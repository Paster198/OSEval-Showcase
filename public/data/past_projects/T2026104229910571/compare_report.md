# 对比分析报告

## 一、项目基本信息对比

| 维度 | OSKernel2026-X (当前项目) | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------------------|--------|----------|------------|-------------|------------|
| **开发团队** | 当前团队 | 河南科技大学-海底小纵队 | 天津大学-Moncake | 哈尔滨工业大学-练习时长两年半 | 清华大学-undefined | 杭州电子科技大学-NoAxiom |
| **代码规模** | ~19,418行Rust / 18 crate | ~5,500行(估计) / 94 vendor crate | ~13,700行 / 13 crate / 85 vendor | ~18,684行 | ~100+文件 / 6 workspace crate | ~356文件(kernel+lib) |
| **支持架构** | RISC-V64, LoongArch64, x86_64, AArch64 | RISC-V64, x86_64, AArch64, LoongArch64 | RISC-V64, LoongArch64 | RISC-V64 | x86_64, AArch64, RISC-V64, LoongArch64 | RISC-V64, LoongArch64 |
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核(ArceOS组件化) | 宏内核 |
| **生态系统** | ByteOS(继承) | 无(原创) | ByteOS(继承) | 无(原创) | ArceOS(继承) | 无(原创) |
| **构建验证** | 未完成(工具链不匹配) | 成功(669KB) | 成功 | 失败(Git依赖不可达) | 未报告 | 失败(测试镜像缺失) |

---

## 二、架构设计对比

### 2.1 内核分层设计

| 分层维度 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|---------|--------------|--------|----------|------------|-------------|------------|
| HAL抽象层 | polyhal (4架构) | polyhal (4架构) | polyhal v0.2.4 (2架构) | 自研arch/rv64 (1架构) | ArceOS axhal (4架构) | 自研lib/arch (2架构 trait体系) |
| 执行器/调度 | executor crate, FIFO协作式 | executor, FIFO协作式 | executor, FIFO协作式 | 自研异步执行器+事件总线 | 传统同步模型 | MultiLevelScheduler (实时+普通+CFS废弃) |
| 同步原语 | spinlock (Mutex/RwLock/LazyInit) | spinlock | spinlock | IrqMutex, AsyncMutex, 多种锁 | spin::RwLock + WaitQueue | SpinLock + SyncUnsafeCell |
| 模块化程度 | 高(18 crate) | 中 | 中(13 crate) | 中(monolithic) | 高(6 workspace crate + 组件化) | 高(kernel + lib分离) |

### 2.2 架构设计评价

**OSKernel2026-X**: 分层最为完善。18个独立crate形成清晰的依赖层次：基础库层(crates/) → 驱动层(driver/) → 文件系统层(filesystem/) → 内核层(kernel/src/) → 系统调用层(syscall/)。polyhal HAL实现了四种架构的trap处理，在选中项目中架构覆盖最广(与ByteOS、Undefined-OS持平)。但同步机制仅基于spinlock，在SMP场景下存在扩展性短板。

**ByteOS**: OSKernel2026-X的直接前身。分层结构基本一致但crate划分较粗。驱动注册采用linkme分布式切片是原创设计。缺点是Waker实现为空操作，导致被阻塞任务无法被真正唤醒，仅能依赖轮询。

**MonkeyOS**: 在ByteOS基础上的二次开发，架构高度相似。主要增量在LoongArch PCI枚举和双C库支持，但多核启动代码被注释，实际仅单核运行。代码中遗留大量调试输出(~300行)，工程成熟度受影响。

**MinotaurOS**: 独立实现的异步内核，架构最为统一。事件总线机制将信号、中断与异步等待优雅结合，是五个项目中异步模型设计最完整的。四种内存区域类型(LazyRegion/FileRegion/SharedRegion/DirectRegion)的抽象层次清晰。ASID管理使用LRU缓存优化TLB刷新。

**Undefined-OS**: 唯一基于ArceOS框架的项目。组件化设计带来高内聚低耦合的优势，但受限于ArceOS的框架约束。四层进程模型(Session→ProcessGroup→Process→Thread)是唯一完整实现POSIX会话/进程组层次结构的项目。但mount/umount被注释为no-op，部分功能仅完成框架。

