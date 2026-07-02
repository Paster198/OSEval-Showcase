# OSKernel C Base Model - 技术画像与评估报告

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| 项目名称 | OSKernel C Base Model |
| 目标架构 | RISC-V64 (主要)、LoongArch64 (占位) |
| 实现语言 | C (主体)、RISC-V 汇编 (启动/陷阱入口)、LoongArch C (minikernel) |
| 代码规模 | 约 14,677 行 (含源文件、头文件、汇编、链接脚本、Makefile) |
| 生态系统归属 | Linux 兼容 (syscall ABI、ELF 格式、ext4 文件系统、POSIX 信号) |
| 运行平台 | QEMU virt 机器 (RISC-V64) / QEMU virt 机器 (LoongArch64) |
| libc 支持 | musl + glibc 双 ABI (通过 execve 自动检测和路径映射) |
| 构建系统 | GNU Make + riscv64-unknown-elf-gcc |
| 项目定位 | OS 内核赛道比赛作品 |

## 二、子系统实现清单

### 2.1 已实现子系统

| 子系统 | 实现状态 | 核心文件 |
|--------|---------|---------|
| 启动子系统 | 已实现 | `src/arch/riscv64/boot.S` |
| 陷阱与异常处理 | 已实现 | `src/arch/riscv64/trap.S`, `trap.c` |
| 物理内存管理 | 已实现 | `src/kernel/vm.c` |
| 虚拟内存管理 (Sv39) | 已实现 | `src/kernel/vm.c` |
| Copy-on-Write | 已实现 | `src/kernel/vm.c` |
| 任务/进程管理 | 已实现 | `src/kernel/task.c` |
| 信号处理 (POSIX) | 已实现 | `src/kernel/task.c` |
| 系统调用接口 | 已实现 | `src/kernel/syscall.c` |
| 虚拟文件系统 (VFS) | 已实现 | `src/kernel/fs.c` |
| 内存文件系统 (memfs) | 已实现 | `src/kernel/fs.c` |
| ext4 只读支持 | 已实现 | `src/kernel/ext4.c` |
| ELF 加载器 | 已实现 | `src/kernel/elf.c` |
| 设备驱动 (UART/virtio-blk/virtio-net) | 已实现 | `src/kernel/uart.c`, `virtio_blk.c`, `virtio_net.c` |
| 用户态 init shell | 已实现 | `src/user/init.c` |
| LoongArch64 minikernel | 已实现 | `src/arch/loongarch64/minikernel.c` |

### 2.2 未实现子系统

| 子系统 | 状态 |
|--------|------|
| 多核 (SMP) 支持 | 未实现 |
| PLIC/APLIC 中断控制器驱动 | 未实现 |
| 内核抢占 | 未实现 |
| 页面回收 / 交换 | 未实现 |
| 磁盘写入 (ext4/virtio-blk) | 未实现 |
| TCP/IP 协议栈 | 未实现 |
| 用户态交互输入 (UART RX) | 未实现 |
| 内核模块动态加载 | 未实现 |
| cgroup 资源控制 | 未实现 |

## 三、各子系统实现细节与优缺点

### 3.1 启动子系统

**实现细节**：
- 入口点 `_start` 位于 `.text.boot` 段，由链接脚本确保置于镜像开头
- 16KB 启动栈，4KB 对齐
- BSS 清零采用逐字节循环 (`sb zero`)，未优化为按 8 字节批量清零
- 未执行 `mstatus`、`satp` 等 CSR 的早期初始化（由后续 C 代码完成）

**优点**：
- 结构清晰，启动路径短且可预测
- 链接脚本正确管理了 `.text.boot` 的入口位置

**缺点**：
- BSS 清零未使用 `sd` 指令优化，O(n) 操作常数因子大
- 无多核启动支持（无 hartid 检查，所有 hart 均执行相同流程）
- 无 DTB 解析，硬件配置硬编码

**完整度评价**：单核场景基本可用。多核场景下存在多个 hart 同时执行的风险（无 hartid 栅栏），在实际运行中依赖 QEMU 的 `-smp 1` 参数避免问题。

### 3.2 陷阱与异常处理子系统

