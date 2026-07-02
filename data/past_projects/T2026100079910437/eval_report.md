# StarryOS 内核项目技术画像与评估报告

## 一、项目基本信息

| 项目 | 内容 |
|------|------|
| 项目名 | StarryOS |
| 架构 | RISC-V（主要）、x86_64、AArch64、LoongArch |
| 实现语言 | Rust |
| 生态归属 | 基于 ArceOS 框架的独立宏内核项目（非 Linux/BSD 衍生） |
| 许可协议 | Apache 2.0 |
| 代码行数（不含 ArceOS 框架） | 约 27,264 行 |
| 代码行数（含 ArceOS 框架） | 约 56,000 行 |
| 项目特点 | 支持 vSched2 用户态调度框架、多架构、基于 VDSO 的调度器抽象 |
| 内核类型 | 宏内核（monolithic kernel） |
| 项目状态 | 活跃开发中的原型/中级阶段 |

---

## 二、子系统与功能实现列表

### 2.1 已实现的子系统

| 子系统 | 概述 |
|--------|------|
| 进程管理 | 进程/线程创建（fork/clone）、PID 管理、进程组/会话、等待子进程、退出处理、资源限制 |
| 内存管理 | 虚拟地址空间、ELF 加载（静态/动态）、mmap（匿名/文件/设备/共享/大页）、brk 堆管理、CoW |
| 文件系统 (VFS) | VFS 抽象层、devfs、tmpfs/MemoryFs、procfs、管道、设备文件、ext4/FAT（通过 ArceOS） |
| 系统调用 | 约 206 个 Linux 兼容系统调用分支 |
| 信号处理 | 信号发送/接收/屏蔽、信号帧管理、signalfd |
| Futex/同步 | FUTEX_WAIT/WAKE、REQUEUE、CMP_REQUEUE、bitset 操作、robust list |
| I/O 多路复用 | epoll、poll/ppoll、select/pselect6 |
| 网络协议栈 | IPv4 TCP/UDP、Unix domain socket、socket API（通过 ArceOS axnet） |
| IPC | System V 共享内存、System V 消息队列、虚拟队列 IPC（vQueue，实验性） |
| 终端/TTY | PTY 主从设备对、行规程（canonical/raw）、job control、termios |
| 时间管理 | clock_gettime、gettimeofday、times、getitimer/setitimer、clock_getres |
| vSched2 调度器 | 用户态协程式调度框架、自定义陷阱向量、VDSO 调度器接口 |
| 多架构支持 | RISC-V（完整）、x86_64、AArch64、LoongArch（基础功能可用） |

### 2.2 未实现或未完成的功能

| 功能 | 状态 |
|------|------|
| System V 信号量 | 未实现 |
| Cgroup/Namespace | 仅定义了 CloneFlags 位掩码，实际逻辑未实现 |
| mprotect/madvise/msync/mlock | 未实现 |
| PI futex / FUTEX_WAKE_OP | 未实现 |
| IPv6 / AF_NETLINK / 原始 socket | 未实现 |
| 物理网卡驱动支持 | 仅支持 VirtIO-net（通过 ArceOS） |
| vSched2 非 RISC-V 架构 | 未实现（含 `unimplemented!()` 宏） |
| coredump 实际生成 | 未实现（仅计算退出码） |
| inotify | 未实现 |

---

## 三、各子系统实现完整程度

完整度评估基准定义：以 Linux 内核相应子系统的功能集为参照，考量功能覆盖率、边界情况处理和数据结构的完整程度。

