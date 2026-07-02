# 对比分析报告

## 一、对比项目总览

本报告对当前项目（以下简称"本项目"）与五个选定的同类竞赛内核项目进行多维度对比分析。所有项目均为基于 Rust 语言开发的宏内核，面向 OSKernel 竞赛场景，以 Linux ABI 兼容为主要目标。

| 项目 | 队伍 | 基础框架 | 架构 | 代码规模（内核） | 系统调用数 | 文件系统 |
|------|------|----------|------|------------------|------------|----------|
| **本项目 (OSKernel)** | --- | rCore-Tutorial-v3 | RISC-V 64 / LoongArch 64 (最小) | ~15,000 行 | ~85 标准 + ~17 自定义 | easy-fs + EXT4 (只读+overlay) |
| **ChaOS** | 北京科技大学-chaos | rCore-Tutorial | RISC-V 64 | ~12,917 行 | ~50+ | EXT4 (ext4_rs, 部分操作) |
| **TrustOS** | 华中科技大学-RustTrustHuster | rCore-Tutorial ch6 | RISC-V 64 | ~14,625 行 | 105 | EXT4 (lwext4, 完整) |
| **Nonix OS** | 南开大学-如有名字队 | rCore+TrustOS+polyhal | RISC-V 64 / LoongArch 64 | ~10,979 行 | 73 | EXT4 (lwext4, 完整) |
| **SubsToKernel** | 北京科技大学-SubsToKernel | rCore-Tutorial ch8 | RISC-V 64 / LoongArch 64 | ~91 源文件 | ~100+ | EXT4 (lwext4, 完整) |
| **ZeroOS** | 南开大学-萌新 | ArceOS/Starry | RISC-V 64 | ~61,441 行 (workspace) | ~101 | EXT4 + FAT + ramfs + devfs + procfs |

---

## 二、多维度对比分析

### 2.1 架构设计

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核（组件化） |
| **生态归属** | rCore-Tutorial-v3 | rCore-Tutorial | rCore-Tutorial ch6 | rCore + TrustOS 混合 | rCore-Tutorial ch8 | ArceOS/Starry |
| **架构数量** | 2 (RV64主要/LA64最小) | 1 (RV64) | 1 (RV64) | 2 (RV64/LA64) | 2 (RV64/LA64) | 1 (RV64) |
| **模块化程度** | 中（传统目录分层） | 中（传统目录分层） | 中（传统目录分层） | 中（polyhal HAL层） | 中高（hal目录分离） | 高（workspace多crate组件化） |
| **硬件抽象** | 无统一HAL，arch/目录不完整 | 无统一HAL，boards/目录 | 无统一HAL | polyhal 统一HAL | hal/目录分离架构代码 | axhal 统一HAL |
| **调度器** | FIFO 协作式 | FIFO | FIFO | FIFO | FIFO (stride注释) | 多策略(FIFO/RR/CFS) |
| **多核支持** | 无 | 无 | 无 | 无 | 无 | 框架支持(未验证) |
| **地址空间模型** | 恒等映射内核空间 | 高半核映射 | 高半核映射 | polyhal管理 | 高半核(RV)/DMW(LA) | 高半核映射 |

**分析**：

- 本项目与 ChaOS、TrustOS 同属传统 rCore 目录分层风格，模块化程度相近。ZeroOS 采用 ArceOS 组件化架构，模块解耦最彻底。
- Nonix OS 和 SubsToKernel 在双架构支持方面最成熟，均通过统一的硬件抽象层实现 RV64/LA64 代码复用。本项目的 LoongArch 支持仅为最小启动验证（约 1000 行独立代码），远未达到与 RISC-V 对等的程度。
- ZeroOS 是唯一支持多种调度算法的项目（FIFO、Round-Robin、CFS），其余项目均仅实现基础 FIFO 调度。

