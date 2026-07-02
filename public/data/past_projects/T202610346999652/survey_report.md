# StarryOS (TheKernel) 项目探索报告

## 一、项目概述

本项目名为 **StarryOS**（参赛名称 TheKernel），是一个基于 **ArceOS unikernel** 构建的 **Rust 语言** OS 内核，目标是在 RISC-V 和 LoongArch 架构上提供 Linux ABI 兼容性，通过官方的 OS 比赛评测套件。项目使用 `nightly-2025-05-20` Rust 工具链。

## 二、仓库文件组织结构

```
repo/
├── Cargo.toml            # 工作空间根配置，定义 workspace 成员和依赖
├── Cargo.lock            # 依赖锁定文件
├── Makefile              # 顶层 Makefile：构建、运行、评测、lab 等命令入口
├── rust-toolchain.toml   # Rust 工具链版本和 target 声明
├── rustfmt.toml          # Rust fmt 配置
├── README.md             # 项目说明
├── ltp_test.txt          # LTP 测试清单
├── LICENSE / NOTICE      # 许可文件
│
├── src/                  # 顶层二进制入口
│   ├── main.rs           # 内核入口点 (no_std + no_main)，启动 init 进程
│   └── init.sh           # 用户态 init 脚本（嵌入在 main.rs 中）
│
├── kernel/               # 内核核心 crate (starry-kernel)
│   ├── Cargo.toml        # 内核 crate 配置和依赖声明
│   └── src/              # 内核源代码（161 个 .rs 文件，~61,637 行）
│       ├── lib.rs        # 内核库入口，声明所有子系统模块
│       ├── entry.rs      # 内核初始化：地址空间、任务、伪文件系统挂载
│       ├── config/       # 架构相关配置（riscv64, loongarch64, x86_64, aarch64）
│       ├── syscall/      # 系统调用处理（~364 个 Sysno 分支）
│       ├── task/         # 任务/进程管理
│       ├── mm/           # 内存管理（地址空间、页表、mmap、加载器）
│       ├── file/         # 文件抽象层（FileLike trait、各类文件类型）
│       ├── pseudofs/     # 伪文件系统（procfs, sysfs, devfs, tmpfs, cgroupfs）
│       ├── bpf/          # eBPF 子系统（虚拟机、验证器、map、程序管理）
│       ├── mounts.rs     # 挂载记录管理
│       └── time.rs       # 时间管理
│
├── crates/               # 自定义 vendored crate
│   └── axnet-ng/         # 网络栈 crate：TCP/UDP/unix socket/vsock
│
├── third_party/          # 第三方 vendored/patch 依赖
│   └── rust-patches/     # 22 个 patched crate
│       ├── axfeat/             # ArceOS 特性门控
│       ├── axruntime/          # ArceOS 运行时
│       ├── axhal/相关          # 硬件抽象层
│       ├── axtask/             # 任务调度基础设施
│       ├── axsched/            # CFS 调度器
│       ├── axdriver/           # 设备驱动框架
│       ├── axdriver_virtio/    # VirtIO 驱动
│       ├── axfs-ng/            # 文件系统（ext4 支持）
│       ├── axfs-ng-vfs/        # VFS 层
│       ├── axio/               # IO trait
│       ├── axcpu/              # CPU 抽象
│       ├── starry-process/     # 进程抽象（PID、进程树）
│       ├── starry-signal/      # 信号处理框架
│       ├── starry-vm/          # 用户态内存访问（vm_load/vm_write）
│       ├── starry-smoltcp/     # 网络协议栈（smoltcp fork）
│       ├── memory_set/         # 内存区域管理
│       ├── page_table_multiarch/ # 多架构页表
│       ├── kernel-elf-parser/  # ELF 解析
│       ├── lwext4_rust/        # ext4 文件系统（C 绑定）
│       ├── virtio-drivers/     # VirtIO 驱动
│       ├── axplat-riscv64-qemu-virt/  # RISC-V QEMU 平台定义
│       └── axplat-loongarch64-qemu-virt/ # LoongArch QEMU 平台定义
│
├── scripts/              # 构建/评测/辅助脚本
│   ├── oscomp.sh         # 评测运行入口
│   ├── replay-oscomp-eval.sh  # 评测回放
│   ├── build-oscomp-support-disk.sh  # 支持磁盘镜像构建
│   ├── ltp-lab.py        # LTP 测试 lab 管理（大型脚本，~157K）
│   ├── axconfig-tool.py  # 配置生成工具
│   └── ...               # 其他辅助脚本
│
├── make/                 # 构建系统（Makefile 片段）
│   ├── Makefile          # 构建主逻辑
│   ├── build.mk          # Cargo 构建规则
│   ├── platform.mk       # 平台解析
│   ├── features.mk       # 特性解析
│   ├── qemu.mk           # QEMU 启动规则
│   ├── cargo.mk          # Cargo 参数
│   ├── config.mk         # 配置生成
│   └── platforms/        # 平台配置文件
│
├── dev-env/              # 开发容器
│   ├── Dockerfile
│   ├── compose.yaml
│   └── entrypoint.sh
│
└── docs/                 # 文档
    ├── oscomp2026_report.pdf/txt   # 技术报告
    ├── oscomp2026_slides.pdf/txt   # 答辩幻灯片
    └── history-rewrite.md          # Git 历史改写说明
```

