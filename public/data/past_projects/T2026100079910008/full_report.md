# Ax OS 内核项目深度技术报告

## 一、分析过程与方法

本报告基于以下分析手段得出：

1. **静态源码审查**：逐文件阅读全部 127 个 Rust 源文件，覆盖所有 8 个子系统模块。
2. **编译验证**：成功执行了 RISC-V 64（`riscv64gc-unknown-none-elf`）和 LoongArch 64（`loongarch64-unknown-none`）双平台的 release 构建。
3. **符号与结构分析**：通过链接脚本、条件编译指令、trait 定义追踪架构抽象层的设计意图。
4. **接口分析**：通过系统调用表定义、VFS trait 接口、设备驱动 trait 等逆向推导出 Linux ABI 兼容策略。

---

## 二、编译测试结果

| 测试项 | 结果 | 详情 |
|--------|------|------|
| RISC-V 64 release 构建 | **成功** | 产出文件 `os/target/riscv64gc-unknown-none-elf/release/os`，大小约 1.6MB，ELF 64-bit LSB executable |
| LoongArch 64 release 构建 | **成功** | 产出文件 `os/target/loongarch64-unknown-none/release/os` |
| QEMU 运行测试 | **未执行** | 环境缺少 Docker 镜像 `zhouzhouyi/os-contest:20260104`，且 QEMU 需要特定磁盘镜像配置 |

RISC-V 构建产生 96 个警告（主要是未使用函数/方法警告），LoongArch 构建产生 101 个警告。无编译错误。

---

## 三、项目总体架构

### 3.1 代码规模统计

| 组件 | 代码行数 | 源文件数 |
|------|----------|----------|
| 内核核心 (`os/src/`) | 22,788 | 127 |
| ext4 适配库 (`edited_lib/ext4_rs/`) | 8,243 | 29 |
| ELF 解析库 (`edited_lib/rust-elf/`) | 12,492 | 18 |
| 用户态 init 程序 (`programs/init/`) | 273 | 1 |
| **总计** | **43,796** | **175** |

### 3.2 子系统划分与代码占比

| 子系统 | 代码行数 | 占比 | 职责 |
|--------|----------|------|------|
| filesystem | 6,691 | 29.4% | VFS 框架、ext4/tmpfs/devfs/procfs 文件系统、pipe、epoll |
| syscall | 5,342 | 23.4% | 92 个 Linux 兼容系统调用 |
| multitask | 3,316 | 14.5% | 进程/线程管理、调度、信号、futex、等待队列 |
| memory | 2,296 | 10.1% | Sv39 页表、物理页帧分配、地址空间、VMA、uaccess |
| basic | 1,844 | 8.1% | 控制台、日志、堆分配器、定时器、同步原语、调试支持 |
| arch | 1,781 | 7.8% | RISC-V 64 与 LoongArch 64 架构适配 |
| devices | 540 | 2.4% | VirtIO、PCI 设备扫描与块设备抽象 |
| trap | 497 | 2.2% | 陷阱/中断处理入口、页错误分类 |
| main.rs | 481 | 2.1% | 内核入口与初始化流程 |

---

## 四、各子系统详细拆解

### 4.1 架构抽象层（arch）

#### 4.1.1 接口层设计

`arch/interfaces/` 定义了五个核心 trait：

- **`Arch`**：架构入口 trait，定义 `INIT_EXEC_PATH`（init 程序路径）、关联类型（Regs/Basic/Chrono/UAccessRaw/Trap）以及 `_start()` 入口函数。
- **`Regs`**：寄存器操作接口，提供 `get_fp()`、`get_tp()`/`set_tp()`、`get_sp()`、`set_trap_handler()` 等方法。
- **`Basic`**：基础硬件操作接口，包含控制台 I/O、关机、TLB 刷新、halt 等。
- **`Chrono`**：时钟接口，提供 CPU tick 获取、时钟频率、定时器中断管理。
- **`Trap`**：陷阱处理接口，定义关联类型 `TrapContext` 及其行为，包含用户态/内核态陷阱入口、返回用户态、获取错误地址等。使用 `#[naked]` 函数完全手写汇编。
- **`UAccessRaw`**：用户态内存访问原语。

```rust
// arch/mod.rs - 条件编译选择架构
#[cfg(target_arch = "loongarch64")]
pub use loongarch64::LoongArch64 as Native;
#[cfg(target_arch = "riscv64")]
pub use riscv64::RiscV64 as Native;

pub type NativeRegs = <Native as interfaces::Arch>::Regs;
pub type NativeTrap = <Native as interfaces::Arch>::Trap;
// ... 等类型别名
```

#### 4.1.2 RISC-V 64 实现

**启动流程**（`_start`）：

1. 设置 `satp` 寄存器启用 Sv39 虚拟内存（使用 `BOOT_PAGE_TABLE` 引导页表）。
2. 引导页表同时映射低地址 `0x80000000` 和高地址 `0xffffffc080000000` 到同一物理地址（因为 Rust 编译器认为代码位于高虚拟地址，而硬件实际加载在低物理地址）。
3. 通过 `auipc + jr` 将 PC 从低地址跳转到高地址。
4. 设置栈指针 `sp = boot_stack_top`（128KB 启动栈）。
5. 跳转到 Rust `main` 函数。

```rust
// 引导页表，编译期常量求值
static BOOT_PAGE_TABLE: BootPageTable = const {
    let mut entries = [0; 512];
    // 低地址映射 (0x80000000): 2号巨型页，可执行
    entries[2] = PhysPageNum::<2>(2).mask() | VX;
    // 高地址映射: 256+2号巨型页，可读可写可执行
    entries[256 + 2] = PhysPageNum::<2>(2).mask() | VRWX;
    // VirtIO 设备 MMIO 区域映射
    entries[256 + 0] = PhysPageNum::<2>(0).mask() | VRWX;
    BootPageTable(entries)
};
```

**陷阱处理**（`trap.rs`）：

