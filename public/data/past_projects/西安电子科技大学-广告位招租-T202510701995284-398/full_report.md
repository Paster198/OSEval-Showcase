# NPUcore-Aspera 操作系统内核技术报告

## 一、项目概述

NPUcore-Aspera 是一个基于 Rust 语言编写的操作系统内核项目，源自 2024 年计算机系统能力大赛参赛队伍"NPUcore"的参赛作品。该项目支持 **LoongArch64** 和 **RISC-V64** 两种体系结构，通过自建的 HAL（硬件抽象层）统一两套架构的代码。内核源码约 37,531 行 Rust 代码（不含汇编），分布在约 130 个源文件中。

## 二、分析过程

本次分析对仓库进行了以下调查：
1. 完整的源码目录结构遍历与文件统计。
2. 逐个子系统的源码阅读与分析（HAL、内存管理、文件系统、进程管理、系统调用、网络、驱动）。
3. 构建验证：使用 `nightly-2025-01-18` 工具链，以 `board_rvqemu + block_virt + oom_handler` 特性组合成功编译 RISC-V64 内核（release 模式，40 个 warning，0 个 error）。
4. 用户态程序编译验证：三个 initproc 变体均成功编译。
5. QEMU 运行测试未进行，原因：缺少完整的根文件系统镜像构建流程（需要 `buildfs.sh` 脚本和预编译的 bash/busybox 二进制文件），且竞赛模式需要预打包的 sdcard 镜像。

## 三、子系统拆解与实现细节

### 3.1 硬件抽象层（HAL）

**位置**：`os/src/hal/`

**架构**：HAL 分为两层：
- `hal/arch/`：架构相关代码（`loongarch64/` 和 `riscv/`）
- `hal/platform/`：板级配置（`loongarch64/qemu.rs`、`loongarch64/2k1000.rs`、`loongarch64/2k0300.rs`、`riscv/qemu.rs`、`riscv/k210.rs`、`riscv/fu740.rs`）

**统一接口**：通过 `hal/arch/mod.rs` 的条件编译，向内核其余部分导出统一接口：
```rust
// LoongArch64 导出
pub use loongarch64::{
    bootstrap_init, config, machine_init, shutdown,
    KernelPageTableImpl, PageTableImpl, __switch, kstack_alloc, tlb_invalidate,
    trap::{trap_handler, trap_return, TrapContext, MachineContext, UserContext},
    ...
};
// RISC-V64 导出
pub use riscv::{
    bootstrap_init, config, machine_init, shutdown,
    KernelPageTableImpl, PageTableImpl, __switch, ...
};
```

**完整度**：高。两套架构的启动、异常处理、上下文切换、TLB 管理、时间管理均已实现。

#### 3.1.1 LoongArch64 架构实现

**启动流程**（`bootstrap_init()`）：
- 仅允许 CPU 0 启动，其余核心进入死循环
- 配置行中断向量（Timer 使用行中断）
- 启用浮点单元（`EUEn`）
- 清除定时器中断、配置异常入口
- 配置 DMW（直接映射窗口）：DMW2 设置为 StronglyOrderedUnCached 模式
- 配置 MMU：STLBPS、PWCL/PWCH 设置四级页表结构（每级 9 位索引，页表项 8 字节）

**寄存器封装**（`hal/arch/loongarch64/register/`）：
- 完整封装了 LoongArch64 的 CSR 寄存器：基础寄存器（CRMD、PRMD、EEntry、ERA、EStat、ECfg、BadV 等）、MMU 寄存器（PGD、STLBPS、PWCL、PWCH、TLB 相关）、定时器寄存器（TCfg、TVal、TIClr）、RAS 寄存器（MErrCtl、MErrEntry 等）
- 使用自定义宏 `csr_macros!` 生成读写方法

**LAFlex 页表**（`laflex.rs`，498 行）：
- 自定义的 LoongArch64 页表实现，支持灵活的页表项格式
- 页表项标志位：V（有效）、D（脏）、PLV（特权级 0-3）、MAT（内存访问类型：SUC/CC/WUC）、G（全局）、P（物理页存在）、W（可写）、NR（不可读）、NX（不可执行）、RPLV（限制特权级）
- 内核页表使用 token=0 的特殊标识，通过 `MEMORY_HIGH_BASE_VPN` 区分身份映射段
- 支持 `find_pte_create`（按需创建中间页表项）和 `find_pte`（只读查找）

**异常处理**（`trap/mod.rs`，529 行）：
- 实现了 `__rfill`（TLB Refill 异常处理），使用内联汇编直接在内核态完成 TLB 填充，无需切换到通用异常处理
- 通用异常处理 `trap_handler()` 处理：系统调用（Syscall）、页面错误（PageInvalidLoad/Store/Fetch、PageModifyFault、PageNonReadableFault）、非法指令、定时器中断
- 支持 CoW（写时复制）：页面错误处理中调用 `do_page_fault()`

