# Eureka OS 内核项目深度技术分析报告

## 一、分析方法与过程

本报告基于以下分析手段生成：

1. **静态代码审查**：对所有 Rust 源文件、汇编文件、链接脚本、构建配置文件、Cargo 配置进行全面审阅。
2. **结构提取**：统计各子系统代码行数、模块依赖关系、关键数据结构定义。
3. **HAL 接口分析**：逐组件比对 RISC-V 与 LoongArch 双架构的 trait 实现差异。
4. **系统调用清单枚举**：从 `syscall/mod.rs` 提取完整调度表，确认已实现的 syscall 及其处理函数位置。
5. **构建系统分析**：解析顶层与 `os/` 下的 Makefile，确认交叉编译与镜像制作流程。
6. **未进行运行时测试**：环境中 QEMU 虽可用但缺少完整的磁盘镜像（需外部 `sdcard-rv.img`），无法进行完整的启动与系统调用验证。此项限制在报告中已注明。

---

## 二、项目总体结构

### 2.1 项目概述

| 属性 | 值 |
|---|---|
| 项目名称 | Eureka OS |
| 开发团队 | 武汉大学 Eureka 团队 |
| 语言 | Rust (核心) + C (lwext4 底层) + 汇编 (HAL 入口/Trap/上下文切换) |
| 内核类型 | 宏内核 (Monolithic Kernel) |
| 目标架构 | RISC-V 64 (rv64gc) + LoongArch 64 |
| Rust 工具链 | `nightly-2025-02-01` |
| 总代码量 | ~55,600 行 Rust + ~1,100 行汇编 + ~3,100 行 HAL |

### 2.2 代码规模分布

| 子系统 | 行数 | 占比 |
|---|---|---|
| `syscall/fs.rs` | 12,914 | 23.2% |
| `mm/memory_set.rs` | 6,228 | 11.2% |
| `syscall/process.rs` | 4,955 | 8.9% |
| `fs/stdio.rs` | 3,157 | 5.7% |
| `mission/mod.rs` | 2,366 | 4.3% |
| `task/task.rs` | 2,080 | 3.7% |
| `net/mod.rs` | 1,980 | 3.6% |
| `syscall/mod.rs` (dispatch) | 1,895 | 3.4% |
| `fs/ext4.rs` | 1,842 | 3.3% |
| `syscall/net.rs` | 1,578 | 2.8% |
| `syscall/time.rs` | 1,454 | 2.6% |
| `syscall/key.rs` | 1,417 | 2.5% |
| `syscall/ipc.rs` | 1,387 | 2.5% |
| `ipc/sysv.rs` | 1,290 | 2.3% |
| HAL 总计 | 3,078 | 5.5% |

---

## 三、子系统详细实现拆解

### 3.1 入口与初始化 (`main.rs`)

**实现概述**：内核入口函数 `rust_main()` 在 HAL 提供的汇编入口 (`_start`) 设置好栈指针后被调用。

**启动流程**（`os/src/main.rs`）：

```rust
pub fn rust_main() -> ! {
    clear_bss();                          // 清零 BSS 段
    enable_user_counters();               // 允许 U-mode 读取 time/instret 计数器
    Instruction::enable_floating_point(); // 启用浮点单元
    println!("[kernel] Hello, world!");
    logging::init();                      // 日志系统初始化
    mm::init();                           // 内存管理初始化（堆、帧分配器、内核页表）
    mm::remap_test();                     // 内核重映射自检
    trap::init();                         // 设置 stvec 陷阱向量
    mm::kernel_vmap_smoke_test();         // 内核 vmap 冒烟测试
    fs::list_apps();                      // 列出根文件系统中的可执行文件
    mission::add_initproc();              // 创建 init 进程
    trap::enable_timer_interrupt();       // 开启时钟中断
    timer::set_next_trigger();            // 设置首次时钟触发
    mission::run_tasks();                 // 进入调度器主循环
    mm::dump_allocator_stats();           // 输出分配器统计（不可达代码）
    panic!("Unreachable in rust_main!");
}
```

**关键观察**：
- 启动时执行了内核重映射自检 (`remap_test`) 和 vmap 冒烟测试 (`kernel_vmap_smoke_test`)，说明内核实现了自身的虚拟地址重映射。
- 最后一行 `dump_allocator_stats()` 是防御性死代码——`run_tasks()` 永不返回。
- 通过 SBI 调用 (`firmware.rs`) 或 LoongArch UART 直接访问实现控制台输出。

---

### 3.2 硬件抽象层 (HAL)

**目录**：`hal/src/component/`

**设计模式**：每个子组件定义统一的 Rust trait，然后按 `riscv64` 和 `loongarch64` 分别提供实现模块，由 `mod.rs` 中的条件编译 (`#[cfg(target_arch = ...)]`) 选择。

#### 3.2.1 HAL 组件清单

| 组件 | Trait | RISC-V 实现 | LoongArch 实现 |
|---|---|---|---|
| `abi` | `AbiHal` | `riscv64.rs` (43行) | `loongarch64.rs` (43行) |
| `constant` | `ConstantHal` | `riscv64.rs` (27行) | `loongarch64.rs` (27行) |
| `context` | `TaskContextLayout` | 统一的 `mod.rs` (6行) | 同 |
| `cpu` | `CpuHal` | `riscv64.rs` (11行) | `loongarch64.rs` (11行) |
| `entry` | 宏 `include_entry_asm!` | `riscv64.S` (12行) | `loongarch64.S` (54行) |
| `firmware` | `FirmwareHal` | `riscv64.rs` (71行) | `loongarch64.rs` (114行) |
| `instruction` | `Instruction` | `riscv64.rs` (23行) | `loongarch64.rs` (26行) |
| `irq` | `IrqHal` | `riscv64.rs` (17行) | `loongarch64.rs` (69行) |
| `pagetable` | `PageTableHal` | `riscv64.rs` (140行) | `loongarch64.rs` (322行) |
| `signal` | `SignalHal` | `riscv64.rs` (16行) | `loongarch64.rs` (16行) |
| `switch` | 无 trait，直接汇编 | `asm/riscv64.S` (25行) | `asm/loongarch64.S` (33行) |
| `timer` | `TimerHal` | `riscv64.rs` (15行) | `loongarch64.rs` (60行) |
| `trap` | `TrapHal` + `TrapContextHal` | `riscv64.rs` (248行) | `loongarch64.rs` (507行) |
| `virtio` | 无 trait，直接实现 | `riscv64.rs` (15行) | `loongarch64.rs` (71行) |

#### 3.2.2 固件抽象 (`firmware`)

**RISC-V**：通过 SBI ecall 实现，包括：
- `set_timer`: 使用 SBI TIME 扩展 (`SBI_EXT_TIME`)
- `console_putchar`/`console_getchar`: 使用传统 SBI 控制台调用
- `shutdown`: 使用 SBI SRST 扩展

```rust
// riscv64.rs
fn sbi_call_ex(ext: usize, fid: usize, arg0: usize, arg1: usize, arg2: usize) -> usize {
    let mut ret;
    unsafe {
        core::arch::asm!(
            "ecall",
            inlateout("x10") arg0 => ret,
            in("x11") arg1, in("x12") arg2,
            in("x16") fid, in("x17") ext,
        );
    }
    ret
}
```

