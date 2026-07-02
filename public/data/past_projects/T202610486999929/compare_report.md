# 对比分析报告

## 一、对比项目概览

| 属性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **团队** | 当前项目 | 华中科技大学 | 杭州电子科技大学 | 西北工业大学 | 哈尔滨工业大学 | 同济大学 |
| **语言** | Rust | Rust | Rust | Rust | Rust | Rust |
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **架构** | RV64+LA64 | RV64+LA64 | RV64+LA64 | RV64+LA64 | RV64 | x86_64+RV64+LA64 |
| **内核代码量** | ~46,254行 | ~30,000行 | ~35,000行 | ~36,000行 | ~18,684行 | ~39,447行 |
| **调度模型** | 同步(CFS-like) | 同步(FIFO) | 异步(无栈协程) | 同步 | 异步(async/await) | 异步(async/await) |
| **系统调用** | 80+ | 100+ | 未统计 | 90+ | 120+ | 100+ |

---

## 二、架构设计对比

| 维度 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **分层方式** | arch/shared/kernel 三层 | arch/kernel 两层 | HAL/driver/kernel 三层 | HAL/platform/kernel 三层 | arch/kernel 两层 | HAL/crates/kernel 三层 |
| **架构隔离度** | 高(~84%代码共享) | 中 | 高(trait抽象) | 高(hal feature切换) | 仅单架构 | 极高(三架构统一) |
| **模块化程度** | 高(清晰子系统边界) | 中 | 高(221源文件细粒度) | 高(170源文件) | 中(单crate) | 高(多crate工作区) |
| **多核支持** | SMP(最多8核) | 未明确 | SMP | SMP | SMP | SMP(x86 SMP完整) |
| **Crate结构** | 4 crate工作区 | 单crate | 多crate | 单crate+依赖 | 单crate | 多crate工作区 |

**分析**：Remilia 在双架构共享代码比例（84%）上表现突出，其 `arch/{riscv64,loongarch64,shared}` 三层设计将架构差异严格限制在约16%的代码中，上层完全架构无关。Eonix 是唯一支持三种架构的项目，且其 HAL 设计使用了 Rust trait 系统实现编译期架构选择。NoAxiom-OS 的细粒度模块拆分（221个源文件）展现了更好的模块化水平。

---

## 三、子系统实现对比

### 3.1 内存管理

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **帧分配器** | 自研bitmap | 自研(页缓存) | 栈式 | 栈式(回收链表) | Buddy | Buddy+Per-CPU缓存 |
| **内核堆** | 自研Buddy+Slab | buddy_system_allocator | buddy_system_allocator | buddy_system_allocator | buddy_system_allocator | 自研Buddy+Slab(9类) |
| **COW** | 完整实现 | 完整实现 | 完整实现 | 完整实现 | 完整实现 | 完整实现 |
| **懒分配** | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |
| **mmap** | 匿名+文件 | 匿名+文件+共享 | 匿名+文件 | 匿名+文件 | 匿名+文件+共享 | 匿名+文件+共享 |
| **共享内存** | 未独立实现 | System V(shmget) | 未明确 | 未明确 | System V(shmget) | System V(shmget) |
| **页面回收** | 无 | 无 | 无 | ZRAM+Swap | 无 | 无 |
| **OOM处理** | 无 | 无 | 无 | 多级OOM回收 | 无 | 无 |
| **ASID管理** | 无 | 无 | 无 | 无 | LRU缓存(动态检测) | 无 |
| **大页支持** | 无 | 无 | 无 | 无 | 2MB大页 | 1GB大页(x86) |

**分析**：在内存管理方面，NPUcore-BLOSSOM 最为全面，是唯一实现 ZRAM 压缩内存和磁盘交换分区（Swap）的项目，其多级 OOM 回收机制也独具特色。Remilia 的自研 Buddy+Slab 完整实现体现了对底层机制的深刻理解，且在 frame_rc（帧引用计数）和 COW 的配合上设计精细。TatlinOS 的页缓存（PageCache）机制和 GroupManager 共享页管理在性能优化上有独到之处。Eonix 的 Per-CPU 页缓存是唯一面向多核性能优化的分配器设计。MinotaurOS 的 ASID 动态管理是唯一的 TLB 优化实现。

