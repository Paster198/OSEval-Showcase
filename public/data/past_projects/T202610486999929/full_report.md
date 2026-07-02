# Remilia OS 内核项目 —— 详细技术分析报告

## 一、项目概览与分析范围

### 1.1 分析范围

本报告对 Remilia OS 内核仓库进行了全面的源代码级调查，涵盖了以下方面：
- 全部 152 个 Rust 源文件的阅读与分析（内核 crate `scarlet`）
- 29 个 ext4 文件系统库源文件的分析（`ext4_rs_fixed`）
- `devil` DTB 解析库、`scarlet-test-macros` 过程宏库和 `sakuya` 测试运行器的分析
- 构建系统（`build.rs`、`Makefile`、`justfile`、`Cargo.toml`）
- 开发设计文档（`development-design.txt`）
- 源代码总计约 **54,642 行** Rust 代码（内核 46,254 + ext4仓库 8,388），不含 vendor 依赖

### 1.2 项目结构

Remilia 是一个四 crate 工作区：

| Crate | 类型 | 行数 | 职责 |
|-------|------|------|------|
| **scarlet** | 内核 binary | ~46,254 | OS 内核本体，`#![no_std]` + `#![no_main]` |
| **devil** | 库 | ~400 | 无分配 DTB (Flattened Device Tree) 解析器 |
| **sakuya** | host binary | ~500 | 端到端测试运行器 |
| **scarlet-test-macros** | proc-macro | ~80 | `#[scarlet_test]` 内核内测试属性宏 |

### 1.3 目标架构

- **RISC-V 64**（`riscv64gc-unknown-none-elf`）：Sv39 MMU，OpenSBI，VirtIO MMIO
- **LoongArch 64**（`loongarch64-unknown-none`）：LA64 MMU，VirtIO PCI

---

## 二、测试结果

### 2.1 测试概况

由于当前沙箱环境中缺少 RISC-V 和 LoongArch 目标平台的 Rust nightly 工具链组件，无法直接编译和运行该内核。但通过源代码分析可以确认：

1. **内核内测试框架**：内核内置于 `#[scarlet_test]` 属性宏，将测试函数注册到 `.scarlet_tests` 段。测试覆盖了：
   - `sched/tests.rs`（1,318行）：调度器全面测试（公平调度、RT调度、优先级继承、futex）
   - `sync/mod.rs`：自旋锁排序测试、try_lock 测试
   - `mm/slab.rs`：Slab 分配器测试
   - `fs/pipe.rs`：管道语义测试
   - `fs/procfs/tests.rs`：procfs 测试
   - `fs/ext4_adaptor.rs`：ext4 适配器测试
   - `irq/mod.rs`：IRQ 子系统测试
   - `process/process_table.rs`：进程表测试
   - `process/thread_table.rs`：线程表测试

2. **端到端测试**：`sakuya` 测试运行器通过编译 C 测试程序、构建 initramfs 并在 QEMU 中运行来验证内核。

3. **官方比赛测例**：通过 OS 比赛官方测试套件（`testsuits-for-oskernel`）进行验证。

---

## 三、子系统与功能清单

### 3.1 已实现子系统汇总

| 子系统 | 路径 | 代码行数 | 完整度评估 |
|--------|------|----------|-----------|
| **系统调用层** | `syscall/` | ~12,606 | 高（80+ 个 Linux 兼容 syscall 真实实现） |
| **架构层** | `arch/` | ~8,807 | 高（双架构完整实现） |
| **调度器** | `sched/` | ~5,771 | 高（CFS-like 公平调度 + RT + Idle + futex + PI） |
| **文件系统** | `fs/` | ~4,632 | 高（VFS + ramfs + devfs + procfs + pipe + ext4） |
| **内存管理** | `mm/` | ~4,591 | 高（buddy + slab + 页表 + COW + mmap） |
| **进程管理** | `process/` | ~1,856 | 中高（进程/线程管理 + 资源容器） |
| **网络栈** | `net/` | ~1,375 | 中（以太网 + ARP + IPv4 + UDP + 基础 TCP） |
| **时钟子系统** | `tokei/` | ~790 | 高（三层设计：clocksource/clockevent/timekeeper） |
| **ELF 加载器** | `loader/` | ~614 | 高（静态 ELF/PIE + TLS + 重定位） |
| **SMP** | `smp/` | ~541 | 中（多核拓扑 + 启动 + IPI 框架） |
| **IRQ 子系统** | `irq/` | ~478 | 中高（Linux 风格 IRQ domain + 描述符表） |
| **同步原语** | `sync/` | ~450 | 中（ticket 锁 + IRQ 安全变体 + TLB shootdown） |
| **信号** | `signal/` | ~152 | 中（POSIX 信号 1-31 + sigframe + sigreturn） |
| **陷阱处理** | `trap/` | ~60 | （大部分在 arch 中） |

---

## 四、各子系统详细实现拆解

### 4.1 启动流程

#### 4.1.1 汇编入口（entry.rs）

RISC-V 入口使用 LR/SC 原子指令实现多核竞态自举：

```rust
// 来自 crates/scarlet/src/arch/riscv64/entry.rs
// LR/SC 原子声明自举hart：BOOT_HART_ID_STATIC 初始为 u64::MAX，
// 第一个成功 SC 的 hart 成为自举hart
1:  lr.d t4, (t0)
    bne  t4, t5, 2f           // 已被声明 → 走辅hart路径
    sc.d t6, t1, (t0)         // 尝试声明：写入我的hart_id
    bnez t6, 1b               // SC失败，重试
```