**LoongArch**：直接使用 MMIO 访问 UART（`0x9000_0000_0000_0000 | 0x1fe0_01e0`）和定时器 CSR，通过写 `0x8000_0000_100e_001c` MMIO 地址实现关机。

#### 3.2.3 页表抽象 (`pagetable`)

**RISC-V (Sv39)**：
- 3 级页表，每级 9 位索引（512 项）
- PA 宽度 56 位，VA 宽度 39 位
- 软 CoW 位：PTE bit[8]（`1 << 8`）
- `satp` mode: 8（Sv39）
- 单根页表激活 (`AddressSpaceActivation::Single`)

**LoongArch (LA39)**：
- 3 级页表，每级 9 位索引
- PA 宽度 48 位，VA 宽度 39 位
- 软 CoW 位：PTE bit[58]
- 双根页表激活 (`AddressSpaceActivation::Split`)：PGDL（低半地址）和 PGDH（高半地址）两个 CSR
- 使用 DMW（直接映射窗口）将 `0x9000...` 映射到物理地址
- 包含 TLB 重填异常处理 (`__tlb_refill_entry`)，这是 LoongArch 的独特需求

#### 3.2.4 Trap 处理 (`trap`)

**RISC-V Trap 上下文**（37 字 = 296 字节）：
```rust
pub struct TrapContext {
    pub x: [usize; 32],        // 通用寄存器
    pub status_bits: usize,    // sstatus
    pub sepc: usize,           // 异常 PC
    pub kernel_satp: usize,    // 内核页表
    pub kernel_sp: usize,      // 内核栈指针
    pub trap_handler: usize,   // trap 处理函数地址
}
```

**LoongArch Trap 上下文**（35 字 = 280 字节）：
```rust
pub struct TrapContext {
    pub gpr: [usize; 32],      // 通用寄存器
    pub user_prmd: usize,      // 用户模式 PRMD
    pub user_era: usize,       // 用户异常返回地址
    pub kernel_sp: usize,      // 内核栈指针
}
```

**关键差异**：
- RISC-V 使用 trampoline 页（`strampoline`）进行用户态/内核态切换，利用 `sscratch` CSR 保存/恢复上下文。
- LoongArch 使用 `CSR 0x31`（`KSAVE5`）存储用户态上下文指针，区分用户态和内核态 trap 路径（`__trap_from_user` vs `__trap_from_kernel`）。
- LoongArch 需要单独处理 TLB 重填异常（`__tlb_refill_entry`，页对齐 4096 字节）。

#### 3.2.5 上下文切换 (`switch`)

**RISC-V**：
```asm
__switch:
    sd sp, 8(a0)       # 保存当前 sp
    sd ra, 0(a0)       # 保存当前 ra
    SAVE_SN 0..11      # 保存 s0-s11
    ld ra, 0(a1)       # 恢复目标 ra
    LOAD_SN 0..11      # 恢复目标 s0-s11
    ld sp, 8(a1)       # 恢复目标 sp
    ret
```

保存/恢复的寄存器：`ra`, `sp`, `s0-s11`（14 个寄存器），与 `TaskContext` 结构对应。

#### 3.2.6 HAL 完整性评估

| 组件 | 完整度 | 说明 |
|---|---|---|
| ABI | 完整 | 机器名、loader 路径等 |
| Constant | 完整 | 时钟频率、内存边界、MMIO 区域 |
| CPU | 完整 | CPU ID 获取 |
| Entry | 完整 | 启动汇编 + 链接脚本 |
| Firmware | 完整 | SBI / 直接 MMIO |
| Instruction | 基本完整 | `sfence.vma`、浮点使能、用户计数器 |
| IRQ | 完整 | 定时器中断控制 |
| PageTable | 完整 | Sv39 / LA39，含 TLB 刷新 |
| Signal | 完整 | Trampoline 地址、Trap 上下文基址 |
| Switch | 完整 | 上下文切换汇编 |
| Timer | 完整 | 读取时间、设置下次触发 |
| Trap | 完整 | 用户态/内核态 trap、上下文保存恢复 |
| VirtIO | 完整 | MMIO/PCI 传输抽象 |

---

### 3.3 内存管理子系统 (MM)

**源文件**：`os/src/mm/`（9 个文件，~8,700 行）

#### 3.3.1 物理页帧分配器 (`frame_allocator.rs`, ~752 行)

**实现方式**：
- 基于 `buddy_system_allocator` crate 的伙伴系统分配器
- 支持三种粒度的分配：
  - 4KB 标准页帧（`frame_alloc`/`frame_dealloc`）
  - 2MB 大页（`huge_2m_alloc`/`huge_2m_dealloc`，512 个 4KB 页）
  - 1GB 巨页（`huge_1g_alloc`/`huge_1g_dealloc`，262,144 个 4KB 页）
- 独立的页表节点缓存（`pt_node_alloc`/`pt_node_dealloc`），限制 1024 个
- 2MB 大页缓存限制 128 个，1GB 巨页缓存限制 8 个
- 实现了引用计数追踪系统 (`FrameRefTable`)：记录每个物理页帧的引用计数，用于诊断内存泄漏
- `FrameTracker` 作为 RAII 守卫，在 drop 时自动释放页帧

**关键特性**：
- 大页/巨页分配优先从缓存池获取，失败后再从伙伴系统分配
- 全量引用计数追踪，支持 frame-ref 事件日志用于调试

#### 3.3.2 页表 (`page_table.rs`, ~576 行)

**核心数据结构**：

```rust
pub(crate) struct PageTable {
    root_ppn: PhysPageNum,           // 根页表物理页号
    pt_frames: Vec<FrameTracker>,    // 持有的中间页表帧
}

pub(crate) struct PageTableEntry {
    bits: usize,                     // PTE 原始位
}
```

**PTE 标志位**（架构无关抽象）：
```rust
pub(crate) struct PTEFlags: u8 {
    const V = 1 << 0;   // Valid
    const R = 1 << 1;   // Readable
    const W = 1 << 2;   // Writable
    const X = 1 << 3;   // Executable
    const U = 1 << 4;   // User-accessible
    const G = 1 << 5;   // Global
    const A = 1 << 6;   // Accessed
    const D = 1 << 7;   // Dirty
}
```

**核心功能**：
- `walk_leaf()`: 遍历页表找到叶子 PTE 及其层级
- `find_pte_create()`: 按需创建中间页表节点
- `map()`/`unmap()`: 4KB 页映射/解映射
- `map_huge()`/`unmap_huge()`: 2MB/1GB 大页映射/解映射
- `attach_kernel_root_entries_from()`: RISC-V 上共享内核高半地址映射（复制根级 PTE）
- **Copy-on-Write 支持**：通过软件位 `pte_cow_bit()` 标记 CoW 页面

#### 3.3.3 地址空间 (`memory_set.rs`, ~6,228 行 — 最大单文件之一)

**核心结构**：

```rust
pub(crate) struct MemorySet {
    page_table: PageTable,
    areas: Vec<MapArea>,                  // 用户 VMA 列表
    kernel_areas: Vec<MapArea>,           // 内核 VMA 列表
    // ...
}
```

**支持的用户 VMA 类型** (`UserVmaKind`)：
- `Anonymous`: 匿名映射（堆、栈、mmap 匿名）
- `FileBacked { path, offset, is_private }`: 文件支持映射
- `LazyMmap`: 延迟 mmap（按需分配页面）
- `SysvShm { shmid, page_offset }`: System V 共享内存映射
- `MemFd { ... }`: memfd 创建的匿名文件映射

