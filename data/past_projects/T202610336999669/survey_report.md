## StellarOS 项目初步调查分析

---

### 一、项目概述

StellarOS 是一个用 Rust 从零编写的多架构操作系统内核，同时支持 **RISC-V 64 (rv64gc)** 与 **LoongArch 64 (la64)** 两条指令集。项目目标是对齐 Linux ABI，探索面向具身智能（Embodied Intelligence OS）的系统能力。内核共约 **248 个 Rust 源文件 + 12 个汇编文件**，总计约 **80,781 行代码**（不含 vendor 依赖和用户程序）。

---

### 二、仓库文件组织结构

```
StellarOS/
├── bootloader/              # RustSBI QEMU 固件（RISC-V），含 rustsbi-qemu.bin
├── os/                      # 内核主体工程
│   ├── Cargo.toml           # 内核依赖配置
│   ├── Makefile             # 内核级构建规则
│   ├── build.rs             # 构建脚本：incbin 收集 user/ 用户程序
│   ├── smoltcp-local/       # 本地维护的 smoltcp 副本（网络协议栈）
│   ├── vendor/              # vendored 依赖（~70+ crate），支持离线可复现构建
│   ├── cargo-config/        # Cargo 离线配置模板（config.toml）
│   └── src/                 # 内核源码
├── user/                    # 用户程序工程
│   ├── Cargo.toml           # 用户库配置
│   ├── cargo-config/        # 用户侧 Cargo 离线配置
│   └── src/bin/             # ~50 个用户态测试/验证程序
├── doc/                     # 大赛设计文档（初赛PPT、设计文档PDF）
├── scripts/                 # CI/测试辅助脚本（LTP 基线、QEMU gate 等）
├── .github/workflows/       # CI（sync-to-gitlab.yml）
├── Makefile                 # 顶层构建入口（双架构 all/kernel-rv/kernel-la）
└── rust-toolchain.toml      # 工具链版本锁定
```

---

### 三、子系统划分

内核源码（`os/src/`）按功能模块划分，如下表所示：

| 目录 | 代码规模 | 子系统 | 说明 |
|------|---------|--------|------|
| `syscall/` | 984K | 系统调用分发 | 近 300 个 Linux 兼容系统调用，按 `fs/`、`net/`、`process/` 子目录分组 |
| `fs/` | 780K | 文件系统 | VFS 抽象 + FAT32/EXT2/EXT4/EXT4 磁盘文件系统 + tmpfs/devfs/procfs 伪文件系统 + 管道 + anonfd + loop/inotify/mount API |
| `net/` | 440K | 网络栈 | TCP/UDP/Raw/Unix 套接字 + poll + socket filter（基于本地 smoltcp 副本），含 core/inet/filter 子模块 |
| `arch/` | 230K | 架构抽象层 | riscv64 与 loongarch64 两个子目录，封装 trap 上下文、页表、FPU、SMP/IPI、定时器、VirtIO 探测等差异 |
| `task/` | 192K | 任务管理 | Task 结构体、`__switch` 寄存器切换、调度器入口 |
| `mm/` | 184K | 内存管理 | SV39/LoongArch 页表抽象、按需分页、COW fork、匿名与文件 mmap、TLB 失效管理 |
| `drivers/` | 133K | 设备驱动 | VirtIO-Blk/Net、PLIC、PCI、串口、RTC、RNG、TTY，按 block/irq/net/rng/rtc/serial/tty/virtio 分组 |
| `ipc/` | 104K | 进程间通信 | System V IPC（消息队列、信号量、共享内存）+ POSIX 消息队列 |
| `signal/` | 64K | 信号处理 | POSIX 信号发送/递送 + sigreturn |
| `futex/` | 52K | Futex | Linux futex 系统调用实现 |
| `sched/` | 44K | 调度器 | EEVDF 公平调度 + SCHED_OTHER/FIFO/RR 多策略 + per-CPU 运行队列 + work-stealing |
| `bpf/` | 36K | eBPF | eBPF 虚拟机桩（seccomp filter 等） |
| `sync/` | 33K | 同步原语 | WaitQueue + 自旋锁 + 原子 wake_gen 消除 SMP 丢唤醒 |
| `time/` | 28K | 时钟与定时器 | 时钟管理、定时器、timerfd |
| `ns/` | 28K | 命名空间 | Linux 命名空间支持 |
| `runtime/` | 17K | 运行时支撑 | perf 事件等 |
| `crypto/` | 16K | 加密子系统 | AF_ALG / crypto 接口 |
| `cpu/` | 16K | CPU 管理 | Per-CPU 数据管理 + Hart 启动 |
| `boards/` | 13K | 板级配置 | QEMU virt 平台的内存布局、设备物理地址、时钟频率常量（riscv64/loongarch64） |

