# OSKernel v0.1.0 深度技术分析报告

## 一、分析范围与方法

本报告基于对项目仓库 **全部** 内核源码（`kernel/src/` 下 100+ 个源文件，共约 25,700 行）的逐文件阅读和分析。分析方法包括：

- **静态代码审查**：逐行阅读所有 Rust 源码、汇编文件和链接脚本
- **结构分析**：梳理模块依赖关系、设计模式和架构层次
- **接口分析**：追踪回调注册、syscall ABI、VFS 操作函数指针表
- **文档对照**：参考 26 篇设计文档（仅作辅助参考，事实依据均来自源码实现）

由于当前环境 Rust 工具链缺乏 `rustup`（无法安装 `riscv64gc-unknown-none-elf` target），无法执行实际编译和 QEMU 运行测试，下文分析均基于源码实现。

---

## 二、项目总体架构

### 2.1 架构层次

```
┌─────────────────────────────────────────────────────┐
│  syscall (dispatch → io / process / file / sig /    │
│           memory / time)                             │
│  fs (VFS → RamFs / DevFs / EXT4 / ProcFs)           │
│  loader (ELF64 + 动态链接)          ipc (Pipe)       │
├─────────────────────────────────────────────────────┤
│  sched (TCB / 调度器 / 信号 / fd / lifecycle)       │
├─────────────────────────────────────────────────────┤
│  mm (Frame / PageTable / AddressSpace / VmArea)     │
├─────────────────────────────────────────────────────┤
│  hal (薄门面: boot / context / cpu / mmu / irq ...) │
├─────────────────────────────────────────────────────┤
│  arch/riscv64 (entry.S / trap / Sv39 / PLIC / UART) │
└─────────────────────────────────────────────────────┘
```

### 2.2 核心设计模式：回调注入解耦

整个项目最核心的架构设计是**通过函数指针回调实现上下层解耦**。体现在三个关键位置：

1. **arch::trap ↔ sched/syscall 解耦**：`arch::trap::handler::TrapCallbacks` 结构体包含三个函数指针：
   - `syscall_dispatch: fn(usize, [usize; 6]) -> isize` — 系统调用分发
   - `pre_return_to_user: fn()` — 返回用户态前信号投递钩子
   - `user_fault: fn(usize, usize, FaultKind)` — 用户态缺页/异常处理

2. **sched::fd ↔ ipc/fs 解耦**：`sched::fd::FdCallbacks` 结构体包含：
   - `close: fn(FdKind)` — 关闭 fd 时递减管道/文件引用计数
   - `clone_ref: fn(FdKind)` — dup/fork 时递增引用计数

3. **arch::trap::timer ↔ sched 解耦**：通过 `register_tick_handler(handler: fn(bool))` 向定时器中断注入调度器 tick 处理。

所有回调在 `kernel_main()` 初始化序列中注册，使 arch/ 层完全不直接依赖 sched/ 或 syscall/ 的任何符号。

---

## 三、各子系统详细分析

### 3.1 架构层 (arch/riscv64) — 约 1,998 行

#### 3.1.1 启动序列 (boot/)

**entry.S** (60 行汇编)：内核物理入口点 `_start`，由 RustSBI 在 M-mode 初始化后以 S-mode 跳转至此。流程：
1. 设置栈指针 `sp = _stack_top`
2. 保存 `a0 (hartid)` 和 `a1 (dtb_pa)` 到 callee-saved 寄存器 `s0, s1`
3. 清零 BSS 段（`_bss_start` 到 `_bss_end`，以 8 字节为单位）
4. 调用 Rust 的 `kernel_main(hartid, dtb_pa)`
5. 若返回则 `wfi` 死循环

**linker.ld** (69 行)：定义内存布局：
- `BASE_ADDRESS = 0x80200000`（OpenSBI 占用前 2MB）
- 段顺序：`.text.entry`（必须最前）→ `.text` → `.rodata` → `.data` → `.bss`
- 栈空间：256KB BSS 后分配，`_stack_bottom` 到 `_stack_top`
- 丢弃：`.eh_frame`、`.comment`

#### 3.1.2 Trap 系统 (trap/)

这是最核心的架构子系统。

**trap.S** (230 行汇编)：`__trap_entry` 和 `__trap_return` 两个汇编入口。

`__trap_entry` 的设计精巧：
- 通过 `csrrw sp, sscratch, sp` 原子交换 `sp` 和 `sscratch`，一步完成保存用户 `sp` + 切换到内核栈
- 若交换后 `sp != 0`：来自 U-mode（`sscratch` 存有 `kernel_sp_top`）
- 若交换后 `sp == 0`：来自 S-mode（嵌套 trap），从 `sscratch` 恢复原始内核 `sp`
- 保存全部 32 个通用寄存器 + `sstatus` + `sepc` 到 `Context` 结构体（34 × 8 = 272 字节）
- `x0` 写入非零值标记来自 U-mode（供返回时判断）
- 特殊处理：在保存 `x5(t0)` 之前就将原始 `t0` 写入 context，避免 `csrr t0, sscratch` 覆盖问题（曾导致 glibc 栈损坏 bug）

`__trap_return` 的安全设计：
- 立即清零 `sscratch`，防止在寄存器恢复期间的嵌套异常误用旧的 `kstack_top`
- 在写入 `sstatus` 前清除 SIE 位（确保返回序列关中断）
- 仅当 `sstatus.SPP == 0`（返回 U-mode）时才将内核栈顶写入 `sscratch`
- 最后恢复 `sp`（从 `Context.x[2]`），然后 `sret`

**context.rs** (23 行)：`Context` 结构体 `#[repr(C)]`，保证与汇编偏移一致：
```rust
pub struct Context {
    pub x: [usize; 32], // x0-x31
    pub sstatus: usize,
    pub sepc: usize,
}
```

**handler.rs** (约 280 行)：Rust trap 分发逻辑：

1. `__trap_handler(ctx: &mut Context) -> *mut Context`：
   - 读取 `scause` / `stval` CSR
   - 通过 `decode_trap()` 将 scause 解码为 `Trap::Interrupt` 或 `Trap::Exception`
   - 分发到 `handle_interrupt()` / `handle_exception()`
   - 返回用户态前调用 `pre_return_to_user` 回调（信号投递）
   - 包含一个**关键的运行时断言**：验证 U-mode trap 时 `ctx` 指针恰好位于 `kstack_top - CTX_SIZE`。此断言曾捕获过多起栈损坏问题
   - 安全校验：U-mode 返回前检查 `sepc` 是否为合法用户地址（`< 0x8000_0000`），非法则 SIGSEGV 终止进程