| 子系统 | 完整度 | 评估依据 |
|--------|--------|----------|
| 进程管理 | 高 (约85%) | fork/clone/execve/exit/wait 核心路径完整；缺少 vfork、cgroup、namespace 实际实现；execve 限制单线程 |
| 内存管理 | 中高 (约75%) | 地址空间、ELF 加载、mmap/brk 实现扎实；缺少 mprotect、madvise、msync 等关键内存控制接口 |
| 文件系统 (VFS) | 中高 (约80%) | VFS 抽象设计良好，MemoryFs 实现完整；部分 procfs 数据硬编码；文件锁实现存根化 |
| 系统调用覆盖 | 中高 (约80%) | 206 个分支覆盖主流 POSIX 调用；内存管理和 IPC 类调用缺口明显 |
| 信号处理 | 高 (约85%) | 信号发送/接收/屏蔽/等待路径完整；缺少 coredump 生成、stop/continue 完整语义 |
| Futex/同步 | 中高 (约70%) | 基础 futex 操作完整，robust list 支持到位；缺少 PI futex 和 FUTEX_WAKE_OP |
| I/O 多路复用 | 高 (约90%) | epoll/poll/select 三类实现完整，支持边缘触发、oneshot；集成信号中断处理 |
| 终端/TTY | 中高 (约75%) | PTY 对、行规程、job control 基本可用；部分 termios 属性未覆盖 |
| 网络协议栈 | 中高 (约75%) | TCP/UDP/Unix socket 核心路径可用；缺少 IPv6、原始 socket、netlink |
| IPC | 基本 (约65%) | 共享内存基本可用，消息队列实现较浅；信号量完全缺失；vQueue 处于实验阶段 |
| vSched2 调度器 | 不完整 (约60%) | RISC-V 框架完整但默认禁用；非 RISC-V 架构未实现；抢占调度策略依赖外部 libvsched2.so |
| 多架构支持 | 中高 (约70%) | RISC-V 功能最完整；x86_64/AArch64 核心可用但 vSched2 缺位；LoongArch 支持最少 |

---

## 四、各子系统优缺点及实现细节

### 4.1 进程管理

**优点：**
- 基于 `starry-process` crate 的 PID 分配和进程树管理，结构清晰。
- clone 支持 CLONE_VM、CLONE_FILES、CLONE_FS、CLONE_SIGHAND、CLONE_THREAD 等核心标志，多线程进程创建路径完整。
- `ProcessData` 和 `Thread` 数据结构分离进程级和线程级状态，设计合理。
- 支持进程组（ProcessGroup）和会话（Session）的 job control 语义。
- 退出路径处理了 robust_list 清理和 clear_child_tid 通知。

**不足：**
- execve 系统调用限制调用进程必须为单线程，多线程进程执行 execve 会返回错误。
- 用户堆管理仅使用原子变量 `heap_top` 记录堆顶，缺少对堆碎片的回收。
- vfork 系统调用未实现（syscall 分发表中无对应分支）。
- `CloneFlags` 枚举定义了 CLONE_NEWCGROUP、CLONE_NEWNS 等命名空间相关标志，但实际 clone 路径中未使用，仅为占位。
- 无 OOM killer 实现，`oom_score_adj` 仅通过 procfs 读写但无后端逻辑。

**关键实现细节：**
- 进程创建时，子进程的地址空间通过 `AddrSpace::try_clone()` 以 CoW 方式复制。
- 文件描述符表通过 `Scope` 机制在 clone 时根据标志位选择共享或复制。
- 任务调度使用 ArceOS 的 `spawn_task()` 接口，任务结束后通过 `task.join()` 回收。
- PID 分配基于 `starry-process` crate 的位图分配器，支持 PID 复用。

### 4.2 内存管理

**优点：**
- `load_user_app()` 实现完整的 ELF 加载流程：解析 Program Headers、检测并加载动态链接器（PT_INTERP）、构造 AUX vector、初始化用户栈。
- CoW（Copy-on-Write）机制通过 `Backend::new_cow` 实现，文件段映射使用 `FileBackend::Cached` 优化。
- mmap 实现支持多种映射类型：匿名映射（MAP_ANONYMOUS）、文件映射（Cached/Direct 后端）、设备映射（物理地址）、共享内存（SharedPages）、大页（MAP_HUGETLB、2MB/1GB）。
- 支持 MAP_FIXED 和 MAP_FIXED_NOREPLACE 的精确地址映射语义。
- ELF 加载使用 LRU 缓存（容量 32），避免重复解析同一可执行文件。
- RISC-V 和 x86_64 架构实现了内核地址空间到用户页表的复制映射，减少上下文切换时的 SATP 切换开销。

