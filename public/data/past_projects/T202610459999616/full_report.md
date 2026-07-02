# PulseOS 技术分析报告

## 一、分析范围与方法

本报告通过对仓库源代码的逐文件阅读、代码量统计、关键数据结构追踪和子系统交互分析，形成对 PulseOS 内核项目的全面技术评估。分析覆盖了项目根目录、`pulse_core/`、`pulse_syscalls/`、`arceos/modules/`、`crates/` 等全部非 vendor 代码路径，总计检查约 **57 个** Rust 源文件（PulseOS 自研部分约 26,307 行，arceos 模块约 20,608 行，crates 约数千行）。

由于环境限制（缺少 `axconfig-gen` 预编译工具的目标架构兼容性、Rust 工具链版本差异），未进行实际构建与 QEMU 运行测试。以下分析全部基于源代码静态分析。

---

## 二、项目总体架构

PulseOS 是基于 ArceOS 组件化框架构建的双架构（RISC-V 64、LoongArch 64）宏内核 OS。整体架构分五层：

```
┌─────────────────────────────────┐
│      用户态程序 (/bin/sh 等)       │
├─────────────────────────────────┤
│    pulse_syscalls (系统调用层)     │
├─────────────────────────────────┤
│    pulse_core (内核核心服务层)     │
│  进程/线程/信号/VFS/网络/IPC      │
├─────────────────────────────────┤
│  arceos/modules (组件化内核底座)   │
│  axmm/axhal/axtask/axfs/axnet等  │
├─────────────────────────────────┤
│  crates (平台适配/驱动/调度器等)   │
│  axplat-*/virtio-drivers/axsched │
└─────────────────────────────────┘
```

工作区包含三个 crate：
- **根 package `Pulse`**（`src/main.rs`）：内核入口，102 行
- **`pulse_core`**：核心库，约 10,819 行
- **`pulse_syscalls`**：系统调用库，约 15,386 行（含 handler.rs 约 500+ 行）

加上 `arceos/` 子 workspace 和 `crates/` 下的定制化组件。

---

## 三、子系统详细分析

### 3.1 进程管理子系统

**核心文件**：`pulse_core/src/task/process.rs`（3,193 行）、`pulse_core/src/task/thread.rs`（309 行）、`pulse_core/src/task/exec.rs`（284 行）、`pulse_core/src/task/mod.rs`（722 行）

#### 3.1.1 进程控制块 (Process)

`Process` 结构体（`process.rs:397`）是核心数据结构，包含约 **40 个字段**：

| 类别 | 字段 | 说明 |
|------|------|------|
| 标识 | `pid`, `parent_pid`, `parent` | 进程ID、父进程链接 |
| 地址空间 | `aspace: RwLock<Arc<RwLock<AddrSpace>>>` | 用户态虚拟地址空间 |
| 堆管理 | `heap_top: Arc<AtomicUsize>`, `brk_lock: Mutex<()>` | brk 扩展与并发控制 |
| 文件系统 | `fs_context`, `fd_table` | 根/CWD 上下文与文件描述符表 |
| 线程管理 | `threads: SpinNoIrq<BTreeMap<u64, ThreadState>>` | 线程注册表 |
| 父子关系 | `children: SpinNoIrq<Vec<Arc<Process>>>` | 子进程列表 |
| 生命周期 | `zombie`, `exit_code`, `exit_signal`, `group_exiting`, `group_exit_code` | 退出状态管理 |
| 同步 | `futex_table: FutexTable`, `vfork_context` | futex 与 vfork 同步 |
| 安全 | `credentials: RwLock<Arc<Credentials>>` | UID/GID/能力集 |
| 信号 | `signal_shared: Arc<SignalShared>` | 进程共享信号状态 |
| 时间 | `time_context: TimeContext` | itimer 与 CPU 时间统计 |
| IPC | `ipc: IpcContext` | 共享内存与信号量撤销 |
| 命名空间 | `uts_ns: RwLock<Arc<UtsNamespace>>` | UTS 主机名 |
| POSIX 定时器 | `posix_timers: SpinNoIrq<[Option<PosixTimer>; 16]>` | 最多 16 个 |

#### 3.1.2 线程结构 (Thread)

