# TxKernel 项目初步调查报告

## 1. 项目概述

TxKernel 是一个基于 Rust 语言开发的操作系统内核项目，主要面向 **RISC-V 64** 和 **LoongArch 64** 两种架构，运行于 QEMU virt 虚拟平台。项目采用 Rust 2021 edition，使用 nightly-2025-05-20 工具链，以 Cargo workspace 方式组织，总代码量约 **29.5 万行 Rust 代码**（分布于 677 个 .rs 源文件中）。

## 2. 仓库顶层结构

```
.
├── boards/                  # 板级支持包（BSP）—— 架构/平台特定实现
├── crates/                  # 核心 crate —— 内核各子系统
├── external/                # 外部依赖（git submodules）
├── xtask/                   # 构建编排工具（cargo xtask）
├── tools/                   # 辅助脚本与工具（测试、评测、镜像制作等）
├── docs/                    # 文档（开发指南、设计文档、进度记录等）
├── cargo/                   # Cargo 配置
├── Cargo.toml               # workspace 清单
├── Makefile                  # 构建便利层（封装 docker + cargo xtask）
├── rust-toolchain.toml      # Rust 工具链声明
├── Dockerfile / docker-compose.yml  # 容器化构建环境
└── .gitmodules              # 外部子模块声明
```

## 3. 子系统划分

### 3.1 硬件抽象层 (HAL)

| Crate / Board | 代码量 | 说明 |
|---|---|---|
| `crates/tx-hal` | ~2,451 行 | 架构无关的 HAL trait 定义：PlatformConfig、BootInfo、PmapIf、IrqIf、TimeIf、ConsoleIf、SmpIf 等 |
| `boards/tx-hal-riscv64-qemu-virt` | ~9,838 行 | RISC-V 64 QEMU virt 平台实现：页表、trap 帧、SBI 调用、DTB 解析、启动、信号帧、用户态访问 |
| `boards/tx-hal-loongarch64-qemu-virt` | ~8,017 行 | LoongArch 64 QEMU virt 平台实现 |
| `boards/tx-hal-riscv64-m1dock-mock` | ~2,272 行 | RISC-V 64 M1 Dock mock 平台 |

**职责**：CPU 特权级切换、页表操作、中断/异常处理、定时器、SMP、DMA、控制台 I/O、启动协议适配。

### 3.2 内核核心 (Kernel Core)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-kernel` | ~16,729 行 | 内核主逻辑：启动初始化、trap 分发、IRQ 处理、线程 Future（异步任务包装）、vDSO、zone 管理、同步原语、设备注册 |

### 3.3 基础运行时 (Substrate)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-substrate` | ~27,595 行 | 内核基础设施：epoch 内存回收、页帧分配器、zone 分配器、总线/端口系统、step 引擎、wake/mailbox、slab 分配器、slot 管理 |

### 3.4 异步运行时 (Reactor)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-reactor` | ~14,176 行 | 异步任务运行时：调度器、任务管理、中断处理、等待源、定时器、自旋锁、抢占、hart 循环、completion 机制 |

### 3.5 子系统集合 (Subsystems) —— 最大模块

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-subsystems` | ~131,924 行 | 内核主要功能子系统：进程管理、虚拟内存(VM)、VFS、信号处理、网络协议栈(TCP/UDP/ICMP/ARP)、IPC (SysV msg/sem/shm + POSIX mq)、epoll、eventfd、futex、io_uring、AIO、timerfd、signalfd、pipe、tty、mount、credential、userfaultfd、vDSO、wall clock、reactor affinity 等 |

### 3.6 Linux 系统调用兼容层 (Shims)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-shims` | ~66,679 行 | Linux syscall 转译层：将 Linux 系统调用翻译为内部子系统调用。覆盖文件操作、进程管理、信号、网络、IPC、io_uring、epoll、futex 等几乎所有主要 syscall 类别 |

### 3.7 文件系统 (Filesystem)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-fs` | ~11,098 行 | VFS 集成层：tmpfs、procfs、sysfs、devfs、bdevfs、devpts、initramfs 内存文件系统，以及 ext4/FAT 桥接 |
| `crates/tx-ext4` | ~2,738 行 | ext4 文件系统内核端实现 |
| `crates/tx-ext4-format` | ~3,357 行 | ext4 磁盘格式定义和解析 |
| `crates/tx-fat` | ~1,658 行 | FAT 文件系统内核端实现 |
| `crates/tx-fat-format` | ~2,198 行 | FAT 磁盘格式定义和解析 |

