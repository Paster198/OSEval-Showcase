# OrayS OS 内核项目深度技术报告

## 一、分析方法说明

本报告基于对 OrayS 项目源码的完整静态分析，包括：

1. **全量源码审查**：遍历 workspace 内所有 crate 的 Rust/C/汇编源文件（~138,000 行 Rust + ~6,000 行 C + ~1,200 行汇编），逐子系统分析实现细节。
2. **构建系统分析**：解析 `Makefile`（~717 行）和 `Cargo.toml` 配置，理解编译流程、feature 组合、平台适配机制。
3. **依赖关系梳理**：分析 vendor 目录下的 6 个本地化 crate，以及 `Cargo.lock` 中的外部依赖。
4. **测试基础设施审查**：分析 `scripts/` 目录下的 26 个测试/检查脚本，以及 `user/shell/src/cmd.rs` 中内嵌的 LTP 测试运行器。

由于环境缺少 RISC-V musl GCC 工具链（bootlin 工具链不可用），未能进行实际的编译构建与 QEMU 运行测试。

---

## 二、项目总体架构

### 2.1 分层架构

OrayS 采用明确的六层架构，从底向上依次为：

```
┌─────────────────────────────────────────────────────────┐
│  用户态程序 (BusyBox, LTP, UnixBench)                    │
├─────────────────────────────────────────────────────────┤
│  Linux ABI 兼容层 (user/shell/src/uspace/)    ~37,437 行 │
│  ├─ 系统调用分发 (231+ Linux syscalls)                   │
│  ├─ 进程生命周期 (fork/clone/execve/wait/exit)           │
│  ├─ 文件描述符表 (FdTable, ~10,094 行)                   │
│  ├─ 内存映射 (mmap/mprotect/brk)                         │
│  ├─ 信号 (sigaction/sigreturn/rt_sig*)                   │
│  ├─ futex, 管道, socket, IPC, epoll, select              │
│  └─ ELF 程序加载器                                       │
├─────────────────────────────────────────────────────────┤
│  POSIX API 层 (api/arceos_posix_api/)                    │
│  ├─ fd_ops, fs, io, net, pipe, pthread, signal, time     │
│  └─ IO 多路复用 (epoll/select)                           │
├─────────────────────────────────────────────────────────┤
│  ArceOS API 层 (api/arceos_api/)                         │
│  └─ 显示/文件系统/内存/网络/任务抽象                      │
├─────────────────────────────────────────────────────────┤
│  内核核心子系统:                                          │
│  ├─ 文件系统 (axfs): VFS + FAT + EXT4 + ramfs + devfs   │
│  ├─ 网络 (axnet): smoltcp TCP/UDP/DNS                    │
│  ├─ 任务调度 (axtask): FIFO/RR/CFS + 等待队列 + 定时器   │
│  ├─ 内存管理 (axalloc + axmm): TLSF + 位图页分配器       │
│  ├─ 同步原语 (axsync): Mutex                             │
│  ├─ SMP/IPI (axipi): 事件 + 消息队列                     │
│  └─ 命名空间 (axns): 全局/线程局部键值存储               │
├─────────────────────────────────────────────────────────┤
│  硬件抽象层 (axhal):                                      │
│  ├─ 启动/内存/中断/页表/定时器/CPU本地存储                │
│  └─ 通过 axcpu + axplat 支持 4 种架构                    │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Crate 依赖图

项目包含 **21 个 workspace 成员 crate** + **6 个 vendored crate**：

**内核核心 crate（15 个）**：
`axhal`, `axconfig`, `axlog`, `axdriver`, `axdisplay`, `axdma`, `axfs`, `axalloc`, `axmm`, `axns`, `axnet`, `axruntime`, `axipi`, `axsync`, `axtask`

**API 层 crate（3 个）**：
`axfeat`, `arceos_api`, `arceos_posix_api`

**用户态 crate（3 个）**：
`axstd`, `axlibc`, `arceos-shell` (即 `user/shell`)

**Vendored crate（6 个）**：
`axcpu`, `axfs_ramfs`, `axfs_vfs`, `axsched`, `rust-fatfs`, `smoltcp`

---

## 三、各子系统详细分析

### 3.1 硬件抽象层 (axhal + axcpu + axplat)

#### 3.1.1 架构支持矩阵

| 架构 | 页表格式 | 用户态页表隔离 | 信号栈帧 | FP/SIMD |
|------|----------|----------------|----------|---------|
| RISC-V64 | Sv39 | satp 切换 | RISC-V sigframe (含 FP 状态, 528 字节) | 支持 (Sstatus.FS) |
| LoongArch64 | LA64 (PGDL) | 独立 PGDL | 基本 sigframe | 未适配 |
| x86_64 | x86-64 4-level | 保留 | 未完全适配 | 支持 |
| AArch64 | VMSAv8-64 (TTBR0_EL1) | 独立 TTBR0 | 未完全适配 | 未适配 |

**关键发现**：RISC-V64 和 LoongArch64 是主要目标架构，两者均实现了完整的从硬件抽象到用户态信号传递的链路。

#### 3.1.2 Trap 处理流程

RISC-V 和 LoongArch 的 trap 处理流程类似，以 RISC-V 为例：

```rust
// vendor/axcpu/src/riscv/trap.rs
fn riscv_trap_handler(tf: &mut TrapFrame, from_user: bool) {
    let scause = scause::read();
    match scause.cause() {
        // 用户态系统调用 (U-Mode ecall)
        Trap::Exception(E::UserEnvCall) => {
            tf.regs.a0 = crate::trap::handle_syscall(tf, tf.regs.a7) as usize;
            tf.sepc += 4;
        }
        // 缺页异常
        Trap::Exception(E::LoadPageFault) => handle_page_fault(...),
        Trap::Exception(E::StorePageFault) => handle_page_fault(...),
        Trap::Exception(E::InstructionPageFault) => handle_page_fault(...),
        // 用户态其它异常 → 信号
        Trap::Exception(E::IllegalInstruction) if from_user => {
            handle_user_signal(tf, 4) // SIGILL
        }
        // 中断
        Trap::Interrupt(_) => handle_trap!(IRQ, scause.bits()),
        // 未知用户态异常
        _ if from_user => handle_user_signal(tf, 4),
    }
    // 返回用户态前调用钩子（信号传递、syscall 重启等）
    if from_user { crate::trap::handle_user_return(tf); }
}
```

系统调用通过 `linkme` 分布式切片机制注册：

```rust
// vendor/axcpu/src/trap.rs
#[def_trap_handler]
pub static SYSCALL: [fn(&TrapFrame, usize) -> isize];
#[def_trap_handler]
pub static PAGE_FAULT: [fn(VirtAddr, PageFaultFlags, bool) -> bool];
```

这种设计允许 `user/shell` crate 在编译时注册处理函数，而无需修改内核代码。

### 3.2 内存管理 (axalloc + axmm)

#### 3.2.1 全局分配器 (axalloc)

位于 `kernel/memory/axalloc/src/lib.rs`，采用**两级分配架构**：

```
┌─────────────────────────────────┐
│       GlobalAllocator            │
│  ┌───────────────────────────┐  │
│  │ 字节分配器 (ByteAllocator) │  │
│  │ 可选: TLSF / Slab / Buddy  │  │
│  └──────────┬────────────────┘  │
│             │ 内存不足时         │
│             ▼                    │
│  ┌───────────────────────────┐  │
│  │  页分配器 (PageAllocator)  │  │
│  │  位图 (BitmapPageAllocator)│  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

