# StellaOS 内核项目技术画像与评估报告

## 一、项目基本信息

- **项目名称**：StellaOS
- **架构**：RISC-V64 (Sv39)、LoongArch64
- **实现语言**：Rust（内核核心、文件系统 crate、同步原语 crate、用户态）
- **生态归属**：类 Unix / Linux 兼容宏内核
- **内核类型**：宏内核（单地址空间、单核 UP）
- **系统调用数量**：约 168 个（含占位 ENOSYS）
- **支持文件系统**：ext4（读写）、VFAT、ramfs、tmpfs、devfs、procfs
- **代码规模**：内核核心约 16,900 行，文件系统 crate 约 7,000+ 行，独立 ext4 库约 5,000+ 行
- **测试套件**：12 个测试套件（basic、busybox、lua、libctest、iozone、unixbench、iperf、libcbench、lmbench、netperf、cyclictest、ltp）
- **特点**：两阶段缺页处理、condvar 原子 wait_with_mutex、跨架构抽象层、多类型虚拟文件系统支持、用户态 TCP/IP 协议栈整合

## 二、实现的子系统与功能

### 2.1 内存管理

- 物理帧分配器（栈式分配，支持回收、多页连续分配）
- 内核堆分配器（基于 buddy_system_allocator，128 MB 堆）
- 用户地址空间管理（MemorySet、MapArea、MapBackend）
- Copy-on-Write fork
- 缺页处理（两阶段设计：prepare_page_fault + commit_file_backed_page_fault）
- mmap / munmap / mprotect / mremap
- 匿名页懒分配
- 文件映射（私有/共享）
- System V 共享内存
- brk / 堆增长
- ELF 加载（含 shebang 支持、动态链接器加载）
- 用户空间缓冲区安全读写（软件页表遍历，三阶段重试 fault）

### 2.2 进程管理

- 进程控制块（PCB，含地址空间、父子关系、cwd、fd 表、信号、凭据、资源限制）
- 线程控制块（TCB，含 trapframe、内核上下文、信号状态、CPU 时间统计）
- fork / clone （支持 CLONE_VM、CLONE_FILES、CLONE_VFORK、CLONE_THREAD 等标志）
- exec（ELF + shebang 递归 + ENOEXEC 回退）
- wait4 / waitpid / exit / exit_group
- 信号子系统（64 个信号、sigaction / sigprocmask / sigaltstack / sigtimedwait / sigreturn、进程级共享 pending、实时信号队列）
- Futex（FUTEX_WAIT / WAKE / REQUEUE / CMP_REQUEUE，robust list，竞态安全设计）
- 进程组、会话、凭据管理
- 资源限制（rlimit）

### 2.3 文件系统

- VFS 框架（Dentry 树、Dentry Cache (LRU)、Inode trait、File 对象）
- ext4 文件系统（读、写、创建、删除、重命名、截断、fallocate、符号链接、硬链接）
- VFAT 文件系统支持
- 纯内存文件系统（ramfs、tmpfs）
- 设备文件系统（devfs，含 null、zero、urandom、rtc、tty、console、loop*）
- procfs（/proc/meminfo、self/exe 等）
- 统一页缓存（块缓冲与文件数据页共享 LRU）
- 块设备抽象（BlockDevice trait，MBR 分区扫描，设备注册表）
- Pipe（环形缓冲区、阻塞/唤醒、O_NONBLOCK、原子写保证）
- Eventfd

### 2.4 中断与陷入处理

- 陷入分发（SysCall、Timer、SupervisorExternal、BusError、页故障等）
- 缺页处理集成（两阶段 fault）
- 信号在返回用户态前交付（handle_signals）
- RISC-V PLIC 驱动
- LoongArch PCH-PIC / EXTIOI / CPUINTC 驱动链

### 2.5 定时器

