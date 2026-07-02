# OSoldierBoy 内核项目深度技术报告

---

## 一、分析方法与测试结果

### 1.1 分析方法

本阶段对仓库进行了以下分析操作：

1. **静态源代码审查**：逐文件阅读并分析所有 Rust 源文件（`src/` 目录下全部 `.rs` 文件）、汇编文件（`riscv64.S`、`loongarch64.S`）、链接脚本（`arch/*.ld`）以及构建配置文件（`Cargo.toml`、`Makefile`）。
2. **符号搜索与交叉引用**：通过 `grep` 搜索关键函数、结构体、枚举和常量定义，追踪调用链和数据流。
3. **代码度量**：统计各文件的代码行数、函数数、syscall 数量、FdEntry 变体数量等。
4. **构建测试**：使用 Rust nightly-2025-05-20 工具链 + `riscv64gc-unknown-none-elf` 目标成功构建 RISC-V 内核镜像。
5. **QEMU 启动测试**：在无磁盘镜像的情况下启动 RISC-V QEMU virt 机器，验证内核初始化流程。

### 1.2 测试结果

**构建结果**：成功。产物为 `target/riscv64gc-unknown-none-elf/release/osoldierboy`，大小约 1.07 MiB（1,119,480 字节），ELF 64-bit LSB RISC-V 静态链接可执行文件。

**QEMU 启动结果**（无磁盘镜像）：

```
OSoldierBoy kernel
cpu=0 firmware_arg=0x9fe00000
heap: bump allocator range=[0x802e1000, 0x842e1000)
frame: allocator range=[0x84322000, 0x88000000) total=15582 pages
mm: kernel=[0x80200000, 0x84322000) free-frames=[0x84322000, 0x88000000)
heap: smoke ok box=0x4f53424f59550001 vec_len=3 vec_sum=6
frame: smoke ok first=0x84322000 second=0x84323000 remaining=15580 pages
paging: sv39 smoke ok va=0x10000000 pa=0x84322000 tables=3
user: aspace smoke ok mapped_pages=1 sample=user-aspace-smoke
contest runner
script suffix: _testcode.sh
scan root: /
scan root: /musl
scan root: /glibc
block: no RISC-V virtio-mmio block device found
block/ext4/user-mode execution is the next implementation stage
system halt
```

内核正确完成初始化（控制台、内存管理、页表、用户地址空间冒烟测试），随后因未检测到 VirtIO-MMIO 块设备而正常停机。用户态入口路径（`ext4::smoke_test → task::riscv64::run_loaded_elf`）在无磁盘时不会触发。

---

## 二、项目总览

| 维度 | 数值 |
|------|------|
| **语言** | Rust（`#![no_std]` + `#![no_main]`），少量 RISC-V / LoongArch 汇编 |
| **内核类型** | 单体内核 (Monolithic Kernel) |
| **总代码量** | Rust ~30,521 行 + 汇编 ~1,970 行 + 链接脚本 ~130 行 |
| **外部依赖** | 零（无任何第三方 crate） |
| **架构支持** | RISC-V 64（完整）、LoongArch 64（部分） |
| **Rust 工具链** | nightly-2025-05-20 |
| **链接器** | rust-lld (LLVM LLD) |
| **Syscall 数量** | 183 个 `fn sys_*` 方法 |
| **文件描述符类型** | 15 种 `FdEntry` 变体 |
| **信号支持** | 65 个信号位（SIGNO 0-64） |

---

## 三、子系统详细拆解

### 3.1 架构抽象层 (`src/arch/`)

#### 3.1.1 模块结构

```
src/arch/
├── mod.rs          # 条件编译分发: #[cfg(target_arch = "riscv64")] / #[cfg(target_arch = "loongarch64")]
├── riscv64.rs      # RISC-V 平台常量、UART、SBI、定时器
├── riscv64.S       # RISC-V 汇编: 启动、陷入处理、用户态切换 (~245 行)
├── loongarch64.rs  # LoongArch 平台常量、UART、关机
└── loongarch64.S   # LoongArch 汇编: 启动 (~55 行)
```

#### 3.1.2 RISC-V 64 平台实现

**内存布局常量：**

```rust
pub const PAGE_SIZE: usize = 4096;
pub const PHYS_MEMORY_BASE: usize = 0x8000_0000;
pub const PHYS_MEMORY_SIZE: usize = 128 * 1024 * 1024;  // 128 MiB
pub const KERNEL_BASE: usize = 0x8020_0000;
```

内核从物理地址 `0x8020_0000` 开始（OpenSBI 跳转地址后），物理内存上限 128 MiB。`virt_to_phys`/`phys_to_virt` 在 RISC-V 上为恒等映射。

**UART 控制台 (NS16550A)：**

```rust
const UART_BASE: usize = 0x1000_0000;

pub fn putchar(byte: u8) {
    unsafe {
        while read_reg(UART_LSR) & UART_LSR_THRE == 0 {}  // 等待发送就绪
        write_reg(UART_RHR_THR, byte);
    }
}
```

标准 QEMU `virt` 机器 `0x1000_0000` 处的 NS16550A UART，通过 MMIO volatile 读写操作。

**SBI 调用封装：**

```rust
unsafe fn sbi_call(eid: usize, fid: usize, arg0: usize, arg1: usize, arg2: usize) -> usize {
    let mut ret = arg0;
    asm!("ecall", inlateout("a0") ret, in("a1") arg1, in("a2") arg2,
         in("a6") fid, in("a7") eid, options(nostack));
    ret
}
```

用于系统关机 (`0x5352_5354` = "SRST") 和定时器设置（SBI TIME 扩展 + 旧版 SET_TIMER 回退）。

**定时器：**

```rust
pub fn set_timer_after_us(delta_us: u64) {
    let delta_ticks = delta_us.saturating_mul(TIMEBASE_HZ) / 1_000_000;
    set_timer_ticks(read_time_ticks().saturating_add(delta_ticks.max(1)));
}
```

基于 `rdtime` 指令读取时间戳（`TIMEBASE_HZ = 10_000_000`），通过 SBI 设置定时器比较值。调度器使用定时器实现时间片 `TIMER_SLICE_US = 1_000`（1ms）。

**启动汇编 (`riscv64.S`)：**

- `_start`: 仅 CPU0 (hart 0) 进入内核主函数，其他 hart 进入 WFI 自旋
- `__riscv_trap_entry`: 完整保存/恢复 32 个通用寄存器 + `sepc` + `sstatus`，使用 `sscratch` 与内核栈交换
- `__riscv_enter_user`: 从 TrapFrame 恢复所有寄存器，设置 `sepc`/`sstatus`（SPIE=1, FS=1），通过 `sret` 进入用户态
- 启动栈 128 KiB，陷入栈 256 KiB

#### 3.1.3 LoongArch 64 平台实现

**当前实现状态**：仅支持启动、串口输出、关机，无双核处理、无定时器、无陷入处理、无用户态切换。

```rust
pub const PHYS_MEMORY_BASE: usize = 0x9000_0000;
pub const KERNEL_BASE_VADDR: usize = 0x9000_0000_9000_0000;  // 直接映射窗口
pub const PHYS_VIRT_OFFSET: usize = KERNEL_BASE_VADDR - KERNEL_BASE_PADDR;
```

