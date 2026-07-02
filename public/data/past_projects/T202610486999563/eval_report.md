# whuse 操作系统内核技术画像与评估报告

## 一、项目基本信息

| 属性 | 内容 |
|---|---|
| 项目名称 | whuse |
| 架构 | RISC-V 64 (riscv64gc)、LoongArch 64 |
| 实现语言 | Rust（核心）+ 汇编（trap入口/上下文切换） |
| 内核类型 | 宏内核（Monolithic Kernel） |
| 生态归属 | UNIX/Linux 兼容（musl/glibc 用户态目标） |
| 目标平台 | QEMU virt（RISC-V: virt, LoongArch: virt） |
| 代码规模 | 约 29,400 行（含汇编与构建脚本） |
| 主要依赖 | ext4-view 0.9.3, spin, virtio-drivers (forked), fdt (vendored) |
| 特点 | 竞赛级看门狗系统、集成自检 init、内嵌用户态文件系统、惰性页表重建、自旋式阻塞系统调用 |

---

## 二、子系统与功能实现清单

whuse 实现了以下主要子系统和功能模块：

### 2.1 硬件抽象层（HAL）
- 跨平台 trait 接口定义（9 个 trait）
- RISC-V 64 QEMU virt 平台支持（UART、PLIC、VirtIO-MMIO、SBI timer）
- LoongArch 64 QEMU virt 平台支持（UART、PCH-PIC、VirtIO-PCI、CSR timer、TLB 重填）
- VirtIO 块设备驱动（扇区级读写）
- DMA 内存池管理

### 2.2 内存管理
- 物理帧分配（bump 分配器）
- 虚拟地址空间管理（匿名映射、共享映射、固定地址映射、文件映射）
- Sv39 页表构建（RISC-V）/ LoongArch 页表构建
- ELF64 加载器（静态与动态链接）
- mmap/munmap/mprotect/brk/mremap
- 基础 CoW 语义（Arc 共享帧）

### 2.3 进程管理
- 完整进程生命周期（fork/vfork/clone/execve/exit/wait）
- 线程支持（CLONE_THREAD、共享地址空间）
- 进程组/会话管理
- 进程凭证（uid/euid/gid/egid/groups）
- 信号系统（发送、掩码、pending、用户态处理器、信号帧构建/恢复）
- SIGCANCEL 线程取消（含 EINTR 活锁保护）
- Futex 完整实现（WAIT/WAKE/REQUEUE/CMP_REQUEUE/bitset、robust futex 清理）

### 2.4 任务调度
- 简单 FIFO 轮转调度
- 时间片抢占（10ms）
- 等待队列机制
- 阻塞/唤醒操作

### 2.5 虚拟文件系统（VFS）
- 内存文件系统（目录、文件、符号链接）
- EXT4 只读挂载与路径解析
- procfs（/proc/meminfo、/proc/uptime、/proc/mounts 等）
- devfs（/dev/console）
- tmpfs（/tmp）
- 管道（匿名管道）
- eventfd
- epoll
- Unix Domain Socket（抽象命名空间）
- 原始 socket（AF_INET/AF_INET6，进程间转发）

### 2.6 系统调用接口
- 约 130+ 个 Linux 系统调用实现
- 覆盖 fs、mm、task、signal、net、ipc、time、io_multiplexing、resource、sys 10 个域

### 2.7 内核核心
- 启动流程（HAL 初始化、VFS 播种、EXT4 探测、init 进程创建、主循环）
- Trap 处理分发（系统调用/定时器中断/外部中断/异常）
- 看门狗系统（竞赛超时管理、死锁检测、强制抢占）

### 2.8 用户态初始化
- 内嵌自检程序（eventfd/epoll/socketpair/signal/shm/clone/futex/fork 集成测试）
- 编译时嵌入用户态文件系统（busybox + 测试框架）

### 2.9 构建系统
- xtask 构建编排（Cargo 交叉编译、镜像制作、QEMU 启动、Docker 容器化评测）
- OS 竞赛完整评测流程集成

---

## 三、各子系统实现完整度

