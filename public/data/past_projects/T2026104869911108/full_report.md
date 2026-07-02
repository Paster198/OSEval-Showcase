# Starry-Next (StarryOS) 宏内核项目深度技术分析报告

## 一、分析方法与测试过程

### 1.1 分析方法

本报告通过以下方法进行系统性分析：

1. **静态代码分析**：逐文件审查了项目全部核心源代码，涵盖 `src/`、`core/`、`api/`、`crates/` 四个核心目录，以及 ArceOS 框架的关键模块（`axhal`、`axmm`、`axtask`、`axfs`、`axnet`、`axns`、`axsync`）。
2. **构建验证**：成功执行了 x86_64 平台的完整构建流程（`make defconfig && make build`）。
3. **运行时验证**：在 QEMU x86_64 虚拟环境下启动了编译产出的内核，验证了内核启动、内存初始化、设备驱动探测（virtio-blk、virtio-net）、FAT32 文件系统挂载、网络栈初始化等关键路径的可用性。
4. **文档审查**：审查了设计文档、基线测试报告、Syscall 计划、ATTRIBUTION 等辅助材料。

### 1.2 测试结果

| 测试项 | 平台 | 结果 |
|--------|------|------|
| 完整构建 | x86_64 | 成功（release profile，产出自带内核 ELF 和 BIN） |
| QEMU 运行 | x86_64 (q35) | 成功启动，HAL、内存管理、块设备驱动、FAT32 fs、网络栈初始化均正常 |
| 多架构构建 | RISC-V64, LoongArch64 | 根据基线报告，均已通过构建和测试 |

基线测试报告（`docs/baseline_report.md`）声明：RISC-V64 和 LoongArch64 双架构 basic 100/100、busybox 8/8、Lua 9/9、libctest 160/160、iozone 20/20。

---

## 二、项目架构概览

### 2.1 总体分层结构

该项目采用**三层架构**：

```
┌───────────────────────────────────────────────┐
│  (A) 用户态应用层                              │
│  basic / busybox / lua / libctest / iozone     │
├───────────────────────────────────────────────┤
│  (B) Starry 宏内核层 (~12,000 行 Rust)         │
│  src/ syscall dispatch                        │
│  api/ 系统调用实现 (fs/mm/task/net/signal)     │
│  core/ 进程/内存/futex/时间基础抽象            │
│  crates/ axprocess + axsignal                 │
├───────────────────────────────────────────────┤
│  (C) ArceOS Unikernel 框架 (~18,000 行 Rust)  │
│  axhal/axmm/axtask/axfs/axnet/axns/...        │
├───────────────────────────────────────────────┤
│  (D) 虚拟硬件 (QEMU virtio)                    │
└───────────────────────────────────────────────┘
```

**关键设计思想**：ArceOS 原本是一个 unikernel 框架（单地址空间、无进程隔离），Starry 通过添加独立的用户态地址空间、进程模型、系统调用接口，将其扩展为类 Linux 的宏内核。

### 2.2 代码量统计

| 组件 | 代码行数 | 说明 |
|------|---------|------|
| Starry 核心 (src + core + api + crates) | ~12,000 行 | 系统调用 + 进程 + 信号 + 文件抽象 |
| ArceOS 框架模块 | ~18,000 行 | HAL/MM/Task/FS/Net/Driver |
| Vendored 依赖 | 大量 | smoltcp/rust-fatfs/lwext4_rust 等 |
| **总计** | **30,000+ 行** | |

---

## 三、子系统详细分析

### 3.1 系统调用层 (`src/syscall.rs`)

#### 3.1.1 分发机制

系统调用通过 `register_trap_handler(SYSCALL)` 注册——这是 ArceOS 提供的 `linkme` 分布式切片（distributed slice）机制。当 CPU 陷入内核时，架构特定的 trap handler 调用 `handle_syscall`，进而分发到具体的系统调用函数。

入口代码：
```rust
// src/syscall.rs
#[register_trap_handler(SYSCALL)]
fn handle_syscall(tf: &mut TrapFrame, syscall_num: usize) -> isize {
    let sysno = Sysno::from(syscall_num as u32);
    time_stat_from_user_to_kernel();
    let result = match sysno {
        Sysno::ioctl => sys_ioctl(tf.arg0() as _, tf.arg1() as _, tf.arg2().into()),
        Sysno::chdir => sys_chdir(tf.arg0().into()),
        // ... 167 个分支
    };
    // ...
}
```

**参数传递**：通过 `TrapFrame` 的 `arg0()` 到 `arg5()` 方法提取寄存器参数（遵循各架构的系统调用 ABI）。返回值为 `isize`，负数表示 Linux errno。

#### 3.1.2 系统调用覆盖度

共计实现了 **167 个** 独立系统调用，分类如下：

