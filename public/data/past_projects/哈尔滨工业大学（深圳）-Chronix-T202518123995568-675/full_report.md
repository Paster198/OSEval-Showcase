# Chronix 内核项目深度技术报告

## 1. 分析概述

本报告对 Chronix OS 内核项目进行了全面的源码级分析。分析范围覆盖：
- 项目整体架构与启动流程
- 全部 12 个子系统的实现细节
- 子系统间的交互关系
- 代码量统计与完整度评估
- 创新性分析

项目内核主体代码约 **36,669 行**（`os/src/`），硬件抽象层约 **4,516 行**（`hal/src/`），另有自定义工具 crate（`range-map`、`segment-tree`）。总计约 **41,000+ 行** Rust 代码。

---

## 2. 项目架构总览

### 2.1 整体架构

Chronix 是一个基于 Rust `async/await` 的宏内核，核心设计理念是将每个用户任务封装为一个 Rust Future，通过异步执行器统一调度。

```
用户态程序
    ↕ (trap/eret)
┌─────────────────────────────────────────────┐
│  trap_handler (异步)                         │
│    ↕                                         │
│  syscall 分发 (async fn)                     │
│    ↕                                         │
│  ┌──────┬──────┬──────┬──────┬──────┐       │
│  │  FS  │  MM  │  Net │ Proc │ Sig  │       │
│  └──┬───┴──┬───┴──┬───┴──┬───┴──┬───┘       │
│     ↓      ↓      ↓      ↓      ↓           │
│  ┌──────────────────────────────────┐       │
│  │  异步执行器 (executor)            │       │
│  │  ┌──────────────────────────┐    │       │
│  │  │  每核心任务队列 (SMP)     │    │       │
│  │  └──────────────────────────┘    │       │
│  └──────────────────────────────────┘       │
│     ↓                                       │
│  ┌──────────────────────────────────┐       │
│  │  HAL (硬件抽象层)                 │       │
│  │  riscv64 │ loongarch64           │       │
│  └──────────────────────────────────┘       │
└─────────────────────────────────────────────┘
```

### 2.2 代码量分布

| 子系统 | 目录 | 行数 | 占比 |
|--------|------|------|------|
| 系统调用 | `os/src/syscall/` | 8,558 | 23.3% |
| 文件系统 | `os/src/fs/` | 6,534 | 17.8% |
| 内存管理 | `os/src/mm/` | 3,108 | 8.5% |
| 网络 | `os/src/net/` | 3,384 | 9.2% |
| 任务管理 | `os/src/task/` | 2,494 | 6.8% |
| 设备与驱动 | `os/src/devices/` + `os/src/drivers/` | 3,498 | 9.5% |
| 信号 | `os/src/signal/` | 1,066 | 2.9% |
| 定时器 | `os/src/timer/` | 956 | 2.6% |
| 处理器/调度 | `os/src/processor/` | 812 | 2.2% |
| 同步原语 | `os/src/sync/` | 507 | 1.4% |
| 执行器 | `os/src/executor/` | 202 | 0.6% |
| 陷阱处理 | `os/src/trap/` | 237 | 0.6% |
| IPC | `os/src/ipc/` | 238 | 0.6% |
| 工具 | `os/src/utils/` | 566 | 1.5% |
| 其他 | `main.rs`, `config.rs`, `banner.rs`, `lang_items.rs` | 268 | 0.7% |
| HAL | `hal/src/` | 4,516 | - |

---

## 3. 启动流程

### 3.1 入口点

**文件**: `os/src/main.rs` (205 行)

内核入口通过 HAL 宏 `hal::define_entry!(pre_main)` 定义，汇编入口在 HAL 层（`hal/src/component/entry/`）。

RISC-V 平台的 `pre_main` 是一个 `#[naked]` 函数，执行以下步骤：

```rust
#[naked]
extern "C" fn pre_main(id: usize, first: bool) -> bool {
    unsafe {
        naked_asm!(
            // 1. 保存旧栈指针
            // 2. BSP: 调用 mm::init() 初始化内存
            //    AP: 调用 enable_kvm() 启用内核页表
            // 3. 切换到内核栈 (kernel_stack_bottom)
            // 4. 调用 main()
            // 5. 恢复旧栈并返回
        )
    }
}
```

### 3.2 初始化序列

`main()` 函数中，BSP（Bootstrap Processor）执行以下初始化：

```rust
fn main(id: usize, first: bool) -> bool {
    if first {
        banner::print_banner();
        processor::processor::init(id);   // 初始化处理器结构
        hal::trap::init();                // 初始化陷阱向量
        devices::init();                  // 初始化设备（PCI、块设备、网络设备）
        fs::init();                       // 初始化文件系统（注册+挂载）
        
        // 异步创建 init 进程
        task::schedule::spawn_kernel_task(async move {
            task::add_initproc();
        });

        #[cfg(feature = "smp")]
        processor_start(id);              // 唤醒其他核心
    } else {
        processor::processor::init(id);   // AP 初始化
        hal::trap::init();
    }
    
    unsafe { Instruction::enable_timer_interrupt(); }
    timer::set_next_trigger();
    executor::run_until_shutdown();       // 进入主调度循环
    false
}
```

---

## 4. 异步执行器子系统

**文件**: `os/src/executor/mod.rs` (202 行)

### 4.1 核心设计

Chronix 使用 `async_task` crate 构建自定义异步执行器。每个用户任务是一个 `UserTaskFuture`，每个内核任务是一个 `KernelTaskFuture`，它们都被 `spawn` 到执行器中。

### 4.2 任务队列

```rust
// 单核模式
pub struct TaskQueue {
    queue: SpinNoIrqLock<VecDeque<Runnable>>,
}

// 多核模式：每个 Processor 拥有独立的 TaskQueue
pub type TaskQueue = VecDeque<Runnable>;
```

### 4.3 调度策略

```rust
pub fn spawn<F>(future: UserTaskFuture<F>) -> (Runnable, Task<F::Output>) {
    let schedule = move |runnable: Runnable, info: ScheduleInfo| {
        if info.woken_while_running {
            TASK_QUEUE.push(runnable);        // 尾部入队（刚运行过）
        } else {
            TASK_QUEUE.push_preempt(runnable); // 头部入队（被外部唤醒，优先调度）
        }
    };
    async_task::spawn(future, WithInfo(schedule))
}
```

SMP 模式下，调度闭包根据 `cpu_mask_id` 将任务放入对应核心的队列。`cpu_mask_id == 4` 表示无 CPU 亲和性限制，使用轮转选择（`select_run_queue_index()`）。

### 4.4 主循环

