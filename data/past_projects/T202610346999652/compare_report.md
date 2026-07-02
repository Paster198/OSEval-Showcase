# 对比分析报告

## 一、项目概览

本报告对六个操作系统内核项目进行多维度对比分析。其中 **TheKernel** (当前分析项目) 为核心参照系，其余五个为从竞赛项目库中选中的对比项目。

| 属性 | TheKernel (当前) | starry-next (燕山) | StarryX (杭电) | Undefined-OS (清华) | StarryOS (海南) | TOYOS (华东师范) |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **语言** | Rust | Rust | Rust | Rust | Rust | C |
| **生态** | ArceOS | ArceOS | ArceOS | ArceOS | ArceOS | 无(自研) |
| **内核类型** | 宏内核 | Unikernel/宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **架构数** | 4 | 4 | 4 (2主) | 4 | 4 | 1 (RISC-V) |
| **自有代码量** | ~67,694行 | ~5,750行 | ~22,800行 | 100+文件 | 中等规模 | ~16,858行(C) |
| **系统调用数** | 364分支 | ~99 | ~200 | ~150 | ~100+ | 55 |
| **整体成熟度** | 极高 | 中低 | 中高 | 中等 | 中等 | 中低 |

## 二、架构设计对比

| 维度 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|-----------|-------------|---------|--------------|----------------|-------|
| **分层方式** | 四层 (入口/核心/syscall/third_party) | 三层 (API/Core/ArceOS) | 三层 (API/Core/Module) | 六 workspace crate | 三层 (API/Core/ArceOS) | 单体分层 (boot/dev/fs/mm/proc) |
| **模块化程度** | 极高，9子系统+22 patched crates | 较高，43文件清晰划分 | 极高，167文件6子crate | 高，6 workspace crate | 中等 | 中等，10子系统 |
| **进程模型** | ProcessData+Thread双核心，5种namespace | TaskExt->Thread->Process三层 | XProcess+XThread，进程组/会话 | Session->PG->Process->Thread四层 | Process+Thread，Arc/Weak | 简单PCB，单线程，64进程上限 |
| **地址空间模型** | 4种Backend多态(Linear/COW/Shared/File) | 基础映射+SHM | VMA+LRU页缓存 | 基础映射+SHM | COW(特性门控)+大页 | SV39基础映射 |
| **调度器** | CFS (axsched) | ArceOS基础调度 | ArceOS基础调度 | ArceOS基础调度 | ArceOS基础调度 | 简单轮转(无优先级) |
| **跨架构设计** | 独立config，RISC-V/LoongArch完善 | 统一HAL，四架构 | 统一HAL，RISCV/LoongArch为主 | 多架构页表适配 | 统一HAL，四架构 | 单架构(RISC-V) |

### 架构设计评价

- **TheKernel**: 四层架构最清晰，子系统间交互追踪明确。`enum_dispatch` 内存后端多态和 scope-local FD_TABLE 展示了深入的工程优化思维。命名空间实现（5种）和独立页表信号跳板设计处于所有项目最高水平。
- **starry-next**: 以最少代码量(~5750行)实现四架构支持，展示了 ArceOS 复用效率的极限。但 Unikernel 用户程序嵌入方式极大限制了通用性。
- **StarryX**: 三层分离最彻底，`xmodules/` 层将 VMA、页缓存、信号等独立为可复用子 crate，模块化设计最为规范。
- **Undefined-OS**: 四层进程模型(Session/ProcessGroup/Process/Thread)最为严格地映射了 POSIX 标准，`DynamicFs` Builder 模式构建伪文件系统设计优雅。
- **StarryOS (海南)**: 架构与 TheKernel 同源(均基于 starry-next)，但实现深度和广度差距明显。
- **TOYOS**: 唯一纯C自研项目，无外部生态依赖，所有驱动和子系统从零编写。Trampoline 机制和 VFS 函数指针表设计简洁有效，但在架构抽象层次和代码复用方面与 Rust+ArceOS 项目存在代际差距。

## 三、子系统实现深度对比

