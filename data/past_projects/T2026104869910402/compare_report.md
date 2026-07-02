# 对比分析报告

## 一、对比项目概述

| 项目 | 语言 | 架构 | 内核类型 | 生态来源 | 代码规模 |
|---|---|---|---|---|---|
| **StellaOS** (本项目) | Rust | riscv64, loongarch64 | 宏内核 | rCore + polyhal | ~47,000 行 |
| 小混子队 (合工大) | C | riscv64 | 宏内核 | xv6 | 内核镜像 ~333KB |
| ByteOS (河科大) | Rust | riscv64, x86_64, aarch64, loongarch64 | 宏内核 | 自研 + polyhal | 内核镜像 ~669KB |
| AronaOS (哈工大) | Rust | riscv64 | 宏内核 | rCore | ~15,700 行 |
| NPUcore-BLOSSOM (西工大) | Rust | riscv64, loongarch64 | 宏内核 | 自研 | ~36,000 行 |
| ChaOS (北科大) | Rust | riscv64 | 宏内核 | rCore | ~12,917 行 |

---

## 二、架构设计对比

| 维度 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| **分层清晰度** | 高。VFS/HAL/驱动/内存/进程五层分明，模块边界明确 | 中。xv6 原有结构基础上扩展，部分模块耦合度高 | 高。polyhal 为 HAL 核心，executor/fs/devices 模块化清晰 | 高。rCore 继承的分层结构保持良好 | 高。hal/arch/platform 三层 HAL，自研模块划分清晰 | 中。rCore 结构衍生，但部分子系统未充分展开 |
| **模块化程度** | 优良。ksync crate 独立解耦，filesystem crate 独立为子项目 | 一般。C 语言单体仓库，头文件依赖网复杂 | 优良。多个独立 crate (executor, polyhal, fs, devices) | 良好。ext4 独立为子 crate | 优良。hal/mm/task/fs/net 独立模块 | 一般。单 crate 内模块划分 |
| **跨架构设计** | 双架构 (RISC-V + LoongArch)，polyhal 桥接 | 单架构 (RISC-V) | 四架构 (RISC-V + x86_64 + AArch64 + LoongArch)，polyhal 桥接 | 单架构 (RISC-V) | 双架构 (RISC-V + LoongArch)，自研 HAL | 单架构 (RISC-V)，双平台 (QEMU+VF2) |
| **并发模型** | 同步抢占式，关中断互斥 (UPIntrFreeCell)，FIFO+时间片 | 同步抢占式，自旋锁，轮转调度 | 异步协作式，Rust Future/Waker，FIFO 任务队列 | 异步协作式，无栈协程，async-task | 同步抢占式，FIFO (stride 调度已预留) | 同步抢占式，FIFO (stride 调度注释未启用) |
| **同步原语设计** | 完整。Mutex/ Condvar/ Semaphore/ Futex/ Eventfd，原子 wait_with_mutex | 基础。自旋锁 + 睡眠/唤醒，无 futex | 基础。Mutex，无独立 condvar/semaphore 层 | 基础。SpinNoIrqLock，无 futex | 完整。Mutex/ Condvar/ Semaphore/ Futex | 基础。自旋锁风格，同步原语较少 |

**分析**：StellaOS 在架构设计上处于第一梯队。其分层清晰度与 NPUcore-BLOSSOM 相当，模块化程度（独立 ksync crate 解耦同步原语）优于多数项目。跨架构方面 ByteOS 以四架构领先，StellaOS 与 NPUcore-BLOSSOM 以双架构紧随其后。StellaOS 的同步原语设计是六个项目中最完善的——futex 的 WAIT/WAKE/REQUEUE/CMP_REQUEUE 四种操作全部实现且竞态安全，这一点显著优于其余项目。

---

## 三、子系统实现深度对比

