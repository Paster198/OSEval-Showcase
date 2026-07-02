# GoodOS 内核项目初步调查报告

## 一、项目概况

**GoodOS** 是一个使用 Rust (2021 edition) 从零开发的宏内核操作系统，面向 2026 操作系统内核实现赛（"内核实现"赛道）。项目支持 **RISC-V 64** 和 **LoongArch 64** 双架构，通过硬件抽象层（HAL）在编译期选择对应实现，上层内核代码完全架构无关。

- 总代码规模：约 **41,400 行 Rust 源代码**，分布在 11 个 crate 的约 **176 个 `.rs` 文件**中。
- 工具链：`nightly-2025-05-20`，目标 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none`。

---

## 二、仓库文件组织结构

```
(仓库根目录)
├── Cargo.toml                  # 顶层 workspace，组织 10 个内核 crate
├── Cargo.lock
├── Makefile                    # 比赛构建入口（build/run/clean）
├── rust-toolchain.toml         # 固定 nightly 版本
├── rustfmt.toml
├── .gitignore / .gitattributes
├── README.md                   # 项目说明
│
├── crates/                     # 内核源码 workspace（10 个 crate）
│   ├── kernel/                 # 内核入口、初始化、trap 分发、调度主循环
│   ├── hal/                    # 硬件抽象层（RISC-V / LoongArch 双实现）
│   ├── platform/               # 平台常量、内存布局、链接脚本
│   ├── mm/                     # 内存管理（物理页、页表、地址空间、ELF加载、COW）
│   ├── task/                   # 进程/线程管理（fork/exec/wait/futex）
│   ├── sched/                  # 底层调度器（异步运行时、阻塞/睡眠队列、work-stealing）
│   ├── signal/                 # POSIX 信号机制（sigaction/kill/sigreturn）
│   ├── fs/                     # VFS 层 + EXT4/RamFS/ProcFS/DevFS/SocketFS
│   ├── driver/                 # 设备驱动框架（virtio-blk、串口、PLIC）
│   ├── syscall/                # 系统调用分发（约 110 个 syscall）
│   └── net/                    # 网络栈（基于 smoltcp，当前注释未启用）
│
├── user/                       # 用户态 workspace（独立构建系统）
│   ├── Cargo.toml / Makefile
│   ├── libc/                   # 用户态 libc（crt0 + syscall 封装）
│   ├── apps/user_init/         # 首个用户进程（init 程序 + 测试用例集）
│   ├── apps/exec_test/         # exec 测试程序
│   ├── linker.ld / linker-la.ld
│   └── cargo-config/
│
├── configs/                    # 平台配置文件（当前为空模板）
│   ├── riscv64-qemu.toml
│   ├── riscv64-vf2.toml
│   ├── loongarch64-qemu.toml
│   └── loongarch64-laptop.toml
│
├── docs/                       # 设计文档与提交材料
│   ├── keyPoints/              # 比赛要点说明
│   └── 初赛文档/               # 初赛设计文档（PDF + txt）
│
├── scripts/                    # 辅助脚本（build_img / mk_ld / run_test，当前为空）
│
├── test_logs/                  # QEMU 日志包装脚本
│   └── scripts/
│
└── cargo-config/               # Cargo 配置（config.toml）
```

---

## 三、子系统划分与归属

### 3.1 各 crate 的角色与行数估算

| Crate | 源文件数 | 功能定位 | 依赖（内部） |
|-------|---------|---------|------------|
| `platform` | 3 | 平台常量、内存布局、链接脚本；定义 `PAGE_SIZE`、物理地址范围、MMIO 基址等 | 无（最底层） |
| `hal` | 31 | 硬件抽象层：定义 `ArchFull` 等 7 个 trait，分别实现 RISC-V 和 LoongArch 的寄存器操作、页表、trap、中断、时钟、启动等 | `platform` |
| `mm` | 11 | 内存管理：`FrameAllocator`（物理页分配）、`AddressSpace`（地址空间/SATP）、Sv39/LA64 三级页表、COW、ELF 加载、共享内存、缺页处理、内核堆、Slab 分配器 | `hal`, `platform` |
| `sched` | 14 | 异步调度运行时：`Runtime` 单例、`SimpleScheduler`（FIFO 就绪队列）、`spawn`/`block_on`/`yield_now`/`timeout`/`sleep`/`Event`、SMP work-stealing | `hal` |
| `task` | 23 | 进程/线程管理：`Process`/`Thread`/`Task` PCB/TCB、fork/exec/exit/wait/futex、进程组/会话、资源限制、时间统计、惰性 mmap 缺页处理 | `sched`, `mm`, `hal`, `platform`, `fs` |
| `signal` | 12 | POSIX 信号：`sigaction`/`sigprocmask`/`kill`/`sigreturn`、信号集（64-bit bitmap）、信号栈、信号传递（trampoline 帧） | `hal`, `task` |
| `fs` | 30 | VFS 层 + 五类文件系统实现：EXT4（磁盘读写）、RamFS（内存/tmp）、ProcFS（/proc 虚拟）、DevFS（/dev 设备节点）、SocketFS（套接字）；含 fd 表、管道、页缓存、块缓存 | `mm`, `driver`, `sched` |
| `driver` | 20 | 设备驱动框架：总线抽象（virtio-mmio/PCI）、设备注册/探测（device tree + PCI）、块设备（ramdisk/virtio-blk）、字符设备（NS16550A 串口）、中断控制器（PLIC）、网络设备（virtio-net） | `hal`, `platform`, `mm` |
| `syscall` | 16 | 系统调用分发层：`handle_syscall` 入口、按领域分模块实现（fs/io/mm/net/signal/task/time/system/shm）、约 110 个 syscall | `hal`, `task`, `fs`, `mm`, `signal`, `sched`, `platform` |
| `kernel` | 8 | 内核入口与组装：`_start` 汇编桩、`rust_main` 初始化流程、trap 分发（时钟/缺页/syscall）、init 任务创建、调度主循环 | 全部其他 crate |
| `net` | 8 | 网络栈（基于 smoltcp）：TCP/UDP/Raw socket、async socket I/O、poll/select stub（当前在 Cargo.toml 中注释未启用） | `sched`, `driver` |

### 3.2 架构图（依赖层次）

```
                    ┌──────────┐
                    │  kernel  │  (入口 + 组装)
                    └────┬─────┘
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      ┌─────────┐  ┌──────────┐  ┌──────────┐
      │ syscall │  │  signal  │  │   net    │ (未启用)
      └────┬────┘  └────┬─────┘  └────┬─────┘
           │            │             │
      ┌────▼────────────▼─────────────▼────┐
      │              task                  │ (进程/线程)
      └────┬──────────────┬───────────────┘
           │              │
    ┌──────▼──────┐  ┌────▼─────┐
    │     fs      │  │   mm     │
    └──────┬──────┘  └────┬─────┘
           │              │
    ┌──────▼──────┐  ┌────▼─────┐
    │   driver    │  │  sched   │
    └──────┬──────┘  └────┬─────┘
           │              │
    ┌──────▼──────────────▼─────┐
    │           hal             │ (硬件抽象层)
    └────────────┬──────────────┘
                 │
    ┌────────────▼──────────────┐
    │         platform          │ (平台常量)
    └───────────────────────────┘