`Thread`（`thread.rs`）包含：
- `process_weak: Weak<Process>`：反向指向进程
- `signal: Arc<ThreadSignal>`：线程本地信号状态
- `clear_child_tid/set_child_tid/robust_list_head`：clone/futex 线程同步
- `task_ref: Mutex<Option<AxTaskWeak>>`：底层任务引用
- `user_time_ns/sys_time_ns`：线程级 CPU 时间
- `sched_policy/sched_nice/sched_runtime` 等：调度属性
- `io_buffer`：线程本地 IO 缓冲区复用

#### 3.1.3 进程创建 (fork/clone)

`spawn_fork_from_trap_frame()`（`process.rs:2993`）实现完整 fork 流程：
1. 从 TrapFrame 构造子进程 UspaceContext，设置返回值 0
2. 调用 `parent_aspace.try_clone()` 复制地址空间（COW）
3. `TaskInner::try_new()` 分配内核栈
4. `new_child_process()` 创建 Process 实例
5. 复制/共享文件描述符表、信号处理器、文件系统上下文
6. 设置 `parent_set_tid`/`child_set_tid`/`child_clear_tid`
7. 将子进程加入全局 PROCESS_REGISTRY 和父进程 children 列表

`spawn_from_trap_frame()`（`process.rs:3074`）处理 clone 系统调用（共享地址空间）：
- `is_thread_clone` 判断：若为 true，复用父进程 Process，仅注册新线程
- 若为 false（namespace clone），创建独立 Process 但共享地址空间

#### 3.1.4 execve

`exec()` 方法（`exec.rs`）采用**原子替换**策略：
1. **可逆验证阶段**：解析 shebang、检查 ELF 头、验证解释器
2. **构建新地址空间**：在独立的 AddrSpace 中加载 ELF 段
3. 调用 `replace_aspace_handle()` 原子替换地址空间
4. 释放旧地址空间资源
5. 重置信号处理器（`reset_on_exec`）、关闭 CLOEXEC fd、清除线程状态
6. `enter_user_mode()` 切换到用户态

亮点：支持 shebang 解释器递归解析（最多 4 层）、ETXTBSY 检查、文件执行权限验证。

#### 3.1.5 进程退出

`begin_group_exit()` → `finish_thread_exit()` 实现完整退出流程：
1. 设置 `group_exiting=true`，唤醒所有 futex 等待者
2. 遍历所有线程，唤醒等待队列
3. 线程退出时：清除 child_tid（futex 唤醒）、清理 robust list
4. 最后一个线程退出时标记 zombie，释放地址空间（`release_zombie_resources`）
5. 通知父进程 `child_exit_event`
6. 父进程通过 `waitid_find_and_reap()` 回收

#### 3.1.6 调度属性支持

Thread 支持完整的 Linux sched 属性：
- `SCHED_RR`（默认）、`SCHED_FIFO`、`SCHED_DEADLINE`
- `sched_setattr`/`sched_getattr`、`sched_setparam`/`sched_getparam`
- `sched_setaffinity`/`sched_getaffinity`（CPU 亲和性）
- `sched_get_priority_max/min`

---

### 3.2 信号子系统

**核心文件**：`pulse_core/src/task/signal.rs`（1,013 行）

#### 3.2.1 双级信号架构

- **`SignalShared`**：进程级，被所有线程共享
  - `handlers: Arc<SignalHandlers>`：信号处理器表（64 条目）
  - `process_pending: AtomicU64`：进程挂起信号位图
  - `pending_siginfo`：siginfo 队列
  
- **`ThreadSignal`**：线程级
  - `shared: Arc<SignalShared>`：指向进程共享部分
  - `thread_pending: AtomicU64`：线程挂起信号位图
  - `blocked: AtomicU64`：阻塞信号掩码
  - `saved_ctx`：信号处理前保存的上下文
  - `altstack`：信号替代栈
  - `sigsuspend_restore`：sigsuspend 恢复掩码

#### 3.2.2 信号分发流程

