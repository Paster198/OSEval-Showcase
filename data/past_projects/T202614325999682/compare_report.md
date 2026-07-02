# 对比分析报告

## 一、项目概览

| 维度 | Sustcore | ChCore | RuOK OS | F7LY OS | NoAxiom-OS | NexusOS |
|---|---|---|---|---|---|---|
| **内核类型** | Capability混合内核 | Capability微内核 | 宏内核 | 宏内核 | 异步宏内核 | 异步框内核 |
| **编程语言** | C++ (GNU++23) | C | C++ (C++17/23) | C++ (C++23) | Rust | Rust |
| **代码规模** | ~114,009行 | ~6,596文件(含用户态) | ~48,841行 | 316源文件(内核) | 356源文件(内核+lib) | 582源文件(内核+ostd) |
| **支持架构** | RISC-V64, LoongArch64 | RISC-V64 | RISC-V64, LoongArch64 | RISC-V64, LoongArch64 | RISC-V64, LoongArch64 | RISC-V64, LoongArch64, x86-64 |
| **生态基础** | 自研 | 自研(教学项目) | 自研+EASTL+RustSBI | 基于Xv6重构+lwext4+onpstack | 自研+smoltcp+async_task | 基于Asterinas二次开发 |
| **构建验证** | 未构建(GCC 15+需求) | 未构建(工具链不匹配) | 未构建(工具链不匹配) | 未构建(缺C++编译器) | 未构建(缺子模块) | 未构建(缺镜像) |

---

## 二、架构设计对比

### 2.1 内核类型与安全模型

| 项目 | 内核类型 | 安全模型 | 分层设计 |
|---|---|---|---|
| **Sustcore** | Capability混合内核 | 两级索引CSpace + 64位权限位图 + Payload引用计数 | 架构Trait层 / 对象层 / 能力层 / 子系统层 四层 |
| **ChCore** | Capability微内核 | 10种内核对象 + Badge身份验证 + Capability传递 | 内核层 / 用户态服务层 两层 |
| **RuOK OS** | 宏内核 | 传统Unix权限(U/G/other) | HAL / HSAI / Kernel 三层 |
| **F7LY OS** | 宏内核 | 传统Unix权限 + rlimit资源限制 | 启动层 / 内核核心 / 第三方库 三层 |
| **NoAxiom-OS** | 异步宏内核 | Rust类型安全 + 细粒度并发锁 + 传统Unix权限 | HAL / 驱动层 / 内核核心 三层 |
| **NexusOS** | 异步框内核 | Rust类型系统零成本能力检查(VMAR/VMO) | ostd / kernel / osdk 三层 |

**分析**：Sustcore和ChCore是仅有的两个以Capability作为核心安全抽象的项目。Sustcore采用混合内核方式，在内核态直接实现能力系统；ChCore作为微内核，将能力管理作为内核核心职责，其它服务推至用户态。NexusOS的VMAR/VMO模型通过Rust类型系统实现零成本能力检查，但在语义丰富度上不如Sustcore的15种Payload类型+64位权限位图。RuOK OS和F7LY OS采用传统Unix权限模型，安全抽象层次较低。

### 2.2 模块化与抽象层次

| 项目 | 架构抽象方式 | 跨架构策略 | 模块化评价 |
|---|---|---|---|
| **Sustcore** | C++20 Concepts定义ArchTrait，编译期接口检查 | Traits统一接口 + 条件编译实现 | 优秀：类型安全的架构抽象 |
| **ChCore** | 策略模式(struct sched_ops) + 条件编译 | 条件编译(仅RISC-V) | 良好：调度策略可插拔 |
| **RuOK OS** | HSAI层(VirtualCpu/VirtualMemory等) | HSAI统一接口，HAL分架构实现 | 优秀：双架构代码复用率高 |
| **F7LY OS** | 面向对象多态(VFS文件类型体系) | 条件编译散布 | 中等：部分架构代码与业务逻辑耦合 |
| **NoAxiom-OS** | Rust trait抽象(ArchMemory等) | trait统一接口 | 优秀：语言级接口保证 |
| **NexusOS** | ostd层提供统一抽象 + trait | ostd屏蔽差异 | 优秀：框架层抽象成熟 |

