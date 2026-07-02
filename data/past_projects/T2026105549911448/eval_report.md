# xiande-OS 内核项目技术画像与评估报告

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| **项目名称** | xiande-OS |
| **内核类型** | 宏内核 (Monolithic Kernel) |
| **实现语言** | Rust 1.89 nightly（零 unstable feature，纯 stable Rust） |
| **目标架构** | RISC-V64 (riscv64gc-unknown-none-elf) / LoongArch64 (loongarch64-unknown-none) |
| **特权级别** | RISC-V64 S-mode / LoongArch64 特权态 |
| **代码规模** | 约 31,633 行（Rust + 汇编，55 个源文件） |
| **依赖管理** | vendored 依赖（自包含），alloc + no_std |
| **生态归属** | Linux ABI 兼容层，glibc/musl 双 libc 支持 |
| **赛题定位** | OS 内核赛道竞赛作品 |
| **构建产物** | RISC-V64 ELF ~41MB（text 5.95MB, bss 268MB 含 256MB 内核堆） |

**核心特征：**

- 双 ISA 架构后端，通过命名约定 + `#[cfg]` 编译选择实现 95% 以上上层代码架构无关
- 约 238 条 Linux 系统调用实现，覆盖文件 I/O、进程管理、信号、网络 socket、SysV IPC、futex、epoll 等
- 完整 POSIX 信号模型（含实时信号、SA_SIGINFO、替代栈、sigreturn）
- 自包含设计：内嵌用户态二进制（busybox、git、ld-musl）、内嵌 vDSO、内核内 ext2 mkfs
- 两遍构建符号表嵌入（崩溃时自解析 function+offset）
- per-syscall 看门狗与故障恢复路径

---

## 二、子系统实现清单

| 子系统 | 核心源文件 | 功能摘要 |
|--------|-----------|---------|
| **架构后端 (arch)** | `arch/mod.rs`, `riscv64/` (trap.S, trap.rs, context.rs, boot.S), `loongarch64/` (boot.S, trap.S, trap.rs, context.rs, fpu.rs, pci.rs) | 陷阱处理、上下文切换、TLB Refill（LA）、FP/LSX/LASX、PCI 枚举、定时器、关机 |
| **内存管理 (mm)** | `address.rs`, `frame.rs`, `heap.rs`, `page_table.rs`, `memory_set.rs`, `mod.rs` | 物理帧分配（buddy allocator）、内核堆（256MB）、Sv39 风格 3 级页表、地址空间管理（VMA）、fork 即时深拷贝、mmap、大页映射 |
| **进程管理 (task)** | `task/mod.rs` (2478行), `signal.rs` (1098行), `loader/mod.rs` (269行) | fork/clone/clone3/execve/execveat/wait4/waitid、单核 round-robin 抢占调度、进程组/会话、孤儿僵尸回收 |
| **文件系统 (fs)** | `fs/mod.rs` (781行), `ext4.rs`, `ext2.rs`, `fat32.rs`, `tmpfs.rs`, `devfs.rs`, `procfs.rs`, `pipe.rs`, `socket.rs`, `notify.rs` | VFS 抽象、ext4 只读（含 extent 树）、ext2 读写（含内核内 mkfs）、FAT32 只读、tmpfs、devfs、procfs（1024行）、pipe（64KB 环形缓冲）、inotify/fanotify |
| **系统调用 (syscall)** | `syscall/mod.rs` (9851行), `socket.rs`, `sysv_ipc.rs`, `keys.rs`, `futex.rs`, `nr.rs` | 244 个 syscall 编号定义，约 238 条实现；Socket 层（TCP/UDP）、SysV IPC 三种、Key Management、futex、epoll、splice 族 |
| **网络 (net)** | `net/mod.rs`, `loopback.rs` | smoltcp 集成（IP 10.0.2.15/24）、TCP/UDP socket、内核内 loopback（TCP 管道对、UDP 消息队列）、临时端口分配 |
| **设备驱动 (drivers)** | `virtio_blk.rs`, `virtio_net.rs`, `pci.rs` | virtio-blk（16MB 块缓存）、virtio-net（队列深度 16）、LoongArch64 PCI ECAM 枚举与 BAR 分配 |
| **同步原语 (sync)** | `spinlock.rs` (135行), `futex.rs` (453行) | 抢占安全 Mutex（preempt_disable 计数）、futex（WAIT/WAKE/BITSET/REQUEUE/CMP_REQUEUE） |
| **vdso** | `vdso.rs` (206行), `vdso/rt_sigreturn.S` | 预编译极小 vDSO ELF，导出 `__vdso_rt_sigreturn`，含 `.cfi_signal_frame` CFI，映射到 VDSO_BASE |
| **竞赛编排器** | `contest_runner.rs` (1137行) | 自动挂载 ext4 测试盘、枚举 glibc/musl 变体、生成 init.sh 并按优先级运行测试组 |
| **符号表** | `ksyms.rs` (121行) | 两遍构建嵌入符号表，`black_box` + fat pointer 保证可重现，崩溃时二分查找自解析 |

---

## 三、各子系统详细分析

### 3.1 内存管理

**实现完整度：75%**（以支持完整竞赛测试集所需特性为基准）

**已实现：**
- buddy system 物理帧分配器（`LockedFrameAllocator<32>`），支持 alloc/dealloc/alloc_uninit
- FrameTracker RAII 守卫自动回收
- 256 MiB 内核堆（`PreemptHeap`），alloc/dealloc 时禁用抢占避免死锁
- 双架构 Sv39 风格 3 级页表（`PageTable`），中间级页表懒分配，Drop 递归释放
- 完整虚拟地址空间管理（`MemorySet`）：VMA (VmArea) 以 BTreeMap 管理映射，支持 brk/mmap/munmap/mprotect/madvise/mremap/msync/mincore
- 2 MiB 大页优化（内核恒等映射区域）
- fork 即时深拷贝（无 CoW）
- MAP_SHARED 共享内存（Arc<FrameTracker>）
- MADV_WIPEONFORK 支持
- LoongArch64 低 RAM bank 补充注册

**未实现：**
- demand paging（即时分配策略，mmap 时立即分配全部物理帧）
- Copy-on-Write（fork 时全量复制）
- KASLR 地址随机化
- swap 换页
- KSM（虽有 /sys/kernel/mm/ksm 目录桩，但无实际功能）
- 完整的多 NUMA 感知

**优缺点分析：**

优点：页表实现考虑了双架构差异（RISC-V PTE 格式 vs LoongArch64 PTE 格式，含 MAT/NR/NX 负逻辑），通过 `PageTable::satp()` 统一返回对应 CSR 格式。地址空间布局设计合理（PIE_LOAD_BASE 0x20_0000、MMAP_BASE 0x2000_0000、USER_STACK_TOP 0x4000_0000、vDSO/SIG_RESTORER 固定映射），考虑了 glibc 动态链接器对地址空间的需求。`alloc_uninit` 优化在 fork 复制路径中避免了冗余清零。

