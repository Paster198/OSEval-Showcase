# GCore OS 内核技术画像与评估报告

## 一、项目基本信息

| 项目属性 | 内容 |
|--------|------|
| 项目名称 | GCore |
| 内核架构 | 单体内核（类 Unix） |
| 目标架构 | RISC-V 64（Sv39 MMU）、LoongArch 64（LA-Flex MMU） |
| 实现语言 | Rust（核心代码约 64,000 行，不含 vendor） |
| 生态归属 | 独立内核，用户态兼容 glibc/musl C 运行时 |
| 主要外部依赖 | smoltcp（TCP/IP），lz4_flex（压缩），buddy_system_allocator，spin，downcast-rs 等 |
| 系统调用数量 | 约 139 个（基于 RISC-V Linux ABI 编号方案） |
| 支持的文件系统 | ext4（含 extent 树），FAT32（VFAT），设备文件系统 |
| 网络支持 | Loopback 设备，TCP/UDP/ICMP/Unix Domain Socket（基于 smoltcp） |
| 动态链接 | 支持 ELF 解释器加载，提供动态链接器 |
| 用户态程序 | busybox、bash、lua、lmbench、LTP、自定义 initproc |
| 独特设计 | 双架构统一 HAL、ext4 extent 完整实现、三级内存回收（Zram+Swap+OOM）、信号 trampoline |

## 二、已实现子系统和功能

GCore 实现的子系统覆盖范围如下：

- **内存管理**：物理页帧分配（伙伴系统）、虚拟地址空间管理、mmap/munmap/mprotect、写时复制（CoW）、延迟分配、页面缓存、Zram 压缩内存、Swap 交换、OOM Handler、mlock/mlockall/munlockall、mincore、madvise、brk/sbrk。
- **进程管理**：进程与线程创建（fork/clone）、ELF 程序加载（execve）、进程退出（exit/exit_group）、等待子进程（wait4/waitid）、PID/TID 分配与回收、进程组/会话管理、调度器（FIFO）、CPU 时间统计、资源使用统计（rusage）、prctl/prlimit。
- **文件系统**：VFS 统一接口、目录树缓存与路径解析、文件描述符表、ext4 文件系统（含 extent 树、超级块、块组、块/inode 分配、CRC32c）、FAT32 文件系统（含长文件名）、设备文件（/dev/null, /dev/zero, /dev/tty, /dev/urandom, /dev/hwclock, /dev/timerfd, /dev/proc_meminfo）、管道（Pipe）、套接字文件、poll/ppoll/select、sendfile/splice、文件锁（flock）、fsync/fdatasync。
- **信号**：POSIX 信号 1~30、实时信号 SIGRTMIN~SIGRTMAX (64个)、sigaction/sigprocmask/sigtimedwait/sigpending/sigsuspend、sigaltstack、sigreturn trampoline、默认信号动作。
- **同步原语**：futex（FUTEX_WAIT/FUTEX_WAKE/FUTEX_REQUEUE/FUTEX_WAKE_OP）、robust list、Pipe（阻塞读写）。
- **网络**：TCP/UDP/ICMP/Unix Domain Socket（基于 smoltcp + Loopback）、socket 接口族（socket/bind/listen/accept/connect/sendmsg/recvmsg/setsockopt/getsockopt/shutdown）、非阻塞 I/O。
- **时间管理**：RTC 时间、高精度时钟（clock_gettime）、定时器（itimerval、timerfd_create/settime/gettime）、进程时钟、nanosleep/clock_nanosleep。
- **设备驱动**：VirtIO MMIO/PCI 块设备、SATA AHCI 块设备、内存模拟块设备、NS16550A 串口控制台。
- **系统信息**：uname、sysinfo、syslog。
- **架构抽象层**：RISC-V（Sv39）和 LoongArch（LA-Flex）两套页表实现、陷阱处理（含 TLB 重填）、上下文切换、启动流程、平台配置（QEMU virt、SiFive FU740、Kendryte K210、龙芯 2K1000）。
- **构建与日志系统**：条件编译 feature flag 体系，分级日志，vendored 依赖管理。

## 三、子系统实现完整程度

以 Linux 内核对应子系统典型功能集为参照基准（即一个完整的单体内核所应具备的核心能力），各子系统实现程度评估如下：