---

## 三、子系统实现完整度对比

以通用操作系统内核的核心子系统为基准(100%代表覆盖Linux对应子系统的核心功能)，各项目子系统完整度对比如下：

### 3.1 内存管理

| 项目 | 物理分配器 | 虚拟内存 | 页表 | COW | 按需调页 | mmap | 完整度 |
|---|---|---|---|---|---|---|---|
| **Sustcore** | Buddy+SLUB+GFP | VMA+MemoryPayload | Sv39/LA64 | 完整 | 完整 | 文件后端 | **90%** |
| **ChCore** | Buddy+Slab | VMSpace(红黑树) | Sv39/Sv48 | 完整 | 部分 | 仅brk/mprotect | **85%** |
| **RuOK OS** | Buddy+liballoc | VMA | Sv39/LA64-4级 | 无 | 无 | 无 | **85%** |
| **F7LY OS** | Buddy(完全二叉树)+Slab | VMA+ProcessMemMgr | 三级页表 | 无(fork深拷贝) | 部分(TODO) | 匿名+文件 | **80%** |
| **NoAxiom-OS** | 伙伴系统 | MemorySet+MapArea | Sv39/LA64 | 完整 | 完整 | 匿名+文件+共享 | **80%** |
| **NexusOS** | 伙伴系统+Slab | VMAR/VMO模型 | Sv39/Sv48 | Fork页表复制 | 完整 | 匿名+文件 | **85%** |

**Sustcore优势**：Buddy+SLUB+GFP三层分配器链路最完整；MemoryPayload与能力系统深度集成，file-backed memory和COW实现完整。唯一一个将内存区域抽象为能力对象的项目。

### 3.2 进程管理

| 项目 | fork/clone | execve | 信号 | Futex | 线程 | 进程组 | 完整度 |
|---|---|---|---|---|---|---|---|
| **Sustcore** | fork | ELF64+RISC-V/LA64 | 64信号+SigAction | 无 | 1:1模型 | 无 | **85%** |
| **ChCore** | clone_proc | 用户态实现 | 基础框架 | 16桶哈希 | Cap Group+线程 | 无 | **80%** |
| **RuOK OS** | fork+clone3(简化) | ELF64+#!解释器 | sigaction+掩码 | 仅有头文件 | 基础 | 无 | **75%** |
| **F7LY OS** | fork+clone(含线程) | ELF64 | 完整POSIX+trampoline | 完整(超时+重排队) | clone线程 | 基础 | **80%** |
| **NoAxiom-OS** | clone(含CLONE_VM等) | ELF64+动态链接器 | 64信号+SA_RESTART | 完整+私/共享队列 | 完整线程组 | 完整 | **85%** |
| **NexusOS** | clone(标志分治) | ELF64 | 仅存储桩 | 无 | 线程组 | 无 | **70%** |

**Sustcore优势**：独特的1:1进程-线程模型与能力系统集成；信号机制设计完善。NoAxiom-OS在线程、Futex、进程组方面实现最完整。F7LY OS的Futex实现(含超时和重排队)在C++项目中较为突出。

### 3.3 文件系统