LoongArch 地址转换通过 `virt_to_phys`/`phys_to_virt` 基于直接映射窗口偏移实现。`monotonic_time_us()` 目前返回常量 `1_000_000`。链接脚本使用 `AT()` 指令处理物理/虚拟地址分离。

#### 3.1.4 链接脚本

**RISC-V (`arch/riscv64.ld`)**：`KERNEL_BASE = 0x80200000`，标准段布局 `.text` / `.rodata` / `.data` / `.bss` + `.boot_stack`，设置 `__global_pointer$` 偏移 `0x800`，丢弃 `.eh_frame` 和 `.comment`。

**LoongArch (`arch/loongarch64.ld`)**：`KERNEL_VADDR = 0x9000000090000000`，使用 `PHDRS` 显式定义三个 `PT_LOAD` 段，每个输出段通过 `AT(ADDR(.) - PHYS_OFFSET)` 指定加载地址。

---

### 3.2 内存管理子系统 (`src/mm/`)

#### 3.2.1 模块结构

```
src/mm/
├── mod.rs       # 子系统入口: BSS清零、初始化调度、冒烟测试
├── frame.rs     # 物理页帧分配器 (161 行)
├── heap.rs      # 内核堆分配器 (273 行)
├── paging.rs    # Sv39 页表管理 (332 行)
└── user.rs      # 用户地址空间管理 (1,235 行)
```

#### 3.2.2 物理页帧分配器 (`frame.rs`)

**数据结构：**

```rust
struct FrameAllocator {
    locked: AtomicBool,       // 自旋锁
    start: AtomicUsize,       // 物理起始地址
    next: AtomicUsize,        // bump 指针
    end: AtomicUsize,         // 物理结束地址
    free_count: AtomicUsize,  // 回收列表计数
}
```

**分配策略**：Bump allocator + 回收列表（`FREE_FRAMES: [usize; 32768]`）。优先从回收列表分配，为空时推进 bump 指针。回收时插入到 `FREE_FRAMES[]` 数组末尾（O(1)）。

**同步机制**：基于 `AtomicBool` 的自旋锁（CAS 循环），`lock()/unlock()` 使用 Acquire/Release 语义。

**初始化**：以内核 `__kernel_end` 对齐到页边界后的物理地址为起点，`PHYS_MEMORY_BASE + PHYS_MEMORY_SIZE` 为终点。当前配置约 15,582 个可用页帧（约 60.9 MiB）。

#### 3.2.3 内核堆分配器 (`heap.rs`)

**寄存器为全局分配器：**

```rust
#[global_allocator]
static ALLOCATOR: BumpAllocator = BumpAllocator::new();
```

**实现**：64 MiB 静态数组 `KernelHeap`（4 KiB 对齐）。Bump allocator + 自由块复用（`FREE_BLOCKS: [FreeBlock; 8192]`）。

分配时先搜索自由块列表（支持对齐填充和剩余块拆分），无匹配时推进 bump 指针。释放时通过 `add_free_block()` 插入并自动合并相邻空闲块（O(n) 扫描合并）。

`#[alloc_error_handler]` 在分配失败时触发 panic。

#### 3.2.4 Sv39 页表管理 (`paging.rs`)

**核心数据结构：**

```rust
pub struct Sv39PageTable {
    root: *mut PageTableNode,            // 根页表（三级）
    root_frame: frame::PhysFrame,
    table_frames: [usize; 128],         // 已分配的中间页表帧
    table_count: usize,
}

#[repr(C, align(4096))]
struct PageTableNode {
    entries: [PageTableEntry; 512],      // 每级 512 项
}
```

**页表项标志**：`PTE_V(0)/R(1)/W(2)/X(3)/U(4)/A(6)/D(7)`，兼容 RISC-V Sv39 规范。

**支持操作**：
- `map(virt, phys, flags)`：映射 4 KiB 页面（三级遍历）
- `map_large(virt, phys, flags)`：映射 2 MiB 大页（两级遍历，中间节点为叶）
- `unmap(virt)`：解除映射并清零 PTE
- `protect(virt, flags)`：修改叶节点权限标志
- `translate(virt)`：遍历页表返回物理地址（支持大页偏移计算）
- `satp_value()`：生成 Sv39 SATP 寄存器值（MODE=8）

**限制**：最多 128 个中间页表帧（可管理约 256 GiB 虚拟地址空间）。

#### 3.2.5 用户地址空间管理 (`user.rs`)

这是整个内核中最复杂的子系统之一，提供完整的用户态虚拟地址空间管理。

**核心数据结构：**

```rust
pub struct UserAddressSpace {
    inner: Rc<RefCell<UserAddressSpaceInner>>,  // 引用计数 + 内部可变性
}

struct UserAddressSpaceInner {
    page_table: Sv39PageTable,
    pages: Vec<UserPage>,            // 已映射页面追踪
    reservations: Vec<Reservation>,  // 延迟分配预留
}
```

`Rc<RefCell<>>` 设计支持 `fork()` 时的 COW 语义（通过 `shared_clone()`/`deep_clone()`）。

**地址空间布局常量：**

```rust
pub const USER_SPACE_BASE: usize = 0x1000;
pub const USER_STACK_TOP: usize = 0x4_0000_0000;
pub const USER_STACK_SIZE: usize = 0x8_0000;        // 512 KiB
pub const USER_HEAP_BASE: usize = 0x4000_0000;
pub const USER_MMAP_BASE: usize = 0x5000_0000;
pub const USER_MMAP_SIZE: usize = 0x1200_0000_0000; // ~18 TiB
pub const SIGNAL_TRAMPOLINE: usize = 0x4010_0000;
pub const USER_INTERP_BASE: usize = 0x400_0000;     // 动态链接器加载地址
pub const USER_STATIC_PIE_BASE: usize = 0x20_0000;
```

**ELF 加载流程：**

1. `ElfImage::parse(bytes)` 解析 ELF 头，验证魔数、64位、小端、RISC-V 机器类型
2. `ElfImage::load_plan(bytes)` 遍历 PT_LOAD 段生成 `LoadPlan`（最多 8 个段）
3. `load_elf_with_args()` 创建 `UserAddressSpace`，依次调用：
   - `map_kernel_identity()`：恒等映射物理内存 + MMIO 区域（UART, VirtIO, CLINT, PLIC）
   - `map_signal_trampoline()`：在 `0x4010_0000` 映射信号返回跳板（`li a7,139; ecall`）
   - `map_load_plan()`：为每个 PT_LOAD 段分配页帧，拷贝文件数据，BSS 默认已清零
   - `apply_static_pie_relocations()`：处理 R_RISCV_RELATIVE / R_RISCV_64 / R_RISCV_JUMP_SLOT 重定位
   - `map_initial_stack()`：构建初始用户栈（argc/argv/envp/auxv/AT_RANDOM）

**静态 PIE 重定位**：解析 ELF 的 `PT_DYNAMIC` 段，查找 `DT_RELA`/`DT_RELASZ`/`DT_SYMTAB`/`DT_SYMENT`，遍历 `.rela.dyn` 条目，仅支持 RISC-V 的三种重定位类型。

**初始栈构建 (`StackBuilder`)**：自顶向下在 `USER_STACK_TOP` 构建用户栈，写入：
- 字符串数据（argv、envp、16 字节随机种子 `AT_RANDOM_OSBOY!`）
- 对齐到 16 字节
- AUX vectors：`AT_PHDR(3)`, `AT_PHENT(4)`, `AT_PHNUM(5)`, `AT_PAGESZ(6)`, `AT_BASE(7)`, `AT_ENTRY(9)`, `AT_RANDOM(25)`, `AT_NULL(0)`
- envp 指针数组 + NULL 终止
- argv 指针数组 + NULL 终止
- argc

