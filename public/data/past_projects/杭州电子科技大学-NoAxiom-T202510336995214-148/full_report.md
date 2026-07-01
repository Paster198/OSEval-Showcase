# NoAxiom-OS 内核项目深度技术分析报告

## 一、分析范围与方法

本报告基于对 NoAxiom-OS 仓库源码的逐模块静态分析完成。分析覆盖了内核主 crate（`NoAxiom/kernel/src/`，221 个 Rust 源文件）和内部依赖库（`NoAxiom/lib/`，135 个 Rust 源文件，不含 vendor），以及用户态运行时（`user/`）。分析手段包括：源码阅读、模块结构梳理、关键数据结构与算法追踪、子系统间调用关系分析。

由于仓库缺少测试镜像构建所需的子模块（`NoAxiom-OS-Test`），且 RISC-V musl 交叉工具链缺失，未能完成完整的构建与 QEMU 运行测试。以下分析结论均基于静态代码审查。

---

## 二、项目总体架构

NoAxiom-OS 是一个基于 Rust 的宏内核操作系统，核心特征是**基于无栈协程的异步调度**。整体架构分为三层：

1. **硬件抽象层（HAL）**：`lib/arch/`，通过 trait 抽象屏蔽 RISC-V64 和 LoongArch64 差异。
2. **驱动与平台层**：`lib/driver/`、`lib/platform/`、`lib/memory/`，提供设备探测、块设备/网络设备驱动、物理内存管理。
3. **内核核心层**：`kernel/src/`，实现进程管理、调度、内存管理、文件系统、网络、信号、系统调用等子系统。

内核入口流程（`entry/init.rs`）：
```
_boot_hart_init:
  bss_init -> heap_init -> arch_init -> log_init -> 
  frame_init -> kernel_space_init -> 
  probe_device(dtb) -> realize_device -> 
  fs_init -> ktime_init -> 
  schedule_spawn_with_path (spawn init process) ->
  wake_other_hart -> boot_broadcast -> rust_main (run_task loop)
```

每个 hart（硬件线程）进入 `rust_main` 后执行无限循环 `run_task()`，该函数是调度器的核心驱动：
```rust
pub fn run_task() {
    timer_handler();           // 检查定时器到期
    Arch::enable_interrupt();
    Arch::enable_external_interrupt();
    RUNTIME.run();             // 从调度队列取出并执行一个任务
}
```

---

## 三、子系统详细拆解

### 3.1 调度子系统（`kernel/src/sched/`）

#### 3.1.1 架构设计

调度子系统是 NoAxiom-OS 最核心的创新点。它基于 Rust 的 `async_task` crate 实现了一个**协程运行时（Runtime）**，将每个用户进程/线程包装为一个异步 Future（`UserTaskFuture`），由调度器决定何时 poll 哪个 Future。

核心 trait 定义在 `vsched.rs`：
```rust
pub trait Scheduler<R> {
    fn new() -> Self;
    fn push(&mut self, runnable: Runnable<R>, info: ScheduleInfo);
    fn pop(&mut self) -> Option<Runnable<R>>;
}

pub trait Runtime<R> {
    fn new() -> Self;
    fn run(&self);
    fn schedule(&self, runnable: Runnable<R>, info: ScheduleInfo);
    fn spawn<F>(self: &'static Self, future: F, task: Option<&Arc<Task>>);
}
```

#### 3.1.2 多级调度器（`MultiLevelScheduler`）

实际使用的调度器是 `MultiLevelScheduler`，包含两级：

- **实时队列（`RealTimeSchedulerImpl = FifoScheduler`）**：FIFO 调度，用于标记为 `SchedPrio::RealTime` 的任务。
- **普通队列（`NormalSchedulerImpl = ExpiredScheduler`）**：采用 O(1) 调度器的 current/expire 双队列设计。内部使用 `DualPrioScheduler`，根据 `ScheduleInfo::woken_while_running` 将任务分为 normal 和 idle 两个子队列。

```rust
pub struct MultiLevelScheduler {
    realtime: RealTimeSchedulerImpl,  // FifoScheduler
    normal: NormalSchedulerImpl,      // ExpiredScheduler -> DualPrioScheduler
}
```

`pop` 策略：优先弹出实时队列任务，实时队列为空时弹出普通队列任务。

#### 3.1.3 CFS 调度器（已废弃）

`cfs/` 目录下实现了完整的 CFS（完全公平调度器），使用 `BTreeSet` 作为红黑树替代结构，支持虚拟运行时间（vruntime）计算、nice 值到权重映射（`SCHED_PRIO_TO_WEIGHT`）、负载平衡等。但文件头部明确标注 `this scheduler is currently discarded`，实际未投入使用。

#### 3.1.4 调度实体（`SchedEntity`）

```rust
pub struct SchedEntity {
    pub nice: i32,             // nice 优先级 (-20 ~ 19)
    pub sched_prio: SchedPrio, // 调度优先级 (RealTime/Normal/IdlePrio)
    pub time_stat: TimeInfo,   // 任务时间统计
    pub cpu_mask: CpuMask,     // CPU 亲和性掩码
    pub yield_req: bool,       // 让出请求
}
```

