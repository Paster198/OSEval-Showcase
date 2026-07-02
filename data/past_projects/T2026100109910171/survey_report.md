## StarryOS 项目初步分析报告

### 一、项目概况

StarryOS 是一个基于 ArceOS unikernel 构建的**实验性宏内核（monolithic kernel）**，全部使用 Rust 语言编写。其目标是提供 Linux 兼容的系统调用接口，支持运行 Linux 用户态程序。项目以 Cargo workspace 形式组织，支持 RISC-V 64、LoongArch64、AArch64 三种架构（x86_64 尚在开发中）。

### 二、仓库文件组织结构

```
(repo root)/
├── Cargo.toml              # Workspace 清单，workspace 成员: kernel/
├── Cargo.lock
├── Makefile                # 顶层构建入口，封装 make/ 下的构建逻辑
├── rust-toolchain.toml     # 指定 Rust nightly-2026-02-25
├── rustfmt.toml
│
├── kernel/                 # [核心] 内核 crate (starry-kernel)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # 内核库入口，声明所有子系统模块
│       ├── entry.rs        # 内核初始化与 init 进程启动
│       ├── config/         # 架构相关常量定义 (riscv64/loongarch64/x86_64/aarch64)
│       ├── syscall/        # 系统调用层
│       ├── task/           # 任务/进程/线程管理
│       ├── mm/             # 内存管理 (地址空间、mmap、COW、ELF 加载)
│       ├── file/           # 文件抽象层 (File/Socket/Pipe/Epoll/Event 等)
│       ├── pseudofs/       # 伪文件系统 (/dev, /proc, /tmp 等)
│       └── time.rs         # 时间工具
│
├── src/                    # 用户态入口 (bin crate: starryos)
│   ├── main.rs             # #![no_std] 入口，调用 kernel entry
│   └── init.sh             # 嵌入的 init shell 脚本
│
├── deps/                   # 本地 fork/补丁依赖
│   └── starry-process/     # 进程管理库 (Process, ProcessGroup, Session)
│
├── configs/platforms/      # 平台硬件配置 (.toml)
│   ├── riscv64-qemu-virt.toml
│   └── loongarch64-qemu-virt.toml
│
├── make/                   # 构建系统 (GNU Make)
│   ├── Makefile            # 主 Makefile (参数解析、目标定义)
│   ├── build.mk            # 构建脚本
│   ├── cargo.mk            # Cargo 调用封装
│   ├── config.mk           # 配置生成
│   ├── features.mk         # feature 解析
│   ├── platform.mk         # 平台解析
│   ├── qemu.mk             # QEMU 启动规则
│   ├── deps.mk             # 依赖安装
│   ├── utils.mk            # 工具函数
│   └── dwarf.sh            # DWARF 调试信息处理
│
├── scripts/
│   ├── test.sh             # 多步骤测试脚本
│   ├── ci-test.py          # CI 测试
│   └── flash.sh            # 烧录脚本
│
├── docs/
│   ├── competition-compliance.md
│   └── x11.md
│
├── bin/                    # 辅助工具 (如 axconfig-gen)
├── kernel-rv               # 预构建的 RISC-V 内核镜像
└── 设计文档/PPT/视频等
```

### 三、子系统划分

根据 `kernel/src/lib.rs` 的模块声明及代码目录结构，内核划分为以下 **7 个子系统**：

#### 1. 系统调用层 (`syscall/`) — Linux ABI 兼容接口

这是代码量最大的子系统。按功能进一步分为：