**按需分页 (Demand Paging)**：`write_inner()` 和 `read()` 在页缺失时调用 `handle_page_fault()`，检查 `reservations` 列表中是否有对应的预留（来自 mmap 或 brk），有则分配物理页帧并填入页表。`ensure_mapped()` 方法同样支持按需映射。

**fork 支持**：`deep_clone()` 为 owned 页面分配新帧并拷贝内容，shared 页面共享物理帧（`map_shared_frame`）。`shared_clone()` 仅增加 `Rc` 引用计数（用于 `CLONE_VM` 的线程创建）。

---

### 3.3 任务/进程管理子系统 (`src/task/`)

#### 3.3.1 模块结构

```
src/task/
├── mod.rs       # UserTask、系统调用实现、信号、定时器 (~11,880 行)
└── riscv64.rs   # 调度器、陷入处理、等待队列、克隆/退出协调 (~2,418 行)
```

#### 3.3.2 UserTask 结构体

```rust
pub struct UserTask {
    // 进程身份
    pid: usize, visible_pid: usize, ppid: usize, pgid: usize, sid: usize, tid: usize,
    // 地址空间
    aspace: UserAddressSpace,
    fd_table: FdTable,
    files: FileCatalog,
    // 文件系统状态
    root: String, cwd: String,
    // 凭证
    uid: usize, euid: usize, saved_uid: usize,
    gid: usize, egid: usize, saved_gid: usize,
    groups: Vec<usize>, umask: usize,
    // 内存布局
    brk_base: usize, brk_current: usize, mmap_next: usize,
    // 信号
    signal_mask: u64, signal_actions: [SignalAction; 65],
    pending_signals: Vec<PendingSignal>,
    // 定时器
    real_timer: RealTimer, virtual_timer: RealTimer, prof_timer: RealTimer,
    posix_timer: PosixTimerState,
    // 命名空间
    pid_namespace_inode: u64, user_namespace_inode: u64,
    cgroup_path: String, cgroup_namespace_root: String,
    netns_lo_tag: i32, netns_default_tag: i32,
    time_namespace: TimeNamespaceState, realtime_offset_us: i128,
    // 资源限制
    nofile_limit: (u64, u64), rusage_utime_us: u64,
    sched_policy: usize, sched_priority: usize,
    // 扩展功能
    capabilities: CapabilityState, bpf_maps: Vec<BpfMap>, bpf_programs: Vec<BpfProgram>,
    shm_segments: Vec<SharedMemorySegment>, key_quota: KeyQuotaState,
    loop_device_attached: bool, tty_termio: [u8; 18], tty_termios: [u8; 36],
    // 杂项
    command_name: String, exec_path: Option<String>,
    epoll_create_legacy_rejected: Rc<RefCell<bool>>,
    uname_call_count: usize, recent_cgroup_move: Option<String>,
}
```

60+ 字段，覆盖 Linux 进程控制块的核心状态。

#### 3.3.3 系统调用分发

**两级分发机制：**

第一级 `handle_syscall()`（在 `task/mod.rs`）：通过 `if` 链快速处理需要异步等待的 syscall（execve/clone/openat/read/write/poll/epoll/futex/signal 等），返回 `SyscallResult` 枚举。

第二级 `handle_syscall_return()`（`match number {}`）：处理可同步返回的 syscall，包括文件操作、进程控制、内存管理、socket、定时器等约 150 个调用。

**SyscallResult 枚举**（21 种变体）：

```rust
pub enum SyscallResult {
    Return(isize),                      // 同步返回
    Exec(ExecTransition),               // execve 地址空间替换
    Clone(CloneTransition),             // fork/clone 创建子任务
    SigReturn,                          // 信号返回（恢复用户态上下文）
    // 异步等待
    FanotifyPermissionWait, ReadWait, WriteWait, AcceptWait,
    DatagramWriteWait, DatagramReadWait, RecordLockWait,
    PollWait, SelectWait, EpollWait, Wait,
    // 信号/睡眠
    SignalTimedWait, SignalSuspend, Sleep,
    // 进程间操作
    Kill, CgroupMove, CgroupKill, FutexWait, FutexWake, FutexRequeue,
    // 终止
    Exit, ExitGroup, Yield,
    Getpgid, GetRobustList, AsyncIoSignal,
}
```

#### 3.3.4 调度器 (`task/riscv64.rs`)

```rust
struct Scheduler {
    tasks: Vec<ScheduledTask>,         // 活动任务列表
    zombies: Vec<ZombieTask>,          // 僵尸任务（等待父进程回收）
    files: FileCatalog,                // 全局文件目录
    pending_programs: Vec<PendingProgram>,  // 待运行的测试程序队列
    current: usize,                    // 当前运行任务索引
    next_pid: usize,                   // 下一个 PID
    root_status: Option<ExitStatus>,   // 根任务退出状态
}
```

**调度策略**：简单轮转（Round-Robin）。时间片耗尽（`SCAUSE_SUPERVISOR_TIMER_INTERRUPT`，1ms）时调用 `schedule_next_ready()` 切换到下一个 `Ready` 状态的任务。

**任务状态**：任务在以下情况变为等待状态：
- 阻塞 I/O（管道读/写、socket accept/connect/datagram、记录锁）
- 轮询等待（poll/select/epoll）
- 信号等待（sigtimedwait/sigsuspend）
- Futex 等待
- 睡眠（nanosleep/clock_nanosleep）
- Fanotify 权限检查
- `waitpid` 等待子进程

**唤醒机制**：每个 syscall 返回后（特别是 `close`、`write`、`read`、`connect`、`shutdown`、`fcntl` 等），调用专用的 `wake_*` 函数检查等待队列：
- `wake_pipe_readers/writers`
- `wake_datagram_readers/writers`
- `wake_accept_waiters`
- `wake_record_lock_waiters`
- `wake_poll/select/epoll_waiters`
- `wake_fanotify_permission_waiters`

**多任务协调**：通过 `next_pid` 单调递增分配 PID，`release_deferred_children()` 将 `SIGCHLD` 信号入队并清理僵尸，`reap_zombie()` 处理 `waitpid`。

#### 3.3.5 clone/fork 实现

```rust
pub fn clone_from(&self, flags: usize, clear_child_tid: usize) -> Result<Self, Error> {
    // CLONE_VM: shared_clone() 而非 deep_clone()
    // CLONE_FILES: fd_table.clone() 而非 deep_clone()
    // CLONE_THREAD: 同 pid, ppid
    // CLONE_NEWCGROUP: 重置 cgroup_namespace_root
    // CLONE_NEWNET: 使用 netns_default_tag
    // CLONE_NEWPID/NEWUSER: 在 Scheduler 层处理
    // ...
}
```

完整支持 Linux clone flags：`CLONE_VM`、`CLONE_FILES`、`CLONE_FS`、`CLONE_SIGHAND`、`CLONE_THREAD`、`CLONE_NEWNS`、`CLONE_NEWCGROUP`、`CLONE_NEWNET`、`CLONE_NEWPID`、`CLONE_NEWUSER`、`CLONE_CHILD_CLEARTID`、`CLONE_CHILD_SETTID`、`CLONE_PARENT_SETTID`、`CLONE_SETTLS`、`CLONE_PIDFD`、`CLONE_INTO_CGROUP`、`CLONE_VFORK`、`CLONE_PARENT`。