| 类别 | 数量 | 代表性 syscall |
|------|------|----------------|
| **进程管理** | 10+ | `fork`, `clone`, `clone3`, `execve`, `exit`, `exit_group`, `wait4`, `waitid`, `getpid`, `getppid`, `gettid` |
| **文件 IO** | 20+ | `read`, `write`, `readv`, `writev`, `pread64`, `pwrite64`, `preadv`, `pwritev`, `preadv2`, `pwritev2`, `sendfile`, `copy_file_range`, `splice`, `tee`, `vmsplice`, `lseek`, `ftruncate` |
| **文件描述符** | 10+ | `openat`, `open`, `close`, `close_range`, `dup`, `dup2`, `dup3`, `fcntl`, `pipe2`, `pipe` |
| **文件系统** | 15+ | `stat`, `fstat`, `lstat`, `fstatat`, `newfstatat`, `statx`, `statfs`, `fstatfs`, `getcwd`, `chdir`, `mkdirat`, `linkat`, `unlinkat`, `renameat`, `renameat2`, `readlinkat` |
| **文件系统挂载** | 4 | `mount`, `umount2`, `faccessat`, `faccessat2`, `fchmodat`, `fchmodat2`, `utimensat`, `sync`, `syncfs`, `fsync`, `fdatasync` |
| **内存管理** | 12 | `mmap`, `munmap`, `mprotect`, `mremap`, `brk`, `madvise`, `msync`, `mincore`, `mlock`, `mlockall`, `munlock`, `munlockall` |
| **SysV 共享内存** | 4 | `shmget`, `shmat`, `shmdt`, `shmctl` |
| **信号** | 15+ | `rt_sigaction`, `rt_sigprocmask`, `rt_sigpending`, `rt_sigreturn`, `rt_sigtimedwait`, `rt_sigsuspend`, `rt_sigqueueinfo`, `rt_tgsigqueueinfo`, `kill`, `tkill`, `tgkill`, `sigaltstack`, `signalfd4`, `pidfd_send_signal` |
| **网络** | 16+ | `socket`, `socketpair`, `bind`, `connect`, `listen`, `accept`, `accept4`, `sendto`, `recvfrom`, `sendmsg`, `recvmsg`, `getsockname`, `getpeername`, `getsockopt`, `setsockopt`, `shutdown` |
| **时间** | 8 | `clock_gettime`, `clock_getres`, `clock_nanosleep`, `nanosleep`, `gettimeofday`, `times`, `getitimer`, `setitimer` |
| **同步** | 3 | `futex`, `set_robust_list`, `get_robust_list` |
| **调度** | 12 | `sched_yield`, `sched_getparam`, `sched_setparam`, `sched_getscheduler`, `sched_setscheduler`, `sched_get_priority_max/min`, `sched_rr_get_interval`, `sched_getaffinity`, `sched_setaffinity`, `sched_getattr`, `sched_setattr` |
| **fd 通知** | 8 | `eventfd2`, `timerfd_create`, `timerfd_settime`, `timerfd_gettime`, `epoll_create1`, `epoll_ctl`, `epoll_pwait`, `epoll_pwait2` |
| **系统信息** | 10+ | `uname`, `sysinfo`, `syslog`, `getrandom`, `getrlimit`, `prlimit64`, `getrusage`, `getuid/euid/gid/egid`, `get_mempolicy` |
| **其他** | 5+ | `membarrier`, `arch_prctl`(x86_64), `set_tid_address`, `pidfd_open`, `pidfd_getfd`, `memfd_create` |

---

### 3.2 进程管理系统

#### 3.2.1 进程数据结构 (`crates/axprocess/`)

进程模型由三层结构组成：

- **`Session`**：会话（job control 基础），由 SID 标识
- **`ProcessGroup`**：进程组，关联一个 Session，包含多个 Process 的 Weak 引用
- **`Process`**：进程主体，关键字段：
  - `pid: Pid`（u32）
  - `parent: Mutex<Option<Weak<Process>>>`（父进程弱引用，避免循环）
  - `children: Mutex<Vec<Arc<Process>>>`（子进程强引用列表）
  - `group: Arc<ProcessGroup>`
  - `threads: Mutex<Vec<Weak<Thread>>>`
  - `data: Once<Box<DynData>>`（类型擦除的扩展数据，实际存储 `ProcessData`）
  - `zombie/freed/group_exited: AtomicBool`（生命周期状态）
  - `exit_code: AtomicI32`

- **`Thread`**：线程主体，关联一个 Process，关键字段：
  - `tid: Pid`
  - `process: Arc<Process>`
  - `data: Once<Box<DynData>>`（实际存储 `ThreadData`）
  - `zombie/freed: AtomicBool`

设计特点：
- 使用**建造者模式**（`ProcessBuilder`/`ThreadBuilder`），通过 `Process::new_init()`、`process.fork(pid)`、`process.new_thread(tid)` 创建
- Global `INIT_PROC` 静态变量保存 init 进程引用
- zombie 状态用于 wait 系统调用的子进程回收

#### 3.2.2 进程管理核心 (`core/src/task.rs`)

**`ProcessData`**（进程扩展数据）是进程资源的核心容器：

