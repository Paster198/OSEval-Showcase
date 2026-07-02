---

# Oblivion OS 内核项目 - 深度技术分析报告

---

## 一、分析范围与方法

本报告依据对项目仓库的完整源代码审查生成。分析涵盖：

- RISC-V64 内核（`xv6-k210/`）的全部 35 个 C/汇编源文件和 37 个头文件（总计约 23,663 行）
- LoongArch64 内核探针（`la-minimal/`）的全部 4 个源文件（约 420 行代码，不含嵌入数据）
- 构建系统（3 个 Makefile、3 个链接脚本）
- 用户态测试程序（30+ 个）
- 项目设计与过程文档（19 个 Markdown）

分析方法为源代码逐行审查、符号交叉引用追踪、构建依赖分析以及架构设计推断。未进行实际构建与运行测试，因 LoongArch64 侧为预录制输出 runner 不具备测试意义，而 RISC-V64 侧需要特定 EXT4 磁盘镜像（未在仓库中提供）。

---

## 二、项目架构总览

### 2.1 双架构策略

Oblivion 是一个面向 OS 内核赛道的**双架构提交**：

| 架构 | 源目录 | 产物 | 实质 |
|------|--------|------|------|
| RISC-V64 | `xv6-k210/` | `kernel-rv` | 基于 xv6-riscv 框架、经过深度扩展的类 Unix 内核 |
| LoongArch64 | `la-minimal/` | `kernel-la` | 极简内核探针——预录制输出 runner，而非真实内核 |

二者严重不对称。RISC-V64 侧是功能完备的内核；LoongArch64 侧本质上是一个通过预先录制的基准测试输出数据来获得分数的兼容层。项目文档（`docs/design.md`）对此直言不讳。

### 2.2 平台支持

RISC-V64 内核通过条件编译支持三种平台：

| 平台 | 宏定义 | 状态 | 磁盘驱动 | 串口 |
|------|--------|------|----------|------|
| QEMU `virt` | `QEMU` | 主目标 | VirtIO | SBI 控制台 |
| K210 实板 | 默认 | 完整支持 | SPI SD 卡 | UARTHS |
| VisionFive 2 | `VISIONFIVE2` | 实验性存根 | 未实现 | VF2 UART |

### 2.3 顶层构建

根目录 `Makefile` 是比赛入口：

```makefile
all: kernel-rv kernel-la
kernel-rv:
    $(MAKE) -C $(SRC) clean
    $(MAKE) -C $(SRC) platform=qemu all
    cp $(SRC)/kernel-qemu kernel-rv
kernel-la:
    $(MAKE) -C $(LA_SRC) clean all
    cp $(LA_SRC)/kernel-la kernel-la
```

---

## 三、RISC-V64 内核子系统深度拆解

### 3.1 启动与初始化流程

**源代码**：`main.c`（133 行）、`entry_qemu.S`（19 行）、`entry_k210.S`（28 行）

启动流程（QEMU 平台）：

1. **汇编入口**（`entry_qemu.S`）：设置栈指针后跳转 `main()`。每个 hart 都从同一入口进入，通过 `mhartid` 区分。
2. **`main()` 函数**（hart 0）：
   - `consoleinit()` — 初始化控制台
   - `printfinit()` — 初始化 printf 锁
   - `kinit()` — 初始化物理页分配器
   - `kvminit()` — 创建内核页表（直接映射 + 设备 MMIO 映射 + 蹦床页）
   - `kvminithart()` — 启用分页（写入 `satp` CSR）
   - `timerinit()` — 初始化时钟锁
   - `trapinithart()` — 安装内核 trap 向量（`kernelvec`），启用中断
   - `procinit()` — 初始化进程表
   - `plicinit()` / `plicinithart()` — 初始化 PLIC 中断控制器
   - `disk_init()` — 初始化 VirtIO 磁盘
   - `binit()` — 初始化块缓冲区缓存
   - `fileinit()` — 初始化文件表
   - `userinit()` — 创建第一个用户进程（init）
   - 通过 SBI IPI 唤醒 hart 1
3. **Hart 1** 等待 hart 0 完成设置后执行 `kvminithart()`、`trapinithart()`、`plicinithart()`，进入 `scheduler()`。

**关键细节**：
- VisionFive 2 路径是一个早期 bring-up 存根：安装 trap 向量后仅轮询等待时钟中断，不启动用户态。
- 内核页表使用 Sv39 虚拟地址方案，带 `VIRT_OFFSET = 0x3F00000000` 偏移（QEMU/K210）。

### 3.2 内存管理子系统

**源代码**：`vm.c`（781 行）、`kalloc.c`（166 行）、`include/vm.h`（38 行）、`include/kalloc.h`（14 行）

#### 3.2.1 物理页分配器（`kalloc.c`）

- **数据结构**：空闲链表（`struct run`）+ 引用计数数组 `refcnt[]`
- **关键功能**：
  - `kalloc()`：从空闲链表分配一页，初始化引用计数为 1，填充垃圾字节 `0x05`
  - `kfree()`：减少引用计数，归零时回收到空闲链表，填充垃圾字节 `0x01`
  - `kaddref()`/`kgetref()`：引用计数增减/查询接口（**COW 支持的核心**）
- **引用计数的计算**：基于物理地址相对于 `KERNBASE` 的偏移索引
- **统计**：`kallocated_pages()` 通过 `total_pages - npage` 计算已用页数

```c
// kalloc.c 中的引用计数维护
void kaddref(void *pa) {
    uint64 idx = pa2idx((uint64)pa);
    acquire(&kmem.lock);
    kmem.refcnt[idx]++;
    release(&kmem.lock);
}
```

#### 3.2.2 虚拟内存管理（`vm.c`）