#### 3.1.2 RISC-V64 架构实现

**Sv39 页表**（`sv39.rs`）：
- 标准三级页表实现，页表项格式遵循 RISC-V 规范
- 标志位：V、R、W、X、U、G、A、D
- 支持 `find_pte_create`、`find_pte`、`find_pte_refmut`

**异常处理**（`trap/mod.rs`）：
- 处理 UserEnvCall（系统调用）、Store/Load/Instruction Fault（页面错误）、IllegalInstruction、SupervisorTimer（定时器中断）、SupervisorExternal（外部中断）
- 定时器中断触发 `do_wake_expired()` 唤醒超时任务并进行调度

**TrapContext**：保存 32 个通用寄存器、32 个浮点寄存器、FCSR、sstatus、kernel_satp、trap_handler、kernel_sp。

### 3.2 内存管理（MM）

**位置**：`os/src/mm/`

**总代码量**：约 5,500 行（含 `memory_set.rs` 1,390 行、`map_area.rs` 1,046 行、`page_table.rs` 562 行）

#### 3.2.1 物理帧分配器（`frame_allocator.rs`）

- **算法**：栈式帧分配器（`StackFrameAllocator`）
- **数据结构**：`current` 指针 + `end` 指针 + `recycled: Vec<usize>` 回收列表
- **分配策略**：优先使用回收帧，其次递增 `current`
- **FrameTracker**：RAII 封装，`Drop` 时自动回收物理帧
- **Arc 封装**：所有分配的帧均包装为 `Arc<FrameTracker>`，支持引用计数（用于 CoW）
- **OOM 处理**（`oom_handler` feature）：分配失败时触发 `oom_handler()`，依次执行：
  1. 清理文件系统缓存
  2. 清理当前任务的内存（`do_shallow_clean`）
  3. 通知所有任务释放内存（`do_oom`）
- **帧预留**：`frame_reserve(num)` 确保有足够帧可用，不足时触发 OOM

#### 3.2.2 堆分配器（`heap_allocator.rs`）

- 使用 `buddy_system_allocator::LockedHeap<32>`（buddy 算法，32 级）
- 静态分配 `HEAP_SPACE: [u8; KERNEL_HEAP_SIZE]`
- 自定义 `alloc_error_handler`，打印详细错误信息后 panic

#### 3.2.3 地址类型（`address.rs`）

- 定义了 `PhysAddr`、`VirtAddr`、`PhysPageNum`、`VirtPageNum` 四种类型
- 提供 `floor()`、`ceil()`、`page_offset()`、`aligned()` 等方法
- `VirtPageNum::indexes<const T: usize>()` 支持任意级数的页表索引计算
- `SimpleRange<T>` 和 `SimpleRangeIterator<T>` 提供页号范围迭代

#### 3.2.4 页表抽象（`page_table.rs`）

- 定义 `PageTable` trait，包含：`map`、`unmap`、`translate`、`translate_va`、`token`、`revoke_read/write/execute`、`set_ppn`、`set_pte_flags`、`clear_access_bit`、`clear_dirty_bit`、`is_mapped`、`activate`、`is_valid`、`is_dirty`、`readable`、`writable`、`executable`
- 提供用户空间数据访问工具函数：`translated_byte_buffer`、`translated_str`、`translated_ref`、`translated_refmut`、`copy_from_user`、`copy_to_user`、`copy_to_user_string`、`get_from_user`、`try_get_from_user`
- `UserBuffer` 结构体封装跨页的用户空间缓冲区

#### 3.2.5 内存区域管理（`map_area.rs`，1,046 行）

- **Frame 枚举**：
  ```rust
  pub enum Frame {
      InMemory(Arc<FrameTracker>),
      Compressed(Arc<ZramTracker>),    // oom_handler feature
      SwappedOut(Arc<SwapTracker>),    // oom_handler feature
      Unallocated,
  }
  ```
- **LinearMap**：管理一个内存区域的帧映射，包含 `vpn_range`、`frames: Vec<Frame>`、`active: VecDeque<u16>`（活跃页面队列）、`compressed`/`swapped` 计数
- **MapArea**：封装一个内存区域的映射信息，支持：
  - `map_one`：映射单个页面
  - `unmap`：取消映射
  - `do_page_fault`：处理页面错误（CoW、swap in、zram 解压）
  - `do_cow`：写时复制
  - `do_shallow_clean` / `do_deep_clean`：OOM 时释放页面

#### 3.2.6 内存集（`memory_set.rs`，1,390 行）

