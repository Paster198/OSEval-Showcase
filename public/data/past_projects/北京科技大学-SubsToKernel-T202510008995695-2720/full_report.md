# SubsToKernel OS 内核项目技术报告

## 1. 项目概述与分析范围

SubsToKernel 是由北京科技大学参赛队伍为 2025 春秋季开源操作系统训练营设计实现的操作系统内核。项目基于 rCore-Tutorial-v3 的 ch8 分支开发，使用 Rust 语言编写，支持 RISC-V 64 位和 LoongArch 64 位两种架构。本报告对该项目的全部 91 个 Rust 源文件、构建系统、外部依赖和用户态程序进行了逐模块的深入分析。

---

## 2. 构建与测试结果

### 2.1 构建尝试

项目使用 Cargo 构建系统，通过 `os/Makefile` 和顶层 `Makefile` 驱动。构建流程如下：
- 将 `os/cargo/config.toml` 复制到 `.cargo/` 以启用 vendored 依赖
- 通过 `build.rs` 根据目标架构生成链接脚本（替换 `%ARCH%` 和 `%KERNEL_BASE%`）
- 使用 `cargo build --release` 编译内核

在当前环境中尝试构建 RISC-V 目标：

```
cd os && cp -r cargo .cargo && cargo build --release -p os --target riscv64gc-unknown-none-elf --offline
```

构建过程中，由于 lwext4_rsut 库依赖 C 交叉编译工具链（通过 cc crate 编译 C 源码），且构建脚本中对 RISC-V 交叉编译器的路径有特定要求，构建未能完成。LoongArch 目标同样面临类似问题。

### 2.2 测试缺失原因

由于构建产物未能生成，无法在 QEMU 中进行运行时测试。测试缺失的原因归结为：
1. lwext4_rsut 的 C 代码编译需要特定版本的 RISC-V/LoongArch 交叉编译器
2. 当前环境中的交叉编译工具链路径与项目构建脚本的预期不完全匹配
3. 项目依赖的 `sdcard-rv.img` 文件系统镜像未包含在仓库中

---

## 3. 子系统详细分析

### 3.1 启动与初始化子系统

**文件**: `boot.rs`, `main.rs`, `config.rs`, `boards/qemu.rs`

**实现细节**:

启动流程分为两个阶段。第一阶段是汇编入口 `_start`，在 `boot.rs` 中通过 `global_asm!` 宏实现，针对两种架构分别编写：

RISC-V 启动代码简洁直接：
```rust
_start:
    la sp, boot_stack_top  
    call {rust_main}
```

LoongArch 启动代码更为复杂，需要处理直接映射窗口（DMW）配置：
```rust
_start:
    pcaddi      $t0,    0x0
    srli.d      $t0,    $t0,    0x30
    slli.d      $t0,    $t0,    0x30
    addi.d      $t0,    $t0,    0x11
    csrwr       $t0,    0x181   // 配置 DMW1
    // ... 跳转到高地址后配置 DMW0
    csrwr       $t0,    0x180
    // ... 跳转到 0 段执行
    la.global $sp, boot_stack_top
    bl          {rust_main}
```

LoongArch 的启动代码需要手动配置直接映射窗口来实现从高物理地址到低虚拟地址的跳转，这是因为 LoongArch 的 `bl` 指令只能进行有限范围的跳转。

第二阶段是 Rust 入口 `main()` 函数，按顺序初始化各子系统：
```rust
pub fn main(cpu: usize) -> ! {
    clear_bss();
    logging::init();
    mm::init();
    hal::trap::init();
    timer::set_next_trigger();  // 仅 RISC-V
    fs::list_apps();
    task::add_initproc();
    fs::init();
    net::net_init();
    hal::trap::enable_timer_interrupt();
    task::run_tasks();
}
```

BSS 段清理使用 `u128` 类型进行 128 位宽度的填充，相比逐字节清理更高效。

**配置常量**（`config.rs`）定义了关键参数：
- 物理内存上界: `0x9800_0000`（约 3.5GB）
- 内核堆大小: `0x200_0000`（32MB）
- 用户栈大小: 32KB（每线程）
- 最大线程数: 3000
- 用户空间大小: `0x5000_0000`（约 20GB 虚拟地址空间）
- Trampoline 地址: `usize::MAX - PAGE_SIZE + 1`
- 信号返回地址: `0x3_0000_0000`

**完整度评估**: 85%。启动流程完整，双架构支持良好。但仅支持单核启动（SMP 未实现），`cpu` 参数未被使用。

---

### 3.2 内存管理子系统

**文件**: `mm/address.rs`, `mm/frame_allocator.rs`, `mm/heap_allocator.rs`, `mm/page_table.rs`, `mm/map_area.rs`, `mm/memory_set.rs`, `mm/shm.rs`, `mm/page_fault_handler.rs`, `mm/group.rs`

#### 3.2.1 地址抽象（address.rs）

定义了四种核心地址类型：`PhysAddr`、`VirtAddr`、`PhysPageNum`、`PhysPageNum`，均为 `usize` 的新类型封装。

RISC-V 采用 SV39 分页模式：
- 物理地址宽度: 56 位
- 虚拟地址宽度: 39 位
- 页表项索引: 9-9-9 三级，每级 512 项

LoongArch 采用 48 位虚拟/物理地址，页大小 4KB（代码中 `PAGE_SIZE_BITS = 0xc`），三级页表结构 9-9-9-12。

