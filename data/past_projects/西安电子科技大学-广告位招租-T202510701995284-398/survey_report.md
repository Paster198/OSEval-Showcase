## NPUcore-Aspera 内核项目初步调查报告

### 一、项目概述

NPUcore-Aspera 是一个基于 Rust 编写的操作系统内核项目，源自 2024 年计算机系统能力大赛参赛队伍"NPUcore"的参赛作品。该项目支持 **LoongArch64** 和 **RISC-V64** 两种体系结构，通过自建的 HAL（硬件抽象层）统一两套架构的代码。

### 二、仓库文件组织结构

```
.
├── Makefile              # 顶层 Makefile，协调 os/user 构建
├── README.md             # 项目说明文档
├── LICENSE               # 许可证（约35KB）
├── NPUcore-Aspera内核文档.pdf  # 内核设计文档
├── NPUcore-Mix.pptx      # 项目演示PPT
├── .gitignore
├── .vscode/              # VS Code 配置
├── Docs/                 # 文档资料（文件系统、Rust、实践笔记等）
├── bootloader/           # 引导加载程序（fw_payload.bin）
├── dependency/           # 本地依赖库
│   ├── riscv/            # RISC-V 寄存器/内联汇编封装
│   ├── rlibc/            # 裸机 C 库替代
│   ├── rustsbi/          # RustSBI 固件
│   ├── virtio-drivers/   # VirtIO 驱动
│   ├── dep_pci/          # PCI 总线驱动
│   └── dep_iso/          # 同构驱动框架
├── os/                   # 内核主体（Rust no_std 项目）
│   ├── Cargo.toml        # 内核依赖配置
│   ├── Makefile          # 内核构建入口
│   ├── make/             # 架构相关 Makefile
│   │   ├── la64.mk       # LoongArch64 构建规则
│   │   ├── rv64.mk       # RISC-V64 构建规则
│   │   └── boards/       # 板级配置
│   ├── src/              # 内核源码
│   ├── vendor/           # Cargo vendor 离线依赖
│   └── scripts/          # 辅助脚本
├── user/                 # 用户态程序
│   ├── Cargo.toml        # 用户库依赖配置
│   ├── src/              # 用户态源码（initproc 等）
│   ├── fs/               # 根文件系统镜像内容（bash、terminfo 等）
│   ├── busybox_lua_testsuites/  # LoongArch/RISC-V 测试套件
│   └── vendor/           # 离线依赖
└── util/                 # 工具
    └── qemu-2k1000/      # LoongArch 2K1000 QEMU 模拟器
```

### 三、内核子系统分析

内核源码位于 `os/src/`，共约 130 个 Rust 源文件和 8 个汇编文件，可划分为以下子系统：

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| **HAL（硬件抽象层）** | `hal/` | 统一 LoongArch64 和 RISC-V64 的底层接口，包含启动、寄存器操作、异常处理、上下文切换、TLB 管理、时间等 |
| **内存管理（MM）** | `mm/` | 物理帧分配器、堆分配器、页表管理、地址空间（MemorySet）、共享内存（shm）、zram 压缩内存 |
| **文件系统（FS）** | `fs/` | VFS 层、FAT32 实现、ext4 实现、目录树管理、inode/dirent 抽象、页缓存、procfs、设备文件（pipe/null/zero/tty/hwclock/urandom/socket）、poll 机制、swap 支持 |
| **进程/任务管理** | `task/` | 任务控制块（TCB）、PID 分配、调度器、ELF 加载、信号处理、线程支持、上下文切换 |
| **系统调用** | `syscall/` | 约 117 个系统调用 ID 定义，涵盖文件操作、进程管理、网络、调度等 |
| **网络** | `net/` | 基于 smoltcp 的 TCP/UDP/Unix Socket 实现 |
| **驱动** | `drivers/` | 块设备驱动（VirtIO MMIO/PCI、SATA、内存块设备）、串口驱动（NS16550A） |
| **定时器** | `timer.rs` | 系统定时器 |
| **控制台** | `console.rs` | 内核控制台输出 |
| **工具模块** | `utils/` | 错误处理、随机数生成 |
| **数学库** | `math/` | 内核数学运算 |

### 四、支持的硬件平台

- **LoongArch64**: QEMU 虚拟平台（laqemu）、龙芯 2K1000 开发板、龙芯 2K0300 开发板
- **RISC-V64**: QEMU virt 平台（rvqemu）、K210、Fu740

### 五、构建工具链需求

| 工具 | 用途 |
|------|------|
| **Rust nightly-2025-01-18** | 内核及用户态程序编译（目标：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none`） |
| **rustup / cargo** | Rust 工具链管理、依赖构建 |
| **llvm-tools-preview** | `rust-objcopy`、`rust-objdump` 等二进制工具 |
| **loongarch64-linux-gnu-objcopy/objdump/readelf** | LoongArch 二进制处理 |
| **qemu-system-riscv64** | RISC-V64 QEMU 模拟运行 |
| **qemu-system-loongarch64**（自定义版本） | LoongArch64 2K1000 QEMU 模拟运行（仓库内含预编译版本） |
| **GNU Make** | 构建编排 |
| **mkfs.ext4 / mkfs.vfat** | 文件系统镜像制作 |
| **mkimage (U-Boot)** | LoongArch uImage 格式打包 |
| **dtc** | 设备树编译（可能用于 RISC-V） |
| **GDB** | 调试（`riscv64-unknown-elf-gdb`） |

### 六、关键特性标记（Cargo Features）

- `board_laqemu` / `board_la2k1000` / `board_la2k0300` / `board_rvqemu`：板级选择
- `block_virt` / `block_sata` / `block_mem`：块设备驱动选择
- `swap` / `zram` / `oom_handler`：内存交换与 OOM 处理
- `comp`：竞赛模式（预加载应用到内存）
- `zero_init`：LoongArch 平台 BSS 全清零初始化

### 七、用户态

用户态项目（`user/`）包含：
- 一个用户态库（`user_lib`），封装了系统调用接口
- 三个 initproc 变体（普通、竞赛、normal）
- 根文件系统镜像中包含 bash shell 及 terminfo 配置
- 附带 busybox/lua 测试套件（LoongArch64 和 RISC-V64 两套）