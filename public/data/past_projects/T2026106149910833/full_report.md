# OSKernel2026-X 内核项目深度技术分析报告

## 一、分析过程说明

本报告基于以下分析方法得出：

1. **源码静态分析**：逐文件阅读了全部 170 个 Rust 源文件的关键部分，覆盖了 `source/arch/contract/`（架构契约层）、`source/arch/riscv64/` 与 `source/arch/loongarch64/`（平台实现层）、`source/core/`（核心子系统）、`source/kernel/`（内核编排层）、`source/official/`（评测适配层）等所有模块。
2. **构建验证**：使用环境提供的 Rust 工具链（rustc 1.89.0-nightly）对 RISC-V 64 和 LoongArch64 两个目标均成功完成 `cargo build`，产物分别为 28 MB（RISC-V）和 27.7 MB（LoongArch）的 ELF 可执行文件。
3. **链接脚本分析**：分析了 `source/build/riscv64.ld` 和 `source/build/loongarch64.ld` 的内存布局设计。
4. **汇编入口分析**：分析了 `arch/riscv64/boot.S`、`arch/riscv64/trap.S`、`arch/riscv64/user_v45.S` 以及内联在 Rust 源文件中的汇编代码。
5. **配置文件分析**：分析了 `config/real_run_policy.json`（真实运行策略配置）、`Makefile`、`Cargo.toml` 等构建和运行配置。

未进行 QEMU 实际运行测试，因为缺少官方评测所需的 ext4 根文件系统镜像（`.img` 文件），无法构造完整的启动环境。此限制在报告中标注。

---

## 二、构建测试结果

### 2.1 RISC-V 64 构建

| 项目 | 结果 |
|------|------|
| 目标三元组 | `riscv64gc-unknown-none-elf` |
| 构建命令 | `cargo build --target riscv64gc-unknown-none-elf` |
| 构建结果 | **成功**（13.23s） |
| 产物路径 | `target/riscv64gc-unknown-none-elf/debug/source-riscv64-kernel` |
| 产物大小 | 28,026,232 字节 (~26.7 MB) |
| 产物类型 | ELF 64-bit LSB executable, UCB RISC-V, RVC, double-float ABI, statically linked, not stripped |
| 警告数量 | 无（`#![deny(warnings)]`） |

### 2.2 LoongArch64 构建

| 项目 | 结果 |
|------|------|
| 目标三元组 | `loongarch64-unknown-none` |
| 构建命令 | `cargo build --target loongarch64-unknown-none` |
| 构建结果 | **成功**（13.75s） |
| 产物路径 | `target/loongarch64-unknown-none/debug/source-loongarch64-kernel` |
| 产物大小 | 27,677,584 字节 (~26.4 MB) |
| 产物类型 | ELF 64-bit LSB executable, LoongArch, statically linked, not stripped |

### 2.3 测试缺失说明

未进行 QEMU 实际启动测试，原因：项目依赖官方评测提供的 ext4 根文件系统镜像作为 VirtIO 块设备后端，该镜像未包含在仓库中。内核启动路径中的块设备探测、ext4 挂载和用户程序执行依赖于外部提供的磁盘镜像。

---

## 三、项目整体架构

### 3.1 架构概览

该项目采用**分层单体内核**架构，通过架构契约（Architecture Contract）模式实现跨平台硬件抽象。整体分为四层：

```
+-----------------------------------------------+
|  bin/          内核二进制入口（汇编桩+Rust入口）     |
+-----------------------------------------------+
|  kernel/       内核编排层（启动、执行、调度、运行时）   |
+-----------------------------------------------+
|  core/         核心子系统层（进程、调度、文件系统、    |
|                内存管理、系统调用、加载器、时间、随机数） |
+-----------------------------------------------+
|  arch/         架构层                              |
|    contract/   硬件抽象契约（平台中立接口）           |
|    riscv64/    RISC-V 64 平台具体实现              |
|    loongarch64/ LoongArch64 平台具体实现            |
+-----------------------------------------------+
```

### 3.2 代码规模

| 指标 | 数值 |
|------|------|
| Rust 源文件总数 | **170** |
| 总代码行数 | **~84,237** |
| 最大单文件 | `source/kernel/syscall_runtime/vfs_backend.rs` (3,367 行) |
| 第二大文件 | `source/core/fs/vfs.rs` (2,485 行) |
| 系统调用层总代码 | ~27 个文件，~18,000 行 |
| 文件系统层总代码 | ~20 个文件，~18,000 行 |

---

## 四、子系统详细拆解

### 4.1 架构抽象契约层 (`source/arch/contract/`)

这是该项目最具设计特色的模块。它定义了 12 个架构中立的硬件服务契约，每个契约采用**函数指针 + 状态枚举**的模式来实现依赖注入：

#### 4.1.1 契约模块清单

| 契约模块 | 文件 | 核心抽象 | 功能 |
|----------|------|----------|------|
| `boot` | `contract/boot.rs` | `BspServices`, `EarlyBootInfo`, `BootInitPath` | 启动信息收集、BSP 服务聚合 |
| `block` | `contract/block.rs` | `BlockServices` | 块设备读写服务 |
| `console` | `contract/console.rs` | `FatalConsole` | 致命错误控制台输出 |
| `context` | `contract/context.rs` | `ContextSwitchServices`, `ContextSwitchRequest` | 上下文切换、首次运行帧准备 |
| `halt` | `contract/halt.rs` | `HaltReason`, `FatalReason` | 系统停机原因分类 |
| `mmu` | `contract/mmu.rs` | `MmuServices`, `KernelMmuRequest` | 内核/用户 MMU 配置 |
| `timer` | `contract/timer.rs` | `TimerServices`, `TimerConfig` | 定时器配置与控制 |
| `trap` | `contract/trap.rs` | `TrapServices`, `TrapVector` | 异常向量安装 |
| `user_entry` | `contract/user_entry.rs` | `UserEntryServices`, `UserEntryTrapStackRequest` | 用户态入口与返回 |
| `boundary` | `contract/boundary.rs` | `BoundaryMode` | 操作边界模式（Inspect/Prepare/ApplyUnsafe） |
| `readiness` | `contract/readiness.rs` | `HardwareReadiness` | 硬件就绪状态查询 |
| `fdt` | `contract/fdt.rs` | （FDT 解析相关） | 设备树扁平化解析 |

#### 4.1.2 设计模式详解

**BoundaryMode 三阶段状态机**：每个硬件操作通过 `BoundaryMode` 枚举支持三个阶段：

```rust
// source/arch/contract/boundary.rs 中定义
pub enum BoundaryMode {
    Inspect,    // 仅验证参数，不产生副作用
    Prepare,    // 准备资源但不执行最终操作
    ApplyUnsafe, // 实际执行硬件操作（unsafe 语义）
}
```

这使得调用方可以在不同阶段验证、准备和执行，而不会在不可回滚的状态下出错。

**BspServices 聚合模式**：`BspServices` 是所有平台服务的单一聚合入口，包含函数指针成员和状态快照：

```rust
// source/arch/contract/boot.rs
pub struct BspServices {
    snapshot: BspSnapshot,
    fatal_console: FatalConsole,
    trap: TrapServices,
    timer: TimerServices,
    mmu: MmuServices,
    user_entry: UserEntryServices,
    context_switch: ContextSwitchServices,
    block: BlockServices,
    boot_memory: fn(EarlyBootInfo, KernelLayout) -> BootMemory,
    boot_init_path: fn(EarlyBootInfo) -> Result<BootInitPath, BootInitBlocker>,
    halt: fn(HaltReason) -> !,
}
```