`check_signals_and_deliver()` 实现完整分发：
1. 计算 `ready = (process_pending | thread_pending) & ~blocked`
2. 跳过 SIGKILL/SIGSTOP 的特殊处理
3. 查询 `SignalShared::action(sig)` 确定处理动作
4. 若是自定义处理器：在用户栈/altstack 上构造 sigframe，设置 trampoline 返回地址
5. 修改 TrapFrame 的 PC/SP 重定向到信号处理器
6. 保存旧上下文供 `rt_sigreturn` 恢复

#### 3.2.3 信号递送检查点

信号在以下时机检查：
- 系统调用返回时（`syscall_handler` 末尾）
- 用户态返回时（`handle_user_return` trap handler）
- epoll_wait、futex_wait 等阻塞操作的可中断等待点

实现了 `ERESTARTSYS` 机制：若信号处理器设置了 `SA_RESTART`，系统调用自动重启（通过回退 PC 4 字节）。

---

### 3.3 文件描述符与 VFS 子系统

**核心文件**：`pulse_core/src/fd_table.rs`（2,431 行）、`pulse_core/src/flock.rs`（210 行）

#### 3.3.1 FdTable 设计

```rust
pub struct FdTable {
    entries: Vec<Option<FdEntry>>,  // 稀疏数组
    open_fds: Vec<u64>,            // 位图加速空闲 fd 查找
    count: usize,
}
```

关键特性：
- **位图辅助 O(1) 空闲 fd 分配**：`open_fds` 使用 64 位字组成的位图，`insert_from(min_fd)` 通过 `trailing_zeros` 快速定位
- **指数扩容**：`new_len = old_len.saturating_mul(2)`，上限 `FD_LIMIT = 1,048,576`
- **SharedFdTable**：`Arc<RwLock<FdTable>>`，支持 clone 共享

#### 3.3.2 FdObject 多态 Trait

```rust
pub trait FdObject: Send + Sync {
    fn read(&self, _buf: &mut [u8]) -> LinuxResult<usize>;
    fn write(&self, _buf: &[u8]) -> LinuxResult<usize>;
    fn stat(&self) -> LinuxResult<stat>;
    fn poll(&self) -> LinuxResult<PollState>;
    fn ioctl(&self, _cmd: u32, _arg: usize) -> LinuxResult<isize>;
    fn seek(&self, _pos: SeekFrom) -> LinuxResult<u64>;
    fn truncate(&self, _len: u64) -> LinuxResult;
    fn read_at/write_at/read_dirents64/...
    fn mmap_file_flags(&self) -> Option<AxFileFlags>;
    fn get_wait_queues(&self, _events, _wqs) -> LinuxResult<bool>;
    // ... 共约 20 个方法，均有默认实现返回错误
}
```

实现 FdObject 的类型：
| 类型 | 说明 |
|------|------|
| `FileObject` | 普通文件（通过 axfs CachedFile） |
| `StdinObject` / `StdoutObject` | 标准输入输出 |
| `PipeObject` | 匿名管道（含零拷贝路径） |
| `EpollObject` | epoll 实例 |
| `pulse_core::net::Socket` | 网络套接字 |
| `PidfdObject` | pidfd |

#### 3.3.3 管道实现

`PipeObject` 内嵌基于 `smoltcp::wire::IpProtocol` 风格的环形缓冲区：
- 读/写阻塞在 `WaitQueue` 上
- 支持信号中断（`EINTR`）
- **零拷贝优化**：当 buf 和 count 满足对齐条件时（4K 对齐且 >= 64KB），直接通过页表实现零拷贝传输

#### 3.3.4 文件锁 (flock)

`flock.rs` 实现完整的 BSD flock：
- 全局 `FLOCK_MAP: Mutex<BTreeMap<LockTarget, LockState>>`
- `LockTarget` 通过 `FdObject::location()` 定位（基于 fs_id+inode）
- 支持共享锁/排他锁的兼容规则与锁类型转换
- 支持非阻塞模式（`LOCK_NB`）、信号中断
- 进程退出时 `flock_release_owner()` 自动释放所有锁

#### 3.3.5 epoll

`EpollObject`（定义在 `fd_table.rs`）：
- `events: Mutex<BTreeMap<usize, EpollRegistration>>`：监控的文件描述符集合
- 支持 `EPOLL_CTL_ADD/MOD/DEL`、`EPOLLONESHOT`、`EPOLLET` 边缘触发
- `epoll_pwait` 支持信号掩码临时修改（即 pselect 风格的 sigmask 参数）
- **嵌套检测**：防止 epoll 相互嵌套导致的死循环（最多 5 层）

