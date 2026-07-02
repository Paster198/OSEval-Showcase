# KunikOS 操作系统内核技术分析报告

---

## 一、分析概要

本报告基于对 KunikOS 仓库全部 18 个源文件（4167 行）的逐行阅读、两次交叉编译（RISC-V64 + LoongArch64）的构建验证、双架构 clippy 静态检查、以及 QEMU-riscv64 裸机启动测试。分析覆盖了硬件抽象层、内存管理、陷入/异常处理、用户态切换、系统调用层、文件系统、块设备驱动、网络子系统等全部模块。

---

## 二、构建与测试结果

### 2.1 构建验证

| 目标 | 命令 | 结果 |
|------|------|------|
| RISC-V64 交叉编译 | `cargo build --release --target riscv64gc-unknown-none-elf` | **通过**，产出 1.6 MB 的 `kunikos` ELF |
| LoongArch64 交叉编译 | `cargo build --release --target loongarch64-unknown-none-softfloat` | **通过** |
| RISC-V64 clippy | `cargo clippy --release --target riscv64gc-unknown-none-elf` | **零警告** |
| LoongArch64 clippy | `cargo clippy --release --target loongarch64-unknown-none-softfloat` | **零警告** |

### 2.2 QEMU 裸机启动测试（RISC-V64）

在无磁盘镜像的条件下启动，内核按预期完成全部引导阶段后因无 virtio-blk 设备退出：

```
OpenSBI v1.3 ... Boot HART Domain: root ...
[KunikOS] booting on riscv64
[KunikOS] heap ready: [0, 1, 4, 9, 16, 25, 36, 49]
[khal] trap handled: breakpoint, resume at 0x80202176
[KunikOS] trap round-trip ok
[KunikOS] paging + frame alloc + dynamic map ok (paged-heap-ok)
[KunikOS] boot pipeline ok
[KunikOS] no virtio-blk device
```

此输出验证了以下引导管线的每个阶段：`_start` → 内核堆 → trap 往返（ebreak）→ 分页开启 → 帧分配与动态映射 → virtio-blk 探测。无磁盘镜像故在此停下，行为完全符合设计预期。

---

## 三、项目总体架构

KunikOS 采用严格的双层架构：`khal`（KunikOS Hardware Abstraction Layer）+ `kunikos`（架构无关内核）。核心设计哲学为 **"一个 HAL，一个内核"**：所有硬件差异收敛在 `khal` 两个 per-arch 模块中，内核 crate 对两套 ISA 编译时一字不改，且从不出现 `riscv64`/`loongarch64` 字样。

```
kunikos (kernel crate, binary)
   |
   | 唯一依赖: khal (lib crate)
   |
   +-- khal/src/lib.rs  (编译期 cfg 分发)
         |
         +-- riscv64.rs   (cfg target_arch="riscv64")
         +-- loongarch64.rs (cfg target_arch="loongarch64")
```

Cargo workspace 零外部依赖——`Cargo.lock` 仅含 `khal` 与 `kunikos` 两个成员。

---

## 四、各子系统详细拆解

### 4.1 硬件抽象层（khal）

#### 4.1.1 接口契约

`khal/src/lib.rs`（48 行）是整个内核与硬件之间唯一的接口文件。它通过编译期 `cfg` 分发从对应 arch 模块 `pub use *` 来暴露统一 API：

```rust
#[cfg(target_arch = "riscv64")]
mod riscv64;
#[cfg(target_arch = "riscv64")]
pub use riscv64::*;

#[cfg(target_arch = "loongarch64")]
mod loongarch64;
#[cfg(target_arch = "loongarch64")]
pub use loongarch64::*;
```

这种设计确保编译时**有且仅有一个 arch 模块被编译**，实现编译期单态化，无 trait object、无动态分发。

公共接口涵盖：

| API | RISC-V64 | LoongArch64 | 说明 |
|-----|----------|-------------|------|
| `ARCH`, `console_putchar`, `shutdown` | 完整 | 完整 | 平台标识与基本 I/O |
| `TrapFrame`, `init_trap`, `test_breakpoint` | 完整 | 完整 | 陷入帧与异常设置 |
| `init_paging`, `frame_alloc` (内部) | 完整/Sv39 | 完整/4级4KB软件TLB | 分页初始化 |
| `setup_user`, `load_elf`, `load_elf_args` | 完整 | 完整 | ELF 加载 |
| `run_user`, `exit_user`, `reset_user_space` | 完整 | 完整 | 用户态执行 |
| `spawn_child` (fork/clone) | **完整实现** | **stub（返回 0）** | 进程创建 |
| `exec_replace` | 完整 | 完整 | execve 映像替换 |
| `set_user_brk`, `user_brk`, `user_mmap` | 完整 | 完整 | 用户内存管理 |
| `mark_shared` | 完整 | **no-op** | MAP_SHARED 标记 |
| `time_ns` | 完整（100ns/tic） | 完整（10ns/tic） | 时间 |
| `arm_timeout` / `disarm_timeout` / `enable_timer_irq` | 完整 | 完整 | 定时器超时 |
| `frame_watermark` | 完整 | 无（用内部 KERNEL_WATERMARK） | 帧分配器水位 |
| `pci_scan` | 无 | 完整 | PCI 枚举（仅 LA 需要） |
| `enter_user` | 无 | 完整 | 便捷入口 |

**缝的不对称性**是一个明确的工程现实：La64 侧的 `spawn_child` 为 stub（返回 0 退出码），这直接导致 `fork`、`clone` 等系统调用在 La64 上无实际效果，同时也意味着 La64 侧无法通过需要进程创建的测试。

#### 4.1.2 RISC-V64 启动流程

`_start` 位于 `.text.entry` 段，链接地址 `0x80200000`（QEMU virt 的 OpenSBI 交接地址）：

```asm
_start:
    la   sp, _stack_top
    call kunikos_main
1:  wfi
    j    1b
```

仅 3 条指令：设栈 → 跳 Rust → 死循环。无 C 运行时、无 BSS 清零。内核运行在 S 态（Supervisor mode），OpenSBI 已在 M 态完成机器级初始化（PMP、CLINT、中断委托）。SBI 调用封装为：

