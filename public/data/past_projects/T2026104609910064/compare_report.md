# 对比分析报告

## 一、对比项目概况

本报告对 **OSKernel2026**（当前项目）与五个选取的竞赛级操作系统内核项目进行多维度对比分析。六个项目的基本信息如下：

| 属性 | OSKernel2026（当前） | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|---------------------|-------------|----------------|------------|--------|---------|
| **来源** | 当前项目 | 北京科技大学 | 西北工业大学 | 杭州电子科技大学 | 上海交通大学 | 郑州大学 |
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 异步宏内核 | 微内核 | 异步框内核 |
| **实现语言** | Rust | Rust | Rust | Rust | C | Rust |
| **生态基座** | rCore-Tutorial | rCore-Tutorial | NPUcore-lwext4 | 自研 | 自研 | Asterinas |
| **目标架构** | RV64 + LA64 | RV64 + LA64 | RV64 + LA64 | RV64 + LA64 | RV64 仅 | RV64 + LA64 + x86_64 |
| **内核代码量** | ~56,700 行 | ~21,400 行 | ~36,000 行 | ~356 源文件 | ~345 源文件 | ~582 源文件 |
| **系统调用数** | 150+ | 100+ | 90+ | 未统计 | 未统计 | ~55 |
| **调度模型** | FIFO | FIFO（Stride 仅数据结构） | FIFO | 多级异步调度 | 可插拔 RR/PBRR/PBFIFO | 工作窃取多核调度 |

---

## 二、架构设计维度对比

| 维度 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 异步宏内核 | 微内核（Capability） | 异步框内核（Framekernel） |
| **分层方式** | PlatformOps trait + delegate宏 | 条件编译 + HAL模块 | 架构/板级分离 HAL | 多层trait抽象 HAL | 策略模式 + 架构分离 | VMAR/VMO能力模型 |
| **模块化程度** | 高（14个顶层模块，清晰边界） | 中高（10个模块，部分耦合） | 高（清晰模块划分，170文件） | 高（kernel/lib分离，356文件） | 极高（内核+用户态服务分离） | 极高（ostd/kernel/osdk三层） |
| **双架构实现** | PlatformOps trait统一接口，条件编译 | 条件编译，架构差异在函数体内 | 特征(feature)切换+架构独立目录 | trait抽象，架构独立目录 | 仅RISC-V（单架构） | 条件编译+架构独立目录 |
| **模型创新性** | 常规宏内核，继承rCore模式 | 常规宏内核，继承rCore模式 | 常规宏内核 | 全异步Future驱动调度，创新性高 | Capability安全模型，架构级创新 | 异步系统调用+静态分发VFS，创新性高 |

**分析**：
- OSKernel2026、SubsToKernel、NPUcore-BLOSSOM 三者均属于常规同步宏内核架构，继承或参考了rCore的设计范式。OSKernel2026 的 `PlatformOps` trait 设计最为系统化，通过委托宏实现零开销架构抽象，优于SubsToKernel的条件编译散落在函数体内的做法。
- NoAxiom-OS 和 NexusOS 代表了异步内核的两个分支：前者基于 `async_task` 的无栈协程运行时，后者基于 Asterinas 的全异步框内核。两者在调度模型上均有实质性创新。
- ChCore 作为唯一的微内核，其 Capability 安全模型与迁移式 IPC 代表了与宏内核截然不同的设计哲学，在安全隔离性上有先天优势。

---

## 三、子系统实现深度对比