#### 3.3.6 完整 syscall 清单

以下列出全部 183 个实现的 syscall（按 syscall 号排列）：

| 号码 | 函数名 | 类别 |
|------|--------|------|
| 0 | `sys_io_setup` | AIO |
| 2 | `sys_io_submit` | AIO |
| 4 | `sys_io_getevents` | AIO |
| 5 | `sys_setxattr` | 扩展属性 |
| 7 | `sys_fsetxattr` | 扩展属性 |
| 8 | `sys_getxattr` | 扩展属性 |
| 10 | `sys_fgetxattr` | 扩展属性 |
| 13 | `sys_flistxattr` | 扩展属性 |
| 16 | `sys_fremovexattr` | 扩展属性 |
| 17 | `sys_getcwd` | 目录 |
| 19 | `sys_eventfd2` | 事件 |
| 20 | `sys_epoll_create1` | epoll |
| 21 | `sys_epoll_ctl` | epoll |
| 22 | `sys_epoll_pwait` | epoll |
| 23 | `sys_dup` | FD |
| 24 | `sys_dup3` | FD |
| 25 | `sys_fcntl` | FD |
| 26 | `sys_inotify_init1` | inotify |
| 27 | `sys_inotify_add_watch` | inotify |
| 28 | `sys_inotify_rm_watch` | inotify |
| 29 | `sys_ioctl` | 设备 |
| 32 | `sys_flock` | 文件锁 |
| 33 | `sys_mknodat` | 文件 |
| 34 | `sys_mkdirat` | 目录 |
| 35 | `sys_unlinkat` | 文件 |
| 36 | `sys_symlinkat` | 符号链接 |
| 37 | `sys_linkat` | 硬链接 |
| 39 | `sys_umount2` | 挂载 |
| 40 | `sys_mount` | 挂载 |
| 43 | `sys_statfs` | 文件系统统计 |
| 44 | `sys_fstatfs` | 文件系统统计 |
| 45 | `sys_truncate` | 文件 |
| 46 | `sys_ftruncate` | 文件 |
| 47 | `sys_fallocate` | 文件 |
| 48 | `sys_faccessat` | 访问检查 |
| 49 | `sys_chdir` | 目录 |
| 50 | `sys_fchdir` | 目录 |
| 51 | `sys_chroot` | 目录 |
| 52 | `sys_fchmod` | 权限 |
| 53 | `sys_fchmodat` | 权限 |
| 54 | `sys_fchownat` | 所有权 |
| 55 | `sys_fchown` | 所有权 |
| 56 | `sys_openat` | 文件 |
| 57 | `sys_close` | FD |
| 59 | `sys_pipe2` | 管道 |
| 61 | `sys_getdents64` | 目录 |
| 62 | `sys_lseek` | 文件 |
| 63 | `sys_read` | I/O |
| 64 | `sys_write` | I/O |
| 65 | `sys_readv` | I/O |
| 66 | `sys_writev` | I/O |
| 67 | `sys_pread64` | I/O |
| 68 | `sys_pwrite64` | I/O |
| 69 | `sys_preadv` | I/O |
| 70 | `sys_pwritev` | I/O |
| 71 | `sys_sendfile` | I/O |
| 72 | `sys_pselect6` | 轮询 |
| 73 | `sys_ppoll` | 轮询 |
| 78 | `sys_readlinkat` | 符号链接 |
| 79 | `sys_newfstatat` | 文件状态 |
| 80 | `sys_fstat` | 文件状态 |
| 82/83 | `sys_fsync` | 同步 |
| 88 | `sys_utimensat` | 时间戳 |
| 89 | `sys_acct` | 进程记账 |
| 90 | `sys_capget` | 能力 |
| 91 | `sys_capset` | 能力 |
| 93 | `sys_exit` | 进程 |
| 94 | `sys_exit` (ExitGroup) | 进程 |
| 96 | `sys_set_tid_address` | 线程 |
| 97 | `sys_unshare` | 命名空间 |
| 98 | `sys_futex` | 同步 |
| 100 | `sys_nanosleep` (via SyscallResult) | 时间 |
| 101 | `sys_nanosleep` | 时间 |
| 102 | `sys_getitimer` | 定时器 |
| 103 | `sys_setitimer` | 定时器 |
| 105 | `sys_init_module` | 模块 |
| 106 | `sys_delete_module` | 模块 |
| 107 | `sys_timer_create` | POSIX 定时器 |
| 110 | `sys_timer_settime` | POSIX 定时器 |
| 112 | `sys_clock_settime` | 时钟 |
| 113 | `sys_clock_gettime` | 时钟 |
| 114 | `sys_clock_getres` | 时钟 |
| 115 | `sys_clock_nanosleep` | 时间 |
| 116 | `sys_syslog` | 日志 |
| 118 | `sys_sched_setparam` | 调度 |
| 119 | `sys_sched_setscheduler` | 调度 |
| 120 | `sys_sched_getscheduler` | 调度 |
| 121 | `sys_sched_getparam` | 调度 |
| 122 | `sys_sched_setaffinity` | 调度 |
| 123 | `sys_sched_getaffinity` | 调度 |
| 124 | `SyscallResult::Yield` | 调度 |
| 125 | `sys_sched_get_priority_max` | 调度 |
| 126 | `sys_sched_get_priority_min` | 调度 |
| 129 | `SyscallResult::Kill` | 信号 |
| 130 | `sys_tkill` | 信号 |
| 131 | `sys_tgkill` | 信号 |
| 133 | `sys_rt_sigsuspend` | 信号 |
| 134 | `sys_rt_sigaction` | 信号 |
| 135 | `sys_rt_sigprocmask` | 信号 |
| 137 | `sys_rt_sigtimedwait` | 信号 |
| 139 | `SyscallResult::SigReturn` | 信号 |
| 141 | `sys_getpriority` | 调度 |
| 143 | `sys_setregid` | 凭证 |
| 144 | `sys_setgid` | 凭证 |
| 145 | `sys_setreuid` | 凭证 |
| 146 | `sys_setuid` | 凭证 |
| 147 | `sys_setresuid` | 凭证 |
| 148 | `sys_getresuid` | 凭证 |
| 149 | `sys_setresgid` | 凭证 |
| 150 | `sys_getresgid` | 凭证 |
| 153 | `sys_times` | 时间 |
| 154 | `sys_setpgid` | 进程组 |
| 155 | `SyscallResult::Getpgid` | 进程组 |
| 156 | `sys_getsid` | 会话 |
| 157 | `getpid` (行内) | 进程 |
| 158 | `sys_getgroups` | 凭证 |
| 159 | `sys_setgroups` | 凭证 |
| 160 | `sys_uname` | 系统信息 |
| 163 | `sys_getrlimit` | 资源限制 |
| 164 | `sys_setrlimit` | 资源限制 |
| 165 | `sys_getrusage` | 资源使用 |
| 166 | `sys_umask` | 权限 |
| 167 | `sys_prctl` | 进程控制 |
| 168 | `sys_getcpu` | CPU |
| 169 | `sys_gettimeofday` | 时间 |
| 171 | `sys_adjtimex` | 时间 |
| 172 | `getpid` | 进程 |
| 173 | `getppid` | 进程 |
| 174 | `getuid` | 凭证 |
| 175 | `geteuid` | 凭证 |
| 176 | `getgid` | 凭证 |
| 177 | `getegid` | 凭证 |
| 178 | `gettid` | 线程 |
| 179 | `sys_sysinfo` | 系统信息 |
| 194 | `sys_shmget` | 共享内存 |
| 195 | `sys_shmdt` | 共享内存 |
| 196 | `sys_shmat` | 共享内存 |
| 197 | `sys_shmctl` | 共享内存 |
| 198 | `sys_socket` | 网络 |
| 199 | `sys_socketpair` | 网络 |
| 200 | `sys_bind` | 网络 |
| 201 | `sys_listen` | 网络 |
| 202 | `sys_accept` | 网络 |
| 203 | `sys_connect` | 网络 |
| 204 | `sys_getsockname` | 网络 |
| 205 | `sys_getpeername` | 网络 |
| 206 | `sys_sendto` | 网络 |
| 207 | `sys_recvfrom` | 网络 |
| 208 | `sys_setsockopt` | 网络 |
| 209 | `sys_getsockopt` | 网络 |
| 210 | `sys_shutdown` | 网络 |
| 211 | `sys_sendmsg` | 网络 |
| 212 | `sys_recvmsg` | 网络 |
| 214 | `sys_brk` | 内存 |
| 215 | `sys_munmap` | 内存 |
| 217 | `sys_add_key` | 密钥 |
| 219 | `sys_keyctl` | 密钥 |
| 220 | `sys_clone` | 进程 |
| 221 | `sys_execve` | 进程 |
| 222 | `sys_mmap` | 内存 |
| 223 | `sys_fadvise64` | 文件 |
| 226 | `sys_mprotect` | 内存 |
| 227 | `sys_msync` | 内存 |
| 228 | `sys_mlock` | 内存 |
| 229 | `sys_munlock` | 内存 |
| 230 | `sys_mlockall` | 内存 |
| 231 | `sys_munlockall` | 内存 |
| 233 | `sys_madvise` | 内存 |
| 236 | `sys_get_mempolicy` | NUMA |
| 260 | `SyscallResult::Wait` | 进程 |
| 261 | `sys_prlimit64` | 资源限制 |
| 262 | `sys_fanotify_init` | fanotify |
| 263 | `sys_fanotify_mark` | fanotify |
| 264 | `sys_name_to_handle_at` | 文件句柄 |
| 266 | `sys_clock_adjtime` | 时钟 |
| 267 | `sys_fsync` | 同步 |
| 268 | `sys_setns` | 命名空间 |
| 273 | `sys_finit_module` | 模块 |
| 276 | `sys_renameat2` | 文件 |
| 278 | `sys_getrandom` | 随机数 |
| 280 | `sys_bpf` | BPF |
| 281 | `sys_execveat` | 进程 |
| 283 | `sys_membarrier` | 屏障 |
| 285 | `sys_copy_file_range` | I/O |
| 286 | `sys_preadv2` | I/O |
| 287 | `sys_pwritev2` | I/O |
| 291 | `sys_statx` | 文件状态 |
| 409 | `sys_timer_settime` | POSIX 定时器 |
| 424 | `sys_pidfd_send_signal` | pidfd |
| 429 | `sys_move_mount` | 挂载 |
| 430 | `sys_fsopen` | 挂载 |
| 431 | `sys_fsconfig` | 挂载 |
| 432 | `sys_fsmount` | 挂载 |
| 433 | `sys_fspick` | 挂载 |
| 434 | `sys_pidfd_open` | pidfd |
| 435 | `sys_clone3` | 进程 |
| 436 | `sys_close_range` | FD |
| 439 | `sys_faccessat2` | 访问检查 |