```rust
pub fn run_until_shutdown() {
    loop {
        let _tasks = run_until_idle();
        if os_is_shutting_down() { break; }
    }
}

pub fn run_until_idle() -> usize {
    // SMP: 检查是否需要迁移任务
    if current_processor().need_migrate_check() {
        // 从当前队列尾部取出一个任务，迁移到目标核心
    }
    // 从当前核心队列头部取出任务并执行
    while let Some(runnable) = current_processor()
        .unwrap_with_mut_task_queue(|q| q.pop_front()) {
        runnable.run();
    }
}
```

### 4.5 系统状态管理

```rust
pub enum SystemStatus { Running = 0, ShutingDown = 1, Rebooting = 2 }
```

`do_shutdown()` 向除 init 进程外的所有进程发送 `SIGKILL`，等待所有进程退出后关闭系统。

---

## 5. 进程/任务管理子系统

### 5.1 任务控制块 (TCB)

**文件**: `os/src/task/task.rs` (967 行)

```rust
pub struct TaskControlBlock {
    // === 不可变字段 ===
    pub tid: TidHandle,
    pub leader: Option<Weak<TaskControlBlock>>,  // 线程组领导者
    pub is_leader: bool,

    // === 仅自身上下文可变 ===
    pub trap_context: UPSafeCell<TrapContext>,
    pub waker: UPSafeCell<Option<Waker>>,
    pub tid_address: UPSafeCell<TidAddress>,
    pub time_recorder: UPSafeCell<TimeRecorder>,
    pub robust: UPSafeCell<UserPtrRaw<RobustListHead>>,

    // === 原子字段 ===
    pub exit_code: AtomicUsize,
    pub task_status: SpinNoIrqLock<TaskStatus>,
    pub cpu_allowed: AtomicUsize,
    pub processor_id: AtomicUsize,
    pub priority: AtomicI32,
    pub ruid: AtomicI32, pub euid: AtomicI32, pub suid: AtomicI32,
    pub rgid: AtomicI32, pub egid: AtomicI32, pub sgid: AtomicI32,

    // === 共享可变字段 ===
    pub vm_space: UPSafeCell<Shared<UserVmSpace>>,
    pub parent: Shared<Option<Weak<TaskControlBlock>>>,
    pub children: Shared<BTreeMap<Pid, Arc<TaskControlBlock>>>,
    pub fd_table: Shared<FdTable>,
    pub thread_group: Shared<ThreadGroup>,
    pub pgid: Shared<PGid>,
    pub sig_manager: Shared<SigManager>,
    pub cwd: Shared<Arc<dyn Dentry>>,
    pub itimers: Shared<[ITimer; 3]>,
    pub posix_timers: Shared<BTreeMap<TimerId, PosixTimer>>,
    pub elf: Shared<Option<Arc<dyn File>>>,
}
```

### 5.2 线程组模型

```rust
pub struct ThreadGroup {
    members: BTreeMap<Tid, Weak<TaskControlBlock>>,
    alive: usize,
    pub group_exiting: bool,
    pub group_exit_code: usize,
}
```

Chronix 实现了 Linux 风格的线程组：同一进程内的线程通过 `leader` 字段指向线程组领导者，共享 `vm_space`、`fd_table`、`sig_manager` 等资源。

### 5.3 Clone 实现

`TaskControlBlock` 的 clone 方法实现了 Linux `clone()` 系统调用的核心逻辑，支持以下标志：

| 标志 | 行为 |
|------|------|
| `CLONE_VM` | 共享地址空间（线程）或 COW 克隆（进程） |
| `CLONE_FS` | 共享当前工作目录 |
| `CLONE_FILES` | 共享文件描述符表 |
| `CLONE_SIGHAND` | 共享信号处理器 |
| `CLONE_THREAD` | 创建线程（同一线程组） |
| `CLONE_PARENT` | 共享父进程 |
| `CLONE_CHILD_CLEARTID` | 子线程退出时清除 TID |
| `CLONE_CHILD_SETTID` | 设置子线程 TID 地址 |

### 5.4 任务调度集成

**文件**: `os/src/task/schedule.rs` (140 行)

```rust
pub struct UserTaskFuture<F: Future + Send + 'static> {
    pub task: Arc<TaskControlBlock>,
    env: EnvContext,
    future: F,
}

impl<F: Future + Send + 'static> Future for UserTaskFuture<F> {
    fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Self::Output> {
        let this = unsafe { self.get_unchecked_mut() };
        switch_to_current_task(current_processor(), &mut this.task, &mut this.env);
        let ret = unsafe { Pin::new_unchecked(&mut this.future).poll(cx) };
        switch_out_current_task(current_processor(), &mut this.env);
        ret
    }
}
```

每次 poll 时：
1. `switch_to_current_task`：设置当前处理器任务、切换页表、记录时间
2. 执行内部 future（`run_tasks`）
3. `switch_out_current_task`：保存环境上下文

`run_tasks()` 是用户任务的主循环：

```rust
pub async fn run_tasks(task: Arc<TaskControlBlock>) {
    task.set_waker(get_waker().await);
    loop {
        match task.get_status() {
            TaskStatus::Zombie => break,
            TaskStatus::Stopped => suspend_now().await,
            _ => {}
        }
        trap_return(&task, is_interrupted);           // 返回用户态
        is_interrupted = user_trap_handler().await;   // 处理陷阱（异步）
        task.check_and_handle(is_interrupted, old_a0); // 信号处理
    }
}
```

### 5.5 PELT 调度算法

**文件**: `os/src/processor/schedule.rs` (190 行)

参考 Linux CFS 实现了 PELT（Per-Entity Load Tracking）负载追踪：

```rust
pub struct TaskLoadTracker {
    pub last_update_time: u64,
    pub load_sum: u64,
    pub period_contribute: u32,
    pub load_avg: u32,
}
```

核心参数：
- `LOAD_AVG_PERIOD = 32`：衰减周期
- `DECLINE_TABLE[32]`：预计算的衰减因子表（定点数：高 10 位整数 + 低 22 位小数）
- `decay_load()`：实现指数衰减 `val * y^n`，其中 `y^32 ≈ 0.5`

负载均衡：

```rust
pub fn load_balance() -> bool {
    let (busiest_core, busiest_load) = loads.iter().max_by_key(|(_, l)| l).unwrap();
    let (idlest_core, idlest_load) = loads.iter().min_by_key(|(_, l)| l).unwrap();
    if busiest_load - idlest_load > LOAD_THRESHOLD {  // 阈值 = 10
        migrate_tasks(busiest_core, idlest_core);
    }
}
```

### 5.6 处理器管理

