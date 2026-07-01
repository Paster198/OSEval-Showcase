# NPUcore+ OS 内核项目技术报告

## 1. 项目概述

NPUcore+ 是一个基于 RISC-V 64 位架构的操作系统内核项目，使用 Rust 语言编写，源自清华大学 rCore-Tutorial v3 教学操作系统。该项目由西安理工大学"无所畏惧"团队开发，参加了 2023 年全国大学生操作系统比赛（oskernel2023）。目标平台为 QEMU virt 虚拟机和 K210 开发板，同时包含对 SiFive FU740 SoC 的实验性支持。

项目仓库包含约 591 个 Rust 源文件，其中内核主体（`os/src/`）约 80 个文件、约 17,000 行代码（不含 vendor 依赖），用户态程序（`user/src/`）约 12 个文件、约 1,200 行代码，easy-fs 文件系统库约 3,500 行代码。

## 2. 分析过程

本次分析对仓库进行了以下调查：

1. **文件结构与代码规模统计**：遍历所有源文件，统计各模块代码行数。
2. **构建系统分析**：阅读顶层 Makefile、os/Makefile、user/Makefile，理解构建流程与依赖关系。
3. **内核源码逐文件阅读**：对 `os/src/` 下所有核心模块进行了详细阅读，包括 main.rs、mm/、task/、fs/、syscall/、drivers/、arch/、timer.rs 等。
4. **用户态程序分析**：阅读 user/src/ 下的测试程序和 initproc。
5. **外部组件分析**：阅读 easy-fs 库、rustsbi-k210 固件源码。
6. **构建尝试**：检查工具链可用性，确认构建可行性。

## 3. 测试结果

**未能进行运行时测试**。原因如下：

- 内核构建依赖 `preload_app.S` 中嵌入的 `bash-5.1.16/bash` 二进制文件，该文件需要通过 `riscv64-linux-musl-gcc` 交叉编译 Bash 源码获得。
- 当前环境中 **RISC-V musl 交叉编译工具链缺失**（`riscv64-linux-musl-gcc`、`riscv64-linux-musl-ar`、`riscv64-linux-musl-objcopy` 均不可用）。
- 没有预编译的 bash 二进制文件存在于仓库中（`.gitignore` 排除了构建产物）。
- 因此无法完成完整的内核构建（`cargo build` 会因 `preload_app.S` 中 `.incbin "../bash-5.1.16/bash"` 找不到文件而失败）。
- 用户态 Rust 程序（如 initproc）理论上可以单独编译，但由于内核构建流程的耦合性，无法独立验证。

## 4. 子系统实现分析

### 4.1 架构与平台适配层 (`os/src/arch/rv64/`)

**实现完整度：较高（约 85%）**

#### 4.1.1 启动与引导

内核入口通过 `entry.asm` 汇编代码实现，在 `main.rs` 中通过 `global_asm!` 宏引入。启动流程为：

```
entry.asm -> rust_main() -> bootstrap_init() -> mem_clear() -> console::log_init() -> mm::init() -> machine_init() -> fs::init_fs() -> fs::flush_preload() -> task::add_initproc() -> task::run_tasks()
```

`bootstrap_init()` 在 QEMU 平台上为空函数。`machine_init()` 负责设置 trap 入口、启用定时器中断、设置首次定时器触发。

#### 4.1.2 SBI 调用封装 (`sbi.rs`)

使用传统的 Legacy SBI 接口（v0.1），通过内联汇编 `ecall` 指令实现：

```rust
fn sbi_call(which: usize, arg0: usize, arg1: usize, arg2: usize) -> usize {
    let mut ret;
    unsafe {
        asm!(
            "ecall",
            inlateout("x10") arg0 => ret,
            in("x11") arg1,
            in("x12") arg2,
            in("x17") which,
        );
    }
    ret
}
```

支持的功能包括：`set_timer`、`console_putchar`、`console_getchar`、`shutdown`。未使用 SBI v0.2+ 的新接口规范。`console_flush()` 为空实现。

#### 4.1.3 SV39 分页管理 (`sv39.rs`)

实现了完整的 SV39 三级页表管理，约 330 行代码：

- **页表项结构** `Sv39PageTableEntry`：包含 PPN 和标志位（V/R/W/X/U/G/A/D），提供了 `find_pte_create`（自动创建中间页表节点）、`find_pte`（只读查找）、`find_pte_refmut`（可变查找）三种遍历方式。
- **页表结构** `Sv39PageTable`：实现了 `PageTable` trait，包含 `new`、`from_token`、`map`、`unmap`、`translate`、`translate_va` 等方法。
- **TLB 管理**：提供 `tlb_invalidate()` 函数（`sfence.vma`），但在 `unmap` 中未自动调用，需要调用者手动处理。

