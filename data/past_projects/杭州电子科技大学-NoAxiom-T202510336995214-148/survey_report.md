# NoAxiom-OS 项目初步分析报告

## 一、项目概述

NoAxiom-OS 是由杭州电子科技大学 NoAxiom 团队开发的基于 Rust 的宏内核操作系统，面向 OS 内核比赛。该项目支持 **RISC-V64** 和 **LoongArch64** 两种指令集架构，核心特色是基于 Rust 无栈协程实现的**异步调度**。比赛决赛总分位列第7，性能相关测试点总分位列第2，其中 iperf 网络性能测试位列第1。

项目实现了 **115 个系统调用**，覆盖文件系统、IO、网络、进程管理、信号处理、内存管理、调度管理、时间管理等领域。

---

## 二、仓库文件组织结构

```
./
├── Makefile              # 顶层构建入口，协调内核、用户态、测试镜像的构建与运行
├── config.mk             # 构建配置文件（自动生成）
├── rust-toolchain.toml   # Rust 工具链配置（nightly-2024-05-01）
├── rustfmt.toml          # Rust 代码格式化配置
├── README.md             # 项目说明文档
├── LICENSE               # 许可证
├── docs/                 # 比赛相关文档（PPT、PDF、截图等）
├── NoAxiom/              # 内核主目录（Rust workspace）
│   ├── Cargo.toml        # Workspace 定义
│   ├── .cargo/           # Cargo 配置（vendor 源）
│   ├── kernel/           # 内核主 crate
│   │   ├── Cargo.toml
│   │   ├── Makefile
│   │   └── src/          # 内核源码（221 个 .rs 文件）
│   ├── lib/              # 内核依赖的内部库（135 个 .rs 文件，不含 vendor）
│   │   ├── arch/         # 指令集架构抽象层
│   │   ├── config/       # 内核全局配置
│   │   ├── driver/       # 驱动框架
│   │   ├── driver_ahci/  # AHCI 驱动
│   │   ├── fatfs/        # FAT32 文件系统实现
│   │   ├── include/      # 公共类型定义（errno 等）
│   │   ├── kfuture/      # 内核异步 Future 工具
│   │   ├── ksync/        # 内核同步原语（异步锁、信号量等）
│   │   ├── memory/       # 物理内存管理（帧分配器、堆）
│   │   ├── platform/     # 平台抽象层
│   │   └── scripts/      # 链接脚本生成脚本
│   └── vendor/           # 第三方依赖（vendored）
└── user/                 # 用户态程序
    ├── Makefile
    ├── .cargo/
    ├── apps/             # 用户态应用
    │   ├── run_busybox/  # busybox 启动器
    │   └── run_tests/    # 测试用例启动器
    ├── libd/             # 用户态运行时库（30 个 .rs 文件）
    │   └── src/
    │       ├── arch/     # 架构相关入口与系统调用
    │       ├── syscall/  # 系统调用封装
    │       └── ...       # 堆、控制台、ioctl 等
    └── vendor/           # 用户态第三方依赖（vendored）
```

---

## 三、子系统划分与目录映射

### 1. 进程与任务管理子系统
- **目录**: `kernel/src/task/`（18 个文件）
- **内容**: PCB（进程控制块）、TCB（任务控制块）、fork、execve、exit、wait、futex、任务管理器、任务状态等
- **系统调用入口**: `kernel/src/syscall/process.rs`、`kernel/src/syscall/sched.rs`

### 2. 调度子系统
- **目录**: `kernel/src/sched/`（8 个文件）
- **内容**: CFS 调度器（`cfs/`）、调度实体、调度器抽象、协程运行时（runtime）、spawn、虚拟调度器
- **特点**: 基于无栈协程的异步分时多任务调度，支持任务优先级

### 3. 内存管理子系统
- **目录**: `kernel/src/mm/`（8 个文件）+ `lib/memory/`（5 个文件）
- **内容**: 页表管理、内存区域映射（map_area）、mmap 管理、共享内存（shm）、用户指针校验、写时复制、懒分配
- **底层**: `lib/memory/` 提供物理帧分配器、堆分配器、地址抽象

### 4. 文件系统子系统
- **目录**: `kernel/src/fs/`（约 80+ 个文件，含 VFS 实现）
- **结构**:
  - `vfs/basic/` — VFS 抽象层（dentry、inode、file、filesystem、superblock）
  - `vfs/impls/ext4/` — EXT4 文件系统适配
  - `vfs/impls/rust_fat32/` — FAT32 文件系统适配
  - `vfs/impls/ramfs/` — 内存文件系统
  - `vfs/impls/proc/` — procfs（/proc 伪文件系统，含 exe、fd、maps、meminfo、mounts、stat、status）
  - `vfs/impls/devfs/` — devfs（/dev 设备文件系统，含 null、zero、urandom、tty、rtc、loop 设备）
  - `pipe.rs` — 管道
  - `pagecache.rs` — 页缓存
  - `blockcache.rs` — 块缓存
  - `fdtable.rs` — 文件描述符表
  - `path.rs` — 路径解析
