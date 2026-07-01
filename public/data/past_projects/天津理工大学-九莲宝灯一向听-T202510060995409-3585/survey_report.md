## WenyiOS 项目初步调查报告

### 一、项目概述

WenyiOS 是一款基于 Rust 语言编写、基于 ArceOS 微内核生态实现的**宏内核操作系统**。该项目是 starry-next 的一个分支，参加 OS 内核比赛。项目支持四种架构：x86_64、aarch64、riscv64、loongarch64。

### 二、仓库文件组织结构

```
.
├── src/                    # 内核入口与顶层逻辑（主 crate: starry）
│   ├── main.rs             # 内核 main 函数，创建 init 进程并加载用户应用
│   ├── entry.rs            # 用户应用加载与运行（run_user_app）
│   ├── syscall.rs          # 系统调用分发（约 100+ 个 syscall 处理）
│   └── mm.rs               # 缺页异常处理（Page Fault）
├── core/                   # starry-core crate：内核核心功能
│   └── src/
│       ├── lib.rs
│       ├── futex.rs        # Futex 实现
│       ├── mm.rs           # 内存管理（用户地址空间、ELF 加载、trampoline 映射）
│       ├── task.rs         # 任务/进程/线程管理
│       ├── time.rs         # 时间统计
│       └── resources.rs    # 资源限制管理
├── api/                    # starry-api crate：系统调用 API 实现层
│   └── src/
│       ├── lib.rs
│       ├── file/           # 文件描述符抽象（fs、net、pipe、stdio）
│       ├── imp/            # 系统调用具体实现
│       │   ├── fs/         # 文件系统相关（ctl、fd_ops、io、io_mpx、mount、pipe、stat）
│       │   ├── mm/         # 内存管理（brk、mmap）
│       │   ├── task/       # 进程/线程操作（clone、execve、exit、schedule、thread、wait）
│       │   ├── ipc/        # 进程间通信（shm 共享内存）
│       │   ├── net.rs      # 网络系统调用
│       │   ├── signal.rs   # 信号处理
│       │   ├── futex.rs    # Futex 系统调用
│       │   ├── time.rs     # 时间相关系统调用
│       │   ├── sys.rs      # 系统信息类调用
│       │   └── resources.rs# 资源限制类调用
│       ├── path.rs         # 路径处理
│       ├── ptr.rs          # 用户空间指针安全访问
│       ├── signal.rs       # 信号数据结构
│       ├── sockaddr.rs     # Socket 地址处理
│       └── time.rs         # 时间数据结构
├── arceos/                 # ArceOS 基座（作为子模块/依赖）
│   ├── modules/            # ArceOS 内核模块
│   │   ├── axalloc/        # 内存分配器
│   │   ├── axconfig/       # 配置管理
│   │   ├── axdisplay/      # 显示驱动
│   │   ├── axdma/          # DMA 管理
│   │   ├── axdriver/       # 设备驱动框架
│   │   ├── axfs/           # 文件系统
│   │   ├── axhal/          # 硬件抽象层
│   │   ├── axlog/          # 日志
│   │   ├── axmm/           # 内存管理
│   │   ├── axnet/          # 网络协议栈
│   │   ├── axns/           # 命名空间
│   │   ├── axruntime/      # 运行时初始化
│   │   ├── axsync/         # 同步原语
│   │   └── axtask/         # 任务调度
│   ├── api/                # ArceOS API 层
│   ├── ulib/               # 用户态库（axstd、axlibc）
│   └── configs/            # 平台配置
├── apps/                   # 用户态测试应用
│   ├── junior/             # 初级测试用例
│   ├── nimbos/             # NimboOS 测试用例（C + Rust）
│   ├── libc/               # libc 测试用例
│   └── oscomp/             # 比赛测试用例
├── crates/                 # 本地扩展 crate
│   ├── axdriver_net/       # 网络驱动扩展（dwmac/fxmac/ixgbe）
│   ├── lwext4_rust/        # ext4 文件系统 Rust 绑定（基于 lwext4 C 库）
│   ├── ls2k1000la_driver/  # 龙芯 2K1000LA 板级驱动
│   └── visionfive2-sd/     # VisionFive 2 SD 卡驱动
├── configs/                # 各架构平台配置（TOML）
│   ├── riscv64.toml
│   ├── loongarch64.toml
│   ├── aarch64.toml
│   ├── x86_64.toml
│   └── dummy.toml
├── vendor/                 # 离线依赖包（约 150+ 个 crate）
├── scripts/                # 构建与测试脚本
├── bin/                    # 自定义二进制工具
├── docs/                   # 比赛文档与 PPT
├── build.rs                # 构建脚本（将用户应用二进制嵌入内核镜像）
├── Cargo.toml              # 工作区配置
├── Makefile                # 顶层构建入口
├── build_img.sh            # 磁盘镜像构建脚本
├── run_qemu_rv.sh          # RISC-V QEMU 运行脚本
└── run_qemu_la.sh          # LoongArch QEMU 运行脚本
```