缺点：无 demand paging 意味着每次 mmap 大区域都会立即占用物理内存，对内存压力测试不利。无 CoW 意味着 fork 密集型测试（如 shell 脚本中的大量 fork/exec 模式）会产生显著的物理内存开销。BTreeMap 存储 VMA 帧映射虽然查找高效，但内存开销大于区间表示。256MB 内核堆虽然是针对 libc-bench 的合理配置，但静态预留导致即使在内存受限环境中也不可缩减。

**实现细节（代码依据）：**
- `mm/memory_set.rs:1008` — MemorySet 完整实现
- `mm/memory_set.rs` 中 `map_identity_range` 使用 `PTEFlags::new().huge(true)` 创建 2 MiB 映射
- `mm/frame.rs` 中 `emergency_reclaim()` 在 OOM 时回收僵尸任务帧
- `mm/page_table.rs` 中 LoongArch64 PTE 标志位包含 `MAT`(Memory Access Type)、`NR`(Not Readable) 负逻辑、`NX`(Not Executable) 负逻辑

---

### 3.2 进程管理

**实现完整度：85%**（以支持完整 Linux ABI 进程模型为基准）

**已实现：**
- fork/clone/clone3 完整支持（CLONE_VM/THREAD/FS/FILES/SIGHAND/SETTLS/CHILD_CLEARTID/VFORK）
- execve/execveat 地址空间替换与 ELF 加载
- wait4/waitid 子进程等待（WNOHANG/WUNTRACED）
- 单核 round-robin 抢占调度（1ms 时间片，trap 边界调度）
- 进程组/会话模型（pgid/sid/tty 控制）
- 任务状态机：Ready/Running/Waiting/Zombie
- 孤儿进程回收与僵尸清理（表大小超 128 触发）
- 64 KiB 内核栈（TaskStorage 内嵌）
- vfork 语义（父进程阻塞至子进程 execve/exit）
- detached 线程自动回收

**未实现：**
- 多核 SMP 调度
- CFS（完全公平调度器）或任何优先级调度
- CPU affinity 绑定
- cgroup 资源控制
- 完整 namespace（仅有 ns/ 目录桩）

**优缺点分析：**

优点：进程管理是该项目最扎实的子系统之一。clone/clone3 的标志处理细致，正确实现了 CLONE_VM 下的地址空间共享（Arc<Mutex<MemorySet>>）和 CLONE_FILES 下的 fd 表共享（Arc<Mutex<FdTable>>）。vfork 的阻塞-唤醒链正确：父进程在 fork 时将 `vfork_child` 设置为子进程 PID，子进程在 execve/exit 时通过 raise_signal(SIGCHLD) 唤醒父进程。孤儿僵尸回收机制避免了无限积累。

调度器虽然简单，但抢占安全设计是亮点：`PREEMPT_DISABLE` 计数而非关中断，在持锁期间 timer tick 仍可触发，使看门狗能够在 wedged syscall 中检测超时并触发恢复路径。`force_unlock()` 方法使故障恢复路径能够强制释放被遗弃栈持有的锁。

缺点：单核 round-robin 调度器没有优先级概念，IO 密集型和 CPU 密集型任务无法区分对待。fork 的深拷贝策略结合无 CoW 意味着大进程的 fork 成本较高。任务状态为 Mutex 保护的单一日志而非精细的等待队列，导致 `block_and_retry()` 需要全局轮询（每次 trap 出口扫描全部超时等待者）。

**实现细节（代码依据）：**
- `task/mod.rs:2478` — Task 结构含 64KiB 内核栈、TaskContext、FP 上下文
- `task/mod.rs` 中 `schedule_next_after_trap_inner()` 的调度序列：网络轮询→futex 超时扫描→唤醒到期 sleepers→回收 detached 线程→孤儿回收→round-robin 选下一任务
- `task/mod.rs` 中 `block_and_retry_recheck()` 在标记 Waiting **后**重新检查条件以消除 lost-wakeup 竞态

---

### 3.3 文件系统

**实现完整度：70%**（以支持竞赛测试所需的基本文件操作为基准）

**已实现：**

| 文件系统 | 读写支持 | 关键特性 |
|---------|---------|---------|
| ext4 | 只读 | 1/2/4 KiB 块，64-bit 组描述符，extent 树（inline + depth-1），HTREE 降级线性遍历 |
| ext2 | 可读写 | 128 MiB 最大容量，直接块 + 单/双间接块，内核内 mkfs，块位图/inode 位图管理 |
| FAT32 | 只读 | BPB 解析，32-bit FAT，LFN 长文件名，目录项缓存 |
| tmpfs | 可读写 | Vec<u8> 文件内容，BTreeMap 目录，特殊设备节点，符号链接，硬链接，扩展属性 |
| devfs | 只读 | /dev/null, zero, full, random, urandom, tty, console |
| procfs | 动态只读 | /proc/<pid>/ 完整状态导出，/proc/mounts，/proc/meminfo，/proc/cpuinfo |
| pipe | 可读写 | 环形缓冲（VecDeque，默认 64 KiB），阻塞读写，SIGPIPE，F_SETOWN/F_SETSIG |
| socket inode | 可读写 | TCP/UDP socket 暴露为 VFS Inode |

**VFS 核心抽象 (Inode trait)：**
- `read_at`/`write_at` 基于偏移量的读写
- `lookup`/`create`/`unlink`/`list` 目录操作
- `link`/`symlink`/`rename` 命名操作
- `truncate` 文件截断
- `xattr_store_get/set/list/remove` 扩展属性（BTreeMap<String, Vec<u8>>）

**未实现：**
- ext4 写入（仅只读）
- ext2/3/4 日志（journal）支持
- 后备存储脏页回写
- xfs/btrfs 等其他文件系统
- 完整 O_TMPFILE 语义
- 文件锁字节范围锁的完整支持

**优缺点分析：**

优点：VFS 的 Inode trait 设计简洁通用，通过 trait object（`Arc<dyn Inode>`）实现了多文件系统类型的统一访问。每个 Inode 可选实现 `as_any()` 以支持向下转型，使特定文件系统可以提供超出 trait 的能力。

ext4 驱动的 extent 树解析是真正的工程成果：从 `i_block[60]` 中读取 extent header（magic 0xF30A），根据深度字段选择 inline 或索引模式，遍历 extent 叶节点获取文件块映射。这比常见的"只支持直接块映射"的 ext4 驱动要完整得多。ext2 的内核内 mkfs 功能使空白设备可在内核启动时格式化为 ext2，无需外部 e2fsprogs，直接支持了 LTP 的 `.format_device` 类用例。