2. `handle_interrupt()`：
   - `SupervisorTimer`：调用 `timer::on_tick()`，仅在来自 U-mode 时允许抢占（can_preempt = true）
   - `SupervisorSoft`：清除 SSIP（`csrc sip, 2`）
   - `SupervisorExternal`：从 PLIC claim，分发到 UART ISR

3. `handle_exception()`：
   - `EcallFromU`：调用 `handle_syscall()`，特殊处理 `SYS_RT_SIGRETURN(139)` 不推进 sepc
   - `EcallFromS`：panic
   - 页错误/非法指令等：若来自 U-mode，转换为 `FaultKind` 通过 `user_fault` 回调处理；若来自 S-mode，panic

4. `handle_syscall()`：从 `ctx.x[17] (a7)` 取 syscall 编号，从 `x[10..15]` 取参数，通过回调分发，返回值写入 `x[10] (a0)`

**timer.rs** (约 250 行)：S-mode 定时器：

- **SBI Timer 后端探测**：运行时选择 SBI v0.2 Timer Extension（EID=0x54494D45）或 Legacy set_timer。探测流程包括：
  1. `sbi_probe_extension(0x54494D45)` 检查扩展可用性
  2. `timer_v02_liveness_test()`：实际编程短 deadline 并 spin 检查 `sip.STIP`，确保中断 pending 能产生。这对兼容 RustSBI v0.2.2（可能返回成功但不产生 STIP）至关重要
- **One-shot 支持**：`set_one_shot(deadline)` 仅在 deadline 早于当前已编程值时更新 `mtimecmp`，使 nanosleep 能在精确时刻唤醒
- Tick 间隔：`10,000 ticks = 1ms`（基于 QEMU 10MHz mtime 频率，1000Hz）

**interrupt.rs** (76 行)：S-mode 中断开关。使用 `csrrc`/`csrs` 操作 `sstatus.SIE`，实现 save/restore 模式的嵌套中断禁用。提供 `with_interrupts_disabled` 高阶函数包装。

#### 3.1.3 任务切换 (task/)

**switch.S** (约 40 行汇编)：`__switch` 函数，保存/恢复 callee-saved 寄存器（ra, sp, s0-s11），14 × 8 = 112 字节。使用 `sd`/`ld` 按固定偏移操作 `TaskContext`。

**context.rs** (69 行)：`TaskContext` 结构体和构造方法。`goto(entry, sp)` 创建指向 `entry` 函数的上下文，`zero()` 创建全零上下文（用于 idle）。

#### 3.1.4 MMU 与页表 (mmu/)

**paging.rs** (235 行)：Sv39 页表管理。
- `kernel_satp()`：返回内核根页表对应的 satp 值（MODE=Sv39）
- `init()`：建立内核恒等映射。将 RAM 区域（0x80000000 起）和 UART MMIO 区域做 2MB 大页映射
- 使用 Sv39 三级页表：L2 (1G) → L1 (2M) → L0 (4K)
- 关键函数：
  - `map_page(root_ppn, vpn, ppn, flags)`：在指定根页表建立映射
  - `walk_pte(root_ppn, vpn, alloc)`：遍历/创建页表项，返回 PTE 可变引用
  - `splice_kernel_mapping(new_table)`：将内核映射复制到新页表（共享内核 PTE），用于创建用户进程地址空间
  - `switch_satp(satp)`：写入 satp CSR + `sfence.vma`

**tlb.rs** (28 行)：TLB 刷新包装：`flush_tlb_all()` 执行 `sfence.vma`，`flush_tlb_vaddr(vaddr)` 执行 `sfence.vma zero, addr`

#### 3.1.5 其他

- **uart.rs** (136 行)：NS16550A UART 驱动，基于 MMIO（地址 0x10000000）。支持轮询输出、接收中断（通过环形缓冲区 `RX_BUF`）、中断处理注册
- **plic.rs** (82 行)：平台级中断控制器，地址 0xC000000。claim/complete 操作，固定 IRQ 号映射（UART_IRQ=10）
- **sbi.rs** (98 行)：SBI legacy 封装：`set_timer` / `putchar` / `shutdown` / `reboot`
- **cpu.rs** (39 行)：`current_sp()`、`memory_fence()` (fence iorw,iorw)、`io_fence()` (fence w,w)

---

### 3.2 HAL 抽象层 — 约 949 行

HAL 目前是对 arch/riscv64 的薄包装（透明新类型 + 内联转发），例如：

```rust
#[repr(transparent)]
pub struct TaskContext(crate::arch::riscv64::task::TaskContext);
```

HAL 模块划分：
- **boot.rs** (292 行)：DTB 解析 + 内存区域抽象。`MemoryKind` 枚举区分 Usable/Reserved/Kernel/BootStack/Device/Firmware/Initrd。`init()` 解析 DTB 的 `/memory` 节点构建内存区域列表，失败则回退到 128MB 固定布局
- **fdt.rs** (358 行)：极简 FDT 解析器，零堆分配。仅解析结构块中的 `/memory*` 节点 `reg` 属性
- **context.rs**：`TaskContext` 和 `switch()` 透明包装
- **cpu.rs**：`wfi()`、`current_sp()`、`interrupts_enabled()`、`memory_fence()`、`io_fence()`
- **firmware.rs**：`shutdown()`、`reboot()`
- **irq.rs**：中断开关的 HAL 包装
- **mmu.rs**：`AddressSpaceToken`（satp 值的新类型）、`activate()`、`flush_tlb_all()`、`flush_tlb_vaddr()`
- **time.rs**：`read_ticks()`、`set_next_timer()`、`ticks_per_second()`
- **trap.rs**：`UserTrapFrame`（透明包装 `arch::Context`）、`TrapCause` 枚举、`FaultKind` 枚举
- **console.rs**：早期控制台输出包装

当前状态下 HAL 仅包装了 RISC-V，但预留了 amd64/loongarch64 的架构替换空间。

---

### 3.3 内存管理 (mm/) — 约 2,373 行