#### 3.3.7 信号子系统

**信号数量**：65 个（SIGNAL_COUNT=65），使用 `u64` 位掩码。显式支持：`SIGALRM`(14)、`SIGABRT`(6)、`SIGBUS`(7)、`SIGFPE`(8)、`SIGILL`(4)、`SIGKILL`(9)、`SIGQUIT`(3)、`SIGSEGV`(11)、`SIGCHLD`(17)、`SIGSTOP`(19)、`SIGSYS`(31)、`SIGTRAP`(5)、`SIGXCPU`(24)、`SIGXFSZ`(25)。

**信号处理流程：**

1. `queue_signal(signal, value, sender_pid, sender_uid)`：将信号插入 `pending_signals` 有序列表（按信号编号排序，同信号去重）
2. `check_pending_signals()`：检查有无未被阻塞且 action 非 SIG_IGN 的信号
3. `deliver_pending_signal()`：调用 `build_signal_frame()` 在用户栈构造信号帧：
   - 格式（从低到高）：`[magic:u64][old_mask:u64][signo:u64][siginfo_ptr:u64][trapframe:272B][siginfo:128B][ucontext:960B]`
   - `SIGNAL_FRAME_MAGIC = 0x4f_53_42_53_49_47_46_52` ("OSBSIGFR")
   - 设置 `sepc = sa_handler`, `ra = SIGNAL_TRAMPOLINE`
4. 信号返回：用户态跳板执行 `li a7,139; ecall` → `SyscallResult::SigReturn` → `handle_sigreturn()` 恢复 `TrapFrame`

**信号动作**：`SignalAction` 包含 `handler: usize`、`mask: u64`、`flags: usize`，支持 `SA_SIGINFO`（传递 siginfo_t）。

#### 3.3.8 Futex 实现

基于物理地址的 futex key（`physical_address(uaddr)`），支持：
- `FUTEX_WAIT`：原子检查值 → 不匹配返回 EAGAIN，匹配则阻塞等待
- `FUTEX_WAKE`：唤醒最多 count 个等待者
- `FUTEX_REQUEUE` / `FUTEX_CMP_REQUEUE`：部分唤醒 + 部分转移到目标 futex

超时支持通过 `read_relative_timeout_deadline()` 将 `timespec` 转换为绝对微秒截止时间。

---

### 3.4 文件系统子系统 (`src/fs/`)

#### 3.4.1 模块结构

```
src/fs/
├── mod.rs      # 模块入口 (2 行)
├── ext4.rs     # EXT4 只读文件系统 (~1,224 行)
└── file.rs     # VFS 风格文件抽象层 (~11,625 行)
```

#### 3.4.2 EXT4 只读文件系统 (`ext4.rs`)

**Superblock 解析：**

```rust
struct Superblock {
    magic: u16, blocks_count: u64, inodes_count: u32,
    block_size: u32, inode_size: u16,
    blocks_per_group: u32, inodes_per_group: u32,
    first_data_block: u32, ...
}
```

从偏移 1024 字节读取 1024 字节超级块，验证 `EXT4_SUPER_MAGIC (0xef53)`。支持块大小为 1024/2048/4096 的动态探测。

**Inode 解析：**

```rust
struct Inode {
    mode: u16, uid: u32, gid: u32, size: u64,
    atime_sec: u64, ctime_sec: u64, mtime_sec: u64,
    flags: u32, block: [u8; 60],  // 块指针/extent header
}
```

**Extent 树遍历：**

```rust
fn collect_extents(device, inode, block_size) -> Result<Vec<Extent>, Error>
```

