# 对比分析报告

## 一、对比项目概览

本报告以 VOS 内核为基准参照，将其与五个同期 OS 内核竞赛项目进行多维对比。项目选取覆盖了宏内核（VOS、Undefined-OS、starry-next、AstrancE、ZeroOS）与微内核（ChCore）两种范式，以及 ArceOS 生态内的不同复用策略。

| 属性 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS | ChCore |
|------|-----|-------------|-------------|----------|--------|--------|
| **内核类型** | 宏内核 | 宏内核 | 宏内核(Unikernel) | 宏内核 | 宏内核 | 微内核 |
| **生态基础** | ArceOS | ArceOS | ArceOS | ArceOS | ArceOS/Starry | 无(自研) |
| **开发语言** | Rust | Rust + C | Rust | Rust + C | Rust | C |
| **支持架构数** | 2 | 4 | 4 | 4 | 1 | 1 |
| **自研代码量** | ~43,600 | ~100+文件 | ~5,750 | ~76,572 | ~61,441 | ~345文件 |
| **系统调用数** | ~220 | ~150+ | ~99 | ~71 | ~101+ | ~50 |
| **整体完整度** | 65%(竞赛)/35-40%(通用) | ~75% | 60-65% | 75-80% | ~75% | 80%(微内核基准) |

---

## 二、架构设计对比

### 2.1 内核类型与分层方式

| 项目 | 分层设计 | 模块化程度 | 评价 |
|------|---------|-----------|------|
| **VOS** | 4层：syscall→task→fs/exec→ArceOS HAL | 高。`syscall/` 13子模块、`task/` 10子模块、`fs/` 7子模块，职责边界清晰 | ArceOS作为"硬件抽象库"的外部应用模式，仅3处上游修改，与框架松耦合 |
| **Undefined-OS** | 4层：api(imp+interface)→core→process→ArceOS HAL | 高。6个workspace crate，核心抽象(core)与具体实现(api)分离 | 严格的POSIX四层进程模型(Session→ProcessGroup→Process→Thread) |
| **starry-next** | 3层：入口层→核心层(ProcessData/ThreadData)→API层 | 中高。43个源文件组织为3大层，AxNamespace实现资源隔离 | Unikernel部署方式——用户程序编译时嵌入内核，无init进程 |
| **AstrancE** | 多层：axhal→axmm/axalloc→axtask→axfs→axmono/axsyscall | 高。~480源文件，linkme机制实现可插拔陷阱处理 | 硬件抽象层与上层通过`#[register_trap_handler]`宏完全解耦 |
| **ZeroOS** | 多层：HAL→axmem/axalloc→axtask→axfs→api | 高。~50个workspace crate，子系统通过trait和条件编译解耦 | 采用async/await异步系统调用模型，区别于所有其他项目的同步模型 |
| **ChCore** | 微内核分层：内核核心→用户态服务 | 极高。内核仅~50 syscall，FS/网络/驱动推至用户态 | Capability安全模型，策略模式调度框架，微内核TCB最小化 |

**关键差异**：
- VOS和AstrancE均将ArceOS视为HAL库而非fork，但VOS修改更少（3处 vs AstrancE的自定义axhal扩展）。
- starry-next的Unikernel风格将所有用户程序嵌入内核镜像，启动即执行测试，无传统shell交互——这是六者中最激进的部署简化策略。
- ZeroOS的async模型是唯一采用异步系统调用的项目，理论上能更好地支持阻塞型I/O的挂起/恢复，但也引入了额外的执行器调度开销。
- ChCore的微内核架构与所有宏内核项目形成根本性对立：文件系统崩溃仅影响用户态服务进程而非整个内核。

### 2.2 ArceOS 复用模式对比

五个ArceOS生态项目在复用策略上有显著差异：

| 复用维度 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS |
|---------|-----|-------------|-------------|----------|--------|
| 复用方式 | 外部应用(path依赖) | workspace内嵌arceos/目录 | 外部应用(path依赖) | 深度定制(crates/目录) | 内嵌modules/目录 |
| 对上游修改 | 极少(~3处) | 中等(自定义VFS库) | 极少 | 较多(axhal/axmm/axprocess均定制) | 较多(自定义驱动和子系统) |
| HAL依赖深度 | 标准(axhal/axmm/axalloc) | 标准+自定义page_table_multiarch | 标准+AxNamespace | 深度(新增linkme陷阱框架) | 标准+自定义PLIC/RTC/SD驱动 |
| C代码依赖 | 无 | 有(lwext4) | 无 | 有(lwext4) | 无(纯Rust) |

