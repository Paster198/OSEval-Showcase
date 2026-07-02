# StarryOS 内核项目深入技术分析报告

## 一、分析过程概述

本次分析对 StarryOS 仓库进行了以下维度的深入调查：

1. **静态代码审查**：通读了内核全部 18,876 行 Rust 源代码（共 98 个 `.rs` 文件），覆盖全部 7 个子系统。
2. **依赖关系梳理**：分析了 `Cargo.toml` 中声明的 40+ 个外部 crate 及其作用。
3. **构建系统分析**：审查了 `Makefile` 和 `make/` 下的构建脚本，理解编译流程。
4. **架构配置对比**：对比了 RISC-V 64、LoongArch64、AArch64、x86_64 四种架构的配置常量。
5. **外部库分析**：审查了 `deps/starry-process/` 中的进程管理库实现。

未进行构建与运行测试——因为当前环境缺少 RISC-V 交叉编译目标 `riscv64gc-unknown-none-elf` 的完整 Rust 工具链支持。

---

## 二、项目整体架构

### 2.1 设计理念

StarryOS 是在 ArceOS unikernel 框架之上构建的**宏内核（monolithic kernel）**。它将 ArceOS 的组件化 unikernel 基础转化为类 Linux 的进程化 OS：所有内核组件（任务调度、内存管理、文件系统、网络栈、信号、IPC）运行在同一个内核地址空间，通过 Linux 兼容的系统调用接口为上层用户态程序提供服务。

与纯微内核或纯 unikernel 的区别在于：StarryOS 保留了 ArceOS 的组件化底层（`axhal`、`axmm`、`axfs`、`axnet` 等），但在其之上构建了完整的进程抽象、虚拟内存隔离和 Linux ABI 兼容层。

### 2.2 分层架构

```
+---------------------------------------------------+
|              Linux 用户态程序 (busybox, musl)        |
+---------------------------------------------------+
|     syscall 层 (150+ Linux 系统调用)                 |
|  fs | net | mm | task | signal | ipc | sync | time |
+---------------------------------------------------+
|  task (进程/线程/信号/futex)  |  mm (地址空间/COW)   |
+---------------------------------------------------+
|  file (统一文件抽象)  |  pseudofs (/dev/proc/tmp)   |
+---------------------------------------------------+
|           ArceOS 底层组件 (untrusted)                |
|  axhal | axmm | axtask | axfs | axnet | axdriver    |
+---------------------------------------------------+
|              硬件 (RISC-V/LoongArch/AArch64)         |
+---------------------------------------------------+
```

### 2.3 Crate 结构与代码量

| 组件 | 文件数 | 代码行数 | 说明 |
|------|--------|---------|------|
| syscall 层 | 41 | ~6100 | 系统调用分发与实现 |
| task 子系统 | 8 | ~1700 | 任务/线程/进程管理 |
| mm 子系统 | 10 | ~2100 | 虚拟内存/地址空间 |
| file 子系统 | 9 | ~2300 | 文件抽象层 |
| pseudofs 子系统 | 17 | ~4300 | 伪文件系统 |
| 入口/配置 | 7 | ~400 | 内核入口与架构配置 |
| starry-process 库 | 4 | ~460 | 进程抽象库 |
| **总计** | **98** | **~18,876** | |

---

## 三、子系统详细拆解

### 3.1 系统调用层 (`syscall/`) — 最复杂子系统

系统调用层是 StarryOS 最大的子系统，实现了 **150+ 个 Linux 系统调用**，按功能域分为 11 个子模块。

#### 3.1.1 系统调用分发机制

`handle_syscall()` 是整个系统调用入口，通过 `Sysno` 枚举匹配系统调用号。其核心结构如下：

```rust
// kernel/src/syscall/mod.rs
pub fn handle_syscall(uctx: &mut UserContext) {
    let Some(sysno) = Sysno::new(uctx.sysno()) else {
        warn!("Invalid syscall number: {}", uctx.sysno());
        uctx.set_retval(-LinuxError::ENOSYS.code() as _);
        return;
    };
    let result = match sysno {
        Sysno::ioctl => sys_ioctl(...),
        Sysno::read => sys_read(...),
        Sysno::write => sys_write(...),
        // ... 150+ branches
    };
    // 错误转换为负 errno
}
```

关键设计特点：
- 使用 `syscalls` crate（v0.8）提供的 `Sysno` 枚举，完整覆盖 Linux 系统调用号空间。
- 对不支持的架构差异，使用 `#[cfg(target_arch = "x86_64")]` 条件编译标记特定于 x86_64 的调用（如 `open`、`fork`、`mkdir` 等），在 RISC-V 上使用 `*at` 系列替代。
- 返回值为 `AxResult<isize>`，错误自动映射为 Linux 负 errno。

#### 3.1.2 文件系统调用 (`syscall/fs/`)

| 文件 | 功能 | 关键实现 |
|------|------|---------|
| `io.rs` | read/write/lseek/truncate | 通过 `get_file_like(fd)` 获取统一文件抽象，调用 `FileLike::read/write` |
| `ctl.rs` (525行) | ioctl/fcntl/chdir/mkdirat/linkat/getdents64 | 最复杂的 fs 调用文件，实现了完整的目录遍历、路径解析 |
| `fd_ops.rs` | openat/close/dup/fcntl/flock | 文件描述符表操作 |
| `stat.rs` | fstat/statx | Kstat 转换 |
| `mount.rs` | mount/umount | 挂载操作 |
| `pipe.rs` | pipe2 | 管道创建 |
| `event.rs` | eventfd2 | eventfd 创建 |
| `memfd.rs` | memfd_create | 匿名内存文件 |
| `signalfd.rs` | signalfd4 | 信号文件描述符 |
| `timerfd.rs` | timerfd_create/settime/gettime | 定时器文件描述符 |
| `pidfd.rs` | pidfd_open | PID 文件描述符 |

