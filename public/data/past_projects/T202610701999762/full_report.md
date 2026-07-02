# NameNotFound OS 内核项目全面技术分析报告

## 一、分析过程概述

本报告基于以下分析流程产出：

1. **代码目录全面扫描**：遍历所有 283 个 Rust 源文件、48 个 `module.toml`、`services.toml`、生成器 `archgen`、构建脚本、链接脚本、以及独立 ext4_rs crate。
2. **Need/Provide 依赖体系分析**：追踪从 `services.toml`（99 个全局 Service，8 个全局 Effect）到每个模块的 Need/Provide 声明的静态接线逻辑。
3. **子系统逐层审查**：从 L0（内核机制）到 L1（OS 对象语义）到 L2（系统调用 ABI），逐模块分析 body.rs、api.rs、need.rs 的代码实现。
4. **架构后端对比**：分别审查 RISC-V 64 和 LoongArch 64 两个 ISA 后端的汇编入口、上下文切换、页表操作、中断处理、定时器操作等。
5. **系统调用表全量审查**：逐一核对了 70+ 个已实现的 Linux 系统调用及其分派路径。
6. **构建系统分析**：审查 Makefile、Cargo.toml、cargo/config.toml 的构建配置与测试框架。

**注意**：由于环境中未安装 `nightly-2025-01-18` Rust 工具链和 QEMU 9.2.1，未能进行编译构建与运行测试。以下分析完全基于源代码及其架构设计。

---

## 二、项目整体架构

### 2.1 核心创新：组件化依赖注入架构

该项目的最大设计创新在于**编译期静态模块接线系统**。传统内核的模块间依赖通常通过直接 `use` 或全局符号链接实现，而本项目引入了三层抽象：

| 概念 | 说明 | 示例 |
|------|------|------|
| **Service** | 全局唯一能力契约（99 个） | `PAGE_ALLOC`、`TASK`、`VFS_FILE`、`IRQ` |
| **Effect** | 模块能力所附属的副作用标记（8 个） | `HEAP`、`SLEEP`、`LOCK`、`USER`、`FILE`、`CALLBACK`、`DEVICE`、`NEED_IRQ_ON` |
| **Tag** | 同一 Service 多个提供者之间的优先级与偏好标记 | prefer/avoid 机制 |

**模块定义（module.toml）示例**（以 `page_alloc` 为例）：

```toml
name = "page_alloc"
level = 0
stage = 30

[[need]]
alias = "boot_memory"
id = "INIT_BOOT_MEMORY"
use = "init"

[[need]]
alias = "memory_map"
id = "INIT_MEMORY_MAP"
use = "init"

[[need]]
alias = "panic"
id = "PANIC"
use = "run"
deny = ["HEAP", "SLEEP", "LOCK"]

[[provide]]
alias = "pages"
id = "PAGE_ALLOC"
api = "api"
effect = []
```

关键约束包括：
- `use` 字段区分 `"init"`（仅在初始化阶段使用）和 `"run"`（运行时使用）。
- `deny` 字段约束依赖的提供者不能具有这些 Effect，保证了例如 `page_alloc` 不会依赖带有 `HEAP` 和 `SLEEP` 副作用的模块——防止循环依赖。
- `required = false` 表示该依赖为可选。

### 2.2 代码生成器 archgen

`tools/archgen/src/main.rs`（1778 行）是核心构建工具，执行以下任务：

1. **`gen`**：扫描所有 `module.toml`，解析 Need/Provide 依赖图，进行拓扑排序和依赖绑定，生成：
   - `kernel/src/generated/mod.rs`：模块树根
   - `kernel/src/generated/init_plan.rs`：完整的初始化顺序和接线
   - 每个模块的 `need.rs`：将别名映射到具体实现路径
   - `docs/generated/`：架构文档

2. **绑定算法**：按 Level、Stage 分组，采用贪心策略逐阶段解析依赖。对于每个未解决的模块，在已绑定的 Provider 池中寻找匹配项：
   - 匹配 Service ID
   - 排除被 deny 的 Effect
   - 按 Tag 优先级评分（prefer +99, avoid -99）

3. **`gen-check`**：生成后运行 `git diff --exit-code`，确保生成的代码与仓库一致。

### 2.3 分层架构

```
L2 (syscall ABI)     linux_abi → syscall_args → syscall_handlers → syscall_table → syscall_entry → shell_init
                         ↑                                                  ↑
L1 (OS semantics)    context_core → task_mm_signal → vfs_fd → ipc_net_device → (fork/exec/elf/...)
                         ↑
L0 (kernel mech)     raw_panic → boot_info → page_alloc → trap_core → scheduler → device_core → ext4_core
                         ↑
Arch (ISA backend)   riscv64.rs / loongarch64.rs  (直接调用，不参与 Need/Provide)
```

### 2.4 初始化顺序

`init_plan.rs` 中的初始化严格按照 Level/Stage 排序，保证依赖方向始终由低层到高层。共 47 个启用模块按序初始化：

```
L0: raw_panic → boot_info_seed → cpu_raw → panic_halt → arch_primitives 
  → early_console → panic_early_print → boot_memory → page_alloc → page_map 
  → kernel_heap → dynamic_log → trap_core → user_copy_raw → irq_core 
  → clock_alarm → scheduler → wait_work → device_core → ext4_core → l0_ready

L1: context_core → task_mm_signal → vfs_fd → page_cache → ipc_net_device 
  → elf → exec → exit_wait → file_mapping → fork → futex → pipe_file 
  → poll → proc_export → ptrace → socket_file → user_boot → l1_ready

L2: linux_abi → syscall_args → syscall_handlers → sys_fs → sys_signal 
  → syscall_table → syscall_entry → shell_init
```

---

## 三、子系统详细拆解

### 3.1 架构抽象层（`kernel/src/arch/`）

#### 3.1.1 架构模块组织

`arch/platform.rs` 通过条件编译选择后端：

```rust
#[cfg(target_arch = "riscv64")]
#[path = "imp/riscv64.rs"]
mod imp;

#[cfg(target_arch = "loongarch64")]
#[path = "imp/loongarch64.rs"]
mod imp;
```

提供的抽象接口分布在 15 个文件中：`barrier.rs`、`boot.rs`、`cache.rs`、`console.rs`、`cpu.rs`、`debug.rs`、`dma.rs`、`irq.rs`、`mmio.rs`、`smp.rs`、`syscall.rs`、`thread.rs`、`timer.rs`、`trap.rs`、`vm.rs`。

