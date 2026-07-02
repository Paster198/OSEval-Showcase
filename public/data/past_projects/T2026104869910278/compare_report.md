# 对比分析报告

## 一、项目基本信息汇总

| 维度 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| **所属学校** | -- | 华中科技大学 | 南开大学 | 中山大学 | 武汉大学 | 燕山大学 |
| **生态基座** | rCore-Tutorial v3 ch8 | rCore-Tutorial ch6 | rCore + polyhal | rCore-Tutorial | MIT XV6 | ArceOS |
| **编程语言** | Rust | Rust | Rust | Rust | C | Rust |
| **内核类型** | 单核宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | Unikernel式宏内核 |
| **支持架构** | RISC-V 64 + LoongArch 64 | RISC-V 64 | RISC-V 64 + LoongArch 64 | RISC-V 64 + LoongArch 64(部分) | RISC-V 64 + LoongArch 64 | RISC-V 64 + LoongArch 64 + AArch64 + x86_64 |
| **内核代码规模** | ~26,000行 | ~14,625行 | ~10,979行 | ~18,000行 | ~30,000行(内核) | ~5,750行(自有) |
| **总代码规模** | ~38,300行 | ~14,625行 | ~14,000行(含lwext4) | ~49,442行(含7个crate) | ~56,662行 | ~5,750行(不含ArceOS) |
| **系统调用数** | **233** | 105 | 73 | ~75 | 144 | ~99 |
| **ext4方案** | lwext4 FFI | lwext4 FFI | lwext4 FFI | **自研 (6,976行)** | lwext4 FFI | 依赖ArceOS axfs |
| **网络支持** | loopback模拟 | 部分socket API | 无 | 轻量协议栈(728行) | 基础socket | 依赖ArceOS axnet |
| **信号支持** | 64种+嵌套 | 完整信号帧 | 32种 | 基础 | POSIX完整 | 完整 |

---

## 二、架构设计对比

### 2.1 内核类型与分层方式

| 项目 | 分层策略 | 模块化程度 | 评价 |
|------|---------|-----------|------|
| **OSOSOS** | 单层monolithic，`#[cfg]`条件编译区分架构 | 中高。子系统按目录分离（task/mm/fs/syscall/trap/sync/drivers），模块边界清晰，但架构差异通过内联条件编译处理而非独立HAL trait | 模块化好但缺少形式化HAL层 |
| **TrustOS** | 单层monolithic，无显式HAL | 中。按功能目录分离，架构代码混入各模块 | 仅支持单架构，无抽象需求 |
| **Nonix OS** | 基于polyhal的三层：内核核心层 / polyhal HAL / 驱动层 | 高。通过polyhal trait实现架构解耦，驱动层独立于内核 | 形式化HAL层设计最佳，双架构代码完全分离 |
| **Explosion OS** | trait-based HAL + `cfg_if`条件编译 | 高。独立crate分离（ext4_rs、lose-net-stack、virtio-drivers、plic、fdt），HAL通过PageTable trait等抽象 | crate级别模块化出色，但HAL trait覆盖不全 |
| **SC7** | **HAL / HSAI / Kernel Core 三层架构** | 最高。硬件抽象层(HAL) + 硬件服务抽象层(HSAI) + 内核核心层的严格分层，每层有明确接口 | 经典的分层架构设计，三层分离最为严格规范 |
| **starry-next** | starry-core / starry-api / ArceOS基座 三层 | 高。利用ArceOS组件化框架，通过AxNamespace实现资源隔离，api层与core层分离 | 组件化设计，但深度依赖ArceOS框架，独立性较低 |

**分析**：SC7的三层架构（HAL/HSAI/Kernel Core）在形式上最为严谨；Nonix OS通过polyhal trait实现了最干净的架构解耦；OSOSOS虽然模块化良好但缺少形式化HAL层，架构代码混入各模块；starry-next依赖外部框架，自身架构层次受限于ArceOS。

