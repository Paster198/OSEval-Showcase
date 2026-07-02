## 项目初步调查报告

### 一、项目概览

该项目是一个基于 Rust 语言开发的 OS 内核，采用 Cargo workspace 组织，支持 **4 种 CPU 架构**：RISC-V64、LoongArch64、AArch64、x86_64。项目以 QEMU 为主要模拟运行环境，同时包含对特定真机板卡（如 VisionFive2、K210、cv1811h）的支持。

---

### 二、文件组织结构

项目根目录下主要包含以下顶层目录和文件：

| 路径 | 类型 | 说明 |
|------|------|------|
| `os/` | crate | **内核主二进制 crate**，包含内核入口、所有核心子系统实现 |
| `arch/` | crate | **架构抽象层**，封装各 CPU 架构差异（陷阱、页表、上下文切换等） |
| `vfs/` | crate | **虚拟文件系统实现**（procfs、devfs、memfs、tmpfs） |
| `vfs-defs/` | crate | **VFS 类型定义**（Inode、Dentry、SuperBlock、File、Kstat 等） |
| `ext4/` | crate | **ext4 文件系统实现** |
| `easy-fs/` | crate | **简易文件系统**（基于块设备的轻量 FS） |
| `lose-net-stack/` | crate | **网络协议栈**（TCP/UDP、ARP、IP） |
| `virtio-drivers/` | crate | **VirtIO 设备驱动**（blk、net、gpu、console、input、socket） |
| `isomorphic_drivers/` | crate | **同构驱动**（AHCI SATA、e1000、ixgbe 网卡） |
| `sync/` | crate | **同步原语**（基于 spinlock 的 Mutex） |
| `buffer/` | crate | **块缓冲缓存**（block cache） |
| `device/` | crate | **设备抽象层**（块设备、ramdisk、设备管理器） |
| `config/` | crate | **内核编译配置** |
| `time/` | crate | **时间相关工具** |
| `logger/` | crate | **内核日志基础设施** |
| `system-result/` | crate | **系统调用返回值类型定义** |
| `user/` | crate | **用户态测试程序**（shell、forktest、usertests 等约 28 个） |
| `vendor/` | 目录 | **Vendored 第三方依赖**（约 130+ 个 crate） |
| `bootloader/` | 文件 | **RustSBI 引导固件二进制** |
| `testinit/` | 文件 | **测试初始化程序**（分为 rv/ 和 la/） |
| `testsuits-for-oskernel/` | 目录 | **OS 内核测试套件**（含 sdcard 镜像） |
| `os-contest-image/` | 目录 | **Docker 构建与运行环境** |
| `ext4_rs-1.3.1/` | crate | **ext4 Rust 库**（外部引入） |
| `easy-fs-fuse/` | crate | **easy-fs 的 FUSE 挂载工具**（用于主机端调试） |
| `ext4-fs-fuse/` | crate | **ext4 的 FUSE 挂载工具** |
| `ext4-test-fuse/` | crate | **ext4 测试用的 FUSE 工具** |
| `visionfive2-sd/` | crate | **VisionFive2 板卡 SD 卡外设支持** |
| `Cargo.toml` | 文件 | **顶层 workspace 清单** |
| `Makefile` | 文件 | **顶层构建编排脚本** |
| `rust-toolchain.toml` | 文件 | Rust 工具链配置（nightly-2024-05-01） |

---

### 三、子系统识别与划分

根据源码目录和模块声明，该 OS 内核实现了以下子系统：

#### 1. 架构抽象层（`arch/`）

- **路径**：`arch/src/{riscv64,loongarch64,aarch64,x86_64}/`
- **核心文件**：
  - `context.rs` — 上下文切换
  - `trap.rs` — 陷阱/中断/系统调用入口
  - `page_table.rs` — 页表操作（RISC-V 含 sv39/sigtrx）
  - `timer.rs` — 架构相关时钟
  - `consts.rs` — 架构常量
  - `boot.rs` / `entry.rs` — 启动入口
  - 架构特有：`sbi.rs`（RISC-V）、`gic.rs`+`psci.rs`（AArch64）、`idt.rs`+`gdt.rs`+`apic.rs`（x86_64）、`sigtrx.rs`（LoongArch）
- **接口**：通过 `arch/src/api.rs` 中的 `ArchInterface` trait 向上层提供统一 API

#### 2. 内存管理（`os/src/mm/`）

- `frame_allocator.rs` — 物理页帧分配器
- `heap_allocator.rs` — 内核堆分配器
- `page_table.rs` — 页表管理
- `memory_set.rs` — 虚拟地址空间（MemorySet）
- `address.rs` — 地址类型定义
- `shm.rs` — 共享内存

#### 3. 进程/任务管理（`os/src/task/`）

