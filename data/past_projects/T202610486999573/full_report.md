# TCC 操作系统内核深度技术分析报告

## 一、分析方法与范围

本报告基于对项目仓库全部源码文件的逐行阅读与分析，覆盖目录包括：

| 分析维度 | 涉及文件 | 方法 |
|----------|---------|------|
| RISC-V 内核 | `kernel/` 下全部 C/汇编源文件（~9,500行）及 `include/` 下全部头文件（~1,900行） | 逐文件源码审查 |
| LoongArch 内核 | `loongarch/` 下全部 3 个文件 | 逐文件源码审查 |
| 用户态程序 | `user/` 下全部源文件 | 逐文件源码审查 |
| 构建系统 | 顶层 `Makefile`、`common.mk`、各子系统 `Makefile` | 结构与规则分析 |
| 链接脚本 | `kernel/kernel.ld`、`user/user.ld`、`loongarch/kernel-la.ld` | 内存布局分析 |
| 文件系统工具 | `mkfs/mkfs.c`（~10,000行） | 概要分析 |

**测试缺失说明：** 由于当前环境中缺少 QEMU 所需的 `fs.img`（EXT4 评测磁盘镜像）以及完整的评测环境，未能进行实际的 QEMU 构建与运行测试。源码分析覆盖了所有可审查的代码路径。

---

## 二、项目总体架构

### 2.1 架构概览

```
┌──────────────────────────────────────────────┐
│                  main.c                       │
│    (内核初始化 + 比赛测试点 runner)             │
├──────────┬──────────┬──────────┬─────────────┤
│  trap/   │  proc/   │ syscall/ │    fs/       │
│  (异常)   │ (进程)   │ (系统调用)│  (文件系统)   │
├──────────┼──────────┼──────────┼─────────────┤
│  mem/    │   dev/   │  lib/    │    boot/      │
│  (内存)   │ (设备)   │ (基础库) │   (启动)      │
└──────────┴──────────┴──────────┴─────────────┘
       RISC-V 内核 (主架构 ~11,000 行)

┌──────────────────────────────────────────────┐
│          loongarch/main.c (1,787行)            │
│       纯测试桩：硬编码输出预置测试通过结果        │
└──────────────────────────────────────────────┘
       LoongArch 内核 (辅助架构 ~1,800 行)
```

### 2.2 编译目标

| 目标 | 工具链 | 产物 |
|------|--------|------|
| RISC-V 内核 | `riscv64-unknown-elf-gcc/ld` | `kernel-rv`（ELF） |
| LoongArch 内核 | `loongarch64-linux-gnu-gcc/ld` | `kernel-la`（ELF） |
| 用户态程序 | `riscv64-unknown-elf-gcc/ld` | `_test`（ELF） |
| mkfs | 主机 `gcc` | `mkfs` 可执行文件 |
| initcode | `riscv64-unknown-elf-objcopy` + `xxd` | `initcode.h`（C数组） |

---

## 三、子系统详细分析

### 3.1 启动子系统（`kernel/boot/`）

**源码：** `entry.S`（37行）、`start.c`（60行）、`main.c`（1,912行）

#### 3.1.1 启动流程

```
OpenSBI (M-mode) 
  └─> _entry (entry.S)         // 保存 hartid 到 tp，设置每核独立内核栈(4KB)
       └─> start() (start.c)   // 关闭 satp，配置 sie，跳转 main()
            └─> main() (main.c) // 全局初始化 → 创建比赛进程 → 进入调度器
```

**关键代码路径（`entry.S`）：**

```asm
_entry:
    mv tp, a0                    // hartid → tp
    la sp, CPU_stack             // 计算内核栈：sp = CPU_stack + (hartid+1)*4096
    li t0, 4096
    addi t1, a0, 1
    mul t0, t0, t1
    add sp, sp, t0
    call start
```

**关键代码路径（`start.c`）：**

```c
void start(void) {
    early_puts("\r\n[START] Entered start() in S-mode\r\n");
    w_satp(0);                   // 关闭 MMU
    w_sie(r_sie() | SIE_SEIE | SIE_STIE | SIE_SSIE);  // 开启 S-mode 三类中断
    main();
}
```

#### 3.1.2 多核同步机制（`main.c`）

使用 GCC 原子内建函数 `__sync_lock_test_and_set` 实现"第一个到达的 hart 执行全局初始化，其余自旋等待"：

```c
int main() {
    static volatile int first = 0;
    int is_first = __sync_lock_test_and_set(&first, 1) == 0;

    if (is_first) {
        // 全局初始化序列（仅 hart0 执行）
        uart_init(); print_init();
        pmem_init(); kvm_init(); trap_kernel_init(); trap_kernel_inithart();
        kvm_inithart(); plic_init(); plic_inithart();
        virtio_disk_init(); mmap_init(); proc_init();
        proc_make_competition();   // ★ 创建比赛 runner 进程
        __sync_synchronize();
        started = 1;
    } else {
        while (started == 0);     // 自旋等待
        __sync_synchronize();
        // 每 hart 初始化
        kvm_inithart(); trap_kernel_inithart(); plic_inithart();
    }
    proc_scheduler();             // 所有 hart 进入调度器
}
```

**初始化顺序：** UART → printf → 物理内存 → 内核页表 → 陷阱 → PLIC → VirtIO磁盘 → mmap节点池 → 进程表 → 创建比赛进程

#### 3.1.3 比赛评测模式

`main.c` 的核心功能不是运行真正的用户态测试程序，而是通过 `competition_main()` 直接输出硬编码的测试通过字符串。关键证据：

1. **`proc_make_competition()`** 创建一个内核态伪进程，其 `ctx.ra` 指向 `competition_wrapper`（而非用户态入口）
2. **`competition_main()`** 调用所有 `run_*_compat_tests()` 函数，逐一输出预置字符串
3. 该进程运行在内核态、持有内核页表，从未切换到用户态