| 子系统 | 实现完整度 | 说明 |
|--------|----------|------|
| 内存管理 | 80% | 虚拟地址空间、CoW、mmap、Swap、Zram、OOM Handler 均已实现；缺匿名共享内存（shmget 等 SysV IPC）及大量页面替换算法。 |
| 进程管理 | 85% | fork/execve/exit/wait 体系完备，支持线程组和 TLS；调度器过于简单（FIFO），无优先级、时间片、多核负载均衡。 |
| 文件系统 | 90% | 支持 ext4 extent 和 FAT32 VFAT，VFS 接口统一，缺 hard link 的严格原子性保证以及复杂的 POSIX ACL/扩展属性。 |
| 信号处理 | 85% | 64 信号、sigaction、sigaltstack、trampoline 均已实现；缺 sigqueue 携带值的多实例排队，信号实时性限于非抢占式调度。 |
| 同步原语 | 75% | futex 基本操作、robust list 均已实现；缺进程间信号量、消息队列等 SysV IPC，FUTEX_CMP_REQUEUE_PI 等 PI futex 未实现。 |
| 时间管理 | 70% | 支持多种时钟源、定时器、itimerval、timerfd；缺高精度定时器（hrtimer）框架、时间命名空间。 |
| 网络栈 | 65% | TCP/UDP/ICMP/Unix Socket 可用，但仅 Loopback，无真实网卡驱动，缺路由、ARP、IP 分片重组等完整网络层功能。 |
| 设备驱动 | 50% | 仅块设备和串口，缺其他标准 VirtIO 设备（gpu, input, rng），无总线枚举框架。 |
| 跨架构支持 | 70% | 双架构 HAL 抽象合理，但 SMP 多核启动在 LoongArch 部分不完整。 |
| 整体评估 | **75%** | 核心路径可支持复杂用户态程序运行，若干边缘功能仍为存根或缺失。 |

## 四、各子系统实现细节与优缺点

### 4.1 内存管理

**实现细节**：物理帧分配基于 buddy_system_allocator，以 Arc<FrameTracker> 管理生命周期；虚拟地址空间通过 MemorySet 和 MapArea 组织，每个虚拟页的映射状态由 Frame 枚举描述（Framed、FramedCoW、File、Zram、Swapped）。缺页处理在 do_page_fault 中根据映射类型完成延迟分配、CoW 复制、Swap-in 或 Zram 解压。Zram 使用 lz4_flex 块压缩，Swap 在文件系统上分配连续区域并通过位图管理。OOM Handler 通过 frame_reserve(3) 触发，对可中断和就绪进程分别执行深度或浅层页面回收。

**优点**：
- 内存回收体系完整，Zram + Swap + OOM Handler 构成多层次回收，能在紧张条件下维持运行。
- CoW 和延迟分配机制显著降低 fork 开销和实际内存占用。
- Page Cache 与文件系统耦合自然，文件映射 mmap 可直接复用页缓存。
- 内核-用户数据拷贝函数（copy_from_user 等）内置缺页处理，健壮性好。

**缺点**：
- 内存回收策略较简单，回收时缺乏活跃度老化机制（如 LRU），可能导致频繁 I/O。
- 物理帧分配器缺少 NUMA 感知或反碎片化措施。
- mmap 缺乏 MAP_GROWSDOWN 等复杂标志的完整实现。
- 没有大页（Hugepage）支持，TLB 覆盖效率受限。

### 4.2 进程管理

**实现细节**：TaskControlBlock 将不变字段（pid, tid 等）与 Mutex 保护的 inner 及可共享资源（vm, files, sighand 等）分离。clone 通过标志位控制共享程度，execve 通过 ELF 加载器构建新地址空间，包括处理 ELF 解释器。调度器采用简单的 FIFO 就绪队列和可中断睡眠队列，使用 switch.S 汇编实现上下文切换。进程退出后进入 Zombie 状态，父进程通过 wait4 回收。PID 分配器支持回收重用。

**优点**：
- 结构清晰，资源分离设计使 fork 和 clone 的实现直观、共享控制精细。
- 支持线程组（TGID）、TLS 设置（通过 set_tid_address）、clear_child_tid 等现代线程机制。
- 进程树正确维护，子进程退出时自动过继给 init 进程，避免僵尸堆积。
- ELF 加载器支持解释器，可运行动态链接的程序。

**缺点**：
- 调度器过于简单，无优先级和时间片，所有就绪任务完全平等，导致交互性差。
- 没有 cgroup 或资源限额机制。
- 未实现多核调度（SMP 启动代码被注释），当前仅运行于单核。
- 缺乏实时调度类（SCHED_FIFO/SCHED_RR）。

### 4.3 文件系统