```rust
fn sbi_call(eid: usize, arg0: usize) -> usize {
    let ret;
    unsafe { asm!("ecall", inlateout("a0") arg0 => ret, in("a7") eid, options(nostack)); }
    ret
}
```

- 控制台输出：SBI `console_putchar`（EID 0x01）
- 关机：SBI `shutdown`（EID 0x08）
- 定时器：SBI `set_timer`（EID 0x00）

#### 4.1.3 LoongArch64 启动流程

La64 无 SBI，从复位态自举：

```asm
_start:
    la.global $sp, _stack_top
    bl   kunikos_main
1:  idle 0
    b    1b
```

链接地址 `0x200000`（低物理地址）。复位时 `CRMD.DA=1, PG=0`，MMU 被旁路，VA==PA。控制台走裸 MMIO——UART 基址 `0x1fe001e0`，关机向 GED 寄存器 `0x100e001c` 写入 `0x34`。整个启动过程在恒等寻址下完成，直到 `init_paging` 打开 MMU。

#### 4.1.4 陷入与异常处理

**RISC-V64** 使用 `stvec`（direct 模式）安装两个向量：

| 向量 | 用途 | 安装时机 |
|------|------|----------|
| `__trap_entry` | 内核态自陷（breakpoint，启动验证） | `init_trap()` 时 |
| `__uentry` | 用户态系统调用与中断 | 进入用户态前 |

内核态陷入处理（`rv_trap_handler`）：仅处理 `breakpoint`（scause=3），根据指令是否压缩判定 2 或 4 字节跳过；其余异常直接关机。

用户态陷入处理（`rv_user_syscall`）：
- **定时器中断**（scause=最高位|5）：超过死线则 `exit_user(124)` 杀掉超时程序；否则重整定时器后返回用户态。
- **ecall from U-mode**（scause=8）：解码 `a7=syscall编号, a0-a5=参数`，调用 `kunikos_syscall`，返回值写入 `a0`，`sepc+=4`。
- **其他异常**：打印 `scause/stval/sepc` 后用退出码 139（SIGSEGV）终止用户程序。

**LoongArch64** 使用 CSR `EENTRY` 安装两个 4KB 对齐的向量：

| 向量 | CSR | 用途 |
|------|-----|------|
| `__la_trap_entry` | EENTRY(0xc) | 内核态自陷（breakpoint） |
| `__la_uentry` | EENTRY(0xc)，进入用户态前覆写 | 用户态系统调用与中断 |

LoongArch 内核态处理用 `ESTAT.Ecode` 解码：断点为 `0xc`（BRK），跳过 4 字节。用户态处理按 `ecode==0xb`（syscall）解码 `r11=编号, r4-r9=参数`，调度 `kunikos_syscall`；`ecode==0` 且 `ESTAT.IS[11]` 为定时器中断。

#### 4.1.5 分页与内存映射

**RISC-V64：Sv39 三级页表（硬件遍历）**

```rust
const PTE_V: u64 = 1 << 0;
const PTE_R: u64 = 1 << 1;
const PTE_W: u64 = 1 << 2;
const PTE_X: u64 = 1 << 3;
const PTE_U: u64 = 1 << 4;
const PTE_A: u64 = 1 << 6;
const PTE_D: u64 = 1 << 7;
```

`init_paging` 策略：
1. 帧分配器起点 = `_ekernel` 向上对齐 4KB 页
2. 用一条 **1 GiB 大页**（`ROOT[2]`）恒等映射全部 RAM（`0x80000000` 起）
3. 逐页（4KB）映射 MMIO 区：`0x1000_0000..0x1001_0000`
4. 写 `satp`（MODE=Sv39, PPN=根页表物理地址），`sfence.vma` 刷新 TLB
5. 置 `sstatus.SUM=1`，允许 S 态访问 U 态页（系统调用读写用户缓冲区）

**LoongArch64：4 级 4KB 页表（软件填 TLB）**

这是本项目的核心工程亮点之一。La64 采用 MIPS 血统的软件 TLB 重填机制：

```rust
const PTE_KERN_RAM: u64 = PTE_V | PTE_D | PTE_MAT_CC | PTE_G;
const PTE_KERN_MMIO: u64 = PTE_V | PTE_D | PTE_MAT_SUC | PTE_G;
```

`init_paging` 策略：
1. 恒等映射低 256 MiB（`0x0..0x1000_0000`）为 `PTE_KERN_RAM`（coherent cached）
2. MMIO 区使用 `PTE_KERN_MMIO`（strongly-ordered uncached）：UART `0x1fe00000`、GED `0x100e0000`、PCIe ECAM `0x20000000..0x20100000`、PCI MMIO BAR 窗 `0x40000000..0x41000000`
3. 设置 PWCL/PWCH（页表遍历控制）、PGDL（页表根）、STLBPS（页大小 = 4KB）
4. 安装 TLB 重填入口 `__la_tlb_refill` 到 `TLBRENTRY`
5. 设置 EUEN 启用 FP/LSX/LASX（硬浮点 ABI 需要）
6. 翻转 `CRMD.DA→0, PG→1`——这是最微妙的时刻：若恒等映射或重填处理程序有误，下一条取指就会出错

TLB 重填处理程序（`__la_tlb_refill`）：

```asm
__la_tlb_refill:
    csrwr $t0, 0x8b       # TLBRSAVE：保存 t0
    csrrd $t0, 0x1b       # PGD：取坏地址对应的页表根
    lddir $t0, $t0, 3     # Dir3→Dir2
    beqz  $t0, 1f
    lddir $t0, $t0, 2     # Dir2→Dir1
    beqz  $t0, 1f
    lddir $t0, $t0, 1     # Dir1→PT
    beqz  $t0, 1f
    ldpte $t0, 0          # 载入 TLBRELO0/1
    ldpte $t0, 1
    b     2f
1:  # 无效项：填 NR|NX 占位
    ...
2:  tlbfill
    csrrd $t0, 0x8b       # 恢复 t0
    ertn
```