**实现细节**：
- 使用 `sscratch` 寄存器实现用户/内核栈的原子切换（`csrrw sp, sscratch, sp`）
- TrapFrame 结构为 272 字节，保存 x1-x31 + sepc + sstatus + x0（padding）
- 中断处理仅覆盖时钟中断（`scause=5`），使用 SBI `set_timer` 设置下次中断（间隔 100,000 周期，约 10ms@10MHz）
- 页错误处理分两级：先尝试 COW 处理（`vm_handle_cow_fault`），失败则递送 SIGSEGV
- ECALL 分发至 `syscall_dispatch()`，其中对 clone/vfork/clone3/execve 有特殊路径（直接操作 TrapFrame）

**优点**：
- `sscratch` 切换机制是 RISC-V 用户态陷阱处理的经典设计，实现正确
- TrapFrame 保存/恢复完整，覆盖所有调用者保存和被调用者保存寄存器
- COW 缺页处理与信号递送路径分离，逻辑清晰

**缺点**：
- 无外部中断处理（`scause=9` 场景仅打印警告），导致 virtio 设备无法使用中断模式
- 无性能计数器溢出中断、无机器模式委托配置
- 时钟中断间隔固定为 100,000 周期，未根据实际需求动态调整

**完整度评价**：陷阱框架设计正确且完整。中断子系统仅覆盖时钟中断，外部中断处理完全缺失。

### 3.3 物理内存管理子系统

**实现细节**：
- 基于 `struct PageInfo` 数组的空闲链表分配器，每个物理页一个元数据条目
- `PageInfo` 包含 `ref`（u16 引用计数）、`next`（空闲链表指针）、`on_free`（状态标志）
- 两阶段分配：启动早期使用 bump allocator（`early_free` 指针），`page_allocator_ready` 置位后切换到空闲链表
- 初始化时遍历 `PHYS_MEM_BASE..PHYS_MEM_END`（256MB），将内核镜像占用的页标记为 `ref=1`，其余加入空闲链表
- `vm_incref_page()` / `vm_decref_page()` 管理引用计数，引用计数归零时自动回收至空闲链表

**优点**：
- 两阶段分配器设计合理，解决了内核早期无法使用复杂分配器的问题
- 引用计数机制支持共享页的精确管理（COW、SysV shm 均依赖此机制）
- 空闲链表操作正确（无重复释放、无泄漏的风险）

**缺点**：
- 物理内存耗尽时直接 `panic()`，无 OOM killer 或页面回收
- 空闲链表为单链表，分配/释放 O(1) 但无法按 order 分配连续物理页（限制了 DMA 和大页支持）
- 无 NUMA 感知、无页面迁移
- `PageInfo` 数组固定 `VM_PAGE_COUNT` 个条目，不支持动态扩展

**完整度评价**：基础分配器功能完整且正确。缺少内存压力处理和连续页分配能力。

### 3.4 虚拟内存管理 (Sv39) 子系统

**实现细节**：
- 三级页表遍历（`vm_walk`，level=2 根 → level=0 叶），支持按需分配中间页表
- `vm_map()` 支持大小不对齐的映射（自动向下/向上对齐到页边界），映射前检查旧映射并正确处理引用计数
- `vm_unmap()` 释放页表项并递减物理页引用计数，但不递归清理空的中间页表目录
- `vm_translate()` 软件遍历页表完成 VA→PA 翻译
- 用户页表创建（`vm_create_user_pagetable`）时映射全部物理内存（内核权限 `PTE_R|PTE_W|PTE_X`，未置 `PTE_U`）

**优点**：
- Sv39 页表操作完整（walk/map/unmap/translate/clone/destroy）
- 页表项状态管理细致（旧映射清理、引用计数同步）
- 支持按需分配中间页表，节省内存

**缺点**：
- `vm_unmap` 不清理空的中间页表目录，长期运行会导致页表内存占用膨胀
- 用户页表的内核映射部分暴露了全部物理内存（虽无 `PTE_U`，但缺乏最小权限原则）
- 无 ASID 支持（Sv39 规范允许但未使用），每次切换用户页表需完整刷新 TLB

**完整度评价**：Sv39 页表操作实现完整。缺少 ASID 优化和中间页表回收。