### 3.1 内存管理

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| 页表机制 | Sv39 + LoongArch | Sv39 | 多架构页表 | Sv39 | Sv39 + LoongArch LAFlex | Sv39 |
| COW Fork | 完整 (帧级引用计数) | 未实现 | 完整 (Arc 引用计数) | 完整 (Arc 引用计数，懒分配未实现) | 完整 (Frame 状态枚举) | 部分实现 |
| mmap/munmap | 完整 (含 MAP_SHARED/PRIVATE/FIXED) | 未实现 | 部分实现 | 部分 (MAP_FIXED 不支持) | 完整 | 基本实现 |
| mprotect/mremap | 完整 | 未实现 | 未提及 | mprotect 标注未完成 | 完整 | 未提及 |
| 缺页处理 | 两阶段设计 (锁内判断+锁外 I/O) | 基础 | 单阶段 | 单阶段 | 单阶段 | 基础 |
| SHM (SysV) | 完整 (含 attach 两阶段) | 未实现 | 部分 | 未提及 | 部分 | 未实现 |
| Swap | 未实现 | 未实现 | 未实现 | 未实现 | 完整 (含 Zram LZ4 压缩) | 未实现 |
| OOM 处理 | 无 (分配失败直接返回错误) | 无 | 无 | 无 | 多级 OOM (缓存清理→进程回收) | 无 |
| TLS 支持 | 完整 | 未提及 | 部分 | 部分 | 完整 | 未提及 |

**分析**：StellaOS 的内存管理在 COW、mmap 系列、SHM、缺页处理方面达到六个项目中的最优水平。两阶段缺页处理设计是独有的工程创新。但 NPUcore-BLOSSOM 在 Swap/Zram/OOM 方面领先——这些是 StellaOS 的明确短板。

### 3.2 进程与任务管理

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| 进程/线程模型 | 分离 (PCB+TCB) | 分离 (proc+thread) | 分离 (PCB+TCB) | 分离 (Process+Thread) | 分离 | 统一 TCB 模型 |
| fork 实现 | 完整 COW fork | 完整 (uvmcopy) | 完整 COW fork | 完整 COW fork | 完整 COW fork | 完整 |
| clone 标志 | 完整 (CLONE_VM/FILES/VFORK/THREAD/SETTLS 等) | 基础 (CLONE_VM) | 完整 | 基础 (线程创建) | 完整 | 完整 |
| exec 实现 | 完整 (shebang 递归/PT_INTERP/ENOEXEC 回退) | 完整 (ELF+辅助向量) | 部分 | 完整 (含 auxv) | 完整 | 完整 (含 auxv) |
| 进程组/会话 | 完整 (pgid/sid) | 基础 (pgid) | 未提及 | 基础 (pgid) | 完整 | 未提及 |
| 凭据管理 | 完整 (uid/euid/gid/egid/setresuid 等) | 基础 (uid/gid) | 未提及 | 未提及 | 完整 | 基础 (仅 getuid/geteuid 等) |
| 资源限制 | 完整 (rlimit/prlimit) | 未实现 | 部分 (rlimits Vec) | 未实现 | 完整 | 未实现 |
| CPU 时间统计 | 完整 (utime/stime，rusage) | 未提及 | 部分 (TMS) | 未提及 | 完整 | 基础 (user_clock/kernel_clock) |
| 多核支持 | 未实现 (UP 设计) | 部分 (SMP=2，但有 proc alloc failed) | 部分 (多核框架存在) | 未实现 (仅 hart 0 调度) | 部分 | 未实现 |

**分析**：StellaOS 的进程管理在 exec 实现（shebang 递归、动态链接器加载、ENOEXEC 回退）、凭据管理、资源限制方面最为完善。小混子队的 NPROC=64 限制和 "proc alloc failed" 错误暴露了资源管理的严重缺陷。多核支持是所有项目的共同短板。

