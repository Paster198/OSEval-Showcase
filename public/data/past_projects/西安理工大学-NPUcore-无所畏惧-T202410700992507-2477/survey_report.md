# NPUcore+ 项目初步调查报告

## 1. 项目概述

NPUcore+ 是一个基于 RISC-V 架构的操作系统内核项目，使用 Rust 语言编写，源自 rCore-Tutorial 教学操作系统，参加了 2023 年全国大学生操作系统比赛（oskernel2023）。目标平台为 QEMU virt 虚拟机（RISC-V 64位）和 K210 开发板，同时包含对 SiFive FU740 SoC 的实验性支持。

## 2. 仓库文件组织结构

```
.
├── Makefile              # 顶层构建入口
├── README.md             # 项目说明文档
├── rust-toolchain        # Rust 工具链版本锁定 (nightly-2022-04-11)
├── .gitignore
├── os/                   # 内核主体
│   ├── Cargo.toml        # 内核 Rust 包配置
│   ├── Makefile          # 内核构建脚本
│   └── src/              # 内核源码
├── user/                 # 用户态程序
│   ├── Cargo.toml
│   ├── Makefile
│   └── src/
├── easy-fs/              # 简易文件系统库（FAT32 实现）
│   └── src/
├── easy-fs-fuse/         # 文件系统镜像制作工具（FUSE 方式）
├── bootloader/           # 引导加载程序二进制（OpenSBI fw_jump.bin, fw_payload.bin, RustSBI）
├── rustsbi-k210/         # K210 平台的 RustSBI 固件源码
├── bash-5.1.16/          # Bash 5.1.16 源码（交叉编译为用户态 shell）
├── vendor/               # Rust 第三方依赖（离线 vendor 目录）
└── docs/                 # 项目文档
```

## 3. 子系统分析

### 3.1 架构与平台适配层 (`os/src/arch/`)

- 目录 `os/src/arch/rv64/` 包含 RISC-V 64 位架构相关实现
- 包含：启动汇编 (`entry.asm`)、SBI 调用封装 (`sbi.rs`)、上下文切换 (`switch.S`/`switch.rs`)、异常/中断处理 (`trap/`)、SV39 分页 (`sv39.rs`)、时钟 (`time.rs`)、SD 卡驱动 (`sdcard.rs`)、系统调用号定义 (`syscall_id.rs`)
- 板级配置：`board/qemu.rs`、`board/k210.rs`、`board/fu740.rs`

### 3.2 内存管理子系统 (`os/src/mm/`)

- `address.rs` — 物理/虚拟地址抽象
- `frame_allocator.rs` — 物理页帧分配器
- `heap_allocator.rs` — 内核堆分配器（基于 buddy_system_allocator）
- `memory_set.rs` — 地址空间管理（MemorySet）
- `page_table.rs` — 页表操作，用户空间数据拷贝
- `map_area.rs` — 内存映射区域、映射权限
- `zram.rs` — 压缩内存（zram）支持，用于 OOM 处理
- 特性开关：`swap`（交换分区）、`zram`（压缩内存）、`oom_handler`（OOM 处理）

### 3.3 进程/任务管理子系统 (`os/src/task/`)

- `task.rs` — 任务控制块（TCB/PCB），包含进程状态、信号、futex 等
- `manager.rs` — 任务调度队列管理（就绪队列、可中断等待队列）
- `processor.rs` — 处理器抽象，当前任务获取
- `pid.rs` — PID/TID 分配，内核栈管理
- `context.rs` — 任务上下文
- `elf.rs` — ELF 加载器（含动态链接器/解释器加载、auxv 支持）
- `signal.rs` — 信号机制实现
- `threads.rs` — 多线程支持

### 3.4 文件系统子系统 (`os/src/fs/`)

- `fat32/` — FAT32 文件系统实现（bitmap、目录迭代、inode、布局、VFS 接口）
- `cache.rs` — 页缓存（PageCache）
- `directory_tree.rs` — 目录树管理（VFS 层）
- `filesystem.rs` — 文件系统抽象
- `file_trait.rs` — 文件 trait 定义
- `layout.rs` — 文件系统数据结构（Stat、Dirent、OpenFlags 等）
- `poll.rs` — poll/select 支持（FdSet）
- `swap.rs` — 交换分区支持
- `dev/` — 设备文件：
  - `null.rs` — /dev/null
  - `zero.rs` — /dev/zero
  - `pipe.rs` — 管道
  - `tty.rs` — 终端
  - `socket.rs` — 套接字文件
  - `hwclock.rs` — 硬件时钟

