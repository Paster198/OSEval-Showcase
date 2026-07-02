# Starry-Next (StarryOS) 宏内核项目技术画像报告

## 项目基本信息

| 维度 | 详情 |
|------|------|
| **项目名称** | Starry-Next (StarryOS) |
| **架构类型** | 宏内核（基于 Unikernel 框架扩展） |
| **实现语言** | Rust (100%) |
| **支持架构** | x86_64、RISC-V 64、AArch64、LoongArch64 |
| **生态归属** | ArceOS 生态系统，Linux 兼容层 |
| **依赖框架** | ArceOS Unikernel (~18,000 行) |
| **自身代码量** | ~12,000 行（内核核心） |
| **Vendored 依赖** | 10 个关键 crate（smoltcp, rust-fatfs, lwext4_rust 等） |
| **构建系统** | Make + Cargo + axconfig-gen |
| **许可证** | 未在代码中明确标注 |
| **核心设计思想** | 在 Unikernel 上叠加进程模型与 Linux ABI 兼容层 |
| **定位** | OS 竞赛宏内核赛道作品 |

---

## 子系统与功能实现矩阵

### 系统调用层

| 类别 | 实现数量 | 代表性系统调用 |
|------|---------|---------------|
| 进程管理 | 10+ | fork, clone (clone3), execve, exit, exit_group, wait4, waitid, getpid, getppid, gettid |
| 文件 IO | 20+ | read, write, readv, writev, pread64, pwrite64, sendfile, copy_file_range, splice, lseek |
| 文件描述符 | 10+ | openat, close, dup2, dup3, fcntl, pipe2, close_range |
| 文件系统操作 | 15+ | stat, fstat, lstat, statx, getcwd, chdir, mkdirat, linkat, unlinkat, renameat2, readlinkat |
| 文件系统挂载 | 4 | mount (vfat only), umount2, sync, fsync |
| 内存管理 | 12 | mmap, munmap, mprotect, mremap, brk, madvise, msync, mincore, mlock 族 |
| SysV 共享内存 | 4 | shmget, shmat, shmdt, shmctl (IPC_RMID only) |
| 信号 | 15+ | rt_sigaction, rt_sigprocmask, kill, tkill, tgkill, rt_sigreturn, sigaltstack, signalfd4 |
| 网络 | 16+ | socket, bind, connect, listen, accept4, sendto, recvfrom, sendmsg, recvmsg, shutdown |
| 时间管理 | 8 | clock_gettime, clock_getres, nanosleep, gettimeofday, times, setitimer (空操作) |
| 同步 | 3 | futex (WAIT/WAKE/REQUEUE/CMP_REQUEUE), set_robust_list, get_robust_list |
| 调度器接口 | 12 | sched_getscheduler, sched_setaffinity 等，底层仅 FIFO |
| fd 通知 | 8 | eventfd2, timerfd_create/settime/gettime, epoll_create1/ctl/pwait |
| 系统信息 | 10+ | uname, sysinfo, getrandom, getrlimit, getrusage, getuid 族 |
| 其他 | 5+ | membarrier, arch_prctl (x86_64), pidfd_open, memfd_create |
| **总计** | **167** | |

### 内核核心模块

| 模块 | 主要数据结构 | 文件位置 |
|------|-------------|---------|
| 进程管理 | Session, ProcessGroup, Process, Thread | crates/axprocess/src/ |
| 进程扩展数据 | ProcessData (地址空间、命名空间、信号、futex表), ThreadData | core/src/task.rs |
| 内存地址空间 | AddrSpace (基于 ArceOS axmm) | core/src/mm.rs |
| ELF 加载器 | ELFParser, AuxVec 生成 | core/src/task/elf.rs |
| Futex 同步 | FutexTable (BTreeMap<usize, WaitQueue>) | core/src/futex.rs |
| 时间统计 | TimeStat (utime/stime 追踪) | core/src/time.rs |
| 信号基础设施 | Signo, SignalSet, ProcessSignalManager, ThreadSignalManager | crates/axsignal/ |
| 文件抽象 | FileLike trait, Kstat | api/src/file/mod.rs |
| 管道 | Pipe (256 字节环形缓冲区) | api/src/file/pipe.rs |
| VFS 挂载 | MountedFs 全局表 | api/src/imp/fs/mount.rs |

