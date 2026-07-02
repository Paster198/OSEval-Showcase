# Kairix OS (Unicus) 技术画像与评估报告

## 1. 项目基本信息

- **项目名称**：Kairix OS / Unicus
- **核心理念**：自安全、多架构、Linux 兼容的宏内核
- **实现语言**：Rust（内核主体）、C（lwext4 库及用户态工具）
- **架构支持**：RISC-V 64（已验证）、LoongArch 64（已适配）、AArch64 / x86_64（有 HAL 实现）
- **内核类型**：宏内核（Monolithic kernel）
- **生态归属**：独立内核，目标为 Linux ABI 兼容，可运行为 musl/glibc 编译的用户程序
- **关键特点**：
  - 精心设计的多架构硬件抽象层（polyhal），支持 4 种 CPU 架构
  - 完整的内存管理子系统，包括 COW、KSM、交换与页面回收
  - 自包含的 TCP/IP 协议栈（以太网、ARP、IP、ICMP、TCP、UDP）
  - 面向 Linux 兼容的 150+ 系统调用，支持 signal、futex、clone3 等
  - 支持 Landlock 沙箱、fanotify/inotify、SysV 共享内存等进阶特性
  - 内嵌 ext4（基于 lwext4 C 库）、FAT32、tmpfs、devfs、procfs 等多文件系统

## 2. 子系统与功能概览

项目实现了以下核心子系统：

- **内存管理**：物理页帧分配（栈式）、内核堆（buddy allocator）、用户虚拟地址空间管理（VMSet/Area）、缺页处理（文件映射、COW、惰性分配、栈扩展）、内核同页合并（KSM）、页面缓存、页面回收、交换分区、mmap 匿名/文件映射
- **进程管理**：多进程（fork/exec/wait）、多线程（CLONE_THREAD）、POSIX 凭证（UID/GID）、进程组与会话、调度器（SCHED_NORMAL/FIFO/RR）、CPU 亲和性、延迟僵尸任务释放
- **同步原语**：SpinLock、SpinNoIrqLock、BlockingMutex（睡眠锁）、ReentrantLock、统一的 IrqGuard 机制
- **文件系统**：VFS 抽象（File/Inode/Dentry/SuperBlock），支持 ext4（读/写/创建/删除/目录/链接/xattr）、FAT32（基本读写）、tmpfs、devfs、procfs、sysfs、pipe、splice、sendfile
- **网络栈**：自研 TCP/IP 四层协议栈（Ethernet、ARP、IPv4（含分片重组）、ICMP、TCP（完整状态机）、UDP）、回环设备、路由表、邻居发现、VirtIO-net 驱动
- **Socket 层**：TCP/UDP/Raw/Unix 套接字，bind/listen/accept/connect/send/recv/shutdown
- **信号处理**：标准 POSIX 信号 1-31 及实时信号 32-64，支持自定义 handler、sigreturn、sigtimedwait、sigsuspend、SA_RESTART
- **时间管理**：clock_gettime/monotonic/realtime、定时器（timerfd）、 nanosleep、ITIMER
- **设备驱动**：VirtIO-blk、VirtIO-net（MMIO 与 PCI）、PCI 枚举
- **安全机制**：Landlock 规则集、fanotify 权限事件、inotify 监视、capabilities 检查骨架
- **其他**：io_uring 系统调用占位、BPF 占位、perf_event_open 骨架

详细功能清单可参考系统调用表（150+ 个系统调用，覆盖文件、进程、内存、网络、信号、futex、同步、时间、管道、共享内存、landlock、fanotify 等模块）。

## 3. 子系统实现完整度

以 Linux 内核对应子系统作为参照基准（100% 表示具备 Linux 级功能完整性），评估各子系统状况如下。注：百分比仅为参照指示，真实完整度需结合定性描述理解。