VOS和starry-next的"薄复用"策略与AstrancE和ZeroOS的"厚定制"策略形成对照。VOS以最小修改最大化上游兼容性，代价是部分功能受限于ArceOS既有能力边界（如单核协作式调度）。AstrancE的深度定制释放了更多自由度（如可插拔陷阱框架），但增加了与上游的维护分歧风险。

---

## 三、子系统实现对比

### 3.1 系统调用覆盖度

| 功能域 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS | ChCore |
|--------|-----|-------------|-------------|----------|--------|--------|
| 文件I/O | 极全(~50+) | 全(~40+) | 全(~30+) | 全(~25+) | 全(~37) | 基础(~15) |
| 进程管理 | 全(~20+) | 全(~15+) | 全(~10+) | 全(~10+) | 全(~40含调度) | 基础(~8) |
| 内存管理 | 全(~12) | 全(~10) | 全(~10) | 全(~8) | 全(~10) | 基础(brk/mprotect) |
| 网络 | 中(~15) | 中(~12, 仅IPv4) | **低(syscall未接入)** | 中(~10) | 中(~14) | 中(用户态lwIP) |
| 信号 | 全(~10) | 全(~8) | 中(~7) | 中高(~6) | 中(~8, 缺STOP) | 基础(~4) |
| 同步/IPC | 全(futex+shm+pipe) | 全(futex+shm) | 全(futex+shm) | **缺(futex为桩)** | 全(futex+shm) | 全(futex+IPC) |
| 多路复用 | 全(epoll/poll/select) | 全(epoll/poll) | 全(epoll/poll/select) | 基础(poll/select) | **缺(无epoll)** | **缺** |
| **总计** | **~220** | **~150+** | **~99** | **~71** | **~101+** | **~50** |

VOS以约220个系统调用在所有项目中遥遥领先。starry-next的网络子系统调用虽已封装但未接入主分发器——这是一个显著的"完成但不可用"的场景。AstrancE的futex仅为桩实现，意味着用户态pthread互斥锁等关键同步机制实际上无法正确工作。

### 3.2 内存管理

| 特性 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS | ChCore |
|------|-----|-------------|-------------|----------|--------|--------|
| 物理分配器 | 依赖ArceOS | Slab/Buddy/TLSF | 依赖ArceOS | Slab/Buddy/TLSF | Bitmap+Slab/Buddy | Buddy+Slab |
| 按需分页 | 支持 | 支持(COW) | 支持 | 支持(COW) | 支持(延迟分配) | 支持(COW) |
| COW | **不支持** | 支持 | **不支持** | 支持 | 支持 | 支持 |
| mmap | 完整(匿名/文件/SHM) | 完整(含大页) | 完整(含大页) | 完整(匿名/文件) | 完整(含mremap) | **基础(仅brk/mprotect)** |
| SHM | SysV | SysV | SysV(完整含ShmidDs) | SysV+POSIX | SysV(含IPC_PRIVATE) | 通过PMO_SHM |
| Swap | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |

VOS在内存管理中的一个显著不足是不支持COW——fork直接深复制地址空间。这在ArceOS生态中属于有意识的妥协，Undefined-OS、AstrancE和ZeroOS均基于ArceOS的axmm实现了COW。starry-next同样未实现COW，与VOS处于同一阵营。ChCore的mmap实现最为基础（仅brk+mprotect），反映了微内核将复杂内存语义推至用户态的设计偏向。

### 3.3 进程管理