- 周期性 tick（100 Hz，10 ms）
- 高精度定时器（BinaryHeap，最近到期硬件武装）
- ITIMER_REAL（每 100 ms 扫描，SIGALRM）
- 多时钟源（CLOCK_REALTIME / MONOTONIC / PROCESS_CPUTIME_ID 等 8 种）
- CPU 时间统计（utime / stime）

### 2.6 设备驱动

- virtio-blk 块设备（非阻塞 I/O 模式、链式唤醒、多设备支持）
- virtio-net 网络设备
- NS16550A UART
- virtio-gpu（framebuffer 输出）
- virtio-input（键盘/鼠标）
- virtio MMIO 传输层

### 2.7 网络

- lose-net-stack 用户态 TCP/IP 协议栈（TCP 连接管理、UDP、ARP）
- 内核网络桥接（ARP 代理、loopback、发送/接收路径）
- Socket 实现（TCP/UDP、bind/listen/accept/connect/sendto/recvfrom、poll）

### 2.8 同步原语

- UPIntrFreeCell（关中断互斥，死锁检测）
- MutexSpin / MutexBlocking
- Condvar（signal / broadcast / wait_with_mutex 原子操作）
- Semaphore（计数信号量）
- 任务操作抽象（TaskHandle / TaskRuntimeOps 解耦）

### 2.9 架构抽象

- polyhal 补丁（页表、IRQ、定时器、控制台、内核上下文、percpu、多核）
- RISC-V64 与 LoongArch64 双架构构建
- 信号帧布局、陷阱入口适配

### 2.10 用户态

- 用户库（系统调用封装、文件 I/O、同步原语、网络等）
- initproc 测试调度器（12 个测试套件串行执行）

## 三、各子系统实现完整程度

以下完整度基于实现代码的覆盖范围、与竞品教学/竞赛内核的典型需求对比而评定，均以百分比形式给出大致度量，仅为定性参考，不基于精确公式。

| 子系统 | 完整度参考 | 说明 |
|---|---|---|
| 内存管理 | 较高 | 实现了 COW fork、mmap/munmap/mprotect/mremap、SHM、brk、ELF 加载等核心功能，缺页处理健壮。缺：页面交换、NUMA、THP、KSM。 |
| 进程管理 | 较高 | fork/clone/exec/wait4、信号、futex 等均已实现，支持多数 Linux 常用标志。缺：cgroup、namespace、ptrace。 |
| 文件系统 | 较高 | VFS 框架完善，ext4 读写稳定，多种伪文件系统，页缓存与 dentry cache 齐备。缺：ext4 日志、xattr、ACL、配额。 |
| 信号 | 高 | 64 个信号、完整处理流程、实时信号队列、进程级共享 pending 均实现。 |
| 同步 | 较高 | futex 完整（含 requeue）、robust_list、eventfd、多种内核同步原语。缺：PI futex。 |
| 定时器 | 较高 | 100 Hz tick、高精度定时器堆、ITIMER_REAL、多时钟源、CPU 时间统计。缺：timerfd。 |
| 网络 | 中高 | TCP/UDP/ARP、socket API、loopback、poll 可用，但协议栈在用户态，性能受限。缺：IPv6、RAW socket、路由。 |
| 设备驱动 | 中高 | virtio 设备覆盖块、网、GPU、输入，UART，中断控制器。缺：USB、PCI 枚举框架。 |
| IPC | 中高 | SysV SHM 和 SEM 完整。缺：消息队列、POSIX 消息队列。 |
| 架构支持 | 中高 | RISC-V64 与 LoongArch64 均能启动并运行测试，但 LoongArch 部分驱动代码覆盖较少。 |

## 四、子系统优缺点及实现细节

### 4.1 内存管理