这是从零编写的完整四级软件 TLB 重填处理程序，使用 LoongArch 专用的 `lddir`/`ldpte`/`tlbfill` 指令，链式遍历页表后填入 TLB。

#### 4.1.6 用户态切换

**RISC-V64 用户态进入**（`__enter_user`）：
1. 将 `stvec` 指向用户陷入入口 `__uentry`
2. `sscratch` 存内核栈顶（用户陷入时 `csrrw` 交换）
3. `sepc` 设入口地址，`sstatus.SPP=0`（返回 U 态），`sret`

**从系统调用返回**：恢复全部 31 个寄存器 + sepc + sstatus，`sret`。

**LoongArch64 用户态进入**（`__la_run_user`）：
1. 保存内核上下文（ra, sp, fp, s0-s8）到 `KernelContext`
2. `EENTRY` 指向 `__la_uentry`，`SAVE0` 存内核栈顶
3. `PRMD: PPLV=3|PIE=1`，`ERA` 设入口，清全部 31 个寄存器（防泄漏）
4. `ertn`

**LoongArch64 用户陷入交换**（`__la_uentry`）：
- `csrwr $sp, 0x30`：`sp`↔`SAVE0`（用户 sp ↔ 内核栈）的一步原子交换

**返回内核**（`__la_ret_to_kernel`）：
- 恢复 `KernelContext` 中 12 个被调用者保存寄存器，`jr $ra`

**退出码传递**：RISC-V 通过 `__ret_to_kernel` 将退出码写入 `a0` 后 `ret` 到 `run_user` 的调用点；LoongArch 同样通过 `__la_ret_to_kernel`，退出码经 `t0` 转入 `a0`。

#### 4.1.7 ELF 加载器

两架构共用相同的 ELF 解析逻辑（在各自 arch 文件中重复实现，略有差异）：

**基本流程**：验证 ELF 魔数 → 解析程序头 → 遍历 `PT_LOAD` 段 → 为每段分配帧并映射到用户地址空间 → 从 ELF 文件拷入段内容 → 设置 brk → 映射用户栈（8 页） → 构建初始进程栈（argc/argv/envp/auxv）。

**初始栈布局**（Linux ABI 兼容）：
```
[栈顶向下]
  AT_RANDOM (16 bytes)
  参数字符串区
  envp[0] 字符串 ("LTP_IPC_PATH=/ltpipc")
  auxv: [AT_PHDR, AT_PHENT, AT_PHNUM, AT_PAGESZ, AT_RANDOM, AT_NULL]
  envp[1] = NULL
  envp[0]
  argv[N] = NULL
  argv[N-1] ... argv[0]
  argc
```

**关键差异**：
- RISC-V64：auxv 仅含 AT_PAGESZ(6), AT_RANDOM(25), AT_NULL(0)，共 6 条
- LoongArch64：auxv 包含 AT_PHDR(3), AT_PHENT(4), AT_PHNUM(5), AT_PAGESZ(6), AT_RANDOM(25), AT_NULL(0)，共 12 条。AT_PHDR 用于 musl libc 定位 TLS 模板——这是 La64 侧能正确运行多线程程序的关键

### 4.2 内核堆分配器（heap.rs，149 行）

实现了一个 64 MiB 静态区上的空闲链表分配器，注册为 `#[global_allocator]`：

```rust
const HEAP_SIZE: usize = 0x400_0000; // 64 MiB
const MIN: usize = 16;               // 最小块粒度
```

**数据结构**：
- 一块 `#[repr(align(16))]`、`UnsafeCell<[u8; HEAP_SIZE]>` 的静态内存
- 空闲链表头存储在 `UnsafeCell<usize>` 中
- 每块头 16 字节：`[size: usize][next: usize]`

**算法**：
- **分配**：首次适配（first-fit），遍历空闲链表找第一块 `bsize >= need` 的块。若剩余 `>= MIN`（16 字节）则分裂，否则整块分配。使用自旋锁（`AtomicBool` CAS）保护。
- **释放**：按地址序插入空闲链表，与前块和后块合并（相邻合并）。
- **对齐**：所有分配 16 字节对齐。

**特点与局限**：
- 单 hart 顺序执行，自旋锁仅为满足 Rust `GlobalAlloc` 的并发安全签名要求
- 无 BSS 初始化——整个 `HEAP` 静态数组在 `.bss` 段中为零，`ensure_init` 仅在首次分配时执行
- 无碎片整理，长时间运行可能产生外部碎片
- 64 MiB 容量针对测试场景（大文件 ftruncate + ELF 加载），与实际 RAM 限制匹配

### 4.3 系统调用层（syscall.rs，606 行）

#### 4.3.1 分发架构

唯一入口：`kunikos_syscall(num, a0..a6) -> isize`，由 khal 的 trap handler 调用。使用 Linux `asm-generic` 统一系统调用编号，通过一个大 `match` 分发约 **102 个系统调用**：

```rust
match num {
    64 => sys_write(a0, a1, a2),
    93 | 94 => { khal::exit_user(a0); }
    172 => unsafe { CUR_PID as isize }, // getpid
    ...
    _ => { -38 } // -ENOSYS
}
```

#### 4.3.2 系统调用分类