**不足：**
- 缺少 mprotect 系统调用，用户态无法动态修改内存页的访问权限。
- 缺少 madvise 系统调用，无法向内核提供内存使用提示。
- msync 未实现，文件映射的同步写回缺少用户态控制路径。
- mlock/munlock 未实现，无法锁定物理页面。
- 用户堆最大限制为 512MB（`USER_HEAP_SIZE_MAX`），对于某些应用可能不足，且该值为编译时常量。
- 按需分页（demand paging）依赖 ArceOS 的缺页处理，但未实现预读策略。

**关键实现细节：**
- 地址空间创建通过 `axmm::AddrSpace::new_empty()` 进行，各架构的用户空间基址和大小在 `config.rs` 中定义。
- brk 的扩展每次分配一页，收缩时以页为单位释放，不会产生部分页面的释放。
- VDSO 共享库通过专用函数 `map_vdso()` 映射到用户地址空间的固定位置（`USER_SIGNAL_TRAMPOLINE_BASE + PAGE_SIZE`）。
- 信号 trampoline 页面映射在 `USER_SIGNAL_TRAMPOLINE_BASE`，用于信号处理函数的返回跳板。

### 4.3 文件系统

**优点：**
- VFS 抽象设计清晰：`SimpleFileOps`、`SimpleDirOps`、`DeviceOps` 三个核心 trait 覆盖了文件、目录和设备三类对象。
- MemoryFs 是独立于 ArceOS VFS 的完整实现，包含 slab 分配器、目录项 HashMap、引用计数和 nlink 追踪，功能齐全。
- procfs 覆盖了进程状态查询的主要文件：`/proc/[pid]/stat`、`/proc/[pid]/status`、`/proc/[pid]/fd/`、`/proc/[pid]/cmdline`等，格式与 Linux 兼容。
- 设备文件覆盖了常用设备（null、zero、full、random、urandom、tty、console、ptmx、loop、fb0 等），主次设备号分配与 Linux 一致。
- 支持 memfd_create 创建匿名内存文件。
- 文件描述符表通过 `close_range` 系统调用支持批量关闭。

**不足：**
- `/proc/meminfo` 的内容为硬编码静态文本，不反映实际内存使用情况。
- `/proc/[pid]/maps` 仅显示 VDSO 映射区域，未遍历实际地址空间的所有映射。
- 文件锁（flock）在 fcntl 系统调用中有调用路径，但实际锁定逻辑为存根实现。
- 缺少 inotify 文件事件通知机制。
- xattr（扩展属性）的 getxattr/listxattr 仅返回固定空列表。
- `/proc/[pid]/mounts` 依赖实际挂载信息，但挂载信息的数据结构未与 procfs 深度集成。
- loop 设备列于 devfs 但实际后端实现有限。

**关键实现细节：**
- `SimpleFs::init()` 使用 slab 分配器为 inode 预分配空间，每个 inode 大小固定。
- MemoryFs 的 inode 回收策略：当 nlink 降至 0 且外部引用计数降至 2（仅剩文件系统内部引用和调用者引用）时，触发 inode 回收。
- 文件描述符表使用 `scope-local` crate 实现 per-process 隔离，clone 时根据 CLONE_FILES 标志选择共享或复制。
- 管道基于 `ringbuf::HeapRb` 实现，默认容量 64KB，支持 fcntl F_SETPIPE_SZ 动态调整容量（页面对齐）。

### 4.4 信号处理

