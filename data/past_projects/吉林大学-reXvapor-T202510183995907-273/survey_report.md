## Re-XVapor 项目初步调查报告

### 一、项目概述

Re-XVapor 是一个基于 MIT xv6-riscv 深度改造的类 Unix 操作系统内核项目，由吉林大学开发者维护。项目采用 C 语言编写，使用宏内核架构，目标平台为 RISC-V（主要）和 LoongArch（部分实现）。项目声称实现了 81 个系统调用，支持 glibc/musl-busybox 用户态程序运行。

---

### 二、仓库文件组织结构

```
Re-XVapor/
├── Makefile              # 顶层构建入口，协调 user/kernel 编译及 QEMU 启动
├── README.md             # 项目文档
├── conf/lab.mk           # 实验配置（当前为 "util"）
├── include/              # 公共头文件（仅 wait.h）
├── kernel/               # 内核源码（核心）
│   ├── arch/             # 架构相关代码
│   │   ├── riscv/        # RISC-V: entry.S, kernelvec.S, swtch.S, trampoline.S, sigret.S
│   │   ├── loongarch/    # LoongArch: entry.S, exception.S, swtch.S, ahci.c, pci.c, ns16550a.c 等
│   │   └── qemu/         # QEMU 平台通用: console.c, plic.c, uart.c
│   ├── atomic/           # 同步原语: spinlock, sleeplock, semaphore, cond(条件变量)
│   ├── fs/               # 文件系统
│   │   ├── vfs/          # VFS 抽象层: vfs.c, vfs_ext4.c, vfs_xv6fs.c, vfs_mount.c
│   │   ├── ext4*.c       # ext4 文件系统实现（基于 lwext4，约 20 个文件）
│   │   ├── xv6fs.c       # 原始 xv6 文件系统
│   │   ├── exec.c        # ELF 加载器
│   │   ├── virtio_disk.c # VirtIO 块设备驱动
│   │   ├── bio.c, blockdev.c, device.c, log.c, file.c, sysfile.c, fcntl.c, ioctl.c, procfs.c
│   ├── include/          # 内核私有头文件（约 80+ 个 .h 文件）
│   ├── init/             # 内核启动: main.c, start.c
│   ├── ipc/              # 进程间通信: signal.c, pipe.c, futex.c, syssig.c
│   ├── lib/              # 内核库: printf.c, string.c, qsort.c, queue.c, snprintf.c
│   ├── mm/               # 内存管理: kalloc.c（物理页分配）, vm.c（虚拟内存）, mmap.c
│   ├── sched/            # 调度与进程: proc.c, sched.c, thread.c, trap.c
│   ├── syscall.c         # 系统调用分发
│   ├── sysproc.c         # 进程相关系统调用实现
│   └── sysother.c        # 其他系统调用实现
├── mkfs/                 # 文件系统镜像制作工具（mkfs.c，主机端编译）
├── scripts/              # 构建辅助脚本
│   ├── syscall.tbl       # 系统调用表定义（约 81 个系统调用）
│   ├── sysgen.sh         # 系统调用代码自动生成脚本（Perl + Shell）
│   ├── run.sh, crun.sh, mount.sh, update_image.sh
├── user/                 # 用户空间程序
│   ├── asm/initcode.S    # 初始用户进程汇编入口
│   ├── init/init.c       # init 进程
│   ├── lib/              # 用户态库: ulib.c, printf.c, umalloc.c
│   ├── src/              # 用户程序: echo, forktest, ln, mkdir, rm, sleep, zombie, signal_test
│   ├── test/             # 测试用例（约 30+ 个预编译二进制测试程序 + shell 脚本）
│   ├── include/user.h    # 用户空间头文件
│   ├── user.ld           # RISC-V 用户程序链接脚本
│   ├── loongarch_user.ld # LoongArch 用户程序链接脚本
│   ├── usys.pl           # RISC-V 系统调用桩代码生成器
│   └── loongarch_usys.pl # LoongArch 系统调用桩代码生成器
├── docs/                 # 项目文档（设计文档、调试记录等）
└── busybox_unstripped    # 预编译的 busybox 二进制
```

---

### 三、子系统划分

根据代码目录结构和内容分析，该项目实现了以下子系统：