- `task.rs` — 任务控制块（TCB）定义
- `manager.rs` — 任务管理器
- `processor.rs` — CPU 调度
- `pid.rs` / `tid.rs` — PID/TID 分配
- `context.rs` — 任务上下文
- `signal.rs` / `sigaction.rs` — 信号处理
- `futex.rs` — futex 同步
- `fdtable.rs` — 文件描述符表
- `pidfd.rs` — pidfd 支持
- `info.rs` / `action.rs` / `aux.rs` — 任务辅助功能

#### 4. 系统调用（`os/src/syscall/`）

- `mod.rs` — 系统调用分发
- `fs.rs` — 文件系统相关 syscall
- `memory.rs` — 内存相关 syscall
- `process.rs` — 进程相关 syscall
- `signal.rs` — 信号相关 syscall
- `socket.rs` — 套接字相关 syscall
- `timesyscall.rs` — 时间相关 syscall

#### 5. 虚拟文件系统（`vfs/` + `vfs-defs/`）

- **vfs-defs**：定义核心抽象 — `Inode`、`Dentry`、`SuperBlock`、`File`、`FileSystemType`、`Kstat`、`StatFs`、`PollEvents` 等
- **vfs**：具体实现
  - `procfs/` — /proc 文件系统（cpuinfo、meminfo、mounts、stat、status、self/proc、smaps、interrupts、exe）
  - `devfs/` — /dev 文件系统（null、zero、tty、urandom、rtc、cpu_dma_latency）
  - `memfs/` — 内存文件系统（inode、file、dentry）
  - `tmpfs/` — 临时文件系统
  - `blockfile.rs` — 块文件抽象
  - `fdtable.rs` — 文件描述符表操作

#### 6. 文件系统实现

- **ext4（`ext4/`）**：完整 ext4 实现（superblock、inode、dentry、file、block、fs）
- **easy-fs（`easy-fs/`）**：简化文件系统（bitmap、block_cache、block_dev、layout、efs、vfs）

#### 7. 设备驱动

- **VirtIO 驱动（`virtio-drivers/`）**：blk、net、console、gpu、input、socket(vsock)，支持 MMIO 和 PCI 传输
- **同构驱动（`isomorphic_drivers/`）**：AHCI SATA 块设备、Intel e1000/ixgbe 网卡
- **内核内驱动（`os/src/drivers/`）**：virtio-blk、pci_virtio_blk、sata_block、sdcard、uart、plic

#### 8. 网络协议栈（`lose-net-stack/`）

- TCP/UDP 连接管理
- ARP 协议与 ARP 表
- IP 数据包处理
- 网络 trait 抽象

#### 9. 同步原语（`sync/`）

- 基于 spinlock 的内核互斥锁（`kspinbase.rs`、`kspinlib.rs`）

#### 10. 时钟与定时器（`time/` + `os/src/timer.rs`）

#### 11. 日志系统（`logger/` + `os/src/logging.rs`）

#### 12. 控制台（`os/src/console.rs`）

#### 13. 块缓冲（`buffer/`）— block_cache

#### 14. 设备管理（`device/`）— 块设备抽象、ramdisk、设备管理器

---

### 四、构建工具与流程

根据 `Makefile`、`Cargo.toml`、`rust-toolchain.toml` 和 `dotcargo/config.toml` 分析，构建该项目需要：

| 工具/依赖 | 用途 |
|-----------|------|
| **Rust nightly-2024-05-01** | 编译器，需 `rust-src`、`llvm-tools`、`rustfmt`、`clippy` 组件 |
| **Cargo** | 构建系统（workspace + `-Z build-std`） |
| **GNU Make** | 顶层构建编排 |
| **QEMU** | 模拟运行（qemu-system-riscv64 / loongarch64 / aarch64 / x86_64） |
| **Docker** | 可选，用于容器化构建 |
| **rust-objdump / rust-objcopy** | 二进制处理（RISC-V） |
| **loongarch64-linux-gnu-objcopy/objdump** | LoongArch 二进制处理 |
| **OpenSBI / RustSBI** | RISC-V SBI 固件（`bootloader/rustsbi-qemu.bin`） |

**构建目标**：
- RISC-V64: `riscv64gc-unknown-none-elf`
- LoongArch64: `loongarch64-unknown-none`
- AArch64: `aarch64-unknown-none-softfloat`
- x86_64: `x86_64-unknown-none`

**主要构建命令**：
- `make all` — 构建所有架构
- `make rv` — 仅构建 RISC-V
- `make la` — 仅构建 LoongArch
- `make rvlocalfull` — 完整本地构建 + 测试用 RISC-V 镜像
- 构建产物为 `kernel-rv`（RISC-V）或 `kernel-la`（LoongArch）