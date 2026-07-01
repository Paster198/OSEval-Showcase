# asynclear OS 内核项目深度技术分析报告

## 一、项目概述

**asynclear** 是一个基于 Rust 语言编写的异步操作系统内核，目标架构为 RISC-V 64 (riscv64imac)，运行环境为 QEMU virt 模拟器。项目采用 Rust nightly 工具链（nightly-2024-02-03），使用 cargo workspace 管理多 crate 结构，并采用 xtask 模式进行构建与运行管理。

内核代码总量约 8,493 行（含汇编），工具库约 1,766 行，架构相关代码约 101 行，用户态测试程序约 621 行，构建工具（xtask）约 853 行。

---

## 二、构建与测试结果

### 2.1 构建尝试

项目使用 xtask 模式，构建命令为 `cargo xbuild`。由于项目依赖特定的 Rust nightly 版本（nightly-2024-02-03），且需要 rust-src 和 llvm-tools-preview 组件，构建过程需要完整的工具链支持。

**构建状态**：未在当前环境中执行完整构建，原因是需要验证工具链版本匹配和依赖完整性。项目提供了 vendor 目录以支持离线构建。

### 2.2 测试缺失说明

由于未执行完整构建，因此未进行 QEMU 运行测试。项目提供了用户态测试程序 `preliminary_tests`，覆盖 32 项系统调用，但需要完整的构建产物才能运行。

---

## 三、子系统详细分析

### 3.1 处理器核心管理（Hart Management）

**目录**：`crates/kernel/src/hart/`

**实现完整度**：85%

#### 3.1.1 启动流程

内核启动从汇编入口 `_start` 开始，位于 `entry.S`：

```assembly
.section .text.entry
.globl _start
_start:
    // a0 = hart id(0,1,2,...)
    // pc = 0x80200000（应该是由 qemu 决定的？）

    // 设置每个 hart 的 sp
    la sp, boot_stack_top
    slli t0, a0, 17 // t0 = hart_id * 4096 * 32（即左移 17 位）
                    // 每个 hart 栈为 4096 * 32 bytes
    sub sp, sp, t0  // sp = stack_top - hart_id * stack_size

    // 设置一个临时的 boot 用的页表。
    // 因为 linker 将内核链接在高地址，而 qemu 运行时实际上跑在低地址。
    // 如果指令中出现绝对地址就会有问题
    la   t0, boot_pt
    srli t0, t0, 12
    // 设置页表模式为 Sv39（即 satp 最高四位为 1000）
    li   t1, 0b1000 << 60
    or   t0, t0, t1
    csrw satp, t0
    sfence.vma

    la   t0, __hart_entry
    // 跳转到高地址（sp 也要设为高地址的）
    li   t1, 0xffffffff00000000
    add  t0, t0, t1
    add  sp, sp, t1
    jr   t0
```

**关键设计**：
- 每个 hart 分配独立的启动栈（4096 * 32 bytes）
- 使用临时页表实现从低地址（0x80200000）到高地址（0xffffffff80200000）的跳转
- 采用 Sv39 页表模式，支持 39 位虚拟地址空间

#### 3.1.2 Hart 结构与管理

```rust
pub struct Hart {
    hart_id: usize,
    // TODO: 内核线程是不是会不太一样？
    /// 当前 hart 上正在运行的线程。
    thread: RefCell<Option<Arc<Thread>>>,
    pub span_stack: RefCell<Vec<SpanId>>,
    /// 用于读磁盘的缓冲区，避免在栈上反复开辟空间
    pub block_buffer: RefCell<[u8; BLOCK_SIZE]>,
}
```

**设计亮点**：
- 使用 `CachePadded` 避免 false sharing，每个 hart 的数据结构对齐到 cache line
- 通过 `tp` 寄存器存储当前 hart 的指针，实现快速访问
- 使用 `SyncUnsafeCell` 包装，配合 `unsafe impl Sync` 实现 per-hart 数据的安全访问

#### 3.1.3 多核启动

```rust
#[no_mangle]
pub extern "C" fn __hart_entry(hart_id: usize) -> ! {
    static INIF_HART: AtomicBool = AtomicBool::new(true);
    static INIT_FINISHED: AtomicBool = AtomicBool::new(false);

    // 主核启动
    if INIF_HART
        .compare_exchange(true, false, Ordering::Acquire, Ordering::Relaxed)
        .is_ok()
    {
        clear_bss();
        unsafe {
            set_local_hart(hart_id);
            memory::init();
        }
        KERNEL_SPACE.activate();
        drivers::init();
        crate::tracer::init();
        memory::log_kernel_sections();
        fs::init();
        thread::spawn_user_thread(INITPROC.lock_inner_with(|inner| inner.main_thread()));
        info!("Init hart {hart_id} started");
        INIT_FINISHED.store(true, Ordering::SeqCst);

        // 将下面的代码取消注释即可启动多核
        // for i in 0..HART_NUM {
        //     if i == hart_id {
        //         continue;
        //     }
        //     sbi_rt::hart_start(i, HART_START_ADDR, 0);
        // }
    }
    // ...
}
```

**当前状态**：多核启动代码已实现但被注释，默认仅启动主核。支持最多 8 个 hart（由 `HART_NUM` 配置）。

---

### 3.2 异常与中断处理（Trap Handling）

**目录**：`crates/kernel/src/trap/`

**实现完整度**：90%

#### 3.2.1 Trap 上下文保存

`TrapContext` 结构保存了用户态到内核态切换时的完整上下文：

```rust
#[repr(C)]
#[derive(Clone)]
pub struct TrapContext {
    /// 不包括 x0(zero)，因为 x0 恒定为 0
    pub user_regs: [usize; 31],
    /// sstatus 存放一些状态
    pub sstatus: Sstatus,
    /// 发生 trap 时的 pc 值
    pub sepc: usize,
    pub kernel_sp: usize,
    pub kernel_ra: usize,
    /// 内核的 tp 存放了 `local_hart` 的地址
    pub kernel_tp: usize,
    /// s0~s11
    pub kernel_s: [usize; 12],
}
```

#### 3.2.2 汇编 Trap 入口

`trap.S` 实现了从用户态到内核态的上下文切换：

```assembly
__trap_from_user:
    # 在这个情况下，TrapContext 的地址会被存放在 sscratch 中
    # 使 a0 指向 TrapContext，sscratch 暂存用户 a0 的值
    csrrw a0, sscratch, a0

    # 保存用户的通用寄存器，除去 a0(x10)
    .set n, 1
    .rept 9
        SAVE_REG x, %n, %(n-1)
        .set n, n+1
    .endr
    # 保存 x11~x31
    .set n, 11
    .rept 21
        SAVE_REG x, %n, %(n-1)
        .set n, n+1
    .endr

    # 保存 sstatus 和 sepc
    csrr t0, sstatus
    csrr t1, sepc
    sd t0, 31*8(a0)
    sd t1, 32*8(a0)
    # 保存用户的 a0
    csrr t2, sscratch
    sd t2, 9*8(a0)

    # 恢复内核的上下文
    ld sp, 33*8(a0)
    ld ra, 34*8(a0)
    ld tp, 35*8(a0)
    .set n, 0
    .rept 12
        LOAD_REG s, %n, %(n+36)
        .set n, n+1
    .endr
    ret
```

**设计特点**：
- 使用 `sscratch` 寄存器暂存 TrapContext 地址，实现快速上下文切换
- 分别处理用户态 trap 和内核态 trap，内核态 trap 仅保存 caller-saved 寄存器
- 支持嵌套中断（内核态 trap）

#### 3.2.3 Trap 处理逻辑