调度元数据 `SchedMetadata` 通过裸指针引用 `SchedEntity`，避免 Arc 开销，作为 `async_task::Runnable` 的 metadata 传递。

#### 3.1.5 任务 Future（`UserTaskFuture`）

`UserTaskFuture` 是用户任务的 Future 包装器，在每次 poll 时执行上下文切换：
```rust
impl<F: Future + Send + 'static> Future for UserTaskFuture<F> {
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        // switch-in: 设置当前 CPU 任务、激活地址空间、记录切换时间
        task.time_stat_mut().record_switch_in();
        current_cpu().set_task(task);
        task.memory_activate();
        // poll 内部 future
        let ret = future.poll(cx);
        // switch-out: 保存浮点寄存器、清除当前任务、切换回内核地址空间
        task.time_stat_mut().record_switch_out();
        task.trap_context_mut().freg_mut().yield_task();
        current_cpu().clear_task();
        kernel_space_activate();
        ret
    }
}
```

#### 3.1.6 完整度评估

- **已实现**：多级优先级调度、时间片轮转（通过定时器中断触发 yield）、nice 值支持、CPU 亲和性掩码、实时/普通/空闲优先级、vfork 等待。
- **部分实现**：CFS 代码完整但未启用；负载平衡代码存在但标注为 "the worst performance ever"。
- **缺失**：真正的 CFS 调度未投入使用；多核负载均衡未完善。
- **完整度**：约 75%（以 Linux CFS 为基准）。

---

### 3.2 进程与任务管理子系统（`kernel/src/task/`）

#### 3.2.1 Task 结构体

`Task` 是内核中最核心的数据结构，代表一个调度实体（线程）。其字段按并发访问模式精心分类：

```rust
pub struct Task {
    // 需要锁保护的可变字段
    pub pcb: Mutable<PCB>,                    // 进程控制块（SpinLock 保护）
    pub user_id: Mutable<TaskUserId>,         // 用户 ID
    pub sup_groups: Mutable<Vec<u32>>,        // 补充组

    // 仅当前线程访问的字段（无锁）
    pub tcb: ThreadOnly<TCB>,                 // 线程控制块（SyncUnsafeCell）
    pub sched_entity: ThreadOnly<SchedEntity>, // 调度实体
    pub memory_set: ThreadOnly<SharedMut<MemorySet>>, // 地址空间

    // 不可变字段
    pub tid: Immutable<TidTracer>,            // 线程 ID
    pub tgid: Immutable<TGID>,                // 线程组 ID（即 PID）

    // 线程间共享字段（Arc<SpinLock<T>>）
    pub fd_table: SharedMut<FdTable>,         // 文件描述符表
    pub dir_cwd: SharedMut<Arc<dyn Dentry>>,  // 当前工作目录
    pub sa_list: SharedMut<SigActionList>,     // 信号处理列表
    pub thread_group: SharedMut<ThreadGroup>,  // 线程组
    pub pgid: Arc<AtomicUsize>,               // 进程组 ID
    pub futex: SharedMut<FutexPrivateQueue>,   // Futex 等待队列
    pub itimer: SharedMut<ITimerManager>,      // 间隔定时器
}
```

#### 3.2.2 PCB（进程控制块）

```rust
pub struct PCB {
    pub status: TaskStatus,           // 任务状态（Normal/Zombie/Stopped/Terminated）
    pub exit_code: ExitCode,          // 退出码
    pub children: Vec<Arc<Task>>,     // 子进程列表
    pub parent: Option<Weak<Task>>,   // 父进程（弱引用）
    pub signals: SigManager,          // 待处理信号队列
    pub sig_stack: Option<SigAltStack>, // 信号备用栈
    pub robust_list: RobustList,      // 健壮链表（futex 相关）
}
```

#### 3.2.3 TCB（线程控制块）

```rust
pub struct TCB {
    pub flags: TaskFlags,               // 线程标志（TIF_NOTIFY_SIGNAL 等）
    pub sig_mask: SigMask,              // 信号掩码
    pub waker: Option<Waker>,           // 协程 Waker
    pub cx: TaskTrapContext,            // 陷阱上下文（寄存器状态）
    pub ucx: UserPtr<UContext>,         // 用户上下文（信号处理用）
    pub set_child_tid: Option<usize>,   // CLONE_CHILD_SETTID
    pub clear_child_tid: Option<usize>, // CLONE_CHILD_CLEARTID
    pub current_syscall: SyscallID,     // 当前系统调用号
    pub vfork_wait: Option<VforkInfo>,  // vfork 等待信息
    pub exit_signal: Option<Signal>,    // 退出时发送的信号
    pub cap: UserCapData,               // 内核能力
}
```

#### 3.2.4 Fork 实现