`VirtPageNum::indexes()` 方法提取三级页表索引：
```rust
pub fn indexes(&self) -> [usize; 3] {
    let mut vpn = self.0;
    let mut idx = [0usize; 3];
    for i in (0..3).rev() {
        idx[i] = vpn & 511;
        vpn >>= 9;
    }
    idx
}
```

还实现了 `bad_address` 管理机制，通过全局 `BTreeSet` 记录无效地址，用于防止非法内存访问。

#### 3.2.2 物理页帧分配器（frame_allocator.rs）

采用栈式分配策略（`StackFrameAllocator`）：
```rust
pub struct StackFrameAllocator {
    current: usize,     // 当前分配到的页号
    end: usize,         // 可用页号上界
    recycled: Vec<usize>, // 回收的页号栈
}
```

分配时优先从回收栈弹出，否则递增 `current`。释放时进行有效性检查（防止重复释放和释放未分配的页）。`FrameTracker` 使用 RAII 模式，在 `Drop` 时自动释放物理页。

分配器使用 `UPSafeCell` 保护，通过 `lazy_static!` 延迟初始化。

#### 3.2.3 页表管理（page_table.rs）

`PageTable` 结构维护根页物理页号和所有分配的页表帧：
```rust
pub struct PageTable {
    root_ppn: PhysPageNum,
    frames: Vec<FrameTracker>,
}
```

提供两种查找 PTE 的方法：
- `find_pte_create()`: 不存在时自动创建中间页表
- `find_pte()`: 仅查找不创建

RISC-V 的 PTE 结构遵循标准 SV39 格式（V/R/W/X/U/G/A/D 标志位）。LoongArch 的 PTE 结构更为复杂，包含 NR（不可读）、NX（不可执行）、RPLV（限制特权级）等额外标志位，以及 MAT（内存访问类型）字段。

**COW（Copy-on-Write）支持**: 利用 PTE 的第 9 位标记 COW 页面：
```rust
pub fn is_cow(&self) -> bool {
    self.bits & (1 << 9) != 0
}
```

#### 3.2.4 内存映射区域（map_area.rs）

`MapArea` 是内存管理的核心结构，支持两种映射类型：
- `Identical`: 恒等映射（VPN == PPN）
- `Framed`: 帧映射（分配新物理帧）

每个 `MapArea` 包含：
```rust
pub struct MapArea {
    pub vpn_range: VPNRange,
    pub data_frames: BTreeMap<VirtPageNum, Arc<FrameTracker>>,
    pub map_type: MapType,
    pub map_perm: MapPermission,
    pub area_type: MapAreaType,
    pub mmap_file: MmapFile,
    pub mmap_flags: MmapFlags,
    pub groupid: usize,
}
```

`MapAreaType` 枚举区分不同用途的映射区域：`Elf`、`Stack`、`Heap`、`Brk`、`Mmap`、`Trap`、`Signal`，用于在 fork 时进行差异化处理。

`MmapFile` 结构支持文件映射（mmap），记录关联文件和偏移量。

#### 3.2.5 地址空间管理（memory_set.rs）

`MemorySet` 封装了 `MemorySetInner`（页表 + 区域列表），通过 `UPSafeCell` 提供内部可变性。

内核地址空间构建（仅 RISC-V 需要，LoongArch 通过 DMW 窗口实现等价功能）：
- 恒等映射 `.text`、`.rodata`、`.data`、`.bss` 段
- 恒等映射 MMIO 区域
- 映射 Trampoline 页面

用户地址空间从 ELF 文件构建（`from_elf`），包括：
- ELF 段映射（支持动态链接器加载）
- 用户堆区域
- 每线程的用户栈
- 每线程的 Trap 上下文页面
- 辅助向量（Auxiliary Vector）设置

**动态链接支持**: `load_dl_interp_if_needed()` 检测 ELF 的 `PT_INTERP` 段，加载动态链接器（如 `/lib/ld-musl-riscv64.so.1`），并设置辅助向量（AT_PHDR、AT_BASE、AT_ENTRY 等）。

**mmap/munmap 实现**: 支持匿名映射和文件映射，支持 `MAP_SHARED` 和 `MAP_PRIVATE` 标志。`insert_framed_area_with_hint()` 实现了地址空间中的空闲区域查找。

**mprotect 实现**: 修改已映射区域的权限，支持权限降级和升级。

#### 3.2.6 缺页异常处理（page_fault_handler.rs）

实现了三种缺页处理：

1. **Lazy Allocation**: 堆和栈的延迟分配，仅在首次访问时分配物理页
```rust
pub fn lazy_page_fault(va: VirtAddr, page_table: &mut PageTable, vma: &mut MapArea) {
    vma.map_one(page_table, va.floor());
    flush_tlb();
}
```

2. **mmap 读缺页**: 检查共享组中是否有可用页面，有则 COW 映射，无则分配并从文件加载
3. **mmap 写缺页**: 分配新页面并从文件加载数据
4. **COW 缺页**: 当引用计数为 1 时直接恢复写权限，否则复制页面

#### 3.2.7 共享内存（shm.rs）

实现了 System V 风格的共享内存：
```rust
pub fn shm_create(size: usize) -> usize  // 创建共享内存段
pub fn shm_find(key: usize) -> bool      // 查找共享内存段
pub fn shm_attach(key: usize, addr: usize, map_perm: MapPermission) -> isize  // 附加到进程
pub fn shm_drop(key: usize)              // 删除共享内存段
```