#### 3.1.2 RISC-V 64 后端（`imp/riscv64.rs`，约 800+ 行）

**地址空间布局**：
- `PHYSICAL_MEMORY_OFFSET = 0xFFFF_FFFF_4000_0000`
- `KERNEL_OFFSET = 0xFFFF_FFFF_C000_0000`
- `USER_STACK_TOP = 0x4000_0000`
- 页表格式：Sv39（三级页表，512 条目/层）
- `SATP_MODE_SV39 = 8 << 60`

**异常入口**（内联汇编）：
- `__namenotfound_riscv64_trap_entry`：完整的 TrapFrame 保存/恢复，使用 `sscratch` 寄存器交换内核栈指针。保存全部 32 个通用寄存器 + sepc/sstatus/stval/scause，并在 TrapFrame 末尾写入 `1` 标记来自用户态（`from_user` 字段）。
- `__namenotfound_riscv64_trap_return`：恢复全部上下文后执行 `sret` 返回。
- `__namenotfound_riscv64_fork_return`：先通过 `csrw satp, s0; sfence.vma` 切换页表，再走 trap_return 路径。

**上下文切换**：
```asm
__namenotfound_riscv64_context_switch:
    sd sp,  0*8(a0)    # 保存 15 个 callee-saved 寄存器
    sd tp,  1*8(a0)    
    sd s0,  2*8(a0)    
    ...
    sd ra, 14*8(a0)
    ld sp,  0*8(a1)    # 恢复目标上下文
    ...
    ret
```

**控制台**：通过 UART 16550（基址 `0x1000_0000`）轮询输出。

**定时器**：使用 SBI `TIME` 扩展（`SBI_EID_TIME / SBI_FID_TIME_SET_TIMER`）设置下一次中断。

**CPU 标识**：通过 `tp` 寄存器保存 hart ID。

#### 3.1.3 LoongArch 64 后端（`imp/loongarch64.rs`，约 600+ 行）

**地址空间布局**：
- `PHYSICAL_MEMORY_OFFSET = 0x9000_0000_0000_0000`
- `DMW0_BASE = 0x8000_0000_0000_0000`（直接映射窗口）
- 页表格式：三级 4K 页表
- `PWCL_3LEVEL_4K = 12 | (9<<5) | (21<<10) | (9<<15) | (30<<20) | (9<<25)`

**TLB 重填处理**：实现了完整的三级页表软件遍历（`__namenotfound_loongarch64_tlb_refill`），使用 `lddir` 指令逐级遍历，最终 `ldpte` + `tlbfill` 完成 TLB 填充。若遍历失败则触发页面错误。

**异常入口**（`__namenotfound_loongarch64_trap_entry`）：保存全部 32 个通用寄存器 + ERA/CRMD/BADV/ESTAT，通过 `ertn` 返回。

**上下文切换**：保存 sp/tp/s0-s8/ra（使用 LoongArch 的 `s9` 作为额外的 callee-saved），LD/ST 指令均为 64 位。

**启动入口**（`qemu_loongarch64.rs`）：
```asm
_start:
    ori   $t0, $zero, 0x9
    lu52i.d $t0, $t0, -2048
    csrwr $t0, 0x180       # 配置 DMW0
    ...
    li.w  $t0, 0x08
    csrwr $t0, 0x0          # CRMD: 开启 PG/DA/IE
```

在启动时就配置了直接映射窗口（DMW），使物理地址 `0x8000_0000_0000_0000` 起直接可访问。

#### 3.1.4 线程上下文（`arch/thread.rs`）

`ThreadContext` 结构体：

```rust
#[repr(C)]
pub struct ThreadContext {
    pub sp: usize,           // 内核栈指针
    pub tp: usize,           // CPU 本地指针
    pub saved: [usize; 12],  // callee-saved 寄存器
    pub pc: usize,           // 返回地址
    pub arg: usize,          // 参数
    pub tls: usize,          // 线程本地存储指针
    pub page_table: usize,   // 页表令牌（satp/pgdl）
    pub user_stack: usize,   // 用户栈指针
    pub flags: usize,        // 标志位
}
```

关键操作：
- `init_user()`：创建全新用户线程上下文，设置入口点、用户栈、内核栈顶、页表、TLS
- `init_fork()`：复制父上下文，构造子进程的 TrapFrame（a0=0），设置 PC 为 `fork_return_entry`
- `init_kernel()`：创建内核线程
- `switch()`：调用架构特定的上下文切换汇编

### 3.2 L0 内核机制层

#### 3.2.1 物理页分配器（`page_alloc`）

**实现**：基于空闲范围链表的最先匹配分配器：

```rust
const MAX_FREE_RANGES: usize = 64;
static mut FREE_RANGES: [PageRange; MAX_FREE_RANGES] = ...;
static mut MANAGED_RANGES: [PageRange; MAX_FREE_RANGES] = ...;
```

- **初始化**：从 `boot_memory` 获取可用内存区域，按页对齐后填充 `FREE_RANGES`
- **分配**：遍历空闲范围，取第一个可用页（O(n)，n≤64），移动 `start` 指针
- **释放**：新建单页范围插入 `FREE_RANGES`，排序后合并相邻范围（`coalesce_ranges`）
- **锁机制**：自定义自旋锁（`with_lock`），使用 `AtomicBool` + `compare_exchange`，关中断保护，含重入检测（通过 `LOG_EARLY` 输出警告）
- **完整度**：基本功能完整（alloc/dealloc/free_pages），但不支持大页、NUMA、或细粒度内存区域类型

#### 3.2.2 页表管理（`page_map`）

**实现**：Sv39/LA64 三级页表的通用抽象。

核心 API：
```rust
pub fn new_table() -> Result<PageTable, MapError>
pub fn map_page(table, vaddr, paddr, flags) -> Result<(), MapError>
pub fn unmap_page(table, vaddr) -> Result<usize, MapError>
pub fn translate(table, vaddr) -> Option<Translation>
pub fn map_range(table, vaddr, paddr, len, flags) -> Result<(), MapError>
pub fn unmap_range(table, vaddr, len) -> Result<(), MapError>
```

