# StarryOS 宏内核项目 - 深度技术分析报告

## 第一章：分析方法与范围

### 1.1 分析方法

本分析通过以下方法对项目进行了系统性审查：

- **静态代码审查**：逐文件阅读了 kernel 核心源码的全部关键模块（约 20,587 行 Rust 代码），涵盖系统调用分发、任务管理、内存管理、文件系统、伪文件系统、网络等子系统。
- **符号追踪与交叉引用**：通过 grep 追踪类型定义、trait 实现、函数调用链、依赖关系。
- **依赖链分析**：分析 Cargo 工作空间中各 crate 间的依赖关系，包括 vendored 第三方 crate（340 个）、本地 fork/覆盖 crate（11 个）。
- **构建与运行日志分析**：分析了项目提供的 RISC-V 平台运行日志 (`os_serial_out_rv.txt`)。
- **完整性评估**：对照 Linux 系统调用接口标准，评估实现完整度。

### 1.2 分析范围

涵盖了以下各层：

| 层次 | 涉及文件 | 代码行数(约) |
|---|---|---|
| 入口与初始化 | `src/main.rs`, `kernel/src/entry.rs`, `kernel/src/lib.rs` | ~130 |
| 系统调用分发 | `kernel/src/syscall/mod.rs` | ~372 |
| 系统调用实现（全部子模块） | `kernel/src/syscall/**/*.rs` | ~8,000 |
| 任务管理核心 | `kernel/src/task/**/*.rs` | ~1,200 |
| 内存管理 | `kernel/src/mm/**/*.rs` | ~2,000 |
| 文件抽象层 | `kernel/src/file/**/*.rs` | ~2,000 |
| 伪文件系统 | `kernel/src/pseudofs/**/*.rs` | ~3,000 |
| 配置 | `kernel/src/config/**/*.rs` | ~200 |
| 第三方基础设施 | `third_party/`, `vendor/` 中的核心 crate | N/A |

---

## 第二章：构建测试

### 2.1 测试尝试

项目提供了预构建的二进制文件 `submit_loongarch64-qemu-virt.bin` 和 `.elf` 文件（约 38-40 MB），表明 LoongArch 架构构建已通过。

运行日志 `os_serial_out_rv.txt` 显示了 RISC-V 平台的一次测试运行：

```
arch = riscv64
platform = riscv64-qemu-virt
target = riscv64gc-unknown-none-elf
build_mode = release
log_level = warn
```

### 2.2 测试结果

该次运行在启动后出现 panic：

```
panicked at kernel/src/entry.rs:46:10:
Failed to resolve executable path: AxErrorKind::NotFound
```

这表明 `/bin/sh` 可执行文件未在根文件系统镜像中找到。这并非内核本身的问题，而是根文件系统镜像构建/配置问题。内核初始化流程（伪文件系统挂载、额外文件系统挂载、ELF 加载器初始化）在此之前已成功执行。

### 2.3 构建配置验证

项目的 `Cargo.toml` 和 `Makefile` 配置完整，支持四种架构的交叉编译：

- `riscv64gc-unknown-none-elf`
- `loongarch64-unknown-none-softfloat`
- `aarch64-unknown-none-softfloat`
- `x86_64-unknown-none`

---

## 第三章：子系统详细拆解

### 3.1 系统调用层

#### 3.1.1 系统调用分发 (`kernel/src/syscall/mod.rs`)

核心匹配分发函数 `handle_syscall` 使用 `syscalls` crate 的 `Sysno` 枚举进行系统调用号匹配：

```rust
pub fn handle_syscall(uctx: &mut UserContext) {
    let Some(sysno) = Sysno::new(uctx.sysno()) else {
        warn!("Invalid syscall number: {}", uctx.sysno());
        uctx.set_retval(-LinuxError::ENOSYS.code() as _);
        return;
    };
    // ... 大 match 语句分发至各子系统处理函数
}
```

统计：**224 个 `Sysno::` 分支**，涵盖文件操作、任务管理、内存管理、网络、同步、IPC、I/O 多路复用、信号、时间、BPF 等。

#### 3.1.2 任务管理系统调用

**clone/fork 实现** (`kernel/src/syscall/task/clone.rs`, 349 行)：

```rust
pub struct CloneArgs {
    pub flags: CloneFlags,
    pub exit_signal: u64,
    pub stack: usize,
    pub tls: usize,
    pub parent_tid: usize,
    pub child_tid: usize,
    pub pidfd: usize,
}
```

- 支持完整 `CloneFlags`（包括 `CLONE_VM`, `CLONE_FILES`, `CLONE_FS`, `CLONE_SIGHAND`, `CLONE_THREAD`, `CLONE_VFORK`, `CLONE_PARENT`, `CLONE_SETTLS`, `CLONE_PARENT_SETTID`, `CLONE_CHILD_SETTID`, `CLONE_CHILD_CLEARTID`, `CLONE_PIDFD`, `CLONE_PTRACE`, `CLONE_UNTRACED`, `CLONE_SYSVSEM`, `CLONE_NEWCGROUP`, `CLONE_NEWUTS`, `CLONE_NEWIPC`, `CLONE_NEWUSER`, `CLONE_NEWPID`, `CLONE_NEWNET`, `CLONE_IO`, `CLONE_CLEAR_SIGHAND`, `CLONE_INTO_CGROUP`, `CLONE_DETACHED`）
- 命名空间相关标志（NEWNS/NEWIPC/NEWNET 等）仅做 stub 支持，打印 warn 日志
- `do_clone` 方法正确处理：
  - 线程创建（共享地址空间和信号处理器）
  - 进程创建（CoW 复制地址空间）
  - 文件描述符表共享/复制
  - 文件系统上下文共享/复制
  - pidfd 创建与写入
  - `clear_child_tid` 设置

**execve 实现** (`kernel/src/syscall/task/execve.rs`, 约 80 行)：

```rust
pub fn sys_execve(uctx: &mut UserContext, path: *const c_char, ...) -> AxResult<isize> {
    // 加载参数
    let path = vm_load_string(path)?;
    let args = vm_load_until_nul(argv)?;
    let envs = vm_load_until_nul(envp)?;

    // 多线程检查（当前不支持）
    if proc_data.proc.threads().len() > 1 {
        return Err(AxError::WouldBlock);
    }

    // 加载新 ELF 到地址空间，替换当前地址空间
    let (entry_point, user_stack_base) = load_user_app(&mut aspace, ...)?;

    // 重置信号处理器为默认
    *proc_data.signal.actions.lock() = Default::default();

    // 关闭 CLOEXEC 文件描述符
    // ...

    uctx.set_ip(entry_point.as_usize());
    uctx.set_sp(user_stack_base.as_usize());
    Ok(0)
}
```

