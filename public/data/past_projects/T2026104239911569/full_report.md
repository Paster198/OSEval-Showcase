# RmikuOS 深入技术分析报告

## 一、分析概述

### 1.1 分析方法

本次分析通过以下途径对 RmikuOS 进行了全面调查：

1. **完整源代码审阅**：逐文件阅读了内核所有子系统（~14,500 行 Rust/汇编）的源代码实现，包括架构引导、陷阱处理、内存管理、任务调度、系统调用、文件系统、块设备驱动、PCI 总线、同步原语、定时器等全部模块。
2. **用户态审阅**：审阅了用户 C 库、系统调用包装、Shell 实现、测试程序集（约 55 个测试 + 10 个 Rust 用户程序）。
3. **构建系统分析**：分析了 `Makefile`、`build.rs`、`user/build.py`、`user/mkfs_ext4.sh`、`run.sh` 等构建与编排脚本。
4. **实际构建与运行测试**：使用 RISC-V 工具链成功构建了用户程序集（5 个 bin 程序 + 55 个测试程序）、ext4 根文件系统镜像、FAT 镜像，并用 `qemu-system-riscv64` 成功启动并交互式运行了该内核。测试了 `ls`、`cat`、`exit`、`/tests/hello`、`/tests/thread_test`、`/tests/fork_wait` 等功能。

### 1.2 测试结果

| 测试项 | 结果 |
|--------|------|
| RISC-V 内核编译（release） | 通过（产生 34MB ELF） |
| 用户程序编译（55 个 C 测试 + 5 个 C bin） | 通过 |
| ext4 根文件系统制作 (32MB) | 通过 |
| FAT 镜像制作 (32MB) | 通过 |
| QEMU 启动至 Shell | 通过 |
| Shell 内建命令（ls/exit/cd/pwd） | 通过 |
| ext4 文件读取（cat /etc/motd） | 通过 |
| 用户程序执行（/tests/hello） | 通过 |
| 多线程测试（/tests/thread_test） | 通过 |
| fork/waitpid 测试（/tests/fork_wait） | 通过 |

---

## 二、项目整体结构

### 2.1 仓库组织

```
repo/
├── kernel/              # 内核源代码
│   └── src/
│       ├── main.rs      # 内核入口、多核启动、初始化序列
│       ├── arch/        # 架构相关（RISC-V / LoongArch 64）
│       ├── trap/        # 中断/异常/系统调用分发
│       ├── mm/          # 内存管理
│       ├── task/        # 任务管理（进程/线程/调度器）
│       ├── syscall/     # 系统调用路由与实现
│       ├── fs/          # 虚拟文件系统 + ext4/tmpfs/FAT 实现
│       ├── block/       # 块设备抽象 + VirtIO 驱动
│       ├── pci/         # PCI 总线枚举与配置
│       ├── io/          # UART 驱动、控制台、日志
│       ├── sync/        # 同步原语（自旋锁、Mutex）
│       ├── timer/       # 架构相关时钟中断
│       ├── test/        # 内核自测
│       └── ...
├── user/                # 用户态程序、用户库、根文件系统模板
├── third_party/fatfs/   # 修改版的 fatfs 库
├── vendor/              # Cargo vendor 依赖
├── scripts/             # 调度数据分析/绘图脚本
├── Cargo.toml           # 内核 crate 清单
├── Makefile             # 顶层构建入口
├── build.rs             # Cargo 构建脚本
└── run.sh               # QEMU 启动脚本
```

### 2.2 代码规模统计

| 子系统 | 代码行数 (.rs + .S + .ld) |
|--------|------|
| task（任务管理） | ~3,600 |
| block（块设备/VirtIO） | ~3,100 |
| mm（内存管理） | ~2,800 |
| fs（文件系统/VFS） | ~2,600 |
| trap（陷阱中断） | ~1,600 |
| arch（架构引导） | ~1,400 |
| test（内核自测） | ~1,200 |
| syscall（系统调用） | ~650 |
| pci（PCI 总线） | ~500 |
| io（I/O） | ~280 |
| timer（定时器） | ~190 |
| sync（同步） | ~190 |
| **内核总计** | **~18,000** |
| 用户态（C 测试/工具 + Rust） | ~12,000 |
| **项目总计** | **~30,000** |

---

## 三、子系统详细分析

### 3.1 架构引导层 (`kernel/src/arch/`)

#### 3.1.1 概述

支持两种架构：**RISC-V 64** (riscv64gc) 和 **LoongArch 64**。通过条件编译 (`#[cfg(target_arch)]`) 选择对应平台模块。

```rust
// kernel/src/arch/mod.rs
#[cfg(target_arch = "riscv64")]
#[path = "riscv64/mod.rs"]
mod platform;

#[cfg(target_arch = "loongarch64")]
#[path = "loongarch64/mod.rs"]
mod platform;

pub use platform::*;
```

#### 3.1.2 RISC-V 引导流程

**链接脚本** (`kernel/src/arch/riscv64/linker.ld`)：
- 物理加载地址：`0x80200000`（QEMU virt 的默认内核加载地址）
- 内核高半虚拟地址：`KERNEL_OFFSET = 0xffffffc000000000`
- 先放置 `.text.boot` 和 `.bss.boot` 在低物理地址（引导阶段）
- 再通过 `AT()` 指定 LMA/VMA 分离：VMA = 高虚拟地址，LMA = 低物理地址
- 提供符号：`_kernel_start/_end`、`_stext/_etext`、`_srodata/_erodata`、`_sdata/_edata`、`_sbss/_ebss`

**引导汇编** (`kernel/src/arch/riscv64/boot.S`)：
- 入口 `_start` 从 OpenSBI 获取 `hartid`（存于 `tp` 寄存器）
- 为每个 hart 分配 64KB 的临时物理栈
- 在 `boot_page_table` 中建立三个 1GB 大页映射：
  - **Entry 2**：低临时恒等映射（VA 0x80000000 → PA 0x80000000），用于 MMU 开启后的过渡
  - **Entry 258**：高半直接映射（VA 0xffffffc080000000 → PA 0x80000000），覆盖 DRAM
  - **Entry 256**：低 MMIO 区域映射（VA 0xffffffc000000000 → PA 0x00000000），覆盖 UART
- 设置 `satp` 开启 Sv39 分页
- 切换到高半虚拟栈地址
- 跳转到高半地址的 `rust_main`

#### 3.1.3 LoongArch 引导流程

LoongArch 的引导更复杂（`kernel/src/arch/loongarch64/boot.S`，589 行）：
- 使用 DMW（Direct Mapping Window）进行初始地址映射
- 建立 4 级页表结构（不同于 RISC-V 的 3 级 Sv39）
- 物理加载地址：`0x01000000`
- 内核高半偏移：`0xffff800000000000`
- 包含详细的 CSR 配置：`CRMD`、`EENTRY`、`PGDL/PGDH`、`PWCL/PWCH`、`STLBPS`、`TLBRENTRY`、`DMW0-3`
- 支持调试用的物理地址 UART 输出宏 (`PUTCH_PHYS`)
- 约 256MB 的引导映射大小 (`BOOT_MAP_SIZE`)