### 3.2 调度器

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **调度模型** | 同步抢占 | 同步FIFO | 异步无栈协程 | 同步 | 异步async/await | 异步async/await |
| **调度类** | RT+Fair+Idle | 单FIFO | RT+Normal(双队列) | 未明确 | 双队列(prio+fifo) | FIFO |
| **Fair实现** | CFS-like(8优先级) | 无 | CFS(已废弃) | 无 | 无 | 无 |
| **Futex** | 完整+PI+Robust | 未明确 | 完整 | 完整 | 完整 | 完整 |
| **优先级继承** | 实现 | 未明确 | 未明确 | 未明确 | 未明确 | 未明确 |
| **负载均衡** | 基础 | 无 | 标注"最差性能" | 未明确 | 无 | 无 |

**分析**：Remilia 的调度器是三款同步内核中最复杂的——实现了 CFS-like 公平调度、RT FIFO/RR、Idle 三级调度类，以及 futex 优先级继承和 robust list，这在所有对比项目中独一无二。NoAxiom-OS 的异步调度架构最具创新性，将每个用户任务封装为 Future，但其废弃的 CFS 代码暗示了异步模型下实现公平调度的难度。MinotaurOS 的异步调度配合事件总线设计优雅，但缺少优先级调度。TatlinOS 的调度器较为简单（仅 FIFO），是一个明显短板。

### 3.3 文件系统

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **VFS抽象** | Vnode trait | 有 | Dentry+Inode | DirectoryTree | Inode+File trait | Dentry+Inode |
| **磁盘FS** | ext4(ext4_rs) | ext4(lwext4) | 5种(含ext4) | ext4+FAT32 | ext4(lwext4) | ext4+FAT32 |
| **内存FS** | ramfs+devfs+procfs | 未明确 | tmpfs+devfs+procfs | 未明确 | tmpfs+devfs+procfs | tmpfs+procfs+devfs+shm |
| **Pipe** | 环形缓冲(64KB) | 未明确 | 未明确 | 有 | 有 | 未明确 |
| **页缓存** | 无独立实现 | 无 | 无 | 块缓存 | PageCache | PageCache |
| **inotify** | 无 | 无 | 无 | 无 | 有 | 无 |
| **快照缓存** | 无 | 无 | 无 | 无 | ELF快照(LRU=4) | 无 |
| **目录缓存** | lookup缓存 | 无 | 有 | 目录树缓存 | 无 | Dentry缓存(RCU) |
| **Ext4特性** | 64bit/extents | 未明确 | 未明确 | extent树完整 | 未明确 | 未明确 |

**分析**：MinotaurOS 在文件系统方面最为全面，实现了5种文件系统类型和独有的 inotify 支持，其 ELF 快照缓存和 PageCache 设计也体现了性能优化意识。Remilia 的 VFS 设计（Vnode trait）最为完整，支持 poll/epoll 就绪检查、socket 集成等高级特性，且 ext4 适配层包含 inode 缓存和 lookup 缓存优化。NPUcore-BLOSSOM 的 ext4 实现最为深入——自研了完整的 superblock、extent 树、inode 操作等核心逻辑，其块缓存管理器设计也较为成熟。Eonix 在 Dentry 缓存中使用 RCU 无锁读取是独特的并发优化。NoAxiom-OS 支持5种文件系统类型，类型覆盖最广。

### 3.4 网络栈

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **实现方式** | 自研 | 未明确 | smoltcp | smoltcp | smoltcp(Loopback) | smoltcp |
| **Ethernet** | 自研(类型分发) | 未明确 | smoltcp内置 | smoltcp内置 | 无 | smoltcp内置 |
| **ARP** | 自研(缓存+队列) | 未明确 | smoltcp内置 | smoltcp内置 | 无 | smoltcp内置 |
| **IPv4** | 自研(校验+回环) | 未明确 | smoltcp内置 | smoltcp内置 | 无 | smoltcp内置 |
| **UDP** | 自研 | 未明确 | smoltcp内置 | smoltcp内置 | 无 | smoltcp内置 |
| **TCP** | 自研(握手+挥手) | 未明确 | smoltcp内置 | smoltcp内置 | smoltcp(Loopback) | smoltcp内置 |
| **Unix Socket** | 有(双向管道) | 未明确 | 未明确 | 部分实现 | socketpair | 未明确 |
| **网卡驱动** | VirtIO-Net | 未明确 | VirtIO-Net | VirtIO-Net | 无(Loopback) | VirtIO+E1000E |
| **epoll** | 完整 | 未明确 | 未明确 | 未明确 | 无 | 无 |

