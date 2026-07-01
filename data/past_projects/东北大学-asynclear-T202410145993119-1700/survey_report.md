# 项目初步调查报告

## 一、项目概述

该项目名为 **asynclear**，是一个基于 Rust 语言编写的异步操作系统内核，目标架构为 **RISC-V 64 (riscv64imac)**，运行环境为 QEMU 模拟器。项目采用 Rust nightly 工具链（nightly-2024-02-03），使用 cargo workspace 管理多 crate 结构，并采用 xtask 模式进行构建与运行管理。

内核代码总量约 **8,493 行**（含汇编），工具库约 **1,766 行**，架构相关代码约 **101 行**，用户态测试程序约 **621 行**，构建工具（xtask）约 **853 行**。

---

## 二、仓库文件组织结构

```
.
├── .cargo/              # Cargo 别名配置（xtask 命令映射）
├── .vscode/             # VSCode 调试与编辑器配置
├── cargo-submit/        # 提交用的 cargo 配置副本
├── crates/              # 核心代码（workspace 成员）
│   ├── kernel/          # 内核主模块（生成内核二进制）
│   ├── arch/            # 架构相关模块
│   │   ├── riscv_guard/ # RISC-V 中断保护原语
│   │   └── riscv_time/  # RISC-V 时间读取
│   └── utils/           # 通用工具库
│       ├── common/      # 公共配置与常量
│       ├── defines/     # 内核/用户共享定义（syscall号、错误码、信号等）
│       ├── idallocator/ # 整数 ID 分配器（PID/TID）
│       ├── kernel_tracer/ # 日志与 tracing 系统
│       └── klocks/      # 锁原语（自旋锁、关中断自旋锁等）
├── deps/                # 第三方依赖（本地修改版）
│   ├── buddy_system_allocator/  # 伙伴系统内存分配器
│   └── riscv/           # RISC-V CSR 操作库
├── res/                 # 资源文件
│   ├── rustsbi-qemu.bin # RustSBI 固件（SBI）
│   └── images/          # 文件系统镜像等
├── user/                # 用户态程序
│   └── src/
│       ├── bin/preliminary_tests.rs  # 综合测试程序（32项系统调用测试）
│       ├── lib.rs       # 用户态库（fork/exec/exit/wait 封装）
│       └── syscall.rs   # 用户态系统调用封装
├── vendor/              # 离线 vendored 依赖
├── xtask/               # 构建/运行/调试工具（xtask 模式）
├── Cargo.toml           # Workspace 根配置
├── Cargo.lock           # 依赖锁定
├── makefile             # 简易构建入口
├── rust-toolchain.toml  # Rust 工具链版本锁定
└── rustfmt.toml         # 代码格式化配置
```

---

## 三、子系统划分

根据代码目录结构与内容分析，该项目实现了以下子系统：

### 1. 处理器核心管理（hart）
- **目录**: `crates/kernel/src/hart/`
- **内容**: 多 hart（硬件线程）启动与管理，内核入口（`entry.S` 汇编 + `mod.rs` 中 `__hart_entry`），主 hart 初始化并启动其他 hart。

### 2. 异常与中断处理（trap）
- **目录**: `crates/kernel/src/trap/`
- **内容**: 包含汇编 trap 入口（`trap.S`）、trap 上下文保存与恢复（`context.rs`）、内核态 trap 处理（`kernel_trap.rs`）。

### 3. 内存管理（memory）
- **目录**: `crates/kernel/src/memory/`
- **内容**: 物理地址/虚拟地址抽象（`address.rs`）、物理页帧分配器（`frame_allocator.rs`）、内核堆分配（`kernel_heap.rs`）、页表管理（`page_table.rs`）、虚拟内存区域 VMA（`vm_area.rs`）、地址空间管理（`memory_space/`）、用户空间指针校验（`user_check.rs`）。内核链接地址为 `0xffffffff80200000`（高半核）。

### 4. 进程管理（process）
- **目录**: `crates/kernel/src/process/`
- **内容**: 进程结构与管理（`mod.rs`、`inner.rs`），包含进程创建、退出等。

### 5. 线程管理（thread）
- **目录**: `crates/kernel/src/thread/`
- **内容**: 线程结构（`mod.rs`、`inner.rs`）、用户线程（`user.rs`）。

