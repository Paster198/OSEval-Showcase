# 对比分析报告

## 一、项目概览

本报告对以下六个 OS 内核项目进行多维对比分析:

| 编号 | 项目名 | 团队 | 基座 | 语言 | 架构 | 代码量 | 系统调用 |
|:---:|--------|------|------|------|------|-------|:-------:|
| P0 | **OSuperBeauty** | — | xv6 | C | RISC-V + LoongArch | ~59,800 行 | 93 |
| P1 | **SC7** | 武汉大学 | xv6 | C | RISC-V + LoongArch | ~56,662 行 | 144 |
| P2 | **Re-XVapor** | 吉林大学 | xv6 | C | RISC-V + LoongArch(部分) | ~51,335 行 | 81 |
| P3 | **HatOS** | 中南大学 | xv6 | C | RISC-V | ~27,627 行 | ~70 |
| P4 | **Nonix OS** | 南开大学 | rCore | Rust | RISC-V + LoongArch | ~10,979 行 | 73 |
| P5 | **BugOS** | 合肥工业大学 | xv6 | C | RISC-V | ~16,670 行 | 60+ |

> 注: P0 = OSuperBeauty 为本报告的主要参照对象。代码量统计均包含第三方库(如 lwext4)。

---

## 二、架构设计对比

| 维度 | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 内核类型 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| 分层方式 | 无明显分层 | HAL/HSAI/核心三层 | VFS/调度/内存模块化 | 模块化(无显式分层) | polyhal 硬件抽象层 | 模块化(无显式分层) |
| 架构隔离 | 条件编译+目录分离 | 条件编译+HAL目录 | 条件编译 | 仅单架构 | polyhal trait 抽象 | 条件编译 |
| 硬件抽象质量 | 中(目录分离,但有交叉依赖) | 高(正式 HAL/HSAI 层) | 中低(LA 仅部分实现) | 低(单架构无抽象需要) | 高(polyhal trait,编译期多态) | 中(条件编译,多平台入口) |
| 模块化程度 | 中 | 高 | 中高 | 中 | 高(Rust 模块系统) | 中 |

### 分析

**SC7** 在架构设计上最为规范，通过 HAL（硬件抽象层）、HSAI（硬件服务抽象层）、Kernel Core（内核核心层）三层严格分离，将架构相关代码与架构无关代码彻底解耦。这一设计使其成为六个项目中架构清晰度最高的项目。

**Nonix OS** 的 polyhal 方案利用 Rust 的 trait 系统实现了编译期多态的硬件抽象，代码量虽少但架构表达力强。其内存安全由语言层面保障，在双架构支持上与 SC7 并列最优。

**OSuperBeauty** 的架构隔离通过 `kernel/*/rv/` 与 `kernel/*/la/` 目录分离加 `#ifdef` 条件编译实现，虽功能完整但缺乏 SC7 那样的正式抽象层接口定义。

**HatOS** 与 **BugOS** 仅支持 RISC-V 单架构，无跨架构抽象需求，架构设计相对简单。**Re-XVapor** 的 LoongArch 支持仅部分实现，跨架构抽象完整性不足。

---

## 三、内存管理子系统对比

| 维度 | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 物理页分配 | 伙伴系统(17级) | 伙伴系统(0-10阶) + Slab | 空闲链表(仅页级) | 空闲链表 + Buddy(堆) | 伙伴系统(FrameAllocator) | 空闲链表(仅页级) |
| 小块内存 | 无(仅 buddy_kalloc 4KB) | Slab(8-1024字节) + 页级回退 | 无(kmalloc 实为整页) | Buddy(内核堆) | Buddy(256MB堆) | 无 |
| 页表 | Sv39 / LA四级 | Sv39 / LA四级 | Sv39 | Sv39(含位置无关映射) | Sv39 / LA(polyhal) | Sv39 |
| COW | **未实现** | 已实现 | 未实现 | 已实现(PTE_COW标志) | 已实现(Arc引用计数) | 未实现 |
| mmap | 惰性分配(文件+匿名) | 惰性分配(文件+匿名+PROT_NONE) | 按需调页(文件+匿名) | 惰性分配+Lazy Map(1X级) | 惰性分配(文件+匿名) | 文件映射+惰性(仅文件) |
| VMA 管理 | 固定数组(NVMA=16) | 双向循环链表 | 链表(线性查找) | 链表(mapregion_t) | BTreeMap(高效查找) | 段数组(NSEG=16) |
| 共享内存 | 未实现 | System V(shmget/shmctl) | 未实现 | System V(shmget/shmat/shmctl) | System V(shmget/shmat) | 未实现 |
| Swap | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| ASLR | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |

### 分析

内存管理是六个项目差异最大的子系统。**SC7** 以伙伴系统+Slab 分配器的双层架构和完整的 COW 实现位居首位，是唯一实现了完整 Slab 对象缓存的项目。**HatOS** 与 **Nonix OS** 在 COW 实现上各有特色：HatOS 通过自定义 `PTE_COW` 页表标志位实现，Nonix OS 利用 Rust 的 `Arc<FrameTracker>` 引用计数机制实现，后者在安全性上更优。HatOS 的"懒映射"(仅分配 2MB 级别的中间页表项)是一项独特的内存优化技术。

**OSuperBeauty** 的伙伴系统实现(17级树状结构)在小块内存分配上存在浪费——每秒都需要分配整页 4KB，缺乏 Slab 缓存。COW 的缺失意味着 `fork()` 时全量复制物理页，在进程创建频繁的场景下性能显著劣于实现了 COW 的 SC7、HatOS 和 Nonix OS。

**Re-XVapor** 与 **BugOS** 的物理内存管理最为简陋，仅支持 4KB 页级分配的空闲链表，`kmalloc` 实际分配整页，存在严重的内存浪费。

---

## 四、进程与线程管理对比

| 维度 | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 进程槽位 | 128 | 静态池 | **16**(硬限制) | 512 | 动态 | 动态(上限未知) |
| 线程模型 | clone(CLONE_VM等) | POSIX线程(独立TCB池) | 线程组(TCB+PCB分离) | 无线程(仅进程) | clone(进程/线程语义) | clone(24个标志位) |
| 线程数限制 | 不限(共享进程槽) | 静态线程池 | 4/进程,64全局 | N/A | 不限 | 不限(共享进程槽) |
| 调度算法 | 轮询(O(N)) | 轮询(O(N)) | FIFO队列 | FIFO队列 | FIFO | 轮询(O(N)) |
| 进程组/会话 | 部分(gid/sid字段) | 完整(pgid/sid) | 部分(pgid) | 未实现 | 未实现 | 未实现 |
| 资源限制 | 未实现(prlimit64 stub) | 完整(rlimit数组) | 完整(rlimit数组) | 部分(prlimit64) | 未实现 | 未实现 |
| 命名空间 | 未实现 | UTS命名空间 | 未实现 | 未实现 | 未实现 | 未实现 |
| 优先级调度 | 无 | 无 | 无 | 无 | 无 | 无 |
| 多核支持 | 是(最多8核) | 是(配置为单核) | 是 | 是(最多3核) | **否(仅hart 0)** | 是 |

### 分析

**SC7** 在进程与线程管理上覆盖最全面，POSIX 线程取消机制(`PTHREAD_CANCEL_ENABLE`/`DEFERRED`)、完整 rlimit 资源限制和 UTS 命名空间是其他项目不具备的功能。**Re-XVapor** 的线程组模型设计合理——线程组 ID 等于 PID、线程组包含线程链表、组领导指针等结构清晰——但全局 64 线程的硬限制严重制约了实用性。

**OSuperBeauty** 在进程/线程模型上处于中上水平：通过 `clone()` 支持线程语义，128 个进程槽位充裕，`tgid`/`tid` 字段设计合理。但调度算法的 O(N) 轮询和缺乏优先级调度是所有基于 xv6 项目的共性问题。