辅hart在 `BOOT_READY_FLAG` 上自旋等待，直至自举hart完成初始化并通过 `publish_boot_ready()` 释放。每hart使用独立启动栈（`BOOT_STACKS[hart_id]`，每栈128KB）。

LoongArch 入口则依赖于固件邮箱机制，辅hart的启动需要固件支持（当前为桩实现）。

#### 4.1.2 main() 函数（main.rs）

内核主入口 `main(a0, a1, a2)` 的启动顺序：

1. `util::clear_bss()` — 清零 `.bss` 段
2. `arch::shared::hart::bootstrap_hart_local()` — 初始化 hart-local 指针（`tp` 寄存器）
3. `arch::interrupts_disable()` — 关闭中断
4. `log::init()` + `log::add_channel()` — 初始化日志
5. `boot::init_boot_info(a0, a1)` — 解析启动信息（DTB/ACPI/fw_cfg 多路径）
6. `mm::init(boot_info)` — 初始化物理帧分配器
7. `mm::heap_init()` — 初始化内核堆（buddy + slab）
8. `mm::init_kernel_space(boot_info)` — 建立内核地址空间
9. VirtIO 块设备探测 → ext4 根文件系统挂载（失败则回退到 ramfs）
10. devfs 挂载、`/dev` 设备注册、procfs 初始化
11. 网络栈初始化（virtio-net 探测、协议栈各层）
12. SMP 初始化、trap 初始化、平台中断控制器初始化、时钟初始化
13. 调度器初始化、空闲线程创建
14. 竞赛 runner 检测（扫描 `*_testcode.sh`）或默认 init 启动

#### 4.1.3 BootInfo 多路径解析

启动信息支持三种路径的自动检测与回退：

```
DTB (RISC-V) → ACPI RSDP 搜索 → fw_cfg 加载（QEMU direct boot）
```

关键代码 `unsafe fn init_boot_info(hart_id, dtb_ptr)` 在 `boot.rs` 中实现：
- 首先通过 `is_valid_dtb()` 验证 `dtb_ptr` 是否为有效 DTB，是则解析内存区域和 initrd
- 若无可用内存区域，回退到 `arch::acpi::search_rsdp()` 搜索 ACPI RSDP
- 再回退到 `fwcfg::load_tables()` 从 QEMU fw_cfg 设备加载 ACPI 表
- 解析 SRAT 表获取内存拓扑

### 4.2 内存管理（mm/）

#### 4.2.1 帧分配器（frame.rs）

基于 bitmap 的物理帧分配器，设计在无分配器环境下运行：

```rust
// 关键结构
struct FrameAllocator {
    bitmap: [u8; BITMAP_SIZE],          // 最多跟踪 16M 帧（64GB）
    regions: [Region; MAX_REGIONS],      // 最多 16 个区域
    reserved_ranges: [(u64, u64); MAX_RESERVED],  // 保留范围
    total_frames: usize,
    free_frames: usize,
}
```

特点：
- 支持多个不连续物理内存区域（`MAX_REGIONS=16`）
- 单帧分配（`alloc()`）和连续多帧分配（`alloc_contiguous(count)`）
- 分配时自动清零帧内容（`ptr::write_bytes(pa, 0, PAGE_SIZE)`）
- 保留范围标记（内核代码、DTB、ACPI 表、initrd 等）

#### 4.2.2 Buddy 分配器（buddy.rs）

管理从帧分配器获得的内核堆区域：

| 参数 | 值 |
|------|-----|
| 最小块 | 32 字节（order 0） |
| 最大块 | 256KB（order 13） |
| 阶数 | 14（0..=13） |

```rust
pub struct BuddyAllocator {
    base: usize,
    size: usize,
    free_lists: [*mut FreeNode; ORDER_COUNT],
}
```

- 使用嵌入式空闲链表节点（`FreeNode { next: *mut FreeNode }`）
- 分配时从小阶向上分裂，释放时尝试与 buddy 合并
- 包含安全检查：`valid_free_node()` 验证地址对齐和范围，`list_contains()` 防重复释放

#### 4.2.3 Slab 分配器（slab.rs）

固定大小对象缓存，5 个大小类：

```rust
pub const SLAB_SIZES: [usize; 5] = [32, 64, 128, 256, 512];
```

- 每 slab 页包含一个 header（占用第一个对象槽）+ 剩余容量槽
- `SlabAllocator` 整合 5 个 `SlabCache`，对外提供统一接口
- 支持 `grow_from_page()` 添加新 slab 页

#### 4.2.4 页表抽象（page_table.rs）

架构无关的页表接口：
- RISC-V：Sv39 三级页表
- LoongArch：对应三级页表

```rust
pub trait PageTable {
    fn new() -> Option<Self>;
    fn from_root(root: PhysAddr) -> Self;
    fn root_addr(&self) -> PhysAddr;
    fn map(&mut self, va: VirtAddr, pa: PhysAddr, perm: MapPermission) -> Option<()>;
    fn unmap(&mut self, va: VirtAddr) -> Option<()>;
    fn translate(&self, va: VirtAddr) -> Option<PhysAddr>;
}
```

权限模型（`MapPermission`）使用 bitflags，支持 `READ | WRITE | EXECUTE | USER` 组合。

#### 4.2.5 地址空间管理（memory_set.rs）

`MemorySet` 代表一个完整的地址空间（内核或用户进程），关键实现：

