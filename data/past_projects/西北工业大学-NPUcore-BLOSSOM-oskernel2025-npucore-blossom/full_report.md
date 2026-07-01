# NPUcore-BLOSSOM OS内核项目技术报告

## 1. 项目概述

**NPUcore-BLOSSOM** 是由西北工业大学团队开发的操作系统内核项目，参加 OSKernel2025 竞赛。该项目基于此前的 NPUcore-lwext4 框架迭代升级，使用 Rust 语言编写，同时支持 **RISC-V 64** 和 **LoongArch 64** 两种指令集架构。项目总代码量约 **36,000 行 Rust 代码**（不含汇编和依赖库），分布在约 **170 个源文件**中。

---

## 2. 项目结构分析

### 2.1 顶层目录结构

```
OSKernel2025-NPUcore-BLOSSOM/
├── Makefile              # 顶层构建入口
├── README.md             # 项目说明
├── 决赛设计文档.pdf       # 设计文档
├── os/                   # 内核主体（Rust 项目）
├── user/                 # 用户态程序
├── apps/                 # 扩展应用（kilo编辑器、tetris游戏）
├── bootloader/           # 引导固件
├── dependency/           # 本地依赖库
└── util/                 # 工具（mkimage、QEMU 2K1000）
```

### 2.2 内核源码结构

```
os/src/
├── main.rs               # 内核入口（约 150 行）
├── hal/                  # 硬件抽象层
│   ├── arch/
│   │   ├── riscv/        # RISC-V 架构实现
│   │   └── loongarch64/  # LoongArch64 架构实现
│   └── platform/         # 板级支持包
├── mm/                   # 内存管理（约 3,500 行）
├── task/                 # 进程/线程管理（约 4,000 行）
├── fs/                   # 文件系统（约 8,000 行）
├── net/                  # 网络子系统（约 2,000 行）
├── syscall/              # 系统调用（约 3,000 行）
├── drivers/              # 设备驱动（约 1,000 行）
├── timer.rs              # 定时器管理（366 行）
├── console.rs            # 控制台输出
├── utils/                # 工具模块
└── math/                 # 数学辅助
```

---

## 3. 子系统详细分析

### 3.1 硬件抽象层 (HAL)

#### 3.1.1 架构设计

HAL 层采用 **架构抽象 + 板级支持** 的分层设计：

```
hal/
├── arch/
│   ├── mod.rs            # 架构选择（通过 feature 切换）
│   ├── riscv/            # RISC-V 实现
│   │   ├── mod.rs        # 模块导出
│   │   ├── sv39.rs       # Sv39 页表实现
│   │   ├── trap/         # 异常/中断处理
│   │   ├── switch.rs     # 上下文切换
│   │   ├── sbi.rs        # SBI 调用封装
│   │   └── config.rs     # 架构配置
│   └── loongarch64/      # LoongArch64 实现
│       ├── mod.rs        # 模块导出
│       ├── laflex.rs     # 灵活页表实现
│       ├── trap/         # 异常/中断处理
│       ├── register/     # CSR 寄存器定义
│       └── tlb.rs        # TLB 管理
└── platform/
    ├── riscv/
    │   ├── qemu.rs       # QEMU virt 板级
    │   ├── visionfive2.rs # VisionFive2 开发板
    │   ├── fu740.rs      # Fu740 SoC
    │   └── k210.rs       # K210 SoC
    └── loongarch64/
        ├── qemu.rs       # QEMU virt 板级
        └── 2k1000.rs     # 2K1000 开发板
```

#### 3.1.2 RISC-V 架构实现

**页表实现 (Sv39)**：

```rust
// os/src/hal/arch/riscv/sv39.rs
pub struct Sv39PageTable {
    root_ppn: PhysPageNum,
    frames: Vec<Arc<FrameTracker>>,
}

impl PageTable for Sv39PageTable {
    fn map(&mut self, vpn: VirtPageNum, ppn: PhysPageNum, flags: MapPermission) {
        let pte = self.find_pte_create(vpn).unwrap();
        *pte = Sv39PageTableEntry::new(ppn, PTEFlags::V | flags.into());
    }
    // ...
}
```

Sv39 采用三级页表结构，每级 9 位索引，支持 39 位虚拟地址空间。

**异常处理**：

```rust
// os/src/hal/arch/riscv/trap/mod.rs
pub fn trap_handler() -> ! {
    match scause.cause() {
        Trap::Exception(Exception::UserEnvCall) => {
            // 系统调用处理
            let result = syscall(cx.gp.a7, [cx.gp.a0, ...]);
            cx.gp.a0 = result as usize;
        }
        Trap::Exception(Exception::StorePageFault) | ... => {
            // 缺页异常处理
            task.vm.lock().do_page_fault(addr);
        }
        Trap::Interrupt(Interrupt::SupervisorTimer) => {
            // 时钟中断处理
            set_next_trigger();
            suspend_current_and_run_next();
        }
        // ...
    }
}
```