### 三、子系统划分

| 子系统 | 对应目录/文件 | 说明 |
|--------|--------------|------|
| **系统调用分发** | `src/syscall.rs` | 统一入口，将 Linux syscall 号分发到具体实现函数，覆盖约 100+ 个系统调用 |
| **进程/线程管理** | `api/src/imp/task/`、`core/src/task.rs` | clone、execve、exit、wait、调度策略、线程创建与销毁 |
| **内存管理** | `api/src/imp/mm/`、`core/src/mm.rs`、`src/mm.rs` | brk、mmap/munmap/mprotect、用户地址空间管理、ELF 加载、缺页异常处理 |
| **文件系统** | `api/src/imp/fs/`、`api/src/file/` | open/close/read/write/lseek、目录操作、stat、mount/umount、ioctl、管道 |
| **I/O 多路复用** | `api/src/imp/fs/io_mpx/` | poll/ppoll/select/pselect6 |
| **网络** | `api/src/imp/net.rs`、`api/src/file/net.rs` | socket、bind、listen、accept、connect、send/recv 等 |
| **信号** | `api/src/imp/signal.rs`、`api/src/signal.rs`、`core/src/` | 信号发送、处理、sigaction、sigprocmask |
| **IPC（共享内存）** | `api/src/imp/ipc/` | shmget、shmat、shmdt、shmctl |
| **Futex** | `api/src/imp/futex.rs`、`core/src/futex.rs` | futex 等待与唤醒 |
| **时间** | `api/src/imp/time.rs`、`core/src/time.rs` | clock_gettime、nanosleep、gettimeofday |
| **资源限制** | `api/src/imp/resources.rs`、`core/src/resources.rs` | rlimit、prlimit64 |
| **设备驱动** | `crates/`、`arceos/modules/axdriver/` | 网卡（dwmac/fxmac/ixgbe）、SD 卡（VisionFive2）、龙芯板级驱动、VirtIO |
| **文件系统驱动** | `crates/lwext4_rust/` | ext4 文件系统支持（通过 lwext4 C 库绑定） |
| **硬件抽象层** | `arceos/modules/axhal/` | 多架构 CPU 上下文、中断/异常处理、页表管理 |
| **调度器** | `arceos/modules/axtask/` | 任务调度框架 |
| **内存分配** | `arceos/modules/axalloc/`、`arceos/modules/axmm/` | 物理页分配、虚拟内存管理 |

### 四、构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust nightly 工具链** (nightly-2025-01-18) | 主编译工具链，项目使用 `edition = "2024"` |
| **cargo / rustc** | Rust 构建与编译 |
| **GNU Make** | 顶层构建编排 |
| **RISC-V 交叉编译工具链** | riscv64gc-unknown-none-elf 目标 |
| **LoongArch 交叉编译工具链** | loongarch64-unknown-none 目标 |
| **AArch64 交叉编译工具链** | aarch64-unknown-none 目标 |
| **x86_64 bare-metal 工具链** | x86_64-unknown-none 目标 |
| **QEMU** | 多架构模拟运行（riscv64、loongarch64、aarch64、x86_64） |
| **OpenSBI/RustSBI** | RISC-V SBI 固件 |
| **mkfs.ext4 / dd / losetup** | 磁盘镜像制作（`build_img.sh`） |
| **C 编译器（musl 交叉）** | lwext4 C 库编译、用户态 libc 测试应用编译 |
| **dtc（设备树编译器）** | 可能需要处理设备树 |
| **bindgen + libclang** | lwext4_rust 的 C 绑定生成 |
| **Python** | 测试脚本（`judge_*.py`） |
| **Git** | 依赖管理 |
| **wget/curl + gunzip** | 下载测试镜像 |

### 五、关键观察

1. **架构设计**：项目采用三层结构 -- `starry`（顶层入口）依赖 `starry-api`（系统调用实现层）依赖 `starry-core`（核心数据结构与逻辑），底层基于 ArceOS 模块化框架提供硬件抽象和基础服务。

2. **系统调用覆盖**：从 `syscall.rs` 可见，项目实现了约 100+ 个 Linux 兼容系统调用，涵盖文件操作、进程管理、内存管理、网络、信号、IPC、时间等核心子系统。

3. **多架构支持**：通过条件编译（`cfg(target_arch)`）和平台配置文件支持四种架构，其中 riscv64 和 loongarch64 是比赛主要目标平台。

4. **ext4 文件系统**：通过 `lwext4_rust` crate 集成 lwext4 C 库实现 ext4 文件系统支持，已预编译 riscv64 和 loongarch64 的静态库。

5. **vendor 目录**：包含约 150+ 个离线依赖 crate，支持离线构建。