procfs 实现（1024 行）覆盖了日常诊断所需的主要接口：/proc/<pid>/maps 展示了 VMA 列表（地址范围、权限、偏移量）、/proc/<pid>/status 展示了进程状态（Name/State/Tgid/Pid/PPid/VmSize等）。

缺点：ext4 只读限制了测试盘的使用灵活性。ext2 的单块组设计限制了最大容量为 128 MiB（4 KiB 块 × 32768 块）。没有缓存的脏页回写机制意味着所有写操作立即落盘，小写入性能较低。inotify/fanotify 的事件匹配按 inode 指针或 ino 号进行，但如果文件系统驱动不提供稳定指针或 ino，事件可能丢失。

**实现细节（代码依据）：**
- `fs/ext4.rs:732` — ext4 完整实现含 extent 解析
- `fs/ext4.rs` 中 `read_extent_tree` 函数：读取 i_block[0..60] 作为 extent header，检查 magic 0xF30A，根据 `eh_depth` 选择深度 0（叶子）或深度 1（索引）路径
- `fs/ext2.rs` 中 `mkfs` 函数：写入超级块、块组描述符、块位图、inode 位图、inode 表、根目录 inode
- `fs/procfs.rs` 中 `/proc/<pid>/maps` 生成：遍历 `memory_set.areas`，格式化 `"{:x}-{:x} {}{}{} {:08x} ..."` 

---

### 3.4 系统调用与 ABI 兼容

**实现完整度：85%**（以实现的 syscall 数 / 竞赛所需核心 syscall 数为基准）

**统计：**
- syscall 编号定义：244 个（`syscall/nr.rs`）
- syscall 实现分支：约 238 条（`syscall/mod.rs` 中 match 分支数）
- 核心分发器：`dispatch(tf)` 读取 `tf.syscall_no()`，从寄存器提取 a0-a5 参数，匹配后调用对应函数

**完整实现的系统调用类别：**

| 类别 | 代表性 syscall | 实现状态 |
|------|---------------|---------|
| 文件 I/O | read/write/pread64/pwrite64/readv/writev/lseek/sendfile | 完整 |
| 文件描述符 | openat/openat2/close/dup/dup3/pipe2/fcntl/flock | 完整 |
| 目录操作 | getcwd/chdir/fchdir/mkdirat/unlinkat/symlinkat/linkat/readlinkat | 完整 |
| 文件元数据 | fstat/newfstatat/statx/fchmod/fchown/utimensat/faccessat | 完整 |
| 扩展属性 | setxattr/getxattr/listxattr/removexattr（含 l/f 变体，共 8 条） | 完整 |
| 挂载 | mount/umount2/statfs/fstatfs | 完整 |
| 进程管理 | fork/clone/clone3/execve/execveat/exit/exit_group | 完整 |
| 进程控制 | wait4/waitid/getpid/getppid/getuid/getgid/setuid/setgid 等 | 完整 |
| 信号 | rt_sigaction/rt_sigprocmask/rt_sigpending/rt_sigreturn/kill/tkill/tgkill/rt_sigqueueinfo/rt_tgsigqueueinfo | 完整 |
| 定时器 | nanosleep/clock_gettime/clock_nanosleep/timer_create/timer_settime/timer_gettime/timer_delete/timerfd | 完整 |
| 内存管理 | brk/mmap/munmap/mprotect/madvise/mremap/msync/mincore/memfd_create | 完整 |
| futex | WAIT/WAKE/WAIT_BITSET/WAKE_BITSET/REQUEUE/CMP_REQUEUE | 完整 |
| 网络 socket | socket/bind/listen/accept/accept4/connect/sendto/recvfrom/sendmsg/recvmsg/shutdown/getsockopt/setsockopt/getpeername/getsockname | 完整 |
| SysV IPC | shmget/shmat/shmdt/shmctl/msgget/msgsnd/msgrcv/msgctl/semget/semop/semctl/semtimedop | 完整 |
| epoll | epoll_create1/epoll_ctl/epoll_pwait | 完整 |
| splice 族 | splice/tee/vmsplice/sendfile/copy_file_range | 完整 |
| Key management | add_key/request_key/keyctl | 完整 |
| 进程间内存读写 | process_vm_readv/process_vm_writev | 完整 |
| 其他 | close_range/prctl/set_tid_address/set_robust_list/getrandom/membarrier | 完整 |

**未实现或桩实现的 syscall：**
- io_uring 相关（IORING_SETUP 等）：未实现
- seccomp：未实现
- bpf：未实现
- prlimit64：桩（返回 0 但不实际设置限制）
- setns：桩

**优缺点分析：**

优点：系统调用覆盖广度是该项目最突出的优势之一。238 条 syscall 的实现数量在同规模的竞赛内核中属于较为完整的水平。不仅是"简单 syscall"，“实现复杂的 splice 族（涉及内核内管道间数据传输）、SysV IPC 三种机制的完整实现（含 UNDO 语义）、key management 子系统（含多种 keyctl 命令）等都被实现，显示了较高的 ABI 兼容追求。

`openat2` 的实现尤为值得注意：支持 `RESOLVE_NO_XDEV`、`RESOLVE_NO_SYMLINKS` 等解析标志，这是较新的 Linux 系统调用（5.6+），说明项目关注了现代 ABI 演进。

缺点：io_uring 的缺失意味着某些高性能 I/O 模式的测试无法进行。seccomp 和 bpf 的缺失限制了沙箱相关测试用例的支持。部分系统调用返回成功但不产生实际效果（如 prlimit64），这可能在审计类测试中被检测。

**实现细节（代码依据）：**
- `syscall/mod.rs` 中 `dispatch()` 函数：`let ret = match id { ... }` 映射约 238 个分支
- `syscall/nr.rs`：定义 244 个 syscall 编号常量，含 `SYS_openat2 = 437`

---

### 3.5 信号处理

**实现完整度：90%**（以 POSIX 信号模型完整性为基准）

