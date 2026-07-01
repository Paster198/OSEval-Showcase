# MonkeyOS 项目初步调查报告

## 项目概述

- **项目名称**: MonkeyOS (OSKernel2025 参赛项目，天津大学)
- **基础项目**: 基于 [ByteOS](https://github.com/Byte-OS/ByteOS) 二次开发
- **开发语言**: Rust (nightly-2024-08-01)
- **目标架构**: RISC-V (riscv64gc) 和 LoongArch (loongarch64)，工具链配置中还声明了 x86_64 和 aarch64 target 但 Makefile 仅构建前两者
- **HAL 层**: 使用 `polyhal` (v0.2.4) 作为硬件抽象层
- **依赖管理**: 使用 vendored 模式，vendor 目录下包含 85 个第三方 crate

## 文件组织结构

```
.
├── kernel/          -- 内核核心 (约 13,607 行 Rust 代码)
│   ├── src/
│   │   ├── main.rs         -- 内核入口、中断处理
│   │   ├── syscall/        -- 系统调用实现
│   │   ├── tasks/          -- 任务/进程管理
│   │   ├── user/           -- 用户态交互
│   │   ├── utils/          -- 工具模块
│   │   ├── socket.rs       -- 网络套接字
│   │   ├── panic.rs        -- panic 处理
│   │   └── consts.rs       -- 常量定义
│   ├── linker*.lds         -- 链接脚本 (riscv64/loongarch64/x86_64)
│   └── build.rs            -- 构建脚本
├── crates/          -- 共享库 (约 1,727 行)
│   ├── devices/     -- 设备抽象层
│   ├── executor/    -- 异步执行器 (协程调度)
│   ├── runtime/     -- 运行时 (堆分配、物理页帧管理)
│   ├── signal/      -- 信号机制
│   └── sync/        -- 同步原语
├── driver/          -- 硬件驱动 (约 1,090 行)
│   ├── general-plic/   -- PLIC 中断控制器
│   ├── kgoldfish-rtc/  -- Goldfish RTC 时钟
│   ├── kramdisk/       -- RAM Disk
│   ├── kvirtio/        -- VirtIO 驱动 (块设备/输入/网络)
│   └── ns16550a/       -- NS16550A UART 串口
├── filesystem/      -- 文件系统 (约 4,263 行)
│   ├── vfscore/     -- VFS 核心抽象
│   ├── fs/          -- 主文件系统层 (ext4/FAT 适配、dentry、file、pipe)
│   ├── devfs/       -- 设备文件系统 (null/zero/tty/rtc/shm/urandom/passwd 等)
│   ├── procfs/      -- 进程文件系统 (cpuinfo/meminfo/mounts/stat/version/interrupts)
│   └── ramfs/       -- 内存文件系统
├── config/          -- 板级配置 (qemu.toml, k210.toml, cv1811h.toml, 链接脚本)
├── scripts/         -- 构建/运行辅助脚本 (TypeScript)
├── vendor/          -- 85 个第三方依赖 crate
├── doc/             -- 项目文档 (初赛/决赛/现场赛 PDF)
├── dotcargo/        -- Cargo 配置 (构建时复制为 .cargo)
├── Cargo.toml       -- Workspace 定义
├── Makefile         -- 构建入口
└── rust-toolchain.toml -- Rust 工具链声明
```

## 子系统分析

### 1. 进程/任务管理子系统 (`kernel/src/tasks/`)
包含任务创建与调度 (`task.rs`)、ELF 加载 (`elf.rs`, `exec.rs`)、文件描述符表 (`filetable.rs`)、初始进程 (`initproc.rs`)、内存集管理 (`memset.rs`)、共享内存 (`shm.rs`)、信号处理 (`signal.rs`)、异步操作 (`async_ops.rs`)。

### 2. 系统调用子系统 (`kernel/src/syscall/`)
实现了大量 Linux 兼容系统调用，按功能分组：
- **文件描述符** (`fd.rs`): open/close/read/write/dup/lseek/pread/pwrite/readv/writev/ioctl/fcntl 等
- **内存管理** (`mm.rs`): mmap/munmap/brk/mprotect
- **进程管理** (`task.rs`): fork/clone/execve/wait4/exit/getpid/getppid/gettid 等
- **信号** (`signal.rs`): rt_sigaction/rt_sigprocmask/rt_sigsuspend/kill/tgkill
- **套接字** (`socket.rs`): socket/bind/listen/accept/connect/sendto/recvfrom 等
- **共享内存** (`shm.rs`): shmget/shmat/shmdt/shmctl
- **时间** (`time.rs`): clock_gettime/gettimeofday/nanosleep/times
- **系统信息** (`sys.rs`): uname/statfs/prlimit64/mount/umount2 等

### 3. 文件系统子系统 (`filesystem/`)
采用 VFS 分层架构：`vfscore` 提供核心抽象，`fs` 层实现具体文件系统适配（ext4 via `ext4_rs`/`lwext4_rust`、FAT via `rust-fatfs`），`devfs`/`procfs`/`ramfs` 提供特殊文件系统。支持 pipe、dentry 缓存、路径解析等。

### 4. 驱动子系统 (`driver/`)
覆盖 VirtIO 块设备/网络/输入设备、PLIC 中断控制器、Goldfish RTC、NS16550A UART、RAM Disk。通过 `crates/devices` 提供统一的设备抽象接口。

### 5. 内存管理子系统 (`crates/runtime/`)
包含物理页帧分配器 (`frame.rs`) 和堆分配器 (`heap.rs`)，内核通过 `polyhal` 进行页表管理，用户态支持 COW (Copy-on-Write) 缺页处理。

### 6. 调度/执行器子系统 (`crates/executor/`)
基于异步模型的协程执行器，包含 executor、task、thread 抽象。

### 7. 网络子系统 (`kernel/src/socket.rs` + `kvirtio/virtio_net.rs`)
使用 `lose-net-stack` 库实现网络协议栈，通过 VirtIO 网卡驱动提供 socket 接口。

### 8. 信号子系统 (`crates/signal/` + `kernel/src/tasks/signal.rs` + `kernel/src/user/signal.rs`)
完整的 POSIX 信号机制，支持信号发送、掩码、挂起、定时等待等。

## 构建工具需求

| 工具 | 用途 |
|------|------|
| Rust nightly-2024-08-01 (含 rust-src, llvm-tools-preview) | 编译内核 |
| cargo | 构建管理 |
| rust-objcopy (cargo-binutils) | 生成 RISC-V 二进制镜像 |
| GNU Make | 构建入口 |
| QEMU (riscv64 + loongarch64) | 运行与测试 |
| dtc (Device Tree Compiler) | 设备树相关（间接依赖） |

构建命令为 `make all`，分别编译 RISC-V 和 LoongArch 两个目标，使用 `--offline` 模式从 vendor 目录获取依赖。