**NoAxiom-OS**: 架构设计最具工程深度的项目。lib/arch/中的trait体系定义了10+个架构抽象接口，比polyhal更细粒度。任务结构体按并发访问模式分类(锁保护/线程独占/不可变/共享)，体现了对并发安全性的深入考量。MultiLevelScheduler是唯一实现多级优先级调度的项目。

---

## 三、子系统实现对比

### 3.1 进程管理

| 特性 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------|--------|----------|------------|-------------|------------|
| 进程/线程模型 | 1进程:N线程 | 1进程:N线程 | 1进程:N线程 | 1进程:N线程 | Session→PG→Process→Thread | 1进程:N线程 |
| fork/clone | 完整(COW) | 完整(COW) | 完整(COW) | 完整(COW) | 完整(含CLONE_VFORK等) | 完整(含vfork) |
| execve | 含解释器+动态链接 | 含解释器+动态链接 | 含解释器+动态链接+模板缓存 | 含ELF快照缓存(LRU=4) | 含脚本解释器递归 | 含动态链接器 |
| 进程组/会话 | 基础支持 | 缺失 | 基础支持 | 未提及 | 完整实现 | 完整(PG管理+孤儿回收) |
| 退出/wait | exit/exit_group/wait4 | exit/exit_group/wait4 | exit/exit_group/wait4 | exit/wait4 | exit/exit_group/wait4(含WNOHANG等) | exit/wait4(含WNOHANG) |
| robust_list | 未提及 | 未提及 | 支持 | 未提及 | 未提及 | 支持 |
| **评分** | **80%** | **75%** | **78%** | **85%** | **90%** | **88%** |

进程管理方面，Undefined-OS以四层模型和完整会话管理领先；NoAxiom-OS在并发安全分类和vfork/孤儿回收方面最细致；MinotaurOS的ELF快照缓存实现富有创意；OSKernel2026-X覆盖了基础功能但在进程组层次结构上有欠缺。

### 3.2 内存管理

| 特性 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------|--------|----------|------------|-------------|------------|
| COW机制 | Arc引用计数 | Arc引用计数 | Arc引用计数 | Arc引用计数 | ArceOS axmm | 引用计数+PageState |
| mmap/munmap | 完整 | 完整 | 完整 | 完整(含MAP_SHARED回写) | 完整(含大页) | 完整(含MAP_HUGETLB) |
| mprotect | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |
| 共享内存 | shmget/shmat/shmctl | shmget/shmat/shmctl | 支持 | SysV共享内存 | shmget/shmat/shmdt/shmctl | 支持 |
| 页缓存 | 无 | 无 | 无 | PageCache集成 | 无 | PageCache(MSI协议)+BlockCache(LRU) |
| madvise/msync | madvise(ENOSYS)/mremap(ENOSYS) | 缺失 | 缺失 | 未提及 | madvise(部分) | msync(仅在Drop触发) |
| 大页支持 | 无 | 无 | 无 | 直接映射2MB大页 | MAP_HUGE_2MB/1GB | MAP_HUGETLB |
| ASID管理 | 无 | 无 | 无 | LRU缓存 | 未提及 | 未提及 |
| brk | 支持 | 支持 | 支持 | 支持 | 仅改指针不映射 | 支持 |
| **评分** | **70%** | **68%** | **68%** | **88%** | **75%** | **82%** |

MinotaurOS在内存管理方面明显领先，四种区域类型+页缓存+ASID管理的组合最为完整。NoAxiom-OS的MSI页缓存协议在竞赛场景下具有性能优势。OSKernel2026-X的COW实现简洁但缺少页缓存层。

### 3.3 文件系统

