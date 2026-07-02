# 对比分析报告

## 一、项目基本信息概览

| 维度 | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS (Starry) | SC7 |
|---|---|---|---|---|---|---|
| **编程语言** | Rust | Rust | Rust | Rust | Rust | C |
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **生态基座** | 无（自研） | 无（自研） | 无（自研） | 无（自研） | ArceOS | XV6 |
| **支持架构** | RISC-V, LoongArch | RISC-V, LoongArch | RISC-V, LoongArch | RISC-V, x86_64, AArch64, LoongArch | x86_64, AArch64, RISC-V, LoongArch | RISC-V, LoongArch |
| **代码规模** | ~29,400 行 | ~37,531 行 | ~100+ 文件 | ~28 核心文件 + 94 依赖crate | ~10,400 行（自有） | ~56,662 行 |
| **系统调用数** | ~130+ | 117 | 100+ | 100+ | 100+ | 144 |

---

## 二、架构设计对比

| 维度 | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS | SC7 |
|---|---|---|---|---|---|---|
| **分层方式** | HAL trait + kernel-core + syscall + 子系统crate | HAL条件编译 + 子系统模块 | cfg_if条件编译 + trait抽象 | polyhal HAL + vendor crates | 三层（入口/API/核心）依赖ArceOS基座 | 三层（HAL/HSAI/内核核心） |
| **HAL抽象** | 9个trait定义统一接口，spin::Once注册 | 条件编译导出统一接口，两套arch实现 | trait + cfg_if隔离架构差异 | polyhal统一多架构抽象 | 依赖ArceOS的axhal | 条件编译的HAL层，架构相关代码分散 |
| **模块化程度** | 高（12个独立crate） | 中（模块文件划分） | 中（模块文件划分） | 高（crate化，28个核心文件） | 高（crate化，三层架构） | 中（按子系统分目录） |
| **调度模型** | FIFO轮转+10ms时间片抢占 | FIFO就绪队列 | 轮转（1Hz时钟） | 异步协作式FIFO（Future/Waker） | 依赖ArceOS的axtask | 轮询遍历进程池 |
| **并发模型** | 单核 | 单核 | 单核（HART_NUM=1） | 多核支持 | 依赖ArceOS调度 | 单核（NUMCPU=1） |

**分析**：

whuse的HAL设计在六者中最为系统化——通过9个trait精确定义平台接口边界，内核其余部分通过`hal()`函数获取平台能力，这比NPUcore-Aspera的条件编译导出和TatlinOS的cfg_if都更加类型安全和可测试。ByteOS的polyhal在架构数量上占优（4架构），但其抽象层分散在vendor crate中，不如whuse的trait集合内聚。WenyiOS完全依赖ArceOS的axhal，自身不定义抽象层，自主性最低。SC7的HAL层与XV6传统一致，功能完整但抽象程度受限于C语言的表达能力。

whuse的"自旋式阻塞"模型（不递增sepc实现系统调用重试）是独特的调度设计，与ByteOS的异步协作式调度和TatlinOS的1Hz轮转形成鲜明对比。

---

## 三、内存管理子系统对比

