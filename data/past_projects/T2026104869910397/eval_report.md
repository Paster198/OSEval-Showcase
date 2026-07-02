# CoreCraft OS 内核项目技术画像与评估报告

---

## 一、项目基本信息

| 条目 | 内容 |
|------|------|
| **项目名称** | CoreCraft |
| **目标架构** | RISC-V 64 (SV39) / LoongArch 64 |
| **实现语言** | Rust (约 87,000 行) + C FFI (lwext4 库) |
| **内核类型** | 宏内核 (Monolithic Kernel) |
| **生态归属** | Linux ABI 兼容层 |
| **Rust 工具链** | nightly-2024-05-01 |
| **构建系统** | Cargo workspace (13 个子 crate) |
| **地址空间模型** | 高半内核虚拟地址 (RISC-V: 0xffffffc0_xxxxxxxx, LoongArch: 0x9000_xxxxxxxx) |
| **页表格式** | RISC-V: Sv39 (3 级, 4KB 页), LoongArch: 4 级 (4KB 页) |
| **调度模型** | 单核 FIFO 协程调度 |
| **已实现系统调用** | 237 个 (380 个 dispatch 分支) |
| **平台支持** | riscv64+qemu, riscv64+vf2, loongarch64+qemu, loongarch64+2k1000 |
| **主要特点** | 双架构统一抽象、策略-执行分离的内存故障处理、多后端 VFS (ext4/devfs/procfs/tmpfs)、完整 POSIX 信号子系统、嵌入式 LTP 测试框架 |

---

## 二、子系统实现概览

### 2.1 架构抽象层

**实现内容**：启动引导、中断/异常处理、页表操作、上下文切换、信号跳板、SBI 接口 (RISC-V)、DMW 窗口配置 (LoongArch)。

**实现完整程度**：约 85%。双架构核心功能完整，缺少多核启动支持、FPU/向量寄存器上下文保存。

**优点**：

1. **双架构统一抽象设计**：通过 `ArchInterface` trait + `#[cfg_attr]` 条件编译而非 `#[cfg]` 代码分支，架构边界清晰。`crate_interface` 宏实现了类似依赖注入的模式，架构代码无需直接依赖内核内部模块。
2. **引导页表策略务实**：RISC-V 使用 2MiB 大页映射简化早期页表，采用"链接时高半、加载时低半"策略——ELF 以虚拟地址链接，通过 `objcopy --change-section-lma` 调整加载地址，使得 MMU 启用前仅需 PC 相对寻址。
3. **LoongArch DMW 窗口利用**：利用 DMW0/DMW1 直接映射窗口处理物理内存访问，避免了在页表中维护内核直接映射区域的复杂性。
4. **非对齐访存模拟**：LoongArch 实现了 603 行（含约 500 行汇编）的完整非对齐访存模拟 (`unaligned.rs` + `unaligned.S`)，覆盖了硬件不支持非对齐访问的情况。
5. **信号跳板隔离设计**：使用独立的两级静态页表将 `_sigreturn` 跳板映射到用户地址空间固定位置，不占用用户地址空间布局。

**缺点与限制**：

1. **单核设计**：`Processor` 结构仅跟踪一个 `current` 任务，未实现 SMP 启动协议（如 RISC-V SBI HSM 扩展、LoongArch IPI 核间中断），`percpu` 变量仅为预留。
2. **FPU/向量上下文缺失**：上下文切换 (`KContext`) 仅保存整数寄存器（ra/sp/s0-s11），未保存浮点/向量寄存器，多线程浮点计算存在寄存器污染风险。
3. **LoongArch 内存大小硬编码**：内存区域硬编码为 512 MiB (`0x9000_0000..0xB000_0000`)，未解析设备树 `memory` 节点获取实际内存大小。
4. **RISC-V SBI 使用传统接口**：未使用 SBI v0.2+ 的 HSM/DBG/SRST 等扩展。

---

### 2.2 内存管理