| 子系统 | 参考完整度 | 关键说明 |
|--------|------------|----------|
| **内存管理** | 75% | 缺 NUMA、透明大页、内存压缩、内核地址随机化等 |
| **进程 / 线程管理** | 80% | 无 SCHED_DEADLINE，cgroup 为骨架，无命名空间隔离 |
| **信号处理** | 70% | 未实现 core dump 生成 |
| **VFS 与文件系统抽象** | 75% | 缺文件锁（flock/fcntl）、ACL、notify_change |
| **ext4 支持** | 65% | 依赖 lwext4 C 库，日志回放能力有限，未支持加密/扩展属性全部 |
| **FAT32 支持** | 50% | 基本读写可用，未实现 exFAT，VFS 集成深度一般 |
| **tmpfs / devfs / procfs / sysfs** | 70% | 覆盖主要节点，部分统计文件返回固定值 |
| **网络协议栈** | 60% | 无 IPv6、TCP 拥塞控制简化、无 SACK/窗口缩放 |
| **Socket 层** | 65% | 不支持 SCTP/DCCP，Unix socket 为占位实现 |
| **同步原语** | 85% | 无 RCU/SEQLOCK 等无锁同步机制 |
| **设备驱动** | 50% | 仅支持 virtio 设备，缺少 USB/SATA/NVMe/显卡等 |
| **Landlock** | 60% | ABI v6 路径 + 网络规则，scoped 规则部分实现 |
| **io_uring / BPF** | <10% | 仅系统调用号占位 |
| **整体内核** | **约 65%** | 加权平均，考虑代码量与功能重要性 |

## 4. 各子系统优缺点与实现细节

### 4.1 内存管理

**实现细节**：
- 物理页帧采用栈式分配器，支持连续页分配与回收栈复用，通过 `alloc_ppn_with_reclaim` 在分配失败时触发页面回收。
- 虚拟地址空间由 `UserVMSet` + `UserMapArea` 管理，支持多种区域类型（ELF 段、堆、栈、mmap、共享内存、trap 上下文等），完整实现了 COW、惰性分配、文件映射缺页、栈自动扩展。
- 实现 KSM（内核同页合并）：对匿名映射页面扫描、哈希分组、合并为共享只读页，写时通过 COW 分离，并提供 `/proc/sys/kernel/ksm/` 接口进行参数调优。
- 页面缓存统一处理磁盘文件系统和 tmpfs，区分脏页，结合交换机制实现页换出/换入（交换文件 `.kairix_swap`，128MB）。
- 回收策略基于低/高水位线（64MB/128MB），并在系统调用返回路径轮询回收，写回队列实现延迟批处理。

**优点**：
- 高级特性丰富，KSM 和交换在同类竞赛内核中极为突出。
- 缺页处理路径覆盖多种场景，与文件系统、信号机制深度集成。
- 回收与写回机制形成了闭环的内存压力处理体系。

**缺点**：
- 页面回收触发条件较为简单，尚未实现精细的 LRU 链表，回收目标选择可能不够高效。
- 交换空间大小固定，无动态扩展能力。
- KSM 扫描开销目前仅通过休眠时间粗略控制，缺乏自适应节流。

### 4.2 进程管理

**实现细节**：
- PCB 包含完整的 POSIX 凭证、资源限制、信号处理表、文件描述符表、Landlock 域等；线程通过 `CLONE_THREAD` 共享进程地址空间和文件表。
- 调度器基于每 CPU 的 FIFO 就绪队列，支持 `SCHED_NORMAL`、`SCHED_FIFO`、`SCHED_RR` 三种策略和 0-99 优先级。
- `CLONE_VFORK` 通过父任务阻塞在 `vfork_parent` 直至子进程 exec/exit 唤醒。
- 延迟僵尸任务释放 (`DEFERRED_EXITED_TASKS`) 避免了在持有全局锁时 drop 复杂对象可能导致的死锁。

**优点**：
- 进程/线程模型完整，CLONE 标志覆盖广泛（CLONE_THREAD、CLONE_VFORK、CLONE_VM、CLONE_FS、CLONE_FILES 等），Linux 兼容性强。
- 调度器设计简洁，支持实时策略。
- 延迟释放机制体现了工程细致度。