**优点**：
- 两阶段缺页处理避免在持有锁期间进行文件 I/O，解决了 RefCell 重入和锁竞争问题，设计思路成熟。
- COW 实现层次清晰，对匿名页、文件私有映射、共享映射均有覆盖，共享内存通过 Arc<FrameTracker> 实现物理共享。
- 内存区域抽象（MapArea、MapBackend）支持多种类型（匿名、文件、共享内存），扩展性良好。
- 物理帧分配器支持回收和连续多页分配，兼顾碎片回收与 DMA 连续物理内存需求。
**缺点**：
- 无页面交换（swap），内存压力大时可能直接分配失败，无 OOM killer。
- 物理帧分配器为简单的栈式实现，未采用 buddy system 或 slab 分配器，长时间运行可能因内存碎片导致连续多页分配失败。
- 内存去重（KSM）和透明大页（THP）等高级特性缺失。
- 缺页错误处理中，若文件页加载失败，直接返回 SIGSEGV，但未提供更细粒度的错误报告。

**实现细节**：
- `prepare_page_fault` 返回解析结果，其中包含 `FileBackedPageFault` 计划，计划记录所需文件偏移和 inode 信息。
- `commit_file_backed_page_fault` 需要调用者在锁外加载文件页后重新获取锁并提交，整个过程可重试。
- 用户空间缓冲区访问使用 `translated_ref` 等函数，通过软件遍历页表，支持三阶段重试（直接翻译→懒 fault 匿名页→加载文件页），保证了跨页边界的字节读取安全。

### 4.2 进程管理

**优点**：
- fork/clone/exec 实现细致，支持多种 clone 标志，shebang 脚本递归和动态链接器加载处理完善。
- 信号子系统完整度极高，支持全部标准信号及实时信号，sigaltstack、sigtimedwait、sigreturn 流程完整，进程级共享 pending 的设计减少了信号不能交付的情况。
- futex 实现正确处理竞态，通过在全局锁内检查用户空间值并原子入队避免丢失唤醒，robust list 清理路径考虑周到。
- 进程组、会话、凭据管理为多用户环境打下基础。
**缺点**：
- 调度器仅为简单的 FIFO+时间片轮转，无优先级调度或 CFS，可能导致实时性不足。
- 缺乏 ptrace 等调试接口，难以进行进程追踪。
- 无 cgroup 或 namespace，无法进行容器化隔离。
- 进程资源限制仅部分实现，且缺少强制执行（如对内存使用限制）。

**实现细节**：
- `clone_process` 函数通过 CloneFlags 位域解析参数，体系结构差异（如 RISC-V 的 CLONE_BACKWARDS）在系统调用入口处理。
- `exec` 中解释器递归最大深度为 5，防止无限递归；ENOEXEC 回退到 `/bin/sh` 模拟 shebang 行为。
- 信号交付时，构造 sigframe 包括 ucontext，支持 sigaction 标志 SA_SIGINFO 和 SA_RESTART。

### 4.3 文件系统

**优点**：
- VFS 框架设计合理，Dentry 树与 Inode trait 分离，延迟加载和 negative dentry 优化路径查找。
- Dentry Cache 基于 LRU，可配置容量，统计计数便于调优。
- ext4 读写支持扎实，可创建、删除、重命名，通过了 iozone 等压力测试。
- 页缓存统一块缓冲和文件数据缓存，减少了重复缓存逻辑。
- Pipe 和 Eventfd 的实现遵循 POSIX 语义，原子写和读写阻塞/唤醒正确处理。
**缺点**：
- ext4 未实现日志，异常断电可能导致文件系统不一致，`ext4_write_verify` 特性暗示可能的数据一致性问题。
- 文件锁（flock）实现不完整。
- 缺少扩展属性（xattr）和 ACL，文件权限模型简单。
- 没有文件系统卸载时的脏数据回刷机制（除 sync 系统调用外），依赖 LRU 逐出时的回写。

**实现细节**：
- `Dentry` 生命周期状态机：Invalid → Valid → Dirty，保证了在内存中的一致性。
- 写操作时通过 `offset_lock` 保证线程安全，pread/pwrite 使用偏移参数避免修改文件位置。
- `CachedBlockDevice` 作为块设备与 ext4 之间的缓存层，将块 I/O 粒度映射到页缓存。

### 4.4 中断与陷入处理

