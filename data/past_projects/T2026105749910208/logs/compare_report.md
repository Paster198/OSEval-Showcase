# 对比分析报告

## 一、项目概览

本报告对以下六个 Rust 宏内核项目进行多维度的横向对比分析：

| 项目 | 学校 | 生态归属 | 架构支持 | 代码规模(行) | 系统调用数 |
|------|------|---------|---------|-------------|-----------|
| **wll_OS** | — | rCore/polyhal | RISC-V64, LoongArch64 | ~31,370 | ~173 |
| **Nonix OS** | 南开大学 | rCore/polyhal | RISC-V64, LoongArch64 | ~10,979 | 73 |
| **StarryX** | 杭州电子科技大学 | ArceOS | RISC-V64, LoongArch64 (+2) | ~22,800 | ~200 |
| **TatlinOS** | 华中科技大学 | 独立(TrustOS) | RISC-V64, LoongArch64 | ~100+文件 | 100+ |
| **Explosion OS** | 中山大学 | 独立(rCore衍生) | RISC-V64 (LoongArch64部分) | ~49,442 | ~75 |
| **MinotaurOS** | 哈尔滨工业大学 | 独立 | RISC-V64 | ~18,684 | 120+ |

---

## 二、架构设计对比

### 2.1 内核类型与分层方式

| 项目 | 内核类型 | 分层方式 | 模块化程度 |
|------|---------|---------|-----------|
| **wll_OS** | 宏内核 | 子系统平行分层：syscall/fs/mm/task/trap/drivers 六层，通过 polyhal HAL 隔离架构 | 高。子系统间接口清晰，共享数据结构（TCB/MemorySet/VFS）通过 Arc<Mutex<>> 交互 |
| **Nonix OS** | 宏内核 | 子系统平行分层，polyhal HAL 层隔离架构 | 中高。模块划分清晰但共享数据结构耦合度稍高，部分模块（如信号）与其他子系统集成较浅 |
| **StarryX** | 宏内核 | **三层分离**：xapi(系统调用API)/xcore(核心逻辑)/xmodules(可复用模块)，ArceOS基座提供HAL | 最高。API-核心-模块三层严格分离，6个独立子crate，体现清晰的组件化设计哲学 |
| **TatlinOS** | 宏内核 | 子系统平行分层，arch/ 目录按架构分离，cfg_if 条件编译 | 中高。PCB/TCB分离设计体现良好抽象，但子系统间文件交织较多 |
| **Explosion OS** | 宏内核 | 子系统平行分层，hal/ trait抽象 + cfg_if条件编译，7个独立crate | 中高。7个独立crate体现了良好的模块边界意识，但内核主体子系统耦合度中等 |
| **MinotaurOS** | 宏内核(异步) | 子系统平行分层，arch/ 目录按架构分离，异步trait统一IO抽象 | 高。全异步设计强制清晰的接口边界，4种内存区域统一抽象体现了高度模块化 |

### 2.2 硬件抽象策略

| 项目 | HAL策略 | 架构隔离方式 | 代码复用率评估 |
|------|---------|-------------|--------------|
| **wll_OS** | polyhal (3个patched crate) | 条件编译 `#[cfg(target_arch)]` + polyhal trait统一接口 | 高。启动汇编、页表、陷阱、定时器均保持架构独立，内核主体逻辑架构无关 |
| **Nonix OS** | polyhal (上游) | 条件编译 + polyhal trait | 高。与wll_OS共享polyhal生态，双架构适配模式相似 |
| **StarryX** | ArceOS基座提供HAL | ArceOS框架统一抽象，架构相关代码集中在基座 | 最高。HAL完全由成熟框架提供，项目自身无需处理架构差异 |
| **TatlinOS** | 自研arch/目录 | cfg_if + trait + 独立汇编文件 | 中高。自研HAL需要维护两套架构代码，但抽象层设计合理 |
| **Explosion OS** | 自研hal/目录 + trait | Trait定义架构无关接口 + cfg_if选择实现 | 中。RISC-V实现完整，LoongArch64仅20%完成度，HAL设计存在但未完全验证 |
| **MinotaurOS** | 自研arch/rv64/ | 仅RISC-V64，无多架构需求 | 低(单架构)。无需多架构抽象，但代码组织清晰 |