| 特性 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------|--------|----------|------------|-------------|------------|
| VFS抽象 | INodeInterface(27方法) | INodeInterface | INodeInterface | Inode + File双trait(异步) | FileLike trait | Dentry+Inode+File+SuperBlock |
| ext4 | lwext4(C)+ext4_rs(Rust)双后端 | FAT32 | lwext4(C)+FAT32 | lwext4_rust(C) | lwext4(C) | ext4_rs(Rust) |
| FAT32 | fatfs(条件编译) | 支持 | 支持 | 无 | 无 | 自研FAT32完整实现 |
| RAMFS | 支持(页帧+硬链接+符号链接) | 支持 | 支持 | 无 | 无(tmpfs替代) | 支持 |
| DevFS | /dev/null,zero,ttyv0,rtc,urandom等10个 | 支持 | 支持 | 支持 | DynamicFs(builder模式) | /dev/null,zero,urandom,tty,rtc,loop |
| ProcFS | /proc/mounts,meminfo,self,exe等~15项 | 支持 | 支持 | 支持 | 两套实现(proc.rs+proc1/) | /proc/<pid>/status,stat,exe,fd,maps等 |
| 管道 | PipeSender/PipeReceiver,320KB | 支持 | 支持 | 支持 | PipeRingBuffer(64KB) | 环形缓冲区+异步等待 |
| 页缓存 | 无 | 无 | 无 | PageCache | 无 | MSI协议缓存 |
| Epoll | epoll_create1/ctl/pwait | 基础实现(60%) | 基础实现 | 未明确 | epoll(无EPOLLET) | 无(仅ppoll/pselect) |
| sendfile/copy_file_range | 支持 | 未提及 | 未提及 | 未提及 | copy_file_range | sendfile/splice/copy_file_range |
| inotify | 无 | 无 | 无 | 支持 | 无 | 无 |
| mount/umount | 支持(启动时) | 支持 | 支持 | 未提及 | 注释为no-op | 支持 |
| **评分** | **80%** | **72%** | **75%** | **82%** | **78%** | **85%** |

NoAxiom-OS在文件系统方面最为全面：自研FAT32+MSI页缓存+块缓存+丰富ProcFS+splice/copy_file_range，五个项目中唯一实现自研FAT32的项目。OSKernel2026-X的双EXT4后端设计独特，但缺少页缓存。MinotaurOS是唯一实现inotify的项目。Undefined-OS的DynamicFs Builder模式具有工程优雅性但缺少运行时mount/umount。

### 3.4 网络子系统

| 特性 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------|--------|----------|------------|-------------|------------|
| 协议栈 | lose-net-stack | lose-net-stack | lose-net-stack | smoltcp(自定义分支) | smoltcp | smoltcp |
| TCP/UDP | 支持 | 支持 | 支持 | 支持 | 支持(仅IPv4) | 支持(IPv4+IPv6) |
| Unix socket | 无 | 无 | 无 | 支持 | 无 | 标注todo! |
| socketpair | 支持 | 未提及 | 未提及 | 未提及 | 未提及 | 支持 |
| poll/epoll | poll/ppoll/epoll | epoll(基础) | 支持 | 未明确 | poll/ppoll/epoll | ppoll/pselect6(无epoll) |
| 流量控制 | 全局SOCKET_QUEUED_BYTES(512KB高水位) | 未提及 | 未提及 | 未提及 | 无 | 无 |
| sendmsg/recvmsg | 支持 | 未提及 | 未提及 | 未提及 | 未提及 | 支持(含sendmmsg/recvmmsg) |
| **评分** | **72%** | **68%** | **68%** | **78%** | **62%** | **75%** |

MinotaurOS以Unix socket支持领先；NoAxiom-OS的IPv6+sendmmsg支持最丰富；OSKernel2026-X的流量控制机制独有但协议栈依赖外部crate且MAC/IP硬编码。

### 3.5 信号处理

| 特性 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------|--------|----------|------------|-------------|------------|
| 信号数量 | sigaction[65] | sigaction[65] | sigaction[65] | 64信号 | 64信号 | 64信号(含实时信号) |
| 信号队列 | 实时信号队列计数 | 支持 | 支持 | SignalQueue | 排队信号 | 实时信号未排队 |
| SA_SIGINFO | 未完整支持 | 未完整支持 | 未完整支持 | 支持 | 未提及 | 支持 |
| sigaltstack | ENOSYS | 未提及 | 未提及 | 未提及 | 支持 | 标注unimplemented |
| SA_RESTART | 未明确 | 未提及 | 未提及 | 未提及 | 未提及 | 支持(可中断系统调用) |
| 信号栈帧 | trampoline(4架构) | trampoline | trampoline | 支持 | trampoline映射 | sig_trampoline |
| sigsuspend | 支持 | 未提及 | 未提及 | 未提及 | 未实现 | 未明确 |
| CoreDump | 未提及 | 未提及 | 未提及 | 未提及 | 未实际实现 | 标注Term(终止) |
| **评分** | **62%** | **60%** | **60%** | **78%** | **70%** | **80%** |