**HatOS** 的 512 进程槽位是所有项目中最大的，但缺乏线程支持意味着无法运行依赖 `pthread` 的多线程程序。**Nonix OS** 虽支持 clone 语义，但严格单核限制使其无法利用多核并发。

---

## 五、文件系统对比

| 维度 | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 主要 FS | ext4(lwext4) | ext4(lwext4改进) | ext4(lwext4) | ext4(lwext4) + FAT32 | ext4(lwext4_rust) | ext4(lwext4) |
| 辅助 FS | 无(FAT32仅枚举) | VFAT | procfs(基础) | FAT32(编译时切换) | /proc虚拟文件 | 无 |
| VFS 抽象 | 有(file_operations接口) | 有(完整VFS层) | 有(inode_ops/file_ops/fs_ops) | 有(Dev设备抽象) | 有(File trait) | 有(基础抽象) |
| 挂载点 | 最多4个 | 支持多挂载 | 最多4个 | 编译时固定 | 记录式(非真挂载) | 未实现 |
| 块缓存 | LRU(60缓冲,512B块) | 有(bio层) | 有 | LRU(双向链表) | 无(经lwext4内部缓存) | LRU(30缓冲) |
| 管道 | 512B环形缓冲 | 有(pipe+fifo) | 有 | 512B环形缓冲 | **32B环形缓冲(过小)** | 有 |
| 符号链接 | 支持 | 支持 | 部分 | 有(创建busybox链接) | 支持 | 未实现 |
| 硬链接 | 支持(linkat) | 支持 | 支持 | 支持(linkat) | 支持 | 未实现 |
| xattr/ACL | 未实现 | 支持xattr | 未实现 | 未实现 | 未实现 | 未实现 |

### 分析

所有六个项目均选择集成 lwext4 库实现 ext4 支持，体现了这一方案在比赛场景下的成熟度。差异主要体现在 VFS 层的设计质量和辅助文件系统支持上。

**SC7** 在文件系统方面领先：支持 VFAT 作为第二文件系统(非编译时切换,可同时挂载)、支持扩展属性(xattr)、FIFO 命名管道和 loop 设备，是唯一实现了较完整 Linux 文件系统生态的项目。

**HatOS** 是唯一实现了 FAT32 自研实现(非第三方库)的项目，其双文件系统架构(编译时切换)体现了较强底层开发能力。**Nonix OS** 的虚拟文件注册表机制是独特的设计，可动态注册 `/proc/interrupts` 等虚拟文件。

**OSuperBeauty** 的 VFS 层设计规范——`struct file_operations` 接口统一了管道、控制台、ext4 和中断信息文件——但缺乏多文件系统支持。`/proc/interrupts` 通过 `FD_INTERRUPT` 特殊文件类型实现，虽功能可用但不如 SC7 的 procfs 框架通用。

**BugOS** 的重大缺陷在于文件系统错误处理：文件打开失败时触发 lwext4 库的 C 断言(`assertion failed`)导致内核崩溃，而非向用户态返回错误码，违反了内核容错基本原则。

---

## 六、信号与同步机制对比

| 维度 | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 信号数量 | 31(SIGHUP~SIGSYS) | 64(含实时信号) | 31 | 有(数量未明确) | 32 | 64(NSIG=64) |
| 信号注册 | rt_sigaction | sigaction(SA_SIGINFO) | rt_sigaction | sigaction | sigaction | rt_sigaction |
| 信号掩码 | rt_sigprocmask | 支持 | 支持 | 支持(sigmask) | 支持 | 支持 |
| 信号跳板 | 独立SIG_TRAMPOLINE页 | 用户栈保存上下文 | trampoline桩代码 | 固定地址跳板页 | 未明确 | 用户态trampoline |
| 实时信号队列 | 未实现 | 支持 | 未实现 | 未实现(SA_SIGINFO panic) | 未实现 | 未实现 |
| Futex | 哈希表(WAIT/WAKE) | 静态数组(WAIT/WAKE/WAITV/BITSET) | 哈希表(WAIT/WAKE+超时) | **未实现** | **未实现** | **未实现** |
| Robust List | 支持 | 支持 | 未明确 | 未实现 | 未实现 | 未实现 |
| 锁机制 | spinlock+sleeplock | spinlock+sleeplock | spinlock+sleeplock+信号量+条件变量 | spinlock+sleeplock | spin::Mutex/RwLock | spinlock+sleeplock |
| 读写锁 | 未实现 | 未实现 | 未实现 | 未实现 | 有(RwLock) | 未实现 |