- 正确实现了 execve 语义（替换地址空间、重置信号处理器、关闭 CLOEXEC fd）
- 限制：**不支持多线程进程的 execve**

**exit 实现** (`kernel/src/syscall/task/exit.rs`+`kernel/src/task/ops.rs` 的 `do_exit` 函数)：

```rust
pub fn do_exit(exit_code: i32, group_exit: bool) {
    // 1. 清除 clear_child_tid 并 futex 唤醒
    // 2. 处理 robust list（健壮互斥锁清理）
    // 3. 从进程的线程列表中移除
    // 4. 如果是最后一个线程，发送退出信号给父进程
    // 5. 唤醒父进程的 child_exit_event
    // 6. 如果 group_exit，向所有线程发送 SIGKILL
}
```

完整实现了：
- `clear_child_tid` 的 futex 唤醒语义
- robust list（健壮 futex）的退出处理
- 进程组退出（SIGKILL 广播）
- 父进程 SIGCHLD 通知

**waitpid 实现** (`kernel/src/syscall/task/wait.rs`, 151 行)：

- 支持 `WNOHANG`, `WUNTRACED`, `WEXITED`, `WCONTINUED`, `WNOWAIT`, `__WNOTHREAD`, `__WALL`, `__WCLONE`
- 支持按 PID、PGID、Any 等待
- 正确处理信号中断与自动重启（SA_RESTART 语义）
- 正确区分 SIGCHLD 与其他信号的唤醒行为

**调度相关** (`kernel/src/syscall/task/schedule.rs`, 249 行)：

- `sys_sched_yield` - 完整实现
- `sys_nanosleep` / `sys_clock_nanosleep` - 支持 TIMER_ABSTIME
- `sys_sched_getaffinity` / `sys_sched_setaffinity` - CPU 亲和性管理
- `sys_sched_getscheduler` / `sys_sched_setscheduler` - 支持 SCHED_OTHER/SCHED_FIFO/SCHED_RR
- `sys_sched_getparam` / `sys_getpriority` / `sys_setpriority`

**线程相关** (`kernel/src/syscall/task/thread.rs`, 89 行)：

- `sys_getpid`, `sys_getppid`, `sys_gettid`, `sys_set_tid_address`
- x86_64 特定: `sys_arch_prctl` (FS/GS 段基址设置)

**作业控制** (`kernel/src/syscall/task/job.rs`, 61 行)：

- `sys_getsid`, `sys_setsid`, `sys_getpgid`, `sys_setpgid`
- 注有 `// TODO: job control` 注释

#### 3.1.3 内存管理系统调用

**mmap 实现** (`kernel/src/syscall/mm/mmap.rs`, 437 行)：

- 完整支持 `PROT_READ/WRITE/EXEC/NONE` 保护标志
- 完整支持 `MAP_SHARED`, `MAP_PRIVATE`, `MAP_FIXED`, `MAP_FIXED_NOREPLACE`, `MAP_ANONYMOUS`, `MAP_POPULATE`, `MAP_NORESERVE`, `MAP_STACK`, `MAP_HUGETLB`, `MAP_HUGE_1GB`, `MAP_DENYWRITE`
- 支持多种后端：
  - 匿名映射 → `Backend::new_alloc`（CoW 后端）
  - 文件映射(SHARED) → `Backend::new_file`（直接文件映射）
  - 文件映射(PRIVATE) → `Backend::new_cow`（CoW 文件映射）
  - 设备映射 → 线性物理地址映射 / CoW 只读映射 / 缓存文件映射
- 大页支持（2MB/1GB）
- 内存过量使用检查

**brk 实现** (`kernel/src/syscall/mm/brk.rs`)：

- 管理进程堆的扩展/收缩，带 `USER_HEAP_SIZE_MAX` 上限（RISC-V: 0x2000_0000 = 512MB）

**munmap/mprotect** (`kernel/src/mm/aspace/mod.rs`)：

- `AddrSpace::unmap` 正确释放物理页框（CoW 引用计数递减）
- `AddrSpace::protect` 更新页表权限

**mincore** (`kernel/src/syscall/mm/mincore.rs`)：

- 查询页面是否在物理内存中

#### 3.1.4 文件系统系统调用

**文件操作** (`kernel/src/syscall/fs/io.rs`, 430 行; `kernel/src/syscall/fs/fd_ops.rs`, 678 行)：

- 完整 read/write/readv/writev 系列（含 pread64/pwrite64/preadv/pwritev/preadv2/pwritev2）
- sendfile, splice, copy_file_range
- open/openat, close, close_range, dup/dup2/dup3, fcntl, flock
- lseek, truncate/ftruncate, fallocate, fsync/fdatasync, fadvise64

**目录与文件元数据** (`kernel/src/syscall/fs/ctl.rs`, 705 行; `kernel/src/syscall/fs/stat.rs`)：

- 完整目录操作：mkdirat, linkat, unlinkat, symlinkat, renameat2, getdents64, getcwd, chdir, fchdir, chroot
- 文件元数据：chown/fchown/fchownat, chmod/fchmod/fchmodat, readlinkat, utimensat
- stat 系列：stat/fstat/lstat/newfstatat/fstatat/statx, access/faccessat/faccessat2
- 挂载：mount, umount2, sync, syncfs, acct

**特殊文件类型**：

| 系统调用 | 文件 | 状态 |
|---------|------|------|
| pipe2/pipe | `kernel/src/syscall/fs/pipe.rs` | 完整实现 |
| eventfd2 | `kernel/src/syscall/fs/event.rs` | 完整实现 |
| memfd_create | `kernel/src/syscall/fs/memfd.rs` | 完整实现 |
| pidfd_open/pidfd_getfd/pidfd_send_signal | `kernel/src/syscall/fs/pidfd.rs` | 完整实现 |
| signalfd4 | `kernel/src/syscall/fs/signalfd.rs` | 完整实现 |
| timerfd_create/timerfd_settime/timerfd_gettime | `kernel/src/syscall/fs/timerfd.rs` | 完整实现 |

#### 3.1.5 网络系统调用

**套接字操作** (`kernel/src/syscall/net/socket.rs` + 其他网络文件)：

- `sys_socket`：支持 AF_INET/AF_INET6 (TCP/UDP/RAW)、AF_UNIX (STREAM/DGRAM)、AF_PACKET (DGRAM)、AF_VSOCK
- `sys_bind`：含特权端口检查 (uid != 0 时 port < 1024 返回 EACCES)
- `sys_connect`：正确转换 EWOULDBLOCK 为 EINPROGRESS
- `sys_listen`, `sys_accept`/`sys_accept4`：含 O_CLOEXEC 和 O_NONBLOCK 支持
- `sys_shutdown`, `sys_socketpair`（仅 AF_UNIX）
- `sys_getsockname`, `sys_getpeername`, `sys_getsockopt`, `sys_setsockopt`
- `sys_sendto`, `sys_recvfrom`, `sys_sendmsg`, `sys_recvmsg`：含完整 cmsg（控制消息）支持
- `sys_sendmmsg`, `sys_recvmmsg`