| 类别 | 调用号 | 实现策略 |
|------|--------|----------|
| **文件 I/O** | 56(openat), 57(close), 63(read), 64(write), 61(getdents64), 62(lseek), 46(ftruncate), 67(pread), 68(pwrite), 65(readv), 66(writev), 23(dup), 24(dup3), 59(pipe2), 80(fstat), 79(fstatat), 291(statx) | 真实现，委托给 `fs` 模块 |
| **目录操作** | 17(getcwd), 34(mkdir), 35(unlink), 49(chdir) | 真实现 |
| **内存管理** | 214(brk), 215(munmap), 222(mmap), 226(mprotect) | 真实现（mmap支持匿名+文件映射） |
| **进程管理** | 220(clone), 221(execve), 260(wait4), 93/94(exit), 96(set_tid_address) | 真实现（clone 分 fork/线程两路） |
| **进程标识** | 172(getpid), 173(getppid), 174/175(getuid/euid), 176/177(getgid/egid), 178(gettid) | 返回固定值（root=0）或动态 PID |
| **时间** | 169(gettimeofday), 113(clock_gettime), 101(nanosleep), 115(clock_nanosleep) | 真实现 |
| **信号** | 134(rt_sigaction), 135(rt_sigprocmask), 133(rt_sigsuspend) | 信号掩码真存储，投递为 no-op |
| **网络** | 198(socket), 200(bind), 201(listen), 202/242(accept), 203(connect), 204(getsockname), 206(sendto), 207(recvfrom), 208(setsockopt) | 真实现，委托给 `net` 模块 |
| **futex** | 98(futex) | 真实现，值比较+忙等 |
| **资源限制** | 163/164/261(prlimit), 25(fcntl) | RLIMIT_NOFILE 真处理，其余返回大值 |
| **proc 伪文件系统** | 78(readlinkat), 48(faccessat), 43/44(statfs/fstatfs) | 合成数据返回 |
| **其他** | 29(ioctl), 33(mknodat), 36(symlinkat), 37(linkat), 39(umount2), 40(mount), 45(truncate), 47(fdatasync), 52-55(chmod/fchown系列), 82(fsync), 83(fdatasync), 88(utimensat), 89(utime), 99(set_robust_list), 103(setitimer), 122-123(sched_affinity), 124(sched_yield), 129-131(kill/tkill/tgkill), 154(setpgid), 155(getpgid), 157(setsid), 159(setgroups), 166(umask), 227(msync), 228-231(mlock系列), 232(mincore), 233(madvise), 278(getrandom), 165(getrusage), 179(sysinfo), 10(fgetxattr) 等 | 语义合法前提下的"平凡满足"（如 mlockall 恒成立）或返回适当 errno |

#### 4.3.3 关键系统调用实现细节

**fork/clone（sys_clone）**：
```rust
fn sys_clone(flags: usize, new_sp: usize, tls: usize, ctid: usize) -> isize {
    // CLONE_VM(0x100) → 线程（共享地址空间）
    // 否则 → fork（快照可写用户页 + brk/mmap游标，子结束后还原）
}
```
- `CLONE_VM`（线程）：直接在共享地址空间上运行子进程 trace，不保存/还原
- `CLONE_VM` 未设置（fork）：遍历所有用户可写页表项（`walk_user_writable`），用 `Box<[u8; 4096]>` 快照物理页内容，子进程结束后逐页还原
- 支持 `CLONE_CHILD_SETTID`/`CLONE_CHILD_CLEARTID`（写 ctid）
- 子进程在副本陷入帧上执行（`spawn_child` → `run_user_tf`），`a0=0`，`sepc+=4`（越过 ecall）
- 同步执行（子进程跑完才返回父进程），僵尸进程用 32 槽静态数组记录

**mmap**：
```rust
fn sys_mmap(len: usize, flags: usize, fd: usize) -> isize {
    let va = khal::user_mmap(len);
    // 文件映射：拷入文件内容
    // MAP_SHARED：标记区间，fork 时不快照
}
```
支持匿名映射（`MAP_ANONYMOUS`）和文件映射（`fd != -1` 时拷入文件内容），`MAP_SHARED` 标记的区间在 fork 时不快照/还原（用于 LTP tst 框架的共享内存回传）。

**execve**：
```rust
fn sys_execve(path_ptr: usize) -> isize {
    let elf = ext4::global().load(&path)?;
    let (entry, sp) = khal::load_elf(&elf);
    khal::exec_replace(entry, sp); // 不返回
}
```
从 ext4 加载新 ELF，调用 `exec_replace` 单向进入新用户程序（不复原内核上下文）。

**futex**：
```rust
fn sys_futex(addr: usize, op: usize, val: usize) -> isize {
    // FUTEX_WAIT：值匹配则忙等（非真正睡眠），上限 ~5s
    // FUTEX_WAKE：恒返回 0（等待者自行超时醒来）
}
```
简化实现：FUTEX_WAIT 忙等比较 `*addr == val`，上限约 5 秒防止死锁；FUTEX_WAKE 返回 0，等待者靠超时自旋退出。足以通过 pthread join 语义但非真正睡眠/唤醒。

**ppoll**：
```rust
fn sys_ppoll(fds: usize, nfds: usize) -> isize {
    // 同步标 fd 就绪：stdin/pipeR 恒可读，socket 在有数据报或 backlog 时标可读/可写，其余恒就绪
}
```
同步内核对 fd 标就绪——不阻塞等待，仅标记当前状态（符合顺序执行模型）。

**getrandom**：
```rust
fn sys_getrandom(buf: usize, len: usize) -> isize {
    let mut x = khal::time_ns() ^ 0x9e37_79b9_7f4a_7c15;
    // LCG: x = x * 6364136223846793005 + 1442695040888963407
}
```
使用线性同余生成器（LCG）以时间 CSR 为种子产生伪随机数，足够通过 libc-test 随机性自检，非密码学安全。

### 4.4 文件系统（fs.rs + ext4.rs）

#### 4.4.1 ext4 只读驱动（ext4.rs，218 行）

**数据结构**：
```rust
pub struct Ext4 {
    inode_size: usize,
    inodes_per_group: u32,
    desc_size: usize,
    bgd: Vec<u8>,  // 块组描述符表（挂载时缓存）
}
```

**挂载流程**（`mount`）：
1. 读取超级块（块 0，偏移 1024）
2. 验证魔数 `0xef53` 和块大小（`1024 << s_log_block_size == 4096`）
3. 解析 `inode_size`、`inodes_per_group`、`first_data_block`、块组数量
4. 缓存块组描述符表（跨 `ceil(组数*描述符大小/块大小)` 个块）