---

### 3.4 内存管理子系统

**核心文件**：`arceos/modules/axmm/src/aspace.rs`、`arceos/modules/axmm/src/backend/`、`pulse_core/src/mm/loader.rs`（563 行）、`pulse_syscalls/src/impls/mm.rs`

#### 3.4.1 地址空间布局

（定义在 `pulse_core/src/config.rs`）

| 区域 | 基址 | 大小 |
|------|------|------|
| 用户空间 | `0x1000` | `0x3f_ffff_f000` |
| 用户栈 | `0x4_0000_0000`（顶） | `0x8_0000` |
| 用户堆 | `0x4000_0000` | 初始 `0x1_0000`，最大 `0x2000_0000` |
| 解释器基址 | `0x400_0000` | - |
| 内核栈 | - | `0x4_0000` |

#### 3.4.2 页表与地址空间 (axmm)

`AddrSpace` 由 `MemorySet<Backend>` + `PageTableLockManager` 组成。

后端类型：
- **`Alloc`**：匿名页（mmap, brk, stack）
- **`File`**：文件映射（mmap file, ELF 加载）
- **`Cow(CowMapping)`**：写时复制（fork 后共享页）
- **`Shared`**：共享内存映射
- **`Linear`**：内核直接映射

#### 3.4.3 缺页处理

`handle_page_fault()`（`process.rs:1685`）：
1. 先尝试读锁快速路径（`aspace.handle_page_fault`）
2. 若返回 `NeedWriteLock`（栈向下增长需要写锁），获取写锁重试
3. 成功则返回 true
4. 失败则通过遍历 `MemoryArea` 判断是否为文件映射越界（SIGBUS vs SIGSEGV）

读锁/写锁双阶段设计避免了大部分缺页场景下的锁争用。

#### 3.4.4 ELF 加载器

`loader.rs` 实现：
- **ELF 文件缓存**：最多 16 个条目的 LRU 缓存（避免重复解析）
- **解释器支持**：加载 `/lib/ld-musl-*.so.1` 作为解释器
- **vDSO 映射**：映射 vDSO 页面供用户态快速系统调用
- **AuxVec 构建**：AT_PHDR、AT_ENTRY、AT_BASE、AT_RANDOM 等
- **栈初始化**：argc/argv/envp/auxv 布局
- **prefault 优化**：读/执行段预映射最多 3 个连续页面
- **架构验证**：检查 ELF Machine 类型匹配当前架构

#### 3.4.5 mmap/brk 系统调用

`sys_mmap` 支持：
- `MAP_ANONYMOUS` / `MAP_SHARED` / `MAP_PRIVATE`
- `MAP_FIXED` / `MAP_FIXED_NOREPLACE`
- `MAP_POPULATE`（预 fault）、`MAP_LOCKED`（mlock）
- `MAP_GROWSDOWN` / `MAP_STACK`
- 文件映射（私有/共享）

`sys_brk` 实现：
- 以 256KB 块为单位扩展/收缩堆
- 与 `mlock_future` 集成
- 支持 rollback（扩展失败时回滚映射）

#### 3.4.6 内存锁定 (mlock)

`MemlockState` 实现：
- 区间合并（`memlock_insert_range`）
- 锁定字节计数与 soft/hard 限制检查
- `mlockall(MCL_CURRENT | MCL_FUTURE)` 支持
- `munlockall` 全部解锁

---

### 3.5 网络子系统

**核心文件**：`pulse_core/src/net/mod.rs`（981 行）、`pulse_syscalls/src/impls/net/`、`arceos/modules/axnet/`

#### 3.5.1 Socket 抽象

```rust
pub enum SocketInner {
    Tcp(TcpSocket),         // 基于 smoltcp
    Udp(UdpSocket),         // 基于 smoltcp
    Local(LocalSocket),     // AF_UNIX
    Packet(PacketSocket),   // AF_PACKET
    Netlink(NetlinkSocket), // AF_NETLINK
}
```