**实现细节**：VFS 层通过 File trait 统一所有文件类型，DirectoryTreeNode 构成目录树缓存，实现路径解析（处理 .、..、符号链接）和目录项延迟加载。FileDescriptor 封装标志和 Arc<dyn File>，FdTable 以向量和回收列表管理描述符。ext4 子系统完整实现超级块、块组描述符、extent 树（搜索、分裂、合并）、位图块/inode 分配、目录项操作和 CRC32c 校验。FAT32 支持 BPB 解析、FAT 链遍历、短/长文件名，并包含针对 LoongArch 非对齐访问的汇编规避代码。页面缓存层以 PageCache 和 BufferCache 提供块级和页级缓存，支持脏页写回。

**优点**：
- ext4 extent 树实现具有相当深度，覆盖了查找、插入时的分裂与合并，接近生产系统核心逻辑。
- VFS 设计简洁且可扩展，设备文件、管道、套接字均可融入同一接口。
- 目录树缓存和路径解析效率高，支持符号链接及路径缓存加速。
- Page Cache 与文件系统和 mmap 无缝集成。
- 为不同架构编译器缺陷提供特定规避代码，体现真实硬件测试深度。

**缺点**：
- ext4 不支持日志（journal）模式，意外掉电可能导致文件系统不一致。
- 目录项缓存缺乏完善的失效机制，可能引发陈旧的 dentry 问题。
- FAT32 的写入性能较低，缺少 FAT 表缓存优化。
- 未实现伪文件系统（procfs/sysfs），系统信息暴露方式有限。

### 4.4 信号处理

**实现细节**：信号集以位标志表示（RISC-V 用 usize，LoongArch 用 u128），支持 64 个信号。do_signal 在从内核返回用户态前执行，遍历未屏蔽的 pending 信号，对 SIG_DFL 执行默认动作，对自定义 handler 在用户栈上布置 sigframe（保存原上下文），并修改返回地址指向信号处理函数。sigreturn trampoline 位于专用内存页 SIGNAL_TRAMPOLINE，通过 sys_sigreturn (139) 恢复上下文。sigaltstack 可指定备用信号栈。

**优点**：
- 信号处理流程完整，支持嵌套信号处理和 sa_mask 屏蔽。
- 实时信号数量充足，可满足多数应用需求。
- sigaltstack 实现正确，提高了信号处理的可靠性。
- trampoline 设计干净，不依赖特殊库函数。

**缺点**：
- 信号队列实现为简单位图 + 计数值，rt_sigqueueinfo 携带的值可能丢失，不完全符合 POSIX 实时信号排队要求。
- 默认动作中的 Stop/Cont 实现可能不完整（进程组停止/继续缺乏作业控制支持）。
- 信号递送时机仅在 trap_return 中，延迟可能较大，且无法在内核关键路径上被打断。

### 4.5 同步原语

**实现细节**：Futex 基于 BTreeMap<usize, WaitQueue>，支持 FUTEX_WAIT、FUTEX_WAKE、FUTEX_REQUEUE、FUTEX_WAKE_OP 操作。等待队列支持超时和批量唤醒。Robust list 在进程退出时清理持有的 robust mutex。Pipe 采用环形缓冲区（默认 64KB），读写端通过弱引用检测对方关闭，阻塞等待采用 suspend/block 机制。

**优点**：
- Futex 实现了 requeue 和 wake_op 等高级操作，可支持条件变量高效实现。
- Robust list 实现健壮性，防止 mutex 持有者异常退出造成死锁。
- Pipe 缓冲区容量较大，阻塞行为正确。

**缺点**：
- 未实现 PI futex（FUTEX_LOCK_PI/FUTEX_UNLOCK_PI 等），不能用于实时互斥锁优先级继承。
- 等待队列在大量等待者时线性操作，效率可能下降。
- 无 POSIX 信号量、消息队列等 SysV IPC 机制，多进程同步手段受限。

### 4.6 资源管理

**实现细节**：文件描述符、内存映射、套接字等都通过引用计数 (Arc) 管理生命周期，内核对象在最后一个引用释放时自动回收（如 FrameTracker Drop 归还物理帧）。进程退出时通过 do_exit 清理：回收用户地址空间页面（recycle_data_pages），关闭所有文件描述符，释放套接字和信号处理表，归还 PID，并向父进程发送 SIGCHLD。OOM Handler 作为全局资源紧急回收机制。

**优点**：
- 基于 RAII 的资源管理模式避免了显式释放错误，代码安全性高。
- 进程退出时资源清理比较彻底。
- 文件描述符表使用回收列表，分配和释放均摊 O(1)。

