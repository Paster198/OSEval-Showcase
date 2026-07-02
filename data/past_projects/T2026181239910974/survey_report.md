# Somber OS 项目初步分析报告

## 1. 项目结构

```
repo/
├── Makefile                          # 根级构建与运行入口
├── README.md                         # 项目说明文档
├── LICENSE                           # 开源许可证 (35126 bytes, 疑似 GPL 类)
├── Somber初赛PPT.pptx                # 初赛答辩幻灯片
├── somber初赛设计文档.pdf / .txt      # 初赛设计文档
├── bootloader/
│   └── opensbi-qemu                  # RISC-V OpenSBI 固件二进制
├── docs/
│   └── assets/                       # 文档图片资源 (hitsz-logo.jpg, score-rank.png)
├── os/                               # 【内核主体】
│   ├── Makefile                      # 内核构建、运行、调试入口
│   ├── Cargo.toml / Cargo.lock       # Rust 依赖配置
│   ├── build.rs                      # 构建时将用户程序嵌入 link_app.S
│   ├── build                         # 辅助 shell 脚本
│   ├── matrix.S                      # 矩阵测试汇编
│   ├── rust-toolchain                # Rust 工具链版本锁定
│   ├── cargo/                        # 多架构 cargo 配置 (riscv64 / loongarch64)
│   ├── src/                          # 内核源码 (~53000 行 Rust + ~700 行汇编)
│   └── vendor/                       # 离线依赖 (17个 crate)
└── user/                             # 【用户态运行时与程序】
    ├── Makefile / Cargo.toml         # 用户态构建配置
    ├── build.rs                      # 构建脚本
    ├── assets/                       # LTP 测试脚本资源
    ├── src/
    │   ├── lib.rs                    # 用户运行时入口 (_start, 堆初始化)
    │   ├── syscall.rs                # 系统调用 ecall 封装
    │   ├── console.rs / lang_items.rs
    │   ├── linker.ld / linker_loongarch64.ld
    │   ├── bin/                      # 用户程序入口
    │   │   ├── initproc.rs           # 初始进程
    │   │   ├── user_shell.rs         # 交互式 Shell
    │   │   ├── testsuits.rs          # 测试套件入口
    │   │   ├── contest_runner.rs     # 比赛测试运行器
    │   │   └── submit_script.rs      # 提交脚本
    │   └── archive/                  # 17个早期测试/示例程序
    └── vendor/                       # 离线依赖 (3个 crate)
```

## 2. 子系统划分

### 2.1 架构适配层 (`os/src/arch/`)
- **文件**: `mod.rs`, `riscv64.rs`, `loongarch64.rs`, `sigreturn_riscv64.S`, `sigreturn_loongarch64.S`
- **职责**: 架构相关抽象（Trap 寄存器操作、用户内存访问开关、信号返回跳板）

### 2.2 内存管理 (`os/src/mm/`)
- **文件**: `address.rs`, `page_table.rs`, `memory_set.rs`, `frame_allocator.rs`, `heap_allocator.rs`, `page.rs`
- **职责**: 虚拟地址空间管理（`MemorySet`）、页表映射（SV39/LA 页表）、物理页帧分配、内核堆分配（基于 `buddy_system_allocator`）、mmap/munmap/mprotect 支持
- **规模**: ~3700 行

### 2.3 进程与线程管理 (`os/src/task/`)
- **文件**: `task.rs`, `bootstrap.rs`, `context.rs`, `processor.rs`, `scheduler.rs`, `switch.rs`/`switch.S`/`switch_loongarch64.S`, `futex.rs`, `id.rs`, `kstack.rs`, `namespace.rs`, `resource.rs`, `timer.rs`, `wait.rs`, `wait_child_error.rs`, `aux.rs`
- **职责**: Task 数据结构、内核栈分配、任务上下文切换、处理器管理、futex 同步、PID/TID 分配、命名空间（Uts/Time/User）、资源限制与统计、等待队列、进程组/线程组管理
- **规模**: ~5700 行（含汇编）

### 2.4 调度器 (`os/src/sched/`)
- **文件**: `mod.rs` (Scheduler trait), `fifo.rs`, `prio.rs`
- **职责**: 调度策略抽象，实现了 FIFO 和优先级调度器（CFS 被注释/未完成）
- **规模**: ~300 行

### 2.5 系统调用 (`os/src/syscall/`)
- **文件**: `mod.rs` (分发入口), `fs.rs`, `task.rs`, `mm.rs`, `socket.rs`, `miscfd.rs`, `bpf.rs`, `util.rs`, `module.rs`
- **职责**: Linux 兼容系统调用层，实现 170+ 个系统调用
- **规模**: ~24000 行（最大子系统）

### 2.6 虚拟文件系统 (`os/src/fs/`)
- **文件**: `dentry.rs`, `inode.rs`, `file.rs`, `fdtable.rs`, `mount.rs`, `namei.rs`, `path.rs`, `pipe.rs`, `stdio.rs`, `page_cache.rs`, `kstat.rs`, `loopdev.rs`, `super_block.rs`, `procfs.rs`, `sysfs.rs`, `perf.rs`
- **职责**: VFS 框架（Dentry/Inode/Mount）、文件描述符表、路径解析、管道、procfs/sysfs 伪文件系统、页面缓存、回环设备
- **规模**: ~7000 行