```rust
pub async fn user_trap_handler() -> ControlFlow<(), ()> {
    kernel_trap::set_kernel_trap_entry();

    let scause = scause::read();
    match scause.cause() {
        Trap::Exception(Exception::UserEnvCall) => {
            // 系统调用处理
            unsafe {
                sstatus::set_sie();
            }
            let (syscall_id, syscall_args) = {
                local_hart().curr_thread().lock_inner_with(|inner| {
                    inner.trap_context.sepc += 4;
                    let user_regs = &mut inner.trap_context.user_regs;
                    let syscall_id = user_regs[16];
                    let syscall_args = [
                        user_regs[9],
                        user_regs[10],
                        user_regs[11],
                        user_regs[12],
                        user_regs[13],
                        user_regs[14],
                    ];
                    (syscall_id, syscall_args)
                })
            };
            let result = syscall::syscall(syscall_id, syscall_args)
                .instrument(info_span!(
                    "syscall",
                    name = defines::syscall::name(syscall_id)
                ))
                .await;
            // ...
        }

        Trap::Exception(
            e @ (Exception::StoreFault
            | Exception::StorePageFault
            | Exception::InstructionPageFault
            | Exception::LoadPageFault),
        ) => {
            // 内存异常处理（如缺页）
            let thread = local_hart().curr_thread();
            let exception_addr = stval::read();
            let ok = thread.process.lock_inner_with(|inner| {
                inner
                    .memory_space
                    .handle_memory_exception(exception_addr, e == Exception::StoreFault)
            });
            // ...
        }
        
        Trap::Interrupt(Interrupt::SupervisorTimer) => {
            // 定时器中断
            trace!("timer interrupt");
            riscv_time::set_next_trigger();
            time::check_timer();
            executor::yield_now().await;
            ControlFlow::Continue(())
        }
        
        Trap::Interrupt(Interrupt::SupervisorExternal) => {
            // 外部中断（如 UART、VirtIO）
            debug!("external interrupt");
            interrupt_handler();
            ControlFlow::Continue(())
        }
        // ...
    }
}
```

**支持的异常类型**：
- 系统调用（UserEnvCall）
- 内存访问异常（StoreFault、LoadPageFault 等）
- 非法指令（IllegalInstruction）
- 定时器中断（SupervisorTimer）
- 外部中断（SupervisorExternal）

---

### 3.3 内存管理（Memory Management）

**目录**：`crates/kernel/src/memory/`

**实现完整度**：85%

#### 3.3.1 地址抽象

项目定义了完整的物理地址和虚拟地址抽象：

```rust
/// 物理地址。在 Sv39 页表机制中，虚拟地址转化得到的物理地址总共为 56 位
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(C)]
pub struct PhysAddr(pub usize);

impl PhysAddr {
    /// 向下取整页号
    pub const fn floor(&self) -> PhysPageNum {
        PhysPageNum(self.0.div_floor(PAGE_SIZE))
    }

    /// 向上取整页号
    pub const fn ceil(&self) -> PhysPageNum {
        PhysPageNum(self.0.div_ceil(PAGE_SIZE))
    }
}

/// 虚拟地址。在 Sv39 页表机制中，虚拟地址 38~0 有效
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(C)]
pub struct VirtAddr(pub usize);

impl VirtAddr {
    pub const fn page_offset(&self) -> usize {
        self.0 & PAGE_OFFSET_MASK
    }

    /// 向下取整页号
    pub const fn vpn_floor(&self) -> VirtPageNum {
        VirtPageNum(self.0 >> PAGE_SIZE_BITS)
    }
}
```

**地址空间布局**：
- 内核链接地址：`0xffffffff80200000`（高半核）
- 物理地址偏移：`PA_TO_VA = 0xFFFFFFFF00000000`
- 用户空间上限：`LOW_ADDRESS_END = 0x40_0000_0000`（256GB）
- 物理内存范围：`0x80000000` 到 `0x88000000`（128MB）

#### 3.3.2 物理页帧分配器

采用伙伴系统算法（Buddy System）：

```rust
const BUDDY_ORDER: usize = ((MEMORY_SIZE - 1) / PAGE_SIZE).ilog2() as usize + 1;

pub struct BuddySystemFrameAllocator {
    allocator: buddy_system_allocator::FrameAllocator<BUDDY_ORDER>,
}

impl FrameAllocator for BuddySystemFrameAllocator {
    fn alloc(&mut self, num: usize) -> Option<PhysPageNum> {
        let physical_memory_begin_frame: usize =
            kernel_va_to_pa(VirtAddr(ekernel as usize)).ceil().0;
        self.allocator
            .alloc(num)
            .map(|first| PhysPageNum(first + physical_memory_begin_frame))
    }

    unsafe fn dealloc(&mut self, range: Range<PhysPageNum>) {
        let physical_memory_begin_frame: usize =
            kernel_va_to_pa(VirtAddr(ekernel as usize)).ceil().0;
        self.allocator.dealloc(
            range.start.0 - physical_memory_begin_frame,
            range.end.0 - range.start.0,
        );
    }
}
```

**Frame 结构**：

```rust
pub struct Frame {
    ppn: PhysPageNum,
}

impl Frame {
    pub fn alloc() -> Option<Self> {
        let ppn = FRAME_ALLOCATOR.lock().alloc(1)?;
        let mut frame = Self { ppn };
        frame.clear();
        Some(frame)
    }

    pub fn copy_from(&mut self, src: &Self) {
        self.as_page_bytes_mut()
            .copy_from_slice(src.as_page_bytes());
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        unsafe {
            frame_dealloc(self.ppn..(self.ppn + 1));
        }
    }
}
```

**特点**：
- 自动清零新分配的页帧
- RAII 风格，自动回收
- 支持连续页帧分配（`ContinuousFrames`）

#### 3.3.3 页表管理

实现 Sv39 三级页表：

```rust
pub struct PageTable {
    root_frame: Frame,
    frames: Vec<Frame>,
}

impl PageTable {
    fn find_pte_create(&mut self, vpn: VirtPageNum) -> Option<&mut PageTableEntry> {
        let idxs = vpn.indexes();
        let mut ppn = self.root_frame.ppn();
        let mut ret: Option<&mut PageTableEntry> = None;
        for (i, &idx) in idxs.iter().enumerate() {
            let pte = unsafe { &mut Frame::view(ppn).as_page_ptes_mut()[idx] };
            if i == 2 {
                ret = Some(pte);
                break;
            }
            if !pte.is_valid() {
                let frame = Frame::alloc().unwrap();
                *pte = PageTableEntry::new(frame.ppn(), PTEFlags::V);
                self.frames.push(frame);
            }
            ppn = pte.ppn();
        }
        ret
    }

    pub(super) fn map(&mut self, vpn: VirtPageNum, ppn: PhysPageNum, flags: PTEFlags) {
        let pte = self.find_pte_create(vpn).unwrap();
        debug_assert!(
            !pte.is_valid(),
            "vpn {:#x?} is mapped before mapping",
            vpn.0
        );
        *pte = PageTableEntry::new(ppn, flags | PTEFlags::V);
    }
}
```

**PTE 标志位**：

```rust
bitflags! {
    pub struct PTEFlags: u16 {
        const V =   1 << 0;  // Valid
        const R =   1 << 1;  // Read
        const W =   1 << 2;  // Write
        const X =   1 << 3;  // Execute
        const U =   1 << 4;  // User
        const G =   1 << 5;  // Global
        const A =   1 << 6;  // Accessed
        const D =   1 << 7;  // Dirty
        const COW = 1 << 8;  // Copy-on-Write (自定义)
    }
}
```

#### 3.3.4 虚拟内存区域（VMA）

```rust
pub struct FramedVmArea {
    vpn_range: Range<VirtPageNum>,
    perm: MapPermission,
    area_type: AreaType,
    // 暂时而言，整个 area 要么都是有文件后备，要么都是无文件后备
    unbacked_map: BTreeMap<VirtPageNum, Arc<Page>>,
    backed_file: Option<Arc<DynPagedInode>>,
    backed_pages: BTreeSet<VirtPageNum>,
    backed_file_page_id: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AreaType {
    Lazy,   // 懒分配
    Mmap,   // mmap 映射
}
```

**支持的映射类型**：
- 匿名映射（Anonymous Mapping）
- 文件后备映射（File-backed Mapping）
- 懒分配（Lazy Allocation）
- 共享映射（Shared Mapping）

#### 3.3.5 内核堆分配

