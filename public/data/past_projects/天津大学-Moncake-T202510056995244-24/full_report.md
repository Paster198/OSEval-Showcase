# MonkeyOS 操作系统内核技术报告

## 1. 项目概述

MonkeyOS 是由天津大学团队基于 ByteOS 项目二次开发的操作系统内核，参加 OSKernel2025 竞赛。项目使用 Rust 语言（nightly-2024-08-01）编写，目标架构为 RISC-V 64 和 LoongArch 64。内核采用宏内核架构，通过 `polyhal`（v0.2.4）硬件抽象层实现跨架构支持，并基于 Rust 异步编程模型实现协作式调度。

---

## 2. 项目规模与结构

### 2.1 代码规模统计

| 模块 | 路径 | 文件数 | 代码行数（约） |
|------|------|--------|----------------|
| 内核核心 | `kernel/src/` | 28 | ~5,500 |
| 共享库 | `crates/` | 13 | ~2,200 |
| 驱动 | `driver/` | 10 | ~1,500 |
| 文件系统 | `filesystem/` | 18 | ~4,500 |
| **总计（不含 vendor）** | | **69** | **~13,700** |

### 2.2 目录结构

```
MonkeyOS/
├── kernel/          -- 内核核心（入口、系统调用、任务管理、用户态交互）
├── crates/
│   ├── devices/     -- 设备抽象层
│   ├── executor/    -- 异步执行器（协作式调度器）
│   ├── runtime/     -- 运行时（堆分配器、物理页帧分配器）
│   ├── signal/      -- 信号标志与操作定义
│   └── sync/        -- 同步原语（Mutex、RwLock、LazyInit）
├── driver/
│   ├── general-plic/   -- PLIC 中断控制器
│   ├── kgoldfish-rtc/  -- Goldfish RTC
│   ├── kramdisk/       -- RAM Disk
│   ├── kvirtio/        -- VirtIO 驱动（块/网络/输入）
│   └── ns16550a/       -- UART 串口
├── filesystem/
│   ├── vfscore/     -- VFS 核心抽象（trait 定义、类型定义）
│   ├── fs/          -- 主文件系统层（ext4/FAT 适配、dentry、file、pipe）
│   ├── devfs/       -- 设备文件系统
│   ├── procfs/      -- 进程文件系统
│   └── ramfs/       -- 内存文件系统
├── config/          -- 板级配置
├── vendor/          -- 85 个第三方 crate（离线构建）
└── Makefile         -- 构建入口
```

---

## 3. 子系统详细分析

### 3.1 内核入口与中断处理（`kernel/src/main.rs`）

#### 3.1.1 启动流程

内核入口通过 `polyhal_boot::define_entry!(main, secondary)` 宏定义，`main` 函数接收 `hart_id` 参数，执行以下初始化序列：

```rust
fn main(hart_id: usize) {
    IRQ::int_disable();
    runtime::init();                    // 初始化堆分配器
    polyhal::common::init(&PageAllocImpl); // 初始化 HAL 页分配器
    get_mem_areas().cloned().for_each(|(start, size)| {
        runtime::frame::add_frame_map(start, start + size); // 注册物理内存
    });
    devices::prepare_drivers();         // 准备驱动
    // FDT 设备枚举
    if let Ok(fdt) = get_fdt() {
        for node in fdt.all_nodes() {
            devices::try_to_add_device(&node);
        }
    }
    devices::regist_devices_irq();      // 注册设备中断
    fs::init();                         // 初始化文件系统
    IRQ::int_enable();                  // 开启中断
    tasks::init();                      // 初始化调度器
    tasks::run_tasks();                 // 运行任务主循环
}
```

**分析**：启动流程清晰，遵循典型的裸机内核初始化顺序。但 `main.rs` 中包含大量调试代码（约 300 行用于文件系统诊断和目录遍历输出），这些代码在生产环境中应当移除。多核启动代码被注释掉（`polyhal::multicore::MultiCore::boot_all()`），当前仅支持单核运行。

#### 3.1.2 中断处理

`kernel_interrupt` 函数处理以下异常类型：