| 子系统 | 实现完整度 | 评估依据 |
|---|---|---|
| HAL（RISC-V） | 90% | 除 VirtIO-net 存根外，UART/块设备/PLIC/定时器/上下文切换均完整 |
| HAL（LoongArch） | 85% | 基本与 RISC-V 对等，但 init 自检程序功能精简 |
| 内存管理 | 65% | 帧分配器不可回收、CoW 语义不完整、无页面换出/惰性分配、无缺页处理 |
| 进程管理 | 85% | fork/clone/execve/exit/wait 完整，信号/futex 完整，缺 ptrace/core dump/资源限制 |
| 任务调度 | 30% | 仅 FIFO 轮转，无优先级/多核/CFS 调度 |
| VFS | 75% | 九种节点类型，内存/EXT4/proc/dev/tmp 多后端，socket 仅进程内转发，缺文件锁/xattr |
| 文件系统（EXT4） | 70% | 只读访问完整，stat/read/readdir/read_link 功能齐全，缺写入支持 |
| 系统调用 | 75% | 约 130+ syscall，覆盖核心 POSIX 接口，部分存根（sendfile/splice/flock/fallocate） |
| 网络 | 25% | Unix socket 完整，raw socket 仅进程间转发，无真实网络栈/TCP/UDP |
| IPC | 60% | System V 共享内存基本实现但数据同步不完整，缺消息队列/信号量 |
| 构建系统 | 85% | 双架构交叉编译、Docker 评测、LTP 过滤、镜像制作，缺增量构建优化 |

**内核整体实现完整度：约 70-75%**（以 musl busybox 功能兼容为基准，涵盖系统调用覆盖度、子系统功能完整性与边缘情况处理）。

---

## 四、各子系统优缺点及实现细节

### 4.1 HAL 抽象层

**优点：**
1. trait 抽象边界清晰。9 个核心 trait 完整定义了平台无关接口，内核其余部分仅通过 `hal()` 获取平台能力，实现了架构解耦。
2. 上下文切换实现精良。RISC-V 的 `__whuse_run_user` 和 `__whuse_user_trap_entry` 完整保存/恢复通用寄存器、浮点寄存器与 CSR，浮点上下文保存完整（32 个 FP 寄存器 + fcsr），满足 musl 用户态需求。
3. 双平台 VirtIO 双模支持。RISC-V 使用 MMIO 传输，LoongArch 使用 PCI 传输（ECAM 枚举），均能正确驱动 VirtIO-blk 设备。
4. DMA 内存池设计合理。基于位图的固定大小池支持分配/释放/地址转换，2MB 池满足块设备缓冲需求。

**缺点：**
1. VirtIO-net 未实现。两个平台均定义了 `VirtioNet` 探测逻辑（RISC-V 解析 FDT 中的 net 节点、LoongArch 通过 PCI 识别），但网络设备类型为存根，无法进行实际网络通信。
2. 代码重复。RISC-V 和 LoongArch 的上下文切换汇编在结构上高度相似但独立维护，增加移植新架构的成本。
3. 浮点状态无条件保存。在无浮点运算上下文中产生不必要的性能开销（RISC-V 32 个 8 字节浮点寄存器 = 256 字节/次切换）。

### 4.2 内存管理

**优点：**
1. 段存储模型设计精巧。`SegmentStorage` 三态（Owned/Shared/Host）覆盖了私有映射、共享映射、内嵌二进制加载三种场景，且通过 `Arc` 引用计数实现了自然的内存共享。
2. ELF 加载器功能完整。支持静态与动态链接 ELF，正确解析 PHDR、PT_INTERP、PT_GNU_STACK、PT_GNU_RELRO，构建完整的辅助向量（AT_PHDR/AT_ENTRY/AT_BASE/AT_RANDOM 等）。shebang 脚本支持（最多 4 跳递归）覆盖了常见脚本语言场景。
3. 惰性页表重建优化。`dirty` 标志机制避免了每次映射变更时的全量页表遍历，将重建延迟到实际地址空间切换时，减少批量映射操作（如 execve 加载 ELF）的页表更新开销。
4. mremap 实现。支持原地扩展/收缩和跨地址移动，这在同类项目中较少见。

