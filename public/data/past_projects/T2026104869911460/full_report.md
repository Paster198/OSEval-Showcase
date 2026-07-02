# AsyncBridge OS 内核 — 深度技术分析报告

---

## 一、分析范围与方法

本报告基于对项目仓库中所有核心源代码文件的逐行审查生成。分析方法包括：

1. **静态代码审查**：审查了内核主体 `NoAxiom/kernel/src/` 下的全部 255 个 `.rs` 文件、支持库 `NoAxiom/lib/` 下的全部 165 个 `.rs` 文件、架构汇编文件（RISC-V 和 LoongArch 的 `trap.S`、`tlb.S`）、用户态库 `user/libd/` 全部源文件。
2. **构建系统审查**：审查了顶层 `Makefile`、内核 `Cargo.toml` 及 `build.rs`、用户态 `Cargo.toml`、链接脚本、特性标志体系。
3. **依赖分析**：审查了 vendored 依赖列表，包括 `async-task`、`smoltcp`、`virtio-drivers`、`fatfs`、`riscv`、`loongArch64` 等关键外部 crate。

审查排除了 vendor 目录中的第三方代码以及用户态中的 LTP 测试用例代码（这些属于外部测试基础设施）。

---

## 二、项目整体架构

### 2.1 代码规模

| 组成部分 | 文件数 | 代码行数 (Rust) | 说明 |
|----------|--------|----------------|------|
| 内核主体 (`kernel/src/`) | ~255 `.rs` | ~35,000 | 不含 vendor |
| 支持库 (`lib/`) | ~165 `.rs` | ~42,000 | 含 ext4_rs, fatfs, driver 等 |
| 汇编文件 | 4 `.S` | ~720 | RISC-V + LoongArch |
| 用户库 (`user/libd/`) | ~25 `.rs` | ~2,500 | syscall 封装 |
| **内核总计（不含 vendor）** | | **~77,000** | |

### 2.2 Cargo Workspace 结构

```
NoAxiom/
├── kernel/          # 内核 crate（核心）
├── lib/
│   ├── arch/        # 架构抽象层 (RISC-V / LoongArch)
│   ├── config/      # 编译期配置常量
│   ├── driver/      # 设备驱动框架与实现
│   ├── driver_ahci/ # AHCI 磁盘驱动（独立 crate）
│   ├── ext4_rs/     # ext4 文件系统库（独立 crate）
│   ├── fatfs/       # FAT 文件系统库（独立 crate）
│   ├── include/     # 错误码定义
│   ├── kfuture/     # 异步 Future 工具（block_on, yield, suspend）
│   ├── ksync/       # 内核同步原语（SpinLock, Mutex, RwLock, Semaphore 等）
│   ├── memory/      # 低级内存管理（帧分配、内核堆）
│   └── platform/    # 平台内存布局 + 链接脚本生成
└── vendor/          # vendored 依赖 (~150 crates)
```

---

## 三、子系统详细拆解

### 3.1 入口与引导系统

#### 3.1.1 启动流程

入口定义在 `kernel/src/entry/main.rs`、`init.rs`、`init_proc.rs`：

**Boot Hart 初始化序列**（`_boot_hart_init`）：
1. `bss_init()` — BSS 段清零
2. `heap_init()` — 内核堆初始化（基于 `buddy_system_allocator`）
3. `Arch::arch_init()` + `log_init()` — 架构初始化和日志系统初始化
4. `frame_init()` — 物理帧分配器初始化
5. `kernel_space_init()` — 内核页表构建（SV39 / LA 三级页表）
6. `probe_device(dtb)` + `realize_device()` — 设备树探测和设备初始化
7. `block_on(fs_init())` — 文件系统初始化（VFS + 挂载）
8. `ktime_init()` — 内核时钟初始化
9. `schedule_spawn_with_path()` — 通过内嵌 ELF 创建 init 进程
10. `wake_other_hart()` — 唤醒其他 hart（多核）
11. `boot_broadcast()` + `rust_main()` — 进入事件循环

**其他 Hart 初始化序列**（`_other_hart_init`）：
1. `Arch::arch_init()` — 架构初始化
2. `kernel_space_activate()` — 激活内核页表
3. `Arch::enable_interrupt()` — 开启中断
4. 进入 `rust_main()` 事件循环

关键代码 (`init.rs:79-88`)：
```rust
#[no_mangle]
pub extern "C" fn _boot_hart_init(_: usize, dtb: usize) -> ! {
    bss_init();
    heap_init();
    Arch::arch_init();
    log_init();
    hello_world();
    frame_init();
    kernel_space_init();
    probe_device(dtb);
    realize_device();
    block_on(fs_init());
    ktime_init();
    schedule_spawn_with_path();
    #[cfg(feature = "multicore")]
    wake_other_hart(get_hartid());
    boot_broadcast();
    crate::asyncbridge_main()
}
```

#### 3.1.2 Init 进程创建

Init 进程通过**编译期内嵌 ELF** 方式加载。`build.rs` 扫描 `user/bin/` 目录，生成 `link_apps.S` 汇编文件，将用户程序二进制直接嵌入内核数据段。

`init_proc.rs` 使用声明宏 `use_apps!` 和 `gen_get_content!` 自动为每个内嵌应用生成访问函数。内核启动时，将内嵌 ELF 写入 ramfs（通过 `kcreate` + `file.write_at`），然后使用 `MemorySet::load_elf` 加载并创建任务。

设计要点：这种内嵌方式避免了需要从磁盘加载 init 程序的复杂性，使内核在缺乏完整块设备驱动的情况下也能引导到用户态。

---

### 3.2 内存管理子系统 (`kernel/src/mm/`)

#### 3.2.1 虚拟地址空间管理 (`memory_set.rs`, 907 行)

`MemorySet` 是虚拟地址空间的核心抽象：

```rust
pub struct MemorySet {
    page_table: PageTable,             // 页表
    areas: Vec<MapArea>,              // 虚拟内存区域列表
    mmap_manager: MmapManager,        // mmap 管理器
    shm_manager: ShmInfo,             // 共享内存信息
}
```

支持操作：
- `init_kernel_space()` — 初始化内核地址空间，映射内核各段（text、rodata、data、bss）
- `load_elf(&file)` — 从文件加载 ELF，返回 `ElfMemoryInfo`（含入口点、用户栈、auxv）
- ELF 解释器支持（PT_INTERP），通过 `dl_interp` 字段支持动态链接
- 信号 trampoline 页映射（`SIG_TRAMPOLINE`）
- `fork_from()` — 从父进程复制地址空间（支持 COW）

`RawElfInfo` 结构体记录 ELF 加载的关键信息：
```rust
pub struct RawElfInfo {
    head_va: VirtAddr,
    end_va: VirtAddr,
    ph_offset: usize,
    ph_count: usize,
    ph_entry_size: usize,
    entry_point: usize,
    dl_interp: Option<Arc<dyn Dentry>>,
}
```

#### 3.2.2 虚拟内存区域 (`map_area.rs`)

`MapArea` 管理一段连续的虚拟地址范围：
- **类型**：`MapAreaType` 枚举包括 `Linear`（文件映射）、`Framed`（匿名映射）、`Stack`、`Trampoline` 等
- **权限**：基于 `MappingFlags`（V/R/W/X/U/G/A/D/COW）
- **COW 支持**：通过 `flags_switch_to_cow()` 将父子进程的共享页设为只读+COW 标记

#### 3.2.3 mmap 实现 (`mmap_manager.rs`, 361 行)

支持完整的 mmap 系统调用语义：
- `MAP_SHARED` / `MAP_PRIVATE` — 共享与私有映射
- `MAP_ANONYMOUS` / `MAP_FIXED` / `MAP_POPULATE` 等标志
- `MmapManager` 维护 `BTreeMap<VirtPageNum, MmapRegion>` 的映射关系
- 懒分配：页面在首次访问时通过缺页异常分配

#### 3.2.4 共享内存 (`shm.rs`, 366 行)

System V 共享内存实现：
```rust
pub struct ShmManager {
    segments: BTreeMap<usize, ShmSegment>,
}
pub struct ShmSegment {
    shmid: usize,
    key: usize,
    size: usize,
    frames: Vec<FrameTracker>,
    attach_count: usize,
    // ...
}
```
- `SHM_MANAGER` 全局单例管理所有共享内存段
- 支持 shmget/shmctl/shmat/shmdt 完整操作

#### 3.2.5 页表操作 (`page_table.rs`)

基于架构抽象的页表实现，通过 `ArchPageTable` trait 提供统一接口。RISC-V 采用 SV39（三级页表，39 位虚拟地址），LoongArch 采用类似的三级页表结构（LA64 手册标准）。

#### 3.2.6 用户指针安全访问 (`user_ptr.rs`, 450 行)

