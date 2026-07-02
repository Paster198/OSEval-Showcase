## 项目初步调查结果

### 1. 项目概览

**项目名称**：Kairix OS（参赛作品名"Unicus"）

**项目性质**：采用 Rust 编写的宏内核（monolithic kernel）操作系统，支持 RISC-V 64 位（riscv64gc）和 LoongArch 64 位双架构。项目依赖 polyhal 硬件抽象层，理论上可扩展到 AArch64 和 x86_64。

**代码规模**（不含 vendor 和 .git）：
- Rust 源文件：约 341 个，合计约 79,553 行
- C 源文件：约 177 个，合计约 109,075 行（主要来自 lwext4 C 库）
- 汇编文件：约 9 个，合计约 1,130 行

---

### 2. 顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `os/` | **内核主体**，包含所有核心子系统 |
| `user/` | 用户态程序（initproc、shell、测试用例等） |
| `polyhal/` | 硬件抽象层（多架构支持、页表、中断、定时器等） |
| `bootloader/` | SBI 固件二进制（RustSBI for QEMU） |
| `lwext4_rust/` | ext4 文件系统的 Rust 绑定（含 lwext4 C 库） |
| `tools/` | 构建辅助工具（mkfs 工具链、SD 卡镜像注入脚本等） |
| `patches/` | 第三方库补丁（cty crate） |
| `iperf/` | iperf3 网络性能测试工具源码 |
| `netperf-2.7.0/` | netperf 网络性能测试工具源码 |
| `rust-fatfs/` | 空目录（fatfs 已 vendored 到 os/vendor） |
| `docs/` | 项目文档（架构图、设计说明等） |
| `Makefile` | 顶层 Makefile，委托到 `os/Makefile` |

---

### 3. 子系统划分

#### 3.1 内核核心 (`os/src/`)

| 子系统 | 目录/文件 | 功能简述 |
|---|---|---|
| **架构入口** | `arch/riscv_dir/`, `arch/loongarch_dir/` | 各架构的启动入口（`entry.rs`） |
| **内存管理** | `mm/` | 页帧分配器、堆分配器、VM 区间管理、VM 空间管理、KSM（内核同页合并）、页面回收、交换 |
| **任务管理** | `task/` | 进程（`process.rs`）、线程、调度器、上下文切换、任务 ID 管理、信号处理 |
| **系统调用** | `syscall/` | 分派各类系统调用：文件系统（`fs.rs`, 187KB）、进程（`process.rs`, 62KB）、网络（`net.rs`）、内存（`mm.rs`）、信号、futex、共享内存、管道、landlock、fanotify、inotify 等 |
| **同步原语** | `sync/mutex/` | 自旋锁（`spin_mutex`）、睡眠锁（`sleep_mutex`）、可重入锁（`remutex`） |
| **陷阱/异常** | `trap/` | 陷阱帧、异常处理、上下文保存/恢复（含汇编） |
| **定时器** | `timer.rs` | 时钟中断与定时器管理 |
| **控制台** | `console.rs` | 串口控制台输出 |
| **SBI 接口** | `sbi.rs`, `sbi_la.rs` | RISC-V SBI / LoongArch 固件调用封装 |
| **板级支持** | `boards/qemu.rs` | QEMU 平台板级配置 |
| **设备管理** | `devices/` | 设备抽象与管理 |

#### 3.2 文件系统 (`os/src/fs/`)

| 子模块 | 目录 | 功能简述 |
|---|---|---|
| **VFS** | `vfs/` | 虚拟文件系统层：dentry、inode、file、superblock、dcache、路径解析、文件类型 |
| **FAT32** | `fat32/` | FAT32 文件系统实现（基于 vendored fatfs） |
| **ext4** | `lwext4/` | ext4 文件系统（基于 lwext4_rust C 绑定） |
| **devfs** | `devfs/` | 设备文件系统：tty、null、zero、urandom、rtc、loop、cpu_dma_latency 等 |
| **procfs** | `procfs/` | 进程信息伪文件系统：status、maps、smaps、cgroups、meminfo、mounts、pagmap 等 |
| **sysfs** | `sysfs/` | sysfs 块设备信息 |
| **tmpfs** | `tmpfs/` | 内存文件系统 |
| **etc** | `etc/` | 系统配置虚拟文件（passwd、group、hosts、localtime 等） |
| **页面缓存** | `page/` | pagecache 实现 |
| **回写** | `writeback.rs` | 脏页回写机制 |
| **管道** | `pipe.rs` | 内核管道实现 |
| **通知** | `notify/` | fanotify、inotify 文件事件通知 |
| **pidfd** | `pidfd.rs` | pidfd 支持 |

