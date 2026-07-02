# Starry (starry-next) OS 内核项目初步分析报告

## 1. 项目概览

该项目名为 **Starry**（仓库名 starry-next），是一个基于 **ArceOS** 组件化内核框架构建的 **宏内核（Monolithic Kernel）** 操作系统，使用 Rust 语言编写，面向 OS 内核比赛（OSKernel 2026）场景。项目支持 4 种指令集架构：**x86_64、AArch64、RISC-V64、LoongArch64**。

项目在 ArceOS 提供的模块化基础（HAL、内存管理、任务调度、文件系统、网络、同步原语等）之上，实现了完整的 Linux 兼容用户态支持：进程管理（fork/execve/clone）、信号、futex、mmap/brk、管道、socket 等系统调用，能够运行 musl 和 glibc 编译的用户程序。

## 2. 文件组织结构

```
.
├── Cargo.toml              # workspace 根配置 (成员: api, core, 根 crate "starry")
├── Cargo.lock
├── Makefile                # 顶层构建入口
├── build.rs                # 构建脚本（链接用户测例二进制到内核）
├── build_img.sh            # 磁盘镜像制作脚本
├── .gitlab-ci.yml           # CI 配置
│
├── src/                    # 内核入口 & 核心粘合层
│   ├── main.rs             # 内核主函数：初始化 init 进程、运行用户测例
│   ├── entry.rs            # 用户程序加载与运行入口
│   ├── syscall.rs          # 系统调用分发（~102 个 Sysno 分支）
│   └── mm.rs               # 缺页异常处理（PAGE_FAULT handler）
│
├── core/ (starry-core)     # 内核核心库
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs           # crate 入口
│       ├── task.rs          # 任务扩展（TaskExt/ThreadData/ProcessData）、时间统计
│       ├── mm.rs            # 用户地址空间管理（ELF 加载、栈/堆映射、trampoline 映射）
│       ├── futex.rs         # Futex 表实现
│       └── time.rs          # 时间统计结构（用户/内核态时间、定时器）
│
├── api/ (starry-api)       # 系统调用实现层
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs           # crate 入口
│       ├── imp/             # 系统调用具体实现
│       │   ├── fs/          # 文件系统调用 (ioctl/chdir/open/read/write/stat/mount/pipe/...)
│       │   ├── mm/          # 内存管理调用 (brk/mmap)
│       │   ├── task/        # 进程/线程调用 (clone/execve/exit/wait/fork)
│       │   ├── signal.rs    # 信号调用
│       │   ├── futex.rs     # futex 调用
│       │   ├── time.rs      # 时间调用
│       │   └── sys.rs       # 系统信息调用
│       ├── file/            # 文件描述符抽象（fs/net/pipe/stdio）
│       ├── signal.rs
│       ├── socket.rs
│       ├── path.rs
│       ├── ptr.rs
│       └── time.rs
│
├── vendor/                  # 依赖的本地化（vendored）代码
│   ├── arceos/              # ArceOS 内核框架（patch 覆盖远程依赖）
│   │   ├── api/             # axfeat (特性门控), arceos_api, arceos_posix_api
│   │   └── modules/         # 14 个内核模块
│   │       ├── axhal        # 硬件抽象层（中断、内存、CPU、架构支持）
│   │       ├── axmm         # 内存管理（地址空间、页表后端）
│   │       ├── axtask       # 任务调度（任务结构、运行队列、API）
│   │       ├── axfs         # 文件系统抽象（VFS、文件操作）
│   │       ├── axnet        # 网络栈（基于 smoltcp）
│   │       ├── axalloc      # 内核内存分配器
│   │       ├── axns         # 命名空间抽象
│   │       ├── axsync       # 同步原语（Mutex 等）
│   │       ├── axruntime    # 运行时（语言项、启动流程）
│   │       ├── axlog        # 日志
│   │       ├── axconfig     # 平台配置
│   │       ├── axdriver     # 设备驱动框架
│   │       ├── axdisplay    # 显示子系统
│   │       └── axdma        # DMA 子系统
│   └── cargo/               # 18 个本地化的第三方 crate
│       ├── axprocess        # 进程管理（Process/Thread/ProcessGroup/Session）
│       ├── axsignal         # 信号子系统
│       ├── syscalls         # 系统调用号枚举定义
│       ├── axdriver_*       # 驱动（virtio/block/net/pci/display/base）
│       ├── page_table_*     # 多架构页表
│       ├── scheduler        # 调度器
│       ├── smoltcp          # TCP/IP 协议栈
│       ├── fatfs/lwext4_rust # 文件系统实现
│       ├── allocator        # 分配器
│       └── linked_list/weak-map # 数据结构
│
├── configs/                 # 平台配置文件 (TOML)
│   ├── x86_64.toml
│   ├── aarch64.toml
│   ├── riscv64.toml
│   └── loongarch64.toml
│
├── apps/                    # 用户态测例
│   ├── junior/              # 最小测试集（brk/chdir/clone）
│   ├── libc/                # libc 测试（helloworld/signal/mmap/sleep）
│   ├── nimbos/              # NimbOS 测试集（C + Rust 双语言）
│   └── oscomp/              # 比赛测例编排（basic/busybox/iozone/iperf/ltp/lua 等）
│
├── scripts/                 # 构建/测试辅助脚本
│   ├── make/oscomp.mk       # 比赛构建规则
│   ├── get_deps.sh          # 获取 ArceOS 依赖
│   ├── set_ax_root.sh       # 设置 ArceOS 根路径
│   ├── testcase_list_gen.py # 测例列表生成
│   └── oscomp_test.sh       # 线上测试脚本
│
└── docs/                    # 文档
    ├── submission/          # 提交材料
    ├── design-and-source.md
    ├── progress-log.md
    └── test-tracker.md
```