**缺点：**
1. 帧分配器不可回收。`FrameAllocator` 为 bump 型分配器，`dealloc_page` 为空操作。物理帧仅在进程退出、整个地址空间销毁时才通过 `Arc` 引用计数回收，长时间运行或多进程场景下会导致物理内存耗尽。这是一种简化设计而非完整方案。
2. CoW 语义不完整。`clone_private` 通过 `Arc::clone` 共享物理帧，但缺页异常处理（`handle_trap` 中对非系统调用/非定时器/非外部中断的异常仅打印诊断并终止进程）未实现写时复制的触发逻辑。当任一进程写入共享页时，两个进程会看到相同修改，与标准 CoW 语义相悖。
3. 无换页支持。没有 swap 机制，物理内存耗尽时直接分配失败。
4. 映射预先分配物理帧。`map_anonymous` 在映射时即调用 `alloc_page` 分配全部物理帧，而非使用惰性分配（缺页时分配），这加剧了 bump 分配器的不可回收问题。
5. 静态 procfs 报告。`/proc/meminfo` 硬编码为 1GB 总内存，与实际物理内存容量无关，可能导致依赖该信息的用户态程序误判。

### 4.3 进程管理

**优点：**
1. 进程模型覆盖完整。支持 fork/vfork/clone/clone3/execve/exit/exit_group/wait/waitpid/id 全生命周期，含 CLONE_THREAD（线程）、CLONE_VFORK、CLONE_VM、CLONE_FILES、CLONE_SIGHAND 等标志。线程组语义（tgid 共享、group_exit）处理正确。
2. Futex 实现完备。支持 WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP/WAIT_BITSET/REQUEUE_PI，robust futex 在进程退出时自动清理（遍历 robust_list 链表并执行 FUTEX_OWNER_DIED 语义），私有/共享 futex 按地址区分等待队列。这些特性对 musl pthread 同步原语至关重要。
3. 信号帧与 musl 兼容。RISC-V 信号帧布局（siginfo_t 128 字节 + ucontext_t 含 mcontext_t）与 musl 一致，信号处理器 restorer 通过 `SIGNAL_TRAMPOLINE_BASE` 地址的 vDSO 风格 trampoline 实现。SIGCANCEL（信号 33）支持 musl 线程取消语义，含 EINTR 活锁保护（1000 次计数后强制退出线程）。
4. 进程退出清理全面。`exit_current_thread` 和 `exit_current_process_group` 处理了 robust futex 遍历（最多 2048 条目防死循环）、clear_child_tid 唤醒、vfork 父进程唤醒、SIGCHLD 投递。

**缺点：**
1. `fork_from` 中 CoW 语义的不完整性（见 4.2 节）直接影响进程管理的正确性。对于写时复制的期望与实际的共享行为之间的差异，可能导致依赖 CoW 语义的应用程序（如 Python multiprocessing）出现未定义行为。
2. waitpid 选择器虽支持 PID/PGID/ALL/WNOHANG/WUNTRACED，但对 WCONTINUED 的处理在代码中未见明确实现。
3. 资源限制（rlimit）均为存根（getrlimit 返回硬编码值），setrlimit 不接受实际修改。
4. 无 ptrace 支持，无法进行进程跟踪/调试。

### 4.4 任务调度

**优点：**
1. 自旋式阻塞模型简洁。通过不递增 `sepc` 实现阻塞系统调用的自动重试，避免了复杂的内核线程休眠栈管理与唤醒路径。这种设计在单核协作式调度的基础上实现了类似抢占的行为。
2. 等待队列实现规范。`WaitQueue` 提供 `wake_one`/`wake_all` 语义，正确维护 FIFO 顺序，通过 `WaitToken` 实现 RAII 风格的自动取消注册。
3. 定时器中断驱动的抢占。10ms 时间片（`SCHED_TIME_SLICE_NS`）通过内核定时器中断强制执行，而非依赖用户态主动 yield。