**实现内容**：栈式物理帧分配器、伙伴系统内核堆、VMA 管理器（BTreeMap 区间树）、COW/延迟分配页面故障处理、mmap 地址空间分配器、System V 共享内存。

**实现完整程度**：约 72%。核心虚拟内存功能扎实，COW 和延迟分配实现正确，缺少大页、页面回收/交换、KSM 等高级特性。

**优点**：

1. **策略-执行分离的故障处理**：`FaultHandler`（策略层）与 `MemorySet`（执行层）分离设计清晰。`FaultHandler::handle_fault()` 根据 VMA 属性、访问类型和故障原因决策，返回 `FaultAction` 枚举（`AllocAnonPage`/`LoadFilePage`/`LoadElfPage`/`MapSharedPage`/`DoCow`），`MemorySet::handle_page_fault()` 执行具体操作。此设计使故障处理逻辑可测试、可扩展。
2. **COW 优先级正确**：在 `kernel_interrupt` 中 COW 故障优先于延迟分配处理：
   ```rust
   StorePageFault(addr) => memory_set
       .handle_page_fault(addr, AccessType::Write, FaultCause::Cow)
       .or_else(|_| memory_set.handle_page_fault(addr, AccessType::Write, FaultCause::Lazy)),
   ```
   这确保了 COW 语义正确，避免了延迟分配错误地满足 COW 页面的写操作。
3. **VMA 后端类型枚举**：`VmaBackend::Anonymous/Physical/File/Shared` 清晰分类，简化了页面故障时的后端分发逻辑，每种后端的数据来源和处理方式物理隔离。
4. **RAII 帧回收**：`FrameTracker` 封装物理帧，`Drop` 时自动回收到 `StackFrameAllocator.recycled` 栈，避免了显式回收调用导致的内存泄漏。
5. **用户态地址验证基础设施**：`user_translated_ref<T>()`/`user_safe_translated_str()` 等安全访问辅助函数提供了一致的用户内存访问模式，利用 RISC-V SUM 位直接解引用用户指针，避免了显式地址空间切换。

**缺点与限制**：

1. **物理帧分配器过于简单**：栈式分配器 (`StackFrameAllocator`) 在长期运行中可能产生外部碎片，缺乏伙伴系统或 SLAB 分配器的物理内存管理能力。回收帧仅在栈中线性排列，无合并相邻帧的机制。
2. **仅支持 4KB 页面**：`PageTable::map_page()` 仅实现 4KB 映射，`MappingFlags` 虽定义了 `Huge` 标志但未被使用，缺少 2MiB/1GiB 大页支持。
3. **无页面回收与交换**：未实现 kswapd、LRU 页面回收、交换分区/文件支持，内存压力下无降级路径。
4. **无 NUMA 感知**：单节点设计，未区分不同物理内存域的访问延迟。
5. **地址空间分配器有限**：`AddressSpaceAllocator` 基于简单区间树管理 `[USER_MMAP_TOP, USER_STACK_TOP)` 范围，无 ASLR 随机化支持。

---

### 2.3 进程管理

**实现内容**：TCB 管理、FIFO 调度器、PID/TID 分配、clone/fork/exec/exit/waitpid、文件描述符表、用户地址空间验证、exit_group 同步语义。

**实现完整程度**：约 75%。单核进程管理全面，TCB 设计详尽（含凭证、能力、资源限制、命名空间），缺少多核调度和实时调度策略执行。

**优点**：