关键设计决策：
- **大分配直通页分配器**：超过 4KB（`PAGE_SIZE`）的分配直接走页分配器，避免 TLSF 碎片化。
- **分配统计**：内置 14 个桶的分配直方图（8B 到 usize::MAX），支持按大小桶追踪活跃分配。
- **帧分配统计**：`FrameAllocatorStats` 暴露 `free_frames` 和 `allocated_frames`。

#### 3.2.2 地址空间管理 (axmm)

位于 `kernel/memory/axmm/src/aspace.rs`，核心结构：

```rust
pub struct AddrSpace {
    va_range: VirtAddrRange,
    areas: MemorySet<Backend>,    // 内存区域集合
    pt: PageTable,                // 页表
}
```

支持的操作：
- `new_empty(base, size)`：创建空地址空间
- `map_linear()`：线性映射（用于内核直接映射物理内存）
- `map_alloc()`：按需分配物理帧（支持 `populate` 预填充）
- `handle_page_fault()`：缺页处理，支持按需分配、COW
- `clone_user_mappings_from()`：fork 时克隆用户映射（COW 语义）
- `share_user_mappings_from()`：vfork 时共享用户映射

**COW（Copy-on-Write）实现**：

```rust
// kernel/memory/axmm/src/aspace.rs
fn clone_user_mappings_from_inner(&mut self, other: &mut AddrSpace,
    cow_writable: bool) -> AxResult {
    // ...
    for area in other.areas.iter() {
        let cow_pages = cow_writable
            && area.flags().contains(MappingFlags::WRITE)
            && alloc_missing;
        for vaddr in PageIter4K::new(area.start(), area.end())? {
            let (src_paddr, src_flags, page_size) = /* query parent PTE */;
            let mut child_flags = src_flags;
            if cow_pages {
                child_flags.remove(MappingFlags::WRITE); // 子进程只读
                parent_protect_pages.push((vaddr, child_flags)); // 父进程也写保护
            }
            shared_pages.insert(vaddr, (src_paddr, child_flags));
            retained_frames.push(src_paddr);
        }
        // map shared pages, retain frames
    }
    // protect parent pages for COW
}
```

**共享帧引用计数**：`kernel/memory/axmm/src/backend/alloc.rs` 中维护全局 `BTreeMap<PhysAddr, refcount>`，跟踪被 COW 共享的物理帧。释放时仅在引用计数归零时才真正回收。

### 3.3 任务管理与调度 (axtask + axsched)

#### 3.3.1 任务结构

```rust
// kernel/task/axtask/src/task.rs
pub struct TaskInner {
    id: TaskId(u64),
    name: String,
    state: AtomicU8,          // Running/Ready/Blocked/Exited
    entry: Option<*mut dyn FnOnce()>,
    kstack: Option<TaskStack>,
    ctx: UnsafeCell<TaskContext>,  // 架构相关上下文
    cpumask: SpinNoIrq<AxCpuMask>, // CPU 亲和性
    exit_code: AtomicI32,
    wait_for_exit: WaitQueue,
    task_ext: AxTaskExt,      // 用户扩展数据（如 UserTaskExt）
    // ...
}
```

**任务扩展机制**：通过 `axtask::def_task_ext!(UserTaskExt)` 宏，将 `UserTaskExt`（包含 ~30 个字段的信号、futex、robust list 等状态）嵌入每个任务。扩展数据通过 `task_ext_ptr()` 获取指针。

#### 3.3.2 调度器 (axsched)

vendored `axsched` 提供三种调度策略：

| 调度器 | 类型 | 数据结构 | 优先级支持 | 抢占 |
|--------|------|----------|------------|------|
| **CFS** | 完全公平调度 | `BTreeMap<(vruntime, taskid)>` | nice值 (-20~19) 映射为权重 (15~88761) | 是 |
| **Round-Robin** | 轮转 | 队列 | 固定时间片 | 是 |
| **FIFO** | 先入先出 | 队列 | 无 | 否 |

**CFS 实现细节** (`vendor/axsched/src/cfs.rs`)：

```rust
const NICE2WEIGHT_POS: [isize; 20] = [
    1024, 820, 655, 526, 423, 335, 272, 215, 172, 137,
    110, 87, 70, 56, 45, 36, 29, 23, 18, 15,
];
const NICE2WEIGHT_NEG: [isize; 21] = [
    1024, 1277, 1586, 1991, 2501, 3121, 3906, 4904, 6100,
    7620, 9548, 11916, 14949, 18705, 23254, 29154, 36291,
    46273, 56483, 71755, 88761,
];

fn get_vruntime(&self) -> isize {
    self.init_vruntime + self.delta * 1024 / self.get_weight()
    // 高权重（低nice）→ vruntime增长慢 → 更多CPU时间
}
```

