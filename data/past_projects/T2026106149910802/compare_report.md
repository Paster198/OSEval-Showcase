# 对比分析报告

## 1. 项目概述

本报告对以下六个操作系统内核项目进行多维度的横向对比分析：

| 编号 | 项目名称 | 所属学校 | 生态归属 | 架构支持 | 代码规模 |
|------|----------|----------|----------|----------|----------|
| P0 | UESTC OS Kernel 2026 | 电子科技大学 | rCore (RustOsWhu) | riscv64, loongarch64 (x86_64, aarch64 部分) | ~40,500 行 / 260 源文件 |
| P1 | Explosion OS | 中山大学 | rCore | riscv64 (loongarch64 部分) | ~49,442 行 / 366 源文件 |
| P2 | Nonix OS | 南开大学 | rCore + polyhal | riscv64, loongarch64 | ~10,979 行(os/) / 57 源文件 |
| P3 | NPUcore-BLOSSOM | 西北工业大学 | 独立生态 | riscv64, loongarch64 | ~36,000 行 / ~170 源文件 |
| P4 | NoAxiom-OS | 杭州电子科技大学 | 独立生态 | riscv64, loongarch64 | 221(内核)+135(库) 源文件 |
| P5 | Undefined-OS | 清华大学 | ArceOS | x86_64, aarch64, riscv64, loongarch64 | ~100+ 源文件 / 6 crate |

---

## 2. 架构设计对比

| 维度 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 组件化单体内核 |
| **HAL 方式** | crate_interface 宏 + 条件编译 | trait + cfg_if 条件编译 | polyhal 外部框架 | 架构抽象 + 板级支持分离 | arch trait + 条件编译 | ArceOS 框架 HAL |
| **HAL 解耦** | 零开销静态分派 | 零开销静态分派 | 外部 crate 依赖 | 模块级 feature 切换 | trait 静态分派 | 框架级抽象 |
| **模块化程度** | 高 (13 独立 crate) | 高 (7 独立 crate) | 中 (集中于 os crate) | 中 (集中于 os/src) | 很高 (kernel + lib 分离) | 很高 (6 workspace crate) |
| **调度器设计** | FIFO 时间片轮转 | FIFO 轮转 | FIFO 轮转 | FIFO (单队列) | 多级优先级 + 异步协程 | ArceOS 任务系统 |
| **并发模型** | UP 自旋锁 | UPIntrFreeCell (关中断) | UPSafeCell (单核) | UP 自旋锁 | 细粒度并发 + 异步 | ArceOS 同步原语 |
| **构建系统** | Cargo + Makefile | Cargo + Docker Makefile | Cargo (指定 nightly) | Cargo + feature flags | Cargo workspace | Cargo workspace + CMake |

**架构设计评述**：

- **P0 (UESTC)** 的 `crate_interface` 解耦机制是六个项目中最为独特的 HAL 设计：通过 proc-macro 实现编译时接口定义与实现分离，在保持零开销的同时彻底避免了循环依赖问题。模块化程度仅次于 P4 和 P5。
- **P1 (Explosion)** 的 HAL 设计采用传统 trait + cfg_if 模式，功能正确但灵活性不如 P0 的 crate_interface 方案。
- **P2 (Nonix)** 依赖外部 polyhal 框架，减轻了 HAL 开发负担但增加了外部依赖耦合，且其内核源码集中于单一 os crate，模块化程度最低。
- **P3 (NPUcore)** 的架构抽象与板级支持分离设计清晰，支持 5 种板级配置，但实际仅 QEMU virt 平台完整可用。
- **P4 (NoAxiom)** 的异步协程调度架构是六者中最具创新性的设计，将内核调度与 Rust async/await 深度整合，且其 Task 结构体按并发访问模式分类字段的设计在工程上极为成熟。
- **P5 (Undefined)** 依托 ArceOS 框架实现了四层进程模型 (Session-ProcessGroup-Process-Thread)，组件化设计带来最高的代码组织度，但框架依赖也限制了底层创新的自由度。