1. **TCB 设计详尽**：`TaskControlBlock` 是项目中最大的数据结构，包含执行上下文、内存管理、文件系统、信号处理（含实时/非实时队列）、进程关系（parent/children/pgid/sid）、凭证（uid/euid/suid/fsuid/gid/egid/sgid/fsgid/groups）、Linux 能力集（cap_effective/permitted/inheritable/bounding）、间隔定时器、资源限制（memlock/fsize/nproc/core）、命名空间（UTS/时间）、futex 健壮列表、I/O 优先级、调度属性等字段，覆盖了 Linux task_struct 主要语义。
2. **Exit_group 同步语义正确**：`run_tasks()` 中在上下文切换前检查 Zombie 状态：
   ```rust
   if task.inner_exclusive_access().task_status == TaskStatus::Zombie {
       drop(task);
       continue;
   }
   ```
   确保被 `exit_group` 终结的兄弟线程不会多跑一轮才处理 SIGKILL，维护了 POSIX exit_group 的原子性语义。
3. **PID 自动回收**：`PidHandle` RAII 模式确保进程退出时自动回收 PID，避免了 PID 泄漏。
4. **Futex 实现完整**：支持 `futex_wait`/`futex_wake`/`futex_requeue`/`futex_wait_bitset`/`futex_wake_bitset`（`os/src/task/futex.rs`），包括基于物理地址的 `FutexKey` 跨进程 futex 和超时机制。
5. **文件描述符表设计合理**：`FdTable` 使用 `Vec<Option<Fd>>` 动态扩展，最大 1024 FD，通过 `Arc<Mutex<FdTable>>` 支持 CLONE_FILES 语义，`timerfd_cnt` 计数器优化了 timerfd 查找。

**缺点与限制**：

1. **调度器仅为 FIFO**：`TaskManager` 使用 `VecDeque` 就绪队列，无优先级调度、无时间片轮转、无 CFS/实时调度策略（数据结构已定义但未实现对调度决策的影响）。
2. **单核设计**：`Processor` 单 `current` 任务结构无法支持 SMP。
3. **无内核抢占**：不检查 `need_resched` 标志，任务仅在主动让出或定时器中断时切换。
4. **命名空间不完整**：仅支持 UTS 和时间命名空间偏移，缺少 mount/pid/net/user/cgroup 命名空间。
5. **Cgroups 完全缺失**：无任何 cgroup 子系统实现。

---

### 2.4 文件系统

**实现内容**：VFS 抽象层（Dentry/Inode/File/SuperBlock/FileSystemType trait）、ext4 后端（lwext4 C FFI）、procfs（12+ 文件）、devfs（7+ 设备）、tmpfs/memfs、LRU 块缓存、POSIX 管道（环形缓冲区）。

**实现完整程度**：约 78%。VFS 架构优雅，ext4 集成扎实，procfs/devfs 实现全面，管道语义正确，但 ext4 写操作性能可优化。

**优点**：

1. **多后端统一 VFS 架构**：devfs/procfs/tmpfs/memfs/ext4 共享同一套 Dentry/Inode/File trait 定义（`vfs-defs/`），各自有独立的实现策略。`FileSystemManager` 通过 `BTreeMap<String, Arc<dyn FileSystemType>>` 管理注册的文件系统类型，新文件系统类型可插件式添加。
2. **lwext4 C 库的无缝集成**：通过 `BlockDevice` trait 桥接实际块设备、`GuardSlot` 锁保护、瞬态文件句柄模式，将单线程设计的 lwext4 C 库安全地集成到多任务 Rust 内核中。`IO_LOCK` + `GuardSlot` 机制防止重入。挂载时进行超级块健康检查和恢复尝试 (`ext4_recover`)。
3. **procfs 自引用结构简洁**：`/proc/self` 通过符号链接指向当前进程的 PID 目录，`/proc/[tid]/exe` 为可执行文件路径的符号链接，实现简洁。
4. **管道实现完整**：`PipeRingBuffer` 环形缓冲区（默认 16 页/64 KiB），阻塞/非阻塞语义正确，支持 `fcntl(F_SETFL, O_NONBLOCK)` 和 `fcntl(F_SETPIPE_SZ)`，`CAP_SYS_RESOURCE` 权限检查到位。
5. **LRU 块缓存**：16,384 条目 LRU 缓存，`get_ref<T>()`/`get_mut<T>()` 提供类型安全访问，`Drop` 时自动写回修改的块。