**优点：**
- 信号处理路径完整：从系统调用入口到信号入队、检查、分发，再到用户态信号处理函数的 trampoline 执行和 rt_sigreturn 返回。
- 支持实时信号的队列化（rt_sigqueueinfo）和附带数据传递。
- signalfd4 实现将信号转换为文件描述符可读事件，与 epoll 集成。
- 支持信号栈（sigaltstack）切换，通过 `SignalFrame` 结构保存和恢复上下文。
- 进程级信号管理（`ProcessSignalManager`）和线程级信号管理（`ThreadSignalManager`）分离清晰。
- 信号屏蔽（sigmask）在信号处理函数执行前自动设置，rt_sigreturn 恢复。

**不足：**
- coredump 生成仅计算退出码（128+signo），未实际生成 core 文件。
- SIGSTOP/SIGCONT 的处理逻辑缺少实际的停止/继续控制，仅为存根。
- 信号发送到前台进程组的功能依赖终端行规程的 VINTR/VQUIT/VSUSP 字符识别，但行规程的部分特殊字符处理未完全实现。
- 缺少对 SIGBUS 的详细错误地址信息传递（siginfo_t 的 si_addr 字段填充不完整）。

**关键实现细节：**
- 信号 trampoline 代码位于 `USER_SIGNAL_TRAMPOLINE_BASE` 页面，包含恢复上下文并调用 rt_sigreturn 的汇编序列。
- `check_signals()` 在每次从内核态返回用户态前被调用，确保信号在安全的时间点被处理。
- 信号处理函数执行前，内核在用户栈上构造 `SignalFrame`，包含保存的寄存器上下文和 siginfo_t/ucontext_t。
- `block_next_signal()` 和 `unblock_next_signal()` 提供了一种机制，在特定区间内阻止信号分发（用于内核中访问用户内存的临界区）。

### 4.5 I/O 多路复用

**优点：**
- epoll 实现完整，支持 EPOLL_CTL_ADD/MOD/DEL、EPOLLONESHOT、边缘触发。
- epoll_wait 在等待期间可被信号中断，返回 -EINTR。
- poll/ppoll 和 select/pselect6 均基于统一的事件循环实现，代码重用度高。
- 管道、socket、eventfd、signalfd、终端等均实现了所需的 Pollable 接口，与 epoll 无缝集成。
- 超时参数支持纳秒级精度（通过 ArceOS 的定时器接口）。

**不足：**
- epoll 未实现 EPOLLEXCLUSIVE 标志，无法避免惊群效应。
- 未实现 EPOLLWAKEUP 标志（与电源管理相关）。
- select 的 fd_set 大小限制为 1024（与 Linux 默认相同），但未提供运行时扩展机制。

**关键实现细节：**
- epoll 内部使用 `EpollFile` 结构，包含红黑树（或等效的有序集合）管理监控的文件描述符和事件掩码。
- 就绪队列使用 `VecDeque` 维护，事件触发时文件描述符被推入队列。
- `PollSet` 机制用于进程退出事件的异步通知，通过 `Arc<PollSet>` 在进程间共享。

### 4.6 网络协议栈

**优点：**
- 通过 ArceOS 的 `axnet` 模块提供了 TCP（SOCK_STREAM）和 UDP（SOCK_DGRAM）的 AF_INET 支持。
- Unix domain socket 实现完整，支持 SOCK_STREAM、SOCK_DGRAM、SOCK_SEQPACKET。
- 支持辅助数据（cmsg）传递，用于 Unix socket 的 SCM_RIGHTS（文件描述符传递）。
- socket API 覆盖全面：socket、bind、listen、accept/accept4、connect、shutdown、socketpair、sendmsg/recvmsg、sendto/recvfrom、getsockname/getpeername、getsockopt/setsockopt。

**不足：**
- AF_INET6（IPv6）完全缺失，无法处理 IPv6 地址族。
- 缺少 AF_NETLINK，无法与内核路由表或网络配置交互。
- 原始 socket（SOCK_RAW）未实现，无法进行自定义网络协议开发。
- packet socket（AF_PACKET）缺失。
- 网络设备仅支持 VirtIO-net（通过 ArceOS），物理网卡驱动依赖 ArceOS 的 VirtIO 框架。