**缺点：**
1. 调度策略过于简单。FIFO 轮转无优先级区分，I/O 密集型任务（如 busybox sh 脚本）和 CPU 密集型任务（如 lmbench）获得相同的调度机会，可能导致交互响应延迟和吞吐量下降。
2. 强制抢占为启发式方案。针对 iozone 工作负载的 5ms 强制抢占（`FORCED_PREEMPT_DELTA_NS`）通过硬编码的进程名判断触发，缺乏通用性。
3. 无多核支持。调度器数据结构（`ready: VecDeque<Task>`）无 per-CPU 队列或负载均衡机制。
4. 无实时调度。不支持 SCHED_FIFO/SCHED_RR/SCHED_DEADLINE 策略。

### 4.5 虚拟文件系统

**优点：**
1. 节点类型丰富。支持目录、文件、字符设备、proc、管道、符号链接、eventfd、epoll、socket、pidfd 共 10 种节点类型，其中 eventfd/epoll/socket 具备完整的操作语义。
2. 路径解析正确。`lookup_abs` 正确处理 `.`、`..`、多余 `/`、符号链接递归（ELOOP 检测，最多 40 跳）。
3. 多后端统一接口。内存文件系统、EXT4 只读挂载、procfs、devfs、tmpfs 通过统一的 `NodeData` 枚举和 `KernelObject` trait 进行读写操作，外部挂载列表管理 EXT4 与内存 VFS 的路径映射。
4. EXT4 缓存优化。`ext_stat_cache` 缓存 stat 结果，`ext_dir_lite_cache` 缓存目录项（仅名称和类型），减少块设备 I/O。`external_preloaded` 标志支持批量预加载。
5. Unix socket 实现完整。支持抽象命名空间地址（`/__unix_abstract__/` 前缀）、SOCK_STREAM 语义（bind/listen/accept/connect/send/recv）、监听队列、连接队列、双向通道通信。

**缺点：**
1. EXT4 只读。无法创建、修改或删除 EXT4 文件系统中的文件，限制了需要写操作的场景。
2. 网络功能仅进程间转发。raw socket 通过匹配其他进程的相同协议族 raw socket 投递数据包，无真实网络设备驱动和协议栈（无 ARP/ICMP 处理/IP 路由），`sendto`/`sendmsg` 不能实现实际的网络通信。
3. 文件锁存根。`flock` 直接返回 0（假装成功），可能导致依赖文件锁实现互斥的应用程序出现竞态条件。
4. 静态 procfs 内容。`/proc/meminfo`、`/proc/stat` 等关键 proc 文件内容为编译时固定值，不反映运行时系统状态。
5. VFS 全部实现集中于单个 3,075 行的 `lib.rs` 文件，缺乏模块化组织。

### 4.6 系统调用

**优点：**
1. 域分发架构清晰。10 个域模块通过 `or_else` 链式尝试，每个域模块内部通过宏（如 `dispatch_syscall!`）消除重复的模式匹配代码。
2. 阻塞重试机制巧妙。通过返回 `EAGAIN`（不递增 sepc）实现系统调用的自动重试，将异步等待转换为同步阻塞的编程模型，降低了每个系统调用处理函数的实现复杂度。
3. 系统调用覆盖广。约 130+ 个系统调用涵盖了文件 I/O（open/read/write/close/stat/getdents/lseek/readv/writev/pread64/pwrite64/sendfile 存根等）、进程（fork/vfork/clone/clone3/execve/exit/exit_group/wait4）、内存（mmap/munmap/mprotect/brk/mremap/madvise 存根）、信号（kill/tkill/tgkill/rt_sigaction/rt_sigprocmask/rt_sigsuspend/rt_sigpending/rt_sigreturn）、socket（socket/bind/listen/accept/connect/sendto/recvfrom/getsockname/getpeername/getsockopt/setsockopt）、IPC（shmget/shmat/shmdt/shmctl）、时间（nanosleep/clock_gettime/clock_nanosleep/gettimeofday/times/adjtimex）、I/O 多路复用（select/pselect6/poll/ppoll/epoll_create1/epoll_ctl/epoll_pwait）、futex（完整）和系统信息（uname/sysinfo）。