```rust
pub struct MemorySet {
    page_table: PageTable,
    areas: [Option<MemoryArea>; MAX_AREAS],  // 最多 64 个 VMA
    area_count: usize,
    pub tlb_gen: AtomicU64,                    // TLB 代际，加速切换判断
}
```

重要地址布局常量：
```rust
pub const USER_STACK_TOP: VirtAddr = 0x0000_003f_ffff_f000;  // 用户栈顶
pub const USER_STACK_SIZE: usize = 0x20_000;                  // 128KB
pub const TRAP_CONTEXT_VA: VirtAddr = TRAMPOLINE_VA - PAGE_SIZE;
pub const SIGNAL_TRAMPOLINE_VA: VirtAddr = TRAP_CONTEXT_VA - PAGE_SIZE;
pub const USER_TLS_BASE: VirtAddr = USER_STACK_TOP - USER_STACK_SIZE - PAGE_SIZE;
pub const USER_MMAP_BASE: VirtAddr = 0x0000_0000_1000_0000;  // 256MB
```

特性：
- **COW（写时复制）**：`handle_cow_fault()` 在缺页处理中实现
- **VMA 合并**：`coalesce_neighbors()` 自动合并相邻同类型 VMA，避免 `MAX_AREAS` 耗尽
- **惰性映射**：`try_map_framed_area_lazy()` 支持按需分配物理页
- **内核映射继承**：用户页表拷贝内核直接映射区段的 PTE（`inherit_kernel_mappings()`）
- **TLB shootdown**：`tlb_gen` 配合跨核 shootdown 机制

#### 4.2.6 帧引用计数（frame_rc.rs）

COW 机制的配套组件，跟踪物理帧的共享计数。当引用计数 > 1 时触发 COW 复制。

### 4.3 进程与线程管理（process/）

#### 4.3.1 设计哲学

**进程 = 资源容器**，**线程 = 可调度执行上下文**：

```rust
pub struct Process {
    pub pid: Pid,
    pub mm: Option<MemorySet>,           // 地址空间（用户进程）
    pub files: Option<Arc<FileTable>>,    // 文件描述符表
    pub threads: Vec<Arc<SpinMutex<Thread>>>,
    pub signal_actions: [SigAction; 32], // 信号处理器（进程级）
    pub cwd: String,                      // 当前工作目录
    pub brk: u64, pub brk_base: u64,     // 程序断点
    pub mmap_cursor: u64,                 // mmap 分配游标
    pub zombie_children: Vec<(Pid, ExitStatus)>, // 僵尸子进程
    pub child_waiters: Vec<Tid>,          // 等待子进程的线程
    pub uid, euid, gid, egid, umask, ...  // POSIX 凭证
    // ... 共 23 个字段
}

pub struct Thread {
    pub tid: Tid,
    pub state: ThreadState,               // Ready/Running/Blocked/Exited/Zombie
    pub policy: SchedPolicy,              // 调度策略
    pub trap_context_ppn: usize,          // 陷阱上下文页物理地址
    pub task_context: ThreadContext,      // 任务上下文（供 __switch 使用）
    pub signal: SignalState,              // 线程级信号状态
    // ...
}
```

#### 4.3.2 状态机

```
Ready ──→ Running ──→ Blocked (等待事件)
  ↑         │              │
  │         │              ↓
  │         └──→ Zombie ←── Exited
  └───────────── (wake_up)
```

- `running_tid`（原子变量）确保每个进程最多一个线程在运行
- `wake_pending` 处理 Running 状态下收到唤醒信号的情况

#### 4.3.3 进程表与线程表

两者均为分桶哈希表实现（`ProcessTable`: 64 桶，`ThreadTable`: 256 桶）：

```rust
pub struct ProcessTable {
    buckets: [IrqSafeSpinlock<Bucket<Arc<SpinMutex<Process>>>>; 64],
}
```

- 使用原始指针链表（`ListNode<T>`）存储条目，避免 `Vec` 重分配
- `for_each()` 先快照再回调，防止死锁
- `with()` / `with_mut()` 方便的单条目操作

### 4.4 调度器（sched/）

#### 4.4.1 整体架构

```rust
struct HartLocalState {
    rt: RtSchedClass,       // RT 调度类（FIFO + RoundRobin）
    fair: FairSchedClass,   // CFS-like 公平调度类
    idle: IdleSchedClass,   // Idle 调度类
    current_tid: Option<usize>,
    need_resched: bool,
    // 缓存字段（trap 快速路径使用）
    current_is_user: bool,
    current_user_token: usize,
    current_trap_cx_ppn: usize,
    current_policy: SchedPolicy,
    balance_ticks: usize,   // 负载均衡 tick 计数器
}
```

调度类链：**RT → Fair → Idle**（优先级递减）

#### 4.4.2 公平调度类（fair.rs）

- 8 个优先级级别（0 最高）
- 每优先级一个 FIFO 队列
- 加权服务轮次：优先级 P 每轮获得 `(8-P)` 次调度机会
- 时间片 = `(priority + 1) * BASE_SLICE` tick（BASE_SLICE = 1，即 10ms）
- 使用开放寻址哈希表存储任务条目，支持高效查找与删除后 compact

```rust
const NUM_PRIORITIES: usize = 8;
const BASE_SLICE: usize = 1;            // 10ms at 100Hz
const MAX_TRACKED_FAIR_TASKS: usize = 4096;  // 非测试模式
```

#### 4.4.3 上下文切换（__switch）

