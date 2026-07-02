# OSKernel2026-SGYB 操作系统内核深度技术分析报告

---

## 一、分析方法概述

本次分析采用了以下方法进行全方位调查：

1. **静态源码审查**：逐文件阅读了 `kernel/`、`user/`、`mkfs/` 目录下全部约 11,858 行源代码。
2. **构建与运行测试**：使用 RISC-V 交叉编译工具链完整构建内核、用户程序及文件系统镜像，并在 QEMU (`qemu-system-riscv64`) 上启动运行。
3. **交互式功能验证**：在 QEMU 环境中通过 shell 执行了 `ls`、`myCall`（自定义系统调用综合测试）、`echo` 等命令，验证了核心功能和新增系统调用的行为。
4. **开发日志交叉验证**：审阅了 `.workbuddy/memory/` 下 5 篇开发日志，获取了开发者对已知 bug 的自评估信息，并将其与源码实际状态进行交叉比对。
5. **交叉引用分析**：通过 `grep` 等手段追踪函数调用链、数据结构引用路径，构建子系统交互图。

---

## 二、构建与测试结果

### 2.1 构建

构建过程完全成功，无任何编译错误或警告（`-Wall -Werror` 通过）。构建使用的工具链为 `riscv64-unknown-elf-gcc`（自动检测）。

构建产物：
- `kernel/kernel`：内核 ELF 可执行文件
- `fs.img`：2000 块（约 2MB）的文件系统镜像，包含 19 个用户程序
- 19 个用户程序：`cat`, `echo`, `forktest`, `grep`, `init`, `kill`, `ln`, `ls`, `mkdir`, `rm`, `sh`, `stressfs`, `usertests`, `grind`, `wc`, `zombie`, `logstress`, `forphan`, `dorphan`, `myCall`

### 2.2 QEMU 运行测试

**测试环境**：`qemu-system-riscv64`，`virt` 机器，3 个 hart（CPU），128MB RAM。

**启动过程**：
```
xv6 kernel is booting
hart 1 starting
hart 2 starting
init: starting sh
$
```

内核成功启动，多核初始化正常（hart 1、hart 2 依次上线）。

**Shell 测试**：
- `ls` — 成功列出 24 个目录项（包括 `.`, `..`, `README`, 19 个用户程序, `console` 设备节点）
- `echo hello world` — 成功回显
- `myCall` — 自定义系统调用综合测试程序输出：
  ```
  This is my First Call.          (myFirstCall: 返回 22)
  The pid of the parent of 4 is 2 (getppid: 父进程 PID=2 即 init)
  schedule success.               (sched_yield: 返回 0)
  xv6                             (uname: sysname="xv6")
  /                               (getcwd: 根目录 "/")
  8 300000000                     (gettimeofday: tv_sec=8, tv_nsec=300000000)
  p:5 15 0 0                      (times: utime=5, stime=15)
  p:5 15
  ```

所有新增系统调用在基本场景下功能正常。`getcwd` 在根目录返回 "/"，`gettimeofday` 返回了合理的时间值，`times` 正确累计了用户态和内核态 CPU 时间。

---

## 三、子系统与功能清单

| 子系统 | 核心文件 | 状态 | 实现完整度 |
|--------|----------|------|-----------|
| 启动与平台初始化 | `entry.S`, `start.c`, `main.c`, `kernel.ld` | 完成 | 100% |
| 内存管理（物理页分配） | `kalloc.c` | 完成 | 100% |
| 内存管理（虚拟内存/Sv39） | `vm.c`, `vm.h`, `memlayout.h` | 完成（含延迟分配） | 100% |
| 进程管理 | `proc.c`, `proc.h`, `swtch.S` | 完成（含 6 状态模型） | 100% |
| 同步原语 | `spinlock.c`, `sleeplock.c` | 完成 | 100% |
| 陷阱与中断 | `trap.c`, `trampoline.S`, `kernelvec.S`, `plic.c` | 完成 | 100% |
| 系统调用层 | `syscall.c`, `syscall.h`, `sysproc.c`, `sysfile.c` | 部分完成（编号问题） | 75% |
| 文件系统核心 | `fs.c`, `fs.h` | 完成 | 100% |
| 磁盘块缓存 | `bio.c`, `buf.h` | 完成 | 100% |
| 日志系统 | `log.c` | 完成 | 100% |
| 文件描述符层 | `file.c`, `file.h` | 完成 | 100% |
| 管道 | `pipe.c` | 完成 | 100% |
| ELF 加载器 | `exec.c`, `elf.h` | 完成 | 100% |
| 设备驱动（UART） | `uart.c` | 完成 | 100% |
| 设备驱动（virtio 磁盘） | `virtio_disk.c`, `virtio.h` | 完成 | 100% |
| 控制台层 | `console.c` | 完成 | 100% |
| 内核工具函数 | `string.c`, `printf.c` | 完成 | 100% |
| 用户空间 | `user/*` | 完成 | 100% |

---

## 四、各子系统详细实现拆解

### 4.1 启动与平台初始化

#### 4.1.1 启动流程

启动分三个阶段：**M-mode 汇编入口** → **M-mode C 初始化** → **S-mode 主线**。

**阶段一：entry.S（M-mode 汇编入口）**

```asm
# kernel/entry.S
_entry:
    la sp, stack0
    li a0, 1024*4
    csrr a1, mhartid
    addi a1, a1, 1
    mul a0, a0, a1
    add sp, sp, a0
    call start
```

- QEMU 的 `-kernel` 将内核加载到物理地址 `0x80000000`，每个 hart 跳转至 `_entry`。
- 利用 `mhartid` 为每个 hart 分配独立的 4096 字节内核栈（`stack0[]` 声明在 `start.c` 中，`__attribute__((aligned(16)))`，总大小 `4096 * NCPU`，其中 `NCPU=8`）。
- 栈指针 = `stack0 + (hartid + 1) * 4096`，自顶向下生长。

**阶段二：start.c（M-mode C 初始化）**

```c
// kernel/start.c
void start() {
    unsigned long x = r_mstatus();
    x &= ~MSTATUS_MPP_MASK;
    x |= MSTATUS_MPP_S;       // 设置 mret 返回 S-mode
    w_mstatus(x);

    w_mepc((uint64)main);      // mret 跳转目标 = main()

    w_satp(0);                 // 禁用分页

    w_medeleg(0xffff);         // 所有异常委托给 S-mode
    w_mideleg(0xffff);         // 所有中断委托给 S-mode
    w_sie(r_sie() | SIE_SEIE | SIE_STIE);  // 使能 S-mode 外部中断和定时器中断

    w_pmpaddr0(0x3fffffffffffffull);  // PMP: S-mode 可访问全部物理内存
    w_pmpcfg0(0xf);

    timerinit();               // 配置 SSTC 定时器

    int id = r_mhartid();
    w_tp(id);                  // tp 寄存器存储 hartid，供 cpuid() 使用

    asm volatile("mret");      // 切换到 S-mode，跳转至 main()
}
```

**关键设计决策**：
- 使用 **SSTC 扩展**（`stimecmp` CSR）而非传统的 CLINT 内存映射定时器。`timerinit()` 通过设置 `menvcfg` 第 63 位（`STCE`）使能 SSTC，并配置 `mcounteren` 允许 S-mode 访问 `time` CSR。
- 使用 **PMP（物理内存保护）** 而非完整的内存管理：`pmpcfg0=0xf`（TOR 模式，R/W/X 全开），`pmpaddr0` 覆盖整个 56 位物理地址空间。