**已实现：**
- 标准信号（1-31）+ 实时信号（32-64），共 64 个信号
- 每个信号可配置 sa_handler/sa_sigaction、sa_mask、sa_flags（SA_SIGINFO/SA_RESTART/SA_ONSTACK/SA_NOCLDWAIT/SA_NODEFER）
- siginfo_t 传递（si_signo/si_code/si_pid/si_uid/si_value）
- sigprocmask/sigpending/sigsuspend/rt_sigpending
- sigaltstack 替代信号栈
- SA_RESTART：可中断阻塞 syscall 在信号处理后自动重启（通过 `in_blocking_syscall` 标志和 `sepc -= 4` 回退实现）
- SI_TKILL 正确设置（glibc pthread_cancel 依赖此 si_code 以区分 tkill 和 kill）
- 信号恢复页（SIG_RESTORER_VA 0x5000_0000）：映射含 `rt_sigreturn` 指令的代码页
- vDSO 中的 `__vdso_rt_sigreturn` 含 `.cfi_signal_frame` CFI（支持 glibc 的 DWARF 栈回溯穿透信号帧）
- 信号投递路径：raise_signal → 设置 pending bit → 下次 trap 出口 deliver_pending → 构造 rt_sigframe → enter_signal_handler

**未实现：**
- 多线程信号的精确定向投递（仅在 trap 出口检查当前任务）
- sigqueue 的 value 队列（仅保留最新 siginfo）
- 信号处理的实时优先级排序

**优缺点分析：**

优点：信号系统是该内核实现最为完整的子系统之一。vDSO + CFI 自实现是关键的兼容性工作。项目手写汇编构造了带有 `.cfi_signal_frame` 标注的 vDSO ELF，使得 glibc 的 `pthread_cancel` 在竞赛环境中能够正常进行 DWARF 栈回溯穿透信号帧。作者对此设计意图有清晰认知：vDSO 被映射到固定地址并仅包含导出的 `__vdso_rt_sigreturn`，通过 AT_SYSINFO_EHDR auxv 通告给 glibc。

SA_RESTART 的实现也值得注意：通过 `in_blocking_syscall` 原子标志标记可中断阻塞系统调用（如 read/wait4/futex），信号处理后检查该标志，若信号被正确处理（非默认终止动作）则回退 sepc 使系统调用重试。这保证了对那些期望 SA_RESTART 行为的 glibc 函数的兼容。

SI_TKILL 的正确传递（通过 `tkill` 和 `tgkill` 区分）解决了 glibc `pthread_cancel` 的实际需求——`pthread_cancel` 使用 `__pthread_kill` → `tgkill` → 检查返回的 si_code 是否为 SI_TKILL 来确认信号来自自身线程组的取消请求。

缺点：信号在单任务的环境中工作受限。多线程程序虽然有独立的 sigmask 和 pending 集合，但信号只在下一次进入内核（trap）时被检查，且仅投递给当前被调度的任务，而非像 Linux 那样基于信号亲和性选择目标线程。siginfo 仅保留每个信号的最新信息，对于快速连续发送的同一实时信号会丢失中间信息。

**实现细节（代码依据）：**
- `signal.rs` 中 `deliver_pending()` 函数：遍历 pending 位图，检查 mask 阻挡，调用 `enter_signal_handler()` 构造 sigframe
- `vdso/rt_sigreturn.S`：手写汇编，含 `.cfi_startproc`、`.cfi_signal_frame`、`.cfi_def_cfa_offset` 等 CFI 指令
- `signal.rs` 中 `enter_signal_handler()`：计算用户栈偏移，写入 siginfo_t + ucontext + mcontext，设置返回地址为 vDSO `__vdso_rt_sigreturn`

---

### 3.6 网络子系统

**实现完整度：65%**（以 Linux 网络协议栈完整度为基准）

**已实现：**
- smoltcp 集成：TCP/UDP 协议栈，IP 10.0.2.15/24，网关 10.0.2.2
- TCP socket buffer：8 KiB 接收 + 8 KiB 发送
- UDP socket buffer：16 个 packet metadata + 8 KiB payload
- 临时端口分配：49152-65535 循环
- 内核内 loopback（绕过 smoltcp 的 127.0.0.1 路由）
- TCP loopback：管道对 (LoopbackEnd) 双向字节流
- UDP loopback：进程内消息队列，按 port 注册/分发
- POSIX socket 系统调用完整封装
- 非阻塞模式与阻塞模式（block_and_retry）

**未实现：**
- IPv6 协议栈
- AF_UNIX DGRAM（可能有 SOCK_STREAM 的 pipe-like 实现）
- tun/tap 虚拟设备
- 原始 socket (AF_PACKET/SOCK_RAW)
- netfilter/iptables
- TCP 拥塞控制可调参数
- SO_REUSEADDR/SO_REUSEPORT 完整语义

**优缺点分析：**

优点：内核内 loopback 实现是值得关注的优化。标准的 127.0.0.1 路径会经过完整的 smoltcp 协议栈（包括 TCP 状态机），而项目实现了直接的进程内数据传输通道：TCP loopback 使用管道对 (LoopbackEnd) 建立双向字节流，UDP loopback 按 port 注册接收者并直接在进程间传递数据报。这避免了对模拟网络栈的性能压力，且对应用透明。

网络轮询整合到了调度器中（每次 trap 出口调用 `poll_with_progress()`），仅在处理了包或准备好 socket 时才返回 true 以避免无效唤醒。阻塞 socket 使用 `block_and_retry_recheck()` 避免 lost-wakeup 竞态。

缺点：网络栈依赖 smoltcp 的完整性和局限。smoltcp 不支持 TCP window scaling（或仅在有限程度支持），在大带宽延迟积（BDP）场景下吞吐量受限。8 KiB 的 TCP socket buffer 限制了单连接吞吐。无 IPv6 限制了对现代网络环境的兼容。AF_UNIX 仅实现了 SOCK_STREAM（通过管道模拟），缺少 DGRAM 和 SEQPACKET 支持。

**实现细节（代码依据）：**
- `net/mod.rs` 中 `NetStack` 结构：持有 `Interface`、`SocketSet`、`VirtioPhy`
- `net/loopback.rs` 中 `TcpConnect`：在 `loopback_accept` 和 `loopback_connect` 之间创建 `LoopbackEnd` 对，双向传输数据
- `net/loopback.rs` 中 `UdpBind`：按 port 注册 VecDeque，`loopback_send` 在目标 port 队列中插入 datagram

---

### 3.7 同步原语

**实现完整度：70%**（以所需的最小同步机制集合为基准）

**已实现：**
- 抢占安全 Mutex (`sync/spinlock.rs`)：基于 `preempt_disable` 计数，lock 时递增，drop 时递减
- futex (`syscall/futex.rs`)：完整 WAIT/WAKE/BITSET/REQUEUE/CMP_REQUEUE 实现
- `force_unlock()` 故障恢复方法（heap、frame allocator、Mutex）
- `preempt_reset()` 抢占计数复位

**未实现：**
- RWLock 读写锁（仅有类型重导出但无真正的读写锁实现）
- 条件变量（仅在 futex 基础上可构造用户态条件变量）
- 屏障（barrier）
- 自旋锁与关中断结合的标准方案

**优缺点分析：**