### 分析

**SC7** 在信号与同步机制上全面领先：支持 64 个信号(含 SIGRTMIN~SIGRTMAX 实时信号)、`SA_SIGINFO` 扩展信号信息、Futex 支持 `FUTEX_WAITV`(批量等待)和 `FUTEX_BITSET`(选择性唤醒)，在六个项目中独树一帜。静态数组设计的 Futex 在高并发下可能出现资源耗尽，但功能维度远超过其他项目。

**OSuperBeauty** 在信号机制上与 Re-XVapor 并列第二梯队：31 种标准 POSIX 信号、独立信号跳板页、注册/屏蔽/投递/返回全流程完整。Futex 的哈希表设计优于 SC7 的静态数组。但缺少实时信号队列和 `SA_SIGINFO` 支持。

**HatOS**、**Nonix OS**、**BugOS** 均未实现 Futex，这意味着无法支持依赖 `pthread` 条件变量和互斥锁的用户态多线程程序。Nonix OS 的 `sigreturn` 缺失(触发 panic)是一个致命的信号处理缺陷。HatOS 的 `wakeup` 函数因 lost wakeup bug 退化到 O(N) 全表扫描(遍历 512 进程)，存在性能隐患。

---

## 七、系统调用覆盖面对比

| 类别 | OSuperBeauty(93) | SC7(144) | Re-XVapor(81) | HatOS(~70) | Nonix OS(73) | BugOS(60+) |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 进程管理 | 17 | ~20+ | ~15 | ~12 | ~12 | ~10 |
| 文件操作 | 21 | ~25+ | ~18 | ~16 | ~15 | ~12 |
| 目录/路径 | 17 | ~20+ | ~12 | ~14 | ~10 | ~8 |
| 内存管理 | 5 | ~6 | ~5 | ~6 | ~5 | ~3 |
| 信号处理 | 8 | ~10+ | ~6 | ~5 | ~5 | ~5 |
| 时间管理 | 7 | ~8 | ~5 | ~5 | ~5 | ~4 |
| 同步 | 2 | ~3 | ~2 | 0 | 0 | 0 |
| 用户/组 | 8 | ~10+ | ~1 | ~2 | ~3 | ~2 |
| 系统信息 | 3 | ~8+ | ~3 | ~4 | ~3 | ~2 |
| 网络 | 0 | ~10+(桩) | 0 | 0(仅socket桩) | 0 | 0 |
| I/O多路复用 | 1(ppoll) | ~2 | 1(poll) | 1(ppoll) | 1(ppoll) | 0 |
| 杂项 | 3 | ~10+ | ~5 | ~3 | ~3 | ~2 |

### 分析

SC7 以 144 个系统调用位居首位，覆盖了所有类别且包含网络系统调用框架(虽为桩实现)。OSuperBeauty 以 93 个位列第二，在文件操作、目录/路径、信号、时间类别上覆盖完备。Re-XVapor 的 81 个系统调用通过脚本自动生成分发表，工程化程度高。

所有项目均未实现真正的网络协议栈。Nonix OS 和 HatOS 的 Futex 缺失使其在同步类别上明显落后。BugOS 的系统调用总数最少且部分功能不完整(如 `lseek`、`fcntl` 功能不完整)。

---

