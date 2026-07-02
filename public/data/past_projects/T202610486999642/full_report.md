# WHUSP 内核项目深入技术报告

---

## 一、分析方法与范围

本次分析基于对项目全部 159 个 Rust 源文件（约 77,059 行内核代码）的系统性源码审查，以及对构建系统和依赖配置的完整检查。分析涵盖了：

1. **逐文件源码阅读**：对每个子系统的核心文件进行详细代码审查
2. **跨架构对比**：对比 RISC-V 64 和 LoongArch 64 两个架构的实现差异
3. **数据流追踪**：追踪系统调用从用户态到内核态的完整路径
4. **接口分析**：分析 VFS 抽象、设备驱动接口、内存管理 API 等内部接口
5. **构建系统审查**：审查 Makefile、Cargo.toml、链接脚本等构建配置

本分析未进行实际的 QEMU 运行测试，原因是该项目需要特定的比赛磁盘镜像和测试套件环境，在当前容器环境中缺少完整的测试磁盘镜像文件。

---

## 二、项目整体评估

### 2.1 项目定位

WHUSP 是一个面向操作系统内核比赛的宏内核（monolithic kernel），目标是提供与 Linux 高度兼容的用户空间 ABI，能够运行标准 Linux 可执行程序（通过 musl libc 编译）和 LTP（Linux Test Project）测试套件。

### 2.2 规模统计

| 指标 | 数值 |
|------|------|
| 内核 Rust 源文件 | 159 个 |
| 内核代码行数 | 约 77,059 行 (Rust + 汇编 + 链接脚本) |
| 系统调用号 | ~280 个（含显式常量定义和 match 臂） |
| 系统调用实际实现 | ~294 个 match 分支 |
| 支持架构 | RISC-V 64 (riscv64gc) + LoongArch 64 |
| 文件系统类型 | 8 种（EXT4、FAT、procfs、devfs、tmpfs、overlayfs、cgroupfs、staticfs） |
| 特殊文件类型 | 7 种（pipe、fifo、socket、eventfd、timerfd、memfd、anonfd） |

---

## 三、各子系统详细拆解

### 3.1 内核入口与启动 (`main.rs`)

**实现概要**：内核入口函数 `rust_main(hart_id, dtb_addr)` 在 `entry.asm` 中设置好启动栈后被调用。

**详细实现**：

```rust
// os/src/main.rs
pub extern "C" fn rust_main(hart_id: usize, dtb_addr: usize) -> ! {
    clear_bss();
    BOOT_HART_ID.store(hart_id, Ordering::Relaxed);
    DTB_ADDR.store(dtb_addr, Ordering::Relaxed);
    board::init_from_dtb(dtb_addr);   // DTB 解析 -> 板级配置
    mm::init();                        // 堆 + 帧分配器
    timer::init_wall_clock();          // RTC 初始化
    UART.init();
    logging::init();
    // ... 设备发现 ...
    trap::init();                      // 陷阱向量设置
    trap::enable_timer_interrupt();
    timer::set_next_trigger();
    board::device_init(hart_id);       // 外设初始化（块设备等）
    fs::init();                        // 文件系统初始化（挂载根文件系统）
    fs::list_apps();
    task::add_initproc();              // 创建 init 进程
    *DEV_NON_BLOCKING_ACCESS.exclusive_access() = board::block_irq_available();
    task::run_tasks();                 // 进入调度循环
    panic!("Unreachable in rust_main!");
}
```

**启动流程**：

1. **架构相关入口**（`entry.asm`）：设置启动栈，跳转到 `rust_main`
   - RISC-V：直接设置 `sp` 然后调用 `rust_main`
   - LoongArch：配置 DMW（直接映射窗口），从低物理地址跳转到高虚拟地址，然后调用 `rust_main`
2. **BSS 清零**：`clear_bss()` 使用 `sbss`/`ebss` 符号将 BSS 段清零
3. **DTB 解析**：`board::init_from_dtb(dtb_addr)` 解析设备树，提取：
   - 时钟频率
   - 内存范围
   - UART 基地址和 IRQ
   - 中断控制器信息（RISC-V PLIC / LoongArch EIOINTC+PCH-PIC）
   - 块设备配置（MMIO 或 PCI）
   - GPU、键盘、鼠标等可选外设
4. **内存管理初始化**：内核堆（128 MB）+ 物理帧分配器
5. **陷阱初始化**：设置 `stvec` / `eentry` 指向陷阱处理入口
6. **文件系统初始化**：挂载根文件系统（从 VirtIO 块设备读取 EXT4/FAT）
7. **init 进程**：创建 PID 1 进程，运行比赛测试脚本
8. **调度启动**：`run_tasks()` 进入无限调度循环

---

### 3.2 架构层 (`arch/`)

#### 3.2.1 RISC-V 64 实现

**关键文件**：
- `entry.asm`：16 页启动栈，跳转 `rust_main`
- `trap/trap.S`：用户/内核陷阱入口/出口汇编
- `trap/mod.rs`：Rust 陷阱处理逻辑
- `switch.S`：任务上下文切换
- `mm.rs`：Sv39 页表操作、ASID 管理、TLB 维护
- `board.rs`：DTB 解析、VirtIO MMIO 设备发现
- `signal.rs`：信号栈帧设置（`RiscvUContext`）
- `sbi.rs`：SBI 调用封装（定时器设置、关机）
- `backtrace.rs`：栈帧回溯

**陷阱处理流程**：

trap.S 中 `__alltraps` 保存完整用户上下文：
```asm
# 保存 31 个通用寄存器到 TrapContext
csrrw sp, sscratch, sp     # 交换 sp 和 sscratch（指向用户 TrapContext）
sd x1, 1*8(sp)
# ... 保存 x3-x31 ...
csrr t0, sstatus
csrr t1, sepc
sd t0, 32*8(sp)            # 保存 sstatus
sd t1, 33*8(sp)            # 保存 sepc
# 保存用户栈指针
csrr t2, sscratch
sd t2, 2*8(sp)
# 延迟 FPU 保存：仅在 FS == Dirty 时保存
# 加载内核页表 token 并切换
ld t0, 34*8(sp)            # kernel_satp
ld t1, 36*8(sp)            # trap_handler
csrw satp, t0
sfence.vma                 # 条件 TLB 刷新
jr t1                       # 跳转到 Rust trap_handler
```