RISC-V 汇编实现的上下文切换保存/恢复：
- 保存 callee-saved 寄存器：`sp, ra, s0-s11`
- 按需保存/恢复浮点寄存器（检查 `sstatus.FS` 位，避免不必要开销）
- 保存/恢复 `fcsr`

#### 4.4.4 Futex 支持

- `sys_futex`、`sys_futex_wait`、`sys_futex_wake`、`sys_futex_waitv`、`sys_futex_requeue`
- 优先级继承（`pi.rs`）：跟踪 futex 持有者与等待者的优先级关系
- Robust list（`robust.rs`）：处理持有 futex 的线程异常退出

#### 4.4.5 抢占与 tick

`HartLocalState::tick()` 在每次时钟中断调用：
- Fair 策略：调用 `fair.tick(current)` 检查时间片耗尽
- FIFO：不抢占
- RoundRobin：有其他就绪任务时抢占
- Idle：有任何非 idle 任务时抢占

### 4.5 虚拟文件系统（fs/）

#### 4.5.1 VFS 抽象层

```rust
pub trait Vnode: Send + Sync {
    fn metadata(&self) -> Result<Metadata>;
    fn is_seekable(&self) -> bool { true }
    fn lookup(&self, _name: &str) -> Result<NodeRef>;
    fn create_file(&self, _name: &str) -> Result<NodeRef>;
    fn mkdir(&self, _name: &str) -> Result<NodeRef>;
    fn readdir(&self) -> Result<Vec<DirEntry>>;
    fn unlink(&self, _name: &str) -> Result<()>;
    fn read_at(&self, _offset: usize, _buf: &mut [u8]) -> Result<usize>;
    fn write_at(&self, _offset: usize, _data: &[u8]) -> Result<usize>;
    fn truncate(&self, _len: usize) -> Result<()>;
    fn readlink(&self) -> Result<String>;
    fn poll_read_ready(&self) -> bool { true }
    fn poll_write_ready(&self) -> bool { true }
    fn link_path(&self) -> Option<&str> { None }
    fn socket_id(&self) -> Option<u64> { None }
    fn epoll_id(&self) -> Option<u64> { None }
    fn timerfd_id(&self) -> Option<u64> { None }
    // ... 更多方法
}
```

#### 4.5.2 挂载系统

```rust
pub fn register_mount(path: &str, node: NodeRef, fs_type: FsType);
pub fn find_mount(path: &str) -> Option<(NodeRef, String)>;
```

`lookup()` 在每次路径解析时检查挂载点，透明重定向到挂载的文件系统。

#### 4.5.3 Ramfs

基于内存树的文件系统实现：
- `RamNode` 包含 `RamNodeKind::{Directory{entries}, Regular{data}, Symlink{target}}`
- 目录条目为 `Vec<RamEntry>`，线性查找
- 目录读时先快照子节点再释放锁，避免锁嵌套

#### 4.5.4 Devfs

设备文件系统，注册字符设备和块设备节点：
- `/dev/console`、`/dev/null`、`/dev/zero`
- VirtIO 块设备（`vd{a,b,c,...}`）
- BlockDevVnode 包装 `Arc<dyn BlockDevice>`

#### 4.5.5 Pipe

```rust
pub struct PipeEnd {
    inner: Arc<Mutex<PipeBuffer>>,
    is_read_end: bool,
}
```

- 环形缓冲区（65,536 字节容量）
- `WouldBlock` 错误支持非阻塞 I/O
- `Drop` 时自动关闭对应端并唤醒等待者
- 额外的 `UnixStreamEnd`（双向管道）支持

#### 4.5.6 Procfs

提供 `/proc` 伪文件系统：
- `/proc/{pid}/maps`、`/proc/{pid}/stat`、`/proc/{pid}/status`
- `/proc/{pid}/task/{tid}/` 线程目录
- `/proc/{pid}/cmdline`
- 只读静态文件（cpuinfo、meminfo 等）
- 符号链接支持（`/proc/{pid}/fd/{n}`）

#### 4.5.7 Ext4 支持

基于 `ext4_rs_fixed`（yuoo655/ext4_rs 的 fork 修复版）实现：

```rust
pub struct Ext4Fs {
    pub(crate) ext4: Ext4,
    pub(crate) adapter: Arc<Ext4BlockAdapter>,
    pub(crate) lock: Mutex<()>,
    inode_cache: Mutex<BTreeMap<u32, CachedInodeMeta>>,
    lookup_cache: Mutex<BTreeMap<(u32, String), CachedDirEntry>>,
}
```

关键修复和适配：
- 修复非 64-bit EXT4 镜像中 `desc_size == 0` 导致的除零问题
- 适配 `BlockDevice` trait 到 ext4_rs 的 `BlockDevice` trait（`Ext4BlockAdapter`）
- 支持 64-bit、extents、flex_bg、meta_bg、filetype 等特性
- `CachedInodeMeta` 和 `CachedDirEntry` 缓存避免重复磁盘 I/O
- `readdir_raw()` 绕过通用 VFS 直接从 ext4 读取目录条目以提升性能

### 4.6 系统调用层（syscall/）

#### 4.6.1 分发表

512 项静态分发表：

```rust
static SYSCALL_TABLE: [SyscallHandler; NR_SYSCALLS] = {
    let mut table: [SyscallHandler; NR_SYSCALLS] = [sys_not_implemented; NR_SYSCALLS];
    // P0-P2 级系统调用的真实实现
    table[numbers::SYS_READ] = io::sys_read;
    table[numbers::SYS_WRITE] = io::sys_write;
    // ... 等 80+ 个真实实现
    table
};
```

