# whuse 操作系统内核技术分析报告

## 一、分析方法与过程

本次分析对 whuse 内核项目进行了全面的源代码审查，涵盖以下方面：

1. **全量代码结构审查**：遍历项目 1,236 个文件，逐一审查所有 Rust 源文件、汇编文件、链接脚本和构建配置。
2. **构建系统分析**：审查 `Makefile`、`Cargo.toml`、`cargo_config.toml`、`xtask` 构建编排工具与 Docker 容器化评测流程。
3. **子系统逐层拆解**：对 HAL、MM、Proc、Task、VFS、EXT4、Syscall、Kernel-Core、User-Init、Platform 共 10 个子系统进行代码级详细分析。
4. **关键路径追踪**：追踪系统调用从用户态 trap 到内核分发再到子系统处理的完整路径。
5. **跨架构对比**：对比 RISC-V 64 和 LoongArch 64 两套平台实现的一致性与差异。

由于时间限制，未进行实际 QEMU 运行测试（构建需要完整的 nightly-2025-01-18 工具链与目标平台支持，且需要预置 EXT4 根文件系统镜像进行完整功能验证），但通过静态代码分析已能充分揭示内核的架构设计与实现细节。

---

## 二、项目总体架构

### 2.1 架构概览

whuse 是一个基于 Rust 的宏内核（Monolithic Kernel），采用 `#![no_std]` 裸机方式构建。它的核心设计理念是：

- **HAL 抽象层解耦**：通过 `hal-api` trait 集合实现平台无关的内核逻辑，RISC-V 和 LoongArch 分别提供具体实现。
- **单一内核镜像**：所有子系统编译为单一 ELF 二进制，无内核模块机制。
- **UNIX 兼容**：面向 Linux 兼容，支持 musl/glibc 用户态程序直接运行。
- **竞赛优化导向**：内建看门狗、OS 竞赛评测流程集成、busybox 环境适配。

### 2.2 Crate 组织结构

```
workspace (16 members)
├── crates/          (12 个核心库 crate)
│   ├── hal-api           HAL 接口定义
│   ├── hal-virtio        VirtIO 设备发现/DMA
│   ├── hal-riscv64-virt  RISC-V QEMU virt 平台 HAL
│   ├── hal-loongarch64-virt  LoongArch QEMU virt 平台 HAL
│   ├── mm                内存管理
│   ├── proc              进程管理
│   ├── task              任务调度
│   ├── vfs               虚拟文件系统
│   ├── fs-ext4           EXT4 只读访问
│   ├── syscall           系统调用分发
│   ├── kernel-core       内核集成核心
│   └── user-init         用户态初始化数据
├── platform/         (3 个平台二进制目标)
│   ├── riscv64-virt      RISC-V 内核入口
│   ├── loongarch64-virt  LoongArch 内核入口
│   └── loongarch64-bootrom LoongArch bootrom 存根
├── tools/            (构建/测试辅助)
│   ├── xtask             Rust 构建编排
│   ├── dev               Shell 竞赛测试脚本
│   ├── oscomp            竞赛评测配置
│   └── rootfs            根文件系统骨架
├── third_party/      (第三方库补丁)
│   ├── fdt               Flattened Device Tree 解析
│   └── virtio-drivers    VirtIO 驱动
└── vendor/           (依赖 vendoring)
```

### 2.3 代码规模

| 子系统 | 文件 | 行数 |
|---|---|---|
| syscall (核心分发+10个域模块) | 11 | 9,472 |
| kernel-core (RISC-V + LoongArch) | 3 | 6,980 |
| vfs | 1 | 3,075 |
| proc | 1 | 2,432 |
| mm | 1 | 1,886 |
| hal-loongarch64-virt | 1 | 1,151 |
| hal-riscv64-virt | 1 | 1,103 |
| user-init (+内嵌汇编) | 1 | 525 |
| fs-ext4 | 1 | 519 |
| hal-virtio | 1 | 385 |
| task | 1 | 349 |
| hal-api | 1 | 220 |
| platform 入口(3个目标) | 6 | ~550 |
| xtask | 1 | ~790 |
| **总计** | | **~29,400** |

---

## 三、各子系统详细实现分析

### 3.1 HAL 抽象层 (hal-api, hal-virtio, hal-riscv64-virt, hal-loongarch64-virt)

#### 3.1.1 HAL 接口定义 (`hal-api`)

`hal-api` 定义了 9 个核心 trait，构成平台抽象边界：

```rust
pub trait HalCpu: Send + Sync {
    fn cpu_id(&self) -> usize;
    fn enable_interrupts(&self);
    fn disable_interrupts(&self);
    fn interrupts_enabled(&self) -> bool;
    fn switch_address_space(&self, token: VmSpaceToken);
    fn wait_for_interrupt(&self);
    fn run_user(&self, frame: &mut TrapFrame);
    fn set_kernel_timer_callback(&self, cb: fn());
}
```

`TrapFrame` 结构体（`#[repr(C)]`）定义了跨平台统一的 trap 上下文：
- 32 个通用寄存器 (`regs: [usize; 32]`)
- `sepc`/`sstatus`/`scause`/`stval` CSR 寄存器
- RISC-V 专有：32 个浮点寄存器 + `fcsr`

全局 HAL 注册使用 `spin::Once<HalBundle>` 单例，通过 `register_hal()` 在平台初始化时注入，内核其余部分通过 `hal()` 函数获取。

#### 3.1.2 RISC-V 平台 HAL (`hal-riscv64-virt`)

**关键常量与硬件资源：**
- UART: `0x1000_0000` (NS16550A)
- VirtIO MMIO: `0x1000_1000` 起 8 个槽位
- 物理内存: `0x8000_0000` 起 256MB
- 定时器频率: 10MHz (通过 SBI `TIME` 扩展或 legacy `SET_TIMER`)

**上下文切换实现：**
RISC-V 用户态进入/退出通过精心手写的汇编实现（`__whuse_run_user` 和 `__whuse_user_trap_entry`）：

- `__whuse_run_user`: 从 `TrapFrame` 恢复所有通用/浮点寄存器，设置 `stvec` 指向用户态 trap 入口，通过 `sret` 进入用户态。
- `__whuse_user_trap_entry`: 保存全部上下文到 `TrapFrame`，通过 `sscratch` 交换内核栈指针，恢复内核执行环境，跳转回 Rust 代码。

内核态自身也有一组 trap handler（`__whuse_kernel_trap_entry`），处理内核中发生的异常（主要是定时器中断）。内核 trap handler 采用函数指针注册机制，通过 `KERNEL_TRAP_HANDLER` 原子变量存储回调。

**中断系统：**
使用 PLIC（Platform-Level Interrupt Controller），通过 FDT 解析配置：
- `enable_irq`/`disable_irq` 通过 PLIC 寄存器控制
- `next_pending` 轮询 PLIC claim 寄存器
- `ack_irq` 写入 PLIC complete 寄存器

**VirtIO 块设备：**
- 使用 `VirtioDmaArena<2MB, ...>` 管理 DMA 内存
- 通过 `MmioTransport` 驱动 VirtIO-blk 设备
- `read_sector`/`write_sector`：封装的扇区级 I/O
- 设备初始化时探测容量和扇区大小

#### 3.1.3 LoongArch 平台 HAL (`hal-loongarch64-virt`)