- 使用 `#[naked]` 函数 + `seq!` 宏批量生成寄存器保存/恢复代码。
- `trap_handler_raw_from_user`：从用户态陷入时的入口，执行栈切换（`csrrw sp, sscratch, sp`）、保存全部 31 个通用寄存器 + `sstatus` + `sepc`、将 `stvec` 切换到内核态版本、调用 `recover_task_pointer` 恢复 `tp`、调用 Rust `trap_handler`、最后跳转 `return_to_user`。
- `trap_handler_raw_from_kernel`：从内核态陷入的入口，不切换栈，直接在原内核栈上操作。
- `return_to_user`：恢复所有寄存器、将 `stvec` 切回用户态版本、执行 `sret` 返回。
- `TrapContext` 结构体包含 `Registers`（31 个寄存器）、`status`（sstatus）、`ret_pc`（sepc），按 16 字节对齐。
- 支持通过 `mcontext` 进行完整的用户态上下文保存/恢复（用于信号处理）。

```rust
// Trap 枚举 - 从 scause 寄存器解析
pub fn new() -> Self {
    match riscv::register::scause::read().cause() {
        riscv::interrupt::Trap::Interrupt(code) => Self::Interrupt(...),
        riscv::interrupt::Trap::Exception(code) => Self::Exception(...),
    }
}
```

**寄存器操作**：通过内联汇编直接读写 `tp`、`sp`、`fp`、`stvec` 等寄存器。

#### 4.1.3 LoongArch 64 实现

**启动流程**：利用 DMW（Direct Mapping Window）实现直接物理内存映射，无需引导页表。设置 DMW 寄存器、使能分页（`CRMD` 的 PG 位），直接跳转 `main`。设备树物理地址硬编码为 `0x100000`。

**陷阱处理**：使用 `CSR_SAVE0`（0x30）寄存器作为用户栈/内核栈交换媒介，通过 `csrwr` 实现原子交换。`ertn` 指令返回。陷阱上下文包含 `Registers`（31 个寄存器，但命名不同于 RISC-V）、`prmd`、`ret_pc`。

**页表差异**：LoongArch 的 `PTEFlagsNative` 使用 `NRead`/`NExecute` 负逻辑位（位 61/62），与 RISC-V 的正逻辑位不同。内核通过 `From` trait 在两种表示间转换。

**特殊处理**：LoongArch 支持浮点寄存器，在 `FloatingPointUnavailable` 异常中启用浮点单元。支持 `PageModifyFault`、`PageNonReadableFault`、`PageNonExecutableFault` 等额外页错误类型。

### 4.2 内存管理（memory）

#### 4.2.1 地址空间布局

采用 Sv39 三级页表（4KB + 2MB + 1GB），`PAGE_SHIFTS = [12, 21, 30]`。

**用户态（低 256GB）**：
- `0 ~ 4KB*2`：保留，用于检测空指针异常。
- `4KB*2 ~ ~256GB - 4KB*2`：用户常规内存（代码、堆、栈、mmap 区域）。
- `~256GB - 4KB*2 ~ 256GB`：保留区域，用于信号跳板页面。
- 用户栈位于最高处向下增长（`USER_STACK_BYTES = 2048 * 4KB = 8MB`），堆从数据段向上增长。
- `MMAP_START = 0x8_0000_0000`，`MMAP_END = 0x10_0000_0000`。
- `DYNAMIC_INTERPRETER_BASE = 0x12_0000_0000`（用于动态链接器的加载基址）。

**内核态（高 256GB，RISC-V: `0xffffffc000000000` 起）**：
- `0 ~ 16GB`（高地址偏移）：直接物理内存映射（1:1 映射到物理地址 0~16GB）。
- 内核态映射在所有地址空间共享（外层页表同一批物理页）。

**LoongArch 特殊处理**：使用 DMW 机制实现内核直接映射（偏移量 `0x1000000000000000`），天然免疫 Meltdown，无需 KPTI。

```rust
// RISC-V：高 256GB 的线性映射偏移
pub const LINEAR_MAPPING_OFFSET: usize = 0xffff_ffc0_0000_0000;
// LoongArch：DMW 偏移
pub const LINEAR_MAPPING_OFFSET: usize = 0x1000_0000_0000_0000;
```

#### 4.2.2 页表实现

`PageTable<LEVEL>` 是一个泛型结构体，`LEVEL` 取值为 0、1、2，分别对应叶子页表（4KB）、中间页表（2MB）、顶级页表（1GB）。

**关键设计**：
- 页表结构体 `#[repr(C)]` 且 `#[repr(align(4096))]`，保证内存布局与硬件一致。
- 使用 `Pin<Box<PageTable>>` 管理，防止页表在内存中移动（页表物理地址被写入 `satp` 等寄存器）。
- `map::<LEVEL>()` 方法支持大页映射，会遍历多级页表并在需要时分配中间页表。
- `new_table()` 创建顶级页表时自动填充内核直接映射区域（RISC-V：256~272 号 1GB 巨型页条目）。
- `at()`/`at_mut()` 方法通过多级遍历定位任意级别的页表项。
- `unmap()` 方法删除了用户态映射并释放中间页表。
- `deep_copy_user_part()` 用于 fork 时深拷贝用户态页表部分。

```rust
pub fn map<'a, const LEVEL: usize>(
    self: &'a mut Pin<Box<Self>>,
    from: VirtPageNum<LEVEL>,
    to: PhysPageNum<LEVEL>,
    flags: PTEFlags,
) -> Result<(), &'a mut PageTableEntry<LEVEL>> {
    // 自动添加 Valid 和 User 标志
    let flags = PTEFlagsNative::from(flags | PTEFlags::Valid | PTEFlags::User);
    // 遍历页表层级，按需分配中间表
    // ...
}
```

**PTEFlags 双架构兼容**：

RISC-V：`Valid | Read | Write | Execute | User | Global | Accessed | Dirty`（正逻辑）。

LoongArch：`Valid | Dirty | User | Global | NRead(bit61) | NExecute(bit62)`（Read/Execute 为负逻辑，Write 复用 Dirty 位）。通过 `From<PTEFlagsNative> for PTEFlags` 实现自动翻转转换。

#### 4.2.3 物理页帧分配器

基于 `buddy_system_allocator::FrameAllocator<ORDER=2>`（伙伴系统），在 `MEMORY_START (0x80000000)` 到 `MEMORY_END` 之间分配。RISC-V 可用 1GB（`MEMORY_SIZE = 0x40000000`），LoongArch 可用 768MB（`MEMORY_SIZE = 0x30000000`，另有低地址 256MB 添加到内核堆）。

