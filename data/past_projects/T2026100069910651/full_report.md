现在我已经对整个项目有了深入的理解，可以生成详细的技术报告了。

---

# OurKernel2026 操作系统内核技术报告

## 一、分析方法与范围

本报告基于对 OurKernel2026 项目仓库（位于工作区根目录）的完整源代码审查，覆盖了约 22,111 行自有 Rust 代码（不含 vendor 和 arceos 第三方依赖）。分析方法包括：

- 逐文件阅读内核入口、核心模块、系统调用层、进程模型、内存管理、VFS、网络等关键源代码；
- 分析 Cargo workspace 结构与 crate 间依赖关系；
- 检查构建系统（Makefile、build.rs）和配置文件；
- 分析系统调用分发表中已实现与存根系统调用的比例；
- 分析评测框架与竞赛测试基础设施。

本报告未进行 QEMU 实际运行测试，因为构建环境缺少指定版本的 Rust nightly-2025-05-20 工具链和相关交叉编译工具，且项目强依赖特定 Rust 版本和外部 git 依赖。以下所有结论均基于静态代码分析。

---

## 二、项目总体结构

### 2.1 Cargo Workspace 成员

| crate 名称 | 路径 | 职责 |
|-----------|------|------|
| `ourkernel2026` | 根目录 | 内核入口、系统调用分发、文件系统初始化、评测框架 |
| `starry-core` | `core/` | 内核核心状态管理：进程数据、线程数据、地址空间、资源限制、共享内存、时间统计 |
| `ourkernel2026-api` | `api/` | POSIX API 层：三层结构（`core`/`imp`/`interface`） |
| `ourkernel2026-process` | `process/` | 纯数据结构：进程/线程/进程组/会话层级模型 |
| `ourkernel2026-vfs` | `modules/vfs/` | 可复用 VFS 抽象：Filesystem、DirEntry、Node、Path、Metadata |
| `syscall-trace` | `syscall_trace/` | proc-macro：系统调用自动日志记录 |
| `lwext4_rust` | `modules/lwext4_rust/` | ext4 文件系统（C 库 lwext4 的 Rust FFI 绑定） |
| `page_table_multiarch` | `modules/page_table_multiarch/` | 多架构页表条目与页表抽象 |

### 2.2 外部依赖（ArceOS 生态）

项目大量依赖 ArceOS 框架，通过 git 远程仓库引入：

| 依赖 | 用途 |
|------|------|
| `axhal` | 硬件抽象层：陷阱处理、分页、架构特定操作（features: uspace, rtc） |
| `axmm` | 地址空间管理（features: cow，支持写时复制） |
| `axtask` | 任务调度、WaitQueue、CPU affinity |
| `axalloc` | 物理页分配器（features: page-alloc-4g） |
| `axfs-ng` | 文件系统上下文与操作 |
| `axns` | 命名空间抽象（features: thread-local） |
| `axsync` | 同步原语（Mutex 等） |
| `axsignal` | 信号基础设施（来自 Starry-OS/axsignal，rev 7352c08） |
| `arceos_posix_api` | POSIX API 兼容基础设施（features: uspace, smp, irq, fs, multitask, net, pipe, select, epoll） |
| `axnet` | 网络栈（TcpSocket/UdpSocket） |
| `axconfig` | 平台配置常量 |
| `axlog` | 内核日志 |
| `axfeat` | 特性门控框架 |
| `axdisplay`/`axdriver_display` | 显示驱动（GUI 特性） |

### 2.3 支持的 CPU 架构

- `riscv64gc-unknown-none-elf`
- `x86_64-unknown-none`
- `aarch64-unknown-none` / `aarch64-unknown-none-softfloat`
- `loongarch64-unknown-none-softfloat`

---

## 三、子系统详细分析

### 3.1 系统调用分发层

**位置**：`src/syscall.rs`（560 行）

系统调用分发是整个内核的用户态接口中枢。通过 ArceOS 的 `#[register_trap_handler(SYSCALL)]` 机制注册陷阱处理函数。

**核心机制**：

```rust
#[register_trap_handler(SYSCALL)]
fn handle_syscall(tf: &mut TrapFrame, syscall_num: usize) -> isize {
    let sysno = Sysno::new(syscall_num as _);
    // ...
    let result: LinuxResult<isize> = match sysno {
        Sysno::read => sys_read(tf.arg0() as _, tf.arg1().into(), tf.arg2() as _),
        Sysno::write => sys_write(tf.arg0() as _, tf.arg1().into(), tf.arg2() as _),
        // ... 约 150+ 个系统调用分支
        _ => stub_unimplemented(syscall_num),
    };
    // 处理 EINTR + 未阻塞信号的情况
    if ans == -(LinuxError::EINTR.code() as isize) && has_unblocked_pending_signal() {
        #[cfg(target_arch = "riscv64")]
        tf.set_ip(tf.ip().saturating_sub(4)); // 重试系统调用
    }
    // ...
}
```

**已实现系统调用统计**（按功能分类）：

