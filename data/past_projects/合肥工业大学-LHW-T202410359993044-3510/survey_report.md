## 项目结构

```
.
├── Makefile              # 构建脚本（GNU Make）
├── README                # 项目说明文档
├── .gdbinit.tmpl-riscv   # GDB 调试配置模板
├── .dir-locals.el        # Emacs 编辑器配置
├── .editorconfig         # 编辑器通用配置
├── .gitignore
├── kernel/               # 内核源码（48 个文件，约 6800 行）
│   ├── *.c               # C 源文件（约 30 个）
│   ├── *.h               # 头文件（约 15 个）
│   ├── *.S               # RISC-V 汇编文件（4 个）
│   └── kernel.ld         # 链接器脚本
├── user/                 # 用户态程序（8 个文件）
│   ├── init.c            # init 进程
│   ├── initcode.S        # 初始用户态代码（嵌入内核）
│   ├── ulib.c / printf.c / umalloc.c  # 用户态库
│   ├── usys.pl           # 系统调用桩代码生成脚本（Perl）
│   ├── user.h            # 用户态头文件
│   └── user.ld           # 用户态链接器脚本
└── mkfs/                 # 文件系统镜像制作工具
    └── mkfs.c            # 制作 fs.img 的宿主工具
```

## 初步调查结果

### 1. 项目性质

该项目是一个基于 **xv6**（MIT 教学操作系统）改造的 **RISC-V 64 位** 内核项目，面向操作系统内核比赛（oscomp）。从系统调用编号（如 `SYS_clone=220`、`SYS_execve=221`、`SYS_mmap=222`、`SYS_exit=93` 等）可以看出，该项目已将 xv6 原始的系统调用接口改造为 **Linux 兼容的系统调用 ABI**，以适配比赛提供的测试套件（`testsuits-for-oskernel`）。

### 2. 子系统划分

| 子系统 | 对应文件 | 说明 |
|--------|----------|------|
| **启动与入口** | `entry.S`, `start.c`, `kernel.ld` | RISC-V 裸机启动、SBI 引导、内核入口 |
| **内存管理** | `kalloc.c`, `vm.c` | 物理页分配器、虚拟内存/页表管理 |
| **进程管理** | `proc.c`, `proc.h`, `swtch.S` | 进程创建/销毁、上下文切换、调度 |
| **中断与异常** | `trap.c`, `trampoline.S`, `kernelvec.S` | 陷阱处理、内核态中断向量 |
| **系统调用** | `syscall.c`, `syscall.h`, `sysproc.c`, `sysfile.c` | 系统调用分发、进程类/文件类系统调用实现 |
| **文件系统** | `fs.c`, `fs.h`, `log.c`, `bio.c`, `buf.h` | 日志型文件系统（类 xv6 fs）、块 I/O 缓存 |
| **文件与管道** | `file.c`, `file.h`, `pipe.c`, `exec.c` | 文件描述符管理、管道、exec 加载 |
| **设备驱动** | `virtio_disk.c`, `virtio.h`, `uart.c`, `plic.c`, `console.c` | VirtIO 块设备驱动、UART 串口、PLIC 中断控制器 |
| **同步机制** | `spinlock.c`, `spinlock.h`, `sleeplock.c`, `sleeplock.h` | 自旋锁、睡眠锁 |
| **辅助工具** | `printf.c`, `string.c` | 内核打印、字符串操作 |
| **用户态** | `user/` 目录下所有文件 | 用户态库、init 进程、系统调用桩 |
| **镜像制作** | `mkfs/mkfs.c` | 宿主端文件系统镜像生成工具 |

### 3. 构建所需工具

| 工具 | 用途 | 当前环境状态 |
|------|------|-------------|
| **RISC-V 交叉编译器**（`riscv64-unknown-elf-gcc` 或 `riscv64-linux-gnu-gcc`） | 编译内核与用户态代码 | **缺失** |
| **GNU Make** | 执行 Makefile 构建 | **缺失** |
| **QEMU**（`qemu-system-riscv64`） | 运行与测试内核 | **缺失** |
| **Perl** | 生成用户态系统调用桩代码 `usys.S` | 未确认，需检查 |
| **sed** | 生成系统调用表 `_syscall_table.inc` | 可用（bash 内置） |
| **GCC**（宿主） | 编译 `mkfs/mkfs` 工具 | **可用** |
| **GNU ld / objcopy / objdump**（RISC-V 版） | 链接内核、生成二进制 | **缺失**（仅有宿主版本） |

### 4. 关键特征

- **目标架构**：RISC-V 64 位（`-mcmodel=medany`，`-march=rv64g`）。
- **SMP 支持**：默认配置 3 个 CPU（`CPUS := 3`），最大支持 8 个（`NCPU 8`）。
- **最大进程数**：64（`NPROC 64`）。
- **文件系统**：采用 xv6 风格的日志文件系统，块缓存大小为 30 块（`NBUF = MAXOPBLOCKS*3`）。
- **外部依赖**：构建 `fs.img` 时依赖外部测试套件目录 `../testsuits-for-oskernel/`，以及一个 SD 卡镜像 `sdcard-riscv.img`。
- **系统调用数量**：约 40 个，涵盖进程管理（fork/clone/exit/wait4）、文件操作（openat/read/write/close）、内存管理（mmap/munmap/brk）、系统信息（uname/times/gettimeofday）等类别。