### 3.8 设备驱动 (Drivers)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-drivers` | ~1,747 行 | virtio 驱动：virtio-blk（块设备）、virtio-net（网络）、virtio-mmio 和 virtio-pci 传输层、DMA 抽象 |

### 3.9 ELF 加载与进程创建 (Scripts)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-scripts` | ~7,137 行 | ELF 文件加载器、exec 协议脚本（进程创建的八阶段协议）、用户栈初始化 |

### 3.10 观测/追踪框架 (Observation)

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-observe` | ~2,922 行 | 内核事件追踪记录与导出 |
| `crates/tx-observe-types` | ~1,146 行 | 追踪事件类型定义（支持 serde 的 host 端） |

### 3.11 其他小型模块

| Crate | 代码量 | 说明 |
|---|---|---|
| `crates/tx-platform-adapter` | ~614 行 | proc-macro，编译时代码生成的平台适配 |
| `crates/tx-services` | ~212 行 | 内核服务：随机数生成 |
| `crates/tx-policy` | ~9 行 | 调度策略/cgroup 策略占位 |
| `crates/tx-vdso` | ~361 行 | vDSO .so 构建产物嵌入（include_bytes!） |
| `crates/tx-test-support` | ~52 行 | 跨 crate 测试支持 |

### 3.12 板级内核入口 (Boards - Kernel)

| Board | 代码量 | 说明 |
|---|---|---|
| `boards/tx-kernel-riscv64-qemu-virt` | ~75 行 | RISC-V 64 QEMU 内核入口（main.rs + build.rs） |
| `boards/tx-kernel-loongarch64-qemu-virt` | ~76 行 | LoongArch 64 QEMU 内核入口 |
| `boards/tx-kernel-riscv64-m1dock-mock` | ~41 行 | RISC-V M1 Dock mock 内核入口 |

### 3.13 构建工具 (xtask)

| 路径 | 代码量 | 说明 |
|---|---|---|
| `xtask/` | ~20,157 行 | cargo xtask 工具：QEMU 启动、镜像构建(cpio/ext4)、OSComp 竞赛评测集成、CI 检查、lint 不变量检查、syscall 状态追踪、observe 数据分析、trap trace 解析、边界报告等 |

### 3.14 外部依赖

| 子模块 | 说明 |
|---|---|
| `external/smoltcp-asterinas` | 定制版 smoltcp 网络协议栈（用于内核态 TCP/UDP/IP） |
| `external/musl` | musl libc（用于构建用户态测试程序） |
| `external/linux-rv-6.17` | Linux 内核源码（参考/对照） |
| `external/rsext4` | Rust ext4 实现参考 |
| `external/oscomp-autotest` | OS 竞赛自动评测框架 |
| `external/lmbench` / `external/libc-bench` | 性能基准测试套件 |
| `external/humanlayer-reference` | HumanLayer 参考实现 |

## 4. 构建工具需求

根据 Makefile、rust-toolchain.toml 和 Cargo.toml 分析，构建该项目需要：

| 工具 | 用途 |
|---|---|
| **Rust nightly-2025-05-20** | 编译器 + cargo |
| **rust-src** | 编译 core/alloc（no_std 内核） |
| **llvm-tools-preview** | LLVM 工具链（rust-lld 链接器） |
| **riscv64gc-unknown-none-elf target** | RISC-V 64 裸机交叉编译目标 |
| **loongarch64-unknown-none-softfloat target** | LoongArch 64 裸机交叉编译目标 |
| **rust-lld** | 内核 ELF 链接 |
| **QEMU** (riscv64 / loongarch64) | 模拟运行 |
| **Docker** | 容器化构建环境（可选，通过 Makefile） |
| **OpenSBI** (external/opensbi-silent) | RISC-V SBI 固件 |
| **mkfs.ext4 / mkfs.vfat / mcopy / dd** | 文件系统镜像制作 |
| **dtc** | Device Tree 编译 |
| **Python 3** | 辅助脚本（评测、镜像制作、LTP 测试编排等） |

核心构建命令：`cargo xtask build --target rv64-qemu` 或 `cargo xtask build --target la64-qemu`，由 xtask 工具统一编排内核编译、镜像打包和 QEMU 启动流程。