分配失败时自动执行回收：
1. 遍历所有文件系统执行 writeback（回写脏页）和 inode GC。
2. 若仍失败，执行全量 DEntry GC 和缓存收缩。

```rust
pub fn try_alloc(&self, frame_count: usize) -> Option<PhysPageNum<0>> {
    try_alloc().or_else(|| {
        foreach_filesystem(|fs| {
            fs.writeback(NonZeroUsize::MAX);
            fs.gc_inode();
        });
        try_alloc()
    })
}
```

#### 4.2.4 地址空间管理（AddressSpace）

`AddressSpace` 管理一个进程的完整虚拟地址空间，核心数据结构：

- **`vmas: Vec<VirtualMemoryArea>`**：有序 VMA 列表（保证不重叠、升序排列、无零大小段）。选择有序数组而非平衡树是因为"不会有那么多 VMA 插入/删除"。
- **`page_table: PageTableBox<2>`**：顶级页表。
- **`brk: VirtAddr`**：当前堆顶。

**VMA 操作**：
- `add_vma()`：插入 VMA，自动合并相邻兼容的 VMA。
- `find_vma()`：二分查找包含指定地址的 VMA。
- `remove_vmas_between()`：删除范围内 VMA，支持部分重叠的自动拆分。
- `modify_vma_flags_between()`：修改范围内 VMA 标志，支持自动拆分。
- `set_brk()`：修改堆顶，同步更新 VMA 和页表映射。
- `mmap()`/`munmap()`：用户态内存映射的底层实现。
- `handle_page_fault()`：缺页处理，支持匿名页（分配零页）和文件映射页（从页缓存读取）。

**VMA 类型**：
- `Anonymous`：匿名映射，缺页时分配零页。堆、栈、.bss 段使用。
- `File { file, page_index }`：文件映射，缺页时从文件读取。

#### 4.2.5 用户态内存访问（uaccess）

提供安全的用户态内存拷贝函数：
- `copy_to_user()`/`copy_from_user()`：字节级拷贝，自动检查地址是否在用户空间。
- `copy_one_to_user()`/`copy_one_from_user()`：单个结构体拷贝。
- `copy_str_from_user()`：C 字符串拷贝。
- `fill_user_memory()`：填充用户态内存。

所有函数返回 `Result<(), CopyError>`，错误类型包括 `UserPointerNotInUserSpace`、`BadAccess`、`TooLong`、`CapacityOverflow`、`OutOfMemory`。

### 4.3 多任务管理（multitask）

#### 4.3.1 任务数据结构（Task）

`Task` 是内核中单个线程/进程的完整描述符，采用侵入式设计：

```rust
pub struct Task {
    pub kstack: TaskKernelStackPtr,       // 内核栈指针
    pub tid: usize,                        // 线程 ID
    pub policy: SchedulePolicy,            // 调度策略
    pub priority: TaskPriority,            // 优先级
    pub address_space: RwLock<Arc<RwLock<AddressSpace>>>,  // 地址空间
    pub files: Arc<RwLock<FileDescriptorTable>>,            // 文件描述符表
    pub fs_data: Arc<RwLock<FilesystemData>>,               // FS 上下文 (cwd等)
    pub process: Arc<ProcessData>,         // 进程级共享数据
    pub signal_handler: Arc<RwLock<SignalHandler>>,         // 信号处理器
    pub signals_wl: Mutex<SignalsWaitingList>,              // 信号等待队列
    pub robust_list_head: AtomicPtr<RobustListHead>,        // robust futex 链表
    pub children: Mutex<LinkedList<TaskAdapter>>,           // 子任务链表
    pub parent: RwLock<NonNull<Task>>,     // 父任务指针
    pub wait_state: Mutex<ZombieWaitingState>,              // 退出等待状态
    pub exit_signal: SignalId,             // 退出信号
    pub state: AtomicU8,                   // 任务状态
    pub time_stats: Mutex<TaskTimeStats>,  // 时间统计
    pub tid_address: AtomicPtr<c_int>,     // set_tid_address 地址
    // 定时器红黑树节点（侵入式）
    pub timer_rbtree_key: UnsafeCell<usize>,
    pub timer_rbtree_link: RBTreeLink,
    pub user_ids: Mutex<TaskUserIds>,      // UID/GID
    pub refcount: AtomicU32,               // 引用计数
    _pin: PhantomPinned,                   // 禁止移动
}
```

**关键设计决策**：
- `tp` 寄存器始终指向当前 `Task`（`#[repr(C)]` 不适用，使用 `PhantomPinned` 禁止移动）。
- 地址空间通过 `Arc<RwLock<AddressSpace>>` 共享：线程（`CLONE_VM`）共享同一个 Arc，进程拥有独立副本。
- 文件描述符表同理：`CLONE_FILES` 共享，否则 fork 时深拷贝。
- 进程级数据（`ProcessData`）包含 PID、PGID、信号分发、rlimits 等，使用 `Arc` 在线程间共享。

**任务状态**：
```rust
pub enum TaskState {
    Normal = 0,      // 可运行/正在运行
    Sleeping = 1,    // 可中断睡眠
    SleepingUninterruptible = 2,  // 不可中断睡眠
}
```

#### 4.3.2 Fork 实现

`Task::fork()` 根据 `CloneFlags` 执行不同的资源共享策略：

| CloneFlags | 行为 |
|------------|------|
| `VM` | 共享地址空间（不复制页表） |
| `FILES` | 共享文件描述符表 |
| `FS` | 共享文件系统上下文（cwd、umask） |
| `SIGHAND` | 共享信号处理器表 |
| `THREAD` | 子任务并入父任务线程组 |
| `PARENT` | 子任务的父进程设为当前进程的父进程 |
| `VFORK` | 无特殊处理（注释说明"约束的是用户而非操作系统"） |
| `SETTLS` | 设置子任务 TLS（tp 寄存器） |
| `CHILD_CLEARTID` | 退出时清零 ctid 并唤醒 futex |

不支持的标志：`NEWPID`、`NEWCGROUP` 等命名空间相关标志（会触发 `todo!()`）。

#### 4.3.3 Execve 实现