#### 4.1.4 异常/中断处理 (`trap/mod.rs`)

trap 处理约 174 行代码，处理以下异常类型：

| 异常类型 | 处理方式 |
|---------|---------|
| `UserEnvCall` | 系统调用分发，PC+4 后调用 `syscall()` |
| `StoreFault/StorePageFault/InstructionFault/InstructionPageFault/LoadFault/LoadPageFault` | 缺页异常处理，调用 `do_page_fault()`，失败时发送 SIGBUS 或 SIGSEGV |
| `IllegalInstruction` | 发送 SIGILL 信号 |
| `SupervisorTimer` | 唤醒过期定时器，设置下次触发，调度切换 |

关键设计：在 trap 入口处记录进程进入内核态时间（`update_process_times_enter_trap`），在 trap 返回前记录离开时间（`update_process_times_leave_trap`），用于 getrusage 统计。

trap 返回前调用 `do_signal()` 处理待处理信号，实现了信号在返回用户态时的注入机制。

#### 4.1.5 上下文切换 (`switch.S`/`switch.rs`)

通过外部汇编文件 `switch.S` 实现 `__switch` 函数，保存/恢复 callee-saved 寄存器。`TaskContext` 结构体包含 `ra` 和 `s[0..11]` 共 13 个寄存器。

#### 4.1.6 板级配置

- **QEMU** (`board/qemu.rs`)：内存范围 `0x8000_0000` ~ `0x809e_0000`（约 10MB），时钟频率 12.5MHz，VirtIO 块设备，MMIO 区域定义。
- **K210** (`board/k210.rs`)：内存范围 `0x8000_0000` ~ `0x8080_0000`（8MB），SD 卡驱动。
- **FU740** (`board/fu740.rs`)：内存范围 `0x8000_0000` ~ `0x9000_0000`（256MB），实验性支持。

### 4.2 内存管理子系统 (`os/src/mm/`)

**实现完整度：高（约 90%）**

这是本项目最复杂和最具创新性的子系统之一，总计约 3,800 行代码。

#### 4.2.1 地址抽象 (`address.rs`, 277 行)

定义了 `PhysAddr`、`VirtAddr`、`PhysPageNum`、`VirtPageNum` 四种类型，支持相互转换。实现了 `VPNRange` 用于表示虚拟页号范围，支持迭代器模式。地址空间布局：

```
TASK_SIZE = 0xC000_0000 (3GB)
MMAP_BASE = 0x6000_0000
MMAP_END  = 0x8000_0000
TRAMPOLINE = usize::MAX - PAGE_SIZE + 1
SIGNAL_TRAMPOLINE = TRAMPOLINE - PAGE_SIZE
TRAP_CONTEXT_BASE = SIGNAL_TRAMPOLINE - PAGE_SIZE
```

#### 4.2.2 物理页帧分配器 (`frame_allocator.rs`, 310 行)

采用栈式分配器 `StackFrameAllocator`：

- 维护 `current`（当前未分配起始页号）、`end`（结束页号）、`recycled`（回收栈）。
- 分配时优先从回收栈弹出，否则递增 `current`。
- 新分配的页帧默认清零（`FrameTracker::new`），FU740 平台可选不清零（`zero_init` feature）。
- 返回 `Arc<FrameTracker>`，利用 Rust 引用计数自动回收。

**OOM 处理机制**（`oom_handler` feature 启用时）：

```rust
pub fn frame_alloc() -> Option<Arc<FrameTracker>> {
    let result = FRAME_ALLOCATOR.write().alloc();
    match result {
        Some(frame_tracker) => Some(Arc::new(frame_tracker)),
        None => {
            oom_handler(1).unwrap();
            FRAME_ALLOCATOR.write().alloc().map(|frame_tracker| Arc::new(frame_tracker))
        }
    }
}
```

当物理内存耗尽时，触发三级 OOM 处理：
1. 清理文件系统缓存（`fs::directory_tree::oom()`）
2. 清理当前进程的内存空间（`do_shallow_clean`）
3. 遍历所有进程进行深度清理（`do_deep_clean`）

#### 4.2.3 映射区域与 Frame 状态机 (`map_area.rs`, 887 行)

`Frame` 枚举实现了页面状态机：

```rust
pub enum Frame {
    InMemory(Arc<FrameTracker>),    // 在物理内存中
    Compressed(Arc<ZramTracker>),   // 压缩存储在 zram 中
    SwappedOut(Arc<SwapTracker>),   // 交换到磁盘
    Unallocated,                     // 未分配（CoW 延迟分配）
}
```

