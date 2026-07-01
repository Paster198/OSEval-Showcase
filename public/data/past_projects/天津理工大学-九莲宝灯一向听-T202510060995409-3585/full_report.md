# WenyiOS 操作系统内核项目技术报告

## 一、项目概述

WenyiOS（又名 Starry）是由天津理工大学团队开发的基于 Rust 语言的宏内核操作系统。该项目基于 ArceOS 微内核生态构建，是 starry-next 的一个分支，专为操作系统内核比赛设计。项目支持四种架构：x86_64、aarch64、riscv64 和 loongarch64，其中 riscv64 和 loongarch64 是比赛的主要目标平台。

## 二、项目规模与代码统计

基于代码行数统计（仅统计项目自有代码，不含 ArceOS 基座和 vendor 依赖）：

| 模块 | 文件数 | 代码行数 |
|------|--------|----------|
| **starry（顶层入口）** | 4 | 517 |
| **starry-core（核心逻辑）** | 6 | 858 |
| **starry-api（系统调用实现）** | ~30 | 5,524 |
| **crates（扩展驱动）** | ~15 | ~3,500 |
| **总计** | ~55 | ~10,400 |

项目使用 Rust edition 2024，依赖 nightly-2025-01-18 工具链，包含约 150+ 个离线 vendor 依赖包。

## 三、架构设计

### 3.1 三层架构

```
┌─────────────────────────────────────┐
│  starry (顶层入口 crate)            │
│  - main.rs: 内核入口与 init 进程    │
│  - entry.rs: 用户应用加载           │
│  - syscall.rs: 系统调用分发         │
│  - mm.rs: 缺页异常处理              │
├─────────────────────────────────────┤
│  starry-api (系统调用实现层)        │
│  - imp/: 各子系统 syscall 实现      │
│  - file/: 文件描述符抽象            │
│  - ptr.rs: 用户空间指针安全访问     │
│  - path.rs: 路径处理与硬链接管理    │
│  - signal.rs: 信号分发              │
├─────────────────────────────────────┤
│  starry-core (核心数据结构)         │
│  - task.rs: 进程/线程扩展数据       │
│  - mm.rs: 地址空间与 ELF 加载       │
│  - futex.rs: Futex 等待队列         │
│  - time.rs: 时间统计                │
│  - resources.rs: 资源限制           │
├─────────────────────────────────────┤
│  ArceOS 基座 (外部依赖)             │
│  - axhal: 硬件抽象层                │
│  - axmm: 内存管理                   │
│  - axtask: 任务调度                 │
│  - axfs: 文件系统                   │
│  - axnet: 网络协议栈                │
│  - axprocess: 进程管理框架          │
│  - axsignal: 信号框架               │
└─────────────────────────────────────┘
```

### 3.2 关键设计决策

1. **命名空间隔离**：使用 `axns` 的 `AxNamespace` 实现进程级资源隔离（文件描述符表、当前目录等），支持 `init_shared` 和 `init_new` 两种模式，分别对应 `CLONE_FILES`/`CLONE_FS` 的共享与复制语义。

2. **信号处理**：基于外部 `axsignal` crate 实现，使用泛型参数 `<RawMutex, WaitQueueWrapper>` 适配 ArceOS 的同步原语。信号 trampoline 被映射到用户地址空间的固定地址（`0x4001_0000`）。

3. **用户空间指针安全**：通过 `UserPtr<T>` 和 `UserConstPtr<T>` 封装，在访问用户空间内存前进行地址范围验证和页表权限检查，并通过 `access_user_memory` 机制允许内核态访问用户内存时触发缺页异常。

## 四、子系统详细分析

### 4.1 系统调用分发（src/syscall.rs，373 行）

**实现完整度：高（约 100+ 个系统调用）**

系统调用通过 `Sysno` 枚举（来自 `syscalls` crate）进行分发，覆盖了 Linux 系统调用的主要类别：

```rust
#[register_trap_handler(SYSCALL)]
fn handle_syscall(tf: &mut TrapFrame, syscall_num: usize) -> isize {
    let sysno = Sysno::from(syscall_num as u32);
    time_stat_from_user_to_kernel();
    let result = match sysno {
        Sysno::ioctl => sys_ioctl(tf.arg0() as _, tf.arg1() as _, tf.arg2().into()),
        Sysno::openat => sys_openat(tf.arg0() as _, tf.arg1().into(), tf.arg2() as _, tf.arg3() as _),
        // ... 100+ 个系统调用
        _ => { warn!("Unimplemented syscall: {}", syscall_num); Err(LinuxError::ENOSYS) }
    };
    time_stat_from_kernel_to_user();
    result.unwrap_or_else(|e| -e.code() as isize)
}
```