### 2.2 内存管理子系统

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **分页模式** | Sv39 | Sv39 | Sv39 | Sv39 | Sv39 | Sv39 |
| **物理页分配器** | 栈式(回收+线性) | 栈式(回收注释掉) | 栈式(Vec回收) | 伙伴系统 | 栈式(Vec回收) | 位图+Slab/Buddy/TLSF |
| **写时复制(COW)** | 无 | 无 | 有(PTE第9位标记) | 有 | 有(PTE第9位标记) | 有 |
| **延迟分配(Lazy)** | 无 | 无 | 有 | 有(栈/堆/brk) | 有(堆/栈/brk) | 有 |
| **mmap** | 仅匿名映射 | 匿名+文件 | 匿名+文件 | 匿名+文件 | 匿名+文件 | 匿名+文件 |
| **共享内存(SHM)** | 无 | 无 | System V | System V | System V | System V (IPC_PRIVATE) |
| **mprotect** | 仅刷TLB(无实际权限变更) | 无 | 有 | 有 | 有 | 有 |
| **共享组机制** | 无 | 无 | GroupManager | GroupManager | GroupManager | SharedMem |
| **swap** | 无 | 无 | 无 | 无 | 无 | 无 |

**分析**：

本项目的内存管理子系统在此对比中处于明显劣势。COW、延迟分配、文件映射 mmap、System V 共享内存等现代操作系统必备的内存优化技术均未实现。TrustOS、Nonix OS 和 SubsToKernel 在内存管理方面实现最为完整，均具备 COW + 延迟分配 + 文件映射 mmap 的组合。ZeroOS 的物理分配器最为灵活（支持 Slab/Buddy/TLSF 三种算法），Nonix OS 和 SubsToKernel 的 mmap 共享组机制设计精巧，有效解决了 fork 后 MAP_SHARED 区域的物理帧共享问题。

### 2.3 文件系统子系统

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **EXT4 实现方式** | 自研只读解析器 | ext4_rs (Rust库) | lwext4 (C库FFI) | lwext4 (C库FFI) | lwext4 (C库FFI) | another_ext4 (Rust) |
| **EXT4 写入支持** | 否(仅overlay伪写) | 部分(todo!) | 是(通过lwext4) | 是(通过lwext4) | 是(通过lwext4) | 是 |
| **VFS 抽象** | File trait | Dentry/Inode模型 | Inode/File trait | File trait/FileClass | VFS层(ext4_lw/) | RootDirectory多挂载点 |
| **多文件系统** | easy-fs + EXT4 | EXT4 (FAT32未集成) | EXT4 + devfs | EXT4 | EXT4 + devfs | EXT4+FAT+ramfs+devfs+procfs |
| **管道** | 环形缓冲区(32B) | 环形缓冲区(32B) | 环形缓冲区(64KB) | 环形缓冲区(32B) | 环形缓冲区 | 环形缓冲区 |
| **页缓存(Page Cache)** | 无 | 无 | 无 | 无 | 无 | 无 |
| **符号链接** | 快速符号链接 | 部分 | 完整 | 部分 | 完整 | 用户态模拟 |
| **/proc** | 无 | 无 | 无 | 有(动态注册) | 静态文件 | 有(procfs) |
| **overlay层** | 有(内存overlay) | 无 | 无 | 无 | 无 | 无 |

**分析**：

本项目在文件系统方面有一个独特设计——EXT4 只读解析器配合内存 overlay 层，使得只读的 EXT4 实现能够支撑用户程序的"写入"需求。这一设计在同类项目中独一无二，是对自研 EXT4 解析器的巧妙补充。

但 TrustOS、Nonix OS 和 SubsToKernel 通过 lwext4 C 库获得了完整的 EXT4 读写能力，功能更为完备。ZeroOS 的文件系统生态最为丰富，支持 EXT4、FAT、ramfs、devfs、procfs 五类文件系统，且通过 VFS 多挂载点机制进行统一管理。

本项目的管道缓冲区仅 32 字节，TrustOS 为 64KB，差距显著，直接影响管道吞吐量。

