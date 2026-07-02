# SWTC 双架构 OS 内核项目技术画像与评估报告

## 项目基本信息

| 属性 | 内容 |
|------|------|
| **项目名称** | SWTC |
| **参赛队伍** | `sudo_win_the_cscc` |
| **所属机构** | 上海电力大学 |
| **目标架构** | RISC-V64 (主线) + LoongArch64 (并行主线) |
| **实现语言** | Rust (100%) |
| **内核类型** | RISC-V 主线：自研单体内核；LoongArch 主线：基于 ArceOS 的分层组件化内核 |
| **生态归属** | Rust 内核生态；LoongArch 主线依托 ArceOS/StarryX 框架 |
| **代码规模** | 约 47,803 行 Rust 源代码（不含 vendor 和自动生成代码） |
| **系统调用覆盖** | RISC-V 主线：约 113 个系统调用处理函数；LoongArch 主线：248 个 Sysno 匹配分支 |
| **目标三元组** | `riscv64gc-unknown-none-elf` / `loongarch64-unknown-none` |
| **构建环境** | Rust nightly (两套独立工具链) + cargo + rust-lld |
| **测试框架** | LTP 子集、lmbench、libc-test、busybox |

---

## 子系统与功能实现总览

### 系统总体结构

该项目在一个仓库中并行维护两条独立的内核主线：

- **SWTC (RISC-V64)**：传统单体内核，所有子系统扁平组织在 `kernel/src/` 下，不依赖外部框架，自研程度高。
- **SWTC-la (LoongArch64)**：分层组件化内核，基于 ArceOS 框架，组织为 xapi (Linux ABI) / xcore (内核核心服务) / xmodules (功能模块) / arceos (硬件抽象与框架) 四层架构。

### 已实现子系统清单

| 子系统 | RISC-V 主线 | LoongArch 主线 |
|--------|-------------|----------------|
| 内存管理 | SV39 页表、伙伴系统、堆分配器、VMA、COW、共享内存、mmap/brk/mprotect | ArceOS axmm 多架构页表 + xvma VMA管理器 + COW + 栈自动扩展 |
| 进程管理 | Process/Thread、进程组、会话、fork/clone/exec/wait4 | XProcess/XThread、进程组、会话、clone (含全部标志组合验证)/exec/wait |
| 文件系统 | 自研 VFS + FAT32 (含 LFN) + devfs + procfs + tmpfs + pipefs + 页缓存 | ArceOS VFS + dev/tmp/proc/etc 虚拟文件系统 + ext4 (通过 lwext4 FFI) + fanotify + eventfd + timerfd |
| 网络 | smoltcp: TCP/UDP/Unix socket + SocketTable | smoltcp (via axnet): TCP/UDP/Unix socket |
| 信号 | POSIX 标准信号 + SigQueue + SignalContext | 完整 POSIX 信号 + 实时信号排队 + 多架构抽象 (xsignal) |
| 同步原语 | SpinNoIrqLock、SleepMutex、ReMutex、FutexQueue、Mailbox、Event | ArceOS axsync Mutex + FutexTable (含 WAIT/WAKE/BITSET/REQUEUE/CMP_REQUEUE + robust list) |
| 进程间通信 (IPC) | System V 共享内存 (shmget/shmctl/shmat) | System V 消息队列 + 信号量 + 共享内存 (完整三大件，含 UNDO 机制) |
| IO 多路复用 | poll/ppoll/pselect/epoll 基础 | epoll/poll/select/pselect 完整实现 |
| 时间管理 | 定时器 (ITimerval) + nanosleep + clock_gettime + 异步超时任务 | clock_gettime/settime/getres + timerfd + XThread 时间统计 |
| vDSO | 未实现 | 完整实现: __vdso_clock_gettime/gettimeofday/clock_getres/getcpu/rt_sigreturn |
| 设备驱动 | PLIC、UART (NS16550 + SiFive FU740)、virtio-blk、SPI、SD 卡、SBI 封装 | 依托 ArceOS 驱动体系: virtio-blk/net/gpu + PCI + ramdisk |
| 资源管理 | rlimit (getrlimit/setrlimit) + sysinfo | 完整 rlimit + prlimit64 + sysinfo |
| 系统信息 | uname | uname + 完整 proc 信息导出 |
| ELF 加载 | 自研 (含 musl 动态链接器支持、interp 路径识别) | 基于 ArceOS kernel_elf_parser (含 auxv 构建) |
| 用户态支持 | 自研用户库 + 嵌入用户程序 (shell, initproc, runtestcase) | musl/glibc + busybox + LTP |

---

## 各子系统实现细节与评估

### 1. 内存管理

**RISC-V 主线 (SWTC)**：

