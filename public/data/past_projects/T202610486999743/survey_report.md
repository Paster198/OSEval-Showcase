## Eureka OS 项目结构与初步调查

---

### 一、项目概述

Eureka OS 是由武汉大学 Eureka 团队开发的基于 Rust 语言的宏内核操作系统，支持 **RISC-V 64** 和 **LoongArch 64** 双架构。这是一个面向全国大学生 OS 内核比赛的参赛项目。

---

### 二、顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `os/` | 内核主体 crate，包含所有内核子系统 |
| `hal/` | 硬件抽象层 crate，封装 RISC-V / LoongArch 架构差异 |
| `bootloader/` | 引导固件（`rustsbi-qemu.bin`） |
| `third_party/` | 第三方依赖：`ext4fs`（EXT4 实现）、`loongarch64-glibc`（LoongArch glibc 运行库） |
| `vendor/` | 本地 fork 的 Rust crate：`riscv`（RISC-V 寄存器级访问） |
| `etc/` | 用户态覆盖文件（`passwd`, `group`），制作镜像时拷贝 |
| `judge/` | 评测相关脚本与配置（本地评测工具链） |
| `docs/` | 项目文档（设计文档、测例通过记录、调试笔记等） |
| `Makefile` | 顶层构建入口：`make all/build/run` |
| `rust-toolchain.toml` | Rust 工具链版本锁定：`nightly-2025-02-01` |
| `Dockerfile` | 容器化构建环境 |
| `.gitlab-ci.yml` | CI 流水线配置 |

---

### 三、内核子系统划分

内核主体位于 `os/src/` 下，62 个 Rust 源文件按功能模块组织：

| 子系统 | 目录/文件 | 行数（约） | 功能描述 |
|---|---|---|---|
| **入口与初始化** | `main.rs` | ~80 | 内核入口 `rust_main`，依次初始化各子系统后进入调度 |
| **配置常量** | `config.rs` | ~20 | 页大小、栈大小、堆大小、时钟频率等 |
| **架构抽象层 (HAL)** | `hal/` | ~48 文件 | 统一 trait 封装：CPU、IRQ、页表、上下文切换、Trap、定时器、VirtIO、信号、固件接口等 |
| **内存管理 (MM)** | `mm/` | ~8,700 | 页帧分配器 (`frame_allocator.rs`)、页表 (`page_table.rs`)、内核空间映射 (`kernel_space.rs`)、地址空间 (`memory_set.rs`, 226K)、堆分配器 (`heap_allocator.rs`)、mmap 区域 (`map_area.rs`) |
| **进程与调度 (Task/Processor)** | `task/` + `processor/` + `mission/` | ~8,500 | 进程控制块 `TaskControlBlock`、调度器 (`schedule.rs`)、协程 (`coroutine.rs`)、PID 分配 (`id.rs`)、等待队列 (`wait_queue.rs`)、任务管理器 (`manager.rs`)、评测任务编排 (`mission/`) |
| **系统调用 (Syscall)** | `syscall/` | ~20,700 | 系统调用分发与实现：文件系统 (`fs.rs`, 402K)、进程 (`process.rs`, 152K)、网络 (`net.rs`)、IPC (`ipc.rs`)、信号 (`signal.rs`)、时间 (`time.rs`)、内存 (`mm.rs`)、eBPF (`bpf.rs`)、keyctl (`key.rs`)、userdb (`userdb.rs`) |
| **文件系统 (FS)** | `fs/` | ~4,400 | VFS 抽象（`File` trait）、EXT4 实现 (`ext4.rs`)、inode 管理 (`inode.rs`)、管道 (`pipe.rs`)、stdio (`stdio.rs`, 88K)、epoll (`epoll.rs`)、eventfd (`eventfd.rs`) |
| **网络 (Net)** | `net/` | ~1,980 | Socket 实现：UNIX domain、IPv4、Netlink 等（全在 `mod.rs` 中） |
| **IPC** | `ipc/` | ~1,300 | System V IPC 机制 (`sysv.rs`)：信号量、共享内存、消息队列 |
| **信号 (Signal)** | `signal/` | ~560 | POSIX 信号：信号动作 (`action.rs`)、信号处理 (`handler.rs`)、信号管理器 (`manager.rs`)、信号消息队列 (`msg_queue.rs`) |
| **Trap 处理** | `trap/` | ~330 | 异常与中断处理入口 (`mod.rs`)、Trap 上下文 (`context.rs`) |
| **驱动 (Drivers)** | `drivers/` | ~200 | VirtIO 块设备驱动 (`block/virtio_blk.rs`)、块设备抽象 trait |
| **同步原语 (Sync)** | `sync/` | ~70 | 自旋锁 (`spin.rs`)、UP 单元 (`up.rs`) |
| **定时器** | `timer.rs` | ~30 | 时钟中断计时 |
| **控制台** | `console.rs` | ~30 | `print!`/`println!` 宏实现 |
| **日志** | `logging.rs` | ~70 | 日志系统初始化 |
| **兼容层** | `compat.rs` | ~20 | Linux ABI 兼容辅助 |
| **语言项** | `lang_items.rs` | ~15 | Rust 语言项实现（panic 处理等） |

