## 一、项目概述

StarryOS（VegarOS）是一个基于 ArceOS 组件化 unikernel 基底、使用 Rust 语言编写的 Linux 兼容宏内核。项目面向 OS 竞赛（OSComp / OSCamp），实现了 210+ 条与 Linux 兼容的系统调用，支持 **RISC-V 64**、**LoongArch64**、**AArch64** 三种架构，可直接运行为 Linux 编译的用户态程序（如 BusyBox）。

---

## 二、顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `kernel/` | 宏内核核心逻辑（StarryOS 自有代码，~18K 行 Rust） |
| `src/` | 根 crate 入口（`main.rs`）及初始化脚本 |
| `vendor/` | 完全 vendored 的第三方 Rust 依赖（含 ArceOS 全家桶 `ax*` 组件） |
| `make/` | 构建系统辅助（Makefile 片段：平台解析、QEMU 运行、特性开关） |
| `Makefile` | 顶层构建入口（ARCH、bus、test mode 等变量驱动） |
| `Cargo.toml` | workspace 根 manifest（成员仅 `kernel`） |
| `tools/` | 构建辅助工具：`axconfig-gen`（生成平台配置）、`cargo-axplat` |
| `scripts/` | CI 测试、构建验证、固件烧写脚本 |
| `docs/` | 项目文档、架构图、评测记录 |
| `patches/` | 针对 `axfs-ng` 的补丁（定制化修改） |
| `.github/workflows/` | CI 流水线（oscomp-build-test） |

---

## 三、子系统划分

### 3.1 入口与初始化

- **`src/main.rs`**（~20 行）：`#![no_std]` 入口，解析命令行参数后调用 `starry_kernel::entry::init`。
- **`kernel/src/entry.rs`**（~100 行）：挂载伪文件系统、加载 init 进程 ELF、建立用户地址空间、创建首个用户任务。

### 3.2 系统调用（`kernel/src/syscall/`，~7900 行，最大子系统）

通过 `mod.rs` 中 `handle_syscall()` 统一分发，实现 **211 条** syscall。按功能分为：

| 子模块 | 文件数 | 功能 |
|---|---|---|
| `syscall/fs/` | 11 | 文件/目录操作、挂载、stat、fcntl、sendfile、splice、copy_file_range 等 |
| `syscall/task/` | 10 | clone/fork/execve/exit/wait、prctl、capget/set 等 |
| `syscall/net/` | 7 | socket/bind/connect/accept/sendmsg/recvmsg 等 BSD socket API |
| `syscall/mm/` | 4 | brk、mmap/munmap/mprotect、mincore |
| `syscall/io_mpx/` | 4 | epoll、poll/ppoll、select/pselect |
| `syscall/ipc/` | 3 | System V 消息队列(msg*)、共享内存(shm*) |
| `syscall/sync/` | 3 | futex、membarrier |
| `syscall/time.rs` | 1 | gettimeofday、clock_gettime、times、timer |
| `syscall/signal.rs` | 1 | kill/tkill、sigaction/sigprocmask/sigreturn 等 POSIX 信号 |
| `syscall/sys.rs` | 1 | uname、sysinfo、getrandom、reboot、get/set uid/gid 等 |
| `syscall/resources.rs` | 1 | get/set priority、prlimit64 |

### 3.3 任务管理（`kernel/src/task/`，~1700 行）

三层任务抽象，管理进程/线程生命周期：

- `mod.rs`：`Thread`/`ProcessData` 结构定义、全局进程表
- `ops.rs`：任务操作（spawn、join）
- `signal.rs`：信号队列与处理逻辑
- `futex.rs`：内核态 futex 等待队列
- `resources.rs`：进程资源限制
- `stat.rs`：进程统计信息
- `timer.rs`：进程级定时器
- `user.rs`：用户态上下文管理

### 3.4 内存管理（`kernel/src/mm/`，~2200 行）

用户地址空间管理：

- `aspace/`：地址空间抽象 (`AddrSpace`)，四种映射后端：
  - `linear.rs`：线性映射
  - `cow.rs`：写时复制映射
  - `shared.rs`：共享映射
  - `file.rs`：文件映射（mmap 文件）
- `access.rs`：跨内核-用户边界内存读写
- `io.rs`：用户空间 I/O 操作
- `loader.rs`：ELF 加载器

### 3.5 文件描述符层（`kernel/src/file/`，~1700 行）