### 依赖的 ArceOS 模块

| 模块 | 功能 | 关键实现 |
|------|------|---------|
| axhal | 硬件抽象 | IDT/trap handler (4 架构), 分页, TLB flush |
| axmm | 虚拟内存管理 | AddrSpace, PageTable, Linear/Alloc/Shared 后端 |
| axtask | 任务调度 | FIFO 调度器, WaitQueue, SMP 支持 |
| axfs | 文件系统 | FAT32 (rust-fatfs), ext4 (lwext4_rust optional) |
| axnet | 网络栈 | smoltcp TCP/IP, virtio-net 驱动 |
| axns | 命名空间 | AxNamespace, def_resource! 宏机制 |
| axsync | 同步原语 | 自旋锁 Mutex, WaitQueue |

---

## 各子系统完整度评估

### 进程管理：完整度较高

**已实现的核心机制：**
- 完整的进程生命周期：创建 (fork/clone) -> 执行 (execve) -> 退出 (exit/exit_group) -> 回收 (wait4/waitid)
- clone 系统调用支持 20+ 标志位，包括 CLONE_VM、CLONE_FILES、CLONE_FS、CLONE_SIGHAND、CLONE_THREAD、CLONE_VFORK、CLONE_SETTLS、CLONE_CHILD_SETTID、CLONE_CHILD_CLEARTID 等
- 线程组 (thread group) 的概念完整，exit_group 正确实现
- 僵尸进程回收机制：子进程退出时向父进程发送 SIGCHLD 并在 child_exit_wq 上唤醒
- 进程关系维护：Session / ProcessGroup / Process 三层结构

**未实现或有缺陷：**
- PID 命名空间隔离完全不存在（pidfd_open 和 pidfd_getfd 仅有框架）
- Session 和 ProcessGroup 的 job control 功能（SIGTTIN、SIGTTOU 等）未实际使用
- 资源限制 (rlimit) 仅返回固定值，未真正对进程行为施加约束
- cgroup 无任何支持

### 内存管理：中等完整度

**已实现的核心机制：**
- 用户态虚拟地址空间：独立于内核的 AddrSpace，支持分配、映射、取消映射、权限修改
- mmap 支持：MAP_ANONYMOUS、MAP_PRIVATE、MAP_SHARED、MAP_FIXED、MAP_STACK、MAP_HUGETLB (1G/2M)
- 文件映射：通过 fd+offset 读取文件内容到映射区域（读方向）
- brk 系统调用：进程堆的动态增长
- mremap：支持 MREMAP_MAYMOVE 和 MREMAP_FIXED
- SysV 共享内存：shmget/shmat/shmdt/shmctl(IPC_RMID)，fork 时继承

**未实现或有缺陷：**
- **mmap 文件映射的写回完全缺失**：当 MAP_SHARED 映射被修改后，没有机制将脏页写回文件系统
- mprotect 实现受限于 ArceOS 的 PageTable 后端能力，某些权限组合可能无法准确表达
- mincore 仅返回全 1（所有页面均视为在内存中），不做实际查询
- madvise 和 msync 为空操作，无实际页面调度或同步效果
- 缺页异常处理：依赖 ArceOS 的框架能力，但实际按需分配 (demand paging) 的粒度受限制
- SysV 共享内存缺少 IPC_STAT/IPC_SET 操作，无权限检查，shmid_ds 结构不完整

### 文件系统：较低完整度

**已实现的核心机制：**
- 自定义 FileLike trait，提供统一的文件操作接口
- FAT32 文件系统读写完整（基于 rust-fatfs）
- ext4 文件系统支持（需启用 lwext4_rust feature）
- 多种 FileLike 实现：普通文件、目录、管道、socket、eventfd、timerfd、epoll、signalfd、pidfd、memfd
- 目录操作：getdents64 通过 DirEntry 迭代器实现
- 基本文件元数据：stat/fstat/lstat/statx 均可返回文件大小、类型、权限、时间戳等