### 3.1 进程管理

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| clone/fork/execve/exit/wait | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| 多线程(CLONE_THREAD) | 完整 | 完整 | 完整 | 完整 | 完整 | 不支持 |
| 进程组/会话 | 完整 | 部分(setsid占位) | 完整 | 完整(PG+Session) | 占位 | 不支持 |
| 命名空间 | 5种(Cgroup/PID/User/UTS/Time) | AxNamespace基础 | Thread-local | AxNamespace基础 | AxNamespace基础 | 无 |
| ptrace | 部分实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| coredump | 完整(ELF格式) | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| 作业控制 | 完整(stop/continue状态机) | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| robust futex | 完整 | 基础 | 完整 | 基础 | 基础 | 无futex |

### 3.2 内存管理

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| mmap/munmap/mprotect | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| 写时复制(COW) | 完整(引用计数) | 未实现(全量复制) | 完整(LRU页缓存) | 依赖ArceOS axmm | 特性门控 | 未实现(全量复制) |
| 大页(2M/1G) | 支持 | 支持 | 支持 | 支持 | 支持 | 不支持 |
| 按需分页 | 完整 | 基础 | 完整(VMA按需) | 基础 | 基础 | 不支持(无缺页处理) |
| mlock/madvise | mlock完整,madvise存根 | 未实现 | madvise存根 | 未实现 | 未实现 | 未实现 |
| 页缓存 | 通过ext4 | 无 | LRU淘汰+脏页回写 | 无独立页缓存 | 无 | 30节点LRU缓冲 |
| brk | 完整动态管理 | 预分配64KB | 完整动态 | 预分配 | 简化 | 预分配 |
| 共享内存 | System V完整 | System V完整 | System V完整 | System V完整 | System V完整 | 未实现 |
| mremap | 完整 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |

### 3.3 文件系统

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| VFS抽象 | FileLike trait完整 | FileLike trait | FileLike trait | FileLike trait | FilesystemOps trait | FS_OP_t函数指针表 |
| ext4 | lwext4_rust | 依赖ArceOS | lwext4_rust | lwext4_rust(C绑定) | lwext4 | 自研Extent树 |
| FAT32 | 不支持 | 不支持 | 支持 | 不支持 | 不支持 | 自研完整实现 |
| tmpfs | 完整(基于页面) | 无 | 完整 | 基础 | 基础 | 无 |
| devfs | 丰富设备节点 | 基础 | 基础 | Builder构建 | 基础 | 无独立devfs |
| procfs | 丰富(含per-process) | 仅/proc/self/exe | 完整(含per-process) | 两套实现,大量硬编码 | 硬编码静态 | 无 |
| sysfs/cgroupfs | 完整实现 | 无 | 无 | 无 | 无 | 无 |
| 管道 | 894行完整实现(O_DIRECT) | 256B环形缓冲 | 64KB环形缓冲 | 64KB环形缓冲 | 基础 | 基础 |
| io_uring | 完整(380行) | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| 文件锁(flock/fcntl) | 完整(653行+死锁检测) | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| 文件租约(lease) | 完整(324行) | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| 权限检查 | 完整(capabilities+uid/gid) | 缺失 | 基础 | 硬编码uid=1000 | 基础 | 基础 |

### 3.4 特殊文件类型覆盖

这是 TheKernel 最显著的领先维度：

| 文件类型 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| eventfd | 有 | 无 | 无 | 无 | 无 | 无 |
| timerfd | 有 | 无 | 无 | 无 | 无 | 无 |
| signalfd | 有 | 无 | 无 | 无 | 无 | 无 |
| memfd | 有 | 无 | 有 | 有 | 无 | 无 |
| pidfd | 有 | 无 | 无 | 无 | 无 | 无 |
| inotify | 有(686行) | 无 | 存根 | 无 | 无 | 无 |
| fanotify | 有(974行) | 无 | 无 | 无 | 无 | 无 |
| userfaultfd | 有(352行) | 无 | 无 | 无 | 无 | 无 |
| io_uring | 有(380行) | 无 | 无 | 无 | 无 | 无 |
| epoll | 完整(LT/ET/ONESHOT) | 轮询(LT only) | ET/ONESHOT | LT only | 轮询 | 无 |
| Netlink | 有(948行) | 无 | 无 | 无 | 无 | 无 |
| AF_PACKET | 有(417行) | 无 | 无 | 无 | 无 | 无 |
| AF_ALG | 有(479行) | 无 | 无 | 无 | 无 | 无 |

