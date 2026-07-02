# MyGO!!!!! OS 内核项目深度技术分析报告

## 一、分析过程说明

本报告基于以下分析手段：

1. **源码静态分析**：对 508 个 Rust 源文件（约 226,619 行代码）进行了系统性审查，覆盖所有核心子系统和辅助库。
2. **结构分析**：通过 Cargo workspace 结构和模块依赖关系分析了分层架构。
3. **接口契约分析**：通过 HAL trait 定义、arch 注入点、sched hook 等分析了子系统间交互协议。
4. **文档与注释审查**：以实现代码为唯一事实依据，文档仅作参考。
5. **未进行运行时测试**：由于环境中缺少 LoongArch64 和 RISC-V 交叉编译所需的特定 QEMU 配置以及完整的 busybox 构建链路，未进行实际构建与 QEMU 启动测试。

---

## 二、项目总体架构

### 2.1 分层模型

MyGO!!!!! OS 采用严格的层次化架构，自底向上分为：

```
┌──────────────────────────────────────┐
│          kernel crate                │  ← syscall 实现、启动流程、基准测试
├──────────────────────────────────────┤
│          general crate               │  ← 架构无关的通用实现（VFS具体、MM通用、设备框架）
├──────────────────────────────────────┤
│          hal crate                   │  ← 硬件抽象层（trait 定义）
├──────────────────────────────────────┤
│          arch crate                  │  ← 架构特定实现（LoongArch64 / RISC-V64）
├──────────────────────────────────────┤
│          libs/*                      │  ← 独立功能库（调度、VFS、网络、分配器等）
└──────────────────────────────────────┘
```

### 2.2 Cargo Workspace 成员（20 个 crate）

| Crate | 定位 | 代码量级 |
|---|---|---|
| `kernel` | 内核二进制，syscall实现，启动流程 | ~15,800行 |
| `general` | 架构无关通用实现 | ~38,900行 |
| `hal` | 硬件抽象接口定义 | ~500行 |
| `arch` | 架构特定（LA64 + RV64） | ~5,000行 |
| `libs/sched` | 调度器核心 | ~7,500行 |
| `libs/allocator` | 物理/虚拟内存分配器 | ~12,000行 |
| `libs/vfs` | 虚拟文件系统层 | ~14,000行 |
| `libs/extfs` | ext2/3/4 驱动 | ~5,500行 |
| `libs/fatfs` | FAT12/16/32 驱动 | ~5,000行 |
| `libs/net` | 网络协议栈封装 | ~11,000行 |
| `libs/mygo-smoltcp` | TCP/IP 协议栈(fork) | ~20,000行 |
| `libs/socket` | Unix 域套接字 | ~2,000行 |
| `libs/mm` | VMA 数据模型 | ~1,500行 |
| `libs/elf` | ELF 解析 | ~1,200行 |
| `libs/acpi` | ACPI 解析(fork) | ~6,000行 |
| `libs/errno` | 错误码定义 | ~300行 |
| `libs/log` | 内核日志 | ~400行 |
| `libs/ktest` | 内核测试框架 | ~800行 |
| `libs/efi` | EFI 支持 | ~500行 |

---

## 三、子系统详细拆解

### 3.1 进程管理子系统

#### 3.1.1 任务控制块（TCB）

`Task` 结构体（`libs/sched/src/task.rs`, 1387行）是调度器管理的最小实体，设计上**不依赖全局 PID 表**，任务身份即为 `Arc<Task>`：

```rust
// 父子关系通过 Weak/Arc 直接互引
// parent ── Weak ──▶ Task
// Task ◀── 子的 parent: Weak ──
```

关键设计决策：
- **生命周期规则**：活跃任务由父的 `children` 列表和运行队列/等待队列双重保活；exit 后变 Zombie 等待父 reap；父先死时子自动 reparent 到 init。
- **扩展机制**：通过 `TaskExtKey` + `Arc<dyn Any + Send + Sync>` 实现类型安全的扩展槽，VFS上下文、FdTable、VmSpace、用户trap frame等都通过此机制挂载，避免 `Task` 结构体无限膨胀。
- **原子状态**：任务状态通过 `AtomicU8` 表示，支持 CAS 状态转换。

定义了完善的诊断接口 `TaskDiag`，可实时追踪 live/zombie/dead 任务数量、引用计数、信号 pending 等指标。

#### 3.1.2 EEVDF 调度器

调度算法采用 Linux 6.6+ 引入的 **EEVDF（Earliest Eligible Virtual Deadline First）**（`libs/sched/src/eevdf.rs`）：

核心概念：
- **vruntime**：虚拟时间轴上的累计运行量，权重越大走得越慢
- **avg_vruntime**：运行队列加权平均，作为 eligible 基线
- **eligible 条件**：`vruntime <= avg_vruntime`
- **deadline**：`vruntime + slice * NICE_0_WEIGHT / weight`
- **lag 保存/恢复**：离开 rq 时保存 `lag = avg_vruntime - vruntime`，重新入队时恢复，避免长睡眠任务获得不公平额度

权重系统对齐 Linux 内核 `sched_prio_to_weight` 表（nice=-20→88761, nice=0→1024, nice=19→15），相邻两级比率约 1.25。

