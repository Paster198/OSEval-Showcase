## 项目概述

该项目名为 **StarryOS**（仓库名 starry-next），由海南大学团队开发，基于 [ArceOS](https://github.com/arceos-org/arceos) 框架的**宏内核（Monolithic Kernel）**，面向操作系统比赛。项目使用 Rust 编写（`no_std` 环境），支持四种目标架构：**riscv64**、**x86_64**、**aarch64**、**loongarch64**。

---

## 仓库文件组织结构

```
.
├── src/                  # 内核主入口与系统调用分发层
│   ├── main.rs           # 内核入口(main函数)、用户程序加载与调度
│   ├── page_fault.rs     # 缺页异常处理
│   └── syscall_imp/      # 系统调用具体实现（按子系统分文件）
│       ├── mod.rs        # 系统调用总分发（约100+个syscall的match）
│       ├── fs.rs         # 文件系统相关syscall
│       ├── mm/           # 内存管理syscall（brk, mmap）
│       ├── task/         # 进程/线程syscall（clone, execve, wait4, exit等）
│       ├── res.rs        # 资源管理syscall
│       ├── sys.rs        # 系统信息syscall
│       └── utils.rs      # 辅助工具
├── api/                  # posix_api crate - POSIX兼容API层
│   └── src/
│       ├── lib.rs        # 对外导出接口
│       ├── fd/           # 文件描述符抽象（epoll, fs, net, pipe, stdio）
│       ├── imp/          # POSIX API具体实现
│       │   ├── fd/       # fd操作、pipe、stat
│       │   ├── io.rs     # 读写IO
│       │   ├── io_mpx/   # IO多路复用（epoll, poll）
│       │   ├── ipc/      # 进程间通信（sem信号量, shm共享内存）
│       │   ├── signal.rs # 信号处理
│       │   ├── futex.rs  # Futex实现
│       │   ├── time.rs   # 时间相关
│       │   ├── task.rs   # 任务相关
│       │   └── resources.rs # 资源限制
│       ├── signal.rs     # 信号发送接口
│       └── ptr.rs        # 用户空间指针安全访问
├── core/                 # sys_core crate - 内核核心抽象层
│   └── src/
│       ├── lib.rs
│       ├── mm.rs         # 内存管理核心（用户地址空间、ELF加载）
│       ├── futex.rs      # Futex核心数据结构
│       ├── time.rs       # 时间管理
│       ├── task/         # 任务管理核心
│       │   ├── process.rs       # 进程
│       │   ├── process_group.rs # 进程组
│       │   ├── session.rs       # 会话
│       │   ├── thread.rs        # 线程
│       │   ├── flags.rs         # 任务标志
│       │   └── trapframe.rs     # 陷入帧管理
│       └── vfs/          # 虚拟文件系统层
│           ├── dev.rs    # 设备文件系统
│           ├── proc.rs   # proc文件系统
│           ├── tmp.rs    # tmpfs
│           ├── file.rs   # 文件抽象
│           └── dynamic.rs# 动态分发
├── crates/               # 自定义子crate
│   ├── axdriver_crates/  # 设备驱动（block, net, display, virtio, pci）
│   ├── axfs-ng-vfs/      # 下一代文件系统VFS层（挂载、路径解析、目录/文件节点）
│   ├── lwext4_rust/      # ext4文件系统（基于lwext4 C库的Rust绑定）
│   ├── page_table_multiarch/ # 多架构页表管理
│   └── visionfive2-sd/   # VisionFive2 SD卡驱动
├── arceos/               # ArceOS基础框架（作为依赖引入，非本项目原创）
│   ├── modules/          # 内核模块（axalloc, axhal, axmm, axtask, axnet, axfs等）
│   ├── api/              # ArceOS API层
│   └── ulib/             # 用户态库（axstd, axlibc）
├── apps/                 # 用户态测试程序
│   ├── nimbos/           # NimboOS测试集
│   ├── oscomp/           # OS比赛测试集
│   ├── junior/           # 初级测试集
│   └── libc/             # libc测试集
├── configs/              # 各架构配置文件（riscv64.toml, x86_64.toml等）
├── vendor/               # 离线依赖包（约150+个crate）
├── scripts/              # 构建脚本
├── tools/                # 辅助工具
├── docs/                 # 项目文档
├── Cargo.toml            # Rust workspace配置
├── Makefile              # 构建入口
└── build.rs              # 构建脚本（链接用户程序二进制）
```

---

## 子系统分析

基于代码结构和系统调用分发，该项目实现了以下子系统：

| 子系统 | 主要代码位置 | 说明 |
|--------|-------------|------|
| **系统调用分发** | `src/syscall_imp/mod.rs` | 通过 `Sysno` 枚举分发约100+个Linux系统调用 |
| **进程/线程管理** | `core/src/task/`, `src/syscall_imp/task/` | 进程、进程组、会话、线程、clone/fork/execve/wait4/exit |
| **内存管理** | `core/src/mm.rs`, `src/syscall_imp/mm/` | 用户地址空间创建、ELF加载、mmap/munmap/brk/mprotect、COW |
| **文件系统** | `core/src/vfs/`, `api/src/fd/`, `crates/axfs-ng-vfs/`, `crates/lwext4_rust/` | VFS层、ext4支持、devfs/procfs/tmpfs、openat/read/write/getdents64等 |
| **网络** | `api/src/fd/net.rs` | socket/bind/connect/listen/accept/send/recv |
| **IO多路复用** | `api/src/imp/io_mpx/` | epoll、poll、select/pselect6 |
| **管道** | `api/src/fd/pipe.rs`, `api/src/imp/fd/pipe.rs` | pipe2 |
| **信号** | `api/src/signal.rs`, `api/src/imp/signal.rs` | rt_sigaction/rt_sigprocmask/kill/tkill/tgkill |
| **IPC** | `api/src/imp/ipc/` | System V 信号量(semget/semop/semctl)、共享内存(shmget/shmat/shmdt/shmctl) |
| **Futex** | `core/src/futex.rs`, `api/src/imp/futex.rs` | futex系统调用 |
| **时间管理** | `core/src/time.rs`, `api/src/imp/time.rs` | clock_gettime/nanosleep/gettimeofday |
| **设备驱动** | `crates/axdriver_crates/` | VirtIO(block/net/gpu)、PCI、RAMDisk、BCM2835 SD、VisionFive2 SD |
| **页表管理** | `crates/page_table_multiarch/` | 多架构(riscv/aarch64/x86_64/loongarch64)页表抽象 |
| **资源限制** | `api/src/imp/resources.rs` | getrlimit/setrlimit |

---

## 构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| **Rust nightly** (nightly-2025-05-20) | 编译内核主体 | 可用（rustup） |
| **cargo-binutils** | rust-objcopy/rust-objdump | 可用 |
| **GNU Make** | 构建入口 | 可用 |
| **QEMU** (>= 8.2.0) | 运行模拟 | 可用 |
| **RISC-V交叉编译工具链** | 编译用户态程序 | 可用（riscv64-linux-gnu） |
| **LoongArch交叉编译工具链** | 编译LoongArch用户态程序 | 可用 |
| **AArch64交叉编译工具链** | 编译AArch64用户态程序 | 可用 |
| **musl交叉工具链** | 编译musl libc用户态程序 | **缺失**（riscv64-musl等） |
| **libclang-dev** | bindgen依赖 | 需确认 |
| **dtc** | 设备树编译 | 可用 |
| **OpenSBI/RustSBI** | RISC-V SBI固件 | 可用 |

构建流程：通过 `Makefile` 调用 `arceos/Makefile`，使用 `cargo build` 编译 Rust 内核，`build.rs` 负责将用户态程序二进制嵌入内核镜像。项目使用 `vendor/` 目录实现离线依赖，无需网络访问。