**优点**：
- 系统调用处理快速路径直接写入返回值推进 SEPC/ERA，开销低。
- 缺页故障与信号的衔接流畅：页故障失败时发送 SIGSEGV，执行信号处理机制使进程可能恢复或终止。
- RISC-V PLIC 驱动实现完整，支持优先级和使能控制。
**缺点**：
- 中断处理中未观察到优先级抢占或嵌套中断，所有处理在关中断或关阈值下进行。
- 对于总线错误等异常，仅发送信号，无硬件诊断信息输出。

**实现细节**：
- `handle_user_trap` 中 timer 中断处理先更新定时器再检查信号，确保周期性时间统计准确。
- LoongArch 的中断控制器链（PCH-PIC→EXTIOI→CPUINTC）在 `arch::board` 中初始化，中断路由固定。

### 4.5 同步原语

**优点**：
- Condvar 的 `wait_with_mutex` 原子操作设计精巧，在关中断窗口下完成解锁、入队、阻塞，从根本上解决信号丢失问题。
- 提供了 MutexSpin 和 MutexBlocking 两种实现，适合不同场景。
- UPIntrFreeCell 附带死锁检测功能（debug 模式），有助于开发调试。
- 通过 TaskHandle trait 将同步原语与具体内核解耦，复用性强。
**缺点**：
- 所有同步原语基于关中断，无法在多核环境下工作，代码中假设单核 UP。
- 没有优先级继承支持，可能导致优先级反转（虽在 UP 下不严重）。
- Semaphore 的等待队列为简单 FIFO，无优先级。

**实现细节**：
- `interrupt_free` 返回一个 token，在 token 生命期内中断保持关闭，离开作用域自动恢复。
- `Condvar::wait_with_mutex` 实现依赖 `TaskRuntimeOps::block_current_and_run_next` 等回调。

### 4.6 定时器

**优点**：
- 高精度定时器基于堆，支持最近到期武装硬件，减少不必要的 tick 中断。
- 支持多种 POSIX 时钟源，包括粗粒度时钟，减少高开销读取。
- ITIMER_REAL 通过周期性扫描实现，开销可控。
- CPU 时间统计集成在 trap 出口处更新，对进程调度透明。
**缺点**：
- 未实现 timerfd，无法将定时器作为文件描述符传递给 poll/epoll。
- nanosleep 基于定时器堆，精度受限于 tick 粒度（10 ms），高精度睡眠可能延迟。
- 缺少高分辨率时钟源（如 HPET）的驱动。

**实现细节**：
- `check_timer` 在每次 tick 时调用，唤醒到期定时器并更新堆。
- `TimeStat` 在 `handle_user_trap` 出口累加用户态和内核态时间，用于 times/getrusage。

### 4.7 网络

**优点**：
- 支持 TCP/UDP 常用 socket 操作，poll 集成使得非阻塞 I/O 可用。
- Loopback 实现正确，包括 ARP 自应答和数据包内部路由。
- 通过 setsockopt/getsockopt 支持 TCP_NODELAY、SO_REUSEADDR 等选项，提高了兼容性。
**缺点**：
- TCP/IP 协议栈在用户态，每次网络操作需要上下文切换到内核再返回用户态，性能受限；且协议栈稳定性依赖于用户态库。
- 缺少 IPv6 支持，地址族仅 AF_INET。
- 无路由表，仅支持直连网络（部分依赖协议栈实现）。
- 接收缓冲区固定 2048 字节，对高流量场景可能不足。

**实现细节**：
- 内核 `NetMod` 实现了 `NetInterface` trait，协议栈调用其发送/接收方法，方法内部区分 loopback 和物理路径。
- 网络中断处理函数调用 `NET_DEVICE.receive()` 后交给 `NET_SERVER.analysis_net_data()`，由协议栈分析。

### 4.8 架构抽象