注意：CFS 权重表直接复用 Linux 内核的值，保证了调度行为的语义兼容性。

#### 3.3.3 多核支持

```rust
// kernel/task/axtask/src/run_queue.rs
percpu_static! {
    RUN_QUEUE: LazyInit<AxRunQueue>,      // 每 CPU 运行队列
    IDLE_TASK: LazyInit<AxTaskRef>,       // 每 CPU 空闲任务
    EXITED_TASKS: VecDeque<AxTaskRef>,    // 每 CPU 待回收任务
}
```

SMP 模式下通过 CPU 亲和性掩码 (`AxCpuMask`) 和简单轮转选择目标运行队列。

### 3.4 文件系统 (axfs + axfs_vfs + axfs_ramfs)

#### 3.4.1 VFS 层

`vendor/axfs_vfs/src/lib.rs` 定义了统一的 VFS 接口：

```rust
pub trait VfsNodeOps: Send + Sync {
    fn open(&self) -> VfsResult;
    fn release(&self) -> VfsResult;
    fn get_attr(&self) -> VfsResult<VfsNodeAttr>;
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> VfsResult<usize>;
    fn write_at(&self, offset: u64, buf: &[u8]) -> VfsResult<usize>;
    fn truncate(&self, size: u64) -> VfsResult;
    fn lookup(self: Arc<Self>, path: &str) -> VfsResult<VfsNodeRef>;
    fn create(&self, path: &str, ty: VfsNodeType) -> VfsResult;
    fn remove(&self, path: &str) -> VfsResult;
    fn read_dir(&self, start_idx: usize, dirents: &mut [VfsDirEntry]) -> VfsResult<usize>;
    fn rename(&self, src: &str, dst: &str) -> VfsResult;
    // ...
}
```

#### 3.4.2 文件系统实现

| 文件系统 | 实现位置 | 读写 | 主要用途 |
|----------|----------|------|----------|
| **FAT** | `kernel/fs/axfs/src/fs/fatfs.rs` | 读写 | 可读写主文件系统 |
| **EXT4** | `kernel/fs/axfs/src/fs/ext4fs.rs` | 只读 | 评测镜像加载 |
| **ramfs** | `vendor/axfs_ramfs/src/` | 读写 | tmpfs, procfs, sysfs 后端 |
| **devfs** | `vendor/axfs_vfs` 相关 | 读写 | /dev 设备节点 |

**EXT4 只读实现关键特性**：
- 基于 `ext4-view` crate 实现的只读 EXT4 访问
- 多级缓存：元数据缓存（1024 条目 LRU）、读取缓存（96 条目/4MB 每文件上限，总计 32MB）、目录缓存（64 目录/2048 条目每目录上限）
- 缓存预热：使用 `observed_reads` 计数的二次机会策略决定是否缓存

**FAT 实现关键特性**：
- 基于 vendored `rust-fatfs` (no_std 适配版)
- 支持 FAT16 格式化、文件创建/删除/读写/截断
- 权限固定为 0755（FAT 本身不支持 POSIX 权限）

#### 3.4.3 挂载系统

```rust
// kernel/fs/axfs/src/mounts.rs
rootfs /    → FAT 或 EXT4（根据 feature）
devfs /dev  → 设备节点 (null, zero, urandom)
tmpfs /tmp  → ramfs
tmpfs /var  → ramfs
proc  /proc → ramfs（预填充 cpuinfo, meminfo, mounts 等）
sysfs /sys  → ramfs（目录拓扑 + 合成内容）
```

### 3.5 网络栈 (axnet + smoltcp)

#### 3.5.1 架构

基于 vendored `smoltcp` (no_std 适配版) 实现：

```
┌──────────────────────────────────┐
│  TcpSocket / UdpSocket (axnet)   │
│  ├─ connect/bind/listen/accept    │
│  ├─ send/recv + 超时             │
│  └─ 非阻塞模式                    │
├──────────────────────────────────┤
│  smoltcp 协议栈 (vendor/smoltcp)  │
│  ├─ TCP/UDP/ICMP/DHCP/DNS       │
│  └─ 以太网/IP 层                  │
├──────────────────────────────────┤
│  网卡驱动 (axdriver/virtio-net)   │
└──────────────────────────────────┘
```

#### 3.5.2 TCP Socket 实现

```rust
// kernel/net/axnet/src/smoltcp_impl/tcp.rs
pub struct TcpSocket {
    state: AtomicU8,                // CLOSED/BUSY/CONNECTING/CONNECTED/LISTENING
    handle: UnsafeCell<Option<SocketHandle>>,
    local_addr: UnsafeCell<IpEndpoint>,
    peer_addr: UnsafeCell<IpEndpoint>,
    loopback: UnsafeCell<Option<LoopbackTcpEndpoint>>,
    nonblock: AtomicBool,
    reuse_addr: AtomicBool,
    nodelay: AtomicBool,
    recv_shutdown: AtomicBool,
    send_shutdown: AtomicBool,
    recv_timeout: Mutex<Option<Duration>>,
    send_timeout: Mutex<Option<Duration>>,
    recv_buffer_size: Mutex<usize>,
    send_buffer_size: Mutex<usize>,
}
```

支持完整 TCP 状态机：CLOSED → BUSY → CONNECTING → CONNECTED（客户端）或 LISTENING → CONNECTED（服务端），包括 shutdown（半关闭）语义。额外支持 loopback TCP 端点用于本地通信。

### 3.6 Linux ABI 兼容层 (user/shell/src/uspace/)

这是 OrayS 项目最核心的扩展层，代码量最大（37,437 行），实现了完整的 Linux 用户态兼容。

#### 3.6.1 系统调用分发