关键实现细节：
- `walk_create()`：按需创建中间页表级，用 `pages::alloc_zeroed()` 分配新的页表页
- `walk_existing()`：只遍历已存在的页表结构
- 叶子 PTE 编码/解码委托给 `arch::vm::encode_page_table_entry` / `decode_page_table_entry`
- 每次映射/解映射后调用 `arch::vm::flush_tlb_addr`
- `ENTRIES_PER_TABLE = 512`，`LEVELS = 3`
- 支持 `map_range` 的原子性回滚（失败时撤销已映射的页面）

#### 3.2.3 内核堆分配器（`kernel_heap`）

基于 `linked_list_allocator` crate 的 `LockedHeap`，在内核堆可用后才初始化。提供 `Box`、`Vec`、`Arc` 等标准分配器接口。

#### 3.2.4 陷阱处理（`trap_core`）

- **初始化**：调用 `arch::trap::init()`，安装陷阱向量到 `stvec`/`eentry`
- **系统调用原始接口**（`syscall_raw`）：`set_handler` 注册 syscall 处理函数，运行时从 TrapFrame 提取 `number`、`arg(n)`、设置 `set_result`、`advance_pc`
- **线程上下文**（`thread_context`）：封装 `arch::thread` 的上下文操作
- **页面错误处理**：由架构层的 `handle_trap` 根据 `scause`/`estat` 解码后分发，页面错误调用注册的 `page_fault_handler`

#### 3.2.5 中断管理（`irq_core`）

提供 `IrqOff` RAII 结构（构造时关中断，析构时恢复），以及 `enable`/`disable`/`save`/`restore`/`enable_line`/`ack` 接口，直接映射到架构层的 PLIC/INTC 操作。

#### 3.2.6 时钟与定时器（`clock_alarm`）

- `clock::now_ns()`：调用架构的 `timer::now_ns()`，从硬件计数器读取开机时间
- `alarm::set_periodic(hz)`：设置周期性定时器中断，调度器使用 100Hz
- `alarm::set_next_ticks()` / `alarm::set_after_ticks()`：设置一次性闹钟

#### 3.2.7 任务调度器（`scheduler`）

核心数据结构：

```rust
struct Scheduler {
    tasks: Vec<Entry>,
}

struct Entry {
    id: TaskId,
    state: State,         // Ready | Running | Blocked(deadline) | Exited
    context: ThreadContext,
}
```

关键算法：

- **`schedule()`**：关中断 → 清定时器中断 → 重设 100Hz 定时器 → 唤醒到期 Blocked 任务 → 选取下一个 Ready 任务 → 暂存当前上下文 → 切换（`thread_context::switch`）
- **任务选择**：简单线性扫描，跳过当前任务和 State!=Ready 的任务
- **`next_ready()`**：仅选取不实际切换，用于非抢占式场景
- **阻塞机制**：`block_task(id, deadline)` 设置状态为 Blocked 并记录截止时间戳，100Hz 定时器中断触发 `schedule()` 时唤醒到期任务

#### 3.2.8 等待队列（`wait_work`）

提供 `WAIT` Service（等待队列）和 `WORK` Service（工作队列），用于实现阻塞锁和设备 I/O 的异步等待。依赖 `RUN` 和 `IRQ`。

#### 3.2.9 设备框架（`device_core`）

提供 6 个能力：

| 能力 | 说明 |
|------|------|
| `DEVICE` | MMIO 读写原语 |
| `DMA` | DMA 同步（调用 arch cache 操作） |
| `CHAR_DEVICE` | 字符设备注册表（基于 trait `CharDevice`） |
| `BLOCK_DEVICE` | 块设备注册表（基于 trait `BlockDevice`） |
| `CONSOLE` | 控制台抽象 |
| `RANDOM_CORE` | 随机数核心 |

**块设备接口**：
```rust
pub trait BlockDevice: Send {
    fn name(&self) -> &str;
    fn block_size(&self) -> usize;
    fn block_count(&self) -> u64;
    fn read_blocks(&mut self, start_block: u64, buf: &mut [u8]) -> Result<(), BlockError>;
    fn write_blocks(&mut self, start_block: u64, buf: &[u8]) -> Result<(), BlockError>;
}
```

**字符设备接口**：
```rust
pub trait CharDevice: Send {
    fn name(&self) -> &str;
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, CharError>;
    fn write(&mut self, buf: &[u8]) -> Result<usize, CharError>;
}
```

注册表使用全局 `Mutex<Vec<Box<dyn Device>>>` 存储，ID 即为数组索引。

#### 3.2.10 ext4 文件系统适配器（`ext4_core`）

作为 L0 层的最高模块（Stage 85），将独立 crate `ext4_rs` 包装为 `EXT4_RAW` 和 `EXT4_FS` 两个 Service。

**核心实现**：
- `Ext4Root` 结构体封装 `ext4_rs::Ext4` 实例
- `KernelBlockDevice` 适配器将 `BlockDeviceId` 适配为 `ext4_rs` 的 `BlockDevice` trait
- `mount_root_impl()`：检查 ext4 魔数（超级块偏移 0x438 处），然后用 `Ext4::open(block)` 创建实例

完整的文件操作包装：
```rust
impl Ext4Root {
    fn open_file(&mut self, path: &str, create: bool) -> Result<Ext4Node, FsError>
    fn open_dir(&mut self, path: &str) -> Result<Ext4Node, FsError>
    fn lookup(&mut self, path: &str) -> Result<Ext4Node, FsError>
    fn list_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, FsError>
    fn mkdir(&mut self, path: &str) -> Result<Ext4Node, FsError>
    fn symlink(&mut self, target: &str, link_path: &str) -> Result<Ext4Node, FsError>
    fn readlink(&mut self, path: &str) -> Result<String, FsError>
    fn unlink(&mut self, path: &str) -> Result<(), FsError>
    fn rmdir(&mut self, path: &str) -> Result<(), FsError>
    fn rename(&mut self, old: &str, new: &str, flags: u32) -> Result<(), FsError>
    fn read_at(&mut self, inode: u32, offset: usize, buf: &mut [u8]) -> Result<usize, FsError>
    fn write_at(&mut self, inode: u32, offset: usize, data: &[u8]) -> Result<usize, FsError>
    fn truncate(&mut self, inode: u32, size: u64) -> Result<(), FsError>
    fn metadata(&mut self, path: &str) -> Result<Metadata, FsError>
}
```

