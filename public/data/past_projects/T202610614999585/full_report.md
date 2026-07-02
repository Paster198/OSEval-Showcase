# Starry OS 内核项目深度技术报告

## 一、分析方法与测试结果

### 1.1 分析方法

本次分析采用以下方法对项目进行全面审查：

1. **源代码静态分析**：逐文件审查了约 170 个非 vendor Rust 源文件（约 46,200 行代码），重点关注核心逻辑、数据结构、系统调用路径和子系统间交互。
2. **构建系统分析**：审阅了 Makefile、Cargo.toml（workspace）、平台配置生成流程，以及 arceos 子模块的集成方式。
3. **架构对比分析**：对比了 riscv64、loongarch64、aarch64、x86_64 四条架构线的差异实现。
4. **测试套件审查**：分析了 init.sh 启动脚本、LTP 测试用例列表（rv_case / la_case）、以及 auto-test 自动化测试脚本。

### 1.2 测试结果

由于当前环境缺少完整的 RISC-V 和 LoongArch 交叉编译工具链中所需的 `libgcc_s.so.1` 以及 ext4 测试磁盘镜像，未能进行内核的实际构建与 QEMU 运行测试。项目设计为在 Docker 容器（`zhouzhouyi/os-contest:20260510`）内完成构建和测试。根据 init.sh 脚本内容可确认其支持以下测试集：

| 测试集 | 类型 | 覆盖范围 |
|--------|------|---------|
| LTP (Linux Test Project) | 系统调用正确性 | 数百个 syscall 级别的回归测试 |
| busybox | 用户态工具集 | sh、ls、cp 等标准 Unix 工具 |
| iperf | 网络性能 | TCP/UDP 吞吐量基准 |
| netperf | 网络性能 | TCP_STREAM、UDP_STREAM、TCP_RR 等 |
| iozone | 文件 I/O 性能 | 读写/随机/顺序等多种模式 |
| lmbench | 微基准性能 | 上下文切换、内存延迟、管道等 |
| cyclictest | 实时性 | NO_STRESS 段延迟测试 |
| libctest | libc 功能 | C 库接口一致性 |

---

## 二、总体架构分析

### 2.1 分层架构

Starry OS 采用四层架构模型：

```
┌──────────────────────────────────────────────────────┐
│  src/         内核入口、syscall 分发、init 脚本执行    │
├──────────────────────────────────────────────────────┤
│  starry-api    POSIX 系统调用实现层（约 8,000 行）     │
├──────────────────────────────────────────────────────┤
│  starry-core   内核核心服务层（约 2,500 行）           │
├──────────────────────────────────────────────────────┤
│  arceos/       ArceOS 运行基座（约 37,300 行）        │
│  ├── axhal     硬件抽象层                             │
│  ├── axmm      内存管理                               │
│  ├── axtask    任务调度                               │
│  ├── axnet     网络协议栈（smoltcp）                   │
│  ├── axfs-ng   文件系统（FAT/ext4）                   │
│  ├── axdriver  设备驱动（virtio/PCI/MMIO/ixgbe）       │
│  ├── axalloc   全局内存分配器                          │
│  └── axruntime 启动流程                               │
└──────────────────────────────────────────────────────┘
```

### 2.2 关键外部依赖

| 依赖 | 来源 | 作用 |
|------|------|------|
| `axprocess` | `github.com/Starry-Mix-THU/axprocess.git` | 进程/线程模型（Process、Thread、ProcessGroup、Session） |
| `axsignal` | `github.com/Starry-Mix-THU/axsignal.git`（vendored） | 信号机制的底层实现 |
| `axfs-ng-vfs` | `github.com/Starry-Mix-THU/axfs-ng-vfs` | 虚拟文件系统框架（Filesystem、Location、DirEntry trait） |
| `syscalls` | `github.com/jasonwhite/syscalls.git` | `Sysno` 枚举（系统调用号定义） |
| `kernel_elf_parser` | crate | ELF 加载解析 |
| `smoltcp` | crates.io（通过 axnet） | TCP/IP 协议栈 |

---

## 三、子系统详细拆解

### 3.1 内存管理子系统 (Memory Management)

#### 3.1.1 实现架构

内存管理分三层：

| 层 | 位置 | 职责 |
|----|------|------|
| 地址空间层 | `arceos/modules/axmm/src/aspace.rs`（769行） | `AddrSpace`：管理虚拟地址区域(VMA)、页表映射、COW |
| 物理内存层 | `arceos/modules/axalloc/src/lib.rs`（322行） | Slab 分配器 + 页帧分配器 |
| 用户态接口层 | `api/src/imp/mm/` （mmap.rs 1000行, brk.rs） | mmap/munmap/mprotect/brk/mlock 系统调用 |

#### 3.1.2 地址空间结构

用户地址空间布局（以 riscv64 为例，定义于 `config/src/riscv64.rs`）：

```
USER_SPACE_BASE  = 0x0000_0000_0000_1000  （页0保留）
USER_INTERP_BASE = 0x0000_0000_0400_0000  （解释器基址）
SIGNAL_TRAMPOLINE= 0x0000_0000_4001_0000  （信号跳板页）
USER_HEAP_BASE   = 0x0000_0000_4000_0000  （堆基址，初始 64KB）
USER_STACK_TOP   = 0x0000_0004_0000_0000  （栈顶，向下增长 512KB）
USER_SPACE_SIZE  = 0x0000_003F_FFFF_F000  （总用户空间 ~256GB）
```

地址空间核心操作通过 `AddrSpace` 类型完成，关键方法：
- `new_empty(base, size)` — 创建空地址空间
- `map_alloc(vaddr, size, flags, populate, page_size)` — 匿名映射
- `map_shared(vaddr, size, flags, shared_pages, page_size)` — 共享页映射（COW 共享）
- `handle_page_fault(vaddr, access_flags)` — 按需分页和 COW 处理
- `try_clone()` — fork 时的地址空间复制（支持 COW 优化）

#### 3.1.3 ELF 加载与缓存机制

ELF 加载位于 `core/src/mm.rs`（365行），实现了复杂的多级缓存策略：

**a) ELF 文件数据缓存** (`CACHED_ELF`)：
```rust
static CACHED_ELF: RwLock<BTreeMap<usize, Arc<ElfFile>>> = RwLock::new(BTreeMap::new());
```
以文件路径在 VFS 中的 entry 指针为键，缓存已解析的 `ElfFile` 结构。在 `main()` 中预缓存了常用 ELF（busybox、libc.so、ld-linux、libm、libgcc_s），避免每次 exec 时重新从磁盘读取和解析。