- **MemorySet<T: PageTable>**：表示一个完整的地址空间（用户或内核）
- **内核空间**：`KERNEL_SPACE` 全局静态变量，映射内核代码段、数据段、BSS、trampoline、MMIO
- **用户空间操作**：
  - `insert_framed_area`：插入匿名映射（CoW 延迟分配）
  - `insert_program_area`：插入已有帧的映射（用于 ELF 加载）
  - `mmap` / `munmap` / `mprotect`：内存映射操作
  - `do_page_fault`：页面错误处理入口
  - `do_shallow_clean` / `do_deep_clean`：OOM 清理
  - `spawn` / `from_elf`：创建新地址空间
- **CoW 实现**：`fork()` 时复制页表项但撤销写权限，写时触发页面错误并复制页面
- **共享内存**：通过 `SharedSegment` 实现文件映射和匿名共享映射

#### 3.2.7 共享内存（`shm.rs`）

- **SharedSegmentId**：唯一标识共享段（文件映射使用文件指针+偏移的 hash，匿名映射使用递增 ID）
- **SharedSegment**：包含 `pages: BTreeMap<usize, Arc<FrameTracker>>`、文件引用、引用计数
- **SharedMemoryManager**：全局管理器，支持 `get_or_create_segment`、`add_segment_ref`、`remove_segment_ref`、`get_segment_page`、`sync_all`
- 支持文件 unlink 后仍保持映射有效

#### 3.2.8 Zram 压缩内存（`zram.rs`）

- 使用 `lz4_flex` 库进行 LZ4 压缩/解压
- **Zram 结构**：`compressed: Vec<Option<Vec<u8>>>` + `recycled: Vec<u16>` + `tail: u16`
- 容量：2048 个压缩页面
- **ZramTracker**：RAII 封装，`Drop` 时自动释放

#### 3.2.9 Swap 交换（`swap.rs`）

- 使用块设备作为交换空间
- **Swap 结构**：`bitmap: Vec<u64>` + `block_ids: Vec<usize>`
- 默认大小：16 MB
- **SwapTracker**：RAII 封装，`Drop` 时自动释放

### 3.3 文件系统（FS）

**位置**：`os/src/fs/`

**总代码量**：约 10,000 行（含 ext4 约 6,000 行、fat32 约 4,000 行）

#### 3.3.1 VFS 层（`vfs.rs`）

- 定义 `VFS` trait（使用 `downcast-rs` 支持向下转型）：
  ```rust
  pub trait VFS: DowncastSync {
      fn alloc_blocks(&self, blocks: usize) -> Vec<usize>;
      fn get_filesystem_type(&self) -> FS_Type;
      fn block_size(&self) -> usize;
      // ...
  }
  ```
- `open_fs()` 根据文件系统类型（FAT32/Ext4）创建对应实例
- `root_osinode()` 获取根目录 inode

#### 3.3.2 File trait（`file_trait.rs`）

- 定义统一的文件接口（使用 `downcast-rs`）：
  ```rust
  pub trait File: DowncastSync {
      fn deep_clone(&self) -> Arc<dyn File>;
      fn readable(&self) -> bool;
      fn writable(&self) -> bool;
      fn read(&self, offset: Option<&mut usize>, buf: &mut [u8]) -> usize;
      fn write(&self, offset: Option<&mut usize>, buf: &[u8]) -> usize;
      fn get_size(&self) -> usize;
      fn get_stat(&self) -> Stat;
      fn open(&self, flags: OpenFlags, special_use: bool) -> Arc<dyn File>;
      fn create(&self, name: &str, file_type: DiskInodeType) -> Result<Arc<dyn File>, isize>;
      fn unlink(&self, delete: bool) -> Result<(), isize>;
      fn lseek(&self, offset: isize, whence: SeekWhence) -> Result<usize, isize>;
      fn get_single_cache(&self, offset: usize) -> Result<Arc<Mutex<PageCache>>, ()>;
      fn oom(&self) -> usize;
      fn ioctl(&self, cmd: u32, argp: usize) -> isize;
      fn fcntl(&self, cmd: u32, arg: u32) -> isize;
      // ...
  }
  ```

#### 3.3.3 目录树（`directory_tree.rs`，821 行）

- **DirectoryTreeNode**：树形目录结构，每个节点包含：
  - `name: String`
  - `filesystem: Arc<FileSystem>`
  - `file: Arc<dyn File>`
  - `father: Mutex<Weak<Self>>`
  - `children: RwLock<Option<BTreeMap<String, Arc<Self>>>>`
  - `spe_usage: Mutex<usize>`（特殊用途计数：cwd、mount point、root）
- 支持路径解析（`parse_dir_path`）、路径查找（`open`）、创建目录（`mkdir`）、删除（`delete`）、重命名（`rename`）
- 支持 `get_cwd()` 获取当前工作目录的绝对路径
- 全局 `ROOT` 节点和 `FILE_SYSTEM` 实例

#### 3.3.4 FAT32 实现（`fat32/`）

