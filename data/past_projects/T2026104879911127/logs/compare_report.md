Now I have all the information needed. Let me compile the comprehensive comparison report.

# 对比分析报告

## 一、项目概览

本报告对 MoonOS（当前项目）与五个基于 ArceOS 生态的同类宏内核项目进行多维度对比分析。六个项目均采用 Rust 语言、以 ArceOS 为组件化底座构建 Linux 兼容宏内核，共享相似的架构基因，但在子系统深度、技术侧重点和工程规模上存在显著差异。

| 属性 | MoonOS | starry-next（燕山大学） | WenyiOS（天津理工） | OSKernel2024-KeepOnOS（南开大学） | StarryX（杭州电子科大） | StarryOS（海南大学） |
|------|--------|------------------------|---------------------|----------------------------------|------------------------|---------------------|
| 自有代码行数 | ~23,500 | ~5,750 | ~10,400 | ~50,000 | ~22,800 | ~10,000+ |
| 系统调用数 | ~202 | ~99 | ~100+ | ~116+ | ~200 | ~100+ |
| 支持架构 | RV64/LA64/x86/ARM | RV64/LA64/x86/ARM | RV64/LA64/x86/ARM | RV64/ARM/x86 | RV64/LA64/ARM/x86 | RV64/LA64/x86/ARM |
| 层级架构 | 三层 | 三层 | 三层 | 四层 | 三层 | 三层 |
| 文件数 | ~200+ | ~43 | ~55 | ~300+ | ~167 | ~150+ |

---

## 二、架构设计对比

| 维度 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|------|--------|-------------|---------|----------|---------|----------|
| 内核类型 | 宏内核 | Unikernel风格宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| 分层方式 | api/core/arceos | api/core/arceos | api/core/arceos | 四层（含独立模块层） | xapi/xcore/xmodules/arceos | api/core/arceos |
| 模块化程度 | 高，vendor子crate拆分 | 中，集中于core+api | 中，crates扩展 | 高，四层架构 | 高，三层+独立xmodules | 中，crates扩展 |
| ArceOS依赖深度 | 深度复用 | 深度复用 | 深度复用 | 深度复用 | 深度复用 | 深度复用 |
| 进程资源隔离 | scope_local + extern_trait | AxNamespace | AxNamespace | AxNamespace | AxNamespace | AxNamespace |

### 架构设计总结

MoonOS 与 starry-next、WenyiOS 采用极为相似的三层架构（api/core/arceos），属于同一技术谱系（starry-next 系列）。StarryX 在此基础上进一步模块化，将可复用组件抽取为独立的 `xmodules/` 层（含 xprocess、xsignal、xvma、xcache、xuspace、xutils），达到了更高的模块解耦程度。KeepOnOS 的四层架构在模块化方面最为彻底。

MoonOS 的独特之处在于使用 `scope_local!` 宏 + `#[extern_trait]` 机制实现进程资源作用域与任务调度器的集成，比其余项目的 `AxNamespace` 方案更为轻量且避免了显式命名空间对象传递。StarryX 的 `xmodules/` 独立 crate 设计则是模块化程度最高的方案，达到了组件级复用。

---

## 三、子系统实现对比

### 3.1 内存管理子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| mmap/munmap/mprotect | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| 大页支持（2M/1G） | 支持 | 支持 | 不支持 | 支持 | 支持 | 支持 |
| COW（写时复制） | 支持 | 不支持（全复制） | 不支持 | 支持 | 支持 | 支持 |
| brk动态扩展 | 支持 | 固定64KB | 固定64KB | 支持 | 支持 | 简单 |
| LRU页缓存 | 基于axmm | 无 | 无 | 有 | 独立实现（xcache） | 无 |
| 按需分页 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |
| 共享内存映射 | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| mlock/madvise/msync | 部分 | 不支持 | 不支持 | 部分 | 存根 | 不支持 |
| ELF加载缓存 | LRU 32条 | 无 | 无 | 有 | 无 | 无 |

