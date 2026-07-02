# 对比分析报告

## 一、项目概览

本报告对以下六个操作系统内核项目进行多维度对比分析：

| 项目 | 语言 | 代码量(行) | 架构支持 | 系统调用数 | 基座/生态 |
|------|------|-----------|----------|-----------|----------|
| **NPUcore-Ovo**（基线） | Rust | ~69,500 | RISC-V + LoongArch | ~200+ | 无基座，自研 |
| **NPUcore-BLOSSOM** | Rust | ~36,000 | RISC-V + LoongArch | ~90 | 无基座，NPUcore 系列 |
| **NPUcore-Aspera** | Rust | ~37,531 | RISC-V + LoongArch | ~117 | 无基座，NPUcore 系列 |
| **OSakura** | C | ~9,633 | RISC-V | ~60 | 无基座，自研 |
| **TatlinOS** | Rust | 未明确统计 | RISC-V + LoongArch | ~100+ | 无基座，自研 |
| **StarryX** | Rust | ~22,800 | 四架构(含AArch64/x86_64) | ~200 | ArceOS 基座 |

---

## 二、架构设计对比

| 维度 | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|------|------------|-----------------|----------------|---------|----------|---------|
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **分层方式** | HAL→子系统→驱动，严格分层 | HAL→子系统→驱动 | HAL→子系统→驱动 | 子系统平铺+FS抽象层 | HAL→子系统→驱动 | API层/核心层/模块层 三层 |
| **HAL 抽象** | trait统一接口，编译期架构选择 | 条件编译`mod.rs`重导出 | 条件编译`mod.rs`重导出 | 无HAL，仅RISC-V | cfg_if+trait隔离 | 依赖ArceOS基座抽象 |
| **模块化程度** | 高（187文件，清晰边界） | 中高（170文件） | 中高（130文件） | 中（~30个.c文件） | 高（100+文件） | 高（167文件，三层分离） |
| **多核支持** | 是（SMP，原子屏障同步） | 否（单核） | 否（CPU0以外死循环） | 否（代码框架存在但禁用） | 否（HART_NUM=1） | 依赖ArceOS基座 |
| **架构可扩展性** | 强（trait抽象，新架构实现trait即可） | 中（条件编译，需修改mod.rs） | 中（条件编译，需修改mod.rs） | 弱（单架构硬编码） | 强（trait抽象规范） | 强（基座已支持四架构） |

**分析要点**：
- NPUcore-Ovo 的 HAL 设计最为成熟：采用 trait 统一接口而非条件编译重导出，新增架构只需实现 trait，无需修改现有代码。多核支持通过原子操作（Acquire-Release语义）和 `on_cpu` 标志实现了完整的 SMP 安全上下文切换。
- NPUcore-BLOSSOM 和 NPUcore-Aspera 共享同一 HAL 设计范式（条件编译重导出），结构相似但均缺乏 SMP 支持。
- StarryX 的三层分离（API/核心/模块）是组件化设计的典范，但调度和底层硬件依赖 ArceOS 基座，自主性不如其他项目。
- OSakura 架构最简单——单架构、C语言、无HAL，但函数指针表实现多文件系统抽象的思路清晰务实。
- TatlinOS 的 trait 隔离设计良好，但 `HART_NUM=1` 硬编码和 1Hz 调度频率暴露了并发设计的短板。

---

## 三、内存管理子系统对比