**覆盖的系统调用类别**：
- 文件系统控制：ioctl、chdir、mkdir、mkdirat、getdents64、linkat、unlinkat、getcwd、renameat、renameat2、utimensat
- 文件描述符操作：openat、open、close、dup、dup2、dup3、fcntl
- I/O 操作：read、readv、write、writev、lseek、sendfile、pread64、pwrite64、copy_file_range、ftruncate
- I/O 多路复用：poll、ppoll、select、pselect6
- 文件系统挂载：mount、umount2
- 管道：pipe、pipe2
- 文件状态：stat、fstat、lstat、fstatat、statx、access、faccessat2、statfs
- 内存管理：brk、mmap、munmap、mprotect
- 进程信息：getpid、getppid、gettid
- 进程调度：sched_yield、nanosleep
- 进程操作：clone、fork、execve、exit、exit_group、wait4、set_tid_address、arch_prctl
- 信号：rt_sigaction、rt_sigprocmask、rt_sigreturn、rt_sigpending、kill、tkill、tgkill、rt_sigqueueinfo、rt_tgsigqueueinfo、rt_sigtimedwait、rt_sigsuspend、sigaltstack
- 网络：socket、bind、connect、listen、accept、sendto、recvfrom、getsockname、getpeername
- IPC：shmget、shmat、shmdt、shmctl
- Futex：futex
- 时间：clock_gettime、gettimeofday、times
- 系统信息：uname、getuid、geteuid、getgid、getegid
- 资源限制：prlimit64、getrlimit、setrlimit

**特殊处理**：
- x86_64 架构特有的系统调用（如 `arch_prctl`、`open`、`stat` 等旧版调用）通过 `#[cfg(target_arch = "x86_64")]` 条件编译支持
- `sync` 和 `fsync` 作为 stub 直接返回成功
- 未实现的系统调用返回 `ENOSYS`

### 4.2 进程/线程管理（api/src/imp/task/，约 700 行；core/src/task.rs，365 行）

**实现完整度：高**

#### 4.2.1 数据结构

```rust
pub struct ProcessData {
    pub exe_path: RwLock<String>,
    pub aspace: Arc<Mutex<AddrSpace>>,
    pub ns: AxNamespace,
    heap_bottom: AtomicUsize,
    heap_top: AtomicUsize,
    pub child_exit_wq: WaitQueue,
    pub exit_signal: Option<Signo>,
    pub signal: Arc<ProcessSignalManager<RawMutex, WaitQueueWrapper>>,
    pub futex_table: FutexTable,
    pub resource_limits: Arc<Mutex<ResourceLimits>>,
}

pub struct ThreadData {
    pub clear_child_tid: AtomicUsize,
    pub signal: ThreadSignalManager<RawMutex, WaitQueueWrapper>,
}

pub struct TaskExt {
    pub time: RefCell<TimeStat>,
    pub thread: Arc<Thread>,
}
```

#### 4.2.2 clone 系统调用

`sys_clone` 实现了完整的 Linux clone 语义，支持以下标志：
- `CLONE_VM`：共享地址空间
- `CLONE_FS`：共享文件系统信息
- `CLONE_FILES`：共享文件描述符表
- `CLONE_SIGHAND`：共享信号处理器
- `CLONE_THREAD`：创建线程（同进程组）
- `CLONE_PARENT`：使用父进程的父进程
- `CLONE_VFORK`：vfork 语义（未完全实现）
- `CLONE_SETTLS`：设置 TLS
- `CLONE_PARENT_SETTID`/`CLONE_CHILD_SETTID`/`CLONE_CHILD_CLEARTID`：TID 管理

关键实现细节：
```rust
let process = if flags.contains(CloneFlags::THREAD) {
    // 线程：共享地址空间和进程
    new_task.ctx_mut().set_page_table_root(
        curr.task_ext().process_data().aspace.lock().page_table_root(),
    );
    curr.task_ext().thread.process()
} else {
    // 进程：创建新的地址空间（除非 CLONE_VM）
    let aspace = if flags.contains(CloneFlags::VM) {
        curr.task_ext().process_data().aspace.clone()
    } else {
        let mut aspace = curr.task_ext().process_data().aspace.lock();
        let mut aspace = aspace.clone_or_err()?;
        copy_from_kernel(&mut aspace)?;
        Arc::new(Mutex::new(aspace))
    };
    // ...
};
```