### 3.5 网络子系统

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| TCP/UDP | 完整 | 对象封装(未接入syscall) | 完整 | 基础(IPv4 only) | 基础 | 无 |
| Unix域套接字 | 完整(Stream+Dgram) | 无 | 完整 | 无 | 无 | 无 |
| VSock | 完整 | 无 | 无 | 无 | 无 | 无 |
| Netlink | 完整 | 无 | 无 | 无 | 无 | 无 |
| AF_PACKET | 完整 | 无 | 无 | 无 | 无 | 无 |
| IPv6 | 基础支持 | 无 | 无 | 触发panic | 基础 | 无 |
| 路由表 | 最长前缀匹配 | 无 | 无 | 无 | 无 | 无 |
| SO_REUSEPORT | 支持 | 无 | 无 | 无 | 无 | 无 |
| TCP_CORK/NODELAY | 支持 | 无 | 无 | 无 | 无 | 无 |

### 3.6 信号处理

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 64信号 | 完整 | 完整 | 完整 | 完整 | 完整 | 仅定义 |
| sigaction | 完整 | 完整 | 完整 | 完整 | 完整 | 接口存在 |
| 信号排队(siginfo) | 完整 | 完整 | 完整 | 部分 | 部分 | 无 |
| sigaltstack | 完整 | 完整 | 完整 | 完整 | 部分 | 无 |
| 实时信号 | 完整 | 完整 | 完整 | 部分 | 部分 | 无 |
| CoreDump | 完整 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| Stop/Continue | 完整 | 未实现 | 部分 | 未实现 | 未实现 | 未实现 |
| 信号跳板 | 独立页表映射 | 固定地址映射 | 架构特定trampoline | 用户空间trampoline | Trap回调 | 无 |

### 3.7 同步与IPC

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| Futex操作集 | WAIT/WAKE/REQUEUE/BITSET/WAITV/PI | WAIT/WAKE/REQUEUE | WAIT/WAKE/REQUEUE/BITSET | WAIT/WAKE | WAIT/WAKE/REQUEUE | 无 |
| Futex表设计 | 全局哈希+WaitQueue | 每进程FutexTable | 分片FutexTable | BTreeMap | 按SMP核数分片 | 无 |
| System V 信号量 | 完整(943行) | 未实现 | 完整(含SEM_UNDO) | 未实现 | 完整(含SEM_UNDO) | 无 |
| System V 消息队列 | 完整(905行) | 未实现 | 完整 | 未实现 | 未实现 | 无 |
| System V 共享内存 | 完整(918行) | 完整 | 完整 | 完整 | 完整 | 无 |
| POSIX 消息队列 | 完整(742行) | 未实现 | 未实现 | 未实现 | 未实现 | 无 |
| membarrier | 完整 | 未实现 | 未实现 | 未实现 | 未实现 | 无 |

### 3.8 高级子系统

| 特性 | TheKernel | starry-next | StarryX | Undefined-OS | StarryOS (海南) | TOYOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| eBPF | VM+验证器+3种map | 无 | 无 | 无 | 无 | 无 |
| TTY/PTY | 完整终端+行规程+作业控制 | 基础ioctl | 基础tty | 无 | 基础 | 无 |
| cgroup | 基础框架(v1) | 无 | 无 | 无 | 无 | 无 |
| ELF动态链接 | 完整 | 无(Unikernel) | 完整 | 完整 | 完整 | 完整(亮点) |
| CFS调度器 | 完整(axsched) | 无 | 无 | 无 | 无 | 无 |
| 系统调用追踪 | 无 | 无 | 无 | syscall_trace宏(亮点) | 无 | 无 |
| Disk quota | quotactl(1008行) | 无 | 无 | 无 | 无 | 无 |

