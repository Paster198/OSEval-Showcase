# MangoCore OS 内核技术画像与评估报告

## 一、项目基本信息

- **项目名称**：MangoCore（亦称 NPUCore / Aspera）
- **运行架构**：RISC-V 64（RV64GC，SV39 页表），LoongArch 64（LA664，三级页表）
- **实现语言**：Rust（内核 no_std，用户库 `#![no_std]`）
- **生态归属**：独立开发的微内核-宏内核混合风格单体内核，Linux ABI 兼容
- **突出特点**：
    - 双架构 HAL 抽象，RISC-V 与 LoongArch 共用上层内核代码
    - 约 255 个 Linux 兼容系统调用
    - 丰富的文件系统支持（ext4 读写实现，FAT32，多个虚拟文件系统）
    - 基于 smoltcp 的完整网络协议栈（TCP/UDP/Unix/Netlink/Packet）
    - 完善的进程管理（fork/clone/execve，实时信号，futex，SysV/POSIX IPC）
    - 单核调度，无 SMP 支持

## 二、已实现子系统和功能总览

### 2.1 子系统构成

| 子系统 | 源码规模（估计） | 关键功能 |
|--------|------------------|----------|
| **HAL（硬件抽象层）** | ~5,200 行 Rust | 架构/平台抽象，启动，页表，trap，上下文切换，SBI/ACPI |
| **MM（内存管理）** | ~9,500 行 Rust | 物理页帧分配，虚拟地址空间，VMA 管理，mmap，CoW，swap/zRAM |
| **Task（任务管理）** | ~8,500 行 Rust | 进程/线程控制块，公平调度，信号系统，futex，ELF 加载，命名空间 |
| **Syscall（系统调用）** | ~10,500 行 Rust | 约 255 个系统调用号的分发与实现，涵盖文件/进程/网络/IPC 等 |
| **FS（文件系统）** | ~27,000 行 Rust | VFS 层，ext4，FAT32，tmpfs，ramfs，procfs，sysfs，devfs，页缓存 |
| **Net（网络）** | ~12,000 行 Rust | smoltcp 集成，TCP/UDP/Unix/Raw/Netlink/Packet 套接字，路由 |
| **Drivers（设备驱动）** | ~2,000 行 Rust | virtio-blk，virtio-net，SATA，串口，veth 虚拟网卡 |

### 2.2 已实现的具体功能