| 维度 | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS | SC7 |
|---|---|---|---|---|---|---|
| **物理帧分配器** | Bump分配器（不回收） | 栈式分配器+回收列表 | 页缓存+水位线（高低水位批量操作） | 位图分配器 | 依赖ArceOS | 伙伴系统（0-10阶） |
| **内核堆分配** | Buddy分配器（22阶/21阶） | Buddy分配器（32阶） | Buddy分配器 | 依赖外部crate | 依赖ArceOS | Slab分配器（8-1024字节） |
| **写时复制(CoW)** | 基础（Arc共享帧，缺页处理不完整） | 完整（缺页触发复制+权限撤销） | 完整（COW页表标志位+缺页复制） | 完整（Arc引用计数检测+缺页复制） | 依赖ArceOS | 完整（缺页异常处理） |
| **惰性分配** | 未实现 | 未明确（依赖CoW延迟） | 完整（lazy_insert_framed_area） | 未明确 | 按需分页 | PROT_NONE延迟分配 |
| **Swap/Zram** | 未实现 | 完整（Zram LZ4压缩+Swap 16MB） | 未实现 | 未实现 | 未实现 | 未实现 |
| **OOM处理** | 未实现 | 多层（缓存清理→浅清理→深清理→压缩/交换） | 未实现 | 未实现 | 未实现 | 未实现 |
| **共享内存** | 完整（System V shmget/shmat/shmdt/shmctl） | 完整（SharedSegment+BTreeMap管理） | 完整（ShmManager+GroupManager） | 完整（System V shm） | 完整（含垃圾回收） | 完整（System V shm） |
| **mmap支持** | 完整（ANONYMOUS/FIXED/SHARED/PRIVATE+文件映射） | 完整（文件映射+匿名映射+共享） | 完整（文件映射+匿名+共享组管理） | 完整（文件映射+匿名） | 完整（FIXED/ANONYMOUS+文件映射） | 完整（文件映射+匿名） |

**分析**：

六者中，NPUcore-Aspera的内存管理子系统实现最深——Frame状态机（InMemory/Compressed/SwappedOut/Unallocated）统一管理物理帧的四种状态，配合Zram压缩和Swap交换实现多层OOM处理，在竞赛级内核中独树一帜。whuse的bump分配器是明显的短板，不回收物理帧使得长时间运行内存压力不可控。TatlinOS的页缓存（高低水位线批量分配/回收）是值得关注的工程优化，但1Hz时钟频率严重削弱了其实用性。SC7的伙伴系统+Slab组合最为传统和成熟，但VMA线性查找在大规模场景下性能堪忧。WenyiOS完全依赖ArceOS，自主实现的内存管理代码极少。whuse在CoW实现上不完整——通过Arc共享物理帧但缺少缺页中断触发实际复制，是功能上的重要缺陷。

---

## 四、进程与任务管理对比

| 维度 | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS | SC7 |
|---|---|---|---|---|---|---|
| **进程模型** | Process结构（~50字段）完整 | TCB+PgCB分离 | Process+TaskControlBlock解耦 | PCB+TCB分离 | ProcessData+ThreadData | proc+thread_t分离 |
| **fork/clone** | 完整（CoW clone_private + 线程shared clone） | 完整（clone标志位） | 完整（clone标志位+线程共享） | 完整（CloneFlags细粒度控制） | 完整（CLONE_VM/THREAD/FILES等） | 完整（clone+线程创建） |
| **execve** | 完整（shebang/busybox/.sh自动处理） | 完整（ELF动态链接+auxv） | 完整（ELF加载+shebang） | 完整（静态/动态ELF） | 部分（多线程时返回EAGAIN） | 完整（ELF加载） |
| **信号系统** | 完整（64信号+SIGCANCEL取消+EINTR活锁保护） | 完整（64信号+用户态信号栈） | 完整（64信号+sigreturn） | 完整（标准+实时信号） | 完整（Trampoline映射） | 完整（64信号+SA_SIGINFO） |
| **Futex** | 完整（WAIT/WAKE/REQUEUE+bitset+robust+超时） | 完整（WAIT/WAKE/REQUEUE） | 完整（WAIT/WAKE/REQUEUE+BITSET+定时器集成） | 基础（WAIT/WAKE/REQUEUE） | 基础（wait/wake/requeue） | 完整（超时+FUTEX_WAITV+bitset） |
| **进程组/会话** | 完整（setpgid/getsid/setsid） | 未明确 | 有限 | 缺失 | 未明确 | 完整（pgid/sid） |
| **资源限制(rlimit)** | 存根（返回固定值） | 未明确 | 基础 | 基础（rlimits数组） | 框架（仅RLIMIT_NOFILE检查） | 完整（RLIMIT_STACK/NOFILE等） |
| **命名空间** | 存根（unshare返回0） | 未实现 | 未实现 | 未实现 | 完整（AxNamespace FD/FS隔离） | 部分（仅UTS命名空间） |

**分析**：