| 类别 | 已实现 | 存根(stub)/返回错误 | 主要系统调用 |
|------|--------|---------------------|-------------|
| 文件 I/O | ~25 | 5+ | read, write, openat, close, lseek, pread64, pwrite64, readv, writev, copy_file_range, sendfile, splice, truncate, ftruncate, sync, fsync |
| 文件元数据 | ~15 | 5+ | fstat, statx, fstatat, getdents64, chdir, fchdir, linkat, unlinkat, renameat2, symlinkat, readlinkat, mkdirat, fchmod, fchownat, utimensat, faccessat, statfs, fstatfs |
| 文件描述符 | ~5 | 0 | dup, dup3, fcntl, pipe2, close |
| epoll/poll/select | ~5 | 0 | epoll_create1, epoll_ctl, epoll_pwait, ppoll, pselect6 |
| 进程管理 | ~10 | 5+ | clone, fork(x86_64), execve, exit, exit_group, wait4, getpid, getppid, gettid, set_tid_address |
| 线程/调度 | ~15 | 3+ | sched_yield, nanosleep, clock_nanosleep, sched_getaffinity, sched_setaffinity, sched_getparam, sched_setparam, sched_getscheduler, sched_setscheduler, sched_get_priority_max/min, setpgid, getpgid |
| 信号 | ~10 | 0 | kill, tkill, tgkill, rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigqueueinfo, rt_tgsigqueueinfo, rt_sigsuspend, rt_sigtimedwait, rt_sigreturn, sigaltstack |
| 内存管理 | ~5 | 2+ | mmap, munmap, mprotect, brk, madvise(stub) |
| 共享内存 | 4 | 0 | shmget, shmat, shmctl, shmdt |
| 网络 | ~15 | 5+ | socket, bind, listen, accept, connect, sendto, recvfrom, shutdown, setsockopt, getsockopt, getpeername, getsockname |
| 时间 | ~5 | 2+ | gettimeofday, clock_gettime, clock_getres, times, timer_create/settime/gettime/delete/getoverrun |
| 资源限制 | 2 | 0 | getrlimit, setrlimit, prlimit64 |
| 用户/组 | ~4 | 5+ | getuid, geteuid, getgid, getegid (setuid/setgid等为stub) |
| 杂项 | ~5 | 15+ | uname, getcwd, getrandom, syslog(stub), arch_prctl(x86_64) |

总计约 **140+ 个系统调用被明确处理**，其中约 90 个有实质性实现，约 30 个为存根（记录日志后返回 0），约 20 个返回特定错误码。

**存根类型**：
- `stub_bypass`: 返回 Ok(0) 并打印警告（如 setuid、prctl、flock 等）
- `stub_unimplemented`: 返回 ENOSYS（如未知系统调用）
- `sys_openstub`: 返回 EBADF 或类似错误（如 bpf、io_uring_setup 等）

**平台差异处理**：
- `clone` 系统调用在 RISC-V/AArch64 上需要传入 `tf`（TrapFrame）以正确克隆用户上下文；x86_64/LoongArch64 则不需要
- x86_64 平台有额外的老式系统调用（如 `open`、`stat`、`fork`、`pipe` 等），非 x86_64 平台使用新式系统调用
- `arch_prctl` 仅在 x86_64 上可用

---

### 3.2 进程与线程模型

**位置**：`process/src/` + `core/src/process.rs` + `core/src/task.rs`

#### 3.2.1 纯数据结构层（`ourkernel2026-process`）

该 crate 是零外部依赖的纯数据结构层（仅依赖 `spin`），定义了 POSIX 兼容的严格两级层级：

```
Session (会话)
  └── ProcessGroup (进程组)
        └── Process (进程)
              └── Thread (线程)
```

**Process** (`process/src/process.rs`)：

```rust
pub struct Process {
    pid: Pid,
    threads: Mutex<BTreeMap<Pid, Arc<Thread>>>,
    process_group: Mutex<Weak<ProcessGroup>>,
    children: Mutex<BTreeMap<Pid, Arc<Process>>>,
    parent: Mutex<Weak<Process>>,
    is_zombie: AtomicBool,
    exit_code: AtomicI32,
}
```

关键实现：
- **PID 分配**：通过全局 `NEXT_PID: AtomicU32` 单调递增分配
- **进程创建**：`spawn_process()` 创建无父进程的 init 进程；`fork()` 从当前进程派生
- **僵尸进程处理**：进程退出时（`exit()`），若为僵尸状态，将所有子进程转移至 reaper 进程（当前硬编码为 PID=1 的 init 进程）
- **进程释放**：`release()` 从父进程的子进程列表、进程组和全局进程表中移除
- **会话管理**：`create_session()` 创建新会话（不能是进程组 leader）；`create_group()` 创建新进程组（不能已是 group leader）

**Thread** (`process/src/thread.rs`)：

```rust
pub struct Thread {
    tid: Pid,
    process: Weak<Process>,
}
```

- TID 与 PID 共享同一编号空间（通过 `NEXT_PID`）
- 主线程的 TID 等于进程 PID
- 线程退出时调用 `process.remove_thread()`；当进程所有线程退出后，进程自动变为僵尸

**ProcessGroup** (`process/src/process_group.rs`)：
- 维护 PGID 和成员进程 BTreeMap
- 进程组为空时自动从会话和全局表中移除

**Session** (`process/src/session.rs`)：
- 维护 SID 和成员进程组 BTreeMap
- 会话为空时自动从全局表中移除

#### 3.2.2 内核核心状态层（`starry-core`）

**ProcessData** (`core/src/process.rs`)：

