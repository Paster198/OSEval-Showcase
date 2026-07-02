# 对比分析报告

本报告以 **Kairix OS (Unicus)** 为基准项目，从架构设计、子系统实现、技术亮点、不足与缺失、整体成熟度五个维度，对五个竞赛同类项目（Nonix OS、MonkeyOS、NPUcore-BLOSSOM、Explosion OS、TatlinOS）进行横向对比。

---

## 一、项目概览

| 维度 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **团队** | (基准项目) | 南开大学 | 天津大学 | 西北工业大学 | 中山大学 | 华中科技大学 |
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **语言** | Rust (+C lwext4) | Rust (+C lwext4) | Rust | Rust | Rust | Rust (+C lwext4) |
| **内核代码量** | ~60,000行Rust + ~109,000行C | ~10,979行Rust | ~13,700行Rust | ~36,000行Rust | ~18,000行核 + ~29,000行自研crate | ~15,000-20,000行Rust |
| **支持架构** | RISC-V64, LA64 (AArch64/x86_64就绪) | RISC-V64, LA64 | RISC-V64, LA64 | RISC-V64, LA64 | RISC-V64为主, LA64约20% | RISC-V64, LA64 |
| **HAL方案** | polyhal (4架构) | polyhal | polyhal | 自研(架构目录+feature) | 自研(trait+cfg_if) | 自研(trait+cfg_if) |
| **系统调用数** | 150+ | 73 | 100+ | 90+ | 75 | 100+ |
| **生态归属** | (独立) | rCore | ByteOS | 独立自研 | rCore | 独立自研 |
| **整体完整度** | 65% | 约55% | 约60% | 约65% | 约70% | 约58% |

---

## 二、架构设计对比

### 2.1 硬件抽象层设计

| 维度 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **HAL方案** | polyhal + define_arch_mods!宏 | polyhal | polyhal | 架构目录 + feature标志 | trait + cfg_if条件编译 | trait + cfg_if条件编译 |
| **架构覆盖** | 4种(riscv64/la64/aarch64/x86_64) | 2种(riscv64/la64) | 2种(riscv64/la64) | 2种(riscv64/la64) | 1.2种(RV64完整, LA64框架) | 2种(riscv64/la64) |
| **HAL原创性** | 中(复用polyhal) | 低(依赖polyhal) | 低(依赖polyhal) | 高(自研完整HAL) | 高(自研trait HAL) | 高(自研统一抽象) |
| **代码复用率** | 高(宏驱动架构分派) | 中 | 中 | 高(架构目录分离清晰) | 中(LA64仅框架) | 高(统一配置接口) |

**分析**：Kairix OS、Nonix OS、MonkeyOS 三者共享 polyhal HAL 层生态。Kairix 在 polyhal 之上将架构覆盖扩展到四种（实际验证两种），并通过 `define_arch_mods!()` 宏实现了编译时零开销的架构分派，在 polyhal 生态中拓展最深。NPUcore-BLOSSOM 的自研 HAL 最为完整，为 LoongArch64 定义了详尽的 CSR 寄存器接口并支持 LAFlex 灵活页表。Explosion OS 和 TatlinOS 的自研 HAL 均采用 trait+cfg_if 模式，设计合理，但 Explosion OS 的 LA64 移植仅约 20%，双架构承诺未能兑现。

### 2.2 调度器设计

| 维度 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **调度范式** | 抢占式同步调度 | FIFO协作 | async/await协作式 | FIFO | FIFO轮转 | 轮转 (Round-Robin) |
| **调度策略** | SCHED_NORMAL/FIFO/RR (0-99优先级) | 单一FIFO | 单一FIFO (全局队列) | 单一FIFO | 单一FIFO | 单一轮转 |
| **时间片抢占** | 有 | 无 | 无(纯协作, Waker为空) | 无 | 有(定时器中断触发) | 有(1Hz时钟中断) |
| **SMP支持** | 有(独立就绪队列, 未负载均衡) | 无(仅hart0) | 无(代码被注释) | 无 | 无 | 无(限制HART_NUM=1) |