`trap_handler` 的核心逻辑：
```rust
pub fn trap_handler() -> ! {
    set_kernel_trap_entry();
    let scause = scause::read();
    match scause.cause() {
        Trap::Exception(Exception::UserEnvCall) => {
            // 系统调用处理
            // 1. 提前处理 exit/exit_group（释放 Arc 避免死锁）
            // 2. 调用 syscall_with_current_task
            // 3. ptrace 停止检查
            // 4. 信号递送
        }
        Trap::Exception(Exception::StorePageFault) |
        Trap::Exception(Exception::InstructionPageFault) |
        Trap::Exception(Exception::LoadPageFault) => {
            handle_user_page_fault(stval, access_type); // 按需分页 + COW
        }
        Trap::Exception(Exception::IllegalInstruction) => {
            init_lazy_fp_for_task(&task); // 惰性 FPU 初始化
        }
        Trap::Interrupt(Interrupt::SupervisorTimer) => {
            set_next_trigger();
            check_timer();
            // CFS 调度抢占检查
        }
        Trap::Interrupt(Interrupt::SupervisorExternal) => {
            crate::board::irq_handler(); // 设备中断
        }
    }
}
```

**上下文切换** (`switch.S`)：
```asm
__switch:
    sd sp, 8(a0)       # 保存当前 sp
    sd ra, 0(a0)       # 保存 ra
    # 保存 s0-s11（被调用者保存寄存器）
    # 从 next 恢复 ra, s0-s11, sp
    ld sp, 8(a1)
    ret                 # 返回到 __switch 调用者的调用者
```

**RISC-V 页表**：采用 Sv39 三级页表，`mm.rs` 提供：
- ASID 分配与管理（支持运行时探测 ASID 支持）
- TLB 维护：`sfence.vma` 用于全刷新和单页刷新
- 延迟 TLB 刷新优化：跟踪最近返回的用户 token
- COW 标志位映射到 PTE 的保留位

#### 3.2.2 LoongArch 64 实现

**关键差异**：
- **入口**：`entry.asm` 配置 DMW0/DMW1 实现直接地址映射
- **页表**：三级页表（与 RISC-V 类似），但 PTE 编码完全不同：
  ```rust
  // LoongArch PTE 位
  const LA_PTE_V: usize = 1 << 0;       // 有效
  const LA_PTE_D: usize = 1 << 1;       // 脏
  const LA_PTE_PLV_USER: usize = 0b11 << 2;  // 用户特权级
  const LA_PTE_MAT_CC: usize = 0b01 << 4;    // 缓存一致性
  const LA_PTE_P: usize = 1 << 7;       // 存在
  const LA_PTE_W: usize = 1 << 8;       // 可写
  const LA_PTE_COW: usize = 1 << 58;    // COW 标记（软件位）
  const LA_PTE_NR: usize = 1 << 61;     // 不可读
  const LA_PTE_NX: usize = 1 << 62;     // 不可执行
  ```
- **无 ASID 支持**：`alloc_page_table_asid()` 返回 0，每次返回用户态总是清 TLB
- **直接映射**：`phys_to_virt(addr) = addr | 0x9000_0000_0000_0000`
- **中断控制器**：EIOINTC + PCH-PIC 两级中断控制器
  ```rust
  // EIOINTC 管理 256 个向量，通过 IOCSR 访问
  // PCH PIC 管理 64 个 IRQ，级联到 EIOINTC
  ```
- **TLB 重填**：trap.S 中有硬件 TLB 重填的 `__tlb_refill` 入口 (`align 12`)，配置了 `pwcl`/`pwch` 寄存器实现三级页表硬件走表
- **FPU 状态**：trap.S 中无条件保存/恢复全部 32 个浮点寄存器和 8 个 FCC 条件码
- **关机**：通过 QEMU GED（通用事件设备）的电源关闭寄存器 (`0x100e_001c`)

---

### 3.3 内存管理 (`mm/`)

#### 3.3.1 物理帧分配器 (`frame_allocator.rs`)

**实现**：栈式分配器（`StackFrameAllocator`），基于引用计数：

```rust
pub struct StackFrameAllocator {
    start: usize,        // 物理帧范围起始
    current: usize,      // 当前分配指针（单调递增）
    end: usize,          // 物理帧范围结束
    recycled: Vec<usize>, // 回收链表
    ref_counts: Vec<usize>, // 每个物理帧的引用计数
}
```

**关键特性**：
- 分配从 `ekernel` 之后开始，到 `memory_end()`（DTB 获取）结束
- `frame_alloc()` 返回零化的 `FrameTracker`（实现 Drop 自动回收）
- `frame_alloc_uninit()` 返回未零化的帧（用于内核私有映射）
- `frame_alloc_more(num)` 分配连续物理帧（DMA 队列用）
- 引用计数防止双重释放，支持 `frame_retain()` 增加引用

#### 3.3.2 内核堆分配器 (`heap_allocator.rs`)

基于 `buddy_system_allocator::LockedHeap<32>`，包装了中断安全的全局分配器：

```rust
struct InterruptFreeLockedHeap<const ORDER: usize> {
    inner: LockedHeap<ORDER>,
}
// alloc/dealloc 操作期间屏蔽中断，防止中断处理程序重入分配器
```

- 堆大小：128 MB (`KERNEL_HEAP_SIZE = 0x800_0000`)
- 使用 `#[global_allocator]` 注册为 Rust 全局分配器

#### 3.3.3 页表管理 (`page_table.rs`)

**跨架构抽象**：
```rust
pub struct PageTable {
    root_ppn: PhysPageNum,
    asid: usize,                        // ASID（LoongArch 上为 0）
    frames: Vec<FrameTracker>,          // 持有页表页的所有权
}
```

**PTE 标志位**（架构无关抽象）：
```rust
bitflags! {
    pub struct PTEFlags: usize {
        const V = 1 << 0;   // 有效
        const R = 1 << 1;   // 可读
        const W = 1 << 2;   // 可写
        const X = 1 << 3;   // 可执行
        const U = 1 << 4;   // 用户可访问
        const G = 1 << 5;   // 全局
        const A = 1 << 6;   // 已访问
        const D = 1 << 7;   // 已修改
        const COW = 1 << 8; // Copy-on-Write 标记
    }
}
```

**关键操作**：
- `try_map()`：三级页表遍历，按需分配中间页表
- `unmap()`：清除 PTE，释放物理页
- `mark_cow_readonly()`：将 PTE 标记为 COW 并去除写权限
- `remap_flags()`：修改现有映射的保护位
- 用户 PTE 缓存：原子变量实现的单槽缓存，加速 `UserBuffer` 地址翻译

