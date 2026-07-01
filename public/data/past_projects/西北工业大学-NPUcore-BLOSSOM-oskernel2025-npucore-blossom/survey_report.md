## 项目结构

```
OSKernel2025-NPUcore-BLOSSOM/
├── Makefile              # 顶层构建入口
├── README.md             # 项目说明与得分记录
├── 决赛设计文档.pdf       # 设计文档
├── os/                   # 内核主体（Rust 项目）
│   ├── Cargo.toml        # 内核依赖与 feature 配置
│   ├── Makefile          # 内核构建调度（rv64/la64 双架构）
│   ├── make/             # 架构相关 Makefile（rv64.mk, la64.mk）
│   ├── src/              # 内核源码（约 170 个 .rs 文件，约 36000 行）
│   │   ├── main.rs       # 内核入口
│   │   ├── hal/          # 硬件抽象层（arch + platform）
│   │   ├── mm/           # 内存管理
│   │   ├── task/         # 进程/线程管理
│   │   ├── fs/           # 文件系统
│   │   ├── net/          # 网络
│   │   ├── syscall/      # 系统调用
│   │   ├── drivers/      # 设备驱动
│   │   ├── utils/        # 工具模块
│   │   ├── math/         # 数学辅助
│   │   ├── timer.rs      # 定时器
│   │   └── console.rs    # 控制台输出
│   └── vendor/           # 离线 crate 依赖
├── user/                 # 用户态程序（Rust 项目）
│   ├── Cargo.toml
│   ├── Makefile
│   └── src/
│       ├── bin/          # 用户程序（initproc.rs）
│       ├── lib.rs        # 用户库
│       └── syscall.rs    # 用户态系统调用封装
├── apps/                 # 扩展应用
│   ├── kilo/             # 文本编辑器（C）
│   └── tetris/           # 俄罗斯方块游戏（C）
├── bootloader/           # 引导固件（fw_payload.bin）
├── dependency/           # 本地依赖库
│   ├── rustsbi/          # RustSBI 固件
│   ├── virtio-drivers/   # VirtIO 设备驱动
│   ├── riscv/            # RISC-V 寄存器访问库
│   ├── dep_iso/          # 同构驱动库（isomorphic_drivers）
│   ├── dep_pci/          # PCI 总线驱动
│   └── rlibc/            # Rust libc 替代
└── util/                 # 工具
    ├── mkimage           # 镜像制作工具
    └── qemu-2k1000/      # LoongArch 2K1000 QEMU 模拟器
```

## 初步调查结果

### 1. 项目概况

本项目名为 **NPUcore-BLOSSOM**，由西北工业大学团队开发，参加 OSKernel2025 竞赛。项目基于此前的 NPUcore-lwext4 框架迭代升级，是一个用 Rust 编写的操作系统内核，同时支持 **RISC-V 64** 和 **LoongArch 64** 两种架构。

### 2. 已实现的子系统

| 子系统 | 对应目录 | 说明 |
|--------|----------|------|
| **硬件抽象层 (HAL)** | `os/src/hal/` | 包含 `arch/riscv`、`arch/loongarch64` 两套架构实现，以及 `platform/` 下多块板级支持（QEMU virt、VisionFive2、2K1000、Fu740、K210）。涵盖启动引导（entry.asm）、上下文切换（switch.S）、异常/中断处理（trap/）、TLB 管理、SBI 调用、寄存器定义等。 |
| **内存管理 (MM)** | `os/src/mm/` | 物理页帧分配器（frame_allocator）、堆分配器（heap_allocator）、地址空间管理（memory_set/map_area）、页表管理（page_table）、zram 压缩内存（可选 feature）。支持 OOM 处理、swap 交换。 |
| **进程/线程管理 (Task)** | `os/src/task/` | 进程与线程管理（task/threads）、ELF 加载与动态链接（elf）、调度器（manager/processor）、PID 分配（pid）、信号机制（signal）、上下文（context）。 |
| **文件系统 (FS)** | `os/src/fs/` | VFS 层（vfs）、EXT4 文件系统实现（ext4/，含超级块、inode、extent、bitmap、目录项等完整子模块）、FAT32 文件系统（fat32/）、目录树管理（directory_tree）、文件描述符表（file_descriptor）、inode 管理、poll 机制、swap 分区支持。设备文件包括 pipe、null、zero、urandom、hwclock、interrupts、tty、socket。 |
| **网络 (Net)** | `os/src/net/` | 基于 smoltcp 协议栈，实现 TCP（tcp）、UDP（udp）、Unix Domain Socket（unix），以及网络地址管理（address/config）。 |
| **系统调用 (Syscall)** | `os/src/syscall/` | 涵盖文件系统操作（fs）、进程管理（process）、网络操作（net）三大类。从 syscall_id.rs 可见实现了约 80+ 个系统调用，包括 dup/open/read/write/pipe/mmap/fork/exec/clone/signal/socket/splice/poll/futex 等。 |
| **设备驱动 (Drivers)** | `os/src/drivers/` | 块设备驱动（block/）：VirtIO 块设备（MMIO 和 PCI 两种模式）、SATA 块设备、内存块设备。串口驱动（serial/）：NS16550A UART。 |
| **定时器 (Timer)** | `os/src/timer.rs` | 定时器管理，约 366 行。 |

### 3. 双架构支持

- **RISC-V 64**：目标三元组 `riscv64gc-unknown-none-elf`，使用 OpenSBI/RustSBI 作为引导固件，支持 QEMU virt 和 VisionFive2 开发板。
- **LoongArch 64**：目标三元组 `loongarch64-unknown-none`，使用 fw_payload.bin 引导，支持 QEMU virt 和 2K1000 开发板。LoongArch 侧有完整的 CSR 寄存器定义（base/mmu/ras/timer 四类）。

### 4. 构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust 工具链** | `rustc`（nightly-2024-05-01）、`cargo`、`rustup`、`rust-src`、`llvm-tools-preview`、`rust-objcopy`、`rust-objdump` |
| **QEMU** | `qemu-system-riscv64`（RISC-V 模拟）、`qemu-system-loongarch64`（LoongArch 模拟，仓库自带定制版本） |
| **GNU Make** | 构建调度 |
| **文件系统镜像工具** | `buildfs.sh` 脚本用于制作 rootfs 镜像（可能用到 mkfs.ext4/mkfs.vfat/dd 等） |
| **GDB** | 可选，用于调试（`riscv64-unknown-elf-gdb` / `loongarch64-unknown-elf-gdb`） |
| **Git** | 依赖管理（vendor 目录已离线化） |

项目使用 Cargo 的 vendor 模式进行离线构建，所有 crate 依赖已预置于 `os/vendor/` 目录。内核通过 Cargo feature 机制切换架构（`riscv`/`loongarch64`）、板级（`board_rvqemu`/`board_laqemu` 等）、块设备模式（`block_virt`/`block_sata`/`block_mem`）和日志级别。