**Raw IPv6 Socket** (`kernel/src/file/net.rs` 中的 `RawIpv6Socket`)：

- 自定义实现的 raw IPv6 数据包收发
- 支持 ICMPv6 过滤器、checksum 偏移量设置
- 基于全局数据包缓冲区的进程间通信

**Packet Socket** (`kernel/src/file/net.rs` 中的 `PacketSocket`)：

- AF_PACKET/SOCK_DGRAM 实现

#### 3.1.6 信号系统调用 (`kernel/src/syscall/signal.rs`)

完整实现：

- `sys_rt_sigaction`：含完整的 kernel_sigaction/sigaction 转换
- `sys_rt_sigprocmask`：SIG_BLOCK/SIG_UNBLOCK/SIG_SETMASK
- `sys_rt_sigpending`
- `sys_kill`：支持 pid > 0, pid == 0 (进程组), pid == -1 (广播), pid < -1 (进程组)
- `sys_tkill`, `sys_tgkill`
- `sys_rt_sigqueueinfo`, `sys_rt_tgsigqueueinfo`
- `sys_rt_sigreturn`：从信号处理函数返回
- `sys_rt_sigtimedwait`：含超时、信号等待、SIGKILL 检测
- `sys_rt_sigsuspend`：临时替换信号掩码并等待
- `sys_rt_sigpending`
- `sys_signalfd4`（在 fs/signalfd.rs）

#### 3.1.7 同步系统调用

**futex** (`kernel/src/syscall/sync/futex.rs`)：

```rust
pub fn sys_futex(uaddr, futex_op, value, timeout, uaddr2, value3) -> AxResult<isize> {
    match command {
        FUTEX_WAIT | FUTEX_WAIT_BITSET => { /* 含快速路径检查和超时 */ }
        FUTEX_WAKE | FUTEX_WAKE_BITSET => { /* 唤醒等待者 */ }
        FUTEX_REQUEUE | FUTEX_CMP_REQUEUE => { /* 重新排队到另一个 futex */ }
    }
}
```

- 支持 FUTEX_WAIT, FUTEX_WAKE, FUTEX_WAIT_BITSET, FUTEX_WAKE_BITSET
- 支持 FUTEX_REQUEUE, FUTEX_CMP_REQUEUE
- 支持 robust list (get_robust_list / set_robust_list)
- 支持 EOWNERDEAD 错误返回

**membarrier** (`kernel/src/syscall/sync/membarrier.rs`)：

- 基础 stub 实现

#### 3.1.8 I/O 多路复用

**epoll** (`kernel/src/syscall/io_mpx/epoll.rs`, `kernel/src/file/epoll.rs`, 共约 510 行)：

- `sys_epoll_create1`：CLOEXEC 标志支持
- `sys_epoll_ctl`：ADD/MOD/DEL，支持 EPOLLET (边沿触发) 和 EPOLLONESHOT
- `sys_epoll_pwait` / `sys_epoll_pwait2`：超时和 sigmask 支持

实现细节（`kernel/src/file/epoll.rs`）：
```rust
enum TriggerMode {
    Level,            // 水平触发
    Edge,             // 边沿触发
    OneShot { fired }, // 一次性触发
}
```

- `InterestWaker` 结构通过 `Weak<EpollInner>` 实现 epoll 实例的弱引用唤醒
- `EpollInner` 维护 `interests: HashMap` 和 `ready_queue: VecDeque`
- 正确实现了 LT/ET/ONESHOT 三种触发模式
- `consume` 方法正确处理事件消费和重新入队逻辑

**poll/select** (`kernel/src/syscall/io_mpx/poll.rs`, `select.rs`)：

- `sys_ppoll`：含超时和 sigmask 支持
- `sys_pselect6`：含 sigmask 支持

#### 3.1.9 IPC 系统调用

**System V 共享内存** (`kernel/src/syscall/ipc/shm.rs`, 568 行)：

- `sys_shmget`：IPC_PRIVATE/IPC_CREAT/IPC_EXCL，权限检查
- `sys_shmat`：SHM_RDONLY/SHM_RND/SHM_REMAP，基于 `SharedPages` 后端
- `sys_shmdt`：分离共享内存
- `sys_shmctl`：IPC_RMID/IPC_SET/IPC_STAT/IPC_INFO/SHM_INFO/SHM_STAT

```rust
pub struct ShmInner {
    pub shmid: i32,
    pub page_num: usize,
    va_range: BTreeMap<Pid, VirtAddrRange>,
    pub phys_pages: Option<Arc<SharedPages>>,
    pub rmid: bool,
    pub mapping_flags: MappingFlags,
    pub shmid_ds: ShmidDs,
}
```

- 全局 `SHM_MANAGER` (Mutex) 管理所有共享内存段
- `clear_proc_shm` 在进程退出时清理

**System V 消息队列** (`kernel/src/syscall/ipc/msg.rs`, 913 行)：

- `sys_msgget`, `sys_msgsnd`, `sys_msgrcv`, `sys_msgctl`
- 完整的消息队列操作
- 权限检查 (`has_ipc_permission`)

#### 3.1.10 时间系统调用

(`kernel/src/syscall/time.rs`, 415 行)：

- `sys_clock_gettime`：CLOCK_REALTIME/MONOTONIC/BOOTTIME/PROCESS_CPUTIME_ID/THREAD_CPUTIME_ID
- `sys_clock_settime`：权限检查 (EPERM for non-root)
- `sys_clock_getres`
- `sys_gettimeofday`
- `sys_clock_adjtime` / `sys_adjtimex`：含 Timex 结构和模式验证
- `sys_timer_create`：POSIX 定时器，SIGEV_SIGNAL/SIGEV_NONE
- `sys_timer_settime`：TIMER_ABSTIME 支持
- `sys_timer_gettime`
- `sys_timer_delete`
- `sys_setitimer` / `sys_getitimer`：ITIMER_REAL/VIRTUAL/PROF

#### 3.1.11 BPF 系统调用

(`kernel/src/syscall/bpf.rs`, 433 行)：

- `sys_bpf`：支持基本 BPF 命令（如 BPF_MAP_CREATE, BPF_PROG_LOAD 等）
- 具体的实现深度需要进一步验证

#### 3.1.12 系统信息与资源管理

- `sys_uname`, `sys_sysinfo`, `sys_getrlimit`, `sys_setrlimit`, `sys_prctl`