| 特性 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS | ChCore |
|------|-----|-------------|-------------|----------|--------|--------|
| 进程模型 | Process+Thread | Session→PG→Process→Thread | Process→Thread | Process+Thread+PG | Task(TID→引用) | CapGroup+Thread |
| 调度算法 | 协作式FIFO | 依赖ArceOS | 依赖ArceOS | **FIFO/RR/CFS** | **FIFO/RR/CFS** | RR/PBRR/PBFIFO |
| SMP多核 | **不支持** | 依赖ArceOS | 依赖ArceOS | **支持(per-CPU)** | 支持 | **支持(IPI+负载均衡)** |
| 进程组/会话 | 支持 | **四层全支持** | 部分(缺setsid) | 支持 | 支持 | 不支持 |
| 孤儿回收 | 支持(pid 1) | 支持(reaper) | 支持 | 支持 | 支持 | 支持 |
| COW-less fork | 是 | 否 | 是 | 否 | 否 | 否 |

VOS和starry-next均采用COW-less fork策略，是竞赛导向的有意识选择。Undefined-OS的四层进程模型是所有项目中最贴近Linux POSIX标准的实现。AstrancE和ZeroOS在调度算法丰富度上领先（CFS是重要加分项）。ChCore的进程管理最为简约——缺乏进程组/会话概念，但通过Capability模型实现了独特的资源隔离语义。

### 3.4 文件系统

| 特性 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS | ChCore |
|------|-----|-------------|-------------|----------|--------|--------|
| VFS抽象 | 组合式VfsRoot | FileLike trait | FileLike trait | 分层VFS | RootDirectory多挂载 | 用户态VNode |
| 支持FS | ext4(只读)+ramfs+devfs+procfs+sysfs | ext4+tmpfs+devfs+procfs | ext4(只读)+ramfs+devfs+procfs | **ext4+FAT+devfs+ramfs+procfs+shmfs** | ext4+FAT+ramfs+devfs+procfs/sysfs(壳) | tmpfs+ext4+FAT(用户态) |
| procfs/sysfs | 部分(手动枚举) | 部分(含两套proc实现) | 极简(仅/proc/self/exe) | **动态闭包生成** | **空壳(仅目录)** | 无 |
| 管道缓冲区 | **64 KiB** | **64 KiB** | 256 B | 未详查 | VecDeque | 未详查 |
| epoll | 支持(ET/oneshot) | 支持(仅LT) | 支持(轮询,仅LT) | 未详查 | **不支持** | **不支持** |
| 挂载管理 | 支持bind mount | 注释掉(仅启动时硬编码) | 仅记录管理 | 支持(最长前缀匹配) | 支持 | 用户态 |
| ext4写支持 | 不可写(仅ramfs) | 可写(via lwext4) | 不可写(仅ramfs) | 可写(via lwext4) | 可写(via another_ext4) | 可写(用户态) |

VOS的组合式VFS（overlay风格组合ext4+ramfs+devfs+procfs+sysfs为统一视图）是六者中唯一的union mount实现。AstrancE的文件系统生态最丰富（6种），其procfs闭包动态生成机制在工程上最为优雅。starry-next的256字节管道缓冲区在所有项目中最小，可能严重影响pipe密集型测试的性能。ZeroOS的procfs/sysfs仅为挂载了ramfs的空目录——这是六者中最严重的信息暴露缺口。

### 3.5 信号处理

| 特性 | VOS | Undefined-OS | starry-next | AstrancE | ZeroOS | ChCore |
|------|-----|-------------|-------------|----------|--------|--------|
| 信号发送 | kill/tkill/tgkill | kill/tkill/tgkill+queue | kill/tkill/tgkill | kill/tkill/tgkill | kill/tkill/tgkill | 基础框架 |
| 信号掩码 | per-thread mask | per-thread mask | per-thread mask | per-thread mask | per-thread mask | 部分 |
| 自定义handler | 支持(SA_RESTART等) | 支持 | 支持+备用栈 | 支持+trampoline+备用栈 | 支持+SA_SIGINFO+siginfo_t | 基础 |
| SIGSTOP/CONT | 部分支持 | 未完全实现 | 未完全实现 | 未完全实现 | **unimplemented!()** | 未实现 |
| CoreDump | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 实时信号排队 | 部分 | 部分(sigqueueinfo) | 部分(rt_sigqueueinfo) | 部分 | 部分 | 不支持 |

所有六个项目在信号处理上的完整度均未超过75%。SIGSTOP/SIGCONT作业控制的普遍缺失意味着Ctrl+Z、fg/bg等shell作业控制均无法正常工作。ZeroOS的`unimplemented!()`标记最为直接——这在运行依赖作业控制的测试程序时会直接panic。