### 2.2 多架构支持策略

| 项目 | 架构数 | 实现策略 | 代码复用率 |
|------|--------|---------|-----------|
| **OSOSOS** | 2 | `#[cfg(target_arch = "riscv64")]` + `#[cfg(target_arch = "loongarch64")]` 内联条件编译 | 高（上层完全复用） |
| **TrustOS** | 1 | 无抽象需求 | N/A |
| **Nonix OS** | 2 | polyhal trait抽象，架构代码在独立文件中 | 最高（HAL接口统一） |
| **Explosion OS** | 2(部分) | trait + `cfg_if!` 宏，LoongArch未完成 | 中（trait设计好但实现不完整） |
| **SC7** | 2 | HAL/HSAI两层分离，架构代码在独立目录 | 高（HAL接口清晰） |
| **starry-next** | **4** | 完全依赖ArceOS的axhal模块 | 最高（平台代码由框架承担） |

**分析**：starry-next以最少自有代码支持最多架构（4种），但这高度依赖ArceOS框架；Nonix OS的polyhal方案在自主实现的前提下实现了最干净的双架构分离；OSOSOS的条件编译方案工程上可行但不如trait抽象优雅，且不具备扩展到第三架构的便利性。

---

## 三、子系统实现深度对比

### 3.1 进程管理子系统

| 特性 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| 进程/线程模型 | 1:N线程 | 1:N线程 | 1:N线程 | 1:N线程 | 1:N线程 | 1:N线程 |
| clone flags | 完整 | 完整 | 完整 | 部分 | 完整 | 完整 |
| 调度器 | 混合优先级(实时+stride) | FIFO | FIFO | 基础 | 轮询 | 依赖axtask |
| 凭证系统 | **UID/GID四件套+14种capability+securebits** | 基础UID/GID | 无 | 无 | UID/GID+umask | 无 |
| 进程组/会话 | 完整(pgid/sid) | 无 | setpgid/getpgid | 无 | 完整(pgid/sid/uts_ns) | setpgid/getpgid |
| 资源限制 | rlimit(16种) | 无 | prlimit | rlimit | rlimit(完整) | rlimit |
| 内核线程 | 不支持 | 不支持 | 不支持 | 不支持 | **支持** | 不支持 |

**分析**：OSOSOS在凭证系统方面具有显著优势，实现了14种Linux capability和完整的UID/GID体系，是六个项目中唯一实现如此深度凭证管理的。SC7在进程组/会话管理和内核线程方面最完善。starry-next和Nonix OS的进程管理相对基础。

### 3.2 内存管理子系统

| 特性 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| 页表格式 | Sv39 + LA64 | Sv39 | Sv39 + LA64(polyhal) | Sv39 | Sv39 + LA64 | 依赖axmm |
| 物理帧分配器 | 栈式+bitmap | 栈式 | buddy system | 栈式 | **伙伴系统+Slab** | 依赖axalloc |
| COW | 完整 | 完整 | 完整(含共享组) | 实现但默认不使用 | 完整 | 未实现(完整复制) |
| 惰性分配 | 完整 | 完整 | 完整(push_lazily) | 完整 | 完整 | Demand Paging |
| mmap | 匿名+共享 | 匿名+文件+共享 | 匿名+文件+**共享组** | 匿名+文件 | 匿名+文件+共享 | 匿名+文件+大页 |
| 共享内存 | System V SHM | System V SHM | System V SHM | 无 | System V SHM | System V SHM |
| 页缓存 | **已移除** | 无 | 无 | PageCache(未完成) | 有 | 依赖axfs |

**分析**：SC7的物理内存管理最为成熟（伙伴系统+Slab分配器），这在六个项目中是独有的双层分配器设计。Nonix OS的mmap共享组机制是其独特创新——fork后通过GroupManager管理共享mmap区域，解决了fork后多进程mmap共享的一致性问题。OSOSOS的COW和惰性分配实现完整，LoongArch端利用DMW窗口是良好实践，但页缓存被移除是明显的性能缺陷。starry-next的COW未实现（使用完整复制`try_clone()`），TrustOS和Explosion OS的COW实现完整但不具备Nonix的共享组特性。