#### 4.2.3 execve 系统调用

`sys_execve` 实现了程序替换语义：
- 清除当前地址空间的用户区域
- 重新映射信号 trampoline
- 加载新的 ELF 可执行文件
- 支持 shebang 脚本（`.sh` 文件自动调用 busybox sh）
- **限制**：多线程情况下返回 `EAGAIN`（TODO 标记）
- **缺失**：close-on-exec 标志处理（TODO 标记）

#### 4.2.4 exit 与 waitpid

`do_exit` 实现了完整的进程/线程退出流程：
1. 清除 `clear_child_tid` 并唤醒 futex 等待者
2. 如果是最后一个线程，标记进程退出并通知父进程
3. 发送退出信号给父进程
4. 清理文件描述符表

`sys_waitpid` 支持：
- `WNOHANG`：非阻塞等待
- `WNOWAIT`：不回收僵尸进程
- `WALL`/`WCLONE`：等待所有/clone 子进程
- 按 PID、PGID 或任意子进程等待

#### 4.2.5 时间统计

`TimeStat` 结构体跟踪用户态和内核态时间：
```rust
pub struct TimeStat {
    utime_ns: usize,
    stime_ns: usize,
    user_timestamp: usize,
    kernel_timestamp: usize,
    timer_type: TimerType,
    timer_interval_ns: usize,
    timer_remained_ns: usize,
}
```

支持 `REAL`、`VIRTUAL`、`PROF` 三种计时器类型，在每次用户态/内核态切换时更新时间统计。

### 4.3 内存管理（api/src/imp/mm/，约 250 行；core/src/mm.rs，205 行；src/mm.rs，38 行）

**实现完整度：中高**

#### 4.3.1 地址空间布局

各架构的地址空间配置（以 riscv64/loongarch64 为例）：
- 用户空间基址：`0x1000`
- 用户空间大小：`0x3f_ffff_f000`（约 256GB）
- 用户栈顶：`0x4_0000_0000`
- 用户栈大小：`0x1_0000`（64KB）
- 用户堆基址：`0x4000_0000`
- 用户堆大小：`0x1_0000`（64KB）
- 信号 trampoline：`0x4001_0000`

x86_64 和 aarch64 使用更大的地址空间（`0x7fff_ffff_f000`）。

#### 4.3.2 mmap 实现

```rust
pub fn sys_mmap(addr: usize, length: usize, prot: u32, flags: u32, fd: i32, offset: isize) -> LinuxResult<isize> {
    let start_addr = if map_flags.contains(MmapFlags::FIXED) {
        // MAP_FIXED：精确映射到指定地址
        aspace.unmap(dst_addr, aligned_length)?;
        dst_addr
    } else {
        // 查找空闲区域
        aspace.find_free_area(VirtAddr::from(start), aligned_length, ...)
            .or(aspace.find_free_area(aspace.base(), aligned_length, ...))
            .ok_or(LinuxError::ENOMEM)?
    };
    
    aspace.map_alloc(start_addr, aligned_length, permission_flags.into(), populate)?;
    
    // 文件映射：读取文件内容到映射区域
    if populate {
        let file = File::from_fd(fd)?;
        file.read_at(offset as u64, &mut buf)?;
        aspace.write(start_addr, &buf)?;
    }
}
```

支持的特性：
- `MAP_ANONYMOUS`：匿名映射
- `MAP_FIXED`：固定地址映射
- `MAP_PRIVATE`/`MAP_SHARED`：私有/共享映射
- `MAP_STACK`：栈映射（标志接受但未特殊处理）
- 文件映射：支持从文件读取内容到映射区域

#### 4.3.3 brk 实现

```rust
pub fn sys_brk(addr: usize) -> LinuxResult<isize> {
    let heap_bottom = process_data.get_heap_bottom() as usize;
    if addr != 0 && addr >= heap_bottom && addr <= heap_bottom + axconfig::plat::USER_HEAP_SIZE {
        process_data.set_heap_top(addr);
        return_val = addr as isize;
    }
    Ok(return_val)
}
```