#### 3.3.4 地址空间抽象 (`memory_set.rs`)

```rust
pub struct MemorySet {
    pub(super) page_table: PageTable,
    pub(super) areas: Vec<MapArea>,              // 排序的 VMA 列表
    pub(super) last_area_idx_containing: Cell<Option<usize>>, // 缓存最近查找
    pub(super) brk_base: usize,                   // 程序 break
    pub(super) brk: usize,
    pub(super) brk_limit: usize,
    pub(super) brk_mapped_end: usize,
    pub(super) mmap_next: usize,                  // 下次 mmap 分配的 hint
    pub(super) mlock_future: bool,
    pub(super) mlock_future_on_fault: bool,
}
```

**VMA 管理**：
- 保持 `areas` 排序，支持 O(log n) 查找
- `MapArea` 支持多种映射类型：`Framed`（惰性分配）、`Mmap`（文件/匿名映射）、`Shm`（共享内存）
- 页面错误处理（`MapArea::fault()`）实现按需分配、COW 复制和文件页缓存

#### 3.3.5 页面缓存 (`page_cache.rs`)

```rust
pub(crate) struct PageCachePage {
    pub(crate) frame: FrameTracker,
    pub(crate) key: PageCacheKey,
    pub(crate) file_size_at_load: usize,
    pub(crate) dirty: bool,        // MAP_SHARED 脏页
    pub(crate) ref_count: usize,   // 页表引用计数
    exec_icache_synced: bool,
    lru_stamp: usize,
}
```

- 软上限：4096 页（16 MB）
- LRU 驱逐策略
- 脏页追踪用于 MAP_SHARED 写回
- 执行页的指令缓存同步

#### 3.3.6 共享内存 (`shm.rs`)

实现了 System V 共享内存 (shmget/shmat/shmdt/shmctl)：
- `ShmSegment`：管理共享内存段（物理页列表、大小、权限）
- 全局 `SHM_SEGMENTS` 表
- 支持 `ShmCaller` 权限检查

#### 3.3.7 ELF 加载器 (`elf_loader.rs`)

- 使用 `xmas-elf` 库解析 ELF 文件
- 支持动态链接的 ELF（通过 PT_INTERP 识别解释器）
- 加载到用户地址空间时创建惰性帧映射区域
- 记录 `ElfLoadInfo` 用于 `/proc` 报告

---

### 3.4 任务/进程管理 (`task/`)

#### 3.4.1 进程控制块 (`process.rs`)

```rust
pub struct ProcessControlBlock {
    pub pid: PidHandle,                     // 进程 ID
    pub inner: UPIntrFreeCell<ProcessControlBlockInner>,
}

pub struct ProcessControlBlockInner {
    pub memory_set: MemorySet,              // 地址空间
    pub tasks: Vec<Option<Arc<TaskControlBlock>>>, // 线程表
    pub parent: Option<Weak<ProcessControlBlock>>,
    pub children: Vec<Arc<ProcessControlBlock>>,   // 子进程
    pub fd_table: Vec<Option<FdTableEntry>>,       // 文件描述符表
    pub executable_path: Option<String>,
    pub cmdline: Vec<String>,               // /proc/cmdline
    pub working_dir: Option<WorkingDir>,    // 当前工作目录
    pub root_dir: Option<WorkingDir>,       // chroot 根目录
    pub umask: u32,
    pub exit_code: Option<i32>,
    pub signal_actions: Vec<SignalAction>,  // 信号处理器
    pub signal_mask: SignalFlags,
    pub credentials: Credentials,           // UID/GID
    pub resource_limits: ProcessResourceLimits,
    // ... 更多字段
}
```

**凭证与权限**：完整的 Linux 风格凭证模型
```rust
pub struct Credentials {
    pub uid: u32, euid: u32, suid: u32, fsuid: u32,
    pub gid: u32, egid: u32, sgid: u32, fsgid: u32,
    pub groups: Vec<u32>,
    pub capabilities: CapabilitySets,
}
```

**资源限制**：实现了 16 种 `RLimitResource`（Cpu, FSize, Data, Stack 等）

**命名空间支持**：Mount、PID、User、UTS、Net 命名空间（以枚举值形式存储）

#### 3.4.2 线程控制块 (`task.rs`)

```rust
pub struct TaskControlBlock {
    pub process: Weak<ProcessControlBlock>,  // 所属进程
    pub kstack: KernelStack,                 // 内核栈
    pub inner: UPIntrFreeCell<TaskControlBlockInner>,
}

pub struct TaskControlBlockInner {
    pub res: Option<TaskUserRes>,           // 用户栈/陷阱上下文资源
    pub tid: usize,                          // 内部任务 ID
    pub trap_cx_ppn: PhysPageNum,           // 陷阱上下文物理页
    pub task_cx: TaskContext,               // 调度上下文（ra, sp, s0-s11）
    pub task_status: TaskStatus,            // Ready/Running/Blocked/Exited
    pub pending_signals: SignalFlags,        // 待处理信号
    pub signal_infos: Vec<Option<SignalInfo>>,
    pub signal_mask: SignalFlags,            // 信号掩码
    pub sigaltstack: SigAltStack,            // 信号替代栈
    pub sched_policy: i32,                   // SCHED_NORMAL/FIFO/RR/DEADLINE
    pub sched_priority: i32,
    pub sched_vruntime: u64,                 // CFS 虚拟运行时间
    pub nice: i8,
    pub cpu_times: TaskCpuTimes,             // 用户/系统 CPU 时间
    pub seccomp_mode: u8,                    // SECCOMP 过滤模式
    pub seccomp_filter: Option<Vec<SeccompSockFilter>>, // BPF 过滤器
    pub clear_child_tid: Option<usize>,      // CLONE_CHILD_CLEARTID
    pub robust_list_head: usize,             // futex robust list
    pub linux_tid: Option<PidHandle>,        // Linux TID
    // ... 更多字段
}
```

#### 3.4.3 调度器 (`manager.rs`, `processor.rs`)

**CFS 调度实现**：
- 就绪队列使用 `BinaryHeap` 组织（按 `sched_vruntime` 排序）
- 支持 `SCHED_NORMAL`（CFS）、`SCHED_FIFO`、`SCHED_RR`、`SCHED_DEADLINE`
- 实时任务优先级高于普通任务
- SCHED_RR 时间片：100ms (`SCHED_RR_INTERVAL_US`)
- 定时器中断频率：1000 Hz（1ms 抢占粒度）
- `timer_tick_should_preempt()` 检查是否需要抢占