## 四、技术亮点对比

### 4.1 各项目独特亮点

**TheKernel (当前项目)**:
- **系统调用覆盖面业界领先**: 364个Sysno分支，19种特殊文件类型，在所有对比项目中遥遥领先。
- **eBPF子系统**: 唯一实现了完整eBPF虚拟机和验证器的项目，包含1432行验证器代码和三种BPF map类型。
- **io_uring实现**: 唯一提供io_uring_setup/enter/register完整实现的项目。
- **文件锁与租约**: 唯一实现POSIX记录锁（死锁检测）和Linux文件租约机制的项目。
- **TPAI/PTY完整实现**: 包含N_TTY行规程、termios、作业控制和PTY对，唯一具备完整终端子系统的项目。
- **五重命名空间**: 唯一实现Cgroup/PID/User/UTS/Time五种命名空间的项目。
- **快速路径优化**: syscall快速路径针对lmbench/cyclictest优化，在所选项目中独一无二。

**starry-next (燕山大学)**:
- **极致代码密度**: 以约5750行代码实现四架构支持和99个系统调用，每行代码的功能产出比最高。
- **AxNamespace资源隔离**: 利用ArceOS scope-local存储实现优雅的进程级资源隔离，设计理念先进。
- **固定地址信号跳板**: 避免内核空间拷贝，展示了在极简代码规模下的优化权衡。

**StarryX (杭州电子科技大学)**:
- **三层分离最彻底**: API/Core/Module三层物理分离，`xmodules/`目录下的6个子crate（xprocess/xsignal/xvma/xcache/xuspace/xutils）高度可复用。
- **LRU页缓存+脏页回写**: 唯一实现了独立页缓存子系统并支持脏页追踪与回写的项目（TheKernel依赖框架）。
- **System V IPC最完整**: SEM_UNDO支持在所有项目中最为完善。

**Undefined-OS (清华大学)**:
- **四层进程模型**: Session-ProcessGroup-Process-Thread严格映射POSIX标准，孤儿进程自动回收至PID 1。
- **syscall_trace过程宏**: 自研编译期代码生成机制，自动记录系统调用参数和返回值，调试效率显著提升。
- **DynamicFs Builder模式**: 声明式伪文件系统构建，`builder.add_file().data_fn().build()`的链式调用风格优雅。

**StarryOS (海南大学)**:
- **分片Futex表**: 按SMP核心数分片哈希表，在Futex设计维度有独立创新（TheKernel使用全局哈希+等待队列）。
- **用户指针安全验证**: 统一的用户空间指针合法性检查机制。
- **VirtIO多设备驱动**: 除块设备和网络外，还实现了VirtIO-GPU和多种SD卡驱动。

**TOYOS (华东师范大学)**:
- **纯C自研无依赖**: 唯一不从属于任何生态框架的项目，所有驱动和子系统从寄存器级编写，技术栈独立性强。
- **ELF动态链接**: 在教学/竞赛OS中实现动态链接难度极高，TOYOS是仅有的两个实现项目之一。
- **ext4 Extent树**: 自研实现Extent树结构优化大文件访问，而非绑定外部C库。
- **Trampoline机制**: 使用跳板页实现高效特权级切换，避免页表复制开销。

### 4.2 亮点维度总览

| 亮点维度 | 领跑者 | 说明 |
|----------|--------|------|
| 系统调用覆盖广度 | TheKernel | 364分支，远超第二名StarryX(~200) |
| 特殊文件类型 | TheKernel | 19种，第二名约5-6种 |
| 代码密度(功能/行数) | starry-next | 5750行/99syscall，效率最高 |
| 模块化架构 | StarryX | 三层物理分离+6子crate |
| 进程模型规范性 | Undefined-OS | 唯一严格Session-PG-Process-Thread |
| 页缓存设计 | StarryX | 唯一独立LRU+脏页回写 |
| IPC完整度 | TheKernel | 唯一同时实现SysV三件套+POSIX mqueue |
| Futex设计创新 | StarryOS(海南) | 分片表按核心数扩展 |
| eBPF | TheKernel | 独占 |
| 自研深度 | TOYOS | 纯C无依赖，自研ext4+VFS+驱动 |

