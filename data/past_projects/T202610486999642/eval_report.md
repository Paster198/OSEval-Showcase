# WHUSP 内核项目技术画像与评估报告

---

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| **项目名称** | WHUSP |
| **内核类型** | 宏内核（Monolithic Kernel） |
| **架构支持** | RISC-V 64 (riscv64gc)、LoongArch 64 |
| **实现语言** | Rust（内核主体）+ RISC-V/LoongArch 汇编（入口、上下文切换、陷阱处理） |
| **生态归属** | 类 Linux ABI 兼容内核，可运行 musl libc 编译的 Linux 用户程序 |
| **内核代码规模** | 约 77,059 行（159 个 Rust 源文件 + 汇编 + 链接脚本） |
| **系统调用覆盖** | 约 280 个系统调用号，约 294 个实际实现分支 |
| **文件系统支持** | EXT4、FAT（VFAT）、procfs、devfs、tmpfs、overlayfs、cgroupfs、staticfs 共 8 种 |
| **特殊文件类型** | pipe、named FIFO、socket（TCP/UDP/Unix/Netlink/Packet）、eventfd、timerfd、memfd、anonfd |
| **调度器** | CFS（完全公平调度器），支持 SCHED_NORMAL / SCHED_FIFO / SCHED_RR / SCHED_DEADLINE |
| **许可协议** | 源码中未见明确许可证声明文件 |
| **定位场景** | OS 内核比赛作品，以通过 LTP（Linux Test Project）测试套件为主要目标 |

---

## 二、子系统与功能总览

WHUSP 实现了以下子系统：

| 子系统 | 核心功能模块 |
|--------|-------------|
| **架构层** | RISC-V 64 完整支持（Sv39页表、ASID、FPU惰性保存、PLIC）；LoongArch 64 完整支持（三级页表、DMW直接映射窗口、EIOINTC+PCH-PIC两级中断控制器） |
| **内存管理** | 栈式物理帧分配器、伙伴系统内核堆分配器、三级页表管理、VMA地址空间抽象、按需分页、COW、页面缓存（LRU驱逐）、System V共享内存 |
| **进程管理** | 完整进程/线程模型（PCB+TCB）、clone/fork/execve、CFS调度器、信号处理（65种信号）、futex（含PI优先级继承）、ptrace调试支持、seccomp过滤、资源限制 |
| **文件系统** | VFS抽象层、EXT4（通过lwext4_rust绑定）、FAT（通过fatfs）、tmpfs（含稀疏文件优化）、procfs、devfs、overlayfs、cgroupfs、脏页缓存与预读 |
| **设备驱动** | VirtIO MMIO/PCI传输层、VirtIO块设备（双路径I/O）、NS16550a UART、输入设备（键盘/鼠标）、PLIC中断控制器、EIOINTC+PCH-PIC中断控制器 |
| **同步原语** | UPIntrFreeCell（中断屏蔽互斥）、SleepMutex（基于futex的阻塞锁）、Condvar（条件变量） |
| **网络栈** | 本地回环TCP/UDP、Unix域套接字、Netlink套接字、Packet套接字（无实际网络设备数据路径） |
| **时间管理** | RTC挂钟、定时器中断（1000Hz）、timerfd、vDSO时钟访问（免系统调用）、高精度定时器 |
| **vDSO** | 手工构建ELF镜像，提供 `__vdso_clock_gettime`、`__vdso_gettimeofday`、`__vdso_clock_getres` |
| **System V IPC** | 消息队列(msg)、信号量(sem)、共享内存(shm) |
| **io_uring** | io_uring_setup/enter/register 基础支持 |
| **AIO** | io_setup/destroy/submit/cancel/getevents 基础支持 |
| **cgroup** | 内存控制组基本实现（memcg） |
| **系统信息** | 极为详尽的 procfs 实现（进程状态、系统统计、sysctl树、挂载信息等） |
| **性能工具** | 52个性能剖析点，通过 `/proc/oskernel/perf` 暴露，条件编译可选 |

---

## 三、各子系统实现完整度与细节分析

### 3.1 架构层