**调度流程**：
```rust
pub fn schedule(switched_task_cx_ptr: *mut TaskContext) -> ! {
    // 1. 从就绪队列取出下一个任务
    // 2. 设置当前处理器任务
    // 3. 切换到新任务的内核栈和地址空间
    // 4. __switch(current, next)
}
```

#### 3.4.4 克隆与执行 (`clone.rs`, `exec.rs`)

**clone 实现**：
- 支持全部 Linux clone 标志（`CLONE_VM`, `CLONE_FILES`, `CLONE_SIGHAND`, `CLONE_THREAD` 等）
- 线程创建共享地址空间、文件表、信号处理
- 支持 `CLONE_CHILD_CLEARTID`、`CLONE_SETTLS` 等
- vfork 通过 `CLONE_VFORK` 实现（父进程阻塞直到子进程 exec/exit）

**execve 实现**：
- ELF 加载 + 地址空间替换
- 辅助向量 (AT_PHDR, AT_ENTRY, AT_BASE, AT_HWCAP 等)
- 信号处理器重置（SIG_DFL / SIG_IGN）
- ptrace exec 事件通知
- 支持 shebang 脚本（`#!`）解释器递归加载

#### 3.4.5 信号处理 (`signal.rs`)

**信号结构**（128 位 `SignalFlags` 支持 65 个信号）：
```rust
bitflags! {
    pub struct SignalFlags: u128 {
        const SIGHUP    = 1u128 << 1;
        const SIGINT    = 1u128 << 2;
        // ... 到 SIGSYS (bit 31) ...
        // SIGRTMIN (bit 32) 到 SIGRTMAX (bit 64)
    }
}
```

**信号递送流程**：
1. `queue_signal_to_task()` → 设置 `pending_signals`
2. 从内核态返回用户态前调用 `deliver_pending_signal()`
3. 检查信号掩码和阻塞状态
4. 在用户栈上构建信号帧（`RiscvUContext` / LoongArch ucontext）
5. 设置用户 `sepc` 到信号处理器或 `__vdso_rt_sigreturn`
6. `rt_sigreturn` 还原上下文

**架构相关信号帧**：
- RISC-V：`RiscvUContext` 包含 `RiscvMContext`（32 个 GPR + FP 状态）
- LoongArch：类似结构，使用 LA 的 ucontext 格式

#### 3.4.6 Futex 实现 (`futex.rs`)

完整的 Linux futex 兼容实现：

```rust
const FUTEX_BUCKET_COUNT: usize = 64;  // 64 个哈希桶

struct FutexManager {
    buckets: Vec<FutexBucket>,
    waiter_keys: BTreeMap<usize, FutexWaiterLocation>,
    ...
}
```

**支持的操作**：
- `FUTEX_WAIT` / `FUTEX_WAKE`（基本操作）
- `FUTEX_WAIT_BITSET` / `FUTEX_WAKE_BITSET`（位集变体）
- `FUTEX_REQUEUE` / `FUTEX_CMP_REQUEUE`（重新排队）
- `FUTEX_LOCK_PI` / `FUTEX_UNLOCK_PI` / `FUTEX_TRYLOCK_PI`（优先级继承）
- `FUTEX_PRIVATE_FLAG`（进程私有优化）
- `FUTEX_CLOCK_REALTIME`（实时时钟超时）
- Robust list 清理（在任务退出时）

**超时处理**：通过 `add_timer()` 注册定时器，超时后唤醒 futex 等待者

#### 3.4.7 Ptrace 支持 (`ptrace.rs`)

实现了 Linux ptrace 的核心操作：
- `PTRACE_TRACEME`、`PTRACE_ATTACH`、`PTRACE_DETACH`
- `PTRACE_SYSCALL`（系统调用入口/出口停止）
- `PTRACE_SINGLESTEP`、`PTRACE_CONT`
- `PTRACE_GETREGS`、`PTRACE_SETREGS`
- `PTRACE_PEEKDATA`、`PTRACE_POKEDATA`
- `PTRACE_GETSIGINFO`、`PTRACE_SETSIGINFO`
- `PTRACE_EVENT_EXEC`、`PTRACE_EVENT_EXIT` 等事件

---

### 3.5 文件系统 (`fs/`)

#### 3.5.1 VFS 框架 (`fs/vfs/`)

**核心抽象**：

```rust
pub(crate) trait FileSystemBackend {
    // 目录操作
    fn root_ino(&self) -> u32;
    fn lookup_component_from(&mut self, parent_ino: u32, name: &str)
        -> FsResult<(u32, FsNodeKind)>;
    
    // 文件/节点创建
    fn create_file(&mut self, parent_ino: u32, name: &str) -> FsResult<u32>;
    fn create_dir(&mut self, parent_ino: u32, name: &str, mode: u32) -> FsResult<u32>;
    fn create_node(&mut self, parent_ino: u32, name: &str, kind: FsNodeKind,
                   mode: u32, rdev: u64) -> FsResult<u32>;
    
    // 文件内容操作
    fn read(&mut self, ino: u32, offset: u64, buf: &mut [u8]) -> FsResult<usize>;
    fn write(&mut self, ino: u32, offset: u64, buf: &[u8]) -> FsResult<usize>;
    fn truncate(&mut self, ino: u32, size: u64) -> FsResult;
    
    // 元数据
    fn stat(&mut self, ino: u32) -> FsResult<FileStat>;
    fn link(&mut self, parent: u32, name: &str, child: u32) -> FsResult;
    fn unlink(&mut self, parent: u32, name: &str) -> FsResult;
    fn symlink(&mut self, parent: u32, name: &str, target: &[u8]) -> FsResult;
    fn readlink(&mut self, ino: u32) -> FsResult<Vec<u8>>;
    
    // 文件系统统计
    fn statfs(&mut self) -> FileSystemStat;
}
```

**VfsFile**：VFS 层的文件对象，实现了：
- 统一的 `read()` / `write()` 接口（含分块循环，最大 64KB 每块）
- 脏页缓存（写缓冲）+ 写回
- 小文件读缓存（< 8MB 文件，总缓存 32MB）
- 预读（readahead：6 页）
- O_APPEND 处理
- `seek()` 支持 SEEK_SET/CUR/END/DATA/HOLE
- 文件锁（`flock`）
- ETXTBSY 检查（可写文件不允许执行映射）

