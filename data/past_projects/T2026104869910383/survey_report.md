## XJC-OS 项目初步调查报告

### 一、项目概述

XJC-OS 是一个基于 ArceOS 组件化框架构建的 Linux 兼容宏内核，由武汉大学"洗剪吹"团队开发，用于 2026 年全国大学生操作系统内核实现赛。项目采用 **Rust** 语言编写（no_std），目标架构为 RISC-V 64 和 LoongArch 64。

---

### 二、顶层目录结构

```
.
├── Cargo.toml              # 工作空间根配置（workspace）
├── Cargo.lock              # 依赖锁定
├── Makefile                # 顶层构建编排（双架构编译、LTP runner、vendor 等）
├── rust-toolchain.toml     # Rust nightly-2025-05-20 工具链声明
├── rustfmt.toml            # 代码格式化配置
├── .axconfig-rv.toml       # RISC-V 平台配置文件
├── .axconfig-la.toml       # LoongArch 平台配置文件
├── README.md               # 项目文档
├── run.md                  # 运行说明
│
├── src/                    # 顶层应用入口（构建 init 命令行、嵌入 init.sh）
│   ├── main.rs             # 内核 boot 后首个用户态 init 进程的构建逻辑
│   ├── init.sh             # 内嵌 Shell 初始化脚本（LTP runner 调度等）
│   └── ltp_whitelist_*.txt # LTP 测试白名单
│
├── kernel/                 # 【核心】宏内核实现
│   └── src/
│       ├── lib.rs          # 模块声明入口
│       ├── entry.rs        # 内核入口：PID 1 生命周期管理
│       ├── config/         # 多架构配置（riscv64/loongarch64/x86_64/aarch64）
│       ├── syscall/        # 系统调用层
│       ├── task/           # 任务管理
│       ├── mm/             # 内存管理
│       ├── file/           # 文件描述符子系统
│       ├── pseudofs/       # 伪文件系统
│       └── time.rs         # 时间类型转换
│
├── make/                   # 构建子系统（Makefile 片段）
│   ├── Makefile            # 主构建逻辑
│   ├── build.mk            # 构建规则
│   ├── cargo.mk            # Cargo 调用封装
│   ├── config.mk           # 配置处理
│   ├── features.mk         # feature 解析
│   ├── platform.mk         # 平台选择
│   └── qemu.mk             # QEMU 启动规则
│
├── scripts/                # 辅助脚本
│   ├── fix-loongarch-elf.py       # LoongArch ELF 修复
│   ├── oscomp-local-tests.sh      # 本地测试编排
│   ├── score-passonly.py          # 评分脚本
│   ├── docker-passonly-eval.sh    # Docker 评测
│   ├── analyze-ltp-log.py         # LTP 日志分析
│   └── ...
│
├── tools/                  # 预编译工具
│   ├── bin/                # axconfig-gen, cargo-axplat
│   ├── ltp-runner-riscv64  # RISC-V LTP 测试运行器（C 编译）
│   ├── ltp-runner-loongarch64
│   └── ltp-runner.c        # LTP runner 源码
│
├── vendor/                 # 离线依赖（vendor），包含 ArceOS 组件及第三方 crate
├── _cargo/                 # Cargo 配置备份（用于测评环境恢复）
├── page_table_entry/       # 本地 patch：页表项抽象
├── page_table_multiarch/   # 本地 patch：多架构页表（含 LoongArch 修复）
├── docs/                   # 文档
│   ├── chentao/
│   └── overleaf/
└── test-result-*.log       # 测试结果日志
```

---

### 三、模块划分与子系统归属

#### 1. 系统调用层 (`kernel/src/syscall/`) — 约 7,400 行

系统调用的中央调度与实现，按功能分为 7 个子模块：

| 子模块 | 路径 | 主要功能 | 代码量 |
|--------|------|----------|--------|
| **进程** | `syscall/task/` | clone/clone3, fork, execve, exit, wait4, ptrace, 调度 | ~2,380 行 |
| **内存** | `syscall/mm/` | mmap, munmap, brk, mprotect, mremap, mincore | ~580 行 |
| **文件系统** | `syscall/fs/` | open/read/write/close, stat, fcntl, mount, pipe, eventfd, signalfd, pidfd, memfd | ~2,100 行 |
| **网络** | `syscall/net/` | socket, bind, listen, accept, sendmsg, recvmsg, getsockopt/setsockopt | ~1,035 行 |
| **I/O 多路复用** | `syscall/io_mpx/` | epoll, poll, select | ~770 行 |
| **IPC** | `syscall/ipc/` | SysV 消息队列、信号量、共享内存 | ~1,960 行 |
| **同步** | `syscall/sync/` | futex, membarrier | ~230 行 |
| **信号** | `syscall/signal.rs` | rt_sigaction, rt_sigprocmask, kill, tkill, tgkill, rt_sigreturn | ~440 行 |
| **时间** | `syscall/time.rs` + `timer.rs` | clock_gettime, nanosleep, setitimer, POSIX timer, timerfd | ~610 行 |
| **系统信息** | `syscall/sys.rs` | uname, sysinfo, prctl, getpid/getuid 等 | ~290 行 |
| **调度表** | `syscall/mod.rs` | 系统调用号到处理函数的映射（约 224 处引用） | ~830 行 |

