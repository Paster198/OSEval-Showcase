## Ax OS 内核项目初步调查报告

### 一、项目概况

**项目名称**：Ax  
**开发团队**：北京理工大学 btw 队（单人开发）  
**项目类型**：基于 Rust 语言从零开发的宏内核操作系统  
**目标架构**：RISC-V 64（riscv64gc）与 LoongArch 64  
**项目规模**：核心内核代码（`os/src`）总计约 22,788 行 Rust 代码，分布在 127 个源文件中  

---

### 二、仓库顶层组织结构

```
.
├── os/                  # 内核主体（Rust Cargo 项目）
│   ├── Cargo.toml       # 内核依赖与编译配置
│   ├── Cargo.lock
│   ├── cargo/           # Cargo 配置（含 vendored sources 配置）
│   ├── src/             # 内核源码
│   └── vendor/          # 依赖库本地副本（约 70+ crate）
├── programs/
│   └── init/            # 用户态 init 程序（独立 Rust 项目）
├── disk_img/            # 根文件系统镜像内容
│   ├── etc/             # 系统配置文件（passwd, protocols, nsswitch.conf）
│   └── ltp.sh           # LTP 测试脚本
├── edited_lib/          # 经适配修改的第三方库
│   ├── ext4_rs/         # ext4 文件系统实现库
│   └── rust-elf/        # ELF 文件解析库
├── docs/                # 项目文档（Typst 格式）
│   ├── doc/             # 分章节文档（概述/内存/任务/文件系统/硬件等）
│   └── AI.md            # AI 相关说明
├── Makefile             # 顶层构建脚本
├── README.md
├── 初赛文档.pdf / .txt   # 初赛技术文档
└── .gitignore
```

---

### 三、子系统划分

内核源码（`os/src/`）按功能划分为 **8 个子系统模块**，外加 `main.rs` 入口：

| 子系统 | 目录 | 代码行数 | 占核心代码比例 | 职责描述 |
|--------|------|----------|----------------|----------|
| **filesystem** | `os/src/filesystem/` | 6,691 | 29.4% | 虚拟文件系统（VFS）框架及多种文件系统实现 |
| **syscall** | `os/src/syscall/` | 5,342 | 23.4% | 系统调用接口层，Linux ABI 兼容 |
| **multitask** | `os/src/multitask/` | 3,316 | 14.5% | 进程/线程管理、调度、信号、同步 |
| **memory** | `os/src/memory/` | 2,296 | 10.1% | 虚拟内存管理、页表、帧分配、VMA |
| **basic** | `os/src/basic/` | 1,844 | 8.1% | 基础设施：控制台、日志、分配器、定时器等 |
| **arch** | `os/src/arch/` | 1,781 | 7.8% | 架构抽象层，RISC-V 与 LoongArch 适配 |
| **devices** | `os/src/devices/` | 540 | 2.4% | 设备驱动框架（VirtIO、PCI） |
| **trap** | `os/src/trap/` | 497 | 2.2% | 陷阱/中断处理、页错误 |
| **main** | `os/src/main.rs` | 481 | 2.1% | 内核入口与初始化流程 |

---

### 四、各子系统详细说明

#### 4.1 架构抽象层（arch）

- **接口定义**（`arch/interfaces/`）：定义了 `Arch`、`Regs`、`Basic`、`Chrono`、`Trap`、`UAccessRaw` 等 trait，规范了架构相关的行为契约。
- **RISC-V 64 实现**（`arch/riscv64/`）：具体实现上述 trait。
- **LoongArch 64 实现**（`arch/loongarch64/`）：具体实现上述 trait。
- 在 `mod.rs` 中通过条件编译（`#[cfg]`）选择 `Native` 类型别名。

#### 4.2 基础设施（basic）

实现内核运行的最底层支撑：

