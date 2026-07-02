# Ferriswheel OS 项目初步调查

## 一、项目总览

该项目名为 **Ferriswheel OS**，是一个用于操作系统比赛（OSKernel2026）的内核项目。项目基于 Rust `#![no_std]` 开发，包含两套内核实现（RISC-V 和 LoongArch），以模块化方式组织，目标是运行标准 Linux 测试程序（busybox、iozone、LTP 等）。

## 二、目录结构

```
.
├── os/                    # RISC-V (RV64GC) 内核实现
│   ├── src/
│   │   ├── main.rs        # 内核入口
│   │   ├── config.rs      # 内核常量配置
│   │   ├── lang_items.rs  # Rust no_std 语言项
│   │   ├── sbi.rs         # SBI 调用封装
│   │   ├── timer.rs       # 时钟中断与定时器
│   │   ├── console.rs     # 控制台输出
│   │   ├── logging.rs     # 日志
│   │   ├── boards/        # 板级配置 (QEMU)
│   │   ├── mm/            # 内存管理 (5 文件, ~1528 行)
│   │   ├── task/          # 任务/进程管理 (9 文件, ~1499 行)
│   │   ├── syscall/       # 系统调用 (9 文件, ~3936 行)
│   │   ├── fs/            # 文件系统 VFS + ext4 (9 文件, ~1669 行)
│   │   ├── trap/          # 异常/中断处理 (2 文件, ~228 行)
│   │   ├── drivers/       # 块设备驱动 (3 文件, ~128 行)
│   │   └── sync/          # 同步原语 (6 文件, ~287 行)
│   ├── vendor/            # 离线依赖 vendor
│   └── Cargo.toml
│
├── os-la/                 # LoongArch (LA64) 内核实现
│   ├── src/
│   │   ├── main.rs, config/, drivers/, fs/, mm/,
│   │   ├── task/, trap/, syscall/, sync/, signal/, utils/
│   └── Cargo.toml         # 使用 polyhal 抽象层
│
├── os-la-patch/           # LoongArch 内核的补丁依赖
│   ├── cty/, polyhal/, polyhal-trap/, virtio-drivers/
│
├── user/                  # 用户态程序 (initproc + 测试程序)
│   ├── src/bin/           # 56 个用户态测试/示例程序
│   ├── src/lib.rs         # 用户库 (含 syscall 封装)
│   └── basic/user/        # 额外的基础测试
│
├── lwext4_rust/           # ext4 文件系统 Rust 封装 (C库绑定)
│   ├── src/               # bindings, blockdev, file, lib
│   └── c/lwext4/          # 上游 C 实现 (lwext4)
│
├── deps/                  # 依赖项
│   ├── riscv/             # RISC-V 寄存器/指令封装
│   └── virtio-drivers/    # VirtIO 驱动
│
├── scripts/               # 构建辅助脚本 (mkfs_ext4.sh)
├── autotest/              # 自动化测试框架
├── eval_data/             # 评测数据 (sdcard 镜像、judge 脚本)
├── docs/                  # 文档 (CONCEPTS, FS_ARCH, ROADMAP 等)
├── logs/                  # 开发日志
├── status/                # 状态报告
├── Makefile               # 顶层构建入口
├── CLAUDE.md              # 项目说明文档
├── DEVLOG.md              # 开发记录
└── Dockerfile             # 容器构建环境
```

## 三、子系统划分

### 1. 内存管理 (Memory Management)
- **RISC-V**: `os/src/mm/` — 页帧分配器（`frame_allocator.rs`）、堆分配器（`heap_allocator.rs`）、SV39 页表（`page_table.rs`）、地址空间/MapArea/MemorySet（`memory_set.rs`）、虚拟/物理地址抽象（`address.rs`）。
- **LoongArch**: `os-la/src/mm/` — 类似结构，额外增加了共享内存（`shm.rs`）和更细粒度的映射区域管理。

### 2. 任务与进程管理 (Task/Process Management)
- **RISC-V**: `os/src/task/` — 进程控制块（`process.rs`）、任务控制块（`task.rs`）、上下文切换（`switch.rs`/`context.rs`）、调度器（`manager.rs`/`processor.rs`）、信号（`signal.rs`）、PID 分配（`id.rs`）。
- **LoongArch**: `os-la/src/task/` — 类似结构。

