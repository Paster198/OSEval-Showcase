# UESTC OS Kernel 2026 — 项目初步调查报告

## 1. 项目概述

本项目为电子科技大学参加 2026 全国大学生操作系统设计赛（内核实现赛）的内核项目。内核基于 **Rust** 语言编写，采用 **Cargo workspace** 方式组织，主要支持 **RISC-V 64** 和 **LoongArch64** 两种架构，同时保留了 aarch64 和 x86_64 的部分移植代码。

项目的上游基线是 **RustOsWhu**，在此基础上进行了二次开发、移植与优化，目前正处于持续完善系统调用兼容性、内核稳定性和性能的阶段。

---

## 2. 仓库文件组织结构

```
.
├── Cargo.toml               # Workspace 根配置，定义所有成员 crate
├── Cargo.lock
├── Makefile                 # 顶层构建入口，支持 rv/la 目标
├── rust-toolchain.toml      # Rust nightly-2024-05-01 工具链声明
├── Dockerfile               # Docker 构建环境
├── README.md
├── dotcargo/config.toml     # vendored-sources 配置，指向 vendor/
│
├── arch/                    # 硬件抽象层 (HAL)
├── os/                      # 内核主 crate
├── vfs/                     # 虚拟文件系统实现
├── vfs-defs/                # VFS 接口定义
├── ext4/                    # ext4 文件系统实现
├── ext4_rs-1.3.1/           # ext4 的另一套实现 (备用)
├── ext4-fs-fuse/            # ext4 镜像制作工具 (FUSE)
├── ext4-test-fuse/          # ext4 测试镜像制作工具
├── easy-fs/                 # 简易文件系统 (遗留)
├── easy-fs-fuse/            # easy-fs 镜像制作工具 (遗留)
├── buffer/                  # 文件系统块缓存
├── device/                  # 块设备抽象定义
├── lose-net-stack/          # 网络协议栈
├── virtio-drivers/          # Virtio 设备驱动 (fork)
├── sync/                    # 内核同步原语
├── config/                  # 常量与配置
├── logger/                  # 日志系统
├── time/                    # 时间相关定义
├── system-result/           # 系统错误码定义
├── user/                    # 用户态程序与用户库
├── bootloader/              # RustSBI 固件二进制
├── testcase/                # 比赛测例 (basic/)
├── testinit/                # 测试用 init 程序
├── doc/                     # 文档与架构图
└── vendor/                  # 139 个 vendored 第三方 crate
```

---

## 3. 子系统划分

### 3.1 硬件抽象层 — `arch/`