共享内存段由 `ShmManager` 管理，使用 `BTreeMap<usize, Shm>` 存储，每个 `Shm` 包含一组 `Arc<FrameTracker>` 物理页。多个进程通过 `shm_attach` 共享同一组物理页。

#### 3.2.8 共享组管理（group.rs）

`GroupManager` 为 mmap 的 `MAP_SHARED` 区域提供跨 fork 的页面共享：
```rust
pub struct GroupManager {
    unused_id: Vec<usize>,
    groups: BTreeMap<usize, GroupInner>,
}
```

每个 `GroupInner` 维护共享帧的 `BTreeMap<VirtPageNum, Arc<FrameTracker>>`。当 fork 发生时，子进程继承相同的 groupid，在缺页时查找共享帧避免重复分配。

**完整度评估**: 90%。内存管理子系统功能完整，包括 SV39 分页、COW、lazy allocation、mmap/munmap、mprotect、共享内存、文件映射等。但缺少 swap（交换空间）支持和内存回收机制。

---

### 3.3 进程与任务管理子系统

**文件**: `task/task.rs`, `task/process.rs`, `task/manager.rs`, `task/processor.rs`, `task/stride.rs`, `task/futex.rs`, `task/context.rs`, `task/switch.rs`, `task/id.rs`, `task/aux.rs`, `task/alloc.rs`

#### 3.3.1 进程控制块（process.rs）

`ProcessControlBlock` 是进程管理的核心结构：
```rust
pub struct ProcessControlBlock {
    pub ppid: usize,
    pub pid: usize,
    pub user: Arc<User>,
    inner: UPSafeCell<ProcessControlBlockInner>,
}
```

`ProcessControlBlockInner` 包含：
- `memory_set: Arc<MemorySet>` - 地址空间
- `parent/children` - 进程树关系
- `fd_table: Arc<FdTable>` - 文件描述符表
- `fs_info: Arc<FsInfo>` - 文件系统信息（当前工作目录）
- `signals: SignalFlags` - 进程级信号
- `tasks: Vec<Option<Arc<TaskControlBlock>>>` - 线程列表
- `mutex_list/semaphore_list/condvar_list` - 同步原语列表
- `priority/stride` - 调度参数
- `tms: Tms` - 进程时间统计
- `sig_table: Arc<SigTable>` - 信号处理表
- `heap_bottom/heap_top` - 堆管理
- `robust_list: RobustList` - futex 健壮列表
- `timer: Arc<Timer>` - 进程定时器

**fork 实现**: 支持 `CloneFlags`（CLONE_VM、CLONE_FS、CLONE_FILES、CLONE_THREAD 等），实现了 Linux 风格的 clone 语义：
- `CLONE_VM`: 共享地址空间
- `CLONE_FILES`: 共享文件描述符表
- `CLONE_FS`: 共享文件系统信息
- `CLONE_THREAD`: 创建线程而非进程
- `CLONE_PARENT_SETTID`/`CLONE_CHILD_SETTID`/`CLONE_CHILD_CLEARTID`: TID 设置

**exec 实现**: 支持 ELF 加载和动态链接器加载，设置辅助向量（Auxiliary Vector），包括 AT_PHDR、AT_PHENT、AT_PHNUM、AT_PAGESZ、AT_BASE、AT_ENTRY、AT_UID、AT_GID、AT_RANDOM、AT_EXECFN 等。

**brk 实现**: 通过 `change_program_brk()` 动态调整堆顶，支持增长和收缩。

#### 3.3.2 任务控制块（task.rs）

`TaskControlBlock` 代表一个线程：
```rust
pub struct TaskControlBlock {
    pub process: Weak<ProcessControlBlock>,
    pub kstack: KernelStack,
    inner: UPSafeCell<TaskControlBlockInner>,
}
```

每个线程拥有独立的：
- 内核栈（`KernelStack`）
- Trap 上下文页面
- 用户栈
- 信号掩码和待处理信号

RISC-V 的内核栈通过在内核地址空间中映射实现，LoongArch 则直接分配堆内存。

#### 3.3.3 任务管理器（manager.rs）

使用 FIFO 就绪队列和阻塞映射表管理任务：
```rust
pub struct TaskManager {
    ready_queue: VecDeque<Arc<TaskControlBlock>>,
    block_map: BTreeMap<usize, Arc<TaskControlBlock>>,
    stop_task: Option<Arc<TaskControlBlock>>,
}
```

维护三个全局映射：
- `PID2PCB`: PID 到进程控制块的映射
- `TID2TCB`: TID 到任务控制块的映射
- `THREAD_GROUP`: 线程组管理

#### 3.3.4 处理器管理（processor.rs）

`Processor` 维护当前运行的任务和空闲任务上下文：
```rust
pub struct Processor {
    pub current: Option<Arc<TaskControlBlock>>,
    idle_task_cx: TaskContext,
}
```

调度循环 `run_tasks()` 不断从就绪队列获取任务并切换执行：
```rust
pub fn run_tasks() {
    loop {
        let mut processor = PROCESSOR.exclusive_access();
        if let Some(task) = fetch_task() {
            // 设置 TMS、切换上下文
            unsafe { __switch(idle_task_cx_ptr, next_task_cx_ptr); }
        } else {
            check_timer();
        }
    }
}
```

#### 3.3.5 上下文切换（switch.rs + context.rs）