`Task::execve()` 流程：
1. 解析 ELF 文件头（使用 `edited_lib/rust-elf` 库）验证格式。
2. 检测 shebang（`#!`），支持脚本解释器递归（仅一层）。
3. 重置地址空间（新建页表，切换 `satp`）。
4. 加载 ELF 的 `PT_LOAD` 段到内存，建立对应 VMA。
5. 设置用户栈：压入 argv、envp、auxiliary vector（AT_PHDR、AT_PHENT、AT_PHNUM、AT_PAGESZ、AT_BASE、AT_ENTRY、AT_UID 等）。
6. 对于动态链接的 ELF，加载解释器（PT_INTERP），将解释器入口作为实际入口点。
7. 重置信号处理器为默认值、设置新进程名。
8. 通过架构相关的 `execute_init()` 跳转到用户态入口。

#### 4.3.4 调度器

采用可扩展的调度器框架：

```rust
pub trait Scheduler: Send + Sync {
    fn add_task(&mut self, task: TaskArc) -> Result<(), TaskArc>;
    fn pick_next(&mut self) -> Option<TaskArc>;
    fn on_time_interrupt(&mut self, task: &Task) -> Result<Option<TaskArc>, ()>;
}
```

`TaskScheduler` 维护一个调度器列表，按优先级尝试：
1. **RealtimeScheduler**：处理实时优先级（0~99），FIFO 和 RoundRobin 策略。
   - 100 个优先级队列（`VecDeque`）+ 位图加速（`BitArr`）。
   - FIFO：时钟中断不触发切换（跑到跑完）。
   - RoundRobin：每个时间片 128 个 tick，用完则轮转到同优先级下一个任务。
2. **IdleScheduler**（已注释掉）：理论上处理普通优先级（100~139）。

**上下文切换**：`TaskContext` 结构体保存被切换任务的 `ra`、`sp`、`s0`-`s11`（callee-saved 寄存器），使用 `switch_context()` 汇编函数实现栈的切换。

#### 4.3.5 信号处理

完整的 POSIX 信号子系统：

**信号 ID**：支持 `SIGHUP(1)` 到 `SIGSYS(31)` 共 31 种标准信号，以及 `SIGRTMIN` 实时信号。

**SignalHandler**：每个任务维护 32 个 `SignalAction`：
- `sa_handler`：简单处理函数指针（0=默认，1=忽略，其他=用户函数）。
- `sa_sigaction`：详细处理函数（SA_SIGINFO 标志设置时）。
- `sa_mask`：处理期间屏蔽的信号集。
- `sa_flags`：`SA_RESTART`、`SA_SIGINFO`、`SA_RESETHAND`、`SA_NODEFER`、`SA_RESTORER` 等。

**信号递送流程**（在 `trap_handler` 返回用户态前）：
1. 检查当前任务是否有待处理信号。
2. 调用 `SignalHandler::handle()` 判断处理方式：
   - `Terminate`：直接调用 `exit_group_kernel`。
   - `Ignored`：什么都不做。
   - `UserDefinedSimple/Detailed`：在用户栈上构造 sigframe，包含 `UContext`（含 `mcontext` 和 `mask`）和可选的 `SignalInfo`。
3. 修改 `TrapContext` 的 `ret_pc` 指向用户处理函数，`ra` 指向信号跳板（`signal_return_trampoline`）。
4. 信号跳板是一页用户态代码，调用 `rt_sigreturn` 系统调用（139）恢复上下文。

**sigreturn**：从用户栈读取 `UContext`，恢复 `mcontext` 中的寄存器和信号掩码。

#### 4.3.6 Futex 实现

支持五种 futex 操作：

| 操作 | 说明 |
|------|------|
| `FUTEX_WAIT` | 条件等待，原子比较 `*uaddr == val` 后休眠 |
| `FUTEX_WAKE` | 唤醒最多 `val` 个等待者 |
| `FUTEX_REQUEUE` | 唤醒部分等待者并将其余迁移到另一个 futex |
| `FUTEX_CMP_REQUEUE` | 与 REQUEUE 相同但先比较 `*uaddr == val3` |
| `FUTEX_WAIT_BITSET` | 带位掩码的选择性等待 |

**FutexKey**：唯一标识一个 futex，有三种类型：
- `Private { addr_space, uaddr }`：进程私有 futex（通过 Arc 防止 ABA）。
- `SharedFile { inode, offset }`：文件共享 futex。
- `SharedAnon { addr }`：匿名共享 futex（物理地址，假设不支持页面交换）。

使用 256 个哈希桶 (`FUTEX_BUCKET_COUNT`) 减少锁竞争。

#### 4.3.7 等待队列

`WaitQueue` 基于侵入式链表实现，支持：
- `wait()`：将当前任务加入等待队列并休眠。
- `sleep()`：进入 `Sleeping` 状态，可被信号中断。
- `sleep_uninterruptible()`：进入 `SleepingUninterruptible` 状态。
- `sleep_with_timeout()`：带超时的睡眠。
- `wake()`/`wake_all()`：唤醒等待者。

析构时自动唤醒所有剩余等待者。

#### 4.3.8 其他

- **PID 分配器**：基于位图的 `IdAllocator`，最大 8192 个 PID。
- **文件描述符表**：基于 `Vec` 的 `FileDescriptorTable`，支持 `CLOEXEC` 标志。
- **时间统计**：`TaskTimeStats` 跟踪用户态/内核态 CPU 时间（基于 CPU tick 计数器），支持子进程时间累加。

### 4.4 系统调用（syscall）

#### 4.4.1 系统调用分发框架

```rust
pub static TABLE: [Option<SyscallFn>; MAX_SYSCALL_COUNT] = const {
    // 编译期构造 512 项系统调用表
    // define!(id, func) 宏将函数指针填入表中
};
```

- 使用编译期常量求值（`const {}`）构造系统调用表，零运行时开销。
- `SyscallFn` 是一个 `#[repr(transparent)]` 包装的 `NonNull<()>`，通过内联汇编调用：
  ```rust
  asm!("jalr ra, {func}", ..., clobber_abi("C"));
  ```
- 系统调用分发在 `trap_handler` 中：从 `TrapContext` 提取 `a7`（系统调用号）和 `a0-a5`（参数），查表调用，返回值写入 `a0`。
- 支持 `ERRORCODE_SPECIAL_RESTART_SYSCALL` 机制：返回此值时 `ret_pc` 回退 4 字节，重新执行 `ecall` 指令。

#### 4.4.2 错误码系统