**分析**：Kairix OS 是六个项目中唯一实现多级调度策略（SCHED_NORMAL/FIFO/RR）和 SMP 多核支持的项目。MonkeyOS 的 async/await 协作式调度在代码简洁性上有优势，但 Waker 为空实现在工程上存在严重缺陷——阻塞任务无法真正被唤醒。TatlinOS 的 1Hz 时钟中断频率导致调度粒度过粗。其余项目均为单核 FIFO，调度能力处于同一层级。

### 2.3 模块化与代码组织

| 维度 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **模块化方式** | Cargo workspace (多crate) | Cargo workspace (2成员) | 多crate (无workspace) | Cargo workspace | Cargo workspace (7 crate) | 单crate扁平结构 |
| **子系统边界** | 清晰(syscall/task/mm/fs/net/sync分目录) | 清晰(os/src下分模块) | 清晰(kernel/src下分模块) | 清晰(hal/mm/task/fs/net分层) | 清晰(os+ext4_rs+其他crate) | 较清晰(modules目录+扁平) |
| **同步原语体系** | 4种(SpinLock/SpinNoIrq/BlockingMutex/ReentrantLock) | UPSafeCell+Mutex | Mutex/RwLock | Mutex/RwLock | UPIntrFreeCell+自旋锁+阻塞锁+信号量+条件变量 | Mutex/RwLock |

**分析**：所有六个项目的模块化程度均较好。Kairix OS 的同步原语体系最为完善，四种锁类型覆盖了从中断上下文到长临界区的全部场景。Explosion OS 提供了信号量和条件变量，在同步原语种类上最为丰富，但强依赖单核中断禁用模型。

---

## 三、子系统实现深度对比

### 3.1 内存管理

| 特性 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **物理页分配器** | 栈式+回收栈 | 伙伴系统 | 位图线性扫描O(n) | 栈式 | 栈式 | 栈式+页缓存(水位线) |
| **内核堆分配** | Buddy allocator | Buddy allocator (256MB) | linked_list_allocator (16MB固定) | Buddy | 链表分配器 | Buddy |
| **COW** | 完整(PTE标志+Arc) | 完整(引用计数) | 完整(Arc引用计数) | 完整 | 完整(FrameTracker标记) | 完整(PTE bit 9) |
| **懒分配** | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| **mmap** | 完整(匿名+文件, 共享+私有) | 完整(共享组机制) | 完整 | 部分(文件映射不完整) | 完整 | 完整(GroupManager管理共享) |
| **共享页去重** | **KSM(扫描-合并-COW分离)** | GROUP_SHARE(共享组ID) | 无 | 无 | PageCache雏形 | GroupManager |
| **Swap/Zram** | **Swap(文件后端128MB)** | 无 | 无 | **Zram(LZ4)+Swap** | 无 | 无 |
| **OOM处理** | 水位线回收+后台回收 | 无 | 无 | **三级降级策略** | 无 | 无 |
| **页面回收** | 清洁页缓存回收+脏页写回 | 无 | 无 | Zram压缩+Swap换出 | 无 | 无 |
| **mremap** | 完整 | 缺失 | 缺失 | 缺失 | 缺失 | 缺失 |
| **mlock/munlock** | 完整 | 缺失 | 缺失 | 缺失 | 缺失 | 缺失 |

**分析**：Kairix OS 和 NPUcore-BLOSSOM 在内存管理上处于六个项目中的第一梯队，两者均实现了 Swap 等高级特性。Kairix 的 KSM（内核同页合并）在所有项目中独一无二，而 NPUcore-BLOSSOM 的 Zram 压缩内存在内存压力场景下有独特优势。TatlinOS 的页缓存水位线设计在分配性能优化上独具匠心。Nonix OS 和 MonkeyOS 的内存管理停留在基础层次（COW+懒分配），缺少页面置换与回收机制。

### 3.2 进程与任务管理