#### 3.3.1 物理页帧分配器 (frame.rs — 约 280 行)

- **位图分配**：使用 `BITMAP_PTR`（在物理 RAM 高端切出的 metadata 区域中），每 bit 对应一个 4KB 物理页
- **引用计数**：每帧一个 `u16` ref count，`alloc_frame()` 初始化为 1
- **初始化策略**："默认全占用，只释放 Usable"
  1. 遍历 boot info 的 memory_regions，找到最大 Usable 区域
  2. 从该区域高端切出 metadata（bitmap + ref_count 数组）
  3. 初始化 bitmap 全 1
  4. 遍历所有 Usable 区域，按页对齐清除对应位
  5. 将 metadata 自身占用的帧重新标记为占用
- **搜索策略**：环形扫描（NEXT_HINT 提示），O(n) 最坏复杂度
- **连续分配**：`alloc_contiguous_frames(n)` 线性扫描位图寻找 n 个连续空闲帧（用于内核栈）
- **引用计数操作**：`ref_frame()` / `deref_frame()` 增减引用、`frame_ref_count()` 查询（用于 COW）

#### 3.3.2 页表 (pgtable.rs — 536 行)

- Sv39 三级页表操作
- `PTEFlags`：bitflags 结构体，支持 READ/WRITE/EXEC/USER/ACCESSED/DIRTY/GLOBAL
- `PageTable` 结构体：持有根页表物理页号（`root_ppn`），Drop 时递归回收中间页表帧（保留叶子帧）
- 关键函数：
  - `map(root_ppn, vpn, ppn, flags)` — 建立单页映射
  - `map_contiguous(root_ppn, start_vpn, start_ppn, count, flags)` — 建立连续映射
  - `unmap(root_ppn, vpn)` — 解除映射
  - `translate(root_ppn, vpn)` — 遍历页表查找 PTE
  - `splice_kernel_mapping(new_table)` — 将内核的 RAM + UART 映射复制到新页表根，实现内核空间在所有地址空间中共享
  - `get_page(root_ppn, vpn)` — 非分配遍历，返回 None 表示页不存在（用于缺页检测）

#### 3.3.3 地址空间 (address_space.rs — 约 550 行)

`AddressSpace` 封装一个进程的完整虚拟地址空间：

```rust
pub struct AddressSpace {
    page_table: PageTable,           // 独立页表根
    satp_val: usize,                 // 预计算的 satp 值
    mappings: MappingStore,          // 用户页映射记录（帧后备存储）
    areas: VmAreaList,               // 虚拟内存区域列表
    brk_start: usize,                // 堆起点（ELF 数据段后）
    brk_current: usize,              // 当前 brk
    mmap_brk: usize,                 // mmap 高水位线
    tls_info: TlsInfo,               // TLS 信息
}
```

关键设计：
- **MappingStore**：用物理帧存放 `UserMapping` 数组（每帧 170 条记录，最多 32 帧 = 5440 条），避免栈上分配巨大数组。支持按需增长、swap-remove
- **VmAreaList**：类似的帧后备存储，存放 `VmArea`（每个 24 字节，每帧约 170 条）
- `new()`：创建新页表 → splice 内核映射 → 初始化
- `init_brk_from_elf(max_load_end)`：ELF 加载后初始化堆起点
- `set_brk(new_brk)`：延迟分配堆（仅更新边界和 VmArea，物理帧按需分配）
- `map_user_page(vpn, flags)`：分配帧 → 写入页表 → 记录映射
- `map_existing(vpn, ppn, flags)`：映射已存在的帧（fork 时使用）
- `unmap_user_page(vpn)`：解除映射 → 释放帧 → 移除记录
- `translate(vpn)`：查询页表，返回 PTE
- `find_vm_area(vpn)`：查找哪个 VmArea 包含此 VPN
- Drop 实现：遍历 `mappings` 释放所有用户物理帧；`PageTable::drop` 递归回收中间页表帧

#### 3.3.4 虚拟内存区域 (area.rs — 约 280 行)

```rust
pub struct VmArea {
    pub start_vpn: VirtPageNum,
    pub end_vpn: VirtPageNum,  // 不含
    pub flags: PTEFlags,
    pub area_type: VmAreaType,
}
```

- `VmAreaType` 枚举：Anonymous / Stack / Heap / Elf / MmapFile(u8)
- `MmapFile` 变体使用全局 `MMAP_FILE_TABLE`（64 槽位）存储文件映射详细信息（fs_id, fs_inode, file_size, offset, shared），避免 VmArea 膨胀
- 全局表操作：`mmap_file_alloc()` / `mmap_file_free()` / `mmap_file_retain()` / `mmap_file_clone_with_delta()` / `mmap_file_shift_ref()`
- `VmAreaList`：帧后备存储，支持 push/get/set/swap_remove/find

#### 3.3.5 缺页处理 (fault.rs — 88 行)

`handle_page_fault(addr_space, fault_addr, is_write) -> Option<bool>`：
1. 计算 `fault_vpn`
2. 在 `areas` 中查找包含此 VPN 的 VmArea
3. 若未找到 → 返回 None（发送 SIGSEGV）
4. 若找到，根据 VmArea 类型决定操作：
   - **Stack**：若地址在栈底以下但仍在增长范围内，扩展栈区域
   - **Heap**：按需分配物理帧
   - **Anonymous / Elf**：分配零页
   - **MmapFile**：从文件读取对应偏移的数据到新分配的帧
5. 调用 `map_user_page()` 建立映射，返回 Some(true)

---

### 3.4 进程调度 (sched/) — 约 3,741 行

#### 3.4.1 PID 管理 (pid.rs — 152 行)

- u64 位图分配器（`PID_BITMAP: [u64; 8]`），支持最多 512 个 PID
- `alloc_pid() -> Option<PidHandle>`：扫描位图找空闲位
- `PidHandle(usize)`：RAII 句柄，`Drop` 时自动释放位图
- `MAX_PROCESSES = 512`，PID 0 保留给 idle

#### 3.4.2 TCB 定义 (task.rs — 约 400 行)