优点：抢占安全 Mutex 设计较为独特。传统的单核 Rust 内核通常在持锁时关闭中断以避免死锁，但该项目选择了一种更精细的方案：递增 `PREEMPT_DISABLE` 原子计数器，调度器在计数非零时拒绝切换。这意味着：
1. 持锁期间 timer tick 仍然触发
2. 看门狗可以在 ticks 累积中检测 wedged syscall
3. 故障恢复路径可以强制释放锁

`force_unlock()` 机制是这一设计的延伸：故障恢复路径（如 wedged syscall 被看门狗检测）可以调用 `force_unlock()` 强制释放被遗弃栈持有的锁，使内核恢复到可运行状态。

futex 实现完整支持了 `FUTEX_WAIT_BITSET`/`FUTEX_WAKE_BITSET`（这是 pthread 条件变量和屏障的核心依赖），以及 `FUTEX_CMP_REQUEUE`（glibc `pthread_cond_broadcast` 的优化路径）。

缺点：缺乏真正的读写锁意味着所有 VFS inode、地址空间等共享资源都是互斥访问，读者之间无法并发（虽然单核环境下这种差异不明显，但在代码结构上限制了未来扩展）。条件变量需要在用户态通过 futex 构造，内核本身没有提供直接的内核内条件变量。

**实现细节（代码依据）：**
- `sync/spinlock.rs` 中 `MutexGuard::drop()`：`preempt_enable()` 递减 PREEMPT_DISABLE 计数
- `sync/spinlock.rs` 中 `force_unlock()`：强制将 `spin::Mutex` 的内部状态设为 unlocked，然后 `preempt_enable()`
- `syscall/futex.rs` 中 `poll_timeouts()`：在每次 trap 出口由调度器调用，扫描 `WAITERS` 表中的超时条目

---

### 3.8 设备驱动

**实现完整度：50%**（以常见竞赛所需驱动集合为基准）

**已实现：**
- virtio-blk：基于 `virtio-drivers` 0.7.5 crate，16 MiB 块读取缓存，多块设备支持
- virtio-net：队列深度 16，帧缓冲区 2048 字节
- LoongArch64 PCI ECAM 枚举：BAR 自动分配（32-bit MMIO 窗口 0x4000_0000-0x8000_0000），Memory Space + Bus Master 使能
- RISC-V64 virtio-mmio 扫描：非侵入式设备探测
- 自定义 `KernelHal`：通过 `KERNEL_PHYS_OFFSET` 实现 DMA 缓冲区 VA↔PA 转换

**未实现：**
- virtio-console/gpu/input 等
- USB 协议栈
- 音频设备
- PCI MSI/MSI-X 中断
- NVMe 驱动
- ACPI 解析

**优缺点分析：**

优点：双传输层支持（virtio-mmio + virtio-pci）使得设备驱动在两个架构上都能工作。LoongArch64 的 PCI 枚举是自实现的（163 行），包括 ECAM 配置空间遍历、BAR 解析和分配（32-bit/64-bit 自动识别）、命令寄存器编程，不依赖外部固件。

非侵入式设备探测是一个精心设计的特性：在扫描 virtio-mmio bank 时，仅读取 DeviceID 寄存器以判断设备类型而不创建 transport。这避免了初始化已由其他代码初始化的设备时发生状态冲突。

缺点：驱动覆盖范围有限。仅有块设备和网络设备驱动，没有控制台驱动（通过 SBI 或 UART 输出），没有输入设备驱动，没有显示驱动。缺乏中断驱动的 I/O——virtio 设备使用轮询模式，每个 trap 出口检查是否有待处理数据。这在有实际 I/O 负载时会产生延迟和处理开销。

**实现细节（代码依据）：**
- `drivers/pci.rs` 中 `scan_ecam()`：从 ECAM 基址遍历总线/设备/功能，检查 Vendor ID 是否有效（0xFFFF 表示不存在），读取 Header Type 决定 BAR 布局
- `drivers/virtio_blk.rs` 中 `BlockCache`：16 MiB 缓存以 sector 粒度管理
- `drivers/virtio_net.rs` 中 `DeviceProbe`：只读取 VirtIOHeader 的前几个字段做判断

---

### 3.9 时间管理

**实现完整度：70%**（以支持基本定时需求为基准）

**已实现：**
- 基于 DTB 中 `timebase-frequency` 的时钟频率检测
- 1ms 抢占定时器滴答
- clock_gettime（CLOCK_REALTIME/CLOCK_MONOTONIC/CLOCK_PROCESS_CPUTIME_ID/CLOCK_THREAD_CPUTIME_ID）
- clock_nanosleep
- POSIX 定时器：timer_create/timer_settime/timer_gettime/timer_delete（实时信号通知）
- timerfd：create/settime/gettime
- nanosleep 高精度睡眠
- `timer_slack` 支持（PR_SET_TIMERSLACK）
- /proc/uptime 统计

**未实现：**
- CLOCK_REALTIME 校准（无 RTC 持久化）
- CLOCK_BOOTTIME（无法区分挂起时间）
- adjtimex/clock_adjtime 时间调节
- HPET/APIC Timer 等硬件定时器抽象
- 高精度事件定时器 (hrtimer) 框架

**优缺点分析：**

优点：定时器系统的 syscall 覆盖较完善。timer_create/timerfd 的实现允许用户态使用 POSIX 定时器接口。clock_nanosleep 支持 `TIMER_ABSTIME` 绝对时间睡眠（这是实现稳健定时等待的关键标志）。per-syscall 看门狗也依赖定时器 tick 计数。

缺点：时间管理缺乏硬时钟抽象层。所有定时器都基于单一的 1ms 定时器 tick，没有实现高精度事件定时器框架。CLOCK_REALTIME 在启动时从零开始计数，没有 RTC 同步机制。无 adjtimex 意味着无法进行时间调节或 NTP 同步。

**实现细节（代码依据）：**
- `arch/riscv64/time.rs` 中 `timer_init()`：从 DTB 读取 `timebase-frequency`，写入 mtimecmp 寄存器
- `syscall/mod.rs` 中 `sys_clock_gettime()`：根据 clk_id 分支处理，MONOTONIC 从全局 TICK_COUNT 读取

---

### 3.10 系统信息与可观测性

**实现完整度：65%**（以 /proc 文件系统和诊断信息为基准）