位于 `user/shell/src/uspace/syscall_dispatch.rs`（829 行），通过 `#[register_trap_handler(SYSCALL)]` 注册为唯一的系统调用处理入口。

**已注册约 231 个 Linux 系统调用**，包括：

| 类别 | 系统调用 |
|------|----------|
| **文件 IO** | read, write, openat, close, lseek, pread64, pwrite64, readv, writev, dup, dup3, sendfile, splice, tee, vmsplice, copy_file_range |
| **文件元数据** | statx, newfstatat, fstat, fstatfs, statfs, fchmod, fchmodat, fchown, fchownat, faccessat, faccessat2, fgetxattr, fsetxattr, flistxattr, fremovexattr, getxattr, setxattr, listxattr, removexattr, lgetxattr, lsetxattr, llistxattr, lremovexattr, readlinkat, symlinkat, linkat, unlinkat, renameat2, mkdirat, mknodat, utimensat, chdir, fchdir, getcwd, chroot, truncate, ftruncate, fallocate, fadvise64, readahead, fsync, fdatasync, umask, mount, umount2 |
| **进程管理** | clone, execve, exit, exit_group, wait4, waitid, getpid, getppid, getpgid, setpgid, getsid, setsid, personality |
| **内存管理** | mmap, munmap, mprotect, mremap, brk, madvise, msync, mincore, mlock, mlock2, munlock, mlockall, munlockall, mbind, get_mempolicy, set_mempolicy |
| **信号** | rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigsuspend, rt_sigtimedwait, rt_sigreturn, kill, tkill, tgkill, pidfd_send_signal, sigaltstack, signalfd4 |
| **时间** | clock_gettime, clock_settime, clock_getres, clock_nanosleep, clock_adjtime, nanosleep, gettimeofday, times, timer_create, timer_delete, timer_settime, timer_gettime, timer_getoverrun, getitimer, setitimer, adjtimex, timerfd_create, timerfd_settime, timerfd_gettime |
| **调度** | sched_yield, sched_getscheduler, sched_setscheduler, sched_getparam, sched_setparam, sched_getattr, sched_setattr, sched_getaffinity, sched_setaffinity, sched_get_priority_max, sched_get_priority_min, sched_rr_get_interval, getpriority, setpriority, nice (通过 setpriority), ioprio_get, ioprio_set |
| **资源限制** | getrlimit, setrlimit, prlimit64, getrusage |
| **凭证** | getuid, setuid, getgid, setgid, geteuid, getegid, getresuid, getresgid, setreuid, setregid, setresuid, setresgid, setfsuid, setfsgid, getgroups, setgroups, capget, capset |
| **Socket** | socket, bind, connect, listen, accept, accept4, sendto, recvfrom, sendmsg, recvmsg, getsockname, getpeername, getsockopt, setsockopt, shutdown, socketpair |
| **IO 多路复用** | epoll_create1, epoll_ctl, epoll_pwait, epoll_pwait2, ppoll, pselect6, select (间接) |
| **IPC** | pipe2, eventfd2, futex, msgget, msgsnd, msgrcv, msgctl, semget, semop, semtimedop, semctl, shmget, shmat, shmdt, shmctl, mq_open, mq_timedsend, mq_timedreceive, mq_notify, mq_getsetattr, mq_unlink |
| **系统信息** | uname, sysinfo, syslog, getcpu, prctl, sethostname, setdomainname |
| **其他** | getrandom, kcmp, pidfd_open, pidfd_getfd, memfd_create, ioctl, flock, inotify_init1, close_range |

#### 3.6.2 进程生命周期 (process_lifecycle.rs, 3,072 行)

**进程结构** (`UserProcess`，定义在 `mod.rs`)：

```rust
struct UserProcess {
    aspace: Arc<Mutex<AddrSpace>>,     // 地址空间
    owns_aspace: bool,                  // 是否拥有地址空间（非vfork子进程）
    brk: Mutex<BrkState>,              // brk 状态
    mmap_ranges: Mutex<Vec<UserMmapRegion>>,  // mmap 区域跟踪
    mlock_future: AtomicBool,
    fds: Arc<ProcessFdTable>,          // 文件描述符表（可共享）
    cwd: Mutex<String>,                // 当前工作目录
    fs_root: Mutex<String>,            // 文件系统根
    exec_root: Mutex<String>,          // exec 根
    exec_path: Mutex<String>,          // 可执行文件路径
    children: Mutex<Vec<ChildTask>>,   // 子进程列表
    child_exit_wait: WaitQueue,        // 等待子进程退出的等待队列
    rlimits: Mutex<BTreeMap<u32, UserRlimit>>,
    signal_actions: Mutex<BTreeMap<usize, kernel_sigaction>>,
    path_modes: Mutex<BTreeMap<String, u32>>,  // 虚拟文件系统权限
    path_inodes: Mutex<BTreeMap<String, u64>>, // 虚拟 inode 号
    path_symlinks: Mutex<BTreeMap<String, String>>,  // 符号链接
    // ... 更多元数据字段
    real_uid/gid, uid/gid, saved_uid/gid, fs_uid/gid,
    credential_generation, cap_effective/permitted/inheritable/bounding,
    personality,
    parent_death_signal,
    mount_points: Arc<Mutex<BTreeMap<String, MountPoint>>>,
    // 定时器相关
    posix_timers, real_timer_deadline_us, virtual_timer_deadline_us, prof_timer_deadline_us,
}
```

**fork/clone 实现**：

```rust
// process_lifecycle.rs 核心流程
sys_clone() → 
  1. 检查可用帧数 (≥8192)
  2. 创建新地址空间 (AddrSpace)
  3. clone_user_mappings_from() 或 share_user_mappings_from() (COW/vfork)
  4. 创建新 UserProcess，继承/拷贝父进程属性
  5. 创建新 axtask 任务，注册到 task_registry
  6. 拷贝文件描述符表 (unshare 语义支持)
  7. 设置子进程信号掩码、调度状态等
  8. 返回子进程 TID
```

