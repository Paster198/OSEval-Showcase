## StarryOS 项目初步调查报告

### 一、项目概述

StarryOS 是一个基于 **ArceOS unikernel** 框架构建的 **Linux 兼容型 OS 内核**，使用 Rust 编写。其目标是在保持 ArceOS 组件化架构的同时，提供 Linux 系统调用接口（ABI），以支持运行 Linux 用户空间程序（包括 musl 与 glibc 链接的二进制文件）。

- **仓库地址**: https://github.com/Starry-OS/StarryOS
- **Rust 工具链**: nightly-2026-02-25
- **支持架构**: riscv64（主要）、loongarch64、x86_64、aarch64
- **代码总规模**: 约 17,634 行（仅 `kernel/src/` 目录下的 Rust 源码）

---

### 二、顶层目录结构

| 目录/文件 | 定位 |
|---|---|
| `Cargo.toml` | 工作区根清单，定义 workspace、依赖与 feature |
| `Makefile` | 顶层构建入口，封装 `make/` 中的详细构建逻辑 |
| `src/main.rs` | 最终内核镜像的入口点，调用 `kernel::entry::init()` |
| `src/init.sh` | 嵌入式初始化脚本，作为 init 进程启动，负责系统信息展示与测例执行 |
| `kernel/` | **核心内核 crate** (`starry-kernel`)，包含所有子系统实现 |
| `make/` | 构建系统（GNU Make），含平台解析、配置生成、feature 组装、QEMU 启动等 |
| `patches/` | 对上游 crate 的补丁：`axfs-ng`（文件系统改进）、`loongarch64`（启动兼容性） |
| `vendor/` | 完整的依赖 vendoring，支持离线构建 |
| `_cargo/` | 隐藏的 `.cargo/config.toml`，构建时恢复以启用 vendor 源 |
| `docs/submission/` | 比赛提交材料：设计方案 PDF/PPT、演示视频 |
| `Dockerfile` | 容器化构建环境 |
| `.axconfig.toml` (在 `make/`) | 平台硬件配置模板（以 riscv64-qemu-virt 为默认） |

---

### 三、子系统划分

#### 1. 系统调用层 (`kernel/src/syscall/`)

内核最大的子系统，负责实现 Linux 系统调用接口。按功能分为以下子模块：