#### 4.6.2 已实现的系统调用

按类别统计：

| 类别 | 已实现 | 代表性系统调用 |
|------|--------|---------------|
| **I/O** | 6 | read, write, readv, writev, pread64, pwrite64 |
| **进程** | 22+ | exit, exit_group, clone, clone3, execve, wait4, waitid, getpid, gettid, fork |
| **内存** | 5 | brk, mmap, munmap, mprotect, mremap |
| **FD/VFS** | 13 | openat, close, lseek, newfstatat, fstat, getdents64, getcwd, chdir, dup, dup3, fcntl, ioctl, readlinkat |
| **时间** | 7 | clock_gettime, gettimeofday, nanosleep, clock_nanosleep, clock_getres, getitimer, setitimer |
| **信号** | 11 | rt_sigaction, rt_sigprocmask, rt_sigreturn, kill, tkill, tgkill, sigaltstack, rt_sigpending, rt_sigsuspend, rt_sigtimedwait, signalfd4 |
| **调度** | 8+ | sched_yield, sched_getparam, sched_getscheduler, sched_setaffinity, sched_getaffinity, getcpu, set_tid_address, futex* (4个) |
| **IPC** | 1 | pipe2 |
| **网络** | 8+ | socket, bind, listen, accept, connect, sendto, recvfrom, getsockname, getpeername, setsockopt |
| **epoll** | 4+ | epoll_create1, epoll_ctl, epoll_wait, epoll_pwait |
| **poll** | 3+ | poll, ppoll, pselect6 |
| **mount** | 2 | mount, umount2 |
| **timerfd** | 3 | timerfd_create, timerfd_settime, timerfd_gettime |
| **system** | 8+ | reboot, uname, sysinfo, getrandom, getrlimit, times, getrusage, prlimit64 |
| **libc 兼容** | ~15 | personality, prctl, umask, getuid, geteuid, getgid, getegid, setuid, setgid, capget, capset, set_tid_address, set_robust_list |

#### 4.6.3 ABI 层

架构层 (`arch/{riscv64,loongarch64}/syscall.rs`) 只负责：
- 从寄存器提取系统调用号和参数 → `SyscallRequest`
- 将返回值写回寄存器
- RISC-V：`a7`=syscall number, `a0-a5`=args, `a0`=return
- LoongArch：使用对应通用寄存器

### 4.7 ELF 加载器（loader/）

#### 4.7.1 加载能力

```rust
pub fn load(mm: &mut MemorySet, elf_data: &[u8]) -> Result<LoadInfo, LoadError>;
```

支持的 ELF 特性：
- **静态 ET_EXEC**：零偏移加载
- **静态 PIE (ET_DYN)**：带 `PIE_LOAD_BIAS` 偏移加载
  - RISC-V: `0x1_0000`
  - LoongArch: `0x1200_0000_0`
- **PT_LOAD 段**：按 ELF 标志映射到 `MapPermission`
- **PT_TLS**：TLS 模板数据、对齐、大小记录
- **PT_INTERP**：解析但标记为不支持（`has_interp = true`）
- **PT_DYNAMIC**：解析 `DT_RELA`/`DT_JMPREL` 并执行 `R_RELATIVE` 和 `R_JUMP_SLOT` 重定位

#### 4.7.2 用户栈构建

`build_user_stack()` 构建完整的初始用户栈布局：

```
栈顶（高地址）
...
字符串数据区：RANDOM[16] | PLATFORM[NUL] | argv 字符串 | envp 字符串 | EXECFN[NUL]
auxv[17] × 16字节：AT_PHDR, AT_PHENT, AT_PHNUM, AT_PAGESZ, AT_ENTRY, AT_RANDOM, ...
NULL (envp 终止)
envp[n-1] ... envp[0]
NULL (argv 终止)
argv[argc-1] ... argv[0]
argc (8字节)
栈底（低地址）= SP 入口
```

18 个辅助向量：AT_PHDR, AT_PHENT, AT_PHNUM, AT_PAGESZ, AT_BASE, AT_FLAGS, AT_ENTRY, AT_UID, AT_EUID, AT_GID, AT_EGID, AT_SECURE, AT_CLKTCK, AT_RANDOM, AT_PLATFORM, AT_EXECFN, AT_HWCAP, AT_NULL。

### 4.8 时钟子系统（tokei/）

三层设计：

| 层 | 职责 | 关键代码 |
|----|------|---------|
| **Clocksource** | 全局只读硬件计数器 | `Clocksource::init(freq, read_fn)` |
| **Clockevent** | 每 hart 可编程 one-shot 定时中断 | `Clockevent::new(set_timer, enable, disable)` |
| **Timekeeper** | 单调纳秒时间，指定 hart 推进 | `timekeeper::do_timer(now)` |

特性：
- Tick 周期：10ms（100Hz），使用 one-shot 模式
- 软件定时器列表（`TimerList`）：支持 `nanosleep`、`timerfd`、`futex` 超时
- `program_next_event()` 计算下一个到期时间 = min(tick终点, 最早软件定时器)
- 基于 `token` 的定时器标识，防止 TID 重用导致的误取消

### 4.9 网络栈（net/）

#### 4.9.1 协议分层