**阶段三：main.c（S-mode 主线）**

```c
void main() {
    if(cpuid() == 0){
        consoleinit(); printfinit();
        kinit();          // 物理页分配器
        kvminit();        // 内核页表
        kvminithart();    // 开启分页
        procinit();       // 进程表
        trapinit();       // 陷阱向量
        trapinithart();
        plicinit();       // PLIC 中断控制器
        plicinithart();
        binit();          // 磁盘块缓存
        iinit();          // inode 表
        fileinit();       // 文件描述符表
        virtio_disk_init(); // virtio 磁盘
        userinit();       // 第一个用户进程（init）
        __sync_synchronize();
        started = 1;
    } else {
        while(started == 0);  // 非主 hart 自旋等待
        __sync_synchronize();
        kvminithart(); trapinithart(); plicinithart();
    }
    scheduler();          // 进入调度器（永不返回）
}
```

- **多核同步**：使用 `volatile static int started` + `__sync_synchronize()` 内存屏障。非主 hart 忙等直到主 hart 完成初始化。
- 文件系统初始化被**延迟**到第一个用户进程的上下文中（`forkret()` → `fsinit(ROOTDEV)`），因为 `fsinit` 中的 `ireclaim` 可能调用 `sleep`，而调度器尚未运行。

#### 4.1.2 链接脚本

```ld
OUTPUT_ARCH("riscv")
ENTRY(_entry)
SECTIONS {
    . = 0x80000000;
    .text : {
        kernel/entry.o(_entry)    // 强制 _entry 位于最前面
        *(.text .text.*)
        . = ALIGN(0x1000);
        _trampoline = .;
        *(trampsec)               // trampoline 代码放在独立页
        . = ALIGN(0x1000);
        ASSERT(. - _trampoline == 0x1000, "...");
    }
    // .rodata, .data, .bss ...
}
```

- `trampoline.S` 的 `trampsec` 段被强制对齐到单独一页，通过 `ASSERT` 保证不超过 4KB。
- 内核起始于 `0x80000000`（QEMU `virt` 机器 DRAM 基址）。

---

### 4.2 内存管理子系统

#### 4.2.1 物理页分配器 (`kalloc.c`)

采用**空闲链表**（free list）实现，极其简洁（82 行）：

```c
struct run { struct run *next; };
struct {
    struct spinlock lock;
    struct run *freelist;
} kmem;
```

**初始化** (`kinit`)：
- 从内核 BSS 末尾（`end` 符号，由链接脚本定义）到 `PHYSTOP`（`0x80000000 + 128MB`）的全部物理内存加入空闲链表。
- `freerange()` 逐页调用 `kfree()`。

**分配** (`kalloc`)：
- 自旋锁保护下的链表头删除操作。
- 分配后用 `memset(ptr, 5, PGSIZE)` 填充垃圾字节（防止悬垂引用利用旧数据）。

**释放** (`kfree`)：
- 合法性检查：页对齐、地址范围在 `[end, PHYSTOP)`。
- 填充垃圾字节 `memset(ptr, 1, PGSIZE)`。
- 插入链表头部。

**设计评注**：标准 xv6 实现，无变动。该分配器不区分 NUMA 节点，不维护空闲页计数，无预留区域。

#### 4.2.2 虚拟内存管理 (`vm.c`)

采用 **RISC-V Sv39 三级页表**（每级 512 个 PTE，9 位索引，4KB 页）。

**内核地址空间** (`kvmmake`)：

| 虚拟地址范围 | 物理地址 | 大小 | 权限 | 用途 |
|-------------|---------|------|------|------|
| `UART0` | `UART0` | 4KB | R+W | NS16550 UART 寄存器 |
| `VIRTIO0` | `VIRTIO0` | 4KB | R+W | virtio MMIO 接口 |
| `PLIC` | `PLIC` | 64MB | R+W | PLIC 中断控制器 |
| `KERNBASE..etext` | 同 | 内核代码段 | R+X | 内核可执行代码 |
| `etext..PHYSTOP` | 同 | 剩余内存 | R+W | 内核数据 + 空闲 RAM |
| `TRAMPOLINE` | `trampoline` 物理页 | 4KB | R+X | 用户态↔内核态跳板 |
| `KSTACK(p)` | 动态分配 | 4KB×NPROC | R+W | 每进程内核栈 |

- 内核采用**直接映射**（虚拟地址 = 物理地址），简化了内核代码对物理内存的访问。
- `TRAMPOLINE` 映射到虚拟地址空间最高页 `MAXVA - PGSIZE`，在用户和内核页表中映射到**同一物理页**，使得页表切换时代码仍可执行。
- 每进程内核栈位于 `KSTACK(p) = TRAMPOLINE - (p+1)*2*PGSIZE`，栈下方有 4KB 的**保护页**（未映射），用于检测栈溢出。

**核心页表操作**：

`walk(pagetable, va, alloc)` — 三级页表遍历：
```c
pte_t *walk(pagetable_t pagetable, uint64 va, int alloc) {
    for(int level = 2; level > 0; level--) {
        pte_t *pte = &pagetable[PX(level, va)];
        if(*pte & PTE_V) {
            pagetable = (pagetable_t)PTE2PA(*pte);
        } else {
            if(!alloc || (pagetable = (pde_t*)kalloc()) == 0)
                return 0;
            memset(pagetable, 0, PGSIZE);
            *pte = PA2PTE(pagetable) | PTE_V;
        }
    }
    return &pagetable[PX(0, va)];
}
```
遍历方式自上而下（level 2 → level 0），若中间页表缺失且 `alloc=1`，则动态分配新的页表页。

`mappages` — 批量建立映射，循环调用 `walk(alloc=1)` 并写入 PTE，检查 `PTE_V` 防止重复映射（若重复则 panic）。

`uvmalloc` — 为用户进程增长地址空间，逐页分配物理页并映射，权限为 `PTE_R | PTE_U | xperm`。

`uvmcopy` — fork 时复制用户地址空间，逐页 `kalloc` + `memmove` + `mappages`。此处**未实现写时复制（COW）**，直接深拷贝所有物理页。

`uvmfree` — 释放用户地址空间，先 `uvmunmap` 释放所有物理页，再 `freewalk` 递归释放页表页。

**用户地址空间布局**：

```
0x00000000 ─── text (代码)
            ─── data + bss
            ─── stack (固定大小: 1 页 = USERSTACK=1)
            ─── heap (可扩展, sbrk)
            ...
TRAPFRAME   ─── trapframe 页 (TRAMPOLINE - PGSIZE)
TRAMPOLINE  ─── trampoline 页 (MAXVA - PGSIZE)
```

#### 4.2.3 延迟内存分配（Lazy Allocation）

这是该项目对标准 xv6 的**最重要扩展**之一。

**触发路径**：用户调用 `sbrk(n, SBRK_LAZY)` → `sys_sbrk()` 仅增加 `p->sz`，不分配物理页。

**缺页处理**：当进程访问未映射的懒惰分配页时，触发**页异常**（`scause=13` Load Fault 或 `scause=15` Store Fault），在 `usertrap()` 中：

```c
} else if((r_scause() == 15 || r_scause() == 13) &&
          vmfault(p->pagetable, r_stval(), (r_scause() == 13)? 1 : 0) != 0) {
    // page fault on lazily-allocated page
}
```