| 异常类型 | 处理方式 |
|----------|----------|
| StorePageFault / InstructionPageFault / LoadPageFault | 用户态：COW 缺页处理；内核态：panic |
| IllegalInstruction | 委托给 `task_ilegal` 处理（信号或终止） |
| SupervisorExternal | 委托给中断设备处理 |

**分析**：缺页处理中包含 `force_unlock()` 的不安全操作，用于解决锁竞争问题，但存在潜在的数据竞争风险。

### 3.2 调度与执行器子系统（`crates/executor/`）

#### 3.2.1 架构设计

执行器基于 Rust 的 `Future` 和 `async/await` 机制实现协作式调度：

```rust
pub struct Executor {
    cores: LazyInit<Vec<Mutex<Option<Arc<dyn AsyncTask>>>>>,
    inited: AtomicBool,
}
```

核心调度循环：

```rust
pub fn run(&self) {
    loop {
        self.run_ready_task();
        self.hlt_if_idle();
    }
}

fn run_ready_task(&self) {
    let task = TASK_QUEUE.lock().pop_front();
    if let Some(task_item) = task {
        let AsyncTaskItem { task, mut future } = task_item;
        task.before_run();  // 切换页表
        *self.cores[hart_id()].lock() = Some(task.clone());
        let waker = Arc::new(Waker { task_id: task.get_task_id() }).into();
        let mut context = Context::from_waker(&waker);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(()) => {} // 任务完成
            Poll::Pending => TASK_QUEUE.lock().push_back(AsyncTaskItem { future, task }),
        }
    }
}
```

#### 3.2.2 任务抽象

```rust
pub trait AsyncTask: DowncastSync {
    fn get_task_id(&self) -> TaskId;
    fn before_run(&self);      // 切换页表等上下文
    fn get_task_type(&self) -> TaskType;
    fn exit(&self, exit_code: usize);
    fn exit_code(&self) -> Option<usize>;
}
```

支持的任务类型包括：`BlankKernel`、`MonolithicTask`、`MicroTask`、`UnikernelTask`、`RTOSTask` 等。

#### 3.2.3 线程 spawn 机制

```rust
pub fn spawn<T: AsyncTask>(task: Arc<T>, future: impl Future<Output = ()> + Send + 'static) {
    let future = async move {
        future.await;
    };
    DEFAULT_EXECUTOR.spawn(task, Box::pin(future));
}
```

**分析**：
- **优点**：利用 Rust 异步生态实现调度，代码简洁，类型安全。
- **缺点**：
  - 调度器为纯协作式，无时间片抢占。任务必须主动 `yield_now().await` 才能切换。
  - `Waker` 实现为空操作（`wake_by_ref` 为空函数），意味着被阻塞的任务无法被真正唤醒，只能依赖轮询。
  - `hlt_if_idle` 为空实现，空闲时不执行 `wfi` 指令，浪费 CPU 资源。
  - 任务队列为全局单一 FIFO 队列，无优先级支持。

### 3.3 进程/任务管理子系统（`kernel/src/tasks/`）

#### 3.3.1 进程控制块（PCB）

```rust
pub struct ProcessControlBlock {
    pub memset: MemSet,           // 内存映射集合
    pub fd_table: FileTable,      // 文件描述符表
    pub curr_dir: Arc<File>,      // 当前工作目录
    pub heap: usize,              // 堆顶地址
    pub entry: usize,             // 程序入口地址
    pub children: Vec<Arc<UserTask>>, // 子进程列表
    pub tms: TMS,                 // 进程时间统计
    pub rlimits: Vec<usize>,      // 资源限制
    pub sigaction: [SigAction; 65], // 信号处理表
    pub futex_table: Arc<Mutex<FutexTable>>, // Futex 表
    pub shms: Vec<MapedSharedMemory>, // 共享内存映射
    pub timer: [ProcessTimer; 3], // 定时器
    pub threads: Vec<Weak<UserTask>>, // 线程列表
    pub exit_code: Option<usize>,
    pub exit_signal: Option<usize>,
    pub core_dumped: bool,
    pub umask: usize,
}
```

#### 3.3.2 线程控制块（TCB）