- **EasyFileSystem**：FAT32 文件系统实例
- **FatInode**：FAT32 inode 抽象
- **FatOSInode**：实现 `File` trait 的 FAT32 文件封装
- **layout.rs**（690 行）：FAT32 磁盘布局定义（BPB、FSInfo、FAT 表、目录项）
- **bitmap.rs**：FAT 表位图管理
- **dir_iter.rs**：目录迭代器
- 支持页缓存（`PageCache`）

#### 3.3.5 Ext4 实现（`ext4/`）

- **代码量**：约 6,000 行，是最复杂的子系统之一
- **ext4fs.rs**：Ext4 文件系统实例
- **ext4_inode.rs**（1,063 行）：Ext4 inode 操作
- **extent.rs**（1,491 行）：Ext4 extent 树实现（支持 extent 的创建、查找、插入、分裂）
- **layout.rs**（983 行）：Ext4 磁盘布局定义（超级块、块组描述符、inode 结构、目录项）
- **balloc.rs**（414 行）：块分配器
- **ialloc.rs**：inode 分配器
- **block_group.rs**（544 行）：块组管理
- **bitmap.rs**：位图操作
- **direntry.rs**（759 行）：目录项操作
- **superblock.rs**：超级块解析
- **crc.rs**：CRC 校验
- **file.rs**（680 行）：Ext4 文件读写
- **path.rs**：路径解析

#### 3.3.6 块缓存（`cache.rs`，521 行）

- **BufferCache**：块级缓存，包含优先级、block_id、dirty 标志、缓冲区
- **BlockCacheManager**：管理所有块缓存，支持 LRU 式回收（优先级递减后写回并释放）
- **PageCache**：页级缓存，用于文件内容的缓存
- **PageCacheManager**：页缓存管理器

#### 3.3.7 设备文件（`dev/`）

| 设备 | 文件 | 说明 |
|------|------|------|
| Pipe | `pipe.rs`（503 行） | 环形缓冲区实现的管道，支持读写端分离、阻塞等待 |
| Null | `null.rs` | /dev/null，读取返回 0 字节，写入丢弃 |
| Zero | `zero.rs` | /dev/zero，读取返回全零，写入丢弃 |
| TTY | `tty.rs`（484 行） | 终端设备，支持行缓冲、回显、信号生成 |
| HwClock | `hwclock.rs` | 硬件时钟设备 |
| Urandom | `urandom.rs` | 伪随机数生成器 |
| Socket | `socket.rs` | Socket 设备文件 |

#### 3.3.8 ProcFS（`procfs/`）

- **meminfo.rs**：`/proc/meminfo`，报告内存使用情况
- **interrupts.rs**：`/proc/interrupts`，报告中断统计
- **cpuinfo.rs**：`/proc/cpuinfo`（存在但功能有限）

#### 3.3.9 Poll 机制（`poll.rs`，402 行）

- 实现 `ppoll()` 和 `pselect6()` 系统调用
- 支持 `POLLIN`、`POLLOUT`、`POLLHUP`、`POLLERR`、`POLLNVAL` 等事件
- 支持超时和信号掩码

#### 3.3.10 文件描述符（`file_descriptor.rs`，468 行）

- **FileDescriptor**：封装 `cloexec`、`nonblock`、`file: Arc<dyn File>`
- **FdTable**：文件描述符表，支持 `insert`、`insert_at`、`get_ref`、`take`、`dup`

### 3.4 进程/任务管理

**位置**：`os/src/task/`

**总代码量**：约 3,500 行

#### 3.4.1 任务控制块（`task.rs`，710 行）

```rust
pub struct TaskControlBlock {
    pub pid: PidHandle,
    pub tid: usize,
    pub tgid: usize,
    pub kstack: KernelStack,
    pub ustack_base: usize,
    pub exit_signal: Signals,
    inner: Mutex<TaskControlBlockInner>,
    pub exe: Arc<Mutex<FileDescriptor>>,
    pub tid_allocator: Arc<Mutex<RecycleAllocator>>,
    pub files: Arc<Mutex<FdTable>>,
    pub socket_table: Arc<Mutex<SocketTable>>,
    pub fs: Arc<Mutex<FsStatus>>,
    pub vm: Arc<Mutex<MemorySet<PageTableImpl>>>,
    pub sighand: Arc<Mutex<Vec<Option<Box<SigAction>>>>>,
    pub futex: Arc<Mutex<Futex>>,
}
```

- **TaskControlBlockInner**：包含信号掩码/待处理信号、trap_cx_ppn、task_cx、task_status、parent/children、exit_code、clear_child_tid、robust_list、heap_bottom、pgid、rusage、clock、timer
- **TaskStatus**：Ready、Running、Interruptible、Zombie
- **ProcClock**：记录进入用户态/内核态的时间，用于计算 CPU 时间
- **Rusage**：资源使用统计（ru_utime、ru_stime 已实现，其余字段预留）
- **ITimerVal**：三种定时器（ITIMER_REAL、ITIMER_VIRTUAL、ITIMER_PROF）