---

### 四、HAL 硬件抽象层结构

HAL 位于 `hal/src/component/`，每个组件定义统一的 trait，然后按 `riscv64` / `loongarch64` 分别实现：

| HAL 组件 | Trait / 接口 | 功能 |
|---|---|---|
| `abi` | `AbiHal` | 体系结构 ABI 信息（机器名、loader 路径等） |
| `constant` | `ConstantHal` | 架构常量（时钟频率、内存边界、MMIO 区域） |
| `context` | `TaskContextLayout` | 任务上下文布局（寄存器保存） |
| `cpu` | `CpuHal` | CPU ID 获取 |
| `entry` | 汇编入口 + 链接脚本 | 内核启动入口（`loongarch64.S` / `riscv64.S`）及链接脚本 |
| `firmware` | Firmware 接口 | SBI / UEFI 等固件调用 |
| `instruction` | `Instruction` | 特权指令抽象（如 `sfence.vma`、浮点使能等） |
| `irq` | IRQ 控制 | 中断使能/禁用/保存恢复 |
| `pagetable` | 页表操作 | 页表项操作（创建、映射、查询） |
| `signal` | 信号 trampoline | 信号返回 trampoline 地址 |
| `switch` | 上下文切换汇编 | `__switch` 汇编实现 |
| `timer` | 定时器 | 设置下次时钟中断 |
| `trap` | Trap 处理 | Trap 入口汇编、trap 返回 |
| `virtio` | VirtIO 传输 | VirtIO MMIO/PCI 传输抽象 |

---

### 五、构建系统与依赖

**构建工具**：
- **Rust 工具链**：`nightly-2025-02-01`（由 `rust-toolchain.toml` 管理），需 `rust-src`、`llvm-tools-preview`、`rustfmt`、`clippy`
- **Make**：顶层和 `os/` 下各有一个 Makefile
- **QEMU**：`qemu-system-riscv64`（RISC-V）和 `qemu-system-loongarch64`（LoongArch）
- **e2fsprogs**：`mkfs.ext4`、`debugfs`、`e2fsck` 用于磁盘镜像制作
- **交叉编译工具链**：LoongArch 需 `loongarch64-linux-gnu-gcc` / `ar` 编译入口汇编
- **基础工具**：`dd`、`mount`、`umount`

**关键依赖 crate**：

| Crate | 用途 |
|---|---|
| `hal`（本地） | 硬件抽象层 |
| `lwext4_rust`（本地 `third_party/ext4fs`） | EXT4 文件系统实现（Rust 封装 C 的 lwext4） |
| `riscv`（本地 `vendor/riscv`） | RISC-V CSR 寄存器访问 |
| `virtio-drivers` v0.8.0 | VirtIO 设备驱动框架 |
| `buddy_system_allocator` v0.6 | 伙伴系统物理页帧分配器 |
| `xmas-elf` v0.7.0 | ELF 文件解析 |
| `bitflags` v1.2.1 | 位标志宏 |
| `lazy_static` v1.4.0 | 延迟初始化静态变量 |
| `log` v0.4 | 日志抽象 |

**构建流程**（`make build`）：
1. 调用 `make -C os kernel ARCH=riscv64` 编译 RISC-V 内核
2. 调用 `make -C os kernel ARCH=loongarch64` 编译 LoongArch 内核
3. 制作 EXT4 磁盘镜像（`disk.img`），并将 `etc/` 覆盖层拷贝进去
4. 将内核 ELF 分别复制为 `kernel-rv` / `kernel-la`

---

### 六、初步评估总结

该项目是一个工程化程度较高的 Rust 宏内核项目，具有以下特点：

1. **双架构支持**：通过统一的 HAL trait 抽象实现 RISC-V 与 LoongArch 双架构，架构相关代码隔离在 14 个组件中，每个组件约 ~100 行（汇编+配置+Rust），架构差异对内核主体透明。

2. **子系统完整度较高**：覆盖了内存管理（含按需分页、写时复制、mmap）、进程/线程管理、VFS + EXT4 文件系统、网络 Socket、System V IPC、POSIX 信号、epoll/eventfd、eBPF 等 Linux 关键子系统。

3. **Linux ABI 兼容**：实现了大量 Linux 系统调用，可运行 BusyBox、glibc 等真实用户态程序，具备 LTP 测试回归能力。

4. **构建体系清晰**：Make + Cargo 双层构建，支持独立内核编译与完整磁盘镜像制作，环境依赖明确。

5. **代码规模**：内核主体约 40,000+ 行 Rust 代码，HAL 层约 1,500 行（含汇编），整体规模中等偏大。