## 三、子系统划分

根据代码组织结构和模块声明，该内核实现了以下子系统：

### 1. 系统调用层 (`kernel/src/syscall/`)
- **位置**：`kernel/src/syscall/`
- **内容**：分发和处理 Linux 系统调用，涵盖约 364 个 `Sysno` 分支
- **子模块**：
  - `fs/` — 文件系统相关系统调用（open, read, write, stat, ioctl, mount, epoll, inotify, fanotify, io_uring, signalfd, timerfd, memfd, pidfd, userfaultfd, aio, xattr 等）
  - `task/` — 进程/线程相关系统调用（clone, execve, exit, wait, ptrace, schedule, thread, acct 等）
  - `mm/` — 内存相关系统调用（mmap, brk, mincore, process_vm, swap 等）
  - `net/` — 网络相关系统调用（socket, bind, send, recv 等）
  - `io_mpx/` — IO 多路复用（epoll, poll, select）
  - `ipc/` — 进程间通信（mqueue, msg, sem, shm）
  - `sync/` — 同步原语（futex, membarrier）
  - `signal.rs` — 信号系统调用
  - `time.rs` — 时间系统调用
  - `resources.rs` — 资源限制系统调用（getrlimit/setrlimit）
  - `sys.rs` — 通用系统调用（uname, sysinfo 等）
  - `bpf/` — eBPF 系统调用

### 2. 任务/进程管理 (`kernel/src/task/`)
- **位置**：`kernel/src/task/`
- **内容**：进程、线程、信号、调度相关
- **子模块**：`process.rs`（ProcessData）、`thread.rs`（Thread）、`signal.rs`（信号处理）、`futex.rs`（futex）、`resources.rs`（资源限制）、`creds.rs`（凭证/权限）、`jobctl.rs`（作业控制）、`accounting.rs`（任务记账）、`timer.rs`（定时器）、`coredump.rs`（核心转储）、`stat.rs`（统计信息）、`restart.rs`（系统调用重启）、`user.rs`（用户态上下文）

### 3. 内存管理 (`kernel/src/mm/`)
- **位置**：`kernel/src/mm/`
- **内容**：用户态地址空间管理、内存映射、缺页处理
- **子模块**：
  - `aspace/` — 地址空间实现（AddrSpace），后端包括 `cow`（写时复制）、`file`（文件映射）、`linear`（线性映射）、`shared`（共享映射）
  - `access.rs` — 用户态内存访问
  - `io.rs` — 内存 IO
  - `loader.rs` — ELF 加载器
  - `stats.rs` — 内存统计

### 4. 文件系统 (`kernel/src/file/` + `kernel/src/pseudofs/`)
- **核心抽象**：`file/types.rs` — `FileLike` trait，统一的文件操作接口
- **文件类型实现**（`kernel/src/file/`）：
  - `fs.rs` — 常规文件和目录
  - `net.rs` — Socket 文件
  - `netlink.rs` — Netlink socket
  - `packet.rs` — Packet socket
  - `pipe.rs` — 管道
  - `epoll.rs` — epoll
  - `event.rs` — eventfd
  - `inotify.rs` — inotify
  - `fanotify.rs` — fanotify
  - `signalfd.rs` — signalfd
  - `timerfd.rs` — timerfd
  - `memfd.rs` — memfd
  - `pidfd.rs` — pidfd
  - `io_uring.rs` — io_uring
  - `userfaultfd.rs` — userfaultfd
  - `af_alg.rs` — AF_ALG socket
  - `bpf.rs` — BPF 文件描述符
  - `flock.rs` — 文件锁
  - `lease.rs` — 文件租约
  - `executable.rs` — 可执行文件引用
  - `fd_table.rs` — 文件描述符表
  - `desc.rs` — 文件描述符
  - `stdio.rs` — 标准 IO
- **伪文件系统**（`kernel/src/pseudofs/`）：
  - `dev/` — devfs（设备节点：tty, fb, rtc, loop, event, log, memtrack）
  - `proc.rs` — procfs
  - `sys.rs` — sysfs
  - `cgroup.rs` — cgroupfs
  - `tmp.rs` — tmpfs (MemoryFs)
  - `dir.rs`, `file.rs`, `fs.rs` — 伪文件系统框架