| 特性 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **进程/线程模型** | PCB/TCB分离 | TCB为主 | PCB/TCB分离 | TCB为主 | PCB/TCB分离 | Process/TCB分离 |
| **clone语义** | 完整(CLONE_VM/FILES/SIGHAND/THREAD/VFORK等) | 完整(SHARE_VM/FILES) | 完整 | 完整 | 完整(CLONE_VM/FILES等) | 完整(CLONE_THREAD等) |
| **进程组/会话** | 完整(pgid/sid) | 无 | 存根 | 无 | 无 | 有限 |
| **POSIX凭证** | 完整(UID/EUID/SUID/GID/EGID/SGID) | 统一root | 统一root | 统一root | 部分 | 部分 |
| **资源限制rlimit** | 完整(FSIZE/NOFILE) | 无 | 部分 | 无 | 基础 | 无 |
| **C库支持** | musl | musl | **musl+glibc双库** | musl | musl | musl |
| **ELF加载优化** | 标准加载 | 标准加载 | **任务模板缓存** | 标准加载 | 标准加载 | 标准加载 |
| **孤儿进程回收** | 有 | 未明确 | 未明确 | 有(归init) | 有(Reparent) | 有 |

**分析**：Kairix OS 在进程管理上最为完备——POSIX 凭证模型、进程组/会话、资源限制、Landlock 沙箱均完整实现。MonkeyOS 的 musl+glibc 双 C 库支持和任务模板缓存机制是其独有亮点，显著提升了用户态兼容性和程序加载效率。Nonix OS 的进程管理核心路径完整但缺少进程组/会话等高级抽象。

### 3.3 文件系统

| 特性 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **磁盘文件系统** | **ext4+FAT32** | ext4 | ext4 | **ext4+FAT32** | ext4 | ext4 |
| **ext4实现方式** | lwext4 C库绑定 | lwext4 C库绑定 | lwext4 C库绑定 | 自研(基于lwext4框架) | **自研纯Rust ~7,000行** | lwext4 C库绑定 |
| **虚拟文件系统** | **tmpfs/devfs/procfs/sysfs/etc** | /proc(动态注册) | ramfs/devfs/procfs | pipe/null/zero/urandom/tty | /proc(静态) | 无 |
| **VFS抽象** | File/Inode/Dentry/SuperBlock四层 | File trait + FileClass | INodeInterface + FileSystem | VFS + DirectoryTreeNode缓存 | File trait | Inode + File trait |
| **页缓存** | 有(统一页面缓存,16MB限制) | 无 | 无 | 有 | PageCache雏形 | 无 |
| **写回机制** | 有(延迟批处理队列) | 无 | 无 | 无 | 无 | 无 |
| **管道** | 环形缓冲区(64KB, 最大1MB) | 环形缓冲区(32字节) | 支持 | 支持 | 支持 | 环形缓冲区(64KB) |
| **DCache** | LRU淘汰(32768条目上限) | HashMap缓存 | 无 | DirectoryTreeNode(BTreeMap+懒加载) | 无 | 无 |
| **文件事件通知** | **fanotify+inotify(含权限事件)** | 无 | 无 | 无 | 无 | 无 |
| **Ext4特性** | xattr/fallocate | 基本CRUD | 目录读取硬编码限制50项 | **Extent树+CRC32** | **Extent树+块/Inode分配** | 基本CRUD+符号链接 |
| **日志(Journaling)** | 有限(依赖lwext4) | 有限(依赖lwext4) | 有限(依赖lwext4) | 有限 | 无(自研不含Journal) | 有限(依赖lwext4) |

**分析**：Kairix OS 在文件系统子系统的广度和深度上全面领先——支持两种磁盘文件系统加五种虚拟文件系统、完整的 VFS 四层抽象、统一页面缓存、写回机制、DCache LRU淘汰、以及 fanotify/inotify 事件通知。Explosion OS 从零自研近 7,000 行纯 Rust ext4 实现的工程量在所有项目中最为突出，虽然缺少 Journal 机制但核心读写逻辑完整。NPUcore-BLOSSOM 是除 Kairix 外唯一支持双磁盘文件系统（ext4+FAT32）的项目。Nonix OS 的管道缓冲区仅 32 字节，严重制约 I/O 性能。

### 3.4 网络栈