**execve 实现**：

```
sys_execve() →
  1. 解析路径、处理脚本解释器递归（最多4层）
  2. ELF 加载 → load_program_image() →
     a. 解析 ELF header，验证架构 (EM_RISCV/EM_LOONGARCH)
     b. 映射 LOAD 段到地址空间
     c. 处理 INTERP (动态链接器)
     d. 设置辅助向量 (AT_PHDR, AT_ENTRY, AT_PAGESZ, AT_CLKTCK 等)
     e. 构建用户栈 (argc, argv, envp, auxv)
  3. 设置 UspaceContext (entry point + 用户栈指针)
  4. 更新进程名、exec_path、信号处理等
```

**vfork 特殊处理**：子进程 `share_user_mappings_from()` 共享父进程页表映射（写操作直接可见），父进程阻塞在 `child_exit_wait` 上直到子进程 exec 或 exit。

#### 3.6.3 文件描述符表 (fd_table.rs, 10,094 行)

这是整个项目中最大的单一源文件。

**FdTable 结构**：

```rust
pub struct ProcessFdTable {
    state: AxMutex<ProcessFdTableState>,
}
struct ProcessFdTableState {
    base: FdTable,                    // 基础 fd 表
    unshared: BTreeMap<i32, FdTable>, // unshare 后的独立表
    aliases: BTreeMap<i32, i32>,      // fd 别名
}
```

**FdEntry 支持的文件描述符类型（28 种）**：

```rust
pub enum FdEntry {
    Stdin(u32), Stdout(u32), Stderr(u32),
    DevNull, DevZero(u32), DevRandom(u32), DevCpuDmaLatency(u32),
    BlockDevice(BlockDeviceEntry),
    Rtc,
    File(FileEntry), Directory(DirectoryEntry),
    ProcFdDir(ProcFdDirEntry), SyntheticDir(SyntheticDirEntry),
    Path(PathEntry),
    MemoryFile(MemoryFileEntry), Memfd(MemfdEntry),
    ProcPagemap(ProcPagemapEntry), ProcTimerSlack(ProcTimerSlackEntry),
    Pipe(PipeEndpoint),
    Socket(SocketEntry), LocalSocket(LocalSocketEntry),
    EventFd(EventFdEntry),
    Inotify(InotifyEntry),
    Epoll(EpollEntry),
    TimerFd(TimerFdEntry),
    SignalFd(SignalFdEntry),
    PidFd(PidFdEntry),
    PosixMq(PosixMqDescriptor),
    ProcMqQueuesMax(ProcMqQueuesMaxEntry),
    ProcSysFile(ProcSysFileEntry),
}
```

**关键实现**：
- **大文件稀疏覆盖**：超过 `MAX_PHYSICAL_FILE_BACKING_SIZE`（64KB 即一个 IO chunk）的文件数据通过 `path_sparse_data` 存储为 `Vec<(offset, Vec<u8>)>` 的块列表
- **epoll**：支持 `EPOLLIN/OUT/ERR/ET/ONESHOT`，最多 5 层嵌套深度，`epoll_pwait` 超时精度处理（纯测量调用不计入 syscall 运行时统计）
- **eventfd/timerfd/signalfd**：完整实现，包括非阻塞语义
- **文件锁 (flock)**：支持 LOCK_SH/LOCK_EX/LOCK_UN，与 POSIX record lock 协同

#### 3.6.4 信号系统 (signal_abi.rs, 1,733 行)

**信号集表示**：`u64` 位掩码，支持信号 1-64。

**信号处理流程**：

```
发送信号 (kill/tkill/tgkill) →
  queue_pending_signal_info() → 设置 pending_signal_mask 位
  → 如果目标线程在 sigsuspend/阻塞等待中 → 唤醒
  → 如果信号不被阻塞 → 在下一次 user_return 钩子中投递

信号投递 (deliver_user_signal) →
  1. 读取 sigaction 配置
  2. 在用户栈上构建 sigframe（RISC-V: 含 FP 状态, 共528字节; LoongArch: 基本帧）
  3. 安装 sigtramp 代码（RISC-V: 3条指令; LoongArch: 3条指令）
  4. 设置 sepc/era = sigaction.sa_handler
  5. 设置用户栈指针指向 sigframe 下方

信号返回 (rt_sigreturn) →
  1. 从用户栈 sigframe 恢复寄存器
  2. 恢复信号掩码
  3. 检查是否需要重启被中断的系统调用
```

**特殊信号处理**：
- `SIGKILL`/`SIGSTOP`：不可被阻塞或忽略
- `SIGCHLD`：在子进程退出时自动发送给父进程
- `SIGPIPE`：在向已关闭的管道写入时自动生成
- `SIGSEGV`：缺页异常无法处理时生成
- 同步信号（SIGSEGV/SIGBUS/SIGILL/SIGFPE）通过 `queue_current_synchronous_signal()` 特殊处理

#### 3.6.5 Futex (futex.rs, 471 行)

```rust
pub struct FutexState {
    pub seq: AtomicU32,       // 唤醒序列号（防止丢失唤醒）
    pub queue: WaitQueue,     // 等待队列
}
```

**Futex 键**：由物理帧地址 + 页内偏移组成（`paddr | (uaddr & 0xfff)`），确保跨进程的 MAP_SHARED 区域能正确会合。

**FUTEX_WAIT**：
1. 验证用户地址指向的值等于期望值
2. 计算 futex 键
3. 获取或创建 `FutexState`
4. 阻塞在 `WaitQueue` 上（支持超时：短于 2ms 的自旋等待）

**FUTEX_WAKE**：增加 `seq`，从等待队列唤醒最多 `count` 个等待者（支持 `FUTEX_BITSET` 匹配）。

#### 3.6.6 内存映射 (memory_map.rs, 1,447 行)

