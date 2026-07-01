## NexusOS 项目结构分析报告

### 项目概述

**NexusOS** 是一个基于 Rust 语言开发的多核、异步、框内核（Framekernel）架构的操作系统。项目版本号为 0.11.3，基于 [Asterinas](https://github.com/asterinas/asterinas) 项目进行二次开发，采用 MPL 2.0 许可证。

### 项目结构

```
NexusOS/
├── kernel/              # 内核主程序（用户态接口与核心功能）
│   ├── src/             # 内核核心源码
│   │   ├── syscall/     # 系统调用接口层
│   │   ├── thread/      # 线程与进程管理
│   │   ├── time/        # 时间管理
│   │   └── vm/          # 虚拟内存管理
│   ├── comps/           # 内核组件（大型独立模块）
│   │   ├── another_ext4/# ext4 文件系统实现
│   │   └── vfs/         # 虚拟文件系统抽象层
│   └── libs/            # 内核专用依赖库
│       ├── aster-rights/# 基于能力的权限管理
│       ├── block-dev/   # 块设备抽象
│       ├── nexus-error/ # 自定义错误处理
│       └── typeflags*/  # 类型标志工具
├── ostd/                # 操作系统标准库（底层抽象与核心服务）
│   ├── src/             # 核心源码
│   │   ├── arch/        # 体系结构相关代码
│   │   │   ├── riscv/   # RISC-V 架构实现
│   │   │   ├── loongarch/# LoongArch 架构实现
│   │   │   └── x86/     # x86-64 架构实现
│   │   ├── boot/        # 系统引导
│   │   ├── bus/         # 系统总线驱动（PCI, MMIO）
│   │   ├── cpu/         # CPU 核心功能封装
│   │   ├── drivers/     # 设备驱动（VirtIO）
│   │   ├── mm/          # 内存管理
│   │   ├── sync/        # 同步原语
│   │   ├── task/        # 任务/线程调度
│   │   ├── timer/       # 定时器管理
│   │   └── trap/        # 陷入处理
│   └── libs/            # 第三方库与辅助工具
│       ├── maitake*/    # 轻量级异步运行时
│       ├── virtio-drivers/# VirtIO 驱动
│       └── ...          # 其他工具库
├── osdk/                # OS Development Kit（构建工具）
├── test/                # 测试应用与脚本
├── tools/               # 辅助工具脚本
├── vendor/              # 离线依赖包
└── docs/                # 项目文档
```

### 子系统分析

根据代码结构，NexusOS 实现了以下主要子系统：

| 子系统 | 主要目录 | 功能描述 |
|--------|----------|----------|
| **系统调用** | `kernel/src/syscall/` | 用户态与内核态接口，包括文件系统、信号、进程等调用 |
| **进程/线程管理** | `kernel/src/thread/` | 线程创建、克隆、执行、退出、等待等生命周期管理 |
| **虚拟内存** | `kernel/src/vm/` | 内存映射、BRK、MMap、页面错误处理 |
| **时间管理** | `kernel/src/time/` | 时钟获取、纳秒睡眠等时间相关功能 |
| **文件系统** | `kernel/comps/vfs/`, `kernel/comps/another_ext4/` | VFS 抽象层与 ext4 文件系统实现 |
| **内存管理** | `ostd/src/mm/` | 物理/虚拟内存、页表、堆分配器、DMA |
| **任务调度** | `ostd/src/task/` | 任务抽象、抢占式调度、调度器 |
| **设备驱动** | `ostd/src/drivers/` | VirtIO 块设备、网络设备驱动 |
| **总线管理** | `ostd/src/bus/` | PCI 总线、MMIO 设备管理 |
| **同步机制** | `ostd/src/sync/` | Mutex、Spinlock、RCU 等同步原语 |
| **中断处理** | `ostd/src/trap/` | 中断、异常、系统调用陷入处理 |
| **体系结构** | `ostd/src/arch/` | RISC-V、LoongArch、x86_64 多架构支持 |

### 构建工具需求

根据 Makefile 和配置文件分析，构建该项目需要以下工具：

| 工具类别 | 具体工具 | 用途 |
|----------|----------|------|
| **Rust 工具链** | rustc (nightly-2025-02-01), cargo, rust-src, llvm-tools | Rust 代码编译 |
| **OSDK** | cargo-osdk | 内核构建与运行的专用工具 |
| **QEMU** | qemu-system-riscv64, qemu-system-loongarch64 | 模拟器运行 |
| **交叉编译** | RISC-V GCC, LoongArch GCC | 目标架构编译 |
| **固件** | OpenSBI/RustSBI | RISC-V SBI 固件 |
| **文件系统工具** | mkfs.ext4, dd | 镜像制作 |
| **其他** | GNU Make, Git, Python | 构建脚本与辅助 |

### 目标架构支持

项目支持三种目标架构：
- **RISC-V 64** (`riscv64gc-unknown-none-elf`) - 主要目标架构
- **LoongArch 64** (`loongarch64-unknown-none`) - 龙芯架构
- **x86-64** (`x86_64-unknown-none`) - 传统 PC 架构

默认构建目标为 RISC-V 64，通过 `ARCH` 参数可切换架构。