**缺点与限制**：

1. **ext4 写操作使用瞬态文件句柄**：每次 `write_at` 都执行 `open → seek → write → close` 流程，频繁的 `ext4_fopen2`/`ext4_fclose` 调用带来显著的性能开销。对比读操作同样使用瞬态模式，小 I/O 场景下吞吐量受限。
2. **procfs 文件为静态数据**：`/proc/meminfo`、`/proc/cpuinfo` 等文件的内容为硬编码或启动时快照，不反映实时状态（如 MemFree 不会随分配变化更新）。
3. **devfs 随机数设备不随机**：`/dev/urandom` 返回固定字节，未接入 CSPRNG。
4. **文件锁支持待确认**：定义了 `flock` 系统调用常量，但源码中未找到与 BSD 文件锁（`flock` LOCK_SH/LOCK_EX/LOCK_UN）或 POSIX 记录锁（`fcntl` F_SETLK/F_GETLK）对应的锁管理器实现。
5. **无日志文件系统原生支持**：ext4 日志依赖于 lwext4 C 库内部实现，内核自身无通用日志层（jbd2 接口）。

---

### 2.5 信号子系统

**实现内容**：完整 POSIX 信号集（STANDARD + RTMIN-RTMAX）、信号处理器注册/管理、信号掩码/阻塞、sigreturn 跳板机制、实时信号队列、信号栈 (sigaltstack)、同步信号强制投递、进程组信号。

**实现完整程度**：约 90%。信号子系统是项目中实现最全面的子系统之一，覆盖了 POSIX 信号的核心语义和边界情况。

**优点**：

1. **信号集定义完整**：`SignalFlags` 位图覆盖了 SIGHUP(1) 到 SIGSYS(31) 的全部标准信号，以及 SIGRTMIN(32) 到 SIGRTMAX(64) 的 33 个实时信号。`SYNCHRONOUS_MASK` 正确区分了同步信号（SIGSEGV/SIGBUS/SIGILL/SIGTRAP/SIGFPE/SIGSYS）。
2. **实时/非实时信号队列分离**：非实时信号使用 `Option<SigInfo>` 去重（多次发送只保留一次），实时信号使用 `Vec<SigInfo>` 按发送顺序排队，符合 POSIX 规范。
3. **信号序列号机制**：`signal_seq` 字段在信号投递时递增，用于 `pselect`/`ppoll` 等系统调用检测信号竞态（EINTR 判定），防止信号丢失。
4. **强制投递语义正确**：同步信号（如 SIGSEGV）不可被阻塞，重入时直接通过 `force_sig` 终止进程，符合 Linux 语义。
5. **信号跳板地址选择巧妙**：RISC-V (`0xffff_ffc1_0000_0000`) 和 LoongArch (`0x40_0000_0000`) 的跳板地址均选择在用户地址空间外的固定位置，通过两级静态页表映射，不与用户地址空间冲突。

**缺点与限制**：

1. **无 SA_RESTART 实际执行**：`SigAction` 定义了 SA_RESTART 标志位，但信号处理返回后未检查该标志以决定是否自动重启被中断的系统调用。被信号中断的系统调用始终返回 EINTR。
2. **信号处理器默认动作不完整**：SIGSTOP/SIGTSTP/SIGTTIN/SIGTTOU 的默认动作为停止进程，但当前实现中停止状态的进程管理（job control）未完全实现。
3. **Core dump 未实现**：SIGQUIT/SIGABRT/SIGSEGV 等信号的默认动作包含 core dump，但未生成 core 文件。

---

### 2.6 系统调用

**实现内容**：237 个系统调用常量（覆盖编号 0-456）+ 自定义 poweroff(2025)，380 个 dispatch 分支。涵盖文件系统、进程管理、内存管理、信号、定时器、AIO、futex、epoll、inotify 等。

**实现完整程度**：约 65%。文件和进程管理系统调用覆盖广泛，但网络栈仅限于 AF_ALG，部分系统调用仅有常量定义无实际实现。