```rust
pub struct ProcessData {
    pub command_line: Mutex<Vec<String>>,
    pub addr_space: Arc<Mutex<AddrSpace>>,
    heap_bottom: AtomicUsize,
    heap_top: AtomicUsize,
    pub resource_limits: Arc<Mutex<ResourceLimits>>,
    pub child_exit_wq: WaitQueue,
    pub exit_signal: Option<Signo>,
    pub signal: Arc<ProcessSignalManager<RawMutex, WaitQueueWrapper>>,
    pub futex_table: Mutex<BTreeMap<usize, Arc<WaitQueue>>>,
    pub shared_memory: Mutex<BTreeMap<VirtAddr, Arc<SharedMemory>>>,
}
```

每个 `ProcessData` 包含：
- **地址空间**：`Arc<Mutex<AddrSpace>>`，可在 clone(CLONE_VM) 时共享
- **堆管理**：`heap_bottom` / `heap_top` 原子变量，由 brk 系统调用操作
- **资源限制**：通过 `ResourceLimits` 管理
- **信号管理**：`ProcessSignalManager`（来自 axsignal），管理进程级信号处理
- **Futex 表**：`BTreeMap<usize, Arc<WaitQueue>>`，以用户态地址为键
- **共享内存**：`BTreeMap<VirtAddr, Arc<SharedMemory>>`，记录已附加的共享内存段

**ThreadData** (`core/src/process.rs`)：

```rust
pub struct ThreadData {
    tid: Pid,
    pub process_data: Arc<ProcessData>,
    pub namespace: AxNamespace,
    pub addr_clear_child_tid: AtomicUsize,
    pub addr_set_child_tid: AtomicUsize,
    pub signal: ThreadSignalManager<RawMutex, WaitQueueWrapper>,
}
```

- **命名空间**：`AxNamespace` 实现线程本地资源隔离（FD_TABLE、FS_CONTEXT 等由其管理）
- **clear_child_tid / set_child_tid**：支持 Linux clone 语义，线程退出时清零 clear_child_tid 并 futex 唤醒
- **信号**：线程级 `ThreadSignalManager`，共享进程级 `ProcessSignalManager`

**TaskExt** (`core/src/task.rs`)：

```rust
pub struct TaskExt {
    pub time: RefCell<TimeStat>,
    pub thread: Arc<Thread>,
    pub thread_data: Arc<ThreadData>,
}
```

通过 ArceOS 的 `def_task_ext!` 宏将扩展数据附加到调度器任务结构上。提供便捷访问函数：
- `current_thread()` / `current_process()` / `current_thread_data()` / `current_process_data()`

**时间统计** (`core/src/ctypes.rs`)：`TimeStat` 追踪用户态/内核态时间，支持 3 种定时器类型（REAL/VIRTUAL/PROF），用于 `times` 系统调用。

#### 3.2.3 进程创建流程（clone 系统调用）

`api/src/imp/task/clone.rs` 实现了完整的 `clone` 语义：

1. 从内核栈读取父进程的 TrapFrame
2. 根据 CloneFlags 决定创建线程还是进程：
   - **CLONE_THREAD**：创建线程，共享地址空间、信号处理等；新线程加入同一进程
   - **否则**：创建新进程，可选共享地址空间（CLONE_VM）、信号处理（CLONE_SIGHAND）、文件描述符表（CLONE_FILES）、文件系统信息（CLONE_FS）
3. 支持 CLONE_PARENT（以兄弟身份创建）、CLONE_VFORK（父进程挂起直到子进程 execve/exit）
4. 处理 CLONE_SETTLS（设置 TLS）、CLONE_CHILD_SETTID/CLONE_PARENT_SETTID（写 TID）
5. 通过 `CloneFlags` 扩展 `starry_core::ctypes::CloneFlags` 增加了更多 flags

**VFORK 实现**：父进程在子进程 execve 或退出前挂起在 `vfork_wq` 等待队列上。

---

### 3.3 内存管理

**位置**：`core/src/mm.rs` + `src/mm.rs` + `api/src/imp/mm/`

#### 3.3.1 地址空间初始化

用户地址空间的创建流程（`src/entry.rs` -> `run_user_app`）：

1. **创建空地址空间**：`new_user_aspace_empty()` 创建覆盖用户空间的空地址空间
2. **拷贝内核映射**：对于 RISC-V/x86_64，`copy_from_kernel()` 将内核页表项复制到用户页表（因为这两个架构的 MMU 在内核态和用户态共用页表）。AArch64 和 LoongArch64 有独立页表寄存器（TTBR0_EL1/PGDL），无需此步骤
3. **映射信号 Trampoline**：`map_trampoline()` 将 axsignal 提供的信号返回跳板代码映射到用户空间固定地址（`axconfig::plat::SIGNAL_TRAMPOLINE`）
4. **加载 ELF**：`load_user_app()` 解析 ELF，映射 LOAD 段、用户栈和堆

#### 3.3.2 ELF 加载

`load_user_app()` 实现了完整的 ELF 加载：

- 支持 **shebang 脚本**（`#!` 开头）：递归加载解释器
- 支持 **动态链接器**（PT_INTERP 段）：递归加载 `ld-linux.so` 等解释器
- 使用 `kernel_elf_parser` 解析 ELF 程序头，按段映射并填充数据
- 构建用户栈：包含参数、环境变量、辅助向量（auxv），通过 `app_stack_region()` 布局
- 映射用户堆：从 `USER_HEAP_BASE` 开始，大小 `USER_HEAP_SIZE`

#### 3.3.3 页错误处理

`src/mm.rs` 通过 `#[register_trap_handler(PAGE_FAULT)]` 注册页错误处理：