### 3.3 文件系统

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| VFS 抽象层 | 完整 (Dentry 树+Inode trait+InodeMeta 缓存) | 无 (直接文件系统操作) | 完整 (VFS 抽象层) | 基础 (File trait) | 完整 (目录树缓存) | 完整 (VFS 抽象层) |
| ext4 支持 | 完整 (读/写/创建/删除/重命名/截断/fallocate/符号链接/硬链接) | 基础 (读/写/创建/删除) | 未提及 (报告中无 ext4) | 完整 (独立开发，读/写/创建/删除) | 完整 (读/写/创建/删除/重命名) | 基础 (读/写/创建/删除) |
| FAT32/VFAT | 支持 | 未实现 | 支持 | 支持 | 支持 | 未实现 |
| ramfs/tmpfs | 支持 | 未实现 | 支持 (RAMFS) | 未提及 | 支持 | 未提及 |
| devfs/procfs | 支持 | 未实现 | 支持 | 支持 | 支持 | 部分 (devfs 存在) |
| 页缓存 | 统一页缓存 (fs_id 命名空间，LRU) | LRU 块缓存 (BCACHE) | 未提及 | 未提及 | 目录树缓存 | 未提及 |
| Dentry 缓存 | 完整 (LruCache，保留 Dirty/挂载点) | 无 | 未提及 | 无 | 目录树缓存 (功能相近) | 未提及 |
| Pipe/Eventfd | 完整 (64KB 环形缓冲/64位计数器) | 未实现 | 未提及 | Pipe 实现 | 完整 | Pipe 实现 |
| 文件锁 (flock) | 已定义 (实现可能不完整) | 未实现 | 未提及 | 未提及 | 完整 | 未提及 |
| ext4 Journal/xattr/ACL | 未实现 | 未实现 | 未提及 | 未实现 | 未实现 | 未实现 |

**分析**：StellaOS 的文件系统是六个项目中最完善的。ext4 支持覆盖了包括 fallocate、符号链接、硬链接在内的完整操作集。VFS 框架的 Dentry 树+Inode trait+InodeMeta 缓存三层设计在抽象性和效率之间取得了良好平衡。统一页缓存（块缓冲与文件数据共用同一 LRU）是独有的设计。小混子队在 xv6 上实现 ext4 值得肯定但深度不足；AronaOS 独立开发 ext4 展现了较强的实现能力但操作覆盖不如 StellaOS 完整。

### 3.4 信号子系统

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| 信号数量 | 64 (含实时信号) | 65 (含 SIGRT) | 65 | 基础 | 64 | 64 |
| sigaction | 完整 (含 SA_NODEFER/RESETHAND/RESTART/SIGINFO) | 完整 | 完整 | 完整 | 完整 | 部分 |
| sigprocmask | 完整 | 完整 (但有逻辑错误：SIGTERM 等不可屏蔽处理使用 &= 而非 |=) | 完整 | 完整 | 完整 | 完整 |
| sigaltstack | 完整 (SS_ONSTACK/SS_DISABLE/SS_AUTODISARM) | 未提及 | 未提及 | 未提及 | 完整 | 未提及 |
| sigtimedwait | 完整 | 未提及 | 未提及 | 未提及 | 完整 | 核心逻辑被注释，仅返回 SUCCESS |
| 进程级共享 pending | 完整 (所有线程屏蔽时降级到进程级) | 未实现 | 未提及 | 未实现 | 部分 | 未实现 |
| 信号帧布局 | 架构相关 (RISC-V GeneralRegs+FloatRegs，LoongArch 含 era) | 基础 | 未提及 | 基础 | 完整 | 未提及 |
| 实时信号队列 | 完整 (sigqueue) | 未提及 | 部分 | 未实现 | 部分 | 未提及 |

**分析**：StellaOS 的信号子系统是六个项目中实现深度最高的。进程级共享 pending 的降级交付策略、sigaltstack 的完整实现、架构相关的信号帧布局均为独有或最优。小混子队的 sigprocmask 存在明显的逻辑错误。ChaOS 的 sigtimedwait 实现为空壳。

