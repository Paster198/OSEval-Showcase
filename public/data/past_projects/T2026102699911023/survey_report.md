# StarryOS 项目初步调查报告

## 一、项目概览

**StarryOS** 是一个基于 ArceOS 单内核框架构建的 **Linux 兼容宏内核 OS**。项目使用 Rust 语言编写，目标是提供一个类 Linux 的用户空间运行环境，支持加载和执行 Linux ELF 可执行程序，并实现了一套较完整的 Linux 系统调用接口。

- **项目名称**: StarryOS (Starry-OS)
- **许可证**: Apache-2.0
- **Rust 工具链**: nightly-2025-05-20
- **支持架构**: RISC-V 64、LoongArch64、AArch64（x86_64 开发中）
- **面向平台**: QEMU virt（主要）、VisionFive2（RISC-V 开发板）

---

## 二、仓库文件组织结构

```
repo/
├── Cargo.toml                  # 工作区根配置，定义 workspace
├── Cargo.lock                  # 依赖锁定文件
├── Makefile                    # 顶层构建入口（ARCH=riscv64/loongarch64）
├── rust-toolchain.toml         # Rust nightly 工具链指定
├── rustfmt.toml                # 代码格式配置
├── README.md                   # 项目说明
├── setup-tools.sh              # 构建工具初始化脚本
│
├── src/
│   ├── main.rs                 # 内核入口：调用 kernel::entry::init
│   └── init.sh                 # 嵌入的 init 进程命令行脚本
│
├── kernel/                     # 【核心】starry-kernel 内核 crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs              # 模块声明 & no_std 配置
│       ├── entry.rs            # 内核初始化 & init 进程启动
│       ├── time.rs             # 时间工具类型
│       ├── config/             # 各架构配置 (riscv64/loongarch64/x86_64/aarch64)
│       ├── task/               # 用户任务管理子系统
│       ├── syscall/            # Linux 系统调用处理子系统
│       ├── file/               # 文件描述符表 & 统一文件类型子系统
│       ├── mm/                 # 用户态内存管理子系统
│       └── pseudofs/           # 伪文件系统子系统
│
├── axfs-ng-local/              # ArceOS 文件系统模块本地补丁 (ext4 + FAT)
│   └── src/
│       ├── fs/ext4/            # ext4 实现
│       ├── fs/fat/             # FAT 实现
│       └── highlevel/          # 高层文件/目录操作
│
├── kernel-elf-parser-local/    # ELF 解析器本地补丁
│   └── src/
│       ├── auxv.rs             # 辅助向量 (AuxVec) 处理
│       ├── info.rs             # ELF 信息提取
│       └── user_stack.rs       # 用户栈构建
│
├── make/                       # 构建系统（Makefile 子集）
│   ├── Makefile                # 构建规则
│   ├── build.mk                # 编译规则
│   ├── cargo.mk                # Cargo 构建封装
│   ├── config.mk               # 配置生成 (axconfig-gen)
│   ├── deps.mk                 # 依赖管理
│   ├── features.mk             # Feature 选择逻辑
│   ├── platform.mk             # 平台选择逻辑
│   ├── qemu.mk                 # QEMU 启动规则
│   └── defconfig.toml          # 默认配置模板
│
├── vendor/                     # 已 vendored 的依赖 crate (~360 个)
│   ├── axfeat/                 # ArceOS 顶层 feature 选择
│   ├── axhal/                  # ArceOS 硬件抽象层
│   ├── axruntime/              # ArceOS 运行时（引导/初始化）
│   ├── axalloc/                # 物理/虚拟内存分配器
│   ├── axmm/                   # 内核态内存管理
│   ├── axdriver/               # 设备驱动框架 (virtio, PCI)
│   ├── axfs-ng-vfs/            # VFS 抽象层
│   ├── axnet-ng/               # 网络栈
│   ├── axtask/                 # 任务调度和管理
│   ├── axsync/                 # 同步原语
│   ├── axinput/                # 输入设备支持
│   ├── axdisplay/              # 显示设备支持
│   ├── axconfig/               # 配置系统
│   ├── axio/                   # I/O trait 抽象
│   ├── axpoll/                 # Poll 机制
│   ├── axerrno/                # 错误码
│   ├── starry-process/         # Starry 进程管理库
│   ├── starry-signal/          # Starry 信号管理库
│   ├── starry-vm/              # Starry 虚拟内存管理库
│   ├── starry-smoltcp/         # Starry TCP/IP 协议栈 (smoltcp fork)
│   ├── axplat-*/               # 各平台实现 (riscv64-qemu-virt 等)
│   ├── virtio-drivers/         # VirtIO 驱动实现
│   └── ...                     # 其它通用依赖
│
├── tools/                      # 预构建辅助工具
│   ├── axconfig-gen             # 配置生成工具
│   ├── cargo-axplat             # 平台选择工具
│   ├── rust-objcopy / rust-objdump / rust-size
│
├── scripts/
│   ├── ci-test.py              # CI 测试脚本
│   └── test.sh                 # 测试脚本
│
├── docs/
│   └── x11.md                  # X11 支持文档
│
└── cargo-config/
    └── config.toml             # Cargo 镜像/配置
```

