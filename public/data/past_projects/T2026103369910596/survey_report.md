# CosmOS 内核项目初步分析报告

## 一、项目概览

**CosmOS** 是一个使用 Rust 语言编写的微内核操作系统，支持 **RISC-V 64** 和 **LoongArch 64** 两种指令集架构。项目整体规模约 **59,000 行内核代码**，外加 **15,000 行文件系统库代码** 和 **7,000 行用户程序代码**（共约 219 个 Rust 源文件）。

---

## 二、仓库顶层文件组织结构

```
repo/
├── os/                    # 内核源码 (核心)
├── fs/                    # 文件系统库 (独立 crate)
├── fs-fuse/               # FUSE 用户态工具 (制作磁盘镜像)
├── user/                  # 用户态程序与用户库
├── bootloader/            # 引导固件 (RustSBI + LoongArch 自定义 boot)
├── CosmOS-rootfs/         # 根文件系统构建基础设施 (busybox/bash 等)
├── vendor/                # 第三方依赖 (riscv crate, smoltcp)
├── scripts/               # 辅助脚本 (镜像打包、评估导出)
├── test/                  # 测试脚本 (LTP runner, TCP 测试)
├── docs/                  # 文档与 TODO 记录
├── ci/                    # CI Docker 构建文件
├── .github/               # GitHub CI 工作流
├── .devcontainer/         # 开发容器配置
├── .vscode/               # VS Code 配置
├── Makefile               # 顶层构建编排
├── rust-toolchain.toml    # Rust 工具链版本锁定
├── README.md              # 项目简介
└── 初赛报告/              # 比赛报告目录
```

---

## 三、子系统划分

### 1. 内核核心 (`os/src/`)

内核源码按功能模块清晰分层：

| 目录/文件 | 所属子系统 | 职责简述 |
|-----------|-----------|---------|
| `arch/` | **架构抽象层** | RISC-V 和 LoongArch 的入口、页表、陷阱、上下文切换、hart 管理 |
| `platform/` | **平台/板级层** | QEMU virt 平台适配 (MMIO 布局、中断路由、设备探测、SMP 启动) |
| `hal/` | **硬件抽象层** | 定义架构无关的 trait 接口 (中断控制、定时器、陷阱机、页表) |
| `drivers/` | **设备驱动** | virtio-blk、virtio-net、NS16550A UART、PLIC 中断控制器 |
| `mm/` | **内存管理** | 帧分配器、堆分配器、页表、内存集 (VMA)、OOM、TLB shootdown |
| `task/` | **任务/进程管理** | ProcessControlBlock、TaskControlBlock、PID 分配、等待队列 |
| `sched/` | **调度器** | CFS/FIFO 调度策略、运行队列、处理器管理、autogroup、上下文切换 |
| `syscall/` | **系统调用** | 约 15 个分类文件：fs、net、process、signal、sync、mmap、sched、thread、times、random、resource、key、errno、utils |
| `fs/` | **内核 VFS 层** | inode 管理、页缓存、管道、stdio，以及 procfs/devfs/sysfs/tmpfs/cgroupfs/tty 特殊文件系统 |
| `net/` | **网络栈** | 基于 smoltcp：TCP、UDP、Unix socket、loopback、raw IPv6、AF_ALG、socket 超时 |
| `sync/` | **同步原语** | 互斥锁、自旋锁、条件变量、信号量、futex、睡眠锁、死锁检测 |
| `signal/` | **信号处理** | POSIX 信号发送/等待/处理 |
| `trap/` | **陷阱处理** | 中断/异常入口分发、IRQ 管理、trap 上下文 |
| `timer.rs` | **定时器** | 内核定时器堆、RTC 支持 |
| `ipc.rs` | **进程间通信** | System V 共享内存 |
| `keys.rs` | **密钥管理** | 内核 key/keyring (兼容 LTP 测试) |
| `poll.rs` | **事件轮询** | ppoll/epoll 等待注册表 |
| `klog.rs` | **内核日志** | syslog 环形缓冲区 |
| `random.rs` | **随机数** | ChaCha20 PRNG |
| `perf_probe.rs` | **性能探测** | 低开销命名计时探针 |
| `perf_sampler.rs` | **性能采样** | 周期性的内存压力/系统状态采样 |
| `bootinfo.rs` | **启动信息** | 设备树 (FDT) 解析 |
| `sbi.rs` | **SBI 调用** | RISC-V SBI 封装 |
| `config.rs` | **内核配置** | 常量定义 (栈大小、内存布局等) |
| `console.rs` | **控制台** | 多核安全的控制台输出 |
| `lang_items.rs` | **语言项** | panic handler、backtrace |
| `main.rs` | **内核入口** | rust_main() 启动流程 |

