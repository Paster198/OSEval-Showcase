# 对比分析报告

## 对比项目概述

本报告将 Project Aurora 与 4 个已分析的同赛道操作系统内核项目（ZeroOS、StarryOS、TOYOS、OSakura）进行多维度对比分析。KeepOnOS（T202410055992606-3389）因在当前工作区中未检索到该项目仓库与报告，无法纳入本次对比。

---

## 一、项目基础信息总览

| 维度 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| **语言** | Rust | Rust | Rust | C | C |
| **生态框架** | ArceOS（深度自研） | ArceOS/Starry | ArceOS | 无（独立） | 无（独立） |
| **架构** | riscv64 | riscv64 | riscv64/x86_64/aarch64/loongarch64 | riscv64 | riscv64 |
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **代码规模** | ~20,686 行 | ~61,441 行 | 大型（4370个 .rs 文件） | 中等（139个 .c/.h/.S 文件） | ~9,633 行 |
| **系统调用数** | 92 | 101 | 100+ | 55 | 60 |
| **多核支持** | 无 | 有（SMP） | 有（SMP） | 代码存在但禁用 | 代码存在但禁用 |

---

## 二、架构设计对比

| 维度 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| **分层方式** | 扁平化（12个模块文件） | Workspace 约50个 crate | 多层 crate 架构 | 传统分层（kernel/include/fs/mm） | 传统分层（kernel/include/fs/mm） |
| **模块化程度** | 中（单文件模块） | 高（crate 级模块化） | 高（crate 级模块化） | 中（文件级拆分） | 中（文件级拆分） |
| **VFS 抽象** | trait VfsOps + MountTable | RootDirectory + 多挂载点 | 多 trait 抽象（FilesystemOps/NodeOps/FileNodeOps） | 函数指针表 FS_OP_t | 函数指针表 FS_OP_t |
| **设备驱动模型** | trait BlockDevice + 直接调用 | trait 抽象 + HAL 层 | 多层 trait 抽象 | 接口层 disk.c | 直接调用 |
| **资源管理策略** | 全静态数组（MAX_TASKS=8） | BTreeMap + Vec 动态分配 | Arc/Weak 引用计数 + BTreeMap | 静态数组（64 进程） | 静态数组（NOFILE FDs） |
| **分配器设计** | 无全局堆分配器 | Bitmap + Slab/Buddy/TLSF | ArceOS 内置分配器 | 空闲链表 | 空闲链表 |

**分析**：Aurora 采用「极简无堆」设计哲学——整个内核不依赖全局 allocator，所有数据结构均使用固定大小静态数组。这在保证可预测性和避免内存碎片方面有优势，但 MAX_TASKS=8 和 FD_TABLE_SLOTS=16 等硬编码限制严重制约了可扩展性。ZeroOS 和 StarryOS 则利用 Rust 生态的标准动态数据结构（BTreeMap、Vec、Arc），具备更好的可扩展性。TOYOS 和 OSakura 采用传统的 C 语言静态数组策略，与 Aurora 类似但上限更宽松（64 进程 vs 8 任务）。

---

## 三、子系统实现深度对比

### 3.1 内存管理

| 能力 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| 分页模式 | Sv39 | Sv39 | 多架构 MMU | SV39 | SV39 |
| Copy-on-Write | 完整（自定义 PTE_COW） | 未明确 | 完整（feature 开关） | 无（全量复制） | 无（全量复制） |
| 按需分页（Demand Paging） | 无 | 有（Fault PTE + 文件后端） | 有（缺页异常集成 COW） | 无（无缺页处理） | 无（无缺页处理） |
| 大页支持 | 内核 2MB 恒等映射 | 未提及 | 4K/2M/1G 大页 | 无 | 无 |
| mmap 文件映射 | 无（仅匿名） | 有（MemBackend） | 有 | 有 | 有（支持文件映射） |
| mremap | 无 | 有（支持 MAYMOVE） | 未提及 | 无 | 无 |
| 共享内存（SHM） | 无 | 有（IPC_PRIVATE + KEY） | 有（System V） | 无 | 无 |
| 物理页分配 | Bump + 释放链表 | Bitmap 页分配器 | ArceOS 内置 | 空闲链表（单页） | 空闲链表（单页） |
| 用户指针验证 | UserPtr + UserSlice 逐页校验 | 未明确 | 统一验证机制 | 严格地址合法性校验 | 辅助函数安全读取 |