#### 3.3 网络栈 (`os/src/net/`)

| 子模块 | 文件 | 功能简述 |
|---|---|---|
| **以太网** | `ethernet.rs` | 以太网帧处理 |
| **ARP** | `arp.rs` | 地址解析协议 |
| **IP** | `ip.rs` | IP 协议层 |
| **ICMP** | `icmp.rs` | ICMP 协议 |
| **TCP** | `tcp.rs` | TCP 协议实现 |
| **UDP** | `udp.rs` | UDP 协议实现 |
| **路由** | `route.rs` | 路由表管理 |
| **邻居** | `neighbor.rs` | 邻居发现 |
| **Loopback** | `loopback.rs` | 回环接口 |
| **skb** | `skb.rs` | 网络缓冲区管理 |
| **virtio-net** | `virtio/` | virtio-net 网卡驱动（含 PCI 探测） |

#### 3.4 Socket 层 (`os/src/socket/`)

| 子模块 | 功能 |
|---|---|
| `mod.rs` | Socket 抽象层 |
| `tcp.rs` | TCP Socket 实现 |
| `udp.rs` | UDP Socket 实现 |
| `raw.rs` | 原始 Socket |

#### 3.5 块设备驱动 (`os/src/drivers/block/`)

| 子模块 | 功能 |
|---|---|
| `virtio_blk.rs` | virtio-blk 块设备驱动 |
| `pci.rs` | PCI 总线枚举与配置 |
| `probe.rs` | 设备探测 |

#### 3.6 硬件抽象层 (`polyhal/`)

| 子 crate | 功能 |
|---|---|
| `polyhal` | 核心 HAL：页表、内存、中断、定时器、多核、percpu、指令封装、调试控制台 |
| `polyhal-trap` | 陷阱帧与陷阱处理（支持 riscv64/loongarch64/aarch64/x86_64） |
| `polyhal-boot` | 启动引导支持 |
| `polyhal-macro` | 过程宏辅助 |

---

### 4. 构建工具需求

基于 `Makefile`、`rust-toolchain.toml` 和 `dev-env-info.md` 分析：

| 工具 | 版本/说明 |
|---|---|
| **Rust 工具链** | `nightly-2025-01-18`，组件：`rust-src`, `llvm-tools`, `rustfmt`, `clippy` |
| **Rust 目标** | `riscv64gc-unknown-none-elf`, `loongarch64-unknown-none` |
| **cargo-binutils** | 提供 `rust-objcopy`、`rust-objdump` |
| **QEMU** | 9.2.1，支持 `qemu-system-riscv64` 和 `qemu-system-loongarch64` |
| **SBI 固件** | RustSBI（RISC-V，位于 `bootloader/rustsbi-qemu.bin`） |
| **GCC 交叉工具链** | `riscv64-unknown-elf-gcc` 8.2.0, `riscv64-linux-gnu-gcc` 11.4.0, `loongarch64-linux-gnu-gcc` 13.2.0 |
| **文件系统工具** | `e2fsck`, `mkfs.ext*`（由 `tools/build-mkfs.sh` 构建），用于 SD 卡镜像制作与注入 |
| **GNU Make** | 构建编排 |

---

### 5. 整体架构评估

该项目是一个功能较为完整的类 Unix 宏内核，实现了以下核心子系统：

- **内存管理**：分页（SV39/LA 页表）、页帧分配、堆分配、VM 区间管理、写时复制（COW）、KSM、页面回收与交换
- **进程管理**：多进程/多线程、fork、exec、调度器、信号、futex
- **文件系统**：多文件系统支持（FAT32、ext4、tmpfs、devfs、procfs、sysfs）、VFS 抽象、页面缓存、管道、文件事件通知（fanotify/inotify）
- **网络栈**：完整的 TCP/IP 协议栈（以太网/ARP/IP/ICMP/TCP/UDP）、Socket API、virtio-net 驱动
- **同步机制**：自旋锁、睡眠锁、可重入锁
- **架构支持**：RISC-V 64 和 LoongArch 64（通过 polyhal 可扩展至 AArch64 和 x86_64）

该项目还具有较完善的用户态测试体系（`user/src/bin/` 下约 32 个测试程序）和网络性能测试工具（iperf3/netperf）。