### 3.5 同步与 IPC

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| Futex | 完整 (WAIT/WAKE/REQUEUE/CMP_REQUEUE，含 robust_list) | 未实现 | 基础 | 未实现 | 完整 | 未实现 |
| Eventfd | 完整 | 未实现 | 未提及 | 未实现 | 完整 | 未实现 |
| Mutex (内核态) | 完整 (Spin+Blocking 双模式，含死锁检测) | 自旋锁 | 基础 | SpinNoIrqLock | 完整 | 基础 |
| Condvar | 完整 (原子 wait_with_mutex) | 睡眠/唤醒 | 未提及 | 未提及 | 完整 | 未提及 |
| Semaphore | 完整 (计数信号量) | 未实现 | 未提及 | 未提及 | 完整 | 有 sem_* 系统调用 |
| SysV SEM | 完整 | 未实现 | 未提及 | 未实现 | 部分 | 未提及 |
| 消息队列 | 未实现 | 未实现 | 未提及 | 未实现 | 未实现 | 未实现 |

**分析**：StellaOS 与 NPUcore-BLOSSOM 在同步与 IPC 方面并列最优。StellaOS 的 condvar wait_with_mutex 原子设计（关中断窗口内完成解锁→入队→阻塞）是防止信号丢失的典范实现。小混子队、ByteOS、AronaOS、ChaOS 在 futex 上全部缺失，这是与 Linux 用户态程序兼容性的关键差距。

### 3.6 网络子系统

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| 协议栈位置 | 用户态 (lose-net-stack) | 未实现 | 用户态 (lose-net-stack) | 未实现 | 内核态 (基础) | 未实现 |
| TCP/UDP | 完整 | 未实现 | 完整 | 未实现 | 基础 | 未实现 |
| Socket API | 完整 (socket/bind/listen/accept/connect/sendto/recvfrom) | 未实现 | 完整 | 未实现 (仅有 socketpair) | 部分 | 未实现 |
| setsockopt/getsockopt | 完整 (含 SO_REUSEADDR/TCP_NODELAY/TCP_INFO 等) | 未实现 | 未提及 | 未实现 | 部分 | 未实现 |
| Loopback | 完整 (127.0.0.0/8 ARP 自应答+IPv4 环回) | 未实现 | 未提及 | 未实现 | 未提及 | 未实现 |
| epoll | 未实现 (ppoll/pselect6 替代) | 未实现 | 基础 (60% 完整度) | 未实现 | 部分 | 未实现 |
| IPv6 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |

**分析**：StellaOS 和 ByteOS 在网络上处于领先地位，两者都使用 lose-net-stack。StellaOS 在 setsockopt/getsockopt 覆盖面和 loopback 实现上更完整。但两者都将协议栈放在用户态，存在上下文切换开销的固有缺陷。NPUcore-BLOSSOM 将协议栈置于内核态但实现较为基础。

### 3.7 设备驱动

| 特性 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| virtio-blk | 完整 (非阻塞模式+Condvar 链式唤醒) | 基础 (virtio_mmio) | 完整 | 基础 | 完整 | 基础 |
| virtio-net | 完整 | 未实现 | 完整 | 未实现 | 基础 | 未实现 |
| virtio-gpu | 完整 | 未实现 | 未提及 | 未实现 | 未实现 | 未实现 |
| virtio-input | 完整 (键盘+鼠标) | 未实现 | 未提及 | 未实现 | 未实现 | 未实现 |
| UART | NS16550A | NS16550A | NS16550A | 基础 | 基础 | 基础 |
| 中断控制器 | PLIC (RISC-V) + PCH-PIC/EXTIOI/CPUINTC (LoongArch) | PLIC | PLIC | PLIC | PLIC | PLIC |
| 多平台支持 | QEMU virt (双架构) | QEMU virt | 多平台框架 | QEMU virt | QEMU + VisionFive2/Fu740/K210/2K1000 | QEMU + VisionFive2 |

