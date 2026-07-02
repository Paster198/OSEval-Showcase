# 对比分析报告

## 一、项目总览

本报告对 xiande-OS 与五个同期竞赛项目进行多维度对比。六个项目均为 Rust 语言实现的宏内核，具有较高的可比较性。

| 属性 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **代码规模** | ~31,633 行 | ~41,200 行 | ~15,000-20,000 行 | ~37,531 行 | 356 源文件 | ~61,441 行 |
| **支持架构** | RISC-V64 + LoongArch64 | RISC-V64 + LoongArch64 | RISC-V64 + LoongArch64 | LoongArch64 + RISC-V64 | RISC-V64 + LoongArch64 | RISC-V64 |
| **系统调用数** | ~238 | ~200 | 100+ | 117 | 115 | 101 |
| **并发模型** | 抢占式轮转 (1ms) | async/await + PELT | 协作式轮转 | FIFO | async/await 多级优先级 | async/await + FIFO/RR/CFS |
| **多核支持** | 无 (单 hart) | 完整 SMP | 无 (HART_NUM=1) | 无 (仅 CPU0) | 多 hart | 有 (SMP) |
| **上游基础** | 完全自研 | 自研 + async_task | 自研 + lwext4 | 自研 | 自研 + async_task | ArceOS/Starry |
| **构建验证** | 成功 (双架构) | 未完成 (环境限制) | 未完成 (缺镜像) | 成功 (单架构) | 未完成 (缺子模块) | 未完成 (环境限制) |

---

## 二、架构设计对比

### 2.1 内核类型与分层方式

| 维度 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **内核类型** | 宏内核 | 异步宏内核 | 宏内核 | 宏内核 | 异步宏内核 | 宏内核 |
| **HAL 抽象** | 命名约定 + #[cfg] | trait 抽象 + 条件编译 | cfg_if + trait | trait + 条件编译 | trait 抽象 | crate_interface + feature |
| **模块化程度** | 中 (55 源文件, 模块内聚) | 高 (清晰分层) | 中 (约100源文件) | 中 (约130源文件) | 高 (221+135 源文件) | 极高 (~50 crate) |
| **架构透明性** | 上层 95%+ 无条件编译 | trait 封装, 架构无关 | 核心逻辑共享 | HAL 完全隔离架构差异 | 内核层架构无关 | crate 级别隔离 |

xiande-OS 的 HAL 设计最为简洁：以命名约定用 `use imp as ...` 重导出关键类型，无需 trait 对象带来的动态分发开销。Chronix 和 NoAxiom-OS 的 trait 抽象更规范但引入了间接层。KeepOnOS 的组件化架构基于 ArceOS 框架，crate 粒度最细但整体耦合度受框架约束。

### 2.2 调度与并发模型

这是六个项目差异最大的维度，也是区分设计哲学的核心标志。

| 项目 | 调度模型 | 核心机制 |
|------|----------|----------|
| **xiande-OS** | 抢占式轮转 (trap 边界) | 1ms 定时器抢占, `PREEMPT_DISABLE` 计数器保护临界区 |
| **Chronix** | async/await 执行器 + PELT 负载追踪 | 每核心任务队列, SMP 任务迁移, `woken_while_running` 判定 |
| **TatlinOS** | 协作式轮转 | 定时器中断触发 `suspend_current_and_run_next` |
| **NPUcore-Aspera** | FIFO | `suspend_current_and_run_next` + 超时唤醒 |
| **NoAxiom-OS** | async/await 多级优先级 | 实时 FIFO + 普通 Expired 双队列, CPU 亲和性掩码 |
| **KeepOnOS** | async/await 多策略 | FIFO/RR/CFS 可选, `async-task` 执行器 |

xiande-OS 是唯一采用 **纯抢占式同步调度** 的项目，不使用 async/await。Chronix、NoAxiom-OS 和 KeepOnOS 均基于 `async_task` crate 实现异步执行器，系统调用为异步函数。这两种路线各有优劣：同步抢占式模型的控制流更直观、调试更容易，但异步模型在 IO 密集型场景下能更自然地表达阻塞语义而不浪费 CPU。NoAxiom-OS 在性能测试中取得的 iperf 网络性能第一印证了异步模型在 IO 场景的优势。