```rust
pub struct TaskControlBlock {
    pub pid: PidHandle,
    pub pgid: usize,              // 进程组 ID
    pub sid: usize,               // 会话 ID
    pub state: TaskState,         // Ready/Running/Blocked/Stopped/Zombie
    pub context: TaskContext,     // 内核上下文（callee-saved）
    pub kstack_pages: [PhysPageNum; 16], // 64KB 内核栈
    pub kstack_top: usize,
    pub satp_val: usize,
    pub addr_space: Option<AddressSpace>,
    pub addr_space_owner: usize,  // CLONE_VM 线程指向父进程
    pub exit_code: i32,
    pub killed_by_signal: Option<u32>,
    pub time_slice: usize,        // 剩余 tick
    pub fd_table: [FdKind; 128],
    pub fd_cloexec: u128,
    pub parent_pid: usize,
    pub children: [usize; 512],
    pub child_count: usize,
    pub signal: SignalState,
    pub cwd_inode: u16,
    pub exe_path: [u8; 256],
    pub posix_timer: PosixTimerState,
    pub itimer_real: PosixTimerState,
    pub clear_child_tid: usize,
    pub sleep_deadline: u64,      // nanosleep 唤醒时间
    pub sleep_interrupted: bool,
    pub sleep_woken: bool,
    pub vfork_waiter: usize,      // vfork 父进程 PID
    pub waiting_for_child: bool,
    pub tp_value: usize,          // TLS 线程指针
}
```

关键设计要点：
- **零堆分配**：所有 TCB 存在 `[Option<TCB>; 512]` 固定数组中
- **内核栈 64KB**（16 页）：需要 `alloc_contiguous_frames()` 保证物理连续
- **`new()` 创建 S-mode 内核任务**：`context = TaskContext::goto(entry, kstack_top)`
- **`new_user()` 创建 U-mode 任务**：在 `kstack_top - CTX_SIZE` 处预填 `TrapContext`，设置 `sepc=entry, sp=user_sp, sstatus.SPP=0`
- `TaskState` 六态生命周期：UnInit → Ready ⇄ Running → Blocked/Stopped → Zombie/Exited

#### 3.4.3 任务管理器 (manager.rs — 约 550 行)

`TaskManager` 全局单例（`static mut MANAGER`）：

```rust
pub(crate) struct TaskManager {
    pub(crate) tasks: [Option<TaskControlBlock>; 512],
    pub(crate) ready_queue: [usize; 512],    // 环形队列
    pub(crate) queue_head/tail/count: usize,
    pub(crate) current: usize,               // 当前运行 PID
    pub(crate) idle_ctx: TaskContext,        // idle 上下文
    pub(crate) scratch_ctx: TaskContext,     // exit 废上下文
    pub(crate) pending_reap: [usize; 512],   // 延迟回收列表
    pub(crate) pending_reap_count: usize,
    pub(crate) initialized: bool,
}
```

**调度器核心 `schedule()`**：
1. 首先处理 `pending_reap`——上一次 exit 留下的 orphan TCB（延迟回收确保不在自身栈上释放）
2. 从就绪队列 `pop_next_runnable()`（跳过 state 非 Ready 的僵尸条目）
3. 若 `next_pid == cur_pid` 且为唯一任务 → 跳过切换
4. 设置 `next.state = Running`，`next.time_slice = DEFAULT_TIME_SLICE`
5. 调用 `__switch(cur_ctx, next_ctx)` 执行上下文切换
6. 切换 satp（若 next 有独立地址空间）

**时间片轮转**：`DEFAULT_TIME_SLICE = 5` ticks（每个 tick = 10ms → 50ms 片）。`timer_tick()` 由定时器回调调用：
- 若 can_preempt 且当前是 U-mode 任务 → 递减 time_slice
- time_slice 归零 → Running → Ready → 入就绪队列 → `schedule()`

**spawn / spawn_user**：分配 TCB → 创建内核栈 → 设置初始上下文 → Ready + 入队

**yield_current**：Running → Ready → 入队 → schedule()

**wakeup(pid)**：Blocked → Ready → 入队

**block_current_until(deadline)**：Running → Blocked，设置 sleep_deadline，schedule()

#### 3.4.4 进程生命周期 (lifecycle.rs — 约 300 行)

**exit_current()** 流程：
1. 处理延迟回收
2. PID 1 退出 → 调用 SBI shutdown
3. 切换回内核页表
4. Drop 地址空间（释放所有用户帧 + 页表帧）
5. 关闭所有 fd（通过 `fd_close_resource` 回调）
6. vfork 唤醒：若 `vfork_waiter != 0`，唤醒父进程
7. 如果是线程 (`addr_space_owner != cur`)：直接加入 pending_reap，释放 PID
8. 否则：转为 Zombie 状态，保留 TCB 槽位
9. 通知父进程 SIGCHLD
10. `schedule()`（永不返回）

**waitpid_current()**：遍历子进程列表找 Zombie → 提取 exit_code → 回收 TCB 槽位 + PID → 返回。若无 Zombie 子进程且非 WNOHANG，则 `waiting_for_child = true` + Blocked。

#### 3.4.5 信号系统 (signal.rs — 约 350 行 / sig_deliver.rs — 约 300 行)

**signal.rs** 定义：
- 标准信号常量（SIGHUP=1 到 SIGSYS=31，NSIG=64）
- `SigAction` 结构体（与 Linux `kernel_sigaction` 兼容）
- `SignalState`：`pending: u64`（位图）、`blocked: u64`（位图）、`actions: [SigAction; 64]`
- `fork_clone()`：继承 blocked，非 SIG_IGN handler 重置为 SIG_DFL（防止信号链式传播）
- `exec_reset()`：非 SIG_IGN handler 重置为 SIG_DFL
- `has_interrupting_pending()`：检查是否有需要打断阻塞 syscall 的 pending 信号
- `handle_user_fault()`：将硬件异常映射到信号（PageFault→SIGSEGV，IllegalInstruction→SIGILL）

**sig_deliver.rs** 实现：
- `send_signal(target_pid, sig)`：设置 pending 位 + 若目标 Blocked 则唤醒（包括 SIGTERM/SIGINT 打断）
- `deliver_pending_signals()`（pre_return_to_user 回调）：
  1. 遍历 deliverable（pending & ~blocked & ~ignored）信号
  2. 默认动作：Terminate/CoreDump → exit，Stop → 设置 Stopped，Continue → 恢复 Ready
  3. 用户 handler：在用户栈构造 `SignalFrame`，设置 `sepc = handler`, `ra = restorer`（指向 `__sigreturn` trampoline）