**b) Text 段物理页缓存** (`TEXT_PAGE_CACHE`)：
```rust
static TEXT_PAGE_CACHE: RwLock<BTreeMap<(u64, u64, usize, usize), Arc<SharedPages>>> =
    RwLock::new(BTreeMap::new());
```
以 `(device, inode, segment_offset, segment_size)` 为键的共享物理页缓存。当多个进程映射同一个 ELF 的只读 text 段时，它们共享同一组物理页面。通过 `/proc/sys/vm/text_page_cache` 开关控制（仅在 `fs_bind*` 测试组中启用）。

**c) Shebang 解释器支持**：
```rust
if file_data.starts_with(b"#!") {
    // 解析 shebang 行，提取解释器路径和参数
    let head = &file_data[2..file_data.len().min(256)];
    // ...
}
```
支持 `#!` 脚本解释器间接调用。对于 `.sh` 文件，自动转为 `/bin/sh` 调用。

#### 3.1.4 mmap 实现

`api/src/imp/mm/mmap.rs`（1000行）实现了完整的 mmap 系统调用族：

- `sys_mmap` / `sys_munmap` / `sys_mprotect` / `sys_msync`
- `MAP_SHARED` / `MAP_PRIVATE` / `MAP_ANONYMOUS` / `MAP_FIXED` / `MAP_POPULATE` / `MAP_GROWSDOWN`
- 文件映射的后备页缓存（`SHARED_FILE_PAGE_CACHE`）：以 `(device, inode, generation, offset, length, page_size)` 为键
- `MADV_DONTDUMP` / `MADV_DODUMP` / `MADV_WIPEONFORK` / `MADV_FREE` / `MADV_DONTNEED`
- `mlock` / `munlock` 系列（通过 `mlock_ranges` 跟踪锁定的地址区间）

#### 3.1.5 实现完整度

| 功能 | 状态 | 备注 |
|------|------|------|
| 按需分页 (demand paging) | 已实现 | `handle_page_fault` 在 `AddrSpace` 中 |
| COW (Copy-on-Write) | 已实现 | fork 时通过 `try_clone()` 使用共享页 |
| mmap / munmap / mprotect | 已实现 | 含文件映射、匿名映射 |
| brk (堆管理) | 已实现 | 简单线性增长，上限 `USER_HEAP_SIZE` |
| mlock / munlock | 已实现 | 区间跟踪，非实际物理锁定 |
| madvise | 已实现 | DONTDUMP/DODUMP/WIPEONFORK/FREE/DONTNEED |
| ELF 缓存 | 已实现 | 两层缓存（文件+物理页） |
| 栈自动扩展 | 已实现 | 基于 rlimit 检查 |
| huge pages | 未实现 | 无 THP 支持 |
| KSM | 未实现 | - |

---

### 3.2 进程与任务管理子系统 (Process & Task Management)

#### 3.2.1 数据模型

Starry 的任务模型由三层抽象组成：

| 类型 | 来源 | 对应 Linux 概念 |
|------|------|-----------------|
| `TaskInner` (axtask) | arceos | 内核调度实体 |
| `Thread` (axprocess) | 外部 crate | 线程（system-wide unique TID） |
| `Process` (axprocess) | 外部 crate | 进程（PID、子进程列表、进程组、会话） |

扩展数据结构定义在 `core/src/task.rs`：

**`StarryTaskExt`** — 内核任务的扩展数据，实现 `TaskExt` trait：
```rust
pub struct StarryTaskExt {
    pub thread: Arc<Thread>,
}
```
通过 `on_enter` / `on_leave` hook 管理 per-task 资源作用域切换。

**`ThreadData`** — 每个线程的扩展数据（12个字段）：
```rust
pub struct ThreadData {
    task: Arc<Once<WeakAxTaskRef>>,    // 回引到 TaskInner
    pub clear_child_tid: AtomicUsize,  // CLONE_CHILD_CLEARTID
    pub robust_list_head: AtomicUsize, // robust futex 列表头
    pub signal: ThreadSignalManager,    // 线程级信号管理器
    pub current_handler_signo: AtomicU32,
    pub time: AssumeSync<RefCell<TimeManager>>,
    pub futex_bitset: AtomicU32,
    pub oom_score_adj: AtomicI32,
}
```

**`ProcessData`** — 每个进程的扩展数据（22个字段）：
```rust
pub struct ProcessData {
    pub exe_path: RwLock<String>,
    pub aspace: Arc<Mutex<AddrSpace>>,    // 虚拟地址空间
    pub scope: RwLock<Scope>,             // 资源作用域
    heap_bottom: AtomicUsize,             // 堆底
    heap_top: AtomicUsize,                // 堆顶
    pub rlim: RwLock<Rlimits>,            // 资源限制
    pub child_exit_wq: WaitQueue,         // 子进程退出等待队列
    pub stop_wq: WaitQueue,              // SIGSTOP 等待队列
    pub exit_signal: Option<Signo>,       // 退出信号
    pub signal: Arc<ProcessSignalManager>,// 进程级信号管理器
    stopped_signal: AtomicU32,            // 当前停止信号
    stop_report_pending: AtomicBool,      // stop 事件待汇报
    futex_table: FutexTable,              // 进程私有 futex 表
    pub umask: AtomicU32,
    pub uid / euid / suid: AtomicU32,    // 用户 ID
    pub gid / egid / sgid: AtomicU32,    // 组 ID
    pub supplementary_gids: RwLock<Vec<u32>>,
    pub mlock_ranges: RwLock<Vec<(usize, usize)>>,
    pub coredump_filter: AtomicU32,
    pub madvise_dontdump_ranges / dodump_ranges: RwLock<Vec<...>>,
    pub wipe_on_fork_ranges: RwLock<Vec<...>>,
}
```

#### 3.2.2 进程/线程生命周期

**a) 进程创建 (clone/fork)**

`api/src/imp/task/clone.rs` 实现了完整的多功能 clone：

```rust
pub fn sys_clone(tf, flags, stack, parent_tid, child_tid, tls) -> LinuxResult<isize>
```

核心逻辑流程：

1. **标志解析**：解析 `exit_signal`（低8位）和 clone flags，检查语义合法性
   - `CLONE_THREAD` 必须同时带 `CLONE_VM | CLONE_SIGHAND`
   - namespace 标志（`CLONE_NEWNS/NEWUTS/NEWIPC/NEWUSER/NEWPID/NEWNET/NEWCGROUP`）对非特权进程返回 `EPERM`
2. **地址空间处理**：
   - `CLONE_THREAD`：共享地址空间
   - `CLONE_VM`（不含 `CLONE_VFORK`）：共享父进程地址空间
   - 默认（含 `CLONE_VFORK`）：通过 `try_clone()` COW 复制地址空间；失败时触发 tmpfs 回收后重试
