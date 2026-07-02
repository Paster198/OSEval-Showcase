# HPU OS 内核项目深度技术分析报告

---

## 一、分析过程与方法

本报告基于以下分析方法：

1. **源码逐文件审查**：逐一阅读所有 Rust 源文件、汇编文件、链接脚本、Cargo 清单和 Makefile。
2. **编译构建测试**：尝试使用环境提供的 RISC-V 工具链编译 RISC-V 内核。
3. **交叉对比分析**：对比 RISC-V (`src/`) 和 LoongArch (`src-la/`) 两套内核在架构层面的差异。
4. **代码度量**：对代码行数、模块规模、syscall 覆盖范围进行定量统计。

---

## 二、构建测试结果

### RISC-V 内核编译测试

**结果：编译失败**。错误原因是 `src/test_runner.rs` 文件存在重复定义。

该文件在第 1-252 行包含完整的 test_runner 模块实现，但在第 253-494 行又出现了该模块的第二个完整副本。这导致以下符号被重复定义：

| 重复定义符号 | 首次定义行 | 重复定义行 |
|-------------|-----------|-----------|
| `BASIC_TESTS` | 11 | 253 |
| `EXTENDED_GROUPS` | 19 | 261 |
| `SUITE_TIMEOUT_SEC` | 23 | 265 |
| `RunnerState` | 25 | 268 |
| `RUNNER` | 39 | 282 |
| `start_from_disk` | 41 | 284 |
| `on_root_task_exit` | 96 | 338 |
| `suite_has_timed_out` | 101 | 343 |
| `emit_end_and_shutdown` | 111 | 353 |
| `detect_basic_dir` | 137 | 379 |
| `spawn_next` | 151 | 393 |
| `spawn_next_group` | 197 | 439 |

编译产生 **30 个错误** 和 **53 个警告**。

### LoongArch 内核编译

未实际编译测试（需要 `loongarch64-unknown-none` 目标及 nightly Rust 工具链的 `-Zbuild-std=core,alloc`），但源码审查表明 `src-la/test_runner.rs`（265 行）无重复定义问题。

---

## 三、项目整体架构

### 3.1 目录与模块组织

```
HPU OS
├── RISC-V 内核 (src/)          — 10,783 行 Rust + 汇编
│   ├── 入口与启动    — main.rs, entry.asm, linker.ld, lang_items.rs, config.rs
│   ├── 控制台/日志   — console.rs, sbi.rs
│   ├── 内存管理      — mm/ (mod, address, page_table, frame_allocator, heap_allocator, memory_set)
│   ├── 任务管理      — task/ (mod, task, manager, processor, context, switch.S, elf, pid)
│   ├── 陷阱处理      — trap/ (mod, context, trap.S)
│   ├── 系统调用      — syscall/ (mod, fs, process, errno)
│   ├── 文件系统      — fs/ (mod, ext4, vfs, fd_table, manager)
│   ├── 设备驱动      — drivers/ (mod, block)
│   ├── 计时器        — timer.rs
│   ├── 输入处理      — input.rs
│   └── 评测框架      — test_runner.rs (494 行，含重复)
│
├── LoongArch 内核 (src-la/)    — 约 11,100 行 Rust + 汇编
│   └── (镜像结构，额外包含 loongarch_csr.rs 替代 riscv crate)
│
├── 用户程序 (user/)            — ~190 行
│   └── src/main.rs, lib.rs, linker.ld
│
├── 构建系统
│   ├── Makefile (顶层)
│   ├── Cargo.toml
│   ├── cargo-config/config.toml
│   └── src-la/Cargo.toml (LoongArch 独立 manifest)
│
└── 文档/工具
    ├── docs/ (HPU_OS.pptx, 说明文档.docx)
    └── loongarc-package/ (LoongArch 评测打包)
```

### 3.2 双架构策略

RISC-V 和 LoongArch 两套内核代码在结构上基本镜像对称。核心差异集中在以下几个方面：

| 差异维度 | RISC-V (`src/`) | LoongArch (`src-la/`) |
|---------|-----------------|---------------------|
| 页表格式 | Sv39 (三级, PTE 8字节) | LoongArch 三级页表 (PGDL/PGDH, 64位 PTE) |
| 直接映射 | 无 DMW (全部走页表) | DMW0 窗口 (0x9000...映射全部物理内存) |
| 异常入口 | stvec CSR → TRAMPOLINE | EENTRY CSR → TRAMPOLINE (地址12位对齐) |
| 系统调用 | ecall → scause::UserEnvCall | syscall 指令 → ECODE_SYS (0x0b) |
| 计时器 | SBI ecall (a7=0) + rdtime | CSR TCFG/TICLR + rdtime.d |
| 中断控制 | sie/sstatus CSR | ECFG/CRMD CSR |
| 固件接口 | sbi-rt crate (OpenSBI) | 直接 MMIO (UART, SYSCON) |
| TLB 管理 | sfence.vma | invtlb 指令 |
| 上下文切换 | __switch (汇编) | __switch (汇编，同逻辑) |
| TRAMPOLINE 地址 | 0xFFFFFFFFFFFFF000 | 0x00000000FFFFF000 |

---

## 四、各子系统详细实现拆解

### 4.1 启动与初始化流程

**RISC-V 启动路径：**

```
_start (entry.asm)
  → la sp, boot_stack_top  (设置启动栈，16页 = 64KB)
  → call rust_main

rust_main()
  → clear_bss()                     // 清零 .bss 段
  → console::log_init()             // 初始化 log 系统
  → mm::init()                      // 内存子系统初始化
    → heap_allocator::init_heap()     // 伙伴系统内核堆 (16MB)
    → frame_allocator::init()         // 物理帧分配器
    → MemorySet::new_kernel()         // 内核地址空间
      → 恒等映射内核段 + 额外空间
      → 映射剩余物理内存
      → 映射 0x1000_0000..0x1000_9000 (virtio MMIO)
      → 映射 TRAMPOLINE 页
      → 映射 TRAP_CONTEXT_BASE
    → kernel_space.activate()         // 写入 satp, sfence.vma
  → 记录 TRAMPOLINE_PA
  → trap::init()                     // stvec → trap_from_kernel
  → timer::set_next_trigger()
  → drivers::init()                  // virtio-blk 设备探测
  → fs::init()                       // EXT4 挂载
  → test_runner::start_from_disk()   // 评测框架
  → task::run_tasks()                // 主调度循环
```

**LoongArch 启动路径差异：**

```
loongarch_main()
  → clear_bss()
  → loongarch_csr::init_direct_map()  // DMW0 配置
  → loongarch_csr::init_page_walk()   // PWCL/PWCH 页表遍历配置
  → loongarch_csr::enable_paging()    // CRMD.PG=1
  → (后续流程与 RISC-V 类似)
```