实现了完整的 `SchedEntity` 结构，支持 `Fair`、`RT`（FIFO/RR）、`Deadline`（EDF+bandwidth）和 `Idle` 四种调度类别。

#### 3.1.3 运行队列

`Runqueue`（`libs/sched/src/runqueue.rs`）内部按优先级分层：
```
Deadline(BTreeMap) > Realtime(BTreeMap) > Fair(BTreeMap) > Idle(BTreeMap)
```

- Fair class 使用 EEVDF，按 deadline 排序
- RT class 按 `(priority, seq, addr)` 排序，支持 FIFO/RR
- Deadline class 按 EDF 的绝对 deadline 排序，含 budget 耗尽后的 throttled 队列
- 使用 `BTreeMap` 作为每层队列的底层数据结构

#### 3.1.4 进程操作

`libs/sched/src/operation.rs`（2096行）实现了 POSIX 进程操作的核心状态机：

- **fork/clone**：通过 `CloneFlags` 控制资源共享粒度（`CLONE_VM`, `CLONE_FS`, `CLONE_FILES`, `CLONE_NEWNS` 等），支持 `clone3` 系统调用的 `CloneArgs` 结构
- **execve**：通过 `ExecRequest` + `ProcessImageOps` trait 实现用户态镜像替换，支持 shebang 脚本（最多4层递归）
- **exit/exit_group**：Zombie 状态机，等待父进程 reap
- **wait4/waitid**：支持 `WNOHANG`, `WUNTRACED`, `WCONTINUED` 等选项

#### 3.1.5 PID 管理

`libs/sched/src/pid.rs` 实现了层级 PID namespace：
- 每个 namespace 维护 `BTreeMap<PidT, Weak<Task>>` 注册表
- 支持 `tgid`（线程组ID）缓存
- `PidT` 为全局单调递增整数

#### 3.1.6 信号处理

`libs/sched/src/signal.rs` 实现了完整的 POSIX 信号子系统：

- **64 个信号**：标准信号 1-31 + 实时信号 32-64
- **per-task 信号状态**：`SignalState` 含 pending bits（原子）、pending infos（锁保护队列）、blocked mask、saved mask
- **per-thread-group 共享信号**：`SharedSignal` 提供线程组级别的共享 pending 队列
- **sigaction**：支持 `SA_ONSTACK`, `SA_NODEFER`, `SA_RESETHART`, `SA_RESTART`, `SA_SIGINFO`
- **默认动作**：Term/Core/Stop/Cont/Ign 五类
- **SIGKILL/SIGSTOP 不可屏蔽**：在 `SigSet::sanitized()` 中强制剥离

信号投递路径：`kill/tkill/tgkill` → `send_signal` → `signal_wakeup`（设置 `TIF_SIGPENDING` + 唤醒），在 trap 返回路径检查并调用 `do_signal` 铺设 sigframe。

#### 3.1.7 futex 实现

futex（快速用户空间互斥锁）实现（`kernel/src/syscalls/process.rs` 2340-2700行附近）是一个完整的状态机：

- **分片哈希表**：`FutexKey` → `FutexBucket`，键由 VmSpace 地址 + 私有/共享属性决定
- **三态协议**：`ARMED`(已登记未睡眠) → `SLEEPING`(已切出CPU) → `WOKEN`(已被唤醒)
- **支持的操作**：
  - `FUTEX_WAIT` / `FUTEX_WAKE`：基本等待/唤醒
  - `FUTEX_REQUEUE`：将 waiter 从源 futex 迁移到目标 futex
  - `FUTEX_WAKE_OP`：原子 RMW 操作 + 条件唤醒（支持 SET/ADD/OR/ANDN/XOR）
  - `FUTEX_LOCK_PI` / `FUTEX_UNLOCK_PI`：优先级继承
  - `FUTEX_WAIT_BITSET` / `FUTEX_WAKE_BITSET`：bitset 过滤
  - `FUTEX_FD`：文件描述符关联
  - `FUTEX_CMP_REQUEUE_PI`：条件 requeue + PI
- **robust list**：支持 `set_robust_list`/`get_robust_list`，在任务退出时遍历处理 `FUTEX_OWNER_DIED`
- **private 优化**：`FUTEX_PRIVATE_FLAG` 使 futex 仅在同一 VmSpace 内查找，避免全局锁

### 3.2 内存管理子系统

#### 3.2.1 物理页分配器（Buddy）

`libs/allocator/src/buddy.rs`（2545行）实现了基于伙伴算法的物理页分配器：

- **多段支持**：不假设整块连续 RAM，支持来自 DTB/ACPI 的多个 `MemorySegment`
- **多 zone**：`VM_FREELIST_DEFAULT` + `VM_FREELIST_DMA`（16MiB 以下）
- **延迟合并**：保留最多 128 个 order-0 热页避免 split/merge 抖动，空闲率低于 25% 时禁用
- **order 范围**：从 `PAGE_SIZE`(4KiB) 到 `MAX_TRACKED_ORDER`（受 usize 位宽限制）
- **页状态**：`Free`/`Allocated`/`BuddyTail`/`Reserved`
- **稀疏实现**：不再为整机 RAM 物化全局 `PageInfo[]`，仅在分配时记录必要元数据

#### 3.2.2 Slab 分配器

`libs/allocator/src/slab.rs`（1700行）实现了小对象 slab 分配器：