## 五、不足与缺失对比

### 5.1 TheKernel (当前项目)

- 部分系统调用为存根（内核模块相关、某些quotactl子命令）
- cgroup资源控制仅为文件结构存在，无实际资源限制
- eBPF缺少JIT编译和更多程序类型（仅有socket filter类）
- 依赖大量第三方patched crates（22个），上游同步路径存在维护挑战
- 调度器通过axsched获得CFS，但缺乏NUMA感知
- 网络缺少IPv6全面支持、SCTP/DCCP协议
- 缺少XFS/BTRFS等高级文件系统后端

### 5.2 starry-next (燕山大学)

- Unikernel嵌入方式限制通用性：用户程序编译时链接进内核
- 无COW：fork采用全量地址空间复制
- brk预分配固定64KB堆空间
- 管道缓冲区仅256字节
- epoll纯轮询，无事件驱动
- 网络系统调用未接入主分发器
- 文件系统挂载仅为记录管理
- 信号CoreDump/Stop/Continue动作未实现
- 整体完整度仅60-65%

### 5.3 StarryX (杭州电子科技大学)

- msync/madvise仅为存根
- 缺乏POSIX IPC（mq_open/sem_open/shm_open）
- epoll底层依赖poll转换，非真正事件驱动
- 缺乏内存压缩与swap机制
- 无cgroups资源控制
- 缺乏完整的namespace隔离
- 高级调度策略未实现
- inotify/fanotify完整实现缺失
- 网络缺乏Raw Socket与Netlink

### 5.4 Undefined-OS (清华大学)

- mount/umount系统调用被注释
- procfs大量硬编码，且存在两套实现
- 文件映射不支持PROT_WRITE
- 网络仅IPv4，IPv6触发panic
- setsockopt为空实现
- epoll仅LT模式，不支持ET
- 多线程execve不完全支持
- CoreDump/Stop/Continue信号动作未实现
- sigsuspend缺失

### 5.5 StarryOS (海南大学)

- procfs为硬编码静态数据
- epoll纯轮询方式
- setpgid/setsid为桩实现
- vfork语义未完整实现
- 管道阻塞依赖yield而非等待队列
- Futex物理地址键存在ABA隐患
- 缺乏POSIX IPC
- 缺乏madvise/mlock高级内存特性
- 整体完整度约78%

### 5.6 TOYOS (华东师范大学)

- 信号核心分发函数sig_handle未实现
- 无缺页异常处理
- 无COW机制
- 物理页仅支持单页分配
- 无页面置换算法
- 无多线程支持
- 抢占式调度被注释
- 无IPC机制
- 单核设计
- ext4未实现日志
- 文件系统挂载为桩
- 进程数上限64

## 六、整体成熟度综合评分

以下评分以"可运行标准Linux用户态程序集（含BusyBox/LTP/复杂应用）的通用操作系统内核"为100%基准：

| 项目 | 架构设计 | 进程管理 | 内存管理 | 文件系统 | 网络 | IPC | 信号 | 高级特性 | 综合 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **TheKernel** | 95 | 90 | 85 | 85 | 80 | 85 | 90 | 80 | **87** |
| **StarryX** | 90 | 85 | 80 | 85 | 75 | 85 | 90 | 55 | **81** |
| **Undefined-OS** | 88 | 85 | 75 | 80 | 65 | 70 | 75 | 55 | **74** |
| **StarryOS (海南)** | 82 | 75 | 80 | 85 | 70 | 75 | 80 | 50 | **75** |
| **starry-next** | 85 | 75 | 70 | 75 | 40 | 65 | 75 | 40 | **65** |
| **TOYOS** | 75 | 70 | 60 | 85 | N/A | 40 | 30 | 60 | **57** |