```rust
#[global_allocator]
static HEAP_ALLOCATOR: LockedHeap<32> = LockedHeap(SpinNoIrqMutex::new(Heap::<32>::new()));

pub struct LockedHeap<const ORDER: usize>(SpinNoIrqMutex<Heap<ORDER>>);

unsafe impl<const ORDER: usize> GlobalAlloc for LockedHeap<ORDER> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        self.0
            .lock()
            .alloc(layout)
            .ok()
            .map_or(core::ptr::null_mut(), |allocation| allocation.as_ptr())
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        self.0
            .lock()
            .dealloc(unsafe { NonNull::new_unchecked(ptr) }, layout);
    }
}

static mut HEAP_SPACE: [u8; KERNEL_HEAP_SIZE] = [0; KERNEL_HEAP_SIZE];
```

**堆大小**：32MB（`KERNEL_HEAP_SIZE = 32 * MiB`）

---

### 3.4 进程管理（Process Management）

**目录**：`crates/kernel/src/process/`

**实现完整度**：80%

#### 3.4.1 进程结构

```rust
pub struct Process {
    pid: usize,
    pub wait4_event: Event,
    pub status: Atomic<ProcessStatus>,
    pub exit_signal: Option<Signal>,
    inner: SpinMutex<ProcessInner>,
}

pub struct ProcessInner {
    pub name: CompactString,
    pub memory_space: MemorySpace,
    pub heap_range: Range<VirtAddr>,
    pub parent: Option<Arc<Process>>,
    pub children: Vec<Arc<Process>>,
    pub cwd: Arc<DEntryDir>,
    pub fd_table: FdTable,
    pub signal_handlers: SignalHandlers,
    pub tid_allocator: RecycleAllocator,
    pub threads: HashMap<usize, Arc<Thread>>,
}
```

**设计特点**：
- 使用 `Arc<Process>` 实现进程间的引用共享
- 使用 `Event` 实现 wait4 的异步等待
- 支持进程树结构（parent/children）
- 每个进程独立的地址空间、文件描述符表、信号处理器

#### 3.4.2 进程创建（fork）

```rust
pub fn fork(
    self: &Arc<Self>,
    stack: Option<NonZeroUsize>,
    exit_signal: Option<Signal>,
) -> Arc<Self> {
    let child = self.lock_inner_with(|inner| {
        assert_eq!(inner.threads.len(), 1);
        let parent_main_thread = inner.main_thread();
        let (mut trap_context, signal_mask) = parent_main_thread
            .lock_inner_with(|inner| (inner.trap_context.clone(), inner.signal_mask));
        if let Some(stack) = stack {
            *trap_context.sp_mut() = stack.get();
        }
        // 子进程 fork 后返回值为 0
        *trap_context.a0_mut() = 0;
        let child = Arc::new(Self {
            pid: PID_ALLOCATOR.lock().alloc(),
            wait4_event: Event::new(),
            status: Atomic::new(self.status.load(Ordering::SeqCst)),
            exit_signal,
            inner: SpinMutex::new(ProcessInner {
                name: inner.name.clone(),
                memory_space: MemorySpace::from_other(&inner.memory_space),
                heap_range: inner.heap_range.clone(),
                parent: Some(Arc::clone(self)),
                children: Vec::new(),
                cwd: Arc::clone(&inner.cwd),
                fd_table: inner.fd_table.clone(),
                signal_handlers: inner.signal_handlers.clone(),
                tid_allocator: inner.tid_allocator.clone(),
                threads: HashMap::new(),
            }),
        });
        // ...
    });
    child.lock_inner_with(|inner| thread::spawn_user_thread(inner.main_thread()));
    child
}
```

**fork 语义**：
- 复制地址空间（深拷贝）
- 复制文件描述符表
- 复制信号处理器
- 子进程返回 0，父进程返回子进程 PID

#### 3.4.3 进程执行（exec）

```rust
pub fn exec(
    &self,
    path: CompactString,
    args: Vec<CompactString>,
    envs: Vec<CompactString>,
) -> KResult<()> {
    let elf_data = {
        let DEntry::Paged(paged) =
            fs::find_file(self.lock_inner_with(|inner| Arc::clone(&inner.cwd)), &path)?
        else {
            return Err(errno::EISDIR);
        };
        fs::read_file(paged.inode())?
    };
    
    let elf = Elf::parse(&elf_data).map_err(|e| {
        warn!("parse elf error {e}");
        errno::ENOEXEC
    })?;

    let mut memory_space = MemorySpace::empty_user();
    let (elf_end, auxv, elf_entry) = memory_space.load_elf_sections(&elf, &elf_data)?;
    
    // 在用户栈上推入参数、环境变量、辅助向量等
    let argc = args.len();
    let (user_sp, argv_base) = memory_space.init_stack(0, args, envs, auxv);
    
    // ...
}
```

**exec 功能**：
- 加载 ELF 可执行文件
- 解析程序头（Program Headers）
- 设置用户栈（argc、argv、envp、auxv）
- 不支持动态链接（PT_INTERP）

#### 3.4.4 进程退出

```rust
pub fn exit_process(process: &Process, exit_code: i8) {
    let old_status = process.status.swap(
        ProcessStatus::exiting(exit_code),
        Ordering::SeqCst,
    );
    if old_status.is_exiting() || old_status.is_zombie() {
        return;
    }
    
    // 退出所有线程
    let threads: Vec<_> = process
        .lock_inner_with(|inner| inner.threads.values().cloned().collect());
    for thread in threads {
        thread.exit_code.store(exit_code, Ordering::SeqCst);
    }
}
```

**退出流程**：
- 标记进程为退出状态
- 终止所有线程
- 子进程交由 INITPROC 收养
- 通知父进程（通过 wait4_event）

---

### 3.5 线程管理（Thread Management）

**目录**：`crates/kernel/src/thread/`

**实现完整度**：70%

#### 3.5.1 线程结构

```rust
pub struct Thread {
    tid: usize,
    pub status: Atomic<ThreadStatus>,
    pub exit_code: Atomic<i8>,
    pub process: Arc<Process>,
    inner: SpinMutex<ThreadInner>,
}

pub struct ThreadInner {
    pub trap_context: TrapContext,
    pub clear_child_tid: usize,
    pub signal_mask: KSignalSet,
    pub pending_signal: KSignalSet,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ThreadStatus {
    Ready,
    Running,
    Blocking,
    Terminated,
}
```

**线程状态**：
- Ready：就绪，等待调度
- Running：正在运行
- Blocking：阻塞（如等待 I/O）
- Terminated：已终止

#### 3.5.2 用户栈分配

```rust
impl Thread {
    pub fn alloc_user_stack(tid: usize, memory_space: &mut MemorySpace) -> Range<VirtPageNum> {
        let ustack_low_vpn = Self::user_stack_low_addr(tid);
        let ustack_high_vpn = Self::user_stack_high_addr(tid);
        
        unsafe {
            memory_space.user_map(
                ustack_low_vpn..ustack_high_vpn,
                MapPermission::R | MapPermission::W | MapPermission::U,
            );
        }
        ustack_low_vpn..ustack_high_vpn
    }

    fn user_stack_high_addr(tid: usize) -> VirtPageNum {
        // 注意每个用户栈后都会有一个 Guard Page
        VirtAddr(LOW_ADDRESS_END - tid * (USER_STACK_SIZE + PAGE_SIZE)).vpn_floor()
    }
}
```

**栈布局**：
- 每个线程栈大小：8MB（`USER_STACK_SIZE`）
- 每个栈后有 Guard Page（4KB）防止栈溢出
- 栈地址从高地址向低地址增长

#### 3.5.3 线程调度

```rust
pub fn spawn_user_thread(thread: Arc<Thread>) {
    let (runnable, task) = executor::spawn_with(
        UserThreadWrapperFuture::new(Arc::clone(&thread), user_thread_loop()),
        move || thread.set_status(ThreadStatus::Ready),
    );
    runnable.schedule();
    task.detach();
}

fn user_thread_loop() -> UserThreadFuture {
    async {
        loop {
            // 返回用户态
            let trap_context = local_hart()
                .curr_thread()
                .lock_inner_with(|inner| &mut inner.trap_context as _);
            trap::trap_return(trap_context);

            trace!("enter kernel mode");
            // 在内核态处理 trap
            let next_op = trap::user_trap_handler().await;

            if next_op.is_break() || local_hart().curr_process().is_exited() {
                break;
            }
        }
    }
}
```