### 4.2 内存管理子系统 (mm/)

#### 4.2.1 地址抽象 (`address.rs`)

定义了四类地址包装类型，均实现了 `From/Into` 转换和迭代器：

```rust
pub struct PhysAddr(pub usize);      // 物理地址
pub struct VirtAddr(pub usize);      // 虚拟地址
pub struct PhysPageNum(pub usize);   // 物理页号 (PPN)
pub struct VirtPageNum(pub usize);   // 虚拟页号 (VPN)
```

关键方法：
- `PhysAddr::floor()/ceil()` → PhysPageNum（向下/向上取整到页边界）
- `VirtAddr::floor()/ceil()` → VirtPageNum
- `PhysPageNum::get_addr()` → PhysAddr（页号 × 4096）
- `VPNRange` 迭代器：遍历 VPN 范围
- `StepByOne` trait：逐步递增 VPN

#### 4.2.2 Sv39 页表 (`page_table.rs` - RISC-V)

**PTE 结构：**

```rust
pub struct PageTableEntry { pub bits: usize }
// bits[63:10] = PPN[2:0] (44位物理页号)
// bits[9:8]   = 保留
// bits[7:0]   = 标志位 (V/R/W/X/U/G/A/D)
```

标志位使用 `bitflags` 宏定义，包含 Valid、Readable、Writable、Executable、User、Global、Accessed、Dirty。

**页表结构：**

```rust
pub struct PageTable {
    root_ppn: PhysPageNum,         // 根页表物理页号
    frames: Vec<FrameTracker>,     // 持有中间级页表帧，防止被回收
}
```

**关键方法：**

- `new()` → 分配一页作为根页表，返回 `Option<Self>`
- `find_pte_create(vaddr)` → 遍历三级页表查找 PTE，自动创建缺失的中间级页表
- `map(vaddr, ppn, flags)` → 建立虚拟地址到物理页的映射（自动加上 V 标志）
- `unmap(vaddr)` / `unmap_if_mapped(vaddr)` → 解除映射
- `find_pte(vaddr)` → 只读查找 PTE（用于 virt_to_phys）
- `from_token(token)` → 从 satp 值恢复页表结构（用于查询，不持有帧所有权）
- `token()` → 生成 satp 值：`8 << 60 | root_ppn.0`（Sv39 模式）

VPN 提取：
```rust
fn vpn_index(vaddr: VirtAddr, level: usize) -> usize {
    (vaddr.0 >> (12 + level * 9)) & 0x1ff  // level 2: bits 38-30, level 1: 29-21, level 0: 20-12
}
```

#### 4.2.3 LoongArch 页表 (`src-la/mm/page_table.rs`)

与 RISC-V 的关键差异在于 PTE 标志位映射到硬件定义：

```rust
pub struct PTEFlags: usize {
    const V = 1 << 0;       // Valid
    const D = 1 << 1;       // Dirty
    const PLV_USER = 3 << 2; // 用户特权级
    const MAT_CC = 1 << 4;  // 缓存一致
    const G = 1 << 6;       // Global
    const P = 1 << 7;       // Present
    const W = 1 << 8;       // Writable
    const HUGE = 1 << 12;   // 大页
    const NR = 1 << 61;     // 不可读
    const NX = 1 << 62;     // 不可执行
    // 软件兼容标志
    const R/X/U/A = 软件标志位
}
```

`PageTableEntry::new()` 中进行了标志位转换：软标志 (R/X/U/W/G) 被映射为对应的硬件标志位组合。`token()` 返回的是物理地址（写入 PGDL/PGDH），而非 satp 格式。

#### 4.2.4 物理帧分配器 (`frame_allocator.rs`)

```rust
struct FrameAllocator {
    start: usize,       // 起始 PPN
    current: usize,     // 当前分配游标
    end: usize,         // 结束 PPN
    recycled: Vec<usize>, // 回收的 PPN
}
```

- **分配策略**：优先从 `recycled` 栈弹出，否则从 `current` 递增分配
- **初始化范围**：从内核结束地址（`ekernel`）向上取整到页边界，到 `MEMORY_END`
- **MEMORY_END**：RISC-V 为 `0x8800_0000` (128MB)，LoongArch 为 `DMW_BASE + 0x0800_0000`
- **FrameTracker**：RAII 包装器，`Drop` 时自动调用 `frame_dealloc()`
- **并发安全**：通过 `lazy_static!` + `spin::Mutex` 实现全局单例
- **分配时清零**：`FrameTracker::new()` 中使用 `core::ptr::write_bytes(ptr, 0, 0x1000)` 清零

#### 4.2.5 内核堆分配器 (`heap_allocator.rs`)

```rust
static mut HEAP_SPACE: [u8; 16 * 1024 * 1024] = [0; HEAP_SIZE]; // 16MB
#[global_allocator]
static HEAP_ALLOCATOR: LockedHeap<32> = LockedHeap::empty();
```

- 基于 `buddy_system_allocator` 的伙伴系统实现
- 最大阶数 32（支持 4KB 到 16MB 的分配）
- 16MB 堆空间（注释说明用于缓冲测试可执行文件）

#### 4.2.6 地址空间管理 (`memory_set.rs`)

**核心结构：**

```rust
pub struct MemorySet {
    pub page_table: PageTable,
    pub areas: Vec<MapArea>,      // 已映射区域列表
    pub frames: Vec<FrameTracker>, // 持有的物理帧
}

pub struct MapArea {
    vaddr: usize,   // 起始虚拟地址
    pages: usize,   // 页数
    flags: PTEFlags, // 权限标志
}
```

**关键方法：**

- `new_kernel()`：创建内核地址空间
  - 恒等映射内核段（`skernel..ekernel+0x10000`），权限 R|W|X
  - 映射剩余物理内存（R|W）
  - 映射 virtio MMIO 区域 `0x1000_0000..0x1000_9000`（R|W）
  - 映射 TRAMPOLINE 页到 `__alltraps` 物理页（R|X）
  - 映射 TRAP_CONTEXT_BASE（占位 PPN=0）

- `new_bare()`：创建空地址空间（用户进程）
- `from_existed_user(parent, trampoline_pa)`：fork 时深拷贝父进程地址空间
  - 遍历父进程的 `areas`，分配新物理页
  - 逐页 `copy_nonoverlapping` 复制内容（**急切拷贝，非写时复制**）

- `insert_framed_area(start_va, end_va, flags)`：分配物理页并映射虚拟地址区间
- `map_trampoline(trampoline_pa)` / `map_trap_context(trap_cx_va, tid)`：映射特殊页
- `load_elf(elf_data)`：委托给 `task::elf::load_elf()`
- `handle_lazy_page_fault(fault_va)`：**惰性页故障处理**
  - 检查 `fault_va` 是否在已记录的 `areas` 范围内
  - 如果 PTE 不存在，分配物理帧、建立映射

