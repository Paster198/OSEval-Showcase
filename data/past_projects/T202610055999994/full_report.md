# PwnMyOS 操作系统内核技术分析报告

## 一、分析过程概述

本报告基于对 PwnMyOS 仓库的全面源代码审阅、项目结构分析和实际构建与运行测试。分析过程包括：

1. **静态代码分析**：逐一阅读了所有 Rust 源文件（约 14,891 行内核代码 + lwext4_rust + user 库），涵盖 `os/src/` 下 10 个子系统的全部模块。
2. **构建验证**：使用环境提供的 Rust 工具链（nightly-2025-01-31）成功交叉编译了 RISC-V64 目标的内核 ELF 文件。
3. **运行测试**：在 QEMU (v8.2.2) RISC-V64 虚拟机中成功启动了内核，观察到完整的启动序列：OpenSBI -> polyhal 初始化 -> 内存初始化 -> virtio-blk 驱动加载 -> ext4 文件系统挂载 -> 读取并执行 init 进程。

---

## 二、项目总体概况

PwnMyOS 是基于 **Nonix** 继续开发的 OS 内核项目，目标参加 2026 年全国大学生计算机系统能力大赛（操作系统设计赛）。使用 **Rust** 语言编写，主要支持 **RISC-V64** 和 **LoongArch64** 两种架构（通过条件编译 `#[cfg(target_arch)]` 实现）。

### 代码规模

| 子系统 | 文件数 | 代码行数 |
|--------|--------|----------|
| 系统调用 (syscall/) | 6 | ~4,130 |
| 文件系统 (fs/) | 14 | ~4,385 |
| 任务管理 (task/) | 7 | ~2,040 |
| 内存管理 (mm/) | 8 | ~2,021 |
| 设备驱动 (drivers/) | 5 | ~683 |
| 工具/辅助 (utils/) | 4 | ~549 |
| 信号处理 (signal/) | 4 | ~323 |
| 陷阱/中断 (trap/) | 2 | ~173 |
| 配置 (config/) | 3 | ~68 |
| 同步原语 (sync/) | 2 | ~44 |
| 顶层 (main, lang_items, etc.) | 5 | ~375 |
| **总计** | | **~14,791** |

---

## 三、子系统详细分析

### 3.1 系统调用子系统 (syscall/)

系统调用是本项目中最大的模块，约 4,130 行代码，定义了 **100+ 个系统调用号**，覆盖了类 Linux 系统调用的主要类别。

#### 系统调用号常量定义（`syscall/mod.rs`）

系统调用号在 `mod.rs` 中以 `const SYSCALL_XXX: usize = N;` 的形式定义，例如：

```rust
const SYSCALL_READ: usize = 63;
const SYSCALL_WRITE: usize = 64;
const SYSCALL_OPENAT: usize = 56;
const SYSCALL_CLOSE: usize = 57;
const SYSCALL_EXIT: usize = 93;
const SYSCALL_EXITGROUP: usize = 94;
const SYSCALL_CLONE: usize = 220;
const SYSCALL_EXEC: usize = 221;
const SYSCALL_MMAP: usize = 222;
const SYSCALL_FUTEX: usize = 98;
const SYSCALL_SIGACTION: usize = 134;
```

系统调用分发函数 `syscall()` 通过 `match syscall_id { ... }` 将请求路由到对应的处理函数。

#### 实现的系统调用功能分组

**A. 进程管理（`syscall/process.rs`，~927行）**
- `sys_exit` / `sys_exit_group`：进程和进程组退出
- `sys_futex`：支持 `FUTEX_WAIT`、`FUTEX_WAKE`、`FUTEX_WAIT_BITSET`、`FUTEX_WAKE_BITSET` 等操作
- `sys_set_robust_list` / `sys_settidaddr`：robust futex 支持
- `sys_clone`：支持多标志位（见下文 CloneFlags），含架构特定的参数规范化
- `sys_exec`：进程执行，包含 **ELF 加载**、**shebang 脚本支持**（`#!`）、**busybox applet 路由**、**PATH 环境变量搜索**
- `sys_wait4`：阻塞和非阻塞等待（支持 `WNOHANG`、`WUNTRACED`、`WCONTINUED`）
- `sys_nanosleep` / `sys_clock_nanosleep`：高精度睡眠
- `sys_getpid` / `sys_getppid` / `sys_gettid` / `sys_getpgid` / `sys_setpgid`
- `sys_getuid` / `sys_geteuid` / `sys_getgid` / `sys_getegid` / `sys_setuid` / `sys_setgid` / `sys_setresuid` / `sys_setresgid` / `sys_getgroups` / `sys_setgroups`
- `sys_prlimit`：资源限制（仅完整实现 `RLIMIT_NOFILE`）
- `sys_sched_*`：调度器相关系统调用（占位实现，返回默认值）
- `sys_times` / `sys_gettimeofday` / `sys_clock_gettime` / `sys_clock_getres`

