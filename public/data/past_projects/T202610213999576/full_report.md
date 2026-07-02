# QuasarOS 内核项目深入分析技术报告

## 一、分析方法概述

本报告基于以下分析方法：

1. **源码全文阅读**：对 `os/src/` 和 `user/src/` 下共 174 个 `.rs`/`.S` 源文件进行了系统性的逐文件阅读和分析。
2. **构建验证**：成功完成了 RISC-V64 (`kernel-rv`, 4.4MB) 和 LoongArch64 (`kernel-la`) 两个架构的 release 模式完整构建，无编译错误。
3. **交叉引用分析**：追踪了从内核入口 → 架构抽象 → 子系统初始化 → 系统调用分发 → 各层后端的完整调用链路。
4. **静态度量**：对代码规模、系统调用覆盖数、文件数量等进行了统计。

---

## 二、构建测试结果

### 构建成功

| 目标架构 | 产物大小 | 编译模式 | 警告数 | 状态 |
|----------|----------|----------|--------|------|
| RISC-V64 | 4.4 MB | release | 34 warnings | 成功 |
| LoongArch64 | 4.4 MB (估) | release | 43 warnings | 成功 |

- 使用的 Rust 工具链：`rustc 1.86.0-nightly (6067b3631 2025-01-17)`，target `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 均已安装。
- 构建流程：`user/` 先编译用户态二进制程序，`os/build.rs` 通过 `.incbin` 将它们嵌入内核镜像，最终链接输出 ELF。

### 未进行运行时测试

由于环境未配置 QEMU 所需的 RISC-V/LoongArch 固件与磁盘镜像（`sdcard-rv.img` / `sdcard-la.img`），未能进行 QEMU 运行时测试。构建验证已确认内核可正确编译链接。

---

## 三、子系统与功能全景

### 3.1 架构抽象层 (`os/src/arch/`)

该层通过编译期 `#[cfg(target_arch)]` 在 RISC-V64 和 LoongArch64 之间切换，所有上层代码通过 `crate::arch::*` 门面访问。

**RISC-V64 架构实现** (`riscv/`)：
- **入口汇编** (`entry.S`)：设置启动栈和全局指针后跳转到 Rust 的 `fake_main`。
- **陷阱处理** (`trap/mod.rs` + `trap.S`)：Direct模式的 `stvec`，统一汇编入口 `__alltraps`，通过 `sscratch` 寄存器区分为用户态/内核态陷阱。支持：
  - 用户态 syscall（ecall）
  - 页错误分派（Instruction/Load/Store PageFault）
  - 内核态陷阱 panic
  - 懒浮点上下文保存（按 FS 位检测）
  - 抢占式调度：syscall 返回路径上的调度节流（`SYSCALL_RETURN_SCHED_HZ`）
- **分页/TLB** (`mm/mod.rs`)：Sv39 页表，支持 `sfence.vma` 全刷/按va刷新。
- **SBI 封闭** (`sbi.rs`)：console_putchar、set_timer、shutdown。
- **配置** (`config.rs`)：`KERNEL_BASE_OFFSET`、`PAGE_SIZE`（4KB）、`CLOCK_FREQ`、调度参数等。
- **VirtIO 驱动** (`drivers/`)：MMIO VirtIO transport 探测和初始化。

**LoongArch64 架构实现** (`loongarch/`)：
- **陷阱处理** (`trap/mod.rs` + `trap.S`)：使用 `EENTRY` 统一入口，`PRMD` 区分内核/用户态。独特设计：
  - **硬件 TLB refill** (`handle_tlb_refill`)：利用 LoongArch 的三级页表硬件 walker 在汇编中完成 TLB 填充，失败时填入无效项并回退到软件缺页处理路径。
  - **合成时间片调度**：syscall 路径关闭中断，因此额外实现了 `SYSCALL_FAIR_RETURN_COUNTER`（每64次syscall触发调度），借鉴自 RocketOS。
  - **扩展单元管理**：通过 `EUEN` CSR 按需启用 FPU/LSX/LASX。
- **定时器** (`timer.rs`)：通过 `TCFG`/`TICLR` CSR 实现 one-shot timer。
- **分页** (`mm/mod.rs`)：三级页表，支持 `invtlb` 全刷（注：`flush_tlb_vaddr` 实际执行全刷）。

### 3.2 内存管理子系统 (`os/src/mm/`)

这是内核最核心的子系统之一，实现了类 Linux 的完整虚拟内存管理。

**地址抽象** (`address.rs`)：
- `PhysAddr`、`VirtAddr`、`PhysPageNum`、`VirtPageNum` 类型，提供安全的地址转换。
- 内核直接映射区的物理/虚拟地址转换函数（`kernel_virt_to_phys_addr`、`phys_to_kernel_virt_addr`）。

