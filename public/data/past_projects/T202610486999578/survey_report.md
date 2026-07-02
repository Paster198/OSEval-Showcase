## 项目初步调查结果

### 一、项目概览

该项目名为 **StarryOS**（比赛名称为 `oskernel2026-nexuscore` / NexusCore），是基于 ArceOS unikernel 框架构建的 Linux 兼容宏内核，使用 Rust 编写。支持 RISC-V 64、LoongArch64、AArch64 三种架构（x86_64 为进行中状态）。项目采用 Cargo workspace 组织，位于 `Starry-OS` 组织下。

---

### 二、文件组织结构

```
.
├── Cargo.toml                  # Workspace 根配置，定义依赖与 features
├── Cargo.lock                  # 依赖锁定文件
├── Makefile                    # 顶层构建入口
├── rust-toolchain.toml         # Rust 工具链版本 (nightly-2025-05-20)
├── rustfmt.toml                # 代码格式化配置
├── .axconfig-rv.toml           # RISC-V 平台配置
├── .axconfig-la.toml           # LoongArch 平台配置
├── README.md                   # 项目说明
├── src/                        # 用户态入口 / 引导程序
│   ├── main.rs                 # 内核入口点，调用 kernel::entry::init
│   ├── init.sh                 # 嵌入到内核中的初始化脚本
│   ├── ltp_whitelist.txt       # LTP 测试白名单
│   └── ltp_blacklist.txt       # LTP 测试黑名单
├── kernel/                     # 内核核心 crate (starry-kernel)
│   ├── Cargo.toml              # 内核 crate 依赖
│   ├── build.rs                # 构建脚本 (嵌入 LTP 白名单)
│   └── src/                    # 内核源代码
│       ├── lib.rs              # kernel crate 根模块
│       ├── entry.rs            # 内核初始化入口
│       ├── time.rs             # 时间子系统
│       ├── ltp_whitelist.rs    # LTP 白名单运行时处理
│       ├── config/             # 架构特定配置 (riscv64/la64/x86_64/aarch64)
│       ├── file/               # 文件描述符与文件类型抽象层
│       ├── mm/                 # 用户态地址空间管理 (含 aspace 后端)
│       ├── net/                # 网络子系统 (命名空间、设备、协议)
│       ├── pseudofs/           # 伪文件系统 (/proc, /sys, /dev, tmpfs 等)
│       ├── syscall/            # 系统调用实现
│       └── task/               # 任务/进程管理
├── make/                       # 构建系统细节 (Makefile 片段)
│   ├── Makefile, build.mk, cargo.mk, config.mk, platform.mk, qemu.mk, features.mk, ...
│   └── defconfig.toml
├── patches/                    # 本地补丁/覆盖的依赖 crate
│   ├── axcpu/                  # CPU 相关补丁
│   ├── axfs-ng/                # 文件系统补丁
│   ├── axio/                   # I/O 抽象补丁
│   ├── axnet-ng/               # 网络栈补丁
│   ├── axplat-loongarch64-qemu-virt/  # LoongArch 平台支持
│   └── starry-vm/              # 虚拟内存子系统补丁
├── scripts/                    # 辅助脚本
│   ├── test.sh, ci-test.py     # 测试脚本
│   ├── setup_wsl_native_env.sh # WSL 环境配置
│   └── journalfs_crash_test.sh # 日志文件系统崩溃测试
├── docs/                       # 文档
└── 展示资料/                   # 比赛展示材料 (设计文档、工作日志等)
```

---

### 三、子系统划分

根据 `kernel/src/` 目录结构及代码分析，该内核实现了以下主要子系统：

| 子系统 | 目录 | 核心职责 | 代码规模(行) |
|--------|------|---------|-------------|
| **系统调用层** | `kernel/src/syscall/` | Linux syscall 兼容层，分发所有系统调用 | ~15,500 |
| **伪文件系统** | `kernel/src/pseudofs/` | /proc, /sys, /dev, tmpfs, journalfs, tracefs | ~6,000 |
| **文件抽象层** | `kernel/src/file/` | 文件描述符表、管道、epoll、eventfd、signalfd 等 | ~3,400 |
| **网络子系统** | `kernel/src/net/` | 网络命名空间、虚拟设备、ICMP、UDP、packet socket、rtnetlink | ~3,200 |
| **任务管理** | `kernel/src/task/` | 进程/线程管理、信号、futex、定时器、资源管理 | ~2,500 |
| **内存管理** | `kernel/src/mm/` | 用户态地址空间、mmap、COW、文件映射后端、ELF 加载 | ~1,700 |
| **初始化入口** | `kernel/src/entry.rs` | 内核启动、init 进程加载 | ~356 |
| **时间子系统** | `kernel/src/time.rs` | 时钟与定时相关 | ~130 |
| **架构配置** | `kernel/src/config/` | 四个架构的条件编译配置 | ~100 |