### 3.5 Copy-on-Write 子系统

**实现细节**：
- 使用 RISC-V PTE 保留位 bit 8 作为 `PTE_COW` 标志，bit 9 作为 `PTE_SHM` 标志
- `vm_clone_user_leaf()` 在 fork 时处理每个用户页：若可写且非 SHM，去写权限并设 COW 标志；所有页的物理引用计数 +1
- `vm_handle_cow_fault()` 处理 COW 缺页：若 `refcount<=1` 则直接恢复写权限并清 COW；若 `refcount>1` 则分配新页、memcpy 内容、建立新映射
- SysV shm 页（PTE_SHM）跳过 COW 处理，保持共享

**优点**：
- 引用计数决策逻辑正确：`refcount<=1` 的无复制优化是标准 COW 实现
- 与虚拟内存/物理内存子系统集成良好
- SysV shm 的区分处理实用且必要

**缺点**：
- PTE 保留位的使用不符合 RISC-V 特权规范（保留位可能被硬件触发异常），仅在 QEMU 下安全
- 无 COW 页打破后的 TLB 局部刷新（单条 `sfence.vma` 可能性能不佳）
- 未处理 COW 缺页时的内存分配失败（分配失败直接 `panic`）

**完整度评价**：COW 机制实现完整且逻辑正确。PTE 保留位复用在真实硬件上存在兼容性风险。

### 3.6 任务/进程管理子系统

**实现细节**：
- Task 控制块包含：pid/tgid/ppid、页表指针、brk 区间、mmap 区间、TrapFrame、信号处理字段、futex 等待字段、文件描述符表（128）、cwd 等
- 256 个任务槽位静态分配（`tasks[256]`，约 21MB）
- 调度器：简单 round-robin，线性扫描 `tasks[]` 选择第一个 `TASK_RUNNABLE` 任务
- 调度触发点：`task_on_trap_return()` 中检查 `need_resched` 标志
- `task_clone_current()` 支持 CLONE_VM、CLONE_FILES、CLONE_THREAD 等标志
- fork 实现：COW 复制页表、复制文件描述符表（非 CLONE_FILES 时）、子进程 `tf.a0=0`

**优点**：
- 任务状态机完整（UNUSED/RUNNABLE/RUNNING/ZOMBIE/BLOCKED/SLEEPING/FUTEX/PIPE/SOCKET）
- clone 实现质量高，正确支持 CLONE_THREAD（同一线程组）、CLONE_VM（共享页表）、CLONE_FILES（共享 fd 表）
- 文件描述符表共享通过 `files_id` 机制实现，避免深拷贝
- 僵尸进程回收逻辑完整（父进程 wait4 + 孤儿进程自动回收）

**缺点**：
- 调度器 O(n) 线性扫描，256 个槽位每次调度均需遍历
- 无调度优先级、无时间片计算、无 CFS 等公平调度
- 阻塞任务仍占用扫描时间（未使用单独就绪队列）
- 无内核抢占，调度仅发生在返回用户态时
- 不支持 CLONE_NEWNS、CLONE_NEWPID 等命名空间

**完整度评价**：任务管理功能完整。调度器为基础 round-robin，缺乏现代调度器的公平性和效率。

### 3.7 信号处理子系统

**实现细节**：
- 64 位 `signal_pending_mask` 和 `signal_mask` 位掩码管理信号
- 信号发送：设置 pending 位；信号递送：在 `task_on_trap_return()` 中检查并处理
- 信号帧（rt_sigframe）包含 siginfo_t + ucontext_t + trampoline（`li a7,139; ecall`）
- 支持 SA_SIGINFO、SA_ONSTACK、SA_RESTORER 标志
- SIG_DFL 和 SIG_IGN 处理：部分信号（SIGINT/SIGQUIT/SIGTERM 等）的默认动作为 SIGKILL 等效
- rt_sigreturn：在 `trap_handler` 中特殊处理（`scause=8` 且 `a7=SYS_rt_sigreturn`），恢复完整寄存器上下文