**缺点：**
1. 存根系统调用存在风险。部分存根（如 `flock` 返回 0、`madvise` 返回 0、`sendfile` 返回 ENOSYS）可能导致依赖精确返回值的用户态程序产生未定义行为。例如 `sendfile` 是某些 Web 服务器的关键性能路径，ENOSYS 会导致其回退到 read/write，但存根行为使该回退不可预期。
2. 无 ptrace 相关系统调用（ptrace、process_vm_readv/writev），限制调试能力。
3. 无 seccomp 支持。

---

## 五、动态测试的设计与结果

### 5.1 内嵌自检测试

whuse 在用户态初始化阶段（`user-init`）内嵌了一套集成自检程序（RISC-V 平台）。该程序以手写汇编实现，在 init 进程创建时作为 entry 执行，顺序测试以下功能：

1. **基础 I/O**：向 stdout 写入 "user:init entered"
2. **eventfd + epoll**：创建 eventfd、epoll_create1、epoll_ctl、epoll_wait
3. **socketpair**：创建 Unix socket 对，进行数据收发验证
4. **信号**：注册信号处理器、sigprocmask 阻塞信号、rt_sigtimedwait 等待信号
5. **System V 共享内存**：shmget 创建、shmat 附加、shmctl 控制、shmdt 分离
6. **clone + futex**：创建子任务（CLONE_VM），通过 futex 进行父子同步
7. **fork + waitpid**：创建子进程并等待退出

自检通过后打印 "user:integration ok"，然后执行 `execve` 启动 busybox 竞赛环境。

**测试优势：**
- 每次内核启动自动执行，零人工干预
- 覆盖内核的多个关键子系统（VFS/信号/调度/futex/共享内存）
- 失败时可在 QEMU 串口输出中立即定位问题子系统

**测试局限：**
- 仅验证单一路径（happy path），不测试错误处理路径
- 不测试并发竞态条件
- LoongArch 平台的自检程序功能精简（仅打印消息），未获得同等的自动化验证

### 5.2 竞赛基准测试框架

xtask 构建系统集成了 OS 竞赛的完整评测流程：

- **Stage 1**：基础功能测试（依赖 init 自检通过）
- **Stage 2**：基准测试套件（busybox testcode、libctest/LTP、libc-bench、lmbench、unixbench、iozone、lua、netperf/iperf、cyclictest）
- 支持 profile 过滤（`full`/`basic`/`busybox`/`libc`/`lmbench`/`unixbench`/`iozone`/`lua`/`netperf`/`iperf`/`ltp`/`cyclictest`）
- Docker 容器化运行，`timeout` 命令包装（3600s 默认超时）
- LTP 支持白名单/黑名单测试用例过滤

**注意**：本次分析未进行实际基准测试运行（需 Docker 环境与特定容器镜像，以及包含测试程序的 EXT4 根文件系统镜像），因此无法提供测试通过率或性能数据。

---

## 六、细则评价表格

### 6.1 内存管理

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 65% |
| 关键发现 | 采用 bump 型帧分配器，物理帧释放为空操作，内存仅在进程退出时通过 Arc 回收；CoW 通过 Arc 共享物理帧但缺页处理路径缺失，写操作会实际修改共享页，不符合标准 CoW 语义；无页面换出/swap；ELF 加载器功能齐全（静态/动态/shebang） |
| 评价 | 内存管理实现了用户态所需的核心抽象（虚拟地址空间、多种映射类型、ELF 加载、页表构建），但帧管理的不可回收性和 CoW 语义缺失是两个根本性缺陷，限制了长时间运行和内存密集型场景的可用性。惰性页表重建和 mremap 支持是工程亮点 |