核心设计模式——所有 I/O 操作统一委托给 `FileLike` trait：

```rust
// syscall/fs/io.rs
pub fn sys_read(fd: i32, buf: *mut u8, len: usize) -> AxResult<isize> {
    Ok(get_file_like(fd)?.read(&mut VmBytesMut::new(buf, len))? as _)
}
```

#### 3.1.3 网络系统调用 (`syscall/net/`)

| 文件 | 功能 |
|------|------|
| `socket.rs` (194行) | socket/bind/connect/listen/accept/socketpair |
| `io.rs` (173行) | sendto/recvfrom/sendmsg/recvmsg（含 CMSG 处理） |
| `addr.rs` (268行) | 地址转换（用户态 sockaddr ↔ 内核 SocketAddrEx） |
| `opt.rs` (192行) | getsockopt/setsockopt |
| `name.rs` | getsockname/getpeername |
| `cmsg.rs` | 控制消息（SCM_RIGHTS 文件描述符传递） |

支持的协议族：
- `AF_INET` + `SOCK_STREAM` → TCP（通过 `axnet::TcpSocket`）
- `AF_INET` + `SOCK_DGRAM` → UDP（通过 `axnet::UdpSocket`）
- `AF_UNIX` + `SOCK_STREAM` → Unix Stream（进程间管道）
- `AF_UNIX` + `SOCK_DGRAM` → Unix Dgram
- `AF_VSOCK` (可选 feature) → Vsock

关键实现：CMSG 中的 `SCM_RIGHTS` 支持通过 Unix socket 传递文件描述符：

```rust
// syscall/net/io.rs - recvmsg 中的 SCM_RIGHTS 处理
CMsg::Rights { fds } => builder.push(SOL_SOCKET, SCM_RIGHTS, |data| {
    for (f, chunk) in fds.into_iter().zip(data.chunks_exact_mut(size_of::<i32>())) {
        let fd = add_file_like(f, false)?;
        chunk.copy_from_slice(&fd.to_ne_bytes());
    }
})
```

#### 3.1.4 进程/线程系统调用 (`syscall/task/`)

| 文件 | 功能 |
|------|------|
| `clone.rs` (323行) | clone 系统调用（核心），含完整的 CloneFlags bitflags |
| `clone3.rs` (94行) | clone3（新版 clone 接口） |
| `execve.rs` (90行) | execve（ELF 加载、CLOEXEC 关闭、信号重置） |
| `exit.rs` (13行) | exit/exit_group |
| `wait.rs` (114行) | wait4/waitpid（WNOHANG/WUNTRACED/进程组等待） |
| `schedule.rs` (258行) | nanosleep/sched_yield/sched_* 系列 |
| `thread.rs` (89行) | getpid/gettid/set_tid_address/arch_prctl |
| `ctl.rs` (123行) | prctl/prlimit64 |
| `job.rs` (41行) | setsid/getsid/setpgid/getpgid |

**clone 实现核心逻辑：**

```rust
// syscall/task/clone.rs - CloneArgs::do_clone()
pub fn do_clone(self, uctx: &UserContext) -> AxResult<isize> {
    // 1. 验证 flags 组合
    self.validate()?;
    // 2. 确定线程 vs 进程：CLONE_THREAD → 共享 ProcessData
    let new_proc_data = if flags.contains(CloneFlags::THREAD) {
        // 线程：共享页表根、ProcessData
        new_task.ctx_mut().set_page_table_root(
            old_proc_data.aspace.lock().page_table_root());
        old_proc_data.clone()
    } else {
        // 进程：fork Process、克隆地址空间（或共享若 CLONE_VM）
        let proc = old_proc_data.proc.fork(tid);
        let aspace = if flags.contains(CloneFlags::VM) {
            old_proc_data.aspace.clone()
        } else {
            let mut aspace = old_proc_data.aspace.lock();
            let aspace = aspace.try_clone()?;
            copy_from_kernel(&mut aspace.lock())?;
            aspace
        };
        // ...
    };
    // 3. 处理 CLONE_FILES/CLONE_FS/CLONE_SIGHAND 共享语义
    // 4. spawn 新任务
}
```

#### 3.1.5 内存管理系统调用 (`syscall/mm/`)

| 文件 | 功能 |
|------|------|
| `mmap.rs` (338行) | mmap：支持 ANONYMOUS/FILE/SHARED/PRIVATE/FIXED/POPULATE/HUGETLB |
| `brk.rs` (70行) | brk：堆扩展与收缩 |
| `mincore.rs` (119行) | mincore：页面驻留检测 |

mmap 的后端映射策略（在 syscall 层决定使用哪个 backend）：

```rust
// syscall/mm/mmap.rs - 根据 map_type 选择后端
let backend = match map_type {
    MmapFlags::SHARED | MmapFlags::SHARED_VALIDATE => {
        // 文件共享映射 → FileBackend
        // 设备映射 → DeviceMmap::{Physical, ReadOnly, Cache}
    }
    _ => {
        // MAP_PRIVATE 文件 → CowBackend
        // MAP_ANONYMOUS → 匿名分配
    }
};
```

#### 3.1.6 信号系统调用 (`syscall/signal.rs`, 317行)

完整实现了 Linux RT 信号 API：