**优点**：

1. **覆盖范围广**：237 个系统调用编号涵盖了 Linux 核心 ABI 的主要部分，包括 AIO（`io_setup`/`io_submit`/`io_getevents`/`io_destroy`/`io_cancel`）、epoll（`epoll_create1`/`epoll_ctl`/`epoll_pwait`）、inotify（`inotify_init1`/`inotify_add_watch`）、timerfd（`timerfd_create`/`timerfd_settime`/`timerfd_gettime`）等较高级的接口。
2. **AIO 可扩展架构**：`AioEngine` trait 定义了异步 I/O 接口，当前 `SyncEngine` 在 submit 时同步执行，但架构支持未来接入真正的异步 I/O 引擎。
3. **futex 健壮列表支持**：实现了 `set_robust_list`/`get_robust_list` 系统调用，在任务异常退出时内核可遍历健壮列表释放互斥锁。
4. **ioctl 通用化**：定义了 `Ioc`/`Ior`/`Iow`/`Iowr` 宏用于构建 ioctl 命令码，支持 `tcgetattr`/`tcsetattr`/`TIOCGPGRP`/`TIOCSPGRP` 等终端 ioctl。

**缺点与限制**：

1. **大量系统调用仅有常量**：`SYSCALL_TKILL`/`SYSCALL_MQ_OPEN`/`SYSCALL_ADD_KEY`/`SYSCALL_REQUEST_KEY`/`SYSCALL_KEYCTL` 等 100+ 个系统调用定义了常量但 dispatch 中无分支或分支仅返回 `-ENOSYS`。
2. **网络栈极度有限**：`SYSCALL_SOCKET`/`SYSCALL_BIND`/`SYSCALL_ACCEPT` 等仅在 AF_ALG 路径上有实现，无 AF_INET/AF_UNIX 支持。
3. **Seccomp 未执行过滤**：`prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ...)` 常量已定义，但未实现 BPF 过滤器检查和系统调用过滤。
4. **getrandom 未实现**：`getrandom` 系统调用定义存在但未实现，用户态无法获取内核 CSPRNG 输出。

---

### 2.7 设备驱动

**实现内容**：VirtIO 传输层（MMIO + PCI）、VirtIO 块设备、网络设备、GPU、输入设备、控制台、VSock；AHCI SATA 驱动、e1000/ixgbe 网络驱动；StarFive VisionFive2 SD 卡驱动。

**实现完整程度**：约 60%。块设备支持完善，网络驱动有完整代码但未与协议栈深度集成，缺少 NVMe/USB 支持。

**优点**：

1. **VirtIO 驱动框架自研完整**：`virtio-drivers/` 子 crate 包含约 3,000+ 行 Rust 代码，覆盖 MMIO 和 PCI 两种传输层、完整的 virtqueue 实现（描述符表/available/used 环）、块设备/网络/GPU/输入/VSock 设备。
2. **多平台块设备抽象**：通过条件编译在四种平台组合间选择块设备驱动（VirtIO-Blk / VF2-SD / SATA），`BlockDevice` trait 统一接口。
3. **真实硬件驱动覆盖**：支持 AHCI SATA 控制器 (562 行)、Intel e1000 (300+ 行) 和 ixgbe 10GbE (630 行) 网络驱动、VisionFive2 SD 卡寄存器级驱动 (1,233 行)。
4. **驱动架构解耦**：驱动代码通过 `#[cfg]` 条件编译与内核主逻辑分离，`os/src/drivers/` 仅作设备选择和全局单例暴露。

**缺点与限制**：