**extent 树遍历**（支持多级索引）：
```rust
fn extent_runs(&self, inode: &[u8]) -> Vec<(u32, u64, u32)> {
    // 栈式遍历：内联头(60字节)入栈
    // while pop:
    //   depth==0 → 收集 (ee_block, ee_start, ee_len)
    //   depth>0  → child=ei_leaf，读盘入栈
}
```
- 支持 `ext4_extent_idx`（内部节点，depth>0）和 `ext4_extent`（叶节点，depth=0）
- 大文件/大目录用索引树可获得正确的 extent 列表
- 仅支持 extent 格式，不支持间接块（indirect block）——但现代 ext4 默认使用 extent

**文件读取**（`read_file`）：
```rust
fn read_file(&self, ino: u32) -> Vec<u8> {
    let inode = self.read_inode(ino);
    let size = rd32(&inode, 0x4) as usize;
    let mut data = alloc::vec![0u8; size.div_ceil(BS) * BS];
    // 批量读取：连续块合并为一次 DMA 请求（最多 DATA_MAX=64KB/次）
    for (lblk, phys, run) in self.extent_runs(&inode) {
        let mut done = 0u32;
        while done < run {
            let cnt = min(run - done, PER);  // PER = DATA_MAX/BS
            virtio_blk::read(sector, &mut data[off..off+bytes]);
            done += cnt;
        }
    }
}
```
- 按逻辑块号铺放，空洞留零——这是**稀疏文件正确性的关键**
- 连续物理块批量读：每请求最多 64 KiB（`DATA_MAX`），将 1 MiB ELF 的 256 次往返压缩至约 16 次

**目录遍历**（`lookup_root` / `list_root`）：
- 从 inode 2（根目录）的 extents 逐块扫描
- 解析 ext4 目录项格式：`[ino:u32][rec_len:u16][name_len:u8][file_type:u8][name:...]`
- 按名精确匹配（`lookup_root`）或收集全部名字（`list_root`）

**限制**：仅支持 4096 字节块；仅支持根目录直接查找（无子目录递归）；不支持符号链接、权限位、时间戳的持久存储。

#### 4.4.2 文件描述符表与内存文件存储（fs.rs，729 行）

**核心数据结构**：

```rust
struct Node {
    name: String,
    data: Vec<u8>,      // 文件内容全量在内存
    dir: bool,
    names: Vec<String>, // 目录的子项名列表
    atime: u64, mtime: u64,
}

enum Fd {
    Console,
    File { idx: usize, pos: usize },
    PipeR(usize), PipeW(usize),
    Null, Zero,
    Socket(usize),
}
```

**设计要点**：

1. **全量内存模型**：文件数据首次 open 时从 ext4 全量载入 `Vec<u8>`；写入仅作用于内存副本，不回写磁盘。这使得 close/reopen 可读回写入内容（满足测试需要），但断电丢失所有修改。

2. **per-process fd 表**：64 槽（`MAXFD=64`），fd 0/1/2 默认绑定 Console。`reset()` 在每程序启动前清空。

3. **fork 的 fd 表处理**：`fork_push()` 保存父进程 fd 表快照到栈 `FD_SAVE`；子进程在活表上独立操作；`fork_pop()` 还原（子进程结束后调用）。这确保了 fork 语义的正确性——子进程的 close/dup 不影响父进程。

4. **管道**：单向字节流，`PipeBuf { buf: Vec<u8>, rpos: usize }`。写端追加字节，读端从 `rpos` 推进，读空返回 0（EOF）。在顺序执行模型下写端先写完，此后读端可完整读取。

5. **合成文件系统**：为满足 LTP/libc-test 对 `/proc` 和 `/sys` 的访问需求，内存中不存在但在 `open`/`read` 时动态返回合成内容：
   - `/proc/meminfo`：伪造内存统计（262144 kB total）
   - `/proc/cpuinfo`：按架构返回 CPU 信息
   - `/proc/sys/kernel/pid_max`, `osrelease`, `hostname`, `threads-max` 等
   - `/proc/sys/vm/overcommit_memory`, `min_free_kbytes`
   - `/proc/self/exe`：返回 `/test`（readlinkat）
   - `/proc/<pid>/*` → 归一化为 `/proc/self/*`
   - `/sys/devices/system/cpu/online` 等

6. **路径解析**：支持 `.`、`..`、绝对/相对路径。`chdir` 实现为文本级路径规范化（分割 → 压栈/弹栈 → 重组）。

7. **stat/fstat/statx**：根据节点类型（文件/目录/字符设备）返回合理的 mode、size、nlink、blksize、timestamp 等字段，结构布局对齐 Linux `struct stat` 和 `struct statx`。

### 4.5 virtio-blk 块设备驱动（virtio_blk.rs，428 行）

#### 4.5.1 共用核心：split virtqueue

```rust
#[repr(C, align(4096))]
struct Queue {
    desc: [Desc; QSIZE],   // QSIZE=16
    avail: Avail,
    _pad: [u8; ...],       // 确保 used 对齐到 4096
    used: Used,
}
```

**单次读请求**（`read` 函数，两架构共用）：
1. 构造 3 个描述符链：`[BlkReq(16B, DEV→DRV)] → [数据缓冲(可变长, DEV→DRV, WRITE标志)] → [状态字节(1B, DEV→DRV, WRITE标志)]`
2. 将描述符索引 0 写入 `avail.ring[avail.idx % QSIZE]`
3. 内存屏障（`fence(SeqCst)`）
4. `avail.idx += 1`
5. 通知设备（`notify()`）
6. 自旋等待 `used.idx` 变化（上限 200M 次迭代）
7. 检查状态字节：`0`=成功

**关键设计**：恒等映射下内核 VA = PA，缓冲地址即设备可用的物理地址，**无需翻译或弹跳缓冲**。数据直接 DMA 进目标 `&mut [u8]`，省去经静态缓冲的中转拷贝。

`DATA_MAX = 0x10000`（64 KiB）定义了单次请求的最大长度，批量读将连续物理块合并为一次 DMA 请求。

#### 4.5.2 RISC-V64 传输层：virtio-mmio

- 扫描 `0x10001000` 起的 8 个 MMIO 槽位（stride 0x1000）
- 通过 `R_MAGIC`（`0x74726976`）和 `R_DEVICE_ID`（2）识别 virtio-blk 设备
- 同时支持 **legacy**（version 1）和 **modern**（version 2）两种协议：
  - legacy：设置 `QueuePFN` 指向队列物理页帧
  - modern：协商 `VIRTIO_F_VERSION_1`，分别设置 desc/avail/used 三块地址

