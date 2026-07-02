# Project Aurora 深入技术分析报告

## 一、分析方法与覆盖范围

本次分析覆盖了项目全部 **20,686 行**源代码（内核总计），包含以下维度的调查：

| 分析维度 | 具体操作 |
|---|---|
| 静态代码审查 | 逐文件阅读全部 `.rs`、`.S`、`.ld` 源文件 |
| 构建验证 | 成功执行 `cargo build -p axruntime --target riscv64gc-unknown-none-elf` |
| 运行验证 | 通过 QEMU 启动内核，验证基本启动流程（DTB 解析、内存初始化、页表启用） |
| 子系统拆解 | 对 12 个子系统逐个追踪代码路径和数据流 |
| 接口分析 | 梳理 VFS trait、块设备 trait、网络设备 trait 的接口定义与实现关系 |

构建使用 Rust 1.75.0 工具链，目标 `riscv64gc-unknown-none-elf`，在 `--features user-test` 下也编译通过。QEMU 启动测试确认内核能够完成 OpenSBI 到内核入口的完整启动链，输出 Aurora banner、DTB 解析结果、内存初始化信息和页表启用确认。

---

## 二、构建与测试结果

### 2.1 构建

默认构建（无 feature）和 `--features user-test` 均编译通过。

```
cargo build -p axruntime --target riscv64gc-unknown-none-elf  # 成功
cargo build -p axruntime --target riscv64gc-unknown-none-elf --features user-test  # 成功
```

### 2.2 QEMU 启动测试

在无 feature 的基础构建下，QEMU 启动输出：

```
OpenSBI v1.3
...
 :: Aurora OS :: (Powered by Rust)
Aurora kernel booting...
hart_id=0x0 dtb=0x8fe00000
dtb: uart base=0x10000000 size=0x100
dtb: timebase-frequency=10000000Hz
dtb: virtio-mmio base=0x10008000 size=0x1000 irq=8
dtb: virtio-mmio base=0x10007000 size=0x1000 irq=7
dtb: virtio-mmio base=0x10006000 size=0x1000 irq=6
dtb: virtio-mmio base=0x10005000 size=0x1000 irq=5
dtb: plic base=0xc000000 size=0x600000
mm: memory base=0x80000000 size=0x10000000
mm: frame allocator start=0x80791000 end=0x90000000 pages=63599
mm: paging enabled (sv39 identity map)
timer: tick=10Hz interval=1000000 ticks
```

内核成功完成：入口初始化、BSS 清零、控制台输出、DTB 解析、物理内存/设备区域识别、Sv39 页表建立与启用、时钟初始化。之后进入 idle loop。

---

## 三、子系统实现清单

| 编号 | 子系统 | 实现状态 | 核心文件 |
|---|---|---|---|
| 1 | 启动引导 (Bootstrap) | **完整** | `entry.S`, `main.rs`, `dtb.rs`, `console.rs`, `sbi.rs` |
| 2 | 内存管理 (MM) | **较完整** | `mm.rs` (1379行) |
| 3 | Trap/中断处理 | **较完整** | `trap.S`, `trap.rs` (389行) |
| 4 | 进程/任务管理 | **较完整** | `task.rs`, `process.rs`, `scheduler.rs`, `runtime.rs` |
| 5 | 系统调用 (Syscall) | **较完整** | `syscall.rs` (6416行) |
| 6 | 文件系统 (VFS + 多后端) | **较完整** | `axvfs/lib.rs`, `axfs/*.rs` (共5387行) |
| 7 | 网络栈 | **较完整** | `axnet/*.rs` (共1510行) |
| 8 | VirtIO 块设备驱动 | **较完整** | `virtio_blk.rs` (526行) |
| 9 | VirtIO 网卡驱动 | **较完整** | `virtio_net.rs` (556行) |
| 10 | 同步原语 | **较完整** | `futex.rs`, `wait.rs`, `wait_queue.rs`, `sleep.rs`, `sleep_queue.rs`, `task_wait_queue.rs` |
| 11 | 异步执行器 | **基本** | `async_exec.rs` (243行) |
| 12 | 用户态支持 | **较完整** | `user.rs` (852行) |

---

## 四、各子系统详细拆解

### 4.1 启动引导 (Bootstrap)

**入口链**：OpenSBI (M-mode) → `_start` (S-mode) → `rust_main`

#### 4.1.1 汇编入口 (`arch/riscv64/entry.S`)

```asm
_start:
    csrw sie, zero           # 关中断
    # 清零 BSS（不使用栈，因为栈本身在 BSS 中）
    la t0, sbss
    la t1, ebss
1:  bgeu t0, t1, 2f
    sd zero, 0(t0)
    addi t0, t0, 8
    j 1b
2:  la sp, boot_stack_top   # 设启动栈 (64KB)
    call rust_main           # 跳转 Rust 入口
```

- BSS 清零循环使用了巧妙的设计：因为 `.bss.stack` 在 BSS 段内，不能在设栈前使用栈，故直接使用寄存器循环清零。
- 启动栈大小为 `4096 * 16 = 64KB`。

#### 4.1.2 Rust 入口 (`main.rs`)

`rust_main` 按以下顺序初始化子系统：

1. `trap::init()` — 设置 `stvec` 指向 `__trap_vector`，清零 `sscratch`
2. 打印 Aurora banner
3. `dtb::parse(dtb_addr)` — 解析设备树，提取内存/UART/virtio/PLIC/时间基准频率
4. `mm::init(memory, devices)` — 初始化物理页帧分配器，建立 Sv39 内核页表
5. `plic::init(plic_region)` — 初始化平台级中断控制器
6. `fs::init(virtio_mmio)` — 初始化根文件系统块设备 (virtio-blk 或内存盘)
7. `virtio_net::init(virtio_mmio)` — 初始化网卡
8. `axnet::init(dev)` — 初始化 smoltcp 网络栈
9. `time::init(timebase, tick_hz)` — 初始化时钟，计算 tick 间隔
10. `trap::enable_timer_interrupt(interval)` + `trap::enable_external_interrupts()` — 开中断
11. `runtime::init()` — 初始化调度器（可选调度 demo 任务）
12. 条件性启动用户态（`user-test` 或 `user-shell` feature）
13. `runtime::enter_idle_loop()` — 进入主调度循环