```rust
pub struct ProcessData {
    pub exe_path: RwLock<String>,           // 可执行文件路径
    pub aspace: Arc<Mutex<AddrSpace>>,       // 虚拟地址空间
    pub ns: AxNamespace,                     // 命名空间（FD表、工作目录等）
    heap_bottom: AtomicUsize,               // 堆底
    heap_top: AtomicUsize,                   // 堆顶
    pub child_exit_wq: WaitQueue,           // 子进程退出等待队列
    pub exit_signal: Option<Signo>,         // 退出时发送的信号
    pub signal: Arc<ProcessSignalManager<..>>, // 进程级信号管理器
    pub futex_table: FutexTable,            // Futex 等待队列表（按地址索引）
    pub shm_attachments: Mutex<BTreeMap<usize, usize>>, // SysV 共享内存附件
}
```

**`ThreadData`**（线程扩展数据）：
```rust
pub struct ThreadData {
    pub clear_child_tid: AtomicUsize,       // set_tid_address 地址
    robust_list_head: AtomicUsize,          // robust futex 链表头
    pub signal: ThreadSignalManager<..>,     // 线程级信号管理器
}
```

**关键机制**：
- **时间统计**：`TimeStat` 追踪 utime（用户态时间）和 stime（内核态时间），在用户/内核切换时更新
- **任务创建**：`new_user_task()` 创建一个 `TaskInner`，其闭包在调度时通过 `uctx.enter_uspace(kstack_top)` 进入用户态
- **全局线程表**：通过 `WeakMap` 维护 tid→Thread 映射，支持 `tkill`/`tgkill` 和 `get_thread()`

#### 3.2.3 `clone` 系统调用实现 (`api/src/imp/task/clone.rs`)

`clone` 实现非常完整，支持几乎所有 Linux clone 标志：

```rust
bitflags! {
    struct CloneFlags: u32 {
        const VM = CLONE_VM;           // 共享地址空间
        const FS = CLONE_FS;           // 共享文件系统信息
        const FILES = CLONE_FILES;     // 共享文件描述符表
        const SIGHAND = CLONE_SIGHAND; // 共享信号处理器
        const THREAD = CLONE_THREAD;   // 放入同一线程组
        const VFORK = CLONE_VFORK;
        const PARENT = CLONE_PARENT;
        const SETTLS = CLONE_SETTLS;
        const CHILD_SETTID = CLONE_CHILD_SETTID;
        const CHILD_CLEARTID = CLONE_CHILD_CLEARTID;
        const PARENT_SETTID = CLONE_PARENT_SETTID;
        // ... 更多标志
    }
}
```

实现逻辑：
1. 从 `TrapFrame` 创建 `UspaceContext`，处理栈（stack）、TLS 设置
2. 判断 `CLONE_THREAD`：若是，直接复用父进程的地址空间和进程对象；否则执行完整的 fork 流程（地址空间深拷贝、文件描述符表复制/共享、信号处理器复制/共享等）
3. 验证标志组合合法性（如 CLONE_THREAD 必须同时设置 CLONE_VM 和 CLONE_SIGHAND）

#### 3.2.4 `execve` 实现 (`api/src/imp/task/execve.rs`)

1. 读取 ELF 文件（通过 `axfs::api::read`）
2. 处理 shebang（`#!`）脚本解释器（最多 4 层递归）
3. 映射 ELF 段和动态链接器（`.interp`），构建 AUX 向量
4. 构建用户栈（参数、环境变量、AUX 向量）
5. 解映射旧地址空间的用户区域，映射新的 trampoline 页
6. 更新 `TrapFrame` 的 IP 和 SP

亮点：支持 shebang 脚本（`#!`），并实现了脚本解释器的相对路径解析：
```rust
fn resolve_script_interpreter(script_path: &str, interp: &str) -> String {
    // 处理 ./interpreter 和相对路径
    let candidate = if script_dir == "/" {
        format!("/{interp}")
    } else {
        format!("{script_dir}/{interp}")
    };
    axfs::api::canonicalize(&candidate).unwrap_or(candidate)
}
```

#### 3.2.5 `exit` 实现 (`api/src/imp/task/exit.rs`)

1. 清除 `clear_child_tid` 地址并唤醒 futex 等待者
2. 遍历 robust futex 链表，标记 owner-dead（`FUTEX_OWNER_DIED`）
3. 标记 thread zombie，检查是否所有线程都已退出
4. 若是，标记 process zombie，向父进程发送 SIGCHLD，唤醒父进程 `child_exit_wq`
5. 释放地址空间（`unmap_user_areas`）
6. group exit：向所有线程发送 SIGKILL

---

### 3.3 内存管理系统

#### 3.3.1 用户地址空间 (`core/src/mm.rs`)

```rust
pub fn new_user_aspace_empty() -> AxResult<AddrSpace> {
    AddrSpace::new_empty(
        VirtAddr::from_usize(axconfig::plat::USER_SPACE_BASE),
        axconfig::plat::USER_SPACE_SIZE,
    )
}
```

- **x86_64/RISC-V**：从内核地址空间复制内核部分映射（共享页表）
- **AArch64/LoongArch64**：使用独立页表（TTBR0_EL1 / PGDL），无需复制

地址空间布局（以 x86_64 为例）：

