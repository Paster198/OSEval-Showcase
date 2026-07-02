# Ferriswheel OS 内核项目技术画像与评估报告

## 一、项目基本信息

| 条目 | 内容 |
|------|------|
| 项目名称 | Ferriswheel OS |
| 目标架构 | RISC-V 64-bit (RV64, SV39)、LoongArch 64-bit |
| 实现语言 | Rust（内核主体）、C（lwext4 外部库） |
| 内核类型 | 类微内核向宏内核过渡（所有组件同地址空间运行） |
| 生态归属 | 类 Linux 兼容、操作系统竞赛/教学内核 |
| 特权级模型 | RISC-V: M/S/U 三级（OpenSBI/RustSBI + Supervisor + User）；LoongArch: Firmware + Kernel + User |
| 动态链接支持 | musl libc、glibc 双支持 |
| 代码规模 | 约 51000 行（Rust 内核约 18000 行、lwext4 C 库约 20707 行、用户态程序约 4000 行、ext4 Rust 封装约 3933 行） |
| 源文件数 | 约 210 个（RISC-V 内核 38 个、LoongArch 内核 44 个、lwext4 C 64 个、ext4 Rust 封装 4 个、用户态约 60 个） |
| 核心特点 | 双架构实现、lwext4 C 库深度集成、类 POSIX 进程模型、较完整的 Linux ABI 兼容层、面向标准测试套件（busybox/LTP/iozone）的务实设计 |

## 二、子系统与功能实现清单

| 子系统 | 核心功能 | 实现状态 |
|--------|----------|----------|
| 内存管理 | 页帧分配（栈式回收）、堆分配（伙伴系统）、SV39 三级页表、地址空间管理（MapArea/MemorySet）、mmap/munmap/brk/mprotect、共享内存（MAP_SHARED）、fork 时地址空间复制 | 已实现 |
| 进程管理 | PCB/TCB 两级模型、fork（含 CLONE 标志）、exec（含动态链接 ELF 加载）、waitpid、exit/exit_group、孤儿进程托管、僵尸进程回收、进程组关系树 | 已实现 |
| 线程管理 | 同地址空间线程创建、waittid 等待、gettid、线程退出回收 | 已实现 |
| 调度器 | FIFO 就绪队列、空闲自旋检查定时器 | 已实现 |
| 系统调用层 | 约 99 个系统调用号，覆盖文件 I/O（25 个）、进程管理（10 个）、内存管理（4 个）、同步/信号（10 个）、时间（5 个）、socket（6 个）、SysV 共享内存（4 个）、自定义（10 个）、桩函数（15 个） | 已实现 |
| 文件系统 (VFS) | File trait 抽象、OSInode（ext4 路径封装）、Pipe（环形缓冲管道）、Stdin/Stdout（控制台 I/O）、DevNullZero 设备、SocketFile、挂载点管理（最长前缀匹配）、双块设备挂载 | 已实现 |
| ext4 文件系统 | 超级块、块组、位图、inode、目录、文件读写、目录枚举、日志（通过 lwext4 C 库） | 已实现 |
| 设备驱动 | VirtIO 块设备（双设备：根设备 + 挂载设备）、DMA 分配、扇区级/批量读写 | 已实现 |
| 异常/中断处理 | 汇编 trap 入口（全寄存器保存/恢复）、Trampoline 页机制、页故障/非法指令信号递送、定时器中断调度、用户态 ecall 系统调用分发、内核态异常 panic | 已实现 |
| 同步原语 | UPSafeCell（RefCell 封装）、自旋锁（MutexSpin）、阻塞锁（MutexBlocking）、信号量（Semaphore）、条件变量（Condvar）、Futex（全局地址键 BTreeMap） | 已实现 |
| 定时器 | mtime 硬件时钟读取、100Hz 定时器中断、最小堆定时器管理器（add/remove/check）、get_time_ms/us/ns | 已实现 |
| 信号机制 | 信号标志设置/查询（rt_sigprocmask）、tgkill/kill、信号表定义；用户态信号处理函数递送未实现 | 部分实现 |
| ELF 加载 | 静态/动态 ELF（ET_EXEC/ET_DYN）解析、PT_INTERP 解释器加载、辅助向量构造（17 项）、静态 TLS 分配 | 已实现 |
| 管道 IPC | 32 字节环形缓冲、阻塞读/写、写端关闭检测（Weak 引用计数） | 已实现 |
| SysV 共享内存 | shmget/shmat/shmdt/shmctl | 已实现 |
| 本地 Socket | AF_LOCAL stream/dgram、socket/bind/listen/accept/connect/socketpair | 已实现 |