- **14 个 size class**：8, 16, 32, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048 字节
- **per-CPU 缓存**：每个 CPU 每个 size class 有 32 个槽位，热路径优先命中
- **批量补货**：缓存失配时一次补 8 个对象
- **位图管理**：每 slab 8 个 u64 位图字
- **统计接口**：`SlabStats` + `SlabClassStat` 提供详细的分配/释放/命中/失败统计

#### 3.2.3 虚拟内存管理

`general/src/mm/vm_space.rs`（1796行）实现了 `VmSpace`——进程地址空间的顶层对象：

- **VMA 管理**：基于 `libs/mm` 的 `VmaSet`（BTreeMap 实现），支持插入/查找/分裂/合并/裁剪
- **COW（写时复制）**：fork 时将私有可写页标记为只读，写访问时触发 COW 分裂
- **共享页**：`SHARED_FILE_PAGES`（文件映射）和 `SHARED_ANON_PAGES`（匿名共享）全局表，用 `Weak<ResidentPage>` 避免循环引用
- **futex key**：`VmFutexKey` 枚举区分 `Private`/`SharedFile`/`SharedAnon`，确保跨进程 futex 按底层物理页匹配
- **按需分页**：`handle_fault` 处理 Load/Store/Exec/Perm 各类缺页

#### 3.2.4 页错误处理

`general/src/mm/fault.rs` 实现了通用的缺页分派：

- 从 arch 注入的 `FaultDecodeOps` 提取类型/地址/来源权级
- 内核态访问用户 buffer 时先尝试 `__ex_table` fixup
- 用户态触发时委托 `VmSpace::handle_fault` 处理
- 返回 `Fixed`/`Segv`/`Kernel` 三类结果

#### 3.2.5 架构特定页表

- **RISC-V64**（`arch/src/riscv64/paging.rs`）：Sv48 四级页表，支持 4KiB/2MiB/1GiB 大页，`Riscv64Pte` 封装 PTE 位操作
- **LoongArch64**：DMW（直接映射窗口）+ 多级页表混合方案

### 3.3 文件系统子系统

#### 3.3.1 VFS 层

`libs/vfs/` 是 VFS 的核心抽象层：

**Dentry 缓存**（`dentry.rs`, 1220行）：
- 正向/负向缓存，`SmallStr` 内联短名称（<16字节零堆分配）
- 分片哈希表（按 `(parent_ptr, name)` 选片），降低多核竞争
- `AtomicU8` 状态（正向/负向/失效）实现无锁热路径判断
- 有界缓存策略：负向项和总条目均有分片上限

**Inode**（`inode.rs`, ~600行）：
- `Arc<Inode>` 共享所有权，`Weak<Superblock>` 打破引用环
- 不可变字段（id/kind/rdev）无锁读取
- 可变元数据（size/nlink/mode/uid/gid/timestamps）受 `Spinlock` 保护，size 和 nlink 额外镜像到原子字段
- `InodeOps` trait object 解耦 VFS 与具体文件系统

**Superblock**（`superblock.rs`）：
- 分片 Inode 缓存（8 个独立 `Spinlock<BTreeMap>`），按 `ino % 8` 选片
- `FsDriver` trait + `FsRegistry` 全局注册表
- Mount 与 Superblock 分离：挂载标志属于 Mount，文件系统属性属于 Superblock

**挂载命名空间**（`mount.rs`）：
- `Mount` 树结构，支持 `MountNamespace` 隔离
- `open_count` 引用计数判断"挂载点是否繁忙"
- 可见路径计算（跨挂载点拼接）

**File 对象**（`file.rs`）：
- 打开时冻结凭据和打开选项（TOCTOU 防护）
- `pos_lock` 串行化偏移操作，pread/pwrite 不修改偏移
- `Drop` 时自动调 `FileOps::release`

**管道**（`pipe.rs`）：
- 64KB 环形缓冲区
- `WaitQueue` 驱动的阻塞读/写
- 读写端计数追踪

**epoll**（`epoll.rs`）：
- 独立的 `epollfs` 内部文件系统承载 epoll fd
- 支持 `EPOLL_CTL_ADD/DEL/MOD`、`EPOLLET`（边缘触发）、`EPOLLONESHOT`
- 通过 `FileOps::poll()` 回调检测就绪状态

**eventfd/timerfd/signalfd**：均有实现，集成在 `libs/vfs/` 中。

**文件锁**（`flock.rs`, `record_lock.rs`, `lease.rs`）：支持 BSD `flock` 和 POSIX `fcntl` 记录锁。

**套接字抽象**（`socket.rs`, `net_socket.rs`, `netlink_socket.rs`）：为 Unix 域套接字和网络套接字提供统一的 VFS 接口。

#### 3.3.2 具体文件系统

**tmpfs**（`general/src/vfs/tmpfs.rs`）：
- 完全内存驻留，`BTreeMap<SmallStr, Arc<Inode>>` 组织目录
- 支持普通文件读写、目录操作、符号链接
- 全局实例计数器生成唯一 `fs_id`