#### 4.1.3 DTB 解析 (`dtb.rs`, 456行)

完整实现了 Flattened Device Tree (FDT) 解析器：
- 验证 FDT 魔数 (`0xd00dfeed`)
- 递归遍历节点树，深度上限 16 层
- 解析 `#address-cells`/`#size-cells` 以正确处理 `reg` 属性
- 提取 `memory@`、`uart@`/`serial@`、`virtio_mmio@`/`virtio@`、`plic@` 节点的 `reg` 和 `interrupts`
- 提取 `timebase-frequency`
- 支持最多 4 个 virtio-mmio 设备

#### 4.1.4 SBI 封装 (`sbi.rs`, 90行)

同时支持 SBI legacy 和 v0.2+ 调用规范：
- `console_putchar`/`console_getchar`：使用 legacy SBI (EID=1/2)
- `set_timer`：先尝试 SBI TIME 扩展 (EID=0x54494D45)，失败则回退到 legacy
- `shutdown`：先尝试 SRST 扩展 (EID=0x53525354)，失败则回退到 legacy

---

### 4.2 内存管理 (MM) (`mm.rs`, 1379行)

#### 4.2.1 地址空间抽象

定义了一套完整的地址类型系统：

```rust
PhysAddr(usize)     // 物理地址
VirtAddr(usize)     // 虚拟地址
PhysPageNum(usize)  // 物理页号 (PPN)
VirtPageNum(usize)  // 虚拟页号 (VPN)
PageTableEntry      // Sv39 页表项
```

虚拟地址提供 `sv39_indexes()` 方法，返回三级页表索引 `[L2, L1, L0]`。

#### 4.2.2 物理页帧分配器

基于 bump allocator 的 `BumpFrameAllocator`：
- 从内核映像结束 (`ekernel`) 的下一页开始
- 以原子操作推进 `next` 指针，支持 `alloc_contiguous(count)` 和 `alloc()`
- 同时维护了一个释放帧链表 (`FRAME_FREE_LIST`)，用于回收已释放帧
- 每个帧维护 16 位引用计数 (`FRAME_REFCOUNT`)，支持 CoW

关键代码：
```rust
pub fn alloc_frame() -> Option<PhysPageNum> {
    // 优先从释放链表弹出
    if let Some(pa) = pop_free_frame() {
        set_refcount(pa, 1);
        return Some(PhysPageNum::new(pa >> PAGE_SHIFT));
    }
    // 否则从 bump allocator 分配
    FRAME_ALLOC.alloc()
}
```

#### 4.2.3 Sv39 页表管理

内核采用**恒等映射**（物理地址=虚拟地址）：
- 映射范围：`0x8000_0000` 到 `0x8000_0000 + 1GB`
- 使用 2MB 大页（`PTE_R|W|X|G|A|D`）覆盖内核代码/数据区
- 设备 MMIO 区域使用 4KB 页映射（`PTE_R|W|G|A|D`，不含 X）

关键初始化代码：
```rust
unsafe fn setup_kernel_page_table(memory: MemoryRegion) -> Option<usize> {
    let root_pa = alloc_user_root()?;  // 分配根页表
    // 恒等映射整个物理内存范围（使用2MB大页）
    // ...
    enable_paging(root_pa);
    KERNEL_ROOT_PA.store(root_pa, Ordering::Relaxed);
    Some(root_pa)
}
```

#### 4.2.4 用户页映射

支持独立用户地址空间的构建：

| 功能 | 函数 |
|---|---|
| 分配用户根页表 | `alloc_user_root()` |
| 映射用户页 | `map_user_page(root_pa, va, pa, flags)` |
| 查询映射 | `user_page_mapped(root_pa, va)` |
| 解除映射 | `unmap_user_page(root_pa, va)` |
| 克隆用户地址空间 | `clone_user_root(parent_root_pa)` |
| 释放用户地址空间 | `release_user_root(root_pa)` |
| 切换活动页表 | `switch_root(root_pa)` |

用户映射使用 `PTE_U` 位标记，支持 `R/W/X` 权限组合。

#### 4.2.5 Copy-on-Write (CoW)

实现了完整的 CoW 机制：

- **标记阶段** (`clone_user_root`)：遍历父进程页表，将可写用户页的 PTE 标记为 `PTE_COW`（bit 8），清除 `PTE_W`，引用计数+1。父子进程共享同一物理页。

```rust
let new_flags = cow_flags(parent_l0e.flags());
parent_l0.entries[l0_idx] = PageTableEntry::new(parent_l0e.ppn(), new_flags);
child_l0.entries[l0_idx] = PageTableEntry::new(parent_l0e.ppn(), new_flags);
```

- **缺页处理** (`resolve_cow`)：Store page fault 触发时检查 PTE 的 CoW 标志：
  - 若引用计数为 1：直接恢复 `PTE_W`，清除 `PTE_COW`
  - 若引用计数 > 1：分配新帧，复制内容，更新 PTE，释放旧帧引用

```rust
fn resolve_cow(root_pa: usize, va: usize) -> bool {
    // 检查 PTE_COW 标志
    let count = frame_refcount(old_pa).unwrap_or(1);
    if count <= 1 {
        // 唯一引用：直接恢复可写
        *entry_ptr = PageTableEntry::new(entry.ppn(), new_flags);
    } else {
        // 共享引用：分配新页并复制
        let frame = alloc_frame()?;
        ptr::copy_nonoverlapping(old_pa, new_pa, PAGE_SIZE);
        *entry_ptr = PageTableEntry::new(frame, new_flags);
        release_frame(old_pa);
    }
}
```