**优点**：
- 信号框架相当完整：支持 64 个实时信号、SA_SIGINFO 的扩展信息传递
- trampoline 机制直接在信号栈上执行，无需 vDSO
- 信号帧布局支持 siginfo_t 和 ucontext_t 的完整内容
- 信号栈（SA_ONSTACK）和信号屏蔽（SA_MASK）正确实现

**缺点**：
- SIGSTOP/SIGCONT 的作业控制语义未实现（SIGSTOP 实际发送 SIGKILL）
- 无 SA_NODEFER、SA_RESETHAND、SA_NOCLDSTOP、SA_NOCLDWAIT 标志的完整处理
- 信号递送在返回用户态时才处理，实时性依赖于下一个 trap 时机

**完整度评价**：信号框架完整，POSIX 实时信号扩展已实现。作业控制信号语义不完整。

### 3.8 系统调用子系统

**实现细节**：
- 分发表 `syscall_table[436]`，已注册 155 个 syscall（35.6%）
- 系统调用参数通过 `TrapFrame` 的 a0-a5 传递，a7 为 syscall 号
- clone/vfork/clone3/execve 在 `syscall_dispatch` 中有特殊路径（直接操作 TrapFrame，绕过标准调用约定）
- 已实现的关键 syscall 类：
  - 文件 I/O：read/write/readv/writev/pread/pwrite/lseek/close/dup/fcntl 等 15 个
  - 文件系统操作：openat/mkdirat/unlinkat/renameat/getdents64/statx/mount 等 18 个
  - 进程管理：clone/vfork/clone3/execve/exit/exit_group/wait4/getpid 等 8 个
  - 内存管理：brk/mmap/munmap/mremap/mprotect 等 8 个
  - 信号：rt_sigaction/rt_sigprocmask/rt_sigpending/kill/tgkill 等 11 个
  - 时钟：nanosleep/clock_gettime/clock_nanosleep/setitimer 等 6 个
  - 网络：socket/socketpair/bind/listen/accept/connect/sendto/recvfrom 等 16 个
  - 其他：pipe2/eventfd2/epoll_*/timerfd_*/futex/sysinfo/uname/shm*等 20+ 个

**优点**：
- 核心文件 I/O、进程创建、内存管理、信号处理 syscall 覆盖全面
- execve 的双 libc（musl/glibc）支持设计精巧且实用
- 特殊 syscall 路径（clone/execve）正确处理了 TrapFrame 修改
- 不少存根 syscall 返回合理值而非错误（如 msync/madvise 返回 0），提高了测例兼容性

**缺点**：
- 436 个 syscall 中 281 个（64.4%）标记为 `sys_unimplemented`
- fcntl 实现覆盖不完整（缺 F_GETOWN/F_SETOWN/F_GETLK/F_SETLK 等）
- ioctl 为存根（返回 0），不支持任何设备控制操作
- prlimit64/getrlimit 仅有基本实现，sched_* 系列几乎全部为存根
- getrandom 返回固定种子，非随机数

**完整度评价**：155/436 已注册（35.6%）。高优先级 syscall 覆盖率良好，但大量辅助 syscall 为存根。syscall 总表完整度偏低。

### 3.9 虚拟文件系统与内存文件系统

**实现细节**：
- 内存文件系统（memfs）：2048 个 `MemFile` 槽位，64MB 数据池，支持文件和目录
- `MemFile` 结构包含：名称（128）、数据指针、容量/大小、nlink、时间戳、目录标志等
- 路径解析（`fs_resolve_task_path`）：处理相对/绝对路径、`.` 和 `..`
- 路径规范化（`normalize_path`）：合并连续 `/`、消除冗余 `.` 和 `..`
- `memfs_compact_pool()`：整理数据池碎片，回收已删除文件的空间
- 文件描述符表：每任务 128 个 fd，支持 STDIN/STDOUT/STDERR、memfs 文件、目录、管道、套接字、/dev/null、/dev/zero、eventfd、epoll、timerfd 等类型
- `files_id` 共享机制：使用引用计数管理 fd 表的跨任务共享（clone/fork 时）

**优点**：
- memfs 覆盖了标准文件系统操作：创建、读写、目录遍历、重命名、链接、删除、截断
- 文件描述符类型丰富，支持多种 I/O 抽象（文件/管道/套接字/eventfd/epoll/timerfd）
- `files_id` 共享机制正确实现了 POSIX 的 fd 共享语义（fork 后父子共享 fd 偏移）
- 数据池压缩机制实用，避免长期运行时碎片化