```rust
pub struct ThreadControlBlock {
    pub cx: TrapFrame,            // 寄存器上下文
    pub sigmask: SigProcMask,     // 信号掩码
    pub clear_child_tid: usize,
    pub set_child_tid: usize,
    pub signal: SignalList,       // 待处理信号列表
    pub signal_queue: [usize; REAL_TIME_SIGNAL_NUM], // 实时信号队列
    pub exit_signal: u8,
    pub thread_exit_code: Option<u32>,
    pub robust_list_head: usize,
    pub robust_list_len: usize,
}
```

#### 3.3.3 UserTask 结构

```rust
pub struct UserTask {
    pub task_id: TaskId,
    pub process_id: TaskId,
    pub page_table: Arc<PageTableWrapper>,
    pub pcb: Arc<Mutex<ProcessControlBlock>>,
    pub parent: RwLock<Weak<UserTask>>,
    pub tcb: RwLock<ThreadControlBlock>,
}
```

**分析**：PCB 和 TCB 分离设计正确支持了多线程模型。`task_id` 和 `process_id` 区分线程和进程。但 PCB 使用 `Mutex` 保护，在高并发场景下可能成为瓶颈。

#### 3.3.4 Fork 与 COW（Copy-on-Write）

`cow_fork` 实现：

```rust
pub fn cow_fork(self: &Arc<Self>) -> Arc<UserTask> {
    // 1. 分配新 task_id 和页表
    let child_task = Arc::new(Self {
        page_table: Arc::new(PageTableWrapper::alloc()),
        task_id: task_id_alloc(),
        process_id: self.process_id, // 继承进程 ID
        // ...
    });
    
    // 2. 复制内存映射（共享物理页，增加引用计数）
    for area in pcb.memset.iter() {
        for tracker in area.mtrackers.iter() {
            child_task.map(tracker.tracker.0, tracker.vaddr, MappingFlags::URX);
        }
    }
    
    // 3. 复制文件描述符表、信号处理表等
    // ...
}
```

COW 缺页处理（`user_cow_int`）：

```rust
pub fn user_cow_int(task: Arc<UserTask>, cx_ref: &mut TrapFrame, vaddr: VirtAddr) {
    let mut pcb = task.pcb.lock();
    let area = pcb.memset.iter_mut().find(|x| x.contains(vaddr.raw()));
    if let Some(area) = area {
        let finded = area.mtrackers.iter_mut().find(|x| x.vaddr == vaddr.floor());
        let ppn = match finded {
            Some(map_track) => {
                if Arc::strong_count(&map_track.tracker) > 1 {
                    // 复制物理页
                    let src = map_track.tracker.0;
                    let dst = frame_alloc().expect("...");
                    unsafe {
                        dst.0.get_mut_ptr::<u8>()
                            .copy_from_nonoverlapping(src.get_ptr(), PAGE_SIZE);
                    }
                    map_track.tracker = Arc::new(dst);
                }
                map_track.tracker.0
            }
            None => {
                // 按需分配新页（demand paging）
                let tracker = Arc::new(frame_alloc().expect("..."));
                // 如果有文件映射，从文件读取
                if let Some(file) = &area.file {
                    file.readat(file_offset, tracker.0.slice_mut_with_len(PAGE_SIZE));
                }
                // ...
            }
        };
        task.map(ppn, vaddr.floor(), MappingFlags::URWX);
    }
}
```

**分析**：COW 实现基本正确，使用 `Arc<FrameTracker>` 的引用计数判断是否需要复制。但存在以下问题：
- 所有映射权限统一设为 `URWX`（读/写/执行），未实现细粒度的权限控制（如代码段只读+执行）。
- 缺页处理中包含大量针对特定地址范围的硬编码逻辑（如 `0x7000_0000` 栈区域、`0x1000000` 堆区域），缺乏通用性。

#### 3.3.5 ELF 加载

支持静态和动态链接的 ELF 文件加载：