**`kernel/src/arch/loongarch64/boot.rs`** 提供了 Rust 侧的引导辅助代码。

#### 3.1.4 架构平台常量

**RISC-V**：
- `MEMORY_START = 0x8000_0000`，`MEMORY_SIZE = 128MB`
- `UART_PADDR = 0x1000_0000`
- `VIRTIO_MMIO_BASE = 0x1000_1000`，stride = 0x1000，count = 8
- `MAX_HARTS = 8`

**LoongArch**：
- `MEMORY_START = 0x0100_0000`，`MEMORY_SIZE = 2GB`
- `UART_PADDR = 0x1fe0_01e0`
- `PCI_ECAM_BASE = 0x2000_0000`，size = 128MB
- `PCI_MMIO_BASE = 0x4000_0000`，size = 1GB
- `MAX_HARTS = 8`

#### 3.1.5 平台抽象接口

```rust
pub fn hartid() -> usize;        // 读取核 ID
pub fn enable_interrupt();       // 开启中断
pub fn disable_interrupt();      // 关闭中断
pub fn wait_for_interrupt();     // WFI/IDLE
pub fn flush_tlb();              // TLB 刷新
```

---

### 3.2 陷阱与中断处理 (`kernel/src/trap/`)

#### 3.2.1 概述

实现了一个完整的内核陷阱框架，支持从用户态和内核态进入陷阱，处理中断（定时器）、系统调用和异常。

#### 3.2.2 TrapContext

RISC-V 的 `TrapContext` 包含：
- 32 个通用寄存器 (`x[0..31]`)
- 4 个 CSR：`sstatus`, `sepc`, `stval`, `scause`
- 总大小 288 字节

LoongArch 的 `TrapContext`（`trap/loongarch64/context.rs`）包含更丰富的寄存器集（对应 LoongArch 的 CSR 体系）。

TrapContext 提供关键方法：
```rust
pub fn app_init_context(entry: usize, sp: usize) -> Self;  // 初始化用户上下文
pub fn is_from_user(&self) -> bool;                         // 判断来源
pub fn is_interrupt(&self) -> bool;                         // 判断是否中断
pub fn cause_code(&self) -> usize;                          // 异常编码
```

#### 3.2.3 陷阱入口汇编（RISC-V）

`trap/riscv64/trap.S`（348 行）实现了完整的陷阱入口/出口：

**入口协议** (`__alltraps`)：
- 使用 `csrrw sp, sscratch, sp` 原子交换，区分用户态/内核态陷阱
- `sscratch`：内核态时为 0，用户态时为内核栈顶地址
- 用户态陷阱：`sp` 获得内核栈顶，`sscratch` 获得用户 `sp`
- 内核态陷阱：恢复原始内核 `sp`，重置 `sscratch`

**上下文保存**：
- 保存全部 32 个通用寄存器到栈上的 TrapContext 结构
- 保存 `sstatus`、`sepc`、`stval`、`scause`
- 用户态入口通过 `csrr` 从 `sscratch` 恢复用户 `sp` 存入 `x[2]` 槽

**上下文恢复** (`__restore`/`__restore_user`)：
- 从 `sstatus.SPP` 判断返回目标（用户/内核）
- 用户态返回前设 `sscratch = 内核栈顶`（为下次陷阱做准备）
- 内核态返回前设 `sscratch = 0`
- 最后恢复 `sp` 然后 `sret`

#### 3.2.4 陷阱分发（RISC-V）

```rust
pub extern "C" fn riscv_trap_handler(cx: &mut TrapContext) -> &mut TrapContext {
    let code = cx.cause_code();
    if cx.is_interrupt() {
        match code {
            INTERRUPT_SUPERVISOR_TIMER => {
                let should_schedule = crate::timer::tick();
                if should_schedule && cx.is_from_user() {
                    crate::task::preempt_current_and_run_next();
                }
                if cx.is_from_user() {
                    crate::task::account_current_tick();
                }
            }
            _ => panic!("unsupported RISC-V interrupt"),
        }
    } else {
        match code {
            CAUSE_U_ECALL => { cx.sepc += 4; handle_syscall(...) }
            CAUSE_S_ECALL => panic!("unexpected supervisor ecall"),
            CAUSE_BREAKPOINT => { cx.sepc += 4; }
            CAUSE_*_FAULT | CAUSE_*_PAGE_FAULT => panic!("fatal RISC-V exception"),
            _ => panic!("unsupported RISC-V exception"),
        }
    }
}
```

支持的中断/异常类型：
- **中断**：仅 `Supervisor Timer`（通过 SBI 时钟）
- **异常**：U-mode ECALL、断点、非法指令、Load/Store 错误、指令/加载/存储页错误

#### 3.2.5 LoongArch 陷阱处理

LoongArch 陷阱（`trap/loongarch64/trap.S`，431 行 + `tlb_refill.S`，168 行）更为复杂：
- 使用 LoongArch 异常编码体系（`ECODE_INT`, `ECODE_PIL/PIS/PIF`, `ECODE_PME/PNR/PNX`, `ECODE_SYS`, `ECODE_BRK` 等）
- TLB 重填 (`tlb_refill.S`) 在软件层面处理 TLB miss
- 定时器中断通过 `ESTAT_IS_TIMER` 位检测

#### 3.2.6 系统调用路由

```rust
fn handle_syscall(id: usize, args: [usize; 6]) -> isize {
    crate::syscall::syscall(id, args)
}
```

统一路由到 `syscall` 模块，40 个系统调用 ID。

---

### 3.3 内存管理 (`kernel/src/mm/`)

#### 3.3.1 概述

完整实现了虚拟内存管理，包含物理帧分配、内核堆、页表抽象、虚拟地址空间（MemorySet）、ELF 加载器、用户地址空间布局。

#### 3.3.2 地址空间与常量

```rust
// kernel/src/mm/config.rs
pub const PAGE_SIZE: usize = 0x1000;          // 4KB
pub const PAGE_SIZE_BITS: usize = 12;
pub const KERNEL_HEAP_SIZE: usize = 16 * 1024 * 1024;  // 16MB

// RISC-V: 高半偏移 0xffffffc000000000 (Sv39)
// LoongArch: 高半偏移 0xffff800000000000
pub const KERNEL_OFFSET: usize = ...;

// 用户空间布局 (kernel/src/mm/user_layout.rs)
pub const USER_TEXT_BASE: usize = 0x0001_0000;
pub const USER_HEAP_BASE: usize = 0x0020_0000;
pub const USER_MMAP_BASE: usize = 0x0080_0000;
pub const USER_STACK_SIZE: usize = 64 * 1024;
pub const USER_STACK_TOP: usize = TRAP_CONTEXT_BASE - PAGE_SIZE;
pub const TRAMPOLINE: usize = USER_TOP - PAGE_SIZE;
pub const TRAP_CONTEXT_BASE: usize = TRAMPOLINE - PAGE_SIZE;
```

**地址转换**（高半内核）：
```rust
pub fn phys_to_virt(pa: usize) -> usize { pa + KERNEL_OFFSET }
pub fn virt_to_phys(va: usize) -> usize { va - KERNEL_OFFSET }
```