#### 4.5.3 LoongArch64 传输层：virtio-pci

这是另一个核心工程亮点。LoongArch virt 的 virtio-blk 是 PCI transitional 设备（device ID 0x1001），驱动使用 **PCIe ECAM**（Enhanced Configuration Access Mechanism）完成：

1. **ECAM 枚举**：bus 0，遍历 32 个设备，读 vendor/device/class 寄存器
2. **BAR 分配**：处理 64 位 BAR0/1（`0x10-0x18`），在 BAR 窗口（`0x40000000..0x41000000`，HAL 映射的 16 MiB）中分配
3. **现代能力解析**：在 PCI 配置空间偏移 0x34 找到 capability pointer，遍历 capability 链表找 vendor-specific（id=0x09）的 virtio-pci 能力结构
4. **现代握手**：经 BAR4 的 `common_cfg`/`notify_cfg`/`isr_cfg`/`device_cfg` 寄存器完成与 virtio-mmio modern 对等的初始化

```rust
// capability 结构定位：
let cap_vndr  = *next;             // cfg type
let cap_next  = *(next + 1);       // next capability
let bar       = *(next + 4);       // BAR index
let offset    = read32(next + 8);  // offset within BAR
```

PCI modern 路径完全避开 legacy I/O 空间（`0x18004000`，HAL 未映射），仅使用内存映射 BAR。

### 4.6 网络子系统（net.rs，159 行）

一个**纯内存回环**（loopback）网络栈，无硬件依赖：

```rust
pub struct Socket {
    pub port: u16,
    pub listening: bool,
    pub cloexec: bool,
    pub nonblock: bool,
    dgrams: Vec<Vec<u8>>,  // UDP 收包队列
    backlog: Vec<usize>,   // TCP 待 accept 的对端 socket 下标
}
```

**UDP 数据报**：`sendto` 按目标端口查找 socket，将数据报推入其 `dgrams` 队列；`recvfrom` 从队列取出。端口号解析 `sockaddr_in.sin_port`（大端序，偏移+2）。

**TCP 模拟**：不实现真正的 TCP 状态机，而是通过 `listen`/`connect`/`accept` 配对模拟：
- `listen(fd)`：标记 socket 为 listening
- `connect(addr)`：查找 listening 且端口匹配的 socket，创建新的 peer socket 推入 `backlog`
- `accept(fd)`：从 `backlog` 弹出 peer socket，分配新 fd

这满足 libc-test socket 测试以及 `socketpair`/`getsockname` 等需求。

**与 fd 表的集成**：`install_socket(sidx)` 在 fd 表中创建 `Fd::Socket` 条目，`socket_of(fd)` 反向查询。

### 4.7 启动与测试框架（main.rs，268 行）

`kunikos_main` 按以下管线编排启动：

```
1. 堆冒烟测试（Vec push 8 个平方数）
2. init_trap + test_breakpoint（ebreak 往返验证）
3. init_paging + 动态映射自检（Vec<u8> with_capacity + extend_from_slice）
4. virtio_blk::init（探测块设备）
5. ext4::mount（挂载文件系统）
6. 按磁盘内容选择测试集
```

**测试集自动选择逻辑**：

| 判定条件 | 执行测试集 |
|----------|-----------|
| 磁盘存在 `entry-static.exe` | libc-test（94 个用例） |
| 磁盘存在 `lua` | lua（9 个脚本） |
| 磁盘存在 `__ltp__` 标记文件 | LTP（遍历根目录 ELF） |
| 以上均无 | basic（32 个独立 ELF） |

**LTP 测试执行模式**：
```rust
for name in fs.list_root() {
    let elf = fs.load(&name)?;
    fs::reset();
    khal::reset_user_space();
    let (entry, sp) = khal::load_elf_args(&elf, &[&name]);
    let code = khal::run_user(entry, sp);
    kprintln!("FAIL LTP CASE {} : {}", name, code);
}
```

每个测试用例独立运行：重置 fd 表 + 文件系统 + 地址空间 + 帧分配器水位 → 加载 ELF → 运行 → 输出 FAIL 标记（因为所有用例都返回 FAIL，这可能是赛题的评分标记格式）。

---

## 五、OS 内核各部分的交互

### 5.1 调用链总览

```
QEMU / OpenSBI
  │
  └─ _start (asm) ─► kunikos_main (Rust)
                        │
                        ├─► khal::init_trap()       [安装内核 trap 向量]
                        ├─► khal::test_breakpoint()  [ebreak → trap handler → 跳过]
                        ├─► khal::init_paging()      [开启分页/TLB]
                        ├─► virtio_blk::init()       [扫描/初始化块设备]
                        ├─► ext4::Ext4::mount()      [读超级块 → 缓存BGD]
                        │
                        └─► run_xxx()
                              │
                              ├─► fs::reset()              [清空 fd 表/文件]
                              ├─► khal::reset_user_space() [回收用户页]
                              ├─► khal::load_elf()         [加载ELF→用户态]
                              ├─► khal::run_user()         [进入用户态]
                              │     │
                              │     ├─► (用户态执行)
                              │     ├─► ecall/syscall ──► __uentry (asm)
                              │     │                      │
                              │     │                      └─► kunikos_syscall()
                              │     │                            │
                              │     │                            ├─► fs::*  (文件I/O)
                              │     │                            ├─► net::* (socket)
                              │     │                            └─► ...
                              │     │
                              │     └─► exit_user() ──► __ret_to_kernel (asm)
                              │
                              └─► khal::shutdown()
```

### 5.2 关键交互路径