```
应用层：Socket (socket.rs)
传输层：TCP (tcp.rs) / UDP (udp.rs)
网络层：IPv4 (ipv4.rs)
链路层：ARP (arp.rs) / Ethernet (ethernet.rs)
设备层：VirtioNet (arch/shared/virtio_net.rs)
```

#### 4.9.2 详细实现

**Ethernet**：按 `EtherType`（ARP=0x0806, IPv4=0x0800）分发。MAC 地址从 virtio-net 设备配置空间读取。

**ARP**：缓存 IP→MAC 映射，支持请求发送与响应接收，待发送队列（ARP 解析期间暂存）。

**IPv4**：
- 头校验和验证
- 回环队列（`LOOPBACK_QUEUE`）：源 IP == 目标 IP 时走回环而非网卡
- `drain_loopback()` 在每次接收后处理积压的回环包

**UDP**：
- 简单无状态实现，8 字节头 + 数据
- 端口绑定（49152-65535 临时端口范围）
- `sendto()`/`recvfrom()` 语义

**TCP**：
- 三次握手：SYN → SYN-ACK → ACK
- 四次挥手：FIN → ACK + FIN → ACK
- 序列号管理、ACK 确认
- MSS 协商（1460 字节）
- `BTreeMap<(src_port, dst_port, src_ip), Socket>` 连接表
- TCP 状态：Closed/Created/Bound/Listening/Connecting/Connected

**Socket 层**：
- `AF_INET` + `SOCK_STREAM`/`SOCK_DGRAM`
- 全局 socket 注册表、绑定表、TCP 监听表
- 支持 `SO_REUSEADDR`、`SO_KEEPALIVE`、`SO_BROADCAST`、`TCP_NODELAY`
- `SocketVnode` 实现 `Vnode` trait 以嵌入文件描述符表

### 4.10 中断子系统（irq/）

Linux 风格的 IRQ 域抽象：

```rust
pub trait IrqChip: Send + Sync {
    fn mask(&self, hwirq: u32) -> Result<(), IrqError>;
    fn unmask(&self, hwirq: u32) -> Result<(), IrqError>;
    fn claim(&self) -> Option<u32>;
    fn eoi(&self, hwirq: u32);
    fn set_affinity(&self, hwirq: u32, mask: &HartMask);
}
```

- `IrqDomain::new_linear()` 创建线性 IRQ 域
- `map_hwirq()` 建立 hwirq → linux irq 映射（填充 `IrqDesc` + 反向映射表）
- `handle_external()`：claim → reverse lookup → handler → eoi 的标准处理流程
- 支持中断亲和力设置与计数统计
- PLIC（RISC-V）和 EIOINTC（LoongArch）作为 `PARENT_CHIP` 注册

### 4.11 SMP（smp/）

```rust
pub struct SmpState {
    harts: [HartInfo; MAX_HARTS],         // 最多 8 个 hart
    online_mask: HartMask,                 // 在线 hart 位掩码
    discovered_mask: HartMask,            // 发现 hart 位掩码
}
```

- Hart 生命周期：Offline → Bringup → Online → Teardown → Offline
- 跨核函数调用槽（`CallFunctionSlot`）：`busy`、`pending`、`resched_pending` 标志
- 任务放置：轮转选择目标 hart（`choose_target_hart()`），支持亲和力匹配

### 4.12 同步原语（sync/）

```rust
pub struct RawSpinlock {
    ticket: AtomicU32,    // 取号计数器
    serving: AtomicU32,   // 当前服务号
}
```

自研 ticket-based 自旋锁：
- FIFO 公平性保证
- `spin_lock_irqsave()` / `spin_unlock_irqrestore()`：关中断+获取锁
- `IrqSafeSpinlock<T>`：自动关中断的锁包装器，`IrqSafeGuard` 在 drop 时恢复中断
- `spin_lock_noirq()`：断言中断已关闭的快速锁定（用于多锁场景）

### 4.13 信号子系统（signal/）

```rust
pub struct SignalState {
    pub pending: u32,   // 位掩码
    pub blocked: u32,   // 位掩码
}
```

- 支持信号 1-31（SIGHUP 到 SIGSYS）
- `SigAction::{Default, Ignore, Handler(addr)}` 三种处置
- `SigFrame`：保存在用户栈的信号帧，包含 magic 验证、保存的寄存器和 PC
- 信号 trampoline 页（`SIGNAL_TRAMPOLINE_VA`）：包含 `li a7, SYS_RT_SIGRETURN; ecall`
- 信号递延到返回用户态时进行（`schedule()` 中检查）

### 4.14 架构层（arch/）

#### 4.14.1 RISC-V 64

- Trap 入口：`sscratch` 交换模式的汇编陷阱入口，带哨兵字节（0xAB）重入检测
- 保存/恢复全部 32 个 GPR + sepc/scause/stval/sstatus
- 每 hart 独立陷阱页（boot hart 使用 `.bss.trap`，辅 hart 动态分配）
- PLIC 外部中断控制器驱动
- Sv39 三级页表操作
- SBI timer（通过 OpenSBI `set_timer`）

#### 4.14.2 LoongArch 64

- 对应 trap 入口（CSR_SAVE0 交换模式）
- EIOINTC 中断控制器（LoongArch 扩展 IO 中断控制器）
- LA64 三级页表
- 稳定计数器定时器（Stable Counter + TVAL）
- PCI VirtIO 设备发现（virtio-blk-pci, virtio-net-pci）

#### 4.14.3 共享层（arch/shared/）