支持双挂载槽位（`slot=0` 为根文件系统，`slot=1` 为额外挂载如 `/mnt`）。

### 3.3 L1 OS 对象语义层

#### 3.3.1 上下文管理（`context_core`）

提供 `CONTEXT`、`CREDENTIAL`、`NAMESPACE`、`CURRENT_CTX`、`HANDLE_CORE`、`RLIMIT`、`SYS_ERROR` 等基础 Service。

`SysError` 定义了完整的 POSIX errno 映射（`EPERM=1`, `ENOENT=2`, `ESRCH=3`, `EINTR=4`, `EIO=5`, ..., `ENOSYS=38`, `ENOTEMPTY=39`, ...），映射到 Linux errno 编号。

#### 3.3.2 任务管理（`task_mm_signal`）

这是 L1 层最复杂的模块，内部包含四个子模块：`task_state`、`memory`、`signal_state`、`types`。

**任务状态管理（`task_state.rs`，约 300+ 行）**：

核心数据结构：
```rust
struct Task {
    signal_waiting: SigSet,       // 待处理信号集
    signal_blocked: SigSet,       // 阻塞的信号
    signal_restore_mask: Option<SigSet>, // sigreturn 保存的原始掩码
    signal_actions: [SignalAction; 65],  // 信号处理动作表 (0..=64)
    signal_stack: SignalStack,    // 信号栈配置
    signal_queue: Vec<SignalInfo>, // 信号队列
    exec_path: String,            // /proc/self/exe 用
    cwd: String,                  // 当前工作目录
    id: TaskId,
    parent: Option<TaskId>,
    children: Vec<TaskId>,
    kind: TaskKind,               // User / Kernel
    address_space: Option<AddressSpace>,
    entry: usize,                 // 用户态入口点
    user_stack: usize,
    tls: usize,
    kernel_stack_bottom: usize,
    kernel_stack_size: usize,
    exit_code: Option<isize>,
}
```

关键功能：
- **`spawn_user()`**：分配内核栈（16KB），初始化用户线程上下文，向调度器注册
- **`spawn_fork()`**：类似 spawn_user 但使用 fork 特定初始化
- **`spawn_kernel()`**：创建无用户态的内核线程
- **`set_current_task()`**：切换地址空间并更新调度器
- **任务间关系**：维护 parent/children 树，exit 时自动过继子进程给祖父
- **信号集成**：完整的信号动作表、信号栈、阻塞掩码管理

**用户内存管理（`memory.rs`，1034 行）**：

核心数据结构：
```rust
struct Space {
    table: map::PageTable,
    mappings: Vec<Mapping>,     // 映射列表
    brk: usize,                 // 程序断点
}

struct Mapping {
    start: usize,
    len: usize,
    perm: MapPerm,              // Read/Write/Execute
    pages: Vec<Option<usize>>,   // 物理页帧列表 (None=惰性分配)
    source: MappingSource,       // Anonymous | Lazy(file-backed)
}
```

关键功能：
- **`new_address_space()`**：创建新页表 + 映射内核恒等区域
- **`clone_address_space()`**：深度复制整个地址空间（fork 用），复制所有映射和物理页
- **`map_anonymous()`**：分配物理页并建立映射
- **`map_data()`**：将数据拷贝到新分配的物理页后映射
- **`map_stack()`**：分配用户栈空间（`USER_STACK_SIZE`）
- **惰性页面加载**：通过 `LazyPageLoader` trait 支持惰性页面分配和按需加载

#### 3.3.3 VFS 与文件描述符（`vfs_fd`）

**这是内核中最长的单个 API 文件（2485 行）**，集成了路径解析、文件操作、挂载管理、缓存、以及 procfs/devfs/tmpfs 虚拟文件系统。

**核心数据结构**：

```rust
enum FsNode {
    Ext4 { mount: Ext4Mount, inode: u32, kind: NodeKind },
    ProcDir { kind: procfs::DirKind },
    ProcFile { kind: procfs::FileKind },
    DevFile { kind: devfs::FileKind },
}

struct OpenFile {
    path: String,
    node: FsNode,
    flags: OpenFlags,
    offset: usize,
}

enum FdTarget {
    Standard(Fd),           // stdin/stdout/stderr
    File(FileId),           // 普通打开文件
    Pipe(PipeEnd),          // 管道端点
    External(ExternalFile), // socket/epoll 等外部对象
}
```

**路径解析**：
- `resolve_ext4_path()`：将路径解析为 `(Ext4Mount, inner_path, display_path)`
- `normalize_path()`：规范化并去 `..` 和 `.`
- 支持符号链接跟随（循环检测）
- 支持额外挂载点（如 `/mnt`）

**LRU 缓存**：通用 LRU 缓存实现，支持：
- 路径缓存（`PATH_CACHE_CAP=1024`）
- 目录项缓存（`DIR_CACHE_CAP=256`）
- 元数据按路径缓存（`METADATA_PATH_CACHE_CAP=1024`）
- 元数据按 inode 缓存（`METADATA_INODE_CACHE_CAP=4096`）
- 符号链接目标缓存（`SYMLINK_CACHE_CAP=1024`）
- 批量淘汰策略（`CACHE_EVICT_BATCH=64`）

**文件操作 API**：
```rust
pub fn open(path, flags) -> Result<FileId, SysError>
pub fn close(id) -> Result<(), SysError>
pub fn read(id, buf) -> Result<usize, SysError>
pub fn write(id, data) -> Result<usize, SysError>
pub fn read_at(id, offset, buf) -> Result<usize, SysError>
pub fn write_at(id, offset, data) -> Result<usize, SysError>
pub fn metadata(id) -> Result<Metadata, SysError>
pub fn truncate(id, size) -> Result<(), SysError>
pub fn seek(id, offset, whence) -> Result<usize, SysError>
```

**fd 表管理**：
- 每进程 fd 表存储在 VFS 全局存储中
- `dup()`/`dup3()` 支持
- `FdSnapshot` 支持 fork 后恢复
- `ExternalFile` 机制允许 socket、epoll 等子系统注册到 fd 表