**已实现：**
- /proc/<pid>/status：进程名、状态、Tgid/Pid/PPid、UID/GID、VmSize/VmRSS、信号掩码
- /proc/<pid>/stat：进程状态机信息
- /proc/<pid>/maps：VMA 完整列表（地址范围、权限、偏移量）
- /proc/<pid>/cmdline：启动命令行
- /proc/<pid>/exe：可执行文件符号链接
- /proc/<pid>/comm：进程名称
- /proc/<pid>/fd/：文件描述符列表
- /proc/<pid>/ns/：命名空间桩
- /proc/mounts：挂载表（含设备、挂载点、文件系统类型、选项）
- /proc/meminfo：MemTotal/MemFree/HeapUsed 统计
- /proc/cpuinfo：CPU 数量与 ISA 信息
- /proc/uptime：运行时间
- /proc/stat：CPU 时间统计
- /proc/sys/：内核参数目录（部分可读写桩）
- 内核崩溃时的符号表自解析（function+offset 格式）

**未实现：**
- /proc/<pid>/smaps（VMA 的详细内存映射）
- /proc/<pid>/stack（内核栈回溯）
- /proc/<pid>/environ 完整实现
- /proc/<pid>/io 读写统计
- /proc/<pid>/cgroup
- coredump 生成
- ftrace/perf 等追踪工具
- 结构化日志系统

**优缺点分析：**

优点：procfs 实现（1024 行）是该项目中继系统调用模块之外最大的单一文件，提供了详细的进程状态信息。/proc/<pid>/maps 的输出格式与 Linux 兼容（地址范围、rwx权限、偏移量、设备号、inode号、路径名），支持 mmap 文件路径的显示。/proc/meminfo 提供了内核堆和物理帧的使用统计，可用于内存泄漏诊断。

两遍构建符号表嵌入方案展示了较强的工程能力：使用 `include_bytes!` 嵌入预生成的符号表，崩溃时通过二分查找在排序的地址表中定位最近的符号。该方案的关键技巧是使用 `black_box(ptr::addr_of!(BLOB))` 读取 fat pointer，使两遍构建生成相同长度的 `.text` 代码，确保符号地址在两个 pass 间保持一致。

缺点：可观测性主要依赖静态 /proc 文件读取，缺乏动态追踪机制。没有 ftrace、perf 或 kprobe 等事件追踪支持，也没有 USDT 探针。栈回溯仅在内核崩溃时可用（且仅解析符号偏移量，无源文件位置）。没有结构化的日志级别或日志缓冲区。

**实现细节（代码依据）：**
- `fs/procfs.rs` 中 `/proc/<pid>/status` 生成格式：Name、Umask、State、Tgid、Ngid、Pid、PPid、TracerPid、Uid、Gid、FDSize、VmPeak、VmSize、VmRSS 等字段
- `ksyms.rs` 中 `resolve(addr)`：二分查找 sorted addresses 数组，找到最近的不超过目标地址的符号

---

## 四、动态测试设计与结果

### 4.1 构建验证

| 目标 | 编译状态 | 产物大小 | 备注 |
|------|---------|---------|------|
| RISC-V64 Release | 成功 | ELF ~41 MB (text: 5.95 MB, data: 4 KB, bss: 268 MB) | 含 debuginfo，BSS 含 256MB 内核堆 |
| LoongArch64 Release | 成功 | ELF 正常生成 | — |

构建使用 Rust 1.89 nightly，vendor 依赖全部包含在项目树中，无网络需求的完全离线构建。

### 4.2 QEMU 启动测试

**测试配置：**
- QEMU: RISC-V64 `virt` 平台
- RAM: 512 MB
- 无块设备映像、无网络设备

**启动日志（关键阶段）：**
```
xiande-os booting on hart 0
  dtb @ 0x9fe00000
[timer] dtb timebase-frequency = 10000000 Hz
  RAM end @ 0xa0000000
  timer raw 10000000 Hz -> normalised 10000000 Hz
[ok] heap + frame allocator + trap vector + vfs + /bin + /lib + /dev/shm
[virtio-blk] no block device detected
[virtio-net] no network device detected
[xiande-os] ext4 mount failed: no block dev — empty harness
[user] contest init: busybox sh /init.sh
#### OS COMP TEST GROUP START basic ####
#### OS COMP TEST GROUP END basic ####
```

**测试结果分析：**

1. **内存初始化成功**：`mm::init(dtb_pa)` 从 DTB 检测到 512 MB RAM（0x80000000..0xa0000000），正确初始化了 buddy frame allocator 和 256 MB 内核堆。

2. **VFS 初始化成功**：根文件系统（tmpfs）创建成功，devfs 和 procfs 挂载成功，`/bin`、`/lib`、`/dev/shm` 目录创建成功。内嵌的 busybox、git、dyn_hello、ld-musl 等二进制写入 VFS。

3. **设备探测优雅降级**：virtio-blk 和 virtio-net 均未检测到设备（无磁盘映像和网络配置），内核输出 `"no block device detected"` 和 `"no network device detected"` 后继续启动。ext4 挂载失败的日志包含 `"empty harness"` 标记，表明测试编排器意识到了设备缺失。

4. **竞赛编排器启动**：生成了 `/init.sh`，busybox sh 执行该脚本，basic 测试组运行完成（start/end 分隔符均输出）。

**未测试的部分：**
由于缺少 ext4 测试磁盘映像和网络设备，无法验证以下组件的运行时行为：
- ext4 文件系统读取
- ext2 文件系统读写（包括 mkfs）
- 网络协议栈（TCP/UDP 通信）
- 完整的 lua/busybox/ltp/libctest/iperf/netperf/benchmarks 测试组

这属于测试环境限制，而非内核缺陷。

### 4.3 竞赛编排器设计

`contest_runner.rs`（1137 行）实现了自动化的测试编排：

1. 枚举测试磁盘上的变体目录（`musl/`、`glibc/`）
2. 绑定动态加载器路径（`ld-linux-riscv64-lp64d.so.1` 等）
3. 按优先级顺序生成测试组执行脚本：basic → lua → busybox → ltp → libctest → iperf/netperf → benchmarks
4. 支持特性标志选择性运行特定测试（`single_ltp`、`single_bench`）
5. 测试组白名单机制：为不同 libc/架构组合维护通过的测试列表

该编排器设计使内核能够在不同测试环境下自适应，在设备不足时优雅降级为 "empty harness"。

---

## 五、细则评价表格

### 5.1 内存管理

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。完整度 75%（以竞赛测试集需求为基准）。包含物理帧分配（buddy system）、内核堆（256MB）、3 级页表、完整地址空间管理（VMA + mmap/brk/mprotect/madvise）、2MB 大页。 |
| **关键发现** | 页表实现双架构自适应（RISC-V PTE 格式 vs LoongArch64 MAT/NR/NX 负逻辑）。fork 采用即时深拷贝策略，无 CoW。mmap 时立即分配全部物理帧（无 demand paging）。LoongArch64 低 RAM bank（物理内存不连续区域）通过 `add_region` 补充注册。 |
| **评价** | 基础功能完备，能满足竞赛场景的内存需求。但缺乏 demand paging 和 CoW 意味着大进程 fork 和 mmap 大区域时的内存开销较高。双架构适配考虑周全，PTE 标志位的架构差异处理正确。`emergency_reclaim()` 和 `alloc_uninit` 优化是工程质量的体现。 |