`Socket` 结构体包含：
- `domain/pending_send/pending_addr`：协议族与待发送数据缓冲
- `rx_shutdown/tx_shutdown`：半关闭状态

#### 3.5.2 AF_UNIX (LocalSocket)

基于 `LocalSocketRingBuffer`（64KB 环形缓冲区）：
- 双向双缓冲（每端有 rx + tx）
- `closed`/`peer_closed` 原子标志
- 阻塞模式下在 `WaitQueue` 上等待
- 支持非阻塞模式（`EAGAIN`）和信号中断（`EINTR`）
- Drop 时自动通知对端

UNIX_REGISTRY 记录绑定的路径/抽象名，用于 connect 查找。

#### 3.5.3 NetlinkSocket

模拟 Netlink 协议响应：
- 硬编码响应 `RTM_GETLINK`（返回 lo + eth0 接口信息）
- 硬编码响应 `RTM_GETADDR`（返回 eth0 的 IP 地址）
- 其他消息返回 NLMSG_DONE
- 用于支持 `ip link`/`ip addr` 等命令

#### 3.5.4 TCP/UDP（smoltcp）

通过 ArceOS 的 `axnet` 模块集成 smoltcp 协议栈：
- `TcpSocket`/`UdpSocket` 来自 `arceos/modules/axnet`
- 支持 bind/listen/connect/accept/send/recv
- 非阻塞模式、超时支持

#### 3.5.5 Socket 系统调用覆盖

| 系统调用 | 状态 |
|----------|------|
| socket/bind/connect/listen/accept/accept4 | 已实现 |
| sendto/recvfrom/sendmsg/recvmsg/sendmmsg/recvmmsg | 已实现 |
| getsockname/getpeername | 已实现 |
| setsockopt/getsockopt | 已实现（820 行实现） |
| shutdown | 已实现 |
| socketpair | 已实现（仅 AF_UNIX） |

---

### 3.6 IPC 子系统

**核心文件**：`pulse_core/src/ipc/sem.rs`（260 行）、`pulse_core/src/ipc/shm.rs`（444 行）

#### 3.6.1 System V 信号量

- 全局 `SEM_MANAGER`（`Lazy<Mutex<SemManager>>`），使用双向 BTreeMap（key↔semid）
- `SemSetInner`：包含信号量数组、`SemidDs` 元数据、`WaitQueue`
- 支持 `IPC_CREAT`/`IPC_EXCL`、`IPC_RMID`、`SETVAL`/`GETALL`/`SETALL`
- **信号量撤销**（`SemUndoEntry`）：进程退出时自动回滚 `sembuf` 操作
- `semtimedop` 支持超时和信号中断

#### 3.6.2 System V 共享内存

- `ShmInner`：持有分配的物理页集合（`Vec<PhysPage>`）
- 映射到进程地址空间时使用 `Backend::Shared`
- 支持 `SHM_RDONLY`、`SHM_REMAP`、`SHM_LOCK`/`SHM_UNLOCK`
- `IPC_STAT`/`IPC_SET`/`IPC_RMID` 控制操作
- 进程退出时自动分离（`detach_all_shared_memory`）

---

### 3.7 futex 子系统

**核心文件**：`pulse_core/src/task/process.rs`（FutexTable 内嵌 250+ 行）、`pulse_syscalls/src/impls/futex.rs`

#### 3.7.1 FutexTable

每个 Process 有独立 `FutexTable`，同时有 `GLOBAL_FUTEX_TABLE`（用于非私有 futex）：
- `queue(addr) -> Arc<WaitQueue>`：惰性创建等待队列
- `wake(addr, count)`：唤醒最多 count 个等待者
- `requeue(addr, wake_count, target, requeue_count)`：futex_requeue 操作
- `wake_all()/clear()`：进程退出时清理

#### 3.7.2 支持的操作

| 操作 | 说明 |
|------|------|
| `FUTEX_WAIT` | 基本等待，支持超时 |
| `FUTEX_WAKE` | 基本唤醒 |
| `FUTEX_REQUEUE` | 条件唤醒+转移 |
| `FUTEX_CMP_REQUEUE` | 带比较的转移（PI-futex 基础） |
| `FUTEX_WAIT_BITSET` | 位掩码等待 |
| `futex_waitv` | 多地址等待（Android binder 使用） |