**惰性分配机制**：注释提到「reserve_user_range」用于 mmap 预注册区域但不立即分配物理页。实际的页分配在 `handle_lazy_page_fault` 中按需完成。

**跨地址空间访问辅助函数：**
- `translated_byte_buffer(token, ptr, len)`：通过页表翻译用户缓冲区为物理页切片
- `translated_str(token, ptr)`：翻译用户态字符串
- `translated_refmut(token, ptr)`：翻译用户态可变引用
- `virt_to_phys(token, va)`：查用户页表获取物理地址

### 4.3 任务管理子系统 (task/)

#### 4.3.1 进程控制块 (`task.rs`)

```rust
pub struct TaskControlBlock {
    pub pid: PidHandle,              // PID（RAII 分配句柄）
    pub tid: usize,                  // 线程 ID
    pub kstack: KernelStack,         // 内核栈（16页 = 64KB）
    pub ustack_base: usize,          // 用户栈基址
    pub inner: Mutex<TaskControlBlockInner>, // 可变内部状态
    pub vm: Arc<Mutex<MemorySet>>,   // 共享地址空间（Arc 支持多线程）
}

pub struct TaskControlBlockInner {
    pub trap_cx_ppn: usize,          // TrapContext 物理页号
    pub task_cx: TaskContext,         // 上下文切换用
    pub task_status: TaskStatus,      // Ready/Running/Zombie/Interruptible
    pub parent: Option<Weak<TaskControlBlock>>,
    pub children: Vec<Arc<TaskControlBlock>>,
    pub exit_code: u32,
    pub heap_bottom: usize,          // 堆底（brk 起点）
    pub heap_pt: usize,              // 堆顶（brk 当前位置）
    pub mmap_pt: usize,              // mmap 分配游标
    pub rlimits: [(usize, usize); RLIMIT_COUNT],
    pub clear_child_tid: usize,      // CLONE_CHILD_CLEARTID 地址
    pub signal_mask: u64,            // 信号屏蔽字
    pub pending_signals: u64,        // 待处理信号集
    pub sigactions: [usize; 65],     // 信号处理函数（占位，未完整实现）
    pub sigaction_flags: [usize; 65],
}
```

**进程创建流程** (`TaskControlBlock::new_with_args(elf_data, args)`)：
1. 分配 PID 和内核栈
2. 创建空地址空间 `MemorySet::new_bare()`
3. 映射 TRAMPOLINE 和 TrapContext 页
4. 加载 ELF → 获取入口地址和用户栈指针
5. 计算堆底（ELF 加载后最高地址向上对齐）
6. 构建用户栈（argc/argv/envp/auxv）
7. 初始化 TrapContext（入口地址、用户栈、内核栈、内核 SATP）
8. 组装 TCB

**fork 实现** (`TaskControlBlock::fork(parent, child_sp)`)：
- 深拷贝父进程地址空间 (`MemorySet::from_existed_user`)
- 复制父进程 TrapContext，修改 a0=0（子进程返回 0）
- 如果 `child_sp != 0`（clone 提供新栈），修改 sp
- 继承堆、mmap 游标、rlimits、信号屏蔽字

**exec 实现** (`TaskControlBlock::exec(elf_data, args)`)：
- 创建全新地址空间
- 重新加载 ELF
- 替换 `vm`、重置 `heap_bottom/pt`、`mmap_pt`、`clear_child_tid`、`signal_mask`、`pending_signals`

#### 4.3.2 任务上下文 (`context.rs`)

```rust
#[repr(C)]
pub struct TaskContext {
    pub ra: usize,        // 返回地址
    pub sp: usize,        // 栈指针
    pub s: [usize; 12],   // s0-s11 被调用者保存寄存器
}
```

14 个寄存器（ra + sp + 12个s寄存器），与 `switch.S` 严格对应。

#### 4.3.3 上下文切换 (`switch.S`)

```asm
__switch:
    # 保存当前任务上下文到 a0 (current_task_cx_ptr)
    sd ra, 0(a0)
    sd sp, 8(a0)
    sd s0..s11, 16..104(a0)
    # 从 a1 (next_task_cx_ptr) 恢复
    ld ra, 0(a1)
    ld sp, 8(a1)
    ld s0..s11, 16..104(a1)
    ret
```

#### 4.3.4 调度器 (`processor.rs` + `manager.rs`)

**Processor 结构：**

```rust
pub struct Processor {
    current: Option<Arc<TaskControlBlock>>,
    idle_task_cx: TaskContext,   // 空闲上下文（调度器的"锚点"）
}
```

**主调度循环** (`run_tasks()`):
```
loop {
    reap_zombies()           // 回收僵尸进程
    if let Some(task) = fetch_task() {  // 从就绪队列取任务
        switch_to_process()  // 切换 FS 视图
        __switch(idle_task_cx_ptr, next_task_cx_ptr)  // 上下文切换
    } else {
        shutdown()           // 无任务则关机
    }
}
```

**任务管理器** (`TaskManager`)：
- `ready_queue: VecDeque` — FIFO 就绪队列
- `sleeping: Vec<(Arc, TimeSpec)>` — 定时睡眠队列
- `interruptible_queue: VecDeque` — 可中断等待队列
- `futex_waiters: Vec<(usize, Arc)>` — Futex 等待队列
- `zombies: Vec<Arc>` — 僵尸队列

**调度策略**：简单的 FIFO 协作式 + 时钟中断抢占。每个时钟中断会调用 `suspend_current_and_run_next()` 强制切换。

**超时看门狗**：`check_per_task_timeout()` 在每个时钟 tick 检查当前任务是否超过 10 秒预算，超时则强制 kill（exit code 124）。

#### 4.3.5 PID 分配器 (`pid.rs`)

```rust
pub struct PidAllocator {
    current: usize,      // 从 1 开始（0 保留）
    recycled: Vec<usize>, // 回收的 PID
}
```

- `PidHandle`：RAII 包装器，`Drop` 时自动回收 PID
- `KernelStack`：每个进程 16 页内核栈（注释说明为了支持静态链接 glibc 程序的深层调用）
- `trap_cx_bottom_from_tid(tid)`：`TRAP_CONTEXT_BASE - tid * PAGE_SIZE`（每个线程独立 TrapContext 页）

#### 4.3.6 ELF 加载器 (`elf.rs`)

- 使用 `xmas-elf` crate 解析 ELF 文件
- 仅支持 RISC-V 架构（有 `assert_eq!(machine, RISC_V)`）
- 遍历所有 `PT_LOAD` 段，根据 `p_flags` 设置页权限（R/W/X）
- 将段内容按页复制到对应物理地址
- 分配用户栈：`USER_STACK_BASE` (0xBFFFFFF000) 向下 40 页