`UserPtr<T>` 封装了从内核态安全访问用户态内存的机制：
- `read()` / `write()` — 带有缺页处理的用户内存访问
- `translate_pa()` — 将用户虚拟地址翻译为物理地址
- 使用 `Arch::check_read()` / `Arch::check_write()` 进行安全探测
- 架构层面通过 `__try_read_user` / `__try_write_user` 汇编函数实现安全探测，使用专门的异常向量 `__kernel_user_ptr_vec` 捕获非法访问

#### 3.2.7 低级内存管理 (`lib/memory/`)

- **帧分配器** (`frame.rs`)：基于 `buddy_system_allocator` 的伙伴系统物理帧分配器，支持分配、释放、引用计数
- **内核堆** (`heap.rs`)：同样基于伙伴系统，提供 `malloc`/`free` 语义
- **地址工具** (`address.rs`, `utils.rs`)：物理地址/虚拟地址/物理页号/虚拟页号的类型安全封装

---

### 3.3 虚拟文件系统 (`kernel/src/fs/`)

#### 3.3.1 VFS 核心抽象 (`vfs/basic/`)

VFS 采用经典的 Unix VFS 四元组设计，并通过 `async_trait` 实现异步接口：

**Dentry**（目录项，`dentry.rs`, 1,017 行）：
```rust
pub struct DentryMeta {
    name: String,
    pub super_block: Arc<dyn SuperBlock>,
    parent: Option<Weak<dyn Dentry>>,
    children: Mutex<BTreeMap<String, Arc<dyn Dentry>>>,
    inode: Mutex<Option<Arc<dyn Inode>>>,
    abs_path: Mutex<Option<String>>,
    // ...
}
```
- 使用 `SpinLock<BTreeMap<String, Arc<dyn Dentry>>>` 管理子节点
- 支持路径缓存（`abs_path` 字段）
- `Dentry` trait 定义了 `open()`, `create()`, `lookup()` 等核心操作（全部异步）
- 具体实现通过 `#[async_trait]` 和 `downcast_rs` 支持动态分发

**Inode**（索引节点，`inode.rs`, 505 行）：
```rust
pub struct InodeMeta {
    pub id: usize,
    pub inner: Mutex<InodeMetaInner>,
    pub inode_mode: AtomicU32,
    pub fs_flags: AtomicU32,
    xattrs: Mutex<BTreeMap<String, Vec<u8>>>,
    pub super_block: Arc<dyn SuperBlock>,
    pub page_cache: Option<()>,
    pub uid: AtomicU32,
    pub gid: AtomicU32,
    symlink: Mutex<Option<String>>,
}
```
- `InodeMetaInner` 包含 nlink、size、state（UnInit/Normal/Dirty/Deleted）、时间戳
- `Inode` trait 提供 `read_at()`, `write_at()`, `truncate()`, `lookup()`, `create()` 等异步操作
- 支持扩展属性（xattrs）
- 通过 `AtomicU32` 实现部分字段的无锁访问

**File**（打开文件，`file.rs`, 603 行）：
```rust
pub struct FileMeta {
    flags: AtomicI32,
    pub pos: AtomicUsize,
    dentry: Arc<dyn Dentry>,
    pub inode: Arc<dyn Inode>,
}
```
- 文件位置 `pos` 使用 `AtomicUsize` 支持多线程安全
- `File` trait（通过 `#[async_trait]`）定义 `read()`, `write()`, `ioctl()`, `poll()`, `fsync()` 等操作
- `File` 同时实现了 `EventSource` trait（来自 `async_bridge`），用于异步 I/O 就绪通知

**SuperBlock**：文件系统超级块抽象，包含文件系统类型名、根 dentry、设备信息、挂载标志等。

**FileSystem** trait：定义 `mount()`, `umount()`, `root()` 等文件系统级操作。

#### 3.3.2 具体文件系统实现

**ramfs** (`vfs/impls/ramfs/`)：
- 完全在内存中实现的文件系统
- `RamFsDentry` + `RamFsFileInode` + `RamFsDirInode` 组合
- 底层使用全局 `RwLock<HashMap<String, Vec<u8>>>` 存储文件内容
- 支持写钩子 `RamFsWriteHook`，用于 `/proc/sys/` 中的特殊文件

**devfs** (`vfs/impls/devfs/`)：
- 设备文件系统，挂载于 `/dev`
- 实现以下设备文件：
  - `/dev/null` — `NullInode`（丢弃所有写入，读取返回 EOF）
  - `/dev/zero` — `ZeroInode`（读取返回零字节）
  - `/dev/full` — `FullInode`（写入返回 ENOSPC）
  - `/dev/urandom` — `UrandomInode`（读取返回伪随机数）
  - `/dev/tty` — `TtyInode`（终端设备，引用当前进程的终端）
  - `/dev/rtc` — `RtcInode`（实时时钟，支持 RTC_RD_TIME ioctl）
  - `/dev/loop-control` — Loop 设备控制器
  - `/dev/loopN` — Loop 设备
  - `/dev/cpu_dma_latency` — CPU DMA 延迟控制

**procfs** (`vfs/impls/proc/`)：
- 挂载于 `/proc`，提供进程和系统信息
- 实现的 proc 文件：
  - `/proc/meminfo` — 内存统计信息
  - `/proc/cpuinfo` — CPU 信息
  - `/proc/mounts` — 挂载点列表
  - `/proc/uptime` — 系统运行时间
  - `/proc/interrupts` — 中断统计
  - `/proc/stat` — 系统统计（每个进程 PID 目录下）
  - `/proc/[pid]/status` — 进程状态
  - `/proc/[pid]/maps` — 进程内存映射
  - `/proc/[pid]/exe` — 进程可执行文件符号链接
  - `/proc/[pid]/fd/` — 进程文件描述符目录
  - `/proc/[pid]/timerslack` — 定时器 slack 值
  - `/proc/sys/kernel/` — 内核参数（pid_max, hostname, domainname, shmmax 等）
  - `/proc/sys/fs/` — 文件系统参数（pipe-max-size, aio-max-nr 等）
- 每个进程目录动态创建，使用 `ProcStatDentry`, `StatusDentry` 等专用 dentry 类型

**ext4** (`vfs/impls/ext4/`)：
- 适配层将 `ext4_rs` 库桥接到 VFS
- 实现了完整的文件系统 VFS 接口：`Ext4FileSystem`, `Ext4SuperBlock`, `Ext4Dentry`, `Ext4Inode`, `Ext4File`
- ext4 底层库 (`lib/ext4_rs/`) 实现了：
  - 超级块读取和解析
  - 块分配/释放（balloc/ialloc）
  - 目录操作（查找、创建、遍历）
  - 文件读写（支持 extent）
  - CRC 校验
  - 路径解析
- 支持异步操作：库内所有磁盘 I/O 基于 `async_trait` 和 `block_on`

**FAT32** (`vfs/impls/rust_fat32/`)：
- 适配层将 `fatfs` 库桥接到 VFS
- FAT 库 (`lib/fatfs/`) 是 `no_std` 兼容的 FAT12/FAT16/FAT32 实现
- 支持长文件名 (LFN)
- 支持目录、文件创建/读写/删除
- 通过 `DiskCursor` 适配 VFS 块设备接口

#### 3.3.3 文件系统基础设施

**页缓存** (`pagecache.rs`)：
```rust
pub struct PageCacheManager {
    pages: HashMap<CacheKey, Page>,
    total_frames: usize,
}
```
- 容量为总物理帧的 1/5（`PAGE_CACHE_PROPORTION = 5`）
- 支持 Modified/Shared/Deleted 三态
- 全局 `RwLock` 保护
- 支持脏页写回（writeback），批量写回阈值 16 页
- 页面状态跟踪类似 Linux 的 MESI 思想

**块缓存** (`blockcache.rs`)：
```rust
pub struct AsyncBlockCache {
    cache: AsyncMutex<LruCache<usize, CacheBlock>>,
    block_device: &'static dyn BlockDevice,
}
```
- 基于 LRU 淘汰策略，最大容量 `MAX_LRU_CACHE_SIZE = 2 * PAGE_SIZE`
- 使用 `AsyncMutex` 实现异步安全的并发访问
- `CacheBlock` 跟踪 dirty 状态
- 支持批量同步写回（`sync_all`）

**文件描述符表** (`fdtable.rs`, 430 行)：
```rust
pub struct FdTable {
    table: Vec<Option<Arc<dyn File>>>,
    cloexec: Vec<bool>,
}
```
- 基于 `Vec` 的线性表，支持自动扩容
- `alloc_fd()` 分配最小可用 fd
- 支持 `O_CLOEXEC` 标志跟踪
- `dup3()` 支持指定目标 fd 的复制

**路径解析** (`path.rs`)：
- `kopen()` / `kcreate()` / `kdelete()` — 基于路径的内核文件操作
- 支持 `.` / `..` 特殊目录解析
- 符号链接跟随（循环检测）
- 基于 `get_dentry()` 递归查找