**B. 文件系统（`syscall/fs.rs`，~1,596行）**
- `sys_openat`、`sys_close`、`sys_read`、`sys_write`、`sys_readv`、`sys_writev`、`sys_pread64`、`sys_lseek`
- `sys_getcwd`、`sys_chdir`
- `sys_dup`、`sys_dup3`、`sys_fcntl`（支持 `F_DUPFD`、`F_DUPFD_CLOEXEC`、`F_GETFD`、`F_SETFD`、`F_GETFL`）
- `sys_mkdirat`、`sys_unlinkat`、`sys_symlinkat`、`sys_linkat`、`sys_renameat2`
- `sys_getdents64`：目录迭代
- `sys_fstat`、`sys_fstatat`、`sys_statfs`、`sys_statx`
- `sys_faccessat`、`sys_fchmod`、`sys_fchmodat`、`sys_fchown`、`sys_fchownat`
- `sys_ftruncate`、`sys_fsync`、`sys_fdatasync`
- `sys_mount`、`sys_umount2`、`sys_pipe2`
- `sys_readlinkat`
- `sys_ppoll`（文件描述符轮询）
- `sys_sendfile` / `sys_copy_file_range` / `sys_splice`：数据传输
- `sys_utimensat`：支持 `UTIME_NOW` 和 `UTIME_OMIT`

**C. 内存管理（`syscall/mm.rs`，~315行）**
- `sys_brk`：进程堆边界调整
- `sys_mmap`：文件映射和匿名映射，支持 `MAP_PRIVATE`、`MAP_ANONYMOUS`、`MAP_FIXED` 等标志
- `sys_munmap`：解除内存映射
- `sys_mprotect`：修改内存保护属性
- `sys_m lock` / `sys_munlock` / `sys_mlockall` / `sys_munlockall`：占位实现（总是返回成功）
- `sys_shmget` / `sys_shmctl` / `sys_shmat` / `sys_shmdt`：System V 共享内存（返回 `ENOSYS`）

**D. 信号处理（`syscall/signal.rs`，~400行）**
- `sys_sig_kill`：支持向进程、进程组（`pid=0`）和所有进程（`pid=-1`）发送信号
- `sys_tgkill`：向线程组中的特定线程发送信号
- `sys_rt_sigaction`：设置信号处理动作（含用户-内核信号集格式转换）
- `sys_sig_proc_mask`：进程信号掩码管理（`SIG_BLOCK`、`SIG_UNBLOCK`、`SIG_SETMASK`）
- `sys_sig_suspend`：占位实现
- `sys_sig_timed_wait`：超时等待信号
- `sys_sig_return`：信号处理返回

**E. 网络相关（`syscall/fs.rs` 末尾）**
- `sys_socket`、`sys_socketpair`、`sys_bind`、`sys_listen`、`sys_accept`、`sys_accept4`
- `sys_connect`、`sys_getsockname`、`sys_getpeername`、`sys_setsockopt`、`sys_getsockopt`
- `sys_sendto`、`sys_recvfrom`、`sys_shutdown`
- 大部分返回 `ENOSYS`

**F. 其他**
- `sys_uname`：返回系统信息
- `sys_getrandom`：随机数（占位）
- `sys_syslog`：占位实现

#### CloneFlags 设计（`syscall/option.rs`）

```rust
bitflags! {
    pub struct CloneFlags: u32 {
        const SIGCHLD           = 0x00000011;
        const SHARE_VM          = 0x00000100;
        const SHARE_FS          = 0x00000200;
        const SHARE_FILES       = 0x00000400;
        const SHARE_SIGHANDLER  = 0x00000800;
        const VFORK             = 0x00004000;
        const THREAD_GROUP      = 0x00010000;
        const SET_TLS           = 0x00080000;
        const PARENT_SETTID     = 0x00100000;
        const CHILD_CLEARTID    = 0x00200000;
        const CHILD_SETTID      = 0x01000000;
        // ... 更多标志
    }
}
```

包含 `validate_pthread()` 方法来验证 POSIX 线程所需的标志组合。

#### 特殊的兼容层处理

在 `syscall/process.rs` 和 `syscall/fs.rs` 中，存在大量的 **busybox applet 路由逻辑** 和 **LTP 测试兼容层**。例如：

- `should_try_busybox_applet()`：判断路径是否应路由到 busybox
- `ltp_file_path_for_cwd()`：将 LTP 辅助文件路由到正确的 C 库目录
- Glibc/Musl 目录结构的区分处理（`/glibc/` 和 `/musl/` 子目录）
- Shebang 脚本解析：`shebang_line()` 和 `parse_shebang()` 函数

---

### 3.2 文件系统子系统 (fs/)

约 4,385 行代码，采用分层架构：