---

## 三、子系统实现对比

### 3.1 内存管理

| 特性 | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|------|--------|----------|---------|----------|-------------|-----------|
| 物理页分配器 | 伙伴系统+RAII FrameTracker | 伙伴系统+RAII FrameTracker | ArceOS基座提供 | 伙伴系统+**PageCache(水位线)** | 栈式分配器+RAII FrameTracker | 伙伴系统(内核)+独立用户分配器 |
| 虚拟内存 | MemorySet+MapArea | MemorySet+MapArea | XUserSpace+VmaManager | MemorySet+MapArea | MemorySet+MapArea | AddressSpace+4种Region |
| 写时复制(COW) | 完整(软件COW标志位) | 完整(shallow_clone+引用计数) | 完整 | 完整 | 完整(fork_cow存在但默认fork为全复制) | 完整 |
| 懒分配 | 完整 | 完整(栈预分配8页) | 完整(按需分页+页错误处理) | 完整 | 完整 | 完整(LazyRegion) |
| mmap/munmap/mprotect | 完整(含文件映射+共享映射) | 完整(含mmap共享组) | 完整(含2M/1G大页) | 完整 | 完整 | 完整(FileRegion+SharedRegion) |
| System V共享内存 | 完整(shmget/shmat/shmctl) | 完整 | 完整 | 完整(含GroupManager) | 未实现 | 完整 |
| 页缓存 | ext4专用(PageCacheDirtyModel状态机) | 无 | LRU页缓存(完整状态追踪) | 物理页缓存(仅用于分配优化) | PageCache结构存在但未完全集成 | 完整异步页缓存 |
| Swap/页面置换 | 无 | 无 | 无 | 无 | 无 | 无 |

**内存管理评价**：
- **wll_OS** 的内存管理在功能性上最全面：COW、懒分配、mmap全系列、System V共享内存、ext4专用脏页追踪与回写状态机。MemFS的Inline/Chunked双模存储是独特的工程优化。
- **MinotaurOS** 的4种内存区域统一抽象（Lazy/File/Shared/Direct）在架构优雅性上最优，且具备ASID动态管理。
- **TatlinOS** 的物理页缓存（水位线机制）是针对分配性能的独特优化，GroupManager解决了mmap共享的物理帧管理问题。
- **StarryX** 的LRU页缓存与VMA管理结合大页支持，在成熟度上表现突出但部分接口（msync/madvise）为存根。
- **Nonix OS** 的mmap共享组（GROUP_SHARE）设计精巧，但缺少页缓存层。
- **Explosion OS** 的COW fork存在但默认使用全复制fork，PageCache未完全集成。

### 3.2 文件系统

| 特性 | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|------|--------|----------|---------|----------|-------------|-----------|
| VFS抽象 | FileDescriptor枚举+多后端路由 | File trait+FileClass枚举 | FileLike trait统一抽象 | Inode+File trait | File trait统一抽象 | Inode+File异步trait |
| ext4支持 | ext4_rs集成+路径/目录/文件缓存 | lwext4 C FFI | ext4_rs集成 | lwext4 Rust封装 | **自研~7,000行** | lwext4_rust集成 |
| ext4写回 | **完整**(PageCacheDirtyModel+WRITEBACK_QUEUE) | 无(每次open/close) | 基于LRU页缓存 | 基础 | 无 | 基于异步页缓存 |
| 虚拟文件系统 | MemFS(预置程序)+/proc(动态注册) | 虚拟文件注册表(/proc静态) | Procfs/Devfs/Tmpfs/Etcfs | 无虚拟文件系统 | /proc(静态伪文件) | tmpfs/devfs/procfs |
| 管道 | 64KB环形缓冲区 | **32字节**(严重瓶颈) | 64KB环形缓冲区 | 64KB环形缓冲区 | 实现 | 实现(异步) |
| eventfd | 完整 | 无 | 无 | 无 | 无 | 无 |
| epoll | 完整(level-triggered) | 无 | 完整(ET+ONESHOT) | 无 | 无 | 无(仅ppoll/pselect) |
| VFAT | 只读实现(~344行) | 无 | FAT支持 | 无 | 无 | FAT32(存在但未详述) |
| 文件锁 | OFD锁(F_SETLK/F_SETLKW) | 无 | 未提及 | 无 | 无 | 未提及 |