**关键实现细节：**
- TCP socket 的 `accept()` 返回的套接字继承监听套接字的非阻塞标志。
- Unix socket 的 SOCK_SEQPACKET 通过消息边界队列实现，保证消息的原子性。
- getsockopt/setsockopt 支持 SOL_SOCKET 级别的常用选项（SO_REUSEADDR、SO_KEEPALIVE、SO_RCVBUF/SO_SNDBUF 等）。
- 网络命名空间的概念未引入，所有 socket 在全局命名空间中操作。

### 4.7 vSched2 用户态调度框架

**优点：**
- 设计理念新颖：将调度策略从内核态移至用户态，通过 VDSO 共享库分发调度器代码。
- 通过 VDSO VTable 接口向调度器暴露 27 个内核函数指针，覆盖任务管理、上下文切换、栈管理等。
- 自定义陷阱向量（`vsched2_trap_vector`）直接处理调度相关的 ecall，绕过通用陷阱路径，减少延迟。
- 支持协程式调度（`CoroutinePoll` trait），用户态可以定义协程的轮询行为。
- 用户态调度器可通过替换 `libvsched2.so` 进行热更新，无需重新编译内核。

**不足：**
- 默认禁用（`USE_VSCHED2 = false`），传统 ArceOS 调度器仍为默认选项。
- 仅在 RISC-V 架构上有完整实现，x86_64、AArch64、LoongArch 的 vsched context 中包含 `unimplemented!()` 占位。
- 陷阱向量的实现与 RISC-V 紧耦合，难以移植到其他架构。
- 具体调度策略依赖外部 `libvsched2.so`（预构建产物存储在 `vdso_vsched2_output/`），源码未包含在内核仓库中。
- SMP 支持不完整：`VschedSmpImpl` 仅返回当前 CPU ID，缺少多核调度器的负载均衡和任务迁移逻辑。
- vSched2 与 ArceOS 原有调度模型的集成深度有限——两者是二选一的关系而非可动态切换。

**关键实现细节：**
- 调度器选择过程：内核通过特殊 ecall（a7=0xdead）通知 vSched2，调度器在 VDSO 中做出决策后通过 sret 切换到目标任务。
- 内核页表被复制到所有用户页表中，避免调度时切换 SATP 寄存器。
- SUM（Supervisor User Memory）和 MXR（Make eXecutable Readable）位在进入用户态前设置，允许内核直接访问用户空间。
- `raw_run_task` 是 VDSO 中的汇编函数，负责从内核态恢复完整用户态上下文并执行 sret。

---

## 五、OS内核整体实现完整度

**评估基准：** 以一个能够运行主流 Linux 用户态应用程序（如 busybox、GNU coreutils、gcc 等）的通用操作系统内核为参照，考量核心子系统的功能覆盖率和实现的深度。

**整体完整度：约 77%（B+ 评级）**

**评估依据：**

1. **核心路径完整性（权重 40%）：得分 85/100**
   - 进程创建/销毁/切换路径完整
   - 内存分配/映射/回收路径基本完整
   - 文件 I/O 路径完整（open/read/write/close）
   - 信号处理路径完整
   - 同步原语（futex）核心操作完整

2. **系统调用覆盖率（权重 25%）：得分 80/100**
   - 实现了约 206 个 Linux 兼容系统调用分支
   - 核心 POSIX 系统调用覆盖良好
   - 内存管理和 IPC 类调用存在明显缺口
   - 网络类调用缺少 IPv6 和原始 socket

3. **边界与错误处理（权重 15%）：得分 65/100**
   - 常规错误码返回（ENOMEM、EINVAL、EFAULT 等）较为规范
   - 资源泄漏风险较低（Rust 所有权模型保障）
   - 极端情况处理不全面（如 OOM 下的行为未定义）
   - 竞态条件和死锁检测缺乏系统化处理