| 特性 | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|------|------------|-----------------|----------------|---------|----------|---------|
| **分页机制** | sv39 + LAFlex | sv39 + LAFlex | sv39 + LAFlex | sv39 | sv39 + LA64 | 依赖基座 |
| **物理帧分配** | 栈式分配器 | 栈式分配器 | 栈式分配器 | 空闲链表（单页） | 带水位线页缓存 | 依赖基座 |
| **内核堆** | buddy_system(256MB) | buddy_system | buddy_system | 静态分区（4MB） | buddy_system | 依赖基座 |
| **写时复制(CoW)** | 完整 | 完整 | 完整 | 无 | 完整 | 完整 |
| **按需分页(Lazy)** | 是 | 是 | 是 | 否（fork全量复制） | 是 | 是 |
| **ZRAM压缩** | 是（LZ4，2048槽） | 是（LZ4） | 是（LZ4，2048槽） | 无 | 无 | 无 |
| **Swap交换** | 是（16MB，位图管理） | 是（位图管理） | 是（16MB，位图管理） | 无 | 无 | 无 |
| **OOM处理** | 三级降级策略 | 三级降级策略 | 三级降级+Frame状态机 | 无 | 无 | 无 |
| **共享内存** | 是 | 是 | 是（SharedSegment） | 否 | 是（GroupManager） | 是（System V SHM） |
| **mmap** | 完整（匿名/文件/CoW） | 完整 | 完整 | 基础（128区域限制） | 完整 | 完整（含大页2M/1G） |
| **页缓存** | 优先级淘汰+free_list | 无独立页缓存 | 块缓存+页缓存 | LRU buf缓存 | 水位线页缓存 | LRU页缓存+脏页回写 |
| **高级特性** | 进程凭证完整建模 | Frame枚举状态机 | Frame枚举状态机（4态） | 无 | 页缓存批量分配/回收 | VMA管理器+2M/1G大页 |

**分析要点**：
- NPUcore-Ovo 的内存管理最为全面：同时具备 ZRAM+Swap+OOM 三级回收，且页缓存、CoW、mmap 等基础机制完整。ZRAM/Swap/CoW 形成了完整的"压力-回收"闭环。
- NPUcore-Aspera 在 Ovo 基础上引入 Frame 状态机设计（InMemory/Compressed/SwappedOut/Unallocated），使得页面在不同存储层级间的迁移逻辑更为清晰，是架构设计上的一个改进。
- NPUcore-BLOSSOM 与 Aspera 在内存管理上高度相似（同源分支），但 BLOSSOM 未采用 Frame 状态机。
- TatlinOS 的页缓存水位线设计（HIGH=128, LOW=32, REFILL=16, FLUSH=64）在物理页分配性能优化上有独到之处，但缺少 ZRAM/Swap 意味着在内存压力下缺乏回收手段。
- StarryX 的 LRU 页缓存+脏页回写机制成熟，VMA 管理器支持大页，但 msync/madvise 为存根且无 Swap/ZRAM。
- OSakura 的内存管理最弱：无 CoW、无按需分页、单页分配限制、内核池仅 4MB。

---

## 四、进程管理与调度对比

| 特性 | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|------|------------|-----------------|----------------|---------|----------|---------|
| **调度器** | 三级：RT(FIFO/RR)+CFS+Idle | FIFO | FIFO | 遍历式轮转 | 轮转(RR) | ArceOS基础调度 |
| **调度复杂度** | RT: O(1)位图, CFS: O(log n) | O(1) | O(1) | O(n)遍历 | O(1) | 依赖基座 |
| **调度策略** | NORMAL/FIFO/RR/BATCH/IDLE/DEADLINE | FIFO | FIFO | 协作式（抢占注释掉） | 固定1Hz抢占 | SCHED_RR标志 |
| **nice权重表** | 是（Linux标准权重表） | 无 | 无 | 无 | 无 | 无 |
| **vruntime** | 是（CFS核心） | 无 | 无 | 无 | 无 | 无 |
| **时间片粒度** | SCHED_LATENCY=6ms, MIN_GRAN=0.75ms | 无精细控制 | 无精细控制 | 无 | 1000ms(1Hz) | 依赖基座 |
| **SMP多核** | 是（Per-CPU队列） | 否 | 否 | 否 | 否 | 依赖基座 |
| **CPU亲和性** | 是（位图） | 否 | 否 | 否 | 否 | 是(sched_getaffinity) |
| **clone标志位** | 完整 | 完整 | 完整 | 基础 | 完整 | 完整 |
| **ELF动态链接** | 是（PT_INTERP+辅助向量） | 是 | 是 | 是 | 是 | 是 |
| **信号机制** | 64/128位位图+实时信号+sigaltstack | 64种信号+sigaltstack | 64种信号+sigaltstack | 31种标准信号 | 64位位图+实时信号 | 实时信号队列+siginfo |
| **Futex** | 完整（WAIT/WAKE/REQUEUE/BITSET+robust） | 是（BTreeMap等待队列） | 是（超时+REQUEUE） | 无 | 是（BinaryHeap超时） | 完整（含robust list） |