**管道** (`pipe.rs`, 993 行)：
```rust
pub struct PipeFile {
    buffer: RingBuffer<u8>,
    read_wakers: Vec<Waker>,
    write_wakers: Vec<Waker>,
}
```
- 基于环形缓冲区（`ringbuffer` crate）
- 默认容量 `PIPE_BUF_SIZE = 16 * PAGE_SIZE`
- 可配置的最大容量 `pipe_max_size()`
- 完整的异步读写支持：读端阻塞时注册 waker，写端写入后唤醒

**epoll** (`epoll.rs`, 353 行)：
- `EpollFile` 实现 epoll 实例
- 支持 `EPOLL_CTL_ADD` / `EPOLL_CTL_MOD` / `EPOLL_CTL_DEL`
- 使用 `epoll_interest` 跟踪每个被监控 fd 的事件类型
- 基于 waker 的就绪通知机制

**其他 fd 类型**：
- `eventfd.rs` — 事件通知文件描述符（计数器信号量）
- `timerfd.rs` (338 行) — 定时器文件描述符
- `signalfd.rs` — 信号文件描述符（通过信号管理器注册 mask + waker）
- `memfd.rs` — 内存文件描述符（匿名内存文件）
- `pidfd.rs` — 进程文件描述符
- `anonfd.rs` — 匿名 inode 文件描述符
- `nsfd.rs` — 命名空间文件描述符
- `netlink.rs` — netlink socket 接口
- `socketpair.rs` — socket 对
- `procfile.rs` — 进程文件描述符

**文件锁**：
- `flock.rs` — BSD 文件锁（flock 系统调用）
- `record_lock.rs` (403 行) — POSIX 记录锁（F_SETLK/F_GETLK）
- `lease.rs` — 文件租约

**其他**：
- `mqueue.rs` (696 行) — POSIX 消息队列
- `dnotify.rs` — 目录变更通知
- `manager.rs` — 全局文件系统管理器 `FS_MANAGER`（注册/查找文件系统类型）

---

### 3.4 进程与任务管理 (`kernel/src/task/`)

#### 3.4.1 任务控制块 (`task.rs`, 518 行)

`Task` 结构体设计采用分层锁策略：

```rust
#[repr(C, align(64))]
pub struct Task {
    // 可变（锁保护）
    pub(super) pcb: Mutable<PCB>,                    // SpinLock<PCB>
    pub(super) user_id: Mutable<TaskUserId>,         // SpinLock<TaskUserId>
    pub(super) sup_groups: Mutable<Vec<u32>>,        // SpinLock<Vec<u32>>

    // 线程独占/一次性初始化
    pub(super) tcb: ThreadOnly<TCB>,                 // SyncUnsafeCell<TCB>
    pub(super) sched_entity: ThreadOnly<SchedEntity>,// SyncUnsafeCell<SchedEntity>
    pub(super) memory_set: ThreadOnly<SharedMut<MemorySet>>,

    // 不可变
    pub(super) tid: Immutable<TidTracer>,
    pub(super) tgid: Immutable<TGID>,
    pub(super) pid_in_namespace: Immutable<PID>,

    // 共享（Arc<SpinLock<T>>）
    pub(super) fd_table: ThreadOnly<SharedMut<FdTable>>,
    pub(super) dir_cwd: SharedMut<Arc<dyn Dentry>>,
    pub(super) dir_exe: SharedMut<String>,
    pub(super) dir_root: SharedMut<Arc<dyn Dentry>>,
    pub(super) dir_proc: SharedMut<Arc<dyn Dentry>>,
    pub(super) umask: SharedMut<u32>,
    pub(super) personality: SharedMut<usize>,
    pub(super) time_namespace: SharedMut<TimeNamespace>,
    pub(super) pid_namespace: SharedMut<LinuxNamespace>,
    pub(super) sa_list: SharedMut<SigActionList>,
    pub(super) thread_group: SharedMut<ThreadGroup>,
    pub(super) pgid: Arc<AtomicUsize>,
    pub(super) sid: Arc<AtomicUsize>,
    pub(super) futex: SharedMut<FutexPrivateQueue>,
    pub(super) itimer: SharedMut<ITimerManager>,
}
```

类型别名体系：
- `Mutable<T> = SpinLock<T>` — 锁保护的可变数据
- `ThreadOnly<T> = SyncUnsafeCell<T>` — 仅当前线程访问的可变数据
- `Immutable<T> = T` — 不可变数据（构造后不修改）
- `SharedMut<T> = Arc<SpinLock<T>>` — 跨线程共享的可变数据
- `Shared<T>` 构造器：`Shared::new(data)` → `Arc::new(SpinLock::new(data))`

此设计将数据分类为四种访问模式，在安全性和性能之间取得平衡。`ThreadOnly` 无需锁开销，`Mutable` 使用自旋锁保护，`SharedMut` 使用 Arc+自旋锁在进程/线程间共享。

#### 3.4.2 进程控制块 (`pcb.rs`)

```rust
pub struct PCB {
    pub signals: SigManager,
    pub exit_code: i32,
    pub exit_signal: Option<Signal>,
    pub state: TaskState,
    pub children: Vec<Weak<Task>>,
    pub parent: Option<Weak<Task>>,
    // ...
}
```

#### 3.4.3 线程控制块 (`tcb.rs`)

```rust
pub struct TCB {
    pub cx: TaskTrapContext,
    pub exit_signal: Option<Signal>,
    pub flags: TaskFlags,
    pub current_syscall: Option<SyscallID>,
    pub set_child_tid: Option<usize>,
    pub clear_child_tid: Option<usize>,
    pub cap: CapabilitySet,
    pub robust_list: Option<usize>,
    // ...
}
```

#### 3.4.4 Fork 实现 (`fork.rs`)

`Task::do_fork()` 实现了类 Linux 的 clone 系统调用：
- 支持 `CloneFlags` 的全部标志位：`THREAD`, `VM`, `FILES`, `FS`, `SIGHAND`, `VFORK`, `PARENT_SETTID`, `CHILD_SETTID`, `SETTLS`, `PIDFD`, `CLEAR_SIGHAND` 等
- 支持命名空间标志：`NEWNS`, `NEWPID`, `NEWTIME`, `NEWUSER`
- `inner_fork()` 执行实际的内存/资源复制
- 内存使用 COW 策略：`MemorySet::fork_from()` 将父子进程的共享页标记为只读+COW
- 文件描述符表可选共享（`CLONE_FILES`）或复制
- 信号处理表可选共享（`CLONE_SIGHAND`）或复制
- 支持 `CLONE_CHILD_SETTID` / `CLONE_CHILD_CLEARTID` 语义

#### 3.4.5 Execve 实现 (`execve.rs`, 365 行)

`Task::do_execve()` 实现了完整的 execve 流程：
- 参数/环境变量从用户空间复制
- `MemorySet::load_elf()` 加载新 ELF
- 支持 shebang（`#!`）解释器脚本
- 替换地址空间、重置信号处理（将捕获的信号恢复为默认）
- 设置新栈（含 argc/argv/envp/auxv）
- 设置 `O_CLOEXEC` 文件描述符关闭
- 重置 `dir_exe` 为新的可执行路径

#### 3.4.6 退出与等待 (`exit.rs`, `wait.rs`)

- `do_exit()` — 设置退出码，向父进程发送 SIGCHLD，将状态设为 Zombie
- `do_exit_group()` — 终止线程组内所有线程
- `do_wait4()` — 等待子进程状态变更，收集退出码和信号信息
- 支持 `WNOHANG`, `WUNTRACED`, `WCONTINUED` 选项
- Zombie 进程由父进程 wait 时回收

#### 3.4.7 Futex 实现 (`futex.rs`)

```rust
pub struct FutexPrivateQueue {
    waiters: SpinLock<BTreeMap<VirtAddr, WaiterQueue>>,
}

pub struct FutexWaiter {
    waker: Waker,
    bitset: u32,
    done: Arc<AtomicBool>,
}
```
- 支持 `FUTEX_WAIT` / `FUTEX_WAKE` / `FUTEX_WAIT_BITSET` / `FUTEX_WAKE_BITSET`
- 支持 `FUTEX_PRIVATE_FLAG`（进程私有 futex）
- 共享 futex 使用物理地址索引全局哈希表
- 私有 futex 使用虚拟地址在 `FutexPrivateQueue` 中查找
- 使用 `FutexWaitSource` 实现异步等待（实现 `EventSource` trait）
- 支持 `FUTEX_REQUEUE` / `FUTEX_CMP_REQUEUE`（从全局 `FUTEXQUEUE` 静态管理器）

#### 3.4.8 命名空间 (`namespace.rs`)

```rust
pub struct LinuxNamespace {
    ns_type: NsType,  // Mount, PID, Time, User
    ns_id: usize,
}
```
- 支持 Mount、PID、Time、User 四种命名空间
- 通过 `/proc/[pid]/ns/` 目录暴露命名空间 fd

#### 3.4.9 任务管理器 (`manager.rs`)

```rust
pub static TASK_MANAGER: Lazy<TaskManager> = ...;
pub static PROCESS_GROUP_MANAGER: Lazy<SpinLock<ProcessGroupManager>> = ...;
```
- `TaskManager` 维护 `BTreeMap<TID, Weak<Task>>` 的全局任务注册表
- `ThreadGroup` 在线程组内跟踪线程成员
- `ProcessGroupManager` 管理进程组关系