- **页表结构**：标准 Sv39 三级页表（512 条目/级），9+9+9+12 位拆分
- **关键函数**：
  - `walk()`：遍历页表，可选创建中间级页表
  - `mappages()`：映射虚拟地址范围到物理地址
  - `vmunmap()`：解除映射，可选释放物理页
  - `kvmmap()`：内核地址空间映射（仅启动时使用）
  - `uvmcreate()`：创建空用户页表
  - `uvmalloc()`：为用户进程分配虚拟地址空间并映射物理页
  - `uvmdealloc()`：释放用户地址空间
  - `uvmcopy()`：**fork 时的 COW 实现核心**——将可写页标记为 `PTE_COW`，在两个页表中共享物理页并增加引用计数
  - `uvmfree()`：释放整个用户页表
  - `freewalk()`：递归释放页表页

**双页表架构**：每个进程维护**两套页表**：
- `p->pagetable`：用户态页表（含 `PTE_U` 标志）
- `p->kpagetable`：该进程的内核态页表副本——使得内核可以在该进程的地址空间上下文中直接访问用户内存（通过 `copyin2`/`copyout2`），而无需切换页表

#### 3.2.3 Copy-on-Write (COW)

COW 实现在 RISC-V Sv39 页表的 **RSW（保留给软件使用）位**中定义 `PTE_COW`（位 8）：

```c
#define PTE_COW (1L << 8)   // copy-on-write marker in RSW bits
```

- **fork 时**（`uvmcopy()`）：对于所有可写页，清除 `PTE_W` 并设置 `PTE_COW`，父子进程共享物理页，增加引用计数
- **写时触发**：页面错误处理 `uvm_handle_page_fault()` 检测 `scause==15`（Store page fault）且 `PTE_COW` 置位
  - 若引用计数为 1：直接恢复 `PTE_W` 和原始标志
  - 若引用计数 > 1：分配新物理页，复制内容，更新映射，释放旧页（减少引用计数）

```c
static int cow_alloc_page(struct proc *p, uint64 va) {
    // ...
    if(kgetref((void *)pa) == 1){
        // 最后一份引用，直接恢复可写
        *pte = PA2PTE(pa) | flags;
        return 0;
    }
    // 仍然共享，分配新页并复制
    mem = kalloc();
    memmove(mem, (void *)pa, PGSIZE);
    *pte = PA2PTE((uint64)mem) | flags;
    kfree((void *)pa);
    return 0;
}
```

- **copyin/copyout 集成**：`ensure_user_page()` 在每次内核访问用户内存前隐式处理 page fault，透明地支持 COW 和 lazy allocation

#### 3.2.4 Lazy Allocation

`lazy_alloc_page()` 允许在用户态触发页面错误时按需分配堆/栈页面：

```c
static int lazy_alloc_page(struct proc *p, uint64 va) {
    if(va >= PGROUNDUP(p->brk) && va < PGROUNDDOWN(p->trapframe->sp))
        return -1;  // 不在合法范围内
    mem = kalloc();
    memset(mem, 0, PGSIZE);
    mappages(p->pagetable, va, PGSIZE, (uint64)mem, PTE_R | PTE_W | PTE_U);
    mappages(p->kpagetable, va, PGSIZE, (uint64)mem, PTE_R | PTE_W);
    return 0;
}
```

- 页面错误处理统一入口：`uvm_handle_page_fault()` 先检查 COW 再检查 lazy allocation
- 支持 sbrk（`growproc()`）向上增长堆，但尚未实现页面回收

**实现完整度评估**：内存管理子系统的 COW 和 lazy allocation 实现完整且经过良好的集成测试（`test_mem_cow.c`、`test_mem_lazy_allocation.c`）。页面替换（FIFO/LRU）虽在 Makefile 和测试名中被提及，但未在 vm.c 中发现实际实现。

### 3.3 进程管理子系统

**源代码**：`proc.c`（1,663 行）、`swtch.S`（42 行）、`exec.c`（245 行）、`include/proc.h`（112 行）

#### 3.3.1 进程模型

- **进程表**：静态数组 `struct proc proc[NPROC]`，`NPROC=50`
- **CPU 结构**：`struct cpu cpus[NCPU]`，`NCPU=2`
- **进程状态**：`UNUSED → {SLEEPING, RUNNABLE, RUNNING, ZOMBIE}`

```c
enum procstate { UNUSED, SLEEPING, RUNNABLE, RUNNING, ZOMBIE };
```

- **进程结构体关键字段**（`proc.h`）：
  - 标准字段：`pid`, `state`, `parent`, `killed`, `xstate`, `kstack`, `sz`, `pagetable`, `trapframe`, `context`, `ofile[]`, `cwd`, `name[]`
  - 调度扩展字段：`timeslice`, `slice_remain`, `priority`, `mlfq_cpu_ticks`, `mlfq_sleep_ticks`
  - 双页表字段：`kpagetable`
  - 堆边界：`brk`

#### 3.3.2 上下文切换（`swtch.S`）

简洁的 RISC-V 汇编实现，保存/恢复 14 个 callee-saved 寄存器（`ra`, `sp`, `s0`-`s11`）：

```asm
swtch:
    sd ra, 0(a0)       // 保存旧上下文
    sd sp, 8(a0)
    ...
    ld ra, 0(a1)       // 加载新上下文
    ld sp, 8(a1)
    ...
    ret
```

#### 3.3.3 fork 与 clone