3. **信号处理继承**：`CLONE_SIGHAND` 时共享 signal actions，否则深拷贝
4. **文件描述符表**：`CLONE_FILES` 时共享 `FD_TABLE`
5. **特殊标志处理**：
   - `CLONE_CHILD_CLEARTID`：设置 `clear_child_tid` 地址
   - `CLONE_CHILD_SETTID`：在子进程内存写入 TID
   - `CLONE_SETTLS`：设置 TLS 寄存器
   - `CLONE_PARENT_SETTID`：在父进程内存写入子进程 TID
6. **OOM 预防**：每 500 次 fork 主动回收一次 tmpfs（`FORK_RECLAIM_INTERVAL`）

**b) 程序执行 (execve)**

`api/src/imp/task/execve.rs` 的 execve 实现流程：

1. 检查是否为多线程进程（当前不支持，返回 `EAGAIN`）
2. 权限检查：`check_exec_permission()` 实现了 owner/group/other 三级执行权限语义
3. **先构建后替换**：先在新地址空间中加载 ELF 成功，再原子切换页表根
   ```rust
   let mut new_aspace = new_user_aspace_empty()?;
   copy_from_kernel(&mut new_aspace)?;
   map_trampoline(&mut new_aspace)?;
   let (entry_point, user_stack_base) = load_user_app(&mut new_aspace, ...)?;
   // 全部成功后一次性切换
   unsafe { curr.set_page_table_root(new_root) };
   *aspace = new_aspace;
   ```
4. LoongArch 特殊处理：execve 时不能复用旧 TrapFrame，直接构建干净的 `UspaceContext`
5. 关闭所有带 `FD_CLOEXEC` 标志的文件描述符

**c) 进程退出与等待**

`api/src/imp/task/exit.rs` 实现了 `exit` 和 `exit_group`：
- `exit_group` 遍历进程内所有线程终止它们
- 唤醒进程私有 futex 上的阻塞线程
- 将进程状态设为 zombie，唤醒父进程的 `child_exit_wq`

`api/src/imp/task/wait.rs` 实现了 wait4 系列：
```rust
pub fn sys_waitpid(pid, exit_code_ptr, options) -> LinuxResult<isize>
```
- 支持 `WaitPid::Any/Pid/Pgid` 三种匹配模式
- 支持 `WNOHANG/WUNTRACED/WEXITED/WCONTINUED/WNOWAIT/WALL/WCLONE/WNOTHREAD`
- stop 信号通过 `ProcessData::waitable_stop_signal(consume)` 管理

#### 3.2.3 进程表管理

四张全局查找表（位于 `core/src/task.rs`）：
```rust
static THREAD_TABLE: RwLock<WeakMap<Pid, Weak<Thread>>>
static PROCESS_TABLE: RwLock<WeakMap<Pid, Weak<Process>>>
static PROCESS_GROUP_TABLE: RwLock<WeakMap<Pid, Weak<ProcessGroup>>>
static SESSION_TABLE: RwLock<WeakMap<Pid, Weak<Session>>>
```
使用弱引用避免循环引用导致的内存泄漏。`get_process(1)` 实现了 PID 1 进程别名兼容。

#### 3.2.4 实现完整度

| 功能 | 状态 | 备注 |
|------|------|------|
| fork/clone | 已实现 | 支持大部分 clone flags |
| vfork | 已实现 | 独立地址空间副本 |
| execve | 已实现 | 含权限检查、COW 兼容 |
| exit/exit_group | 已实现 | 含 futex 唤醒 |
| wait4/waitpid | 已实现 | 含 WUNTRACED/WNOHANG |
| 线程 (CLONE_THREAD) | 已实现 | 共享 VM/FILES/SIGHAND |
| 进程组/会话 | 已实现 | getpgid/setpgid/setsid/getsid |
| set_tid_address | 已实现 | clear_child_tid |
| 多线程 execve | 未实现 | 返回 EAGAIN |
| namespace | 存根 | 返回 EPERM |
| Cgroups | 未实现 | - |
| prctl(PR_SET_NAME 等) | 部分 | 仅 PR_GET_DUMPABLE/PR_SET_DUMPABLE |

---

### 3.3 文件系统子系统 (File System & VFS)

#### 3.3.1 架构

文件系统层分三层：

| 层 | 位置 | 说明 |
|----|------|------|
| VFS 框架 | `arceos/modules/axfs-ng/` + `axfs-ng-vfs` | Filesystem、Location、DirEntry trait |
| 文件描述符抽象 | `api/src/file/` (mod.rs, fs.rs, pipe.rs, net.rs, stdio.rs, unix.rs) | `FileLike` trait |
| 系统调用 | `api/src/imp/fs/` (fd_ops.rs 397行, io.rs 1043行, stat.rs 398行, mount.rs 752行, ctl.rs 1047行, pipe.rs) | POSIX 文件操作 |

#### 3.3.2 文件描述符抽象

`FileLike` trait 是文件描述符的统一抽象：
```rust
pub trait FileLike: Send + Sync {
    fn read(&self, buf: &mut [u8]) -> LinuxResult<usize>;
    fn write(&self, buf: &[u8]) -> LinuxResult<usize>;
    fn stat(&self) -> LinuxResult<Kstat>;
    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
    fn poll(&self) -> LinuxResult<PollState>;
    fn is_nonblocking(&self) -> bool;
    fn set_nonblocking(&self, nonblocking: bool) -> LinuxResult;
    fn close(self: Arc<Self>) -> LinuxResult;
}
```

实现该 trait 的类型：

| 类型 | 文件 | 说明 |
|------|------|------|
| `File` | `api/src/file/fs.rs` | 普通文件/目录的包装 |
| `Directory` | `api/src/file/fs.rs` | 目录句柄（含offset、removed标记） |
| `Pipe` | `api/src/file/pipe.rs` | 管道（环形缓冲区，64KB） |
| `Socket` | `api/src/file/net.rs` | TCP/UDP 套接字包装 |
| `UnixSocket` | `api/src/file/unix.rs` | Unix 域套接字 |
| `Stdin` / `Stdout` | `api/src/file/stdio.rs` | 标准输入/输出 |
| `EpollInstance` | `api/src/imp/io_mpx/epoll.rs` | Epoll 实例 |

FD 表通过 `scope_local` 机制实现 per-process 隔离：
```rust
scope_local! {
    pub static FD_TABLE: Arc<RwLock<FlattenObjects<Arc<dyn FileLike>, AX_FILE_LIMIT>>>
    pub static FD_CLOEXEC_TABLE: Arc<RwLock<BTreeSet<c_int>>>
}
```
`scope_local` 提供了一个类似 Linux `task_struct->files` 的 per-task 作用域机制。`AX_FILE_LIMIT` 为 1024，受 `RLIMIT_NOFILE` 约束。