NoAxiom-OS在信号子系统方面最为完整，SA_SIGINFO+SA_RESTART+可中断系统调用是其区别于其他项目的重要特征。MinotaurOS紧随其后。OSKernel2026-X的四架构trampoline实现有工程价值但缺少SA_SIGINFO详情填充。

### 3.6 调度器设计

| 特性 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|--------------|--------|----------|------------|-------------|------------|
| 调度模型 | 协作式异步(FIFO) | 协作式异步(FIFO) | 协作式异步(FIFO) | 异步执行器+事件总线 | 传统同步(ArceOS) | 无栈协程+多级优先级 |
| 优先级 | 无 | 无 | 无 | 无 | 无 | 实时/普通/空闲(Nice -20~19) |
| 时间片 | 无(watchdog替代) | 无 | 无 | 未明确 | 无 | 定时器中断触发yield |
| 多核支持 | 单核(spin_loop) | 单核 | 单核(注释掉) | 未明确 | 未明确 | 每hart独立run_task循环 |
| CPU亲和性 | 无 | 无 | 无 | 无 | sched_setaffinity | CpuMask支持 |
| CFS | 无 | 无 | 无 | 无 | 无 | 代码完整但废弃 |
| 负载均衡 | 无 | 无 | 无 | 无 | 无 | 代码存在但性能差 |
| **评分** | **40%** | **35%** | **35%** | **55%** | **45%** | **70%** |

调度器是所有项目共同的薄弱环节。NoAxiom-OS的多级调度器远超其他项目——虽然CFS被废弃，但至少完成了实现和评估。其他四个项目均停留在FIFO协作式调度阶段，无优先级和时间片。OSKernel2026-X的watchdog系统部分补偿了调度能力的不足，但本质是监控而非调度机制。

### 3.7 系统调用覆盖

| 项目 | 估计数量 | 覆盖率 | 特色覆盖 |
|------|---------|--------|---------|
| OSKernel2026-X | ~100+ | ~55-60% | futex, shm, sendfile, copy_file_range, fallocate |
| ByteOS | ~100+ | ~50-55% | 基础POSIX覆盖 |
| MonkeyOS | ~100+ | ~52-57% | 与ByteOS类似 |
| MinotaurOS | ~120+ | ~55-60% | inotify |
| Undefined-OS | ~150+ | ~60-65% | mremap(部分), memfd, eventfd |
| NoAxiom-OS | ~115 | ~55-60% | splice, sendmmsg/recvmmsg, fadvise |

Undefined-OS在系统调用数量上领先，得益于ArceOS框架提供的接口丰富性。OSKernel2026-X在sendfile/copy_file_range/fallocate等高级文件操作上有独特覆盖。

---

## 四、技术亮点对比

### 4.1 各项目核心创新

| 项目 | 核心创新 | 创新级别 |
|------|---------|---------|
| **OSKernel2026-X** | (1)双EXT4后端(C+Rust)条件编译切换 (2)三层Watchdog系统 (3)完整测试编排引擎(987行initproc) (4)四架构trap统一处理 (5)linkme驱动注册 | **工程创新** |
| **ByteOS** | (1)linkme分布式切片驱动注册 (2)Async-first内核设计 (3)polyhal多架构HAL | **架构创新** |
| **MonkeyOS** | (1)musl/glibc双C库动态链接 (2)任务模板缓存加速ELF加载 (3)LoongArch PCI完整枚举 | **功能创新** |
| **MinotaurOS** | (1)事件总线统一信号/中断/异步等待 (2)四种内存区域类型抽象 (3)ELF快照缓存(LRU) (4)ASID动态管理 (5)inotify实现 | **设计创新** |
| **Undefined-OS** | (1)四层进程层次模型 (2)DynamicFs Builder模式 (3)FileLike统一抽象 (4)自定义syscall追踪过程宏 | **工程创新** |
| **NoAxiom-OS** | (1)无栈协程异步调度 (2)多级优先级调度器 (3)自研FAT32实现 (4)MSI页缓存协议 (5)细粒度并发分类(Mutable/ThreadOnly/SharedMut/Immutable) | **算法与架构创新** |