**物理页帧分配器** (`frame_allocator.rs`)：
- 栈式分配算法：`StackFrameAllocator`，维护 `current`（未分配区游标）和 `recycled`（回收栈）。
- 支持连续物理页分配（`frame_alloc_contiguous`），用于 VirtIO DMA。
- 引用计数跟踪：`FRAME_REFCNT`，用于 COW 和共享页管理。
- 内存压力回收：分配失败时自动触发 zombie 进程回收和 clean page cache 释放。

**页表** (`page_table.rs`)：
- 多级页表抽象，支持 Sv39（RISC-V）和 LoongArch 三级页表。
- token 生成（`satp`/`PGD` 寄存器值）。

**地址空间 MemorySet** (`memory_set.rs` + 子模块)：
- `MemorySet`：页表 + BTreeMap 有序 VMA 区域 + COW 额外帧 + 布局元数据。
- **VMA 管理** (`areas.rs`)：区域的映射/取消映射、合并（`try_merge_with_next`）、拆分、mprotect、mremap。
- **fork COW** (`fork.rs`)：深拷贝页表，将父子进程的私有可写页标记为只读 COW，共享物理帧。
- **ELF 加载** (`loader.rs`)：内核空间初始化、用户 ELF 映射（PT_LOAD 段）。
- **用户态访问** (`user_access.rs`)：跨地址空间的安全读写（`copy_to_user`/`copy_from_user`），含页权限检查。

**MapArea 与文件映射** (`map_area.rs`)：
- `MapType`：线性映射（直接分配物理页）vs 按需映射（缺页时填充）。
- `VmAreaBacking`：支持匿名映射、文件映射、共享匿名映射等后端类型。
- `FilePageLoad`：描述文件映射的缺页填充参数。

**内核堆分配器** (`mod.rs`)：
- 基于 `buddy_system_allocator::LockedHeap<32>` 的自定义全局分配器。
- 详细统计：容量、当前用量、峰值、分配/释放/重分配计数、失败计数。
- **堆压力回收**：分配失败时自动回收僵尸进程资源和 clean block cache（最多 8192 个块）。

**交换框架** (`swap.rs`)：
- 接口已定义但默认关闭（`SWAP_ENABLED: bool = false`）。
- 记录缺页/COW拆分/懒分配统计计数器。

**用户地址布局** (`layout.rs`)：
- `UserVmLayout`：定义堆、栈、mmap 区域、TLS 区域、栈守护页的虚拟地址边界。

**虚拟地址分配** (`vmalloc.rs`)：内核虚拟地址空间的动态分配和释放。

### 3.3 进程管理子系统 (`os/src/process/`)

**进程控制块** (`pcb.rs`)：
```rust
pub struct ProcessControlBlock {
    pub pid: usize,
    pub group: Arc<ThreadGroupShared>,
    pub exec_path: String,
    pub state: ProcessState,  // Ready / Running / Blocked / Zombie
    pub exit_code: i32,
    pub memory_set: SharedMemorySet,
    pub trap_cx_frame: FrameTracker,  // 线程私有 TrapContext 页
    pub used_fpu: bool,
    pub fpu_euen_bits: usize,
    pub fd_table: SharedFiles,
    pub fs_context: SharedFsContext,
    pub signal_shared: SharedSignal,
    pub sysvsem: SharedSysvsem,
    pub clear_child_tid: usize,
    pub robust_list_head: usize,
    pub robust_list_len: usize,
    pub sched_policy: isize,
    pub sched_priority: i32,
    pub sched_runtime/deadline/period: u64,
}
```
- TrapContext 布局：位于内核栈页末尾（`TRAP_CONTEXT_OFFSET = PAGE_SIZE - sizeof(TrapContext)`），前面是内核栈。

**进程管理器** (`manager.rs`)：
- `ProcessManager`：PID 分配（复用已释放 PID）、进程槽位 Vec、就绪队列 + BTreeSet 去重、空闲 PID 栈。
- **实时调度支持**：`scan_ready_rt_pid_except` 按 SCHED_FIFO/SCHED_RR 优先级扫描就绪 RT 任务。
- 线程限制：每组最多 1024 线程，全局最多 4096 线程。

**线程组共享结构** (`shared.rs`)：
- `ThreadGroupShared`：tgid、leader_pid、parent_pid、exit_signal、session/pgrp、凭证（uid/gid/suid...）、资源限制（rlimit）、能力位图（capability）、seccomp 过滤器、时间命名空间偏移等。
- `SharedFiles`、`SharedFsContext`、`SharedSignal`、`SharedSysvsem` 等 Arc 共享句柄。