| 区域 | 起止地址 | 说明 |
|------|---------|------|
| 用户空间基址 | 0x1000 | |
| 解释器基址 | 0x400_0000 | 动态链接器加载地址 |
| 堆基址 | 0x4000_0000 | brk 系统调用管理区域 |
| 信号 trampoline | 0x4001_0000 | 信号返回桩代码 |
| 用户栈顶 | 0x7fff_0000_0000 | 向下增长 |
| 用户空间大小 | ~128TB (x86_64) / ~256GB (RISC-V) | |

#### 3.3.2 ELF 加载器

```rust
fn map_elf(uspace: &mut AddrSpace, elf: &ElfFile) -> AxResult<(VirtAddr, [AuxvEntry; 16])> {
    let elf_parser = ELFParser::new(elf, ...);
    for segment in elf_parser.ph_load() {
        uspace.map_alloc(segment.vaddr, segment.memsz, segment.flags, true, PageSize::Size4K)?;
        uspace.write(segment.vaddr, PageSize::Size4K, seg_data)?;
    }
    flush_icache(); // RISC-V: fence.i, LoongArch: ibar 0
    Ok((elf_parser.entry().into(), elf_parser.auxv_vector(PAGE_SIZE_4K)))
}
```

特性：
- 支持 **动态链接**（解析 `.interp` 段，加载 ld-linux 等动态链接器，合并 AUX 向量中的 `AT_BASE`）
- 支持 **shebang 脚本**（最多 4 层嵌套）
- 架构相关的指令缓存刷新（`fence.i` / `ibar 0`）

#### 3.3.3 `mmap` / `munmap` 实现 (`api/src/imp/mm/mmap.rs`)

- 支持 `MAP_FIXED`、`MAP_ANONYMOUS`、`MAP_PRIVATE`、`MAP_SHARED`、`MAP_STACK`、`MAP_HUGETLB`（1G/2M 大页）
- 支持文件映射（通过 fd+offset 读取文件内容填充）
- `mprotect`、`mremap`（支持 `MREMAP_MAYMOVE`、`MREMAP_FIXED`）、`madvise`（空操作）、`msync`（空操作）、`mincore`

#### 3.3.4 SysV 共享内存 (`api/src/imp/mm/shm.rs`)

基于 ArceOS 的 `SharedPages` 后端的 SysV shm 实现：
```rust
static SHM_MANAGER: Mutex<ShmManager> = Mutex::new(ShmManager::new());
```
- `shmget(key, size, flags)`：创建/获取共享内存段，支持 `IPC_PRIVATE`、`IPC_CREAT`、`IPC_EXCL`
- `shmat(shmid, addr, flags)`：附加到进程地址空间（`map_shared`）
- `shmdt(addr)`：从进程地址空间解附加
- `shmctl(IPC_RMID)`：标记删除
- fork 时继承附件元数据（`inherit_shm_attachments_from`），execve 时清除（`clear_shm_attachments`）

#### 3.3.5 ArceOS 内存管理 (`arceos/modules/axmm/`)

- **`AddrSpace`**：基于 `MemorySet<Backend>` 和 `PageTable` 的地址空间抽象
- **后端类型**：
  - `Linear`：线性映射（内核物理内存）
  - `Alloc`：按需分配页面
  - `Shared`：共享物理页面（供 SysV shm 使用）
- 支持 `map_alloc`、`map_linear`、`map_shared`、`unmap`、`protect`、`find_free_area`
- 页面大小：4K / 2M / 1G

---

### 3.4 文件系统

#### 3.4.1 VFS 抽象 (`api/src/file/mod.rs`)

自定义 `FileLike` trait（非 Linux VFS 兼容，但提供类似抽象）：

```rust
pub trait FileLike: Send + Sync {
    fn read(&self, buf: &mut [u8]) -> LinuxResult<usize>;
    fn write(&self, buf: &[u8]) -> LinuxResult<usize>;
    fn stat(&self) -> LinuxResult<Kstat>;
    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
    fn poll(&self) -> LinuxResult<PollState>;
    fn set_nonblocking(&self, nonblocking: bool) -> LinuxResult;
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> LinuxResult<usize> { ... }
    fn write_at(&self, offset: u64, buf: &[u8]) -> LinuxResult<usize> { ... }
    fn seek(&self, pos: SeekFrom) -> LinuxResult<u64> { ... }
    fn truncate(&self, length: u64) -> LinuxResult { ... }
    // ...
}
```

**文件描述符表**：使用 `FlattenObjects<Arc<dyn FileLike>, AX_FILE_LIMIT>`（最大 1024 个），通过 `def_resource!` 宏定义为命名空间感知资源。

**`Kstat`**：自定义 stat 结构，可转换为 Linux 的 `stat` 和 `statx`。

#### 3.4.2 FileLike 实现类型