| 子模块 | 对应目录 | 功能 |
|--------|---------|------|
| `syscall::fs` | `syscall/fs/` | 文件系统相关系统调用：open/close/read/write/stat/mount/chdir/getdents64 等 |
| `syscall::io_mpx` | `syscall/io_mpx/` | I/O 多路复用：epoll、poll、select |
| `syscall::ipc` | `syscall/ipc/` | System V IPC：消息队列(msg)、共享内存(shm) |
| `syscall::mm` | `syscall/mm/` | 内存管理系统调用：mmap/munmap/brk/mincore |
| `syscall::net` | `syscall/net/` | 网络系统调用：socket/bind/listen/accept/send/recv 等 |
| `syscall::sync` | `syscall/sync/` | 同步原语：futex、membarrier |
| `syscall::task` | `syscall/task/` | 进程/线程系统调用：clone/clone3/execve/exit/wait/prctl 等 |
| `syscall::signal` | `syscall/signal.rs` | 信号处理系统调用 |
| `syscall::resources` | `syscall/resources.rs` | 资源限制 (prlimit64) |
| `syscall::time` | `syscall/time.rs` | 时间相关系统调用 |
| `syscall::sys` | `syscall/sys.rs` | 通用系统信息 (uname 等) |

系统调用入口 `handle_syscall()` 位于 `syscall/mod.rs`，通过 `Sysno` 枚举匹配约 150+ 个 Linux 系统调用号。

#### 2. 任务管理 (`task/`) — 进程、线程、信号、定时器

| 子模块 | 路径 | 功能 |
|--------|------|------|
| `task::*` | `task/mod.rs` | `Thread` 结构体、`ProcessData` 结构体、任务扩展 trait |
| `task::signal` | `task/signal.rs` | 信号检查与分发 (`check_signals`) |
| `task::futex` | `task/futex.rs` | 进程级 futex 表 |
| `task::posix_timer` | `task/posix_timer.rs` | POSIX 定时器 |
| `task::timer` | `task/timer.rs` | 通用定时器管理 |
| `task::resources` | `task/resources.rs` | 资源限制 (RLIMIT) |
| `task::stat` | `task/stat.rs` | 进程统计信息 |
| `task::user` | `task/user.rs` | 用户态任务创建 |
| `task::ops` | `task/ops.rs` | 任务操作辅助 |

依赖外部 crate：`starry-process`（进程/进程组/会话）、`starry-signal`（信号管理）、`starry-vm`（用户态内存访问）。

#### 3. 内存管理 (`mm/`) — 用户地址空间

| 子模块 | 路径 | 功能 |
|--------|------|------|
| `mm::aspace` | `mm/aspace/` | 地址空间抽象 (`AddrSpace`)，支持多种后端 |
| `mm::aspace::backend::linear` | | 线性映射后端 |
| `mm::aspace::backend::cow` | | 写时复制 (COW) 后端 |
| `mm::aspace::backend::file` | | 文件映射后端 |
| `mm::aspace::backend::shared` | | 共享内存后端 |
| `mm::loader` | `mm/loader.rs` | ELF 加载器、信号蹦床映射 |
| `mm::access` | `mm/access.rs` | 用户态内存安全访问 |
| `mm::io` | `mm/io.rs` | 用户态 I/O 缓冲操作 |

#### 4. 文件抽象层 (`file/`) — 统一的文件接口

| 子模块 | 路径 | 功能 |
|--------|------|------|
| `file::*` | `file/mod.rs` | `FileLike` trait、文件描述符表 (`FD_TABLE`)、`Kstat` |
| `file::fs` | `file/fs.rs` | 磁盘文件 (`File`, `Directory`) |
| `file::net` | `file/net.rs` | Socket 封装 |
| `file::pipe` | `file/pipe.rs` | 管道 |
| `file::epoll` | `file/epoll.rs` | epoll 文件描述符 |
| `file::event` | `file/event.rs` | eventfd |
| `file::pidfd` | `file/pidfd.rs` | pidfd |
| `file::signalfd` | `file/signalfd.rs` | signalfd |
| `file::timerfd` | `file/timerfd.rs` | timerfd |

通过 `FileLike` trait 提供统一的 `read/write/stat/ioctl/poll` 接口，所有文件类型（普通文件、socket、管道、epoll、eventfd 等）均实现该 trait。

#### 5. 伪文件系统 (`pseudofs/`) — /dev, /proc, /tmp 等

