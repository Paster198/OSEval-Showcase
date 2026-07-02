# StarryOS 内核项目深度技术分析报告

## 一、分析方法概述

本报告基于以下分析方法生成：

1. **源代码静态分析**：通读所有核心源文件（约27264行不含ArceOS框架代码），包括 `core/`、`api/`、`src/`、`deps/`、`vdso*/` 等目录。
2. **依赖与配置分析**：检查 `Cargo.toml`、`Makefile`、`rust-toolchain.toml` 等构建配置文件。
3. **架构配置分析**：对比四个目标架构（RISC-V、x86_64、AArch64、LoongArch）的地址空间布局差异。
4. **系统调用覆盖分析**：统计 `syscall/mod.rs` 中支持的系统调用种类和数量。
5. **未进行构建与运行测试**：当前环境中缺少必要的预构建二进制（`vdso_vsched2_output/libvsched2.so` 及其相关的 VDSO 产物需要专门的链接器 `riscv64-linux-musl-ld` 并在特定的构建流程中生成），完整构建需要预先存在的 VDSO 共享库。此外，运行测试需要下载外部 rootfs 镜像。

---

## 二、项目整体架构

### 2.1 项目定位

StarryOS 是一个基于 ArceOS 框架构建的 **Rust 宏内核（monolithic kernel）**，目标是提供一个通用的、多架构的、具备完整用户态支持的操作系统内核。项目在 Apache 2.0 许可下开源。

### 2.2 模块层次结构

```
┌─────────────────────────────────────────────┐
│                src/ (入口)                    │
│         main.rs / entry.rs                   │
├─────────────────────────────────────────────┤
│           starry-api (api/)                   │
│    系统调用分发 / 文件抽象 / 信号 / 终端      │
├─────────────────────────────────────────────┤
│          starry-core (core/)                  │
│   进程管理 / 内存管理 / VFS / Futex / 调度    │
├─────────────────────────────────────────────┤
│              ArceOS (arceos/)                 │
│  HAL / 内存管理 / 文件系统 / 网络栈 / 驱动    │
├─────────────────────────────────────────────┤
│          自定义依赖 (deps/)                   │
│    VDSO构建 / ELF解析 / 调度HAL / IPC        │
├─────────────────────────────────────────────┤
│          VDSO 体系 (vdso*/)                   │
│     用户态共享库调度 / 虚拟队列IPC            │
└─────────────────────────────────────────────┘
```

### 2.3 代码量统计

| 组件 | Rust 代码行数（不含ArceOS） |
|------|---------------------------|
| `core/` | ~5,200 |
| `api/` | ~8,600 |
| `src/` | ~210 |
| `deps/` | ~3,100 |
| `vdso*/` | ~1,000 |
| `tests/` | ~30 |
| 预构建 VDSO (`vdso_*_output/`) | ~1,800 |
| **合计** | **~27,264** |

ArceOS 框架（`arceos/`）自身约 28,945 行。总项目规模约 **56,000 行 Rust 代码**。

---

## 三、子系统详细拆解

### 3.1 内核入口与初始化 (`src/`)

#### 3.1.1 `main.rs` — 内核主函数

内核入口 `main()` 执行以下流程：

1. 调用 `starry_api::init()` 初始化 VFS 挂载、中断计数器、alarm 任务
2. 调用 `vdso::vdso_init()` 初始化 VDSO 子系统
3. 解析命令行参数，默认启动 `/bin/sh -c <init.sh>`（init.sh 内嵌为字符串常量）
4. 根据 `USE_VSCHED2` 常量选择调度模式：
   - `false`（默认）：使用传统 ArceOS 调度，调用 `entry::run_initproc()`
   - `true`：使用 vSched2 用户态调度器，调用 `create_vsched_init_task()` + `vsched2_bootstrap()`
5. 通过 SBI SRST 扩展执行关机

关键代码：
```rust
pub const CMDLINE: &[&str] = &["/bin/sh", "-c", include_str!("init.sh")];
const USE_VSCHED2: bool = false;
```

#### 3.1.2 `entry.rs` — 传统 init 进程启动

`run_initproc()` 部署传统 init 进程：

1. 创建空用户地址空间 → 从内核复制映射（仅 RISC-V/x86_64）
2. 通过 FS_CONTEXT 解析可执行文件路径
3. 加载 ELF 用户程序 → 获得入口地址和用户栈顶
4. 创建 `UserContext` → 创建用户任务 `new_user_task()`
5. 关联 `ProcessData`、`Thread`、文件描述符表
6. 调用 `spawn_task()` 将任务加入调度队列
7. 等待任务结束（`task.join()`）

---

### 3.2 进程管理子系统 (`core/src/task.rs`)

#### 3.2.1 核心数据结构