**分析**：Aurora 在 CoW 实现上与 StarryOS 同为该维度的领先者，但两者采用不同策略——Aurora 使用自定义 PTE_COW 位（bit 8）配合引用计数帧管理，StarryOS 通过 feature 开关集成在缺页异常中。ZeroOS 在内存管理的功能广度上最为全面（Demand Paging + 文件映射 + mremap + SHM），但报告未确认其 CoW 实现。TOYOS 和 OSakura 在内存管理方面明显薄弱，缺乏 CoW 和按需调页，fork 采用全量复制导致性能开销大。

### 3.2 文件系统

| 能力 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| ext4 实现 | **纯 Rust 从零编写（2585行）** | another_ext4 crate | lwext4_rust（C FFI） | C 自实现（2230行） | C 自实现（2262行） |
| ext4 Extent 树 | 支持（仅叶子 extent） | 依赖 crate | 依赖 lwext4 | 支持 | 支持 |
| ext4 写入 | 支持（RMW + 数据块分配） | 未明确 | 依赖 lwext4 | 未明确 | 未明确 |
| ext4 日志 | 无 | 未明确 | 依赖 lwext4 | 无 | 无 |
| FAT32 | 纯 Rust 自实现（1457行） | rust-fatfs crate | 未明确 | C 自实现 | C 自实现 |
| VFS 挂载 | MountTable 前缀匹配 | RootDirectory 前缀匹配 | 完整挂载点管理 | 无挂载实现（桩函数） | 无挂载实现 |
| procfs | 空壳（仅目录） | ramfs 模拟（空） | 硬编码静态数据 | 未提及 | 轻量级（硬编码路径） |
| 块缓存 | 32行直接映射写回缓存 | 未明确 | ArceOS 内置 | 30节点 LRU | LRU 缓冲层 |

**分析**：Aurora 在 ext4 实现上具有最显著的独立工程成就——2585 行纯 Rust 代码从零实现，包含超级块解析、inode 管理、extent 树寻址、文件创建和写入。这是全部对比项目中唯一的**全自研 Rust 版本 ext4**。StarryOS 通过 lwext4_rust 使用 C FFI 绑定（技术路线不同，属集成而非自研）。ZeroOS 使用 another_ext4 crate（依赖外部 Rust crate）。TOYOS 和 OSakura 共享几乎相同的 C 语言 ext4 实现（文件结构、行数高度一致，疑似同源），均约 2200+ 行。Aurora 的 FAT32 同样为纯 Rust 自研（1457 行），而 ZeroOS 使用 rust-fatfs crate。

### 3.3 进程与任务管理

| 能力 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| fork/clone | 完整（CoW fork） | 完整（支持 CLONE_VM 等标志） | 完整（vFork 不完整） | 完整（全量复制） | 完整（全量复制） |
| execve | 完整（ELF 加载） | 完整（ELF 加载） | 完整（支持动态链接 + shebang） | 完整（含动态链接） | 完整（含动态链接） |
| 调度算法 | Round-Robin（仅协作式） | FIFO/RR/CFS（可切换） | 基于 async-task 执行器 | 简单轮转（无优先级） | 简单轮转（遍历） |
| 抢占 | 时钟中断触发 | preempt_yield 抢占 | 异步调度 | 代码被注释 | 代码被注释 |
| 线程支持 | 无（仅进程） | 有（CLONE_THREAD） | 有（clone 标志区分） | 无 | 无 |
| 进程组/会话 | 无 | 有（setpgid/setsid） | 桩实现 | 未提及 | 未提及 |
| 任务上限 | 8 | 动态（BTreeMap） | 动态 | 64 | 未明确 |
| FD 上限 | 16 | 1025 | 1024 | 100 | NOFILE（静态） |
| 内核栈 | 16KB + 保护页 | 预分配110个 | 动态分配 | 4KB | 4KB（每 hart） |