状态转换：
- `InMemory -> Compressed`：`zip()` 方法，使用 LZ4 压缩
- `Compressed -> InMemory`：`unzip()` 方法，LZ4 解压
- `InMemory -> SwappedOut`：`swap_out()` / `force_swap_out()` 方法
- `SwappedOut -> InMemory`：`swap_in()` 方法
- `Unallocated -> InMemory`：`insert_in_memory()` 方法（CoW 触发时）

`LinearMap` 结构使用 `Vec<Frame>` 和 `VecDeque<u16>` 活跃列表来管理映射区域内的页面状态，支持 OOM 时的页面回收策略。

#### 4.2.4 地址空间管理 (`memory_set.rs`, 1163 行)

`MemorySet<T: PageTable>` 是核心结构，管理一个进程的完整虚拟地址空间：

- **内核地址空间**：通过 `lazy_static!` 创建全局 `KERNEL_SPACE`，映射 `.text`、`.rodata`、`.data`、`.bss`、MMIO 区域和 trampoline 页面。
- **用户地址空间**：通过 `from_elf()` 从 ELF 文件创建，包含程序段映射、用户栈、堆、trampoline。
- **mmap 支持**：`mmap()` 方法在 `MMAP_BASE` ~ `MMAP_END` 范围内分配匿名映射区域。
- **CoW（Copy-on-Write）**：`do_cow()` 方法实现写时复制，在 fork 时共享物理页面，写入时才分配新页面。
- **缺页处理**：`do_page_fault()` 方法处理四种情况：
  1. 未分配页面（CoW 延迟分配）
  2. 压缩页面（从 zram 解压）
  3. 交换页面（从 swap 读回）
  4. 权限错误（发送信号）

```rust
pub fn do_page_fault(&mut self, addr: VirtAddr) -> Result<(), MemoryError> {
    // 查找包含该地址的 MapArea
    // 根据 Frame 状态执行相应操作
    // Unallocated -> 分配新页面
    // Compressed -> unzip
    // SwappedOut -> swap_in
    // 权限不匹配 -> 返回 NoPermission
}
```

- **OOM 清理**：`do_shallow_clean()` 将不活跃的 InMemory 页面压缩到 zram；`do_deep_clean()` 进一步将 zram 页面交换到磁盘。

#### 4.2.5 堆分配器 (`heap_allocator.rs`, 46 行)

使用 `buddy_system_allocator` crate 的 `LockedHeap`，内核堆大小在 QEMU 上为 `PAGE_SIZE * 0x240`（约 2.25MB），FU740 上为 `PAGE_SIZE * 0x2000`（约 32MB）。

#### 4.2.6 ZRAM 压缩内存 (`zram.rs`, 104 行)

使用 `lz4_flex` crate 实现内存压缩：

```rust
pub struct Zram {
    compressed: Vec<Option<Vec<u8>>>,  // 压缩数据数组
    recycled: Vec<u16>,                 // 回收的索引
    tail: u16,                          // 下一个可用索引
}
```

容量固定为 2048 个压缩页面。`write()` 方法使用 `compress_prepend_size` 压缩，`read()` 方法使用 `decompress_size_prepended` 解压。通过 `ZramTracker` 的 `Drop` 实现自动回收。

#### 4.2.7 交换分区 (`fs/swap.rs`, 79 行)

在 FAT32 文件系统上分配块作为交换空间：

```rust
pub struct Swap {
    bitmap: Vec<u64>,       // 页面使用位图
    block_ids: Vec<usize>,  // 预分配的块 ID
}
```

初始化时从文件系统预分配 `size * 2048` 个块（默认 16MB 交换空间 = 32768 个块 = 4096 个页面）。每个页面占 8 个连续块（4KB / 512B）。

### 4.3 进程/任务管理子系统 (`os/src/task/`)

**实现完整度：较高（约 85%）**

总计约 2,800 行代码。

#### 4.3.1 任务控制块 (`task.rs`, 563 行)

`TaskControlBlock` 结构包含：

```rust
pub struct TaskControlBlock {
    pub pid: PidHandle,           // 进程 ID
    pub tid: usize,               // 线程 ID
    pub tgid: usize,              // 线程组 ID（等于主线程的 pid）
    pub kstack: KernelStack,      // 内核栈
    pub ustack_base: usize,       // 用户栈基址
    pub exit_signal: Signals,     // 退出时发送给父进程的信号
    inner: Mutex<TaskControlBlockInner>,  // 可变内部状态
    pub exe: Arc<Mutex<FileDescriptor>>,  // 可执行文件描述符
    pub tid_allocator: Arc<Mutex<RecycleAllocator>>,  // 线程 ID 分配器
    pub files: Arc<Mutex<FdTable>>,       // 文件描述符表（进程内线程共享）
    pub fs: Arc<Mutex<FsStatus>>,         // 文件系统状态（工作目录）
    pub vm: Arc<Mutex<MemorySet<PageTableImpl>>>,  // 地址空间（进程内线程共享）
    pub sighand: Arc<Mutex<Vec<Option<Box<SigAction>>>>>,  // 信号处理表（共享）
    pub futex: Arc<Mutex<Futex>>,         // futex 状态（共享）
}
```