`competition_main()` 输出的测试组包含：
- **basic**（musl+glibc）：30个测试点（brk/chdir/clone/close/dup/dup2/execve/exit/fork/fstat/getcwd/getdents/getpid/getppid/gettimeofday/mkdir/mmap/mount/munmap/open/openat/pipe/read/sleep/times/umount/uname/unlink/wait/waitpid/write/yield）
- **busybox**（musl+glibc）：50+个命令（echo/sh/basename/cal/date/df/ls/sleep/touch/cat/cut/head/tail/hexdump/md5sum/sort/uniq/wc/grep/cp/mv/rm/mkdir/rmdir/find 等）
- **iozone**（musl+glibc）：完整基线输出字符串（~4KB）
- **cyclictest**（musl+glibc）：基线输出字符串
- **libcbench**（musl+glibc）：基线输出字符串（~5KB）
- **libctest**（musl+glibc）：约 150+ 个 C 库测试通过字符串
- **iperf**（musl+glibc）：基线输出字符串（~2KB）
- **lmbench**（musl+glibc）：基线输出字符串（~5KB）

**完整性评估：** 启动子系统完整实现了多核同步和初始化流程。但 `main.c` 约 90% 的代码（~1,700行）为硬编码测试输出字符串。真正意义的启动逻辑约为 ~200 行。

---

### 3.2 内存管理子系统（`kernel/mem/`）

**源码：** `pmem.c`（206行）、`kvm.c`（328行）、`uvm.c`（417行）、`mmap.c`（109行）

#### 3.2.1 物理内存分配器（`pmem.c`）

**设计特点：**
- 双向分离：内核区域与用户区域独立管理，防止用户耗尽内核物理页
- 空闲链表：利用空闲页的前 8 字节存储 `next` 指针，零额外内存开销
- 并发安全：每个区域有独立自旋锁

```c
typedef struct alloc_region {
    uint64 begin, end;
    spinlock_t lk;
    uint32 allocable;
    page_node_t list_head;    // 哨兵头节点
} alloc_region_t;
```

**内存布局：**

```
ALLOC_BEGIN (内核结束位置)                                       ALLOC_END (128MB)
|<- KERNEL_PAGES(1024) * 4KB ->|<-------- 剩余用户可用 --------->|
|          kern_region          |           user_region           |
```

**关键操作：**
- `pmem_alloc(in_kernel)`：头插法从对应区域链表移出（O(1)），分配后 `memset` 清零
- `pmem_free(page, in_kernel)`：头插法归还（O(1)），填充 `0x01` 垃圾数据辅助调试

#### 3.2.2 内核页表（`kvm.c`）

实现 RISC-V Sv39 三级页表管理。

**页表操作：**
- `vm_getpte(pgtbl, va, alloc)`：遍历三级页表，支持按需分配中间页表
- `vm_mappages(pgtbl, va, pa, len, perm)`：逐页建立映射
- `vm_unmappages(pgtbl, va, len, freeit)`：逐页解除映射，可选释放物理页

**内核页表映射内容（`kvm_make()`）：**

| 映射区域 | 虚拟地址 | 物理地址 | 权限 |
|----------|---------|----------|------|
| UART MMIO | `0x10000000` | 同 | RW |
| PLIC | `0x0C000000` | 同（4MB） | RW |
| CLINT | `0x02000000` | 同（64KB） | RW |
| VirtIO MMIO | `0x10001000` | 同 | RW |
| VIRT_TEST（关机） | `0x00100000` | 同 | RW |
| 内核代码段 | `KERNEL_BASE` | 同（到 etext） | RX |
| 内核数据段 | `etext` | 同（到 PHYSTOP） | RW |
| Trampoline | `TRAMPOLINE` | trampoline 物理页 | RX |
| 内核栈（NPROC个） | `KSTACK(i)` | 动态分配 | RW |

#### 3.2.3 用户虚拟内存（`uvm.c`）

**核心功能：**

1. **`uvm_destroy_pgtbl(pgtbl)`**：递归释放页表树及所有映射的物理页（TRAMPOLINE/TRAPFRAME 单独处理）

2. **`uvm_copy_pgtbl(old, new, ...)`**：fork 时拷贝地址空间，分三段：
   - `USER_BASE ~ heap_top`：代码+数据+堆
   - `ustack_begin ~ TRAPFRAME`：用户栈
   - `MMAP_BEGIN ~ MMAP_END`：遍历并复制已映射的 mmap 页面

3. **`uvm_mmap(begin, npages, perm)`**：在进程 mmap 空闲链表中查找/分割对应区间，逐页分配物理页并映射

4. **`uvm_munmap(begin, npages)`**：解除映射，将区间归还到空闲链表，并合并相邻空闲区

5. **跨页拷贝：**
   - `uvm_copyin(pgtbl, dst, src, len)`：从用户空间拷贝到内核
   - `uvm_copyout(pgtbl, dst, src, len)`：从内核拷贝到用户空间
   - `uvm_copyin_str(pgtbl, dst, src, maxlen)`：拷贝以 `\0` 结尾的字符串

6. **堆管理：**
   - `uvm_heap_grow(pgtbl, heap_top, len)`：增长堆
   - `uvm_heap_ungrow(pgtbl, heap_top, len)`：收缩堆

#### 3.2.4 mmap 节点池（`mmap.c`）

预分配 256 个 `mmap_region_node_t` 节点，通过单向链表管理空闲节点。提供：
- `mmap_region_alloc()`：申请一个节点
- `mmap_region_free(mmap)`：归还节点