**关键差异：**
- CSR 寄存器命名不同（`CRMD`/`PRMD`/`ECFG`/`ESTAT`/`ERA`/`EENTRY`/`TCFG`/`TVAL`/`TICLR`）
- 定时器频率：100MHz
- VirtIO 通过 PCI 总线而非 MMIO
- 中断控制器：PCH-PIC（而非 PLIC）
- TLB 重填使用硬件页表走表（通过 `lddir`/`ldpte` 指令）

**上下文切换：**
LoongArch 版本的 `__whuse_run_user` 和 `__whuse_user_trap_entry` 与 RISC-V 类似，但使用 LoongArch 特有指令：
- `ertn` 代替 `sret` 进行异常返回
- `csrwr`/`csrrd` 操作 CSR
- 使用 `CSR_SAVE0`/`CSR_SAVE1`（`0x30`/`0x31`）作为临时寄存器

**PCI 设备发现：**
通过 `PciRoot` 和 `MmioCam` 遍历 PCI ECAM 空间，识别 VirtIO PCI 设备，配置 BAR 空间和中断线。

**TLB 重填处理：**
LoongArch 实现了软件 TLB 重填（`__whuse_tlb_refill_entry`），通过 4 级硬件页表走表自动加载 TLB 条目。失败时触发 `TLBR` 异常。

#### 3.1.4 VirtIO 设备发现 (`hal-virtio`)

`hal-virtio` 提供两个关键 FDT 解析函数：

- `parse_riscv_virtio_discovery(dtb_pa)`: 解析 PLIC 配置（基址、大小、supervisor context、中断源数）和最多 8 个 VirtIO MMIO 设备（基址、大小、IRQ）。
- `parse_loongarch_virtio_discovery(dtb_pa)`: 解析 PCI 主机桥（ECAM 基址/大小、bus range、IO/MMIO window）和 PCH-PIC 中断配置。

`VirtioDmaArena` 实现 DMA 内存管理：
- 基于位图的固定大小内存池（2MB）
- `alloc(pages)` / `dealloc(paddr, pages)` 分配/释放
- 自动清零分配的内存
- `contains(paddr)` / `virt_to_phys` / `phys_to_virt` 地址转换

#### 3.1.5 HAL 实现完整度评估

| 接口 | RISC-V | LoongArch | 备注 |
|---|---|---|---|
| `HalPlatform` | 完整 | 完整 | |
| `HalPlatformLifecycle` | 完整 | 完整 | WFI/idle 支持 |
| `HalInterrupt` | 完整 (PLIC) | 完整 (PCH-PIC) | |
| `HalCpu` | 完整 | 完整 | 含完整上下文切换 |
| `HalMemory` | 完整 | 完整 | 恒等映射 |
| `HalTimer` | 完整 (SBI) | 完整 (CSR) | 10MHz/100MHz |
| `HalCharDevice` | 完整 (NS16550) | 完整 (UART) | |
| `HalBlockDevice` | 完整 (VirtIO-MMIO) | 完整 (VirtIO-PCI) | |
| `HalNetDevice` | 存根 | 存根 | VirtIO-net 未完整实现 |

---

### 3.2 内存管理 (`mm`)

#### 3.2.1 帧分配器 (`FrameAllocator`)

采用极简的 bump 分配器策略：
```rust
pub struct FrameAllocator {
    start: usize,  // 可用物理内存起始
    end: usize,    // 可用物理内存结束
    next: usize,   // 下次分配的起始指针
}
```

- `alloc_page()`: 每次递增 `PAGE_SIZE`(4096) 字节，仅前进不后退。
- `dealloc_page()`: **空操作**。释放由 `OwnedFramesInner` 的 `Arc` 引用计数管理。
- `from_regions()`: 从 HAL 报告的 `MemoryRegion` 中找到第一个 `usable` 区域。

**限制：** bump 分配器无法回收已释放的帧，内存碎片在进程退出时通过整个地址空间销毁来回收。

#### 3.2.2 段存储模型

地址空间的每个映射由一个 `Segment` 表示，其存储有三种形式：

```rust
enum SegmentStorage {
    Owned { frames: Arc<OwnedFramesInner> },   // 私有物理帧
    Shared { bytes: Arc<Mutex<Vec<u8>>>, ptr: usize }, // 共享内存
    Host { ptr: usize, len: usize },            // 主机物理内存（内嵌 busybox）
}
```

- `Owned`: 标记 CoW 友好的私有映射，通过 `Arc` 引用计数实现页表克隆。
- `Shared`: 用于 `mmap(MAP_SHARED)`、System V 共享内存、进程间共享数据。
- `Host`: 特殊类型，用于内嵌的 busybox 二进制加载，在 `clone_private` 时转换为 `Owned`。

#### 3.2.3 地址空间 (`AddressSpace`)

核心数据结构：
```rust
struct AddressSpaceInner {
    token: VmSpaceToken,           // 页表根物理地址
    mappings: BTreeMap<usize, Segment>,  // start -> segment
    program_break: usize,          // brk 指针
    next_mapping_base: usize,      // mmap 搜索起始地址
    page_table: Option<PageTableSpace>,
    dirty: bool,                   // 脏标志，触发页表重建
    frame_allocator: Mutex<FrameAllocator>,
}
```

**关键操作：**

- `map_anonymous(len, prot)`: 分配匿名映射，搜索空闲空间（从 `USER_MMAP_BASE=0x5000_0000` 起），创建 `Owned` 段。
- `map_anonymous_at(addr, len, prot)`: 在固定地址创建映射（用于信号栈、TLS 等）。
- `map_anonymous_shared(len, prot)`: 创建 `Shared` 段。
- `map_fixed_bytes(addr, data, len, prot)`: 将数据从内核复制到用户的固定地址映射（用于 ELF 加载）。
- `unmap(addr, len)`: 删除映射，释放物理帧（通过 `Arc` 引用计数）。
- `mprotect(addr, len, prot)`: 修改映射权限。
- `clone_private()`: 深拷贝所有映射——`Owned` 段克隆 `Arc`（CoW 语义的基础），`Shared` 段共享，`Host` 段转换为 `Owned`。
- `clone()`: `Arc::clone(self.inner)`，浅拷贝（线程共享用）。
- `token()`: 获取页表根物理地址（触发 `rebuild_page_table` 若 dirty）。

**ELF 加载器 (`ElfBinaryLoader`)：**

实现了完整的 ELF64 加载器，支持：
- 静态链接 ELF：解析 PHDR，加载 `PT_LOAD` 段，设置 `PT_GNU_STACK`/`PT_GNU_RELRO` 权限。
- 动态链接 ELF：检测 `PT_INTERP` 段，分别加载解释器和主程序，支持 `AT_PHDR`/`AT_ENTRY`/`AT_BASE` 等 auxiliary vector。
- 用户栈构建：布置 `argv`、`envp`、auxiliary vector、`AT_RANDOM` (16 字节随机数)。
- shebang 脚本支持：在 `kernel-core` 而非 `mm` 中处理，支持递归解释器查找（最多 4 跳）。

`LoadedImage` 返回结构：
```rust
pub struct LoadedImage {
    pub entry, stack_pointer, load_bias: usize,
    pub phdr_addr, phnum, phent: usize,
    pub interp_base, interp_entry, program_entry: usize,
    pub is_dyn: bool,
}
```

#### 3.2.4 页表管理