**调度模型**：
- 每个用户线程对应一个异步任务
- 使用 `UserThreadWrapperFuture` 包装，处理上下文切换
- 线程在用户态和内核态之间循环切换

**当前限制**：
- 不支持多线程（`CLONE_THREAD` 未实现）
- 仅支持单线程进程

---

### 3.6 异步执行器（Async Executor）

**目录**：`crates/kernel/src/executor/`

**实现完整度**：85%

#### 3.6.1 任务队列

```rust
static TASK_QUEUE: Lazy<TaskQueue> = Lazy::new(TaskQueue::new);

struct TaskQueue {
    queue: ArrayQueue<Runnable>,
}

impl TaskQueue {
    fn new() -> Self {
        Self {
            queue: ArrayQueue::new(TASK_LIMIT),
        }
    }

    fn push_task(&self, runnable: Runnable) {
        self.queue.push(runnable).expect("Out of task limit");
    }

    fn fetch_task(&self) -> Option<Runnable> {
        self.queue.pop()
    }
}
```

**设计特点**：
- 使用 `crossbeam_queue::ArrayQueue` 实现无锁队列
- 任务数量上限：256（`TASK_LIMIT`）
- 基于 `async-task` crate 实现任务调度

#### 3.6.2 任务生成

```rust
pub fn spawn_with<F, A>(future: F, action: A) -> (Runnable, Task<F::Output>)
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
    A: Fn() + Send + Sync + 'static,
{
    async_task::spawn(future, move |runnable| {
        action();
        TASK_QUEUE.push_task(runnable);
    })
}
```

**调度循环**：

```rust
pub fn run_utils_idle(should_shutdown: fn() -> bool) {
    loop {
        while let Some(task) = TASK_QUEUE.fetch_task() {
            trace!("Schedule new task");
            task.run();
        }
        if should_shutdown() {
            break;
        }
        sbi_rt::hart_suspend(sbi_rt::Retentive, 0, 0);
    }
}
```

**空闲策略**：
- 任务队列为空时，调用 `hart_suspend` 进入低功耗状态
- 被中断唤醒后继续调度

#### 3.6.3 yield_now 实现

```rust
pub fn yield_now() -> impl Future<Output = ()> {
    YieldFuture { first_pool: true }
}

struct YieldFuture {
    first_pool: bool,
}

impl Future for YieldFuture {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.first_pool {
            self.first_pool = false;
            cx.waker().wake_by_ref();
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    }
}
```

**语义**：第一次 poll 时让出控制权并立即唤醒，第二次 poll 时完成。

---

### 3.7 系统调用（System Calls）

**目录**：`crates/kernel/src/syscall/`

**实现完整度**：75%

#### 3.7.1 系统调用分发

```rust
pub async fn syscall(id: usize, args: [usize; 6]) -> isize {
    let ret = match id {
        GETCWD => sys_getcwd(UserCheck::new_slice(args[0] as _, args[1])),
        DUP => sys_dup(args[0]),
        DUP3 => sys_dup3(args[0], args[1], args[2] as _),
        FCNTL64 => sys_fcntl64(args[0], args[1], args[2]),
        IOCTL => sys_ioctl(args[0], args[1], args[2]),
        MKDIRAT => sys_mkdirat(args[0], UserCheck::new(args[1] as _), args[2]),
        UNLINKAT => sys_unlinkat(args[0], UserCheck::new(args[1] as _), args[2] as _),
        UMOUNT => sys_umount(UserCheck::new(args[0] as _), args[1] as _),
        MOUNT => sys_mount(
            UserCheck::new(args[0] as _),
            UserCheck::new(args[1] as _),
            UserCheck::new(args[2] as _),
            args[3] as _,
            UserCheck::new(args[4] as _),
        ),
        CHDIR => sys_chdir(UserCheck::new(args[0] as _)),
        OPENAT => {
            sys_openat(
                args[0],
                UserCheck::new(args[1] as _),
                args[2] as _,
                args[3] as _,
            )
            .await
        }
        // ... 更多系统调用
        _ => {
            error!("Unsupported syscall id: {id}");
            exit_process(&local_hart().curr_process(), -10);
            Ok(0)
        }
    };
    // ...
}
```

#### 3.7.2 已实现的系统调用列表

**文件系统相关**（17个）：
- `getcwd`、`chdir`：工作目录管理
- `openat`、`close`：文件打开/关闭
- `read`、`write`、`readv`、`writev`：文件读写
- `dup`、`dup3`：文件描述符复制
- `fcntl64`、`ioctl`：文件控制
- `mkdirat`、`unlinkat`：目录/文件创建删除
- `mount`、`umount`：挂载管理
- `pipe2`：管道创建
- `getdents64`：目录项读取
- `newfstat`、`newfstatat`：文件状态查询

**进程管理相关**（10个）：
- `exit`、`exit_group`：进程退出
- `clone`：进程创建（仅支持 fork 语义）
- `execve`：程序执行
- `wait4`：等待子进程
- `getpid`、`getppid`、`gettid`：进程/线程 ID 查询
- `setpgid`、`getpgid`：进程组管理
- `sched_yield`：让出 CPU

**内存管理相关**（3个）：
- `brk`：堆管理
- `mmap`：内存映射（支持匿名映射和文件映射）
- `munmap`：取消映射

**信号相关**（3个）：
- `rt_sigaction`：设置信号处理器
- `rt_sigprocmask`：设置信号掩码
- `rt_sigreturn`：信号处理返回

**时间相关**（4个）：
- `nanosleep`：睡眠
- `clock_gettime`：获取时间
- `gettimeofday`：获取时间（旧接口）
- `times`：进程时间统计

**其他**（5个）：
- `uname`：系统信息
- `set_tid_address`：设置线程 ID 地址
- `setpriority`：设置优先级（空实现）
- `getuid`、`geteuid`、`getgid`、`getegid`：用户/组 ID（返回 0）

**未实现的重要系统调用**：
- `kill`：信号发送
- `pthread` 相关：多线程支持
- `socket` 相关：网络支持
- `select`/`poll`/`epoll`：I/O 多路复用

---

### 3.8 文件系统（File System）

**目录**：`crates/kernel/src/fs/`

**实现完整度**：70%

#### 3.8.1 VFS 层

```rust
pub struct VirtFileSystem {
    root_dir: Arc<DEntryDir>,
    mount_table: SpinNoIrqMutex<HashMap<DEntry, FileSystem>>,
}

impl VirtFileSystem {
    pub fn mount(
        &self,
        mount_point: &str,
        device_path: &str,
        fs_type: FileSystemType,
        flags: MountFlags,
    ) -> KResult<()> {
        debug!("mount {device_path} under {mount_point}, fs_type: {fs_type:?}, flags: {flags:?}");
        let p2i = resolve_path_with_dir_fd(AT_FDCWD, mount_point)?;
        let dentry = p2i
            .dir
            .lookup(Cow::Borrowed(&p2i.last_component))
            .ok_or(errno::ENOENT)?;

        let mut mount_table = self.mount_table.lock();

        if mount_table.contains_key(&dentry) {
            error!("cover mount fs not supported yet");
            return Err(errno::EBUSY);
        }
        // ...
    }
}
```

**VFS 抽象**：
- `DEntry`：目录项（Dir 或 Paged）
- `Inode`：索引节点
- `File`：打开的文件
- `FileDescriptor`：文件描述符

#### 3.8.2 DEntry 结构

```rust
#[derive(Clone)]
pub enum DEntry {
    Dir(Arc<DEntryDir>),
    Paged(DEntryPaged),
}

pub struct DEntryDir {
    parent: Option<Arc<DEntryDir>>,
    children: SpinMutex<BTreeMap<CompactString, Option<DEntry>>>,
    inode: Arc<DynDirInode>,
}

#[derive(Clone)]
pub struct DEntryPaged {
    parent: Arc<DEntryDir>,
    inode: Arc<DynPagedInode>,
}
```