`do_fork` 实现了完整的 `clone` 语义，支持以下标志：
- `CLONE_VM`：共享地址空间（线程），否则执行 COW 克隆
- `CLONE_FILES`：共享文件描述符表
- `CLONE_SIGHAND`：共享信号处理表
- `CLONE_THREAD`：创建线程而非进程
- `CLONE_PARENT`：使用调用者的父进程
- `CLONE_VFORK`：vfork 语义（父进程阻塞直到子进程 exec/exit）
- `CLONE_CHILD_SETTID` / `CLONE_CHILD_CLEARTID` / `CLONE_PARENT_SETTID`：TID 地址设置
- `CLONE_SETTLS`：设置 TLS

#### 3.2.5 Execve 实现

`execve` 流程：加载 ELF -> 创建新地址空间 -> 解析动态链接器（`dl_interp`）-> 构建用户栈（argv、envp、auxv）-> 更新任务状态。支持 `AT_PHDR`、`AT_PHENT`、`AT_PHNUM`、`AT_PAGESZ`、`AT_BASE`、`AT_ENTRY`、`AT_UID`、`AT_GID`、`AT_CLKTCK` 等辅助向量。

#### 3.2.6 任务管理器

```rust
pub static TASK_MANAGER: Lazy<TaskManager>;           // TID -> Weak<Task> 映射
pub static PROCESS_GROUP_MANAGER: Lazy<SpinLock<ProcessGroupManager>>; // 进程组管理
```

支持进程组管理（`setpgid`）、线程组管理、孤儿进程回收（子进程重新挂到 init 进程）。

#### 3.2.7 Futex 实现

完整实现了 futex 的 `FUTEX_WAIT`、`FUTEX_WAKE`、`FUTEX_REQUEUE`、`FUTEX_BITSET` 操作。区分私有（虚拟地址索引）和共享（物理地址索引）两种 futex 队列。使用自定义 `FutexFuture` 实现异步等待。

#### 3.2.8 Wait 实现

`WaitChildFuture` 实现了 `wait4` 语义，支持按 PID 等待特定子进程或等待任意子进程，支持 `WNOHANG` 选项。

#### 3.2.9 完整度评估

- **已实现**：fork/clone（含线程）、execve（含动态链接器）、exit、wait4、futex、进程组、线程组、孤儿进程回收、vfork。
- **完整度**：约 85%（以 Linux 进程管理为基准）。

---

### 3.3 内存管理子系统（`kernel/src/mm/` + `lib/memory/`）

#### 3.3.1 地址空间管理（`MemorySet`）

```rust
pub struct MemorySet {
    pub page_table: SyncUnsafeCell<PageTable>,  // 页表
    pub areas: Vec<MapArea>,                     // 内存区域列表（ELF 段等）
    pub stack: MapArea,                          // 用户栈
    pub brk: BrkAreaInfo,                        // 堆（brk）
    pub mmap_manager: MmapManager,               // mmap 管理
    pub shm: ShmInfo,                            // 共享内存
}
```

#### 3.3.2 页表管理（`PageTable`）

页表基于架构抽象（`ArchMemory` trait），支持 SV39（RISC-V）和 LoongArch 页表格式。核心操作：
- `map(vpn, ppn, flags)`：建立映射
- `unmap(vpn)`：解除映射
- `find_pte(vpn)`：查找页表项
- `new_root_cloned()`：克隆根页表（用于新地址空间创建）

#### 3.3.3 写时复制（COW）

`clone_cow()` 在 fork 时将所有可写页面的 PTE 标记为 COW（通过 `MappingFlags::COW`），父子进程共享物理页。当写入触发 `StorePageFault` 时，`validate()` 函数检测 COW 标志并执行页面复制：

```rust
if flags.contains(MappingFlags::COW) {
    memory_set.lock().realloc_cow(vpn, pte)?;
    Ok(())
}
```

#### 3.3.4 懒分配

支持栈、堆、mmap 三种区域的懒分配：
- **栈**：`lazy_alloc_stack(vpn)` 在页面错误时分配物理页
- **堆**：`lazy_alloc_brk(vpn)` 在 brk 区域内按需分配
- **mmap**：`MmapPage::lazy_map_page()` 在首次访问时分配并读取文件内容

#### 3.3.5 Mmap 管理

```rust
pub struct MmapManager {
    pub mmap_start: VirtAddr,
    pub mmap_top: VirtAddr,
    pub mmap_map: BTreeMap<VirtPageNum, MmapPage>,     // 所有 mmap 页面（含未分配）
    pub frame_trackers: BTreeMap<VirtPageNum, FrameTracker>, // 已分配的物理帧
}
```

支持 `MAP_SHARED`/`MAP_PRIVATE`、`PROT_READ`/`PROT_WRITE`/`PROT_EXEC`、文件映射、`mprotect`、`munmap`。`MmapPage` 在 `Drop` 时自动执行 `msync` 将脏页写回文件。

#### 3.3.6 共享内存（SHM）

实现了 System V 共享内存接口（`shmget`、`shmat`、`shmdt`、`shmctl`），使用 `ShmManager` 管理共享内存段，支持 `IPC_NEW`、`IPC_CREAT`、`IPC_EXCL` 标志。