### 5.2 进程管理

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。完整度 85%（以 Linux ABI 进程模型为基准）。包含 fork/clone/clone3（CLONE_VM/THREAD/FS/FILES/SIGHAND 等标志）、execve/execveat、wait4/waitid、单核 round-robin 抢占调度、进程组/会话、孤儿僵尸回收。 |
| **关键发现** | clone 的标志处理细致，正确实现了地址空间、fd 表、信号处理表的 Arc 共享。vfork 的阻塞-唤醒链正确。64 KiB 内核栈内嵌于 TaskStorage。调度器使用 preempt_disable 计数而非关中断，持锁期间 timer 仍可触发。`block_and_retry_recheck()` 在标记 Waiting 后重新检查条件以消除 lost-wakeup。 |
| **评价** | 进程管理是最扎实的子系统之一。clone/clone3 的标志位覆盖广泛，满足 glibc pthread 创建的基本需求。但单核 round-robin 调度缺乏优先级和 I/O-vs-CPU 区分，在大任务负载下公平性有限。孤儿回收和 detached 线程回收机制减少了资源泄漏。 |

### 5.3 文件系统

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。完整度 70%（以竞赛测试集文件操作需求为基准）。包含 VFS Inode trait 抽象、ext4 只读（含 extent 树）、ext2 读写（含内核内 mkfs）、FAT32 只读、tmpfs、devfs、procfs、pipe、socket inode、inotify/fanotify。 |
| **关键发现** | ext4 extent 树解析是真正的工程成果（从 i_block 读取 extent header，magic 0xF30A，支持 inline 和 depth-1 索引）。ext2 内核内 mkfs 使空白设备无需外部工具即可格式化为 ext2。procfs 实现（1024 行）覆盖 /proc/<pid>/ 的主要状态导出。Inode trait 通过 `as_any()` 支持向下转型为具体文件系统类型。 |
| **评价** | VFS 抽象设计简洁，trait object 模式使多文件系统类型统一访问自然。ext4 驱动在只读范围内较为完整（extent 树支持超过常见的直接块映射）。ext2 可写支持团队级验证场景（`.format_device` 用例）。缺少日志支持和脏页回写机制，小写入性能较低。 |

### 5.4 交互设计

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现基础命令行交互。内核通过 SBI/direct console 输出启动日志和测试结果。busybox 作为用户态 shell 提供交互界面。竞赛编排器自动生成 init.sh 并执行。 |
| **关键发现** | 内核启动日志层次分明（硬件初始化、内存初始化、设备探测、VFS 挂载、测试编排各阶段有明确标记和状态输出）。竞赛编排器支持多种特性标志选择性运行测试（single_ltp、single_bench、diag_full_ltp），提供了灵活的测试粒度控制。崩溃时输出符号表解析的 function+offset 信息。 |
| **评价** | 内核交互偏向自动化测试而非人工交互。启动日志信息充足，各阶段状态明确（ok、fail、empty harness）。无交互式内核 shell/debugger 接口。busybox 作为用户态交互代理，覆盖了基本的 shell 命令。竞赛编排器的 init.sh 生成逻辑考虑了多 libc、多测试组的完整矩阵。 |

### 5.5 同步原语

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。完整度 70%（以所需最小同步机制集合为基准）。包含抢占安全 Mutex（preempt_disable 计数）、futex（WAIT/WAKE/BITSET/REQUEUE/CMP_REQUEUE）、force_unlock 恢复机制。 |
| **关键发现** | 抢占安全 Mutex 设计有别于传统关中断方案：持锁时仅递增 preempt_disable 计数，timer tick 和看门狗仍可运行。故障恢复路径通过 force_unlock 强制释放被遗弃栈持有的所有锁。futex 完整支持 BITSET 变体（pthread 条件变量核心依赖）和 CMP_REQUEUE（pthread_cond_broadcast 优化路径）。 |
| **评价** | 抢占安全 Mutex 的设计在单核环境下是合理的折中——避免了关中断导致的故障检测盲区。futex 实现覆盖了 glibc pthread 同步所需的核心操作（BITSET 和 CMP_REQUEUE 是关键）。但缺乏真正的读写锁意味着所有共享资源都是互斥访问，限制了潜在的并发优化空间。 |

### 5.6 资源管理

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。资源管理分散在多个子系统中：帧分配器的 OOM 紧急回收、tmpfs 容量限制、SysV IPC 128 MiB 全局上限、孤儿僵尸回收、文件描述符表 BTreeMap 管理、FrameTracker RAII 自动回收。 |
| **关键发现** | `emergency_reclaim()` 在 frames 耗尽时回收僵尸任务持有的帧，提供 OOM 下的优雅降级。孤儿僵尸回收设有 128 条目的表大小阈值，超过时触发批量清理。SysV IPC 共享内存全局容量限制为 128 MiB，防止单测试用例耗尽全部物理内存。FrameTracker RAII 守卫确保帧在不再引用时自动归还。 |
| **评价** | 资源管理机制分散但覆盖了主要资源类型（物理帧、内核堆、文件描述符、IPC 对象）。OOM 处理策略（紧急回收重试）在竞赛场景下是实用的，但缺乏更精细的资源会计（如 per-cgroup 限制）。128 MiB 的 SysV IPC 上限和 16 MiB 的块缓存是硬编码常量，无法在运行时调整。 |

### 5.7 时间管理

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。完整度 70%（以 POSIX 定时器需求为基准）。包含 1ms 抢占定时器 tick、clock_gettime（多种时钟类型）、clock_nanosleep、timer_create/timerfd、nanosleep、per-syscall 看门狗。 |
| **关键发现** | timer_create 通过实时信号（SIGRTMIN+1 起）通知到期，这是 POSIX 定时器的标准行为。clock_nanosleep 支持 TIMER_ABSTIME 标志（稳健定时等待的关键）。per-syscall 看门狗依赖 tick 计数检测 wedged syscall（约 8 秒超时）。 |
| **评价** | 基本定时功能覆盖了竞赛所需，但缺乏高精度事件定时器框架和 RTC 同步机制。1ms tick 精度对于大多数测试用例足够，但限制了需要微秒级精度的场景。看门狗机制在防止测试被单个卡死的系统调用阻塞方面是有效的竞赛策略。 |