**procfs**（`general/src/vfs/procfs.rs`, 2863行）：
- 静态 ino 分配（`/proc/version`, `/proc/cpuinfo`, `/proc/meminfo`, `/proc/uptime`, `/proc/stat`, `/proc/devices`, `/proc/filesystems`, `/proc/mounts`, `/proc/mountinfo`, `/proc/sys/...` 等）
- 动态 per-task 条目：`/proc/[pid]/status`, `stat`, `cmdline`, `environ`, `comm`, `maps`, `fd/`, `task/`, `exe`, `cwd`, `root`, `mountinfo`, `mounts`
- 通过 sched 和 VFS 钩子获取进程/内存/设备信息

**sysfs**（`general/src/vfs/sysfs.rs`, 3415行）：
- `/sys/devices`, `/sys/block`, `/sys/class`, `/sys/bus`, `/sys/kernel`, `/sys/fs`, `/sys/power`, `/sys/firmware`
- PnP 设备树投影，device function 注册表兼容层

**devtmpfs**（`general/src/vfs/devtmpfs.rs`, 2932行）：
- 设备节点直接持有 `CharDevice` 或 `Arc<BlockDevice>` 引用，`open()` 零查找
- 支持字符设备、块设备、符号链接的动态增删
- 通过 `DeviceFunctionEvent` 订阅设备热插拔

**extfs**（`libs/extfs/`）：
- **从零手写**的 ext2/3/4 驱动，含写支持
- **extent tree** 遍历（`extent.rs`），支持内节点 + 叶节点
- **inline_data** 最小支持
- **HTree 目录**：读路径走线性扫描（HTree 仅加速查找）
- **fast/slow symlink**：≤60 字节走 i_block
- **METADATA_CSUM**：读侧验证超级块/inode 的 crc32c
- **块缓存**：O(log n) BTreeMap 索引 + Clock eviction，8192 槽
- 显式拒绝：日志未回放、ENCRYPT/VERITY/CASEFOLD 等不兼容特性

**fatfs**（`libs/fatfs/`）：
- **从零手写**的 FAT12/16/32 驱动
- BPB 校验、FSInfo 维护、LFN（含 Unicode checksum）、SFN 冲突检测
- 目录扩容、文件截断、O_APPEND 原子追加
- 共享 FAT 扇区缓存（最小 LRU），卸载前 flush

#### 3.3.3 设备文件投影

`general/src/vfs/device_files/` 实现了设备文件到具体驱动的投影机制：
- `projection.rs`：管理 `PublishedDevNode` 发布状态机
- `rtc.rs`：RTC 设备文件
- `loop_device.rs`：loop 设备文件
- `cpu_dma_latency.rs`：CPU DMA latency 设备
- `spec.rs`：`DevNodeSpec` / `CustomDevNodeSpec` 设备节点规格

#### 3.3.4 用户态 API 接口

`general/src/vfs/user_api/` 提供面向用户的接口适配：
- `block_device.rs`：块设备 ioctl（`BLKGETSIZE`, `BLKSSZGET` 等）
- `net_socket.rs`：网络 socket ioctl（`SIOCGIFCONF`, `SIOCGIFFLAGS`, `SIOCGIFADDR` 等 20+ 命令）
- `tty.rs`：TTY ioctl（termios, winsize）
- `ioctl.rs`：通用 ioctl 分发框架
- `device_numbers.rs`：设备号管理
- `shm.rs`：共享内存用户接口

### 3.4 系统调用子系统

#### 3.4.1 分发框架

`general/src/syscall.rs` 实现了架构无关的系统调用分发：

- **`SyscallFrameOps`**：arch 注入 4 个回调（取号、读参、写返回值、推进PC）
- **`SYSCALL_TABLE`**：512 槽的 `AtomicUsize` 表，启动期填表
- **`SyscallContext`**：封装 trap frame、当前 task、syscall 号、6 个参数
- **`dispatch`**：主分发循环，查表调用，末尾统一写返回值 + 推进 PC
- **`frame_finalized`**：execve/sigreturn 等已重写 trap frame 的 syscall 可跳过默认收尾

#### 3.4.2 系统调用覆盖

`kernel/src/syscalls/nr.rs` 定义了 346 个 Linux asm-generic syscall 号常量，另有私有号 `SYS_MYGO_SCHED_INFO=510`。

**文件系统 syscall**（`fs.rs`, 4368行）：约 80 个 syscall，覆盖：
- 基本 I/O：read/write/readv/writev/pread64/pwrite64/close/lseek
- 文件操作：openat/faccessat/faccessat2/fstat/newfstatat/statx/readlinkat/getcwd
- 目录操作：mkdirat/unlinkat/renameat2/linkat/symlinkat/mknodat/getdents64
- 元数据：fchmod/fchmodat/fchownat/fchown/utimensat/truncate/ftruncate
- 同步：fsync/fdatasync/sync/syncfs/sync_file_range
- 扩展属性：setxattr/lsetxattr/fsetxattr/getxattr/lgetxattr/fgetxattr
- 事件通知：eventfd2/timerfd_create/timerfd_settime/timerfd_gettime/signalfd4
- epoll：epoll_create1/epoll_ctl/epoll_pwait
- 文件锁：flock
- 挂载：mount/umount2/pivot_root/chdir/fchdir/chroot
- 网络 socket：socket/socketpair/bind/listen/accept/accept4/connect/getsockname/getpeername/sendto/recvfrom/sendmsg/recvmsg/sendmmsg/recvmmsg/setsockopt/getsockopt/shutdown
- 发送文件：sendfile/copy_file_range
- 预读/建议：readahead/fadvise64
- 文件分配：fallocate
- close_range