```rust
fn handle_page_fault(vaddr: VirtAddr, access_flags: MappingFlags, is_user: bool) -> bool {
    // 内核态缺页（非用户内存访问）-> panic
    // 否则调用 aspace.handle_page_fault() 处理 CoW、惰性分配等
    // 无法处理时发送 SIGSEGV
}
```

关键特性：
- **写时复制（CoW）**：由 axmm（features: cow）在地址空间层面支持
- **按需分页**：由 `aspace.handle_page_fault()` 和 `aspace.populate_area()` 支持
- **用户内存安全访问**：`access_user_memory()` 使用 percpu 标志位标记内核正在访问用户内存，使页错误处理可以区分合法与非法内核态缺页

#### 3.3.4 mmap/munmap/mprotect/brk

**mmap** (`api/src/imp/mm/mmap.rs`)：

支持的特性：
- **MAP_ANONYMOUS**：匿名映射
- **MAP_PRIVATE / MAP_SHARED**：私有与共享映射
- **MAP_FIXED / MAP_FIXED_NOREPLACE**：固定地址映射
- **MAP_STACK**：栈分配
- **HUGETLB**：大页支持（2MB/1GB，通过 `PageSize::Size2M/Size1G`）
- **文件映射**：通过 `aspace.map_file()` 将文件内容映射到内存
- **设备内存映射**：framebuffer 等设备内存可直接线性映射
- **MAP_SHARED 匿名映射**：使用 `aspace.map_shared()` 实现共享内存（mmap 级别）

**munmap**：调用 `aspace.unmap()` 解除映射

**mprotect**：更新映射区域的权限标志

**brk**：简单实现——仅在 `heap_bottom` 到 `heap_bottom + USER_HEAP_SIZE` 范围内调整 `heap_top`

---

### 3.4 文件系统 (VFS + 物理文件系统)

#### 3.4.1 VFS 抽象层（`ourkernel2026-vfs`）

`modules/vfs/` 定义了一套可复用的 VFS 抽象，与 ArceOS 的 `axfs-ng` 既有关联又有独立设计：

**核心类型**：

- `NodeOps<M: RawMutex>`：文件系统节点操作 trait
  - `inode()`, `metadata()`, `update_metadata()`, `filesystem()`, `size()`, `sync()`, `into_any()`
- `FileNodeOps<M>`：文件节点操作（`read_at()`, `write_at()`, `resize()`, `fallocate()`, `flush()`, `seek()`）
- `DirNodeOps<M>`：目录节点操作（`read_dir()`, `lookup()`, `create()`, `remove()`, `link()`, `symlink()`, `rename()`）
- `DirEntry<M>`：目录项（`Arc<Inner<M>>` 包装），统一表示文件或目录
- `Filesystem<M>`：文件系统实例
- `FilesystemOps<M>`：文件系统操作（`name()`, `root_dir()`, `stat()`）
- `Metadata`：完整的 POSIX 兼容元数据（inode、权限、uid/gid、时间戳、设备 ID 等）
- `NodeType`：节点类型枚举（Fifo、CharacterDevice、Directory、BlockDevice、RegularFile、Symlink、Socket）
- `NodePermission`：完整权限位（SET_OWNER、SET_GROUP、STICKY、OWNER/GROUP/OTHER R/W/X）
- `DeviceId`：包含 major/minor 编号

**路径解析**：`path.rs` 实现了 POSIX 兼容的路径解析（支持绝对/相对路径、`.` 和 `..`、符号链接跟随、挂载点穿越）

**挂载系统**：`mount.rs` 定义了 `Mountpoint`，支持将文件系统挂载到目录树的任意位置

#### 3.4.2 文件描述符管理

`api/src/core/file/fd.rs` 实现了完整的 FD 表：

- 基于 `FlattenObjects`（类似稀疏数组）的 O(1) 查找/插入
- 硬限制 `RLIMIT_MAX_FILES = 1024`
- 初始化时预设 stdin(0)、stdout(1)、stderr(2)
- 支持 `CLOSE_ON_EXEC` 标志（execve 时自动关闭）
- `FileLike` trait：统一的文件类对象接口（`read`, `write`, `status`, `poll`, `get_flags`, `set_flags`, `into_any`）
- 通过 `AxNamespace`（线程本地命名空间）实现 per-thread FD_TABLE 隔离

#### 3.4.3 动态文件系统框架

项目实现了两套动态文件系统框架（存在代码重复）：

**a) `api/src/core/fs/pseudo/dynamic.rs`**（API 层版本）：

```rust
pub struct DynamicFs {
    name: String,
    fs_type: u32,
    inodes: Mutex<Slab<()>>,
    root: Mutex<Option<DirEntry<RawMutex>>>,
}
```

- 使用 Slab 分配器管理 inode 编号
- `DynamicDir`：支持通过 `DynamicDirBuilder` 声明式构建目录树
- `DynamicFile`：简单文件节点

**b) `src/fs/dynamic/dynamic.rs`**（内核层版本）：

- API 相同但在内核层实现
- 被 devfs、procfs 使用

#### 3.4.4 伪文件系统实现

**devfs** (`src/fs/imp/dev.rs`)：

| 设备文件 | 类型 | Major/Minor | 功能 |
|---------|------|-------------|------|
| `/dev/null` | 字符设备 | 1:3 | 读取返回 0 字节，写入丢弃数据 |
| `/dev/zero` | 字符设备 | 1:5 | 读取返回零填充，写入无效果 |
| `/dev/random` | 字符设备 | 1:8 | 读取返回伪随机数 |
| `/dev/urandom` | 字符设备 | 1:9 | 同 random |
| `/dev/rtc0` | 字符设备 | 250:0 | 实时时钟（当前为空实现） |
| `/dev/shm` | 目录 | - | 挂载 tmpfs |

