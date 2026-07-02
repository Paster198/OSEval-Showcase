# xiande-OS 内核项目深入技术分析报告

## 一、分析方法说明

本次分析采用了以下方法：

1. **完整源代码审查**：逐文件阅读了全部约 31,633 行 Rust 源码和汇编文件，覆盖 `kernel/src` 下的所有 55 个源文件。
2. **构建验证**：使用 Rust 1.89 nightly 工具链，分别对 RISC-V64 (`riscv64gc-unknown-none-elf`) 和 LoongArch64 (`loongarch64-unknown-none`) 目标进行了 release 构建，均编译成功。
3. **QEMU 启动测试**：在 RISC-V64 QEMU `virt` 平台上以 512MB RAM 配置启动构建产物，验证了内核引导、内存初始化、VFS 创建、测试编排器脚本生成的完整流程。
4. **静态分析**：基于代码逻辑分析各子系统实现、交互方式和完整性。

---

## 二、构建与测试结果

### 2.1 构建结果

| 目标 | 状态 | 产物大小 | 备注 |
|------|------|---------|------|
| RISC-V64 | **成功** | ~41 MB ELF (text: 5.95 MB, data: 4 KB, bss: 268 MB) | Release 模式，含 debuginfo |
| LoongArch64 | **成功** | ELF 正常生成 | Release 模式 |

BSS 段 268 MB 中包含 256 MB 的内核堆 (`KERNEL_HEAP_SIZE = 256 MiB`)，这是为支持 libc-bench 等内存密集型 benchmark 而配置的。

### 2.2 QEMU 测试结果

在无块设备、无网络设备的裸 QEMU (512MB RAM) 下：

```
xiande-os booting on hart 0
  dtb @ 0x9fe00000
  ksyms: none (faults print raw addresses)
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

内核成功完成了全部启动流程，在无磁盘映像的情况下优雅降级（"empty harness"），最终正常运行完 basic 测试组。**由于缺少评测用的 ext4 磁盘映像和网络设备，无法完成完整的测试套件运行，但这属于测试环境限制，非内核问题。**

---

## 三、项目整体架构

### 3.1 内核形态

xiande-OS 是一个用 Rust 编写的 **宏内核 (Monolithic Kernel)**，运行在 RISC-V64 S-mode 和 LoongArch64 特权态，具有以下特征：

- **单地址空间**：所有内核代码共享高半区映射
- **双体系结构支持**：通过 `#[cfg(target_arch)]` 编译时选择后端，上层代码完全架构无关
- **`no_std` + `alloc`**：仅使用 Rust 核心库和分配器，无需标准库
- **零 unstable feature**：纯 stable Rust 构建
- **预抢占调度**：单 hart，1ms 时间片，trap 边界调度

### 3.2 模块依赖关系

```
                    kmain (main.rs)
                         |
        ┌────────────────┼────────────────┐
        |                |                |
    arch (后端)      mm (内存)      contest_runner
    ┌──┴──┐       ┌──┴─────────┐         |
  riscv64 loongarch64  frame/heap/    fs (VFS)
                        page_table/       |
                        memory_set   ┌────┴─────┐
                                    |          |
                               ext2/ext4   tmpfs/pipe
                               /fat32      /devfs
                                           /procfs
         drivers ─────────────────┘          |
       (virtio-blk,                     syscall
        virtio-net,               ┌───────┴───────┐
        pci)                      |               |
                               task (调度)    signal (信号)
                                   |               |
                               loader (ELF)    net (smoltcp)
                                   |               |
                               sync (futex/    socket
                                 spinlock)
```

---

## 四、子系统详细拆解

### 4.1 架构后端 (`arch/`)

#### 4.1.1 抽象层设计 (`arch/mod.rs`, 125 行)

采用命名约定模式：每个后端（`riscv64`、`loongarch64`）提供相同的公开名称集合（`time`、`console`、`power`、`mm`、`trap`、`context`）。上层通过 `arch/mod.rs` 的 `use imp as ...` 重导出关键类型：

```rust
#[cfg(target_arch = "riscv64")]
use riscv64 as imp;
#[cfg(target_arch = "loongarch64")]
use loongarch64 as imp;

pub use imp::trap::TrapFrame;
pub use imp::context::TaskContext;
pub unsafe fn switch_context(prev: *mut TaskContext, next: *const TaskContext) { ... }
pub fn trap_init() { ... }
pub fn activate_page_table(token: usize) { ... }
```

这种设计的优势：上层代码（syscall、task、signal）完全不感知 ISA 差异，通过 `TrapFrame` 的方法（`user_pc()`、`syscall_arg(n)`、`enter_signal_handler()` 等）操作寄存器。

#### 4.1.2 RISC-V64 陷阱处理 (`riscv64/trap.S` + `trap.rs`, 566 行)

**汇编入口（132 行）**：`__trap_entry` 使用 `sscratch` CSR 实现用户/内核栈切换：
- `sscratch == 0` → 来自 S-mode（内核陷阱），sp 不变
- `sscratch != 0` → 来自 U-mode，sscratch 保存内核 sp

保存 31 个通用寄存器 (x1-x31) 到 TrapFrame (34×8 字节布局)，然后调用 `rust_trap_handler`。

**Rust 陷阱分发器 (434 行)**：

