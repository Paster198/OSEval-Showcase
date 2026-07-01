# Bella-V (OSKernel2024) 项目初步调查报告

## 一、项目概述

本项目名为 **Bella-V**（OSKernel2024-BellaV），是基于 MIT xv6-riscv 教学操作系统进行二次开发的 RISC-V 内核项目。项目参考了 xv6-riscv、xv6-vf2 和 xv6-sifive，目标平台为 QEMU virt 虚拟机和 VisionFive 2（VF2）开发板。仓库仅有 1 个 Git 提交（`7c6ff2c try to boot on vf2`），单分支 `main`。

项目使用 C 语言编写，辅以少量 RISC-V 汇编，采用 GNU Make 构建系统。

## 二、仓库文件组织结构

```
.
├── Makefile              # 构建脚本（支持 qemu/vf2 双平台）
├── README / README.md    # 项目说明
├── LICENSE               # MIT 许可证（xv6 原始许可）
├── .gitignore            # 忽略 target/ 和 .o/.d 文件
├── fs.img                # 预构建的 FAT32 文件系统镜像（128MB）
├── kernel/               # 内核源码
│   ├── include/          # 内核头文件（56 个 .h 文件）
│   ├── *.c               # 内核 C 源文件（28 个）
│   └── *.S               # 内核汇编文件（5 个）
├── user/                 # 用户态程序
│   ├── *.c               # 用户程序源文件（22 个）
│   ├── *.S               # 用户汇编（initcode.S）
│   ├── user.h            # 用户态 API 声明
│   └── usys.pl           # 系统调用桩代码生成脚本（Perl）
├── linker/               # 链接脚本
│   ├── qemu.ld           # QEMU 平台链接脚本（基地址 0x80400000）
│   └── vf2.ld            # VF2 平台链接脚本（基地址 0x80400000）
└── doc/                  # 中文设计文档（9 个 Markdown 文件）
```

**代码规模统计**（基于 `wc -l` 实测）：
- 内核代码（.c + .S）：约 7,438 行
- 用户代码（.c + .S）：约 5,045 行
- 总计（含头文件）：约 12,483 行

## 三、子系统划分与文件归属

### 1. 进程管理子系统

| 文件 | 职责 |
|------|------|
| `kernel/proc.c`（971 行） | 进程表管理、fork/clone/exit/wait/scheduler、进程调度 |
| `kernel/swtch.S` | 上下文切换汇编实现 |
| `kernel/include/proc.h` | 进程结构体定义（proc、cpu、context、trapframe、tms） |

支持的功能：fork、clone（带自定义栈）、exit、wait/wait4、sched_yield、getpid/getppid、kill、进程追踪（trace/tmask）、进程时间统计（tms）。最大进程数 50，最大 CPU 数 5。

### 2. 内存管理子系统

| 文件 | 职责 |
|------|------|
| `kernel/vm.c`（709 行） | Sv39 页表管理、内核/用户地址空间映射、copyin/copyout |
| `kernel/kalloc.c` | 物理页分配器（链表式空闲页管理） |
| `kernel/mmap.c`（181 行） | mmap/munmap 内存映射实现 |
| `kernel/include/vm.h` | 虚拟内存接口声明 |
| `kernel/include/mmap.h` | mmap 结构体和常量定义 |
| `kernel/include/kalloc.h` | 物理内存分配接口 |
| `kernel/include/memlayout.h` | 内存布局定义（KERNBASE=0x80200000, PHYSTOP=128MB） |

采用 Sv39 三级页表，每个进程维护独立的用户页表和内核页表（kpagetable）。mmap 支持文件映射，每进程最多 5 个映射区域。

### 3. 文件系统子系统