#### 3.4.2 调度器（`manager.rs`，537 行）

- **算法**：FIFO 调度（`VecDeque` 就绪队列）
- **TaskManager**：
  - `ready_queue: VecDeque<Arc<TaskControlBlock>>`
  - `interruptible_queue: VecDeque<Arc<TaskControlBlock>>`
  - `active_tracker: ActiveTracker`（OOM 时跟踪任务激活状态）
- **等待队列**（`WaitQueue`）：使用 `VecDeque<Weak<TaskControlBlock>>` 实现，支持 `wake_at_most(n)` 唤醒
- **超时唤醒**：`wait_with_timeout()` 使用 `BinaryHeap`（最小堆）管理超时任务
- **OOM 处理**：`do_oom(req)` 遍历所有任务，先对 interruptible 任务执行 `do_deep_clean`，再对 ready 任务执行 `do_shallow_clean`

#### 3.4.3 处理器（`processor.rs`）

- **Processor**：单核处理器抽象，包含 `current: Option<Arc<TaskControlBlock>>` 和 `idle_task_cx: TaskContext`
- **run_tasks()**：主调度循环，不断从 `fetch_task()` 获取任务并切换执行
- 无任务时调用 `do_wake_expired()` 唤醒超时任务

#### 3.4.4 信号处理（`signal.rs`，679 行）

- **Signals**：64 位信号集（使用 `bitflags!`），覆盖标准 POSIX 信号（SIGHUP 到 SIGSYS）和实时信号（SIGRT_3 到 SIGRTMAX）
- **SigAction**：信号处理动作（handler、flags、mask、restorer）
- **SigActionFlags**：SA_NOCLDSTOP、SA_NOCLDWAIT、SA_SIGINFO、SA_ONSTACK、SA_RESTART、SA_NODEFER、SA_RESETHAND、SA_RESTORER
- **do_signal()**：在 `trap_return` 前检查并处理待处理信号
- 支持信号处理函数的安装（`sigaction`）、信号掩码（`sigprocmask`）、信号返回（`sigreturn`）
- 支持用户态信号栈（`SignalStack`）

#### 3.4.5 ELF 加载（`elf.rs`）

- 使用 `xmas-elf` 库解析 ELF 文件
- **load_elf_interp()**：加载 ELF 解释器（动态链接器）到内核空间
- **AuxvEntry**：辅助向量（AT_PHDR、AT_PHENT、AT_PHNUM、AT_PAGESZ、AT_BASE、AT_ENTRY、AT_RANDOM、AT_CLKTCK 等）
- 支持动态链接的 ELF 可执行文件

#### 3.4.6 线程支持（`threads.rs`）

- **Futex**（快速用户空间互斥锁）：
  - `BTreeMap<usize, WaitQueue>` 存储等待队列
  - 支持 `FUTEX_WAIT`（等待）、`FUTEX_WAKE`（唤醒）、`FUTEX_REQUEUE`（重新排队）
  - `do_futex_wait()`：原子比较并睡眠，支持超时
- **RecycleAllocator**：TID 分配器，支持回收

#### 3.4.7 PID 分配（`pid.rs`）

- **RecycleAllocator**：栈式分配器，支持回收
- **PidHandle**：RAII 封装，`Drop` 时自动回收 PID

### 3.5 系统调用

**位置**：`os/src/syscall/`

**总代码量**：约 4,700 行（`fs.rs` 2,174 行、`process.rs` 1,536 行、`errno.rs` 418 行、`mod.rs` 448 行）

#### 3.5.1 系统调用列表

共定义约 **117 个系统调用 ID**，按功能分类：

| 类别 | 系统调用 | 数量 |
|------|----------|------|
| 文件操作 | open/openat/close/read/write/lseek/dup/dup2/dup3/fcntl/ioctl/mkdirat/unlinkat/linkat/readlinkat/getdents64/fstat/fstatat/statx/sync/fsync/ftruncate/fallocate/sendfile/pread/pwrite/readv/writev/splice/copy_file_range/renameat2/faccessat/faccessat2/fchmodat/fchownat/utimensat/statfs/mount/umount2 | ~35 |
| 进程管理 | clone/execve/exit/exit_group/wait4/kill/tkill/tgkill/getpid/getppid/gettid/setpgid/getpgid/setsid/uname/getrusage/sysinfo/prlimit | ~17 |
| 内存管理 | mmap/munmap/mprotect/msync/brk/sbrk/madvise | 7 |
| 信号 | sigaction/sigprocmask/sigtimedwait/sigreturn | 4 |
| 时间 | clock_gettime/clock_nanosleep/nanosleep/getitimer/setitimer/times/get_time_of_day | 7 |
| 网络 | socket/bind/listen/accept/connect/getsockname/getpeername/sendto/recvfrom/setsockopt/getsockopt/socketpair/shutdown | 13 |
| 同步 | futex/set_tid_address/set_robust_list/get_robust_list/membarrier | 5 |
| 调度 | yield/sched_getaffinity | 2 |
| 其他 | getcwd/chdir/pipe2/pselect6/ppoll/syslog/umask/getrandom/shmget/shmctl/shmat/getuid/geteuid/getgid/getegid | ~16 |
| 非标准 | ls/shutdown/clear | 3 |