**分析**：Aurora 的进程模型在 fork+execve+waitpid 全链路上实现扎实，CoW fork 是其亮点，但 8 任务/16 FD 的硬编码上限在全部对比项目中最为严苛。ZeroOS 的调度系统最为丰富，支持三种算法切换，且具备完整的线程支持。StarryOS 在进程管理的数据结构设计上最为优雅（Arc/Weak 避免循环引用）。TOYOS 和 OSakura 的调度器均为最简轮转模式，且抢占式调度代码被注释禁用。

### 3.4 系统调用覆盖

| 类别 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| 进程控制 | exit/exit_group/clone/execve/wait4/getpid/gettid | 含进程组/会话/prlimit64 | 含 clone 多标志 | 基础 | 基础 |
| 内存管理 | brk/mmap/munmap/mprotect | 含 mremap/SHM | 含 mmap/brk | mmap/brk | mmap/brk |
| 文件 I/O | read/write/pread/pwrite/readv/writev | 含 splice/sendfile | 完整 | 基础 | 基础 |
| 文件操作 | openat/close/pipe2/mkdirat/unlinkat/symlinkat/linkat/renameat | 含 mount/umount | 完整 | 部分为桩 | 部分为桩 |
| Socket | 17 个（TCP/UDP） | 14 个 | TCP/UDP | 无 | 无 |
| Poll/Epoll | poll/ppoll/epoll 系列 | 定义了 ID 但未实现 | poll/select/epoll（轮询） | 无 | 无 |
| Eventfd/Timerfd | eventfd2/timerfd 系列 | 未明确 | 未明确 | 无 | 无 |
| Futex | futex（8并发） | 含 robust list/requeue | 分片 Futex（SMP 优化） | 无 | 无 |
| 信号 | **完全缺失** | sigaction/sigprocmask/sigreturn/SA_SIGINFO | 完整信号流转 | 框架定义但 sig_handle 未实现 | 31 种信号定义 |
| System V IPC | 无 | 无 | 信号量 + 共享内存 | 无 | 无 |
| 时间 | clock_gettime/nanosleep/gettimeofday | clock_getres/clock_nanosleep/setitimer | 含 itimer | nanosleep/gettimeofday | 部分硬编码 |

**分析**：Aurora 的 92 个系统调用在数量上接近 ZeroOS（101）和 StarryOS（100+），但缺失类别明显——**无信号机制**是最大缺口，而 ZeroOS 和 StarryOS 均实现了完整的信号处理（含 SA_SIGINFO 和 sigreturn）。Aurora 在 eventfd/timerfd 方面有独特覆盖，这是 ZeroOS 和 StarryOS 报告中未明确的功能。ZeroOS 缺少 epoll 实现是其硬伤。StarryOS 虽然接口最全，但 epoll 为轮询实现而非事件驱动。TOYOS 和 OSakura 的系统调用数量明显少于三个 Rust 项目。

### 3.5 网络栈

| 能力 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| 协议栈基础 | smoltcp 自适配（1463行） | smoltcp 封装 | TCP/UDP Socket | 无 | 无 |
| TCP 缓冲区 | 65536 字节 | 未明确 | 未明确 | -- | -- |
| 回环支持 | SmolDevice 回环队列 | loopback 模式 | 未明确 | -- | -- |
| 网卡驱动 | virtio-net（MMIO） | virtio-net + IXGBE 10GbE | virtio-net | 无 | 无 |
| IPv6 | 无 | 无 | 基础支持 | -- | -- |

**分析**：Aurora 和 ZeroOS 均基于 smoltcp 构建网络栈，Aurora 的适配代码（1463行）包含了较完整的 Socket 管理、回环机制和网络轮询。ZeroOS 额外支持 IXGBE 10GbE 网卡驱动。StarryOS 报告称有 IPv4/IPv6 基础支持。TOYOS 和 OSakura 均无网络能力。

### 3.6 同步与 IPC