#### 4.2.6 用户态指针验证

`UserPtr<T>` 和 `UserSlice` 提供了安全的用户态内存访问抽象：
- `translate_user_ptr` 逐页验证用户虚拟地址的映射和权限
- `UserSlice::for_each_chunk` 将用户态切片按页边界分段，逐段校验后执行操作
- 支持 `UserAccess::Read`/`Write`/`Execute` 权限检查
- 遇到 CoW 页时自动触发 `resolve_cow`

#### 4.2.7 完整程度评价

| 功能 | 状态 |
|---|---|
| 物理页帧分配 (bump + freelist) | 完整 |
| Sv39 三级页表 | 完整 |
| 内核恒等映射 (1GB, 2MB 大页) | 完整 |
| 设备 MMIO 映射 | 完整 |
| 用户地址空间创建/销毁 | 完整 |
| CoW fork 语义 | 完整 |
| 用户态指针安全验证 | 完整 |
| 缺页处理 (CoW) | 完整 |
| 大页用户映射支持 | **未实现** (CoW 和释放仅处理 4KB 页) |
| 页表回收 (release) | **部分** (大页释放被跳过) |
| 按需分页 (demand paging) | **未实现** |
| 页面交换 (swap) | **未实现** |

---

### 4.3 Trap 与中断处理

#### 4.3.1 汇编层 (`arch/riscv64/trap.S`, 233行)

精心设计的 trap 向量入口：

**内核态 vs 用户态区分**：利用 `sscratch` CSR 作为标志：
- 内核态 trap：`sscratch == 0`，直接使用当前 `sp` 保存上下文
- 用户态 trap：`sscratch` 存有用户 `sp`，通过 `csrrw sp, sscratch, sp` 交换得到内核栈指针

**TrapFrame 布局**（36 × 8 = 288 字节）：
```
偏移  名称      说明
0*8   ra       返回地址
1*8   gp       全局指针
2*8   tp       线程指针
3-7*8 t0-t2    临时寄存器
8-9*8 s0-s1    被调用者保存
10-23 a0-a7,s2-s11  参数/保存寄存器
24-29 t3-t6    临时寄存器
30*8  sstatus  特权状态
31*8  sepc     异常PC
32*8  scause   异常原因
33*8  stval    异常值
34*8  user_sp  用户栈指针
35*8  pad      填充对齐
```

**返回路径**：`__trap_return` 根据 `sstatus.SPP` 位判断返回内核态还是用户态。返回用户态时通过 `csrrw sp, sscratch, sp` 恢复用户栈指针并保存内核栈指针到 `sscratch`。

#### 4.3.2 Rust 层 (`trap.rs`, 389行)

`trap_handler` 分发逻辑：

| 异常类型 | 处理 |
|---|---|
| Supervisor Timer Interrupt | 设置下一次时钟中断 → `runtime::on_tick()` → `runtime::maybe_schedule()` → 用户态任务可被抢占 |
| Supervisor External Interrupt | 读取 PLIC claim → 分发到 `virtio_blk::handle_irq` / `virtio_net::handle_irq` → complete |
| User Ecall (`scause=8`) | `syscall::handle_syscall(tf)` |
| Supervisor Ecall (`scause=9`) | `sepc += 4`（跳过 ecall 指令） |
| Store/Load/Inst Page Fault | 先尝试 `handle_cow_fault`，失败则 panic |
| Illegal Instruction | 打印诊断信息（仅一次） |

关键设计：外部中断处理时主动切换到内核页表（`mm::switch_root(kernel_root)`），处理完再切回，确保设备 MMIO 地址在内核映射中可达。

---

### 4.4 任务与进程管理

#### 4.4.1 任务控制块 (`task.rs`, 378行)

```rust
pub struct TaskControlBlock {
    pub id: TaskId,
    pub state: TaskState,     // Ready/Running/Blocked
    pub context: Context,     // callee-saved 寄存器快照
    pub entry: Option<TaskEntry>,
    pub kernel_sp: usize,
    pub user_root_pa: usize,
    pub user_entry: usize,
    pub user_sp: usize,
    pub heap_top: usize,      // brk
    pub is_user: bool,
    pub trap_frame: Option<usize>,
    wait_reason: AtomicU8,
}
```

- 固定容量：`MAX_TASKS = 8`
- 全局静态 `TASK_TABLE: [MaybeUninit<TaskControlBlock>; 8]`
- 状态转换：`transition_state(task_id, from, to)` 提供原子 compare-and-swap 语义
- 支持 `WaitReason`（Notified/Timeout）记录阻塞结束原因

#### 4.4.2 上下文切换 (`context.rs` + `arch/riscv64/context.S`)

汇编 `context_switch` 保存/恢复 14 个 callee-saved 寄存器（`ra, sp, s0-s11`），并在切换后清零 `sscratch`（防止内核态残留用户态 `sscratch` 值）。

```asm
context_switch:
    sd ra, 0(a0)       # 保存当前上下文
    ...
    ld ra, 0(a1)       # 恢复目标上下文
    ...
    csrw sscratch, zero
    ret
```

#### 4.4.3 调度器 (`scheduler.rs`, 84行)

简单轮询 (Round-Robin) 调度：
- `RunQueue`：固定大小环形队列 (`MAX_TASKS = 8`)
- `push(task_id)`：线性扫描插入
- `pop_ready()`：从 `head` 开始轮转查找 Ready 状态任务
- 无优先级、无时间片量化——纯协作式结合抢占点（时钟中断触发 `maybe_schedule`）

#### 4.4.4 运行时核心 (`runtime.rs`, 666行)

`enter_idle_loop()` 主循环：
```
loop {
    poll_async_tasks();
    schedule_once();    // 轮询就绪队列
    poll_net();         // 驱动网络栈
    if 无任务运行 {
        enable_interrupts();
        wfi();          // 等待中断
    }
}
```