---

### 3.5 调度器子系统 (`kernel/src/sched/`)

#### 3.5.1 异步运行时 (`runtime.rs`)

`MultiLevelRuntime` 是内核异步运行时核心：

```rust
pub struct MultiLevelRuntime {
    scheduler: SpinLock<SchedulerImpl>,  // MultiLevelScheduler
}

impl Runtime<Info> for MultiLevelRuntime {
    fn run(&self) {
        let runnable = self.scheduler.lock().pop();
        if let Some(runnable) = runnable {
            set_next_trigger(None);
            runnable.run();
        }
    }
    fn schedule(&self, runnable: Runnable<Info>, info: ScheduleInfo) {
        self.scheduler.lock().push(runnable, info);
    }
    fn spawn<F>(self: &'static Self, future: F, task: Option<&Arc<Task>>) { ... }
}
```

- 基于 `async-task` crate（vendored）构建
- `run_task()` 循环：每个 hart 不断调用 `RUNTIME.run()`，从调度器弹出 runnable 并执行
- `spawn()` 将 future 包装为 `Runnable`，附带调度元数据 `SchedMetadata`
- 全局单例：`lazy_static! { pub static ref RUNTIME: RuntimeImpl = RuntimeImpl::new(); }`

#### 3.5.2 多级调度器 (`scheduler.rs`)

```rust
pub struct MultiLevelScheduler {
    realtime: RealTimeSchedulerImpl,    // FifoScheduler
    normal: NormalSchedulerImpl,        // ExpiredScheduler
}
```

- **实时任务**（`FifoScheduler`）：优先级 `SchedPrio::RealTime(priority)`，FIFO 队列调度
- **普通任务**（`ExpiredScheduler`）：使用 expired/active 双队列，内部使用 `DualPrioScheduler`（normal + idle 子队列）
- **DualPrioScheduler**：区分 "just woken" 任务和普通任务，刚唤醒的任务放入 idle 队列延迟处理
- **ScheduleInfo**：`woken_while_running` 标志影响任务入队策略
- **缓存行对齐**：`#[repr(align(64))]` 避免伪共享

#### 3.5.3 调度实体 (`sched_entity.rs`)

```rust
pub struct SchedEntity {
    pub sched_prio: SchedPrio,
    pub weight: usize,
    pub vruntime: SchedVruntime,
}

pub enum SchedPrio {
    Idle,
    Normal(isize),    // nice -20..+19
    RealTime(usize),  // RT priority 1..99
}
```

- `SchedMetadata` 从 `Task` 构造，传递给 `async_task::Builder`
- `SchedVruntime` 跟踪虚拟运行时间（用于 CFS）

#### 3.5.4 CFS 调度器 (`cfs/cfs.rs`)

CFS（完全公平调度）实现使用红黑树（`BTreeSet`）按 `vruntime` 排序：
```rust
pub struct CFS<R> {
    normal: BTreeSet<CfsTreeNode<R>>,  // 按 vruntime 排序的红黑树
    urgent: VecDeque<Runnable<R>>,     // 实时/刚唤醒任务队列
    load: usize,
    task_count: usize,
    last_time: usize,
    time_limit: usize,
}
```
- CFS 节点 `CfsTreeNode` 按 `(vruntime, tid)` 排序
- 支持负载均衡（`load_balance`）
- CFS 目前标记为 `#[allow(unused)]`，说明当前实际使用的是 `ExpiredScheduler`，CFS 是备用/实验性实现

#### 3.5.5 任务派生 (`spawn.rs`)

```rust
pub fn spawn_utask(task: &Arc<Task>) {
    RUNTIME.spawn(UserTaskFuture::new(task.clone(), task_main(task.clone())), Some(task));
}

pub fn spawn_ktask<F, R>(future: F)
where F: Future<Output = R> + Send + 'static, R: Send + 'static {
    RUNTIME.spawn(future, None);
}
```

- `spawn_utask`：派生用户任务，创建 `UserTaskFuture` 包装器
- `spawn_ktask`：派生内核任务（如 init 进程创建流程）
- `UserTaskFuture` 运行 `task_main()`，后者包含用户态进入循环（trap → 处理 → restore）

---

### 3.6 I/O 异步桥 (`kernel/src/io/async_bridge.rs`, 502 行)

这是 AsyncBridge 项目的**核心创新**——将阻塞语义的系统调用统一转换为异步 Future 的机制。

#### 3.6.1 核心类型

**WaitPolicy**：描述阻塞行为
```rust
pub struct WaitPolicy {
    pub nonblock: bool,
    pub timeout: Option<Duration>,
    pub interruptible: bool,
    pub check_signal_before_poll: bool,
}
```

**Completion**：等待完成状态
```rust
pub enum Completion {
    Ready(ReadyMask),
    WouldBlock,
    Timeout,
    Interrupted,
    HangUp,
    Error(i32),
}
```

**EventSource** trait：
```rust
pub trait EventSource {
    fn poll_ready(&self, interest: EventMask) -> ReadyMask;
}
```

**WakerEventSource** trait：
```rust
pub trait WakerEventSource {
    type Ready;
    fn poll_ready_with_waker(&self, waker: Waker) -> Option<Self::Ready>;
}
```

#### 3.6.2 等待模型

三种核心等待模式：

1. **`wait_with_policy(task, fut, policy, sigmask)`** — 最通用的等待：包装 future，添加超时，支持信号中断
2. **`wait_outcome_with_policy(task, fut, policy, sigmask)`** — 返回 `WaitOutcome<T>`（Ready 或 Timeout）
3. **`sleep_with_policy(task, interval)`** — 睡眠指定时间

`wait_with_policy_and_wake()` 使用 `TimeLimitedFuture` 包装超时，使用 `interruptable()` 包装信号中断。

#### 3.6.3 就绪事件模型

- **`poll_ready_entries_once()`** — 对一组 `EventSource` 进行单次非阻塞轮询
- **`AsyncWaitSet`** — 收集一组 `WakerEventSource`，当 waker 被触发时批量轮询就绪状态
- **`ReadyCompletion<T>`** — 将就绪结果与 Completion 状态结合

#### 3.6.4 应用到子系统

每个支持阻塞的子系统（文件、socket、管道、futex、eventfd 等）实现 `EventSource` trait，使得 `ppoll`/`pselect` 等系统调用可以通过统一的 `AsyncWaitSet` 机制收集就绪通知。

`FutexWaitSource` 是一个典型实现：poll 时检查 futex 值是否变化，register waker 到 futex 等待队列，被唤醒时重新检查。

---

### 3.7 系统调用接口 (`kernel/src/syscall/`)

#### 3.7.1 系统调用分发器 (`syscall.rs`, 400 行)

```rust
pub struct Syscall<'a> {
    pub task: &'a Arc<Task>,
}

impl<'a> Syscall<'a> {
    async fn syscall_inner(&mut self, id: SyscallID, args: [usize; 6]) -> SyscallResult {
        use SyscallID::*;
        match id {
            SYS_READ =>  self.sys_read(args[0], args[1], args[2]).await,
            SYS_WRITE => self.sys_write(args[0], args[1], args[2]).await,
            SYS_OPENAT => self.sys_openat(...).await,
            SYS_FORK => ... (via SYS_CLONE),
            // ... ~293 个系统调用
        }
    }
}
```

- 使用 `async fn` 实现，天然支持异步系统调用
- `task.syscall(cx)` 调用 `syscall_inner()`，将结果写入 trap context 的 A0 寄存器
- 系统调用在 `user_trap_handler` 中被 await

#### 3.7.2 系统调用 ID 枚举 (`include/syscall_id.rs`)

定义了 293 个系统调用 ID，覆盖 Linux syscall 的主要功能：

| 类别 | 数量 | 代表 syscall |
|------|------|-------------|
| 文件系统 | ~70 | read/write/openat/close/statx/getdents64/mount/mkdirat/unlinkat/... |
| 进程管理 | ~30 | clone/execve/exit/wait4/fork/prctl/... |
| 内存管理 | ~20 | mmap/munmap/mprotect/madvise/mremap/brk/msync/... |
| 信号 | ~15 | kill/tkill/sigaction/sigprocmask/sigreturn/sigsuspend/... |
| 网络 | ~25 | socket/bind/listen/accept/connect/sendto/recvfrom/... |
| 时间 | ~20 | clock_gettime/nanosleep/timer_create/timerfd/... |
| 调度 | ~15 | sched_setscheduler/sched_getaffinity/sched_yield/... |
| IPC | ~10 | shmget/shmctl/shmat/shmdt/msgget/semget/... |
| 系统 | ~15 | uname/sysinfo/reboot/syslog/getrandom/... |
| 其他 | ~40 | futex/eventfd/epoll/signalfd/timerfd/io_uring/... |