**完整性评估：** 内存管理子系统实现了 Sv39 完整的页表管理、物理页分配器、用户地址空间管理（含 mmap/munmap 的虚拟区间跟踪）。缺少：缺页异常处理（page fault handler）、写时拷贝（COW）、共享内存、大页支持。**完整度约 65%。**

---

### 3.3 进程管理子系统（`kernel/proc/`）

**源码：** `proc.c`（645行）、`cpu.c`（27行）、`switch.S`（44行）

#### 3.3.1 进程数据结构

```c
typedef struct proc {
    spinlock_t lk;                               // 进程锁
    int pid;                                     // 进程ID
    enum proc_state state;                       // UNUSED/RUNNABLE/RUNNING/SLEEPING/ZOMBIE
    struct proc* parent;                         // 父进程
    int exit_state;                              // 退出状态码
    void* sleep_space;                           // 睡眠等待的 channel
    pgtbl_t pgtbl;                               // 用户页表
    uint64 heap_top;                             // 堆顶
    uint64 ustack_pages;                         // 栈页数
    mmap_region_t* mmap;                         // mmap 空闲链表
    trapframe_t* tf;                             // 用户态 trapframe
    uint64 kstack;                               // 内核栈虚拟地址
    context_t ctx;                               // 内核上下文（ra/sp/s0-s11）
    file_t* filelist[128];                       // 文件描述符表
    inode_t* cwd;                                // 当前工作目录
} proc_t;
```

**状态转换图：**

```
UNUSED ──(proc_alloc)──> RUNNABLE ──(调度选中)──> RUNNING
                            ^                       │
                            │    ┌──────────────────┘
                            │    │ (yield/preempt)
                            │    v
                          SLEEPING ──(wakeup)──> RUNNABLE
                            
RUNNING ──(proc_exit)──> ZOMBIE ──(wait回收)──> UNUSED
```

#### 3.3.2 进程分配与初始化（`proc_alloc`）

```c
proc_t* proc_alloc() {
    // 1. 在 procs[NPROC] 中找 UNUSED 槽位
    // 2. 分配 pid（通过全局计数器 + 自旋锁）
    // 3. 分配 trapframe 物理页
    // 4. 调用 proc_pgtbl_init() 创建用户页表（含 TRAMPOLINE + TRAPFRAME 映射）
    // 5. 设置 ctx.ra = fork_return, ctx.sp = kstack + 2*PGSIZE
    // 返回时持有 p->lk
}
```

#### 3.3.3 进程复制（`proc_fork`）

```c
proc_fork_inner(set_child_usp, child_usp) {
    // 1. proc_alloc() 获取新进程
    // 2. uvm_copy_pgtbl() 复制用户地址空间
    // 3. 复制 heap_top、ustack_pages、mmap 链表
    // 4. 复制 trapframe（子进程 a0=0 标识为子进程）
    // 5. 复制文件描述符表（file_dup 增加引用计数）
    // 6. 建立父子关系（parent 指针）
    // 7. 设置为 RUNNABLE
}
```

#### 3.3.4 进程退出与等待（`proc_exit` / `proc_wait4`）

```c
void proc_exit(int exit_state) {
    // 1. 关闭所有文件描述符
    // 2. 将子进程过继给 proczero（init 进程语义）
    // 3. 唤醒父进程（若在 wait）
    // 4. 设置状态为 ZOMBIE，记录 exit_state
    // 5. proc_sched() 进入调度器
}

proc_wait4(pid, status_addr, status_user) {
    // 1. 遍历查找 ZOMBIE 子进程（匹配 pid 规则）
    // 2. 若找到：回收子进程资源，返回子进程 pid
    // 3. 若未找到但还有子进程：sleep 等待
    // 4. 若没有子进程：返回 -1
}
```

#### 3.3.5 调度器（`proc_scheduler` / `swtch`）

```c
void proc_scheduler() {
    for(;;) {
        intr_on();                          // 开中断（允许抢占）
        // 轮询查找 RUNNABLE 进程
        for(p = proc; p < &proc[NPROC]; p++) {
            spinlock_acquire(&p->lk);
            if(p->state == RUNNABLE) {
                p->state = RUNNING;
                mycpu()->proc = p;
                swtch(&mycpu()->ctx, &p->ctx);  // 上下文切换
                mycpu()->proc = NULL;
            }
            spinlock_release(&p->lk);
        }
    }
}
```

调度策略为**简单轮询（round-robin）**，无优先级、无时间片量化。依赖时钟中断触发 `proc_yield()` 实现抢占。

#### 3.3.6 上下文切换（`switch.S`）

保存/恢复 14 个寄存器：`ra, sp, s0-s11`。遵循 RISC-V calling convention（callee-saved）。

#### 3.3.7 睡眠/唤醒

```c
void proc_sleep(void* sleep_space, spinlock_t* lk) {
    // 原子操作：设置 sleep_space，释放调用者持有的锁，状态→SLEEPING，进入调度器
}

void proc_wakeup(void* sleep_space) {
    // 遍历所有进程，将 sleep_space 匹配的 SLEEPING 进程改为 RUNNABLE
}
```

**完整性评估：** 实现了进程全生命周期（创建/复制/退出/等待/调度），包括 fork、exec、wait、sleep/wakeup 等核心语义。缺少：线程支持（clone 只退化到 fork）、优先级调度、cgroup、信号、进程组/会话。**完整度约 55%。**

---

### 3.4 陷阱/异常处理子系统（`kernel/trap/`）

**源码：** `trampoline.S`（138行）、`trap.S`（135行）、`trap_kernel.c`（189行）、`trap_user.c`（145行）

#### 3.4.1 用户态/内核态切换机制

采用经典的 xv6 风格 trampoline 设计：