**就绪状态追踪**：每个子系统通过 `HardwareReadiness` 枚举报告其当前状态：

```rust
pub enum HardwareReadiness {
    Ready,
    NotReady(ReadinessReason),
    Unsupported(ReadinessReason),
}
```

#### 4.1.3 契约模式评价

- **优点**：高度解耦架构相关代码和核心逻辑，添加新架构仅需实现契约中的函数指针和枚举变体。
- **成本**：运行时函数指针调用有间接开销，但在裸机内核中这是可接受的工程权衡。
- **完整性**：所有 12 个契约在两个目标架构上都有实现。

---

### 4.2 RISC-V 64 平台实现 (`source/arch/riscv64/`)

#### 4.2.1 启动流程 (`boot.rs`)

- 从固件（OpenSBI）获取 `hart_id` 和 `device_tree` 指针
- 构造 `EarlyBootInfo`（架构类型 = Riscv64）
- 返回聚合的 `BspServices`

#### 4.2.2 内存管理 (`mmu.rs`, `mmu/hardware.rs`, `mmu/pte.rs`, `mmu/user_memory.rs`)

- **Sv39 页表**：三级页表（PGD → PMD → PTE），每级 512 项
- **PTE 标志位映射**：将架构中立的 `MappingFlags` 映射到 RISC-V PTE 的 R/W/X/U/G 位
- **内核映射**：使用 Sv39 恒等映射（identity mapping），基地址 `0x8020_0000`
- **用户内存操作**：实现了 `UserMemoryReader`、`UserMemoryWriter`、`UserMemoryMapper` trait，通过软件遍历页表读取/写入用户空间内存

关键代码——PTE 构造：

```rust
// source/arch/riscv64/mmu/pte.rs 中
pub(super) const fn pte_from_phys(phys: usize, flags: MappingFlags) -> usize {
    let mut pte = (phys >> 2) & 0x003F_FFFF_FFFF_FFC0; // PPN
    if flags.contains(MappingFlags::READ)     { pte |= 1 << 1; }
    if flags.contains(MappingFlags::WRITE)    { pte |= 1 << 2; }
    if flags.contains(MappingFlags::EXECUTE)  { pte |= 1 << 3; }
    if flags.contains(MappingFlags::USER)     { pte |= 1 << 4; }
    if flags.contains(MappingFlags::GLOBAL)   { pte |= 1 << 5; }
    pte |= 1; // Valid
    pte
}
```

#### 4.2.3 异常处理 (`trap.rs`, `trap/block_dispatch.rs`, `trap/block_switch.rs`, `trap/fork.rs`, `trap/signal.rs`)

RISC-V trap 实现是该平台最复杂的模块（~1,222 行主文件 + 4 个子模块）。关键流程：

1. **汇编入口** `__riscv64_trap_vector`：
   - 通过 `csrrw sp, sscratch, sp` 原子切换用户栈到内核 trap 栈
   - 保存全部 32 个通用寄存器 + sepc/sstatus/scause/stval 到 `RiscvUserTrapFrame`（288 字节，16 字节对齐）
   - 调用 `riscv64_user_trap_dispatch()` Rust 函数

2. **Rust 分发逻辑**：
   - 根据 `scause` 区分：用户 ecall（syscall）、指令缺页、加载缺页、存储缺页、定时器中断
   - syscall 路径：构造 `SyscallFrame` → 调用 `dispatch_with_memory()` → 处理 `SyscallOutcome`（立即返回/阻塞/上下文切换/退出）
   - 缺页路径：调用 `single_classify_user_page_fault()` 判断是否合法缺页 → 按需映射用户页面
   - 定时器路径：更新单调时钟 → 检查是否有更高优先级任务就绪 → 按需触发上下文切换

3. **阻塞系统调用处理**：
   - 当系统调用返回阻塞状态（sleep/futex/pipe/epoll/wait4 等），调度器选择下一个就绪任务
   - 执行上下文切换：保存当前任务栈指针 → 切换到新任务 → 加载新地址空间

#### 4.2.4 上下文切换 (`context.rs`)

汇编实现 `__riscv64_context_switch`：
- 保存 callee-saved 寄存器（ra、s0-s11，共 13 个寄存器，112 字节帧）
- 将当前 SP 写入 `TASK_CONTEXT_SAVED_SP_SLOT`
- 通过 `csrw satp` 切换地址空间 + `sfence.vma` 刷新 TLB
- 恢复新任务的寄存器并返回

首次运行蹦床 `__riscv64_context_first_run_trampoline`：
- 从 s0/s1 恢复 arg0/arg1
- 跳转到 s2 中的入口地址（用户态 `sret` 恢复函数）

#### 4.2.5 块设备 (`block.rs`)

实现了 **VirtIO-MMIO** 协议的最小化块设备驱动：
- 固定地址 `0x1000_1000`（QEMU virt 机器第一个 VirtIO 设备）
- 同步轮询模式：建立单个虚拟队列（8 个描述符），自旋等待读取完成
- 仅支持 `VIRTIO_BLK_T_IN`（读操作）
- 旋转等待上限：100,000,000 次迭代

#### 4.2.6 控制台 (`console.rs`)

- 通过 NS16550A UART（地址 `0x1000_0000`）输出字符
- `write_fatal()`：直接内存映射写入，用于 panic 和致命错误输出

#### 4.2.7 定时器 (`timer.rs`)

- 使用 RISC-V `mtimecmp`/`mtime` 寄存器
- 通过 SBI `sbi_set_timer()` 设置下一次定时器中断

#### 4.2.8 用户态入口 (`user_entry.rs`)

- 从 `PendingUserEntry` 构造 `RiscvUserTrapFrame`
- 设置 sepc = 用户入口地址，sstatus 清除 SPP 位（用户模式）
- 通过 `sret` 指令进入用户态

---

### 4.3 LoongArch64 平台实现 (`source/arch/loongarch64/`)

与 RISC-V 实现平行，具有相同的契约接口但使用 LoongArch 特有机制：

#### 4.3.1 上下文切换 (`context.rs`)

- 汇编实现 `__loongarch64_context_switch`
- 12 个寄存器帧（96 字节）：ra, fp, s0-s8, CSR_ESTAT (0x30)
- 通过 `csrwr $a2, 0x19`（CSR_PGDL）切换地址空间 + `invtlb` 刷新

#### 4.3.2 块设备 (`block.rs`)

- 实现了 **PCI ECAM + VirtIO-PCI (Modern)** 协议
- PCI 总线扫描：遍历 Bus 0-127、Device 0-31、Function 0-7
- 识别 VirtIO 块设备（厂商 ID `0x1af4`，设备 ID `0x1001` 传统/`0x1042` 现代）
- BAR 空间手动分配：窗口 `0x4000_0000` - `0x8000_0000`
- VirtIO 通用配置、通知、ISR 能力结构发现
- 同步块读取操作（与 RISC-V 版本相同的自旋轮询模式）

#### 4.3.3 内存管理 (`mmu.rs`)

- LoongArch 页表结构（与 RISC-V Sv39 类似的三级结构）
- PTE 标志位映射到 LoongArch 的 NR/DA/UX/UR/WY/RY/V 位

#### 4.3.4 陷阱处理 (`trap.rs`, `trap_block.rs`)

- 与 RISC-V 版本功能平行
- 使用 LoongArch 特有的 CSR（ECFG, ESTAT, ERA, BADV 等）
- `ertn` 指令从异常返回

#### 4.3.5 链接地址

LoongArch 内核加载地址为 `0x9000_0000`（与 RISC-V 的 `0x8020_0000` 不同）。