**用户任务创建** (`spawn_user`)：
```rust
pub fn spawn_user(ctx: UserContext) -> Option<TaskId> {
    let stack = stack::alloc_task_stack()?;
    let task_id = task::alloc_task(user_task_entry, stack.top())?;
    task::set_user_context(task_id, ctx.root_pa, ctx.entry, ctx.user_sp);
    process::init_process(task_id, 0, ctx.root_pa);
    syscall::init_fd_table(task_id);
    RUN_QUEUE.push(task_id);
}
```

**fork 实现** (`spawn_forked_user`)：
- 从父进程的 trapframe 快照构建子进程上下文
- `sepc` 设为 trapframe 中的 `sepc`（fork 返回点）
- 子进程 `a0` 返回 0，父进程返回子 PID

#### 4.4.5 进程管理 (`process.rs`, 225行)

最小化进程表：
```rust
static PROC_STATE: [ProcState; MAX_PROCS];    // Empty/Running/Zombie
static PROC_PPID: [usize; MAX_PROCS];
static PROC_EXIT: [i32; MAX_PROCS];
static PROC_ROOT: [usize; MAX_PROCS];          // 根页表PA
static PROC_CLEARTID: [usize; MAX_PROCS];     // set_tid_address
```

**waitpid** 实现：
- 循环扫描进程表查找僵尸子进程
- 支持 `WNOHANG`（非阻塞轮询）
- 阻塞等待使用 `TaskWaitQueue` + `wait_timeout_ms(10ms)` 重试循环
- 回收僵尸进程时释放其根页表 (`release_user_root`)

**exit** 实现：
- 标记进程为 Zombie
- 若设置了 `clear_tid`，通过 futex 唤醒等待者
- 唤醒父进程的 `PROC_WAITERS`

#### 4.4.6 内核栈管理 (`stack.rs`, 70行)

每个任务分配独立的 4 页 (16KB) 内核栈，外加 1 页保护页（位于栈底下方）：
```rust
pub fn new() -> Option<Self> {
    let alloc_pages = STACK_PAGES + 1;  // 5页：4栈+1保护
    let start = alloc_contiguous_frames(alloc_pages)?;
    let base = start_pa + PAGE_SIZE;    // 跳过保护页
    Some(Self { base, size: STACK_PAGES * PAGE_SIZE })
}
```

---

### 4.5 系统调用 (`syscall.rs`, 6416行)

#### 4.5.1 系统调用号定义

使用 RISC-V Linux ABI（与 `riscv64-linux-gnu` 兼容），**共支持 92 个系统调用**：

| 类别 | 系统调用 |
|---|---|
| 进程控制 | `exit(93)`, `exit_group(94)`, `clone(220)`, `execve(221)`, `wait4(260)`, `getpid(172)`, `getppid(173)`, `gettid(178)` |
| 内存管理 | `brk(214)`, `mmap(222)`, `munmap(215)`, `mprotect(226)`, `madvise(233)`, `rseq(293)` |
| 文件 I/O | `read(63)`, `write(64)`, `pread64(67)`, `pwrite64(68)`, `readv(65)`, `writev(66)`, `preadv(69)`, `pwritev(70)` |
| 文件操作 | `openat(56)`, `open(1024)`, `close(57)`, `pipe2(59)`, `mknodat(33)`, `mkdirat(34)`, `unlinkat(35)`, `symlinkat(36)`, `linkat(37)`, `renameat(38)`, `renameat2(276)` |
| 目录操作 | `getdents64(61)`, `getcwd(17)`, `chdir(49)`, `fchdir(50)` |
| 文件元数据 | `newfstatat(79)`, `fstat(80)`, `faccessat(48)`, `statx(291)`, `statfs(43)`, `fstatfs(44)`, `readlink(89)`, `readlinkat(78)`, `ftruncate(46)`, `fchmodat(53)`, `fchownat(54)`, `utimensat(88)` |
| 文件描述符 | `dup(23)`, `dup3(24)`, `fcntl(25)`, `ioctl(29)` |
| Socket | `socket(198)`, `bind(200)`, `listen(201)`, `accept(202)`, `accept4(242)`, `connect(203)`, `sendto(206)`, `recvfrom(207)`, `sendmsg(211)`, `recvmsg(212)`, `sendmmsg(269)`, `recvmmsg(243)`, `getsockname(204)`, `getpeername(205)`, `setsockopt(208)`, `getsockopt(209)`, `shutdown(210)` |
| Poll/Epoll | `poll(7)`, `ppoll(73)`, `epoll_create1(20)`, `epoll_ctl(21)`, `epoll_pwait(22)`, `epoll_pwait2(441)` |
| Eventfd/Timerfd | `eventfd2(19)`, `timerfd_create(85)`, `timerfd_settime(86)`, `timerfd_gettime(87)` |
| Futex | `futex(98)` |
| 时间 | `clock_gettime(113)`, `clock_getres(114)`, `gettimeofday(169)`, `nanosleep(101)` |
| 其他 | `uname(160)`, `sysinfo(179)`, `getrandom(278)`, `sched_yield(124)`, `sync(162)`, `syncfs`, `prctl(167)`, `set_tid_address(96)` 等 |

#### 4.5.2 文件描述符表

每个进程独立的 FD 表：
```rust
static FD_TABLES: [[FdEntry; 16]; MAX_PROCS];  // 每进程16个FD槽位
```

FD 类型 (`FdObject`)：
- `Stdin`/`Stdout`/`Stderr` — 标准流，stdin 从 SBI 控制台读取
- `Vfs(VfsHandle)` — 普通文件（含 mount ID + inode ID）
- `PipeRead(usize)`/`PipeWrite(usize)` — 管道读写端
- `Socket(SocketId)` — 网络 socket
- `Eventfd(usize)` — eventfd
- `Timerfd(usize)` — timerfd
- `Epoll(usize)` — epoll 实例