#### RISC-V 64
- **实现完整度**：在比赛场景下接近完备。
- **实现细节**：
  - Sv39 三级页表，PTE 软件保留位用于 COW 标记。
  - ASID 运行时探测：启动时通过写入/回读 SATP 的 ASID 位自动检测硬件能力，决定是否启用延迟 TLB 刷新优化。
  - 陷阱入口 `trap.S` 保存完整用户上下文（31 个通用寄存器 + sstatus + sepc），FPU 采用惰性保存（仅在 FS==Dirty 时保存）。
  - 上下文切换 `switch.S` 仅保存/恢复被调用者保存寄存器（ra + s0-s11 + sp），切换开销约 112 字节状态。
  - SBI 调用封装完整（定时器设置、IPI、关机）。
- **优点**：ASID 自动探测是实用且精巧的工程决策；FPU 惰性保存避免了无浮点任务的不必要开销。
- **局限**：SBI 调用为同步轮询模式，未使用 SBI 的异步扩展。

#### LoongArch 64
- **实现完整度**：核心路径完整，优化程度低于 RISC-V。
- **实现细节**：
  - 三级页表，PTE 编码独立于 RISC-V，COW 使用 bit 58 软件位。
  - DMW0/DMW1 直接映射窗口配置在入口汇编中完成，实现低物理地址到高虚拟地址的无页表跳转。
  - TLB 重填：trap.S 中配置 `pwcl`/`pwch` 实现硬件三级页表走表，`__tlb_refill` 入口对齐 12 字节。
  - FPU 状态无条件保存/恢复全部 32 个浮点寄存器和 8 个 FCC 条件码。
  - 中断控制器为 EIOINTC（256 向量，IOCSR 访问）级联 PCH-PIC（64 IRQ）。
- **优点**：TLB 硬件重填路径利用 LoongArch 的硬件走表特性，减少软件 TLB 缺失处理开销。
- **局限**：无 ASID 支持（`alloc_page_table_asid()` 返回 0），每次返回用户态刷新全部 TLB，在多进程场景下有不可忽略的性能代价；FPU 无条件保存/恢复比 RISC-V 的惰性方案开销更大。

---

### 3.2 内存管理

- **实现完整度**：核心路径完整，约 85% 的典型宏内核内存管理功能已实现。
- **实现细节**：
  - **栈式物理帧分配器**：`current` 指针单调递增分配，`recycled` Vec 回收释放帧，`ref_counts` 数组防止双重释放，支持 `frame_alloc_more()` 分配连续物理帧用于 DMA。
  - **内核堆**：基于 `buddy_system_allocator::LockedHeap<32>`，128 MB 堆空间，alloc/dealloc 期间屏蔽中断（`InterruptFreeLockedHeap` 包装）。
  - **页表**：跨架构的 `PageTable` 抽象，统一 `PTEFlags` 位标志（V/R/W/X/U/G/A/D/COW），`try_map()` 按需分配中间页表。用户 PTE 单槽缓存（原子变量实现）加速 `UserBuffer` 地址翻译。
  - **地址空间**：`MemorySet` 将 VMA 组织为排序 `Vec<MapArea>`，支持 `Framed`（惰性分配）、`Mmap`（文件/匿名映射）、`Shm`（共享内存）三种映射类型。`MapArea::fault()` 处理按需分页、COW 复制和文件页缓存加载。
  - **页面缓存**：全局 LRU 页面缓存，软上限 4096 页（16 MB），脏页追踪用于 MAP_SHARED 写回。
  - **System V 共享内存**：`shmget/shmat/shmdt/shmctl` 完整实现，权限检查使用能力模型。
- **优点**：用户态 PTE 缓存是低成本、有实际效果的优化；页面缓存与 VMA 文件映射之间的集成设计清晰；COW 通过 PTE 保留位标记，实现简洁。
- **局限**：页面缓存无回写线程，脏页仅在内存压力或显式 fsync 时写回；`mlock`/`mlockall` 语义接受了标志但未强制执行锁定；madvise 大部分建议为 no-op。

---

### 3.3 进程管理