**缺点**：
- 无跨 CPU 负载均衡，多核环境下可能造成 CPU 闲置或任务堆积。
- cgroup 仅为骨架，资源隔离和统计能力有限。
- 缺少 SCHED_DEADLINE 和全功能 CFS/EEVDF 调度类。

### 4.3 文件系统

**实现细节**：
- VFS 定义 `File`、`Inode`、`Dentry`、`SuperBlock` 等核心 trait，通过 trait 对象实现多文件系统挂载。
- ext4 通过 Rust FFI 绑定封装 lwext4 C 库，使用时需获取全局递归锁以保证线程安全；基本文件操作、目录、重命名、链接、xattr 均已支持。
- FAT32 基于 vendored fatfs crate，提供基础的读写和目录遍历。
- tmpfs 为纯内存实现，深度集成页面缓存和交换，支持从交换区恢复页面。
- devfs、procfs、sysfs 提供 `/dev`、`/proc` 关键节点，例如 `meminfo`、`mounts`、`ksm` 等。
- 管道支持环形缓冲区和阻塞/非阻塞模式，支持原子写入和 SIGPIPE 通知，并可通过 splice 零拷贝传输。
- 实现 inotify 和 fanotify（含权限事件），可通过 `fanotify_check_permission_dentry` 干预文件访问。

**优点**：
- VFS 层次清晰，易于扩展新的文件系统。
- 通过内嵌 lwext4 获得了较成熟的 ext4 支持。
- fanotify 权限事件为安全应用提供了基础。

**缺点**：
- ext4 依赖外部 C 库且需要全局锁，可能成为并发瓶颈；日志回放和崩溃恢复能力未充分验证。
- FAT32 实现完整度较低，缺少 exFAT 支持，无法替换外部存储的主流需求。
- 缺少文件锁和健全的 POSIX ACL 支持。
- 写回队列批处理虽好，但未与磁盘 I/O 调度结合。

### 4.4 网络栈

**实现细节**：
- 自研协议栈：从以太网帧解析开始，向上构建 ARP、IPv4（含分片重组）、ICMP、TCP、UDP。
- TCP 实现包含 SYN/ESTABLISHED/LAST_ACK 等状态，支持 MSS 分段、校验和、序列号和确认号处理，但拥塞控制仅为基础实现。
- 网络设备驱动支持 VirtIO-net MMIO 和 PCI 两种传输方式。
- ARP 表查询和待发送队列挂起机制确保异步发送的正确顺序。

**优点**：
- 自行实现的完整四层协议栈，内核不依赖外部网络库，控制度高。
- 与 Socket 层和 epoll/poll 机制良好集成。

**缺点**：
- 缺失 IPv6 支持，在现代网络场景中受限。
- TCP 实现缺少窗口缩放、SACK、快速重传/快速恢复等性能优化，高带宽/高延迟下效率不佳。
- 路由功能极简，不支持策略路由或动态路由协议。

### 4.5 同步原语

**实现细节**：
- 基于 `MutexSupport` trait 统一了锁行为，提供 `SpinLock`、`SpinNoIrqLock`（关中断）、`BlockingMutex`（睡眠锁）、`ReentrantLock`。
- `IrqGuard` RAII 结构在构造时保存中断状态并禁用，析构时恢复，保证中断安全。
- 睡眠锁在锁竞争时调用 `block_current_and_run_next()` 主动让出 CPU，避免忙等浪费。

**优点**：
- 锁类型丰富，满足不同场景需求（中断上下文、长临界区、可重入）。
- 中断屏蔽与锁获取绑定为单一类型，减少错误使用风险。

**缺点**：
- 缺少 RCU、seqlock 等无锁同步机制，无法高效支持读多写少的场景。
- 睡眠锁使用 BTreeMap 管理等待队列，唤醒复杂度为 O(log n)。

### 4.6 资源管理

此处主要指文件描述符、内存限制、进程数等资源的管理。