### 3.1 内存管理

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| 物理页分配 | bump+回收链表+引用计数 | LIFO栈+回收链表 | 栈式+回收链表 | 架构抽象的页分配器 | Buddy+Slab双层 | Buddy系统（Asterinas） |
| 页表管理 | SV39/LA64，PlatformOps抽象 | SV39/LA64，PTE第9位COW标记 | SV39/LAFlex灵活页表 | SV39/LA64，ArchMemory trait | SV39/SV48，四级页表 | SV39/LA64，游标式遍历 |
| CoW | 完整（fork共享+缺页复制） | 完整（引用计数+PTE标记） | 完整（缺页复制新帧） | 完整 | 完整（含COW缺页处理） | 通过VMO引用实现 |
| Lazy分配 | 部分（仅缺页触发的COW） | 完整（堆/栈延迟分配） | 部分 | 完整（按需映射） | 部分（PMO_ANONYM） | 完整（demand paging） |
| mmap支持 | MAP_PRIVATE/SHARED/FIXED/ANONYMOUS | MAP_PRIVATE/SHARED/FIXED/ANONYMOUS+文件 | 基本实现 | 完整（含文件映射） | 较完整 | MAP_PRIVATE/SHARED/FIXED/ANONYMOUS |
| 共享内存 | SysV shmget/shmat/shmdt | SysV shm+GroupManager跨fork | 未确认 | ShmInfo结构 | PMO_SHM | 通过VMO共享 |
| Swap/Zram | 无 | 无 | **有（LZ4压缩+Swap分区）** | 无 | 无 | 无 |
| OOM处理 | 无 | 无 | **有（三级降级策略）** | 无 | 无 | 无 |
| **综合评分** | 7/10 | 7.5/10 | **8.5/10** | 7.5/10 | 8/10 | 7.5/10 |

**评述**：NPUcore-BLOSSOM 在内存管理维度整体领先，其 Swap、Zram 和 OOM 三级降级机制是其他五个项目均不具备的关键能力，使得该内核在物理内存耗尽时仍有降级路径。OSKernel2026 的引用计数帧分配器与 COW 实现完整正确，但缺乏任何形式的页面回收机制。ChCore 的 Buddy+Slab 双层分配器设计经典且工程成熟。

### 3.2 进程与任务管理

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| 进程/线程模型 | 进程-线程双层 | 进程-线程双层 | 进程-线程双层 | Task（统一）+PCB/TCB分离 | Thread（统一） | ThreadState + ThreadGroup |
| fork/clone | 12种clone标志，含CLONE_THREAD | 完整clone标志，含CLONE_VFORK | 支持（完整clone标志） | 完整clone语义，8种标志 | 不支持（微内核语义） | clone按CLONE_THREAD分治 |
| exec | ELF静态+动态+shebang+解释器缓存 | ELF+动态链接器+auxv | ELF+动态链接器 | ELF+dl_interp+auxv | ELF加载（用户态服务） | ELF+auxv+FD_CLOEXEC |
| 调度器 | FIFO+抢占检测 | FIFO（Stride仅数据结构） | FIFO | **多级异步调度+CFS废弃代码** | **可插拔RR/PBRR/PBFIFO** | **工作窃取多核调度** |
| futex | 6种操作（含bitset+超时+EINTR） | 4种操作（WAIT/WAKE/REQUEUE/WAKE_OP） | 基本实现 | 4种操作（含bitset+异步Future） | 未确认 | 无 |
| 多核支持 | 无（单核） | 无（单核） | 无（单核） | 有（CPU亲和性掩码） | **有（完整SMP）** | **有（工作窃取多核）** |
| **综合评分** | 7.5/10 | 7/10 | 6.5/10 | **8.5/10** | **8.5/10** | 7/10 |

**评述**：NoAxiom-OS 和 ChCore 在进程管理维度领先。NoAxiom-OS 的多级异步调度器（实时FIFO + 普通双队列）是唯一在竞赛宏内核中实现了非平凡调度策略的项目。ChCore 的可插拔调度框架（三种策略编译期切换）和完整 SMP 支持体现了工业级工程水准。OSKernel2026 的 futex 实现最为完整（6种操作、EINTR正确处理），clone 标志支持也达到了较高水平，但缺少调度深度和 SMP 支持。

