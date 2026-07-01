# Being[3]++ OS 内核项目初步调查报告

## 项目概述

Being[3]++ 是由杭州电子科技大学（HDU）三位同学基于历届内核及 Linux 实现参考开发的一个 RISC-V 64 位简单 OS 内核，使用 Rust 语言编写，支持多核 CPU。目标平台为 QEMU virt 虚拟机，计划支持 VisionFive 2 开发板。项目面向 OS 内核比赛（BEING[3]++ 初赛）。

内核源码总量约 13,585 行（Rust + 汇编），不含 vendor 依赖。

---

## 仓库文件组织结构

```
.
├── Makefile                  # 顶层构建入口
├── README.md                 # 项目说明
├── BEING[3]++初赛文档.pdf     # 比赛文档
├── .gitmodules               # Git 子模块（OpenSBI）
├── .github/                  # CI 配置（镜像、semver）
├── .vscode/                  # VSCode/RA 编辑器配置
├── docs/                     # 项目文档（调试、FAT32、系统调用等）
├── firmware/                 # OpenSBI 固件（Git 子模块）
├── crates/                   # 辅助 Rust crate
│   ├── libd/                 # 用户态 C 运行时库 / init 进程
│   ├── nix/                  # Linux 兼容数据结构（CloneFlags, Utsname, TimeSpec 等）
│   ├── riscv/                # RISC-V 寄存器访问库（本地修改版）
│   └── sync_cell/            # 同步原语（SyncCell）
├── kernel/                   # 内核主体源码
│   ├── Cargo.toml            # Rust 项目配置
│   ├── Makefile              # 内核构建/运行/调试规则
│   ├── build.rs              # 构建脚本（嵌入 initproc）
│   ├── linkerld/linker.ld    # 链接脚本（基地址 0xffffffc080200000）
│   ├── bootloader/           # RustSBI QEMU 固件
│   ├── vendor/               # 离线 vendored 依赖（约 40 个 crate）
│   └── src/                  # 内核源码
│       ├── main.rs           # 入口 & 初始化流程
│       ├── entry.S           # 汇编入口
│       ├── boards/qemu.rs    # QEMU 平台参数
│       ├── consts.rs         # 全局常量
│       ├── console.rs        # 控制台输出
│       ├── logging.rs        # 日志系统
│       ├── sbi.rs            # SBI 调用封装
│       ├── mm/               # 内存管理子系统
│       ├── process/          # 进程/线程管理子系统
│       ├── fs/               # 文件系统子系统
│       ├── syscall/          # 系统调用子系统
│       ├── trap/             # 异常/中断处理
│       ├── drivers/          # 设备驱动
│       ├── timer/            # 定时器
│       ├── executor/         # 异步任务调度器
│       ├── processor/        # 处理器/Hart 管理
│       ├── sync/             # 同步原语（互斥锁）
│       ├── macros/           # 宏定义
│       └── utils/            # 工具模块（路径、哈希表、基数树、栈追踪、时间追踪等）
├── misc/                     # 用户态测例
│   └── user/                 # C 语言系统调用测试程序（oscomp 测例集）
└── workspace/                # FAT32 镜像构建工作区
    └── Makefile              # 镜像制作规则
```

---

## 已实现的子系统

### 1. 内存管理（mm/）

| 文件 | 职责 |
|------|------|
| `address.rs` | 物理/虚拟地址与页号的数据类型封装 |
| `frame_allocator.rs` | 物理页帧分配器 |
| `heap_allocator.rs` | 内核堆分配器（buddy_system_allocator） |
| `kernel_vmm.rs` | 内核虚拟内存管理 |
| `page_table.rs` | SV39 多级页表操作 |
| `memory_set/` | 地址空间管理（MemorySet、VMA、MapPermission） |
| `vma.rs` | 虚拟内存区域 |
| `user_buffer.rs` | 用户缓冲区访问 |

特性：支持 COW（Copy-on-Write）、懒分配（lazy alloc）、mmap/munmap。

### 2. 进程与线程管理（process/）

| 文件/目录 | 职责 |
|-----------|------|
| `manager.rs` | 进程管理器、进程组管理器 |
| `thread/` | 线程结构、调度（schedule）、退出（exit）、ID 分配（id）、线程循环（thread_loop） |
| `initproc/` | 初始进程（嵌入内核的 initproc ELF） |
| `signals/` | 信号机制（signal_flags、SigSet） |