- **实现完整度**：功能覆盖广泛，约 88% 的 Linux 进程管理接口已有实现。
- **实现细节**：
  - **进程/线程模型**：`ProcessControlBlock` 管理地址空间、文件描述符表、信号处理、凭证等进程级资源；`TaskControlBlock` 管理内核栈、调度上下文、待处理信号等线程级状态。线程通过 `Arc<TaskControlBlock>` 共享进程资源。
  - **clone**：支持全部 Linux clone 标志（CLONE_VM、CLONE_FILES、CLONE_SIGHAND、CLONE_THREAD、CLONE_VFORK 等），vfork 父进程阻塞直到子进程 exec/exit。
  - **execve**：ELF 加载 + 地址空间替换，支持动态链接 ELF（PT_INTERP）、shebang 脚本递归解释器加载，辅助向量完整（AT_PHDR/AT_ENTRY/AT_BASE/AT_HWCAP 等 19 项）。
  - **CFS 调度器**：就绪队列为 `BinaryHeap`（按 `sched_vruntime`），支持 4 种调度策略，实时任务优先级高于普通任务，SCHED_RR 时间片 100ms，定时器中断频率 1000Hz（1ms 抢占粒度）。
  - **信号处理**：128 位 `SignalFlags` 支持 65 种信号（SIGHUP-SIGSYS + SIGRTMIN-SIGRTMAX），信号递送在陷阱返回路径中进行，支持 `rt_sigreturn` 恢复上下文，架构相关信号帧格式（RISC-V `RiscvUContext` / LoongArch ucontext）。
  - **futex**：64 个哈希桶的 futex 管理器，支持 WAIT/WAKE/WAIT_BITSET/WAKE_BITSET/REQUEUE/CMP_REQUEUE/LOCK_PI/UNLOCK_PI/TRYLOCK_PI，超时通过内核定时器实现，robust list 在任务退出时清理。
  - **ptrace**：支持 PTRACE_TRACEME/ATTACH/DETACH/SYSCALL/SINGLESTEP/CONT/GETREGS/SETREGS/PEEKDATA/POKEDATA/GETSIGINFO/SETSIGINFO 及事件通知。
  - **凭证模型**：完整的多 UID/GID 模型（uid/euid/suid/fsuid + gid/egid/sgid/fsgid + groups + capabilities）。
- **优点**：futex 实现包含优先级继承（PI），这是复杂但关键的正确性保证；ptrace 支持覆盖了调试器核心需求；CFS 调度器设计符合 Linux 语义。
- **局限**：seccomp 过滤仅支持经典 BPF 指令的子集，非通用实现；资源限制（RLIMIT）的 16 种类型被接受存储但多数未实际强制执行；核心转储（core dump）仅有框架标记而无实际写入逻辑。

---

### 3.4 文件系统

- **实现完整度**：在所有子系统中完整度最高，约 92%。
- **实现细节**：
  - **VFS 抽象**：`FileSystemBackend` trait 定义约 20 个方法（lookup/create/read/write/truncate/stat/link/unlink/symlink/readlink/statfs 等），足够支撑 8 种文件系统的接入。
  - **VfsFile**：统一文件对象，提供分块读写（最大 64KB/块）、脏页缓存（写缓冲）、小文件读缓存（< 8MB 文件，总缓存 32MB）、预读（6 页）、O_APPEND 处理、文件锁（flock）、ETXTBSY 检查。
  - **EXT4**：通过 `lwext4_rust`（C 库绑定）实现完整 EXT4 读写、目录操作、链接、符号链接、扩展属性、inode 标志。
  - **FAT**：通过 vendored `fatfs` crate 支持 FAT12/16/32，含长文件名（LFN）。
  - **tmpfs**：采用 `TmpfsSparseExtent` 枚举实现稀疏文件优化（密集数据 `Vec<u8>` + 重复模式 `Repeated{pattern, len}`），自动将全零块转为重复模式以节省内存。
  - **overlayfs**：实现 lower + upper 层合并、写时复制、白名单文件删除（opaque whiteouts）、目录条目去重。
  - **procfs**（3352 行）：极为详尽，涵盖 `/proc/cpuinfo`、`/proc/meminfo`、`/proc/sys/` 完整 sysctl 树、`/proc/<pid>/` 下 stat/status/maps/smaps/pagemap/fd/ns/mounts 等几乎所有常用条目。
  - **devfs**（2994 行）：提供 null/zero/full/random/urandom、tty/pts（64 对 PTY，8KB 缓冲区）、loop 设备、input 设备、uinput、kmsg、tun、rtc。
  - **挂载系统**：支持 bind mount、递归 bind mount、挂载传播（shared/slave/private/unbindable）、`open_tree`/`fsopen`/`fsconfig`/`fsmount`/`move_mount` 新挂载 API。