**procfs 实现**：
- 静态内容：`/proc/meminfo`（固定内存信息）、`/proc/mounts`（挂载表）
- 动态内容：`/proc/{pid}/stat`、`/proc/{pid}/statm`、`/proc/{pid}/status`、`/proc/{pid}/cmdline`、`/proc/{pid}/comm`、`/proc/{pid}/exe`（链接目标为 todo）
- 目录结构：`/proc` → 按 PID 的子目录

**devfs 实现**：
- `/dev/tty`、`/dev/console`：字符设备
- `/dev/null`：空设备
- `/dev/rtc`、`/dev/rtc0`、`/dev/misc/rtc`：实时时钟

**tmpfs 实现**：骨架实现，仅标记就绪状态（`READY` flag），无实际内存文件系统功能。

#### 3.3.4 页面缓存（`page_cache`）

**独立于 VFS 缓存的全局页缓存**，用于文件数据的页面级缓存：

```rust
struct PageKey { dev: u64, inode: u64, page_index: usize }
struct CachedPage { data: Vec<u8>, valid_len: usize }
```

- LRU 缓存，`PAGE_CACHE_CAP=4096`，`EVICT_BATCH=256`
- 提供 `read_page()` / `write_page()` / `invalidate()` 接口
- 与 ext4 文件操作集成，透明缓存文件读写

#### 3.3.5 IPC 与网络（`ipc_net_device`）

**POSIX 时间**（`posix_time`）：从 `clock::now_ns()` 构造 `TimeSpec`，提供毫秒/秒/微秒转换。

**IPC 对象**（`ipc`）：共享内存（`ShmHandle`）和信号量（`Semaphore`）的骨架实现——仅分配递增 ID，无实际操作。

**Socket 实现**（`socket`）：
- `create(domain, ty, protocol)`：创建 socket，分配 fd
- `bind(handle, port)`：绑定端口
- `connect(handle, port)`：连接对等端口
- `listen(handle)`：标记为监听
- `accept(handle)`：接受连接（通过 `wait` 队列阻塞）
- `info(handle)`：查询状态

**TTY**：字符设备接口，与 console 集成。

**tcp_core**：标记为 `enabled=false`，TCP 协议栈完全未实现。

#### 3.3.6 L1 Bridge 模块

**ELF 加载器**（`elf`）：

使用 `xmas_elf` crate 解析 ELF 文件：

```rust
pub fn load(path: &str) -> SysResult<ElfImage> {
    // 1. 读取文件前缀（ELF 头 + 程序头 + 解释器路径）
    // 2. 解析 LOAD 段信息
    // 3. 如有 INTERP 段，递归加载动态链接器（偏移 INTERP_BIAS=0x2000_0000）
    // 4. 解析 TLS 模板
    // 5. 构建 AUX 向量
    // 6. 返回 ElfImage
}
```

支持：
- 静态和动态链接 ELF
- Shebang（`#!`）解释器重定向（最多 5 层递归）
- TLS 段解析
- PHDR、ENTRY、BASE 等 AUX 向量

**exec 执行**（`exec`）：

完整的进程镜像替换流程：
```rust
pub fn exec(path, argv) {
    1. 处理 shebang
    2. 验证 ELF 魔术数 (0x7f, b'E', b'L', b'F')
    3. ELF 加载 → ElfImage
    4. 创建新地址空间
    5. 映射可执行段和解释器段
    6. 设置 brk
    7. 映射用户栈
    8. 初始化栈内容 (argc/argv/envp/auxv)
    9. 设置 TLS
    10. replace_image 或 spawn_user
}
```

懒加载文件句柄（`LazyFile`）：exec 时打开的文件不立即关闭，通过引用计数延迟释放。

**fork 克隆**（`fork`）：

```rust
pub fn clone_current(args: CloneArgs) -> Result<TaskId, SysError> {
    1. 获取父任务信息
    2. share_address_space ? 复用 : clone_address_space
    3. 确定 user_stack / tls
    4. task::spawn_fork
    5. share_thread_group ? 加入同线程组
    6. 写入 parent_tid / child_tid
}
```

**exit/wait**（`exit_wait`）：

```rust
pub fn exit_current(code) { mark_exited → schedule() }
pub fn wait_current() { 循环: try_wait → 标记阻塞 → schedule() → 继续 }
```

子进程过继：exit 时将存活子进程的 parent 改为父进程的 parent。

**futex**（`futex`）：

完整实现 `wait_until` / `wake` / `requeue`：
- `wait_until(uaddr, expected, deadline)`：原子检查 `*uaddr==expected`，相等则加入等待队列并阻塞
- `wake(uaddr, count)`：移除等待者并标记为 Ready
- `requeue(from, to, wake_count, requeue_count)`：先唤醒 wake_count 个，再将至多 requeue_count 个迁移到新地址

**pipe_file**：管道实现，使用环形缓冲区和等待队列，支持读写阻塞和 EOF 检测。

**poll**：

实现 `poll`（单次轮询）和 `epoll`（持久化监视）：
- `poll(fds, timeout_ms)`：遍历 fds，原地填充 revents，支持超时阻塞
- `epoll_create/flags)`：创建 epoll 实例并在 fd 表中注册
- `epoll_ctl(epfd, op, fd, event)`：ADD/DEL/MOD 监视项
- `epoll_wait(epfd, events, maxevents, timeout_ms)`：等待就绪事件并复制到用户缓冲区

**file_mapping**：

`mmap` 文件映射实现：将文件内容读取到内核缓冲区后通过 `user_memory::map_data` 映射到用户空间，支持共享映射的回写同步（`sync`）。

**socket_file**：将 socket 的 fd 操作与 VFS 集成。

**ptrace**：进程跟踪支持（基本框架）。

**proc_export**：将进程信息导出到 procfs。

### 3.4 L2 系统调用 ABI 层

#### 3.4.1 Linux ABI 定义（`linux_abi`）

定义完整的 Linux ABI 结构体和常量：

- `Stat`（`struct stat`，128 字节）
- `Statx`（`struct statx`，256 字节）
- `StatFs`（`struct statfs`）
- `UtsName`（`struct utsname`，390 字节）
- `SysInfo`（`struct sysinfo`）
- `WinSize`（`struct winsize`）
- `Termios`（`struct termios`，60 字节）
- `RLimit64`（`struct rlimit64`）
- `RtcTime`（`struct rtc_time`）
- 完整的 `AT_*` 标志、`F_*`/`FD_*` fcntl 标志、`STATX_*` 标志、Rlimit 常量