还包括自定义 syscall：`SYSCALL_FRAMEBUFFER`, `SYSCALL_FRAMEBUFFER_FLUSH`, `SYSCALL_EVENT_GET`, `SYSCALL_LISTEN`, `SYSCALL_CONNNET`。

#### 3.7.3 系统调用实现统计

| 文件 | 行数 | 说明 |
|------|------|------|
| `syscall/fs.rs` | 4,438 | 文件系统 syscall 实现 |
| `syscall/process.rs` | 1,696 | 进程管理 syscall |
| `syscall/net.rs` | 1,520 | 网络 socket syscall |
| `syscall/io.rs` | 1,183 | I/O 多路复用 (ppoll/pselect) |
| `syscall/mm.rs` | 1,045 | 内存管理 syscall |
| `syscall/signal.rs` | 547 | 信号 syscall |
| `syscall/sched.rs` | 496 | 调度 syscall |
| `syscall/time.rs` | 433 | 时间 syscall |
| `syscall/syscall.rs` | 400 | 分发器 |
| `syscall/others.rs` | 99 | 其他（prctl 等） |
| `syscall/ipc.rs` | 185 | IPC syscall |
| `syscall/system.rs` | 107 | 系统信息 syscall |
| **总计** | **~12,185** | |

---

### 3.8 信号子系统 (`kernel/src/signal/`)

#### 3.8.1 信号类型定义 (`signal.rs`)

完整定义了 POSIX 信号：
- 31 个非实时信号（SIGHUP=1 到 SIGSYS=31）
- 33 个实时信号（SIGTIMER=32 到 SIGRT_32..63）
- `NSIG = 64`
- `SIG_DFL = 0` / `SIG_IGN = 1` 常量

#### 3.8.2 信号管理器 (`sig_manager.rs`)

```rust
pub struct SigManager {
    pub queue: VecDeque<SigInfo>,
    pub pending_set: SigSet,
    pub should_wake: SigSet,
    signalfd_wakers: Vec<(SigSet, Waker)>,
    signal_versions: [u64; NSIG],
}
```
- 实时信号可排队（每次入队），非实时信号通过 `pending_set` 去重
- `signalfd_wakers` 支持 signalfd 的就绪通知
- `signal_versions` 跟踪信号生成计数，用于 signalfd 的 epoll

#### 3.8.3 信号处理动作 (`sig_action.rs`)

```rust
pub struct SigActionList {
    actions: [SigAction; NSIG],
}
pub struct SigAction {
    pub handler: usize,      // 用户态处理函数地址
    pub flags: SigActionFlags,  // SA_SIGINFO, SA_RESTART, SA_NODEFER 等
    pub mask: SigSet,
}
```

#### 3.8.4 信号集操作 (`sig_set.rs`)

- `SigSet`: 基于 `usize` 位图的信号集（64 位可覆盖全部 NSIG）
- `SigMask`: 线程的信号掩码 + 通用 pending/wake 集合
- 支持 `sigprocmask`, `sigpending`, `sigsuspend` 操作

#### 3.8.5 信号栈 (`sig_stack.rs`)

- 支持 `sigaltstack()` 系统调用
- `UContext` 结构包含信号栈信息

#### 3.8.6 可中断等待 (`interruptable.rs`)

```rust
pin_project! {
    pub struct IntableFuture<'a, F> {
        task: &'a Arc<Task>,
        fut: F,
        mask: SigMask,
        check_signal_before_poll: bool,
    }
}
```

`IntableFuture` 在每次 poll 前后检查是否有待处理信号。如果有，返回 `Err(Errno::EINTR)`。这是实现 POSIX 信号中断语义的核心机制。

支持 `TIF_WAIT_SLEEPING` 标志和 `should_wake` 信号集，控制哪些信号可以唤醒等待中的任务。

#### 3.8.7 任务级信号处理 (`task/signal.rs`, 396 行)

- `recv_siginfo()` — 向任务发送信号
- `do_signal()` — 在返回用户态前处理 pending 信号
- 信号帧构建：在用户栈上构建 sigframe，设置返回地址为 signal trampoline（`user_sigreturn`）
- `user_sigreturn` 汇编函数（在 `trap.S` 中定义）调用 `SYS_SIGRETURN` 恢复上下文

---

### 3.9 网络子系统 (`kernel/src/net/`)

#### 3.9.1 整体架构

基于 `smoltcp` 0.11.0 协议栈构建：
```
Kernel Net Subsystem
├── socketfile.rs (480 行) — Socket 与 VFS File 的桥接
├── socket.rs — Socket trait 抽象
├── tcpsocket.rs (719 行) — TCP socket 实现
├── udpsocket.rs (436 行) — UDP socket 实现
├── socket_set.rs — smoltcp SocketSet 封装
├── port_manager.rs — TCP/UDP 端口分配器
└── mod.rs — 全局单例和网络设备管理
```

全局单例：
```rust
lazy_static! {
    pub static ref SOCKET_SET: SocketSet = SocketSet::new();
    pub static ref TCP_PORT_MANAGER: Arc<SpinLock<PortManager>> = ...;
    pub static ref UDP_PORT_MANAGER: Arc<SpinLock<PortManager>> = ...;
    pub static ref NET_DEVICES: RwLock<BTreeMap<usize, &'static dyn NetWorkDevice>> = ...;
}
```

#### 3.9.2 SocketFile (`socketfile.rs`)

```rust
pub enum Sock {
    Tcp(TcpSocket),
    Udp(UdpSocket),
    Unix(UnixSocket),
}
```

`SocketFile` 实现 `File` trait，将 socket 操作（read/write/poll/ioctl）桥接到 VFS：
- `read()` → socket `recvfrom()`
- `write()` → socket `sendto()`
- `poll()` → 检查 socket 状态（可读/可写/错误）
- `ioctl()` → `FIONREAD` 查询可读字节数

#### 3.9.3 TCP Socket (`tcpsocket.rs`)

```rust
pub struct TcpSocket {
    meta: SocketMeta,
    state: TcpState,           // Closed / Listen
    shutdown_type: ShutdownType,
    handles: Vec<SocketHandle>, // smoltcp 句柄
    local_endpoint: Option<IpEndpoint>,
    owns_local_port: bool,
    connected_once: bool,
}
```

TCP 状态机：
- `TcpState::Closed` → bind → listen → `TcpState::Listen`
- Listen 状态支持 accept（通过 smoltcp 的 `accept()` 方法）
- Connect 使用 smoltcp 的 `connect()`，支持阻塞和非阻塞模式

smoltcp 集成：
- 每个 TCP socket 拥有一个 `tcp::Socket`，通过 `SOCKET_SET` 全局管理
- 网络轮询：在 `poll_ifaces()` 中遍历 `NET_DEVICES`，调用 smoltcp 的 `iface.poll()`
- 超时处理：使用 `Instant::from_millis(get_time_ms())` 作为时间戳

#### 3.9.4 UDP Socket (`udpsocket.rs`)

类似 TCP socket 结构，使用 `udp::Socket`：
- 支持 `bind()`, `connect()`, `sendto()`, `recvfrom()`
- 数据包缓冲使用 `udp::PacketBuffer`

#### 3.9.5 端口管理 (`port_manager.rs`)

```rust
pub struct PortManager {
    used_ports: BTreeSet<u16>,
    ephemeral_start: u16,
}
```
- 维护已使用端口集合
- `get_ephemeral_port()` — 从 49152 开始分配临时端口
- TCP 和 UDP 各自独立的端口管理器

#### 3.9.6 网络设备

当前支持：
- **LoopBackDev** — 回环设备（默认启用）
- virtio-net 设备（通过 QEMU 的 `-device virtio-net-device` 配置）
- 网络设备通过 `NetWorkDevice` trait 抽象，包含 `poll()` 和 smoltcp `Device` 接口

---

### 3.10 时间管理子系统 (`kernel/src/time/`)

#### 3.10.1 时钟源 (`clock.rs`)

基于架构抽象 `ArchTime` trait：
- `get_time()` — 获取当前时间（从启动以来的 tick 数）
- `set_timer()` — 设置下一次时钟中断
- RISC-V 使用 `mtime`/`mtimecmp` 寄存器
- LoongArch 使用其自身的定时器机制

#### 3.10.2 内核定时器 (`timer.rs`)

```rust
pub struct Timer {
    pub expire: Duration,
    pub data: Box<dyn TimerEvent>,
}

pub trait TimerEvent: Send + Sync {
    fn callback(self: Box<Self>) -> Option<Timer>;
}
```

- 使用 `BinaryHeap<Reverse<Timer>>` 实现最小堆定时器
- `TIMER_MANAGER` 全局单例管理所有定时器
- `timer_handler()` 在每个 `run_task()` 循环中调用，处理到期的定时器
- 支持 `TimerEvent` trait 实现不同类型的回调（waker 唤醒、信号发送等）
- `ITimerManager` 实现间隔定时器（ITIMER_REAL/VIRTUAL/PROF）

#### 3.10.3 时间片管理 (`time_slice.rs`)