whuse在进程管理子系统的功能完整度在六者中处于领先地位。其信号处理深度尤为突出：完整的SIGCANCEL线程取消机制、EINTR活锁保护（1000次后强制退出）、robust futex自动清理，这些在其余五个项目中均未见完整实现。whuse的execve对shebang和busybox的深度适配（自动.sh脚本处理、busybox applet重定向）也是独特的工程优势。

WenyiOS的命名空间隔离（AxNamespace）实现最为规范，支持FD和FS的共享与复制语义。SC7的rlimit实现最为完整，且支持UTS命名空间。TatlinOS的Process与TCB解耦设计与whuse相似。ByteOS的进程模型完整但缺少进程组和会话管理。NPUcore-Aspera的信号处理符合POSIX标准但缺少whuse的线程取消高级特性。

---

## 五、文件系统对比

| 维度 | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS | SC7 |
|---|---|---|---|---|---|---|
| **VFS抽象** | NodeKind+NodeData枚举，统一VFS | VFS trait+File trait（downcast-rs） | Inode+File trait | vfscore VFS抽象层 | FileLike trait统一抽象 | VFS抽象层（mount/umount/statfs） |
| **支持文件系统** | EXT4(只读)+内存FS+procfs+devfs+tmpfs | FAT32+Ext4(含Extent树) | ext4(通过lwext4) | FAT32+Ext4+RAMFS+DevFS+ProcFS | ext4+vfat | ext4+VFAT+procfs |
| **EXT4实现方式** | 自研封装ext4-view(只读) | 自研（含Extent树完整操作） | lwext4 Rust封装 | 外部crate | lwext4 | lwext4移植 |
| **Dentry/目录缓存** | EXT4目录项缓存 | 完整目录树缓存（BTreeMap+Weak引用） | 未明确 | DentryNode缓存 | 未明确 | 路径解析 |
| **管道** | 完整（环形缓冲区+阻塞） | 完整 | 完整（64KB环形缓冲区） | 完整 | 完整（256字节缓冲区+yield等待） | 完整 |
| **Socket** | Unix socket完整+raw socket基础 | Unix socket未实现（todo!()） | 伪实现（组合管道+全局队列） | TCP/UDP基础 | TCP/UDP基础IPv4 | 仅接口框架 |
| **procfs** | 部分（meminfo/uptime/stat/version/mounts） | 部分（仅meminfo/interrupts） | 未实现 | 完整 | 未明确 | 完整（cpuinfo/meminfo/进程stat等） |
| **网络协议栈** | raw socket（无真实网络） | smoltcp（仅Loopback） | 无（全局队列模拟） | lose-net-stack IPv4 TCP/UDP | 依赖axnet IPv4 | 未实现（仅框架） |
| **文件系统写入** | EXT4只读；内存FS可写 | FAT32/Ext4读写 | ext4读写 | FAT32/Ext4读写 | ext4/vfat读写 | ext4/VFAT读写 |

**分析**：

whuse的VFS设计在六者中最为灵活——通过Rust枚举（NodeKind/NodeData）将所有节点类型统一在一个数据结构中，支持File/Directory/CharDevice/Pipe/Symlink/Event/Epoll/Socket/PidFd共10种节点类型。相比之下，NPUcore-Aspera和TatlinOS使用trait+downcast-rs方式，运行时开销更大但扩展性更好。ByteOS的VFS+Dentry缓存设计最为成熟。WenyiOS的FileLike trait最为简洁。

whuse的主要短板是EXT4仅支持只读访问，这限制了其作为通用内核的实用性。NPUcore-Aspera的Ext4实现最为完整（含Extent树创建/查找/插入/分裂），且同时支持FAT32。SC7和TatlinOS都依赖lwext4外部库，虽然功能完整但自主实现比例较低。

whuse的Unix socket实现是六者中最完整的（bind/listen/accept/connect/send/recv全链路），NPUcore-Aspera的Unix socket核心方法为todo!()。但在网络方面，NPUcore-Aspera基于smoltcp至少具备Loopback TCP/UDP能力，ByteOS和WenyiOS有真实的IPv4 TCP/UDP支持，whuse仅实现了进程间raw socket数据转发。