**分析**：StellaOS 在设备驱动覆盖面上明显领先，是唯一实现 virtio-gpu 和 virtio-input 的项目。非阻塞 virtio-blk 的 Condvar 链式唤醒设计是独有亮点。NPUcore-BLOSSOM 的板级支持最广（6 种板级/平台），ChaOS 次之（QEMU + VF2）。

---

## 四、技术亮点与创新对比

### StellaOS 的核心亮点

1. **两阶段缺页处理**：锁内判断+锁外文件 I/O，避免 RefCell borrow 重入，在保持简洁性的同时解决了经典的锁内阻塞问题。
2. **condvar wait_with_mutex 原子性保证**：在关中断原子窗口中完成"解锁 mutex→入队 condvar→标记阻塞"三步，从根本上防止信号丢失。
3. **统一页缓存命名空间**：(fs_id, ino, pgoff) 三维 key，块缓冲 (fs_id=0) 和文件数据页共用 LRU，简化缓存逻辑。
4. **安全 virtio 设备探测**：`core::mem::forget(transport)` 防止 Drop 复位已初始化设备。
5. **双架构信号帧**：RISC-V (GeneralRegs+FloatRegs) 和 LoongArch (含 era 寄存器) 的架构相关布局。

### 各项目独特亮点

| 项目 | 最突出亮点 |
|---|---|
| 小混子队 | 在 xv6 (C语言) 上实现 ext4 文件系统和约 70 个 Linux 系统调用，从教学内核向实用化跨越的难度高于在 rCore 框架上扩展 |
| ByteOS | 四架构支持 (RISC-V/x86_64/AArch64/LoongArch) 是全部项目中跨架构覆盖最广的，polyhal 抽象层成熟度最高 |
| AronaOS | 独立开发 ext4 文件系统模块（非 fork 第三方库），展现了最强的文件系统实现能力；异步无栈协程的调度模型具有学术探索价值 |
| NPUcore-BLOSSOM | Zram 压缩内存+Swap 交换+多级 OOM 机制，是唯一实现完整内存压力处理链的项目，在资源受限场景下的鲁棒性设计理念领先 |
| ChaOS | TCB 统一模型 (pid==tid 为主线程) 简化了进程/线程管理逻辑；设备树 (DTB) 动态解析增强了硬件适配性 |

---

## 五、不足与缺失对比

### StellaOS 的主要不足

1. **单核限制**：UPIntrFreeCell 和所有同步设计基于 UP 单核假设，无法直接迁移到 SMP。
2. **无内存压力处理**：缺少 Swap、Zram、OOM killer 等机制，在内存耗尽时仅返回错误。
3. **网络栈在用户态**：lose-net-stack 作为用户态库运行，每包数据需经过内核-用户态上下文切换。
4. **无 epoll**：以 ppoll/pselect6 替代，缺少高性能 I/O 多路复用机制。
5. **ext4 写完整性**：`ext4_write_verify` feature 的存在暗示写数据一致性问题。
6. **LoongArch 覆盖不均**：GPU、输入设备在 LoongArch 路径中不活跃。

### 各项目主要缺陷总结

| 项目 | 关键缺陷 |
|---|---|
| 小混子队 | NPROC=64 导致进程表耗尽；编译警告超 40 处；iozone 基准测试结果硬编码伪造；sigprocmask 不可屏蔽信号处理逻辑错误；无 COW/无 mmap/无 futex；代码质量较低 (调试信息残留) |
| ByteOS | 缺少可用的文件系统镜像，无法验证运行时行为；无 ext4 支持的报告证据；epoll 仅 60% 完成度；协作式调度在 CPU 密集型场景下公平性不足；无 futex |
| AronaOS | 仅单架构 (RISC-V)；仅 hart 0 执行调度 (多核浪费)；无网络协议栈；mmap 不支持 MAP_FIXED；COW 懒分配未实现；futex 未实现；系统调用数量最少 (~55) |
| NPUcore-BLOSSOM | 网络子系统实现较基础；stride 调度器未启用 (实际仍为 FIFO)；部分高级特性 (Zram/OOM) 置于 feature gate 后，默认不启用；无 virtio-gpu/input 支持 |
| ChaOS | 帧回收逻辑被注释导致内存泄漏；sigtimedwait 核心逻辑为空壳；信号处理函数执行路径不完整；单架构；代码规模最小；无网络/无 futex/无 SHM |