- `fork()` 调用 `fork_at(0)`（子进程使用默认栈指针 0）
- `clone_proc(child_stack)` 调用 `fork_at(child_stack)`，设置子进程的 `sp` 为指定值
- `fork_at()` 的核心流程：
  1. `allocproc()` — 分配进程槽位
  2. `uvmcopy()` — COW 复制父进程内存
  3. 复制 trapframe，设置子进程 `a0=0`
  4. 复制文件描述符表（`filedup`）
  5. 复制当前工作目录（`edup`）
  6. 设置为 `RUNNABLE`

#### 3.3.4 exec（`exec.c`）

exec 实现完整支持 ELF 加载，关键特性：

- **ELF 解析**：解析 ELF 头和程序头，加载 `PT_LOAD` 段
- **双页表设置**：创建新的 `pagetable` 和 `kpagetable`
- **用户栈构建**：
  - 分配栈页，构建 argv 数组
  - **构建 Linux 兼容的 auxv 向量**（`AT_PHDR`, `AT_PHENT`, `AT_PHNUM`, `AT_PAGESZ`, `AT_ENTRY`, `AT_PLATFORM`, `AT_RANDOM`, `AT_EXECFN` 等），支持 glibc/musl 动态链接器
  - 堆起始地址（`brk`）位于 `load_end` 之上
  - 栈位于 `heapbase + 16MB` 处

```c
// exec.c 中的 auxv 构建
uint64 auxv[] = {
    3, phdr_addr,             // AT_PHDR
    4, elf.phentsize,         // AT_PHENT
    5, elf.phnum,             // AT_PHNUM
    6, PGSIZE,                // AT_PAGESZ
    9, elf.entry,             // AT_ENTRY
    15, platform_addr,        // AT_PLATFORM
    25, random_addr,          // AT_RANDOM
    31, ustack[0],            // AT_EXECFN
    0, 0,
};
```

#### 3.3.5 调度器

实现了三种调度算法（全局可切换）：

| 算法 | 枚举值 | 实现函数 |
|------|--------|----------|
| Round-Robin (RR) | `SCHED_RR=0` | `pick_rr_proc()` |
| 基于优先级 | `SCHED_PRIORITY=1` | `pick_priority_proc()` |
| MLFQ | `SCHED_MLFQ=2` | 基于优先级的选取 + 动态优先级调整 |

- **RR 调度**：
  - 时间片可配置（`set_timeslice` 系统调用）
  - `slice_remain` 递减至 0 时让出 CPU
  - 使用循环游标 `rr_cursor` 避免饥饿

- **优先级调度**：
  - 优先级范围 1-31（越小优先级越高）
  - 默认优先级 10
  - 使用 `clamp_priority()` 确保合法性

- **MLFQ 动态调整**：
  - 每 `MLFQ_WINDOW=5` 个 tick 评估一次
  - CPU 密集进程：`mlfq_cpu_ticks > mlfq_sleep_ticks` → 降低优先级
  - I/O 密集进程：`mlfq_sleep_ticks > mlfq_cpu_ticks` → 提升优先级
  - 通过 `proc_on_timer_tick()` 和 `proc_record_sleep()` 收集统计数据

```c
void mlfq_maybe_update_locked(struct proc *p) {
    uint total = p->mlfq_cpu_ticks + p->mlfq_sleep_ticks;
    if(total < MLFQ_WINDOW) return;
    if(p->mlfq_cpu_ticks > p->mlfq_sleep_ticks)
        p->priority = clamp_priority(p->priority + 1);
    else if(p->mlfq_sleep_ticks > p->mlfq_cpu_ticks)
        p->priority = clamp_priority(p->priority - 1);
    p->mlfq_cpu_ticks = 0;
    p->mlfq_sleep_ticks = 0;
}
```

#### 3.3.6 内核 init 进程自测试框架

`proc.c` 中内嵌了一个复杂的 init 进程自动测试框架：

- 维护测试用例状态机（`init_test_idx`, `init_group_idx` 等）
- 支持多组测试（basic-glibc/basic-musl、lua-glibc/lua-musl、busybox-glibc/busybox-musl、libctest-musl）
- 每次 `exit()` 时自动运行下一个测试用例
- 测试完成后调用 `rv_public_output_print()` 输出预录制基准测试结果

```c
void exit(int status) {
    struct proc *p = myproc();
    if(p == initproc){
        if(run_next_init_test(p, status) >= 0) return;
        printf("init exiting, shutdown qemu\n");
        sbi_shutdown();
    }
    // ...
}
```

### 3.4 系统调用子系统

**源代码**：`syscall.c`（1,735 行）、`sysproc.c`（205 行）、`sysfile.c`（542 行）、`include/sysnum.h`（42 行）

#### 3.4.1 系统调用分发

`syscall()` 函数实现双层分发：

1. **Linux ABI 检测**：`is_linux_abi_proc(p)` 检查进程名是否匹配已知 Linux 测试二进制名列表（"times", "execve", "busybox", "lua", "runtest.exe" 等）
2. **Linux 系统调用优先**：若进程为 Linux ABI 进程，优先调用 `linux_dispatch()` 
3. **xv6 系统调用回退**：查找 `syscalls[]` 函数指针表
4. **非 Linux 进程的 Linux 系统调用**：作为最后手段尝试

#### 3.4.2 xv6 系统调用表（32 个系统调用）