```rust
pub async fn exec_with_process(
    task: Arc<UserTask>,
    curr_dir: PathBuf,
    path: String,
    args: Vec<String>,
    envp: Vec<String>,
) -> Result<Arc<UserTask>, Errno> {
    // 1. 读取 ELF 文件
    let file = File::open(path.clone(), OpenFlags::O_RDONLY)?;
    let buffer = frame_alloc_much(file_size.div_ceil(PAGE_SIZE));
    file.readat(0, buffer);
    
    // 2. 解析 ELF 头
    let elf = xmas_elf::ElfFile::new(&buffer);
    
    // 3. 检测动态链接器
    let header = elf.program_iter().find(|ph| ph.get_type() == Ok(Type::Interp));
    if let Some(header) = header {
        // 根据 libc 类型（musl/glibc）选择动态链接器
        let libc_type = detect_libc_type(&elf);
        // 加载动态链接器和 libc.so
    }
    
    // 4. 加载 LOAD 段
    elf.program_iter()
        .filter(|x| x.get_type().unwrap() == Type::Load)
        .for_each(|ph| {
            // 分配物理页并复制数据
        });
    
    // 5. 初始化栈（参数、环境变量、auxv）
    init_task_stack(user_task, args, base, &path, entry_point, ...);
}
```

**分析**：
- 支持 musl 和 glibc 两种 C 库的动态链接。
- 栈初始化正确设置了 `auxv`（辅助向量），包括 `AT_PHDR`、`AT_PHNUM`、`AT_ENTRY`、`AT_RANDOM` 等。
- 任务模板缓存机制（`TaskCacheTemplate`）可加速重复程序的加载。
- ELF 加载失败时自动回退到 `busybox sh`，增强了鲁棒性。

### 3.4 内存管理子系统（`crates/runtime/`）

#### 3.4.1 物理页帧分配器

```rust
pub struct FrameRegionMap {
    bits: Vec<usize>,      // 位图：每 bit 代表一个 4KB 页
    paddr: PhysAddr,
    paddr_end: PhysAddr,
}

pub struct FrameAllocator(Vec<FrameRegionMap>);
```

**分配算法**：
- 单页分配：线性扫描位图，找到第一个空闲位。
- 多页连续分配：滑动窗口方法查找连续空闲块。
- 分配失败时输出内存碎片化分析日志。

**分析**：
- 位图分配器实现简单可靠，但分配效率为 O(n)，对于大内存系统可能较慢。
- 不支持 buddy 分配器或 slab 分配器，无法有效减少外部碎片。
- `FrameTracker` 使用 `Drop` trait 自动回收物理页，防止内存泄漏。

#### 3.4.2 堆分配器

```rust
#[global_allocator]
static HEAP_ALLOCATOR: LockedHeap = LockedHeap::empty();

pub fn init() {
    let heap_start = frame_alloc_much(HEAP_SIZE / PAGE_SIZE);
    unsafe {
        HEAP_ALLOCATOR.init(heap_start[0].0.raw() | VIRT_ADDR_START, HEAP_SIZE);
    }
}
```

使用 `linked_list_allocator` crate 提供的 `LockedHeap`，初始堆大小为 16MB（4096 页 × 4KB）。

**分析**：堆大小固定，不支持动态扩展。对于大型应用可能导致堆溢出。

#### 3.4.3 虚拟内存管理

`MemSet` 管理进程的虚拟内存区域：

```rust
pub struct MemArea {
    pub mtype: MemType,           // 类型：CodeSection/Stack/Mmap/Shared/ShareFile
    pub mtrackers: Vec<MapTrack>, // 虚拟-物理映射跟踪
    pub file: Option<Arc<dyn INodeInterface>>, // 文件映射（如有）
    pub offset: usize,            // 文件偏移
    pub start: usize,             // 虚拟起始地址
    pub len: usize,               // 长度
}
```

支持的操作：
- `sub_area`：从内存区域中切除指定范围（用于 munmap）
- `overlapping`：检查重叠
- `write_page`：将脏页写回文件（用于文件映射）

### 3.5 文件系统子系统（`filesystem/`）

#### 3.5.1 VFS 核心抽象

