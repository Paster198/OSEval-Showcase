## 项目初步调查报告

### 一、项目概览

该项目名称为 **OwnSome**，是一个基于 Rust 异步协程的宏内核操作系统，由北京航空航天大学开发，用于 2026 年全国大学生计算机系统能力大赛（OS 内核实现赛道）。项目基于往届项目 NighthawkOS，支持 RISC-V 64 位和 LoongArch 64 位两种指令集架构。

---

### 二、文件组织结构

```
ownsome/
├── kernel/                   # 内核核心代码（~23,882 行 Rust）
│   ├── Cargo.toml
│   ├── Makefile
│   ├── build.rs              # 构建脚本（生成链接脚本等）
│   ├── linker.ld             # 链接脚本模板
│   └── src/
│       ├── main.rs           # 内核入口/初始化
│       ├── boot.rs           # 多核启动、BSS 清零
│       ├── loader.rs         # 用户程序加载
│       ├── logging.rs        # 日志系统
│       ├── lang_item.rs      # Rust 语言项（panic_handler 等）
│       ├── entry/            # 架构相关入口点（riscv64/loongarch64）
│       ├── trap/             # Trap 处理（含汇编入口、上下文保存/恢复）
│       ├── syscall/          # 系统调用分发（~12,430 行，最大子系统）
│       ├── task/             # 任务/进程管理（~4,352 行）
│       ├── vm/               # 虚拟内存管理（~3,573 行）
│       ├── net/              # 内核网络层接口
│       ├── processor/        # 处理器控制（hart 管理）
│       └── osdriver/         # 操作系统驱动管理
│
├── lib/                      # 内核库（~34,780 行 Rust，24 个子库）
│   ├── arch/                 # 架构抽象层（控制台、中断、MMU、Trap、定时器）
│   ├── config/               # 编译时常量配置（内存布局、设备、文件系统等）
│   ├── driver/               # 设备驱动（virtio 块设备/网络、串口、PLIC 等）
│   ├── vfs/                  # 虚拟文件系统层（~4,454 行，最大 lib 子库之一）
│   ├── osfs/                 # 伪文件系统集合（~15,276 行，procfs/sysfs/devpts/tmpfs/pipefs 等）
│   ├── ext4/                 # ext4 文件系统实现
│   ├── fat32/                # FAT32 文件系统实现
│   ├── net/                  # 网络协议栈（基于 smoltcp，含 TCP/UDP/Unix Socket）
│   ├── mm/                   # 内存管理核心（物理页帧、堆分配器、页缓存）
│   ├── executor/             # 异步执行器（单核协程调度、优先级队列）
│   ├── timer/                # 定时器管理（含异步定时器）
│   ├── mutex/                # 锁机制
│   ├── signal/               # 信号处理基础设施
│   ├── shm/                  # 共享内存
│   ├── systype/              # 系统类型定义（错误码、rlimit、rusage 等）
│   ├── osfuture/             # 异步 Future 工具
│   ├── id_allocator/         # ID 分配器
│   ├── common/               # 通用工具（RingBuffer、AtomicFlags）
│   ├── logger/               # 日志基础设施
│   ├── pps/                  # 每秒脉冲（Pulse Per Second）支持
│   ├── polyhal-macro/        # 多架构硬件抽象宏
│   └── simdebug/             # 模拟调试支持
│
├── user/                     # 用户态程序（~4,613 行 Rust）
│   ├── src/bin/              # 用户二进制程序（init_proc、shell 等 16 个）
│   ├── src/lib.rs            # 用户库（系统调用接口封装）
│   ├── src/ltpauto.rs        # LTP 自动化测试支持
│   └── src/initproclib.rs    # init 进程辅助库
│
├── submit/                   # 提交文件（Cargo 配置模板、vendor 依赖归档）
├── docs/                     # 文档（设备树、LTP 待办、系统调用待办）
├── Cargo.toml                # 工作区根配置（含所有依赖声明）
├── Makefile                  # 构建编排（build/run/fs-img 等目标）
├── Dockerfile                # 构建环境 Docker 镜像定义
├── rust-toolchain.toml       # Rust 工具链配置（nightly-2025-01-18）
├── LTPtestcase.txt           # LTP 测试用例清单
└── OwnSome初赛文档.pdf/txt   # 初赛设计文档
```

---

### 三、子系统划分与归属