- `do_sigreturn()`：从用户栈恢复原始 TrapContext

---

### 3.5 系统调用 (syscall/) — 约 4,286 行

#### 3.5.1 分发框架

**dispatch.rs** (约 300 行)：定义 70+ 个 syscall 编号常量（遵循 Linux RISC-V ABI），match 分发到各功能域处理器。包含所有标准 syscall 常量即使未实现（标记为 stub）。

**check.rs** (235 行)：用户指针验证。`validate_user_buffer(addr, len)` / `validate_user_buffer_write(addr, len)` 检查地址是否在用户空间且已映射。`read_bytes_from_user()` / `write_bytes_to_user()` 通过页表翻译执行安全读写。

#### 3.5.2 已实现的系统调用

| 类别 | 系统调用 | 编号 | 说明 |
|------|---------|------|------|
| **I/O** | read/write/close | 63/64/57 | 通过 fd_table 分发到 File/PipeRead/PipeWrite |
| | pipe2 | 59 | 创建管道，分配读写 fd |
| | dup/dup3 | 23/24 | fd 复制，dup3 支持 O_CLOEXEC |
| | fcntl | 25 | F_DUPFD/F_GETFD/F_SETFD/F_GETFL/F_SETFL |
| | ioctl | 29 | TIOCGWINSZ/TCGETS等终端ioctl |
| | writev/readv | 66/65 | 聚集写/散布读 |
| | sendfile | 71 | 文件到文件零拷贝传输 |
| | ppoll | 73 | 多路复用poll |
| | readlinkat | 78 | 读符号链接 |
| **进程** | exit/exit_group | 93/94 | 进程/线程组退出 |
| | clone | 220 | fork+vfork+CLONE_VM线程 |
| | execve | 221 | 替换进程映像 |
| | wait4 | 260 | 等待子进程（支持WNOHANG） |
| | getpid/getppid | 172/173 | PID查询 |
| | gettid | 178 | 线程ID |
| | sched_yield | 124 | 主动让出CPU |
| | set_tid_address | 96 | 设置clear_child_tid地址 |
| | set_robust_list | 99 | robust futex链表（存根） |
| | setpgid/getpgid/getsid/setsid | 154-157 | POSIX进程组/会话 |
| **信号** | rt_sigaction | 134 | 设置信号处理 |
| | rt_sigprocmask | 135 | 阻塞/解阻塞信号 |
| | rt_sigreturn | 139 | 从信号handler恢复 |
| | rt_sigsuspend | 133 | 原子挂起+等待信号 |
| | kill | 129 | 发送信号 |
| | tgkill | 131 | 线程定向信号 |
| **文件** | openat | 56 | 打开文件 |
| | getdents64 | 61 | 读目录 |
| | lseek | 62 | 文件定位 |
| | fstat/fstatat | 80/79 | 文件状态 |
| | getcwd | 17 | 当前工作目录 |
| | chdir | 49 | 切换目录 |
| | mkdirat | 34 | 创建目录 |
| | unlinkat | 35 | 删除文件 |
| | fchmodat/fchownat | 53/54 | 权限/属主修改 |
| | renameat2 | 276 | 重命名 |
| | mount/umount2 | 40/39 | 挂载（支持bind mount） |
| | statfs | 43 | 文件系统统计 |
| | ftruncate | 46 | 截断文件 |
| | utimensat | 88 | 文件时间戳 |
| | faccessat | 48 | 访问检查 |
| **内存** | brk | 214 | 堆边界调整 |
| | mmap | 222 | 内存映射（匿名+文件） |
| | munmap | 215 | 解除映射 |
| | mprotect | 226 | 页权限修改 |
| **时间** | nanosleep | 101 | 纳秒睡眠 |
| | clock_gettime | 113 | 时钟查询 |
| | clock_nanosleep | 115 | 高精度睡眠 |
| | gettimeofday | 169 | 时间获取 |
| | times | 153 | 进程时间 |
| | getitimer/setitimer | 102/103 | 间隔定时器 |
| **其他** | uname | 160 | 系统信息（OSKernel/riscv64） |
| | getrandom | 278 | 伪随机数 |
| | sysinfo/syslog | 179/116 | 系统信息/日志（存根） |
| | futex | 98 | 快速用户态互斥（基本支持） |
| | socketpair | 199 | socketpair创建 |
| | prlimit64 | 261 | 资源限制 |
| | madvise | 233 | 内存建议 |
| | sched_* | 118-123 | 调度器信息（存根） |

---

### 3.6 虚拟文件系统 (fs/) — 约 4,762 行

#### 3.6.1 VFS 核心架构

VFS 使用**函数指针表（FsOps）** 实现文件系统多态：

```rust
pub struct FsOps {
    pub read: fn(u8, u32, usize, &mut [u8]) -> isize,
    pub write: fn(u8, u32, usize, &[u8]) -> isize,
    pub lookup: fn(u8, u32, &[u8]) -> Option<u32>,
    pub create: fn(u8, u32, &[u8], InodeType) -> Option<u32>,
    pub unlink: fn(u8, u32, &[u8]) -> isize,
    pub readdir: fn(u8, u32, usize) -> Option<([u8; 128], u8, u32, InodeType)>,
    pub stat: fn(u8, u32) -> Stat,
    pub truncate: fn(u8, u32, usize) -> isize,
    pub rename: fn(u8, u32, &[u8], u32, &[u8]) -> isize,
}
```

每个文件系统提供一组静态 FsOps 实例，`get_ops(fs_id)` 按挂载索引返回对应表。

**全局结构**：
- `FILE_TABLE: [GlobalFile; 512]` — 全局文件对象表
- `INODE_TABLE: [Inode; 1024]` — 全局 inode 表
- `MOUNT_TABLE: [MountEntry; 16]` — 挂载表

**路径解析** (path.rs — 207 行)：
- `resolve_path(cwd, path)`：遍历路径组件，处理 `/`、`.`、`..`
- 挂载点穿越：解析到挂载点时切换到目标文件系统的根 inode
- `resolve_parent()`：解析到父目录（用于 create/unlink）

#### 3.6.2 RamFs (ramfs/) — 约 592 行

全内存文件系统，用作根文件系统：

