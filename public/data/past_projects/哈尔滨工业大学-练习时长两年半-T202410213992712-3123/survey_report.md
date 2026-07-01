## MinotaurOS 项目初步分析报告

### 一、项目概述

MinotaurOS 是一个使用 Rust 语言编写的、面向 RISC-V 64 位架构的多核操作系统内核。项目目标是实现一个 Linux 兼容的操作系统，支持进程调度、文件系统、网络等功能。项目使用 Rust nightly-2024-02-03 工具链，目标平台为 `riscv64gc-unknown-none-elf`。

内核代码总量约 **18,684 行** Rust 代码（不含汇编和链接脚本）。

---

### 二、仓库文件组织结构

仓库采用 Cargo workspace 结构，包含 4 个 crate：

```
MinotaurOS/
├── Cargo.toml          # Workspace 根配置
├── Cargo.lock
├── Makefile            # 顶层构建入口（调用 cargo task）
├── README.md
├── logo.txt
├── .cargo/config.toml  # cargo alias: task = "run --package tasks"
├── kernel/             # 内核 crate（核心代码）
├── user/               # 用户态程序 crate
├── tasks/              # 构建任务 crate（自定义构建脚本）
├── macros/             # 过程宏 crate
└── docs/               # 项目文档（Typst 格式）
```

---

### 三、子系统划分与目录映射

#### 内核子系统（kernel/src/）

| 子系统 | 目录/文件 | 说明 | 代码规模（行） |
|--------|-----------|------|---------------|
| **架构相关** | `arch/rv64/` | RISC-V 地址抽象、页表项、SBI 调用 | ~500 |
| **内存管理** | `mm/` | 地址空间、页表、堆分配器、用户分配器、内存区域（direct/file/lazy/shared）、ASID、SysV 共享内存 | ~2,500 |
| **文件系统** | `fs/` | VFS 层（inode/fd/file/path）、ext4、FAT32、tmpfs、devfs（null/zero/urandom/rtc/tty）、procfs、pipe、inotify、page cache、inode cache | ~5,500 |
| **网络** | `net/` | TCP、UDP、Unix socket、网络接口、端口管理（基于 smoltcp） | ~1,800 |
| **进程管理** | `process/` | 进程/线程创建与管理、资源追踪、事件总线、辅助向量 | ~1,200 |
| **多核管理** | `processor/` | Hart（硬件线程）管理、上下文切换 | ~400 |
| **调度** | `sched/` | 异步执行器、IO 多路复用、定时器、时钟 | ~800 |
| **信号** | `signal/` | 信号处理机制 | ~200 |
| **同步** | `sync/` | Futex、多种互斥锁（spin/sync/reentrant）、Once | ~500 |
| **系统调用** | `syscall/` | 系统调用分发与处理（fs/mm/net/process/signal/sync/time/misc/system） | ~2,800 |
| **中断/异常** | `trap/` | 内核态/用户态 trap 处理、上下文保存与恢复 | ~400 |
| **设备驱动** | `driver/` | VirtIO（块设备/网卡）、MMC/SD（JH7110）、PLIC 中断控制器、串口（NS16550A/DW-APB-UART）、ramdisk、随机数 | ~2,000 |
| **调试** | `debug/` | 控制台输出、日志系统 | ~200 |
| **内置程序** | `builtin/` | 集成到内核镜像的用户程序 | ~50 |
| **系统信息** | `system/` | 系统级信息查询 | ~100 |

#### 用户态程序（user/）

包含 3 个用户态二进制程序：
- `shell` — 命令行 Shell
- `proc_test` — 进程相关测试
- `sig_test` — 信号相关测试

用户态库提供基本的系统调用封装和控制台 I/O。

#### 构建系统（tasks/）

自定义的 Cargo 构建任务工具，负责：
- 环境准备（`env`）
- 编译内核和用户程序（`build`）
- 运行 QEMU 模拟器（`run`）
- 调试支持（`debug`）

#### 过程宏（macros/）

提供项目自定义的过程宏，基于 `syn` 和 `quote` 实现。

---

### 四、关键外部依赖

| 依赖 | 用途 |
|------|------|
| `smoltcp` (fork) | TCP/IP 网络协议栈 |
| `virtio-drivers` | VirtIO 设备驱动 |
| `lwext4_rust` | ext4 文件系统支持 |
| `goblin` | ELF 二进制解析 |
| `fdt-rs` | 设备树（DTB）解析 |
| `buddy_system_allocator` | 伙伴系统内存分配 |
| `async-task` / `futures` | 异步任务调度 |
| `riscv` (fork) | RISC-V CSR 寄存器访问 |
| `sbi-spec` | SBI 规范定义 |
| `visionfive2-sd` | VisionFive2 SD 卡驱动 |
| `tock-registers` | 硬件寄存器抽象 |

---

### 五、编译构建所需工具

| 工具 | 用途 | 必要性 |
|------|------|--------|
| **Rust nightly-2024-02-03** | 内核与用户程序编译 | 必需 |
| **RISC-V Linux GNU 交叉编译工具链** (`riscv64-unknown-linux-gnu-gcc`) | 用户态程序链接 | 必需 |
| **QEMU** (7.0-9.0) | 系统模拟运行 | 运行必需 |
| **RustSBI** (`rustsbi-qemu.bin`) | RISC-V SBI 固件 | 运行必需 |
| **Typst** | 文档编译 | 仅文档 |
| **GNU Make** | 顶层构建入口 | 可选（可直接用 cargo task） |

项目使用了大量 Rust nightly 特性（`naked_functions`、`strict_provenance`、`trait_upcasting` 等），对工具链版本有严格要求。