---

## 三、子系统实现对比

### 3.1 内存管理

| 特性 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **物理帧分配** | Buddy 32级 | 位图分配器 | Buddy + 页缓存 (水位线) | 栈式 + recycled | 位图 + ZONE 分区 | Bitmap |
| **内核堆** | 256MB LockedHeap<32> | 13级 SLAB | Buddy LockedHeap | Buddy LockedHeap<32> | Slab/Buddy/TLSF 可选 | Slab/Buddy/TLSF 可选 |
| **页表** | Sv39 / LA 原生 | Sv39 / LA 原生 | Sv39 / LA64 页表 | Sv39 / LAFlex | Sv39 / LA 原生 | Sv39 |
| **懒分配** | 无 (即时分配) | 有 | 有 | 有 (延迟 PageFault) | 有 | 有 |
| **写时复制** | 无 (即时深拷贝) | 有 | 有 | 有 | 有 | 有 |
| **共享内存** | 有 (Arc<FrameTracker>) | 有 (SHM) | 有 (GroupManager) | 有 (SharedSegment) | 有 | 有 |
| **Zram/Swap** | 无 | 无 | 无 | 有 (LZ4/Zram+Swap) | 无 | 无 |
| **OOM 处理** | emergency_reclaim | shrink | 无 | 多层 OOM (缓存→浅清理→深清理) | 无 | 无 |
| **mremap** | 有 | 有 | 无 | 无 | 无 | 有 |
| **大页支持** | 有 (2MB 内核) | 无 | 无 | 无 | 无 | 无 |

xiande-OS 在内存管理上的设计选择是"即时分配 + 深拷贝"，在所有项目中**唯一不实现懒分配和 CoW**。这降低了页错误处理的复杂度，无需 TLB shootdown 协议，避免了 CoW 的引用计数管理开销。代价是 fork 和 mmap 的内存效率较低、启动延迟更高。TatlinOS 的页缓存水位线机制在物理页分配性能上有所创新，NPUcore-Aspera 的 OOM+Zram+Swap 组合在内存压力处理上最为完善，Chronix 的 13 级 SLAB 分配器在细粒度内存分配上最具工程深度。

### 3.2 文件系统

