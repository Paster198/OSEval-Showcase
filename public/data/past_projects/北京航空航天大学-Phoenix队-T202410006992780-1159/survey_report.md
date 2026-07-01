# Sos (SleepOS) 内核项目初步分析报告

## 一、项目概述

- **项目名称**：Sos（SleepOS）
- **目标架构**：RISC-V 64 位（rv64g，lp64d ABI）
- **目标平台**：QEMU virt 虚拟机（同时保留 SiFive 板级支持的条件编译选项）
- **开发语言**：C 语言 + RISC-V 汇编
- **构建系统**：GNU Make（递归子目录构建）
- **项目定位**：2024 年 OS 内核比赛项目，采用类 xv6 风格的教学/竞赛内核

## 二、仓库文件组织结构

```
.
├── Makefile            # 顶层 Makefile，负责链接最终内核 ELF 并生成 os.bin
├── include.mk          # 公共编译变量（工具链、CFLAGS、LDFLAGS、QEMU 选项等）
├── README.md           # 简短说明
├── LICENSE             # 许可证
├── .clang-format       # 代码格式化配置
├── .editorconfig       # 编辑器配置
├── .gitignore
│
├── kernel/             # 内核源码（按子系统分子目录）
│   ├── boot/           # 启动代码（entry.S, start.c, main.c）
│   ├── dev/            # 设备驱动（UART, PLIC, timer, virtio, DTB）
│   ├── fs/             # 文件系统（FAT, buffer, file, pipe, proc_fs）
│   ├── lib/            # 内核库函数（printf, ELF 加载, transfer）
│   ├── lock/           # 同步原语（spinlock）
│   ├── mm/             # 内存管理（PMM, VMM, MMU/页表）
│   ├── proc/           # 进程/线程管理（PCB, fork, sched, switch, thread, wait, times）
│   ├── sys/            # 系统调用实现（sys_fs, sys_proc, sys_mem, sys_info, syscall 分发）
│   └── trap/           # 中断/异常处理（ktrap, utrap, trap_handler, trampoline, kern_vec）
│
├── include/            # 头文件（目录结构与 kernel/ 对应）
│   ├── asm/            # 汇编相关（trapframe.h）
│   ├── dev/            # 设备头文件
│   ├── fs/             # 文件系统头文件（含 vfs.h 占位）
│   ├── lib/            # 库头文件（printf, string, queue, elf, log, error 等）
│   ├── lock/           # 锁头文件（spinlock, sleeplock）
│   ├── mm/             # 内存管理头文件（memlayout, mmu, pmm, vmm）
│   ├── proc/           # 进程头文件（proc, cpu, sched, thread, context, times）
│   ├── sys/            # 系统调用头文件（syscall, errno, time, utsname）
│   ├── trap/           # 中断头文件（trap, trapframe）
│   ├── riscv.h         # RISC-V CSR 操作内联函数
│   ├── types.h         # 基础类型定义
│   ├── param.h         # 内核参数（NCPU=1, NPROC=64 等）
│   └── buildin.h       # 内建宏/声明
│
├── lib/                # 共享库代码（string.c, vprint.c）
├── user/               # 用户态程序和测试用例
│   ├── include/        # 用户态头文件（stdio, stdlib, string, syscall, unistd 等）
│   ├── entry.S         # 用户程序入口汇编
│   ├── lib_main.c      # 用户态主库
│   ├── syscall.c       # 用户态系统调用封装
│   ├── clone.S         # clone 系统调用汇编
│   ├── stdio.c/stdlib.c/string.c  # 用户态 C 库
│   └── test_*.c        # 约 30 个测试程序
│
├── linkers/            # 链接脚本
│   ├── kernel.ld       # 内核链接脚本（入口 0x80200000）
│   └── user.ld         # 用户程序链接脚本
│
├── scripts/            # 构建辅助脚本
│   ├── bin2c.py        # 二进制转 C 数组（将用户程序嵌入内核）
│   └── check_style.sh  # 代码风格检查
│
└── docs/               # 项目文档
    ├── SleepOS-boot.md
    ├── SleepOS-console.md
    ├── SleepOS-environment.md
    ├── SleepOS-memory.md
    ├── SleepOS-process.md
    ├── SleepOS-syscall.md
    ├── SleepOS-trap.md
    └── imgs/           # 文档配图
```

## 三、子系统识别

根据目录结构和源码内容，该项目实现了以下子系统：