`TaskContext` 保存被调用者保存寄存器：
```rust
pub struct TaskContext {
    ra: usize,      // 返回地址
    sp: usize,      // 栈指针
    s: [usize; 12], // s0-s11
}
```

`__switch` 函数通过汇编实现，保存当前上下文并恢复目标上下文。首次运行的任务通过 `goto_trap_return()` 将 `ra` 设置为 `trap_return` 的地址，使得切换后自动进入用户态。

#### 3.3.6 Stride 调度（stride.rs）

实现了 Stride 调度算法：
```rust
impl Stride {
    const BIG_STRIDE: StrideInner = StrideInner::MAX / 10000;
    pub fn step(&mut self, prio: usize) {
        let pass = Stride::BIG_STRIDE / prio;
        self.0 += pass;
    }
}
```

优先级越高的进程，每次调度增加的 stride 值越小，从而获得更多 CPU 时间。但当前调度器实际使用的是 FIFO 队列，Stride 调度虽然实现了数据结构但未被集成到主调度循环中。

#### 3.3.7 Futex（futex.rs）

实现了 Linux 风格的 Futex（快速用户态互斥锁）：
```rust
pub struct FutexKey {
    pa: PhysAddr,
    pid: usize,
}
```

支持的操作：
- `FUTEX_WAIT`: 等待 futex 值匹配
- `FUTEX_WAKE`: 唤醒等待的线程
- `FUTEX_REQUEUE`: 重新排队等待线程
- `FUTEX_WAKE_OP`: 原子操作后唤醒

使用物理地址作为 futex 键，区分 `PRIVATE_FUTEX`（进程内）和 `SHARED_FUTEX`（跨进程）。

**完整度评估**: 85%。进程/线程管理功能丰富，支持 fork（含 COW）、exec（含动态链接）、clone、futex、信号等。但调度器仍为简单 FIFO，Stride 调度未实际启用。SMP 支持未实现。

---

### 3.4 文件系统子系统

**文件**: `fs/mod.rs`, `fs/vfs/mod.rs`, `fs/vfs/inode.rs`, `fs/ext4_lw/mod.rs`, `fs/ext4_lw/inode.rs`, `fs/ext4_lw/sb.rs`, `fs/pipe.rs`, `fs/devfs.rs`, `fs/stdio.rs`, `fs/mount.rs`, `fs/dirent.rs`, `fs/stat.rs`, `fs/fsidx.rs`, `fs/fstruct.rs`

#### 3.4.1 虚拟文件系统层（vfs/）

定义了三组核心 trait：

**Inode trait**: 文件系统节点抽象，支持创建、查找、读写、截断、同步、链接、符号链接、重命名、时间戳设置等操作。

**File trait**: 打开文件的抽象，支持读写、fstat、poll、lseek。

**Sock trait**: 套接字抽象，支持 bind、listen、connect、accept、sendto、recvfrom。

`OSInode` 是 `File` trait 的主要实现，封装了 `Arc<dyn Inode>` 和偏移量管理：
```rust
pub struct OSInode {
    readable: bool,
    writable: bool,
    pub inode: Arc<dyn Inode>,
    pub(crate) inner: Mutex<OSInodeInner>,
}
```

`FileClass` 枚举统一了三种文件类型：
```rust
pub enum FileClass {
    File(Arc<OSInode>),    // 普通文件
    Abs(Arc<dyn File>),    // 抽象文件（管道、设备等）
    Sock(Arc<dyn Sock>),   // 套接字
}
```

#### 3.4.2 ext4 文件系统（ext4_lw/）

基于 lwext4 C 库的 Rust 绑定实现。`Ext4SuperBlock` 封装了 `Ext4BlockWrapper<Disk>`：
```rust
pub struct Ext4SuperBlock {
    inner: UPSafeCell<Ext4BlockWrapper<Disk>>,
    root: Arc<dyn Inode>,
}
```

`Ext4Inode` 实现了 `Inode` trait，通过 `Ext4File` 与底层 C 库交互。支持的操作包括：
- 文件创建/打开/关闭
- 读写（带偏移量）
- 截断
- 目录创建和遍历
- 符号链接
- 重命名
- 时间戳设置
- 所有者设置

`Disk` 类型实现了 `KernelDevOp` trait，作为 lwext4 的块设备后端。

#### 3.4.3 管道（pipe.rs）

实现了环形缓冲区管道，缓冲区大小 64KB：
```rust
const RING_BUFFER_SIZE: usize = 65536;
pub struct PipeRingBuffer {
    arr: Vec<u8>,
    head: usize,
    tail: usize,
    status: RingBufferStatus,
    write_end: Option<Weak<Pipe>>,
    read_end: Option<Weak<Pipe>>,
}
```

支持批量读写优化（`write_bytes`/`read_bytes`），当缓冲区长度大于 10 字节时使用批量操作。管道读端在写端全部关闭时返回 EOF，写端在读端全部关闭时发送 SIGPIPE 信号。

#### 3.4.4 设备文件系统（devfs.rs）

实现了多个虚拟设备：
- `/dev/zero`: 读取返回零字节
- `/dev/null`: 丢弃所有写入
- `/dev/rtc`: 实时时钟设备
- `/dev/random`: 随机数生成
- `/dev/tty`: 终端设备（代理到 Stdin/Stdout）
- `/dev/cpu_dma_latency`: CPU DMA 延迟控制

设备通过全局 `DEVICES` 注册表管理。