```rust
pub trait INodeInterface: DowncastSync + Send + Sync {
    fn readat(&self, offset: usize, buffer: &mut [u8]) -> VfsResult<usize>;
    fn writeat(&self, offset: usize, buffer: &[u8]) -> VfsResult<usize>;
    fn lookup(&self, name: &str) -> VfsResult<Arc<dyn INodeInterface>>;
    fn create(&self, name: &str, file_type: FileType) -> VfsResult<()>;
    fn stat(&self, stat: &mut Stat) -> VfsResult<()>;
    fn read_dir(&self) -> VfsResult<Vec<DirEntry>>;
    fn remove(&self, name: &str) -> VfsResult<()>;
    fn truncate(&self, len: usize) -> VfsResult<()>;
    fn poll(&self, events: PollEvent) -> VfsResult<PollEvent>;
    fn resolve_link(&self) -> VfsResult<String>;
    // ...
}

pub trait FileSystem: Send + Sync {
    fn root_dir(&self) -> Arc<dyn INodeInterface>;
    fn name(&self) -> &str;
    fn flush(&self) -> VfsResult<()>;
}
```

#### 3.5.2 挂载与路径解析

`dentry.rs` 实现挂载点管理：

```rust
pub fn mount_fs(fs: Arc<dyn FileSystem>, path: &str) {
    MOUNT_POINTS.lock().push((PathBuf::from(path), fs));
}

pub fn get_mounted(path: &PathBuf) -> (Arc<dyn INodeInterface>, PathBuf) {
    // 查找最长前缀匹配的挂载点
}
```

初始化时挂载：
| 路径 | 文件系统类型 |
|------|-------------|
| `/` | ext4（块设备）或 ramfs（无块设备） |
| `/dev` | DevFS |
| `/tmp` | RamFS |
| `/dev/shm` | RamFS |
| `/home` | RamFS |
| `/var` | RamFS |
| `/proc` | ProcFS |

#### 3.5.3 ext4 文件系统适配

通过 `ext4_shim.rs` 适配 `lwext4_rust` 库：

```rust
pub struct Ext4FileSystem {
    inner: Arc<Ext4>,
}

impl FileSystem for Ext4FileSystem {
    fn root_dir(&self) -> Arc<dyn INodeInterface> {
        Arc::new(Ext4Dir { path: "/".to_string(), fs: self.inner.clone() })
    }
}
```

#### 3.5.4 DevFS 设备文件系统

支持的设备节点：
- `/dev/null`：丢弃所有写入，读取返回 0 字节
- `/dev/zero`：读取返回零字节
- `/dev/tty`：终端设备
- `/dev/rtc`：实时时钟
- `/dev/shm`：共享内存目录
- `/dev/urandom`：伪随机数生成器
- `/dev/passwd`：密码文件
- `/dev/cpu_dma_latency`：CPU DMA 延迟

#### 3.5.5 ProcFS 进程文件系统

支持的伪文件：
- `/proc/cpuinfo`：CPU 信息
- `/proc/meminfo`：内存信息
- `/proc/mounts`：挂载信息
- `/proc/stat`：系统统计
- `/proc/version`：内核版本
- `/proc/interrupts`：中断信息

#### 3.5.6 管道（Pipe）

```rust
pub fn create_pipe() -> (Arc<Pipe>, Arc<Pipe>) {
    let buffer = Arc::new(Mutex::new(VecDeque::new()));
    let read_end = Arc::new(Pipe { buffer: buffer.clone(), is_read: true });
    let write_end = Arc::new(Pipe { buffer, is_read: false });
    (read_end, write_end)
}
```

**分析**：
- 文件系统层次清晰，VFS 抽象合理。
- ext4 支持通过外部库实现，但适配层较薄，错误处理可能不完善。
- 符号链接解析在 `File::open` 中实现，支持递归解析，但可能存在循环链接导致的无限递归风险。
- `getdents` 实现中硬编码了 `max_entries = 50` 的限制，可能导致大目录读取不完整。

### 3.6 驱动子系统（`driver/`）

#### 3.6.1 VirtIO 块设备

```rust
pub struct VirtIOBlk {
    inner: Mutex<VirtIOBlkDriver<HalImpl, MmioTransport>>,
    interrupts: Vec<u32>,
}

impl BlockDriver for VirtIOBlk {
    fn read_block(&self, block_id: usize, buf: &mut [u8]) -> Result<(), &'static str> {
        self.inner.lock().read_block(block_id, buf)
    }
    fn write_block(&self, block_id: usize, buf: &[u8]) -> Result<(), &'static str> {
        self.inner.lock().write_block(block_id, buf)
    }
}
```