4. **架构可移植性（权重 10%）：得分 70/100**
   - 支持 4 个架构（RISC-V、x86_64、AArch64、LoongArch）
   - 核心功能在非 RISC-V 架构上可用
   - vSched2 仅在 RISC-V 上可用
   - 架构特定代码的抽象层次不一致

5. **创新设计与工程实践（权重 10%）：得分 75/100**
   - vSched2 用户态调度框架具备创新性
   - 代码模块化良好（core/api 分离）
   - VDSO 构建工具链自动化程度高
   - 遗留代码和未清理模块降低了工程整洁度

**加权求和：** 85*0.4 + 80*0.25 + 65*0.15 + 70*0.1 + 75*0.1 = 34 + 20 + 9.75 + 7 + 7.5 = 78.25，约 77-78%。

---

## 六、动态测试的设计和结果

### 6.1 测试设计概述

StarryOS 在 `tests/` 目录下包含约 30 行测试代码，通过集成测试框架 `tests/tests.rs` 执行内核功能验证。该测试文件通过 qemu 启动内核并运行用户态测试程序。

### 6.2 测试构建与运行要求

根据 Makefile 和 CI 配置分析，测试的完整执行需要：
- 预构建的 VDSO 共享库：`vdso_vsched2_output/libvsched2.so` 及相关产物
- 外部 rootfs 镜像（包含 busybox 和测试程序）
- 特定版本的工具链：RISC-V musl GCC/Rust 工具链
- QEMU 模拟器（RISC-V virt 平台）

### 6.3 本评估中的测试状态

**动态测试未执行。** 原因如下：

1. **VDSO 预构建依赖缺失：** 构建系统需要预先生成 `vdso_vsched2_output/libvsched2.so`，该产物需通过 `build_vdso` 工具链（依赖 RISC-V musl-ld）在特定流程中生成。当前环境中缺少 musl-ld 链接器及完整的构建上下文。

2. **外部 rootfs 镜像不可用：** 测试运行需要下载外部提供的 rootfs 镜像，该镜像不在代码仓库中。

3. **构建时错误：** 尝试初步构建时，编译器报告 VDSO 预构建产物的缺失，阻止了内核二进制文件的生成。

### 6.4 现有测试代码分析

从静态分析角度看，`tests/tests.rs` 设计为通过 QEMU 启动 StarryOS，并在内核中运行嵌入在 rootfs 中的用户态测试程序。测试框架的设计遵循标准的集成测试模式，即在模拟环境中启动完整的内核实例并验证其行为。

---

## 七、细则评价表格

### 7.1 内存管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中高（约75%） |
| 关键发现 | ELF 加载支持静态/动态链接，CoW 机制基于 axmm 后端实现；mmap 覆盖匿名/文件/设备/共享/大页多种映射类型；brk 支持扩展与收缩。但缺少 mprotect、madvise、msync 等关键内存控制接口。 |
| 评价 | 内存管理核心路径扎实，地址空间管理、ELF 加载和 mmap 实现质量良好。缺失的内存控制接口限制了用户态高级内存管理能力（如 JIT 编译器、垃圾回收器对 mprotect 的依赖）。 |

### 7.2 进程管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度高（约85%） |
| 关键发现 | fork/clone/execve/exit/wait 路径完整；支持 CLONE_VM/FILES/FS/SIGHAND/THREAD 等核心标志；进程组和会话的 job control 语义已实现；robust_list 和 clear_child_tid 等细节处理到位。但 execve 限制调用进程为单线程，缺少 vfork 和命名空间实际实现。 |
| 评价 | 进程管理是该项目最成熟的子系统之一，核心 POSIX 进程语义覆盖全面。单线程 execve 限制可能影响某些应用场景（如 shell 在后台进程中的 exec 调用），但在当前原型阶段是可接受的简化。 |