---

## 六、系统调用覆盖度对比

| 领域 | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS | SC7 |
|---|---|---|---|---|---|---|
| **文件I/O** | ~60（read/write/open/close/stat/getdents/mount/...） | 完整 | 完整 | 32 | 完整 | 完整 |
| **进程管理** | ~10（fork/vfork/clone/clone3/execve/exit/wait/...） | 完整 | 完整 | 15 | 完整 | 完整 |
| **内存管理** | 9（mmap/munmap/mprotect/brk/mremap/madvise/...） | 完整 | 完整 | 6 | 完整 | 完整 |
| **信号** | 7（kill/tkill/tgkill/sigaction/sigprocmask/...） | 完整 | 完整 | 7 | 完整 | 完整 |
| **网络** | 17（socket/bind/listen/accept/connect/send/recv/...） | 基础 | 伪实现 | 12 | 完整 | 仅框架 |
| **时间** | 7（nanosleep/clock_gettime/clock_nanosleep/...） | 完整 | 完整 | 8 | 完整 | 完整 |
| **IPC** | 4（shmget/shmat/shmctl/shmdt） | 完整 | 完整 | 完整 | 完整 | 完整 |
| **I/O多路复用** | 完整（epoll/pselect/ppoll） | 完整（Poll机制） | 未明确 | 基础（epoll 60%） | 完整（poll/ppoll/select/pselect6） | 未明确 |
| **系统信息** | ~15（getpid/uname/sysinfo/umask/prctl/...） | 基础 | 基础 | 5 | 完整 | 完整 |
| **总系统调用数** | ~130+ | 117 | 100+ | 100+ | 100+ | 144 |

**分析**：

SC7以144个系统调用数量领先，但其中网络相关调用为桩实现。whuse的~130+个系统调用在六者中处于第二，且每个调用都有实质实现而非空壳。whuse在I/O多路复用（epoll/pselect/ppoll完整实现）和网络系统调用（Unix socket全链路）方面的深度明显优于其他项目。TatlinOS和ByteOS的系统调用覆盖面广但部分网络调用为伪实现或桩。WenyiOS的系统调用实现依赖ArceOS基座，自主实现部分约100+。

---

## 七、技术亮点对比

| 项目 | 独特技术亮点 |
|---|---|
| **whuse** | (1) 自旋式阻塞系统调用模型——不递增sepc实现自动重试，避免传统休眠唤醒复杂性；(2) 竞赛级智能看门狗——进程名称匹配自动超时策略、死锁检测、EINTR活锁保护；(3) SIGCANCEL线程取消——完整实现musl的线程取消协议；(4) robust futex自动清理；(5) 集成自检init程序——启动时验证eventfd/epoll/socketpair/signal/shm/clone/futex/fork全部功能；(6) shebang/busybox深度适配——自动.sh脚本处理、applet重定向 |
| **NPUcore-Aspera** | (1) LAFlex自定义页表+内联汇编TLB Refill——针对LoongArch64优化的快速TLB填充路径；(2) Frame状态机——统一管理InMemory/Compressed/SwappedOut/Unallocated四种状态；(3) 多层OOM处理——缓存清理→浅清理→深清理→压缩→交换的递进回收策略；(4) Ext4 Extent树完整实现——创建/查找/插入/分裂操作自研；(5) Zram LZ4压缩+Swap交换双通道内存回收 |
| **TatlinOS** | (1) 物理页缓存机制——高低水位线(128/32页)批量分配/回收，降低堆分配器锁竞争；(2) GroupManager共享页管理——高效管理MAP_SHARED场景下的物理页复用；(3) Futex与定时器深度集成——基于二叉堆的超时管理；(4) Process与TCB清晰解耦——clone标志位精确控制资源共享 |
| **ByteOS** | (1) 异步协作式调度——基于Rust Future/Waker机制的FIFO任务队列；(2) polyhal四架构统一HAL——RISC-V/x86_64/AArch64/LoongArch全支持；(3) Dentry目录项缓存——加速VFS路径解析；(4) 多核任务分发——支持SMP环境下的任务调度 |
| **WenyiOS** | (1) 命名空间资源隔离——AxNamespace实现FD/FS的共享与复制语义；(2) 固定地址信号Trampoline——避免每次向用户栈复制返回代码；(3) 类型安全用户指针——UserPtr/UserConstPtr封装+页表权限检查；(4) 共享内存垃圾回收——完整的引用计数与自动清理；(5) 以~10,400行自有代码实现100+系统调用——代码效率最高 |
| **SC7** | (1) 伙伴系统+Slab分配器——成熟的二级内存分配架构；(2) POSIX线程取消机制——PTHREAD_CANCEL_ENABLE/DEFERRED完整语义；(3) UTS命名空间隔离——支持主机名隔离；(4) FUTEX_WAITV批量等待——支持高效的批量Futex操作；(5) 144个系统调用——数量最多 |