**exec 执行链** (`exec/`)：
- `entry.rs`：`exec_from_path` 和 `exec_current_from_path_with_argv_env` 主流程。
  - 线程组收敛（exec 时摧毁同组其他线程）。
  - 创建新地址空间、加载 ELF、设置用户栈（argv/env/auxv）。
  - 支持动态链接（`create_user_memory_dynamic`）、相对重定位。
  - TLS 初始化（glibc `TPIDR` 约定、`RISCV_GLIBC_TLS_PRE_TCB_SIZE=1888`）。
- `image.rs`：可执行文件缓存（`EXEC_IMAGE_CACHE`）。
- `interp.rs`：解释器路径推断（`LD_LIBRARY_PATH` 环境变量）。
- `shebang.rs`：`#!` 脚本解释器解析。
- `stack.rs`：用户栈写入、auxv 构造。
- `tls.rs`：线程指针初始化、全局指针（`gp`）引导。

**clone/fork 实现** (`syscall/process/clone.rs`)：
- 支持完整的 clone/clone3 语义。
- fork 子进程优先调度策略（内存压力时优先运行子进程）。
- glibc fork 子进程 TCB 清理（`sanitize_riscv_glibc_fork_child_tcb`）：修复 `multiple_threads`、线程链表、stackblock 等字段。
- vfork 父子同步（`VFORK_WAITERS`）。

**缺页处理** (`fault.rs`)：
- `handle_user_page_fault`：分派 COW、懒分配、文件映射填充、栈自动增长（`grow_down_page_for_fault`）。
- 共享匿名映射缺页支持（hugetlbfs）。

**延迟回收** (`recycle.rs`)：
- `RECYCLED_PROCESSES`：存放已摘除 PCB，延迟析构以避免在进程表锁内触发复杂 Drop。
- `DEFERRED_ZOMBIE_MEMORY_RELEASES`：延迟释放地址空间。
- 基于水位线的分批回收策略（`RECYCLE_DRAIN_PCB_HIGH_WATERMARK=64` 等）。
- 堆压力驱动的回收（`drain_recycled_processes_for_heap_failure`）。

### 3.4 文件系统子系统 (`os/src/fs/`)

这是内核最大、最复杂的子系统。

**VFS 核心** (`vfs_core/`)：
- **inode** (`inode.rs`)：`VfsInode` 含 `VfsInodeOperations` 虚表、metadata、address_space。
- **dentry** (`dentry.rs`)：目录项缓存 `VFS_DCACHE`，支持负向缓存（`VfsLookupFlags`）。
- **file** (`file.rs`)：`VfsFile` 含 `VfsFileOperations` 虚表、`VfsDirContext`。
- **superblock** (`superblock.rs`)：`VfsSuperBlock`、`VfsFileSystemType`、挂载回调。
- **mount** (`mount.rs`)：`VfsMount`、`VfsPath` 挂载树管理。
- **namei** (`namei.rs`)：路径查找 `lookup_openat`、`lookup_parent_with_subject`、`lookup_path_with_subject`，支持 `LastType`（最后组件类型）、`VfsOpenIntent`。
- **address_space** (`address_space.rs`)：页缓存（page cache），`VfsAddressSpaceOperations`。
- **permission** (`permission.rs`)：权限检查（UID/GID/capability）。
- **api** (`api.rs`)：约 80+ 个对外 API 函数的统一入口，将 syscall 层与 VFS 内部实现解耦。

**VFS 操作分片** (`vfs_core/ops/`)，约 22 个文件：
- `regular_io.rs`：generic_file_read_iter/write_iter。
- `mmap.rs`：文件映射支持（`vfs_apply_mmap_region_checked`）。
- `poll.rs`：epoll/poll/select 事件管理。
- `create.rs`/`remove.rs`/`rename.rs`：目录项的创建/删除/重命名。
- `metadata.rs`：stat/getattr/setattr/utimes。
- `xattr.rs`：扩展属性支持（getxattr/setxattr/listxattr/removexattr）。
- `lock_notify.rs`：文件锁（flock/fcntl lock）和目录通知（dnotify）。
- `pipe_ops.rs`：管道读写操作。
- `mount_ops.rs`：mount/umount/move_mount/open_tree。
- `handle.rs`：name_to_handle_at/open_by_handle_at。
- `fd.rs`/`fd_targets.rs`：文件描述符管理。
- `directory.rs`：getdents/readdir 迭代。
- `device.rs`：设备号管理、mknod。
- `virtual_file.rs`：虚拟文件支持（/proc/$pid/fd 等）。
- `path.rs`：路径操作（getcwd、chdir、chroot）。
- `test_compat.rs`：测试兼容层。
- `common.rs`：通用辅助函数。
- `legacy.rs`：迁移期遗留接口。
- `iozone_trace.rs`：iozone 基准测试追踪。