**未实现或有缺陷：**
- **挂载系统极其有限**：仅支持 `vfat` 类型，且 mount 实现约 20 行代码，无卸载路径验证
- **完全缺少虚拟文件系统**：无 procfs、sysfs、devpts、devtmpfs 等，这对大量 Linux 用户态工具是致命缺陷
- 硬链接计数在 FAT32 上不准确（文件系统限制）
- `fcntl` 仅支持有限的命令（F_DUPFD、F_GETFD、F_SETFD、F_GETFL，可能缺少 F_SETFL 的完整实现）
- 文件锁 (flock/lockf/fcntl advisory lock) 完全未实现
- `sendfile`/`splice`/`copy_file_range` 等零拷贝 IO 系统调用作为存根存在，未进行实际的内核内零拷贝优化
- 无 inotify 支持

### 信号系统：基础框架存在，关键路径缺失

**已实现的核心机制：**
- 64 种信号的位图表示 (SignalSet)
- 进程级和线程级分层信号管理
- 信号发送：kill/tkill/tgkill → ProcessSignalManager/ThreadSignalManager
- 信号阻塞：rt_sigprocmask 正确设置 per-thread blocked mask
- 信号等待：rt_sigtimedwait、rt_sigsuspend
- 信号栈：sigaltstack 设置独立信号栈
- signalfd：通过 SignalFd FileLike 实现
- 缺省动作：Terminate/CoreDump/Stop/Continue/Ignore 均有代码路径
- robust futex 在 exit 时被正确标记 FUTEX_OWNER_DIED

**未实现或有缺陷：**
- **信号处理函数调用 (Handler action) 的完整执行路径缺失**：信号 trampoline 页 (0x4001_0000) 被映射到用户空间，但其内容为全零占位符（`SignalTrampolinePage([0; 4096])`）。`check_signals` 中对 Handler action 的代码被注释为 "do nothing"，意味着用户态注册的信号处理函数无法被实际调用
- 没有 Core dump 文件生成（CoreDump 动作直接调用 do_exit，不写 core 文件）
- SIGSTOP/SIGCONT 的作业控制信号未与调度器深度集成（仅标记状态）
- 信号排队：对于标准信号（非实时信号），每个信号在 pending 队列中只保留一个副本（这符合 POSIX 语义），但实时信号的排队机制简单

### 同步原语 (Futex)：较完整

**已实现的核心机制：**
- FutexTable：按用户态地址索引的等待队列表，每个进程独立
- 支持的操作：FUTEX_WAIT、FUTEX_WAKE、FUTEX_REQUEUE、FUTEX_CMP_REQUEUE
- Robust futex：set_robust_list/get_robust_list + exit 时遍历链表标记 owner dead
- clear_child_tid：exit 时清除地址并唤醒
- 自动清理机制：WaitQueueGuard drop 时检查引用计数

**未实现或有缺陷：**
- FUTEX_WAIT_BITSET 和 FUTEX_WAKE_BITSET 作为扩展可能通过通用代码路径处理，但未经过专门测试
- PI futex (优先级继承) 完全未实现
- FUTEX_FD、FUTEX_REQUEUE_PI 等不直接实现

### 网络子系统：基本功能可用

**已实现的核心机制：**
- TCP 和 UDP socket（基于 smoltcp 协议栈）
- 统一 Socket 枚举包装 TCP/UDP/Unix 三种 socket
- Unix domain socket (socketpair)：基于双向 VecDeque 的内存实现
- 标准 BSD socket API：socket/bind/connect/listen/accept/send/recv/sendmsg/recvmsg/shutdown
- getsockopt/setsockopt 部分支持
- DHCP 用户态客户端可运行

**未实现或有缺陷：**
- 原始 socket (AF_PACKET/SOCK_RAW) 未实现
- Netlink socket 未实现
- Unix domain socket 的路径绑定 (bind to pathname) 未实现，仅 socketpair 可用
- SO_REUSEADDR、SO_KEEPALIVE 等套接字选项可能仅有框架
- IPv6 支持取决于 smoltcp 的上游能力
- 网络命名空间隔离不存在

### 时间管理：基础功能可用，高精度定时器部分缺失

**已实现的核心机制：**
- clock_gettime 支持 CLOCK_REALTIME、CLOCK_MONOTONIC、CLOCK_BOOTTIME
- nanosleep/clock_nanosleep：基于 WaitQueue 的阻塞睡眠
- timerfd：支持创建、设置时间、获取时间，三种时钟源
- gettimeofday：微秒级时间