`TaskControlBlockInner` 包含：信号掩码/待处理信号、trap 上下文物理页号、任务上下文、任务状态、父子关系、退出码、`clear_child_tid`、`robust_list`、堆信息、进程组 ID、`rusage` 统计、进程时钟、定时器。

**多线程设计**：同一进程的多个线程共享 `vm`、`files`、`fs`、`sighand`、`futex`、`exe`、`tid_allocator`，各自拥有独立的 `pid`、`tid`、`kstack`、`ustack_base`、`inner`。

#### 4.3.2 调度器 (`manager.rs`, 457 行)

采用简单的 FIFO 调度策略：

```rust
pub struct TaskManager {
    pub ready_queue: VecDeque<Arc<TaskControlBlock>>,
    pub interruptible_queue: VecDeque<Arc<TaskControlBlock>>,
    pub active_tracker: ActiveTracker,  // OOM 时跟踪活跃进程
}
```

- `ready_queue`：就绪队列，`fetch()` 从队首取出任务。
- `interruptible_queue`：可中断等待队列，用于睡眠的进程（等待 I/O、futex、定时器等）。
- `ActiveTracker`：位图追踪哪些进程近期被调度过，用于 OOM 时决定清理顺序。

OOM 清理策略（`do_oom`）：
1. 先对 `interruptible_queue` 中的活跃进程执行 `do_deep_clean`
2. 再对 `ready_queue` 中的活跃进程执行 `do_shallow_clean`

#### 4.3.3 信号机制 (`signal.rs`, 646 行)

实现了完整的 POSIX 信号机制：

- **64 种信号**：从 SIGHUP(1) 到 SIGRTMAX(64)，使用 `bitflags!` 宏定义。
- **SigAction 结构**：包含 handler（SIG_DFL/SIG_IGN/自定义地址）、flags（SA_SIGINFO/SA_RESTART/SA_NODEFER/SA_RESETHAND/SA_RESTORER 等）、restorer、mask。
- **信号处理流程**：
  1. `do_signal()` 在 trap 返回前检查待处理信号
  2. 对于有自定义 handler 的信号，修改用户态 trap context，将 PC 指向 handler 地址
  3. 在用户栈上构造信号帧（signal frame），保存原始上下文
  4. 用户态 handler 执行完毕后调用 `sigreturn` 系统调用恢复上下文
- **信号掩码**：`sigprocmask` 支持 SIG_BLOCK/SIG_UNBLOCK/SIG_SETMASK
- **不可屏蔽信号**：SIGILL、SIGKILL、SIGSEGV、SIGSTOP

#### 4.3.4 Futex (`threads.rs`, 152 行)

实现了 Linux futex 的核心操作：

```rust
pub struct Futex {
    inner: BTreeMap<usize, WaitQueue>,  // 以 futex word 地址为键的等待队列映射
}
```

支持的操作：
- `FUTEX_WAIT`：原子比较 futex word 与期望值，匹配则睡眠等待
- `FUTEX_WAKE`：唤醒指定数量的等待者
- `FUTEX_REQUEUE`：将等待者从一个 futex word 转移到另一个
- 支持超时等待（通过 `wait_with_timeout`）

#### 4.3.5 ELF 加载器 (`elf.rs`, 122 行)

支持 ELF 解释器（动态链接器）加载：

```rust
pub fn load_elf_interp(path: &str) -> Result<&'static [u8], isize>
```

- 从文件系统读取 ELF 文件
- 验证 ELF magic number
- 将 ELF 数据映射到内核地址空间
- 返回 ELF 数据切片供 `MemorySet::from_elf` 解析

`ELFInfo` 结构记录：入口地址、解释器入口地址、基地址、程序头数量和大小、程序头地址。支持 auxv（辅助向量）传递。

#### 4.3.6 PID/TID 管理 (`pid.rs`, 117 行)

使用 `RecycleAllocator` 分配 PID/TID：

- 维护 `current`（下一个可用 ID）和 `recycled`（回收的 ID 栈）
- `PidHandle` 的 `Drop` 实现自动回收 PID
- 内核栈通过 `kstack_alloc` 分配，每个线程独立内核栈

### 4.4 文件系统子系统 (`os/src/fs/`)

**实现完整度：较高（约 80%）**

总计约 5,500 行代码（含 FAT32 实现）。

#### 4.4.1 VFS 层 (`file_trait.rs`, 70 行)

定义了 `File` trait 作为所有文件类型的统一接口：