**文件系统评价**：
- **wll_OS** 的文件系统在广度上明显领先：MemFS+ext4+VFAT三后端混合、完整的ext4脏页写回、eventfd、epoll、文件锁、多模式文件存储。VFS层通过挂载表路由是最灵活的方案。
- **Explosion OS** 的自研ext4（~7,000行，支持extent树）工程量最大，但缺少日志和写回缓存。
- **StarryX** 的虚拟文件系统覆盖最全面（Procfs/Devfs/Tmpfs/Etcfs四种），且支持FAT。
- **MinotaurOS** 的异步VFS设计最优雅，但procfs节点覆盖率低。
- **Nonix OS** 的32字节管道缓冲区在所有项目中是最小的，严重制约I/O性能。lwext4 C FFI的每次操作open/close模式也引入了不必要的开销。
- **TatlinOS** 缺少虚拟文件系统是明显的功能短板。

### 3.3 进程与调度

| 特性 | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|------|--------|----------|---------|----------|-------------|-----------|
| 进程模型 | TCB(含线程组TGID) | TCB | XProcess+XThread分离 | **PCB/TCB分离** | PCB/TCB分离 | Process+Thread分离 |
| clone标志支持 | CLONE_VM/FS/FILES/SIGHAND/VFORK/THREAD/SETTLS等 | SHARE_VM/SHARE_FILES | CLONE_VM/FS/FILES/SIGHAND/THREAD/VFORK/SETTLS等 | CLONE_VM/FS/FILES/SIGHAND/THREAD等 | CLONE_VM/FS/FILES/SIGHAND等 | CLONE_VM/THREAD/FS/FILES等 |
| 调度算法 | **优先级+RT有界公平性** | FIFO | 依赖ArceOS基座 | Round-Robin@**1Hz** | FIFO | **双队列异步**(优先级+FIFO) |
| 多核支持 | 单核 | 单核(仅hart0) | 依赖ArceOS基座 | 单核(HART_NUM=1) | 声称支持但UPIntrFreeCell限制 | **多核**(Hart管理) |
| 进程组/会话 | 线程组(ThreadGroup) | 基础支持 | **完整**(进程组+会话) | 有限 | 未实现 | 有限 |
| 凭证模型 | 完整POSIX(uid/gid四件套+附属组) | 统一root | 完整 | 基础 | 基础 | **Linux Capabilities** |
| 资源限制 | rlimit(部分) | 软/硬限制(仅FD) | getrlimit/setrlimit/prlimit64 | 基础 | 基础rlimit | rusage统计 |
| Futex | 完整(WAIT/WAKE/BITSET/REQUEUE/CMP_REQUEUE) | 无 | 完整(含robust list) | 完整(WAIT/WAKE/REQUEUE/BITSET+**定时器深度集成**) | 无 | 完整(WAIT/WAKE/REQUEUE) |
| 命名空间 | 无 | 无 | 基础(thread-local) | 无 | 无 | Mount Namespace |

