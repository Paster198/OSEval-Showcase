# Explosion OS 内核项目初步分析报告

## 项目概述

**项目名称**: Explosion  
**开发语言**: Rust（含少量汇编）  
**内核类型**: 宏内核（Monolithic Kernel）  
**基础项目**: rCore-Tutorial-v3  
**目标架构**: RISC-V 64位（主要）、LoongArch64（次要）  
**开发团队**: 中山大学三名本科生  
**Rust 工具链**: nightly-2025-01-18  

---

## 仓库文件组织结构

```
./
├── os/                    # 内核主体代码
├── ext4_rs/               # EXT4 文件系统实现（独立 crate）
├── fdt/                   # Flattened Device Tree 解析库（独立 crate）
├── loongArch64/           # LoongArch64 架构支持库（独立 crate）
├── lose-net-stack/        # 网络协议栈实现（独立 crate）
├── plic/                  # RISC-V PLIC 中断控制器驱动（独立 crate）
├── riscv/                 # RISC-V 底层访问库（独立 crate）
├── virtio-drivers/        # VirtIO 驱动（新版 v0.11.0，未直接使用）
├── virtio-drivers-old/    # VirtIO 驱动（旧版 v0.1.0，内核实际依赖）
├── imgs/                  # 图片资源/文档插图
├── Makefile               # 顶层 Makefile（Docker/提交用）
├── rust-toolchain.toml    # Rust 工具链配置
├── docker-compose.yaml    # Docker 构建配置
└── README.md              # 项目文档
```

---

## 内核子系统分析

内核主体位于 `os/src/` 目录，包含以下子系统模块：

| 目录/文件 | 所属子系统 | 说明 |
|-----------|-----------|------|
| `mm/` | 内存管理 | 地址空间、页帧分配器、堆分配器、页表、MemorySet |
| `task/` | 进程/线程管理 | 进程控制块、调度器、上下文切换、信号、任务ID管理 |
| `fs/` | 文件系统 | inode 缓存、管道、标准I/O |
| `syscall/` | 系统调用接口 | 文件、进程、内存、网络、信号、同步、线程、GUI、输入等 |
| `drivers/` | 设备驱动 | 块设备、总线、字符设备、GPU、输入设备、网络设备 |
| `net/` | 网络子系统 | 端口表、Socket、TCP、UDP |
| `sync/` | 同步原语 | 条件变量、互斥锁、信号量 |
| `trap/` | 陷阱/异常处理 | 中断与异常入口 |
| `hal/` | 硬件抽象层 | 板级支持、启动、指令、中断、内存、页表、定时器、陷阱 |
| `boards/` | 板级配置 | QEMU 平台参数定义 |
| `sbi.rs` | SBI 接口 | 与固件交互的 SBI 调用封装 |
| `config.rs` | 全局配置 | 内核参数常量 |
| `console.rs` | 控制台输出 | 内核打印 |
| `logging.rs` | 日志系统 | 内核日志框架 |

---

## 外部依赖 crate 归属

| crate 名称 | 目录 | 功能归属 |
|------------|------|---------|
| `ext4_rs` | `./ext4_rs/` | 文件系统子系统（EXT4） |
| `lose-net-stack` | `./lose-net-stack/` | 网络子系统（协议栈） |
| `virtio-drivers`（旧版） | `./virtio-drivers-old/` | 设备驱动子系统（VirtIO 块/网络设备） |
| `riscv` | `./riscv/` | RISC-V 架构支持（CSR 寄存器访问） |
| `loongArch64` | `./loongArch64/` | LoongArch64 架构支持 |
| `plic` | `./plic/` | 中断控制器驱动（RISC-V PLIC） |
| `fdt` | `./fdt/` | 设备树解析（硬件发现） |

---

## 构建工具需求

| 工具 | 用途 | 状态 |
|------|------|------|
| Rust nightly (nightly-2025-01-18) | 内核编译 | 可用 |
| `rust-src` | 交叉编译目标标准库源码 | 可用 |
| `llvm-tools` | rust-objdump / rust-objcopy | 可用 |
| `cargo` | Rust 包管理与构建 | 可用 |
| QEMU (riscv64) | RISC-V 模拟运行 | 可用 |
| QEMU (loongarch64) | LoongArch64 模拟运行 | 可用 |
| OpenSBI / RustSBI | RISC-V SBI 固件 | 可用 |
| Make | 构建编排 | 可用 |
| `mkfs.ext4` / `dd` | 文件系统镜像制作 | 可用 |
| RISC-V 交叉编译工具链 | 用户态程序编译（如有） | 可用 |

---

## 初步观察

1. **架构支持**: 项目以 RISC-V 64 位为主要目标架构，LoongArch64 为次要支持，通过 `hal/` 硬件抽象层实现多平台适配。

2. **功能覆盖**: 系统调用接口覆盖面较广，包括文件系统、进程管理、内存管理、网络、信号、同步、线程、GUI 和输入设备等，表明项目追求较完整的 Linux ABI 兼容性。

3. **依赖管理**: 多个外部 crate 以本地路径依赖方式集成（而非 crates.io），便于定制修改，但增加了仓库体积。

4. **SMP 支持**: QEMU 启动参数中 `-smp 2` 表明项目支持多核运行，`sync/` 模块中的同步原语也印证了这一点。

5. **网络功能**: 集成 `lose-net-stack` 网络协议栈和 VirtIO 网络设备驱动，支持 TCP/UDP 通信。

6. **文件系统**: 采用 EXT4 文件系统（通过 `ext4_rs` crate），而非 rCore-Tutorial 原生的 easy-fs。