| 能力 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|------|--------|--------|----------|-------|---------|
| Futex | 基本 wait/wake（8 并发） | wait/wake/requeue/bitset + robust list | 分片表（SMP 优化） | 无 | 无 |
| 管道 | 512 字节环形缓冲 | VecDeque 环形缓冲 | 基础可用（yield 阻塞） | 基础 | 基础 |
| Eventfd | 支持 | 未明确 | 未明确 | 无 | 无 |
| Epoll | 64 监控项 + TaskWaitQueue | 未实现 | 轮询实现 | 无 | 无 |
| 信号量 | 无 | 无 | System V（含 SEM_UNDO） | 无 | 无 |
| 锁机制 | 自旋锁 + 关中断 | 未明确 | ArceOS 内置 | 自旋锁 + 睡眠锁 | 自旋锁 + 睡眠锁 |

**分析**：StarryOS 在同步机制上最为完善——分片 Futex 表设计有效降低了 SMP 环境下的锁竞争，且支持 System V 信号量与共享内存。Aurora 的 Futex 实现虽基本可用但受限于 MAX_TASKS=8，仅支持 8 个并发 Futex。Aurora 在 eventfd/epoll 方面实现较完整，弥补了 Futex 容量的不足。

---

## 四、技术亮点独特性对比

### Aurora 独有亮点

1. **全 Rust 从零实现 ext4（2585行）**：不依赖任何外部 ext4 库（如 lwext4 或 another_ext4），包含超级块、inode、extent 树寻址、目录项、文件创建和写入的完整实现。这在全部对比项目中是唯一的。
2. **手写 RISC-V 机器码内嵌测试（1052字节）**：以机器码字节数组形式直接内嵌用户态测试程序，覆盖 16+ 系统调用路径，实现"自包含"测试。
3. **自定义 PTE_COW 位（bit 8）**：通过 RISC-V 页表保留位实现 CoW 标记，配合引用计数帧管理，实现完整的 fork 语义。
4. **无堆分配全静态设计**：内核完全不使用全局 allocator，所有数据结构预分配，避免内核堆管理的复杂性和潜在的内存泄漏。

### ZeroOS 独有亮点

1. **全异步系统调用模型**：基于 Rust async/await 实现系统调用，阻塞型 I/O 通过 Future 挂起而非忙等或阻塞调度。
2. **双平台硬件适配**：不仅支持 QEMU，还深度适配 VisionFive2 实体开发板，自研 PLIC、RTC、SD 卡驱动。
3. **用户态 BTreeMap 模拟 FAT32 链接**：在 VFS 层通过内存映射解决 FAT32 不支持符号链接的工程难题。
4. **三种调度算法**：支持 FIFO、Round-Robin、CFS，可通过 Cargo features 切换。

### StarryOS 独有亮点

1. **四架构支持**：唯一同时支持 RISC-V、x86_64、AArch64、LoongArch64 的项目。
2. **分片 Futex 表**：基于 SMP 核心数分片，有效降低多核锁竞争，体现对并发性能的深入考量。
3. **System V IPC**：唯一实现 System V 信号量（含 SEM_UNDO）和共享内存的项目。
4. **命名空间隔离**：通过 AxNamespace 实现文件描述符表等资源的命名空间级隔离。

### TOYOS 独有亮点

1. **ELF 动态链接**：在教学/竞赛级 OS 中较为少见的完整动态链接支持（含 ld.so 加载）。
2. **Trampoline 机制**：利用地址空间最高页实现高效的特权级切换，避免页表复制。
3. **严谨的锁持有者校验**：自旋锁包含死锁检测和非法释放检测。

### OSakura 独有亮点

1. **轻量级 procfs**：虽为硬编码路径，但是唯一尝试实现真实 procfs 结构（如 /proc/meminfo）的 C 项目。
2. **双文件系统指针管理**：进程结构体同时维护 FAT32 和 ext4 两套文件指针。

---

## 五、不足与缺失对比