- `set_next_trigger()` 设置下一次调度时钟中断
- `TimeSliceInfo::realtime()` / `TimeSliceInfo::normal()` 区分实时/普通时间片长度
- 支持负载均衡触发（`get_load_balance_ticks()`）

#### 3.10.4 超时机制 (`timeout.rs`)

```rust
pub struct TimeLimitedFuture<F> { ... }
pub enum TimeLimitedType<T> {
    Ok(T),
    TimeOut,
}
```
- `TimeLimitedFuture` 包装任意 future，提供超时语义
- 使用内核定时器注册超时回调

#### 3.10.5 时间命名空间 (`namespace.rs`)

```rust
pub struct TimeNamespace {
    offsets: BTreeMap<ClockId, Duration>,
}
```
- 支持 CLOCK_MONOTONIC / CLOCK_BOOTTIME 的命名空间偏移

---

### 3.11 异常与中断处理 (`kernel/src/trap/`)

#### 3.11.1 用户态陷阱处理 (`utrap_handler.rs`)

`user_trap_handler` 是用户态异常/中断的核心处理函数（async fn）：

```rust
pub async fn user_trap_handler(task: &Arc<Task>, trap_type: TrapType) {
    Arch::disable_interrupt();
    
    if unlikely(task.need_resched()) {
        task.yield_now().await;
    }

    match trap_type {
        TrapType::Exception(ExceptionType::Syscall) => {
            Arch::enable_interrupt();
            let result = task.syscall(cx).await;
            task.update_syscall_result(result);
        }
        TrapType::Exception(ExceptionType::PageFault(pf)) => {
            // COW 处理 / SIGSEGV / SIGBUS
            match task.memory_validate(addr, pf, false).await {
                Ok(_) => {},  // 页面已处理（COW 复制或分配）
                Err(errno) => {
                    // 发送 SIGSEGV 或 SIGBUS
                    task.recv_siginfo(...);
                }
            }
        }
        TrapType::Interrupt(InterruptType::Timer(id)) => {
            inc_interrupts_count(id);
            set_next_trigger(None);
            task.yield_now().await;
        }
        TrapType::Interrupt(InterruptType::SupervisorExternal(id)) => {
            inc_interrupts_count(id);
            ext_int_handler();
        }
        TrapType::Interrupt(InterruptType::SupervisorSoft(id)) => {
            inc_interrupts_count(id);
            soft_int_handler();
        }
        // ...
    }
}
```

处理流程：
1. 禁用中断
2. 检查是否需要重新调度（时间片用完）→ `yield_now().await`
3. 根据 trap 类型分发：系统调用→异步执行 syscall；缺页→COW/按需分配；定时器中断→yield；外部中断→设备中断处理；软中断→IPI 处理

#### 3.11.2 上下文切换 (`context.rs`)

```rust
pub struct TaskTrapContext {
    pub cx: TrapContext,
    pub res_tmp: usize,
    pub int_en: bool,
}

impl Task {
    pub fn trap_restore(&self) -> TrapType {
        clear_current_syscall();
        task.time_stat_mut().record_trap_in();
        let cx = task.trap_context_mut();
        Arch::trap_restore(cx);
        let trap_type = Arch::read_trap_type(cx);
        task.time_stat_mut().record_trap_out();
        trap_type
    }
}
```

`trap_restore()` 执行用户态返回（`sret`/`ertn`），下一次陷入时读取 trap 类型。这是一个经典的机制：内核在用户态返回后等待下一次陷入，然后恢复异步执行。

#### 3.11.3 外部中断处理 (`ext_int.rs`)

- `ext_int_handler()` 调用 `driver::manager::handle_irq()`
- PLIC 中断控制器处理外设中断
- 中断处理中可能唤醒等待 I/O 的 waker

#### 3.11.4 软中断 (`soft_int.rs`)

- 处理核间中断 (IPI)
- 用于多核调度中的远程唤醒

---

### 3.12 架构抽象层 (`lib/arch/`)

#### 3.12.1 通用 trait 定义 (`common/`)

| Trait | 说明 |
|-------|------|
| `ArchBoot` | `arch_init()`, `hart_start()` |
| `ArchInt` | 中断控制（enable/disable/ipi） |
| `ArchMemory` | TLB、页表激活、缓存同步 |
| `ArchTrap` | 陷阱初始化、上下文恢复、异常读取 |
| `ArchTrapContext` | 陷阱上下文访问（寄存器索引） |
| `ArchPageTable` | 页表操作 |
| `ArchPageTableEntry` | PTE 操作 |
| `ArchTime` | 时钟操作 |
| `ArchInfo` | 架构信息（名称、页大小、HART 数量） |
| `ArchAsm` | 汇编辅助操作 |

#### 3.12.2 RISC-V 64 实现 (`rv64/`)

- **页表**：SV39（3 级页表，39 位 VA，56 位 PA）
  ```rust
  pub const VA_WIDTH: usize = 39;
  pub const INDEX_LEVELS: usize = 3;
  pub const KERNEL_ADDR_OFFSET: usize = 0xffff_ffc0_0000_0000;
  pub const IO_ADDR_OFFSET: usize = 0xffff_ffd0_0000_0000;
  ```
- **PTE 格式**：标准 RISC-V PTE（V/R/W/X/U/G/A/D + COW 软件位）
- **陷阱向量**（`trap.S`）：
  - `__user_trapvec` — 用户→内核（通过 `sscratch` 交换栈）
  - `__user_trapret` — 内核→用户（`sret`）
  - `__kernel_trapvec` — 内核→内核（保存/恢复 caller-saved 寄存器）
  - `__kernel_user_ptr_vec` — 用户指针探测专用向量
- **上下文**（`context.rs`）：`TrapContext` 包含 32 个 GPR + sstatus + sepc + 内核上下文 + 浮点寄存器
- **浮点上下文**：`UserFloatContext`（32×f64 + fcsr + need_save/need_restore 标志）
- **寄存器**（`registers.rs`）：GPR 索引常量、`MySstatus`/`MyScause` 封装

#### 3.12.3 LoongArch 64 实现 (`la64/`)

- **页表**：LA64 三级页表
  ```rust
  const PA_WIDTH: usize = 39;
  const VA_WIDTH: usize = 39;
  pub(crate) const KERNEL_ADDR_OFFSET: usize = 0x9000_0000_0000_0000;
  ```
- **PTE 格式**：使用 LA 特有的位布局（V/D/PLV/MAT/G/P/W/COW/NR/NX/RPLV）
- **直接映射窗口**：使用 `dmw2` 寄存器实现内核直接映射
- **陷阱向量**（`trap.S`）：
  - `__user_trapvec` — 用户→内核（通过 `CSR_SAVE` 交换栈，`ertn` 返回）
  - `__user_trapret` — 内核→用户（`ertn`）
  - `__kernel_trapvec` — 内核→内核（512 字节栈帧）
  - `__kernel_user_ptr_vec` — LA 版本的用户指针探测
- **浮点支持**：完整的 32×f64 保存/恢复 + FCSR + FCC（浮点条件码）
- **未对齐访问处理**（`unaligned.rs`）：LA 架构默认为严格对齐，内核模拟未对齐访问

#### 3.12.4 架构差异处理

- RISC-V 使用 `#[cfg(target_arch = "riscv64")]` 条件编译
- LoongArch 使用 `target = "loongarch64-unknown-linux-gnu"` triple
- 两个架构共享通用 trait，各自实现具体细节
- LoongArch 需要 `la_libc_import.rs` 导入一些 libc 函数（因为使用 linux-gnu triple）

---

### 3.13 设备驱动子系统 (`lib/driver/`)

#### 3.13.1 驱动模型

**设备总线** (`manager.rs`)：
```rust
pub struct GeneralBus {
    pub block: SpinLock<Vec<&'static dyn BlockDevice>>,
    pub display: SpinLock<Vec<&'static dyn DisplayDevice>>,
    pub network: SpinLock<Vec<&'static dyn NetWorkDevice>>,
    pub interrupt: SpinLock<Vec<&'static dyn InterruptDevice>>,
}
pub static DEV_BUS: GeneralBus = GeneralBus::new();
```

**设备类型层次**：
- `Device` trait（基础）→ `BlockDevice` / `NetWorkDevice` / `DisplayDevice` / `InterruptDevice` / `CharDevice` 等
- 设备注册使用 `Box::leak(Box::new(dev))` 创建 `&'static dyn Device`
- 中断控制器通过 `define_global_device!` 宏全局注册

**设备探测** (`probe/`)：
- `probe_device(dtb)` — 从设备树解析设备信息
- `realize_device()` — 根据探测信息初始化设备
- 设备树解析：`probe/arch/rv/dtb.rs` 和 `probe/arch/la/dtb.rs` 使用 `fdt` crate
- PCI 探测：`probe/pci.rs`

#### 3.13.2 块设备驱动