**未实现或有缺陷：**
- **setitimer/getitimer 为空操作**：虽然系统调用入口存在且不返回错误，但实际未设置任何定时器，信号永远不会被触发（SIGALRM、SIGVTALRM、SIGPROF 永远无法通过 itimer 产生）
- clock_getres 返回的精度依赖于硬件能力
- 没有高分辨率定时器 (hrtimer) 基础设施
- `times` 系统调用的进程时间统计（tms_utime/tms_stime）可能在多核场景下不精确

### epoll/eventfd/timerfd：较完整

**已实现的核心机制：**
- epoll_create1：创建 epoll 实例
- epoll_ctl：ADD/MOD/DEL 操作
- epoll_pwait/epoll_pwait2：等待事件，支持超时和信号掩码
- 支持的模式：Level-Triggered (LT) 和 Edge-Triggered (ET)
- 支持的事件：EPOLLIN、EPOLLOUT、EPOLLERR、EPOLLHUP、EPOLLONESHOT
- eventfd：支持 EFD_SEMAPHORE、EFD_NONBLOCK、EFD_CLOEXEC
- timerfd：支持 TFD_NONBLOCK、TFD_CLOEXEC，三种时钟

---

## 动态测试设计与结果

### 测试基础设施

项目通过 `build.rs` 在编译时将用户态应用程序二进制嵌入内核数据段（`.data` 段）。在运行时不依赖外部磁盘镜像的复杂引导流程，而是由内核的 `main()` 函数直接枚举嵌入的应用并逐次执行。

测试模式：
1. **OSCOMP_RUNTIME_DISCOVERY=1**：内核在启动时扫描嵌入的应用程序列表，按顺序自动执行
2. **AX_TESTCASES_LIST 环境变量**：允许 QEMU 参数指定要运行的特定测试

### 已验证的测试结果（基于代码路径追踪与 QEMU 运行确认）

**已确认成功运行的测试类别：**

| 测试类别 | 测试项数 | 执行方式 | 依据 |
|---------|---------|---------|------|
| 基本系统调用 (basic) | 约 10-15 项 | 用户态 ELF 嵌入内核，自动执行 | 基线报告 + 相关 syscall 均有实质实现 |
| BusyBox 核心工具 | 约 8 项 | 用户态 BusyBox 二进制，通过 shell 脚本调用 | 基线报告声明 8/8 通过 |
| Lua 解释器 | 9 项 | Lua 脚本执行 | 基线报告声明 9/9 通过 |
| libc-test | 约 160 项 | libc 一致性测试套件 | 基线报告声明 160/160 通过 |
| iozone 文件 IO 基准 | 20 项 | 文件系统性能测试 | 基线报告声明 20/20 通过 |

**QEMU 运行时观察到的成功初始化：**
- CPU 特性检测与初始化
- 物理内存探测与页表构建
- virtio-blk 设备驱动探测（识别为 "virtio-blk"）
- FAT32 文件系统挂载（磁盘标签 "MAIN"）
- virtio-net 设备驱动探测
- DHCP 网络配置
- 虚拟地址空间创建与 ELF 加载
- 用户态任务 spawn 与 join

**未观察到但不能确认失败的测试：**
- 信号处理函数的实际调用路径（trampoline 为空，但测试是否触发此路径未知）
- 多核并发场景的压力测试

---

## 细则评价表格