### 3.3 文件系统

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| VFS抽象 | BackendRegistry+NodeBackend枚举 | Inode/File/Sock三Trait | DirectoryTreeNode缓存 | 多Trait层次抽象 | 用户态文件系统服务 | Vnode/FileSystem/Dentry多层 |
| 磁盘文件系统 | **RamFS(读写)+EXT4(只读)叠加** | lwext4 ext4(读写) | **EXT4(Extent树)+FAT32双系统** | 5种文件系统 | 多文件系统（用户态） | **纯Rust ext4(基本读写)** |
| EXT4实现方式 | 自研Rust只读实现 | C库lwext4 FFI绑定 | 自研Rust完整实现 | 自研（含extent树） | 用户态服务 | 自研纯Rust实现 |
| 管道 | 64KB环形缓冲+EPIPE | 64KB环形缓冲+SIGPIPE | 基本实现 | 完整实现 | 完整实现 | RingPipe+splice |
| 伪文件系统 | DevFS+ProcFS(/proc/self) | DevFS+静态procfs | DevFS（null/zero/urandom/tty） | DevFS+ProcFS | 用户态服务 | DevFS（serial/null）+procfs |
| 页缓存/Dentry缓存 | **三层缓存（dentry/inode/page）** | 无独立缓存层 | 目录树缓存 | 未确认 | 未确认 | VnodeCache+DentryCache |
| **综合评分** | **8/10** | 7/10 | **8.5/10** | **8.5/10** | 7/10 | **8/10** |

**评述**：文件系统是四个 Rust 宏内核项目均重点投入的领域。NPUcore-BLOSSOM 和 NoAxiom-OS 实现了最广泛的文件系统类型覆盖。OSKernel2026 的 RamFS+EXT4 叠加方案（RamFS提供读写、EXT4提供只读数据）是一个实用的工程策略，三层缓存架构在竞赛内核中较为少见。但 EXT4 不支持写入是明显短板。NexusOS 是唯一实现**纯 Rust ext4**（从磁盘结构解析到 extent 树遍历均不依赖 C 库）的项目，但日志（journal）仅为桩实现。SubsToKernel 依赖 C 库 lwext4，虽然功能完整但失去了 Rust 的安全保证。

### 3.4 网络子系统

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| 协议栈 | smoltcp loopback | smoltcp TCP/UDP | smoltcp TCP/UDP | smoltcp TCP/UDP | lwIP（用户态服务） | smoltcp（通过Asterinas） |
| TCP状态机 | 基础 | 完整（含状态机） | 完整（Nagle+KeepAlive） | 完整 | 完整（通过lwIP） | 基础 |
| Socket API | 14个系统调用，完整 | 12个系统调用 | 基础 | 完整 | 完整（用户态） | 有限 |
| DNS | 无独立DNS | 基础（8.8.8.8） | 无独立DNS | 无独立DNS | 无独立DNS | 无独立DNS |
| Unix Socket | socketpair（通过socket表） | 无 | UnixSocket（未完成） | 无 | 无 | 无 |
| IPv6 | 无 | 无 | 无 | 无 | 无 | 无 |
| **综合评分** | 5/10 | 6.5/10 | 6/10 | **7.5/10** | 7/10 | 5/10 |

**评述**：网络是六个项目中普遍较为薄弱的维度。OSKernel2026 仅实现了 loopback（127.0.0.1/8），缺少对外部网络接口的支持，这是一个显著的功能缺失。NoAxiom-OS 的网络实现在竞赛中经过了实际测试验证（曾获网络性能第一），可靠性最高。ChCore 将网络栈置于用户态服务是微内核的架构选择，隔离性好但存在 IPC 性能开销。

### 3.5 信号处理

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| 信号数量 | **64个（含实时信号）** | 33个 | 64个 | 完整 | 完整 | 仅存储（桩） |
| SA_SIGINFO | **完整** | 部分 | 未确认 | 完整 | 未确认 | 无 |
| 信号栈帧 | **完整+SA_RESTORER** | 完整（magic标记） | 基本 | 完整 | 基本 | 无 |
| 实时信号排队 | **有** | 无 | 未确认 | 未确认 | 未确认 | 无 |
| sigaltstack | **完整** | 未实现 | 未确认 | 未确认 | 未确认 | 无 |
| SIGCANCEL(musl) | **有** | 无 | 无 | 未确认 | 无 | 无 |
| **综合评分** | **9/10** | 7.5/10 | 7/10 | 8/10 | 6.5/10 | 2/10 |

**评述**：OSKernel2026 在信号处理维度上明显领先。实时信号排队、完整的 SA_SIGINFO 语义、sigaltstack 和 SIGCANCEL（musl线程取消）的支持使其信号子系统达到了准生产级别。这是该项目相对 SubsToKernel 基座最显著的增量改进之一。NexusOS 的信号仅为存储，是该项目的最大短板。