- **优点**：VFS 抽象层设计精良，以约 20 个方法的 trait 支撑 8 种差异显著的文件系统；tmpfs 稀疏 extent 优化具有实际工程价值；overlayfs 的实现完整性在比赛内核中罕见；procfs 的详尽程度接近真实 Linux。
- **局限**：O_DSYNC/O_SYNC 标志被接受但未实现真正的同步写回；文件系统后端未实现独立的写回线程；loope 设备的实际 I/O 路径仅为框架。

---

### 3.5 同步原语

- **实现完整度**：基本可用，约 80%。
- **实现细节**：
  - **UPIntrFreeCell<T>**：基于中断屏蔽的单核互斥原语，`exclusive_access()` 屏蔽中断获取 `RefMut`，守卫 Drop 时恢复，`IntrMaskingInfo` 追踪嵌套级别和原始中断使能状态以正确处理嵌套。
  - **SleepMutex<T>**：基于 futex 的阻塞互斥锁，`lock()` 在竞争时阻塞当前任务，内部使用 `UPIntrFreeCell` 保护锁状态。
  - **Condvar**：条件变量，`wait_no_sched()` 阻塞当前任务并返回 `task_cx_ptr` 供调度器使用，与 `UPIntrFreeCell::exclusive_session()` 配合用于块设备 I/O 完成通知等场景。
- **优点**：UPIntrFreeCell 的中断嵌套追踪机制正确且必要；同步原语与调度器、块设备 I/O 的集成设计合理。
- **局限**：所有互斥原语为单核设计（依赖 UP 缩写即 Uniprocessor），无多核 CPU 的原子 CAS 锁实现；缺少 RCU、读写锁、顺序锁等高级同步机制；Condvar 无超时等待能力。

---

### 3.6 资源管理

- **实现完整度**：框架存在但执行不完整，约 60%。
- **实现细节**：
  - 定义了 16 种 `RLimitResource`（CPU、FSIZE、DATA、STACK、CORE、RSS、NPROC、NOFILE、MEMLOCK、AS、LOCKS、SIGPENDING、MSGQUEUE、NICE、RTPRIO、RTTIME）。
  - 资源限制值通过 `getrlimit`/`setrlimit` 系统调用读写，存储在 `ProcessResourceLimits` 中。
  - `getrusage` 返回 CPU 时间等资源使用统计。
  - `/proc/<pid>/stat` 和 `/proc/<pid>/status` 报告进程资源使用情况。
- **优点**：资源限制的接口层和存储层已完整实现，为后续强制执行提供了基础。
- **局限**：内存限制、调度器限制、fork 限制等关键 RLIMIT 仅存储但未在分配路径中强制执行；`getpriority`/`setpriority` 接受但无实际调度效果。

---

### 3.7 时间管理

- **实现完整度**：功能覆盖较好，约 85%。
- **实现细节**：
  - **挂钟时间**：RTC 初始化通过 DTB 获取时钟频率，内核维护墙上时间。
  - **定时器中断**：1000Hz 定时器中断，驱动 CFS 调度器和定时器超时处理。
  - **系统调用**：`clock_gettime`/`clock_settime`/`clock_getres`（支持 CLOCK_REALTIME/MONOTONIC/PROCESS_CPUTIME_ID/THREAD_CPUTIME_ID）、`nanosleep`/`clock_nanosleep`、`gettimeofday`/`settimeofday`、`timer_create`/`timer_settime`/`timer_gettime`/`timer_delete`、`getitimer`/`setitimer`。
  - **timerfd**：定时器文件描述符实现。
  - **vDSO**：手工构建的 vDSO ELF 镜像，`__vdso_clock_gettime` 直接读取 RISC-V `rdtime` 或 LoongArch 定时器 CSR，`__vdso_gettimeofday` 读取时间并转换，内核在映射后补丁写入时钟频率和墙上时间偏移。
- **优点**：vDSO 免系统调用的时钟访问路径设计精巧，手工构建 ELF 的过程展现了深度的 ELF 格式理解；timerfd 与 epoll 配合可构建高效定时器应用。
- **局限**：`adjtimex` 接受但为 no-op；`settimeofday` 接受但未持久化到 RTC；`clock_nanosleep` 的 TIMER_ABSTIME 语义处理需进一步验证。