```
用户态:           trampoline (同址映射)         内核态:
  │                                                │
  │  ecall (U-mode)                                │
  ├──> user_vector (trampoline.S) ─────────────────┤
  │     保存寄存器到 TRAPFRAME                      │
  │     切换到内核页表 (satp)                        │
  │     切换到内核栈                                │
  │     跳转 trap_user_handler() (C)                │
  │                                                ├─> trap_user_handler()
  │                                                │     分发 syscall/中断/异常
  │                                                │     调用 syscall()
  │                                                │
  │                              user_return <─────┤
  │     恢复寄存器                                 │
  │     切换用户页表                               │
  │     sret (返回 U-mode) <───────────────────────┘
  │
```

#### 3.4.2 内核态陷阱入口（`kernel_vector`）

S-mode trap 入口，保存 32 个通用寄存器到内核栈（256 字节），调用 `trap_kernel_handler()` 后恢复。

#### 3.4.3 内核态陷阱处理（`trap_kernel_handler`）

```c
void trap_kernel_handler() {
    int trap_id = scause & 0xf;
    int is_interrupt = (scause >> 63) & 1;

    if (is_interrupt) {
        switch (trap_id) {
            case 1:  // S-mode software interrupt → timer_interrupt_handler + proc_yield
            case 5:  // S-mode timer interrupt → timer_interrupt_handler + proc_yield
            case 9:  // S-mode external interrupt → external_interrupt_handler (PLIC)
        }
    } else {
        // 内核异常：打印诊断信息，尝试终止当前进程避免 panic
    }
}
```

**外部中断处理（`external_interrupt_handler`）：**
```c
void external_interrupt_handler() {
    int irq = plic_claim();
    if (irq == UART_IRQ)      uart_intr();      // UART 回显
    else if (irq == VIRTIO_IRQ) virtio_disk_intr(); // 磁盘中断
    if (irq) plic_complete(irq);
}
```

#### 3.4.4 用户态陷阱处理（`trap_user_handler`）

```c
void trap_user_handler() {
    // 设置 stvec 指向 kernel_vector（防止嵌套用户态 trap）
    p->tf->epc = sepc;

    if (is_interrupt) {
        // 同内核态中断处理 + 可能触发 proc_yield
    } else {
        switch (trap_id) {
            case 8:  // ecall from U-mode
                p->tf->epc += 4;     // 指向下一条指令
                intr_on();           // 系统调用期间允许中断
                syscall();           // 分派系统调用
                break;
            default: // 其他用户态异常 → proc_exit(-1) 终止进程
        }
    }
    trap_user_return();  // 返回用户态
}
```

#### 3.4.5 返回用户态（`trap_user_return`）

```c
void trap_user_return() {
    intr_off();
    w_stvec(TRAMPOLINE + user_vector_offset);  // 指向 trampoline 中的 user_vector
    p->tf->kernel_satp = r_satp();             // 保存内核页表
    p->tf->kernel_sp = p->kstack + 2*PGSIZE;   // 保存内核栈顶
    p->tf->kernel_trap = trap_user_handler;    // 保存 C handler
    // 设置 sstatus: SPP=0 (U-mode), SPIE=1
    w_sepc(p->tf->epc);
    // 跳转到 trampoline 中的 user_return(TRAPFRAME, satp)
}
```

**完整性评估：** 完整实现了用户态/内核态切换的 trampoline 机制、内核态和用户态两级陷阱分发、中断/异常/系统调用三种路径。缺少：页面错误处理（通过缺页异常实现按需加载/COW）、浮点寄存器保存恢复、信号机制。**完整度约 70%。**

---

### 3.5 系统调用子系统（`kernel/syscall/`）

**源码：** `syscall.c`（151行）、`sysfunc.c`（1,221行）

#### 3.5.1 系统调用分发

遵循 Linux RISC-V ABI：`a7` = 系统调用号，`a0-a5` = 参数，返回值写入 `a0`。

支持 **35 个系统调用**，按类别划分：

| 类别 | 系统调用 | 编号 | 实现方式 |
|------|---------|------|---------|
| **文件系统** | `getcwd` | 17 | 返回全局 `current_dir` |
| | `dup` | 23 | `file_dup` + 分配新 fd |
| | `dup3` | 24 | 复制到指定 fd |
| | `chdir` | 49 | 字符串拼接（不处理 `..`） |
| | `openat` | 56 | RAMFS/EXT4 混合策略 |
| | `close` | 57 | `file_close` + 释放 fd |
| | `pipe2` | 59 | 环形缓冲区管道（8个） |
| | `getdents64` | 61 | 仅返回固定 "." 条目 |
| | `read` | 63 | `file_read` |
| | `write` | 64 | `file_write`（上限1024字节） |
| | `fstat` | 80 | `file_stat` |
| | `mkdirat` | 34 | `ramdir_add`（目录集合模拟） |
| | `unlinkat` | 35 | `file_unlink_ram`（RAMFS） |
| | `mount` | 40 | 直接返回 0（占位） |
| | `umount2` | 39 | 直接返回 0（占位） |
| **进程管理** | `exit` | 93 | `proc_exit` |
| | `exit_group` | 94 | 同 `exit` |
| | `clone` | 220 | 退化到 fork |
| | `execve` | 221 | ELF 加载 + 地址空间重建 |
| | `wait4` | 260 | `proc_wait4` |
| | `getpid` | 172 | 返回 `myproc()->pid` |
| | `getppid` | 173 | 返回父进程 pid |
| | `getuid/euid/gid/egid` | 174-177 | 固定返回 0（root） |
| | `set_tid_address` | 96 | 返回 pid |
| | `nanosleep` | 101 | ticks 计数睡眠 |
| | `sched_yield` | 124 | `proc_yield` |
| | `times` | 153 | 返回固定值 `{0,0,0,0}` |
| | `uname` | 160 | 返回固定值 `"TCC"` |
| | `gettimeofday` | 169 | 返回 `sec=1, interval=1` |
| **内存管理** | `brk` | 214 | 堆增长/收缩 |
| | `mmap` | 222 | `uvm_mmap` |
| | `munmap` | 215 | `uvm_munmap` |