自研 SV39 分页系统，虚拟地址 39 位，物理地址 56 位。页表实现包含三级树结构，`PageTableEntry` 封装了 RISC-V Sv39 PTE，其中自定义了 bit 8 作为 COW 标志位。地址空间管理 (`MemorySpace`) 整合了 `VmArea`（虚拟内存区描述）、`PageManager`（页映射管理）、以及 `CowPageManager`（写时复制机制）。物理帧分配采用伙伴系统实现，内核堆分配器基于 `linked_list_allocator` crate。

页错误处理采用处理器链模式，注册了 `CowPageFaultHandler`（COW 触发）、`UStackPageFaultHandler`（栈自动扩展）、`SBrkPageFaultHandler`（brk 堆扩展）三种处理器。ELF 加载包含完整的 header 校验和动态链接器支持（识别 musl ld.so 路径，动态链接器在 0x20_0000_0000 偏移处映射）。

`UserCheck` 类型在系统调用入口对所有用户空间指针执行基于 `MemorySpace` 的合法性验证，检查读写权限。

**LoongArch 主线 (SWTC-la)**：

依赖于 ArceOS `axmm` 的多架构页表抽象（`UserAddressSpace`），在此基础上通过 `xvma` crate 构建 `VmaManager`，管理文件支持的 mmap 区域（`MmapRegion<F: VmFile>`），支持按需加载和区域的 split/merge 操作。`XUserSpace` 封装了地址空间和 VMA 管理器。页错误处理在 `src/mm.rs` 中实现，支持栈自动扩展（检查 `RLIMIT_STACK`），对不可恢复的页错误发送 SIGSEGV。

物理内存管理完全委托给 ArceOS `axalloc`（可选 buddy/slab/TLSF 算法）。

**优缺点**：
- *优势*：RISC-V 主线的自研 SV39 + COW 实现完整且细节到位，COW 利用 PTE 保留位的设计精巧。LoongArch 主线的 `xvma` 泛型设计支持文件后端 mmap，架构清晰。
- *不足*：两条主线均缺失 swap 交换机制、大页支持 (huge page)、KSM。RISC-V 主线中物理内存的 NUMA 感知和页面回收机制未实现。

---

### 2. 进程管理

**RISC-V 主线 (SWTC)**：

`Process` 作为核心控制块，持有 `ProcessInner`（含内存空间、父进程弱引用、子进程列表、文件描述符表、socket 表、线程集合、futex 队列、当前工作目录、定时器、rlimit、进程组 ID）。`Thread` 管理独立的 tid、内核栈、陷入上下文、信号队列和退出码。`ProcessManager` (`BTreeMap<tid, Weak<Process>>`) 和 `ProcessGroupManager` 提供进程查找和进程组操作。

进程创建支持 `fork` (通过 `CowPageManager::from_another()` 实现 COW 语义) 和 `exec` (终止所有非主线程、重置地址空间、加载新 ELF)。wait4 支持 WNOHANG，支持 CLONE_VM/CLONE_FS/CLONE_FILES/CLONE_SIGHAND/CLONE_THREAD/CLONE_VFORK 等标志。线程创建通过 clone 标志实现。

**LoongArch 主线 (SWTC-la)**：

`XProcess` 和 `XThread` 作为 ArceOS `axtask` 的任务扩展（通过 `def_task_ext!` 机制）。`XProcess` 包含可执行路径、用户空间 (`XUserSpace`)、命名空间、子进程等待队列、进程信号管理器、rlimits、futex 表、凭证信息。`XThread` 包含时间统计、robust list 头、oom_score_adj、调度优先级等。

clone 的实现包含完整的 `CloneFlags` 组合验证，对所有标志的组合强制执行 Linux 兼容性规则；execve 包含 FD_CLOEXEC 关闭和多线程环境下的 EAGAIN 返回。进程组和会话管理通过独立的 `xprocess` crate 提供。

**优缺点**：
- *优势*：LoongArch 主线的 clone 标志验证逻辑详尽，是两条主线中进程模型结构更清晰的一方。RISC-V 主线的 COW fork 实现完整。
- *不足*：两条主线均缺失 cgroup、namespace、seccomp 等容器/安全特性。内核抢占机制未实现。

---

### 3. 文件系统

**RISC-V 主线 (SWTC)**：

自研 VFS 框架，定义了 `Inode` 和 `File` 两个核心 trait。`InodeMeta` 管理 inode 元数据（ino、名称、权限模式、子节点 BTreeMap、父节点引用、状态），通过 `InodeCache` (`BTreeMap<HashKey, Arc<dyn Inode>>`) 实现 dentry 缓存加速。`FastPathCache` 针对 `/dev/null`、`/proc`、`/tmp` 等 8 条高频路径实现了前缀匹配快速查找。