#### 3.4.2 系统调用编号（`syscall_number`）

定义了 72 个系统调用号的完整枚举：

```rust
pub enum Syscall {
    Getcwd, Dup, Dup3, Fcntl, Ioctl, Mkdirat, Unlinkat, Symlinkat,
    Renameat, Umount2, Mount, Statfs, Fstatfs, Chdir, Faccessat,
    OpenAt, Close, Pipe2, Getdents64, Lseek, Read, Write, Readv,
    Writev, Sendfile, Ppoll, Readlinkat, Newfstatat, Fstat, Utimensat,
    SetTidAddress, Nanosleep, ClockGettime, ClockNanosleep, Syslog,
    Kill, Tkill, Tgkill, Sigaltstack, RtSigsuspend, RtSigaction,
    RtSigprocmask, RtSigpending, RtSigtimedwait, RtSigqueueinfo,
    RtSigreturn, Reboot, Times, Setpgid, Getpgid, Getsid, Setsid,
    Gettimeofday, Uname, Umask, Getpid, Getppid, Getuid, Geteuid,
    Getgid, Getegid, Gettid, Sysinfo, Brk, Munmap, Clone, Execve,
    Mmap, Mprotect, Exit, ExitGroup, Wait4, Renameat2, Prlimit64, Statx,
    Unknown(usize),
}
```

#### 3.4.3 系统调用参数（`syscall_args`）

提供用户态内存安全访问：
- `read_buffer(user_ptr, len)` / `write_buffer(user_ptr, data)`
- `read_value::<T>(user_ptr)` / `write_value::<T>(user_ptr, value)`
- `read_string(user_ptr, max_len)` → 从用户态读取 NUL 结尾字符串

#### 3.4.4 系统调用处理器（`syscall_handlers` + `sys_fs` + `sys_signal`）

**进程类**（`process`）：
- `clone()`：解析 clone flags，构造 `CloneArgs`，调用 `fork::clone_current`
- `execve()`：从用户态读取 path/argv/envp，调用 `exec`
- `exit(code)`：调用 `exit_wait::exit_current`
- `wait4(pid, wstatus, options, rusage)`：调用 `exit_wait::wait_current`
- `getpid()`/`getppid()`/`getuid()`/`geteuid()`/`getgid()`/`getegid()`/`gettid()`
- `setpgid()`/`getpgid()`/`getsid()`/`setsid()`
- `prlimit64()`/`set_tid_address()`
- `reboot()`：调用 `arch::shutdown`

**内存类**（`memory`）：
- `brk(addr)`：调整程序断点
- `mmap(addr, len, prot, flags, fd, offset)`：支持匿名映射和文件映射
- `munmap(addr, len)`：解除映射
- `mprotect(addr, len, prot)`：修改页权限

**文件类**（`file`，最详细）：
- `openat(dirfd, path, flags, mode)`：dirfd 相对路径支持，flag 转换
- `read(fd, buf, len)` / `write(fd, buf, len)`：基本 I/O
- `readv(fd, iov, iovcnt)` / `writev(fd, iov, iovcnt)`：分散/聚集 I/O
- `close(fd)` / `dup(fd)` / `dup3(old, new, flags)` / `fcntl(fd, cmd, arg)`
- `lseek(fd, offset, whence)` / `getdents64(fd, buf, len)`
- `fstat(fd, statbuf)` / `newfstatat(dirfd, path, statbuf, flags)`
- `mkdirat(dirfd, path, mode)` / `unlinkat(dirfd, path, flags)` / `symlinkat(target, dirfd, linkpath)`
- `renameat(olddir, oldpath, newdir, newpath)` / `renameat2`
- `statfs(path, buf)` / `fstatfs(fd, buf)`
- `readlinkat(dirfd, path, buf, bufsiz)`
- `utimensat(dirfd, path, times, flags)`
- `statx(dirfd, path, flags, mask, statxbuf)`
- `mount(source, target, fstype, flags, data)` / `umount2(target, flags)`
- `ioctl(fd, request, arg)`：支持 TIOCGWINSZ、TCGETS/TCSETS、RTC_RD_TIME
- `sendfile(out_fd, in_fd, offset, count)`
- `getcwd(buf, size)` / `chdir(path)` / `faccessat(dirfd, path, mode, flags)`
- `pipe2(fds, flags)`

**信号类**（`signal`，约 200 行）：
- `kill(pid, sig)` / `tkill(tid, sig)` / `tgkill(tgid, tid, sig)`
- `rt_sigaction(sig, act, oact, sigsetsize)`：Linux sigaction 结构体映射
- `rt_sigprocmask(how, set, oset, sigsetsize)`
- `rt_sigpending(set, sigsetsize)`
- `rt_sigtimedwait(set, info, timeout, sigsetsize)`
- `rt_sigqueueinfo(tgid, sig, info)`
- `rt_sigsuspend(mask, sigsetsize)`
- `sigaltstack(ss, oss)`

**时间类**（`time`）：
- `clock_gettime(clk_id, tp)` / `clock_nanosleep(clk_id, flags, req, rem)`
- `nanosleep(req, rem)` / `gettimeofday(tv, tz)`
- `times(tms)`

**IPC/Socket 类**：
- `ppoll(fds, nfds, timeout, sigmask, sigsetsize)`
- socket 相关 syscall（由 `ipc_net_device` 提供）

**杂项**：
- `uname(buf)` / `sysinfo(info)` / `syslog(tyoe, buf, len)` / `umask(mask)`

#### 3.4.5 系统调用入口（`syscall_entry`）

**这是系统调用的最关键路径**，约 500 行完整实现：

```rust
pub fn handle_trap(tf: &mut TrapFrame) {
    // 1. 提取 syscall number 和 6 个参数
    // 2. 如果是 rt_sigreturn，直接恢复信号帧
    // 3. Clone 在入口处特殊处理（需要修改子进程 TrapFrame）
    // 4. 其他调用走分发表
    // 5. Execve 成功后重置入口帧
    // 6. set_result + advance_pc
    // 7. 交付挂起信号（deliver_pending_signal）
}
```