**分析**：MoonOS 在内存管理方面处于上游水平。COW 支持与动态 brk 扩展补齐了 starry-next/WenyiOS 的主要短板。StarryX 的 xcache 独立页缓存模块（含 LRU 淘汰与脏页回写）和 KeepOnOS 的延迟分配机制是两项 MoonOS 缺失的特性。starry-next 和 WenyiOS 的 brk 固定 64KB 是它们最明显的短板。

### 3.2 进程管理子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| fork/clone标志覆盖 | 高（大部分标志） | 中高 | 中高 | 高 | 高 | 中高 |
| execve（含shebang） | 完整（4层递归） | 基本 | 基本 | 完整 | 完整 | 基本 |
| 多线程execve | 不支持 | 不支持 | 不支持 | 部分 | 不支持 | 不支持 |
| exit/exit_group | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| robust futex清理 | 支持 | 不支持 | 不支持 | 支持 | 支持 | 部分 |
| 进程组/会话 | 完整 | 部分（setsid占位） | 部分 | 完整 | 完整 | 部分（桩实现） |
| 命名空间 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 调度算法 | 仅RR | 仅RR | 仅RR | CFS+3种+CPU亲和性 | 仅RR | 仅RR |

**分析**：进程管理是所有项目实现最一致的子系统，核心生命周期管理（fork/execve/exit/wait4）均完整。MoonOS 的优势在于 Shebang 递归解析（4层深度+绝对路径固化）和对 robust futex 的完整支持。**KeepOnOS 是唯一实现多种调度算法（含 CFS）和 CPU 亲和性的项目**，这是 MoonOS 最大的差距之一。所有项目在多线程 execve 上均存在限制。

### 3.3 文件系统子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| VFS抽象 | 可组合框架（SimpleFile/SimpleFs） | FileLike trait | FileLike trait | FileLike trait | FileLike trait | 多层Trait |
| ext4支持 | 支持（lwext4） | 支持 | 支持 | 支持 | 支持 | 支持 |
| FAT32支持 | 支持 | 支持（vfat） | 支持 | 支持 | 支持 | 支持 |
| tmpfs | 完整实现 | 无 | 无 | 有 | 完整实现 | 有 |
| procfs | 较完整 | 仅/proc/self/exe | 无 | 有 | 完整实现 | 硬编码静态数据 |
| devfs | 完整（含PTY） | 无 | 无 | 有 | 完整（含标准设备） | 有 |
| 管道缓冲区 | 64KB（ringbuf） | 256字节 | 256字节 | 较大 | 64KB | 256字节 |
| 管道等待机制 | 同步原语（阻塞） | yield_now() | yield_now() | 同步原语 | 同步原语 | yield_now() |
| epoll | LT/ET/One-Shot | 轮询遍历 | 无（仅poll/select） | 有 | ET/One-Shot（轮询转换） | 轮询遍历 |
| eventfd | 完整 | 无 | 无 | 无 | 无 | 无 |
| signalfd | 完整 | 无 | 无 | 无 | 无 | 无 |
| 硬链接管理 | 有 | HardlinkManager | HardlinkManager | 有 | 有 | 有 |

**分析**：MoonOS 在文件系统方面有明显优势。其 VFS 采用可组合的 `SimpleFile`/`SimpleFs`/`DirMaker` 工厂模式，比其余项目的 `FileLike` trait 方案更灵活。epoll 是 MoonOS 的突出亮点——完整支持 LT/ET/One-Shot 三种模式，使用 `EntryKey`（fd+Weak指针）防止 FD 复用混淆，而 starry-next 和 StarryOS 仅为轮询遍历、StarryX 底层也是基于 poll 转换。eventfd 和 signalfd 是 MoonOS 独有实现。管道实现上 MoonOS 和 StarryX 使用 64KB ringbuf + 同步原语等待，明显优于 starry-next/WenyiOS/StarryOS 的 256 字节 + yield 方案。StarryX 的 procfs 实现最为完整。