| 缺陷类别 | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|----------|--------|--------|----------|-------|---------|
| **信号机制** | 完全缺失 | SIGSTOP/SIGCONT 未实现 | 进程组信号不完整 | sig_handle 核心未实现 | 仅框架定义 |
| **多核支持** | 完全缺失 | 已支持 | 已支持 | 代码存在但禁用 | 代码存在但禁用 |
| **容量硬限制** | MAX_TASKS=8, FD=16（极严格） | 栈110个，FD 1025 | 较少硬限制 | 进程64，FD 100 | mmap 区128个 |
| **调度器** | 仅轮询，无优先级 | -- | -- | 无优先级/无抢占 | 无优先级/抢占被注释 |
| **epoll 效率** | 轮询实现 | 完全缺失 | 轮询实现 | 完全缺失 | 完全缺失 |
| **ext4 深度** | 无日志/无多级 extent/无删除 | 依赖 crate | 依赖 lwext4 | 无日志 | 无日志 |
| **procfs/sysfs** | 空壳 | 空壳 | 硬编码静态数据 | 无 | 硬编码静态数据 |
| **权限检查** | 未明确 | 未明确 | 未明确 | 未明确 | check_flags 直接返回 true |
| **内核态异常恢复** | 直接 panic | 未明确 | 未明确 | 直接 panic | 直接 panic |

---

## 六、整体成熟度综合评分

以「可运行标准 Linux 用户态程序并具备生产级潜力」为基准（满分 100%）：

| 维度（权重） | Aurora | ZeroOS | StarryOS | TOYOS | OSakura |
|-------------|--------|--------|----------|-------|---------|
| 进程模型 (15%) | 60% | 80% | 75% | 65% | 60% |
| 内存管理 (15%) | 70% | 80% | 80% | 55% | 50% |
| 文件系统 (15%) | 65% | 70% | 75% | 70% | 65% |
| 系统调用覆盖 (15%) | 65% | 75% | 85% | 55% | 55% |
| 网络栈 (10%) | 65% | 65% | 70% | 0% | 0% |
| 同步与IPC (10%) | 55% | 75% | 75% | 40% | 35% |
| 调度与并发 (10%) | 25% | 70% | 65% | 30% | 25% |
| 设备驱动 (5%) | 50% | 80% | 70% | 50% | 40% |
| 代码质量与架构 (5%) | 80% | 75% | 80% | 70% | 65% |
| **加权综合** | **59.5%** | **74.0%** | **76.3%** | **49.3%** | **46.3%** |

**说明**：Aurora 在文件系统自研深度和代码架构简洁性上得分较高，但受限于单核设计、极严格的静态容量限制、信号机制完全缺失和原始调度器，整体成熟度与 ZeroOS/StarryOS 存在显著差距。TOYOS 和 OSakura 因无网络栈和较弱的 IPC/调度能力，综合评分较低。

---

## 七、各项目总结评价

### Aurora（本项目）

Aurora 是一个**架构简洁、自研深度突出**的 RISC-V Rust 宏内核。其最大竞争力在于：纯 Rust 从零实现的 ext4 文件系统（2585行）和 FAT32（1457行），是完全不依赖外部库的全自研成果；CoW fork 通过自定义 PTE_COW 位实现，设计巧妙；手写 RISC-V 机器码内嵌测试方案在竞赛场景中具有独特创意。然而，MAX_TASKS=8 和 FD_TABLE_SLOTS=16 的硬编码限制、信号机制完全缺失、仅支持轮询调度且无多核能力，使其在面对复杂用户态应用时力有不逮。Aurora 是一个「精而深」的技术原型，适合展示文件系统和内存管理的实现深度，但在系统完整性和可扩展性方面需大幅补强。

### ZeroOS

ZeroOS 是全部对比项目中**功能广度与工程实践结合最好**的项目。其异步系统调用模型在同类 Rust 内核中独具特色；VisionFive2 实体开发板的深度适配展示了扎实的底层硬件能力；101 个系统调用与三种调度算法的组合提供了良好的应用兼容性；约 61,441 行的代码规模是 Aurora 的三倍，体现了更全面的子系统覆盖。主要短板在于 epoll 缺失、procfs/sysfs 为空壳、以及部分测试用例未通过（iperf、libcbench 等）。

### StarryOS

StarryOS 是全部对比项目中**架构最成熟、扩展性最强**的项目。四架构支持使其在平台覆盖面上遥遥领先；分片 Futex 表设计展示了对多核性能优化的深入理解；System V IPC 和命名空间隔离实现了更完整的 Linux 兼容性。其使用 lwext4_rust（C FFI）的方式降低了 ext4 自研的工作量但牺牲了纯 Rust 的技术纯粹性。epoll 的轮询实现和高负载下的性能瓶颈是其主要技术债务。综合而言，StarryOS 在架构成熟度和生产就绪度上领先于其他项目。