#### 2. 任务管理 (`kernel/src/task/`) — 约 2,050 行

Linux 风格进程/线程模型的核心实现：

- `mod.rs` — 核心抽象：`Thread`、`ProcessData`、`Credentials`（UID/GID）、进程组、会话
- `futex.rs` — 用户态 futex 等待队列
- `signal.rs` — 信号挂起/递送/掩码
- `timer.rs` — 进程级定时器（alarm, setitimer）
- `stat.rs` — 进程状态统计
- `ops.rs` — 进程创建/销毁操作
- `resources.rs` — RLIMIT 资源限制
- `user.rs` — 用户态上下文

依赖外部 crate：`starry-process`（进程管理）、`starry-signal`（信号框架）。

#### 3. 内存管理 (`kernel/src/mm/`) — 约 2,350 行

用户态虚拟内存管理：

- `aspace/mod.rs` — 地址空间抽象（`AddrSpace`），管理 VMA 集合
- `aspace/backend/` — 四种后端：
  - `linear.rs` — 线性映射（匿名内存）
  - `cow.rs` — 写时复制
  - `shared.rs` — 共享内存
  - `file.rs` — 文件映射
- `access.rs` — 用户态内存安全访问（`copy_from_user`/`copy_to_user`）
- `loader.rs` — ELF 加载器
- `io.rs` — 用户态 I/O 缓冲

依赖外部 crate：`starry-vm`、`page_table_multiarch`、`page_table_entry`、`memory_set`、`memory_addr`。

#### 4. 文件描述符子系统 (`kernel/src/file/`) — 约 2,980 行

"一切皆文件"抽象层：

- `mod.rs` — `FileLike` trait、`FD_TABLE` 文件描述符表
- `fs.rs` — 磁盘文件句柄（对接 axfs-ng/EXT4）
- `pipe.rs` — 匿名管道
- `epoll.rs` — epoll 实例
- `event.rs` — EventFd
- `signalfd.rs` — Signalfd
- `timerfd.rs` — TimerFd
- `pidfd.rs` — PidFd
- `net.rs` — Socket 文件描述符适配
- `record_lock.rs` — POSIX 记录锁（fcntl）

#### 5. 伪文件系统 (`kernel/src/pseudofs/`) — 约 2,250 行

- `mod.rs` / `fs.rs` / `dir.rs` / `file.rs` / `device.rs` — 伪文件系统框架
- `proc.rs` — `/proc` 文件系统（进程信息、meminfo 等）
- `tmp.rs` — `/tmp`、`/dev/shm` 临时文件系统
- `dev/mod.rs` — `/dev` 设备文件系统
- `dev/tty/` — TTY/PTY 设备（`ntty.rs`, `ptm.rs`, `pts.rs`, `pty.rs`）
- `dev/event.rs` — `/dev/event` 事件设备
- `dev/fb.rs` — `/dev/fb0` 帧缓冲
- `dev/loop.rs` — `/dev/loop` 循环设备
- `dev/rtc.rs` — `/dev/rtc` 实时时钟
- `dev/log.rs` — `/dev/log`
- `dev/memtrack.rs` — 内存追踪

#### 6. 其他内核模块

| 模块 | 路径 | 功能 |
|------|------|------|
| 入口点 | `kernel/src/entry.rs` (~260 行) | init 进程创建、伪 FS 挂载、ELF 加载、关机流程 |
| 配置 | `kernel/src/config/` | 多架构常量和配置切换 |
| 时间 | `kernel/src/time.rs` (~140 行) | timespec/timeval 与内核 TimeValue 互转 |

#### 7. 应用入口 (`src/main.rs`)

负责在编译时内嵌 init.sh 和 LTP runner 二进制，构建传递给内核的命令行参数与环境变量。通过 `include_bytes!` 编译期嵌入，供内核 entry 使用。