FAT32 实现涵盖完整的 BPB 解析、FAT 表管理（簇链遍历与分配）、目录项解析（短文件名 8.3 + VFAT 长文件名支持）、簇边界处理、FSInfo 扇区结构、时间戳转换。

虚拟文件系统包含 devfs (`/dev`: null, zero, tty, urandom, rtc 等)、procfs (`/proc`: meminfo, mounts)、tmpfs (`/tmp`, `/var/tmp`)、pipefs（管道对）。文件描述符表支持 `alloc_fd`/`alloc_spec_fd`/`dup` 系列操作和 `fcntl` 标志管理。页缓存 (`page_cache`) 为文件提供基于页的缓存层。

**LoongArch 主线 (SWTC-la)**：

基于 ArceOS `axfs-ng` 框架，定义了 `FileLike` trait（类似 Linux `file_operations` 结构），将 Socket、Pipe、EventFd、TimerFd、FanotifyFd 等统一抽象为文件接口。VFS 挂载点包括 `/dev` (devfs)、`/tmp` (tmpfs)、`/proc` (procfs，含 pid/ 子目录)、`/etc` (etcfs)。

通过 lwext4_rust crate（C FFI 绑定）支持 ext4 文件系统，使其具备读写 ext4 磁盘镜像的能力。fanotify 提供文件系统事件监控，eventfd 和 timerfd 提供了额外的事件通知机制。

**优缺点**：
- *优势*：RISC-V 主线的 FAT32 实现完整，包含 LFN 解析，FastPathCache 设计有实际性能价值。LoongArch 主线的 ext4 支持和 `FileLike` 统一抽象实现了更接近 Linux“一切皆文件”的设计。
- *不足*：RISC-V 主线不支持 ext4 等现代日志文件系统，LoongArch 主线的 ext4 依赖外部 C 库绑定（lwext4），增加了 FFI 复杂度和潜在的维护成本。两条主线均缺失网络文件系统（NFS）和 FUSE 支持。RISC-V 主线的 FAT32 实现未支持 FAT12/FAT16 回退。

---

### 4. 网络

**RISC-V 主线 (SWTC)**：

基于 `smoltcp` 用户态协议栈实现。`Socket` trait 定义了 `bind`/`listen`/`connect`/`accept`/`socket_type`/`shutdown`/`set_nagle_enabled`/`set_keep_alive` 等操作。支持三种 socket 类型：`TcpSocket`（含 Nagle 算法和 Keep-Alive）、`UdpSocket`、`UnixSocket`（域套接字，用于进程间通信）。`SocketTable` 管理进程级 socket 描述符，包含端口冲突检测（`can_bind` 检查）。

**LoongArch 主线 (SWTC-la)**：

同样基于 smoltcp，通过 ArceOS `axnet` crate 集成。`Socket` 枚举包装了 `UdpSocket`/`TcpSocket`/`UnixSocket`，通过宏自动生成 `FileLike` trait 的方法委托。Unix socket 支持 socketpair 创建。

**优缺点**：
- *优势*：两条主线均实现了 TCP/UDP/Unix 三种 socket 类型的基本功能，Unix socket 为本地 IPC 提供了便利。socket 与文件描述符的集成使得网络编程接口与标准 POSIX 一致。
- *不足*：smoltcp 的用户态协议栈在性能上受限，且两条主线均未实现 IPv6 完整支持、原始 socket (raw socket)、netfilter/iptables、路由表管理。TCP 拥塞控制算法受限于 smoltcp 内置策略。

---

### 5. 信号

**RISC-V 主线 (SWTC)**：

自研信号子系统，实现了 POSIX 标准信号（SIGHUP 到 SIGSYS）和实时信号（SIGRTMIN+）。`SigQueue` 管理每个线程的 pending 信号和处理器表。信号投递流程：`recv_signal()` 遍历进程所有线程并向每个线程的队列投递；`check_signal_for_current_task()` 在返回用户态前检查 pending 信号；`handle_signal()` 对用户自定义 handler 执行上下文保存（通过 `SignalContext` 将当前寄存器状态保存在用户栈上），设置 `sepc` 为 handler 地址，`ra` 为 sigreturn trampoline。

默认信号处理器支持 term/core/stop/ign/cont 五种动作。

**LoongArch 主线 (SWTC-la)**：

通过独立的 `xsignal` crate 实现，这是该项目中最具跨架构设计特色的模块。`xsignal` 同时支持 aarch64/loongarch64/riscv/x86_64 四种架构，通过 `arch/` 子模块封装各架构特定的 TrapFrame 操作方式。实现了 `ProcessSignalManager` 和 `ThreadSignalManager`，支持实时信号排队（`SigQueMax=n`，按优先级排列）。系统调用实现包括 `rt_sigaction`、`rt_sigprocmask`、`rt_sigsuspend`、`rt_sigtimedwait`、`rt_sigreturn`、`kill`、`tkill`、`tgkill`。