### 3.3 文件系统子系统

| 特性 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| ext4方案 | lwext4 FFI | lwext4 FFI | lwext4 FFI | **自研ext4_rs(6,976行)** | lwext4 FFI | 依赖axfs |
| VFS抽象 | 基础File trait | File trait | File trait + FileClass | File trait | 完整VFS层 | FileLike trait |
| 管道 | 环形缓冲区(4KB) | 环形缓冲区 | 环形缓冲区(32B) | 环形缓冲区 | 完整 | 环形缓冲区(256B) |
| procfs | 动态生成(多文件) | 无 | 虚拟文件注册表 | /proc | 完整 | /proc/self/exe |
| 其它文件类型 | **mqueue/eventfd/fanotify/memfile/pidfile** | 无 | 无 | 无 | 无 | 无 |
| inode缓存 | 无 | 无 | HashMap缓存 | 无 | 有 | 依赖axfs |
| 符号链接 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |

**分析**：Explosion OS的自研ext4_rs（6,976行纯Rust实现，支持extent树和完整块分配）在技术难度和原创性上远超其它项目（均使用lwext4 C库FFI封装）。OSOSOS在特殊文件类型方面最丰富（mqueue、eventfd、fanotify、memfile、pidfile均实现），文件系统功能广度领先。SC7的VFS层设计最完整。Nonix OS的管道缓冲区仅32字节，是明显的性能瓶颈。starry-next文件系统几乎完全依赖ArceOS框架。

### 3.4 网络子系统

| 项目 | 网络实现 | 深度评价 |
|------|---------|---------|
| **OSOSOS** | loopback TCP/UDP/RAW（内核内VecDeque模拟） | 纯内存模拟，无真实协议栈；TCP状态机完整(bind→listen→accept→connect)，UDP端口注册表，RAW协议匹配。功能广度好但本质是IPC而非网络 |
| **TrustOS** | 基础socket API | 系统调用层面封装，网络子系统不完整 |
| **Nonix OS** | 无 | 完全未实现网络相关系统调用 |
| **Explosion OS** | **lose-net-stack (728行自研)** | 轻量级网络协议栈，是唯一尝试真实网络协议栈的项目，但规模较小 |
| **SC7** | 基础socket | 系统调用层面部分实现 |
| **starry-next** | 依赖ArceOS axnet | 封装TcpSocket/UdpSocket，实际上网能力取决于ArceOS的smoltcp集成 |

**分析**：所有六个项目的网络支持都处于初级阶段。Explosion OS是唯一尝试自研网络协议栈的（lose-net-stack），OSOSOS的loopback实现在功能覆盖上最完整（TCP/UDP/RAW三种套接字类型），但本质是进程间通信而非真实网络。starry-next依赖ArceOS的smoltcp集成，理论上有真实网络能力但受限于框架成熟度。

### 3.5 信号机制

| 特性 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| 信号数量 | **64 (含实时信号)** | 32 | 32 | 部分 | 64 (SIGRTMAX) | 64 |
| sigaction | 完整 | 完整 | 完整 | 基础 | 完整 | 完整 |
| 信号嵌套 | **支持(栈式saved_trap_cx_addrs)** | 支持 | 不支持 | 不支持 | 支持 | 不支持 |
| 用户栈信号帧 | 完整(UContext) | 完整 | 基础 | 基础 | 完整 | **独立页表信号跳板** |
| sigtimedwait | 存根 | 支持 | 支持 | 不支持 | 支持 | 不支持 |

**分析**：OSOSOS和SC7的信号机制最为完整，均支持64种信号和嵌套递送。starry-next的独立页表信号跳板（避免内核空间拷贝）是其独特的技术亮点。OSOSOS的嵌套信号通过`Vec<usize>`栈式管理多个TrapContext，支持信号处理函数中再次触发信号，设计健壮。Nonix OS和Explosion OS的信号支持相对基础。