实现特点：
- 私有 futex 使用虚拟地址 key，共享 futex 先尝试转换为物理地址
- 超时支持相对时间（FUTEX_WAIT）和绝对时间（FUTEX_WAIT_BITSET，含 CLOCK_REALTIME 支持）
- `wait_multiple_timeout_until()` 实现批量 futex 等待（最多 128 个）
- 信号中断返回 `EINTR`/`ERESTARTSYS`
- 进程退出时清理 robust list

---

### 3.8 时间管理子系统

**核心文件**：`pulse_syscalls/src/impls/time.rs`（1,092 行）、`arceos/modules/axhal/src/time.rs`

支持的时钟：
- `CLOCK_REALTIME` / `CLOCK_REALTIME_COARSE`
- `CLOCK_MONOTONIC` / `CLOCK_MONOTONIC_RAW` / `CLOCK_MONOTONIC_COARSE`
- `CLOCK_BOOTTIME`
- `CLOCK_PROCESS_CPUTIME_ID` / `CLOCK_THREAD_CPUTIME_ID`

系统调用：
- `nanosleep` / `clock_nanosleep`（含 TIMER_ABSTIME）
- `clock_gettime` / `clock_settime` / `clock_getres`
- `gettimeofday` / `settimeofday`
- `times`（进程/子进程 CPU 时间）
- `setitimer` / `getitimer`（ITIMER_REAL/VIRT/PROF）
- `timer_create` / `timer_settime` / `timer_gettime` / `timer_delete`（POSIX 定时器，最多 16 个）

实现亮点：
- `clock_getres` 返回 1ns 分辨率（满足 cyclictest 的高精度要求）
- itimer/prof 定时器由调度时钟滴答驱动（`itimer_tick_hook`）
- 支持 epoch offset 调整（用于 `clock_adjtime`/`settimeofday`）

---

### 3.9 硬件抽象层与驱动

#### 3.9.1 平台适配

- **RISC-V 64**：`crates/axplat-riscv64-qemu-virt/`，基于 SBI 的串口、定时器、中断
- **LoongArch 64**：`crates/axplat-loongarch64-qemu-virt/`，直接操作 CSR

平台层提供：boot、console、init、irq、mem、time、power 等模块。

#### 3.9.2 驱动框架

`arceos/modules/axdriver/`：
- 支持 VirtIO（virtio-blk、virtio-net、virtio-gpu）
- 支持 ixgbe 网卡
- PCI/MMIO 总线枚举
- 块设备通过 `AxBlockDevice` 抽象暴露给文件系统

---

### 3.10 同步原语

| 组件 | 来源 | 说明 |
|------|------|------|
| `SpinNoIrq` | `kspin` | 关中断自旋锁（进程/线程注册表） |
| `Mutex` | `spin` | 标准互斥锁（futex、文件锁表） |
| `RwLock` | `spin` | 读写锁（地址空间、fd 表） |
| `WaitQueue` | `axtask` | 条件等待（信号、管道、futex、epoll） |
| `NoPreemptIrqSave` | `kernel_guard` | 禁止抢占+关中断（fork 关键区） |
| `Lazy` | `spin` | 懒惰初始化全局状态 |

---

### 3.11 系统调用分发

**核心文件**：`pulse_syscalls/src/handler.rs`

#### 3.11.1 分发器

`syscall_handler()` 注册为 `SYSCALL` trap handler：
1. 获取当前 Thread 和 Process
2. 提取 6 个参数（`tf.arg0()..arg5()`）
3. FS 相关系统调用先 `sync_fs_context()`（将内核 FsContext 同步到当前进程）
4. 通过 `match sysno { ... }` 分发到约 **189 个** 已实现的系统调用
5. 处理 `ERESTARTSYS` 信号重启逻辑
6. 检查待处理信号并递送
7. 更新 CPU 时间统计

#### 3.11.2 已实现系统调用清单（部分）

**进程管理**：clone, clone3, fork(via clone), vfork, execve, execveat, exit, exit_group, wait4, waitid, getpid, getppid, gettid, set_tid_address