### 2.4 进程与任务管理

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **进程模型** | PCB+TCB分离 | TCB统一模型 | TCB | PCB+TCB | PCB+TCB | Task (统一) |
| **线程支持** | 有(sys_thread_create) | 有(clone) | 有(clone,完整flags) | 有(clone) | 有(clone,完整flags) | 有(clone) |
| **clone flags** | 基础 | 部分 | 完整(VM/FS/FILES/THREAD等) | 部分 | 完整 | 完整 |
| **COW fork** | 无(完整复制) | 无 | 有 | 有 | 有 | 有 |
| **exec** | ELF加载+aux vector | ELF加载+aux vector | ELF+脚本+aux vector | ELF加载+aux vector | ELF+动态链接+aux vector | ELF加载+aux vector |
| **waitpid** | 有(含WNOHANG) | 有 | 有 | 有 | 有 | 有 |
| **动态链接** | 部分(aux vector) | 部分 | 完整 | 部分 | 完整(ld-musl) | 完整 |
| **进程组/会话** | 无 | 无 | 无 | 有(setpgid/getpgid) | 有 | 有 |
| **资源限制** | stub | 无 | 有(prlimit64) | 有(prlimit) | 有 | 有(prlimit64/getrusage) |

**分析**：

ChaOS 的 TCB 统一模型在概念上最为简洁，将进程和线程统一为一个数据结构，通过 pid/tid 区分。本项目采用传统的 PCB+TCB 分离模型，语义更清晰但代码量更大。

TrustOS 和 SubsToKernel 的 clone 实现最为完整，支持完整的 Linux clone flags，包括 CLONE_PARENT_SETTID、CLONE_CHILD_CLEARTID 等细节，能够良好支撑 pthread 库。本项目仅支持自定义的 sys_thread_create，不符合 POSIX 线程创建语义。

本项目 fork 时完整复制地址空间（无 COW），在内存效率上显著落后于 TrustOS、Nonix OS、SubsToKernel 和 ZeroOS。

### 2.5 信号机制

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **信号数量** | 8种(基础) | 64种 | 31种(标准) | 31种 | 33种(含实时信号) | 31种 |
| **用户态handler** | 无(stub) | 框架(执行逻辑缺失) | 有(完整信号帧) | 框架(sigreturn未实现) | 有(完整信号帧) | 有 |
| **信号帧构建** | 无 | 无 | 用户栈构建+魔数校验 | 无 | 用户栈构建 | 有 |
| **SA_SIGINFO** | 无 | 无 | 有 | 无 | 有 | 有 |
| **SA_RESTART** | 无 | 无 | 有 | 无 | 部分 | 有 |
| **sigsuspend** | 无 | 无 | 无 | 有 | 无 | 有 |
| **实时信号** | 无 | 无 | 无 | 无 | 部分 | 无 |

**分析**：

信号处理是本项目和 ChaOS 共同的薄弱环节。本项目仅实现了信号记录和致命信号终止，rt_sigaction 为 stub，无法注册用户态信号处理函数。ChaOS 的信号框架已建立但执行逻辑不完整。

TrustOS 和 SubsToKernel 的信号实现最为完整，均支持在用户栈构建标准信号帧、SA_SIGINFO 传递详细上下文、sigreturn 上下文恢复。ZeroOS 的信号支持同样成熟。

### 2.6 同步原语

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **内核锁** | UPIntrFreeCell | UPSafeCell | Mutex/SpinNoIrq | UPSafeCell/spin::Mutex | UPSafeCell | SpinNoIrq |
| **互斥锁** | MutexSpin/MutexBlocking | SpinMutex | 无内核实现 | 无 | 有 | 有 |
| **信号量** | 有 | 有(注释掉) | 无 | 无 | 有 | 无 |
| **条件变量** | 有 | 无(注释掉) | 无 | 无 | 有 | 无 |
| **Futex** | FUTEX_WAIT/WAKE | 无 | FUTEX_WAIT/WAKE/REQUEUE | 无 | 4种操作+原子操作 | 有 |
| **银行家算法** | 无 | 无 | 无 | 无 | 有 | 无 |
| **读写锁** | 无 | 无 | 无 | 无 | 无 | 无 |

**分析**：

本项目的同步原语实现最为全面——互斥锁（自旋+阻塞）、信号量、条件变量、Futex 基础操作一应俱全。SubsToKernel 在此基础上加入了银行家算法死锁避免和完整的 Futex 四种操作（含 FUTEX_REQUEUE、FUTEX_WAKE_OP），是同步子系统的标杆。

ChaOS 的同步原语大部分被注释，实际可用性有限。Nonix OS 几乎未实现内核同步原语。ZeroOS 的 Futex 实现支持健壮列表（robust_list），是唯一考虑 pthread 健壮性需求的项目。