**`ProcessData`** — 进程级共享数据：
```rust
pub struct ProcessData {
    pub proc: Arc<Process>,              // starry-process crate 的进程对象
    pub exe_path: RwLock<String>,        // 可执行文件路径
    pub cmdline: RwLock<Arc<Vec<String>>>, // 命令行参数
    pub aspace: Arc<Mutex<AddrSpace>>,   // 虚拟地址空间
    pub scope: RwLock<Scope>,            // 资源作用域（FD表、FS上下文）
    heap_top: AtomicUsize,               // 用户堆顶
    pub rlim: RwLock<Rlimits>,           // 资源限制
    pub child_exit_event: Arc<PollSet>,  // 子进程退出事件
    pub exit_event: Arc<PollSet>,        // 自身退出事件
    pub exit_signal: Option<Signo>,      // 退出信号
    pub signal: Arc<ProcessSignalManager>, // 信号管理器
    futex_table: Arc<FutexTable>,        // Futex 表
    umask: AtomicU32,                    // 文件权限掩码
}
```

**`Thread`** — 线程级数据：
```rust
pub struct Thread {
    pub proc_data: Arc<ProcessData>,     // 共享的进程数据
    clear_child_tid: AtomicUsize,        // CLONE_CHILD_CLEARTID
    robust_list_head: AtomicUsize,       // robust futex 链表头
    pub signal: Arc<ThreadSignalManager>, // 线程级信号管理
    pub time: AssumeSync<RefCell<TimeManager>>, // 时间统计
    oom_score_adj: AtomicI32,            // OOM 分数调整
    exit: AtomicBool,                    // 退出标志
    accessing_user_memory: AtomicBool,   // 用户内存访问标志
}
```

#### 3.2.2 任务表管理

使用 `hashbrown::HashMap` + `lazy_static` 维护全局 PID→AxTaskRef 映射：
```rust
lazy_static! {
    static ref TASK_TABLE: SpinNoIrq<HashMap<Pid, AxTaskRef>> = ...;
}
static PROCESS_TABLE: ... = WeakMap<...>; // Weak 引用避免循环
```

#### 3.2.3 信号发送机制

支持进程级信号发送（`send_signal_to_process`）、进程组级（`send_signal_to_process_group`）、线程级（`send_signal_to_thread`）。

#### 3.2.4 TaskExt 集成

通过 `#[extern_trait]` 宏实现 `TaskExt` trait：
- `on_enter()`：设置 ActiveScope 为当前进程的资源作用域
- `on_leave()`：恢复到全局作用域

#### 3.2.5 实现完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| 进程创建 (fork/clone) | 完整 | 支持 CLONE_VM/FILES/FS/SIGHAND/THREAD 等标志 |
| 线程支持 | 基本 | 支持多线程进程，但 execve 限制单线程 |
| PID 管理 | 完整 | 基于 starry-process crate |
| 进程组/会话 | 完整 | 支持 job control |
| 退出处理 | 完整 | 支持 exit/exit_group，robust_list，clear_child_tid |
| 等待子进程 | 完整 | 支持 waitpid 多种模式 |
| 资源限制 | 基本 | 支持 RLIMIT_NOFILE/STACK |
| Cgroup/Namespace | 未实现 | CloneFlags 仅定义了位掩码，实际逻辑未实现 |

---

### 3.3 内存管理子系统 (`core/src/mm.rs`)

#### 3.3.1 地址空间管理

基于 ArceOS `axmm::AddrSpace`：

```rust
pub fn new_user_aspace_empty() -> AxResult<AddrSpace> {
    AddrSpace::new_empty(
        VirtAddr::from_usize(USER_SPACE_BASE),
        USER_SPACE_SIZE,
    )
}
```

各架构地址空间布局：

| 参数 | RISC-V | LoongArch | x86_64 / AArch64 |
|------|--------|-----------|-------------------|
| USER_SPACE_BASE | 0x1000 | 0x1000 | 0x1000 |
| USER_SPACE_SIZE | ~256GB | ~256GB | ~128TB |
| USER_STACK_TOP | 0x4_0000_0000 | 0x4_0000_0000 | 0x7fff_0000_0000 |
| USER_STACK_SIZE | 512KB | 512KB | 512KB |
| USER_HEAP_BASE | 0x4000_0000 | 0x4000_0000 | 0x4000_0000 |
| USER_HEAP_SIZE_MAX | 512MB | 512MB | 512MB |

#### 3.3.2 ELF 加载

`load_user_app()` 实现完整的 ELF 加载流程：

1. 使用 LRU 缓存 (`LRUCache<ElfCacheEntry, 32>`) 缓存已加载的 ELF 文件
2. 解析 ELF Program Headers，提取 LOAD 段
3. 检测并处理动态链接器 (PT_INTERP) → 递归加载 ld.so 到 USER_INTERP_BASE
4. 使用 CoW (Copy-on-Write) 后端映射文件段
5. 映射信号 trampoline 页面
6. 映射 VDSO 共享库
7. 构造 AUX vector（包括 AT_PHDR、AT_ENTRY、AT_BASE 等）
8. 初始化用户栈（argv、envp、auxv）

关键代码片段——ELF 段映射：
```rust
let backend = Backend::new_cow(
    seg_start,
    PageSize::Size4K,
    FileBackend::Cached(cache.clone()),
    ph.offset,
    Some(ph.offset + ph.file_size),
);
uspace.map(seg_start.align_down_4k(), seg_align_size,
    mapping_flags(ph.flags), false, backend)?;
```

#### 3.3.3 mmap 实现 (`api/src/syscall/mm/mmap.rs`)