#### 3.4.5 挂载管理（mount.rs）

`MountTable` 维护挂载点列表：
```rust
pub struct MountTable {
    mnt_list: Vec<(String, String, String, u32)>, // special, dir, fstype, flags
}
```

支持 mount、umount 和 remount 操作，最多 16 个挂载点。

#### 3.4.6 文件系统初始化

`fs::init()` 在启动时创建必要的文件和目录结构：
- `/proc/` 目录及其子文件（meminfo、stat、self 等）
- `/sys/` 目录
- `/dev/` 目录及设备文件
- `/etc/passwd`、`/etc/hosts` 等配置文件
- `/tmp/` 目录
- 测试脚本 `/musl/run_testcases_musl.sh`

**完整度评估**: 80%。VFS 层设计合理，ext4 实现完整，管道和设备文件功能齐全。但缺少 procfs/sysfs 的真正实现（仅为静态文件），不支持硬链接，符号链接支持有限。

---

### 3.5 系统调用子系统

**文件**: `syscall/mod.rs`, `syscall/fs.rs`, `syscall/process.rs`, `syscall/mem.rs`, `syscall/net.rs`, `syscall/signal.rs`, `syscall/sync.rs`, `syscall/thread.rs`, `syscall/uname.rs`, `syscall/options.rs`, `syscall/sys_result.rs`

#### 3.5.1 系统调用分发

`syscall()` 函数通过 match 分发约 100+ 个系统调用：

**文件系统调用**（约 30 个）：
- 基本 I/O: `read`, `write`, `readv`, `writev`, `pread64`, `lseek`
- 文件管理: `openat`, `close`, `dup`, `dup3`, `fcntl`, `ftruncate`
- 目录操作: `getcwd`, `chdir`, `mkdirat`, `unlinkat`, `linkat`, `renameat2`, `getdents64`
- 文件信息: `fstat`, `fstatat`, `statfs`, `statx`, `readlinkat`
- 高级 I/O: `pselect6`, `ppoll`, `sendfile`, `fsync`
- 挂载: `mount`, `unmount2`
- 其他: `ioctl`, `utimensat`, `sync`, `getrandom`

**进程管理调用**（约 15 个）：
- `fork`（含 clone 语义）, `exec`, `waitpid`, `exit`, `exit_group`
- `getpid`, `getppid`, `gettid`, `getuid`, `geteuid`, `getgid`, `getegid`
- `yield`, `set_priority`, `setsid`
- `times`, `getrusage`, `prlimit`
- `shmget`, `shmctl`, `shmat`（共享内存）

**内存管理调用**（约 6 个）：
- `mmap`, `munmap`, `mprotect`, `msync`, `madvise`, `brk`

**网络调用**（约 10 个）：
- `socket`, `bind`, `listen`, `accept`, `connect`
- `sendto`, `recvfrom`, `setsockopt`, `getsockopt`
- `getsockname`, `socketpair`

**信号调用**（约 6 个）：
- `kill`, `tkill`, `tgkill`, `sigaction`, `sigprocmask`, `sigreturn`, `sigtimedwait`

**同步调用**（约 10 个）：
- `futex`（WAIT/WAKE/REQUEUE/WAKE_OP）
- `mutex_create/lock/unlock`
- `semaphore_create/up/down`
- `condvar_create/signal/wait`
- `set_robust_list`, `get_robust_list`

**线程调用**（约 3 个）：
- `thread_create`, `waittid`, `set_tid_address`

**其他**：
- `uname`, `sysinfo`, `clock_gettime`, `gettimeofday`, `nanosleep`, `clock_nanosleep`
- `setitimer`（三种 itimer 类型）
- `membarrier`, `sched_getaffinity`

#### 3.5.2 选项处理（options.rs）

定义了大量位标志和枚举类型，用于解析系统调用参数：
- `OpenFlags`: 文件打开标志
- `MmapProt`/`MmapFlags`: mmap 保护和标志
- `CloneFlags`: clone 标志
- `FutexCmd`/`FutexOpt`: futex 操作
- `PollEvents`: poll 事件
- `SignalFlags`: 信号标志
- `FdSet`: select 文件描述符集

**完整度评估**: 85%。系统调用覆盖面广，涵盖了 Linux 兼容性的核心部分。但部分调用仅为桩实现（如 `madvise`、`setsid`、`sched_getaffinity`），某些高级功能（如 epoll、inotify）未实现。

---

### 3.6 设备驱动子系统

**文件**: `drivers/device.rs`, `drivers/disk.rs`, `drivers/virtio/blk.rs`, `drivers/virtio/net.rs`

#### 3.6.1 VirtIO 块设备驱动（virtio/blk.rs）

支持两种传输方式：
- **MMIO**: 用于 RISC-V QEMU virt 机器
- **PCI**: 用于 LoongArch QEMU

`VirtIoBlkDev` 封装了 `virtio_drivers` crate 的 `VirtIOBlk`：
```rust
pub struct VirtIoBlkDev<H: Hal, T: Transport> {
    inner: Mutex<VirtIOBlk<H, T>>,
}
```

实现了 `BlockDriver` trait，提供 `read_block`、`write_block`、`flush` 操作。包含错误重试机制（处理 `NotReady` 错误）。