**ext4 磁盘层** (`ext4/`)：
- `layout.rs`（约 300 行）：完整的 ext4 磁盘结构定义：
  - `SuperBlock`、`Inode`、`DirEntry`、`GroupDesc`（64 字节版本）
  - `ExtentHeader`、`ExtentIndex`、`ExtentLeaf`——ext4 extent 树解析
  - 小端字节读取辅助函数
- `ext4.rs`（约 3998 行）：完整的 ext4 raw 实现：
  - 超级块解析和挂载
  - inode 读取/写入（`read_inode`/`write_inode`）
  - extent 树遍历：逻辑块号 → 物理块号映射
  - 目录项查找/添加/删除（含缓存 `DIR_ENTRY_CACHE`，上限 16384 条）
  - 数据块分配（`allocate_blocks`）、位图扫描
  - inode 数据缓存（`INODE_DATA_CACHE`，上限 512 条）
  - 块映射缓存（`BLOCK_MAP_CACHE`，上限 65536 条）
  - 文件读写（`read_at_raw`/`write_at_raw`）

**块缓存层** (`block/`)：
- `cache.rs`：`BlockCache`，管理块设备的缓存块，支持脏块回写、clean cache 淘汰。

**文件系统后端** (`filesystems/`)：
- `ext4fs.rs`：ext4 VFS 适配，将 raw ext4 API 接入 VFS 虚表。实现了：
  - `EXT4_SUPER_OPS`、`EXT4_INODE_OPS`（lookup/create/mkdir/unlink/rename/getattr/setattr...）
  - `EXT4_ADDRESS_SPACE_OPS`（readpage/readpages/writepage/writepages）
  - `EXT4_FILE_OPS`、`EXT4_DIR_FILE_OPS`、`EXT4_SPECIAL_FILE_OPS`（普通文件/目录/特殊文件）
- `ramfs.rs`：内存文件系统（当前默认 root）。
- `procfs.rs`：/proc 伪文件系统，支持：
  - 按 PID 的进程信息节点（`/proc/$pid/fd`、`/proc/$pid/mountinfo` 等）
  - 可写 sysctl（`/proc/sys/`）
  - hugetlb 统计（`/proc/sys/vm/nr_hugepages` 等）
  - 动态生成的伪文件内容
- `sysfs.rs`：/sys 伪文件系统。
- `devfs.rs`：/dev 设备文件系统。
- `pipefs.rs`：管道文件系统，支持 pipe2 创建、阻塞/非阻塞读写、poll、splice。
- `anon_inode.rs`：匿名 inode（epoll/timerfd/signalfd 等）。
- `mod.rs`：文件系统类型注册表 `VFS_FILESYSTEM_TYPES`，名字归一化（rootfs→ramfs、ext2/ext3→ext4 等）。

**文件描述符表** (`fdtable.rs`)：
- `FdTable`：基于 Vec 的文件描述符表，支持 `CLOEXEC`、`O_NONBLOCK`、`O_PATH` 等标志。
- `FileDescriptor`：持有 `Arc<VfsFile>` 和标志位。

### 3.5 网络子系统 (`os/src/net/`)

基于 smoltcp 0.12.0 构建的类 Linux socket 层。

**核心结构** (`mod.rs` + `socket.rs`)：
- `Socket` 枚举：Tcp/Udp/Icmp/Local/Netlink/Packet/Alg 变体。
- `SocketAddr`：统一地址类型（IPv4/IPv6/Unix/Packet/Netlink）。
- loopback 设备（地址 127.0.0.1，MTU 65536）和 eth0 设备（地址 10.0.2.15，MTU 1500）。
- `ifreq`/`ifconf` ioctl 实现（SIOCGIFCONF/SIOCGIFFLAGS/SIOCGIFADDR 等）。

**协议特定实现**：
- `tcp.rs`（约 1105 行）：TCP socket，smoltcp TcpSocket 封装，支持阻塞/非阻塞 connect/accept/send/recv、nagle 算法、keepalive。
- `udp.rs`（约 633 行）：UDP socket，支持 sendto/recvfrom。
- `icmp.rs`（约 307 行）：ICMP raw socket。
- `local.rs`（约 812 行）：AF_UNIX 本地 socket（流/数据报），带监听 backlog 和连接队列。
- `netlink.rs`（约 352 行）：NETLINK 最小兼容实现（RTM_GETLINK/RTM_GETADDR）。
- `packet.rs`（约 550 行）：AF_PACKET raw socket（ETH_P_ALL）。
- `alg.rs`（约 255 行）：AF_ALG 加密算法 socket 占位实现。