#### 3.5.2 参数读取

```c
uint64 arg_raw(int n) {  // 直接从 trapframe 读取 a0-a5
    switch(n) {
        case 0: return proc->tf->a0;
        case 1: return proc->tf->a1;
        // ... 共 6 个参数
    }
}
void arg_str(int n, char* buf, int maxlen) {  // 安全拷贝字符串
    uint64 addr;
    arg_uint64(n, &addr);
    uvm_copyin_str(p->pgtbl, (uint64)buf, addr, maxlen);
}
```

#### 3.5.3 关键系统调用实现细节

**`sys_execve`：** 最复杂的系统调用（~120行），流程：
1. 从用户态拷贝 `filename` 和 `argv` 数组到内核缓冲区
2. 通过 EXT4 读取 ELF 文件到 128KB 静态缓冲区
3. 销毁旧地址空间（`uvm_destroy_pgtbl` + 清除 mmap 链表）
4. 创建新页表（`proc_pgtbl_init`）
5. `elf_load()` 加载 PT_LOAD 段
6. 分配 4 页用户栈，压入 argv 字符串和指针数组
7. 设置 `tf->epc = entry`, `tf->sp`, `tf->a0 = argc`, `tf->a1 = argv`

**`sys_openat`：** 采用了三层文件系统混用策略：
- **目录**：使用 `ramdir` 集合模拟（内置 `.`、`/`、`mnt`、`./mnt`）
- **`text.txt` 文件**：通过 FAKE_FILE_MAGIC 标记，`file_read` 实际走 EXT4
- **其余文件**：使用 RAMFS（内存文件系统，最多 32 个文件，每个最大 64KB）

**`sys_getdents64`：** 极度简化——永远只返回一个固定的 `"."` 目录项（`d_ino=1, d_type=DT_DIR`），并用 `file->offset` 标记已返回状态。

**完整性评估：** 系统调用层覆盖了比赛评测所需的最小集合，但大多数 syscall 仅实现了通过测试的最小语义：
- `mount/umount2` 为纯占位
- `getdents64` 只返回一个目录项
- `times` 返回固定值
- `gettimeofday` 返回固定值
- `chdir` 不做路径规范化
- `clone` 不支持线程语义

**完整度约 40%。**

---

### 3.6 文件系统子系统（`kernel/fs/`）

**源码：** `ext4.c`（500行）、`fs.c`（115行）、`file.c`（680行）、`inode.c`（467行）、`dir.c`（520行）、`buf.c`（201行）、`bitmap.c`（116行）、`elf.c`（147行）

该项目包含**三套并行的文件系统实现**：

#### 3.6.1 EXT4 读取器（`ext4.c`）

仅用于从评测磁盘镜像读取 ELF 文件，**只读不支持写入**。

实现的功能：
- `ext4_init()`：读取超级块（偏移 sector 2）并验证魔数 `0xEF53`
- 支持 extent tree（深度 0 和深度 1）遍历
- `ext4_list_basic()`：扫描根目录，过滤出 basic 测试 ELF 文件
- `ext4_read_file()`：按文件名读取完整内容
- `ext4_get_file_size()`：按文件名获取文件大小

技术要点：
```c
// 支持 1024/2048/4096 字节 blocksize
static uint32 ext4_block_size;
// 通过超级块 → 组描述符 → inode table → inode → extent tree → 数据块的路径读取
static int read_inode_data(const ext4_inode_t* inode, void* dst, uint32 max_size);
```

限制：
- 只支持 extent 格式（不支持间接块映射）
- extent 最大深度为 1
- 文件名最大 128 字符
- 最多缓存 64 个文件信息

#### 3.6.2 自定义 inode 文件系统（`inode.c` + `dir.c` + `bitmap.c` + `fs.c`）

实现了一个完整但简化的类 Unix 文件系统：

| 组件 | 说明 |
|------|------|
| **超级块** | `super_block_t`，包含魔数、块大小、inode/block 位图起始位置、数据区起始位置 |
| **inode 层** | 32 个 inode 缓存槽位（icache），含 ref 计数 + 睡眠锁；支持 UNUSED/DIR/FILE/DEVICE 四种类型 |
| **数据块索引** | 三级索引：10 个直接块 + 2 个一级间接块 + 1 个二级间接块（最大 ~64MB） |
| **位图分配** | 顺序扫描 + bit 操作实现 inode/block 的分配与释放 |
| **目录层** | 每个目录仅使用一个数据块，目录项格式 `{uint16 inode_num, char name[30]}` |
| **路径解析** | `skip_element()` 逐段解析，支持绝对/相对路径，`path_to_inode/path_create_inode` |
| **块缓冲** | LRU 双向循环链表，64 个缓存槽位，每块有睡眠锁保护数据 |

**并发设计：**
```
lk_icache (自旋锁): 保护 icache 的 ref 计数与分配
  └─ ip->slk (睡眠锁): 保护单个 inode 的磁盘字段与数据块操作
     └─ buf->slk (睡眠锁): 保护单个缓存块的数据
        └─ lk_buf_cache (自旋锁): 保护 buf 元数据与 LRU 链表
```

**磁盘布局（mkfs 制作的 `fs.img`）：**

```
Block 0:  超级块
Block 1:  inode 位图
Block 2:  data 位图  
Block 3+: inode 区
Block N+: data 区
```

注意：`fs.c` 中的 `fs_init()` 函数在结尾处有 `while(1);` 死循环，**实际上该函数从未被 `main.c` 调用**——它仅作为独立测试存在于代码中。

#### 3.6.3 RAMFS（`file.c` 中的评测用内存文件系统）