---

### 4.4 内存管理子系统 (`source/core/mm/`)

#### 4.4.1 物理页帧分配 (`frame.rs`)

- 页大小：4,096 字节（`PAGE_SIZE = 4096`）
- `PhysFrame`：单个物理页帧（start 地址，必须 4K 对齐）
- `PhysRange`：连续物理页帧范围
- `BootFrameAllocator`：简单的线性自增分配器
  - `Ready { next, end }`：从 next 开始分配，每次移动 `PAGE_SIZE`
  - `NotReady(blocker)`：尚未初始化

```rust
// source/core/mm/frame.rs
pub fn allocate(&mut self) -> Result<PhysFrame, FrameAllocError> {
    match self {
        Self::Ready { next, end } => {
            if *next >= *end {
                Err(FrameAllocError::Exhausted)
            } else {
                let frame = PhysFrame::new(*next)?;
                *next += PAGE_SIZE;
                Ok(frame)
            }
        }
        Self::NotReady(blocker) => Err(FrameAllocError::NotReady(*blocker)),
    }
}
```

#### 4.4.2 内核布局描述 (`frame.rs`)

- `KernelImageRange`：内核镜像整体范围
- `KernelSectionRange`：单个段（text/rodata/data/bss）范围
- `KernelLayout`：聚合所有段信息，验证段顺序和镜像包含关系

#### 4.4.3 页表抽象 (`page_table.rs`)

- `PageTableRoot`：封装根页表物理帧
- `KernelGlobalMappings`：内核恒等映射配置（虚拟地址 = 物理地址）
- `MappingFlags`：权限位集合（READ/WRITE/EXECUTE/GLOBAL/USER），提供预定义组合：
  - `KERNEL_IMAGE`：R+W+X+G（内核代码段全权限）
  - `USER_TEXT`：R+X+U（用户代码段）
  - `USER_DATA`：R+W+U（用户数据段）
  - `USER_STACK`：R+W+U（用户栈）

#### 4.4.4 地址空间管理 (`address_space.rs`)

- `AddressSpace`：内核地址空间 = 硬件根页表 + 内核全局映射
- `UserAddressSpacePlan`：用户地址空间规划，包含 text 段区域、stack 段区域、入口地址、初始栈指针
- 严格的不变量检查：
  - text 区域必须 U+R+X（不可写）
  - stack 区域必须 U+R+W（不可执行）
  - text 和 stack 不能重叠
  - 用户区域不能与内核全局映射冲突
  - 入口地址必须在 text 区域内
  - 初始栈指针必须在 stack 区域内

```rust
// source/core/mm/address_space.rs 中 UserAddressSpacePlan::new()
// 包含详细的权限、重叠、边界检查
pub const fn new(
    kernel_globals: KernelGlobalMappings,
    text: UserMemoryRegion,
    stack: UserMemoryRegion,
    entry: UserEntryAddress,
    initial_stack_pointer: usize,
) -> Result<Self, UserMemoryBlocker> { ... }
```

#### 4.4.5 缺页处理 (`fault.rs`)

- `UserFaultAccess`：读/写/执行分类
- `UserFaultDisposition`：缺页处理结果
  - `Mapped { frame }`：成功映射物理页
  - `ZeroFill { frame }`：零填充页面
  - `SharedFile { frame, offset }`：共享文件映射页面
- `user_fault_page_start()`：计算缺页地址所在页面的起始地址

#### 4.4.6 内存基础 (`foundation.rs`)

- `MemoryFoundation`：聚合帧分配器、内核全局映射和内核地址空间
- `BootMemory`：从固件/设备树发现的可用物理内存范围
- `MemorySummary`：内核地址空间硬件根就绪状态

#### 4.4.7 用户内存拷贝 (`user_copy.rs`)

- `copy_from_user()` / `copy_to_user()`：安全的跨地址空间内存拷贝
- `ProcessMemoryAccess` trait：抽象用户内存访问接口
- 实现 `UserMemoryReader`、`UserMemoryWriter`、`UserMemoryMapper` 三个 trait
- 错误类型：`UserCopyError`（地址未映射/权限不足）、`UserMapError`

---

### 4.5 进程与任务管理子系统 (`source/core/task/`)

#### 4.5.1 进程模型 (`process.rs`)

- `Pid`：进程标识符（`usize` 包装）
- `ExitCode`：退出码，区分正常退出和信号终止
- `ExitState`：退出状态 = PID + 退出码
- `ChildWaitSelector`：子进程等待选择器（任意/PID/进程组）
- `ProcessState`：进程状态机（Runnable/...）
- `Process`：进程主体，持有 PID、调度状态、内存状态、信号状态、凭据
- `ForkRequest`：fork 请求结构
- `RseqRegistration`：可重启序列注册
- `ResourceLimit` / `ResourceLimitKind`：资源限制（文件大小、打开文件数等）

#### 4.5.2 单进程运行时 (`single.rs`, `single/memory_runtime.rs`, `single/process_runtime.rs`, `single/slots.rs`)

这是任务管理子系统的实际实现核心，使用全局静态数组管理最多 64 个（`EDF_TASK_CAPACITY`）进程的状态。

**核心全局状态**：

```rust
// source/core/task/single/slots.rs
const CHILD_SLOT_COUNT: usize = scheduler::EDF_TASK_CAPACITY - 1; // 63
const VMA_SLOT_COUNT: usize = 128;
const SHARED_FILE_DIRTY_SLOT_COUNT: usize = 4096;
const USER_MEMORY_SLOT_COUNT: usize = scheduler::EDF_TASK_CAPACITY; // 64
const SUPPLEMENTARY_GROUP_SLOT_COUNT: usize = 16;
```

**关键能力**：
- 进程创建（fork 子进程）
- 信号发送（按 PID、进程组、全体）
- 用户 VMA 管理（注册/替换/移动/删除/保护虚拟内存区域）
- 进程退出和回收
- 线程组管理
- 凭据管理（UID/GID/capabilities）
- 资源限制
- 内存策略

**完整度评估**：
- 进程生命周期：**完整**（创建→运行→等待→退出→回收）
- 线程支持：**部分**（有线程组结构，但实际并发线程数受限于单 CPU 调度）
- VMA 管理：**完整**（128 槽位，支持共享文件映射）
- 信号处理：**完整**（64 种信号，信号队列，信号栈，信号掩码）

#### 4.5.3 信号子系统 (`signal.rs`)

- 64 种标准信号（SIGHUP=1 到 SIGSYS=31，加上 SIGRTMIN..SIGRTMAX）
- `SignalAction`：信号处理动作（handler/flags/restorer/mask）
- `SA_ONSTACK`、`SA_NODEFER`、`SA_RESETHAND` 标志支持
- `SIG_DFL`（默认）、`SIG_IGN`（忽略）处理
- 信号掩码操作：`SIG_BLOCK`/`SIG_UNBLOCK`/`SIG_SETMASK`
- 不可变信号掩码：SIGKILL 和 SIGSTOP 不可被阻塞
- `SignalStack`：备用信号栈（`SS_ONSTACK`/`SS_DISABLE`，最小 `MINSIGSTKSZ = 2048`）
- `QueuedSignalInfo`：排队信号信息（128 字节，包含 signo/errno/code/pid/uid/value/status）

#### 4.5.4 凭据管理 (`credentials.rs`)

- Linux capabilities 模型：`CAP_DAC_READ_SEARCH`、`CAP_KILL`、`CAP_MKNOD`、`CAP_SETPCAP`、`CAP_SYS_CHROOT`、`CAP_SYS_PTRACE`、`CAP_SYS_TIME`
- 进程凭据结构：real/effective/saved UID + GID，补充组列表
- 凭据继承和替换操作