#### 3.5.2 关键系统调用实现

**clone**：支持 `CLONE_VM`（共享地址空间）、`CLONE_FS`（共享文件系统状态）、`CLONE_FILES`（共享文件描述符表）、`CLONE_SIGHAND`（共享信号处理）、`CLONE_THREAD`（线程）、`CLONE_PARENT_SETTID`、`CLONE_CHILD_SETTID`、`CLONE_CHILD_CLEARTID` 等标志。

**execve**：解析 ELF 文件，支持动态链接（加载解释器），构建用户栈（argv、envp、auxv），设置入口点。

**mmap**：支持 `MAP_SHARED`、`MAP_PRIVATE`、`MAP_ANONYMOUS`、`MAP_FIXED` 等标志，支持文件映射和匿名映射。

**splice**：在两个文件描述符之间传输数据，支持管道。

### 3.6 网络子系统

**位置**：`os/src/net/`

**总代码量**：约 1,200 行

#### 3.6.1 网络接口（`config.rs`）

- 基于 `smoltcp` 库实现
- 使用 `Loopback` 设备（回环接口），配置 IPv4 `127.0.0.1/8` 和 IPv6 `::1/128`
- **NetInterface**：封装 `Interface`、`SocketSet`、`Loopback` 设备
- 支持 `poll()` 轮询网络事件

#### 3.6.2 TCP Socket（`tcp.rs`，449 行）

- **TcpSocket**：封装 smoltcp 的 TCP socket
- 支持 `bind`、`listen`、`accept`、`connect`、`send`、`recv`、`shutdown`
- 支持 Nagle 算法控制和 Keep-Alive 设置
- 实现了 `File` trait，可作为文件描述符使用

#### 3.6.3 UDP Socket（`udp.rs`）

- **UdpSocket**：封装 smoltcp 的 UDP socket
- 支持 `bind`、`sendto`、`recvfrom`

#### 3.6.4 Unix Socket（`unix.rs`）

- **UnixSocket**：基于 Pipe 实现，但大部分方法为 `todo!()`
- `make_unix_socket_pair()` 函数存在但功能不完整
- **完整度**：低，基本不可用

### 3.7 驱动子系统

**位置**：`os/src/drivers/`

#### 3.7.1 块设备驱动

| 驱动 | 文件 | 说明 |
|------|------|------|
| VirtIO MMIO | `virtio_blk_mmio.rs` | RISC-V QEMU 平台使用，基于 `virtio-drivers` 库 |
| VirtIO PCI | `virtio_blk_pci.rs` | LoongArch 平台使用，PCI 总线上的 VirtIO 块设备 |
| SATA | `sata_blk.rs` | LoongArch 2K1000 开发板的 SATA 控制器 |
| 内存块设备 | `mem_blk.rs` | 将内存区域模拟为块设备（用于无磁盘环境） |

- **BlockDevice trait**：`read_block(block_id, buf)` 和 `write_block(block_id, buf)`
- **VirtioHal**：实现 `virtio-drivers` 的 HAL，处理 DMA 分配、物理/虚拟地址转换、缓冲区共享

#### 3.7.2 串口驱动

- **NS16550A**（`ns16550a.rs`）：标准 UART 驱动，实现 `embedded-hal` 的 `Write` trait
- 用于 LoongArch 平台的控制台输出

### 3.8 定时器（`timer.rs`，301 行）

- 提供 `get_time_sec()`、`get_time_ms()`、`get_time_us()`、`get_time_ns()` 等时间获取函数
- **TimeSpec**：秒 + 纳秒，支持加减运算和比较
- **TimeVal**：秒 + 微秒
- **ITimerVal**：间隔定时器（it_value + it_interval）
- **Times**：进程时间统计结构
- **TimeZone**：时区信息

### 3.9 控制台（`console.rs`，89 行）

- **KernelOutput**：实现 `core::fmt::Write`，通过 `console_putchar` 输出字符
- **Logger**：实现 `log::Log` trait，支持彩色输出和日志级别过滤
- 日志输出包含当前进程 PID

### 3.10 工具模块（`utils/`）