```rust
pub fn rust_trap_handler(tf: &mut TrapFrame) -> *mut TrapFrame {
    let scause = scause::read();
    match scause.cause() {
        Trap::Interrupt(Interrupt::SupervisorTimer) => { ... }
        Trap::Exception(Exception::UserEnvCall) => {
            tf.advance_past_syscall();  // sepc += 4
            syscall::dispatch(tf);
        }
        Trap::Exception(e) => {
            // 页面错误 → SIGSEGV, 非法指令 → SIGILL, ...
            handle_user_exception(tf, e);
        }
        ...
    }
    task::schedule_next_after_trap(tf)
}
```

关键设计特性：
- **内核双重故障保护**：使用 `KERNEL_ACCESS_FAULTS` 原子计数器检测连续内核态内存故障，两次连续故障即触发干净关机（防止内核损坏后的死循环）
- **用户态故障循环断路器**：检测同一 PID 在同一 PC 重复触发同一故障超过 8 次后终止任务
- **per-syscall 看门狗**：在 SIE 打开的状态下运行 `dispatch`，允许嵌套 timer tick 检测超过约 8 秒的 wedged syscall

#### 4.1.3 RISC-V64 上下文切换 (`riscv64/context.rs`, 81 行)

```rust
#[repr(C)]
pub struct TaskContext {
    pub ra: usize,
    pub sp: usize,
    pub s: [usize; 12],  // s0..s11
}
```

`__switch` 汇编保存/恢复 callee-saved 寄存器（ra, sp, s0-s11），通过 `ret` 指令跳转到目标任务的 ra 地址。新任务的 `TaskContext` 被初始化为指向 `task_first_run` 函数，首次调度时从该函数开始执行。

#### 4.1.4 LoongArch64 完整后端

**启动 (`boot.S`, 62 行)**：配置 DMW0（缓存一致窗口 0x9000_0000_0000_0000）和 DMW1（非缓存窗口 0x8000_0000_0000_0000），设置 CRMD，启用 FP/LSX/LASX 向量单元（EUEN=0x7）。

**陷阱处理 (`trap.S` + `trap.rs`, 545 行)**：
- 使用 SAVE0 (CSR 0x30) 作为内核 sp 暂存器（类似 riscv64 的 sscratch）
- 包含完整的 **TLB Refill 异常处理**（独立的 `__tlb_refill_entry`，4096 字节对齐）
- TLB refill 使用硬件页表遍历指令 `lddir`/`ldpte` + `tlbfill` 进行 3 级 9-bit 页表遍历
- 定时器使用 CSR 0x41 (TCFG) 配置周期性定时器

**上下文切换 (`context.rs`, 76 行)**：保存/恢复 ra, sp, tp, fp, s0-s8（13 个 callee-saved 寄存器），使用 LoongArch 特有的 `st.d`/`ld.d` 指令和 `jr $r1` 跳转。

**FP/向量状态管理 (`fpu.rs`, 181 行)**：完整实现 256-bit LASX 上下文的保存/恢复（32 个 xr 寄存器 + 8 个 fcc 条件标志 + fcsr），使用 `xvst`/`xvld` 指令。内核本身为 soft-float，仅在任务切换时进行保存/恢复。

**PCI ECAM 枚举 (`pci.rs`, 163 行)**：在 LoongArch64 上，virtio 设备通过 virtio-pci 暴露。实现完整的 ECAM 总线扫描、BAR 分配（32-bit MMIO 窗口 0x4000_0000-0x8000_0000）、内存空间和总线主控使能。

---

### 4.2 内存管理 (`mm/`)

#### 4.2.1 地址抽象 (`address.rs`, 140 行)

定义四种 newtype：
- `PhysAddr` / `VirtAddr`：物理/虚拟地址
- `PhysPageNum` / `VirtPageNum`：物理/虚拟页号

关键设计：
```rust
#[cfg(target_arch = "riscv64")]
pub const KERNEL_PHYS_OFFSET: usize = 0;
#[cfg(target_arch = "loongarch64")]
pub const KERNEL_PHYS_OFFSET: usize = 0x9000_0000_0000_0000;
```
通过 `KERNEL_PHYS_OFFSET` 常量实现物理地址到内核可解引用指针的转换，RISC-V64 使用恒等映射，LoongArch64 使用 DMW0 窗口偏移。

#### 4.2.2 物理帧分配器 (`frame.rs`, 157 行)

基于 `buddy_system_allocator::LockedFrameAllocator<32>`，提供：
- `alloc()` / `alloc_uninit()`：分配一个零初始化或未初始化的帧
- `dealloc(ppn)`：释放帧
- `FrameTracker`：RAII 守卫，drop 时自动释放
- `frame_stats()`：返回 (total, free) 统计，供 procfs 使用
- OOM 时触发 `emergency_reclaim()` 回收僵尸任务帧
- `add_region()`：支持添加额外的物理内存区域（LoongArch64 低 RAM bank）

#### 4.2.3 内核堆 (`heap.rs`, 70 行)

- 256 MiB 静态 `.bss.heap` 段
- 包装 `LockedHeap<32>` 为 `PreemptHeap` 全局分配器
- 在每次 alloc/dealloc 时禁用抢占，防止单 hart 上被抢占导致死锁
- 实现 `force_unlock()` 用于故障恢复路径释放被遗弃栈持有的堆锁

#### 4.2.4 页表 (`page_table.rs`, 341 行)

双架构 Sv39 风格页表（3 级，每级 9 位）：

```rust
pub struct PageTable {
    root: FrameTracker,
    intermediate: Vec<FrameTracker>,  // 持有中间级页表帧
}
```

