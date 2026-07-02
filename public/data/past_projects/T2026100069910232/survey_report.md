## 项目结构

```
.
├── Makefile                        # 顶层构建入口 (make all → kernel-rv + kernel-la)
├── README.md                       # 项目说明
├── COMMENTING.md                   # Rustdoc 注释规范
├── docs/prel/                      # 初赛阶段文档
├── reference/                      # StarryOS 来源、许可证、参考资料
├── tools/                          # 顶层工具（待确认）
└── src/                            # 源码主体
    ├── Cargo.toml                  # Rust workspace 定义 (starryos)
    ├── Makefile                    # 二级构建入口，编排 kernel-rv / kernel-la
    ├── .cargo/                     # Cargo 离线配置
    ├── init/                       # 用户态 init 程序 (no_std Rust)
    │   ├── main.rs                 # init 入口，内联启动脚本
    │   ├── init.sh                 # 启动脚本：环境设置、测试调度
    │   ├── ltp-cases/              # LTP 测试用例列表
    │   └── ltp-cases.sh            # LTP 测试调度脚本
    ├── kernel/                     # 内核 crate (starry-kernel)
    │   ├── Cargo.toml
    │   └── src/
    │       ├── lib.rs              # crate 根模块
    │       ├── entry.rs            # 内核入口 → 用户态 init 启动流程
    │       ├── time.rs             # 内核时间工具
    │       ├── config/             # 架构/平台配置 (riscv64, loongarch64, aarch64, x86_64)
    │       ├── file/               # 文件子系统 (FileLike, FD表, pipe, epoll, eventfd, socket, signalfd, pidfd, flock, xattr)
    │       ├── mm/                 # 内存管理 (地址空间, 页表, mmap, ELF加载, COW, 共享映射, 用户指针访问)
    │       ├── pseudofs/           # 伪文件系统 (devfs, procfs, sysfs, tmpfs, TTY/PTY, fb, rtc, loop)
    │       ├── syscall/            # Linux 兼容系统调用
    │       │   ├── fs/             # 文件类 syscall (fd_ops, io, stat, mount, pipe, memfd, ctl, event, pidfd, signalfd)
    │       │   ├── mm/             # 内存类 syscall (brk, mmap, mincore)
    │       │   ├── task/           # 进程/线程 syscall (clone, clone3, execve, exit, wait, ctl, job, schedule, thread)
    │       │   ├── net/            # 网络 syscall (socket, io, addr, name, opt, cmsg)
    │       │   ├── ipc/            # System V IPC (msg, shm)
    │       │   ├── io_mpx/         # I/O 多路复用 (epoll, poll, select)
    │       │   ├── sync/           # 同步原语 (futex, membarrier)
    │       │   ├── signal.rs       # 信号相关 syscall
    │       │   ├── time.rs         # 时间相关 syscall
    │       │   ├── resources.rs    # 资源限制 syscall
    │       │   └── sys.rs          # 系统信息类 syscall
    │       └── task/               # 任务管理 (进程/线程生命周期, 信号, futex, 定时器, 资源统计, rlimit)
    ├── make/                       # 构建规则片段
    │   ├── Makefile, build.mk, cargo.mk, config.mk, deps.mk
    │   ├── features.mk, platform.mk, qemu.mk, utils.mk
    │   ├── defconfig.toml          # 平台默认配置
    │   ├── linker_riscv64-qemu-virt-contest.lds
    │   └── linker_loongarch64-qemu-contest.lds
    ├── scripts/                    # 构建/运行/调试/测试辅助脚本
    ├── target-check/               # 目标平台检查配置
    ├── tools/                      # 构建辅助工具 (axconfig-gen, cargo-axplat)
    └── vendor/                     # 离线第三方依赖 (~397 个 crate)
```

## 初步调查结果

### 1. 项目性质

