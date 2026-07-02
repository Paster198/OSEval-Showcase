## 项目结构初步调查报告

### 一、仓库顶层结构

该仓库是一个面向 2026 年 OS 内核实现赛道的竞赛项目，内核基于 Byte-OS/ByteOS 导入，使用 Rust (no_std) 编写，支持 RISC-V、x86_64、AArch64、LoongArch 四种架构。

```
.
├── Makefile                    # 根构建入口: make all -> kernel-rv + kernel-la
├── kernel/                     # 内核主体 (Rust workspace)
├── vendor/                     # 离线依赖 vendored crates（约 80+ 个）
├── third_party/                # C 语言第三方依赖 (lwext4, git submodule)
├── harness/                    # 测试 harness 脚本 (run-rv.sh, run-la.sh, common.sh)
├── scripts/                    # 辅助脚本 (docker-shell.sh)
├── analysis/                   # 测试结果分析 (LTP 分类)
├── contest_capture/            # 比赛相关抓取数据
├── review_packets/             # 比赛期间的 review/task 记录 (~70 个 Markdown)
├── docs/                       # 项目文档 (PROJECT_BOOK.md, PLAYBOOK.md 等)
└── .cargo/                     # Cargo 配置 (vendor source 重定向)
```

### 二、内核子系统及其代码位置

内核主体位于 `kernel/`，是一个 Rust workspace，包含 18 个 crate，约 126 个 `.rs` 源文件，总计约 19,418 行 Rust 代码。

#### 2.1 核心内核 crate (`kernel/kernel/`)

| 子模块 | 位置 | 功能描述 |
|--------|------|----------|
| 入口/主循环 | `kernel/kernel/src/main.rs` (228行) | 内核入口 `main(hart_id)`，初始化各子系统，启动异步任务执行器 |
| 系统调用 | `kernel/kernel/src/syscall/` | 系统调用分发与实现，约 9 个源文件 |
| - 文件描述符 | `syscall/fd.rs` (56KB) | 文件描述符操作 |
| - 内存管理 | `syscall/mm.rs` (5KB) | mmap/munmap 等 |
| - 进程/线程 | `syscall/task.rs` (22KB) | fork/clone/exec 等 |
| - 信号 | `syscall/signal.rs` (6KB) | 信号处理 |
| - Socket | `syscall/socket.rs` (19KB) | Socket 系统调用 |
| - 时间 | `syscall/time.rs` (8KB) | 时间相关系统调用 |
| - 共享内存 | `syscall/shm.rs` (3KB) | 共享内存 |
| - 杂项 | `syscall/sys.rs` (23KB), `syscall/mod.rs` (26KB) | 其他系统调用及分发 |
| 任务管理 | `kernel/kernel/src/tasks/` | 进程/线程/异步任务管理，约 10 个源文件 |
| - 核心 | `tasks/task.rs` (23KB), `tasks/exec.rs` (12KB) | 任务结构体、调度、执行 |
| - ELF加载 | `tasks/elf.rs` (3KB) | ELF 可执行文件加载 |
| - init进程 | `tasks/initproc.rs` (33KB) | init 进程逻辑 |
| - 异步操作 | `tasks/async_ops.rs` (4KB) | 异步 I/O 操作 |
| 用户态接口 | `kernel/kernel/src/user/` | 用户态入口、信号处理、socket pair |
| 看门狗 | `kernel/kernel/src/watchdog.rs` (3KB) | 任务超时检测 |
| Socket | `kernel/kernel/src/socket.rs` (7KB) | 内核态 socket 管理 |
| 工具 | `kernel/kernel/src/utils/` | 用户空间引用、辅助函数 |

#### 2.2 基础库 crates (`kernel/crates/`)

| Crate | 位置 | 功能 |
|-------|------|------|
| `devices` | `crates/devices/` | 设备抽象与管理（device.rs, lib.rs） |
| `executor` | `crates/executor/` | 异步任务执行器（executor.rs, task.rs, thread.rs） |
| `runtime` | `crates/runtime/` | 物理帧分配器（frame.rs 7.6KB）与堆分配（heap.rs） |
| `libc-types` | `crates/libc-types/` | C 标准库类型定义（fcntl, signal, termios, epoll, futex, ioctl, sched, mman 等，约 20 个源文件） |
| `sync` | `crates/sync/` | 同步原语（Mutex 等） |
| `polyhal-trap` | `crates/polyhal-trap/` | 架构相关 trap 处理（fork 自 polyhal 0.4.0，含 riscv64/loongarch64/x86_64/aarch64 四种架构实现） |

#### 2.3 文件系统 (`kernel/filesystem/`)