**优缺点**：
- *优势*：LoongArch 主线的 `xsignal` 多架构抽象设计出色，实现了信号处理逻辑的跨架构复用。实时信号排队和 `rt_sigtimedwait` 提供了更完整的 POSIX 兼容性。RISC-V 主线在自研约束下也实现了完整的基本信号处理流程。
- *不足*：RISC-V 主线未实现实时信号排队（同一实时信号多次发送只保留一个），未实现 `rt_sigtimedwait`。两条主线均未实现 core dump。

---

### 6. 同步原语

**RISC-V 主线 (SWTC)**：

实现了六种同步原语：`SpinNoIrqLock`（自旋锁 + 关中断，内核中最常用）、`SleepMutex`（基于 async/await 的睡眠互斥锁）、`ReMutex`（可重入互斥锁，同一线程可多次获取）、`FutexQueue`（futex 等待队列，支持 wait/wake/requeue 操作）、`Mailbox`（消息邮箱，线程间消息传递）、`Event`（基于 async 的事件通知机制）。

**LoongArch 主线 (SWTC-la)**：

依赖 ArceOS `axsync` 提供的 `Mutex` 和 `WaitQueue`。futex 实现（在 xapi 层）支持 `FUTEX_WAIT`、`FUTEX_WAKE`、`FUTEX_WAIT_BITSET`、`FUTEX_WAKE_BITSET`、`FUTEX_REQUEUE`、`FUTEX_CMP_REQUEUE` 六种操作，并包含 robust list 的完整支持（`set_robust_list`/`get_robust_list`）。

**优缺点**：
- *优势*：RISC-V 主线自研了丰富的同步原语套件（6 种），可重入锁和 SleepMutex 的设计在内核中有实际价值。LoongArch 主线的 futex 实现完整度很高，对 pthread 同步原语的兼容性良好。
- *不足*：两条主线均缺失 RCU（读-复制-更新）和 seqlock 等无锁同步机制，这些在高并发读场景下能显著提升性能。RISC-V 主线的 futex requeue 实现不如 LoongArch 主线完整。

---

### 7. 进程间通信 (IPC)

**RISC-V 主线 (SWTC)**：

仅实现了 System V 共享内存 (`SHARED_MEMORY_MANAGER` 全局实例)，支持 `shmget`/`shmctl`/`shmat` 三个系统调用。共享内存物理页面通过 `SharedPages` 管理。

**LoongArch 主线 (SWTC-la)**：

完整实现了 System V 三大 IPC 机制：

- **共享内存** (`shm`)：`ShmManager` 提供 key→shmid→segment 两级索引，支持 `shmget`/`shmat`/`shmdt`/`shmctl` (IPC_STAT/IPC_SET/IPC_RMID/linux 特定 cmd)，管理进程级地址空间跟踪 (`pid_shmid_vaddr` 映射)。
- **信号量** (`sem`)：`SemManager` 管理信号量集合，支持 `semop` 操作数组（可为多信号量的原子操作）、UNDO 机制（通过 `SEM_UNDO` 标志在进程退出时自动恢复信号量值）、IPC_NOWAIT。
- **消息队列** (`msg`)：`MsgManager` 管理消息队列，支持 `msgsnd` 和 `msgrcv`（按消息类型接收），支持 `IPC_NOWAIT`、`MSG_EXCEPT`（接收非指定类型消息）、`MSG_NOERROR`（消息过长时截断不报错）。

**优缺点**：
- *优势*：LoongArch 主线的 System V IPC 实现非常完整，UNDO 机制、消息类型过滤、等待队列等细节处理到位，在该类项目进程间通信方面达到了较高的实现水准。
- *不足*：RISC-V 主线的 IPC 仅覆盖共享内存，缺失消息队列和信号量，两条主线的 IPC 子系统实现水平差异显著。两条主线均未实现 POSIX 消息队列 (mq_open/mq_send/mq_receive)。

---

### 8. 时间管理

**RISC-V 主线 (SWTC)**：

基于硬件定时器中断实现。`timer/` 子模块包含：`timed_task.rs`（基于 async 的定时任务）、`timeout_task.rs`（带超时的异步任务，如 `ksleep` 和 `TimeoutTaskFuture`）、`poll_queue.rs`（全局轮询队列 `POLL_QUEUE`）。系统调用实现了 `nanosleep`、`clock_gettime`、`clock_settime`、`clock_getres`、`clock_nanosleep`、`setitimer`（ITIMER_REAL/VIRTUAL/PROF）、`times`。`ITimerval` 结构是自研的 FFI 类型。