**进程调度评价**：
- **wll_OS** 的调度器在单核场景下功能最丰富：用户/内核双就绪队列、优先级调度、RT有界公平性、前台驱动模式。凭证模型最完整。
- **MinotaurOS** 的全异步调度模型在架构创新性上最突出，且是唯一真正支持多核的项目。
- **StarryX** 的进程组/会话管理最完整，Futex支持最全面（含robust list）。
- **TatlinOS** 的PCB/TCB分离设计最清晰，但**1Hz时钟中断频率**是所有项目中最严重的性能瓶颈。
- **Nonix OS** 和 **Explosion OS** 的FIFO调度最为基础，且Nonix的Futex完全缺失。
- 仅MinotaurOS实现了Linux Capabilities权限模型。

### 3.4 信号机制

| 特性 | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|------|--------|----------|---------|----------|-------------|-----------|
| 信号集大小 | 标准POSIX | 32个标准信号 | **完整POSIX+实时信号** | **64位(含实时信号)** | 64位掩码 | 完整信号队列 |
| sigaction | 完整(SA_SIGINFO/SA_RESTART/SA_NODEFER/SA_RESETHAND) | 基础 | 完整 | 完整 | 基础(动作注册) | 完整 |
| sigprocmask | 完整 | 完整 | 完整 | 完整 | 未实现 | 完整 |
| sigreturn | **完整(trampoline)** | **未实现(触发panic)** | 完整(trampoline) | **完整** | **不完整** | **完整(含浮点上下文)** |
| 实时信号排队 | 无 | 无 | 支持 | 支持 | 无 | 支持 |
| sigaltstack | 未实现 | 未实现 | 支持 | 未提及 | 未实现 | 未提及 |
| 信号与Futex交互 | 完整 | 无Futex | 完整 | 完整 | 无Futex | 完整(事件总线) |

**信号机制评价**：
- **StarryX** 的信号系统最完整：实时信号排队、siginfo、sigaltstack、多架构trampoline。
- **MinotaurOS** 的信号与事件总线深度集成，且支持浮点上下文恢复。
- **wll_OS** 的信号实现完整且正确，trampoline机制完善。
- **Nonix OS** 的sigreturn未实现（触发panic）是**致命缺陷**——任何用户态自定义信号处理函数执行后无法返回。
- **Explosion OS** 的信号trampoline不完整，主要依赖致命信号终止进程。

### 3.5 网络支持

| 特性 | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|------|--------|----------|---------|----------|-------------|-----------|
| UNIX域套接字 | SOCK_STREAM+SOCK_DGRAM | 无 | 支持 | 双pipe模拟 | 未提及 | socketpair only |
| INET套接字 | AF_INET/AF_INET6本地回环 | 无 | TCP/UDP | **桩实现**(127.0.0.1队列) | **自研协议栈**(ARP/IP/TCP/UDP) | **smoltcp TCP/UDP**(仅loopback) |
| epoll | 完整(LT) | 无 | 完整(ET+ONESHOT) | 无 | 无 | 无 |
| select/poll | 未明确 | pselect6/ppoll存根 | select/poll | 未明确 | 未明确 | ppoll/pselect6 |
| TCP状态机 | 无 | 无 | 依赖基座 | 无 | 无(缺失) | smoltcp提供 |
| 物理网卡驱动 | 无 | 无 | 依赖基座 | 无 | VirtIO网卡(已驱动) | VirtIO网卡(**未集成**) |

**网络评价**：
- **StarryX** 的网络功能最完整：TCP/UDP、Unix Socket、epoll全系列。
- **Explosion OS** 的自研协议栈工程量最大，但TCP缺乏状态机和可靠性保障。
- **wll_OS** 的UNIX域套接字实现（DGRAM+STREAM双模式）和AF_INET本地回环在无外部协议栈依赖的项目中覆盖面最广。
- **MinotaurOS** 基于smoltcp的协议栈最成熟但网卡驱动未集成，实际只能本地回环。
- **TatlinOS** 的网络是纯粹的桩实现。
- **Nonix OS** 完全无网络支持。