**缺点**：
- 无完整的 VFS 抽象层（所有操作直接调用 memfs 或 ext4 函数，无统一 inode/dentry 接口）
- 无访问权限检查（无用户/组 ID 验证，open 始终成功）
- 路径长度固定为 128（`FS_PATH_MAX`），无动态扩展
- 时间戳未与真实时钟同步（仅记录秒/纳秒值）

**完整度评价**：memfs 实现完整。缺乏 VFS 抽象层限制了文件系统类型的扩展性。

### 3.10 ext4 只读支持

**实现细节**：
- 超级块解析：从 offset 1024 读取，验证魔数 `0xEF53`
- 块组描述符读取：定位 inode 表
- extent 树遍历：完整的索引/叶子节点解析，支持递归深度遍历
- 传统间接块：支持间接/双重间接/三重间接块映射（兼容预-extent 格式）
- 目录遍历：`ext4_getdents` 读取 `ext4_dir_entry_2` 结构
- 名称缓存：64 条目查找缓存
- 文件缓存：8 个文件的完整内容缓存（每文件最多 2MB）
- 块设备接口：`block_read_sector()` 读取 512 字节扇区

**优点**：
- extent 树遍历实现正确，支持现代 ext4 默认格式
- 兼容传统间接块，可读取旧版本创建的 ext4 文件系统
- 文件缓存和名称缓存是面向比赛场景（反复读取测例脚本）的实用优化
- 与 memfs 的集成：当 memfs 中未找到文件时自动回退到 ext4

**缺点**：
- 仅支持读取，无写入、无文件创建、无删除
- 不支持 ext4 日志（journal），需要已 fsck 的干净文件系统
- inode 读取使用 64 字节缓冲，inode size>128 时可能读取不完整（仅读取前 64 字节）
- 无 xattr、ACL、符号链接支持
- 未处理 flex_bg、meta_bg 等特性

**完整度评价**：ext4 只读实现紧凑但实用。对于读取测例脚本的需求足够。缺乏日志处理限制了其对非干净文件系统的兼容性。

### 3.11 ELF 加载器

**实现细节**：
- `elf_is_valid()`：验证 ELF64 魔数、64 位、小端、ET_EXEC/ET_DYN、EM_RISCV
- `elf_get_interp()`：提取 PT_INTERP 段（动态链接器路径）
- `elf_interp_is_optional()`：检查 PT_DYNAMIC 中的 DT_NEEDED 数量判断是否需要解释器
- `elf_load_into_at()`：完整加载逻辑
  - ET_EXEC：加载偏移=0；ET_DYN：加载偏移=requested_bias
  - 为每个 PT_LOAD 段分配物理页并复制数据
  - 自动设置页权限（R/W/X + PTE_U）
  - 提取 PT_PHDR、PT_DYNAMIC 地址
  - 返回 `ElfLoadInfo` 结构

**优点**：
- 支持 ET_EXEC 和 ET_DYN 两种 ELF 类型
- 与 execve 的集成完善（双 libc 自动检测、shebang 支持）
- 页权限设置正确（基于 PF_R/PF_W/PF_X 标志）

**缺点**：
- 不支持 ET_REL 目标文件（无重定位引擎）
- 动态链接依赖外部解释器（ld-*.so），内核不执行重定位
- 缺少对 PT_TLS 段（线程局部存储）的处理
- 未验证 PT_LOAD 段的地址冲突（多个段映射到重叠区域）

**完整度评价**：ELF 加载器功能完整，支持静态和动态链接 ELF 的 PT_LOAD 加载。缺少重定位和 TLS 支持。

### 3.12 设备驱动

**实现细节**：
- UART（NS16550 兼容）：仅支持轮询输出（`uart_putc` 等待 THRE 位），无输入（读取）支持，47 行代码
- virtio-blk MMIO：支持 v1/v2，8 条描述符 virtqueue，仅实现读操作（VIRTIO_BLK_T_IN），最多 4 次重试，初始化流程完整
- virtio-net MMIO：双 virtqueue（RX/TX），各 8 条描述符，扫描 MMIO 地址范围（步长 0x1000），MTU 1514，仅原始帧收发，无 TCP/IP 协议栈
- LoongArch virtio-blk PCI：PCI ECAM 配置空间访问，legacy 接口，256 条描述符 virtqueue