**页面故障处理** (`check_fault`):
1. 查找对应 VMA
2. 根据 VMA 类型分配/加载页面：
   - **CoW 页面**：复制原页面内容到新分配的帧
   - **文件映射**：通过 EXT4 页缓存加载
   - **共享文件 mmap**：通过全局 `SHARED_FILE_MMAP_PAGES` 维护跨进程共享页面
   - **共享匿名 mmap**：通过 `SHARED_ANON_MMAP_PAGES` 跟踪
   - **延迟 mmap**：首次访问时清零分配
3. 返回 `PageFaultResult::{Handled, Bus, Poisoned, Oom}`

**mmap 实现** (`map` 方法)：
- 支持 `MAP_SHARED`, `MAP_PRIVATE`, `MAP_ANONYMOUS`, `MAP_FIXED`, `MAP_FIXED_NOREPLACE`
- 支持 `MAP_HUGETLB` 大页
- 支持 `MAP_LOCKED` 锁定页面
- 文件映射支持页缓存集成

**fork 支持** (`from_existed_user`)：
- 通过 CoW 机制实现：将父进程的所有可写页面标记为 CoW
- 共享文件映射保持不变（增加引用计数）
- 共享匿名映射增加引用计数
- 实现了 fork 性能分析（feature gate: `fork_profile`）

**其他内存操作**：
- `mprotect`: 修改 VMA 保护位
- `mremap`: 重新映射（支持 `MREMAP_MAYMOVE`, `MREMAP_FIXED`, `MREMAP_DONTUNMAP`）
- `munmap`: 解映射并释放页面
- `madvise`: 内存建议（`MADV_DONTNEED` 等）
- `mlock`/`munlock`/`mlockall`/`munlockall`: 内存锁定
- `msync`: 同步文件映射
- `mincore`: 查询页面是否在内存中
- `dumpable_private_anon_ranges`: 用于生成 core dump

#### 3.3.4 映射区域 (`map_area.rs`, ~310 行)

**`MapArea` 结构**：
```rust
pub(super) struct MapArea {
    pub(super) vpn_range: VPNRange,
    pub(super) data_frames: BTreeMap<VirtPageNum, FrameTracker>,   // 4KB 帧
    pub(super) huge_pages: BTreeMap<VirtPageNum, (PhysPageNum, PageSizeKind)>, // 大页
    pub(super) user_huge_allowed: bool,
    pub(super) map_type: MapType,
    pub(super) map_perm: MapPermission,
}
```

**大页自动降级策略**：
- 至少连续 2 个 2MB 大页（1024 个 4KB 页）才考虑使用 `Size2M`
- 至少连续 2 个 1GB 巨页才考虑使用 `Size1G`
- 无法满足大页对齐要求时自动降级为 4KB 页

**映射类型**：
- `MapType::Identical`: 直接等同映射（VPN = PPN，用于内核）
- `MapType::Framed`: 通过帧分配器分配物理页

#### 3.3.5 堆分配器 (`heap_allocator.rs`, ~320 行)

**实现**：
- 基于 `buddy_system_allocator::LockedHeap` 作为底层全局分配器
- **Slab 缓存系统**：为 `TaskControlBlock` 和 `OSInode` 两种高频分配类型实现了专用 slab 缓存
  - 每种缓存限制可配置数量（TCB: 128, Inode: 512）
  - 释放时优先回收到 slab 缓存（hit/miss 统计）
- 支持 slab 统计输出用于内存泄漏诊断

#### 3.3.6 进程地址空间 (`mm.rs`, ~285 行)

```rust
pub(crate) struct Mm {
    memory_set: Arc<UPSafeCell<MemorySet>>,
    activation: MmActivation,
    program_brk: usize,
}
```

- `MmActivation` 包含用户态 token（`satp`/`pgdl`）和内核态 token
- RISC-V 使用 `AddressSpaceActivation::Single`
- LoongArch 使用 `AddressSpaceActivation::Split { user_root, kernel_root }`
- `fork_from()` 实现 fork 的地址空间克隆

#### 3.3.7 内核地址空间 (`kernel_space.rs`, ~384 行)

- 通过链接脚本导出的符号 (`stext`, `etext`, `srodata`, `sbss`, `ekernel` 等) 建立内核映射
- 管理内核栈分配（每个栈有 guard page）
- 支持 VMAP 区域的内核栈延迟回收

#### 3.3.8 MM 子系统完整度评估

| 功能 | 完整度 | 说明 |
|---|---|---|
| 物理页帧分配 | 完整 | 伙伴系统 + 大页/巨页支持 + 缓存池 |
| Sv39 页表 | 完整 | 3 级页表，含大页映射 |
| LA39 页表 | 完整 | 3 级页表 + TLB 重填 |
| CoW | 完整 | fork 时标记 + 页面故障时复制 |
| mmap | 完整 | MAP_SHARED/PRIVATE/ANONYMOUS/FIXED/HUGETLB/LOCKED |
| 按需分页 | 完整 | LazyMmap + 文件映射按需加载 |
| 大页支持 | 完整 | 2MB + 1GB，自动选择最优粒度 |
| mprotect/mremap/munmap | 完整 | 含 MREMAP_FIXED/DONTUNMAP |
| mlock/mlockall | 完整 | 含 MLOCK_ONFAULT |
| 堆管理 | 完整 | buddy allocator + slab 缓存 |
| 内核地址空间 | 完整 | 符号映射 + 内核栈管理 |

---

### 3.4 进程与调度子系统

#### 3.4.1 任务控制块 (`task/task.rs`, ~2,080 行)

**`TaskControlBlock` 结构**：

```rust
pub(crate) struct TaskControlBlock {
    // 不可变字段
    pub pid: PidHandle,
    pub cached_tgid: AtomicUsize,      // 线程组 ID
    pub cached_ppid: AtomicUsize,      // 父进程 ID
    pub kernel_stack: KernelStack,

    // 可变字段（受 UPSafeCell 保护）
    inner: UPSafeCell<TaskControlBlockInner>,
}
```

**`TaskControlBlockInner` 包含**（非完整列表）：
- `task_status: TaskStatus` — Ready/Running/Sleeping/Waking/Zombie
- `mm: Arc<UPSafeCell<Mm>>` — 地址空间
- `fd_table: Vec<Option<Arc<dyn File>>>` — 文件描述符表
- `fd_cloexec: Vec<bool>` — close-on-exec 标志
- `shared_files: Option<Arc<UPSafeCell<SharedFileTable>>>` — 线程组共享文件表
- `shared_fs: Option<Arc<UPSafeCell<SharedFsState>>>` — 线程组共享 FS 状态（cwd, root）
- `sig_manager: SignalManager` — 信号管理器
- `cwd: String` — 当前工作目录
- `fs_root: String` — 文件系统根
- `euid/egid/uid/gid/saved_uid/saved_gid/suid/sgid: u32` — 凭证
- `umask: u32` — 文件创建掩码
- `rlimits: [RLimit; 16]` — 资源限制
- `children: Vec<Weak<TaskControlBlock>>` — 子进程列表
- `parent: Option<Weak<TaskControlBlock>>` — 父进程
- `priority: isize` — 调度优先级
- `sched_policy: i32` — SCHED_OTHER/FIFO/RR
- `cpu_time_us: usize` — CPU 时间统计
- `itimer_real_*` — 实时定时器
- `netns: Arc<UPSafeCell<NetNamespaceState>>` — 网络命名空间
- `ipc_ns: Arc<UPSafeCell<IpcNamespaceState>>` — IPC 命名空间
- `mount_ns_id: usize` — 挂载命名空间 ID
- `time_ns_offsets: TimeNamespaceOffsets` — 时间命名空间偏移
- `dumpable: bool` — 是否可生成 core dump
- `in_signal_handler: bool` — 是否正在执行信号处理
- `saved_signal_trap_cx` — 信号处理前保存的 trap 上下文