---

### 四、ArceOS 基础设施层（vendor 目录）

作为宏内核的底层支撑，以下 ArceOS 组件以 vendor crate 形式提供：

| Crate | 功能领域 |
|-------|----------|
| `axhal` | 硬件抽象（中断、页表、时间、DTB、percpu） |
| `axmm` | 内核态内存管理（页分配器、地址空间） |
| `axtask` | 任务调度（多任务、RR 调度、WaitQueue） |
| `axfs-ng` | 文件系统框架（VFS、EXT4 支持） |
| `axnet-ng` | 网络栈（TCP/UDP/smoltcp、Unix socket） |
| `axdriver` + 子 crate | 设备驱动（VirtIO、PCI、UART、PLIC 等） |
| `axruntime` | 运行时初始化 |
| `axsync` | 同步原语（Mutex、SpinLock 等） |
| `axalloc` | 内核内存分配器（slab） |
| `axconfig` | 平台配置生成 |
| `axfeat` | 编译期 feature 开关 |
| `axlog` | 日志 |
| `axerrno` | 错误码 |
| `axio` / `axpoll` | I/O trait 与 poll 抽象 |

社区/第三方关键依赖：
- `starry-process` / `starry-signal` / `starry-vm` — 来自 starry-next 项目的进程/信号/VM 组件
- `starry-smoltcp` — 基于 smoltcp 的网络栈定制版
- `rsext4` / `lwext4_rust` — EXT4 文件系统
- `virtio-drivers` — VirtIO 设备驱动
- `page_table_multiarch` / `page_table_entry` — 多架构页表（含本地 LoongArch patch）

---

### 五、构建系统与依赖工具

#### 需要的工具链

| 工具 | 版本/说明 |
|------|-----------|
| Rust 工具链 | `nightly-2025-05-20`，含 `rust-src`、`llvm-tools`、`rustfmt`、`clippy` |
| Rust target | `riscv64gc-unknown-none-elf`、`loongarch64-unknown-none-softfloat` |
| C 交叉编译器 | LoongArch musl 工具链（`tools/loongarch64-linux-musl-cross/`，用于编译 LTP runner） |
| RISC-V 交叉编译器 | 用于编译 LTP runner（`ltp-runner-riscv64` 已预编译） |
| QEMU | 9.2.1+（RISC-V 和 LoongArch 模拟） |
| GNU Make | 构建编排 |
| Python 3 | ELF 修复脚本、LTP 日志分析、评分脚本 |
| Bash | 测试脚本 |

#### 构建流程

1. `make kernel-rv`：使用 `.axconfig-rv.toml` 配置，Cargo 构建 RISC-V 内核，输出 `.bin` 格式
2. `make kernel-la`：使用 `.axconfig-la.toml` 配置，Cargo 构建 LoongArch 内核，通过 `fix-loongarch-elf.py` 修复 ELF 物理地址
3. `make all`：并行构建两个架构

构建过程使用 `cargo-axplat` 和 `axconfig-gen` 工具（在 `tools/bin/` 中）生成平台配置，`make/Makefile` 封装了详细的 Cargo 调用逻辑。

#### 关键依赖路径

- 本项目 patch 了 `page_table_multiarch` 和 `page_table_entry`（在仓库根目录），以支持 LoongArch64
- patch 了 `axcpu`、`axsched`、`axtask`、`starry-process`（指向 `vendor/` 中的本地副本）

---

### 六、初步量化总结

| 指标 | 数值 |
|------|------|
| 内核核心代码（`kernel/src/`） | 约 23,250 行 Rust |
| 顶层入口（`src/`） | 约 150 行 Rust |
| 页表补丁（`page_table_*`） | 约 1,220 行 Rust |
| 内核源文件数（不含 vendor） | 123 个 `.rs` 文件 |
| Vendor crate 数量 | 约 280+ |
| 支持架构 | 2（RISC-V 64、LoongArch 64），部分支持 x86_64/AArch64 |
| 系统调用实现数 | 约 200+（`syscall/mod.rs` 中 224 处 `sys_` 引用） |
| 实现的子系统 | 进程/线程、虚拟内存、文件系统（EXT4+伪FS）、网络栈、信号、IPC（SysV三件套）、同步（futex）、I/O 多路复用（epoll/poll/select）、时间/定时器、设备驱动 |

该项目具有清晰的层次结构：**ArceOS 底层框架（vendor） → 宏内核核心（kernel） → 应用入口（src）**，三层的职责边界明确。