```
SYS_fork(1)        → sys_fork
SYS_exit(2)        → sys_exit
SYS_wait(3)        → sys_wait
SYS_pipe(4)        → sys_pipe
SYS_read(5)        → sys_read
SYS_kill(6)        → sys_kill
SYS_exec(7)        → sys_exec
SYS_fstat(8)       → sys_fstat
SYS_chdir(9)       → sys_chdir
SYS_dup(10)        → sys_dup
SYS_getpid(11)     → sys_getpid
SYS_sbrk(12)       → sys_sbrk
SYS_sleep(13)      → sys_sleep
SYS_uptime(14)     → sys_uptime
SYS_open(15)       → sys_open
SYS_write(16)      → sys_write
SYS_remove(17)     → sys_remove
SYS_trace(18)      → sys_trace
SYS_sysinfo(19)    → sys_sysinfo
SYS_mkdir(20)      → sys_mkdir
SYS_close(21)      → sys_close
SYS_test_proc(22)  → sys_test_proc
SYS_dev(23)        → sys_dev
SYS_readdir(24)    → sys_readdir
SYS_getcwd(25)     → sys_getcwd
SYS_rename(26)     → sys_rename
// 调度扩展
SYS_set_timeslice(400)
SYS_set_priority(401)
SYS_get_priority(402)
SYS_set_sched_algo(403)
// 内存扩展
SYS_getprocsz(500)
SYS_getpgcnt(501)
```

#### 3.4.3 Linux ABI 兼容层（50+ 系统调用）

`linux_dispatch()` 实现了一个**薄兼容层**，将 Linux RISC-V 系统调用号映射到内部实现：

**文件操作**：`openat`, `close`, `read`, `write`, `readv`, `writev`, `pread64`, `lseek`, `getdents64`, `readlinkat`, `sendfile`, `pipe2`, `dup`, `dup3`, `fcntl`, `ioctl`

**文件系统**：`mkdirat`, `unlinkat`, `mount`, `umount2`, `statfs`, `faccessat`, `newfstatat`, `fstat`, `utimensat`, `renameat2`

**进程管理**：`clone`, `execve`, `exit`, `exit_group`, `wait4`, `getpid`, `getppid`, `gettid`, `kill`, `tgkill`, `set_tid_address`, `set_robust_list`

**内存管理**：`brk`, `mmap`, `munmap`, `mprotect`

**时间相关**：`nanosleep`, `clock_gettime`, `clock_nanosleep`, `gettimeofday`, `times`

**信号**：`rt_sigaction`, `rt_sigprocmask`, `rt_sigtimedwait`（均为桩实现）

**系统信息**：`uname`, `sysinfo`, `getuid`, `geteuid`, `getgid`, `getegid`, `getcwd`, `sched_yield`, `prlimit64`, `getrandom`, `syslog`

每个 Linux 系统调用由一个独立的 `linux_sys_*()` 函数实现，这些函数：
- 解析参数并转换标志位（如 `O_RDWR` ↔ `LINUX_O_RDWR`）
- 调用底层 xv6 系统调用或文件操作
- 在需要时转换返回格式（如 `wait4` 的状态码从 xv6 格式重排为 Linux 格式）

```c
static uint64 linux_sys_wait4(void) {
    // ...
    ret = wait(status);
    if(status != 0){
        child_status = (child_status & 0xff) << 8;  // 格式转换
        copyout2(status, ...);
    }
    return ret;
}
```

**关键兼容性存根**：
- `mmap`：通过 `growproc` 扩展进程大小，若 fd 有效则从文件读取内容——非标准 mmap 语义但足以通过测试
- `brk`：直接操作 `p->brk`，无页面回收
- `clone`：映射到 `clone_proc()`，仅支持 `child_stack` 参数
- `statfs`：返回硬编码的 EXT4 超级块信息
- 信号相关系统调用：几乎全部为返回 0 或 `SIGCHLD` 的无操作存根

**实现完整度评估**：Linux ABI 兼容层覆盖了竞赛公开测试二进制所需的所有系统调用，但各系统调用的实现深度不均衡——核心 I/O 系统调用完整，而信号、内存映射和网络相关调用为桩或最小实现。

### 3.5 中断与异常处理

**源代码**：`trap.c`（339 行）、`kernelvec.S`（86 行）、`trampoline.S`（147 行）、`plic.c`（86 行）、`intr.c`（40 行）、`timer.c`（40 行）

#### 3.5.1 Trap 路径

**内核态 trap**（`kernelvec.S` → `kerneltrap()`）：
- 保存全部 32 个通用寄存器到内核栈（256 字节帧）
- 调用 `kerneltrap()` C 处理函数
- `kerneltrap()` 调用 `devintr()` 处理设备中断
- 定时器中断触发 `yield()`
- 恢复寄存器后 `sret` 返回

**用户态 trap**（`trampoline.S` 的 `uservec` → `usertrap()`）：
- 蹦床页（TRAMPOLINE）映射在内核和用户地址空间的同一虚拟地址
- `sscratch` CSR 保存 trapframe 地址
- `uservec` 保存用户寄存器到 trapframe，切换到内核页表
- `usertrap()` 处理系统调用（`scause==8`）、页面错误（`scause==13/15`）和设备中断
- `usertrapret()` 通过 `userret` 返回用户空间

#### 3.5.2 设备中断（`devintr()`）

三平台条件编译：

- **QEMU**：`scause` 位 63 置位 + 异常码 9 → PLIC 外部中断；异常码 5 → 定时器中断
- **K210**：使用 supervisor software interrupt（`scause` 位 63 + 异常码 1 + `stval=9`），因 K210 无外部中断支持
- **VF2**：使用标准 PLIC 外部中断路径（`scause` 位 63 + 异常码 9）

中断处理：
- UART 中断 → `consoleintr(c)` 读取字符并放入控制台缓冲区
- 磁盘中断 → VirtIO/SD 卡中断处理
- 定时器中断 → `timer_tick()` 递增全局 `ticks` 计数器，调用 `wakeup(&ticks)`，设置下一次超时

#### 3.5.3 定时器（`timer.c`）

- 时钟间隔：`INTERVAL = 390000000 / 2000`（约 195,000 周期，即约 200 Hz）
- 使用 SBI `set_timer` 接口设置下一次超时
- 全局 `ticks` 变量用作系统时间基准（用于 `sleep`、`uptime`、`wait` 等）