## 3. 子系统划分

经初步分析，该项目实现的子系统如下：

| 子系统 | 负责目录/代码 | 依赖的 ArceOS 模块 | 功能概述 |
|--------|-------------|-------------------|---------|
| **系统调用分发** | `src/syscall.rs` | axhal (TrapFrame) | 统一系统调用入口，处理约 102 个 Linux sysno |
| **进程管理** | `core/src/task.rs`, `api/src/imp/task/`, `vendor/cargo/axprocess/` | axprocess, axtask, axns | fork/execve/clone/exit/wait、进程树、进程组、会话 |
| **线程管理** | `core/src/task.rs` (ThreadData) | axtask, axprocess | 线程创建、set_tid_address、robust_list |
| **内存管理** | `core/src/mm.rs`, `api/src/imp/mm/`, `src/mm.rs` | axmm, axalloc | ELF加载、mmap/brk/mprotect/munmap、缺页处理、用户地址空间 |
| **文件系统** | `api/src/imp/fs/`, `api/src/file/` | axfs | open/read/write/stat/mount/pipe/ioctl/getdents、VFS |
| **信号** | `api/src/imp/signal.rs`, `api/src/signal.rs`, `vendor/cargo/axsignal/` | axsignal | kill/tkill/rt_sigaction/rt_sigreturn/rt_sigprocmask |
| **Futex** | `core/src/futex.rs`, `api/src/imp/futex.rs` | axtask (WaitQueue) | futex_wait/futex_wake、进程级 futex 表 |
| **网络** | `api/src/imp/fs/socket.rs`, `api/src/socket.rs`, `api/src/file/net.rs` | axnet | socket/bind/listen/connect/accept/sendto/recvfrom |
| **时间** | `core/src/time.rs`, `api/src/imp/time.rs` | axhal (timer) | nanosleep/gettimeofday/times、进程时间统计与定时器 |
| **管道** | `api/src/imp/fs/pipe.rs`, `api/src/file/pipe.rs` | axfs | pipe/pipe2 匿名管道 |
| **同步原语** | `vendor/arceos/modules/axsync/` | (自包含) | Mutex、自旋锁等 |
| **设备驱动** | `vendor/cargo/axdriver_*`, `vendor/arceos/modules/axdriver/` | axhal | VirtIO (block/net)、PCI、IXGBE、Display |
| **硬件抽象** | `vendor/arceos/modules/axhal/` | (自包含) | 中断处理、内存属性、架构特定代码（x86_64/aarch64/riscv/loongarch64） |
| **运行时** | `vendor/arceos/modules/axruntime/` | axhal, axlog | 语言项、启动流程、多核支持 |
| **日志** | `vendor/arceos/modules/axlog/` | (自包含) | 内核日志输出 |

### 子系统分层关系（粗略）

```
┌──────────────────────────────────────┐
│        src/  (内核入口 & 粘合层)        │
│   main.rs / entry.rs / syscall.rs    │
└──────────┬──────────────┬────────────┘
           │              │
    ┌──────▼──────┐ ┌─────▼──────┐
    │  starry-api  │ │ starry-core │
    │ (系统调用实现)│ │(核心内核逻辑)│
    └──────┬──────┘ └─────┬──────┘
           │              │
    ┌──────▼──────────────▼──────┐
    │   axprocess / axsignal     │  (进程 & 信号扩展)
    └────────────┬───────────────┘
                 │
    ┌────────────▼───────────────┐
    │   ArceOS 基础模块           │
    │ axhal/axmm/axtask/axfs/    │
    │ axnet/axalloc/axsync/...   │
    └────────────────────────────┘
```

## 4. 编译构建工具需求

根据 `Makefile`、`Cargo.toml`、`build.rs`、`scripts/make/oscomp.mk` 的分析：

| 工具 | 用途 | 必需 |
|------|------|------|
| **Rust 工具链** (rustc, cargo, rustup) | 编译内核主体。比赛构建使用 `nightly-2025-05-20` | 是 |
| **GNU Make** | 顶层构建编排 | 是 |
| **rust-objcopy** (cargo-binutils) | RISC-V 平台 ELF 格式转换 | 是（RISC-V） |
| **rust-lld** (Rust 自带 LLVM linker) | RISC-V 平台链接 | 是（RISC-V） |
| **Python 3** | 测例列表生成脚本 | 是 |
| **wget / gunzip** | 下载比赛评测磁盘镜像 | 否（仅 oscomp_run） |
| **mkfs.ext4 / mkfs.vfat** | 制作文件系统镜像 | 否（仅本地调试） |
| **QEMU** | 模拟运行内核 | 否（仅运行/调试） |
| **OpenSBI / RustSBI** | RISC-V SBI 固件 | 否（仅运行/调试） |
| **dtc** (Device Tree Compiler) | 设备树编译 | 否（仅特定平台运行） |

**构建流程简述**：`make all` 触发 `oscomp_build`，会先通过 `oscomp_testcase_list` 生成测例列表，然后调用 ArceOS 的 Makefile（`vendor/arceos/Makefile`）执行实际的 `cargo build`。RISC-V 平台会有额外的 `rust-objcopy` + `rust-lld` 步骤将原始二进制包装为 ELF。构建依赖通过 Cargo 的 `[patch]` 机制全部指向本地 `vendor/` 目录，不需要网络下载。