**procfs** (`src/fs/imp/proc.rs`)：

提供静态的 `/proc` 内容，包括：
- `/proc/stat`：硬编码的系统统计信息
- `/proc/cpuinfo`：硬编码的 CPU 信息（4 核 AMD Ryzen）
- `/proc/meminfo`：基本内存信息
- `/proc/version`、`/proc/filesystems`、`/proc/uptime` 等
- 部分 `/proc/sys/` 下的内核参数（`pid_max`, `shmmax`, `shmmni`, `pipe-max-size`, `lease-break-time`, `core_pattern`）

**tmpfs** (`src/fs/imp/tmp.rs`)：

完整的内存文件系统实现：
- 基于 BTreeMap 的目录结构
- Inode 通过 Slab 分配管理
- 支持创建/读取/写入/删除文件、目录操作
- 正确管理引用计数（InodeRef 在 Drop 时递减 nlink）
- 支持符号链接

#### 3.4.5 ext4 文件系统

`modules/lwext4_rust/` 通过 bindgen 将 C 语言 lwext4 库绑定到 Rust：

- `build.rs` 编译 lwext4 C 源码并生成 Rust FFI 绑定
- 提供 `BlockDevice` trait（抽象块设备接口）
- `Ext4Fs::mount()` 挂载 ext4 文件系统
- `Ext4File` / `Ext4Dir`：文件/目录操作
- 通过 `lwext4_rs` cargo feature 启用

#### 3.4.6 挂载系统

`mount_all()` 在初始化时挂载：
1. devfs -> `/dev`（内含 `/dev/shm` 挂载 tmpfs）
2. tmpfs -> `/tmp`
3. procfs -> `/proc`

---

### 3.5 信号处理

**位置**：`api/src/imp/task/signal.rs` + 外部依赖 `axsignal`

信号子系统基于 Starry-OS 的 `axsignal` crate，提供完整的 POSIX 信号支持。

**核心组件**：

- `ProcessSignalManager`：进程级信号管理（信号处理函数表、pending 信号集）
- `ThreadSignalManager`：线程级信号管理（per-thread 阻塞信号集、pending 信号集）
- `SignalActions`：信号处理动作表（`[SignalAction; 65]`，覆盖 1-64 号信号）
- `SignalAction`：包含 disposition（Default/Ignore/Handler）、flags（SA_RESTART 等）、mask、restorer

**实现的信号系统调用**：

| 系统调用 | 功能 |
|---------|------|
| `rt_sigaction` | 设置/获取信号处理动作 |
| `rt_sigprocmask` | 阻塞/解除阻塞信号 |
| `rt_sigpending` | 获取 pending 信号集 |
| `rt_sigqueueinfo` | 向进程发送带数据的信号 |
| `rt_tgsigqueueinfo` | 向线程发送带数据的信号 |
| `rt_sigsuspend` | 挂起并等待信号 |
| `rt_sigtimedwait` | 带超时的信号等待 |
| `rt_sigreturn` | 从信号处理函数返回 |
| `sigaltstack` | 设置/获取备用信号栈 |
| `kill` / `tkill` / `tgkill` | 发送信号 |

**信号发送流程**（`send_signal_thread` / `send_signal_process` / `send_signal_process_group`）：
1. 查找目标线程/进程
2. 调用 `signal.send_signal()` 将信号加入 pending 集
3. 在 POST_TRAP 回调中检查：`check_signals()` 在每次从用户态陷入后检查是否有未阻塞的 pending 信号
4. 如果有：根据 `SignalOSAction` 执行 Terminate/CoreDump/Stop/Continue/Handler
5. 如果为 Handler 类型：通过 axsignal 在用户栈设置信号帧，修改用户 IP 指向信号处理函数，ra 指向 trampoline

**信号 Trampoline**：映射在固定地址 `SIGNAL_TRAMPOLINE`（如 RISC-V 上为 `0x4001_0000`），信号处理函数返回后通过 trampoline 执行 `rt_sigreturn` 系统调用恢复上下文。

---

### 3.6 网络子系统

**位置**：`api/src/imp/net/socket.rs` + `api/src/imp/net/socketaddr.rs`

网络栈基于 ArceOS 的 `axnet` crate（提供 `TcpSocket`/`UdpSocket`）。

**Socket 枚举**：

```rust
pub enum Socket {
    Udp(Mutex<UdpSocket>),
    Tcp(Mutex<TcpSocket>),
}
```

实现了 `FileLike` trait，可作为文件描述符使用。

**支持的网络系统调用**：

| 系统调用 | 实现状态 |
|---------|---------|
| `socket` | AF_INET/AF_INET6, SOCK_STREAM/SOCK_DGRAM, TCP/UDP |
| `bind` | 支持 IPv4/IPv6 |
| `listen` | TCP 支持，UDP 返回 EOPNOTSUPP |
| `accept` | TCP 支持 |
| `connect` | TCP/UDP 均支持 |
| `sendto` | UDP 支持（自动 bind 到随机端口） |
| `recvfrom` | TCP/UDP 均支持 |
| `shutdown` | TCP/UDP 均支持 |
| `setsockopt` | SOL_SOCKET: SO_REUSEADDR, SO_RCVBUF, SO_SNDBUF; TCP: TCP_NODELAY |
| `getsockopt` | SOL_SOCKET: SO_ERROR, SO_RCVBUF, SO_SNDBUF, SO_REUSEADDR; TCP: TCP_MAXSEG, TCP_NODELAY |
| `getpeername` / `getsockname` | 获取对端/本地地址 |
| `sendmsg` / `sendmmsg` | 存根 |