## 三、各子系统实现完整程度与细节

### 3.1 内存管理

**完整度评估**：约 85%

**已实现**：页帧栈式分配器（RAII FrameTracker）、伙伴系统堆分配器（256 MiB 内核堆）、SV39 三级页表（惰性中间页表分配）、地址空间（MemorySet + MapArea，三种映射类型：恒等/Framed/Shared）、ELF 地址空间构造、fork 地址空间复制（区分共享/私有）、mmap/munmap/brk/mprotect。

**关键实现细节**：
- 物理地址范围：ekernel 至 0xC0000000，约 256 MB 可用
- `VirtPageNum::indexes()` 返回 `[VPN2, VPN1, VPN0]` 三级索引
- `MapArea` 通过 `is_shared` 标志与 `shared_frames` 向量区分 MAP_SHARED 与 MAP_PRIVATE
- fork 时对 `is_shared` 区域仅增加引用计数，不复制物理页

**缺失项**：无 COW（写时复制，fork 时全量复制物理页）、无页面交换（swap）、无大页（huge page）支持、无 NUMA 支持、无 KSM（内核同页合并）。

**优点**：代码类型安全性强（PhyAddr/VirtAddr/PhyPageNum/VirtPageNum 新类型封装），RAII 资源管理彻底（FrameTracker、KernelStack），惰性页表分配策略合理。
**缺点**：全量 fork 复制导致内存效率低、无延迟分配（demand paging）优化。

### 3.2 进程管理

**完整度评估**：约 80%

**已实现**：PCB/TCB 两级模型、fork（含 CLONE_PARENT_SETTID/CLONE_CHILD_SETTID/CLONE_CHILD_CLEARTID）、exec（静态/动态/PIE）、waitpid、exit/exit_group、孤儿进程自动托管给 initproc、僵尸进程回收、进程组父子关系树。

**关键实现细节**：
- PCB 中存储用户态 token（`AtomicUsize` 缓存页表根，免锁读取）
- `exec_static()` 完整构造 Linux ABI 辅助向量（17 项：AT_PHDR/AT_PHENT/AT_PHNUM/AT_BASE/AT_ENTRY/AT_RANDOM/AT_PLATFORM 等），支持 musl/glibc `__libc_start_main`
- 动态链接器加载路径 fallback 机制：musl → `/musl/lib/libc.so`，glibc → `/glibc/lib/ld-linux-riscv64-lp64d.so.1`
- AIO 回调兼容：写入 magic 值 `0xDEAD` 至 aio_context[1] 满足 musl `__aio_wake` 检测

**缺失项**：无 COW、无进程优先级（nice）、无 cgroup、无 namespace、无 rlimit 实际强制执行（虽定义了 rlimits 字段）、ptrace 完全未实现。

**优点**：fork/exec 流程完备，孤儿进程回收和僵尸进程清理逻辑清晰，CLONE 标志支持使线程创建与 libc 的 pthread 兼容。
**缺点**：全量复制地址空间效率低，进程间关系仅维护父子链而无进程组/会话等更完整 POSIX 概念。

### 3.3 线程管理

**完整度评估**：约 75%

**已实现**：同地址空间线程创建（`sys_thread_create`）、线程等待（`sys_waittid`）、获取线程 ID（`sys_gettid`）、主线程退出触发进程终止、非主线程安全退出并回收。

**关键实现细节**：线程与进程共享 `ustack_base`，通过 `Arc<TaskControlBlock>` 管理线程生命周期。线程 TCB 中 `exit_code` 在退出时设置，由 `waittid` 读取并回收。

**缺失项**：无线程调度优先级、无线程亲和性（CPU affinity）、无 TLS 动态分配（仅静态 TLS）、无线程取消点（cancellation point）。

**优点**：线程创建与回收模型清晰，与进程模型共享 PCB/TCB 架构，代码复用度较好。
**缺点**：调度器对所有线程同等对待（FIFO），无优先级区分。

### 3.4 文件系统

**完整度评估**：VFS 约 80%，ext4 约 85%（得益于复用 lwext4 C 库）

**已实现**：VFS File trait 统一接口、OSInode（ext4 文件/目录路径封装）、Pipe（32 字节环形缓冲）、Stdin/Stdout、DevNullZero、SocketFile、挂载点管理（全局 MOUNT_TABLE + 最长前缀匹配路径解析）、双块设备支持（根设备 + /mnt 挂载设备）。