---

## 八、不足与缺失对比

| 项目 | 主要不足 |
|---|---|
| **whuse** | (1) CoW实现不完整——Arc共享帧但缺页处理未触发实际复制，写入共享页时两个进程都会看到修改；(2) Bump帧分配器不可回收——长时间运行内存耗尽；(3) EXT4仅支持只读；(4) 无真实网络协议栈——raw socket仅在进程间转发；(5) 双平台代码重复——RISC-V和LoongArch的kernel-core和buddy分配器各自独立实现；(6) 调度器过于简单——FIFO轮转无优先级；(7) 无Swap/Zram/OOM处理 |
| **NPUcore-Aspera** | (1) 仅单核运行；(2) 调度器为纯FIFO，无时间片轮转或优先级；(3) 网络仅Loopback，Unix socket核心方法为todo!()；(4) Zram容量固定2048页，Swap固定16MB，缺乏动态调整；(5) Ext4无日志机制；(6) procfs仅实现meminfo和interrupts两个节点 |
| **TatlinOS** | (1) 1Hz时钟中断频率——定时精度极差，nanosleep几乎不可用；(2) 调度器无优先级和多核支持；(3) 网络为伪实现——全局队列模拟本地回环；(4) 无虚拟文件系统（procfs/sysfs均缺失）；(5) 无Swap/Zram/OOM处理；(6) 挂载表为简化内存列表 |
| **ByteOS** | (1) 异步调度缺乏时间片轮转和抢占——Waker实现为空操作；(2) 无Swap/Zram/OOM处理；(3) 缺少进程组和会话管理；(4) Futex实现基础，无robust/超时/bitset高级操作；(5) 无UID/GID权限检查——安全机制缺失；(6) 网络仅IPv4，无IPv6 |
| **WenyiOS** | (1) 深度依赖ArceOS基座——底层核心机制自主实现比例有限；(2) brk堆大小固定64KB——不动态扩展物理页；(3) I/O多路复用忙等待——CPU资源浪费；(4) 管道缓冲区仅256字节；(5) mount为简化实现——无实质文件系统切换；(6) 资源限制仅框架——除RLIMIT_NOFILE外未实质执行；(7) 多线程execve返回EAGAIN |
| **SC7** | (1) 调度器O(N)线性遍历——进程多时效率低；(2) 静态进程/线程池——编译时固定并发上限；(3) VMA线性链表查找——大规模地址空间性能差；(4) 网络协议栈缺失——socket为框架桩；(5) Futex静态数组——高并发资源耗尽风险；(6) 路径解析存在潜在缓冲区溢出——C语言字符串操作风险；(7) 命名空间仅UTS一个维度 |

---

## 九、整体成熟度综合评分

评分基准：以"能够运行busybox全部applet及libc测试套件"为满分10分，综合考量各子系统完整度、代码质量、工程化程度和创新性。以下评分为相对评分，用于横向对比。