NOS 是基于 StarryOS/ArceOS 框架开发的 **Linux 兼容操作系统内核**，使用 **Rust** 语言编写（`no_std` 环境），面向 2026 年操作系统设计赛内核实现赛道。内核以宏内核（monolithic kernel）架构组织，运行在裸机/QEMU 环境上。

### 2. 目标平台

- **RISC-V 64** (QEMU virt 平台，MMIO 总线)
- **LoongArch64** (QEMU virt 平台，PCI 总线)
- 代码中存在 aarch64 和 x86_64 的配置模块，但当前评测入口仅支持上述两种架构。

### 3. 已实现的子系统

| 子系统 | 对应目录 | 说明 |
|--------|----------|------|
| **进程与线程管理** | `task/`, `syscall/task/` | 进程/线程生命周期、clone/clone3、execve、exit、wait、进程组/会话、调度、资源限制(rlimit) |
| **信号机制** | `task/signal.rs`, `syscall/signal.rs`, `file/signalfd.rs` | 信号发送/处理/掩码、signalfd |
| **内存管理** | `mm/`, `syscall/mm/` | 虚拟地址空间、VMA、页表、mmap/munmap、brk、COW、共享映射、文件映射、缺页处理、ELF 加载、mincore |
| **文件系统与 VFS** | `file/`, `syscall/fs/` | FileLike 抽象、FD 表、VFS 对接、管道、eventfd、epoll、记录锁、flock、xattr、memfd、mount |
| **伪文件系统** | `pseudofs/` | devfs(`/dev`)、procfs(`/proc`)、sysfs(`/sys`)、tmpfs；设备节点包括 null/zero/random/rtc/fb/loop/event/log/memtrack；TTY 子系统含 PTY master/slave、ntty、终端行规程(termios/ldisc/job control) |
| **网络** | `file/net.rs`, `syscall/net/` | socket 接口、地址解析、socket 选项、控制消息(cmsg)、I/O 操作 |
| **System V IPC** | `syscall/ipc/` | 消息队列(msg)、共享内存(shm) |
| **I/O 多路复用** | `syscall/io_mpx/` | epoll、poll、select |
| **同步原语** | `task/futex.rs`, `syscall/sync/` | futex、membarrier |
| **定时器** | `task/timer.rs`, `syscall/time.rs` | POSIX 定时器、时间相关 syscall |
| **ELF/脚本加载** | `mm/loader.rs`, `syscall/task/execve.rs` | ELF 解析与加载、脚本解释器(#!) |
| **内核入口** | `entry.rs` | 伪文件系统挂载、init 程序加载、用户地址空间创建、标准 I/O 设置 |

### 4. 底层依赖框架

项目基于 ArceOS 的模块化 unikernel 框架，vendor 目录中包含约 **397 个第三方 crate**，其中核心 ArceOS 组件约 50 个（`axhal`、`axplat`、`axruntime`、`axtask`、`axmm`、`axalloc`、`axdriver`、`axnet-ng`、`axfs-ng`、`axfeat` 等），提供硬件抽象层、平台支持、运行时初始化、任务调度、内存分配、驱动框架、网络栈和文件系统等底层能力。

### 5. 构建工具链需求

- **Rust 工具链**：rustc、cargo（离线模式，vendor 目录提供依赖），edition 2024
- **构建辅助工具**：`axconfig-gen`（平台配置生成）、`cargo-axplat`（平台构建 cargo 子命令），均位于 `src/tools/`
- **GNU Make**：多层 Makefile 编排（根目录 → `src/Makefile` → `src/make/`）
- **链接器脚本**：自定义 `.lds` 链接脚本（RISC-V 和 LoongArch 各一份）
- **QEMU**：用于运行和调试（riscv64 和 loongarch64 目标）
- **Python**：构建辅助脚本（`strtosz.py`、`ci-test.py`）
- **文件系统镜像工具**：rootfs 镜像从远程下载（xz 压缩），使用 `dd`/`mkfs` 等工具处理
- **交叉编译**：RISC-V 和 LoongArch 裸机目标需要对应的 Rust target（通过 rustup 安装）