支持完整的 mmap 语义：
- MAP_PRIVATE / MAP_SHARED / MAP_SHARED_VALIDATE
- MAP_FIXED / MAP_FIXED_NOREPLACE
- MAP_ANONYMOUS / MAP_POPULATE / MAP_STACK / MAP_HUGETLB
- 文件映射（Cached/Direct 后端）
- 设备映射（物理地址、只读、缓存文件）
- 共享内存后端 (SharedPages)
- 大页支持 (2MB / 1GB)

#### 3.3.4 brk 实现 (`api/src/syscall/mm/brk.rs`)

支持堆的动态扩展与收缩：
- 扩展：分配新的物理页并通过 `Backend::new_alloc` 映射
- 收缩：调用 `AddrSpace::unmap` 释放页
- 限制在 `USER_HEAP_BASE + USER_HEAP_SIZE_MAX` 范围内

#### 3.3.5 实现完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| 地址空间创建 | 完整 | 基于 axmm::AddrSpace |
| ELF 加载 | 完整 | 支持静态/动态链接、解释器 |
| mmap | 完整 | 支持匿名/文件/设备/共享/大页映射 |
| brk | 完整 | 支持扩展和收缩 |
| CoW | 完整 | 基于 Backend::new_cow |
| 内核空间复制 | 按架构 | RISC-V/x86_64需要，AArch64/LoongArch不需要 |
| mprotect | 未实现 | syscall 分发中未出现 |
| madvise | 未实现 | syscall 分发中未出现 |

---

### 3.4 系统调用子系统 (`api/src/syscall/`)

#### 3.4.1 系统调用分发架构

`handle_syscall()` 函数为核心入口，特殊处理 vSched2 的专用 ecall（sysno=0xdead），其余通过 `Sysno` 枚举匹配分发。

支持的 syscall 总数：约 **206 个匹配分支**。

#### 3.4.2 各子系统 syscall 覆盖

| 子系统 | 文件 | 主要 syscall |
|--------|------|-------------|
| **文件控制** | `fs/ctl.rs` | ioctl, chdir, fchdir, chroot, mkdirat, getdents64, linkat, unlinkat, symlinkat, renameat2, sync, syncfs |
| **文件操作** | `fs/fd_ops.rs` | openat, close, close_range, dup, dup3, fcntl, flock, chown/fchown/fchownat, chmod/fchmod/fchmodat, readlinkat, utimensat |
| **文件I/O** | `fs/io.rs` | read, readv, write, writev, lseek, truncate/ftruncate, fallocate, fsync/fdatasync, pread64/pwrite64, preadv/pwritev, sendfile, copy_file_range |
| **文件状态** | `fs/stat.rs` | statfs/fstatfs, statx, fstat, newfstatat, getxattr/listxattr |
| **内存文件** | `fs/memfd.rs` | memfd_create |
| **挂载** | `fs/mount.rs` | mount, umount2, fsmount, fsopen |
| **管道** | `fs/pipe.rs` | pipe2 |
| **事件通知** | `fs/event.rs` | eventfd2, eventfd |
| **signalfd** | `fs/signalfd.rs` | signalfd4 |
| **pidfd** | `fs/pidfd.rs` | pidfd_open, pidfd_getfd |
| **内存管理** | `mm/` | mmap, brk, mincore |
| **进程/线程** | `task/` | clone, execve, exit, exit_group, wait4, getpid, gettid, getppid, set_tid_address, prctl, arch_prctl, sched_yield, nanosleep, getrandom, rseq |
| **信号** | `signal.rs` | rt_sigaction, rt_sigprocmask, rt_sigpending, kill, tkill, tgkill, rt_sigqueueinfo, rt_tgsigqueueinfo, rt_sigreturn, rt_sigtimedwait, rt_sigsuspend |
| **网络** | `net/` | socket, bind, connect, listen, accept/accept4, shutdown, socketpair, sendmsg/recvmsg, sendto/recvfrom, getsockname/getpeername, getsockopt/setsockopt |
| **I/O多路复用** | `io_mpx/` | epoll_create1, epoll_ctl, epoll_wait, poll, ppoll, select, pselect6 |
| **IPC** | `ipc/` | shmget, shmat, shmdt, shmctl, msgget, msgsnd, msgrcv, msgctl |
| **同步** | `sync/` | futex, get_robust_list, set_robust_list, membarrier |
| **时间** | `time.rs` | clock_gettime, gettimeofday, clock_getres, times, getitimer, setitimer |
| **系统** | `sys.rs` | getuid, geteuid, getgid, getegid, uname, sysinfo, getrlimit, setrlimit, getpriority, setpriority |
| **资源** | `resources.rs` | getrusage, prlimit64 |

#### 3.4.3 实现完整度评估

| 类别 | 完整度 | 说明 |
|------|--------|------|
| 文件系统 syscall | 高 (~85%) | 缺少 xattr 完整实现、inotify |
| 内存管理 syscall | 中 (~50%) | 缺少 mprotect, madvise, msync, mlock |
| 进程管理 syscall | 高 (~80%) | 缺少 vfork, 命名空间相关 |
| 信号 syscall | 高 (~90%) | 基本完整 |
| 网络 syscall | 中高 (~75%) | TCP/UDP/Unix socket, 缺少原始socket |
| I/O 多路复用 | 完整 | epoll/poll/select 均已实现 |
| IPC syscall | 基本 (~70%) | 共享内存和消息队列基本可用 |
| 时间 syscall | 高 (~80%) | 支持主流时钟 |