**VfsNodeId**：
```rust
pub(crate) struct VfsNodeId {
    pub(crate) mount_id: MountId,
    pub(crate) ino: u32,
}
```

#### 3.5.2 EXT4 文件系统 (`ext4.rs`)

基于 `lwext4_rust`（C 库 lwext4 的 Rust 绑定）：

- `KernelDisk` 将 `VirtIOBlock` 适配为 `Ext4BlockDevice`
- `Ext4Mount` 包装 `Ext4Filesystem`
- 实现了完整的 `FileSystemBackend` trait
- 支持文件/目录创建、读写、链接、符号链接、截断
- 支持扩展属性 (xattr)
- inode 标志（immutable, append-only 等）
- 运行时特殊设备号 (`runtime_special_rdevs`)

#### 3.5.3 FAT 文件系统 (`fat.rs`)

基于 vendored `fatfs` crate：
- 支持 FAT12/16/32
- 长文件名支持 (LFN)
- 通过 `FileSystemBackend` trait 集成

#### 3.5.4 Proc 文件系统 (`procfs.rs`)

极为完善的 `/proc` 实现（3352 行），包括：

- `/proc/cpuinfo`, `/proc/meminfo`, `/proc/uptime`, `/proc/version`
- `/proc/sys/` 完整 sysctl 树（kernel, fs, net, vm, user 等）
- `/proc/self` 符号链接
- `/proc/<pid>/` 目录：
  - `stat`, `status`, `cmdline`, `comm`, `exe`
  - `maps`, `smaps`, `pagemap`
  - `fd/`, `fdinfo/`
  - `ns/`（mnt, pid, user, uts, net）
  - `mounts`, `mountinfo`
  - `task/<tid>/` 线程目录
  - `coredump_filter`
  - `oom_score_adj`, `io`, `timerslack_ns`
  - `uid_map`, `gid_map`, `setgroups`
- `/proc/filesystems`, `/proc/mounts`
- `/proc/sysvipc/`（shm, sem, msg）
- `/proc/oskernel/perf`（性能计数器）
- `/proc/config.gz`（内嵌的内核配置）

#### 3.5.5 Dev 文件系统 (`devfs.rs`)

实现了完整的设备节点系统（2994 行）：

- `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`
- `/dev/tty`, `/dev/ttyS0`, `/dev/tty8`, `/dev/tty9`
- `/dev/ptmx` + `/dev/pts/*`（伪终端，PTY buffer 8KB，64 对）
- `/dev/loop-control`, `/dev/loop0`, `/dev/loop1`（回环设备）
- `/dev/input/event0`, `/dev/input/mice`（输入设备）
- `/dev/uinput`（用户输入设备）
- `/dev/kmsg`
- `/dev/net/tun`
- `/dev/rtc`（实时时钟）

#### 3.5.6 Tmpfs (`tmpfs.rs`)

内存文件系统（1462 行），特色功能：
- **稀疏文件支持**：使用 `TmpfsSparseExtent` 枚举：
  ```rust
  enum TmpfsSparseExtent {
      Bytes(Vec<u8>),                          // 密集数据
      Repeated { pattern: Vec<u8>, len: usize }, // 重复模式（如全零）
  }
  ```
- 自动将大块零数据转为重复模式（节省内存）
- 64KB 稀疏 extent 限制
- 软硬链接、目录、特殊文件（FIFO, socket）
- 扩展属性存储
- 额外配额模式（`EXT_SCRATCH_INLINE_FILE_LIMIT = 0`）

#### 3.5.7 Overlay 文件系统 (`overlayfs.rs`)

实现了 Linux overlayfs 的核心功能：
- 下层（lower）+ 上层（upper）合并
- 写时复制：修改 lower 文件时复制到 upper
- 白名单文件删除（opaque whiteouts）
- 目录合并和条目去重

#### 3.5.8 Cgroup 文件系统 (`cgroupfs.rs`)

简化的 cgroup v1 兼容实现：
- `/sys/fs/cgroup/memory/` 内存控制组
- 内存压力检测和回收 (`memcg_pressure_active`)
- 页面回收接口 (`reclaim_memcg_pressure_pages`)

#### 3.5.9 特殊文件类型

| 文件类型 | 实现文件 | 关键特性 |
|---------|---------|---------|
| **Pipe** | `pipe.rs` (692 行) | 环形缓冲区，默认 64KB，支持 fcntl 修改容量 |
| **Named FIFO** | `named_fifo.rs` | 基于 Pipe 的命名管道 |
| **Socket** | `socket.rs` (3774 行) | 本地回环 TCP/UDP/Unix Socket/Netlink/Packet |
| **Eventfd** | `eventfd.rs` | 事件计数器，支持 semaphore 模式 |
| **Timerfd** | `timerfd.rs` | 定时器文件描述符 |
| **Memfd** | `memfd.rs` | 匿名内存文件 |
| **Anonfd** | `anonfd.rs` | 匿名 inode（用于 O_TMPFILE 等） |

#### 3.5.10 挂载系统 (`mount.rs`, `mount_fd.rs`)

- `MountId` / `MountNamespaceId` 标识挂载点和命名空间
- 支持 bind mount、递归 bind mount
- 挂载传播（shared/slave/private/unbindable）
- 挂载过期（MNT_EXPIRE）
- `open_tree`/`fsopen`/`fsconfig`/`fsmount`/`move_mount` 新挂载 API
- `/proc/mounts` 和 `/proc/mountinfo` 输出

---

### 3.6 系统调用 (`syscall/`)

#### 3.6.1 系统调用分发表

系统调用号遵循 Linux 通用编号方案，在 `syscall/mod.rs` 中定义约 280 个常量（`SYSCALL_IO_SETUP = 0` 到 `SYSCALL_FSPICK` 等）。

**系统调用入口**：
```rust
pub fn syscall_with_current_task(
    current: Arc<TaskControlBlock>,
    syscall_id: usize,
    args: [usize; 6],
) -> isize {
    // 1. 提前处理 exit（释放 Arc）
    // 2. seccomp 过滤
    // 3. 处理 exit_group（释放 Arc）
    // 4. 身份快速路径（getpid/getuid 等无锁调用）
    // 5. 构建 SyscallContext
    // 6. syscall_with_context(ctx, syscall_id, args)
}
```