### TOYOS

TOYOS 是一个**技术亮点突出但整体完成度有限**的 C 语言内核。其 ext4 Extent 树实现和 ELF 动态链接支持在同语言项目中处于领先水平；Trampoline 机制和严谨的锁设计体现了良好的底层理解。然而，信号机制的 sig_handle 核心函数未实现、抢占式调度被禁用、无缺页处理、无网络栈等问题严重制约了其实际可用性。55 个系统调用的覆盖范围在对比项目中排名末位。

### OSakura

OSakura 是一个**代码紧凑、结构清晰但深度不足**的 C 语言教学内核。其 ext4/FAT32 实现与 TOYOS 高度同源（文件结构和行数几乎一致），轻量级 procfs 是一个差异化尝试。但约 9,633 行的代码总量在对比项目中最小，check_flags 直接返回 true 暴露了安全机制的缺失，无网络驱动、无 COW、无按需调页、部分系统调用返回硬编码值等问题表明其仍处于较早期的开发阶段。

---

## 八、综合排名与分类评价

### 综合排名

| 排名 | 项目 | 综合得分 | 核心优势 |
|------|------|---------|---------|
| 1 | **StarryOS** | 76.3% | 多架构、成熟架构、SMP、System V IPC |
| 2 | **ZeroOS** | 74.0% | 异步模型、双平台硬件、功能广度 |
| 3 | **Aurora** | 59.5% | 全自研 ext4、CoW、代码简洁 |
| 4 | **TOYOS** | 49.3% | 动态链接、extent 树、锁设计 |
| 5 | **OSakura** | 46.3% | 代码紧凑、procfs 尝试 |

### 分类评价

- **最佳工程完整性**：StarryOS —— 四架构、SMP、命名空间、System V IPC，是最接近「产品级」的项目。
- **最佳技术创新性**：ZeroOS —— 异步系统调用模型和双平台硬件适配在全部项目中独树一帜。
- **最佳自研深度**：Aurora —— 全 Rust 从零实现 ext4 + FAT32 + CoW，不依赖外部文件系统库，技术纯粹性最高。
- **最佳学习参考价值**：OSakura —— 代码量最小（~9,600行）、结构最清晰、注释充分，适合作为 OS 入门学习材料。
- **最佳底层架构设计**：TOYOS —— Trampoline 机制和锁的持有者校验体现了扎实的底层系统设计功底。

---

## 九、评审意见

Project Aurora 作为一个面向 OS 竞赛的 RISC-V Rust 宏内核，展现了优秀的**独立技术攻坚能力**。其最突出的贡献在于纯 Rust 从零实现 ext4 文件系统（含 extent 树寻址和文件写入）和 FAT32 文件系统，这在同类竞赛项目中极为罕见——ZeroOS 使用 another_ext4 crate、StarryOS 使用 lwext4 C FFI，而 TOYOS/OSakura 共享同一套 C 语言实现。此外，Aurora 的自定义 PTE_COW 位实现 Copy-on-Write fork 以及手写 RISC-V 机器码内嵌测试程序均体现了作者对底层机制的透彻理解和创新思维。

然而，Aurora 在**系统完整性**方面的短板同样突出。MAX_TASKS=8 和 FD_TABLE_SLOTS=16 的硬编码限制了其作为通用操作系统的潜力；信号机制的完全缺失使其无法支持作业控制和高级进程间通信；单核设计和纯协作式调度器无法发挥现代硬件的并发性能。将这些限制与 ZeroOS 的 101 个系统调用+三种调度算法、StarryOS 的四架构+SMP+System V IPC 进行对比，Aurora 在系统成熟度上存在明显的代际差距（约 15-17 个百分点）。

**建议与定位**：Aurora 最适合定位为「深挖文件系统与内存管理关键技术的专业型内核」，而非追求功能广度的通用型内核。若能在保持自研深度的同时，突破静态容量限制、补充信号机制、实现基本的多核支持，Aurora 将具备与 StarryOS 和 ZeroOS 在同一水平线上竞争的潜力。就当前状态而言，其在 ext4/CoW 方向的技术深度已处于全部对比项目中的领先水平，值得肯定。