| 维度（权重） | whuse | NPUcore-Aspera | TatlinOS | ByteOS | WenyiOS | SC7 |
|---|---|---|---|---|---|---|
| **内存管理** (20%) | 6.5 | 9.0 | 7.5 | 7.0 | 6.0 | 8.0 |
| **进程管理** (20%) | 8.5 | 7.5 | 7.5 | 7.0 | 7.5 | 8.0 |
| **文件系统** (15%) | 7.0 | 8.5 | 7.0 | 8.0 | 7.0 | 7.5 |
| **系统调用覆盖** (15%) | 8.0 | 7.5 | 7.5 | 7.5 | 7.5 | 8.5 |
| **信号与同步** (10%) | 9.0 | 7.5 | 7.5 | 6.5 | 7.5 | 8.0 |
| **网络能力** (5%) | 3.0 | 3.5 | 1.5 | 5.0 | 5.0 | 1.0 |
| **架构抽象** (5%) | 8.5 | 8.0 | 7.5 | 9.0 | 5.0 | 7.5 |
| **工程化程度** (5%) | 9.0 | 7.5 | 7.0 | 7.5 | 7.5 | 7.0 |
| **创新性** (5%) | 7.5 | 8.5 | 6.5 | 7.0 | 6.5 | 6.0 |
| **加权总分** | **7.56** | **7.88** | **7.08** | **7.33** | **6.88** | **7.43** |

---

## 十、各项目总结评价

### whuse（当前项目）

whuse是一个系统调用兼容性突出、工程化程度高的Rust宏内核。其核心竞争力在于进程管理子系统的深度实现——SIGCANCEL线程取消协议、robust futex、EINTR活锁保护是六个项目中独一无二的特性。竞赛级看门狗系统和集成自检init程序体现了务实的工程思维。HAL trait抽象层设计规范，自旋式阻塞模型是一种简洁有效的调度方案。主要短板在于内存管理（bump分配器不回收、CoW不完整、无Swap/Zram）和EXT4只读限制，这使其在长时间运行和内存压力场景下存在风险。在同类Rust自研宏内核中，whuse以约29,400行代码实现了最广的系统调用覆盖和最强的信号处理能力，但在内存管理的深度上明显落后于NPUcore-Aspera。

### NPUcore-Aspera

NPUcore-Aspera是内存管理深度最强的项目。Frame状态机驱动的物理帧管理、多层OOM递进回收、Zram压缩与Swap交换构成了六者中最完整的内存压力应对体系。LAFlex自定义页表的内联汇编TLB Refill优化展现了架构级优化的能力。Ext4 Extent树的自研实现和FAT32双文件系统支持使其文件系统能力也处于领先。但在进程管理和信号处理方面不如whuse深入，调度器仅为纯FIFO，网络仅Loopback。综合得分最高（7.88），适合作为内存管理密集型场景的技术参考。

### TatlinOS

TatlinOS在内存管理方面有独到的页缓存优化（水位线批量操作），但在时钟系统上存在致命缺陷——1Hz中断频率使nanosleep等时间相关系统调用几乎不可用。其Process/TCB解耦设计和Futex与定时器的集成是亮点，但网络伪实现和无虚拟文件系统是明显短板。整体是一个在核心机制上有想法但在系统工程完整性上不够均衡的项目。

### ByteOS

ByteOS的最大特色是基于Rust异步机制的协作式调度和四架构polyhal支持。在架构覆盖度上（RISC-V/x86_64/AArch64/LoongArch）六者第一。VFS+Dentry缓存设计和TCP/UDP网络协议栈使其具备较完整的系统能力。但异步Waker空操作实现和缺乏抢占式调度是异步架构的未完成部分，Futex实现也较为基础。作为探索Rust异步内核路径的代表，其技术方向具有参考价值。

### WenyiOS (Starry)

WenyiOS以约10,400行自有代码实现100+系统调用，代码效率六者最高。命名空间隔离、固定地址信号Trampoline、类型安全用户指针和共享内存垃圾回收体现了现代内核设计理念。但其深度依赖ArceOS基座，底层核心机制（物理内存分配、调度策略）的自主实现比例有限，这使得它在与完全自研项目的比较中处于不同赛道。适合作为展示组件化框架构建宏内核可行性的案例。