---

## 六、测试与验证对比

| 维度 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| 测试套件数量 | 12 | 1 (busybox 内嵌) | 未知 (无法运行) | 基础 | 多个 (含 LTP) | 基础 |
| busybox | 支持 | 支持 (数十个命令) | 未验证 | 部分 | 支持 | 部分 |
| libc-test (musl) | 支持 | 不支持 | 未验证 | 不支持 | 支持 | 不支持 |
| LTP | 支持 | 不支持 | 未验证 | 不支持 | 支持 | 不支持 |
| 网络测试 (iperf/netperf) | 支持 | 不支持 | 未验证 | 不支持 | 未提及 | 不支持 |
| 性能基准 (unixbench/lmbench) | 支持 | 不支持 (iozone 数据被伪造) | 未验证 | 不支持 | 支持 | 不支持 |
| 实时性测试 (cyclictest) | 支持 | 标记成功但未实际执行 | 未验证 | 不支持 | 未提及 | 不支持 |
| 解释型语言 (Lua) | 支持 | 不支持 | 未验证 | 不支持 | 未提及 | 不支持 |
| 运行时验证状态 | 已通过构建，测试通过 | 部分通过 (存在 proc alloc 错误) | 构建通过但无法运行 (缺镜像) | 未完整验证 | 已验证 | 未完整验证 |

**分析**：StellaOS 的测试覆盖度在六个项目中最为全面，12 个测试套件涵盖了从基础功能 (basic/busybox)、C 库兼容性 (libctest/libcbench)、文件系统压力 (iozone)、网络性能 (iperf/netperf)、系统基准 (unixbench/lmbench) 到实时性 (cyclictest) 和标准符合性 (LTP) 的全方位验证。小混子队存在测试结果伪造问题，严重影响了可信度。ByteOS 因缺少文件系统镜像而无法进行任何运行时验证。

---

## 七、整体成熟度综合评分

以下评分基于竞赛内核的典型需求范围（POSIX 兼容性、Linux 用户态程序支持、子系统完整度、代码质量、测试覆盖），以 StellaOS 为基准 100 分进行相对评估：

| 评估维度 | StellaOS | 小混子队 | ByteOS | AronaOS | NPUcore-BLOSSOM | ChaOS |
|---|---|---|---|---|---|---|
| 架构设计 (15%) | 13 | 7 | 14 | 11 | 14 | 9 |
| 内存管理 (20%) | 17 | 8 | 14 | 12 | 19 | 10 |
| 进程管理 (15%) | 14 | 8 | 11 | 10 | 13 | 9 |
| 文件系统 (20%) | 19 | 10 | 12 | 14 | 17 | 11 |
| 信号/IPC/同步 (15%) | 14 | 6 | 8 | 6 | 12 | 5 |
| 网络/设备驱动 (10%) | 8 | 3 | 7 | 2 | 5 | 2 |
| 测试与验证 (5%) | 5 | 2 | 1 | 2 | 4 | 2 |
| **加权总分** | **14.55** | **6.85** | **10.85** | **9.55** | **13.70** | **7.80** |

**等级评定**：