#### 3.1.3 LoongArch64 架构实现

**页表实现 (LAFlex)**：

LoongArch64 采用灵活的页表结构，支持 2-4 级页表：

```rust
// os/src/hal/arch/loongarch64/laflex.rs
pub struct LAFlexPageTable {
    root_ppn: LAPTRoot,
    frames: Vec<Arc<FrameTracker>>,
}

bitflags! {
    pub struct LAPTEFlagBits: usize {
        const V = 1 << 0;      // Valid
        const D = 1 << 1;      // Dirty
        const PLV0 = 0;        // Privilege Level 0
        const PLV3 = 3 << 2;   // Privilege Level 3 (User)
        const MAT_SUC = 0 << 4; // Strongly-ordered UnCached
        const MAT_CC = 1 << 4;  // Coherent Cached
        const W = 1 << 8;       // Writable
        const NR = 1 << 61;     // Not Readable
        const NX = 1 << 62;     // Not Executable
    }
}
```

**CSR 寄存器定义**：

项目为 LoongArch64 定义了完整的 CSR 寄存器访问接口，分为四类：
- **base/**：基础寄存器（CRMD、PRMD、ECFG、EENTRY、ESTAT 等）
- **mmu/**：MMU 相关（PGD、STLBPS、TLBIDX、PWCL/PWCH 等）
- **ras/**：可靠性相关（MERRCTL、MERRENTRY 等）
- **timer/**：定时器相关（TCFG、TVAL、TICLR 等）

#### 3.1.4 板级支持

| 板级 | 架构 | 内存大小 | 块设备 | 状态 |
|------|------|----------|--------|------|
| QEMU virt | RISC-V | 1024MB | VirtIO MMIO | 完整支持 |
| VisionFive2 | RISC-V | - | - | 部分支持 |
| Fu740 | RISC-V | - | - | 框架存在 |
| K210 | RISC-V | - | - | 框架存在 |
| QEMU virt | LoongArch64 | 256MB | SATA | 完整支持 |
| 2K1000 | LoongArch64 | - | SATA | 部分支持 |

---

### 3.2 内存管理子系统

#### 3.2.1 整体架构

```
mm/
├── mod.rs                # 模块导出与初始化
├── address.rs            # 地址类型定义（PhysAddr/VirtAddr/PhysPageNum/VirtPageNum）
├── frame_allocator.rs    # 物理页帧分配器
├── heap_allocator.rs     # 内核堆分配器
├── memory_set.rs         # 地址空间管理
├── map_area.rs           # 内存区域映射
├── page_table.rs         # 页表抽象接口
└── zram.rs               # 压缩内存（可选）
```

#### 3.2.2 物理页帧分配器

采用 **栈式帧分配器**（StackFrameAllocator）：

```rust
// os/src/mm/frame_allocator.rs
pub struct StackFrameAllocator {
    current: usize,           // 当前分配位置
    end: usize,               // 可分配区域末尾
    recycled: Vec<usize>,     // 已回收的页面列表
}

impl FrameAllocator for StackFrameAllocator {
    fn alloc(&mut self) -> Option<FrameTracker> {
        // 优先使用回收的帧
        if let Some(ppn) = self.recycled.pop() {
            Some(FrameTracker::new(ppn.into()))
        } else if self.current == self.end {
            None  // 无可用帧
        } else {
            self.current += 1;
            Some(FrameTracker::new((self.current - 1).into()))
        }
    }
}
```

**OOM 处理机制**：

```rust
#[cfg(feature = "oom_handler")]
pub fn oom_handler(req: usize) -> Result<(), ()> {
    // Step 1: 清理文件系统缓存
    released += fs::directory_tree::oom();
    
    // Step 2: 清理当前任务的内存
    if let Some(mut memory_set) = task.vm.try_lock() {
        released += memory_set.do_shallow_clean();
    }
    
    // Step 3: 清理所有任务的内存
    crate::task::do_oom(req - released)
}
```

#### 3.2.3 内核堆分配器

使用 `buddy_system_allocator` crate：

```rust
// os/src/mm/heap_allocator.rs
#[global_allocator]
static HEAP_ALLOCATOR: LockedHeap<32> = LockedHeap::empty();

static mut HEAP_SPACE: [u8; KERNEL_HEAP_SIZE] = [0; KERNEL_HEAP_SIZE];

pub fn init_heap() {
    unsafe {
        HEAP_ALLOCATOR.lock().init(HEAP_SPACE.as_ptr() as usize, KERNEL_HEAP_SIZE);
    }
}
```

#### 3.2.4 地址空间管理

**MemorySet 结构**：

```rust
// os/src/mm/memory_set.rs
pub struct MemorySet<T: PageTable> {
    page_table: T,              // 页表实现
    areas: Vec<MapArea>,        // 映射区域列表
}
```

**Frame 状态枚举**（支持 OOM 时）：

```rust
#[cfg(feature = "oom_handler")]
pub enum Frame {
    InMemory(Arc<FrameTracker>),    // 在内存中
    Compressed(Arc<ZramTracker>),   // 已压缩（zram）
    SwappedOut(Arc<SwapTracker>),   // 已换出到磁盘
    Unallocated,                     // 未分配（CoW）
}
```

#### 3.2.5 写时复制 (CoW)

项目实现了完整的写时复制机制：

```rust
// 在 fork 时，子进程共享父进程的物理页，但标记为只读
// 当写入时触发缺页异常，此时分配新页并复制内容
pub fn do_page_fault(&mut self, addr: VirtAddr) -> Result<(), MemoryError> {
    // 检查是否为 CoW 页面
    if !page_table.writable(vpn) && area.map_perm.contains(MapPermission::W) {
        // 分配新页并复制
        let new_frame = frame_alloc().unwrap();
        new_frame.ppn.get_bytes_array().copy_from_slice(old_frame.ppn.get_bytes_array());
        page_table.set_ppn(vpn, new_frame.ppn);
    }
}
```

#### 3.2.6 Zram 压缩内存

```rust
// os/src/mm/zram.rs
pub struct Zram {
    compressed: Vec<Option<Vec<u8>>>,  // 压缩数据存储
    recycled: Vec<u16>,                 // 回收的索引
    tail: u16,                          // 当前分配位置
}

impl Zram {
    pub fn write(&mut self, buf: &[u8]) -> Result<Arc<ZramTracker>, ZramError> {
        let mut compressed = compress_prepend_size(buf);  // LZ4 压缩
        compressed.shrink_to_fit();
        self.insert(compressed)
    }
    
    pub fn read(&mut self, zram_id: usize, buf: &mut [u8]) -> Result<(), ZramError> {
        let compressed_data = self.get(zram_id)?;
        let decompressed = decompress_size_prepended(compressed_data.as_slice()).unwrap();
        buf.copy_from_slice(decompressed.as_slice());
        Ok(())
    }
}
```

#### 3.2.7 Swap 交换分区

```rust
// os/src/fs/swap.rs
pub struct Swap {
    bitmap: Vec<u64>,       // 位图跟踪已使用的交换页
    block_ids: Vec<usize>,  // 交换分区块号列表
}

impl Swap {
    pub fn write(&mut self, buf: &[u8]) -> Arc<SwapTracker> {
        if let Some(swap_id) = self.alloc_page() {
            Self::write_page(self.get_block_ids(swap_id), buf);
            self.set_bit(swap_id);
            Arc::new(SwapTracker(swap_id))
        } else {
            panic!("Swap space exhausted!");
        }
    }
}
```

---

### 3.3 进程/线程管理子系统

#### 3.3.1 任务控制块 (TCB)

```rust
// os/src/task/task.rs
pub struct TaskControlBlock {
    // 不可变字段
    pub pid: PidHandle,           // 进程ID
    pub tid: usize,               // 线程ID
    pub tgid: usize,              // 线程组ID
    pub kstack: KernelStack,      // 内核栈
    pub ustack_base: usize,       // 用户栈基址
    pub exit_signal: Signals,     // 退出信号
    
    // 可变字段
    inner: Mutex<TaskControlBlockInner>,
    
    // 可共享字段
    pub exe: Arc<Mutex<FileDescriptor>>,      // 可执行文件
    pub tid_allocator: Arc<Mutex<RecycleAllocator>>,
    pub files: Arc<Mutex<FdTable>>,           // 文件描述符表
    pub socket_table: Arc<Mutex<SocketTable>>, // Socket表
    pub fs: Arc<Mutex<FsStatus>>,             // 文件系统状态
    pub vm: Arc<Mutex<MemorySet<PageTableImpl>>>, // 虚拟内存
    pub sighand: Arc<Mutex<Vec<Option<Box<SigAction>>>>>, // 信号处理
    pub futex: Arc<Mutex<Futex>>,             // Futex
}
```

#### 3.3.2 调度器

采用 **FIFO 调度算法**：

```rust
// os/src/task/manager.rs
pub struct TaskManager {
    pub ready_queue: VecDeque<Arc<TaskControlBlock>>,        // 就绪队列
    pub interruptible_queue: VecDeque<Arc<TaskControlBlock>>, // 可中断等待队列
    #[cfg(feature = "oom_handler")]
    pub active_tracker: ActiveTracker,  // 任务激活状态跟踪
}

impl TaskManager {
    pub fn add(&mut self, task: Arc<TaskControlBlock>) {
        self.ready_queue.push_back(task);
    }
    
    pub fn fetch(&mut self) -> Option<Arc<TaskControlBlock>> {
        self.ready_queue.pop_front()
    }
}
```

#### 3.3.3 任务状态

```rust
pub enum TaskStatus {
    Ready,          // 就绪
    Running,        // 运行中
    Interruptible,  // 可中断等待
    Zombie,         // 僵尸态
}
```

#### 3.3.4 进程创建与执行

**fork/clone 实现**：

```rust
// os/src/syscall/process.rs
pub fn sys_clone(flags: u32, stack: usize, ptid: usize, tls: usize, ctid: usize) -> isize {
    let task = current_task().unwrap();
    let new_task = task.clone_task(flags, stack, ptid, tls, ctid);
    add_task(new_task);
    new_task.pid.0 as isize
}
```

**execve 实现**：

```rust
pub fn sys_execve(path: *const u8, argv: *const usize, envp: *const usize) -> isize {
    let path = translated_str(token, path)?;
    let elf = ROOT_FD.open(&path, OpenFlags::O_RDONLY, false)?;
    let elf_info = load_elf(elf, &mut task.vm.lock())?;
    // 设置新的入口点和栈
}
```

#### 3.3.5 信号机制

支持完整的 POSIX 信号机制：

```rust
// os/src/task/signal.rs
bitflags! {
    pub struct Signals: u64 {
        const SIGHUP    = 1 << 0;
        const SIGINT    = 1 << 1;
        const SIGQUIT   = 1 << 2;
        const SIGILL    = 1 << 3;
        const SIGTRAP   = 1 << 4;
        const SIGABRT   = 1 << 5;
        const SIGBUS    = 1 << 6;
        const SIGFPE    = 1 << 7;
        const SIGKILL   = 1 << 8;
        const SIGUSR1   = 1 << 9;
        const SIGSEGV   = 1 << 10;
        // ... 共 64 个信号
        const SIGRTMAX  = 1 << 63;
    }
}

pub struct SigAction {
    pub handler: SigHandler,      // 处理函数
    pub flags: SigActionFlags,    // 标志位
    pub restorer: usize,          // 恢复函数地址
    pub mask: Signals,            // 信号掩码
}
```

#### 3.3.6 Futex 实现

```rust
// os/src/task/threads.rs
pub struct Futex {
    inner: BTreeMap<usize, WaitQueue>,  // 地址 -> 等待队列
}

impl Futex {
    pub fn wake(&mut self, futex_word_addr: usize, val: u32) -> isize {
        if let Some(mut wait_queue) = self.inner.remove(&futex_word_addr) {
            let ret = wait_queue.wake_at_most(val as usize);
            if !wait_queue.is_empty() {
                self.inner.insert(futex_word_addr, wait_queue);
            }
            ret as isize
        } else {
            0
        }
    }
}
```

---

### 3.4 文件系统子系统

#### 3.4.1 整体架构

```
fs/
├── mod.rs                # 模块导出
├── vfs.rs                # VFS 抽象层
├── directory_tree.rs     # 目录树管理
├── file_descriptor.rs    # 文件描述符
├── file_trait.rs         # File trait 定义
├── inode.rs              # Inode 抽象
├── cache.rs              # 块缓存/页缓存
├── poll.rs               # poll/select 支持
├── ext4/                 # EXT4 文件系统实现
│   ├── ext4fs.rs         # 文件系统主体
│   ├── superblock.rs     # 超级块
│   ├── block_group.rs    # 块组描述符
│   ├── extent.rs         # Extent 树
│   ├── ext4_inode.rs     # Inode 结构
│   ├── direntry.rs       # 目录项
│   ├── balloc.rs         # 块分配
│   ├── ialloc.rs         # Inode 分配
│   ├── bitmap.rs         # 位图操作
│   └── crc.rs            # CRC32 校验
├── fat32/                # FAT32 文件系统实现
│   ├── efs.rs            # 文件系统主体
│   ├── fat_inode.rs      # Inode
│   ├── dir_iter.rs       # 目录迭代器
│   └── bitmap.rs         # FAT 表
├── dev/                  # 设备文件
│   ├── pipe.rs           # 管道
│   ├── null.rs           # /dev/null
│   ├── zero.rs           # /dev/zero
│   ├── urandom.rs        # /dev/urandom
│   ├── hwclock.rs        # /dev/hwclock
│   ├── interrupts.rs     # /proc/interrupts
│   ├── tty.rs            # /dev/tty
│   └── socket.rs         # Socket 文件
└── swap.rs               # Swap 分区
```

#### 3.4.2 VFS 抽象层

```rust
// os/src/fs/vfs.rs
pub trait VFS: DowncastSync {
    fn close(&self) -> ();
    fn read(&self) -> Vec<u8>;
    fn write(&self, data: Vec<u8>) -> usize;
    fn alloc_blocks(&self, blocks: usize) -> Vec<usize>;
    fn get_filesystem_type(&self) -> FS_Type;
    fn block_size(&self) -> usize;
}

impl VFS {
    pub fn open_fs(block_device: Arc<dyn BlockDevice>, ...) -> Arc<Self> {
        let fs_type = pre_mount();  // 自动检测文件系统类型
        match fs_type {
            FS_Type::Fat32 => EasyFileSystem::open(block_device, ...),
            FS_Type::Ext4 => Arc::new(Ext4FileSystem::open_ext4rs(block_device, ...)),
            FS_Type::Null => panic!("no filesystem found"),
        }
    }
}
```

#### 3.4.3 目录树管理

```rust
// os/src/fs/directory_tree.rs
pub struct DirectoryTreeNode {
    spe_usage: Mutex<usize>,           // 特殊使用计数
    pub name: String,                   // 节点名称
    filesystem: Arc<FileSystem>,        // 文件系统实例
    pub file: Arc<dyn File>,            // 文件对象
    selfptr: Mutex<Weak<Self>>,         // 自引用
    father: Mutex<Weak<Self>>,          // 父节点引用
    children: RwLock<Option<BTreeMap<String, Arc<Self>>>>, // 子节点
}
```

#### 3.4.4 EXT4 文件系统实现

**超级块结构**：

```rust
// os/src/fs/ext4/superblock.rs
#[repr(C)]
pub struct Ext4Superblock {
    pub inodes_count: u32,
    pub blocks_count_lo: u32,
    pub free_blocks_count_lo: u32,
    pub free_inodes_count: u32,
    pub first_data_block: u32,
    pub log_block_size: u32,
    pub blocks_per_group: u32,
    pub inodes_per_group: u32,
    pub magic: u16,              // 0xEF53
    pub inode_size: u16,
    pub features_compatible: u32,
    pub features_incompatible: u32,
    pub features_read_only: u32,
    // ... 完整 EXT4 超级块字段
}
```

**Extent 树实现**：

```rust
// os/src/fs/ext4/extent.rs
#[repr(C)]
pub struct Ext4ExtentHeader {
    pub magic: u16,              // 0xF30A
    pub entries_count: u16,
    pub max_entries_count: u16,
    pub depth: u16,
    pub generation: u32,
}

#[repr(C)]
pub struct Ext4Extent {
    pub first_block: u32,        // 起始逻辑块号
    pub block_count: u16,        // 块数量
    pub start_hi: u16,           // 物理块号高位
    pub start_lo: u32,           // 物理块号低位
}
```

**文件打开流程**：

```rust
// os/src/fs/ext4/ext4fs.rs
pub fn generic_open(&self, path: &str, parent_inode_num: &mut u32, 
                    create: bool, ftype: u16, name_off: &mut u32) -> Result<u32, isize> {
    loop {
        // 跳过斜杠
        while search_path.starts_with('/') { ... }
        
        // 解析路径组件
        let len = path_check(search_path, &mut is_goal);
        let current_path = &search_path[..len];
        
        // 查找目录项
        let r = self.dir_find_entry(*parent, current_path, &mut dir_search_result);
        
        match r {
            Ok(_) => { /* 找到，继续或返回 */ }
            Err(errno) => {
                if create {
                    // 创建新 inode
                    let new_inode_ref = self.create(*parent, current_path, inode_mode)?;
                }
            }
        }
    }
}
```

#### 3.4.5 FAT32 文件系统实现

```rust
// os/src/fs/fat32/efs.rs
pub struct EasyFileSystem {
    pub block_device: Arc<dyn BlockDevice>,
    pub fat: Fat,                    // FAT 表
    pub data_area_start: usize,      // 数据区起始
    pub cluster_size: usize,         // 簇大小
    // ...
}
```

#### 3.4.6 块缓存管理

```rust
// os/src/fs/cache.rs
pub struct BlockCacheManager {
    _hold: Vec<Arc<FrameTracker>>,           // 持有的物理页
    cache_pool: Vec<Arc<Mutex<BufferCache>>>, // 缓存池
}