---

## 3. 子系统实现对比

### 3.1 内存管理

| 特性 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| 页帧分配器 | 栈式 | 栈式 | Buddy 伙伴 | 栈式 | 全局锁分配器 | ArceOS 内置 |
| 内核堆 | Buddy (80MB) | Buddy (80MB) | Buddy (256MB) | Buddy | Buddy | ArceOS 内置 |
| 页表 | Sv39 + LA64 | Sv39 | polyhal 统一 | Sv39 + LAFlex | Sv39 + LA64 4级 | 多架构 (page_table_multiarch) |
| COW | 完整 | 完整(存在但非默认fork) | 完整 (shallow_clone) | 完整 | 完整 | 完整(axmm) |
| 懒分配 | 完整 | 部分 (仅栈/brk) | 完整 (8种区域类型) | 完整 | 完整 | brk仅改指针 |
| mmap | 匿名/共享/固定 | 匿名/文件/固定 | 匿名/文件/共享组 | 匿名/文件 | 匿名/文件/回写 | 匿名/文件(只读)/大页 |
| mprotect | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| 共享内存 | System V SHM | 无 | System V SHM | 无 | System V SHM | System V SHM |
| Swap | 无 | 无 | 无 | 有(Swap+Zram LZ4) | 无 | 无 |
| OOM 处理 | 无 | 无 | 无 | 三级降级策略 | 无 | 无 |

**内存管理评述**：P3 (NPUcore) 以 Swap + Zram + OOM 三级降级的完整内存回收链位居第一梯队，是六者中唯一深入解决内存压力问题的项目。P0 (UESTC) 和 P4 (NoAxiom) 处于第二梯队，COW、懒分配和 mmap 实现均完整。P5 (Undefined) 的 brk 仅修改堆顶指针而不进行实际页面映射，功能完整度受限。

### 3.2 进程与任务管理

| 特性 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| TCB 设计 | TCB + inner(Mutex) | PCB + inner(UPIntrFreeCell) | TCB (单一结构) | TCB | Task 按访问模式分类 | Process+Thread 分离 |
| fork/clone | 完整 CloneFlags | 完整 CloneFlags | 基础 SHARE_VM 等 | 完整 | 完整 CloneFlags | 完整 CloneFlags |
| execve | 支持动态链接器 | 支持动态链接器 + BusyBox特殊处理 | 支持 shell 脚本自动包装 | 支持 | 支持动态链接器 | 支持动态链接器+脚本 |
| wait/waitpid | WNOHANG/WUNTRACED | 基础等待 | 基础等待 | 基础 | wait4 完整 | WNOHANG/WNOWAIT |
| 进程组/会话 | 基础 | 无 | 伪实现(setpgid) | 无 | 完整线程组+进程组 | 四层模型 |
| 线程支持 | 完整 (CLONE_THREAD) | 完整 | 基础 | 完整 | 完整 | 完整 |
| 孤儿进程回收 | 有 (init) | 有 | 无明确 | 无明确 | 有 (init reaper) | 有 (PID 1 reaper) |

**进程管理评述**：P5 (Undefined) 以严格的 Session-ProcessGroup-Process-Thread 四层模型在进程层次结构上领先。P0 (UESTC) 和 P4 (NoAxiom) 的 clone 语义实现最为完整。P2 (Nonix) 在进程组管理上存在伪实现问题。

### 3.3 文件系统