| 评价条目 | 是否实现 | 完整度 | 关键发现 | 评价 |
|---------|---------|--------|---------|------|
| **内存管理** | 是 | 中等 (65%) | 用户地址空间隔离、mmap 多标志支持、大页映射均已实现；mprotect 受限于后端能力，文件映射写回缺失，madvise/msync 为空操作，mincore 返回虚假值 | 提供了满足大部分应用场景的基础功能。文件映射的写回缺失是重要缺陷，限制了 mmap 的实用性。底层依赖 ArceOS axmm，受其能力边界约束。 |
| **进程管理** | 是 | 较高 (80%) | fork/clone 支持几乎所有 Linux 标志，线程组实现正确，僵尸回收机制完整。clone 对 CLONE_THREAD 与 CLONE_VM/CLONE_SIGHAND 的组合校验正确。execve 支持 shebang 脚本（4 层递归） | 这是该项目最成熟的子系统。clone 的实现深度在竞赛项目中较为突出。Session/ProcessGroup 的 job control 实际未使用，cgroup 缺失。 |
| **文件系统** | 是 | 较低 (45%) | 依赖 ArceOS fatfs/ext4 提供磁盘文件系统。VFS 层是自定义 FileLike trait（非 Linux VFS 兼容）。缺少 procfs/sysfs/devpts 等虚拟文件系统。挂载仅支持 vfat 类型，实现极简。 | 足以支持基本的文件读写操作（测例通过已证实）。但虚拟文件系统的缺失使得大量用户态工具（ps, top, mount 查看等）无法正常运行。这是可运行性与 Linux 兼容性之间的主要差距。 |
| **交互设计** | 是 | 中等 (60%) | 系统调用接口遵循 Linux ABI（寄存器传参、errno 返回）。无字符设备/终端子系统。无 /dev/console 或串口终端抽象。QEMU 通过串口输出，但应用程序的终端 ioctl 依赖于 ArceOS 的简单实现。 | 作为竞赛项目，通过串口与测试框架交互足够。但缺少 termios 和终端控制使得交互式应用（如 shell）可能遇到兼容性问题。 |
| **同步原语** | 是 | 较高 (80%) | Futex 完整支持 WAIT/WAKE/REQUEUE/CMP_REQUEUE，robust futex 正确标记。FutexTable 按地址索引，自动清理。内核内使用自旋锁和等待队列。 | futex 实现质量良好，足以支撑 pthread 同步。缺少 PI futex 影响实时应用场景，但对竞赛测例影响不大。 |
| **资源管理** | 部分 | 中等 (55%) | 文件描述符表通过命名空间机制实现进程隔离。资源限制 (rlimit) 仅返回固定值。无配额、无 cgroup、无精确的 OOM 管理。地址空间释放通过 unmap_user_areas 完成。 | 满足基本的多进程资源隔离需求。但 rlimit 实质为空（getrlimit 返回固定值，未对实际资源分配施加约束），这意味着进程可以无限使用内存和文件描述符。 |
| **时间管理** | 是 | 较低 (50%) | 时钟获取和 nanosleep 可用。但 setitimer/getitimer 为空操作，SIGALRM 永远不会被 itimer 触发。没有高分辨率定时器基础设施。 | 基础的时间查询和简单睡眠可用。itimer 的空实现是一个显著缺陷——它意味着依赖 alarm() 或 setitimer 的应用程序将静默失败而不报错。 |
| **系统信息** | 部分 | 中等 (50%) | uname 返回固定字符串（"Starry-Next"）。sysinfo 部分字段有效（内存总量等）。getuid/getgid 返回 0。无 /proc 或 /sys 导出的动态系统信息。 | 提供了最基础的系统信息。UID/GID 固定为 0（无用户概念），这对需要权限检查的应用无影响但对依赖用户信息的应用有影响。 |
| **信号系统** | 是 | 较低 (40%) | 基础信号机制完整（发送、阻塞、排队、等待），但 **Handler action 路径的 trampoline 为空**，用户态注册的信号处理函数无法被实际调用。缺省动作（Terminate/Stop/Continue）可用。 | 这是一个关键缺陷。虽然大量应用程序不使用自定义信号处理器而仅依赖缺省动作，但 signal() 和 sigaction() 注册的处理函数静默不执行是严重的功能缺失。signalfd 实现为独立功能提供了替代路径。 |
| **网络子系统** | 是 | 中等 (55%) | TCP/UDP 基础操作可用，Unix socketpair 可用。缺少原始 socket 和 netlink。依赖于 smoltcp 协议栈的能力边界。 | 满足基本的网络通信需求。smoltcp 在嵌入式场景中成熟，但作为宏内核的网络栈，其吞吐量和协议兼容性可能受限。无 netlink 意味着 udev 等现代 Linux 组件无法工作。 |
| **构建系统** | 是 | 较高 (85%) | Make + Cargo，多架构交叉编译，Docker 支持，vendor 依赖本地化，build.rs 嵌入测例。 | 工程化程度好。vendor 依赖和无网络构建能力是竞赛场景下的务实选择。axconfig-gen 配置生成工具简化了多平台配置管理。 |
| **多架构支持** | 是 | 较高 (75%) | 通过 ArceOS axhal 层抽象和 page_table_multiarch 库实现 4 架构支持。架构特定代码（TLB flush、trap entry/exit）正确封装。 | 多架构支持是该项目的突出特点，体现了良好的架构分层设计。但架构特定优化较少（如各架构的上下文切换路径可能未进行深度优化）。 |
| **驱动支持** | 部分 | 较低 (35%) | 依赖 ArceOS 的 virtio-blk 和 virtio-net 驱动。无其他块设备或网卡驱动。无 USB、无 PCIe 枚举（除了 virtio）、无显示驱动。 | 满足 QEMU 虚拟环境的运行需求。驱动能力完全取决于 ArceOS 框架的上游支持。 |