**限制**：brk 仅在预分配的堆范围内调整堆顶指针，不会动态扩展堆的物理内存。堆大小固定为 64KB。

#### 4.3.4 缺页异常处理

```rust
#[register_trap_handler(PAGE_FAULT)]
fn handle_page_fault(vaddr: VirtAddr, access_flags: MappingFlags, is_user: bool) -> bool {
    if !is_user && !is_accessing_user_memory() {
        return false;
    }
    let curr = current();
    if !curr.task_ext().process_data().aspace.lock().handle_page_fault(vaddr, access_flags) {
        do_exit(SIGSEGV as _, true);
    }
    true
}
```

支持按需分配物理页（demand paging），通过 `access_user_memory` 机制允许内核态访问用户内存时触发缺页异常。

#### 4.3.5 ELF 加载

`load_user_app` 函数实现了完整的 ELF 加载流程：
1. 支持 shebang 脚本（`#!` 开头的文件）
2. 支持动态链接器（`PT_INTERP` 段）
3. 解析 ELF 段并映射到用户地址空间
4. 构建用户栈（参数、环境变量、辅助向量）
5. 预分配堆空间

### 4.4 文件系统（api/src/imp/fs/，约 1,500 行；api/src/file/，约 700 行）

**实现完整度：高**

#### 4.4.1 文件描述符抽象

```rust
pub trait FileLike: Send + Sync {
    fn read(&self, buf: &mut [u8]) -> LinuxResult<usize>;
    fn write(&self, buf: &[u8]) -> LinuxResult<usize>;
    fn stat(&self) -> LinuxResult<Kstat>;
    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
    fn poll(&self) -> LinuxResult<PollState>;
    fn set_nonblocking(&self, nonblocking: bool) -> LinuxResult;
}
```

实现了四种文件类型：
- `File`：普通文件（封装 `axfs::fops::File`）
- `Directory`：目录（封装 `axfs::fops::Directory`）
- `Pipe`：管道（环形缓冲区实现）
- `Socket`：网络套接字（TCP/UDP）
- `Stdin`/`Stdout`：标准输入输出

文件描述符表使用 `FlattenObjects<Arc<dyn FileLike>, 1024>` 实现，支持最多 1024 个打开的文件。

#### 4.4.2 管道实现

```rust
const RING_BUFFER_SIZE: usize = 256;

struct PipeRingBuffer {
    arr: [u8; RING_BUFFER_SIZE],
    head: usize,
    tail: usize,
    status: RingBufferStatus,
}
```

管道使用 256 字节的环形缓冲区，读写端通过 `Arc<Mutex<PipeRingBuffer>>` 共享。当缓冲区满/空时使用 `axtask::yield_now()` 让出 CPU（TODO 标记：应使用同步原语）。

#### 4.4.3 路径处理与硬链接

`FilePath` 结构体提供规范化的路径表示，`HardlinkManager` 实现硬链接管理：
```rust
pub struct HardlinkManager {
    inner: RwLock<LinkManagerInner>,
}
struct LinkManagerInner {
    links: BTreeMap<String, String>,
    ref_counts: BTreeMap<String, usize>,
}
```

支持硬链接的创建、删除和引用计数管理。

#### 4.4.4 文件系统挂载

```rust
pub fn sys_mount(source: ..., target: ..., fs_type: ..., flags: i32, ...) -> LinuxResult<isize> {
    if fs_type != "vfat" {
        return Err(LinuxError::EPERM);
    }
    // ...
}
```

**限制**：目前仅支持 vfat 文件系统挂载（实际上只是记录挂载信息，未真正实现文件系统切换）。

#### 4.4.5 ext4 文件系统支持

通过 `lwext4_rust` crate 集成 lwext4 C 库，提供 ext4 文件系统支持。该 crate 包含：
- `bindings.rs`：C 绑定（约 2,000 行）
- `blockdev.rs`：块设备抽象（393 行）
- `file.rs`：文件操作（497 行）
- `ulibc.rs`：C 库函数封装（117 行）

### 4.5 I/O 多路复用（api/src/imp/fs/io_mpx/poll.rs，184 行）

**实现完整度：中**

实现了 `poll`、`ppoll`、`select`、`pselect6` 四个系统调用：