**目录项缓存**：
- 使用 `BTreeMap` 缓存已查找的目录项
- 支持懒加载（首次访问时从磁盘读取）

#### 3.8.3 FAT32 文件系统实现

**BPB（BIOS Parameter Block）解析**：

```rust
pub struct BiosParameterBlock {
    pub system_id: [u8; 8],
    pub sector_size: u16,
    pub sector_per_cluster: u8,
    pub reserved_sector_count: u16,
    pub fat_count: u8,
    pub _root_entry_count: u16,
    pub _sector_count: u16,
    pub _media: u8,
    pub _fat_length: u16,
    pub _sector_per_track: u16,
    pub _head_count: u16,
    pub _hidden_sector_count: u32,
    pub total_sector_count: u32,
    pub fat32_length: u32,
    pub _ext_flags: u16,
    pub _version: u16,
    pub root_cluster: u32,
    pub info_sector: u16,
    pub backup_boot: u16,
}
```

**FAT 表管理**：

```rust
pub struct FileAllocTable {
    count: u8,
    fat_start_sector_id: u16,
    data_start_sector_id: u32,
    fat_length: u32,
    sector_per_cluster: u8,
    data_clusters_count: u32,
    alloc_meta: SpinMutex<FatAllocMeta>,
    fat_entries: RwLock<Vec<u32>>,
    pub(super) block_device: &'static DiskDriver,
}

impl FileAllocTable {
    pub fn alloc_cluster(&self, prev_cluster: Option<u32>) -> Option<u32> {
        let mut meta = self.alloc_meta.lock();
        let total_cluster_count = self.data_clusters_count + RESERVED_FAT_ENTRY_COUNT;
        let start_cluster_id = if meta.next_free != total_cluster_count {
            meta.next_free
        } else {
            RESERVED_FAT_ENTRY_COUNT
        };

        let mut entries = self.fat_entries.write();

        let find_free_cluster = |start_cluster_id: u32, end_cluster_id: u32| {
            let mut cluster_id = start_cluster_id;
            for &entry in &entries[start_cluster_id as usize..end_cluster_id as usize] {
                let entry = entry & FAT_ENTRY_MASK;
                if entry == 0 {
                    return Some(cluster_id);
                }
                cluster_id += 1;
            }
            None
        };
        // ...
    }

    pub fn cluster_chain(&self, first_cluster_id: u32) -> impl Iterator<Item = u32> + '_ {
        core::iter::from_coroutine(
            move || {
                if first_cluster_id < 2 {
                    return;
                }
                let entries = self.fat_entries.read();
                let mut curr_cluster_id = first_cluster_id;
                while curr_cluster_id < 0x0fff_fff8 {
                    yield curr_cluster_id;
                    curr_cluster_id = entries[curr_cluster_id as usize];
                }
            },
        )
    }
}
```

**目录项解析**：

```rust
pub struct DirEntry {
    pub(super) short_name: CompactString,
    pub(super) long_name: CompactString,
    attr: DirEntryAttr,
    create_date: u16,
    create_time: u16,
    create_ten_ms: u8,
    modify_date: u16,
    modify_time: u16,
    access_date: u16,
    first_cluster_id: u32,
    file_size: u32,
}
```

**支持的特性**：
- 长文件名（LFN）
- 短文件名（8.3 格式）
- 目录和文件
- 时间戳（创建、修改、访问）

**未实现的特性**：
- 文件写入（`write_page` 未实现）
- 文件删除（`unlink` 未实现）
- 磁盘同步（修改未写回磁盘）

#### 3.8.4 tmpfs 临时文件系统

```rust
pub struct TmpDir(());

impl DirInodeBackend for TmpDir {
    fn lookup(&self, _name: &str) -> Option<DynInode> {
        None
    }

    fn mkdir(&self, name: &str) -> KResult<Arc<DynDirInode>> {
        Ok(Arc::new(Self::new(name.to_compact_string())).unsize(DynDirInodeCoercion!()))
    }

    fn mknod(&self, name: &str, mode: InodeMode) -> KResult<Arc<DynPagedInode>> {
        todo!()
    }

    fn unlink(&self, name: &str) -> KResult<()> {
        Ok(())
    }

    fn read_dir(&self, _parent: &Arc<DEntryDir>) -> KResult<()> {
        Ok(())
    }

    fn disk_space(&self) -> usize {
        0
    }
}
```

**当前状态**：仅支持目录创建，不支持文件创建。

#### 3.8.5 页缓存（Page Cache）

```rust
pub struct PageCache {
    pages: BTreeMap<usize, Arc<BackedPage>>,
}

pub struct BackedPage {
    pub(super) inner: Page,
    pub(super) state_guard: SleepMutex<()>,
    pub(super) state: Atomic<PageState>,
}

#[derive(bytemuck::NoUninit, Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PageState {
    Invalid,
    Synced,
    Dirty,
}
```

**页缓存功能**：
- 缓存文件页，减少磁盘访问
- 支持页状态跟踪（Invalid、Synced、Dirty）
- 使用 `SleepMutex` 实现异步锁

#### 3.8.6 管道（Pipe）

```rust
const PIPE_CAPACITY: usize = 16384;

#[derive(Clone)]
pub struct Pipe {
    meta: Arc<InodeMeta>,
    inner: PipeInner,
}

impl Pipe {
    pub async fn read(&self, buf: UserCheck<[u8]>) -> KResult<usize> {
        let PipeInner::ReadEnd(receiver) = &self.inner else {
            return Err(errno::EBADF);
        };
        let buf = unsafe { buf.check_slice_mut()? };
        let mut out = buf.out();
        let mut n_read = 0;

        while let Some(ptr) = out.reborrow().get_out(n_read)
            && let Ok(byte) = receiver.recv().await
        {
            ptr.write(byte);
            n_read += 1;
        }
        // ...
    }

    pub async fn write(&self, buf: UserCheck<[u8]>) -> KResult<usize> {
        let PipeInner::WriteEnd(sender) = &self.inner else {
            return Err(errno::EBADF);
        };
        let buf = buf.check_slice()?;
        let mut n_write = 0;

        for &byte in &*buf {
            if sender.send(byte).await.is_err() {
                break;
            }
            n_write += 1;
        }
        // ...
    }
}

pub fn make_pipe() -> (Pipe, Pipe) {
    let (sender, receiver) = async_channel::bounded(PIPE_CAPACITY);
    let meta = Arc::new(InodeMeta::new(
        InodeMode::Fifo,
        CompactString::from_static_str("_pipe"),
    ));
    // ...
}
```

**管道特性**：
- 容量：16KB
- 基于 `async_channel` 实现异步读写
- 支持阻塞等待

---

### 3.9 设备驱动（Device Drivers）

**目录**：`crates/kernel/src/drivers/`

**实现完整度**：80%

#### 3.9.1 VirtIO 块设备驱动

```rust
pub struct DiskDriver {
    device: SpinMutex<VirtIOBlk<HalImpl, MmioTransport>>,
    /// 仅用于读的块缓存
    caches: RwLock<HashMap<usize, [u8; BLOCK_SIZE]>>,
}

impl DiskDriver {
    pub fn read_blocks(&self, block_id: usize, buf: &mut [u8; BLOCK_SIZE]) {
        if let Err(e) = self.device.lock().read_blocks(block_id, buf) {
            panic!("Failed reading virtio blocks {block_id}: {e}");
        }
    }

    pub fn read_blocks_cached(&self, block_id: usize, buf: &mut [u8; BLOCK_SIZE]) {
        if let Some(block) = self.caches.read().get(&block_id) {
            buf.copy_from_slice(block);
            return;
        }
        self.read_blocks(block_id, buf);
        self.caches.write().insert(block_id, *buf);
    }
}
```

**HAL 实现**：