### 2.7 网络子系统

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **协议栈** | lose-net-stack | 无 | 无 | 无 | smoltcp | smoltcp |
| **TCP** | 有(基础) | 无 | 无 | 无 | 有 | 有 |
| **UDP** | 有 | 无 | 无 | 无 | 有 | 有 |
| **Socket API** | 有(BSD风格) | 无 | socketpair仅本地 | 无 | 有 | 有 |
| **DNS** | 无 | 无 | 无 | 无 | 有 | 无 |
| **DHCP** | 无(IP硬编码) | 无 | 无 | 无 | 无 | 无 |

**分析**：

本项目是唯一在 rCore 系项目中集成网络协议栈的（基于 lose-net-stack），实现了基本的 TCP/UDP 和 BSD Socket API。SubsToKernel 和 ZeroOS 基于 smoltcp 实现了更成熟的网络支持。ChaOS、TrustOS 和 Nonix OS 均未实现网络功能。

本项目的网络 IP 地址硬编码且缺乏 TCP 拥塞控制，仅为概念验证级别。

### 2.8 测试与基础设施

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **内置测试框架** | 有(runner, ~1127行) | 无(外部Python脚本) | 有(Docker测试环境) | 无 | 无 | 无 |
| **测试套件支持** | glibc/musl/lmbench/ltp等9种 | 基础测试 | LTP/busybox/lmbench等7种 | busybox shell | 基础测试 | LTP/busybox/lua/unixbench等 |
| **自动化程度** | 高(启动自动执行) | 外部脚本 | Docker自动化 | runall.sh | 基础 | Makefile驱动 |
| **结果输出** | 结构化矩阵格式 | 基础 | 无特定格式 | 基础 | 基础 | 基础 |
| **构建系统** | cargo+Makefile | cargo+Makefile | cargo+Makefile | cargo+Makefile | cargo+Makefile | cargo+Makefile(多平台) |

**分析**：

本项目内置的 runner 测试框架是独特亮点，支持内核启动后自动执行多种外部测试套件（glibc、musl、lmbench、lua、iozone、cyclictest、ltp、iperf、netperf），并输出结构化的测试结果矩阵。这一设计在同类项目中独树一帜。TrustOS 和 ZeroOS 也有测试套件集成，但依赖外部脚本或 Docker 环境。

### 2.9 硬件平台支持

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| **QEMU virt** | 是 | 是 | 是 | 是 | 是 | 是 |
| **VisionFive2** | 否 | 是 | 是 | 否 | 否 | 是 |
| **架构可移植性** | 低(LA64仅最小) | 低(单架构) | 低(单架构) | 中(polyhal HAL) | 中(hal目录分离) | 低(单架构) |

---

## 三、各项目总结评价

### 本项目 (OSKernel)

本项目是一个从 rCore-Tutorial-v3 演进而来的综合型竞赛内核。其最突出的特色在于**子系统覆盖面广**——在约 15,000 行内核代码中同时涵盖了进程管理、内存管理、双后端文件系统（easy-fs + EXT4 overlay）、网络协议栈、设备驱动和一套内置的自动化测试框架，是六个项目中子系统种类最丰富的。EXT4 只读解析器配合内存 overlay 层的设计具有创新性，自研 runner 测试框架在同类项目中独树一帜。然而，项目在深度方面存在明显短板：无 COW、无延迟分配、信号处理仅为 stub、调度器为基础 FIFO、mmap 仅支持匿名映射、LoongArch 支持仅为最小启动验证。整体呈现出"广度有余、深度不足"的特征。

### ChaOS

ChaOS 是一个设计思路清晰的竞赛内核。其高半核地址空间设计、TCB 统一进程/线程模型、双平台（QEMU+VisionFive2）编译时切换等架构决策体现了良好的系统设计素养。ext4_rs 自研 Rust 库的集成使其摆脱了对 C 库的依赖。但项目存在多处关键缺陷：页帧回收逻辑被注释导致内存泄漏、同步原语系统调用被注释、ext4 多项操作为 todo!()、用户态与内核态系统调用号不匹配等，整体完成度受到严重影响。适合作为架构设计的参考案例，但代码可用性不足。