---

## 四、技术亮点与创新对比

### 4.1 各项目核心创新

| 项目 | 核心创新 | 创新等级 | 适用场景 |
|------|---------|---------|---------|
| **VOS** | musl运行时二进制补丁、组合式VFS(union mount)、阻塞syscall通用框架 | **高** | 解决libc ABI兼容性、多FS统一视图、避免维护独立libc fork |
| **Undefined-OS** | 系统调用追踪proc-macro、DynamicFs声明式伪文件系统Builder | **中高** | 内核调试辅助、动态构建/dev和/proc文件树 |
| **starry-next** | AxNamespace进程级资源隔离、固定地址信号跳板(避免内核拷贝) | **中高** | 文件描述符和CWD的优雅共享/独立、上下文切换优化 |
| **AstrancE** | linkme可插拔陷阱处理框架、双共享内存(SysV+POSIX)、procfs闭包生成器 | **高** | 硬件抽象层与上层解耦、双标准IPC兼容、按需动态生成procfs内容 |
| **ZeroOS** | async/await异步系统调用模型、FAT32链接用户态模拟、VisionFive2真机驱动 | **中高** | 阻塞型I/O的优雅实现、绕过FAT32无链接限制、裸金属硬件适配 |
| **ChCore** | Capability安全模型、迁移式IPC(Shadow线程)、用户态系统服务 | **最高** | 严格资源隔离、降低微内核IPC开销、TCB最小化 |

### 4.2 创新深度分析

**VOS的musl二进制补丁**在六个项目中是独一无二的：其他项目要么修改libc源码（维护fork），要么接受libc行为差异导致的测试失败。VOS通过在ELF装载阶段对musl只读代码段进行运行时二进制替换，在不修改评测程序的前提下精确修复了pathconf/brk/sbrk/epoll_create/gethostname等5处ABI不兼容。这种方法的代价是对musl特定二进制版本的强依赖。

**AstrancE的linkme陷阱框架**在六个ArceOS项目中是最彻底的模块解耦方案。它允许上层模块（如axmono、axsyscall）在不修改HAL代码的情况下注册陷阱处理器，实现了类似Linux内核中`request_irq()`的效果。VOS的陷阱处理是集中式分发（`trap.rs`中的match），相比之下AstrancE的方案扩展性更强。

**ChCore的迁移式IPC**在学术价值和设计深度上高于所有宏内核项目的创新。通过Shadow线程机制，它将传统IPC的4次上下文切换（client→kernel→server→kernel→client）减少为2次（client→server→client），这是对微内核经典性能瓶颈的有针对性优化。

**ZeroOS的async模型**是一个独特的架构决策，但它的优势（阻塞型I/O自然挂起）伴随着额外的async运行时开销。在竞赛环境中，这种设计选择可能对其cyclictest等实时性测试结果产生影响。

---

## 五、不足与缺失对比

### 5.1 共性问题

六个项目共享以下不足：

1. **无Swap/页面换出**：所有项目均不支持虚拟内存交换，物理内存耗尽即失败。
2. **无完整CoreDump**：所有项目的SIGQUIT/SIGABRT等CoreDump动作均直接退出，无法生成调试转储。
3. **权限模型薄弱**：所有项目的uid/gid/capability检查要么硬编码（返回0/1000），要么完全跳过。
4. **SIGSTOP/SIGCONT缺失或不完整**：Shell作业控制在所有项目上均不可用。

### 5.2 各项目特有缺陷

| 项目 | 最严重的3个缺陷 | 影响 |
|------|---------------|------|
| **VOS** | 单核协作式调度、COW-less fork、ext4只读 | 无多核性能、fork大进程慢/耗内存、无法持久化写操作 |
| **Undefined-OS** | mount/umount用户态接口注释、procfs两套实现且硬编码、网络仅IPv4 | 无法动态挂载、代码维护负担、网络应用兼容性受限 |
| **starry-next** | **网络syscall未接入主分发器**、管道缓冲区仅256B、epoll纯轮询实现 | **网络功能不可用**、pipe性能极差、高并发I/O效率低 |
| **AstrancE** | **futex为桩实现**、ext4依赖C库增加构建复杂度、SMP负载均衡过于简单 | **pthread同步不可用**、跨工具链构建困难、多核性能受限 |
| **ZeroOS** | procfs/sysfs为空壳、无epoll、SIGSTOP/SIGCONT直接panic | 系统信息无法获取、高并发网络不可用、shell作业控制崩溃 |
| **ChCore** | mmap仅brk/mprotect、无epoll、信号处理基础 | 现代内存映射应用受限、高并发I/O受限、信号语义不完整 |