| 类型 | 源文件 | 说明 |
|------|--------|------|
| `File` | `api/src/file/fs.rs` | ArceOS `axfs::fops::File` 包装，支持 FAT32/ext4 文件 |
| `Directory` | `api/src/file/fs.rs` | 目录包装，支持 `getdents64` 通过 `DirEntry` 迭代 |
| `Pipe` | `api/src/file/pipe.rs` | 管道（环形缓冲区，256 字节） |
| `Socket` | `api/src/file/net.rs` | TCP/UDP/Unix socket 统一包装 |
| `UnixSocket` | `api/src/file/net.rs` | 基于内存 VecDeque 的 Unix 域 socketpair |
| `EventFd` | `api/src/imp/fs/eventpoll.rs` | eventfd 实现 |
| `TimerFd` | `api/src/imp/fs/eventpoll.rs` | timerfd 实现（支持 CLOCK_MONOTONIC/REALTIME/BOOTTIME） |
| `EpollFile` | `api/src/imp/fs/eventpoll.rs` | epoll 实例（支持 EPOLLIN/OUT/ERR/HUP/ET/ONESHOT） |
| `SignalFd` | `api/src/imp/signal.rs` | signalfd 实现 |
| `PidFd` | `api/src/imp/task/pidfd.rs` | pidfd 实现 |
| `MemFd` | `api/src/imp/fs/memfd.rs` | memfd_create 实现（支持文件封印 seal） |

#### 3.4.3 挂载系统 (`api/src/imp/fs/mount.rs`)

仅支持 vfat 文件系统类型的挂载：
```rust
pub fn sys_mount(source, target, fs_type, flags, _data) -> LinuxResult<isize> {
    if fs_type != "vfat" { return Err(LinuxError::EPERM); }
    mount_fat_fs(&device_path, &mount_path);
}
```

全局 `MOUNTED: Mutex<Vec<MountedFs>>` 维护挂载表，只能挂载已存在的路径。

#### 3.4.4 底层文件系统 (ArceOS `axfs`)

- **FAT32**：通过 `rust-fatfs`（vendored）
- **ext4**：通过 `lwext4_rust`（optional feature）
- **myfs**：自定义文件系统

---

### 3.5 信号系统

#### 3.5.1 信号基础设施 (`crates/axsignal/`)

```rust
pub enum Signo {
    SIGHUP=1, SIGINT=2, SIGQUIT=3, SIGILL=4, SIGTRAP=5, SIGABRT=6,
    SIGBUS=7, SIGFPE=8, SIGKILL=9, SIGUSR1=10, SIGSEGV=11, SIGUSR2=12,
    SIGPIPE=13, SIGALRM=14, SIGTERM=15, SIGCHLD=17, SIGCONT=18, SIGSTOP=19,
}
```

**`SignalSet`**：基于 `u64` 位图，支持 64 种信号。

**信号架构**分为两层：
- `ProcessSignalManager`：进程级信号管理器（pending 队列、action 表、wait_queue 通知）
- `ThreadSignalManager`：线程级信号管理器（每个线程独立的 blocked mask、pending 队列、signal stack）

```rust
pub struct ThreadSignalManager<R, W> {
    process: Arc<ProcessSignalManager<R, W>>,  // 关联进程
    blocked: SpinMutex<SignalSet>,              // 阻塞信号集
    pending: SpinMutex<VecDeque<SignalInfo>>,   // 线程级 pending
    stack: SpinMutex<SignalStack>,              // 信号栈
}
```

#### 3.5.2 信号处理流程 (`api/src/signal.rs`)

1. **发送**：`send_signal_thread()` → `ThreadSignalManager::send_signal()` → 唤醒 wait_queue
2. **检查**：`POST_TRAP` handler 在每次从用户态陷入后调用 `check_signals()`
3. **分发**：`ThreadSignalManager::check_signals()` 取出未阻塞信号，确定 OS action（Terminate/CoreDump/Stop/Continue/Handler）
4. **执行**：
   - `Terminate`/`CoreDump`：调用 `do_exit(128 + signo, true)`
   - `Handler`：设置 trampoline，用户态下次返回时执行信号处理函数

#### 3.5.3 信号 trampoline

```rust
// crates/axsignal/src/lib.rs
#[repr(C, align(4096))]
struct SignalTrampolinePage([u8; 4096]);
static SIGNAL_TRAMPOLINE_PAGE: SignalTrampolinePage = SignalTrampolinePage([0; 4096]);
```

信号 trampoline 页被映射到用户空间 `SIGNAL_TRAMPOLINE`（0x4001_0000），当前为空白占位符（实际 trampoline 代码在此项目中未完全实现，`check_signals` 中对 Handler action 仅注释 "do nothing"）。

---

### 3.6 同步原语

#### 3.6.1 Futex (`core/src/futex.rs` + `api/src/imp/futex.rs`)

```rust
pub struct FutexTable(Mutex<BTreeMap<usize, Arc<WaitQueue>>>);
```

- 每个 `ProcessData` 拥有一个 `FutexTable`
- 按用户态地址索引等待队列（`BTreeMap`）
- 支持 `FUTEX_WAIT`、`FUTEX_WAKE`、`FUTEX_REQUEUE`、`FUTEX_CMP_REQUEUE`
- 自动清理：`WaitQueueGuard` drop 时若引用计数为 1 且队列为空，移除条目

#### 3.6.2 Robust Futex