---

### 3.5 虚拟文件系统 (`core/src/vfs/`, `api/src/vfs/`)

#### 3.5.1 VFS 架构

StarryOS 实现了自己的轻量级 VFS 抽象层，构建在 ArceOS `axfs_ng_vfs` 之上：

**核心 trait 体系：**
- `SimpleFileOps`：简单文件读写（`read_all` / `write_all`）
- `SimpleDirOps`：目录操作（`child_names` / `lookup_child`）
- `DeviceOps`：设备操作（`read_at` / `write_at` / `ioctl` / `mmap`）

**核心类型：**
- `SimpleFs`：基于 slab 分配 inode 的简单文件系统
- `SimpleFsNode`：文件系统节点（inode + metadata）
- `SimpleFile<O>`：实现 `FileNodeOps` 的文件
- `SimpleDir<O>`：实现 `DirNodeOps` 的目录
- `Device`：设备文件
- `RwFile<F>`：读/写回调包装器

#### 3.5.2 挂载的文件系统

`mount_all()` 挂载以下文件系统：

| 挂载点 | 类型 | 实现 |
|--------|------|------|
| `/dev` | devfs | `SimpleFs` + 设备文件 |
| `/dev/shm` | tmpfs | `MemoryFs`（独立实现的内存文件系统） |
| `/tmp` | tmpfs | `MemoryFs` |
| `/proc` | procfs | `SimpleFs` + 动态生成的 proc 文件 |
| `/sys` | tmpfs | `MemoryFs` + 符号链接 |

#### 3.5.3 MemoryFs 实现细节 (`api/src/vfs/tmp.rs`)

`MemoryFs` 是一个完整的独立内存文件系统实现，包括：
- 基于 `Slab` 的 inode 分配
- 支持文件和目录
- 基于 HashMap 的目录项存储
- 支持符号链接
- nlink 追踪（当 nlink==0 且引用计数==2 时自动回收 inode）
- 文件内容由 ArceOS 页缓存管理（仅记录长度）
- 支持创建、链接、删除、重命名等操作

#### 3.5.4 procfs 实现 (`api/src/vfs/proc.rs`)

动态生成的 proc 文件系统，每个 PID 目录提供：
- `/proc/[pid]/stat`：基于 `TaskStat` 结构，格式兼容 Linux
- `/proc/[pid]/status`：进程状态文本
- `/proc/[pid]/oom_score_adj`：OOM 分数（可读写）
- `/proc/[pid]/task/`：线程子目录
- `/proc/[pid]/fd/`：文件描述符目录（符号链接到实际路径）
- `/proc/[pid]/maps`：内存映射（当前硬编码 VDSO 区域）
- `/proc/[pid]/mounts`：挂载信息
- `/proc/[pid]/cmdline`：命令行
- `/proc/[pid]/comm`：命令名
- `/proc/[pid]/exe`：可执行文件路径链接
- `/proc/meminfo`：硬编码的内存信息
- `/proc/interrupts`：中断计数

#### 3.5.5 设备文件 (`api/src/vfs/dev/mod.rs`)

| 设备 | 主:次设备号 | 说明 |
|------|------------|------|
| `/dev/null` | 1:3 | 空设备 |
| `/dev/zero` | 1:5 | 零设备 |
| `/dev/full` | 1:7 | 满设备 |
| `/dev/random` | 1:8 | 伪随机数 |
| `/dev/urandom` | 1:9 | 非阻塞随机数 |
| `/dev/tty` | 5:0 | 当前 TTY |
| `/dev/console` | 5:1 | 控制台 |
| `/dev/ptmx` | 5:2 | PTY 主设备 |
| `/dev/pts/` | — | PTY 从设备目录 |
| `/dev/rtc0` | — | 实时时钟 |
| `/dev/fb0` | 29:0 | 帧缓冲（条件编译） |
| `/dev/loop[0-15]` | 7:0 | 循环块设备 |
| `/dev/cpu_dma_latency` | 10:1024 | PM QoS |
| `/dev/log` | — | 日志设备（条件编译） |
| `/dev/memtrack` | 114:514 | 内存追踪（条件编译） |
| `/dev/input/` | — | 输入设备（条件编译） |

#### 3.5.6 实现完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| VFS 抽象 | 完整 | trait 设计良好 |
| devfs | 高 | 覆盖常用设备 |
| procfs | 中高 | 核心文件具备，部分数据硬编码 |
| tmpfs/MemoryFs | 完整 | 功能齐全 |
| ext4 支持 | 通过 ArceOS | 由 axfs 的 ext4 模块提供 |
| FAT 支持 | 通过 ArceOS | 由 axfs 提供 |
| 文件锁 (flock) | 已存根 | fcntl 中有 flock 调用但未深入实现 |

---

### 3.6 信号子系统 (`api/src/signal.rs`)

