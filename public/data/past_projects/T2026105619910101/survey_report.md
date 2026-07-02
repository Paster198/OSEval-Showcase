## 项目结构分析报告

### 一、项目概述

该项目为 **StarryOS**（团队名 Minux，来自华南理工大学未来技术学院），是一个基于 **ArceOS unikernel** 构建的**实验性宏内核（Monolithic Kernel）**，目标是提供 Linux 兼容的系统调用接口。项目采用 Rust 编写，使用 Cargo 工作空间管理。

---

### 二、顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `kernel/` | 内核核心 crate（`starry-kernel`），实现宏内核主体逻辑 |
| `src/` | 可执行入口（`main.rs`）+ 用户态初始化脚本（shell脚本） |
| `third_party/` | 本地修改/覆盖的第三方 crate（ArceOS组件、starry-vm等） |
| `vendor/` | 依赖的 vendored crate（340个），涵盖 ArceOS 生态系统及通用 Rust 库 |
| `configs/` | 平台配置文件（链接脚本、硬件参数、构建设置） |
| `make/` | 构建系统 Makefile 片段 |
| `scripts/` | 辅助脚本（测试、CI、镜像生成、烧写） |
| `rootfs-source/` | 根文件系统源材料（`riscv64/` 和 `loongarch64/` 的 busybox + musl） |
| `benchmarks/` | 基准测试 C 程序（系统调用、调度、IPv6、timerfd 等） |
| `docs/` | 文档（x11.md） |
| `reports/` | 项目报告 |
| `.github/` | CI 工作流与 Issue/PR 模板 |

---

### 三、子系统划分

#### 1. 系统调用层 —— `kernel/src/syscall/`

系统调用的核心分发与实现，共约 **224 个系统调用**。按功能分为以下子模块：

| 子模块 | 文件 | 功能 |
|---|---|---|
| **文件系统** | `fs/ctl.rs`, `fs/fd_ops.rs`, `fs/io.rs`, `fs/stat.rs`, `fs/mount.rs`, `fs/memfd.rs`, `fs/pipe.rs`, `fs/event.rs`, `fs/pidfd.rs`, `fs/signalfd.rs`, `fs/timerfd.rs` | 文件操作、挂载、stat、memfd、管道、事件通知等 |
| **任务管理** | `task/clone.rs`, `task/clone3.rs`, `task/execve.rs`, `task/exit.rs`, `task/wait.rs`, `task/ctl.rs`, `task/schedule.rs`, `task/thread.rs`, `task/job.rs` | 进程创建(clone/fork)、程序执行(execve)、退出、等待、调度、线程控制、作业控制 |
| **内存管理** | `mm/mmap.rs`, `mm/brk.rs`, `mm/mincore.rs` | mmap/munmap/mprotect、brk 堆管理、mincore |
| **网络** | `net/socket.rs`, `net/io.rs`, `net/addr.rs`, `net/opt.rs`, `net/name.rs`, `net/cmsg.rs` | socket 创建、收发、地址管理、套接字选项、控制消息 |
| **同步** | `sync/futex.rs`, `sync/membarrier.rs` | futex、内存屏障 |
| **IPC** | `ipc/msg.rs`, `ipc/shm.rs` | System V 消息队列、共享内存 |
| **I/O 多路复用** | `io_mpx/epoll.rs`, `io_mpx/poll.rs`, `io_mpx/select.rs` | epoll、poll、select |
| **信号** | `signal.rs` | 信号发送、处理、掩码管理 |
| **时间** | `time.rs` | 时钟获取、定时器、纳秒睡眠 |
| **BPF** | `bpf.rs` | Berkeley Packet Filter 系统调用 |
| **系统信息** | `sys.rs` | uname、sysinfo 等 |
| **资源管理** | `resources.rs` | getrlimit/setrlimit、prctl 等 |

#### 2. 任务管理系统 —— `kernel/src/task/`

| 文件 | 功能 |
|---|---|
| `mod.rs` | 核心数据结构：`Thread`（线程）、`ProcessData`（进程共享数据，含地址空间、信号、futex表、资源限制等） |
| `ops.rs` | 任务操作（ID 分配、任务查找） |
| `futex.rs` | 内核态 futex 等待队列 |
| `signal.rs` | 信号传递与检查逻辑 |
| `timer.rs` | 定时器管理（用户态 alarm/timer） |
| `stat.rs` | 进程统计信息（rusage） |
| `resources.rs` | 资源限制管理 |
| `user.rs` | 用户任务创建辅助 |

#### 3. 内存管理系统 —— `kernel/src/mm/`