**信号交付流程**（`deliver_pending_signal`）：
1. 从当前任务取挂起信号（忽略已阻塞的信号）
2. 查询信号动作：
   - `SIG_DFL`：默认动作（终止/忽略）
   - `SIG_IGN`：忽略
   - 自定义处理器：构造 `SignalFrame`（magic=0x5349474652414D45），压入用户栈，设置返回地址为 `restorer`，修改 TrapFrame 跳转到处理器

**信号帧恢复**（`rt_sigreturn`）：
- 验证 `SignalFrame.magic` 和版本
- 恢复 blocked 掩码和用户上下文

**clone 特殊处理**（`clone_from_trap`）：
- 复制父 TrapFrame，设置子进程返回值为 0
- 如果有 `child_stack`，设置为子进程的栈指针
- 如果有 `CLONE_SETTLS`，设置 TLS 寄存器
- 构造 `CloneArgs` 并调用 `fork::clone_current`

#### 3.4.6 Shell 初始化（`shell_init`）

负责内核启动后的用户态初始化：
1. 根据 `SHELL_ENABLE` 环境变量决定启动模式（`Tests` 或 `Shell`）
2. 挂载根文件系统
3. 如果测试模式，挂载额外块设备到 `/mnt`
4. 如果是 BusyBox Shell 模式，安装 BusyBox 符号链接（17 个命令）
5. 调用 `user_entry::start()` 进入用户态执行 `init` 程序

### 3.5 ext4_rs Crate（8816 行）

独立的外部 crate，完整实现 ext4 文件系统：

| 模块 | 说明 |
|------|------|
| `ext4_defs/block.rs` | 块设备抽象 |
| `ext4_defs/block_group.rs` | 块组描述符 |
| `ext4_defs/consts.rs` | 常量定义（O_RDONLY 等） |
| `ext4_defs/direntry.rs` | 目录项结构 |
| `ext4_defs/ext4.rs` | Ext4 主结构体 |
| `ext4_defs/extents.rs` | Extent 树 |
| `ext4_defs/file.rs` | 文件类型定义 |
| `ext4_defs/inode.rs` | Inode 结构与操作 |
| `ext4_defs/super_block.rs` | 超级块解析 |
| `ext4_impls/balloc.rs` | 块分配器 |
| `ext4_impls/ialloc.rs` | Inode 分配器 |
| `ext4_impls/dir.rs` | 目录操作 |
| `ext4_impls/file.rs` | 文件读写 |
| `ext4_impls/inode.rs` | Inode 操作 |
| `ext4_impls/extents.rs` | Extent 操作 |
| `simple_interface/` | 简化 API（`ext4_file_open`/`ext4_file_read`/`ext4_file_write`/`ext4_dir_mk` 等） |
| `fuse_interface/` | FUSE 兼容接口（`fuse_unlink`/`fuse_rmdir`/`fuse_symlink`/`fuse_rename`） |

支持 ext4 extent 格式（非传统间接块映射），这是现代 ext4 文件系统的核心特性。

---

## 四、子系统交互

### 4.1 系统调用完整路径

以 `write(fd=1, "hello", 5)` 为例：

```
1. 用户态 ecall (RISC-V) / syscall (LoongArch)
2. __namenotfound_riscv64_trap_entry 保存完整 TrapFrame
3. handle_trap() [arch/trap.rs] 解码 scause=SYSCALL
4. syscall_raw::handler(tf) → syscall_entry::handle_trap(tf)
5. 提取 number=64 (WRITE), args = [1, buf_addr, 5, 0, 0, 0]
6. table::dispatch → file::write(1, buf_addr, 5)
7. syscall_args::read_buffer(buf_addr, 5) → 用户态内存拷贝
8. fd::write(Fd(1), data) → FdTarget::Standard → console 输出
9. 设置 tf.regs[10] = 5 (a0 = 返回值), advance_pc
10. deliver_pending_signal → 交付挂起信号(如有)
11. trap_return 恢复寄存器, sret/ertn
```

### 4.2 fork + exec 路径

```
1. clone syscall → clone_from_trap(tf, args)
2. 复制 TrapFrame, 设置子进程 a0=0
3. fork::clone_current(CloneArgs) 
4. ├─ share_address_space? 复用 : clone_address_space (深度复制)
5. ├─ task::spawn_fork → alloc_kernel_stack → init_fork → scheduler::register
6. └─ write_tid (写入 parent_tid/child_tid)
7. 子进程醒来走 fork_return → trap_return → sret
8. 子进程调用 execve → exec::exec(path, argv)
9. ├─ elf::load(path) → 解析 ELF, 加载段信息
10. ├─ new_address_space → map 可执行段 + 解释器
11. ├─ map_stack → init_user_stack (argc/argv/envp/auxv)
12. └─ replace_image → set_address_space → set_context
13. syscall_entry 检测到 Execve 返回 0 → reset_user_entry_frame
14. trap_return → 进入新程序入口点
```

### 4.3 中断处理与调度路径

```
1. 定时器中断 (STI / 定时器 IRQ)
2. trap_entry → handle_trap → TrapKind::SupervisorTimer
3. trap::timer_handler → scheduler::schedule()
4. schedule() {
     关中断 → clear_interrupt → set_periodic(100Hz)
     → 唤醒到期 Blocked 任务
     → 选取下一个 Ready 任务
     → thread_context::switch(prev, next)
   }
5. context_switch 保存/恢复 callee-saved 寄存器
6. 新任务醒来时在 arch 的 switch 函数 ret 处继续执行
```

---

## 五、实现完整度评估

### 5.1 完整度基准

以下评估基于**一个能运行 Linux 兼容用户空间程序的操作系统内核**的典型需求，以 Linux 内核的功能集作为参照基准（100%）。