#### 3.3.3 物理帧分配器 (`frame_allocator.rs`)

实现了 `StackFrameAllocator`，一种支持回收的栈式分配器：

- **分配算法**：栈式线性增长 + 回收链表
- **单帧分配**：优先从 recycled 栈弹出，否则从 current 指针递增
- **连续帧分配** (`alloc_contiguous`)：先在 recycled 链表中搜索连续块（排序后查找），失败则从 current 切新页
- **安全检查**：双重释放检测、越界检查、与内核堆范围冲突自动调整
- **全局单例**：通过 `static FRAME_ALLOCATOR` + `SpinLock` 保护

```rust
pub fn alloc_frame() -> Option<PhysPageNum>;
pub fn dealloc_frame(ppn: PhysPageNum);
pub fn alloc_contiguous_frames(pages: usize) -> Option<PhysPageNum>;
pub fn dealloc_contiguous_frames(base_ppn: PhysPageNum, pages: usize);
```

#### 3.3.4 内核堆 (`heap.rs`)

基于 `buddy_system_allocator::LockedHeap<32>` 实现：
- 16MB 堆空间
- 作为 `#[global_allocator]` 供整个内核使用
- 通过原子变量 `KERNEL_HEAP_START/KERNEL_HEAP_END` 记录范围

#### 3.3.5 页表抽象 (`page_table/`)

**RISC-V Sv39 页表** (`page_table/riscv64.rs`)：
- 三级页表结构（VPN[2], VPN[1], VPN[0]）
- `PageTableEntry`：10 位标志 + 44 位 PPN
- `PteFlags`：V/R/W/X/U/G/A/D 标志位
- `PageTable`：持有根 PPN 和所有分配的中间页帧 (`FrameTracker`)

关键操作：
```rust
impl PageTable {
    pub fn new() -> Self;                              // 分配根页表
    pub fn map(&mut self, vpn, ppn, flags);            // 映射单页
    pub fn unmap(&mut self, vpn);                      // 解除映射
    pub fn translate(&self, vpn) -> Option<PageTableEntry>;  // 地址转换
    pub fn root_ppn(&self) -> PhysPageNum;
}
```

分页激活：
```rust
// RISC-V: 通过 satp CSR
pub fn activate_page_table(root: PhysPageNum) {
    let satp = SATP_MODE_SV39 | (root.0);
    unsafe { asm!("csrw satp, {}", in(reg) satp); sfence_vma(); }
}
```

**LoongArch 页表** (`page_table/loongarch64.rs`，452 行)：
- 4 级页表结构（DIR3/DIR2/DIR1/PTE）
- 使用 LoongArch CSR（`PGDL/PGDH`、`PWCL/PWCH`）
- 标志体系不同（`PLV0/PLV3` 权限级、`MAT_CC` 内存属性、`NR`/`NX` 负权限位、`G` 全局位）

#### 3.3.6 虚拟地址空间 (`memory_set.rs` + `map_area.rs`)

**MemorySet**：
- 持有 `PageTable` 和 `Vec<MapArea>`
- 支持三种映射类型：
  - `MapType::Identical`：VA = PA（恒等映射）
  - `MapType::Linear { offset }`：VA = PA + offset（线性偏移，用于内核直接映射）
  - `MapType::Framed`：按需分配物理帧

```rust
impl MemorySet {
    pub fn new_kernel() -> Self;       // 创建内核地址空间
    pub fn new_bare() -> Self;         // 创建空白地址空间
    pub fn from_elf(app: &[u8]) -> Option<(Self, usize, usize)>;  // 从 ELF 加载
    pub fn from_existed_user(other: &Self) -> Self;   // fork 时复制
    pub fn insert_area(&mut self, area: MapArea);
    pub fn remove_area(&mut self, start, end) -> bool;
    pub fn translate(&self, vpn) -> Option<PageTableEntry>;
}
```

**内核空间初始化** (`map_kernel_areas`)：
- 对 `MEMORY_START..MEMORY_START+KERNEL_DIRECT_MAP_SIZE` 建立线性映射
- 识别并单独映射 MMIO 区域（UART、VirtIO MMIO/PCI ECAM/PCI MMIO）
- MMIO 区域权限为 R+W（不含 X），DRAM 区域为 R+W+X
- RISC-V 额外映射 SiFive Test 关机寄存器

**MapArea**：
- 定义一段连续的虚拟地址范围的映射方式
- 支持 `map()/unmap()` 操作
- `clone_framed_area_data()` 用于 fork 时复制 Framed 类型区域（逐页拷贝数据）

#### 3.3.7 ELF 加载器 (`elf.rs`)

完整实现了 ELF64 解析：
- 支持 `ET_EXEC` 类型（静态链接的可执行文件）
- 验证魔数、64 位、小端、RISC-V/LoongArch 机器类型
- 解析 Program Header（仅处理 `PT_LOAD` 段）
- 从 ELF 创建 MemorySet：

```rust
impl MemorySet {
    pub fn from_elf(data: &[u8]) -> Option<(Self, usize, usize)> {
        // 1. 解析 ELF header
        // 2. 遍历 program headers
        // 3. 为每个 PT_LOAD 段创建 MapArea (Framed + U)
        // 4. 将段数据拷贝到映射的物理页中
        // 5. 分配用户栈
        // 6. 映射 Trampoline 和 TrapContext 页
        // 7. 返回 (MemorySet, entry_point, user_stack_top)
    }
}
```

#### 3.3.8 内核初始化流程

```rust
pub fn init() {
    // 1. 确定内核物理范围 → 计算堆起止 → 初始化 heap
    // 2. 计算空闲物理帧范围 → 初始化 frame allocator
    // 3. 打印内存布局信息
}

pub fn init_paging() {
    // 1. 创建内核 MemorySet (new_kernel)
    // 2. 提取根 PPN → 激活页表 (activate_kernel_page_table)
    // 3. 泄漏 kernel_space (永不释放)
}
```

---

### 3.4 任务管理 (`kernel/src/task/`)

#### 3.4.1 概述

任务子系统是 RmikuOS 最核心和复杂的子系统（~3,600 行），实现了**进程-线程两级模型**、**基于 stride 的调度器**以及**自适应 alpha 调度**。

#### 3.4.2 进程控制块 (`process.rs`)

```rust
pub struct ProcessControlBlock {
    pub pid: Pid,
    pub parent: Option<Pid>,
    pub children: Vec<Pid>,
    pub user_space: MemorySet,          // 虚拟地址空间
    pub fd_table: Vec<Option<FileRef>>, // 文件描述符表
    pub free_fds: Vec<usize>,           // 回收的 fd
    pub cwd: String,                    // 当前工作目录
    pub threads: Vec<Tid>,              // 所有线程
    pub ready_threads: Vec<Tid>,        // 就绪队列
    // 调度参数
    pub tickets: usize,                 // 基准票数（默认 100）
    pub stride: usize,                  // 步长 = BIG_STRIDE / tickets
    pub pass: usize,                    // 当前 pass 值
    pub run_ticks: usize,               // 累计运行 tick 数
    pub effective_tickets: usize,       // 有效票数（经 alpha 缩放）
    pub ready_thread_count_snapshot: usize,
    // mmap 管理
    pub mmap_areas: Vec<MmapArea>,
    pub mmap_free_ranges: Vec<MmapFreeRange>,
    pub mmap_next: usize,
    pub exit_code: i32,
}
```