```rust
fn do_poll(fds: &mut [pollfd], timeout: Option<TimeValue>) -> LinuxResult<isize> {
    let deadline = timeout.map(|t| wall_time() + t);
    loop {
        axnet::poll_interfaces();
        let mut res = 0;
        for fd in &mut *fds {
            match get_file_like(fd.fd) {
                Ok(f) => match f.poll() {
                    Ok(state) => {
                        if (fd.events & POLLIN as i16) != 0 && state.readable {
                            revents |= POLLIN;
                        }
                        // ...
                    }
                },
            }
        }
        if res > 0 { return Ok(res); }
        if deadline.is_some_and(|d| wall_time() >= d) { return Ok(0); }
        axtask::yield_now();
    }
}
```

**限制**：
- 使用忙等待（busy-wait）+ `yield_now()` 而非事件驱动
- `ppoll` 和 `pselect6` 的信号掩码参数未处理（TODO 标记）
- `select` 的异常文件描述符集合未实现

### 4.6 网络（api/src/imp/net.rs，164 行；api/src/file/net.rs，121 行）

**实现完整度：中**

#### 4.6.1 Socket 抽象

```rust
pub enum Socket {
    Udp(Mutex<UdpSocket>),
    Tcp(Mutex<TcpSocket>),
}
```

支持 TCP 和 UDP 两种协议，基于 ArceOS 的 `axnet` 模块实现。

#### 4.6.2 支持的系统调用

- `socket`：创建套接字（仅支持 `AF_INET`）
- `bind`、`connect`、`listen`、`accept`
- `sendto`、`recvfrom`
- `getsockname`、`getpeername`

**限制**：
- 仅支持 IPv4（`AF_INET`）
- UDP `sendto` 会自动绑定到本地地址
- 缺少 `setsockopt`、`getsockopt` 等选项操作
- 缺少 `sendmsg`、`recvmsg` 等高级 I/O

### 4.7 信号处理（api/src/imp/signal.rs，301 行；api/src/signal.rs，约 80 行）

**实现完整度：高**

#### 4.7.1 支持的信号操作

- `rt_sigaction`：设置/获取信号处理器
- `rt_sigprocmask`：设置/获取信号掩码（支持 `SIG_BLOCK`、`SIG_UNBLOCK`、`SIG_SETMASK`）
- `rt_sigreturn`：从信号处理器返回
- `rt_sigpending`：获取待处理信号
- `rt_sigtimedwait`：等待信号（带超时）
- `rt_sigsuspend`：挂起等待信号
- `sigaltstack`：设置/获取备用信号栈
- `kill`：向进程/进程组发送信号
- `tkill`：向线程发送信号
- `tgkill`：向线程组中的线程发送信号
- `rt_sigqueueinfo`/`rt_tgsigqueueinfo`：排队信号

#### 4.7.2 信号分发机制

```rust
#[register_trap_handler(POST_TRAP)]
fn post_trap_callback(tf: &mut TrapFrame, from_user: bool) {
    if !from_user { return; }
    check_signals(tf, None);
}
```

每次从内核态返回用户态时检查待处理信号。信号处理器的执行通过信号 trampoline 实现，trampoline 代码被映射到用户地址空间的固定地址。

**限制**：
- `SignalOSAction::Stop` 和 `SignalOSAction::Continue` 未完全实现
- `CoreDump` 未实现（直接终止进程）

### 4.8 IPC 共享内存（api/src/imp/ipc/shm.rs，509 行）

**实现完整度：高**

#### 4.8.1 数据结构

```rust
struct ShmInner {
    pub shmid: i32,
    pub page_num: usize,
    pub va_range: BTreeMap<Pid, VirtAddrRange>,
    pub phys_pages: Option<Arc<SharedPages>>,
    pub rmid: bool,
    pub mapping_flags: MappingFlags,
    pub shmid_ds: ShmidDs,
}

struct ShmManager {
    key_shmid: BiBTreeMap<i32, i32>,
    shmid_inner: BTreeMap<i32, Arc<Mutex<ShmInner>>>,
    pid_shmid_vaddr: BTreeMap<Pid, BiBTreeMap<i32, VirtAddr>>,
}
```

#### 4.8.2 支持的操作

- `shmget`：创建/获取共享内存段
- `shmat`：附加共享内存到进程地址空间
- `shmdt`：分离共享内存
- `shmctl`：控制共享内存（`IPC_RMID`、`IPC_STAT`、`IPC_SET`）

实现了完整的引用计数和垃圾回收机制：当最后一个进程分离共享内存且标记为删除时，自动释放物理页面。