```rust
pub trait File: DowncastSync {
    fn deep_clone(&self) -> Arc<dyn File>;
    fn readable(&self) -> bool;
    fn writable(&self) -> bool;
    fn read(&self, offset: Option<&mut usize>, buf: &mut [u8]) -> usize;
    fn write(&self, offset: Option<&mut usize>, buf: &[u8]) -> usize;
    fn r_ready(&self) -> bool;
    fn w_ready(&self) -> bool;
    fn read_user(&self, offset: Option<usize>, buf: UserBuffer) -> usize;
    fn write_user(&self, offset: Option<usize>, buf: UserBuffer) -> usize;
    fn get_stat(&self) -> Stat;
    fn open(&self, flags: OpenFlags, special_use: bool) -> Arc<dyn File>;
    fn open_subfile(&self) -> Result<Vec<(String, Arc<dyn File>)>, isize>;
    fn create(&self, name: &str, file_type: DiskInodeType) -> Result<Arc<dyn File>, isize>;
    fn unlink(&self, delete: bool) -> Result<(), isize>;
    fn lseek(&self, offset: isize, whence: SeekWhence) -> Result<usize, isize>;
    fn ioctl(&self, cmd: u32, argp: usize) -> isize;
    fn fcntl(&self, cmd: u32, arg: u32) -> isize;
    // ... 更多方法
}
```

使用 `downcast-rs` crate 支持 trait 对象的向下转型。

#### 4.4.2 目录树管理 (`directory_tree.rs`, 765 行)

`DirectoryTreeNode` 实现了 VFS 层的目录树结构：

```rust
pub struct DirectoryTreeNode {
    spe_usage: Mutex<usize>,           // 特殊引用计数（cwd、mount point、root）
    name: String,
    filesystem: Arc<FileSystem>,
    file: Arc<dyn File>,               // 底层文件实现
    selfptr: Mutex<Weak<Self>>,
    father: Mutex<Weak<Self>>,
    children: RwLock<Option<BTreeMap<String, Arc<Self>>>>,  // 延迟加载的子节点
}
```

关键特性：
- **延迟加载**：子目录内容在首次访问时才从底层文件系统加载（`cache_all_subfile`）
- **路径解析**：支持绝对路径和相对路径，处理 `.` 和 `..`
- **路径缓存**：全局 `PATH_CACHE` 缓存最近解析的路径
- **OOM 支持**：`oom()` 方法释放未使用的目录树节点缓存

#### 4.4.3 FAT32 文件系统 (`fat32/`)

完整的 FAT32 实现，约 3,200 行代码：

- **布局定义** (`layout.rs`, 616 行)：BPB（BIOS Parameter Block）、短目录项（`FATShortDirEnt`）、长目录项（`FATLongDirEnt`）、FAT 表操作。支持 VFAT 长文件名。
- **Inode 实现** (`vfs.rs`, 1587 行)：`Inode` 结构管理文件/目录的簇链、大小、缓存。支持读写、创建、删除、重命名、截断等操作。
- **目录迭代器** (`dir_iter.rs`, 236 行)：遍历目录项，处理长/短文件名。
- **位图** (`bitmap.rs`, 256 行)：FAT 表簇分配/释放。
- **EFS** (`efs.rs`, 114 行)：`EasyFileSystem` 结构，管理 FAT32 文件系统元数据。

#### 4.4.4 页缓存 (`cache.rs`, 432 行)

实现了两级缓存：

- **BufferCache**：512 字节的块缓存，带优先级机制
- **PageCache**：4KB 页面缓存，由 8 个 BufferCache 组成
- **BlockCacheManager**：管理 16 个 BufferCache 的缓存池，支持 LRU 式优先级回收
- **PageCacheManager**：管理文件的页面缓存，支持按需加载和写回

#### 4.4.5 设备文件

| 设备 | 文件 | 行数 | 实现状态 |
|------|------|------|---------|
| /dev/null | `null.rs` | 153 | 完整：读返回 0 字节，写丢弃 |
| /dev/zero | `zero.rs` | 155 | 完整：读返回全零，写丢弃 |
| 管道 | `pipe.rs` | 501 | 完整：环形缓冲区，阻塞读写，支持信号中断 |
| TTY | `tty.rs` | 479 | 较完整：支持 termios、ioctl(TIOCGWINSZ/TCGETS/TCSETS)、回显 |
| Socket | `socket.rs` | 141 | 桩实现：所有方法均为 `todo!()` |
| 硬件时钟 | `hwclock.rs` | 147 | 完整：读取 SBI 时间 |

#### 4.4.6 Poll/Select (`poll.rs`, 402 行)

实现了 `ppoll` 和 `pselect6`：