```
应用层
  ↓
open() / read() / write()   (VFS 接口 - fs/inode.rs)
  ↓
File trait 实现层
  ├── OSInode (ext4 文件, fs/inode.rs)
  ├── Pipe     (管道, fs/pipe.rs)
  ├── Socket   (套接字占位, fs/socket.rs)
  ├── Stdin/Stdout (标准IO, fs/stdio.rs)
  ├── DevZero/DevNull/DevRtc/DevRandom/DevTty  (设备文件, fs/devfs.rs)
  ├── VirtFile/StaticVirtFile/ProcPidFile (虚拟文件, fs/vfs_registry.rs)
  └── FileClass (统一分发, fs/mod.rs)
  ↓
ext4 后端 (fs/ext4_lw/)
  ├── Ext4Inode (lwext4_rust 封装)
  └── Ext4SuperBlock (超级块)
  ↓
lwext4_rust (C FFI 绑定)
  └── lwext4 C 库 (ext4 实现)
  ↓
virtio-blk (块设备驱动, drivers/)
```

#### File trait 设计（`fs/mod.rs`）

```rust
pub trait File: Send + Sync {
    fn readable(&self) -> bool;
    fn writable(&self) -> bool;
    fn read(&self, buf: UserBuffer) -> usize;
    fn write(&self, buf: UserBuffer) -> usize;
    fn fstat(&self) -> Kstat;
    fn get_dirent(&self, dirent: &mut Dirent) -> isize;
    fn get_name(&self) -> String;
    fn set_offset(&self, offset: usize);
    fn poll(&self, events: PollEvents) -> PollEvents;
}
```

这是整个文件系统的统一抽象接口，所有文件类型（ext4 inode、管道、设备文件、虚拟 proc 文件等）都实现此 trait。

#### FileClass 分发机制

```rust
pub enum FileClass {
    Abs(Arc<dyn File>),     // 抽象文件（管道、socket、设备等）
    Os(Arc<OSInode>),       // ext4 文件系统文件
}
```

通过 `FileClass` 在抽象文件和 ext4 文件之间统一分发 `read/write` 等操作。

#### 管道实现（`fs/pipe.rs`）

环形缓冲区设计：
- `PipeRingBuffer`：32 字节固定大小的环形缓冲区
- 支持 `Full`、`Empty`、`Normal` 三种状态
- 使用弱引用追踪读端/写端关闭（`write_end: Option<Weak<Pipe>>`）
- `splice_from_pipe` / `splice_to_pipe`：支持 `splice` 系统调用的零拷贝数据传输
- `make_pipe()` 工厂函数创建读写对

#### 虚拟文件系统注册表（`fs/vfs_registry.rs`）

支持三种虚拟文件类型：
1. **VirtFile**：带偏移量的可读虚拟文件（如 `/proc/interrupts`）
2. **StaticVirtFile**：静态内容虚拟文件（如 `/proc/meminfo`、`/proc/cpuinfo`）
3. **ProcPidFile**：动态生成的 `/proc/<pid>/stat` 和 `/proc/<pid>/status`

在 `fs/mod.rs` 中还硬编码了大量 proc 文件系统的内容常量（`MEMINFO`、`CPUINFO`、`PROC_STAT`、`LOADAVG` 等），用于模拟 `/proc` 文件系统。

#### 设备文件系统（`fs/devfs.rs`）

实现了以下设备文件：
- `/dev/zero`：`DevZero` - 读取返回全零
- `/dev/null`：`DevNull` - 读取返回空，写入丢弃
- `/dev/rtc`、`/dev/rtc0`、`/dev/misc/rtc`：`DevRtc` - 返回固定时间
- `/dev/random`、`/dev/urandom`：`DevRandom` - 返回确定性伪随机序列
- `/dev/tty`：`DevTty` - 代理 stdin/stdout
- `/dev/cpu_dma_latency`：`DevCpuDmaLatency`

通过设备注册表（`DeviceRegistry`）管理设备号分配。

#### Socket 占位实现（`fs/socket.rs`）

**最小化 socket 实现**：`Socket` 结构体存储 `domain`、`sock_type`、`protocol`，`read` 返回 0，`write` 返回 `buf.len()`（黑洞/空源），让 LTP 测试能够通过 `socket()` 调用并推进到下一个系统调用。没有真实的网络栈。

#### ext4 文件系统绑定（`fs/ext4_lw/`）

- `Ext4SuperBlock`：封装 lwext4 的超级块操作，通过 `BlockDeviceImpl`（virtio-blk）访问底层块设备
- `Ext4Inode`：对 lwext4 C 库 `Ext4File` 的 Rust 安全封装，使用 `UPSafeCell` 实现内部可变性
- 支持文件创建、目录创建、读写、截断等操作

#### lwext4_rust crate