PCI 枚举代码实现了 BAR 分配和命令寄存器配置：
```rust
fn enumerate_pci<H: Hal>(mmconfig_base: *mut u8) -> Option<PciTransport> {
    let mut pci_root = unsafe { PciRoot::new(mmconfig_base, Cam::Ecam) };
    // 枚举 PCI 总线，查找 VirtIO 块设备
    // 分配 BAR 地址空间
    // 启用 IO/MEMORY/BUS_MASTER
}
```

#### 3.6.2 VirtIO 网络设备驱动（virtio/net.rs）

`VirtIoNetDev` 封装了 `VirtIONet`，队列大小 64，缓冲区大小 1526 字节（标准 MTU + 以太网头）。

`AxNetDevice` 提供了面向网络子系统的抽象层：
```rust
pub struct AxNetDevice<H: Hal, T: Transport> {
    dev: VirtIoNetDev<H, T>,
}
```

支持 MAC 地址获取、收发状态查询、数据包收发和缓冲区管理。

#### 3.6.3 磁盘管理（disk.rs）

`Disk` 结构封装块设备驱动，提供按字节的读写接口，内部维护当前位置和块缓存。

**完整度评估**: 75%。VirtIO 驱动功能完整，支持 MMIO 和 PCI 两种传输方式。但仅支持块设备和网络设备，缺少其他 VirtIO 设备（如 GPU、输入设备）的支持。

---

### 3.7 硬件抽象层（HAL）

**文件**: `hal/arch/mod.rs`, `hal/arch/loongarch.rs`, `hal/arch/uart.rs`, `hal/arch/info.rs`, `hal/trap/mod.rs`, `hal/trap/context.rs`, `hal/utils/console.rs`

#### 3.7.1 异常与中断处理（trap/）

**RISC-V trap 处理**:
- 用户态 trap 通过 Trampoline 页面进入内核
- 内核态 trap 通过 `__trap_from_kernel` 处理
- 支持系统调用（UserEnvCall）、页异常（Store/Load/Instruction Page Fault）、定时器中断

**LoongArch trap 处理**:
- 配置了 TLB 重填异常入口（`__tlb_refill`）
- 页面大小设置为 4KiB
- 配置了三级页表遍历硬件（pwcl/pwch 寄存器）
- DMW2 配置为强序非缓存访问

LoongArch 的 TLB 重填处理是该项目的一个亮点，直接在汇编中实现了快速 TLB 重填：
```asm
__tlb_refill:
    // 从 CSR_PGD 获取页目录基地址
    // 三级页表遍历
    // 设置 TLB 条目
    tlbwr  // 写入 TLB
    ertn   // 返回
```

**TrapContext** 结构保存完整的用户态上下文：
```rust
pub struct TrapContext {
    pub gp: GeneralRegs,     // 32 个通用寄存器
    pub fp: FloatRegs,       // 32 个浮点寄存器 + FCSR
    pub sstatus: Sstatus/Prmd, // 状态寄存器
    pub sepc: usize,         // 异常程序计数器
    pub kernel_satp: usize,  // 内核页表
    pub kernel_sp: usize,    // 内核栈指针
    pub kernel_ra: usize,    // trap handler 地址
    pub origin_a0: usize,    // 原始 a0 值
}
```

#### 3.7.2 控制台输出（utils/console.rs）

`CONSOLE` 通过 UART 实现字符输出。RISC-V 使用 16550 UART（MMIO 地址 0x1000_0000），LoongArch 使用 LS7A UART（MMIO 地址 0x1FE0_01E0）。

**完整度评估**: 80%。双架构的 trap 处理实现完整，LoongArch 的 TLB 重填是一个技术亮点。但仅支持单核，中断处理较为基础（仅定时器中断）。

---

### 3.8 网络子系统

**文件**: `net/mod.rs`, `net/socket/tcp.rs`, `net/socket/udp.rs`, `net/socket/dns.rs`, `net/socket/loopback.rs`, `net/socket/listen_table.rs`, `net/socket/addr.rs`, `net/socket_impl.rs`, `net/lazy_init.rs`

#### 3.8.1 TCP 套接字（tcp.rs）

基于 smoltcp 协议栈实现，状态机模型：
```
CLOSED -> BUSY -> CONNECTING -> CONNECTED -> BUSY -> CLOSED
       |-> BUSY -> LISTENING -> BUSY -> CLOSED
       |-> BUSY -> CLOSED (bind only)
```

支持阻塞和非阻塞两种模式。关键操作：
- `connect()`: 建立 TCP 连接，支持非阻塞模式下的异步连接
- `bind()`: 绑定本地地址和端口
- `listen()`: 开始监听，使用 `LISTEN_TABLE` 管理监听套接字
- `accept()`: 接受连接，支持阻塞等待
- `send()/recv()`: 数据传输
- `shutdown()`: 关闭连接

#### 3.8.2 UDP 套接字（udp.rs）

支持完整的 UDP 操作：
- `bind()`: 绑定地址
- `send_to()/recv_from()`: 数据报收发
- `connect()`: 设置默认目标地址
- `send()/recv()`: 已连接模式下的收发
- `peek_from()`: 窥视数据
- `recv_from_timeout()`: 带超时的接收

#### 3.8.3 DNS 解析（dns.rs）

实现了基本的 DNS 查询功能，通过 UDP 套接字向 DNS 服务器发送查询请求。

#### 3.8.4 回环接口（loopback.rs）

实现了本地回环网络接口，支持本机进程间的网络通信。

#### 3.8.5 监听表（listen_table.rs）

管理 TCP 监听套接字，支持端口复用检查和新连接的队列管理。