**`vmfault` 实现** (`vm.c`)：
```c
uint64 vmfault(pagetable_t pagetable, uint64 va, int read) {
    struct proc *p = myproc();
    if (va >= p->sz)         // 超出进程地址空间
        return 0;
    va = PGROUNDDOWN(va);
    if(ismapped(pagetable, va))  // 已映射 → 不是延迟分配页
        return 0;
    mem = (uint64) kalloc();
    if(mem == 0) return 0;
    memset((void *)mem, 0, PGSIZE);
    if (mappages(p->pagetable, va, PGSIZE, mem, PTE_W|PTE_U|PTE_R) != 0) {
        kfree((void *)mem);
        return 0;
    }
    return mem;
}
```

- 仅当 `va < p->sz`（在进程声明的地址空间内）且页表项无效时才分配。
- 新页权限为 `PTE_R | PTE_W | PTE_U`（可读可写可用户访问），不支持只执行页的延迟分配。
- 如果 `kalloc` 失败（内存耗尽），返回 0 → `usertrap` 不处理异常 → 进程被 kill。

**`copyin`/`copyout` 的适配**：`copyin` 在 `walkaddr` 返回 0 时调用 `vmfault` 尝试延迟分配：
```c
int copyin(pagetable_t pagetable, char *dst, uint64 srcva, uint64 len) {
    // ...
    pa0 = walkaddr(pagetable, va0);
    if(pa0 == 0) {
        if((pa0 = vmfault(pagetable, va0, 0)) == 0)
            return -1;
    }
    // ...
}
```

**设计评注**：延迟分配降低了 `sbrk` 的实际内存开销，但 `vmfault` 的 `read` 参数未被实际使用（所有缺页都分配可读写页），未区分 COW 页和延迟分配页。

---

### 4.3 进程管理子系统

#### 4.3.1 进程状态模型

6 状态有限状态机：

```
UNUSED → USED → RUNNABLE ⇄ RUNNING
                  ↑         ↓
                SLEEPING   ZOMBIE
```

- **UNUSED**：进程槽位空闲，`p->lock` 未持有。
- **USED**：`allocproc()` 中，已分配 PID 和 trapframe/page table，但尚未准备好运行。
- **RUNNABLE**：就绪，等待调度。
- **RUNNING**：当前在某 CPU 上执行。
- **SLEEPING**：阻塞于某个 `chan`（如磁盘 I/O、管道、子进程退出）。
- **ZOMBIE**：已退出，等待父进程 `wait()` 回收。

实际上，`USED` 状态是一个短暂过渡状态，仅在 `allocproc()` 和 `freeproc()` 之间出现。

#### 4.3.2 进程结构体

```c
struct proc {
    struct spinlock lock;         // 保护以下字段
    enum procstate state;
    void *chan;                   // sleep 等待通道
    int killed;                   // 被 kill 标记
    int xstate;                   // 退出状态
    int pid;

    struct proc *parent;          // 受 wait_lock 保护

    uint64 kstack;                // 内核栈虚拟地址
    uint64 sz;                    // 进程内存大小
    pagetable_t pagetable;
    struct trapframe *trapframe;
    struct context context;       // 调度器上下文
    struct file *ofile[NOFILE];   // 打开文件表（NOFILE=16）
    struct inode *cwd;            // 当前工作目录
    tms time;                     // CPU 时间统计（新增）
    char name[16];
};
```

**新增 `tms time` 字段**（来自 `types.h`）：
```c
typedef struct tms {
    long tms_utime;   // 用户态 CPU 时间
    long tms_stime;   // 内核态 CPU 时间
    long tms_cutime;  // 子进程用户态时间累计
    long tms_cstime;  // 子进程内核态时间累计
} tms;
```

#### 4.3.3 调度器

```c
void scheduler(void) {
    struct proc *p;
    struct cpu *c = mycpu();
    c->proc = 0;
    for(;;){
        intr_on();                   // 允许中断
        for(p = proc; p < &proc[NPROC]; p++){
            acquire(&p->lock);
            if(p->state == RUNNABLE){
                p->state = RUNNING;
                c->proc = p;
                swtch(&c->context, &p->context);  // 上下文切换
                c->proc = 0;
            }
            release(&p->lock);
        }
    }
}
```

- **轮转调度（Round-Robin）**：线性扫描 `proc[NPROC]` 数组，选择第一个 `RUNNABLE` 进程。
- 无优先级、无时间片配额——进程一直运行直到主动 `yield()`、`sleep()` 或被时钟中断抢占。
- `NPROC=64`：最多 64 个进程。
- 时钟中断处理中调用 `yield()` 实现抢占（`usertrap` 中 `which_dev == 2` 分支）。

#### 4.3.4 上下文切换 (`swtch.S`)

```asm
swtch:
    sd ra, 0(a0)       # 保存 callee-saved 寄存器到 old context
    sd sp, 8(a0)
    sd s0, 16(a0)
    ...
    ld ra, 0(a1)       # 从 new context 恢复
    ld sp, 8(a1)
    ...
    ret
```

仅保存/恢复 **callee-saved 寄存器**（`ra, sp, s0-s11`），caller-saved 由调用约定自动管理。这是理解 `sched()` 和 `scheduler()` 之间控制流转移的关键。

#### 4.3.5 fork 实现 (`kfork`)

```c
int kfork(void) {
    np = allocproc();                             // 分配进程槽位
    uvmcopy(p->pagetable, np->pagetable, p->sz); // 深拷贝用户内存
    np->sz = p->sz;
    *(np->trapframe) = *(p->trapframe);          // 拷贝 trapframe
    np->trapframe->a0 = 0;                       // 子进程返回 0
    for(i = 0; i < NOFILE; i++)                  // 复制文件描述符
        if(p->ofile[i])
            np->ofile[i] = filedup(p->ofile[i]);
    np->cwd = idup(p->cwd);                      // 共享当前目录引用
    np->parent = p;
    np->state = RUNNABLE;
    return pid;
}
```

- 内存复制：完整深拷贝（无 COW）。
- 文件描述符：增加引用计数（`filedup`），父子共享文件偏移量。
- 子进程的 `trapframe->a0 = 0` 使得 `fork()` 在子进程中返回 0。

#### 4.3.6 exit 实现 (`kexit`)

```c
void kexit(int status) {
    // 1. 关闭所有文件描述符
    for(int fd = 0; fd < NOFILE; fd++)
        if(p->ofile[fd]) { fileclose(f); p->ofile[fd] = 0; }
    // 2. 释放当前目录
    begin_op(); iput(p->cwd); end_op();
    // 3. 子进程过继给 init
    acquire(&wait_lock);
    reparent(p);
    wakeup(p->parent);
    // 4. 累计时间到父进程（⚠ BUG-3）
    acquire(&p->lock);
    p->xstate = status;
    p->state = ZOMBIE;
    release(&wait_lock);
    if(p->parent) {
        acquire(&p->parent->lock);
        p->parent->time.tms_cutime += p->time.tms_utime;
        p->parent->time.tms_cstime += p->time.tms_stime;
        release(&p->parent->lock);
    }
    sched();  // 永不返回
}
```

**已知 BUG-3**：时间累计在 `release(&wait_lock)` 之后进行。此时父进程可能在另一个 CPU 上通过 `wait()` 已回收该子进程（`freeproc`），导致访问已释放内存（use-after-free）。

