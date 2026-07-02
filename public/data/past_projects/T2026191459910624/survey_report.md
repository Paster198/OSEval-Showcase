# Starry_fix 项目初步调查报告

## 一、项目概述

Starry_fix 是基于 [StarryOS](https://github.com/Starry-OS/StarryOS) 的改进分支。StarryOS 本身是一个基于 ArceOS 组件化框架构建的 Linux 兼容宏内核，采用 Rust 语言编写。本项目在 StarryOS 之上进行了系统调用层修复、信号机制完善与多架构适配工作。

## 二、仓库文件组织结构

```
Starry_fix/
├── kernel/                    # 内核核心 crate (starry-kernel)
│   ├── Cargo.toml             # 内核 crate 清单
│   └── src/
│       ├── lib.rs             # 内核库入口
│       ├── entry.rs           # 内核初始化入口 (init 进程启动)
│       ├── time.rs            # 时间管理
│       ├── config/            # 架构相关配置
│       │   ├── mod.rs         # 条件编译分发
│       │   ├── riscv64.rs
│       │   ├── loongarch64.rs
│       │   ├── x86_64.rs
│       │   └── aarch64.rs
│       ├── syscall/           # 系统调用层
│       │   ├── mod.rs         # syscall 分发器 (640行)
│       │   ├── fs/            # 文件系统 syscall
│       │   ├── mm/            # 内存管理 syscall
│       │   ├── task/          # 进程/线程管理 syscall
│       │   ├── net/           # 网络 syscall
│       │   ├── ipc/           # 进程间通信 syscall
│       │   ├── sync/          # 同步原语 syscall
│       │   ├── io_mpx/        # IO多路复用 syscall
│       │   ├── signal.rs      # 信号处理
│       │   ├── time.rs        # 时间相关 syscall
│       │   ├── resources.rs   # 资源限制
│       │   └── sys.rs         # 通用系统调用
│       ├── file/              # 文件描述符框架
│       ├── mm/                # 内存管理 (地址空间、加载器等)
│       ├── task/              # 任务管理 (信号、定时器、futex等)
│       └── pseudofs/          # 伪文件系统 (dev, proc, tmp)
│
├── src/                       # 工作区根 crate (starryos)
│   ├── main.rs                # 内核入口点 (#![no_std] #![no_main])
│   └── init.sh                # 用户态 init 脚本
│
├── vendor/                    # 343 个第三方依赖 crate (fork 并本地化)
│
├── axfs-ng-patched/           # 本地修补的 axfs-ng (文件系统)
├── axio-patched/              # 本地修补的 axio (I/O 抽象)
├── axnet-ng-patched/          # 本地修补的 axnet-ng (网络栈)
├── starry-vm-patched/         # 本地修补的 starry-vm (虚拟内存)
│
├── make/                      # GNU Make 构建系统
│   ├── Makefile               # 主 Makefile (构建逻辑)
│   ├── build.mk               # 构建脚本
│   ├── qemu.mk                # QEMU 启动参数
│   ├── features.mk            # feature 解析
│   ├── platform.mk            # 平台解析
│   ├── config.mk / deps.mk    # 配置和依赖
│   └── defconfig.toml         # 默认配置模板
│
├── Makefile                   # 顶层 Makefile (用户界面)
├── Cargo.toml / Cargo.lock    # Rust 工作区清单
├── rust-toolchain.toml        # Rust 工具链版本锁定
│
├── scripts/                   # 测试与CI脚本
│   ├── test.sh                # 多步骤测试脚本
│   ├── ci-test.py             # CI 测试入口
│   └── flash.sh               # 烧录脚本
│
├── for_oscomp/                # 操作系统比赛相关脚本
├── tools/bin/                 # 预编译二进制工具
│   ├── axconfig-gen           # 配置生成工具
│   ├── cargo-axplat           # 平台解析工具
│   └── rust-* / cargo-*       # LLVM binutils 工具链
│
├── rootfs-riscv64.img.xz      # RISC-V 根文件系统镜像 (压缩)
├── rootfs-loongarch64.img.xz  # LoongArch64 根文件系统镜像 (压缩)
├── DESIGN_REPORT.pdf / .txt   # 设计报告
├── README.md                  # 项目说明
└── docs/                      # 额外文档
```

## 三、子系统划分

### 1. 系统调用层 (`kernel/src/syscall/`)

内核与用户态的主要接口，按功能域分为 10 个子模块：

| 子模块 | 目录/文件 | 职责 |
|--------|-----------|------|
| 文件系统 | `syscall/fs/` | 文件操作 (io, stat, mount, pipe, eventfd, signalfd, pidfd, memfd, fd_ops, ctl) |
| 内存管理 | `syscall/mm/` | mmap, brk, mincore |
| 进程管理 | `syscall/task/` | clone/clone3, execve, wait, exit, schedule, thread, job, ctl |
| 网络栈 | `syscall/net/` | socket, addr, io, opt, name, cmsg |
| IPC | `syscall/ipc/` | msg, shm |
| 同步 | `syscall/sync/` | futex, membarrier |
| IO多路复用 | `syscall/io_mpx/` | epoll, poll, select |
| 信号 | `syscall/signal.rs` | 信号发送与处理 |
| 时间 | `syscall/time.rs` | 时钟相关 syscall |
| 资源 | `syscall/resources.rs` | rlimit 等资源限制 |

分发器 `syscall/mod.rs` (640行) 将 syscall 编号路由到对应处理函数。

### 2. 文件描述符框架 (`kernel/src/file/`)

提供统一的文件描述符抽象层，支持：
- 通用文件操作 (`mod.rs`)
- 管道 (`pipe.rs`)
- Eventfd (`event.rs`)
- Signalfd (`signalfd.rs`)
- Pidfd (`pidfd.rs`)
- Epoll (`epoll.rs`)
- 网络 socket (`net.rs`)
- 文件系统 (`fs.rs`)

### 3. 内存管理 (`kernel/src/mm/`)

- **地址空间** (`aspace/`): 管理用户地址空间，支持多种后端：
  - `cow.rs` — 写时复制
  - `file.rs` — 文件映射
  - `linear.rs` — 线性映射
  - `shared.rs` — 共享内存
- **加载器** (`loader.rs`): ELF 程序加载
- **内存访问** (`access.rs`): 用户/内核内存拷贝
- **I/O** (`io.rs`): 内存映射 I/O

### 4. 任务管理 (`kernel/src/task/`)

- 任务操作 (`ops.rs`)
- 信号处理 (`signal.rs`)
- 定时器 (`timer.rs`)
- Futex (`futex.rs`)
- 资源管理 (`resources.rs`)
- 统计信息 (`stat.rs`)
- 用户态接口 (`user.rs`)

### 5. 伪文件系统 (`kernel/src/pseudofs/`)

实现 Linux 风格的伪文件系统：

| 子模块 | 目录 | 功能 |
|--------|------|------|
| devfs | `dev/` | 设备节点：tty, rtc, event, fb, log, loop, memtrack |
| procfs | `proc.rs` | /proc 文件系统 |
| tmpfs | `tmp.rs` | 临时文件系统 |
| 核心框架 | `device.rs`, `dir.rs`, `file.rs`, `fs.rs` | 伪文件系统基础设施 |

TTY 子系统 (`dev/tty/`) 尤其复杂，包含 PTY master/slave、终端 line discipline、作业控制和 termios。

### 6. 架构配置 (`kernel/src/config/`)

为 4 种架构提供编译期配置：
- RISC-V 64 (`riscv64.rs`)
- LoongArch64 (`loongarch64.rs`)
- x86_64 (`x86_64.rs`)
- AArch64 (`aarch64.rs`)

### 7. 本地修补的子系统 Crate

| Crate | 路径 | 修补目的 |
|-------|------|----------|
| axfs-ng | `axfs-ng-patched/` | ext4/fat 文件系统支持 |
| axio | `axio-patched/` | I/O 抽象层 (buffered I/O等) |
| axnet-ng | `axnet-ng-patched/` | 网络栈 (TCP/UDP/Unix socket/VSOCK) |
| starry-vm | `starry-vm-patched/` | 虚拟内存管理 |

### 8. ArceOS 基础组件 (via vendor + 依赖)

基于 ArceOS 组件化框架，内核复用了以下上游组件：
- **axhal** — 硬件抽象层
- **axmm** — 物理内存管理
- **axalloc** — 分配器（slab）
- **axtask** — 任务调度（含 SA_RESTART 中断支持修补）
- **axsync** — 同步原语
- **axdriver** — 设备驱动（virtio、PCI 等）
- **axnet** — 网络设备抽象
- **axdisplay** — 显示设备
- **axlog** — 日志系统
- **axfeat** — 编译期 feature 管理
- **axruntime** — 运行时初始化

## 四、构建工具需求

基于对 Makefile 和项目配置的分析，构建该项目需要：

| 工具 | 用途 | 必需性 |
|------|------|--------|
| **Rust nightly-2025-05-20** | 内核编译（含 rust-src, llvm-tools, clippy, rustfmt） | 必需 |
| **RISC-V 目标**: `riscv64gc-unknown-none-elf` | RISC-V 交叉编译 | 必需 |
| **LoongArch64 目标**: `loongarch64-unknown-none-softfloat` | LoongArch64 交叉编译 | 必需 |
| **GNU Make** | 构建编排 | 必需 |
| **rust-lld** (via llvm-tools) | 内核链接 | 必需 |
| **rust-objcopy** (via llvm-tools) | 内核镜像生成 | 必需 |
| **QEMU** (riscv64/loongarch64) | 模拟运行 | 运行时必需 |
| **xz** | 解压根文件系统镜像 | 构建时必需 |
| **RISC-V musl 交叉工具链** | C 程序交叉编译（可选） | 非必需 |
| **LoongArch64 musl 交叉工具链** | C 程序交叉编译（可选） | 非必需 |
| **axconfig-gen** (预编译于 `tools/bin/`) | 平台配置生成 | 必需 |
| **cargo-axplat** (预编译于 `tools/bin/`) | 平台信息解析 | 必需 |

构建流程由两层 Makefile 控制：
- 顶层 `Makefile` 提供用户友好的构建目标 (`make build`, `make run`, `make ARCH=riscv64 run` 等)
- `make/Makefile` 包含实际构建逻辑（平台解析 -> 配置生成 -> feature 解析 -> cargo build -> objcopy）

支持的构建目标架构：RISC-V 64 (默认)、LoongArch64、x86_64、AArch64。当前 RISC-V 64 和 LoongArch64 为完整支持架构。

## 五、代码规模概览

| 范围 | 文件数 (.rs) | 代码行数 |
|------|-------------|----------|
| kernel/src (内核核心) | 104 | ~17,745 |
| 非 vendor 的 .rs 文件总计 | 182 | — |
| vendor/ 目录 crate | 343 | — |
| syscall/mod.rs (分发器) | 1 | 640 |
| kernel/src/syscall/ 总计 | ~35 | — |