| 系统调用 | 功能 |
|---------|------|
| `rt_sigprocmask` | 阻塞/解除阻塞信号 |
| `rt_sigaction` | 设置信号处理器 |
| `rt_sigpending` | 获取待处理信号 |
| `rt_sigreturn` | 从信号处理器返回 |
| `rt_sigtimedwait` | 同步等待信号（使用 async/await poll_fn） |
| `rt_sigsuspend` | 原子替换信号掩码并等待 |
| `kill/tkill/tgkill` | 向进程/线程发送信号 |
| `rt_sigqueueinfo/rt_tgsigqueueinfo` | 带附加数据发送信号 |
| `sigaltstack` | 设置备用信号栈 |

信号等待使用 Rust 异步原语实现：

```rust
// syscall/signal.rs - rt_sigtimedwait
let fut = poll_fn(|cx| {
    if let Some(sig) = signal.dequeue_signal(&set) {
        Poll::Ready(Some(sig))
    } else if check_signals(thr, uctx, Some(old_blocked)) {
        Poll::Ready(None)
    } else {
        let _ = curr.poll_interrupt(cx);
        Poll::Pending
    }
});
let sig = block_on(future::timeout(timeout, fut));
```

#### 3.1.7 futex 系统调用 (`syscall/sync/futex.rs`, 136行)

实现 `FUTEX_WAIT`/`FUTEX_WAIT_BITSET`/`FUTEX_WAKE`/`FUTEX_WAKE_BITSET`/`FUTEX_REQUEUE`/`FUTEX_CMP_REQUEUE`：

- 使用进程级 futex 表（`FutexTable`，按 FutexKey 索引）
- 支持 bitset wake（用于 `FUTEX_WAIT_BITSET`）
- 支持 requeue 操作（将等待者从一个 futex 迁移到另一个）
- 原子快速路径：`FUTEX_WAIT` 先做一次无锁检查 `uaddr.vm_read()? != value`
- 支持 owner_dead 状态（用于 robust futex 清理）

#### 3.1.8 IPC 系统调用 (`syscall/ipc/`)

**消息队列** (`msg.rs`, 884行)：
- `msgget`：创建/获取消息队列
- `msgsnd`：发送消息（含类型和正文）
- `msgrcv`：接收消息（按类型过滤、支持 MSG_NOERROR/MSG_EXCEPT）
- `msgctl`：控制操作（IPC_STAT/IPC_SET/IPC_RMID）

使用 `BiBTreeMap<i32, MsgQueue>` 管理全局消息队列，每个队列包含：
- 按类型索引的 BTreeMap
- 发送者和接收者等待队列
- IPC 权限结构

**共享内存** (`shm.rs`, 568行)：
- `shmget`：创建共享内存段
- `shmat`：附加到进程地址空间（使用 `Backend::Shared`）
- `shmdt`：分离
- `shmctl`：控制操作

共享内存使用 `SharedPages` 后端，在物理页层面实现真正共享：

```rust
// syscall/ipc/shm.rs - shmat
aspace.map(start, size, flags, true, Backend::new_shared(start, pages.clone()))?;
```

#### 3.1.9 时间系统调用 (`syscall/time.rs`, 255行)

- `clock_gettime`：支持 CLOCK_REALTIME/MONOTONIC/PROCESS_CPUTIME_ID 等
- `gettimeofday`/`times`
- `getitimer`/`setitimer`（ITIMER_REAL/VIRTUAL/PROF）
- `timer_create`/`timer_settime`/`timer_gettime`/`timer_delete`（POSIX per-process 定时器）
- 定时器通知支持 SIGEV_NONE/SIGEV_SIGNAL/SIGEV_THREAD_ID

#### 3.1.10 I/O 多路复用 (`syscall/io_mpx/`)

- **epoll** (`epoll.rs`, 138行)：`epoll_create1`/`epoll_ctl`/`epoll_pwait`/`epoll_pwait2`，支持 LT/ET/ONESHOT 三种触发模式
- **poll** (`poll.rs`, 113行)：`poll`/`ppoll`
- **select** (`select.rs`, 194行)：`select`/`pselect6`

#### 3.1.11 其他系统调用

- **sys.rs**：`uname`、`sysinfo`、`syslog`、`getrandom`、`seccomp`（stub）、`getuid/setuid/getgid/setgid` 系列
- **resources.rs**：`getrlimit`/`setrlimit`/`prlimit64`
- **membarrier.rs**：`membarrier`（stub 实现）

---

### 3.2 任务管理子系统 (`task/`)

#### 3.2.1 核心数据结构

**`Thread`** — 每个线程的扩展数据：

```rust
// task/mod.rs
pub struct Thread {
    pub proc_data: Arc<ProcessData>,    // 共享的进程数据
    clear_child_tid: AtomicUsize,       // set_tid_address 支持
    robust_list_head: AtomicUsize,      // robust futex 链表头
    pub signal: Arc<ThreadSignalManager>, // 线程级信号管理器
    pub time: AssumeSync<RefCell<TimeManager>>, // 定时器（ITIMER）
    oom_score_adj: AtomicI32,           // OOM 分数调整
    sched_policy/priority: AtomicI32,   // 调度器参数
    pub exit: Arc<AtomicBool>,          // 退出标记
    accessing_user_memory: AtomicBool,  // 用户态内存访问保护
    pub exit_event: Arc<PollSet>,       // 退出事件（用于 wait）
}
```

**`ProcessData`** — 进程级共享数据：