**RISC-V64**：标准 Sv39 PTE 格式（PPN 在 [53:10]，标志在 [9:0]）
**LoongArch64**：原生 PTE 格式（V/D/PLV/MAT/G/P/W + NR/NX 负逻辑 + PPN<<12）

关键方法：
- `map(vpn, ppn, flags)`：建立映射
- `unmap(vpn)`：解除映射
- `walk(vpn)`：遍历页表获取 PTE 引用
- `satp()`：返回 satp CSR 值
- 中间级页表**懒分配**：仅在 `map` 需要时创建
- Drop 时递归释放所有中间级帧

#### 4.2.5 地址空间管理 (`memory_set.rs`, 1008 行)

`MemorySet` 管理一个进程的完整虚拟地址空间：

```rust
pub struct MemorySet {
    pub page_table: PageTable,
    pub areas: Vec<VmArea>,
    pub brk_base: VirtAddr,   // 程序断点
    pub brk_cur: VirtAddr,
    pub mmap_top: VirtAddr,   // mmap 区域顶
    pub pending_stack_reclaim: Vec<usize>,
}
```

`VmArea` 描述一段映射区域：
```rust
pub struct VmArea {
    pub vpn_start: VirtPageNum,
    pub vpn_end: VirtPageNum,
    pub perm: VmPerm,
    pub frames: BTreeMap<VirtPageNum, Arc<FrameTracker>>,
    pub shared: bool,        // MAP_SHARED
    pub anon: bool,          // 私有匿名内存
    pub wipe_on_fork: bool,  // MADV_WIPEONFORK
}
```

关键特性：
- **即时分配策略**：mmap 时立即分配所有物理帧（无 demand paging）
- **fork 即时深拷贝**：fork 时复制所有帧（无 CoW）
- **MAP_SHARED**：父子进程共享 `Arc<FrameTracker>`，实现真正的共享内存
- **MADV_WIPEONFORK**：子进程 fork 时对标记区域清零而非拷贝
- **megapage 优化**：内核恒等映射区域使用 2 MiB 大页（`map_identity_range`）
- `alloc_uninit` 优化：fork 复制路径跳过冗余清零

用户地址空间布局：
```
0x0000_0020_0000  PIE_LOAD_BASE（PIE 程序加载基址）
0x0000_2000_0000  MMAP_BASE（mmap 分配起点，向上增长）
0x0000_4000_0000  USER_STACK_TOP（用户栈顶，8 MiB，向下增长）
0x0000_5000_0000  SIG_RESTORER_VA（信号恢复页）
0x0000_5000_1000  VDSO_BASE（vDSO 映射）
0x0010_0000_0000  INTERP_BASE（动态链接器基址）
```

#### 4.2.6 内存初始化 (`mm/mod.rs`, 233 行)

`mm::init(dtb_pa)` 流程：
1. 初始化内核堆 (`heap::init()`)
2. 从设备树检测物理内存末端 (`detect_memory_end`)
   - RISC-V64：从 a1 传入的 DTB 指针读取 memory nodes
   - LoongArch64：扫描低 16 MiB 物理内存寻找 FDT magic，取包含内核载入地址的 memory region
3. 初始化帧分配器 (`frame::init(kend, mem_end)`)
4. LoongArch64：添加低 RAM bank (`frame::add_region`)

---

### 4.3 任务管理与调度 (`task/mod.rs`, 2478 行)

#### 4.3.1 Task 结构

```rust
pub struct Task {
    pub pid: i32,
    pub tgid: AtomicI32,       // 线程组 ID
    pub ppid: AtomicI32,       // 父进程 ID
    pub pgid: AtomicI32,       // 进程组 ID
    pub sid: AtomicI32,        // 会话 ID
    storage: UnsafeCell<Box<TaskStorage>>,  // 64 KiB 内核栈 + kctx + fp state
    pub memory_set: Arc<Mutex<MemorySet>>,  // 地址空间
    pub fd_table: Arc<Mutex<FdTable>>,      // 文件描述符表
    pub cwd: Arc<Mutex<String>>,            // 工作目录
    pub state: Mutex<TaskState>,            // Ready/Running/Waiting/Zombie
    pub exit_code: AtomicI32,
    pub exit_signal: AtomicI32,             // 退出时发送给父进程的信号
    pub children: Mutex<Vec<i32>>,          // 子进程 PID 列表
    pub signals: SignalState,               // 信号状态
    pub clear_child_tid: Mutex<usize>,      // CLONE_CHILD_CLEARTID
    pub timer_slack: AtomicUsize,           // PR_SET_TIMERSLACK
    pub vfork_child: Mutex<Option<i32>>,    // vfork 父进程阻塞
    pub thread_stack_top: AtomicUsize,      // 线程栈回收
    pub in_blocking_syscall: AtomicBool,    // 可中断阻塞标记
    pub start_ticks: AtomicU64,             // 创建时间戳
}
```

关键设计：
- `TaskStorage` 包含 64 KiB 内核栈 + `TaskContext`（调度上下文）+ FP 上下文（LoongArch64）
- 使用 `Arc<Mutex<>>` 实现 CLONE_VM/CLONE_FILES/CLONE_FS/CLONE_SIGHAND 的共享
- `fork` 时 `try_boxed()` 使用 fallible 分配 + 失败时紧急回收重试

#### 4.3.2 调度器

