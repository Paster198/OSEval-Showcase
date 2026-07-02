# GCore OS 内核项目初步调查报告

## 一、项目概览

GCore 是一个基于 Rust 语言开发的 OS 内核项目，支持 **RISC-V 64** 和 **LoongArch 64** 双架构，以 QEMU 虚拟环境为主要运行平台。项目采用 Cargo 工作空间管理，内核以 `no_std` 方式构建。

## 二、目录与文件组织结构

```
/
├── Makefile                    # 顶层 Makefile，分发到 rv64/la64 构建
├── GCore/
│   ├── Doc/                    # 技术设计文档（信号、SMP、Swap、futex、网络等）
│   ├── bootloader/             # 预编译的 SBI 固件 (fw_payload.bin)
│   ├── dependency/             # 内核依赖库（本地路径依赖）
│   │   ├── dep_iso/            # isomorphic_drivers（同构驱动）
│   │   ├── dep_pci/pci/        # PCI 总线驱动
│   │   ├── riscv/              # RISC-V 架构封装库
│   │   ├── rlibc/              # 简易 libc 实现
│   │   ├── rustsbi/            # RustSBI 接口库
│   │   └── virtio-drivers/     # VirtIO 驱动库
│   ├── os/                     # 内核主目录
│   │   ├── Cargo.toml          # 内核 crate 配置
│   │   ├── Makefile            # 内核构建 Makefile
│   │   ├── make/               # 架构相关 Makefile 片段
│   │   │   ├── rv64.mk         # RISC-V 64 构建规则
│   │   │   ├── la64.mk         # LoongArch 64 构建规则
│   │   │   └── la64o.mk        # LoongArch 64 备选构建规则
│   │   ├── src/                # 内核源码
│   │   ├── vendor/             # Rust 第三方依赖 (vendored)
│   │   ├── dotcargo/           # Cargo 配置
│   │   ├── dotcargo_os/        # OS 级 Cargo 配置
│   │   ├── buildfs.sh*         # 文件系统镜像构建脚本
│   │   ├── run_script          # QEMU 自动化运行脚本 (expect)
│   │   └── *.img / *.bin       # 预编译内核/测试二进制
│   ├── user/                   # 用户态程序
│   │   ├── Cargo.toml          # 用户库 crate 配置
│   │   ├── Makefile            # 用户程序构建 Makefile
│   │   ├── src/                # 用户库源码
│   │   │   ├── bin/initproc.rs # init 进程
│   │   │   ├── lib.rs          # 用户库主入口
│   │   │   ├── syscall.rs      # 系统调用封装
│   │   │   └── linker*.ld      # 用户程序链接脚本
│   │   ├── LaTest/             # 预编译测试程序 (lmbench, busybox, lua 等)
│   │   │   ├── glibc/          # glibc 链接版本
│   │   │   └── musl/           # musl 链接版本
│   │   └── fs/                 # 文件系统模板目录 (bin/, etc/, root/)
│   └── util/                   # 工具
│       └── qemu-2k1000/        # LoongArch 2K1000 板级 QEMU 支持
└── Gcore设计文档.pdf / .txt    # 项目设计文档
```

## 三、子系统识别与代码归属

### 3.1 子系统总览

| 子系统 | 主要目录 | 核心代码行数（Rust，不含 vendor） | 说明 |
|--------|----------|----------------------------------|------|
| **HAL（硬件抽象层）** | `GCore/os/src/hal/` | ~6,200 | 架构与平台抽象 |
| **内存管理 (MM)** | `GCore/os/src/mm/` | ~4,000 | 页表、帧分配、内存映射、Zram |
| **文件系统 (FS)** | `GCore/os/src/fs/` | ~16,300 | VFS、ext4、FAT32、设备文件、Pipe |
| **系统调用 (Syscall)** | `GCore/os/src/syscall/` | ~5,000 | 系统调用分发与实现 |
| **任务管理 (Task)** | `GCore/os/src/task/` | ~2,800 | 进程/线程管理、调度、信号、ELF加载 |
| **网络 (Net)** | `GCore/os/src/net/` | ~1,800 | TCP/UDP/ICMP/Unix Socket（基于 smoltcp） |
| **驱动 (Drivers)** | `GCore/os/src/drivers/` | ~800 | 块设备与串口驱动 |
| **工具 (Utils)** | `GCore/os/src/utils/` | ~200 | 错误处理、随机数 |
| **数学 (Math)** | `GCore/os/src/math/` | ~12 | 数学辅助函数 |
| **其他顶层** | `GCore/os/src/*.rs` | ~700 | main、console、timer、lang_items |
| **用户库** | `GCore/user/src/` | ~1,300 | 用户态 syscall 封装与运行时 |