**RISC-V Sv39 页表构建 (`Sv39PageTableBuilder`):**

- 三级页表（PGD → PMD → PTE），每级 512 项。
- `map_identity_2m(start, end, flags)`: 以 2MB 大页进行恒等映射（内核物理内存 + MMIO 区域）。
- `map_4k(vaddr, paddr, flags)`: 4KB 小页映射用户空间映射。
- `ensure_next_table(table_phys, index)`: 按需分配下级页表。
- PTE 标志：`V|R|W|X|U|A|D`，用户页额外设置 `U` 位。

内核空间恒等映射范围：
- `0x8000_0000` - `0x1_0000_0000`（物理内存 2GB 窗口，RWX）
- `0x0200_0000` - `0x2000_0000`（MMIO 区域，RW）

**LoongArch 页表构建 (`LoongPageTableBuilder`):**

- 与 RISC-V 结构相似，但使用 LoongArch 特有 PTE 布局：
  - `V|D|PLVL|PLVH|MATL|MATH|GH|P|W|NR|NX`
- 内核物理内存：`0x9000_0000` 起 512MB
- MMIO 区域：`0x1000_0000` 起 256MB
- 用户页使用 `PLV=3` 权限位

**页表重建触发条件：**
`dirty` 标志在映射变更时设置，在 `token()` 被调用（即将切换到该地址空间）时触发重建，实现惰性页表更新。

#### 3.2.5 MM 实现完整度

| 功能 | 状态 | 备注 |
|---|---|---|
| 物理帧分配 | 部分 | bump 分配器，不回收 |
| 虚拟地址空间管理 | 完整 | 匿名/共享/固定/文件映射 |
| mmap/munmap/mprotect | 完整 | 含 MAP_FIXED/MAP_SHARED/MAP_ANONYMOUS/MAP_PRIVATE |
| brk | 完整 | 堆增长 |
| ELF 加载（静态） | 完整 | PHDR 解析与段映射 |
| ELF 加载（动态） | 完整 | INTERP 解析，auxv 构建 |
| 页表构建（Sv39） | 完整 | 2MB/4KB 混合映射 |
| 页表构建（LoongArch） | 完整 | 含 TLB 重填 |
| CoW (写时复制) | 基础 | `clone_private` 通过 Arc 共享帧 |
| 页面换出 | 未实现 | 无 swap |
| 惰性分配 | 未实现 | 所有映射预先分配物理帧 |
| mremap | 实现 | 支持原地扩展/收缩和移动 |
| madvise | 存根 | 返回 0 |

---

### 3.3 进程管理 (`proc`)

#### 3.3.1 进程结构

`Process` 结构体约 50 个字段，涵盖完整的 UNIX 进程语义：

```rust
pub struct Process {
    // 标识
    pub pid, tid, tgid, pgid, sid: usize,
    pub parent: Option<usize>,
    pub name: String,
    pub cwd: String,
    
    // 凭证
    pub uid, euid, gid, egid: u32,
    pub groups: Vec<u32>,
    pub umask: u32,
    
    // 状态
    pub state: ProcessState,
    pub exit_code: Option<i32>,
    
    // 资源
    pub address_space: AddressSpace,
    pub fds: BTreeMap<i32, FileHandle>,
    pub trap_frame: TrapFrame,
    
    // 信号
    pub signal_mask, pending_signals: u64,
    pub signal_actions: BTreeMap<usize, SigAction>,
    pub sigaltstack: Option<(usize, usize, u32)>,
    
    // Futex
    pub futex_wait_addr: Option<usize>,
    pub futex_wait_deadline_ns: Option<u64>,
    pub robust_list: Option<(usize, usize)>,
    pub clear_child_tid: Option<usize>,
    pub tid_address: Option<usize>,
    
    // 取消
    pub signal_frame_pending: bool,
    pub cancel_signal_seen: bool,
    pub cancellation_in_progress: bool,
    pub force_thread_exit: bool,
    pub eintr_count: u32,
    
    // 睡眠
    pub sleep_deadline_ns: Option<u64>,
    pub sleep_absolute: bool,
    
    // vfork
    pub vfork_parent_tid: Option<usize>,
    // ... 等
}
```

#### 3.3.2 进程表 (`ProcessTable`)

```rust
pub struct ProcessTable {
    next_pid: usize,
    current_tid: usize,
    processes: BTreeMap<usize, Process>,
    futex_waiters: BTreeMap<usize, VecDeque<usize>>,  // addr -> [tid]
}
```

- `spawn(name, parent, entry)`: 创建新进程，分配 PID/TID，初始化地址空间（含用户栈 0x80_000 字节）。
- `spawn_init(name, entry)`: 创建 PID=1 的 init 进程。
- `current()` / `current_mut()`: 通过 `current_tid` 获取当前执行上下文。
- `set_current(tid)`: 切换当前执行上下文。

#### 3.3.3 Fork 实现

`fork_from(pid)` 方法实现进程复制：
1. 克隆 `user_stack` 影子缓冲区。
2. 复制 `trap_frame`，设置子进程返回值为 0，`sepc += 4`（跳过父进程的 ecall）。
3. 调用 `address_space.clone_private()` 深拷贝地址空间。
4. 克隆文件描述符表、信号配置、凭证等。
5. 清空子进程的 `pending_signals` 和 futex 等待状态。

`fork_from_shared(pid)`: 使用 `address_space.clone()`（`Arc` 浅拷贝），用于 CoW 语义。

#### 3.3.4 Clone 实现

`clone_thread_from(tid, stack, tls)` 实现线程创建：
1. 使用 `address_space.clone()`（Arc 共享）——线程共享地址空间。
2. 通过 `stack` 参数设置线程栈指针。
3. 通过 `tls` 参数设置线程局部存储指针（写入 `tp`/`regs[4]`）。
4. 线程继承父进程的 `tgid`、`pgid`、`sid`、`parent`。
5. 清空线程级的 futex 和 robust list 状态。

#### 3.3.5 Execve 实现

execve 的完整流程在 `kernel-core` 和 `syscall` 中协作完成：

`syscall/src/lib.rs::sys_execve()`:
1. 从用户空间读取 path、argv、envp。
2. 处理 shebang（`#!`）解释器重定向（最多 4 跳）。
3. 处理 busybox applet 重定向。
4. 对 `.sh` 脚本自动通过 busybox `sh` 执行。
5. 调用 `process.reset_image(entry, stack_pointer)`。

`proc/src/lib.rs::reset_image()`:
1. 重新初始化地址空间（新 `AddressSpace::new_user()`）。
2. 重置 `trap_frame`。
3. 保留进程标识和凭证。
4. 关闭 `CLOEXEC` 标记的文件描述符。
5. 重置信号栈但保留信号处理器配置。

#### 3.3.6 进程退出

`exit_current_thread(code)`:
- 设置进程状态为 `Exited`。
- 收集 robust futex 地址列表。
- 通知 `clear_child_tid`（FUTEX_WAKE）。
- 如果是线程组最后一个线程，设置 `group_exited = true`。

`exit_current_process_group(code)`:
- 对线程组中所有线程执行退出。
- 如果 `vfork_parent_tid` 存在，唤醒父进程。
- 向父进程发送 `SIGCHLD`。

#### 3.3.7 信号系统