- `ppoll`：轮询文件描述符数组，支持 POLLIN/POLLOUT/POLLHUP 等事件，支持超时和信号掩码
- `pselect6`：基于 `FdSet` 位图的 select 实现，支持 1024 个文件描述符
- 两者都支持超时等待和信号中断

#### 4.4.7 文件描述符表 (`mod.rs`, 567 行)

`FdTable` 管理进程的文件描述符：

```rust
pub struct FdTable {
    fd_table: Vec<Option<Arc<FileDescriptor>>>,
}
```

- 支持 `dup`/`dup2`/`dup3`
- 支持 `O_CLOEXEC` 标志
- 系统限制 `SYSTEM_FD_LIMIT = 256`

### 4.5 系统调用子系统 (`os/src/syscall/`)

**实现完整度：较高（约 75%）**

总计约 3,500 行代码，实现了约 80+ 个系统调用。

#### 4.5.1 系统调用分发 (`mod.rs`, 488 行)

通过 `match` 语句分发系统调用号到对应处理函数。支持日志输出（可通过 `LOG` 环境变量控制）。

#### 4.5.2 文件系统调用 (`fs.rs`, 1474 行)

| 系统调用 | 实现状态 |
|---------|---------|
| openat | 完整 |
| close | 完整 |
| read / write | 完整 |
| pread / pwrite | 完整 |
| readv / writev | 完整 |
| lseek | 完整 |
| getcwd | 完整 |
| chdir | 完整 |
| mkdirat | 完整 |
| unlinkat | 完整 |
| renameat2 | 完整 |
| linkat | 桩实现（返回 ENOSYS） |
| readlinkat | 桩实现 |
| fstat / fstatat | 完整 |
| statfs | 桩实现 |
| getdents64 | 完整 |
| dup / dup3 | 完整 |
| pipe2 | 完整 |
| fcntl | 部分（支持 F_DUPFD/F_GETFD/F_SETFD/F_GETFL/F_SETFL） |
| ioctl | 部分（TTY 相关） |
| faccessat / faccessat2 | 完整 |
| ftruncate | 完整 |
| fsync | 桩实现（返回 SUCCESS） |
| utimensat | 桩实现 |
| sendfile | 完整 |
| mount / umount2 | 桩实现 |
| syslog | 部分（返回伪造的 Linux 版本信息） |

#### 4.5.3 进程管理调用 (`process.rs`, 1101 行)

| 系统调用 | 实现状态 |
|---------|---------|
| exit / exit_group | 完整 |
| clone（fork） | 完整，支持 CLONE_VM/CLONE_FS/CLONE_FILES/CLONE_SIGHAND/CLONE_THREAD 等标志 |
| execve | 完整，支持 ELF 加载和动态链接器 |
| wait4 | 完整，支持 WNOHANG/WUNTRACED |
| yield | 完整 |
| kill / tkill | 完整 |
| sigaction | 完整 |
| sigprocmask | 完整 |
| sigtimedwait | 完整 |
| sigreturn | 完整 |
| nanosleep | 完整 |
| setitimer / getitimer | 完整 |
| clock_gettime | 完整 |
| gettimeofday | 完整 |
| times | 完整 |
| getpid / getppid / gettid | 完整 |
| getuid / geteuid / getgid / getegid | 桩实现（返回 0） |
| setpgid / getpgid | 完整 |
| uname | 完整（返回 Linux 5.10.102.1 信息） |
| getrusage | 部分（仅 ru_utime 和 ru_stime） |
| umask | 桩实现（返回 0） |
| sysinfo | 完整（返回内存和任务统计） |
| mmap / munmap / mprotect | 完整 |
| brk / sbrk | 完整 |
| set_tid_address | 完整 |
| futex | 完整（WAIT/WAKE/REQUEUE） |
| set_robust_list / get_robust_list | 完整 |
| prlimit | 桩实现 |
| membarrier | 桩实现（返回 SUCCESS） |

#### 4.5.4 Socket 调用 (`socket.rs`, 67 行)

**桩实现**：所有 socket 系统调用（socket/bind/listen/accept/connect/sendto/recvfrom/setsockopt/getsockname/getpeername）均返回 SUCCESS 或固定值，不提供实际网络功能。`sys_recvfrom` 返回固定字符串 "x"。

#### 4.5.5 错误码 (`errno.rs`, 431 行)

定义了约 130 个 POSIX 错误码常量，覆盖了常见的 Linux 错误码。

### 4.6 驱动子系统 (`os/src/drivers/`)

**实现完整度：中等（约 60%）**

#### 4.6.1 块设备驱动

- **VirtIO 块设备** (`virtio_blk.rs`, 88 行)：使用 `virtio-drivers` crate 实现 QEMU 平台的块设备读写。提供了 DMA 分配/释放和地址转换的回调函数。
- **内存块设备** (`mem_blk.rs`, 36 行)：将一段物理内存映射为块设备，用于 FU740 平台。
- **SD 卡驱动** (`arch/rv64/sdcard.rs`, 824 行)：K210 平台的 SPI SD 卡驱动，实现了 SD 卡初始化、CMD 命令、块读写。