### TrustOS

TrustOS 是六个项目中**子系统实现深度最均衡**的项目。105 个系统调用、COW+延迟分配内存管理、完整 ext4 读写、用户态信号帧构建（SA_SIGINFO+SA_RESTART）、Futex 完整操作、clone 完整 flags 支持——几乎每个核心子系统都达到了竞赛级实现的深度。代码质量较高，Rust 所有权模型运用得当（Arc/Weak 管理资源生命周期）。主要短板在于：单架构（仅 RISC-V）、无网络协议栈、FIFO 调度器基础、无页缓存。整体而言，TrustOS 是传统 rCore 路线上实现质量最高的作品之一，在 OSKernel2024 复赛中排名第五的成绩也验证了其竞争力。

### Nonix OS

Nonix OS 的核心特色在于**双架构支持与 polyhal 硬件抽象层**。通过 polyhal 统一了 RISC-V 和 LoongArch 的页表、中断、设备发现等底层操作，代码复用率高。mmap 共享组机制是解决 fork 后 MAP_SHARED 区域共享问题的精巧设计。动态虚拟文件注册表使 /proc 文件系统具备实时数据生成能力。不足之处在于：信号处理的 sigreturn 未实现导致用户自定义信号处理不可用、同步原语极为薄弱（仅 UPSafeCell）、管道缓冲区仅 32 字节、部分系统调用为伪实现。Nonix OS 在跨架构工程实践方面表现出色，但核心功能的完成度有待提升。

### SubsToKernel

SubsToKernel 是六个项目中**功能和深度综合最强**的项目。COW + 延迟分配 + 共享组的三层内存优化策略设计精良；银行家算法死锁避免在竞赛内核中极为罕见；完整 Futex 四种操作配合 pthread 健壮列表支持体现了对 Linux 内核机制的深入理解；动态链接器加载和完整辅助向量传递使其能够运行 musl libc 动态链接程序。双架构支持（含 LoongArch TLB 重填和 DMW 配置）展现了优秀的底层硬件适配能力。smoltcp 网络协议栈集成使网络功能达到可用水平。主要不足在于：单核限制、基础 FIFO 调度器、无 swap/内存回收、代码中存在较多调试痕迹。

### ZeroOS (KeepOnOS)

ZeroOS 是六个项目中**架构理念最先进**的项目。基于 ArceOS/Starry 的组件化设计，将内核拆分为约 50 个独立 crate，通过 `crate_interface` 和条件编译实现灵活组合，模块解耦程度远超传统 rCore 系项目。支持五种文件系统（EXT4/FAT/ramfs/devfs/procfs）通过统一 VFS 多挂载点管理；调度器支持 FIFO/RR/CFS 三种算法；异步执行器模型（async-task）为阻塞系统调用提供了更优雅的实现方式。约 61,441 行的代码规模（含全部 workspace crate）远超其他项目。不足之处在于：单架构（仅 RISC-V）、项目为单人开发、部分高级功能（如 epoll）仅定义了接口未实现、ArceOS 框架的学习曲线陡峭。

---

## 四、综合对比排名

### 4.1 按整体成熟度排名

| 排名 | 项目 | 加权评分 | 核心理由 |
|------|------|----------|----------|
| 1 | **SubsToKernel** | 82% | 内存管理三层优化+银行家算法+完整Futex+双架构+网络，深度与广度兼备 |
| 2 | **TrustOS** | 80% | 105个系统调用+完整信号帧+COW+lwext4完整ext4，传统路线的品质标杆 |
| 3 | **ZeroOS** | 78% | 组件化架构+五种文件系统+多调度算法+异步模型，架构理念先进 |
| 4 | **Nonix OS** | 73% | 双架构polyhal+mmap共享组+动态/proc，跨架构工程实践出色 |
| 5 | **本项目** | 72% | 子系统覆盖面最广+EXT4 overlay+内置runner，广度有余深度不足 |
| 6 | **ChaOS** | 68% | TCB统一模型+高半核设计+ext4_rs，设计思路清晰但完成度低 |

### 4.2 按维度能力矩阵