### 2.7 ext4 文件系统 (`os/src/ext4/`)
- **文件**: `mod.rs`, `super_block.rs`, `inode.rs`, `block_group.rs`, `extent_tree.rs`, `dentry.rs`, `block_op.rs`
- **职责**: ext4 只读/读写支持，超级块解析、inode 读写、extent tree 遍历、块组描述符、目录项
- **规模**: ~3800 行

### 2.8 FAT32 文件系统 (`os/src/fat32/`)
- **文件**: `mod.rs`, `fs.rs`, `fat.rs`, `dentry.rs`, `inode.rs`, `file.rs`, `layout.rs`, `time.rs`
- **职责**: FAT32 实现，FAT 表操作、目录项解析、文件读写
- **规模**: ~2000 行

### 2.9 信号处理 (`os/src/signal/`)
- **文件**: `mod.rs`, `delivery.rs`, `sigaction.rs`, `sigframe.rs`, `sigset.rs`, `trampoline.rs`
- **职责**: POSIX 信号机制：信号发送/阻塞/递送、sigaction 注册、信号帧构建与恢复、sigtrampoline
- **规模**: ~1500 行

### 2.10 异常与中断 (`os/src/trap/`)
- **文件**: `mod.rs`, `context.rs`, `irq.rs`, `trap.S`, `trap_loongarch64.S`
- **职责**: Trap 分发（用户态/内核态异常）、中断处理、TrapContext 管理
- **规模**: ~1200 行（含汇编）

### 2.11 设备驱动 (`os/src/drivers/`)
- **文件**: `block/mod.rs`, `block/virtio_blk.rs`, `block/block_dev.rs`, `block/block_cache.rs`, `block/registry.rs`
- **职责**: VirtIO 块设备驱动，带块缓存层
- **规模**: ~600 行

### 2.12 网络 (`os/src/net/`)
- **文件**: `mod.rs`, `addr.rs`, `options.rs`
- **职责**: 网络地址抽象、套接字选项
- **规模**: 较小（网络协议栈似乎依赖外部 virtio-net 驱动 + 用户态协议栈）

### 2.13 同步原语 (`os/src/mutex/`)
- **文件**: `mod.rs`, `spin_mutex.rs`
- **职责**: 自旋锁（关中断版本 `SpinNoIrqLock`）

### 2.14 基础设施
- **`console.rs`**: 内核控制台输出（`println!` 宏）
- **`logging.rs`**: 日志系统初始化
- **`timer.rs`**: 时钟中断管理
- **`sbi.rs`**: RISC-V SBI 调用封装
- **`loader.rs`**: 从嵌入的 `link_app.S` 加载用户程序
- **`config.rs`**: 编译期常量（内存布局、页大小等）
- **`utils.rs`**: 通用辅助函数
- **`lang_items.rs`**: `no_std` 环境下的 panic handler 等
- **`index_list/`**: 自定义侵入式链表

### 2.15 板级配置 (`os/src/boards/`)
- **文件**: `mod.rs`, `qemu.rs`
- **职责**: QEMU virt 板级配置，指定 BlockDevice 实现

### 2.16 用户态运行时 (`user/`)
- **职责**: 提供 `no_std` 用户程序运行时：系统调用封装（~50 个）、堆分配器、`_start` 入口、LTP 脚本安装、busybox/glibc 路径探测

## 3. 编译构建工具需求

根据 Makefile 和 Cargo.toml 分析：

| 工具 | 用途 |
|------|------|
| **rustc / cargo** (nightly) | Rust 编译（需要 `#![no_std]` / `#![no_main]` 及多个 unstable feature） |
| **rust-src** | `no_std` 编译所需的 core/alloc 源码 |
| **rustup target** | `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 目标 |
| **cargo-binutils / llvm-tools** | 提供 `rust-objcopy`，用于剥离内核 ELF 生成二进制 |
| **QEMU** | QEMU virt 模拟（`qemu-system-riscv64` / `qemu-system-loongarch64`） |
| **OpenSBI** (嵌入) | RISC-V SBI 固件 (`bootloader/opensbi-qemu`) |
| **mkfs 工具** | 制作磁盘镜像（`img/sdcard-rv.img` / `img/sdcard-la.img`）——镜像文件需预先存在 |
| **GNU Make** | 构建编排 |

关键依赖 crate（离线 vendor 化）：
- `riscv` (RISC-V 寄存器/CSR 操作)
- `virtio-drivers` (VirtIO 块设备和网卡驱动，fork 自 `li041/virtio-drivers`)
- `buddy_system_allocator` (伙伴系统物理帧/堆分配)
- `lazy_static`, `bitflags`, `log`, `hashbrown`, `zerocopy`, `memoffset`, `xmas-elf` (ELF 解析)

## 4. 初步判断汇总

1. **项目名称**: Somber OS，哈尔滨工业大学（深圳）参赛项目。
2. **语言与架构**: 纯 Rust 编写，支持 RISC-V64 和 LoongArch64 双 ISA。
3. **设计风格**: 宏内核（monolithic kernel），内核态运行在 S 模式，用户态在 U 模式。
4. **系统调用兼容性**: 面向 Linux ABI 兼容，实现了 170+ 个系统调用，覆盖文件、进程、内存、网络、信号、futex、epoll、io_uring 等领域，目标是运行未修改的 Linux 用户态程序（busybox、LTP、lua、libcbench 等）。
5. **代码总量**: 内核约 53000 行 Rust + 700 行汇编；用户态运行时约 2000 行。
6. **最大子系统**: 系统调用层 (~24000 行，占总量 45%)，体现了该项目的 Linux 兼容导向。