支持 `O_NONBLOCK`、`O_CLOEXEC`、`FD_CLOEXEC` 标志，以及 `fcntl(F_GETFL/F_SETFL/F_GETFD/F_SETFD)`。

#### 4.5.3 管道实现

```rust
struct Pipe {
    used: bool,
    readers: usize, writers: usize,  // 引用计数
    read_pos: usize, write_pos: usize, len: usize,
    buf: [u8; 512],   // 512字节环形缓冲区
}
```

- 使用 `PIPE_READ_WAITERS`/`PIPE_WRITE_WAITERS` 阻塞等待
- 支持 `O_NONBLOCK` 非阻塞模式
- 正确处理 EOF（所有写端关闭）

#### 4.5.4 Epoll 实现

```rust
struct EpollInstance {
    used: bool, refs: usize, flags: usize,
    items: [EpollItem; 64],  // 最多64个监控项
}
```

- 支持 `EPOLL_CTL_ADD/DEL/MOD`
- epoll_wait 使用 `TaskWaitQueue` + `wait_timeout_ms` 重试循环实现超时
- 轮询时检查各 FD 状态（pipe 可读/可写、socket 可读/可写/错误）

#### 4.5.5 mmap 实现

当前仅支持 `MAP_ANON | MAP_PRIVATE`（匿名私有映射）：
- 从 `heap_top` 以上分配虚拟地址空间
- 逐个分配物理页帧并清零
- 不支持文件映射、共享映射、固定地址映射

#### 4.5.6 execve 实现

完整实现 ELF 加载：
1. 通过 VFS 读取目标 ELF 镜像
2. 分配新用户根页表
3. 解析 ELF header，加载各 LOAD 段到用户地址空间
4. 构建用户栈（含 argc/argv/envp）
5. 更新 trapframe 的 sepc/a0/a1/a2 指向新程序入口
6. 切换页表，释放旧地址空间
7. 关闭 CLOEXEC FD

---

### 4.6 文件系统

#### 4.6.1 VFS 抽象层 (`crates/axvfs/src/lib.rs`, 147行)

定义了两个核心 trait：

```rust
pub trait VfsOps {
    fn root(&self) -> VfsResult<InodeId>;
    fn lookup(&self, parent: InodeId, name: &str) -> VfsResult<Option<InodeId>>;
    fn create(&self, parent: InodeId, name: &str, kind: FileType, mode: u16) -> VfsResult<InodeId>;
    fn remove(&self, parent: InodeId, name: &str) -> VfsResult<()>;
    fn metadata(&self, inode: InodeId) -> VfsResult<Metadata>;
    fn read_at(&self, inode: InodeId, offset: u64, buf: &mut [u8]) -> VfsResult<usize>;
    fn write_at(&self, inode: InodeId, offset: u64, buf: &[u8]) -> VfsResult<usize>;
    fn read_dir(&self, inode: InodeId, offset: usize, entries: &mut [DirEntry]) -> VfsResult<usize>;
    fn flush(&self) -> VfsResult<()>;
    fn truncate(&self, inode: InodeId, size: u64) -> VfsResult<()>;
}

pub trait FileOps {
    fn read(&mut self, buf: &mut [u8]) -> VfsResult<usize>;
    fn write(&mut self, buf: &[u8]) -> VfsResult<usize>;
    fn seek(&mut self, offset: i64, whence: SeekWhence) -> VfsResult<u64>;
    fn metadata(&self) -> VfsResult<Metadata>;
}
```

#### 4.6.2 挂载表 (`mount.rs`, 212行)

`MountTable<const N: usize>` 支持最多 N 个挂载点：
- 最长前缀匹配算法：`/dev/null` 匹配 `/dev` 挂载点
- 路径解析支持 `.` 和 `..`
- 深度上限 `MAX_PATH_DEPTH = 64`

当前配置 3 个挂载点：
```
/      → memfs (内存文件系统，含 /init)
/dev   → devfs (设备节点)
/proc  → procfs (空壳)
```

当 virtio-blk 可用时，`/` 可替换为 ext4 或 FAT32。

#### 4.6.3 块设备抽象与缓存 (`block.rs`, 263行)

```rust
pub trait BlockDevice {
    fn block_size(&self) -> usize;
    fn read_block(&self, block_id: BlockId, buf: &mut [u8]) -> VfsResult<()>;
    fn write_block(&self, block_id: BlockId, buf: &[u8]) -> VfsResult<()>;
    fn flush(&self) -> VfsResult<()>;
}
```

`BlockCache` 实现：
- 32 行直接映射写回缓存
- 自旋锁保护缓存状态
- 换出脏块时先写回设备

#### 4.6.4 ext4 实现 (`ext4.rs`, 2585行)

**已实现功能**：
- 超级块解析（支持 1024/2048/4096 字节块）
- 块组描述符解析（第 0 块组）
- Inode 读取（含 128/256 字节 inode 大小自适应）
- **Extent 树**寻址（支持 extent header/entry/index 遍历）
- 经典间接块寻址（`i_block[0..11]` 直接块 + 间接块）
- 目录项遍历（含 file_type 字段解析）
- **文件创建**（在目录中分配新 inode，写入目录项）
- **文件写入**（RMW 跨块写入，按需分配数据块）
- **文件截断**（truncate，仅更新 size，不回收物理块）
- create/lookup/metadata/read_at/write_at/read_dir/truncate/flush 完整 VFS 接口

**extent 树寻址实现**：
```rust
fn extent_lookup(&self, inode: &Ext4Inode, block: u32) -> VfsResult<Option<u64>> {
    // 解析 inode.i_block 中的 extent header
    let header = ExtentHeader::parse(&inode.blocks)?;
    // 线性搜索 extent entries
    for i in 0..header.entries {
        let entry = ExtentEntry::parse(&inode.blocks, EXTENT_HEADER_SIZE + i * EXTENT_ENTRY_SIZE);
        if block >= entry.start && block < entry.start + entry.len {
            return Ok(Some(entry.phys + (block - entry.start) as u64));
        }
    }
}
```