| 特性 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **协议栈方案** | **自研完整TCP/IP** | 无 | lose-net-stack | smoltcp | **自研lose-net-stack** | 伪实现(UDP队列模拟) |
| **TCP实现** | **完整状态机+流控** | 无 | 基础 | 依赖smoltcp | 无完整状态机 | 无 |
| **UDP** | 完整 | 无 | 基础 | 依赖smoltcp | 基础 | 伪实现 |
| **ICMP** | Echo Reply | 无 | 无 | 依赖smoltcp | 无 | 无 |
| **ARP** | 完整(表+等待队列) | 无 | 无 | 依赖smoltcp | 基础 | 无 |
| **IP分片重组** | 有 | 无 | 无 | 依赖smoltcp | 无 | 无 |
| **Socket抽象** | TCP/UDP/Raw/Unix | 无 | TCP/UDP | TCP/UDP(Unix未完成) | TCP/UDP | 仅本地回环模拟 |
| **Unix Domain Socket** | 有(最小化) | 无 | 无 | 未完成(todo!) | 无 | 无 |
| **网络设备驱动** | VirtIO-net(MMIO+PCI) | 无 | VirtIO-net | VirtIO-net | VirtIO-net | 无 |

**分析**：Kairix OS 是六个项目中唯一从零实现完整四层 TCP/IP 协议栈（含 TCP 状态机、IP 分片重组、ARP 表管理）的项目，网络实现最为深入。NPUcore-BLOSSOM 依赖 smoltcp 获得相对完整的 TCP/UDP 能力。Explosion OS 的自研 lose-net-stack 具备基础连通能力但缺乏 TCP 可靠性保障。TatlinOS 的网络为纯桩实现，无法进行真实网络通信。Nonix OS 完全没有网络支持。

### 3.5 系统调用与信号

| 特性 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|-----------|----------|----------|-----------------|-------------|----------|
| **系统调用数** | **150+** | 73 | 100+ | 90+ | 75 | 100+ |
| **信号支持** | 标准信号+实时信号(64个) | 32个(标准) | 支持 | **64位完整信号掩码** | 基础(主要致命信号) | **64位完整+实时信号** |
| **sigreturn** | 完整(信号帧+嵌套) | **未实现(panic)** | 支持 | 支持 | 不完整 | **完整(上下文恢复)** |
| **Futex** | **完整(WAIT/WAKE/REQUEUE/BITSET+超时)** | 无 | 基础 | **完整(BTreeMap+精确唤醒)** | 无 | **完整(含BITSET+超时)** |
| **Landlock** | **ABI v6(路径+网络规则)** | 无 | 无 | 无 | 无 | 无 |
| **fanotify/inotify** | **完整(含权限事件)** | 无 | 无 | 无 | 无 | 无 |
| **SysV共享内存** | 完整(shmget/shmat/shmdt/shmctl) | 完整 | 完整(含信号量+消息队列) | 部分 | 无 | 完整 |

**分析**：Kairix OS 以 150+ 系统调用数量领先，且是唯一实现 Landlock 沙箱和 fanotify 权限事件的项目。Landlock ABI v6 兼容实现在非 Linux 内核中极为罕见。Nonix OS 虽然系统调用数量最少（73），但其信号机制存在致命缺陷——sigreturn 未实现导致用户态自定义信号处理函数无法正常返回。TatlinOS 的 Futex 实现与定时器深度集成，在超时处理上最为完善。

---

## 四、技术亮点对比

| 项目 | 独特技术亮点 | 创新性评级 |
|------|-------------|-----------|
| **Kairix OS** | KSM内核同页合并（竞赛OS中极罕见）；Landlock ABI v6沙箱；fanotify权限事件；自研完整TCP/IP协议栈(含TCP状态机+IP分片重组)；延迟僵尸任务释放避免死锁；嵌入式mkfs工具链；initproc内嵌 | **极高** |
| **Nonix OS** | mmap共享组(GROUP_SHARE)机制高效解决fork后物理帧共享；动态虚拟文件注册表支持/proc；基于polyhal的双架构适配 | **中高** |
| **MonkeyOS** | Rust async/await协作式调度(代码简洁性突出)；musl+glibc双C库动态链接；任务模板缓存(TaskCacheTemplate)加速ELF加载；LoongArch PCI总线枚举 | **高** |
| **NPUcore-BLOSSOM** | Zram(LZ4压缩)+Swap完整内存回收链路；三级OOM降级策略(清缓存→清当前进程→遍历清所有)；双磁盘文件系统(ext4+FAT32)；目录树缓存(DirectoryTreeNode) | **高** |
| **Explosion OS** | 从零自研纯Rust ext4(~7,000行,含Extent树+块分配)；自研轻量级网络协议栈；地址类型Newtype抽象防混用 | **极高** |
| **TatlinOS** | 物理页缓存(水位线)优化分配性能；GroupManager高效管理mmap共享页；Futex超时与定时器深度集成；双架构统一抽象代码复用率高 | **中高** |