### 6.2 进程管理

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 85% |
| 关键发现 | fork/clone/execve/exit/wait 生命周期的完整实现，CLONE_THREAD 线程语义正确，vfork 与父进程阻塞同步；futex 实现完备（WAIT/WAKE/REQUEUE/CMP_REQUEUE/bitset/robust），等待队列按地址区分共享/私有；信号帧布局与 musl 二进制兼容，SIGCANCEL 支持 musl 线程取消，含 EINTR 活锁保护（1000 次上限）；缺 ptrace、core dump、cgroups |
| 评价 | 进程管理是 whuse 最成熟的子系统之一。futex 的完整性和信号帧的 musl 兼容性是支撑复杂用户态（如 pthread-intensive 应用）的关键工程成果。EINTR 活锁保护（1000 次后强制线程退出）是一种务实的工程防御，避免循环中 EINTR 导致的 CPU 自旋。进程退出的 robust futex 清理逻辑（最多 2048 条目遍历）考虑周全 |

### 6.3 文件系统

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 75%（VFS 框架）/ 70%（EXT4） |
| 关键发现 | VFS 支持 10 种节点类型（目录/文件/字符设备/proc/管道/符号链接/eventfd/epoll/socket/pidfd），多后端统一接口（内存/EXT4/proc/dev/tmp）；EXT4 只读访问完整（stat/read/readdir/read_link/exists），目录项缓存优化（Ext4DirEntryLite）；Unix socket 完整（抽象命名空间、SOCK_STREAM、监听/连接队列）；EXT4 无写入支持，网络功能仅进程间 raw socket 转发，关键 proc 文件（meminfo/stat）内容静态 |
| 评价 | VFS 框架设计灵活，节点类型丰富满足 busybox 和基本服务需求。epoll/eventfd/socket 三大 Linux I/O 多路复用机制的实现质量较高。EXT4 只读访问能正确加载根文件系统和执行其中的二进制文件。但 procfs 的静态数据（如 meminfo 固定 1GB）可能误导依赖运行时内存信息的应用程序。VFS 全部逻辑集中于单个 3,075 行文件，模块化不足 |

### 6.4 交互设计

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 80% |
| 关键发现 | 内核通过 NS16550 UART 提供串口字符设备交互（/dev/console），init 进程自动映射 stdin/stdout/stderr 到控制台；集成自检程序在启动时打印测试进度和结果；看门狗系统输出超时诊断信息；内核 panic 时打印 trap 帧和调用栈；构建系统支持本地 QEMU 启动（cargo xtask qemu-riscv）一键交互 |
| 评价 | 开发者交互体验良好：自检程序提供快速功能验证，调用栈诊断辅助调试，一键 QEMU 启动降低使用门槛。运行时交互通过串口实现基本输入输出，满足竞赛评测的文本交互需求。缺少图形终端、网络终端（SSH）等高级交互方式，但这对竞赛场景并非必需 |

### 6.5 同步原语

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 85% |
| 关键发现 | Futex 实现覆盖 WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAIT_BITSET/WAKE_OP/REQUEUE_PI op 码；支持共享/私有 futex（按进程地址空间+地址区分等待队列）；robust futex 在进程退出时自动遍历 robust_list（最多 2048 条目）并执行 FUTEX_OWNER_DIED 唤醒；进程表维护全局 futex 等待队列映射；死锁检测在定时器中断中执行（全阻塞 futex 等待者强制唤醒）；自旋锁（spin crate）用于内核内部互斥 |
| 评价 | Futex 作为 Linux 用户态同步的基石（pthread mutex/condvar/barrier 等均依赖），其实现的完整性是 whuse 能运行复杂多线程用户态程序的关键。robust futex 处理考虑周全（断链检测、2048 上限防死循环）。死锁检测（全 futex 阻塞时强制唤醒）是一种主动防御措施 |

### 6.6 资源管理

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 45% |
| 关键发现 | 文件描述符通过 BTreeMap<i32, FileHandle> 管理，支持 CLOEXEC 自动关闭；物理帧通过 Arc 引用计数在进程退出时回收，但无运行时碎片回收；bump 分配器不回收空闲帧；内嵌文件系统通过编译时 include_bytes! 静态占用内核内存；32 位 buddy 分配器管理内核堆（RISC-V 224MB/LoongArch 192MB）；系统资源限制（rlimit）均为存根；无 cgroups |
| 评价 | 资源管理实现了基本的分配和生命周期追踪（文件描述符、物理帧的引用计数），但缺乏主动回收和限制机制。bump 帧分配器是最大的资源管理短板，多进程场景下无法回收已释放的内存。rlimit 存根导致无法对进程施加内存/文件/CPU 限制。buddy 分配器实现对内核堆的管理是可靠的 |