#### 4.6.2 串口驱动

- **NS16550A** (`ns16550a.rs`, 79 行)：实现了 `embedded-hal` 的 `Read<u8>` 和 `Write<u8>` trait，支持轮询式读写。初始化由 SBI 固件完成。

### 4.7 用户态程序 (`user/`)

**实现完整度：中等（约 50%）**

用户态程序主要用于功能验证：

| 程序 | 功能 |
|------|------|
| `initproc.rs` (260 行) | init 进程，fork+exec 启动 bash shell，回收僵尸进程 |
| `fork_text.rs` | fork 测试 |
| `getpid_text.rs` | getpid 测试 |
| `getrusage_text.rs` | getrusage 测试 |
| `sbrk_text.rs` | sbrk 堆扩展测试 |
| `openat_text.rs` | 文件打开测试 |
| `ls.rs` | 目录列表 |
| `mkdir.rs` | 创建目录 |
| `fantastic_text.rs` | 文本输出测试 |
| `mycall.rs` | 自定义系统调用测试 |
| `print_tcb.rs` | TCB 打印测试 |

`initproc.rs` 是核心用户态程序，负责：
1. 打开 `/dev/tty` 作为 stdin/stdout/stderr
2. fork 并 exec 启动 bash shell
3. 循环 wait 回收僵尸进程

### 4.8 外部组件

#### 4.8.1 easy-fs 库

独立的 FAT32 文件系统库（`no_std`），约 3,500 行代码。包含完整的 FAT32 实现：BPB 解析、FAT 表操作、目录项管理、长文件名支持、块缓存。可被内核和用户态工具共用。

#### 4.8.2 rustsbi-k210

K210 平台的 RustSBI 固件源码（约 2,000 行），包含：
- M 态异常处理和中转
- 页表异常委托
- SFENCE.VMA 模拟
- 定时器中断转发
- hart CSR 初始化

#### 4.8.3 Bash 5.1.16

GNU Bash shell 源码，通过 RISC-V musl 交叉编译为用户态程序。由于 musl 工具链缺失，无法编译。

## 5. 子系统交互分析

### 5.1 系统调用路径

```
用户态 ecall -> trap.S(__alltraps) -> trap_handler() -> syscall() -> sys_xxx()
                                                              |
                                                              v
                                                    fs/task/mm 子系统
                                                              |
                                                              v
                                              trap_return() -> do_signal() -> __restore -> 用户态
```

### 5.2 内存管理与文件系统交互

- 文件系统通过 `BLOCK_DEVICE` 全局变量访问块设备驱动
- 页缓存（`PageCache`）从 `frame_alloc()` 获取物理页面
- OOM 时，`oom_handler` 首先调用 `fs::directory_tree::oom()` 释放文件系统缓存
- Swap 分区在 FAT32 文件系统上预分配块

### 5.3 进程管理与信号交互

- `trap_handler` 在处理异常后调用 `do_signal()` 检查并处理待处理信号
- 信号处理修改用户态 `TrapContext`，将 PC 指向信号 handler
- `sigreturn` 系统调用恢复原始上下文
- 定时器中断触发 `do_wake_expired()` 唤醒超时等待的进程

### 5.4 进程管理与内存管理交互

- `fork` 时通过 `MemorySet::from_existed_user()` 复制地址空间，实现 CoW
- `exec` 时创建新的 `MemorySet`，加载 ELF 文件
- `exit` 时回收用户空间资源（trap context、用户栈）
- `mmap`/`munmap`/`mprotect` 直接操作进程的 `MemorySet`

## 6. 项目完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 架构适配层 | 85% | SV39 分页、trap 处理、SBI 调用完整；SMP 未实现 |
| 内存管理 | 90% | CoW、swap、zram、OOM 处理完整；缺少 KSM、huge pages |
| 进程管理 | 85% | fork/exec/wait/信号/futex 完整；缺少优先级调度、进程组完整管理 |
| 文件系统 | 80% | FAT32 完整、VFS 层完整、设备文件部分完整；缺少 ext4 等 |
| 系统调用 | 75% | 约 80 个调用，核心 POSIX 接口覆盖；部分为桩实现 |
| 驱动 | 60% | VirtIO 块设备、串口、SD 卡完整；缺少网络、GPU 等 |
| 网络 | 5% | 仅有 socket 系统调用桩实现，无实际网络协议栈 |
| 用户态 | 50% | 基本测试程序完整，依赖外部 Bash 编译 |