#### 3.3.7 用户指针校验（`UserPtr`）

`UserPtr<T>` 封装了用户空间指针的安全访问，提供 `read`、`write`、`try_read`、`try_write`、`translate_pa`（虚拟地址转物理地址）等方法，所有操作均为异步。

#### 3.3.8 物理帧分配器（`lib/memory/`）

使用 `SpinLock` 保护的帧分配器，支持 `frame_alloc()`、`frame_refcount()`（引用计数，用于 COW）。

#### 3.3.9 完整度评估

- **已实现**：页表管理、COW、懒分配（栈/堆/mmap）、mmap/munmap/mprotect、brk、共享内存、用户指针校验、内核地址空间。
- **部分实现**：mmap 的 `msync` 仅在 `Drop` 时触发，无显式 `msync` 系统调用实现（代码中标注 `unimplemented!`）。
- **完整度**：约 80%（以 Linux 内存管理为基准）。

---

### 3.4 文件系统子系统（`kernel/src/fs/`）

#### 3.4.1 VFS 抽象层

VFS 采用面向对象的 trait 设计，核心 trait 包括：

- **`Dentry`**：目录项，包含名称、父目录、子目录映射、关联 inode。
- **`Inode`**：索引节点，定义文件元数据和操作接口。
- **`File`**：打开的文件实例，包含 `FileMeta`（标志、位置、dentry、inode）和异步读写接口。
- **`SuperBlock`**：超级块，管理文件系统实例。
- **`FileSystem`**：文件系统类型。

`File` trait 的关键方法：
```rust
pub trait File: Send + Sync + DowncastSync {
    fn meta(&self) -> &FileMeta;
    async fn base_read(&self, offset: usize, buf: &mut [u8]) -> SyscallResult;
    async fn base_write(&self, offset: usize, buf: &[u8]) -> SyscallResult;
    fn poll(&self, req: &PollEvent, waker: Waker) -> PollEvent;
    fn ioctl(&self, cmd: usize, arg: usize) -> SyscallResult;
    // ...
}
```

`File` 的 `read_at`/`write_at` 方法集成了页缓存：先查页缓存，命中则直接拷贝，未命中则调用 `base_read` 从底层文件系统读取并缓存。

#### 3.4.2 文件系统实现

| 文件系统 | 目录 | 说明 |
|---------|------|------|
| **EXT4** | `vfs/impls/ext4/` | 适配 vendor 中的 `ext4_rs` 库，提供 dentry/inode/file/superblock/filesystem 完整适配层 |
| **FAT32** | `vfs/impls/rust_fat32/` + `lib/fatfs/` | 自研 FAT32 实现，完整适配 VFS |
| **RamFS** | `vfs/impls/ramfs/` | 内存文件系统，用于 `/tmp` 等临时目录 |
| **ProcFS** | `vfs/impls/proc/` | 伪文件系统，包含 `/proc/<pid>/status`、`/proc/<pid>/stat`、`/proc/exe`、`/proc/fd`、`/proc/maps`、`/proc/meminfo`、`/proc/mounts`、`/proc/stat`、`/proc/interrupts` |
| **DevFS** | `vfs/impls/devfs/` | 设备文件系统，包含 `/dev/null`、`/dev/zero`、`/dev/urandom`、`/dev/tty`、`/dev/rtc`、`/dev/loop*`、`/dev/cpu_dma_latency` |

#### 3.4.3 页缓存（`PageCacheManager`）

采用 MSI（Modified-Shared-Invalid）状态协议：
```rust
pub enum PageState {
    Modified,  // 脏页，需要写回
    Shared,    // 干净页
    Deleted,   // 已删除
}
```

缓存容量基于物理内存总量的固定比例（`PAGE_CACHE_PROPORTION`），超限时执行清理策略：遍历所有缓存页，将脏页写回磁盘后释放。

#### 3.4.4 块缓存（`AsyncBlockCache`）

使用 LRU 缓存策略（`lru::LruCache`），缓存大小由 `MAX_LRU_CACHE_SIZE` 控制。读写操作通过异步接口与底层块设备交互。

#### 3.4.5 管道（`Pipe`）

实现了完整的匿名管道，使用物理帧作为环形缓冲区，支持：
- 读写端引用计数（检测 EOF 和 SIGPIPE）
- 异步等待（读等待/写等待 waker 列表）
- `poll` 支持（`POLLIN`/`POLLOUT`/`POLLHUP`/`POLLERR`）

#### 3.4.6 路径解析（`path.rs`）

提供内核态路径操作函数：`kopen`（打开）、`kcreate`（创建）、`kdelete`（删除）、`kcreate_async`（异步创建）。支持符号链接解析、路径缓存（`PATH_CACHE`）。

#### 3.4.7 文件描述符表（`FdTable`）

```rust
pub struct FdTable {
    pub table: Vec<Option<FdTableEntry>>,
    rlimt: RLimit,  // 资源限制
}
```

支持 `alloc_fd`、`dup`/`dup3`、`close`、`close_on_exec`（CLOEXEC 标志）、`fcntl` 标志操作。默认初始化 stdin/stdout/stderr 指向 TTY 设备。