### 4.4 陷阱处理子系统 (trap/)

#### 4.4.1 TRAMPOLINE 机制

TRAMPOLINE 是内核和用户态之间的跳板页，在用户页表和内核页表中都映射到相同虚拟地址：

- **RISC-V TRAMPOLINE**：`0xFFFFFFFFFFFFF000`（虚拟地址空间最高页）
- **LoongArch TRAMPOLINE**：`0x00000000FFFFF000`

该页包含 `__alltraps`（陷入入口）和 `__restore`（恢复出口），通过 `.section .text.trampoline` 被放置在独立的链接段中，由链接脚本保证页对齐。

#### 4.4.2 RISC-V 陷阱入口 (`trap.S`)

```
__alltraps:
    csrrw sp, sscratch, sp     # sp ↔ TrapContext(VA)，sscratch ← 用户sp
    # 保存 31 个通用寄存器到 TrapContext.gp (偏移 0..31*8)
    sd x1, 1*8(sp)             # ra
    ...
    sd x31, 31*8(sp)
    # 保存 sepc → gp.pc (偏移 0)
    csrr t0, sepc; sd t0, 0*8(sp)
    # 保存 sstatus (偏移 34*8)
    csrr t0, sstatus; sd t0, 34*8(sp)
    # 恢复用户 sp (从 sscratch) → gp.sp (偏移 2*8)
    csrr t0, sscratch; sd t0, 2*8(sp)
    # 保存原始 a0 → origin_a0 (偏移 33*8)
    # 加载内核环境 (kernel_satp, trap_handler, kernel_sp)
    # 切换页表、跳转到 trap_handler
```

**恢复出口** (`__restore`):
```
    # a0: TrapContext VA, a1: 用户 SATP
    csrw satp, a1; sfence.vma
    csrw sscratch, a0; mv sp, a0
    # 恢复 sepc, sstatus, 通用寄存器 (除 sp)
    ld sp, 2*8(sp)             # 最后恢复 sp
    sret
```

#### 4.4.3 TrapContext 布局 (`trap/context.rs`)

```rust
#[repr(C)]
pub struct TrapContext {
    pub gp: GeneralRegs,      // 偏移 0*8..31*8 (32个通用寄存器)
    pub reserved: usize,      // 偏移 32*8 (对齐填充)
    pub origin_a0: usize,     // 偏移 33*8 (ecall 前的原始 a0)
    pub sstatus: usize,       // 偏移 34*8
    pub kernel_satp: usize,   // 偏移 35*8
    pub trap_handler: usize,  // 偏移 36*8 (trap_handler 函数地址)
    pub kernel_sp: usize,     // 偏移 37*8 (内核栈指针)
}
```

`GeneralRegs` 包含 32 个寄存器：pc(sepc), ra, sp, gp, tp, t0-t6, s0-s11, a0-a7。

初始化时 `sstatus` 设置为 `0x20 | (3 << 13)`：SPIE=1 (开中断), SPP=0 (回到 U-mode)。

#### 4.4.4 trap_handler 分发逻辑

```rust
pub fn trap_handler() -> ! {
    set_kernel_trap_entry();  // stvec → trap_from_kernel
    match scause.cause() {
        UserEnvCall => {
            cx.gp.pc += 4;   // 跳过 ecall
            result = syscall(syscall_id, args);
            cx.gp.a0 = result;
        }
        StoreFault | StorePageFault | LoadFault | LoadPageFault
        | InstructionFault | InstructionPageFault => {
            // 尝试惰性页故障处理 (handle_lazy_page_fault)
            // 失败则退出进程 (exit code 139 = SIGSEGV)
        }
        IllegalInstruction => exit 132 (SIGILL)
        Breakpoint => exit 133 (SIGTRAP)
        SupervisorTimer => {
            do_wake_expired();
            set_next_trigger();
            check_per_task_timeout();
            suspend_current_and_run_next();
        }
        _ => panic!()
    }
    trap_return();
}
```

**关键设计点**：
- 内核态 stvec 始终指向 `trap_from_kernel`（内核态异常视为 bug，直接 panic）
- 用户态 stvec 指向 TRAMPOLINE 中的 `__alltraps`
- 系统调用后在 `trap_return()` 前切换回用户 stvec
- 惰性页故障：内存区域已注册 (reserve) 但尚未分配物理页时按需分配

#### 4.4.5 LoongArch 陷阱处理差异

- 异常码寄存器为 ESTAT 的 ECode 字段（而非 scause）
- 系统调用码为 `ECODE_SYS = 0x0b`
- 缺页异常码为 `0x01..=0x07 | 0x09 | 0x0a`
- 使用 `ertn`（而非 `sret`）从异常返回
- 额外实现了 `__tlb_refill` 处理程序：硬件页表遍历失败时，软件遍历 PGD 并填充 TLB

### 4.5 系统调用子系统 (syscall/)

#### 4.5.1 系统调用注册

在 `syscall/mod.rs` 中注册了 **约 130 个** Linux RISC-V syscall ID。主要类别：

| 类别 | 数量 | 代表性调用 |
|------|------|-----------|
| 文件 I/O | ~30 | read, write, openat, close, lseek, readv, writev, pread64, pwrite64, sendfile, splice |
| 进程管理 | ~15 | clone, clone3, execve, exit, exit_group, wait4, waitid, fork(通过clone) |
| 内存管理 | ~10 | brk, mmap, munmap, mprotect, mremap, madvise, mlock* |
| 时间相关 | ~12 | nanosleep, clock_gettime, clock_nanosleep, gettimeofday, timerfd_* |
| 信号处理 | ~10 | kill, tkill, tgkill, sigaction, sigprocmask, sigpending, sigtimedwait, sigreturn |
| 文件系统元数据 | ~18 | fstat, newfstatat, getdents64, mkdirat, unlinkat, renameat, chdir, getcwd, mount, statfs |
| 网络/socket | ~14 | socket, bind, listen, accept, connect, sendto, recvfrom, setsockopt |
| 调度相关 | ~10 | sched_yield, sched_setaffinity, sched_getparam, getpriority |
| 杂项 | ~15 | uname, sysinfo, getrandom, getrlimit, prlimit64, getrusage, umask, eventfd2, epoll_*, signalfd4 |

#### 4.5.2 系统调用分发

```rust
pub fn syscall(id: usize, args: [usize; 6]) -> isize {
    match id {
        SYS_WRITE => fs::sys_write(a0, a1, a2),
        SYS_EXIT => process::sys_exit(a0 as u32),
        SYS_CLONE => process::sys_clone(a0 as u32, a1 as *const u8, ...),
        // ... 130+ 匹配分支
        _ => ENOSYS,  // 未实现的返回 -38
    }
}
```