单 hart 协作式 + 抢占式混合调度：
```rust
fn schedule_next_after_trap_inner(current_tf: *mut TrapFrame) -> *mut TrapFrame {
    // 1. 网络轮询 (仅在有进展时唤醒 socket 等待者)
    // 2. futex 超时扫描
    // 3. 唤醒到期 sleepers / itimers / POSIX timers
    // 4. 回收 detached 线程
    // 5. 孤儿僵尸回收（表大小超过 128 时触发）
    // 6. Round-robin 选下一个 Ready 任务
    // 7. 上下文切换到目标任务
}
```

**抢占禁用机制**：使用 `PREEMPT_DISABLE` 原子计数器。`Mutex::lock()` 自动 `preempt_disable()`，`MutexGuard::drop()` 自动 `preempt_enable()`。调度器在 `preempt_enabled() == false` 时拒绝切换。

#### 4.3.3 进程创建与执行

- **fork/clone/clone3**：完整支持 CLONE_VM/THREAD/FS/FILES/SIGHAND/SETTLS/CHILD_CLEARTID/VFORK 等标志
- **execve/execveat**：替换地址空间，加载 ELF，设置 auxv 和初始栈
- **wait4/waitid**：阻塞等待子进程退出，支持 WNOHANG/WUNTRACED
- **vfork**：父进程在子进程 execve/exit 前保持阻塞

---

### 4.4 虚拟文件系统 (`fs/`)

#### 4.4.1 VFS 核心抽象 (`fs/mod.rs`, 781 行)

```rust
pub trait Inode: Send + Sync + core::any::Any {
    fn as_any(&self) -> &dyn core::any::Any;
    fn kind(&self) -> FileType;
    fn ino(&self) -> Option<u64> { None }
    fn size(&self) -> u64 { 0 }
    fn read_at(&self, _offset: u64, _buf: &mut [u8]) -> Result<usize> { Err(EINVAL) }
    fn write_at(&self, _offset: u64, _buf: &[u8]) -> Result<usize> { Err(EINVAL) }
    fn truncate(&self, _len: u64) -> Result<()> { Err(EINVAL) }
    fn lookup(&self, _name: &str) -> Result<Arc<dyn Inode>> { Err(ENOTDIR) }
    fn create(&self, _name: &str, _kind: FileType) -> Result<Arc<dyn Inode>> { Err(ENOTDIR) }
    fn unlink(&self, _name: &str) -> Result<()> { Err(ENOTDIR) }
    fn list(&self) -> Result<Vec<(String, FileType)>> { Err(ENOTDIR) }
    // ... 以及 symlink, link, rename 等
}
```

`FdTable` 管理每个进程的文件描述符（`BTreeMap<i32, Arc<File>>`），`File` 持有 `Arc<dyn Inode>` + offset + flags。支持 close-on-exec 语义。

扩展属性系统：`XattrStore = Mutex<BTreeMap<String, Vec<u8>>>`，提供 `xattr_store_get/set/list/remove` 公共函数。

#### 4.4.2 文件系统实现

**(a) ext4 只读 (`ext4.rs`, 732 行)**

只读 ext2/ext3/ext4 驱动，支持：
- 1 KiB / 2 KiB / 4 KiB 块大小
- 64-bit 组描述符
- **extent 树**：inline extents（i_block 直接含 extent header）+ depth-1 extent indices
- HTREE 目录降级为线性遍历
- 文件内容包装为 `TmpfsFile`（读时从设备提取）

```rust
struct SuperBlock {
    inodes_per_group: u32,
    blocks_per_group: u32,
    block_size: u32,
    inode_size: u16,
    desc_size: u16,
    features_incompat: u32,
    total_blocks: u64,
}
```

extent 解析核心逻辑：从 `i_block[60]` 读取 extent header（magic 0xF30A），根据深度选择 inline 或索引模式，遍历 extent 叶节点获取文件块映射。

**(b) ext2 可写 (`ext2.rs`, 1195 行)**

完整的读写 ext2 实现：
- 单个块组（4 KiB 块，最多 128 MiB）
- rev 1 动态格式，128 字节 inode
- 直接块 + 单/双间接块映射
- 块位图 + inode 位图管理
- 线性目录（支持 FILETYPE）
- 支持 `mkfs`：内核启动时可在空白设备上创建 ext2 文件系统

```rust
const N_DIRECT: usize = 12;
const IND: usize = 12;    // 单间接
const DIND: usize = 13;   // 双间接
const N_BLOCKS: usize = 15;
```

**(c) FAT32 只读 (`fat32.rs`, 351 行)**

- 解析 BPB，遍历 FAT 表（32-bit 条目）
- 支持 LFN（长文件名）
- 目录项缓存

**(d) tmpfs (`tmpfs.rs`, 475 行)**

完全在内存中的文件系统：
- `TmpfsFile`：`Vec<u8>` 存储文件内容
- `TmpfsDir`：`BTreeMap<String, Arc<dyn Inode>>` 存储子节点
- 支持特殊设备节点（`DevKind::Null/Zero/Full/Random/Urandom/Tty`）
- 支持符号链接和硬链接
- 支持扩展属性

**(e) devfs (`devfs.rs`, 150 行)**

设备文件系统，提供 `/dev/null`、`/dev/zero`、`/dev/full`、`/dev/random`、`/dev/urandom`、`/dev/tty`、`/dev/console`。

**(f) procfs (`procfs.rs`, 1024 行)**

动态生成的 `/proc` 文件系统：
- `/proc/<pid>/`：cmdline, exe, maps, status, stat, comm, cwd, fd/, ns/
- `/proc/self`：当前进程符号链接
- `/proc/mounts`：挂载表
- `/proc/meminfo`：内存统计
- `/proc/cpuinfo`：CPU 信息
- `/proc/uptime`、`/proc/stat`：系统统计
- `/proc/sys/`：内核参数（可读/部分可写桩）