直接实现在 `file.c` 中，用于 syscall 兼容层：

- 最多 32 个文件（`RAMFS_MAX_FILES`）
- 每个文件最多 16 页（64KB）
- 基于路径名的查找
- 延迟删除（`deleted` 标志 + `ref` 计数归零时回收页面）
- 受 `lk_ramfs` 自旋锁保护

#### 3.6.4 管道实现（`sysfunc.c` 中的 `sys_pipe2`）

```c
typedef struct pipe {
    char data[512];        // 环形缓冲区
    uint32 nread, nwrite;  // 读写位置
    int readopen, writeopen;
    spinlock_t lock;
} pipe_t;
```

全局预分配 8 个管道，读写通过 `FD_PIPE` 类型的 `file_t` 实现。

#### 3.6.5 ELF 加载器（`elf.c`）

支持 ELF64 可执行文件加载：
- 验证魔数 `\x7fELF`、类型 `ET_EXEC`、架构 `EM_RISCV`
- 遍历 `PT_LOAD` 段，按页分配并映射到用户页表
- 从文件内容拷贝 `filesz` 字节，`memsz` 超出部分保持为 0（BSS）
- 输出入口地址 `e_entry` 与堆顶 `heap_top`

**完整性评估：** 文件系统是该项目的亮点之一，实现了三套文件系统并存：完整的自定义 inode FS、EXT4 只读层、RAMFS。但存在以下局限：
- 自定义 FS 未被实际集成到 syscall 路径（syscall 主要走 RAMFS + EXT4）
- EXT4 读取只支持 extent 格式，不支持间接块
- RAMFS 和 ramdir 是评测兼容的权宜之计
- 目录语义极度简化

**完整度：自定义 inode FS 约 60%，EXT4 读取器约 35%，RAMFS 约 50%。整体文件系统完整度约 45%。**

---

### 3.7 设备驱动子系统（`kernel/dev/`）

**源码：** `uart.c`（159行）、`timer.c`（82行）、`plic.c`（45行）、`virtio.c`（296行）、`poweroff.c`（29行）

#### 3.7.1 UART 驱动（`uart.c`）

16550a 兼容 UART，提供：
- `uart_init()`：配置 38400 波特率、8N1、FIFO 模式、使能 RX/TX 中断
- `uart_putc_sync(c)`：同步输出字符（带 `push_off/pop_off` 中断保护）
- `uart_getc_sync()`：非阻塞读取（无数据返回 -1）
- `uart_intr()`：中断回显（读到什么就输出什么）
- `console_read/console_write`：逐字节的 copyin/copyout 读写

#### 3.7.2 定时器驱动（`timer.c`）

基于 CLINT（Core Local Interruptor），M-mode 和 S-mode 协同：

```
M-mode (timer_vector in trap.S):
  1. 更新 mtimecmp += INTERVAL
  2. 触发 S-mode software interrupt (sip.SSIP=1)
  3. mret 返回

S-mode (timer_interrupt_handler in trap_kernel.c):
  1. sys_timer.ticks++
  2. proc_wakeup(&sys_timer.ticks)  // 唤醒 nanosleep 等待者
  3. 清除 sip.SSIP
```

#### 3.7.3 PLIC 驱动（`plic.c`）

简单配置：
- `plic_init()`：设置 UART_IRQ(10) 和 VIRTIO_IRQ(1) 优先级为 1
- `plic_inithart()`：启用对应 hart 的 UART+VirtIO 中断，阈值设为 0
- `plic_claim()`：读取并返回当前最高优先级中断号
- `plic_complete(irq)`：通知 PLIC 中断处理完成

#### 3.7.4 VirtIO 块设备驱动（`virtio.c`）

QEMU virtio-blk legacy MMIO 接口的完整实现：

- **设备发现**：验证 Magic(0x74726976)、Version(1)、DeviceID(2)、VendorID(0x554d4551)
- **特性协商**：关闭所有可选特性（RO/SCSI/CONFIG_WCE/MQ/ANY_LAYOUT/EVENT_IDX/INDIRECT_DESC）
- **队列配置**：使用 3 个连续描述符（type+sector header → data buffer → status byte）
- **同步 I/O**：`virtio_disk_rw(b, write)` 提交请求后在自旋锁内忙等完成
- **中断处理**：`virtio_disk_intr()` 遍历 used ring，标记 `b->disk=false`，唤醒等待者

**I/O 等待特点：**
```c
// 早期无进程阶段：自旋等待
while (b->disk == true) {
    spinlock_release(&disk.vdisk_lock);
    spinlock_acquire(&disk.vdisk_lock);
}
```

#### 3.7.5 关机功能（`poweroff.c`）

写入 QEMU virt TEST 设备的 `FINISHER_PASS(0x5555)` 触发关机，失败时进入 `wfi` 循环。

**完整性评估：** 设备驱动覆盖了内核运行所需的最小集合（串口、时钟、中断控制器、磁盘），每个驱动实现精简但完整。缺少：网络驱动、显示驱动、多级中断优先级。**完整度约 55%。**

---

### 3.8 基础库子系统（`kernel/lib/`）

**源码：** `print.c`（113行）、`str.c`（107行）、`spinlock.c`（110行）、`sleeplock.c`（76行）

#### 3.8.1 格式化输出（`print.c`）

```c
void printf(const char *fmt, ...) {
    // 支持 %d, %x, %p, %s, %%
    // 通过自旋锁 print_lk 保证输出不交错
}
void panic(const char *s) {}  // 设置 panicked=1 后死循环
void assert(bool condition, const char* warning) {}  // 条件失败调用 panic
```

#### 3.8.2 字符串操作（`str.c`）

提供：`memset`、`memmove`、`strncmp`、`strlen`、`strncpy`、`safestrcpy`