#### 子系统详解：

**1. 系统调用层 (`syscall/`)**
按功能域组织子模块：
- `fs/` — 文件系统相关：open/read/write/stat/mount/io_uring/inotify/fanotify/memfd/signalfd/pidfd 等
- `task/` — 进程/线程：clone/clone3/execve/exit/wait/schedule/namespace 等
- `net/` — 网络：socket/bind/connect/sendmsg/recvmsg/getsockopt/netlink 等
- `mm/` — 内存：mmap/munmap/brk/mincore 等
- `sync/` — 同步：futex/membarrier 等
- `ipc/` — 进程间通信：msg queue/shared memory
- `io_mpx/` — I/O 多路复用：epoll/poll/select
- `signal.rs` — 信号处理
- `time.rs` — 时间相关系统调用
- `module.rs` — 内核模块 (init_module/delete_module)
- `bpf.rs` — BPF 系统调用
- `key.rs` — 内核密钥管理
- `aio.rs` — 异步 I/O

**2. 伪文件系统 (`pseudofs/`)**
- `proc.rs` — /proc 文件系统 (进程信息等，约 2,167 行，最大的单文件)
- `sys.rs` / `sysfs.rs` — /sys 文件系统
- `dev/` — /dev 设备节点 (block, event, fb, log, loop, memtrack, rtc, tty/pty)
- `tmp.rs` — tmpfs 内存文件系统
- `journal.rs` — 日志文件系统 (含崩溃恢复)
- `tracing.rs` — tracefs 跟踪文件系统
- `blockdev.rs` — 块设备抽象

**3. 文件抽象层 (`file/`)**
- `fs.rs` — 通用文件操作
- `pipe.rs` — 管道
- `epoll.rs` — epoll 事件
- `event.rs` — eventfd
- `signalfd.rs` / `pidfd.rs` — 特殊 fd 类型
- `net.rs` — socket 文件描述符
- `af_alg.rs` — 内核加密算法 socket
- `can.rs` — CAN bus socket
- `ipv6_raw.rs` — IPv6 raw socket
- `fanotify.rs` — 文件监控

**4. 网络子系统 (`net/`)**
- `namespace.rs` — 网络命名空间管理
- `device.rs` — 虚拟网络设备
- `rtnetlink.rs` — 路由 netlink
- `icmp.rs`, `udp4.rs` — 协议实现
- `packet.rs` — packet socket
- `ipv6.rs` — IPv6 支持

**5. 任务管理 (`task/`)**
- `signal.rs` — Unix 信号处理
- `futex.rs` — futex 同步原语
- `ops.rs` — 任务操作 (创建、调度等)
- `resources.rs` — 资源限制 (rlimit)
- `timer.rs` / `posix_timer.rs` — 定时器
- `stat.rs` — 任务统计信息
- `user.rs` — 用户态上下文
- `keyring.rs` — 密钥环
- `aio.rs` — 异步 I/O 任务

**6. 内存管理 (`mm/`)**
- `aspace/` — 地址空间抽象 (含 COW、文件映射、线性映射、共享映射后端)
- `loader.rs` — ELF 加载器
- `access.rs` — 用户态内存访问 (copy_from/to_user)
- `io.rs` — 内存映射 I/O
- `mmap_rnd.rs` — mmap 随机化

---

### 四、编译构建工具

根据 Makefile、Cargo.toml 及 rust-toolchain.toml 分析，构建该项目需要：

| 类别 | 工具 | 说明 |
|------|------|------|
| **Rust 工具链** | nightly-2025-05-20 | 包含 rust-src、llvm-tools 组件 |
| **Rust 编译目标** | `riscv64gc-unknown-none-elf` | RISC-V 64 裸机目标 |
| | `loongarch64-unknown-none-softfloat` | LoongArch 64 裸机目标 |
| **Rust 辅助** | `rust-objcopy`, `rust-lld` | 来自 llvm-tools |
| **交叉编译** | `loongarch64-linux-musl-gcc` | LoongArch 交叉编译 (用于生成 kernel-la) |
| **构建系统** | GNU Make | 顶层和 make/ 子目录 |
| **配置工具** | `axconfig-gen` | 来自 axconfig crate，生成平台配置 |
| **QEMU** | qemu-system-riscv64 / qemu-system-loongarch64 | 模拟运行 |
| **文件系统** | curl, xz | 下载 rootfs 镜像 |
| **容器化** | Docker (可选) | 预置环境镜像 `zhouzhouyi/os-contest:20260104` |

构建流程：`make ARCH=riscv64` → 生成 `.axconfig-rv.toml` → `cargo build` → `rust-objcopy` / `rust-lld` 生成最终 ELF 内核镜像。