1. **网络驱动与协议栈脱节**：VirtIO 网络、e1000、ixgbe 驱动已实现包收发，但内核无 TCP/IP 协议栈，网络设备无法被用户态 socket 使用。
2. **中断驱动异步 I/O 未实现**：块设备和网络设备均采用轮询或同步模式，无中断处理程序注册，无法利用硬件中断进行异步通知。
3. **缺少 NVMe 驱动**：无 NVMe 控制器和命令队列实现，无法支持现代高性能 SSD。
4. **缺少 USB 栈**：无 USB 主机控制器驱动（UHCI/OHCI/EHCI/xHCI）、无 USB 设备枚举和类驱动。
5. **GPU 驱动仅限 framebuffer**：无 DRM/KMS 接口、无 3D 加速支持。
6. **输入设备集成不深**：无输入事件到终端/用户态的事件转发机制（如 evdev）。

---

### 2.8 定时器子系统

**实现内容**：BinaryHeap 定时器框架、Futex 超时定时器、间隔定时器 (ITimer)、Timerfd、架构定时器接口（SBI set_timer / LA CSR）。

**实现完整程度**：约 85%。核心定时功能完整，timerfd 实现符合 Linux 语义。

**优点**：

1. **Futex 超时序列号保护**：`futex_wait_seq` 机制防止虚假超时唤醒——在任务被超时定时器唤醒时，检查 `futex_wait_seq` 是否与等待时的序列号一致，确保唤醒确由超时引起而非 futex_wake。
2. **Timerfd 优化**：`fd_table` 中维护 `timerfd_cnt` 计数器，`timerfd_create`/`timerfd_close` 时调整计数，避免遍历所有 FD 来检查 timerfd 存在。
3. **架构无关定时器接口**：定时器框架通过 `TimeSpec` 与架构定时器解耦，架构层仅需提供设置下一次定时器中断的能力。

**缺点与限制**：

1. **定时器精度受限于调度粒度**：定时器检查在 `run_tasks()` 调度循环中进行，不在中断上下文中处理。长时间无调度点（如用户态计算密集型任务）会延迟定时器触发。
2. **无高精度定时器 (hrtimer)**：使用 BinaryHeap（最小堆）管理定时器，插入为 O(log n)，但缺乏 Linux hrtimer 的红黑树高效范围查询。
3. **PROF/VIRTUAL itimer 未与调度集成**：`TCBITimer` 包含虚拟/概况定时器字段，但调度器中未更新时间累计，`ITIMER_VIRTUAL`/`ITIMER_PROF` 的实际触发依赖未完整实现。

---

### 2.9 网络与 Socket

**实现内容**：AF_ALG 协议族（加密 API socket）、9 种哈希算法 + HMAC 变体、skcipher/AEAD 注册表。

**实现完整程度**：约 25%。AF_ALG 实现非常完整，但整个网络栈仅限于加密 API socket，缺少 TCP/IP/UDP/Unix Domain Socket。

**优点**：

1. **AF_ALG 实现完整**：支持完整的 socket(AF_ALG) → bind(算法选择) → setsockopt(密钥) → accept(请求 socket) → read/write(数据 I/O) 流程，哈希计算使用 RustCrypto 系列 crate 实现真实计算。
2. **算法注册表可扩展**：`AlgKind` 枚举 + HashMap 注册表模式便于添加新算法。
3. **支持 LTP 回归测试**：VMAC 算法占位（名称识别但不计算）专为满足 LTP af_alg04 测试需求，体现了测试驱动的设计考量。

**缺点与限制**：

1. **整个 TCP/IP 协议栈缺失**：无 AF_INET/AF_INET6 地址族，无 SOCK_STREAM/SOCK_DGRAM/SOCK_RAW 实现，无 IP/UDP/TCP 协议处理。网络驱动的包收发能力无法被用户态使用。
2. **AF_UNIX 缺失**：无 Unix Domain Socket 支持，无法进行本地进程间 socket 通信。
3. **Netlink 缺失**：无 netlink socket，无法进行内核-用户态路由/网络配置通信。
4. **无 Berkeley Packet Filter**：未实现 BPF 或 eBPF 虚拟机，限制了包过滤和 seccomp 过滤器的实现能力。

---