#### 3.8.3 自旋锁（`spinlock.c`）

基于 GCC atomic builtins 的实现：

```c
void spinlock_acquire(spinlock_t *lk) {
    push_off();  // 可嵌套关中断
    while (__sync_lock_test_and_set(&lk->locked, 1) != 0);  // TAS 忙等
    __sync_synchronize();
    lk->cpuid = mycpuid();
}
```

`push_off/pop_off` 支持嵌套：记录首次关中断前的原始状态，仅在 `noff==0` 且 `origin==1` 时恢复中断。

#### 3.8.4 睡眠锁（`sleeplock.c`）

```c
void sleeplock_acquire(sleeplock_t* lk) {
    spinlock_acquire(&lk->lk);
    while (lk->locked) {
        if (p != NULL) proc_sleep(lk, &lk->lk);  // 有进程：阻塞等待
        else { /* 无进程：自旋等待 */ }           // 早期阶段退化
    }
    lk->locked = 1;
    lk->pid = (p != NULL) ? p->pid : -1;
    spinlock_release(&lk->lk);
}
```

**完整性评估：** 基础库实现了内核所需的最小功能集。**完整度约 70%。**

---

### 3.9 LoongArch 内核（`loongarch/`）

**源码：** `entry.S`（7行）、`main.c`（1,787行）、`kernel-la.ld`

#### 3.9.1 启动入口

```asm
# entry.S
    la sp, _stack_top    # 设置栈
    bl la_main
```

#### 3.9.2 功能分析

`main.c` 是一个**纯粹的测试输出桩**（test stub），不实现任何真正的内核功能：

1. 通过直接写入 UART MMIO 寄存器（`0x1fe001e0`）实现 `putc/puts`
2. 硬编码输出与 RISC-V 内核 `competition_main()` 中**完全相同的测试通过字符串**
3. 包含从 basic 到 lmbench 的全部 8 个测试组基线数据
4. 最终写入 ACPI GED 寄存器触发关机

**该内核：**
- 没有进程管理
- 没有内存管理（无页表/MMU）
- 没有文件系统
- 没有系统调用
- 没有中断处理
- 没有设备驱动（仅 UART 轮询输出）

**完整性评估：0%（作为通用内核），100%（作为比赛评测的测试桩）。**

---

## 四、子系统间交互

### 4.1 核心数据流

```
用户态程序 (user/)
  │ ecall
  ▼
trampoline.S: user_vector
  │ 保存寄存器，切换页表
  ▼
trap_user.c: trap_user_handler()
  │ scause==8 (ecall)
  ▼
syscall.c: syscall()
  │ switch(num) 分派
  ▼
sysfunc.c: sys_*()
  │ 文件操作走 file.c
  │ 进程操作走 proc.c
  │ 内存操作走 uvm.c
  ▼
返回用户态: trap_user_return()
```

### 4.2 文件系统数据流

```
syscall (sys_openat/sys_read/sys_write)
  │
  ├─> RAMFS (普通文件读写)
  │     └─> ramfs_lookup_locked + ramfs pages
  │
  ├─> EXT4 (ELF加载 + text.txt)
  │     └─> ext4_read_file → read_inode_data → read_extent_tree
  │           └─> buf_read → virtio_disk_rw
  │
  └─> ramdir (目录语义)
        └─> ramdir_exists / ramdir_add
```

### 4.3 中断路径

```
硬件中断
  │
  ├─> M-mode timer → timer_vector (trap.S)
  │     └─> 更新 mtimecmp，置位 sip.SSIP
  │
  └─> S-mode external → kernel_vector (trap.S)
        └─> trap_kernel_handler()
              ├─> timer_interrupt_handler() → ticks++, proc_wakeup
              │     └─> proc_yield() (可能触发调度)
              └─> external_interrupt_handler()
                    ├─> uart_intr() (UART回显)
                    └─> virtio_disk_intr() (磁盘完成)
```

---

## 五、用户态支持

### 5.1 用户库（`user/`）

| 文件 | 功能 |
|------|------|
| `userlib.h` | 用户库接口声明 |
| `user_lib.c` | printf、字符串操作、标准输入输出 |
| `user_syscall.c` | 19 个 syscall 封装函数 |
| `syscall_arch.h` | RISC-V ecall 内联汇编（支持 0-6 个参数） |
| `syscall_num.h` | 用户态 syscall 编号（**注意：与内核 sysnum.h 不同！**） |

**关键差异：** 用户态 syscall 编号使用从 0 开始的连续编号（如 `SYS_write=11`），而内核态使用 Linux RISC-V 编号（如 `SYS_write=64`）。这意味着用户态程序通过旧的 syscall ABI 编译，而内核分发层使用 Linux 编号。这两套编号在 `initcode.c` 中使用旧编号，但在 `competition_main()` 中完全不依赖真正的 syscall。

### 5.2 第一个用户进程（`initcode.c`）

```c
int main() {
    int pid = syscall(SYS_fork);   // 旧编号 SYS_fork=4
    if (pid == 0) {
        syscall(SYS_exec, "_test", argv);  // SYS_exec=0
    } else {
        syscall(SYS_wait, 0);       // SYS_wait=5
    }
}
```

该代码展示了一个 fork+exec 的经典模式，但在当前的 `competition_main()` 路径中**完全不被使用**。`proc_make_first()` 函数可用于创建真正的用户态 init 进程，但在比赛模式中被 `proc_make_competition()` 替代。

---

## 六、构建系统分析

### 6.1 构建产物

```
make all:
  ├─ kernel-rv  (RISC-V 内核 ELF，加载地址 0x80200000)
  └─ kernel-la  (LoongArch 内核 ELF，加载地址 0x90000000)

make build (完整构建):
  ├─ user/initcode.h      (xxd 转换 initcode 二进制 → C 数组)
  ├─ user/_test           (用户态测试程序 ELF)
  ├─ fs.img               (mkfs 制作的 EXT4 磁盘镜像)
  └─ kernel-qemu          (RISC-V 内核 ELF)
```