#### 4.3.7 wait 实现 (`kwait`)

```c
int kwait(uint64 addr) {
    for(;;){
        havekids = 0;
        for(pp = proc; pp < &proc[NPROC]; pp++){
            if(pp->parent == p){
                acquire(&pp->lock);
                havekids = 1;
                if(pp->state == ZOMBIE){
                    pid = pp->pid;
                    if(addr != 0 && copyout(p->pagetable, addr, ...) < 0) { ... }
                    p->time.tms_cutime += pp->time.tms_cutime;
                    p->time.tms_cstime += pp->time.tms_cstime;
                    freeproc(pp);
                    release(&pp->lock);
                    release(&wait_lock);
                    return pid;
                }
                release(&pp->lock);
            }
        }
        if(!havekids || killed(p)) { release(&wait_lock); return -1; }
        sleep(p, &wait_lock);  // 等待子进程退出
    }
}
```

- 扫描进程表寻找 ZOMBIE 子进程。
- 回收时累加子进程的 `tms_cutime`/`tms_cstime` 到自己的统计中（两级累计）。
- 无子进程时返回 -1。

---

### 4.4 同步原语

#### 4.4.1 自旋锁 (`spinlock.c`)

```c
struct spinlock {
    uint locked;
    char *name;
    struct cpu *cpu;
};
```

**acquire**：
1. `push_off()` — 禁用中断（嵌套计数，`c->noff++`）。
2. `__sync_lock_test_and_set(&lk->locked, 1)` — 原子 TAS，自旋等待。
3. `__sync_synchronize()` — 内存屏障。
4. `lk->cpu = mycpu()` — 记录持有者。

**release**：
1. `lk->cpu = 0`。
2. `__sync_synchronize()` — 内存屏障。
3. `__sync_lock_release(&lk->locked)` — 原子释放。
4. `pop_off()` — 恢复中断（嵌套计数，仅在最外层恢复）。

**中断禁用嵌套** (`push_off`/`pop_off`)：
- 使用 `c->noff` 计数。首次 `push_off` 记录原中断状态到 `c->intena`，`pop_off` 仅当 `noff==0` 且 `intena==1` 时才重新开中断。
- 这保证了持有自旋锁期间不会被同一 CPU 上的中断处理程序重入。

#### 4.4.2 睡眠锁 (`sleeplock.c`)

```c
struct sleeplock {
    uint locked;
    struct spinlock lk;    // 保护 locked 字段
    char *name;
    int pid;
};
```

**acquiresleep**：
```c
acquire(&lk->lk);
while (lk->locked) sleep(lk, &lk->lk);
lk->locked = 1; lk->pid = myproc()->pid;
release(&lk->lk);
```

- 基于 `sleep`/`wakeup` 机制实现。
- 持有自旋锁的时间极短（仅检查和设置 `locked` 字段）。

---

### 4.5 陷阱与中断子系统

#### 4.5.1 用户态陷阱处理 (`usertrap`)

```c
uint64 usertrap(void) {
    w_stvec((uint64)kernelvec);   // 切换到内核陷阱向量
    p->trapframe->epc = r_sepc();

    if(r_scause() == 8) {         // 系统调用 (ecall)
        p->trapframe->epc += 4;
        intr_on();
        syscall();
    } else if((which_dev = devintr()) != 0) {
        // 设备中断
    } else if((r_scause() == 15 || r_scause() == 13) &&
              vmfault(...) != 0) {
        // 延迟分配缺页
    } else {
        setkilled(p);             // 未识别的异常 → kill
    }

    if(killed(p)) kexit(-1);
    if(which_dev == 2) {          // 定时器中断
        p->time.tms_utime++;      // 累计用户态时间
        yield();
    }
    prepare_return();
    return MAKE_SATP(p->pagetable);
}
```

**`tms_utime` 累计点**：在定时器中断触发 `yield()` 之前递增。这表示每次时钟滴答（约 0.1 秒）中若进程处于用户态则 `tms_utime++`。这个实现较为粗粒度——如果进程在系统调用中收到时钟中断，`tms_stime` 在 `kerneltrap` 中递增。

#### 4.5.2 内核态陷阱处理 (`kerneltrap`)

```c
void kerneltrap() {
    if(intr_get() != 0)
        panic("kerneltrap: interrupts enabled");
    if((which_dev = devintr()) == 0)
        panic("kerneltrap");  // 内核不应产生未识别的异常

    if(which_dev == 2 && myproc() != 0) {
        p->time.tms_stime++;  // 累计内核态时间
        yield();
    }
    w_sepc(sepc); w_sstatus(sstatus);  // 恢复寄存器（yield 可能已改变）
}
```

**`tms_stime` 累计点**：在内核态收到定时器中断时递增。注意 `kerneltrap` 先保存 `sepc`/`sstatus`，在 `yield()` 返回后恢复——因为 `yield()` → `sched()` → `swtch()` 可能修改这些 CSR。

#### 4.5.3 trampoline (`trampoline.S`)

`uservec`（用户态进入内核）：
1. 通过 `sscratch` 暂存 `a0`。
2. 将所有通用寄存器保存到 `TRAPFRAME` 页。
3. 从 trapframe 加载内核栈指针、hartid、`usertrap` 函数地址、内核页表地址。
4. `sfence.vma` + `csrw satp` 切换到内核页表。
5. `jalr t0` 调用 `usertrap()`。

`userret`（内核返回用户态）：
1. `csrw satp, a0` 切换到用户页表。
2. 从 `TRAPFRAME` 恢复所有寄存器。
3. `sret` 返回用户态。

关键：trampoline 页在用户和内核页表中映射到相同虚拟地址（`TRAMPOLINE`），保证页表切换过程中指令流不中断。

#### 4.5.4 PLIC 中断控制器 (`plic.c`)

```c
void plicinit(void) {
    // 设置 UART0_IRQ(10) 和 VIRTIO0_IRQ(1) 的优先级为 1
    *(uint32*)(PLIC + UART0_IRQ*4) = 1;
    *(uint32*)(PLIC + VIRTIO0_IRQ*4) = 1;
}

void plicinithart(void) {
    int hart = cpuid();
    // 设置 S-mode 优先级阈值为 0
    // 使能该 hart 的两个中断源
    *(uint32*)PLIC_SENABLE(hart) = (1 << UART0_IRQ) | (1 << VIRTIO0_IRQ);
    *(uint32*)PLIC_SPRIORITY(hart) = 0;
}

int plic_claim(void) { return *(uint32*)PLIC_SCLAIM(cpuid()); }
void plic_complete(int irq) { *(uint32*)PLIC_SCLAIM(cpuid()) = irq; }
```

简洁的 PLIC 驱动，仅支持两个设备。使用 hart 索引寻址对应的使能和阈值寄存器。

#### 4.5.5 时钟中断处理

```c
void clockintr() {
    if(cpuid() == 0) {         // 仅 hart 0 维护全局 ticks
        acquire(&tickslock);
        ticks++;
        wakeup(&ticks);
        release(&tickslock);
    }
    w_stimecmp(r_time() + 1000000);  // 下一次中断 ≈ 0.1 秒后
}
```