#### 3.4.8 完整度评估

- **已实现**：VFS 抽象层、EXT4/FAT32/RamFS/ProcFS/DevFS、页缓存、块缓存、管道、符号链接、硬链接、目录操作、文件权限、mount/umount、sendfile、splice、copy_file_range、fallocate、readlink、rename、truncate。
- **部分实现**：`msync` 未实现（标注 `unimplemented!`）；`sync`/`fsync` 为空操作。
- **完整度**：约 80%（以 Linux VFS 为基准）。

---

### 3.5 网络子系统（`kernel/src/net/`）

#### 3.5.1 架构

网络子系统基于 `smoltcp` 协议栈，支持 TCP 和 UDP。核心组件：

- **`SocketSet`**：全局 smoltcp 套接字集合，使用 `SpinLock` 保护。
- **`TcpSocket`**：TCP 套接字封装，支持 listen/connect/accept/read/write/shutdown。
- **`UdpSocket`**：UDP 套接字封装，支持 bind/connect/read/write。
- **`SocketFile`**：将套接字包装为 VFS `File` trait 实现，使其可以通过文件描述符操作。
- **`PortManager`**：端口管理器，支持临时端口分配和端口绑定。
- **`SocketPollMethod`**：无锁 poll 方法，用于网卡中断中轮询套接字状态。

#### 3.5.2 TCP 实现

```rust
pub struct TcpSocket {
    meta: SocketMeta,
    state: TcpState,                    // Closed / Listen
    handles: Vec<SocketHandle>,         // smoltcp socket handles
    local_endpoint: Option<IpEndpoint>,
}
```

支持的操作：`socket`、`bind`、`listen`、`accept`/`accept4`、`connect`、`sendto`、`recvfrom`、`shutdown`、`getsockname`、`getpeername`、`setsockopt`、`getsockopt`、`recvmsg`、`recvmmsg`、`sendmsg`、`sendmmsg`、`socketpair`。

#### 3.5.3 网络设备

支持 virtio-net 设备（通过 `virtio-drivers-async`）和回环设备（`LoopBackDev`）。网络设备通过 `DEV_BUS` 注册。

#### 3.5.4 完整度评估

- **已实现**：TCP/UDP 套接字、IPv4/IPv6、listen/connect/accept、send/recv 系列、socketpair、shutdown、sockopt、poll 支持。
- **部分实现**：Unix domain socket 标注为 `todo!`；`SIGIO` 缓冲区满信号未实现。
- **完整度**：约 70%（以 Linux 网络子系统为基准）。

---

### 3.6 信号子系统（`kernel/src/signal/`）

#### 3.6.1 信号定义

支持完整的 64 个 Linux 信号（`SIGINVAL` 到 `SIGRTMAX`），包括标准信号（1-31）和实时信号（32-64）。

#### 3.6.2 信号处理

`SigActionList` 存储每个信号的处理动作：
```rust
pub struct KSigAction {
    pub handler: SAHandlerType,  // Ign/Term/Core/Stop/Cont/User{handler}
    pub mask: SigMask,           // 处理期间阻塞的信号集
    pub flags: SAFlags,          // SA_RESTART/SA_SIGINFO/SA_ONSTACK/SA_NODEFER/SA_RESETHAND/SA_RESTORER
    pub restorer: usize,         // sigreturn 地址
}
```

#### 3.6.3 信号传递流程

1. **信号产生**：`recv_siginfo()` 将 `SigInfo` 加入任务的 `SigManager` 队列，设置 `TIF_NOTIFY_SIGNAL` 标志，唤醒任务。
2. **信号检查**：`check_signal()` 在每次从内核返回用户态前调用，检查 `TIF_NOTIFY_SIGNAL`。
3. **信号处理**：
   - `Ign`：忽略
   - `Term`：终止进程
   - `Core`：核心转储（当前实现为终止）
   - `Stop`：停止进程
   - `Cont`：继续进程
   - `User`：构建 `UContext` 和 `SigInfo` 写入用户栈，修改 EPC 指向用户处理函数，RA 指向 `sig_trampoline`。
4. **信号返回**：用户处理函数返回后触发 `sigreturn` 系统调用，恢复原始上下文。

#### 3.6.4 可中断系统调用

`interruptable.rs` 实现了可中断的系统调用支持，支持 `SA_RESTART` 标志自动重启被信号中断的系统调用。

#### 3.6.5 完整度评估

- **已实现**：64 个信号定义、sigaction、sigprocmask、sigreturn、信号栈（部分）、可中断系统调用、SA_RESTART/SA_SIGINFO/SA_NODEFER/SA_RESETHAND/SA_RESTORER 标志。
- **部分实现**：信号备用栈（`SigAltStack`）标注为 "unimplemented"；实时信号队列未实现排队。
- **完整度**：约 75%（以 Linux 信号机制为基准）。

---

### 3.7 IO 多路复用子系统（`kernel/src/io/`）

#### 3.7.1 ppoll