- **error.rs**：错误类型定义（`SyscallErr`、`SyscallRet`、`GeneralRet`）
- **random.rs**：伪随机数生成器（`RNG`），基于 `rand_core`

### 3.11 数学库（`math/`）

- 内核数学运算支持（内容较少）

## 四、子系统间交互

```
用户程序
    |
    v
[系统调用层] -- syscall() 分发
    |
    +---> [文件系统] ---> [VFS] ---> [FAT32/Ext4] ---> [块缓存] ---> [块设备驱动]
    |         |
    |         +---> [设备文件] (pipe/tty/null/zero/urandom)
    |         +---> [ProcFS] (meminfo/interrupts)
    |         +---> [Poll/Select]
    |
    +---> [进程管理] ---> [调度器] ---> [上下文切换]
    |         |
    |         +---> [信号处理] ---> [trap_return 前检查]
    |         +---> [ELF 加载] ---> [内存管理]
    |         +---> [Futex] ---> [等待队列]
    |
    +---> [内存管理] ---> [页表] ---> [HAL 页表实现]
    |         |
    |         +---> [帧分配器] ---> [OOM 处理]
    |         +---> [共享内存]
    |         +---> [Zram/Swap]
    |         +---> [CoW]
    |
    +---> [网络] ---> [smoltcp] ---> [Loopback 设备]
    |
    v
[HAL 层] ---> [LoongArch64/RISC-V64 架构实现]
    |
    +---> [异常/中断处理]
    +---> [定时器]
    +---> [串口驱动]
```

关键交互路径：
1. **系统调用路径**：用户态 -> trap -> trap_handler -> syscall() -> 具体实现 -> trap_return -> 用户态
2. **页面错误路径**：用户态访问 -> TLB miss/page fault -> trap_handler -> do_page_fault -> 分配/CoW/swap in -> 修复页表 -> trap_return
3. **调度路径**：定时器中断 -> trap_handler -> do_wake_expired -> suspend_current_and_run_next -> schedule -> __switch
4. **文件 I/O 路径**：sys_read -> FileDescriptor -> File trait -> 具体文件系统 -> BlockCache -> BlockDevice

## 五、实现完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| HAL（LoongArch64） | 90% | 启动、异常、TLB、上下文切换、寄存器封装完整；多核支持仅保留核心 0 |
| HAL（RISC-V64） | 85% | 标准实现完整；外部中断处理框架存在但具体设备中断处理未实现 |
| 物理帧分配器 | 90% | 栈式分配器 + OOM 处理完整 |
| 堆分配器 | 85% | buddy 算法实现，静态分配 |
| 页表管理 | 90% | 两套架构均实现，支持 CoW |
| 地址空间管理 | 85% | mmap/munmap/mprotect/fork 完整，madvise 为伪实现 |
| 共享内存 | 80% | 文件映射和匿名映射基本可用 |
| Zram | 85% | LZ4 压缩实现，容量固定 |
| Swap | 80% | 基本功能实现，容量固定 |
| FAT32 文件系统 | 85% | 读写、目录操作、页缓存完整 |
| Ext4 文件系统 | 80% | extent 支持完整，但部分高级特性（日志、扩展属性）未实现 |
| 目录树/VFS | 85% | 路径解析、挂载点管理完整 |
| 设备文件 | 80% | pipe/tty/null/zero/urandom 基本可用 |
| ProcFS | 40% | 仅 meminfo 和 interrupts，cpuinfo 不完整 |
| 进程管理 | 85% | fork/clone/exec/exit/wait 完整 |
| 调度器 | 70% | FIFO 调度，无优先级、无时间片轮转 |
| 信号处理 | 85% | 64 种信号、sigaction/sigprocmask/sigreturn 完整 |
| 线程支持 | 80% | clone + futex 基本可用 |
| 系统调用 | 80% | 117 个 ID，大部分有实现，部分为桩函数 |
| TCP 网络 | 70% | 基于 smoltcp，仅回环接口 |
| UDP 网络 | 70% | 基于 smoltcp，仅回环接口 |
| Unix Socket | 10% | 大部分方法为 todo!() |
| 块设备驱动 | 85% | VirtIO MMIO/PCI、SATA、内存块设备 |
| 串口驱动 | 80% | NS16550A 实现 |
| 定时器 | 85% | 三种 itimer + clock_gettime 完整 |
| Poll/Select | 80% | ppoll 和 pselect6 实现 |

**整体完整度**：约 **78%**（以能运行 bash shell 和基本用户程序为基准）。

## 六、设计创新性

### 6.1 双架构 HAL 设计
项目通过 `hal/arch/mod.rs` 的条件编译实现了 LoongArch64 和 RISC-V64 的统一抽象。两套架构共享相同的 `PageTable` trait、`TrapContext` 接口和 `KernelStack` 抽象，使得上层代码（内存管理、进程管理、文件系统）完全架构无关。这种设计在竞赛项目中较为少见。