---

### 3.8 系统信息

- **实现完整度**：在同类比赛内核中罕见地详尽，约 90%。
- **实现细节**：
  - `/proc/cpuinfo`：报告 CPU 型号、频率、缓存大小。
  - `/proc/meminfo`：报告 MemTotal/MemFree/Cached/SwapTotal 等字段。
  - `/proc/version`：内核版本字符串。
  - `/proc/uptime`：系统运行时间。
  - `/proc/sys/`：完整 sysctl 树（kernel/fs/net/vm/user 等）。
  - `/proc/<pid>/stat`：进程状态字段（pid/comm/state/ppid/pgrp/session/tty_nr/tpgid/flags/minflt/cminflt/majflt/cmajflt/utime/stime/cutime/cstime/priority/nice/num_threads/starttime/vsize/rss 等）。
  - `/proc/<pid>/status`：可读格式。
  - `/proc/<pid>/maps`、`/proc/<pid>/smaps`：内存映射详情。
  - `/proc/<pid>/pagemap`：页表条目导出。
  - `/proc/<pid>/fd/`：文件描述符符号链接。
  - `/proc/<pid>/ns/`：命名空间信息。
  - `/proc/mounts`、`/proc/mountinfo`：挂载点信息。
  - `/proc/filesystems`：已注册文件系统类型。
  - `/proc/sysvipc/`：System V IPC 资源信息。
  - `/proc/oskernel/perf`：性能计数器（可选编译特性）。
- **优点**：procfs 实现极为全面，几乎覆盖了 Linux 中常用的 proc 接口，对于比赛中的 LTP 测试和调试都非常有价值。
- **局限**：`/proc/config.gz` 条目存在但依赖编译时嵌入配置；部分 sysctl 条目为可读写接口但写入后的实际行为未全部验证。

---

### 3.9 设备驱动

- **实现完整度**：关键的块设备驱动较完整，约 70%。
- **实现细节**：
  - **VirtIO 传输层**：MMIO（RISC-V）和 PCI（LoongArch）双模式，`VirtioHal` 实现 DMA 分配/释放和物理地址转换。
  - **VirtIO 块设备**：双路径 I/O 设计——非阻塞路径在安全上下文使用条件变量异步等待，同步回退路径用于中断禁用的不安全上下文（如页面错误处理中的写回）。
  - **块缓存**：832 行的块缓存实现，与页面缓存协作。
  - **UART**：NS16550a 驱动，用于串口输入输出和内核日志。
  - **输入设备**：键盘/鼠标设备驱动框架。
  - **中断控制器**：RISC-V PLIC 驱动、LoongArch EIOINTC+PCH-PIC 驱动。
- **优点**：块设备双路径 I/O 设计体现了对内核中不同上下文约束的深入理解；VirtIO PCI 枚举为 LoongArch 支持提供了完整的设备发现路径。
- **局限**：无 VirtIO GPU 的实际渲染路径；无 VirtIO 网络设备的数据包处理路径（设备被发现但不处理数据）；输入设备驱动仅提供框架而未展现完整的事件注入管线。

---

### 3.10 网络

- **实现完整度**：协议栈框架完整但无外部网络数据路径，约 50%。
- **实现细节**：
  - socket 系统调用族完整（socket/socketpair/bind/listen/accept/connect/sendto/recvfrom/setsockopt/getsockopt/shutdown/sendmsg/recvmsg）。
  - 支持的协议族：AF_INET（TCP/UDP）、AF_UNIX、AF_NETLINK、AF_PACKET。
  - 协议栈为本地回环实现：数据在协议栈内部自循环。
- **优点**：socket 接口层完整，为将来接入真实网络设备驱动提供了良好的抽象基础。
- **局限**：无实际网络数据路径——VirtIO 网络设备被识别但不传输数据；TCP/UDP 仅本地回环，无 IP 路由、ARP、DHCP 等网络协议实现；无 AF_INET6 支持。

---

## 四、内核整体实现完整度评估

**综合评估**：WHUSP 在比赛导向的宏内核评价维度下，整体实现完整度约 **80-85%**。