| 维度 | 本项目 | ChaOS | TrustOS | Nonix OS | SubsToKernel | ZeroOS |
|------|--------|-------|---------|----------|-------------|--------|
| 内存管理 | C | C | A | A- | A | A- |
| 文件系统 | B | B- | A- | B+ | A- | A |
| 进程管理 | B | B | A- | B+ | A- | B+ |
| 信号机制 | D | C | A | C+ | A | A- |
| 同步原语 | A- | D | B | D | A+ | B+ |
| 网络支持 | B- | F | F | F | B+ | B+ |
| 系统调用覆盖 | B+ | B- | A | B | A | A- |
| 架构可移植性 | C+ | C | C | A- | A- | C |
| 测试基础设施 | A | C | B+ | C | C | B |
| 代码质量 | B- | C+ | A- | B | B+ | B+ |

(注：A-优秀 B-良好 C-一般 D-不足 F-缺失)

---

## 五、评审意见

综合本项目的分析以及与 ChaOS、TrustOS、Nonix OS、SubsToKernel、ZeroOS 五个同类竞赛内核的全面对比，形成以下评审意见：

**本项目的核心优势在于工程广度与实用创新**。在六个项目中，本项目是唯一同时覆盖进程管理、内存管理、双后端文件系统、网络协议栈、设备驱动和内置自动化测试框架六个子系统的内核，这种"全栈"式的覆盖在竞赛项目中较为少见。EXT4 只读解析器配合内存 overlay 层实现伪写入的设计具有鲜明的工程实用主义色彩——在自研 EXT4 解析器功能受限的情况下，通过巧妙的软件层弥补了写入能力的缺失。内置 runner 测试框架支持九种业界标准测试套件的自动执行和结构化结果输出，在测试基础设施方面领先于所有对比项目。

**本项目的核心短板在于关键机制的实现深度不足**。与 TrustOS、SubsToKernel 和 ZeroOS 相比，本项目在以下方面存在显著差距：(1) 无写时复制（COW），fork 时完整复制地址空间，内存效率低下；(2) 无延迟分配，所有内存映射在创建时即分配物理页；(3) mmap 仅支持匿名映射，不支持文件映射；(4) 信号处理的 rt_sigaction 为 stub，无法注册用户态信号处理函数；(5) 调度器为最基础的 FIFO 协作式调度，无可抢占、无优先级；(6) LoongArch 支持仅为约 1000 行的独立最小启动代码，未与主内核集成。这些缺失使得本项目在"操作系统内核"的核心竞争力——资源管理效率——方面处于劣势。

**在技术路线选择上**，本项目与 TrustOS、SubsToKernel 同属 rCore-Tutorial 演进路线，但 TrustOS 和 SubsToKernel 在演进深度上显著领先。TrustOS 在信号处理（用户栈信号帧、SA_SIGINFO、SA_RESTART）和 clone 完整性方面建立了标杆，SubsToKernel 在内存管理（COW+延迟分配+共享组）、同步原语（银行家算法+完整 Futex）和双架构支持方面达到了竞赛级项目的最高水准。ZeroOS 则代表了另一条技术路线——基于 ArceOS 的组件化架构，以更高的工程复杂度换取了更灵活的模块组合能力和更丰富的文件系统生态。

**建议的改进方向**：(1) 优先实现 COW 和延迟分配，这是提升内存效率最关键的优化，也是 TrustOS/SubsToKernel/Nonix OS 均已实现的基础特性；(2) 完善信号处理机制，至少支持用户态信号处理函数的注册和调用；(3) 扩展 mmap 以支持文件映射，使其能够支撑更丰富的用户态应用场景；(4) 将 LoongArch 支持从独立的最小启动代码整合到统一的架构抽象层中；(5) 考虑引入更成熟的 EXT4 方案（如 lwext4 FFI 或完整实现 ext4_rs 的写入路径），替代当前的只读+overlay 方案以获得真正的 EXT4 读写能力。

总体而言，本项目在工程广度和实用创新方面具有特色，但在内核核心机制的实现深度上与同赛道的顶尖项目（TrustOS、SubsToKernel）存在明确差距。若能在上述关键机制上进行针对性补强，有潜力达到竞赛级内核的一线水平。