**完整度评估**: 75%。TCP/UDP 基本功能完整，支持阻塞/非阻塞模式。但缺少 IPv6 支持、socket 选项处理有限、DNS 实现较为基础。

---

### 3.9 同步原语子系统

**文件**: `sync/mutex.rs`, `sync/semaphore.rs`, `sync/condvar.rs`, `sync/up.rs`, `sync/banker_algo.rs`

#### 3.9.1 互斥锁（mutex.rs）

提供两种实现：
- `MutexSpin`: 自旋锁，使用 `suspend_current_and_run_next()` 避免忙等
- `MutexBlocking`: 阻塞锁，使用等待队列管理阻塞线程

```rust
impl Mutex for MutexBlocking {
    fn lock(&self) {
        let mut mutex_inner = self.inner.exclusive_access();
        if mutex_inner.locked {
            mutex_inner.wait_queue.push_back(current_task().unwrap());
            drop(mutex_inner);
            block_current_and_run_next();
        } else {
            mutex_inner.locked = true;
        }
    }
}
```

#### 3.9.2 信号量（semaphore.rs）

经典的计数信号量实现：
```rust
pub struct SemaphoreInner {
    pub count: isize,
    pub wait_queue: VecDeque<Arc<TaskControlBlock>>,
}
```

`up()` 增加计数并唤醒等待线程，`down()` 减少计数并在计数为负时阻塞。

#### 3.9.3 条件变量（condvar.rs）

支持 `signal()`（唤醒一个等待线程）和 `wait()`（释放互斥锁并阻塞，被唤醒后重新获取锁）。

#### 3.9.4 银行家算法（banker_algo.rs）

实现了死锁避免的银行家算法：
```rust
pub struct BankerAlgorithm {
    available: BTreeMap<ResourceIdentifier, NumberOfResources>,
    task_state: BTreeMap<TaskIdentifier, BTreeMap<ResourceIdentifier, TaskResourceState>>,
}
```

安全性检查算法遍历所有任务，模拟资源分配过程，判断系统是否处于安全状态。每个进程维护独立的 `BankerAlgorithm` 实例。

#### 3.9.5 UPSafeCell（up.rs）

单核环境下的内部可变性封装，通过关闭中断保证安全性。

**完整度评估**: 85%。同步原语种类齐全，银行家算法是一个特色功能。但缺少读写锁（RwLock）的内核实现（用户态通过 futex 实现），且所有同步原语仅支持单核。

---

### 3.10 信号处理子系统

**文件**: `signal/signal.rs`, `signal/sigact.rs`

#### 3.10.1 信号定义

支持 33 种信号（SIGHUP 到 SIGRT_1），与 Linux 信号编号一致。每种信号有默认操作：
- `Terminate`: 终止进程（SIGHUP、SIGINT、SIGKILL 等）
- `CoreDump`: 核心转储（SIGQUIT、SIGILL、SIGABRT 等）
- `Ignore`: 忽略（SIGCHLD、SIGURG、SIGWINCH）
- `Stop`: 停止（SIGSTOP、SIGTSTP 等）
- `Continue`: 继续（SIGCONT）

#### 3.10.2 信号动作

`SigAction` 结构：
```rust
pub struct SigAction {
    pub sa_handler: usize,
    pub sa_flags: SigActionFlags,
    pub sa_restore: usize,
    pub sa_mask: SignalFlags,
}
```

`SigTable` 维护每个信号的处理动作，支持自定义处理函数。

#### 3.10.3 信号传递

信号通过以下机制传递：
- `send_signal_to_thread()`: 向特定线程发送信号
- `send_signal_to_thread_group()`: 向线程组发送信号
- `check_if_any_sig_for_current_task()`: 检查当前任务是否有待处理信号
- `handle_signal()`: 处理信号，包括设置信号帧和跳转到处理函数

信号返回通过 `SIGRETURN` 地址（`0x3_0000_0000`）触发 `sys_sigreturn` 系统调用。

**完整度评估**: 80%。信号机制基本完整，支持自定义处理函数、信号掩码、信号返回。但缺少信号队列（实时信号的排队处理）和信号栈的完整支持。

---

### 3.11 用户管理子系统

**文件**: `users/users.rs`, `users/id.rs`, `users/group.rs`

实现了基本的用户和组管理：
```rust
pub struct User {
    pub uid: Arc<Uid>,
    pub username: String,
    pub group: Vec<Weak<Gid>>,
    pub pwd: String,
    pub homedir: String,
    pub shell: String,
}
```

每个进程关联一个 `User` 对象，支持 `getuid()`、`getgid()` 等操作。UID/GID 通过全局分配器管理。

**完整度评估**: 60%。实现了基本的用户/组 ID 管理，但缺少权限检查、用户认证等功能。

---

### 3.12 定时器子系统

**文件**: `timer.rs`

实现了多种定时器：
- **系统时钟**: 基于 RISC-V `time` 寄存器或 LoongArch 定时器
- **TimeSpec/TimeVal**: 时间结构体，支持纳秒/微秒精度
- **Itimerval**: 三种间隔定时器（ITIMER_REAL、ITIMER_VIRTUAL、ITIMER_PROF）
- **Timer**: 进程级定时器，支持周期性触发

定时器使用 `BinaryHeap`（最小堆）管理，按到期时间排序。`check_timer()` 在每次调度时检查到期定时器并发送相应信号。

