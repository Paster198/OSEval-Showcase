# Eonix OS 内核项目初步调查报告

## 一、项目概述

Eonix 是一个使用 Rust 编写的宏内核操作系统，支持多处理器、多架构（x86_64、RISC-V 64、LoongArch64），基于 Rust async 语法实现有栈/无栈异步任务管理。项目为原创内核架构设计，所有核心模块由团队独立实现。代码总量约 39,265 行 Rust 代码（含 crates 和 src）。

使用的 Rust 工具链版本为 `nightly-2025-05-20`，依赖大量 nightly 特性（如 `allocator_api`、`arbitrary_self_types`、`get_mut_unchecked` 等）。

---

## 二、仓库文件组织结构

```
.
├── Cargo.toml / Cargo.lock       # Rust 项目配置与依赖锁定
├── Makefile / Makefile.src       # 构建脚本（Makefile.real 由 configure 生成）
├── configure                     # Shell 配置脚本（检测工具链、QEMU、GDB 等）
├── build.rs                      # Rust 构建脚本（链接器参数设置）
├── rust-toolchain                # 指定 nightly-2025-05-20
├── x86_64-unknown-none.json      # x86_64 裸机目标定义
├── src/                          # 内核主源码
├── crates/                       # 核心 Rust 库（模块化 crate）
├── macros/                       # 自定义过程宏
├── doc/                          # 项目文档
├── script/                       # 辅助脚本
├── user-programs/                # 用户空间测试程序（busybox、init 等预编译二进制）
└── .github/workflows/            # CI 配置
```

---

## 三、子系统划分与目录映射

### 1. 硬件抽象层（HAL）

| 目录 | 说明 |
|------|------|
| `crates/eonix_hal/` | HAL 核心，含架构无关接口 |
| `crates/eonix_hal/eonix_hal_traits/` | HAL trait 定义（context、fault、fpu、mm、processor、trap） |
| `crates/eonix_hal/src/arch/x86_64/` | x86_64 架构实现（bootstrap、GDT、中断、FPU、陷阱、MM） |
| `crates/eonix_hal/src/arch/riscv64/` | RISC-V 64 架构实现（bootstrap、中断、FPU、陷阱、时间、MM） |
| `crates/eonix_hal/src/arch/loongarch64/` | LoongArch64 架构实现（bootstrap、FDT、FPU、陷阱、MM） |
| `crates/eonix_hal/src/platform/` | 平台特定配置（如 riscv64_qemu_virt） |

### 2. 内存管理子系统

| 目录 | 说明 |
|------|------|
| `crates/eonix_mm/` | 内存管理核心库（地址抽象、页表、分页机制） |
| `crates/buddy_allocator/` | Buddy 页分配器（free_area、zone） |
| `crates/slab_allocator/` | Slab 对象分配器（slab_cache） |
| `src/kernel/mem/` | 内核内存管理（地址、分配器接口、mm_area、mm_list、page_alloc、page_cache、paging、用户空间访问辅助） |
| `src/kernel/mem.rs` | 内存管理入口 |

### 3. 任务/进程/线程管理子系统

| 目录 | 说明 |
|------|------|
| `crates/eonix_runtime/` | 异步运行时（executor、scheduler、ready_queue、task、context） |
| `crates/eonix_preempt/` | 内核抢占支持 |
| `crates/eonix_percpu/` | Per-CPU 变量支持 |
| `src/kernel/task/` | 任务管理（process、thread、clone、futex、kernel_stack、signal、process_group、process_list、session） |
| `src/kernel/task/loader/` | ELF 可执行文件加载器（elf、aux_vec） |
| `src/kernel/task.rs` | 任务管理入口 |

### 4. 文件系统与 VFS 子系统

| 目录 | 说明 |
|------|------|
| `src/kernel/vfs/` | 虚拟文件系统层（dentry/dcache、inode、file、filearray、mount、vfs 核心接口） |
| `src/fs/` | 具体文件系统实现 |
| `src/fs/ext4.rs` | EXT4 文件系统（读写，依赖外部 crate `another_ext4`） |
| `src/fs/fat32/` | FAT32 文件系统（读，含 dir、file） |
| `src/fs/procfs.rs` | Procfs 伪文件系统 |
| `src/fs/tmpfs.rs` | 临时文件系统 |
| `src/fs/shm.rs` | 共享内存文件系统 |
| `src/kernel/block/` | 块设备管理（含 MBR 分区解析） |

### 5. 网络协议栈子系统

| 目录 | 说明 |
|------|------|
| `src/net/` | 网络模块（device、iface、netdev、socket） |
| `src/net/socket/tcp.rs` | TCP socket 实现 |
| `src/net/socket/udp.rs` | UDP socket 实现 |
| `src/net/device/loopback.rs` | 回环设备 |
| 外部依赖 `smoltcp` | 底层网络协议栈（IPv4/IPv6、TCP/UDP/ICMP/DNS、以太网） |