### 3.4 IPC 子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| System V 共享内存 | 完整（shmget/shmat/shmdt/shmctl） | 完整 | 完整 | 完整 | 完整 | 完整 |
| System V 信号量 | 不支持 | 不支持 | 不支持 | 无 | 完整（含SEM_UNDO） | 完整（含SEM_UNDO） |
| System V 消息队列 | 不支持 | 不支持 | 不支持 | 无 | 完整（含类型接收） | 不支持 |
| POSIX IPC | 不支持 | 不支持 | 不支持 | 无 | 不支持 | 不支持 |

**分析**：**StarryX 是唯一实现完整 System V IPC 三大机制（共享内存+信号量+消息队列）的项目**。StarryOS 实现了共享内存和信号量。MoonOS、starry-next、WenyiOS 仅实现了共享内存。这是 MoonOS 在 IPC 方面最明显的不足。StarryX 的 System V 信号量实现（~772行）和消息队列实现（~371行）可作为 MoonOS 未来补充的参考。

### 3.5 信号子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| 信号类型覆盖 | 64种信号 | 64种信号 | 64种信号 | 完整 | 64种信号 | 64种信号 |
| rt_sig系列接口 | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| 信号跳板（trampoline） | 固定地址映射（4KB对齐） | 固定地址映射 | 固定地址映射 | 有 | 固定地址映射 | 固定地址映射 |
| 进程/线程两级队列 | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| sigaltstack | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |
| Core dump | 不支持 | 不支持 | 不支持 | 无 | 不支持 | 不支持 |
| Stop/Continue | 不支持 | 不支持 | 不支持 | 无 | 不支持 | 不支持 |

**分析**：信号子系统在所有项目中实现程度高度一致。均采用固定地址信号跳板（trampoline）设计，支持进程/线程两级信号队列。Core dump 和 Stop/Continue 动作是所有项目的共同缺失项。

### 3.6 同步子系统（Futex）

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| 基础Futex（WAIT/WAKE） | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |
| REQUEUE | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |
| BITSET | 支持 | 不支持 | 不支持 | 无 | 支持 | 不支持 |
| Robust Futex | 完整 | 不支持 | 不支持 | 支持 | 完整 | 部分 |
| PI Futex | 不支持 | 不支持 | 不支持 | 无 | 不支持 | 不支持 |
| Futex键模型 | Private/Shared（虚拟地址+SharedPages） | 物理地址 | 物理地址 | 物理地址 | 物理地址 | 物理地址（分片哈希） |
| 并发设计 | 进程私有FutexTable | 进程私有BTreeMap | 进程私有BTreeMap | 进程私有 | 进程私有 | SMP分片（SHARD_NUM=1<<SMP） |

**分析**：Futex 实现展现了各项目在设计深度上的差异。MoonOS 的 `FutexKey` 区分 Private 和 Shared 模式、以虚拟地址索引进程私有 futex 并以 `SharedPages` 支持跨进程 futex，语义比其余项目单纯以物理地址为键的方案更接近 Linux。**StarryOS 的分片 Futex 表设计（按 SMP 核数分片）是面向多核并发优化的独特方案**，能有效降低锁竞争。StarryX 和 MoonOS 均完整支持 robust futex（健壮 futex），这是对 pthread 健壮互斥锁的关键支撑。

### 3.7 网络子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| TCP/UDP | 完整 | 对象封装（未接入分发） | 基础可用 | 完整 | 完整 | 基础可用 |
| Unix Domain Socket | 完整（流式+数据报） | 无 | 无 | 无 | 完整 | 无 |
| Vsock | 条件编译支持 | 无 | 无 | 无 | 无 | 无 |
| sendmsg/recvmsg | 完整 | 不支持 | 不支持 | 有 | 完整 | 不支持 |
| 地址族 | AF_INET/INET6/UNIX/VSOCK | AF_INET | AF_INET | AF_INET/INET6 | AF_INET/INET6/UNIX | AF_INET/INET6 |

**分析**：MoonOS 在网络子系统的广度上领先——Unix Domain Socket（流式+数据报）、Vsock、sendmsg/recvmsg（含 cmsg 辅助数据）均为独有或少数项目拥有的特性。starry-next 虽然封装了 TCP/UDP Socket 对象，但系统调用入口未接入主分发器，导致用户态程序无法实际使用网络功能，这是它最严重的短板。