**不支持**：
- 日志 (journal)
- metadata_csum 校验
- 配额/xattr/ACL
- 跨块组分配（仅使用第 0 块组）
- extent 树深度 > 0（仅处理叶子 extent）
- 删除 inode 或目录项

#### 4.6.5 FAT32 实现 (`fat32.rs`, 1457行)

- BPB 解析（含 FAT32 扩展字段）
- FAT 链遍历（簇链读取）
- 短文件名目录项解析（支持 DIR/Volume ID/Long Name 属性的区分）
- **文件创建**（分配簇链、写入目录项）
- **文件写入**（RMW、按需扩展簇链）
- Inode ID 编码方案：将簇号和大小编码进 64 位 inode ID
- 提供 `build_minimal_image()` 用于构造内存中的最小 FAT32 镜像

#### 4.6.6 内存文件系统 (`memfs.rs`, 601行)

固定节点的伪文件系统：

```
/          (dir, 0o755)
├── dev/   (dir, 0o755)
│   ├── null  (char, 0o666)
│   └── zero  (char, 0o666)
├── init  (file, 0o444)  ← 内嵌 ELF 镜像
├── proc/ (dir, 0o755)
└── tmp/  (dir, 0o755)
    └── log  (file, 0o644, 1KB 环形缓冲)
```

- `/tmp/log`：支持读写的内存日志缓冲
- `/dev/null`：写丢弃，读返回 0 字节
- `/dev/zero`：写丢弃，读返回零填充

#### 4.6.7 devfs (`devfs.rs`, 156行)

独立的设备文件系统，挂载于 `/dev`：
- `null` — 字符设备
- `zero` — 字符设备

#### 4.6.8 procfs (`procfs.rs`, 97行)

空壳实现，仅有根目录 `.` 和 `..`，无实际 proc 文件。

---

### 4.7 网络栈

#### 4.7.1 架构

基于 smoltcp 0.10 构建：

```
应用程序 (syscall: socket/bind/listen/accept/connect/send/recv)
    ↓
axnet (smoltcp_impl.rs): Socket 管理、poll/事件
    ↓
smoltcp 0.10: TCP/UDP/ICMP/ARP 协议栈
    ↓
NetDevice trait: virtio_net 驱动 (MMIO)
    ↓
VirtIO MMIO → QEMU virtio-net → 宿主机网络
```

#### 4.7.2 Socket 管理 (`smoltcp_impl.rs`, 1463行)

- 最多 8 个并发 socket
- TCP socket 缓冲区大小：65536 字节（为性能测试优化）
- UDP socket 缓冲区大小：2048 字节
- ICMP socket：1 个，用于 ping
- 临时端口从 49152 开始分配

**关键操作**：

| 操作 | 实现 |
|---|---|
| `socket_create` | 分配 socket slot，创建 smoltcp TCP/UDP socket |
| `socket_bind` | 绑定本地 IP:Port |
| `socket_listen` | TCP listen |
| `socket_accept` | 阻塞等待新连接，返回新 socket ID |
| `socket_connect` | TCP 连接（含 ARP 解析） |
| `socket_send` | TCP/UDP 发送（阻塞/非阻塞） |
| `socket_recv` | TCP/UDP 接收（阻塞/非阻塞） |
| `socket_poll` | 查询 socket 可读/可写/错误状态 |
| `socket_close` | 关闭 socket，释放资源 |

#### 4.7.3 网络轮询机制

在 `runtime::on_tick()` 中每 2 个 tick 调用 `axnet::request_poll()` + `axnet::poll()`：

```rust
pub fn on_tick(ticks: u64) {
    if ticks % NET_POLL_TICK_INTERVAL == 0 {
        axnet::request_poll();
        if let Some(event) = axnet::poll(time::uptime_ms()) {
            wake_all(net_wait_queue());
        }
    }
}
```

`poll()` 驱动 smoltcp interface，处理 ARP/ICMP/TCP 定时器和数据收发。

#### 4.7.4 网络事件

```rust
pub enum NetEvent {
    IcmpEchoReply { seq, from },
    ArpReply { from },
    ArpProbeSent { target },
    RxFrameSeen,
    TcpRecvWindow { id, port, window, capacity, queued },
    Activity,
}
```

支持 ICMP ping、ARP 探测、TCP 接收窗口通知。

#### 4.7.5 回环

`SmolDevice` 实现了简单的回环队列 `LoopbackQueue`：发往本机 IP 的帧直接入队，在下次 `receive()` 时返回，无需经过 virtio-net 硬件。

---

### 4.8 VirtIO 驱动

#### 4.8.1 VirtIO 块设备 (`virtio_blk.rs`, 526行)

- MMIO 传输模式
- 单队列 (queue 0)，8 个描述符
- 512 字节扇区
- 通过 DTB 自动发现设备
- 同步 I/O 模型：自旋锁 + inflight 标志 + WaitQueue 阻塞
- 支持 `VIRTIO_BLK_T_IN`（读）和 `VIRTIO_BLK_T_OUT`（写）
- 中断处理：`handle_irq()` 检查 used ring，唤醒等待者

#### 4.8.2 VirtIO 网卡 (`virtio_net.rs`, 556行)

- MMIO 传输模式
- 双队列：RX (queue 0) + TX (queue 1)，各 8 个描述符
- MTU 1500，缓冲区 2048 字节
- 通过 DTB 自动发现设备，读取 MAC 地址
- RX 使用预分配缓冲区循环接收
- TX 使用自旋锁保护
- 中断处理：`handle_irq()` 检查 used ring

---

### 4.9 同步原语