#### 3.6.2 VirtIO 网络设备

```rust
pub struct VirtIONet {
    inner: Mutex<VirtIONetDriver<HalImpl, MmioTransport>>,
    interrupts: Vec<u32>,
}

impl NetDriver for VirtIONet {
    fn send(&self, data: &[u8]) -> Result<usize, &'static str> {
        self.inner.lock().send(data)
    }
    fn recv(&self, buf: &mut [u8]) -> Result<usize, &'static str> {
        self.inner.lock().recv(buf)
    }
}
```

#### 3.6.3 LoongArch PCI 支持

LoongArch 架构下通过 PCI 总线枚举 VirtIO 设备：

```rust
#[cfg(target_arch = "loongarch64")]
fn enumerate_pci(mmconfig_base: *mut u8) {
    let mut pci_root = unsafe { PciRoot::<MmioCam>::new(...) };
    for (device_function, info) in pci_root.enumerate_bus(0) {
        if let Some(virtio_type) = virtio_device_type(&info) {
            // 分配 BAR、启用设备、创建 PciTransport
        }
    }
}
```

**分析**：
- 驱动实现依赖 `virtio-drivers` crate，封装层较薄。
- VirtIO Input 驱动的 `read_event`、`handle_irq`、`is_empty` 均为 `todo!()`，功能未实现。
- LoongArch PCI 枚举代码较为完整，包含 BAR 分配、设备启用等。

### 3.7 系统调用子系统（`kernel/src/syscall/`）

#### 3.7.1 系统调用分发

```rust
impl UserTaskContainer {
    pub async fn syscall(&self, call_id: usize, args: [usize; 6]) -> Result<usize, Errno> {
        let sysno = Sysno::new(call_id).ok_or(Errno::EINVAL)?;
        match sysno {
            Sysno::read => self.sys_read(args[0] as _, args[1].into(), args[2] as _).await,
            Sysno::write => self.sys_write(args[0] as _, args[1].into(), args[2] as _).await,
            // ... 约 100+ 系统调用
        }
    }
}
```

#### 3.7.2 已实现的系统调用列表

| 类别 | 系统调用 |
|------|----------|
| **文件描述符** | openat, close, read, write, readv, writev, pread64, pwrite64, lseek, dup, dup3, ioctl, fcntl, fstat, fstatat, getdents64, mkdirat, unlinkat, renameat2, symlinkat, linkat, readlinkat, fchmodat, fchown, fchownat, umask |
| **内存管理** | brk, mmap, munmap, mprotect, msync, set_robust_list, get_robust_list |
| **进程管理** | clone, execve, exit, wait4, getpid, getppid, gettid, sched_yield, set_tid_address, prlimit64 |
| **信号** | rt_sigaction, rt_sigprocmask, rt_sigsuspend, rt_sigtimedwait, kill, tgkill |
| **套接字** | socket, bind, listen, accept, connect, sendto, recvfrom, setsockopt, getsockopt, socketpair, shutdown |
| **IPC** | shmget, shmat, shmdt, shmctl, semget, semctl, semop, msgget, msgsnd, msgrcv, msgctl |
| **时间** | clock_gettime, gettimeofday, nanosleep, times |
| **系统信息** | uname, statfs, mount, umount2, getcwd, chdir, futex, epoll_create1, epoll_ctl, epoll_wait, poll, pipe2 |

**分析**：系统调用覆盖面广，基本满足 Linux 兼容性需求。但部分实现为 stub（如 `mprotect` 直接返回 0，`msync` 直接返回 0），可能影响依赖这些功能的程序正确性。

### 3.8 网络子系统（`kernel/src/socket.rs` + `syscall/socket.rs`）

#### 3.8.1 协议栈

使用 `lose-net-stack` 库实现 TCP/UDP 协议栈：

```rust
pub static NET_SERVER: Lazy<Arc<NetServer<NetMod>>> = Lazy::new(|| {
    Arc::new(NetServer::new(
        MacAddress::new([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]),
        Ipv4Addr::new(10, 0, 2, 15),
    ))
});
```