```rust
pub struct ProcessData {
    pub proc: Arc<Process>,             // starry-process 库的 Process 对象
    pub exe_path: RwLock<String>,       // 可执行文件路径
    pub cmdline: RwLock<Arc<Vec<String>>>, // 命令行参数
    pub aspace: Arc<Mutex<AddrSpace>>,  // 虚拟地址空间（共享）
    pub scope: RwLock<Scope>,           // 资源作用域（用于 FD_TABLE）
    heap_top: AtomicUsize,              // 堆顶（brk）
    pub rlim: RwLock<Rlimits>,          // 资源限制
    pub child_exit_event: Arc<PollSet>, // 子进程退出通知
    pub exit_signal: Option<Signo>,     // 退出时发送的信号
    pub signal: Arc<ProcessSignalManager>, // 进程级信号管理器
    futex_table: Arc<FutexTable>,       // futex 等待表
    pub posix_timers: PosixTimerTable,  // POSIX 定时器表
    umask: AtomicU32,                   // 文件模式创建掩码
}
```

#### 3.2.2 任务表管理

使用 4 个全局 `WeakMap` 维护引用（`task/ops.rs`）：

```rust
static TASK_TABLE: RwLock<WeakMap<Pid, WeakAxTaskRef>>;    // tid → task
static PROCESS_TABLE: RwLock<WeakMap<Pid, Weak<ProcessData>>>; // pid → ProcessData
static PROCESS_GROUP_TABLE: RwLock<WeakMap<Pid, Weak<ProcessGroup>>>;
static SESSION_TABLE: RwLock<WeakMap<Pid, Weak<Session>>>;
```

所有引用均为弱引用，允许进程/任务在无外部引用时自动释放。

#### 3.2.3 退出流程 (`do_exit`)

```rust
// task/ops.rs
pub fn do_exit(exit_code: i32, group_exit: bool) {
    // 1. clear_child_tid futex wake
    // 2. 处理 robust futex 链表（exit_robust_list）
    // 3. 从 Process 中移除线程，若为最后一个线程则标记 zombie
    // 4. POSIX 定时器清理
    // 5. 若 group_exit，唤醒父进程的等待
    // 6. 通知子进程退出事件
    // 7. 设置 exit 标志
}
```

#### 3.2.4 信号处理 (`task/signal.rs`)

```rust
pub fn check_signals(thr: &Thread, uctx: &mut UserContext, restore_blocked: Option<SignalSet>) -> bool {
    let Some((sig, os_action)) = thr.signal.check_signals(uctx, restore_blocked) else {
        return false;
    };
    match os_action {
        SignalOSAction::Terminate => do_exit(signo as i32, true),
        SignalOSAction::CoreDump => do_exit(128 + signo as i32, true),
        SignalOSAction::Stop => do_exit(1, true),
        SignalOSAction::Continue => { /* TODO */ },
        SignalOSAction::Handler => { /* 已由 signal manager 设置 uctx */ },
    }
}
```

信号发送链路：`send_signal_to_process` → `ProcessSignalManager::send_signal` → 选择目标线程 → `ThreadSignalManager::send_signal` → `task.interrupt()`

#### 3.2.5 futex 表 (`task/futex.rs`)

每个 `ProcessData` 拥有独立的 `FutexTable`（实际上是全局的，但按 FutexKey 中的地址空间区分进程）。表结构：

```rust
pub struct FutexKey { addr: usize, aspace_id: u64 }
pub struct FutexTable {
    table: HashMap<FutexKey, Arc<Futex>>,  // key → futex
}
pub struct Futex {
    pub wq: WaitQueue,                   // 等待队列
    pub owner_dead: AtomicBool,          // robust futex 标记
}
```

---

### 3.3 内存管理子系统 (`mm/`)

#### 3.3.1 地址空间抽象 (`AddrSpace`)

```rust
pub struct AddrSpace {
    va_range: VirtAddrRange,          // 地址空间范围
    areas: MemorySet<Backend>,        // 内存区域集合
    pt: PageTable,                    // 页表
}
```

核心操作：
- `new_empty(base, size)` — 创建空地址空间
- `map(start, size, flags, populate, backend)` — 添加映射区域
- `unmap(start, size)` — 移除映射
- `populate_area(start, size, access_flags)` — 按需分配物理页面
- `find_free_area(hint, size, limit, align)` — 寻找空闲地址
- `try_clone()` — 克隆地址空间（fork 时用）
- `handle_page_fault(vaddr, access_flags)` — 缺页处理

#### 3.3.2 四种映射后端 (`Backend`)

使用 `enum_dispatch` 实现多态后端：

```rust
#[enum_dispatch(BackendOps)]
pub enum Backend {
    Linear(LinearBackend),    // 线性映射（信号蹦床、设备 MMIO）
    Cow(CowBackend),          // 写时复制（MAP_PRIVATE、ELF 段）
    Shared(SharedBackend),    // 共享物理页（共享内存、MAP_SHARED）
    File(FileBackend),        // 文件映射（mmap 文件）
}
```

**`CowBackend`（最复杂的后端）**：
- 使用全局 `FRAME_TABLE`（BTreeMap）维护每个物理帧的引用计数
- `handle_cow_fault`：当引用计数为 1 时升级权限；>1 时分配新帧并复制
- 支持从文件后端初始化页面内容（ELF 加载）
- `clone_map` 在 fork 时将所有可写页面降级为只读，共享物理帧

```rust
// mm/aspace/backend/cow.rs
fn handle_cow_fault(&self, vaddr, paddr, flags, pt) -> AxResult {
    let mut frame_table = FRAME_TABLE.lock();
    let frame = frame_table.get_frame_ref(paddr)?;
    drop(frame_table);
    let mut frame = frame.lock();
    match frame.0 {
        1 => {
            pt.protect(vaddr, flags)?;  // 单引用：直接升级
        }
        _ => {
            let new_frame = self.alloc_new_frame(false)?;
            // 复制内容
            core::ptr::copy_nonoverlapping(...);
            pt.remap(vaddr, new_frame, flags)?;
            frame.drop_frame(paddr, self.size);  // 减引用
        }
    }
}
```