- 使用 SSTC 的 `stimecmp` CSR 设置下次中断时间。
- `1000000` 个时间单位 ≈ 0.1 秒（假设 10MHz 时钟频率，QEMU 默认）。
- 仅 hart 0 更新全局 `ticks` 计数器，避免多核竞争。

---

### 4.6 系统调用子系统

#### 4.6.1 系统调用分发 (`syscall.c`)

```c
static uint64 (*syscalls[])(void) = {
    [SYS_fork]    sys_fork,
    [SYS_exit]    sys_exit,
    // ... 共 28 个系统调用
    [SYS_times]   sys_times,
};

void syscall(void) {
    int num = p->trapframe->a7;
    if(num > 0 && num < NELEM(syscalls) && syscalls[num]) {
        p->trapframe->a0 = syscalls[num]();
    } else {
        printf("%d %s: unknown sys call %d\n", p->pid, p->name, num);
        p->trapframe->a0 = -1;
    }
}
```

- 系统调用号通过 `a7` 寄存器传递（RISC-V 调用约定）。
- `syscalls[]` 是稀疏数组（designated initializer 语法），最大索引 = 173（`SYS_getppid`）。
- 参数提取：`argint(n, &ip)` 从 trapframe 的 `a0-a5` 获取第 n 个参数。
- 地址参数：`argaddr(n, &ip)` 仅做类型转换，合法性由后续 `copyin`/`copyout` 检查。

**已知 BUG-7**：`syscalls[]` 数组大小由 `NELEM` 决定。`SYS_getppid=173` 是最大编号，因此数组约 174 个槽位。竞赛要求支持编号到 260（`wait4`）的系统调用，当前实现拒绝所有编号 ≥ 174 的调用。

**已知 BUG-8**：10 个标准系统调用编号与 Linux RISC-V ABI 不符：
- `read=5` 应为 `63`，`write=16` 应为 `64`，`open=15` 应为 `56`，`close=21` 应为 `57`，`fstat=8` 应为 `80`，`dup=10` 应为 `23`，`chdir=9` 应为 `49`，`exec=7` 应为 `221`，`exit=2` 应为 `93`，`getpid=11` 应为 `172`。

这些是 xv6 的历史遗留编号，与 POSIX/Linux 系统调用编号体系不同。

#### 4.6.2 标准 pv6 系统调用实现 (`sysproc.c` + `sysfile.c`)

所有 pv6 标准系统调用保持 MIT 6.1810 的实现不变：
- `fork`, `exit`, `wait`, `pipe`, `read`, `write`, `close`, `kill`, `exec`, `fstat`, `chdir`, `dup`, `getpid`, `sbrk`, `pause`, `uptime`, `open`, `mknod`, `unlink`, `link`, `mkdir`

#### 4.6.3 新增系统调用详解

**(a) `myFirstCall` (编号 22)**

```c
uint64 sys_myFirstCall(void) { return 22; }
```
最简单的测试桩，直接返回常量 22。

**(b) `getppid` (编号 173)**

```c
uint64 sys_getppid(void) { return myproc()->parent->pid; }
```
直接返回父进程 PID。**已知 BUG-9**：未检查 `parent != NULL`。若 init 进程（其 `parent==NULL`）调用则 panic。

**(c) `sched_yield` (编号 124)**

```c
uint64 sys_sched_yield(void) { yield(); return 0; }
```
主动让出 CPU。与 Linux `sched_yield` 语义一致。

**(d) `uname` (编号 160)**

```c
uint64 sys_uname(void) {
    // 填充 utsname 结构体
    safestrcpy(temp.sysname, "xv6", 65);
    safestrcpy(temp.nodename, "xv6", 65);
    safestrcpy(temp.release, "1.0", 65);
    safestrcpy(temp.version, "2026", 65);
    safestrcpy(temp.machine, "riscv64", 65);
    copyout(..., &temp, sizeof(temp));
}
```
返回硬编码的系统信息。结构体各字段 65 字节，总 325 字节。

**(e) `gettimeofday` (编号 169)**

```c
uint64 sys_gettimeofday(void) {
    timespec time;
    uint64 temp = sys_uptime();
    time.tv_sec = temp / 10;           // ticks → 秒 (10 ticks/秒)
    time.tv_nsec = (temp % 10) * 100000000;  // 剩余 ticks → 纳秒
    copyout(..., &time, sizeof(time));
}
```

**已知 BUG-5**：使用了 `timespec`（`tv_sec + tv_nsec`）而非 `timeval`（`tv_sec + tv_usec`）。POSIX `gettimeofday` 应使用 `timeval`，但此处错误地用了 `timespec`。这导致 `tv_nsec` 字段的值单位是纳秒而非微秒，且结构体名称/语义与 POSIX 标准不符。

**(f) `times` (编号 153)**

```c
uint64 sys_times(void) {
    tms time = myproc()->time;
    copyout(..., &time, sizeof(time));
    return ticks;
}
```
返回当前进程的时间统计和当前 ticks。POSIX `times()` 返回的是自系统启动以来的时钟滴答数。

**(g) `getcwd` (编号 17)**

```c
uint64 sys_getcwd(void) {
    char path[20][14];   // 最多 20 层，每层目录名最多 14 字节
    struct inode* now = idup(myproc()->cwd);
    ilock(now);
    while(now->inum != ROOTINO) {  // 从当前目录向上遍历到根
        struct inode* parent = dirlookup(now, "..", 0);
        ilock(parent);
        // 在 parent 中查找指向 now 的目录项
        for(off = 0; off < parent->size; off += sizeof(de)) {
            readi(parent, 0, (uint64)&de, off, sizeof(de));
            if(de.inum == now->inum) break;
        }
        safestrcpy(path[i], de.name, sizeof(de.name));
        iunlock(now); iput(now);
        now = parent;
    }
    // 拼接: "/" + path[n-1] + "/" + path[n-2] + ...
    copyout(..., "/", 2);
    while(i) {
        i--;
        copyout(..., path[i], strlen(path[i]));
        if(i > 0) copyout(..., "/", 2);
    }
}
```

**已知 BUG-1, BUG-2, BUG-4, BUG-6**：
- BUG-1：while 循环内路径拼接逻辑混乱（`buf++` 和 `buf += strlen` 导致偏移错误）。
- BUG-2：持有 `now->lock` 时调用 `ilock(parent)`——若 `parent` 恰是 `now` 的祖先且被另一个查找锁定，可能死锁。标准 xv6 的 `namex` 采用`ip = dirlookup(...)` 后 `iunlockput(dp)` 再 `ilock(ip)` 的模式避免此问题。
- BUG-4：根目录的 `copyout` 写入了 `strlen("/")+1 = 2` 字节包含 '\0'，但在后续循环中进行 `buf++`，导致路径中间可能出现空洞。
- BUG-6：`path[20][14]` 硬编码 20 层深度和 14 字节名字（`DIRSIZ=14`），超出时静默返回。

**(h) `sbrk` 修改（编号 12）**

```c
uint64 sys_sbrk(void) {
    argint(0, &n); argint(1, &t);  // t = SBRK_EAGER(1) 或 SBRK_LAZY(2)
    if(t == SBRK_EAGER || n < 0)
        return growproc(n);       // 立即分配/释放
    else
        myproc()->sz += n;        // 仅增加虚拟大小（延迟分配）
    return addr;
}
```

`vm.h` 中定义：
```c
#define SBRK_EAGER 1
#define SBRK_LAZY  2
```