`SyscallResult` 实现了 `Try` trait，支持 `?` 运算符：
```rust
// VfsError 自动转换为对应的 errno
impl FromResidual<Result<Infallible, VfsError>> for SyscallResult {
    fn from_residual(residual: ...) -> Self {
        match residual.unwrap_err() {
            VfsError::FileNotFound => ENOENT,
            VfsError::NotADirectory => ENOTDIR,
            // ...
        }
    }
}
```

错误码常量（`err_codes` 模块）覆盖了 40+ 标准 errno（`ENOENT`、`EINVAL`、`ENOMEM`、`EFAULT`、`EAGAIN`、`EINTR`、`EPERM` 等）。

#### 4.4.3 已实现的系统调用清单（92 个）

**基础**（basic.rs）：`exit(93)`、`yield_(124)`、`times(153)`、`prlimit64(261)`、`getrlimit(163)`

**时钟**（clock.rs）：`clock_getres(114)`、`clock_gettime(113)`、`clock_settime(112)`

**epoll**（epoll.rs）：`epoll_create1(20)`、`epoll_ctl(21)`

**文件系统**（filesystem.rs - 35个）：`getcwd(17)`、`pipe2(59)`、`dup(23)`、`dup3(24)`、`chdir(49)`、`openat(56)`、`close(57)`、`getdents64(61)`、`read(63)`、`write(64)`、`linkat(37)`、`unlinkat(35)`、`mkdirat(34)`、`umount2(39)`、`mount(40)`、`fstat(80)`、`writev(66)`、`readv(65)`、`pread64(67)`、`pwrite64(68)`、`preadv(69)`、`pwritev(70)`、`fstatat(79)`、`fcntl(25)`、`statx(291)`、`splice(76)`、`sendfile(71)`、`ppoll(73)`、`ioctl(29)`、`lseek(62)`、`readlinkat(78)`、`symlinkat(36)`、`faccessat(48)`、`fchmod(52)`、`fchmodat(53)`、`ftruncate64(46)`、`fchownat(54)`、`fchown(55)`、`fadvise64_64(223)`、`utimensat(88)`

**内存**（memory.rs）：`brk(214)`、`mmap(222)`、`munmap(215)`、`mprotect(226)`、`madvise(233)`

**进程**（process.rs）：`getpid(172)`、`getppid(173)`、`gettid(178)`、`clone(220)`、`clone3(435)`、`execve(221)`、`wait4(260)`、`nanosleep(101)`、`set_tid_address(96)`、`exit_group(94)`、`setpgid(154)`、`getpgid(155)`

**信号**（signal.rs）：`rt_sigaction(134)`、`kill(129)`、`tgkill(131)`、`tkill(130)`、`rt_sigprocmask(135)`、`rt_sigtimedwait(137)`、`rt_sigreturn(139)`

**同步**（sync.rs）：`futex(98)`

**用户**（user.rs）：`getuid(174)`、`geteuid(175)`、`getgid(176)`、`getegid(177)`、`setresuid(147)`、`getresuid(148)`、`setresgid(149)`、`getresgid(150)`、`setreuid(145)`、`setregid(143)`、`setuid(146)`、`setgid(144)`

**杂项**（misc.rs）：`gettimeofday(169)`、`uname(160)`、`set_robust_list(99)`、`get_robust_list(100)`、`getrandom(278)`

### 4.5 文件系统（filesystem）

#### 4.5.1 VFS 框架

设计了一个完整的类 Unix VFS 抽象层，核心抽象：

**INode**（索引节点）：
```rust
pub struct INode<T: ?Sized + INodeOps = dyn INodeOps> {
    pub id: u32,                    // inode 编号
    pub fs: NonNull<FileSystem>,    // 所属文件系统
    pub(super) mem_refcount: AtomicU32,  // 内存引用计数
    pub(super) in_icache: SyncUnsafeCell<bool>,  // 是否在 icache 中
    pub(super) lru: LruNode<INode>, // LRU 链表节点
    pub data: RwLock<INodeData<T>>, // 可变数据
}

pub struct INodeData<T: ?Sized + INodeOps> {
    pub file_size: u64,
    pub hard_links: HardLinksType,
    pub mode: INodeMode,
    pub page_cache: Option<PageCache>,
    pub(in super::super) ops: T,    // 文件系统特定操作
}
```

`INodeOps` trait 定义了 12 个方法：`create`、`lookup`、`link`、`unlink`、`mkdir`、`rmdir`、`rename`、`symlink`、`read_symlink`、`make_node`、`get_kstat`、`evictable_when_mem_ref_zero`。

**DEntry**（目录项缓存）：
- `DEntry` 包含名称、父 DEntry 引用、对应的 INode（可能为 None，即负 DEntry）、挂载信息。
- `dentry_arc` 使用自定义引用计数（`AtomicU32`），支持 LRU 回收。
- `DEntryOps` trait 含 `open()` 方法（`devfs` 使用它来创建设备文件句柄）。

**File**（打开的文件）：
```rust
pub struct File<T: ?Sized + FileOps = dyn FileOps> {
    pub inode: NonNull<INode>,
    pub data: Mutex<FileData<T>>,
}

pub trait FileOps: Send + Sync {
    fn kread(&mut self, visitor: &mut dyn FnMut(&[u8]) -> VfsResult<u64>, len: u64) -> VfsResult<u64>;
    fn kwrite(&mut self, visitor: &mut dyn FnMut(&mut [MaybeUninit<u8>]) -> VfsResult<u64>, len: u64) -> VfsResult<u64>;
    fn fseek(&mut self, seek_from: SeekFrom) -> VfsResult<u64>;
    fn fsync(&mut self) -> VfsResult<()>;
    fn get_dir(&self, pos: u64) -> VfsResult<Option<IterateDirData>>;
    fn poll(&self) -> VfsResult<PollStatus>;
    fn ioctl(&mut self, cmd: IoctlCommand, arg: *mut ()) -> VfsResult<usize> { ... }
}
```

`read()`/`write()` 默认实现通过 `kread`/`kwrite` + uaccess 拷贝完成。

**FileSystem**：
- 包含根 DEntry、根 INode、icache（`HashMap<u32, ICacheArc>`）、块设备引用、挂载点。
- `FileSystemOps` trait 定义 `writeback_page` 和 `read_to_page` 两个底层 I/O 方法。