**关键实现细节**：
- ext4 完全通过 C 库绑定实现：`Ext4BlockWrapper<K: KernelDevOp>` 将 Rust 块设备驱动桥接至 C 回调（`dev_open/dev_bread/dev_bwrite/dev_close`）
- `Ext4Inode` 采用延迟打开策略（`ensure_open()`），避免不必要的 inode 分配
- 管道写端关闭检测通过 `Weak<Pipe>` 引用计数实现
- 文件描述符表存储在 `ProcessControlBlockInner` 中，`fork` 时全量复制后按需通过 CLOEXEC 标志清理

**缺失项**：无 VFS inode/dentry 缓存、无路径缓存（每次路径查找从根遍历）、无文件锁（flock/fcntl lock）、管道缓冲区仅 32 字节（POSIX 建议至少 4096 字节）、无伪文件系统（procfs/sysfs/devfs）、无 sendfile 实际实现（虽有 syscall 号但实现未确认）。

**优点**：通过复用 lwext4 C 库（约 2 万行）获得了成熟的 ext4 支持（含日志），File trait 抽象简洁且易于扩展，双挂载点设计具备基本的多设备管理能力。
**缺点**：缺乏任何形式的缓存层级，每次读写均穿透至块设备；管道缓冲区过小影响吞吐量。

### 3.5 设备驱动

**完整度评估**：约 70%

**已实现**：VirtIO 块设备驱动（双设备，MMIO 地址 0x10001000/0x10002000）、DMA 分配与地址转换、单扇区/多扇区读写。

**关键实现细节**：`VirtioHal` 实现 `virtio_drivers` 库的 HAL trait，使用内核帧分配器进行 DMA 内存分配，通过 `PhysAddr::from()` 和 `VirtAddr::from()` 完成物理-虚拟地址转换。

**缺失项**：仅支持块设备，无 VirtIO 网络/GPU/输入设备驱动，无中断驱动的异步 I/O（通过轮询完成），无 DMA 映射缓存。

**优点**：驱动实现精简，HAL 层抽象合理，双设备支持与挂载管理配合良好。
**缺点**：设备类型单一，缺乏网络设备驱动使得网络协议栈无法落地。

### 3.6 异常与中断处理

**完整度评估**：约 85%

**已实现**：汇编级完整寄存器保存/恢复（32 个通用寄存器 + sstatus + sepc）、Trampoline 页机制、页故障转 SIGSEGV/非法指令转 SIGILL、定时器中断触发调度、ITIMER_REAL 检查与 SIGALRM 发送、系统调用分发、内核态异常 panic。

**关键实现细节**：
- Trampoline 页（`TRAMPOLINE`）存放 `__alltraps` 和 `__restore`，用户/内核共享，保证特权级切换时页表切换的原子性
- `TrapContext` 存储于 `TRAP_CONTEXT_BASE - tid * PAGE_SIZE`，每个线程独占一页
- 信号检查在 `trap_return()` 前执行，若有待处理信号则调用 `exit_current_and_run_next()`

**缺失项**：真正的用户态信号处理函数调用未实现（仅终止进程），内核态异常处理仅 panic 无恢复机制。

**优点**：Trampoline 设计标准且安全，寄存器保存/恢复完整，异常到信号的映射清晰。
**缺点**：信号递送不完整，限制了用户态程序对异常的自定义处理能力。

### 3.7 同步原语

**完整度评估**：约 90%

**已实现**：UPSafeCell（单核 RefCell 封装）、MutexSpin（自旋锁 + 调度挂起）、MutexBlocking（等待队列阻塞锁）、Semaphore（PV 操作 + 等待队列）、Condvar（与 Mutex 配合的条件变量）、Futex（全局 BTreeMap 地址键等待队列）。

**关键实现细节**：
- `UPSafeCell` 基于 `RefCell`，`exclusive_access()` 在 borrow 冲突时 panic 并打印调用位置（`#[track_caller]`）
- `Futex` 使用 `BTreeMap<usize, Vec<Arc<TCB>>>` 以用户态地址为键管理等待任务，`futex_wake_all()` 支持 CLONE_CHILD_CLEARTID 机制
- `Condvar::wait()` 先释放 mutex、加入等待队列、阻塞；被唤醒后重新获取 mutex

**缺失项**：Futex 的超时参数被忽略（无限等待），无 PI（优先级继承）futex 支持，无 robust futex 完整处理（虽有 `set_robust_list` syscall）。