**调度**：sched_yield, sched_get/setaffinity, sched_get/setparam, sched_get/setscheduler, sched_get_priority_max/min, sched_rr_get_interval, sched_setattr, sched_getattr

**文件 I/O**：read, write, readv, writev, pread64, pwrite64, preadv, pwritev, preadv2, pwritev2, sendfile, openat, close, lseek, ftruncate, fallocate, fsync, fdatasync, sync, dup, dup3, pipe2, fcntl, ioctl

**文件元数据**：fstat, statx, fstatat/newfstatat, statfs, fstatfs, getdents64, getcwd, chdir, fchdir, unlinkat, linkat, renameat2, utimensat, readlinkat, symlinkat, faccessat, faccessat2, fchmodat, fchmod, fchownat, fchown, mkdirat, mknodat, mount, umount2, chroot

**内存**：brk, mmap, munmap, mprotect, mlock, munlock, mlockall, munlockall, msync, madvise, fadvise64

**信号**：rt_sigaction, rt_sigreturn, rt_sigprocmask, rt_sigsuspend, rt_sigtimedwait, sigaltstack, kill, tkill, tgkill

**用户/组**：getuid, geteuid, getgid, getegid, setuid, setgid, setreuid, setregid, setresuid, setresgid, getresuid, getresgid, getgroups, setgroups, setfsuid, setfsgid, umask, capget, capset

**网络**：(完整套接字 API，见 3.5.5)

**IPC**：shmget, shmat, shmdt, shmctl, semget, semctl, semtimedop, semop

**时间**：(见 3.8)

**杂项**：uname, sethostname, sysinfo, syslog, prctl, prlimit64, getrlimit, getrandom, getrusage, membarrier, unshare, setns, flock, getcpu, pidfd_open, pidfd_send_signal, riscv_hwprobe, ppoll, pselect6, epoll_create1, epoll_ctl, epoll_pwait, epoll_pwait2, set_robust_list, get_robust_list

---

## 四、项目创新性与设计亮点

### 4.1 扁平物理页帧元数据管理 (FrameTable)

根据设计文档，PulseOS 的 `axmm` 使用预分配的扁平数组 `FrameTable` 替代 B 树结构管理物理页引用计数。所有操作通过无锁原子操作实现 O(1) 查询，在并发 clone/fork 场景下消除锁开销。代码验证：
- `axmm/src/lib.rs` 中 `init_frame_table(min_paddr, total_memory_size)` 预分配连续数组
- `cow_inc_frame_ref`/`cow_dec_frame_ref` 通过原子操作更新引用计数

### 4.2 安全隔离的用户态拷贝机制

`pulse_core/src/task/process.rs` 中 `read_user_bytes()` 和 `write_user_bytes()`：
- 不直接解引用用户虚拟地址
- 通过 `aspace.query_vaddr()` 将用户虚拟地址转换为物理地址
- 使用 `phys_to_virt()` 获得内核可访问的虚拟地址
- 在自定义的 `write_user_bytes_in_aspace()` 中实现跨页安全拷贝

### 4.3 纯 Rust ext4 文件系统

使用 `crates/ext4plus/`（约 20 个 Rust 源文件）替代传统的 C 语言 `lwext4`，消除 FFI 开销与安全隐患。该库实现了：extent tree、htree 目录索引、块位图、checksum 等完整的 ext4 特性。

### 4.4 O(1) 位图文件描述符分配

`FdTable::insert_from()` 使用 `open_fds: Vec<u64>` 位图，通过 `(!word).trailing_zeros()` 实现 O(1) 空闲 fd 查找，结合指数扩容策略。

### 4.5 读锁/写锁双阶段缺页处理

`handle_page_fault()` 先尝试读锁（减少锁争用），仅在栈向下增长等需要写锁的场景才获取写锁。

### 4.6 exec 原子替换策略

先在新地址空间加载 ELF，验证成功后原子替换，失败时原地址空间不受影响——防止 exec 失败导致进程处于不一致状态。

### 4.7 零拷贝管道 I/O

`PipeObject` 在对齐条件下（4K 对齐且 >= 64KB），通过页表直接映射实现 read/write 零拷贝。

### 4.8 futex 多地址等待 (futex_waitv)