#### 3.5.4 PLIC（`plic.c`）

- 设置 UART_IRQ (10) 和 DISK_IRQ (1) 的优先级
- QEMU 路径使用 S-mode PLIC 寄存器（`PLIC_SCLAIM`/`PLIC_SPRIORITY`）
- K210 路径使用 M-mode PLIC 寄存器（`PLIC_MCLAIM`）

### 3.6 文件系统

**源代码**：`fat32.c`（986 行）、`ext4.c`（873 行）、`file.c`（249 行）、`bio.c`（160 行）、`disk.c`（75 行）、`pipe.c`（120 行）

#### 3.6.1 VFS 层（`file.c`）

- **文件类型**：`FD_NONE`, `FD_PIPE`, `FD_ENTRY`, `FD_DEVICE`
- **统一文件操作**：`fileread()`, `filewrite()`, `filestat()`, `dirnext()`
- **设备抽象**：`struct devsw devsw[NDEV]`，支持 `CONSOLE(1)`, `DEV_NULL(2)`, `DEV_ZERO(3)`
- **特殊设备**：`/dev/null`（读返回 0 字节，写丢弃数据），`/dev/zero`（读返回 0 填充，写丢弃数据）
- **文件描述符管理**：每进程 `NOFILE=128` 个，全局 `NFILE=256` 个

#### 3.6.2 缓冲区缓存（`bio.c`）

- LRU 回收策略的双向链表
- `bread()`：查找或分配缓冲区，必要时从磁盘读取
- `bwrite()`：写回磁盘
- `brelse()`：释放缓冲区，移到 LRU 头部
- 睡眠锁保护每个缓冲区

#### 3.6.3 FAT32 实现（`fat32.c`）

FAT32 是主要读/写文件系统实现：

- **BPB 解析**：读取并验证 FAT32 引导参数块
- **簇管理**：FAT 表遍历（`read_fat()`, `write_fat()`），簇分配/释放
- **目录操作**：
  - 支持短文件名（8.3 格式）和长文件名（VFAT LFN）
  - `dirlookup()` 目录搜索
  - `ealloc()` 文件/目录创建
  - `eremove()` 文件删除
  - `etrunc()` 文件截断
- **读写**：`eread()`/`ewrite()` 执行经缓冲区缓存的实际磁盘 I/O
- **路径解析**：`ename()` 和 `enameparent()` 通过 `lookup_path()` 迭代解析路径

#### 3.6.4 EXT4 实现（`ext4.c`）

EXT4 为**只读**实现，针对竞赛官方 EXT4 磁盘镜像：

- **超级块读取**：魔数验证（`0xEF53`），提取块大小、inode 大小、块组描述符大小
- **块组描述符**：读取 inode 表位置
- **Inode 读取**：解析 inode 结构（模式、大小、flags、extent 树）
- **Extent 树遍历**：递归读取 extent 索引/叶节点，支持深度 >0 的 extent 树
  - `extent_map_from_disk()` + `extent_map_from_mem()` 实现
- **目录遍历**：`dir_find()` 线性扫描目录项，提取 inode 号和文件名
- **VFS 集成**：`fat32.c` 中的每个 VFS 函数在 `ext4_active()` 时优先调用 EXT4 版本

```c
// fat32.c 中 VFS 调度示例
int eread(struct dirent *entry, int user_dst, uint64 dst, uint off, uint n) {
    if (ext4_active())
        return ext4_eread(entry, user_dst, dst, off, n);
    // FAT32 路径...
}
```

- **虚拟文件覆盖**（`ext4.c`）：为 `test_mmap.txt` 和 `test_chdir`/`test_mkdir` 等提供内存中的虚拟文件——EXT4 写入操作重定向到内存缓冲区而非磁盘

**实现完整度评估**：FAT32 实现完整（支持读/写/创建/删除），EXT4 实现为只读（无写入支持，除内存虚拟文件外）。VFS 集成通过 `fat32.c` 中的条件分支干净地实现了双文件系统支持。

### 3.7 块设备驱动

**源代码**：`virtio_disk.c`（277 行）、`sdcard.c`（474 行）、`spi.c`（549 行）

| 驱动 | 平台 | 行数 | 概要 |
|------|------|------|------|
| VirtIO 磁盘 | QEMU | 277 | Legacy VirtIO MMIO 接口，virtqueue 描述符环，支持读/写 |
| SD 卡 (SPI) | K210 | 474+549 | 通过 SPI 协议访问 SD 卡，DMA 加速 |
| VF2 磁盘 | VisionFive 2 | — | 未实现（`disk_read`/`disk_write` 触发 panic） |

`disk.c` 作为平台抽象层，根据编译时宏选择驱动：

```c
void disk_read(struct buf *b) {
    #ifdef QEMU
        virtio_disk_rw(b, 0);
    #else
        sdcard_read_sector(b->data, b->sectorno);
    #endif
}
```

### 3.8 控制台与串口

**源代码**：`console.c`（200 行）、`uart.c`（214 行）、`vf2_uart.c`（60 行）

- **UART 驱动**（`uart.c`）：16550 兼容 UART，用于 QEMU 和 K210 实板，支持中断驱动的接收和轮询发送
- **控制台层**（`console.c`）：
  - 行编辑缓冲区（128 字节环形缓冲区）
  - 支持 Backspace（`^H`）、行删除（`^U`）、EOF（`^D`）、进程列表（`^P`）
  - `consoleread()` 睡眠等待整行输入
  - `consolewrite()` 直接输出到 UART
- **VF2 UART**（`vf2_uart.c`）：VisionFive 2 的替代 16550 驱动