### 3.2 各子系统详细说明

#### HAL（硬件抽象层）— `GCore/os/src/hal/`

- **架构层** (`hal/arch/`)：
  - `riscv/`：RISC-V 64 架构支持，含 Sv39 页表 (`sv39.rs`)、SBI 调用 (`sbi.rs`)、SMP (`smp.rs`)、陷阱处理 (`trap/`)、上下文切换 (`switch.S`)。
  - `loongarch64/`：LoongArch 64 架构支持，含 LA-Flex 页表 (`laflex.rs`)、CSR 寄存器定义 (`register/`)、ACPI (`acpi.rs`)、TLB 管理 (`tlb.rs`)、陷阱处理 (`trap/`)。
- **平台层** (`hal/platform/`)：
  - RISC-V 平台：QEMU virt (`qemu.rs`)、SiFive FU740 (`fu740.rs`)、Kendryte K210 (`k210.rs`)。
  - LoongArch 平台：QEMU virt (`qemu.rs`)、龙芯 2K1000 (`2k1000.rs`)。
- **配置层** (`hal/configs/`)：各平台编译配置文件 (TOML)。

#### 内存管理 — `GCore/os/src/mm/`

- `page_table.rs`：页表实现（Sv39 / LA-Flex），用户态内存拷贝/转换。
- `frame_allocator.rs`：物理帧分配器。
- `heap_allocator.rs`：内核堆分配器（基于 buddy_system_allocator）。
- `memory_set.rs`：虚拟地址空间管理（MemorySet），内核空间。
- `map_area.rs`：内存映射区域管理（mmap 支持）。
- `zram.rs`：Zram 内存压缩（feature-gated）。
- 支持 Swap 交换机制（feature `swap`）。

#### 文件系统 — `GCore/os/src/fs/`

- `ext4/`：完整的 ext4 文件系统实现（~17 个文件，含 extent、inode、balloc、ialloc、superblock、direntry 等）。
- `fat32/`：FAT32 文件系统实现。
- `dev/`：设备文件系统（`tty.rs`、`pipe.rs`、`null.rs`、`zero.rs`、`urandom.rs`、`hwclock.rs`、`timerfd.rs`、`socket.rs`、`proc_meminfo.rs`）。
- `vfs.rs`：虚拟文件系统接口。
- `file_descriptor.rs`：文件描述符管理。
- `directory_tree.rs`：目录树与挂载点管理。
- `cache.rs`：页面缓存。
- `poll.rs`：poll/epoll 多路复用。

#### 系统调用 — `GCore/os/src/syscall/`

- `mod.rs`：系统调用分发入口。
- `process.rs`：进程相关系统调用（fork、execve、clone、wait 等）。
- `fs.rs`：文件系统相关系统调用（open、read、write、stat 等）。
- `net.rs`：网络相关系统调用（socket、bind、connect 等）。
- `syscall_id.rs`：系统调用号定义。
- `errno.rs`：错误码定义。

#### 任务管理 — `GCore/os/src/task/`

- `task.rs`：任务控制块 (TCB) 定义与核心操作。
- `manager.rs`：任务管理器（调度）。
- `processor.rs`：处理器结构与当前任务。
- `signal.rs`：Unix 信号机制实现。
- `threads.rs`：线程管理。
- `elf.rs`：ELF 加载器。
- `context.rs`：任务上下文。
- `pid.rs`：PID 分配。