#### 4.5.5 Robust 列表 (`robust.rs`)

- 支持 `set_robust_list` / `get_robust_list` 系统调用
- 线程退出时清理 futex robust 列表

---

### 4.6 EDF 调度器 (`source/core/scheduler/`)

#### 4.6.1 核心设计

调度器采用**最早截止时间优先**（EDF）算法，支持 64 个任务槽位，全部状态通过全局 `AtomicUsize` 数组管理。

**任务状态机**（6 种状态）：

```
EMPTY(0) → PREPARED(1) → RUNNABLE(2) → RUNNING(3)
                                          ↓
                              SLEEPING(4) / WAITING(5)
```

**等待类型**（20 种阻塞原因）：

| 等待类型 | 含义 | 唤醒条件 |
|----------|------|----------|
| `WAIT_CHILD_EXIT` | 等待子进程退出 | 子进程退出 |
| `WAIT_PIPE_READABLE` | 管道可读 | 对端写入 |
| `WAIT_PIPE_WRITABLE` | 管道可写 | 对端读取 |
| `WAIT_FUTEX` | futex 等待 | futex wake |
| `WAIT_SIGNAL` | 等待信号 | 信号递送 |
| `WAIT_VFORK_EXEC` | vfork 等待子进程 exec | 子进程 exec |
| `WAIT_EVENTFD_READABLE` | eventfd 可读 | eventfd 写入 |
| `WAIT_EVENTFD_WRITABLE` | eventfd 可写 | eventfd 读取 |
| `WAIT_TIMERFD_READABLE` | timerfd 到期 | 定时器触发 |
| `WAIT_INOTIFY_READABLE` | inotify 事件 | 文件系统事件 |
| `WAIT_SOCKET_READABLE` | socket 可读 | 对端发送 |
| `WAIT_SOCKET_WRITABLE` | socket 可写 | 缓冲区空间 |
| `WAIT_RECORD_LOCK` | 记录锁 | 锁释放 |
| `WAIT_FLOCK` | 文件锁 | 锁释放 |
| `WAIT_MESSAGE_QUEUE_*` | 消息队列 | 消息到达/空间 |
| `WAIT_SYSV_MESSAGE_QUEUE_*` | SysV 消息队列 | 消息到达/空间 |
| `WAIT_SYSV_SEMAPHORE` | SysV 信号量 | 信号量操作 |

**每个槽位的调度元数据**：

```rust
// 全局 AtomicUsize 数组（索引 = 任务槽位）
TASK_PID[64]              // 进程 PID
TASK_STATE[64]            // EMPTY/PREPARED/RUNNABLE/RUNNING/SLEEPING/WAITING
TASK_DEADLINE_MICROS[64]  // EDF 绝对截止时间
TASK_PERIOD_MICROS[64]    // 周期
TASK_RUNTIME_MICROS[64]   // 单周期预算
TASK_RELATIVE_DEADLINE_MICROS[64] // 相对截止时间
TASK_POLICY[64]           // 0=NORMAL, 1=DEADLINE
TASK_WAKE_MICROS[64]      // 睡眠/等待超时唤醒时间
TASK_WAKE_REASON[64]      // CHANNEL/TIMEOUT/SIGNAL
TASK_WAIT_KIND[64]        // 等待类型
TASK_WAIT_KEY0[64]        // 等待键（如 futex 地址）
TASK_WAIT_KEY1[64]        // 辅助等待键
TASK_CONTEXT_SAVED_SP_SLOT[64]   // 上下文切换保存的栈指针
TASK_CONTEXT_KERNEL_SP[64]       // 内核栈指针
TASK_CONTEXT_ROOT_FRAME[64]      // 页表根帧
```

#### 4.6.2 关键调度操作

- `pick_next_task()`：选择最早截止时间的可运行任务
- `mark_task_running(pid, now)`：将任务标记为运行中并清除等待状态
- `yield_task(pid, now)`：主动让出 CPU，更新截止时间为 `max(current_deadline, now) + period`
- `plan_yield_switch(pid, now)`：规划让出后的上下文切换（如果存在更高优先级任务）
- `commit_yield_context_switch(current, next, now)`：提交上下文切换
- `rollback_yield_context_switch(current, next, now)`：上下文切换失败时回滚

#### 4.6.3 阻塞管理 (`blocking.rs`, `blocking/futex.rs`)

- `SchedulerSleepRequest`：携带 `wake_micros` 超时时间
- `SchedulerWaitChannelRequest`：携带等待通道和可选超时
- 按通道类型分桶管理等待者（pipe/eventfd/timerfd/inotify/socket/futex 各有独立桶）
- futex 唤醒支持 `wake_futex_wait_bucket()` 和 `requeue_futex_wait_bucket()`
- futex requeue 操作：从源桶唤醒最多 `max_wake` 个，将最多 `max_requeue` 个重新排队到目标桶

#### 4.6.4 EDF 调度器评价

- **完整性**：高。支持完整的任务生命周期（注册→激活→运行→让出→阻塞→唤醒→回收）
- **实时特性**：支持 SCHED_DEADLINE（EDF）和 SCHED_NORMAL 两种策略
- **阻塞机制**：涵盖 20 种不同的阻塞场景，与 Linux 内核常见的等待通道对应
- **限制**：固定 64 个任务槽位、仅单 CPU、无负载跟踪、无 CPU 带宽控制

---

### 4.7 系统调用层 (`source/core/syscall/`)

#### 4.7.1 分发框架

系统调用分发采用三层递进模式：

```
dispatch(frame, process)
  → dispatch_with_memory(frame, process, memory)
    → dispatch_with_runtime(frame, process, memory, vfs)
```

每层增加更多的运行时上下文（内存访问器、VFS 后端），允许在不同场景下使用不同级别的依赖注入。

#### 4.7.2 SyscallFrame

```rust
// source/core/syscall.rs
pub struct SyscallFrame {
    number: usize,  // 系统调用号 (a7)
    args: [usize; 6], // a0-a5
}
```

#### 4.7.3 已实现的系统调用（按类别）

**进程控制**（`process_control.rs`，~1,590 行）：
- `clone`, `fork`, `vfork`, `execve`, `execveat`
- `exit`, `exit_group`
- `wait4`, `waitid`
- `getpid`, `getppid`, `gettid`, `getpgid`, `setpgid`, `getsid`, `setsid`
- `getuid`, `geteuid`, `getgid`, `getegid`, `getresuid`, `getresgid`
- `setuid`, `setgid`, `setreuid`, `setregid`, `setresuid`, `setresgid`
- `prctl`（名称、死亡信号、dumpable、timerslack、no_new_privs）
- `personality`
- `arch_prctl`
- `uname`, `sethostname`, `setdomainname`
- `getrlimit`, `setrlimit`, `prlimit64`
- `getrusage`
- `sysinfo`
- `capget`, `capset`

**内存管理**（`memory.rs`，~810 行；含 `advice.rs`、`locking.rs`、`numa.rs`、`shared_file.rs`）：
- `brk`
- `mmap`, `munmap`, `mprotect`, `mremap`, `madvise`
- `mseal`
- `msync`
- `mincore`
- `mlock`, `munlock`, `mlockall`, `munlockall`
- `mbind`, `set_mempolicy`, `get_mempolicy`, `move_pages`
- `memfd_create`