**关键实现**：
- 文件描述符和 FS 状态通过 `shared_files`/`shared_fs` 支持线程组共享（clone 时）
- `sync_files_from_shared()`/`publish_fs_to_shared()` 实现懒同步
- `unshare_files()` 用于命名空间隔离
- 实现了 `RLIMIT_NOFILE`（默认 1024）和 `RLIMIT_MEMLOCK`（默认 8MB）资源限制
- 支持完整的能力集 (`CAP_FULL_LOWER`/`CAP_FULL_UPPER`)

#### 3.4.2 调度器

**多层调度架构**：

1. **`TaskManager`** (`task/manager.rs`): 全局就绪队列，基于优先级的调度：
   ```rust
   pub(crate) fn fetch(&mut self) -> Option<Arc<TaskControlBlock>> {
       // 遍历 VecDeque，选择最高优先级的非睡眠/僵尸任务
   }
   ```

2. **`Processor`** (`processor/processor.rs`): 每 CPU 的处理器结构，维护：
   - 当前正在运行的任务
   - 本 CPU 的任务队列和负载跟踪器
   - 轮询 PID 追踪

3. **`CoroutineUnit`** (`processor/coroutine.rs`): 将任务包装为 Future，实现协作式调度：
   ```rust
   impl Future for CoroutineUnit {
       fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<usize> {
           // 运行一个时间片的任务
           // 如果任务变为睡眠/唤醒/僵尸状态，返回 Poll::Ready
           // 否则返回 Poll::Pending 并重新唤醒 waker
       }
   }
   ```

4. **PELT 负载跟踪** (`processor/schedule.rs`): 简化的 Linux PELT 模型：
   - 32 段衰减表 (`DECLINE_TABLE`)
   - 每 CPU 维护 `load_sum` 和 `load_avg`
   - 负载均衡阈值：`max_load - min_load > 10` 时触发迁移

5. **SMP 支持** (feature gate: `smp`):
   - 最多 4 个 CPU（`MAX_PROCESSORS`）
   - 轮询式队列选择 (`select_run_queue_index`)
   - 在线 CPU 掩码管理
   - 任务迁移 (`migrate_one_task`)

**调度策略**：
- 支持 `SCHED_OTHER`（默认）、`SCHED_FIFO`、`SCHED_RR`
- 优先级越高越先调度
- 协作式时间片：每个任务运行一个时间片后主动让出

#### 3.4.3 进程管理 (`mission/mod.rs`, ~2,366 行)

**核心功能**：
- `add_task()`: 注册任务到全局注册表 + 加入就绪队列
- `add_initproc()`: 加载并启动 init 进程（路径由 HAL ABI 提供）
- `suspend_current_and_run_next()`: 挂起当前任务并调度下一个
- `exit_current_and_run_next()`: 退出当前任务并调度下一个
- `find_task_by_pid()`: 通过 PID 查找任务
- `request_exit_group()`: 向线程组所有线程发送退出请求
- `wait4_add_waiter()`/`wait4_remove_waiter()`: wait4 等待队列管理
- LTP 诊断支持：槽位记录 LTP 测试用例信息

#### 3.4.4 子系统完整度评估

| 功能 | 完整度 | 说明 |
|---|---|---|
| 进程创建 (fork/clone) | 完整 | CoW fork + clone 标志支持 |
| 线程支持 | 完整 | 共享文件表/FS/mm 的 clone |
| 进程退出 | 完整 | exit + exit_group + 僵尸回收 |
| 等待队列 | 完整 | wait4/waitid 支持 |
| execve | 完整 | ELF 加载 + 解释器支持 |
| 调度器 | 完整 | 优先级 + PELT 负载均衡 |
| SMP | 完整 | 最多 4 核支持 |
| 命名空间 | 部分 | 网络/挂载/IPC/时间命名空间基础支持 |

---

### 3.5 文件系统子系统 (FS)

#### 3.5.1 VFS 抽象 (`fs/mod.rs`, ~378 行 + 各文件实现)

**`File` trait**（核心 VFS 接口）：

```rust
pub(crate) trait File: Send + Sync {
    fn readable(&self) -> bool;
    fn writable(&self) -> bool;
    fn read(&self, buf: UserBuffer) -> usize;
    fn write(&self, buf: UserBuffer) -> usize;
    fn seek(&self, offset: isize, whence: usize) -> Option<usize>;
    fn read_at(&self, offset: usize, buf: UserBuffer) -> Option<usize>;
    fn write_at(&self, offset: usize, buf: UserBuffer) -> Option<usize>;
    fn on_dup(&self) {}
    fn on_close(&self) {}
    fn flush(&self) -> bool { true }
    fn path(&self) -> Option<String> { None }
    fn stat(&self) -> Option<Stat> { None }
    fn poll_readable(&self) -> bool { ... }
    fn poll_writable(&self) -> bool { ... }
    fn as_any(&self) -> &dyn Any;
}
```

**`Stat` 结构**（Linux 兼容）：
```rust
pub(crate) struct Stat {
    pub dev: u64, pub ino: u64, pub mode: StatMode,
    pub nlink: u32, pub uid: u32, pub gid: u32,
    pub rdev: u64, pub size: i64, pub blksize: i64, pub blocks: i64,
    pub atime: ... , pub mtime: ... , pub ctime: ...
}
```

#### 3.5.2 文件类型实现

| 文件类型 | 源文件 | 行数 | 说明 |
|---|---|---|---|
| EXT4 文件系统 | `ext4.rs` | 1,842 | 基于 lwext4 C 库的完整 EXT4 实现 |
| 管道 | `pipe.rs` | 934 | 匿名管道 + 命名管道 (FIFO) |
| stdio | `stdio.rs` | 3,157 | stdin/stdout/stderr + 伪文件 |
| inode 管理 | `inode.rs` | 743 | OSInode 的 inode 操作 |
| epoll | `epoll.rs` | 236 | epoll_create1/epoll_ctl/epoll_wait |
| eventfd | `eventfd.rs` | 127 | eventfd 创建/读写/poll |

#### 3.5.3 EXT4 实现 (`fs/ext4.rs`, ~1,842 行)

**架构**：
- 底层使用 `lwext4_rust` crate（封装 C 库 `lwext4`）
- 通过 `Disk` 结构实现 `KernelDevOp` trait，桥接 `BlockDevice` 驱动
- 自动检测 MBR 分区表，定位 EXT4 分区起始 LBA
- 页缓存系统：
  - 容量 2048 页 (`EXT4_PAGE_CACHE_CAPACITY`)
  - 元数据缓存 512 页
  - 读预取最大 8 页 (`EXT4_READAHEAD_MAX_PAGES`)
  - exec 预取 12 页 (`EXT4_EXEC_PREFETCH_PAGES`)
  - 读写合并：读 64KB，写 256KB