| 子系统 | 对应代码位置 | 行数（约） | 说明 |
|---|---|---|---|
| **系统调用接口** | `kernel/src/syscall/` | 12,430 | 含 fs、mm、net、signal、process、sche、poll、io、bpf、fanotify 等 16 个模块 |
| **进程/任务管理** | `kernel/src/task/` + `lib/executor/` | ~4,700 | 任务结构体、调度器、futex、信号处理、线程组、PID 管理、异步执行器 |
| **虚拟内存管理** | `kernel/src/vm/` + `lib/mm/` | ~4,500 | 地址空间、页表、mmap/munmap/mremap、物理页帧分配器（伙伴系统）、CoW |
| **虚拟文件系统（VFS）** | `lib/vfs/` | 4,454 | Dentry/Inode/File 抽象、路径解析、文件句柄、fanotify、dcache |
| **伪文件系统** | `lib/osfs/` | 15,276 | procfs、sysfs、devpts、tmpfs、pipefs、devfs、eventfd、signalfd、timerfd、epoll、inotify、io_uring 等 |
| **ext4 文件系统** | `lib/ext4/` | 1,618 | ext4 磁盘格式解析、inode、目录、文件操作 |
| **FAT32 文件系统** | `lib/fat32/` | 752 | FAT32 磁盘格式支持 |
| **网络协议栈** | `lib/net/` + `kernel/src/net/` | ~3,700 | 基于 smoltcp 的 TCP/UDP、Unix Domain Socket、接口管理、端口分配 |
| **设备驱动** | `lib/driver/` | 3,291 | virtio-blk、virtio-net、串口（16550）、PLIC 中断控制器、loopback、DW-MSHC（MMC） |
| **架构抽象层** | `lib/arch/` + `kernel/src/trap/` + `kernel/src/entry/` | ~2,000 | RISC-V/LoongArch trap 处理、上下文切换、MMU 操作、定时器、多核启动 |
| **信号处理** | `kernel/src/task/signal/` + `lib/signal/` | ~700 | POSIX 信号投递、sigreturn、pidfd |
| **共享内存** | `lib/shm/` + `kernel/src/vm/shm.rs` | ~200 | 共享内存段管理 |
| **定时器** | `lib/timer/` | 306 | 异步定时器、定时器管理器 |
| **同步原语** | `lib/mutex/` | 720 | 内核锁机制 |
| **配置与常量** | `lib/config/` | 930 | 编译时常量（内存布局、设备地址、文件系统参数、进程限制等） |
| **系统类型定义** | `lib/systype/` | 726 | errno、rlimit、rusage、splice flags 等 |
| **用户态程序** | `user/` | 4,613 | init_proc、shell、LTP 自动化测试、系统调用测试用例 |

---

### 四、编译构建工具需求

基于对 `Cargo.toml`、`Makefile`、`Dockerfile` 和 `rust-toolchain.toml` 的分析：

| 构建工具/依赖 | 用途 |
|---|---|
| **Rust nightly-2025-01-18** | 核心编译工具链，需要 `llvm-tools` 组件 |
| **RISC-V 裸机目标** (`riscv64gc-unknown-none-elf`) | RISC-V 架构内核编译目标 |
| **LoongArch 裸机目标** (`loongarch64-unknown-none`) | LoongArch 架构内核编译目标 |
| **cargo** | Rust 包管理与构建 |
| **GNU Make** | 顶层构建编排 |
| **musl/glibc 交叉编译工具链**（RISC-V + LoongArch） | 用户态测试程序编译（外部 testcase） |
| **QEMU**（>= 7.0，支持 riscv64/loongarch64） | 模拟运行 |
| **rust-objdump / rust-objcopy** | 内核反汇编和二进制处理 |
| **mkfs.ext4 / mount / dd** | 构建 ext4 文件系统镜像 |
| **Docker** | 可选：标准化构建环境 |

值得注意的是，内核本身使用 `#![no_std]` 环境编译，不依赖宿主操作系统的标准库；内核和用户程序构建均支持 `--offline` 模式（依赖已通过 `submit/vendor.tar.gz` 预下载归档）。

---

### 五、初步评估总结

该项目是一个功能完整的宏内核操作系统，具备以下特征：

1. **代码规模较大**：总计约 63,000 行 Rust 代码，分布在 24 个子库和内核主体中。
2. **子系统覆盖全面**：实现了内存管理（含 mmap/CoW/lazy allocation）、文件系统（ext4/FAT32/多个伪文件系统）、网络协议栈（TCP/UDP/Unix Socket）、完整的 POSIX 信号机制、异步协程调度器等。
3. **多架构支持**：通过硬件抽象层（`lib/arch`、`lib/polyhal-macro`）和条件编译支持 RISC-V 64 和 LoongArch 64。
4. **构建系统依赖链清晰**：Cargo workspace + Makefile 双层构建体系，vendor 归档支持离线构建。