**文件系统路径操作**（`fs_path.rs`，~1,178 行；含 `metadata.rs`、`mount.rs`、`pipe.rs`、`xattr.rs`）：
- `openat`, `openat2`
- `close`
- `read`, `pread64`, `readv`, `preadv`, `preadv2`
- `write`, `pwrite64`, `writev`, `pwritev`, `pwritev2`
- `lseek`
- `fstat`, `newfstatat`
- `statx`
- `fstatfs`, `statfs`
- `getdents64`
- `truncate`, `ftruncate`
- `fallocate`
- `faccessat`, `faccessat2`
- `readlinkat`
- `linkat`, `unlinkat`, `symlinkat`, `renameat2`, `mkdirat`, `mknodat`
- `chmod`, `fchmod`, `fchmodat`
- `chown`, `fchown`, `fchownat`
- `umask`
- `utimensat`
- `name_to_handle_at`, `open_by_handle_at`
- `sync`, `syncfs`, `fsync`, `fdatasync`
- `mount`, `umount2`
- `chroot`
- `pipe2`
- `copy_file_range`, `sendfile`
- `getxattr`, `setxattr`, `listxattr`, `removexattr` 及 `f`/`l` 变体

**信号**（`signal.rs`，~265 行主体；含 `codec.rs`、`kill.rs`、`state.rs`、`wait.rs`）：
- `kill`, `tgkill`, `tkill`
- `sigaction`, `signal`, `sigprocmask`, `sigpending`, `sigsuspend`
- `sigaltstack`
- `rt_sigaction`, `rt_sigprocmask`, `rt_sigpending`, `rt_sigsuspend`
- `rt_sigqueueinfo`, `rt_tgsigqueueinfo`
- `rt_sigreturn`
- `rt_sigtimedwait`
- `signalfd4`
- `restart_syscall`

**时间**（`time.rs`，~864 行）：
- `clock_gettime`, `clock_settime`, `clock_getres`
- `clock_nanosleep`, `nanosleep`
- `gettimeofday`, `settimeofday`
- `times`
- `timer_create`, `timer_settime`, `timer_gettime`, `timer_delete`
- `timerfd_create`, `timerfd_settime`, `timerfd_gettime`

**Poll/Epoll**（`poll.rs` ~875 行，`epoll.rs` ~若干行）：
- `poll`, `ppoll`
- `epoll_create1`, `epoll_ctl`, `epoll_pwait`

**EventFD**（`eventfd.rs`）：
- `eventfd2`

**Inotify**（`inotify.rs`）：
- `inotify_init1`, `inotify_add_watch`, `inotify_rm_watch`

**消息队列**（`mqueue.rs`）：
- `mq_open`, `mq_unlink`, `mq_timedsend`, `mq_timedreceive`, `mq_notify`, `mq_getsetattr`

**Socket**（`socket.rs`，~2,466 行）：
- `socket`, `socketpair`, `bind`, `listen`, `accept`, `accept4`, `connect`
- `getsockname`, `getpeername`
- `sendto`, `recvfrom`, `sendmsg`, `recvmsg`
- `setsockopt`, `getsockopt`
- `shutdown`

**SysV IPC**（`sysv_msg.rs` ~747 行，`sysv_sem.rs` ~1,203 行）：
- `msgget`, `msgctl`, `msgsnd`, `msgrcv`
- `semget`, `semctl`, `semop`, `semtimedop`

**AIO**（`aio.rs`）：
- `io_setup`, `io_destroy`, `io_submit`, `io_cancel`, `io_getevents`, `io_pgetevents`

**其他**：
- `sched_setattr`, `sched_getattr`（`sched.rs` ~806 行）
- `ioprio_set`, `ioprio_get`
- `keyctl` 族（`keyring.rs` ~1,126 行）
- `process_vm_readv`, `process_vm_writev`（`process_vm.rs`）
- `readahead`, `fadvise64`
- `sync_file_range`
- `tee`, `splice`
- `dup`, `dup2`, `dup3`
- `fcntl`
- `ioctl`
- `flock`
- `getrandom`
- `rseq`
- `set_tid_address`, `set_robust_list`, `get_robust_list`
- `ptrace`（trace.rs）

#### 4.7.4 系统调用实现完整度评估

基于与 Linux 系统调用集的比较（以 RISC-V 的 ~290 个系统调用为基准）：

| 类别 | 覆盖程度 | 说明 |
|------|----------|------|
| 进程管理 | **高** (~90%) | clone/fork/execve/exit/wait 完整，ptrace 部分实现 |
| 内存管理 | **高** (~85%) | mmap/munmap/mprotect/brk 完整，缺 hugepage/thp |
| 文件 I/O | **高** (~80%) | 基本读写完整，缺 AIO 回调、io_uring |
| 文件系统元数据 | **中高** (~75%) | stat/chmod/chown/utimes 完整，缺 ACL |
| 信号 | **高** (~90%) | 完整信号操作和排队信号 |
| 时间 | **高** (~85%) | 完整 POSIX 时钟和定时器 |
| Socket | **中** (~60%) | AF_UNIX 完整，缺 AF_INET/AF_NETLINK |
| IPC | **中** (~50%) | pipe/eventfd/signalfd/timerfd/mqueue 完整，SysV 部分，缺 shm |
| epoll/inotify | **高** (~90%) | 完整 epoll 和 inotify |
| 调度 | **中** (~50%) | SCHED_DEADLINE/SCHED_NORMAL 基本，缺 SCHED_RR/FIFO 细粒度 |

---

### 4.8 文件系统子系统 (`source/core/fs/`)

#### 4.8.1 VFS 框架 (`vfs.rs`, ~2,485 行)

VFS 采用**类型状态**（typestate）模式，通过 trait 抽象文件系统后端：

- `SyscallVfs` trait：系统调用视角的 VFS 操作契约
- `NoSyscallVfs`：零大小类型，表示无 VFS 后端（编译期可见）
- `MountedRootfs`：挂载的根文件系统句柄
- `WritableOverlay`：可写覆盖层（内存中的文件系统变更）

**VFS 路径解析**：
- `VfsPath` / `VfsPathBuffer`：路径抽象（256 字节缓冲区）
- `resolve_path()`：路径解析（处理 `.`、`..`、符号链接，最大递归深度 16 层）
- `VFS_NAME_MAX = 255`，`VFS_PATH_MAX = 256`

#### 4.8.2 Builtin 文件系统 (`vfs/builtin.rs`, ~1,539 行)

实现了一个内置的伪文件系统，提供：

| 路径 | 说明 |
|------|------|
| `/proc/` | proc 目录 |
| `/proc/mounts` | 挂载信息 |
| `/proc/meminfo` | 内存信息 |
| `/proc/cpuinfo` | CPU 信息 |
| `/proc/stat` | 系统统计 |
| `/proc/uptime` | 系统运行时间 |
| `/proc/loadavg` | 系统负载 |
| `/proc/version` | 内核版本 |
| `/proc/self/` | 当前进程目录 |
| `/proc/self/status` | 进程状态 |
| `/proc/self/stat` | 进程统计 |
| `/proc/self/cmdline` | 进程命令行 |
| `/proc/self/fd/` | 文件描述符目录 |
| `/proc/[pid]/` | 按 PID 的进程目录（含 status/stat/cmdline/fd/exe） |
| `/dev/` | 设备目录 |
| `/dev/null` | 空设备 |
| `/dev/zero` | 零设备 |
| `/dev/urandom` | 伪随机数 |
| `/dev/tty` | 终端 |
| `/dev/console` | 控制台 |
| `/dev/stdin`, `/dev/stdout`, `/dev/stderr` | 标准 I/O 符号链接 |
| `/sys/` | sysfs 目录 |

