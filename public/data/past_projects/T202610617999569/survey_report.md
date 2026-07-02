## 项目初步调查报告

### 一、项目概况

该项目名为 **MOSS OS**（仓库内也称 **StarryOS**），是一个基于 **ArceOS unikernel** 演进而来的 **Rust 宏内核操作系统**。主要目标是实现 Linux 用户态兼容，面向操作系统比赛场景开发。当前版本支持 **RISC-V 64** 和 **LoongArch64** 两种架构，可运行 BusyBox、musl/glibc 用户程序、性能测试套件以及 LTP 系统调用测试。

---

### 二、仓库文件组织结构

```
repo/
├── Cargo.toml              # Workspace 根配置，定义 workspace 成员与依赖
├── Cargo.lock
├── Makefile                # 顶层构建入口（构建、运行、调试等目标）
├── cargo-config.toml       # Cargo 配置模板
├── rustfmt.toml
├── src/                    # 二进制入口 crate（starryos）
│   ├── main.rs             # 内核入口：设置 init 参数，调用 kernel entry
│   ├── init.sh             # 默认 init 脚本
│   ├── init_shell.sh       # shell 模式 init 脚本
│   ├── ltp_testcases.sh    # LTP 测试用例列表
│   └── todo_syscall.sh     # 待实现 syscall 列表
├── kernel/                 # 内核核心 crate（starry-kernel）
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # crate 根，声明各子系统模块
│       ├── entry.rs        # 内核初始化入口
│       ├── config/         # 架构相关配置（riscv64/loongarch64/x86_64/aarch64）
│       ├── file/           # 文件抽象层（FileLike trait 等）
│       ├── mm/             # 内存管理（地址空间、加载器、访问接口）
│       ├── pseudofs/       # 伪文件系统（/dev, /proc, /sys, /tmp）
│       ├── syscall/        # 系统调用分发与实现
│       ├── task/           # 进程/线程管理
│       └── time.rs         # 时间管理
├── vendor/                 # 本地 vendored 依赖（fork / patch）
│   ├── axhal/              # 硬件抽象层
│   ├── axplat/             # 平台抽象层（多架构支持）
│   ├── axfs/               # 文件系统框架
│   ├── axfs-ng-vfs/        # VFS 层
│   ├── starry-process/     # 进程管理库
│   ├── starry-signal/      # 信号管理库
│   ├── starry-smoltcp/     # 网络协议栈（smoltcp 定制版）
│   └── ... (大量 ArceOS 生态 crate)
├── third_party/            # 第三方代码
│   ├── lwext4_rust/        # ext4 文件系统 Rust 绑定
│   └── syscalls/           # syscall 编号枚举库
├── syscalls_code/          # LTP syscall 测试用例（365+ 个子目录）
├── make/                   # 构建子系统的 Makefile
│   ├── Makefile            # 子构建入口
│   ├── build.mk
│   ├── cargo.mk
│   ├── config.mk
│   ├── platform.mk         # 架构/平台解析
│   ├── features.mk         # feature 解析
│   ├── qemu.mk             # QEMU 启动配置
│   └── *.ld               # 链接脚本
├── scripts/                # 辅助脚本（运行、测试、汇总）
├── docs/                   # 文档与测试日志
│   ├── benchmark/
│   ├── cyclictest/
│   ├── iozone/
│   ├── iperf/
│   ├── libcbench/
│   ├── lmbench/
│   ├── netperf/
│   ├── report_primary/
│   └── saved_logs/
└── .github/                # CI/CD 配置
```

---

### 三、实现的子系统

根据 `kernel/src/lib.rs` 的模块声明及目录结构，内核共实现以下核心子系统：

| 子系统 | 对应目录 | 功能概述 |
|--------|----------|----------|
| **系统调用层** | `kernel/src/syscall/` | 系统调用分发与实现，按功能分为 fs、mm、net、task、signal、sync、io_mpx、ipc、bpf、time、resources 等子模块 |
| **任务/进程管理** | `kernel/src/task/` | 进程（Process）与线程（Thread）管理，包括 futex、信号处理、资源限制、定时器、用户态上下文、统计信息等 |
| **内存管理** | `kernel/src/mm/` | 用户地址空间（AddrSpace）、页表操作、内存映射后端（COW/File/Linear/Shared）、ELF 加载器、用户内存安全访问 |
| **文件系统** | `kernel/src/file/` | FileLike trait 抽象层，统一管理各类文件对象：普通文件、目录、管道、Socket、epoll、eventfd、timerfd、signalfd、BPF 等 |
| **伪文件系统** | `kernel/src/pseudofs/` | /dev（tty、fb、log、rtc、memtrack、loop）、/proc、/sys、/tmp（tmpfs）、/dev/shm 等伪文件系统 |
| **网络子系统** | `kernel/src/file/net.rs` `kernel/src/syscall/net/` | 基于 starry-smoltcp（定制 smoltcp）的 TCP/IP 协议栈，socket 系统调用 |
| **信号子系统** | `kernel/src/task/signal.rs` `kernel/src/syscall/signal.rs` | 基于 starry-signal 库的 POSIX 信号机制，支持进程级和线程级信号管理 |
| **时间管理** | `kernel/src/time.rs` `kernel/src/task/timer.rs` | 时间获取、定时器管理、timerfd 等 |
| **IPC** | `kernel/src/syscall/ipc/` | System V IPC（消息队列 msg、共享内存 shm）以及 futex |
| **I/O 多路复用** | `kernel/src/syscall/io_mpx/` | epoll、poll、select |
| **BPF** | `kernel/src/file/bpf.rs` `kernel/src/syscall/bpf.rs` | 基本的 BPF 程序和 BPF map（array、hash、ringbuf）支持 |
| **架构配置** | `kernel/src/config/` | 4 种架构的差异化配置（riscv64、loongarch64、x86_64、aarch64） |