**LoongArch 主线 (SWTC-la)**：

基于 ArceOS 的定时器抽象，实现了 `clock_gettime`、`clock_settime`、`clock_getres`（含 CLOCK_REALTIME/MONOTONIC/MONOTONIC_RAW/BOOTTIME 等时钟源）。vDSO 提供了 `__vdso_clock_gettime` 和 `__vdso_gettimeofday` 的无锁快速路径，通过 seqlock 协议读取内核更新的数据页，在不需要进入内核的情况下完成时间查询。`timerfd` 将定时器抽象为文件描述符，可集成到 poll/epoll 机制中。`XThread` 包含 `TimeStat` 用于统计用户态/内核态时间。

**优缺点**：
- *优势*：LoongArch 主线的 vDSO seqlock 时间读取是显著的性能优化，timerfd 的设计扩展了定时器的事件驱动能力。RISC-V 主线的异步超时任务框架（`ksleep`）在协程调度环境中巧妙地将时间与执行流结合。
- *不足*：RISC-V 主线未实现 vDSO 时间加速，未实现 `timerfd`。两条主线均未实现高精度定时器 (hrtimer) 框架和 `adjtimex` 系统调用。

---

### 9. 系统信息

**RISC-V 主线 (SWTC)**：

实现 `uname` 系统调用，返回内核名、版本、机器架构等信息。`procfs` 实现了 `/proc/meminfo` 和 `/proc/mounts` 两个节点。

**LoongArch 主线 (SWTC-la)**：

实现 `uname`（通过 `sys_uname`）。`procfs` 更丰富，包含 `pid/` 子目录（进程信息）、`sys/` 子目录（系统参数）、以及 dummy 节点。`sysinfo` 系统调用返回系统统计信息（正常运行时间、内存使用等）。

**优缺点**：
- *优势*：LoongArch 主线的 procfs 和 sysinfo 覆盖度更高。
- *不足*：两条主线的系统信息导出均较为基础，procfs 的进程级详细信息（如 `/proc/[pid]/maps`、`/proc/[pid]/status`）未完整实现。未实现 `sysfs`。

---

### 10. 设备驱动

**RISC-V 主线 (SWTC)**：

自研驱动，涵盖：
- PLIC 中断控制器：完整的中断 claim/complete 流程
- QEMU NS16550 UART：字符设备读写 + 中断处理
- SiFive FU740 平台：UART + SPI 控制器 + SD 卡驱动
- virtio-blk：块设备读写，实现 `BlockDevice` trait
- SBI 封装：通过 ecall 调用 OpenSBI/RustSBI 服务

驱动通过 `BLOCK_DEVICE` 和 `CHAR_DEVICE` 全局实例暴露，通过条件编译 (`#[cfg(feature = ...)]`) 在 QEMU 和 FU740 平台间切换。

**LoongArch 主线 (SWTC-la)**：

全部依托 ArceOS `axdriver` 驱动框架，涵盖 virtio 全系列（virtio-blk/virtio-net/virtio-gpu）、ramdisk、PCI 总线枚举。驱动通过 ArceOS 设备注册机制自动发现和初始化，架构更标准化。

**优缺点**：
- *优势*：RISC-V 主线的自研驱动覆盖到真实硬件平台（FU740），SD 卡驱动和 SPI 控制器的实现体现了底层硬件交互能力。LoongArch 主线的 ArceOS 驱动体系覆盖了更广泛的设备类型。
- *不足*：RISC-V 主线的驱动缺少 virtio-net（网络走 smoltcp 软件模拟）和 GPU 驱动，LoongArch 主线的驱动虽然是现成的，但依赖整个 ArceOS 框架的引入。两条主线均缺少 USB 驱动栈和 NVMe 驱动。

---

### 11. 构建与测试

**构建系统**：

根 `Makefile` 串行构建两条主线：
```
make all → build-rv (cargo build + rust-objcopy + rust-lld) → kernel-rv
          build-la (cargo build) → kernel-la
```
通过 `RUSTUP_TOOLCHAIN` 环境变量隔离两套 Rust nightly 工具链，使用离线 vendor 目录支持无网络构建。条件编译通过 cargo features 管理平台差异和功能开关。

**测试体系 (SWTC-la)**：

`init.sh` 脚本实现了自动化测试流程：
- **LTP 测试子集**：约 160+ 个测试用例，覆盖文件操作、进程管理、信号、内存、时间、权限、IO 多路复用、资源限制等模块
- **lmbench**：系统调用延迟、上下文切换开销、管道带宽、文件读写带宽、mmap 延迟等性能指标
- **libc-test**：musl libc 兼容性验证
- **busybox**：通过 busybox 内置命令验证系统基本可用性