支持的 mmap 标志：
- `MAP_SHARED`, `MAP_PRIVATE`, `MAP_FIXED`, `MAP_ANONYMOUS`
- `MAP_POPULATE`, `MAP_NONBLOCK`, `MAP_STACK`, `MAP_GROWSDOWN`
- `MAP_FIXED_NOREPLACE`, `MAP_DENYWRITE`, `MAP_LOCKED`, `MAP_NORESERVE`

**栈增长 (MAP_GROWSDOWN)**：自动在缺页时扩展栈区域（最多到 `USER_STACK_SIZE`=8MB）。

**brk 管理**：通过 `BrkState` 结构跟踪堆的 `start/end/limit`，支持 `brk()`/`sbrk()` 语义。

#### 3.6.7 管道 (fd_pipe.rs, 874 行)

- 环形缓冲区实现，默认容量 64KB，不可信用户限制为 4KB
- 读端/写端引用计数跟踪
- POSIX 兼容的 `O_NONBLOCK` 语义
- `F_SETOWN`/`F_GETOWN` 支持（异步 IO 信号通知）
- SIGPIPE 自动投递

#### 3.6.8 Socket (fd_socket.rs, 2,623 行)

完整的 socket API 桥接层：
- 地址族：AF_INET, AF_INET6, AF_UNIX（本地 socket）
- 类型：SOCK_STREAM, SOCK_DGRAM
- socketpair 支持
- sendmsg/recvmsg 支持（含 SCM_RIGHTS 传递文件描述符）
- getsockopt/setsockopt 覆盖常用选项（SO_REUSEADDR, SO_KEEPALIVE, SO_RCVBUF, SO_SNDBUF, SO_RCVTIMEO, SO_SNDTIMEO, TCP_NODELAY 等）

#### 3.6.9 System V IPC

| IPC 类型 | 文件 | 行数 | 关键特性 |
|----------|------|------|----------|
| **消息队列** | sysv_msg.rs | 642 | msgget/msgsnd/msgrcv/msgctl, 支持 IPC_NOWAIT, MSG_COPY |
| **信号量** | sysv_sem.rs | 764 | semget/semop/semtimedop/semctl, 支持 SEM_UNDO |
| **共享内存** | sysv_shm.rs | 692 | shmget/shmat/shmdt/shmctl, 通过全局分配器分配物理页 |

共享内存的附着/分离直接操作地址空间，支持 SHM_RDONLY 和 SHM_REMAP 标志。

#### 3.6.10 合成文件系统 (synthetic_fs.rs, 1,504 行)

实现了一系列 `/proc` 和 `/sys` 下的合成文件：

- `/proc/self/maps`：生成进程内存映射信息
- `/proc/self/smaps`：详细内存统计（RSS, PSS, 共享/私有页面等）
- `/proc/self/pagemap`：页面映射信息
- `/proc/self/timerslack_ns`：定时器宽松值
- `/proc/{pid}/stat`, `/proc/{pid}/status`：进程状态
- `/proc/{pid}/comm`：进程命令行
- `/proc/{pid}/fd/`：文件描述符目录
- `/proc/sysvipc/{msg,sem,shm}`：SysV IPC 状态
- `/proc/version`：内核版本信息
- `/proc/meminfo`：内存信息
- `/etc/passwd`, `/etc/group`：用户数据库
- `/sys/kernel/...`：内核参数（shmmax, shmmni, shmall 等）

#### 3.6.11 ELF 程序加载器 (program_loader.rs, 1,231 行)

支持：
- ET_EXEC（静态链接）和 ET_DYN（PIE/动态链接）ELF 类型
- RISC-V64 (EM_RISCV = 243) 和 LoongArch64 (EM_LOONGARCH = 258)
- INTERP 段处理（加载动态链接器如 ld-musl-*.so.1 或 ld-linux-*.so.2）
- 脚本解释器（`#!` shebang），最多 4 层递归
- 辅助向量 (AT_PHDR, AT_PHENT, AT_PHNUM, AT_PAGESZ, AT_BASE, AT_ENTRY, AT_CLKTCK, AT_RANDOM, AT_PLATFORM)
- 栈构建（argc, argv, envp, auxv 序列化到用户栈）
- 可执行映像缓存（内存中缓存最近加载的 ELF 映像，最多 24MB 总大小，单个条目最多 4MB）

### 3.7 用户态库 (ulib/)

#### 3.7.1 axlibc

提供 musl-libc 兼容的 C 库，`ulib/axlibc/c/` 目录下约 40 个 C 源文件：

| 类别 | 文件 |
|------|------|
| 基础 | assert.c, ctype.c, locale.c, env.c |
| 字符串 | printf.c (自定义实现), libm.c, math.c, pow.c |
| 文件 IO | fcntl.c, dirent.c, ioctl.c, stdio.c |
| 网络 | network.c, poll.c |
| 内存 | mmap.c, malloc.c (通过 Rust 端桥接) |
| 线程 | pthread.c, sched.c, time.c |
| 动态链接 | dlfcn.c |
| 其他 | glob.c, fnmatch.c, crypt.c, passwd.c 等 |

Rust 侧 (`ulib/axlibc/src/`) 补充了 C 语言不便实现的函数（如 `execve`）。

#### 3.7.2 axstd

Rust 用户态标准库精简版，提供文件系统、网络、线程、同步、IO 等 Rust 风格的 API。用于编写内核内用户态 Rust 程序。

### 3.8 用户程序与测试框架 (user/shell)

#### 3.8.1 交互式 Shell

`user/shell/src/main.rs` 实现了一个基本交互式 shell（`OrayS:$ ` 提示符），支持命令执行和文件系统浏览。

#### 3.8.2 LTP 测试运行器

`user/shell/src/cmd.rs`（3,250 行）实现了完整的 LTP 测试框架：

**测试模式**：
- `busybox`：安装 BusyBox applet 符号链接
- `libc-test`：运行 libc 回归测试
- `ltp_core`：16 个核心 LTP 用例
- `ltp_stable`：约 340+ 个稳定通过用例（硬编码列表）
- `ltp_full`：全量 LTP 扫描
- `unixbench`：UnixBench 基准测试
- `libctest`：glibc 测试套件