### 3.6 系统调用覆盖率

| 类别 | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|------|--------|----------|---------|----------|-------------|-----------|
| 文件IO | ~75 | ~30 | ~50+ | ~40+ | ~30 | ~40+ |
| 进程管理 | ~10 | ~15 | ~15 | ~10+ | ~10 | ~10+ |
| 内存管理 | ~9 | ~7 | ~8 | ~7 | ~8 | ~8 |
| 信号 | ~8 | ~6(含伪实现) | ~10+ | ~8+ | ~5 | ~8+ |
| 网络 | ~14 | 0 | ~20+ | ~5(桩) | ~10 | ~15+ |
| IPC | ~5 | ~3 | ~10 | ~3 | ~3 | ~5 |
| 同步 | ~5 | 0(Futex缺失) | ~5 | ~5 | ~5 | ~5 |
| 系统管理 | ~47 | ~12 | ~30+ | ~20+ | ~10 | ~25+ |
| **总计** | **~173** | **73** | **~200** | **100+** | **~75** | **120+** |

---

## 四、技术亮点对比

| 项目 | 核心技术创新 | 工程亮点 |
|------|------------|---------|
| **wll_OS** | 内建评测Harness+前台驱动调度模式；MemFS Inline/Chunked双模存储；ext4 PageCacheDirtyModel状态机脏页追踪与异步回写队列 | 构建时ELF预载机制；Whiteout覆盖删除语义；OFD文件锁；用户/内核双就绪队列+RT有界公平性 |
| **Nonix OS** | mmap共享组(GROUP_SHARE)解决fork后物理帧共享管理 | polyhal双架构适配完整；稀疏文件写入支持；动态虚拟文件注册表 |
| **StarryX** | 三层分离的模块化架构(xapi/xcore/xmodules)；完整System V IPC三大机制(消息队列/信号量含SEM_UNDO/共享内存) | LRU页缓存含完整状态追踪；epoll边缘触发+ONESHOT；2M/1G大页支持 |
| **TatlinOS** | 物理页缓存(水位线控制)优化分配性能；GroupManager管理mmap共享页；Futex与定时器深度集成 | PCB/TCB完全分离设计；双架构统一抽象代码复用率高；完整64位信号集 |
| **Explosion OS** | **从零自研EXT4(~7,000行)**含extent树与块分配；自研网络协议栈(lose-net-stack) | 7个独立crate模块化设计；Trait+HAL架构隔离；ELF AUXV完整构建 |
| **MinotaurOS** | **全异步内核设计**(async/await统一并发)；事件总线(EventBus)统一信号与异步等待；4种内存区域统一抽象 | ASID动态检测与LRU管理；ELF快照缓存加速execve；5种Mutex策略适应不同上下文；Linux Capabilities权限模型 |

---

## 五、不足与缺失对比

| 项目 | 致命/严重缺陷 | 重要缺失 | 改进空间 |
|------|-------------|---------|---------|
| **wll_OS** | 无 | 单核设计；无TCP/IP协议栈；调度器非CFS；缺实时信号排队；msync为存根 | SMP多核；完整网络协议栈；多级反馈队列调度；内核抢占 |
| **Nonix OS** | **sigreturn未实现(触发panic)**——用户自定义信号处理致命缺陷 | **管道仅32字节**；Futex缺失；FIFO单核调度；ext4每次操作open/close；网络完全缺失 | 修复sigreturn；重写管道；实现Futex；引入页缓存 |
| **StarryX** | 无 | msync/madvise为存根；epoll底层基于poll轮询(非回调)；缺cgroups/完整namespace；依赖ArceOS基座 | 实现真正epoll就绪队列；补充资源隔离机制 |
| **TatlinOS** | **时钟中断1Hz**——时间精度极差(nanosleep最小粒度1秒) | 网络为纯桩；缺虚拟文件系统；单核Round-Robin；无页缓存(文件) | 提高时钟频率至100-1000Hz；实现procfs；重构调度器 |
| **Explosion OS** | 信号trampoline不完整；TCP无状态机/重传/拥塞控制 | LoongArch64仅20%完成度；COW fork未默认启用；PageCache未集成；Futex缺失；FIFO调度 | 完成信号trampoline；完善TCP状态机；恢复默认COW fork |
| **MinotaurOS** | 网卡驱动未集成导致网络仅本地回环 | 仅RISC-V；缺epoll；缺完整命名空间隔离；Unix Socket仅socketpair | 集成网卡驱动；实现epoll；增加多架构支持 |