**SWTC 主线**：

主要是自带的三个嵌入用户程序的正确性验证（initproc、shell、runtestcase），缺乏系统化的自动化测试套件。

**优缺点**：
- *优势*：SWTC-la 的 LTP + lmbench + libc-test 三层测试体系覆盖了功能正确性和性能验证，测试链条完整。离线 vendor 和独立工具链的构建设计为无网络环境下的可复现性提供了保障。
- *不足*：SWTC 主线缺少系统化的自动化测试，仅依赖嵌入用户程序的验证。两条主线的测试均依赖 QEMU 模拟环境，未观察到在真实硬件上的测试报告。

---

## 系统集成与交互设计

**RISC-V 主线**：

启动流程从汇编入口 (`entry.S`) 开始，经 `fake_main` 进行地址偏移处理后进入 `rust_main`，依次初始化 BSS、Hart 本地存储、日志、内存管理、陷入向量、设备驱动、异步执行器、加载器、文件系统、竞赛评测、定时器、网络，最后派发内核线程并进入 `executor::run_until_idle()` 异步轮询循环。中断/异常通过统一的 `user_trap` 分发，系统调用号匹配后调用相应子系统实现。

**LoongArch 主线**：

主入口在 `main.rs`，创建初始进程、挂载根文件系统、初始化标准 I/O 后执行 `init.sh` 脚本。`entry.rs` 的 `run_user_app` 负责 ELF 加载、地址空间创建、任务派发。系统调用通过 `#[register_trap_handler(SYSCALL)]` 注册处理器，`handle_syscall_impl` 利用 `Sysno` 枚举匹配 248 个系统调用号并分发至 xapi 层。

**设计特点**：

- 两条主线各自独立运行，共享顶层 Makefile 但不共享内核代码（模块间无交叉引用），这在竞态条件下为适配不同评测平台提供了灵活性。
- RISC-V 主线使用 async/await 协程模型实现 I/O 异步化，在单体内核中较为少见。
- LoongArch 主线的 `inherit_methods!` 宏通过自动委托减少样板代码。

---

## 细则评价表格