**测试基础设施**：
- 测试用例超时控制（默认 300 秒/远程 900 秒上限）
- 内存泄漏检测（帧分配器快照对比）
- 测试结果分类（PASS/FAIL/TIMEOUT/TBROK/TCONF/ENOSYS）
- 黑名单机制（按架构分离：`blacklist-common.txt`, `blacklist-rv.txt`, `blacklist-la.txt`）
- 自动结果汇总（`scripts/ltp_summary.py`）

### 3.9 构建系统

#### 3.9.1 Makefile 架构

核心构建目标：
- `kernel-rv` / `kernel-la`：RISC-V64 / LoongArch64 内核二进制
- `run-rv` / `run-la`：构建并 QEMU 运行
- `all`：构建两个架构的评测版本

关键构建参数：
- `KERNEL_FEATURES = alloc,paging,irq,multitask,fs,net,rtc`
- `KERNEL_APP_FEATURES = auto-run-tests,uspace`
- RISC-V 目标三元组：`riscv64gc-unknown-none-elf`
- LoongArch 目标三元组：`loongarch64-unknown-none-softfloat`

#### 3.9.2 平台配置生成

`scripts/axconfig-gen.py` 从 `configs/platforms/*.toml` 生成 `axconfig` crate 的 Rust 常量（物理内存布局、MMIO 范围、设备地址、定时器频率等）。

#### 3.9.3 测试与合规检查脚本

`scripts/` 目录包含 13 对 `check_g*` / `test_g*` 脚本，针对特定功能点进行静态/动态合规验证：

- `g002`: 假成功检测
- `g003`: stat 元数据正确性
- `g004`: rlimit 文件描述符限制
- `g005`: 运行器解析器正确性
- `g006`: 合成文件系统能力
- `g007`: socket 超时和内存策略
- `g008`: musl 补丁稳定性
- `g009-g010`: 审阅后语义和真实内核语义
- `g011`: 空 shell 检测
- `g012`: 系统调用审阅热点
- `g013`: 用户拷贝边界检查

---

## 四、创新点与技术亮点

### 4.1 基于 ArceOS 的 Linux 兼容方案

OrayS 的核心创新在于：在一个组件化的 Unikernel 风格内核（ArceOS）之上，完整构建了 Linux 用户态 ABI 兼容层。这不同于传统的 Linux 内核移植，而是在保有 ArceOS 轻量化、模块化优势的同时实现了 Linux 二进制兼容。

### 4.2 细粒度进程属性建模

`UserProcess` 结构包含超过 50 个字段，精确建模了 Linux 进程的几乎所有可观测属性：
- 用户/组凭证（8 个 UID/GID 字段）
- 能力集（4 个 64 位掩码）
- 资源限制、调度策略、nice 值、IO 优先级
- 文件系统命名空间（cwd, fs_root, exec_root）
- 挂载点表、符号链接表、文件元数据覆盖表
- 信号处理器表、itimers、POSIX 定时器
- 内存锁记账

### 4.3 虚拟文件系统元数据层

`UserProcess` 中维护了完整的 per-process 虚拟文件系统元数据：

```rust
path_modes: Mutex<BTreeMap<String, u32>>,        // 文件权限
path_inodes: Mutex<BTreeMap<String, u64>>,        // inode 编号
path_owners: Mutex<BTreeMap<String, (u32, u32)>>, // 所有者
path_symlinks: Mutex<BTreeMap<String, String>>,    // 符号链接
path_hardlinks: Mutex<BTreeMap<String, String>>,   // 硬链接
path_xattrs: Mutex<BTreeMap<String, BTreeMap<String, Vec<u8>>>>, // 扩展属性
path_times: Mutex<BTreeMap<String, PathTimes>>,    // 时间戳
path_sparse_data: ...                               // 稀疏文件数据
```

这使得 LTP 测试中大量的 stat/chmod/chown/getxattr 操作无需真实文件系统支持即可正确返回期望结果。

### 4.4 COW Fork 实现

在独立页表管理的基础上实现了完整的写时复制 fork：
- 父子进程共享物理页，均标记为只读
- 缺页异常处理中识别 COW 页面，分配新帧并拷贝
- 全局共享帧引用计数追踪
- 支持 vfork 优化（直接共享而非 COW）

### 4.5 精细的系统调用运行时统计

系统调用分发器中实现了复杂的运行时统计策略：
- 纯测量系统调用（clock_gettime, gettimeofday, getrusage）不计入系统 CPU 时间
- 立即返回的 epoll 探测（timeout=0）不计入统计
- 阻塞系统调用正确记账
- 信号中断后的系统调用重启帧管理

### 4.6 EXT4 只读缓存系统

为只读 EXT4 实现了三级缓存（元数据/数据/目录），使用观测计数二次机会策略决定缓存与否，有效加速 LTP 测试中大量重复的 stat/open/readdir 操作。

### 4.7 多架构信号栈帧

RISC-V64 实现了完整的 `sigframe` 布局（含 FP 状态帧 528 字节），LoongArch64 实现了基本信号栈帧，两者均通过内联的 `sigtramp` 代码（3 条机器指令）实现信号返回。

---

## 五、实现完整度评估

### 5.1 内核核心（以 ArceOS 为基准）

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 硬件抽象层 | 90% | 4 种架构支持，RISC-V/LoongArch 用户态完整 |
| 内存管理 | 85% | TLSF+位图双层分配器，COW，按需分页，缺 huge page 支持 |
| 任务调度 | 85% | CFS/FIFO/RR 三种策略，SMP 支持，缺负载均衡 |
| 文件系统 | 80% | VFS + FAT(RW) + EXT4(RO) + ramfs/devfs/procfs/sysfs |
| 网络栈 | 75% | TCP/UDP (smoltcp)，缺 IPv6 片段重组等高级特性 |