| 文件 | 职责 |
|------|------|
| `kernel/fat32.c`（1,114 行） | FAT32 文件系统完整实现（BPB 解析、目录项缓存、文件读写） |
| `kernel/file.c`（285 行） | 文件表管理、文件读写分发 |
| `kernel/bio.c`（165 行） | 块设备缓冲缓存（LRU 链表） |
| `kernel/exec.c`（187 行） | ELF 程序加载器 |
| `kernel/image.c` | 文件系统镜像读写（基于 FAT32 镜像文件） |
| `kernel/ramdisk.c` | 内存磁盘（ramdisk）读写 |
| `kernel/disk.c` | 磁盘抽象层（调用 ramdiskrw） |
| `kernel/diskio.c`（162 行） | FatFs 底层磁盘 I/O 骨架（已注释，原用于 SD 卡） |
| `kernel/include/fat32.h` | FAT32 数据结构（dirent、Fat、entry_cache、fs） |
| `kernel/include/file.h` | 文件结构体定义 |
| `kernel/include/buf.h` | 缓冲区结构体 |
| `kernel/include/elf.h` | ELF 格式定义 |

文件系统采用 FAT32 格式（替代 xv6 原始的 Unix 文件系统），支持多文件系统挂载（最多 5 个 fs 实例），支持 mount/umount。磁盘 I/O 通过函数指针抽象，支持 virtio-blk 和 ramdisk 两种后端。

### 4. 系统调用子系统

| 文件 | 职责 |
|------|------|
| `kernel/syscall.c`（295 行） | 系统调用分发器、参数提取 |
| `kernel/sysproc.c`（356 行） | 进程相关系统调用实现 |
| `kernel/sysfile.c`（819 行） | 文件相关系统调用实现 |
| `kernel/systime.c` | 时间相关系统调用（times、gettimeofday） |
| `kernel/uname.c` | uname 系统调用 |
| `kernel/mmap.c` | mmap/munmap 系统调用 |
| `kernel/include/sysnum.h` | 系统调用号定义（Linux 兼容编号） |
| `kernel/include/syscall.h` | 系统调用接口声明 |

已实现的系统调用共 **46 个**，采用 Linux 兼容编号，包括：
- 进程类：fork、clone、exec/execve、exit、wait/wait4、getpid、getppid、kill、sched_yield
- 内存类：sbrk、brk、mmap、munmap
- 文件类：open/openat、close、read、write、lseek、dup/dup3、fstat、getdents64、mkdir/mkdirat、unlinkat、chdir、getcwd、rename、mount、umount2
- 信息类：uname、sysinfo、times、gettimeofday、nanosleep、sleep、uptime、trace

### 5. 中断与异常子系统

| 文件 | 职责 |
|------|------|
| `kernel/trap.c`（303 行） | 陷阱处理（usertrap/kerneltrap/devintr）、缺页异常处理 |
| `kernel/timer.c` | 定时器中断管理（SBI 设置下次超时） |
| `kernel/plic.c` | PLIC 中断控制器驱动 |
| `kernel/kernelvec.S` | 内核态中断入口汇编 |
| `kernel/trampoline.S`（147 行） | 用户态/内核态切换跳板代码 |
| `kernel/include/trap.h` | trapframe 结构体定义 |
| `kernel/include/timer.h` | 定时器常量和接口 |
| `kernel/include/plic.h` | PLIC 接口 |

支持时钟中断（通过 SBI ecall 设置下次触发）、外部中断（UART）、缺页异常处理（load/store page fault）。

### 6. 同步与锁子系统

| 文件 | 职责 |
|------|------|
| `kernel/spinlock.c` | 自旋锁实现（基于 RISC-V amoswap） |
| `kernel/sleeplock.c` | 睡眠锁实现（基于自旋锁 + sleep/wakeup） |
| `kernel/intr.c` | 中断开关（push_off/pop_off） |

### 7. I/O 与设备驱动子系统