## 八、跨架构支持对比

| 维度 | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 架构数量 | 2 | 2 | 1.5 | 1 | 2 | 1 |
| RISC-V 完整度 | 高 | 高 | 高 | 高 | 高 | 高 |
| LoongArch 完整度 | 高 | 高 | 部分 | N/A | 高 | N/A |
| LA 非对齐模拟 | **有**(ALE软件模拟) | 未明确 | 未明确 | N/A | 依赖polyhal | N/A |
| LA 中断控制器 | APIC+EXTIOI | 有 | AHCI/PCI(部分) | N/A | polyhal PCI | N/A |
| LA 启动方式 | CSR直接配置 | 有 | 有 | N/A | polyhal | N/A |
| 实板支持 | VF2, 2K1000LA | 有 | 未明确 | 无 | 未明确 | K210, VF5 |
| 硬件抽象机制 | 目录分离+条件编译 | HAL/HSAI分层 | 条件编译 | N/A | polyhal trait | 条件编译 |

### 分析

**SC7** 与 **OSuperBeauty** 是双架构支持最完整的两个项目。SC7 通过 HAL/HSAI 正式分层实现架构解耦，设计规范性强于 OSuperBeauty 的条件编译方案。OSuperBeauty 的独特贡献在于 **LoongArch ALE(地址非对齐异常)软件模拟**——解码引发异常的 load/store 指令并用 `copyin`/`copyout` 模拟非对齐访问——这是对 LA2K1000 硬件限制的务实解决方案，体现了深入的底层硬件理解。

**Nonix OS** 通过 polyhal 实现了双架构支持，且利用 Rust trait 系统在编译期完成架构选择，代码量最小但抽象能力最强。**Re-XVapor** 的 LA 支持仅部分实现，不能算作真正的双架构项目。**HatOS** 与 **BugOS** 仅支持 RISC-V，但 BugOS 在单架构内实现了最广泛的硬件平台支持(QEMU+K210+VisionFive)。

---

## 九、技术亮点汇总

| 项目 | 独特技术创新 |
|------|-------------|
| **OSuperBeauty** | LoongArch ALE 非对齐访问软件模拟、伙伴系统(17级树状)、每进程控制台缓冲、中断计数器机制 |
| **SC7** | 三层架构(HAL/HSAI/Core)、伙伴系统+Slab双层分配器、COW、POSIX线程取消、64实时信号、FUTEX_WAITV、VFAT+ext4双FS、UTS命名空间、rlimit |
| **Re-XVapor** | 线程组模型(PCB/TCB分离)、系统调用脚本自动生成、动态链接ELF加载、按需调页mmap |
| **HatOS** | 位置无关内核(PIC)、懒映射(1X级页表)、编译时双文件系统(FAT32自研)、固定地址信号跳板 |
| **Nonix OS** | mmap共享组机制、polyhal trait硬件抽象、Rust内存安全、Arc引用计数COW、虚拟文件注册表 |
| **BugOS** | 最广泛硬件平台(QEMU+K210+VF5)、LRU块缓存、24个clone标志位、段式内存管理 |

---

## 十、不足与缺失汇总

| 项目 | 主要不足 |
|------|---------|
| **OSuperBeauty** | 无COW、无Slab、无Swap、无ASLR、VMA固定数组(NVMA=16)、无FAT32/procfs、无优先级调度、无命名空间、prlimit64/mremap/getrandom为stub |
| **SC7** | O(N)调度、静态池(进程/线程/Futex)、VMA线性查找、网络仅框架、路径解析潜在缓冲区溢出、命名空间仅UTS |
| **Re-XVapor** | NPROC=16硬限制、仅页级分配器、无COW、线程64全局限制、mmap地址单调递减、无ASLR、内核态缺页直接panic、部分syscall stub |
| **HatOS** | 单架构、FIFO调度、fork硬编码延时workaround、wakeup全表扫描、无Futex、无线程、SA_SIGINFO panic、编译时FS切换无法动态挂载 |
| **Nonix OS** | 单核、sigreturn未实现(panic)、管道仅32B、ioctl/setpgid等伪实现、Rust nightly工具链依赖、无Futex、用户指针验证薄弱 |
| **BugOS** | 无COW、mmap仅文件映射、文件缺失触发内核断言崩溃、无动态链接、无Futex、无线程(虽有clone标志)、部分syscall不完整、编译警告未清理 |

