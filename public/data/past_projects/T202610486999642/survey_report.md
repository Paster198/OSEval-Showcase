## 项目结构与初步调查结果

---

### 一、项目概览

**WHUSP** 是一个用 Rust 编写、面向 OS 内核比赛的宏内核（monolithic kernel），双目标架构为 **RISC-V 64** 和 **LoongArch 64**。总计约 **76,455 行 Rust 代码**，分布在 **159 个源文件**中。

---

### 二、顶层目录结构

| 路径 | 用途 |
|------|------|
| `./os/` | 内核主 crate，包含全部内核源码 |
| `./vendor/` | 离线依赖：vendored crates + `lwext4_rust`（Rust 封装的 ext4 库） |
| `./scripts/` | 构建辅助脚本（比赛磁盘镜像构建、测试用例导出） |
| `./testsuits/` | 测试套件（LTP 完整测试集） |
| `./docs/` | 团队内部文档（比赛开发计划、Git 提交规范） |
| `./assets/` | 静态资源（Logo 等） |
| `./Makefile` | 顶层构建入口，支持 `make all`、`make run-rv`、`make run-la` 等 |
| `./rust-toolchain.toml` | Rust 工具链版本锁定：`nightly-2025-05-20` |

---

### 三、子系统划分

内核源码位于 `os/src/`，按功能划分为以下子系统：

#### 1. 架构层 (`arch/`)

| 子目录 | 说明 |
|--------|------|
| `arch/riscv64/` | RISC-V 64 架构特定代码：入口、中断/陷阱、上下文切换、MMU、定时器、SBI、信号、栈回溯 |
| `arch/loongarch64/` | LoongArch 64 架构特定代码：入口、中断/陷阱（含 IOCSR/IRQ 控制器）、上下文切换、MMU、定时器、SBI、信号、栈回溯 |

关键文件：`entry.asm`、`switch.S`、`trap/trap.S`、`board.rs`（板级初始化/DTB 解析）、`mm.rs`（架构级 MMU 操作）、`signal.rs`、`timer.rs`。

#### 2. 内存管理 (`mm/`)

| 文件 | 功能 |
|------|------|
| `frame_allocator.rs` | 物理帧分配器 |
| `heap_allocator.rs` | 内核堆分配器 |
| `page_table.rs` | 页表管理 |
| `memory_set.rs` | 虚拟地址空间抽象 |
| `address.rs` | 物理/虚拟地址类型 |
| `area.rs` | 内存区域（映射区域） |
| `elf_loader.rs` | ELF 加载器 |
| `kernel_space.rs` / `user_space.rs` | 内核/用户地址空间 |
| `page_cache.rs` | 页面缓存 |
| `shm.rs` | 共享内存 |

#### 3. 进程/任务管理 (`task/`)

| 文件 | 功能 |
|------|------|
| `task.rs` | TaskControlBlock（线程控制块） |
| `process.rs` | ProcessControlBlock（进程控制块）、凭证、资源限制 |
| `manager.rs` | 任务管理器（调度队列、PID 分配） |
| `processor.rs` | 处理器抽象（当前任务、调度、上下文切换） |
| `clone.rs` | clone 系统调用实现 |
| `exec.rs` | execve 实现 |
| `initproc.rs` | 初始进程创建 |
| `signal.rs` | 信号处理 |
| `ptrace.rs` | ptrace 调试支持 |
| `futex.rs` | futex 支持 |
| `fd.rs` | 文件描述符表 |
| `id.rs` | PID、内核栈分配 |
| `process_lifecycle.rs` | 进程生命周期管理 |
| `contest_runner.rs` | 比赛测试用例运行器 |

#### 4. 文件系统 (`fs/`)

这是子系统中最丰富的模块：

| 文件 | 功能 |
|------|------|
| `vfs/` | 虚拟文件系统框架（backend、file、node、path、error） |
| `ext4.rs` | EXT4 文件系统支持（通过 `lwext4_rust`） |
| `fat.rs` | FAT 文件系统支持（vendored `fatfs`） |
| `procfs.rs` | proc 伪文件系统 |
| `devfs.rs` | dev 设备文件系统 |
| `tmpfs.rs` | 临时文件系统 |
| `overlayfs.rs` | Overlay 文件系统 |
| `cgroupfs.rs` | cgroup 文件系统 |
| `staticfs.rs` | 静态文件系统 |
| `pipe.rs` | 匿名管道 |
| `named_fifo.rs` | 命名管道 (FIFO) |
| `socket.rs` | Socket 文件 |
| `eventfd.rs` | eventfd |
| `timerfd.rs` | timerfd |
| `memfd.rs` | memfd |
| `anonfd.rs` | 匿名 fd |
| `stdio.rs` | 标准输入输出 |
| `console_tty.rs` | 控制台 TTY（终端控制、termios、winsize） |
| `inode.rs` / `dentry_cache.rs` | inode / dentry 缓存 |
| `mount.rs` / `mount_fd.rs` | 挂载管理 |
| `path.rs` / `dirent.rs` | 路径解析 / 目录项 |
| `status_flags.rs` | 文件状态标志 |