- `build.rs` 通过 `git submodule` 拉取 lwext4 C 库源码
- 使用 `bindgen` 自动生成 Rust FFI 绑定
- 编译时依赖对应架构的 C 交叉编译器（`riscv64-linux-musl-gcc` 或 `loongarch64-linux-musl-gcc`）
- `blockdev.rs`：将 Rust 块设备驱动适配到 lwext4 的 `KernelDevOp` trait
- `file.rs`：对 lwext4 文件操作的封装
- `ulibc.rs`：为 lwext4 C 库提供用户态 libc 函数的替代实现

---

### 3.3 任务管理子系统 (task/)

约 2,040 行代码，实现了进程/线程的完整生命周期管理。

#### 核心数据结构（`task/task.rs`）

```rust
pub struct TaskControlBlock {
    pub pid: PidHandle,                    // 不可变：进程ID
    inner: UPSafeCell<TaskControlBlockInner>,
}

pub struct TaskControlBlockInner {
    pub trap_cx: TrapFrame,                // 陷入帧
    pub task_cx: KContext,                 // 内核上下文
    pub task_status: TaskStatus,           // 任务状态
    pub memory_set: Arc<MemorySet>,        // 地址空间
    pub kernel_stack: KernelStack,         // 内核栈
    pub parent: Option<Weak<TaskControlBlock>>,  // 父进程
    pub children: Vec<Arc<TaskControlBlock>>,    // 子进程列表
    pub exit_code: i32,                    // 退出码
    pub fd_table: Arc<FdTable>,            // 文件描述符表
    pub sig_table: Arc<SigTable>,          // 信号表
    pub signals: SignalFlags,              // 待处理信号集
    pub signal_mask: SignalFlags,          // 信号掩码
    pub handling_sig: isize,               // 正在处理的信号
    pub killed: bool,                      // 是否被杀死
    pub frozen: bool,                      // 是否冻结
    pub fsinfo: Arc<FsInfo>,               // 文件系统信息(CWD等)
    pub time_data: TimeData,               // 时间统计
    pub user_stack_top: usize,             // 用户栈顶
    pub clear_child_tid: Option<usize>,    // CLONE_CHILD_CLEARTID
    pub robust_list: RobustList,           // robust futex 列表
    pub pgid: usize,                       // 进程组ID
    pub uid: u32, euid: u32,               // 用户ID
    pub gid: u32, egid: u32,               // 组ID
    pub adopted_by_init: bool,             // 是否被init收养
    // ...
}
```

#### 调度器（`task/manager.rs` + `task/processor.rs`）

- **FIFO 调度器**：`TaskManager` 使用 `VecDeque` 实现的简单先入先出队列
- **全局任务映射**：`PID2TCB: BTreeMap<usize, Arc<TaskControlBlock>>` 通过 PID 索引所有任务
- `Processor`：每核处理器状态，包含 `current` 任务和 `idle_task_cx`（空闲上下文）
- 上下文切换通过 `polyhal::kcontext::context_switch_pt()` 实现，该函数同时切换上下文和页表

#### PID 分配器（`task/pid.rs`）

```rust
pub struct PidAllocator {
    current: usize,          // 当前最大PID
    recycled: Vec<usize>,    // 回收的PID列表
}
```

支持 PID 回收重用，通过 `PidHandle` 的 RAII 模式在 Drop 时自动回收 PID。

#### 关键生命周期函数

- `exit_current_and_run_next()`：最复杂的函数（约 70 行），处理：
  1. 将僵尸子进程收养给 INITPROC
  2. `clear_child_tid` 的 futex 唤醒
  3. 内存回收和数据页释放
  4. 文件描述符表清理
  5. 向父进程发送 `SIGCHLD`

- `exit_current_group_and_run_next()`：线程组退出，向共享地址空间或信号表的所有任务发送 `SIGKILL`

- `suspend_current_and_run_next()`：挂起当前任务，放入就绪队列，调度下一个

- `TaskControlBlock::new()`：创建新任务，包含：
  1. ELF 加载到 MemorySet
  2. 用户栈分配（`lazy_insert_framed_area_with_hint`）
  3. 信号表和文件描述符表的初始化
  4. aux vector 设置（`Aux`）
  5. 进程凭证初始化和 CloneFlags 派生

---

### 3.4 内存管理子系统 (mm/)

约 2,021 行代码，实现基于 SV39（RISC-V）的虚拟内存管理。

#### 物理页帧分配器（`mm/frame_allocator.rs`）

- 使用 `buddy_system_allocator::FrameAllocator` 伙伴系统分配器
- `FrameTracker`：RAII 包装的物理页帧，Drop 时自动归还
- `frame_alloc()`：分配单页，返回 `Arc<FrameTracker>`
- `frames_alloc(count)`：分配多页连续物理内存（用于 DMA）
- `frame_alloc_persist()`：分配单页但返回裸 `PhysAddr`（用于页表等长期持有）
- `add_frames_range()`：将物理内存范围注册到分配器（由 `main()` 中的 `get_mem_areas()` 驱动）