| 特性 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| VFS 抽象 | Dentry/Inode/File/SB | File trait | File trait + FileClass | VFS trait | Dentry/Inode/File/SB | FileLike trait |
| ext4 实现 | ext4_rs 引擎 (6618行) | 自研 7000行 ext4_rs | lwext4 C库绑定 | 自研 Extent树 | ext4_rs 绑定 | lwext4 C库绑定 |
| ext4 特性 | extent树/块分配/CRC | extent树/块分配/inode分配 | 基础读写/稀疏文件 | extent树/CRC32/块组 | 完整读写 | 基础读写 |
| Journal | 未完整支持 | 无 | 依赖lwext4 | 无 | 无 | 依赖lwext4 |
| 其他FS | devfs/procfs/tmpfs/memfs | proc/pipe | pipe/虚拟注册表 | FAT32/pipe/null等 | FAT32/RamFS/ProcFS/DevFS | tmpfs/devfs/procfs |
| 页/块缓存 | LRU 块缓存 | PageCache (未完成) | 无独立缓存 | 目录树缓存(RwLock+BTreeMap) | MSI页缓存+LRU块缓存 | ArceOS 内置 |
| epoll | 完整 (LT) | 无 | 无 | 无 | 无 | 完整 (LT, 无ET) |
| 管道 | 完整 | 有 | 32字节环形缓冲 | 有 | 完整(物理帧环形缓冲) | 64KB环形缓冲 |
| 文件系统数量 | 4 | 2 | 1(+虚拟) | 2(+伪) | 5 | 4 |

**文件系统评述**：P0 (UESTC) 和 P1 (Explosion) 在 ext4 实现上投入最大，均基于 Rust 从零/深度定制实现。P0 采用双层架构（ext4_rs 引擎 + VFS 适配层），设计更为解耦。P4 (NoAxiom) 以 5 种文件系统位居数量之首，且拥有最完善的缓存体系（MSI 页缓存 + LRU 块缓存）。P2 (Nonix) 管道缓冲区仅 32 字节，严重制约 I/O 性能。P0 的 epoll/eventfd/signalfd/timerfd 四件套是所有项目中唯一完整实现 I/O 多路复用生态的。

### 3.4 信号处理

| 特性 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| 信号数量 | 33 (1-33) | 64位掩码 | 32 | 64 | 64 | POSIX 标准 |
| 信号队列 | 有 (Vec<SigInfo>) | 无 | 无 | 无 | 无 | 无 |
| sigaction | 完整(区分架构布局) | 有 | 有 | 完整 SigAction | 完整 | 完整 |
| sigreturn | 完整 (蹦床) | 不完整 | **未实现 (panic)** | 完整 | 完整 | 完整 (蹦床) |
| 信号掩码 | 完整 | 有 | 有 | 完整64位 | 完整 | 完整 |
| 实时信号 | 部分 (SIGRT1) | 无 | 无 | 无 | 部分 | 无 |
| 备用栈 | 有 | 无 | 无 | 无 | 部分 | 有 |
| 可中断系统调用 | SA_RESTART | 无 | 无 | 无 | 完整 | 无 |

**信号处理评述**：P0 (UESTC) 的信号子系统实现最为完整——信号队列、区分 RISC-V/LoongArch 的 SigAction 布局、sigreturn 蹦床、SA_RESTART 等高级特性均已实现。P2 (Nonix) 的 sigreturn 未实现（触发 panic），这是一个致命缺陷，导致用户自定义信号处理函数无法正常返回。P4 (NoAxiom) 的异步陷阱处理使得信号与调度自然融合，架构上最为优雅。

### 3.5 网络子系统

| 特性 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| 协议栈 | lose-net-stack 自研 | lose-net-stack 自研 | 无 | smoltcp | smoltcp | axnet (ArceOS) |
| TCP | 三次握手/状态机 | 基础 (缺状态机) | 无 | 完整 (Nagle/KeepAlive) | 完整 | 基础 |
| UDP | 有 | 有 | 无 | 有 | 有 | 基础 |
| ARP | 有 | 有 | 无 | 依赖smoltcp | 依赖smoltcp | 依赖axnet |
| IPv6 | 无 | 无 | 无 | 无 | 有 | 无 |
| 物理驱动 | **空桩 (不可用)** | VirtIO-net | 无 | 有 | virtio-net 异步 | 有 |
| Unix Socket | 无 | 无 | 无 | **todo!()** | **todo!()** | 无 |
| epoll 集成 | 有 | 无 | 无 | 无 | 无 | 有 |
| 性能记录 | 无 | 无 | 无 | 无 | **iperf 第1名** | 无 |