**`FileBackend`**：
- 使用 `CachedFile`（带页面缓存）实现文件支持的映射
- 注册 evict 监听器：当页面缓存驱逐某页时，自动 unmap 对应的虚拟地址
- 支持 `populate` 按需从文件读取页面

**`SharedBackend`**：
- 直接映射预分配的物理页面数组（`SharedPages`）
- 用于 System V 共享内存
- 多个地址空间可共享同一组物理页面

#### 3.3.3 ELF 加载器 (`mm/loader.rs`, 451行)

关键设计：
- 使用 `ElfCacheEntry`（基于 `ouroboros` 的自引用结构）缓存已解析的 ELF 头
- LRU 缓存（`LRUCache<ElfCacheEntry, 32>`）最多缓存 32 个 ELF 文件
- 支持动态链接：解析 PT_INTERP，加载 `ld-musl-*.so.1` 或 `ld-linux-*.so.2`
- 自动尝试路径回退：`/lib/` → `/musl/lib/`
- 构建 AUX 向量（`AT_PHDR`、`AT_ENTRY`、`AT_BASE`、`AT_PAGESZ` 等）
- 映射信号蹦床（`map_trampoline`）到 `0x6000_1000`
- 设置用户栈（包含 argc/argv/envp/auxv）

#### 3.3.4 用户态内存访问 (`mm/access.rs`, 413行)

实现了安全的用户态内存访问框架：

```rust
pub struct UserPtr<T>(*mut T);        // 可读写
pub struct UserConstPtr<T>(*const T);  // 只读
```

关键安全机制——**页面故障保护**：
```rust
pub fn access_user_memory<R>(f: impl FnOnce() -> R) -> R {
    thr.set_accessing_user_memory(true);
    let result = f();
    thr.set_accessing_user_memory(false);
    result
}
```

注册了页面故障处理器：
```rust
#[register_trap_handler(PAGE_FAULT)]
fn handle_page_fault(vaddr, access_flags) -> bool {
    // 仅在 access_user_memory() 范围内处理
    if !thr.is_accessing_user_memory() { return false; }
    aspace.lock().handle_page_fault(vaddr, access_flags)
}
```

这允许内核安全地访问用户态内存：在 `access_user_memory` 块内发生的页面故障被捕获并通过 populate 处理，而不会导致内核 panic。

#### 3.3.5 I/O 向量操作 (`mm/io.rs`, 168行)

实现了 `readv`/`writev` 的 I/O 向量缓冲操作：
- `IoVectorBuf`：将用户态 `iovec` 数组包装为可迭代的缓冲区
- `VmBytes`/`VmBytesMut`：单个用户态缓冲区的读/写适配器
- 与 `axio::Read`/`axio::Write` trait 兼容

---

### 3.4 文件抽象层 (`file/`)

#### 3.4.1 `FileLike` trait — 统一文件接口

```rust
pub trait FileLike: Pollable + DowncastSync {
    fn read(&self, _dst: &mut IoDst) -> AxResult<usize> { Err(AxError::InvalidInput) }
    fn write(&self, _src: &mut IoSrc) -> AxResult<usize> { Err(AxError::InvalidInput) }
    fn stat(&self) -> AxResult<Kstat> { Ok(Kstat::default()) }
    fn path(&self) -> Cow<'_, str>;
    fn ioctl(&self, _cmd: u32, _arg: usize) -> AxResult<usize> { Err(AxError::NotATty) }
    fn nonblocking(&self) -> bool { false }
    fn set_nonblocking(&self, _nonblocking: bool) -> AxResult { Ok(()) }
    fn from_fd(fd: c_int) -> AxResult<Arc<Self>>;  // 从 fd 获取
    fn add_to_fd_table(self, cloexec: bool) -> AxResult<c_int>;  // 添加到 fd 表
}
```

所有文件类型均实现此 trait。

#### 3.4.2 文件描述符表

```rust
scope_local! {
    pub static FD_TABLE: Arc<RwLock<FlattenObjects<FileDescriptor, AX_FILE_LIMIT>>>;
}

pub struct FileDescriptor {
    pub inner: Arc<dyn FileLike>,
    pub cloexec: bool,
}
```

使用 `scope_local` crate 实现线程作用域内的 fd 表：
- `CLONE_FILES` 未设置时，fork 创建新的 fd 表（深层复制）
- `CLONE_FILES` 设置时，共享同一个 `Arc<RwLock<...>>`
- 使用 `FlattenObjects` 实现紧凑的 fd 编号（重用已关闭的 fd 编号）

#### 3.4.3 具体文件类型

| 类型 | 实现文件 | 关键特性 |
|------|---------|---------|
| `File` | `file/fs.rs` | 磁盘文件，支持阻塞/非阻塞 I/O，委托给 `axfs::File` |
| `Directory` | `file/fs.rs` | 目录，仅支持 `getdents64` |
| `Socket` | `file/net.rs` | 网络 socket，委托给 `axnet::Socket` |
| `Pipe` | `file/pipe.rs` | 管道，基于 `ringbuf::HeapRb`（64KB 默认容量），支持 SIGPIPE |
| `Epoll` | `file/epoll.rs` | epoll 实例，支持 LT/ET/ONESHOT |
| `EventFd` | `file/event.rs` | eventfd，原子计数器 + semaphore 模式 |
| `Signalfd` | `file/signalfd.rs` | signalfd，128 字节 siginfo 结构 |
| `TimerFd` | `file/timerfd.rs` | timerfd，支持实时/单调时钟，间隔/绝对时间 |
| `PidFd` | `file/pidfd.rs` | pidfd，进程文件描述符 |

#### 3.4.4 epoll 实现细节