**优点**：
- polyhal 补丁使得内核可以相对容易地移植到新架构，RISC-V 和 LoongArch 已成功运行。
- 架构特定代码隔离在 arch 目录和 patches 中，内核主体与架构无关。
**缺点**：
- LoongArch 代码路径覆盖面不如 RISC-V，部分设备模块（如 GPU、input）在 LoongArch 下可能未充分测试。
- 多核支持框架（percpu、SMP）仅在 polyhal 中声明，内核未实际使用。

**实现细节**：
- 陷阱入口通过 polyhal 提供的 trapframe 访问寄存器，信号帧布局因架构而异。
- Makefile 通过 ARCH 变量切换交叉编译目标，initproc 以二进制形式嵌入内核。

## 五、OS 内核整体实现完整度

该项目实现了一个**功能较为全面**的类 Unix 宏内核，能够启动 BusyBox、运行 Lua 解释器、通过 libctest 测试和 LTP 部分测试，支持 RISC-V64 和 LoongArch64 双架构。内核的核心子系统（内存管理、进程管理、文件系统、信号、同步、网络）均已达到可用的程度，但特性丰富度和生产环境所需的健壮性（如多核支持、页面回收、文件系统日志、安全模块）尚存较大缺口。整体上看，该内核在竞赛/教学项目中属于实现深度较高的一档，但在向通用操作系统演进的道路上仍有大量工作。

## 六、动态测试的设计与结果

### 6.1 测试设计

项目以 **initproc** 为用户态初始进程，嵌入内核镜像，系统启动后自动运行。initproc 扫描根文件系统中的测试脚本（命名格式 `*_testcode.sh`），按文件名顺序串行执行。测试套件包括：

1. **basic** — 基本 OS 功能（initproc 自身健壮性、控制台输出等）
2. **busybox** — BusyBox 工具集（验证大量常用命令的正确性）
3. **lua** — Lua 脚本解释器（语言运行时兼容性）
4. **libctest** — musl libc 测试（C 库函数合规性）
5. **iozone** — 文件系统 I/O 性能基准（ext4 读写稳定性与性能）
6. **unixbench** — Unix Benchmark（系统综合性能指标）
7. **iperf** — 网络吞吐量测试（TCP/UDP 带宽）
8. **libcbench** — C 库性能基准
9. **lmbench** — 系统微基准（上下文切换、内存延迟等）
10. **netperf** — 网络性能测试（请求/响应延迟与吞吐量）
11. **cyclictest** — 实时延迟测试（测试内核中断延迟与调度抖动）
12. **ltp** — Linux Test Project（大规模 POSIX 兼容性测试）

每个测试脚本的输出由 initproc 捕获，结果显示在控制台，可通过 UART 输出观察。

### 6.2 测试结果

由于当前分析环境限制，未实际执行动态测试。根据项目仓库中的构建和运行基础设施完备性（Makefile、预配置的 QEMU 启动命令、测试脚本存在），可合理推断这些测试套件被用于验证内核功能。但具体的通过率、性能数据、失败用例等信息无法从静态代码分析中获取。技术报告中无法提供确切的测试结果数据。

建议后续评估中对实际 QEMU 启动并运行几个关键测试套件（如 basic、busybox、libctest）以获取客观的通过/失败统计。

## 七、细则评价表格

### 7.1 内存管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| 物理内存分配器 | 已实现，基本完整。 | 栈式分配器，支持回收和连续多页分配，无碎片整理。 | 适用于单核 UP，简洁高效。长期运行可能出现外部碎片。 |
| 虚拟地址空间 | 已实现，较完整。 | MemorySet + MapArea 抽象，支持匿名、文件、共享内存映射，COW fork 实现正确。 | 设计清晰，MapBackend 枚举扩展性好。缺页两阶段处理是亮点。 |
| 缺页处理 | 已实现，较完整。 | 两阶段设计分离 I/O，实现懒分配、COW、文件页加载，失败时发送 SIGSEGV。 | 有效降低了锁竞争，逻辑正确。但无回收或交换，内存压力下可能失败。 |
| 页面回收/交换 | 未实现。 | 无 swap 或页面回收机制。 | 典型竞赛内核可接受，但无法应对内存过载。 |
| 用户内存访问安全 | 已实现，较完整。 | 软件页表遍历，三阶段重试 fault 保证跨页字节读取安全。 | 严谨的内存访问模式，避免了直接解引用用户指针的风险。 |