**缺点**：
- 缺乏进程级别的资源使用限额（rlimit 部分实现但未实际限制），一个进程可能耗尽系统内存或文件描述符。
- 没有全局资源审计和报警机制。
- 内核空间本身的内存分配（堆分配器）没有界限控制。

### 4.7 时间管理

**实现细节**：通过 HAL 层的 get_time 和 get_clock_freq 获取硬件时间基。TimeSpec/TimeVal/ITimerSpec 等类型提供时间运算和转换。时钟源主要为单调时钟和实时时钟，支持 clock_gettime、clock_nanosleep。定时器包括 itimerval（REAL/VIRTUAL/PROF）和 timerfd，定时到期后通过信号或 fd 可读事件通知。进程统计维护 utime/stime。

**优点**：
- 支持多种时钟源和定时器类型，timerfd 提供统一的事件循环集成方式。
- 时间运算正确处理秒/纳秒进位，避免常见溢出错误。
- 进程时间统计可基本满足资源审计需求。

**缺点**：
- 缺乏高精度定时器框架，定时精度受限于调度 ticks。
- RTC 初始化后未处理时间同步或 NTP 调整，长时间运行可能出现时钟漂移。
- 没有各 CPU 的定时器抽象，多核下每核局部定时器未实现。

### 4.8 系统信息

**实现细节**：sys_uname 返回内核名称、版本、机器类型等信息。sys_sysinfo 返回内存、交换区、进程数等统计。syslog 实现为简单日志缓冲区读取。

**优点**：
- 提供了基本系统信息获取系统调用。
- 实现简洁，满足基本需求。

**缺点**：
- 信息获取不全面，例如没有单独的进程统计接口（除 getrusage 外）。
- syslog 功能较弱，未实现内核日志分级缓存和管理。

### 4.9 网络栈

**实现细节**：基于 smoltcp 0.10.0 实现 TCP/UDP/ICMP 及 Unix Domain Socket。NetInterface 封装 Loopback 设备和 smoltcp Interface，SocketSet 管理活跃套接字。TCP 支持 connect（含非阻塞 EINPROGRESS）、accept（套接字替换机制）、Nagle 算法禁用、Keep-Alive 和 Shutdown。Unix Socket 利用双向管道实现全双工。地址族抽象支持 IPv4/v6 和 AF_UNIX。

**优点**：
- Socket API 实现较完整，支持主流传输协议和选项控制。
- Unix Domain Socket 设计巧妙，复用管道机制。
- 非阻塞和异步 I/O 事件可通过 poll/select 集成。

**缺点**：
- 无真实物理/虚拟网卡驱动，所有网络通信限于本地回环。
- 缺乏 IP 路由表、ARP 解析、IP 分片等网络层功能。
- TCP 流量控制和拥塞控制完全依赖 smoltcp 默认实现，无调优参数导出。
- 无原始套接字（SOCK_RAW）支持。

### 4.10 跨架构支持

**实现细节**：HAL 层通过条件编译和内部 trait 将 RISC-V 与 LoongArch 差异封装。RISC-V 端包含 Sv39 页表、S-mode 陷阱、SBI 调用、SMP 启动；LoongArch 端包含 LA-Flex 页表（含软件 TLB 重填和 dirty 位模拟）、多级异常处理、DMW 地址窗口、ACPI 支持等。上下文切换汇编为各架构单独编写但接口一致。

**优点**：
- 两套架构差异巨大，HAL 层成功屏蔽底层细节，上层内核代码几乎无差异。
- LoongArch 部分实现细节丰富，包含人工 dirty 位维护和 TLB 重填软件例程。
- 平台配置文件支持多种开发板，便于移植。

**缺点**：
- SMP 支持在 LoongArch 部分处于未完成状态，多核启动代码未集成。
- 部分时间、TLB 刷新路径可能未充分优化，存在冗余操作。
- 编译器 bug 规避代码表明工具链成熟度不足，长期维护需关注。

### 4.11 驱动与设备管理

**实现细节**：BlockDevice trait 提供统一接口，支持 VirtIO MMIO/PCI、SATA AHCI 和内存模拟三种后端，通过 feature flag 切换。串口驱动为 NS16550A 标准 UART。无总线框架，设备硬编码初始化。

**优点**：
- 块设备抽象层使得文件系统可运行于多种后端。
- 提供内存模拟块设备模式，便于无持久存储时调试。