#### 4.5.3 process.rs 实现分析（~2,293 行）

这是最大的模块，涵盖了进程、信号、时间、内存、epoll、eventfd、timerfd、socket 等系统调用。

**完整实现的关键系统调用：**

| 系统调用 | 实现质量 | 说明 |
|---------|---------|------|
| `sys_exit` | 完整 | 退出当前进程，通知父进程 (SIGCHLD)，通知 test_runner |
| `sys_exit_group` | 完整 | 终止所有子进程后退出 |
| `sys_getpid/getppid/gettid` | 完整 | 返回 PID/PPID/TID |
| `sys_clone` | 较完整 | 支持 CLONE_VM, CLONE_VFORK, CLONE_CHILD_CLEARTID，分 fork/clone_thread 路径 |
| `sys_execve` | 较完整 | 支持 PATH 查找（多前缀回退，含 busybox applet 检测），含 test_echo 直接模拟 |
| `sys_wait4/waitid` | 较完整 | 支持 WNOHANG，遍历子进程查找僵尸进程，写 rusage |
| `sys_nanosleep/clock_nanosleep` | 完整 | 基于 `sleep_current_until()`，到期后唤醒 |
| `sys_futex` | 基本 | 支持 FUTEX_WAIT/Wake，简化实现（单次 yield，非精确等待队列） |
| `sys_brk` | 完整 | 管理 `heap_bottom/heap_pt`，惰性映射 |
| `sys_mmap/munmap` | 较完整 | 支持 MAP_ANONYMOUS，基于惰性页故障 |
| `sys_kill/tkill/tgkill` | 基本 | 支持信号投递到就绪/睡眠/futex 队列中的进程 |
| `sys_sigprocmask/sigpending` | 完整 | 64位信号位图操作 |
| `sys_sigtimedwait` | 完整 | 等待信号（含超时），检测僵尸子进程的 SIGCHLD |
| `sys_ppoll/pselect6` | 完整 | 遍历 fd 集合，查询 FS_MANAGER 的 poll_events |
| `sys_getrandom` | 基本 | 基于纳秒时间戳的简单伪随机数生成 |
| `sys_ioctl` | 部分 | 只支持 TIOCGWINSZ (0x5413), TCGETS (0x5401), RTC_RD_TIME |
| `sys_timerfd_*` | 完整 | 创建/设置/读取 timerfd（基于 TimeSpec，支持 MONOTONIC/REALTIME） |
| `sys_eventfd2` | 完整 | 支持 SEMAPHORE 模式 |
| `sys_epoll_*` | 完整 | 支持 EPOLL_CTL_ADD/DEL，epoll_pwait（含信号屏蔽） |
| `sys_clock_gettime/getres` | 完整 | 返回 TimeSpec::now() |
| `sys_socket/bind/listen/accept/connect` | 部分 | 仅支持 AF_INET SOCK_STREAM，本地回环模拟 |
| `sys_uname` | 完整 | 返回硬编码 "Linux 6.1.0-hpu" 等 |
| `sys_getrlimit/setrlimit/prlimit64` | 完整 | 16 种资源限制 |
| `sys_getrusage` | 存根 | 返回全零 |

**存根/简单返回系统调用（返回 0 或简单值）：**
`getuid`, `geteuid`, `getgid`, `getegid`, `settimeofday`, `adjtimex`, `umask`, `set_robust_list`, `getpriority`, `sched_*`, `mlock*`, `syslog`, `sync`, `fsync`, `fdatasync`, `sync_file_range`, `fadvise64`, `msync`, `madvise`, `mprotect` (部分), `membarrier`, `rseq` 等。

#### 4.5.4 fs.rs 实现分析（~1,000 行）

文件系统系统调用：
- `sys_write`：通过 FS_MANAGER 写入
- `sys_read`：通过 FS_MANAGER 读取，管道空时重试（最多 128 次）
- `sys_openat`：路径解析 + `FS_MANAGER.open()`
- `sys_readv/sys_writev`：iovec 向量 I/O
- `sys_pread64/pwrite64/preadv/pwritev`：定位读写
- `sys_sendfile`：文件到文件零拷贝传输（64KB 块）
- `sys_lseek`：设置文件偏移
- `sys_close/dup/dup3`：文件描述符操作
- `sys_pipe2`：创建管道
- `sys_getdents64`：目录读取
- `sys_mkdirat/unlinkat/fchmodat/faccessat`：文件系统元数据操作
- `sys_fstat/newfstatat/statfs/fstatfs/statx`：文件/文件系统状态查询
- `sys_getcwd/chdir/fchdir`：工作目录管理
- `sys_mount/umount2`：挂载/卸载（简化实现）
- `sys_fcntl`：F_DUPFD, F_GETFD, F_SETFD, F_GETFL, F_SETFL 等

### 4.6 文件系统子系统 (fs/)

#### 4.6.1 EXT4 只读驱动 (`ext4.rs`)

实现了完整的 EXT4 只读支持，包括：

**超级块解析：**
```rust
pub struct Ext4Info {
    pub block_size: usize,        // 从 s_log_block_size 计算：1024 << log
    pub inode_size: usize,        // 从 s_inode_size 读取（默认 128）
    pub inodes_per_group: usize,  // s_inodes_per_group
    pub group_desc_size: usize,   // s_desc_size（默认 32，64位特性下为 64）
}
```

验证 EXT4 魔数 `0xef53`（偏移 0x38）。

**Inode 读取：**
- 计算 inode 所在块组：`group = (inode_no-1) / inodes_per_group`
- 从组描述符表中获取 inode table 块号（支持 64 位高 32 位）
- 读取 inode 所在块，提取 256 字节 inode 数据

**目录查找** (`lookup`)：
- 检查 inode 是否为目录（mode & 0x4000）
- 支持两类块映射：
  - **直接/间接块** (flags & 0x80000 == 0)：遍历 `i_block[0..12]`
  - **Extent 树** (flags & 0x80000 != 0)：解析 extent header（magic 0xf30a），遍历 extent 条目
- 在每个数据块中线性搜索目录项

**文件读取** (`read_file`)：
- 基于 extent 树或直接块映射定位逻辑块对应的物理块
- 支持跨块读取
- 对于空洞（sparse file），填充零

#### 4.6.2 虚拟文件系统抽象 (`vfs.rs`)

```rust
pub struct OpenFlags(pub usize);
impl OpenFlags {
    pub const RDONLY: Self = Self(0);
    pub const WRONLY: Self = Self(1 << 0);
    pub const RDWR: Self = Self(1 << 1);
    pub const CREATE: Self = Self(1 << 6);
    fn readable(self) -> bool;
    fn writable(self) -> bool;
}

pub trait File {
    fn readable(&self) -> bool;
    fn writable(&self) -> bool;
    fn read(&self, buf: &mut [u8]) -> isize;
    fn write(&self, buf: &[u8]) -> isize;
}
```