**Mount**：支持绑定挂载，`MountPoint::mount()` 可将一个文件系统的子树挂载到另一个文件系统的目录上。

**PageCache**：基于 `xarray` 的页缓存（以页索引为键），支持脏页回写和 LRU 回收。

**路径遍历**：
- `walk_path()`：从根目录或当前工作目录开始，逐级解析路径组件，处理 `.`、`..`、符号链接跟随、挂载点跨越。
- 返回 `WalkedPath::Positive(Path)` 或 `WalkedPath::Negative(NegativePath)`（最后一级不存在时）。

#### 4.5.2 ext4 文件系统适配

基于 `edited_lib/ext4_rs` 库实现：

- `Ext4INode` 包装了 `ext4_rs::Ext4InodeRef`，实现了 `INodeOps` 的全部 12 个方法。
- 目录操作（`create`、`lookup`、`link`、`unlink`、`mkdir`、`rmdir`）委托给底层 ext4 库的相应方法。
- `rmdir` 额外遍历目录所有块验证目录为空（检查除 `.` 和 `..` 外的条目）。
- `rename` 标记为 `todo!()`（未实现）。
- `Ext4File` 实现 `FileOps`，支持 `kread`/`kwrite` 通过 ext4 库的 `read_bytes`/`write_bytes` 操作文件。
- 文件读写使用页缓存加速（`INodeData.page_cache`）。

#### 4.5.3 tmpfs 内存文件系统

- 使用 `hashbrown::HashMap<Vec<u8>, INodeArc>` 存储目录条目。
- 文件内容存储在 `Vec<Vec<u8>>`（页粒度）中。
- 不支持硬链接（`hard_links` 始终为 1）。
- 完整的 `INodeOps` 实现：`create`、`lookup`、`link`（仅 `.` 和 `..`）、`unlink`、`mkdir`、`rmdir`、`symlink`、`read_symlink`。

#### 4.5.4 devfs 设备文件系统

- 静态根目录包含 `/dev/tty`、`/dev/urandom`、`/dev/null`、`/dev/zero` 四个设备文件。
- `Driver` trait（不同于 `FileOps`）定义了设备驱动的统一接口：`kread`、`kwrite`、`fseek`、`ioctl`、`fsync`。
- `DEntryOps::open()` 创建设备特定的 `File` 对象，绑定对应的静态 `Driver`。
- `DeviceId` 为 `(主设备号: u16, 次设备号: u32)` 二元组。
- 字符设备注册表 `CHAR_DEVICE_TYPES` 和块设备注册表 `BLOCK_DEVICE_TYPES` 使用 `HashMap<DeviceId, Box<dyn Driver>>`。

**已实现的设备驱动**：
- `TtyDriver`：输出到内核控制台，输入从控制台读取。
- `URandomDriver`：基于 ChaCha20 的随机数生成器。
- `NullDriver`：读取返回 0 字节，写入丢弃所有数据。
- `ZeroDriver`：读取返回零字节流，写入丢弃。

#### 4.5.5 procfs 进程信息文件系统

- 支持目录结构（`dir.rs` 实现 `DirINode`）。
- `/proc/meminfo`：返回硬编码的内存信息字符串（注明"这不属于 GPL 2 的保护范畴，因为其没有任何独创性"）。
- `simple.rs`：提供 `simple_file!` 宏快速创建只读文件。

#### 4.5.6 管道（pipe）

- 基于 `ringbuf::LocalRb<Array<u8, 4096>>` 环形缓冲区。
- `PipeReadFile`：实现读端 `FileOps`，`kwrite` 返回 `BadPipeEnd` 错误。
- `PipeWriteFile`：实现写端 `FileOps`，`kread` 返回 `BadPipeEnd` 错误。
- 支持原子写入（`len <= 4096` 时保证不与其他写入者交叉）。
- 读端关闭时写端收到 `BrokenPipe` 错误并发送 `SIGPIPE`。
- 写端关闭时读端返回 0（EOF）。
- 休眠通过 `yield_()` 实现（注释："假装睡眠"）。

#### 4.5.7 epoll

- `EPollFile` 维护 `HashMap<usize, EPollEvent>`（文件描述符到事件的映射）。
- 实现了 `epoll_create1`（支持 `CLOEXEC` 标志）和 `epoll_ctl`（ADD/DEL/MOD 操作）。
- `poll()` 方法标记为 `todo!()`，意味着 epoll_wait 的实际轮询机制尚未完整实现。

### 4.6 陷阱处理（trap）

**陷阱分发**（`trap_handler`）处理以下类型：

| 陷阱类型 | 处理方式 |
|----------|----------|
| `Syscall` | 查系统调用表，调用对应函数，写入返回值 |
| `TimerInterrupt` | 重置定时器中断，检查定时器红黑树，可能触发调度 |
| `LoadPageFault`/`StorePageFault`/`InstructionPageFault` | 用户态：尝试 VMA 缺页处理；内核态：检查 fixup 表（用于 uaccess），失败则 panic |
| `IllegalInstruction` | 用户态：发送 SIGILL；内核态：panic |
| `FloatingPointUnavailable`（LoongArch） | 启用浮点单元 |
| 其他 | `todo!()` panic |

**内核态缺页 fixup 机制**：uaccess 代码段的地址范围被记录在 `FIXUPS` 静态数组中（通过链接脚本标记 `suaccess_copy`/`euaccess_copy` 等符号），当内核在这些范围内发生缺页时，将 `sepc` 重定向到对应的错误处理地址，而不是直接 panic。

### 4.7 设备驱动（devices）

- **块设备抽象**：`BlockDevice` trait 定义 `block_size()`、`block_count()`、`read_block()`、`write_block()`、`device_id()`。
- **VirtIO 扫描**：通过设备树（FDT）扫描 `virtio,mmio` 兼容节点，使用 `virtio_drivers` crate 的 `MmioTransport` 初始化设备。支持 VirtIO 块设备（`VirtIOBlk`），网络设备标记为 TODO。
- **PCI 扫描**：`scan_pci_devices()` 实现了基本的 PCI 总线枚举（支持多功能设备），识别 VirtIO PCI 设备。
- **设备去重**：添加块设备时基于设备 ID 字符串或（块大小 + 块数量）去重。

### 4.8 基础设施（basic）

