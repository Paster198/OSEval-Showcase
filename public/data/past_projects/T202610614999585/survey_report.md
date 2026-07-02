# Starry OS 项目初步调查报告

## 一、项目概述

该项目名为 **Starry OS**，是一个基于 ArceOS 组件化运行基座与 starry-next 演进而来的 Rust 宏内核，面向 2025 年全国大学生计算机系统能力大赛内核赛道进行适配与优化。重点支持 **riscv64** 和 **loongarch64** 两条架构线，同时兼容 aarch64 和 x86_64。

项目在 ArceOS 基础上补齐了面向 POSIX 语义的进程/线程、虚拟内存、文件系统、信号、网络与系统调用等子系统，并通过 LTP、busybox、lua、libctest、iperf、netperf、iozone、lmbench、cyclictest 等测试集持续验证。

---

## 二、仓库文件组织结构

### 顶层目录布局

```
repo/
├── src/                    # 内核入口与主逻辑
│   ├── main.rs             # 内核入口点，初始化环境、挂载FS、启动init进程
│   ├── entry.rs            # 用户态应用启动（ELF加载、进程/线程创建）
│   ├── syscall.rs          # 系统调用分发（约584行，match所有sysno）
│   ├── mm.rs               # 内核态与用户态内存映射辅助
│   ├── init.sh             # 测试脚本分发
│   ├── rv_case / la_case   # RISC-V/LoongArch 测试用例配置
│
├── api/                    # 系统调用与POSIX兼容接口实现（crate: starry-api）
│   └── src/
│       ├── lib.rs          # crate入口
│       ├── imp/            # 系统调用实现（核心逻辑）
│       │   ├── fs/         # 文件系统syscall（ctl, fd_ops, io, mount, stat, pipe）
│       │   ├── task/       # 进程/线程syscall（clone, execve, exit, wait, schedule, thread, ctl, job）
│       │   ├── mm/         # 内存syscall（brk, mmap）
│       │   ├── net/        # 网络syscall（io, socket, name, opt）
│       │   ├── io_mpx/     # I/O多路复用（epoll, poll, select）
│       │   ├── ipc/        # 进程间通信（shm）
│       │   ├── signal.rs   # 信号处理
│       │   ├── futex.rs    # futex
│       │   ├── sys.rs      # 系统级syscall
│       │   ├── time.rs     # 时间相关syscall
│       │   └── resources.rs # 资源限制
│       ├── file/           # 文件描述符类型抽象（fs, net, pipe, stdio, unix socket）
│       ├── ptr.rs          # 用户态指针工具
│       ├── signal.rs       # 信号数据结构
│       ├── socket.rs       # 套接字数据结构
│       └── time.rs         # 时间工具
│
├── core/                   # 内核核心资源管理（crate: starry-core）
│   └── src/
│       ├── lib.rs          # crate入口
│       ├── task.rs         # 任务管理（约571行）
│       ├── task/stat.rs    # 任务统计
│       ├── mm.rs           # 内存管理核心
│       ├── vfs/            # 虚拟文件系统层
│       │   ├── mod.rs      # VFS核心（约651行）
│       │   ├── proc.rs     # procfs实现
│       │   ├── dev.rs      # devfs实现
│       │   ├── tmp.rs      # tmpfs实现
│       │   ├── etc.rs      # etc配置文件
│       │   └── simple/     # 简化VFS实现（dev, dir, file, fs）
│       ├── futex.rs        # Futex内核实现
│       ├── resources.rs    # 资源限制
│       └── time.rs         # 定时器/ITimer
│
├── config/                 # 平台与架构配置（crate: starry-config）
│   └── src/
│       ├── lib.rs
│       ├── riscv64.rs, loongarch64.rs, aarch64.rs, x86_64.rs
│
├── arceos/                 # ArceOS基座（git submodule）
│   ├── modules/            # 内核模块
│   │   ├── axhal/          # 硬件抽象层（架构+平台代码）
│   │   ├── axmm/           # 内存管理（地址空间、后端分配器）
│   │   ├── axtask/         # 任务管理（调度、等待队列、定时器）
│   │   ├── axalloc/        # 全局内存分配器（slab/page）
│   │   ├── axdriver/       # 设备驱动（virtio, PCI, MMIO, ixgbe）
│   │   ├── axnet/          # 网络栈（基于smoltcp）
│   │   ├── axfs-ng/        # 文件系统（FAT, ext4）
│   │   ├── axruntime/      # 运行时/启动流程
│   │   ├── axlog/          # 日志
│   │   ├── axsync/         # 同步原语（Mutex等）
│   │   ├── axconfig/       # 构建配置生成
│   │   ├── axdisplay/      # 显示
│   │   └── axdma/          # DMA
│   ├── api/                # 对外API
│   │   ├── arceos_api/     # 高层Rust API
│   │   ├── arceos_posix_api/ # POSIX C API（fd_ops, fs, io, net, pthread, pipe, stdio等）
│   │   └── axfeat/         # 特性门控
│   ├── ulib/               # 用户态库
│   │   ├── axlibc/         # libc实现
│   │   └── axstd/          # std-like库
│   ├── configs/            # 平台defconfig
│   └── scripts/            # 构建辅助脚本
│
├── vendor/                 # 本地vendored第三方依赖（约140+ crate）
├── auto-test/              # 测试脚本与评测辅助工具
├── bin/                    # 构建辅助二进制（含axconfig-gen）
├── .github/workflows/      # CI配置
├── Cargo.toml              # Workspace定义
├── Makefile                # 顶层构建入口
├── rust-toolchain.toml     # Rust工具链版本锁定
└── 初赛设计文档.pdf/.txt   # 设计文档
```