---

### 3.2 任务管理子系统 (`kernel/src/task/`)

#### 3.2.1 核心数据结构

**Thread** (`kernel/src/task/mod.rs`)：

```rust
pub struct Thread {
    pub proc_data: Arc<ProcessData>,    // 进程共享数据
    clear_child_tid: AtomicUsize,       // set_tid_address
    robust_list_head: AtomicUsize,      // 健壮 futex 列表
    pub signal: Arc<ThreadSignalManager>, // 线程级信号管理
    pub time: AssumeSync<RefCell<TimeManager>>, // 定时器
    oom_score_adj: AtomicI32,           // OOM 分数
    pub exit: Arc<AtomicBool>,          // 退出标志
    accessing_user_memory: AtomicBool,  // 用户内存访问标志
    pub exit_event: Arc<PollSet>,       // 退出事件
}
```

**ProcessData** (`kernel/src/task/mod.rs`)：

```rust
pub struct ProcessData {
    pub proc: Arc<Process>,              // starry-process 的 Process
    pub exe_path: RwLock<String>,        // 可执行文件路径
    pub cmdline: RwLock<Arc<Vec<String>>>, // 命令行
    pub aspace: Arc<Mutex<AddrSpace>>,    // 地址空间
    pub scope: RwLock<Scope>,            // 资源作用域
    heap_top: AtomicUsize,               // 堆顶
    pub rlim: RwLock<Rlimits>,           // 资源限制
    pub child_exit_event: Arc<PollSet>,  // 子进程退出事件
    pub exit_event: Arc<PollSet>,        // 自身退出事件
    pub exit_signal: Option<Signo>,      // 退出信号
    pub signal: Arc<ProcessSignalManager>, // 进程级信号管理
    futex_table: Arc<FutexTable>,        // 私有 futex 表
    umask/uid/gid/nice: Atomic*         // 进程属性
}
```

设计亮点：
- `Thread` 和 `ProcessData` 分离设计，`ProcessData` 通过 `Arc` 在多线程间共享
- 通过 `#[extern_trait]` 宏将 `Thread` 注入 `axtask::TaskExt` 机制
- `AssumeSync<T>` 包装器用于处理 `RefCell<TimeManager>` 的跨线程安全

#### 3.2.2 任务表管理 (`kernel/src/task/ops.rs`)

```rust
static TASK_TABLE: RwLock<WeakMap<Pid, WeakAxTaskRef>>
static PROCESS_TABLE: RwLock<WeakMap<Pid, Weak<ProcessData>>>
static PROCESS_GROUP_TABLE: RwLock<WeakMap<Pid, Weak<ProcessGroup>>>
static SESSION_TABLE: RwLock<WeakMap<Pid, Weak<Session>>>
```

- 四级表结构：任务 → 进程 → 进程组 → 会话
- 使用 `WeakMap` 实现自动清理（当强引用归零时条目自动移除）
- `cleanup_task_tables()` 函数用于在内存泄漏分析时主动清理

#### 3.2.3 Futex 实现 (`kernel/src/task/futex.rs`)

```rust
pub struct WaitQueue {
    queue: SpinNoIrq<VecDeque<(Waker, u32)>>,
}
```

- `WaitQueue::wait_if`：使用 `poll_fn` + `interruptible` + `timeout` 实现可中断等待
- `WaitQueue::wake`：支持 bitset 掩码匹配的唤醒
- `WaitQueue::requeue`：将等待者从一个队列移动到另一个

**FutexKey** 分类：

```rust
pub enum FutexKey {
    Private { address: usize },            // 进程私有 futex
    Shared { offset: usize, region: ... }, // 共享内存中的 futex
}
```

- 私有 futex 使用进程本地 `FutexTable`
- 共享 futex 使用全局 `SHARED_FUTEX_TABLES`（按共享区域指针索引）

#### 3.2.4 信号子系统 (`kernel/src/task/signal.rs` + `vendor/starry-signal/`)

信号发送流程：
```
send_signal_to_process/thread/tgkill
  → ProcessSignalManager::send_signal (选择目标线程)
    → ThreadSignalManager::send_signal (将信号加入 pending 集合)
      → task.interrupt() (中断目标任务)
        → 必要时发送 IPI (跨 CPU 强制检查信号)
```

`check_signals` 函数处理信号的检查与分发：

```rust
pub fn check_signals(thr: &Thread, uctx: &mut UserContext, restore_blocked: Option<SignalSet>) -> bool {
    let Some((sig, os_action)) = thr.signal.check_signals(uctx, restore_blocked) else {
        return false;
    };
    match os_action {
        SignalOSAction::Terminate => do_exit(signo as i32, true),
        SignalOSAction::CoreDump => do_exit(128 + signo as i32, true), // TODO
        SignalOSAction::Stop => do_exit(1, true),                      // TODO
        SignalOSAction::Continue => {}                                  // TODO
        SignalOSAction::Handler => {}                                   // 信号帧已由 check_signals 设置
    }
}
```

信号 trampoline (RISC-V)：

```asm
signal_trampoline:
    li a7, 139        # sys_rt_sigreturn
    ecall
```

#### 3.2.5 定时器管理 (`kernel/src/task/timer.rs`)

```rust
pub struct TimeManager {
    state: TimerState,
    // 管理 ITIMER_REAL/VIRTUAL/PROF
}
```

- 支持 setitimer/getitimer 的三种定时器类型
- `poll` 方法检查定时器是否到期并发送信号

---

### 3.3 内存管理子系统 (`kernel/src/mm/`)

#### 3.3.1 地址空间 (`kernel/src/mm/aspace/mod.rs`)

```rust
pub struct AddrSpace {
    va_range: VirtAddrRange,
    areas: MemorySet<Backend>,     // 基于 memory_set crate 的 VMA 管理
    pt: PageTable,                 // 页表
}
```

主要操作：
- `map`：使用指定后端映射内存区域
- `unmap`：解除映射并释放物理页框（通过后端）
- `protect`：修改页面权限
- `populate_area`：预填充物理页面
- `find_free_area`：寻找空闲虚拟地址范围（用于 mmap）
- `read`/`write`：跨地址空间安全读写（遍历页表进行物理地址转换）

#### 3.3.2 内存映射后端 (`kernel/src/mm/aspace/backend/`)

**Backend trait 体系**：

```rust
#[enum_dispatch(BackendOps)]
pub enum Backend {
    Linear(linear::LinearBackend),   // 线性映射（物理地址偏移）
    Cow(cow::CowBackend),            // 写时复制
    Shared(shared::SharedBackend),   // 共享内存
    File(file::FileBackend),         // 文件映射
}
```

**CoW 后端** (`cow.rs`, 307 行)：