---

## 六、整体成熟度综合评分

以构建一个能稳定运行Linux用户态程序的宏内核为基准（100%），各项目评分如下：

| 维度(权重) | wll_OS | Nonix OS | StarryX | TatlinOS | Explosion OS | MinotaurOS |
|-----------|--------|----------|---------|----------|-------------|-----------|
| 内存管理(20%) | 85 | 80 | 85 | 85 | 75 | 90 |
| 文件系统(20%) | 85 | 65 | 85 | 70 | 75 | 80 |
| 进程调度(15%) | 70 | 50 | 75 | 55 | 55 | 80 |
| 信号机制(10%) | 70 | 35 | 90 | 80 | 45 | 85 |
| 系统调用(15%) | 80 | 60 | 85 | 70 | 60 | 75 |
| 网络(10%) | 45 | 0 | 80 | 15 | 55 | 60 |
| 架构抽象(5%) | 85 | 85 | 90 | 80 | 60 | 50 |
| 工程成熟度(5%) | 90 | 70 | 90 | 75 | 80 | 85 |
| **加权总分** | **77.8** | **56.5** | **83.0** | **65.5** | **65.0** | **77.8** |

**排名**：
1. **StarryX** (83.0) — 得益于ArceOS基座和三层架构，在系统调用覆盖面和信号/IPC上优势明显
2. **wll_OS** 与 **MinotaurOS** 并列 (77.8) — wll_OS在文件系统和工程成熟度上领先，MinotaurOS在架构创新和调度上领先
3. **TatlinOS** (65.5) — 核心机制扎实但时钟精度和网络是明显短板
4. **Explosion OS** (65.0) — 工程量最大但关键子系统完成度不足
5. **Nonix OS** (56.5) — sigreturn致命缺陷和管道瓶颈拉低了整体评价

---

## 七、各项目总结评价

### wll_OS
wll_OS 是一个**功能覆盖面最广、工程成熟度最高**的自研宏内核项目。其核心优势在于：约173个系统调用的广泛覆盖、MemFS+ext4+VFAT三后端混合VFS（含完整脏页写回状态机）、完善的UNIX域套接字实现、以及独特的评测Harness与前台驱动调度模式。代码结构清晰，RAII和TOCTOU安全等待队列体现了良好的系统编程素养。主要不足在于单核限制和无TCP/IP协议栈。在六个项目中，wll_OS是自研程度与功能完整度平衡最好的项目之一。

### Nonix OS
Nonix OS 是一个**架构设计有亮点但关键实现存在致命缺陷**的项目。其mmap共享组机制和polyhal双架构适配展现了良好的设计能力。然而，sigreturn的未实现（触发panic）意味着任何用户态自定义信号处理函数无法正常返回，这是POSIX兼容性的致命伤。32字节管道缓冲区也严重制约I/O性能。该项目在代码规模最小（~10,979行）的情况下实现了73个系统调用，性价比尚可，但需优先修复致命缺陷。

### StarryX
StarryX 是六个项目中**整体完整度最高**的项目。基于ArceOS框架的三层架构设计（xapi/xcore/xmodules）展现了成熟的软件工程能力。约200个系统调用、完整的System V IPC、全功能epoll、以及LRU页缓存使其在功能广度和深度上领先。但该项目高度依赖ArceOS基座，自身在调度、硬件抽象等核心基础设施上的自主性较弱。部分系统调用（msync、madvise）为存根实现，epoll底层基于poll轮询转换而非高效的事件回调机制。