**文件**: `os/src/processor/processor.rs` (276 行)

```rust
pub struct Processor {
    id: usize,
    current: Option<Arc<TaskControlBlock>>,
    env: EnvContext,
    #[cfg(feature = "smp")]
    pub task_queue: Option<Shared<TaskQueue>>,
    #[cfg(feature = "smp")]
    pub sche_entity: Option<Shared<TaskLoadTracker>>,
    #[cfg(feature = "smp")]
    pub need_migrate: AtomicUsize,
    pub timeline: AtomicU64,
}
```

全局处理器数组：
```rust
pub static mut PROCESSORS: [Processor; MAX_PROCESSORS] = [const { Processor::new() }; MAX_PROCESSORS];
```

---

## 6. 内存管理子系统

### 6.1 物理帧分配器

**文件**: `os/src/mm/allocator/frame_allocator.rs` (182 行)

```rust
struct BitMapFrameAllocator {
    range: Range<PhysPageNum>,
    align_log2: usize,           // 默认 8（256 页对齐）
    inner: bitmap_allocator::BitAlloc16M,  // 支持最大 64GiB
    last: usize,
}
```

- 使用 `bitmap_allocator::BitAlloc16M` 位图分配器
- 支持对齐分配（`alloc_contiguous`）
- `FrameTracker` 使用 RAII 管理物理帧生命周期

### 6.2 SLAB 堆分配器

**文件**: `os/src/mm/allocator/slab_allocator.rs` (738 行)

```rust
pub struct SlabAllocatorInner {
    pub cache8:   SpinNoIrqLock<SmallSlabCache<8>>,
    pub cache16:  SpinNoIrqLock<SmallSlabCache<16>>,
    pub cache32:  SpinNoIrqLock<SmallSlabCache<32>>,
    pub cache64:  SpinNoIrqLock<SmallSlabCache<64>>,
    pub cache96:  SpinNoIrqLock<SmallSlabCache<96>>,
    pub cache128: SpinNoIrqLock<SmallSlabCache<128>>,
    pub cache192: SpinNoIrqLock<SlabCache<192>>,
    pub cache256: SpinNoIrqLock<SlabCache<256>>,
    pub cache512: SpinNoIrqLock<SlabCache<512>>,
    pub cache1024: SpinNoIrqLock<SlabCache<1024>>,
    pub cache2048: SpinNoIrqLock<SlabCache<2048>>,
    pub cache4096: SpinNoIrqLock<SlabCache<4096>>,
    pub cache8192: SpinNoIrqLock<SlabCache<8192>>,
}
```

- 小于等于 128 字节使用 `SmallSlabCache`（优化小对象分配）
- 192-8192 字节使用 `SlabCache`
- 大于 8192 字节直接回退到 `FrameAllocator`
- 内存不足时自动 `shrink()` 回收空闲 slab

### 6.3 用户虚拟内存空间

**文件**: `os/src/mm/vm/uvm.rs` (1228 行)

```rust
pub struct UserVmSpace {
    page_table: PageTable,
    areas: RangeMap<VirtPageNum, UserVmArea>,  // 自定义区间映射
    brk: Range<VirtAddr>,
}

pub struct UserVmArea {
    pub range_va: Range<VirtAddr>,
    pub vma_type: UserVmAreaType,   // Data, Heap, Stack, Mmap
    pub map_perm: MapPerm,
    frames: BTreeMap<VirtPageNum, StrongArc<FrameTracker>>,
    pub file: UserVmFile,           // None, File(Arc<dyn File>), Shm(Arc<ShmObj>)
    pub map_flags: MapFlags,        // SHARED
    pub offset: usize,
    pub len: usize,
}
```

#### 6.3.1 COW (Copy-on-Write)

```rust
fn clone_cow(&mut self, page_table: &mut PageTable) -> Result<Self, ()> {
    if !self.map_flags.contains(MapFlags::SHARED) && self.map_perm.contains(MapPerm::W) {
        for &vpn in self.frames.keys() {
            let (pte, _) = page_table.find_pte(vpn).unwrap();
            pte.set_writable(false);   // 清除写权限
            pte.set_dirty(false);
            unsafe { Instruction::tlb_flush_addr(vpn.start_addr().0); }
        }
    }
    Ok(Self { frames: self.frames.clone(), ... })  // 共享物理帧
}
```

#### 6.3.2 页错误处理

```rust
pub fn handle_page_fault(&mut self, page_table: &mut PageTable, vpn: VirtPageNum,
    access_type: PageFaultAccessType) -> Result<(), ()> {
    match page_table.find_pte(vpn) {
        Some((pte, _)) if pte.is_valid() => {
            // COW 写时复制
            if self.map_flags.contains(MapFlags::SHARED) {
                pte.set_writable(true);  // 共享映射直接恢复写权限
            } else {
                let old_frame = self.frames.get_mut(&vpn).unwrap();
                if old_frame.get_owners() > 1 {
                    let new_frame = frames_alloc(1).unwrap();
                    // 复制数据
                    new_frame.range_ppn.get_slice_mut::<usize>()
                        .copy_from_slice(old_frame.range_ppn.get_slice());
                    pte.set_ppn(new_frame.range_ppn.start);
                    old_frame.emplace(new_frame);
                }
                pte.set_writable(true);
            }
        }
        _ => {
            // 懒分配：根据 VMA 类型分发
            match self.vma_type {
                UserVmAreaType::Data  => UserDataHandler::handle_lazy_page_fault(...),
                UserVmAreaType::Stack => UserStackHandler::handle_lazy_page_fault(...),
                UserVmAreaType::Heap  => UserHeapHandler::handle_lazy_page_fault(...),
                UserVmAreaType::Mmap  => UserMmapHandler::handle_lazy_page_fault(...),
            }
        }
    }
}
```

#### 6.3.3 ELF 加载

`from_elf()` 完成完整的 ELF 加载流程：
1. 从内核空间克隆基础映射（trampoline 等）
2. 解析 ELF program headers，映射 Load 段
3. 加载动态链接器（`_dl_interp`）
4. 构建辅助向量（auxv）：`AT_PHENT`, `AT_PHNUM`, `AT_PAGESZ`, `AT_ENTRY`, `AT_BASE`, `AT_RANDOM`, `AT_UID`, `AT_CLKTCK` 等
5. 映射用户栈
6. 设置 brk 起始地址

#### 6.3.4 mmap 系列操作

- `mmap`：支持匿名映射、文件映射、SHM 映射，MAP_SHARED/MAP_PRIVATE
- `munmap`：支持部分取消映射，自动分割 VMA
- `mremap`：支持原地扩展、移动映射
- `mprotect`：修改映射权限