---

## 三、子系统划分

### 1. 系统调用层 (`kernel/src/syscall/`) — Linux ABI 兼容

约 640 行的 `mod.rs` 中集中分发所有 Linux 系统调用。子模块按功能分组：

| 子模块 | 目录/文件 | 功能 |
|--------|-----------|------|
| **文件系统** | `syscall/fs/` (ctl, event, fd_ops, io, memfd, mount, pipe, stat, signalfd, pidfd) | open/openat, close, read/write, lseek, fcntl, chdir, getdents64, stat/fstat, mount, sync, symlink, rename, truncate, utimensat 等 |
| **内存管理** | `syscall/mm/` (brk, mmap, mincore) | brk, mmap/munmap, mprotect, madvise, msync 等 |
| **网络** | `syscall/net/` (addr, cmsg, io, name, opt, socket) | socket/bind/listen/accept/connect, sendmsg/recvmsg, getsockname/getpeername 等 |
| **任务管理** | `syscall/task/` (clone, clone3, ctl, execve, exit, job, schedule, thread, wait) | clone/clone3, execve/execveat, exit/exit_group, wait/waitid/waitpid, sched_yield, prctl, set_tid_address 等 |
| **I/O 多路复用** | `syscall/io_mpx/` (epoll, poll, select) | epoll_create/epoll_ctl/epoll_wait, poll/ppoll, select/pselect6 |
| **进程间通信** | `syscall/ipc/` (msg, shm) | msgget/msgsnd/msgrcv/msgctl, shmget/shmat/shmdt/shmctl |
| **同步原语** | `syscall/sync/` (futex, membarrier) | futex, membarrier |
| **信号** | `syscall/signal.rs` | kill/tkill, sigaction/sigprocmask, sigreturn, rt_sigpending 等 |
| **时间** | `syscall/time.rs` | clock_gettime, nanosleep, timerfd_create/settime/gettime 等 |
| **系统信息** | `syscall/sys.rs` | uname, sysinfo, getpid/getppid, getuid/geteuid 等 |
| **资源限制** | `syscall/resources.rs` | getrlimit/setrlimit, prlimit64 |

### 2. 任务管理子系统 (`kernel/src/task/`)

管理用户态进程和线程。基于 ArceOS 的 `axtask` 框架扩展：

- **进程模型**: `ProcessData` (进程级共享数据: 地址空间、信号管理器、文件资源 scope)、`Thread` (线程级数据: 信号、定时器、退出状态)
- **外部库依赖**: `starry-process` (进程树、PID 分配、会话/进程组)、`starry-signal` (信号递送与处理)
- **子模块**: 调度操作 (`ops`)、资源限制 (`resources`)、信号处理 (`signal`)、统计 (`stat`)、定时器管理 (`timer`)、用户态访问辅助 (`user`)、futex (`futex`)

### 3. 文件子系统 (`kernel/src/file/`)

统一文件描述符表及文件类型抽象：

- **文件类型**: 普通文件 (`File`)、目录 (`Directory`)、管道 (`Pipe`)、套接字 (`Socket`)、epoll 实例、signalfd、pidfd、eventfd
- **基于 trait 的多态**: 使用 `downcast-rs` 和 `FlattenObjects` 实现类型的统一访问
- **数据结构**: `FD_TABLE` (进程级文件描述符表)、`Kstat` (内核统一 stat 结构)

### 4. 内存管理子系统 (`kernel/src/mm/`)

用户态地址空间管理，基于 `starry-vm` 库：

- **地址空间** (`aspace/`): 支持多种映射后端 — `cow` (写时复制)、`file` (文件映射)、`linear` (线性映射如堆)、`shared` (共享内存)
- **加载器** (`loader.rs`): 解析 ELF 并加载可执行程序
- **用户内存访问** (`access.rs`): 内核态访问用户态内存的安全包装
- **I/O** (`io.rs`): 用户空间 I/O 操作支持