**SocketAddr 处理**：`SockAddr` 提供了 `sockaddr_in`/`sockaddr_in6` 的安全封装，支持与 Rust 标准库 `SocketAddr` 类型的互相转换。

**非阻塞支持**：socket 可通过 `fcntl(O_NONBLOCK)` 或 `setsockopt` 设置为非阻塞模式。

---

### 3.7 管道 (Pipe)

**位置**：`api/src/core/file/pipe.rs`

基于 Ring Buffer 的无名管道实现：

```rust
pub struct PipeRingBuffer {
    arr: [u8; RING_BUFFER_SIZE],  // RING_BUFFER_SIZE = 65536 (PIPE_MAX_SIZE)
    head: usize,
    tail: usize,
    status: RingBufferStatus,     // Full/Empty/Normal
}
```

- **容量**：64KB（与 Linux PIPE_BUF 对齐）
- **读写语义**：阻塞/非阻塞模式；写端关闭时读返回 EOF；读端关闭时写收到 EPIPE
- **原子性**：非阻塞写入不超过 PIPE_BUF 时保证原子性
- **中断支持**：阻塞等待期间可被信号中断（通过 `task_yield_interruptable()`）
- **引用计数**：通过 `AtomicUsize` 追踪 reader/writer 数量

---

### 3.8 epoll

**位置**：`api/src/core/file/epoll.rs`

```rust
pub struct EpollInstance {
    events: Mutex<BTreeMap<usize, epoll_event>>,
}
```

支持的 epoll 操作：
- `EPOLL_CTL_ADD`：添加监控
- `EPOLL_CTL_MOD`：修改监控事件
- `EPOLL_CTL_DEL`：删除监控
- `epoll_wait`：通过 `poll_all()` 遍历所有监控的文件描述符，检查其 `poll()` 状态

限制：
- 不支持边缘触发（`EPOLLET`）——代码中有 TODO 注释
- `poll_all()` 为轮询模式（非事件驱动），每次 epoll_wait 都会全量检查

---

### 3.9 Futex

**位置**：`api/src/imp/task/futex.rs`

实现了 fast userspace mutex 的核心操作：

| 操作 | 实现状态 |
|------|---------|
| `FUTEX_WAIT` | 完整实现，支持超时和信号中断 |
| `FUTEX_WAKE` | 完整实现，唤醒指定数量的等待者 |
| `FUTEX_REQUEUE` | 完整实现，将等待者从一个 futex 迁移到另一个 |
| `FUTEX_CMP_REQUEUE` | 完整实现，条件迁移 |
| `FUTEX_WAIT_BITSET` | 仅支持 `FUTEX_BITSET_MATCH_ANY` |
| `FUTEX_WAKE_BITSET` | 仅支持 `FUTEX_BITSET_MATCH_ANY` |

关键实现细节：
- 使用 `BTreeMap<usize, Arc<WaitQueue>>` 管理每个用户态 futex 地址的等待队列
- `wait_futex_interruptible()` 以轮询间隔（10ms）检查 futex 值变化和 pending 信号，实现可中断等待
- 线程退出时（`sys_exit_impl`），清理 `clear_child_tid` 地址并通过 futex 唤醒等待者

---

### 3.10 共享内存 (SysV IPC)

**位置**：`core/src/shared_memory.rs` + `api/src/interface/mm/shm.rs`

**SharedMemoryManager**：

```rust
pub struct SharedMemoryManager {
    pub mem_map: Mutex<BTreeMap<u32, Arc<SharedMemory>>>,
    next_key: AtomicU32,
}
```

- 通过全局页分配器分配物理页面
- 支持 `IPC_PRIVATE`（自动分配 key）和指定 key
- `shmat`：将共享内存段映射到用户地址空间（使用 `map_linear`）
- `shmdt`：解除映射
- `shmctl(IPC_RMID)`：删除共享内存段
- `shmctl(IPC_STAT)`：标记为 ENOSYS（未实现）

---

### 3.11 资源限制

**位置**：`core/src/resource.rs`

定义了 15 种资源限制类型（与 Linux 的 `RLIMIT_*` 对齐）：

```rust
pub struct ResourceLimits([ResourceLimit; RLIM_NLIMITS as usize]);
```

默认值：
- `RLIMIT_STACK`：软限制 = `USER_STACK_SIZE`，硬限制 = 无限
- `RLIMIT_NOFILE`：软限制 = 1024，硬限制 = 1024
- `RLIMIT_CORE`：软限制 = 0（不生成 core dump）
- `RLIMIT_NPROC`：软/硬限制 = 10000
- 其余：均为无限

支持的资源限制系统调用：`getrlimit`、`setrlimit`、`prlimit64`（部分实现）。

---

### 3.12 评测框架

**位置**：`src/oscomp_runner.rs` + `apps/oscomp/`

评测框架专为 OS 内核竞赛设计：

- 从磁盘读取评测脚本（`*_testcode.sh`）
- 通过 busybox sh 执行评测命令
- 支持 `run_test_script` 自定义命令
- 平台特定测试（如 RISC-V 上运行 iozone、libcbench）
- Python 评测脚本：`judge_basic.py`、`judge_busybox.py`、`judge_iozone.py`、`judge_libctest.py`、`judge_lua.py`