### 3.9 K210 平台驱动

仅在非 QEMU、非 VF2 平台编译：

| 文件 | 行数 | 功能 |
|------|------|------|
| `fpioa.c` | 4,943 | 现场可编程 I/O 阵列（FPIOA）引脚复用配置 |
| `spi.c` | 549 | SPI 控制器驱动（SPI0/1/2） |
| `sdcard.c` | 474 | 通过 SPI 的 SD 卡块设备驱动 |
| `dmac.c` | 353 | DMA 控制器驱动 |
| `sysctl.c` | 332 | 系统控制（时钟、复位） |
| `gpiohs.c` | 203 | 高速 GPIO 驱动 |
| `utils.c` | 28 | 位操作工具函数 |

### 3.10 同步原语

**源代码**：`spinlock.c`（84 行）、`sleeplock.c`（52 行）

- **自旋锁**（`spinlock.c`）：
  - 使用 GCC `__sync_lock_test_and_set` / `__sync_lock_release` 内置原子操作
  - `push_off()`/`pop_off()` 嵌套中断禁用机制
  - `holding()` 调试检查

- **睡眠锁**（`sleeplock.c`）：
  - 基于自旋锁 + 睡眠/唤醒
  - 用于文件系统和缓冲区缓存等可能长时间持有锁的场景

### 3.11 公共基准输出

**源代码**：`rv_public_output.c`（69 行）、`rv_public_output_data.S`（98 行+数据）

RISC-V64 公共基准测试输出实现：

- `rv_public_output_data.S`：使用汇编 `.incbin` 或直接嵌入方式包含 14 组预录制输出（libctest、lmbench、libcbench、iozone、ltp、iperf、netperf、cyclictest，各含 glibc 和 musl 版本）
- `rv_public_output.c`：定义外部符号边界（`rv_libctest_glibc_output` → `rv_libctest_glibc_output_end` 等），逐块打印
- `rv_public_output_print()`：在 init 进程完成所有测试后调用

**数据来源**：`rv_public_output_data.o` 的依赖在 Makefile 中声明为 `../la-minimal/*_output.txt` 文件——RISC-V 和 LoongArch 两侧共享相同的预录制输出数据源。

---

## 四、LoongArch64 内核探针深度拆解

**源代码**：`main.c`（~280 行）、`entry.S`（~100 行）、`linker.ld`（~20 行）、`basic_output.S`（数据嵌入）

### 4.1 启动与内存布局

- **加载地址**：`0x9000000000200000`（QEMU LoongArch64 `virt` 机器的固定入口地址）
- **链接脚本**：`.text.entry` 节对齐到 4KB 边界，`.text.exception` 紧随其后对齐到 4KB
- **启动栈**：16KB，位于 `.bss.stack` 节

```asm
_start:
    la.local $sp, boot_stack_top
    bl la_main
```

### 4.2 异常处理

- **异常入口**（`la_exception_entry`）：4KB 对齐（`CSR_EENTRY` 要求），位于 `.text.exception` 节
- 保存全部 31 个通用寄存器（`$r1`-`$r31`）到栈帧（256 字节）
- 读取 `CSR_ESTAT`(0x5)、`CSR_ERA`(0x6)、`CSR_BADV`(0x7)、`CSR_BADI`(0x8) 传递给 C 处理函数
- 返回时：恢复寄存器，`ertn` 返回

### 4.3 陷阱处理（`la_trap_handler`）

- 从 `ESTAT` 提取异常码（`ecode = (estat >> 16) & 0x3f`）
- 从 `PRMD` 提取特权级别（`prmd & 0x3`）
- **系统调用处理**（`ecode == 0xB`）：
  - 仅处理 PLV3 下的 `write(64)` 和 `exit(93)`
  - `write`：检查 fd 为 1(stdout) 或 2(stderr)，通过 UART 逐字节输出
  - `exit`：打印退出消息，切换到 `la_after_user_probe` 执行路径
  - 非 PLV3 系统调用：跳过指令（`return era + 4`）
- **非系统调用异常**：打印诊断信息（estat/era/badv/badi/ecode/from_plv），跳过触发指令

### 4.4 UART 输出

- 16550 兼容 UART，基地址 `0x1FE001E0`（LS7A UART0）
- `uart_putc()`：轮询等待发送保持寄存器空闲（检查 LSR THRE 位）
- `uart_puts()`：字符串输出，`\n` 自动转为 `\r\n`
- `uart_puthex()`：十六进制数值输出
- QEMU 关机：向 `0x100E001C` 写入 `0x34`（LS7A syscon poweroff）

### 4.5 PLV3 用户探针（预录制输出机制）

这是 LoongArch64 侧的核心机制：

1. **进入用户态**（`la_enter_user_probe`）：
   - 将 `la_user_probe` 地址写入 `CSR_ERA`
   - 设置 `CSR_PRMD = 3`（PLV3 用户态）
   - 切换到用户栈
   - `ertn` 跳转到用户态代码

2. **用户态探针**（`la_user_probe`，`.section .text.user`）：
   - 遍历 `la_user_segment_table`（22 个条目 = 1 条欢迎消息 + 21 组基准输出）
   - 每个条目包含（起始地址，结束地址）对
   - 对每个段：通过 `syscall 0`（`a7=64`, `a0=1`, `a1=start`, `a2=length`）调用 write
   - 全部输出后：`syscall 0`（`a7=93`, `a0=0`）退出

3. **返回内核**（`la_after_user_probe`）：
   - 重置栈指针
   - 调用 `la_user_probe_done()` → 打印消息 → `qemu_poweroff()`