### 3.5 系统调用子系统 (`os/src/syscall/`)

- `mod.rs` — 系统调用分发器，定义了约 80+ 个系统调用号
- `fs.rs` — 文件系统相关系统调用（open、read、write、lseek、mkdir、unlink、rename、stat、poll、select 等）
- `process.rs` — 进程相关系统调用（fork/clone、exec、wait、exit、mmap、mprotect、futex、signal 等）
- `socket.rs` — 网络套接字系统调用（socket、bind、listen、accept、connect、sendto、recvfrom 等）
- `errno.rs` — 错误码定义

### 3.6 驱动子系统 (`os/src/drivers/`)

- `block/` — 块设备驱动：
  - `virtio_blk.rs` — VirtIO 块设备驱动
  - `mem_blk.rs` — 内存块设备（用于 zram）
  - `block_dev.rs` — 块设备抽象
- `serial/` — 串口驱动：
  - `ns16550a.rs` — NS16550A UART 驱动

### 3.7 用户态程序 (`user/`)

- 使用 Rust 编写的用户态测试程序：initproc（init 进程）、fork_test、getpid、getrusage、sbrk、openat、ls、mkdir 等
- 包含自定义系统调用封装 (`syscall.rs`, `usr_call.rs`)

### 3.8 外部组件

- `bash-5.1.16/` — GNU Bash shell，通过 RISC-V musl 交叉编译工具链编译为用户态程序
- `easy-fs/` — 独立的 FAT32 文件系统库（no_std），可被内核和用户态工具共用
- `easy-fs-fuse/` — 文件系统镜像制作工具
- `rustsbi-k210/` — K210 平台的 SBI 固件
- `bootloader/` — 预编译的 OpenSBI 固件二进制

## 4. 构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|----------------|
| Rust nightly-2022-04-11 | 内核和用户态 Rust 代码编译 | 可用（rustup） |
| riscv64gc-unknown-none-elf target | Rust 交叉编译目标 | 可通过 rustup 安装 |
| cargo / rustc | Rust 构建系统 | 可用 |
| rust-objcopy / rust-objdump | ELF 转 BIN、反汇编（cargo-binutils） | 可用 |
| rust-src, llvm-tools-preview | Rust 标准库源码和 LLVM 工具 | 可用 |
| riscv64-linux-musl-gcc | Bash 交叉编译（musl libc） | **缺失** |
| riscv64-linux-musl-ar | Bash 静态库打包 | **缺失** |
| riscv64-linux-musl-objcopy | Bash 二进制 strip | **缺失** |
| QEMU (riscv64) | 运行和调试内核 | 可用 |
| GNU Make | 构建编排 | 可用 |
| Python 3 | K210 烧录工具（kflash.py） | 可用 |
| mkfs.vfat | FAT32 文件系统镜像制作 | 可用 |
| dd | 二进制拼接 | 可用 |

**关键缺失**：RISC-V musl 交叉编译工具链（`riscv64-linux-musl-gcc` 等）在当前环境中不可用，这将导致 Bash 5.1.16 无法交叉编译。内核主体和用户态 Rust 程序的编译不受影响。

## 5. 初步观察

- 该项目基于 rCore-Tutorial v3 进行了大量扩展，增加了 FAT32 文件系统、信号机制、多线程、futex、poll/select、socket、zram 压缩内存、OOM 处理等功能。
- 内核采用模块化设计，通过 Rust 的 feature flag 控制不同平台和功能的编译组合。
- 默认构建配置（`comp` feature）针对 QEMU 平台，启用 OOM handler（含 swap + zram），关闭日志输出。
- 项目支持 SMP（多核），README 中的 QEMU 启动命令使用了 `-smp 2`。
- 用户态同时包含 Rust 编写的测试程序和交叉编译的 GNU Bash shell。