impl BlockCacheManager {
    pub fn get_block_cache(&self, block_id: usize, block_device: &Arc<dyn BlockDevice>) 
        -> Arc<Mutex<BufferCache>> 
    {
        match self.try_get_block_cache(block_id) {
            Some(block_cache) => block_cache,
            None => {
                let buffer_cache = self.alloc_buffer_cache(block_device);
                buffer_cache.lock().read_block(block_id, block_device);
                buffer_cache
            }
        }
    }
}
```

---

### 3.5 网络子系统

#### 3.5.1 整体架构

```
net/
├── mod.rs                # 模块导出与 Socket trait
├── config.rs             # 网络接口配置
├── address.rs            # 地址转换
├── tcp.rs                # TCP Socket 实现
├── udp.rs                # UDP Socket 实现
└── unix.rs               # Unix Domain Socket（部分实现）
```

#### 3.5.2 Socket 抽象

```rust
// os/src/net/mod.rs
pub trait Socket: File {
    fn bind(&self, addr: IpListenEndpoint) -> SyscallRet;
    fn listen(&self) -> SyscallRet;
    fn connect(&self, addr_buf: &[u8]) -> SyscallRet;
    fn accept(&self, sockfd: u32, addr: usize, addrlen: usize) -> SyscallRet;
    fn socket_type(&self) -> SocketType;
    fn recv_buf_size(&self) -> usize;
    fn send_buf_size(&self) -> usize;
    fn shutdown(&self, how: u32) -> GeneralRet<()>;
    fn set_nagle_enabled(&self, enabled: bool) -> SyscallRet;
    fn set_keep_alive(&self, enabled: bool) -> SyscallRet;
}
```

#### 3.5.3 TCP Socket 实现

基于 `smoltcp` 协议栈：

```rust
// os/src/net/tcp.rs
pub struct TcpSocket {
    inner: Mutex<TcpSocketInner>,
    socket_handler: SocketHandle,
}