### 3.6 同步机制

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| 锁机制 | 自旋锁（CAS） | MutexSpin+MutexBlocking | 基本 | 多种锁 | 内核大锁+细粒度锁 | 基于Asterinas |
| 信号量 | 无独立实现 | 计数信号量 | 未确认 | 未确认 | 未确认 | 无 |
| 条件变量 | 无独立实现 | 完整 | 未确认 | 未确认 | 未确认 | 无 |
| futex | **6种操作** | 4种操作 | 基本 | 4种操作（异步） | 未确认 | 无 |
| 银行家算法 | 无 | **有（进程级死锁检测）** | 无 | 无 | 无 | 无 |
| 健壮列表 | 完整（set/get_robust_list） | 完整 | 未确认 | 未确认 | 未确认 | 仅存储 |
| **综合评分** | 7/10 | **8.5/10** | 6/10 | 7/10 | 6/10 | 3/10 |

**评述**：SubsToKernel 在同步机制维度领先，银行家算法是其在竞赛内核中的独特贡献——尽管其实用性有限（仅进程内检测），但教学和展示价值突出。OSKernel2026 未继承银行家算法（或有意删除），但 futex 实现更为完善（新增 bitset 和超时操作）。NexusOS 的同步机制最为薄弱，缺乏 futex 是其运行复杂多线程应用的主要障碍。

### 3.7 设备驱动与硬件抽象

| 特性 | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|------|-------------|-------------|----------------|------------|--------|---------|
| HAL设计 | **PlatformOps trait+delegate宏** | 条件编译+独立模块 | 架构/板级分离 | trait抽象 | 架构目录分离 | 继承Asterinas ostd |
| 块设备 | VirtIO MMIO+PCI Modern | VirtIO MMIO+PCI | VirtIO MMIO/PCI + SATA | VirtIO | VirtIO | 通过ostd |
| 网络设备 | 无（仅loopback） | VirtIO MMIO+PCI | 无独立驱动 | VirtIO | 用户态驱动 | 通过ostd |
| 总线枚举 | MMIO+PCI基础探测 | **PCI完整枚举+BAR分配** | 基础 | 基础 | 基础 | 通过ostd |
| 多板级支持 | QEMU virt | QEMU virt | **6种板级（含VisionFive2/2K1000）** | QEMU virt | QEMU virt+VisionFive2 | QEMU virt |
| **综合评分** | 6.5/10 | **8/10** | **8/10** | 7/10 | 7.5/10 | 6/10 |

**评述**：SubsToKernel 的 PCI 总线完整枚举与 BAR 分配是竞赛内核中较为少见的工程实现，这为 LoongArch 平台的 PCI VirtIO 设备提供了完整支持。NPUcore-BLOSSOM 的板级支持最为广泛（6种配置），展现了实际硬件适配的潜力。OSKernel2026 的 PlatformOps trait 设计优雅但设备驱动覆盖不足，尤其是网络设备驱动的缺失使其网络能力局限于 loopback。NexusOS 和 ChCore 大量继承了底层框架（Asterinas ostd 和 OpenSBI），在驱动层面自主实现较少。

---

## 四、技术亮点与创新性对比

| 项目 | 核心技术亮点 | 创新程度 | 实用价值 |
|------|------------|---------|---------|
| **OSKernel2026** | 150+ syscall覆盖面广；三层文件缓存；实时信号排队+SIGCANCEL；PlatformOps零开销架构抽象；12种自测框架 | 中等 | 高 |
| **SubsToKernel** | 银行家算法死锁检测；LoongArch TLB快填汇编优化；CoW+Lazy+GroupManager三层内存优化；PCI完整枚举 | **较高** | 中高 |
| **NPUcore-BLOSSOM** | Swap+Zram压缩+OOM三级降级；EXT4+FAT32双文件系统；6种板级支持；Extent树+CRC32校验 | 较高 | **高** |
| **NoAxiom-OS** | 无栈协程异步调度；多级优先级调度器；async VFS全链路异步IO；CFS完整代码（未启用）；竞赛性能测试第二 | **高** | 高 |
| **ChCore** | Capability安全模型；迁移式IPC(Shadow线程)；可插拔实时调度；OpenTrustee TEE；ASLR | **高** | 高 |
| **NexusOS** | VMAR/VMO能力模型；纯Rust ext4实现；静态分发VFS零开销；Rust类型系统能力检查；工作窃取多核 | **高** | 中高 |