```

---

## 四、子系统粗粒度分析

### 4.1 硬件抽象层（`hal` + `platform`）

- `platform` crate 通过 `#[cfg(target_arch + feature)]` 在编译期选择平台常量，支持 4 种配置：`riscv64-qemu`、`riscv64-vf2`（VisionFive 2）、`loongarch64-qemu`、`loongarch64-laptop`（2K1000）。
- `hal` crate 定义了 7 个架构无关 trait（`ArchInfo`、`ArchMemory`、`ArchTrap`、`ArchInt`、`ArchTime`、`ArchBoot`、`ArchAsyncSupport`），由 `rv64` 和 `la64` 模块分别实现。上层通过 `hal::Arch` 类型别名引用当前架构实现。

### 4.2 内存管理（`mm`）

- **物理页分配**：基于位图的 `FrameAllocator`，带引用计数。
- **页表**：支持 Sv39（RISC-V）和 LA64 三级页表，提供 `map`/`unmap`/`translate`/`ensure_user_write` 等操作。
- **地址空间**：`AddressSpace` 封装 satp/PGDL token。
- **COW**：写时复制支持，使用软件定义 COW 标志位（RISC-V bit 8，LA64 bit 9）。
- **ELF 加载**：解析 ELF header、映射 LOAD 段、构造 auxv。
- **共享内存**：匿名共享页和 SysV shm 接口。
- **内核堆**：基于 `linked_list_allocator` 实现。
- **Slab 分配器**：用于内核对象缓存。

### 4.3 进程/线程管理（`task` + `sched`）

- **`sched` crate**：提供异步运行时框架——`Runtime` 单例 + `SimpleScheduler`（当前为 FIFO），支持 `spawn`/`block_on`/`yield_now`/`timeout`/`sleep`/`Event`，以及 SMP work-stealing。
- **`task` crate**：经典 UNIX 进程模型——`Process`（PCB）含 pid、地址空间、文件描述符表、信号管理器；`Thread`（TCB）含 tid、内核栈、trap 上下文；支持 `fork`（`sys_clone`）、`execve`、`exit`/`exit_group`、`wait4`/`waitid`、`futex`、进程组、会话、资源限制（rlimit）。

### 4.4 文件系统（`fs`）