#### 3.3.3 VFS 实现

`core/src/vfs/mod.rs`（651行）实现了虚拟文件系统挂载管理：

**挂载表** (`ProcMountTable`)：
- 基于稳定槽位的挂载记录管理（避免 umount 导致下标失效）
- 支持 `target_index`（按路径索引）和 `peer_group_index`（按 peer group 索引）
- `/proc/mounts` 缓存快照，变更后标记 dirty
- 活跃槽位列表避免遍历墓碑

**挂载传播**：
```rust
pub enum MountPropagation {
    Private,   // 默认
    Shared,    // 挂载事件传播到 peer group
    Slave,     // 接收但不发送
    Unbindable, // 不可绑定挂载
}
```

**bind mount 支持**：`new_bindfs` 创建绑定挂载文件系统，递归复制源目录结构。

#### 3.3.4 特殊文件系统

| 文件系统 | 位置 | 说明 |
|----------|------|------|
| **procfs** | `core/src/vfs/proc.rs`（609行） | `/proc/mounts`, `/proc/[pid]/stat`, `/proc/sysvipc/shm`, `/proc/sys/...` |
| **devfs** | `core/src/vfs/dev.rs` | `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/rtc0`, `/dev/kmsg`, `/dev/loop*` |
| **tmpfs** | `core/src/vfs/tmp.rs`（667行） | 基于 slab 的纯内存文件系统，支持全局可回收 |
| **etc** | `core/src/vfs/etc.rs` | `/etc` 配置文件的 Stub 实现 |

procfs 功能亮点：
- `/proc/self` → 当前进程符号链接
- `/proc/[pid]/stat` → 52 列进程状态输出（`TaskStat` 结构）
- `/proc/sysvipc/shm` → System V 共享内存快照（含增删改维护）
- `/proc/sys/kernel/shmmax/shmall/shmmni` → 可读写 sysctl
- `/proc/sys/kernel/domainname` → 可读写
- `/proc/sys/fs/pipe-max-size` → 管道容量上限
- `/proc/sys/vm/drop_caches` / `text_page_cache` → 缓存控制
- `/proc/meminfo` → 静态占位数据

#### 3.3.5 文件 I/O 操作

`api/src/imp/fs/io.rs`（1043行）实现了丰富的文件 I/O 操作：

- `read` / `write` / `readv` / `writev` — 基础 I/O
- `pread64` / `pwrite64` / `preadv` / `pwritev` / `preadv2` / `pwritev2` — 定位 I/O
- `lseek` — 含 `SEEK_DATA` / `SEEK_HOLE` 支持（通过逐块扫描实现）
- `sendfile` — 文件到文件/套接字的零拷贝传输
- `splice` — 管道到文件/文件到管道的数据搬运
- `copy_file_range` — 文件到文件的复制
- `truncate` / `ftruncate` / `fallocate` — 文件空间操作
- `fsync` / `fdatasync` / `sync` / `syncfs` — 同步操作

关键实现细节：
- 对 LoongArch 和 AArch64（独立内核/用户页表的架构），使用内核临时缓冲区后统一回写用户态，而非直接访问用户虚拟地址
- `RLIMIT_FSIZE` 写前检查
- FIFO (命名管道) 最小 O_NONBLOCK 语义支持（`ENXIO` 当无读端时）

#### 3.3.6 实现完整度

| 功能 | 状态 | 备注 |
|------|------|------|
| 文件描述符管理 | 已实现 | 含 CLOEXEC/FD_CLOEXEC |
| VFS 挂载表 | 已实现 | 含 bind mount / peer group |
| procfs | 已实现 | 较完整的 /proc 子树 |
| devfs | 已实现 | 标准设备节点 |
| tmpfs | 已实现 | 含全局可回收 |
| ext4 (读/写) | 已实现 | 通过 lwext4_rs |
| FAT | 已实现 | 通过 arceos axfs-ng |
| 管道 | 已实现 | 环形缓冲区 |
| AIO | 未实现 | - |
| inotify | 未实现 | - |
| fanotify | 未实现 | - |
| overlayfs | 未实现 | - |
| NFS/CIFS | 未实现 | - |

---

### 3.4 网络子系统 (Networking)

#### 3.4.1 架构

网络子系统基于 ArceOS 的 smoltcp 集成：

| 层 | 位置 | 说明 |
|----|------|------|
| TCP/IP 协议栈 | `arceos/modules/axnet/src/smoltcp_impl/` | 基于 smoltcp 的 TCP/UDP/ICMP |
| 网卡驱动 | `arceos/modules/axdriver/` | virtio-net、ixgbe |
| 套接字抽象 | `api/src/file/net.rs` | Socket 类型包装 |
| 系统调用 | `api/src/imp/net/` (socket.rs 322行, io.rs 398行, name.rs, opt.rs) | POSIX socket API |

#### 3.4.2 套接字实现

**Socket 枚举** (`api/src/file/net.rs`)：
```rust
pub enum Socket {
    Tcp(Mutex<TcpSocket>),
    Udp(Mutex<UdpSocket>),
}
```

**UnixSocket** (`api/src/file/unix.rs`, 422行)：
- 支持 `SOCK_STREAM` 和 `SOCK_DGRAM`
- 路径地址（`UnixAddr::Pathname`）和抽象地址（`UnixAddr::Abstract`）
- 全局命名空间 `UNIX_SOCKET_NAMESPACE`（`BTreeMap<UnixAddr, Arc<UnixSocket>>`）
- 持久化路径名表 `UNIX_SOCKET_PATHS`（`BTreeSet<String>`）
- Stream 监听队列（`accept_queue: Mutex<VecDeque<Arc<UnixSocket>>>`）和接受等待队列
- 数据报接收缓冲区 `recv_buffer: Mutex<VecDeque<(Vec<u8>, UnixAddr)>>`
- `socketpair()` 支持 stream 类型的成对创建
- 对端凭据（`ucred`: pid, uid, gid）

**网络套接字系统调用**（`api/src/imp/net/socket.rs`）：