| Crate | 位置 | 功能 |
|-------|------|------|
| `vfscore` | `filesystem/vfscore/` | VFS 核心抽象层（inode, dentry, superblock 等概念） |
| `fs` | `filesystem/fs/` | 文件系统整合层：File (14KB), dentry, pathbuf, pipe, fatfs_shim (14KB) |
| `devfs` | `filesystem/devfs/` | 设备文件系统：/dev/null, /dev/zero, /dev/tty, /dev/urandom, /dev/rtc, /dev/shm, /dev/sdx |
| `procfs` | `filesystem/procfs/` | 进程文件系统：/proc/meminfo, /proc/interrupts, /proc/mounts |
| `ramfs` | `filesystem/ramfs/` | 内存文件系统（18KB 单文件实现） |
| `ext4fs` | `filesystem/ext4fs/` | EXT4 文件系统实现（基于 C 库 lwext4 的 FFI 绑定，14KB） |
| `ext4rsfs` | `filesystem/ext4rsfs/` | EXT4 文件系统纯 Rust 实现（基于 ext4_rs crate，9.6KB） |

注：通过 `cfg(root_fs = ...)` 条件编译选择 fat32/ext4/ext4_rs 三种根文件系统后端之一。

#### 2.4 设备驱动 (`kernel/driver/`)

| Crate | 位置 | 功能 |
|-------|------|------|
| `kvirtio` | `driver/kvirtio/` | VirtIO 驱动：virtio_blk, virtio_net, virtio_input, virtio_impl |
| `kramdisk` | `driver/kramdisk/` | RAM 磁盘驱动 |
| `ns16550a` | `driver/ns16550a/` | NS16550A UART 串口驱动 |
| `general-plic` | `driver/general-plic/` | 平台级中断控制器（PLIC）驱动 |
| `kgoldfish-rtc` | `driver/kgoldfish-rtc/` | Goldfish RTC 时钟驱动 |

### 三、编译构建所需工具

根据根 `Makefile`、`kernel/Makefile`、`kernel/rust-toolchain.toml` 和 `kernel/.cargo/config.toml` 分析：

| 工具 | 用途 |
|------|------|
| **Rust nightly-2025-01-18** | 编译器 toolchain |
| **Cargo** (offline mode) | 构建管理，依赖已 vendored |
| **rust-objcopy** (llvm-tools-preview) | 将 ELF 转为 raw binary |
| **GNU Make** | 构建编排 |
| **QEMU** (多架构) | 模拟运行：qemu-system-riscv64, qemu-system-x86_64, qemu-system-aarch64, qemu-system-loongarch64 |
| **mkfs.ext4 / mkfs.vfat** | 制作根文件系统镜像 |
| **dd, mount** | 镜像操作 |
| **Deno** | 可选的 `byteos` TypeScript 构建前端（非必须，Makefile 直接调用 cargo） |
| **RISC-V/LoongArch 交叉编译目标** | `riscv64imac-unknown-none-elf`, `loongarch64-unknown-none` |

支持的目标平台（通过 `PLATFORM` 变量选择）：
- `riscv64-qemu`（默认）、`riscv64-vf2`（VisionFive2）
- `x86_64-qemu`、`x86_64-generic`
- `aarch64-qemu`
- `loongarch64-qemu`、`loongarch64-2k1000`

构建产物为两个内核 ELF 文件：`kernel-rv`（RISC-V）和 `kernel-la`（LoongArch），由根 `make all` 生成。

### 四、子系统依赖关系总览

```
kernel (main crate)
 ├── devices ──────── 设备抽象与发现
 ├── executor ─────── 异步任务执行器
 ├── runtime ──────── 物理内存/帧管理
 ├── sync ─────────── 同步原语
 ├── libc-types ───── C 类型定义（供 syscall 使用）
 ├── polyhal ──────── 硬件抽象层（外部依赖）
 ├── polyhal-boot ─── 多核启动
 ├── polyhal-trap ─── 陷阱/中断处理
 ├── fs ───────────── 文件系统整合 ──┬── vfscore (VFS 抽象)
 │                                   ├── devfs, procfs, ramfs
 │                                   ├── ext4fs 或 ext4rsfs 或 fatfs
 │                                   └── pipe
 ├── kvirtio ──────── VirtIO 驱动（块/网/输入）
 ├── kramdisk ─────── RAM 磁盘
 ├── ns16550a ─────── 串口
 ├── general-plic ─── PLIC 中断控制器
 ├── kgoldfish-rtc ── RTC 时钟
 └── lose-net-stack ─ 网络协议栈（外部依赖）
```