**优点**：同步原语种类齐全，实现正确且遵循标准语义，Futex 地址键设计合理，UPSafeCell 在单核无抢占假设下高效。
**缺点**：Futex 无超时处理，鲁棒性受限；UPSafeCell 在引入多核或抢占式调度后需全面替换。

### 3.8 定时器

**完整度评估**：约 85%

**已实现**：mtime 硬件时钟读取、100Hz 定时器中断、基于最小堆的定时器管理器（BinaryHeap<TimerCondVar>）、add_timer/remove_timer/check_timer 接口、get_time_ms/us/ns 时间获取、nanosleep/clock_nanosleep 系统调用。

**关键实现细节**：
- `run_tasks()` 主循环在无就绪任务时检查 `TIMERS` 堆，若无挂起定时器才真正空闲，否则自旋等待定时器触发，避免 nanosleep 等待期间错误关机
- 定时器中断频率 100Hz（`TICKS_PER_SEC = 100`），时钟频率 12.5 MHz（QEMU virt）

**缺失项**：无高精度定时器（hrtimer）、无 tickless 模式、无 clock_gettime 的多个时钟源支持（仅有 CLOCK_MONOTONIC）。

**优点**：定时器管理基于标准堆数据结构，接口清晰，空闲判断逻辑考虑了挂起定时器的情况，实用性强。
**缺点**：100Hz 中断频率在虚拟化环境下开销可接受但精度有限，时钟源支持单一。

### 3.9 信号机制

**完整度评估**：约 40%

**已实现**：信号标志定义（SIGSEGV/SIGILL/SIGALRM/SIGCHLD 等）、rt_sigprocmask（信号屏蔽字设置）、kill/tgkill（信号发送）、页故障/非法指令/ITIMER_REAL 触发信号标志设置。

**关键实现细节**：
- 信号标志存储在 `ProcessControlBlockInner.signals` 中，为简单的 pending 位集
- `trap_return()` 前检查信号 pending，若有则直接终止当前任务

**缺失项**：无用户态信号处理函数调用（sigaction 注册的处理函数从未被调用）、无信号栈（sigaltstack）、无 rt_sigsuspend/rt_sigtimedwait 实际实现、rt_sigaction 为桩函数（返回 0）。

**优点**：信号标志的基础框架已搭建，页故障到 SIGSEGV 的映射通路完整。
**缺点**：核心短板——无真正的信号递送机制，限制了 LTP 等测试套件中信号相关用例的通过。

### 3.10 调度器

**完整度评估**：约 40%

**已实现**：FIFO 就绪队列（`TASK_MANAGER`）、单核调度循环、suspend_current_and_run_next/block_current_and_run_next 调度点。

**关键实现细节**：
- 就绪队列为简单的 FIFO 队列，`run_tasks()` 从中取出任务执行
- 协作式调度：仅在显式挂起（suspend/block）或定时器中断时触发切换
- 空闲时自旋检查定时器，避免错误关机

**缺失项**：无时间片轮转、无优先级调度、无多核 SMP、无负载均衡、无实时调度类、无 CFS（完全公平调度器）。

**优点**：实现极简，调度开销低，适合单核教学/竞赛场景。
**缺点**：过于简单，无法满足交互式任务或多任务负载下的公平性要求。

## 四、OS 内核整体实现完整度

以运行 Linux 标准测试程序（busybox、LTP、iozone）为目标，**整体实现完整度约 75%**。内核已具备运行复杂用户态程序的核心能力（进程模型、文件系统、内存管理、动态链接），但在性能优化（COW、缓存）、多核支持、完善的信号递送等方面存在明显缺口。

## 五、动态测试设计

由于分析环境限制，本次评估**未执行实际 QEMU 运行测试**，以下基于源代码中的测试框架进行分析。

### 5.1 测试体系设计

项目设计了多层次的测试体系：

1. **用户态自定义测试程序**（`user/src/` 约 56 个程序）：
   - 基础系统调用测试：`forktest`、`pipetest`、`mmap_test`、`fstest`、`shm_test` 等
   - 线程测试：`threads`、`threads_arg`、`mtest` 等
   - 文件 I/O 测试：`filetest`、`huge_write`、`cat` 等
   - 信号测试：`sigtest`、`signal` 等

2. **标准测试套件集成**：
   - busybox：部分内置命令（sh/ls/cat/cp/mv 等）可用于功能验证
   - iozone：文件 I/O 性能基准测试
   - LTP（Linux Test Project）：部分 syscall 测试用例