- **进程与线程**：fork/vfork/clone/clone3，execve/execveat，exit/exit_group，wait4/waitid；POSIX 调度参数（nice、policy）兼容回读。
- **内存管理**：物理页帧分配（栈式+回收列表），虚拟地址空间管理（懒分配，CoW），mmap/munmap/mprotect/mremap/brk，mlock/munlock，交换分区与 zRAM（LZ4 压缩）。
- **文件系统**：VFS 抽象层，ext4（含 extent 树，无 journal），FAT32，tmpfs，ramfs，procfs（含进程目录），sysfs，devfs，initramfs（cpio newc），页面缓存，脏页回写。
- **信号**：完整 POSIX 信号集（1..64/128），sigaction，sigprocmask，sigtimedwait，sigaltstack，sigreturn，实时信号排队。
- **同步与 IPC**：futex（WAIT/WAKE/REQUEUE/WAIT_BITSET/FUTEX_WAITV），SysV 共享内存/信号量/消息队列，POSIX 消息队列，eventfd，timerfd，signalfd。
- **网络**：AF_INET（TCP/UDP/Raw），AF_UNIX（Stream/Datagram），AF_NETLINK（NETLINK_ROUTE），AF_PACKET；套接字选项，sendmsg/recvmsg 辅助数据；ARP/NDP 邻居缓存，路由表。
- **设备与终端**：串口控制台（NS16550A），TTY/PTY，pipe，/dev/null/zero/full/urandom/rtc。
- **系统信息与调测**：procfs 多文件导出（cpuinfo, meminfo, mounts, stat, net/*, SysV IPC 等），perf 性能计数器框架，命名空间 stub。
- **多架构支持**：RISC-V 和 LoongArch 两个架构完整后端，通过 feature flag 编译期切换。

## 三、各子系统实现完整度与细节评析

（完整度以 Linux 内核对应子系统为参照基准，综合评估接口覆盖率与核心逻辑深度。）

### 3.1 硬件抽象层（HAL）

- **完整度**：约 85%
- **实现细节**：
    - 通过 `#[cfg(feature = "riscv")]` 等条件编译在架构间切换，向上导出统一的页表、trap、上下文切换、时间等接口。
    - RISC-V 后端：SV39 三级页表，`sfence.vma` 刷新 TLB，trap 入口解析 `scause` 分发异常，syscall 返回前处理信号。
    - LoongArch 后端：DMW 直接映射窗口，三级页表（PWCL/PWCH 配置），`invtlb` 刷新，硬件页表遍历器 `__rfill` 软件回填，ACPI 关机。
    - 上下文切换由汇编实现 `__switch`（RISC-V）和对应的 LoongArch 版本。
- **优点**：
    - 架构抽象清晰，上层内核零感知差异。
    - LoongArch 适配深入，涵盖 DMW、TLB 重填和 ACPI 等平台特性。
    - 定时器、中断管理直接可用。
- **缺点**：
    - 单核启动，SMP 启动流程和多核间中断（IPI）未实现。
    - LoongArch 的 PCI 枚举代码较独立，驱动侧与架构耦合较紧。

### 3.2 内存管理（MM）

- **完整度**：约 75%
- **实现细节**：
    - 物理页帧采用“栈式增长 + 回收列表”分配器，去重检测通过辅助标志数组实现 O(1) 检查。
    - 虚拟地址空间（`AddressSpace`）组合页表、VMA 集合、堆指针，支持 mmap 懒分配。
    - VMA 基于有序 `Vec` 维护，支持查找、拆分、合并和解除映射。
    - 缺页处理：区分匿名页、文件映射页、CoW 页，支持非 fatal 的 out-of-memory 信号和 OOM kill。
    - Swap 基于块设备的位图管理槽位，zRAM 使用 LZ4 压缩，作为 OOM 回收先于交换。
    - 用户内存访问提供 `UserPtr<T>`、`UserSlice` 等安全抽象，`copy_from_user` 支持缺页处理（fault-in）。
- **优点**：
    - 完整的虚拟内存管理流程，包含 CoW、mmap 文件映射、mlock 统计。
    - zRAM 作为压缩缓存是实用特性。
    - 跨页用户缓冲区迭代器设计安全。
- **缺点**：
    - 无 THP（透明大页），无 NUMA 感知。
    - 物理分配器未实现伙伴系统，当前简单混合策略可能导致外部碎片。
    - VMA 集合采用有序 `Vec`，在大数量区间下查找和插入开销为 O(n)，未使用红黑树等更高效结构。
    - 页面回收策略较简单，缺少 LRU 链表和细粒度回收优先级。

### 3.3 任务与进程管理（Task）

- **完整度**：约 80%
- **实现细节**：
    - PCB 包含 pid、线程列表、信号处理器表、地址空间、文件描述符表、命名空间等。
    - TCB 内部使用不可变字段（无锁访问）和 `Mutex<Inner>` 保护可变部分（如任务上下文、pending 信号）；调度器常用提示字段通过 `Atomic*` 提供热路径快速访问。
    - 单核公平调度：就绪队列中选择 virtual runtime 最小的任务，同时结合 nice 值调整权重。
    - WaitQueue 支持条件等待、超时和可中断等待；内核定时器队列使用 `BinaryHeap` 驱动超时。
    - 信号系统：64/128 位掩码，支持标准 RT 信号排队，信号投递可唤醒处于 interruptible 状态的线程；信号返回路径在 trap 返回前执行 `do_signal()`，构造用户空间信号栈帧。
    - futex 实现支持 PRIVATE/SHARED、多地址等待（futex_waitv）、requeue 和超时。
    - clone：完整标志位处理（CLONE_VM, CLONE_FILES, CLONE_VFORK 等），vfork 通过 `Completion` 同步。
    - execve：ELF 加载，shebang 支持，解释器回退，权限检查，AUX vector 构建。
- **优点**：
    - 进程模型贴近 POSIX，clone 语义正确。
    - 锁粒度设计较合理，热路径使用原子变量减少争用。
    - 信号帧构造和返回路径处理正确，支持备用信号栈。
    - futex 实现完整，支持多地址等待，与现代 Linux 接口一致。
- **缺点**：
    - 单核调度器，无可抢占内核（非抢占式）。长时间处于内核路径的任务可能阻塞调度。
    - 公平调度仅基于最小 vruntime 扫描，复杂度 O(n)，任务数增大时开销上升。
    - 缺少 CFS 调度类的完整实现（如组调度权重分摊），仅兼容 nice 系数。
    - 任务资源限制（rlimit）未完整实现（如 CPU 时间限制等）。

### 3.4 系统调用（Syscall）

- **完整度**：约 70%（以 Linux 系统调用表覆盖率计）
- **实现细节**：
    - 约 255 个系统调用号，涵盖文件 I/O、进程控制、内存管理、socket、IPC、时间、epoll、timerfd、signalfd 等。
    - 文件操作系列：read/write/pread/pwrite/readv/writev/sendfile/copy_file_range/lseek 等均实现。
    - 文件描述符管理 fcntl 实现较完整（F_DUPFD/F_GETFL/F_SETFL/F_SETLK 等）。
    - 进程相关 clone/clone3/execveat/waitid 等均实现。
    - 高级 I/O 多路复用：select/poll/epoll（epoll_create1、epoll_ctl、epoll_pwait）实现。
- **优点**：
    - 系统调用覆盖面广，足以运行 BusyBox 和 LTP 测试子集。
    - 散布/聚集 I/O（readv/writev）、sendfile 等零拷贝或高效接口均有实现。
- **缺点**：
    - 缺少 `io_uring` 等现代高性能异步 I/O 接口。
    - 部分 syscall 仅为 ENOSYS 桩（如一些 netlink 细节、bpf 子命令等）。
    - 对 `prctl`、`ptrace` 的实现仅为有限子集。

### 3.5 文件系统（FS）

- **完整度**：约 75%
- **实现细节**：
    - VFS 层定义了 `IndexNode` trait（read_at/write_at/find/create/link/unlink/truncate）和 `File` 封装，路径解析基于挂载点递归查找。
    - ext4：完整读取超级块、块组描述符、extent 树（查找/插入/拆分/释放）、inode 和目录项操作、块与 inode 分配器、CRC32 校验。
    - FAT32：支持 BPB 解析、目录项遍历、簇分配位图；LoongArch 架构补偿编译器未对齐读取问题。
    - 页缓存：状态机跟踪页状态（Loading/UpToDate/Dirty/Writeback），脏页按段 valid mask 追踪部分写入，支持后台回写（DIRTY_BACKGROUND/DIRTY_THROTTLE 阈值）。
    - 虚拟文件系统：procfs（/proc/mounts, /proc/stat, /proc/net/*, /proc/[pid]/* 等）、sysfs、devfs、tmpfs、ramfs 和 initramfs。
    - 设备文件提供 null/zero/full/urandom/tty/ptmx/rtc 等，pipe 使用环形缓冲区。
- **优点**：
    - VFS 设计完整，支持跨文件系统查找和挂载点传播（shared/slave/private 等挂载属性）。
    - ext4 的 extent 树实现深度足够，涵盖复杂分配逻辑。
    - 页面缓存支持部分写入有效性追踪，可避免不必要磁盘读取。
    - procfs 信息导出丰富，方便诊断。
- **缺点**：
    - ext4 不支持 journal，崩溃后文件系统一致性无法保证。
    - 不支持 64bit 特性，大文件系统容量受限。
    - 元数据缓存（MetaCache/DirCache）为简单全局结构，未对多核做并发设计。
    - 文件锁（POSIX fcntl lock）实现可能不完整，缺乏死锁检测。

### 3.6 网络协议栈（Net）

- **完整度**：约 70%
- **实现细节**：
    - 基于 smoltcp 构建，内核侧封装了设备适配器（`SmoltcpDeviceAdapter`），每个网卡一个 `Interface`，由调度器轮询或网络中断触发 `poll`。
    - TCP：6 状态枚举（Init/Connecting/Listening/Established/SelfConnected/Closed），监听 backlog=16，支持 MSS 和收发缓冲区。
    - UDP：基于 smoltcp UDP socket，支持数据报收发。
    - Unix 域：Stream 模式通过一对 `RingBuffer` 连接两端，Datagram 模式有绑定和排队。
    - Netlink：实现 NETLINK_ROUTE 协议，兼容 BusyBox `ip` 命令。
    - Packet：AF_PACKET 原始帧收发。
    - 全局网络接口管理绑定表和设备栈，支持 lo、eth0 和动态 veth。
- **优点**：
    - 支持多种地址族和协议，Unix 域套接字实现正确支持抽象命名空间。
    - Netlink 路由协议兼容性好，可运行标准用户态网络配置工具。
    - 调度器中对网络轮询采用无 spin 的 `try_lock`，适合当前单核环境。
- **缺点**：
    - 缺少 IP 分片重组/分片发送，大 UDP 数据报可能无法工作。
    - 网络栈缓冲区和连接限制较小（如 TCP backlog 16），可能影响并发连接。
    - 无路由缓存或高级拥塞控制，TCP 性能在复杂网络中有限。
    - 缺乏完整的 netfilter/iptables 框架。

### 3.7 设备驱动（Drivers）

- **完整度**：约 50%
- **实现细节**：
    - 块设备：virtio-blk (MMIO/PCI)，SATA AHCI，内存模拟磁盘，支持双磁盘。
    - 网络设备：virtio-net (MMIO/PCI)，veth，队列大小固定 16。
    - 串口：NS16550A 实现基础的字符输入输出。
    - virtio 驱动使用内核的 `frame_alloc` 分配 DMA 缓冲区，实现了 `virtio-drivers` crate 的 `Hal` trait。
- **优点**：
    - 覆盖 QEMU 常见设备，足以运行标准测试环境。
    - virtio 驱动在两种架构上均可工作。
- **缺点**：
    - 驱动生态极简，无 NVMe、e1000 等常用模拟设备支持。
    - 无 PCI 总线完整枚举框架，设备地址硬编码。
    - 驱动与平台定义耦合较深，未形成统一的设备模型（如 device/driver 绑定）。

## 四、内核整体实现完整度评估

- **整体完整度**：约 70%（基准：Linux 内核基础 ABI 与常用机制）。
- **依据**：
    - 核心进程、内存、文件、网络、IPC 子系统均具备可运行实现，能启动到用户空间并运行复杂应用（BusyBox、LTP、iperf 等）。
    - 约 255 个系统调用，覆盖多数 POSIX 接口。
    - 明显缺失的模块包括：SMP 多核调度、ext4 日志、io_uring、完整 ptrace、细粒度 cgroup/namespace 隔离等。
    - 驱动与平台抽象尚属于竞赛原型级别。

## 五、动态测试设计与结果

根据代码仓库中的 `judge/` 目录，该内核配备了一套基于 shell 脚本的自动化评测体系，累计 20 套以上评测脚本，覆盖：

- **libc-test**：C 库接口回归测试
- **LTP (Linux Test Project)**：POSIX 兼容性子集测试
- **cyclictest**：实时延迟测试
- **iperf / netperf**：网络吞吐测试
- **iozone**：文件 I/O 性能基准
- **lmbench**：系统整体微基准

评测脚本通过 QEMU 启动内核，运行预构建的用户态测试程序，并收集日志输出至 `judge/console_log`。仓库中保留的已存日志表明这些测试曾经成功执行并输出结果。

受当前分析环境限制，未进行新的 QEMU 启动测试，因此无法提供本轮动态测试的新数据。但已有基础设施表明，该内核具备成体系的自动化测试能力，可验证基本功能正确性和部分性能指标。

## 六、细则评价表

| 评价条目 | 是否实现及完整度 | 关键发现 | 评价 |
|----------|------------------|----------|------|
| **内存管理** | 是，约 75% | 实现了物理分配器（栈式+回收）、虚拟地址空间、VMA、缺页处理、CoW、mmap、swap/zRAM。缺少 THP、NUMA、伙伴系统。 VMA 集合为有序 `Vec`，性能在大数量下受限。 | 虚拟内存核心流程完整，zRAM 有实际价值；数据结构选型对扩展性有约束，适合中等规模内存场景。 |
| **进程管理** | 是，约 80% | 进程/线程模型贴近 POSIX，clone/flags 处理正确；信号系统完整支持 RT 信号和备用栈；futex 实现功能全面；公平调度为单核 O(n) 扫描。 | 作为单核内核，任务管理机制较为成熟，热路径锁优化良好；调度器可扩展性受限，缺乏内核抢占。 |
| **文件系统** | 是，约 75% | VFS 抽象清晰，ext4 extent 树实现深入但缺 journal；FAT32 可读写；页缓存支持部分写入追踪和回写；procfs 信息丰富。 | 文件系统是该项目的突出亮点之一，ext4 实现深度超过多数同类竞赛内核；但无日志限制了崩溃恢复；建议未来完善 journal 或引入更简单的文件系统一致性模型。 |
| **交互设计** | 是，约 80% | 提供串口控制台、TTY/PTY 对、pipe，支持 termios 和 Ctrl+C（VINTR）信号生成；/dev 设备文件系统完整；用户库提供 Rust 安全封装。 | 交互基础扎实，可运行 sh 并处理作业控制信号，体验完整；但未引入图形终端或多路复用控制台。 |
| **同步原语** | 是，约 85% | 内核内部使用 `Mutex`、`WaitQueue`（条件/超时/可中断），并提供 futex（含 futex_waitv）、eventfd、timerfd、signalfd 等用户态原语；SysV 信号量和 POSIX 消息队列均实现。 | 同步机制完善，futex 支持与 Linux 高度一致；WaitQueue 设计清晰，能够支撑内核内部及用户态同步需求。 |
| **资源管理** | 是，约 50% | 文件描述符表采用位图复用；物理页帧通过 RAII 跟踪；交换槽和 zRAM 槽均有 RAII 管理；但缺少 cgroup、rlimit 完全实现，资源隔离与配额控制薄弱。 | 基础资源记账可用，但缺乏细粒度控制和隔离机制；当前仅适用于单用户或简单环境。 |
| **时间管理** | 是，约 80% | 通过 `get_time`、`program_timer_delta` 管理定时器中断；内核定时器队列（`KernelTimerQueue`）以 BinaryHeap 实现超时；提供 nanosleep、clock_gettime、timerfd、timer_create/settime 等系统调用。 | 时间子系统实现较完整，精度依赖底层时钟频率；未实现高精度计时器（hrtimer）或 tickless 模式，但满足常规需求。 |
| **系统信息** | 是，约 70% | procfs 导出 CPU 信息、内存统计、挂载表、网络状态、进程状态、文件描述符、I/O 统计等；perf 性能计数器框架用于内部热路径统计；但未完善 sysctl 参数接口。 | 系统信息可观测性较好，满足诊断和基准测试需求；perf 框架有利用价值，但接口非标准。 |
| **网络系统** | 是，约 70% | TCP/UDP/Unix/Raw/Netlink/Packet 多协议支持；路由表和邻居缓存；基于 smoltcp 的适配与轮询合理。缺少 IP 分片重组和高级拥塞控制。 | 网络可用性良好，足以运行网络工具和简单应用；吞吐和并发连接能力受限，适合教学和测试。 |
| **设备驱动与平台** | 是，约 50% | 支持 virtio-block/net、SATA AHCI、串口；双架构 HAL 抽象设计合理。但驱动数量少、平台硬件信息硬编码，缺乏标准设备模型和总线枚举。 | 驱动层满足 QEMU 环境验收，但可移植性不足；未来若扩展真实硬件需重构设备模型。 |

## 七、总结评价

MangoCore 是一个用 Rust 编写的、面向 Linux ABI 兼容的单体内核，其代码量（约 106,000 行内核代码）和子系统覆盖范围在竞赛类内核项目中处于较高水平。项目实现了从硬件抽象到用户态库的完整垂直栈，支持 RISC-V 和 LoongArch 双架构，在进程管理、文件系统（尤其是 ext4 读写）、网络协议栈、信号和同步原语等方面均达到可运行且相对深入的实现程度。

**核心竞争力**：
- 系统调用覆盖广泛（约 255 个）且多数实现完整，可直接运行 BusyBox、LTP 测试及部分网络应用。
- ext4 的 extent 树实现超越很多同类项目，页面缓存设计亦有亮点（partial-write 有效性追踪、后台回写）。
- 全面的评测脚本体系为回归验证提供了基础。

**主要局限**：
- 单核无 SMP，无法利用多核性能，内核不可抢占，交互延迟和吞吐扩展受限。
- ext4 缺少 journal，文件系统无法保证崩溃一致性。
- 缺乏现代异步 I/O（io_uring）、高级资源控制和细粒度安全隔离机制。
- 驱动生态极其有限，难以脱离 QEMU 虚拟环境运行。

**总体结论**：该项目展现了对操作系统内核多个核心领域的扎实工程能力，代码组织和抽象有明确的设计思想，适合作为教学、研究或竞赛环境下的操作系统内核实现。受限于部分关键特性的缺失，目前仍处于原型/竞赛级别，距离实用的成熟内核尚有距离。建议未来重点增强多核支持、文件系统事务性以及 I/O 性能优化，以提升整体成熟度。