---

## 五、不足与缺失对比

| 项目 | 主要不足 |
|------|---------|
| **OSKernel2026** | 无Swap/页面回收；EXT4仅只读；网络仅loopback；无SMP支持；调度器仅为FIFO；银行家算法缺失 |
| **SubsToKernel** | 无Swap/Zram；调度器仅FIFO（Stride未启用）；无SMP；procfs为静态模拟；MachineContext序列化未实现 |
| **NPUcore-BLOSSOM** | 调度器仅FIFO；无SMP；UnixSocket未完成；FAT32驱动不完整；部分panic错误处理 |
| **NoAxiom-OS** | CFS完整但未启用；负载均衡未完善；无Swap；DNS/Unix Socket缺失；异步复杂性增加维护难度 |
| **ChCore** | 仅RISC-V单架构；微内核IPC开销；用户态文件系统服务增加延迟；构建依赖特定工具链 |
| **NexusOS** | 系统调用仅55个（最少）；信号为桩；无futex；journal为桩；依赖Asterinas框架版本锁定 |

---

## 六、整体成熟度综合评分

以下评分采用10分制，以竞赛级教学/研究内核的期望水平为基准（10分代表功能完整、工程成熟、可直接用于教学与竞赛评测的生产级教学内核）。

| 维度（权重） | OSKernel2026 | SubsToKernel | NPUcore-BLOSSOM | NoAxiom-OS | ChCore | NexusOS |
|-------------|-------------|-------------|----------------|------------|--------|---------|
| 内存管理 (20%) | 7.0 | 7.5 | **8.5** | 7.5 | 8.0 | 7.5 |
| 进程管理 (20%) | 7.5 | 7.0 | 6.5 | **8.5** | **8.5** | 7.0 |
| 文件系统 (20%) | 8.0 | 7.0 | **8.5** | **8.5** | 7.0 | 8.0 |
| 网络 (10%) | 5.0 | 6.5 | 6.0 | **7.5** | 7.0 | 5.0 |
| 信号处理 (10%) | **9.0** | 7.5 | 7.0 | 8.0 | 6.5 | 2.0 |
| 同步机制 (10%) | 7.0 | **8.5** | 6.0 | 7.0 | 6.0 | 3.0 |
| 设备驱动/HAL (10%) | 6.5 | 8.0 | 8.0 | 7.0 | 7.5 | 6.0 |
| **加权总分** | **7.2** | 7.4 | **7.5** | **7.9** | **7.5** | 6.3 |

**排名**（按加权总分）：
1. **NoAxiom-OS**：7.9 —— 异步调度架构创新与均衡的子系统实现
2. **NPUcore-BLOSSOM**：7.5 —— 内存管理与文件系统深度突出，Swap/Zram为独特优势
3. **ChCore**：7.5 —— 微内核架构成熟，SMP与调度框架完善
4. **SubsToKernel**：7.4 —— 系统调用覆盖面广，同步机制独特
5. **OSKernel2026**：7.2 —— 信号处理与系统调用突出，但网络与Swap缺失
6. **NexusOS**：6.3 —— 架构前瞻但功能完整度不足

---

## 七、各项目总结评价

### OSKernel2026（当前项目）

OSKernel2026 是一个在 SubsToKernel 基座上进行了**显著增量改进**的项目。其最突出的成就是系统调用覆盖从 100+ 提升至 150+，信号处理子系统从基本可用提升至**准生产级别**（实时信号排队、SA_SIGINFO、sigaltstack、SIGCANCEL），以及 PlatfromOps trait 实现了更优雅的架构抽象。三层文件缓存（dentry/inode/page）在竞赛宏内核中具有差异化优势。然而，项目在继承基座时**舍弃了部分特色功能**（如银行家算法、lwext4 ext4 读写能力），且未弥补基座的根本性不足（SMP、Swap、非loopback网络），使得整体增量呈现"拓宽但未深化"的特征。RamFS+EXT4只读叠加方案虽实用，但EXT4不支持写入是硬伤。

### SubsToKernel（北京科技大学）