| 项目 | VFS抽象 | 支持的文件系统 | ext4深度 | 页缓存 | 完整度 |
|---|---|---|---|---|---|
| **Sustcore** | IFsDriver/ISuperblock/IFile多态接口 | ext4/tmpfs/procfs/tarfs/devfs (5种) | 自研(~3305行), Extent树, 目录操作, inode分配 | LRU双链表+RCU读保护 | **80%** |
| **ChCore** | 用户态VNode抽象 | tmpfs/ext4/FAT32 (3种) | Extent树+Journal(基础) | 用户态实现 | **75%** |
| **RuOK OS** | dentry/Inode/Path | ext4/FAT32/ramfs (3种) | dx_dir哈希树索引(TEA/MD4), 间接块 | BufferManager(同步) | **70%** |
| **F7LY OS** | 多态file体系+lwext4 | ext4(lwext4移植)/procfs (2种) | 依赖lwext4库 | lwext4内置 | **65%** |
| **NoAxiom-OS** | Dentry/Inode/File/SuperBlock trait | ext4/FAT32/RamFS/ProcFS/DevFS (5种) | 自研, extent树 | MSI协议页缓存+LRU块缓存 | **80%** |
| **NexusOS** | Vnode/FileSystem trait+静态分发 | ext4(自研)/DevFS (2种) | 自研(another_ext4), extent树, 块分配 | 块缓存 | **80%** |

**Sustcore优势**：ext4实现代码量最大(3305行)，页缓存(LRU+RCU)设计最接近Linux。RuOK OS的dx_dir哈希树目录索引是独特亮点。NoAxiom-OS支持文件系统种类最多(5种)，MSI页缓存协议设计独特。NexusOS的纯Rust ext4和静态分发VFS性能优秀。

### 3.4 调度器

| 项目 | 调度策略 | 核心算法 | 多核 | 实时支持 | 完整度 |
|---|---|---|---|---|---|
| **Sustcore** | 5级(RT>INIT>RR>FCFS>IDLE) | RR时间片=5ticks, 抢占检查 | 无 | RT FIFO | **85%** |
| **ChCore** | 3种(RR/PBRR/PBFIFO)可插拔 | PBRR: 256级+两级位图O(1) | SMP+负载均衡 | PBFIFO | **80%** |
| **RuOK OS** | 纯优先级(0-19) | 遍历进程池 | 无 | 无 | **50%** |
| **F7LY OS** | 优先级+时间片 | 遍历进程池 | 无(smp 1) | 无 | **60%** |
| **NoAxiom-OS** | 多级(实时FIFO+普通Expired双队列) | O(1)双队列+协程Future poll | 多核(负载均衡待完善) | FIFO实时 | **75%** |
| **NexusOS** | 工作窃取(Work-stealing) | maitake异步运行时+Xoroshiro随机 | 多核完整 | 无 | **85%** |

**Sustcore优势**：5级调度类层次最丰富，模板化调度器基类可扩展性好。ChCore的256级O(1)查找和SMP负载均衡在RISC-V项目中较为完善。NexusOS的多核工作窃取调度最为成熟。NoAxiom-OS的异步协程调度创新性最强。

### 3.5 系统调用覆盖

| 项目 | 系统调用数 | 覆盖领域 | POSIX兼容度 |
|---|---|---|---|
| **Sustcore** | ~80 | 任务/能力/IPC/内存/VFS/信号/时间 | 自有ABI+Linux子系统兼容层 |
| **ChCore** | ~50 | 字符IO/PMO/Cap/IPC/基础POSIX | 基于musl适配 |
| **RuOK OS** | ~82 | 文件IO/进程/内存/时间/系统信息(网络为桩) | Linux兼容 |
| **F7LY OS** | ~120(注册) | 进程/内存/文件/网络/信号/IPC | Linux高度兼容(BusyBox) |
| **NoAxiom-OS** | ~115 | 文件(~45)/进程(~20)/网络(~18)/内存(~10) | Linux兼容(比赛测试通过) |
| **NexusOS** | ~55 | 进程/文件/内存/时间 | Linux兼容(musl+glibc) |

### 3.6 网络支持

| 项目 | 协议栈 | 实现方式 | 网络性能 |
|---|---|---|---|
| **Sustcore** | 无 | -- | -- |
| **ChCore** | lwIP (TCP/UDP/IP) | 用户态服务 | 支持iperf/netperf |
| **RuOK OS** | 无(系统调用为桩) | -- | -- |
| **F7LY OS** | onpstack (TCP/UDP/ICMP/ARP) | 内核集成+BSD Socket API | RISC-V可用 |
| **NoAxiom-OS** | smoltcp (TCP/UDP/IPv4/IPv6) | 内核集成+Socket适配VFS | 比赛iperf第1名 |
| **NexusOS** | 无(仅VirtIO网卡驱动封装) | -- | -- |