3. **自动化测试脚本**（`tools/` 目录）：
   - 构建脚本（`build.sh`/`Makefile`/`build-all.sh`）
   - sdcard 镜像制作脚本
   - QEMU 启动脚本

### 5.2 测试设计评价

测试设计体现了“以通过标准测试套件为目标”的务实策略。自定义测试程序覆盖了核心系统调用路径，标准测试套件（busybox/LTP）则提供更广泛的兼容性验证。然而，测试框架缺乏单元测试层面的组件测试（如仅测试页分配器或页表逻辑），也未见内核层面的断言/自测代码，测试完全依赖用户态黑盒验证。测试覆盖率难以量化。

## 六、细则评价表格

### 6.1 内存管理

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | 约 85% |
| 关键发现 | 页帧分配器（栈式回收）、伙伴系统堆分配器、SV39 三级页表（惰性分配）、MemorySet/MapArea 地址空间模型、mmap/munmap/brk/mprotect 均实现。fork 时全量复制物理页，无 COW。 |
| 评价 | 类型安全的地址抽象、RAII 资源管理是突出优点。全量 fork 复制和无页面交换是主要局限，在内存受限场景下可能成为瓶颈。 |

### 6.2 进程管理

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | 约 80% |
| 关键发现 | PCB/TCB 两级模型、fork/exec/waitpid/exit 核心流程完整。动态链接 ELF 加载（musl/glibc 双支持）和 Linux ABI 辅助向量构造（17 项）是亮点。孤儿进程托管和僵尸回收逻辑清晰。 |
| 评价 | 进程模型较为完整，exec 中对动态链接器和 TLS 的处理展现了良好的系统编程深度。无 COW、无进程组/会话是主要不足。 |

### 6.3 文件系统

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | VFS 约 80%，ext4 约 85% |
| 关键发现 | VFS File trait 抽象简洁（6 种文件类型实现），通过 lwext4 C 库绑定获得完整 ext4 支持（含日志）。双挂载点设计。管道仅 32 字节缓冲。 |
| 评价 | 复用成熟 C 库的策略使 ext4 支持迅速达到较高水准。缺乏任何缓存层级（inode/dentry/路径）导致每次操作穿透至块设备，I/O 效率偏低。管道容量不足。 |

### 6.4 交互设计

| 项目 | 内容 |
|------|------|
| 是否实现 | 是（基础实现） |
| 完整度 | 约 60% |
| 关键发现 | 通过 Stdin/Stdout 支持控制台输入输出，系统调用接口遵循 Linux ABI 规范，命令通过 busybox 内置 shell 执行。未发现独立的 shell 实现或用户友好交互界面。 |
| 评价 | 控制台 I/O 通路可用，满足基本交互需求。交互体验完全依赖 busybox，内核本身未提供额外的人机交互机制（如调试 shell、内核日志级别动态调整等）。 |

### 6.5 同步原语

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | 约 90% |
| 关键发现 | 实现种类齐全：UPSafeCell、自旋锁、阻塞锁、信号量、条件变量、Futex。Futex 使用 BTreeMap 地址键管理等待队列，语义正确。UPSafeCell 基于 RefCell 并在冲突时 panic 提供调试信息。 |
| 评价 | 为本项目最完整的子系统之一。实现规范性好，Futex 设计支持了 pthread 同步需求。Futex 超时参数被忽略，限制了带超时的等待操作。 |

### 6.6 资源管理

| 项目 | 内容 |
|------|------|
| 是否实现 | 是（基础实现） |
| 完整度 | 约 65% |
| 关键发现 | PID/TID/KernelStack 采用分配器+回收复用策略。FrameTracker 和 KernelStack 使用 RAII 模式自动回收。文件描述符表在 fork 时复制。rlimits 结构已定义但在内核中未强制执行。 |
| 评价 | RAII 资源管理模式保证了页帧和内核栈的可靠回收。PID 回收复用避免了 PID 耗尽问题。资源限制（rlimits）仅定义未执行，进程退出时同步原语列表的回收机制存在但未深入验证。 |

### 6.7 时间管理

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | 约 85% |
| 关键发现 | 基于 mtime 硬件时钟，100Hz 定时器中断，最小堆定时器管理器。提供 nanosleep/clock_nanosleep/clock_gettime/gettimeofday/times 系统调用。空闲时检查挂起定时器避免错误关机。 |
| 评价 | 定时器管理逻辑正确，空闲判断的“检查挂起定时器”设计细节体现了工程实践中的细致考虑。时钟源支持单一、无高精度定时器是主要不足。 |