| 评价条目 | 是否实现及完整度 | 关键发现 | 评价 |
|----------|-----------------|----------|------|
| **内存管理** | 已实现。RISC-V 主线完整度约 80%（SV39+COW+VMA+mmap/brk+shm，缺 swap/huge page）；LoongArch 主线约 82%（多架构页表+xvma+COW，缺 swap） | RISC-V 主线自研 SV39 页表的 COW 通过 PTE 保留位 (bit8) 实现，设计精巧。LoongArch 主线的 xvma 泛型文件后端 mmap 区域管理具有较好的扩展性。 | 两条主线在核心内存管理功能上均完整，COW 实现正确。主要差距在于 swap 和大页支持的缺失，限制了内存过载场景和 TLB 优化。 |
| **进程管理** | 已实现。两条主线完整度均约 85%（fork/clone/exec/wait/进程组/会话，缺 cgroup/namespace） | LoongArch 主线的 clone flags 兼容性检查逻辑详尽，覆盖了全部标准标志组合。RISC-V 主线的 COW fork 实现完整。 | 进程生命周期管理功能完备，能够支撑复杂的多进程应用（如 busybox/LTP）。容器化支持缺失是主要短板。 |
| **文件系统** | 已实现。RISC-V 主线约 75%（自研 VFS+FAT32+虚拟 FS，缺 ext4）；LoongArch 主线约 85%（ArceOS VFS+ext4+虚拟 FS 全家桶+fanotify） | RISC-V 主线自研的 FAT32 实现包含完整 LFN 解析，FastPathCache 设计具有性能优化价值。LoongArch 主线的 ext4 支持显著扩展了存储兼容性。 | RISC-V 主线的文件系统自研程度高但支持的文件系统有限。LoongArch 主线在实用性和兼容性上更强，但 ext4 依赖 C FFI 增加了维护负担。 |
| **交互设计** | 已实现。两条主线均支持基本 shell 交互和测试脚本自动运行 | LoongArch 主线通过 `init.sh` 集成了 LTP/lmbench/busybox 的多层自动化流程。RISC-V 主线仅有自研简易 shell 和几个嵌入用户程序。 | LoongArch 主线的测试设施成熟度明显优于 RISC-V 主线，后者偏向最小可用验证。两者均未提供交互式调试接口（如内置 monitor）。 |
| **同步原语** | 已实现。RISC-V 主线约 75%（6 种自研原语，缺 RCU/seqlock）；LoongArch 主线约 78%（futex 全套+ArceOS Mutex，缺 RCU） | RISC-V 主线自研的 SleepMutex 利用 async/await 实现阻塞等待，ReMutex 支持可重入，设计合理。LoongArch 主线的 futex 支持 BITSET/REQUEUE/robust list，完整度高。 | 两条主线在内核级同步和用户态 futex 支持上均完整。RCU 等高性能无锁机制的缺失限制了读密集型工作负载下的扩展性。 |
| **资源管理** | 已实现。RISC-V 主线约 50%（rlimit+sysinfo）；LoongArch 主线约 60%（完整 rlimit+prlimit64+sysinfo） | LoongArch 主线的 rlimit 覆盖了 RLIMIT_STACK/NOFILE/AS/CPU 等常用资源项。RISC-V 主线仅实现了 getrlimit/setrlimit 基础框架。 | 基本资源限制功能已具备，但在资源隔离（cgroup）和审计方面存在明显不足。两者均未实现内核同页合并 (KSM) 等内存优化。 |
| **时间管理** | 已实现。RISC-V 主线约 65%（基础定时器+clock_gettime/nanosleep+异步超时，缺 vDSO/timerfd）；LoongArch 主线约 80%（完整 clock 系列+vDSO seqlock+timerfd+时间统计） | LoongArch 主线的 vDSO seqlock 无锁时间读取是该项目最突出的性能优化设计之一。timerfd 将定时器与事件驱动机制集成。 | LoongArch 主线在时间管理上表现突出，vDSO 的设计和实现具有实际性能价值。RISC-V 主线的异步超时任务是其协程模型的自然延伸，但功能覆盖度不足。 |
| **系统信息** | 已实现。RISC-V 主线约 35%（uname+基础 procfs）；LoongArch 主线约 50%（uname+pid procfs+sysinfo） | LoongArch 主线的 `/proc/pid/` 子目录提供了进程级信息查询能力。 | 系统信息导出为基础水平，与 Linux 完备的 procfs/sysfs 相比差距明显。在调试和监控场景下提供的可见性有限。 |
| **网络子系统** | 已实现。两条主线均约 70%（TCP/UDP/Unix socket，缺 IPv6 完整/raw socket/netfilter） | 两条主线均基于 smoltcp 用户态协议栈，提供了基本的 TCP/UDP/Unix socket 功能，Unix socket 实现了本地 IPC。 | 基本的套接字通信功能可用，但在协议栈性能（用户态 vs 内核态）、IPv6 完整度、网络安全过滤方面存在受限。 |
| **信号子系统** | 已实现。RISC-V 主线约 80%（POSIX 信号完整，缺实时信号排队）；LoongArch 主线约 85%（完整 POSIX+实时排队+多架构抽象） | `xsignal` 的多架构设计是所有子系统中跨架构复用最成功的案例，同时支持四种 CPU 架构。实时信号排队和 rt_sigtimedwait 提升了 LoongArch 主线的 POSIX 兼容性。 | LoongArch 主线的信号系统设计优秀。RISC-V 主线在自研约束下也实现了基本完整的信号处理，实时信号排队的缺失影响较小。 |
| **IPC 子系统** | 部分实现。RISC-V 主线约 35%（仅 System V 共享内存）；LoongArch 主线约 85%（System V 三大件完整，含 UNDO 机制） | LoongArch 主线的 ShmManager/SemManager/MsgManager 实现了 System V IPC 的完整语义，UNDO 机制和消息类型过滤等细节到位。 | 两条主线的 IPC 实现水平差异显著。RISC-V 主线在此方面有较大的完善空间。两者均缺失 POSIX 消息队列。 |
| **设备驱动** | 已实现。RISC-V 主线约 55%（PLIC/UART/virtio-blk/SPI/SD 覆盖基本）；LoongArch 主线约 70%（ArceOS 驱动体系覆盖 virtio 全系列+PCI） | RISC-V 主线自研驱动覆盖到 SiFive FU740 真实硬件平台，展现了跨平台适配能力。LoongArch 主线依赖现成框架但设备覆盖更广。 | 驱动覆盖满足 QEMU 虚拟环境运行需求。RISC-V 主线对真实硬件（FU740）的适配是其亮点，但整体驱动生态不如 LoongArch 主线丰富。 |
| **构建与测试** | 已实现。构建系统完整度约 85%（双工具链+离线 vendor+条件编译）；测试完整度：RISC-V 约 20%、LoongArch 约 70% | 根 Makefile 的离线构建设计细致（通过环境变量隔离工具链、vendor 目录离线化）。SWTC-la 的 LTP+lmbench+libc-test 三层测试体系覆盖了功能正确性和基准性能。 | SWTC-la 的测试基础设施在同类项目中属于完善级别。SWTC 主线的测试明显不足，缺乏系统化验证手段。 |