#### 堆分配器（`mm/heap_allocator.rs`）

- 使用 `buddy_system_allocator::LockedHeap<32>` 作为内核全局分配器（`#[global_allocator]`）
- 256MB 内核堆空间（`KERNEL_HEAP_SIZE = 0x1000_0000`）
- 带有 `alloc_error_handler` 的 panic 处理

#### 页表管理（`mm/page_table.rs`）

提供了一系列用户-内核数据传输辅助函数：
- `translated_byte_buffer()`：将用户指针转为内核可访问的字节切片
- `translated_str()` / `try_translated_str()`：从用户空间读取字符串
- `translated_ref()` / `translated_refmut()`：从用户空间读取/写入引用
- `get_data()` / `put_data()`：直接读写用户空间数据（依赖当前页表）
- `UserBuffer`：跨页的用户缓冲区抽象，支持 `write()` 和迭代器

#### 内存集（`mm/memory_set.rs`）

```rust
pub struct MemorySet { inner: MutexNoIrq<MemorySetInner> }

pub struct MemorySetInner {
    pub page_table: Arc<PageTableWrapper>,
    pub areas: Vec<MapArea>,
}
```

- 使用 `MutexNoIrq` 保护，确保中断安全
- 支持 **懒分配**（lazy allocation）：`lazy_page_fault()` 在缺页时按需分配物理页
- 支持 **写时复制**（COW）：`cow_page_fault()` 处理 `StorePageFault`
- `mmap()`：支持匿名映射和文件映射
- `munmap()`：解除映射并释放物理页
- `mprotect()`：修改映射区域的保护属性
- `from_existed_user()`：fork 时从已有 MemorySet 创建新的（COW 语义）
- `shallow_clone()`：浅拷贝（共享页表，用于线程）
- `recycle_data_pages()`：进程退出时回收数据页

#### 内存区域（`mm/map_area.rs`）

```rust
pub struct MapArea {
    pub vaddr_range: VAddrRange,
    pub data_frames: BTreeMap<VirtAddr, Arc<FrameTracker>>,
    map_type: MapType,          // Linear 或 Framed
    pub map_perm: MapPermission, // R/W/X/U 权限
    pub area_type: MapAreaType, // Stack/Elf/Brk/Mmap
    pub mmap_file: MmapFile,    // mmap 关联的文件
    pub mmap_flags: MmapFlags,
    pub groupid: usize,         // 共享组ID
}
```

- `MapAreaType` 枚举：`Stack`、`Elf`、`Brk`、`Mmap`
- `MapType` 枚举：`Linear`（直接映射）和 `Framed`（按需分页）
- `MapPermission` 支持 `R`、`W`、`X`、`U` 四位标志
- 共享内存通过 `GROUP_SHARE` 全局注册表实现引用计数管理

#### 地址空间布局（`config/mod.rs` + `config/rv.rs`）

```
RISC-V64:
  USER_SPACE:   0x0000_0000_0000_0000 - 0x0000_003F_FFFF_FFFF (256GB)
  KERNEL_SPACE: 0xFFFF_FFC0_0000_0000 - 0xFFFF_FFFF_FFFF_FFFF
  KERNEL_BASE:  0xFFFFFFC080200000
  USER_STACK_TOP: USER_SPACE_MAX (0x3F_FFFF_FFFF)

LoongArch64:
  KERNEL_BASE:  0x9000000080000000
  KERNEL_SPACE_BASE: 0x9000_0000_0000_0000
```

---

### 3.5 信号处理子系统 (signal/)

约 323 行代码，实现了 POSIX 信号机制的基本框架。

#### 信号定义（`signal/sigflags.rs`）

定义了 32 个标准信号（SIGHUP=1 到 SIGSYS=31）和 32 个实时信号（SIGRTMIN=32 到 SIGRTMAX=63），使用 `SignalFlags: u64` 的 bitflags 表示。包含默认信号动作映射：

- **Terminate**：SIGHUP, SIGINT, SIGKILL, SIGUSR1/2, SIGPIPE, SIGALRM, SIGTERM 等
- **CoreDump**：SIGQUIT, SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGSEGV 等
- **Ignore**：SIGCHLD, SIGURG, SIGWINCH
- **Stop**：SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU
- **Continue**：SIGCONT

#### 信号动作（`signal/sigact.rs`）

```rust
#[repr(C)]
pub struct SigAction {
    pub sa_handler: usize,         // 信号处理函数地址
    pub sa_flags: SigActionFlags,  // SA_NOCLDSTOP, SA_SIGINFO 等
    pub sa_restore: usize,         // sigreturn trampoline 地址
    pub sa_mask: SignalFlags,      // 处理期间的临时信号掩码
}
```