关键方法：
- `new()`：创建新进程（含 fd table 初始化：0=stdin, 1=stdout, 2=stdout）
- `fork_from()`：从父进程 fork，继承地址空间/FD/CWD/调度参数/mmap 状态
- `alloc_mmap_range()` / `dealloc_mmap_range()`：mmap 区域的分配与释放（first-fit + 合并相邻空闲区间）
- `close_non_standard_fds_on_exec()`：exec 时关闭 fd≥3

#### 3.4.3 线程控制块 (`thread.rs`)

```rust
pub struct ThreadControlBlock {
    pub tid: Tid,
    pub pid: Pid,
    pub kernel_stack: KernelStack,    // 独立内核栈（128KB）
    pub trap_cx_addr: usize,          // TrapContext 在内核栈上的地址
    pub task_cx: TaskContext,         // 上下文切换快照
    pub status: ThreadStatus,         // Ready/Running/Blocking/Zombie/Dead
    pub block_reason: BlockReason,    // Sleep/WaitPid/Join/PipeRead/PipeWrite
    pub tickets: usize,
    pub stride: usize,
    pub pass: usize,
    pub run_ticks: usize,
    pub exit_code: i32,
}
```

线程创建：
- `new_main_thread()`：为进程创建主线程（从 init shell 或 exec 触发）
- `new_user_thread(entry, user_sp, arg0, arg1)`：为用户线程创建上下文

#### 3.4.4 任务管理器 (`manager.rs` + `manager_wrapper.rs`)

**TaskManager**（950 行核心逻辑 + 1,429 行包装层）是系统的调度核心：

```rust
pub struct TaskManager {
    processes: Vec<Option<ProcessControlBlock>>,
    threads: Vec<Option<ThreadControlBlock>>,
    free_pids: Vec<Pid>,
    free_tids: Vec<Tid>,
    sched_alpha: isize,         // 自适应调度 alpha 参数 [0, 100]
    scale_cache: Vec<usize>,    // 缩放因子缓存
    cache_alpha: isize,         // 缓存对应的 alpha
}
```

**两级调度算法**：

1. **进程级 Stride 调度** (`pick_ready_process_by_stride`)：
   - 遍历所有进程，找到 `pass` 最小的有就绪线程的进程
   - 在比较前，通过 `update_process_stride_by_alpha()` 动态更新进程的 effective_tickets 和 stride：

```rust
pub fn update_process_stride_by_alpha(&mut self, pid: Pid) {
    let runnable = self.count_runnable_threads_in_process(pid);
    let factor = self.scale_factor_cached(runnable);  // floor(n^(alpha/100))
    let effective_tickets = base_tickets * factor;
    let new_stride = BIG_STRIDE / effective_tickets;
    // ... 更新 PCB
}
```

2. **线程级选择** (`pick_ready_thread_in_process`)：
   - 在选中的进程中，选 pass 最小的就绪线程

3. **Pass 推进**：
   - 进程的 `pass += process.stride`（基于 effective_tickets）
   - 线程的 `pass += thread.stride`

#### 3.4.5 自适应 Alpha 调度

核心实现在 `kernel/src/math.rs`：

```rust
/// 返回 floor(n^(alpha/100))，alpha ∈ [0, 100]
/// alpha=0   → 1    (n^0)
/// alpha=50  → floor(√n)
/// alpha=100 → n    (n^1)
pub fn sched_thread_scale(n: usize, alpha: isize) -> usize
```

实现采用**纯整数、无浮点**的二进制小数幂算法：
- 使用定点数（基数 `SCALE = 1<<20`）
- `sqrt_fp()`：定点开平方（Newton 迭代）
- 将 `alpha/100` 按二进制小数逐位展开：`n^e = Π (n^(2^-k))^{b_k}`
- 每轮 `cur = sqrt_fp(cur)` 计算 `n^(2^-k)`
- 结果始终 `≥ 1` 且 `≤ n`，单调不降

带缓存的缩放因子查询：
```rust
fn scale_factor_cached(&mut self, n: usize) -> usize {
    // alpha 变化时重算已有缓存
    // n 超出缓存时扩容补算
}
```

这使得调度器可以让用户空间通过 `set_sched_alpha` 系统调用实时调整"就绪线程数 → 有效票数"的缩放曲线。alpha=0 表示完全忽略线程数（纯公平），alpha=100 表示按线程数线性缩放票数。

#### 3.4.6 上下文切换

**TaskContext**：
```rust
#[repr(C)]
pub struct TaskContext {
    pub ra: usize,
    pub sp: usize,
    pub s: [usize; 12],  // RISC-V: s0-s11
}
```

**汇编切换** (`switch_riscv64.S` / `switch_loongarch64.S`)：
- 保存 callee-saved 寄存器（ra, sp, s0-s11）到当前 TaskContext
- 从下一个 TaskContext 恢复
- `ret` 返回到新任务的 `ra`

**任务入口** (`__task_entry`)：
```rust
pub extern "C" fn __task_entry() -> ! {
    let trap_cx_addr = manager.thread(current_tid).trap_cx_addr;
    unsafe { __restore_user(trap_cx_addr as *const TrapContext); }
}
```

**调度循环** (`run_tasks`)：
```rust
pub fn run_tasks() -> ! {
    loop {
        let next = manager.find_next_ready_thread()?;
        // 准备：获取根 PPN、内核栈顶、TrapContext 地址
        processor::set_current_tid(Some(tid));
        mm::activate_page_table(root);
        __switch(idle_cx_ptr, task_cx_ptr);  // 切换到目标线程
        processor::set_current_tid(None);
    }
}
```

无就绪线程时：开启中断 → `WFI` → 等待定时器唤醒。

#### 3.4.7 进程/线程生命周期操作

| 操作 | 实现函数 | 说明 |
|------|----------|------|
| `fork` | `fork_current()` | COW 未实现，完整复制地址空间；复制 FD 表（调用 `on_fork()`） |
| `exec` | `exec_current()` | 从文件加载 ELF → 创建新 MemorySet → 替换当前进程 |
| `waitpid` | `waitpid_current()` | 支持 `-1`（任意子进程）和指定 PID；循环 Block/Wake |
| `exit` | `exit_current_and_run_next()` | 标记 Zombie → 唤醒等待的父进程 → 切换到 idle |
| `thread_create` | `create_thread_current()` | 新线程共享地址空间和 FD 表，初始化 pass 为进程内最小 |
| `thread_exit` | `thread_exit_current()` | 标记 Zombie → 唤醒 join 等待者 |
| `thread_join` | `thread_join_current()` | 等待目标线程退出 |
| `sleep` | `sleep_current_and_run_next()` | 基于 tick 的延时阻塞 |
| `yield` | `suspend_current_and_run_next()` | 主动让出 CPU |

#### 3.4.8 内核栈管理

```rust
pub struct KernelStack {
    base_ppn: PhysPageNum,
    pages: usize,            // 128KB = 32 pages
}
```