```rust
// file/epoll.rs
struct EpollInterest {
    key: EntryKey,                    // (fd, Weak<FileLike>)
    event: EpollEvent,
    mode: SpinNoPreempt<TriggerMode>, // Level/Edge/OneShot
    in_ready_queue: AtomicBool,
}
```

epoll 的核心机制：
- `Epoll::add(fd, event, flags)` — 向目标 `FileLike` 注册 waker
- `Epoll::poll_events(events)` — 遍历就绪列表，根据触发模式决定是否保持/移除
- `TriggerMode::should_notify()` — LT 始终通知，ET 首次通知（但不清除），ONESHOT 仅通知一次

#### 3.4.5 Pipe 实现细节

```rust
struct Shared {
    buffer: Mutex<HeapRb<u8>>,  // ringbuf，默认 64KB
    poll_rx: PollSet,           // 读端等待者
    poll_tx: PollSet,           // 写端等待者
    poll_close: PollSet,        // 关闭通知
}
```

- `read`：循环读取直到有数据或 EOF
- `write`：循环写入（`block_on(poll_io(...))`）
- 写端关闭时读取返回 0（EOF）；读端关闭时写入触发 SIGPIPE
- 支持 `FIONREAD` ioctl

---

### 3.5 伪文件系统 (`pseudofs/`)

#### 3.5.1 挂载结构

```rust
pub fn mount_all() -> LinuxResult<()> {
    mount_at(&fs, "/dev", dev::new_devfs())?;
    mount_at(&fs, "/dev/shm", tmp::MemoryFs::new())?;
    mount_at(&fs, "/tmp", tmp::MemoryFs::new())?;
    mount_at(&fs, "/var", tmp::MemoryFs::new())?;
    mount_at(&fs, "/var/tmp", tmp::MemoryFs::new())?;
    mount_at(&fs, "/proc", proc::new_procfs())?;
    mount_at(&fs, "/sys", tmp::MemoryFs::new())?;
    // 创建 /sys/class/graphics/fb0/device/subsystem 符号链接
}
```

#### 3.5.2 devfs 设备

| 设备 | 类型 | 实现 |
|------|------|------|
| `/dev/null` | 字符设备 1:3 | 读返回 0，写丢弃 |
| `/dev/zero` | 字符设备 1:5 | 读返回零填充 |
| `/dev/full` | 字符设备 1:7 | 读返回零，写返回 ENOSPC |
| `/dev/random` | 字符设备 1:8 | 读返回伪随机数（`SmallRng`） |
| `/dev/urandom` | 字符设备 1:9 | 同上 |
| `/dev/rtc0` | 字符设备 | RTC 时间读写 |
| `/dev/fb0` | 字符设备 29:0 | 帧缓冲（条件编译） |
| `/dev/tty` | 字符设备 5:0 | 当前控制终端 |
| `/dev/console` | 字符设备 5:1 | 系统控制台 |
| `/dev/ptmx` | 字符设备 5:2 | PTY 主设备 |
| `/dev/loop*` | 块设备 | loop 设备 |

#### 3.5.3 TTY 子系统

TTY 子系统是 pseudofs 中最复杂的部分（~1500 行），实现了：

```
/dev/tty    → CurrentTty (引用控制终端)
/dev/console → N_TTY (内核控制台)
/dev/ptmx   → Ptmx (PTY 主设备创建器)
/dev/pts/*  → PtsDir (从设备)
```

核心架构：
- `Terminal`：终端核心，包含作业控制、窗口大小、termios 设置
- `LineDiscipline<R, W>`：线路规程，实现规范模式/原始模式、回声、信号生成
- `Tty<R, W>`：通用 TTY 设备（用于 PTY 和 N_TTY）
- `NTtyDriver`：控制台驱动（通过 `axhal` 的串口/显示输入输出）

termios 支持的 ioctl：`TCGETS`/`TCSETS`/`TCSETSF`/`TCSETSW`/`TCGETS2`/`TCSETS2`（使用 `Termios2` 结构）

作业控制 ioctl：`TIOCGPGRP`/`TIOCSPGRP`/`TIOCGWINSZ`/`TIOCSWINSZ`/`TIOCSPTLCK`/`TIOCGPTN`/`TIOCSCTTY`/`TIOCNOTTY`

线路规程特性：
- 规范模式：行缓冲、`VERASE`（退格擦除）、`VKILL`（行杀死）、`VEOF`
- 非规范模式：`VMIN`/`VTIME` 控制
- 信号生成：`VINTR`（SIGINT）、`VQUIT`（SIGQUIT）、`VSUSP`（SIGTSTP）
- 回声控制：`ECHO`/`ECHOCTL`/`ECHOK`
- 输入处理：`ICRNL`（CR→NL）、`IGNCR`

#### 3.5.4 procfs

实现 `/proc` 下的动态目录结构：

| 路径 | 内容 |
|------|------|
| `/proc/meminfo` | 静态 meminfo 字符串（dummy数据） |
| `/proc/stat` | 静态 stat 字符串 |
| `/proc/[pid]/status` | 进程状态（Tgid/Pid/Uid/Gid） |
| `/proc/[pid]/stat` | 进程统计 |
| `/proc/[pid]/fd/` | 文件描述符目录（每个 fd 为符号链接） |
| `/proc/[pid]/exe` | 可执行文件符号链接 |
| `/proc/[pid]/task/[tid]/` | 线程子目录 |

procfs 通过 `Weak<Process>` 引用进程，当进程结束时条目自动变为空。

#### 3.5.5 tmpfs (`MemoryFs`)

完整的内存文件系统实现：
- 基于 `Slab` inode 分配器
- 支持文件、目录、符号链接
- 文件内容委托给页面缓存（不需要手动管理）
- 支持 nlink 追踪和自动 inode 回收
- 支持 `read_at`/`write_at`/`set_len`/`read_dir`