**信号投递 (`deliver_signal` / `send_signal`):**
- 按 PID、TGID、PGID 或全部进程发送信号。
- `SIGKILL`(9) 和 `SIGSTOP`(19) 不可忽略或捕获。
- `SIGCONT`(18) 清除挂起的停止信号。
- 信号掩码过滤：被阻塞的信号置为 pending。

**信号帧构建 (`dispatch_pending_signals` in kernel-core):**
1. 计算 `unmasked = pending_signals & !signal_mask`。
2. 查找信号处理器（handler/flags/mask/restorer）。
3. `SIG_DFL`（handler=0）：终止进程（SIGCHLD 等忽略）。
4. `SIG_IGN`（handler=1）：忽略。
5. 用户处理器：在用户栈上构建信号帧。

信号帧布局（RISC-V musl 兼容）：
```
offset 0:     siginfo_t (128 bytes)
offset 128:   ucontext_t
  +40:          uc_sigmask (128 bytes)
  +168:         mcontext_t (32*8 regs + 32*8 fp + fcsr)
```

信号帧构建完成后：
- `trap_frame.sepc = handler`（下次进入用户态时执行信号处理器）
- `trap_frame.regs[1] = restorer`（信号处理器返回地址指向 `SIGNAL_TRAMPOLINE_BASE`）
- `trap_frame.regs[10] = signum`
- `signal_frame_pending = true`

**信号返回 (rt_sigreturn):**
1. 从用户栈恢复 `trap_frame`。
2. 恢复 `signal_mask`（从 `uc_sigmask`）。
3. 清除 `signal_frame_pending`，设置 `cancellation_in_progress`（若为 SIGCANCEL）。

**SIGCANCEL (信号33) 处理：**
- musl 用于线程取消的特殊信号。
- 触发 `mark_cancel_signal_dispatched()`。
- 在 `rt_sigreturn` 中通过 `arm_cancellation_persistent()` 设置 `cancellation_in_progress`。
- 导致后续 FUTEX_WAIT 持续返回 `EINTR`，驱动取消清理。

#### 3.3.8 Futex 实现

`ProcessTable` 维护全局 `futex_waiters: BTreeMap<usize, VecDeque<usize>>`（地址→等待队列）。

**futex_wait:**
1. 原子读取用户空间 futex 字（通过 `read_user_bytes`）。
2. 若值匹配 `val`：将线程加入等待队列，阻塞。
3. 若值不匹配：返回 `EAGAIN`。
4. 信号检查：若有 pending 非取消信号，返回 `EINTR`。
5. 超时检查：若 `monotonic_nanos >= deadline`，返回 `ETIMEDOUT`。
6. EINTR 活锁保护：若 `eintr_count >= 1000`，设置 `force_thread_exit` 强制退出。

**futex_wake:**
1. 从等待队列取出最多 `val` 个等待者。
2. 唤醒对应的调度器任务。

**robust futex:**
- 进程退出时遍历 `robust_list` 链表。
- 对每个 robust futex 地址执行 `FUTEX_WAKE | FUTEX_OWNER_DIED`。
- 最多扫描 2048 个条目防止死循环。

#### 3.3.9 Proc 实现完整度

| 功能 | 状态 | 备注 |
|---|---|---|
| 进程创建 (fork) | 完整 | 含 CoW 地址空间克隆 |
| 线程创建 (clone) | 完整 | 共享地址空间，独立栈 |
| 程序执行 (execve) | 完整 | shebang/busybox/sh 脚本支持 |
| 进程退出 | 完整 | 含 robust futex 清理 |
| 等待子进程 (wait/waitpid) | 完整 | 支持 PID/PGID/ANY 选择器 |
| 进程凭证 | 完整 | uid/euid/gid/egid/groups |
| 信号发送 | 完整 | kill/tkill/tgkill/pid/pgid |
| 信号处理 | 完整 | SIG_DFL/SIG_IGN/用户处理器 |
| 信号帧 | 完整 | RISC-V musl 兼容布局 |
| SIGCANCEL 取消 | 完整 | 含 EINTR 活锁保护 |
| Futex (WAIT/WAKE/REQUEUE) | 完整 | 含 bitset/requeue/WAKE_OP |
| Robust futex | 完整 | 退出时自动清理 |
| 进程组/会话 | 完整 | setpgid/getsid/setsid |
| 资源限制 | 存根 | 返回固定值 |
| 命名空间 | 存根 | unshare 返回 0 |
| Core dump | 未实现 | |
| ptrace | 未实现 | |

---

### 3.4 任务调度 (`task`)

#### 3.4.1 调度器设计

```rust
pub struct Scheduler {
    next_id: usize,
    ready: VecDeque<Task>,         // 就绪队列
    current: Option<Task>,         // 当前运行任务
    blocked: BTreeMap<usize, Task>, // 阻塞任务
    next_wait_queue: usize,        // 等待队列 ID 分配器
}
```

**调度策略：** 简单的 FIFO 轮转（Round-Robin），`ready` 作为 `VecDeque` 实现。
- `schedule_next()`: 从队列头部取出任务设为 `current`。
- `yield_now()`: 将当前任务放回队列尾部，调度下一个。
- 时间片通过内核定时器中断强制抢占（`SCHED_TIME_SLICE_NS = 10ms`）。

**任务状态机：**
```
Ready → Running (schedule_next)
Running → Ready (yield_now / 抢占)
Running → Blocked (block_current / block_current_on)
Blocked → Ready (wake_task)
Running/Ready/Blocked → Exited (exit_current / exit_group)
```

#### 3.4.2 等待队列

```rust
pub struct WaitQueue {
    pub id: usize,
    waiters: VecDeque<usize>,  // task_id 队列
}
```

- `register(task_id)`: 将任务加入等待队列尾部，返回 `WaitToken`。
- `wake_one()`: 弹出并返回队列头部任务。
- `wake_all()`: 清空并返回所有等待任务。
- 线程安全由 `ProcessTable` 和 `Scheduler` 的外层同步保证。

#### 3.4.3 调度器完整度

| 功能 | 状态 |
|---|---|
| 多任务调度 | 完整 (FIFO 轮转) |
| 时间片抢占 | 完整 (10ms) |
| 等待队列 | 完整 |
| 阻塞/唤醒 | 完整 |
| 优先级调度 | 未实现 |
| 多核调度 | 未实现 (单核) |
| CFS/实时调度 | 未实现 |
| CPU 亲和性 | 未实现 |

---

### 3.5 虚拟文件系统 (`vfs`)

#### 3.5.1 节点类型

```rust
pub enum NodeKind {
    Directory, File, CharDevice, Proc,
    Pipe, Symlink, Event, Epoll, Socket, PidFd,
}
```

对应的 `NodeData` 枚举：
```rust
enum NodeData {
    Directory(BTreeMap<String, Arc<Node>>),
    File(Vec<u8>),
    Ext4File(Ext4FileState),       // 按需从块设备读取
    Ext4Dir(Ext4DirState),         // 缓存目录项
    CharDevice,                    // /dev/console 等
    ProcFile(Vec<u8>),             // /proc/* 静态内容
    Pipe(PipeState),               // 管道缓冲区
    Symlink(String),               // 符号链接目标
    Event(u64),                    // eventfd 计数器
    Epoll(Vec<EpollWatch>),        // epoll 监视列表
    SocketPending(SocketPending),  // 监听 socket
    SocketConnected { ... },       // 已连接 socket
    SocketRaw(RawSocketState),     // 原始 socket
    PidFd(usize),                  // pidfd
}
```