### 6.2 LAFlex 页表
LoongArch64 的页表实现（`laflex.rs`）并非简单移植 RISC-V 的 Sv39，而是针对 LoongArch64 的 TLB Refill 机制进行了优化。`__rfill` 函数使用内联汇编直接在 TLB Refill 异常中完成页表查找和 TLB 填充，避免了完整的异常处理流程，显著降低了 TLB miss 的开销。

### 6.3 多层 OOM 处理机制
当物理内存不足时，系统采用分层策略：
1. 清理文件系统块缓存（`BlockCacheManager::oom`）
2. 清理当前任务的非活跃页面（`do_shallow_clean`）
3. 遍历所有任务进行深度清理（`do_deep_clean`），包括压缩（zram）和交换（swap）
4. 使用 `ActiveTracker` 位图避免重复清理

### 6.4 Frame 状态机
`Frame` 枚举将物理帧的状态（InMemory/Compressed/SwappedOut/Unallocated）统一管理，配合 `Arc` 引用计数实现了 CoW 和页面迁移的无缝切换。

### 6.5 目录树缓存
`DirectoryTreeNode` 使用 `Weak` 引用和 `DIRECTORY_VEC` 全局缓存，配合延迟清理策略（计数器达到一半时批量更新），减少了目录查找的开销。

## 七、其他信息

### 7.1 用户态

- **user_lib**：封装了系统调用接口的用户态库
- **initproc**：三个变体
  - `initproc.rs`：标准初始化进程，启动 bash shell
  - `initproc-comp.rs`：竞赛模式，自动运行测试套件
  - `initproc-normal.rs`：普通模式
- 根文件系统镜像包含 bash shell 和 terminfo 配置
- 附带 busybox/lua 测试套件（LoongArch64 和 RISC-V64 两套）

### 7.2 构建系统

- 使用 GNU Make 编排构建流程
- 支持 `MODE=release/debug`、`BLK_MODE=virt/sata/mem`、`FS_MODE=ext4/fat32` 等配置
- 文件系统镜像通过 `buildfs.sh` 脚本生成（脚本未在仓库中找到）
- 竞赛模式使用 `comp` feature，将 initproc 和 bash 预加载到内核镜像中

### 7.3 依赖库

| 库 | 用途 |
|----|------|
| `lazy_static` | 全局静态变量初始化 |
| `buddy_system_allocator` | 内核堆分配器 |
| `spin` | 自旋锁（Mutex、RwLock） |
| `bitflags` | 标志位操作 |
| `xmas-elf` | ELF 文件解析 |
| `virtio-drivers` | VirtIO 设备驱动 |
| `smoltcp` | TCP/IP 协议栈 |
| `lz4_flex` | LZ4 压缩（zram） |
| `downcast-rs` | trait 对象向下转型（VFS/File） |
| `num_enum` | 枚举与整数转换 |
| `log` | 日志框架 |
| `managed` | smoltcp 依赖 |

### 7.4 已知限制

1. **单核支持**：仅使用 CPU 0，其余核心进入死循环
2. **网络仅回环**：未实现真实的网络设备驱动，仅支持 loopback
3. **Unix Socket 未实现**：大部分方法为 `todo!()`
4. **调度器简单**：FIFO 调度，无优先级和时间片
5. **ProcFS 不完整**：仅 meminfo 和 interrupts
6. **部分系统调用为桩函数**：如 `madvise`、`membarrier`、`syslog` 的部分操作
7. **无 SMP 支持**：所有锁均为单核假设下的自旋锁
8. **无安全机制**：无用户/组权限检查（getuid/getgid 返回固定值）

## 八、总结

NPUcore-Aspera 是一个功能较为完整的操作系统内核项目，在竞赛级别的 OS 内核中属于较高水平。其核心优势在于：

1. **双架构支持**：通过精心设计的 HAL 层同时支持 LoongArch64 和 RISC-V64，代码复用率高。
2. **内存管理完善**：实现了 CoW、mmap、共享内存、zram 压缩、swap 交换、OOM 处理等多层内存管理机制。
3. **文件系统丰富**：同时支持 FAT32 和 Ext4（含 extent），并实现了 VFS 层、目录树缓存、页缓存、多种设备文件和 procfs。
4. **系统调用覆盖广**：117 个系统调用 ID，覆盖了文件操作、进程管理、信号、网络、同步等核心功能。
5. **信号处理完整**：64 种信号、sigaction/sigprocmask/sigreturn、用户态信号栈。

主要不足在于调度器过于简单（FIFO）、网络仅支持回环、Unix Socket 未实现、单核限制以及部分系统调用为桩函数。整体实现完整度约 78%，能够支持 bash shell 和基本用户程序的运行。