| 文件/目录 | 功能 |
|---|---|
| `aspace/mod.rs` | 地址空间抽象 (`AddrSpace`)，管理 VMA 集合 |
| `aspace/backend/linear.rs` | 线性映射后端（堆、栈等） |
| `aspace/backend/file.rs` | 文件映射后端（mmap FILE） |
| `aspace/backend/cow.rs` | 写时复制后端 |
| `aspace/backend/shared.rs` | 共享内存后端 |
| `access.rs` | 用户空间内存安全读写（跨地址空间拷贝） |
| `loader.rs` | ELF 加载器，加载用户程序到地址空间 |
| `io.rs` | 内存映射 I/O |

#### 4. 文件系统 —— `kernel/src/file/`

| 文件 | 功能 |
|---|---|
| `mod.rs` | `FileLike` trait（统一文件抽象）、文件描述符表 `FD_TABLE`、`Kstat` |
| `fs.rs` | 常规文件操作实现 |
| `net.rs` | Socket 文件抽象（`PacketSocket`, `RawIpv6Socket`） |
| `pipe.rs` | 管道 |
| `epoll.rs` | epoll 文件描述符 |
| `event.rs` | eventfd |
| `pidfd.rs` | pidfd |
| `signalfd.rs` | signalfd |
| `timerfd.rs` | timerfd |

#### 5. 伪文件系统 —— `kernel/src/pseudofs/`

| 文件/目录 | 功能 |
|---|---|
| `mod.rs` | 伪文件系统框架，挂载 `/dev`, `/dev/shm`, `/tmp`, `/proc`, `/sys` |
| `proc.rs` | `/proc` 文件系统（进程信息、系统信息） |
| `tmp.rs` | 内存文件系统 (`MemoryFs`) |
| `dev/mod.rs` | `/dev` 设备文件系统 |
| `dev/tty/` | TTY 子系统（终端、行规程 termios、作业控制、PTY master/slave） |
| `dev/fb.rs` | 帧缓冲设备 |
| `dev/log.rs` | 日志设备 |
| `dev/loop.rs` | loop 设备 |
| `dev/rtc.rs` | RTC 设备 |
| `dev/event.rs` | 输入事件设备 |
| `dev/memtrack.rs` | 内存追踪设备 |

#### 6. 架构配置 —— `kernel/src/config/`

为 `riscv64`、`loongarch64`、`x86_64`、`aarch64` 提供架构特定的常量（如 `USER_HEAP_BASE`、`SIGNAL_TRAMPOLINE` 等）。

#### 7. 底层能力（由 `third_party/` 和 `vendor/` 提供）

这些 crate 构成了该宏内核的硬件抽象与基础服务层，源自 ArceOS 生态系统：

| Crate | 功能 |
|---|---|
| `axhal` | 硬件抽象层（异常、中断、上下文切换、电源管理） |
| `axmm` | 物理内存管理、页表操作 |
| `axruntime` | 运行时初始化 |
| `axtask` / `axsched` | 任务调度（RR + RT） |
| `axdriver` 系列 | 设备驱动（VirtIO block/net/gpu/input/vsock、PCI） |
| `axfs` / `axfs-ng-vfs` | 文件系统框架、VFS |
| `axnet-ng` | 网络协议栈 |
| `axdisplay` / `axinput` | 显示与输入 |
| `starry-vm` | 虚拟内存管理原语（VmPtr, VmMutPtr） |
| `starry-process` | 进程抽象（PID管理） |
| `starry-signal` | 信号框架 |
| `lwext4_rust` | ext4 文件系统（C库 Rust 绑定） |
| `kernel-elf-parser` | ELF 解析 |
| `axio` | I/O 抽象 |
| `axplat-*` | 平台定义（riscv64-qemu-virt, loongarch64-qemu-virt 等） |

---

### 四、构建系统

- **主构建工具**：GNU Make（顶层 `Makefile` + `make/` 子目录）
- **Rust 构建**：Cargo（nightly-2025-05-20），workspace 模式
- **交叉编译目标**：
  - `riscv64gc-unknown-none-elf`
  - `loongarch64-unknown-none-softfloat`
  - `aarch64-unknown-none-softfloat`
  - `x86_64-unknown-none`
- **C 交叉编译**：musl 工具链（如 `riscv64-linux-musl-gcc`），用于编译 rootfs 中的用户程序
- **模拟器**：QEMU（RISC-V、LoongArch、AArch64、x86）
- **其他工具**：Python（测试脚本）、dtc（设备树）、mkfs/cpio（文件系统镜像）
- **链接器**：rust-lld（GNU flavor），自定义链接脚本位于 `configs/`

---

### 五、初步评估总结

该项目是一个结构清晰、模块化良好的 Linux 兼容宏内核。它以 ArceOS unikernel 的硬件抽象层和驱动框架为基础，在其上构建了完整的 Linux 系统调用接口层。核心子系统（系统调用、任务管理、内存管理、文件系统、伪文件系统）组织合理，代码总计约 9000 行（kernel 部分），覆盖了约 224 个 Linux 系统调用，是比赛项目中功能较为完整的作品。