#### 5. 系统调用 (`syscall/`)

| 子目录/文件 | 功能 |
|-------------|------|
| `mod.rs` | 系统调用分发表（>200 个 Linux 兼容系统调用号） |
| `fs/` | 文件系统相关系统调用：读写、打开、stat、poll/epoll、inotify、fanotify、file handle、mount、quota、swap、TTY、权限等 |
| `process/` | 进程相关系统调用：clone、exec、ID、identity、namespace、ptrace、resource、sched、system、pidfd |
| `memory.rs` | 内存相关系统调用（mmap、munmap、brk 等） |
| `signal.rs` | 信号系统调用 |
| `time.rs` | 时间相关系统调用 |
| `futex.rs` | futex 系统调用 |
| `net.rs` | 网络相关系统调用 |
| `aio.rs` | 异步 IO 系统调用 |
| `msg.rs` / `sem.rs` | System V IPC（消息队列、信号量） |
| `keyring.rs` | 内核密钥环 |
| `kmodule.rs` | 内核模块 |
| `context.rs` | 系统调用上下文 |
| `errno.rs` | 错误码定义 |
| `uapi.rs` / `user_ptr.rs` | 用户空间 API 和指针 |
| `wait.rs` | wait 系列系统调用 |

#### 6. 设备驱动 (`drivers/`)

| 文件 | 功能 |
|------|------|
| `virtio.rs` | VirtIO 传输层（MMIO / PCI） |
| `block.rs` | VirtIO 块设备驱动 |
| `block_cache.rs` | 块缓存 |
| `chardev.rs` | 字符设备抽象（UART/NS16550a） |
| `input.rs` | 输入设备（键盘、鼠标） |
| `plic.rs` | RISC-V PLIC 中断控制器（仅 RISC-V） |

LoongArch 的中断控制器（EIOINTC/PCH-PIC）直接实现在 `arch/loongarch64/irq.rs`。

#### 7. 同步原语 (`sync/`)

| 文件 | 功能 |
|------|------|
| `up.rs` | `UPIntrFreeCell` / `UPIntrRefMut`（单核中断安全互斥） |
| `sleep_mutex.rs` | `SleepMutex`（阻塞互斥锁） |
| `condvar.rs` | `Condvar`（条件变量） |

#### 8. 基础设施

| 文件 | 功能 |
|------|------|
| `main.rs` | 内核入口 `rust_main`：BSS 清零、板级初始化、MM 初始化、驱动初始化、启动调度 |
| `config.rs` | 内核常量配置（栈大小、堆大小、页大小、mmap 布局等） |
| `console.rs` | 控制台输出（`print!` / `println!` 宏） |
| `logging.rs` | 基于 `log` crate 的日志系统 |
| `lang_items.rs` | Rust `#![no_std]` 语言项（panic handler、栈回溯） |
| `vdso.rs` | vDSO 实现（`__vdso_clock_gettime` 等） |
| `perf.rs` | 性能计数器/性能剖析点（仅 `perf-counters` feature 启用，约 134 KB） |
| `linker-qemu.ld` / `linker-loongarch64.ld` | 链接脚本 |

---

### 四、构建工具链

| 工具 | 用途 |
|------|------|
| **Rust nightly-2025-05-20** + `rust-src`、`llvm-tools`、`rustfmt`、`clippy` | 内核编译 |
| **Cargo**（通过 `vendor/` 实现离线构建） | 依赖管理 |
| **目标三元组**：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none` | 交叉编译 |
| **GNU Make** | 顶层构建编排 |
| **QEMU** ≥ 10.0.2（`qemu-system-riscv64`、`qemu-system-loongarch64`） | 模拟运行 |
| **Python 3** | 测试用例脚本导出 |
| **mkfs.ext4** | 制作 ext4 测试磁盘镜像 |
| **OpenSBI**（QEMU `-bios default`） | RISC-V SBI 固件 |
| **FDT (Flattened Device Tree)** | 硬件信息解析 |

构建流程：`make all` → 格式化 → 构建比赛磁盘 → 编译 RISC-V 内核 → 编译 LoongArch 内核。

---

### 五、关键特征摘要

1. **双架构支持**：RISC-V 64 和 LoongArch 64 共享绝大部分上层代码，差异集中在 `arch/` 目录。
2. **Linux 兼容性**：实现了超过 200 个 Linux 系统调用号，覆盖文件系统、进程管理、信号、IPC、网络、时间等主要子系统。
3. **丰富的文件系统支持**：VFS 框架下集成了 EXT4、FAT、procfs、devfs、tmpfs、overlayfs、cgroupfs 等多种文件系统。
4. **VirtIO 驱动**：块设备、网络设备通过 VirtIO 协议驱动，RISC-V 使用 MMIO 传输，LoongArch 使用 PCI 传输。
5. **完全离线构建**：所有依赖 vendored 在 `vendor/crates/` 中，无需网络。