用户态库提供两个封装：
```c
char *sbrk(int n)      { return sys_sbrk(n, SBRK_EAGER); }
char *sbrklazy(int n)  { return sys_sbrk(n, SBRK_LAZY); }
```

---

### 4.7 文件系统子系统

#### 4.7.1 磁盘布局

```
[ boot block(0) | superblock(1) | log blocks(2..31) | inode blocks(32..44) | bitmap(45) | data blocks(46..1999) ]
```

- 块大小：`BSIZE = 1024` 字节。
- 超级块定义：
```c
struct superblock {
    uint magic;       // FSMAGIC = 0x10203040
    uint size;        // 总块数 (2000)
    uint nblocks;     // 数据块数
    uint ninodes;     // inode 数 (200)
    uint nlog;        // 日志块数 (LOGBLOCKS+1=31)
    uint logstart;    // 日志起始块 (2)
    uint inodestart;  // inode 起始块 (33)
    uint bmapstart;   // 位图起始块 (46)
};
```

#### 4.7.2 inode 管理

**磁盘 inode (`dinode`)**：
```c
struct dinode {
    short type;                      // T_FILE=2, T_DIR=1, T_DEVICE=3
    short major, minor;              // 设备号
    short nlink;                     // 硬链接数
    uint size;                       // 文件大小（字节）
    uint addrs[NDIRECT+1];           // NDIRECT=12 直接块 + 1 个间接块
};
```

最大文件大小：`(12 + 1024/4) * 1024 = (12+256) * 1024 = 268 KB`。

**内存 inode (`inode`)**：
```c
struct inode {
    uint dev, inum;
    int ref;              // 引用计数（受 itable.lock 保护）
    struct sleeplock lock; // 保护以下字段
    int valid;            // 磁盘数据是否已加载
    short type, major, minor, nlink;
    uint size;
    uint addrs[NDIRECT+1];
};
```

inode 表大小：`NINODE=50`，同时最多 50 个活跃 inode。

**inode 生命周期**：
1. `iget(dev, inum)` — 在表中查找或分配空槽位，`ref++`。
2. `ilock(ip)` — 获取睡眠锁，若 `!valid` 从磁盘读取。
3. `iunlock(ip)` — 释放睡眠锁。
4. `iput(ip)` — `ref--`，若 `ref==0 && nlink==0` 则释放磁盘块。

#### 4.7.3 目录结构

```c
struct dirent {
    ushort inum;         // inode 编号（0 表示空闲）
    char name[DIRSIZ];   // 文件名（最多 14 字节，不含 '\0'）
};
```

路径查找 `namex(path, nameiparent, name)`：
- 从 `ROOTINO`（根 inode 1）或当前目录开始。
- 逐级 `dirlookup`，对每个 `..` 条目特殊处理。
- 若 `nameiparent` 为真，返回父目录 inode 并在 `name` 中写入最后一级文件名。

#### 4.7.4 日志系统 (`log.c`)

**设计**：物理重做日志（physical redo log），支持并发的文件系统调用。

**核心数据结构**：
```c
struct log {
    struct spinlock lock;
    int start;           // 日志区域起始块号
    int outstanding;     // 正在执行的 FS 系统调用数
    int committing;      // 正在提交中
    int dev;
    struct logheader lh; // 内存中的日志头部
};
struct logheader {
    int n;               // 已记录的块数
    int block[LOGBLOCKS]; // LOGBLOCKS = MAXOPBLOCKS*3 = 30
};
```

**操作流程**：
1. `begin_op()` — 若日志空间不足或正在提交，则 `sleep`；否则 `outstanding++`。
2. `log_write(bp)` — 将块号记录到 `lh.block[]`，通过 `bpin` 防止块缓存回收。
3. `end_op()` — `outstanding--`；若为 0 则 `commit()`。
4. `commit()` — `write_log()`（复制缓存块到日志区）→ `write_head()`（真正的提交点）→ `install_trans()`（复制日志块到原位）→ `write_head()`（清零日志）。

**崩溃恢复** (`recover_from_log`)：
- 启动时调用，若日志头部 `n > 0`（上次崩溃前已提交），则将日志块复制到原位。

#### 4.7.5 磁盘块缓存 (`bio.c`)

**LRU 链表** + 睡眠锁：

```c
struct {
    struct spinlock lock;
    struct buf buf[NBUF];      // NBUF = MAXOPBLOCKS*3 = 30
    struct buf head;           // 双向链表哨兵
} bcache;
```

- `bget(dev, blockno)` — 先搜索缓存命中（从 head.next 向 tail 遍历），未命中则从 tail.prev（最久未使用）回收。
- `bread(dev, blockno)` — `bget` + 若 `!valid` 调用 `virtio_disk_rw(b, 0)`。
- `brelse(b)` — 释放睡眠锁，若 `refcnt==0` 移到链表头部（更新为最近使用）。
- `bpin`/`bunpin` — 增加/减少 `refcnt`，防止日志中的块被回收。

#### 4.7.6 文件描述符层 (`file.c`)

```c
struct file {
    enum { FD_NONE, FD_PIPE, FD_INODE, FD_DEVICE } type;
    int ref;
    char readable, writable;
    struct pipe *pipe;   // FD_PIPE
    struct inode *ip;    // FD_INODE / FD_DEVICE
    uint off;            // FD_INODE 偏移量
    short major;         // FD_DEVICE
};
```

全局打开文件表：`NFILE=100`，每进程最多 `NOFILE=16` 个 fd。

**`filewrite`** 的分块写入策略：
```c
int max = ((MAXOPBLOCKS-1-1-2) / 2) * BSIZE;  // 单次事务的最大写入量
```
每次循环限制写入 `max` 字节后 `begin_op/end_op`，防止单次写操作占满日志空间。

#### 4.7.7 管道 (`pipe.c`)

```c
struct pipe {
    struct spinlock lock;
    char data[PIPESIZE];    // PIPESIZE = 512
    uint nread, nwrite;
    int readopen, writeopen;
};
```

- 环形缓冲区，`nread` 和 `nwrite` 单调递增，通过 `% PIPESIZE` 取模。
- 满条件：`nwrite == nread + PIPESIZE`。
- 空条件：`nread == nwrite`。
- 读写均为阻塞操作，使用 `sleep`/`wakeup` 在 `&pi->nread` 和 `&pi->nwrite` 上同步。

---

### 4.8 设备驱动

#### 4.8.1 UART (`uart.c`)

- NS16550 兼容 UART，寄存器基址 `UART0 = 0x10000000`。
- 波特率：38.4K。
- 中断驱动发送：`uartwrite()` 在发送忙时 `sleep(&tx_chan)`，`uartintr()` 在发送完成时 `wakeup(&tx_chan)`。
- 轮询同步发送：`uartputc_sync(c)` 用于 `printf` 和 panic 时的紧急输出，直接忙等 `LSR_TX_IDLE`。
- 接收：`uartintr()` 中循环读取 RHR，逐字符调用 `consoleintr(c)`。

#### 4.8.2 virtio 磁盘 (`virtio_disk.c`)

- 基于 virtio-mmio 接口，寄存器基址 `VIRTIO0 = 0x10001000`。
- 使用 3 个描述符链：请求头（`virtio_blk_req`）+ 数据缓冲区（`b->data`）+ 状态字节。
- `NUM` 个描述符（定义在 `virtio.h`，推测为 8），`alloc3_desc` 分配 3 个连续描述符。
- 同步 I/O：`virtio_disk_rw()` 提交请求后 `sleep(b)` 等待完成中断，`virtio_disk_intr()` 检查 `used` 环并 `wakeup(b)`。

