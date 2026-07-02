## 项目结构分析报告

### 1. 项目概述

该项目名为 **PulseOS**，是一个基于 ArceOS 组件化内核框架构建的、面向 RISC-V 64 和 LoongArch 64 双架构的组件化宏内核操作系统。项目使用 Rust 语言编写，采用 Cargo workspace 管理多 crate 结构，Rust 工具链要求为 `nightly-2025-05-20`。

---

### 2. 仓库文件组织结构

```
repo/
├── Cargo.toml              # 工作区根清单 (workspace: pulse_core, pulse_syscalls)
├── Cargo.lock
├── Makefile                # 顶层构建入口
├── rustfmt.toml
├── README.md
├── build_img.sh            # 根文件系统镜像构建脚本
├── add_apk_to_rootfs.sh    # APK 注入到 rootfs 的工具脚本
├── src/
│   └── main.rs             # 内核入口：初始化各子系统后加载 /bin/sh 用户进程
├── pulse_core/             # PulseOS 核心库：进程管理、文件描述符、IPC、网络等
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── config.rs
│       ├── trap.rs
│       ├── fd_table.rs
│       ├── flock.rs
│       ├── cpu_dma_latency.rs
│       ├── ipc/            # 信号量(sem.rs) + 共享内存(shm.rs)
│       ├── mm/             # ELF loader (loader.rs)
│       ├── net/            # 套接字抽象与 TCP/UDP 状态机
│       └── task/           # 进程(process.rs)、线程(thread.rs)、信号(signal.rs)、exec(exec.rs)
├── pulse_syscalls/         # 系统调用接口层：处理分发 + 分类实现
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── handler.rs      # 系统调用统一派发入口 (syscall_handler)
│       └── impls/
│           ├── mod.rs
│           ├── fs/         # 文件/目录/epoll 系统调用 (io.rs, path.rs, meta.rs, epoll.rs...)
│           ├── ipc/        # IPC 系统调用 (sem.rs, shm.rs)
│           ├── net/        # 网络套接字系统调用 (socket.rs, io.rs, opt.rs, addr.rs...)
│           ├── task/       # clone/exec/wait/exit/schedule 等系统调用
│           ├── mm.rs       # 内存分配与映射系统调用 (mmap, brk 等)
│           ├── time.rs     # 定时器与时间相关系统调用
│           ├── misc.rs     # 杂项系统调用
│           ├── futex.rs    # futex 系统调用
│           └── utils.rs
├── arceos/                 # ArceOS 上游内核底座 (嵌入为本项目子目录)
│   ├── Cargo.toml          # 独立 workspace
│   ├── Makefile
│   ├── rust-toolchain.toml
│   ├── api/                # 对外 API: axfeat, arceos_api, arceos_posix_api
│   ├── ulib/               # 用户库: axstd, axlibc
│   ├── modules/            # 内核组件
│   │   ├── axalloc         # 动态内存分配器
│   │   ├── axconfig        # 编译期配置
│   │   ├── axdisplay       # 显示设备抽象
│   │   ├── axdma           # DMA 支持
│   │   ├── axdriver        # 外设驱动框架 (virtio, PCI, MMIO 总线)
│   │   ├── axfs            # 虚拟文件系统 (VFS) 与设备挂载
│   │   ├── axhal           # 硬件抽象层 (内存、中断、页表、TLS、时间)
│   │   ├── axipi           # 核间中断 (IPI)
│   │   ├── axlog           # 日志系统
│   │   ├── axmm            # 虚拟内存管理与页表映射
│   │   ├── axnet           # 网络协议栈 (基于 smoltcp)
│   │   ├── axns            # 命名空间抽象
│   │   ├── axruntime       # 内核启动与运行时环境 (lang_items, mp, vdso)
│   │   ├── axsync          # 同步原语 (Mutex, RwLock)
│   │   └── axtask          # 任务控制与调度 (含 TaskInner, WaitQueue, timer)
│   ├── configs/            # 平台构建配置 (含 x86_64-pc-oslab 自定义配置)
│   ├── examples/           # 示例应用 (helloworld, httpclient, httpserver, shell)
│   ├── scripts/            # make 辅助脚本、网络配置脚本
│   └── tools/              # 平台工具 (raspi4, phytium_pi 等)
├── crates/                 # 第三方定制化依赖 (patch 覆盖上游 crate)
│   ├── allocator/          # 内存分配器 (TLSF 等)
│   ├── axcpu/              # CPU 抽象
│   ├── axsched/            # 调度器算法 (统一接口, 含 RR 等)
│   ├── axio/               # I/O 抽象
│   ├── axfs-ng-vfs/        # 下一代 VFS 框架
│   ├── axplat-riscv64-qemu-virt/      # RISC-V 64 平台适配
│   ├── axplat-loongarch64-qemu-virt/  # LoongArch 64 平台适配
│   ├── ext4plus/           # 纯 Rust ext4 文件系统实现
│   ├── memory_addr/        # 虚拟/物理地址抽象
│   ├── memory_set/         # 内存集合抽象
│   ├── page_table_multiarch/ # 多架构页表支持
│   ├── smoltcp/            # 网络协议栈 (定制版)
│   ├── virtio-drivers/     # VirtIO 驱动
│   └── starry-vdso/        # vDSO 加速机制
├── vendor/                 # vendored 第三方依赖 (大量 Rust crate)
├── bin/                    # 预编译工具
│   ├── axconfig-gen        # 配置生成工具 (x86-64 ELF)
│   ├── cargo-axplat        # 平台选择辅助脚本
│   ├── rust-objcopy        # llvm-objcopy 封装
│   └── rust-objdump        # llvm-objdump 封装
├── rootfs/                 # 根文件系统内容
│   ├── base/               # 基础 Alpine minirootfs
│   ├── extras/             # 额外包
│   └── overlay/            # 覆盖层
└── docs/                   # 设计文档 (PulseOS初赛设计文档.pdf/.txt)
```