| 等级 | 分数区间 | 项目 |
|---|---|---|
| A (优秀) | >= 13 | StellaOS (14.55), NPUcore-BLOSSOM (13.70) |
| B (良好) | 10-13 | ByteOS (10.85), AronaOS (9.55) |
| C (基本) | < 10 | ChaOS (7.80), 小混子队 (6.85) |

---

## 八、总结评价

### StellaOS (本项目)

StellaOS 是六个对比项目中综合成熟度最高的内核。其核心优势在于：**工程完备性突出**——168 个系统调用、6 种文件系统、双指令集架构、12 个测试套件的覆盖度在竞赛内核中处于领先水平；**实现深度扎实**——两阶段缺页处理、完整的 futex 子系统（四种操作+robust_list）、进程级信号降级交付、condvar 原子 wait 等设计体现了对操作系统核心机制的深入理解；**架构设计清晰**——VFS/HAL/驱动/内存/进程五层分离，ksync crate 独立解耦同步原语，模块边界明确。

主要短板在于单核限制、缺少内存压力处理机制（Swap/OOM）、用户态网络栈的性能瓶颈，以及 LoongArch 路径的部分模块覆盖不足。这些短板均属于向生产级内核演进时的高级特性范畴，在竞赛场景下是合理的取舍。

### 与各项目的比较定位

- **对比 NPUcore-BLOSSOM**：两者处于同一梯队且各有所长。NPUcore-BLOSSOM 在内存压力处理（Swap/Zram/OOM）、板级支持广度上领先；StellaOS 在文件系统深度、信号/IPC 完整度、futex 实现、测试覆盖上领先。两者可互为补充参考。
- **对比 ByteOS**：ByteOS 的跨架构覆盖（四架构）优于 StellaOS（双架构），异步调度模型具有技术差异化价值；但 StellaOS 在子系统实现深度、运行时验证、同步原语设计上全面领先。ByteOS 可作为跨架构扩展方向的参考。
- **对比 AronaOS**：AronaOS 的独立 ext4 开发能力和异步协程模型值得肯定，但在系统调用数量（55 vs 168）、网络支持、IPC 机制等方面与 StellaOS 差距显著。两者代表了 rCore 生态向不同方向（异步调度 vs POSIX 兼容）演进的两种路径。
- **对比 ChaOS**：ChaOS 的设备树解析和双平台支持有参考价值，但代码规模、子系统完整度、实现深度均与 StellaOS 存在较大差距。TCB 统一模型的设计理念可资借鉴。
- **对比小混子队**：小混子队在 xv6 (C语言) 上实现 ext4 和 busybox 支持展现了较强的底层改造能力，但代码质量（40+ 警告、调试信息残留、测试结果伪造）和子系统深度（无 COW、无 mmap、无 futex、NPROC 限制）与 Rust 项目群体存在代际差距。

### 综合评审意见

StellaOS 是一个在竞赛场景下表现优异的内核项目。其在有限的开发周期内完成了从教学内核（rCore-Tutorial-v3）向具备高度 Linux 兼容性的实用型内核的跨越，核心贡献在于：

1. 通过 polyhal 引入双架构能力，将单架构教学内核扩展为跨架构工程内核；
2. 实现了接近完整的 POSIX 系统调用集（168 个），覆盖进程、文件、信号、IPC、网络、时间等核心领域；
3. 构建了以 ext4 为核心的深度文件系统支持（含 VFS、页缓存、dentry cache），达到可运行复杂用户态工具链的水平；
4. 通过 12 个测试套件的系统验证，在功能正确性和稳定性方面建立了可信的证据链。

项目最值得称道的技术决策是将精力聚焦于"深度"而非"广度"——在关键子系统（文件系统、信号、futex）中追求接近完整而非浅尝辄止，这一策略在竞赛场景下取得了良好回报。建议后续发展方向：引入多核支持（将 UPIntrFreeCell 替换为真正的锁机制）、实现内存回收机制（Swap/OOM）、将网络协议栈移入内核态，以及补齐 LoongArch 路径的设备驱动覆盖。