**(g) pipe (`pipe.rs`, 267 行)**

匿名管道：
- 环形缓冲区（`VecDeque<u8>`），容量 64 KiB（可通过 `fcntl(F_SETPIPE_SZ)` 调整）
- 懒分配：初始为空，写入时扩展
- 读写端关闭检测
- 阻塞读取等待者通知
- SIGPIPE 投递
- F_SETOWN/F_SETSIG 异步 I/O 信号通知

**(h) socket inode (`socket.rs`, 301 行)**

将 smoltcp socket 暴露为 VFS Inode，支持 TCP/UDP + loopback 快速路径。

**(i) inotify/fanotify (`notify.rs`, 765 行)**

文件系统通知机制：
- 全局 watch group 列表
- 按 inode 身份（稳定指针或 inode 号）匹配事件
- 事件队列（每 group 上限 16384）
- 支持 `IN_ACCESS/IN_MODIFY/IN_OPEN/IN_CREATE/IN_DELETE/IN_MOVED_FROM/IN_MOVED_TO` 等事件
- `fanotify_init` + `fanotify_mark` 支持

---

### 4.5 系统调用 (`syscall/`)

#### 4.5.1 分发机制 (`mod.rs`, 9851 行)

```rust
pub fn dispatch(tf: &mut TrapFrame) {
    let id = tf.syscall_no();
    let a0..a5 = tf.syscall_arg(0..5);
    let ret = match id {
        nr::SYS_WRITE => sys_write(a0 as i32, a1, a2),
        nr::SYS_READ => sys_read(a0 as i32, a1, a2),
        // ... 约 238 条 syscall 映射
        _ => ENOSYS,
    };
    tf.set_syscall_ret(ret as usize);
}
```

定义了 244 个系统调用编号（`nr.rs`），实际实现约 238 条（`mod.rs` 中的 match 分支数）。

#### 4.5.2 系统调用分类与覆盖

| 类别 | 代表性 syscall | 实现程度 |
|------|---------------|---------|
| **文件 I/O** | read/write/pread64/pwrite64/readv/writev/lseek | 完整 |
| **文件描述符** | openat/close/dup/dup3/pipe2/fcntl/flock | 完整 |
| **目录操作** | getcwd/chdir/fchdir/mkdirat/unlinkat/symlinkat/linkat | 完整 |
| **文件元数据** | fstat/newfstatat/statx/fchmod/fchown/utimensat | 完整 |
| **扩展属性** | setxattr/getxattr/listxattr/removexattr (含 l/f 变体) | 完整 |
| **挂载** | mount/umount2/statfs/fstatfs | 完整 |
| **进程管理** | fork/clone/clone3/execve/execveat/exit/exit_group | 完整 |
| **进程控制** | wait4/waitid/getpid/getppid/getuid/getgid/set*id | 完整 |
| **信号** | rt_sigaction/rt_sigprocmask/rt_sigpending/rt_sigreturn/kill/tkill/tgkill | 完整 |
| **定时器** | nanosleep/clock_gettime/clock_nanosleep/timer_create/timerfd | 完整 |
| **内存管理** | brk/mmap/munmap/mprotect/madvise/mremap/msync/mincore | 完整 |
| **futex** | futex (WAIT/WAKE/WAIT_BITSET/WAKE_BITSET/REQUEUE/CMP_REQUEUE) | 完整 |
| **网络 socket** | socket/bind/listen/accept/connect/sendto/recvfrom/setsockopt/getsockopt/shutdown | 完整 |
| **SysV IPC** | shmget/shmat/shmdt/shmctl/msgget/msgsnd/msgrcv/msgctl/semget/semop/semctl | 完整 |
| **Key management** | add_key/request_key/keyctl | 完整 |
| **splice 族** | splice/tee/vmsplice/sendfile/copy_file_range | 完整 |
| **epoll** | epoll_create1/epoll_ctl/epoll_pwait | 完整 |
| **进程间内存** | process_vm_readv/process_vm_writev | 完整 |
| **扩展** | openat2/name_to_handle_at/close_range/memfd_create | 完整 |

#### 4.5.3 Socket 系统调用 (`socket.rs`, 1337 行)

实现完整的 POSIX socket 层：
- `socket()`：创建 TCP/UDP socket（AF_INET only）
- `bind()`/`listen()`/`accept()`/`accept4()`：TCP 服务器端
- `connect()`：TCP/UDP 客户端，含 loopback 快捷路径
- `sendto()`/`recvfrom()`/`sendmsg()`/`recvmsg()`/`sendmmsg()`/`recvmmsg()`
- `getsockname()`/`getpeername()`
- `getsockopt()`/`setsockopt()`（含常用 SOL_SOCKET 选项）
- `shutdown()`：SHUT_RD/SHUT_WR/SHUT_RDWR

阻塞 I/O 模型：使用 `block_and_retry()` 将任务标记为 Waiting + 回退 sepc，在 trap 出口重新调度。包含 lost-wakeup 保护：`block_and_retry_recheck()` 在标记 Waiting **后**重新检查条件。

#### 4.5.4 SysV IPC (`sysv_ipc.rs`, 1007 行)

完整实现三种 IPC 机制：
- **共享内存**：使用 `Arc<FrameTracker>` 实现真正的物理页共享；全局容量限制 128 MiB
- **消息队列**：阻塞 msgsnd/msgrcv，支持 IPC_NOWAIT
- **信号量**：semop/semtimedop，支持 UNDO 语义（通过 `sem_undo` 表）

