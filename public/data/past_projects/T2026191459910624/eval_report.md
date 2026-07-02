# Starry_fix 操作系统内核技术画像与评估报告

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| 项目名称 | Starry_fix |
| 架构支持 | RISC-V64 (主要), LoongArch64, x86_64, AArch64 |
| 实现语言 | Rust |
| 生态归属 | 基于 StarryOS（ArceOS 组件化 unikernel 框架之上的 Linux 兼容宏内核）的改进分支 |
| 内核类型 | 宏内核（Linux ABI 兼容），构建于组件化 unikernel 框架之上 |
| 代码规模 | 内核核心约 104 个源文件，约 17,745 行代码 |
| 依赖管理 | 通过 `[patch.crates-io]` 机制精确替换 4 个上游 crate，保持与上游的最大兼容性 |
| 构建工具 | Cargo + Makefile，使用 `axconfig-gen` 生成平台配置 |
| 特点 | Linux ABI 兼容、组件化框架逆用、FileLike 统一抽象、scope-based 资源管理、补丁式依赖管理 |

## 二、子系统实现概况

### 2.1 已实现的子系统与功能

| 子系统 | 已实现功能 |
|--------|-----------|
| 系统调用分发 | 约 200+ 个 Linux 系统调用号映射，架构条件编译（x86_64/RISC-V） |
| 文件描述符框架 | FileLike trait 统一抽象，FD 表（`FlattenObjects` 稀疏数组），支持 File、Directory、Pipe、Socket、EventFd、Signalfd、PidFd、Epoll 八种文件类型 |
| 内存管理 | 地址空间（AddrSpace）含 MemorySet + PageTable，四种后端（Linear/Cow/File/Shared），ELF 加载器（含动态链接器预加载），mmap/munmap/mprotect/mremap，COW 机制 |
| 进程/线程管理 | 1:1 线程模型，clone/clone3（含 20+ 个标志位），fork（x86_64）、execve、exit/exit_group、进程组、会话、wait4 |
| 信号子系统 | 完整信号发送/接收/掩码/动作处理，sigtimedwait、signalfd，信号 trampoline，信号队列（siginfo） |
| 同步原语 | futex（含 bitset、requeue、robust list、PI futex 基础），eventfd，membarrier |
| 时间管理 | gettimeofday、clock_gettime/clock_getres、times、三种 interval 定时器（ITIMER_REAL/VIRTUAL/PROF），nanosleep/clock_nanosleep |
| 网络栈 | TCP/UDP/Unix Socket/VSOCK（基于 smoltcp），socket/socketpair/bind/connect/listen/accept/sendto/recvfrom/sendmsg/recvmsg，CMSG（SCM_RIGHTS FD 传递），loopback 自动配置 |
| System V IPC | 消息队列（msgget/msgsnd/msgrcv/msgctl，完整权限检查），共享内存（shmget/shmat/shmdt/shmctl，物理页延迟分配，引用计数管理） |
| IO 多路复用 | epoll（ET/LT/ONESHOT，ReadyQueue + InterestWaker），poll/ppoll，select/pselect6 |
| 文件系统 | ext4（读写）、FAT（读写）、tmpfs（基于 HashMap）、devfs、procfs（基本进程信息） |
| 伪文件系统 | devfs（tty、console、ptmx/pts、rtc、random/urandom、fb0、loop 等）、procfs（/proc/{pid}/* 系列）、tmpfs（/tmp、/dev/shm） |
| TTY/PTY 子系统 | PTY master/slave 对，环形缓冲，线路规程（规范模式/原始模式），特殊字符处理，ISIG 信号生成（^C->SIGINT 等），作业控制框架（Session/ProcessGroup/JobControl） |
| 资源管理 | rlimit（prlimit64）、umask、UID/GID（getuid/setuid/getgid/setgid/getgroups/setgroups）、capget/capset（存根） |
| 系统信息 | uname、sysinfo、syslog（存根）、getrandom、seccomp（存根） |

### 2.2 未实现或存根实现的功能

| 功能 | 状态 |
|------|------|
| System V 信号量 | 未实现 |
| 命名空间隔离 | 存根（接受标志但无实际操作） |
| cgroup | 未实现 |
| ptrace | 存根 |
| seccomp（过滤模式） | 存根 |
| swap / page reclaim | 未实现（物理页永不回收） |
| 完整的 mremap（跨区域重映射） | 退化实现（mmap+copy+munmap） |
| madvise / msync / mlock / mlock2 | 存根（返回成功但不执行实际操作） |
| 多线程 execve | 不支持（返回 WouldBlock） |
| IPv6 | 未实现 |
| 原始 socket（AF_PACKET） | 未实现 |
| netfilter / iptables | 未实现 |
| 文件系统写时分配、日志、xattr、ACL | 未实现 |
| Core dump | 未实现 |
| 完整 capget/capset | 存根 |

## 三、各子系统实现完整度与细节

### 3.1 内存管理

**实现完整度**：约 75%。

| 已实现 | 未/存根实现 |
|--------|------------|
| mmap（含 MAP_PRIVATE/SHARED/FIXED/ANONYMOUS/HUGETLB/POPULATE/STACK）、munmap、mprotect | madvise、msync、mlock、mlock2 均为存根 |
| Copy-on-Write（Cow 后端）、文件映射（File 后端，含 Cached/Direct 模式）、共享内存映射（Shared 后端） | swap / page reclaim 完全未实现 |
| ELF 加载器（含动态链接器预加载，LRU 缓存） | 无 THP 分裂/合并、无 NUMA 策略、无 KSM |
| 用户态内存安全访问（VmPtr/VmMutPtr trait，零开销抽象） | mincore 返回全驻留 |
| 物理页按需分配（populate_area） | 完整的 mremap（支持跨区域）为退化实现 |
| 设备 MMIO 映射（DeviceMmap::Physical） | - |

**优点**：
- Cow 后端实现正确，通过外部 PageTable 引用在页面故障处理中完成写时复制。
- 四种后端设计清晰分离了不同映射场景的语义，Shared 后端通过 `Arc<SharedPages>` 管理物理页引用计数。
- `VmPtr`/`VmMutPtr` trait 提供编译期类型安全的用户态内存访问，通过 `#[extern_trait]` 在 monomorphization 阶段消除虚函数开销。

**缺点**：
- 无页面回收机制，物理页面在分配后永不释放（即使所有进程已 unmap），内存压力下无法换出。
- madvise/MADV_DONTNEED 等关键内存管理提示为 no-op，可能影响依赖此行为的应用程序性能。
- mremap 实现为退化方案（创建新映射+复制+解除旧映射），不具备原子性和地址空间连续性保证。

### 3.2 进程管理

**实现完整度**：约 80%。

| 已实现 | 未/存根实现 |
|--------|------------|
| clone/clone3（CLONE_VM/FILES/SIGHAND/THREAD/VFORK/PARENT/SETTLS/CHILD_SETTID/CHILD_CLEARTID/PARENT_SETTID/PIDFD/CLEAR_SIGHAND 等 14+ 标志位） | CLONE_SYSVSEM、CLONE_PTRACE、CLONE_IO、命名空间标志均为存根 |
| fork（x86_64）、execve（单线程）、exit/exit_group | 多线程 execve 不支持 |
| 进程组（setpgid/getpgid）、会话（setsid/getsid） | cgroup 未实现 |
| wait4（含 WNOHANG/WUNTRACED 语义） | ptrace 未实现 |
| sched_yield、sched_getaffinity/setaffinity、sched_getscheduler/setscheduler、getpriority | 无 CFS 或其他复杂调度器（依赖 axtask 的 RR 调度） |
| tid_address 退出通知 + futex 唤醒 | - |
| robust list futex 死亡处理 | - |
| rlimit（prlimit64，含 RLIMIT_NOFILE/CPU/FILE 等） | - |

**优点**：
- clone 实现通过 `CloneArgs::do_clone()` 中心化处理，逻辑清晰，标志位组合支持较为完整。
- 进程退出流程处理考究：clear_child_tid futex 唤醒、robust list 清理、子进程 exit_event 通知、线程组 SIGKILL 传播、共享内存自动清理。
- 全局任务表使用四个 `WeakMap`（TASK_TABLE/PROCESS_TABLE/PROCESS_GROUP_TABLE/SESSION_TABLE）维护关系，避免循环引用。

**缺点**：
- 多线程 execve 不支持为明显缺陷，限制了对进程替换语义的完整支持。
- 命名空间和 cgroup 的缺失使得容器化部署无法在此内核上运行。
- 调度器实现较为基础（依赖 axtask 的 RR），缺少对调度策略和优先级的细粒度支持。

### 3.3 文件系统

**实现完整度**：约 70%。

| 已实现 | 未/存根实现 |
|--------|------------|
| ext4 读写（inode 操作、目录遍历、文件读写）、FAT 读写 | 文件系统写时分配、日志、xattr、ACL |
| tmpfs（基于 HashMap 的内存文件系统） | 写回缓存、脏页管理 |
| devfs（含 tty、ptmx/pts、rtc、random、fb0、loop 等） | 设备热插拔 |
| procfs（/proc/{pid}/* 基本系列） | 完整 /proc/meminfo（仅静态常量）、/proc/net/*、/proc/sys/* |
| VFS 层通过 FileLike trait 架构实现 | 无完整 VFS mount 树（mount 表简单） |
| openat/close/read/write/lseek/getdents64/statx/faccessat2 等 50+ 文件系统相关系统调用 | - |
| sendfile、copy_file_range、splice 等高级 I/O | splice 实现未深度验证 |

**优点**：
- FileLike trait 统一抽象使得添加新文件类型（如 Signalfd、PidFd）无需修改核心框架，仅需实现该 trait。
- `FlattenObjects` 稀疏数组提供了 O(1) 的 FD 分配和回收，比链表方案更高效。
- 伪文件系统框架（SimpleFs/SimpleDir/SimpleFile + DirMaker 工厂函数）实现了按需创建目录结构。

**缺点**：
- 文件系统层缺少写回缓存和脏页管理，写入性能和一致性保障不足。
- procfs 信息以静态占位为主（如 `/proc/meminfo` 为常量、`/proc/{pid}/maps` 不含真实映射信息），实用性有限。
- 无完整的 VFS super_block 和 mount 管理，挂载操作功能受限（仅支持 tmpfs 和块设备挂载）。

### 3.4 交互设计（系统调用接口与用户体验）

**实现完整度**：约 85%。

**评价**：
- 系统调用分发器架构清晰（`Sysno` -> `handle_syscall` match 分支），覆盖约 200+ 个系统调用号，达到了 Linux 常用系统调用的较高覆盖率。
- 参数传递方式遵循标准（`uctx.arg0()` ~ `uctx.arg5()`，返回值通过 `uctx.set_retval()`），架构差异通过条件编译处理（如 x86_64 保留 `poll`/`select`/`open` 独立系统调用，RISC-V 统一使用 `*at` 变体）。
- 错误码使用 `LinuxError` 枚举，与 Linux 标准错误码对应。
- 存在少量不一致：x86_64 上 fork 作为独立系统调用存在（内部调用 `sys_clone(SIGCHLD, 0, 0, 0, 0, 0)`），RISC-V 无此包装。
- 缺少文档：多数代码缺少注释，系统调用语义的正确性需通过源码推断，用户态开发者无法明确知道哪些行为与 Linux 存在差异。

### 3.5 同步原语

**实现完整度**：约 85%。

| 已实现 | 未/存根实现 |
|--------|------------|
| futex（含 FUTEX_WAIT/WAKE/FD/REQUEUE/CMP_REQUEUE/WAIT_BITSET/WAKE_BITSET/OWNER_DIED） | 完整 PI futex（仅有基础处理） |
| robust list（get_robust_list/set_robust_list，退出时 futex 死亡处理） | - |
| eventfd（含 EFD_SEMAPHORE 模式） | - |
| membarrier（存根，返回成功） | 实际 membarrier 指令未执行 |
| 自动清理空 futex 条目 | - |
| 共享 futex 全局表（每 100 次操作清理一次） | - |

**优点**：
- futex 实现完整度较高，支持 bitset 匹配唤醒和 requeue 操作，这在 Rust 内核中较罕见。
- robust list 处理正确：进程退出时遍历 robust list 并设置 `FUTEX_OWNER_DIED` 位。

**缺点**：
- membarrier 为存根实现，不执行实际内存屏障，可能引发多核一致性假设错误。
- PI futex 实现不完整，无法支持实时线程的优先级继承需求。

### 3.6 资源管理

**实现完整度**：约 60%。

| 已实现 | 未/存根实现 |
|--------|------------|
| 文件描述符（FlattenObjects，上限 AX_FILE_LIMIT） | 无全局资源统计/限制 |
| rlimit（prlimit64，含 RLIMIT_NOFILE/RLIMIT_CPU/RLIMIT_FILE 等） | cgroup 资源控制未实现 |
| umask（进程级文件模式掩码） | 设备配额未实现 |
| UID/GID（getuid/setuid/geteuid/getegid/getgid/setgid/getgroups/setgroups） | capget/capset 完全存根，无能力检查 |
| 进程退出时共享内存自动清理（SHM_MANAGER.clear_proc_shm） | 无 OOM killer |
| Scope-based 资源作用域管理 | - |

**优点**：
- Scope-based 资源管理在 clone 时通过 scope 机制灵活选择共享或复制 FD 表、FS 上下文，避免了传统内核中复杂的引用计数路径。
- 共享内存引用计数管理正确，进程退出时自动清理。

**缺点**：
- 无实际能力检查（capabilities），所有权限判断依赖简单的 UID 比较，安全性不足。
- 缺少全局资源限制（如总打开文件数限制），可能导致资源耗尽。
- OOM killer 缺失，物理内存不可回收，极端情况下将直接系统不可用。

### 3.7 时间管理

**实现完整度**：约 75%。

| 已实现 | 未/存根实现 |
|--------|------------|
| gettimeofday（微秒精度） | adjtimex/ntp 时间同步 |
| clock_gettime（含 CLOCK_REALTIME/MONOTONIC/PROCESS_CPUTIME_ID/THREAD_CPUTIME_ID） | - |
| clock_getres | - |
| clock_nanosleep（含 TIMER_ABSTIME） | - |
| times | - |
| setitimer/getitimer（ITIMER_REAL/VIRTUAL/PROF） | - |
| 全局警报任务（基于 BinaryHeap + event_listener） | - |

**优点**：
- interval 定时器实现完整，含用户态/内核态时间统计（utime_ns/stime_ns）。
- 全局警报任务通过 `event_listener` 实现高效等待，避免忙轮询。

**缺点**：
- 缺少 NTP 时间同步接口，系统时间可能漂移。
- 时间统计依赖 tick 粒度，可能无法满足高精度计时需求。

### 3.8 系统信息

**实现完整度**：约 50%。

| 已实现 | 未/存根实现 |
|--------|------------|
| uname（含 sysname/nodename/release/version/machine） | syslog 为存根（仅记录到缓冲区，不实际写入） |
| sysinfo（uptime/loads/totalram/freeram/sharedram/bufferram/totalswap/freeswap/procs） | 完整 /proc 信息（内存、网络、cgroup、设备） |
| getrandom | seccomp 完全存根 |
| /proc/{pid}/stat、/proc/{pid}/status、/proc/{pid}/cmdline、/proc/{pid}/comm | /proc/{pid}/maps 为静态 VDSO 信息 |
| /proc/{pid}/fd/、/proc/{pid}/task/ | - |

**优点**：
- 基本进程信息可通过 procfs 访问，提供了开发调试的基础能力。

**缺点**：
- 大量系统信息接口为存根或静态数据，实用性有限。例如 syslog 不做实际写入，seccomp 不接受任何过滤规则。

## 四、内核整体实现完整度

基于上述各子系统的分析，以 Linux 内核的完整功能集为基准（100%），该内核项目的整体实现完整度约为 **72%-78%**。以下为影响完整度判断的关键因素：

**已实现的核心价值**：
- 系统调用覆盖约 200+ 个，可支持基本 Linux 用户态程序运行。
- 进程/线程管理、信号机制、futex、epoll、System V IPC 等核心机制实现质量较高。

**主要缺口**：
- 完整缺失：swap/page reclaim、cgroup、命名空间、ptrace、System V 信号量、IPv6。
- 存根功能：madvise/msync/mlock（内存）、seccomp（安全）、capabilities（权限）、membarrier（同步）。
- 退化实现：mremap、多线程 execve。

**判断依据**：所有判断均基于源代码审查获得的实现事实，未依赖项目文档或声明。

## 五、动态测试的设计与结果

### 5.1 测试条件

由于当前环境缺乏完整的 RISC-V 夜间 Rust 工具链（`rust-src` 组件缺失），无法执行 `make build ARCH=riscv64` 完整构建。尝试了以下步骤：

- `make build ARCH=riscv64` 因 `rustup target add riscv64gc-unknown-none-elf` 后仍缺少 `rust-src` 而失败。
- 环境提供的 QEMU（RISC-V env）可正常使用，但无可运行的内核镜像。
- 未能在 LoongArch 或 x86_64 QEMU 环境中完成替代构建。

### 5.2 动态测试结果

**无动态测试结果**。本报告的结论完全基于源代码静态分析。

## 六、细则评价表格

| 评价条目 | 是否实现 | 完整度 | 关键发现 | 评价 |
|----------|----------|--------|----------|------|
| 内存管理 | 是 | 约 75% | mmap/munmap/mprotect 完整，COW 实现正确，四种后端设计清晰；但 madvise/msync/mlock 为存根，无 swap/page reclaim，mremap 为退化实现 | 核心映射机制扎实，但内存回收和高级管理特性缺失严重 |
| 进程管理 | 是 | 约 80% | clone 含 14+ 标志位，exit 流程处理考究（robust list、共享内存清理）；但多线程 execve 不支持，命名空间/cgroup 缺失 | 基本进程生命周期管理能力较好，但对复杂部署场景支持有限 |
| 文件系统 | 是 | 约 70% | FileLike trait 统一抽象，FlattenObjects O(1) FD 管理，ext4/FAT 读写；但无写回缓存、procfs 信息以静态为主、VFS mount 管理不完整 | 文件系统框架设计优秀，但实际文件系统实现深度不足 |
| 交互设计 | 是 | 约 85% | 200+ 系统调用覆盖，架构条件编译处理差异，LinuxError 错误码；但文档和注释不足 | 系统调用接口覆盖度较高，但缺少行为差异说明文档 |
| 同步原语 | 是 | 约 85% | futex 支持 bitset/requeue/robust list，eventfd 含 semaphore 模式；但 membarrier 为存根，PI futex 不完整 | futex 实现质量较高，但同步屏障和优先级继承存在短板 |
| 资源管理 | 是 | 约 60% | rlimit 部分支持，Scope-based 资源作用域，共享内存引用计数管理；但 capabilities 完全存根，无 OOM killer，缺少全局资源限制 | 资源管理能力较为基础，安全性依赖简单的 UID 比较 |
| 时间管理 | 是 | 约 75% | interval 定时器完整，含 utime/stime 统计，全局警报任务基于 event_listener；但缺少 adjtimex/NTP 接口 | 基本时间服务可用，但缺少时间同步能力 |
| 系统信息 | 是 | 约 50% | uname/sysinfo 可用，procfs 提供基本进程信息；但 syslog 为存根，seccomp 不执行过滤，大量信息接口为静态/占位数据 | 系统信息接口存在但实用性有限，用于生产环境调试能力不足 |
| 信号机制 | 是 | 约 90% | 完整信号发送/接收/掩码/动作，sigtimedwait、signalfd，trampoline 映射，信号队列（siginfo 完整字段）；缺少 core dump、stop/continue 处理 | 信号机制实现是本项目最完善的子系统之一 |
| System V IPC | 部分 | 约 70% | 消息队列（884 行，含权限检查、消息类型过滤、MSG_EXCEPT/MSG_NOERROR）、共享内存（568 行，含延迟分配、引用计数、退出清理）完整；信号量未实现 | 两个 IPC 机制实现质量高，但信号量缺失造成 IPC 三角不完整 |
| 网络栈 | 是 | 约 75% | TCP/UDP/Unix Socket/VSOCK，CMSG 支持 SCM_RIGHTS FD 传递，Unix socket 三次握手模拟；缺少 IPv6、原始 socket、netfilter | 网络栈可满足基本通信需求，但协议和功能覆盖有限 |
| IO 多路复用 | 是 | 约 80% | epoll 支持 ET/LT/ONESHOT，ReadyQueue + InterestWaker，poll/ppoll/select/pselect6 可用 | epoll 实现机制较为完善，正确性需通过动态测试进一步验证 |
| TTY/PTY | 是 | 约 70% | PTY master/slave 对，环形缓冲，线路规程（规范/原始模式），ISIG 信号生成，作业控制框架 | 终端子系统架构完整，细节处理（如 termios 属性完整度）有待深入验证 |
| 设备驱动 | 是 | 约 60% | virtio-block/net/gpu，RTC，串口；依赖 ArceOS axdriver 框架 | 依赖上游框架的设备驱动支持，独立设备驱动能力较弱 |

## 七、总结评价

Starry_fix 是一个工程实现扎实的 Rust 语言 Linux 兼容宏内核项目。它在 ArceOS 组件化 unikernel 框架之上构建了约 200+ 个 Linux 系统调用的兼容层，核心机制（进程管理、内存管理、信号处理、futex、epoll、System V IPC）的实现质量较高，在同类 Rust 内核作品中系统调用覆盖度较为突出。

项目的技术贡献主要体现在工程层面：

1. **组件化框架逆用**：成功将本用于构建单地址空间 unikernel 的 ArceOS 组件重组为支持多进程隔离的宏内核，展示了一种有别于 "从头构建" 的内核开发路径。

2. **Rust 类型系统的有效利用**：FileLike trait 统一文件抽象、VmPtr/VmMutPtr 零开销用户内存访问、scope_local 实现线程局部资源管理等设计体现了 Rust 语言在系统软件工程中的优势。

3. **补丁式依赖管理**：通过 `[patch.crates-io]` 精确替换 4 个上游 crate 而非整体 fork，保持与上游的最大兼容性同时允许深度修改。

主要不足包括：多项内存管理高级特性为存根或退化实现、无 swap/page reclaim 机制、seccomp 和 capabilities 等安全机制实质缺失、文件系统实现深度不足、多线程 execve 不支持、命名空间和 cgroup 缺失等。

总体而言，该项目在 Linux ABI 兼容的广度上表现出色，但在内核机制的深度和安全性方面存在明确短板，适用于教学、研究或对内核功能要求不极端的嵌入式场景，距离通用目的的完整 OS 内核仍有显著距离。