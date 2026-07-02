# SudoOS-Plus 项目初步调查报告

## 1. 项目基本信息

- **项目名称**: SudoOS-Plus（内部 crate 名 `myos-kernel`）
- **开发语言**: Rust（edition 2024）
- **工具链**: nightly-2025-01-18
- **目标架构**: RISC-V 64 (`riscv64imac-unknown-none-elf`)、LoongArch64 (`loongarch64-unknown-none-softfloat`)
- **作者**: Mingyang Chen

## 2. 顶层文件组织结构

```
repo/
├── Cargo.toml              # 工作区清单，定义 9 个成员 crate
├── Cargo.lock
├── Makefile                # 竞赛提交包装（make all → oscomp-build.sh）
├── Makefile.project        # 原始开发 Makefile（构建/运行/QEMU 等）
├── rust-toolchain.toml     # 固定 Rust 工具链版本
├── .gitignore / .gitattributes
├── arch/                   # 架构相关代码
│   ├── riscv64/            #   RISC-V 64 架构（含 linker.ld、asm/）
│   └── loongarch64/        #   LoongArch64 架构（含 linker.ld、asm/）
├── boot/                   # 启动信息抽象 crate
├── firmware/
│   └── fdt/                # FDT (Flattened Device Tree) 解析 crate
├── kernel/                 # 内核主 crate（二进制包）
│   ├── Cargo.toml
│   ├── build.rs            # 构建脚本（选择链接脚本、检测 vendor busybox）
│   └── src/                # 内核所有子系统源码
├── mm/                     # 内存管理 crate（物理/虚拟内存分配器）
├── runtime/                # 运行时 crate（console 抽象）
├── sync/                   # 同步原语 crate（SpinLock）
├── vfs/                    # VFS 抽象层 crate
├── vendor/                 # 第三方依赖
│   ├── virtio-drivers/     #   VirtIO 驱动（blk/net/console/rng/rtc/gpu/input/socket/sound）
│   ├── vte/                #   虚拟终端模拟器
│   ├── fdt-reader/         #   FDT 读取器（已排除，未直接使用）
│   ├── lwext4/             #   轻量 ext4 库
│   ├── musl-cross-make/    #   musl 交叉编译工具
│   ├── rust-src/           #   Rust 标准库源码（用于 build-std）
│   └── userland/           #   用户态程序（busybox 等）
├── cargo-dot/              # .cargo 隐藏目录的备份（竞赛环境恢复用）
├── scripts/                # 构建/审计/CI 脚本（50+ 文件）
├── docs/                   # 开发文档（里程碑进度记录、设计说明等）
└── *.md / *.pdf / *.pptx   # 项目文档、设计方案、进展报告
```

## 3. Crate 子系统划分

项目基于 Rust workspace 组织为 **9 个成员 crate** + 外部依赖：

| Crate | 路径 | 职责 |
|---|---|---|
| `myos-kernel` | `kernel/` | 内核主二进制，集成所有子系统 |
| `arch-riscv64` | `arch/riscv64/` | RISC-V 64 架构支持（启动、页表、中断/陷入、上下文切换、SBI、SMP） |
| `arch-loongarch64` | `arch/loongarch64/` | LoongArch64 架构支持（启动、DMW 直接映射窗口、页表、中断/陷入、上下文切换、SMP） |
| `myos-mm` | `mm/` | 内存管理核心（buddy、slab、heap 分配器、页表抽象、VMA、地址空间、TLB） |
| `myos-vfs` | `vfs/` | 虚拟文件系统抽象层（File、DirEntry、Inode、挂载、路径解析） |
| `myos-sync` | `sync/` | 同步原语（SpinLock） |
| `myos-boot` | `boot/` | 启动信息数据结构 |
| `myos-fdt` | `firmware/fdt/` | FDT 设备树解析 |
| `myos-runtime` | `runtime/` | 运行时控制台抽象 |

外部依赖:
- `virtio-drivers`（本地 vendor 路径）: VirtIO 设备驱动
- `smoltcp` 0.11（crates.io）: TCP/IP 网络协议栈

## 4. 子系统识别（按功能域）

基于 `kernel/src/` 下模块及关联 crate 的粗略划分：

### 4.1 内存管理
- **mm crate**: `buddy/`（伙伴分配器）、`slab/`（slab 分配器）、`heap/`（堆分配器）、`paging/`（页表抽象）、`vma.rs`（虚拟内存区域）、`address_space.rs`（地址空间）、`user_space.rs`（用户空间管理）、`vmalloc.rs`（内核虚拟内存分配）、`tlb.rs`（TLB 刷新/广播）、`asid.rs`（ASID 分配）
- **kernel/src**: `memory.rs`（~34KB，内核内存管理集成）、`page_alloc.rs`（页面分配）、`heap.rs`（内核堆）、`vm.rs`（虚拟内存）、`user_mm.rs`（用户内存管理，~43KB）、`runtime_page_table.rs`（~39KB，运行时页表操作）、`tlb.rs`（~27KB，TLB shootdown）
- **arch**: `memory/`（架构特定内存布局与页表硬件操作）