| 子系统 | 对应目录 | 主要文件 | 说明 |
|--------|----------|----------|------|
| **启动引导** | `kernel/boot/` | entry.S, start.c, main.c | 内核入口、早期初始化 |
| **设备驱动** | `kernel/dev/` | uart.c, plic.c, timer.c, virtio.c, dtb.c, interface.c | UART 串口、PLIC 中断控制器、定时器、VirtIO 块设备、设备树解析 |
| **内存管理** | `kernel/mm/` | pmm.c, vmm.c, mmu.c | 物理内存管理、虚拟内存管理、页表/MMU 操作 |
| **进程/线程管理** | `kernel/proc/` | proc.c, fork.c, sched.c, switch.S, thread.c, wait.c, times.c, cpu.c | PCB、fork、调度、上下文切换、线程、等待、计时 |
| **文件系统** | `kernel/fs/` | fat.c, buffer.c, file.c, pipe.c, proc_fs.c | FAT 文件系统、缓冲区、文件描述符、管道、进程文件系统结构 |
| **系统调用** | `kernel/sys/` | syscall.c, sys_fs.c, sys_proc.c, sys_mem.c, sys_info.c | 系统调用分发及各类系统调用实现 |
| **中断/异常处理** | `kernel/trap/` | ktrap.c, utrap.c, trap_handler.c, trampoline.S, kern_vec.S | 内核态/用户态 trap 处理、trampoline 页、中断向量 |
| **同步机制** | `kernel/lock/` | spinlock.c | 自旋锁（sleeplock.h 存在但未见 .c 实现） |
| **内核库** | `kernel/lib/` | printf.c, elf.c, transfer.c | 内核打印、ELF 解析加载、数据传输 |
| **公共库** | `lib/` | string.c, vprint.c | 字符串操作、格式化输出底层 |
| **用户态** | `user/` | 用户 C 库 + 约 30 个测试程序 | 用户态 syscall 封装、stdio/stdlib/string 库、功能测试 |

## 四、系统调用覆盖范围

根据 `include/sys/syscall.h`，已声明的系统调用涵盖以下类别：

- **进程管理**：getpid, getppid, clone, exit, wait4, execve, sched_yield, times, nanosleep
- **文件系统**：openat, read, write, close, dup, dup3, pipe2, chdir, mkdirat, mount, umount, linkat, unlinkat, getcwd, getdents64, fstat
- **内存管理**：brk, mmap, munmap, madvise, membarrier
- **系统信息**：uname, gettimeofday

另有大量系统调用以 TODO 注释形式列出但尚未实现（如信号、网络、futex 等）。

## 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|----------------|
| `riscv64-unknown-elf-gcc` | RISC-V 裸机交叉编译器 | 可用（RISC-V cross toolchain） |
| `riscv64-unknown-elf-ld` | 链接器 | 可用 |
| `riscv64-unknown-elf-objcopy` | 生成二进制镜像 | 可用 |
| `riscv64-unknown-elf-objdump` | 反汇编 | 可用 |
| `qemu-system-riscv64` | QEMU 模拟器 | 可用 |
| `python3` | bin2c.py 脚本（将用户程序嵌入内核） | 可用 |
| `mkimage` | 生成 U-Boot uImage 格式 | 可用 |
| `mkfs.vfat` / `dd` | 制作 FAT 文件系统镜像 | 可用 |
| `GNU Make` | 构建系统 | 可用 |

**注意**：Makefile 中 `TOOLPREFIX` 默认为 `riscv64-unknown-elf-`，需确认环境中交叉编译器的实际前缀是否匹配。

## 六、关键设计特征

1. **内存模型**：Sv-39 分页，内核映射在 0x80200000 起始的物理地址，trampoline 页映射在虚拟地址空间顶部。
2. **进程模型**：以线程为调度单位、进程为资源管理单位；最大进程数 64（NPROC=64），单 CPU（NCPU=1）。
3. **用户程序加载**：用户程序编译后通过 `bin2c.py` 转为 C 数组嵌入内核镜像，内核启动时直接加载（非从文件系统加载，但 ELF 加载器已存在）。
4. **文件系统**：实现了 FAT 文件系统驱动和 VirtIO 块设备驱动，VFS 层仅有头文件占位（vfs.h 为空）。
5. **同步机制**：仅实现了自旋锁，sleeplock 仅有头文件声明。