```rust
pub struct HalImpl;

unsafe impl Hal for HalImpl {
    fn dma_alloc(
        pages: usize,
        _direction: virtio_drivers::BufferDirection,
    ) -> (virtio_drivers::PhysAddr, NonNull<u8>) {
        let frames = ContinuousFrames::alloc(pages).unwrap();
        let pa_start = frames.start_ppn().page_start();
        core::mem::forget(frames);
        let vptr = NonNull::new(kernel_pa_to_va(pa_start).as_mut_ptr::<u8>()).unwrap();
        (pa_start.0, vptr)
    }

    unsafe fn dma_dealloc(
        paddr: virtio_drivers::PhysAddr,
        _vaddr: NonNull<u8>,
        pages: usize,
    ) -> i32 {
        let ppn = PhysAddr(paddr).ppn();
        unsafe {
            memory::frame_dealloc(ppn..(ppn + pages));
        }
        0
    }

    unsafe fn mmio_phys_to_virt(paddr: virtio_drivers::PhysAddr, _size: usize) -> NonNull<u8> {
        let va = paddr + PA_TO_VA;
        NonNull::new(va as _).unwrap()
    }
}
```

**块缓存**：
- 使用 `HashMap` 缓存已读取的块
- 仅支持读缓存，写操作未实现

#### 3.9.2 UART 16550 串口驱动

```rust
pub struct Uart {
    port: SpinNoIrqMutex<MmioSerialPort>,
}

impl Uart {
    pub fn print(&self, s: &str) {
        let mut port = self.port.lock();
        for byte in s.as_bytes() {
            port.send(*byte);
        }
    }

    pub fn handle_irq(&self) {
        trace!("uart interrupt");
        let ch = self.port.lock().receive();
        let mut tty = TTY.lock();
        if tty.queue.push_back(ch).is_err() {
            trace!("uart input discard: {ch}");
        }
        if let Some(waker) = tty.waker.take() {
            waker.wake();
        }
    }
}
```

**TTY 层**：

```rust
pub struct Tty {
    pub(crate) queue: Deque<u8, TTY_BUFFER_LEN>,
    pub(crate) waker: Option<Waker>,
}

impl Tty {
    pub fn get_byte(&mut self) -> Option<u8> {
        self.queue.pop_front()
    }

    pub fn register_waker(&mut self, waker: Waker) {
        if let Some(old_waker) = self.waker.replace(waker) {
            old_waker.wake();
        }
    }
}
```

**特性**：
- 输入缓冲区：128 字节（`heapless::Deque`）
- 支持异步读取（通过 Waker 机制）
- 中断驱动

#### 3.9.3 PLIC 中断控制器

```rust
#[repr(C, align(4096))]
pub struct Plic {
    priorities: Priorities,
    pending_bits: PendingBits,
    _reserved0: [u8; 4096 - core::mem::size_of::<PendingBits>()],
    enables: Enables,
    _reserved1: [u8; 0xe000],
    context_local: [ContextLocal; COUNT_CONTEXT],
}

impl Plic {
    pub fn set_priority(&self, source_id: usize, value: u32) {
        let ptr = self.priorities.0[source_id].get();
        unsafe { ptr.write_volatile(value) }
    }

    pub fn enable(&self, source_id: usize, context_id: usize) {
        let pos = context_id * COUNT_SOURCE + source_id;
        let group = pos / U32_BITS;
        let index = pos % U32_BITS;

        let ptr = self.enables.0[group].get();
        unsafe { ptr.write_volatile(ptr.read_volatile() | (1 << index)) }
    }

    pub fn claim(&self, context_id: usize) -> usize {
        let ptr = self.context_local[context_id].claim_or_completion.get();
        unsafe { ptr.read_volatile() as usize }
    }

    pub fn complete(&self, context_id: usize, source_id: usize) {
        let ptr = self.context_local[context_id].claim_or_completion.get();
        unsafe { ptr.write_volatile(source_id as u32) }
    }
}
```

**中断源**：
- VirtIO（ID=1）
- UART0（ID=10）

---

### 3.10 信号机制（Signal Mechanism）

**目录**：`crates/kernel/src/signal/`

**实现完整度**：75%

#### 3.10.1 信号定义

```rust
#[derive(Debug, PartialEq, Eq, Clone, Copy, TryFromPrimitive)]
#[repr(u8)]
pub enum Signal {
    SIGHUP = 0,
    SIGINT = 1,
    SIGQUIT = 2,
    SIGILL = 3,
    SIGTRAP = 4,
    SIGABRT = 5,
    SIGBUS = 6,
    SIGFPE = 7,
    SIGKILL = 8,
    SIGUSR1 = 9,
    SIGSEGV = 10,
    SIGUSR2 = 11,
    SIGPIPE = 12,
    SIGALRM = 13,
    SIGTERM = 14,
    SIGSTKFLT = 15,
    SIGCHLD = 16,
    SIGCONT = 17,
    SIGSTOP = 18,
    SIGTSTP = 19,
    SIGTTIN = 20,
    SIGTTOU = 21,
    SIGURG = 22,
    SIGXCPU = 23,
    SIGXFSZ = 24,
    SIGVTALRM = 25,
    SIGPROF = 26,
    SIGWINCH = 27,
    SIGIO = 28,
    SIGPWR = 29,
    SIGSYS = 30,
}
```

**支持 31 种标准信号**（编号从 0 开始，与 Linux 不同）

#### 3.10.2 信号处理器

```rust
#[derive(Clone)]
pub struct SignalHandlers {
    actions: [KSignalAction; SIGSET_SIZE],
}

impl SignalHandlers {
    pub const fn new() -> Self {
        const DEFAULT_ACTION: KSignalAction = KSignalAction::new();
        Self {
            actions: [DEFAULT_ACTION; SIGSET_SIZE],
        }
    }

    pub fn action(&self, signal: Signal) -> &KSignalAction {
        &self.actions[signal as usize]
    }

    pub fn action_mut(&mut self, signal: Signal) -> &mut KSignalAction {
        &mut self.actions[signal as usize]
    }
}
```

#### 3.10.3 默认处理器

```rust
pub enum DefaultHandler {
    Terminate,
    Ignore,
    CoreDump,
    Stop,
    Continue,
}

impl DefaultHandler {
    pub fn new(signal: Signal) -> Self {
        use Signal::*;
        match signal {
            SIGABRT | SIGBUS | SIGILL | SIGQUIT | SIGSEGV | SIGSYS | SIGTRAP | SIGXCPU
            | SIGXFSZ => DefaultHandler::CoreDump,
            SIGCHLD | SIGURG | SIGWINCH => DefaultHandler::Ignore,
            SIGSTOP | SIGTSTP | SIGTTIN | SIGTTOU => DefaultHandler::Stop,
            SIGCONT => DefaultHandler::Continue,
            _ => DefaultHandler::Terminate,
        }
    }
}
```

#### 3.10.4 信号传递

```rust
pub fn check_signal() -> bool {
    let first_pending = {
        let thread = local_hart().curr_thread();
        let mut inner = thread.lock_inner();
        let pendings = inner.pending_signal.intersection(!inner.signal_mask);
        let Ok(first_pending) = Signal::try_from(pendings.bits().trailing_zeros() as u8) else {
            return false;
        };
        inner.pending_signal.remove(KSignalSet::from(first_pending));
        first_pending
    };

    debug!("handle signal {first_pending:?}");
    let action = local_hart()
        .curr_process()
        .lock_inner_with(|inner| inner.signal_handlers.action(first_pending).clone());
    
    let handler = match action.handler() {
        SIG_ERR => todo!("[low] maybe there is no `SIG_ERR`"),
        SIG_DFL => match DefaultHandler::new(first_pending) {
            DefaultHandler::Terminate | DefaultHandler::CoreDump => {
                exit_process(
                    &local_hart().curr_process(),
                    (first_pending as i8).wrapping_add_unsigned(128),
                );
                return true;
            }
            DefaultHandler::Ignore => return false,
            DefaultHandler::Stop | DefaultHandler::Continue => {
                todo!("[low] default handler Stop and Continue")
            }
        },
        SIG_IGN => return false,
        handler => handler,
    };

    // 设置信号处理上下文
    let thread = local_hart().curr_thread();
    let (old_mask, old_trap_context) = thread.lock_inner_with(|inner| {
        let old_mask = inner.signal_mask;
        let old_trap_context = inner.trap_context.clone();
        inner.signal_mask.insert(action.mask());
        if !action.flags().contains(SignalActionFlags::SA_NODEFER) {
            inner.signal_mask.set(KSignalSet::from(first_pending), true);
        }
        let trap_context = &mut inner.trap_context;
        trap_context.sepc = handler;
        *trap_context.sp_mut() = trap_context.sp() - core::mem::size_of::<SignalContext>();
        *trap_context.ra_mut() = action.restorer();
        *trap_context.a0_mut() = first_pending as usize + 1;

        (old_mask, old_trap_context)
    });

    let signal_context = SignalContext {
        old_mask,
        old_trap_context,
    };

    let sp = signal_context.old_trap_context.sp() - core::mem::size_of::<SignalContext>();
    let user_ptr = unsafe { UserCheck::new(sp as *mut SignalContext).check_ptr_mut() };
    user_ptr.write(signal_context);
    
    false
}
```