| 系统调用 | 实现状态 | 备注 |
|----------|---------|------|
| `socket` | 已实现 | AF_INET/AF_INET6/AF_UNIX, SOCK_STREAM/SOCK_DGRAM |
| `bind` | 已实现 | 含本地地址检查 |
| `connect` | 已实现 | TCP 含 EISCONN 映射，支持 0.0.0.0→loopback 收敛 |
| `listen` | 已实现 | backlog 参数接受但未限制 |
| `accept/accept4` | 已实现 | 含 SOCK_NONBLOCK/SOCK_CLOEXEC |
| `sendto/sendmsg/sendmmsg` | 已实现 | - |
| `recvfrom/recvmsg/recvmmsg` | 已实现 | 含 MSG_OOB/MSG_ERRQUEUE 拒绝 |
| `getsockname/getpeername` | 已实现 | - |
| `getsockopt/setsockopt` | 已实现 | SO_REUSEADDR/SO_KEEPALIVE/SO_RCVBUF/SO_SNDBUF 等 |
| `shutdown` | 已实现 | SHUT_RD/SHUT_WR/SHUT_RDWR |
| `socketpair` | 已实现 | 仅 AF_UNIX + SOCK_STREAM |

#### 3.4.3 实现完整度

| 功能 | 状态 | 备注 |
|------|------|------|
| TCP/IP(v4/v6) | 已实现 | 基于 smoltcp |
| UDP | 已实现 | - |
| Unix Domain Socket | 已实现 | Stream + Dgram |
| 非阻塞 I/O | 已实现 | O_NONBLOCK |
| SO_REUSEADDR | 已实现 | - |
| TCP_NODELAY | 部分 | - |
| Raw Socket | 未实现 | 返回 EPROTONOSUPPORT |
| Netlink | 未实现 | - |
| Packet Socket | 未实现 | - |

---

### 3.5 信号子系统 (Signal)

#### 3.5.1 架构

信号机制由三层组成：

| 层 | 位置 | 说明 |
|----|------|------|
| 信号数据结构 | `api/src/signal.rs` | SignalInfo, SignalSet 用户态 API |
| 系统调用 | `api/src/imp/signal.rs`（365行） | POSIX 信号系统调用 |
| 底层机制 | `vendor/axsignal/` | 信号发送、递送、信号栈 |

#### 3.5.2 信号系统调用实现

| 系统调用 | 状态 | 说明 |
|----------|------|------|
| `kill` | 已实现 | pid=0/-1/<-1 语义完整 |
| `tkill` | 已实现 | 按 tid 发送 |
| `tgkill` | 已实现 | 按 tgid+tid 发送，含线程归属验证 |
| `rt_sigaction` | 已实现 | SA_SIGINFO/SA_ONSTACK/SA_RESTART/SA_NODEFER/SA_RESETHAND |
| `rt_sigprocmask` | 已实现 | SIG_BLOCK/SIG_UNBLOCK/SIG_SETMASK |
| `rt_sigpending` | 已实现 | - |
| `rt_sigreturn` | 已实现 | 含信号重入避免机制 |
| `rt_sigsuspend` | 已实现 | 临时替换 mask 并等待信号 |
| `rt_sigtimedwait` | 已实现 | 含超时支持 |
| `rt_sigqueueinfo` | 已实现 | 跨进程权限检查 |
| `rt_tgsigqueueinfo` | 已实现 | - |
| `sigaltstack` | 已实现 | SS_DISABLE 标志处理 |

**信号递送流程**：
1. `send_signal_process/thread` → 将 `SignalInfo` 加入目标 `ProcessSignalManager` 或 `ThreadSignalManager`
2. 从内核态返回用户态时通过 `check_signals` 检查是否有待递送信号
3. 若信号有注册 handler，设置用户栈上的 signal frame 并跳转到 signal trampoline
4. handler 返回后调用 `sigreturn()` 恢复上下文

**信号重入避免**：
```rust
BLOCK_NEXT_SIGNAL_CHECK.store(
    returning_signo.is_some_and(|signo| pending_after.has(signo)),
    Ordering::SeqCst,
);
```
在 `sigreturn()` 中，如果刚刚返回的 handler 对应信号仍然 pending，则跳过下一次立即信号检查，避免周期性信号（如 SIGALRM）导致 handler 风暴。

#### 3.5.3 实现完整度

| 功能 | 状态 | 备注 |
|------|------|------|
| 标准信号 1-31 | 已实现 | 含 SIGSTOP/SIGCONT/SIGCHLD |
| 实时信号 32-64 | 部分 | 框架支持但队列深度有限 |
| SA_SIGINFO | 已实现 | 额外信号信息传递 |
| 信号栈 (SA_ONSTACK) | 已实现 | - |
| sigaltstack | 已实现 | - |
| 信号转发到子线程 | 未实现 | 信号总是发给主线程 |
| coredump | 部分 | coredump_filter 框架存在，实际 dump 未实现 |

---

### 3.6 进程间通信子系统 (IPC)

#### 3.6.1 System V 共享内存

`api/src/imp/ipc/shm.rs`（960行）实现了完整的 System V 共享内存：

| 系统调用 | 说明 |
|----------|------|
| `shmget` | 创建/获取共享内存段，支持 `IPC_CREAT`/`IPC_EXCL`/`SHM_HUGETLB`，权限检查 |
| `shmat` | 附加共享内存，支持 `SHM_RDONLY`/`SHM_RND`/`SHM_REMAP`，LoongArch 上 64KB 对齐兼容 |
| `shmdt` | 分离共享内存 |
| `shmctl` | 控制操作：`IPC_RMID`/`IPC_SET`/`IPC_STAT`/`IPC_INFO`/`SHM_INFO`/`SHM_STAT`/`SHM_LOCK`/`SHM_UNLOCK` |

内核数据结构：
```rust
struct ShmInner {
    pub shmid: i32,
    pub page_num: usize,
    pub va_range: BTreeMap<Pid, VirtAddrRange>, // 每进程映射到的不同VA区间
    pub phys_pages: Option<Arc<SharedPages>>,   // 物理页面
    pub rmid: bool,                             // 最后分离时删除
    pub mapping_flags: MappingFlags,
    pub shmid_ds: ShmidDs,                      // C结构体
}
```

`ShmInner` 使用 `Arc<SharedPages>` 实现跨进程物理页面共享，映射到各进程的地址空间时，每个进程可能有不同的虚拟地址区间（通过 `va_range` 跟踪）。

`/proc/sysvipc/shm` 的快照维护通过 `update_proc_sysvipc_shm_snapshot`、`append_proc_sysvipc_shm_snapshot_line`、`remove_proc_sysvipc_shm_snapshot_shmid` 实现增删改的增量更新。

#### 3.6.2 实现完整度

| 功能 | 状态 |
|------|------|
| System V 共享内存 | 已实现（完整） |
| System V 信号量 | 未实现 |
| System V 消息队列 | 未实现 |
| POSIX 消息队列 | 未实现 |
| POSIX 共享内存 (shm_open) | 未实现 |

---