### 6.7 时间管理

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 70% |
| 关键发现 | 支持 clock_gettime（CLOCK_MONOTONIC/CLOCK_REALTIME/CLOCK_PROCESS_CPUTIME_ID/CLOCK_THREAD_CPUTIME_ID），通过 HAL timer 获取单调时间；nanosleep/clock_nanosleep 通过设置 sleep_deadline_ns 实现（精度为定时器中断周期 10ms）；定时器中断驱动 10ms 时间片抢占；看门狗使用 wall time 计时（通过启动时间戳 + 单调时间差值计算）；adjtimex 存根（允许调用但无实际时钟调整）；itimers（SIGALRM）通过定时器中断检查到期 |
| 评价 | 时间管理满足基本需求。单调时钟和实时时钟的提供使得用户态时间相关 API 可用。nanosleep 精度受限于 10ms 定时器中断周期（而非微秒级高精度定时器），对 cyclictest 等实时性测试影响显著。缺少 HPET/APIC timer 等更高精度时钟源的支持 |

### 6.8 系统信息

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 55% |
| 关键发现 | uname 返回硬编码系统信息（"Linux 6.8.0-whuse"）；sysinfo 返回部分真实值（uptime 通过单调时间计算、进程数通过进程表计数）和固定值（总内存 1GB、共享内存 0）；/proc 提供 meminfo/uptime/stat/version/mounts/self/stat 等节点，但关键条目（meminfo、stat）内容为静态编译时常量；hostname 通过 sethostname 设置但未持久化；进程级资源使用统计（getrusage）为存根 |
| 评价 | 系统信息提供了基本的 uname/sysinfo/proc 查询能力，满足多数用户态程序的兼容性需求。但静态的 /proc/meminfo（固定 1GB 总内存）和 /proc/stat（固定 CPU 统计）可能导致依赖这些信息的监控工具（如 top/free/vmstat）显示无意义数据。动态计算 uptime 是正确做法 |

### 6.9 网络子系统

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 20% |
| 关键发现 | Unix Domain Socket 实现完整（抽象命名空间、SOCK_STREAM、bind/listen/accept/connect/send/recv）；raw socket（AF_INET/AF_INET6）仅通过进程间匹配转发（同协议族 raw socket 互相投递），无真实网络设备驱动、协议栈或数据包收发；getsockopt/setsockopt 支持部分选项（IPV6_V6ONLY/IPV6_JOIN_GROUP/IPV6_LEAVE_GROUP/SO_TYPE 等）；VirtIO-net 设备探测代码存在（FDT 解析/PCI 识别）但未实现数据传输 |
| 评价 | 网络子系统仅提供进程间通信的基础设施（Unix socket），不具备任何实际网络通信能力。raw socket 的进程间转发是一种有趣的模拟，允许依赖 socket API 的应用程序在单机环境下不报错，但不能用于网络通信。对 netperf/iperf 等网络基准测试而言，此实现无法提供有意义的结果 |

### 6.10 构建与竞赛集成

| 项目 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，完整度 85% |
| 关键发现 | xtask 提供统一构建入口（cargo xtask build-riscv/la、image-riscv/la、qemu-riscv/la、oscomp-riscv/la）；支持 Docker 容器化竞赛评测（docker.educg.net/cg/os-contest:20260104 镜像）；双阶段评测流程（Stage 1: 基础功能，Stage 2: 基准测试套件）；看门狗按进程名自动匹配超时策略（busybox_testcode.sh 10min、libctest 10min+LTP 30min、lmbench 15min、iozone 20min、默认 20min）；LTP 白名单/黑名单过滤；libc-test 已知失败列表管理（expected_fails.txt）；内核二进制通过 objcopy 转换为 raw binary 格式 |
| 评价 | 构建与竞赛集成是 whuse 工程化最成熟的方面。xtask 提供了一站式的构建-打包-运行-评测工作流。看门狗的超时策略细化到单 benchmark 粒度，名称变化自动重置计时器的设计体现了对竞赛场景的深入理解。LTP 白/黑名单和 libc-test 失败列表管理反映出持续集成中对测试结果的系统化追踪 |