**信号传递流程**：
1. 检查待处理信号
2. 获取信号处理器（默认、忽略或自定义）
3. 保存当前上下文到用户栈
4. 修改 trap 上下文，跳转到信号处理函数
5. 信号处理完成后，通过 `sigreturn` 恢复上下文

**未实现的特性**：
- Stop/Continue 默认处理器
- 信号队列（实时信号）
- siginfo 传递

---

### 3.11 时间管理（Time Management）

**目录**：`crates/kernel/src/time/`

**实现完整度**：85%

#### 3.11.1 时间获取

```rust
pub fn curr_time() -> Duration {
    let curr_ns = riscv_time::get_time_ns();
    Duration::from_nanos(curr_ns as u64)
}
```

**时间源**：RISC-V `time` CSR（计数器）

#### 3.11.2 定时器

```rust
struct TimerFuture {
    expire_ms: usize,
    timer_activated: bool,
}

impl Future for TimerFuture {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.expire_ms > riscv_time::get_time_ms() {
            if !self.timer_activated {
                TIMERS.lock().push(Reverse(Timer {
                    expire_ms: self.expire_ms,
                    waker: cx.waker().clone(),
                }));
                self.timer_activated = true;
            }
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    }
}

struct Timer {
    expire_ms: usize,
    waker: Waker,
}

static TIMERS: SpinNoIrqMutex<BinaryHeap<Reverse<Timer>>> =
    SpinNoIrqMutex::new(BinaryHeap::<Reverse<Timer>>::new());

pub fn check_timer() {
    let mut timers = TIMERS.lock();
    let curr_ms = riscv_time::get_time_ms();
    while let Some(timer) = timers.peek() {
        if curr_ms >= timer.0.expire_ms {
            let timer = timers.pop().unwrap();
            timer.0.waker.wake();
        } else {
            break;
        }
    }
}

pub fn sleep(time: Duration) -> impl Future<Output = ()> {
    let curr_ms = riscv_time::get_time_ms();
    let expire_ms = curr_ms + time.as_millis() as usize;
    TimerFuture {
        expire_ms,
        timer_activated: false,
    }
}
```

**定时器特性**：
- 使用最小堆管理定时器
- 支持异步睡眠（`sleep` 返回 Future）
- 定时器中断触发时检查并唤醒到期任务

**时钟频率**：10MHz（`CLOCK_FREQ = 10_000_000`）

**定时器中断频率**：100 Hz（`TICKS_PER_SEC = 100`）

---

### 3.12 日志与性能分析（Tracer）

**目录**：`crates/kernel/src/tracer/` + `crates/utils/kernel_tracer/`

**实现完整度**：80%

#### 3.12.1 日志系统

项目使用自定义的 `kernel_tracer` crate 实现日志系统，支持多级日志：

- `trace`：最详细的调试信息
- `debug`：调试信息
- `info`：一般信息
- `warn`：警告
- `error`：错误

**日志宏**：

```rust
#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        $crate::log($crate::Level::Info, format_args!($($arg)*))
    };
}
```

#### 3.12.2 性能分析（Profiling）

```rust
pub struct SpanId {
    // ...
}

// 支持 span 嵌套
let _enter = info_span!("hart", id = hart_id).entered();
```

**特性**：
- 基于 span 的性能分析
- 支持嵌套 span
- 可输出至 perfetto 可视化工具（需启用 `profiling` feature）

---

### 3.13 同步原语（Synchronization Primitives）

**目录**：`crates/utils/klocks/`

**实现完整度**：90%

#### 3.13.1 自旋锁

```rust
pub struct SpinMutex<T: ?Sized> {
    base: spin::mutex::SpinMutex<T>,
}

impl<T: ?Sized> SpinMutex<T> {
    #[inline]
    #[track_caller]
    pub fn lock(&self) -> SpinMutexGuard<'_, T> {
        #[cfg(all(debug_assertions, not(test)))]
        let begin = riscv_time::get_time_ms();
        loop {
            if let Some(guard) = self.try_lock() {
                return guard;
            }

            while self.is_locked() {
                core::hint::spin_loop();
                #[cfg(all(debug_assertions, not(test)))]
                if riscv_time::get_time_ms() - begin >= 2000 {
                    panic!("deadlock detected");
                }
            }
        }
    }
}
```

**死锁检测**：Debug 模式下，锁等待超过 2 秒会触发 panic

#### 3.13.2 关中断自旋锁

```rust
pub struct SpinNoIrqMutex<T: ?Sized> {
    base: spin::mutex::SpinMutex<T>,
}

pub struct SpinNoIrqMutexGuard<'a, T: ?Sized> {
    spin_guard: ManuallyDrop<spin::mutex::SpinMutexGuard<'a, T>>,
    #[cfg(not(test))]
    _no_irq_guard: riscv_guard::NoIrqGuard,
}

impl<T: ?Sized> SpinNoIrqMutex<T> {
    #[inline]
    #[track_caller]
    fn try_lock(&self) -> Option<SpinNoIrqMutexGuard<'_, T>> {
        #[cfg(not(test))]
        let _no_irq_guard = riscv_guard::NoIrqGuard::new();
        self.base.try_lock().map(|spin_guard| SpinNoIrqMutexGuard {
            spin_guard: ManuallyDrop::new(spin_guard),
            #[cfg(not(test))]
            _no_irq_guard,
        })
    }
}
```

**特性**：
- 获取锁时关闭中断
- 释放锁时恢复中断状态
- 防止中断处理器中发生死锁

#### 3.13.3 读写锁

使用 `spin::RwLock`，支持多读单写：

```rust
pub use spin::{
    rwlock::{RwLockReadGuard, RwLockWriteGuard},
    RwLock,
};
```

---

### 3.14 用户态程序（User-space Programs）

**目录**：`user/`

**实现完整度**：95%（测试程序）

#### 3.14.1 用户态库

```rust
// user/src/lib.rs
pub fn fork() -> isize {
    syscall(SYS_CLONE, [0, 0, 0, 0, 0])
}

pub fn exec(path: &str) -> isize {
    syscall(SYS_EXECVE, [path.as_ptr() as usize, 0, 0, 0, 0])
}

pub fn exit(exit_code: i32) -> ! {
    syscall(SYS_EXIT, [exit_code as usize, 0, 0, 0, 0]);
    unreachable!()
}

pub fn wait(exit_code: &mut i32) -> isize {
    syscall(SYS_WAIT4, [-1isize as usize, exit_code as *mut _ as usize, 0, 0, 0])
}
```

#### 3.14.2 综合测试程序

`preliminary_tests.rs` 覆盖 32 项系统调用测试：

- 内存管理：`brk`、`mmap`、`munmap`
- 进程管理：`fork`、`exec`、`exit`、`wait`、`waitpid`
- 文件系统：`open`、`close`、`read`、`write`、`mkdir`、`unlink`、`chdir`、`getcwd`、`getdents`
- 管道：`pipe`
- 文件描述符：`dup`、`dup2`
- 时间：`gettimeofday`、`sleep`、`times`
- 进程信息：`getpid`、`getppid`、`uname`
- 调度：`yield`
- 挂载：`mount`、`umount`
- 线程：`clone`

---

## 四、子系统交互

### 4.1 启动流程