作为当前项目的直接基座，SubsToKernel 展现了扎实的系统编程功底。银行家算法、LoongArch TLB汇编快填、PCI完整枚举体现了团队在"纵深"维度的探索精神。100+系统调用、基于 lwext4 的 ext4 读写能力使其具备了运行较为复杂用户程序的基础。然而，调度器（FIFO）和 SMP 的缺失使其在多任务并发的真实场景中能力受限。作为2025年的作品，其完成度在当时属于上乘。

### NPUcore-BLOSSOM（西北工业大学）

NPUcore-BLOSSOM 在内存管理维度上的投入是六个项目中最深的。Swap交换分区、Zram压缩内存（LZ4算法）、三级OOM降级策略构成了完整的内存压力应对体系——这是其他五个项目均不具备的能力。EXT4实现包含 extent 树和 CRC32 校验，FAT32 提供额外兼容性。六种板级配置体现了团队对真实硬件的关注。但其调度器仅为FIFO且无SMP支持，使这些内存管理优化在实际并发负载下的受益有限，形成了"底层深厚但调度薄弱"的不均衡格局。

### NoAxiom-OS（杭州电子科技大学）

NoAxiom-OS 是六个项目中**架构创新与工程实现结合最好**的项目。基于无栈协程的异步调度架构不仅是一个概念验证，更在实际竞赛评测中取得了性能测试总分第二、网络性能第一的成绩。多级优先级调度器、五种文件系统、细粒度并发模型均展现了成熟的工程能力。其CFS代码完整但未启用，暗示了团队在更公平调度上的探索意图。不足在于Swap缺失、负载均衡未完善，且异步编程模型的内核调试和维护复杂度较高。

### ChCore（上海交通大学）

ChCore 作为唯一的微内核和C语言项目，代表了与Rust宏内核截然不同的技术路线。Capability安全模型、迁移式IPC（Shadow线程）、OpenTrustee TEE扩展使其在安全性和隔离性上具有天然优势。可插拔的调度框架（三种策略）和完整SMP支持体现了远高于竞赛级教学内核的工程成熟度。但其仅支持RISC-V单架构，这在与双架构Rust项目的对比中构成明显的生态局限。此外，微内核的IPC路径开销和用户态文件系统服务的延迟是固有代价。

### NexusOS（郑州大学）

NexusOS 在架构理念上最具前瞻性：VMAR/VMO能力模型、静态分发VFS、纯Rust ext4、工作窃取多核调度均体现了对Rust类型系统和现代OS设计思想的深度理解。然而，其功能完整度（仅55个系统调用、信号为桩、无futex）与架构先进性之间形成了**显著落差**。项目更像是 Asterinas 框架的能力展示而非独立完成的内核作品，自主实现比例相对较低。ext4的journal为桩实现也限制了其数据一致性保障。

---

## 八、综合评审意见

本次对比的六个项目代表了当前国内高校OS内核竞赛领域的多元技术光谱：从常规同步宏内核（OSKernel2026、SubsToKernel、NPUcore-BLOSSOM）到异步宏内核（NoAxiom-OS、NexusOS），再到微内核（ChCore）。每个项目都有明确的差异化定位：

**OSKernel2026** 选择了一条务实的路径——在成熟的 rCore/SubsToKernel 基座上做增量提升。其150+系统调用和准生产级信号处理是可观的改进，PlatformOps trait 抽象也比基座的条件编译方案更优雅。但项目的取舍策略值得审视：保留并增强了基座的"广度"优势（更多syscall、更完善的信号），却放弃了部分"深度"特色（银行家算法、ext4读写），同时也未突破基座的根基性限制（无SMP、无Swap、网络仅loopback）。如果对比 NPUcore-BLOSSOM 在内存压力处理上的纵深投入，或 NoAxiom-OS 在调度架构上的创新突破，OSKernel2026 的相对定位是"系统调用覆盖最广、信号处理最好的 rCore 系内核"，但在架构创新和子系统深度上尚未形成明确的差异化壁垒。

建议后续发展方向：优先补齐网络设备驱动（使 smoltcp 能使用 VirtIO 网卡而非仅 loopback），其次实现 EXT4 基本写入能力或集成 FAT32 读写支持，中长期应关注 SMP 支持和页面回收机制的引入。