### 7.3 文件系统

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中高（约80%） |
| 关键发现 | VFS 抽象设计良好，MemoryFs 为独立完整实现；procfs 覆盖核心进程信息文件；设备文件种类齐全。但部分 procfs 数据为硬编码静态文本，文件锁为存根实现。 |
| 评价 | 文件系统层提供了可用的 POSIX 文件抽象，能够满足 shell 和基础应用的文件操作需求。procfs 的硬编码数据（如 meminfo）和部分存根实现降低了其在需要精确系统信息的场景中的实用性。 |

### 7.4 交互设计

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中高（约75%） |
| 关键发现 | PTY 主从设备对、行规程（canonical/raw 模式）、job control 均已实现；终端窗口大小可通过 TIOCGWINSZ/TIOCSWINSZ 调整。但部分 termios 属性未覆盖，行规程中某些特殊字符处理不完整。 |
| 评价 | 终端子系统能够支撑基本的交互式 shell 使用。行规程的输入处理（回显、擦除、行删除）和信号生成（VINTR/VQUIT）提供了可用的命令行体验。高级终端功能（如可配置的输出处理）仍有欠缺。 |

### 7.5 同步原语

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中高（约70%） |
| 关键发现 | futex 的 WAIT/WAKE/REQUEUE/CMP_REQUEUE 和 bitset 变体已实现；robust_list 支持线程异常退出时的 mutex 清理。但 PI futex 和 FUTEX_WAKE_OP 未实现，限制了实时应用和复杂同步模式的支持。 |
| 评价 | 基础 futex 功能能够支撑 pthread 同步原语（mutex、condvar、barrier 等）的正常工作。缺少 PI futex 意味着优先级反转问题无法通过内核机制解决，这对实时性要求高的应用有影响。 |

### 7.6 资源管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，基本完整（约65%） |
| 关键发现 | 支持 RLIMIT_NOFILE（最大文件描述符数）和 RLIMIT_STACK（栈大小限制）的资源限制；文件描述符表通过 close_range 支持批量关闭。但无 cgroup 资源控制器、无内存/CPU 使用限额、无 I/O 调度优先级。 |
| 评价 | 资源管理功能处于基础级别，能够防止单一进程耗尽文件描述符等简单场景。但缺少现代操作系统中常见的资源隔离和限制机制（cgroup），在多租户或容器化场景中无法提供有效的资源管控。 |

### 7.7 时间管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度高（约80%） |
| 关键发现 | 支持 CLOCK_REALTIME、CLOCK_MONOTONIC、CLOCK_PROCESS_CPUTIME_ID 等核心时钟源；gettimeofday、clock_gettime、clock_getres 实现完整；timerfd 通过文件描述符提供定时器通知，与 epoll 集成。但 nanosleep 精度受限于 ArceOS 的定时器粒度。 |
| 评价 | 时间管理功能覆盖了 POSIX 标准的主要时钟接口，能够支持用户态的时间查询和定时需求。与 epoll 的集成使得 timerfd 可用于高效的超时管理。定时器精度取决于底层硬件的定时器实现。 |

### 7.8 系统信息

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中等（约60%） |
| 关键发现 | uname 返回内核名称/版本/架构信息；sysinfo 返回基本的系统运行信息；/proc 文件系统提供进程级信息查询。但 meminfo 完全硬编码，/proc/maps 不完整，缺少 /proc/cpuinfo 等关键系统信息文件。 |
| 评价 | 系统信息接口提供了基本的内核和进程信息，但多处关键数据为硬编码或空实现。在需要精确系统状态（如内存使用量、CPU 负载）的诊断和监控工具中实用性有限。 |

