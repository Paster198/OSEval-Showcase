# StarryOS 项目初步调查报告

## 一、项目概述

**StarryOS** 是一个基于 ArceOS unikernel 框架构建的 Linux 兼容型宏内核，使用 Rust 语言开发。项目以 Rust workspace 形式组织，面向操作系统比赛场景，支持多架构（RISC-V、LoongArch、x86_64、AArch64），目标是提供 Linux ABI 兼容性以运行 Busybox、LTP 等用户态测试套件。

## 二、仓库顶层文件结构

```
repo/
├── Cargo.toml              # Workspace 根清单，定义 starryos 二进制 crate
├── Cargo.lock
├── Makefile                # 顶层构建编排（kernel-rv, kernel-la, rootfs 等目标）
├── rust-toolchain.toml     # Rust 工具链：nightly-2026-02-25
├── rustfmt.toml
│
├── kernel/                 # 核心内核 crate（starry-kernel）
│   ├── Cargo.toml
│   └── src/                # 内核实现代码（~20,000 行 Rust）
│
├── src/                    # 二进制入口
│   ├── main.rs             # _start -> starry_kernel::entry::init
│   └── init.sh             # 嵌入的用户态启动脚本（挂载、测试调度）
│
├── axfs-ng-local/          # axfs-ng 文件系统 crate 的本地补丁版本
│   ├── src/fs/ext4/        # ext4 文件系统实现
│   ├── src/fs/fat/         # FAT 文件系统实现
│   └── src/highlevel/      # 高层文件/目录操作 API
│
├── make/                   # ArceOS 构建系统（GNU Make）
│   ├── Makefile             # 构建主入口
│   ├── build.mk             # 构建流程
│   ├── cargo.mk             # Cargo 调用封装
│   ├── config.mk            # 配置生成
│   ├── features.mk          # feature 解析
│   ├── platform.mk          # 平台/架构解析
│   ├── qemu.mk              # QEMU 运行/调试
│   └── ...
│
├── scripts/                # 辅助脚本
│   ├── build-rootfs.sh     # 构建 Busybox 根文件系统镜像
│   ├── ci-test.py          # CI 测试
│   ├── local-oscomp-eval.sh
│   ├── test.sh / test-all.sh
│   └── wrap_kernel_as_elf.sh
│
├── docs/                   # 项目文档
│   ├── ARCHITECTURE.md
│   ├── TODO.md
│   ├── LTP_AI_GUIDE.md
│   ├── ltp-progress.md
│   ├── result/             # 架构测试输出
│   └── ...
│
├── busybox-1.36.1.tar.bz2  # Busybox 源码（用于根文件系统）
├── .github/                # CI 工作流
└── 内核设计文档.pdf/txt/pptx  # 设计文档
```

## 三、内核子系统划分

内核实现位于 `kernel/src/` 目录下，共约 **20,000 行 Rust 代码**，按模块组织如下：

### 3.1 系统调用层 (`syscall/`)

系统调用的分发与实现，约 **7,500 行**（含 `mod.rs` 的 703 行巨型 match 分发）：

| 子模块 | 目录 | 主要文件 | 功能 |
|--------|------|----------|------|
| 文件系统 | `syscall/fs/` | `ctl.rs`(819行), `io.rs`(437行), `fd_ops.rs`(434行), `stat.rs`, `mount.rs`, `pipe.rs`, `event.rs`, `signalfd.rs`, `pidfd.rs`, `memfd.rs` | open/read/write/close/stat/mount/ioctl 等 |
| I/O 多路复用 | `syscall/io_mpx/` | `epoll.rs`, `poll.rs`, `select.rs` | epoll/poll/select |
| 内存管理 | `syscall/mm/` | `mmap.rs`(555行), `brk.rs`, `mincore.rs` | mmap/brk/mincore |
| 任务管理 | `syscall/task/` | `clone.rs`(321行), `ctl.rs`(324行), `execve.rs`, `exit.rs`, `wait.rs`, `schedule.rs`(340行), `ptrace.rs`, `thread.rs` | clone/fork/execve/exit/wait/prctl 等 |
| 网络 | `syscall/net/` | `socket.rs`(214行), `io.rs`, `addr.rs`(268行), `opt.rs`, `name.rs`, `cmsg.rs` | socket/bind/connect/send/recv 等 |
| 信号 | `syscall/signal.rs` | 323行 | kill/tkill/sigaction/sigreturn 等 |
| 同步 | `syscall/sync/` | `futex.rs`(137行), `membarrier.rs` | futex/membarrier |
| IPC | `syscall/ipc/` | `msg.rs`(884行), `shm.rs`(568行) | SysV 消息队列/共享内存 |
| 其他 | — | `sys.rs`(319行), `time.rs`(310行), `resources.rs`, `keyring.rs`(295行) | sysinfo/uname/times/getrlimit 等 |