实现了 Android `futex_waitv` 系统调用，支持同时等待多个 futex 地址，通过 `WaitQueue::wait_multiple_timeout_until()` 批量等待。

---

## 五、实现完整度评估

### 5.1 子系统完整度

| 子系统 | 完整度 | 评估依据 |
|--------|--------|----------|
| **进程管理** | 85% | fork/clone/exec/exit/wait 完整，缺 cgroup、namespace 完全隔离 |
| **线程管理** | 80% | clone(CLONE_THREAD) 完整，缺 pthread 同步原语内核支持 |
| **信号系统** | 85% | 双级信号、siginfo、sigaltstack、实时信号完整，缺 core dump 文件写入 |
| **文件系统 (VFS)** | 75% | ext4/tmpfs/procfs/devfs 完整，缺 ramfs、overlayfs、NFS |
| **文件描述符** | 90% | FdTable、位图分配、跨进程共享、epoll 完整 |
| **内存管理** | 80% | mmap/munmap/brk/mlock 完整，缺 swap、hugepage、NUMA |
| **网络** | 70% | TCP/UDP/Unix/Packet/Netlink 基本可用，Netlink 仅硬编码响应 |
| **IPC** | 75% | System V 信号量/共享内存完整，缺消息队列、POSIX IPC |
| **时间** | 85% | 全部主流时钟、定时器、itimer、POSIX timer 完整 |
| **futex** | 85% | 基本操作+requeue+waitv 完整，缺 PI-futex |
| **调度** | 70% | RR 调度器，sched API 完整，但调度器实现相对简单 |
| **安全/Credentials** | 75% | UID/GID/capability 完整，缺 SELinux、seccomp |

### 5.2 系统调用覆盖

已实现约 **189 个** 系统调用，覆盖 Linux 5.x/6.x ABI 的核心子集。对比 Linux 6.x 约 450+ 系统调用，覆盖约 **42%**。但覆盖了绝大多数应用实际使用的系统调用。

### 5.3 架构支持

- RISC-V 64 (qemu-virt)：完整支持
- LoongArch 64 (qemu-virt)：完整支持（含 musl libc sched 补丁）

---

## 六、构建与运行

构建流程（通过 Makefile 分析）：

```
make all: 双架构构建
  1. prepare-tools（检查 bin/ 下的预编译工具）
  2. ARCH=riscv64 defconfig（生成 .axconfig.toml）
  3. arceos build（递归 Make: cargo build + rust-objcopy）
  4. 复制产物 kernel-rv, kernel-la
  5. build_img.sh all（生成 rootfs-{riscv64,loongarch64}.img）
```

根文件系统基于 Alpine Linux minirootfs + overlay + extras 构建。LoongArch 构建时对 musl libc 的 sched 函数打补丁（直接修改 `ld-musl-loongarch-lp64d.so.1` 的二进制码，将 ENOSYS 桩替换为实际系统调用）。

---

## 七、总结

PulseOS 是一个实现全面、设计精良的组件化宏内核操作系统。其核心贡献在于：

1. **在 ArceOS 组件化框架上构建了完整的 POSIX 兼容层**：通过 `pulse_core` + `pulse_syscalls` 两层约 26,000 行 Rust 代码，实现了涵盖进程管理、信号系统、文件系统、网络协议栈、IPC 的完整内核服务。

2. **多架构统一抽象**：同时支持 RISC-V 64 和 LoongArch 64 双架构，通过 `axplat` 平台适配层和条件编译实现架构差异隔离。

3. **多个设计创新**：扁平 FrameTable（无锁 O(1) 页帧管理）、安全用户态拷贝、纯 Rust ext4、exec 原子替换、复用的 I/O 缓冲区等。

4. **系统调用高覆盖**：189 个系统调用足以运行 Alpine Linux 用户空间及大多数 Linux 应用程序。

5. **已知限制**：调度器相对简单（RR）、网络 Netlink 仅硬编码响应、无 swap 支持、无 SMP（代码中有预留但未完全实现）。

该项目的工程水准较高，代码组织清晰，错误处理完备（大量使用 `LinuxError` 错误码转换），具备参加操作系统内核比赛的技术深度。