---

## 五、不足与缺失对比

| 项目 | 主要不足与缺失 |
|------|--------------|
| **Kairix OS** | TCP拥塞控制简化，io_uring仅占位，BPF仅占位；设备驱动仅virtio；C库依赖(lwext4)引入线程安全问题需全局锁保护；SMP缺少负载均衡；ext4 journal回放有限 |
| **Nonix OS** | **sigreturn未实现(致命缺陷)**；管道缓冲区仅32字节(严重制约I/O)；单核且仅hart0；无网络支持；无Swap/OOM处理；部分系统调用为伪实现(ioctl/setpgid始终返回0)；仅FIFO调度 |
| **MonkeyOS** | **Waker为空实现(协作式调度致命缺陷)**；堆固定16MB不可扩展；内存映射权限粗糙(URWX)；ext4目录读取硬编码50项限制；符号链接无限递归风险；网络IP硬编码；force_unlock不安全操作 |
| **NPUcore-BLOSSOM** | 仅单核FIFO调度；物理页分配器为简单栈式(无碎片整理)；UnixSocket核心方法todo!()；部分物理板级BSP仅为框架；错误处理混用panic!与Result降低容错性；无mremap/mlock |
| **Explosion OS** | 自研ext4无Journal(数据安全性不足)；TCP无完整状态机/重传/拥塞控制；LoongArch仅约20%；调度器仅FIFO；/proc为静态伪文件；部分系统调用号非标准；依赖单核中断禁用模型无法扩展至SMP |
| **TatlinOS** | **网络为纯桩实现**(仅UDP队列模拟本地回环)；**时钟中断仅1Hz**(时间精度极差)；仅单核轮转调度；无虚拟文件系统(procfs/sysfs全缺)；无Swap/OOM处理；文件系统类型单一(仅ext4) |

---

## 六、整体成熟度综合评分

以 Linux 内核对应子系统为满分基准（100%），结合功能广度与实现深度加权计算：

| 维度 | 权重 | Kairix OS | Nonix OS | MonkeyOS | NPUcore-BLOSSOM | Explosion OS | TatlinOS |
|------|------|-----------|----------|----------|-----------------|-------------|----------|
| 内存管理 | 20% | 75% | 55% | 50% | 70% | 65% | 60% |
| 进程管理 | 20% | 80% | 60% | 65% | 60% | 65% | 60% |
| 文件系统 | 20% | 75% | 60% | 55% | 70% | 75% | 55% |
| 网络栈 | 15% | 60% | 0% | 30% | 50% | 40% | 5% |
| 系统调用 | 15% | 80% | 55% | 65% | 60% | 60% | 65% |
| 多架构HAL | 10% | 80% | 70% | 70% | 80% | 50% | 80% |
| **加权总分** | **100%** | **74%** | **50%** | **54%** | **64%** | **60%** | **53%** |

**排名**：Kairix OS (74%) > NPUcore-BLOSSOM (64%) > Explosion OS (60%) > MonkeyOS (54%) > TatlinOS (53%) > Nonix OS (50%)

---

## 七、各项目总结评价

### Nonix OS (南开大学-如有名字队-nonix)

Nonix OS 是一个结构清晰、代码精简（~11,000行）的双架构宏内核。其 mmap 共享组机制在解决 fork 后物理帧共享问题上有独到设计。然而，该项目的功能深度在六个项目中最为有限——无网络支持、无 Swap/OOM、管道仅 32 字节、系统调用数最少（73个），且 sigreturn 未实现构成致命功能缺陷。整体处于竞赛内核的基础层级。

### MonkeyOS (天津大学-Moncake-T202510056995244-24)

MonkeyOS 在架构创新上最为大胆——采用 Rust async/await 构建协作式调度器，并支持 musl+glibc 双 C 库动态链接。任务模板缓存机制是实用的工程优化。然而，Waker 为空实现使协作式模型的实际效果大打折扣，内存映射权限粗放（URWX）、堆大小固定 16MB 等问题反映了系统在底层严谨性上的不足。