**整体完整度：约 65%**（以能运行基本 shell 命令和简单程序为基准）。

## 7. 创新性分析

### 7.1 OOM 处理机制（高创新性）

这是本项目最突出的创新点。实现了三级内存回收策略：

1. **文件系统缓存回收**：释放未使用的目录树节点和页缓存
2. **ZRAM 压缩**：使用 LZ4 算法将不活跃页面压缩到内存中，相当于扩展了物理内存
3. **Swap 交换**：将压缩后仍不够的页面交换到磁盘

这种分层回收策略在嵌入式 OS 中较为少见，体现了对内存管理的深入理解。

### 7.2 Frame 状态机（中等创新性）

将物理页面建模为状态机（InMemory/Compressed/SwappedOut/Unallocated），通过 Rust 枚举和 Arc 引用计数实现安全的状态转换，利用了 Rust 的类型系统优势。

### 7.3 CoW 与缺页异常统一处理（中等创新性）

将 CoW 延迟分配、zram 解压、swap 读入统一在 `do_page_fault` 中处理，通过 `Frame` 枚举区分不同情况，代码结构清晰。

### 7.4 目录树 VFS 层（中等创新性）

在 FAT32 之上构建了独立的目录树缓存层（`DirectoryTreeNode`），支持延迟加载和 OOM 时释放，提高了文件系统性能。

## 8. 其他信息

### 8.1 代码质量

- **Rust 特性使用**：大量使用 `lazy_static!`、`Arc<Mutex<T>>`、`bitflags!`、`downcast-rs` 等模式
- **unsafe 使用**：在必要的底层操作（MMIO、汇编、指针操作）中使用 unsafe，总体控制得当
- **注释与文档**：部分模块有详细的文档注释（如 poll.rs、signal.rs），部分模块缺少注释
- **代码风格**：整体一致，但存在一些不一致的命名和格式

### 8.2 已知问题

1. **Socket 完全未实现**：所有网络相关调用为桩实现
2. **SMP 未实现**：虽然 README 提到 `-smp 2`，但代码中无多核支持
3. **linkat/readlinkat 未实现**：硬链接和符号链接不支持
4. **getrusage 不完整**：仅实现了 ru_utime 和 ru_stime
5. **syslog 伪造**：返回伪造的 Linux 版本信息以兼容 bash
6. **uname 伪造**：返回 Linux 5.10.102.1 信息
7. **TTY 读取存在竞态**：QEMU 平台的 `read_user` 中 `suspend_current_and_run_next` 未实际调用（缺少括号）
8. **部分 `todo!()` 残留**：socket.rs 中大量 `todo!()`，可能导致 panic

### 8.3 依赖管理

使用 `vendor/` 目录离线管理 Rust 依赖，包含约 500 个第三方 crate。主要依赖：
- `riscv`：RISC-V CSR 寄存器访问
- `virtio-drivers`：VirtIO 设备驱动
- `buddy_system_allocator`：内核堆分配
- `xmas-elf`：ELF 文件解析
- `lz4_flex`：LZ4 压缩（zram）
- `lazy_static`：全局静态变量
- `spin`：自旋锁
- `bitflags`：标志位操作
- `downcast-rs`：trait 对象向下转型
- `embedded-hal`：嵌入式硬件抽象层

### 8.4 构建系统特点

- 使用 `preload_app.S` 将 initproc 和 bash 二进制嵌入内核数据段
- 内核启动时将嵌入的二进制写入 FAT32 文件系统（`flush_preload`），然后释放对应物理页面
- 构建流程：编译用户态 Rust 程序 -> 交叉编译 Bash -> 编译内核（嵌入二进制）-> 拼接 OpenSBI 固件

## 9. 总结

NPUcore+ 是一个基于 rCore-Tutorial v3 进行了大量扩展的教学操作系统内核。项目在内存管理方面展现了较高的技术水平和创新性，特别是 OOM 处理的三级回收策略（文件系统缓存 -> zram 压缩 -> swap 交换）和 Frame 状态机设计。文件系统实现了完整的 FAT32 支持和 VFS 抽象层。进程管理实现了 fork/exec/wait/信号/futex 等核心 POSIX 接口。系统调用覆盖了约 80 个接口，核心功能较为完整。

主要不足在于：网络子系统完全缺失（仅有桩实现）、SMP 未实现、部分系统调用为桩实现或返回伪造信息、TTY 驱动存在潜在竞态条件。项目整体完整度约 65%，能够支持基本的 shell 操作和简单程序运行，但距离完整的通用操作系统内核仍有较大差距。

代码总量约 25,000 行（不含 vendor），其中内核主体约 17,000 行，在操作系统比赛项目中属于中等偏上规模。Rust 语言的使用较为规范，充分利用了类型系统和所有权机制来保证内存安全。