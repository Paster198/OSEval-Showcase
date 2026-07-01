# OSKernel2024-TrustOS 项目初步分析报告

## 项目概述

TrustOS 是由华中科技大学学生团队（RustTrushHuster 队）基于 rCore-Tutorial Chapter6 开发的 **RISC-V 架构宏内核操作系统**，使用 Rust 语言编写。该项目参加了 OSKernel2024 比赛，复赛排行榜排名第五（分数 393.6069）。项目从 rCore 原有的 11 个非 POSIX 系统调用扩展到 105 个满足 POSIX 标准的系统调用。

---

## 仓库文件组织结构

```
.
├── Makefile                # 顶层构建脚本（编译内核并复制二进制）
├── README.md               # 项目说明
├── rust-toolchain.toml     # Rust 工具链锁定（nightly-2024-02-03）
├── board.sh                # 上板辅助脚本（SD卡写入等）
├── kernel-qemu             # 预编译的内核二进制（QEMU 用）
├── sbi-qemu                # SBI 固件二进制（QEMU 用）
├── busybox / busybox.S     # 预编译的 busybox 及其链接脚本
├── LICENSE                 # 许可证（GPLv2 风格，约 35KB）
├── bootloader/             # SBI 引导固件（OpenSBI / RustSBI 的 QEMU 二进制）
├── os/                     # 内核源码（Rust，核心部分）
├── user/                   # 用户态测试程序（Rust）
├── lwext4_rust/            # lwext4 文件系统的 Rust 绑定封装（独立 crate）
├── final_tests/            # 比赛测试套件集合（LTP、busybox、lmbench 等）
├── doc/                    # 设计文档与测试说明
└── .vscode/                # VS Code 编辑器配置
```

---

## 内核子系统划分

内核源码位于 `os/src/`，共 **81 个源文件**（.rs / .S / .asm），约 **14,625 行代码**。按目录划分为以下子系统：

| 子系统 | 目录 | 文件数 | 代码行数 | 说明 |
|--------|------|--------|----------|------|
| **系统调用** | `syscall/` | 8 | 3,953 | 实现 105 个系统调用，按功能分为 fs、process、memory、signal、time、net、options 等子模块 |
| **内存管理** | `mm/` | 10 | 3,060 | SV39 页表、物理帧分配、地址空间（MemorySet）、堆分配、缺页处理（懒分配）、共享内存（SHM） |
| **文件系统** | `fs/` | 16 | 2,919 | VFS 抽象层、ext4（对接 lwext4）、设备文件系统（devfs）、管道、标准 I/O、挂载管理、目录项、网络文件抽象 |
| **进程/任务管理** | `task/` | 11 | 1,567 | 进程/线程管理、调度、上下文切换、futex、TID 分配、sysinfo、辅助向量（aux） |
| **信号机制** | `signal/` | 3 | 590 | 信号动作（sigaction）、信号集、信号投递与处理 |
| **异常/中断处理** | `trap/` | 3 | 499 | 陷入上下文保存/恢复（汇编）、中断/异常分发处理 |
| **工具/辅助** | `utils/` | 4 | 553 | 错误码定义（POSIX errno 映射）、字符串工具、Hart 管理 |
| **设备驱动** | `drivers/` | 7 | 476 | VirtIO 块设备（QEMU）、SD 卡驱动（VisionFive2）、RAMDisk、设备抽象 |
| **同步机制** | `sync/` | 3 | 93 | 中断开关封装、单核/多核同步原语（UPSafeCell） |
| **配置** | `config/` | 4 | 43 | 内存布局参数、板级配置、同步参数 |
| **板级定义** | `boards/` | 3 | 33 | QEMU 和 VisionFive2 板级参数 |
| **其他** | 根目录文件 | 9 | ~839 | 入口（main.rs、entry.asm）、控制台输出、SBI 接口、日志、语言项、定时器 |

---

## 辅助组件

- **lwext4_rust/**：独立的 Rust crate，封装 C 语言实现的 lwext4 文件系统库。包含 Rust 绑定（bindings.rs）、块设备接口（blockdev.rs）和文件操作接口（file.rs），以及底层 C 源码（c/ 目录）。构建时需要 C 交叉编译工具链编译底层 C 代码。
- **user/**：用户态测试程序，包含 **23 个** Rust 编写的测试二进制（hello_world、forktest、sleep、signal、usertests 等），使用 vendor 目录进行离线构建。
- **final_tests/**：比赛评测用的完整测试套件集合，包括 LTP、busybox、lmbench、libc-test、iozone、UnixBench、iperf、netperf、lua、cyclictest、rt-tests 等，通过 Docker 容器（`alphamj/os-contest:v7.7`）构建。

---

## 构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust 工具链**（nightly-2024-02-03） | 编译内核和用户态程序；需要 `rust-src`、`llvm-tools-preview`、`rustfmt`、`clippy` 组件 |
| **rust-objcopy / rust-objdump** | 从 ELF 生成裸机二进制、反汇编（来自 `llvm-tools-preview`） |
| **cargo** | Rust 包管理与构建系统 |
| **RISC-V 裸机交叉编译目标** | `riscv64gc-unknown-none-elf`（内核和用户态程序的目标三元组） |
| **RISC-V C 交叉编译工具链** | 编译 lwext4_rust 中的 C 代码部分（build.rs 调用 cc 编译） |
| **QEMU**（qemu-system-riscv64） | 运行和调试内核，支持 virt 机器、VirtIO 块设备、SMP（默认 2 核） |
| **SBI 固件**（OpenSBI / RustSBI） | 作为 bootloader 引导内核启动 |
| **Docker** | 构建 final_tests 中的测试套件 |
| **mkfs.ext4 / dd** | 制作 ext4 文件系统镜像 |
| **GDB**（riscv64-unknown-elf-gdb / rust-gdb） | 可选，用于远程调试 |

### 构建流程

1. 先编译用户态程序（`user/` 目录，`cargo build`）
2. 再编译内核（`os/` 目录，`cargo build --release`）
3. 通过 `rust-objcopy` 从 ELF 生成裸机二进制 `os.bin`
4. 复制到顶层作为 `kernel-qemu`
5. 由 QEMU 加载，配合 SBI 固件和磁盘镜像运行

### 板级配置（Feature Flags）

内核支持三种板级配置，通过 Cargo feature 切换：
- `board_qemu`：QEMU virt 机器 + VirtIO 块设备
- `board_vf2`：VisionFive2 开发板 + SD 卡驱动
- `board_ramdisk`：VisionFive2 开发板 + RAMDisk（默认配置）