1. **系统调用完整路径**（以 write 为例）：
   - 用户程序 `write(1, "hello", 5)` → musl libc 内 `li a7, 64; ecall`
   - CPU 陷入 → `__uentry`（RISC-V）/ `__la_uentry`（LoongArch）
   - 保存全部 31 个寄存器 + sepc/ERA + sstatus/PRMD
   - 解码 `a7=64, a0=1, a1=buf, a2=5`
   - 调用 `kunikos_syscall(64, 1, buf, 5, 0, 0, 0)`
   - 分发到 `sys_write(1, buf, 5)` → `fs::is_console(1)` 为 true → 逐字节 `console_putchar`
   - 返回值写入 `a0`
   - `sepc += 4`
   - 恢复寄存器 → `sret`/`ertn`
   - 用户程序接收返回值 5

2. **fork 完整路径**（仅 RISC-V64）：
   - 用户程序 `fork()` → `clone(flags=0x11, ...)` → ecall
   - `sys_clone(flags, new_sp, tls, ctid)`
   - 不是 CLONE_VM → `fs::fork_push()` 保存父 fd 表
   - 构造子陷入帧（`a0=0`, `sepc+=4`, 可选 new_sp/tp）
   - `walk_user_writable` 快照所有用户可写页 + brk/mmap 游标
   - `run_user_tf(&child)` 同步执行子进程
   - 子进程退出 → `exit_user(code)` → 记录僵尸
   - 逐页还原父进程内存 → `fs::fork_pop()` 还原 fd 表
   - 返回子进程 pid

3. **块设备读取路径**：
   - `ext4::read_file(ino)` → `extent_runs` 得 extent 列表
   - `virtio_blk::read(sector, buf)` → 构建 3 描述符链
   - DMA 直接写入 `buf`（VA=PA）
   - 设备完成 → `used.idx` 推进 → 检查 status

### 5.3 数据流

```
磁盘 (ext4)
  │
  ├──► virtio_blk::read() ──► &mut [u8] (DMA 直接写入)
  │                              │
  │                              └──► Vec<u8> (ext4::read_file 返回)
  │                                     │
  │                                     ├──► Node.data (fs 内存文件)
  │                                     │     │
  │                                     │     ├──► read/write syscall
  │                                     │     └──► mmap 文件映射
  │                                     │
  │                                     └──► load_elf (直接拷入用户页帧)
  │
  └──► 内核使用（不再回写磁盘）
```

---

## 六、实现完整度分析

### 6.1 子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **硬件抽象层 - RISC-V64** | 95% | 完整的 Sv39 分页、SBI 接口、trap、用户态切换、fork/clone/execve、定时器超时、ELF 加载。唯一缺失：无多 hart 支持、无 PLIC/外设中断。 |
| **硬件抽象层 - LoongArch64** | 75% | 核心亮点是软件 TLB 重填和 PCIe ECAM 枚举。但 `spawn_child` 为 stub、`mark_shared` 为 no-op、无 `frame_watermark`。fork/clone 和 MAP_SHARED 的正确性在 La64 上无法验证。 |
| **内核堆分配器** | 70% | 功能完整的首次适配+合并分配器。缺少：空闲链表仅维护空闲块，分配过的块若要回收合并依赖释放顺序；无碎片整理；64 MiB 固定容量。 |
| **系统调用层** | 80% | 102 个系统调用，覆盖文件 I/O、内存管理、进程管理、时间、信号、网络、资源控制。核心缺失：无真正信号投递、无调度器（顺序执行）、futex 为忙等非睡眠、无多线程调度。 |
| **ext4 文件系统** | 50% | 只读支持 extent（含多级索引树）、超级块解析、目录遍历。不支持：写入、间接块、符号链接、扩展属性、日志、子目录递归、inode 其他字段（权限/时间戳/链接数等）。 |
| **文件描述符表** | 75% | 完整的 fd 管理、管道、/proc 合成文件、路径规范化、目录操作、fork 快照/还原。限制：单进程模型（每测试 reset）、文件全量在内存、无回写。 |
| **virtio-blk 驱动** | 85% | 支持 mmio（legacy+modern）和 pci（modern only）两种传输层。限制：仅支持读、单队列 16 描述符、无 VIRTIO_BLK_F_RO 之外的功能协商。 |
| **网络子系统** | 55% | 纯内存回环，UDP 数据报+TCP 连接配对。不支持：真实网络设备驱动、IP 层、TCP 状态机、epoll、非 SOCK_STREAM/SOCK_DGRAM 的 socket 类型。 |
| **进程模型** | 60% | fork+execve+wait4 完整（仅 RV64），clone 支持线程标志。限制：同步执行子进程、32 槽僵尸表、无调度器、无真实并发。 |

### 6.2 整体实现完整度评估

**基准定义**：以"能在 QEMU virt 上引导并运行赛题 libc-test / LTP / lua / basic 测试集"为目标的生产级教学内核。

**整体评估：约 72%**

核心证据：
- RISC-V64 侧：basic 32/32，libc-test 94/95，lua 9/9，LTP 约 106（根据设计文档）
- LoongArch64 侧：basic 32/32，libc-test 93/95，LTP 194/243（约 80%）
- 双架构 clippy 零警告，构建通过，QEMU 启动验证成功

主要差距：
- 无抢占式调度器、无多核支持
- LoongArch64 侧 fork/clone 不完整
- 文件系统只读、无网络硬件驱动
- futex/信号投递为简化实现

---

## 七、创新性分析

### 7.1 架构创新

1. **编译期单态化 HAL 缝**：这是项目最具创新性的设计。通过 `#[cfg]` + `pub use` 实现的编译期架构分发，使得内核逻辑对两套完全不同的 ISA（RISC-V 与 LoongArch）一字不改。这不是简单的"针对不同架构编译不同文件"，而是通过一个精心设计的公共 API 契约（`khal` 的导出符号集）将架构差异完全收敛。两套架构共享完全相同的 `kunikos_syscall`、`ext4`、`virtio_blk`（核心逻辑）、`net`、`fs`、`heap` 等全部内核策略代码。

2. **LoongArch64 的软件 TLB 重填**：在 RISC-V 硬件页表遍历已成为"默认"的当下，为 LoongArch 从零实现完整四级软件 TLB 重填处理程序（`__la_tlb_refill`）是一项极具深度的工程。该实现正确处理了：4KB 页四级遍历、无效映射的 NR|NX 占位符填充、TLBREHI/TLBRELO 寄存器的精确操作。这个组件与"打开 MMU"那一刻（翻转 `CRMD.DA/CRMD.PG`）构成了项目最具挑战性的技术点。