**评估基准说明**：以可运行标准 Linux 用户程序（通过 musl libc 编译）并在 EXT4 根文件系统上通过 LTP 相关测试用例为目标进行衡量。

**各维度权重与得分**：

| 维度 | 权重 | 完整度 | 加权贡献 |
|------|------|--------|----------|
| 文件系统与存储栈 | 20% | 92% | 18.4% |
| 进程管理与调度 | 20% | 88% | 17.6% |
| 系统调用覆盖 | 18% | 82% | 14.8% |
| 内存管理 | 15% | 85% | 12.8% |
| 架构与硬件抽象 | 10% | 85% | 8.5% |
| 同步原语 | 5% | 80% | 4.0% |
| 系统信息（procfs等） | 5% | 90% | 4.5% |
| 设备驱动 | 4% | 70% | 2.8% |
| 网络 | 2% | 50% | 1.0% |
| 资源管理 | 1% | 60% | 0.6% |
| **合计** | **100%** | — | **85.0%** |

---

## 五、动态测试

### 5.1 测试设计

WHUSP 项目的测试策略主要体现在以下方面：

1. **静态测试**：源码中存在大量条件编译的 `#[cfg(test)]` 模块（通常位于各 subsystem 模块底部），对内部函数进行单元测试。
2. **用户态测试**：通过构建比赛提供的磁盘镜像，运行包含测试二进制文件和脚本的用户空间环境。
3. **LTP 测试套件**：作为主要兼容性验证手段，目标为通过 LTP 的相关测试用例。
4. **性能剖析点**：52 个 `ProfilePoint`，通过 `/proc/oskernel/perf` 暴露统计数据，属于运行时性能监控基础设施。

### 5.2 测试执行情况

**本次分析未进行实际的 QEMU 运行测试**。原因如下：

- 该项目需要在 QEMU 中挂载特定的比赛磁盘镜像（包含 EXT4/FAT 文件系统和测试程序），当前容器环境缺少完整的测试磁盘镜像文件。
- 内核构建产物（ELF 二进制文件）需要在分析前已生成，或需在分析容器中编译。由于缺少完整的 vendored 依赖（如 `lwext4_rust` 的 C 库编译环境），完整构建链路的验证存在不确定性。

### 5.3 基于源码的测试结果推断

由于未进行动态测试，无法提供运行时测试结果。以下为基于源码分析的推断：

- 约 280 个系统调用的实现状态表明，大部分常见的 Linux 用户空间操作（文件读写、进程创建、信号处理、内存映射等）应可通过对应的 LTP 测试。
- 源码中约 50+ 处 `UNFINISHED` 注释标记的功能点，在对应 LTP 测试中可能出现不通过或部分通过的情况。
- SA_RESTART 信号处理、O_SYNC 语义、RLIMIT 强制执行等已知限制，可能导致相关 LTP 测试用例失败。

---

## 六、细则评价表格

### 6.1 内存管理

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 核心路径完整（物理帧分配、内核堆、三级页表、VMA管理、按需分页、COW、页面缓存、共享内存）。约 85%。 |
| **关键发现** | 用户 PTE 单槽缓存加速地址翻译；COW 通过 PTE 保留位标记实现简洁；栈式帧分配器含引用计数防止双重释放。 |
| **评价** | 内存管理子系统结构清晰，VMA 的三种映射类型（Framed/Mmap/Shm）抽象合理。`MapArea::fault()` 中的按需分配、COW复制和文件页加载逻辑完整。页面缓存的 LRU 驱逐策略和脏页追踪满足基本需求。主要不足在于缺少独立写回线程、mlock 未强制执行、madvise 大部分建议为 no-op。 |

### 6.2 进程管理

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 功能覆盖面广（clone全标志支持、CFS调度、信号处理、futex含PI、ptrace、凭证模型）。约 88%。 |
| **关键发现** | futex 包含优先级继承（PI）实现，是同类比赛内核中少见的高级特性；CFS 的 `sched_vruntime` 排序和四策略调度设计符合 Linux 语义；ptrace 覆盖调试器核心需求。 |
| **评价** | 进程管理是该内核最成熟的子系统之一。clone 对全标志的支持（CLONE_VM/FILES/SIGHAND/THREAD/VFORK 等）展现了良好的 Linux 兼容性意图。futex PI 的实现尤为突出。seccomp 过滤仅支持经典 BPF 子集，RLIMIT 多数未强制执行，核心转储仅有框架，属于已知取舍。 |