实现了 `ppoll` 系统调用，支持文件描述符集合的读写异常轮询，支持超时和信号掩码。

#### 3.7.2 pselect

实现了 `pselect6` 系统调用，支持 select 语义。

#### 3.7.3 完整度评估

- **已实现**：ppoll、pselect6。
- **缺失**：epoll 未实现。
- **完整度**：约 60%（以 Linux IO 多路复用为基准）。

---

### 3.8 时间管理子系统（`kernel/src/time/`）

#### 3.8.1 组件

| 文件 | 功能 |
|------|------|
| `clock.rs` | 时钟初始化 |
| `gettime.rs` | 获取当前时间（`get_time`、`get_time_ms`、`get_time_duration`） |
| `time_info.rs` | 任务时间统计（用户态/内核态/子进程时间） |
| `time_slice.rs` | 时间片管理、调度触发 |
| `timeout.rs` | 超时 Future |
| `timer.rs` | 定时器管理器（`TimerManager`）、间隔定时器（`ITimerManager`） |
| `timex.rs` | 时间调整（`adjtimex`） |

#### 3.8.2 定时器管理器

使用 `BinaryHeap<Reverse<Timer>>` 作为最小堆，支持一次性定时器和周期性定时器。`ITimerManager` 支持 `ITIMER_REAL`（SIGALRM）、`ITIMER_VIRTUAL`（SIGVTALRM）、`ITIMER_PROF`（SIGPROF）三种间隔定时器。

#### 3.8.3 完整度评估

- **已实现**：clock_gettime、nanosleep、gettimeofday、setitimer/getitimer、timerfd（通过定时器管理器）。
- **完整度**：约 80%。

---

### 3.9 系统调用分发（`kernel/src/syscall/`）

#### 3.9.1 分发机制

系统调用通过 `match` 表分发，按功能域分为 13 个文件：

| 文件 | 覆盖范围 |
|------|---------|
| `fs.rs` | 文件操作（open/close/read/write/stat/mkdir/link/unlink/mount 等） |
| `io.rs` | IO 多路复用（ppoll/pselect） |
| `mm.rs` | 内存管理（mmap/munmap/mprotect/brk/shmget 等） |
| `net.rs` | 网络（socket/bind/listen/accept/connect/send/recv 等） |
| `process.rs` | 进程管理（fork/clone/execve/exit/wait4/kill/getpid 等） |
| `sched.rs` | 调度（sched_yield/sched_getaffinity/nice/setpriority 等） |
| `signal.rs` | 信号（sigaction/sigprocmask/sigreturn/tkill 等） |
| `system.rs` | 系统信息（uname/sysinfo/getrandom 等） |
| `time.rs` | 时间（clock_gettime/nanosleep/gettimeofday/setitimer 等） |
| `others.rs` | 其他（prctl/arch_prctl/futex 等） |
| `utils.rs` | 工具函数 |

#### 3.9.2 系统调用数量

根据 `syscall.rs` 中的 match 表统计，共实现 **115 个系统调用**，覆盖：
- 文件系统：约 45 个
- 进程管理：约 20 个
- 网络：约 18 个
- 内存管理：约 10 个
- 信号：约 8 个
- 时间：约 7 个
- 调度：约 5 个
- IO 多路复用：2 个

部分系统调用为空实现（`empty_syscall`），如 `umask`、`sync`、`fsync`、`fadvise64`。

---

### 3.10 硬件抽象层（`lib/arch/`）

#### 3.10.1 Trait 体系

| Trait | 功能 |
|-------|------|
| `ArchAsm` | 汇编指令（nop、halt、fence） |
| `ArchBoot` | 启动相关（hart_start） |
| `ArchInfo` | 架构信息（ARCH_NAME、频率） |
| `ArchInt` | 中断控制（enable/disable interrupt、IPI） |
| `ArchMemory` | 内存管理（TLB、页表激活） |
| `ArchTime` | 时间读取 |
| `ArchTrap` | 陷阱处理（trap_init、trap_restore） |
| `ArchTrapContext` | 陷阱上下文（寄存器访问） |
| `ArchUserFloatContext` | 浮点寄存器保存/恢复 |
| `ArchPageTable` / `ArchPageTableEntry` | 页表结构抽象 |

#### 3.10.2 RISC-V64 实现（`rv64/`）

- 使用 SV39 页表
- 汇编 trap 入口（`trap.S`）
- SBI 调用接口
- PLIC 中断控制器

#### 3.10.3 LoongArch64 实现（`la64/`）

- 使用 4 级页表
- 汇编 trap 入口（`trap.S`）和 TLB 操作（`tlb.S`）
- 非对齐访问处理（`unaligned.rs`）
- libc 导入（`la_libc_import.rs`，用于 LoongArch 目标的编译支持）

#### 3.10.4 完整度评估

- **已实现**：两种架构的完整 HAL，包括启动、中断、内存、陷阱、浮点上下文。
- **完整度**：约 90%。

---

### 3.11 驱动子系统（`lib/driver/`）

#### 3.11.1 驱动框架