#### 3.8.2 Socket 抽象

```rust
pub struct Socket {
    pub domain: usize,
    pub net_type: NetType,  // STEAM (TCP) / DGRAME (UDP)
    pub inner: Arc<dyn SocketInterface>,
    pub options: Mutex<SocketOptions>,
    pub buf: Mutex<Vec<u8>>,
}
```

Socket 实现了 `INodeInterface` trait，可像普通文件一样通过 `readat`/`writeat` 进行数据收发。

**分析**：
- 网络功能基本可用，支持 TCP/UDP 的 bind/listen/accept/connect/send/recv。
- IP 地址硬编码为 `10.0.2.15`（QEMU 用户模式网络的默认地址）。
- 不支持 RAW socket。
- `socketpair` 实现使用内存通道模拟。

### 3.9 信号子系统（`crates/signal/` + `kernel/src/tasks/signal.rs`）

#### 3.9.1 信号定义

支持 64 种信号，包括标准信号（SIGHUP-SIGSYS）和实时信号（SIGRT_3-SIGRTMAX）。

#### 3.9.2 信号处理流程

```rust
pub async fn check_signal(&self) {
    loop {
        let sig_mask = self.task.tcb.read().sigmask;
        let signal = self.task.tcb.read().signal.clone().mask(sig_mask).try_get_signal();
        if let Some(signal) = signal {
            self.handle_signal(signal.clone()).await;
            tcb.signal.remove_signal(signal.clone());
            // 处理实时信号队列
        } else {
            break;
        }
    }
}
```

**分析**：信号处理在每次用户态返回前检查，支持信号掩码、信号动作注册、实时信号队列。实现较为完整。

### 3.10 IPC 子系统

#### 3.10.1 共享内存

```rust
pub struct SharedMemory {
    pub trackers: Vec<Arc<FrameTracker>>,
    pub deleted: Mutex<bool>,
}

pub static SHARED_MEMORY: Mutex<BTreeMap<usize, Arc<SharedMemory>>> = Mutex::new(BTreeMap::new());
```

支持 `shmget`、`shmat`、`shmdt`、`shmctl`。

#### 3.10.2 信号量

```rust
pub struct Semaphore {
    pub key: usize,
    pub nsems: usize,
    pub values: Vec<i32>,
}
```

支持 `semget`、`semctl`（SETVAL/GETVAL/IPC_RMID）、`semop`（简化实现）。

#### 3.10.3 消息队列

```rust
pub struct MessageQueue {
    pub key: usize,
    pub messages: Vec<Message>,
    pub max_bytes: usize,
    pub current_bytes: usize,
    pub max_messages: usize,
}
```

支持 `msgget`、`msgsnd`、`msgrcv`、`msgctl`。

#### 3.10.4 Futex

```rust
pub type FutexTable = BTreeMap<usize, Vec<usize>>;
```

支持 `futex_wait`、`futex_wake`、`futex_requeue`。

**分析**：IPC 机制覆盖全面，但信号量和消息队列的实现为简化版本，可能无法通过完整的 POSIX 兼容性测试。

---

## 4. 子系统交互分析

### 4.1 系统调用执行流程

```
用户态程序
    ↓ (ecall 指令)
polyhal_trap (TrapFrame 保存)
    ↓
kernel_interrupt / run_user_task
    ↓
UserTaskContainer::entry_point
    ↓ (检查信号、定时器)
UserTaskContainer::syscall
    ↓ (分发到具体实现)
sys_read / sys_write / sys_clone / ...
    ↓ (操作 PCB/TCB)
返回用户态
```

### 4.2 缺页处理流程

```
用户态访问未映射地址
    ↓ (Store/Load Page Fault)
kernel_interrupt
    ↓
user_cow_int
    ↓
├── COW 复制（引用计数 > 1）
├── 按需分配（demand paging）
├── 栈扩展（0x7000_0000-0x8000_0000）
├── 堆扩展（0x1000000-0x2000000）
└── SIGSEGV 信号（无效地址）
```

### 4.3 文件系统 I/O 流程