---

### 四、子系统归属判断依据

1. **架构抽象层** (`arch/`)：通过 `arch/mod.rs` 的显式 `pub use` 固化 HAL 接口契约（控制台、定时器、关机、SMP/IPI、FPU、中断、地址空间、ASID、syscall ABI、VirtIO 探测等 15 组符号），两个架构子模块必须实现相同接口，高层代码零 `#[cfg(target_arch)]` 耦合。

2. **文件系统** (`fs/`)：按层次分为 `vfs/`（虚拟文件系统抽象）、`disk/`（FAT32/EXT2/EXT4 具体实现）、`pseudo/`（procfs/devfs 等伪文件系统）、`mem/`（tmpfs/ramfs）、`anonfd/`（匿名 fd）。

3. **网络栈** (`net/`)：分为 `core/`（核心 socket 抽象）、`inet/`（协议栈集成）、`filter/`（socket filter），底层使用本地维护的 `smoltcp-local`（在 UDP 入站分发上做了 best-match 改造）。

4. **驱动层** (`drivers/`)：按设备类型细分，VirtIO 驱动统一在 `virtio/` 子目录，块设备驱动在 `block/`，中断控制器（PLIC）在 `irq/`。

5. **系统调用** (`syscall/`)：`mod.rs` 为主分发入口（890 行），按功能域进一步分子目录 `fs/`、`net/`、`process/`。

---

### 五、构建工具需求

根据 `Makefile`、`rust-toolchain.toml`、`Cargo.toml` 及 `build.rs` 的分析，构建该项目需要以下工具：

| 类别 | 工具 | 用途 |
|------|------|------|
| Rust 工具链 | `cargo` (nightly-2024-02-03) | 内核与用户程序编译 |
| Rust 组件 | `llvm-tools-preview` | 提供 `rust-objcopy` 用于剥离/转换内核二进制 |
| Rust 组件 | `rust-src`（仅 LoongArch 构建） | `-Z build-std` 从源码重建 core/alloc/compiler_builtins |
| RISC-V 交叉编译 | `riscv64gc-unknown-none-elf` target | RISC-V 64 裸机目标 |
| LoongArch 交叉编译 | `loongarch64-unknown-none-softfloat` target | LoongArch 64 裸机目标 |
| QEMU | `qemu-system-riscv64`（当前默认） | RISC-V virt 平台模拟 |
| 二进制工具 | `rust-objcopy` | 内核 ELF → 二进制转换 |
| Make | GNU Make | 顶层构建编排 |
| SBI 固件 | `rustsbi-qemu.bin`（已内置于 bootloader/） | RISC-V SBI 运行时 |

关键构建特征：
- **离线可复现**：所有 crate 依赖已 vendored 到 `os/vendor/`，使用 `--offline --locked` 标志，不依赖网络。
- **双架构产物**：`make all` 同时构建 RISC-V 和 LoongArch 两个内核 ELF。
- **用户程序嵌入**：`build.rs` 将用户程序二进制通过 `.incbin` 汇编指令嵌入内核镜像。
- **LoongArch 特殊处理**：需 `-Z build-std=core,alloc,compiler_builtins` 从源码重编 compiler_builtins（工具链预编译 rlib 的 psABI e_flags 与当前 LLVM 不兼容）。