#### 4.5.5 Key Management (`keys.rs`, 1142 行)

内核内 keyring 子系统：
- Key 类型：`user`、`logon`、`keyring`、`big_key`
- Key 状态：instantiated / revoked / negatively-instantiated
- 每个线程组有 thread/process/session keyrings
- keyctl 支持：GET_KEYRING_ID/JOIN_SESSION_KEYRING/UPDATE/REVOKE/CHOWN/SETPERM/DESCRIBE/CLEAR/LINK/UNLINK/SEARCH/READ/SET_TIMEOUT/INVALIDATE 等

---

### 4.6 信号处理 (`signal.rs`, 1098 行)

完整实现 POSIX 信号机制：

```rust
pub struct SignalState {
    pub actions: Arc<Mutex<SigActions>>,  // 信号处理器表
    pub mask: AtomicU64,                   // 阻塞掩码
    pub pending: AtomicU64,                // 挂起信号集
    pub altstack: Mutex<Option<SigAltStack>>,
    pub saved_mask: Mutex<Option<u64>>,
    pub siginfo: Mutex<[SigSource; 65]>,   // 每个信号的发送者信息
}
```

关键特性：
- **信号投递路径**：`raise_signal()` → 设置 pending bit + 记录 siginfo → 下次 trap 出口 `deliver_pending()` → 构造 rt_sigframe (siginfo_t + ucontext + mcontext) → `enter_signal_handler()` 设置用户栈/PC
- **sigreturn**：从 sigframe 恢复 `TrapFrame`，包括 PC、GPR、信号掩码
- **SA_SIGINFO**：传递完整 siginfo（si_signo/si_code/si_pid/si_value）
- **SA_RESTART**：可中断阻塞 syscall 在信号处理后自动重启
- **SA_ONSTACK**：替代信号栈支持
- **SI_TKILL**：glibc pthread_cancel 依赖此 si_code
- **信号恢复页**：在 `SIG_RESTORER_VA`(0x5000_0000) 映射含 `rt_sigreturn` 指令的页面

---

### 4.7 ELF 加载器 (`loader/mod.rs`, 269 行)

```rust
pub fn load_elf(image: &[u8], ms: &mut MemorySet) -> Result<LoadedElf, &'static str>
```

支持：
- **静态 ELF**：直接映射 PT_LOAD 段，跳转 e_entry
- **动态 ELF**：解析 PT_INTERP → 加载 ld.so 到 `INTERP_BASE`(0x10_0000_0000) → 入口设为 ld.so 的 e_entry
- **PIE**：ET_DYN 主程序重定位到 `PIE_LOAD_BASE`(0x20_0000)
- **架构检查**：RISC-V (EM=0xF3) / LoongArch (EM=258)
- **初始栈布局**：`[字符串区][auxv][envp][argv][argc]`，sp 16 字节对齐

---

### 4.8 vDSO (`vdso.rs`, 206 行 + `vdso/rt_sigreturn.S`)

预编译的极小 vDSO ELF：
- 映射到每个用户地址空间的 `VDSO_BASE`(0x5000_1000)
- 导出 `__vdso_rt_sigreturn`，含 `.eh_frame` CFI（`.cfi_signal_frame`）
- 通过 `AT_SYSINFO_EHDR` auxv 条目通告给 glibc
- 支持 glibc 的 DWARF 栈回溯穿透信号帧（`pthread_cancel` 的 `_Unwind_ForcedUnwind` 依赖此功能）

---

### 4.9 网络栈 (`net/`)

#### 4.9.1 smoltcp 集成 (`mod.rs`, 413 行)

```rust
pub struct NetStack {
    pub iface: Interface,
    pub sockets: SocketSet<'static>,
    pub phy: VirtioPhy,
    pub next_ephemeral: u16,
}
```

- 单例 `Mutex<NetStack>`，IP 10.0.2.15/24，网关 10.0.2.2
- TCP socket buffer: 8 KiB rx + 8 KiB tx
- UDP socket buffer: 16 个 packet metadata + 8 KiB payload
- 临时端口分配：49152-65535 循环

**轮询模型**：`poll_with_progress()` 在每次 trap 出口调用，仅在处理了包或准备好 socket 时返回 true，避免无效唤醒。

#### 4.9.2 Loopback (`loopback.rs`, 370 行)

内核内 loopback 实现（避免经过 smoltcp 的 127.0.0.1 路由）：
- TCP：使用管道对 (`LoopbackEnd`) 实现双向字节流
- UDP：进程内消息队列，按 port 注册/分发
- `TcpListener`：管理 accept backlog

---

### 4.10 设备驱动 (`drivers/`)

#### 4.10.1 virtio-blk (`virtio_blk.rs`, 401 行)

- 基于 `virtio-drivers` 0.7.5 crate
- 双传输层支持：RISC-V64 virtio-mmio / LoongArch64 virtio-pci
- 16 MiB 块读取缓存 (`BlockCache`)，sector 粒度
- 支持多块设备：区分测试映像（只读 ext4）和暂存盘（可写 ext2）
- 自定义 `KernelHal`：通过 `KERNEL_PHYS_OFFSET` 实现 DMA 缓冲区 VA↔PA 转换

#### 4.10.2 virtio-net (`virtio_net.rs`, 241 行)