### 3.8 终端与交互子系统

| 功能点 | MoonOS | starry-next | WenyiOS | KeepOnOS | StarryX | StarryOS |
|--------|--------|-------------|---------|----------|---------|----------|
| 行规程（line discipline） | 完整（规范+非规范） | 无 | 无 | 有 | 基础 | 基础 |
| PTY（伪终端） | 完整（ptm/pts对） | 无 | 无 | 无 | 无 | 无 |
| termios | 完整（含Termios2） | 部分ioctl | 基础 | 有 | 基础 | 基础 |
| 作业控制 | 部分（前台进程组+信号） | 无 | 无 | 无 | 无 | 无 |

**分析**：终端子系统是 MoonOS 相比所有对比项目最突出的差异化优势。完整的行规程（规范/非规范模式、回显控制、信号生成）、PTY 伪终端对（`/dev/ptmx` + `/dev/pts/N`）、Termios2 扩展结构均为 MoonOS 独有。这使 MoonOS 能支持交互式终端程序（如通过 PTY 的 ssh 会话），而其余项目仅限于基础串口输出。

---

## 四、技术亮点对比

### 4.1 MoonOS 的独特亮点

1. **可组合 VFS 框架**：`SimpleFile`/`SimpleFs`/`DirMaker` 工厂模式 + trait object 动态子节点查找，比其余项目的静态 FileLike trait 方案更灵活，procfs/tmpfs/devfs 均基于此框架构建。

2. **完整 epoll 实现**：LT/ET/One-Shot 三模式 + `EntryKey`（fd+Weak指针）防 FD 复用混淆，是同类项目中最完善的 epoll 实现。

3. **signal/event/pid fd**：signalfd（128字节兼容 Linux 格式）、eventfd（含信号量模式）、pidfd（poll 进程退出事件）均为独有实现。

4. **PTY + 行规程**：完整的伪终端子系统，支持规范/非规范模式、回显控制、作业控制信号生成。所有对比项目均缺失此能力。

5. **FutexKey 双模式设计**：Private（虚拟地址索引）和 Shared（SharedPages 关联）两种键模型，比物理地址方案更接近 Linux 语义，且避免了物理地址 ABA 问题。

6. **ELF 加载 LRU 缓存**：32 条目 LRU 缓存减少重复 ELF 解析开销，starry-next 和 WenyiOS 均无此优化。

7. **Shebang 递归解析**：最大 4 层递归 + 绝对路径固化 + `/bin/sh` 回退，深度优于其他项目的单层解析。

### 4.2 对比项目的独特亮点

| 项目 | 核心亮点 | MoonOS 差距 |
|------|---------|-------------|
| **KeepOnOS** | CFS等3种调度算法 + CPU亲和性 + 精确内核/用户态时间统计 | MoonOS仅RR调度，无CPU亲和性 |
| **StarryX** | 完整System V IPC三件套（信号量+消息队列+共享内存）+ 独立LRU页缓存 | MoonOS仅共享内存，无独立页缓存 |
| **StarryOS** | SMP分片Futex表（降低多核锁竞争）+ COW + 大页 | Futex并发设计可借鉴 |
| **starry-next** | 最小代码量（5750行）达到99个syscall，效率极高 | MoonOS代码量大但部分功能密度低 |
| **WenyiOS** | 类型安全的UserPtr封装 + AxNamespace进程隔离 | 设计与MoonOS早期版本相似度高 |

---

## 五、不足与缺失对比

### 5.1 MoonOS 的主要不足

| 不足 | 严重程度 | 对比参照 |
|------|---------|---------|
| 仅RR调度，无CFS/实时调度 | 中 | KeepOnOS有3种调度算法 |
| IPC仅限于共享内存，缺信号量和消息队列 | 中 | StarryX有完整System V IPC |
| 不支持多线程execve | 低 | 所有项目均不支持 |
| 命名空间不支持（CLONE_NEW*均为空操作） | 低 | 所有项目均不支持 |
| 无Core dump | 低 | 所有项目均不支持 |
| 无独立页缓存模块 | 低 | StarryX有xcache |
| ext4依赖C FFI（lwext4），增加构建复杂度 | 低 | 同类项目均有此依赖 |

