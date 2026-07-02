## 项目结构与初步调查结果

### 1. 项目概况

该项目名为 **Anemone OS**，是一个采用 Rust 编写的宏内核（Monolithic Kernel）操作系统内核，面向 RISC-V 64 和 LoongArch 64 两种架构。项目采用 workspace 方式组织，属于竞赛型 OS 内核项目。总代码量约 **77,560 行 Rust 代码**（仅内核部分），分布在 556 个 `.rs` 文件中。

---

### 2. 顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `anemone-kernel/` | **内核主体代码**，包含架构相关代码、子系统实现和独立 crate |
| `anemone-abi/` | 内核 ABI 定义（系统调用号、错误码、数据结构等），约 2,653 行 |
| `anemone-rs/` | 用户态支持库（runtime），约 2,108 行 |
| `anemone-apps/` | 用户态测试程序集（args、float-test、init、mmap-test、signal-test 等），约 6,374 行 |
| `anemone-book/` | 项目文档/书籍（Typst 格式） |
| `anemone-libc/` | C 库接口（目前仅含 README，内容极少） |
| `scripts/xtask/` | 自定义构建工具（Rust cli），封装 cargo、QEMU、rootfs 管理等 |
| `conf/` | 配置文件目录，包含平台定义、架构链接脚本、rootfs 配置等 |
| `symtab/` | 符号表构建工具 |
| `docs/`、`report/` | 额外文档与报告 |
| `Justfile` | Just 构建命令入口 |
| `Dockerfile` | 容器化开发环境（含 QEMU、交叉编译工具链） |

---

### 3. 内核子系统划分

内核代码 (`anemone-kernel/src/`) 按子系统组织，各子系统规模如下：

| 子系统 | 目录 | 文件数 | 代码行数 | 职责 |
|---|---|---|---|---|
| **VFS/文件系统** | `fs/` | 152 | 25,162 | 最大子系统。实现 VFS 框架、inode/dentry/mount 管理、路径解析、文件操作 API、procfs、devfs、ramfs、ext4、pipe、eventfd、timerfd、fanotify |
| **任务管理** | `task/` | 106 | 16,480 | 进程/线程管理、clone/execve/exit/wait、信号处理、凭证管理（UID/GID/Capability）、内核线程、资源限制（rlimit）、CPU 使用统计 |
| **内存管理** | `mm/` | 49 | 9,365 | 物理页帧分配、内核堆分配 (kmalloc)、页表管理、用户空间映射 (mmap/munmap/mprotect)、共享内存 (shm)、OOM、DMA |
| **设备模型** | `device/` | 40 | 6,969 | 统一设备模型 (kobject)、字符设备 (null/zero/urandom/full)、块设备 (ramdisk/loop)、PCIe 总线、platform 总线、virtio 总线、设备发现 (OF/FDT) |
| **架构相关** | `arch/` | 40 | 5,898 | RISC-V 64 和 LoongArch 64 的启动、异常/中断/陷阱处理、MMU 页表、上下文切换、FPU、回栈追踪 |
| **驱动** | `driver/` | 19 | 2,821 | 串口 (ns16550a)、中断控制器 (PLIC/loongson)、时钟源、RTC (goldfish)、virtio (MMIO/PCIe)、virtio-blk |
| **调度** | `sched/` | 12 | 3,022 | CPU 调度器框架、调度类、等待队列、事件机制、上下文切换 |
| **时间** | `time/` | 27 | 1,359 | 多种时钟 (realtime/monotonic/coarse)、定时器 (timer)、itimers、时间系统调用 |
| **异常/中断** | `exception/` | 10 | 989 | 中断请求管理 (IRQ)、页错误、IPI、时钟中断 |
| **系统调用** | `syscall/` | 3 | 885 | 系统调用分发、用户空间内存访问辅助 |
| **同步原语** | `sync/` | 8 | 834 | 自旋锁、互斥锁、读写锁、中断禁用锁、CPU 同步计数器 |
| **工具** | `utils/` | 17 | 1,758 | 位图、环形缓冲、对齐、缓存行、MMIO 访问等通用基础设施 |
| **调试** | `debug/` | 9 | 661 | printk 日志系统、KUnit 测试框架、系统信息导出 |
| **UTS** | `uts/` | 3 | 55 | uname 系统调用 |
| **其它** | 顶层文件 | 7 | ~1,200 | main.rs（启动流程）、initcall.rs（初始化调用链）、percpu.rs、panic.rs、power.rs、prelude.rs、syserror.rs |

---

### 4. 内核子 Crate（`anemone-kernel/crates/`）

| Crate | 说明 |
|---|---|
| `buddy-system` | 伙伴系统物理页分配器（含 fuzz 测试） |
| `device-tree` | Device Tree 解析器（支持扁平化和展开形式） |
| `idalloc` | ID 分配器（位图、栈、oneshot 分配策略） |
| `kernel-macros` | 内核过程宏（initcall、syscall、percpu、KUnit 等） |
| `la-insc` | LoongArch 指令与寄存器访问封装 |
| `lwext4-rust` | ext4 文件系统驱动（基于 lwext4 C 库的 Rust 封装） |
| `range-allocator` | 范围分配器（递增分配策略） |

---

### 5. 构建工具与依赖

**Rust 工具链**：
- `nightly-2026-04-01`，组件包括 rustfmt、clippy、llvm-tools、rust-src、miri、rust-analyzer
- 编译目标：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none`

**外部工具**：
- **QEMU** (10.2.1)：用于 RISC-V 和 LoongArch 仿真
- **Just**：命令运行器
- **cargo-binutils**：Rust 二进制工具
- **lwext4 交叉编译工具链**：`riscv64-linux-musl-cross`、`loongarch64-linux-musl-cross`（用于编译 lwext4 C 库）
- **libguestfs-tools**、**cmake**、**libclang**（bindgen 需要）：Docker 环境中的辅助工具

**主要 Rust 依赖**：
- `spin`（自旋锁）、`virtio-drivers`（virtio 驱动）、`goblin`（ELF 解析）、`fdt`（设备树解析）、`talc`（分配器）、`intrusive-collections`（侵入式数据结构）等

**构建流程**：
- 通过 `just` 命令调用 `xtask`，再由 `xtask` 调用 `cargo` 进行编译
- 支持 `kunit`、`fs_ext4`、`kernel_preempt`、`spin_lock_irqsave` 等编译时 feature flags
- 支持 `dev` 和 `release` 两种构建 profile

---

### 6. 支持的平台

| 平台 | 配置 | 架构 | 执行环境 |
|---|---|---|---|
| `qemu-virt-rv64` | QEMU virt 机器 | RISC-V 64 | OpenSBI/RustSBI |
| `qemu-virt-la64` | QEMU virt 机器 | LoongArch 64 | SBI |

---

### 7. 初步判断

1. **完整性较高**：该项目实现了典型宏内核的主要子系统——VFS（含多种文件系统）、进程管理、内存管理、信号、同步、设备驱动框架、PCIe 总线、定时器等，整体架构较为完整。
2. **类 Unix 设计**：系统调用接口、VFS 设计、信号机制、凭证管理、procfs 等均体现出类 Linux/Unix 的设计思路。
3. **模块化良好**：子系统间通过目录边界清晰分离，初始化通过 initcall 机制解耦，架构相关代码通过 HAL trait 抽象。
4. **双架构支持**：同等程度支持 RISC-V 64 和 LoongArch 64，架构特定代码封装在 `arch/` 下，通过条件编译选择。
5. **构建系统成熟**：使用 xtask 自定义构建工具、kconfig 风格配置、Justfile 入口，构建流程规范。