- 支持扩展属性 (xattr)：`setxattr`, `getxattr`, `listxattr`, `removexattr`
- 路径查询缓存 (`Ext4PathMetadata`)

**文件操作**：
- `ext4_read_at`/`ext4_write_at`: 偏移读写
- `ext4_size`/`ext4_truncate`: 文件大小操作
- `ext4_exists`/`ext4_is_dir`/`ext4_link`/`ext4_symlink`/`ext4_readlink`
- `ext4_rename`: 重命名
- `ext4_sync`: 同步到磁盘

#### 3.5.4 管道 (`fs/pipe.rs`, ~934 行)

**实现细节**：
- 环形缓冲区：`PipeRingBuffer` 基于 `VecDeque<PipePageRef>`，总容量 64KB
- 每页 4KB (`PIPE_PAGE_SIZE`)
- 使用 `Arc<[u8; 4096]>` 作为页面存储，避免复制
- 读写阻塞/非阻塞模式（支持 `O_NONBLOCK`）
- 命名管道 (FIFO)：通过全局 `NAMED_PIPES` 注册表管理

#### 3.5.5 stdio 与伪文件 (`fs/stdio.rs`, ~3,157 行)

**实现的大量伪文件类型**：
- `Stdin`/`Stdout`: 标准输入输出
- `NullFile`: `/dev/null`
- `ZeroFile`: `/dev/zero`
- `RandomFile`: `/dev/random`, `/dev/urandom`
- `KmsgFile`: `/dev/kmsg`
- `TmpRamFile`: 内存临时文件（支持 `/tmp`）
- `PathFile`: O_PATH 文件描述符
- `PseudoFile`: 伪文件系统文件（如 `/proc`, `/sys`）
- `VirtualDirFile`: 虚拟目录
- `VirtualConfigFile`: 虚拟配置文件
- `MountTreeFile`/`MountTreeState`: 挂载树管理
- `FsContextFile`/`FsContextState`: FS 上下文（用于新的 mount API）
- `LoopDeviceFile`/`LoopControlFile`: loop 设备
- `MemFile`: memfd 文件
- `SocketFile`: socket 文件
- `RtcFile`: RTC 设备
- `EventFdFile`: eventfd
- `EpollFile`: epoll
- `PidFdFile`: pidfd

#### 3.5.6 文件锁 (`flock`)

通过全局 `FLOCK_REFS` 注册表实现 POSIX 文件锁：
- `LOCK_SH`: 共享锁
- `LOCK_EX`: 排他锁
- `LOCK_UN`: 解锁
- `LOCK_NB`: 非阻塞模式
- 锁所有者通过 `owner` (文件描述 ID) 标识

---

### 3.6 系统调用子系统

#### 3.6.1 系统调用总览

**已实现的系统调用数量**：约 **200+** 个（从 `syscall/mod.rs` 的 match 分发表不完全统计）

**按功能分类**：

| 类别 | 数量（约） | 关键系统调用 |
|---|---|---|
| 文件 IO | 50+ | read, write, readv, writev, pread64, pwrite64, openat, close, lseek, sendfile, splice, copy_file_range, dup, dup3, fcntl, ioctl |
| 文件系统元数据 | 30+ | stat/fstat/fstatat/statx, linkat, unlinkat, symlinkat, readlinkat, renameat, mkdirat, mknodat, chdir, fchdir, getcwd, mount, umount2, chroot, faccessat, truncate, ftruncate, fallocate, getdents64 |
| 扩展属性 | 12 | setxattr, lsetxattr, fsetxattr, getxattr, lgetxattr, fgetxattr, listxattr, llistxattr, flistxattr, removexattr, lremovexattr, fremovexattr |
| 进程管理 | 25+ | clone, execve, execveat, exit, exit_group, waitid, waitpid, fork (通过clone), getpid, getppid, gettid, getuid, geteuid, getgid, getegid, setuid, setgid, setreuid, setregid, setresuid, setresgid, getgroups, setgroups, prctl, capget, capset, unshare, setns |
| 内存管理 | 15+ | mmap, munmap, mprotect, mremap, brk, madvise, mlock, munlock, mlock2, mlockall, munlockall, msync, mincore, memfd_create, userfaultfd |
| 信号 | 8 | kill, tkill, tgkill, rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigsuspend, rt_sigtimedwait, rt_sigreturn |
| 定时器 | 15+ | nanosleep, clock_gettime, clock_settime, clock_getres, clock_nanosleep, timer_create, timer_settime, timer_gettime, timer_delete, timerfd_create, timerfd_settime, timerfd_gettime, getitimer, setitimer, clock_adjtime |
| 网络 | 18+ | socket, bind, listen, accept, accept4, connect, sendto, recvfrom, sendmsg, recvmsg, getsockname, getpeername, setsockopt, getsockopt, shutdown, socketpair, pselect6, ppoll |
| IPC | 6 | msgget, msgctl, msgsnd, msgrcv, shmget, shmctl, shmat, shmdt |
| eBPF | 1 | bpf (PROG_LOAD + MAP_CREATE/LOOKUP/UPDATE) |
| Key 管理 | 3 | add_key, request_key, keyctl |
| 调度 | 10+ | sched_setparam, sched_getparam, sched_setscheduler, sched_getscheduler, sched_setaffinity, sched_getaffinity, sched_yield, getpriority, setpriority |
| 系统 | 15+ | sysinfo, syslog, reboot, personality, getrandom, uname, sethostname, getrusage, prlimit64, kcmp, membarrier |
| epoll/eventfd | 6 | epoll_create1, epoll_ctl, epoll_pwait, epoll_pwait2, eventfd2, signalfd4 |
| 其他 | 10+ | io_uring_setup, fanotify_init, pidfd_open, pidfd_send_signal, open_tree, fsopen, fsconfig, fsmount, fspick, move_mount, openat2 |

#### 3.6.2 syscall 分发机制 (`syscall/mod.rs`)

```rust
pub fn syscall(syscall_id: usize, args: [usize; 6]) -> isize {
    // 1. 记录最后系统调用快照（PID + ID + args）
    // 2. 通过 match syscall_id 分发到具体处理函数
    // 3. 每个处理函数返回 isize
}
```

- syscall 号使用 Linux RISC-V 64 位 ABI 约定
- 分发通过巨大的 `match` 语句完成（约 650 行）
- 支持 syscall 性能分析（feature gate: `syscall_profile`, `syscall_list_profile`）
- `sys_temp()` 辅助函数处理未实现的 syscall（仅记录日志并返回 0）

#### 3.6.3 文件系统 syscall (`syscall/fs.rs`, ~12,914 行 — 最大单文件)

**这是项目中最大的源文件**，包含了几乎所有的文件系统和文件 IO 系统调用的完整实现。主要内容：
- 路径解析与规范化（处理 `cwd`、`fs_root`、AT_FDCWD 等）
- 文件描述符管理（分配、释放、close-on-exec）
- 完整的 read/write/readv/writev 实现（含跨页边界处理）
- poll/select 支持
- mount/umount 树管理
- loop 设备管理
- memfd 密封 (seals) 支持
- cgroup 内存计费集成

#### 3.6.4 进程 syscall (`syscall/process.rs`, ~4,955 行)