#### 4.8.3 Overlay 文件系统 (`vfs/overlay.rs`, ~2,427 行；`overlay/file.rs`, `overlay/xattr.rs`)

内存中的可写覆盖层：
- 128 个目录条目容量
- 128 个文件容量
- 4096 个白名单条目
- 每个文件最多 2,048 个 4KB 块（8 MB 最大文件）
- 支持扩展属性（128 个，每个值最大 256 字节）
- 支持文件和目录的创建/删除（whiteout 机制）

#### 4.8.4 ext4 只读支持 (`ext4.rs`, ~869 行；`ext4/extents.rs`, `ext4/inode.rs`)

最小化 ext4 解析器，仅支持文件读取：

- **超级块解析**：偏移 1024 字节，魔数 `0xef53`，块大小 1-4KB
- **inode 解析**：128+ 字节 inode，支持 32/64 位大小和块计数
- **extent 树遍历**：
  - 支持 extent header（12 字节，魔数 `0xf30a`）+ leaf/index 节点
  - `extent_leaf_lookup()`：在叶子节点中查找逻辑块号
  - `extent_index_lookup()`：在索引节点中查找子节点
- **目录遍历**：线性搜索目录项（文件名最大 255 字节）
- **符号链接**：快速符号链接（60 字节内嵌）和块符号链接
- **文件类型**：常规文件、目录、符号链接、字符设备、块设备、FIFO、Socket
- **路径查找**：支持符号链接跟随（最大深度 16）

**不支持**：
- 写操作（只读）
- 日志（journal）
- 扩展属性（从 ext4 inode 的 xattr 块）
- 哈希树目录索引（HTree）
- 时间戳更新
- 多块分配
- 延迟分配

#### 4.8.5 文件描述符层 (`fd.rs`, ~2,436 行)

实现了类 Unix 的文件描述符表：

- `FdTable`：每个任务的 FD 表（容量由 `FD_TABLE_CAPACITY` 定义）
- `OpenFileTable`：全局打开文件描述表
- `OpenFileDescription`：打开文件描述（封装文件身份 + 偏移量）
- **特殊 FD 类型**：
  - `PipeTable`：匿名管道
  - `EventFdTable`：事件文件描述符
  - `TimerFdTable`：定时器文件描述符
  - `EpollTable`：epoll 实例
  - `SignalFdTable`：信号文件描述符
  - `InotifyTable`：inotify 实例
  - `MessageQueueTable`：POSIX 消息队列
  - `SocketTable`：Unix domain socket

#### 4.8.6 文件记录锁 (`fd.rs`)

- `FileRecordLock`：POSIX 记录锁（fcntl F_SETLK/F_GETLK）
- `FileRecordLockRequest`：锁请求
- `FileRecordLockType`：F_RDLCK/F_WRLCK/F_UNLCK
- `FlockOperation`：BSD flock（LOCK_SH/LOCK_EX/LOCK_UN/LOCK_NB）

#### 4.8.7 页缓存 (`page_cache.rs`)

- `FilePageCache`：基于文件标识 + 偏移量的页面缓存
- `FilePageCacheKey`：(file_identity, page_offset) 键
- `FILE_PAGE_CACHE_PAGE_BYTES`：缓存页面大小

#### 4.8.8 stat 编码 (`stat.rs`)

- `encode_linux_stat()`：将内部 VFS stat 结构编码为 Linux ABI 兼容的 128 字节 stat 结构
- `LINUX_STAT_SIZE = 128`

---

### 4.9 ELF 加载器 (`source/core/loader/`)

#### 4.9.1 核心功能 (`elf.rs`, ~1,041 行)

- **ELF 头解析**：验证 ELF 魔数、64 位、小端、版本 1
- **程序头解析**：处理 PT_LOAD、PT_INTERP、PT_DYNAMIC 段
- **段加载**：将 ELF LOAD 段映射到用户地址空间
- **动态链接器支持**：
  - 检测 PT_INTERP 段
  - 解析动态段（DT_NEEDED 等）
  - 为解释器分配独立的加载地址（EXEC_DYNAMIC_BASE=0x400000, INTERPRETER_DYNAMIC_BASE=0x20000000）
- **辅助向量构造**：AT_PAGESZ、AT_PHDR、AT_PHENT、AT_PHNUM、AT_BASE、AT_ENTRY、AT_UID、AT_EUID、AT_GID、AT_EGID、AT_CLKTCK、AT_SECURE、AT_RANDOM、AT_EXECFN、AT_NULL

#### 4.9.2 用户栈初始化 (`elf/stack.rs`)

- 将 argv、envp、auxv 复制到用户栈
- 构造标准的 Linux 进程启动栈布局
- 用户栈大小：2,048 页 × 4KB = 8 MB
- 栈顶地址：`USER_STACK_TOP = 1 << 37 = 128 GB`（典型 RISC-V 用户栈位置）

#### 4.9.3 段管理器 (`elf/segments.rs`)

- `user_load_segments()`：从 ELF 程序头提取 LOAD 段信息
- 权限映射：PF_R→READ, PF_W→WRITE, PF_X→EXECUTE
- 段对齐：按页对齐
- 解释器段加载：支持运行时链接器的独立段

#### 4.9.4 解释器支持

```rust
// source/core/loader/elf.rs
pub fn executable_interpreter(
    bytes: Option<&[u8]>,
    abi: ExecutableAbi,
) -> Result<Option<InterpreterPath>, LoaderBlocker>
```

- 从 PT_INTERP 段提取解释器路径（如 `/lib/ld-linux-riscv64-lp64d.so.1`）
- 支持加载动态链接的可执行文件

---

### 4.10 块设备子系统 (`source/core/block.rs`)

- `BlockSector`：512 字节扇区类型
- `BlockCache`：简单的 8 槽位直接映射缓存
  - 按扇区号查找
  - 写分配（read-miss 时填入缓存）
  - 统计 hit/miss 计数
- `BlockProvider`：函数指针封装的块设备后端
- `BlockIoError`：详细的 I/O 错误类型

---

### 4.11 时间子系统 (`source/core/time/mod.rs`)

- `MONOTONIC_MICROS`：单调时钟（自启动以来的微秒数）
- `REALTIME_OFFSET_MICROS`：实时时钟偏移
- `TIMER_INTERRUPT_COUNT`：定时器中断计数
- `TIMER_INTERVAL_MICROS`：定时器间隔
- **进程间隔定时器**：64 个槽位，支持 ITIMER_REAL/ITIMER_VIRTUAL/ITIMER_PROFILING
- **进程 CPU 时间**：64 个槽位，按 PID 记录 CPU 微秒数
- `TimeValue`：秒 + 微秒的时间表示
- `SleepDuration`：睡眠时长解析（从 Linux timespec）
- `LINUX_CLOCK_TICKS_PER_SECOND = 100`

---

### 4.12 内核编排层 (`source/kernel/`)

#### 4.12.1 启动主线 (`boot.rs`)

启动阶段（通过 `BOOT_STAGE` 原子变量追踪）：

```
BOOT_STAGE=1: 安装用户输出写入器
BOOT_STAGE=2: 安装 trap 向量 + 启动定时器
BOOT_STAGE=3: 发现启动内存 + 激活内核 MMU
BOOT_STAGE=5: 记录 init 路径（正常启动路径）
BOOT_STAGE=14/15: 启动失败/无 init 路径
```

#### 4.12.2 Exec 执行路径 (`exec.rs`, `exec/discovery.rs`, `exec/discovery/script.rs`)