### 4.2 亮点深度对比

**OSKernel2026-X vs ByteOS**: 作为ByteOS的直接继承者，OSKernel2026-X在所有维度上均有显著增强。最关键的增量是：添加了完整ext4支持(双后端)、将系统调用从~90个扩展到100+个、引入三层watchdog、实现了987行的测试编排引擎、增加了FAT32支持。代码量从~5,500行增加到~19,418行，crate从~6个扩展到18个。实质上完成了从"教学原型"到"竞赛可评测系统"的跨越。

**OSKernel2026-X vs MonkeyOS**: 两者同为ByteOS后代但演进路线不同。MonkeyOS聚焦于musl/glibc双C库支持和LoongArch优化，而OSKernel2026-X选择了广度路线(四架构+更多文件系统+更多syscall)。MonkeyOS的任务模板缓存是OSKernel2026-X缺失的优化；OSKernel2026-X的watchdog和测试编排则是MonkeyOS不具备的工程基础设施。

**OSKernel2026-X vs MinotaurOS**: MinotaurOS代表了独立实现的异步内核路线。其事件总线机制比OSKernel2026-X的轮询式Future更高效——当IO就绪时通过事件总线主动唤醒等待任务，而非依赖执行器反复poll。MinotaurOS的内存管理也更为精细(四种区域+页缓存)。但OSKernel2026-X在多架构支持(4 vs 1)和文件系统种类(5 vs 3)上有优势。

**OSKernel2026-X vs Undefined-OS**: Undefined-OS受益于ArceOS的成熟框架，在系统调用数量(150+)和进程层次模型上领先。但其mount/umount被注释、setsockopt为stub等表明部分功能仅是框架。OSKernel2026-X的实现更为"实心"——每个系统调用都有实际处理逻辑。Undefined-OS的DynamicFs Builder模式值得OSKernel2026-X借鉴用于简化devfs/procfs构建。

**OSKernel2026-X vs NoAxiom-OS**: NoAxiom-OS是五个对比项目中技术深度最高的内核。其无栈协程调度器+多级优先级是唯一超越FIFO的实现；自研FAT32和MSI页缓存展示了文件系统方面的深入理解；细粒度并发分类(Task结构的Mutable/ThreadOnly/SharedMut/Immutable)体现了对Rust所有权模型的精妙运用。OSKernel2026-X在架构广度(4 vs 2架构)和watchdog/测试基础设施方面有优势。NoAxiom-OS在调度器、页缓存、自研文件系统方面的设计深度是其获得性能赛总分第二的根本原因。

---

## 五、不足与缺失对比

### 5.1 各项目主要缺陷

| 项目 | 主要不足 |
|------|---------|
| **OSKernel2026-X** | (1)仅FIFO协作式调度，无优先级/时间片 (2)单核运行，SMP未实现 (3)全spinlock同步，SMP死锁风险 (4)大量todo!/unimplemented! (ext4rsfs写入、VirtIO Input) (5)MAC/IP硬编码 (6)无页缓存 (7)SA_SIGINFO未完整支持 (8)sigaltstack 为ENOSYS |
| **ByteOS** | (1)Waker空操作导致无法真正唤醒阻塞任务 (2)hlt_if_idle为空，浪费CPU (3)无ext4支持 (4)单核 (5)缺少进程组/会话管理 |
| **MonkeyOS** | (1)多核启动代码被注释 (2)~300行调试输出未清理 (3)force_unlock不安全操作 (4)与ByteOS相同的调度器缺陷 (5)缺少页缓存 |
| **MinotaurOS** | (1)仅RISC-V单架构 (2)无法构建验证(依赖不可达) (3)事件总线的实际唤醒机制实现模糊 (4)缺少多核描述 (5)无FAT32支持 |
| **Undefined-OS** | (1)mount/umount为no-op (2)setsockopt为stub (3)文件映射不支持写 (4)仅IPv4 (5)epoll不支持边缘触发 (6)procfs存在两套重复实现 (7)CoreDump未实际实现 (8)Stop/Continue未完全实现 |
| **NoAxiom-OS** | (1)无epoll(仅ppoll/pselect) (2)Unix socket为todo! (3)msync仅在Drop触发 (4)CFS完整但废弃 (5)仅2架构 (6)sigaltstack标注unimplemented (7)实时信号未排队 |