核心设计——全局引用计数帧表：

```rust
static FRAME_TABLE: SpinNoIrq<FrameTableRefCount> = ...;

struct FrameTableRefCount {
    table: BTreeMap<PhysAddr, Arc<SpinNoIrq<FrameRefCnt>>>,
}
```

- `clone_map` 实现 fork 的 CoW 语义：将旧页表条目标记为只读，在新页表中映射同一物理页框，递增引用计数
- `handle_cow_fault` 处理写时复制缺页：
  - 引用计数 == 1：直接升级权限（无需复制）
  - 引用计数 > 1：分配新页框，复制数据，重新映射
- `alloc_new_at` 分配填充了文件数据的新页框（用于文件映射的 CoW）

**文件后端** (`file.rs`, 278 行)：

- 直接基于文件缓存 (`CachedFile`) 的映射
- 支持读取时按需填充和写回

**共享后端** (`shared.rs`, 125 行)：

- 基于 `SharedPages` 的共享内存映射
- 用于 System V 共享内存和 MAP_SHARED 匿名映射

#### 3.3.3 ELF 加载器 (`kernel/src/mm/loader.rs`, 345 行)

```rust
struct ElfLoader(LRUCache<ElfCacheEntry, 32>);
```

- 使用 LRU 缓存（32 个条目）缓存最近使用的 ELF 文件
- 支持动态链接器（解释器段 PT_INTERP）
- 自动构建 AUX 向量

加载流程：
```
load_user_app
  → ElfLoader::load
    → 解析 ELF headers
    → 检测 PT_INTERP（动态链接器）
    → map_elf（映射 LOAD 段到地址空间）
      → Backend::new_cow (CoW 文件映射)
    → 映射 signal trampoline
    → 构建 AUX 向量（AT_PHDR, AT_ENTRY, AT_BASE 等）
    → 设置用户栈（参数、环境变量、AUX 向量）
```

#### 3.3.4 用户空间内存访问 (`kernel/src/mm/access.rs`, 413 行)

基于 `starry-vm` crate 的 `VmIo` trait：

```rust
#[extern_trait(VmImpl)]
pub unsafe trait VmIo {
    fn read(&mut self, start: usize, buf: &mut [MaybeUninit<u8>]) -> VmResult;
    fn write(&mut self, start: usize, buf: &[u8]) -> VmResult;
}
```

- `UserPtr<T>` / `UserConstPtr<T>` 包装器提供了类型安全的用户空间指针
- `VmPtr` trait 提供 `.vm_read()`, `.vm_write()` 方法
- `vm_load_string` 等便捷函数封装了 C 字符串的加载

---

### 3.4 文件系统子系统

#### 3.4.1 文件抽象层 (`kernel/src/file/mod.rs`)

**FileLike trait**：

```rust
pub trait FileLike: Pollable + DowncastSync {
    fn read(&self, _dst: &mut IoDst) -> AxResult<usize> { Err(AxError::InvalidInput) }
    fn write(&self, _src: &mut IoSrc) -> AxResult<usize> { Err(AxError::InvalidInput) }
    fn stat(&self) -> AxResult<Kstat> { Ok(Kstat::default()) }
    fn path(&self) -> Cow<'_, str>;
    fn ioctl(&self, _cmd: u32, _arg: usize) -> AxResult<usize> { Err(AxError::NotATty) }
    fn nonblocking(&self) -> bool { false }
    fn set_nonblocking(&self, _nonblocking: bool) -> AxResult { Ok(()) }
}
```

所有文件类型通过实现 `FileLike` trait 统一处理：
- `File`（常规文件）
- `Directory`（目录）
- `Socket` / `PacketSocket` / `RawIpv6Socket`（套接字）
- `Pipe`（管道）
- `Epoll`（epoll 实例）
- `EventFd`（eventfd）
- `PidFd`（pidfd）
- `Signalfd`（signalfd）
- `TimerFd`（timerfd）

文件描述符表使用 `scope_local` crate 实现作用域本地存储：

```rust
scope_local! {
    pub static FD_TABLE: Arc<RwLock<FlattenObjects<FileDescriptor, AX_FILE_LIMIT>>>;
}
```

#### 3.4.2 管道实现 (`kernel/src/file/pipe.rs`)

- 基于 `ringbuf::HeapRb` 环形缓冲区，初始容量 64KB
- 支持阻塞/非阻塞读写
- 支持 `FIONREAD` ioctl
- 支持通过 fcntl 调整管道容量（`Pipe::resize`）
- 正确处理 SIGPIPE 信号（写端关闭时）
- 正确处理 EOF 检测（读端关闭时返回 0）
- 基于 `PollSet` 的 poll 支持

#### 3.4.3 epoll 实现 (`kernel/src/file/epoll.rs`, 455 行)

完整的三触发模式实现：
- **Level-triggered**：只要条件满足就持续通知
- **Edge-triggered**：仅在条件变化时通知一次
- **One-shot**：仅通知一次后禁用

```rust
fn consume(&self, file: &dyn FileLike) -> ConsumeResult {
    match *mode {
        TriggerMode::Level => ConsumeResult::EventAndKeep(event),
        TriggerMode::Edge | TriggerMode::OneShot { .. } => ConsumeResult::EventAndRemove(event),
    }
}
```

`InterestWaker` 结构使用弱引用避免循环引用：
```rust
struct InterestWaker {
    epoll: Weak<EpollInner>,
    interest: Weak<EpollInterest>,
}
```

#### 3.4.4 timerfd 实现 (`kernel/src/file/timerfd.rs`)

- 支持 CLOCK_REALTIME 和 CLOCK_MONOTONIC
- 支持 TFD_TIMER_ABSTIME 标志
- 正确处理周期性定时器（interval）
- `count_expirations` 方法精确计算到期次数（包括自上次读取以来的累积到期）

#### 3.4.5 signalfd 实现 (`kernel/src/file/signalfd.rs`)

- 128 字节的 `signalfd_siginfo` 结构体（与 Linux ABI 完全兼容）
- 从线程信号 pending 集合中出队信号
- `ssi_signo`, `ssi_code`, `ssi_errno` 正确填充

#### 3.4.6 套接字实现 (`kernel/src/file/net.rs`, 342 行)

- `Socket` 结构包装 `axnet::SocketInner`
- `RawIpv6Socket`：自定义 raw IPv6 socket，使用全局数据包缓冲区
- `PacketSocket`：AF_PACKET 实现

---

### 3.5 伪文件系统 (`kernel/src/pseudofs/`)

#### 3.5.1 框架 (`kernel/src/pseudofs/mod.rs`, `fs.rs`, `dir.rs`, `file.rs`, `device.rs`)