## 三、动态测试设计与结果

### 3.1 测试框架架构

项目内建了嵌入式测试运行时 (`test_runtime.rs`)，在编译时将 busybox、poweroff 程序、测试脚本嵌入内核镜像。启动流程：

1. 内核挂载 ext4 根文件系统
2. 初始化 devfs/procfs/tmpfs
3. 部署 busybox 和自定义测试程序到文件系统
4. 执行 `/etc/init.d/rcS` 启动脚本
5. 脚本调用 LTP 测试用例或自定义测试逻辑
6. 测试完成时调用 `poweroff` 系统调用退出

### 3.2 测试配置

`ENABLED_TESTS` 常量数组提供声明式测试选择，开发者可精确控制运行哪些测试用例。LTP 集成支持：
- 自定义 `selfltp_glibc.sh`/`selfltp_musl.sh` 包装脚本
- 按行号精确定位和筛选 LTP 测试用例
- 针对 musl libc 和 glibc 的不同 ABI 行为适配

### 3.3 动态测试执行情况

由于分析环境中缺少 QEMU 9.2.1 二进制文件和 SD 卡镜像，无法执行动态测试。构建验证已成功完成（RISC-V 64 和 LoongArch 64 目标均构建通过），测试框架的设计表明项目具备完整的自动化测试能力，但无运行时测试结果可供评估。

---

## 四、细则评价

| 评价条目 | 是否实现 | 完整度 | 关键发现 | 评价 |
|----------|----------|--------|----------|------|
| **内存管理** | 是 | 72% | 策略-执行分离的页面故障处理架构设计出色；COW 优先级正确；RAII 帧回收；VMA 后端类型枚举清晰；但仅有 4KB 页面支持，无大页/页面回收/交换/NUMA；物理帧分配器过于简单缺乏碎片管理 | 核心功能正确性高，设计模式值得肯定，但高级内存管理特性不足 |
| **进程管理** | 是 | 75% | TCB 设计详尽覆盖 Linux task_struct 主要语义；exit_group 同步语义正确；futex 实现完整含序列号保护；但仅 FIFO 调度无优先级/CFS/实时策略执行；单核设计无 SMP；无内核抢占 | 单核进程管理全面细致，TCB 详尽可能为未来调度器改进留有充分空间 |
| **文件系统** | 是 | 78% | 多后端统一 VFS 架构优雅；ext4/lwext4 集成通过 GuardSlot 锁保护安全；procfs/devfs/tmpfs 实现全面；LRU 块缓存务实；但 ext4 写操作瞬态句柄模式性能不佳；procfs 数据静态；缺文件锁实现 | VFS 架构设计和多后端整合是项目亮点之一，ext4 写路径性能有优化空间 |
| **交互设计** | 是 | 80% | 嵌入式测试运行时可在启动后自动部署测试环境；声明式测试选择；控制台支持 `\r\n` 换行兼容；但无交互式 shell（仅 busybox sh）；无 framebuffer 终端 | 测试工程化意识强，但运行时用户交互体验有限 |
| **同步原语** | 部分 | 60% | 封装 spin::Mutex 用于内核同步；futex 完整支持用户态同步；但无 RCU/读写锁/顺序锁/semaphore 等高级同步原语；退出时 robust_list 处理增强了健壮性 | 基础同步机制可用，但同步原语工具集较为有限 |
| **资源管理** | 部分 | 70% | RAII 帧回收/PID 回收/文件描述符引用计数；`RLimit` 结构定义了资源限制类型；块缓存 LRU 淘汰；但无整体资源统计/监控/cgroups 控制 | 资源生命周期管理基本到位，缺乏全局资源管控和限制执行 |
| **时间管理** | 是 | 85% | BinaryHeap 定时器框架；futex 超时序列号防虚假唤醒；timerfd 优化；TimeSpec/TimeVal 类型完整；但无高精度定时器；定时器检查在调度循环中非中断上下文 | 时间子系统功能完整且注意了边界正确性，精度受限于调度模型 |
| **系统信息** | 部分 | 65% | procfs 提供 cpuinfo/meminfo/stat/mounts/[tid]/stat/status/maps/pagemap 等接口；`sysinfo` 系统调用已实现；但 procfs 数据多为静态快照；无 sysfs 实现 | 系统信息导出基础设施存在，但数据实时性和完整性不足 |
| **网络协议栈** | 极少 | 25% | AF_ALG 实现完整支持真实验证计算；网络驱动代码存在但无 TCP/IP/UDP；无 AF_INET/AF_UNIX；无 netlink | 加密 API 路径实现质量好，但整体网络能力严重不足 |
| **设备驱动** | 部分 | 60% | VirtIO 框架自研完整；多平台块设备支持；真实硬件驱动（AHCI/e1000/ixgbe/SD）；但网络驱动与协议栈脱节；无中断驱动异步 I/O；缺 NVMe/USB | 块设备支持务实，网络硬件驱动有投入但未能转化为可用网络能力 |
| **安全机制** | 部分 | 55% | 用户态地址验证基础设施；CAP 能力集定义；uid/gid 多凭证；seccomp 常量定义但过滤未执行；无 ASLR；无地址空间随机化；无 KASLR | 基础权限模型存在，但现代安全防护技术普遍缺失 |