**分析**：Remilia 在网络栈方面具有最显著的差异化优势——它是唯一自研完整协议栈（Ethernet/ARP/IPv4/UDP/TCP）的项目，而非依赖 smoltcp。其实现虽然基础（TCP 缺少拥塞控制），但体现了对网络协议底层机制的理解深度。其余五个项目均依赖 smoltcp 库，其中 MinotaurOS 仅实现了 Loopback 本地回环，网络功能最弱。Eonix 的 E1000E 网卡驱动是除 VirtIO 之外唯一的额外网卡驱动支持。

### 3.5 进程管理

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **fork语义** | clone/clone3 | clone | clone(完整标志) | clone | clone | clone/fork/vfork |
| **COW fork** | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| **线程支持** | 是(共享地址空间) | 是 | 是(CLONE_THREAD) | 是 | 是 | 是 |
| **vfork** | 未明确 | 未明确 | 是(vfork等待) | 未明确 | 是 | 是 |
| **TLS** | 支持(PT_TLS) | 未明确 | 支持(CLONE_SETTLS) | 未明确 | 支持 | 未明确 |
| **动态链接** | 解析但无ld.so | 未明确 | 支持(dl_interp) | 未明确 | 支持(interpreter) | 未明确 |
| **进程组/会话** | 基础 | 未明确 | 完整(进程组) | 有(setpgid) | 有(setpgid/setsid) | 有(setpgid/setsid) |
| **资源限制** | prlimit64 | 未明确 | 未明确 | prlimit | 未明确 | 未明确 |
| **Capabilities** | capget/capset | 未明确 | 未明确 | 未明确 | 完整(PCap) | 未明确 |

**分析**：MinotaurOS 在进程管理方面最为完整，是唯一实现完整 Linux capabilities 模型的项目，且支持动态链接器加载。NoAxiom-OS 的 clone 实现最为全面，支持了几乎全部 clone 标志位，且其 Task 结构体按并发访问模式精细分类（Mutable/ThreadOnly/Immutable/SharedMut）的设计是并发安全方面的最佳实践。Remilia 的进程=资源容器、线程=调度实体的设计哲学清晰，支持 clone3 新接口，且分桶哈希表实现的进程/线程表具有较好的可扩展性。

### 3.6 信号机制

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **信号范围** | 1-31 | POSIX完整 | 1-31 | 1-31 | 1-31 | 1-31 |
| **信号掩码** | 位掩码 | 完整 | 完整 | 完整 | 完整 | 完整 |
| **信号处理** | Default/Ignore/Handler | 完整 | 完整 | 完整 | 完整 | 完整 |
| **SigFrame** | 完整 | 完整 | 未明确 | 完整 | 完整 | 完整 |
| **信号栈** | sigaltstack | 未明确 | sigaltstack | 未明确 | 未明确 | 未明确 |
| **实时信号** | rt_sig*系列 | 未明确 | 未明确 | sigtimedwait | rt_sig*系列 | rt_sig*系列 |
| **事件总线** | 无 | 无 | 无 | 无 | EventBus创新 | 无 |

**分析**：Remilia 和 MinotaurOS 在信号实现上最为完整。MinotaurOS 的事件总线（EventBus）机制是一个独特创新——将信号中断与异步等待统一到事件模型中，支持 `CHILD_EXIT`、`KILL_THREAD`、`COMMON_SIGNAL`、`VFORK_DONE` 等事件类型的异步等待。Remilia 的信号 trampoline 页设计（包含 `li a7, SYS_RT_SIGRETURN; ecall`）和哨兵字节重入检测展现了严谨的实现态度。

### 3.7 时钟与定时器

| 特性 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| **时钟架构** | 三层(CS/CE/TK) | 未明确 | 有(ktime) | 基础 | 定时器队列 | tick基础 |
| **Tick频率** | 100Hz | 未明确 | 未明确 | 未明确 | 未明确 | 未明确 |
| **One-shot模式** | 是 | 未明确 | 未明确 | 未明确 | 未明确 | 未明确 |
| **高精度定时器** | 纳秒级 | 未明确 | 未明确 | 未明确 | 纳秒级 | 未明确 |
| **timerfd** | 完整(create/set/get) | 未明确 | 未明确 | 未明确 | 无 | 无 |
| **itimer** | 完整(get/set) | 未明确 | 未明确 | 有 | 有 | 无 |