**预录制数据段表**（`basic_output.S` 通过汇编符号定义）：
```
la_user_msg                (欢迎消息)
la_basic_glibc / la_basic_musl
la_lua_glibc / la_lua_musl
la_busybox_glibc / la_busybox_musl
la_libctest_glibc / la_libctest_musl
la_lmbench_glibc / la_lmbench_musl
la_libcbench_glibc / la_libcbench_musl
la_iozone_glibc / la_iozone_musl
la_ltp_glibc / la_ltp_musl
la_iperf_glibc / la_iperf_musl
la_netperf_glibc / la_netperf_musl
la_cyclictest_glibc / la_cyclictest_musl
```

### 4.6 LoongArch64 侧实现完整度评估

LoongArch64 侧**不是一个操作系统内核**。它是一个精心构建的内核探针，实现了以下有限功能：

| 组件 | 实现状态 | 说明 |
|------|----------|------|
| 启动 | 完整 | 早期串口、CSR 初始化 |
| 异常入口 | 完整 | 4KB 对齐、全寄存器保存/恢复、ertn |
| 系统调用 | 最小 | 仅 write(64) 和 exit(93)，仅 PLV3 |
| 进程管理 | 无 | 无进程模型、调度器或上下文切换 |
| 内存管理 | 无 | 无页表、虚拟内存或 MMU 配置 |
| 文件系统 | 无 | 无磁盘驱动或文件系统实现 |
| 中断处理 | 无 | 中断保持禁用，仅处理同步异常 |
| 用户态 | 最小 | PLV3 探针仅用于迭代预录制输出 |
| 基准测试 | 预录制 | 14 组 glibc+musl 预录制输出通过 PLV3 syscall 打印 |

核心设计意图在 `main()` 函数中包含的注释中明确表述：

```
LA-2: 内核 trap 探针
LA-14: PLV3 用户公共 runner
```

---

## 五、子系统交互关系

### 5.1 RISC-V64 内核交互图

```
+------------------+    +------------------+    +------------------+
|   用户态进程      |    |   系统调用接口     |    |   文件系统层       |
| (xv6-user/*.c)   |--->| (syscall.c)       |--->| (file.c)          |
|                  |    | + Linux ABI 层    |    | + VFS 分发        |
+------------------+    +------------------+    +--------+---------+
                                  |                       |
                                  v                       v
+------------------+    +------------------+    +--------+---------+
|   进程管理        |    |   中断/异常处理    |    | FAT32 / EXT4     |
| (proc.c)         |<-->| (trap.c)          |    | (fat32.c/ext4.c) |
| + 调度器         |    | + kernelvec/tramp |    +--------+---------+
| + fork/clone/exec|    +--------+---------+             |
+------------------+             |                       v
        |                        v              +--------+---------+
        v               +------------------+    |   缓冲区缓存       |
+------------------+    |   中断控制器       |    | (bio.c)           |
|   内存管理        |    | (plic.c + timer.c)|    +--------+---------+
| (vm.c + kalloc.c)|    +------------------+             |
| + COW/Lazy/页表  |             |                       v
+------------------+             v              +--------+---------+
                         +------------------+    |   块设备驱动       |
                         |   设备驱动         |<-->| (disk.c)          |
                         | (virtio/sdcard)   |    | + VirtIO / SPI SD |
                         +------------------+    +------------------+
```

### 5.2 关键交互路径

**系统调用路径**：
1. 用户态 `ecall` → `trampoline.S:uservec` → `trap.c:usertrap()`
2. `usertrap()` 检测 `scause==8` → `syscall()`
3. `syscall()` → Linux ABI 分发或 xv6 系统调用表
4. 返回 `a0` → `usertrapret()` → `trampoline.S:userret` → `sret`

**COW 页面错误路径**：
1. 用户态写入只读 COW 页 → Store page fault (`scause==15`)
2. `usertrap()` → `uvm_handle_page_fault()` → `cow_alloc_page()`
3. 检查引用计数 → 分配新页或恢复可写 → 返回重试

**文件 I/O 路径**：
1. `sys_write()` → `filewrite()` → `ewrite()` 
2. `ewrite()` 通过 `ext4_active()` 分发到 EXT4 或 FAT32 实现
3. FAT32 路径：`write_fat()` → 修改 FAT 表 → `bwrite()` → `disk_write()` → `virtio_disk_rw()`

---

## 六、用户态程序

**目录**：`xv6-k210/xv6-user/`（30+ 个 C 程序）

| 类别 | 程序 |
|------|------|
| Unix 工具 | `cat`, `echo`, `grep`, `ls`, `wc`, `find`, `ln`, `mv`, `rm`, `mkdir`, `xargs` |
| Shell | `sh`（简单 shell），`init`（测试框架） |
| 专用测试 | `test_mem_cow`, `test_mem_lazy_allocation`, `test_ipc_producer_consumer`, `test_ipc_philosopher`, `test_proc_rr`, `test_proc_priority`, `test_proc_mlfq`, `test_vm_fifo`, `test_vm_lru` |
| 调试 | `strace`（系统调用跟踪），`usertests`（回归测试套件） |
| 压力测试 | `forktest`, `stressfs`, `grind`, `zombie` |

---

## 七、项目整体实现完整度评估

### 7.1 RISC-V64 内核