### 5.2 共同缺失的功能域

所有六个项目在以下领域均存在明显不足：

1. **SMP多核调度**：无一实现真正的多核负载均衡调度。NoAxiom-OS具备基本多核框架但负载均衡代码被标注为"worst performance ever"。
2. **内存回收**：无一实现swap、LRU页面回收或内存压缩。
3. **高级同步原语**：均缺少RCU、完成变量、读写信号量等。
4. **NUMA感知**：全部缺失。
5. **cgroup/namespace**：均仅有框架或无实现。
6. **ACL/xattr**：全部缺失。

---

## 六、整体成熟度综合评分

评分维度与权重：
- **架构设计** (15%): 内核分层、模块化、抽象质量
- **进程管理** (15%): fork/clone/exec/wait、进程组、线程模型
- **内存管理** (15%): COW、mmap、页缓存、共享内存
- **文件系统** (15%): VFS、支持种类、缓存、挂载
- **网络** (10%): TCP/UDP、socket、协议站
- **信号** (10%): 信号处理、SA_SIGINFO、trampoline
- **调度** (10%): 调度算法、优先级、多核
- **系统调用** (10%): 覆盖数量与深度
- **跨架构** (附加5%): 架构支持多样性
- **工程成熟度** (附加5%): 构建验证、测试、文档

| 维度 | OSKernel2026-X | ByteOS | MonkeyOS | MinotaurOS | Undefined-OS | NoAxiom-OS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 架构设计 | 8.0 | 7.0 | 7.5 | 8.5 | 8.5 | 9.0 |
| 进程管理 | 7.5 | 7.0 | 7.5 | 8.0 | 8.5 | 8.5 |
| 内存管理 | 6.5 | 6.0 | 6.0 | 8.5 | 7.0 | 8.0 |
| 文件系统 | 8.0 | 6.5 | 7.0 | 8.0 | 7.5 | 8.5 |
| 网络 | 7.0 | 6.5 | 6.5 | 7.5 | 6.0 | 7.5 |
| 信号 | 6.0 | 5.5 | 5.5 | 7.5 | 6.5 | 8.0 |
| 调度 | 4.0 | 3.5 | 3.5 | 5.5 | 4.5 | 7.0 |
| 系统调用 | 7.5 | 7.0 | 7.0 | 7.5 | 8.0 | 7.5 |
| 跨架构(+5%) | 4.5 | 4.5 | 3.5 | 1.5 | 4.5 | 3.0 |
| 工程成熟度(+5%) | 4.0 | 3.5 | 3.0 | 2.5 | 3.5 | 3.5 |
| **加权总分** | **67.6** | **61.0** | **62.0** | **71.3** | **69.6** | **77.0** |

---

## 七、综合排名与分类评价

### 7.1 综合排名

| 排名 | 项目 | 总分 | 定位 |
|:---:|------|:---:|------|
| 1 | **NoAxiom-OS** | 77.0 | 技术深度领先者 |
| 2 | **MinotaurOS** | 71.3 | 设计优雅型 |
| 3 | **Undefined-OS** | 69.6 | 工程广度型 |
| 4 | **OSKernel2026-X** | 67.6 | 均衡工程型 |
| 5 | **MonkeyOS** | 62.0 | 定向增强型 |
| 6 | **ByteOS** | 61.0 | 原始基座型 |

### 7.2 分类评价

**技术深度型** (NoAxiom-OS, MinotaurOS):
以调度算法、内存管理精细化、文件系统自研为特征。NoAxiom-OS的无栈协程+多级调度+MSI页缓存+自研FAT32代表了竞赛项目中的最高技术深度；MinotaurOS的事件总线+四区域内存+ASID管理展示了精致的设计思维。两者的共同问题是架构覆盖不足(均为1-2架构)和构建验证困难。