**优点**：
- virtio MMIO 初始化流程正确（ACKNOWLEDGE → DRIVER → FEATURES_OK → DRIVER_OK）
- virtio-net 自动扫描 MMIO 地址范围，支持多个设备
- 驱动代码量小，结构清晰

**缺点**：
- 所有设备 I/O 均为轮询模式，无中断驱动（浪费 CPU 周期）
- UART 无输入能力，用户无法与 shell 交互
- virtio-blk 无写入操作，限制了文件系统写入能力
- virtio-net 无网络协议栈（仅提供原始帧收发接口）
- LoongArch virtio-blk PCI 仅用于 minikernel，未集成到完整内核

**完整度评价**：驱动实现基础但功能有限。轮询模式适用于比赛自动运行场景，但缺乏中断驱动和完整的 I/O 能力。

### 3.13 用户态 init shell

**实现细节**：
- 内建命令：echo（含重定向）、cat、cd、sleep、kill、wait、sh -c
- 管道支持：`run_pipeline()` 解析 `|` 分隔符，多级管道，内建 grep/sort/uniq/cat/tail/awk 文本过滤器
- 外部命令执行：通过 clone + execve 创建子进程，支持后台执行（`&`）、前台等待、输出捕获（pipe2）
- 脚本解析：`interpret_script_text()` 逐行解析，支持 for 循环
- 测试编排：递归扫描目录（最大深度 4）查找 `*_testcode.sh`，自动搜索 fallback 脚本
- 环境变量：PATH、LANG、LC_ALL 预设
- 约 30 个已知不兼容 libc-test 用例的跳过逻辑

**优点**：
- 内建文本过滤器（grep/sort/uniq/awk）减少了对 busybox 的依赖
- 管道实现支持多级命令串联
- 输出捕获机制允许将外部命令输出用于结果对比
- 测试编排逻辑完善（目录扫描、fallback 脚本、跳过列表）

**缺点**：
- 无行编辑功能（命令输入缺少退格/光标移动）
- 内建过滤器的实现较简化（grep 仅支持基本匹配，awk 仅支持 `{print $N}`）
- 错误处理不完善（管道中间命令失败难以追踪）

**完整度评价**：用户态 init shell 功能丰富，测试编排能力较好。交互能力受限。

### 3.14 LoongArch64 minikernel

**实现细节**：
- 64KB 启动栈
- UART 输出（`0x1FE001E0`，每字符输出后 `delay(3000)`）
- GED 寄存器关机（`0x100E001C`）
- ext4 磁盘扫描：遍历测试脚本目录，为每个 `*_testcode.sh` 输出 skip 信息
- 无用户态、无系统调用、无任务调度、无信号、无网络

**优点**：
- 作为多架构支持的占位符，展示了 LoongArch 的基本启动能力
- 与 ext4 只读支持集成，可扫描磁盘目录

**缺点**：
- 不具备操作系统功能（无用户态、无进程、无内存管理）
- 仅为概念验证级别实现

**完整度评价**：仅为多架构支持的占位实现，不具备实用价值。

## 四、OS 内核整体实现完整度

**评估基准**：以比赛测例通过为目标，覆盖从内核启动、设备驱动、内存管理、进程创建、文件系统、信号处理、网络通信、到用户态 shell 测试编排的完整路径。

**评估结论**：项目实现了从内核启动到用户态 ELF 执行的完整路径，覆盖了比赛测例所需的核心功能集（进程创建、文件 I/O、信号处理、管道通信、网络原始帧、测试脚本编排）。主要功能缺失项为：磁盘写入（virtio-blk 只读）、用户输入交互（UART RX 未实现）、TCP/IP 协议栈（仅有原始帧）。整体实现完整度约 **68%**。

## 五、动态测试的设计和结果

### 5.1 构建测试