**进程 syscall**（`process.rs`, 4079行）：约 55 个 syscall，覆盖：
- 标识：getpid/gettid/getppid/getuid/geteuid/getgid/getegid
- 生命周期：exit/exit_group/clone/clone3/execve/execveat
- 等待：wait4/waitid
- 进程组/会话：setpgid/getpgid/getsid/setsid
- 调度：sched_yield/sched_setparam/sched_getparam/sched_getscheduler/sched_setscheduler/sched_getaffinity/sched_setaffinity/sched_get_priority_max/sched_get_priority_min/sched_rr_get_interval/sched_setattr/sched_getattr
- 信号：kill/tkill/tgkill/rt_tgsigqueueinfo
- 定时器：nanosleep/clock_nanosleep/clock_gettime/clock_getres/getitimer/setitimer
- 资源：getrlimit/setrlimit/prlimit64/getrusage/times/sysinfo
- 凭证：setreuid/setresuid/setresgid/setfsuid/setfsgid/setregid/getgroups/setgroups
- futex：完整实现
- rseq：注册/注销
- robust_list：注册/获取
- membarrier：全局内存屏障
- prctl：部分选项
- uname/sethostname/setdomainname
- getcpu/getrandom/gettimeofday
- personality
- reboot

**内存管理 syscall**（`mm.rs`, 482行）：
- brk/munmap/mmap/mprotect/madvise/msync/mremap/mincore
- mlock/munlock/mlock2/mlockall/munlockall

**信号 syscall**（`signal.rs`, 389行）：
- rt_sigaction/rt_sigprocmask/rt_sigpending/rt_sigsuspend/rt_sigtimedwait/rt_sigqueueinfo/rt_sigreturn/sigaltstack/restart_syscall

**IPC syscall**（`ipc.rs`, 343行）：
- shmget/shmat/shmdt/shmctl（System V 共享内存）
- semget/semctl/semtimedop/semop（信号量）
- msgget/msgctl/msgsnd/msgrcv（消息队列）

**syslog syscall**（`syslog.rs`, 82行）：
- syslog 系统调用（内核日志读取）

### 3.5 设备驱动子系统

#### 3.5.1 设备驱动框架

`general/src/dev/` 提供了完整的设备驱动框架：

- **PnP 总线**（`pnp.rs`, 1658行）：通用即插即用设备抽象，`PnpDevice` + `PnpDriver` + `PnpBusInfo` trait
- **PCI 子系统**（`pci.rs`, 1627行）：PCI/PCIe 设备封装，config space 访问、BAR 映射、MSI/MSI-X、bus master 控制
- **VirtIO 框架**（`virtio.rs`, 1382行 + `virtio_mmio.rs`）：MMIO 传输层
- **块设备层**（`block.rs`, `block_sync.rs`, `bio.rs`）：`BlockDevice` + `BlockDriver` + `Bio` 请求
- **中断管理**（`irq.rs`, `msi.rs`）：中断请求、MSI 分配
- **DMA**（`dma.rs`）：DMA 约束、反弹缓冲区策略
- **RTC 框架**（`rtc.rs`）：实时时钟抽象

#### 3.5.2 具体设备驱动

| 驱动 | 位置 | 说明 |
|---|---|---|
| virtio_blk | `drivers/virtio_blk.rs` + `virtio_block_common.rs`(1385行) | VirtIO 块设备，共享通用逻辑 |
| virtio_net | `drivers/virtio_net.rs` | VirtIO 网络设备 |
| virtio_pci | `drivers/virtio_pci.rs` | VirtIO PCI 传输层 |
| uart16550 | `drivers/uart16550.rs` | NS16550 兼容串口 |
| plic | `drivers/plic.rs` | RISC-V PLIC 中断控制器 |
| loongson_irq | `drivers/loongson_irq.rs` | 龙芯中断控制器 |
| ls7a_rtc | `drivers/ls7a_rtc.rs` | 龙芯 7A RTC |
| goldfish_rtc | `drivers/goldfish_rtc.rs` | Goldfish RTC |
| random | `drivers/random.rs` | 硬件随机数 |
| fw_cfg | `drivers/fw_cfg.rs` | QEMU fw_cfg 接口 |
| cfi_flash | `drivers/cfi_flash.rs` | CFI Flash |
| syscon | `drivers/syscon.rs` | 系统控制器 |
| loopback | `drivers/loopback.rs` | 回环块设备 |

### 3.6 网络子系统

#### 3.6.1 TCP/IP 协议栈

`libs/mygo-smoltcp/` 是 fork 自 smoltcp 0.12.0 的 TCP/IP 协议栈，包含：
- IPv4/IPv6 双栈
- TCP（8736行，完整状态机）
- UDP
- ICMP/ICMPv6
- DHCPv4 客户端
- 以太网/RPL/6LoWPAN 等链路层

#### 3.6.2 网络栈封装

`libs/net/` 在 smoltcp 之上提供了操作系统级的封装：

- `NetStack`（`stack.rs`, 4958行）：全局协议栈管理器
  - 读写锁 + per-interface 锁双层架构
  - 接口注册表（BTreeMap）
  - 路由表（最长前缀匹配）
  - TCP/UDP socket 管理