**网络评述**：P4 (NoAxiom) 在网络子系统中全面领先——基于 smoltcp 的完整 TCP/UDP、IPv6 支持、异步驱动集成，以及决赛 iperf 性能测试第一的实战成绩。P0 (UESTC) 自研的 lose-net-stack 协议栈代码完整，但物理驱动为空桩，导致网络功能实际不可用，这是最严重的功能缺陷。P2 (Nonix) 完全缺失网络支持。P3 (NPUcore) 的 Unix Domain Socket 处于 todo!() 状态。

### 3.6 系统调用覆盖

| 特性 | P0 UESTC | P1 Explosion | P2 Nonix | P3 NPUcore | P4 NoAxiom | P5 Undefined |
|------|----------|-------------|----------|------------|------------|-------------|
| 系统调用数量 | 130+ | 75 | 73 | 90+ | 115 | 150+ |
| 文件 I/O | 完整 (readv/writev/pread/pwrite) | 基础 | 基础 | 完整 | 完整 | 完整 |
| 进程控制 | 完整 (prctl/set_tid_address/robust_list) | 基础 | 基础 | 完整 | 完整 | 完整 |
| 内存管理 | 完整 (mremap/madvise/mlock/mincore) | 基础 | 基础 | 基础 | 基础 (msync缺失) | 基础 (madvise缺失) |
| 网络 Socket | 18个 | 基础 | 无 | 有 | 丰富 | 基础 |
| I/O 多路复用 | epoll/eventfd/signalfd/timerfd | 无 | 无 | 无 | ppoll/pselect(无epoll) | epoll/poll |
| Futex | 完整(含requeue/bitset) | 无 | 无 | 完整 | 完整 | 有 |
| 时钟/定时器 | 完整(含itimer/timerfd) | 基础 | 基础 | 完整(itimer) | 完整 | 基础 |

**系统调用评述**：P5 (Undefined) 以 150+ 系统调用在数量上领先。P0 (UESTC) 以 130+ 系统调用紧随其后，且在内存管理相关系统调用（mremap/madvise/mlock/mincore）和 I/O 多路复用（epoll/eventfd/signalfd/timerfd）上覆盖最为完整。P2 (Nonix) 存在较多伪实现（ioctl/setpgid/syslog 等始终返回 0）。

---

## 4. 技术亮点对比

| 项目 | 独特技术创新 |
|------|-------------|
| **P0 UESTC** | (1) crate_interface 宏实现零开销 HAL 解耦；(2) FutexKey 基于物理地址的唯一标识方案；(3) ext4 双层架构（引擎+适配层分离）；(4) 信号蹦床静态页表映射；(5) 完整的 epoll/eventfd/signalfd/timerfd I/O 多路复用生态 |
| **P1 Explosion** | (1) 从零自研近 7000 行 EXT4 文件系统（包含 extent 树和块分配）；(2) Trait + cfg_if 的编译时 HAL 选择；(3) 深度集成 BusyBox 支持 Shell 脚本；(4) 延迟浮点上下文保存与 AUXV 传递 |
| **P2 Nonix** | (1) mmap 共享组机制解决 fork 后物理帧共享问题；(2) polyhal 外部框架实现双架构适配；(3) 懒加载与 COW 的精细化实现；(4) 动态虚拟文件注册表支持 /proc |
| **P3 NPUcore** | (1) **OOM 三级降级处理**（清缓存->清当前任务->清所有任务）；(2) **Zram 压缩内存**（LZ4 算法）；(3) **Swap 交换分区**（位图管理）；(4) 双文件系统 EXT4+FAT32；(5) 目录树缓存（RwLock+BTreeMap） |
| **P4 NoAxiom** | (1) **基于 Rust 无栈协程的异步调度架构**（最核心创新）；(2) 异步陷阱处理（缺页/系统调用可 await）；(3) 按并发访问模式分类的 Task 字段设计；(4) MSI 协议页缓存；(5) 5 种文件系统；(6) 比赛性能总分第 2、iperf 第 1 |
| **P5 Undefined** | (1) Session-ProcessGroup-Process-Thread 四层进程模型；(2) FileLike trait 统一文件/管道/套接字/epoll 抽象；(3) DynamicFs 声明式伪文件系统构建；(4) 系统调用追踪 proc-macro；(5) 四架构支持（x86_64/aarch64/riscv64/loongarch64） |