*注：TOYOS的综合分考虑了其纯C自研的技术栈独立性作为加分因素。*

## 七、分类评价

### 7.1 第一梯队：全面领先型

**TheKernel (当前项目)** 在所有六个项目中处于绝对领先地位。其系统调用覆盖(364)、特殊文件类型(19)、eBPF/io_uring/TTY等高级子系统的实现，定义了竞赛内核的功能广度上限。在进程管理（5种namespace、coredump、ptrace、作业控制）和文件系统（文件锁、租约、权限检查）的深度上也远超其他项目。唯一需要注意的是庞大的第三方依赖链带来的维护成本。

### 7.2 第二梯队：工程优秀型

**StarryX** 和 **Undefined-OS** 代表了ArceOS生态下工程质量的优秀水平。StarryX以最规范的模块化设计（三层物理分离+独立子crate）和自研LRU页缓存见长；Undefined-OS以最严谨的POSIX进程模型映射和syscall_trace宏的创新调试手段取胜。两者在核心子系统覆盖上与TheKernel接近，但在高级特性（eBPF、io_uring、文件锁、命名空间等）上存在明显差距。

**StarryOS (海南)** 与TheKernel同源但发展路线不同。其在Futex分片表设计上有独立创新，VirtIO驱动覆盖面广（含GPU），但在系统调用和高级子系统深度上明显落后，procfs硬编码严重。

### 7.3 第三梯队：精巧高效型

**starry-next (燕山大学)** 以约5750行代码实现四架构+99系统调用，代码密度堪称典范。但Unikernel嵌入方式从根本上限制了其作为通用操作系统的能力边界。适合作为教学参考或专用场景，但不适合作为通用Linux兼容内核。

### 7.4 独立路线型

**TOYOS (华东师范大学)** 作为唯一的纯C自研项目，在所有Rust+ArceOS项目中走出了一条独立的技术路线。其自研ext4 Extent树和ELF动态链接展示了扎实的底层开发能力。但由于语言和生态的选择差异，在功能广度和架构抽象层次上与Rust项目存在代际差距。其信号系统核心缺失、无COW/缺页处理等关键短板使其难以运行复杂用户态程序。

## 八、评审意见

TheKernel 项目在本次对比的六个项目中展现出最为全面和深入的系统构建能力。项目在 ArceOS unikernel 基础之上，构建了一个功能密度极高的 Linux ABI 兼容内核，其技术决策体现了"在成熟生态上做深度扩展"的务实工程哲学。

与同生态项目相比，TheKernel 最突出的差异化优势在于：(1) 系统调用和特殊文件类型的覆盖广度达到竞赛场景的近乎极限水平；(2) eBPF、io_uring、TTY/PTY、文件锁与租约等高级子系统是唯一实现者；(3) 五重命名空间和完整的信号处理（含CoreDump）赋予了内核接近真实Linux的进程隔离能力。这些特性组合在一起，使得 TheKernel 成为六个项目中唯一具备运行复杂Linux应用（如systemd、容器运行时等）潜力的内核。

与不同技术路线的TOYOS相比，TheKernel展示了Rust+ArceOS路线的显著生产力优势：在代码量约4倍于TOYOS的情况下，实现了约6.6倍的syscall覆盖和数量级差距的功能特性。但TOYOS的纯C自研路线在技术独立性和学习价值方面具有不可替代的教育意义。

TheKernel的主要不足集中在：(1) 对第三方patched crates的深度依赖（22个），长期维护面临上游同步压力；(2) cgroup和eBPF等子系统虽有框架但深度不足；(3) 网络协议栈的协议覆盖（IPv6/SCTP等）仍有扩展空间。这些问题不影响项目在当前竞赛场景下的领先地位，但若向生产级系统演进则需要持续投入。

综合而言，TheKernel 是一个在功能广度、实现深度和工程质量三个维度上都达到当前竞赛内核最高水准的项目。其在有限的竞赛周期内展现出的系统软件构建能力，以及面对复杂技术问题时的工程权衡智慧，均值得高度认可。