- `ManagedInterface`（`interface.rs`, 2534行）：接口轮询、帧收发
- `NetSocketHandle`：协议无关 socket 句柄
- 非阻塞 API：所有操作返回 `WouldBlock`，阻塞语义由上层 WaitQueue + epoll 实现
- TCP accept 信息快照（在同一把接口锁内获取 local/remote endpoint，避免状态变化）

#### 3.6.3 Unix 域套接字

`libs/socket/` 实现了完整的 Unix 域套接字：
- `Stream`（SOCK_STREAM）：面向连接字节流
- `Datagram`（SOCK_DGRAM）：无连接消息报文
- `Sequenced`（SOCK_SEQPACKET）：面向连接消息报文
- 命名绑定 + socketpair 建立连接
- 连接管理、I/O、等待队列状态机

### 3.7 IPC 子系统

`general/src/ipc/shm.rs`（710行）实现了 System V 共享内存：

- `ShmId`/`ShmKey` 标识
- `IPC_PRIVATE`/`IPC_CREAT`/`IPC_EXCL` 语义
- `IPC_RMID`/`IPC_SET`/`IPC_STAT`/`IPC_INFO` 控制命令
- `SHM_RDONLY`/`SHM_RND`/`SHM_REMAP`/`SHM_EXEC` attach 标志
- 稀疏 backing（`SHM_SPARSE_BLOCK_SIZE = 4096`）
- 权限检查（`ShmPerm` 含 uid/gid/cuid/cgid/mode）
- `ShmLimits` 系统限制
- 作为 `mm::FileLike` 实现，兼容 `MAP_SHARED` 页缓存

System V 信号量和消息队列也有基础骨架实现。

### 3.8 架构支持

#### 3.8.1 RISC-V64

25 个源文件，覆盖：
- **异常入口**（`trap/mod.rs`）：手写汇编 naked function，区分 from_kernel/from_user 路径，syscall 快速路径跳过 FPU 保存
- **Sv48 分页**（`paging.rs`）：四级页表，支持 4KiB/2MiB/1GiB 大页，完整的 PTE 位操作
- **上下文切换**（`sched_ctx.rs`）：14 个 callee-saved 寄存器（ra/sp/s0-s11），手写汇编
- **页错误解码**（`mm/fault_decode.rs`）：从 scause/stval 提取 fault 类型
- **用户拷贝**（`mm/user_copy.rs`）：带 `__ex_table` fixup 的用户态内存访问
- **VDSO**（`vdso.rs`）：时间相关 VDSO 数据页
- **向量扩展**（`vector.rs`）：RISC-V V 扩展上下文管理
- **引导**（`boot.rs`）+ **EFI stub**（`efi_stub.rs`）
- **CSR 操作**（`csr.rs`）

#### 3.8.2 LoongArch64

22 个源文件，覆盖：
- **异常入口**（`trap/mod.rs`）：三条独立入口（EENTRY 通用异常/TLBRENTRY TLB重填/MERRENTRY 机器错误）
- **DMW 窗口**：使用 DMW1 窗口映射内核高半区
- **分页**（`paging.rs`）：多级页表 + TLB 重填快路径
- **上下文切换**（`sched_ctx.rs`）
- **早期控制台**（`early_console.rs`）
- **ABI 定义**（`abi.rs`）
- 与 RISC-V 对应的其他模块

#### 3.8.3 HAL 接口

`hal/` 定义了 9 个抽象模块：`abi`, `console`, `memory`, `platform`, `random`, `sched`, `time`, `user`, `user_context`。这些接口由 `arch` crate 实现，由 `general` 和 `kernel` 使用。

### 3.9 固件与平台初始化

- **ACPI 路径**（`kernel/src/acpi.rs`, 1430行）：MADT 解析（Local APIC/Generic Interrupt/Core PIC），FADT 电源管理，SPCR 串口，PCI MCFG，AML 解释器
- **DTB 路径**（`kernel/src/dtb/mod.rs` + `general/src/firmware/dtb.rs`, 1510行）：完整 FDT 解析，平台设备枚举，中断控制器识别，内存段提取
- **设备初始化**（`kernel/src/device_init.rs`）：统一注册核心文件系统（tmpfs/devtmpfs/procfs/sysfs），PnP bridge 安装，内建设备驱动注册

### 3.10 辅助子系统

#### 3.10.1 ELF 加载器

`libs/elf/` 提供格式解析，`kernel/src/user.rs`（1213行）实现完整装载：

- ELF header 解析 + magic 嗅探（`Image` trait 支持静态分派和 `parse` 动态分派）
- PT_LOAD 段映射 + BSS 清零
- PT_INTERP 动态链接器支持
- PT_PHDR 传递
- 用户栈布局：argc/argv/envp/auxv + 随机数种子
- shebang 脚本支持（最多4层递归）
- AT_RANDOM（16字节随机种子）、AT_SYSINFO_EHDR（VDSO 地址）传递

#### 3.10.2 VDSO

`kernel/src/vdso.rs` 实现了 vDSO 共享数据页：