源码位于 `arch/src/`，按架构分目录：
- **riscv64/** — 含 QEMU/K210/CV1811H 三块板卡，页表 (Sv39)、上下文切换、中断处理、SBI 调用、定时器、信号蹦床
- **loongarch64/** — 启动、控制台、上下文切换、页表、定时器、陷断处理、信号蹦床
- **x86_64/** — APIC、GDT、IDT、页表、Multiboot、UART
- **aarch64/** — GIC、PSCI、PL011、页表、定时器

公共文件：`api.rs`（`ArchInterface` trait 定义）、`pagetable.rs`、`irq.rs`、`addr.rs`、`consts.rs`、`time.rs`

### 3.2 内核核心 — `os/`

| 子模块 | 路径 | 功能 |
|--------|------|------|
| **进程管理** | `os/src/task/` | 任务控制块 (TCB)、调度器（时间片轮转）、PID/TID 管理、Futex、信号处理 (`signal.rs`, `sigaction.rs`)、任务上下文 (`context.rs`)、文件描述符表 (`fdtable.rs`)、进程信息 (`info.rs`)、进程操作 (`action.rs`) |
| **内存管理** | `os/src/mm/` | 页帧分配器（栈式）、堆分配器（伙伴系统）、页表 (`page_table.rs`)、内存集 (`memory_set.rs`)、地址空间 (`address.rs`)、共享内存 (`shm.rs`)、写时复制、懒分配 |
| **系统调用** | `os/src/syscall/` | 约 4188 行，分 `fs.rs`(文件系统)、`process.rs`(进程)、`socket.rs`(网络)、`mod.rs`(入口分发) |
| **文件系统接入** | `os/src/fs/` | epoll、eventfd、inode、pipe、signalfd、stdio、timerfd |
| **设备驱动** | `os/src/drivers/` | VirtIO 块设备 (`virtio_blk.rs`, `pci_virtio_blk.rs`)、UART (`chardevice/uart.rs`)、PLIC、网卡 (`net.rs`) |
| **同步** | `os/src/sync/` | 条件变量 `cond.rs`、UP 自旋锁 `up.rs` |
| **定时器** | `os/src/timer.rs` | 内核定时器管理 |
| **网络接入** | `os/src/socket.rs` | 网络套接字接入层 |
| **控制台** | `os/src/console.rs` | 内核控制台输出 |
| **SBI** | `os/src/sbi.rs` | RISC-V SBI 调用封装 |

### 3.3 虚拟文件系统 — `vfs-defs/` + `vfs/`

- **vfs-defs**：定义 VFS 核心接口 — `dentry`、`dentry_cache`、`file`、`inode`、`filesystemtype`、`superblock`
- **vfs**：实现具体文件系统：
  - `devfs/` — null、zero、urandom、tty、rtc、cpu_dma_latency
  - `memfs/` — 内存文件系统 (dentry/file/inode)
  - `procfs/` — meminfo、mounts、exe
  - `tmpfs/`
  - `fdtable.rs` — 文件描述符表实现

### 3.4 ext4 文件系统 — `ext4/` + `ext4_rs-1.3.1/`

- `ext4/src/`：block、dentry、file、fs、inode、superblock — 基于 VFS 接口的 ext4 实现
- `ext4_rs-1.3.1/src/`：另一套 ext4 实现（来自 `ext4_rs` crate 的上游版本）

### 3.5 文件系统块缓存 — `buffer/`

`block_cache.rs` — LRU 块缓存，支撑 ext4 等文件系统的块级读写。

### 3.6 网络协议栈 — `lose-net-stack/`

源自 `byte-os/lose-net-stack`，包含：
- 地址管理 (`addr.rs`)
- ARP 表 (`arp_table.rs`)
- TCP 连接 (`connection/tcp.rs`)
- UDP 连接 (`connection/udp.rs`)
- 数据包 (ARP/ICMP/TCP/UDP in `packets/`)
- 网络抽象 trait (`net_trait.rs`)

### 3.7 VirtIO 设备驱动 — `virtio-drivers/`

Fork 自 `rcore-os/virtio-drivers`，包含：
- 块设备 (`blk.rs`)
- 网络设备 (`net/`)
- 控制台 (`console.rs`)、GPU (`gpu.rs`)、输入 (`input.rs`)
- VirtIO Socket (`socket/vsock.rs`)
- PCI 和 MMIO 传输层

### 3.8 用户态 — `user/`

- `src/lib.rs` — 用户库，含 syscall 封装
- `src/bin/` — 约 28 个用户程序：`initproc`、`user_shell`、`usertests`、`brktest`、`forktest`、`pipetest`、`mmap`、`signal_test` 等

### 3.9 支撑库

| Crate | 功能 |
|-------|------|
| `sync/` | 基于 spin 的内核自旋锁封装 |
| `config/` | 内核常量（栈大小、堆大小、资源定义等） |
| `logger/` | 日志系统，封装 log crate |
| `time/` | 时间结构体与常量定义 |
| `system-result/` | SysResult 等系统调用结果类型 |
| `device/` | `BlockDevice` trait 定义 |

### 3.10 构建辅助

- `ext4-fs-fuse/` — FUSE 工具，将用户程序打包为 ext4 镜像
- `ext4-test-fuse/` — 同上，但将测试用例打入镜像
- `easy-fs-fuse/` — 遗留的 easy-fs 镜像工具
- `testcase/basic/` — riscv64/loongarch64 的比赛基础测例集
- `testinit/` — 测试用 init 程序（rv 和 la）
- `bootloader/rustsbi-qemu.bin` — RustSBI 固件

---

## 4. 构建系统与工具需求

### 4.1 编译器与工具链

| 工具 | 用途 |
|------|------|
| **rustc/cargo** (nightly-2024-05-01) | Rust 编译，需要 `rust-src`、`llvm-tools`、`rustfmt`、`clippy` 组件 |
| **RISC-V 目标** | `riscv64gc-unknown-none-elf` |
| **LoongArch 目标** | `loongarch64-unknown-none` |
| **cargo build-std** | `-Z build-std` 用于裸机目标的核心库构建 |
| **rust-objcopy** | 将 ELF 转换为 raw binary |
| **rust-objdump** / `loongarch64-linux-gnu-objdump` | 反汇编 |

### 4.2 构建流程

顶层 `Makefile` 提供快捷构建目标：
- `make rv` — 构建 RISC-V 内核 (`kernel-rv`)
- `make la` — 构建 LoongArch 内核 (`kernel-la`)
- `make all` — 同时构建两者

内核构建由 `os/Makefile` 驱动，关键步骤：
1. 将 `dotcargo/` 重命名为 `.cargo/`（启用 vendor 配置）
2. 使用 `cargo build -Z build-std --release --target <TARGET>` 编译
3. 使用 `rust-objcopy --strip-all -O binary` 生成 `.bin`
4. 使用 `ext4-fs-fuse` 或 `ext4-test-fuse` 制作 ext4 文件系统镜像

### 4.3 仿真与调试

- **QEMU**：支持 `qemu-system-riscv64` 和 `qemu-system-loongarch64`
- **RISC-V**：`make rvrun` — 使用 `virt` 机器，VirtIO 块设备 + 网卡
- **LoongArch**：`make larun` — 调用 `ls2k_debug.sh`
- **GDB 调试**：`make debug`（RISC-V）/ `make lagdbclient`（LoongArch）
- **Docker**：可选打包构建环境

---

## 5. 初步评估总结

| 维度 | 评估 |
|------|------|
| **架构支持** | RISC-V 64（主力）、LoongArch64（主力），x86_64/aarch64（部分移植） |
| **进程管理** | 完整：TCB、时间片轮转调度、fork/exec、PID/TID、信号处理、Futex |
| **内存管理** | 完整：分页（Sv39）、伙伴分配器、栈式页帧分配、COW、懒分配、共享内存、mmap |
| **文件系统** | 分层清晰：VFS 抽象层 → ext4 实现 + devfs/procfs/tmpfs，含块缓存 |
| **网络** | 完整：独立网络栈 (lose-net-stack)，支持 TCP/UDP/ARP，通过 VirtIO-net 驱动 |
| **设备驱动** | VirtIO 系列（blk/net/console/gpu/input/vsock），PCI 和 MMIO 传输 |
| **系统调用** | 较丰富：约 4188 行实现，覆盖 fs/process/socket |
| **代码规模** | 内核核心 (`os/src/`) 约 12,431 行，arch 层各架构各约数百至千行 |