- **virtio-blk** (`virtio_block.rs`)：基于 `virtio-drivers` crate 的异步 virtio 块设备驱动
- **AHCI** (`ls_ahci.rs` + `lib/driver_ahci/`)：AHCI SATA 控制器驱动（用于物理龙芯平台），包含完整的 ATA 命令实现
- **VF2 SD 卡** (`vf2_sdcard/`)：VisionFive 2 开发板的 SD 卡驱动

#### 3.13.3 字符设备驱动

- **NS16550A** (`ns16550a.rs`)：经典 UART 驱动
- **UART 8250** (`uart8250.rs`)：8250 兼容 UART

#### 3.13.4 中断控制器

- **PLIC** (`plic.rs`)：RISC-V 平台级中断控制器

#### 3.13.5 其他驱动

- **virtio-gpu** (`virtio_gpu.rs`)：virtio GPU 驱动
- **loopback** (`loopback.rs`)：网络回环设备
- **debug** (`debug_console.rs`, `debug_serial.rs`)：调试输出

---

### 3.14 同步原语 (`lib/ksync/`)

#### 3.14.1 自旋锁 (`mutex.rs`)

基于 `spin` crate 的 `SpinLock`：
```rust
pub use spin::mutex::SpinLock;
pub type Mutex<T> = SpinLock<T>;
```

在项目中使用 `ksync::mutex::SpinLock` 作为主要的内核锁机制。所有 VFS 组件、调度器、任务管理器均使用自旋锁保护。

#### 3.14.2 异步锁 (`async_lock/`)

自定义实现的异步锁：

- **`Mutex`**（`async_lock/mutex.rs`）：基于 waker 队列的异步互斥锁
- **`RwLock`**（`async_lock/rwlock/`）：基于 waker 队列的异步读写锁（分 raw/futures 两层实现）
- **`Semaphore`**（`async_lock/semaphore.rs`）：异步信号量
- **`Barrier`**（`async_lock/barrier.rs`）：异步屏障
- **`OnceCell`**（`async_lock/once_cell.rs`）：异步单次初始化

#### 3.14.3 异步 Mutex（阻塞式）

```rust
pub struct AsyncMutex<T> { ... }
pub struct AsyncMutexGuard<'a, T> { ... }
```
- 独立于自旋锁的异步 mutex，用于块缓存等场景
- 等待时通过 waker 挂起而不是自旋

#### 3.14.4 SyncUnsafeCell (`cell.rs`)

```rust
pub struct SyncUnsafeCell<T> { ... }
```
- 用于 `ThreadOnly<T>` 模式，标记仅当前线程访问但编译器不可见的数据
- 提供 `as_ref()` / `as_ref_mut()` 的安全访问接口

---

### 3.15 异步工具 (`lib/kfuture/`)

- `block.rs` — `block_on()` 函数：在当前线程上轮询 future 直到完成（用于引导阶段）
- `yield_fut.rs` — `yield_now()` future：主动让出 CPU
- `suspend.rs` — `suspend_now()`：挂起当前任务直到 waker 被触发
- `take_waker.rs` — 获取当前任务的 waker

---

### 3.16 进程间通信 (`kernel/src/ipc.rs`)

#### System V IPC 实现

**消息队列** (`SysvMsgManager`)：
```rust
pub struct SysvMsgManager {
    queues: BTreeMap<usize, SysvMsgQueue>,
    key_to_id: BTreeMap<usize, usize>,
    next_id: usize,
}
struct SysvMsgQueue {
    perm: IpcPerm,
    messages: VecDeque<SysvMessage>,
    msg_cbytes: usize,      // 当前字节数
    msg_qbytes: usize,      // 最大字节数
    msg_lspid: usize,       // 最后发送者 PID
    msg_lrpid: usize,       // 最后接收者 PID
}
```
- 支持 msgget/msgctl/msgsnd/msgrcv
- 消息类型过滤（MSG_EXCEPT）
- 容量限制（MSGMAX = 8192, MSGMNB = 16384）

**信号量** (`SysvSemManager`)：
```rust
pub struct SysvSemManager {
    sets: BTreeMap<usize, SysvSemSet>,
    key_to_id: BTreeMap<usize, usize>,
    next_id: usize,
}
struct SysvSemSet {
    perm: IpcPerm,
    values: Vec<u16>,
    last_pid: Vec<usize>,
}
```
- 支持 semget/semctl/semop/semtimedop
- 信号量操作集合（原子操作多个信号量）
- SEM_UNDO 标志支持

---

### 3.17 配置系统 (`lib/config/`)

包含编译期配置常量：

| 模块 | 关键配置 |
|------|---------|
| `cpu.rs` | `CPU_NUM`, `HART_NUM` |
| `fs.rs` | `BLOCK_SIZE = 512`, `MAX_LRU_CACHE_SIZE`, `PAGE_CACHE_PROPORTION`, `PIPE_BUF_SIZE` |
| `mm.rs` | `PAGE_SIZE = 4096`, `PAGE_WIDTH = 12`, `USER_STACK_SIZE`, `USER_HEAP_SIZE`, `USER_MEMORY_END`, `SIG_TRAMPOLINE` |
| `sched.rs` | 调度参数（时间片、优先级范围） |
| `task.rs` | `INIT_PROCESS_ID = 1`, 进程/线程数量限制 |

---

### 3.18 用户态库 (`user/libd/`)

#### 3.18.1 系统调用封装 (`syscall/`)

```rust
// syscall/wrapper.rs - 系统调用包装函数
pub fn sys_read(fd: usize, buf: *mut u8, count: usize) -> isize { ... }
pub fn sys_write(fd: usize, buf: *const u8, count: usize) -> isize { ... }
pub fn sys_openat(dirfd: isize, path: *const u8, flags: i32, mode: u32) -> isize { ... }
// ... 所有 ~100 个系统调用包装
```

- 架构相关的 syscall 实现（`arch/rv64/syscall.rs` / `arch/la64/syscall.rs`）
- RISC-V 使用 `ecall` 指令，LoongArch 使用 `syscall 0` 指令
- `syscall/macros.rs` 提供声明宏简化系统调用定义

#### 3.18.2 入口点 (`entry.rs`)

```rust
#[no_mangle]
pub extern "C" fn _start() -> ! {
    // 初始化堆
    // 调用 main(argc, argv)
    // 调用 exit()
}
```

#### 3.18.3 应用

- `run_busybox` — BusyBox 启动器
- `run_tests` — LTP 测试运行器（含数百个 feature gates 控制测试范围）

---

## 四、各子系统实现完整度评估

基于对源代码的详细审查，以 Linux 内核为参照基准：

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **内存管理** | 75% | 实现了完整的虚拟内存（页表/COW/mmap/shared memory），缺页处理完善。缺少：交换、NUMA、透明大页、KSM。 |
| **VFS** | 80% | 完整实现了 dentry/inode/file/superblock 抽象。支持 5 种文件系统（ramfs/devfs/procfs/ext4/FAT32）。有页缓存和块缓存。缺少：写时复制文件系统层（overlayfs）、NFS 客户端。 |
| **进程管理** | 78% | 实现了 fork/clone/execve/exit/wait 完整生命周期。支持命名空间（Mount/PID/Time/User）、cgroups 雏形。缺少：ptrace、coredump。 |
| **调度器** | 65% | 有可工作的多级调度器（实时FIFO + 普通Expired）。CFS 实现存在但未启用。支持多核。缺少：负载均衡（代码存在但未激活）、EAS、cgroup 调度。 |
| **信号** | 82% | 完整实现了 POSIX 信号（31 非实时 + 33 实时）。包括 sigaction/sigprocmask/sigaltstack/signalfd。信号帧构建完善。 |
| **网络** | 55% | TCP/UDP socket 功能完整。基于 smoltcp 协议栈。支持 loopback 和 virtio-net。缺少：IPv6 深度支持、路由表、ARP 缓存管理、完整的 netfilter。 |
| **文件系统** | 70% | ext4 和 FAT32 的读写支持。缺少：ext4 日志（journal）、FAT32 的 exFAT 支持、更多本地文件系统。 |
| **设备驱动** | 50% | 支持 virtio-blk/net/gpu、AHCI、NS16550A、PLIC。驱动模型（probe/realize）设计良好。缺少：USB 栈、PCI 枚举完善支持、更多真实硬件驱动。 |
| **系统调用** | 72% | 293 个系统调用覆盖主要 Linux syscall 集合。关键缺失：io_uring 完整实现（仅有 ID 定义）、seccomp、fanotify。 |
| **时间管理** | 70% | 支持高精度定时器、itimers、timerfd、clock_nanosleep。缺少：NTP 调整、完整的 clock_adjtime。 |
| **IPC** | 65% | System V 消息队列和信号量功能完整。POSIX 消息队列存在。缺少：Unix domain socket 完整实现。 |
| **同步原语** | 85% | 完整的自旋锁、异步锁、信号量、屏障、OnceCell、AsyncMutex。实现质量高。 |

**总体内核完整度：约 70%**（以 Linux 内核功能为基准，加权平均）

---

## 五、内核子系统交互分析

### 5.1 系统调用执行路径