**工程广度型** (Undefined-OS, OSKernel2026-X):
以多架构支持、多文件系统、大量系统调用为特征。Undefined-OS受益于ArceOS生态系统实现了四架构和150+系统调用；OSKernel2026-X在ByteOS基础上大幅扩展了架构和文件系统支持。两者的共同问题是细粒度优化的缺失——Undefined-OS的stub实现较多，OSKernel2026-X的调度和同步机制粗放。

**基座进化型** (ByteOS, MonkeyOS):
ByteOS作为多个项目的起点，其polyhal HAL和async executor的设计影响了OSKernel2026-X和MonkeyOS。MonkeyOS在ByteOS基础上做了定向增强(双C库+LoongArch优化)，但增量有限。两者现在主要作为对比基线存在。

### 7.3 OSKernel2026-X的定位与改进方向

OSKernel2026-X处于"均衡工程型"象限：在架构广度(4架构)、文件系统种类(双EXT4+RAMFS+DevFS+ProcFS+FAT32)、系统调用覆盖(100+)方面表现均衡，但每个维度都未能达到该类别的最高水平。

**相比ByteOS的核心改进**：
- 代码量增长3.5倍(5,500→19,418行)
- 文件系统从FAT32扩展到双EXT4+多FS
- 新增三层watchdog系统
- 新增完整测试编排引擎
- 系统调用从~90扩展到~100+

**应向NoAxiom-OS学习的**：
- 调度器：从FIFO升级到至少支持优先级和时间片
- 页缓存：引入MSI协议缓存提升IO性能
- 细粒度并发：按访问模式分类Task字段减少锁争用
- 自研关键组件：FAT32或网络协议栈的自研替代方案

**应向MinotaurOS学习的**：
- 事件总线机制替代纯轮询Future
- 内存区域类型化抽象提升COW效率
- ASID管理减少TLB刷新

**应向Undefined-OS学习的**：
- 完整进程组/会话层次模型
- DynamicFs Builder模式简化伪文件系统构建
- 系统调用追踪宏辅助调试

---

## 八、评审意见

OSKernel2026-X作为一个基于ByteOS二次开发的竞赛内核项目，在工程完整性和功能广度上展现出了明确的进步。项目将代码量从原基座的~5,500行扩展到~19,418行，增加了ext4双后端支持、FAT32兼容、三层watchdog监控系统和987行的完整测试编排引擎，成功地将一个教学原型内核转变为可自动化评测的竞赛系统。在四个对比项目中，OSKernel2026-X的架构跨度(同时支持RISC-V/LoongArch/x86_64/AArch64)与Undefined-OS并列第一，polyhal HAL层的四架构trap处理(包括LoongArch未对齐访存模拟)是扎实的底层工程工作。

然而，项目在技术深度方面存在明显短板。调度器停留在ByteOS原始的FIFO协作式模型，是所有六个项目中调度能力最弱的之一(仅优于ByteOS和MonkeyOS)。全自旋锁的同步策略在单核环境下尚可工作，但已有watchdog文档中记载的死锁隐患提示。缺少页缓存层意味着所有文件IO都直接穿透到块设备，在IO密集型场景下性能将显著落后于NoAxiom-OS和MinotaurOS。信号处理的SA_SIGINFO支持不完整、sigaltstack标记为ENOSYS，在实际运行复杂Linux应用时会遇到兼容性问题。

在比较视野中，OSKernel2026-X代表了一种"广度优先"的开发策略——覆盖更多架构、更多文件系统、更多系统调用，以数量取胜。而NoAxiom-OS和MinotaurOS代表了"深度优先"策略——在较少架构上做到极致优化。从竞赛角度看，广度策略在功能覆盖评测中有优势，但在性能评测中会暴露短板(NoAxiom-OS的性能赛总分第二即为明证)。建议OSKernel2026-X在下一阶段聚焦于：(1)引入优先级调度或至少时间片轮转；(2)实现页缓存层；(3)完善信号处理的SA_SIGINFO填充；(4)用更安全的同步原语替换部分自旋锁。这些改进将显著缩小与NoAxiom-OS和MinotaurOS在技术深度上的差距，同时保持已有的架构广度优势。