**分析要点**：
- NPUcore-Ovo 的调度器在所有项目中遥遥领先：实现了 Linux 风格的三级调度层次（RT/CFS/Idle），CFS 包含完整的 nice 权重映射和 vruntime 计算。RT 调度使用 128 位位图实现 O(1) 复杂度。这是六个项目中唯一实现真正多级调度框架的内核。
- NPUcore-BLOSSOM 和 NPUcore-Aspera 的 FIFO 调度器过于简单，CPU 密集型任务可能饿死其他任务。
- TatlinOS 的 1Hz 时钟中断频率（1000ms 时间片）导致调度精度极差，这几乎是硬伤——nanosleep 的精度被限制在秒级。
- OSakura 的遍历式轮转 O(n) 效率最低，且抢占被注释，实为协作式调度。
- StarryX 依赖 ArceOS 基座调度器，缺乏自主的调度策略实现，灵活性受限。

---

## 五、文件系统对比

| 特性 | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|------|------------|-----------------|----------------|---------|----------|---------|
| **磁盘FS** | EXT4(extent)+FAT32 | EXT4(extent)+FAT32 | EXT4(extent)+FAT32 | EXT4(extent)+FAT32 | EXT4(via lwext4) | EXT4+FAT |
| **EXT4实现方式** | 自研（~8062行Rust） | 自研（~8000行Rust） | 自研（~6000行Rust） | 自研（C语言） | 封装C库lwext4 | 自研 |
| **Extent树** | 完整（搜索/分裂/插入/删除） | 完整 | 完整（创建/查找/插入/分裂） | 完整 | 依赖lwext4 | 实现 |
| **EXT4日志** | 无 | 无 | 无 | 无 | 依赖lwext4 | 未明确 |
| **VFS抽象** | trait VFS + File trait | trait VFS + File trait | trait VFS + File trait | 函数指针表 FS_OP_t | trait Inode + File | FileLike trait |
| **目录树缓存** | DirectoryTreeNode+RwLock+BTreeMap | DirectoryTreeNode+RwLock+BTreeMap | DirectoryTreeNode+Weak引用+全局缓存 | 无 | 简化挂载表 | Procfs/Devfs/Tmpfs |
| **procfs** | 丰富（status/maps/smaps/pagemap等） | 基础（meminfo/interrupts） | 基础（meminfo/interrupts） | 轻量（8个硬编码节点） | 无 | 完整（含/proc/[pid]/） |
| **设备文件** | 丰富（null/zero/urandom/tty/hwclock/loop等） | 基础（pipe/null/zero/urandom/tty） | 基础（pipe/tty/null/zero/urandom） | 无独立设备文件 | 无 | 完整（Devfs） |
| **管道** | 环形缓冲区 | 是 | 是 | 环形缓冲区 | 64KB环形缓冲区 | 64KB环形缓冲区 |
| **sendfile/splice** | 是 | 否 | 否 | 否 | 否 | 是 |
| **文件锁** | 未完整实现 | 未完整实现 | 未完整实现 | 无 | 未完整实现 | 未完整实现 |