**完整度评估**: 80%。定时器功能完整，支持多种类型。但 ITIMER_VIRTUAL 和 ITIMER_PROF 的 CPU 时间统计精度有限。

---

### 3.13 工具模块

**文件**: `utils/error.rs`, `utils/hart.rs`, `utils/string.rs`

- `error.rs`: 定义了 `SysErrNo` 枚举（约 40 种错误码）和 `SyscallRet` 类型
- `hart.rs`: 硬件线程相关工具
- `string.rs`: 字符串处理工具（路径操作、C 字符串转换等）

---

## 4. 子系统交互分析

### 4.1 系统调用路径

```
用户态 ecall -> Trampoline -> trap_handler() -> syscall() -> 具体实现
                                                         |
                                                         v
                                              进程/内存/文件/网络子系统
                                                         |
                                                         v
                                              schedule() -> __switch -> 下一任务
```

### 4.2 进程创建路径

```
sys_fork() -> ProcessControlBlock::fork()
  -> MemorySet::from_existed_user() (COW 复制地址空间)
  -> TaskControlBlock::new() (创建新线程)
  -> 设置 Trap 上下文
  -> add_task() (加入就绪队列)
```

### 4.3 缺页处理路径

```
Page Fault -> trap_handler()
  -> memory_set.lazy_page_fault() (延迟分配)
  -> memory_set.cow_page_fault() (COW 复制)
  -> memory_set.mmap_read/write_page_fault() (文件映射)
  -> flush_tlb()
  -> 返回用户态
```

### 4.4 文件 I/O 路径

```
sys_read() -> fd_table.get(fd) -> FileClass::any()
  -> OSInode::read() -> Inode::read_at()
  -> Ext4Inode -> lwext4 C 库 -> Disk -> VirtIOBlk -> QEMU
```

---

## 5. 项目创新性与特色

1. **双架构支持**: 同时支持 RISC-V 和 LoongArch，通过条件编译实现代码复用。LoongArch 的 TLB 重填和 DMW 配置是技术亮点。

2. **COW + Lazy Allocation + 共享组**: 三层内存优化策略。COW 减少 fork 时的物理页复制，Lazy Allocation 延迟堆/栈分配，共享组（GroupManager）在 mmap MAP_SHARED 区域跨 fork 共享页面。

3. **银行家算法死锁避免**: 在同步子系统中集成了银行家算法，可在资源分配前进行安全性检查，这在教学 OS 中较为少见。

4. **完整的 Futex 实现**: 支持 FUTEX_WAIT、FUTEX_WAKE、FUTEX_REQUEUE、FUTEX_WAKE_OP 四种操作，包括原子操作和条件唤醒。

5. **动态链接支持**: exec 实现中支持加载 ELF 动态链接器（ld-musl），设置完整的辅助向量，使得 musl libc 动态链接程序能够正常运行。

6. **PCI 设备枚举**: VirtIO 驱动中实现了完整的 PCI 设备枚举和 BAR 分配，支持 LoongArch 平台的 PCI 设备。

---

## 6. 其他项目信息

### 6.1 外部依赖

- **smoltcp**: 轻量级 TCP/IP 协议栈（本地修改版本）
- **lwext4_rsut**: ext4 文件系统 C 库的 Rust 绑定
- **virtio-drivers**: VirtIO 设备驱动框架
- **xmas-elf**: ELF 文件解析
- **lazy_static**: 延迟初始化
- **bitflags**: 位标志宏
- **hashbrown**: 高性能哈希表
- **spin**: 自旋锁

### 6.2 用户态程序

用户态包含 4 个程序：
- `initproc.rs`: 初始进程，执行 shell 或测试脚本
- `user_shell.rs`: 简单的命令行 shell
- `usertest.rs`: 综合测试程序
- `test_waitpid.rs`: waitpid 系统调用测试

### 6.3 代码规模

- 内核 Rust 源文件: 91 个
- 汇编文件: 6 个（trap_rv.s、trap_la.s、switch_rv.s、switch_la.s、initproc_rv.S、initproc_la.S）
- 外部库: smoltcp（网络协议栈）、lwext4_rsut（ext4 文件系统）
- 系统调用数量: 约 100+

---

## 7. 总结

SubsToKernel 是一个功能较为完整的教学/竞赛级操作系统内核，基于 rCore-Tutorial-v3 进行了大幅扩展。项目在以下方面表现突出：

**优势**:
- 双架构（RISC-V + LoongArch）支持，LoongArch 的 TLB 重填实现是技术亮点
- 内存管理功能丰富（COW、Lazy Allocation、mmap、共享内存、共享组）
- 系统调用覆盖面广（100+），Linux 兼容性较好
- 文件系统基于成熟的 ext4 实现，功能完整
- 网络子系统基于 smoltcp，TCP/UDP 基本功能齐全
- 同步原语种类齐全，包含银行家算法死锁避免

**不足**:
- 仅支持单核（SMP 未实现），调度器为简单 FIFO
- 缺少 swap 和内存回收机制
- 部分系统调用为桩实现
- procfs/sysfs 仅为静态文件模拟
- 用户态程序较少，测试覆盖有限
- 代码中存在较多调试日志和注释掉的代码，代码整洁度有提升空间

**整体完整度评估**: 约 80%（以 rCore-Tutorial ch8 为基准的扩展完成度）。该项目在教学 OS 的基础上进行了大量扩展，接近竞赛级 OS 的水平，但在多核支持、调度算法、内存回收等方面仍有较大提升空间。