**实现细节**：
- 文件描述符表为 `Vec<Option<Arc<dyn File>>>` 带索引分配，支持 `FD_CLOEXEC` 标志。
- 资源限制通过 `rlimit_fsize`、`rlimit_nofile` 体现，但其他 rlimit 类型（CPU、AS、core 等）未被完整处理。
- PID 使用位图分配，最大进程数受内核常量限制。
- 页面缓存和 dentry 缓存均有容量上限并实现主动淘汰。

**优点**：
- 基本资源管理机制完整，文件描述符表和 dentry 缓存有界限控制。
- 内核在内存压力下能够回收页面缓存和 dentry。

**缺点**：
- rlimit 支持不全面，缺少对核心数量和内存使用的有效限制。
- 没有配额或命名空间隔离机制。

### 4.7 时间管理

**实现细节**：
- 基于硬件定时器（RISC-V mtime/LoongArch 定时器）实现时钟中断。
- 支持 `clock_gettime`（CLOCK_REALTIME/MONOTONIC 等）、`clock_nanosleep`、`timerfd_create/settime/gettime`、`settimeofday`。
- 定时器队列使用 BTreeMap 按超时排序，在每次定时器中断时检查并唤醒到期任务。

**优点**：
- 提供了基本的 POSIX 时间接口，可满足多数应用需求。

**缺点**：
- 缺少高精度定时器（hrtimer）和定时器分辨率精细控制。
- RTC 支持仅骨架，未实质读取硬件实时时钟。

### 4.8 系统信息

主要涉及 `/proc` 文件系统提供的系统信息接口。

**实现细节**：
- procfs 实现 `status`、`maps`、`smaps`、`meminfo`、`mounts`、`cgroups`、`fd`、`pagemap` 等伪文件，动态生成内容。
- `uname` 系统调用返回内核名称、版本和架构信息。
- `sysinfo` 提供内存总量/可用量、进程数等信息。

**优点**：
- procfs 覆盖面较好，能够支持 `ps`、`top` 等基础工具的部分功能。

**缺点**：
- 一部分统计信息返回硬编码常量（如 CPU 信息），缺乏真实硬件数据支撑。
- 缺少 `/sys` 的完整实现（仅块设备部分）。

## 5. 动态测试情况

### 5.1 构建测试

- 内核（`riscv64gc-unknown-none-elf`）成功编译，释放模式生成 ~7.4 MB ELF 二进制。
- mkfs 工具链（基于 e2fsprogs 1.47.0）通过 RISC-V 交叉编译工具链成功构建。
- 34 个用户态测试程序（包括 initproc、shell、ping、tcp_test 等）成功编译为 RISC-V ELF。
- 因缺少 LoongArch 交叉编译器，LoongArch 架构未实际构建测试。

### 5.2 运行测试（QEMU RISC-V virt）

使用 OpenSBI + 内核 `os.bin` 直接启动，参数：1GB 内存、2 个 CPU、VirtIO-net 设备。

**启动流程与结果**：
1. OpenSBI v1.3 正确初始化所有 HART。
2. 平台物理内存区域探测成功（0x80000000-0xc0000000）。
3. 内存初始化（堆分配器、页帧分配器）正确识别可用区域。
4. 内核页表映射完成，跳转至高虚拟地址执行。
5. 中断/陷阱矢量安装成功。
6. 网络子系统初始化成功，VirtIO-net 设备探测通过，分配 IP 10.0.2.15。
7. CPU 多核初始化、文件系统初始化、交换分区初始化依次通过。
8. 在尝试创建 VirtIO-blk 设备时，因未连接磁盘镜像（SD 卡），返回设备 ID 为 0，触发预期 panic：`MmioTransport creation failed: ZeroDeviceId`。

**评价**：
完整的启动路径表明内核的基础设施（引导、内存、中断、网络）可以正常工作。panic 是由于测试环境未提供块设备镜像所致，并非内核缺陷。由此推断，在提供正确块设备镜像后，文件系统挂载和用户态 initproc 启动流程应该能够继续。