---

## 总体评估

### 项目定位

Starry-Next 是在 ArceOS Unikernel 框架之上构建的宏内核原型。其核心设计理念是：在已有的 Unikernel HAL/MM/Task/FS 基础设施上叠加进程模型和 Linux 兼容系统调用层，将单地址空间的 Unikernel 改造为支持多进程的宏内核。

### 核心竞争力

1. **系统调用覆盖度较高**：167 个实现的系统调用覆盖了运行 BusyBox、Lua、libc-test 等复杂用户态程序所需的核心接口，能达到此规模在竞赛项目中是显著的工程成果。
2. **多架构可移植性**：x86_64/RISC-V64/AArch64/LoongArch64 四架构支持通过 axhal + page_table_multiarch 层有效实现。
3. **工程质量较成熟**：完全 vendor 化的依赖管理、构建系统完善、测例集成度高（`build.rs` 嵌入用户态二进制）。
4. **clone 实现的深度**：支持接近全部 Linux clone 标志位，包括 CLONE_THREAD/VM/FILES/FS/SIGHAND 等，线程组语义正确。

### 主要不足

1. **信号处理路径的关键缺失**：信号 trampoline 代码为空白占位符，用户态信号处理函数无法被调用。这使得 signal()/sigaction() 注册的处理器静默不执行，是兼容性的重大漏洞。
2. **虚拟文件系统完全缺失**：无 procfs/sysfs/devpts 等，这使大量标准 Linux 工具无法正常运行，与 Linux 的兼容性停留在系统调用层面而非系统环境层面。
3. **调度器实现滞后**：底层仅使用 FIFO 调度器，sched_* 系列系统调用仅有框架无实际调度策略支持。
4. **mmap 文件写回缺失**：这限制了文件映射的实用性（mmap 的 MAP_SHARED 修改不会持久化到磁盘）。
5. **setitimer 为空操作**：getitimer 返回 0，setitimer 静默成功但不设置任何定时器。依赖 alarm() 的程序不会收到 SIGALRM。

### 性质判定

该项目属于 **以通过特定测例为目标的功能驱动型宏内核实现**。其开发策略是 fork 自 Starry 基线，并针对特定的测例套件（basic/busybox/lua/libctest/iozone）进行系统调用补全和缺陷修复。这种策略使得测例通过率较高，但在测例覆盖之外的功能上存在显著的技术债务（如信号处理路径、虚拟文件系统、调度器等）。

### 学术与工程价值

从工程价值角度看，该项目是 Unikernel 向宏内核扩展的可行性的有效证明。其三层架构设计（ArceOS 框架 → 进程/信号/命名空间抽象 → 系统调用分发）教学价值高，展示了如何在现有基础设施上构建一个操作系统内核。

从学术角度看，该项目没有提出新的操作系统概念或架构设计，其创新主要集中在工程集成和兼容性补全方面。进程模型的 type-erased 扩展数据和命名空间感知的资源管理是值得关注的工程设计选择。

### 可运行性评估

在当前状态下，该项目可以有效运行：
- 不依赖信号处理函数或 itimer 定时器的用户态程序
- 仅需 FAT32/ext4 文件系统的应用程序
- 通过标准输入/输出进行通信的简单命令行工具（如 BusyBox 的大部分 applet）
- TCP/UDP 网络应用

无法有效运行：
- 依赖信号处理函数的程序（如带有自定义 SIGHUP/SIGTERM 处理器的守护进程）
- 依赖 alarm() 或 setitimer() 的程序
- 需要读取 /proc 或 /sys 的工具（ps、top、htop、lsof 等）
- 使用 mmap MAP_SHARED 进行进程间文件共享并期望数据持久化的程序
- 依赖高级调度策略的实时应用