---

## 五、总结评价

CoreCraft 是一个工程完成度中上的 Rust OS 内核项目，代码规模约 87,000 行，以宏内核架构实现了对 Linux ABI 的广泛兼容（237 个系统调用）。项目在以下方面表现突出：

**核心亮点**：

1. **双架构统一抽象设计**：通过 `ArchInterface` trait 实现的架构抽象层干净地隔离了 RISC-V 64 和 LoongArch 64 的平台差异，不是简单的条件编译分支，而是定义了清晰的架构边界接口。两种架构的启动、中断、页表、上下文切换均完整实现。

2. **策略-执行分离的内存管理**：`FaultHandler`（策略）与 `MemorySet`（执行）的分层设计体现了对 OS 原理的深入理解，COW、延迟分配、匿名页面、文件映射页面的故障处理逻辑清晰正确。

3. **多后端 VFS 架构**：ext4（通过 C FFI）、devfs、procfs、tmpfs 在统一的 Dentry/Inode/File trait 体系下协同工作，架构优雅。lwext4 非重入 C 库的多任务安全封装（GuardSlot 锁保护）处理得当。

4. **全面且边界正确性高的信号子系统**：覆盖 POSIX 信号完整语义，非实时/实时队列分离、同步信号强制投递、futex 序列号防虚假唤醒等边界情况处理到位。

5. **测试工程化意识强**：嵌入式测试运行时、声明式测试选择、LTP 深度集成为持续验证提供了良好基础设施。

**主要不足**：

1. **单核设计**：无 SMP 支持是多任务操作系统的显著功能缺口，限制了在多核硬件上的实际部署能力。
2. **网络协议栈极度有限**：仅支持 AF_ALG 加密 API socket，无 TCP/IP/UDP/Unix Domain 支持，网络硬件驱动（e1000/ixgbe/VirtIO-net）的投入未能转化为可用网络能力。
3. **无内核抢占**：影响交互响应性和实时性。
4. **缺少高级内存管理特性**：无大页、页面回收/交换、KSM、NUMA 支持。
5. **部分子系统仅有接口定义无实际执行**：如 seccomp 过滤器、实时调度策略、部分系统调用实现。

**整体评估**：该项目在双架构支持、内存管理正确性、VFS 架构设计、信号处理完整性和系统调用覆盖广度方面展现了扎实的 OS 内核开发能力和良好的工程素养。网络协议栈缺失和单核设计是其最大的功能瓶颈。与其较强的核心子系统实现相比，安全防护（ASLR/KASLR/seccomp 执行）和设备驱动多样性方面有较大的提升空间。