- **数据结构**：`DEntry` 目录项（name + inode号 + 类型）、`INodeData`（数据页列表 + 文件大小）
- 全局 `ENTRIES: [DEntry; 2048]`（目录项池）和 `INODES: [Option<INodeData>; 256]`
- 支持创建/删除/重命名/读写/截断
- 读写直接操作 `Vec<PhysPageNum>` 数据页

#### 3.6.3 EXT4 驱动 (ext4/) — 约 1,800 行

**重要：这是一个具有读写能力的 EXT4 驱动（深度 0 extent 树）**。

- **超级块解析** (mod.rs — 180 行)：解析 superblock（偏移 1024 字节），验证 magic (0xEF53)，提取 block_size/inodes_per_group/inode_size/blocks_count/group_count。支持 64-bit 特性（bg_desc_size >= 64）
- **磁盘 I/O** (disk_io.rs — 80 行)：基于 Virtio-blk 的 `read_bytes/write_bytes/read_block/write_block`，全局 `BLOCK_BUF: [u8; 4096]`（在关中断下使用）
- **Extent 树遍历** (extent.rs — 170 行)：
  - `extent_map_block(i_block, logical_block)`：递归遍历 extent 树（支持 depth > 0 的索引节点）
  - `extent_append(i_block, logical_block, phys_block)`：仅支持 depth=0 叶子扩展
- **Inode 操作** (inode.rs — 175 行)：
  - `read_raw_inode(ino)`：读块组描述符→inode表→解析 i_mode/i_size/i_flags/i_block
  - `update_inode_size/update_inode_nlink/write_inode_iblock/init_new_inode`
- **目录操作** (dir.rs — 约 300 行)：
  - `dir_lookup(dir_ino, name)`：遍历 extent 映射的目录块，线性搜索目录项
  - `dir_readdir(dir_ino, index)`：跳过 `.` 和 `..`，返回第 index 个目录项
  - `dir_add_entry(dir_ino, name, child_ino, itype)`：在 dirent 间隙插入或分配新块
  - `dir_remove_entry(dir_ino, name)`：标记 inode=0 删除目录项
- **块/Inode 分配** (alloc.rs — 150 行)：
  - `alloc_block()`：扫描所有块组的 block bitmap
  - `alloc_inode()`：扫描 inode bitmap
  - `free_block()` / `free_inode()`：清除 bitmap 位
- **文件操作** (ops.rs — 260 行)：`ext4_read`（通过 extent_map_block + read_block）、`ext4_write`（extent_map + 分配新块 + write_block）、`ext4_lookup/create/unlink/readdir/rename/stat`
- **Busybox 内联** (busybox.rs — 133 行)：`is_busybox_applet(name)` 检测是否已知 busybox 小程序名，在 lookup 失败时补充（用于 `/mnt` 根目录缺少 busybox 硬链接的场景）

#### 3.6.4 DevFs (devfs.rs — 约 270 行)

编译期固定的设备文件系统：
- `/dev/console` — 读写 UART
- `/dev/null` — 写丢弃，读返回 0
- `/dev/zero` — 读返回零
- `/dev/urandom` — xorshift 伪随机数
- `/dev/misc/rtc` — RTC 时钟（通过 ioctl）
- `/dev/shm` — 共享内存目录
- `devfs_ioctl()`：支持 TIOCGWINSZ（返回 24×80 终端尺寸）和 RTC_RD_TIME

#### 3.6.5 ProcFs (procfs.rs — 约 280 行)

动态生成的进程信息文件系统：
- `/proc/mounts` — 挂载信息（供 df 使用）
- `/proc/meminfo` — 内存统计（供 free 使用）
- `/proc/cpuinfo` — CPU 信息
- `/proc/{pid}/stat` — 进程状态（供 ps 使用）
- `/proc/self` — 当前进程符号链接

---

### 3.7 ELF 加载器 (loader/) — 约 1,301 行

#### 3.7.1 ELF 解析

**elf.rs** (110 行)：纯数据结构定义：`Elf64Header` (64 bytes)、`Elf64ProgramHeader` (56 bytes)、aux vector 常量

**from_pages.rs** (约 400 行)：从非连续页框加载 ELF64：
1. 验证 ELF header（magic/class/endian/type/machine）
2. 创建新 `AddressSpace`（自带内核 splice）
3. 遍历 PT_LOAD 段：分配帧 → 复制数据 → 清零 BSS → `map_user_page()`
4. 支持 PT_INTERP：若存在且未提供 interp_buf，返回 `NeedsInterp(path, len)`
5. 支持 ET_EXEC（固定地址）和 ET_DYN（PIE，基础偏移 `ELF_DYN_BASE = 0x400000`）
6. 动态链接器加载到 `INTERP_BASE = 0x20000000`

#### 3.7.2 用户栈构建

**stack.rs** (177 行)：
- 栈顶 `USER_STACK_TOP = 0x7f800000`（避免 32-bit 边界 glibc sext.w 问题）
- 默认 2 页（8KB），最大 2048 页（8MB）
- 构建标准 Linux RISC-V 用户栈布局：argc → argv[n] → 0 → envp[n] → 0 → auxv
- Aux vector：AT_PHDR/AT_PHENT/AT_PHNUM/AT_PAGESZ/AT_BASE/AT_ENTRY/AT_HWCAP 等

#### 3.7.3 TLS 支持

**tls.rs** (188 行)：线程局部存储。`TlsInfo` 包含 `tp_value`, `tls_size`, `tls_align`。支持 PT_TLS 段解析和 TLS 初始化映像处理。

#### 3.7.4 exec 路径 (sched/exec.rs — 约 500 行)

完整的 exec 流：
1. 通过 VFS 读取 ELF 文件到临时页框（最多 512 页 = 2MB）
2. 调用 `load_elf_from_pages()`，支持：
   - 静态 ELF → 直接加载
   - 动态 ELF → 返回 `NeedsInterp` → 加载解释器 → 重新调用
   - Shebang 脚本 (`#!`) → 解析解释器路径 → 递归 exec
3. 替换 TCB 地址空间（Drop 旧的）
4. 重写内核栈上的 TrapContext（新入口/栈）
5. 切换 satp，返回（从 `__trap_return` 回到新进程的用户态）

---

### 3.8 进程间通信 (ipc/pipe/) — 约 489 行