```
用户程序
  ↓ ecall/syscall
__user_trapvec (汇编)
  ↓ 保存上下文，切换到内核栈
user_trap_handler (async fn)
  ↓ 匹配 TrapType::Exception(ExceptionType::Syscall)
task.syscall(cx).await
  ↓ 创建 Syscall { task }
syscall_inner(id, args).await
  ↓ match id → 具体 syscall 处理函数 (async fn)
  ├─ sys_read() → File::read_at() → Inode::read_at() → 页缓存/块缓存/设备
  ├─ sys_fork() → Task::do_fork() → MemorySet::fork_from() → spawn_utask()
  ├─ sys_wait4() → 等待子进程状态变更 (通过 waker)
  ├─ sys_ppoll() → AsyncWaitSet → 各文件 EventSource::poll_ready()
  └─ sys_nanosleep() → Timer 注册 → 挂起直到超时
  ↓ 结果写入 cx[TrapArgs::RES]
trap_restore()
  ↓ sret/ertn
用户程序继续执行
```

### 5.2 异步 I/O 等待路径

```
用户调用 read(fd, buf, len)
  ↓
sys_read(fd, buf, len)
  ↓
file.read(buf).await
  ↓ 尝试读取（非阻塞）
如果数据不可用：
  ↓ 创建 waker
inode/pipe/socket 注册 waker
  ↓
wait_with_policy(task, fut, policy, sigmask).await
  ↓
IntableFuture (可信号中断)
  ↓
yield_now().await  ← 让出 CPU，调度其他任务
  ...
[外部中断/定时器] →
  设备中断处理：
    ext_int_handler() → 设备驱动 → 数据就绪
    → 唤醒注册的 waker
  ↓
调度器选择该任务
  ↓
重新 poll future：
  file.read(buf) → 此时数据可用 → 返回 Ok(n)
  ↓
返回用户态（read 系统调用完成）
```

### 5.3 多核交互

```
Hart 0 (Boot):                   Hart 1..N:
  _boot_hart_init()                _other_hart_init()
    ... init ...                     arch_init()
    wake_other_hart(0)  ────→        kernel_space_activate()
    boot_broadcast()                 enable_interrupt()
    rust_main()                      rust_main()
      loop { run_task() }             loop { run_task() }
        ↓                                ↓
      RUNTIME.run()                   RUNTIME.run()
        ↓                                ↓
      scheduler.lock().pop()          scheduler.lock().pop()
        ↓                                ↓
      runnable.run()                  runnable.run()
```

多核通过 `SpinLock` 保护的共享调度器访问实现。IPI (`SupervisorSoft`) 用于跨核唤醒。

---

## 六、设计创新性分析

### 6.1 核心创新：AsyncBridge 全异步架构

该项目最显著的设计创新在于**将内核系统调用设计为原生异步（async fn）**。传统宏内核（包括 Linux）中，系统调用是同步执行路径。AsyncBridge 将每个系统调用实现为 Rust `async fn`：

```rust
// Linux 风格（同步）
fn sys_read(fd: usize, buf: *mut u8, count: usize) -> isize { ... }

// AsyncBridge 风格（异步）
async fn sys_read(&self, fd: usize, buf: usize, count: usize) -> SyscallResult { ... }
```

这一设计的深层含义是：

1. **阻塞系统调用自然地让出 CPU**：当 I/O 不可用时，系统调用通过 `.await` 挂起，调度器可以选择其他可运行的任务。这消除了传统内核中"阻塞线程"的概念。

2. **统一等待模型**（`async_bridge.rs`）：`EventSource` trait 和 `WaitPolicy` 机制将管道、socket、futex、eventfd、timerfd 等不同的等待语义统一为 `poll_ready` + `waker` 的模式。

3. **信号中断即 EINTR**：`IntableFuture` 在每次 poll 前检查 pending 信号，使得信号自然地打断任何可中断的等待——这正是 POSIX 语义要求但传统内核实现复杂的特性。

4. **超时即 cancellation**：`TimeLimitedFuture` 通过内核定时器注册 waker，超时后 waker 被触发，future 返回 `TimeLimitedType::TimeOut`。这比传统内核中分散的超时处理更一致。

### 6.2 创新性的具体体现

1. **async-task 作为调度基础**：使用 `async-task` crate（从 vendor 目录看是定制版本）构建内核调度器，而非传统的内核线程模型。

2. **分层锁策略**：`Task` 结构体将字段分为 `Mutable`（锁保护）、`ThreadOnly`（无锁）、`Immutable`（构造后不变）、`SharedMut`（跨线程共享）四种类型，在编译期编码了数据访问模式。

3. **架构抽象的一致性**：RISC-V 和 LoongArch 共享完全相同的 trait 集合，每个架构仅需实现 `ArchBoot`、`ArchInt`、`ArchMemory`、`ArchTrap` 等 trait。这是 Rust trait 系统的优良应用。

4. **设备探测与驱动模型**：probe（设备树/PCI 探测）+ realize（设备初始化）的两阶段驱动模型，结合 `GeneralBus` 全局设备总线，提供了清晰的驱动架构。

5. **内嵌 ELF init 进程**：通过编译期将用户程序二进制嵌入内核数据段，简化了引导过程，无需依赖磁盘驱动即可启动到用户态。

### 6.3 设计上的权衡

- **全异步的代价**：所有系统调用都是 async fn，这意味着即使是最简单的 `getpid()` 也需要 async context。代码中大量使用 `block_on()` 来桥接同步/异步边界（尤其在引导阶段）。
- **自旋锁而非睡眠锁**：内核广泛使用 `SpinLock` 而非基于 waker 的异步锁。在单核或低竞争场景下合理，但在高竞争多核场景下可能成为瓶颈。
- **smoltcp 而非自定义网络栈**：依赖 smoltcp 减少了网络栈开发工作量，但也限制了性能优化空间和协议完整性。

---

## 七、其他技术信息

### 7.1 构建系统特点

- 支持 RISC-V 和 LoongArch 双架构
- 用户程序支持 MUSL 和 glibc 双工具链（通过 `LIB_NAME` 变量选择）
- 支持 QEMU 和物理板卡（通过 `FEAT_ON_QEMU` 变量控制）
- Docker 容器化构建支持（`zhouzhouyi/os-contest:20260510`）
- LTP 测试集成：通过 `run_tests` 应用的 feature flags 控制测试范围（200+ 个测试 feature）
- 自定义链接脚本生成（`lib/scripts/mk_ld.sh`）

### 7.2 性能分析

- `kernel/src/profile.rs` 提供文件系统操作耗时统计
- 调试特性 `debug_sig` 周期性打印任务状态
- `utils/crossover.rs` 提供周期性中断调试

### 7.3 Panic 处理

- `kernel/src/panic.rs`：panic 时打印寄存器、内存信息、任务状态，然后关机
- 使用 `core::intrinsics::abort()` 终止执行

### 7.4 日志系统

- 基于 `log` crate + 自定义 logger (`utils/log.rs`)
- 通过 `LOG` 环境变量控制日志级别（DEBUG/INFO/WARN/ERROR/OFF）
- 日志输出到串口（UART）

---

## 八、总结

AsyncBridge（NoAxiom）是一个用 Rust 编写的中型宏内核，面向 RISC-V 64 和 LoongArch 64 架构。其核心特色在于**全异步内核设计**：所有系统调用使用 Rust `async fn` 实现，在自定义的 `MultiLevelRuntime` 异步运行时上执行。

**项目规模**：内核 body 约 77,000 行 Rust 代码（不含 vendor 和用户测试），12,185 行系统调用实现代码，支持 293 个 Linux 兼容系统调用。

**实现亮点**：
1. 完整的 VFS 层（5 种文件系统）、页缓存和块缓存
2. 完善的进程管理（fork/clone/execve 含 COW、命名空间）
3. 统一的异步 I/O 桥接模型（EventSource/Waker/WaitPolicy）
4. 信号子系统完整（POSIX 信号、signalfd、可中断等待）
5. 双架构支持（RISC-V 和 LoongArch）的清洁架构抽象
6. TCP/UDP 网络栈基于 smoltcp
7. System V IPC 和 POSIX 消息队列
8. 丰富的设备驱动和驱动模型
9. 分层锁策略和完整的同步原语

**待完善领域**：
1. CFS 调度器尚未激活（当前使用 ExpiredScheduler）
2. 网络栈缺少路由、ARP 管理等高级功能
3. 设备驱动覆盖范围有限（缺少 USB、PCI 枚举等）
4. 无交换和高级内存管理特性
5. io_uring 仅有 syscall ID 定义，无实现
6. 部分系统调用仅返回 ENOSYS

**创新性评价**：该项目在全异步内核设计方面具有明显创新。将系统调用设计为 async fn、统一的 EventSource 等待模型、分层锁策略、以及基于 async-task 的内核调度，构成了一个协调一致的设计理念。在 Rust 语言特性的应用上（trait、async/await、类型系统安全抽象）展现了较高的工程水平。