# OSakura 内核项目初步分析报告

## 一、项目概述

OSakura 是武汉大学开发的一个 RISC-V 架构 OS 内核项目，参考了 2024 年华东师范大学 ECNU 九队的参赛作品进行改进。项目使用 C 语言编写，面向 RISC-V 64 位平台（QEMU virt 机器），采用 OpenSBI 作为固件引导。

## 二、仓库文件组织结构

```
.
├── Makefile                    # 顶层 Makefile，递归调用子目录
├── README.md                   # 项目说明
├── LICENSE                     # GPLv3 许可证
├── OSakura设计文档.pdf          # 设计文档
├── git.sh                      # Git 辅助脚本
└── OSakura-rv/                 # 内核主目录
    ├── Makefile                # 内核顶层构建（QEMU 启动、GDB 调试配置）
    ├── Common.mk               # 公共编译配置（交叉编译器、CFLAGS、LDFLAGS）
    ├── linker/                 # 链接脚本
    │   ├── kernel.ld           # 内核链接脚本（入口 0x80200000）
    │   └── user.ld             # 用户程序链接脚本
    ├── include/                # 头文件
    │   ├── common.h            # 公共类型定义
    │   ├── riscv.h             # RISC-V CSR 寄存器操作
    │   ├── sbi.h               # SBI 调用接口
    │   ├── memlayout.h         # 内存布局定义
    │   ├── dev/                # 设备驱动头文件
    │   ├── fs/                 # 文件系统头文件
    │   ├── lib/                # 库函数头文件
    │   ├── lock/               # 锁机制头文件
    │   ├── mem/                # 内存管理头文件
    │   ├── proc/               # 进程管理头文件
    │   ├── signal/             # 信号机制头文件
    │   ├── syscall/            # 系统调用头文件
    │   └── trap/               # 陷阱/异常处理头文件
    ├── kernel/                 # 内核源码
    │   ├── boot/               # 启动引导（Entry.S, start.c, main.c）
    │   ├── dev/                # 设备驱动（UART, PLIC, RTC, Timer, VirtIO）
    │   ├── fs/                 # 文件系统
    │   │   ├── base/           # 文件系统公共层（buf 缓冲管理）
    │   │   ├── ext4/           # ext4 文件系统实现
    │   │   ├── fat32/          # FAT32 文件系统实现
    │   │   └── procfs.c        # 虚拟文件系统（procfs）
    │   ├── lib/                # 内核库（print, string）
    │   ├── lock/               # 锁（spinlock, sleeplock）
    │   ├── mem/                # 内存管理（物理内存 pmem, 内核虚拟内存 kvm, 用户虚拟内存 uvm）
    │   ├── proc/               # 进程管理（proc, exec, cpu, Swtch.S 上下文切换）
    │   ├── signal/             # 信号机制
    │   ├── syscall/            # 系统调用（syscall 分发, sysfile 文件类, sysproc 进程类）
    │   ├── trap/               # 陷阱处理（Trampoline.S, Trap.S, trap_kernel.c, trap_user.c）
    │   └── test/               # 内核测试（test_execve）
    └── user/                   # 用户态程序
        ├── initcode.c          # 初始进程代码（编译后嵌入内核）
        ├── include/            # 用户态头文件（系统调用封装）
        └── lib/                # 用户态库（stdio, stdlib, syscall）
```

## 三、子系统分析

根据目录结构和头文件内容，该项目实现了以下子系统：

### 1. 启动引导子系统（boot）
- 文件：`kernel/boot/Entry.S`, `start.c`, `main.c`
- 功能：从 OpenSBI 跳转至内核入口 `_entry`，初始化各子系统后进入用户态

### 2. 进程管理子系统（proc）
- 文件：`kernel/proc/proc.c`, `cpu.c`, `exec.c`, `Swtch.S`
- 功能：进程创建（fork）、执行（exec）、退出（exit）、等待（wait）、调度（schedule）、杀死（kill）、休眠/唤醒（sleep/wakeup）
- 进程状态：UNUSED, USED, SLEEPING, RUNNABLE, RUNNING, ZOMBIE