### 6. 异步执行器（executor）
- **目录**: `crates/kernel/src/executor/`
- **内容**: 基于 `async-task` 的异步任务调度器，使用 `crossbeam_queue::ArrayQueue` 作为任务队列，支持 `yield_now`。内核主循环以异步方式运行用户任务。

### 7. 系统调用（syscall）
- **目录**: `crates/kernel/src/syscall/`
- **内容**: 按功能分文件实现：文件系统调用（`fs.rs`）、内存管理调用（`memory.rs`）、进程管理调用（`process.rs`）、信号相关（`signal.rs`）、线程相关（`thread.rs`）、时间相关（`time.rs`）。从 syscall 分发代码可见，已实现的系统调用包括：getcwd、dup、dup3、fcntl64、ioctl、mkdirat、unlinkat、mount、umount、chdir、openat、close、pipe2、getdents64、read、write、readv、writev 等。

### 8. 文件系统（fs）
- **目录**: `crates/kernel/src/fs/`
- **内容**: VFS 层（dentry、inode、file）、FAT32 文件系统实现（`fat32/`）、tmpfs 临时文件系统（`tmpfs/`）、页缓存（`page_cache.rs`）、管道（`pipe.rs`）、标准 I/O（`stdio.rs`）。

### 9. 设备驱动（drivers）
- **目录**: `crates/kernel/src/drivers/`
- **内容**: QEMU virtio 块设备驱动（`qemu_block/`，含 virtio 协议实现）、QEMU PLIC 中断控制器驱动（`qemu_plic.rs`）、QEMU UART 16550 串口驱动（`qemu_uart/`，含 TTY 层）。

### 10. 信号机制（signal）
- **目录**: `crates/kernel/src/signal/`
- **内容**: 信号定义与处理（`mod.rs`）、信号处理程序（`handlers.rs`）。

### 11. 时间管理（time）
- **目录**: `crates/kernel/src/time/`
- **内容**: 时间抽象（`mod.rs`）、定时器（`timer.rs`）。

### 12. 日志与性能分析（tracer）
- **目录**: `crates/kernel/src/tracer/` + `crates/utils/kernel_tracer/`
- **内容**: 内核日志系统（支持多级日志）、基于 span 的性能分析（profiling），可输出至 perfetto 可视化工具。

### 13. 同步原语（klocks）
- **目录**: `crates/utils/klocks/`
- **内容**: 自旋锁、关中断自旋锁（`kspin.rs`），基于 `spin` crate 扩展。

### 14. 用户态程序（user）
- **目录**: `user/`
- **内容**: 用户态库封装（fork、exec、exit、wait 等）、综合测试程序覆盖 32 项系统调用（brk、chdir、clone、close、dup、dup2、execve、exit、fork、fstat、getcwd、getdents、getpid、getppid、gettimeofday、mkdir、mmap、mount、munmap、open、openat、pipe、read、sleep、times、umount、uname、unlink、wait、waitpid、write、yield）。

---

## 四、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| **Rust nightly 工具链** (nightly-2024-02-03) | 编译内核与用户程序，需要 rust-src、llvm-tools-preview 等组件 | 可用（需确认版本匹配） |
| **cargo** | 包管理与构建 | 可用 |
| **qemu-system-riscv64** | 运行内核的模拟器 | 可用 |
| **RustSBI / OpenSBI 固件** | RISC-V SBI 引导固件 | 可用（仓库内已包含 `res/rustsbi-qemu.bin`） |
| **riscv64 交叉编译工具链** (GCC/ld/objdump) | xtask 可能调用进行链接或反汇编 | 可用 |
| **GDB (riscv64)** | 调试内核 | 可用 |
| **dtc (Device Tree Compiler)** | 设备树编译（如需要） | 可用 |
| **mkfs / dd 等文件系统工具** | 制作文件系统镜像 | 可用 |

项目使用 **xtask 模式**，所有构建、运行、调试操作通过 `cargo xbuild`、`cargo qemu`、`cargo ktest` 等别名命令完成，xtask 本身是一个运行在宿主机上的 Rust CLI 程序。依赖通过 `vendor/` 目录离线提供，无需网络访问。