```rust
pub struct GeneralBus {
    pub block: SpinLock<Vec<&'static dyn BlockDevice>>,
    pub display: SpinLock<Vec<&'static dyn DisplayDevice>>,
    pub network: SpinLock<Vec<&'static dyn NetWorkDevice>>,
    pub interrupt: SpinLock<Vec<&'static dyn InterruptDevice>>,
}
```

设备探测流程：`probe_device(dtb)` -> DTB 解析 -> 设备注册 -> `realize_device()` -> 设备初始化。

#### 3.11.2 支持的驱动

| 类型 | 实现 |
|------|------|
| 块设备 | virtio-blk（异步，`virtio-drivers-async`）、AHCI（`lib/driver_ahci/`） |
| 网络设备 | virtio-net（异步）、回环设备 |
| 中断控制器 | PLIC（RISC-V）、中断控制器（LoongArch） |
| 显示设备 | 框架存在，具体实现待确认 |

#### 3.11.3 设备探测

支持 DTB（Device Tree Blob）解析和 PCI 设备探测。

---

### 3.12 内核同步原语库（`lib/ksync/`）

提供以下同步原语：
- `SpinLock`：自旋锁
- `RwLock`：读写锁
- `AsyncMutex`：异步互斥锁
- `Semaphore`：信号量
- `Barrier`：屏障
- `OnceCell`：一次性初始化
- `SyncUnsafeCell`：同步不安全单元
- `assert_no_lock!`：调试宏，断言当前未持有锁

---

### 3.13 内核异步工具库（`lib/kfuture/`）

提供以下异步工具：
- `block_on`：阻塞等待 Future 完成（用于内核态同步调用异步函数）
- `SuspendFuture`：挂起当前任务（不自动唤醒）
- `YieldFuture`：让出当前任务
- `TakeWakerFuture`：获取当前 Future 的 Waker

---

### 3.14 中断/异常处理（`kernel/src/trap/`）

#### 3.14.1 用户态陷阱处理（`utrap_handler.rs`）

```rust
pub async fn user_trap_handler(task: &Arc<Task>, trap_type: TrapType) {
    match trap_type {
        TrapType::Exception(ExceptionType::Syscall) => {
            let result = task.syscall(cx).await;
            task.update_syscall_result(result);
        }
        TrapType::Exception(ExceptionType::PageFault(pf)) => {
            task.memory_validate(addr, pf, false).await;
        }
        TrapType::Interrupt(InterruptType::Timer(_)) => {
            set_next_trigger(None);
            task.yield_now().await;
        }
        TrapType::Interrupt(InterruptType::SupervisorExternal(_)) => {
            ext_int_handler();
        }
        // ...
    }
}
```

关键设计：用户态陷阱处理函数本身是 `async` 的，这意味着系统调用、页面错误处理等都可以直接使用异步操作（如文件 IO、网络等待），这是异步调度架构的核心优势。

#### 3.14.2 内核态陷阱处理（`ktrap_handler.rs`）

处理内核态的页面错误和中断，支持嵌套陷阱（通过 `ktrap_depth` 计数）。

---

### 3.15 用户态（`user/`）

#### 3.15.1 运行时库（`libd`）

用户态运行时库提供：
- 架构相关入口（`_start`）
- 系统调用封装（`syscall` 模块）
- 堆管理
- 控制台输出
- ioctl 封装

#### 3.15.2 应用程序

- `run_busybox`：BusyBox 启动器
- `run_tests`：测试用例启动器

用户态程序以内嵌方式编译进内核二进制（通过 `link_apps.S` 链接脚本），在初始化时写入文件系统后加载执行。

---

## 四、子系统间交互

### 4.1 系统调用路径

```
用户态 ecall/sc -> trap.S -> user_trap_handler -> 
  Syscall::syscall_inner -> 各子系统实现 -> 
  返回结果 -> trap_restore -> 用户态
```

### 4.2 异步 IO 路径

```
sys_read -> file.read_at -> pagecache 查询 -> 
  [未命中] base_read -> block_cache -> virtio-blk 驱动 -> 
  中断唤醒 -> 数据返回
```

### 4.3 进程创建路径

```
sys_clone -> Task::do_fork -> inner_fork -> 
  COW 克隆地址空间 / 共享 fd_table / 克隆 sa_list ->
  spawn_utask -> RUNTIME.spawn -> 调度队列
```

### 4.4 信号传递路径

```
kill/tkill/内核事件 -> Task::recv_siginfo -> 
  SigManager::push -> 设置 TIF_NOTIFY_SIGNAL -> wake_unchecked ->
  调度器 poll UserTaskFuture -> task_main 循环 ->
  check_signal -> 构建 UContext -> 修改 EPC/RA ->
  trap_restore -> 用户态信号处理函数 -> sigreturn ->
  恢复原始上下文
```

### 4.5 页面错误路径