#### 网络 — `GCore/os/src/net/`

- 基于 `smoltcp` 协议栈。
- `tcp.rs`：TCP socket 实现。
- `udp.rs`：UDP socket 实现。
- `icmp.rs`：ICMP socket 实现。
- `unix.rs`：Unix domain socket。
- `address.rs`：网络地址抽象。
- `config.rs`：网络配置。

#### 驱动 — `GCore/os/src/drivers/`

- `block/`：块设备驱动 — `virtio_blk.rs`、`virtio_blk_pci.rs`、`sata_blk.rs`、`mem_blk.rs`（内存模拟块设备）。
- `serial/`：NS16550A 串口驱动。

## 四、构建工具需求

根据 Makefile 和 Cargo.toml 分析，构建该项目需要：

### 必需工具

| 工具 | 用途 |
|------|------|
| **Rust 工具链** | 内核与用户程序编译 |
| - `nightly-2025-01-18` (RISC-V) | RISC-V 构建 |
| - `nightly-2024-05-01` (LoongArch) | LoongArch 构建 |
| - `rust-src` 组件 | `no_std` 编译 |
| - `llvm-tools-preview` | objcopy/objdump |
| - `cargo-binutils` (~0.2) | 二进制工具 |
| **RISC-V 目标** | `riscv64gc-unknown-none-elf` |
| **LoongArch 目标** | `loongarch64-unknown-linux-gnu` |
| **GNU Make** | 构建编排 |
| **QEMU** | 模拟运行 |
| - `qemu-system-riscv64` | RISC-V 模拟 |
| - `qemu-system-loongarch64` | LoongArch 模拟 |
| **交叉编译工具链** | |
| - `loongarch64-linux-gnu-objcopy/objdump/readelf` | LoongArch 二进制处理 |
| - `rust-objcopy/rust-objdump` | RISC-V 二进制处理 |
| **OpenSBI / RustSBI** | RISC-V SBI 固件 |
| **U-Boot** (`mkimage`) | LoongArch 内核镜像打包 |
| **文件系统工具** (`mkfs.ext4`, `dd` 等) | 文件系统镜像制作 |

### 可选/条件工具

| 工具 | 条件 |
|------|------|
| **Docker** | 容器化构建环境 |
| **expect** | 自动化 QEMU 交互（`run_script`） |

### 主要 Feature 开关

- `block_mem` / `block_virt` / `block_virt_pci` / `block_sata`：块设备模式选择
- `swap` / `zram` / `oom_handler`：内存回收机制
- `log_off` / `log_info` / `log_warn` / `log_error`：日志级别
- `board_rvqemu` / `board_laqemu` / `board_2k1000` / `board_k210` / `board_fu740`：目标板级配置
- `loongarch64` / `riscv`：目标架构
- `comp`：组件模式

## 五、关键发现

1. **双架构支持**：内核在 HAL 层完整抽象了 RISC-V 64 和 LoongArch 64 两套架构，各自有独立的页表实现（Sv39 vs LA-Flex）、陷阱处理、上下文切换和寄存器定义。

2. **文件系统丰富**：同时支持 ext4 和 FAT32，ext4 实现最为完整（约 24,000 行），涵盖 extent、块分配、inode 分配等。

3. **网络协议栈**：基于 smoltcp（vendored），在内核层封装了 TCP/UDP/ICMP/Unix Socket 的系统调用接口。

4. **成熟的内存管理**：支持 mmap、Swap、Zram 压缩和 OOM Handler，功能较为完备。

5. **用户态生态**：预置了 busybox、lua、lmbench 等测试程序，同时提供了 glibc 和 musl 两套 C 运行时链接的测试用例。

6. **代码规模**：内核核心代码约 38,600 行（不含 vendor 依赖），加上本地依赖库（riscv、virtio-drivers、rustsbi 等）约 25,800 行，总计约 56 万行（含 vendored crates 如 smoltcp、regex、syn 等）。