```
_start (entry.S)
  ↓
__hart_entry (hart/mod.rs)
  ↓
memory::init() → 初始化堆和页帧分配器
  ↓
KERNEL_SPACE.activate() → 激活内核页表
  ↓
drivers::init() → 初始化 PLIC、UART、VirtIO
  ↓
tracer::init() → 初始化日志系统
  ↓
fs::init() → 初始化 VFS 和 FAT32
  ↓
thread::spawn_user_thread(INITPROC) → 启动 init 进程
  ↓
kernel_loop() → 进入调度循环
```

### 4.2 系统调用流程

```
用户态 ecall
  ↓
__trap_from_user (trap.S) → 保存上下文
  ↓
user_trap_handler() → 分发系统调用
  ↓
syscall::syscall() → 调用具体实现
  ↓
返回用户态 __return_to_user (trap.S)
```

### 4.3 文件读写流程

```
sys_read(fd, buf, len)
  ↓
prepare_io() → 检查文件描述符
  ↓
FileDescriptor::read()
  ↓
PagedFile::read() → 调用 inode
  ↓
PagedInode::read_at() → 页缓存查找
  ↓
（缓存未命中）FatFile::read_page() → 从磁盘读取
  ↓
DiskDriver::read_blocks() → VirtIO 块设备
```

### 4.4 进程 fork 流程

```
sys_clone(flags, stack, ...)
  ↓
Process::fork()
  ↓
MemorySpace::from_other() → 复制地址空间
  ↓
FdTable::clone() → 复制文件描述符表
  ↓
SignalHandlers::clone() → 复制信号处理器
  ↓
Thread::new() → 创建子进程主线程
  ↓
spawn_user_thread() → 加入调度队列
```

---

## 五、整体实现完整度评估

### 5.1 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 处理器核心管理 | 85% | 多核支持已实现但未启用 |
| 异常与中断处理 | 90% | 支持主要异常类型 |
| 内存管理 | 85% | 缺少 COW、大页支持 |
| 进程管理 | 80% | 缺少进程组、会话支持 |
| 线程管理 | 70% | 不支持多线程 |
| 异步执行器 | 85% | 功能完整，缺少优先级调度 |
| 系统调用 | 75% | 缺少网络、I/O 多路复用 |
| 文件系统 | 70% | FAT32 写入未实现 |
| 设备驱动 | 80% | 仅支持 QEMU virt 平台 |
| 信号机制 | 75% | 缺少实时信号、siginfo |
| 时间管理 | 85% | 功能完整 |
| 日志与性能分析 | 80% | 功能完整 |
| 同步原语 | 90% | 功能完整 |

### 5.2 整体完整度

**综合评估**：78%

**优势**：
- 异步设计，支持非阻塞 I/O
- 完整的内存管理（页表、堆、mmap）
- 功能完整的文件系统（VFS + FAT32）
- 信号机制基本可用
- 代码质量高，注释详细

**不足**：
- 不支持多线程
- FAT32 写入未实现
- 缺少网络支持
- 缺少 I/O 多路复用（select/poll/epoll）
- 多核支持未启用

---

## 六、创新性分析

### 6.1 异步内核设计

**创新点**：将 Rust 的 async/await 机制应用于内核开发，实现真正的异步 I/O。

**具体体现**：
- 系统调用可以是 `async fn`，支持阻塞操作（如文件读写、睡眠）
- 使用 `async-task` 实现轻量级任务调度
- 用户线程以异步任务形式运行

**优势**：
- 避免内核线程阻塞
- 提高 I/O 并发能力
- 代码更清晰（避免回调地狱）

### 6.2 Rust 语言特性应用

**创新点**：充分利用 Rust 的类型系统和所有权机制保证内核安全。

**具体体现**：
- 使用 `Arc` 管理共享资源（进程、线程、文件）
- 使用 `UserCheck` 类型安全地访问用户空间
- 使用 `Frame` 的 RAII 语义自动管理物理页
- 使用 `#[repr(C)]` 保证与硬件接口的兼容性

### 6.3 页缓存设计

**创新点**：实现类 Linux 的页缓存机制，支持文件后备的内存映射。

**具体体现**：
- `PageCache` 缓存文件页
- `BackedPage` 跟踪页状态（Invalid、Synced、Dirty）
- 支持 mmap 文件映射

### 6.4 用户空间访问安全

**创新点**：使用 `UserCheck` 类型和 naked 函数实现安全的用户空间访问。

**具体体现**：
```rust
pub struct UserCheck<T: ?Sized> {
    ptr: *mut T,
}

impl UserCheck<u8> {
    pub fn check_cstr(&self) -> KResult<UserRead<str>> {
        // 使用 naked 函数尝试读取，捕获异常
        // 如果发生缺页，尝试按需映射
    }
}
```

**优势**：
- 编译期保证用户指针经过检查
- 运行时捕获非法访问
- 支持按需映射（lazy allocation）

---

## 七、其他信息

### 7.1 依赖管理

项目使用 `vendor/` 目录提供离线依赖，包括：
- `async-task`：异步任务调度
- `crossbeam-queue`：无锁队列
- `goblin`：ELF 解析
- `virtio-drivers`：VirtIO 设备驱动
- `uart_16550`：UART 驱动
- `buddy_system_allocator`：伙伴系统分配器
- `spin`：自旋锁
- `triomphe`：Arc 实现
- `compact_str`：紧凑字符串

### 7.2 构建系统

使用 xtask 模式，支持以下命令：
- `cargo xbuild`：构建内核
- `cargo qemu`：在 QEMU 中运行
- `cargo ktest`：运行测试
- `cargo asm`：查看汇编输出

### 7.3 代码风格

- 使用 `rustfmt` 格式化代码
- 启用大量 clippy lints（见 `Cargo.toml`）
- 详细的文档注释

### 7.4 配置参数

```rust
pub const MEMORY_END: usize = 0x8800_0000;        // 128MB
pub const KERNEL_HEAP_SIZE: usize = 32 * MiB;     // 32MB
pub const USER_STACK_SIZE: usize = 8 * MiB;       // 8MB
pub const HART_NUM: usize = 8;                    // 8 核
pub const TASK_LIMIT: usize = 256;                // 256 任务
pub const CLOCK_FREQ: usize = 10_000_000;         // 10MHz
pub const TICKS_PER_SEC: usize = 100;             // 100Hz
```

---

## 八、总结

### 8.1 项目定位

asynclear 是一个**教学与研究导向**的操作系统内核，重点探索：
- Rust 语言在系统编程中的应用
- 异步编程模型在内核中的实现
- 现代操作系统核心机制（内存管理、文件系统、进程管理）

### 8.2 技术亮点

1. **异步内核**：创新性地将 async/await 应用于内核开发
2. **类型安全**：充分利用 Rust 类型系统保证安全性
3. **代码质量**：注释详细，结构清晰，遵循最佳实践
4. **功能完整**：实现了操作系统的核心子系统

### 8.3 适用场景

- 操作系统课程教学
- Rust 系统编程学习
- 异步内核研究
- OS 竞赛项目

### 8.4 改进建议

1. **启用多核支持**：取消注释多核启动代码，实现真正的 SMP
2. **实现 FAT32 写入**：完善文件系统功能
3. **添加多线程支持**：实现 `CLONE_THREAD` 语义
4. **实现 I/O 多路复用**：添加 select/poll/epoll 支持
5. **添加网络支持**：实现 virtio-net 驱动和 TCP/IP 协议栈
6. **实现 COW**：优化 fork 性能
7. **添加更多文件系统**：如 ext4、tmpfs 完整实现

### 8.5 总体评价

asynclear 是一个**高质量的教学级操作系统内核**，在异步设计和 Rust 语言应用方面具有创新性。代码结构清晰，注释详细，适合作为学习操作系统和 Rust 系统编程的参考项目。虽然在生产环境功能上有所欠缺（如不支持多线程、网络），但其核心机制实现完整，具有良好的扩展性。

**推荐指数**：★★★★☆（4/5）

**适合人群**：
- 操作系统学习者
- Rust 系统编程爱好者
- 对异步内核感兴趣的研究者
- OS 竞赛参赛者