#### 3.5.6 伪文件系统框架

`SimpleFs` 是一个通用的伪文件系统框架：
- `DirMaker`：回调创建目录节点
- `DirMapping`：静态目录条目映射
- `NodeOpsMux`：Dir 或 File 的统一枚举
- `SimpleFsNode`：通用 inode 管理

---

### 3.6 架构配置 (`config/`)

| 常量 | RISC-V 64 | 说明 |
|------|-----------|------|
| `KERNEL_STACK_SIZE` | 256KB | 内核栈大小 |
| `USER_SPACE_BASE` | 0x1000 | 用户空间起始地址 |
| `USER_SPACE_SIZE` | ~256GB | 用户空间大小 |
| `USER_STACK_TOP` | 0x4_0000_0000 | 用户栈顶 |
| `USER_STACK_SIZE` | 512KB | 用户栈大小 |
| `USER_HEAP_BASE` | 0x4000_0000 | 堆起始 |
| `USER_HEAP_SIZE` | 64KB | 初始堆大小 |
| `USER_HEAP_SIZE_MAX` | 512MB | 堆最大扩展 |
| `SIGNAL_TRAMPOLINE` | 0x6000_1000 | 信号蹦床地址 |

四种架构（RISCV64/LA64/AArch64/x86_64）各有独立的配置文件，包含相同的常量集合。

---

### 3.7 内核入口 (`entry.rs`)

启动流程：

1. `pseudofs::mount_all()` — 挂载所有伪文件系统
2. `spawn_alarm_task()` — 启动定时器任务
3. `resolve_init_args()` — 解析 init 二进制路径
   - 自动查找 busybox（多个路径尝试：`/musl/busybox`、`/glibc/busybox` 等）
   - 如果用户请求 `/bin/sh`，自动转换为 `busybox sh`
4. 创建空用户地址空间
5. `load_user_app()` — 加载 ELF 并设置用户栈
6. 创建 init 进程/线程
7. 绑定 `N_TTY` 到 init 进程
8. 添加 stdio（fd 0/1/2 指向 `/dev/console`）
9. `spawn_task` + `join` — 启动调度并等待

---

### 3.8 starry-process 库 (`deps/starry-process/`)

独立的进程抽象库（460行）：

```rust
pub struct Process {
    pid: Pid,
    is_zombie: AtomicBool,
    tg: SpinNoIrq<ThreadGroup>,         // 线程组
    children: SpinNoIrq<StrongMap<Pid, Arc<Process>>>,
    parent: SpinNoIrq<Weak<Process>>,
    group: SpinNoIrq<Arc<ProcessGroup>>,
}
```

关键功能：
- **进程树管理**：parent/children 关系维护
- **孤儿进程收养**：父进程退出时，子进程自动收养到 init 进程
- **Zombie 处理**：`exit()` 标记 zombie，`free()` 清理资源
- **会话/进程组**：`create_session()`、`create_group()`、`move_to_group()`
- **fork 支持**：`Process::fork()` 创建子进程对象

---

## 四、子系统间交互机制

### 4.1 系统调用 → 文件抽象 → 设备/文件系统

```
user syscall → syscall/mod.rs dispatch
    → syscall/fs/io.rs: sys_read(fd, ...)
    → file/mod.rs: get_file_like(fd)?
    → FileLike::read(&mut dst)
    → (匹配具体实现)
        file/fs.rs:  File::read → axfs::File::read
        file/net.rs: Socket::read → axnet::Socket::recv
        file/pipe.rs: Pipe::read → ringbuf 读取
        file/event.rs: EventFd::read → 原子计数器递减
        pseudofs/dev/*: DeviceOps::read_at
```

### 4.2 进程创建 → 内存管理

```
clone/fork syscall
    → CloneArgs::do_clone()
    → Process::fork()            (进程抽象)
    → AddrSpace::try_clone()     (地址空间克隆)
    → CowBackend::clone_map()    (COW页面降级)
    → Backend::map()             (新页表映射)
    → spawn_task()               (任务调度)
```

### 4.3 信号 → 任务中断

```
kill/tkill syscall
    → send_signal_to_process() / send_signal_to_thread()
    → ProcessSignalManager::send_signal()
        → 选择目标线程
        → ThreadSignalManager::send_signal()
            → task.interrupt()        (中断当前阻塞)
            → 下次 check_signals()    (在返回用户态时检查)
```

### 4.4 缺页处理链

```
硬件缺页异常
    → axhal trap handler
    → handle_page_fault(vaddr, flags)
    → 检查：是否在 access_user_memory() 内？
        → 是：AddrSpace::handle_page_fault()
            → BackendOps::populate()
            → CowBackend::handle_cow_fault() 或 分配新页
        → 否：传递到用户态信号处理（SIGSEGV）
```

---

## 五、实现完整度评估

### 5.1 各子系统完整度

以 Linux 内核的对应子系统为参照基准（完整度 = 已实现核心功能 / 该子系统典型必需功能）：