#### 3.6.1 信号处理流程

基于 `starry-signal` crate（外部依赖）：

1. **检查信号**：`check_signals()` 从 `ThreadSignalManager` 出队信号
2. **OS 动作处理**：
   - `Terminate`：调用 `do_exit()`
   - `CoreDump`：do_exit(128+signo)（coredump 未实现）
   - `Stop/Continue`：存根未实现
   - `Handler`：通过信号 trampoline 在用户态执行处理函数
3. **信号屏蔽**：支持 `block_next_signal()` / `unblock_next_signal()`
4. **信号帧**：`SignalFrame` 保存/恢复用户上下文（包括信号栈切换）

#### 3.6.2 信号系统调用覆盖

| syscall | 状态 |
|---------|------|
| rt_sigaction | 完整 |
| rt_sigprocmask | 完整 |
| rt_sigpending | 完整 |
| kill / tkill / tgkill | 完整 |
| rt_sigqueueinfo / rt_tgsigqueueinfo | 完整 |
| rt_sigreturn | 完整 |
| rt_sigtimedwait | 完整 |
| rt_sigsuspend | 完整 |
| signalfd4 | 完整 |

#### 3.6.3 实现完整度评估：**高（约85%）**

缺少：coredump 实际生成、stop/continue 语义完整实现。

---

### 3.7 Futex 子系统 (`core/src/futex.rs`)

#### 3.7.1 核心设计

- **FutexKey**：区分私有和共享 futex
  - `Private { address }`：进程内 futex
  - `Shared { offset, region }`：跨进程 futex（基于共享内存）
- **FutexTable**：HashMap<地址, FutexEntry>，每进程持有
- **WaitQueue**：基于 `VecDeque<(Waker, u32)>` 的等待队列
  - 支持 bitset 匹配唤醒
  - 支持 requeue 操作
- **FutexGuard**：RAII 模式自动清理空等待队列

#### 3.7.2 支持的操作

| 操作 | 状态 |
|------|------|
| FUTEX_WAIT | 完整 |
| FUTEX_WAIT_BITSET | 完整 |
| FUTEX_WAKE | 完整 |
| FUTEX_WAKE_BITSET | 完整 |
| FUTEX_REQUEUE | 完整 |
| FUTEX_CMP_REQUEUE | 完整 |
| PI futex | **未实现** |
| FUTEX_WAKE_OP | **未实现** |

#### 3.7.3 Robust List

支持 `get_robust_list` / `set_robust_list`，线程退出时调用 `exit_robust_list()` 遍历链表设置 `owner_dead` 并唤醒等待者。

#### 3.7.4 实现完整度评估：**中高（约70%）**

---

### 3.8 管道与I/O多路复用

#### 3.8.1 管道 (`api/src/file/pipe.rs`)

基于 `ringbuf::HeapRb` 实现：
- 默认容量 64KB（`RING_BUFFER_INIT_SIZE`）
- 支持 `FIONREAD` ioctl
- 支持非阻塞模式
- 支持 fcntl 调整容量（页面对齐）
- 写端关闭时发送 SIGPIPE
- 集成 Pollable 用于 epoll

#### 3.8.2 Epoll (`api/src/file/epoll.rs`)

完整实现：
- `epoll_create1`（支持 CLOEXEC）
- `epoll_ctl`（ADD/MOD/DEL）
- `epoll_wait`（支持 EPOLLONESHOT、边缘触发）
- 集成信号处理（超时等待期间可被信号中断）

#### 3.8.3 Poll/Select

`poll` 和 `ppoll`、`select` 和 `pselect6` 均基于统一的事件循环框架实现。

#### 3.8.4 实现完整度评估：**高（约90%）**

---

### 3.9 终端子系统 (`api/src/terminal/`)

#### 3.9.1 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| `Terminal` | `mod.rs` | 终端主结构：job control + 窗口大小 + termios |
| `LineDiscipline` | `ldisc.rs` | 行规程：输入处理、缓冲、canonical/raw 模式 |
| `JobControl` | `job.rs` | 前台进程组管理、会话关联 |
| `Termios2` | `termios.rs` | 终端属性（通过外部 crate） |
| PTY 主/从 | `tty/ptm.rs`, `tty/pts.rs` | 伪终端对 |
| N_TTY | `tty/ntty.rs` | 默认 TTY 设备 |

#### 3.9.2 行规程实现细节

`LineDiscipline<R, W>` 支持三种处理模式：
- **Manual**：仅在 read 调用时处理输入
- **External**：后台任务持续处理输入
- **None**：透传模式（用于 PTY master）

输入处理特色：
- Canonical 模式：行缓冲、退格 (VERASE)、行删除 (VKILL)
- 信号生成：识别 VINTR/VQUIT/VSUSP 字符并发送信号到前台进程组
- 回显 (ECHO)：支持 ECHOCTL 控制字符显示
- 输入转换：ICRNL（CR→NL）、IGNCR

#### 3.9.3 实现完整度评估：**中高（约75%）**

---

### 3.10 网络子系统

#### 3.10.1 Socket 支持

通过 `axnet`（ArceOS 网络栈）提供：