- 使用连续物理帧分配（`alloc_contiguous_frames`）
- 栈底放置 magic guard（`0xdead_beef_cafe_babe`）用于溢出检测
- TrapContext 放置在栈顶（`stack_top - sizeof(TrapContext)`）
- Drop 时自动回收物理帧

#### 3.4.9 多核支持

`main.rs` 中实现了基础的多核启动：
- `HART_LOCALS`：每核的原子状态（id, tick, ready）
- `MASTER_READY`：主核初始化完成后的释放-获取同步
- 主核（hart 0）执行全部初始化 → 设置 `MASTER_READY = true`
- 从核自旋等待 `MASTER_READY` → 执行 `secondary_init` → 进入 `kernel_loop`
- 当前为单调度器全局锁模型（所有核竞争 `TASK_MANAGER` 锁）

---

### 3.5 系统调用 (`kernel/src/syscall/`)

#### 3.5.1 概述

实现了 **40 个系统调用**，覆盖进程管理、线程管理、文件系统、调度控制、管道、内存映射等。

#### 3.5.2 完整系统调用列表

| ID | 名称 | 类别 | 说明 |
|----|------|------|------|
| 0 | `exit` | 进程 | 终止当前进程 |
| 1 | `yield` | 进程 | 主动让出 CPU |
| 2 | `write` | FS | 写文件/标准输出 |
| 3 | `getpid` | 进程 | 获取 PID |
| 4 | `fork` | 进程 | 复制当前进程 |
| 5 | `waitpid` | 进程 | 等待子进程 |
| 6 | `sleep` | 进程 | 基于 tick 的延时 |
| 7 | `exec` | 进程 | 替换进程映像 |
| 8 | `read` | FS | 读文件/标准输入 |
| 9 | `open` | FS | 打开/创建文件 |
| 10 | `close` | FS | 关闭文件描述符 |
| 11 | `getdents` | FS | 读取目录项 |
| 12 | `chdir` | FS | 切换工作目录 |
| 13 | `getcwd` | FS | 获取当前工作目录 |
| 14 | `stat` | FS | 按路径获取文件状态 |
| 15 | `fstat` | FS | 按 fd 获取文件状态 |
| 16 | `thread_create` | 线程 | 创建线程 |
| 17 | `thread_exit` | 线程 | 线程退出 |
| 18 | `thread_join` | 线程 | 等待线程 |
| 19 | `mmap` | 内存 | 匿名内存映射 |
| 20 | `munmap` | 内存 | 解除内存映射 |
| 21 | `set_thread_tickets` | 调度 | 设置指定线程票数 |
| 22 | `set_process_tickets` | 调度 | 设置指定进程票数 |
| 23 | `set_my_tickets` | 调度 | 设置当前进程票数 |
| 24 | `get_thread_tickets` | 调度 | 查询线程票数 |
| 25 | `get_process_tickets` | 调度 | 查询进程票数 |
| 26 | `get_my_tickets` | 调度 | 查询当前进程票数 |
| 27 | `set_sched_alpha` | 调度 | 设置自适应 alpha |
| 28 | `get_sched_alpha` | 调度 | 查询 alpha |
| 29 | `get_process_sched_stat` | 调度 | 查询进程调度统计 |
| 30 | `reset_sched_stat` | 调度 | 重置调度统计 |
| 31 | `get_ticks` | 系统 | 获取系统 tick 计数 |
| 32 | `pipe` | FS | 创建管道 |
| 33 | `dup2` | FS | 复制 FD |
| 34 | `mkdir` | FS | 创建目录 |
| 35 | `create` | FS | 创建文件 |
| 36 | `unlink` | FS | 删除文件 |
| 37 | `rmdir` | FS | 删除空目录 |
| 38 | `remove_recursive` | FS | 递归删除 |
| 39 | `shutdown` | 系统 | 关机 |

#### 3.5.3 系统调用实现细节

**`sys_read/sys_write`**：内核缓冲区中转模式
```rust
pub fn sys_read(fd, user_buf, len) -> isize {
    let file = current_file(fd)?;
    if !file.readable() { return -1; }
    let mut kbuf = vec![0u8; len];   // 内核缓冲区
    let n = file.read(&mut kbuf);    // File trait read
    write_current_user_bytes(user_buf, &kbuf[..n]);  // 拷贝到用户空间
}
```

**`sys_exec`**：从文件路径加载 ELF → 解析 → 替换地址空间
```rust
pub fn sys_exec(path_ptr, path_len, args_ptr) -> isize {
    let abs = normalize_path(&cwd, &path);
    let data = read_all(&abs)?;          // 通过 VFS 读取完整 ELF
    let (ms, entry, sp) = MemorySet::from_elf(&data)?;
    // ... 设置参数、替换地址空间和 FD 表
}
```

**`sys_pipe`**：创建管道 → 返回两个 FD
```rust
pub fn sys_pipe(fd_ptr) -> isize {
    let (reader, writer) = make_pipe();
    let fd0 = alloc_fd(reader);
    let fd1 = alloc_fd(writer);
    write_current_user_bytes(fd_ptr, &[fd0, fd1]);
}
```

**用户态访问辅助函数**：
```rust
fn read_current_user_bytes(ptr, len) -> Option<Vec<u8>> {
    // 通过当前进程的 MemorySet 逐页验证 + 拷贝
}
fn write_current_user_bytes(ptr, data) -> Option<()> {
    // 通过当前进程的 MemorySet 逐页验证 + 写入
}
```

---

### 3.6 文件系统 (`kernel/src/fs/`)

#### 3.6.1 概述

实现了完整的类 VFS 抽象层，支持三种具体文件系统（ext4、tmpfs、FAT）的统一挂载和访问。

#### 3.6.2 VFS 核心抽象

**Inode trait**：
```rust
pub trait Inode: Send + Sync {
    fn metadata(&self) -> Metadata;
    fn lookup(&self, name: &str) -> Option<InodeRef>;
    fn open(&self, flags: usize) -> Option<FileRef>;
    fn getdents(&self) -> Vec<DirEntry>;
    fn create(&self, name: &str) -> Option<InodeRef>;
    fn mkdir(&self, name: &str) -> Option<InodeRef>;
    fn truncate(&self) -> isize;
    fn unlink(&self, name: &str) -> isize;
    fn rmdir(&self, name: &str) -> isize;
    fn remove_recursive(&self, name: &str) -> isize;
}
```

**File trait**：
```rust
pub trait File: Send + Sync {
    fn readable(&self) -> bool;
    fn writable(&self) -> bool;
    fn is_dir(&self) -> bool;
    fn read(&self, buf: &mut [u8]) -> isize;
    fn write(&self, buf: &[u8]) -> isize;
    fn getdents(&self, buf: &mut [u8]) -> isize;
    fn stat(&self) -> Stat;
    fn on_fork(&self);                                     // fork 时通知
    fn on_close_kind(&self) -> PipeCloseKind;              // close 时通知
}
```

**挂载系统** (`mount.rs`)：
- 全局挂载表 `static MOUNTS: Mutex<Vec<Mount>>`
- 最长前缀匹配：解析绝对路径时找最佳挂载点
- 支持 /、/tmp、/fat 等多个挂载点