- `VdsoData` 结构（72字节，对齐 4096 字节边界）
- 时钟模式：`VDSO_CLOCK_MODE_RDTIME`（架构特定快速路径）和 `VDSO_CLOCK_MODE_SYSCALL`（回退）
- 支持时钟：`CLOCK_REALTIME`, `CLOCK_MONOTONIC`, `CLOCK_MONOTONIC_RAW`, `CLOCK_REALTIME_COARSE`, `CLOCK_MONOTONIC_COARSE`, `CLOCK_BOOTTIME`
- 实时时钟偏移管理（`realtime_ns = monotonic_ns + offset`）
- RTC 硬件时钟源集成
- 每 tick 更新（通过 `register_vdso_tick_hook`）

#### 3.10.3 Initramfs

`kernel/src/initramfs.rs` 支持 Linux `newc` CPIO 格式解包：

- 支持嵌入（`embedded-initramfs` feature）和外部两种来源
- 通过标准 VFS 入口点创建目录和文件

#### 3.10.4 基准测试

`kernel/src/bench.rs`（3608行）实现了分层性能基准测试（L0-L8）：

- **L0**：纯内存拷贝（理论带宽上限）
- **L1**：裸块设备顺序读写
- **L2**：裸块设备随机读取
- **L3/L4**：FAT32/ext4 文件系统挂载
- **L5**：顺序读文件（1MiB 块）
- **L6**：随机读文件（4KiB 块）
- **L7**：顺序写文件
- **L8**：元数据操作（readdir、创建/删除）

通过 `MemoryBlockDevice` 内存模拟块设备实现可重复测试。

#### 3.10.5 LTP 测试

`userland/ltp-scenarios/` 包含 8 类 LTP 测试场景：
- event：epoll/eventfd 等
- fs：chmod/chown/stat/open/readlink/rename/utime/mknod 等（约50个场景）
- io：基本 I/O
- ipc：共享内存/信号量/消息队列
- memory：内存映射
- process：getpid/waitid/prctl/setreuid 等（约40个场景）
- signal：信号处理
- time：定时器

### 3.11 构建系统

`Makefile` 编排了多架构构建流程：

- 支持 LoongArch64（`loongarch64-unknown-none`）和 RISC-V64（`riscv64gc-unknown-none-elf`）两个目标
- 使用 vendored dependencies（`vendor/` 目录）
- Busybox 1.36.1 作为用户态根文件系统
- `embedded-initramfs` feature 将 CPIO 归档嵌入内核二进制
- 自定义链接脚本（`kernel/linker/qemu-*.ld`，含 debug 变体）
- Rust nightly-2025-05-20 工具链

---

## 四、子系统交互

### 4.1 核心交互流程

**系统调用路径**：
```
用户态 ecall
  → arch trap entry (汇编)
    → general::syscall::dispatch (查表)
      → kernel::syscalls::* (具体实现)
        → sched/lib/vfs/general (调用下层)
      → 写返回值 + 推进 PC
    → 信号检查 (TIF_SIGPENDING)
  → ertn/sret 返回用户态
```

**进程创建路径**：
```
sys_clone/sys_clone3
  → sched::operation::clone (CloneFlags + CloneArgs)
    → Task::new (分配 TCB, 内核栈, ArchContextSlot)
    → TaskExtCloneHook::clone_for (按 CLONE_VM/CLONE_FS/CLONE_FILES 决定共享或深拷贝)
    → VmSpace::fork (COW 标记私有页只读)
    → clone_task (复制 trap frame)
    → activate_task (入队)
```

**缺页处理路径**：
```
arch trap handler (store/load page fault)
  → general::mm::fault::dispatch_page_fault
    → 内核态？→ __ex_table fixup 查找
    → 用户态？→ VmSpace::handle_fault
      → VMA 查找 → COW/匿名页分配/文件页读入
      → PgdOps::map (写 PTE)
```

**文件 I/O 路径**：
```
sys_read/sys_write
  → FdTable::get(fd) → File
  → FileOps::read/write
    → (普通文件) InodeOps → 文件系统驱动 → 块缓存 → BlockBackend
    → (管道) Pipe::read/write → WaitQueue 阻塞
    → (socket) SocketFileOps → net stack / unix socket
```

### 4.2 关键注入点

项目使用"注入模式"解耦层次：

| 注入点 | 注入方 | 使用方 |
|---|---|---|
| `SyscallFrameOps` | arch | general::syscall |
| `FaultDecodeOps` | arch | general::mm::fault |
| `UserPgLayoutOps` | arch | general::mm::vm_space |
| `ArchContextOps` | arch | sched::scheduler |
| `ArchTimeOps` | arch | sched (now_ns) |
| `ProcessImageOps` | kernel::sched | sched::operation (exec/sigreturn) |
| `TaskExtCloneHook` | kernel::sched | sched::spawn |
| `VmSwitchOps` | kernel::sched | sched::scheduler |
| `TaskCpuStateOps` | kernel::sched | sched (rseq) |

---

## 五、实现完整度评估

以下基于对源码实现的完整分析，以 Linux 6.x 内核对应子系统功能为参照基准：