| 子模块 | 主要文件 | 功能概述 |
|---|---|---|
| **fs/** | `io.rs`, `stat.rs`, `ctl.rs`, `fd_ops.rs`, `mount.rs`, `memfd.rs`, `pipe.rs`, `epoll.rs`, `event.rs`, `signalfd.rs`, `pidfd.rs` | 文件 I/O、stat、ioctl/fcntl、挂载、memfd、管道、epoll、eventfd、signalfd、pidfd |
| **io_mpx/** | `epoll.rs`, `poll.rs`, `select.rs` | I/O 多路复用 |
| **ipc/** | `msg.rs`, `shm.rs` | System V 消息队列与共享内存 |
| **mm/** | `mmap.rs`, `brk.rs`, `mincore.rs` | 内存映射、堆管理 |
| **net/** | `socket.rs`, `io.rs`, `addr.rs`, `name.rs`, `opt.rs`, `cmsg.rs` | 套接字操作 |
| **sync/** | `futex.rs`, `membarrier.rs` | futex、内存屏障 |
| **task/** | `clone.rs`, `clone3.rs`, `execve.rs`, `exit.rs`, `wait.rs`, `schedule.rs`, `thread.rs`, `ctl.rs`, `job.rs` | 进程/线程管理 |
| **根模块** | `mod.rs` (~676 行), `signal.rs`, `time.rs`, `resources.rs`, `sys.rs` | 系统调用分发、信号、定时器、资源限制、系统信息 |

#### 2. 任务管理 (`kernel/src/task/`)

进程与线程的核心数据结构与管理逻辑：

| 文件 | 功能 |
|---|---|
| `mod.rs` | `Thread`、`ProcessData` 结构体定义，任务表管理，调度集成 |
| `ops.rs` | 任务操作（创建、销毁等） |
| `futex.rs` | 内核态 futex 等待队列 |
| `signal.rs` | 信号分发与处理（依赖 `starry-signal`） |
| `stat.rs` | 任务统计信息 |
| `timer.rs` | 间隔定时器（ITIMER） |
| `user.rs` | 用户任务创建辅助 |
| `resources.rs` | 任务级资源限制 |

#### 3. 内存管理 (`kernel/src/mm/`)

用户空间地址空间管理：

| 文件/目录 | 功能 |
|---|---|
| `access.rs` | 用户空间内存安全读写 |
| `aspace/mod.rs` | 地址空间抽象 |
| `aspace/backend/cow.rs` | 写时复制后端 (~291 行) |
| `aspace/backend/file.rs` | 文件映射后端 |
| `aspace/backend/linear.rs` | 线性映射后端 |
| `aspace/backend/shared.rs` | 共享内存后端 |
| `io.rs` | 内存映射 I/O |
| `loader.rs` | ELF 可执行文件加载器 |

#### 4. 文件描述符层 (`kernel/src/file/`)

统一文件描述符抽象，封装各类文件类型：

| 文件 | 功能 |
|---|---|
| `mod.rs` | `FileDesc` 表、`Kstat` 结构 |
| `fs.rs` | 常规文件与目录封装 |
| `net.rs` | Socket 文件描述符 |
| `pipe.rs` | 匿名管道 |
| `epoll.rs` | epoll 实例 |
| `event.rs` | eventfd |
| `signalfd.rs` | signalfd |
| `pidfd.rs` | pidfd |

#### 5. 伪文件系统 (`kernel/src/pseudofs/`)

提供类 Linux 的虚拟文件系统：

| 文件/目录 | 功能 |
|---|---|
| `fs.rs`, `dir.rs`, `file.rs`, `device.rs` | VFS 节点基础设施 |
| `proc.rs` | `/proc` 伪文件系统 (~427 行) |
| `tmp.rs` | 内存文件系统 tmpfs (~462 行)，用于 `/tmp`、`/dev/shm` |
| `dev/mod.rs` | `/dev` 文件系统 (~300 行) |
| `dev/tty/` | TTY 子系统：终端线路规程、termios、作业控制、PTY 主从设备 |
| `dev/event.rs` | `/dev/event`（eventfd 设备） |
| `dev/fb.rs` | `/dev/fb0`（framebuffer） |
| `dev/log.rs` | `/dev/log` |
| `dev/loop.rs` | loop 设备 |
| `dev/memtrack.rs` | 内存追踪设备 |
| `dev/rtc.rs` | RTC 设备 |

#### 6. 架构配置 (`kernel/src/config/`)

按架构条件编译，提供架构相关常量：
- `riscv64.rs`, `loongarch64.rs`, `x86_64.rs`, `aarch64.rs`

#### 7. 其他

| 文件 | 功能 |
|---|---|
| `kernel/src/entry.rs` | 内核初始化入口：挂载伪文件系统、加载 init 程序、创建主任务 |
| `kernel/src/time.rs` | 时间相关工具 |
| `kernel/src/lib.rs` | crate 根，声明模块并引入外部依赖 |

---

### 四、依赖框架 (ArceOS 生态)

StarryOS 构建在 ArceOS 组件化 unikernel 生态之上。以下 `ax*` 系列 crate 由 ArceOS 提供：

| Crate | 职责 |
|---|---|
| `axhal` | 硬件抽象层（架构相关） |
| `axmm` | 物理/虚拟内存管理框架 |
| `axalloc` | 内核分配器（slab） |
| `axtask` | 任务调度（RR） |
| `axfs` / `axfs-ng` | 文件系统框架与 ext4 实现 |
| `axdriver` | 设备驱动框架（virtio、PCI 等） |
| `axnet` / `axnet-ng` | 网络栈 |
| `axruntime` | 运行时初始化 |
| `axconfig` / `axfeat` | 配置与 feature 管理 |
| `axsync` | 同步原语 |
| `axdisplay` / `axinput` | 显示与输入 |

StarryOS 自身开发的专用库 crate：

| Crate | 职责 |
|---|---|
| `starry-process` | 进程抽象 |
| `starry-signal` | 信号系统 |
| `starry-vm` | 虚拟机/地址空间辅助 |
| `starry-smoltcp` | 网络栈（smoltcp 适配） |

---

### 五、构建系统分析

- **顶层**：GNU Make（`Makefile` + `make/*.mk`），负责平台选择、feature 配置、交叉编译工具链设置、QEMU 启动
- **Rust 构建**：Cargo（workspace 模式），使用 `cargo build` 编译 `starryos` bin crate
- **关键 Make 目标**：
  - `make all`：分别编译 riscv64 (`kernel-rv`) 和 loongarch64 (`kernel-la`) 两个架构
  - `make run`：编译并启动 QEMU
  - `make build`：仅编译
  - `make ARCH=riscv64` / `make ARCH=loongarch64`：架构选择
- **输出产物**：`StarryOS_{platform}.bin`（原始二进制内核镜像）
- **编译所需工具链**：
  - Rust nightly（含 `rust-src`, `llvm-tools`）
  - RISC-V 与 LoongArch 裸机交叉编译 target
  - `rust-lld`（链接器）
  - `rust-objcopy`（二进制生成）
- **依赖管理**：完全 vendored（`vendor/` 目录），离线构建

---

### 六、补丁说明

| 补丁 | 用途 |
|---|---|
| `patches/axfs-ng/` | 替换上游 `axfs-ng` 的文件系统高层接口（文件读/写/查找等），约 1,484 行 |
| `patches/loongarch64/` | 修复 LoongArch QEMU 8.2 启动兼容性问题（boot.rs、axhal 构建脚本） |

---

### 七、初步评估

StarryOS 是一个结构清晰、模块化程度较高的 Linux 兼容内核。其特点包括：

1. **基于 unikernel 框架**：利用 ArceOS 的组件化设计，将传统宏内核功能集成到 unikernel 模型中
2. **覆盖子系统全面**：进程管理、内存管理、文件系统、网络、IPC、信号、TTY、伪文件系统等均已实现
3. **多架构支持**：主支持 RISC-V 和 LoongArch，兼有 x86_64 和 AArch64
4. **Linux 兼容目标明确**：通过 syscall 层实现 Linux ABI，支持运行 musl/glibc 用户程序
5. **比赛导向**：构建产物直接产出 `kernel-rv` 和 `kernel-la`，内置测试框架 (`init.sh`)，支持 LTP 等标准测试集