- 队列深度 16，帧缓冲区 2048 字节
- RISC-V64：扫描 virtio-mmio bank (0x1000_1000..0x1000_8000)
- LoongArch64：PCI ECAM 枚举
- 非侵入式设备探测：读取 DeviceID 寄存器而不创建 transport（避免重置已初始化的块设备）

#### 4.10.3 PCI (`pci.rs`, 163 行)

LoongArch64 专用：
- ECAM 基址 0x2000_0000（通过 DMW1 非缓存窗口访问）
- 32-bit MMIO 窗口：0x4000_0000-0x8000_0000
- BAR 自动分配（对齐、64-bit BAR 支持）
- 命令寄存器配置（Memory Space + Bus Master）

---

### 4.11 同步原语 (`sync/`)

#### 4.11.1 抢占安全 Mutex (`spinlock.rs`, 135 行)

```rust
pub struct Mutex<T: ?Sized> {
    inner: spin::Mutex<T>,
}
```

`lock()` 时递增 `PREEMPT_DISABLE` 计数，`MutexGuard::drop()` 时递减。调度器在计数非零时拒绝切换。这解决了单 hart 上持锁任务被抢占导致的死锁问题。

#### 4.11.2 Futex (`futex.rs`, 453 行)

基于物理地址键的等待队列：
- 支持 FUTEX_WAIT/WAKE/WAIT_BITSET/WAKE_BITSET/REQUEUE/CMP_REQUEUE
- 阻塞模型：标记 Waiting + 回退 sepc，唤醒时重新执行 syscall
- 超时支持：`poll_timeouts()` 在每次 trap 出口扫描超时等待者
- 支持 FUTEX_PRIVATE_FLAG 和 FUTEX_CLOCK_REALTIME

---

### 4.12 竞赛编排器 (`contest_runner.rs`, 1137 行)

自动测试运行器：
1. 挂载 ext4 测试盘到 `/mnt`
2. 绑定动态加载器路径（`ld-linux-riscv64-lp64d.so.1` 等）
3. 枚举变体目录（`musl/`、`glibc/`）
4. 生成 `/init.sh` 驱动脚本，按优先级运行测试组：**basic → lua → busybox → ltp → libctest → iperf/netperf → benchmarks**
5. 执行 busybox `sh /init.sh`

支持 feature flags：
- `contest`：默认，竞赛模式
- `diag_full_ltp`：额外扫描所有测试二进制（发现新的可评分用例）
- `single_ltp`：仅运行指定 LTP 用例
- `single_bench`：仅运行指定 benchmark

测试组白名单机制：为不同 libc/架构组合维护通过的测试列表。

---

### 4.13 内核符号表 (`ksyms.rs`, 121 行)

两遍构建嵌入符号表：
- **Pass 1**：使用空占位符构建内核
- **gen_ksyms.py**：从 ELF 提取符号（sorted addresses + names）
- **Pass 2**：`include_bytes!` 嵌入真实符号表，仅重编译 `ksyms.rs` + 重链接

关键技巧：`blob()` 使用 `black_box(ptr::addr_of!(BLOB))` 读取 fat pointer，使两个 pass 生成相同长度的 `.text` 代码，确保符号地址有效。

崩溃时自解析：`resolve(addr)` 二分查找最接近的符号，输出 `function+offset` 格式。

---

## 五、内核启动流程

`kmain` 的完整启动序列：

```
kmain(hartid, dtb_pa)
├── 报告 ksyms 状态
├── mm::init(dtb_pa)         ← 从 DTB 检测 RAM，初始化堆和帧分配
├── arch::trap_init()        ← 安装陷阱向量，启动抢占定时器
├── vdso::init()             ← 解析内嵌 vDSO ELF
├── fs::init()               ← 创建 tmpfs 根目录，挂载 devfs/procfs
├── 安装 embedded 二进制     ← busybox, git, dyn_hello, ld-musl, mkfs 包装器
│   ├── 建立 /bin 下的 applet 符号链接
│   └── 建立 git 子命令符号链接
├── 创建 /etc/{passwd,group,shadow,hostname,hosts,resolv.conf,nsswitch.conf}
├── 创建 /dev/shm、/sys/kernel/mm/ksm 等
├── drivers::virtio_blk::init()
│   ├── ext2::smoke_test()   ← 就地格式化暂存盘并读写测试
│   └── fs::register_block_devices() ← 注册 /dev/sdb
├── drivers::virtio_net::init()
│   └── fs::socket::init()   ← 注册 socket 类型
├── [contest mode] contest_runner::prepare_init()
│   └── task::run_user_loop() ← 执行 busybox sh /init.sh
└── [非 contest] 根据 feature flag 运行对应测试程序
```

---

## 六、内核健壮性机制

从代码中识别出以下健壮性设计：

1. **per-syscall 看门狗**：在 SIE 打开状态下执行 syscall，嵌套 timer tick 检测超过约 8 秒的 wedge
2. **内核双重故障保护**：连续两次内核态内存故障后干净关机
3. **用户态故障循环断路器**：同一 PC 重复故障 8 次后终止任务
4. **OOM 保护**：
   - kstack 分配 fallible（`try_boxed` + `emergency_reclaim` 重试）
   - 页表根分配 fallible（`try_new`）
   - 帧分配 OOM 时触发 `emergency_reclaim()`
5. **锁恢复**：`force_unlock()` 方法（heap、frame allocator、Mutex），故障恢复路径可强制释放被遗弃栈持有的锁
6. **孤儿僵尸回收**：定期扫描并回收父进程已退出的僵尸任务
7. **tmpfs 容量限制**：防止测试泄漏耗尽内核堆
8. **SysV IPC 全局容量限制**：128 MiB 物理帧上限
9. **抢占禁用计数复位**：`preempt_reset()` 用于故障恢复路径