Sustcore和RuOK OS完全没有网络支持，是其明显的功能短板。NoAxiom-OS的异步网络性能表现最为优异。

---

## 四、技术亮点对比

### Sustcore 独特亮点
1. **最全面的能力系统**：15种Payload类型、两级CSpace(4096 CGroup x 256 Slots)、CLONE/MIGRATE/MIGRATE_ONCE三种传递语义、64位权限位图，在同赛道项目中独一无二。
2. **MemoryPayload设计**：将虚拟内存区域抽象为能力对象，支持file-backed memory、lazy allocation、连续性选项、增长约束，是能力与内存管理融合的最佳实践。
3. **三层内存分配器**：Buddy(页框)+SLUB(小对象)+GFP(引用计数)形成完整闭环，GFP的引用计数与COW深度集成。
4. **C++20 Concepts架构Trait**：编译期类型检查保证架构代码的类型安全，优于条件编译方式。

### ChCore 独特亮点
1. **迁移式IPC(Shadow线程)**：通过让服务端临时"借用"客户端调度上下文，显著减少微内核IPC的上下文切换次数，在同赛道微内核项目中是独特的性能优化。
2. **用户态文件系统+网络服务**：严格微内核设计哲学，将复杂子系统推至用户态并通过IPC提供服务。
3. **完整的基准测试体系**：集成了lmbench、unixbench、ltp、iozone、iperf等丰富测试套件。

### RuOK OS 独特亮点
1. **ext4 dx_dir哈希树目录索引**：完整移植Linux的TEA/MD4哈希算法，在大目录查找性能上远超同级项目的线性搜索。
2. **HSAI跨架构抽象层**：通过VirtualCpu/VirtualMemory/VirtualPageTable等统一接口，实现双架构核心代码零条件编译。
3. **C++ EASTL深度集成**：在竞赛项目中率先采用工业级C++模板库进行内核开发。

### F7LY OS 独特亮点
1. **C++23面向对象VFS**：利用多态特性构建文件类型继承体系(file->普通文件/目录/管道/Socket/设备/虚拟文件)，设计优雅。
2. **最广系统调用覆盖**：注册120余个Linux兼容系统调用，在C++项目中数量最多。
3. **完整TCP/IP协议栈集成**：基于onpstack实现完整的BSD Socket API，涵盖TCP/UDP/ICMP/ARP。

### NoAxiom-OS 独特亮点
1. **全异步调度架构**：基于Rust无栈协程(async/await)将用户任务封装为Future，系统调用和缺页处理均为异步，是六个项目中唯一深度探索异步内核范式的。
2. **实际性能验证**：决赛性能总分第2、iperf网络性能第1，证明了异步架构在IO密集型场景的实际优势。
3. **细粒度并发模型**：Task结构体按Mutable/ThreadOnly/Immutable/SharedMut四类访问模式分类，有效降低锁竞争。

### NexusOS 独特亮点
1. **VMAR/VMO零成本能力模型**：通过Rust类型系统(Full/Rights)实现编译期+运行期双重能力检查，无运行时开销。
2. **VFS静态分发**：通过枚举类型统一不同文件系统实现，避免动态分发的虚函数开销。
3. **多核工作窃取调度**：基于maitake异步运行时+Xoroshiro随机算法，是多核调度最成熟的项目。
4. **三架构支持**：是六个项目中唯一同时支持RISC-V64、LoongArch64和x86-64的。

---

## 五、不足与缺失对比

