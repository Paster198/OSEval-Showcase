## REMOS 内核项目初步调查报告

### 一、项目概述

REMOS 是一个基于 xv6-riscv 的 RISC-V 宏内核操作系统项目，使用 C 语言编写，面向 RISC-V 64 位架构。项目支持两个目标平台：QEMU 虚拟机（`qemu`）和 VisionFive 开发板（`visionfive`）。项目参加 OS 内核比赛，声称支持 31 个系统调用并通过了初赛全部测例。

### 二、仓库文件组织结构

```
.
├── Makefile              # 构建系统入口
├── README.md             # 项目说明
├── LICENSE               # 许可证（MIT）
├── xv6-riscv-license     # xv6 原始许可证
├── .gitignore
├── linker/               # 链接脚本
│   ├── qemu.ld           # QEMU 平台链接脚本（入口 0x80200000）
│   └── visionfive.ld     # VisionFive 平台链接脚本
├── include/              # 头文件（约 70 个 .h 文件，共约 15300 行）
│   ├── ext4/             # ext4 文件系统相关头文件（约 30 个）
│   └── *.h               # 内核通用头文件
├── src/                  # 内核源码（约 65 个 .c/.S 文件，共约 33400 行）
│   ├── kernel/           # 内核核心
│   │   ├── asm/          # 汇编入口和中断向量
│   │   ├── main.c        # 内核入口
│   │   ├── syscall.c     # 系统调用分发
│   │   ├── sysproc.c     # 进程相关系统调用
│   │   ├── sysfile.c     # 文件相关系统调用
│   │   ├── sysmem.c      # 内存相关系统调用（brk）
│   │   ├── sysothers.c   # 其他系统调用（times, uname, sched_yield 等）
│   │   ├── signal.c      # 信号机制
│   │   ├── trap.c        # 陷阱/异常处理
│   │   ├── intr.c        # 中断处理
│   │   ├── timer.c       # 定时器
│   │   └── plic.c        # PLIC 中断控制器
│   ├── proc/             # 进程管理
│   │   ├── proc.c        # 进程/线程管理
│   │   ├── exec.c        # exec 实现
│   │   ├── pipe.c        # 管道
│   │   ├── sleeplock.c   # 睡眠锁
│   │   ├── swtch.S       # 上下文切换（汇编）
│   │   └── trampoline.S  # 用户态/内核态切换跳板
│   ├── mm/               # 内存管理
│   │   ├── vm.c          # 虚拟内存/页表管理
│   │   ├── kalloc.c      # 内核内存分配
│   │   ├── buddy.c       # Buddy 分配器
│   │   ├── mm.c          # 内存管理初始化
│   │   ├── mmap.c        # mmap/munmap 实现
│   │   └── dmac.c        # DMA 控制器
│   ├── fs/               # 文件系统
│   │   ├── bio.c         # 块 I/O 缓冲层
│   │   ├── file.c        # 文件描述符管理
│   │   ├── fat32/        # FAT32 文件系统（1 个 .c 文件）
│   │   └── ext4/         # ext4 文件系统（约 22 个 .c 文件）
│   ├── platform/         # 平台相关
│   │   ├── disk.c        # 磁盘抽象层
│   │   └── virtio_disk.c # VirtIO 块设备驱动
│   ├── driver/           # 设备驱动
│   │   ├── console.c     # 控制台驱动
│   │   ├── uart.c        # UART 串口驱动
│   │   ├── spi.c         # SPI 驱动（VisionFive）
│   │   ├── gpiohs.c      # GPIO 驱动（VisionFive）
│   │   ├── fpioa.c       # FPIOA 引脚复用（VisionFive）
│   │   └── sdcard.c      # SD 卡驱动（VisionFive）
│   ├── atomic/           # 同步原语
│   │   └── spinlock.c    # 自旋锁
│   ├── lib/              # 内核库函数
│   │   ├── printf.c      # 内核 printf
│   │   ├── string.c      # 字符串操作
│   │   ├── logo.c        # 启动 Logo
│   │   └── utils.c       # 工具函数
│   └── initcode.S        # 初始用户进程代码
├── user/                 # 用户态程序
│   ├── init.c            # init 进程
│   ├── initcode.S        # initcode 汇编入口
│   ├── printf.c          # 用户态 printf
│   ├── ulib.c            # 用户态库
│   ├── umalloc.c         # 用户态内存分配
│   ├── user.h            # 用户态头文件
│   └── usys.pl           # 系统调用桩代码生成脚本（Perl）
├── doc/                  # 设计文档
│   ├── fs/EXT4.md        # ext4 实现文档
│   ├── mm/mm.md          # 内存管理文档
│   └── proc/proc.md      # 进程管理文档
└── build/                # 构建输出目录
    └── kernel            # 编译产物
```