### 5.2 Linux ABI 兼容层

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 系统调用覆盖 | 80% | 约 231 个 syscall，覆盖主要 POSIX 接口 |
| 进程管理 | 85% | fork/vfork/clone/execve/wait 完整，缺 cgroups |
| 文件 IO | 90% | 完整 POSIX 文件操作，含 scatter/gather IO |
| 内存管理 | 80% | mmap/mprotect/brk 完整，缺 huge page, NUMA |
| 信号 | 85% | 完整 POSIX 实时信号，含 sigaltstack |
| IPC | 85% | pipe, futex, SysV 三件套, POSIX 消息队列 |
| Socket | 80% | TCP/UDP/AF_UNIX，含 sendmsg/recvmsg, SCM_RIGHTS |
| IO 多路复用 | 85% | epoll/select/ppoll/pselect6，含超时精度优化 |
| 时间 | 90% | 完整 POSIX 时钟和定时器接口 |
| 调度 | 80% | 完整 sched_* 接口，nice, ioprio |
| 凭证管理 | 90% | 完整 UID/GID 模型和能力集 |

### 5.3 LTP 通过率

从 `LTP_STABLE_CASES` 硬编码列表统计，约 **340+ 个稳定通过的 LTP 用例**（按架构可能有差异）：

核心类别覆盖：文件操作 (open/read/write/lseek/dup/fcntl)、进程管理 (fork/clone/execve/wait/exit)、信号 (sigaction/sigprocmask/sigsuspend/kill)、内存 (mmap/brk/mlock)、调度 (sched_*)、凭证 (setuid/setgid/setgroups)、IPC (pipe/pipe2)、时间 (clock_gettime/nanosleep/alarm/times)、系统信息 (uname/sysinfo/getrusage)。

---

## 六、子系统交互关系

### 6.1 系统调用处理全链路

```
用户程序 (ecall/syscall指令)
  → 硬件 trap
  → axcpu trap.S 汇编保存上下文
  → riscv_trap_handler / loongarch64_trap_handler
  → handle_syscall(tf, syscall_num)
  → SYSCALL[0] (通过 linkme 注册)
  → syscall_dispatch.rs: syscall_handler()
  → 匹配 syscall_num 到具体处理函数
    → fd_table.rs: sys_openat/sys_read/sys_write/...
    → process_lifecycle.rs: sys_clone/sys_execve/...
    → memory_map.rs: sys_mmap/sys_mprotect/...
    → signal_abi.rs: sys_rt_sigaction/sys_kill/...
    → futex.rs: sys_futex
    → ...
  → 返回 isize 结果
  → 写入 tf.regs.a0
  → handle_user_return() 信号投递/系统调用重启检查
  → sret/ertn 返回用户态
```

### 6.2 缺页异常处理链路

```
用户程序访问未映射地址
  → 硬件缺页异常
  → handle_page_fault(tf, flags, is_user=true)
  → user_page_fault() (通过 linkme 注册)
  → AddrSpace::handle_page_fault(vaddr, flags)
    → 查找匹配的 MemoryArea
    → Backend::map_alloc: 分配物理帧并建立映射
    → 或 Backend 的 COW 处理: 分配新帧，拷贝数据
  → 如果处理失败 → queue_current_synchronous_signal(SIGSEGV)
```

### 6.3 进程间关系

```
UserProcess (PID=100)
├── 地址空间 (AddrSpace, 可能通过 COW 共享)
├── 文件描述符表 (ProcessFdTable, Arc 共享)
│   └── 可能在 clone(CLONE_FILES) 时与子进程共享
├── 子进程列表 (children: Vec<ChildTask>)
│   ├── ChildTask { pid: 101, wait_queue, exit_code }
│   └── ChildTask { pid: 102, ... }
├── 挂载点表 (Arc<Mutex<BTreeMap<String, MountPoint>>>)
└── 信号处理器 (signal_actions)
```

---

## 七、总结

OrayS 是一个基于 ArceOS 组件化内核框架构建的、面向 OS 内核比赛的 Linux 兼容操作系统内核。项目在 ArceOS 轻量化的硬件抽象、内存管理、任务调度、文件系统和网络栈之上，通过 `user/shell/src/uspace/` 中约 37,000 行精心编写的 Rust 代码，构建了全面的 Linux 用户态 ABI 兼容层。

**主要技术成就**：

1. **231+ Linux 系统调用实现**，覆盖文件 IO、进程管理、内存管理、信号、IPC、网络、时间、调度等主要类别。

2. **完整的进程模型**：支持 fork/vfork/clone (含 COW)、execve (含脚本解释器和 PIE)、wait4/waitid、exit/exit_group。

3. **丰富的文件描述符抽象**：28 种不同的 `FdEntry` 变体，覆盖普通文件、目录、管道、socket、epoll、eventfd、timerfd、signalfd、memfd、inotify 等。

4. **POSIX 信号系统**：实时信号（1-64）、sigaction/sigprocmask/sigsuspend/rt_sigreturn、sigaltstack、系统调用重启。

5. **三种调度策略**：CFS（复用 Linux 内核权重表）、Round-Robin、FIFO，支持 nice 值和实时优先级。

6. **完整的 IPC**：管道、futex、System V 消息队列/信号量/共享内存、POSIX 消息队列。

7. **多架构支持**：RISC-V64（Sv39）和 LoongArch64（LA64），均完成从硬件异常到用户信号投递的完整链路。

8. **EXT4 只读支持**：含三级缓存系统，有效加速测试运行。

9. **合成文件系统**：procfs 和 sysfs 的丰富实现，支持大量 Linux 工具的开箱即用。

10. **完善的测试基础设施**：内嵌 LTP 运行器、超时控制、内存泄漏检测、黑名单管理、结果汇总。

**架构权衡**：项目选择了在 Unikernel 风格的 ArceOS 之上构建 Linux 兼容层，而非直接使用 Linux 内核。这带来了代码量少、结构清晰的优点，但代价是某些 POSIX 语义需要通过虚拟元数据层模拟，而非依赖真实文件系统。这种设计在 OS 内核比赛场景下是合理且高效的——降低复杂度，聚焦核心兼容性。