**关键实现**：
- `sys_clone`: 完整实现 Linux clone 的 20+ 标志位（CLONE_VM, CLONE_FILES, CLONE_FS, CLONE_SIGHAND, CLONE_THREAD, CLONE_NEWNS, CLONE_NEWNET, CLONE_NEWIPC 等）
- `sys_execve`: ELF 加载（支持静态和动态链接，通过解释器路径加载）
- `sys_waitid`/`sys_waitpid`: 进程等待，含 WNOHANG/WUNTRACED/WEXITED
- `sys_futex`: 完整的 futex 实现（FUTEX_WAIT/FUTEX_WAKE/FUTEX_REQUEUE/FUTEX_CMP_REQUEUE）
- `sys_prctl`: PR_SET_NAME/PR_GET_NAME/PR_SET_DUMPABLE/PR_SET_SECCOMP 等
- 资源限制管理 (prlimit64)

#### 3.6.5 网络 syscall (`syscall/net.rs`, ~1,578 行)

实现了完整的 socket 系统调用族，底层由 `net/mod.rs` 的内核内网络栈支持。

#### 3.6.6 eBPF syscall (`syscall/bpf.rs`, ~884 行)

**支持的程序类型**：
- `BPF_PROG_TYPE_SOCKET_FILTER`: 用于包过滤测试

**支持的 map 类型**：
- `BPF_MAP_TYPE_ARRAY`
- `BPF_MAP_TYPE_RINGBUF`

**实现的 eBPF 指令解释器**（软件 VM）：
- ALU64 指令：ADD, SUB, MUL, DIV, LSH, RSH, MOD, MOV
- 内存指令：LD, LDX, ST, STX
- 跳转指令：JEQ, JNE, CALL, EXIT
- 辅助函数调用：`BPF_FUNC_MAP_LOOKUP_ELEM`, `BPF_FUNC_RINGBUF_RESERVE/SUBMIT/DISCARD`
- 10 个通用寄存器 + 栈 (512 字节)

---

### 3.7 网络子系统 (`net/mod.rs`, ~1,980 行)

**实现范围**：内核内最小化网络栈，主要用于支持 LTP 网络测试。

**支持的协议/功能**：
- **AF_UNIX** (UNIX domain sockets):
  - `SOCK_STREAM`: 完整的 TCP-like 流式 socket
  - `SOCK_DGRAM`: 数据报 socket
  - 文件系统路径名和抽象命名空间地址
  - listen/accept/connect 三路握手
  - 背压控制 (`STREAM_RECVQ_LIMIT = 4MB`)
- **AF_INET/AF_INET6** (IPv4/6):
  - 仅支持 loopback (`127.0.0.1`)
  - `SOCK_STREAM` 流式 socket
  - `SOCK_DGRAM` 数据报
- **Netlink** (`AF_NETLINK`):
  - `NETLINK_ROUTE`: RTM_GETLINK/RTM_NEWLINK/RTM_GETADDR/RTM_NEWADDR
  - `NETLINK_CRYPTO`: CRYPTO_MSG_GETALG 等
  - 用于支持 iproute2/ss 等工具的查询
- **Loopback 接口**：`ARPHRD_LOOPBACK` 类型，`LOOPBACK_IFFLAGS` (UP|LOOPBACK|RUNNING)
- **netperf 控制端口** (12865) 的 raw 数据通路

---

### 3.8 IPC 子系统 (`ipc/sysv.rs`, ~1,290 行)

**System V IPC 实现**：

1. **共享内存 (SHM)**:
   - `shmget`: 创建/获取共享内存段（key 或 IPC_PRIVATE）
   - `shmat`: 附加到进程地址空间
   - `shmdt`: 分离
   - `shmctl`: IPC_STAT/IPC_SET/IPC_RMID/SHM_LOCK/SHM_UNLOCK
   - 物理页按需分配（`ShmObj::get_or_alloc_ppn`）
   - 权限检查：所有者/组/其他 + 超级用户旁路

2. **消息队列 (MSG)**:
   - `msgget`: 创建/获取消息队列
   - `msgsnd`: 发送消息（支持 `MSG_NOERROR`）
   - `msgrcv`: 接收消息（支持 `MSG_EXCEPT`, `MSG_COPY`, `IPC_NOWAIT`）
   - `msgctl`: IPC_STAT/IPC_SET/IPC_RMID/IPC_INFO/MSG_INFO
   - 消息大小和队列容量可调（默认 `MSGMAX=8192`, `MSGMNB=16384`）

3. **信号量 (SEM)**:
   - `semget`: 创建/获取信号量集合
   - `semop`: P/V 操作
   - `semctl`: GETVAL/SETVAL/GETALL/SETALL/IPC_RMID 等
   - 支持 `SEM_UNDO` 机制（进程退出时自动恢复）

**IPC 命名空间**：支持独立的 IPC 命名空间（通过 `IpcNamespaceState`）。

**兼容性数据结构**：`IpcPerm`, `ShmIdDs`, `MsgIdDs`, `MsgInfo` 等结构均按 Linux glibc 64 位 ABI 布局。

---

### 3.9 信号子系统 (`signal/`, ~560 行)

#### 3.9.1 信号管理 (`signal/manager.rs` + `action.rs` + `handler.rs` + `msg_queue.rs`)

**支持的信号范围**：`1..=SIGRTMAX (64)`，含标准信号 (1-31) 和实时信号 (SIGRTMIN=32..64)

**核心特性**：
- 标准信号去重（同一 signo 只保留一个挂起实例）
- 实时信号排队 (`BTreeMap<usize, VecDeque<SigInfo>>`)
- `SigAction` 结构兼容 Linux ABI（`sa_handler`, `sa_flags`, `sa_restorer`, `sa_mask`）
- 支持 `SA_SIGINFO`, `SA_RESTART`, `SA_NODEFER`, `SA_RESETHAND`, `SA_RESTORER`
- 信号阻塞掩码 (`SigSet`)
- `SIGKILL`/`SIGSTOP` 不可被阻塞/忽略/捕获

**信号递送** (`handler.rs`):
1. 从挂起队列出队一个可递送信号
2. 检查动作：`SIG_DFL` → 默认终止；`SIG_IGN` → 忽略
3. 用户态处理：设置 trap 上下文，将 `sepc` 指向处理函数，`ra` 指向 trampoline
4. 如果设置了 `SA_SIGINFO`，在用户栈上构造 `UserSigInfo` 帧
5. `rt_sigreturn` 恢复保存的 trap 上下文

**Core Dump**：实现了最小化 core dump（将私有匿名页写入 `/tmp/core.<pid>` 临时 RAM 文件）。

---

### 3.10 eBPF 子系统 (`syscall/bpf.rs`, ~884 行)

**实现的 eBPF 虚拟机**：

- **指令集**：支持 eBPF 基础指令（64位ALU、内存存取、跳转、函数调用、退出）
- **寄存器**：10 个 64 位通用寄存器（R0-R9）+ R10 栈指针
- **栈**：512 字节（从 `0x1000_0000` 向下增长）
- **Map 实现**：
  - `BPF_MAP_TYPE_ARRAY`：预分配数组
  - `BPF_MAP_TYPE_RINGBUF`：环形缓冲区（支持 reserve/submit/discard 语义）