| 子系统 | 完整度 | 说明 |
|---|---|---|
| 进程管理 | 85% | 完整的 fork/clone/exec/exit/wait 状态机, futex, rseq, robust_list, 进程组/会话, 凭证管理。缺少 cgroup, namespace 大部分类型(仅实现了 mount ns) |
| EEVDF 调度器 | 80% | 完整的 Fair/RT/Deadline/Idle 四类调度, nice 权重表对齐 Linux。SMP 负载均衡有骨架但 AP 启动未落地。缺少 energy-aware scheduling |
| 内存管理 | 75% | Buddy + Slab + VMA + COW + 按需分页 + 共享页。缺少 swap, hugepage, KSM, NUMA |
| 文件系统(VFS) | 80% | 完整的 Dentry/Inode/Superblock/Mount/File/FdTable 抽象。缺少 notify/inotify/fanotify, xattr 完整实现, quota |
| ext2/3/4 | 70% | ext4 只读完备, 含 extent/inline_data/HTree。写支持有框架。缺少 journal replay, encryption |
| FAT12/16/32 | 75% | 完整的读写实现, LFN, FAT 扇区缓存。缺少 exFAT |
| 网络 | 70% | TCP/UDP/ICMP/DHCPv4, IPv4/IPv6, 路由表, SIOC ioctl。缺少 netfilter, IPv6 NDP, TCP congestion control variants |
| 信号 | 85% | 64 信号, sigaction/sigprocmask/sigpending/sigsuspend/sigtimedwait, sigframe 铺设 |
| 系统调用 | 55% | 约 170 个 syscall 有具体实现(346个已定义常量)。大量 syscall 注册但返回 ENOSYS |
| 设备驱动 | 60% | VirtIO 块/网, NS16550, PCI, PLIC, 龙芯中断。缺少 USB, SATA/NVMe, GPU, 大量实际硬件 |
| IPC | 50% | System V shm 完整, sem/msg 有骨架。缺少 POSIX mq |

**整体项目完整度：约 70%**（以能够运行 busybox 并执行 LTP 测试场景为基准）

---

## 六、设计创新性分析

### 6.1 架构创新

1. **Task 扩展槽机制**：通过 `TaskExtKey` + `Arc<dyn Any + Send + Sync>` 实现的类型安全扩展系统，避免了传统宏内核中 `task_struct` 的无限膨胀。这是一个优雅的解耦方案。

2. **注入式架构分层**：通过 `SyscallFrameOps`、`FaultDecodeOps`、`ProcessImageOps` 等一系列函数指针表实现依赖注入，使得 `libs/sched` 和 `general` 层保持架构无关，而 arch 和 kernel 层通过注入完成闭环。

3. **双固件路径**：同时支持 ACPI 和 DTB 两种固件接口的启动路径，通过 `StartContext` 统一抽象分离。

### 6.2 算法创新

1. **EEVDF 调度器**：采用了 Linux 6.6 最新引入的 EEVDF 算法，而非传统的 CFS。这是较前沿的调度算法选择，在公平性和延迟敏感性之间取得了更好的平衡。

2. **延迟合并 Buddy**：`DEFERRED_ORDER0_COALESCE_TARGET` 机制通过保留 order-0 热页水位降低 split/merge 抖动，同时根据空闲率动态调整策略。

3. **分片 Inode/Dentry 缓存**：使用 `ino % 8` 和 `(parent_ptr, name)` 哈希分片，在多核场景下降低锁竞争。

### 6.3 工程创新

1. **SmallStr**：Dentry 名称的零堆分配短字符串优化（≤16字节内联），减少高频路径解析的分配开销。

2. **两阶段 Inode 回收**：unlink 时先标记待回收，真正资源释放延迟到最后一个 `Arc` 引用消失，完美支持 Unix `unlink-but-open` 语义。

3. **futex 三态协议**：ARMED/SLEEPING/WOKEN 三态设计解决了 waiter 登记与睡眠之间的竞态窗口。

### 6.4 局限

1. **无 SMP 完整支持**：per-CPU 数据结构已就位，但 AP 启动未实际实现。
2. **没有用户态动态链接器**：仅支持静态链接的 ELF。
3. **写支持不完整**：extfs 写路径有代码框架但标记为未充分测试。

---

## 七、总结

MyGO!!!!! OS 是一个**架构设计优秀、实现深度可观**的 Rust 宏内核项目。其核心亮点包括：

1. **代码规模和质量**：约 22.6 万行 Rust 代码，严格的分层架构，手写汇编的架构入口，从零实现的 ext4 和 FAT 文件系统驱动。

2. **现代调度算法**：EEVDF 调度器对齐 Linux 6.6 主线，这在教学/竞赛内核中较为少见。

3. **完善的 VFS 层**：Dentry 缓存（含负向缓存和分片哈希）、Inode（含原子字段优化）、挂载命名空间、epoll/eventfd/timerfd/signalfd 等现代 Linux 特性均得到实现。

4. **Linux ABI 兼容性**：346 个 syscall 号定义，约 170 个有实际实现，能够运行 busybox 并通过大量 LTP 测试场景，体现了较强的实用性。

5. **双架构支持**：LoongArch64 和 RISC-V64 的完整支持，展示了良好的可移植性设计。

6. **清晰的注入式架构**：使得调度器核心、VFS 核心等关键组件保持架构无关，具备良好的可测试性和可维护性。

该项目的不足之处主要在于 SMP 支持未完工、部分 syscall 仅有骨架、写文件系统支持不完整等方面，但这些大多是时间/资源约束下的取舍，而非设计缺陷。整体来看，这是一个深度和广度兼具的高质量内核项目。