### 4.9 Futex（api/src/imp/futex.rs，约 80 行；core/src/futex.rs，60 行）

**实现完整度：中**

```rust
pub struct FutexTable(Mutex<BTreeMap<usize, Arc<WaitQueue>>>);
```

支持的操作：
- `FUTEX_WAIT`：等待（支持超时）
- `FUTEX_WAKE`：唤醒指定数量的等待者
- `FUTEX_REQUEUE`/`FUTEX_CMP_REQUEUE`：重新排队等待者

**限制**：
- 缺少 `FUTEX_WAIT_BITSET`、`FUTEX_WAKE_OP` 等高级操作
- 缺少优先级继承支持

### 4.10 时间管理（api/src/imp/time.rs，约 60 行）

**实现完整度：中**

支持的系统调用：
- `clock_gettime`：获取时钟时间（`CLOCK_REALTIME`、`CLOCK_MONOTONIC`）
- `gettimeofday`：获取当前时间
- `times`：获取进程时间统计
- `nanosleep`：睡眠指定时间

**限制**：
- 仅支持 `CLOCK_REALTIME` 和 `CLOCK_MONOTONIC` 两种时钟
- 缺少 `clock_nanosleep`、`timer_create` 等定时器操作

### 4.11 资源限制（api/src/imp/resources.rs，约 80 行；core/src/resources.rs，87 行）

**实现完整度：中**

```rust
pub struct ResourceLimits([ResourceLimit; RLIM_NLIMITS as usize]);

impl ResourceLimits {
    pub fn new() -> Self {
        let mut limits = [ResourceLimit::new_infinite(); RLIM_NLIMITS as usize];
        limits[ResourceLimitType::STACK as usize] = ResourceLimit::new(USER_STACK_SIZE, RLIMIT_INFINITY);
        limits[ResourceLimitType::NOFILE as usize] = ResourceLimit::new(1024, 1024 * 1024);
        // ...
    }
}
```

支持的系统调用：
- `prlimit64`：获取/设置进程资源限制
- `getrlimit`/`setrlimit`：获取/设置当前进程资源限制

支持 16 种资源类型（`RLIMIT_CPU`、`RLIMIT_FSIZE`、`RLIMIT_DATA` 等），但实际执行限制检查的仅有 `RLIMIT_NOFILE`（在 `dup` 时检查）。

### 4.12 设备驱动（crates/，约 3,500 行）

**实现完整度：中**

#### 4.12.1 网络驱动

`axdriver_net` crate 提供三种网卡驱动：
- `dwmac`：StarFive VisionFive 2 板载以太网
- `fxmac`：飞腾 PhytiumPi 平台网卡
- `ixgbe`：Intel 82599 10GbE 网卡

#### 4.12.2 SD 卡驱动

`visionfive2-sd` crate 实现 VisionFive 2 板载 SD 卡控制器驱动，支持 SDIO 协议。

#### 4.12.3 龙芯板级驱动

`ls2k1000la_driver` crate 提供龙芯 2K1000LA 开发板的板级驱动支持。

### 4.13 硬件抽象层（arceos/modules/axhal/）

**实现完整度：高（由 ArceOS 基座提供）**

支持四种架构的：
- CPU 上下文切换
- 中断/异常处理
- 页表管理
- 时间服务
- 控制台 I/O

## 五、子系统交互

### 5.1 系统调用流程

```
用户态程序
    ↓ (ecall/int)
axhal 硬件抽象层（Trap 处理）
    ↓
syscall.rs（系统调用分发）
    ↓
starry-api（具体实现）
    ↓
starry-core（核心数据结构）
    ↓
ArceOS 模块（axmm/axfs/axnet/axtask）
    ↓
axhal（硬件操作）
```

### 5.2 进程创建流程

```
sys_clone/fork
    ↓
创建新 TaskInner（axtask）
    ↓
创建/复制 AddrSpace（axmm）
    ↓
创建 Process/Thread（axprocess）
    ↓
初始化 ProcessData/ThreadData（starry-core）
    ↓
初始化命名空间资源（axns）
    ↓
spawn_task（axtask）
```

### 5.3 文件 I/O 流程

```
sys_read/write
    ↓
get_file_like(fd)（FD_TABLE 查找）
    ↓
FileLike::read/write（动态分发）
    ↓
axfs::fops::File（文件系统操作）
    ↓
axfs（VFS 层）
    ↓
块设备驱动
```

## 六、测试与验证