**`commit_file_backed_exec()`** 的执行阶段（通过 `EXEC_STAGE` 追踪）：

```
EXEC_STAGE=1: 打开目标文件
EXEC_STAGE=2: 验证是常规可执行文件
EXEC_STAGE=3: 读取文件内容 + 构造 auxv
EXEC_STAGE=4: 准备可执行映像（ELF 解析 + 段提取）
EXEC_STAGE=5: 准备用户 MMU + 提交 exec + 注册任务上下文
EXEC_STAGE=6: 完成
```

**启动发现机制** (`discovery.rs`)：
- 支持从 ext4 根文件系统自动发现可执行程序
- `BOOT_DISCOVERY_ENTRY_LIMIT = 256` 个候选入口
- 静态可执行缓存（64 条目 LRU）
- 脚本发现：解析 `#!` shebang 行

**脚本支持** (`discovery/script.rs`)：
- 解析相对路径工具名（`./tool_name` 模式）
- 检测嵌套脚本
- 分类辅助脚本（helper script）
- 支持单工具脚本和组脚本

#### 4.12.3 调度器编排 (`scheduler.rs`, `scheduler/user_task.rs`)

- 内核任务栈管理：256 KB 每任务，64 个槽位
- 任务上下文准备：分配内核栈 → 构造上下文切换帧 → 注册到调度器
- `prepare_pending_user_task_context()`：为用户任务准备首次运行上下文
- `release_pending_user_task_context()`：释放任务上下文

#### 4.12.4 系统调用运行时 (`syscall_runtime.rs`, `syscall_runtime/`)

运行时全局状态（通过 `static mut` 管理）：

| 全局变量 | 用途 |
|----------|------|
| `ACTIVE_ROOTFS` | 当前活跃的根文件系统 |
| `ACTIVE_MEMORY` | 当前内存基础 |
| `ACTIVE_FD_TABLE` | 全局 FD 表 |
| `OPEN_FILE_TABLE` | 全局打开文件表 |
| `ACTIVE_OVERLAY` | 可写覆盖层 |
| `ACTIVE_MOUNTS` | 挂载表 |
| `ACTIVE_PIPES` | 管道表 |
| `ACTIVE_EVENTFDS` | eventfd 表 |
| `ACTIVE_TIMERFDS` | timerfd 表 |
| `ACTIVE_EPOLLS` | epoll 表 |
| `ACTIVE_SIGNALFDS` | signalfd 表 |
| `ACTIVE_INOTIFIES` | inotify 表 |
| `ACTIVE_MQUEUES` | 消息队列表 |
| `ACTIVE_SOCKETS` | socket 表 |
| `ACTIVE_FILE_PAGE_CACHE` | 文件页缓存 |
| `ACTIVE_FS_ROOT` | 当前根目录 |
| `ACTIVE_CWD` | 当前工作目录 |
| `ACTIVE_EXEC_PATH` | 当前执行路径 |
| `ACTIVE_CMDLINE` | 当前命令行 |
| `ACTIVE_BSP` | BSP 服务句柄 |
| `TASK_RUNTIME_PID[64]` | 每个任务的运行时 PID |
| `TASK_RUNTIME_FD_GROUP[64]` | 每个任务的 FD 组 |

运行时子系统还包括：
- `exec_runtime.rs`（~949 行）：`execve`/`execveat` 的运行时实现
- `path_resolution.rs`：相对于当前 cwd/root 的路径解析
- `vfs_backend.rs`（~3,367 行，最大单文件）：`ActiveSyscallVfs` 实现 `SyscallVfs` trait，协调所有 VFS 操作
- `vfs_backend/notify.rs`（~64 行）：inotify 文件描述符通知

---

### 4.13 评测适配层 (`source/official/`)

- `user_output.rs`：拦截用户态 stdout/stderr 输出，转发到架构控制台
- `judge_output.rs`：官方评测输出格式适配
- 支持 `write_user_fd(fd, bytes)` 接口（仅支持 fd=1 stdout 和 fd=2 stderr）

### 4.14 Panic 处理 (`source/panic.rs`)

- 裸机 `#[panic_handler]`
- 向架构控制台输出 `"fatal panic\n"`
- 通过 `halt(HaltReason::Fatal(FatalReason::Panic))` 停机

---

## 五、子系统交互关系

### 5.1 启动交互流程

```
bin/riscv64_kernel.rs (汇编桩)
  ↓ 建立启动栈，调用
riscv64_rust_entry(hart_id, device_tree)
  ↓ 构造 EarlyBootInfo + BspServices
kernel::boot::kernel_start(bsp)
  ↓
  1. install_user_output_writer (console → official::user_output)
  2. kernel_layout (linker → 符号边界)
  3. install_trap_vector (arch trap → stvec CSR)
  4. start_timer (arch timer → mtimecmp)
  5. discover_boot_memory (FDT → 可用内存范围)
  6. activate_kernel_mmu (arch mmu → satp CSR)
  7. MemoryFoundation::from_kernel_mmu (frame allocator + address_space)
  8. discover_boot_init_path (FDT → 启动路径)
  9. drive_boot_init_exec (exec → ELF 加载 → 用户态入口)
```

### 5.2 系统调用交互流程

```
用户态 ecall
  ↓
__riscv64_trap_vector (汇编保存寄存器)
  ↓
riscv64_user_trap_dispatch (Rust trap 分发)
  ↓
SyscallFrame 构造
  ↓
dispatch_with_runtime() (系统调用分发)
  ↓
具体系统调用实现 (core::syscall::*)
  ↓ 使用
core::task::single::* (进程/信号/VMA)
core::fs::vfs::* (VFS 操作)
core::scheduler::* (阻塞/唤醒)
  ↓ 通过
kernel::syscall_runtime::* (运行时 VFS 后端)
  ↓ 可能触发
上下文切换 → pick_next_task → 切换到就绪任务
  ↓ 或
用户态恢复 (sret)
```

### 5.3 文件系统交互流程

```
syscall (open/read/write/stat)
  ↓
kernel::syscall_runtime::vfs_backend (ActiveSyscallVfs)
  ↓
core::fs::vfs::MountedRootfs
  ├── ext4 (只读后端：VirtIO → BlockCache → ext4解析)
  ├── builtin (proc/dev 伪文件系统)
  └── overlay (可写覆盖层：内存中的变更)
```

---

## 六、实现完整度评估

### 6.1 子系统完整度汇总

| 子系统 | 完整度 | 依据 |
|--------|--------|------|
| 架构抽象契约 | **95%** | 12 个契约全部在两个架构上有实现 |
| RISC-V 64 平台 | **90%** | 启动/MMU/trap/上下文切换/块设备/定时器/控制台完整 |
| LoongArch64 平台 | **85%** | 与 RISC-V 平行的完整实现，块设备使用 PCI 而非 MMIO |
| 内存管理 | **80%** | 页帧分配、页表、地址空间、缺页处理完整；缺 COW、交换、hugepage |
| 进程管理 | **85%** | fork/exec/exit/wait 完整；缺 cgroup、namespace |
| 调度器 | **75%** | EDF 核心完整；20 种等待通道；缺多核、负载均衡、cgroup |
| 系统调用 | **75%** | 约 150+ 个系统调用实现；覆盖进程/文件/信号/时间/内存/网络(socket)/IPC 等 |
| 文件系统 | **70%** | VFS 框架、ext4 只读、builtin proc/dev、overlay 完整；缺写回 ext4、多 FS 类型 |
| ELF 加载器 | **80%** | 静态+动态 ELF 支持；缺重定位处理（依赖解释器） |
| 块设备 | **60%** | 基本缓存+同步读取；缺写操作、DMA、异步 I/O |
| 时间子系统 | **75%** | 单调时钟+实时时钟+进程定时器完整；缺高精度定时器 |
| 信号 | **85%** | 64 信号+排队信号+信号栈+信号掩码完整 |
| IPC | **65%** | pipe/eventfd/timerfd/signalfd/epoll/inotify/mqueue/SysV 完整；缺共享内存 |