**分析要点**：
- 所有项目都支持 EXT4 + FAT32 双文件系统，这在竞赛内核中属于较高水平。
- NPUcore-Ovo 的 EXT4 实现代码量最大（~8062行），自研 extent 树操作最完整。设备文件系统和 procfs 的丰富程度远超其他项目。
- OSakura 虽然代码量最小，但在 C 语言中自研实现了 extent 树，技术含量高。但目录项限制在单个 4KB 块是个硬伤。
- TatlinOS 选择封装 C 库 lwext4，开发效率高但丧失了自主掌控能力和 Rust 安全性优势。
- StarryX 的虚拟文件系统（procfs/devfs/tmpfs/etcfs）最为完整，且支持 sendfile/splice 等高级 I/O 接口。
- NPUcore-BLOSSOM 和 Aspera 的文件系统实现高度相似（同源），但两个项目的 procfs 都较为单薄。

---

## 六、网络子系统对比

| 特性 | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|------|------------|-----------------|----------------|---------|----------|---------|
| **TCP/UDP** | smoltcp封装 | smoltcp封装 | smoltcp封装 | 无 | 全局队列模拟 | smoltcp封装 |
| **Unix Socket** | 完整（STREAM/DGRAM/socketpair） | 未完整实现（todo!） | 未完整实现（todo!） | 无 | 双管道模拟 | 是 |
| **真实网卡驱动** | 无（仅loopback） | 无（仅loopback） | 无（仅loopback） | 无 | 无（仅127.0.0.1队列） | 未明确 |
| **epoll** | 否 | 否 | 否 | 否 | 否 | 是（含ET/ONESHOT） |
| **select/poll** | 否 | 否 | 否 | 否 | 否 | 是 |

**分析要点**：
- 所有项目的网络支持都较弱，均停留在 loopback 回环层面。这是竞赛内核的普遍短板。
- StarryX 在网络和 I/O 多路复用方面领先：同时支持 select/poll/epoll（含边缘触发和 ONESHOT），且 Unix Socket 实现完整。
- NPUcore-Ovo 的 Unix Socket 实现完整（STREAM/DGRAM/socketpair），优于 BLOSSOM 和 Aspera 的 todo!() 状态。
- TatlinOS 的网络是最弱的——全局队列模拟仅支持 127.0.0.1，是纯粹的桩实现。

---

## 七、系统调用与兼容性对比

| 特性 | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|------|------------|-----------------|----------------|---------|----------|---------|
| **系统调用数** | ~200+ | ~90 | 117（ID定义） | ~60 | ~100+ | ~200 |
| **分发方式** | 函数指针表(512槽位) | 函数指针表 | 函数指针表 | match/case | FromPrimitive枚举 | 函数指针表 |
| **高速路径优化** | 是（时间统计跳过） | 无 | 无 | 无 | 无 | 无 |
| **错误码覆盖** | 完整 | 完整 | 完整 | 部分 | 133个错误码 | 完整 |
| **System V IPC** | 部分 | 无 | 无 | 无 | 无 | 完整（MSG/SEM/SHM） |
| **POSIX IPC** | 无 | 无 | 无 | 无 | 无 | 无 |
| **LTP兼容层** | 是（专用BTreeMap存储元数据） | 无明确标记 | 无明确标记 | 无 | 无 | 无 |

**分析要点**：
- NPUcore-Ovo 和 StarryX 的系统调用覆盖面最广（~200个），且 NPUcore-Ovo 独有高速路径优化（高频调用跳过时间统计）。
- StarryX 在 System V IPC 三大机制（消息队列/信号量/共享内存）上实现最为完整，是唯一提供全部三种 IPC 的项目。
- NPUcore-Ovo 构建了 LTP 兼容性层（独立的 BTreeMap 存储测试路径属主/权限），体现了竞赛导向的实用工程方法。
- NPUcore-BLOSSOM 和 Aspera 的系统调用数偏少（90-117），但核心功能完备。
- OSakura 的 60 个系统调用中部分返回硬编码值（如 sys_times 返回固定值 100），部分权限检查直接返回 true。