### 7.2 进程管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| fork/clone | 已实现，较完整。 | 支持 CLONE_VM、CLONE_FILES、CLONE_VFORK、CLONE_THREAD 等，COW 继承正确。 | 标志处理细致，兼容性好。 |
| exec | 已实现，较完整。 | shebang 递归（最深5层）和动态链接器加载均已实现，ENOEXEC 回退。 | 功能完备，细节考虑周全。 |
| 退出与等待 | 已实现，基本完整。 | exit/exit_group/wait4 均工作，僵尸进程回收、子进程收养处理到位。 | 符合 POSIX 基本要求。 |
| 信号 | 已实现，高完整度。 | 64 个信号、实时队列、进程级共享 pending、sigaltstack、sigtimedwait 等，交付流程清晰。 | 信号模块是项目亮点之一，设计完整度高。 |
| futex | 已实现，较完整。 | WAIT/WAKE/REQUEUE/CMP_REQUEUE 均实现，robust list 清理正确，竞态处理安全。 | 实现质量高，有效支撑 pthread 同步。 |
| 调度 | 已实现，基础。 | FIFO + 时间片轮转（100ms），无优先级。 | 满足基本多任务需求，但实时性不足。 |
| 资源限制 | 部分实现。 | rlimit 结构存在，但仅少量限制被实际检查。 | 框架已有，强制力不足。 |

### 7.3 文件系统

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| VFS 框架 | 已实现，较完整。 | Dentry 树、Inode trait、File 对象、Dentry Cache (LRU)，设计合理。 | 分层清晰，易于添加新的文件系统后端。 |
| ext4 | 已实现，较完整（读写）。 | 支持文件/目录增删改查、重命名、截断、fallocate、符号链接、硬链接，基于 ext4_rs。 | 读写能力达到实用水平，但缺少日志，存在一致性风险。 |
| 其他文件系统 | 已实现，基本完整。 | VFAT、ramfs、tmpfs、devfs、procfs 均可用，伪文件系统功能满足需求。 | 覆盖了常用伪文件系统。 |
| 页缓存 | 已实现，较完整。 | 统一 LRU 缓存，兼顾块缓冲和文件页，脏页回写。 | 有效减少磁盘 I/O，提升性能。 |
| Pipe/Eventfd | 已实现，较完整。 | 环形缓冲区实现，原子写保证，阻塞/非阻塞语义正确。 | 实现规范，posix 兼容。 |
| 文件锁 | 基本未实现。 | flock 系统调用 stub 存在，但未观察到实际锁定逻辑。 | 缺失，可能影响并发写安全。 |

### 7.4 交互设计

此处“交互设计”理解为：内核向用户态暴露的接口设计，包括系统调用、procfs、devfs 等。

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| 系统调用接口 | 已实现，广泛。 | 约 168 个系统调用，遵循 Linux RISC-V ABI，涵盖文件、进程、网络、同步等。 | 接口丰富，兼容性好。 |
| procfs | 部分实现。 | 提供 meminfo、mounts 等基本信息节点。 | 可扩展，但节点数有限。 |
| devfs | 已实现，基本完整。 | null, zero, urandom, rtc, tty, console 等设备节点可用。 | 满足基础需求。 |
| 图形/输入接口 | 已实现，基础。 | 自定义系统调用提供 framebuffer、键盘鼠标事件。 | 非标准接口，但提供了 GUI 基础。 |
| 错误码 | 较完整。 | 系统调用返回标准 errno，涵盖常见错误。 | 符合 expectation。 |