---

### 3.13 时间管理

**位置**：`core/src/ctypes.rs` + `api/src/imp/task/schedule.rs`

- **TimeStat**：per-task 的用户态/内核态时间统计，支持三种定时器（REAL/VIRTUAL/PROF）
- **POSIX Timer**：实现了 `timer_create/settime/gettime/getoverrun/delete`，通过独立内核任务实现定时器到期通知
- 定时器到期后通过 SIGEV_SIGNAL/SIGEV_THREAD_ID 机制发送信号
- **CPU Affinity**：`sched_getaffinity/sched_setaffinity` 完整实现

---

### 3.14 proc-macro：syscall_trace

**位置**：`syscall_trace/src/lib.rs`

`#[syscall_trace]` 属性宏自动为系统调用函数添加：
- 进入日志：`debug!("[syscall] <= func_name(arg1 = ..., arg2 = ...)")`
- 返回日志：`debug!("[syscall] => func_name(arg1 = ..., arg2 = ...) = result")`
- 智能格式化：`UserInPtr<c_char>` 自动以字符串形式显示，`UserPtr<T: Debug>` 显示内存内容，`UserOutPtr` 仅显示地址
- 错误结果使用 `info!` 级别（因为错误通常更重要）

---

## 四、子系统交互关系

```
用户态程序
    │
    │ 系统调用 (ecall / syscall 指令)
    ▼
┌─────────────────────────────────────────────┐
│ src/syscall.rs: 系统调用分发                  │
│   根据 sysno 路由到 api/imp 或 api/interface  │
└────┬──────┬──────┬──────┬──────┬────────────┘
     │      │      │      │      │
     ▼      ▼      ▼      ▼      ▼
┌─────┐┌─────┐┌─────┐┌─────┐┌──────────┐
│进程  ││内存  ││文件  ││信号  ││网络/其他  │
│管理  ││管理  ││系统  ││处理  ││          │
└──┬──┘└──┬──┘└──┬──┘└──┬──┘└────┬─────┘
   │      │      │      │        │
   ▼      ▼      ▼      ▼        ▼
┌──────────────────────────────────────────────┐
│ starry-core: 内核核心状态                      │
│   ProcessData, ThreadData, TaskExt,           │
│   AddrSpace, ResourceLimits, SharedMemory     │
└────────────┬─────────────────────────────────┘
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
┌──────┐┌──────┐┌──────────────┐
│process││axmm  ││ourkernel-    │
│crate  ││(ArceOS)│vfs           │
│       ││      ││              │
└──────┘└──────┘└──────┬───────┘
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
          ┌─────┐ ┌─────┐ ┌──────────┐
          │devfs│ │procfs│ │tmpfs/ext4│
          └─────┘ └─────┘ └──────────┘
             │
             ▼
┌──────────────────────────────────────────────┐
│ ArceOS 基础设施层                              │
│   axhal, axmm, axtask, axalloc, axfs-ng,     │
│   axnet, axsignal, axns, axsync, axlog       │
└──────────────────────────────────────────────┘
```

**关键交互流程**：

1. **clone/execve 流程**：
   - clone: `syscall.rs` -> `clone.rs` -> `process::fork()` + `ProcessData::new()` + `create_user_task()` + `axtask::spawn_task()`
   - execve: `syscall.rs` -> `execve.rs` -> 清空地址空间 -> `load_user_app()` -> 重置 `ProcessData` -> 设置 `TrapFrame`

2. **文件 I/O 流程**：
   - `syscall.rs` -> `fd.rs` (fd_lookup) -> `FileLike` trait -> VFS 层 (`DirEntry`/`FileNode`) -> 具体文件系统 (tmpfs/devfs/procfs/ext4)

3. **信号发送流程**：
   - `kill/tkill` -> `send_signal_process/thread` -> `ProcessSignalManager::send_signal()` -> POST_TRAP 检查 -> `check_signals()` -> 设置 TrapFrame  redirect 到信号处理函数

4. **内存管理流程**：
   - `mmap` -> `ProcessData.addr_space.lock()` -> `AddrSpace::map_alloc/map_file/map_linear` -> 页错误处理（CoW、惰性分配）

---

## 五、实现完整度评估

以 Linux 内核为基准（100%），对该项目的各个子系统的完整度评估如下：

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 进程/线程模型 | 75% | 完整的 POSIX 层级（Session/ProcessGroup/Process/Thread），支持 clone flags、wait、exit 语义。缺少 cgroup、namespace 完全支持 |
| 内存管理 | 60% | mmap/munmap/mprotect/brk 完整，CoW 和惰性分配由 axmm 支持。缺少 mlock/madvise 真正实现、swap、KSM |
| 文件系统 | 55% | VFS 抽象层完整，tmpfs/devfs/procfs 可用。ext4 通过 lwext4 支持。缺少完整权限检查、inotify、fanotify、xattr |
| 信号处理 | 80% | 大部分 POSIX 信号系统调用已实现。缺少 job control（SIGSTOP/SIGCONT 行为）、core dump |
| 网络 | 50% | TCP/UDP 基本可用。缺少 Unix domain socket、原始 socket、完整 socket option、sendmsg/recvmsg、SCTP |
| IPC | 40% | 管道、futex 完整实现，SysV 共享内存基本可用。缺少消息队列、信号量、POSIX 消息队列 |
| 时间管理 | 55% | 基本时钟和 POSIX timer 可用。缺少 NTP 相关（adjtimex）、alarm、setitimer/getitimer |
| 调度 | 35% | 使用 axtask 调度器。SCHED_OTHER/RR/FIFO 有部分支持，CPU affinity 完整。缺少 CFS、NUMA、完整优先级调度 |
| 安全/权限 | 20% | 基本 uid/gid 结构存在，但 setuid/setgid 等为存根。缺少 capabilities、SELinux、seccomp |
| 设备驱动 | 30% | 基本字符设备框架，/dev/null/zero/random。缺少块设备层、完整设备模型、大多数真实驱动 |
| 系统调用覆盖 | 60% | ~140 个系统调用被处理，~90 个有实质实现。大量高级系统调用为存根 |