- **验证器**：实现了基本验证（指令数、跳转目标、除法零检查等）
- **Socket Filter**：通过 `run_bpf_socket_filter()` 在接收路径上执行 BPF 程序

---

### 3.11 Key 管理子系统 (`syscall/key.rs`, ~1,417 行)

**实现了 Linux keyctl 子集**：

- **keyring 类型**：thread keyring, process keyring, session keyring, user keyring, user session keyring
- **key 类型**：`user` 类型（用户自定义键值）
- **支持的操作**：
  - `KEYCTL_GET_KEYRING_ID`: 获取 keyring ID
  - `KEYCTL_JOIN_SESSION_KEYRING`: 加入会话 keyring
  - `KEYCTL_UPDATE`: 更新 key
  - `KEYCTL_REVOKE`: 撤销 key
  - `KEYCTL_SETPERM`: 设置权限
  - `KEYCTL_CLEAR`: 清空 keyring
  - `KEYCTL_UNLINK`: 从 keyring 移除
  - `KEYCTL_READ`: 读取 key 载荷
  - `KEYCTL_SET_TIMEOUT`: 设置超时
  - `KEYCTL_INVALIDATE`: 标记无效
- **权限模型**：POSIX 风格（owner/group/other × view/read/write/search/link/setattr）
- **key 序列号**：全局递增分配

---

### 3.12 驱动子系统 (`drivers/`)

#### 3.12.1 VirtIO 块设备 (`drivers/block/virtio_blk.rs`, ~206 行)

- 基于 `virtio-drivers` crate 的 `VirtIOBlk` 驱动
- 实现 `BlockDevice` trait（`read_block`, `write_block`, `read_blocks`, `write_blocks`, `total_blocks`）
- DMA 缓冲区管理：
  - 使用帧分配器分配连续物理页
  - shared buffer 机制处理非对齐传输（bounce buffer）
  - 最大单次传输 4096 字节（`VIRTIO_SHARED_BUFFER_LIMIT`）
- 批量读写支持（`read_blocks`/`write_blocks`），自动分块

#### 3.12.2 块设备抽象 (`drivers/block/mod.rs`)

- `BlockDevice` trait 定义块设备接口
- 全局 `BLOCK_DEVICE` 静态变量
- 块 IO 统计（batch count）

---

### 3.13 同步原语 (`sync/`)

#### 3.13.1 自旋锁 (`sync/spin.rs`, ~70 行)

```rust
pub struct SpinMutex<T> {
    locked: AtomicBool,
    inner: UnsafeCell<T>,
}
```

- 基于 `AtomicBool` 的 CAS 自旋锁
- 返回 `SpinMutexGuard` 实现 RAII
- 标记为 `Send + Sync`

#### 3.13.2 UPSafeCell (`sync/up.rs`, ~70 行)

- 单处理器环境下的 `UnsafeCell` 包装器
- 提供 `exclusive_access()` 和 `try_exclusive_access()` 方法
- 用于所有内核全局状态和进程内部可变状态

---

### 3.14 第三方依赖关系

#### 3.14.1 `third_party/ext4fs` (lwext4_rust)

- 封装 C 库 `lwext4`（轻量级 EXT2/3/4 文件系统实现）
- 提供 `Ext4File`, `Ext4BlockWrapper`, `InodeTypes` 等类型
- 通过 `build.rs` 编译 C 代码
- 内核通过 `Disk` 适配器 (`KernelDevOp`) 桥接

#### 3.14.2 `vendor/riscv`

- 本地 fork 的 `riscv` crate
- 提供 RISC-V CSR 寄存器的类型安全访问（`sstatus`, `sepc`, `stvec`, `satp`, `scause`, `stval` 等）
- 包含分页帧分配和多级页表操作

#### 3.14.3 `third_party/loongarch64-glibc`

- LoongArch 架构的 glibc 动态链接器（`ld-linux-loongarch-lp64d.so.1`）
- 在制作磁盘镜像时注入到 `/lib64/`

---

## 四、内核各子系统间交互

### 4.1 系统调用路径

```
用户程序 (U-mode)
  │ ecall
  ▼
Trap 汇编入口 (__alltraps / __trap_from_user)
  │ 保存上下文
  ▼
trap_handler() [os/src/trap/mod.rs]
  │ 分类异常类型
  ▼
syscall(syscall_id, args) [os/src/syscall/mod.rs]
  │ 分发到具体处理函数
  ▼
sys_xxx() [os/src/syscall/{fs,process,net,mm,signal,time,ipc,key,bpf}.rs]
  │ 可能涉及：
  ├── MM: 地址翻译、页面故障处理
  ├── FS: 文件读写、路径解析
  ├── Task: 进程创建/销毁、调度
  ├── Signal: 信号递送
  ├── Net: socket 操作
  └── IPC: SysV 操作
```

### 4.2 页面故障处理路径

```
用户程序触发页面故障
  │ 硬件异常
  ▼
trap_handler() → TrapType::*PageFault
  │ 获取 bad_addr
  ▼
current_task().mm.check_fault(VirtAddr, is_store, is_exec)
  │
  ├── CoW 页面 → 分配新帧 + 复制内容 + 更新 PTE
  ├── 文件映射 → ext4_page_cache_get_page_ref + 加载
  ├── 共享文件 mmap → SHARED_FILE_MMAP_PAGES 查找/加载
  ├── 延迟 mmap → frame_alloc + 清零
  └── 无效 → 发送 SIGSEGV/SIGBUS
```

### 4.3 fork 路径

```
sys_clone()
  │
  ├── MemorySet::from_existed_user() — CoW 克隆
  │   ├── 将可写页面标记为 CoW
  │   ├── 共享文件映射保持
  │   └── 复制内核 VMA
  ├── TaskControlBlock::fork_from() — 复制 TCB
  │   ├── 复制文件描述符表（或共享）
  │   ├── 复制 FS 状态（或共享）
  │   ├── 复制信号管理器（清空挂起队列）
  │   └── 复制命名空间状态
  └── 子进程进入就绪队列
```

### 4.4 时钟中断与调度路径

```
时钟中断
  │ Trap
  ▼
trap_handler() → TrapType::Timer
  │
  ├── set_next_trigger() — 设置下次时钟中断
  ├── wake_timed_waiters_at() — 唤醒超时等待者
  ├── enqueue_current_itimer_real_signal_if_needed()
  └── schedule() — 可能触发任务切换
      │
      ├── 保存当前任务上下文
      ├── fetch_task() — 获取下一任务
      └── __switch() — 上下文切换
```

---

## 五、内核整体实现完整度

### 5.1 完整度评估矩阵

| 子系统 | 完整度 | 评分依据 |
|---|---|---|
| 内存管理 | 90% | 完整的虚拟内存、CoW、mmap、大页；缺：KSM、NUMA、swap |
| 进程管理 | 85% | 完整的 fork/clone/exec/exit/wait；缺：cgroup v2 完整、autogroup |
| 文件系统 | 80% | EXT4 完整 + VFS 框架完善；缺：procfs/sysfs 完整、其他 FS 类型 |
| 网络 | 55% | loopback + AF_UNIX 完整；缺：真实网卡驱动、TCP/IP 协议栈 |
| 信号 | 85% | POSIX 信号完整；缺：siginfo 传递部分细节 |
| IPC | 80% | SysV 三件套完整；缺：POSIX 消息队列部分细节 |
| 调度 | 75% | 优先级 + PELT + SMP；缺：CFS、cgroup 调度 |
| 同步 | 70% | 自旋锁 + UPSafeCell；缺：RCU、读写锁、信号量 |
| 系统调用 | 85% | 200+ syscall 覆盖主要 Linux ABI |
| 驱动 | 40% | 仅 VirtIO 块设备；缺：网络、显示、USB 等 |
| eBPF | 30% | 最小化 socket filter；缺：verifier、JIT、更多程序类型 |
| Key 管理 | 50% | 基础 keyring/key 操作 |