---

## 七、总结评价

### 7.1 项目概览

whuse 是一个面向 **OS 竞赛场景**的 UNIX 兼容宏内核，使用 Rust 语言实现，支持 RISC-V 64 和 LoongArch 64 双架构。内核实现了约 130+ 个 Linux 系统调用，覆盖文件 I/O、进程管理、信号、内存管理、socket IPC、epoll、futex 等关键子系统，能够运行基于 musl 的 busybox 环境及一系列竞赛基准测试程序。

### 7.2 核心优势

1. **系统调用覆盖广泛**。130+ 个系统调用的实现量在同类 Rust OS 竞赛项目中属于较高水平，尤其是 futex、epoll、eventfd 三大机制的完整实现支撑了复杂用户态的多线程和多路 I/O 需求。

2. **进程管理成熟**。fork/clone/execve/exit/wait 生命周期实现完整，CLONE_THREAD 线程语义正确，信号帧与 musl 二进制兼容，SIGCANCEL 支持 musl 线程取消，robust futex 清理逻辑周全。EINTR 活锁保护（1000 次后强制退出）是务实的工程防御。

3. **HAL 抽象设计合理**。9 个 trait 定义的平台接口边界清晰，RISC-V 和 LoongArch 双架构的实现保持了架构独立性，上下文切换汇编代码质量良好。

4. **竞赛工程化成熟**。看门狗系统（按 benchmark 粒度的超时策略、死锁检测、名称变化自动重置）、集成自检 init（启动时自动验证 7 个核心子系统）、内嵌用户态文件系统（编译时嵌入 busybox）、Docker 容器化评测流程，这些构成了一个面向竞赛场景的完整解决方案。

5. **ELF 加载器功能完备**。支持静态/动态链接、shebang 脚本递归、辅助向量构建、PT_GNU_STACK/PT_GNU_RELRO 处理。

### 7.3 主要不足

1. **内存管理存在根本性缺陷**。bump 帧分配器不可回收物理帧，CoW 语义因缺页处理缺失而名存实亡（写操作实际修改共享页），这两个问题直接影响了多进程场景下的正确性和可用性。

2. **网络子系统形同虚设**。raw socket 仅实现进程间转发，无真实网络协议栈或设备驱动，不能进行任何实际网络通信。

3. **代码存在技术债务**。VFS 3,075 行集中于单文件，RISC-V 和 LoongArch 的内核核心代码高度重复，两个平台各有一套独立实现的 buddy 分配器。

4. **调度器过于简单**。FIFO 轮转无优先级区分，iozone 强制抢占依赖硬编码启发式，无多核支持。

5. **部分存根实现存在风险**。`flock` 返回 0（假装获取锁成功）、`sendfile` 存根、静态 `/proc/meminfo` 等，可能导致依赖这些接口的应用程序产生不易排查的错误行为。

### 7.4 适用场景

whuse 适合作为 OS 竞赛的参赛项目，其系统调用的广度和竞赛工具链的成熟度使其能够在 busybox、LTP、lmbench、unixbench 等基准测试中获得有竞争力的成绩。但受限于内存管理和网络栈的不足，不适用于需要长时间稳定运行、真实网络通信或严格 POSIX 兼容的生产环境。

### 7.5 改进建议

1. 将帧分配器替换为可回收的伙伴系统或 SLAB 分配器。
2. 在缺页异常处理中实现真正的 CoW 触发逻辑。
3. 模块化 VFS 代码，提取各节点类型为独立模块。
4. 统一双平台的内核核心代码，通过条件编译减少重复。
5. 实现基本的 TCP/UDP 协议栈或集成 lwIP/smoltcp。
6. 将 procfs 的关键条目改为动态计算运行时数据。