---

## 整体实现完整度

基于两条主线的综合评估（以 Linux 5.x 内核功能集为满分基准，考虑功能深度和覆盖度）：

- **SWTC (RISC-V)**：整体完整度约 **65-70%**。在内存管理、进程管理、文件系统（FAT32）、信号处理等核心子系统上自研实现完整，但 IPC、驱动覆盖、测试体系方面存在明显短板。
- **SWTC-la (LoongArch)**：整体完整度约 **75-80%**。借助 ArceOS 框架和自研的 xapi/xcore/xmodules 层，在系统调用覆盖度（248 个 Sysno）、IPC（System V 三大件）、vDSO、测试体系方面达到了较高的完成水准。

两条主线的差异化实现策略使项目在整体上同时具备“自研深度”（RISC-V 主线）和“功能广度”（LoongArch 主线），但两条主线间的代码复用度极低，维护负担较重。

---

## 动态测试的设计与结果

### 测试框架设计

SWTC-la 的 `init.sh` 实现了多层次自动化测试流水线：

1. **功能正确性层 (LTP)**：运行约 160+ 个 LTP 测试用例（`ltp_subset`），以 pass/fail 方式验证系统调用实现的正确性。
2. **性能基准层 (lmbench)**：测量系统调用延迟、上下文切换开销、管道/文件 I/O 带宽、mmap 延迟等微基准指标。
3. **兼容性层 (libc-test)**：验证 musl libc 的 API 兼容性。
4. **集成验证层 (busybox)**：通过 busybox 内置命令测试系统在实际应用负载下的综合表现。

### 测试环境

- RISC-V：`qemu-system-riscv64` + `kernel-rv` ELF
- LoongArch：`qemu-system-loongarch64` + `kernel-la` ELF + `disk.img` (rootfs)

### 观察到的测试策略

测试采用“启动即测试”的模式：内核启动后自动执行 `init.sh` 脚本，依次运行各测试套件并将结果输出到串口。这种设计简化了测试执行流程，适合自动化评测环境。

SWTC 主线仅依赖三个嵌入用户程序的自我验证（initproc 退出码检查、shell 基本命令执行、runtestcase 竞赛用例执行），缺乏量化的测试结果收集机制。

---

## 总结评价

SWTC 是一个在单一仓库中并行维护 RISC-V64 和 LoongArch64 两条独立内核主线的操作系统内核项目，代码总量约 47,803 行 Rust，系统调用覆盖从 113 个（RISC-V）到 248 个（LoongArch）不等。

**核心优势**：

1. **双架构差异化实现策略**：两条主线采用不同的设计哲学——RISC-V 主线追求自研深度（SV39 页表、伙伴系统、FAT32、COW 均为自研），LoongArch 主线追求功能广度和兼容性（基于 ArceOS 框架，覆盖 ext4、System V IPC 三大件、vDSO、248 个系统调用）。这种策略使项目在两个维度上均有建树。
2. **自研能力证明**：RISC-V 主线的约 26,700 行代码几乎全部为团队自研，从页表操作、物理帧分配、FAT32 实现到异步协程执行器，体现了从零构建内核的完整能力。
3. **高级特性实现**：LoongArch 主线的 vDSO seqlock 无锁时间读取、System V IPC 完整语义（含 UNDO 机制）、多架构信号处理框架 (`xsignal`) 等特性，在技术深度和工程实用性上均有亮点。
4. **测试体系**：SWTC-la 的 LTP + lmbench + libc-test 三层自动化测试覆盖了功能正确性和基准性能，测试链条完整。

**主要不足**：

1. **两条主线缺乏代码复用**：RISC-V 和 LoongArch 两条主线在内核层面完全独立，未抽取共享模块（如 xsignal 这样的多架构组件仅存在于 LoongArch 主线），重复劳动较多。
2. **功能缺失面较广**：两条主线均缺失 cgroup/namespace 容器支持、swap、内核抢占、RCU、大页、eBPF、seccomp 等现代操作系统内核重要特性。
3. **RISC-V 主线的测试与 IPC 薄弱**：RISC-V 主线缺乏系统化的测试套件，IPC 仅实现了 System V 共享内存，与 LoongArch 主线差距显著。
4. **LoongArch 主线的外部依赖**：对 ArceOS 框架和 lwext4 (C FFI) 的依赖虽然加速了开发，但也引入了较大的外部代码基数和维护复杂性。
5. **Stub 处理**：LoongArch 主线中存在部分系统调用被静默处理为返回成功（如 `flock`、`fadvise64`），对依赖这些调用的应用程序可能造成隐蔽的兼容性问题。