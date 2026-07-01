# ZeroOS 内核项目初步调查报告

## 项目概述

ZeroOS 是一个基于 Rust 语言编写的宏内核（Monolithic Kernel）操作系统项目，参加 OSKernel2024 比赛。项目基于 rCore 社区的 Starry 宏内核版 ArceOS 进行开发，目标架构为 RISC-V 64 位，支持 QEMU 虚拟平台和星光2 VisionFive2 实体开发板。

## 仓库文件组织结构

```
/ (项目根目录)
├── Cargo.toml          # Rust workspace 根配置，定义所有成员 crate
├── Cargo.lock          # 依赖锁定文件
├── Makefile            # 顶层构建入口
├── build_img.sh        # 镜像构建脚本
├── README.md           # 项目说明文档
│
├── api/                # 系统调用接口层
│   ├── axfeat/         #   条件编译与特性切换（文件系统、平台等）
│   └── linux_syscall_api/  #   Linux 兼容系统调用入口与实现
│
├── app/                # 用户程序入口，负责加载测试用例
│
├── crates/             # 第三方库与通用组件（约 37 个 crate）
│   ├── allocator/      #   通用分配器
│   ├── another_ext4/   #   ext4 文件系统实现
│   ├── bitmap-allocator/ # 位图分配器
│   ├── slab_allocator/ #   Slab 分配器
│   ├── driver_*/       #   驱动抽象层（block/common/display/net/pci/virtio）
│   ├── page_table*/    #   页表相关组件
│   ├── scheduler/      #   调度算法
│   ├── spinlock/       #   自旋锁
│   ├── elf_parser/     #   ELF 解析器
│   ├── visionfive2-sd/ #   VisionFive2 SD 卡驱动
│   ├── bcm2835-sdhci/  #   BCM2835 SDHCI 驱动
│   ├── ixgbe-driver/   #   Intel 10GbE 网卡驱动
│   └── ...             #   其他工具库
│
├── modules/            # 内核核心模块（12 个模块）
│   ├── axalloc/        #   物理页分配器
│   ├── axconfig/       #   平台相关常数配置
│   ├── axdriver/       #   设备驱动实现
│   ├── axfs/           #   文件系统
│   ├── axhal/          #   硬件抽象层（CPU/寄存器/SBI/中断）
│   ├── axlog/          #   日志输出
│   ├── axmem/          #   内存管理
│   ├── axnet/          #   网络模块
│   ├── axruntime/      #   运行时库与初始化
│   ├── axsignal/       #   信号机制
│   ├── axtask/         #   进程/任务管理
│   └── axtrap/         #   中断与异常转发
│
├── platforms/          # 平台配置文件（TOML 格式）
│   ├── riscv64-qemu-virt.toml
│   └── VisionFive2.toml
│
├── scripts/            # 构建脚本
│   ├── build.mk        #   编译构建规则
│   ├── cargo.mk        #   Cargo 构建封装
│   ├── features.mk     #   特性解析
│   ├── qemu.mk         #   QEMU 运行配置
│   ├── VisionFive2.mk  #   VisionFive2 构建规则
│   └── utils.mk        #   工具函数
│
├── tools/              # 构建辅助工具
│   ├── VisionFive2.its #   FIT 镜像描述文件
│   └── jh7110-*.dtb   #   VisionFive2 设备树二进制
│
├── ulib/               # 用户态依赖库，为 app 服务
│
└── doc/                # 项目文档（约 20 篇）
```

## 子系统分析

根据代码目录结构和 README 描述，该项目实现了以下子系统：

| 子系统 | 对应目录 | 说明 |
|--------|----------|------|
| **系统调用接口** | `api/linux_syscall_api/` | Linux 兼容系统调用，按功能分组（fs/mem/net/task） |
| **进程/任务管理** | `modules/axtask/` | 包含任务调度、执行器、Future、futex、运行队列、信号等 |
| **内存管理** | `modules/axmem/` + `modules/axalloc/` | 虚拟内存管理（area/backend/shared）+ 物理页分配 |
| **文件系统** | `modules/axfs/` + `crates/another_ext4/` + `crates/axfs_vfs/` 等 | VFS 层 + ext4/FAT/ramfs/devfs 多文件系统支持 |
| **网络** | `modules/axnet/` | 基于 smoltcp 的网络协议栈实现 |
| **设备驱动** | `modules/axdriver/` + `crates/driver_*/` | VirtIO、PCI、SD 卡（VisionFive2）、Intel 10GbE 等 |
| **硬件抽象层** | `modules/axhal/` | CPU 操作、中断处理、页表、TLS、时间、平台适配 |
| **信号机制** | `modules/axsignal/` + `api/linux_syscall_api/` 中的 signal 相关代码 | POSIX 信号支持 |
| **中断/异常处理** | `modules/axtrap/` | 中断和异常的捕获与转发 |
| **运行时与初始化** | `modules/axruntime/` | 内核启动初始化、多核支持 |
| **日志** | `modules/axlog/` | 内核日志输出 |

## 构建工具需求

| 工具 | 用途 | 状态 |
|------|------|------|
| **Rust 工具链** (rustc, cargo) | 主要编译工具，项目为纯 Rust workspace | 可用 |
| **rust-lld** | 链接器（`LD := rust-lld -flavor gnu`） | 随 Rust 工具链提供 |
| **rust-objcopy** | ELF 转二进制（`OBJCOPY`） | 随 Rust 工具链提供 |
| **RISC-V 交叉编译工具链** | Makefile 中引用 `riscv64-linux-musl-gcc`（`CROSS_COMPILE`），但实际构建以 Rust 为主 | 可用（GNU 版本） |
| **dtc** | 设备树编译（tools 目录已有预编译 dtb） | 可用 |
| **mkimage** (U-Boot) | 生成 FIT 镜像（`.itb` 文件） | 可用 |
| **QEMU (riscv64)** | 模拟运行 | 可用 |
| **GDB (multiarch)** | 调试 | 可用 |
| **Make** | 构建入口 | 可用 |

构建目标架构为 `riscv64gc-unknown-none-elf`（裸机 RISC-V 64 位），编译模式默认为 release。Makefile 中 `CROSS_COMPILE` 指向 `riscv64-linux-musl-`，但环境中仅有 `riscv64-linux-gnu-` 工具链；由于项目主体为 Rust 编译，C 交叉编译器仅在少量场景（如内联汇编或 C 胶水代码）可能被调用，需进一步确认是否影响构建。

## 初步观察

1. **项目规模**：workspace 包含约 50 个 crate（12 个内核模块 + 37 个组件库 + app/ulib/api），属于中等规模的 Rust 内核项目。
2. **架构定位**：面向 RISC-V 64 位，同时支持 QEMU 虚拟平台和 VisionFive2 实体板，默认配置为 VisionFive2。
3. **设计模式**：采用模块化设计，内核功能拆分为独立 crate，通过 `crate_interface` 和条件编译（`axfeat`）实现灵活组合，具有 ArceOS/Starry 项目的典型特征。
4. **兼容性目标**：系统调用层以 Linux 兼容为目标，按 fs/mem/net/task 分组实现，支持 LTP 等标准测试套件。
5. **文档较完善**：`doc/` 目录下有约 20 篇设计文档，涵盖总体架构、各子系统设计和平台适配等内容。