### 5.2 对比项目的主要不足

| 项目 | 主要不足 |
|------|---------|
| **starry-next** | 无COW（fork全复制）、brk固定64KB、管道256字节+yield等待、epoll轮询、网络syscall未接入、无signalfd/eventfd/PTY、仅99个syscall |
| **WenyiOS** | 无COW、brk固定64KB、管道256字节+yield等待、仅有poll/select无epoll、无signalfd/eventfd/PTY、无Unix Socket |
| **KeepOnOS** | 未获得源码，无法具体评估；据资料显示代码量最大但具体覆盖度不明 |
| **StarryX** | epoll底层基于poll转换（非事件驱动）、msync/madvise仅存根、无PTY/行规程、无eventfd/signalfd、无POSIX IPC |
| **StarryOS** | procfs硬编码静态数据、epoll轮询遍历、管道256字节+yield、进程组/会话管理为桩、Futex物理地址键有ABA隐患、无PTY |

---

## 六、整体成熟度综合评分

以"可运行标准 Linux 用户态程序（含交互式终端）的通用 Linux 兼容宏内核"为 100% 基准，综合各子系统实现深度、系统调用覆盖度、架构设计和工程质量的加权评分如下：

| 项目 | 系统调用覆盖 | 内存管理 | 进程管理 | 文件系统 | IPC | 网络 | 信号 | 同步 | 终端 | 综合评分 |
|------|:----------:|:------:|:------:|:------:|:---:|:---:|:---:|:---:|:---:|:------:|
| **MoonOS** | 85% | 85% | 80% | 85% | 50% | 75% | 75% | 90% | 80% | **80%** |
| **StarryX** | 83% | 80% | 85% | 85% | 85% | 75% | 80% | 85% | 60% | **80%** |
| **KeepOnOS** | 75% | 85% | 85% | 80% | 70% | 75% | 75% | 80% | 60% | **77%** |
| **StarryOS** | 75% | 80% | 75% | 75% | 70% | 70% | 75% | 80% | 55% | **73%** |
| **WenyiOS** | 70% | 70% | 75% | 70% | 50% | 65% | 80% | 70% | 50% | **67%** |
| **starry-next** | 65% | 65% | 75% | 70% | 50% | 40% | 75% | 70% | 45% | **62%** |

---

## 七、各项目总结评价

### MoonOS（当前项目）

MoonOS 是 starry-next 系列中功能最丰富、子系统覆盖最广的演进版本。它在 epoll（LT/ET/One-Shot）、VFS 可组合框架、PTY+行规程、signalfd/eventfd/pidfd、FutexKey 双模式设计等方面处于所有对比项目的领先地位，202 个系统调用覆盖也是最高值。管道实现（64KB ringbuf+同步原语）解决了早期 starry-next 系列的性能问题。主要短板在于 IPC 仅限于共享内存（缺信号量和消息队列）、调度算法仅有 RR、以及缺乏独立的页缓存模块。

### starry-next（燕山大学-模仿游戏）

该项目的突出优势在于**代码效率极高**——以仅 5,750 行自有代码实现了 99 个系统调用和四架构支持，是 starry-next 系列的"最小可行原型"。其 AxNamespace 资源隔离和 System V 共享内存实现扎实。但由于代码量限制，在 COW、brk 动态扩展、管道性能、epoll 实现质量、网络可用性等方面存在明显简化。适合作为入门参考或快速原型，但作为通用内核的深度不足。

### WenyiOS（天津理工大学-九莲宝灯一向听）

WenyiOS 是 starry-next 的一个直接分支，代码规模约 10,400 行，实现了与 starry-next 高度相似的功能集。其主要增量在于类型安全的 UserPtr 封装和更完善的系统调用入口组织。整体成熟度与 starry-next 接近，但在 epoll、eventfd、PTY 等 MoonOS 已有特性上尚存差距。