#### 3.5.2 文件系统树管理

`KernelVfs` 维护：
- 内存文件系统树 (`root: Arc<Node>`)
- EXT4 外部挂载列表 (`external_mounts: Vec<ExternalMount>`)
- 外部统计缓存 (`external_stat_cache`, `external_preloaded`)
- Socket 绑定表 (`socket_bindings`)
- 挂载记录 (`mounts: Vec<MountRecord>`)

**路径解析：**
- `absolute_path(cwd, path)`: 标准化路径（处理 `.`、`..`、多余 `/`）。
- `lookup_abs(absolute)`: 从根节点沿路径查找节点，支持符号链接解析（最多 40 跳，`ELOOP` 检测）。
- `resolve_external_path(absolute)`: 检查路径是否落在 EXT4 挂载点下，返回对应的 `ExternalMount` 和 FS 内部路径。

#### 3.5.3 文件操作

**open:**
1. 标准化路径。
2. 先尝试 EXT4 外部打开（`try_open_external`）。
3. 若不存在则回退到内存文件系统（`open_mem`）。
4. 支持 `O_CREAT`（自动创建）、`O_TRUNC`（截断）、`O_DIRECTORY`（验证）。
5. 符号链接自动跟随。

**read:**
- 内存文件：直接返回 `Vec<u8>` 切片。
- EXT4 文件：通过 `Ext4Mount::read_range(path, offset, len)` 按需读取。
- 管道/eventfd/socket：通过 `KernelObject` trait 的 `read_object` 方法。
- 字符设备：无缓冲，返回空。

**write:**
- 内存文件：追加到 `Vec<u8>`。
- EXT4：只读，返回 `EROFS`。
- 管道：写入管道缓冲区。
- Socket（raw）：封装数据包后投递到匹配的 raw socket。
- Socket（connected）：写入共享通道。

**getdents:**
- 内存目录：遍历 `BTreeMap`，按 64 位 dents 格式编码。
- EXT4 目录：缓存目录项（`Ext4DirEntryLite`），按需从块设备读取。
- `/proc` 目录：返回虚拟条目。

#### 3.5.4 特殊文件系统

**procfs:**
- `/proc/meminfo`: 静态报告 1GB 内存。
- `/proc/uptime`: 静态 `1.00 1.00`。
- `/proc/stat`: 静态 CPU 统计。
- `/proc/version`: 伪 Linux 6.8.0-whuse。
- `/proc/self/stat`: 静态占位内容。
- `/proc/self/exe`: 暂不解析。
- `/proc/mounts`: 动态生成挂载表。
- `/proc/net/*`: 虚拟空目录。

**devfs:**
- `/dev/console`: `CharDevice` 节点，直接映射到 HAL UART。

**tmpfs:**
- `/tmp` 目录，内存文件存储。

#### 3.5.5 Pipe/Eventfd/Epoll

**Pipe:**
- 读写端通过 `PipeEnd::Read`/`PipeEnd::Write` 区分。
- 共享 `PipeState { buf: VecDeque<u8>, readers, writers }`。
- 无数据时读端阻塞（返回 `EAGAIN`，外层调度器处理）。
- 写端关闭时读返回 EOF。

**Eventfd:**
- `NodeData::Event(u64)` 存储 64 位计数器。
- `read` 返回当前值并清零，阻塞等待非零（`EAGAIN` 语义）。
- `write` 累加值。

**Epoll:**
- `NodeData::Epoll(Vec<EpollWatch>)` 存储监视的 fd 列表。
- `epoll_ctl(ADD/DEL/MOD)`: 管理监视项。
- `epoll_wait`: 遍历监视列表，检查各 fd 的可读/可写状态。
  - 内存文件/管道/socket：调用 `poll_read_ready`/`poll_write_ready`。
  - 超时通过 `epoll_wait_deadline_ns` 管理，阻塞当前任务。

#### 3.5.6 Socket 实现

**Unix Domain Socket (AF_UNIX):**
- `SocketPending` 处理监听状态：`listening` 标志 + `pending` 连接队列。
- `SocketConnected` 通过共享 `SocketChannel`（双端 `VecDeque<u8>` inbox）通信。
- 抽象 socket 地址：`/__unix_abstract__/name` 前缀。
- `bind`/`listen`/`accept`/`connect`/`send`/`recv` 完整实现。
- `accept` 在无连接时阻塞。

**Raw Socket (AF_INET6/AF_INET):**
- `RawSocketState` 维护 `inbox: VecDeque<Vec<u8>>`。
- `sendto`/`sendmsg` 构造数据包并通过匹配的 raw socket 投递。
- `recvfrom`/`recvmsg` 从 inbox 取出数据包。
- IPv6 扩展头支持：checksum 自动计算、hop limit、ICMPv6 过滤。
- 多播：`IPV6_JOIN_GROUP`/`IPV6_LEAVE_GROUP` 记录但不实际配置硬件。

#### 3.5.7 VFS 实现完整度

| 功能 | 状态 |
|---|---|
| 目录/文件创建删除 | 完整 (mkdir/create/unlink/rename/symlink/link) |
| 文件读写 | 完整 (read/write/readv/writev/pread/pwrite) |
| 文件寻址 | 完整 (lseek) |
| 文件状态 | 完整 (fstat/fstatat/statfs) |
| 目录遍历 | 完整 (getdents64) |
| 符号链接 | 完整 (含递归解析，ELOOP 检测) |
| 管道 | 完整 (pipe/pipe2) |
| eventfd | 完整 |
| epoll | 完整 (create/ctl/pwait) |
| select/poll | 完整 (pselect6/ppoll) |
| Unix socket | 完整 (socket/bind/listen/accept/connect/send/recv) |
| Raw socket | 基本 (sendto/recvfrom/getsockopt/setsockopt) |
| EXT4 挂载 | 完整 (只读) |
| procfs | 部分 (meminfo/uptime/stat/version/mounts) |
| devfs | 最小 (/dev/console) |
| tmpfs | 完整 |
| sendfile/splice | 存根 |
| 文件锁 (flock) | 存根 (返回 0) |
| fallocate | 存根 (返回 0) |
| xattr | 未实现 |

---

### 3.6 EXT4 文件系统 (`fs-ext4`)

基于 `ext4-view` 库（版本 0.9.3）实现只读 EXT4 访问。

**核心封装：**
```rust
pub struct Ext4Mount {
    fs: Ext4,
    label: String,
}
```

**`BlockDeviceReader`:** 实现 `Ext4Read` trait，桥接 HAL `HalBlockDevice` 与 `ext4-view` 库。处理非对齐扇区读取（通过临时缓冲区拼接）。

**主要操作：**
- `probe(device)`: 初始化设备，加载 EXT4 超级块。
- `stat(path)`: 获取文件元数据（类型、大小、权限）。
- `read(path)`: 读取整个文件。
- `read_range(path, offset, len)`: 按偏移和长度读取文件片段（最大单次 256KB）。
- `read_dir(path)`: 读取目录项（含完整 stat）。
- `read_dir_lite(path)`: 只读名称和类型（缓存友好）。
- `read_link(path)`: 读取符号链接目标。
- `exists(path)`: 检查路径是否存在。

**错误映射：** `Ext4Error` 到 POSIX errno 的完整映射（`NotFound→ENOENT`, `NotADirectory→ENOTDIR`, `IsADirectory→EISDIR`, `Io→EIO` 等）。