**缺点**：
- 无设备树或 ACPI 驱动匹配机制，设备均硬编码，移植新平台需要手动修改。
- 缺少常见设备驱动（如 VirtIO GPU、输入、RNG），用户体验有限。
- 中断管理未抽象，驱动直接绑定特定 IRQ。

## 五、OS 内核整体实现完整度

以类 Unix 单体内核标准参照，GCore 在内核核心路径上的实现完整度约为 **75%**。这一评估基于：内存管理、进程管理、文件系统等关键子系统均已达到可支撑复杂应用程序运行的程度，约 139 个系统调用已实现；但部分子系统仍存在明显缺口（网络仅限回环、调度过于简单、驱动种类稀少），部分系统调用为存根（返回 ENOSYS），多核支持不完整。

## 六、动态测试的设计和结果

本次技术评估**未进行实际动态测试**。原因如下：

- 项目依赖特定版本的 Rust nightly 工具链（`nightly-2025-01-18` for RISC-V, `nightly-2024-05-01` for LoongArch），当前环境不具备这些精确版本。
- 需要预编译的 SBI 固件、根文件系统镜像等二进制资源，当前环境中不可用。
- 构建需要精确的板级配置和块设备模式选择，在当前环境中无法完整复现。

本报告所有分析均基于静态源码审查，不包含运行时行为验证。

根据项目文档及代码结构推断，该项目预期可在 RISC-V 64 QEMU virt 平台通过 `make run` 启动并进入 shell（bash），运行 busybox 等工具。但该推断未经本次评估证实。

## 七、细则评价表格

### 内存管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 物理页分配 | 已实现，较完整 | 伙伴系统 + FrameTracker RAII | 设计可靠，但无反碎片化 |
| 虚拟地址空间管理 | 已实现，较完整 | MemorySet/MapArea 结构清晰 | 支持多种映射类型，可扩展 |
| 缺页处理 | 已实现，较完整 | CoW、懒分配、Swap-in/Zram 统一处理 | 健壮性较好，内置 OOM 预留帧防止递归 |
| mmap/munmap/mprotect | 已实现，中等完整 | 支持匿名和文件映射 | 缺 MAP_GROWSDOWN 等高级标志 |
| mlock 系列 | 已实现，基本完整 | 接口存在，具体物理锁定逻辑待核实 | 大致可用 |
| 页面回收 | 已实现，中等完整 | Zram + Swap + OOM Handler 三级 | 策略简单，缺少 LRU 老化 |

### 进程管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 进程/线程生命周期 | 已实现，较完整 | fork/clone/execve/exit/wait 体系完整 | 线程组和 TLS 支持好 |
| 调度器 | 已实现，基础 | FIFO 队列，无可抢占无优先级 | 过于简单，无法保证交互性 |
| PID 分配 | 已实现，完整 | 支持回收重用 | 正确 |
| 进程组/会话 | 已实现，部分 | getpgid/setpgid/setsid 存在，作业控制可能不全 | 基本可用 |
| 资源使用统计 | 已实现，中等完整 | rusage 提供 utime/stime 等 | 可用，缺少更多细粒度统计 |

### 文件系统

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| VFS 框架 | 已实现，较完整 | File trait + DirectoryTreeNode 灵活 | 设计可扩展，支持多种文件类型 |
| ext4 支持 | 已实现，深入 | 完整 extent 树、CRC32c 校验 | 技术含量高，核心算法正确 |
| FAT32 支持 | 已实现，较完整 | BPB 解析、VFAT 长文件名 | 含平台特定 bug 规避，工程化较好 |
| 页面缓存 | 已实现，较完整 | PageCache + BufferCache 两级 | 与 mmap 集成良好 |
| 设备文件 | 已实现，较完整 | null/zero/tty/urandom 等 | 满足基本需求 |
| 管道 | 已实现，较完整 | 环形缓冲区，阻塞同步 | 可靠 |
| 文件锁 | 已实现，基本 | flock 系统调用 | 简单可用 |

### 交互设计

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 控制台/串口 | 已实现，基本 | NS16550A 驱动，tty 设备文件 | 可用但无行编辑/回显处理 |
| Shell | 通过 busybox/bash 提供 | 外部用户态程序 | 依赖用户态 |
| 系统日志 | 已实现，基本 | syslog 调用 | 功能较弱 |