### 代码规模概览

| 范围 | 文件数 | 代码行数 |
|------|--------|----------|
| 本项目核心代码（不含vendor/arceos） | ~50个.rs文件 | ~8,900行 |
| arceos模块（非vendor） | ~120个.rs文件 | ~37,300行 |
| vendor目录 | ~3,661个.rs文件 | 未统计 |
| **本项目+arceos合计** | ~170个.rs文件 | ~46,200行 |

---

## 三、子系统划分

### 1. 内存管理子系统 (Memory Management)

| 所属目录/文件 | 功能 |
|---|---|
| `core/src/mm.rs` | 内核内存管理核心，ELF缓存等 |
| `api/src/imp/mm/` (mmap.rs, brk.rs) | mmap/brk 系统调用实现 |
| `src/mm.rs` | 内核态/用户态内存映射辅助 |
| `arceos/modules/axmm/` | 地址空间(AddrSpace)、Backend、页帧管理 |
| `arceos/modules/axalloc/` | 全局分配器（slab + page allocator） |
| `arceos/modules/axhal/src/paging.rs`, `mem.rs` | 页表操作、物理内存 |

### 2. 进程/任务管理子系统 (Process & Task Management)

| 所属目录/文件 | 功能 |
|---|---|
| `core/src/task.rs`, `core/src/task/stat.rs` | 任务结构、进程管理、时间统计 |
| `api/src/imp/task/` (clone, execve, exit, wait, schedule, thread, ctl, job) | 进程/线程syscall |
| `arceos/modules/axtask/` | 任务调度、运行队列、等待队列、定时器 |
| `arceos/modules/axruntime/` | 启动流程、SMP |

### 3. 文件系统子系统 (File System / VFS)

| 所属目录/文件 | 功能 |
|---|---|
| `core/src/vfs/` (mod.rs, proc.rs, dev.rs, tmp.rs, simple/) | VFS层、procfs、devfs、tmpfs |
| `api/src/imp/fs/` (ctl.rs, io.rs, mount.rs, stat.rs, fd_ops.rs, pipe.rs) | 文件系统syscall |
| `api/src/file/` (fs.rs, net.rs, pipe.rs, stdio.rs, unix.rs) | 文件描述符类型抽象 |
| `arceos/modules/axfs-ng/` | FAT、ext4底层文件系统实现 |
| `arceos/modules/axdriver/src/disk.rs` | 块设备驱动 |

### 4. 网络子系统 (Networking)

| 所属目录/文件 | 功能 |
|---|---|
| `api/src/imp/net/` (io.rs, socket.rs, name.rs, opt.rs) | 网络系统调用 |
| `api/src/socket.rs` | 套接字数据结构 |
| `arceos/modules/axnet/` (smoltcp_impl/) | 基于smoltcp的TCP/IP协议栈 |
| `arceos/modules/axdriver/` (virtio.rs, ixgbe.rs) | 网卡驱动 |