#### 4.8.3 控制台 (`console.c`)

```c
struct {
    struct spinlock lock;
    char buf[INPUT_BUF_SIZE];  // 128 字节
    uint r, w, e;              // 读、写、编辑索引
} cons;
```

- 行缓冲输入，支持特殊字符：
  - `Ctrl-H` / Delete：退格
  - `Ctrl-U`：清空当前行
  - `Ctrl-D`：EOF
  - `Ctrl-P`：打印进程列表（`procdump()`）
- `consoleread`：阻塞等待整行（以 `\n` 结尾）或 EOF。
- `consolewrite`：将用户数据通过 `uartwrite` 分块输出（32 字节一批）。
- 通过 `devsw[CONSOLE]` 注册为设备，供 `file.c` 的 `fileread`/`filewrite` 调用。

---

### 4.9 ELF 加载器 (`exec.c`)

```c
int kexec(char *path, char **argv) {
    // 1. namei(path) 打开可执行文件
    // 2. 读取 ELF 头，验证 magic
    // 3. proc_pagetable(p) 创建新页表
    // 4. 遍历 program headers，uvmalloc + loadseg 加载各段
    // 5. 分配用户栈 (USERSTACK+1 页，含 1 页 guard page)
    // 6. 将 argv 字符串和指针数组 copyout 到用户栈
    // 7. 设置 trapframe->epc = elf.entry, sp = 用户栈顶
    // 8. 切换 pagetable，释放旧页表
}
```

- 支持 flags→PTE 权限映射：`PF_X → PTE_X`, `PF_W → PTE_W`。
- 用户栈有 1 页保护页（`uvmclear` 清除 PTE_U 标志）用于检测栈溢出。
- `USERSTACK=1`（仅 1 页栈），对于大多数 xv6 简单程序足够。

---

### 4.10 用户空间

#### 4.10.1 系统调用桩生成 (`usys.pl`)

Perl 脚本自动生成 `usys.S`：
```asm
fork:
    li a7, SYS_fork
    ecall
    ret
```

每个系统调用 3 条指令：加载调用号到 `a7`，`ecall` 陷入内核，`ret` 返回。

特殊处理：`sbrk` 生成为 `sys_sbrk`（因为 C 库需要封装为 `sbrk(n)` 和 `sbrklazy(n)`）。

#### 4.10.2 用户库 (`ulib.c`, `umalloc.c`, `printf.c`)

- **字符串函数**：`strcpy`, `strcmp`, `strlen`, `strchr`, `memset`, `memmove`, `memcpy`, `memcmp`, `atoi`。
- **I/O**：`gets`（逐字符 `read(0, ...)`），`stat`（`open` + `fstat` + `close`）。
- **malloc/free**：K&R 风格的隐式空闲链表分配器，`morecore` 通过 `sbrk` 扩展堆。
- **`sbrk`** 封装为 `sbrk(n)`（eager）和 `sbrklazy(n)`（lazy）。

#### 4.10.3 Shell (`sh.c`)

经典的 xv6 shell，支持：
- 命令执行：`EXEC`
- I/O 重定向：`REDIR` (`>`, `<`)
- 管道：`PIPE` (`|`)
- 命令列表：`LIST` (`;`)
- 后台执行：`BACK` (`&`)
- 内建命令：`cd`

解析器约 400 行，采用递归下降法。

#### 4.10.4 用户测试程序

- `usertests.c` (~3197 行)：标准 xv6 用户态测试套件。
- `myCall.c`：竞赛新增系统调用的综合测试。
- `forktest.c` / `forphan.c` / `dorphan.c` / `zombie.c`：进程相关测试。
- `logstress.c` / `stressfs.c`：文件系统压力测试。
- `grind.c`：随机系统调用压力测试。

---

## 五、子系统之间的交互

### 5.1 系统调用完整路径

以 `getcwd(buf, size)` 为例：

1. **用户态**：`getcwd` → `li a7, 17; ecall`（`usys.S` 生成的桩）。
2. **trampoline**：`uservec` 保存寄存器，切换到内核页表，`jalr usertrap`。
3. **trap.c**：`usertrap()` 识别 `scause=8`，调用 `syscall()`。
4. **syscall.c**：`syscall()` 从 `a7` 取调用号 17，调用 `sys_getcwd()`。
5. **sysproc.c**：`sys_getcwd()`：
   - `argaddr(0, &buf)` / `argint(1, &size)` — 从 trapframe 提取参数。
   - `idup(myproc()->cwd)` — 引用当前目录 inode。
   - `ilock(now)` → `dirlookup(now, "..", 0)` — 向上遍历目录树（**fs.c**）。
   - `readi(parent, 0, &de, off, sizeof(de))` — 读取目录项（**fs.c** → **bio.c** → **virtio_disk.c**）。
   - `copyout(p->pagetable, buf, path[i], ...)` — 写回用户空间（**vm.c**）。
6. **trap.c**：`usertrapret()` 设置返回环境，跳转到 `userret`。
7. **trampoline**：`userret` 切换用户页表，恢复寄存器，`sret`。

### 5.2 进程创建与调度交互

```
fork() → kfork() → allocproc() → uvmcopy() → 子进程 RUNNABLE
                              ↓
                          scheduler() → swtch() → 子进程 RUNNING → forkret() → usertrapret() → 用户态
```

### 5.3 中断处理路径

```
时钟中断 → kernelvec → kerneltrap() → devintr() → clockintr()
    → ticks++ (仅 hart 0)
    → tms_stime++ 或 tms_utime++
    → yield() → sched() → swtch() → 下一个进程
```

### 5.4 文件系统写入路径

```
write(fd, buf, n) → sys_write() → filewrite() → writei() → bmap() → balloc()/bread()
    → log_write(bp) → brelse(bp)
    → begin_op() ... end_op() → commit() → write_log() → write_head() → install_trans()
```

---

## 六、整体实现完整度评估

### 6.1 核心 OS 功能

| 功能 | 完整度 | 说明 |
|------|--------|------|
| 多核支持 | 100% | SMP，最多 8 核，通过自旋锁和 `started` 标志同步 |
| 虚拟内存 | 100% | Sv39 三级页表，内核直接映射，用户独立地址空间 |
| 进程管理 | 95% | 完整 6 状态模型，fork/exec/wait/exit/kill 完备；缺进程组和会话 |
| 调度 | 70% | 基础 RR 调度，无优先级/时间片/多级队列 |
| 文件系统 | 95% | V6 风格完整实现，含日志崩溃恢复；缺符号链接、扩展属性、ACL |
| 管道 | 100% | 匿名管道，阻塞读写 |
| 同步 | 100% | 自旋锁 + 睡眠锁 + sleep/wakeup |
| 中断处理 | 100% | PLIC + 时钟 + UART + virtio |

### 6.2 竞赛系统调用覆盖度

基于开发日志对 30 个竞赛要求的对比：