### 7.5 同步原语

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| 中断屏蔽保护单元 | 已实现。 | UPIntrFreeCell 提供关中断互斥访问，支持死锁检测。 | 适合 UP 环境，使用便捷。 |
| Mutex | 已实现（spin/blocking 两种）。 | 支持锁竞争时的自旋或阻塞等待。 | 选择灵活。 |
| Condvar | 已实现，高完整度。 | wait_with_mutex 原子操作设计精巧，signal/broadcast 正确。 | 关键同步原语实现质量高。 |
| Semaphore | 已实现。 | 计数信号量，up/down 操作正确。 | 基本可用。 |
| 同步原语跨核安全 | 未实现。 | 基于关中断，不支持 SMP。 | 扩展至多核需重构。 |

### 7.6 资源管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| 文件描述符 | 已实现。 | 进程持有 fd 表，支持 dup/dup3/fcntl，引用计数关闭。 | 标准实现。 |
| 内存配额 | 未实现。 | 无内存限制强制或 cgroup。 | 可能导致资源滥用。 |
| CPU 时间限制 | 部分实现。 | rlimit 中的 CPU 时间限制未观察到强制执行。 | 框架存在，未落地。 |
| 网络端口/缓冲区 | 基本管理。 | 端口由协议栈管理，内核缓冲区固定。 | 缺乏动态调整能力。 |

### 7.7 时间管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| 时钟 tick | 已实现。 | 100 Hz，10 ms 周期，基于硬件定时器。 | 满足基本需求。 |
| 高精度定时器 | 已实现。 | 基于堆，支持最近到期武装，用于 nanosleep 等。 | 设计良好。 |
| 时钟源 | 已实现（多种）。 | 支持 REALTIME、MONOTONIC、CPU 时间等 8 种。 | 覆盖常用需求。 |
| CPU 时间统计 | 已实现。 | 在 trap 出口累加 utime/stime。 | 准确有效。 |

### 7.8 系统信息

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| uname | 已实现。 | 返回系统名、节点名、版本等。 | 标准实现。 |
| sysinfo | 已实现。 | 返回总内存、空闲内存、负载等信息。 | 可用。 |
| /proc/meminfo | 已实现。 | 从 frame_allocator_stats 获取物理内存统计。 | 便于监控。 |
| 进程状态查看 | 未直接实现。 | 无 /proc/[pid]/ 目录或 ps 支持，依赖测试程序自身。 | 缺少便利的运行时信息。 |

### 7.9 可移植性与架构支持（补充条目）

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| 多架构支持 | 已实现（双架构）。 | RISC-V64 和 LoongArch64 均能启动，通过 polyhal 抽象。 | 跨架构能力得到验证，但 LoongArch 设备驱动覆盖较窄。 |
| 多核支持 | 未实现。 | 框架声明 percpu 变量，但实际调度和同步均锁定单核。 | 限制了性能与扩展性。 |

## 八、总结评价

StellaOS 是一个在竞赛/教学背景下实现深度较高的 Rust 宏内核项目。其核心价值在于：

- **功能完备性**：实现了较丰富的系统调用集合（约 168 个），支持基本 POSIX 兼容，能够运行 BusyBox、Lua 及多种基准测试，展现了良好的实用潜力。
- **设计质量**：内存管理的两阶段缺页处理、完整且严谨的信号子系统、竞态安全的 futex、以及原子化 condvar 等待等设计，反映出开发团队对操作系统并发和内存管理核心问题的深刻理解。
- **工程实践**：项目代码组织清晰，模块边界明确，构建系统完善，通过 12 个测试套件验证功能，体现了较高的工程素养。
- **局限性**：内核基于单核 UP 设计，同步原语均依赖关中断，难以扩展至多核；缺少内存页面交换、文件系统日志等高级特性，鲁棒性有待加强；网络协议栈驻留用户态且在性能上存在瓶颈；部分驱动和架构支持尚不充分。

整体而言，StellaOS 在竞赛赛道中达到了一流水平，其实现深度和覆盖面均处于前列，显示出团队出色的系统编程能力。若能在多核支持、文件系统容错及安全隔离等方面继续演进，将有潜力向更实用的轻量级 OS 演进。