VFS 抽象是存在的，但在实际代码中 `FileHandle` 枚举直接实现了各类文件的操作，而非通过 `File` trait 多态。

#### 4.6.3 文件描述符表 (`fd_table.rs`)

```rust
pub struct FdTable {
    slots: [Option<FileDescriptor>; 256],  // 固定 256 槽位
    hard_limit: usize,                      // 可设置的硬限制
}

pub struct FileDescriptor {
    pub object_id: usize,   // 全局对象 ID
    pub cloexec: bool,      // close-on-exec 标志
    pub nonblock: bool,     // 非阻塞标志
}
```

- `insert(min_fd)`：从最小 fd 开始查找空槽
- `dup3(old_fd, new_fd)`：复制到指定 fd（覆盖已有）
- `close(fd)`：关闭并取出描述符
- 硬限制默认 256

#### 4.6.4 文件系统管理器 (`manager.rs` - ~2,209 行)

这是内核中最大的单一模块，实现了一个完整的进程级文件系统视图管理器。

**FileHandle 枚举：** 定义了所有可打开文件类型：

```rust
enum FileHandle {
    Stdin, Stdout, Stderr,           // 标准流
    DevNull, DevZero, DevRandom,     // 设备文件
    Ext4(Ext4File),                  // EXT4 文件
    Mem(MemOpenFile),                // 内存文件（tmpfs 模拟）
    Dir { path, offset },            // 目录句柄
    PipeRead(usize), PipeWrite(usize), // 管道端
    Socket(usize),                   // Socket
    Epoll(usize),                    // Epoll 实例
    EventFd(usize),                  // Eventfd
    TimerFd(usize),                  // Timerfd
    SignalFd(usize),                 // Signalfd
}
```

**FsManager 结构：**
```rust
pub struct FsManager {
    pub fd_table: FdTable,           // 全局 fd 表（用于初始进程）
    pub fs: Ext4Fs,                  // EXT4 文件系统实例
    files: Vec<Option<FileHandle>>,  // 文件句柄表
    views: Vec<ProcessFsView>,       // 每进程 FS 视图
    active_pid: usize,               // 当前活跃 PID
    mem_nodes: Vec<MemNode>,         // 内存文件节点
    pipes: Vec<Pipe>,                // 管道
    sockets: Vec<Socket>,            // Socket
    epolls: Vec<EpollInstance>,      // Epoll
    eventfds: Vec<EventFd>,          // Eventfd
    timerfds: Vec<TimerFd>,          // Timerfd
    signalfds: Vec<SignalFd>,        // Signalfd
    cwd: Vec<u8>,                    // 当前工作目录
}
```

**进程级 FS 视图** (`ProcessFsView`)：
- 每个进程有独立的 fd table、文件句柄副本、CWD
- fork 时复制父进程视图
- `switch_to_process(pid)` 切换活跃 PID

**管道实现：**
```rust
struct Pipe {
    data: Vec<u8>,
    read_offset: Cell<usize>,
    wrote_once: bool,
    writers: usize,
}
```
- 读端和写端共享同一个 Pipe 索引
- 当管道空且 `wrote_once && writers == 0` 时返回 EOF (0)
- 当管道空但 writers 仍存在时返回 EAGAIN

### 4.7 设备驱动子系统 (drivers/)

#### 4.7.1 virtio-blk 块设备驱动 (`block.rs`)

实现了基于 **virtio-mmio legacy** 接口的块设备驱动：

**设备探测** (`VirtioMmioBlock::probe_first()`)：
- 扫描 MMIO 区域 `0x1000_1000` 起始，步长 `0x1000`，最多 8 个设备
- 验证 Magic Value (`0x74726976`) 和 Device ID (2 = 块设备)

**初始化流程：**
1. 检查版本为 legacy (1)
2. 写 STATUS: ACKNOWLEDGE | DRIVER
3. 写 DRIVER_FEATURES: 0（不接受可选特性）
4. 设置队列：QUEUE_NUM = 8，QUEUE_PFN = queue 物理地址 >> 12
5. 写 STATUS: DRIVER_OK

**队列结构** (legacy split virtqueue)：
```
VirtQueue (4096 字节对齐):
  desc[8]:     descriptor 数组 (16 字节/项)
  avail:       available ring (flags + idx + ring[8])
  padding:     到页边界
  used:        used ring (flags + idx + ring[8])
```

**读取扇区** (`read_sector`)：
- 构建三描述符链：请求头 (IN) → 数据缓冲区 (IN, WRITE) → 状态字节 (WRITE)
- 将描述符 0 写入 available ring
- 通知设备 (QUEUE_NOTIFY = 0)
- 轮询等待 used ring 更新（最多 100,000 次）
- 检查状态字节为 `VIRTIO_BLK_S_OK (0)`

**EXT4 块读取适配：**
```rust
pub fn read_ext4_block(block_id: usize, buf: &mut [u8; 4096]) -> Result<(), ()>
```
将 4096 字节块拆分为 8 个 512 字节扇区读取。

---

### 4.8 计时器子系统 (`timer.rs`)

**RISC-V：**
- `get_time()`：`rdtime` 指令读取 mtime CSR
- `set_timer(stime_value)`：通过 SBI ecall (a7=0) 设置 mtimecmp
- `set_next_trigger()`：当前时间 + `TIMER_INTERVAL` (5,000,000 周期 ≈ 50ms @ 100MHz)
- `TimeVal` / `TimeSpec` 结构体，支持加减运算

**LoongArch：**
- `get_time()`：`rdtime.d` 指令
- `set_timer_delta(delta)`：写 CSR TCFG（bit0=enable, bit1=periodic, bits[63:2]=init value）
- `clear_timer()`：写 CSR TICLR

---

### 4.9 控制台/日志子系统

**RISC-V 控制台：**
- 基于 `sbi_rt::legacy::console_putchar/getchar`
- 实现了 `fmt::Write` trait，支持 `print!`/`println!` 宏
- 集成了 `log` crate（`log::Log` trait），级别为 Info

**LoongArch 控制台：**
- 直接 MMIO 访问 NS16550 UART (`0x9000_0000_1fe0_01e0`)
- `console_putchar` 中自动将 `\n` 转换为 `\r\n`
- 带忙等待发送就绪检查（最多 100,000 次）

**输入处理 (`input.rs`)：**
- `what_you_type()`：交互式按键回显（ESC 退出）
- `getchar()`：阻塞式获取单个字符
- `read_line(buffer)`：读取一行输入，支持退格删除
- `shell()`：简单交互式 shell（命令：help, echo, mm, task, stop, interrupt, intoff, shutdown）