### 三、子系统划分

| 子系统 | 主要目录/文件 | 说明 |
|--------|-------------|------|
| **内核核心与启动** | `src/kernel/main.c`, `src/kernel/asm/` | 内核入口、启动流程、SBI 交互 |
| **中断与异常处理** | `src/kernel/trap.c`, `src/kernel/intr.c`, `src/kernel/plic.c`, `src/kernel/timer.c` | 陷阱处理、PLIC 中断控制器、定时器中断 |
| **进程管理** | `src/proc/proc.c`, `src/proc/exec.c`, `src/proc/swtch.S`, `src/proc/trampoline.S` | 进程/线程创建、调度、上下文切换、exec |
| **内存管理** | `src/mm/vm.c`, `src/mm/kalloc.c`, `src/mm/buddy.c`, `src/mm/mm.c`, `src/mm/mmap.c` | 页表管理、Buddy 物理页分配器、mmap/munmap、brk |
| **文件系统** | `src/fs/ext4/`, `src/fs/fat32/`, `src/fs/bio.c`, `src/fs/file.c` | ext4 文件系统（主要）、FAT32（遗留）、块缓冲层、文件描述符 |
| **系统调用** | `src/kernel/syscall.c`, `src/kernel/sysproc.c`, `src/kernel/sysfile.c`, `src/kernel/sysmem.c`, `src/kernel/sysothers.c` | 系统调用分发及各分类实现 |
| **信号机制** | `src/kernel/signal.c`, `include/signal.h` | POSIX 信号（sigaction, sigprocmask） |
| **设备驱动** | `src/platform/virtio_disk.c`, `src/driver/console.c`, `src/driver/uart.c`, `src/driver/spi.c`, `src/driver/sdcard.c` | VirtIO 块设备、控制台、UART、SPI/SD 卡（VisionFive） |
| **同步机制** | `src/atomic/spinlock.c`, `src/proc/sleeplock.c`, `src/proc/pipe.c` | 自旋锁、睡眠锁、管道 |
| **用户态** | `user/` | init 进程、用户态库函数、系统调用桩 |

### 四、系统调用支持

项目定义了约 50 个系统调用号（`include/sysnum.h`），涵盖：
- **文件系统**：getcwd, dup/dup2, chdir, close, read, write, fstat, pipe2, openat, getdents64, linkat, unlinkat, mkdirat, mount, umount2, ioctl, fcntl, writev, ppoll
- **进程管理**：exit, getpid, getppid, gettid, clone, execve, waitpid, kill, exit_group, set_tid_address
- **内存管理**：brk, mmap, munmap
- **其他**：times, uname, sched_yield, gettimeofday, nanosleep, clock_gettime, rt_sigaction, rt_sigprocmask, getuid, getgid, setuid, setgid

### 五、构建工具链需求

| 工具 | 用途 | 来源 |
|------|------|------|
| `riscv64-unknown-elf-gcc` | C 交叉编译器 | RISC-V 交叉编译工具链 |
| `riscv64-unknown-elf-gas` | 汇编器 | RISC-V 交叉编译工具链 |
| `riscv64-unknown-elf-ld` | 链接器 | RISC-V 交叉编译工具链 |
| `riscv64-unknown-elf-objcopy` | 目标文件转换 | RISC-V 交叉编译工具链 |
| `riscv64-unknown-elf-objdump` | 反汇编 | RISC-V 交叉编译工具链 |
| `qemu-system-riscv64` | QEMU 模拟器 | QEMU |
| `perl` | 生成用户态系统调用桩（`usys.pl`） | 主机工具 |
| `make` | 构建系统 | GNU Make |
| OpenSBI/RustSBI | SBI 固件（`-bios default`） | SBI 固件 |
| `dd` | 镜像制作（VisionFive 平台） | 主机工具 |

构建命令为 `make all`（清理后编译内核），`make run`（启动 QEMU 运行）。QEMU 配置为 2 核、128MB 内存，使用 VirtIO 块设备和网络设备。

### 六、代码规模

| 类别 | 文件数 | 行数（约） |
|------|--------|-----------|
| 内核源码（src/） | 65 | 33,400 |
| 头文件（include/） | 70 | 15,300 |
| 用户态（user/） | 8 | 520 |
| **合计** | **约 143** | **约 49,200** |

其中 ext4 文件系统实现占内核源码的较大比例（22 个 .c 文件），是项目中最庞大的子系统。