**POSIX 管道**（约 490 行）：
- 全局管道池 `PIPES: [Pipe; 1024]`
- 环形缓冲区：`buf: [u8; 4096]` + `read_pos/write_pos/count`
- 引用计数：`readers` 和 `writers` 计数，读写端分别增/减
- 阻塞语义：
  - `pipe_read_blocking()`：管道空时阻塞当前任务，被写者唤醒
  - `pipe_write_blocking()`：管道满时阻塞，被读者唤醒
- EOF 语义：所有写者关闭时读者读到 0；所有读者关闭时写者收到 EPIPE
- 唤醒队列：`blocked_readers: [usize; 8]` / `blocked_writers: [usize; 64]`
- `pipe_poll()`：支持 POLLIN/POLLOUT/POLLHUP/POLLERR 事件（用于 ppoll）

---

### 3.9 块设备驱动 (drivers/virtio_blk/) — 约 403 行

**Virtio MMIO v1 (legacy) 块设备驱动**：
- 探测地址 `0x10001000`（QEMU virt 平台第一个 virtio MMIO 槽）
- `io.rs` (202 行)：设备初始化（reset → ACKNOWLEDGE → DRIVER → FEATURES_OK → DRIVER_OK → 设置 virtqueue）
- Virtqueue 使用单个描述符（无需链）：desc[0] = header (OUT) + data (IN) + status (IN)
- `block_io(type, sector, buf, len)`：填充请求→kick→轮询 used ring
- 公开接口：`read_sector()` / `write_sector()`，512 字节扇区粒度
- 支持 version 1 和 2

---

### 3.10 TTY 子系统 (tty/) — 约 236 行

- **driver.rs** (59 行)：后端注册机制。`TtyBackend { putc, getc }`，当前注册 UART 后端
- **macros.rs** (19 行)：`print!` / `println!` 宏定义，基于 `TtyWriter` + `core::fmt::Write`
- **termios.rs** (64 行)：POSIX termios 常量定义
- **line_discipline.rs** (32 行)：行规程框架（预留）

---

### 3.11 内核日志 (klog.rs — 143 行)

结构化日志宏：`kinfo!` / `kwarn!` / `kerror!` / `kdebug!`，带级别前缀和时间戳（基于 mtime）。编译期可通过常量过滤日志级别。

---

### 3.12 测试子系统 (test/) — 约 4,710 行

共 14 个测试模块、49 项测试：

| 模块 | 测试内容 |
|------|---------|
| mm.rs | 帧分配/连续分配/引用计数/页表映射/翻译/解除映射 |
| sched.rs | PID分配/TCB创建/多任务spawn/时间片轮转/抢占 |
| vm.rs | satp切换/splice/AddressSpace创建/map_user_page |
| umode.rs | U-mode syscall/独立VA/异常处理/brk/bad_ptr/close |
| safety.rs | 关中断临界区保护 |
| ipc.rs | 管道创建/读写/阻塞唤醒/EOF/引用计数 |
| loader.rs | ELF解析/段映射/BSS清零 |
| exec.rs | exec流程/地址空间替换 |
| waitpid.rs | 进程回收/Zombie清理/退出码传递 |
| signal.rs | 信号发送/阻塞/用户handler/sigreturn |
| blk.rs | Virtio-blk探测/读写扇区 |
| lseek.rs | SEEK_SET/SEEK_CUR/SEEK_END |
| ext4.rs | 超级块解析/inode读取/extent遍历/目录操作 |
| tls.rs | TLS信息传递/tp设置 |
| tty.rs | TTY后端注册/输出 |

---

### 3.13 用户程序 (user/)

- **init** (约 350 行 Rust)：PID 1 init 进程，设置 musl/glibc 动态链接器 bind mount，创建并运行 `test_all.sh`、glibc 测试脚本
- **hello** (25 行汇编)：最小用户程序，write + exit
- **tls_test** (约 80 行)：TLS 线程局部存储测试

---

## 四、子系统完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **启动序列** | 90% | entry.S + BSS清零 + 栈设置完整。缺：多核启动 (SMP) |
| **Trap处理** | 95% | 完整的S-mode/U-mode trap，嵌套保护，信号集成。缺：浮点/向量寄存器保存 |
| **定时器** | 95% | SBI v0.2/Legacy双后端，one-shot支持，活性检测。功能完整 |
| **中断控制** | 80% | PLIC + UART中断。缺：其他设备中断 |
| **物理内存管理** | 85% | 位图分配+引用计数+连续分配，DTB解析。缺：页面回收(swap)、NUMA |
| **虚拟内存** | 80% | Sv39完整，缺页处理+COW隔离+mprotect。缺：按需调页文件(lazy mmap file) |
| **进程调度** | 75% | 时间片轮转+阻塞唤醒+六态生命周期。缺：优先级调度、多核 |
| **进程管理** | 80% | fork/exec/waitpid/vfork/CLONE_VM线程+信号。缺：cgroup |
| **信号** | 85% | 标准信号+handler+sigreturn+信号帧。缺：siginfo队列、实时信号排队 |
| **VFS框架** | 85% | FsOps多态+路径解析+挂载点穿越。缺：inode锁、页缓存 |
| **RamFs** | 80% | 全内存文件系统，读写创建删除完整。缺：权限增强 |
| **EXT4** | 60% | 只读完整+写入支持(extent深度0)+分配器。缺：间接块、日志、深度>0写入 |
| **DevFs** | 75% | 标准设备文件，ioctl支持。缺：动态设备添加 |
| **ProcFs** | 60% | mounts/meminfo/stat/cpuinfo。缺：完整/proc/pid/目录 |
| **ELF加载器** | 85% | 静态+PIE+动态链接器+shebang+TLS+栈构建。功能完整 |
| **管道IPC** | 80% | 环形缓冲区+阻塞唤醒+EOF+引用计数。缺：非阻塞模式 |
| **系统调用** | 70% | 70+个syscall，覆盖I/O/进程/文件/信号/内存/时间。缺：socket、完整futex |
| **块设备驱动** | 70% | Virtio-blk v1 polling模式。缺：中断模式、多队列 |
| **TTY** | 50% | 后端注册+输出宏。缺：行规程实现、termios操作 |
| **HAL** | 40% | 当前仅RISC-V薄包装，框架完整但尚未多架构 |