---

### 4.10 评测框架 (`test_runner.rs`)

**RISC-V 版本 (494 行，含重复)** / **LoongArch 版本 (265 行，无重复)**

运行模式：
1. `start_from_disk()` → 探测 EXT4 磁盘中的 `/basic` 目录
2. 检测 `/skip_basic` 标记文件
3. 遍历预定义测试列表 `BASIC_TESTS`（32 个基础测试）
4. 依次执行每个测试：
   - 输出 `#### OS COMP TEST GROUP START {name} ####`
   - 从 EXT4 读取 ELF → 创建 Task → 加入就绪队列
   - 输出 `#### OS COMP TEST GROUP END {name} ####`
5. 支持扩展测试组 `EXTENDED_GROUPS`（busybox, lua, libctest, iozone 等）
6. `on_root_task_exit()` 回调：任务退出时自动推进到下一个测试
7. 全局超时检测（30 秒）

**关键设计点：**
- 根任务（parent 为 None）退出时自动触发下一个测试
- 子进程（fork 出来的）退出不会推进测试组
- 通过 `RUNNER: Mutex<RunnerState>` 管理全局状态

---

### 4.11 LoongArch 特有模块

#### 4.11.1 CSR/DMW 操作 (`loongarch_csr.rs`)

定义了所有 LoongArch CSR 常量和内联操作函数：
- `CSR_CRMD` (0x0)：当前模式控制（DA/PG/IE/PLV）
- `CSR_PRMD` (0x1)：先前模式信息
- `CSR_ECFG` (0x4)：异常配置
- `CSR_ESTAT` (0x5)：异常状态
- `CSR_ERA` (0x6)：异常返回地址
- `CSR_BADV` (0x7)：故障虚拟地址
- `CSR_EENTRY` (0xc)：通用异常入口
- `CSR_PGDL/PGDH` (0x19/0x1a)：页表基址低/高 64 位
- `CSR_DMW0/DMW1` (0x180/0x181)：直接映射窗口
- `CSR_TCFG/TVAL/TICLR`：计时器配置/值/清除
- `CSR_TLBRENTRY` (0x88)：TLB 重填入口

**DMW 直接映射窗口：**
```rust
pub fn init_direct_map() {
    // VSEG=0x9 (高 4 位), PLV0, MAT=1 (缓存), base=0
    let dmw0 = (0x9usize << 60) | (1usize << 4) | 1usize;
    write_csr::<CSR_DMW0>(dmw0);
}
```
DMW0 将虚拟地址 `0x9000_0000_0000_0000` 以上直接映射到物理地址 `0x0000_0000_0000_0000` 以上，绕过页表遍历。

---

## 五、子系统交互关系

### 5.1 系统调用完整路径

```
用户程序
  ↓ ecall / syscall 指令
__alltraps (trap.S)
  ↓ 保存寄存器 → 切换 satp → 切换内核栈
trap_handler() (trap/mod.rs)
  ↓ 读取 scause / ESTAT.ECode
  ↓ UserEnvCall / ECODE_SYS
syscall(id, args) (syscall/mod.rs)
  ↓ match id → sys_*()
  ↓ fs::sys_*() / process::sys_*()
FS_MANAGER / TaskControlBlock
  ↓ 返回结果
trap_return() (trap/mod.rs)
  ↓ 切换 stvec → 用户 satp
__restore (trap.S)
  ↓ 恢复寄存器 → sret / ertn
用户程序
```

### 5.2 进程创建完整路径

```
sys_execve / sys_clone
  ↓
TaskControlBlock::new_with_args() / TaskControlBlock::fork()
  ↓
MemorySet::new_bare() → PageTable::new() (分配根页表)
  ↓
MemorySet::map_trampoline() / map_trap_context()
  ↓
load_elf() → MemorySet::insert_framed_area() (分配物理页 + 建立映射)
  ↓
build_user_stack() (argc, argv, envp, auxv)
  ↓
TrapContext::app_init_context() → 写入 TrapContext 物理页
  ↓
TaskControlBlock 组装 → add_task() → 加入就绪队列
```

### 5.3 上下文切换路径

```
时钟中断 / sys_yield / sys_exit
  ↓
trap_handler() → suspend_current_and_run_next() / exit_current_and_run_next()
  ↓
take_current_task() → 从 Processor 取出
  ↓
设置 task_status → add_task() / park_zombie()
  ↓
schedule(task_cx_ptr)
  ↓
__switch(current_cx, idle_cx) → 回到调度循环
  ↓
run_tasks() → fetch_task() → __switch(idle_cx, next_cx) → 进入新任务
```

### 5.4 文件 I/O 路径

```
sys_read(fd, buf, count)
  ↓
translated_byte_buffer(token, buf, count) → UserBuffer (物理页切片)
  ↓
FS_MANAGER.lock().read(fd, &mut read_buf)
  ↓
active_pid 对应的 ProcessFsView.fd_table.get(fd)
  ↓
FileHandle 匹配:
  - Ext4(file) → file.read(buf) → Ext4Fs::read_file()
      ↓ ext4_physical_block() → read_block() → BlockDevice::read_ext4_block()
  - PipeRead(pipe) → pipes[pipe].data 读取
  - Stdin → console_getchar()
  - DevNull → 返回 0
  - DevZero → 填充 0
  - DevRandom → 伪随机数
  ↓
UserBuffer::write(&read_buf) → 写回用户缓冲区
```

---

## 六、实现完整度评估

### 6.1 各子系统完整度

| 子系统 | 完整度 | 评估基准 |
|--------|--------|---------|
| **内存管理** | 75% | 缺：共享内存、COW fork、页换出、NUMA、大页支持 |
| **进程管理** | 70% | 有 fork/clone/execve/wait4/exit；缺：完整信号处理、cgroup、namespace、ptrace |
| **文件系统** | 65% | EXT4 只读 + 内存文件；缺：写入支持、其它 FS、VFS 完整抽象、inode 缓存 |
| **系统调用** | 50% | 注册 ~130 个，约 60 个有实际实现，其余为存根或简单返回 |
| **设备驱动** | 30% | 仅 virtio-blk (legacy)；缺：virtio-net、virtio-gpu、PCI 总线枚举 |
| **中断处理** | 60% | 有时钟中断和缺页处理；缺：外部中断框架、多核 IPI |
| **网络** | 15% | socket 系列有基础框架，仅本地回环；缺：实际网络栈 |
| **信号** | 40% | 有信号位图、投递机制、sigtimedwait；缺：信号处理函数调用、sigreturn 真实实现 |
| **评测框架** | 80% | 支持 EXT4 扫描 + 串行测试；RISC-V 版有代码重复 bug |

### 6.2 整体内核实现完整度