### 6.4 内核虚拟内存空间

**文件**: `os/src/mm/vm/kvm/riscv64.rs` (315 行), `loongarch64.rs` (185 行)

管理内核映射：代码/数据段、Trampoline 页、内核栈、MMIO 映射。`to_user()` 方法从内核空间创建新的用户空间，继承 trampoline 等必要映射。

---

## 7. 文件系统子系统

### 7.1 VFS 架构

**文件**: `os/src/fs/vfs/` (约 1,142 行)

#### 7.1.1 核心 Trait

```rust
pub trait Dentry: Send + Sync {
    fn dentry_inner(&self) -> &DentryInner;
    fn new(&self, name: &str, parent: Option<Arc<dyn Dentry>>) -> Arc<dyn Dentry>;
    fn open(self: Arc<Self>, flags: OpenFlags) -> Option<Arc<dyn File>>;
    fn inode(&self) -> Option<Arc<dyn Inode>>;
    fn load_child_dentry(self: Arc<Self>) -> Result<Vec<Arc<dyn Dentry>>, SysError>;
    // ...
}

pub trait Inode: Send + Sync {
    fn lookup(&self, name: &str) -> Option<Arc<dyn Inode>>;
    fn create(&self, name: &str, mode: InodeMode) -> Result<Arc<dyn Inode>, SysError>;
    fn read_at(&self, offset: usize, buf: &mut [u8]) -> Result<usize, SysError>;
    fn write_at(&self, offset: usize, buf: &[u8]) -> Result<usize, SysError>;
    fn getattr(&self) -> Kstat;
    fn setattr(&self, attr: &Kstat) -> Result<(), SysError>;
    fn cache_read_at(&self, offset: usize, buf: &mut [u8]) -> Result<usize, SysError>;
    fn cache_write_at(&self, offset: usize, buf: &[u8]) -> Result<usize, SysError>;
    // ...
}

pub trait File: Send + Sync {
    fn read(&self, buf: &mut [u8]) -> Result<usize, SysError>;
    fn write(&self, buf: &[u8]) -> Result<usize, SysError>;
    fn ioctl(&self, cmd: u32, arg: usize) -> Result<usize, SysError>;
    fn poll(&self, events: PollEvents) -> PollEvents;
    fn seek(&self, offset: isize, whence: SeekFrom) -> Result<usize, SysError>;
    // ...
}

pub trait FSType: Send + Sync {
    fn name(&self) -> &str;
    fn mount(&self, source: &str, parent: Option<Arc<dyn Dentry>>,
             flags: MountFlags, dev: Option<Arc<dyn Device>>)
             -> Result<Arc<dyn Dentry>, SysError>;
}
```

#### 7.1.2 Dentry 缓存

```rust
pub static DCACHE: SpinNoIrqLock<BTreeMap<String, Arc<dyn Dentry>>> = ...;
```

全局 Dentry 缓存使用路径字符串作为键。`find()` 先查缓存，未命中则 `walk()` 逐级搜索。路径规范化处理 `.`、`..`、空组件。

### 7.2 Ext4 文件系统

**文件**: `os/src/fs/ext4/` (约 1,137 行)

基于 `lwext4_rust`（lwext4 的 Rust 绑定）实现：

```rust
pub struct Ext4Inode {
    inner: InodeInner,
    file: SpinNoIrqLock<Ext4File>,
    cache: Arc<PageCache>,
}
```

- `lookup()` 支持查找普通文件、目录和符号链接
- 集成了页缓存（`PageCache`）
- `read_at()` / `write_at()` 通过 lwext4 C 绑定执行实际 I/O

### 7.3 FAT32 文件系统

**文件**: `os/src/fs/fat32/` (约 767 行)

基于 `fatfs` crate 实现，结构与 Ext4 类似，用于 SD 卡等 FAT32 格式设备。

### 7.4 TmpFS

**文件**: `os/src/fs/tmpfs/` (约 685 行)

纯内存文件系统，数据存储在内存帧中，挂载在 `/tmp`。实现了完整的 `TmpFsInode`，支持读写、创建子文件/目录、truncate 等操作。

### 7.5 ProcFS

**文件**: `os/src/fs/procfs/` (约 800 行)

虚拟文件系统，提供以下伪文件：

| 路径 | 功能 |
|------|------|
| `/proc/cpuinfo` | CPU 信息 |
| `/proc/meminfo` | 内存信息 |
| `/proc/interrupt` | 中断计数 |
| `/proc/mounts` | 挂载信息 |
| `/proc/self/exe` | 当前进程可执行文件链接 |
| `/proc/self/fd/` | 文件描述符目录 |
| `/proc/self/maps` | 内存映射信息 |
| `/proc/sys/fs/` | 文件系统参数 |
| `/proc/sys/kernel/` | 内核参数 |

### 7.6 DevFS

**文件**: `os/src/fs/devfs/` (约 2,195 行)

| 设备节点 | 行数 | 功能 |
|----------|------|------|
| `/dev/null` | 192 | 空设备 |
| `/dev/zero` | 121 | 零设备 |
| `/dev/urandom` | 178 | 随机数设备 |
| `/dev/tty` | 443 | 终端设备（行编辑、回显、信号生成） |
| `/dev/rtc` | 206 | 实时时钟 |
| `/dev/loop*` | 375 | 回环设备（loop mount） |
| `/dev/cpu_dma_latency` | 114 | CPU DMA 延迟 |
| `/dev/superblock` | - | 超级块信息 |

### 7.7 PipeFS

**文件**: `os/src/fs/pipe.rs` (244 行), `pipefs.rs` (372 行)

管道实现，使用环形缓冲区，支持 `read`/`write`/`poll`/`splice`，正确处理管道两端关闭的情况。

### 7.8 页缓存

**文件**: `os/src/fs/page/` (约 190 行)

```rust
pub struct PageCache {
    pages: SpinNoIrqLock<BTreeMap<usize, Arc<Page>>>,
    end: AtomicUsize,
}

pub struct Page {
    offset: usize,
    frame: FrameTracker,
    dirty: AtomicBool,
}
```

以 4KiB 页为单位缓存文件数据，支持读时按需加载、写时标记脏页。

### 7.9 文件系统初始化

```rust
pub fn init() {
    register_all_fs();  // 注册 ext4, devfs, procfs, tmpfs
    let diskfs_root = diskfs.mount("/", None, ...);  // 根文件系统
    mount("sdcard", diskfs_root);  // /sdcard
    mount("dev", diskfs_root);     // /dev
    mount("proc", diskfs_root);    // /proc
    mount("tmp", diskfs_root);     // /tmp
}
```