| 类别 | 数量 | 详情 |
|------|------|------|
| 完全正确 | 5 | getppid(173), times(153), uname(160), sched_yield(124), gettimeofday(169, 但有类型 bug) |
| 有 bug 但基本可用 | 2 | getcwd(17, 路径重建 bug), sbrk(12, 延迟分配) |
| 功能存在但编号错误 | 10 | read/write/open/close/fstat/dup/chdir/execve/exit/getpid |
| 完全未实现 | 14 | dup3, openat, getdents64, linkat, unlinkat, mkdirat, umount2, mount, clone, wait4, brk(214), munmap, mmap, nanosleep |

**整体评估**：对于基于 xv6 的竞赛项目，核心 OS 机制完备，但系统调用兼容性是主要短板——10 个标准调用编号与 Linux ABI 不匹配，14 个调用完全缺失。

---

## 七、设计创新性分析

### 7.1 延迟内存分配（Lazy Allocation）

**创新点**：在标准 xv6（MIT 6.1810 2024 版已包含此特性）基础上，提供了 `sbrk(n, mode)` 的双模式接口：
- `SBRK_EAGER`：传统立即分配模式
- `SBRK_LAZY`：仅增加虚拟大小，缺页时由 `vmfault` 分配

**实现细节**：`vmfault` 被整合到 `copyin`/`copyout` 路径中，使得内核在访问用户空间时能自动触发延迟分配。`usertrap` 中的缺页处理分支也调用了 `vmfault`。

### 7.2 CPU 时间统计

在标准 xv6 基础上新增了 `tms` 结构体和 `times` 系统调用：
- 在 `usertrap` 的时钟中断分支中递增 `tms_utime`
- 在 `kerneltrap` 的时钟中断分支中递增 `tms_stime`
- 在 `kexit` 中将子进程时间累计到父进程 `tms_cutime`/`tms_cstime`
- 在 `kwait` 中进一步传递孙进程时间

### 7.3 SSTC 定时器扩展

使用 RISC-V Sstc 扩展（`stimecmp` CSR）替代传统的 CLINT 内存映射定时器。`start.c` 中通过 `menvcfg` 的 STCE 位使能，并通过 `mcounteren` 授权 S-mode 访问 `time` CSR。

### 7.4 新增系统调用的自主实现

`getcwd`、`uname`、`gettimeofday`、`times` 均为从零实现的系统调用，非 xv6 原有代码。其中 `getcwd` 的设计思路（向上遍历目录树并通过 `dirlookup(parent, "..")` 定位）是正确的，但实现存在路径拼接 bug。

### 7.5 创新性总结

该项目的创新性主要体现在**功能扩展**而非**架构创新**。内核架构保持 xv6 的简洁宏内核设计。主要创新工作集中在：
1. 新增 8 个系统调用
2. 延迟内存分配的双模式接口
3. CPU 时间统计
4. 使用现代 RISC-V 扩展（SSTC）

整体创新程度：**中等偏低**。大部分工作是在成熟的 xv6 基础上进行增量开发。

---

## 八、已知缺陷汇总

### 8.1 严重缺陷

| 编号 | 位置 | 描述 | 影响 |
|------|------|------|------|
| BUG-1 | `sysproc.c:sys_getcwd` | 路径拼接逻辑错误（`buf++` 和 `buf += strlen` 重复递增） | `getcwd` 返回错误路径 |
| BUG-2 | `sysproc.c:sys_getcwd` | 持有 `now->lock` 时调用 `ilock(parent)` | 潜在死锁 |
| BUG-3 | `proc.c:kexit` | `release(&wait_lock)` 后访问 `p->parent` | use-after-free 竞态 |
| BUG-5 | `sysproc.c:sys_gettimeofday` | 使用 `timespec` 而非 `timeval` | 与 POSIX 语义不兼容 |

### 8.2 中等缺陷

| 编号 | 位置 | 描述 |
|------|------|------|
| BUG-4 | `sys_getcwd` | 根目录 copyout 未正确处理 `\0` |
| BUG-6 | `sys_getcwd` | `path[20][14]` 硬编码限制 |
| BUG-7 | `syscall.c` | `syscalls[]` 数组不支持编号 ≥ 174 |
| BUG-8 | `syscall.h` | 10 个调用编号与 Linux RISC-V ABI 不符 |
| BUG-9 | `sysproc.c:sys_getppid` | 未检查 `parent != NULL` |

---

## 九、其他补充信息

### 9.1 Makefile 工具链检测

Makefile 自动检测 4 种可能的工具链前缀：`riscv64-unknown-elf-`、`riscv64-elf-`、`riscv64-linux-gnu-`、`riscv64-unknown-linux-gnu-`。

### 9.2 QEMU 版本要求

要求 `qemu-system-riscv64 >= 7.2`（SSTC 扩展需要较新版本）。Makefile 中有 `check-qemu-version` 目标进行版本校验。

### 9.3 测试基础设施

- `test-xv6.py`：Python 自动化测试脚本，支持 `usertests`、崩溃恢复测试（`crash`/`log`）、孤儿文件测试（`forphan`/`dorphan`）。
- `testsuits-for-oskernel/`：竞赛测试套件目录，当前为空。

### 9.4 已知问题记录

开发日志（`.workbuddy/memory/`）中详细记录了开发过程中的调查和 bug 识别，共 5 篇日志涵盖系统结构总结、调度器分析、系统调用满足度评估、bug 全面检查等。

---

## 十、总结

**OSKernel2026-SGYB** 是一个基于 **xv6-riscv**（MIT 6.1810 教学操作系统）修改而来的竞赛型 OS 内核项目。项目在 xv6 的简洁宏内核框架上进行了增量开发，总计约 11,858 行代码（含用户空间），运行于 RISC-V 64 位 QEMU `virt` 平台。

**优势**：
- 构建系统健壮，多工具链自动适配，编译零警告零错误。
- 核心 OS 机制完备：Sv39 虚拟内存、6 状态进程模型、V6 文件系统（含日志崩溃恢复）、多核 SMP 支持。
- 成功新增了 8 个系统调用（`getcwd`、`getppid`、`uname`、`gettimeofday`、`times`、`sched_yield`、`myFirstCall`、`mknod`）并修改了 `sbrk` 支持延迟分配。
- 延迟内存分配的 `vmfault` 机制正确集成在缺页异常和 `copyin`/`copyout` 路径中。
- 使用现代 RISC-V 扩展（SSTC 定时器），替代了传统 CLINT。
- 基本功能在 QEMU 上通过验证。

**不足**：
- 系统调用编号与 Linux RISC-V ABI 不兼容（10 个标准调用编号错误），这是竞赛环境下的关键缺陷，将导致大量测试程序无法正确运行。
- `syscalls[]` 数组仅支持到索引 173，无法支持编号 174-260 的系统调用。
- `getcwd` 实现存在路径拼接 bug 和潜在死锁。
- `gettimeofday` 使用了错误的结构体类型（`timespec` vs `timeval`）。
- `kexit` 中存在时间累计的 use-after-free 竞态条件。
- 有 14 个竞赛要求的系统调用完全未实现（`mmap`/`munmap`/`clone`/`wait4` 等）。
- 调度器简单（纯 RR），无优先级或高级调度策略。
- 无写时复制（COW），`fork` 时完整深拷贝内存。

**综合评价**：该项目成功演示了在 xv6 教学内核上扩展系统调用和内存管理特性的能力，但在面向竞赛的系统调用兼容性方面存在显著短板。若将系统调用编号修正、数组扩容、并修复已识别的 bug（尤其是 BUG-1/2/3/5），该项目可以成为一个功能更完备的竞赛作品。