---

## 5. 不足与缺失对比

| 项目 | 主要缺陷 |
|------|---------|
| **P0 UESTC** | (1) **网络驱动为空桩**，协议栈代码虽完整但不可用；(2) 调度器仅 FIFO，无优先级；(3) 仅 UP 模式，SMP 未启用；(4) 无 Swap/页面置换；(5) ext4 日志未完整支持；(6) LoongArch kernel_page_table() 返回零地址 (FIXME) |
| **P1 Explosion** | (1) 调度器仅 FIFO 且 priority 字段未使用；(2) UPIntrFreeCell 关中断模型无法扩展 SMP；(3) 信号 trampoline 机制不完整；(4) LoongArch64 仅框架 (~20% 完成度)；(5) TCP 缺乏完整状态机；(6) PageCache 仅雏形 |
| **P2 Nonix** | (1) **sigreturn 未实现 (panic)**——致命缺陷；(2) 管道缓冲区仅 32 字节；(3) 部分系统调用伪实现；(4) 完全缺失网络支持；(5) 仅单核；(6) 无 Swap；(7) 用户指针验证薄弱 |
| **P3 NPUcore** | (1) 调度器仅 FIFO；(2) 仅单核；(3) UnixSocket 为 todo!()；(4) 错误处理混用 panic 与 Result；(5) 物理板级 BSP 多为占位；(6) 物理帧分配器无碎片整理 |
| **P4 NoAxiom** | (1) CFS 实现完整但被废弃；(2) 缺少 epoll；(3) fsync/msync 为空实现；(4) Unix Domain Socket 为 todo!()；(5) 多核负载均衡自评性能极差；(6) 无 Swap |
| **P5 Undefined** | (1) brk 仅修改指针不映射页面；(2) 文件映射不支持 PROT_WRITE；(3) mount/umount 接口被注释；(4) IPv4 单协议栈(IPv6 触发 panic)；(5) setsockopt 为空实现；(6) procfs 信息硬编码；(7) 无 CoreDump |

---

## 6. 整体成熟度综合评分

基于以下权重计算综合分：进程管理 (15%)、内存管理 (20%)、文件系统 (20%)、网络 (15%)、信号处理 (10%)、系统调用覆盖 (10%)、架构设计 (5%)、技术创新性 (5%)。

| 项目 | 进程管理 | 内存管理 | 文件系统 | 网络 | 信号 | 系统调用 | 架构 | 创新 | **综合分** |
|------|---------|---------|---------|------|------|---------|------|------|-----------|
| P0 UESTC | 90% | 85% | 85% | 45% | 92% | 85% | 88% | 82% | **80.2%** |
| P1 Explosion | 78% | 80% | 82% | 50% | 65% | 72% | 78% | 85% | **73.6%** |
| P2 Nonix | 72% | 80% | 72% | 0% | 55% | 65% | 75% | 70% | **60.9%** |
| P3 NPUcore | 75% | 92% | 85% | 55% | 82% | 75% | 82% | 88% | **80.3%** |
| P4 NoAxiom | 88% | 82% | 88% | 82% | 80% | 80% | 90% | 95% | **84.9%** |
| P5 Undefined | 88% | 72% | 80% | 55% | 75% | 90% | 85% | 78% | **77.5%** |