```
用户态访问 -> PageFault -> user_trap_handler ->
  memory_validate -> validate ->
    [COW] realloc_cow -> 复制物理页 -> 更新 PTE
    [栈懒分配] lazy_alloc_stack -> 分配物理页 -> 映射
    [堆懒分配] lazy_alloc_brk -> 分配物理页 -> 映射
    [mmap懒分配] lazy_map_page -> 分配物理页 -> 读取文件 -> 映射
  -> TLB flush -> 返回用户态重试指令
```

---

## 五、构建与测试

### 5.1 构建尝试

由于以下限制，未能完成完整构建：
1. 仓库缺少 `config.mk` 文件（需要手动创建或通过 `make config` 生成）。
2. 缺少测试镜像构建子模块 `NoAxiom-OS-Test`。
3. RISC-V musl 交叉工具链缺失（用户态编译需要）。
4. Rust 工具链版本要求 `nightly-2024-05-01`，当前环境可能不匹配。

### 5.2 测试结果

未能执行 QEMU 运行测试。根据项目文档，该项目在 OS 内核比赛中完成了以下测试：
- 预赛测试：通过
- 决赛测试：总分第 7，性能测试总分第 2，iperf 网络性能测试第 1。

---

## 六、创新性分析

### 6.1 核心创新：异步协程调度

NoAxiom-OS 最显著的创新是将 Rust 的无栈协程（`async/await`）机制作为内核调度的基础抽象。这一设计有以下优势：

1. **自然的异步 IO**：系统调用实现可以直接使用 `.await` 等待 IO 完成，无需手动管理等待队列和回调。
2. **零成本抽象**：Rust 的 Future 是编译时生成的状态机，没有堆分配开销。
3. **类型安全**：异步操作的类型系统在编译时检查生命周期和借用。
4. **统一的调度接口**：用户任务、内核任务、定时器回调都使用相同的 Future 抽象。

### 6.2 异步驱动

使用 `virtio-drivers-async` 实现异步 virtio 驱动，使块设备和网络设备操作可以与调度器协同工作，避免阻塞式 IO 导致的 CPU 浪费。

### 6.3 精心设计的并发模型

Task 结构体的字段按并发访问模式分类（`SharedMut`、`Mutable`、`ThreadOnly`、`Immutable`），在保证正确性的同时最小化锁竞争。`assert_no_lock!` 宏在调试模式下检测锁持有状态，防止死锁。

### 6.4 双架构支持

通过 HAL trait 抽象，同一套内核代码同时支持 RISC-V64 和 LoongArch64，这在 OS 比赛中是较少见的。

---

## 七、代码质量与工程实践

### 7.1 优点

1. **模块化设计**：子系统划分清晰，模块间通过 trait 和接口交互。
2. **文档注释**：关键模块和函数有 Rust doc 注释。
3. **日志系统**：使用 `log` crate 提供分级日志（TRACE/DEBUG/INFO/WARN/ERROR）。
4. **错误处理**：使用 `Result<T, Errno>` 统一错误处理，定义了完整的 errno 集合。
5. **Vendored 依赖**：所有第三方依赖通过 vendor 目录管理，保证构建可重复性。

### 7.2 不足

1. **CFS 调度器废弃**：实现了完整的 CFS 但未使用，实际使用的多级调度器相对简单。
2. **部分空实现**：`sync`、`fsync`、`umask` 等系统调用为空操作。
3. **锁粒度**：部分全局锁（如 `SOCKET_SET`、`PAGE_CACHE_MANAGER`）可能成为性能瓶颈。
4. **注释中的 TODO**：多处标注 `todo!`、`fixme`、`unimplemented`，表明部分功能未完善。
5. **CFS 代码中的自评**：负载平衡代码被作者自评为 "I made this shit, the worst performance ever"。

---

## 八、项目统计

| 指标 | 数值 |
|------|------|
| 内核 Rust 源文件数 | 221 |
| 内部库 Rust 源文件数（不含 vendor） | 135 |
| 系统调用数量 | 115 |
| 支持的文件系统 | 5（EXT4、FAT32、RamFS、ProcFS、DevFS） |
| 支持的指令集架构 | 2（RISC-V64、LoongArch64） |
| 支持的信号数量 | 64 |
| 网络协议 | TCP、UDP、IPv4、IPv6 |
| 调度器类型 | 多级优先级（实时 FIFO + 普通 Expired） |
| Rust 工具链 | nightly-2024-05-01 |

---

## 九、总结

NoAxiom-OS 是一个设计精良、实现完整的 Rust 宏内核操作系统。其核心创新在于将 Rust 的异步协程机制深度融入内核调度，使得 IO 密集型操作的实现自然而高效。项目在文件系统（5 种文件系统实现）、进程管理（完整的 fork/exec/wait/clone 语义）、信号处理（64 个信号、可中断系统调用）等方面达到了较高的完整度。

主要不足在于：CFS 调度器虽已实现但未启用，实际调度策略相对简单；部分系统调用为空实现；epoll 未实现；多核负载均衡未完善。

从比赛成绩来看，性能测试总分第 2、iperf 网络性能第 1 的成绩验证了异步调度架构在 IO 密集型场景下的优势。整体而言，该项目在架构创新性上表现突出，在实现完整度上处于中上水平。