### NPUcore-BLOSSOM (西北工业大学-NPUcore-BLOSSOM-oskernel2025-npucore-blossom)

NPUcore-BLOSSOM 是六个项目中与 Kairix OS 在内存管理高级特性上最为接近的项目。其 Zram(LZ4 压缩)+Swap+三级 OOM 降级的完整内存回收链路，是除 Kairix 的 KSM 之外最突出的内存管理创新。双磁盘文件系统（ext4+FAT32）和 64 位完整信号掩码也体现了较高的工程完成度。主要短板在于调度仅 FIFO、UnixSocket 未完成、部分 BSP 仅为框架。

### Explosion OS (中山大学-KernalCraft-T202510558995240-2536)

Explosion OS 在文件系统子系统的工程量上最为突出——从零自研近 7,000 行纯 Rust ext4 实现（含 Extent 树和块分配），是所有项目中唯一不依赖 C 库的 ext4 方案。自研网络协议栈也展现了较强的底层系统编程能力。然而，自研 ext4 缺少 Journal 使数据安全性存疑，TCP 无完整状态机，LoongArch 支持仅约 20%，反映项目在深度与广度之间存在取舍。

### TatlinOS (华中科技大学-塔特林设计局-T202510487995221-883)

TatlinOS 在双架构统一抽象上设计合理，物理页缓存水位线机制在分配性能优化上独具匠心，Futex 与定时器的深度集成也体现了精细的工程考量。然而，1Hz 时钟中断频率导致时间精度极差，网络为纯桩实现，无任何虚拟文件系统支持，这三个关键短板使其在六个项目中的功能完整性处于下游。

### Kairix OS (基准项目)

Kairix OS 是六个项目中功能覆盖最广、实现深度最高的项目。其 KSM 内核同页合并、Landlock ABI v6 沙箱、fanotify 权限事件、自研完整 TCP/IP 协议栈等特性在竞赛级 OS 内核中极为罕见（部分特性在所有项目中独一无二）。150+ 系统调用、四种架构 HAL 覆盖、五种虚拟文件系统、统一的页面缓存与写回机制，展现了系统级的架构设计能力。不足之处在于部分子系统（TCP 拥塞控制、io_uring、BPF）深度有限，设备驱动仅限 virtio，且 lwext4 C 库依赖引入了全局锁瓶颈。

---

## 八、评审意见

综合六个项目的横向对比，可以得出以下结论：

**第一梯队（全面领先型）**：Kairix OS 以 150+ 系统调用、KSM、Landlock、自研 TCP/IP、双磁盘文件系统加五种虚拟文件系统、完善的页面回收与交换机制，在功能广度和深度上全面领先。其在内存管理高级特性（KSM、Swap、页面回收、写回）和安全性（Landlock、fanotify 权限事件）上的投入，使其显著区别于其他五个项目。

**第二梯队（深度突破型）**：NPUcore-BLOSSOM 和 Explosion OS 在特定子系统上有突出的深度突破。NPUcore-BLOSSOM 的 Zram+Swap+OOM 内存回收链路是除 Kairix 之外最完善的内存管理方案。Explosion OS 从零自研纯 Rust ext4 文件系统近 7,000 行的工程量，体现了极强的底层系统编程能力和对文件系统内部机制的深入理解。

**第三梯队（功能基础型）**：MonkeyOS、TatlinOS、Nonix OS 在核心执行路径上均形成闭环，能够运行基础用户态程序，但在高级特性上存在不同程度的缺失。MonkeyOS 的 async/await 架构创新值得肯定但工程完成度不足（Waker 为空），TatlinOS 的 1Hz 时钟和伪网络实现严重制约实用性，Nonix OS 的 sigreturn 缺失构成致命功能缺陷。

**总体而言**，Kairix OS 在系统调用覆盖面、高级内存管理特性（KSM/Swap）、安全机制（Landlock/fanotify）、自研网络协议栈深度、多架构 HAL 覆盖等方面，相比五个同类项目具有明显的综合优势。其技术路线体现了"广度与深度并重"的设计哲学——既覆盖了从内存管理到网络安全的全链路，又在 KSM、Landlock 等高级特性上实现了单点突破。这种系统性的工程能力使其在同类竞赛内核项目中处于领先地位。