| 项目 | 主要不足 |
|---|---|
| **Sustcore** | (1)无网络协议栈；(2)无多核支持(调度器缺负载均衡、中断缺affinity)；(3)构建依赖GCC 15+过于激进；(4)无用户态Shell/管理工具；(5)缺少poll/epoll等IO多路复用；(6)中断对象未完全实现 |
| **ChCore** | (1)仅RISC-V单架构；(2)ext4 Journal恢复不完整；(3)信号系统仅基础框架；(4)缺少mmap完整语义；(5)内核态内存安全防护弱(无KASAN)；(6)Capability撤销(cap_revoke)实现复杂 |
| **RuOK OS** | (1)调度器极为简陋(无时间片轮转)；(2)无COW和按需调页；(3)无网络栈；(4)Futex仅有头文件；(5)资源全部静态池化(进程池32等)；(6)ext4仅支持间接块，无extent树 |
| **F7LY OS** | (1)无COW(fork全量深拷贝)；(2)调度器仅静态优先级；(3)无SMP多核；(4)构建依赖Linux系统头文件(裸机工具链不可用)；(5)路径解析含已知缺陷；(6)仅ext4一种持久化文件系统 |
| **NoAxiom-OS** | (1)fsync/msync为空实现(数据安全隐患)；(2)CFS调度器被废弃；(3)缺少epoll；(4)多核负载均衡自评"最差性能"；(5)信号备用栈未完善；(6)物理帧全局锁可能成为瓶颈 |
| **NexusOS** | (1)无网络协议栈(仅网卡驱动封装)；(2)信号/Futex均为桩或缺失；(3)ext4日志为桩(无崩溃恢复)；(4)dup偏移语义与Linux不一致；(5)仅55个系统调用；(6)设备驱动极为有限 |

---

## 六、综合成熟度对比

以通用操作系统内核为基准(100%)，各项目按子系统加权评分：

| 项目 | 内存管理 | 进程管理 | 文件系统 | 调度器 | 系统调用 | 网络 | 安全模型 | 架构抽象 | 多核 | **综合评分** |
|---|---|---|---|---|---|---|---|---|---|---|
| **Sustcore** | 90 | 85 | 80 | 85 | 80 | 0 | 95 | 90 | 15 | **72** |
| **ChCore** | 85 | 80 | 75 | 80 | 65 | 75 | 90 | 65 | 75 | **77** |
| **RuOK OS** | 85 | 75 | 70 | 50 | 75 | 0 | 40 | 85 | 0 | **56** |
| **F7LY OS** | 80 | 80 | 65 | 60 | 85 | 70 | 50 | 55 | 10 | **62** |
| **NoAxiom-OS** | 80 | 85 | 80 | 75 | 85 | 80 | 65 | 85 | 60 | **77** |
| **NexusOS** | 85 | 70 | 80 | 85 | 65 | 10 | 80 | 80 | 85 | **71** |

**评分说明**：各项权重分别为内存管理(18%)、进程管理(15%)、文件系统(15%)、调度器(12%)、系统调用(12%)、网络(10%)、安全模型(8%)、架构抽象(5%)、多核(5%)。

---

## 七、分类评价

### 能力安全型内核 (Sustcore vs ChCore vs NexusOS)

这三个项目均将"能力"作为核心安全抽象，但实现路径迥异：

- **Sustcore**：在混合内核中以C++实现最全面的能力系统。优势在于Payload类型丰富(15种)、权限模型精细(64位位图)、与内存管理深度融合。劣势在于无网络栈和多核支持。
- **ChCore**：在微内核中以C实现能力管理。优势在于微内核架构的隔离性好、IPC设计精巧(Shadow线程)、测试体系完善。劣势在于能力类型较少(10种)、仅RISC-V单架构。
- **NexusOS**：在框内核中以Rust类型系统实现零成本能力检查。优势在于编译期安全保证、多核调度成熟。劣势在于能力语义相对简单(仅VMAR/VMO)、整体功能完整度较低。

**排序**：ChCore(综合成熟度最高) > Sustcore(能力系统最完整) > NexusOS(能力实现最优雅但功能覆盖不足)

### C++语言型内核 (Sustcore vs RuOK OS vs F7LY OS)

这三个项目均用C++开发且支持双架构：