---

## 八、技术亮点独特性分析

### NPUcore-Ovo
- **唯一实现三级调度框架（RT/CFS/Idle）的项目**，CFS 包含完整 nice 权重和 vruntime
- **唯一实现 SMP 多核支持**的项目，原子屏障同步和 `on_cpu` 防偷取机制
- **唯一实现内核态独立异常向量**的项目（`__kernelvec` 与 `__alltraps` 分离）
- ZRAM+Swap+OOM 三级回收形成完整内存压力闭环
- 系统调用高速路径优化和 LTP 兼容性层

### NPUcore-BLOSSOM
- **OOM 三级降级策略**设计完整：FS缓存清理→当前任务清理→全部任务清理
- 双架构 HAL 架构清晰，板级支持最广（6种板级配置）
- 64位信号掩码完整

### NPUcore-Aspera
- **LAFlex 页表 TLB Refill 内联汇编优化**：`__rfill` 直接处理 TLB 缺失，降低延迟
- **Frame 状态机**（InMemory/Compressed/SwappedOut/Unallocated）：页面在四种状态间无缝迁移
- 进程凭证完整建模（uid/euid/suid/fsuid + gid 系列）

### OSakura
- **C 语言自研 EXT4 extent 树**：在约 9600 行代码规模下实现完整的 extent 操作
- **函数指针表多文件系统抽象**：简单的设计解决了多文件系统切换问题
- 微内核级别的 procfs 实现方式（路径拦截+虚拟FD分配）

### TatlinOS
- **物理页缓存水位线机制**：HIGH=128/LOW=32/REFILL=16/FLUSH=64，批量分配减少锁竞争
- **GroupManager 共享页管理**：高效管理 mmap MAP_SHARED 场景
- **Futex 超时与定时器深度集成**：BinaryHeap 管理超时事件

### StarryX
- **四架构支持**（唯一覆盖 AArch64 和 x86_64 的项目）
- **三层分离的组件化架构**（API/核心/模块），可复用性最强
- **完整 System V IPC 三大机制**（唯一实现全部三种的项目）
- **epoll 支持边缘触发和 ONESHOT**
- Procfs/Devfs/Tmpfs/Etcfs 完整虚拟文件系统矩阵

---

## 九、不足与缺失总结

| 项目 | 关键不足 |
|------|---------|
| **NPUcore-Ovo** | 网络仅回环设备，无真实网卡驱动；部分系统调用返回 ENOSYS；~56 个编译 warning；无 ext4 日志 |
| **NPUcore-BLOSSOM** | 单核无 SMP；FIFO 调度过于简陋；Unix Socket 核心方法为 todo!()；错误处理混用 panic! 与 Result |
| **NPUcore-Aspera** | 单核无 SMP；FIFO 调度；Unix Socket 未实现；ZRAM/Swap 容量固定不可动态调整；无 ext4 日志 |
| **OSakura** | 无 CoW/无按需分页；单页分配限制；无 SMP；无网络；调度 O(n)遍历+禁用抢占；权限检查空缺；部分系统调用硬编码 |
| **TatlinOS** | 1Hz 时钟频率致调度精度极差；单核无 SMP；无 ZRAM/Swap/OOM；网络为桩实现；无 procfs；无 ext4 extent 自研能力 |
| **StarryX** | 依赖 ArceOS 基座，缺乏调度/内存底层自主性；msync/madvise 为存根；无 ZRAM/Swap；epoll 底层轮询转换性能受限 |

---

## 十、整体成熟度综合评分

以"能够支持标准 Linux 用户态环境（BusyBox/Bash/LTP 基础测试）"为基准，各维度权重如下：内存管理(20%)、进程调度(15%)、文件系统(20%)、系统调用(15%)、网络(10%)、架构设计(10%)、多核/并发(5%)、代码质量(5%)。