| 模块 | 行数 | 说明 |
|---|---|---|
| `futex.rs` (170行) | Futex | 支持私有/共享 futex，带超时等待，wake 指定数量 |
| `task_wait_queue.rs` (102行) | TaskWaitQueue | 关中断保护的 TaskId 队列 |
| `wait_queue.rs` (34行) | WaitQueue | 面向内核使用的等待队列封装 |
| `sleep_queue.rs` (83行) | SleepQueue | 基于 tick 的定时睡眠队列 |
| `sleep.rs` (28行) | sleep | 高层睡眠 API，优先使用调度器，降级为忙等 |

**futex 设计**：
- 使用 `(root_pa, uaddr)` 作为 futex key
- 私有 futex: `root_pa = 当前页表root`
- 共享 futex: `root_pa = 0`，使用物理地址作为 key
- 最多 `MAX_TASKS`(8) 个并发 futex

---

### 4.10 异步执行器 (`async_exec.rs`, 243行)

最小无堆协作式异步执行器：
- 固定 16 个任务槽位
- `spawn()` 接受 `&'static mut F: Future`
- `poll()` 驱动所有就绪任务
- 自定义 `RawWaker`/`RawWakerVTable`
- 关键区使用关中断（`csrci sstatus, 0x2`）保护

当前未被内核主要路径使用（`poll()` 在 idle loop 中被调用但无 spawn 点）。

---

### 4.11 用户态支持 (`user.rs`, 852行)

#### 4.11.1 内置用户态测试程序

`USER_CODE` 是一个 **1052 字节的手写 RISC-V 机器码**程序，覆盖以下测试路径：
- `poll(NULL, 0, 0)` — 非阻塞 poll 路径
- `pipe2 + ppoll` — 多 FD 超时/睡眠重试
- `write(pipefd[1])` — 管道写入
- `poll(pipefd[0])` — 管道可读就绪
- `writev(1, iovec, 2)` — 跨页 writev（控制台输出 "user: hello\n"）
- `openat + getdents64(/, /dev)` — 静态目录枚举
- `openat("/fatlog.txt") + write/read` — FAT32 文件 I/O
- `openat("/dev/null") + write` — VFS 设备写
- `clone(flags, ptid, ctid)` — fork + tid 写回
- `futex(wait/wake)` — futex EAGAIN/ETIMEDOUT/cleartid 路径
- 子进程校验 ctid + CoW 页面写入后 `exit(42)`
- `wait4(child)` — 父进程回收，验证退出码 + CoW 不变
- `execve("/init")` — ELF 加载与 argv/envp 栈布局

#### 4.11.2 ELF 加载器

实现了最小 ELF64 解析器：
```rust
fn load_elf_segments(root_pa, image, header) -> Result<usize, Errno> {
    for phdr in program_headers {
        if phdr.p_type == PT_LOAD {
            // 分配页，复制段数据，设置权限
            map_user_page(root_pa, va, pa, flags);
        }
    }
}
```

支持 `PT_LOAD` 段，`PF_R/W/X` 权限映射，BSS 清零。

#### 4.11.3 用户栈构建

`build_user_stack` 将 argc/argv/envp 按照 Linux ABI 布局写入用户栈顶：
```
[stack top]
  <envp strings>
  <argv strings>
  <auxv entries>
  <envp pointers> (NULL-terminated)
  <argv pointers> (NULL-terminated)
  argc
[stack pointer →]
```

---

### 4.12 用户态应用程序 (`apps/`)

| 程序 | 说明 |
|---|---|
| `apps/shell/` | 交互式 shell (aurora-sh)，含 banner、命令解析 (ls/cat/cd/pwd/echo/head/tail/wc/stat/hexdump/touch/append/sync/sleep/clear/help/exit)，支持 ANSI 颜色 |
| `apps/tcp_echo/` | TCP echo 测试 (client+server 自测) |
| `apps/udp_echo/` | UDP echo 测试 |
| `apps/fs_smoke/` | 文件系统冒烟测试 |
| `apps/net_bench/` | 网络性能基准测试 |

每个用户程序是 `#![no_std]` 裸机程序，通过 `ecall` 发起系统调用，使用各自的链接脚本，由 `tools/build_init_elf.py` 或对应构建脚本编译为独立的 ELF。

---

## 五、内核子系统交互关系