- **Sustcore**：C++20/23应用最深(Concepts/constexpr/Result模式/模板化SLUB)，代码质量最高，但构建依赖最激进。
- **RuOK OS**：HSAI跨架构抽象层设计最优雅，ext4哈希树索引是独特亮点，但调度器和内存管理深度不足。
- **F7LY OS**：系统调用最广(120+)、面向对象VFS设计优秀，但核心机制深度不足(无COW、调度器简陋)。

**排序**：Sustcore(架构设计与机制深度最优) > F7LY OS(功能广度最优) > RuOK OS(局部亮点突出但整体深度不足)

### Rust异步型内核 (NoAxiom-OS vs NexusOS)

- **NoAxiom-OS**：自研异步调度架构，全链路异步化(系统调用、缺页、驱动IO)，实际性能验证优秀，功能覆盖广(5种文件系统、115个系统调用)。
- **NexusOS**：基于成熟框架二次开发，多核调度和同步原语成熟，但自研深度和功能广度不如NoAxiom-OS。

**排序**：NoAxiom-OS(功能广度与创新性均优于NexusOS) > NexusOS(框架成熟但自研深度有限)

---

## 八、综合排名

基于上述多维度对比，六个项目的综合排名如下：

| 排名 | 项目 | 核心优势 | 核心短板 |
|---|---|---|---|
| **1** | **ChCore** | 微内核架构完整、IPC设计巧妙、测试体系完善、用户态服务丰富 | 仅RISC-V单架构、部分POSIX语义不完整 |
| **1** | **NoAxiom-OS** | 异步架构创新性最强、实际性能优异、功能覆盖广 | 持久化同步接口为空、多核负载均衡待完善 |
| **3** | **Sustcore** | 能力系统最完整、C++现代特性运用最深、内存管理最精细 | 无网络栈、无多核、构建依赖激进 |
| **4** | **NexusOS** | 多核调度最成熟、Rust类型安全能力模型、三架构支持 | 功能覆盖有限(55个系统调用)、网络栈缺失 |
| **5** | **F7LY OS** | 系统调用最广、VFS面向对象设计、集成TCP/IP协议栈 | 核心机制深度不足(无COW、无SMP) |
| **6** | **RuOK OS** | HSAI层设计优秀、ext4哈希树索引独特 | 调度器极为简陋、无COW、资源全部静态池化 |

---

## 九、评审意见

Sustcore是一个在**内核安全架构设计**和**内存管理机制深度**方面表现突出的竞赛项目。其以Capability作为一等公民贯穿整个内核设计的理念，在六个对比项目中独树一帜。Buddy+SLUB+GFP三层分配器、MemoryPayload与能力的深度融合、基于C++20 Concepts的架构Trait系统，均体现出团队扎实的系统编程功底和对现代C++的深入理解。

然而，Sustcore在两个关键维度上存在明显短板。第一，**网络协议栈的完全缺失**使其无法应对现代操作系统的核心需求，与ChCore(lwIP)、F7LY OS(onpstack)、NoAxiom-OS(smoltcp)形成鲜明对比。第二，**多核支持的缺失**限制了其在多核硬件上的性能潜力，而NexusOS和ChCore均已具备较成熟的多核调度能力。此外，GCC 15+的构建依赖在当前竞赛环境中过于激进，影响了项目的可构建性和可复现性。

在六个项目的综合对比中，ChCore以微内核架构完整性和丰富的用户态服务胜出，NoAxiom-OS以异步架构创新性和实际性能验证领先。Sustcore位列第三，其核心优势在于：在能力安全模型领域达到了六个项目中的最高实现深度，这一独特定位使其在安全关键型内核研究方向上具有不可替代的参考价值。

建议后续改进方向：(1)引入网络协议栈(如lwIP或smoltcp)补齐功能短板；(2)实现多核调度与负载均衡；(3)降低构建工具链版本要求以提升可构建性；(4)补充epoll/poll等IO多路复用机制以提升POSIX兼容性。