- **挂载管理**：`kernel/src/mounts.rs`

### 5. 网络栈 (`crates/axnet-ng/` + `kernel/src/file/net.rs`)
- **位置**：`crates/axnet-ng/`
- **内容**：完整的 TCP/UDP/Unix Socket/VSock 实现
- **子模块**：`tcp.rs`, `udp.rs`, `unix/`（stream + dgram）、`vsock/`、`device/`（ethernet, loopback, veth, vsock）、`router.rs`、`listen_table.rs`、`net_stack.rs`、`service.rs`、`socket.rs`
- 底层基于 `starry-smoltcp`（smoltcp 的 fork）

### 6. eBPF 子系统 (`kernel/src/bpf/`)
- **位置**：`kernel/src/bpf/`
- **内容**：eBPF 虚拟机、验证器、map 管理、程序管理
- **子模块**：`vm.rs`（VM 执行引擎）、`verifier.rs`（验证器）、`map.rs`（BPF map）、`prog.rs`（BPF 程序）、`helpers.rs`（辅助函数）、`defs.rs`（定义）

### 7. 时间管理 (`kernel/src/time.rs`)
- 墙上时钟管理、时间偏移、`TimeValue` 与各类 Linux 时间结构互转

### 8. 架构配置 (`kernel/src/config/`)
- RISC-V64、LoongArch64、x86_64、AArch64 的架构特定常量（内核栈、用户空间布局、信号跳板等）

### 9. 第三方基础设施层（`third_party/rust-patches/`）
这些是 ArceOS 生态的 patched 版本，提供底层能力：
- **平台抽象**：axplat-riscv64-qemu-virt, axplat-loongarch64-qemu-virt
- **运行时**：axruntime
- **硬件抽象**：axhal（通过 axfeat 间接引用）
- **驱动框架**：axdriver, axdriver_virtio, virtio-drivers
- **文件系统**：axfs-ng（ext4 支持），axfs-ng-vfs（VFS 层），lwext4_rust
- **内存**：memory_set, page_table_multiarch
- **任务**：axtask, axsched（CFS 调度）
- **进程/信号**：starry-process, starry-signal, starry-vm
- **网络**：starry-smoltcp
- **其他**：axfeat（特性门控），axio, axcpu, axerrno, kernel-elf-parser

## 四、构建工具需求

根据 Makefile、Cargo.toml 和 rust-toolchain.toml 的分析：

1. **Rust 工具链**：`nightly-2025-05-20`，需要 `rust-src`, `llvm-tools`, `rustfmt`, `clippy` 组件
2. **交叉编译目标**：
   - `riscv64gc-unknown-none-elf`（RISC-V）
   - `loongarch64-unknown-none` / `loongarch64-unknown-none-softfloat`（LoongArch）
   - `aarch64-unknown-none-softfloat`（AArch64）
   - `x86_64-unknown-none`（x86_64）
3. **链接器**：`rust-lld`
4. **QEMU**：用于模拟运行（RISC-V 和 LoongArch）
5. **Docker**：官方开发/构建使用容器化环境
6. **其他工具**：Python 3（配置生成脚本、LTP lab 管理）、Make、musl/glibc 交叉工具链（C 程序编译，通过容器提供）
7. **磁盘镜像工具**：`mkfs.ext4`, `mkfs.vfat`, `mcopy`, `dd`

## 五、初步评估总结

| 维度 | 观察 |
|------|------|
| **代码规模** | 内核 crate 约 61,637 行 Rust 代码（161 个源文件）+ vendored crates |
| **架构支持** | RISC-V64（主要）、LoongArch64、x86_64、AArch64 |
| **ABI 兼容** | 实现了大量 Linux 系统调用（~364 个 Sysno 分支），覆盖 fs/task/mm/net/ipc/sync/signal/time/bpf |
| **内存管理** | 完整的用户态地址空间、COW、mmap、文件映射、缺页处理 |
| **文件系统** | VFS 框架 + ext4 + 多种伪文件系统（proc/sys/dev/tmp/cgroup）+ 丰富的特殊文件类型 |
| **进程管理** | 进程/线程模型、clone/execve、信号、作业控制、ptrace、coredump、CFS 调度 |
| **网络** | 完整 TCP/UDP/Unix Socket/VSock、epoll/poll/select、netlink、packet socket |
| **IPC** | 消息队列、信号量、共享内存、futex |
| **eBPF** | 虚拟机、验证器、map、程序管理、socket filter |
| **构建方式** | Cargo workspace + Makefile 包装 + Docker 容器，两阶段编译（Cargo 构建 + ELF 后处理） |

该项目是一个功能较为完整的 Linux 兼容内核，代码组织清晰，模块化程度高，覆盖了 OS 比赛中评测所需的绝大部分子系统。