**分析**：Remilia 的时钟子系统（tokei）是六款内核中设计最为精良的——借鉴 Linux clocksource 框架的三层设计（Clocksource/Clockevent/Timekeeper），支持 one-shot 模式和纳秒级时间精度，且实现了完整的 timerfd 支持。这一子系统的成熟度显著领先于其他对比项目。

---

## 四、技术亮点对比

### Remilia
1. **双架构统一内核**：84%代码共享率，架构层通过 `arch/{riscv64,loongarch64,shared}` 三层实现高度抽象
2. **自研网络协议栈**：唯一完整自研 Ethernet/ARP/IPv4/UDP/TCP 的项目，不依赖 smoltcp
3. **CFS-like 公平调度 + 优先级继承**：三级调度类 + futex PI + robust list，调度器复杂度最高
4. **三层时钟子系统**：借鉴 Linux clocksource 框架，支持 one-shot 和 timerfd
5. **多路径启动信息解析**：DTB/ACPI/fw_cfg 三种启动路径自动检测与回退
6. **LR/SC 多核自举**：使用原子指令实现无锁多核启动竞态

### TatlinOS
1. **页缓存机制**：带水位线控制（高128/低32）的物理页分配缓存，批量补充/回收优化分配性能
2. **GroupManager**：高效管理 mmap 共享页，节省物理内存
3. **System V 共享内存**：完整实现 shmget/shmat/shmctl
4. **双架构共享页表框架**：架构差异通过统一的 PageTable trait 和架构特定实现隔离

### NoAxiom-OS
1. **无栈协程异步调度**：将用户任务封装为 Future，结合 async_task 运行时实现零成本异步抽象
2. **多级优先级调度器**：RealTime(FIFO) + Normal(双队列 current/expire) 设计，支持 nice 值
3. **细粒度并发模型**：Task 字段按 Mutable/ThreadOnly/Immutable/SharedMut 分类，并发安全性高
4. **完整 clone 语义**：支持全部 Linux clone 标志位的异步实现
5. **跨架构 HAL trait 抽象**：通过 ArchMemory trait 统一 RISC-V 和 LoongArch 页表操作

### NPUcore-BLOSSOM
1. **ZRAM 压缩内存**：LZ4 压缩算法实现内存压缩，是唯一实现此特性的项目
2. **磁盘 Swap 分区**：支持将内存页换出到磁盘交换分区
3. **多级 OOM 回收机制**：Step1 清理文件系统缓存 -> Step2 清理当前任务 -> Step3 全局清理
4. **完整 ext4 自研实现**：superblock、extent 树、inode 操作等核心逻辑均为自研
5. **目录树缓存**：DirectoryTreeNode 结构配合 BTreeMap 加速路径解析

### MinotaurOS
1. **事件总线机制**：统一信号中断与异步等待，支持多种事件类型的异步监听
2. **ELF 快照缓存**：LRU 缓存最近4个可执行文件的地址空间，加速 execve
3. **高度抽象内存区域模型**：LazyRegion/FileRegion/SharedRegion/DirectRegion 四种类型，覆盖所有场景
4. **ASID 动态管理**：唯一实现 ASID 分配和 LRU 缓存的项目，优化 TLB 刷新
5. **四种内存区域类型**：面向不同使用场景的精细化内存区域分类

### Eonix
1. **三架构支持**：唯一同时支持 x86_64、RISC-V 64、LoongArch 64 的项目
2. **有栈/无栈混合异步**：async/await + stackful 协程，兼顾表达力和灵活性
3. **RCU 无锁数据结构**：在 Dentry 缓存和进程列表中使用 RCU 优化关键路径
4. **Per-CPU 变量自定义宏**：通过过程宏实现跨架构的处理器局部变量
5. **PCIe 总线枚举 + AHCI 驱动**：最完整的硬件驱动支持，包括 x86 的 MBR 引导

---

## 五、不足与缺失对比