### 5. 伪文件系统子系统 (`kernel/src/pseudofs/`)

提供 Linux 经典伪文件系统：

- **/proc**: 进程信息伪文件系统
- **/tmp**: 基于内存的临时文件系统 (`MemoryFs`)
- **/dev**: 设备节点，包括:
  - `tty/`: PTY 对 (ptm/pts)、终端驱动 (行规程、作业控制、termios)
  - `fb`: 帧缓冲设备
  - `rtc`: 实时时钟
  - `loop`: 回环设备
  - `log`: 日志设备
  - `event`: 事件设备
  - `memtrack`: 内存跟踪设备

### 6. 配置子系统 (`kernel/src/config/`)

各架构特定常量和参数定义，4 种架构文件：`riscv64.rs`、`loongarch64.rs`、`x86_64.rs`、`aarch64.rs`。

### 7. ArceOS 底层框架（通过 vendor 依赖引入）

ArceOS 提供完整的底层支持：

| 模块 | 功能 |
|------|------|
| **axhal** | 硬件抽象层（中断、分页、TLS、FP/SIMD、RTC）|
| **axruntime** | 运行时引导（CPU 初始化、平台探测、模块初始化顺序）|
| **axalloc** | 物理页分配 (4G/64G)、slab 分配器 |
| **axdriver** | 设备驱动框架 (VirtIO-blk/net/gpu/input, ramdisk, SDMMC) |
| **axfs-ng** | 文件系统实现 (ext4 via lwext4_rust, FAT via starry-fatfs) |
| **axnet-ng** | 网络栈 (基于 starry-smoltcp) |
| **axtask** | 任务调度 (Round-Robin) 和任务扩展机制 |
| **axsync** | 同步原语 (Mutex, SpinLock) |
| **axlog** | 日志宏基础设施 |

---

## 四、构建工具需求

### 必需工具

1. **Rust 工具链**: `nightly-2025-05-20`，含 `rust-src`、`llvm-tools`、`rustfmt`、`clippy`
2. **目标三元组**:
   - `riscv64gc-unknown-none-elf` (RISC-V)
   - `loongarch64-unknown-none-softfloat` (LoongArch)
   - `aarch64-unknown-none-softfloat` (AArch64)
   - `x86_64-unknown-none` (x86_64)
3. **Musl 交叉编译工具链** (用于构建用户态程序 rootfs)
4. **QEMU**: 至少支持 `qemu-system-riscv64` 和 `qemu-system-loongarch64`（LoongArch 需要 QEMU 10+）
5. **Cargo 子命令**: 项目自带预构建版本：`axconfig-gen`、`cargo-axplat`、`rust-objcopy`、`rust-objdump`、`rust-size`
6. **系统依赖**: `build-essential`、`cmake`、`clang`（用于编译 C 依赖如 lwext4）

### 构建方式

```bash
# 构建 RISC-V 和 LoongArch 双架构内核
make all

# 单独架构构建和运行
make ARCH=riscv64 build    # 构建
make rv                    # 构建并运行 (RISC-V)
make la                    # 构建并运行 (LoongArch)

# 需要先准备文件系统镜像
make rootfs
```

### 构建输出

- `kernel-rv`: RISC-V 64 内核 ELF (`oskernel2025-8512_riscv64-qemu-virt.elf`)
- `kernel-la`: LoongArch64 内核 ELF (`oskernel2025-8512_loongarch64-qemu-virt.elf`)

---

## 五、初步评估总结

该项目是一个定位清晰、结构完整的 Linux 兼容宏内核：

1. **架构分层合理**: 顶层 `src/main.rs` 作为最小入口，`kernel/` 作为宏内核核心实现，依赖 ArceOS 基础框架提供 HAL 和驱动支持。
2. **系统调用覆盖广泛**: 覆盖了 Linux 主要功能域——文件 I/O、进程/线程管理、内存管理、网络套接字、信号、IPC（共享内存/消息队列）、I/O 多路复用（epoll）、futex、资源限制等。
3. **文件系统支持**: 通过 ArceOS 的 `axfs-ng` 支持 ext4 和 FAT，并实现了自己的伪文件系统层（proc、tmpfs、devfs）。
4. **多架构支持**: 实现了 RISC-V、LoongArch、AArch64 三个架构，x86_64 在开发中。
5. **代码规模**: 排除 vendor 依赖，核心 `.rs` 源文件约 127 个，文件数量适中，模块划分清晰。