| 协议族 | 类型 | 状态 |
|--------|------|------|
| AF_INET (IPv4) | SOCK_STREAM (TCP) | 完整 |
| AF_INET (IPv4) | SOCK_DGRAM (UDP) | 完整 |
| AF_UNIX | SOCK_STREAM | 完整 |
| AF_UNIX | SOCK_DGRAM / SOCK_SEQPACKET | 完整 |
| AF_VSOCK | SOCK_STREAM | 条件编译 |

#### 3.10.2 Socket 操作

支持的 socket API：
- socket / bind / connect / listen / accept / accept4
- shutdown / socketpair
- sendmsg / recvmsg（含辅助数据 cmsg）
- sendto / recvfrom
- getsockname / getpeername
- getsockopt / setsockopt

#### 3.10.3 实现完整度评估：**中高（约75%）**

缺少：AF_INET6 (IPv6)、AF_NETLINK、原始 socket (SOCK_RAW)、packet socket。

---

### 3.11 共享内存与IPC (`core/src/shm.rs`, `api/src/syscall/ipc/`)

#### 3.11.1 System V 共享内存

`ShmManager` 实现：
- `shmget`：创建/获取共享内存段
- `shmat`：附加共享内存（支持 SHM_RDONLY/SHM_RND/SHM_REMAP）
- `shmdt`：分离共享内存
- `shmctl`：IPC_STAT/IPC_SET/IPC_RMID
- 基于 `SharedPages`（ArceOS）的物理页共享
- 双向 BTreeMap (`BiBTreeMap`) 用于 key↔shmid 映射
- `IpcPerm`/`ShmidDs` 数据结构与 Linux 兼容

#### 3.11.2 System V 消息队列

基本实现（`api/src/syscall/ipc/msg.rs`）：msgget/msgsnd/msgrcv/msgctl。

#### 3.11.3 虚拟队列 IPC (`deps/vqueue_vdso/`, `core/src/vipc.rs`)

基于 VDSO 的高性能 IPC：
- 无锁双端队列 (`LockFreeDeque`)
- Slot array 管理每个进程的 IPC 数据结构
- `IpcEntity` 封装 slot 引用计数
- 消息类型到通知 ID 的映射（用于调度器集成）

#### 3.11.4 实现完整度评估

| 组件 | 完整度 |
|------|--------|
| System V 共享内存 | 中高 (~80%) |
| System V 消息队列 | 基本 (~60%) |
| System V 信号量 | **未实现** |
| vQueue IPC | 基本框架 |

---

### 3.12 vSched2 调度器子系统 (`core/src/vsched/`)

这是 StarryOS 最具创新性的子系统——一个**用户态协程式调度框架**。

#### 3.12.1 架构设计

vSched2 将调度逻辑从内核态移至用户态，通过 VDSO 共享库暴露调度器代码给用户态进程。核心思想：

1. **调度器代码在 VDSO 中**：用户态和内核态共用同一份调度器代码
2. **任务 trait 接口**：内核通过 trait 实现将任务信息传递给调度器
3. **用户态 → 内核态切换**：通过特殊 ecall (a7=0xdead) 触发
4. **内核态 → 用户态切换**：通过 sret 到 VDSO 中的 `raw_run_task`
5. **陷阱处理**：自定义陷阱向量 `vsched2_trap_vector` 处理所有中断/异常

#### 3.12.2 核心类型

```rust
pub struct VschedTaskImpl {
    pub task: AxTaskRef,
    pub priority: AtomicIsize,
    pub pid: AtomicUsize,
    pub is_coroutine: AtomicBool,
    pub return_value: AtomicIsize,
    pub thread_stack_base: AtomicUsize,
    pub thread_stack_ptr: AtomicUsize,
    pub coroutine: Option<Arc<dyn CoroutinePoll>>,
    pub user_vdso_base: AtomicUsize,
    pub trap_frame: AtomicUsize,       // *mut UserTrapFrame
    pub user_page_table_root: AtomicUsize,
    pub user_aspace_ptr: AtomicUsize,
}
```

#### 3.12.3 VDSO VTable 接口

通过 `libvsched2` 的 `VdsoVTable` 暴露 27 个函数指针：

| 类别 | 函数 |
|------|------|
| 初始化 | kernel_init_main, kernel_init_secondary, process_init, process_drop, process_reinit |
| 用户态调度 | user_init, user_init_with_vspace, user_scheduler_addr |
| 任务管理 | push_task_into_current, push_task, push_task_into_process |
| 上下文 | current_vspace, trap_handler, current_task_ptr, set_current_task_ptr |
| 栈管理 | take_current_stack |
| 原始入口 | raw_trap_entry, raw_thread_entry, raw_run_task, raw_kschedule |
| VTable 初始化 | init_vtable_Task/Stack/Context/TrapInfo/SMP/VSpace/UserData |

#### 3.12.4 陷阱向量实现 (`trap_vector.rs`)

汇编实现的 `vsched2_trap_vector` 分为四个阶段：

1. **Phase 1**：切换到预保存栈（csrrw sp, sscratch, sp），保存 t0-t4
2. **Phase 2**：检测 vSched2 特殊 ecall（scause==8 && a7==0xdead），直接跳转调度器
3. **Phase 3**：恢复用户 t0-t3，填充 TrapFrame
4. **Phase 4**：保存完整上下文（32 个寄存器 + sepc/sstatus/scause/stval）

