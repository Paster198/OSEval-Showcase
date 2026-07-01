## AronaOS 项目初步调查报告

### 一、项目概述

AronaOS 是 HIT（哈尔滨工业大学）"旺仔"团队为 2024 年全国操作系统大赛开发的内核项目。基于 rCore-Tutorial-v3 ch6（文件系统分支）开发，目标平台为 RISC-V 64 位（QEMU virt 机器），使用 Rust 语言编写，采用异步无栈协程调度模型。

### 二、仓库文件组织结构

```
.
├── bootloader/          # SBI 固件（OpenSBI / RustSBI 预编译二进制）
├── doc/                 # 项目文档
├── ext4/                # ext4 文件系统实现（独立 crate: ext4_rs）
├── fs-img-src/          # 文件系统镜像源文件（测试用例、POSIX 测试等）
├── muslc/               # musl libc 用户态程序（C 语言编译）
├── os/                  # 内核主体（Rust crate）
│   ├── src/
│   │   ├── boards/      # 板级配置（qemu.rs）
│   │   ├── drivers/     # 设备驱动（virtio-blk 块设备）
│   │   ├── executor/    # 异步任务执行器（基于 async-task）
│   │   ├── fs/          # 文件系统子系统（FAT32、ext4、devfs、procfs、pipe）
│   │   ├── mm/          # 内存管理（SV39 页表、帧分配、堆分配、COW）
│   │   ├── mutex/       # 互斥锁（自旋锁 + 关中断）
│   │   ├── signal/      # 信号机制
│   │   ├── sync/        # 同步原语（UPSafeCell）
│   │   ├── syscall/     # 系统调用分发与实现
│   │   ├── task/        # 进程/线程管理、调度、PID 分配
│   │   ├── trap/        # 异常/中断处理（trap.S 汇编入口）
│   │   ├── utils/       # 工具模块（block_on、校验和、字符串等）
│   │   ├── main.rs      # 内核入口
│   │   ├── entry.asm    # 汇编启动代码
│   │   └── linker-qemu.ld  # 链接脚本
│   └── vendor/          # 第三方依赖（vendored）
├── user/                # 用户态程序（Rust crate）
│   └── src/bin/         # 用户态可执行文件（shell、initproc 等）
├── testsuits-for-oskernel/  # 操作系统竞赛测试套件（git submodule）
├── Makefile             # 顶层 Makefile
├── rust-toolchain.toml  # Rust 工具链配置（nightly-2024-01-18）
└── Dockerfile           # Docker 构建环境
```

### 三、子系统分析

| 子系统 | 对应目录/文件 | 说明 |
|--------|-------------|------|
| **内存管理 (MM)** | `os/src/mm/` | SV39 虚拟内存、帧分配器（buddy_system_allocator）、堆分配、页表管理、COW（写时复制）、用户态地址校验 |
| **进程/线程管理** | `os/src/task/` | 进程（Process）与线程（Thread）抽象、PID 分配、处理器管理（多核 Hart）、调度器 |
| **异步调度器** | `os/src/executor/` | 基于 `async-task` crate 的无栈协程执行器，使用任务队列（VecDeque）进行调度 |
| **系统调用** | `os/src/syscall/` | 实现约 50+ 个 POSIX 系统调用，涵盖文件、内存、进程、信号、时间等类别 |
| **文件系统** | `os/src/fs/` + `ext4/` | FAT32 文件系统（自实现）、ext4 文件系统（独立 crate ext4_rs）、devfs（/dev/null、/dev/tty、/dev/rtc 等）、procfs（/proc/meminfo、/proc/mounts）、管道（pipe）、fd 表管理、路径解析 |
| **Trap/中断处理** | `os/src/trap/` | 用户态/内核态切换（trap.S 汇编）、时钟中断、异常处理、信号分发 |
| **信号机制** | `os/src/signal/` | POSIX 信号定义（31 种信号）、sigaction、sigprocmask、信号处理函数 |
| **设备驱动** | `os/src/drivers/` | virtio-blk 块设备驱动 |
| **同步原语** | `os/src/mutex/` + `os/src/sync/` | 自旋锁（含关中断变体 SpinNoIrqLock）、UPSafeCell |
| **用户态程序** | `user/` | Rust 编写的用户态程序，包括 initproc、shell（arona_shell）、测试程序 |
| **C 用户态支持** | `muslc/` | 基于 musl libc 编译的 C 语言用户态程序 |
| **SBI 接口** | `os/src/sbi.rs` | 通过 sbi-rt crate 与 SBI 固件交互 |

### 四、构建工具需求

| 工具 | 用途 | 状态 |
|------|------|------|
| **Rust nightly-2024-01-18** | 内核与用户态程序编译 | 可用（rustup） |
| **rust-src, llvm-tools** | Rust 交叉编译与二进制工具 | 可用 |
| **cargo-binutils** (rust-objcopy) | ELF 转 binary | 可用 |
| **QEMU (riscv64)** | 模拟器运行 | 可用 |
| **OpenSBI / RustSBI** | SBI 固件（已预编译在 bootloader/） | 可用 |
| **mkfs.vfat / mkfs.ext4** | 文件系统镜像制作 | 可用 |
| **dd** | 镜像文件创建 | 可用 |
| **RISC-V 交叉编译工具链** | musl libc 用户态 C 程序编译 | 可用（RISC-V Linux GNU） |
| **GNU Make** | 构建编排 | 可用 |
| **cargo fmt** | 代码格式化（构建流程中调用） | 可用 |

构建流程概要：`make all` -> 编译用户态 Rust 程序 -> 编译 musl libc C 程序 -> 打包文件系统镜像（FAT32 或 ext4）-> 编译内核（cargo build，目标 riscv64gc-unknown-none-elf）-> objcopy 生成二进制 -> 通过 QEMU 启动。