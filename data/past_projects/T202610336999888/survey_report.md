## OrayS (基于 ArceOS) OS 内核项目初步调查报告

### 一、项目概览

该项目名为 **OrayS**，是基于 [ArceOS](https://github.com/arceos-org/arceos) 组件化内核框架演进而来的操作系统内核。使用 Rust 语言编写，采用 Cargo workspace 管理多 crate 结构。目标架构为 **RISC-V64** 和 **LoongArch64**（也兼容 x86_64 和 AArch64）。项目在 ArceOS 基础上大量扩展了 Linux/POSIX 用户态兼容层，包括 ELF 加载、进程生命周期、信号、futex、mmap、socket、文件描述符模型以及 LTP 测试运行器等能力。

---

### 二、项目顶层文件结构

```
repo/
├── Cargo.toml              # Workspace 配置，定义所有成员 crate 与依赖
├── Cargo.lock              # 锁定依赖版本
├── Makefile                # 顶层构建系统（~18K，功能丰富）
├── rust-toolchain.toml     # 固定 nightly-2025-05-20 工具链
├── Dockerfile              # Docker 构建镜像
├── README.md               # 项目说明文档
├── run-eval.sh             # 评测启动脚本
│
├── kernel/                 # 内核核心子系统（9 个子目录，15 个 crate）
├── api/                    # API 抽象层（3 个 crate）
├── ulib/                   # 用户态库（2 个 crate）
├── user/                   # 用户态程序入口
├── vendor/                 # 本地 vendored 依赖（6 个 crate + 离线包）
├── configs/                # 平台与构建配置
├── scripts/                # 构建辅助、评测与合规检查脚本
├── tools/                  # 板级工具与辅助程序
├── docs/                   # 项目文档与演示材料
└── cargo-home/             # 离线 Cargo 依赖缓存
```

---

### 三、子系统划分与目录对应关系

#### 1. 硬件抽象层 (HAL) —— `kernel/arch/axhal`

- 为平台相关操作提供统一 API：启动、内存、中断、页表、CPU 本地存储、定时器等。
- 通过条件编译和 Cargo feature 机制支持 x86_64、AArch64、RISC-V64、LoongArch64 四种架构。
- 关键源文件：`mem.rs`（物理内存探测）、`irq.rs`（中断注册与分发）、`paging.rs`（页表操作）、`time.rs`（时钟）、`tls.rs`（线程本地存储）、`percpu.rs`（CPU 本地数据）。

#### 2. 平台配置 —— `kernel/config/axconfig`

- 编译期平台参数（物理内存布局、MMIO 范围、设备地址、定时器频率等）。
- 由 `scripts/axconfig-gen.py` 从 `configs/platforms/*.toml` 自动生成 Rust 常量。

#### 3. 诊断/日志 —— `kernel/diagnostics/axlog`

- 内核日志宏与日志级别控制。

#### 4. 设备驱动 —— `kernel/drivers/`

| 子目录 | 功能 |
|--------|------|
| `axdriver` | 驱动框架：总线抽象（MMIO/PCI）、VirtIO 驱动、ixgbe 网卡驱动、块设备/网络/显示设备枚举 |
| `axdisplay` | 显示设备驱动 |
| `axdma` | DMA 驱动 |

#### 5. 内存管理 —— `kernel/memory/`

| 子目录 | 功能 |
|--------|------|
| `axalloc` | 全局内存分配器（字节分配 + 页分配） |
| `axmm` | 地址空间管理（`aspace.rs`）与后端（线性映射 `linear.rs`、动态分配 `alloc.rs`） |

#### 6. 文件系统 —— `kernel/fs/axfs`

- VFS 层 + 具体文件系统实现。
- 支持：**FAT** (`fatfs.rs`)、**EXT4** (`ext4fs.rs`)、**ramfs**、**devfs**、**procfs**、**sysfs**、自定义文件系统 (`myfs.rs`)。
- 统一抽象：文件 (`file.rs`)、目录 (`dir.rs`)、挂载点 (`mounts.rs`)、文件操作 (`fops.rs`)。

#### 7. 网络栈 —— `kernel/net/axnet`

- 基于 vendored `smoltcp` 的 TCP/IP 网络栈。
- 实现 TCP/UDP socket、DNS、loopback、监听表等。

#### 8. 任务与调度 —— `kernel/task/axtask`

- 任务结构 (`task.rs`)、运行队列 (`run_queue.rs`)、等待队列 (`wait_queue.rs`)、定时器 (`timers.rs`)。
- 调度器通过 vendored `axsched` 支持 **FIFO**、**Round-Robin**、**CFS** 三种策略。
- 提供任务扩展 API (`api.rs`、`task_ext.rs`)。

#### 9. 运行时 —— `kernel/runtime/axruntime`

- 内核入口 (`rust_main`)：BSS 清零、CPU 初始化、内存初始化、分配器初始化、驱动初始化、文件系统/网络初始化、多核启动、最终进入 `main()`。
- 包含多核启动逻辑 (`mp.rs`) 和语言项 (`lang_items.rs`)。

#### 10. 同步原语 —— `kernel/sync/axsync`

- 互斥锁 (`mutex.rs`) 等内核同步工具。

#### 11. SMP/IPI —— `kernel/smp/axipi`

- 核间中断：事件通知 (`event.rs`)、消息队列 (`queue.rs`)。

#### 12. 命名空间 —— `kernel/namespace/axns`

- 全局与线程局部的键值命名空间，支持文件系统等子系统的命名隔离。

#### 13. API 抽象层 —— `api/`

| 子目录 | 功能 |
|--------|------|
| `arceos_api` | ArceOS 原生公共 API（显示、文件系统、内存、网络、任务） |
| `arceos_posix_api` | **POSIX/Linux API 层**：文件操作、IO 多路复用（epoll/select）、socket、管道、信号、pthread、资源限制、时间、系统信息等 |
| `axfeat` | Cargo feature 组合宏 |

#### 14. 用户态库 —— `ulib/`

| 子目录 | 功能 |
|--------|------|
| `axlibc` | C 标准库实现，提供 musl-libc 兼容的 C 函数（`c/` 目录下 ~40 个 .c 文件），Rust 侧补充实现（`src/` 目录） |
| `axstd` | Rust 用户态标准库精简版：文件系统、网络、线程、同步、IO |

#### 15. 用户态程序 / Linux ABI 层 —— `user/shell`

- 这是项目的**核心扩展层**，在 ArceOS 内核之上实现了完整的 Linux 用户态兼容：
  - `uspace/syscall_dispatch.rs`：829 行，注册约 231 个 Linux 系统调用。
  - `uspace/process_lifecycle.rs`：`clone`/`fork`/`vfork`/`execve`/`wait`/`exit`。
  - `uspace/memory_map.rs`：`mmap`/`mprotect`/`mremap`/`munmap`/`brk`。
  - `uspace/fd_table.rs`：统一文件描述符表、`openat`/`read`/`write`/`dup`/`fcntl` 等。
  - `uspace/fd_pipe.rs`：管道。
  - `uspace/fd_socket.rs`：socket 操作。
  - `uspace/signal_abi.rs`：信号安装、屏蔽、等待、返回。
  - `uspace/futex.rs`：futex 等待/唤醒。
  - `uspace/sysv_msg.rs`、`sysv_sem.rs`、`sysv_shm.rs`：System V IPC。
  - `uspace/posix_mq.rs`：POSIX 消息队列。
  - `uspace/program_loader.rs`：ELF 程序加载器。
  - `uspace/user_memory.rs`：用户空间内存 copy-in/copy-out。
  - `uspace/credentials.rs`：用户/组凭据管理。
  - `uspace/select_fdset.rs`、`uspace/synthetic_fs.rs`、`uspace/time_abi.rs` 等。

#### 16. Vendored 依赖 —— `vendor/`

| 子目录 | 说明 |
|--------|------|
| `axcpu` | CPU 架构抽象（trap 处理、上下文切换、各架构汇编） |
| `axfs_ramfs` | RAM 文件系统实现 |
| `axfs_vfs` | 虚拟文件系统抽象层 |
| `axsched` | 调度器实现（CFS、FIFO、Round-Robin） |
| `rust-fatfs` | FAT 文件系统（no_std 适配版） |
| `smoltcp` | TCP/IP 网络协议栈（no_std 适配版） |
| `bin/` | 预编译辅助工具（`axconfig-gen`、`cargo-axplat`、`rust-objcopy`） |

---

### 四、构建工具链

根据 `rust-toolchain.toml` 和 `Makefile` 分析，构建所需工具：

| 工具 | 用途 |
|------|------|
| **Rust nightly-2025-05-20** | 编译器（`rustc`、`cargo`），带 `rust-src`、`llvm-tools`、`rustfmt`、`clippy` 组件 |
| **GNU Make** | 顶层构建编排 |
| **Python 3** | 配置生成 (`scripts/axconfig-gen.py`) 与评测/合规检查脚本 |
| **RISC-V musl GCC**（bootlin 工具链） | RISC-V 用户态 C 程序编译（`ulib/axlibc` 的 C 部分） |
| **LoongArch GCC** | LoongArch 用户态 C 程序编译 |
| **rust-lld** | 链接器 |
| **rust-objcopy** | 二进制格式转换 |
| **mkfs.ext4 / mkfs.vfat / mcopy / dd** | 文件系统镜像制作 |
| **QEMU** (riscv64/loongarch64) | 模拟运行 |
| **dtc** | 设备树编译（用于某些物理板卡） |
| **Docker**（可选） | 容器化构建环境 |

构建目标三元组：
- `riscv64gc-unknown-none-elf`（RISC-V 裸机）
- `loongarch64-unknown-none-softfloat`（LoongArch 裸机）
- `x86_64-unknown-none` / `aarch64-unknown-none-softfloat`（也保留支持）

---

### 五、初步判断总结

1. **项目定位**：OrayS 是在 ArceOS 组件化内核基础上，面向 OS 内核比赛场景深度定制的 Linux 兼容内核。其核心工作是补全从硬件抽象到 Linux syscall ABI 的完整链路。

2. **架构层次**（自底向上）：
   - 硬件抽象 (`axhal`) -> 内存管理 (`axalloc`/`axmm`) -> 驱动 (`axdriver`) -> 文件系统 (`axfs`) / 网络 (`axnet`) -> POSIX API (`arceos_posix_api`) -> Linux ABI (`user/shell/uspace`) -> 用户程序

3. **代码规模初估**：整个 workspace 包含约 20 个内核 crate + 6 个 vendored crate + 2 个用户库 + 1 个用户程序。`user/shell/src/uspace/` 约 30 个源文件构成最核心的 Linux 兼容层，其中 `syscall_dispatch.rs` 单文件 829 行。

4. **外围基础设施**：项目配备了完善的评测脚本体系（`scripts/` 下的 `check_g*.py` 和 `test_g*.py` 系列），用于静态合规检查与回归验证，以及 LTP 测试结果汇总工具。