impl Socket for TcpSocket {
    fn listen(&self) -> SyscallRet {
        let local = self.inner.lock().local_endpoint;
        NET_INTERFACE.tcp_socket(self.socket_handler, |socket| {
            socket.listen(local).ok().ok_or(SyscallErr::EADDRINUSE)
        })?;
        Ok(0)
    }
    
    fn connect(&self, addr_buf: &[u8]) -> SyscallRet {
        let remote_endpoint = address::endpoint(addr_buf)?;
        self._connect(remote_endpoint)?;
        loop {
            let state = NET_INTERFACE.tcp_socket(self.socket_handler, |socket| socket.state());
            match state {
                tcp::State::Established => return Ok(0),
                tcp::State::Closed => self._connect(remote_endpoint)?,
                _ => {}
            }
            suspend_current_and_run_next();
        }
    }
}
```

#### 3.5.4 Unix Domain Socket

```rust
// os/src/net/unix.rs
pub struct UnixSocket<const N: usize> {
    read_end: Arc<Pipe>,
    write_end: Arc<Pipe>,
}

pub fn make_unix_socket_pair<const N: usize>() -> (Arc<UnixSocket<N>>, Arc<UnixSocket<N>>) {
    let (read1, write1) = make_pipe();
    let (read2, write2) = make_pipe();
    let socket1 = Arc::new(UnixSocket::new(read1, write2));
    let socket2 = Arc::new(UnixSocket::new(read2, write1));
    (socket1, socket2)
}
```

**注意**：UnixSocket 的大部分 File trait 方法仍为 `todo!()` 状态，实现不完整。

---

### 3.6 系统调用子系统

#### 3.6.1 系统调用列表

项目实现了约 **90+ 个系统调用**，涵盖以下类别：

| 类别 | 系统调用 |
|------|----------|
| **文件系统** | getcwd, dup, dup2, dup3, fcntl, ioctl, mkdirat, unlinkat, linkat, mount, umount2, statfs, faccessat, chdir, openat, close, pipe2, getdents64, lseek, read, write, readv, writev, pread, pwrite, sendfile, splice, pselect6, ppoll, readlinkat, fstatat, fstat, ftruncate, fsync, utimensat, renameat2, statx, faccessat2, copy_file_range |
| **进程管理** | exit, exit_group, set_tid_address, futex, set_robust_list, get_robust_list, nanosleep, getitimer, setitimer, clock_gettime, clock_nanosleep, yield, kill, tkill, tgkill, sigaction, sigprocmask, sigtimedwait, sigreturn, times, setpgid, getpgid, setsid, uname, getrusage, umask, getpid, getppid, getuid, geteuid, getgid, getegid, gettid, sysinfo, clone, execve, wait4, prlimit |
| **内存管理** | sbrk, brk, mmap, munmap, mprotect, msync, madvise |
| **网络** | socket, socketpair, bind, listen, accept, connect, getsockname, getpeername, sendto, recvfrom, setsockopt, getsockopt, shutdown |
| **其他** | getrandom, membarrier, syslog |

#### 3.6.2 系统调用分发

```rust
// os/src/syscall/mod.rs
pub fn syscall(syscall_id: usize, args: [usize; 6]) -> isize {
    match syscall_id {
        SYSCALL_GETCWD => sys_getcwd(args[0], args[1]),
        SYSCALL_DUP => sys_dup(args[0]),
        SYSCALL_OPENAT => sys_openat(args[0], args[1] as *const u8, args[2] as u32, args[3] as u32),
        SYSCALL_READ => sys_read(args[0], args[1], args[2]),
        SYSCALL_WRITE => sys_write(args[0], args[1], args[2]),
        SYSCALL_CLONE => sys_clone(args[0] as u32, args[1], args[2], args[3], args[4]),
        SYSCALL_EXECVE => sys_execve(args[0] as *const u8, args[1] as *const usize, args[2] as *const usize),
        SYSCALL_MMAP => sys_mmap(args[0], args[1], args[2] as u32, args[3] as u32, args[4] as i32, args[5]),
        // ...
        _ => {
            error!("Unsupported syscall: {}", syscall_id);
            ENOSYS
        }
    }
}
```

#### 3.6.3 mmap 实现

```rust
// os/src/syscall/process.rs
pub fn sys_mmap(start: usize, len: usize, prot: u32, flags: u32, fd: i32, offset: usize) -> isize {
    let task = current_task().unwrap();
    let mut vm = task.vm.lock();
    
    let map_perm = MapPermission::from_bits(prot).unwrap();
    let map_flags = MapFlags::from_bits(flags).unwrap();
    
    if map_flags.contains(MapFlags::MAP_ANONYMOUS) {
        // 匿名映射
        vm.insert_framed_area(start_va, end_va, map_perm);
    } else {
        // 文件映射
        let file = fd_table.get_ref(fd as usize)?;
        vm.mmap_file(start_va, len, map_perm, file, offset)?;
    }
    
    start as isize
}
```

---

### 3.7 设备驱动子系统

#### 3.7.1 块设备驱动

```
drivers/block/
├── mod.rs              # 块设备抽象
├── block_dev.rs        # BlockDevice trait
├── virtio_blk.rs       # VirtIO MMIO 块设备
├── virtio_blk_pci.rs   # VirtIO PCI 块设备
├── sata_blk.rs         # SATA 块设备（LoongArch）
└── mem_blk.rs          # 内存块设备
```

**VirtIO 块设备实现**：

```rust
// os/src/drivers/block/virtio_blk.rs
pub struct VirtIOBlock(Mutex<VirtIOBlk<VirtioHal, MmioTransport<'static>>>);

impl BlockDevice for VirtIOBlock {
    fn read_block(&self, block_id: usize, buf: &mut [u8]) {
        for (i, chunk) in buf.chunks_mut(VIRT_IO_BLOCK_SZ).enumerate() {
            let virtio_block_id = block_id * BLOCK_RATIO + i;
            self.0.lock().read_blocks(virtio_block_id, chunk)
                .expect("Error when reading VirtIOBlk");
        }
    }
    
    fn write_block(&self, block_id: usize, buf: &[u8]) {
        for (i, chunk) in buf.chunks(VIRT_IO_BLOCK_SZ).enumerate() {
            let virtio_block_id = block_id * BLOCK_RATIO + i;
            self.0.lock().write_blocks(virtio_block_id, chunk)
                .expect("Error when writing VirtIOBlk");
        }
    }
}
```

#### 3.7.2 串口驱动

```rust
// os/src/drivers/serial/ns16550a.rs
pub struct NS16550A {
    base_address: usize,
}

impl NS16550A {
    pub fn putchar(&self, c: u8) {
        // 等待发送缓冲区空
        while (self.read_reg(LSR) & 0x20) == 0 {}
        self.write_reg(THR, c);
    }
    
    pub fn getchar(&self) -> Option<u8> {
        if (self.read_reg(LSR) & 0x01) != 0 {
            Some(self.read_reg(RBR))
        } else {
            None
        }
    }
}
```

---

### 3.8 定时器子系统

```rust
// os/src/timer.rs
pub struct TimeSpec {
    pub tv_sec: usize,   // 秒
    pub tv_nsec: usize,  // 纳秒
}

pub struct TimeVal {
    pub tv_sec: usize,   // 秒
    pub tv_usec: usize,  // 微秒
}

pub struct ITimerVal {
    pub it_interval: TimeVal,  // 定时器间隔
    pub it_value: TimeVal,     // 当前值
}
```

支持三种定时器：
- **ITIMER_REAL**：实时定时器，发送 SIGALRM
- **ITIMER_VIRTUAL**：虚拟定时器，发送 SIGVTALRM
- **ITIMER_PROF**：性能分析定时器，发送 SIGPROF

---

## 4. 构建与测试

### 4.1 构建系统

项目使用 Cargo + Make 混合构建：

```bash
# RISC-V 构建
make rv64-only BLK_MODE=virt

# LoongArch64 构建
make la64-only

# 运行（RISC-V QEMU）
make rv64-run
```

**Cargo Feature 配置**：

```toml
[features]
# 架构选择
riscv = []
loongarch64 = []

# 板级选择
board_rvqemu = ["oom_handler", "riscv"]
board_visionfive2 = ["oom_handler", "riscv"]
board_laqemu = ["oom_handler", "loongarch64"]
board_2k1000 = ["oom_handler", "loongarch64"]

# 块设备模式
block_virt = []
block_sata = []
block_mem = []

# 内存管理特性
swap = []
zram = []
oom_handler = ["swap", "zram"]
```

### 4.2 测试结果

由于项目依赖特定的文件系统镜像（sdcard-rv.img / sdcard-la.img）和测试套件（testsuits-for-oskernel），在当前环境中无法完整运行测试。

**构建测试**：
- RISC-V 目标：需要 `riscv64gc-unknown-none-elf` 工具链
- LoongArch64 目标：需要 `loongarch64-unknown-none` 工具链

---

## 5. 子系统完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **硬件抽象层** | 85% | RISC-V 和 LoongArch64 双架构支持完整，部分板级支持不完整 |
| **内存管理** | 90% | 物理/虚拟内存管理、CoW、Swap、Zram 均已实现 |
| **进程/线程管理** | 85% | 进程创建/销毁、线程、信号、Futex 均已实现，调度器较简单 |
| **文件系统** | 80% | EXT4 和 FAT32 双文件系统支持，VFS 层完整，部分高级功能缺失 |
| **网络** | 70% | TCP/UDP 基于 smoltcp 实现完整，Unix Socket 不完整 |
| **系统调用** | 85% | 90+ 个系统调用，覆盖主要 POSIX 接口 |
| **设备驱动** | 75% | VirtIO 块设备、NS16550A 串口完整，其他驱动较少 |

---

## 6. 设计创新性分析

### 6.1 双架构支持

项目同时支持 RISC-V 和 LoongArch64 两种架构，通过 HAL 层抽象实现代码复用。LoongArch64 的 CSR 寄存器定义和灵活页表实现较为完整。

### 6.2 OOM 处理机制

实现了完整的内存不足处理流程：
1. 清理文件系统缓存
2. 清理当前任务内存
3. 遍历所有任务进行深度/浅度清理
4. 支持 Zram 压缩和 Swap 换出

### 6.3 目录树缓存

采用 `DirectoryTreeNode` 结构缓存目录树，支持懒加载和按需刷新，提高文件系统访问效率。

### 6.4 写时复制 (CoW)

在 fork 时实现 CoW，减少内存拷贝开销。

---

## 7. 项目优缺点总结

### 7.1 优点

1. **双架构支持**：同时支持 RISC-V 和 LoongArch64，架构抽象设计合理
2. **内存管理完善**：CoW、Swap、Zram、OOM 处理机制完整
3. **文件系统双支持**：EXT4 和 FAT32 双文件系统，VFS 层设计清晰
4. **信号机制完整**：支持 64 个信号，包括实时信号
5. **代码注释丰富**：关键模块有详细的中文注释

### 7.2 缺点

1. **调度器简单**：仅实现 FIFO 调度，缺乏优先级和时间片轮转
2. **Unix Socket 不完整**：大部分方法为 `todo!()` 状态
3. **单核支持**：未实现 SMP 多核支持
4. **部分板级支持不完整**：VisionFive2、Fu740、K210 等板级仅有框架
5. **错误处理不统一**：部分地方使用 `panic!`，部分使用 `Result`

---

## 8. 总结

NPUcore-BLOSSOM 是一个功能较为完整的操作系统内核项目，在内存管理、文件系统、进程管理等核心子系统上实现了较高的完成度。项目的双架构支持是一个亮点，LoongArch64 的实现较为完整。整体代码量约 36,000 行，结构清晰，模块划分合理。

**整体完成度评估：约 80%**

主要缺失功能：
- SMP 多核支持
- 完整的 Unix Domain Socket
- 高级调度算法
- 更多的设备驱动
- 完整的网络协议栈（如 ICMP、ARP 等）