---

## 十一、整体成熟度综合评分

以 "比赛级 OS 内核应具备的核心能力" 为基准(满分 100)，综合功能覆盖、实现深度、代码质量、跨架构能力、创新性五个维度：

| 维度(权重) | OSuperBeauty | SC7 | Re-XVapor | HatOS | Nonix OS | BugOS |
|------------|:---:|:---:|:---:|:---:|:---:|:---:|
| 功能覆盖(25%) | 82 | **92** | 72 | 68 | 65 | 60 |
| 实现深度(25%) | 78 | **88** | 68 | 75 | 72 | 58 |
| 代码质量(20%) | 75 | 78 | 76 | 65 | **80** | 62 |
| 跨架构(15%) | **90** | 88 | 50 | 30 | 85 | 30 |
| 创新性(15%) | 72 | **80** | 68 | 75 | 78 | 55 |
| **加权总分** | **79.0** | **85.6** | 68.3 | 64.9 | 74.4 | 55.7 |

### 综合排名

| 排名 | 项目 | 加权总分 | 定性评价 |
|:---:|------|:---:|------|
| 1 | **SC7** | 85.6 | 功能最全面、架构最规范、实现深度最高的双架构项目 |
| 2 | **OSuperBeauty** | 79.0 | 功能广度好、双架构成熟、工程扎实,缺COW和Slab是主要短板 |
| 3 | **Nonix OS** | 74.4 | Rust安全性与双架构抽象出色,但单核限制和sigreturn缺陷严重 |
| 4 | **Re-XVapor** | 68.3 | 线程组和动态链接设计好,但资源硬限制和简陋分配器制约实用性 |
| 5 | **HatOS** | 64.9 | COW和双FS有亮点,PIC内核创新,但单架构且并发缺陷影响可靠性 |
| 6 | **BugOS** | 55.7 | 多硬件平台和LRU缓存是亮点,但致命错误处理和关键特性缺失 |

---

## 十二、各项目总结评价

### SC7 (武汉大学-智核速启队)

SC7 是本组六个项目中综合实力最强的内核。其在架构设计(HAL/HSAI/核心三层)、内存管理(伙伴系统+Slab+COW)、进程模型(POSIX 线程取消+rlimit+UTS 命名空间)、文件系统(ext4+VFAT 双 FS+procfs+xattr)、信号机制(64 信号+实时信号+FUTEX_WAITV)五个维度均处于领先地位。144 个系统调用远超其他项目。不足之处在于静态池设计限制了可扩展性、O(N) 调度与线性 VMA 查找在高负载下效率偏低、网络协议栈缺失。总体而言，SC7 是功能最完备、工程最规范的比赛级宏内核作品。

### OSuperBeauty

OSuperBeauty 在双架构支持、系统调用覆盖(93个)、伙伴系统物理分配器、惰性 mmap 和信号/Futex 实现上表现出色。LoongArch ALE 非对齐访问软件模拟是独特的底层技术亮点，展现了扎实的硬件理解。然而，COW 和 Slab 的缺失使其在内存管理深度上与 SC7 存在显著差距，VMA 固定数组(NVMA=16)限制了地址空间的灵活性。在六个项目中，OSuperBeauty 是唯一与 SC7 在双架构完整度上并列的项目，功能广度排名第二。

### Nonix OS (南开大学-如有名字队)