### 5.3 关键缺陷影响评估

**AstrancE的futex桩实现**是所有项目中最致命的功能缺陷——它直接导致基于pthread_mutex的任意多线程用户程序无法正确同步。考虑到pthreads是Linux用户态最基础的线程库，这个缺陷的影响面覆盖了几乎所有多线程应用。

**starry-next的网络syscall未接入**同样致命但影响面较窄——仅影响网络相关测试组（iperf、netperf），不影响其他测试的通过。

**VOS的单核限制**在竞赛的QEMU单核环境下影响不明显，但使得任何依赖多核并行加速的测试无法受益于SMP。

---

## 六、整体成熟度综合对比

### 6.1 综合评分

以"竞赛评测闭环的可靠完成能力"为基准（100分），结合"通用Linux兼容内核的发展潜力"为加权因子：

| 项目 | 功能广度(30) | 实现深度(25) | 架构设计(20) | 工程规范(15) | 创新性(10) | **总分** |
|------|:---------:|:---------:|:---------:|:---------:|:---------:|:------:|
| **VOS** | 28 | 18 | 17 | 13 | 8 | **84** |
| **Undefined-OS** | 25 | 19 | 18 | 13 | 7 | **82** |
| **starry-next** | 18 | 14 | 16 | 12 | 6 | **66** |
| **AstrancE** | 22 | 21 | 19 | 11 | 9 | **82** |
| **ZeroOS** | 23 | 18 | 17 | 12 | 7 | **77** |
| **ChCore** | 14 | 22 | 20 | 14 | 10 | **80** |

*注：功能广度反映syscall数量和子系统覆盖面；实现深度反映核心机制（如COW、调度、futex）的扎实程度；架构设计反映模块解耦和可扩展性；工程规范反映代码质量和文档完备度；创新性反映独特技术贡献的学术/工程价值。*

### 6.2 分类评价

**第一梯队（总分80+）——竞赛闭环能力强，综合成熟度高**：
- **VOS(84)**：syscall覆盖面最广(220+)，组合式VFS设计和运行时二进制补丁为独有亮点，但单核限制和COW-less fork制约了通用场景潜力。
- **Undefined-OS(82)**：进程模型最贴近POSIX标准，FileLike抽象和DynamicFs工程化程度高，但mount接口缺失和网络限制影响灵活性。
- **AstrancE(82)**：linkme陷阱框架和双共享内存是ArceOS生态内的最佳模块化实践，但futex桩实现是致命短板，严重影响多线程应用的正确性。
- **ChCore(80)**：微内核架构在安全性和模块化上理论最优，迁移式IPC是学术级创新，但syscall覆盖最少、mmap支持最基础，限制了应用兼容性。

**第二梯队（70-79）——功能完整但深度欠缺**：
- **ZeroOS(77)**：async模型新颖、真机适配扎实，但procfs/sysfs空壳和缺失epoll限制了高级应用场景。

**第三梯队（60-69）——代码精简但有重大功能缺口**：
- **starry-next(66)**：以最少代码实现最多架构，AxNamespace设计优雅，但网络不可用和256B管道是显著短板。

---

## 七、各项目总结评价

### VOS
VOS是六个项目中系统调用覆盖最广、竞赛策略最成熟的内核。其组合式VFS和musl运行时二进制补丁在ArceOS生态中具有独创性。阻塞型syscall通用框架（`wait_with_signal_deadline`）展现了成熟的工程抽象能力。主要短板在于单核协作式调度和COW-less fork——这虽是"最窄闭环"策略的有意识选择，但限制了其作为通用内核的演进空间。220个syscall和约500个LTP白名单case的覆盖面在竞赛场景中具有显著优势。