| 文件 | 职责 |
|------|------|
| `kernel/console.c`（204 行） | 控制台输入输出（支持 SBI 和 UART 双模式） |
| `kernel/uart.c`（203 行） | 16550A UART 驱动（VF2 平台专用） |
| `kernel/printf.c`（183 行） | 内核格式化输出（printf/panic/backtrace） |
| `kernel/pipe.c`（120 行） | 管道实现 |
| `kernel/include/virtio.h` | VirtIO MMIO 设备寄存器定义 |
| `kernel/include/sbi.h` / `sbi2.h` | SBI 调用封装（v0.1 legacy + v0.2 HSM 扩展） |

### 8. 启动与平台相关

| 文件 | 职责 |
|------|------|
| `kernel/entry_vf2.S` | VF2 平台入口（分配栈、跳转 main） |
| `kernel/main.c`（111 行） | 内核主函数（初始化序列、多核启动框架） |
| `kernel/initcode.S` / `initcode.c` | 初始用户进程代码（内嵌为二进制数据） |
| `linker/qemu.ld` / `vf2.ld` | 链接脚本（基地址 0x80400000） |

注意：Makefile 中引用了 `entry_qemu.o`，但仓库中不存在 `entry_qemu.S` 文件，当前默认平台为 `vf2`。QEMU 平台构建可能缺少入口文件。

### 9. 用户态程序

| 文件 | 职责 |
|------|------|
| `user/init.c` | 初始进程（启动 shell） |
| `user/sh.c` | Shell（支持管道、重定向、环境变量） |
| `user/cat.c` / `echo.c` / `grep.c` / `wc.c` | 基本文本处理工具 |
| `user/ls.c` / `mkdir.c` / `rm.c` / `find.c` / `mv.c` | 文件系统操作工具 |
| `user/kill.c` / `sleep.c` / `strace.c` | 进程管理工具 |
| `user/test.c` | sysinfo 测试程序 |
| `user/usertests.c` | 综合用户测试 |
| `user/ulib.c` | 用户态库函数（strcpy、strcmp、gets 等） |
| `user/umalloc.c` | 用户态内存分配器（K&R malloc） |
| `user/printf.c` | 用户态 printf（通过 sprint 系统调用） |
| `user/usys.pl` | 系统调用桩生成脚本 |
| `user/initcode.S` | 初始进程汇编（批量运行测试程序） |

### 10. 遗留/未使用代码

头文件目录中包含以下来自 VF2/SiFive/Kendryte 平台的遗留头文件，相关实现代码已被注释或删除：
- `sdcard.h`、`spi.h`、`fpioa.h`、`dmac.h`、`sysctl.h` -- VF2/SiFive 板载外设
- `ff.h`、`ffconf.h` -- FatFs 库头文件（未实际使用，FAT32 已自行实现）
- `xv6_fs.h` -- xv6 原始文件系统头文件（已被 FAT32 替代）

## 四、构建工具需求

根据 Makefile 分析，构建本项目需要以下工具：

| 工具 | 用途 | Makefile 中的引用 |
|------|------|-------------------|
| `riscv64-unknown-elf-gcc` | RISC-V 裸机 C 编译器 | `CC` |
| `riscv64-unknown-elf-gas` | RISC-V 汇编器 | `AS` |
| `riscv64-unknown-elf-ld` | RISC-V 链接器 | `LD` |
| `riscv64-unknown-elf-objcopy` | 二进制格式转换 | `OBJCOPY` |
| `riscv64-unknown-elf-objdump` | 反汇编/符号表提取 | `OBJDUMP` |
| `qemu-system-riscv64` | RISC-V 64 位模拟器 | `QEMU` |
| `perl` | 系统调用桩代码生成 | `usys.pl` |
| Rust 工具链（cargo） | 构建 RustSBI 固件（可选） | `RUSTSBI` 目标 |
| `mkfs.vfat` / `dd` | 文件系统镜像制作 | `fs` 目标 |

当前环境中可用的 RISC-V 交叉编译工具链前缀为 `riscv64-unknown-elf-`（RISC-V cross toolchain），与 Makefile 中的 `TOOLPREFIX` 一致。QEMU 环境（`qemu-system-riscv64`）可用。RustSBI 固件需要单独构建或提供预编译二进制。