**综合评估**：该项目整体实现完整度约为 **55%**（相对于完整 Linux 内核），但对于 OS 内核竞赛场景已实现了核心 POSIX 兼容性。

---

## 六、设计创新性分析

### 6.1 架构创新

1. **三层 API 架构**：`api/` crate 的 `core/imp/interface` 三层分离是一个精心设计的架构选择：
   - `interface/` 直接面向系统调用分发，处理用户态指针转换
   - `imp/` 实现核心业务逻辑，不关心用户态内存安全
   - `core/` 定义可复用的内核数据结构
   
   这种分离使得代码具有良好的关注点分离和可测试性。

2. **类型安全的用户指针**：`PtrWrapper` trait 及其实现（`UserPtr`、`UserInPtr`、`UserOutPtr`、`UserConstPtr`）提供了对用户态内存的类型安全访问。每个指针在解引用前都会验证其地址范围和权限，防止内核访问非法用户内存。这是 Rust 类型系统的一个很好的应用。

3. **命名的系统调用追踪宏**：`#[syscall_trace]` proc-macro 能够智能识别参数类型（特别是 `UserInPtr<c_char>` 自动以字符串格式显示，`UserOutPtr` 仅显示地址），大大提升了系统调用调试体验。

### 6.2 设计特色

4. **VFS 抽象与 ArceOS 的关系**：项目实现了一套独立的 VFS 抽象（`ourkernel2026-vfs`），与 ArceOS 的 `axfs-ng` 并行使用。这种"双重 VFS"设计使得项目可以同时使用 ArceOS 提供的文件系统能力和自己实现的伪文件系统。

5. **动态文件系统框架**：`DynamicFs` + `DynamicDirBuilder` 的组合允许以声明式方式构建伪文件系统，代码极其简洁。例如 devfs 的构建仅需几十行代码。

6. **进程模型纯数据分离**：`ourkernel2026-process` crate 是零外部依赖的纯数据结构层，仅依赖 `spin` crate。这种设计使得进程/线程模型可以在不引入 ArceOS 依赖的情况下独立测试和维护。

7. **线程本地命名空间**：通过 `AxNamespace` 实现线程本地资源隔离（FD_TABLE、FS_CONTEXT），支持 `CLONE_FILES`/`CLONE_FS` 等 clone flag 的正确语义。

### 6.3 潜在改进方向

- 代码重复：`api/src/core/fs/pseudo/dynamic.rs` 和 `src/fs/dynamic/dynamic.rs` 存在大量重复代码，应合并
- 竞态条件：exit 流程中 `exit_group` 的多次调用防护标记为 TODO
- 部分系统调用实现过于简单（如 `/proc` 内容为硬编码静态字符串）

---

## 七、代码统计数据

| 指标 | 数值 |
|------|------|
| 自有 Rust 源文件（不含 vendor/arceos） | ~140 个 |
| 自有代码行数 | ~22,111 行 |
| Cargo workspace 成员 | 6 个（不含 arceos 和 lwext4_rust） |
| 已处理系统调用号 | ~140 个 |
| 实质性实现的系统调用 | ~90 个 |
| 存根系统调用 | ~50 个 |
| 支持 CPU 架构 | 4 个 |
| 进程模型层级 | 4 层（Session/ProcessGroup/Process/Thread） |
| VFS 节点类型 | 7 种 |
| 资源限制类型 | 15 种 |

---

## 八、总结

OurKernel2026 是一个基于 ArceOS 框架的 Rust 宏内核操作系统项目，面向 OS 内核竞赛设计。其主要优势在于：

1. **扎实的 POSIX 兼容性**：实现了约 90 个核心系统调用，覆盖文件 I/O、进程管理、信号处理、内存管理、网络通信等关键领域，能够运行 busybox、lua、iozone 等真实用户态应用。

2. **清晰的架构分层**：三层 API 架构（interface/imp/core）加上独立的进程模型 crate 和 VFS crate，体现了良好的软件工程实践。

3. **多架构支持**：同时支持 RISC-V 64、x86_64、AArch64、LoongArch64 四个 CPU 架构，在竞赛项目中具有较强的通用性。

4. **充分利用 Rust 类型系统**：`UserPtr`、`FileLike`、`PtrWrapper` 等类型安全抽象有效防止了常见的内核漏洞。

5. **模块化设计**：VFS 抽象、动态文件系统框架、进程模型等模块设计合理，具有良好的可扩展性。

不足之处主要在于部分系统调用实现不完整（以存根方式绕过）、安全权限系统基本空缺、以及存在一定代码重复。但总体而言，该项目是一个设计良好、实现扎实的 OS 内核竞赛作品。