| 子模块 | 路径 | 功能 |
|--------|------|------|
| `pseudofs::*` | `pseudofs/mod.rs` | 挂载入口 (`mount_all`)，挂载 devfs/procfs/tmpfs |
| `pseudofs::dev` | `pseudofs/dev/` | `/dev` 设备文件：tty、fb、rtc、loop、log、event 等 |
| `pseudofs::dev::tty` | `pseudofs/dev/tty/` | TTY 子系统：终端、线路规程、termios、作业控制 |
| `pseudofs::proc` | `pseudofs/proc.rs` | `/proc` 伪文件系统 |
| `pseudofs::tmp` | `pseudofs/tmp.rs` | 内存文件系统 (tmpfs) |
| `pseudofs::fs` | `pseudofs/fs.rs` | 伪文件系统框架 |
| `pseudofs::file` | `pseudofs/file.rs` | 伪文件节点 |
| `pseudofs::dir` | `pseudofs/dir.rs` | 伪目录节点 |
| `pseudofs::device` | `pseudofs/device.rs` | 设备号管理 |

#### 6. 架构配置 (`config/`) — 平台相关常量

为每种架构定义内核栈大小、用户空间布局、信号蹦床地址等常量。当前支持 RISC-V 64、LoongArch64、x86_64、AArch64。

#### 7. 入口 (`entry.rs`) — 内核初始化

负责：
- 挂载所有伪文件系统
- 解析 init 程序路径
- 创建用户地址空间
- 加载 ELF 可执行文件
- 创建 init 进程并启动调度

### 四、依赖关系总览

内核依赖 ArceOS 生态的一系列底层 crate：

| 依赖 crate | 提供的功能 |
|-----------|----------|
| `axhal` | 硬件抽象层（中断、分页、用户上下文） |
| `axmm` | 内核态内存管理（页表、内核地址空间） |
| `axalloc` | 内核内存分配器 |
| `axtask` | 任务调度框架 |
| `axsync` | 同步原语（Mutex 等） |
| `axdriver` | 设备驱动框架 |
| `axfs` / `axfs-ng-vfs` | 文件系统/VFS 框架 |
| `axnet` | 网络协议栈 |
| `axconfig` | 平台配置 |
| `axfeat` | 特性开关 |
| `axruntime` | 运行时初始化 |
| `axdisplay` | 显示支持 |
| `axinput` | 输入设备 |
| `axlog` | 日志 |
| `starry-process` | 进程管理抽象 |
| `starry-signal` | 信号管理 |
| `starry-vm` | 用户态内存安全访问 |

### 五、编译构建工具需求

根据 `Makefile`、`rust-toolchain.toml`、`scripts/test.sh` 分析：

| 工具 | 用途 | 备注 |
|------|------|------|
| **Rust nightly-2026-02-25** | 编译器 | 需要 `llvm-tools` 组件 |
| **Cargo** | Rust 构建系统 | 随 Rust 一起安装 |
| **GNU Make** | 顶层构建编排 | |
| **Python 3** | CI 测试脚本 | |
| **RISC-V musl 交叉编译工具链** | C 代码交叉编译 | `riscv64-linux-musl-gcc` 等 |
| **rust-lld** | 链接器 | 通过 `-C link-arg=...` 传递 |
| **rust-objcopy / rust-objdump** | 二进制处理 | 来自 `cargo-binutils` |
| **QEMU** | 模拟运行 | `qemu-system-riscv64`、`qemu-system-loongarch64` |
| **mkimage** (U-Boot) | U-Boot 镜像生成（可选） | AArch64 平台 |
| **axconfig-gen** | 配置生成 | 已预编译在 `bin/` 中 |

构建流程概要：
1. `make defconfig` → 生成 `.axconfig.toml`
2. `make build` → `cargo build --target riscv64gc-unknown-none-elf --release`
3. `rust-objcopy` 将 ELF 转为 raw binary
4. `make run` → QEMU 启动内核 + rootfs 磁盘镜像