---

## 8. 网络子系统

### 8.1 总体架构

**文件**: `os/src/net/` (约 3,384 行)

基于 `smoltcp` 网络栈实现。

```rust
struct InterfaceWrapper {
    name: &'static str,
    ether_addr: EthernetAddress,
    dev: SpinNoIrqLock<NetDeviceWrapper>,
    iface: SpinNoIrqLock<Interface>,
}
```

TCP/UDP 缓冲区大小均为 64KiB。

### 8.2 TCP Socket

**文件**: `os/src/net/tcp.rs` (687 行)

```rust
pub struct TcpSocket {
    state: AtomicU8,                    // Closed/Busy/Connecting/Connected/Listening
    handle: UPSafeCell<Option<SocketHandle>>,
    local_endpoint: UPSafeCell<Option<IpEndpoint>>,
    remote_endpoint: UPSafeCell<Option<IpEndpoint>>,
    nonblock_flag: AtomicBool,
    shutdown_flag: UPSafeCell<u8>,
    reuse_addr_flag: AtomicBool,
    timeout: SpinNoIrqLock<Option<TimeSpec>>,
}
```

支持完整的 TCP 生命周期：connect、listen、accept、send、recv、shutdown（半关闭）。使用 Listen Table 管理端口分配。

### 8.3 UDP Socket

**文件**: `os/src/net/udp.rs` (341 行)

支持 `sendto()`/`recvfrom()`，非阻塞模式，端口复用。

### 8.4 Raw Socket

**文件**: `os/src/net/raw.rs` (195 行)

支持原始 IP 数据包的发送和接收。

### 8.5 SocketPair

**文件**: `os/src/net/socketpair.rs` (295 行)

Unix 域套接字对，用于本地进程间通信。

### 8.6 加密套接字 (AF_ALG)

**文件**: `os/src/net/crypto.rs` (650 行)

实现 Linux `AF_ALG` 套接字接口：

```rust
pub enum AlgType {
    Acomp,      // 异步压缩
    Aead,       // 认证加密（ChaCha20-Poly1305）
    Akcipher,   // 非对称加密
    Hash,       // 哈希函数（HMAC、SHA）
    Skcipher,   // 对称加密（AES-128、Salsa20）
    Kpp,        // 密钥交换
    // ...
}
```

使用 `polyval`、`aes`、`salsa20` 等 Rust 加密库实现。

### 8.7 网络设备驱动

- **VirtIO Net** (`os/src/drivers/net/virtio_net.rs`, 183 行)：基于 `virtio_drivers` crate，32 队列深度
- **Loopback** (`os/src/drivers/net/loopback.rs`, 99 行)：回环设备

---

## 9. 系统调用子系统

### 9.1 系统调用分发

**文件**: `os/src/syscall/mod.rs` (573 行)

定义了约 **200 个**系统调用 ID（`SyscallId` 枚举），覆盖 Linux RISC-V 64 位 ABI。所有系统调用都是 `async` 函数。

### 9.2 系统调用覆盖范围

| 类别 | 文件 | 行数 | 主要系统调用 |
|------|------|------|-------------|
| 文件系统 | `fs.rs` | 1,683 | openat, close, read, write, pread, pwrite, readv, writev, lseek, sendfile, getdents, mkdir, unlinkat, linkat, symlinkat, renameat2, fstat, statx, fchmod, fchown, faccessat, readlinkat, splice, tee, vmsplice |
| I/O 多路复用 | `io.rs` | 1,226 | epoll_create1, epoll_ctl, epoll_pwait, epoll_pwait2, pselect6, ppoll |
| 网络 | `net.rs` | 1,737 | socket, bind, listen, accept, accept4, connect, sendto, recvfrom, sendmsg, recvmsg, sendmmsg, setsockopt, getsockopt, shutdown, socketpair |
| 进程管理 | `process.rs` | 810 | clone, clone3, exec, waitpid, exit, exit_group, getpid, getppid, gettid, setpgid, getpgid, setsid, uname, prlimit64, prctl, setuid/gid |
| 内存管理 | `mm.rs` | 622 | brk, mmap, munmap, mprotect, mremap, msync, mlock, munlock, madvise, mincore |
| 时间 | `time.rs` | 820 | clock_gettime, clock_getres, clock_nanosleep, gettimeofday, nanosleep, timer_create/settime/gettime/delete, timerfd_create/settime/gettime, setitimer, getitimer, times |
| 信号 | `signal.rs` | 434 | rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigsuspend, rt_sigtimedwait, rt_sigreturn, kill, tkill, tgkill, sigaltstack |
| Futex | `futex.rs` | 639 | futex (WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP), set_robust_list, get_robust_list |
| 调度 | `sche.rs` | 235 | sched_yield, sched_setaffinity, sched_getaffinity, sched_setscheduler, sched_getscheduler, setpriority, getpriority |
| 杂项 | `misc.rs` | 472 | sysinfo, getrandom, uname, sethostname, setdomainname, capget, capset, personality, acct, syslog |
| IPC | `ipc/sysv.rs` | 142 | shmget, shmctl, shmat, shmdt, msgget, msgctl, msgsnd, msgrcv |

### 9.3 Futex 实现细节

**文件**: `os/src/syscall/futex.rs` (639 行)

```rust
pub async fn sys_futex(uaddr: usize, futex_op: i32, val: u32,
    timeout: SendWrapper<*const TimeSpec>, uaddr2: usize, val3: u32) -> SysResult
```

支持的操作：
- `FUTEX_WAIT` / `FUTEX_WAIT_BITSET`：等待，支持超时和信号中断
- `FUTEX_WAKE`：唤醒指定数量的等待者
- `FUTEX_REQUEUE`：重新排队等待者
- `FUTEX_CMP_REQUEUE`：条件重新队列
- `FUTEX_WAKE_OP`：原子唤醒操作

Futex 键支持 `Private`（虚拟地址 + 地址空间指针）和 `Shared`（物理地址）两种模式。

支持 Robust List（`set_robust_list`/`get_robust_list`），用于进程退出时自动解锁 futex。

### 9.4 Epoll 实现

**文件**: `os/src/syscall/io.rs` (1,226 行)

完整的 epoll 实现：
- `epoll_create1`：创建 epoll 实例
- `epoll_ctl`：添加/修改/删除监听事件
- `epoll_pwait`/`epoll_pwait2`：等待事件，支持超时和信号掩码
- 支持 `EPOLLIN`, `EPOLLOUT`, `EPOLLERR`, `EPOLLHUP`, `EPOLLET`, `EPOLLONESHOT`