- **VirtIO 块设备**（`virtio_blk.rs`）：Legacy MMIO 传输，16 条描述符队列
- **VirtIO 网络设备**（`virtio_net.rs`）：独立 RX/TX 队列（各 64 描述符），中断驱动接收
- **VirtIO PCI 块设备**（`virtio_blk_pci.rs`）：LoongArch PCI 路径
- **ACPI**（`acpi.rs`）：RSDP 搜索 + SRAT 内存拓扑解析
- **fw_cfg**（`fwcfg.rs`）：QEMU fw_cfg 设备支持
- **陷阱页**（`trap_page.rs`）：双故障处理、emergency stack
- **控制台**（`console.rs`）：NS16550A UART 驱动
- **Hart 本地存储**（`hart.rs`）：`tp` 寄存器 -> `HartLocal` 指针转换

### 4.15 竞赛运行器（competition.rs）

```rust
// 核心流程
1. 扫描根目录查找 *_testcode.sh
2. 按文件名排序串行执行
3. 通过 /busybox sh 运行脚本
4. 输出评测 marker: "#### OS COMP TEST GROUP {name} {libc} ####"
5. 超时检测: 600s 超时或 25,000,000 次 yield
6. 全部完成后 reboot/poweroff
```

特性：
- 环境变量设置：`PATH`、`PWD`、`SHLVL`
- 为 `/bin`、`/usr/bin`、`/sbin`、`/usr/sbin` 安装 BusyBox applet 别名
- 内置 `build_user_stack()` 与 `execve` 路径一致的用户栈构建逻辑

---

## 五、子系统间交互

### 5.1 陷阱处理路径

```
硬件陷阱 → _trap_entry (asm)
  → SAVE_CONTEXT (保存到 per-hart 陷阱页)
  → trap_dispatch (Rust)
    → scause 路由:
      - UserEnvCall → syscall::dispatch(request)
      - SupervisorTimer → tokei::handle_timer(hart_id)
      - Store/LoadPageFault → mm::handle_page_fault(frame) → COW 处理
      - SupervisorExternal → irq::handle_external(frame)
      - IllegalInstruction → trap::handle_illegal_instruction(frame)
  → 信号检查（返回到用户态时）
  → 可能触发调度（need_resched）
  → RESTORE_CONTEXT → sret
```

### 5.2 调度路径

```
tokei::handle_timer()
  → sched::tick()  // 检查是否需要抢占
  → sched::schedule()  // 如果需要
    → pick_next_local()  // RT → Fair → Idle
    → __switch(prev_cx, next_cx)
    → 返回用户态时检查信号
```

### 5.3 系统调用 → 子系统交互

以 `execve` 为例：
```
sys_execve
  → fd::resolve_path_at() → fs::lookup()
  → loader::Loader::load_from_vnode(mm, vnode)
    → fs::Vnode::read_at() (读取 ELF 头)
    → mm::MemorySet::try_map_framed() (映射 PT_LOAD 段)
  → process::Process::new_user() (创建新进程，继承文件表)
  → build_user_stack() (argv, envp, auxv)
  → sched::enqueue_thread() → schedule()
```

### 5.4 网络数据路径

```
virtio-net IRQ → irq::handle_external()
  → virtio_net::receive_handler()
    → net::receive(buf)
      → ethernet::receive() (EtherType 分发)
        → arp::receive() 或 ipv4::receive()
          → tcp::receive() / udp::receive()
            → socket.recv_queue.push()
            → wake_up(blocked_tid)
```

---

## 六、项目实现完整度评估

### 6.1 整体评估

以能够运行 BusyBox shell、libc 测例和比赛测试套件的完整 OS 内核为基准：

| 维度 | 完整度 | 说明 |
|------|--------|------|
| **启动流程** | 95% | DTB/ACPI/fw_cfg 三路径，双架构；LoongArch 辅hart启动为桩 |
| **内存管理** | 90% | Buddy+Slab+COW+mmap 齐全；缺少页面回收和交换 |
| **进程/线程** | 85% | 完整的 fork/clone/execve/wait；缺少 cgroup、namespace |
| **调度器** | 85% | Fair+RT+Idle+Futex+PI；缺少 EEVDF、完全负载均衡 |
| **文件系统** | 80% | VFS+ramfs+devfs+procfs+pipe+ext4；缺少写支持的部分 ext4 特性 |
| **系统调用** | 75% | 80+ 真实实现覆盖关键路径；约 400+ 返回 -ENOSYS |
| **网络** | 60% | 完整 UDP，基础 TCP；缺少 ICMP、TCP 拥塞控制、窗口管理 |
| **信号** | 65% | 基本发送/屏蔽/处理；缺少作业控制信号语义 |
| **设备驱动** | 70% | VirtIO blk/net/console；缺少更多设备类型 |
| **SMP** | 60% | 多核启动+调度；缺少完善的 IPI 和负载均衡 |

### 6.2 缺失的主要功能

1. **TCP 拥塞控制**：目前仅有基本的握手/挥手，缺少滑动窗口、重传、慢启动等
2. **ICMP**：静默丢弃
3. **完整 SMP**：LoongArch 辅hart启动依赖固件邮箱（未实现），跨核 TLB shootdown 基础框架存在但需完善
4. **更多文件系统**：仅有 ext4 读为主的磁盘支持，无 FAT/NTFS 等
5. **设备驱动**：缺少 USB、显示驱动等
6. **安全机制**：无用户/权限强制执行（uid/gid 字段存在但未实际检查）
7. **动态链接**：支持 `PT_INTERP` 解析但无 ld.so 加载