### 3.7 I/O 多路复用子系统 (I/O Multiplexing)

#### 3.7.1 epoll 实现

`api/src/imp/io_mpx/epoll.rs`：

```rust
pub struct EpollInstance {
    events: Mutex<BTreeMap<c_int, epoll_event>>,
}
```

- `epoll_create1` — 创建 epoll 实例，支持 `EPOLL_CLOEXEC`
- `epoll_ctl` — 支持 `EPOLL_CTL_ADD`/`EPOLL_CTL_MOD`/`EPOLL_CTL_DEL`，含重复注册检查和 epfd==fd 判定
- `epoll_wait` / `epoll_pwait` / `epoll_pwait2` — 基于轮询的等待机制

等待循环：
```rust
loop {
    axnet::poll_interfaces();       // 轮询网络接口
    let res = epoll.poll_all(events)?; // 检查所有注册fd
    if res > 0 { return Ok(res); }
    if deadline exceeded { return Ok(0); }
    axtask::yield_now();            // 让出CPU
}
```

支持的 epoll 目标类型：`Pipe`、`Socket`、`UnixSocket`、`Stdin`、`Stdout`。

#### 3.7.2 poll/select 实现

`poll` 和 `select` 都采用与 epoll 相同的轮询模式：
- `poll`/`ppoll`：含 `POLLIN`/`POLLOUT`/`POLLERR`/`POLLNVAL` 语义
- `select`/`pselect6`：`FD_SET`/`FD_ISSET`/`FD_ZERO` 宏兼容
- `ppoll` 支持临时信号 mask 替换（`SIGKILL/SIGSTOP` 不可屏蔽）

#### 3.7.3 实现完整度

| 功能 | 状态 | 备注 |
|------|------|------|
| epoll (level-triggered) | 已实现 | 基于轮询而非事件通知 |
| epoll (edge-triggered) | 未实现 | - |
| poll | 已实现 | - |
| select | 已实现 | - |
| ppoll/pselect6 | 已实现 | 含临时 sigmask |
| EPOLLONESHOT | 未实现 | - |
| signalfd | 未实现 | - |
| eventfd | 未实现 | - |
| timerfd | 存根 | syscall 存在但返回 ENOSYS |

---

### 3.8 时间与定时器子系统 (Time & Timer)

#### 3.8.1 实现

**时间管理器** (`core/src/time.rs`)：
```rust
pub struct TimeManager {
    utime_ns: usize,       // 用户态时间
    stime_ns: usize,       // 内核态时间
    user_timestamp: usize, // 进入用户态时刻
    kernel_timestamp: usize, // 进入内核态时刻
    itimers: [ITimer; 3],  // ITIMER_REAL/VIRTUAL/PROF
}
```

在上下文切换时更新：
- `switch_into_kernel_mode` — 统计 utime，更新 ITIMER_REAL/VIRTUAL/PROF
- `switch_into_user_mode` — 统计 stime，更新 ITIMER_REAL/PROF
- 首次切换检测（timestamp==0 时跳过 delta 累计，避免将启动时间误算为进程时间）

`ITimer` 结构实现了剩余时间倒计时和周期性重载。

**时间系统调用**：
| 系统调用 | 状态 | 备注 |
|----------|------|------|
| `clock_gettime` | 已实现 | 支持 9 种时钟 ID |
| `clock_getres` | 已实现 | 返回 1μs 精度 |
| `gettimeofday` | 已实现 | 含 timezone 废弃参数校验 |
| `times` | 已实现 | utime/stime/cutime/cstime |
| `nanosleep` / `clock_nanosleep` | 已实现 | 含 TIMER_ABSTIME |
| `getitimer` / `setitimer` | 已实现 | ITIMER_REAL/VIRTUAL/PROF |
| `timerfd_create` | 存根 | 返回 ENOSYS |

#### 3.8.2 实现完整度

| 功能 | 状态 |
|------|------|
| 单调时钟 | 已实现 |
| 实时时钟 | 已实现 |
| 进程/线程 CPU 时间 | 已实现 |
| interval timer | 已实现 |
| POSIX timer | 未实现 |
| timerfd | 未实现 |
| adjtimex | 未实现 |

---

### 3.9 同步原语子系统 (Synchronization)

#### 3.9.1 Futex 实现

**内核 Futex 数据结构** (`core/src/futex.rs`)：

```rust
pub enum FutexKey {
    Private { address: usize },                    // 进程私有
    Shared { offset: usize, region: Weak<SharedPages> }, // 跨进程共享
}

pub struct FutexEntry {
    pub wq: WaitQueue,             // 等待队列
    pub owner_dead: AtomicBool,    // robust futex: 所有者是否死亡
}

pub struct FutexTable(Mutex<BTreeMap<usize, Arc<FutexEntry>>>);
```

`FutexKey::new` 通过查找目标地址所属的内存区域判断是私有还是共享 futex。共享 futex 用于跨进程同步（如 pthread mutex 在共享内存中）。

进程级 futex 表位于 `ProcessData::futex_table`，全局共享 futex 表为 `SHARED_FUTEX_TABLE`。

**Futex 系统调用** (`api/src/imp/futex.rs`)：

| 操作 | 说明 |
|------|------|
| `FUTEX_WAIT` | 原子检查值后等待，含 fast path 优化 |
| `FUTEX_WAIT_BITSET` | 支持 bitset 匹配，用于 `pthread_cond_timedwait` |
| `FUTEX_WAKE` | 唤醒指定数量的等待者 |
| `FUTEX_WAKE_BITSET` | bitset 过滤唤醒 |
| `FUTEX_REQUEUE` | 将等待者从当前 futex 迁移到另一个 |
| `FUTEX_CMP_REQUEUE` | 条件迁移（含值校验） |

**robust list 支持**：
- `get_robust_list` / `set_robust_list` — 获取/设置健壮列表头
- `exit_robust_list` — 线程退出时遍历 robust list，标记 `owner_dead` 并唤醒等待者
- 限制遍历深度为 2048（`ROBUST_LIST_LIMIT`）

**超时语义**：
- `FUTEX_WAIT_BITSET` 使用绝对时间（`FUTEX_CLOCK_REALTIME` 控制时钟源）
- 普通 `FUTEX_WAIT` 使用相对时间

#### 3.9.2 实现完整度

| 功能 | 状态 |
|------|------|
| FUTEX_WAIT/WAKE | 已实现 |
| FUTEX_WAIT_BITSET/WAKE_BITSET | 已实现 |
| FUTEX_REQUEUE/CMP_REQUEUE | 已实现 |
| robust futex | 已实现 |
| PI futex | 未实现 |
| FUTEX_FD | 未实现 |

---