**smoltcp 集成** (`smol.rs`，约 667 行)：
- smoltcp `Interface` 初始化、轮询（`poll`）、设备抽象。
- DHCP 地址配置（通过 `smoltcp::socket::dhcp`）。

### 3.6 信号子系统 (`os/src/signal/`)

**核心** (`mod.rs`，约 1559 行)：
- 信号递送：在 trap 返回用户态前检查 pending 信号，构建用户态 signal frame。
- signal frame 安装：将 sigaction handler 地址、siginfo、ucontext 压入用户栈，设置 trampoline 返回地址。
- trampoline 机制：用户态信号处理器返回时通过 trampoline（`li a7,139; ecall`）执行 `rt_sigreturn` 恢复上下文。
- **SIGCHLD** 处理：子进程退出时向父进程发送 SIGCHLD。
- 阻塞 syscall 中断：通过 `has_unmasked_pending_signal` 检查在 wait/futex/socket/poll 等阻塞点检测信号。

**运行时状态** (`runtime.rs`，约 237 行)：
- `PENDING_SIGNALS`：per-process 待处理信号队列。
- `SIGNAL_MASKS`：per-thread 信号屏蔽字（64位位图）。
- `SIGTIMEDWAIT_WAITERS`：sigtimedwait 等待者管理。
- `ACTIVE_SIGNAL_CONTEXTS`：活跃信号上下文。

**类型定义** (`types.rs`)：
- `UserSigAction`：sigaction 结构体。
- `CompatSigInfo`：siginfo_t 兼容结构。
- `CompatStackT`：stack_t 兼容结构。
- `CompatUContext`：ucontext_t 兼容结构。

**常量** (`constants.rs`)：信号编号（SIGINT=2、SIGKILL=9、SIGSEGV=11 等）、标志位（SA_RESTART、SA_SIGINFO 等）、si_code。

### 3.7 系统调用层 (`os/src/syscall/`)

**分发入口** (`mod.rs`，约 962 行)：
- 约 **232 个系统调用编号**定义（RISC-V Linux ABI）。
- 统一分发函数 `syscall_dispatch`：6 个参数寄存器 → 按 syscall_id 分发 → 返回负 errno。
- seccomp 过滤检查。
- syscall 追踪（iperf/netperf/ltp 基准测试）。

**文件系统系统调用** (`fs/`)：
- `io.rs`：read/write/readv/writev/pread64/pwrite64/preadv/pwritev/preadv2/pwritev2/sendfile。
- `fd.rs`：openat/openat2/close/dup/dup3/pipe2/eventfd2/epoll_create1/epoll_ctl/epoll_pwait/epoll_pwait2。
- `meta.rs`：fstat/newfstatat/statx/utimensat/truncate/ftruncate/fallocate/fadvise64/readahead。
- `path.rs`：getcwd/chdir/fchdir/chroot/readlinkat/faccessat/faccessat2。
- `mount.rs`：mount/umount/move_mount/open_tree/statfs/fstatfs/syncfs/sync/fsync/fdatasync/sync_file_range。
- `poll.rs`：pselect6/ppoll/signalfd4。
- `common.rs`：copy_file_range/splice/vmsplice/tee/linkat/symlinkat/renameat/mknodat。
- `abi.rs`：renameat2/setxattr/getxattr/listxattr/removexattr/name_to_handle_at/open_by_handle_at。

**进程系统调用** (`process/`)：
- `clone.rs`：clone/clone3（约 800+ 行，含完整 fork/vfork 语义）。
- `exec.rs`：execve。
- `exit.rs`：exit/exit_group。
- `wait.rs`：wait4/waitid。
- `futex.rs`：futex/set_robust_list/get_robust_list。
- `misc.rs`：prctl/capget/capset/prlimit64/unshare/setns/personality。
- `sched.rs`：sched_* 系列（14 个调度 syscall）。
- `shm.rs`：shmget/shmat/shmdt/shmctl。
- `user.rs`：getpid/getppid/gettid/setuid/setgid/setresuid/setresgid/getgroups/setgroups 等。

**内存系统调用** (`mm.rs`，约 1195 行)：
- brk/mmap/munmap/mremap/mprotect/msync/madvise/mincore/mlock/munlock/mlockall/munlockall/mlock2。
- get_mempolicy/set_mempolicy。

**网络系统调用** (`net.rs`，约 2439 行)：
- socket/bind/listen/connect/accept/accept4。
- sendto/recvfrom/sendmsg/recvmsg/sendmmsg/recvmmsg。
- getsockname/getpeername/getsockopt/setsockopt/shutdown。
- 含 netperf 追踪、musl 特殊路径修复（`try_fixup_musl_sendmsg_fault` 等）。