- `KSigAction` 封装了 `SigAction` 和 `customed` 标志（区分默认处理和自定义处理）
- 支持 `SIG_DFL`（默认动作）、`SIG_IGN`（忽略）、用户自定义处理函数

#### 信号表（`signal/sigtable.rs`）

`SigTable` 为每个信号维护一个 `KSigAction` 数组（`[KSigAction; MAX_SIG + 1]`），支持克隆时共享（`Arc<SigTable>`）。

#### 信号处理流程（`task/mod.rs` 中的 `handle_signals()`）

1. 检查待处理信号和信号掩码
2. 对每个未屏蔽信号，查找信号动作
3. 对 `SIG_DFL` 执行默认动作（Terminate/CoreDump/Stop/Continue/Ignore）
4. 对自定义处理函数，设置用户态信号栈帧（含 ucontext 和 sigmask）
5. 修改 trapframe 中的 `sepc` 跳转到信号处理函数

---

### 3.6 陷阱/中断处理 (trap/)

约 173 行代码，实现内核陷入处理核心。

#### 内核中断处理函数（`trap/mod.rs`）

使用 `#[polyhal::arch_interrupt]` 属性宏标记，处理以下陷入类型：

| 陷入类型 | 处理方式 |
|----------|----------|
| `Breakpoint` | 直接返回（忽略） |
| `Irq(irq_vector)` | 增加中断计数（`inc_irq_count`） |
| `SysCall` | 提取参数，调用 `syscall()`，将结果写入 `ctx[RET]` |
| `StorePageFault` / `LoadPageFault` | 尝试懒分配（`lazy_page_fault`），再尝试 COW（`cow_page_fault`），均失败则杀死进程 |
| `InstructionPageFault` | 杀死进程，发送 `SIGSEGV` |
| `IllegalInstruction` | 发送 `SIGILL` |
| `Timer` | 增加时钟中断计数，触发调度（`suspend_current_and_run_next`） |

中断处理完毕后，依次执行：
1. `current_poll_real_timer()`：检查实时定时器
2. `handle_signals()`：处理待处理的信号
3. 检查 `killed` 标志，若为 true 则调用 `exit_current_and_run_next`

#### 中断统计（`trap/interrupts.rs`）

全局中断计数器 `IRQ_COUNTS: Mutex<[usize; 64]>`，在 `/proc/interrupts` 虚拟文件中暴露。

---

### 3.7 设备驱动子系统 (drivers/)

约 683 行代码，实现 virtio-blk 块设备驱动。

#### 架构适配（`drivers/virtio_blk.rs`）

- **RISC-V**：使用 MMIO 传输（`MmioTransport`），设备位于 `0x10001000 | VIRT_ADDR_START`
- **LoongArch**：使用 PCI 传输（`PciTransport`），通过 `PciRoot<MmioCam>` 枚举 PCI 总线查找 virtio block 设备

#### VirtioHal 实现

```rust
unsafe impl Hal for VirtioHal {
    fn dma_alloc(pages: usize, _direction: BufferDirection) -> (usize, NonNull<u8>) {
        // 使用 frames_alloc() 分配连续物理页
        // 通过 QUEUE_FRAMES 追踪分配的内存
    }
    fn dma_dealloc(paddr: usize, pages: usize) -> i32 { ... }
    fn phys_to_virt(paddr: usize) -> NonNull<u8> { ... }
    fn virt_to_phys(vaddr: usize) -> usize { ... }
}
```

#### BlockDriver trait（`drivers/device.rs`）

定义了块设备驱动的标准接口：
- `num_blocks()`、`block_size()`、`read_block()`、`write_block()`、`flush()`

#### Disk 抽象（`drivers/disk.rs`）

在 `BlockDriver` 之上实现了带游标的块设备访问：
- `read_one()` / `write_one()`：支持跨块边界的单次读写
- `set_position()` / `position()`：游标定位

---

### 3.8 同步原语 (sync/)

极简实现，仅 44 行代码。

```rust
pub struct UPSafeCell<T> {
    inner: RefCell<T>,
}
unsafe impl<T> Sync for UPSafeCell<T> {}
```

- 基于 `RefCell` 的单核内部可变性封装
- `exclusive_access()`：获取可变借用，已被借用时 panic
- `try_exclusive_access()`：获取可变借用，已被借用时返回 `None`
- `unsafe impl Sync` 允许在全局静态变量中使用

---

### 3.9 配置与架构适配 (config/)

- `config/mod.rs`：定义通用常量（`PAGE_SIZE=0x1000`、`USER_STACK_SIZE=20KB`、`KERNEL_HEAP_SIZE=256MB`、`USER_HEAP_SIZE=256MB`）
- `config/rv.rs`：RISC-V64 特定常量（内核基址 `0xFFFFFFC080200000`、时钟频率 12.5MHz、`TIMER_IRQ=5`）
- `config/la.rs`：LoongArch64 特定常量（内核基址 `0x9000000080000000`、时钟频率 25MHz、`TIMER_IRQ=11`）