- 检查 `EXT4_EXTENT_MAGIC (0xf30a)`
- 验证深度 ≤ `MAX_EXTENT_TREE_DEPTH (5)`
- 递归遍历内部节点（`ExtentIndex`）和叶节点（`ExtentLeaf`）
- 收集 `Extent { block: u64, len: u16, start_lo: u32, start_hi: u16 }`

**快速符号链接**：如果 `mode & 0xf000 == 0xa000 && size <= 60`，直接从 `inode.block[]` 读取链接目标。

**目录遍历：**

```rust
fn visit_dir_entries(device, inode, callback) -> Result<(), Error>
```

遍历 ext4 目录项的线性列表（`DirEntry`：`inode: u32, name: &str, file_type: u8`），通过 extent 收集的文件块读取目录数据。

**路径解析：**

```rust
fn lookup_path(device, path) -> Result<u32, Error>  // 返回 inode 号
fn lookup_child(device, parent_inode, name) -> Result<u32, Error>
```

从 `ROOT_INODE (2)` 出发逐级查找。

**用户程序发现（`smoke_test` 核心逻辑）：**

优先级从高到低：
1. 测试脚本（busybox + *_testcode.sh）
2. 基础测例 (`USER_PROGRAM_CANDIDATES`：brk/chdir/clone/... 共 32 个)
3. libctest 动态 runtest 用例
4. libctest 静态 runtest 用例
5. libctest 直接用例
6. 焦点测例 (`FOCUSED_PROGRAM_CANDIDATES`：15 个特定测试程序)

发现后调用 `UserAddressSpace::load_static_elf_with_args()` → `run_loaded_elf()` 进入用户态。

#### 3.4.3 VFS 风格文件抽象层 (`file.rs`)

**FileCatalog**：内核的中心化文件系统目录。从 EXT4 构建时通过 `FileCatalog::from_ext4()` 预填充：
- EXT4 中的真实文件
- 合成目录：`/tmp`, `/var/tmp`, `/proc`, `/proc/1`, `/proc/self`, `/proc/self/fd`, `/proc/self/ns`, `/proc/sys/*`, `/dev`, `/dev/pts`, `/dev/shm`, `/sys`, `/sys/dev/block/*`, `/sys/fs/cgroup`, `/sys/class`, `/ltp-resource/*`
- 合成文件：`/proc/mounts`, `/proc/meminfo`, `/proc/uptime`, `/proc/stat`, `/proc/cpuinfo`, `/proc/sys/*`, `/proc/self/status`, `/proc/self/maps`, `/proc/self/ns/*`, `/proc/self/cgroup`, `/proc/self/attr/current`, `/proc/self/comm`, `/proc/self/exe`, `/proc/self/cmdline`, `/proc/self/limits`, `/proc/self/io`, `/proc/self/mountinfo`, `/proc/self/sched`, `/proc/self/stat`, `/proc/self/statm` 等

**FdEntry 枚举（15 种变体）：**

| 变体 | 用途 |
|------|------|
| `Stdin/Stdout/Stderr` | 标准 I/O（连接到当前控制台） |
| `File(OpenFile)` | 普通文件（支持读写、共享内存映射） |
| `Directory(OpenDirectory)` | 目录（支持 readdir/seekdir） |
| `PipeReader/PipeWriter` | 匿名管道（64 KiB 缓冲区，`PIPE_BUF=4096`） |
| `Socket(Rc<RefCell<SocketState>>)` | 网络 socket |
| `SocketPair(SocketPairEndpoint)` | socketpair 端点 |
| `EventFd(Rc<RefCell<EventFdState>>)` | eventfd（支持 semaphore 模式） |
| `PidFd(PidFdState)` | pidfd |
| `Epoll(Rc<RefCell<EpollState>>)` | epoll 实例 |
| `Inotify(Rc<RefCell<InotifyState>>)` | inotify 实例 |
| `Fanotify(Rc<RefCell<FanotifyState>>)` | fanotify 实例 |
| `FsContext(Rc<RefCell<FsContextState>>)` | fsopen/fsconfig 上下文 |
| `MountObject(Rc<RefCell<MountObjectState>>)` | fsmount 挂载对象 |

**FdTable**：每个进程的文件描述符表。前 `FD_INLINE_LIMIT` 个条目内联存储，超出部分通过 `extra_entries: Vec<(usize, FdSlot)>` 扩展。支持 `deep_clone()`（fork）和共享 clone（`CLONE_FILES`）。

**OpenFile**：封装文件路径、文件数据（`Vec<u8>` 或惰性映射的 EXT4 块）、偏移量、状态标志。支持 `read_at`/`write_at`，对基于内存的文件直接操作字节数组。对 EXT4 文件，`write_at` 触发 copy-on-write（将 EXT4 页面复制到私有缓冲区后写入）。

**挂载系统**：通过合成文件系统实现：
- `fsopen(fsname, flags)` → 创建 `FsContext`
- `fsconfig(fd, cmd, key, value, aux)` → 配置选项
- `fsmount(fd, flags, attrs)` → 创建 `MountObject`
- `move_mount(from_dirfd, from_path, to_dirfd, to_path, flags)` → 移动挂载
- `mount(source, target, fstype, flags, data)` → 传统挂载

支持 bind mount (`mark_bind_mounted`)、只读重挂载 (`mark_mount_read_only`)、overlay lower 挂载 (`mount_overlay_lower`)。

**Socket 子系统：**

```rust
struct SocketState {
    domain: usize,           // AF_UNIX(1) / AF_INET(2) / AF_INET6(10) / AF_NETLINK(16) / AF_PACKET(17)
    kind: usize,             // SOCK_STREAM(1) / SOCK_DGRAM(2) / SOCK_RAW(3) / SOCK_SEQPACKET(5)
    protocol: usize,
    local_port: Option<u16>,
    peer_port: Option<u16>,
    listening: bool,
    pending_connections: Vec<PendingStreamConnection>,
    datagrams: Vec<Datagram>,
    stream: Option<StreamEndpoint>,
    unix_name: Option<[u8; 16]>,   // AF_UNIX 绑定地址
    ...
}
```

- **AF_INET/AF_INET6**：UDP 数据报 socket 支持发送/接收（`sendto`/`recvfrom`）。通过 `SocketRegistry` 管理端口复用。多播组支持（`multicast_group_joined`）。
- **AF_UNIX**：基于名称的 socket 绑定/连接，`SOCK_STREAM` 通过 `StreamEndpoint` 支持双向字节流（64 KiB 缓冲区），`SOCK_DGRAM` 通过 `datagrams` 支持数据报。
- **AF_NETLINK**：`read_netlink_socket`/`write_netlink_socket` 处理 Netlink 协议（`RTM_GETADDR`/`RTM_NEWADDR`/`RTM_DELADDR`）。
- **AF_PACKET**：原始包 socket（`packet_ifindex`）。

**Epoll**：`EpollState` 存储注册的 FD 和事件掩码。`epoll_ctl` 支持 `EPOLL_CTL_ADD/DEL/MOD`。`epoll_pwait` 扫描注册 FD 调用 `readable_now()` 或检查 socket/pipe/eventfd 就绪状态。

**Inotify**：`InotifyState` 维护监视描述符（wd）到路径的映射。文件操作（open/write/unlink/rename等）时通过 `queue_inotify_event` 和 `queue_inotify_child_event` 向相关 inotify 实例投递事件。