| 子系统 | 完整度 | 已实现 | 缺失项 |
|--------|--------|--------|--------|
| 系统调用层 | 70% | 150+ syscall，覆盖 fs/net/mm/task/signal/ipc/sync/time | cgroup、capabilities、seccomp 实际过滤、ptrace、大量 x86_64 专有调用 |
| 任务管理 | 65% | 进程/线程/进程组/会话、fork/clone/execve/wait/exit | 多线程下的 execve 支持、cgroup、namespace（只有 stub）、CPU 亲和性实际应用 |
| 内存管理 | 60% | mmap/munmap/brk/COW/文件映射/共享内存/缺页处理 | mprotect/mremap/madvise/msync 不完整、无 swap、无 KSM、大页支持不完整 |
| 文件系统 | 55% | 文件/目录/管道/epoll/eventfd/signalfd/timerfd | 无 inotify、无 fanotify、无文件锁（仅 flock stub）、无 aio |
| 伪文件系统 | 50% | devfs/procfs/tmpfs/devpts | procfs 数据不完整（静态假数据）、sysfs 基本为空 |
| 网络 | 50% | TCP/UDP/Unix Socket/VSock、基本 socket 选项 | 无 raw socket、无 packet socket、无 netlink、无 IPv6 完整支持 |
| 信号 | 80% | 完整 RT 信号 API、信号处理器、信号队列 | sigaltstack 实际使用、core dump、job control stop/continue |
| IPC | 70% | 消息队列、共享内存（含 attach/detach） | 信号量、IPC 命名空间 |
| 同步 | 60% | futex（WAIT/WAKE/REQUEUE/CMP_REQUEUE）、robust list | PI futex、futex WAIT_MULTIPLE |
| TTY | 65% | PTY 主从、termios、作业控制 ioctl、线路规程 | 完整的线路规程信号处理、modem 控制 |

### 5.2 整体内核完整度

综合评估：约 **60%**（相对于最小可行 Linux 兼容内核）。

关键已实现能力：
- 可运行 musl/glibc 链接的 busybox
- 支持交互式 shell（通过 PTY）
- 支持网络应用（TCP/UDP/Unix Socket）
- 支持动态链接的 ELF 程序

关键缺失：
- 无 SMP 支持的实际进程调度（仅有 stub）
- 无用户态中断（仅 kernel 内使用）
- 无设备驱动模型（依赖 ArceOS 的驱动）
- procfs/sysfs 数据多为虚假数据
- 无 cgroup/namespace 实际隔离

---

## 六、设计创新性分析

### 6.1 创新点

1. **Unikernel 基础上的宏内核构建**
   
   StarryOS 的独特之处在于将 ArceOS（一个模块化 unikernel）改造为支持多进程的宏内核。这不同于传统的"从零构建内核"或"在微内核上构建 Linux 兼容层"。ArceOS 的组件化设计使 StarryOS 可以逐层替换 unikernel 假设为进程化假设。

2. **`scope_local` 文件描述符表**
   
   使用 `scope_local` crate 实现线程作用域的 fd 表是一个精巧设计。相比传统内核用 `current->files` 指针，Rust 的作用域局部变量在 `CLONE_FILES` 未设置时自动创建独立拷贝。

3. **`access_user_memory` 缺页保护机制**
   
   传统 Unix 内核使用 `copy_from_user`/`copy_to_user` 配合 `exception_table` 处理用户态内存访问。StarryOS 使用 Rust 闭包 + 线程局部标志位实现了一种更安全的替代方案：在 `access_user_memory` 块内发生的缺页被内核透明处理并重试访问。

4. **`enum_dispatch` 多态后端**
   
   使用 Rust 的 `enum_dispatch` 而非虚函数表（dyn trait）实现映射后端的多态，避免了间接调用开销，在性能和灵活性之间取得平衡。

5. **LRU 缓存 ELF 解析**
   
   `ElfCacheEntry` 使用 `ouroboros` 自引用结构 + `LRUCache<32>` 缓存已解析的 ELF 文件，避免重复解析频繁使用的共享库。

6. **基于 `ringbuf` 的 Pipe 实现**
   
   使用成熟的 `ringbuf` crate（而非手写环形缓冲区）实现管道，支持动态扩容（`resize`），并正确处理 SIGPIPE 信号。

### 6.2 设计局限

1. **对 ArceOS 的深度依赖**：StarryOS 无法脱离 ArceOS 生态独立运行。所有硬件抽象、驱动、内存分配器、文件系统均来自 ArceOS。

2. **非真正的抢占式多任务**：调度依赖 ArceOS 的协作式 `axtask`，缺少真正的抢占式调度和完全的时间片轮转。

3. **单一内核锁粒度**：许多全局资源（如 `FRAME_TABLE`、`TASK_TABLE`）使用粗粒度锁，SMP 扩展性受限。

4. **procfs/sysfs 数据真实性不足**：`/proc/meminfo` 的内容是完全硬编码的静态字符串，不反映实际内存使用情况。

---

## 七、项目总结

StarryOS 是一个在 ArceOS unikernel 生态之上构建的实验性 Linux 兼容内核，全部使用 Rust 语言编写。它的核心价值在于：

- **证明了 unikernel 组件可以重构为宏内核**，将原本运行单个应用的组件化 OS 改造为支持多进程隔离和 Linux ABI 的完整内核。
- **实现了 Linux 兼容性的关键路径**：150+ 系统调用、完整的进程模型（fork/clone/execve/wait）、虚拟内存管理（COW、mmap）、网络栈、信号、TTY、epoll 等。
- **展示了 Rust 在内核开发中的优势**：类型安全的文件抽象（`FileLike` trait + `DowncastSync`）、安全的用户态内存访问（`access_user_memory` + 缺页捕获）、零成本抽象的枚举分发后端。

从成熟度来看，该项目处于**功能原型阶段**。核心功能路径已经打通（可以运行交互式 busybox shell），但在边缘情况处理（多线程 execve、完整的 job control、资源限制的实际执行）、生产级特性（SMP 优化、细粒度锁、完整统计信息）方面仍有大量工作要做。

代码总量约 19,000 行（含 starry-process 库），由多名贡献者协作开发（KylinSoft、Azure-stars、Yuekai Jia、朝倉水希、Mivik），采用 Apache-2.0 许可证，活跃开发中。