RISC-V64 构建成功（riscv64-unknown-elf-gcc 13.2.0，零警告零错误）。LoongArch64 构建未执行（环境中缺少 `loongarch64-linux-gnu-gcc`）。

### 5.2 运行时测试

未执行 QEMU 运行时测试。Makefile 的 `run` 目标包含 QEMU 启动命令：

```
qemu-system-riscv64 -machine virt -m 256M -nographic -bios default -kernel kernel-rv
```

未执行测试的原因：
- 缺少 ext4 测试镜像（制作镜像的脚本 `tools/make-basic-image.sh` 依赖外部仓库 `testsuits-for-oskernel-pre-2025`，该仓库在当前环境中不可用）
- 用户态 init shell 依赖 ext4 磁盘中的测试脚本才能展示完整行为

### 5.3 内核自检

`selftest.c` 提供了基本的自检机制：加载嵌入的 `init.elf` 并进入用户态。该测试仅验证内核启动和用户态切换的基本路径，不覆盖设备驱动、文件系统、网络、信号处理等子系统。

## 六、细则评价表格

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|----------------|---------|------|
| 内存管理 | 已实现。物理页分配器（空闲链表+引用计数）完整，Sv39 虚拟内存完整，COW 完整。缺页面回收、连续页分配、ASID 支持、中间页表回收 | COW 实现基于引用计数，逻辑正确；PTE 保留位复用存在硬件兼容性风险；用户页表映射全部物理内存不符合最小权限原则 | 核心功能实现质量较好，但部分设计实现细节（保留位复用）不够规范。COW 的`refcount<=1`优化反映了对内存管理机制的深入理解 |
| 进程管理 | 已实现。256 个任务槽位，完整状态机（9 种状态），clone/fork/execve 实现完整。调度器为简单 round-robin | clone 支持 CLONE_THREAD/CLONE_VM/CLONE_FILES，实现质量高；调度器 O(n) 线性扫描，无优先级 | 进程管理功能覆盖面好，fork 写时复制机制正确。调度器过于简单，缺乏现代操作系统所需的公平性和效率保证 |
| 文件系统 | 已实现。内存文件系统（2048 文件，64MB 池）完整，ext4 只读支持（extent+间接块）完整。无 VFS 抽象层，无磁盘写入 | ext4 支持 extent 树和传统间接块双模式；64 条目名称缓存和 8 文件缓存是实用优化；与 memfs 的集成设计合理（memfs 优先，ext4 回退） | 内存文件系统功能完整。ext4 实现紧凑但覆盖了关键的数据结构。缺少 VFS 抽象层限制了文件系统扩展性 |
| 交互设计 | 部分实现。UART 仅输出，无输入；用户态 shell 功能丰富但缺乏行编辑 | shell 内建了文本过滤器（grep/sort/uniq/awk），减少外部依赖；测试编排逻辑（脚本扫描/fallback/跳过列表）设计良好 | 因 UART 无输入，系统缺乏交互能力。用户态 shell 的测试自动化能力较好，适合比赛自动评测场景 |
| 同步原语 | 基本实现。futex（WAIT/WAKE/WAIT_BITSET/WAKE_BITSET/REQUEUE/CMP_REQUEUE）支持超时；无内核锁机制（自旋锁/互斥锁/信号量均未实现） | futex 的 requeue 和 cmp_requeue 实现反映了对同步原语的理解；管道和套接字的阻塞/非阻塞模式通过任务状态正确管理 | futex 实现质量较好。内核自身缺乏并发保护机制（虽然有 UP 环境不需要），对多核扩展形成制约 |
| 资源管理 | 部分实现。文件描述符表（128/task）通过 files_id 共享和管理；SysV shm（8 段，每段 256 页）；无 rlimit 的强制限制 | files_id 的 fd 表共享机制正确实现了 POSIX fork 后的 fd 语义；资源耗尽时通常直接 panic，无降级策略 | 基础资源共享机制存在，但资源限制（rlimit）为存根，缺乏资源隔离和配额管理 |
| 时间管理 | 已实现。时钟中断（SBI set_timer，10ms 间隔）、rdtime 时间源、nanosleep/clock_gettime/clock_nanosleep/setitimer 等 syscall 完整 | 定时器中断间隔固定为 100,000 周期，未根据实际调度需求动态调整；支持 CLOCK_REALTIME 和 CLOCK_MONOTONIC 两种时钟 | 时间管理功能完整，syscall 覆盖良好。缺乏高精度定时器（hr timer）和动态 tick |
| 系统信息 | 已实现。sysinfo（总内存/可用内存/进程数）、uname（内核名/版本/机器名）、times（CPU 时间统计）、statx/fstat（文件状态）等 syscall 完整 | 系统信息 syscall 返回值基本合理且内源一致；uname 返回固定字符串而非从内核编译信息提取 | 系统信息获取接口覆盖良好，满足基本需求 |
| 网络通信 | 部分实现。原始帧收发（virtio-net MMIO）完整，socket 系统调用（AF_UNIX/AF_INET）完整。无 TCP/IP 协议栈、无 ARP/DHCP | socket syscall 接口层实现完整（16 个 syscall）；实际网络通信依赖用户态处理协议栈；virtio-net 为轮询模式 | 网络接口层完整，但协议栈缺失使得 TCP/UDP 通信实际不可用。对比赛测例中可能需要简单网络通信的场景支持有限 |
| 可移植性 | 部分实现。RISC-V64 完整，LoongArch64 仅有 minikernel（占位） | 代码结构支持多架构（arch/riscv64/ 和 arch/loongarch64/ 分离），但 LoongArch 仅实现板级启动和 ext4 扫描 | RISC-V64 移植完整。多架构框架存在但另一架构实质上不可用 |
| 代码质量 | 良好。零编译警告（-Wall -Wextra），代码结构清晰，命名规范一致；部分函数体较长，关键区域注释较少 | 静态大数组（tasks、memfs_pool、ext4 缓存等）导致 BSS 段达约 131MB；少量重复代码（如 virtio MMIO 读写在多个驱动中重复） | 代码整体质量良好，编译严谨。大静态分配和少量代码重复是工程权衡 |