---

## 七、设计创新性分析

### 7.1 架构创新

1. **双架构统一内核**：通过清晰的 `arch/{riscv64,loongarch64,shared}` 三层架构，将架构差异限制在 <9,000 行代码中（占总量的约 16%），上层约 84% 代码完全架构无关。这在 Rust 内核中较为罕见。

2. **编译期 initramfs 嵌入**：`build.rs` 在编译时将预编译的 init ELF 打包为 newc CPIO 格式并嵌入内核镜像，避免了外部 initramfs 文件依赖，简化了部署。

3. **per-hart 调度器缓存**：`HartLocalState` 中的 `current_is_user`、`current_user_token`、`current_trap_cx_ppn` 缓存使 trap 快速路径无需访问全局 `THREAD_TABLE`，降低了多核竞争。

4. **三层时钟子系统**：Clocksource/Clockevent/Timekeeper 分离设计，借鉴 Linux 的 clocksource 框架但在 Rust 中重新实现，支持 one-shot 模式且易于扩展到 NO_HZ。

### 7.2 工程创新

1. **竞赛 runner 内置**：`competition.rs` 是内核内运行的测试运行器，直接扫描文件系统并串行执行 shell 脚本，输出评测 marker 后自动关机。这是面向比赛场景的特化设计。

2. **混合测试体系**：
   - 内核内单元测试（`#[scarlet_test]` + `.scarlet_tests` 段 + 测试运行器）
   - `sakuya` 端到端测试（编译 C 程序 → initramfs → QEMU → stdout 断言）
   - 官方 sdcard 测例回归

3. **LR/SC 多核自举**：RISC-V 入口使用 LR/SC 原子指令实现无锁多核自举，避免了传统方式中的自旋锁或固件依赖。

4. **哨兵字节重入检测**：陷阱入口使用 `sscratch` 交换 + 哨兵字节（0xAB）检测嵌套陷阱，比简单的关中断方案更健壮。

5. **开放寻址调度器哈希表**：公平调度器使用开放寻址（Robin Hood 风格）的紧凑数组存储任务条目，支持 `remove_entry_and_compact()` 以避免墓碑累积。

### 7.3 局限性

1. **对 ext4_rs 的依赖**：ext4 文件系统的核心逻辑（inode 读取、extent 遍历、块分配等）依赖第三方库，虽然做了适配和修复，但并非自研。

2. **网络栈完整性**：TCP 实现仅为概念验证级别，缺少生产环境所需的大部分特性。

3. **缺少形式化验证**：尽管有较完善的单元测试，但缺少对并发安全性（如锁顺序）的形式化证明。

---

## 八、其它项目信息

### 8.1 外部依赖

| 依赖 | 用途 | 许可证 |
|------|------|--------|
| `ext4_rs` (fork) | ext4 文件系统读写 | MIT |
| `riscv` | RISC-V 寄存器定义 | ISC-like |
| `loongArch64` | LoongArch 寄存器定义 | MIT |
| `spin` | `spin::Mutex`（用户态互斥锁） | MIT |
| `qemu-exit` | QEMU 退出设备 | MIT |
| `bitflags`, `log`, `lock_api`, `critical-section` | 工具库 | MIT/Apache |

### 8.2 构建系统

- `build.rs` 在编译时生成链接脚本和 initramfs
- RISC-V 内核加载地址：`0x80200000`
- LoongArch 内核加载地址：`0x00200000`
- 链接脚本包含 `.scarlet_tests` 段用于内核内测试
- 支持 `--offline` 和 vendor 目录的离线构建
- `RUSTUP_AUTO_INSTALL=0` 确保评测机无网络环境可构建

### 8.3 测试覆盖

`sakuya` 测试运行器：
- 扫描 `tests/` 目录中带 `test.toml` 清单的子目录
- 支持 C 源文件编译（通过宿主机交叉编译器）
- 自动创建 initramfs 并运行 QEMU
- 基于 stdout 内容和退出码的断言

### 8.4 开发流程

- Nix flake 提供可复现开发环境
- `justfile` 封装常用开发命令
- 内核内测试通过 QEMU test-device 退出

---

## 九、总结

Remilia OS 是一个成熟度较高的教学/竞赛型 Rust 操作系统内核。其核心优势在于：

1. **双架构统一内核设计**：RISC-V 64 和 LoongArch 64 共享约 84% 的架构无关代码，架构层抽象清晰合理。

2. **Linux 兼容层广度**：80+ 个系统调用实现覆盖了运行 BusyBox shell、libc 测例所需的绝大部分路径，包括进程管理、文件 I/O、内存映射、信号、定时器、poll/epoll、socket 等。

3. **自研核心组件**：内存管理（buddy+slab+COW）、调度器（CFS-like 公平调度+futex+PI）、时钟子系统、IRQ 子系统均为自研，展现了项目组对操作系统核心机制的理解深度。

4. **测试驱动开发**：内核内单元测试 + 端到端测试 + 官方测例回归的三层测试体系提供了可靠的迭代保障。

5. **竞赛特化优化**：内置竞赛 runner、多路径启动信息解析、ext4 性能缓存等面向比赛场景的设计实用且有效。

不足之处主要在于网络栈的 TCP 实现较为基础、SMP 支持（特别是 LoongArch）不够完善，以及对 ext4_rs 第三方库的依赖。总体而言，这是一个在约 46,000 行内核代码中实现了令人印象深刻的功能广度的 Rust OS 内核项目。