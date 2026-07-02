# DDUOS (NighthawkOS) 操作系统内核 —— 深度技术分析报告

## 目录

1. [分析过程概述](#1-分析过程概述)
2. [测试结果](#2-测试结果)
3. [项目架构总览](#3-项目架构总览)
4. [子系统详细拆解](#4-子系统详细拆解)
   - [4.1 启动与初始化流程](#41-启动与初始化流程)
   - [4.2 架构抽象层](#42-架构抽象层)
   - [4.3 物理内存管理](#43-物理内存管理)
   - [4.4 虚拟内存管理](#44-虚拟内存管理)
   - [4.5 页表管理](#45-页表管理)
   - [4.6 任务管理](#46-任务管理)
   - [4.7 异步运行时与调度](#47-异步运行时与调度)
   - [4.8 陷阱与中断处理](#48-陷阱与中断处理)
   - [4.9 系统调用层](#49-系统调用层)
   - [4.10 VFS 虚拟文件系统](#410-vfs-虚拟文件系统)
   - [4.11 文件系统实现](#411-文件系统实现)
   - [4.12 特殊文件与高级 I/O](#412-特殊文件与高级-io)
   - [4.13 网络协议栈](#413-网络协议栈)
   - [4.14 设备驱动](#414-设备驱动)
   - [4.15 同步原语](#415-同步原语)
   - [4.16 信号系统](#416-信号系统)
   - [4.17 定时器管理](#417-定时器管理)
   - [4.18 用户态程序](#418-用户态程序)
   - [4.19 配置与构建系统](#419-配置与构建系统)
5. [各子系统交互关系](#5-各子系统交互关系)
6. [内核实现完整度评估](#6-内核实现完整度评估)
7. [设计创新性分析](#7-设计创新性分析)
8. [其他信息](#8-其他信息)
9. [总结](#9-总结)

---

## 1. 分析过程概述

本报告对 DDUOS（NighthawkOS）项目进行了全面深入的源代码级分析。分析覆盖：

- **源代码阅读**：逐文件阅读了全部约 6.3 万行 Rust 代码的核心模块，包括但不限于 kernel crate（~17,000 行）下的所有子系统，以及 22 个 lib crate 的完整实现。
- **架构分析**：深入分析 RISC-V 64（Sv39）与 LoongArch 64（DMW + 软件页表遍历）双架构支持的实现方式。
- **构建系统分析**：分析了 Cargo workspace 结构、Makefile、Docker 构建环境、链接脚本、build.rs 代码生成逻辑。
- **依赖关系分析**：梳理了外部依赖（smoltcp、lwext4_rust、fatfs、virtio-drivers 等）与内部 crate 之间的调用关系。
- **代码统计**：统计了每个子系统的代码行数分布，确认代码量分布与子系统复杂性之间的对应关系。

由于当前环境缺少完整的 Rust nightly 工具链（rustc/cargo 不可用）及预配置的磁盘镜像，未能进行实际的编译构建与 QEMU 运行测试。

---

## 2. 测试结果

**未进行实际构建与运行测试**。原因如下：

1. 当前环境中的 Rust 工具链描述为"可用：rustup，缺失：rustc, cargo, rust-src, llvm-tools, cargo-binutils"——这意味着虽然 rustup 已安装，但没有实际的 Rust 编译器，无法执行 `cargo build`。
2. 即使有编译器，项目构建还需要预制的 ext4 磁盘镜像（`sdcard-rv.img`/`sdcard-la.img`），当前环境未提供。
3. 项目使用 `cargo build --offline`（离线模式），依赖预 vendor 的依赖包，需要 `submit/vendor.tar.gz` 解压。

因此，本报告的所有分析基于**源代码静态分析**。

---

## 3. 项目架构总览

### 3.1 命名与定位

项目对外名称为 **NighthawkOS**（夜鹰操作系统），内部 crate 命名为 **DDUOS**。这是一个面向操作系统比赛的、以 Linux ABI 兼容为目标的现代化异步内核。

### 3.2 整体架构图

```
┌──────────────────────────────────────────────────────────────┐
│                      用户态程序 (user/)                        │
│  init_proc, shell, LTP 测试框架, 各类测试程序                  │
├──────────────────────────────────────────────────────────────┤
│                    系统调用接口 (kernel/src/syscall/)           │
│  FS | MM | Process | Net | Signal | IO | Poll | Time | ...    │
├──────────┬──────────┬──────────┬──────────┬──────────────────┤
│ 任务管理  │ 虚拟内存  │ VFS+文件系统│ 网络栈  │ 设备驱动          │
│  (task/) │  (vm/)   │(vfs/osfs │ (net/)  │ (driver/osdriver) │
│          │          │ ext4/fat)│         │                  │
├──────────┴──────────┴──────────┴──────────┴──────────────────┤
│              异步运行时 (executor + osfuture)                   │
├──────────────────────────────────────────────────────────────┤
│           同步原语 (mutex) + 定时器 (timer)                     │
├──────────────────────────────────────────────────────────────┤
│         架构抽象层 (arch/) —— RISC-V | LoongArch               │
├──────────────────────────────────────────────────────────────┤
│              物理内存管理 (mm/) + 配置 (config/)                │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 Crate 依赖关系

`kernel` crate 依赖所有 22 个 lib crate，各 lib crate 之间也存在横向依赖：

- `lib/arch`：架构抽象，被几乎所有模块依赖
- `lib/config`：全局配置常量，被所有模块依赖
- `lib/mm`：物理内存管理（帧分配器、堆分配器、页缓存），被 kernel/vm 及文件系统依赖
- `lib/vfs`：虚拟文件系统核心抽象，被 kernel/syscall、osfs、ext4、fat32 依赖
- `lib/osfs`：特殊文件系统实现，依赖 vfs，被 kernel 依赖
- `lib/net`：网络协议栈封装，依赖 smoltcp，被 kernel/net 和 syscall 依赖
- `lib/mutex`：同步原语，被几乎所有模块依赖
- `lib/executor`：异步任务执行器，被 kernel 启动流程依赖
- `lib/osfuture`：异步 Future 工具，被 kernel/task 依赖
- `lib/timer`：定时器管理，被 kernel/task 和 osfs 依赖
- `lib/signal`：信号类型定义，被 kernel/task 依赖
- `lib/driver`：设备驱动抽象，被 kernel/osdriver 和 net 依赖
- `lib/ext4`、`lib/fat32`：磁盘文件系统，被 osfs 依赖

---

## 4. 子系统详细拆解

### 4.1 启动与初始化流程

**入口点**：`kernel/src/entry/`

分架构实现。RISC-V 使用 `_start` 函数（`riscv64.rs`），LoongArch 同样使用 `_start` 函数（`loongarch64.rs`）。

**RISC-V 启动流程**（`kernel/src/entry/riscv64.rs`）：

```rust
// 启动阶段使用一个最小的启动页表 (BootPageTable)，包含两条 1GB 巨页映射：
// 0x0000_0000_8000_0000 -> 0x0000_0000_8000_0000 (物理地址等同映射)
// 0xffff_ffc0_8000_0000 -> 0x0000_0000_8000_0000 (虚拟地址到物理地址)
static mut BOOT_PAGE_TABLE: BootPageTable = {
    let mut arr: [u64; 512] = [0; 512];
    arr[2] = (0x80000 << 10) | 0xcf;    // 物理等同映射
    arr[258] = (0x80000 << 10) | 0xcf;  // 内核虚拟地址映射
    BootPageTable(arr)
};
```

启动汇编代码启用 Sv39 页表后将控制流转移到虚拟地址空间的 `rust_main`。

**LoongArch 启动流程**（`kernel/src/entry/loongarch64.rs`）：

LoongArch 不使用传统页表启动，而是配置**直接映射窗口 (DMW)**：

```asm
// DMW0: 映射 0x8000_0000_0000_0000 区域，PLV0=1, VSEC=8
li.w  $t0, 0x1
lu52i.d $t0, $t0, -2048   // VSEC=8
csrwr $t0, 0x180          // CSR.DMW0

// DMW1: 映射 0x9000_0000_0000_0000 区域，MAT=1, PLV0=1
li.w  $t0, 0x11
lu52i.d $t0, $t0, -1792   // VSEC=9
csrwr $t0, 0x181          // CSR.DMW1
```

然后启用映射地址翻译模式 (CRMD.PG=1) 并跳转到 `rust_main`。

**rust_main 初始化序列**（`kernel/src/main.rs`）：

1. `clear_bss()` — 清零 BSS 段
2. `logger::init()` — 初始化日志系统
3. `heap::init_heap_allocator()` — 初始化内核堆分配器（buddy system，512MB 堆空间）
4. `frame::init_frame_allocator()` — 初始化物理帧分配器（bitmap 分配器）
5. `vm::switch_to_kernel_page_table()` — 切换到正式内核页表
6. `osdriver::probe_device_tree()` — 解析设备树，探测并初始化外设
7. `osfs::init()` — 初始化所有文件系统（ext4、devfs、procfs、tmpfs、sysfs、etcfs）
8. `loader::init()` — 初始化内嵌用户程序
9. `executor::init(hart_id)` — 初始化异步运行时
10. `task::init()` — 创建初始进程（submit_init_by_insert）
11. 进入主循环：`executor::task_run_always_alone(hart_id)`

**初始化顺序体现了明确的依赖关系**：内存分配器（堆/帧）必须最先初始化，随后是页表，然后才能进行设备探测，文件系统挂载依赖块设备驱动，最后才能创建用户进程。

---

### 4.2 架构抽象层 (`lib/arch/`)

**代码量**：903 行 Rust，分布在 6 个子模块中。

架构抽象层使用条件编译（`#[cfg(target_arch = ...)]`）为 RISC-V 和 LoongArch 提供统一接口。使用自定义过程宏 `define_arch_mods!`（来自 `polyhal-macro`）自动生成模块导入。

**子模块及其职责**：

| 子模块 | RISC-V 实现 | LoongArch 实现 |
|--------|-------------|-----------------|
| `console` | SBI 控制台输出 | UART 端口直写 |
| `hart` | SBI HSM扩展 | CSR 操作关机 |
| `interrupt` | sie 寄存器操作 | ecfg CSR 操作 |
| `mm` | sfence.vma / satp 操作 | tlb_fill / invtlb |
| `pte` | Sv39 PTE 标志位 (V/R/W/X/U/G/A/D) | LoongArch PTE 标志位 |
| `time` | SBI timer 扩展 | 定时器 CSR 操作 |
| `trap` | stvec 设置 / 中断使能 | eentry CSR 设置 |

**mm 子模块关键差异**：

- RISC-V：使用 `sfence.vma` 进行 TLB 刷新，通过 `satp` CSR 切换页表，通过 SBI `remote_sfence_vma_asid` 实现跨核 TLB shootdown。
- LoongArch：使用 `invtlb` 指令刷新 TLB，通过 `pgdl` CSR 切换页表，页表遍历使用硬件辅助（`lddir`/`ldpte` 指令）。TLB 填充使用自定义的 `tlb_fill` 函数，该函数接受两个 PTE 并对写入 TLB。

**pte 子模块**：

RISC-V 端定义 Sv39 页表项标志位：

```rust
bitflags! {
    pub struct PteFlags: u64 {
        const V = 1 << 0;  // Valid
        const R = 1 << 1;
        const W = 1 << 2;
        const X = 1 << 3;
        const U = 1 << 4;  // User
        const G = 1 << 5;  // Global
        const A = 1 << 6;  // Accessed
        const D = 1 << 7;  // Dirty
    }
}
```

提供 `MappingFlags` 与 `PteFlags` 双向转换，以及 `is_valid()`, `is_readable()`, `is_writable()`, `is_user()` 等查询方法。

---

### 4.3 物理内存管理 (`lib/mm/`)

**代码量**：905 行。

#### 4.3.1 帧分配器 (`frame.rs`)

使用 **bitmap 分配器**（`bitmap_allocator::BitAlloc1M`）管理物理页帧。

```rust
static FRAME_ALLOCATOR: FrameAllocator = FrameAllocator {
    allocator: SpinNoIrqLock::new(BitAlloc1M::DEFAULT),
    offset: SyncUnsafeCell::new(0),
};
```

初始化时从内核结束地址（`kernel_end_phys()`）到物理内存末端（`RAM_END = 0x100000000`）之间的所有页帧被标记为可用。

使用 **RAII 模式**管理帧生命周期：`FrameTracker` 在构造时分配一帧，在 Drop 时自动释放回分配器。提供 `build_batch()` 批量分配和 `FrameDropper` 批量释放。

#### 4.3.2 内核堆分配器 (`heap.rs`)

使用 **buddy system 分配器**（`buddy_system_allocator::Heap<32>`），32 阶，管理 512MB 内核堆空间：

```rust
#[global_allocator]
static HEAP_ALLOCATOR: NoIrqLockedHeap<32> = NoIrqLockedHeap::new();
```

初始化：

```rust
pub unsafe fn init_heap_allocator() {
    let start_addr = VirtAddr::new(HEAP_MEMORY.0.as_ptr() as usize).to_usize();
    HEAP_ALLOCATOR.init(start_addr, KERNEL_HEAP_SIZE); // 512MB
}
```

堆内存本身通过 4KB 对齐的静态数组 `HeapMemory([u8; KERNEL_HEAP_SIZE])` 预分配在 BSS 段中。

`NoIrqLockedHeap` 包装了 `SpinNoIrqLock<buddy::Heap<32>>`，确保分配/释放操作在关中断的自旋锁保护下进行，实现 `GlobalAlloc` trait。

#### 4.3.3 页缓存 (`page_cache/`)

`PageCache` 用于文件系统页面缓存（位于 `lib/mm/src/page_cache/`），缓存文件数据页以减少磁盘 I/O。

#### 4.3.4 地址类型 (`address.rs`)

定义 `PhysAddr`、`VirtAddr`、`PhysPageNum`、`VirtPageNum` 等地址抽象类型，提供页面对齐、页面号转换、偏移量计算等工具方法。

---

### 4.4 虚拟内存管理 (`kernel/src/vm/`)

**代码量**：3,555 行。

#### 4.4.1 地址空间 (`addr_space.rs`)

`AddrSpace` 是每个进程独立的虚拟地址空间抽象：

```rust
pub struct AddrSpace {
    pub page_table: PageTable,
    pub vm_areas: SpinLock<BTreeMap<VirtAddr, VmArea>>,
}
```

核心操作：

- **`build_user()`**：创建用户地址空间，对于 RISC-V 自动映射内核部分到页表。
- **`add_area()`**：添加 VMA，检查与现有 VMA 的重叠并拒绝（返回 `EINVAL`）。
- **`find_vacant_memory()`**：在指定范围内查找空闲虚拟地址区域，用于 mmap 的地址分配。算法遍历 VMA 树，寻找满足长度要求的空隙。
- **`remove_mapping()`**：移除指定地址范围的映射，可能触发 VMA 的分裂或收缩，并失效对应的页表项。
- **`handle_page_fault()`**：处理缺页异常，根据 VMA 信息和访问权限决定是否映射新页（按需分配）或报告 SIGSEGV。
- **`map_file()`**：实现 mmap 文件映射的核心逻辑，支持 MAP_ANONYMOUS、MAP_SHARED、MAP_PRIVATE、MAP_FIXED 等标志。
- **`change_heap_size()`**：实现 brk 系统调用，调整进程堆的大小。
- **`change_prot()`**：实现 mprotect，修改指定地址范围的访问权限。
- **`init_stack()`**：初始化用户栈，将 argc、argv、envp、auxv 向量和随机数推入栈顶。

地址空间切换：

```rust
pub unsafe fn switch_to(addr_space: &AddrSpace) {
    arch::mm::switch_page_table(addr_space.page_table.root().to_usize());
}
```

通过架构级函数实际修改 satp/pgdl 寄存器。

#### 4.4.2 VMA 区域管理 (`vm_area.rs`)

`VmArea` 表示一段连续的虚拟内存区域：

```rust
pub struct VmArea {
    start_va: VirtAddr,
    end_va: VirtAddr,
    flags: VmaFlags,
    area: TypedArea,
}
```

`TypedArea` 枚举区分不同类型的 VMA：

- `Offset`：文件映射（指定文件 + 偏移量）
- `Anonymous`：匿名映射（用于堆、栈、MAP_ANONYMOUS）
- `SharedMemory`：System V 共享内存
- `Io`：IO 映射

`VmaFlags` 包含页表标志和 mmap 标志（SHARED/PRIVATE/FIXED 等）。

VMA 分裂操作 `split()` 用于在部分取消映射时将一个大 VMA 分割为两个。使用 `BTreeMap` 按起始地址排序管理 VMA，支持高效的区间查询。

#### 4.4.3 ELF 加载器 (`elf.rs`)

实现静态和动态 ELF 文件加载：

- 解析 ELF header 和 program headers
- 映射 LOAD 段到地址空间
- 处理 PT_INTERP（动态链接器）
- 处理 PT_GNU_STACK、PT_GNU_RELRO 等 GNU 扩展段
- 构建 auxv（辅助向量），包括 AT_PHDR、AT_PHENT、AT_PHNUM、AT_PAGESZ、AT_BASE、AT_ENTRY、AT_RANDOM 等

支持通过文件接口加载（`load_elf(elf_file)`），与 VFS 层无缝集成。

#### 4.4.4 共享内存 (`shm.rs` + `lib/shm/`)

实现 System V 共享内存机制：

- `sys_shmget()`：通过 key 获取或创建共享内存段
- `sys_shmat()`：将共享内存段附加到进程地址空间
- `sys_shmdt()`：分离共享内存段
- `sys_shmctl()`：共享内存控制操作

`SHARED_MEMORY_MANAGER` 全局管理器（`lib/shm/src/manager.rs`）以 BTreeMap 维护所有共享内存段。

#### 4.4.5 用户指针安全访问 (`user_ptr.rs`)

`UserReadPtr<T>`、`UserWritePtr<T>`、`UserReadWritePtr<T>` 提供对用户空间指针的安全读写：

- 使用 `SumGuard` 引用计数机制控制 RISC-V 的 SUM 位（允许内核访问用户空间）
- 每次读写前验证指针在用户地址空间范围内
- 对于可能触发页错误的访问，提供专门的异常处理路径（`__try_read_user` / `__try_write_user` 汇编辅助函数）

```asm
// RISC-V 安全用户内存访问
__try_read_user:
    mv a1, a0
    mv a0, zero
    lb a1, 0(a1)     // 如果触发异常，跳转到 __user_rw_exception_entry
    ret

__user_rw_exception_entry:
    csrr a0, sepc
    addi a0, a0, 4   // 跳过故障指令
    csrw sepc, a0
    li   a0, 1        // 返回错误标志
    sret
```

---

### 4.5 页表管理 (`kernel/src/vm/page_table.rs`)

**代码量**：586 行。

`PageTable` 是对硬件页表数据结构的抽象：

```rust
pub struct PageTable {
    root: PhysPageNum,
    frames: SpinLock<Vec<FrameTracker>>,
}
```

**核心操作**：

- **`build()`**：创建空页表，分配根页表帧
- **`build_kernel_page_table()`**（仅 RISC-V）：构建内核页表，线性映射内核代码、数据、BSS 段以及 MMIO 区域
- **`map_kernel()`**：将内核页表内容复制到新页表中（RISC-V），利用内核映射的全局标志 (G) 简化
- **`map()`**：映射虚拟页到物理帧，支持创建中间级页表
- **`unmap()`**：取消映射虚拟页
- **`find_entry()`**：遍历页表查找 PTE
- **`protect()`**：修改页表项权限

**RISC-V 内核页表构建细节**：

在内核页表构建函数中，内核的各个段（`.text`、`.rodata`、`.data`、`.bss`、trampoline）被映射，同时预定义的 MMIO 范围也被映射。使用 `PteFlags::G`（全局标志）标记所有内核映射，使得在切换用户页表时这些映射不会因 TLB 刷新而失效。

**LoongArch 页表差异**：

LoongArch 不使用 Sv39 风格的硬件页表遍历，而是：
- 内核空间通过 DMW 寄存器直接映射
- 用户空间使用 3 级软件管理页表（通过 `pwcl`/`pwch` CSR 配置页表结构）
- TLB 缺失时触发异常，由 `tlb_refill` 处理程序软件遍历页表并填充 TLB

---

### 4.6 任务管理 (`kernel/src/task/`)

**代码量**：4,358 行。这是内核最核心的子系统之一。

#### 4.6.1 任务控制块 (`task.rs`)

`Task` 结构体是进程/线程的统一抽象，包含约 40 个字段：

```rust
pub struct Task {
    tid: TidHandle,                    // 线程ID
    process: Option<Weak<Task>>,       // 所属进程（线程时使用）
    is_process: bool,                  // 是否为进程（线程组领袖）
    threadgroup: ShareMutex<ThreadGroup>,
    trap_context: SyncUnsafeCell<TrapContext>,
    timer: SyncUnsafeCell<TaskTimeStat>,
    waker: SyncUnsafeCell<Option<Waker>>,
    state: SpinNoIrqLock<TaskState>,
    addr_space: SyncUnsafeCell<Arc<AddrSpace>>,
    shm_maps: ShareMutex<BTreeMap<VirtAddr, usize>>,
    parent: ShareMutex<Option<Weak<Task>>>,
    children: ShareMutex<BTreeMap<Tid, Arc<Task>>>,
    exit_code: SpinNoIrqLock<i32>,
    sig_mask: SyncUnsafeCell<SigSet>,
    sig_handlers: ShareMutex<SigHandlers>,
    sig_manager: SyncUnsafeCell<SigManager>,
    sig_stack: SyncUnsafeCell<SignalStack>,
    fd_table: ShareMutex<FdTable>,
    cwd: ShareMutex<Arc<dyn Dentry>>,
    root: ShareMutex<Arc<dyn Dentry>>,
    elf: SyncUnsafeCell<Arc<dyn File>>,
    caps: SyncUnsafeCell<Capabilities>,
    cpus_on: SyncUnsafeCell<CpuMask>,
    perm: ShareMutex<TaskPerm>,
    name: SyncUnsafeCell<String>,
    // ... 更多字段
}
```

**任务状态机**：

```rust
pub enum TaskState {
    Running,
    Zombie,
    WaitForRecycle,
    Sleeping,
    Interruptible,
    UnInterruptible,
}
```

- **Running** → 任务正在运行或在就绪队列中
- **Zombie** → 任务已退出，等待父进程回收
- **WaitForRecycle** → 子进程等待父进程 wait4 回收
- **Sleeping** → 任务睡眠中（通过 `suspend_now`）
- **Interruptible** → 可中断等待（如等待 I/O），可被信号唤醒
- **UnInterruptible** → 不可中断等待

状态转换由以下关键路径驱动：
- `sys_exit()` → Zombie
- `sys_exit_group()` → 线程组所有成员变为 Zombie
- `task_executor_unit` 检测到 Zombie → 退出主循环，设置 WaitForRecycle，通知父进程
- 信号到达且任务处于 Interruptible → 唤醒

#### 4.6.2 任务管理器 (`manager.rs`)

全局任务管理器 `TASK_MANAGER`：

```rust
pub static TASK_MANAGER: TaskManager = TaskManager::new();

pub struct TaskManager(SpinNoIrqLock<BTreeMap<Tid, Weak<Task>>>);
```

使用 `BTreeMap<Tid, Weak<Task>>` 存储所有任务。使用 Weak 指针避免循环引用，不控制任务生命周期。

#### 4.6.3 进程组管理器 (`process_manager.rs`)

`PROCESS_GROUP_MANAGER` 管理进程组：

```rust
pub static PROCESS_GROUP_MANAGER: ProcessGroupManager = ProcessGroupManager::new();

pub struct ProcessGroupManager(SpinNoIrqLock<BTreeMap<PGid, Vec<Weak<Task>>>>);
```

以 PGid（即 leader 进程的 Tid）为键，维护进程组内所有进程的弱引用列表。

#### 4.6.4 线程组 (`threadgroup.rs`)

每个 Task 拥有自己的 `ThreadGroup`：

```rust
pub struct ThreadGroup(BTreeMap<Tid, Weak<Task>>);
```

与 `TASK_MANAGER` 不同，`ThreadGroup` 是任务私有成员，用于管理同一进程内的所有线程。

#### 4.6.5 fork 实现 (`taskf.rs`)

`Task::fork()` 实现了类似 Linux fork/clone 的语义：

```rust
pub fn fork(self: &Arc<Self>, cloneflags: CloneFlags) -> Arc<Self> {
    // 1. 分配新 TID
    // 2. 复制陷阱上下文
    // 3. 复制地址空间（COW语义）
    // 4. 复制文件描述符表
    // 5. 根据 cloneflags 决定共享/复制各类资源
    // 6. 设置父子关系
    // 7. 注册到任务管理器和进程组管理器
}
```

支持的 CloneFlags：`CLONE_VM`、`CLONE_FS`、`CLONE_FILES`、`CLONE_SIGHAND`、`CLONE_THREAD`、`CLONE_VFORK`、`CLONE_PARENT`、`CLONE_CHILD_CLEARTID`、`CLONE_CHILD_SETTID`、`CLONE_PARENT_SETTID`、`CLONE_SETTLS` 等。

#### 4.6.6 execve 实现 (`taskf.rs`)

```rust
pub fn execve(&self, elf_file: Arc<dyn File>, args: Vec<String>,
              envs: Vec<String>, name: String) -> SysResult<()> {
    // 1. 创建新的用户地址空间 (build_user)
    // 2. 加载 ELF (load_elf)
    // 3. 映射新栈 (map_stack)
    // 4. 映射新堆 (map_heap)
    // 5. 切换地址空间
    // 6. 初始化用户栈（argc, argv, envp, auxv, random）
    // 7. 重置陷阱上下文
    // 8. 关闭 CLOEXEC 文件描述符
    // 9. 重置用户自定义信号处理函数
}
```

注意 execve 后保留的属性包括进程 ID、父进程、文件描述符（除 CLOEXEC 外）、进程组等。

#### 4.6.7 文件描述符表 (`lib/osfs/src/fd_table.rs`)

`FdTable` 管理进程的打开文件：

```rust
pub struct FdTable {
    table: Vec<Option<FdInfo>>,
    rlimit: RLimit,
    tid: Tid,
}
```

- 预分配 stdin(0)、stdout(1)、stderr(2) 为 TTY 设备
- 支持 `alloc()`（分配最小可用 FD）、`close()`、`dup()`、`dup3()`、`get_file()`
- 线程安全通过 `ShareMutex` 保护

#### 4.6.8 Futex (`futex.rs`)

实现了 Linux futex 的核心机制：

```rust
pub struct FutexManager {
    hash: HashMap<FutexHashKey, Vec<FutexWaiter>>,
    val32: u32,
    is_mask: bool,
}
```

支持 `FUTEX_WAIT`、`FUTEX_WAKE`、`FUTEX_REQUEUE`、`FUTEX_WAIT_BITSET`、`FUTEX_WAKE_BITSET`、`FUTEX_CMP_REQUEUE` 等操作。使用两个 FutexManager 实例（一个用于普通 futex，一个用于 bitset futex）。

#### 4.6.9 等待队列 (`wait_queue.rs`)

`WAIT_QUEUE_MANAGER` 提供通用的等待-唤醒机制，用于 wait4、信号等待等场景。

---

### 4.7 异步运行时与调度 (`lib/executor/` + `lib/osfuture/`)

**代码量**：332 + 204 行。

#### 4.7.1 任务执行器 (`lib/executor/src/lib.rs`)

基于 `async_task` crate 构建的自定义异步运行时：

```rust
pub static mut HART_TASKS_LINES: [TaskLine; MAX_HARTS] = ...

pub struct TaskLine {
    tasks: SpinNoIrqLock<VecDeque<Runnable>>,
    pritasks: SpinNoIrqLock<VecDeque<Runnable>>,
}
```

- 每个 HART 拥有独立的 `TaskLine`
- 两级优先级：`pritasks`（高优先级）优先于 `tasks`（普通）
- `push_in_available_line()` 找到任务数最少的 HART 队列来分发新任务（工作窃取的前置均衡策略）
- `fetch_one(hart_id)` 实现完整的工作窃取：先从本 HART 取，再从其他 HART 偷取

**主调度循环**：

```rust
pub fn task_run_always_alone(hart_id: usize) {
    while let Some(task) = fetch_one(hart_id) {
        task.run();
    }
}
```

#### 4.7.2 OS Future (`lib/osfuture/src/lib.rs`)

提供内核级异步工具：

- **`suspend_now()`**：挂起当前任务，第一次 poll 返回 Pending，第二次返回 Ready
- **`yield_now()`**：让出 CPU，但在挂起前先调用 waker 将任务放回队列末尾
- **`block_on()`**：同步阻塞运行 future 到完成（忙等轮询，用于内核初始化阶段）
- **`take_waker()`**：获取当前上下文的 waker
- **`Select2Futures`**：同时 poll 两个 future，返回先完成的那个

#### 4.7.3 用户任务与内核任务 Future (`kernel/src/task/future.rs`)

**`UserFuture`**：用户级调度单元

```rust
pub struct UserFuture<F: Future + Send + 'static> {
    task: Arc<Task>,
    pps: ProcessorPrivilegeState,
    future: F,
}
```

poll 流程：
1. `hart.user_switch_in()` — 切换到任务的地址空间和处理器状态
2. 运行内部 future（即 `task_executor_unit`）
3. `hart.user_switch_out()` — 切换回内核

**`KernelFuture`**：内核级调度单元（不需要用户地址空间）

**`task_executor_unit`**（634 行）：用户任务的主循环

```rust
pub async fn task_executor_unit(task: Arc<Task>) {
    task.set_waker(take_waker().await);
    task.init_before_running();
    set_nx_timer_irq();
    loop {
        trap::trap_return(&task);        // 返回到用户空间
        match task.get_state() {
            TaskState::Zombie => break,
            TaskState::Sleeping => {
                task.set_state(TaskState::Interruptible);
                suspend_now().await;
            }
            _ => {}
        }
        trap::trap_handler(&task);       // 处理陷阱
        let mut interrupted = async_syscall(&task).await;
        TIMER_MANAGER.check(get_time_duration());
        if task.timer_mut().schedule_time_out() {
            yield_now().await;
        }
        sig_check(task.clone(), &mut interrupted).await;
        if task.get_state() == TaskState::Zombie { break; }
        task.timer_mut().schedule_reset();
    }
    // 退出处理：通知父进程、回收资源
}
```

#### 4.7.4 处理器抽象 (`lib/pps/` + `kernel/src/processor/hart.rs`)

`ProcessorPrivilegeState` 记录任务的处理器特权状态（sstatus、sepc、satp），用于任务切换时的上下文保存与恢复。使用 RISC-V 的 SUM 位引用计数机制安全访问用户空间。

`Hart` 结构体表示一个硬件线程，管理当前运行的任务和 PPS。

---

### 4.8 陷阱与中断处理 (`kernel/src/trap/`)

**代码量**：949 行 Rust + 418 行汇编。

#### 4.8.1 RISC-V 陷阱入口 (`rv_trap.s`)

`__trap_from_user`：从用户态进入的陷阱处理入口

```asm
__trap_from_user:
    csrrw sp, sscratch, sp    // 交换用户栈指针和内核栈指针
    // 保存 31 个通用寄存器到 TrapContext
    sd x1, 1*8(sp)
    // ... 保存 x3-x31
    // 保存 sstatus, sepc
    csrr t0, sstatus
    csrr t1, sepc
    sd t0, 32*8(sp)
    sd t1, 33*8(sp)
    // 保存用户 sp
    csrr t2, sscratch
    sd t2, 2*8(sp)
    // 加载内核 callee-saved regs 和 sp/ra/fp/tp
    // ...
    ld sp, 34*8(sp)
    ret                     // 跳转到内核返回地址
```

`__return_to_user`：从内核态返回用户态

`__trap_from_kernel`：内核态内陷阱（保存 caller-saved regs 即可）

`scret` 指令完成实际的权限级切换和返回。

#### 4.8.2 RISC-V 陷阱分发 (`trap_handler/`)

```rust
pub fn trap_handler(task: &Task) {
    let cause = register::scause::read().cause();
    match cause {
        Trap::Exception(e) => user_exception_handler(task, e, stval, sepc),
        Trap::Interrupt(i) => user_interrupt_handler(task, i),
    }
}
```

**异常处理**：
- `UserEnvCall` → 标记为系统调用（`task.set_is_syscall(true)`）
- `StorePageFault` / `LoadPageFault` / `InstructionPageFault` → 调用 `addr_space.handle_page_fault()` 尝试按需分配页，失败则发送 SIGSEGV
- `IllegalInstruction` → 发送 SIGILL

**中断处理**：
- `SupervisorTimer` → 设置下次定时器中断，更新时间管理器
- `SupervisorExternal` → 调用 `device_manager().handle_irq()` 处理外部中断

#### 4.8.3 LoongArch 陷阱处理

LoongArch 的陷阱处理有显著差异：

- 陷阱入口通过 `eentry` CSR 配置
- 异常原因为体系结构特有的分类（`FetchPageFault`、`PageNonExecutableFault`、`LoadPageFault`、`PageNonReadableFault`、`StorePageFault`、`PageModifyFault`、`InstructionNotExist` 等）
- TLB 缺失有专门的 `tlb_refill` 处理程序，使用 `lddir`/`ldpte` 指令软件遍历页表并填充 TLB
- TLB 刷新使用 `invtlb` 指令
- 中断通过 HWI0-HWI7 硬件中断线处理

#### 4.8.4 系统调用分发 (`trap_syscall.rs`)

```rust
pub async fn async_syscall(task: &Task) -> bool {
    if !task.is_syscall() { return false; }
    task.set_is_syscall(false);
    let mut cx = task.trap_context_mut();
    let syscall_no = cx.syscall_no();
    cx.sepc_forward();  // 跳过 ecall 指令
    let sys_ret = syscall(syscall_no, cx.syscall_args()).await;
    cx.set_user_ret_val(sys_ret);
    // 如果返回 EINTR 且不是不可重启的系统调用，标记为中断
    ...
}
```

系统调用号从 `a7`（RISC-V：x17，LoongArch：r11）寄存器获取，参数从 `a0-a5` 获取，返回值写入 `a0`。

#### 4.8.5 陷阱统计 (`trap_handler/mod.rs`)

`TRAP_STATS` 全局统计各种中断/异常的发生次数，通过 `/proc/interrupts` 暴露。

---

### 4.9 系统调用层 (`kernel/src/syscall/`)

**代码量**：12,127 行（内核最大的单一模块）。

#### 4.9.1 系统调用号定义 (`consts.rs`)

约 160+ 个系统调用号定义，来自 Linux `asm-generic/unistd.h`：

```rust
pub enum SyscallNo {
    IO_SETUP = 0,     IO_DESTROY = 1,    ...
    OPENAT = 56,      CLOSE = 57,         ...
    READ = 63,        WRITE = 64,         ...
    EXIT = 93,        EXIT_GROUP = 94,    ...
    FUTEX = 98,                            ...
    CLONE = 220,      EXECVE = 221,       ...
    MMAP = 222,                            ...
    SOCKET = 198,     BIND = 200,         ...
    BPF = 280,        IO_URING_SETUP = 425, ...
}
```

每个枚举值有 `as_str()` 方法返回名称字符串用于日志。

#### 4.9.2 系统调用分发 (`mod.rs`)

`syscall()` 函数将所有系统调用分发到对应的处理函数：

```rust
pub async fn syscall(syscall_no: usize, args: [usize; 6]) -> usize {
    let result = match syscall_no {
        GETTIMEOFDAY => sys_gettimeofday(args[0], args[1]).await,
        EXIT => sys_exit(args[0] as i32),
        // ... 约 110+ 个匹配分支
        _ => panic!("Syscall number not included: {syscall_no}"),
    };
    ...
}
```

统计实现约 **110+** 个系统调用处理函数。

#### 4.9.3 文件系统系统调用 (`fs.rs` — 3,514 行)

最大的单个源文件，实现：

| 系统调用 | 功能 | 状态 |
|---------|------|------|
| `sys_openat` | 打开文件/创建文件 | 完整实现，含 O_CREAT/O_TMPFILE/O_DIRECTORY/O_NOFOLLOW 等 |
| `sys_close` | 关闭文件 | 完整实现 |
| `sys_read` / `sys_write` | 读写文件 | 完整实现，基于异步 I/O |
| `sys_lseek` | 文件定位 | 完整实现 (SEEK_SET/CUR/END) |
| `sys_getdents64` | 读取目录项 | 实现中 |
| `sys_mkdirat` / `sys_unlinkat` | 目录操作 | 完整实现 |
| `sys_linkat` / `sys_symlinkat` | 链接操作 | 完整实现 |
| `sys_renameat2` | 重命名 | 完整实现，含 RENAME_NOREPLACE/RENAME_EXCHANGE |
| `sys_fstat` / `sys_fstatat` | 文件状态 | 完整实现 |
| `sys_mount` / `sys_umount2` | 挂载/卸载 | 完整实现 |
| `sys_pipe2` | 创建管道 | 完整实现 |
| `sys_fcntl` | 文件控制 | 完整实现 (F_DUPFD/F_GETFD/F_SETFD/F_GETFL/F_SETFL/F_GETOWN) |
| `sys_ioctl` | 设备控制 | 部分实现（TTY/loop/RTC） |
| `sys_sendfile` | 零拷贝发送 | 基本实现 |
| `sys_readv` / `sys_writev` | 向量 I/O | 完整实现 |
| `sys_sync` / `sys_fsync` | 同步 | 框架实现 |
| `sys_statfs` | 文件系统统计 | 框架实现 |
| `sys_readlinkat` | 读取符号链接 | 完整实现 |
| `sys_truncate64` / `sys_ftruncate64` | 截断文件 | 实现中 |
| `sys_utimensat` | 设置时间戳 | 基本实现 |
| `sys_faccessat` | 访问检查 | 完整实现 |

#### 4.9.4 进程管理系统调用 (`process.rs` — 2,056 行)

| 系统调用 | 功能 | 状态 |
|---------|------|------|
| `sys_clone` | 创建子进程/线程 | 完整实现，支持多种 CloneFlags |
| `sys_execve` | 执行程序 | 完整实现 |
| `sys_exit` / `sys_exit_group` | 退出 | 完整实现 |
| `sys_wait4` | 等待子进程 | 完整实现 (WNOHANG/WUNTRACED/WCONTINUED) |
| `sys_getpid` / `sys_gettid` / `sys_getppid` | 获取ID | 完整实现 |
| `sys_getuid` / `sys_geteuid` / `sys_getgid` / `sys_getegid` | 用户/组ID | 完整实现 |
| `sys_setuid` / `sys_setgid` / `sys_setreuid` | 设置ID | 基本实现 |
| `sys_getpgid` / `sys_setpgid` | 进程组 | 完整实现 |
| `sys_setsid` | 创建会话 | 框架实现 |
| `sys_prctl` | 进程控制 | 部分实现 |
| `sys_getrusage` | 资源使用统计 | 框架实现 |
| `sys_prlimit64` | 资源限制 | 基本实现 |
| `sys_capget` / `sys_capset` | 能力获取/设置 | 实现中 |
| `sys_sched_yield` | 让出CPU | 完整实现（yield_now） |

#### 4.9.5 内存管理系统调用 (`mm.rs` — 558 行)

| 系统调用 | 状态 |
|---------|------|
| `sys_mmap` | 完整实现（匿名/文件映射、SHARED/PRIVATE/FIXED、PROT_*） |
| `sys_munmap` | 完整实现 |
| `sys_mprotect` | 完整实现 |
| `sys_brk` | 完整实现 |
| `sys_madvise` | 桩实现（直接返回成功） |
| `sys_shmget/sys_shmat/sys_shmdt/sys_shmctl` | 完整实现 |

#### 4.9.6 网络系统调用 (`net.rs` — 719 行)

| 系统调用 | 状态 |
|---------|------|
| `sys_socket` | 完整实现 (AF_INET/AF_INET6/AF_UNIX, SOCK_STREAM/SOCK_DGRAM, NONBLOCK/CLOEXEC) |
| `sys_bind` | 完整实现 |
| `sys_listen` | 完整实现 |
| `sys_accept` / `sys_accept4` | 完整实现 |
| `sys_connect` | 完整实现 |
| `sys_sendto` / `sys_recvfrom` | 完整实现 |
| `sys_setsockopt` / `sys_getsockopt` | 部分实现（SOL_SOCKET 级别） |
| `sys_getsockname` / `sys_getpeername` | 完整实现 |
| `sys_shutdown` | 完整实现 |
| `sys_socketpair` | 框架实现 |

#### 4.9.7 信号系统调用 (`signal.rs` — 1,018 行)

| 系统调用 | 状态 |
|---------|------|
| `sys_rt_sigaction` | 完整实现 |
| `sys_rt_sigprocmask` | 完整实现 |
| `sys_rt_sigpending` | 完整实现 |
| `sys_rt_sigtimedwait` | 完整实现 |
| `sys_rt_sigreturn` | 完整实现（含 sigreturn trampoline） |
| `sys_kill` / `sys_tkill` / `sys_tgkill` | 完整实现 |
| `sys_rt_sigsuspend` | 基本实现 |

#### 4.9.8 时间系统调用 (`time.rs` — 897 行)

| 系统调用 | 状态 |
|---------|------|
| `sys_gettimeofday` | 完整实现 |
| `sys_clock_gettime` | 完整实现 (CLOCK_REALTIME/MONOTONIC/PROCESS_CPUTIME_ID/THREAD_CPUTIME_ID) |
| `sys_clock_settime` | 完整实现 |
| `sys_clock_getres` | 完整实现 |
| `sys_nanosleep` / `sys_clock_nanosleep` | 完整实现（基于异步定时器） |
| `sys_setitimer` / `sys_getitimer` | 完整实现 |
| `sys_times` | 完整实现 |
| `sys_adjtimex` / `sys_clock_adjtime` | 框架实现 |

#### 4.9.9 其他系统调用

- **poll/epoll** (`poll.rs`)：`sys_ppoll`、`sys_pselect6`、`sys_epoll_create1`、`sys_epoll_ctl`、`sys_epoll_pwait`
- **BPF** (`bpf.rs` — 524 行)：框架实现
- **fanotify** (`fanotify.rs` — 256 行)：`sys_fanotify_init`、`sys_fanotify_mark`
- **io_uring**：`sys_io_uring_setup`、`sys_io_uring_enter`、`sys_io_uring_register`
- **key** (`key.rs` — 307 行)：`sys_add_key`、`sys_keyctl`
- **fsmount** (`fsmount.rs` — 571 行)：`sys_fsopen`、`sys_fsmount`、`sys_fsconfig`、`sys_fspick`、`sys_open_tree`、`sys_move_mount`
- **misc** (`misc.rs`)：`sys_getrandom`、`sys_sysinfo`、`sys_syslog`、`sys_uname`
- **sche** (`sche.rs`)：调度参数设置
- **user** (`user.rs` — 322 行)：用户/组管理

---

### 4.10 VFS 虚拟文件系统 (`lib/vfs/`)

**代码量**：4,443 行。

#### 4.10.1 核心抽象

VFS 层定义了四个核心 trait：

**`Dentry`**（目录项）：
```rust
pub trait Dentry: Send + Sync {
    fn get_meta(&self) -> &DentryMeta;
    fn base_open(self: Arc<Self>) -> SysResult<Arc<dyn File>>;
    fn base_create(&self, dentry: &dyn Dentry, mode: InodeMode) -> SysResult<()>;
    fn base_lookup(&self, dentry: &dyn Dentry) -> SysResult<()>;
    fn base_link(&self, dentry: &dyn Dentry, old_dentry: &dyn Dentry) -> SysResult<()>;
    fn base_unlink(&self, dentry: &dyn Dentry) -> SysResult<()>;
    fn base_symlink(&self, dentry: &dyn Dentry, target: &str) -> SysResult<()>;
    fn base_rmdir(&self, dentry: &dyn Dentry) -> SysResult<()>;
    fn base_rename(&self, dentry: &dyn Dentry, new_dir: &dyn Dentry,
                    new_dentry: &dyn Dentry) -> SysResult<()>;
    fn base_new_neg_child(self: Arc<Self>, name: &str) -> Arc<dyn Dentry>;
    fn base_new_anonymous(self: Arc<Self>) -> Arc<dyn Dentry>;
}
```

内建方法提供：路径拼接、子节点查找、创建、挂载点管理、绑定挂载、负 dentry 处理、fanotify 事件发布等。

**`File`**（文件）：
```rust
#[async_trait]
pub trait File: Send + Sync + DowncastSync {
    fn meta(&self) -> &FileMeta;
    async fn base_read(&self, buf: &mut [u8], pos: usize) -> SysResult<usize>;
    async fn base_write(&self, buf: &[u8], pos: usize) -> SysResult<usize>;
    fn base_readlink(&self, buf: &mut [u8]) -> SysResult<usize>;
    fn base_load_dir(&self) -> SysResult<()>;
    fn ioctl(&self, cmd: usize, arg: usize) -> SyscallResult;
    async fn base_poll(&self, events: PollEvents) -> PollEvents;
    fn seek(&self, pos: SeekFrom) -> SysResult<usize>;
    // ... 更多内建方法
}
```

`FileMeta` 包含 dentry 引用、文件位置、打开标志。

**`Inode`**（索引节点）：
```rust
pub trait Inode: Send + Sync + DowncastSync {
    fn get_meta(&self) -> &InodeMeta;
    fn get_attr(&self) -> SysResult<Stat>;
    // ... 权限检查、xattr、文件句柄
}
```

`InodeMeta` 包含 inode 号、superblock 引用、页缓存、模式、大小、链接计数、时间戳、uid/gid、扩展属性等。

**`SuperBlock`**（超级块）：
```rust
pub trait SuperBlock: Send + Sync + DowncastSync {
    fn meta(&self) -> &SuperBlockMeta;
    fn stat_fs(&self) -> SysResult<StatFs>;
    fn sync_fs(&self, wait: isize) -> SysResult<()>;
}
```

#### 4.10.2 路径解析 (`path.rs`)

`Path` 结构体实现路径解析：

```rust
pub struct Path {
    start: Arc<dyn Dentry>,
    path: String,
}
```

- `walk()` 递归解析路径，返回目标 dentry
- 支持绝对/相对路径、`.` 和 `..` 组件
- 自动解析中间路径上的符号链接（最大深度 40）
- `resolve_symlink_through()` 递归解析符号链接直到找到非符号链接文件
- `split_parent_and_name()` 工具函数

#### 4.10.3 文件系统类型 (`fstype.rs`)

`FileSystemType` trait 定义文件系统类型的挂载行为：

```rust
pub trait FileSystemType: Send + Sync {
    fn get_meta(&self) -> &FileSystemTypeMeta;
    fn base_mount(self: Arc<Self>, ...) -> SysResult<Arc<dyn Dentry>>;
    fn kill_sblk(&self, sblk: Arc<dyn SuperBlock>) -> SysResult<()>;
}
```

#### 4.10.4 fanotify 集成

VFS 层内建 fanotify 支持。`Dentry` 的 `fanotify_publish()` 方法发布文件系统事件。`InodeMeta` 维护已注册的 fanotify 监听项列表。事件类型包括 `ACCESS`、`MODIFY`、`CLOSE_WRITE`、`CLOSE_NOWRITE`、`OPEN` 等。

---

### 4.11 文件系统实现

#### 4.11.1 ext4 文件系统 (`lib/ext4/`)

**代码量**：1,616 行。

基于 `lwext4_rust` crate（C 库 lwext4 的 Rust 绑定），提供完整的 ext4 读写支持。

关键组件：

- **`ExtFile`**：封装 `ext4_file` 结构体，实现 File trait。使用 `SyncUnsafeCell` 解决 lwext4_rust 中部分函数错误要求 `&mut self` 的问题。
- **`ExtDir`**：目录操作，包括创建、查找、删除、重命名
- **`ExtInode`**：inode 操作
- **`ExtDentry`**：dentry 实现
- **`ExtDisk`**：通过 Rust 的块设备抽象对接底层驱动

提供的文件操作：`open()`、`read()`、`write()`、`seek()`、`truncate()`、`link()`、`symlink()`、`readlink()`、`rename()`、`remove()` 等。

#### 4.11.2 FAT32 文件系统 (`lib/fat32/`)

**代码量**：752 行。

基于 `rust-fatfs` crate，提供 FAT32 文件系统支持。

关键组件：
- `FatFile` / `FatDir`：文件和目录操作
- `DiskCursor`：`std::io::Read + Write + Seek` 实现，桥接内核块设备与 fatfs 库
- 自定义 `NullTimeProvider`：FAT 文件系统不需要真正的时间戳

#### 4.11.3 特殊文件系统 (`lib/osfs/`)

**代码量**：15,276 行（最大的库 crate）。

##### 临时文件系统 (tmpfs)

基于 RAM 的文件系统，通过 `SimpleDentry`/`SimpleInode`/`SimpleFile` 提供：
- 匿名 inode 创建
- 文件内容存储在内存中的 `Vec<u8>`
- 目录项存储在 BTreeMap 中

##### /proc 文件系统

提供进程信息伪文件：

| 文件 | 实现 |
|------|------|
| `/proc/meminfo` | 内存信息（总内存、可用内存等） |
| `/proc/mounts` | 挂载点信息 |
| `/proc/interrupts` | 中断统计（来自 TRAP_STATS） |
| `/proc/stat` | 系统统计 |
| `/proc/<pid>/status` | 进程状态 |
| `/proc/<pid>/stat` | 进程统计 |
| `/proc/<pid>/maps` | 进程内存映射 |
| `/proc/<pid>/fd/<n>` | 进程打开文件 |
| `/proc/<pid>/fdinfo/<n>` | 文件描述符信息 |
| `/proc/<pid>/exe` | 进程可执行文件符号链接 |
| `/proc/<pid>/mounts` | 进程挂载信息 |

procfs 通过 `#[crate_interface::def_interface]` 定义 `KernelProcIf` 接口，内核侧实现该 trait 提供实际数据。

##### /dev 设备文件系统

| 设备 | 说明 |
|------|------|
| `/dev/null` | 丢弃所有写入，读取返回 EOF |
| `/dev/zero` | 读取返回零字节 |
| `/dev/full` | 写入总是返回 ENOSPC |
| `/dev/urandom` | 伪随机数生成器 |
| `/dev/tty` | 当前终端（指向 TTY0/1/2） |
| `/dev/rtc` | 实时时钟 |
| `/dev/shm` | 共享内存目录 |
| `/dev/loop` | loop 设备 |
| `/dev/stdin` / `/dev/stdout` / `/dev/stderr` | 标准 I/O |

##### /sys 文件系统

包含内存信息导出（`/sys/meminfo`）。

##### /etc 文件系统

包含配置文件（passwd 等）。

##### 管道 (pipe)

双向管道实现：
- `PipeInode`：核心环形缓冲区，默认大小 `PIPE_BUF_LEN`（与 Linux 的 PIPE_BUF 对齐）
- `PipeReadFile` / `PipeWriteFile`：管道读写端
- 异步读写支持（阻塞时挂起等待）

---

### 4.12 特殊文件与高级 I/O (`lib/osfs/src/special/`)

#### 4.12.1 epoll (`epoll/`)

完整实现 Linux epoll 机制：
- `EpollFile`：epoll 实例文件
- `EpollInner`：核心数据结构，维护被监视的文件列表
- `EpollFuture`：异步等待 epoll 事件的 Future
- 支持 `EPOLL_CTL_ADD`、`EPOLL_CTL_MOD`、`EPOLL_CTL_DEL`
- 支持 EPOLLIN/EPOLLOUT/EPOLLERR/EPOLLHUP/EPOLLET 等事件标志

epoll 的 poll 逻辑通过遍历所有注册的文件，调用各自的 `base_poll()` 方法收集就绪事件。

#### 4.12.2 eventfd (`eventfd/`)

实现 eventfd 计数器：
- 支持 `EFD_SEMAPHORE` 和 `EFD_NONBLOCK` 标志
- 读操作：消费计数器值（非信号量模式）或减 1（信号量模式）
- 写操作：增加计数器值
- 通过异步 poll 支持 epoll 集成

#### 4.12.3 timerfd (`timerfd/`)

实现基于定时器的文件描述符：
- 支持 `TFD_CLOEXEC`、`TFD_NONBLOCK`
- 定时器到期时文件变为可读
- 读取操作返回定时器到期次数

#### 4.12.4 signalfd (`signalfd/`)

实现信号文件描述符：
- 将信号作为文件描述符上的可读事件
- `SigInfo` 通过 `read()` 以 `signalfd_siginfo` 结构返回
- 与信号系统集成：`Task::recv()` 在接收信号时通知所有已注册的 signalfd

#### 4.12.5 inotify (`inotify/`)

实现文件系统事件监控：
- `InotifyFile`：inotify 实例
- 支持 `IN_ACCESS`、`IN_MODIFY`、`IN_ATTRIB`、`IN_CLOSE_WRITE`、`IN_CLOSE_NOWRITE`、`IN_OPEN`、`IN_CREATE`、`IN_DELETE` 等事件
- Watch 描述符管理
- 通过内核 `fanotify_publish()` 钩子接收事件通知

#### 4.12.6 fanotify (`lib/vfs/src/fanotify/`)

VFS 层的 fanotify 实现：
- `FanotifyGroupFile`：fanotify 组文件
- 支持 FAN_MARK_ADD、FAN_MARK_REMOVE
- 事件掩码和标志的完整定义
- 集成到 Dentry 和 Inode 中

#### 4.12.7 io_uring (`io_uring/`)

Linux io_uring 的部分实现：
- `IoUringFile`：io_uring 实例文件
- `IoUringInode`：管理提交队列 (SQ) 和完成队列 (CQ)
- `IoUringParams`：环参数
- 支持 `IORING_SETUP_SQPOLL`、`IORING_ENTER_GETEVENTS` 等标志
- 当前状态：框架实现，实际 I/O 提交逻辑简化

#### 4.12.8 memfd (`memfd/`)

实现 memfd_create：
- 匿名内存文件
- 支持 `MFD_CLOEXEC`、`MFD_ALLOW_SEALING`
- 封条 (Seals)：`F_SEAL_SEAL`、`F_SEAL_SHRINK`、`F_SEAL_GROW`、`F_SEAL_WRITE`
- 与 mmap 集成（检查写封条）

#### 4.12.9 userfaultfd (`userfaultfd/`)

实现 userfaultfd 框架：
- 缺页事件通知机制
- `UFFD_API`、`UFFDIO_API`、`UFFDIO_REGISTER`、`UFFDIO_UNREGISTER` 等 ioctl 命令
- 支持 `UFFD_FEATURE_MISSING_HUGETLBFS` 等特性

#### 4.12.10 BPF (`bpf/`)

BPF 系统调用框架：
- 支持 `BPF_MAP_CREATE`、`BPF_MAP_LOOKUP_ELEM`、`BPF_MAP_UPDATE_ELEM`、`BPF_MAP_DELETE_ELEM`、`BPF_PROG_LOAD` 等命令
- 基本数据结构定义

#### 4.12.11 perf (`perf/`)

perf_event_open 框架：
- `PerfEventFile`、`PerfEventInode`
- `PERF_TYPE_HARDWARE`、`PERF_TYPE_SOFTWARE`、`PERF_TYPE_TRACEPOINT` 等事件类型
- `perf_event_attr` 结构解析

#### 4.12.12 fscontext 和 opentree

新式文件系统挂载 API 的部分实现：
- `fsopen()`、`fsconfig()`、`fsmount()`、`fspick()`、`open_tree()`、`move_mount()`

---

### 4.13 网络协议栈 (`lib/net/` + `kernel/src/net/`)

**代码量**：2,790 + 971 行。

#### 4.13.1 基于 smoltcp 的协议栈封装

网络栈基于 `smoltcp` crate（自定义 fork 版本），提供 TCP/IP 协议支持。

核心组件：

- **`SocketSetWrapper`**：全局 socket 集合管理器，类似文件描述符表
- **`InterfaceWrapper`**：网卡抽象包装，持有 MAC 地址、IP 地址、网关等
- **`ETH0`**：全局网络接口

初始化：

```rust
pub fn init_network(net_dev: Box<dyn NetDevice>, is_loopback: bool) {
    let eth0 = InterfaceWrapper::new("eth0", net_dev, ether_addr);
    eth0.setup_ip_addr(ip_addrs);
    eth0.setup_gateway(gateway);
    ETH0.call_once(|| eth0);
}
```

网络轮询：

```rust
pub fn poll_interfaces() -> smoltcp::time::Instant {
    SOCKET_SET.poll_interfaces()
}
```

在 `task::init()` 中启动 `net_poll_init()` 内核线程，每 10ms 轮询一次网络接口。

#### 4.13.2 TCP 实现 (`tcp/`)

- **`TcpSocket`**：TCP socket 核心，封装 smoltcp 的 `tcp::Socket`
- **`TcpState`**：`AtomicU8` 表示 socket 状态（Closed, Listen, SynSent, SynReceived, Established, FinWait1, FinWait2, CloseWait, Closing, LastAck, TimeWait）
- **`ListenTable`**：监听表，管理处于 LISTEN 状态的 socket，分发新连接到 accept 队列
- **连接流程**：`bind()` → `listen()` → `accept()`（服务器）或 `connect()`（客户端）
- **异步支持**：connect/accept/recv/send 均通过 Future 实现异步等待

缓冲区大小：TCP RX/TX 各 64KB。

#### 4.13.3 UDP 实现 (`udp.rs`)

- **`UdpSocket`**：UDP socket，封装 smoltcp 的 `udp::Socket`
- 支持 bind/connect/sendto/recvfrom
- 端口自动分配（范围 0xC000-0xFFFF）
- `reuse_addr`/`reuse_port` 选项

缓冲区大小：UDP RX/TX 各 64KB, 元数据槽 8 个。

#### 4.13.4 Unix Domain Socket (`unix.rs`)

实现 Unix 域套接字（AF_UNIX）：
- 基于内核内存的进程间通信
- 支持 SOCK_STREAM 和 SOCK_DGRAM
- 路径绑定和连接

#### 4.13.5 Socket 接口层 (`kernel/src/net/socket.rs`)

`Socket` 结构体统一 TCP/UDP/Unix socket：

```rust
pub struct Socket {
    pub types: SocketType,
    pub sk: Sock,  // Tcp(TcpSocket) | Udp(UdpSocket) | Unix(UnixSocket)
    pub meta: FileMeta,
}
```

实现 `File` trait，使 socket 可以通过文件描述符操作。提供 `base_read`、`base_write`、`base_poll` 等方法。

#### 4.13.6 地址管理 (`kernel/src/net/addr.rs`)

- `SockAddr` 枚举：`Inet(InetAddr)`、`Unix(UnixAddr)`
- `read_sockaddr()` / `write_sockaddr()`：用户空间 sockaddr 的安全读写
- `SaFamily`：地址族 (AF_INET/AF_INET6/AF_UNIX)

---

### 4.14 设备驱动 (`lib/driver/` + `kernel/src/osdriver/`)

**代码量**：3,291 + 871 行。

#### 4.14.1 驱动抽象 (`lib/driver/`)

**块设备 trait**：
```rust
pub trait BlockDevice: Send + Sync + OSDevice {
    fn read(&self, block_id: usize, buf: &mut [u8]);
    fn write(&self, block_id: usize, buf: &[u8]);
    fn size(&self) -> u64;
    fn block_size(&self) -> usize;
}
```

**字符设备 trait**：
```rust
#[async_trait]
pub trait CharDevice: Send + Sync + OSDevice {
    fn get(&self, data: &mut u8) -> Result<(), uart_16550::WouldBlockError>;
    fn puts(&self, datas: &[u8]);
    fn handle_irq(&self);
    async fn write(&self, buf: &[u8]) -> usize;
    async fn read(&self, buf: &mut [u8]) -> usize;
}
```

#### 4.14.2 VirtIO 驱动

支持 MMIO 和 PCI 传输方式：
- **VirtIO Block**：通过 `virtio-drivers` crate 实现，支持读写操作。作为全局 `BLOCK_DEVICE`。
- **VirtIO Net**：通过 `virtio-drivers` crate 实现，创建 `VirtNetDevice` 适配 smoltcp。
- **VirtIO Console**：探测但不作为主要控制台。

#### 4.14.3 串口驱动

- **UART 16550 / ns16550a**：基于 `uart_16550` crate，MMIO 方式访问
- **SiFive UART**：用于 QEMU sifive_u 平台
- 作为全局 `CHAR_DEVICE`

#### 4.14.4 SD/MMC 驱动 (`dw_mshc/`)

为 JH7110（StarFive VisionFive2）板卡实现的 DesignWare MSHC SD/MMC 控制器驱动：
- `dw_mshc/mmc.rs` (594 行)：MMC/SD 卡协议实现
- `dw_mshc/registers.rs` (576 行)：DW MSHC 寄存器定义
- `dw_mshc/dma.rs`：DMA 传输支持

#### 4.14.5 PLIC 中断控制器

平台级中断控制器驱动，管理外部中断源。

#### 4.14.6 设备树探测 (`kernel/src/osdriver/probe.rs`)

`probe_tree()` 函数遍历设备树 (FDT)，自动发现和配置设备：

1. 探测 PLIC（中断控制器）
2. 探测串口设备
3. 探测 SD/MMC 块设备
4. 遍历所有 `virtio,mmio` 兼容节点，创建 VirtIO 传输并匹配设备类型
5. 探测 PCI 总线上的 VirtIO 设备
6. 如果没有发现网络设备，创建 Loopback 设备作为回退

设备探测支持：
- FDT 节点匹配（通过 compatible 字符串）
- MMIO 地址映射（ioremap）
- VirtIO MMIO 传输初始化
- VirtIO PCI 传输初始化（PCI 总线枚举、CAM 访问）

#### 4.14.7 Loopback 网络设备

纯软件实现的回环网络设备，用于没有物理网卡时的本地网络通信。实现了 `NetDevice` trait。

---

### 4.15 同步原语 (`lib/mutex/`)

**代码量**：720 行。

提供五种互斥锁实现：

| 锁类型 | 文件 | 说明 |
|--------|------|------|
| `SpinLock` / `SpinNoIrqLock` | `spin_mutex.rs` | 自旋锁，忙等。`SpinNoIrqLock` 额外关闭中断 |
| `SleepMutex` | `sleep_mutex.rs` | 睡眠锁，基于异步挂起 |
| `OptimisticMutex` | `optimistic_mutex.rs` | 乐观锁，适用于读多写少场景 |
| `ShareMutex` | `share_mutex.rs` | 共享锁，类似读写锁 |
| `SpinThenSleepMutex` | `spin_then_sleep_mutex.rs` | 先自旋后睡眠的混合锁 |

`SpinLock<T>` 基于 `spin::Mutex<T>`（`spin = "0.9.8"`），`SpinNoIrqLock<T>` 在锁定/解锁时额外禁用/恢复中断。

`ShareMutex<T>` 通过 `new_share_mutex()` 创建，内部使用 `SpinLock` 保护数据，但接口设计为共享引用模式。

---

### 4.16 信号系统

**代码量**：内核侧 ~800 行 + `lib/signal/` 346 行。

#### 4.16.1 信号类型 (`lib/signal/src/lib.rs`)

定义 65 种信号（`NSIG = 65`），包括标准 POSIX 信号和 Linux 实时信号：
- `Sig` 枚举（通过 strum 派生 `FromRepr`）
- `SigSet` 位图（基于 bitflags）
- `SigInfo`：信号详细信息（发送者 PID、UID、si_code 等）
- `LinuxSigInfo`：Linux 兼容的 siginfo_t 结构
- `SigDetails` 枚举：None、Kill（含 sender PID）、Child（含 child PID）

#### 4.16.2 信号管理 (`kernel/src/task/sig_members.rs`)

**`SigAction`**：信号处理动作定义
```rust
pub struct SigAction {
    pub sa_handler: usize,      // SIG_DFL(0) / SIG_IGN(1) / 用户函数指针
    pub sa_flags: SigActionFlag,
    pub restorer: usize,
    pub sa_mask: SigSet,
}
```

**`SigHandlers`**：管理所有信号的注册处理函数

**`SigManager`**：管理进程接收到的信号
```rust
pub struct SigManager {
    pub queue: VecDeque<SigInfo>,     // 信号队列
    pub bitmap: SigSet,               // 防止重复信号入队
    pub should_wake: SigSet,         // 哪些信号应唤醒进程
}
```

#### 4.16.3 信号接收与唤醒

`Task::recv()` 在进程接收信号时：
1. 通知所有已注册的 signalfd
2. 将信号加入 `SigManager` 的队列
3. 如果信号未被阻塞且能唤醒进程（在 `should_wake` 集合中），且进程处于 `Interruptible` 状态，则唤醒进程

`Task::set_wake_up_signal()` 允许任务设置哪些信号可以唤醒它（SIGKILL 和 SIGSTOP 默认可唤醒）。

#### 4.16.4 信号执行 (`kernel/src/task/signal/sig_exec.rs`)

`sig_check()` 函数在每个用户陷阱处理后调用：
- 从队列中出队未阻塞的信号
- 调用 `sig_exec()` 处理每个信号

`sig_exec()` 根据信号动作类型执行：
- **Ignore**：忽略
- **Kill**：设置进程为 Zombie（init 进程的 SIGKILL 被忽略）
- **Stop**：设置进程为 Sleeping 状态
- **Cont**：唤醒被停止的进程
- **User**：设置用户自定义信号处理函数
  - 如果设置了 SA_RESTART 且系统调用被中断，重启系统调用（回退 sepc）
  - 构建信号栈帧（SignalStack），保存原陷阱上下文
  - 设置用户 sp 指向信号栈（如果设置了 SA_ONSTACK）
  - 设置 sepc 为信号处理函数地址
  - 设置 ra 为 sigreturn trampoline 地址

#### 4.16.5 sigreturn 机制

每个架构有独立的 sigreturn trampoline 汇编代码（`riscv64_sigreturn_trampoline.asm` / `loongarch64_sigreturn_trampoline.asm`）。trampoline 将 sigreturn 的系统调用号加载到 a7 寄存器，然后执行 ecall 触发 `rt_sigreturn` 系统调用，恢复原陷阱上下文。

---

### 4.17 定时器管理 (`lib/timer/`)

**代码量**：306 行。

#### 4.17.1 定时器管理器 (`timer_manager.rs`)

```rust
pub static TIMER_MANAGER: TimerManager = TimerManager::new();

pub struct TimerManager {
    timers: SpinNoIrqLock<BinaryHeap<Reverse<Timer>>>,
}
```

使用最小堆（`BinaryHeap<Reverse<Timer>>`）管理定时器。`Timer::Ord` 按过期时间排序。

- `add_timer()`：添加定时器到堆中
- `check(current)`：遍历堆顶，触发所有到期的定时器回调；对于周期性定时器且回调未取消的，重新入堆

#### 4.17.2 定时器结构 (`timer.rs`)

```rust
pub struct Timer {
    pub expire: Duration,
    pub callback: Option<Arc<dyn IEvent>>,
    state: TimerState,
    waker: Option<Waker>,
    periodic: bool,
}
```

- `set_waker_callback(waker)`：设置唤醒回调
- `IEvent` trait：定义 `callback()` 方法，返回 `TimerState`（`Fired` 或 `Cancelled`）

#### 4.17.3 异步定时器 (`async_timer.rs`)

- `sleep_ms()`：异步睡眠指定毫秒数
- `TimeoutFuture`：给任何 Future 添加超时限制
- `run_with_timeout()`：运行 Future 并指定超时

#### 4.17.4 任务超时 (`kernel/src/task/taskf.rs`)

`Task::suspend_timeout()`：挂起任务直到被唤醒或超时，返回剩余时间。

---

### 4.18 用户态程序 (`user/`)

**代码量**：4,608 行。

#### 4.18.1 系统调用封装 (`syscall.rs` — 365 行)

提供 Rust 用户态系统调用接口：

```rust
// 每个系统调用都是对 ecall 指令的包装
pub fn sys_write(fd: usize, buf: &[u8]) -> isize { ... }
pub fn sys_read(fd: usize, buf: &mut [u8]) -> isize { ... }
pub fn sys_open(path: &str, flags: i32, mode: i32) -> isize { ... }
// 等等
```

#### 4.18.2 初始化进程 (`init_proc.rs` / `init_proc-rv.rs` / `init_proc-la.rs`)

架构特定的 init 进程，负责：
- 挂载 procfs、devfs 等文件系统
- 启动 shell
- 运行测试程序

#### 4.18.3 Shell (`shell.rs`)

简单命令行 shell，支持：
- 基本命令执行
- 内置命令（cd 等）
- 外部程序加载和运行

#### 4.18.4 LTP 测试框架 (`ltpauto.rs` — 2,306 行)

最大的用户态源文件，实现 Linux Test Project (LTP) 自动化测试框架：
- 测试用例管理
- 测试结果记录和汇总
- 支持 busybox、LTP 等标准测试套件

#### 4.18.5 测试程序

多个测试程序：`clone_test`、`file_test`、`sleep_test`、`time_test`、`hello_world`、`preliminary_test`、`userclone`、`add`/`add2`、`getdents2` 等。

#### 4.18.6 编译为内嵌程序

用户程序通过 `build.rs` 编译为独立二进制文件，然后通过 `linkapp.asm` 模板嵌入内核 ELF 的数据段中。内核的 `loader.rs` 提供 `get_app_data()` / `get_app_data_by_name()` 来访问这些内嵌程序。

---

### 4.19 配置与构建系统

#### 4.19.1 配置系统 (`lib/config/`)

`lib/config/` (930 行) 提供以下配置模块：

- **`mm.rs`**：内存布局常量（RAM 地址、内核虚拟地址、页大小、用户栈/堆位置、MMIO 范围等）
- **`board.rs`**：板级配置（时钟频率、HART 数量）
- **`device.rs`**：设备配置（最大 HART 数、块大小）
- **`fs.rs`**：文件系统配置（最大文件描述符数）
- **`vfs.rs`**：VFS 相关标志位定义（OpenFlags、PollEvents、SeekFrom、AtFd、MountFlags 等）
- **`process.rs`**：进程相关标志（CloneFlags、WaitOptions）
- **`inode.rs`**：inode 相关类型（InodeMode、InodeType、InodeState）
- **`sig.rs`**：信号配置
- **`sbi.rs`**：SBI 相关
- **`time.rs`**：时间相关

#### 4.19.2 构建系统

**Makefile**（约 250 行）：
- 支持 `ARCH=riscv64` / `ARCH=loongarch64`
- `make build`：编译内核 + 用户程序
- `make run`：编译并启动 QEMU
- `make fs-img`：创建文件系统镜像
- `make rkernel-build` / `lkernel-build`：分别编译两种架构
- `make board-rv` / `make board-la`：为真实硬件（VisionFive2/LoongArch）创建 uImage

**QEMU 启动参数**（RISC-V）：
```
qemu-system-riscv64 -m 1G -machine virt -nographic -bios default
  -kernel <KERNEL_ELF> -smp 1
  -drive file=<SDCARD_IMG>,if=none,format=raw,id=x0
  -device virtio-blk-device,drive=x0
  -device virtio-net-device,netdev=net0
  -netdev user,id=net0
```

**Cargo workspace**：`Cargo.toml` 定义 workspace 依赖，统一管理 crate 版本。

**Docker 构建环境** (`Dockerfile`)：
- 基于 Ubuntu 22.04
- 安装 Rust nightly-2025-01-18 及多个工具链版本
- 安装 RISC-V 和 LoongArch 交叉编译工具链
- 编译安装 QEMU 9.2.1（支持 riscv64/loongarch64/aarch64/x86_64）
- 安装 llvm-tools、cargo-binutils
- 安装 libguestfs、qemu-utils 用于镜像制作

---

## 5. 各子系统交互关系

### 5.1 系统调用数据流

```
用户程序 → ecall → __trap_from_user (汇编) → trap_handler → 
async_syscall → syscall() → 具体 sys_*() 函数 → 各子系统 → 
结果写入 TrapContext.a0 → __return_to_user (汇编) → sret → 用户程序
```

### 5.2 文件 I/O 数据流

```
sys_read/write → File::base_read/base_write (异步) → 
具体文件系统实现 (ext4/FAT32/tmpfs/...) → 
(可选) PageCache → 块设备驱动 → 硬件
```

### 5.3 网络数据流

```
用户程序 socket → Socket (File trait) → Sock → 
TcpSocket/UdpSocket/UnixSocket → smoltcp SocketSet → 
InterfaceWrapper → NetDevice (VirtIO) → 
poll_interfaces() 定时轮询 → 硬件
```

### 5.4 调度数据流

```
executor::task_run_always_alone → fetch_one (工作窃取) → 
Runnable::run() → UserFuture::poll() → 
hart.user_switch_in → task_executor_unit → 
  trap_return (→用户态) → 陷阱 → trap_handler → async_syscall →
  sig_check → yield_now/suspend_now (→挂起) →
hart.user_switch_out → 继续下一个 Runnable
```

### 5.5 信号传递路径

```
发送者 (kill/tgkill) → 目标 Task::recv() → SigManager::add() → 
  (可选) 唤醒目标 → sig_check() → sig_exec() → 
  User Action: 修改陷阱上下文 → 返回到用户态信号处理函数 →
  sigreturn trampoline → rt_sigreturn 系统调用 → 恢复上下文
```

### 5.6 内存管理协同

```
mmap → AddrSpace::map_file() → find_vacant_memory() → add_area() → 
  按需：handle_page_fault() → PageTable::map() → FrameTracker::build()
```

---

## 6. 内核实现完整度评估

### 6.1 评估基准

以 Linux 5.x 内核的功能集为参照基准（100% 表示完全达到 Linux 同等功能），结合该项目定位于教学/竞赛操作系统的背景进行评估。

### 6.2 子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **内存管理** | 75% | 页表管理、VMA、mmap/munmap/mprotect/brk 完整；缺页处理完善；COW 基本实现；缺少页面回收、swap、THP、NUMA、KSM 等高级特性 |
| **进程管理** | 70% | fork/clone/execve/wait4/exit 完整；任务状态机清晰；缺少 cgroup、namespace、cpuset、实时调度等 |
| **文件系统 (VFS)** | 80% | 抽象层设计优秀；Dentry/Inode/File/SuperBlock 四层模型清晰；路径解析完整（含符号链接）；fanotify 集成；缺少文件锁、配额、ACL |
| **ext4** | 60% | 基于 lwext4_rust，基本读写完整；目录操作实现；缺少日志、扩展属性、加密等 |
| **FAT32** | 50% | 基于 rust-fatfs，基本读写；缺少 exFAT |
| **procfs/devfs/sysfs** | 65% | 常用文件实现；部分文件为桩实现 |
| **网络协议栈** | 55% | TCP/UDP 基本可用（基于 smoltcp）；Unix domain socket 实现；缺少 IPv6 完整支持、路由、ARP 表管理、netfilter、多网卡绑定等 |
| **设备驱动** | 45% | VirtIO blk/net/console；UART 16550；PLIC；DW MSHC (SD)；缺少 USB、PCIe 枚举、GPU、声卡等 |
| **同步原语** | 70% | 5 种锁实现，覆盖多种场景；缺少 RCU、seqlock、读写信号量等 |
| **信号系统** | 75% | 信号发送/接收/处理完整；sigreturn 机制正确；实时信号支持；缺少 core dump、作业控制信号详细处理 |
| **定时器** | 65% | 基本定时器管理；异步超时；缺少高精度定时器 (hrtimer)、tickless |
| **异步运行时** | 60% | 自研执行器；工作窃取；缺少优先级调度、deadline 调度、cgroup 感知 |
| **系统调用** | 65% | 110+ 系统调用实现；约 60% 的常用 Linux 系统调用；部分为桩实现 |
| **io_uring** | 25% | 框架实现，实际 I/O 提交逻辑简化 |
| **eBPF** | 20% | 基本框架，无 JIT 编译器 |
| **用户态兼容** | 55% | 可运行 busybox/LTP 部分用例；缺少 glibc 全部特性支持 |

### 6.3 整体完整度

**整体评估：约 60%**（相对于 Linux 内核的完整功能集）

如果以教学/竞赛操作系统为基准：**约 85%**，该项目在有限时间内实现了一个功能丰富、设计现代的操作系统内核。

---

## 7. 设计创新性分析

### 7.1 异步优先架构（核心创新）

DDUOS 最显著的设计创新是**全异步内核架构**。与传统同步内核不同：

1. **系统调用均为异步**：`syscall()` 函数签名是 `async fn`，所有系统调用处理函数返回 Future。
2. **自研异步运行时**：实现了包含工作窃取的多 HART 任务执行器和自定义 Future 类型。
3. **异步 I/O 路径**：从 VFS 的 `File` trait（使用 `#[async_trait]`）到具体文件系统实现，I/O 操作全部异步化。
4. **用户任务作为 Future**：`UserFuture` 将传统进程/线程封装为 Future，由统一调度器管理。

这种设计在以下方面体现创新性：

- **统一调度模型**：用户进程、内核线程、I/O 操作都在同一异步框架下调度，消除了传统内核中进程上下文和中断上下文的二元区分。
- **天然避免阻塞**：所有可能阻塞的操作（磁盘 I/O、网络 I/O、定时等待）都通过 `suspend_now().await` 模式实现，CPU 自动切换到其他就绪任务。
- **工作窃取负载均衡**：多个 HART 之间通过工作窃取实现自动负载均衡，无需显式的负载均衡器。

### 7.2 Rust 零成本抽象的深度应用

1. **trait 对象实现多态 VFS**：`dyn Dentry`、`dyn File`、`dyn Inode`、`dyn SuperBlock` 提供文件系统多态，配合 `DowncastSync` 实现向下转型。
2. **过程宏生成架构无关代码**：`define_arch_mods!` 和 `def_percpu` 等宏自动生成条件编译代码和 per-CPU 变量包装。
3. **RAII 资源管理**：`FrameTracker`、`SumGuard` 等通过 Drop 自动释放资源。

### 7.3 双架构支持的巧妙抽象

- **`define_arch_mods!` 宏**：一行代码即可为多个架构生成模块声明和条件导入。
- **统一的 PteFlags/MappingFlags 转换**：架构间使用统一的语义层，架构相关文件仅提供底层位操作。
- **LoongArch TLB 处理**：LoongArch 不像 RISC-V 有硬件页表遍历，项目为 LoongArch 实现了完整的软件 TLB refill 处理程序（`tlb_refill`），使用 `lddir`/`ldpte` 指令优化页表遍历。

### 7.4 与 Linux ABI 深度兼容的设计

- **系统调用号**：直接从 Linux `asm-generic/unistd.h` 引入。
- **数据结构**：`LinuxSigInfo`（siginfo_t）、`Kstat`（stat 结构）、`IoUringParams` 等与 Linux 二进制兼容。
- **特殊文件系统**：procfs、devfs、sysfs 模仿 Linux 布局，使标准工具（如 busybox）可以无修改运行。

### 7.5 局限性也反映了创新取舍

- **简化而非模仿**：如 `block_on()` 使用忙等轮询（适合内核不可抢占场景），而非传统的事件驱动。
- **工作窃取而非传统调度**：用异步运行时的工作窃取替代传统的 CFS/实时调度器，简化了实现的同时支持了现代多核负载均衡。

---

## 8. 其他信息

### 8.1 代码统计总览

| 类别 | 代码行数 | 占比 |
|------|---------|------|
| 系统调用 | 12,127 | 19.3% |
| 特殊文件系统 (osfs) | 15,276 | 24.3% |
| VFS 层 | 4,443 | 7.1% |
| 任务管理 | 4,358 | 6.9% |
| 用户态程序 | 4,608 | 7.3% |
| 虚拟内存 | 3,555 | 5.7% |
| 设备驱动 | 4,162 | 6.6% |
| 网络协议栈 | 3,761 | 6.0% |
| ext4/FAT32 | 2,368 | 3.8% |
| 其他 | 8,306 | 13.2% |
| **总计** | **~62,964** | **100%** |

### 8.2 外部依赖分析

| 依赖 | 用途 | 许可风险 |
|------|------|---------|
| smoltcp (fork) | TCP/IP 协议栈 | 自维护 fork |
| lwext4_rust (fork) | ext4 支持 | 自维护 fork，绑定 C 库 |
| rust-fatfs (fork) | FAT32 支持 | 自维护 fork |
| virtio-drivers 0.11 | VirtIO 驱动 | 社区 crate |
| async-task 4.7 | 异步任务抽象 | 社区 crate |
| buddy_system_allocator | 内核堆分配器 | 社区 crate |
| bitmap-allocator | 帧分配器 | 社区 crate |
| elf (fork) | ELF 解析 | 自维护 fork |
| flat_device_tree 3.1 | 设备树解析 | 社区 crate |
| riscv 0.13 | RISC-V CSR 操作 | 社区 crate |
| loongArch64 (fork) | LoongArch CSR 操作 | 自维护 fork |

项目大量使用了自维护的外部依赖 fork，这可能增加了维护负担但增强了对依赖的控制。

### 8.3 目标平台

- **QEMU 虚拟平台**：`riscv64 virt` 和 `loongarch64 virt`
- **真实硬件**（部分支持）：StarFive VisionFive2 (JH7110, RISC-V)、LoongArch 2K1000 板卡

### 8.4 安全考虑

- **用户指针安全访问**：`UserReadPtr`/`UserWritePtr` 确保所有用户空间访问经过验证
- **SUM 位管理**：RISC-V 上通过引用计数管理 SUM 位
- **权限检查**：Inode 的 `check_permission()` 实现标准的 Unix rwx 权限模型
- **Capability 系统**：`Task::caps` 字段和 `CapabilitiesFlags` 表明计划实现 Linux capability 机制

---

## 9. 总结

DDUOS（NighthawkOS）是一个**功能丰富、设计现代**的操作系统内核项目，具有以下核心特征：

**优势**：
1. **完整的功能栈**：从底层内存管理到高层特殊文件系统（epoll、io_uring、fanotify），形成了一个完整的内核功能矩阵。
2. **异步优先的现代化设计**：自研异步运行时统一了进程调度和 I/O 处理，是相较于传统同步内核的显著架构创新。
3. **清晰的模块化架构**：22 个独立的 lib crate 配合 kernel crate，依赖关系清晰，接口定义明确。
4. **双架构支持**：RISC-V 64 和 LoongArch 64 的架构抽象层设计优雅，展现了良好的可移植性设计。
5. **Linux ABI 兼容**：110+ 系统调用、兼容的数据结构、procfs/devfs/sysfs 布局，使标准 Linux 用户态程序可以直接运行。
6. **工程化程度高**：Docker 构建环境、离线 vendor 依赖、Makefile 多目标构建、LTP 测试框架集成。
7. **代码质量**：使用 Rust 安全特性（类型系统、所有权、RAII），大量使用 `# Safety` 注释标注 unsafe 代码的安全条件。

**不足**：
1. 部分子系统为框架/桩实现（io_uring、BPF、perf 等），实际功能有限。
2. 多核支持声明为"unsupported"（`panic!("multi-core unsupported")`）。
3. 部分系统调用（如 madvise）直接返回成功而不执行实际操作。
4. 缺少 swap、页面回收、高级内存管理特性。
5. 网络协议栈功能有限（基于裁剪的 smoltcp）。
6. 依赖大量自维护的 fork，长期维护成本较高。

**综合评价**：DDUOS 是一个**高质量的竞赛/研究型操作系统内核**，在异步内核设计、Linux ABI 兼容性和多架构支持方面展现了显著的技术深度。其约 6.3 万行的 Rust 代码实现了从硬件抽象到用户态接口的完整垂直整合，是操作系统领域 Rust 语言应用的优秀范例。