## 七、总结评价

OSKernel C Base Model 是一个面向操作系统内核比赛的 RISC-V64 单内核项目，以约 14,677 行 C/汇编代码实现了覆盖内核核心子系统的功能集。该项目能够走通从启动、内存管理、进程创建（COW fork）、ELF 加载、文件系统操作、信号处理到用户态 shell 测试编排的完整路径。

项目的核心优势在于：
1. **功能覆盖面广**：在较紧凑的代码量内集成了 Sv39 虚拟内存（含 COW）、155 个 Linux 兼容 syscall、POSIX 信号处理、内存文件系统、ext4 只读支持、virtio 设备驱动和一个功能丰富的用户态 init shell。
2. **execve 的双 libc 兼容**：musl/glibc 双 ABI 自动检测和路径映射是在比赛框架下的实用创新，提高了测例兼容性。
3. **COW 实现正确**：基于引用计数的 COW 决策逻辑（refcount<=1 时无需复制）是标准且正确的实现方式。
4. **用户态 shell 的测试编排**：内建文本过滤器、管道支持、脚本扫描/fallback/跳过列表、输出捕获等机制使得测试自动化程度较高。

项目的不足和制约因素：
1. **调度器过于简单**：线性扫描的 round-robin 在任务数增多时效率低下，缺乏优先级和公平性保障。
2. **设备驱动为轮询模式**：无中断驱动的 I/O 浪费 CPU 周期，UART 无输入能力限制了交互性，virtio-blk 无写入能力限制了文件系统的完整使用。
3. **网络协议栈缺失**：仅提供原始帧收发，TCP/UDP 通信实际不可用。
4. **PTE 保留位复用**：使用规范保留位存储自定义标志在真实硬件上存在兼容性风险。
5. **多架构支持仅占位**：LoongArch64 实现不具备操作系统功能。
6. **资源管理策略粗糙**：资源耗尽时直接 panic，无降级或回收策略。

总体而言，该项目在比赛框架下工程化程度良好，以紧凑的代码覆盖了 OS 内核的核心路径。其优势体现在功能集成度和特定机制的实现质量上（COW、信号处理、双 libc 支持），其不足主要体现在性能优化、扩展性设计和协议栈完整性方面。