### 5.2 各子系统评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **物理内存管理** | 75% | 页面分配/释放完整，但无线程缓存、无内存水线、无 NUMA、无大页支持 |
| **虚拟内存管理** | 80% | 三级页表、映射/解映射、惰性分配完整，缺 COW 优化、缺页面回收 |
| **内核堆** | 90% | 基于 linked_list_allocator，功能完备 |
| **进程管理** | 85% | fork/exec/exit/wait 完整，信号完整，缺 cgroup、缺 namespaces（仅定义接口） |
| **调度器** | 60% | 简单轮询，有阻塞/唤醒，缺优先级、缺负载均衡、缺 CFS 等价实现 |
| **中断管理** | 70% | 基本 enable/disable/ack，缺 MSI-X、缺中断亲和性 |
| **时钟/定时器** | 80% | 周期性定时器、高精度时间戳、闹钟功能基本完整 |
| **文件系统 VFS** | 75% | 路径解析、缓存、fd 表、procfs/devfs 完整；tmpfs 为空壳 |
| **ext4** | 70% | 读写、目录、符号链接、extent 完整；缺日志、缺 ACL、缺 xattr |
| **页面缓存** | 65% | LRU 读写缓存完整；缺回写、缺预读、缺直接 I/O |
| **网络** | 15% | Socket 框架、UDP 本地回环可能；TCP（tcp_core）禁用 |
| **IPC** | 30% | pipe 完整；共享内存/信号量为骨架；缺消息队列、缺 Unix domain socket |
| **同步原语** | 70% | futex 完整；缺 robust list、缺 PI mutex |
| **设备驱动** | 55% | virtio-mmio/pci blk 框架存在；缺网络设备、缺显示驱动 |
| **系统调用** | 65% | 72 个 syscall 编号定义，约 60+ 个有实质实现，缺 epoll 以外的多路复用、缺部分文件操作 |
| **RISC-V 后端** | 90% | Sv39、SBI、PLIC/UART 完整 |
| **LoongArch 后端** | 85% | 三级页表、DMW、TLB 重填、UART 完整 |

### 5.3 整体完整度

**整体评估：约 65%**

该内核已经可以做到：
- 启动到用户态，运行 BusyBox shell
- 执行静态/动态链接 ELF 可执行文件
- 进行文件 I/O（读/写/创建/删除/目录遍历）
- 支持多进程（fork/exec/exit/wait）
- 信号处理
- 基本的管道和 socket 通信
- 运行 libc-test 测试套件

尚不能做到：
- 真实网络通信（TCP 栈缺失）
- 复杂的资源隔离（cgroup/namespace）
- 高性能调度（CFS/优先级）
- 设备热插拔
- 完整的 POSIX 信号语义（某些边缘情况）

---

## 六、设计创新性评估

### 6.1 主要创新点

| 创新点 | 创新程度 | 具体体现 |
|--------|----------|--------|
| **Need/Provide 依赖注入** | 高 | 编译期自动解析依赖图，消除模块间直接耦合，替换组件只需修改 module.toml |
| **Effect 副作用约束** | 高 | 8 个 Effect 标记形成允许/禁止约束，在编译期防止错误依赖（如 page_alloc 不允许依赖 HEAP） |
| **三层架构因子分解** | 中高 | L0（机制）/L1（语义）/L2（ABI）三分离，确保机制层可独立验证 |
| **双 ISA 完整后端** | 中 | RISC-V 和 LoongArch 均实现完整的异常入口、上下文切换、TLB 管理 |
| **代码生成器驱动的模块化** | 高 | archgen 自动生成 need.rs 和 init_plan.rs，模块间完全解耦 |
| **init/run 依赖时间分离** | 中 | `use = "init"` vs `use = "run"` 防止初始化阶段模块被运行时代码污染 |
| **Tag 优先级接线系统** | 中 | prefer/avoid 机制允许同一 Service 的多个实现竞争，支持平台特定优化 |

### 6.2 创新性总结

该项目的核心创新在于**将依赖注入（DI）范式系统性地应用于 OS 内核构建**。这种架构使得：

1. **可测试性**：每个模块可被 mock 实现替换（只需要匹配 Provide 声明）
2. **可移植性**：换架构只需替换 arch 后端（而 arch 甚至不参与 Need/Provide）
3. **可维护性**：模块间接口由 Services.toml 统一管理（99 个 Service 即 99 个接口契约）
4. **编译时安全**：Effect deny 机制在编译期捕获循环依赖和层级违反

这在 OS 内核竞赛项目中是较为独特的设计选择——大多数参赛项目采用传统的分层/微内核/单体内核架构，而本项目的组件化架构在模块化程度上更进一步。

---

## 七、构建与测试信息

### 7.1 构建流程

```
make gen           # archgen 解析 module.toml → 生成 need.rs + init_plan.rs
make all           # cargo build (RISC-V + LoongArch) + 构建磁盘镜像
make qemu-rv       # QEMU 启动 RISC-V
make test-rv       # 运行测试套件
make docker-test   # Docker 环境中运行测试
```

### 7.2 当前构建配置

- `SHELL_ENABLE=0`（测试模式）
- `VIRTIO_BLK_ENABLE=1`（virtio 块设备启用）
- `LOG=off`（生产模式关闭日志）
- `MUSL_LIBCTEST_TEST=1`（启用 musl libc 测试）

### 7.3 测试未执行的原因

环境缺少 `nightly-2025-01-18` Rust 工具链（需 `rust-src` + `llvm-tools-preview`）和 QEMU 9.2.1，因此未进行编译构建和运行测试。所有分析基于源代码审计。

---

## 八、总结

**NameNotFound**（西安电子科技大学）提交的是一个架构设计精巧、工程实现较为完整的 Rust OS 内核项目。其核心贡献在于：

1. **创新的组件化架构**：通过 `module.toml` + `archgen` 生成器 + `services.toml` 全局契约，实现了编译期静态依赖注入，这在 OS 内核构建中是新颖的设计。

2. **双 ISA 完整支持**：RISC-V 64（Sv39）和 LoongArch 64 均有完整的汇编级异常处理、上下文切换、TLB 管理，展现了良好的可移植性设计。

3. **从硬件到用户态的完整覆盖**：从 UART 轮询输出、物理页分配、页表映射，到完整 Linux ABI 系统调用层（70+ syscall）、ext4 文件系统、ELF 加载器、信号处理，形成了一条完整的可运行路径。

4. **工程成熟度**：包含 Docker 测试环境、自动化测试框架、磁盘镜像构建工具、BusyBox 集成等，表明项目已具备规模化测试能力。

5. **已知不足**：TCP 网络协议栈被禁用（`tcp_core` 的 `enabled=false`）、tmpfs 仅为骨架、共享内存/信号量仅为 ID 分配器、调度器采用简单轮询策略，这些都是未来可增强的方向。

代码总量约 32,738 行 Rust（含 ext4_rs crate），47 个启用的功能模块通过 99 个 Service 契约和 8 个 Effect 约束在编译期静态绑定，形成了模块化程度高、依赖关系清晰的内核架构。