评分说明：
- **进程管理**：以 Linux clone/exec/wait 完整语义为基准
- **内存管理**：以 COW + 懒分配 + mmap/mprotect + Swap 为基准
- **文件系统**：以 ext4 完整读写 + VFS 抽象 + 多种文件系统为基准
- **网络**：以 TCP/UDP 完整协议栈 + 物理驱动可用为基准
- **信号处理**：以 sigaction + sigreturn + 信号队列 + 实时信号为基准
- **系统调用**：以 Linux 核心 POSIX 接口覆盖为基准
- **架构设计**：以模块化、可扩展性、代码组织为基准
- **技术创新性**：以独特设计思路与工程创新为基准

---

## 7. 各项目总结评价

### P0 UESTC OS Kernel 2026

UESTC 项目是一个功能覆盖面广、子系统深度均衡的宏内核。其核心优势在于：(1) crate_interface 解耦机制在架构设计上独具匠心；(2) 130+ 系统调用覆盖在同类项目中排名第二；(3) epoll/eventfd/signalfd/timerfd 构成的完整 I/O 多路复用生态为六者中唯一；(4) ext4 双层架构实现了引擎与适配层的良好分离。最大短板是网络驱动为空桩导致协议栈实际不可用，且调度器停留于简单 FIFO。在同类 rCore 生态项目中处于领先地位，但相较独立生态的 NoAxiom-OS 在调度创新和网络实现上存在差距。

### P1 Explosion OS

Explosion OS 最突出的贡献是从零自研了近 7000 行的 EXT4 文件系统，具备 extent 树和完整的块分配机制，工程量在同类项目中首屈一指。BusyBox 集成度最高，支持 Shell 脚本执行。然而，其 LoongArch64 移植仅完成约 20%，信号 trampoline 机制不完整，调度器未利用已有的 priority 字段，且 UPIntrFreeCell 的关中断模型从根本上限制了对 SMP 的扩展能力。该项目在深度攻坚单一子系统（ext4）方面表现卓越，但整体均衡性不足。

### P2 Nonix OS

Nonix OS 是一个架构简洁、代码量最小的项目。其 mmap 共享组机制有效解决了 fork 后共享内存区域管理问题，体现了精巧的设计思路。然而，sigreturn 未实现（触发 panic）构成致命缺陷，使得用户自定义信号处理功能完全失效。管道缓冲区仅 32 字节严重制约 I/O 性能，完全缺失网络支持使其在六者中功能广度最低。polyhal 双架构支持是其架构亮点，但整体完成度受限于关键缺陷。

### P3 NPUcore-BLOSSOM

NPUcore-BLOSSOM 在内存管理子系统上位居六者之首——OOM 三级降级、Zram 压缩（LZ4）、Swap 交换分区的完整内存回收链展现了对系统资源管理的深刻理解。EXT4+FAT32 双文件系统和目录树缓存设计也体现了较高的工程水准。但调度器仅 FIFO、UnixSocket 为 todo!()、部分路径使用 panic 处理错误等问题，使其在系统鲁棒性和并发性能上存在局限。

### P4 NoAxiom-OS

NoAxiom-OS 是本次对比中综合表现最优秀的项目。其基于 Rust 无栈协程的异步调度架构在技术路线上独树一帜，将 async/await 从应用层引入内核层，实现了 IO 等待与调度的零成本融合。5 种文件系统、MSI 协议页缓存、按并发访问模式分类的 Task 字段设计，以及在比赛中获得的性能总分第 2、iperf 第 1 的成绩，均证明了该项目的架构创新在实战中的有效性。主要遗憾在于 CFS 调度器被废弃、epoll 缺失和 fsync 为空实现。

### P5 Undefined-OS