---

## 10. 信号子系统

### 10.1 信号定义

**文件**: `os/src/signal/mod.rs` (234 行)

支持全部 31 个标准信号（SIGHUP 到 SIGSYS）和 33 个实时信号（SIGRTMIN=32 到 SIGRTMAX=64）。

```rust
pub struct SigInfo {
    pub si_signo: usize,
    pub si_code: i32,     // USER, KERNEL, QUEUE, TIMER, MESGQ, ASYNCIO, SIGIO, TKILL
    pub si_pid: Option<usize>,
}
```

### 10.2 信号动作

**文件**: `os/src/signal/action.rs` (77 行)

```rust
pub struct KSigAction {
    pub sa_handler: usize,
    pub sa_flags: usize,      // SA_SIGINFO, SA_RESTART, SA_NODEFER, SA_RESETHAND, SA_ONSTACK
    pub sa_restorer: usize,
    pub sa_mask: SigSet,
}
```

### 10.3 信号管理器

**文件**: `os/src/signal/manager.rs` (245 行)

```rust
pub struct SigManager {
    pub actions: [KSigAction; 64],
    pub blocked_sigs: SigSet,
    pub pending: SigPending,
    pub pending_flag: SigSet,
}
```

### 10.4 信号处理流程

信号处理在 `check_and_handle()` 中执行（每次从内核返回用户态前）：
1. 检查待处理信号（排除被阻塞的）
2. 根据信号动作执行：默认处理（终止/忽略/停止/继续）或用户自定义处理函数
3. 用户处理函数通过修改 trap context 实现：在用户栈上构建 `sigframe`，跳转到 handler
4. `rt_sigreturn` 恢复原始上下文

### 10.5 消息队列

**文件**: `os/src/signal/msg_queue.rs` (384 行)

实现了 System V 消息队列（`msgget`, `msgsnd`, `msgrcv`, `msgctl`）。

---

## 11. IPC 子系统

### 11.1 System V 共享内存

**文件**: `os/src/ipc/sysv/shm.rs` (218 行)

```rust
pub struct ShmObj {
    id: usize,
    pub shmid_ds: SpinNoIrqLock<ShmIdDs>,
    cache: PageCache,
}

pub struct ShmIdDs {
    pub perm: IpcPerm,
    pub segsz: usize,
    pub atime: usize, pub dtime: usize, pub ctime: usize,
    pub cpid: usize, pub lpid: usize,
    pub nattch: usize,
}
```

- `ShmManager` 管理所有共享内存段
- `ShmIdAllocator` 分配/回收 SHM ID
- 共享内存通过 `PageCache` 存储数据
- 与 `mmap` 集成：`UserVmFile::Shm` 类型

支持：`shmget`, `shmat`, `shmdt`, `shmctl`

---

## 12. 设备与驱动子系统

### 12.1 设备管理器

**文件**: `os/src/devices/manager.rs` (287 行)

```rust
pub struct DeviceManager {
    devices: BTreeMap<(DeviceMajor, usize), Arc<dyn Device>>,
}
```

统一管理块设备、网络设备、串口设备，支持按名称和类型查找，支持 IRQ 分发。

### 12.2 块设备驱动

| 驱动 | 文件 | 行数 | 说明 |
|------|------|------|------|
| VirtIO Block | `drivers/block/virtio_blk/` | 264 | RISC-V 和 LoongArch 分别实现 |
| MMIO Block | `drivers/block/mmio_blk.rs` | 100 | MMIO 块设备 |
| PCI Block | `drivers/block/pci_blk.rs` | 111 | PCI 块设备 |
| MMC/SDIO | `drivers/block/mmc/` | 1,226 | SD 卡驱动，含 DMA 和寄存器定义 |

### 12.3 网络设备驱动

| 驱动 | 文件 | 行数 | 说明 |
|------|------|------|------|
| VirtIO Net | `drivers/net/virtio_net.rs` | 183 | 32 队列深度 |
| Loopback | `drivers/net/loopback.rs` | 99 | 回环设备 |

### 12.4 其他设备

| 组件 | 文件 | 行数 | 说明 |
|------|------|------|------|
| 串口 UART | `drivers/serial/` | 450 | UART 驱动 |
| PCI 总线 | `devices/pci.rs` | 332 | PCI 设备枚举和配置空间访问 |
| PLIC | `devices/plic.rs` | 96 | RISC-V 中断控制器 |
| DMA | `drivers/dma/` | 152 | VirtIO DMA 映射 |
| 网络设备包装 | `devices/net.rs` | 359 | smoltcp Device trait 适配 |
| 缓冲区缓存 | `devices/buffer_cache.rs` | 148 | 块设备缓冲区 |
| MMIO | `devices/mmio.rs` | 61 | MMIO 地址管理 |
| SDIO | `devices/sdio.rs` | 23 | SDIO 接口 |

---

## 13. 同步原语子系统

### 13.1 SpinMutex

**文件**: `os/src/sync/mutex/spin_mutex.rs` (131 行)

```rust
pub struct SpinMutex<T: ?Sized, S: MutexSupport> {
    owner: AtomicUsize,
    _marker: PhantomData<S>,
    data: UnsafeCell<T>,
}
```

- 支持 `Spin`（纯自旋）和 `SpinNoIrq`（关中断）两种策略
- 死锁检测：自旋超过 `0x1000000` 次时 panic
- `MutexGuard` 标记为 `!Send` 和 `!Sync`，防止跨 await 点持有锁

### 13.2 SpinRwMutex

**文件**: `os/src/sync/mutex/spin_rw_mutex.rs` (182 行)

读写锁实现，支持多读者或单写者。

### 13.3 UPSafeCell

**文件**: `os/src/sync/up.rs` (66 行)

单核安全的内部可变性容器，在单核场景下替代 `RefCell`，多核场景下需要外部同步。

---

## 14. 定时器子系统

### 14.1 定时器管理器

**文件**: `os/src/timer/timer.rs` (502 行)

支持多种定时器：
- **内核定时器**：`Timer` + `TimerEvent`，基于 BTreeMap 管理
- **ITimer**：`ITIMER_REAL`, `ITIMER_VIRTUAL`, `ITIMER_PROF`
- **POSIX 定时器**：`timer_create` 系列
- **TimerFD**：`timerfd_create` 系列

### 14.2 定时任务

**文件**: `os/src/timer/timed_task.rs` (89 行)

`suspend_timeout()`：异步超时挂起，用于 `nanosleep`、`futex` 超时等场景。

### 14.3 时间记录

**文件**: `os/src/timer/recoder.rs` (90 行)

