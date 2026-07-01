# NexusOS 内核项目深度技术报告

## 1. 项目概述

**NexusOS** 是一个基于 Rust 语言开发的多核、异步、框内核（Framekernel）架构的操作系统内核，版本号为 0.11.3。项目基于 [Asterinas](https://github.com/asterinas/asterinas) 进行二次开发，采用 MPL 2.0 许可证。项目主要面向操作系统竞赛（OS Comp），目标是在 RISC-V 64 和 LoongArch 64 架构上运行 Linux 用户态程序。

### 1.1 代码规模

| 模块 | Rust 源文件数 |
|------|--------------|
| kernel（内核主程序） | 157 |
| ostd（操作系统标准库） | 387 |
| osdk（构建工具） | 47 |
| **总计（不含 vendor）** | **582** |

### 1.2 架构设计

NexusOS 采用分层架构：
- **ostd（操作系统标准库）**：提供底层硬件抽象、内存管理、任务调度、中断处理等核心服务，相当于 Asterinas 中的 OSTD 层。
- **kernel（内核主程序）**：在 ostd 之上实现用户态接口，包括系统调用、进程/线程管理、虚拟内存、文件系统等。
- **osdk（OS Development Kit）**：独立的构建工具，用于编译、运行和调试内核。

---

## 2. 子系统详细分析

### 2.1 系统调用子系统

**位置**：`kernel/src/syscall.rs` 及 `kernel/src/syscall/` 目录

**实现完整度**：中等（约 55 个系统调用，覆盖竞赛核心需求）

#### 已实现的系统调用清单

| 类别 | 系统调用 |
|------|----------|
| **进程管理** | `clone`, `wait4`, `exit`, `exit_group`, `execve`, `getpid`, `getppid`, `gettid`, `set_tid_address` |
| **文件操作** | `openat`, `close`, `read`, `write`, `lseek`, `pread64`, `pwrite64`, `readv`, `writev`, `preadv`, `pwritev`, `preadv2`, `pwritev2` |
| **目录操作** | `getdents64`, `mkdirat`, `unlinkat`, `linkat`, `renameat2`, `getcwd`, `chdir`, `readlinkat` |
| **文件状态** | `fstat`, `newfstatat`, `statx`, `ftruncate` |
| **文件系统** | `mount`, `umount2`, `ioctl` |
| **文件描述符** | `dup`, `dup3`, `pipe2`, `splice`, `copy_file_range` |
| **内存管理** | `brk`, `mmap`, `munmap`, `mprotect` |
| **时间** | `clock_gettime`, `clock_nanosleep`, `nanosleep`, `gettimeofday`, `times` |
| **调度** | `sched_yield` |
| **信号（桩）** | `rt_sigprocmask`, `rt_sigaction`, `tgkill` |
| **凭证（桩）** | `getuid`, `geteuid`, `getgid`, `getegid` |
| **其他** | `uname`, `set_robust_list`, `get_robust_list`, `prlimit64`, `getrandom` |

#### 实现细节

系统调用分发采用异步模式，所有处理函数均为 `async fn`，返回 `Result<ControlFlow<i32, Option<isize>>>`：

```rust
pub async fn syscall(state: &mut ThreadState, context: &mut UserContext) -> Result<ControlFlow<i32, Option<isize>>> {
    match context.syscall_number() as c_long {
        SYS_clone => do_clone(state, context).await,
        SYS_wait4 => do_wait4(state, context).await,
        // ... 约 55 个分支
        num => {
            warn!("syscall not implemented: number={}", num);
            Err(errno_with_message(Errno::ENOSYS, "syscall not implemented"))
        }
    }
}
```

LoongArch 架构通过条件编译补充了系统调用号差异（如 `SYS_fstat = 80`、`SYS_mmap = 222`）。

信号子系统（`signal.rs`）仅为桩实现，存储信号屏蔽字但不实现信号派发语义。凭证查询（UID/GID）统一返回 0，满足 glibc 初始化需求。

---

### 2.2 进程/线程管理子系统

**位置**：`kernel/src/thread/` 目录

**实现完整度**：中等偏高（核心生命周期管理完整，高级特性缺失）

#### 核心数据结构

```rust
pub struct ThreadState {
    pub task: Arc<Task>,
    pub thread_group: Arc<ThreadGroup>,
    pub shared_info: Arc<ThreadSharedInfo>,
    pub process_vm: Arc<ProcessVm>,
    pub fd_table: Arc<FdTable>,
    pub cwd: PathBuf,
    pub robust_list_head: usize,
    pub robust_list_len: usize,
    pub sig_mask: u64,
    pub user_brk: usize,
}

pub struct ThreadSharedInfo {
    pub tid: u64,
    parent: Weak<ThreadSharedInfo>,
    children: GuardRwArc<Vec<Arc<ThreadSharedInfo>>>,
    lifecycle: Lifecycle,
    pub cpu_times: CpuTimes,
    pub start_ticks: u64,
}
```

#### clone 实现

`clone` 系统调用按 `CLONE_THREAD` 标志分治：
- **线程克隆**（`CLONE_THREAD` 置位）：共享地址空间、线程组、FD 表（按 `CLONE_FILES` 决定共享或复制）。
- **进程克隆**（`CLONE_THREAD` 未置位）：按 `CLONE_VM` 决定是否共享地址空间，创建新的线程组。

支持的 clone 标志：`CLONE_VM`, `CLONE_FS`, `CLONE_FILES`, `CLONE_SIGHAND`, `CLONE_PARENT`, `CLONE_THREAD`, `CLONE_SETTLS`, `PARENT_SETTID`, `CHILD_CLEARTID`, `CHILD_SETTID`。

#### execve 实现

`do_execve` 完成以下工作：
1. 从用户空间读取路径、argv、envp。
2. 处理相对路径（拼接 cwd）。
3. 调用 `load_elf_to_vm` 加载 ELF 到进程地址空间。
4. 更新用户上下文（IP、SP）。
5. 处理 `FD_CLOEXEC` 标志。

#### exit/wait4 实现

- `do_exit`：支持单线程退出和 `exit_group`（组内所有线程置 zombie）。
- `do_wait4`：支持 `pid == -1`（等待任意子进程）和指定 pid，支持 `WNOHANG`。通过 `Lifecycle` 的 `WaitQueue` 实现阻塞等待。

#### 生命周期管理

```rust
pub struct Lifecycle {
    state: AtomicU8,        // Running / Zombie
    exit_code: AtomicI32,
    exit_wait_queue: WaitQueue,
}
```

#### 缺失功能

- 无信号派发机制（仅有存储）
- 无 futex 实现
- 无 namespace/cgroup 支持
- 无完整的资源限制（rlimit 仅桩实现）
- 线程组 ID（tgid）与 tid 的区分不够严格

---

### 2.3 ELF 加载器

**位置**：`kernel/src/thread/loader/` 目录

**实现完整度**：中等

ELF 加载分为三个模块：
- `elf_file.rs`：ELF 文件解析
- `elf_image.rs`：ELF 镜像管理
- `elf_mapper.rs`：将 ELF 段映射到虚拟地址空间

加载流程：
1. 从 VFS 读取 ELF 文件。
2. 解析 ELF 头和程序头。
3. 为每个 LOAD 段创建 VMO 并映射到 VMAR。
4. 设置入口点和用户栈顶。
5. 写入辅助向量（AuxVec）和初始栈。

---

### 2.4 虚拟内存子系统

**位置**：`kernel/src/vm/` 目录

**实现完整度**：中等偏高

#### 核心抽象

采用源自 Zircon 的 VMAR/VMO 模型：
- **VMAR（Virtual Memory Address Region）**：管理用户地址空间的能力。
- **VMO（Virtual Memory Object）**：表示一组内存页的能力。

```rust
pub struct ProcessVm {
    root_vmar: Vmar<Full>,
    heap: Heap,
    init_stack: InitStack,
}
```

#### VMAR 实现

VMAR 使用 `IntervalSet` 管理映射区间，支持：
- 动态能力（`Vmar<Rights>`）和静态能力（`Vmar<R: TRights>`）两种模式。
- 映射创建、 resizing、清除。
- Fork 时复制页表（`fork_from`）。

#### mmap 实现

支持：
- 匿名映射（`MAP_ANONYMOUS`）
- 文件映射（从 VFS 读取文件内容到 VMO）
- `MAP_FIXED`、`MAP_SHARED`、`MAP_PRIVATE`
- 权限检查（读/写/执行）

#### brk 实现

通过 `Heap` 结构管理堆区，支持动态扩展和收缩。

#### mprotect/munmap

均已实现，支持权限修改和映射解除。

#### 页错误处理

在 RISC-V 架构中实现了用户页错误处理（`handle_user_page_fault`），支持按需映射（demand paging）。内核页错误会检查是否在线性映射范围内。

---

### 2.5 文件系统子系统

**位置**：`kernel/comps/vfs/` 和 `kernel/comps/another_ext4/`

**实现完整度**：较高（VFS 抽象完整，ext4 实现基本可用）

#### VFS 架构

```
VfsManager
├── ProviderRegistry    # 文件系统类型注册
├── MountRegistry       # 挂载点管理（最长前缀匹配）
├── VnodeCache          # Vnode 缓存
└── DentryCache         # 目录项缓存
```

核心 trait 层次：
- `FileSystemProvider`：文件系统工厂
- `FileSystem`：文件系统实例
- `Vnode`：虚拟节点（最小公共能力）
- `FileCap` / `DirCap` / `SymlinkCap`：扩展能力
- `FileHandle` / `DirHandle`：打开后的句柄

所有 VFS 操作均为异步（`async`），使用 `impl Future` 返回类型。

#### 静态分发

通过 `static_dispatch` 模块实现类型擦除，将不同文件系统的 `Vnode`、`FileSystem` 等统一为 `SVnode`、`SFileSystem` 等枚举类型，避免动态分发的性能开销。

#### ext4 实现

`another_ext4` 是一个纯 Rust 的 ext4 文件系统实现，包含：

| 模块 | 功能 |
|------|------|
| `ext4_defs/` | 超级块、inode、块组描述符、目录项、extent、xattr 等磁盘结构定义 |
| `ext4/low_level.rs` | 底层块 I/O、inode 读写 |
| `ext4/high_level.rs` | 路径查找、文件创建/删除 |
| `ext4/rw.rs` | 文件读写 |
| `ext4/extent.rs` | extent 树管理 |
| `ext4/alloc.rs` | 块和 inode 分配 |
| `ext4/dir.rs` | 目录操作 |
| `ext4/link.rs` | 硬链接 |
| `ext4/journal.rs` | 日志（仅桩实现，`trans_start`/`trans_abort` 为空函数） |

ext4 实现支持：
- 超级块解析与校验
- inode 读写（含校验和）
- 目录查找与创建
- 文件读写
- extent 树遍历
- 块/inode 位图分配
- 块缓存（可选 feature）

**缺失**：日志（journal）仅为桩实现，不支持崩溃恢复。

#### DevFS 实现

内存中的设备文件系统，支持动态注册字符设备：
- `/dev/serial`：串口输出设备
- `/dev/null`：空设备
- `/proc/interrupts`：中断统计设备

#### 挂载配置

```rust
vfs_manager.mount(None, "/", "ext4", Default::default()).await;
vfs_manager.mount(None, "/dev", "devfs", Default::default()).await;
vfs_manager.mount(None, "/proc", "devfs", Default::default()).await;
```

#### Pipe 实现

`kernel/comps/vfs/src/impls/pipe.rs` 实现了环形管道（`RingPipe`），支持 `pipe2` 和 `splice` 系统调用。

---

### 2.6 文件描述符表

**位置**：`kernel/src/thread/fd_table.rs`

**实现完整度**：中等

```rust
pub struct FdTable {
    map: RwLock<BTreeMap<u32, FdEntry>>,
    next: AtomicU32,
    capacity: usize,  // 默认 1M
}

pub struct FdEntry {
    pub obj: FdObject,    // File 或 Dir
    pub flags: FileOpen,
    pub pos: u64,         // 文件偏移
}
```

支持：
- 标准 I/O 初始化（stdin/stdout/stderr）
- FD 分配（从 `next` 开始扫描空洞）
- dup/dup2/dup3
- FD_CLOEXEC 处理
- 表复制（fork 时深拷贝）

**注意**：dup 后文件偏移不共享（每个 FD 独立维护 `pos`），这与 Linux 语义不完全一致。

---

### 2.7 内存管理子系统（ostd）

**位置**：`ostd/src/mm/` 目录

**实现完整度**：高（继承自 Asterinas，较为成熟）

#### 物理页帧分配器

基于 `buddy_system_allocator` 的伙伴系统分配器：

```rust
pub struct FrameAllocOptions {
    zeroed: bool,
}
```

支持单页分配（`alloc_frame`）和连续多页分配（`alloc_segment`），可选零初始化。

#### 页表管理

支持用户模式（`UserMode`）和内核模式（`KernelMode`）页表，提供：
- 游标式页表遍历（`Cursor`/`CursorMut`）
- 多级页表节点管理
- TLB 刷新控制
- 启动阶段页表（`boot_pt`）

#### 虚拟地址空间

```rust
pub const MAX_USERSPACE_VADDR: Vaddr = 0x0000_8000_0000_0000 - PAGE_SIZE;
pub const KERNEL_VADDR_RANGE: Range<Vaddr> = 0xffff_8000_0000_0000..0xffff_ffff_ffff_0000;
```

#### 地址转换

提供多种 VA→PA 转换路径：
- `linear_v2p`：线性直映区 O(1) 转换
- `kspace_v2p`：内核空间页表遍历
- `current_v2p`：当前地址空间转换
- `register_v2p`：基于 CPU 当前页表根转换（仅 boot 阶段）

#### 堆分配器

基于 slab 分配器（`slab_allocator`），在 `ostd/src/mm/heap_allocator/` 中实现。

#### DMA 支持

提供 `DmaCoherent` 和 `DmaStream` 两种 DMA 模式。

---

### 2.8 任务调度子系统

**位置**：`ostd/src/task/` 目录

**实现完整度**：高

#### 调度器架构

基于 `maitake` 异步运行时的多核调度器：

```rust
pub struct Core {
    scheduler: &'static StaticScheduler,
    id: usize,
    rng: rand_xoshiro::Xoroshiro128PlusPlus,  // 工作窃取随机选择
}

struct Runtime {
    cores: [InitOnce<StaticScheduler>; MAX_CORES],  // 最多 512 核
    injector: scheduler::Injector<&'static StaticScheduler>,
}
```

#### 核心特性

- **每核调度器**：每个 CPU 核心拥有独立的 `StaticScheduler` 实例。
- **全局注入器**：新任务通过全局 `injector` 分发到各核心。
- **工作窃取**：空闲核心从其他核心随机窃取任务，使用 `Xoroshiro128PlusPlus` 随机数生成器选择目标核心。
- **抢占支持**：通过 `disable_preempt` / `DisabledPreemptGuard` 实现抢占禁用。
- **定时器集成**：与 `maitake::time::Timer` 集成，支持定时唤醒。

#### 任务模型

```rust
pub struct Task {
    data: Box<dyn Any + Send + Sync>,
    local_data: ForceSync<Box<dyn Any + Send>>,
    user_space: Option<Arc<UserSpace>>,
}
```

每个任务关联可选的 `UserSpace`（包含 `VmSpace` 和 `UserContext`），支持用户态执行。

#### 主循环

```rust
pub fn run(&mut self) {
    loop {
        if self.tick() { continue; }
        if !self.is_running() { return; }
        crate::arch::wait_for_interrupt();
    }
}
```

---

### 2.9 中断与异常处理

**位置**：`ostd/src/trap/` 和 `ostd/src/arch/riscv/trap/`

**实现完整度**：中等

#### RISC-V 中断处理

```rust
fn trap_handler(f: &mut TrapFrame) {
    match riscv::interrupt::cause::<Interrupt, Exception>() {
        Trap::Interrupt(interrupt) => handle_interrupt(interrupt, f),
        Trap::Exception(e) => { /* 页错误、地址不对齐、非法指令等 */ }
    }
}
```

支持的中断类型：
- **Supervisor Software Interrupt**：IPI（核间中断），通过 `CPU_IPI_QUEUES` 传递。
- **Supervisor Timer**：定时中断，驱动调度器和 jiffies 计数。
- **Supervisor External**：外部中断，通过 PLIC 分发。

#### PLIC 驱动

实现了 RISC-V PLIC（Platform-Level Interrupt Controller）驱动：
- 全局初始化（从设备树解析）
- 每 hart 上下文初始化
- 中断 claim/complete

#### 异常处理

- 页错误：区分用户/内核页错误，用户页错误交由 VMAR 处理。
- 地址不对齐、访问故障、非法指令：直接 panic。
- 断点：跳过指令继续执行。

---

### 2.10 设备驱动子系统

**位置**：`ostd/src/drivers/virtio/` 和 `ostd/src/bus/`

**实现完整度**：低（仅基本设备访问封装）

#### VirtIO 驱动

基于 `virtio-drivers` crate 的包装层：

- **块设备**（`block.rs`）：通过 `DEVICE_MANAGER` 获取第一个块设备。
- **网络设备**（`net.rs`）：获取第一个网络设备。
- **HAL**（`hal.rs`）：提供 `RiscvHal` 适配层。

#### 总线管理

- **设备发现**：通过设备树（FDT）扫描 VirtIO MMIO 设备和 PCI 设备。
- **PCI 支持**：ECAM 配置空间访问、BAR 分配（`BarAllocator`）、MSI-X 能力解析。
- **MMIO 设备**：从 FDT 解析 VirtIO MMIO 设备地址和中断号。

#### 设备管理器

`DEVICE_MANAGER` 全局管理所有发现的设备，提供块设备和网络设备的访问接口。

**注意**：网络设备仅有设备访问封装，未实现网络协议栈。

---

### 2.11 体系结构支持

**位置**：`ostd/src/arch/` 目录

#### RISC-V 64（主要目标）

- 启动：从 OpenSBI 进入，解析 FDT，初始化内存区域。
- SMP：支持多核启动（`boot_all_aps`）。
- 定时器：基于 SBI `set_timer`，频率 200Hz。
- 串口：VirtIO 控制台。
- 页表：Sv39/Sv48 模式。

#### LoongArch 64

- 启动：类似 RISC-V，从 FDT 解析设备信息。
- 定时器：LS7A RTC。
- 中断：PLIC（复用 RISC-V 的 PLIC 实现）。
- 串口：独立实现。

#### x86-64

- 启动：支持 Multiboot2、Linux legacy32、Linux EFI handover64 协议。
- APIC/x2APIC、IOAPIC。
- IOMMU（DMA remapping、interrupt remapping）。
- TDX（Intel Trust Domain Extensions）支持。
- HPET/PIT/APIC 定时器。
- GDT/IDT 管理。

---

### 2.12 同步原语

**位置**：`ostd/src/sync/` 目录

**实现完整度**：高

提供的同步原语：
- `GuardSpinLock` / `SpinLockGuard`：带守卫的自旋锁
- `GuardRwLock` / `RwLock`：读写锁
- `GuardRwArc` / `GuardRoArc`：带守卫的 Arc 包装
- `Rcu` / `RcuOption`：RCU（Read-Copy-Update）
- `WaitQueue`：等待队列（来自 maitake）
- `Mutex`：异步互斥锁（来自 maitake）
- `PreemptDisabled` / `LocalIrqDisabled`：抢占/中断禁用守卫

---

### 2.13 时间管理

**位置**：`kernel/src/time/` 和 `ostd/src/timer/`

**实现完整度**：中等

- `clock_gettime`：基于 jiffies 的时间查询。
- `clock_nanosleep` / `nanosleep`：基于 maitake 定时器的睡眠。
- `gettimeofday`：兼容 POSIX 的时间查询。
- `times`：CPU 时间统计（utime/stime/cutime/cstime）。

定时器频率：200Hz（RISC-V），通过 SBI `set_timer` 设置下一次定时中断。

---

## 3. 子系统交互分析

### 3.1 系统调用执行流

```
用户态 ecall
  → RISC-V trap_handler
    → UserMode::execute 返回 ReturnReason::Syscall
      → task_future 中的 loop 调用 syscall()
        → 具体 do_xxx 处理函数
          → 访问 ThreadState（fd_table, process_vm, cwd 等）
            → VFS 操作 / 内存操作 / 进程操作
              → ostd 层服务
```

### 3.2 进程创建流

```
ThreadBuilder::spawn()
  → ProcessVm::alloc()          # 创建地址空间
  → load_elf_to_vm()            # 加载 ELF
  → TaskOptions::build()        # 创建 Task
  → FdTable::with_stdio()       # 初始化 FD 表
  → ThreadState 构造            # 组装线程状态
  → task.run(ThreadFuture)      # 调度执行
```

### 3.3 文件 I/O 流

```
do_read(fd, buf, len)
  → FdTable::get(fd)            # 获取 FdEntry
  → SFileHandle::read_at(pos)   # VFS 读
    → Ext4FileHandle::read_at   # ext4 实现
      → Ext4::read_file         # ext4 底层
        → BlockDevice::read_blocks  # 块设备 I/O
          → VirtIOBlk            # VirtIO 驱动
  → ProcessVm::write_bytes()    # 写入用户空间
```

---

## 4. 构建与测试

### 4.1 构建系统

项目使用自定义的 OSDK（OS Development Kit）工具进行构建：
- `cargo osdk build`：编译内核
- `cargo osdk run`：在 QEMU 中运行
- 支持 vendor 目录离线构建
- 支持 RISC-V 和 LoongArch 交叉编译

### 4.2 测试情况

项目包含以下测试机制：
- **竞赛测试**：`TASKS` 数组定义了 32 个测试用例（brk, chdir, clone, close, dup2, dup, execve, exit, fork, fstat, getcwd, getdents, getpid, getppid, gettimeofday, mkdir, mmap, mount, munmap, openat, open, pipe, read, sleep, times, umount, uname, unlink, wait, waitpid, write, yield）。
- **musl/glibc 双库支持**：`TYPE_MAP` 包含 "musl" 和 "glibc" 两种 C 库。
- **VFS 单元测试**：`kernel/comps/vfs/src/tests/` 包含基本操作、并发操作、目录操作测试。
- **ostd 内核测试**：通过 `#[ktest]` 宏标记的内核态测试。

**未进行实际运行测试**，原因：
1. 项目需要特定的 QEMU 配置和 sdcard 镜像文件（`sdcard-rv.img`），该文件不在仓库中。
2. 构建依赖 OSDK 工具，需要先编译安装。
3. 项目日志文件（`log1`、`log2`）存在于仓库中，表明之前有过成功运行。

---

## 5. 设计创新性分析

### 5.1 全异步内核设计

NexusOS 的核心创新在于**全异步内核**设计。几乎所有内核操作（系统调用处理、VFS 操作、进程管理）都使用 Rust 的 `async/await` 语法，基于 `maitake` 异步运行时实现。这种设计：
- 天然支持 I/O 密集型操作的并发。
- 避免了传统内核中复杂的阻塞/唤醒逻辑。
- 与 Rust 的所有权系统良好结合。

### 5.2 能力（Capability）模型

VMAR/VMO 采用源自 Zircon 的能力模型，通过 Rust 的类型系统（`Full`、`Rights`、`TRights`）实现零成本能力：
- 静态能力（编译期检查）和动态能力（运行时检查）两种模式。
- 通过 `aster-rights` 库实现类型级别的权利管理。

### 5.3 静态分发 VFS

VFS 层使用 `static_dispatch` 模块将不同文件系统的实现统一为枚举类型，避免了传统 VFS 中虚函数表的性能开销，同时保持了类型安全。

### 5.4 多架构统一抽象

通过 ostd 层的架构抽象，内核代码可以在 RISC-V、LoongArch、x86-64 三种架构上共享，架构特定代码被隔离在 `ostd/src/arch/` 下。

---

## 6. 项目完整度评估

### 6.1 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 系统调用接口 | 55% | 覆盖竞赛核心需求，缺少 socket/futex/poll 等 |
| 进程/线程管理 | 65% | 核心生命周期完整，信号/futex/namespace 缺失 |
| 虚拟内存 | 70% | VMAR/VMO 模型完整，demand paging 基本可用 |
| 文件系统（VFS） | 80% | 抽象层完整，缓存/挂载/路径解析齐全 |
| ext4 实现 | 65% | 读写/目录/链接基本可用，日志为桩 |
| 内存管理（ostd） | 85% | 继承 Asterinas，伙伴系统/页表/堆分配成熟 |
| 任务调度 | 80% | 多核/工作窃取/抢占支持完整 |
| 设备驱动 | 30% | 仅 VirtIO 块设备基本可用，网络未实现协议栈 |
| 中断处理 | 60% | 基本中断分发可用，高级特性缺失 |
| 时间管理 | 60% | 基本时间查询和睡眠可用，精度有限 |
| 同步原语 | 85% | 种类丰富，RCU/WaitQueue/RwLock 齐全 |
| 体系结构支持 | 70% | RISC-V 最完整，LoongArch 次之，x86 继承自 Asterinas |

### 6.2 整体完整度

以通用操作系统内核为基准（100%），NexusOS 的整体完整度约为 **50-55%**。以操作系统竞赛（OS Comp）为基准（100%），完整度约为 **75-80%**，能够运行基本的 Linux 用户态程序（musl/glibc 编译）。

---

## 7. 其他发现

### 7.1 代码质量

- 中文注释广泛使用，便于团队理解。
- 大量 `TODO` 和 `FIXME` 标记，表明项目仍在积极开发。
- 使用 `tracing` 库进行结构化日志记录。
- 使用 `nexus-error` 自定义错误处理库，基于 `error-stack` 实现错误链。

### 7.2 依赖管理

- 使用 `vendor/` 目录实现离线构建。
- 依赖 `maitake` 异步运行时（fork 版本，包含调度器扩展）。
- 依赖 `virtio-drivers` crate 进行 VirtIO 设备驱动。
- 使用 `pin_project_lite` 进行 Future 投影。

### 7.3 已知问题

- `check_vaddr` 函数中的用户空间指针检查被注释掉，可能导致 NULL 指针访问未被及时捕获。
- dup 后文件偏移不共享，与 Linux 语义不一致。
- 信号系统仅为桩实现，不支持信号派发。
- ext4 日志为桩实现，不支持崩溃恢复。
- 网络设备仅有驱动封装，无协议栈。
- `statfs` 未实现（返回 `ENOSYS`）。

---

## 8. 总结

NexusOS 是一个面向操作系统竞赛的 Rust 内核项目，基于 Asterinas 的 OSTD 框架进行二次开发。项目的核心特色是全异步内核设计和能力模型内存管理。在竞赛所需的系统调用覆盖面上表现良好（约 55 个系统调用），能够支持 musl 和 glibc 两种 C 库的用户态程序运行。

项目的主要优势在于：
1. 全异步设计带来的代码简洁性和并发能力。
2. 基于 Rust 类型系统的能力模型，提供编译期安全保障。
3. 完整的 ext4 文件系统实现（纯 Rust）。
4. 多架构支持（RISC-V、LoongArch、x86-64）。

主要不足在于：
1. 信号、futex、网络等高级特性缺失或仅为桩实现。
2. ext4 日志未实现，存在数据安全风险。
3. 部分 Linux 语义兼容性不够精确（如 dup 后偏移共享）。
4. 设备驱动覆盖有限，仅 VirtIO 块设备基本可用。