特性：支持 fork/clone、execve、wait4、进程组、信号（kill/tkill/tgkill/sigaction/sigprocmask/sigreturn）。

### 3. 文件系统（fs/）

| 目录 | 职责 |
|------|------|
| `vfs/` | 虚拟文件系统层（inode、file、dirent、superblock、page_cache、pipe、open_flags、stat、file_page、file_system） |
| `fat32/` | FAT32 文件系统实现（BPB、FAT、dentry、inode、file、fsinfo、time） |
| `stdio/` | 标准输入/输出/错误设备 |

特性：VFS 抽象层、挂载管理、inode 缓存、管道（pipe）、页缓存。

### 4. 系统调用（syscall/）

| 文件 | 职责 |
|------|------|
| `dispatcher.rs` | 系统调用分发器（约 80+ 个系统调用 ID 定义） |
| `impls/fs.rs` | 文件系统相关系统调用实现 |
| `impls/mm.rs` | 内存管理相关系统调用实现 |
| `impls/process.rs` | 进程管理相关系统调用实现 |
| `impls/others.rs` | 其他系统调用实现 |
| `errno.rs` | 错误码定义 |

已声明的系统调用涵盖：文件操作（openat/close/read/write/lseek/mkdirat/unlinkat/linkat/getdents64 等）、进程操作（clone/execve/wait4/exit/kill 等）、内存操作（brk/mmap/munmap/mprotect）、信号、定时器、调度、mount/umount 等。部分系统调用已声明但尚未实现（dispatcher 中会 panic）。

### 5. 异常/中断处理（trap/）

包含 trap 上下文（TrapContext）、trampoline 汇编（trampoline.S）、trap 处理函数（handler.rs）。支持用户态与内核态 trap 分离处理。

### 6. 设备驱动（drivers/）

目前仅实现了 VirtIO 块设备驱动（`block/virtio_blk.rs`、`block/virtio_impl.rs`），基于 `virtio-drivers` crate。

### 7. 定时器（timer/）

系统时钟管理、sleep 任务支持，基于 RISC-V mtime 和 SBI set_timer。

### 8. 异步执行器（executor/）

基于 `async-task` crate 实现的异步任务队列调度器，支持任务抢占（push_preempt）和 yield_now。

### 9. 处理器管理（processor/）

多 Hart（硬件线程）管理，每 Hart 本地上下文（context.rs）、环境上下文（env.rs）、Hart 状态管理（hart.rs）。配置支持最多 8 个 Hart（HART_NUM=8），QEMU 默认启动 2 核。

### 10. 同步原语（sync/）

提供自旋互斥锁（spin_mutex）和睡眠互斥锁（sleep_mutex），以及 SpinNoIrqLock（关中断自旋锁）。

---

## 构建工具需求

| 工具 | 用途 | 状态 |
|------|------|------|
| **Rust 工具链**（cargo, rustc, rust-objcopy, rust-objdump） | 内核编译、链接、二进制生成 | 可用 |
| **riscv64gc-unknown-none-elf** target | 内核裸机目标 | 可用（rustup target） |
| **RISC-V 交叉编译工具链**（riscv64-unknown-elf-gcc 等） | 用户态测例编译 | 可用 |
| **QEMU**（qemu-system-riscv64） | 运行与调试 | 可用 |
| **GNU Make** | 构建编排 | 可用 |
| **mkfs.vfat / dd / mount** | FAT32 文件系统镜像制作 | 可用 |
| **CMake** | 用户态 C 测例构建 | 可用 |
| **GDB**（gdb-multiarch） | 远程调试 | 可用 |
| **OpenSBI / RustSBI** | SBI 固件（bootloader） | 可用（bootloader/rustsbi-qemu 已内置） |
| **Git** | 子模块管理（OpenSBI） | 可用 |

构建流程概要：
1. 先编译 `crates/libd`（initproc 用户态程序）
2. 编译 `misc/user`（C 语言 oscomp 测例）
3. 将测例打包到 FAT32 镜像（`workspace/fat32.img`）
4. 编译内核（`cargo build --release`），生成 ELF 并 objcopy 为 bin
5. 使用 QEMU 启动，加载 RustSBI 固件 + 内核 bin + FAT32 镜像