**架构差异**：
- RISC-V：syscall 号在 `x[17]` (a7)，参数在 `x[10]-x[15]` (a0-a5)
- LoongArch：syscall 号在 `x[11]` (a7)，参数在 `x[4]-x[9]` (a0-a5)

#### 3.6.2 已实现的主要系统调用类别

| 类别 | 主要系统调用 | 实现文件 |
|------|-------------|---------|
| **文件 I/O** | read, write, readv, writev, pread64, pwrite64, preadv, pwritev, lseek, truncate, ftruncate, sendfile, splice, tee, vmsplice, sync, fsync, fdatasync, sync_file_range, readahead, fadvise64 | `syscall/fs/io.rs` |
| **文件操作** | openat, close, dup, dup3, fcntl, statfs, fstatfs, statx, newfstatat, fstat, utimensat, fallocate | `syscall/fs/` |
| **目录操作** | mkdirat, unlinkat, symlinkat, linkat, getcwd, chdir, fchdir, chroot, getdents64 | `syscall/fs/` |
| **文件属性** | faccessat, fchmod, fchmodat, fchown, fchownat, umask, setxattr, getxattr, listxattr, removexattr | `syscall/fs/` |
| **挂载** | mount, umount2, open_tree, move_mount, fsopen, fsconfig, fsmount, fspick | `syscall/fs/mount.rs` |
| **epoll** | epoll_create1, epoll_ctl, epoll_pwait | `syscall/fs/epoll.rs` |
| **inotify** | inotify_init1, inotify_add_watch, inotify_rm_watch | `syscall/fs/inotify.rs` |
| **fanotify** | fanotify_init, fanotify_mark | `syscall/fs/fanotify.rs` |
| **poll/select** | ppoll, pselect6 | `syscall/fs/poll.rs` |
| **进程管理** | clone, execve, exit, exit_group, waitid, getpid, getppid, gettid, set_tid_address, unshare, prctl | `syscall/process/` |
| **信号** | kill, tkill, tgkill, rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigsuspend, rt_sigtimedwait, rt_sigqueueinfo, rt_sigreturn, sigaltstack, signalfd4, pidfd_send_signal | `syscall/signal.rs` |
| **内存** | mmap, munmap, mremap, brk, mprotect, msync, mlock, munlock, mlockall, munlockall, madvise, membarrier, mincore, pkey_alloc, pkey_free, pkey_mprotect, process_madvise | `syscall/memory.rs` |
| **时间** | clock_gettime, clock_settime, clock_getres, clock_nanosleep, nanosleep, gettimeofday, settimeofday, time, adjtimex, timer_create, timer_settime, timer_gettime, timer_delete, timer_getoverrun, getitimer, setitimer | `syscall/time.rs` |
| **Futex** | futex, set_robust_list, get_robust_list | `syscall/futex.rs` |
| **调度** | sched_setparam, sched_setscheduler, sched_getscheduler, sched_getparam, sched_setaffinity, sched_getaffinity, sched_yield, sched_get_priority_max/min, sched_rr_get_interval, sched_setattr, sched_getattr | `syscall/process/sched.rs` |
| **Socket** | socket, socketpair, bind, listen, accept, connect, getsockname, getpeername, sendto, recvfrom, setsockopt, getsockopt, shutdown, sendmsg, recvmsg | `syscall/net.rs` |
| **System V IPC** | msgget, msgctl, msgsnd, msgrcv, semget, semctl, semop, semtimedop, shmget, shmctl, shmat, shmdt | `syscall/msg.rs`, `syscall/sem.rs`, `syscall/memory.rs` |
| **身份/权限** | setuid, getuid, seteuid, geteuid, setreuid, setresuid, getresuid, setgid, getgid, setegid, getegid, setregid, setresgid, getresgid, setfsuid, setfsgid, getgroups, setgroups, capget, capset | `syscall/process/identity.rs` |
| **资源** | getrlimit, setrlimit, getrusage, getpriority, setpriority, times, sysinfo | `syscall/process/resource.rs` |
| **Ptrace** | ptrace | `syscall/process/ptrace.rs` |
| **密钥** | add_key, request_key, keyctl | `syscall/keyring.rs` |
| **AIO** | io_setup, io_destroy, io_submit, io_cancel, io_getevents, io_pgetevents | `syscall/aio.rs` |
| **io_uring** | io_uring_setup, io_uring_enter, io_uring_register | `syscall/fs/io.rs` |
| **PIDfd** | pidfd_open, pidfd_getfd, pidfd_send_signal | `syscall/process/pidfd.rs` |
| **其他** | syslog, reboot, personality, uname, sethostname, setdomainname, init_module, delete_module, quotactl | 各文件 |

---

### 3.7 设备驱动 (`drivers/`)

#### 3.7.1 VirtIO 传输层

**两种传输模式**：
- **MMIO**（RISC-V 主要使用）：通过 DTB 发现 VirtIO MMIO 设备
  ```rust
  pub fn mmio_transport(base_addr: usize, size: usize) -> VirtioTransport
  ```
- **PCI**（LoongArch 主要使用）：通过 PCI ECAM 空间枚举 VirtIO PCI 设备
  ```rust
  // 在 board.rs 的 DTB 解析中处理
  ```

**VirtioHal**：实现了 `virtio_drivers::Hal` trait：
- DMA 分配/释放（通过 `frame_alloc_more`）
- 物理地址转换（页表遍历 `virt_to_phys`）
- 非连续缓冲区的 bounce buffer 机制

#### 3.7.2 块设备驱动 (`block.rs`)

```rust
pub struct VirtIOBlock {
    virtio_blk: UPIntrFreeCell<VirtIOBlk<VirtioHal, VirtioTransport>>,
    condvars: BTreeMap<u16, Condvar>,
    ...
}
```

**I/O 路径**：
1. **非阻塞路径**（首选）：提交请求 → 等待条件变量 → 调度出去 → IRQ 完成时唤醒
2. **同步路径**（回退）：直接调用 `read_blocks` 轮询
3. **不安全上下文回退**：当中断被禁用时使用同步读取

**块缓存** (`block_cache.rs`, 832 行)：
- 缓存 VirtIO 块读取
- 与 page cache 协作

#### 3.7.3 字符设备驱动 (`chardev.rs`)

- `CharDevice` trait：`read()` / `write()` / `init()` / `available_chars()`
- `NS16550a`：UART 驱动（用于串口输入输出）
- 全局 `UART` 实例用于内核 `print!` / `println!`