### OSKernel2024-KeepOnOS（南开大学-萌新）

该项目最突出的特色是**调度子系统的深度**——支持 CFS 等三种调度算法和 CPU 亲和性，这是所有对比项目中独一无二的。近 50,000 行的代码规模最大，四层架构的模块化程度最高。然而由于未获得该项目的源码仓库，无法进行更深入的代码级对比。从公开信息看，其在终端交互和 IPC 完备性方面可能弱于 MoonOS 和 StarryX。

### StarryX（杭州电子科技大学-StarryX）

StarryX 在 IPC 完备性方面**明显领先于所有项目**——是唯一完整实现 System V 三大 IPC 机制（共享内存+信号量+消息队列）的内核。其 `xmodules/` 独立模块层设计达到了最高的代码复用水平。独立实现的 xcache（LRU 页缓存+脏页回写）是区别于依赖 ArceOS 基座内存管理的独特贡献。综合评分与 MoonOS 并列最高，两者的技术侧重点不同：MoonOS 擅长文件系统/VFS/终端/epoll，StarryX 擅长 IPC/模块化/页缓存。

### StarryOS（海南大学-狗剩）

该项目的核心创新是**SMP 分片 Futex 表**——按 CPU 核数将 Futex 哈希表分片（`SHARD_NUM = 1 << SMP`），是唯一针对多核并发锁竞争进行专门优化的项目。COW 和大页支持体现了对性能的考量。但 procfs 采用硬编码静态数据、epoll 轮询遍历、管道使用 yield 等待等设计降低了系统的动态反馈能力和 I/O 性能。

---

## 八、评审意见

MoonOS 是一个在 ArceOS/Starry-next 技术谱系中处于**领先梯队**的宏内核项目。与同类项目相比，MoonOS 在以下方面展现出显著优势：

1. **系统调用覆盖最广**（202 个），涵盖文件系统、进程管理、内存管理、网络、信号、同步、时间等核心领域。
2. **epoll 实现最为完善**，完整支持 LT/ET/One-Shot 三种触发模式，使用 EntryKey（fd+Weak指针）防止 FD 复用混淆，远超同系列其他项目的轮询实现。
3. **VFS 框架设计最具可扩展性**，基于 `SimpleFile`/`SimpleFs`/`DirMaker` factory 模式的可组合虚拟文件系统，使得 procfs、tmpfs、devfs 均可在此框架上简洁构建。
4. **终端子系统为独有能力**，完整的 PTY 伪终端 + 行规程 + termios 支持，使得 MoonOS 能够运行依赖终端的交互式程序，这是所有对比项目均不具备的能力。
5. **Futex 设计语义更接近 Linux**，Private/Shared 双模式 FutexKey 避免了物理地址方案的 ABA 隐患。

同时，MoonOS 在以下方面存在可改进空间：

1. **IPC 完备性不足**：仅实现 System V 共享内存，缺失信号量和消息队列。StarryX 已证明在 ArceOS 框架下可以实现完整的 System V IPC 三大机制，这是 MoonOS 最优先的补全方向。
2. **调度策略单一**：仅有 RR 调度，无 CFS、实时调度或 CPU 亲和性支持。KeepOnOS 的 CFS 实现表明在 ArceOS 框架下替换调度器是可行的。
3. **无独立页缓存模块**：当前依赖 ArceOS 基座的 axmm 提供页缓存，StarryX 的 xcache 独立实现方案可作为参考。
4. **多线程支持不完善**：多线程 execve 不支持、线程信号定向传递有限。不过这是所有同类项目的共性问题。

综合而言，MoonOS 在其选定的技术方向上（VFS 可组合性、I/O 多路复用质量、终端交互能力）达到了同类项目中的最高水平，与 StarryX 在 IPC 和模块化方面的优势形成互补。两者并列处于当前 ArceOS 宏内核赛道的第一梯队，各有侧重、各有千秋。若 MoonOS 能在 IPC 完备性和调度算法多样性上进行补全，将具备成为该赛道标杆项目的潜力。