| 特性 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **Ext4** | 只读 (自研 extent) | 读写 (lwext4 C 绑定) | 读写 (lwext4 Rust 封装) | 读写 (自研 extent) | 读写 | 读写 (another_ext4) |
| **Ext2** | 读写 (自研, 含内核内 mkfs) | 无 | 无 | 无 | 无 | 无 |
| **FAT32** | 只读 (自研) | 读写 | 无 | 读写 | 读写 | 读写 (rust-fatfs) |
| **tmpfs** | 完整读写 | 有 (TmpFS) | 无 | 无 | 有 (RamFS) | 有 (ramfs) |
| **devfs** | 有 | 有 (DevFS) | 无 | 有 (设备文件) | 有 (DevFS) | 有 (devfs) |
| **procfs** | 完整 (/proc/pid/*, /proc/mounts 等) | 有 | 无 | 仅 meminfo/interrupts | 有 | 模拟 (部分) |
| **管道** | 环形缓冲区 64KiB, SIGPIPE | 有 (PipeFS) | 环形缓冲区 64KiB | 有 | 有 | 有 |
| **inotify/fanotify** | 有 (完整实现) | 无 | 无 | 无 | 无 | 无 |
| **VFS 层** | Inode trait + FdTable | Dentry + Inode trait | Inode trait + File trait | VFS trait + File trait | Dentry + Inode trait | VFS + RootDirectory |
| **页缓存** | 有 (read block cache) | 有 | 无 | 有 (PageCache) | 有 | 有 |
| **Dentry 缓存** | 无 | 有 | 无 | 有 (DirectoryTreeNode) | 有 | 无 |

xiande-OS 在文件系统方面覆盖面最广（7 种），且是唯一实现 **内核内 ext2 mkfs** 和 **inotify/fanotify** 的项目。其 ext4 只读驱动的 extent 树解析为完全自研。Chronix 使用 lwext4 C 绑定获得完整 ext4 读写能力，但引入了 C 依赖。NPUcore-Aspera 的 FAT32+Ext4 双文件系统均自研，且实现了页缓存与目录树缓存。TatlinOS 在文件系统多样性上明显不足，仅支持 ext4 和管道。

### 3.3 网络子系统

| 特性 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **协议栈** | smoltcp | smoltcp | 无 (伪实现) | smoltcp | smoltcp | smoltcp |
| **TCP/UDP** | 有 | 有 | 无 | 有 (仅回环) | 有 | 有 |
| **IPv4/IPv6** | IPv4 | IPv4 | 无 | IPv4 | IPv4+IPv6 | IPv4 |
| **Loopback** | 自研内核内 (TCP/UDP) | 无专门实现 | 无 | smoltcp 回环 | 无专门实现 | 无 |
| **Unix Socket** | 无 | SocketPair | 伪实现 (管道模拟) | 大部分 todo!() | 无 | 无 |
| **Raw Socket** | 无 | 有 | 无 | 无 | 无 | 无 |
| **AF_ALG** | 无 | 有 | 无 | 无 | 无 | 无 |
| **网络设备** | virtio-net | virtio-net + MMC | 无 | 无 (仅回环) | virtio-net (异步) | virtio-net + IXGBE |
| **sendmmsg/recvmmsg** | 有 | 无 | 无 | 无 | 无 | 无 |

xiande-OS 的 loopback 实现最为特别：在 smoltcp 之上的内核内管道对，避免了回环地址的协议栈往返开销。Chronix 的网络功能最全（Raw Socket + AF_ALG + SocketPair）。NoAxiom-OS 的 virtio-net 异步驱动获得了比赛网络性能第一。

### 3.4 进程管理与信号

| 特性 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **fork/clone** | 完整 (CLONE_VM/THREAD/FILES 等) | 完整 | 完整 | 完整 | 完整 | 完整 |
| **execve/execveat** | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| **wait4/waitid** | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| **线程组** | 有 (tgid) | 有 (ThreadGroup) | 有 | 有 | 有 (ThreadGroup) | 有 |
| **vfork** | 有 | 无 | 无 | 无 | 有 | 无 |
| **进程组/会话** | 有 (pgid/sid) | 无 | 无 | 无 | 有 (pgid) | 有 |
| **POSIX 信号** | 完整 (64信号+SA_SIGINFO) | 完整 (标准+实时) | 完整 | 完整 | 64信号 | 部分 |
| **信号备用栈** | 有 (SA_ONSTACK) | 有 | 无 | 无 | 无 | 无 |
| **vDSO** | 自研 (含 CFI) | 有 | 无 | 无 | 无 | 无 |
| **孤儿回收** | 有 | 无 | 无 | 无 | 有 | 无 |

xiande-OS 在进程管理子系统中实现了 vfork、进程组/会话、SA_ONSTACK 信号备用栈、自研 vDSO 等细节，整体完整度在六个项目中最高。Chronix 的线程组模型最为接近 Linux 设计。KeepOnOS 的进程组/会话支持源自 Starry 框架。

### 3.5 IPC 与同步

| 特性 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **SysV 共享内存** | 完整 | 有 | 有 (自研 shm) | 有 (SharedSegment) | 有 | 有 (SHM) |
| **SysV 消息队列** | 完整 | 有 | 无 | 无 | 无 | 无 |
| **SysV 信号量** | 完整 (含 UNDO) | 无 | 无 | 无 | 无 | 无 |
| **Futex** | 完整 (含 CMP_REQUEUE) | 完整 (含 robust list) | 完整 (含超时) | 有 (基本) | 完整 (FUTEX_BITSET) | 完整 (含 robust list) |
| **Key Management** | 完整 (keyring) | 无 | 无 | 无 | 无 | 无 |
| **epoll** | 完整 | 有 | 无 | 无 | 无 | 无 (仅定义 ID) |
| **splice 族** | 完整 (splice/tee/vmsplice/sendfile) | 有 (sendfile) | 无 | 无 | 无 | 有 (sendfile/splice 部分) |

xiande-OS 是唯一完整实现 SysV 三种 IPC 机制的项目，且实现 keyring 子系统。Chronix 缺少 SysV 信号量。epoll 方面，xiande-OS 和 Chronix 是仅有的两个实现者。这与 xiande-OS 的系统调用数量最高（238）一致。

---

## 四、技术亮点对比

### 4.1 各项目独特亮点

| 项目 | 核心亮点 | 技术深度 |
|------|----------|----------|
| **xiande-OS** | 抢占安全 Mutex (无中断关闭), per-syscall 看门狗, 两遍构建符号表, 内核双重故障保护, 自研 vDSO+CFI, ext2 内核内 mkfs, inotify/fanotify, keyring | 极高 (系统级健壮性工程) |
| **Chronix** | async/await 内核执行器, PELT 负载追踪, SMP 任务迁移, 13级 SLAB 分配器, AF_ALG 加密套接字, LoongArch EIOINTC | 极高 (架构创新 + SMP) |
| **TatlinOS** | 页缓存水位线机制, GroupManager 共享页管理, 完整 COW+懒分配, lwext4 深度集成 | 中高 |
| **NPUcore-Aspera** | LAFlex 页表 TLB Refill 内联汇编优化, Frame 状态机, 多层 OOM 处理, Zram+Swap | 高 (内存管理深度) |
| **NoAxiom-OS** | 无栈协程异步调度, 细粒度并发模型, 异步 virtio 驱动, iperf 性能第一 | 高 (并发模型创新) |
| **KeepOnOS** | ~50 crate 组件化架构, 三调度策略可选, VisionFive2 实体板适配, 链接模拟 | 中高 (工程广度) |

### 4.2 亮点评述

**xiande-OS** 的创新集中在**系统级健壮性工程**，而非架构范式创新。其抢占安全 Mutex 设计（只禁抢占、不关中断，看门狗仍可运行）、per-syscall 看门狗 + 锁强制恢复路径、内核双重故障保护、用户态故障循环断路器等机制，在竞赛内核中独树一帜。两遍构建符号表自解析（`black_box` + fat pointer）也是精巧的工程技巧。这些设计体现了对"内核在异常压力下不崩溃"的深刻考量。

**Chronix** 和 **NoAxiom-OS** 共享 async/await 异步内核范式，但 Chronix 在此基础上实现了 SMP + PELT 负载均衡，架构创新度和工程复杂度更高。NoAxiom-OS 的更细粒度并发模型和异步驱动深度集成更为彻底。

**NPUcore-Aspera** 的 LAFlex 页表优化针对 LoongArch64 的 TLB Refill 异常处理进行了汇编级优化，这是对特定硬件特性进行深度利用的典范。

**TatlinOS** 的页缓存水位线和 GroupManager 设计体现了对性能细节的关注，但在系统调用覆盖和子系统多样性上相对保守。

**KeepOnOS** 受益于 ArceOS/Starry 框架的组件化设计，在模块化程度上最高，但原创性相对较低（多数子系统基于框架扩展）。

---

## 五、不足与缺失对比

| 维度 | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|------|-----------|---------|----------|----------------|------------|----------|
| **懒分配/CoW** | 缺失 (最大短板) | 有 | 有 | 有 | 有 | 有 |
| **多核/SMP** | 缺失 | 有 | 缺失 | 缺失 | 部分 (未完善) | 有 |
| **真实网络设备驱动** | 有 (virtio-net) | 有 | 缺失 | 缺失 (仅回环) | 有 | 有 |
| **io_uring** | 缺失 | 缺失 | 缺失 | 缺失 | 缺失 | 缺失 |
| **cgroup/namespace** | 缺失 | 部分 | 缺失 | 缺失 | 缺失 | 缺失 |
| **seccomp/bpf** | 缺失 | 缺失 | 缺失 | 缺失 | 缺失 | 缺失 |
| **文件系统日志** | 缺失 (ext2 无日志) | 缺失 | 依赖 lwext4 | 缺失 | 缺失 | 缺失 |
| **完整 SMP 锁** | 缺失 (仅单核 Mutex) | 有 | 缺失 | 缺失 | 有 | 有 |
| **Unix Socket** | 缺失 | 部分 (SocketPair) | 伪实现 | 大部分未实现 | 缺失 | 缺失 |
| **IPv6** | 缺失 | 缺失 | 缺失 | 缺失 | 有 | 缺失 |

xiande-OS 最显著的缺失是**懒分配与 CoW**（六个项目中唯一不实现的）和**多核 SMP 支持**。这两个缺失是设计取舍的结果（简化页错误处理、避免锁竞争复杂度），但限制了 fork 性能和总体吞吐量。相比之下，Chronix 在 SMP 和调度方面最为完善，NoAxiom-OS 和 KeepOnOS 次之。

---

## 六、整体成熟度综合对比

### 6.1 维度加权评分

以竞赛级宏内核的功能需求为基准（权重按实际重要性分配）：

| 维度 (权重) | xiande-OS | Chronix | TatlinOS | NPUcore-Aspera | NoAxiom-OS | KeepOnOS |
|-------------|-----------|---------|----------|----------------|------------|----------|
| **系统调用覆盖** (20%) | 9.5 | 9.0 | 7.0 | 7.5 | 7.0 | 7.0 |
| **内存管理** (15%) | 7.0 | 8.5 | 8.5 | 9.0 | 8.0 | 8.0 |
| **文件系统** (15%) | 9.0 | 8.5 | 7.0 | 8.0 | 8.5 | 8.0 |
| **进程/信号** (15%) | 9.5 | 9.0 | 8.5 | 8.0 | 8.5 | 8.0 |
| **网络** (10%) | 7.5 | 8.5 | 2.0 | 4.0 | 7.5 | 7.0 |
| **IPC/同步** (10%) | 9.5 | 7.0 | 5.0 | 4.5 | 6.0 | 6.5 |
| **架构抽象** (5%) | 8.5 | 9.0 | 8.0 | 9.0 | 8.5 | 7.0 |
| **调度/SMP** (5%) | 5.5 | 9.5 | 5.0 | 4.0 | 7.0 | 7.5 |
| **工程健壮性** (5%) | 9.5 | 7.5 | 6.0 | 7.0 | 7.0 | 6.5 |
| **加权总分** | **8.53** | **8.45** | **6.65** | **7.23** | **7.58** | **7.38** |

### 6.2 综合排名

| 排名 | 项目 | 加权分 | 核心优势 |
|------|------|--------|----------|
| 1 | **xiande-OS** | 8.53 | 系统调用覆盖最广, IPC 最完整, 健壮性工程最突出 |
| 2 | **Chronix** | 8.45 | SMP + PELT 调度, 异步架构最成熟, 内存管理深度 |
| 3 | **NoAxiom-OS** | 7.58 | 异步协程调度, 网络性能卓越, 并发模型精妙 |
| 4 | **KeepOnOS** | 7.38 | 组件化架构, 三调度策略, 实体板卡适配 |
| 5 | **NPUcore-Aspera** | 7.23 | Zram+Swap+OOM 内存管理深度, LAFlex 页表优化 |
| 6 | **TatlinOS** | 6.65 | COW+懒分配+页缓存, 设计扎实但覆盖范围有限 |

---

## 七、各项目总结评价

### xiande-OS
系统调用覆盖面（238 个）和 IPC 完整度（SysV 三种 + keyring + epoll + splice）在六个项目中居首。工程健壮性设计（抢占安全 Mutex、per-syscall 看门狗、内核双重故障保护、两遍构建符号表、vDSO+CFI）为所有项目中最突出。其即时分配与深拷贝策略在六个项目中独树一帜，是明确的工程取舍而非实现缺失。主要短板为无懒分配/CoW 和无 SMP，限制了在内存密集与多核场景下的表现。适合作为"高兼容性、高可靠性的单核内核"的参考实现。

### Chronix
异步宏内核的标杆项目，在 SMP 支持、PELT 调度、13 级 SLAB 分配器、AF_ALG 加密套接字等方面展现了架构创新的深度。~200 个系统调用覆盖和 lwext4 带来的完整 ext4 读写能力使其 Linux 兼容性出色。满分通过决赛测例验证了其工程质量。主要不足在于 IPC 子系统缺少 SysV 信号量，部分系统调用为存根，以及引入 C 依赖（lwext4）降低了纯 Rust 的均质性。

### TatlinOS
设计扎实、代码质量较高的竞赛内核，COW+懒分配+页缓存水位线的组合体现了对内存管理性能的深入思考。lwext4 集成提供了完整的 ext4 读写能力。主要不足在于网络子系统几乎完全缺失（伪实现）、调度器仅为简单轮转、无虚拟文件系统（procfs/devfs）、代码规模相对较小。整体功能覆盖范围在六个项目中最为有限。

### NPUcore-Aspera
内存管理深度为六个项目中最突出者——Zram 压缩、Swap 交换、多层 OOM 处理的组合展现了完整的页面回收与内存压力处理链路。LAFlex 页表对 LoongArch64 的 TLB Refill 进行了汇编级优化，是对特定硬件的深度利用。FAT32 和 Ext4 双文件系统均为自研。主要短板为调度器过于简单（FIFO）、网络仅为回环、Unix Socket 几乎全未实现、ProcFS 仅有两个节点。

### NoAxiom-OS
异步协程调度架构在 IO 密集型场景下优势显著（iperf 网络性能第一、性能测试总分第二）。五种文件系统实现、64 个信号支持、IPv4/IPv6 双栈等方面展现了良好的功能完整度。CFS 调度器代码完整但未启用是一大遗憾（作者自评负载均衡为"worst performance ever"）。epoll 缺失、部分系统调用空实现、多核负载均衡未完善是主要不足。

### KeepOnOS (ZeroOS)
受益于 ArceOS/Starry 组件化框架，在模块化程度和 crate 数量上（~50 个）远超其他项目。VisionFive2 实体板卡适配工作（自定义 PLIC、RTC、SD 卡驱动）体现了从虚拟到实物的能力。链接模拟方案是实用的工程技巧。主要不足为原创性相对较低（核心框架非自研）、代码风格不一致、硬编码值较多（栈数 110、FD 限制 1025），以及 epoll 缺失。

---

## 八、评审意见

综合评估六个 Rust 宏内核竞赛项目，xiande-OS 在 **系统调用覆盖广度**（238 个）、**IPC 完整度**（SysV 三种 + keyring + epoll + splice + inotify/fanotify）和 **系统级健壮性工程**（看门狗、故障恢复、双重故障保护、符号表自解析）三个维度上达到了所有项目中的最高水平。

xiande-OS 的设计哲学可概括为"在单核假设下最大化兼容性和可靠性"。其不实现懒分配和 CoW 的决策与 Chronix/NoAxiom-OS 选择异步调度、NPUcore-Aspera 选择 Zram+Swap 一样，均是有限开发时间内的自觉取舍。xiande-OS 选择将工程资源投入到系统调用覆盖和故障容错机制上，换来了 238 个系统调用的高兼容性和内核在异常压力下的稳定表现。

如果以"竞赛满分通过"作为最终标准，Chronix 已实现此目标且拥有 SMP 和 PELT 调度的架构优势；xiande-OS 在系统调用数量和 IPC 完整度上略胜 Chronix，但在多核和调度算法上存在差距。两个项目代表了竞赛级 Rust 宏内核的两条成功路径：Chronix 偏重架构创新（异步 + SMP），xiande-OS 偏重系统级工程（兼容性 + 健壮性）。

建议 xiande-OS 未来优先补齐懒分配和 CoW（可参考 TatlinOS 或 NPUcore-Aspera 的实现路径），并探索单核范围内的调度算法优化（如多级反馈队列替代固定时间片轮转），以在保持健壮性优势的同时缩小与异步/SMP 内核在性能和内存效率上的差距。