- **VFS 层**：定义统一的 `File`/`Inode`/`SuperBlock` trait，含路径解析、挂载点管理。
- **EXT4**：完整的磁盘文件系统读写实现（super block、inode、block cache、page cache、写回刷新）。
- **RamFS**：纯内存文件系统，用于 `/tmp` 等场景。
- **ProcFS**：`/proc` 虚拟文件系统，可列出进程信息。
- **DevFS**：`/dev` 设备文件系统。
- **SocketFS**：套接字文件系统。
- 此外包含：`pipe`（管道）、`fd_table`（fd 表）、`io_buffer`（I/O 缓冲）等。

### 4.5 设备驱动（`driver`）

- **驱动框架**：总线抽象（virtio-mmio / PCI）、设备注册宏（`linkme`）、设备管理器。
- **块设备**：`ramdisk`（内存模拟）、`virtio-blk`（MMIO 和 PCI 两种传输方式）。
- **字符设备**：NS16550A 串口驱动（UART 输出）。
- **中断控制器**：PLIC（RISC-V 平台级中断控制器）。
- **网络设备**：`virtio-net`（探测框架已就位）。
- **设备探测**：支持 Device Tree（FDT）和 PCI 枚举两种方式。

### 4.6 系统调用（`syscall`）

- 集中分发：`handle_syscall` 根据 syscall 编号分发到各领域实现。
- 分类：`fs`（文件操作）、`io`（读写）、`mm`（brk/mmap/munmap）、`net`（socket）、`signal`（kill/sigaction）、`task`（clone/exec/wait）、`time`（gettimeofday/nanosleep）、`system`（uname/getpid）、`shm`（共享内存）。
- 约 **110 个系统调用**（基于 `consts.rs` 中的编号和分发表）。

### 4.7 信号（`signal`）

- 完整的 POSIX 信号机制：`sigaction`（注册 handler）、`sigprocmask`（阻塞/解除）、`kill`/`tkill`（发送信号）、`sigreturn`（信号返回 trampoline）。
- 信号传递通过 trampoline 帧在用户栈上构造返回上下文。

### 4.8 网络（`net`，当前未启用）

- 基于 smoltcp 协议栈，提供 TCP/UDP/Raw socket。
- Async socket I/O（`socket_future`）、poll/select stub。
- 当前在 workspace `Cargo.toml` 中被注释，标注"等网络栈实现后再启用"。

### 4.9 用户态（`user/`）

- **libc**：包含 `crt0.rs`（`_start` 入口，初始化栈、argc/argv、调用 `main`）和 `syscall.rs`（syscall 封装）。
- **user_init**：第一个用户进程，集成了多种测试用例（LTP、cyclictest、iperf、netperf、lmbench 等），分别针对 RISC-V 和 LoongArch。
- **exec_test**：exec 系统调用测试。

---

## 五、构建工具需求

根据 `Makefile` 和 `rust-toolchain.toml` 分析，构建该项目需要：

| 工具类型 | 具体工具 | 用途 |
|---------|---------|------|
| Rust 工具链 | `rustc`、`cargo`（nightly-2025-05-20） | 编译内核和用户程序 |
| Rust 组件 | `rust-src`、`clippy`、`llvm-tools-preview`、`rustfmt` | 标准库源码、lint、LLVM 工具 |
| RISC-V 目标 | `riscv64gc-unknown-none-elf` | RISC-V 64 裸机目标 |
| LoongArch 目标 | `loongarch64-unknown-none` | LoongArch 64 裸机目标 |
| GNU Make | `make` | 构建编排 |
| Rust objcopy | `rust-objcopy` (来自 `cargo-binutils`) | 生成 RISC-V 裸二进制 |
| QEMU | `qemu-system-riscv64`、`qemu-system-loongarch64` | 模拟运行 |
| 外部 crate | `smoltcp`、`bitflags`、`spin`、`linkme`、`fdt`、`linked_list_allocator` | Rust 依赖（Cargo 自动获取）|

用户态程序通过 `user/Makefile` 独立构建，使用 `riscv64`/`loongarch64` Linux musl 交叉编译工具链（bootlin）编译用户程序，产物嵌入内核镜像（通过 `kernel/build.rs` 生成 `link_apps.S`）。

---

## 六、初步判断总结

1. **架构设计清晰**：采用分层 workspace 结构，依赖方向自底向上（platform → hal → mm/sched → task/fs/driver → syscall/signal → kernel），模块边界明确。
2. **双架构支持**：通过 HAL trait + cfg 编译期选择，RISC-V 和 LoongArch 共享上层全部逻辑。
3. **功能覆盖较全**：涵盖内存管理、进程/线程调度、VFS+多种文件系统、设备驱动框架、约 110 个系统调用、POSIX 信号、网络栈（预留），具备一个可用的宏内核基本形态。
4. **构建系统**：`Makefile` 驱动 `cargo build`，用户态程序嵌入内核 ELF，通过 QEMU 运行。`net` crate 暂未启用。`configs/` 和 `scripts/` 目录当前多为空文件，尚待完善。