**时间系统调用** (`time/`)：
- `clock.rs`：clock_gettime/clock_settime/clock_getres/clock_nanosleep/gettimeofday/settimeofday/adjtimex/time。
- `sleep.rs`：nanosleep。
- `timer.rs`：timer_create/timer_settime/timer_gettime/timer_delete。
- `timerfd.rs`：timerfd_create/timerfd_settime/timerfd_gettime。
- `itimer.rs`：getitimer/setitimer/getrusage。

**系统信息** (`system/`)：
- `info.rs`：sysinfo/syslog/reboot/getcpu。
- `uts.rs`：uname/sethostname/setdomainname。

**信号系统调用** (`signal/mod.rs`)：
- rt_sigaction/rt_sigprocmask/rt_sigsuspend/rt_sigtimedwait/kill/tkill/tgkill/restart_syscall。

**用户访问辅助** (`uaccess.rs`)：checked user pointer copy。

### 3.8 设备驱动 (`os/src/drivers/`)

- `block.rs`：VirtIO 块设备驱动。基于 `virtio-drivers` crate 的 `VirtIOBlk`。实现自定义 `VirtioHal`（DMA 内存分配使用连续物理页）。
- `net.rs`：VirtIO 网络设备驱动。基于 `VirtIONetRaw`，实现 `NetDevice` trait，提供固定大小的网络缓冲区池（`NetBufPool`）。仅在 RISC-V 平台尝试探测 MMIO VirtIO-net（地址 0x1000_2000）。

### 3.9 ELF 加载器 (`os/src/loader/`)

- `elf.rs`（约 633 行）：基于 `xmas-elf` crate 的 ELF 解析。提取 `ProgramHeader`、`TlsTemplateInfo`、`ElfInfo`（phdr 位置、entry、tls vaddr、dynamic vaddr/size）。支持动态重定位（`apply_relative_relocations_with_token`）。
- `builtin.rs`：从内核镜像 `.incbin` 段中获取内置用户程序 ELF 数据。

### 3.10 UAPI 常量 (`os/src/uapi/`)

Linux 用户态 ABI 常量定义，12 个子模块：
- `errno.rs`：约 284 行，130+ errno 常量。
- `signal.rs`：信号编号、标志位、si_code。
- `socket.rs`：AF_/SOCK_/IPPROTO_/MSG_ 常量。
- `ioctl.rs`：ioctl 命令号。
- `poll.rs`：POLLIN/POLLOUT/POLLERR 等。
- `mm.rs`：MADV_/MLOCK_/MREMAP_ 常量。
- `fs.rs`：O_/AT_/S_IF/DT_ 文件系统常量。
- `futex.rs`：FUTEX_ 操作常量。
- `process.rs`：CLONE_/PR_/SCHED_/RLIMIT_ 常量。
- `termios.rs`：终端控制常量。
- `elf.rs`：ELF PT_/PF_/DT_ 常量。
- `auxv.rs`：AT_ aux vector 常量。

---

## 四、各子系统交互关系

### 4.1 启动流程

```
_entry.S (arch) → fake_main → rust_main
  → clear_bss()
  → mm::init()          # 物理内存初始化、页帧分配器
  → process::init_runtime_state()  # 进程管理器、comm表
  → syscall::init_runtime_state()  # syscall辅助状态
  → fs::init_runtime_state()       # pipefs、mount运行时状态
  → trap::init()         # 设置stvec/EEENTRY异常入口
  → mm::activate_kernel_space()   # 激活内核页表
  → drivers::init_runtime_state() # 探测VirtIO块设备
  → test_block_device() → fs::init_filesystems()
       → ext4::init()             # 加载超级块
       → register_builtin_filesystems()  # 注册ramfs/procfs/...
       → vfs_api_root_path()      # 挂载root
       → vfs_api_mount_procfs/sysfs
       → vfs_api_mount_test_roots_from_ext4()  # 挂载glibc/musl目录
  → user_init() → try_exec_from_path("/init")
       → exec_from_path → process切换到用户态
```

### 4.2 系统调用路径

```
用户程序 ecall/syscall
  → __alltraps (汇编陷阱入口)
    → trap_handler (Rust陷阱分发)
      → syscall_dispatch (syscall编号路由)
        → sys_* 具体实现
          → VFS API (vfs_core::api)
            → VFS ops → 文件系统后端 (ext4fs/ramfs/procfs/...)
            → ext4 raw层 → 块缓存层 → VirtIO块设备
          → 或 进程管理 (process::manager)
          → 或 网络 (net::socket → smoltcp)
          → 或 信号 (signal::enqueue_pending_signal)
      → 调度检查 (maybe_schedule_on_syscall_return)
  → __restore (汇编恢复上下文)
    → sret/ertn 返回用户态
```