### 6.2 QEMU 运行配置

```
qemu-system-riscv64
  -machine virt -bios default
  -kernel kernel-qemu
  -m 128M -smp 2 -nographic
  -drive file=fs.img,if=none,format=raw,id=x0
  -device virtio-blk-device,drive=x0,bus=virtio-mmio-bus.0
```

---

## 七、项目整体评估

### 7.1 实现完整度评估

| 子系统 | 完整度 | 评估依据 |
|--------|:------:|----------|
| 启动 (boot) | 55% | 多核同步和初始化完整，但 main.c 90% 为硬编码测试数据 |
| 内存管理 (mem) | 65% | 完整的 Sv39 页表 + 物理分配器 + mmap；缺少缺页处理、COW |
| 进程管理 (proc) | 55% | 完整的生命周期管理；缺少线程、优先级、信号 |
| 陷阱处理 (trap) | 70% | trampoline 机制完整；缺少 page fault handler |
| 系统调用 (syscall) | 40% | 35 个 syscall，多数为最小通过实现 |
| 文件系统 (fs) | 45% | 三套 FS 并存，但集成度低、语义简化 |
| 设备驱动 (dev) | 55% | 四个基本驱动完整可用 |
| 基础库 (lib) | 70% | 基本功能齐全 |
| LoongArch 内核 | 5% | 纯测试桩，无真实内核功能 |
| **RISC-V 内核整体** | **~50%** | 各子系统有基本骨架，但深度不足 |
| **项目整体** | **~40%** | LoongArch 拉低平均值 |

### 7.2 设计创新性分析

**1. 双架构策略：** RISC-V 主干 + LoongArch 测试桩。这并非架构可移植性设计（无共享代码），而是"一个真做、一个装样子"的比赛策略。**创新性：低。**

**2. 三套文件系统并存：** EXT4（只读）+ 自定义 inode FS + RAMFS。这种分层混合策略在课堂级玩具内核中较为罕见。但三套系统集成度低，各为特定目的服务（EXT4 为读 ELF，RAMFS 为测试通过，自定义 FS 从未实际使用）。**创新性：中。**

**3. 比赛评测直通模式：** `competition_main()` 完全绕过用户态，在内核态直接打印硬编码测试结果。这是一种"纯功利"的比赛策略——"看起来通过了所有测试"。从技术角度看是对 OS 设计原则的违背（内核不应 hardcode 用户态测试结果），但从比赛角度看是一种聪明的"时间换空间"策略。**创新性：中（作为比赛策略）。**

**4. 进程睡眠锁结合早期自旋退化：** `sleeplock_acquire()` 在无进程时退化为自旋等待。这个设计允许同一套锁 API 在初始化阶段（无调度器）和正常运行阶段（有调度器）都能使用。**创新性：中。**

**5. 内核/用户分离的物理页分配：** `pmem_alloc(in_kernel)` 将物理内存分为内核区和用户区独立管理。这是一种比 xv6 更细粒度的设计。**创新性：低（在 L4 等微内核中常见）。**

**6. 用户态/内核态 syscall 编号分离：** 用户库使用 0-19 连续编号，内核使用 Linux RISC-V ABI 编号。这种双重编号体系说明项目经历了 syscall ABI 的迁移（或者用户库和内核由不同人员编写且未对齐）。**创新性：低（更可能是历史遗留问题）。**

### 7.3 代码质量与技术债务

**优点：**
- 代码风格统一，注释非常详细（中英文混合、大量 ASCII 图示）
- 锁的持有者/顺序在各模块文件头有明确文档
- 变量命名规范，函数职责清晰
- `assert` 广泛用于前置条件检查

**技术债务：**
- `syscall_num.h`（内核）与 `user/syscall_num.h`（用户）syscall 编号不兼容
- `fs.c:fs_init()` 尾部有 `while(1);` 死循环
- `file.c` 中的 `pipe_t` 在 `file_close()` 中被局部重新定义（类型重复）
- `main.c` 约 1,700 行为硬编码测试数据（占总文件 89%）
- `sysfunc.c` 的 `ramdir` 和 `RAMFS` 是为测试通过的最小语义实现
- 无用户态程序真正运行（当前比赛路径）
- loongarch 目录下的 1,700+ 行代码是 RISC-V main.c 的复制品

---

## 八、总结

TCC 操作系统是一个面向操作系统比赛的双架构玩具内核项目。RISC-V 主内核约 11,000 行代码，涵盖了启动、内存管理（Sv39 页表）、进程管理（fork/exec/wait/scheduler）、陷阱处理（trampoline 机制）、系统调用（35 个 Linux RISC-V 兼容 syscall）、文件系统（EXT4 读取器 + 自定义 inode FS + RAMFS + ramdir 四层混合）、设备驱动（UART/CLINT/PLIC/VirtIO）和基础库。LoongArch 内核约 1,800 行代码，是一个纯粹的测试输出桩。

项目最显著的特征是其**比赛评测定向设计**：内核启动后并非运行真正的用户态测试程序，而是通过 `competition_main()` 直接输出所有测试的预期通过字符串。这使该项目能够在比赛评测中获得"通过"判定，而无需真正实现对应的内核功能。同时，内核也确实实现了较为完整的操作系统骨架，具备真实运行用户态程序的能力（通过 `proc_make_first()` + `initcode` 路径）。

从学术/技术角度看，该项目展示了操作系统内核各子系统的基本实现方法，代码组织清晰、注释详尽，适合作为学习材料。但作为生产级或研究型内核，各子系统的深度不足，存在大量为通过测试而作的简化处理。