#### 3.7.4 输入设备驱动 (`input.rs`)

- 键盘设备（`KEYBOARD_DEVICE`）
- 鼠标设备（`MOUSE_DEVICE`）
- 用于 `/dev/input/event0`

#### 3.7.5 RISC-V PLIC (`plic.rs`)

RISC-V 平台级中断控制器的基本驱动。

---

### 3.8 同步原语 (`sync/`)

#### 3.8.1 `UPIntrFreeCell<T>`

基于中断屏蔽的单核互斥原语：

```rust
pub struct UPIntrFreeCell<T> {
    inner: RefCell<T>,
}
```

- `exclusive_access()`：屏蔽中断 → 获取 `RefMut` → 返回守卫
- 守卫 Drop 时恢复中断
- 嵌套支持（`IntrMaskingInfo` 追踪嵌套级别和原始中断使能状态）
- `try_exclusive_access()`：失败时恢复中断
- `exclusive_session()`：闭包形式，自动释放

#### 3.8.2 `SleepMutex<T>`

基于 futex 的阻塞互斥锁：
- `lock()` 阻塞当前任务直到获取锁
- 内部使用 `UPIntrFreeCell` 保护锁状态

#### 3.8.3 `Condvar`

条件变量：
- `wait_no_sched()`：阻塞当前任务，返回 `task_cx_ptr` 供调度器使用
- 与 `UPIntrFreeCell::exclusive_session()` 配合使用
- 用于块设备 I/O 完成通知等

---

### 3.9 vDSO 实现 (`vdso.rs`)

在内核空间中实现 vDSO（virtual Dynamic Shared Object），提供快速用户态时钟访问：

**汇编实现的函数**：
- `__vdso_clock_gettime`：直接读取 RISC-V `rdtime` 或 LoongArch 定时器 CSR
- `__vdso_gettimeofday`：读取时间并转换为秒/微秒
- `__vdso_clock_getres`：返回分辨率（1ns）

**内核补丁机制**：
- `patch_vdso_u64()` 在映射后写入时钟频率和墙上时间偏移
- 用户态直接读取这些值，避免系统调用开销

**ELF 构造**：手动构建 vDSO ELF 镜像（包含 `.hash`、`.dynsym`、`.dynstr`、`.versym` 等段），映射到 `USER_MMAP_LIMIT - PAGE_SIZE`。

---

### 3.10 基础设施

#### 3.10.1 控制台 (`console.rs`)
- 通过 UART 字符设备输出
- `print!` / `println!` 宏基于 `core::fmt::Write`

#### 3.10.2 日志系统 (`logging.rs`)
- 基于 `log` crate
- 支持 ERROR/WARN/INFO/DEBUG/TRACE 五级日志
- ANSI 颜色区分不同级别
- 日志级别通过 `LOG` 环境变量在编译时设置

#### 3.10.3 内核配置 (`config.rs`)
```rust
pub const USER_STACK_SIZE: usize = 4096 * 1024;    // 4 MB
pub const KERNEL_STACK_SIZE: usize = 4096 * 10;     // 40 KB
pub const KERNEL_HEAP_SIZE: usize = 0x800_0000;     // 128 MB
pub const PAGE_SIZE: usize = 0x1000;                // 4 KB
pub const TRAMPOLINE: usize = usize::MAX - PAGE_SIZE + 1;  // 最高页
```

#### 3.10.4 恐慌处理 (`lang_items.rs`)
- 打印位置和消息
- 栈回溯（最多 10 帧）
- SBI 关机

#### 3.10.5 性能计数器 (`perf.rs`)
- 可选功能（`perf-counters` feature）
- 52 个性能剖析点（`ProfilePoint` 枚举）
- 通过 `/proc/oskernel/perf` 暴露
- 时间作用域宏：`perf::time_scope()`, `perf::time_syscall()`

---

## 四、子系统间的交互

### 4.1 系统调用完整路径

```
用户程序 (ecall)
  → trap.S (保存上下文, 切换到内核页表)
  → trap_handler() (scause 分发)
    → syscall_with_current_task()
      → seccomp 过滤
      → SyscallContext::new() (快照 task + process + user_token)
      → syscall_with_context() (match 分发)
        → sys_xxx() (具体系统调用实现)
          → UserBuffer (用户指针安全检查)
          → VFS 操作 / 进程操作 / 信号操作 / ...
      → 返回结果放入 TrapContext.x[10]/x[4]
  → deliver_pending_signal() (信号递送)
  → trap_return (restore 上下文, sret/ertn)
用户程序 (继续)
```

### 4.2 页面错误处理路径

```
用户内存访问 → 页面错误
  → trap_handler() [StorePageFault/LoadPageFault/InstructionPageFault]
    → handle_user_page_fault()
      → MemorySet::find_area_idx_containing()
      → MapArea::fault()
        ├─ Framed: 分配新物理帧
        ├─ COW: 复制物理帧，更新 PTE
        ├─ Mmap: 从 PageCache 或文件后端读取
        └─ Shm: 查找共享内存段
      → PageTable::try_map() (建立映射)
```

### 4.3 块设备 I/O 路径

```
read()/write() 系统调用
  → vfs::file::read/write
    → ext4/fat backend::read/write
      → lwext4_rust 库
        → KernelDisk::read_blocks/write_blocks
          → VirtIOBlock::read_blocks/write_blocks
            → block_cache::read_with_cache
              → VirtIOBlock::read_blocks_nonblocking_uncached
                → VirtIOBlk::read_blocks_nb (提交非阻塞请求)
                → Condvar::wait_no_sched (阻塞等待)
                → schedule (切换到其他任务)
              [IRQ 到达]
                → board::irq_handler
                  → VirtIOBlock::handle_irq
                    → Condvar::signal (唤醒等待任务)
                      → schedule (返回等待任务)
                → VirtIOBlk::complete_read_blocks (完成读取)
```

### 4.4 任务调度与切换

```
schedule(current_task_cx_ptr)
  → manager::fetch_task() (从就绪队列取最高优先级任务)
  → processor::set_current_task(next)
  → 切换到新任务的内核页表
  → arch::__switch(current, next) (汇编上下文切换)
    [在新任务的上下文中继续]
  → reap_exited_tasks() (清理已退出任务)
  → 检查 pending_signals，必要时递送信号
  → 返回用户态
```

---

## 五、实现完整度评估

### 5.1 各子系统完整度