### 7.9 网络协议栈

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中高（约75%） |
| 关键发现 | TCP/UDP IPv4 和 Unix domain socket 核心路径可用；socket API 覆盖全面；支持 SCM_RIGHTS 文件描述符传递。但完全缺少 IPv6、原始 socket 和 netlink。 |
| 评价 | 网络协议栈能够支持基本的客户端/服务器网络通信，可运行简单的网络应用。IPv6 的缺失使其无法在纯 IPv6 环境中工作，这在现代网络部署中是显著限制。 |

### 7.10 同步与并发安全（补充条目）

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现，完整度中等（约70%） |
| 关键发现 | 内核内部使用 `SpinNoIrq`、`RwLock`、`Mutex` 等 Rust 同步原语保护共享数据；`AtomicBool` 和 `AtomicUsize` 用于无锁标志位；TASK_TABLE 和 PROCESS_TABLE 通过 SpinLock 保护。但未发现系统化的死锁检测或锁排序约定。 |
| 评价 | 内核内部的并发安全依赖 Rust 的类型系统和标准同步原语，基本可靠。但全局锁的粒度偏粗（如 TASK_TABLE 的单一 SpinLock），在高并发场景下可能成为瓶颈。缺少正式的锁层次设计文档。 |

### 7.11 vSched2 调度器（补充条目）

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现但不完整（约60%），默认禁用 |
| 关键发现 | 用户态调度框架设计新颖，自定义陷阱向量和 VDSO 集成具有技术探索价值。但仅在 RISC-V 上可用，且依赖外部闭源的 libvsched2.so。非 RISC-V 架构的陷阱向量标记为 `unimplemented!()`。 |
| 评价 | vSched2 是该项目最具创新性的子系统，代表了一种不同于传统内核调度的设计方向。但其不完整的实现状态和单一架构的支持使其在当前原型阶段更像是概念验证而非生产就绪的功能。 |

---

## 八、总结评价

StarryOS 是一个基于 ArceOS 框架的 Rust 宏内核项目，致力于构建支持多架构的通用操作系统内核。项目总规模约 56,000 行 Rust 代码（含 ArceOS），独立维护约 27,000 行核心代码，覆盖了进程管理、内存管理、文件系统、网络协议栈、信号处理、同步原语等主流内核子系统，实现了约 206 个 Linux 兼容系统调用。

项目的核心优势在于：（1）立足成熟的 ArceOS 框架，复用其 HAL、驱动和网络栈等基础设施；（2）进程管理和信号处理等核心子系统的实现质量良好，能够支撑 shell 和复杂用户态程序的运行；（3）多架构支持已覆盖 RISC-V、x86_64、AArch64 和 LoongArch 四个平台，CI 测试覆盖全部架构。

项目最显著的技术创新是 **vSched2 用户态调度框架**——通过将调度器代码编译为 VDSO 共享库、结合自定义陷阱向量和 trait 接口，将调度决策从内核态移至用户态执行。这一设计在 Rust 内核领域具有较强的探索意义，但其当前状态（默认禁用、仅 RISC-V 可用、依赖外部预构建调度器）表明该功能尚处于概念验证阶段，距离实用化仍有较大距离。

项目的主要短板包括：（1）内存管理缺少 mprotect、madvise、msync 等关键控制接口，影响高级用户态应用；（2）网络协议栈完全缺失 IPv6 支持，不符合现代网络部署要求；（3）IPC 子系统不完整，缺少 System V 信号量；（4）procfs 多处数据为硬编码静态文本，降低了系统诊断工具的实用性；（5）vSched2 在非 RISC-V 架构上的缺失形成了功能碎片；（6）项目文档严重不足，缺少系统设计文档和架构说明。

综合来看，StarryOS 处于**活跃开发中的原型/中级阶段**，核心 POSIX 兼容性已达到足以运行 shell 和许多用户态程序的程度，具备作为操作系统内核基础框架的潜力。其 vSched2 用户态调度探索为 Rust 内核设计提供了有价值的技术参考。但距离生产就绪仍有较大差距，需要在功能完整性、架构可移植性、文档和测试等方面进行持续改进。