记录每个任务的用户态时间、内核态时间，用于 `times()`、`getrusage()` 等系统调用。

---

## 15. 陷阱处理子系统

**文件**: `os/src/trap/mod.rs` (237 行)

### 15.1 用户态陷阱处理

```rust
pub async fn user_trap_handler() -> bool {
    set_kernel_trap_entry();
    let (trap_type, epc) = TrapType::get_debug();
    unsafe { Instruction::enable_interrupt() };
    match trap_type {
        TrapType::Breakpoint => { /* 发送 SIGTRAP */ }
        TrapType::Syscall => {
            let result = syscall(cx.syscall_id(), [...]).await;  // 异步系统调用
            cx.set_ret_nth(0, result as usize);
        }
        TrapType::StorePageFault(stval) | ... => {
            task.with_mut_vm_space(|vm| vm.handle_page_fault(va, access_type));
        }
        TrapType::IllegalInstruction(_) => { /* 发送 SIGILL */ }
        TrapType::Timer => {
            TIMER_MANAGER.check();
            set_next_trigger();
            yield_now().await;  // 时间片轮转
        }
        TrapType::ExternalInterrupt => {
            DEVICE_MANAGER.handle_irq();
        }
    }
}
```

关键设计：系统调用处理是异步的，定时器中断触发 `yield_now().await` 实现时间片轮转。

### 15.2 trap_return

```rust
pub fn trap_return(task: &Arc<TaskControlBlock>, _is_intr: bool) {
    set_user_trap_entry();
    task.time_recorder().record_trap_return();
    let trap_cx = task.get_trap_cx();
    trap_cx.fx_restore();  // 恢复浮点寄存器
    hal::trap::restore(trap_cx);  // 跳转到用户态
}
```

---

## 16. 硬件抽象层 (HAL)

**文件**: `hal/src/` (4,516 行)

### 16.1 架构

```
hal/src/
├── board/          # 板级配置（内存范围、最大处理器数）
├── component/      # 架构相关组件
│   ├── addr/       # 地址类型（PhysAddr, VirtAddr, PhysPageNum 等）
│   ├── console/    # 串口控制台
│   ├── constant/   # 架构常量（PAGE_SIZE, KERNEL_ADDR_SPACE 等）
│   ├── entry/      # 内核入口汇编
│   ├── instruction/# 指令抽象（CSR 操作、TLB 刷新、hart 启动）
│   ├── irq/        # 中断控制器（PLIC/EIOINTC）
│   ├── pagetable/  # 页表（SV39/LoongArch 页表格式）
│   ├── signal/     # 信号上下文（sigcontext）
│   ├── timer/      # 定时器
│   └── trap/       # 陷阱上下文和入口汇编
├── interface/      # 架构无关接口
│   ├── allocator.rs  # FrameAllocatorHal trait
│   └── mapper.rs     # MmioMapperHal trait
└── util/           # 工具（backtrace、bitfield、mutex、smart_point）
```

### 16.2 关键 Trait

- `TrapContextHal`：陷阱上下文（通用寄存器、CSR、浮点寄存器）
- `PageTableHal`：页表操作（映射、解映射、查找 PTE）
- `InstructionHal`：CPU 指令（中断使能/禁止、TLB 刷新、hart 启动）
- `ConstantsHal`：架构常量（页大小、内核地址空间、用户栈范围等）
- `FrameAllocatorHal`：物理帧分配接口
- `MmioMapperHal`：MMIO 映射接口

### 16.3 LoongArch 特殊支持

- EIOINTC 中断控制器（`hal/src/component/irq/loongarch64/eiointc.rs`）
- PLIC 兼容层（`platic.rs`）
- LoongArch 页表格式（`hal/src/component/pagetable/loongarch64.rs`）
- LoongArch 信号上下文（`hal/src/component/signal/loongarch64/`）

---

## 17. 工具与辅助模块

### 17.1 异步工具

**文件**: `os/src/utils/async_utils.rs` (273 行)

- `yield_now()`：让出 CPU（异步 yield）
- `suspend_now()`：挂起当前任务（等待 waker 唤醒）
- `suspend_forever()`：永久挂起
- `get_waker()`：获取当前任务的 Waker
- `SendWrapper`：跨 await 点安全包装器

### 17.2 自定义 Crate

- **range-map** (`utils/range-map/`)：区间映射数据结构，用于管理虚拟内存区域
- **segment-tree** (`utils/segment-tree/`)：线段树，可能用于定时器管理

### 17.3 宏系统

项目大量使用声明式宏减少样板代码：
- `generate_with_methods!`：为 `Shared<T>` 字段生成 `with_xxx` / `with_mut_xxx` 方法
- `generate_option_with_methods!`：为 `SharedOption<T>` 字段生成方法
- `generate_lock_accessors!`：为 `SpinNoIrqLock<T>` 字段生成 getter/setter
- `generate_upsafecell_accessors!`：为 `UPSafeCell<T>` 字段生成访问器
- `generate_atomic_accessors!`：为 `AtomicUsize` 字段生成 getter/setter
- `generate_state_methods!`：为 `TaskStatus` 枚举生成 `is_xxx` / `set_xxx` 方法
- `generate_unwrap_with_methods!`：为 `Option<Shared<T>>` 字段生成方法

---

## 18. 子系统间交互

### 18.1 系统调用 → 文件系统 → 设备

```
sys_openat() → open_file() → VFS(Dentry::walk) → Ext4Inode::open()
  → lwext4 → BlockDevice → VirtIO/MMIO/PCI → QEMU
```

### 18.2 系统调用 → 内存管理 → 页表

```
sys_mmap() → UserVmSpace::mmap() → 创建 UserVmArea
  → 懒分配：handle_page_fault() → FrameAllocator → PageTable::map()
```

### 18.3 陷阱 → 调度 → 执行器

```
trap(Timer) → yield_now().await → executor::run_until_idle()
  → 下一个 Runnable.run() → UserTaskFuture::poll()
  → switch_to_current_task() → run_tasks() → trap_return()
```

### 18.4 进程创建流程

```
sys_clone() → TaskControlBlock::clone()
  ├─ CLONE_VM: 共享 UserVmSpace（线程）或 COW 克隆（进程）
  ├─ CLONE_FILES: 共享/克隆 FdTable
  ├─ CLONE_SIGHAND: 共享/克隆 SigManager
  ├─ CLONE_THREAD: 加入同一 ThreadGroup
  └─ spawn_user_task() → executor::spawn(UserTaskFuture)
```

### 18.5 信号传递流程