### 6. 设备驱动子系统

| 目录 | 说明 |
|------|------|
| `src/driver/virtio/` | VirtIO 驱动（virtio_blk 块设备、virtio_net 网卡，含 riscv64/loongarch64 平台适配） |
| `src/driver/ahci/` | AHCI SATA 控制器驱动（command、control、port、register 等） |
| `src/driver/e1000e/` | Intel E1000E 网卡驱动 |
| `src/driver/serial/` | 串口驱动 |
| `src/driver/sbi_console.rs` | RISC-V SBI 控制台驱动 |
| `src/driver/goldfish_rtc.rs` | Goldfish RTC 驱动 |
| `src/kernel/pcie/` | PCIe 总线管理（device、driver、header、init、error） |
| `src/kernel/rtc/` | 实时时钟管理 |

### 7. 系统调用接口

| 目录 | 说明 |
|------|------|
| `src/kernel/syscall/` | 系统调用实现 |
| `src/kernel/syscall/file_rw.rs` | 文件读写相关 syscall |
| `src/kernel/syscall/mm.rs` | 内存管理相关 syscall |
| `src/kernel/syscall/net.rs` | 网络相关 syscall |
| `src/kernel/syscall/procops.rs` | 进程操作相关 syscall |
| `src/kernel/syscall/sysinfo.rs` | 系统信息相关 syscall |
| `crates/posix_types/` | POSIX 类型定义（syscall_no、stat、signal、poll、open、net 等） |

### 8. 同步与并发原语

| 目录 | 说明 |
|------|------|
| `crates/eonix_sync/` | 内核同步原语（Mutex 等） |
| `crates/atomic_unique_refcell/` | 原子唯一引用单元 |
| `src/sync/` | 同步模块（arcswap、condvar） |
| `crates/intrusive_list/` | 侵入式链表数据结构 |
| `crates/pointers/` | 自定义智能指针 |
| `src/rcu.rs` | RCU（Read-Copy-Update）机制 |

### 9. 辅助模块

| 目录 | 说明 |
|------|------|
| `crates/eonix_log/` | 内核日志系统 |
| `src/kernel/console.rs` | 内核控制台 |
| `src/kernel/terminal.rs` | 终端设备抽象 |
| `src/kernel/timer.rs` | 定时器管理 |
| `src/kernel/interrupt.rs` | 中断处理 |
| `src/kernel/chardev.rs` | 字符设备抽象 |
| `src/kernel/user/` | 用户空间交互（dataflow） |
| `src/path.rs` | 文件路径处理 |
| `src/hash.rs` | 哈希工具 |
| `src/io.rs` | I/O 工具 |
| `macros/` | 自定义过程宏 |

---

## 四、编译构建所需工具

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| **Rust (nightly-2025-05-20)** | 内核编译主工具链 | 可用（rustc/cargo/rustup） |
| **rust-src** | 裸机目标编译所需 | 可用 |
| **GCC** | configure 脚本中作为备选编译器检测 | 可用 |
| **GNU Make** | 构建系统 | 可用 |
| **QEMU** | 运行与调试（qemu-system-riscv64/loongarch64/x86_64） | 可用 |
| **GDB** | 调试 | 可用 |
| **fdisk (util-linux)** | 磁盘镜像分区表创建 | 需确认 |
| **mtools** | 文件系统镜像制作 | 可用（mcopy） |
| **CMake** | README 提及的构建依赖 | 可用 |
| **RISC-V 交叉编译工具链** | RISC-V 目标 GDB 等 | 可用 |
| **LoongArch 交叉编译工具链** | LoongArch 目标 GDB 等 | 可用 |
| **dtc (Device Tree Compiler)** | 设备树编译 | 可用 |
| **OpenSBI/RustSBI** | RISC-V SBI 固件（QEMU 启动所需） | 可用 |
| **ld (GNU linker)** | 链接（通过 link.x 链接脚本） | 可用 |

项目通过 `./configure` 脚本自动检测工具链并生成 `Makefile.real`，然后通过 `make` 进行编译。构建目标架构支持 x86_64、riscv64 和 loongarch64 三种，默认架构为 x86_64（configure 中设定），但 Makefile 的 `all` 目标同时构建 riscv64 和 loongarch64。

外部 Rust 依赖通过 git 引入的关键 crate 包括：`smoltcp`（网络协议栈）、`another_ext4`（EXT4 文件系统）、`intrusive-collections`（侵入式集合，使用 fork 版本）、`virtio-drivers`（VirtIO 设备驱动，仅 riscv64/loongarch64）。