| 子系统 | 对应目录/文件 | 说明 |
|--------|-------------|------|
| **进程管理** | `kernel/sched/proc.c` | 进程表（16 个进程槽位）、进程家族树、fork/wait/exit/kill |
| **线程管理** | `kernel/sched/thread.c`, `kernel/include/thread.h` | 线程控制块（TCB）、线程组、clone 系统调用，每进程最多 4 线程，全局最多 64 线程 |
| **调度器** | `kernel/sched/sched.c` | 多核调度，基于队列的进程状态管理（UNUSED/USED/ZOMBIE + 线程级 RUNNABLE/RUNNING/SLEEPING） |
| **虚拟内存管理** | `kernel/mm/vm.c`, `kernel/mm/mmap.c` | 内核页表、用户页表、VMA 链表管理、mmap/munmap/mprotect |
| **物理内存分配** | `kernel/mm/kalloc.c` | 物理页帧分配器 |
| **VFS 层** | `kernel/fs/vfs/` | 虚拟文件系统抽象，支持多文件系统挂载，统一接口分发 |
| **ext4 文件系统** | `kernel/fs/ext4*.c` | 基于 lwext4 的 ext4 读写实现（约 20 个源文件） |
| **xv6 文件系统** | `kernel/fs/xv6fs.c` | 原始 xv6 文件系统（保留兼容） |
| **块设备层** | `kernel/fs/bio.c`, `blockdev.c`, `device.c` | 块缓冲、块设备表、设备抽象 |
| **磁盘驱动** | `kernel/fs/virtio_disk.c`, `kernel/arch/loongarch/ahci.c` | VirtIO 块设备（RISC-V）、AHCI/SATA（LoongArch） |
| **ELF 加载器** | `kernel/fs/exec.c` | 支持 ELF 动态链接加载，兼容 glibc/musl |
| **信号机制** | `kernel/ipc/signal.c`, `kernel/ipc/syssig.c` | sigaction、sigreturn、信号掩码、信号队列、rt 信号帧 |
| **管道** | `kernel/ipc/pipe.c` | pipe/pipe2 系统调用 |
| **Futex** | `kernel/ipc/futex.c` | 基于哈希表的 Futex 等待/唤醒队列 |
| **同步原语** | `kernel/atomic/` | 自旋锁、睡眠锁、信号量、条件变量 |
| **系统调用** | `kernel/syscall.c`, `sysproc.c`, `sysother.c` | 约 81 个系统调用，自动生成调度表 |
| **中断/异常处理** | `kernel/sched/trap.c`, `kernel/arch/*/kernelvec.S`, `entry.S` | 内核态/用户态陷阱处理、时钟中断 |
| **架构抽象** | `kernel/arch/riscv/`, `kernel/arch/loongarch/` | 上下文切换、trampoline、信号返回桩、TLB 管理 |
| **平台驱动** | `kernel/arch/qemu/` | UART 串口、PLIC 中断控制器、控制台 |
| **内核库** | `kernel/lib/` | printf、string、snprintf、qsort、queue |
| **procfs** | `kernel/fs/procfs.c` | 进程文件系统（/proc） |
| **用户空间** | `user/` | init 进程、用户库、测试程序、busybox 支持 |

---

### 四、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| `riscv64-unknown-elf-gcc` 或 `riscv64-linux-gnu-gcc` | RISC-V 交叉编译内核和用户程序 | 可用（RISC-V cross toolchain + Linux GNU toolchain） |
| `loongarch64-linux-gnu-gcc` | LoongArch 交叉编译 | 可用（LoongArch cross toolchain） |
| `GNU Make` | 构建系统 | 可用 |
| `GNU ld` (交叉版) | 链接内核和用户程序 | 可用 |
| `objcopy` / `objdump` (交叉版) | 二进制处理与反汇编 | 可用 |
| `Perl` | 系统调用桩代码生成（usys.pl） | 需确认（未列出但可能预装） |
| `GCC`（主机） | 编译 mkfs 工具 | 可用 |
| `xxd` | 将 initcode 二进制转为 C 头文件 | 需确认 |
| `qemu-system-riscv64` | RISC-V 模拟运行 | 可用 |
| `qemu-system-loongarch64` | LoongArch 模拟运行 | 可用（但 Makefile 中路径指向 `../qemu-la-*`，需调整） |
| `OpenSBI` | RISC-V SBI 固件（-bios default） | 可用 |

**注意事项**：
- 当前 Makefile 默认仅构建 RISC-V 架构（`ARCHS := riscv`），LoongArch 被注释掉。
- LoongArch 的 QEMU 路径硬编码为 `../qemu-la-20240401/bin/qemu-system-loongarch64`，非标准路径，需要修改才能使用。
- 系统调用表自动生成依赖 Perl 脚本和 Shell 脚本（`scripts/sysgen.sh`）。
- 用户测试目录（`user/test/`）包含预编译的二进制文件（非源码），这些测试程序直接打包进文件系统镜像。