### Undefined-OS
Undefined-OS在进程管理规范化上做的最好——Session→ProcessGroup→Process→Thread四层模型是六者中最贴近POSIX标准的实现。FileLike trait和DynamicFs框架展现了良好的接口设计品味。系统调用追踪proc-macro是一个实用且精巧的调试工具创新。但mount/umount用户态接口的被注释和procfs的两套重复实现暗示了项目在比赛deadline压力下的赶工痕迹。

### starry-next
starry-next以约5,750行自有代码实现4架构支持和99个syscall，代码效率在六者中最高。AxNamespace资源隔离机制设计精巧——通过统一命名空间抽象优雅地解决了文件描述符和CWD的共享/独立问题。但其Unikernel部署方式、网络syscall未接入、256B管道缓冲区、以及COW缺失，使得该项目更像是"ArceOS上运行Linux程序的可行性验证"而非一个通用内核。

### AstrancE
AstrancE的代码规模和子系统丰富度在六者中最高（~76,572行），linkme可插拔陷阱框架是ArceOS生态中最优秀的架构创新。双共享内存(SysV+POSIX)和动态ELF加载展现了强大的功能深度。但futex桩实现是一个令人困惑的缺陷——在76,572行代码中实现futex WAIT/WAKE的几百行代码是性价比最高的投资之一，此处的缺失严重削弱了整体评估。

### ZeroOS
ZeroOS的async/await异步系统调用模型在六者中独树一帜，VisionFive2真机驱动适配（自研PLIC/RTC/SD驱动）展现了出色的底层硬件能力。但procfs/sysfs空壳和SIGSTOP/SIGCONT的`unimplemented!()`宏反映了一种务实的、面向比赛通过率的工程策略——对不影响测试得分的功能做最大化裁剪。

### ChCore
ChCore作为唯一的微内核项目，在架构设计的学术严谨性上远超其他项目。Capability安全模型、迁移式IPC、用户态系统服务等设计体现了完整的微内核哲学。然而其约50个syscall的覆盖度（无epoll、mmap仅brk/mprotect）意味着它在竞赛评测中的得分能力可能不如覆盖面广的宏内核项目。ChCore更适合作为微内核教学与研究平台，而非追求短期竞赛得分的作品。

---

## 八、评审意见

综合以上分析，这六个OS内核项目展示了2024-2026年操作系统竞赛中技术路线的显著分化：

**ArceOS生态已成为竞赛主流基座**——六个项目中有五个基于ArceOS框架构建，但复用策略从"薄封装"（VOS、starry-next）到"厚定制"（AstrancE、ZeroOS）形成了连续光谱。VOS以最小修改换取最大兼容性的策略在竞赛得分效率上最优，而AstrancE的深度定制在架构可扩展性上更胜一筹。

**"最窄闭环"竞赛策略普遍存在**——VOS的COW-less fork和单核调度、starry-next的Unikernel嵌入、ZeroOS的空壳procfs/sysfs、ChCore的基础mmap，均体现出面向比赛评测协议做功能裁剪的工程取舍。这种策略在竞赛限定时间内是最优解，但使得项目在"通用操作系统"维度上的参考价值下降。

**致命功能缺陷决定了实际可用性上限**——AstrancE的futex桩实现和starry-next的网络syscall未接入是六者中最影响实际使用的两个缺陷。前者使得所有pthread应用无法同步，后者使得所有网络应用根本无法使用。相比之下，VOS的单核限制和COW-less fork虽然制约了性能，但不影响功能正确性。

**创新性与工程完成度之间存在张力**——ChCore的迁移式IPC和Capability模型在学术创新上最优，但其syscall覆盖度和应用兼容性最差。VOS的musl运行时补丁在工程创新上别具一格，但其单核假设限制了对现代多核硬件的利用。AstrancE的linkme陷阱框架在架构创新上最为优雅，但被futex桩实现拖累了整体完成度。

在竞赛语境下，VOS以最高的syscall覆盖率（220+个）、独特的运行时补丁方案、以及精心设计的LTP白名单策略，在"有限时间内最大化评测得分"这一核心竞赛目标上表现最为突出。而在学术与教学语境下，ChCore的微内核设计和AstrancE的模块化架构提供了更丰富的长期研究价值。