**Fanotify**：`FanotifyState` 支持 `FAN_CLASS_CONTENT`/`FAN_CLASS_NOTIF`。权限事件（`FAN_OPEN_PERM`/`FAN_OPEN_EXEC_PERM`）在 `execve`/`openat` 路径中触发，通过 `FanotifyPermissionWait` 返回调度器等待用户态响应。支持 `FAN_MARK_ADD`/`FAN_MARK_REMOVE`、`FAN_MARK_MOUNT`、`FAN_MARK_FILESYSTEM`、`FAN_MARK_INODE` 和 `FAN_MARK_IGNORED_MASK`。支持 `FAN_RENAME` 事件（`queue_fanotify_rename_event`）。

**文件锁**：支持 BSD `flock`（`BsdFlockOperation::LockShared/LockExclusive/Unlock`）和 POSIX 记录锁（`RecordLockCommand::SetLock/SetLockWait/GetLock`，通过 `FileLockOwner` 区分进程）。

---

### 3.5 ELF 加载器 (`src/elf/mod.rs`)

**功能**：
- ELF64 头解析（魔数、64位验证、小端验证、RISC-V 机器类型验证）
- 程序头表遍历（PT_LOAD/PT_INTERP/PT_DYNAMIC）
- `LoadPlan` 生成：对齐页边界的虚拟地址范围计算
- 符号链接解释器提取（`PT_INTERP` → `/lib/ld-musl-riscv64.so.1` 等）
- 位置无关代码检测（`ET_DYN`）

**静态 PIE 重定位支持**（解析 `.rela.dyn`）：
- `R_RISCV_NONE (0)`：跳过
- `R_RISCV_RELATIVE (3)`：`*(base + addend) = base + addend`
- `R_RISCV_64 (2)`：`*(base + offset) = symbol_value + addend`
- `R_RISCV_JUMP_SLOT (5)`：同 R_RISCV_64 处理

限制：最多 8 个 PT_LOAD 段，仅支持 RISC-V 架构。

---

### 3.6 设备驱动 (`src/drivers/`)

#### 3.6.1 块设备抽象 (`block.rs`)

```rust
pub trait BlockDevice {
    fn read_sector(&mut self, sector: u64, buffer: &mut [u8; 512]) -> Result<(), Error>;
    fn capacity_sectors(&self) -> u64;
}
```

简单通用的 512 字节扇区级块设备接口。

#### 3.6.2 VirtIO-MMIO 块设备驱动 (`virtio_mmio.rs`)

**探测**：扫描 8 个 MMIO 基址 (`0x1000_1000` ~ `0x1000_8000`)，验证 `VIRTIO_MAGIC (0x74726976)` 和设备 ID `VIRTIO_DEVICE_BLOCK (2)`。

**传输版本**：同时支持 Legacy（MMIO v1）和 Modern（MMIO v2）传输：
- Legacy：通过 `REG_GUEST_PAGE_SIZE` + `REG_QUEUE_PFN` 设置队列物理地址
- Modern：通过 `REG_QUEUE_DESC_LOW/HIGH` + `REG_QUEUE_DRIVER_LOW/HIGH` + `REG_QUEUE_DEVICE_LOW/HIGH` 设置分离的队列地址

**队列**：单个 virtqueue（`QUEUE_SIZE=8`），使用三段描述符链（header → data → status）实现扇区读取。

**容量**：从 `REG_CONFIG` 开始的 8 字节读取（legacy 为 little-endian，modern 通过内存读取）。

---

### 3.7 辅助子系统

#### 3.7.1 控制台 (`console.rs`)

提供 `print!`/`println!` 宏，通过 `Console` 结构体实现 `core::fmt::Write` trait。`\n` 自动扩展为 `\r\n`。

#### 3.7.2 Panic 处理 (`panic.rs`)

```rust
#[panic_handler]
fn panic(info: &PanicInfo<'_>) -> ! {
    println!("kernel panic: {}", info);
    crate::arch::shutdown()
}
```

#### 3.7.3 比赛测试框架 (`contest.rs`)

**重要发现**：`contest.rs` 中的 `run()` 函数是一个部分存根。其主要功能：
1. 描述测试计划（`SEARCH_ROOTS = ["/", "/musl", "/glibc"]`，`TEST_SUFFIX = "_testcode.sh"`）
2. 调用 `drivers::block::smoke_test()` —— 实际用户态入口的触发点
3. 如果未找到块设备，打印"block/ext4/user-mode execution is the next implementation stage"

**真正的用户态入口路径**：
```
main.rs: contest::run()
  → contest.rs: drivers::block::smoke_test()
    → block.rs: ext4::smoke_test(&mut device)
      → ext4.rs: UserAddressSpace::load_static_elf_with_args()
        → task::riscv64::run_loaded_elf()
```

`contest.rs` 的 `is_test_script()` 函数被标记为 `#[allow(dead_code)]`，因为它被 `ext4::smoke_test` 中更复杂的脚本发现逻辑取代。

---

## 四、子系统交互关系

### 4.1 启动流程

```
_start (汇编)
  → rust_main()
    → mm::zero_bss()                    // 清零 BSS 段
    → console::init()                   // 初始化 UART
    → mm::init()                        // 初始化堆 → 帧分配器 → 页表/用户冒烟测试
    → contest::run()                    // 比赛入口
      → block::smoke_test()             // 探测块设备
        → ext4::smoke_test()            // 挂载 EXT4、发现程序、加载 ELF
          → UserAddressSpace::load_static_elf_with_args()  // ELF→地址空间
          → task::riscv64::run_loaded_elf()  // 进入用户态
    → arch::shutdown()                  // 用户态退出后关机
```

### 4.2 用户态陷入处理循环

```
用户态执行 → trap → __riscv_trap_entry (汇编)
  → riscv_handle_trap(frame, scause, stval)
    → SCAUSE_ECALL_FROM_U: scheduler.handle_syscall()
      → UserTask::handle_syscall(number, args)
        → SyscallResult::Return / Exec / Clone / ReadWait / ...
    → SCAUSE_SUPERVISOR_TIMER_INTERRUPT: scheduler.handle_timer()
      → schedule_next_ready() (轮转)
    → SCAUSE_LOAD/STORE_PAGE_FAULT: scheduler.handle_page_fault()
      → UserTask::handle_page_fault() → reservation → frame::alloc()
  → 返回 satp 值 → __riscv_enter_user (汇编恢复上下文)
```

### 4.3 关键数据结构交互

```
Scheduler
 ├── tasks: Vec<ScheduledTask>
 │    ├── task: UserTask
 │    │    ├── aspace: UserAddressSpace → Sv39PageTable
 │    │    ├── fd_table: FdTable
 │    │    │    └── entries → FdEntry (15 变体)
 │    │    └── files: FileCatalog → EXT4 文件 + 合成文件
 │    └── frame: TrapFrame (RISC-V 寄存器快照)
 ├── zombies: Vec<ZombieTask>
 ├── files: FileCatalog (全局共享)
 └── pending_programs: Vec<PendingProgram> (测试编排)
```

---

## 五、实现完整度评估