`exit` 时调用 `exit_robust_list()`：
```rust
fn exit_robust_list(head_addr: usize, tid: u32) -> axerrno::LinuxResult {
    // 遍历 robust_list 链表
    // 对每个条目调用 mark_robust_futex_owner_dead()
    // 设置 FUTEX_OWNER_DIED，若 FUTEX_WAITERS 则唤醒等待者
}
```

#### 3.6.3 ArceOS 同步原语 (`arceos/modules/axsync/`)

提供 `Mutex`（基于自旋锁）、`WaitQueue` 等。Starry 中大量使用 `axsync::Mutex`（自旋锁）和 `spin::Mutex`/`spin::RwLock`。

---

### 3.7 网络子系统

#### 3.7.1 Socket 抽象 (`api/src/file/net.rs`)

```rust
pub enum Socket {
    Udp(Mutex<UdpSocket>),
    Tcp(Mutex<TcpSocket>),
    Unix(UnixSocket),
}
```

**TCP/UDP**：基于 ArceOS 的 `axnet::TcpSocket`/`axnet::UdpSocket`（底层为 `smoltcp`）

**Unix Socket**：纯内存实现，基于两个 `Arc<Mutex<VecDeque<u8>>>` 双向通道（64KB 缓冲区）

#### 3.7.2 网络系统调用 (`api/src/imp/net.rs`)

支持 `socket`、`bind`、`connect`、`listen`、`accept`/`accept4`、`sendto`/`recvfrom`、`sendmsg`/`recvmsg`、`getsockopt`/`setsockopt`、`shutdown`、`socketpair`。

支持 `AF_INET`/`AF_INET6`（TCP/UDP）和 `AF_UNIX`（socketpair 专用）。

#### 3.7.3 底层网络栈 (ArceOS `axnet` + `smoltcp`)

ArceOS 封装了 vendored 版本的 `smoltcp` 协议栈，通过 virtio-net 设备驱动提供网络能力。支持 DHCP（用户态）、静态 IP 配置等。

---

### 3.8 硬件抽象层 (ArceOS `axhal`)

#### 3.8.1 Trap 处理

四种架构的 trap handler：
- **x86_64**：IDT（中断描述符表），处理 #PF、#GP、syscall (INT 0x80)、IRQ
- **RISC-V**：通过 `scause` 寄存器分发，处理 `UserEnvCall`（syscall）、PageFault、IRQ
- **AArch64**：通过异常级别切换处理
- **LoongArch64**：通过 LoongArch 异常向量

统一的 syscall 分发机制（`linkme` distributed slice）：
```rust
// arceos/modules/axhal/src/trap.rs
#[cfg(feature = "uspace")]
pub(crate) fn handle_syscall(tf: &mut TrapFrame, syscall_num: usize) -> isize {
    SYSCALL[0](tf, syscall_num)
}
```

#### 3.8.2 分页与 TLB

`axhal::paging` 提供 `MappingFlags`、`PageSize`、`PageTable` 抽象，底层由 `page_table_multiarch`（vendored）支持多架构。

架构特定的 `flush_tlb`：
- RISC-V：`sfence.vma`
- x86_64：`invlpg` + `mov cr3`
- LoongArch64：`tlbflush` 指令

---

### 3.9 任务调度 (ArceOS `axtask`)

- 支持多种调度器：FIFO（协作式）、Round-Robin（抢占式）、CFS（完全公平调度器）
- 当前 Starry 构建使用 **FIFO 调度器**（默认）
- `TaskInner`：任务内部结构，包含入口闭包、名称、内核栈
- `TaskExt`：任务扩展（通过 `def_task_ext!` 宏），Starry 注入 `TaskExt`（包含 `Thread` 引用和时间统计）
- `WaitQueue`：等待队列，支持 `wait`、`wait_timeout`、`notify_one`、`notify_all`
- 支持 SMP（多核启动，通过 `percpu`）

---

### 3.10 命名空间 (`arceos/modules/axns`)

```rust
pub struct AxNamespace {
    base: usize,  // 资源基地址
    alloc: bool,  // 是否动态分配
}
```

- **全局命名空间**：编译时通过 `axns_resource` 段收集所有通过 `def_resource!` 宏定义的资源
- **线程局部命名空间**：`new_thread_local()` 动态分配并复制全局命名空间，用于进程隔离
- 资源（如 `FD_TABLE`、`CURRENT_DIR`）通过 `deref_from(&namespace)` 获取特定命名空间中的实例
- clone 时根据 CLONE_FILES/CLONE_FS 标志决定共享或复制

---

### 3.11 配置与构建系统

#### 3.11.1 配置层 (`configs/` + ArceOS `axconfig`)

平台配置文件（`.toml` 格式）定义地址空间布局和设备参数。通过 `axconfig-gen` 工具合并平台配置和应用配置生成 `.axconfig.toml`。

#### 3.11.2 构建流程

```
make defconfig → 生成 .axconfig.toml
make build → cargo build (release) → objcopy (ELF→BIN)
make user_apps → 编译用户态测例 → 打包 disk.img
make run → QEMU 启动
```

#### 3.11.3 测例嵌入