- **外部库**: `lib/fatfs/`（自研 FAT32 实现）、vendor 中的 `ext4_rs`

### 5. 网络子系统
- **目录**: `kernel/src/net/`（9 个文件）
- **内容**: TCP/UDP 套接字、socket 管理、端口管理、socket 集合、poll 支持
- **底层**: 依赖 vendor 中的 `smoltcp` 网络协议栈（支持 IPv4/IPv6、DHCP）

### 6. IO 多路复用子系统
- **目录**: `kernel/src/io/`（3 个文件）
- **内容**: ppoll、pselect 实现

### 7. 信号子系统
- **目录**: `kernel/src/signal/`（9 个文件）
- **内容**: 信号管理器、信号动作、信号集、信号栈、信号信息、可中断系统调用支持

### 8. 时间管理子系统
- **目录**: `kernel/src/time/`
- **内容**: 时间结构定义、定时功能

### 9. 系统调用分发
- **目录**: `kernel/src/syscall/`（13 个文件）
- **内容**: 按功能域分文件（fs、io、mm、net、process、sched、signal、system、time、others），统一通过 `syscall.rs` 中的 match 表分发

### 10. 硬件抽象层（HAL）
- **目录**: `lib/arch/`（约 30 个文件）
- **结构**:
  - `common/` — 统一 trait 定义（asm、boot、interrupt、memory、time、trap 等）
  - `rv64/` — RISC-V64 具体实现（含 trap.S 汇编）
  - `la64/` — LoongArch64 具体实现（含 trap.S、tlb.S 汇编）

### 11. 驱动子系统
- **目录**: `lib/driver/`（约 15 个文件）+ `lib/driver_ahci/`
- **内容**: 驱动框架（HAL 抽象、设备嗅探、DTB/PCI 探测、设备管理器）、AHCI 块设备驱动
- **外部**: vendor 中的 `virtio-drivers-async`（异步 virtio 驱动）

### 12. 平台抽象层
- **目录**: `lib/platform/`
- **内容**: 平台相关内存初始化、QEMU/物理开发板差异封装

### 13. 内核同步原语库
- **目录**: `lib/ksync/`
- **内容**: 异步 Mutex、RwLock、Semaphore、Barrier、OnceCell 等

### 14. 内核异步工具库
- **目录**: `lib/kfuture/`
- **内容**: block、suspend、yield_fut、take_waker 等异步 Future 工具

### 15. 中断/异常处理
- **目录**: `kernel/src/trap/`（5 个文件）
- **内容**: 内核态陷阱处理、用户态陷阱处理、外部中断、软中断

### 16. 用户态
- **目录**: `user/`
- **内容**: 用户态运行时库 `libd`（系统调用封装、堆管理、控制台、架构入口）、启动应用（run_busybox、run_tests）

---

## 四、构建工具需求

| 工具类别 | 具体工具 | 用途 |
|---------|---------|------|
| **Rust 工具链** | rustc (nightly-2024-05-01)、cargo、rust-src、llvm-tools-preview、rust-objcopy | 内核与用户态编译 |
| **RISC-V 交叉工具链** | riscv64-unknown-elf-objdump、rust-objcopy (binary-architecture=riscv64) | RISC-V 目标二进制生成 |
| **LoongArch 交叉工具链** | loongarch64-linux-gnu-objdump、loongarch64-linux-gnu-objcopy | LoongArch 目标二进制生成 |
| **QEMU** | qemu-system-riscv64、qemu-system-loongarch64 | 内核运行与测试 |
| **SBI 固件** | OpenSBI (RISC-V default bios) | RISC-V 启动引导 |
| **链接脚本生成** | bash 脚本 (`lib/scripts/mk_ld.sh`) | 生成架构相关链接脚本 |
| **文件系统镜像** | dd、mkfs 等（通过测试目录 Makefile 调用） | 生成测试用文件系统镜像 |
| **构建系统** | GNU Make | 顶层构建协调 |
| **Git** | git (含 submodule、LFS) | 依赖管理与测试用例获取 |
| **Docker** | docker（可选） | 非 Linux 环境下的构建环境 |

目标编译 target：
- RISC-V64: `riscv64gc-unknown-none-elf`
- LoongArch64: `loongarch64-unknown-linux-gnu`

内核以 `no_std` + `no_main` 模式编译，release 模式下 opt-level=3，panic 策略为 abort。