### 5.1 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **架构层 - RISC-V** | 95% | 启动、UART、SBI、定时器、陷入处理、用户态切换全部实现；缺失：多核 SMP、PMU |
| **架构层 - LoongArch** | 15% | 仅启动和 UART；缺失：定时器、陷入处理、用户态切换、页表 |
| **物理页帧分配** | 85% | bump+回收列表，自旋锁保护；缺失：页面回收策略、NUMA 感知 |
| **内核堆分配** | 80% | bump+自由块复用，合并相邻块；缺失：碎片整理、彩色分配 |
| **Sv39 页表** | 90% | map/unmap/protect/translate + 大页；当前 RISC-V 专用 |
| **用户地址空间** | 90% | ELF 加载、mmap、brk、按需分页、PIE 重定位、信号跳板、fork CoW |
| **进程管理** | 85% | fork/clone/clone3/execve/execveat/wait/exit；183 个 syscall |
| **信号** | 80% | 65 信号、sigaction、sigmask、siginfo、信号栈帧；缺失：硬实时信号排队 |
| **调度器** | 60% | 简单 RR+等待队列；缺失：优先级调度、CFS、多核负载均衡 |
| **EXT4** | 60% | 只读：超级块、inode、extent 树、目录遍历、快速符号链接；缺失：写入、日志、扩展属性 |
| **VFS/文件抽象** | 85% | 15 种 FD 类型、管道、socket、epoll、inotify、fanotify、合成 /proc、挂载系统 |
| **Socket/网络** | 50% | AF_UNIX/AF_INET/AF_INET6/AF_NETLINK/AF_PACKET；UDP/TCP 流支持；缺失：真实网络栈 |
| **VirtIO-MMIO** | 80% | Legacy+Modern 传输、扇区读取；缺失：多队列、DMA、virtio-blk 写入 |
| **ELF 加载器** | 70% | 静态 ELF、PT_INTERP、静态 PIE 重定位；仅 RISC-V；最多 8 个 LOAD 段 |
| **定时器** | 75% | ITIMER_REAL/VIRTUAL/PROF、POSIX 定时器、高精度超时 |
| **命名空间** | 50% | PID/User/Cgroup/Net/Mount 命名空间框架；实现不完整 |

### 5.2 整体完整度

基于功能覆盖与实现深度，该内核的整体完整度约为 **70%**（相对于比赛预期的 Linux ABI 兼容性目标）。内核展示了完整的启动→文件系统→ELF 加载→用户态→syscall→调度→信号→退出的关键路径，且在文件抽象和 syscall 数量上覆盖广泛。薄弱环节在于 LoongArch 支持、网络栈深度和多核支持。

---

## 六、设计创新性分析

### 6.1 架构创新点

1. **零外部依赖的单体内核**：在 ~30,000 行 Rust 代码中，未使用任何一个第三方 crate。所有功能（堆分配器、页帧分配器、页表、VFS、EXT4、socket、epoll、inotify、fanotify）均为自包含实现。这在 OS 内核项目中极为罕见。

2. **SyscallResult 枚举驱动的异步调度模型**：系统调用不直接在内核态阻塞，而是返回 `SyscallResult` 枚举的异步变体（如 `ReadWait`、`EpollWait`、`FutexWait`），由调度器统一管理等待队列。这种设计将阻塞语义从 syscall 实现中解耦，使得所有阻塞操作在调度器层被统一唤醒和重试。

3. **一体化文件目录 (`FileCatalog`)**：将 EXT4 文件系统、合成 `/proc`/`/sys`/`/dev`、临时文件、内存文件统一在单一 `FileCatalog` 结构中，所有文件操作通过相同的路径解析和元数据接口。`FdEntry` 的 15 种变体在同一个 `FdTable` 中共存。

4. **Rc<RefCell<>> 驱动的 COW 地址空间**：`UserAddressSpace` 通过 `Rc<RefCell<>>` 实现零成本的共享引用和按需深拷贝，使得 `CLONE_VM`（线程共享地址空间）和 `fork`（COW 语义）能复用同一套地址空间管理代码。

5. **静态 PIE 重定位的深度集成**：ELF 加载器直接实现 `R_RISCV_RELATIVE`/`R_RISCV_64`/`R_RISCV_JUMP_SLOT` 三种重定位，不依赖动态链接器即可加载位置无关的静态可执行文件。

6. **全面的 Linux ABI 测试编排**：`ext4::smoke_test` 中精心设计的 6 级回退测试发现机制（脚本→基础测例→libctest 动态→libctest 静态→libctest 直接→焦点测例），以及 12 类基准测试文件清单（busybox/lua/libcbench/iozone/unixbench/lmbench/cyclictest/netperf/iperf/LTP），体现了面向比赛的工程实践。

### 6.2 设计局限

1. **单核架构**：Scheduler 未实现 SMP 支持，所有核间同步基于单核自旋锁。
2. **简化的网络栈**：Socket 层基于内核内部的内存缓冲区模拟，无真实网络设备驱动和协议栈。
3. **EXT4 只读**：无法创建或修改 EXT4 文件，写入仅针对内存中的副本。
4. **LoongArch 支持不完整**：用户态代码路径全部为 RISC-V 专用 (`#[cfg(target_arch = "riscv64")]`)。

---

## 七、其他项目信息

### 7.1 测试用户程序

`tests/` 目录包含 14 个 C 静态编译测试程序：
- `abi_static.c`、`compat_static.c`：ABI 兼容性
- `exec_child_static.c`、`exec_parent_static.c`：exec 系列
- `file_read_static.c`：文件读取
- `fsmeta_static.c`：文件元数据
- `getdents_static.c`：目录读取
- `identity_static.c`：进程标识
- `lifecycle_static.c`：进程生命周期
- `misc_static.c`：杂项测试
- `path_static.c`：路径操作
- `pipedup_static.c`：管道和 dup
- `tmpwrite_static.c`：临时文件写入
- `vecio_static.c`：向量 I/O

这些文件不参与内核构建，是在磁盘镜像中作为用户态测试载荷。

### 7.2 开发日志

`docs/` 目录包含 32 个开发进度日志（Phase 20-51），记录了从 Phase 20（基础 ELF 加载）到 Phase 51（iperf 脚本测试通过）的迭代过程。

### 7.3 已知基准测试目标

通过代码中的文件清单常量可知，内核针对以下基准测试进行了适配：
- **busybox**：基础 Unix 工具集
- **libctest**：libc 兼容性测试（静态+动态）
- **lua**：Lua 脚本解释器
- **libcbench**：libc 基准测试
- **iozone**：文件 I/O 基准测试
- **unixbench**：Unix 基准测试套件
- **lmbench**：系统微基准测试
- **cyclictest**：实时延迟测试
- **netperf/iperf3**：网络性能测试

---

## 八、总结

OSoldierBoy 是一个面向 OS 内核比赛的高度自包含 Rust 单体内核。它在约 30,000 行纯 Rust 代码中实现了从物理内存管理、Sv39 分页、EXT4 文件系统、ELF 加载、183 个 Linux 兼容系统调用、信号处理、futex、epoll/inotify/fanotify 到用户态调度器的完整垂直栈。

**核心优势**：
- 极致的自包含性（零外部依赖）
- 广泛的 Linux ABI 覆盖（183 个 syscall、15 种 FD 类型、5 种 socket 域）
- 优雅的异步 syscall 调度架构（SyscallResult 枚举 + 统一等待队列）
- RISC-V 用户态全路径实现完整

**主要不足**：
- LoongArch 支持严重不足
- 单核架构无 SMP
- EXT4 只读
- 网络栈为内存模拟而非真实网络
- 调度器策略简单（纯 RR）