### 5.3 未执行的测试

- 未运行用户态程序的功能测试（如 shell 交互、网络通信、文件 I/O 基准）。
- 未进行压力测试或并发正确性测试。
- LoongArch、AArch64、x86_64 的启动测试受限于环境和时间，未执行。

## 6. 细则评价表格

| 条目 | 是否实现 | 完整性评价 | 关键发现 | 评价 |
|------|----------|------------|----------|------|
| **内存管理** | 是 | 高（约 75%） | 拥有 KSM、交换、页面回收等高级特性，缺页处理路径覆盖广 | 在竞赛内核中功能突出，形成较完整的虚拟内存管理体系 |
| **进程管理** | 是 | 较高（约 80%） | 多线程支持良好，CLONE 系列标志与 Linux 高度兼容，调度器支持实时策略 | 缺少负载均衡和资源隔离，但在应用启动和管理方面完备 |
| **文件系统** | 是 | 中高（约 70%） | VFS 设计清晰，集成 ext4（C 库）和多种内存文件系统，支持通知机制 | 功能性较全，但 ext4 依赖 C 库带来并发瓶颈，部分 POSIX 语义缺失 |
| **交互设计** | 部分 | 中等 | 提供了 shell 和基础用户态工具，但缺乏高级调试接口 | 面向开发者，交互以串口为主，无图形或窗口系统 |
| **同步原语** | 是 | 高（约 85%） | 四种锁类型覆盖不同场景，中断安全锁设计严谨，睡眠锁避免忙等 | 缺少 RCU，但现有实现满足内核同步需求 |
| **资源管理** | 部分 | 中低 | 文件描述符和内存缓存有限制，但 rlimit 等资源限制不完整 | 基础管理存在，但尚未达到多租户安全隔离级别 |
| **时间管理** | 是 | 中等 | 支持常用 POSIX 时钟接口和定时器，但缺少高精度定时器框架 | 基本可用，精细度不足 |
| **系统信息** | 是 | 中高 | procfs 覆盖常用伪文件，sysinfo/uname 可用，但部分数据为硬编码 | 可辅助运维，但动态数据精度需加强 |
| **网络协议栈** | 是 | 中高（约 60%） | 自研四层协议栈，支持基础 TCP/UDP 通信，但缺 IPv6 和高级 TCP 特性 | 展现了全栈能力，实用性受限于协议覆盖和性能优化 |
| **信号处理** | 是 | 较高（约 70%） | 支持标准信号和实时信号，自定义 handler 和 sigreturn 流程正确 | 功能完整，欠缺 core dump，但足以处理常见信号场景 |
| **安全机制** | 是 | 中高 | 实现了 Landlock ABI v6 和 fanotify 权限事件，能力集检查骨架化 | 体现了对安全的重视，Landlock 集成度高，但整体防护仍需加强 |

## 7. 总结评价

Kairix OS 是一个功能覆盖面广、架构设计成熟的 Rust 宏内核项目。其对多架构的抽象（polyhal）与 Linux 兼容性的追求贯穿始终，在内存管理（KSM、交换、回收）、文件系统扩展、自研网络栈、高级安全接口等方面均展现了超出一般竞赛内核的实现深度。动态测试验证了内核从引导至设备探测的关键路径，表明项目已具备在 QEMU 环境中进一步运行用户态程序的基础。

主要优势在于：子系统的完整性、Rust 带来的内存安全加持、对 Linux ABI 的精细复刻，以及多项进阶特性（KSM、Landlock、fanotify）的落地。主要不足集中在：网络协议栈的深度与性能、设备驱动生态的薄弱、部分 POSIX 语义（如文件锁、全面 rlimit）的缺失，以及多核调度优化空间。

整体完整度约可达 Linux 级功能的 65%，在同类项目中处于前列。该项目适合作为研究现代化内核设计、Rust 语言内核实践、以及 Linux 兼容层构建的优秀参考实现。