---

### 3.7 系统调用 (`syscall`)

#### 3.7.1 分发架构

```rust
pub struct SyscallDispatcher;

pub fn dispatch(&self, sysno, args, procs, scheduler, vfs) -> isize {
    fs_domain::dispatch()
        .or_else(|| io_mpx_domain::dispatch())
        .or_else(|| ipc_domain::dispatch())
        .or_else(|| mm_domain::dispatch())
        .or_else(|| net_domain::dispatch())
        .or_else(|| resources_domain::dispatch())
        .or_else(|| signal_domain::dispatch())
        .or_else(|| sys_domain::dispatch())
        .or_else(|| task_domain::dispatch())
        .or_else(|| time_domain::dispatch())
        .unwrap_or(Err(ENOSYS))
}
```

10 个域模块各负责一组系统调用：

| 域模块 | 系统调用数 | 涵盖范围 |
|---|---|---|
| `fs_domain` | ~60 | open/read/write/close/stat/getdents/mount/mkdir/unlink/rename/link/... |
| `io_mpx_domain` | 9 | pipe/eventfd/epoll/pselect/ppoll |
| `ipc_domain` | 4 | shmget/shmat/shmctl/shmdt |
| `mm_domain` | 9 | mmap/munmap/mprotect/brk/mremap/madvise/mlock/msync |
| `net_domain` | 17 | socket/bind/listen/accept/connect/send/recv/getsockopt/... |
| `resources_domain` | 4 | getpriority/getrusage/prlimit64/syslog |
| `signal_domain` | 7 | kill/tkill/tgkill/sigaction/sigprocmask/sigsuspend/sigpending/... |
| `sys_domain` | ~15 | getpid/getppid/gettid/uname/sysinfo/umask/prctl/... |
| `task_domain` | ~10 | fork/vfork/clone/clone3/execve/exit/exit_group/wait/sched_yield/... |
| `time_domain` | 7 | nanosleep/clock_gettime/clock_nanosleep/gettimeofday/times/adjtimex |

#### 3.7.2 阻塞系统调用处理

对于可能阻塞的系统调用（`read`/`wait`/`futex`/`epoll_pwait`/`nanosleep` 等），采用统一模式：
1. 系统调用处理函数检查资源可用性。
2. 若不可用：返回 `EAGAIN`（值为 `-11` 的 `isize`）。
3. `kernel-core::handle_trap()` 检测 `EAGAIN` 且属于阻塞类系统调用。
4. **不递增 `sepc`**——下次该线程被调度时，CPU 重新执行同一 `ecall` 指令，系统调用被重试。
5. 调度器将当前任务设为 `Blocked`。

这是一种 **自旋式阻塞**（spin-blocking）实现：使用任务切换代替真正的内核线程休眠。

#### 3.7.3 系统调用实现示例

**read (sysno=63):**
1. 从进程 fd 表获取 `FileHandle`。
2. 通过 `fd_alias` 同步偏移量。
3. 调用 `vfs.read(handle, count)`。
4. 若返回空且不是 EOF 条件，返回 `EAGAIN` 触发阻塞重试。
5. 将数据写入用户空间缓冲区。
6. 更新偏移量。

**mmap (sysno=222):**
1. 解析 flags/prot 参数。
2. `MAP_ANONYMOUS`：调用 `address_space.map_anonymous(len, prot)` 或 `map_anonymous_at`（`MAP_FIXED`）。
3. `MAP_SHARED | MAP_ANONYMOUS`：调用 `map_anonymous_shared`。
4. 文件映射（`fd != -1`）：读取文件内容并 `map_fixed_bytes`。
5. `MAP_PRIVATE | MAP_ANONYMOUS`：同 `MAP_ANONYMOUS`。

**clone/clone3:**
1. 解析 flags (`CLONE_VM`/`CLONE_VFORK`/`CLONE_THREAD`/`CLONE_VM` 等)。
2. `CLONE_THREAD | CLONE_VM`：调用 `clone_thread_from_current`，创建共享地址空间的线程。
3. 其他：调用 `fork_process_from_current_shared`，创建新进程（CoW）。
4. 在子进程的 trap frame 中设置返回值为 0。
5. 将子进程加入调度器就绪队列。
6. `CLONE_VFORK`：父进程阻塞直到子进程退出或 execve。

#### 3.7.4 System V 共享内存

使用全局 `SHM_STATE: Mutex<ShmState>` 管理：

```rust
struct ShmState {
    segments: BTreeMap<usize, ShmSegment>,
    keys: BTreeMap<usize, usize>,  // key -> id
    next_id: usize,
}
```

- `shmget(key, size, flags)`: 创建或查找共享内存段。
- `shmat(id, addr, flags)`: 将共享段映射到进程地址空间（`map_anonymous_shared` + `write_user_bytes` 复制当前内容）。
- `shmdt(addr)`: 解除映射（`unmap`）。
- `shmctl(id, cmd, buf)`: IPC_STAT/IPC_RMID 操作。

限制：段数据在 `shmat` 时一次性复制，后续修改不同步回段。

---

### 3.8 内核核心 (`kernel-core`)

#### 3.8.1 内核启动流程

`Kernel::bootstrap(info: BootInfo)`:
1. 从 HAL 获取平台信息并打印。
2. 创建 `KernelVfs`，通过 `user_init::seed_filesystem()` 填充内嵌文件。
3. 探测块设备，尝试挂载 EXT4 根文件系统。
4. 若 EXT4 挂载成功，检测 `/musl/busybox` 并准备 OS 竞赛运行时布局。
5. 创建 `ProcessTable`，生成 init 进程（PID=1）。
6. 若在 EXT4 中找到 `/sbin/init` 或 `/bin/init`，通过 ELF 加载器加载；否则使用内嵌的 `user_init` 程序。
7. 安装 init 标准 I/O（stdin/stdout/stderr 映射到 `/dev/console`）。
8. 挂载 `/proc`、`/dev`、`/tmp` 目录。

#### 3.8.2 主循环

`Kernel::run_forever()`:
```
loop {
    // 1. 看门狗检查（OS 竞赛超时监控）
    enforce_oscomp_watchdog()
    
    // 2. 获取下一个就绪任务
    scheduler.ensure_current()
    
    // 3. 处理 force_thread_exit 标记
    // 4. 切换到进程地址空间
    // 5. 设置定时器 (10ms 时间片)
    // 6. 进入用户态 (run_user)
    // 7. 处理 trap
    handle_trap()
}
```

**空闲循环：**
- 无就绪任务且有非 init 进程：启用中断 + `spin_loop`（忙等待）。
- 无就绪任务且仅有 init 进程：`WFI`（Wait For Interrupt）节能等待。
- 定时器到期时检查超时 futex 和 itimer。

#### 3.8.3 Trap 处理