以 Linux 内核为参照基准（100%），该 OS 约实现了 **35-40%** 的核心 OS 功能。它在以下方面做了足够的工作来运行基本的竞赛测试程序：进程生命周期管理、EXT4 只读文件访问、内存分配与映射、基本的 IPC（管道/futex/signal）。

但在以下方面存在显著不足：无写入文件系统、无真实网络栈、信号处理不完整、设备驱动覆盖面窄。

---

## 七、设计与创新性分析

### 7.1 架构设计特点

1. **双架构对称设计**：RISC-V 和 LoongArch 共享 >90% 的逻辑代码，仅架构相关部分（页表格式、CSR、异常入口）有差异。这体现了良好的跨架构抽象能力。

2. **TRAMPOLINE 跳板机制**：借鉴 rCore-Tutorial 的设计，将陷入/恢复代码放在独立页中，同时映射到用户和内核地址空间。这一设计避免了运行时修改 stvec 带来的安全问题。LoongArch 额外实现了软件 TLB 重填 (`__tlb_refill`)，利用了该架构的硬件页表遍历支持。

3. **惰性页故障处理**：`handle_lazy_page_fault` 允许 mmap 预注册大范围区域但不立即分配物理页，实现了基本的内存按需分配。这一机制在竞赛场景下比完整实现 COW fork 更简单有效。

4. **进程级文件系统视图**：`ProcessFsView` 为每个进程维护独立的 fd table 和工作目录，支持 fork 时的正确继承语义。这是该内核与 rCore-Tutorial 相比的一个重要增强。

5. **评测框架集成**：`test_runner.rs` 深度嵌入内核，支持自动扫描 EXT4 磁盘、串行执行测试、超时看门狗和状态标记输出。这种"内核原生测试编排器"的设计在竞赛场景下很实用。

### 7.2 创新程度评估

**创新性：中等偏低**。该项目的架构设计高度参照 rCore-Tutorial-v3（TRAMPOLINE 机制、TCB 结构、Sv39 页表），功能实现上参考了 NPUcore。其主要原创贡献在于：

1. **LoongArch 双架构移植**：独立实现了 LoongArch 的 CSR 操作、DMW 配置、页表格式、异常处理，这需要深入理解两个架构的差异。

2. **EXT4 只读驱动的完整实现**：从超级块解析到 extent 树遍历，实现了可用的 EXT4 读取能力，支持 64 位特性。

3. **竞赛导向的工程优化**：包括惰性页故障、进程级 FS 视图、评测框架、看门狗机制等。

### 7.3 代码质量观察

**优点：**
- 代码注释较为详细（中文注释）
- 模块化结构清晰
- 使用了 RAII 模式管理资源（FrameTracker, PidHandle）

**不足：**
- `test_runner.rs` 存在代码重复（编译失败的根本原因）
- 部分存根返回硬编码值（如 `sys_uname`），可能误导测试程序
- 信号处理仅有数据结构和投递机制，缺少实际的用户态信号处理函数调用
- Futex 实现过于简化（仅 yield 一次，非精确等待队列）
- 无单元测试覆盖

---

## 八、其他重要信息

### 8.1 配置常量

| 常量 | RISC-V | LoongArch |
|------|--------|-----------|
| `PAGE_SIZE` | 4096 | 4096 |
| `TASK_SIZE` | 0xC0000000 | 0xC0000000 |
| `USER_STACK_BASE` | 0xBFFFFFF000 | 0xBFFFFFF000 |
| `USER_STACK_SIZE` | 40 页 (160KB) | 40 页 |
| `MMAP_BASE` | 0x60000000 | 0x60000000 |
| `MEMORY_END` | 0x88000000 (128MB) | DMW+0x08000000 |
| `CLOCK_FREQ` | 100MHz | 100MHz |
| `TIMER_INTERVAL` | 5,000,000 周期 (~50ms) | 5,000,000 周期 |
| `KERNEL_HEAP_SIZE` | 256 页 (1MB) | 256 页 |
| `SYSTEM_TASK_LIMIT` | 128 | 128 |
| `SYSTEM_FD_LIMIT` | 256 | 256 |

### 8.2 外部依赖

| Crate | 版本 | 用途 |
|-------|------|------|
| `sbi-rt` | 0.0.2 | RISC-V SBI 调用（legacy 模式） |
| `riscv` | 0.10 | RISC-V CSR 寄存器操作 |
| `buddy_system_allocator` | 0.9 | 伙伴系统堆分配器 |
| `spin` | 0.7 | 自旋锁（Mutex） |
| `lazy_static` | 1.4 | 全局静态变量延迟初始化 |
| `bitflags` | 2.13.0 | 位标志宏 |
| `xmas-elf` | 0.10.0 | ELF 文件解析 |
| `log` | 0.4 | 日志抽象层 |

### 8.3 Rust 工具链需求

- 版本：`nightly-2025-05-20`
- 特性：`#![feature(alloc_error_handler)]`（RISC-V 和 LA 都使用）

---

## 九、项目总结

### 优势

1. **双架构覆盖**：RISC-V 和 LoongArch 两套内核，架构抽象合理，代码复用率高。
2. **功能覆盖面广**：在进程管理、内存管理、文件系统和系统调用四大领域都有实质性实现，130+ 个 syscall ID 的注册量在参赛项目中较为突出。
3. **EXT4 驱动较完整**：从超级块到 extent 树的只读驱动，能够从真实 EXT4 磁盘镜像加载测试程序。
4. **竞赛工程化成熟**：Makefile 支持双架构构建，评测框架深度集成，看门狗超时机制完善。

### 不足

1. **编译缺陷**：RISC-V 的 `test_runner.rs` 存在模块内容重复，导致编译失败。这是当前最严重的质量问题。
2. **存根比例高**：约 50% 的已注册 syscall 仅返回 0 或 ENOSYS，可能误导依赖这些调用的复杂测试程序。
3. **信号处理不完整**：数据结构完备但缺少用户态信号 handler 调用机制。
4. **Futex 实现简化**：非精确等待队列，可能导致多线程同步测试不稳定。
5. **无写入文件系统**：EXT4 仅支持只读，限制了文件系统相关测试的深度。
6. **缺少并发支持**：单核调度，无 SMP 支持，无多核同步原语。
7. **设备驱动覆盖窄**：仅有 legacy virtio-blk，无网络、显示等驱动。

### 综合评估

HPU OS 是一个面向全国大学生计算机系统能力大赛的功能型教学/竞赛内核。它在 rCore-Tutorial-v3 的基础上进行了显著的功能增强（EXT4 驱动、双架构移植、竞赛评测框架），展现了参赛团队在操作系统核心概念上的扎实理解和工程实践能力。尽管存在编译缺陷和部分功能简化的问题，但总体上是一个结构清晰、覆盖面广、具有实用价值的参赛项目。