### 3.6 同步原语

| 特性 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| futex | 完整 | 完整 | 无 | 无 | **完整(含robust)** | 完整 |
| 阻塞锁 | MutexBlocking(等待队列) | 有 | 无 | 有 | 有 | 依赖axsync |
| 自旋锁 | MutexSpin | 有 | 无 | 有 | 有 | 依赖axsync |
| 信号量 | Semaphore | 无 | 无 | 无 | 无 | 无 |
| 条件变量 | Condvar | 无 | 无 | 无 | 无 | 无 |
| 死锁检测 | **银行家算法** | 无 | 无 | 无 | 无 | 无 |
| robust_list | 支持 | 支持 | 支持 | 无 | 支持 | 无 |

**分析**：OSOSOS的同步原语子系统在六个项目中最为全面——是唯一同时实现信号量、条件变量和死锁检测（银行家算法）的项目。SC7的futex实现包含robust futex和完整的超时处理。starry-next、Nonix OS和Explosion OS的同步原语较为基础（主要依赖futex）。

### 3.7 定时器管理

| 特性 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| POSIX定时器 | timer_create/settime/gettime/delete | 无 | 无 | 无 | 无 | 无 |
| 间隔定时器 | itimer(3种) | setitimer | 无 | 无 | 有 | 无 |
| timerfd | 完整 | 无 | 无 | 无 | 无 | 无 |
| nanosleep | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |

**分析**：OSOSOS的定时器子系统功能最全面，是唯一实现POSIX定时器(timer_create系列)和timerfd的项目。其它项目主要停留在基本的nanosleep/clock_gettime层面。

---

## 四、系统调用覆盖对比

| 类别 | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------|--------|---------|----------|-------------|-----|-------------|
| 进程管理 | ~25 | 18 | ~15 | ~10 | ~30 | ~12 |
| 文件系统 | ~55 | 42 | ~30 | ~28 | ~45 | ~35 |
| 信号 | ~8 | 8 | ~6 | ~3 | ~10 | ~6 |
| 网络/套接字 | ~15 | 13 | 0 | ~5 | ~8 | ~5 |
| 同步/IPC | ~19 | 4 | ~3 | ~2 | ~10 | ~8 |
| 定时器 | ~15 | 7 | ~3 | ~3 | ~5 | ~5 |
| 内存管理 | ~5 | 8 | ~7 | ~5 | ~8 | ~5 |
| 凭证/权限 | ~8 | 0 | ~2 | 0 | ~5 | 0 |
| 其它 | ~83 | 5 | ~7 | ~19 | ~23 | ~23 |
| **总计** | **233** | **105** | **73** | **~75** | **144** | **~99** |

**分析**：OSOSOS的233个系统调用在数量上遥遥领先，几乎是第二名SC7(144个)的1.6倍。但需注意OSOSOS中约43个为存根实现（返回-ENOSYS或0），实际完整实现的系统调用约140个，与SC7的144个实际水平相当。OSOSOS的系统调用优势主要体现在文件系统和定时器领域的深度覆盖。

---

## 五、技术亮点独特性对比