3. **LoongArch virtio-pci 现代传输路径**：在无 PCI 库的情况下，从 ECAM 枚举 → BAR 分配 → capability 链表解析 → 现代 virtio-pci 握手，全部手写。这个组件使 La64 侧无需依赖 legacy I/O 空间即可驱动 virtio-blk。

### 7.2 设计创新

4. **"同步 fork"进程模型**：在无调度器的前提下，通过"同步执行子进程 + 内存快照/还原"实现了正确的 fork 语义。用户可写页的遍历式快照（`walk_user_writable`）和 `Box<[u8; 4096]>` 逐页还原是一种巧妙的折中，既满足了 libc-test / LTP 对 fork 的语义要求，又避免了实现完整进程调度器的工程复杂度。

5. **全量内存文件模型**：文件系统采用极简的 "首次 open 载入全量 → 内存操作 → 不写回" 模型。在赛题的顺序执行测试场景下，这比实现 buffer cache / dirty 回写 / journal 等机制在工程上高效得多，且语义完全正确（close/reopen 能读回写入内容）。

6. **合成 `/proc` 文件系统**：通过字符串匹配动态返回合成数据（而非真正维护 procfs 树），以最少的代码（约 70 行匹配分支）满足了 LTP 框架对大量 `/proc`、`/sys` 文件的访问需求。

### 7.3 工程创新

7. **零外部依赖**：整个内核（含 HAL、驱动、文件系统、网络）零第三方 crate 依赖。堆分配器、virtio-blk 驱动、ext4 解析器、网络栈全部手写。这在 Rust 生态中是高度非典型的——大多数 Rust 内核至少依赖 `spin`、`bitflags`、`log` 等基础 crate。

8. **双架构统一构建**：同一 `Cargo.toml` workspace，仅通过 `--target` 和 `RUSTFLAGS`（链接脚本）区分架构，无需条件编译的 feature flag。

---

## 八、其它技术信息

### 8.1 内存布局

**RISC-V64**：
- 内核加载地址：`0x80200000`（OpenSBI 交接点）
- 内核栈：`.bss` 段末尾 + 256 KiB
- RAM 范围：`0x80000000..0x88000000`（128 MiB）
- 用户空间：VA 0..1 GiB（ROOT[0]子树）
- 用户入口：`0x10000`，用户栈顶：`0x40000000`（向下）
- MMIO 区：`0x10000000..0x10010000`

**LoongArch64**：
- 内核加载地址：`0x200000`（低物理地址，复位 DA 模式）
- 内核栈：`.bss` 段末尾 + 256 KiB
- RAM 范围：`0x0..0x10000000`（256 MiB 恒等窗口）
- 用户空间：Dir2[2..512]（≥ 2 GiB），与内核 Dir2[0]（0-1 GiB）和 PCI Dir2[1]（1-2 GiB）分离
- 用户 brk 起始：动态分配
- mmap 区：`0x200000000`（8 GiB）起向上
- 用户栈顶：`0x180000000`（6 GiB）向下

### 8.2 定时器与超时机制

- **RISC-V64**：通过 SBI `set_timer` + `sie.STIE` 启用 S 态定时器中断。`TIMEOUT_TICKS = 30_000_000`（约 3 秒 @ 10 MHz），`TICK_INTERVAL = 2_000_000`（约 0.2 秒周期）。超时后 `exit_user(124)`。
- **LoongArch64**：通过 CSR TCFG（定时器配置，周期模式）+ ECFG.LIE[11] 启用。`TIMEOUT = 200_000_000` ticks，`TICK = 5_000_000` ticks 周期。`rdtime.d` 读取 StableCounter。

### 8.3 汇编级技术细节

- RISC-V `sret` 的两阶段：`SPP→SPIE, SIE←SPIE, SPP=0` → 跳转 `sepc`
- LoongArch `ertn`：`PRMD.PPLV←0, PRMD.PIE←0, PC←ERA`
- LoongArch `csrwr` 是原子交换（写入新值同时读出旧值到寄存器）
- LoongArch `SAVE0(0x30)` 用于用户态→内核态的 sp 原子交换，避免使用内存暂存
- RISC-V `sscratch` 实现相同的交换语义（`csrrw sp, sscratch, sp`）

---

## 九、总结

KunikOS 是一个用 Rust 从零编写的、面向全国大学生系统能力大赛的双架构操作系统内核。其核心成就可以概括为：

**工程层面**：在约 4100 行 Rust 代码中，以零外部依赖实现了 HAL（双架构）、内存管理（Sv39 + 软件 TLB）、virtio-blk 驱动（MMIO + PCI）、只读 ext4（含 extent 树）、全量内存文件系统、内存回环网络、102 个 Linux ABI 系统调用分发、以及 fork/clone/execve 进程模型。双架构均通过构建和 clippy 零警告检查。

**技术层面**：最突出的技术贡献是 LoongArch64 的完整软件 TLB 重填机制和 PCIe ECAM 枚举驱动。从 DA 直址模式自举出整套四级分页翻译机器，配以手写的 TLB 重填处理程序，这是 RISC-V 硬件遍历器用户通常不会触及的底层领域。同时，编译期单态化的 HAL 缝设计使同一份内核代码在两个截然不同的 ISA 上仅需重编译即可运行。

**设计层面**：项目在多个子系统采用了"够用就好"的极简姿态——同步 fork 而非调度器、内存文件而非磁盘回写、忙等 futex 而非睡眠/唤醒——这些选择在明确的设计准则（"正确性第一"、"无死锁"、"真实现不假通过"）约束下，实现了测试通过率与工程复杂度之间的精妙均衡。

**局限**：无抢占式调度器、无多核/多 hart 支持、La64 侧 fork 不完整、文件系统只读无回写、网络仅为内存回环——这些是教学内核在约 4100 行代码规模下的合理取舍。