```
                           ┌──────────────────┐
                           │   User Program   │
                           │ (apps/* + builtin)│
                           └───────┬──────────┘
                                   │ ecall
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  trap_handler ──► syscall::handle_syscall                    │
│       │                                                      │
│       ├─ Timer IRQ ──► runtime::on_tick() ──► scheduler      │
│       │                    │                                   │
│       │                    ├─► sleep_queue.pop_ready()        │
│       │                    ├─► axnet::poll()                  │
│       │                    └─► maybe_schedule()               │
│       │                                                      │
│       └─ External IRQ ──► plic::claim()                      │
│               ├─► virtio_blk::handle_irq()                   │
│               └─► virtio_net::handle_irq()                   │
│                                                              │
│  syscall ──► sys_read/write/openat/...                       │
│       │                                                      │
│       ├─► VFS (MountTable) ──► ext4 / fat32 / memfs / devfs  │
│       │       │                                               │
│       │       └─► BlockCache ──► BlockDevice                 │
│       │               └─► virtio_blk / RootFsDevice          │
│       │                                                      │
│       ├─► pipe/eventfd/timerfd/epoll (in-process)            │
│       │                                                      │
│       ├─► axnet (smoltcp) ──► NetDevice ──► virtio_net      │
│       │                                                      │
│       ├─► mm::map_user_page / clone_user_root / ...          │
│       │                                                      │
│       └─► process::exit / waitpid / fork                     │
│                                                              │
│  runtime ──► scheduler ──► context_switch (asm)              │
│       │                                                      │
│       └─► idle_loop → schedule_once → wfi                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 六、OS 内核整体实现完整度评价

以"可运行类 Linux 用户程序的单核 RISC-V64 宏内核"为基准，各维度完整度如下：

| 维度 | 完整度 | 说明 |
|---|---|---|
| **进程模型** | 85% | fork+execve+waitpid 全链路可用，CoW 实现到位。缺：信号处理、进程组/会话管理 |
| **内存管理** | 75% | Sv39 页表、CoW、用户态指针验证均到位。缺：mmap 文件映射、共享内存、按需分页、swap |
| **文件系统** | 70% | ext4 读写+创建可用，FAT32 可用，多 VFS 后端。缺：ext4 删除/日志/校验、复杂路径操作 |
| **网络栈** | 65% | TCP/UDP/ICMP/ARP 可用。缺：IPv6、原始 socket、高性能 zero-copy、多网卡 |
| **设备驱动** | 50% | virtio-blk + virtio-net 可用。缺：UART 中断模式、输入、显示、其它设备 |
| **同步机制** | 60% | futex/pipe/eventfd/epoll 均可用。缺：信号量、消息队列、条件变量 |
| **调度器** | 30% | 基本轮询调度。缺：优先级、CFS、多核、实时调度、cgroup |
| **系统调用** | 65% | 92 个系统调用，覆盖主要 Linux ABI。缺：信号、IPC、cgroup |

**综合估计**：该内核实现了约 **60-65%** 的类 Unix 宏内核核心功能，对于竞赛项目而言覆盖范围相当广泛。

---

## 七、设计创新性分析

### 7.1 创新点

1. **全 Rust 实现的 ext4 文件系统 (2585行)**
   从头实现 ext4 的超级块、inode、extent 树寻址、目录项、文件创建和写入，不依赖任何外部 ext4 库。这是一个非常显著的工程成就。

2. **手写 RISC-V 机器码用户态测试程序 (1052字节)**
   直接以机器码字节数组形式内嵌用户态测试程序，覆盖 16+ 个系统调用路径，避免了交叉编译用户程序的复杂性。这种"自包含"测试方法在竞赛场景中很有创意。

3. **CoW fork 实现**
   通过自定义 `PTE_COW` (bit 8) 标志位和引用计数帧管理，实现了完整的 copy-on-write fork 语义。这在内核竞赛项目中较为少见。

4. **无堆分配设计**
   整个内核不使用全局 allocator：所有数据结构（TCB、FD 表、inode、挂载表、管道、eventfd、epoll、socket 等）均使用固定大小的静态数组。这避免了内核堆管理的复杂性，但限制了可扩展性。

5. **模块化 VFS 架构**
   `VfsOps` trait + `MountTable` 的设计支持多个文件系统后端（ext4/FAT32/memfs/devfs/procfs）通过挂载点统一访问，架构清晰。

6. **最小化异步执行器**
   实现了完整的 `Future`/`Waker`/`RawWaker` 基础设施（243行），展示了 Rust 异步编程在内核中的应用可能。

### 7.2 局限性

1. **固定容量限制**：`MAX_TASKS=8`、`FD_TABLE_SLOTS=16`、`PIPE_SLOTS=8` 等常量限制了可扩展性。
2. **单核设计**：所有并发控制使用自旋锁或关中断，不支持 SMP。
3. **ext4 完整度不足**：缺少日志支持，extent 树仅处理深度 0。
4. **procfs 为空壳**：虽有挂载点但无实际内容。
5. **mmap 仅支持匿名映射**：不支持文件映射。
6. **无信号机制**：整个信号系统为 stub。

---

## 八、其他重要信息

### 8.1 特性开关 (Feature Flags)

| Feature | 用途 |
|---|---|
| `user-test` | 启用内嵌用户态测试路径 |
| `user-shell` | 以 `/init` 启动交互式 shell |
| `sched-demo` | 启用调度器演示任务（3 个 dummy 任务） |
| `ext4-write-test` | 启用 ext4 写入冒烟测试 |
| `net-loopback-test` | 启动时运行 TCP 回环测试 |
| `user-tcp-echo` | 用户态 TCP echo 测试 |
| `user-udp-echo` | 用户态 UDP echo 测试 |
| `user-fs-smoke` | 用户态文件系统冒烟测试 |

### 8.2 构建产物

默认构建输出：`target/riscv64gc-unknown-none-elf/debug/axruntime`（ELF 可执行文件），直接作为 QEMU `-kernel` 参数使用。

### 8.3 测试体系

- `tests/self/`：自测用例列表
- `scripts/test_host.sh`：宿主机构建测试
- `scripts/test_qemu_smoke.sh`：QEMU 冒烟测试（9504行，15 个测试用例）
- `scripts/test_oscomp.sh`：OS 竞赛测试套件
- `scripts/net_baseline.sh` / `net_perf_baseline.sh`：网络测试

---

## 九、总结

Project Aurora 是一个**工程实现扎实的 RISC-V64 Rust 宏内核**，总代码量约 20,686 行（含汇编），具有以下突出特点：

**优势**：
- **全自主实现的核心子系统**：ext4（2585行）、FAT32（1457行）、Smoltcp 网络栈适配（1463行）、Sv39 页表管理（1379行）、系统调用层（6416行）均为从零编写
- **成熟的类 Linux ABI**：支持 92 个系统调用，覆盖进程/文件/网络/同步等主要类别
- **关键的先进特性**：Copy-on-Write fork、extent 树寻址、Futex 同步、Epoll 多路复用
- **严格的 `#![no_std]` 和无堆设计**：所有数据结构使用预分配的静态数组
- **模块化架构**：清晰的 VFS 层、设备驱动抽象、挂载表设计

**不足**：
- 单核设计，不支持 SMP
- 固定容量数组限制可扩展性
- ext4 缺少日志支持
- 信号、共享内存等 IPC 机制缺失
- mmap 仅支持匿名映射

作为一个 OS 竞赛项目，Aurora 在内核各子系统的覆盖广度上表现出色，在 ext4 文件系统和 CoW 内存管理等深度方向上也有可观的实现质量。