操作系统标识常量：`OS_NAME="NonixOS"`、`OS_RELEASE="5.15.0"`。

---

### 3.10 用户态库 (user/)

独立的 Rust crate，为内核之上的用户程序提供运行时支持：

- `lib.rs`：`_start` 入口，解析 argc/argv，初始化用户堆（32KB buddy allocator），调用 `main()`
- `syscall.rs`：为 `riscv64`/`aarch64`/`x86_64`/`loongarch64` 四种架构提供 ecall/syscall 封装
- `console.rs`：`print!`/`println!` 宏（通过 `sys_write`）
- `linker.ld`：用户程序链接脚本
- `bin/` 目录：包含 `initproc.rs`、`test.rs`、`user_shell.rs`、`finaltest.rs` 等测试程序

---

## 四、构建与运行测试结果

### 构建测试

**内核编译**：使用 `LOG=info INIT_BINARY_PATH=... cargo build --release --target riscv64gc-unknown-none-elf` 成功编译，生成约 21MB 的 ELF 文件。编译过程出现以下警告：

1. `semicolon_in_expressions_from_macros`：`print!` 宏中多余的分号
2. `static_mut_refs`：对可变静态变量的共享引用（`HEAP_SPACE`）

**lwext4_rust 编译限制**：该 crate 需要 `riscv64-linux-musl-gcc` 交叉编译器来编译 lwext4 C 库。当前环境中缺少此工具（仅有 `riscv64-linux-gnu-gcc` 和 `riscv64-unknown-elf-gcc`）。但由于仓库中已预编译了 lwext4 的静态库（通过之前的构建），内核本身可以成功链接。

**用户程序编译**：`user/Makefile` 成功编译了用户态测试程序。

### 运行测试

在 QEMU (v8.2.2) 中成功启动内核：

```
OpenSBI v1.3 -> polyhal 初始化 -> 内存区域注册 -> virtio-blk 设备发现
  (262144KB) -> ext4 超级块挂载 -> 读取 init 程序 -> 执行用户态代码
```

内核成功执行了 ext4 文件系统操作（读取目录、创建文件），证明文件系统栈（virtio-blk -> lwext4 -> ext4 超级块/Inode -> OSInode）正常工作。

---

## 五、各子系统实现完整度评估

以类 Linux 内核为参考基准（基于 Linux 5.x syscall ABI + POSIX 标准），评估各子系统：

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **进程管理** | 85% | fork/clone/exec/exit/wait 全链路完整；支持 POSIX 线程；支持 robust futex；缺少 cgroup、namespace 隔离 |
| **文件系统** | 75% | VFS 框架完整；ext4 支持良好；procfs/devfs 有占位实现；缺少内存文件系统(tmpfs)、写时复制文件系统 |
| **内存管理** | 80% | 页分配/释放/映射/mmap 完整；懒分配和 COW 实现完善；缺页处理健壮；缺少交换(swap)、KSM |
| **信号处理** | 70% | 信号发送/接收/处理框架完整；sigaction/sigprocmask/sigreturn 均有实现；信号队列和实时信号优先级未实现 |
| **任务调度** | 40% | 仅 FIFO 调度器；无优先级/CFS/实时调度；不支持多核 SMP |
| **设备驱动** | 30% | 仅 virtio-blk 块设备；无网络设备驱动、无显示驱动、无输入设备驱动 |
| **网络栈** | 5% | Socket 为纯占位实现；无协议栈 |
| **同步原语** | 30% | 仅 UPSafeCell；无信号量、互斥锁、条件变量、RCU 等内核级同步 |
| **中断处理** | 60% | 基本中断分发完整；中断统计机制存在；缺少中断优先级/亲和性 |
| **时钟/定时器** | 50% | 基本时钟中断和 nanosleep 实现；实时定时器有占位支持 |
| **IPC** | 20% | 管道和 futex 完整；System V IPC 占位；无消息队列 |

**整体内核完整度**：约 **60-65%**（以比赛要求的 Linux 兼容内核为基准）。该内核足以运行 busybox、LTP 部分测试、musl/glibc 动态链接程序，但缺少网络、高级调度、多核等企业级特性。

---

## 六、子系统间交互关系