| 项目 | 独有技术亮点 | 创新程度 |
|------|-------------|---------|
| **OSOSOS** | (1)双ISA同构抽象(LoongArch DMW+Sv39统一) (2)完整Linux capability凭证系统 (3)银行家算法死锁检测 (4)64信号嵌套递送 (5)POSIX定时器+timerfd (6)多种特殊文件类型(mqueue/eventfd/fanotify) | 中高（工程深度突出） |
| **TrustOS** | (1)VisionFive2真实板级适配 (2)用户栈信号帧+系统调用重启 (3)辅助向量动态链接支持 | 中（工程实践扎实） |
| **Nonix OS** | (1)polyhal形式化多架构HAL (2)mmap共享组机制解决fork后共享问题 (3)懒加载push_lazily设计 | 中高（架构设计创新） |
| **Explosion OS** | (1)从零自研EXT4(ext4_rs, 6,976行) (2)自研轻量网络协议栈(lose-net-stack) (3)延迟浮点上下文保存 | 高（原创性强） |
| **SC7** | (1)伙伴系统+Slab双层分配器 (2)HAL/HSAI/Kernel三层严格分层 (3)UTS命名空间隔离 (4)POSIX线程取消机制 (5)144个系统调用 | 中高（工程成熟度最高） |
| **starry-next** | (1)四架构支持 (2)ArceOS组件化框架复用 (3)AxNamespace资源隔离 (4)独立页表信号跳板 (5)约5750行极简代码实现99个syscall | 高（架构理念独特） |

---

## 六、不足与缺失对比

| 项目 | 主要缺陷 |
|------|---------|
| **OSOSOS** | (1)页缓存已移除，文件I/O性能受限 (2)网络仅为loopback模拟，无真实TCP/IP (3)单核设计无多核支持 (4)物理帧分配器为栈式，无buddy/slab (5)约43个存根syscall，部分仅返回0可能误导用户程序 (6)无内核线程 |
| **TrustOS** | (1)仅支持riscv64单架构 (2)无网络协议栈 (3)代码规模较小(14,625行) (4)无凭证系统 (5)无进程组/会话管理 (6)物理帧分配器为基础栈式 |
| **Nonix OS** | (1)系统调用仅73个，功能覆盖面窄 (2)无网络子系统 (3)管道缓冲区仅32字节 (4)无futex同步机制 (5)信号仅32种 (6)无凭证系统 (7)调度器仅为FIFO |
| **Explosion OS** | (1)LoongArch支持不完整 (2)COW实现但默认不使用(fork使用完整复制) (3)ext4_rs存在已知bug (4)网络协议栈仅728行，功能有限 (5)信号实现基础 (6)无凭证系统 (7)无System V共享内存 |
| **SC7** | (1)基于XV6，整体架构创新性有限 (2)C语言内存安全隐患 (3)无死锁检测 (4)无POSIX定时器 (5)无eventfd/fanotify/mqueue等特殊文件类型 (6)静态进程/线程池限制并发数 |
| **starry-next** | (1)深度依赖ArceOS框架，独立性和可控性低 (2)自有代码仅5750行，核心能力受限于框架 (3)COW未实现 (4)ext4能力受限于axfs (5)无凭证系统 (6)Unikernel部署方式限制灵活性 (7)无独立进程模型，测试以嵌入二进制方式运行 |

---

## 七、整体成熟度综合评分

以Linux内核对应子系统为100%基准，以下评分为在各项目中相对比较的综合估算：

| 维度（权重） | OSOSOS | TrustOS | Nonix OS | Explosion OS | SC7 | starry-next |
|------------|--------|---------|----------|-------------|-----|-------------|
| 进程管理(20%) | **85** | 60 | 55 | 50 | **82** | 55 |
| 内存管理(20%) | 65 | 60 | **70** | 60 | **75** | 50 |
| 文件系统(20%) | 70 | 55 | 55 | **75** | 68 | 45 |
| 系统调用覆盖(15%) | **80** | 50 | 40 | 40 | 65 | 45 |
| 网络支持(10%) | 30 | 15 | 0 | 25 | 15 | 20 |
| 同步/IPC(10%) | **75** | 40 | 25 | 30 | 60 | 45 |
| 架构可移植性(5%) | 60 | 20 | **75** | 40 | 65 | **85** |
| **加权综合** | **70.5** | **48.5** | **48.75** | **51.75** | **67.75** | **47.0** |

---

## 八、各项目总结评价

### OSOSOS