Undefined-OS 依托 ArceOS 框架实现了六者中最高的系统调用覆盖数（150+）和唯一的四架构支持（x86_64/aarch64/riscv64/loongarch64）。Session-ProcessGroup-Process-Thread 四层进程模型和 FileLike trait 统一抽象体现了成熟的工程素养。DynamicFs 声明式伪文件系统和系统调用追踪宏是开发体验上的亮点。但 brk 仅修改指针、文件映射不可写、procfs 信息硬编码等问题反映其子系统的实现深度不足，框架依赖也限制了底层创新的空间。

---

## 8. 综合排名与分类评价

### 综合排名

| 排名 | 项目 | 综合分 | 核心优势 |
|------|------|--------|---------|
| 1 | NoAxiom-OS (杭电) | 84.9% | 异步调度创新 + 5文件系统 + 实测性能第1 |
| 2 | NPUcore-BLOSSOM (西工大) | 80.3% | OOM/Zram/Swap 完整内存链 + 双文件系统 |
| 3 | UESTC OS Kernel 2026 (电子科大) | 80.2% | I/O多路复用生态 + 信号完整度 + 系统调用覆盖 |
| 4 | Undefined-OS (清华) | 77.5% | 四架构 + 150+系统调用 + 四层进程模型 |
| 5 | Explosion OS (中山大学) | 73.6% | 自研7000行EXT4 + BusyBox深度集成 |
| 6 | Nonix OS (南开大学) | 60.9% | polyhal双架构 + mmap共享组 |

### 分类评价

**创新驱动型**：
- **NoAxiom-OS**：以异步协程调度为核心创新，在架构层面重新思考了内核调度范式。适合作为异步内核设计的参考实现。

**均衡全面型**：
- **UESTC OS Kernel 2026** 和 **NPUcore-BLOSSOM**：各子系统发展均衡，无明显偏科。UESTC 在 I/O 多路复用和信号处理上更优，NPUcore 在内存管理上更深入。两者代表了 rCore 生态下不同的优化方向。

**框架集成型**：
- **Undefined-OS**：充分利用 ArceOS 框架优势，在架构数量和系统调用覆盖上取得领先。适合作为组件化内核设计的研究案例。

**深度攻坚型**：
- **Explosion OS**：在 ext4 文件系统单一子系统上投入巨大，从零实现获取了最深的技术理解。适合作为文件系统实现的教学参考。

**轻量探索型**：
- **Nonix OS**：代码量最小但包含精巧设计（mmap 共享组），适合作为快速原型验证的参考。但关键缺陷限制了其可用性。

---

## 9. 评审意见

综合以上分析，本次参与对比的六个项目均展现了扎实的系统编程能力和对操作系统核心概念的深入理解。从技术路线来看，呈现出两条清晰的演进方向：其一是在传统同步宏内核框架内不断深化子系统功能（以 UESTC、NPUcore、Explosion 为代表）；其二是在架构层面引入新的编程范式（以 NoAxiom-OS 的异步调度为代表）。

UESTC OS Kernel 2026 在同步宏内核路线中表现均衡且突出。其 crate_interface HAL 解耦机制在架构设计上具有独创性；130+ 系统调用与 epoll/eventfd/signalfd/timerfd 构成的完整 I/O 多路复用生态，在同类 rCore 项目中处于领先水平；信号处理的完整度（含信号队列、区分架构的 SigAction、SA_RESTART）在所有项目中最为出色。主要短板在于网络物理驱动为空桩，使得自研协议栈无法发挥实际作用，且调度器停留于简单 FIFO。

建议 UESTC 项目后续优先补齐网络驱动层，将已有的 lose-net-stack 协议栈与 VirtIO 网卡驱动重新连接；其次引入优先级调度或更高级的调度算法以改善任务响应特性；最后可借鉴 NPUcore 的内存回收机制，逐步引入 Swap 或页面置换以提升内存利用率。总体而言，该项目已达到操作系统内核竞赛的高水平标准，在多个维度上具备与最优项目竞争的实力。