### 6.1 测试用例

项目包含四类测试用例：
- `junior`：初级测试用例
- `nimbos`：NimboOS 测试用例（C + Rust）
- `libc`：libc 兼容性测试
- `oscomp`：比赛官方测试用例

### 6.2 比赛测试脚本

`apps/oscomp/testcase_list` 显示比赛测试流程：
1. 初始化环境（复制 busybox、设置库路径）
2. 运行 musl 编译的测试：basic、libctest、lua、busybox、iozone
3. 运行 glibc 编译的测试：basic、libctest、lua、busybox、iozone

### 6.3 构建测试

由于环境限制（缺少 musl 交叉编译工具链、缺少完整的 ArceOS 构建环境），未能完成完整的构建和运行测试。但代码结构完整，依赖关系清晰，理论上可以在比赛提供的 Docker 环境中成功构建。

## 七、创新性分析

### 7.1 架构创新

1. **基于 ArceOS 的宏内核实现**：将 ArceOS 微内核生态用于构建宏内核，利用其模块化设计实现灵活的组件组合。

2. **命名空间机制**：使用 `axns` 实现进程级资源隔离，支持 `CLONE_FILES`/`CLONE_FS` 的共享与复制语义，这在教学 OS 中较为少见。

3. **多架构统一支持**：通过条件编译和平台配置实现四种架构的统一支持，代码复用率高。

### 7.2 实现创新

1. **信号 trampoline 映射**：将信号返回代码映射到用户空间固定地址，避免每次信号处理时复制代码。

2. **用户空间指针安全封装**：`UserPtr`/`UserConstPtr` 提供类型安全的用户空间内存访问，结合页表验证防止内核漏洞。

3. **硬链接管理器**：在 VFS 层之上实现硬链接支持，通过引用计数管理链接生命周期。

### 7.3 局限性

1. **依赖外部框架**：核心功能（调度、内存分配、文件系统）依赖 ArceOS，自主实现比例相对较低。

2. **部分功能未完整**：多线程 execve、close-on-exec、信号 Stop/Continue 等功能标记为 TODO。

3. **性能优化不足**：poll/select 使用忙等待，管道使用 yield 而非同步原语。

## 八、项目完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 系统调用分发 | 95% | 覆盖 100+ 个系统调用，少量 stub |
| 进程/线程管理 | 85% | clone/fork/execve/waitpid 完整，多线程 execve 未支持 |
| 内存管理 | 80% | mmap/brk/mprotect 完整，堆大小固定 |
| 文件系统 | 85% | 基本操作完整，挂载功能简化 |
| I/O 多路复用 | 70% | 功能完整但性能差（忙等待） |
| 网络 | 75% | TCP/UDP 基本功能，缺少高级选项 |
| 信号处理 | 90% | 主要信号操作完整，Stop/Continue 未实现 |
| IPC 共享内存 | 90% | 完整实现，含垃圾回收 |
| Futex | 75% | 基本操作完整，缺少高级功能 |
| 时间管理 | 80% | 基本功能完整，缺少定时器 |
| 资源限制 | 70% | 框架完整，实际检查有限 |
| 设备驱动 | 75% | 支持多平台，但依赖外部驱动 |

**总体完整度：约 80%**

## 九、总结

WenyiOS 是一个基于 ArceOS 生态构建的功能较为完整的宏内核操作系统。项目代码结构清晰，采用三层架构设计，实现了 Linux 兼容的主要系统调用接口。

**优点**：
1. 系统调用覆盖面广，支持 100+ 个 Linux 系统调用
2. 多架构支持（x86_64、aarch64、riscv64、loongarch64）
3. 进程/线程管理实现完整，支持 clone 语义
4. 信号处理机制完善
5. IPC 共享内存实现完整，含垃圾回收
6. 代码质量较高，使用 Rust 类型系统保证安全性

**不足**：
1. 核心功能依赖 ArceOS 基座，自主实现比例有限
2. 部分功能标记为 TODO（多线程 execve、close-on-exec 等）
3. I/O 多路复用使用忙等待，性能较差
4. 文件系统挂载功能简化
5. 资源限制的实际执行检查有限

**适用场景**：
- 操作系统教学与学习
- 操作系统内核比赛
- 嵌入式系统原型开发

该项目展示了基于现有框架构建宏内核的可行路径，在有限的开发资源下实现了较高的功能完整度，适合作为操作系统课程的参考实现。