### 同步原语

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| Futex | 已实现，中等完整 | WAIT/WAKE/REQUEUE/WAKE_OP | 可支持常见锁，缺 PI futex |
| Robust List | 已实现，较完整 | 进程退出时清理 | 增强健壮性 |
| 管道同步 | 已实现，完整 | 环形缓冲区，正确阻塞/唤醒 | 可靠 |
| SysV IPC | 未实现 | 无信号量、消息队列、共享内存 | 缺失重要 IPC 手段 |

### 资源管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 引用计数管理 | 已实现，完整 | Arc 贯穿整个内核 | 内存安全，无显式释放错误 |
| 进程退出清理 | 已实现，较完整 | 地址空间、fd、信号等均清理 | 较彻底 |
| 全局限额 | 未实现 | 无 cgroup/rlimit 强制限制 | 易导致资源耗尽 |
| OOM 处理 | 已实现，基本 | 主动回收页面 | 提供最后的保护，但策略粗糙 |

### 时间管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 基本时钟 | 已实现，较完整 | clock_gettime、nanosleep | 可用 |
| 定时器 | 已实现，中等完整 | itimerval、timerfd | 可满足基本需求 |
| 高精度定时器 | 未实现 | 无 hrtimer | 实时性受限 |
| 时间同步 | 未实现 | 无 NTP 等 | 长时间漂移 |

### 系统信息

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| uname | 已实现 | 返回基本系统信息 | 可用 |
| sysinfo | 已实现 | 内存、交换区等统计 | 可用 |
| 伪文件系统 | 未实现 | 无 procfs/sysfs | 系统观测手段不足 |

### 驱动与设备

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 块设备驱动 | 已实现，多样 | VirtIO/SATA/内存块设备 | 覆盖面较好 |
| 串口驱动 | 已实现 | NS16550A | 基础控制台可用 |
| 总线框架 | 未实现 | 无统一设备模型 | 移植需手动修改 |
| 其他设备 | 未实现 | 无 GPU、输入、网络等 | 用户态交互受限 |

### 网络栈

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| TCP/IP 协议栈 | 已实现，基础 | 通过 smoltcp + Loopback | 可本地通信，无外部网络能力 |
| Socket API | 已实现，较完整 | TCP/UDP/ICMP/Unix | API 覆盖较全 |
| 真实网卡驱动 | 未实现 | 无 | 阻碍实际网络应用 |

### 信号处理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| 信号发送与递送 | 已实现，较完整 | 64 信号，sigaction 支持 | 流程正确，但递送延迟可能较大 |
| 信号处理函数 | 已实现，较完整 | trampoline + sigaltstack | 安全可靠 |
| 实时信号排队 | 部分实现 | 携带值可能丢失 | 不完全符合 POSIX |

### 跨架构支持

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|--------------|--------|------|
| RISC-V 64 支持 | 已实现，较完整 | Sv39、S-mode 陷阱、SBI | 稳定 |
| LoongArch 64 支持 | 已实现，较深入 | LA-Flex 页表、软 TLB 重填 | 底层细节丰富，但多核未完成 |
| 多平台 | 已实现，部分 | QEMU、FU740、K210、2K1000 | 框架存在，部分平台可能未测试 |

## 八、总结评价

GCore 是一个用 Rust 实现的、双架构支持、功能覆盖广泛的单体内核。项目在文件系统（尤其是 ext4 extent 树的深度实现）和内存管理（Zram + Swap + OOM 三级回收体系）方面表现出超越一般竞赛水平的技术深度，同时具备较好的工程化实践（模块化设计、RAII 资源管理、条件编译 HAL 层）。

主要亮点：
- 完整且具备深度的 ext4 文件系统实现，extent 树算法体现对 Linux 内核的深入理解。
- 多层次内存回收机制（压缩、交换、OOM）有机结合。
- 双架构抽象层设计合理，成功统一 RISC-V 和 LoongArch 底层差异。
- 系统调用覆盖较广，支持运行 busybox、lua 等复杂用户态程序。
- 工程健壮性强，多处体现真实硬件调试痕迹（如 LoongArch 非对齐访问规避）。

主要不足：
- 网络仅限本地回环，无法与外界通信。
- 调度器过于简单，缺乏多核支持和实时特性。
- 没有完整的设备驱动框架和伪文件系统。
- 部分高级特性（PI futex、大页、cgroup、POSIX IPC）缺失。

综合来看，GCore 在核心子系统的实现深度与功能广度之间取得了较好的平衡，在竞赛/教学类内核中属于完成度及技术含量均处于前列的作品。若能在网络能力、调度器改进和多核支持方面持续完善，其实际应用潜力将大幅提升。

（报告完）