关键设计特点：
- 内核页映射在所有用户页表中，避免 SATP 切换
- 设置 SUM 和 MXR 位以允许内核访问用户页
- 恢复内核 gp 寄存器（per-CPU 基址）

#### 3.12.5 Yield 路径

`vsched_yield_trampoline`：保存 callee-saved 寄存器、sepc、sstatus，调用 `vsched_yield_entry_stub` 通知调度器。

#### 3.12.6 实现完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| 用户态调度框架 | 完整 | 但默认禁用 (USE_VSCHED2=false) |
| RISC-V 支持 | 完整 | 汇编陷阱向量已实现 |
| x86_64/AArch64/LoongArch | **未实现** | vsched context 中有 `unimplemented!()` |
| SMP 支持 | 基本 | VschedSmpImpl 仅返回当前 CPU ID |
| 内核协程 | 基本 | TrapHandlerCoroutine 用于异步陷阱处理 |
| 抢占调度 | 部分 | 框架已就绪，依赖 libvsched2.so 中的具体策略 |

---

### 3.13 VDSO 基础设施

#### 3.13.1 `build_vdso` 构建工具 (`deps/build_vdso/`)

自动化 VDSO 构建流程：
1. 生成链接脚本（vdso_linker.lds）
2. 编译 wrapper 静态库（通过 cargo）
3. 链接生成 `.so` 文件（通过 musl-ld）
4. 生成 API 库（通过代码生成）

#### 3.13.2 `elf_parser` (`deps/elf_parser/`)

独立的 ELF 解析库，支持：
- RISC-V (RV64)、AArch64、x86_64
- ELF 段提取（`get_elf_segments`）
- AUX vector 构建（`get_auxv_vector`）
- 用户栈初始化（`get_app_stack_region`）
- 重定位对提取（`get_relocate_pairs`，用于动态链接）

#### 3.13.3 `vsched_hal` (`deps/vsched_hal/`)

调度器硬件抽象层：
- RISC-V：`TaskContext` 结构 + `context_switch` 汇编
- AArch64：类似的上下文结构
- x86_64：类似的上下文结构
- 通过 STR/LDR 宏实现 callee-saved 寄存器保存/恢复

---

### 3.14 执行器子系统（旧版，已弃用）(`core/src/executor/`)

`executor/` 目录包含一个基于异步任务的进程执行器实现，当前已被注释禁用：

```toml
#asynctask = { path = "arceos/modules/asynctask" }
#trampoline = { path = "arceos/modules/trampoline" }
#executor = { path = "core/src/executor" }
```

它实现了：
- `Executor`：进程抽象（地址空间 + 文件描述符 + 调度器）
- `current`：当前任务管理
- `table`：PID→Executor 映射
- `signal`：异步信号处理

---

## 四、多架构支持

### 4.1 架构对比

| 特性 | RISC-V | x86_64 | AArch64 | LoongArch |
|------|--------|--------|---------|-----------|
| 地址空间配置 | 有 | 有 | 有 | 有 |
| 内核栈大小 | 256KB | 256KB | 256KB | 256KB |
| 用户空间布局 | ~256GB | ~128TB | ~128TB | ~256GB |
| vSched2 陷阱向量 | 汇编实现 | 未实现 | 未实现 | 未实现 |
| vsched_hal | 有 | 有 | 有 | 无 |
| elf_parser | 有 | 有 | 有 | 无 |
| 内核→用户地址空间复制 | 需要 | 需要 | 不需要 | 不需要 |
| CI 测试 | 有 | 有 | 有 | 有 |

### 4.2 实现完整度评估

RISC-V 是主要开发平台，功能最完整。其他架构的基础功能（系统调用、内存管理）可用，但 vSched2 仅在 RISC-V 上有完整的汇编陷阱向量。

---

## 五、OS内核各子系统交互

### 5.1 系统调用路径

```
用户程序
  ↓ ecall
axhal::uspace::UserContext::run()
  ↓ ReturnReason::Syscall
api/src/syscall/mod.rs::handle_syscall()
  ↓ 匹配 sysno
具体 syscall 实现 (api/src/syscall/*)
  ↓ 需要时
core/src/task.rs (进程操作)
core/src/mm.rs (内存操作)
core/src/futex.rs (同步操作)
  ↓ 底层
ArceOS 模块 (axfs/axnet/axmm/axhal)
```

### 5.2 中断/异常处理路径

```
硬件中断/异常
  ↓
vsched2_trap_vector (如果启用vSched2)
  或 ArceOS 默认陷阱向量
  ↓
UserContext::run() 返回 ReturnReason
  ↓
task.rs::new_user_task() 中的主循环处理：
  - PageFault → AddrSpace::handle_page_fault
  - Exception → 信号发送 (SIGSEGV/SIGBUS/SIGILL/SIGTRAP)
  - Interrupt → 忽略（由驱动处理）
  - Syscall → handle_syscall()
```

### 5.3 进程创建路径