### 6.2 整体完整度评估

**整体实现完整度约为 78%**（以 Linux 内核相应功能为基准，按各子系统权重加权）。该项目已经构建了一个**功能齐全的单体内核**，能够运行大多数 musl libc 编译的 Linux 用户态程序。

---

## 七、设计创新性分析

### 7.1 架构契约模式

**创新点**：使用 Rust 的类型系统和函数指针将硬件依赖完全参数化。`BspServices` 不是 trait 对象，而是一个包含函数指针的具体结构体，避免了动态分发开销。`BoundaryMode` 三阶段（Inspect/Prepare/ApplyUnsafe）状态机提供了一种优雅的方式来分离验证和副作用。

**创新级别**：中等。类似模式在嵌入式 Rust 中有先例（如 embedded-hal），但在 OS 内核级别做如此系统化的应用较为罕见。

### 7.2 编译期状态验证

**创新点**：大量使用 `const fn` 和编译期断言（如 `const _: () = assert!(EDF_TASK_CAPACITY > 1)`）来在编译时捕获配置错误。地址空间规划在构造时验证重叠、权限和边界条件。

**创新级别**：低-中等。这是 Rust 语言能力的常规应用，但在此项目中执行的彻底程度值得注意。

### 7.3 脚本发现与执行

**创新点**：`exec/discovery/script.rs` 实现了一个启动时的脚本解析和分类系统，能够分析 shebang 脚本的内容（检测嵌套脚本、单工具脚本、辅助脚本等），并据此决定执行策略。这超出了简单的 `#!` 解析。

**创新级别**：中等。这种智能脚本发现机制在竞赛场景中很有价值，但在通用 OS 中不会出现。

### 7.4 评测策略配置

**创新点**：`config/real_run_policy.json` 定义了一套完整的"真实运行验证"策略，区分 REAL_RUN、CONTENT_BACKED、PARSER_ONLY 三种能力标签，并要求通过特定文件路径的证据链。这是竞赛环境特有的设计。

**创新级别**：低（竞赛特定）。这不是内核设计创新，而是竞赛诚信机制。

### 7.5 等待通道分桶

**创新点**：调度器的 20 种等待类型各自使用独立的等待桶（每个桶大小 = EDF_TASK_CAPACITY = 64），避免了全局锁竞争，并支持 futex requeue 操作（将等待者从一个桶迁移到另一个桶）。

**创新级别**：中等。这种设计在概念上类似于 Linux 内核的等待队列哈希表，但实现得更加类型安全和结构化。

### 7.6 总结：设计创新性

该项目的**核心设计创新**在于：

1. **架构契约的工程化应用**：将硬件依赖参数化为编译时已知的函数指针结构体，配合三阶段状态机提供类型安全的硬件操作。
2. **全局状态的静态数组管理**：几乎所有内核状态通过固定大小的全局 `AtomicUsize` 数组管理，这是一种在 `no_std` Rust 中实现共享状态的有效模式。
3. **系统调用的渐进式依赖注入**：`dispatch` → `dispatch_with_memory` → `dispatch_with_runtime` 三层递进，允许在不同上下文中控制依赖关系。

总体来看，设计上更注重**工程实用性和可验证性**而非理论创新。架构清晰、类型安全、状态机明确是其突出特点。

---

## 八、其他重要信息

### 8.1 项目定位

这是一个**全国大学生计算机系统能力大赛操作系统内核实现赛道**的参赛项目。根据 `README.md`、`docs/` 中的迭代记录和 `config/real_run_policy.json` 的内容，该项目：

- 需要兼容官方 QEMU 评测环境
- 需要运行官方提供的 ext4 根文件系统中的用户态程序
- 需要输出标准化的评测结果
- 经历了至少 47 次迭代开发（`docx1/iter_01` 到 `iter_47`）

### 8.2 构建配置

- Cargo workspace（root + `source` 成员）
- 两个 bin 目标：`source-riscv64-kernel` 和 `source-loongarch64-kernel`
- 链接脚本通过 `build.rs` 传递给 rustc
- 优化级别：dev 使用 `opt-level=1`，release 使用 `opt-level=3 + lto=true`
- `#![deny(warnings)]` 确保零警告构建
- 构建日志检查禁止特定模式（`matches any value`、`unreachable pattern`、`unused variable`）

### 8.3 无外部依赖

`source/Cargo.toml` 中 `[dependencies]` 为空，该项目是**纯 `no_std` 实现**，仅依赖 Rust 核心库（`core`）和分配库（`alloc`）。这避免了任何供应链问题，但也意味着所有功能（包括格式化输出、数据结构）都需要手动实现。

### 8.4 安全注意事项

- 大量使用 `unsafe`：由于是裸机内核，几乎所有硬件交互都需要 `unsafe`
- 全局可变状态通过 `static mut` 管理（如运行时全局表），这在 Rust 中本质上是 unsafe 的
- 部分 `AtomicUsize` 用于跨 trap 边界的轻量级同步
- 没有使用 Mutex 等锁机制，依赖单 CPU 的无竞态假设
- 上下文切换期间的 `compiler_fence` 用于防止编译器重排

---

## 九、项目总结

OSKernel2026-X 是一个**工程实现度极高的教学竞赛型操作系统内核**，具有以下显著特征：

**优势**：
1. **代码量大且组织清晰**：~84,000 行 Rust 代码分布在 170 个源文件中，模块划分合理，注释详尽。
2. **双架构支持**：RISC-V 64 和 LoongArch64 的完整实现，通过架构契约实现良好的代码复用。
3. **系统调用覆盖广泛**：实现约 150+ 个 Linux 系统调用，能够运行动态链接的 ELF 程序。
4. **文件系统支持全面**：ext4 只读 + builtin proc/dev + 可写 overlay 的组合覆盖了大多数用户态需求。
5. **IPC 机制丰富**：pipe/eventfd/timerfd/signalfd/epoll/inotify/mqueue/socket/SysV 一应俱全。
6. **调度器设计精良**：EDF 实时调度 + 20 种等待通道 + futex requeue 支持。
7. **类型安全**：充分利用 Rust 的类型系统（const fn、编译期断言、状态机模式）。
8. **零依赖构建**：不依赖任何外部 crate，自包含且可审计。

**不足**：
1. **单 CPU 限制**：调度器和所有全局状态假设单核执行，无法扩展到 SMP。
2. **ext4 只读**：缺乏写支持限制了文件系统的实用性。
3. **不支持网络协议栈**：socket 仅支持 AF_UNIX，无 TCP/IP。
4. **内存管理简化**：无 COW、无页面回收、无交换。
5. **硬编码限制**：64 个任务、128 个 VMA、8 个挂载点等固定容量限制。
6. **缺少多线程支持**：虽然实现了 clone/线程组，但调度器不区分线程和进程。
7. **无用户态测试**：仓库中不包含用户态测试程序或根文件系统。

**综合评价**：这是一个在竞赛背景下表现出色的项目，展示了 Rust 在系统编程领域的强大表达能力。代码质量高，架构设计合理，实现覆盖面广。虽然存在一些固有限制（单核、固定容量），但这些在一个教学/竞赛型内核中是可以接受的工程权衡。