### 6.3 文件系统

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 8 种文件系统，通用 VFS 抽象层，脏页缓存、预读、文件锁。完整度在子系统中最高，约 92%。 |
| **关键发现** | VFS 抽象以约 20 个方法的 trait 支撑 8 种差异显著的文件系统，设计精良；tmpfs 的稀疏 extent 优化（自动将零块转为重复模式）具有工程价值；overlayfs 实现了完整的 lower+upper 合并与写时复制。 |
| **评价** | 文件系统栈是 WHUSP 最大的技术亮点。procfs（3352 行）和 devfs（2994 行）的实现详尽程度远超一般比赛内核。overlayfs 的实现难度高，在比赛环境中具有实用价值（可构建多层根文件系统）。不足在于 O_SYNC 标志未强制执行，缺少独立的写回线程。 |

### 6.4 交互设计

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 串口控制台 + devfs 设备节点提供基本交互，PTY 实现支持终端复用。约 65%。 |
| **关键发现** | PTY 支持 64 对伪终端，8KB 缓冲区；devfs 提供 `/dev/tty`、`/dev/ttyS0`、`/dev/ptmx` 等标准终端设备节点。 |
| **评价** | 交互设计以支持比赛测试脚本执行为目标，控制台输入输出和 PTY 功能可满足基本的 shell 操作需求。缺少图形输出（VirtIO GPU 无实际渲染路径）、framebuffer 支持和高级终端控制（如 termios 的完整实现）。 |

### 6.5 同步原语

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | UPIntrFreeCell、SleepMutex、Condvar 三个原语。约 80%。 |
| **关键发现** | UPIntrFreeCell 的中断嵌套追踪（`IntrMaskingInfo`）正确且必要；SleepMutex 基于 futex 的阻塞语义实现合理。 |
| **评价** | 同步原语均为单核设计（UP 缩写表明确为单核场景），中断屏蔽方案在单核环境下是正确的。与调度器和块设备 I/O 的集成设计合理。缺少多核同步机制（原子 CAS 锁、RCU、读写锁），在仅考虑单核比赛场景下可接受。 |

### 6.6 资源管理

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 部分实现 |
| **完整度** | 接口层和存储层完整（16 种 RLIMIT、getrlimit/setrlimit/getrusage），强制执行不完整。约 60%。 |
| **关键发现** | `ProcessResourceLimits` 结构体定义了 16 种资源限制，系统调用接口完整；`getrusage` 返回 CPU 时间统计。 |
| **评价** | 资源管理框架已搭建完成，但关键的强制执行路径（内存分配限制、进程数限制、文件大小限制）未在对应内核路径中检查。在比赛场景中，这一缺失可能不影响单项功能测试，但在压力测试或多进程并发测试中可能暴露问题。 |

### 6.7 时间管理

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 挂钟时间、定时器中断、多种时钟系统调用、timerfd、vDSO时钟访问。约 85%。 |
| **关键发现** | vDSO 手工构建 ELF 镜像，`__vdso_clock_gettime` 直接读取硬件定时器，免系统调用开销；timerfd 与 epoll 可配合构建高效定时机制。 |
| **评价** | vDSO 实现是亮点，展现了团队对 ELF 格式和用户态优化的深入理解。时钟系统调用覆盖完整（CLOCK_REALTIME/MONOTONIC/PROCESS_CPUTIME_ID/THREAD_CPUTIME_ID）。`adjtimex` 为 no-op，时间持久化未实现，在日常使用中影响较小。 |

### 6.8 系统信息

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 极为详尽，procfs 覆盖 `/proc` 几乎所有常用接口，约 90%。 |
| **关键发现** | procfs 3352 行实现，涵盖 cpuinfo/meminfo/uptime/version/sys/pid下几乎所有字段（stat/status/maps/smaps/pagemap/fd/ns/mounts等）；性能计数器通过 `/proc/oskernel/perf` 暴露。 |
| **评价** | procfs 的详尽程度在比赛内核中极为少见，对调试、测试和运行标准 Linux 工具链具有极高的实用价值。此项属于 WHUSP 的突出亮点。 |