| 维度(权重) | NPUcore-Ovo | NPUcore-BLOSSOM | NPUcore-Aspera | OSakura | TatlinOS | StarryX |
|-----------|-------------|-----------------|----------------|---------|----------|---------|
| 内存管理(20%) | 9.5 | 8.5 | 9.0 | 4.5 | 7.5 | 8.0 |
| 进程调度(15%) | 9.5 | 5.0 | 5.0 | 4.0 | 4.0 | 6.0 |
| 文件系统(20%) | 9.0 | 8.0 | 8.0 | 7.0 | 7.5 | 8.5 |
| 系统调用(15%) | 9.0 | 6.5 | 7.0 | 5.0 | 7.0 | 9.0 |
| 网络(10%) | 5.5 | 4.5 | 4.5 | 2.0 | 2.0 | 7.0 |
| 架构设计(10%) | 9.0 | 7.5 | 8.0 | 5.5 | 7.5 | 8.5 |
| 多核/并发(5%) | 8.0 | 2.0 | 2.0 | 2.0 | 2.0 | 5.0 |
| 代码质量(5%) | 7.5 | 7.0 | 7.5 | 7.0 | 7.5 | 8.5 |
| **加权总分** | **8.68** | **6.73** | **7.03** | **4.93** | **6.33** | **7.83** |

---

## 十一、综合评价与排名

### 第一梯队：NPUcore-Ovo（8.68分）

NPUcore-Ovo 在所有项目中实现了最为全面和深入的内核功能。其三级调度框架（RT/CFS/Idle）、SMP 多核支持、ZRAM+Swap+OOM 三级内存回收闭环、以及 ~200+ 系统调用的覆盖范围，使其成为六个项目中唯一具备"准生产级"特征的内核。在架构设计上，trait 统一的 HAL 接口优于条件编译方案，内核态独立异常向量体现了对异常处理性能的关注。主要短板在网络子系统（仅 loopback）和 ext4 日志缺失，但这在所有对比项目中是共性问题。代码量 ~69,500 行体现了工程投入的深度。

### 第二梯队：StarryX（7.83分）

StarryX 凭借三层分离的组件化架构、四架构覆盖、完整的 System V IPC 和 epoll 支持位居第二。其虚拟文件系统矩阵（procfs/devfs/tmpfs/etcfs）最为完整，系统调用覆盖面与 Ovo 持平。主要扣分项在于对 ArceOS 基座的深度依赖——调度、物理内存管理、硬件抽象等核心能力不由自身掌控，这削弱了其作为"自研内核"的技术独立性。此外，msync/madvise 存根、无 ZRAM/Swap 也是明显短板。

### 第二梯队：NPUcore-Aspera（7.03分）

NPUcore-Aspera 在内存管理上引入了 Frame 状态机这一架构改进，LAFlex TLB Refill 内联汇编优化体现了对龙芯架构的深度适配。进程凭证的完整建模优于 BLOSSOM。但 FIFO 调度、单核限制、Unix Socket 缺失等问题与 BLOSSOM 共享。

### 第三梯队：NPUcore-BLOSSOM（6.73分）

NPUcore-BLOSSOM 的 OOM 三级降级策略和双文件系统支持是其优势，但因缺乏 Frame 状态机、系统调用数较少（~90）、Unix Socket 严重不完整而在 NPUcore 系列中排名低于 Aspera。

### 第三梯队：TatlinOS（6.33分）

TatlinOS 的物理页缓存水位线设计是亮点，但 1Hz 调度频率是严重硬伤——这导致 nanosleep 精度为秒级，无法满足任何实际定时需求。网络子系统为纯桩实现。但通过 lwext4 封装获得了稳定的 ext4 支持，VFS 抽象合理。

### 第四梯队：OSakura（4.93分）

