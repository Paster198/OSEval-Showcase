## Nighthawk OS 项目初步调查报告

### 一、项目概述

Nighthawk OS 是由哈尔滨工业大学（深圳）团队开发的操作系统内核，使用 Rust 语言编写，采用异步无栈协程架构。该项目参加 OS 内核比赛，支持 RISC-V 64 和 LoongArch 64 两种指令集架构，面向 QEMU 虚拟化平台及实际硬件（星光板、星云板）。

### 二、仓库文件组织结构

```
.
├── kernel/              -- 内核主代码
│   └── src/
│       ├── entry/       -- 多架构入口（riscv64/loongarch64）
│       ├── net/         -- 网络系统调用
│       ├── osdriver/    -- 操作系统驱动管理
│       ├── processor/   -- 处理器抽象
│       ├── syscall/     -- 系统调用分发与实现（16个子模块）
│       ├── task/        -- 任务/进程/线程管理（含信号、futex、等待队列等）
│       ├── trap/        -- 中断/异常处理（含汇编级trap入口）
│       └── vm/          -- 虚拟内存管理（地址空间、页表、mmap、ELF加载等）
├── lib/                 -- 内核库（22个独立crate）
│   ├── arch/            -- 架构相关汇编封装
│   ├── common/          -- 通用数据结构（原子标志、环形缓冲区）
│   ├── config/          -- 内核配置常量（板级、设备、文件系统、内存、信号等）
│   ├── driver/          -- 驱动抽象（CPU、PLIC、设备树、HAL）
│   ├── executor/        -- 异步任务执行器
│   ├── ext4/            -- EXT4文件系统实现（基于lwext4_rust）
│   ├── fat32/           -- FAT32文件系统实现（基于rust-fatfs）
│   ├── id_allocator/    -- ID分配器
│   ├── logger/          -- 日志输出
│   ├── mm/              -- 内存管理（地址、物理帧、堆）
│   ├── mutex/           -- 互斥锁
│   ├── net/             -- 网络协议栈（基于smoltcp，含UDP/TCP/DNS等）
│   ├── osfs/            -- 文件系统接口（fd表、pselect、临时文件等）
│   ├── osfuture/        -- 异步Future支持
│   ├── polyhal-macro/   -- 多架构抽象宏（含percpu）
│   ├── pps/             -- CPU特权寄存器存储
│   ├── shm/             -- 共享内存
│   ├── signal/          -- 信号机制
│   ├── simdebug/        -- 调试支持
│   ├── systype/         -- 系统类型与错误码（rlimit、rusage、splice等）
│   ├── timer/           -- 定时器（异步定时器、定时器管理）
│   └── vfs/             -- 虚拟文件系统（dentry缓存、inode、路径解析、stat等）
├── user/                -- 用户态程序
│   └── src/
│       ├── bin/         -- 内置测试程序（shell、init_proc、hello_world等）
│       └── *.rs         -- 用户态库（syscall封装、console、错误处理）
├── testcase/            -- 测试用例（按架构和libc分类：glibc/musl）
├── img-data/            -- 磁盘镜像依赖文件
├── submit/              -- 比赛提交依赖（vendor.tar.gz、config.toml）
├── docs/                -- 文档资料
├── Cargo.toml           -- Rust workspace配置
├── Makefile             -- 顶层构建脚本
├── Dockerfile           -- Docker构建环境
└── rust-toolchain.toml  -- Rust工具链配置（nightly-2025-01-18）
```

### 三、子系统划分

根据代码结构和功能，该项目实现了以下子系统：

| 子系统 | 主要目录/文件 | 说明 |
|--------|-------------|------|
| **进程/任务管理** | `kernel/src/task/`、`kernel/src/processor/` | 进程/线程创建、clone、exec、exit、wait、futex、线程组、TID管理、时间统计 |
| **系统调用** | `kernel/src/syscall/` | 约192个系统调用分发，覆盖文件、内存、进程、网络、信号、时间等 |
| **内存管理** | `kernel/src/vm/`、`lib/mm/` | 物理帧分配、堆管理、地址空间、页表、mmap、共享内存、ELF加载、COW |
| **文件系统** | `lib/vfs/`、`lib/osfs/`、`lib/ext4/`、`lib/fat32/` | VFS抽象层、dentry缓存、EXT4/FAT32实现、fd表、路径解析 |
| **网络** | `kernel/src/net/`、`lib/net/` | 基于smoltcp的TCP/UDP/DNS/ICMP协议栈，socket系统调用 |
| **信号/IPC** | `lib/signal/`、`kernel/src/task/signal/`、`lib/shm/` | POSIX信号、共享内存、等待队列 |
| **中断/异常** | `kernel/src/trap/` | 用户态/内核态trap处理，多架构汇编入口 |
| **设备驱动** | `lib/driver/`、`kernel/src/osdriver/` | 设备树解析、PLIC中断控制器、virtio块设备/网络设备 |
| **定时器** | `lib/timer/` | 异步定时器、定时器管理 |
| **异步调度** | `lib/executor/`、`lib/osfuture/` | 基于Rust async/await的无栈协程调度器 |
| **多架构支持** | `lib/arch/`、`lib/polyhal-macro/`、`kernel/src/entry/` | RISC-V和LoongArch的条件编译与架构抽象 |
| **日志/调试** | `lib/logger/`、`lib/simdebug/`、`kernel/src/logging.rs` | 可过滤的日志系统 |

### 四、代码规模

- 内核及库代码（`kernel/src/` + `lib/`）：约 **58,283 行** Rust 代码
- 系统调用分发：约 **192 个** match 分支
- 库 crate 数量：**22 个**独立 crate
- 用户态测试程序：**17 个**

### 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|--------------|
| **Rust nightly (2025-01-18)** | 内核编译，需要 unstable features | 可用（rustup） |
| **rust-src** | no_std 编译所需 | 可用 |
| **llvm-tools** | rust-objdump、rust-objcopy | 可用（cargo-binutils） |
| **RISC-V GCC 交叉工具链** | GDB调试 | 可用 |
| **LoongArch GCC 交叉工具链** | GDB调试 | 可用 |
| **QEMU (riscv64/loongarch64)** | 模拟运行 | 可用 |
| **GNU Make** | 构建编排 | 可用 |
| **mkfs.ext4 / dd / mount** | 文件系统镜像制作 | 可用 |
| **Docker** | 可选的构建环境 | 未确认 |
| **Git** | 依赖拉取（部分依赖来自Git仓库） | 可用 |

关键外部依赖（通过Git引用）：smoltcp（网络栈）、rust-fatfs（FAT32）、lwext4_rust（EXT4）、rust-elf（ELF解析）、loongArch64（LoongArch寄存器抽象）、virtio-drivers（virtio设备驱动）。比赛提交时通过 `submit/vendor.tar.gz` 提供离线依赖。