| 缺陷类别 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|----------|---------|----------|------------|-----------------|------------|-------|
| **TCP不完整** | 缺拥塞控制/窗口管理 | 未明确 | 依赖smoltcp | 依赖smoltcp | 仅Loopback | 依赖smoltcp |
| **单架构限制** | 无(双架构) | 无(双架构) | 无(双架构) | 无(双架构) | 仅RV64 | 无(三架构) |
| **调度器简单** | 无 | FIFO过于简单 | CFS废弃 | 未明确 | 缺优先级调度 | FIFO简单 |
| **无页面回收** | 有 | 有 | 有 | 无(有ZRAM) | 有 | 有 |
| **缺动态链接** | 有 | 未明确 | 无(支持) | 未明确 | 无(支持) | 未明确 |
| **依赖外部库** | ext4_rs | lwext4 | smoltcp+多个 | smoltcp | lwext4+smoltcp | smoltcp |
| **文件系统单一** | 仅有ext4 | 仅有ext4 | 5种 | ext4+FAT32 | ext4+tmpfs | ext4+FAT32 |
| **SMP不完善** | LoongArch辅hart桩 | 未明确 | 负载均衡差 | 未明确 | 未明确 | x86 SMP完整 |
| **无ICMP** | 有 | 未明确 | smoltcp | smoltcp | 无 | smoltcp |
| **缺epoll** | 无(完整) | 未明确 | 未明确 | 未明确 | 有 | 未明确 |

---

## 六、整体成熟度综合评分

以下评分以"能够运行 BusyBox shell 和比赛测例的完整 OS 内核"为基准（百分制），各维度权重如下：内存管理 20%、调度器 15%、文件系统 15%、系统调用 15%、进程管理 10%、网络 10%、时钟定时器 5%、架构支持 5%、设备驱动 5%。

| 维度 | Remilia | TatlinOS | NoAxiom-OS | NPUcore-BLOSSOM | MinotaurOS | Eonix |
|------|---------|----------|------------|-----------------|------------|-------|
| 内存管理(20%) | 17 | 16 | 15 | 19 | 16 | 17 |
| 调度器(15%) | 14 | 8 | 13 | 9 | 11 | 10 |
| 文件系统(15%) | 12 | 10 | 12 | 13 | 13 | 12 |
| 系统调用(15%) | 12 | 13 | 11 | 12 | 13 | 12 |
| 进程管理(10%) | 8 | 7 | 9 | 7 | 9 | 8 |
| 网络(10%) | 7 | 5 | 7 | 6 | 3 | 6 |
| 时钟(5%) | 5 | 3 | 3 | 3 | 4 | 3 |
| 架构(5%) | 4 | 4 | 4 | 4 | 2 | 5 |
| 驱动(5%) | 3 | 3 | 3 | 3 | 3 | 4 |
| **总分** | **82** | **69** | **77** | **76** | **74** | **77** |

---

## 七、各项目总结评价

### Remilia（当前项目）
Remilia 是一个在广度与深度之间取得良好平衡的 Rust 宏内核。其核心优势在于：自研网络协议栈（所有对比项目中唯一）、CFS-like 公平调度+优先级继承的复杂调度器、以及借鉴 Linux 框架的三层时钟子系统。双架构统一内核的 84% 代码共享率体现了成熟的架构设计能力。不足之处在于 TCP 实现较为基础（缺少拥塞控制）、LoongArch SMP 支持不完整、以及 ext4 依赖第三方库。在六款对比项目中，Remilia 在调度器复杂度和时钟子系统设计上具有明显优势，适合作为深入理解 OS 核心机制的参考实现。

### TatlinOS
TatlinOS 是一个功能扎实的 Linux 兼容内核，其页缓存机制和 GroupManager 共享页管理在性能优化上有独到设计。100+ 系统调用和完整的 POSIX 信号机制保障了应用兼容性。但其调度器仅支持简单的 FIFO 策略，且网络栈实现情况未明确，这在一定程度上限制了其在 IO 密集型场景下的表现。整体定位更偏向"功能完整性"而非"机制创新性"。

### NoAxiom-OS
NoAxiom-OS 是六款内核中调度模型最具创新性的项目——基于无栈协程的异步调度架构将 Rust 语言的 async 生态深度集成到内核中。其 Task 结构体按并发访问模式精细分类的设计展示了出色的系统编程素养，完整的 Linux clone 标志位支持也体现了实现深度。虽然 CFS 实现被废弃，且在比赛中已验证了优异的网络性能（网络性能第一），但负载均衡和调度公平性方面仍有提升空间。