- **控制台**：`console.rs` 提供 `print!`/`println!` 宏，通过架构 `Basic::print_u8` 逐字符输出。同步通过自旋锁保护。
- **日志**：基于 `log` crate，支持 `info!`、`warn!`、`error!`、`debug!`、`trace!` 等级别。
- **堆分配器**：`GlobalAllocator` 包装 `buddy_system_allocator::Heap`，支持 `alloc`/`dealloc`。分配失败时自动执行文件系统 GC。在 debug 模式下维护分配追踪表检测 UAF 和布局不匹配。
- **同步原语**：
  - `Mutex<T>`：自旋锁 + 协作式 yield（检测死锁）。
  - `RwLock<T>`：基于 `AtomicU32` 的读写锁，写者优先（`WRITER_BIT = 1 << 31`）。支持 `downgrade()`（写锁降级为读锁）和 `temporary_release()`（临时释放写锁）。
- **定时器**：使用侵入式红黑树管理定时唤醒任务。`wake_task_when()` 将任务插入红黑树，`check_timers()` 在每次时钟中断时检查到期任务并唤醒。
- **调试**：`debugger.rs` 通过 `addr2line` 和 DWARF 调试信息实现 backtrace（仅 debug 模式）。
- **LRU 缓存**：`lru.rs` 提供侵入式 LRU 链表节点 `LruNode<T>`（用于 DEntry/INode 回收）。

---

## 五、各子系统交互关系

### 5.1 系统调用执行路径

```
用户态 ecall
  └─> trap_handler_raw_from_user (汇编，arch/riscv64/trap.rs)
      └─> trap_handler (trap/trap_handler.rs)
          └─> Trap::Exception(Exception::Syscall)
              └─> context.syscall_id() 提取 a7
              └─> syscall::TABLE[id].call(args) 查表调用
                  └─> 具体系统调用函数 (syscall/*.rs)
                      └─> VFS 层 (filesystem/vfs/*.rs)
                      └─> 内存管理 (memory/*.rs)
                      └─> 任务管理 (multitask/*.rs)
              └─> *context.ret_reg_mut() = ret_value
          └─> return_to_user (汇编)
```

### 5.2 缺页处理路径

```
硬件触发页错误异常
  └─> trap_handler
      └─> Trap::Exception(LoadPageFault | StorePageFault | InstructionPageFault)
          ├─> 内核态：
          │   ├─> 检查 FIXUPS 表 -> 命中则重定向 PC
          │   └─> 未命中 -> kernel_fault (panic)
          └─> 用户态：
              └─> try_handle_user_page_fault
                  └─> AddressSpace::handle_page_fault
                      ├─> 查找 VMA -> 不存在则 SIGSEGV
                      └─> 存在则根据 VMA 类型处理：
                          ├─> Anonymous -> 分配零页并映射
                          └─> File -> 从 PageCache 读取或触发磁盘 I/O
```

### 5.3 文件 I/O 路径

```
read(fd, buf, len) 系统调用
  └─> get_file_from_fd(fd)
  └─> file.data.lock().ops.read(user_buf, len)
      └─> FileOps::kread(visitor, len)
          ├─> ext4: Ext4File::kread -> INode 的 PageCache
          │   └─> PageCache 未命中 -> Ext4Fs::read_to_page
          │       └─> ext4_rs 库读取磁盘块
          ├─> tmpfs: 直接从 Vec<Vec<u8>> 读取
          ├─> devfs: Driver::kread (如 URandomDriver)
          └─> pipe: PipeReadFile::kread (环形缓冲区)
      └─> copy_to_user(user_buf, k_data)  // 拷贝到用户空间
```

### 5.4 进程创建路径

```
clone(flags, stack, ...) 系统调用
  └─> Task::fork(flags, ...)
      ├─> 分配 PID (PID_ALLOCATOR)
      ├─> 分配内核栈
      ├─> 根据 flags 共享或复制：
      │   ├─> 地址空间 (CLONE_VM)
      │   ├─> 文件描述符表 (CLONE_FILES)
      │   ├─> 信号处理器 (CLONE_SIGHAND)
      │   └─> 文件系统数据 (CLONE_FS)
      ├─> 设置子任务的 trap context
      ├─> 注册到 PID_TASK_MAP
      ├─> 添加到调度器
      └─> 返回子任务 TID
```

### 5.5 调度路径

```
时钟中断
  └─> trap_handler -> Interrupt::TimerInterrupt
      └─> reset_timer_interrupt()
      └─> check_timers()  // 检查定时器红黑树
      └─> TASK_SCHEDULER.lock().on_time_interrupt(cur_task)
          └─> RealtimeScheduler::on_time_interrupt
              ├─> FIFO: 返回 None (继续运行)
              └─> RoundRobin: 时间片用完则选择同优先级下一个
      └─> Task::switch_to(next_task)
          └─> switch_context(from_ctx, to_ctx)  // 汇编上下文切换
```

---

## 六、项目实现完整度评估

### 6.1 各子系统完整度

| 子系统 | 完整度 | 评级依据 |
|--------|--------|----------|
| **架构抽象** | 90% | RISC-V 和 LoongArch 的启动、陷阱、寄存器、时钟、TLB 均完整实现。LoongArch 浮点支持已实现。 |
| **内存管理** | 80% | Sv39 页表、伙伴分配器、VMA、mmap/munmap/mprotect/brk、缺页处理、COW（fork 时深拷贝）完整。缺少：页面交换、KSM、THP、NUMA。 |
| **多任务管理** | 85% | fork/clone/clone3/execve/wait4 完整，信号处理完整（含实时信号），futex 支持 5 种操作。缺少：cgroup、命名空间隔离。 |
| **调度器** | 60% | RealtimeScheduler (FIFO+RR) 完整。缺少：CFS/普通优先级调度、多核 SMP 支持、负载均衡。 |
| **文件系统** | 75% | VFS 框架完整（INode/DEntry/File/Mount/PageCache），ext4 大部分操作可用（rename 标记 todo），tmpfs/devfs/procfs 可用。缺少：ext4 写入完整验证、符号链接的 rename 支持。 |
| **系统调用** | 70% | 92 个系统调用覆盖主要类别。缺少：socket 相关调用、poll/select（ppoll 仅框架）、epoll_wait 的 poll 机制。 |
| **设备驱动** | 50% | VirtIO 块设备可用。缺少：网络设备驱动、GPU 驱动、USB 驱动、中断控制器编程。 |
| **同步原语** | 85% | Mutex/RwLock/WaitQueue/Futex 均实现。缺少：条件变量、屏障、读写信号量。 |