### 5. 信号子系统 (Signal)

| 所属目录/文件 | 功能 |
|---|---|
| `api/src/imp/signal.rs` | 信号系统调用实现 |
| `api/src/signal.rs` | 信号数据结构定义 |
| `vendor/axsignal/` | 信号底层机制 |

### 6. 进程间通信子系统 (IPC)

| 所属目录/文件 | 功能 |
|---|---|
| `api/src/imp/ipc/` (shm.rs, util.rs) | 共享内存系统调用 |

### 7. I/O多路复用子系统 (I/O Multiplexing)

| 所属目录/文件 | 功能 |
|---|---|
| `api/src/imp/io_mpx/` (epoll.rs, poll.rs, select.rs) | epoll/poll/select |

### 8. 时间与定时器子系统 (Time & Timer)

| 所属目录/文件 | 功能 |
|---|---|
| `api/src/imp/time.rs` | 时间相关系统调用 |
| `core/src/time.rs` | ITimer实现 |
| `arceos/modules/axhal/src/time.rs` | 硬件时钟抽象 |

### 9. 同步原语子系统 (Synchronization)

| 所属目录/文件 | 功能 |
|---|---|
| `api/src/imp/futex.rs` | Futex系统调用 |
| `core/src/futex.rs` | Futex内核实现 |
| `arceos/modules/axsync/` | Mutex等同步原语 |

### 10. 硬件抽象层 (HAL)

| 所属目录/文件 | 功能 |
|---|---|
| `arceos/modules/axhal/src/arch/` (riscv, loongarch64, aarch64, x86_64) | 架构相关：上下文切换、陷阱处理 |
| `arceos/modules/axhal/src/platform/` | 平台相关：启动、中断、时钟、内存布局、SMP |
| `arceos/modules/axhal/src/cpu.rs`, `irq.rs`, `trap.rs`, `tls.rs` | 通用HAL接口 |

### 11. 设备驱动子系统 (Device Drivers)

| 所属目录/文件 | 功能 |
|---|---|
| `arceos/modules/axdriver/` | virtio块设备/网络、PCI、MMIO总线、ixgbe网卡 |

### 12. 平台配置子系统

| 所属目录/文件 | 功能 |
|---|---|
| `config/src/` | 各架构平台配置参数 |
| `arceos/modules/axconfig/` | 构建时配置生成（axconfig-gen） |
| `arceos/configs/platforms/` | 各平台预置defconfig |

---

## 四、构建工具需求

### 必要工具

| 工具 | 说明 |
|------|------|
| **Rust工具链** | `nightly-2025-05-20`，含 `rust-src`, `llvm-tools`, `rustfmt`, `clippy` |
| **交叉编译目标** | `riscv64gc-unknown-none-elf`, `loongarch64-unknown-none`, `aarch64-unknown-none`, `x86_64-unknown-none` |
| **GNU Make** | 顶层构建编排 |
| **axconfig-gen** | 预编译二进制，位于 `bin/` 目录，用于生成平台配置 |

### 测试/运行工具

| 工具 | 说明 |
|------|------|
| **QEMU** | 模拟运行（RISC-V virt, LoongArch virt, aarch64 virt, x86_64） |
| **Docker** | 可选，提供标准化构建环境（镜像：`zhouzhouyi/os-contest:20260510`） |

### 可选工具

| 工具 | 说明 |
|------|------|
| **curl + xz** | 下载和解压测试磁盘镜像 |
| **RISC-V/LoongArch GNU工具链** | 提供 `libgcc_s.so.1`（运行时依赖） |

### 构建流程概要

1. `make prepare` — 配置 cargo config、安装 axconfig-gen
2. `make defconfig` — 调用 arceos 的 defconfig 生成平台配置
3. `make build` (或 `rv_build` / `la_build`) — 通过 arceos 构建流程编译内核
4. `make run` / `make qemu` — 准备磁盘镜像后启动 QEMU
5. 输出产物：`starry_riscv64-qemu-virt.bin` (RISC-V) 或 `starry_loongarch64-qemu-virt.elf` (LoongArch)