### 3. 系统调用 (Syscalls)
- **RISC-V**: `os/src/syscall/` — 约 3936 行，分文件组织：
  - `mod.rs`: 调度入口 + 常量定义 (~564 行)
  - `fs.rs`: 文件系统相关 syscall (~956 行)
  - `process.rs`: 进程/线程相关 (~876 行)
  - `socket.rs`: socket 相关 (~754 行)
  - `sync.rs`: 同步相关 (~462 行)
  - `thread.rs`: 线程创建/等待 (~121 行)
  - `shm.rs`: 共享内存 (~172 行)
- **LoongArch**: `os-la/src/syscall/` — 类似组织，额外含 `signal.rs` 和 `option.rs`。

### 4. 文件系统 (File System)
- **RISC-V**: `os/src/fs/` — VFS 层（`mod.rs`, `inode.rs`）、管道（`pipe.rs`）、标准 IO（`stdio.rs`）、ext4 适配层（`ext4/`，通过 `lwext4_rust` 绑定 C 库）。
- **LoongArch**: `os-la/src/fs/` — 类似结构，额外含 `mount.rs`、`vfs_registry.rs`、`dirent.rs`、`stat.rs` 等。
- **ext4 底层**: `lwext4_rust/` — Rust 对 C 语言 `lwext4` 库的绑定封装。

### 5. 设备驱动 (Drivers)
- `os/src/drivers/` — VirtIO 块设备驱动（双设备支持）。
- `os-la/src/drivers/` — 类似，额外含 `tran_impl.rs` 和 `device.rs`。

### 6. 同步原语 (Synchronization)
- `os/src/sync/` — UPSafeCell、Mutex（自旋/阻塞两种）、Semaphore、Condvar、Futex。
- `os-la/src/sync/` — 类似结构（UPSafeCell + Futex）。

### 7. 异常与中断处理 (Trap)
- `os/src/trap/` — 统一的 trap 入口（汇编 + Rust handler），处理时钟中断、syscall、page fault 等。
- `os-la/src/trap/` — 额外含 `interrupts.rs`。

### 8. 信号机制 (Signal)
- RISC-V: 内嵌于 `os/src/task/signal.rs` 和 syscall 中。
- LoongArch: 独立为 `os-la/src/signal/`（`sigact.rs`, `sigflags.rs`, `sigtable.rs`）。

### 9. 其他
- **定时器**: `os/src/timer.rs` / `os-la/src/timer.rs`
- **SBI 接口**: `os/src/sbi.rs`
- **用户库**: `user/src/lib.rs` + `user/src/syscall.rs`

## 四、编译构建工具

从 `Makefile`、`CLAUDE.md` 和 `Cargo.toml` 分析：

| 用途 | 工具链 |
|------|--------|
| RISC-V 内核 (`os/`) | `riscv64gc-unknown-none-elf` target, nightly-2024-05-01 |
| LoongArch 内核 (`os-la/`) | `loongarch64-unknown-none` target, nightly-2025-02-01 |
| 用户态程序 (`user/`) | RISC-V: `riscv64gc-unknown-none-elf`; LA: `loongarch64-unknown-none` |
| ext4 C 库 | 需要 C 交叉编译器 + `bindgen` |
| 容器化构建 | Docker 镜像 `zhouzhouyi/os-contest:20260510` |
| QEMU 运行 | `qemu-system-riscv64` / `qemu-system-loongarch64` |
| 文件系统镜像 | `mkfs.ext4`, `gunzip`, `dd` |

构建流程：先编译 `user/initproc`（嵌入内核的 init 进程），再将其复制到 `os/initproc_embedded`，随后编译内核并将用户程序二进制嵌入，最终链接为 ELF 内核镜像 `kernel-rv` / `kernel-la`。

## 五、关键特征

1. **双架构支持**: RISC-V (os/) 和 LoongArch (os-la/)，通过 `polyhal` 抽象层共享上层逻辑。
2. **ext4 文件系统**: 通过 `lwext4_rust` 绑定 C 实现，支持标准 ext4 磁盘镜像读写。
3. **系统调用覆盖广**: 支持约 40+ 个 Linux 兼容 syscall，涵盖进程、文件、socket、同步、信号等。
4. **信号机制**: 支持信号处理函数注册、信号递送、信号屏蔽。
5. **futex 同步**: 支撑 pthread 互斥锁、条件变量。
6. **mmap/brk/mprotect**: 内存管理高级接口。
7. **管道 (pipe)**: 匿名管道实现。
8. **共享内存 (SHM)**: 进程间共享内存。
9. **COW (写时复制)**: fork 时内存共享优化。
10. **动态链接 ELF 加载**: 支持 musl/glibc 编译的动态链接程序。