---

### 3. 子系统划分与归属

| 子系统 | 主要目录/文件 | 摘要 |
|---|---|---|
| **进程管理** | `pulse_core/src/task/process.rs` (3193行), `pulse_core/src/task/thread.rs`, `pulse_core/src/task/exec.rs` | 进程创建(fork/clone)、ELF加载、地址空间管理、线程注册、进程组管理 |
| **信号系统** | `pulse_core/src/task/signal.rs` (1013行) | 信号发送、递送、阻塞/未决掩码、sigaction、默认信号处理 |
| **任务调度** | `arceos/modules/axtask/`, `crates/axsched/` | 底层任务调度 (RR调度)、TaskInner、WaitQueue、定时器 |
| **系统调用** | `pulse_syscalls/` (约15386行) | 统一系统调用分发 + 按功能域分类实现 (fs/task/mm/net/ipc/time/futex/misc) |
| **文件系统 (VFS)** | `arceos/modules/axfs/`, `crates/axfs-ng-vfs/`, `crates/ext4plus/`, `pulse_core/src/fd_table.rs` (2431行) | VFS框架、ext4实现、文件描述符表、FdObject抽象、文件锁(flock) |
| **内存管理** | `arceos/modules/axmm/`, `arceos/modules/axalloc/`, `pulse_core/src/mm/loader.rs`, `crates/page_table_multiarch/`, `crates/memory_addr/`, `crates/memory_set/` | 虚拟内存管理、页表映射、动态分配(TLSF)、ELF加载器、用户态内存映射(mmap/brk) |
| **网络子系统** | `arceos/modules/axnet/`, `crates/smoltcp/`, `pulse_core/src/net/mod.rs` (981行), `pulse_syscalls/src/impls/net/` | smoltcp协议栈集成、套接字抽象、TCP/UDP/Netlink状态机、socket系统调用 |
| **硬件抽象层 (HAL)** | `arceos/modules/axhal/`, `crates/axplat-riscv64-qemu-virt/`, `crates/axplat-loongarch64-qemu-virt/` | 中断处理、页表操作、TLS、percpu、时间、启动引导、控制台 |
| **驱动框架** | `arceos/modules/axdriver/`, `crates/virtio-drivers/` | VirtIO块设备/网络驱动、PCI/MMIO总线、ixgbe网卡驱动 |
| **同步原语** | `arceos/modules/axsync/`, `crates/axcpu/` | Mutex、RwLock、自旋锁、内核守卫 |
| **IPC** | `pulse_core/src/ipc/` (sem.rs, shm.rs), `pulse_syscalls/src/impls/ipc/` | System V信号量、共享内存 |
| **时间管理** | `arceos/modules/axhal/src/time.rs`, `pulse_syscalls/src/impls/time.rs` | 单调时钟、定时器、itimerspec、nanosleep |
| **日志系统** | `arceos/modules/axlog/` | 内核日志输出 |
| **vDSO** | `crates/starry-vdso/`, `arceos/modules/axruntime/src/vdso.rs` | vDSO数据初始化与更新、系统调用加速 |
| **命名空间** | `arceos/modules/axns/` | 命名空间抽象 |
| **显示** | `arceos/modules/axdisplay/` | 显示设备抽象 |
| **DMA** | `arceos/modules/axdma/` | DMA 支持 |
| **IPI** | `arceos/modules/axipi/` | 核间中断 |
| **配置系统** | `arceos/modules/axconfig/`, `arceos/api/axfeat/`, `arceos/configs/` | 编译期特性开关与平台配置 |

---

### 4. 编译构建工具需求

根据 Makefile 和 Cargo.toml 分析，构建 PulseOS 需要：

| 工具 | 用途 | 当前环境 |
|---|---|---|
| **Rust 工具链** `nightly-2025-05-20` | 编译内核 (需 `rust-src`, `llvm-tools` 组件) | 环境已有 Rust 工具链 |
| **目标三元组** `riscv64gc-unknown-none-elf` | RISC-V 64 裸机目标 | 环境有 RISC-V 交叉编译工具链 |
| **目标三元组** `loongarch64-unknown-none-softfloat` | LoongArch 64 裸机目标 | 环境有 LoongArch 交叉编译工具链 |
| **axconfig-gen** | 从 `.axconfig.toml` 生成编译期配置常量 | `bin/axconfig-gen` (预编译 x86-64 ELF) |
| **cargo-axplat** | 平台 crate 选择辅助工具 | `bin/cargo-axplat` (bash 脚本) |
| **rust-objcopy / rust-objdump** | 内核二进制处理 (strip, objcopy) | `bin/` 下为 llvm-tools 封装脚本 |
| **GNU Make** | 顶层构建编排 | 环境已有 |
| **mkfs.ext4, mcopy, dd** 等 | 根文件系统镜像制作 (`build_img.sh`) | 环境已有 |
| **OpenSBI / RustSBI** | RISC-V SBI 固件 (QEMU 运行时) | 环境已有 |

构建流程以 Makefile 驱动，支持 `make all`（双架构构建+镜像）、`make test`、`make run`、`make debug` 等目标。默认目标架构为 `riscv64`，可通过 `ARCH=loongarch64` 切换。`arceos/` 子目录有独立的 Makefile，被顶层 Makefile 通过递归调用驱动。