OSOSOS在六个项目中以**功能广度**和**系统调用覆盖深度**脱颖而出。233个系统调用（实际完整实现约140个）在所有项目中遥遥领先。其在进程凭证系统（14种capability）、信号嵌套递送、POSIX定时器/timerfd、多种特殊文件类型（mqueue/eventfd/fanotify）、死锁检测银行家算法等方面的实现深度是其它项目所不具备的。双ISA同构抽象（RISC-V Sv39 + LoongArch LA64）展现了扎实的底层工程能力。主要弱点在于页缓存被移除导致的文件I/O性能隐患、网络仅为loopback模拟、以及缺少形式化HAL层。简而言之，OSOSOS追求的是"Linux ABI最大兼容"路线，在系统调用数量和子系统丰富度上做到了极致。

### TrustOS

TrustOS是一个工程实践扎实的项目，在rCore-Tutorial基础上进行了高质量的扩展。105个系统调用、完整的信号帧机制、辅助向量动态链接支持和VisionFive2真实板级适配是其亮点。但仅支持RISC-V单架构限制了其可移植性评价，且代码规模（14,625行）和功能广度在六个项目中处于中等偏下水平。缺少网络协议栈、凭证系统和进程组管理是主要的功能缺口。

### Nonix OS

Nonix OS的最大价值在于其**架构设计理念**。polyhal硬件抽象层通过trait实现了干净的双架构分离，mmap共享组（GroupManager）机制是解决fork后mmap共享问题的独特创新。约10,979行的内核代码在六个项目中最少，但其架构的可扩展性最好。主要不足在于系统调用仅73个、无网络子系统、无futex、管道缓冲区仅32字节、信号仅32种等在功能覆盖上的明显短板。Nonix OS是一个"重设计轻功能"的项目。

### Explosion OS

Explosion OS的**原创性在六个项目中最高**。从零自研ext4_rs（6,976行Rust，支持extent树和完整块分配）和lose-net-stack（728行自研网络协议栈）展现了不依赖第三方C库的独立技术路线，这在OS竞赛项目中极为罕见。trait-based HAL设计也体现了良好的架构意识。但该项目最大的问题在于**完成度和稳定性**——LoongArch支持不完整、COW实现但默认不使用(fork走完整复制)、ext4_rs存在已知bug、网络协议栈仅728行功能有限。Explosion OS是一个"重原创轻完成度"的项目，技术雄心和实际落地的差距较大。

### SC7

SC7是六个项目中**工程成熟度最高**的项目。基于XV6的C语言实现，56,662行的总代码量、144个系统调用、伙伴系统+Slab双层分配器、HAL/HSAI/Kernel三层严格分层架构、UTS命名空间隔离、POSIX线程取消机制等，使其在各方面都表现出极高的工程完成度。与其它Rust项目相比，SC7得益于XV6的成熟设计基础和C语言生态的丰富工具链支持。其主要局限在于基于XV6（创新性评价受限）、C语言的内存安全隐患、以及静态资源池限制并发能力。SC7是一个"重工程完成度"的项目，在子系统完整性和实现深度上最为均衡。

### starry-next

starry-next以**最小的自有代码量（约5,750行）实现了最多的架构支持（4种）和约99个系统调用**，充分体现了ArceOS组件化框架的复用优势。AxNamespace资源隔离机制和独立页表信号跳板是精致的设计。但这种对框架的深度依赖也是一把双刃剑——内核的核心能力（文件系统、网络、内存分配器、调度器、驱动框架）完全受限于ArceOS的成熟度，项目的独立性和可控性较低。Unikernel的部署方式（用户程序通过`.incbin`嵌入内核镜像）也限制了作为通用操作系统的灵活性。starry-next是一个"重框架复用轻独立实现"的项目，适合展示组件化OS构建理念，但在独立系统构建能力评价上存在先天不足。

---

## 九、综合排名与分类评价

### 综合排名