**总体估计完整度**：约 **70-75%**（相对于 Linux 内核参考，基于大学生 OS 比赛上下文）

### 5.2 已知限制

- **无真实网络协议栈**：仅支持 loopback
- **无多用户完整隔离**：uid/gid 基本支持但无完整 DAC/MAC
- **设备驱动极度有限**：仅 VirtIO 块设备
- **单地址空间模型**：虽然支持 fork CoW，但不支持 KSM/page sharing 优化
- **无电源管理**
- **无安全模块**（LSM 框架）

---

## 六、设计创新性分析

### 6.1 创新点

1. **双架构 HAL 抽象**：通过统一的 trait 接口 + 条件编译实现 RISC-V 和 LoongArch 双架构支持，架构差异对内核主体完全透明。这种在 Rust 中使用 trait 做 HAL 的设计模式在参赛项目中较为成熟。

2. **基于 Future 的协作式调度**：将 `TaskControlBlock` 包装为 `CoroutineUnit`（实现 `Future` trait），利用 Rust 异步原语进行任务调度。这是较为新颖的设计——大多数教学内核使用传统的就绪队列 + 时钟中断抢占调度。

3. **简化的 PELT 负载均衡**：实现了 Linux CFS 调度器中使用的 PELT (Per-Entity Load Tracking) 算法的简化版本，包括 32 段衰减表和跨 CPU 负载迁移。

4. **EXT4 页缓存系统**：在 lwext4 C 库之上构建了 Rust 层的页缓存（2048 页容量）、元数据缓存、预取和读写合并机制。

5. **软件 eBPF 解释器**：在无 JIT 支持的情况下实现了完整的 eBPF 指令解释器，支持 socket filter 程序和 ringbuf map。

6. **丰富的 LTP 诊断基础设施**：整个内核散布了大量 `#[cfg(feature = "...")]` 保护的性能分析计数器和内存泄漏诊断代码，这在教学/比赛项目中是少见的工程化实践。

7. **命名空间基础支持**：实现了 mount、network、IPC、time 四种命名空间的基本支持，以及对应的 `unshare`/`setns` 系统调用。

### 6.2 创新性局限

- 架构上基本遵循传统宏内核设计（类 Unix），未引入微内核、unikernel、exokernel 等新颖架构。
- 大部分子系统实现是 Linux ABI 兼容性驱动的，而非独立设计。
- HAL 抽象层虽完整但规模较小（每种实现 100-300 行），未达到复杂硬件抽象框架的级别。

---

## 七、测试与评测体系

### 7.1 评测框架

`judge/` 目录提供了完整的本地评测工具链：

- **测试组**：basic, busybox, lua, libctest, libcbench, iozone, ltp
- **双 libc**：musl 和 glibc 两种用户态环境
- **双架构**：RISC-V 和 LoongArch
- **评分脚本**：`judge_*.py` 系列（每个测试组一个）
- **目标检查**：`check_targets.sh` 支持多人并行开发目标管理
- **LTP 回归测试**：支持从 `os/src/task/run-ltp-rv.sh` 动态配置 LTP 测试列表

### 7.2 已记录测试状态

根据 `docs/ltp-glibc.txt`（35,619 字节）和历史文档，项目通过 LTP 回归测试追踪了大量 Linux 兼容性验证。

---

## 八、构建系统

### 8.1 构建流程

```
make all / make build
  ├── make -C os kernel ARCH=riscv64
  │   ├── 复制链接脚本
  │   ├── cargo build --release --target riscv64gc-unknown-none-elf
  │   └── rust-objcopy → kernel-rv.bin
  ├── make -C os kernel ARCH=loongarch64
  │   ├── 编译 loongarch64.S 入口汇编为 .o → .a
  │   ├── cargo build --release --target loongarch64-unknown-none
  │   └── cp → kernel-la
  └── disk-img
      ├── dd + mkfs.ext4 → disk.img (4GB)
      ├── 挂载 + 创建基础目录结构
      ├── 覆盖 etc/ 配置
      └── cp → disk-rv.img / disk-la.img
```

### 8.2 关键构建参数

| 参数 | RISC-V | LoongArch |
|---|---|---|
| Rust target | `riscv64gc-unknown-none-elf` | `loongarch64-unknown-none` |
| 入口地址 | `0x80200000` | `0x9000000090200000` |
| QEMU | `qemu-system-riscv64` | `qemu-system-loongarch64` |
| 默认内存 | 1G | 256M |
| 链接脚本 | `linker-riscv64-qemu.ld` | `linker-loongarch64.ld` |
| SBI | RustSBI | N/A (内置) |

---

## 九、总结

Eureka OS 是一个工程化程度很高的 Rust 宏内核项目，具有以下显著特点：

**优势**：
1. **Linux ABI 兼容性极为全面**：200+ 系统调用覆盖文件 IO、进程管理、内存管理、网络、IPC、信号、定时器、epoll、eBPF 等主要子系统。
2. **双架构支持设计良好**：HAL trait 架构清晰，架构特定代码隔离在 14 个组件中，RISC-V 与 LoongArch 差异处理得当。
3. **内存管理功能丰富**：CoW、按需分页、大页/巨页、共享文件 mmap、共享匿名 mmap、memfd、mlock 等均完整实现。
4. **EXT4 文件系统**：基于 lwext4 提供了完整的读写支持，包括扩展属性、符号链接、页缓存和预取。
5. **工程化基础设施完善**：内置性能分析系统（多维度 feature gate）、内存泄漏诊断、LTP 回归评测框架。
6. **调度器设计有特色**：基于 Future 的协作式调度 + PELT 负载均衡的组合在同类项目中较为少见。
7. **IPC 实现完整**：System V 三件套（共享内存、消息队列、信号量）含权限管理和命名空间支持。

**不足**：
1. **网络栈仅限于 loopback**：缺乏真实网络设备驱动和完整 TCP/IP 协议栈。
2. **设备驱动极度有限**：仅 VirtIO 块设备，无输入、显示、音频等驱动。
3. **部分子系统为满足测试而实现**：如 eBPF 仅支持 socket filter，keyctl 实现虽代码量大但覆盖有限。
4. **内核安全性**：缺乏地址空间随机化 (ASLR)、栈保护、KASLR 等现代安全特性。
5. **代码组织**：`syscall/fs.rs` 达 12,914 行，`memory_set.rs` 达 6,228 行，大文件缺少进一步模块化拆分。

**总体评价**：这是一个面向大学生 OS 内核比赛的高质量 Rust 宏内核实现，在 Linux ABI 兼容性方面达到了较高水平，双架构支持和丰富的子系统使该项目在同类参赛项目中具有较强的竞争力。项目约 55,000 行 Rust 代码，覆盖了操作系统课程核心知识点的同时，也展示了团队在工程实践和系统编程方面的扎实功底。