### TatlinOS
TatlinOS 在**核心内存管理机制上表现突出**。物理页缓存（水位线控制）和GroupManager是独特的工程优化，PCB/TCB分离设计清晰，Futex与定时器的深度集成也体现了良好的系统思维。然而，**1Hz时钟中断频率**是该项目的阿喀琉斯之踵——导致nanosleep等时间相关系统调用精度极差（最小粒度1秒），严重削弱了实际可用性。网络子系统为纯桩实现，缺少虚拟文件系统也是明显的功能短板。

### Explosion OS
Explosion OS 是六个项目中**工程量最大、自研比例最高**的项目。从零构建近7,000行EXT4文件系统和自研网络协议栈展现了惊人的工程雄心。然而，这种"全栈自研"策略也导致了关键子系统完成度不足的问题：TCP缺乏状态机和重传机制，信号trampoline不完整，COW fork未默认启用，LoongArch64移植仅20%完成度。该项目在功能广度上表现突出但深度不足，未来需要集中精力完善核心路径的可靠性。

### MinotaurOS
MinotaurOS 是六个项目中**架构设计最具创新性**的项目。全异步内核设计通过async/await和事件总线统一了系统调用、IO操作与进程调度的并发模型，4种内存区域统一抽象和ELF快照缓存体现了高水平的架构思维。作为唯一真正支持多核的项目，其在并发模型上的探索具有独特价值。然而，仅支持RISC-V单架构、网卡驱动未集成、缺少epoll等高效IO机制限制了其实用性。该项目更适合作为异步内核架构的研究参考而非生产级系统。

---

## 八、综合评审意见

本次对比的六个Rust宏内核项目代表了当前国内高校操作系统竞赛领域的较高水平，各项目在不同维度上各有建树。

在**工程完整度与实用导向**上，StarryX和wll_OS表现最为突出。StarryX借助ArceOS框架实现了最广泛的系统调用覆盖和最完整的IPC/信号体系；wll_OS则在自研前提下实现了接近的系统调用广度（173个），且在文件系统（MemFS+ext4混合VFS+脏页回写）和评测基础设施（内建Harness）上有独特优势。两者分别代表了"框架化构建"和"独立自研"两条路径的最佳实践。

在**架构创新与学术价值**上，MinotaurOS的全异步内核设计独树一帜。其事件总线、统一内存区域抽象、以及async/await在系统调用层的应用，为Rust异步内核的研究提供了有价值的参考实现。TatlinOS的物理页缓存水位线机制和Futex-定时器深度集成也体现了精巧的系统优化思维。

在**工程雄心与代码产量**上，Explosion OS的自研EXT4（~7,000行）和自研网络协议栈展现了最高的工作量投入。然而，这种"全栈自研"策略在有限竞赛周期内导致了核心路径可靠性的牺牲，是一种高风险高回报的选择。

在**基础架构与双架构支持**上，Nonix OS、TatlinOS与wll_OS共享polyhal或类似的双架构抽象方案，为RISC-V与LoongArch的跨平台内核开发提供了可复用的参考模式。

综合来看，**StarryX**在整体成熟度上排名第一，**wll_OS**和**MinotaurOS**并列第二——前者是自研宏内核中功能最全面的项目，后者是架构创新性最强的项目。对于后续开发者，建议关注以下方向：(1) 多核SMP支持是所有项目的共同短板；(2) 完整TCP/IP协议栈的集成是提升实用性的关键路径；(3) 信号系统的正确性（尤其是sigreturn和trampoline）应作为基础门槛而非可选特性；(4) 调度器的高级化（CFS或类似公平调度）是提升系统整体性能的核心环节。