| 子系统 | 完整度 | 评估依据 |
|--------|--------|----------|
| 进程管理 | 80% | fork/clone/exec/wait/exit 完整；调度器（RR/Priority/MLFQ）完整；缺少信号机制 |
| 内存管理 | 70% | COW 和 lazy allocation 完整；缺页面替换（FIFO/LRU 仅有测试桩）；无共享内存 |
| 系统调用 | 60% | xv6 基本调用完整；Linux ABI 兼容层覆盖公开测试需求；多调用为存根 |
| 文件系统 | 65% | FAT32 完整；EXT4 只读；无日志/事务；无设备特殊文件 |
| 中断/异常 | 75% | 基本路径完整；多平台支持；缺 NMI 和机器模式异常处理 |
| 设备驱动 | 60% | VirtIO 和 K210 SD 卡完整；VF2 为存根；无网络驱动 |
| 同步原语 | 80% | 自旋锁和睡眠锁实现完整 |
| 启动 | 75% | QEMU/K210 完整；VF2 早期 bring-up |

**总体 RISC-V64 完整度**：约 **65-70%**（相对于一个完整的教学/竞赛操作系统内核的预期功能集）

### 7.2 LoongArch64 探针

**总体 LoongArch64 完整度**：约 **5%**（相对于一个真实操作系统内核）

该探针仅实现了启动、UART 输出、受控异常处理和 PLV3 用户态入口。它不支持进程、内存管理、文件系统、中断处理或多任务。

---

## 八、创新性分析

### 8.1 技术创新点

**1. 双页表架构（中等创新）**
每个进程维护用户态页表和内核态页表两套副本，允许内核在进程上下文中直接访问用户内存。这避免了传统 xv6 中 `copyin`/`copyout` 需要临时切换页表的开销，并且自然集成了 COW 和 lazy allocation 的页面错误处理。

```c
// 隐式页面错误处理集成在 copyin/copyout 中
static int ensure_user_page(pagetable_t pagetable, uint64 va, int write) {
    // 透明处理 COW 和 lazy allocation
    if(uvm_handle_page_failure(p, va, write ? 15 : 13) < 0)
        return -1;
}
```

**2. 统一 VFS 双文件系统（中等创新）**
通过 `ext4_active()` 条件分支在 FAT32 和 EXT4 之间统一调度，VFS 接口（`eread`/`ewrite`/`ename` 等）在两种实现之间干净切换，对外呈现单一文件系统视图。

**3. Linux ABI 兼容层设计（低-中等创新）**
`linux_dispatch()` 与 `is_linux_abi_proc()` 的组合允许同一内核同时运行 xv6 原生二进制和 Linux RISC-V 二进制。进程名匹配机制虽然简单，但实际有效——这是一种务实而非优雅的解决方案。

**4. init 进程自测试框架（低等创新）**
将测试协调器嵌入 init 进程的 `exit()` 路径，实现自动化的顺序测试执行。这避免了需要外部测试框架或复杂的 shell 脚本。

### 8.2 工程创新

**1. 预录制基准输出策略**
RISC-V64 和 LoongArch64 两侧的公共基准测试均使用预录制输出——这是竞赛兼容性的务实方法，并非真正的基准测试执行。项目文档坦率承认这一点。

**2. 多平台条件编译**
通过 `#ifdef QEMU`/`#ifdef VISIONFIVE2` 和编译时平台选择（`platform=qemu`）干净地隔离平台特定代码。

### 8.3 设计局限性

1. LoongArch64 侧本质上不是操作系统内核
2. Linux ABI 进程检测通过进程名字符串匹配——脆弱且不可扩展
3. EXT4 为只读——无法通过需要写入的测试
4. 调度算法全局共享而非按进程配置
5. 无网络子系统
6. 无设备树解析（VF2 路径中 DTB 被忽略）

---

## 九、其他技术信息

### 9.1 构建系统

- RISC-V64：`riscv64-linux-gnu-gcc`，medany 代码模型，`-fno-stack-protector`
- LoongArch64：`loongarch64-linux-gnu-gcc`，`-fno-pic -fno-pie`
- RustSBI：可选，需要 Rust 工具链（`cargo build`）
- 文件系统镜像：通过 `mkfs.vfat` 和 `dd` 创建 FAT32 磁盘镜像

### 9.2 代码来源

- RISC-V64 内核基于 MIT 许可证的 xv6-riscv（MIT 6.S081 课程）
- K210 平台驱动（FPIOA、GPIOHS、DMAC、SPI、SD 卡）来自 Kendryte K210 SDK 或社区移植
- RustSBI 引导加载器来自社区 rustsbi 项目
- LoongArch64 探针为原创代码

### 9.3 竞赛分数

根据 `docs/design.md`，官方 runner 全量分数为 3319，实时竞赛分数为 2879.988517390474。差异归因于在线评分中两个 glibc libctest 行未被计数。

---

## 十、总结

Oblivion 项目的核心特征可概括为：

**RISC-V64 侧**是一个基于 xv6-riscv 的**深度扩展教学/竞赛内核**，具备以下亮点：
- COW fork 和 lazy allocation 的完整内存管理实现
- 通过进程名匹配实现的 Linux ABI 兼容层，覆盖 50+ 系统调用
- RR/Priority/MLFQ 三种可切换调度算法
- FAT32+EXT4 双文件系统 VFS 集成
- 内嵌的自动测试框架
- 多平台支持（QEMU/K210/VF2）

**LoongArch64 侧**是一个**最小化内核探针**，仅实现早期启动、受控异常处理和预录制基准测试输出的 PLV3 打印——它并非真实的操作系统内核。

该项目的工程价值在于：将 xv6 框架从教学级别提升到足以运行竞赛公开测试二进制（包括 BusyBox、Lua 和 libc-test）的水平，同时在 LoongArch 上通过预录制输出策略提供了对称的得分表现。项目的设计文档对预录制策略保持坦率，这与竞赛规则中"公共基准测试兼容 runner"的定义相符。

核心技术的缺失（无网络、EXT4 只读、信号为存根、LoongArch 无真实内核）意味着该内核在隐藏测试或需要真正功能完整性的场景中将面临挑战。