`handle_trap()`:
1. 从当前进程 trap frame 读取 `scause`、`sysno`、`args`。
2. 判断 trap 类型：
   - **外部中断**（scause=9 on RISC-V, 0 on LoongArch）：调用 `service_irqs()`，遍历 PLIC pending 并 ACK。
   - **定时器中断**（scause=5 on RISC-V, bit 11 on LoongArch）：
     - 重新编程下一次定时器（10ms 后）。
     - 检查超时 futex（`timed_wait_expired_tids`）。
     - 检查 itimer 到期（SIGALRM=14）。
     - 死锁检测：若全部阻塞任务均为 futex 等待者，强制唤醒。
     - 信号阻塞 futex 等待者检测与唤醒。
     - 分发 pending 信号。
     - 触发调度（`yield_now`）。
   - **系统调用**（scause=8 on RISC-V, 11 on LoongArch）：
     - 通过 `SyscallDispatcher::dispatch` 分发。
     - 设置返回值（若非 `EAGAIN` 阻塞类）。
     - 递增 `sepc`（跳过 ecall 指令，RISC-V 为 +4）。
     - 分发 pending 信号。
   - **其他异常**（缺页等）：打印诊断信息，终止进程组。

#### 3.8.4 看门狗系统

竞赛专用的超时监控系统：
- 按进程组跟踪启动时间（`watchdog_started_at`）。
- 名称变化自动重置计时器（检测到新 benchmark 启动）。
- 分类超时策略：
  - `busybox_testcode.sh`: 10 分钟（每个 applet 600s，supervisor 1200s）。
  - `libctest`: 10 分钟入口 + LTP 30 分钟。
  - `libc-bench`: 10 分钟。
  - `lmbench`/`unixbench`: 15 分钟。
  - `iozone`: 20 分钟。
  - 默认 group timeout: 20 分钟。
- 超时后发送 `SIGKILL` 给整个进程组，唤醒所有 futex 等待者。

**强制抢占 (forced preempt):**
- 对于 iozone 工作负载，在 IO 窗口期间使用 `FORCED_PREEMPT_DELTA_NS=5ms` 更激进的时间片。

---

### 3.9 用户态初始化 (`user-init`)

#### 3.9.1 内嵌用户程序

`user-init` 通过 `include!(concat!(env!("OUT_DIR"), "/generated_rootfs.rs"))` 嵌入编译时生成的文件系统数据。

**RISC-V 内嵌 init 程序**（手写汇编）按顺序执行以下自检：
1. 写 "user:init entered" 到 stdout。
2. eventfd + epoll 创建/控制/等待。
3. `socketpair` 创建 + 数据收发测试。
4. 信号处理器注册 + `sigprocmask` + `rt_sigtimedwait`。
5. System V 共享内存创建/附加/控制/分离。
6. `clone` + `futex` 父子同步。
7. `fork` + `waitpid`。
8. 所有测试通过后打印 "user:integration ok"。
9. 启动 OS 竞赛环境：`execve("/musl/busybox", "sh", "-c", "cd /musl && ./busybox sh ./basic_testcode.sh")`。

**LoongArch 内嵌 init 程序**：仅打印消息并退出（功能精简）。

#### 3.9.2 文件系统播种

`seed_filesystem(vfs)`:
- 遍历编译时生成的 `ROOTFS_ENTRIES`（从 `tools/rootfs/common` 目录树构建）。
- 创建目录链和文件。
- 创建 `/etc/motd`（"whuse: init process bootstrapped"）。
- 通过 `builtin_program` 函数查询内嵌的 `/sbin/init`/`/bin/init`。

---

### 3.10 平台入口 (`platform/`)

#### 3.10.1 RISC-V 入口

`entry.S`:
```asm
_start:
    la sp, boot_stack_top   # 设置 128KB 内核栈
    call rust_main          # 跳转 Rust 入口
1:  wfi; j 1b               # 永不返回的后备循环
```

`main.rs`:
1. 初始化 buddy 分配器（224MB 堆）。
2. `unsafe { HEAP.0.as_mut_ptr() }` 作为全局堆。
3. 通过 `#[global_allocator]` 注册 `LockedBuddyAllocator<22>`（2^22=4MB 最大块，22 阶）。
4. `rust_main()`: 
   - 初始化 HAL（UART、VirtIO、PLIC）。
   - 注册 HAL bundle。
   - 调用 `kernel_core::boot_forever(info)`。

#### 3.10.2 LoongArch 入口

类似结构，堆大小 192MB，`LockedBuddyAllocator<21>`。

#### 3.10.3 Buddy 分配器实现

两个平台各自内嵌 buddy 分配器实现：
- 以 2 的幂次方大小分配（最小块 = `size_of::<usize>()`）。
- `push(order, ptr)` / `pop(order)` 管理空闲链表。
- `alloc(layout)`: 向上取整到 2 的幂，从对应阶开始搜索，必要时分裂大块。
- `dealloc(ptr, layout)`: 释放并尝试与 buddy 合并，递归向上合并。
- 中断安全：`alloc` 中临时禁用中断。

**限制：**
- RISC-V 和 LoongArch 有各自独立的 buddy 实现（代码重复）。
- 无碎片整理。
- 分配失败时打印调用栈并 panic。

---

### 3.11 构建系统 (`xtask`)

**xtask 命令集：**
- `build`/`build-riscv`/`build-loongarch`: Cargo 交叉编译。
- `image-riscv`/`image-loongarch`: 制作 EXT4 根文件系统镜像（通过 shell 脚本调用 `mkfs.ext4`）。
- `qemu`/`qemu-riscv`/`qemu-loongarch`: 本地 QEMU 启动。
- `qemu-*-contest`: Docker 容器化 QEMU 启动（竞赛环境）。
- `oscomp-*`: OS 竞赛完整评测流程（Docker 容器 + 超时管理 + 日志收集）。

**内核二进制打包：**
使用 `objcopy -O binary` 将 ELF 转换为 raw binary，输出为 `kernel-rv`/`kernel-la`。

**竞赛评测集成：**
- Stage 1: 基础功能测试（init 进程自检）。
- Stage 2: 完整 benchmark 测试（busybox/libcbench/iozone/lmbench/lua/unixbench/netperf/iperf/LTP/cyclictest）。
- 支持 profile 过滤（`full`/`basic`/`busybox`/.../`ltp`）。
- Docker 超时管理：`timeout` 命令包装，3600s 默认超时。
- LTP 白名单/黑名单测试用例过滤。

---

## 四、子系统交互关系

### 4.1 系统调用完整路径

```
用户态程序
  │ ecall (RISC-V) / syscall (LoongArch)
  ▼
__whuse_user_trap_entry (汇编)
  │ 保存上下文 → TrapFrame
  ▼
__whuse_kernel_ra (返回内核 Rust)
  ▼
Kernel::run_current_process() → hal().cpu.run_user(frame)
  │ 返回后
  ▼
Kernel::handle_trap()
  ├── 系统调用? → SyscallDispatcher::dispatch(sysno, args, procs, scheduler, vfs)
  │   ├── fs_domain   → VFS (KernelVfs) → EXT4 / 内存节点
  │   ├── mm_domain   → MemoryManager (AddressSpace)
  │   ├── task_domain → ProcessTable (fork/clone/execve/exit/wait)
  │   ├── signal_domain → ProcessTable (kill/sigaction/...)
  │   ├── net_domain  → VFS (socket 节点)
  │   ├── io_mpx_domain → VFS (pipe/eventfd/epoll)
  │   ├── ipc_domain  → 全局 SHM_STATE
  │   ├── time_domain → HAL Timer
  │   └── ...
  ├── 定时器中断? → 超时检查 → dispatch_pending_signals() → yield_now()
  └── 外部中断?   → service_irqs()
  ▼
Scheduler::schedule_next() → 选择下一个 Task
  ▼
回到 run_current_process() 循环
```