```
用户程序 (EL0)
    │ ecall
    ▼
trap::kernel_interrupt()     ← 中断/异常入口
    │
    ├── SysCall → syscall::syscall()
    │       ├── sys_read/write/open → fs::open/OSInode/lwext4 → drivers::virtio-blk
    │       ├── sys_fork/sys_clone → task::TaskControlBlock::new()
    │       ├── sys_exec → task 加载 ELF + mm::MemorySet
    │       ├── sys_mmap → mm::MemorySet::mmap()
    │       ├── sys_sig_kill → task 设置 signal flags
    │       └── sys_exit → task::exit_current_and_run_next()
    │
    ├── Timer → task::suspend_current_and_run_next()
    │       └── task::schedule() → context_switch_pt()
    │
    ├── PageFault → mm::lazy_page_fault / mm::cow_page_fault
    │       └── mm::MapArea::map_one() → mm::frame_alloc()
    │
    └── 之后统一调用:
            task::handle_signals()    → signal::SigTable
            task::current_poll_real_timer()
            task::exit_current_and_run_next() (如果 killed)
```

**关键交互路径**：
1. **内存-文件系统**：`mmap` 文件映射通过 `MapArea.mmap_file` 关联 `OSInode`
2. **任务-内存**：每个 `TaskControlBlock` 持有 `Arc<MemorySet>`，clone 时通过 COW 共享
3. **任务-信号**：`handle_signals()` 在每次陷入返回用户态前检查并分发信号
4. **任务-文件系统**：每个 `TaskControlBlock` 持有 `Arc<FdTable>` 和 `Arc<FsInfo>`（当前工作目录等）
5. **驱动-文件系统**：`lwext4_rust::blockdev::KernelDevOp` 将 `Disk<BlockDeviceImpl>` 适配到 lwext4 C 库

---

## 七、设计创新性分析

### 创新点

1. **Rust + C 混合文件系统栈**：通过 `lwext4_rust` crate 和 `bindgen`，将 C 语言实现的 lwext4 ext4 文件系统库无缝集成到 Rust 内核中。这是比赛项目中较少见的技术路线，相比于纯 Rust 实现的简单文件系统，直接获得了完整的 ext4 支持（日志、大文件、目录层次等）。

2. **多 C 库兼容的 busybox 路由机制**：内核在 exec 路径中智能识别 `/glibc/` 和 `/musl/` 目录前缀，将程序请求路由到正确的 busybox 副本。这种设计允许同时测试 glibc 和 musl 编译的程序，是面向比赛评测场景的实用创新。

3. **LTP 测试兼容层**：`syscall/ltp.rs` 中硬编码的 LTP 辅助文件路由表，以及 `syscall/process.rs` 和 `syscall/fs.rs` 中大量的路径回退逻辑（如 `can_ltp_fallback_open`），体现了面向测试驱动的实用主义设计。

4. **跨架构的 polyhal 抽象**：依赖 patched 版本的 `polyhal`、`polyhal-trap`、`virtio-drivers`，实现了 RISC-V64 和 LoongArch64 的双架构支持。`virtio_blk.rs` 中通过 `#[cfg(target_arch)]` 条件编译处理 MMIO 和 PCI 两种 virtio 传输方式。

5. **进程组信号传递**：`send_signal_to_pgid()` 和 `send_signal_to_all()` 实现了类 POSIX 的进程组信号广播，通过遍历 `PID2TCB` 全局映射实现。

6. **健壮的孤儿进程收养机制**：在 `exit_current_and_run_next()` 中，详细处理了子进程收养给 `INITPROC` 的逻辑，包括自引用检查（`Arc::ptr_eq(&child, &task) || Arc::ptr_eq(&child, &INITPROC)`）。

### 设计局限

1. **单核限制**：`UPSafeCell` 和全局 `PROCESSOR` 假设单核运行，多核 SMP 支持需要大量重构。
2. **Socket/网络为空壳**：虽然有完整的 socket 系统调用框架，但底层完全无实现。
3. **调度器过于简单**：FIFO 调度无法满足实时性或公平性要求。
4. **大量占位系统调用**：如 `sys_mlock`、`sys_shmget`、`sys_sched_*` 等仅返回成功或 ENOSYS。

---

## 八、总结

PwnMyOS 是一个面向操作系统设计大赛的、中等规模、实用性导向的 Rust OS 内核项目。其核心技术特征包括：

- **强大的 Linux 兼容性**：100+ 系统调用、完整的进程/线程模型、ext4 文件系统、信号处理框架
- **务实的工程选择**：通过集成成熟的 C 库（lwext4）快速获得 ext4 能力，通过 busybox 路由和 LTP 兼容层提高测试通过率
- **Rust 安全优势**：利用 Rust 的所有权和类型系统，在 `no_std` 环境下通过 `UPSafeCell`、`Arc`、`MutexNoIrq` 等机制管理内核对象的生命周期和并发访问
- **双架构支持**：RISC-V64 和 LoongArch64，通过 polyhal 硬件抽象层和条件编译实现
- **已验证的可运行性**：在 QEMU 中成功启动、挂载 ext4 文件系统、执行用户程序

该项目的核心优势在于**系统调用覆盖广度**和**面向比赛评测的实用性**，而非内核机制的深度或理论创新。对于操作系统设计大赛而言，这是一个务实且有效的参赛项目。