### 3.10 硬件抽象层 (HAL)

HAL 层完全基于 ArceOS 的 `axhal` 模块：

| 架构 | 上下文切换 | 陷阱处理 | 页表操作 | TLS 支持 |
|------|-----------|---------|---------|---------|
| **riscv64** | `context.rs` (505行) | `trap.rs` | paging.rs | 通过 `sscratch` |
| **loongarch64** | `context.rs` (412行) | `trap.rs` | paging.rs | 通过 `$tp` 寄存器 |
| **aarch64** | `context.rs` (426行) | trap.rs | paging.rs | 通过 `TPIDR_EL0` |
| **x86_64** | `context.rs` (473行) | trap.rs | paging.rs | 通过 `FS.base` |

**系统调用路径**（以 riscv64 为例）：

```
用户态 ecall 指令
  → riscv_trap_handler (riscv trap.S 汇编保存 TrapFrame)
    → scause 判断为 UserEnvCall
      → handle_syscall(tf, syscall_num)
        → starry_api::handle_syscall_impl (src/syscall.rs 584行)
          → match Sysno 分发到各 syscall 实现函数
            → 通过 TrapFrame 读写用户态参数
              → sret 返回用户态
```

**页故障处理**（`src/mm.rs`）：
```rust
#[register_trap_handler(PAGE_FAULT)]
fn handle_page_fault(vaddr, access_flags, is_user) -> bool {
    // 1. 内核态访问用户地址（如 COW 写时复制）也需要处理
    // 2. 栈自动扩展检查 rlimit
    // 3. 失败时发送 SIGSEGV
}
```

---

### 3.11 设备驱动子系统 (Device Drivers)

设备驱动完全依赖 ArceOS 的 `axdriver` 模块：

| 驱动 | 说明 |
|------|------|
| virtio-blk | 块设备（磁盘 I/O） |
| virtio-net | 网络设备 |
| virtio-gpu | 显示（未主要使用） |
| ixgbe | Intel 10GbE 网卡 |
| PCI 总线 | 设备枚举和配置空间访问 |
| MMIO 总线 | 内存映射 I/O 设备 |

devfs 中实现了基础设备节点：
- `/dev/null` — 读返回 EOF，写丢弃数据
- `/dev/zero` — 读返回零，写丢弃数据
- `/dev/random` / `/dev/urandom` — 基于 `SmallRng` 的伪随机数
- `/dev/rtc0` — 实时时钟（空操作存根）
- `/dev/kmsg` — 内核消息缓冲区
- `/dev/loop*` — 回环设备（用于挂载磁盘镜像）

---

### 3.12 平台配置子系统

`config/` crate 提供了四个架构的静态配置参数：

| 参数 | riscv64 | loongarch64 | 说明 |
|------|---------|-------------|------|
| `KERNEL_STACK_SIZE` | 256KB | 256KB | 内核栈大小 |
| `USER_SPACE_BASE` | 0x1000 | 0x1000 | 用户空间基址 |
| `USER_SPACE_SIZE` | ~256GB | ~256GB | 用户空间大小 |
| `USER_STACK_TOP` | 0x4_0000_0000 | 0x4_0000_0000 | 栈顶地址 |
| `USER_STACK_SIZE` | 512KB | 512KB | 栈大小 |
| `USER_HEAP_BASE` | 0x4000_0000 | 0x4000_0000 | 堆基址 |
| `USER_HEAP_SIZE` | 64KB | 64KB | 初始堆大小 |
| `USER_INTERP_BASE` | 0x400_0000 | 0x400_0000 | 解释器基址 |
| `SIGNAL_TRAMPOLINE` | 0x4001_0000 | 0x4001_0000 | 信号跳板地址 |

---

## 四、子系统间交互分析

### 4.1 系统调用完整路径

```
用户态程序
  │ [syscall 指令]
  ▼
TrapFrame (保存用户寄存器)
  │ [axhal trap handler]
  ▼
src/syscall.rs :: handle_syscall_impl
  │ [match Sysno, 187个系统调用]
  ├── 进程类 → starry_api::imp::task::* → axprocess + starry_core::task
  ├── 文件类 → starry_api::imp::fs::* → axfs-ng + starry_core::vfs
  ├── 内存类 → starry_api::imp::mm::* → axmm::AddrSpace
  ├── 网络类 → starry_api::imp::net::* → axnet (smoltcp)
  ├── 信号类 → starry_api::imp::signal::* → axsignal
  ├── IPC类  → starry_api::imp::ipc::* → axmm::SharedPages
  └── 同步类 → starry_api::imp::futex::* → starry_core::futex
  │ [返回值写入 tf.regs.a0]
  ▼
sret/ertn 返回用户态
```

### 4.2 关键交互场景

**fork + exec**：
1. `sys_clone` → 创建新 Process + Thread + 复制 AddrSpace (COW)
2. 子进程调用 `sys_execve` → 加载新 ELF → 替换 AddrSpace → 关闭 FD_CLOEXEC

**管道通信**：
1. `sys_pipe2` → 创建两个 `Pipe` 对象 → 分配两个 fd
2. `sys_write(fd[1])` → `Pipe::write` → 环形缓冲区 → `wait_queue.notify_all`
3. `sys_read(fd[0])` → `Pipe::read` → 从环形缓冲区读取 → 阻塞或返回数据

**网络通信**：
1. `sys_socket` → 创建 `Socket::Tcp/Udp` → 分配 fd
2. `sys_connect` → `TcpSocket::connect` → smoltcp TCP 状态机
3. `sys_write/send` → `Socket::write` → smoltcp 发送缓冲区
4. `sys_read/recv` → `Socket::read` → smoltcp 接收缓冲区
5. epoll_wait 定期调用 `axnet::poll_interfaces()` 驱动 smoltcp 轮询

**信号递送**：
1. `sys_kill` → `send_signal_process` → 设置 pending 位
2. 返回用户态前 → `check_signals` → 找到未屏蔽的 pending 信号
3. 设置用户栈 signal frame → 跳转到 signal trampoline → handler 执行
4. handler 返回调用 `sigreturn` → 恢复原始上下文

---

## 五、设计与实现的创新性分析

### 5.1 架构创新

1. **组件化宏内核设计**：Starry OS 不是传统宏内核，也不是微内核。它在 ArceOS 组件化运行基座上通过 trait 扩展机制实现了类 Unix 宏内核语义。`TaskExt` trait 和 `scope_local!` 宏是两个关键机制，允许在不修改 ArceOS 核心调度器的情况下注入进程模型、文件描述符表等复杂状态。