```
sys_read(fd, buf, count)
    ↓
File::async_read
    ↓
WaitBlockingRead (Future)
    ↓ (poll 循环)
INodeInterface::readat
    ↓
├── Ext4FileSystem::readat (块设备)
├── RamFs::readat (内存)
├── DevFS::readat (设备)
└── Pipe::readat (管道)
```

---

## 5. 构建与测试

### 5.1 构建过程

```bash
make build-riscv    # 构建 RISC-V 内核
make build-loongarch # 构建 LoongArch 内核
```

构建使用 `--offline` 模式，依赖从 `vendor/` 目录加载。RISC-V 目标生成二进制镜像（`kernel-rv`），LoongArch 目标生成 ELF 文件（`kernel-la`）。

### 5.2 测试结果

由于当前环境缺少 RISC-V 和 LoongArch 的 QEMU 系统模拟器（需验证），未能进行完整的运行时测试。但通过代码审查发现：

1. **编译可行性**：项目使用 vendored 依赖和 nightly 工具链，构建配置完整。
2. **代码质量**：存在大量调试代码和注释掉的代码，影响代码整洁度。
3. **潜在问题**：
   - 多处 `unsafe` 代码块缺乏充分的安全注释
   - 硬编码地址范围（如栈、堆、TLS 区域）降低可移植性
   - 部分 `todo!()` 和 `unimplemented!()` 宏可能导致运行时 panic

---

## 6. 创新性分析

### 6.1 异步调度模型

MonkeyOS 的核心创新在于使用 Rust 的 `async/await` 机制实现内核调度。这种设计：
- **优点**：代码简洁，类型安全，避免手动上下文切换
- **缺点**：协作式调度无法保证实时性，不适合硬实时场景

### 6.2 多架构支持

通过 `polyhal` HAL 层实现 RISC-V 和 LoongArch 双架构支持，包括：
- 统一的页表抽象
- 统一的中断处理接口
- 架构特定的 PCI 枚举（LoongArch）

### 6.3 动态链接支持

支持 musl 和 glibc 两种 C 库的动态链接，通过 ELF 解释器段自动检测并加载相应的动态链接器。

### 6.4 任务模板缓存

`TaskCacheTemplate` 机制可预加载常用程序的 ELF 段到内存，后续 `exec` 时直接复制映射，减少磁盘 I/O。

---

## 7. 项目完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 进程管理 | 85% | fork/clone/execve/wait4 完整，但缺少进程组、会话管理 |
| 内存管理 | 75% | COW、mmap 基本可用，但权限控制粗糙，堆固定大小 |
| 文件系统 | 80% | VFS 层次完整，ext4/ramfs/devfs/procfs 可用，但错误处理不完善 |
| 驱动 | 70% | VirtIO 块/网可用，输入驱动未实现，多核未启用 |
| 网络 | 70% | TCP/UDP 基本可用，但 IP 硬编码，无 DNS 支持 |
| 信号 | 85% | 标准信号和实时信号均支持，处理流程完整 |
| IPC | 75% | 共享内存、管道完整，信号量/消息队列为简化实现 |
| 系统调用 | 80% | 覆盖 100+ 调用，但部分为 stub |
| 调度器 | 60% | 协作式调度，无抢占，无优先级，Waker 为空实现 |

**总体完整度**：约 75%（以 Linux 兼容内核为基准）

---

## 8. 总结

MonkeyOS 是一个功能较为完整的 Rust 操作系统内核，具备进程管理、内存管理、文件系统、网络、信号处理、IPC 等核心子系统。项目基于 ByteOS 进行了大量扩展，特别是在动态链接支持、多架构适配、IPC 机制等方面有显著增强。

**主要优点**：
1. 代码结构清晰，模块化程度高
2. 利用 Rust 类型系统和异步机制提升安全性和代码简洁度
3. 系统调用覆盖面广，Linux 兼容性较好
4. 支持 RISC-V 和 LoongArch 双架构

**主要不足**：
1. 调度器为纯协作式，缺乏抢占能力
2. 内存权限控制粗糙（统一 URWX）
3. 大量调试代码未清理
4. 多核支持未启用
5. 部分驱动（VirtIO Input）功能未实现
6. 硬编码地址范围降低可移植性