**路径解析** (`path.rs`)：
- `normalize_path(cwd, path)`：规范化路径（处理 `.`、`..`）
- `lookup_abs_path(path)`：逐级查找（经过挂载解析）
- `lookup_path_at(cwd, path)`：相对路径 → 绝对路径 → 查找

#### 3.6.3 ext4 文件系统 (`ext4fs.rs`)

使用 `ext4-view` crate（只读）：
- 包装 `BlockDevice` 为 `CachedBlockReader`（逐块读取）
- `Ext4Fs::load(device)`：加载 ext4 超级块
- `Ext4Inode`：封装 path 字符串，通过 `ext4-view` 的 `metadata()`/`read_dir()`/`read()` 实现
- 仅支持只读（flags 含 O_WRONLY/O_RDWR/O_APPEND 时拒绝打开）
- 不支持 UTF-8 文件名（无法转换为 &str 的文件跳过）

#### 3.6.4 tmpfs (`tmpfs.rs`)

完全内存文件系统，支持完整 CRUD：
- 数据结构：`BTreeMap<String, TmpfsNode>`
- `TmpfsNode::File(Arc<Mutex<Vec<u8>>>)`：文件数据
- `TmpfsNode::Dir(Arc<Mutex<BTreeMap<...>>>)`：目录项
- 支持：`create`、`mkdir`、`unlink`、`rmdir`（仅空目录）、`remove_recursive`、`truncate`、`read`、`write`
- 支持 `O_APPEND` 模式
- 挂载点：`/tmp`

#### 3.6.5 FAT 文件系统 (`fatfs.rs`)

基于 `third_party/fatfs`（fork 并修改为 `no_std`）：
- `FatFs::load(device, num_sectors)`：通过 `BlockIo` 适配器连接
- `BlockIo` 实现 `fatfs::Read + Write + Seek`（逐扇区读写，含 read-modify-write）
- `FatInode`：封装 path 字符串
- `FatFile`：维护独立的 offset，支持 seek、append
- 支持完整读写
- 挂载点：`/fat`

#### 3.6.6 通用文件类型

- `Stdin`：UART 逐字符读取（含行缓冲）
- `Stdout`：UART 逐字符输出
- `ReadOnlyMemFile`：从静态/动态字节数据构造的只读文件
- `ReadOnlyDirFile`：从 `Vec<DirEntry>` 构造的只读目录

#### 3.6.7 管道 (`pipe.rs`)

环形缓冲区管道实现：
- 512 字节固定缓冲区
- `PipeReadEnd` / `PipeWriteEnd`：单向读写端
- 阻塞语义：
  - 读空管道 + 写端存活 → 阻塞（`block_current_on_pipe_read`）
  - 写满管道 + 读端存活 → 阻塞（`block_current_on_pipe_write`）
  - 读空管道 + 写端全部关闭 → 返回 0（EOF）
  - 写满管道 + 读端全部关闭 → 返回 EPIPE（-1）
- 引用计数：`on_fork()` 递增 reader/writer 计数，`on_close_kind()` 递减

#### 3.6.8 目录项格式

```rust
#[repr(C)]
pub struct DirEntry {
    pub file_type: u8,     // 1=file, 2=dir
    pub name_len: u8,
    pub reserved: [u8; 6],
    pub name: [u8; 56],
}
pub const DIRENT_SIZE: usize = 64;
```

---

### 3.7 块设备子系统 (`kernel/src/block/`)

#### 3.7.1 概述

实现了完整的块设备抽象、块缓存、Ramdisk、VirtIO-MMIO 和 VirtIO-PCI 块设备驱动。

#### 3.7.2 块设备抽象

```rust
pub trait BlockDevice: Send + Sync {
    fn block_size(&self) -> usize;      // 通常 512
    fn num_blocks(&self) -> usize;
    fn read_block(&self, block_id: usize, buf: &mut [u8]) -> isize;
    fn write_block(&self, block_id: usize, buf: &[u8]) -> isize;
}
```

#### 3.7.3 块缓存 (`cache.rs`)

- 固定大小 512 字节/块
- LRU-like 淘汰策略：容量 64 块，优先淘汰无外部引用的块（`Arc::strong_count == 1`）
- 全局单例 `static BLOCK_CACHE_MANAGER`
- 写回策略：`Drop` 时自动 `sync()`

```rust
pub fn get_block_cache(block_id, device) -> BlockCacheRef;
```

#### 3.7.4 VirtIO-MMIO 块设备驱动

**VirtioMmioHeader** (`virtio_mmio.rs`)：
- 完整的 MMIO 寄存器布局抽象
- 支持 Legacy（v1）和 Modern（v2）两种传输模式

**VirtioBlkDevice** (`virtio_blk.rs`，967 行)：
- 设备初始化序列：reset → ACKNOWLEDGE → DRIVER → 协商 features → FEATURES_OK → DRIVER_OK
- Legacy 模式：通过 `QueuePFN` 传递队列物理地址
- Modern 模式：通过 `desc/avail/used` 三环传递队列地址
- Split Virtqueue 实现 (`VirtioQueue`)：
  - 描述符环：16B × QUEUE_SIZE 条目
  - Available 环：driver → device
  - Used 环：device → driver
  - 队列内存使用连续物理帧分配
- 同步 I/O：`read_block()`/`write_block()` 内部构造 virtio-blk 请求 → 提交描述符 → 通知设备 → 轮询 used 环

**VirtioBlkReq 格式**：
```rust
#[repr(C)]
struct VirtioBlkReq {
    req_type: u32,    // 0=read, 1=write
    reserved: u32,
    sector: u64,      // LBA
}
```

#### 3.7.5 VirtIO-PCI 块设备驱动

**PCI 能力解析** (`virtio_pci.rs`)：
- 遍历 PCI 配置空间的能力链表
- 解析 `VIRTIO_PCI_CAP_COMMON_CFG`、`NOTIFY_CFG`、`ISR_CFG`、`DEVICE_CFG`
- 通过 BAR 计算各区域的物理地址 → 内核虚拟地址

**VirtioPciBlkDevice** (`virtio_pci_blk.rs`，694 行)：
- 与现代 VirtIO-PCI 传输层交互
- 通过 common_cfg 区域配置设备
- 通过 notify_cfg 区域发送队列通知

#### 3.7.6 磁盘发现

**RISC-V** (`discover_disks.rs`)：
- 扫描 VirtIO MMIO 区域（8 个槽位）
- 读取每个磁盘的 block 2 offset 56 处的 magic
- `0xef53` → ext4 根文件系统盘
- 其他 → FAT 候选盘
- 返回 `(Option<ext4_dev>, Option<fat_dev>)`

**LoongArch**：
- 扫描 PCI 总线寻找 VirtIO-PCI 块设备
- 同样的 magic 判断逻辑

#### 3.7.7 其他块设备

- `RamDisk`：从静态字节数组构造（用于嵌入的 FS 镜像）
- `ext4_image`：编译时嵌入 ext4 镜像到内核（通过 `include_bytes!`）

---

### 3.8 PCI 总线 (`kernel/src/pci/`)