### 4.2 进程与任务管理
- **kernel/src**: `process.rs`（~36KB）、`task/`（含 `mod.rs`、`wait_queue.rs`、`stack.rs`）、`exec.rs`（~27KB，程序执行）、`elf.rs`（~17KB，ELF 加载）、`context.rs`、`signal.rs`、`user.rs`（~303KB，系统调用实现集中地）
- **arch**: `task/context.rs`、`task/switch.S`（上下文切换汇编）

### 4.3 文件系统 (VFS + 具体实现)
- **vfs crate**: `lib.rs`（~930 行，VFS 抽象：File、DirEntry、Inode、Stat、OpenFlags、Errno 等）
- **kernel/src**: `fs/mod.rs`（VFS 实现）、`ext4.rs`（~24KB，ext4 只读）、`initramfs.rs`、`devpts.rs`、`procfs.rs`、`sysfs.rs`、`pipe.rs`、`block.rs`（~20KB，块设备层）

### 4.4 同步与锁机制
- **sync crate**: `spin_lock.rs`（自旋锁）
- **kernel/src**: `irq_lock.rs`（IRQ 安全自旋锁）、`lockdep.rs`（锁依赖检查）、`tracked_spin.rs`（可追踪自旋锁）

### 4.5 中断与陷入
- **kernel/src**: `trap.rs`、`irq.rs`、`ipi.rs`（核间中断）
- **arch**: `interrupt.rs`、`trap/`（含 `entry.S`、`frame.rs`）

### 4.6 多核 (SMP)
- **kernel/src**: `smp.rs`（~16KB）
- **arch**: `smp.rs`

### 4.7 时钟与定时器
- **kernel/src**: `timer.rs`（~19KB）、`time.rs`（~17KB）、`rtc.rs`
- **arch**: `time.rs`

### 4.8 设备与驱动
- **kernel/src**: `device.rs`、`virtio.rs`（~31KB，VirtIO 传输层）、`rng.rs`（~11KB）
- **vendor/virtio-drivers**: blk、net、console、rng、rtc、gpu、input、socket、sound

### 4.9 网络
- **kernel/src**: `net/mod.rs`、`net/socket.rs`、`net/virtio_net.rs`
- 集成 `smoltcp` 协议栈

### 4.10 TTY 与控制台
- **kernel/src**: `tty.rs`、`console.rs`
- **runtime**: `console.rs`
- **vendor/vte**: 终端 ANSI 转义序列解析

### 4.11 工作队列
- **kernel/src**: `workqueue.rs`（~28KB）、`call_function.rs`（~14KB）

### 4.12 其他
- `panic.rs`: panic 处理
- `linker.rs`: 链接器符号导出
- `fault.rs`: 缺页故障处理入口

## 5. 构建工具需求

基于 `scripts/build.sh` 和 `Cargo.toml` 的分析：

| 工具 | 用途 |
|---|---|
| **Rust nightly-2025-01-18** | 编译器（需要 `#![feature]` 特性、edition 2024） |
| **cargo** | 构建系统 |
| **`-Z build-std=core,alloc`** | 为裸机目标编译 core/alloc（需要 `rust-src` 组件） |
| **GNU Make** | 顶层构建编排（`Makefile` + `Makefile.project`） |
| **bash** | 构建脚本（`scripts/build.sh`、vendor 管理） |
| **Python 3** | 审计/验证脚本（50+ 脚本） |
| **目标交叉编译支持**: `riscv64imac-unknown-none-elf`、`loongarch64-unknown-none-softfloat` | 通过 `-Z build-std` 实现，无需额外安装交叉工具链 |
| **QEMU** | 模拟运行（RISC-V / LoongArch） |
| **链接脚本** | `arch/riscv64/linker.ld`、`arch/loongarch64/linker.ld` |

## 6. 初步统计

- 非 vendor Rust 源文件: 149 个
- 汇编源文件: 9 个（共约 1443 行）
- 内核主 crate 源码总行数: 约 35,258 行（`kernel/src/*.rs`）
- 架构层代码: 约 4,821 行
- 内存管理 crate: 约 6,430 行
- VFS crate: 约 930 行
- 项目整体规模: 中等偏大，是面向 OS 内核竞赛（OSKernel2026）的完整实现

## 7. 总体特点

1. **清晰的模块化设计**: 通过 Rust workspace 将架构层、内存管理、VFS、同步等拆分为独立 crate，边界明确。
2. **多架构支持**: 同时支持 RISC-V 64 和 LoongArch64，架构特定代码隔离在 `arch/` 下。
3. **类 Linux 设计**: 系统调用接口（`user.rs` 约 303KB）、VFS 抽象、ext4、procfs/sysfs/devpts、信号、pipe 等明显受 Linux 影响。
4. **竞赛导向**: 大量审计脚本（`scripts/m*-audit.py`）、`Makefile` 中的竞赛目标（`oscomp-*`）、以及 `oscomp_group_matrix.md` 表明这是面向 OS 内核竞赛的项目。
5. **丰富的第三方集成**: VirtIO 驱动套件、smoltcp 网络栈、vte 终端模拟器。