2. **三层分离的 Crate 结构** (`starry-api` / `starry-core` / `starry-config`)：清晰地分离了系统调用接口层（面向用户态）、内核核心服务层（进程/内存/VFS）、以及平台配置层。这种分离使得：系统调用可以独立演进而核心不变；多架构支持可以通过配置层的编译时多态自然实现。

3. **基于 scope_local 的 per-task 状态管理**：使用 `scope_local!` 宏实现类似 Linux `task_struct` 的 per-task 作用域隔离，但通过 Rust 的类型安全保证了正确性。FD_TABLE、FD_CLOEXEC_TABLE 等关键数据结构都通过此机制实现"进入任务时自动切换，离开时自动恢复"。

### 5.2 工程实践创新

1. **多级 ELF 缓存策略**：实现了"ELF 文件数据缓存 → Text 段物理页共享缓存"两级缓存，专门针对 LTP 测试中高频 exec 的场景优化。Text 段缓存在 `fs_bind*` 测试组中实现了跨进程物理页共享。

2. **OOM 预防机制**：在 fork 路径中实现了 tmpfs 预测性回收（每 500 次 fork），在 mmap/地址空间复制失败时触发 tmpfs 回收重试。

3. **嵌入式 libgcc_s**：将 `libgcc_s.so.1` 编译进内核二进制，在启动时自动安装到 rootfs，解决了评测磁盘镜像不包含该库的兼容性问题。

4. **广泛的 LTP 兼容性工程**：
   - `/proc/mounts` 缓存优化（避免高频读取的性能开销）
   - `/proc/[pid]/stat` 的状态映射（`Ready/Blocked → S` 兼容 shell 轮询）
   - 大量边界条件处理（如 `write(fd, NULL, 0)`、`poll` 零超时、`ppoll` 临时 sigmask）
   - LoongArch 特殊路径（execve 不复用旧 TrapFrame、SHMLBA 64K/4K 自适应）

### 5.3 架构特定优化

1. **LoongArch 与 AArch64 的独立页表处理**：这两个架构使用独立的用户/内核页表（PGDL/TTBR0_EL1 vs PGDH/TTBR1_EL1），内核不能直接解引用用户态指针。项目在 `UserPtr::write_bytes` 中统一通过 `AddrSpace::write` 方法写入，并在 I/O 路径中使用内核临时缓冲区。

2. **RISC-V LoongArch 双架构测试分离**：`rv_case` 和 `la_case` 分别维护两架构的 LTP 测试用例列表，init.sh 在运行时根据 `ARCH` 环境变量选择对应的测试集。

---

## 六、整体实现完整度评估

### 6.1 系统调用覆盖率

已实现 **187** 个系统调用。以下按 POSIX 功能域统计：

| 功能域 | 已实现系统调用数 | 估计覆盖率 | 评价 |
|--------|----------------|-----------|------|
| 进程管理 | 15+ | 85% | fork/clone/execve/exit/wait 完整；缺多线程 execve |
| 文件 I/O | 30+ | 90% | 基本 I/O 完整；缺 AIO |
| 文件系统操作 | 25+ | 85% | link/unlink/mount/stat 系列完整 |
| 内存管理 | 10+ | 80% | mmap 系列完整；缺 huge pages |
| 网络 | 20+ | 75% | TCP/UDP/Unix 完整；缺 raw socket |
| 信号 | 12+ | 85% | 标准信号完整；缺实时信号队列 |
| IPC | 4+ | 33% | 仅 System V 共享内存 |
| 时间 | 8+ | 70% | 基本时钟和定时器完整；缺 POSIX timer |
| 同步 | 6+ | 70% | futex 完整；缺 PI futex |
| I/O 多路复用 | 7+ | 70% | epoll/poll/select 完整；缺 eventfd/signalfd/timerfd |
| 系统信息 | 10+ | 60% | uname/sysinfo/prlimit 等 |

**总体估计：系统调用层面覆盖了约 75% 的 POSIX 核心功能。**

### 6.2 关键缺失

| 缺失项 | 优先级 | 影响 |
|--------|-------|------|
| 多线程 execve | 高 | 多线程程序无法正确 exec |
| POSIX timer / timerfd | 中 | 部分应用的定时需求 |
| eventfd / signalfd | 中 | 现代 I/O 事件循环的常用机制 |
| epoll edge-triggered | 中 | 高性能网络服务器 |
| System V 信号量/消息队列 | 低 | 遗留应用依赖 |
| AIO / io_uring | 低 | 高性能异步 I/O |
| Cgroups / namespace | 低 | 容器化支持 |
| Core dump | 低 | 调试支持 |

---

## 七、项目总结

Starry OS 是一个以竞赛为导向、务实且工程化程度高的 Rust 宏内核项目。其核心特征总结如下：

**优势**：
1. **极强的 LTP 兼容性**：通过大量边界条件处理和兼容性 hack，实现了对数百个 LTP 测试用例的支持，这在竞赛场景中具有直接价值。
2. **清晰的分层架构**：starry-api / starry-core / starry-config 三层分离，代码组织合理，职责明确。
3. **实用的工程优化**：ELF 多级缓存、tmpfs OOM 回收、嵌入式 libgcc_s 等优化直接服务于测试效率和兼容性。
4. **良好的多架构支持**：riscv64 和 loongarch64 两条主线的代码路径清晰，架构差异处理得当。
5. **Rust 类型安全**：利用 trait、enum、Arc/Weak、Mutex 等 Rust 特性构建了相对安全的并发模型。

**不足**：
1. **核心进程/线程模型依赖外部 crate**（axprocess/axsignal），使得关键数据结构（Process、Thread）不在本项目控制范围内。
2. **部分实现为存根**（timerfd 返回 ENOSYS、namespace 返回 EPERM），在 LTP 测试中通过测试用例过滤规避而非真正实现。
3. **I/O 多路复用基于轮询**，缺乏真正的事件驱动机制（中断通知），可能在高并发场景下性能不足。
4. **部分 procfs 内容为静态占位**（meminfo、stat 中的多数字段），仅满足 LTP 读取不崩溃的最低要求。
5. **代码中存在大量中文注释**描述了各种 LTP 兼容性工作区（workaround），反映了"以测例通过为目标"的开发模式而非"以规范为目标"的设计模式。

**综合评价**：Starry OS 是一个在约 46,200 行 Rust 代码中实现了 POSIX 宏内核约 75% 核心功能的项目。其最大亮点在于对竞赛测试集的深度适配和实用的工程优化。在技术深度上，clone/execve 的 COW 集成、futex 的 robust list 支持、信号栈和 trampoline 机制、System V 共享内存的跨进程物理页共享等方面体现了扎实的操作系统知识。项目的代码质量和 OOM 防御性编程也显示了较高的工程成熟度。