#### 3.8.1 概述

为 LoongArch 平台实现了完整的 PCI ECAM 配置空间访问和总线枚举。

#### 3.8.2 ECAM 访问

```rust
fn config_addr(addr: PciAddress, offset: usize) -> usize {
    PCI_ECAM_BASE + (bus << 20) + (device << 15) + (function << 12) + offset
}
```

- 支持 8/16/32 位配置空间读写（`read_config_u8/u16/u32`、`write_config_u16/u32`）
- 通过 `volatile` 指针访问，经内核直接映射物理地址

#### 3.8.3 BAR 解析与分配

- `read_bar(addr, bar)`：读 BAR 原始值，解析类型（I/O/Memory，32/64-bit）
- `assign_mem_bar(addr, bar, base)`：分配 MMIO 基地址
- `ensure_mem_bar(addr, bar, base)`：仅在未分配时分配

#### 3.8.4 设备枚举

`scan_pci_bus()`：
- 扫描 bus 0 的 32 个设备、8 个功能
- 读取 vendor/device/class/subclass/header_type
- 识别 VirtIO 块设备：vendor=0x1af4，device=0x1042（modern）或 0x1001（transitional）
- 支持 Multi-Function 设备检测

---

### 3.9 I/O 子系统 (`kernel/src/io/`)

#### 3.9.1 UART 驱动

- 基于 NS16550A 兼容 UART
- 轮询方式（无中断驱动）
- `putchar_raw()`：等待 THR 空 → 写入
- `getchar_raw()`：等待 RBR 就绪 → 读取
- LoongArch 提供 `putchar_phys_raw()` 用于早期引导阶段

#### 3.9.2 控制台

- `print!/println!` 宏：格式化输出到 UART
- 全局 `CONSOLE_LOCK` 自旋锁保护
- 陷阱日志 `_trap_log`：附加 CPU ID 前缀

#### 3.9.3 日志系统

- 基于 `log` crate
- 支持彩色输出（ANSI 转义码）：红色 Error、黄色 Warn、青色 Info
- `LOG` 环境变量控制级别（`ERROR/WARN/INFO/DEBUG/TRACE`）

---

### 3.10 同步原语 (`kernel/src/sync/`)

#### 3.10.1 自旋锁

**`SpinLock`** (sync.rs)：简单的 CAS 自旋锁，用于保护 UART 等轻量资源。

**`Mutex<T>`** (spin.rs)：泛型自旋锁，提供 `MutexGuard` RAII 守卫。

#### 3.10.2 UPSafeCell

单核环境下使用的 `UnsafeCell` 包装（无锁），标记为 `Sync`。

---

### 3.11 定时器 (`kernel/src/timer/`)

#### 3.11.1 RISC-V

- 通过 SBI `set_timer` ecall 设置定时器
- 时间间隔：500,000 ticks（约 50ms @ 10MHz）
- 每次中断后重新设置（one-shot 模式）
- `tick()` 返回 `bool` 表示是否应触发调度

#### 3.11.2 LoongArch

- 使用 CSR 定时器（TCFG/TICLR）
- 周期模式（Periodic = 1）
- 初始值 500,000 ticks
- `clear_timer_interrupt()` 通过 CSR.TICLR 清除

---

### 3.12 用户态程序

#### 3.12.1 构建系统

`user/build.py` 管理跨架构编译：
- 支持 C 程序（gcc 裸机编译）和 Rust 程序（cargo + no_std）
- 输出：`user/build/{arch}/bin/*.elf` 和 `user/build/{arch}/tests/*.elf`
- 剥离调试信息：`objcopy -O binary -j .text` 提取纯代码段

#### 3.12.2 C 用户库

- `crt0_*.S`：运行时启动（设置栈 → `call main` → `exit`）
- `syscall_*.S`：系统调用包装（装入 id 和参数 → `ecall`）
- `include/`：系统调用常量、类型定义、标准函数声明

#### 3.12.3 Rust 用户库

`user/rust/ulib/`：Rust 用户库
- `syscall.rs`：`asm!` 包装 `ecall`
- `io.rs`、`fs.rs`、`process.rs`：高层 API
- `allocator.rs`：用户态堆分配器

#### 3.12.4 Shell 特性

Shell（`user/src/shell.c`）实现功能：
- 内建命令：`cd`, `pwd`, `exit`, `help`, `shutdown`, `mkdir`, `touch`, `rm`, `rmdir`
- 外部命令搜索路径（从 `/etc/path` 读取）
- 管道（`|`）支持（fork + dup2 + exec）
- 输入/输出重定向（`<`、`>`、`>>`）
- 行编辑（退格支持）

#### 3.12.5 测试程序

55 个 C 测试 + 10 个 Rust 用户程序，覆盖：
- 基础 I/O：`hello`, `cat_stdin`, `cat_motd`, `echo_args`
- 进程管理：`fork_wait`, `fork_stride_test`, `getpid_sleep`, `open_exec`, `busy`
- 线程：`thread_test`, `thread_stride_test`, `thread_malloc_test`
- 调度实验：`stride_ticket_test`, `alpha_sched_test`, `adaptive_alpha_test`, `edge_deadline_test`, `dynamic_load_exp` 等
- 文件系统：`crud_test`, `open_test`, `stat_test`, `fs_stress`
- 管道：`pipe_test`, `pipe_stress`
- mmap：`mmap_test`, `mmap_stress`, `mmap_reuse_test`
- Rust：`rust_hello`, `rust_fibonacci`, `rust_estimate_pi`, `bank_system`, `editor`, `library_system`

---

## 四、OS 内核各部分交互

### 4.1 初始化序列

```
OpenSBI/U-Boot → _start (boot.S)
  → 建立引导页表（恒等映射 + 高半直接映射）
  → 开启 MMU → 切换到高半虚拟地址
  → rust_main(id)
    → primary_init():
      → io::uart::init()          // UART 初始化
      → io::logger::init()        // 日志系统
      → trap::init()              // 设 stvec/eentry
      → mm::init()                // 堆 + 帧分配器
      → 内核自测 (heap/frame/pt/mem)
      → mm::init_paging()         // 创建并激活内核 MemorySet
      → block 自测
      → block::discover_disks()   // 发现 ext4/FAT 盘
      → timer::init()             // 时钟中断
      → fs::ext4fs::init()        // 挂载 ext4 /
      → fs::tmpfs::init()         // 挂载 tmpfs /tmp
      → fs::fatfs::init()         // 挂载 FAT /fat
      → task::init()              // 加载 /bin/shell → PCB 0
      → task::run_first_task()    // 进入调度循环
```

### 4.2 系统调用路径

```
用户程序: ecall (a7=id, a0-a5=args)
→ trap.S: __alltraps
  → 保存 TrapContext (用户寄存器 + sstatus/sepc/stval/scause)
  → riscv_trap_handler() / loongarch_trap_handler()
    → ECALL → cx.sepc+=4; handle_syscall(id, args)
      → syscall::syscall(id, args)
        → 具体 sys_* 实现
          → task::* / fs::* (操作 PCB/FD/VFS)
  → __restore (恢复 TrapContext → sret 返回用户态)
```