OSakura 以约 9600 行 C 代码覆盖了操作系统的核心骨架，在代码规模最小的情况下实现了 ext4 extent 树，展现了良好的"性能密度"。但缺失 CoW、按需分页、SMP、网络、高级调度和有效权限控制，在完整度上与其他项目存在代差。

### 最终排名

| 排名 | 项目 | 得分 | 关键词 |
|------|------|------|--------|
| 1 | **NPUcore-Ovo** | 8.68 | 全功能领先：三级调度+SMP+ZRAM/Swap/OOM闭环 |
| 2 | **StarryX** | 7.83 | 架构最优雅：组件化+四架构+完整IPC+epoll |
| 3 | **NPUcore-Aspera** | 7.03 | 内存设计精巧：Frame状态机+LAFlex优化 |
| 4 | **NPUcore-BLOSSOM** | 6.73 | 功能扎实：OOM三级降级+双FS |
| 5 | **TatlinOS** | 6.33 | 页缓存机制优秀但1Hz调度是硬伤 |
| 6 | **OSakura** | 4.93 | 小而精：C语言自研extent树但基础机制缺失严重 |

---

## 十二、评审意见

NPUcore-Ovo 在本轮对比中展现出显著的综合优势。其在进程调度子系统中实现的 RT/CFS/Idle 三级调度框架是全部六个项目中独一无二的——这一特性直接将调度能力从"竞赛验证级"提升至"准生产级"。配合 SMP 多核支持（原子屏障同步 + `on_cpu` 防偷取机制），Ovo 在多核并发场景下的基础能力远超其他单核项目。内存管理方面，ZRAM（LZ4）+ Swap + OOM 三级回收形成的"内存压力-回收"闭环，使得内核在资源受限环境下具备切实的鲁棒性，这与 BLOSSOM/Aspera 的同类机制相当，但 Ovo 额外提供了基于优先级的页缓存淘汰策略和更丰富的 procfs 内存统计接口。

与同源的 NPUcore-BLOSSOM 和 NPUcore-Aspera 相比，Ovo 在共性功能（CoW、EXT4 extent、双架构 HAL、信号机制）基础上实现了显著的功能迭代：三级调度取代了 FIFO、SMP 取代了单核、~200 系统调用取代了 90-117、独立内核态异常向量和系统调用高速路径优化体现了对性能的考量。Aspera 的 Frame 状态机和 LAFlex TLB Refill 优化值得肯定，但 Ovo 在架构深度和功能广度上的领先是全方位的。

与采用不同技术路线的 StarryX 相比，Ovo 代表了"自研深度优先"的路线，而 StarryX 代表了"生态复用优先"的路线。StarryX 在 System V IPC 完整性、epoll 支持、虚拟文件系统矩阵方面有独到优势，但其对 ArceOS 基座的深度依赖意味着调度算法、物理内存管理、硬件抽象等核心能力不由自身掌控。Ovo 在这些方面保持了完全的自研能力，这在以"内核构建能力"为评判核心的竞赛场景中更为重要。

OSakura 和 TatlinOS 分别代表了 C 语言精简实现和 Rust 工程化实践两条路径。OSakura 以约六分之一的代码量覆盖了核心骨架，TatlinOS 的页缓存水位线设计值得借鉴，但两者在调度精度（TatlinOS 1Hz）、内存回收（两者均缺失）、并发支持（两者均单核）等关键维度上与第一梯队差距显著。

综合来看，NPUcore-Ovo 是六个项目中功能最全面、架构最深入、最具竞赛竞争力的内核作品。其核心优势在于：自研的三级调度框架和 SMP 支持确立了调度与并发维度的绝对领先，ZRAM+Swap+OOM 闭环提供了实际可用的内存压力应对能力，~200 系统调用和丰富的设备文件系统支撑了广泛的用户态兼容性。建议后续在真实网卡驱动、ext4 日志支持和文件锁语义等方面继续完善，以进一步提升系统的实用性和鲁棒性。