### SC7

SC7以56,662行代码和144个系统调用在规模上领先。基于XV6的成熟架构使其在核心链路的稳定性上有优势，伙伴系统+Slab分配器的组合最为传统可靠。POSIX线程取消机制和FUTEX_WAITV是其独特亮点。但C语言实现带来的缓冲区溢出风险、静态池和线性查找的性能瓶颈、以及网络协议栈的完全缺失，使其在安全性和现代性上落后于Rust项目。作为六者中唯一的C语言项目，在语言安全性和抽象表达能力上存在系统性差距。

---

## 十一、综合排名与分类评价

### 按技术深度排名

| 排名 | 项目 | 加权总分 | 核心优势 |
|---|---|---|---|
| 1 | NPUcore-Aspera | 7.88 | 内存管理深度和文件系统完整性最优 |
| 2 | whuse | 7.56 | 进程管理深度和系统调用覆盖最优 |
| 3 | SC7 | 7.43 | 规模最大、系统调用最多、内存分配最传统可靠 |
| 4 | ByteOS | 7.33 | 架构覆盖最广、异步调度探索 |
| 5 | TatlinOS | 7.08 | 页缓存优化设计独特但时钟系统严重拖分 |
| 6 | WenyiOS | 6.88 | 代码效率最高但自主实现比例最低 |

### 按技术路线分类

**自研深度型（完全自研，技术投入最深）**：whuse、NPUcore-Aspera、TatlinOS。三者均从零构建，不依赖任何OS框架。其中NPUcore-Aspera在内存管理上投入最深，whuse在进程管理上投入最深，TatlinOS在页缓存优化上有独到设计。

**架构广度型（多架构覆盖优先）**：ByteOS、WenyiOS。两者均支持4种架构，但ByteOS通过自研polyhal实现，WenyiOS通过依赖ArceOS实现。ByteOS在自主性上更胜一筹。

**生态继承型（基于现有OS框架扩展）**：SC7（XV6）、WenyiOS（ArceOS）。两者通过复用成熟框架降低开发成本，SC7在此基础上进行了深度扩展（56K行），WenyiOS则在有限代码量内实现了广泛的功能覆盖。

---

## 十二、评审意见

本届参评的六个操作系统内核项目在技术路线上呈现出"自研深度"与"生态复用"两种范式，在实现语言上形成Rust与C的分野。

whuse在进程管理子系统达到了六个项目中的最高深度：其SIGCANCEL线程取消协议的完整实现（含EINTR活锁保护和robust futex自动清理）是其他五个项目均未完整覆盖的高级特性；自旋式阻塞模型以简洁的设计解决了传统内核线程休眠/唤醒的复杂性；竞赛级看门狗和集成自检init展示了面向实际评测场景的工程化能力。但其内存管理子系统的短板同样明显——bump分配器不回收物理帧、CoW语义不完整（缺页处理未触发实际复制）、无Swap/Zram应对内存压力，这三点使其在长时间运行场景下的可靠性存在系统性风险，也是与NPUcore-Aspera的最大差距所在。

NPUcore-Aspera在内存管理方面建立了六者中最完整的体系，Frame状态机和多层OOM回收策略展现了较强的系统工程能力。LAFlex页表优化和Ext4 Extent树自研实现体现了对底层细节的深入掌握。但其进程管理和信号处理的深度不及whuse。

SC7以C语言实现了最大的代码规模和最多的系统调用数，伙伴系统+Slab的经典组合稳健可靠，但C语言固有的内存安全风险和线性数据结构的性能瓶颈在与Rust项目的对比中处于结构性劣势。

综合来看，whuse与NPUcore-Aspera在技术深度上构成双强格局，各有侧重：whuse胜在进程管理深度和系统调用兼容性，NPUcore-Aspera胜在内存管理深度和文件系统完整性。若whuse能够补齐内存管理的短板（实现真正的CoW缺页处理和物理帧回收机制），将具备挑战最高水平的技术基础。