| 子系统 | 完整度 | 评估基准 |
|--------|--------|---------|
| **架构层 - RISC-V 64** | 90% | 完整的 Sv39 页表、陷阱处理、FPU 惰性保存、ASID 管理、SBI 调用 |
| **架构层 - LoongArch 64** | 80% | 完整但对等实现，无 ASID（性能影响），PCI 设备枚举已实现 |
| **内存管理** | 85% | 完整的页表、帧分配、堆分配、VMA、COW、mmap、共享内存、页面缓存 |
| **进程管理** | 88% | 完整的 fork/clone/exec、信号、futex、ptrace、CFS 调度、cgroup |
| **文件系统** | 92% | 8 种文件系统，完善的 VFS 抽象，脏页缓存，读写缓存 |
| **系统调用** | 82% | ~280 个系统调用号，~294 个实现分支，覆盖主要 Linux ABI |
| **设备驱动** | 75% | VirtIO MMIO/PCI 块设备，UART，输入设备，PLIC/EIOINTC。缺少 VirtIO GPU/网络实际数据路径 |
| **同步原语** | 80% | 完善的 UPIntrFreeCell，SleepMutex，Condvar。缺少 RCU 和更复杂的锁 |
| **网络** | 60% | 本地回环 TCP/UDP/Unix Socket，无实际网络设备数据路径 |
| **vDSO** | 85% | 三个时钟函数，手工构建 ELF。仅 RISC-V 有完整的汇编实现 |

### 5.2 整体完整度：约 83%

基于以上子系统的加权平均，并考虑以下因素：
- 比赛导向的实现策略：优先完成与 LTP 测试直接相关的功能
- 代码中的 `UNFINISHED` / `CONTEXT` 注释标记了已知的限制
- 约 50+ 处 `UNFINISHED` 注释，表明部分功能为 LTP 测试套件做了针对性实现而非完整通用实现

---

## 六、创新性与设计亮点

### 6.1 双架构统一的 TrapContext 设计

WHUSP 在架构无关的 `TrapContext` 结构中实现了通用寄存器布局，同时各架构的 `trap.S` 负责保存/恢复架构特定寄存器。系统调用号的通用编号方案（Linux 编号）使得 `syscall/mod.rs` 中的分发表完全共享。

### 6.2 丰富的 VFS 抽象层次

VFS 抽象 `FileSystemBackend` trait 非常精简（约 20 个方法），却能支撑 8 种文件系统。`VfsFile` 层提供脏页缓存、小文件读缓存、预读等功能，对所有后端文件系统透明。

### 6.3 块设备 I/O 的双路径设计

非阻塞 I/O 路径在安全上下文（中断已使能）下运行，使用条件变量进行异步等待；同步回退路径用于不安全上下文（中断禁用时的页面错误处理等）。这种设计允许内核在大部分情况下利用中断驱动的 I/O，同时在必要情况下保持正确性。

### 6.4 稀疏 Tmpfs 实现

Tmpfs 的 `TmpfsSparseExtent` 使用重复模式优化全零区域，显著节省大文件的内存占用，是具有实际工程价值的优化。

### 6.5 用户 PTE 缓存

在 `page_table.rs` 中使用原子变量实现的单槽 PTE 缓存，用于加速 `UserBuffer` 的地址翻译。这是一种轻量级的性能优化，在比赛场景下（单核、批量测试）可能产生实际效果。

### 6.6 ASID 运行时探测

RISC-V `mm.rs` 在启动时通过写入/回读 SATP 寄存器的 ASID 位来自动检测硬件是否支持 ASID，从而决定是否启用 TLB 优化的延迟刷新路径。

### 6.7 手工构建的 vDSO ELF

完全在内核中手工构建 vDSO ELF 镜像（包括 ELF header、program header、dynamic section、symbol table、version table），并映射到用户空间固定地址，提供免系统调用的时钟访问。

### 6.8 条件编译的性能计数器

`perf.rs` 通过 `perf-counters` feature 条件编译，定义了 52 个性能剖析点和大量计数器。通过 `/proc/oskernel/perf` 暴露统计数据，为性能分析和比赛调优提供了系统化的工具。

---

## 七、已知限制与未完成部分

基于源码中的 `UNFINISHED` 注释和代码分析：

1. **SA_RESTART 信号处理不完整**：大多数被中断的系统调用返回 EINTR，而非自动重启
2. **文件系统同步语义**：O_DSYNC/O_SYNC 标志被接受但未实现真正的同步写回
3. **RLIMIT 未完全执行**：内存、调度器、fork 路径的资源限制仅存储但不强制执行
4. **网络设备无数据路径**：VirtIO 网络设备被发现但不处理实际数据包
5. **shmget 权限检查简化**：IPC 权限使用简化的能力检查模型
6. **LoongArch 无 ASID**：每次用户态返回都刷新整个 TLB
7. **Seccomp 过滤模式有限**：仅支持经典 BPF 指令的一小部分
8. **核心转储不完整**：core dump 状态位存在，但实际核心转储写入路径为最小实现
9. **挂载传播**：`uncloned_subtree_suffixes` 跟踪不完整

---

## 八、总结

WHUSP 是一个技术实现水平极高的比赛内核项目。它的主要优势在于：

1. **惊人的系统调用覆盖**：约 280 个系统调用号，几乎覆盖了 Linux 用户空间的主要 ABI 表面
2. **完整的文件系统栈**：8 种文件系统 + VFS 抽象 + 脏页缓存 + 块缓存，支持 EXT4、FAT、tmpfs、overlayfs 等实际场景
3. **双架构移植**：RISC-V 64 和 LoongArch 64 共享上层代码，架构差异隔离良好
4. **现代化的内核特性**：CFS 调度器、futex（含 PI）、seccomp、ptrace、vDSO、cgroup、inotify/fanotify、io_uring 基础支持
5. **详尽的 procfs**：几乎完整的 Linux /proc 接口，支持进程状态、系统信息、sysctl 等

设计上的权衡反映了比赛场景的务实选择：优先实现能通过 LTP 测试的兼容性接口，而非追求完整的通用实现。代码中大量的 `CONTEXT` 和 `UNFINISHED` 注释表明团队对自身实现局限有清晰的认识。

代码量约 77,000 行 Rust（不含 vendored 依赖），在宏内核比赛项目中属于中大型规模。代码组织清晰，模块划分合理，跨架构抽象层的设计体现了良好的工程实践。