### 6.8 系统信息

| 项目 | 内容 |
|------|------|
| 是否实现 | 否（基本未实现） |
| 完整度 | 约 10% |
| 关键发现 | 未见 /proc 伪文件系统、sysinfo、uname 等系统信息接口。仅 `sys_syslog` 以桩函数形式存在（返回 0）。无内核版本信息、无系统统计（CPU/内存/进程数）暴露机制。 |
| 评价 | 系统信息模块几乎空白。这是面向测试套件务实策略的直接体现——标准测试（LTP/busybox）的通过不依赖此模块。对于实际使用场景，缺少系统信息查询接口会影响可维护性。 |

### 6.9 信号处理（补充条目）

| 项目 | 内容 |
|------|------|
| 是否实现 | 部分 |
| 完整度 | 约 40% |
| 关键发现 | 信号标志定义和 pending 位集已实现，页故障/非法指令/ITIMER_REAL 可设置信号标志。但 rt_sigaction 为桩函数，用户态信号处理函数从未被调用。 |
| 评价 | 信号框架已搭建，但核心的信号递送机制（保存/恢复用户态上下文、跳转到信号处理函数、sigreturn）完全缺失。这是制约 LTP 信号相关测试用例通过的关键因素。 |

### 6.10 可移植性（补充条目）

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | 约 70% |
| 关键发现 | 同时维护 RISC-V 和 LoongArch 两套内核实现，LoongArch 内核通过 polyhal 硬件抽象层适配。两套实现共享相似的架构设计但独立演化。VFS、同步原语等模块存在代码重复。 |
| 评价 | 双架构实现展示了良好的可移植性意识，但共享代码比例不高（LoongArch 内核约 12508 行，RISC-V 内核约 9810 行），真正的架构无关核心抽象尚未完全提炼。 |

### 6.11 构建与工程化（补充条目）

| 项目 | 内容 |
|------|------|
| 是否实现 | 是 |
| 完整度 | 约 75% |
| 关键发现 | 使用 Cargo 构建 Rust 内核、Makefile 管理整体构建流程、sdcard 镜像制作脚本、QEMU 启动脚本。LoongArch 内核有独立的 Makefile。lwext4 C 库通过 `build.rs` 编译集成。 |
| 评价 | 构建系统可完成内核编译和镜像生成，但缺乏统一的顶层构建入口（需手动构建 sdcard 镜像）、未提供容器化构建环境（Dockerfile 存在但依赖外部镜像）、交叉编译工具链配置依赖宿主机环境。 |

## 七、总结评价

Ferriswheel OS 是一个**以通过 Linux 标准测试套件为目标的务实型教学/竞赛内核**。其技术路线体现了明确的优先级取舍：在核心路径（进程模型、文件系统、内存管理）上投入大量工程精力，在非关键路径（信号递送、调度策略、系统信息）上采用桩函数或最小化实现。

**核心优势**：
- 系统调用覆盖广泛（约 99 个），能够运行 busybox、LTP、iozone 等标准测试
- 通过复用 lwext4 C 库（约 2 万行），在较短的内核代码规模下获得了成熟的 ext4 文件系统支持
- 动态链接 ELF 加载机制完整，支持 musl 和 glibc 双工具链，辅助向量构造规范
- Rust 类型系统运用得体（地址新类型、RAII 资源管理、Trait 抽象），代码质量较好
- 双架构（RISC-V + LoongArch）并行维护体现了可移植性考量

**主要不足**：
- 无 COW、无抢占式调度、无多核 SMP 支持，限制了内核在现代硬件上的适用性
- 信号机制仅为框架性实现，无真正的用户态信号处理函数递送
- 调度器过于简单（FIFO），无法提供基本的公平性保证
- 文件系统和路径查找缺乏任何缓存层级，I/O 效率有显著提升空间
- 系统信息查询接口几乎空白，降低了可调试性和可维护性
- 构建工程化有待完善，缺少统一的容器化构建流程

从工程角度看，该项目约 5.1 万行的代码体量中，约 40% 为外部 C 库（lwext4），约 45% 为 Rust 内核代码，约 15% 为用户态测试程序。整体架构清晰，模块划分合理，核心路径的实现深度能够支撑复杂用户态程序的运行。项目的务实策略——以通过标准测试套件为基准、在非关键路径使用桩函数——在竞赛/教学场景下是高效的工程决策，但若作为通用操作系统内核，仍需在 COW、调度、缓存、信号等关键领域进行大量补充工作。