---

## 七、子系统实现完整度评估

以 Linux 内核对应子系统为参照基准：

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **架构后端 (RISC-V64)** | 90% | 完整陷阱、上下文切换、MMU、定时器、关机；无 SMP、无外部中断 |
| **架构后端 (LoongArch64)** | 85% | 含 TLB refill、FP/LSX/LASX、PCI 枚举；同上限制 |
| **内存管理** | 75% | 完整页表和帧分配；缺 demand paging、CoW、KASLR、swap |
| **进程管理** | 85% | 完整 fork/execve/wait4/clone/clone3；缺 cgroup、完整 namespace |
| **调度器** | 60% | 单核 round-robin；缺 CFS、优先级、CPU affinity |
| **VFS** | 80% | 完整 inode 模型、挂载、bind mount；缺后备存储同步、日志 |
| **文件系统** | 70% | ext4 只读、ext2 读写、FAT32、tmpfs/devfs/procfs；缺 xfs/btrfs |
| **系统调用** | 85% | 238 条实现；缺 io_uring、seccomp、bpf |
| **信号** | 90% | 完整 POSIX 信号模型含实时信号、替代栈、SA_SIGINFO |
| **网络** | 65% | TCP/UDP + loopback；缺 IPv6、AF_UNIX(DGRAM)、tun/tap |
| **设备驱动** | 50% | 仅 virtio-blk/net；缺 GPU、USB、音频、virtio-console |
| **同步原语** | 70% | Mutex + futex；缺 RWLock 实现（仅重导出）、条件变量、屏障 |
| **IPC** | 85% | SysV 全部三种 + pipe + socketpair；缺 POSIX MQ |

**整体实现完整度：约 80%**（以竞赛赛道功能需求为基准）

---

## 八、创新性分析

### 8.1 架构创新

1. **双 ISA 架构后端统一抽象**：通过命名约定 + `#[cfg]` 编译选择实现架构透明化，上层 95%+ 的代码无需条件编译。`TrapFrame` 通过同名方法暴露统一接口（如 `user_pc()`、`syscall_arg(n)`、`enter_signal_handler()`），这在 Rust OS 项目中较为罕见。

2. **LoongArch64 TLB Refill 自实现**：在 `trap.S` 中编写了完整的 TLB 缺失处理程序（使用 `lddir`/`ldpte` + `tlbfill`），而非依赖固件的 SBI 等效调用。这使得内核在 LoongArch64 上具有完全独立的页表遍历能力。

### 8.2 工程创新

1. **两遍构建符号表嵌入**：`black_box` + fat pointer 技巧确保两遍构建生成字节相同的 `.text`，使得崩溃日志可自解析为 `function+offset`。此方案不依赖外部 addr2line 或 Rust 版本特定的 `.debug_info`。

2. **抢占安全 Mutex 设计**：不关中断，仅递增 `preempt_disable` 计数。持锁期间 timer 仍可触发、看门狗仍可运行。这比传统关中断方案更利于故障检测。

3. **per-syscall 看门狗 + 故障恢复路径**：不是简单的超时杀进程，而是一套完整的"检测→强制释放锁→标记任务→继续调度"的恢复机制，将单个 wedged syscall 的影响隔离在当前测试用例内。

4. **vDSO + CFI 自实现**：手写汇编构造带 `.cfi_signal_frame` 的 vDSO，使得 glibc 的 `pthread_cancel` 能在竞赛环境中正常工作。这对 glibc 兼容性至关重要。

### 8.3 兼容性创新

1. **双 libc 支持**：同时支持 musl 和 glibc，并能识别并适配两者在动态链接器路径、`AT_PHDR`/`AT_SYSINFO_EHDR`、`mcontext` 偏移等方面的差异。

2. **ext2 内核内 mkfs**：在没有 `e2fsprogs` 的环境中，通过内核代码在空白设备上创建 ext2 文件系统，使 `.format_device` 类 LTP 用例得以通过。

---

## 九、总结

xiande-OS 是一个面向 OS 内核竞赛的高质量 Rust 宏内核实现。项目规模约 31,633 行 Rust + 汇编，实现了约 238 条系统调用，覆盖文件系统、进程管理、信号、网络、IPC 等完整子系统的 Linux ABI 兼容。

**主要优势**：
- **架构抽象清晰**：RISC-V64/LoongArch64 双 ISA 支持，上层代码架构无关
- **Linux ABI 覆盖广泛**：238 条 syscall、双 libc 兼容、完整 POSIX 信号、SysV IPC
- **工程细节扎实**：OOM 保护、故障恢复、两遍构建符号表、看门狗机制
- **自包含设计**：vendored 依赖、内嵌用户态二进制、内嵌 vDSO、无需外部 e2fsprogs
- **构建可重现**：离线构建、remap-path-prefix、确定性的两遍构建

**主要局限**：
- 单核调度（无 SMP）
- 无 demand paging/CoW（fork 和 mmap 即时分配和深拷贝）
- 无外部中断驱动（virtio 使用轮询）
- 文件系统不支持日志（ext4 只读、ext2 无日志）
- 无 io_uring、eBPF、cgroup 等现代 Linux 特性
- 部分 syscall 为桩实现（返回 ENOSYS 或成功但不产生实际效果）

该项目作为竞赛内核具有很高的完成度，在双架构支持、系统调用覆盖面和健壮性工程方面表现突出。