| 排名 | 项目 | 核心优势 | 综合评分 |
|------|------|---------|---------|
| **1** | **OSOSOS** | 系统调用最多(233)、子系统功能最丰富、Linux ABI兼容最深 | 70.5 |
| **2** | **SC7** | 工程成熟度最高、内存管理最完善(伙伴+Slab)、分层架构最规范 | 67.75 |
| **3** | Explosion OS | 原创性最高(自研ext4+网络栈)、模块化设计优秀 | 51.75 |
| **4** | Nonix OS | 架构设计最优雅(polyhal HAL)、mmap共享组创新 | 48.75 |
| **5** | TrustOS | 工程实践扎实、板级适配( VisionFive2 ) | 48.5 |
| **6** | starry-next | 架构支持最多(4种)、代码效率最高(5,750行/99 syscall) | 47.0 |

### 分类评价

按项目的核心特质，可将六个项目分为三类：

**第一类：全面均衡型（OSOSOS、SC7）**
这两个项目追求功能的广度和深度，在系统调用数量、子系统完整性和工程成熟度方面显著领先于其它项目。OSOSOS偏重Linux ABI兼容的极致追求（233个syscall），SC7偏重经典UNIX设计的工程化实现（伙伴+Slab+VFS+命名空间）。两者代表了两种不同生态路径的最高完成水平。

**第二类：架构创新型（Nonix OS、starry-next）**
这两个项目的价值主要体现在架构设计理念而非功能数量。Nonix OS的polyhal trait抽象是双架构HAL的最佳实践，mmap共享组机制解决了fork后共享一致性的真实工程问题。starry-next的组件化复用路线证明了极低代码量实现多架构兼容的可行性。两者适合作为架构设计参考。

**第三类：原创探索型（TrustOS、Explosion OS）**
TrustOS在rCore基础上的高质量扩展（板级适配、信号帧、动态链接）是扎实的工程实践。Explosion OS的自研ext4和网络协议栈代表了"不依赖C库"的独立技术路线，虽然完成度不足，但技术探索的精神值得肯定。

---

## 十、评审意见

OSOSOS项目在六个对比项目中综合评分最高（70.5分），其在系统调用覆盖（233个）和子系统丰富度方面具有明显优势。该项目在进程凭证系统（14种Linux capability）、信号嵌套递送、POSIX定时器/timerfd、死锁检测银行家算法、多种特殊文件类型等方面实现了其它项目未覆盖的深度功能，展现了开发团队对Linux内核机制的深入理解和扎实的系统编程能力。双ISA同构抽象（RISC-V Sv39 + LoongArch LA64）的工程实现也体现了良好的底层架构能力。

然而，该项目存在若干值得关注的问题：（1）页缓存被移除（代码明确注释"page cache removed"），文件I/O每次直接调用lwext4 C库，这将严重影响文件系统性能，与其丰富的文件系统功能形成反差；（2）网络子系统仅为内核内loopback模拟（VecDeque缓冲区），并非真实TCP/IP协议栈，这限制了其作为通用操作系统的网络能力；（3）物理帧分配器为基本栈式设计，缺少buddy/slab等成熟分配策略，可能制约内存管理性能；（4）约43个系统调用为存根实现（返回-ENOSYS或0），其中部分返回0的实现可能误导依赖这些系统调用的用户程序；（5）缺少形式化HAL层（使用内联条件编译而非trait抽象），影响了架构可扩展性。

与SC7相比，OSOSOS在功能广度上占优但在内存管理成熟度（无伙伴系统+Slab）和分层架构规范性上存在差距。与Nonix OS相比，OSOSOS功能丰富得多但架构抽象不如其polyhal方案优雅。与Explosion OS相比，OSOSOS完成度和功能覆盖面远超但原创性不及（依赖lwext4 C库而非自研ext4）。

总体而言，OSOSOS是一个以"Linux ABI最大化兼容"为核心目标的雄心勃勃的项目，在系统调用数量和功能丰富度上做到了六个项目中的第一。若能在页缓存恢复、真实网络协议栈集成和多核支持等关键短板上取得突破，将具有更强的综合竞争力。