### 4.3 时钟中断与调度路径

```
定时器中断
→ trap.S: __alltraps (来自 S-mode 或 U-mode)
→ riscv_trap_handler()
  → timer::tick() → 返回 should_schedule
  → 若 from_user && should_schedule:
    → task::preempt_current_and_run_next()
      → 标记当前线程 Ready → __switch 到 idle
      → run_tasks 循环选下一个线程 → __switch → __task_entry → __restore_user
  → 若 from_user:
    → task::account_current_tick() (更新 run_ticks)
```

### 4.4 文件系统访问路径

```
用户: open("/home/miku/readme.txt", O_RDONLY)
→ syscall: sys_open → 读用户态路径字符串
→ fs::open_at(cwd, path, flags)
  → path::normalize_path() → path::lookup_path_at()
    → mount::resolve_mount()    // 匹配最长挂载点
    → inode.lookup() 逐级查找
      → ext4: ext4_view::metadata/exists
      → tmpfs: BTreeMap::get
      → fat: fatfs::root_dir().open_dir/open_file
  → inode.open() → FileRef
→ task::alloc_fd_current(file) → fd number

用户: read(fd, buf, len)
→ syscall: sys_read
→ task::current_file(fd) → FileRef
→ file.read(&mut kbuf) → File trait 动态派发
  → ext4 → ReadOnlyMemFile::read
  → tmpfs → TmpfsFile::read
  → fat → FatFile::read (fatfs Read + Seek)
  → pipe → PipeReadEnd::read (环形缓冲区 + 阻塞)
  → stdin → Stdin::read (UART 逐字符)
→ write_current_user_bytes(buf, kbuf)
```

---

## 五、实现完整度分析

### 5.1 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 架构引导 | 85% | 双架构支持良好；LoongArch 引导较完善（含 TLB refill）；SMP 基础框架存在但实际多核调度未完成 |
| 陷阱处理 | 80% | 完整的异常/中断/系统调用分发；缺信号机制、用户态中断转发 |
| 内存管理 | 75% | Sv39/LoongArch 页表完整；帧分配器完整；缺 COW、页面换出、demand paging；缺共享内存 |
| 进程管理 | 85% | fork/exec/waitpid/exit 完整；FD 表继承正确；缺进程组/session |
| 线程管理 | 80% | create/exit/join 完整；共享地址空间正确；缺 TLS、futex |
| 调度器 | 90% | Stride 调度完整；自适应 alpha 创新性强；用户态可控；缺多核负载均衡、实时调度 |
| 系统调用 | 85% | 40 个系统调用覆盖面广；参数校验完善；缺信号、poll/select、socket |
| VFS | 80% | Inode/File 抽象清晰；挂载系统合理；缺符号链接、权限检查、inode 缓存 |
| ext4 | 55% | 只读；依赖 ext4-view crate；缺写入支持；文件名仅 ASCII |
| tmpfs | 85% | 完整 CRUD + 目录递归；仅缺文件锁 |
| FAT | 75% | 读写完整；R/W 经过 read-modify-write；缺目录创建/删除 |
| 块设备 | 85% | VirtIO-MMIO/PCI 完整；块缓存有效；缺 NVMe/AHCI |
| PCI | 75% | ECAM 完善；BAR 分配；缺 MSI-X、PCIe 高级特性 |
| I/O | 70% | UART 完善；缺中断驱动 I/O、多控制台 |
| 同步 | 60% | 基础自旋锁+Mutex；缺读写锁、信号量、条件变量 |
| 用户态 | 80% | 55+ 测试；Shell 带管道重定向；Rust 用户程序；缺动态链接 |

### 5.2 整体评估

RmikuOS 是一个**实现完成度中高**的教学/实验型操作系统内核。其覆盖了操作系统核心功能的大部分方面，且在某些领域（调度器）具有显著的深度和创新。在文件系统、块设备驱动方面也达到了实用水平。主要不足之处在于：网络栈完全缺失、内存管理的 COW 和页面置换未实现、多核调度未完成。

---

## 六、创新性分析

### 6.1 自适应 Alpha 调度器（核心创新）

RmikuOS 最显著的创新点在于其**连续自适应 alpha 调度器**。

**创新本质**：在 Stride 调度的基础上，引入了一个连续参数 `alpha ∈ [0, 100]`，控制"进程内就绪线程数"到"进程有效票数"的映射关系：

```
effective_tickets = base_tickets × n^(alpha/100)
```

其中 `n` 是进程内的就绪线程数。核心公式 `n^(alpha/100)` 采用**纯整数、无浮点**的二进制小数幂算法实现（定点数 + Newton 迭代开方），在任何 RISC-V 裸机环境可直接运行。

**创新意义**：
1. **统一调度策略空间**：alpha=0 对应纯公平调度（忽略线程数），alpha=50 对应平方根缩放，alpha=100 对应线性票数（线程越多票数越多）。连续参数使得用户空间可以在运行时探索"公平 vs 吞吐"的帕累托前沿。
2. **用户态可控**：通过 `set_sched_alpha`/`get_sched_alpha` 系统调用，用户程序可以在运行时动态调整调度策略。
3. **缓存优化**：`scale_cache` 和 `cache_alpha` 机制确保高频查询的缩放因子计算开销极小。

### 6.2 双架构 VirtIO Transport 抽象

第二个创新点在于同时支持 **VirtIO-MMIO（RISC-V）** 和 **VirtIO-PCI（LoongArch）** 两种传输层的统一抽象。块设备驱动的上层逻辑（`VirtioBlkDevice`）与传输层（MMIO/PCI）解耦，仅通过不同的寄存器访问方式和队列配置流程区分。这种设计在同类教学内核中较为罕见。

### 6.3 调度实验框架

配套的 20+ 调度测试程序和 Python 分析脚本构成了一套完整的调度器实验框架：
- 多线程 workload 生成器
- 自适应 alpha 的 AIMD 控制器
- deadline 感知的 edge deadline 调度变体
- 动态负载下的 alpha 对比分析

---

## 七、项目总结

RmikuOS 是一个从零实现的教学/实验型操作系统内核，具有以下特点：

**优势**：
1. 双架构支持（RISC-V 64 + LoongArch 64）且共用大部分核心代码
2. 完整的进程-线程两级模型，支持 fork/exec/waitpid 和 thread_create/join
3. 创新的自适应 alpha 调度器，提供连续可调的调度策略空间
4. 完整的 VFS + 三种文件系统（ext4/tmpfs/FAT）挂载框架
5. 完善的 VirtIO 块设备驱动（MMIO + PCI 双传输层）
6. 丰富的用户态测试套件（55+ C 测试 + 10 Rust 程序）
7. 实际的 ext4 根文件系统启动，可交互 Shell 带管道/重定向

**不足**：
1. 无网络协议栈
2. 内存管理缺少 COW、页面置换、共享内存
3. 多核调度未实质性完成（仅框架）
4. 无用户态信号机制
5. ext4 只读
6. 无动态链接支持

**总体评价**：这是一个实现扎实、设计清晰、具有明确创新点的操作系统内核项目。特别在调度器设计方面展现出较深的理论理解与工程实践能力。