| 模块文件 | 功能 |
|----------|------|
| `console.rs` | 控制台输入输出 |
| `logger.rs` | 日志系统 |
| `global_allocator.rs` | 内核堆分配器 |
| `timer.rs` | 时钟与定时器管理 |
| `sync.rs` | 内核同步原语 |
| `debugger.rs` | 调试支持（含 backtrace） |
| `panic_handler.rs` | panic 处理 |
| `bstr.rs` | 字节字符串工具 |
| `lru.rs` | LRU 缓存 |
| `stack.rs` | 栈管理 |
| `shared_with_asm.rs` | 与汇编代码共享的数据结构 |

#### 4.3 内存管理（memory）

| 模块文件 | 功能 |
|----------|------|
| `address.rs` | 物理地址/虚拟地址抽象 |
| `address_space.rs` | 地址空间管理（677 行，最大单文件之一） |
| `frame_allocator.rs` | 物理页帧分配器 |
| `page_table.rs` | 页表操作（565 行） |
| `page.rs` / `page_meta.rs` | 页与页元数据 |
| `virtual_memory_area.rs` | VMA 管理 |
| `uaccess.rs` | 用户态内存访问 |
| `tlb_refill_handler.rs` | TLB 重填处理（LoongArch） |

内核采用 Sv39 页表格式，用户态占低 256GB，内核态占高 256GB，使用直接物理内存映射。

#### 4.4 多任务管理（multitask）

| 模块文件/目录 | 功能 |
|---------------|------|
| `task.rs` | 任务（进程/线程）核心数据结构（1,248 行） |
| `task_manager.rs` | 任务管理器 |
| `task_context.rs` | 任务上下文切换 |
| `task_scheduler.rs` | 调度器框架 |
| `schedulers/` | 具体调度策略（idle、realtime） |
| `signal/` | 信号处理（handler、pending、types） |
| `futex.rs` | futex 快速用户态锁 |
| `wait.rs` | 等待/睡眠机制 |
| `fdtable.rs` | 文件描述符表 |
| `fs_data.rs` | 文件系统相关任务数据 |
| `process_data.rs` | 进程数据 |
| `id_allocator.rs` | PID/FD 等 ID 分配器 |

支持实时优先级（0-99）和普通优先级（100-139）两类调度。

#### 4.5 系统调用（syscall）

按功能分为 11 个子模块，实现 Linux 兼容的系统调用接口：

| 模块 | 行数 | 说明 |
|------|------|------|
| `filesystem.rs` | 1,905 | 文件系统相关系统调用（最大模块） |
| `process.rs` | 752 | 进程管理（fork、execve、wait 等） |
| `mod.rs` | 657 | 系统调用分发框架与错误码 |
| `sync.rs` | 431 | 同步相关（futex 等） |
| `signal.rs` | 385 | 信号相关 |
| `memory.rs` | 320 | 内存管理（mmap、brk 等） |
| `basic.rs` | 309 | 基础系统调用（read、write 等） |
| `misc.rs` | 168 | 杂项系统调用 |
| `user.rs` | 139 | 用户态辅助 |
| `clock.rs` | 117 | 时钟相关 |
| `epoll.rs` | 98 | epoll 相关 |
| `common.rs` | 61 | 通用工具 |

系统调用号遵循 Linux 约定（如 openat=56, write=64, exit=93, fork=220, execve=221, wait4=260）。

#### 4.6 文件系统（filesystem）

代码量最大的子系统，采用 VFS 抽象层设计：

- **VFS 层**（`vfs/`）：`dentry`、`inode`、`file`、`filesystem`、`mount`、`page_cache`、`cache` 等核心抽象。
- **ext4**（`ext4/`）：基于 `edited_lib/ext4_rs` 库的 ext4 文件系统适配。
- **tmpfs**（`tmpfs/`）：内存文件系统。
- **devfs**（`devfs/`）：设备文件系统，提供 `/dev/null`、`/dev/zero`、`/dev/tty`、`/dev/urandom` 等设备。
- **procfs**（`procfs/`）：进程信息文件系统，支持 `/proc/meminfo` 等。
- **其他**（`other/`）：`pipe`（匿名管道）、`epoll` 实现。
- **工具**：`filesystems.rs`（文件系统类型注册表）、`utils.rs`。

#### 4.7 设备驱动（devices）