### 3. 内存管理子系统（mem）
- 文件：`kernel/mem/pmem.c`, `kvm.c`, `uvm.c`, `Mem.S`
- 功能：物理内存管理、内核虚拟内存映射、用户虚拟内存管理（含 mmap/brk 支持）
- 内存布局：内核加载于 0x80200000，Trampoline 位于虚拟地址空间顶部，Trapframe 紧随其下

### 4. 文件系统子系统（fs）
- 文件：`kernel/fs/` 下三个子目录 + `procfs.c`
- 实现了三套文件系统：
  - **FAT32**：完整的 FAT32 实现（cluster、dir、file、inode、pipe、sys）
  - **ext4**：完整的 ext4 实现（block、dir、file、inode、pipe、sys）
  - **procfs**：虚拟文件系统，提供 `/proc/meminfo`、`/proc/mounts`、`/etc/passwd` 等虚拟文件
- 公共层：`base/buf.c` 提供块设备缓冲管理
- 支持管道（pipe）机制

### 5. 设备驱动子系统（dev）
- 文件：`kernel/dev/` 下 6 个驱动
- UART（串口通信）、PLIC（中断控制器）、RTC（实时时钟）、Timer（定时器）、VirtIO（块设备磁盘驱动）、Console（控制台）

### 6. 陷阱与异常处理子系统（trap）
- 文件：`kernel/trap/Trampoline.S`, `Trap.S`, `trap_kernel.c`, `trap_user.c`
- 功能：用户态/内核态切换的 Trampoline 机制，内核态和用户态的陷阱分别处理

### 7. 系统调用子系统（syscall）
- 文件：`kernel/syscall/syscall.c`, `sysfile.c`, `sysproc.c`
- 已定义约 60+ 个系统调用，涵盖：
  - 文件操作：open, close, read, write, lseek, mkdir, unlink, link, rename, stat, pipe, dup, fcntl, ioctl, mount, sendfile, ppoll 等
  - 进程操作：fork(clone), exec, exit, wait, kill, getpid, getppid, sched_yield 等
  - 内存操作：brk, mmap, munmap, mprotect
  - 信号操作：rt_sigaction, rt_sigprocmask, rt_sigtimedwait, rt_sigreturn
  - 其他：nanosleep, clock_gettime, uname, sysinfo, gettimeofday, times

### 8. 信号机制子系统（signal）
- 文件：`kernel/signal/signal.c`
- 支持 31 种标准信号（SIGHUP 至 SIGSYS），以及实时信号
- 进程结构中包含 sigactions、sig_pending、sig_set、sig_frame

### 9. 同步与锁子系统（lock）
- 文件：`kernel/lock/spinlock.c`, `sleeplock.c`
- 自旋锁（spinlock）和睡眠锁（sleeplock）两种同步机制

### 10. 内核库（lib）
- 文件：`kernel/lib/print.c`, `string.c`
- 提供内核态的打印和字符串操作函数

## 四、代码规模

内核源码（C + 汇编）总计约 **9633 行**（含 `.c` 和 `.S` 文件），属于一个中等规模的教学/竞赛级内核。

## 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| `riscv64-unknown-elf-gcc` | RISC-V 裸机交叉编译器 | 可用（RISC-V cross toolchain） |
| `riscv64-unknown-elf-ld` | 链接器 | 可用 |
| `riscv64-unknown-elf-objcopy` | 二进制格式转换 | 可用 |
| `riscv64-unknown-elf-objdump` | 反汇编 | 可用 |
| `qemu-system-riscv64` | RISC-V 64 位模拟器 | 可用 |
| `GNU Make` | 构建系统 | 可用 |
| `mkfs.ext4` / `mkfs.vfat` | 文件系统镜像制作 | 可用 |
| `dd` | 镜像文件创建 | 可用 |
| `mount` / `umount` | 文件系统挂载（需 sudo） | 可用（需权限） |
| `xxd` | 二进制转 C 数组（initcode 嵌入） | 需确认 |
| OpenSBI（`-bios default`） | SBI 固件 | 可用 |

注：`Common.mk` 中硬编码了 `TOOLPREFIX = riscv64-unknown-elf-`，需确认交叉编译器前缀是否匹配。用户程序文件系统镜像制作需要 `sudo` 权限进行 mount 操作。