### 2. 文件系统库 (`fs/src/`)

独立的 `no_std` crate，提供文件系统实现：

| 目录/文件 | 职责 |
|-----------|------|
| `vfs.rs` | 虚拟文件系统接口 (Inode trait) |
| `block_cache.rs` | 块缓存层 |
| `block_dev.rs` | 块设备抽象 |
| `dentry_cache.rs` | 目录项缓存 |
| `inode_cache.rs` | Inode 缓存 |
| `easyfs/` | 自研简易文件系统 (参考 rCore) |
| `ext4/` | ext4 文件系统 |
| `ext4_rs/` | ext4 的纯 Rust 实现 |
| `fat32/` | FAT32 文件系统 |
| `sleep_mutex.rs` | FS 层锁机制 |

### 3. 用户态 (`user/src/`)

| 目录/文件 | 职责 |
|-----------|------|
| `src/bin/*.rs` (31 个) | 用户测试程序：shell、ls、mkdir、rm、fstest、tcp_echo_server、mmap_test 等 |
| `src/lib.rs` | 用户库 (syscall 封装) |
| `src/syscall.rs` | 用户态系统调用接口 |
| `src/console.rs` | 用户态控制台输出 |
| `src/net.rs` | 用户态网络辅助 |
| `src/lang_items.rs` | 用户态 panic handler |

### 4. 工具与基础设施

| 目录 | 职责 |
|------|------|
| `fs-fuse/` | 基于 FUSE 的磁盘镜像打包工具 (支持 easyfs/fat32/ext4) |
| `bootloader/` | RISC-V RustSBI 固件 (v7.0.0 / v10.1.3) + LoongArch 自定义直接引导 bootloader |
| `CosmOS-rootfs/` | 使用 musl 交叉编译的根文件系统 (busybox、bash、coreutils 等 13 个包) |
| `scripts/` | 磁盘镜像打包、评估树导出 |
| `test/` | LTP 测试运行器、TCP 服务器/洪水测试、内存追踪分析 |

---

## 四、构建系统与所需工具

### 构建工具链

1. **Rust 工具链**：`nightly-2025-01-18`，包含 `llvm-tools-preview`，目标架构 `riscv64gc-unknown-none-elf`
2. **RISC-V 交叉编译**：RISC-V musl GCC 工具链 (rootfs 构建)
3. **LoongArch 交叉编译**：LoongArch musl GCC + glibc 工具链 (rootfs 构建)
4. **cargo-binutils**：用于 `rust-objcopy`、`rust-objdump`
5. **QEMU**：`qemu-system-riscv64` 和 `qemu-system-loongarch64`
6. **GNU Make**：顶层 Makefile 驱动全量构建

### 构建流程

- 顶层 `Makefile` 支持 `BUILD_ARCH=rv|la|all` 控制目标架构
- 内核通过 `os/Makefile` 构建 (cargo build，支持 `ext4/easyfs/fat32` 三种主文件系统特性)
- 用户程序 `user/Makefile` 构建为独立 ELF → strip 为二进制
- `fs-fuse` 将用户二进制注入磁盘镜像 (ext4/fat32/easyfs)
- `CosmOS-rootfs/Makefile` 构建 musl/glibc rootfs (busybox + 12 个 GNU 工具包)
- RISC-V 使用 RustSBI + kernel binary 启动；LoongArch 使用自定义 bootloader + kernel ELF 直接引导

---

## 五、初步评估要点

1. **架构完善度较高**：内核覆盖了内存管理、进程/线程管理、VFS、网络栈、信号、同步原语、多种文件系统等现代 OS 核心子系统。
2. **双架构支持**：RISC-V 64 和 LoongArch 64 通过清晰的 `arch/` + `platform/` + `hal/` 三层抽象实现。
3. **文件系统丰富**：自研 easyfs、ext4 (纯 Rust 实现)、FAT32 三种磁盘文件系统，外加 procfs/devfs/sysfs/tmpfs/cgroupfs 等多种内存文件系统。
4. **网络栈完整**：基于 smoltcp 实现了 TCP/UDP/Unix Socket/IPv6/AF_ALG。
5. **测试基础设施**：LTP 测试框架集成、性能采样/探测机制、内存追踪。
6. **外部依赖**：依赖 vendored 的 `riscv` 和 `smoltcp` crate，以及多个 crates.io 上的标准 Rust 库。