### NPUcore-BLOSSOM
NPUcore-BLOSSOM 在内存管理方面独树一帜——是唯一实现了 ZRAM 压缩内存、磁盘 Swap 交换分区和多级 OOM 回收机制的项目。其 ext4 实现最为深入（自研 superblock/extent 树等），FAT32 支持也扩展了文件系统兼容性。这些面向资源受限场景的设计使该项目在内存压力下的鲁棒性预期最高。短板在于调度器和时钟子系统相对基础，以及网络栈完全依赖 smoltcp。

### MinotaurOS
MinotaurOS 以最小的代码量（~18,684 行）实现了 120+ 系统调用和完整的异步调度——代码密度（功能/代码量比）在所有项目中最高。事件总线机制、ELF 快照缓存、ASID 动态管理、inotify 支持等创新点在精巧的设计中展现了出色的工程品味。其主要限制在于仅支持 RISC-V 单架构和仅 Loopback 的网络支持，这限制了其通用性。适合作为异步内核设计的教学参考。

### Eonix
Eonix 是架构支持最广的项目（x86_64/RISC-V/LoongArch），且在 Rust 特性利用上最为充分——async/await、过程宏（Per-CPU 变量、syscall 注册）、RCU 无锁数据结构。其 PCIe 总线枚举、AHCI 驱动、E1000E 网卡驱动使硬件兼容性最强。FIFO 调度策略相对简单，网络栈依赖 smoltcp，使其在调度机制和网络协议自研深度上不及 Remilia 和 NoAxiom-OS。

---

## 八、综合分类评价

### 调度模型维度
- **同步调度最强**：Remilia（CFS-like + RT + futex PI，复杂度最高）
- **异步调度最强**：NoAxiom-OS（无栈协程 + 多级优先级，性能验证最优）

### 内存管理维度
- **功能最完整**：NPUcore-BLOSSOM（唯一支持 ZRAM + Swap + OOM）
- **实现最自研**：Remilia（自研 Buddy + Slab，非依赖外部 crate）

### 文件系统维度
- **类型最丰富**：NoAxiom-OS（5种文件系统）
- **实现最深入**：NPUcore-BLOSSOM（自研 ext4 extent 树等核心逻辑）
- **VFS 设计最完善**：Remilia（Vnode trait 支持 poll/epoll/socket 集成）

### 网络协议栈维度
- **唯一自研**：Remilia（完整自研五层协议栈）
- **功能最完整**：NoAxiom-OS（竞赛验证网络性能第一）

### 架构支持维度
- **支持最广**：Eonix（三架构，含 x86_64）
- **代码复用最高**：Remilia（84% 架构无关代码）

---

## 九、评审意见

Remilia OS 是一款在技术深度与工程广度之间取得出色平衡的 Rust 宏内核项目。在所选六款对比项目中，Remilia 展现了三项不可替代的独特优势：

其一，**调度器设计复杂度领先**。CFS-like 公平调度、RT FIFO/RR 实时调度、Idle 调度三级调度类，配合 futex 优先级继承和 robust list，构成了所有对比项目中最为完整的调度体系。这在以 FIFO 或简单双队列为主的同类项目中具有显著区分度。

其二，**自研网络协议栈是稀缺能力**。在其余五个项目均依赖 smoltcp 的背景下，Remilia 独立实现了 Ethernet/ARP/IPv4/UDP/TCP 五层协议栈，虽然 TCP 实现尚处于基础阶段（缺少拥塞控制与窗口管理），但这一自主性在操作系统教学中具有重要价值。

其三，**三层时钟子系统借鉴了 Linux 成熟设计**。Clocksource/Clockevent/Timekeeper 的清晰分层、one-shot 模式支持和完整的 timerfd 实现，在同类项目中处于领先水平。

同时，Remilia 存在几个明确的改进方向：TCP 协议栈的完善（拥塞控制、RTO 计算）、LoongArch 辅 hart 启动机制的补全、以及页面回收机制的引入（可借鉴 NPUcore-BLOSSOM 的 ZRAM/Swap 设计）。

综合来看，Remilia 在六款对比项目中整体成熟度位列第一梯队（82分），其同步调度+自研网络的技术路线与 NoAxiom-OS（异步调度+smoltcp）和 MinotaurOS（异步调度+Loopback）形成了清晰的差异化定位。对于追求"理解 OS 核心机制深度"而非"最大化依赖外部库"的项目目标而言，Remilia 的技术路线选择是恰当且有价值的。