### 6.9 架构移植与抽象

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | RISC-V 64 和 LoongArch 64 双架构，上层代码高度共享。RISC-V 约 90%，LoongArch 约 80%。 |
| **关键发现** | 架构差异隔离在 `arch/` 目录下，通过统一的 `PTEFlags`、`TrapContext` 布局和系统调用编号方案实现共享；LoongArch 的 DMW 直接映射窗口和 TLB 硬件重填路径利用架构特性。 |
| **评价** | 双架构支持在比赛场景下具有战略价值。架构隔离设计合理，共享代码比例高。LoongArch 缺少 ASID 是其相对 RISC-V 的主要性能差距。 |

### 6.10 vDSO

| 评价项 | 内容 |
|--------|------|
| **是否实现** | 是 |
| **完整度** | 三个时钟函数（clock_gettime/gettimeofday/clock_getres），手工构建 ELF。约 85%。 |
| **关键发现** | 完全在内核中手工构建 vDSO ELF 镜像（含 ELF header、program header、dynamic section、symbol table、version table）；内核在映射后补丁写入时钟参数。 |
| **评价** | 手工构建 ELF 的技术难度较高，体现了团队对二进制格式的掌握。vDSO 是提升时钟访问性能的关键优化，在比赛评测的高频时间操作场景下可能有显著效果。 |

---

## 七、总结评价

### 7.1 总体定位

WHUSP 是一个以**Linux ABI 兼容性为第一优先级**的比赛用宏内核。其设计哲学可以概括为：**广度优先于深度，接口覆盖优先于内部完备**。这体现在约 280 个系统调用号的匹配、8 种文件系统的接入、极为详尽的 procfs 实现上。

### 7.2 主要优势

1. **系统调用覆盖面广**：约 280 个系统调用号覆盖了 Linux 用户空间的主要 ABI 表面，这是通过 LTP 测试的物质基础。
2. **文件系统栈成熟**：8 种文件系统 + 完善的 VFS 抽象 + 脏页缓存 + 块缓存，在比赛内核中属于第一梯队。overlayfs 和 tmpfs 稀疏优化的实现水准突出。
3. **procfs 极为详尽**：3352 行实现几乎覆盖 Linux proc 的所有常用接口，调试和测试价值极高。
4. **双架构支持**：RISC-V 64 和 LoongArch 64 共享上层代码，架构差异隔离良好。
5. **若干高级特性**：futex 优先级继承、vDSO 手工构建、CFS 调度器、ptrace 支持等在比赛内核中不常见。
6. **代码量适中，组织清晰**：约 77,000 行 Rust 代码，模块划分合理，跨架构抽象层设计体现了工程素养。

### 7.3 主要局限

1. **多核支持缺失**：同步原语为单核设计（UP 前缀），调度器和中断管理无多核扩展。
2. **网络仅有协议框架**：无外部网络数据路径，VirtIO 网络设备未被充分利用。
3. **部分接口为 pass-through**：O_SYNC、RLIMIT 强制执行、madvise 等接口接受调用但无实际效果，属于 LTP 合规的权宜实现。
4. **LoongArch 无 ASID**：每次返回用户态刷新全部 TLB，在多进程场景下性能受损。
5. **代码中约 50+ 处 `UNFINISHED`**：团队对自身的实现边界有清晰认知，但表明大量功能为最小可行实现。

### 7.4 综合评价

WHUSP 是技术实现水平较高的比赛内核作品。它的核心策略——以 ABI 兼容性和文件系统完整性为重点——在比赛评测场景下是务实有效的。文件系统栈（尤其是 procfs、tmpfs 稀疏优化和 overlayfs）展现了超出一般比赛内核的工程深度。futex PI、vDSO 手工构建等特性体现了团队对操作系统底层机制的熟练运用。

该项目的主要技术债务集中在多核支持的缺失和部分接口的浅层实现上。考虑到比赛场景通常以单核功能正确性为主要评价维度，这些取舍在技术上是合理的。

代码量约 77,000 行（不含 vendored 依赖），在宏内核比赛项目中属于中大型规模。代码组织清晰，模块间接口定义明确，跨架构抽象层的设计展现了良好的软件工程实践。