### 5.8 系统信息

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。完整度 65%（以 /proc 文件系统要求为基准）。包含 procfs（1024 行）导出进程状态、内存统计、挂载表、CPU 信息等，以及内核崩溃时的符号表自解析。 |
| **关键发现** | procfs 的 /proc/<pid>/maps 输出格式与 Linux 兼容，支持 mmap 文件路径显示。两遍构建符号表嵌入：pass 1 用空占位符构建，gen_ksyms.py 从 ELF 提取符号，pass 2 用 include_bytes! 嵌入真实符号表。black_box + fat pointer 技巧保证两次 pass 生成字节相同的 .text。 |
| **评价** | procfs 为诊断提供了主要的系统信息接口，/proc/<pid>/maps 和 /proc/<pid>/status 的输出格式兼容性较好。符号表嵌入方案有较高的工程水平——不依赖外部 addr2line 或 Rust 版本特定的 .debug_info，且支持崩溃时自解析。但缺乏栈回溯、事件追踪等动态可观测性机制。 |

### 5.9 架构支持

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。RISC-V64 完整度 90%（缺 SMP、外部中断），LoongArch64 完整度 85%（含 TLB refill、FP/LSX/LASX、PCI 枚举）。双架构通过命名约定 + cfg 编译选择实现上层 95%+ 代码架构无关。 |
| **关键发现** | 架构抽象的核心是 TrapFrame 的方法统一：`user_pc()`、`syscall_arg(n)`、`set_syscall_ret()`、`advance_past_syscall()`、`enter_signal_handler()` 等在两个后端完全同签名。LoongArch64 自实现了 TLB Refill 异常处理（lddir/ldpte + tlbfill 硬件页表遍历），不依赖固件 SBI 等效调用。LoongArch64 的 FP/向量管理覆盖到 256-bit LASX（32 个 xr 寄存器 + fcc 标志 + fcsr），内核自身为 soft-float。 |
| **评价** | 双 ISA 支持是该项目最突出的架构特性之一。架构抽象的干净程度较高（上层代码几乎无 cfg 污染）。LoongArch64 后端的完整度在竞赛内核中较为少见——包含了 TLB Refill 自实现、PCI ECAM 枚举、256-bit LASX 状态管理。这些实现需要深入理解 LoongArch64 体系结构规范，显示出较强的底层编码能力。 |

### 5.10 系统调用覆盖

| 评价维度 | 内容 |
|---------|------|
| **是否实现及完整度** | 已实现。约 238 条 syscall，覆盖文件 I/O、进程管理、信号、网络、IPC、futex、epoll、splice 等核心类别。 |
| **关键发现** | 实现数量在竞赛内核中属于较为完整的水平。openat2（含 RESOLVE_* 标志）是 Linux 5.6+ 的较新 syscall。SysV IPC 三种机制完整实现，含 semaphore UNDO 语义。key management 子系统实现多种 keyctl 命令。splice 族（splice/tee/vmsplice）在内核内管道间实现了数据传输。 |
| **评价** | 系统调用覆盖面广，是该项目能够在竞赛测试中获得较高通过率的基础。不仅是简单 syscall，多种实现复杂的系统调用族（SysV IPC、splice、futex REQUEUE）均有实现，显示了较高的 ABI 兼容追求。但 io_uring、seccomp、bpf 等现代 LInux 关键接口的缺失限制了对最新用户态软件的兼容。 |

---

## 六、总结评价

xiande-OS 是一个面向 OS 内核竞赛的高质量 Rust 宏内核实现，总代码规模约 31,633 行（Rust + 汇编，55 个源文件），实现了约 238 条 Linux 系统调用。

**总体实现完整度：约 80%**（以竞赛赛道功能需求为基准，定义如下：能够通过核心竞赛测试集 [basic/lua/busybox/ltp/libctest/iperf-netperf/benchmarks] 中大部分测试用例所需的最小功能集合）。

### 核心优势

1. **双 ISA 架构支持**：RISC-V64 和 LoongArch64 两个后端均具有较高完成度。LoongArch64 端包含 TLB Refill 自实现、256-bit LASX 状态管理、PCI ECAM 枚举等深度实现。架构抽象层设计干净，上层代码 95% 以上无需条件编译。

2. **系统调用覆盖广泛**：238 条 syscall 实现覆盖了核心的系统编程接口，包括多种实现复杂的调用族（SysV IPC 三种机制含 UNDO 语义、splice 族内核内数据传输、futex 完整操作集含 CMP_REQUEUE）。openat2 等较新 syscall 的实现表明项目关注了 ABI 演进。

3. **工程品质扎实**：两遍构建符号表嵌入（崩溃时自解析 function+offset）、抢占安全 Mutex（不关中断但防止死锁）、per-syscall 看门狗 + force_unlock 故障恢复路径、OOM 紧急回收重试、vDSO + CFI 自实现（支持 glibc DWARF 栈回溯）等设计体现了较高的工程素养。

4. **自包含设计**：vendored 全部依赖、内嵌用户态二进制（busybox、git、ld-musl）、内嵌 vDSO、内核内 ext2 mkfs，使得内核可以在无外部工具链和库的环境中独立运行和验证。

5. **竞赛编排完善**：contest_runner 支持多 libc 变体矩阵、按优先级执行测试组、白名单管理、特性标志选择性运行，为竞赛评测提供了灵活的框架。在设备不足时优雅降级为 "empty harness"。

### 主要局限

1. **单核限制**：调度器为单 hart round-robin，无 SMP 支持。这限制了能运行的测试用例类型，也无法测试并发相关的竞态条件。

2. **内存管理简化**：无 demand paging（mmap 即时分配）和无 CoW（fork 深拷贝）。对于大内存操作和 fork 密集型测试，物理内存消耗较高。

3. **驱动覆盖有限**：仅支持 virtio-blk 和 virtio-net，使用轮询模式而非中断驱动。无 virtio-console/input/gpu、USB、NVMe 等驱动。

4. **无中断子系统**：外部中断处理和中断控制器抽象未实现。所有设备 I/O 通过轮询完成，在高 I/O 负载下效率和响应性受限。

5. **现代 Linux 接口缺失**：io_uring、eBPF、seccomp、cgroup 等未实现，限制了与最新用户态软件的兼容边界。

### 综合评价

该项目作为竞赛内核，在双架构支持、系统调用覆盖、工程品质三个维度上均表现出色。项目的技术亮点（预抢占安全 Mutex、两遍构建符号表、vDSO CFI 自实现、内核内 ext2 mkfs）反映了作者对操作系统底层机制的深入理解和解决实际问题的工程能力。其在测试编排和故障恢复方面的设计考虑也较为周全。主要局限集中在 SMP、现代 Linux 接口和驱动覆盖方面，这些对于竞赛赛道而言属于合理取舍。整体来看，这是一个完成度高、工程扎实、具有多个技术亮点的竞赛内核作品。