### 4.3 缺页处理路径

```
硬件页错误
  → __alltraps
    → trap_handler
      → dispatch_page_fault
        → handle_user_page_fault
          → COW 检查 (memory_set.handle_cow_fault)
          → VMA 查找 (memory_set.find_area_info)
          → 匿名页分配 (map_page_in_area)
          → 文件映射填充 (describe_file_page_load → vfs_api_mmap_shared_backing_page_ppn)
          → 栈自动增长 (grow_down_page_for_fault)
```

### 4.4 信号递送路径

```
trap_handler 返回前
  → signal::has_signal_work_fast
    → 构建 signal frame：
      1. 将当前用户寄存器状态压入用户栈
      2. 设置 sigaction handler 为返回地址
      3. 设置 trampoline 为 ra
      4. 将 a0=signo, a1=siginfo_ptr, a2=ucontext_ptr
    → 修改 TrapContext 中的 sepc/era 指向 handler
    用户态 handler 执行完毕 → ret → trampoline → rt_sigreturn syscall
      → 恢复原始上下文
```

---

## 五、实现完整度评估

基于以下基准进行评估：**一个完整的类 Linux 内核应具备的核心功能**。

### 5.1 各子系统实现完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 内存管理 | **85%** | 完整的分页/页帧/VMA/COW/mmap/brk/file-mmap。swap 接口存在但默认关闭。缺 hugepage 的完整支持（部分兼容）。缺 KSM、THP、NUMA。 |
| 进程管理 | **80%** | 完整的 fork/clone/clone3/exec/wait/exit 生命周期。支持线程组、凭证、rlimit、调度策略。缺 cgroup、完整命名空间隔离（仅有 UTS namespace 占位）。 |
| 文件系统 (VFS) | **80%** | 完整的 VFS 框架（inode/dentry/file/superblock/mount/namei/page cache）。多后端支持。缺完整日志、配额、acl、回写节流。 |
| ext4 支持 | **65%** | 支持 extent 树查找、目录项操作、数据读写、块分配。但**仅支持读取已存在的文件系统**——写操作限于现有块/目录项范围，不支持在线扩展开辟新 extent、不支持日志（journal）。 |
| 网络 | **60%** | TCP/UDP/ICMP/AF_UNIX/AF_PACKET/NETLINK 基本功能。基于 smoltcp 而非独立实现。缺 IPv6 完整支持、路由表、ARP 表管理、防火墙。 |
| 信号 | **75%** | 完整的信号递送、mask 管理、sigaction/siginfo。缺实时信号排队（仅简单队列）、核心转储（core dump）。 |
| 时间 | **70%** | 完整的 clock/timer/nanosleep/timerfd。缺高精度定时器（hrtimer）框架、NTP 调整。 |
| 设备驱动 | **50%** | 仅 VirtIO block/net（MMIO transport）。缺 PCI 总线、USB、SATA、显示等。 |
| 系统调用覆盖 | **75%** | 约 232 个 syscall 编号定义，约 224 个有具体实现。覆盖 Linux RISC-V ABI 的核心子集。缺 ptrace、perf_event_open、bpf 等复杂 syscall。 |

### 5.2 总体完整度

**整体评估：约 70% 的类 Linux 内核完整度**（相对于比赛评测基准所需功能）。

该内核以"支撑 LTP、busybox、libc-test、lmbench、iozone、iperf、netperf 等基准测试"为目标，其功能实现与此目标高度吻合。在比赛评测场景下，其关键路径（文件IO、进程生命周期、信号、socket通信、内存管理）均有较完整的实现。

---

## 六、设计创新性分析

### 6.1 双架构并行支持

QuasarOS 同时支持 RISC-V64 和 LoongArch64，这在同类比赛项目中较为少见。架构抽象通过编译期 `#[cfg]` 门面实现，上层代码零感知。特别是 LoongArch 的实现包含：
- 自定义硬件 TLB refill 汇编路径（利用 LoongArch 三级页表硬件 walker）。
- EUEN 按需打开 FPU/LSX/LASX 扩展。
- 合成时间片调度弥补 syscall 路径关中断的设计选择。

### 6.2 完整的 Linux ABI 兼容层

内核追求与 Linux 用户态 ABI 的精确兼容，而非仅满足基本功能：
- 约 232 个 syscall 覆盖、12 个 UAPI 常量模块（130+ errno、完整的 signal/socket/ioctl 常量）。
- **特定 glibc/musl 兼容修复**：如 `sanitize_riscv_glibc_fork_child_tcb`（修复 glibc fork 子进程 TCB 残留状态）、`try_fixup_musl_sendmsg_fault`（绕过 musl sendmsg 中的坏指针问题）。
- `ext4` 名字归一化：ext2/ext3 映射到 ext4、rootfs 映射到 ramfs 等，提升用户态工具兼容性。