```
sys_kill() → target_task.recv_sigs(SigInfo)
  → SigManager::pending 添加信号
  → 唤醒目标任务的 waker
  → trap_return() 前 → task.check_and_handle()
    ├─ 默认动作：终止/停止/忽略/继续
    └─ 用户处理：修改 trap_cx → 构建 sigframe → 跳转到 handler
       → sys_rt_sigreturn() → 恢复原始上下文
```

### 18.6 页错误处理流程

```
trap(PageFault) → user_trap_handler()
  → task.with_mut_vm_space(|vm| vm.handle_page_fault(va, access_type))
    → 查找 VMA → UserVmArea::handle_page_fault()
      ├─ PTE 有效 + 写错误：COW 复制物理帧
      └─ PTE 无效：懒分配新物理帧
         ├─ Data: 从 ELF 文件/页缓存加载
         ├─ Stack: 分配零页
         ├─ Heap: 分配零页
         └─ Mmap: 从文件/SHM 加载或分配零页
```

---

## 19. 构建与测试结果

### 19.1 构建尝试

构建流程：
1. `make setup`：解压 `vendor.tar.xz` 和 `testcase.tar.xz`，配置 `.cargo`
2. `make kernel-rv`：编译 RISC-V 内核（`cargo build --release --target riscv64gc-unknown-none-elf`）
3. `make disk-img`：制作 ext4 磁盘镜像

**构建未能在当前环境中完成**，原因：
- 需要 `nightly-2025-01-18` Rust 工具链（当前环境版本可能不匹配）
- `lwext4_rust` 依赖 C 交叉编译工具链（RISC-V GCC）编译 C 绑定
- 磁盘镜像制作需要 `testcase.tar.xz` 中的用户态测试程序

### 19.2 测试结果

根据项目文档，该项目已**满分通过决赛线上测例**。由于无法在当前环境中完成构建，未进行本地测试。

---

## 20. 创新性分析

### 20.1 异步内核设计（核心创新）

Chronix 最显著的创新是采用了基于 Rust `async/await` 的内核执行模型：

- **每个用户任务是一个 Rust Future**：`UserTaskFuture` 包装了任务的完整生命周期
- **系统调用是异步函数**：I/O 等待时自动让出 CPU，无需显式阻塞/唤醒
- **统一的调度框架**：用户任务、内核任务、定时器任务都通过同一个 `async_task` 执行器调度
- **陷阱处理是异步的**：`user_trap_handler()` 是 `async fn`，系统调用处理中可以 `await`

这种设计相比传统的阻塞式内核：
- 代码更简洁（无需手动管理等待队列和进程状态切换）
- 天然支持高并发（I/O 等待不阻塞执行器线程）
- 利用 Rust 的类型系统保证安全（`MutexGuard` 不能跨 await 点）

### 20.2 多架构 HAL

HAL 层通过 trait 抽象和条件编译，实现了 RISC-V 64 和 LoongArch 64 的双架构支持。内核代码几乎不包含架构特定逻辑，这种设计在 OS 比赛项目中较为少见。

### 20.3 SLAB 分配器

自研的 SLAB 分配器包含 13 个大小级别的缓存（8B 到 8KiB），区分 `SmallSlabCache` 和 `SlabCache` 两种实现，并实现了内存不足时的自动回收（`shrink()`）。

### 20.4 PELT 调度算法

参考 Linux CFS 的 PELT 负载追踪算法，使用指数衰减模型计算任务负载，实现了基于负载的 SMP 负载均衡。

### 20.5 广泛的 Linux 兼容性

系统调用覆盖面广（约 200 个），包括 epoll、futex（含 robust list）、信号（含实时信号）、POSIX 定时器、timerfd、AF_ALG 加密套接字、loop 设备、splice 等高级特性。

---

## 21. 项目完整度评估

| 子系统 | 代码行数 | 完整度 | 说明 |
|--------|---------|--------|------|
| 进程/任务管理 | ~2,500 | 90% | 完整的 clone/fork/exec/waitpid，线程组，SMP 调度，PELT |
| 内存管理 | ~3,100 | 85% | SLAB、COW、懒分配、mmap/mremap/mprotect 完整 |
| 文件系统 | ~6,500 | 85% | VFS + 5 种文件系统 + 页缓存 + Dentry 缓存 |
| 网络 | ~3,400 | 75% | TCP/UDP/Raw/SocketPair/AF_ALG，基于 smoltcp |
| 系统调用 | ~8,600 | 80% | 约 200 个 syscall，部分为存根 |
| 信号 | ~1,100 | 85% | 标准/实时信号、sigaction、sigreturn、消息队列 |
| IPC | ~240 | 60% | 仅 SHM 和消息队列，缺少 System V 信号量 |
| 同步原语 | ~500 | 80% | SpinMutex、RwMutex、Semaphore、UPSafeCell |
| 定时器 | ~960 | 85% | ITimer、POSIX Timer、TimerFD、时间记录 |
| 设备驱动 | ~2,500 | 70% | VirtIO、MMC、UART、PCI，缺少 USB/GPU |
| HAL | ~4,500 | 85% | 双架构支持，抽象清晰 |
| **总计** | **~41,200** | **~80%** | 作为比赛项目，完整度极高 |

---

## 22. 总结

Chronix 是一个高质量的 OS 内核比赛项目，来自哈尔滨工业大学（深圳），已满分通过决赛线上测例。

**核心优势**：
1. **异步内核架构**：基于 Rust `async/await` 的执行器模型，系统调用和陷阱处理均为异步函数，代码简洁且天然支持高并发
2. **Linux 兼容性强**：约 200 个系统调用，覆盖文件系统、进程管理、网络、信号、IPC、定时器等核心领域
3. **多架构支持**：RISC-V 64 和 LoongArch 64 双平台，HAL 抽象层设计合理
4. **内存管理完善**：SLAB 分配器（13 级缓存）、COW、懒分配、mmap 系列操作
5. **文件系统丰富**：Ext4、FAT32、TmpFS、ProcFS、DevFS、PipeFS，含页缓存和 Dentry 缓存
6. **SMP 支持**：PELT 负载追踪、每核心任务队列、任务迁移
7. **代码量大**：内核主体约 36,700 行 + HAL 约 4,500 行 = 总计约 41,200 行 Rust 代码

**不足之处**：
1. IPC 子系统不完整（缺少 System V 信号量）
2. 部分系统调用为存根实现（如 `mlock`、`madvise`、`mincore`）
3. 网络栈依赖 smoltcp，性能可能受限
4. 页缓存缺少完整的 write-back 策略
5. 文档注释不够完整（`#![deny(missing_docs)]` 被注释掉）
6. 宏使用较多，部分代码可读性受影响