- `SimpleFs`：基于 axfs_ng_vfs 的简单文件系统框架
- `NodeOpsMux`：统一了目录 (`DirMaker`) 和文件/设备 (`FileNodeOps`) 的创建
- `Device`：设备节点，包装 `DeviceOps` trait
- `SimpleDir`：目录节点，基于 `DirMapping` 表

#### 3.5.2 `/dev` 文件系统 (`kernel/src/pseudofs/dev/mod.rs`)

设备节点清单：
| 设备 | 类型 | 主:次设备号 | 实现 |
|------|------|------------|------|
| `/dev/null` | 字符 | 1:3 | 读返回 0，写丢弃 |
| `/dev/zero` | 字符 | 1:5 | 读返回零，写丢弃 |
| `/dev/full` | 字符 | 1:7 | 写返回 ENOSPC |
| `/dev/random` | 字符 | 1:8 | 基于 `SmallRng` 的随机数 |
| `/dev/urandom` | 字符 | 1:9 | 同 random |
| `/dev/kmsg` | 字符 | 1:11 | 空实现 |
| `/dev/rtc0` | 字符 | - | RTC 设备 |
| `/dev/fb0` | 字符 | 29:0 | 帧缓冲（条件编译） |
| `/dev/tty` | 字符 | 5:0 | 当前 TTY |
| `/dev/console` | 字符 | 5:1 | N_TTY 控制台 |
| `/dev/ptmx` | 字符 | 5:2 | PTY master |
| `/dev/pts/` | 目录 | - | PTY slave 目录 |
| `/dev/fd` | 符号链接 | - | → /proc/self/fd |
| `/dev/stdin` | 符号链接 | - | → /proc/self/fd/0 |
| `/dev/stdout` | 符号链接 | - | → /proc/self/fd/1 |
| `/dev/stderr` | 符号链接 | - | → /proc/self/fd/2 |
| `/dev/shm` | 目录 | - | 挂载 tmpfs |
| `/dev/loop0-15` | 块 | 7:0 | Loop 设备 (16 个) |
| `/dev/cpu_dma_latency` | 字符 | 10:1024 | PM QoS |
| `/dev/log` | 套接字 | - | 条件编译 |
| `/dev/input/` | 目录 | - | 条件编译 |
| `/dev/memtrack` | 字符 | - | 条件编译 |

#### 3.5.3 TTY 子系统 (`kernel/src/pseudofs/dev/tty/`)

- **`Tty<R,W>`**：泛型 TTY 设备，参数化读/写端
- **`LineDiscipline`**：行规程（`ldisc.rs`, 371 行），实现规范模式 (canonical) 和原始模式
- **`Termios`/`Termios2`**：完整的终端 I/O 属性
- **`JobControl`**：作业控制（前台/后台进程组、会话管理）
- **PTY**：`Ptmx` (master) 和 `PtsDir` (slave) 实现
- `N_TTY`：全局内核控制台 TTY

支持的 ioctl：
- TCGETS/TCSETS/TCSETSF/TCSETSW：获取/设置 termios
- TCGETS2/TCSETS2/TCSETSF2/TCSETSW2：获取/设置 termios2
- TIOCGPGRP/TIOCSPGRP：获取/设置前台进程组
- TIOCGWINSZ/TIOCSWINSZ：获取/设置窗口大小
- TIOCGPTN/TIOCSPTLCK：PTY 管理
- TIOCSCTTY/TIOCNOTTY：控制终端管理

#### 3.5.4 `/proc` 文件系统 (`kernel/src/pseudofs/proc.rs`, 530 行)

提供以下 proc 条目：
- `/proc/meminfo`：硬编码的虚拟内存信息
- `/proc/sched_debug`：调度调试信息
- `/proc/config`：伪内核配置
- `/proc/self/`：当前进程信息（fd 目录、stat、status、exe 符号链接等）
- `/proc/[pid]/`：各进程信息
- `/proc/sys/` 部分条目

#### 3.5.5 内存文件系统 (`kernel/src/pseudofs/tmp.rs`, 462 行)

`MemoryFs`：完整的 in-memory 文件系统实现：
- 基于 `Slab` 分配器管理 inode
- 支持目录、文件、符号链接
- 支持读写、截断、元数据更新
- 用于 `/tmp` 和 `/dev/shm` 挂载

---

### 3.6 底层基础设施

#### 3.6.1 ArceOS 派生组件

项目通过 `[patch.crates-io]` 覆盖了以下关键 crate：

| Crate | 路径 | 用途 |
|-------|------|------|
| `axruntime` | `third_party/arceos/axruntime` | 运行时初始化 |
| `axfs-ng` | `third_party/arceos/axfs` | 文件系统框架 |
| `axsched` | `third_party/axsched` | 调度器 |
| `axtask` | `third_party/axtask` | 任务管理 |
| `axnet-ng` | `third_party/axnet-ng` | 网络协议栈 |
| `axio` | `third_party/axio` | I/O 抽象 |
| `starry-vm` | `third_party/starry-vm` | 虚拟内存原语 |
| `axplat-riscv64-qemu-virt` | `third_party/axplat-riscv64-qemu-virt` | RISC-V 平台定义 |
| `kernel-elf-parser` | `third_party/kernel-elf-parser` | ELF 解析 |
| `lwext4_rust` | `third_party/lwext4_rust` | ext4 文件系统 |

#### 3.6.2 starry-* 系列 crate

- `starry-process`：进程管理（PID 分配、进程组、会话、父子关系）
- `starry-signal`：信号框架（信号集、信号动作、pending 队列、trampoline）
- `starry-vm`：虚拟内存访问原语（`VmIo` trait、`UserPtr`、跨地址空间读写）

#### 3.6.3 架构支持

通过 `kernel/src/config/` 为各架构提供：
- 用户空间基址和大小
- 栈顶地址和栈大小
- 堆基址和最大堆大小
- 解释器基址
- 信号 trampoline 地址

支持架构：RISC-V 64、LoongArch 64、x86_64、AArch64

---

## 第四章：子系统交互

### 4.1 系统调用完整流程

```
用户态: ecall/syscall
  ↓
axhal (异常处理)
  ↓ UserContext (保存寄存器)
handle_syscall (syscall/mod.rs)
  ↓ 匹配 Sysno
各子系统处理函数 (syscall/fs/, syscall/task/, ...)
  ↓ 操作内核数据结构
task/ mm/ file/ pseudofs/
  ↓ 返回结果
uctx.set_retval() → 返回用户态
```

### 4.2 进程创建流程 (fork/clone)