`build.rs` 在编译时将用户态应用二进制嵌入内核数据段：
```rust
// build.rs 生成的汇编
.section .data
.global _app_count
_app_count:
    .quad N
    .quad app_0_name
    .quad app_0_start
    ...
app_0_name:
    .string "basic/brk"
app_0_start:
    .incbin "apps/oscomp/build/riscv64/basic/brk"
```

运行时通过 `OSCOMP_RUNTIME_DISCOVERY`=1 模式或 `AX_TESTCASES_LIST` 环境变量发现测试用例。

#### 3.11.4 Vendor 依赖

项目将 10 个关键上游 crate vendored 到 `vendor/` 目录（通过 `[patch.crates-io]` 和 `[patch.'https://...']`），以保证在无网络环境下可构建：
- `allocator`、`axdriver_crates`、`linked_list`、`lwext4_rust`、`page_table_multiarch`、`rust-fatfs`、`scheduler`、`smoltcp`、`syscalls`、`weak-map`

---

## 四、子系统交互关系

### 4.1 启动流程

```
_start (boot.S)
  → rust_entry()
    → axruntime::init()
      → axhal 平台初始化（CPU、中断、分页）
      → axalloc 内存分配器初始化
      → axmm 虚拟内存管理初始化
      → axdriver 设备驱动初始化（virtio-blk/net）
      → axfs 文件系统初始化（FAT32 挂载）
      → axnet 网络栈初始化
      → axtask 调度器初始化
    → main() [src/main.rs]
      → axprocess::Process::new_init() 创建 init 进程
      → run_user_app() 逐个运行测试用例
        → new_user_aspace_empty() 创建地址空间
        → load_user_app() ELF 加载
        → new_user_task() 创建任务
        → spawn_task() 调度
        → task.join() 等待完成
```

### 4.2 系统调用路径

```
用户态程序
  ↓ ecall/syscall/int 0x80
axhal::arch::trap::trap_handler (架构特定)
  ↓
axhal::trap::handle_syscall
  ↓ SYSCALL[0] (linkme distributed slice)
src/syscall.rs::handle_syscall
  ↓ 按 syscall number 分发
api/src/imp/* 具体实现
  ↓ 访问
core/src/{task,mm,futex,time}.rs (进程/内存/同步抽象)
crates/ax{process,signal} (数据结构)
arceos/modules/ax{fs,net,mm,task,ns} (底层框架)
```

### 4.3 进程创建与销毁

```
fork/clone:
  ProcessBuilder.build() → 新 Process + ProcessData
  → copy/clone AddrSpace
  → copy/clone AxNamespace (FD_TABLE, CURRENT_DIR, etc.)
  → 继承 signal actions / shm attachments
  → new_user_task() → TaskInner → spawn_task()

exit:
  → clear_child_tid + futex wake
  → exit_robust_list (FUTEX_OWNER_DIED)
  → thread.exit() → process.exit()
  → unmap_user_areas() (释放内存)
  → 向父进程发送 SIGCHLD → 唤醒 child_exit_wq
  → axtask::exit()

wait/waitpid:
  → 扫描 children → 查找 zombie
  → 若有：回收 (child.free()) → 返回 exit_code
  → 若无：在 child_exit_wq 上等待
```

### 4.4 信号传递路径

```
kill/tkill/tgkill → send_signal_{process,thread}()
  → {Process,Thread}SignalManager::send_signal()
    → pending 队列 push
    → wait_queue.notify_one()

POST_TRAP handler:
  → check_signals(tf, None)
  → ThreadSignalManager::check_signals()
    → 取未阻塞信号 → 确定 SignalOSAction
    → Terminate → do_exit(128 + signo, true)
```

---

## 五、实现完整度评估

### 5.1 各子系统完整度

| 子系统 | 完整度 | 依据 |
|--------|--------|------|
| **系统调用层** | 85% | 167 个 syscall，覆盖进程/文件/网络/信号/内存/同步主要类别；缺少 cgroup、seccomp、name_to_handle_at 等高级特性 |
| **进程管理** | 80% | fork/clone/execve/wait 族完整；clone 支持几乎所有标志；缺少 cgroup、namespace 隔离 |
| **内存管理** | 75% | mmap/munmap/mprotect/mremap/brk 完整；支持大页和文件映射；mmap 的文件页写回未实现 |
| **文件系统** | 65% | FAT32 读写完整；ext4 需 lwext4_rs feature；挂载有限；缺少 procfs/sysfs/devpts 等虚拟文件系统 |
| **信号** | 60% | 发送/接收/阻塞/等待基本完整；信号处理函数调用（trampoline 路由）未实现；缺少 core dump |
| **同步 (futex)** | 80% | WAIT/WAKE/REQUEUE/CMP_REQUEUE 完整；robust futex 完整；PI futex 未实现 |
| **网络** | 65% | TCP/UDP socket 基本操作完整；Unix socketpair 可用；缺少原始 socket、packet socket、netlink |
| **epoll/eventfd/timerfd** | 70% | 基本操作完整；ET/LT 模式；缺少多线程唤醒的某些边缘情况 |
| **SysV 共享内存** | 60% | shmget/shmat/shmdt/shmctl(IPC_RMID) 完整；缺少 IPC_STAT/IPC_SET、权限检查、shmid_ds 结构导出 |
| **时间管理** | 70% | clock_gettime/getres/gettimeofday/times 完整；itimer 为空操作 |
| **调度器接口** | 50% | sched_* 系统调用参数验证完整，但实际调度策略仅使用 FIFO（无真正的 CFS/RR） |