### 3.2 任务管理 (`task/`)

约 **1,700 行**，管理进程/线程生命周期：

- `mod.rs`(386行)：`Thread`、`ProcessData` 核心数据结构
- `ops.rs`(263行)：线程操作实现
- `signal.rs`(162行)：信号处理集成
- `futex.rs`(278行)、`timer.rs`(277行)：futex 与定时器
- `resources.rs`、`stat.rs`(169行)、`user.rs`(92行)

### 3.3 文件描述符层 (`file/`)

约 **1,500 行**，统一文件描述符表及各类文件类型：

- `mod.rs`(281行)：`FileDesc` trait、`FD_TABLE`、`Kstat` 结构
- `fs.rs`(262行)：普通文件与目录操作（基于 axfs-ng VFS）
- `net.rs`：Socket 文件描述符
- `pipe.rs`(238行)、`epoll.rs`(455行)、`event.rs`、`signalfd.rs`、`pidfd.rs`

### 3.4 内存管理 (`mm/`)

约 **1,700 行**，用户态地址空间管理：

- `aspace/mod.rs`(396行)：`AddrSpace` 地址空间
- `aspace/backend/`：页表后端——`cow.rs`(287行)、`file.rs`(253行)、`linear.rs`、`shared.rs`(110行)
- `access.rs`(413行)：用户态内存安全访问
- `loader.rs`(522行)：ELF 加载器
- `io.rs`(168行)：用户态 I/O 缓冲区操作

### 3.5 伪文件系统 (`pseudofs/`)

约 **2,800 行**，实现 Linux 风格的虚拟文件系统：

- `mod.rs`、`fs.rs`、`dir.rs`、`file.rs`、`device.rs`：框架层
- `dev/`：设备文件系统
  - `tty/`：终端子系统——`terminal/`（行规程、作业控制、termios）、`pty.rs`（伪终端）、`pts.rs`、`ptm.rs`、`ntty.rs`
  - `fb.rs`(239行)、`rtc.rs`、`loop.rs`(166行)、`event.rs`(349行)、`log.rs`、`memtrack.rs`
- `proc.rs`(494行)：procfs
- `tmp.rs`(462行)：tmpfs

### 3.6 配置 (`config/`)

各架构常量定义（每个约 25 行）：`riscv64.rs`、`loongarch64.rs`、`x86_64.rs`、`aarch64.rs`。

### 3.7 入口 (`entry.rs`)

86 行，初始化流程：挂载伪文件系统 → 加载 init 程序 → 创建进程 → 等待退出。

### 3.8 时间 (`time.rs`)

130 行，时间管理。

## 四、外部依赖框架

内核基于 **ArceOS** 组件化 unikernel 框架，依赖以下主要外部 crate：

| 依赖 | 用途 |
|------|------|
| `axhal` | 硬件抽象层（上下文切换、中断等） |
| `axmm` | 物理页分配与内核内存管理 |
| `axfs-ng` / `axfs-ng-vfs` | 文件系统与 VFS 层（本地补丁版） |
| `axtask` | 任务调度原语 |
| `axnet-ng` | 网络栈 |
| `axdriver` | 设备驱动 |
| `axsync` | 同步原语 |
| `starry-process` / `starry-signal` / `starry-vm` | StarryOS 专用进程/信号/VM crate |

## 五、构建系统与所需工具

- **Rust 工具链**：`nightly-2026-02-25`，含 `rust-src`、`llvm-tools`、`rustfmt`、`clippy`
- **交叉编译目标**：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none-softfloat`、`x86_64-unknown-none`、`aarch64-unknown-none-softfloat`
- **构建系统**：GNU Make + Cargo，ArceOS 构建框架
- **链接器**：`rust-lld`
- **根文件系统**：Busybox 1.36.1，使用交叉编译工具链（RISC-V musl / LoongArch）构建
- **QEMU**：用于模拟运行（RISC-V virt、LoongArch virt）
- **辅助工具**：`mkfs.ext4`、`mkfs.vfat`、`mcopy`、`dd`（用于镜像制作）