| 模块 | 功能 |
|------|------|
| `block_device.rs` | 块设备抽象 trait |
| `virtio.rs` | VirtIO 设备扫描与初始化 |
| `pci.rs` | PCI 总线设备扫描 |
| `hal.rs` | 硬件抽象辅助 |

#### 4.8 陷阱处理（trap）

| 模块 | 功能 |
|------|------|
| `trap.rs` | 陷阱入口与分发 |
| `trap_handler.rs` | 具体陷阱处理逻辑 |
| `page_fault_type.rs` | 页错误类型分类 |

---

### 五、外部依赖与库

#### 5.1 edited_lib（经适配的第三方库）

| 库 | 用途 | 规模 |
|----|------|------|
| `ext4_rs` | ext4 文件系统读写实现（含块分配、inode、extent、目录等） | ~29 源文件 |
| `rust-elf` | ELF 可执行文件解析（段、节、符号、重定位、动态链接等） | ~18 源文件 |

#### 5.2 主要 Cargo 依赖

| crate | 用途 |
|-------|------|
| `virtio-drivers` | VirtIO 设备驱动 |
| `flat_device_tree` | 设备树解析 |
| `buddy_system_allocator` | 伙伴系统分配器 |
| `bitvec` / `bitflags` | 位操作 |
| `hashbrown` | 高性能哈希表 |
| `intrusive-collections` | 侵入式数据结构 |
| `xarray` | 可扩展数组 |
| `riscv` | RISC-V 寄存器定义 |
| `object` | 目标文件解析 |
| `ringbuf` | 环形缓冲区 |
| `rand` + `chacha` | 随机数（用于 `/dev/urandom`） |

所有依赖均通过 vendored sources 方式本地化管理（`os/vendor/`）。

---

### 六、构建系统与工具链

#### 6.1 构建工具

| 工具 | 用途 |
|------|------|
| **Rust 工具链**（rustc、cargo） | 内核与 init 程序编译 |
| **RISC-V 交叉编译目标** | `riscv64gc-unknown-none-elf` |
| **LoongArch 交叉编译目标** | `loongarch64-unknown-none` |
| **GNU ld**（通过 linker script） | 内核链接 |
| **mkfs.ext4** | 根文件系统镜像制作 |
| **Docker** | 提供一致的运行/调试环境（镜像 `zhouzhouyi/os-contest:20260104`） |
| **QEMU** | 模拟运行（`qemu-system-riscv64` / `qemu-system-loongarch64`） |
| **GDB** | 内核调试 |

#### 6.2 Makefile 目标

| 目标 | 功能 |
|------|------|
| `make all` | 清理、编译双平台内核 + init、生成磁盘镜像 |
| `make rv` / `make la` | 单独编译 RISC-V / LoongArch 内核 |
| `make run-rv` / `make run-la` | 在 QEMU 中运行对应架构内核 |
| `make debug-rv` / `make debug-la` | GDB 调试对应架构内核 |
| `make clean` | 清理构建产物 |
| `make fmt` / `make clippy-rv` / `make autofix` | 代码质量工具 |

支持 `MODE=release`（默认，LTO fat + 单 codegen-unit）与 `MODE=debug`（含调试信息）两种构建模式。

---

### 七、总结

Ax 是一个结构清晰、模块化良好的 Rust 宏内核项目。其 8 个子系统覆盖了操作系统内核的主要功能领域：

- **核心能力**：内存管理、进程/线程调度、信号处理、futex 同步
- **文件系统**：VFS 框架 + ext4/tmpfs/devfs/procfs 四种文件系统 + pipe + epoll
- **系统调用**：覆盖 Linux ABI 的主要系统调用类别（文件、进程、内存、信号、同步、时钟、epoll）
- **跨架构**：通过 arch trait 抽象层同时支持 RISC-V 64 和 LoongArch 64
- **设备驱动**：基于 VirtIO 的块设备支持，PCI 总线扫描

项目的构建依赖以 Docker 容器化方式管理，确保环境一致性。构建产物为两个架构的内核 ELF 文件（`kernel-rv`、`kernel-la`）及 ext4 格式的磁盘镜像（`disk.img`）。