```
sys_clone/sys_clone3
  ↓
CloneArgs::do_clone
  ├─ 验证标志组合
  ├─ 创建 new_task (axtask)
  ├─ 若 THREAD: 共享 ProcessData 和地址空间
  │   └─ old_proc_data.clone()
  ├─ 若不是 THREAD:
  │   ├─ Process::fork (starry-process)
  │   ├─ AddrSpace::try_clone (CoW 复制)
  │   │   └─ 遍历 MemorySet, 调用 Backend::clone_map
  │   │       └─ CowBackend::clone_map: 标记旧页为只读, 映射相同物理页, 递增引用计数
  │   ├─ ProcessData::new (复制信号动作、资源限制、FD 表、FS 上下文)
  │   └─ copy_from_kernel (复制内核页表部分)
  ├─ 创建 Thread
  ├─ 设置 clear_child_tid / pidfd
  ├─ 将 AxTaskExt 注入 axtask
  └─ spawn_task + add_task_to_table + wake_task
```

### 4.3 页面故障处理流程

```
用户态内存访问触发缺页异常
  ↓
axhal 捕获异常 → PageFaultFlags
  ↓
AddrSpace::populate_area (或自动在 map 时)
  ↓ 找到对应的 MemoryArea
Backend::populate
  ├─ Linear: 直接映射物理页框
  ├─ Cow: 
  │   ├─ 未映射 → alloc_new_at (分配新页框 + 文件数据)
  │   └─ 已映射但不可写 → handle_cow_fault
  │       ├─ refcount==1 → protect (升级权限)
  │       └─ refcount>1 → 分配新页框 + 复制 + remap
  ├─ File: 从文件缓存读取到新页框
  └─ Shared: 映射共享页框
```

### 4.4 信号传递流程

```
send_signal_to_process/tkill/tgkill
  ↓
ProcessSignalManager::send_signal
  ↓ 选择目标线程
ThreadSignalManager::send_signal
  ↓ 加入 pending 集合
task.interrupt()
  ↓ (可能触发 IPI)
下次返回到用户态或内核抢占点时:
  ↓
check_signals (被 axruntime 上下文切换代码调用)
  ↓
ThreadSignalManager::check_signals
  ├─ 检查 blocked & pending
  ├─ 查找信号处理器
  ├─ 构建 UContext (含 sigmask, mcontext)
  ├─ 设置用户栈上的信号帧
  ├─ 设置 sepc 为信号处理器地址
  └─ 返回 SignalOSAction
      ├─ Terminate → do_exit
      ├─ CoreDump → do_exit(128+signo)
      ├─ Stop/Continue → (stub)
      └─ Handler → 返回到用户态的信号处理器
```

### 4.5 I/O 操作流程

```
sys_read/sys_write
  ↓
get_file_like(fd) → Arc<dyn FileLike>
  ↓
FileLike::read/write
  ├─ File → CachedFile::read_at (axfs)
  ├─ Socket → SocketInner::recv/send (axnet)
  ├─ Pipe → ringbuf 环形缓冲区读写
  ├─ Epoll → consume 事件
  ├─ EventFd → 原子计数器
  ├─ TimerFd → count_expirations
  └─ Signalfd → dequeue_signal 并格式化为 signalfd_siginfo
```

### 4.6 文件系统挂载流程

```
entry::init
  ↓
pseudofs::mount_all
  ├─ /dev  ← new_devfs() (SimpleFs + 设备节点目录)
  ├─ /dev/shm ← MemoryFs::new()
  ├─ /tmp ← MemoryFs::new()
  ├─ /proc ← new_procfs() (SimpleFs + proc 条目)
  └─ /sys ← MemoryFs::new() + 图形子系统路径
  ↓
extra_filesystems (竞赛测试磁盘)
  └─ 挂载到 /oscomp
```

---

## 第五章：实现完整度评估

### 5.1 整体评估

| 维度 | 评分 | 依据 |
|------|------|------|
| 系统调用覆盖 | 高 (224个) | 覆盖文件、进程、内存、网络、信号、同步、IPC、I/O复用、时间、BPF 等 |
| 核心机制完整性 | 高 | fork/exec/exit/wait 语义正确，CoW 完整，信号框架完整 |
| 文件系统 | 中高 | 常规文件操作完整，特殊 fd (epoll/signalfd/timerfd/eventfd/pidfd/memfd) 完整 |
| 网络 | 中 | TCP/UDP/Unix socket 完整，IPv6 raw socket 有自定义实现，AF_PACKET 有支持 |
| TTY/PTY | 高 | 行规程、termios、作业控制、PTY master/slave 完整 |
| IPC | 中高 | System V 共享内存和消息队列完整 |
| 调度器 | 中 | SCHED_OTHER/FIFO/RR，CPU 亲和性，优先级 |
| 命名空间 | 低 | stub 支持，实际未实现隔离 |
| 多线程 | 中 | clone(THREAD) 完整，但 execve 不支持多线程 |
| cgroup | 低 | stub 存在（CLONE_INTO_CGROUP 标志识别），实际未实现 |
| 审计/安全模块 | 低 | 未找到完整 LSM 实现 |

### 5.2 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 进程管理 | 90% | fork/clone/exec/exit/wait 完整，缺 cgroup、多线程 execve |
| 内存管理 | 85% | mmap/munmap/mprotect/brk 完整，CoW 完整，大页支持，缺 madvise、mlock 等 |
| 文件系统 | 85% | 常规操作完整，VFS 框架完整，缺 inotify、fanotify、xattr、aio |
| 网络 | 75% | TCP/UDP/Unix 完整，IPv6 raw 自定义，缺 netlink、iptables |
| 信号 | 90% | 完整信号框架，缺 job control stop/continue 实际实现 |
| 同步 | 85% | futex 完整（含 robust list），缺 PI futex、更复杂的 requeue 场景 |
| 时间 | 80% | POSIX 定时器完整，clock_gettime/settime 完整，缺高精度定时器 |
| TTY | 80% | 行规程、termios、job control 框架完整，缺信号驱动的 job control |
| IPC | 80% | SysV shm/msg 完整，缺信号量（sem） |
| epoll | 95% | LT/ET/ONESHOT 完整，pwait/pwait2 完整 |
| 伪文件系统 | 75% | /dev 设备齐全，/proc 基本条目，/sys stub |

### 5.3 已知限制

1. **多线程 execve**：明确不支持（`kernel/src/syscall/task/execve.rs:48-51`），返回 EWOULDBLOCK
2. **命名空间**：clone 标志被识别但不实现隔离语义，仅打印 warn 日志
3. **cgroup**：标志被识别但实际未实现资源控制
4. **Job control**：代码注有 `// TODO: job control`，SIGSTOP/SIGCONT 的实际暂停/恢复未实现
5. **Core dump**：注有 `// TODO: implement core dump`
6. **inotify/fanotify**：未实现
7. **System V 信号量**：未实现（有 shm 和 msg）
8. **文件锁 (OFD locks)**：未在 syscall 中找到
9. **AIO**：未实现