```
sys_clone()
  ↓
new_user_task() → TaskInner::new()
  ↓
Process::fork() → 新 PID
  ↓
AddrSpace::try_clone() (CoW)
  ↓
ProcessData::new() → Thread::new()
  ↓
spawn_task() 或 vsched2 注册
```

### 5.4 文件I/O路径

```
read(fd, buf, len)
  ↓
FD_TABLE → get_file_like(fd)
  ↓
FileLike::read() → 根据类型分发：
  - File → axfs::File::read() → ext4/FAT/...
  - Pipe → ringbuf 读写
  - Socket → axnet Socket::recv()
  - Device → DeviceOps::read_at()
  - EpollFd → 不支持
```

---

## 六、创新性分析

### 6.1 vSched2 用户态调度框架

**创新程度：高**

这是 StarryOS 最显著的创新点。将调度器代码编译为 VDSO 共享库，使得调度策略可以在用户态执行，同时内核通过 trait 接口提供必要的支持。这种设计：

- 允许调度策略的热更新（替换 VDSO .so 文件）
- 减少了内核态/用户态切换开销（调度决策在用户态完成）
- 支持协程式调度（CoroutinePoll trait）
- 自定义陷阱向量直接与调度器交互

然而该功能默认禁用（`USE_VSCHED2 = false`），且仅在 RISC-V 上有完整实现。

### 6.2 VDSO 构建工具链

**创新程度：中高**

`build_vdso` crate 提供了一套完整的 VDSO 构建工具，自动完成编译、链接、API 生成。这种自动化工具在 Rust 内核项目中较为少见。

### 6.3 MemoryFs 独立实现

**创新程度：低**

内存文件系统在 OS 内核中常见，但 StarryOS 的实现独立于 ArceOS 的 VFS，有自己的 inode 管理和引用计数系统，设计清晰。

### 6.4 基于 Scope 的资源隔离

**创新程度：中**

使用 `scope-local` crate 实现文件描述符表和 FS 上下文的 per-process 隔离，支持 clone 时的共享/复制语义。这是一种 Rust 原生的资源隔离方法。

---

## 七、项目整体评估

### 7.1 实现完整度总结

| 子系统 | 完整度 | 评级 |
|--------|--------|------|
| 进程管理 | 85% | A |
| 内存管理 | 75% | B+ |
| 文件系统 (VFS) | 80% | B+ |
| 系统调用覆盖 | 80% | B+ |
| 信号处理 | 85% | A- |
| Futex/同步 | 70% | B |
| 管道/I/O多路复用 | 90% | A |
| 终端/TTY | 75% | B+ |
| 网络协议栈 | 75% | B+ |
| IPC | 65% | B- |
| vSched2 调度器 | 60% | C+ |
| 多架构支持 | 70% | B |
| **整体** | **~77%** | **B+** |

### 7.2 优势

1. **基于成熟的 ArceOS 框架**：复用了 HAL、驱动、网络栈等基础能力
2. **Rust 安全性**：充分利用 Rust 的类型系统、所有权模型
3. **多架构支持**：RISC-V/x86_64/AArch64/LoongArch，CI 覆盖全
4. **系统调用覆盖广**：约 206 个 syscall，可运行复杂用户态程序
5. **创新的 vSched2 框架**：用户态调度是独特的设计探索
6. **代码结构清晰**：模块划分合理，core/api 分离良好

### 7.3 不足

1. **vSched2 未完成**：默认禁用，非 RISC-V 架构未实现
2. **部分功能硬编码**：如 `/proc/meminfo` 为静态文本、`/proc/[pid]/maps` 仅显示 VDSO
3. **IPC 不完整**：缺少 System V 信号量
4. **网络协议栈有限**：缺少 IPv6、原始 socket、netlink
5. **文档不足**：仅有 `x11.md` 和 README，缺少详细设计文档
6. **遗留代码**：`executor/`、`vipc` 等模块处于注释/弃用状态
7. **VDSO 构建依赖复杂**：需要 musl-ld 链接器，预构建产物存储在仓库中

### 7.4 项目成熟度

该项目处于**活跃开发中的原型/中级阶段**。核心 POSIX 兼容性足以运行 shell 和许多用户态程序，但距离生产就绪还有较大差距。项目的创新方向明确（用户态调度），但这一功能尚未成为默认配置。

---

## 八、总结

StarryOS 是一个基于 ArceOS 框架的 Rust 宏内核项目，目标为支持多架构的通用操作系统。项目实现了约 56,000 行 Rust 代码，覆盖了进程管理、内存管理、文件系统、网络协议栈、信号处理、同步原语等主流内核子系统，支持约 206 个 Linux 兼容系统调用。

项目最显著的创新是 **vSched2 用户态调度框架**——通过 VDSO 共享库将调度器逻辑移至用户态，结合自定义陷阱向量和 trait 接口，实现了一种新颖的调度架构。这一设计在 Rust 内核领域具有较强的探索意义。

整体完整度约为 **77%**，RISC-V 是主要支持平台。核心功能（进程/内存/文件/网络/信号）已经能够支持运行 shell 和复杂用户态程序，但 IPC、部分 syscall、非 RISC-V 架构的 vSched2 等方面仍有较大改进空间。