### 5.2 整体完整度评估

**整体完整度：70%**（基于 Linux 宏内核的功能基准）

该项目已具备一个可运行 Linux 用户态程序的宏内核所需的核心功能：
- 完整的进程/线程生命周期管理
- 可用的文件系统（FAT32 + ext4）
- TCP/UDP 网络栈
- 基础信号机制
- futex 同步
- epoll/eventfd/timerfd 通知机制

主要缺失包括：
- 真正的多核调度器集成（当前默认 FIFO）
- 信号处理函数的实际调用（trampoline 为空白）
- 缺少大量 POSIX 高级特性（resource limit 实际执行、capabilities、namespace 隔离等）
- 设备文件系统（devtmpfs、procfs）不完整

---

## 六、创新性分析

### 6.1 设计创新

1. **Unikernel 向宏内核的渐进式扩展**：在 ArceOS Unikernel 框架之上，通过添加独立的用户地址空间、进程模型和系统调用层，将其转换为宏内核。这种架构层次分离的设计在比赛中较有特色。

2. **Type-erased 扩展数据**：`ProcessData` 和 `ThreadData` 通过 `Process::data::<T>()` 和 `Thread::data::<T>()` 的泛型方法访问，使用 `dyn Any + Send + Sync` 实现类型擦除，使得进程/线程模型与星游层的扩展数据解耦。

3. **命名空间感知的资源管理**：`AxNamespace` + `def_resource!` 宏机制使得文件描述符表、当前目录等资源可以透明地在进程间共享或隔离，clone 时根据标志位自动决定。

4. **多架构支持**：通过 ArceOS 框架的 axhal 层和 page_table_multiarch 库，同时支持 4 种 CPU 架构（x86_64、RISC-V64、AArch64、LoongArch64）。

5. **用户态应用程序嵌入**：通过 `build.rs` 在编译时将用户态二进制嵌入内核数据段，避免了复杂的 initramfs 或磁盘镜像加载流程。

### 6.2 工程创新

1. **完全 vendored 依赖**：所有外部 Rust crate 依赖被本地化到 `vendor/`，使项目在无网络评测环境中可完全复现构建。

2. **系统调用枚举驱动的分发**：使用 `Sysno` 枚举（来自 `syscalls` crate）作匹配，比手写数字更可读、更不易出错。

3. **linkme 分布式切片**：ArceOS 的 `linkme` 机制允许在 crate 边界之外注册 trap handler，Starry 利用此机制注册系统调用和 post-trap 信号检查。

4. **竞赛针对性设计**：大量系统调用实现以"通过测例"为目标驱动（如 `getrlimit`/`prlimit64` 仅返回固定值以消除 ENOSYS，`madvise`/`msync` 为空操作），体现了竞赛场景下的务实策略。

---

## 七、项目总结

### 7.1 核心优势

1. **系统调用覆盖广**：167 个 Linux 系统调用，覆盖了进程管理、文件 IO、网络、内存管理、信号等主要子系统，足以运行 BusyBox、Lua、libc-test、iozone 等复杂用户态程序。

2. **多架构支持**：4 种 CPU 架构的支持显示了良好的可移植性设计。

3. **代码组织清晰**：三层架构（Starry 宏内核层、ArceOS 框架层、Vendor 依赖）层次分明，职责明确。

4. **构建系统完善**：支持 Docker 和本地构建、多架构交叉编译、自动化测试评判。

5. **测例通过率高**：基线报告显示双架构 basic 100/100、busybox 8/8、Lua 9/9、libctest 160/160、iozone 20/20。

### 7.2 主要不足

1. **信号处理不完整**：trampoline 代码为空白，用户态信号处理函数无法被实际调用。
2. **调度器未充分利用**：虽然实现了 sched_* 系列系统调用，但底层使用 FIFO 调度器，未真正启用 CFS/RR。
3. **虚拟文件系统缺失**：没有 procfs、sysfs、devpts 等，部分用户态工具可能无法正常运行。
4. **文件系统写支持有限**：mmap 的文件映射写回未实现。
5. **权限模型缺失**：UID/GID 系统调用返回固定值（0），没有真正的权限检查。

### 7.3 综合评价

Starry-Next 是一个**工程上相当成熟的竞赛宏内核项目**。它在 ArceOS Unikernel 框架的基础上成功构建了完整的进程模型和 Linux 兼容系统调用层，能够运行大量复杂的用户态程序。项目的"基线改进"策略（fork → 适配 → 修复测例 → 添加必要的 syscall）是竞赛中的务实选择。代码质量和架构设计在同类竞赛项目中处于较高水平，特别是命名空间感知的资源管理和多架构支持方面表现突出。主要的技术债务集中在信号处理实现和虚拟文件系统方面，这些是未来可以继续完善的方向。