---

## 第六章：设计创新性分析

### 6.1 架构创新

**1. "Unikernel 基底 + 宏内核接口" 的混合架构**

StarryOS 最核心的设计创新在于将 ArceOS unikernel 作为硬件抽象层和驱动框架，在其上构建完整的 Linux 系统调用兼容层：

```
┌─────────────────────────────────────────┐
│        Linux 系统调用接口层              │
│  (syscall, task, mm, file, pseudofs)     │
├─────────────────────────────────────────┤
│        ArceOS unikernel 组件             │
│  (axhal, axmm, axtask, axfs, axnet, ...)│
└─────────────────────────────────────────┘
```

这种设计使得项目能复用 ArceOS 生态的驱动和平台支持，同时提供 Linux 兼容的应用接口。这是一个实用的折中方案——避免了从零编写驱动，但也带来了 unikernel 设计理念与宏内核多进程隔离需求间的潜在张力。

**2. 基于 trait 的统一文件抽象**

`FileLike` trait + `DowncastSync` + `FlattenObjects` 的组合提供了高度可扩展的文件描述符系统：

```rust
pub trait FileLike: Pollable + DowncastSync {
    fn read(&self, _dst: &mut IoDst) -> AxResult<usize> { ... }
    fn write(&self, _src: &mut IoSrc) -> AxResult<usize> { ... }
    fn stat(&self) -> AxResult<Kstat> { ... }
    // ...
}
```

任何实现了 `FileLike` 的类型都可以作为文件描述符添加到全局 FD_TABLE。这种设计将 epoll、socket、pipe、timerfd 等完全不同的对象统一到一个框架下，代码复用性极高。

**3. CoW 后端的全局引用计数帧表**

```rust
static FRAME_TABLE: SpinNoIrq<FrameTableRefCount> = SpinNoIrq::new(...);
```

使用全局 BTreeMap 管理物理页框的引用计数，配合 `Arc<SpinNoIrq<FrameRefCnt>>` 实现了线程安全的 CoW 语义。`clone_map` 中的优化（`frame.0.checked_add(1)`）和 `handle_cow_fault` 中的单引用优化（refcount==1 时直接升级权限）是两个精细的实现细节。

**4. scope-local 资源管理**

```rust
scope_local! {
    pub static FD_TABLE: Arc<RwLock<FlattenObjects<...>>>;
}
```

FD_TABLE 和 FS_CONTEXT 使用 `scope_local` 机制实现了类似 Linux 的 per-process namespace 的资源隔离。`ProcessData::scope` 字段 (RwLock<Scope>) 作为进程级资源作用域，在 clone 时根据 CLONE_FILES/CLONE_FS 标志决定共享还是复制。

**5. FutexKey 的双轨设计**

```rust
pub enum FutexKey {
    Private { address },
    Shared { offset, region },
}
```

通过从虚拟地址自动推断 futex 是私有还是共享（检查 VMA 后端类型），实现了与 Linux 兼容的 futex 语义，同时为跨进程 futex（基于共享内存）提供了支持。

**6. 枚举派发的内存后端**

使用 `enum_dispatch` crate 实现静态分发的后端多态：

```rust
#[enum_dispatch(BackendOps)]
pub enum Backend {
    Linear(...),
    Cow(...),
    Shared(...),
    File(...),
}
```

相比虚函数表，避免了额外的间接调用开销，同时保持了代码组织清晰。

### 6.2 工程创新

- **LRU ELF 缓存**：32 条目的 ELF 解析缓存，减少重复解析开销
- **Weak 引用避免循环**：epoll 的 `InterestWaker` 使用弱引用打破 epoll→interest→waker→epoll 的循环
- **FutexTable 的自动清理**：`FutexGuard` 在 Drop 时检查引用计数和队列空状态，自动清理无人使用的 futex 条目
- **SHARED_FUTEX_TABLES 的定期清理**：每 100 次操作检查一次，清理不再使用的共享 futex 表

---

## 第七章：项目统计总结

### 7.1 代码规模

| 组件 | 文件数 | 代码行数 |
|------|--------|---------|
| kernel 核心 | ~95 个 .rs 文件 | ~20,587 行 |
| 系统调用实现 | ~40 个文件 | ~8,000 行 |
| 任务管理 | ~7 个文件 | ~1,200 行 |
| 内存管理 | ~10 个文件 | ~2,000 行 |
| 文件系统 | ~7 个文件 | ~2,000 行 |
| 伪文件系统 | ~20 个文件 | ~3,000 行 |
| 第三方覆盖 crate | 11 个目录 | N/A |
| vendor crate | 340 个目录 | N/A |

### 7.2 系统调用覆盖

- 总计 224 个系统调用（按 `Sysno::` 分支计数）
- 支持 4 种 CPU 架构（riscv64, loongarch64, x86_64, aarch64）

### 7.3 关键依赖

- ArceOS 生态系统：`axhal`, `axmm`, `axtask`, `axfs`, `axnet`, `axruntime` 等
- 自研 crate：`starry-vm`, `starry-process`, `starry-signal`
- 社区 crate：`memory_set`, `memory_addr`, `ringbuf`, `hashbrown`, `bitflags`, `enum_dispatch`, `bytemuck` 等

---

## 第八章：总体评价

StarryOS 是一个结构清晰、实现扎实的 Linux 兼容宏内核项目。其在 ArceOS unikernel 基础设施之上构建了完整的 Linux 系统调用兼容层，覆盖了约 224 个系统调用。项目的主要优势包括：

1. **系统调用覆盖广**：进程管理、内存管理、文件系统、网络、信号、同步、IPC 等核心子系统均有较完整的实现
2. **设计模式精巧**：`FileLike` trait 统一抽象、CoW 引用计数帧表、FutexKey 双轨、enum_dispatch 后端分发等设计兼具灵活性和性能
3. **TTY/PTY 子系统实现完整**：行规程、termios、作业控制框架均代码齐全
4. **特殊文件描述符覆盖全面**：epoll、signalfd、timerfd、eventfd、pidfd、memfd 全部实现
5. **多架构支持**：RISC-V、LoongArch、x86_64、AArch64 四种架构

主要不足：

1. **多线程 execve 不支持**，限制了某些应用场景
2. **命名空间和 cgroup 仅为 stub**，无法提供容器化隔离
3. **Job control 的 stop/continue 实际语义未实现**
4. **部分高级功能缺失**：inotify、fanotify、AIO、文件锁、System V 信号量等

整体而言，StarryOS 是一个定位清晰的比赛项目，在有限的开发时间内实现了令人印象深刻的系统调用覆盖率和核心机制完整性，是一个优秀的教学和研究型宏内核实现。