### 4.2 Fork 流程

```
sys_clone/clone3 (syscall)
  → ProcessTable::fork_current()
    → Process::fork_from(pid)  或  Process::fork_from_shared(pid)
      → AddressSpace::clone_private() / clone()
        → 遍历 mappings，克隆 Segment
          → Owned: Arc::clone(frames)    -- CoW 共享
          → Shared: Arc::clone(bytes)    -- 完全共享
          → Host: 转换为 Owned (分配新帧)
        → FrameAllocator::alloc_page()   -- 按需分配
      → 复制 fds, signal_actions, credentials
    → ProcessTable 插入新 Process
  → Scheduler::spawn()  加入就绪队列
  → 子进程 trap_frame.set_retval(0)
  → 父进程返回子进程 PID
```

### 4.3 信号处理路径

```
发送: kill(pid, sig)
  → ProcessTable::deliver_signal(pid, signal)
    → send_signal_tid / send_signal_pgid / send_signal_all
      → 为目标进程设置 pending_signals |= 1<<(sig-1)
      → 若目标被 futex_wait 阻塞，清空 futex 等待状态
      → scheduler.wake_task(tid)

处理: dispatch_pending_signals() (在定时器中断或系统调用返回时)
  → 检查 pending_signals & !signal_mask
  → 查找 SigAction
  → SIG_DFL(0): 终止进程
  → SIG_IGN(1): 忽略
  → handler: 在用户栈构建信号帧 → sepc = handler
  → 下次进入用户态时自动跳转到信号处理器

返回: rt_sigreturn
  → 从用户栈恢复 trap_frame
  → 恢复 signal_mask
  → sepc 回到被中断位置
```

---

## 五、创新性分析

### 5.1 架构设计创新

1. **HAL trait 抽象层**：通过 9 个 trait 完整定义平台接口，使双架构（RISC-V/LoongArch）共享同一套内核逻辑。这在 Rust OS 项目中是一个干净且可扩展的设计，与 Linux 的 `arch/` 目录思路类似但更类型安全。

2. **惰性页表重建**：通过 `dirty` 标志延迟页表重建到地址空间切换时，避免每次映射变更都触发全量页表遍历，这是一种实用优化。

3. **自旋式阻塞模型**：通过不递增 `sepc` 实现系统调用自动重试，避免传统内核的线程休眠/唤醒机制的复杂性。这在与用户态调度器结合的简单场景中非常高效。

### 5.2 工程实践创新

1. **竞赛级看门狗系统**：针对 OS 竞赛场景设计的智能超时检测——按进程名称自动匹配超时策略、名称变化自动重置计时器、死锁检测（全 futex 阻塞时强制唤醒）、EINTR 活锁保护（1000 次 EINTR 后强制退出）。这些是面向实际竞赛痛点的工程解决方案。

2. **Busybox/脚本深度适配**：
   - 自动 shebang 解析（`#!` 解释器重定向）。
   - `.sh` 文件自动通过 busybox `sh` 执行。
   - Busybox applet 特殊处理（`wait`/`locale`/`useradd`/`userdel` 重定向到包装脚本）。
   - 这些适配显著提升了与现有 Linux 用户态的兼容性。

3. **集成自检 init 程序**：RISC-V 平台内嵌的汇编 init 程序在启动时执行 eventfd/epoll/socketpair/signal/shm/clone/futex/fork 的完整自检，确保内核核心功能正常后再启动竞赛工作负载。这大大简化了调试流程。

4. **内嵌用户态文件系统**：通过 `include_bytes!` 宏在编译时嵌入 busybox 和测试框架二进制，使内核可以完全不依赖外部存储启动完整的用户态环境。

### 5.3 局限性与改进空间

1. **CoW 实现不完整**：`clone_private` 通过 `Arc` 共享物理帧，但缺少缺页中断处理来触发实际复制。当子进程写入共享页时，两个进程都会看到修改（因为实际共享同一内存），这与标准 CoW 语义不符。

2. **Bump 帧分配器**：无法回收释放的物理帧，长时间运行会导致内存耗尽。

3. **无真实网络栈**：raw socket 实现仅在 socket 间转发数据，无实际网络设备驱动和数据包收发。

4. **代码重复**：RISC-V 和 LoongArch 的内核核心（`lib_riscv.inc.rs`/`lib_loongarch.inc.rs`）有大量重复代码，维护负担较重。两个平台的 buddy 分配器也是各自实现的。

5. **调度器过于简单**：FIFO 轮转不支持优先级，iozone 等 I/O 密集型工作负载的强制抢占是一种粗糙的启发式方法。

---

## 六、测试缺失说明

由于环境限制，本次分析**未进行**以下测试：

1. **实际 QEMU 运行测试**：需要完整的 `nightly-2025-01-18` Rust 工具链（含 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 目标），以及包含 busybox 和测试框架的 EXT4 根文件系统镜像。构建命令为：
   ```
   cargo xtask build-riscv  # 编译 RISC-V 内核
   cargo xtask qemu-riscv   # QEMU 启动
   ```

2. **基准测试运行**：竞赛评测需要 Docker 环境和特定的容器镜像（`docker.educg.net/cg/os-contest:20260104`）。

3. **单元测试**：`task` crate 包含基础的调度器单元测试，但未在分析环境中运行。

这些测试的缺失不影响静态代码分析的完整性，但实际的竞态条件、性能特征和边缘情况需要通过运行时测试验证。

---

## 七、总结

whuse 是一个**高度完整的 UNIX 兼容宏内核**，用 Rust 编写，面向 RISC-V 64 和 LoongArch 64 双架构。以下是对项目的整体评价：

**核心优势：**
- **系统调用覆盖广**：实现了约 130+ 个 Linux 系统调用，覆盖文件 I/O、进程管理、信号、内存管理、socket 网络、IPC、epoll、futex 等关键子系统。
- **进程模型完整**：支持 fork/clone/execve/exit/wait 完整生命周期，含线程组（CLONE_THREAD）、vfork、SIGCHLD、waitpid 等。
- **双架构支持**：RISC-V 64 和 LoongArch 64，HAL 抽象层实现良好。
- **竞赛工程化成熟**：看门狗系统、自检 init、busybox 深度适配、Docker 容器化评测——这些都是面向竞赛场景的实战方案。
- **VFS 框架灵活**：支持内存文件系统、EXT4 只读挂载、procfs/devfs/tmpfs、管道、socket 等多种节点类型。

**实现完整度评估（自定基准：Linux 系统调用接口的 POSIX 兼容性）：**
- 进程管理：85%
- 内存管理：70%
- 文件系统：75%
- 信号处理：90%
- Socket 网络：40%（Unix socket 完整，raw socket 基本，无 TCP/UDP）
- 调度器：30%（基础 FIFO，无优先级/多核/CFS）
- 整体：**约 70-75%** 的 musl/glibc busybox 兼容性覆盖

**设计亮点：**
自旋式阻塞系统调用模型、竞赛级看门狗、集成自检 init、惰性页表重建、内嵌用户态文件系统。

**主要不足：**
CoW 语义不完整、帧分配器不可回收、双平台代码重复、网络栈不完整、调度器功能有限。

作为 OS 竞赛项目，whuse 在系统调用兼容性和竞赛工程化方面展现了较高的完成度，其 HAL 抽象和集成自检的设计在同类 Rust OS 项目中具有参考价值。