此外，通过 vendor 目录引入了 ArceOS 生态的基础设施 crate：

| Crate | 功能 |
|-------|------|
| `axhal` | 硬件抽象层（HAL） |
| `axplat` | 平台抽象层（QEMU virt 平台适配） |
| `axfs` / `axfs-ng-vfs` | 文件系统框架与 VFS 层 |
| `axmm` | 页帧分配、页表操作底层 |
| `axtask` | 任务调度与上下文切换 |
| `axruntime` | 运行时初始化 |
| `axdriver` | 设备驱动框架（virtio、PCI 等） |
| `axalloc` | 内核内存分配器（slab） |
| `axsync` | 同步原语 |
| `starry-process` | 进程抽象（PID 管理、进程树） |
| `starry-signal` | 信号机制 |
| `starry-smoltcp` | 网络协议栈 |

---

### 四、子系统与代码目录粗略对应

| 目录/文件路径 | 所属子系统 |
|---------------|-----------|
| `kernel/src/syscall/mod.rs` | 系统调用总入口，dispatch 所有 syscall |
| `kernel/src/syscall/fs/*.rs` | 文件系统相关系统调用（open/read/write/stat/mount 等） |
| `kernel/src/syscall/mm/*.rs` | 内存管理系统调用（mmap/brk/mprotect 等） |
| `kernel/src/syscall/task/*.rs` | 进程管理系统调用（clone/execve/exit/wait/prctl 等） |
| `kernel/src/syscall/net/*.rs` | 网络系统调用（socket/bind/connect/send/recv 等） |
| `kernel/src/syscall/io_mpx/*.rs` | I/O 多路复用系统调用（epoll/poll/select） |
| `kernel/src/syscall/ipc/*.rs` | IPC 系统调用 |
| `kernel/src/syscall/sync/*.rs` | 同步系统调用（futex/membarrier） |
| `kernel/src/syscall/signal.rs` | 信号系统调用 |
| `kernel/src/syscall/time.rs` | 时间系统调用 |
| `kernel/src/syscall/bpf.rs` | BPF 系统调用 |
| `kernel/src/task/mod.rs` | 进程/线程核心数据结构（Thread, ProcessData） |
| `kernel/src/task/ops.rs` | 进程操作（创建、销毁等） |
| `kernel/src/task/signal.rs` | 进程级信号处理逻辑 |
| `kernel/src/task/futex.rs` | Futex 表实现 |
| `kernel/src/task/timer.rs` | 进程定时器 |
| `kernel/src/mm/aspace/` | 地址空间抽象及映射后端 |
| `kernel/src/mm/loader.rs` | ELF 加载 |
| `kernel/src/mm/access.rs` | 用户内存安全访问 |
| `kernel/src/file/mod.rs` | FileLike trait 及文件描述符表 |
| `kernel/src/file/fs.rs` | 磁盘文件系统文件实现 |
| `kernel/src/file/pipe.rs` | 管道 |
| `kernel/src/file/epoll.rs` | epoll 文件实现 |
| `kernel/src/file/event.rs` | eventfd |
| `kernel/src/file/timerfd.rs` | timerfd |
| `kernel/src/file/signalfd.rs` | signalfd |
| `kernel/src/file/net.rs` | Socket 文件 |
| `kernel/src/file/bpf.rs` | BPF map/program 文件 |
| `kernel/src/file/pidfd.rs` | pidfd |
| `kernel/src/pseudofs/dev/` | /dev 设备文件 |
| `kernel/src/pseudofs/proc.rs` | /proc 文件系统 |
| `kernel/src/pseudofs/tmp.rs` | tmpfs |
| `kernel/src/config/*.rs` | 架构特定配置 |

---

### 五、编译构建工具需求

根据 `Makefile`、`make/` 子目录和 `Cargo.toml` 的分析，编译该项目需要以下工具：

| 工具 | 用途 |
|------|------|
| **Rust 工具链** (nightly-2025-05-20) | 内核主体编译，通过 `rustup` 管理 |
| **cargo-binutils** (`rust-objcopy`, `rust-lld`) | 二进制处理与链接 |
| **RISC-V 交叉编译工具链**（或 `rust-lld` 替代） | RISC-V 64 架构目标 `riscv64gc-unknown-none-elf` |
| **LoongArch64 交叉编译 GCC** (`loongarch64-linux-musl-gcc` 或 `loongarch64-linux-gnu-gcc`) | LoongArch64 目标 `loongarch64-unknown-none-softfloat` 的辅助编译 |
| **GNU Make** | 构建编排 |
| **QEMU** (RISC-V: `qemu-system-riscv64`, LoongArch: `qemu-system-loongarch64`) | 模拟运行 |
| **rootfs 镜像** | 运行所需的根文件系统（从 GitHub Release 下载） |
| **可选：GDB** (`gdb-multiarch`) | 调试 |

核心构建产物为 `kernel-rv`（RISC-V 64）和 `kernel-la`（LoongArch64），是经过 `rust-objcopy`/GCC 包装处理的二进制内核镜像。