### 6.2 整体完整度

Ax 是一个**功能较为完整的宏内核原型**，实现了操作系统核心功能的主要路径：

- **能做的事**：从内核启动 -> 加载 init 程序 -> init fork 子进程 -> 子进程 execve shell -> shell 运行 busybox 命令的完整链路均已打通。
- **限定条件**：单核运行（SMP=1），不支持内核抢占。
- **主要缺失**：网络协议栈、完整的 SMP 支持、设备驱动框架（仅 VirtIO 块设备）。

---

## 七、设计创新性分析

### 7.1 架构创新

1. **双架构 trait 抽象**：通过 `Arch` trait + 条件编译实现了干净的架构隔离，RISC-V 和 LoongArch 的内核代码共享率极高（除 `arch/` 目录外所有代码均为架构无关代码）。这在 Rust OS 项目中较为罕见。

2. **`#[naked]` + `seq!` 宏的批量寄存器处理**：使用 Rust 的声明宏生成重复的寄存器保存/恢复指令，避免了手写冗长汇编或使用不太安全的 `global_asm!` 宏。例如：
   ```rust
   seq!(N in 3..=31 {
       naked_asm!(
           "sd x1, {REGS_OFFSET}(sp)",
           #(concat!("sd x", N, ", (", N, "-1)*8+{REGS_OFFSET}(sp)"),)*
           // ...
       );
   });
   ```

3. **编译期系统调用表**：使用 `const {}` 编译期求值构造 512 项系统调用表，完全消除了运行时初始化开销。

4. **LoongArch 的 NRead/NExecute 负逻辑设计**：内核内部使用统一的 `PTEFlags`（正逻辑），通过 `From` trait 自动转换为 LoongArch 硬件所需的负逻辑格式。

### 7.2 工程创新

1. **侵入式数据结构的广泛应用**：Task、INode、DEntry 等核心对象均使用侵入式链表/红黑树节点，避免了额外的堆分配和指针间接。

2. **无 KPTI 设计**（LoongArch）：利用 DMW 机制使内核映射天然不可被用户态访问，无需 KPTI 的开销。

3. **Fixup 表机制**：在内核访问用户态内存时，通过链接脚本标记 uaccess 代码段并使用 fixup 表优雅处理缺页，而非直接 panic。这是 Linux 内核中使用的成熟技术。

4. **`#[naked]` 信号跳板**：在用户态地址空间动态映射一页包含 `ecall` + `sigreturn` 的代码作为信号处理跳板，避免了依赖 libc 提供 `__restore_rt`。

### 7.3 创新性总结

Ax 的设计创新更多体现在**工程实现层面**而非理论创新。它在 Rust 语言约束下找到了多种优雅的解决方案（trait 抽象、编译期求值、宏生成汇编），整体架构清晰、代码组织合理。最突出的技术亮点是双架构（RISC-V + LoongArch）的无缝支持和编译期系统调用表。

---

## 八、其他补充信息

### 8.1 构建系统

- 使用 GNU Make 作为顶层构建系统。
- 链接脚本通过模板拼接（架构头部 + 通用 body）生成。
- Vendor 模式管理所有 Cargo 依赖（`os/vendor/` 包含 70+ crate）。
- Docker 容器化运行环境（镜像 `zhouzhouyi/os-contest:20260104`）。
- 支持 `MODE=release`（LTO fat + 单 codegen-unit）和 `MODE=debug` 模式。

### 8.2 用户态 init 程序

`programs/init/` 是一个独立的 `#![no_std]` Rust 程序：
- 直接通过内联汇编发起系统调用（`ecall` / `syscall 0`），不依赖任何 libc。
- 打开 `/dev/tty` 作为 stdin/stdout/stderr。
- Fork 子进程执行 busybox shell，运行测试脚本组（musl/glibc 基础测试、busybox 测试、libcbench、lua、libctest、LTP）。

### 8.3 代码质量

- 使用 `#![deny(unused_must_use)]` 防止忽略关键错误。
- 大量使用 `debug_assert!` 和 `static_assertions!` 进行编译期和运行时检查。
- 在 debug 模式下，堆分配器追踪所有分配检测 UAF 和布局不匹配。
- Mutex 在 debug 模式下检测死锁（记录持有者 TID）。
- 部分关键区域有详细的中文注释。

### 8.4 Rust Nightly 特性依赖

使用了约 48 个 Nightly-only 特性（`#![feature(...)]`），包括：
- `naked_functions`：手写汇编陷阱入口。
- `generic_const_exprs`、`adt_const_params`：编译期页表类型级编程。
- `allocator_api`：自定义分配器。
- `trait_upcasting`：trait 对象向上转型。
- `core_intrinsics`：内核级内存操作。
- 等等。

---

## 九、总结

Ax 是一个由单人开发、使用 Rust 语言从零构建的宏内核操作系统，同时支持 RISC-V 64 和 LoongArch 64 两种指令集架构。其约 22,788 行核心内核代码（加上适配库共约 44,000 行）覆盖了操作系统的主要子系统：

**优势**：
- 架构抽象设计优雅，双架构代码共享率高。
- VFS 框架设计完整，支持 ext4/tmpfs/devfs/procfs 四种文件系统。
- 92 个 Linux 兼容系统调用，覆盖进程管理、文件 I/O、内存映射、信号处理、futex 同步。
- 信号处理子系统实现完整，支持用户自定义处理函数和实时信号。
- futex 实现支持 WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAIT_BITSET 五种操作。
- 编译期系统调用表和引导页表，运行时开销极小。

**不足**：
- 调度器仅支持实时优先级（FIFO/RR），缺少普通进程调度策略和 SMP 支持。
- 网络协议栈完全缺失。
- epoll 的 poll 机制未完成（标记 `todo!()`）。
- ext4 的 `rename` 操作未实现。
- 无页面交换机制（物理内存不足时直接分配失败）。
- 无正式的内核测试框架。

**整体评价**：Ax 是一个在有限开发资源下取得了显著成果的 OS 内核项目。其代码组织清晰、架构合理、工程实践扎实，在 Rust OS 内核开发领域具有较强的参考价值。