**总体内核完整度**：约 **70%**（以支持 busybox + musl/glibc 用户态工具链运行 LTP 等测试为目标来衡量）

---

## 五、内核各部分交互机制

### 5.1 系统调用全路径

```
用户态 ecall
  → __trap_entry (汇编保存寄存器)
    → __trap_handler (Rust分发)
      → handle_exception → EcallFromU → handle_syscall
        → callbacks.syscall_dispatch(id, args)
          → syscall::dispatch() (match路由)
            → 具体sys_xxx()
              → sched/fs/ipc/mm 子系统
      → callbacks.pre_return_to_user()
        → deliver_pending_signals() (信号投递)
  → __trap_return (汇编恢复寄存器)
  → sret (返回用户态)
```

### 5.2 上下文切换路径

```
定时器中断 (U-mode)
  → __trap_entry
    → handle_interrupt(SupervisorTimer)
      → timer::on_tick(can_preempt=true)
        → tick_handler → sched::manager::timer_tick
          → 递减 time_slice → 0 → schedule()
            → __switch(cur_ctx, next_ctx)
              → 保存 ra/sp/s0-s11 → 恢复下一个的上下文 → ret
```

### 5.3 缺页异常处理路径

```
用户态访存 → 页错误
  → __trap_entry → __trap_handler
    → handle_exception(LoadPageFault/StorePageFault)
      → callbacks.user_fault(sepc, stval, fault_kind)
        → handle_user_fault()
          → mm::fault::handle_page_fault(addr_space, stval, is_write)
            → 查找 VmArea → 按需分配帧 → map_user_page()
          → 若失败 → send_signal(SIGSEGV)
```

### 5.4 VFS 调用链

```
用户态 read(fd, buf, len)
  → syscall::io::sys_read
    → manager::current_fd_kind(fd)
      → match FdKind::File(gfd) → fs::file_read(gfd, buf)
        → file_ops::file_read → 查 FILE_TABLE[gfd] → get_ops(fs_id).read(fs_id, fs_inode, offset, buf)
          → RamFs: 直接内存拷贝
          → EXT4: read_inode_data → extent_map_block → read_block → 磁盘I/O
          → DevFs: 根据设备类型分发
```

---

## 六、设计创新点分析

### 6.1 回调注入解耦架构

这是本项目的**核心架构创新**。通过函数指针回调，arch/ 层与 sched/syscall 层完全解耦，使架构层可以独立编译和测试。这在教学/比赛级内核中罕见，通常这些层会直接相互 import。具体实现：

1. `TrapCallbacks` 三个回调注册点
2. `FdCallbacks` 解耦 sched/ 与 ipc/fs 引用计数
3. 定时器回调解耦 arch/ 与 sched/

### 6.2 零堆分配设计

整个内核（TCB 池、管道池、inode 表、文件表、PID 位图）全部使用编译期固定大小的全局数组，无 `Box`/`Vec` 堆分配。这不仅避免了 `alloc` crate 依赖，也消除了内核堆碎片化问题。代价是硬编码上限（如 512 进程、1024 inode、1024 管道）。

### 6.3 帧后备存储（MappingStore / VmAreaList）

将地址空间的用户映射记录从栈/BSS 内联数组转移到按需分配的物理帧，解决了 "每个进程需要多少映射" 的不确定性问题。这是一种在 `#![no_std]` + 无动态分配环境下的实用折衷方案。

### 6.4 EXT4 读写驱动

在比赛/教学内核中实现 EXT4 **读写** 驱动（含 extent 树遍历、block/inode 分配器）是相当完整的实现。虽然仅限于 depth=0 的 extent 追加，但已覆盖了小文件的读、写、创建、删除、重命名全操作。

### 6.5 双 libc 兼容（musl + glibc）

init 进程同时支持 musl 和 glibc 测试套件，动态链接器路径和 TLS 处理分别适配。RISC-V Linux ABI 系统调用编号 100% 兼容，使得标准 musl/glibc 工具链几乎无需修改即可运行。

### 6.6 SBI Timer 活性检测

在探测 SBI v0.2 Timer Extension 时，实际编程短 deadline 并 spin 等待 `sip.STIP` 来验证中断活性。这解决了 RustSBI v0.2.2 可能返回成功但不产生 interrupt pending 的兼容性问题。

---

## 七、其他重要信息

### 7.1 已知限制

1. **单核**：MANAGER 是全局单例，依赖于关中断保护而非锁，不支持 SMP
2. **调度策略单一**：仅有时间片轮转，无优先级
3. **EXT4 写入限于 depth=0 extent 树**：大文件（超过 4 个 extent）无法写入
4. **无文件锁/Inode 锁**：并发文件操作不安全（但单核下 FIFO 调度规避了此问题）
5. **内存硬编码 128MB**：回退布局固定在 QEMU virt 128MB
6. **无交换 (swap)**：物理内存耗尽即失败

### 7.2 代码质量观察

- 大量 `debug_assert!` 和运行时断言（如 ctx 位置检查、溢出检查）
- `unsafe` 使用集中在 arch/ 和内存管理边界，上层多用安全抽象
- 所有全局可变状态访问都经过 `with_interrupts_disabled` 保护
- 注释中包含大量设计决策解释（尤其是 trap.S 和 schedule()）

---

## 八、总结

**OSKernel** 是一个在 Rust `#![no_std]` 约束下构建的、具有相当实用性的 RISC-V 64 UNIX-like 微内核。其核心特性包括：

- **完整的 POSIX 进程模型**：fork/exec/waitpid/信号/管道/文件描述符
- **四文件系统支持**：RamFs（根）、DevFs（设备）、EXT4（磁盘读写）、ProcFs（进程信息）
- **70+ Linux 兼容系统调用**：足以运行 busybox + musl/glibc 用户态工具链
- **Sv39 虚拟内存**：独立地址空间 + 缺页处理 + mmap + COW 隔离
- **优雅的解耦架构**：回调注入模式使底层架构与上层策略完全分离
- **零堆分配设计**：全局固定数组 + 帧后备存储

该项目的技术深度在同类比赛/教学内核中表现突出，尤其是在 EXT4 读写驱动、双 libc 兼容、信号机制完整性和架构解耦设计方面展现了成熟的系统工程思维。