Nonix OS 是唯一采用 Rust 语言的项目，其 polyhal trait 硬件抽象和 Arc 引用计数 COW 体现了语言层面的安全性优势。mmap 共享组机制是独特创新，有效解决了 fork 后共享内存区域的物理帧管理问题。代码量最小(~11K 行)但功能覆盖不低，工程效率高。然而，严格单核限制、sigreturn 缺失(panic)、32 字节管道和多个伪实现系统调用严重影响了实用性。Rust nightly 工具链依赖也增加了构建门槛。

### Re-XVapor (吉林大学-reXvapor)

Re-XVapor 在线程组模型(PCB/TCB 分离)和 ELF 动态链接支持上表现出色，系统调用脚本自动生成体现了工程化水平。VFS 抽象层设计标准化。但 16 进程硬限制、64 线程全局限制、仅页级物理分配器(无小块内存支持)和 COW 缺失使其在并发能力和内存效率上严重受限。LoongArch 仅部分实现，不能算作真正的双架构内核。

### HatOS (中南大学-icy_hat)

HatOS 的特色在于位置无关内核(PIC)设计、独特的懒映射(1X 级页表)优化和 COW 实现(PTE_COW 标志)。编译时双文件系统(ext4+FAT32)切换和自研 FAT32 实现体现了较强的底层开发能力。但单架构(RISC-V only)、fork 中的硬编码延时 workaround(暴露并发缺陷)、wakeup 全表扫描和 Futex 缺失是其明显短板。以约 9,600 行自写代码实现了较高功能密度，但并发可靠性问题需要修复。

### BugOS (合肥工业大学-比赛时在干什么有没有空帮我修个bug)

BugOS 在多硬件平台支持(QEMU+K210+VisionFive)和 LRU 块缓存实现上表现扎实，24 个 clone 标志位定义完整。但物理内存管理(空闲链表)、无 COW、无动态链接、无 Futex 使其在核心特性上明显落后。最致命的问题是文件打开失败触发内核断言崩溃，这违反了操作系统内核隔离与容错的基本原则。代码中存在的隐式声明和指针类型不兼容警告也反映出工程严谨性不足。

---

## 十三、评审意见

综合本报告对六个 OS 内核项目的多维对比分析，可以得出以下总体判断:

**第一梯队(综合优秀)**: SC7 与 OSuperBeauty 是本次对比中仅有的两个真正实现了 RISC-V 与 LoongArch 双架构完整支持的项目，且在系统调用覆盖(分别为 144 和 93)、内存管理(均采用伙伴系统)、文件系统(均集成 lwext4)方面达到了比赛级内核的高标准。SC7 在功能深度和架构设计规范上全面领先;OSuperBeauty 虽然在 COW、Slab、多文件系统等高级特性上落后于 SC7，但其 LoongArch ALE 非对齐访问模拟、每进程控制台缓冲等独特实现表明开发团队具备扎实的底层硬件理解能力和务实的工程判断力。两者均具备运行 busybox 和 libc 测试套件的实际能力。

**第二梯队(有突出亮点但有明显短板)**: Nonix OS 以 Rust 语言和 polyhal 硬件抽象在安全性和架构表达力上独树一帜，但单核限制和 sigreturn 致命缺陷使其无法进入第一梯队。Re-XVapor 的线程组模型和动态链接支持设计优雅，但进程/线程硬限制和简陋内存分配器严重制约实用性。HatOS 的位置无关内核和自研 FAT32 体现了创新能力，但单架构限制和并发缺陷需要解决。

**第三梯队(基础扎实但关键特性缺失)**: BugOS 在多硬件平台和 LRU 缓存方面表现稳健，但无 COW、无 Futex、无动态链接以及文件系统致命错误处理使其整体成熟度明显偏低。

**共性趋势**: 六个项目均选择集成 lwext4 作为 ext4 文件系统方案，反映出这一技术路线在比赛场景下的成熟度和共识。同时，所有项目均未实现网络协议栈、Swap 页面交换和 ASLR，表明这些是当前比赛级内核普遍的功能边界。调度算法(均为简单的 FIFO 或轮询)也是共性短板。