### 6.3 延迟回收与内存压力管理

- **两级延迟回收**：PCB 回收队列 + 地址空间延迟释放队列，基于水位线和堆压力的自适应回收策略。
- **内核堆压力回收**：全局分配器在分配失败时自动触发僵尸进程回收和 clean block cache 淘汰（`reclaim_recycled_process_resources`）。
- **页帧分配器压力回收**：frame_alloc 失败时主动触发进程回收 + clean page cache 释放。

### 6.4 详尽的诊断与调试支持

- 内核堆分配器统计（容量、当前用量、峰值、分配/释放/失败计数）。
- 帧分配器失败追踪（连续失败 streak 计数、限流日志）。
- 多种基准测试追踪（netperf/iperf/iozone/LTP exec）。
- 进程回收统计（队列长度、排水量、背压计数）。
- MemorySet 生命周期计数（创建数/销毁数/页表帧释放数）。

### 6.5 实用的测试兼容特性

- 内置用户程序嵌入（通过 `build.rs` 的 `.incbin` 和 `[[bin]]` 清单自动发现）。
- `/proc/sys/` 可写 sysctl 状态（如 `nr_hugepages`、`drop_caches`），直接服务测试程序。
- `is_noop_mkfs_path`、`is_virtual_busybox_applet_path` 等虚拟执行路径支持。

---

## 七、其他重要信息

### 7.1 代码规模

| 类别 | 文件数 | 总行数（估） |
|------|--------|-------------|
| 内核 Rust 源文件 | ~158 | ~85,700 |
| 用户态 Rust 源文件 | ~14 | ~5,800 |
| 汇编源文件(.S) | 4 | ~500 |
| 链接脚本(.ld) | 4 | ~200 |

### 7.2 依赖的第三方 crate

- `buddy_system_allocator`：内核堆分配
- `spin`：自旋锁（Mutex）
- `bitflags`：位标志宏
- `hashbrown`：高性能 HashMap/HashSet
- `riscv`：RISC-V CSR 寄存器访问
- `lazy_static`：静态变量延迟初始化
- `virtio-drivers`：VirtIO 块/网络设备驱动
- `xmas-elf`：ELF 解析
- `smoltcp`：TCP/IP 协议栈
- `log`：日志门面

### 7.3 用户态内置程序

- **启动/管理**：`init`、`testmgr`、`ltp_runner`、`osh`（带命令补全的 shell）。
- **Unix 工具**：awk、cp、file、gzip、ln、mv、readelf、sed、seq、wc、which。
- **网络工具**：ifconfig、ip、netstat。

---

## 八、项目总结

QuasarOS 是一个面向操作系统内核设计赛的中等规模 Rust no_std 内核项目，内核代码量约 85,700 行，用户态代码量约 5,800 行。其核心特征如下：

**优势与亮点**：
1. **双架构（RISC-V64 + LoongArch64）**并行支持，架构抽象层设计清晰、隔离度高。
2. **类 Linux ABI 的高兼容性**：约 232 个系统调用、完整的 VFS 框架（含 ext4 extent 树支持）、信号子系统、多种文件系统后端。
3. **实用的内存管理**：COW、mmap 文件映射、共享匿名映射、栈自动增长、延迟回收与自适应内存压力管理。
4. **丰富的网络支持**：基于 smoltcp 的 TCP/UDP/ICMP/AF_UNIX/AF_PACKET/NETLINK，以及自定义 VirtIO-net 驱动。
5. **良好的比赛适应性**：直接面向 LTP、libc-test、lmbench、iozone、iperf、netperf 等基准测试优化，包含大量测试兼容特性和诊断设施。
6. **详尽的调试/诊断基础设施**：内核堆统计、帧分配追踪、进程回收计数、多种基准测试追踪日志。

**不足与待改进**：
1. ext4 实现仅支持读取已有文件系统结构，写路径不支持在线扩展新的 extent 和日志（journal）。
2. swap 框架接口存在但默认禁用，无实际换页实现。
3. 设备驱动仅覆盖 VirtIO MMIO transport，无 PCI 总线支持。
4. 网络栈基于 smoltcp 而非独立实现，性能受限于 smoltcp 的设计。
5. 命名空间隔离仅占位实现（UTS namespace），无完整容器支持。
6. 部分 syscall 仅有占位实现（如 AF_ALG socket），返回 `-ENOSYS` 或 `-EINVAL`。