统一文件描述符表与类文件对象：

- `mod.rs`：`FD_TABLE`、`FileLike` trait 实现
- `fs.rs`：文件操作（open/read/write 的内核侧）
- `epoll.rs`：epoll 事件通知机制
- `event.rs`：eventfd
- `pipe.rs`：匿名管道
- `net.rs`：socket 文件描述符
- `pidfd.rs`：pidfd
- `signalfd.rs`：signalfd

### 3.6 伪文件系统（`kernel/src/pseudofs/`，~4100 行）

内存文件系统实现，提供类 Linux 的虚拟文件系统树：

- `dev/`：设备文件节点：
  - `tty/`：完整 TTY 子系统（`ntty`、`ptm/pts`、`terminal` 行规程与作业控制）
  - `fb.rs`：framebuffer
  - `rtc.rs`：实时时钟
  - `event.rs`：事件设备
  - `log.rs`：日志设备
  - `loop.rs`：loop 设备
  - `memtrack.rs`：内存追踪
- `proc.rs`：procfs
- `tmp.rs`：tmpfs
- `dir.rs`/`file.rs`/`device.rs`/`fs.rs`：伪文件系统的通用 VFS 框架

### 3.7 架构配置（`kernel/src/config/`，~120 行）

按架构条件编译：`riscv64.rs`、`loongarch64.rs`、`aarch64.rs`、`x86_64.rs`。

### 3.8 时间管理（`kernel/src/time.rs`，~130 行）

时间相关常量与辅助函数。

---

## 四、依赖的 ArceOS 组件（vendored）

项目基于 ArceOS 组件化 unikernel 构建，核心依赖包括：

| 组件 | 用途 |
|---|---|
| `axhal` | 硬件抽象层（跨架构） |
| `axruntime` | 运行时初始化 |
| `axmm` | 物理/虚拟内存管理 |
| `axtask` | 任务调度（Round-Robin） |
| `axfs` / `axfs-ng` / `axfs-ng-vfs` | 文件系统（FAT32、Ext4 只读、虚拟文件系统） |
| `axnet` / `axnet-ng` / `starry-smoltcp` | 网络协议栈（TCP/UDP） |
| `axdriver` 系列 | VirtIO 块/网设备驱动（MMIO/PCI） |
| `axalloc` | 内核内存分配器（slab） |
| `axsync` | 同步原语 |
| `axlog` | 日志框架 |
| `axfeat` | 功能开关/特性门控 |
| `starry-process` / `starry-signal` / `starry-vm` | Starry 特化组件（进程模型、信号、虚拟内存） |
| `axplat-*` | 平台定义（riscv64-qemu-virt、loongarch64-qemu-virt、visionfive2 等） |

---

## 五、构建工具需求

根据 `rust-toolchain.toml` 和 `Makefile`：

| 工具 | 说明 |
|---|---|
| **Rust nightly-2026-02-25** | 固定 nightly 版本（备选 fallback：nightly-2025-05-20） |
| **rust-src**、**llvm-tools**、**rustfmt**、**clippy** | rustup 组件 |
| **交叉编译目标** | `riscv64gc-unknown-none-elf`、`loongarch64-unknown-none-softfloat`、`aarch64-unknown-none-softfloat` |
| **axconfig-gen** | 自研工具（`tools/axconfig-gen/`），用于生成平台配置 `.axconfig.toml`，构建时自动编译 |
| **QEMU** | 模拟运行（RISC-V / LoongArch / AArch64），通过 `make/qemu.mk` 驱动 |
| **GNU Make** | 顶层构建编排 |
| **Cargo** | Rust 构建（支持完全离线 vendor 模式） |
| **curl / xz** | 下载根文件系统镜像（可选） |

---

## 六、总体印象

1. **代码规模**：核心逻辑约 **18,000 行** Rust 代码，其中系统调用分发与实现占比最大（~44%），伪文件系统次之（~23%）。
2. **架构**：严格的分层设计——用户接口层（系统调用）→ 内核核心（进程/内存/文件）→ ArceOS 组件层 → 硬件抽象层。
3. **成熟度**：已实现丰富的 Linux 兼容系统调用集（文件系统、网络、信号、IPC、进程管理），支持 LTP 测试套件验证，有完整的 CI 流程。
4. **构建系统**：通过 Makefile 封装 Cargo，支持多架构灵活切换，支持完全离线构建（vendored dependencies）。