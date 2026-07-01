# ruaruaos 内核项目深度技术分析报告

## 一、项目概述

ruaruaos 是一个面向 RISC-V 64 位架构（rv64gc）的教学/竞赛级操作系统内核，由天津大学的李福鹏开发。项目基于 xv6-riscv 进行深度改造和扩展，运行于 QEMU virt 机器平台，同时提及 K210 硬件支持。内核加载地址为 `0x80200000`，内存配置为 128MB，支持最多 2 个 SMP 核心（Makefile 中 QEMU 参数 `-smp 2`，但代码中 `NCPU` 定义为 8）。

---

## 二、分析过程与方法

本次分析采用以下方法：

1. **源码逐文件阅读**：对仓库中所有 C 源文件（约 25 个）、汇编文件（约 8 个）和头文件（约 20 个）进行了完整阅读。
2. **构建系统分析**：分析了 Makefile、链接脚本 `os.ld`、SBI 固件构建流程。
3. **数据结构与接口分析**：对所有关键头文件（`proc.h`、`fs.h`、`file.h`、`memlayout.h`、`syscall.h`、`shm.h`、`signal.h`、`futex.h`、`pselect.h`、`sysmount.h`、`sysinfo.h`）进行了详细分析。
4. **子系统交互追踪**：通过系统调用入口、trap 处理路径、进程调度路径等关键调用链进行了跨文件追踪。

**测试说明**：仓库中未包含 `sdcard.img` 磁盘镜像文件，且 `mkfs.c` 是 xv6 原始的文件系统镜像制作工具（与内核中实际使用的 ext4 文件系统不匹配），无法在环境中构建出可运行的磁盘镜像。因此未进行 QEMU 运行时测试。预编译的 `kernel-qemu` 和 `sbi-qemu` 二进制文件存在于仓库中。

---

## 三、子系统详细拆解

### 3.1 启动引导子系统

**源文件**：`sbi/boot.S`、`sbi/timer.c`、`sbi/timervec.S`、`start.S`、`entry.S`

**实现细节**：

项目包含一个自研的 SBI（Supervisor Binary Interface）固件，运行在 M-mode（机器模式），负责将 CPU 从 M-mode 切换到 S-mode 并跳转到内核入口。

**SBI 固件启动流程**（`sbi/boot.S`）：

```asm
_start:
    la sp, stack0
    li a0, 1024*4
    csrr a1, mhartid
    bnez a1, _sti          # 非0号核心进入wfi等待
    addi a1, a1, 1
    mul a0, a0, a1
    add sp, sp, a0
    # 配置 mstatus：设置 MPP 为 S-mode (0b10)
    csrr t6, mstatus
    li t5, -6145
    and t6, t5, t6
    li t5, 1024 * 2
    or t6, t5, t6
    li t5, 0x00006000
    or t6, t6, t5
    csrw mstatus, t6
    csrw mepc, t5          # 设置 mepc = 0x80200000
    csrw satp, t5          # 关闭分页
    csrw medeleg, t5       # 委托异常到S-mode
    csrw mideleg, t5       # 委托中断到S-mode
    csrw pmpcfg0, t5       # PMP 配置：全权限
    call timerinit         # 初始化定时器
    mret                   # 跳转到S-mode
```

SBI 固件的关键特性：
- 配置 PMP（Physical Memory Protection）为全访问权限
- 委托所有异常和中断到 S-mode（`medeleg`/`mideleg` 设为 `0xffff`）
- 初始化 M-mode 定时器中断，间隔为 `1000000 / 5 = 200000` 个时钟周期
- 定时器中断处理（`timervec.S`）通过设置 `sip` 寄存器的 SSIP 位触发 S-mode 软件中断

**内核入口**（`start.S`）：

```asm
_start_kernel:
    add t0, a0, 1
    slli t0, t0, 14        # 每个核心栈大小 16KB
    la sp, boot_stack
    add sp, sp, t0
    call start_boot        # 跳转到C语言入口
```

**完整度评估**：60%。SBI 固件功能极简，仅实现了定时器中断转发和基本的 M-mode 到 S-mode 切换。缺少 SBI 标准规范中的 console 服务、IPI 服务、HSM（Hart State Management）等。非 0 号核心在 SBI 中直接进入 `wfi` 死循环，不参与内核启动。

---

### 3.2 内核初始化子系统

**源文件**：`kernel.c`

**实现细节**：

内核初始化由 `start_boot()` 函数完成，仅在 0 号核心（hart 0）上执行主初始化序列：

```c
void start_boot(void) {
    if(cpuid() == 0) {
        consoleinit();       // 控制台初始化
        kinit();             // 物理页分配器
        kvminit();           // 内核页表
        kvminithart();       // 开启分页
        procinit();          // 进程表
        trapinit();          // trap 向量
        trapinithart();      // 安装内核 trap 向量
        plicinit();          // PLIC 中断控制器
        plicinithart();      // PLIC 中断使能
        binit();             // 块缓存
        initlogbuffer();     // 日志缓冲区
        iinit();             // inode 表
        fileinit();          // 文件表
        virtio_disk_init();  // VirtIO 磁盘
        userinit();          // 第一个用户进程
        threadinit();        // 线程池初始化
        started = 1;         // 通知其他核心
    } else {
        while(started == 0); // 等待0号核心完成
        kvminithart();
        trapinithart();
        plicinithart();
    }
    scheduler();             // 进入调度循环
}
```

**完整度评估**：70%。初始化序列完整覆盖了 xv6 的所有子系统，并增加了线程池初始化。但存在以下问题：
- 非 0 号核心的初始化依赖忙等待（`while(started == 0)`），缺少内存屏障优化（虽然有 `__sync_synchronize`）
- 非 0 号核心在 SBI 阶段就进入了 `wfi` 死循环，实际上无法到达 `start_boot` 的 else 分支，意味着多核支持实际上不工作

---

### 3.3 内存管理子系统

**源文件**：`kalloc.c`、`vm.c`、`page.c`

#### 3.3.1 物理页分配器（kalloc.c）

采用经典的空闲链表实现：

```c
struct run {
    struct run *next;
};

struct {
    struct spinlock lock;
    struct run *freelist;
    uint64_t npage;
} kmem;
```

- 管理范围：从内核 `end` 符号到 `PHYSTOP`（`0x80000000 + 128MB`）
- 页大小：4096 字节
- `kfree()` 释放时将页面内容填充为 `1`（调试用途）
- `kalloc()` 分配时将页面内容填充为 `5`（调试用途）
- 提供 `freemem_amount()` 查询空闲内存量

#### 3.3.2 备用页分配器（page.c）

实现了一个基于页描述符的连续页分配器，但**未被内核使用**（`page_init()` 在 `kernel.c` 中被注释掉）：

```c
struct Page {
    uint8_t flags;  // PAGE_TAKEN | PAGE_LAST
};
```

该分配器使用线性扫描查找连续空闲页，支持分配和释放任意数量的连续物理页。设计上可管理最多 128MB 内存。

#### 3.3.3 虚拟内存管理（vm.c）

**内核页表**：

```c
pagetable_t kvmmake(void) {
    kpgtbl = (pagetable_t) kalloc();
    kvmmap(kpgtbl, Uart0, Uart0, PGSIZE, PTE_R | PTE_W);       // UART MMIO
    kvmmap(kpgtbl, VIRTIO0, VIRTIO0, PGSIZE, PTE_R | PTE_W);   // VirtIO MMIO
    kvmmap(kpgtbl, PLIC, PLIC, 0x400000, PTE_R | PTE_W);       // PLIC
    kvmmap(kpgtbl, KERNBASE, KERNBASE, etext-KERNBASE, PTE_R | PTE_X);  // 内核代码段
    kvmmap(kpgtbl, etext, etext, PHYSTOP-etext, PTE_R | PTE_W); // 内核数据段
    kvmmap(kpgtbl, TRAMPOLINE, trampoline, PGSIZE, PTE_R | PTE_X); // Trampoline
    proc_mapstacks(kpgtbl);  // 为每个进程映射内核栈
}
```

内核采用 Sv39 三级页表，直接映射（identity mapping）方式。

**页表遍历**（`walk` 函数）：

```c
pte_t * walk(pagetable_t pagetable, uint64_t va, int alloc) {
    for(int vm_l = 2; vm_l > 0; vm_l--) {
        pte_t *pte = &pagetable[PX(vm_l, va)];
        if(*pte & PTE_V) {
            pagetable = (pagetable_t) PTE2PA(*pte);
        } else {
            if(!alloc || (pagetable = ((pde_t *) kalloc())) == 0)
                return 0;
            memset(pagetable, 0, PGSIZE);
            *pte = PA2PTE(pagetable) | PTE_V;
        }
    }
    return &pagetable[PX(0, va)];
}
```

**用户地址空间布局**（来自 `memlayout.h`）：

| 区域 | 虚拟地址 |
|------|---------|
| Trampoline | `MAXVA - PGSIZE`（最高地址） |
| Trapframe | `TRAMPOLINE - PGSIZE` |
| Signal Trampoline | `TRAPFRAME - PGSIZE` |
| 内核栈 | `TRAMPOLINE - (p+1)*2*PGSIZE` |
| 用户空间 | `0x00000000` ~ `MAXUVA (0x80000000)` |

**mappages 函数存在异常**：

```c
*pte = PA2PTE(pa) | perm | PTE_V;
*pte = PA2PTE(pa) | perm | PTE_V;  // 重复写入三次
*pte = PA2PTE(pa) | perm | PTE_V;
```

这是一个明显的调试遗留，同一赋值被执行了三次，虽然功能上不影响正确性，但反映了代码质量较低。

**walkaddr 函数存在逻辑问题**：

```c
pa_t walkaddr(pagetable_t pagetable, uint64_t va) {
    pte = walk(pagetable, va, 0);
    if(!pte || !(*pte & PTE_V) || !(*pte & PTE_U)) {
        pa = PTE2PA(*pte);  // 即使pte无效也返回PA
        return pa;
    }
    pa = PTE2PA(*pte);
    return pa;
}
```

当 PTE 无效或无 U 位时，函数仍然返回物理地址，这可能导致访问无效内存。

**完整度评估**：55%。基本的物理页分配和虚拟内存管理已实现，但存在以下不足：
- 无 buddy 分配器或 slab 分配器
- 无 COW（Copy-on-Write）机制，`uvmcopy` 采用完整物理页拷贝
- `walkaddr` 存在安全隐患
- 备用的 `page.c` 分配器未被集成
- 无内存回收/交换机制

---

### 3.4 进程管理子系统

**源文件**：`proc.c`、`thread.c`

#### 3.4.1 进程结构

```c
struct proc {
    struct spinlock lock;
    enum procstate state;       // UNUSED/USED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE
    void *chan;                 // 睡眠通道
    int killed;                 // kill 标志
    int xstate;                 // 退出状态
    int pid;                    // 进程 ID
    int uid, gid, pgid;        // 用户/组/进程组 ID
    struct proc *parent;
    thread *main_thread;       // 主线程
    thread *thread_queue;      // 线程队列
    uint64_t kstack;           // 内核栈
    uint64_t sz;               // 进程大小
    pagetable_t pagetable;     // 用户页表
    pagetable_t kpagetable;    // 内核页表（未使用）
    struct trapframe *trapframe;
    struct context context;
    struct file *ofile[NOFILE]; // 文件描述符表（NOFILE=128）
    struct inode *cwd;         // 当前目录
    char name[16];
    int thread_num;
    sigaction sigaction[SIGRTMAX + 1]; // 信号处理表（65个信号）
    __sigset_t sig_set;        // 信号掩码
    __sigset_t sig_pending;    // 待处理信号
    struct trapframe *sig_tf;  // 信号 trapframe 备份
};
```

进程表大小为 `NPROC = 64`，最多支持 64 个进程。

#### 3.4.2 进程创建

`allocproc()` 分配进程结构，初始化 trapframe、用户页表，并映射 trampoline、trapframe 和 signal trampoline 页面。

`fork()` 实现完整的进程复制：复制页表（物理页拷贝）、复制文件描述符表、复制 trapframe。

`userinit()` 创建第一个用户进程，加载 `initcode` 二进制代码。initcode 执行 `exec("/init")` 启动 init 进程。

#### 3.4.3 调度器

调度器采用 xv6 经典的 per-CPU 轮转调度：

```c
void scheduler(void) {
    struct proc *p;
    for(;;) {
        for(p = proc; p < &proc[NPROC]; p++) {
            acquire(&p->lock);
            if(p->state == RUNNABLE) {
                p->state = RUNNING;
                c->proc = p;
                swtch(&c->context, &p->context);
                c->proc = 0;
            }
            release(&p->lock);
        }
    }
}
```

调度策略为简单的轮转（Round-Robin），无优先级、无时间片、无 CFS 等高级调度策略。

#### 3.4.4 上下文切换

`swtch` 汇编函数保存/恢复 callee-saved 寄存器（ra, sp, s0-s11），共 14 个寄存器。

**完整度评估**：60%。进程管理基本功能完整（fork、exec、exit、wait），但存在以下不足：
- 调度器过于简单，无优先级和时间片
- `kpagetable`（per-process 内核页表）字段存在但未被使用
- 进程状态机中 `USED` 状态是 xv6 原始设计中不存在的中间状态
- `wait` 和 `waitpid` 实现存在部分问题

---

### 3.5 线程管理子系统

**源文件**：`thread.c`

#### 3.5.1 线程结构

```c
typedef struct thread {
    struct spinlock lock;
    enum threadState state;    // t_UNUSED/t_SLEEPING/t_RUNNABLE/t_RUNNING/t_ZOMBIE/t_TIMING
    struct proc *p;            // 所属进程
    void *chan;                // 睡眠通道
    int tid;                   // 线程 ID
    uint64_t awakeTime;        // 唤醒时间
    uint64_t kstack;           // 内核栈
    uint64_t vtf;              // trapframe 虚拟地址
    uint64_t sz;               // 进程大小副本
    struct trapframe *trapframe;
    struct context context;
    uint64_t kstack_pa;        // 内核栈物理地址
    uint64_t clear_child_tid;
    struct thread *next_thread;
    struct thread *pre_thread;
} thread;
```

线程池大小为 `THREAD_NUM = 10000`，采用双向链表管理空闲线程。

#### 3.5.2 线程创建

```c
thread *allocNewThread() {
    if(free_thread == NULL) panic("allocNewThread");
    if(!(free_thread->trapframe = (struct trapframe *)kalloc()))
        panic("allocNewThread: can not kalloc");
    free_thread->awakeTime = 0;
    free_thread->state = t_RUNNABLE;
    free_thread->tid = nexttid++;
    // 从空闲链表摘取
    thread *tmp = free_thread;
    free_thread = free_thread->next_thread;
    return tmp;
}
```

#### 3.5.3 clone 系统调用

`sys_clone` 根据参数决定行为：
- `new_stack == 0`：退化为 `fork()`
- `new_fn & CLONE_VM`：调用 `thread_clone()` 创建线程
- 其他：调用 `clone()` 创建新进程

clone 标志定义完整，包括 `CLONE_VM`、`CLONE_FS`、`CLONE_FILES`、`CLONE_SIGHAND`、`CLONE_THREAD` 等 Linux 兼容标志。

**完整度评估**：45%。线程框架已搭建，但存在以下问题：
- 线程调度未与进程调度器集成（调度器只调度进程，不直接调度线程）
- 线程池预分配 10000 个结构体，内存开销大
- `thread_clone` 的具体实现在 `proc.c` 中，但线程与进程的地址空间共享机制不够清晰
- 线程的 `awakeTime` 字段暗示有定时唤醒功能，但未见完整实现

---

### 3.6 中断与异常处理子系统

**源文件**：`trap.c`、`kernelvec.S`、`trampoline.S`、`plic.c`

#### 3.6.1 Trap 处理流程

**用户态 Trap**（`usertrap`）：

1. 用户态通过 `ecall` 触发系统调用（`scause == 8`）
2. 通过 trampoline 页面的 `uservec` 保存所有用户寄存器到 trapframe
3. 切换到内核页表和内核栈
4. 跳转到 `usertrap` 函数

`usertrap` 处理以下异常类型：

| scause | 类型 | 处理方式 |
|--------|------|---------|
| 8 | 系统调用（ecall） | 调用 `syscall()` |
| 7 | Store/AMO 页错误 | 按需分配页面（Demand Paging） |
| 13 | Load 页错误 | 按需分配页面 |
| 15 | Store 页错误 | 按需分配页面 |
| 2 | 非法指令 | 终止进程 |
| 3 | 断点（ebreak） | epc += 2 跳过 |
| 其他 | 未知异常 | 终止进程 |

**Demand Paging 实现**：

```c
} else if(r_scause() == 13 || r_scause() == 15) {
    uint64_t va = r_stval();
    if(va < PGROUNDUP(myproc()->sz) || va > MAXUVA) {
        pte_t *pte = walk(myproc()->pagetable, va, 0);
        if(pte == 0) {
            char *mem = kalloc();
            if(mappages(myproc()->pagetable, PGROUNDDOWN(va), PGSIZE,
                        (uint64_t)mem, PTE_W|PTE_R|PTE_U) != 0) {
                kfree(mem);
                p->killed = 1;
            }
        } else {
            *pte |= PTE_U | PTE_R | PTE_W;
        }
    } else {
        // 对 iozone 程序特殊处理：批量分配页面
        if(!namecmp(myproc()->name, "iozone")) {
            // 单页分配
        } else {
            // 从 p->sz 到 va 连续分配
        }
    }
}
```

这是一个**按需分页**（Demand Paging）的实现，在页面错误时才分配物理页面。但实现较为粗糙：
- 无 COW 支持
- 无页面换出
- 对特定程序（iozone）有硬编码的特殊处理
- 未区分读/写/执行权限错误

**内核态 Trap**（`kerneltrap`）：

内核态 trap 仅处理设备中断，其他异常直接 panic 或 kill 进程。

#### 3.6.2 中断处理

```c
int devintr() {
    uint64_t scause = r_scause();
    if((scause & 0x8000000000000000L) && (scause & 0xff) == 9) {
        // 外部中断：通过 PLIC 处理
        int irq = plic_claim();
        if(irq == Uart0_IRQ) uart_intr();
        else if(irq == VIRTIO0_IRQ) virtio_disk_intr();
        plic_complete(irq);
        return 1;
    } else if(scause == 0x8000000000000001L) {
        // 软件中断（定时器）
        if(cpuid() == 0) clockintr();
        w_sip(r_sip() & ~2);
        return 2;
    }
    return 0;
}
```

定时器中断通过 SBI 的 M-mode 定时器触发 S-mode 软件中断（SSIP），而非直接使用 S-mode 定时器中断。

**完整度评估**：65%。Trap 处理框架完整，支持系统调用、设备中断和按需分页。但存在以下问题：
- 无 COW 机制
- 无页面换出/换入
- 对特定程序有硬编码处理
- 内核态 trap 处理过于简单

---

### 3.7 文件系统子系统

**源文件**：`fs.c`、`file.c`、`bcache.c`、`disk.c`

#### 3.7.1 ext4 文件系统实现

这是本项目最重要的扩展之一。内核实现了一个**部分兼容的 ext4 文件系统**驱动。

**超级块结构**（`include/fs.h`）：

```c
struct ext4_sblock {
    uint32_t inodes_count;
    uint32_t blocks_count_lo;
    uint32_t reserved_blocks_count_lo;
    uint32_t free_blocks_count_lo;
    uint32_t free_inodes_count;
    uint32_t first_data_block;
    uint32_t log_block_size;
    uint32_t blocks_per_group;
    uint32_t inodes_per_group;
    // ... 完整的 ext4 超级块字段
    uint32_t blocks_count_hi;  // 64位支持
};
```

**块组描述符**：

```c
struct ext4_bgroup {
    uint32_t block_bitmap_lo;
    uint32_t inode_bitmap_lo;
    uint32_t inode_table_first_block_lo;
    // ... 完整的 ext4 块组描述符
    uint32_t block_bitmap_hi;   // 64位支持
    uint32_t inode_bitmap_hi;
    uint32_t inode_table_first_block_hi;
};
```

**文件系统初始化**：

```c
void fsinit(int dev) {
    readsb(dev, &ext4_sblock);
    ngroup = (blocks_count) / ext4_sblock.blocks_per_group;
    for(int i = 0; i < ngroup; i++) {
        if(i == 0 || i % 2) {
            read_to_struct(dev, &ext4_bgroup[i],
                          1 + i * ext4_sblock.blocks_per_group,
                          sizeof(ext4_bgroup[i]));
        }
    }
}
```

**inode 操作**：

- `namei()`：路径名解析，支持绝对路径和相对路径
- `enext()`：目录项遍历，支持 ext4 目录项格式（`ext4_dir_entry_2`）
- `readi()`/`writei()`：inode 数据读写，支持 ext4 的 extent 和间接块
- `bmap()`：逻辑块到物理块的映射
- `ialloc()`：inode 分配，通过扫描 inode 位图
- `balloc()`：块分配，通过扫描块位图

**ext4 inode 结构**（`include/fs.h`）：

```c
struct ext4_inode {
    uint16_t mode;
    uint16_t uid;
    uint32_t size_lo;
    uint32_t access_time;
    uint32_t change_inode_time;
    uint32_t modification_time;
    uint32_t deletion_time;
    uint16_t gid;
    uint16_t links_count;
    uint32_t blocks_count_lo;
    uint32_t flags;
    uint32_t block[15];     // 直接/间接块指针
    // ... extent header 等
    uint32_t size_hi;
};
```

**目录项结构**：

```c
struct ext4_dir_entry_2 {
    uint32_t inode;
    uint16_t rec_len;
    uint8_t name_len;
    uint8_t file_type;
    char name[EXT4_NAME_LEN]; // 255
};
```

#### 3.7.2 块缓存（bcache.c）

采用双向链表 LRU 缓存，容量为 30 个缓冲区：

```c
struct {
    struct spinlock lock;
    struct buf buf[30];
    struct buf head;
} bcache;
```

每个缓冲区配有独立的睡眠锁。`bget()` 先查找缓存命中，未命中则回收最近最少使用的缓冲区。

#### 3.7.3 挂载子系统

```c
struct mnt {
    uint32_t devno;
    struct inode *emnt;
    uint32_t refcnt;
    struct mnt *next;
};
```

支持最多 5 个挂载点（`NMNT = 5`），实现了 `mount` 和 `umount2` 系统调用。

#### 3.7.4 虚拟文件系统层

`sys_read` 中对特殊文件进行了硬编码处理：

```c
if(f->type == 10) {  // 虚拟文件类型
    if(!namecmp(f->filename, "/proc/meminfo")) {
        char buf[0x400] = "Cached: 400 MemAvailable: 400 SReclaimable: 400";
        copyout(myproc()->pagetable, addr, buf, sizeof(buf));
    } else if(!namecmp(f->filename, "/etc/passwd")) {
        char buf[0x400] = "root:x:0:0:root:/root:/bin/bash";
        copyout(myproc()->pagetable, addr, buf, sizeof(buf));
    }
}
```

这表明项目实现了简单的 procfs 和虚拟文件支持，但通过硬编码而非 VFS 框架实现。

**完整度评估**：50%。ext4 文件系统的读取功能基本可用，但存在以下问题：
- ext4 写入功能不完整（`write_inode` 实现粗糙）
- 不支持 ext4 extent tree（仅支持传统的直接/间接块映射）
- 不支持日志（journal）
- 不支持 ACL、扩展属性
- 块大小固定为 1024 字节（`BSIZE = 1024`），而 ext4 通常使用 4096 字节
- 无 VFS 抽象层，虚拟文件通过硬编码实现
- `mkfs.c` 生成的是 xv6 原始文件系统格式，与内核使用的 ext4 不匹配

---

### 3.8 系统调用子系统

**源文件**：`syscall.c`、`sysfile.c`、`sysfproc.c`、`sysshm.c`、`sys_pselect.c`

#### 3.8.1 系统调用表

项目实现了约 **70+ 个系统调用**，覆盖了 Linux 系统调用的多个类别：

| 类别 | 系统调用 |
|------|---------|
| **进程管理** | fork, clone, exec, execve, exit, exit_group, wait, wait4, kill, getpid, getppid, gettid, yield |
| **内存管理** | sbrk, mmap, munmap, mprotect, madvise |
| **文件系统** | open, close, read, write, lseek, pread64, pwrite64, mkdir, remove, chdir, getcwd, getdents, renameat2, readlinkat, ftruncate, sync, fsync |
| **文件信息** | fstat, fstatat, faccessat, statx |
| **文件描述符** | dup, dup3, fcntl, ioctl |
| **管道** | pipe |
| **I/O 多路复用** | pselect6 |
| **信号** | rt_sigaction, rt_sigprocmask, rt_sigtimedwait |
| **共享内存** | shmget, shmat, shmctl |
| **时间** | clock_gettime, clock_getres, clock_nanosleep, gettimeofday, times, setitimer |
| **系统信息** | uname, sysinfo, syslog, getrusage |
| **用户/组** | getuid, setuid, setgid |
| **调度** | sched_getscheduler, sched_getparam, sched_getaffinity, sched_setscheduler |
| **挂载** | mount, umount2 |
| **其他** | set_tid_address, futex, prlimit64, readv, writev |

#### 3.8.2 系统调用分发

```c
void syscall(void) {
    int num;
    struct proc *p = myproc();
    num = p->trapframe->a7;
    if(num > 0 && num < NELEM(syscalls) && syscalls[num]) {
        p->trapframe->a0 = syscalls[num]();
    } else {
        printf("%s: unknown sys %d\n", p->name, num);
        p->trapframe->a0 = -1;
    }
}
```

系统调用号通过 `a7` 寄存器传递，返回值通过 `a0` 寄存器返回。系统调用号定义在 `include/syscall.h` 中，采用 Linux RISC-V 标准编号。

#### 3.8.3 关键系统调用实现分析

**mmap**：实现不完整，当前仅返回 `myproc()->sz`，未实际映射文件：

```c
uint64_t sys_mmap(void) {
    int size, perm, fd, len;
    argaddr(1, &len);
    size = argraw(1);
    perm = argraw(3);
    // ...
    return myproc()->sz;  // 直接返回，未做实际映射
}
```

**futex**：实现了基本的 FUTEX_WAIT 和 FUTEX_WAKE：

```c
uint64_t sys_futex(void) {
    uint64_t uaddr;
    int op, val;
    argaddr(0, &uaddr);
    argint(1, &op);
    argint(2, &val);
    if(op == FUTEX_WAIT) {
        // 检查值并睡眠
    } else if(op == FUTEX_WAKE) {
        // 唤醒
    }
}
```

**pselect6**：实现了基本的 I/O 多路复用，支持管道文件描述符的读写就绪检测。

**完整度评估**：55%。系统调用数量较多（70+），覆盖面广，但许多系统调用实现不完整或为桩函数：
- `mmap` 未实际实现文件映射
- `mprotect` 未实现权限修改
- `lseek` 始终返回 1
- `sys_kill` 错误地杀死调用者自身而非目标进程
- 许多调度相关系统调用为桩函数
- `ioctl` 仅处理少量请求

---

### 3.9 信号机制子系统

**源文件**：`signal.c`、`SignalTrampoline.S`

#### 3.9.1 信号定义

支持完整的 POSIX 信号集（1-31 标准信号 + 32-64 实时信号），共 65 个信号：

```c
#define SIGHUP  1   ... #define SIGSYS  31
#define SIGRTMIN 32  #define SIGRTMAX 64
```

#### 3.9.2 sigaction 结构

```c
typedef struct sigaction {
    union {
        __sighandler_t sa_handler;
    } __sigaction_handler;
    __sigset_t sa_mask;
    int sa_flags;
} sigaction;
```

支持 `SA_NOCLDSTOP`、`SA_NOCLDWAIT`、`SA_NODEFER`、`SA_RESETHAND`、`SA_RESTART`、`SA_SIGINFO` 标志。

#### 3.9.3 信号处理流程

```c
void sighandle(void) {
    struct proc *p = myproc();
    int signum = p->killed;
    if (p->sigaction[signum].__sigaction_handler.sa_handler != NULL) {
        p->sig_tf = kalloc();
        memcpy(p->sig_tf, p->trapframe, sizeof(struct trapframe));
        p->trapframe->epc = (uint64_t)p->sigaction[signum].__sigaction_handler.sa_handler;
        p->trapframe->ra = (uint64_t)SIGTRAMPOLINE;
        p->trapframe->sp = p->trapframe->sp - PGSIZE;
        p->sig_pending.__val[0] &= ~(1ul << signum);
    } else {
        exit(-1);
    }
}
```

信号蹦床（`SignalTrampoline.S`）：

```asm
signalTrampoline:
    li a7, 139    # rt_sigreturn 系统调用号
    ecall
```

#### 3.9.4 sigprocmask

```c
int sigprocmask(int how, __sigset_t *set, __sigset_t *oldset) {
    switch (how) {
    case SIG_BLOCK:   p->sig_set.__val[i] |= set->__val[i]; break;
    case SIG_UNBLOCK: p->sig_set.__val[i] &= ~(set->__val[i]); break;
    case SIG_SETMASK: p->sig_set.__val[i] = set->__val[i]; break;
    }
    // SIGTERM/SIGKILL/SIGSTOP 不可被屏蔽
    p->sig_set.__val[0] &= 1ul << SIGTERM | 1ul << SIGKILL | 1ul << SIGSTOP;
}
```

**完整度评估**：50%。信号框架已搭建，支持 sigaction、sigprocmask、rt_sigreturn。但存在以下问题：
- 信号掩码仅使用 1 个 `unsigned long`（`SIGSET_LEN = 1`），只能表示 64 个信号，对实时信号支持有限
- `sa_sigaction`（三参数信号处理）未实现
- 信号传递时机不明确（未见在 trap 返回前检查 pending 信号的逻辑）
- `sigprocmask` 中不可屏蔽信号的掩码计算有逻辑错误（应使用 OR 而非 AND）

---

### 3.10 共享内存子系统

**源文件**：`sysshm.c`

实现了 System V 风格的共享内存 API：

```c
struct shm {
    uint32_t shm_length[4096];
    uint32_t pid[4096];
    uint64_t addr[4096];
    uint64_t pa[4096][32];  // 每个共享内存段最多 32 页（128KB）
};
```

- `shmget`：分配共享内存段，记录大小和虚拟地址
- `shmat`：将共享内存映射到进程地址空间，分配物理页并建立映射
- `shmctl`：控制操作（当前为空实现）

**完整度评估**：30%。基本框架存在但功能有限：
- 每个共享内存段最多 32 页（128KB）
- 无 `shmdt`（分离共享内存）实现
- `shmctl` 为空实现
- 无 IPC 键值管理
- 无权限检查

---

### 3.11 进程间通信子系统

**源文件**：`pipe.c`

实现了经典的管道机制：

```c
struct pipe {
    struct spinlock lock;
    char data[PIPESIZE];  // PIPESIZE = 512
    uint32_t nread;
    uint32_t nwrite;
    int readopen;
    int writeopen;
};
```

**注意**：`piperead` 函数存在严重 bug——在函数开头直接 `return n;`，导致管道读取功能完全失效：

```c
int piperead(struct pipe *pi, uint64_t addr, int n) {
    int i;
    struct proc *pr = myproc();
    char ch;
    return n;  // BUG: 直接返回，后续代码不可达
    acquire(&pi->lock);
    // ...
}
```

**完整度评估**：20%。管道写入功能正常，但读取功能因代码 bug 完全不可用。无命名管道（FIFO）、无消息队列、无 socket。

---

### 3.12 设备驱动子系统

**源文件**：`uart.c`、`console.c`、`virtio_disk.c`

#### 3.12.1 UART 驱动

实现了 16550 UART 驱动，支持字符读写和中断处理。UART 基地址为 `0x10000000`，IRQ 为 10。

#### 3.12.2 VirtIO 块设备驱动

实现了 VirtIO MMIO 块设备驱动，支持读写操作：

```c
static struct disk {
    char pages[2*PGSIZE];          // 描述符表内存
    struct virtq_desc *desc;       // 描述符
    struct virtq_avail *avail;     // 可用环
    struct virtq_used *used;       // 已用环
    char free[NUM];                // 描述符空闲标记
    uint16_t used_idx;
    struct wait_queue queue;       // 等待队列
    struct virtio_blk_req ops[NUM];
    struct spinlock vdisk_lock;
} disk;
```

驱动使用 3 个描述符链完成一次 I/O 操作（请求头 + 数据 + 状态），通过 VirtIO MMIO 接口与 QEMU 交互。

#### 3.12.3 控制台驱动

`console.c` 实现了控制台读写，支持行编辑（退格键处理），将输入输出与 UART 和管道关联。

**完整度评估**：55%。UART 和 VirtIO 块设备驱动基本可用。缺少网络设备驱动（虽然 QEMU 启动参数中包含了 `virtio-net-device`，但内核中无对应驱动）、无 framebuffer 驱动、无键盘驱动。

---

### 3.13 同步机制子系统

**源文件**：`spinlock.c`、`sleeplock.c`

#### 3.13.1 自旋锁

```c
void acquire(struct spinlock *lock) {
    push_off();  // 关中断
    while(__sync_lock_test_and_set(&lock->locked, 1) != 0) { }
    __sync_synchronize();
    lock->cpu = mycpu();
}
```

使用 GCC 内置原子操作 `__sync_lock_test_and_set` 实现。获取锁前关闭中断，支持嵌套的 `push_off`/`pop_off`。

#### 3.13.2 睡眠锁

```c
void acquiresleep(struct sleeplock *lock) {
    acquire(&lock->lock);
    while (lock->locked) {
        sleep(lock, &lock->lock);
    }
    lock->locked = 1;
    lock->pid = myproc()->pid;
    release(&lock->lock);
}
```

基于自旋锁和 sleep/wakeup 机制实现。

**完整度评估**：70%。自旋锁和睡眠锁实现正确。缺少读写锁、互斥量、条件变量、信号量等高级同步原语。futex 系统调用有基本实现但功能有限。

---

### 3.14 程序加载子系统

**源文件**：`exec.c`、`exec1.c`

实现了两个版本的 ELF 加载器：

**exec（原始版本）**：
- 解析 ELF 头
- 加载 LOAD 段到内存
- 处理非页对齐的 vaddr
- 设置用户栈（默认 2 页，libc-bench 特殊分配 100 页）
- 构建辅助向量（aux vector）：AT_HWCAP、AT_PAGESZ、AT_PHDR、AT_PHENT、AT_PHNUM、AT_BASE、AT_ENTRY、AT_UID、AT_GID、AT_RANDOM 等
- 传递命令行参数

**exec1（增强版本）**：
- 支持动态链接程序检测（`ELF_PROG_INTERP`）
- 支持加载动态链接器（`/libc.so`，但代码被注释）
- 支持 shell 脚本检测（`.sh` 后缀）
- 支持环境变量传递
- 更完善的辅助向量构建

**完整度评估**：55%。静态链接 ELF 加载基本可用，动态链接支持框架已搭建但未完成（加载器代码被注释）。对非页对齐段的处理有实现但可能存在边界问题。

---

## 四、子系统交互分析

### 4.1 系统调用路径

```
用户程序 ecall
  → trampoline (uservec)
    → 保存寄存器到 trapframe
    → 切换内核页表
    → usertrap()
      → syscall()
        → syscalls[a7]()  // 分发到具体系统调用
          → sys_read() / sys_write() / sys_fork() / ...
      → usertrapret()
        → trampoline (userret)
          → 恢复寄存器
          → sret 返回用户态
```

### 4.2 中断处理路径

```
硬件中断
  → SBI timervec (M-mode)
    → 设置 SSIP
    → mret
  → kernelvec / uservec (S-mode)
    → devintr()
      → plic_claim()
      → uart_intr() / virtio_disk_intr()
      → plic_complete()
    → clockintr()  // 定时器
      → ticks++
      → wakeup(&ticks)
```

### 4.3 文件 I/O 路径

```
sys_read(fd, buf, n)
  → argfd() 获取 file 结构
  → fileread()
    → 管道: piperead()
    → inode: readi()
      → bmap() 获取块号
      → bread() 读取块
        → bget() 查找缓存
        → virtio_disk_rw() 磁盘 I/O
          → VirtIO 描述符链
          → QEMU 处理
          → 中断完成
```

### 4.4 进程创建路径

```
sys_fork()
  → fork()
    → allocproc() 分配进程结构
    → uvmcopy() 复制页表（物理页拷贝）
    → 复制文件描述符
    → 复制 trapframe
    → 设置子进程返回值为 0
```

---

## 五、项目整体实现完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 启动引导 | 60% | 自研 SBI 基本可用，但功能极简 |
| 内核初始化 | 70% | 初始化序列完整，多核支持不工作 |
| 物理内存管理 | 55% | 空闲链表分配器，无高级分配器 |
| 虚拟内存管理 | 55% | 基本页表管理，有 demand paging，无 COW |
| 进程管理 | 60% | fork/exec/exit/wait 基本可用，调度器简单 |
| 线程管理 | 45% | 框架搭建，与调度器集成不足 |
| 中断/异常处理 | 65% | 框架完整，demand paging 有实现 |
| 文件系统 | 50% | ext4 读取基本可用，写入不完整 |
| 系统调用 | 55% | 数量多但许多为桩函数或不完整 |
| 信号机制 | 50% | 框架搭建，细节有 bug |
| 共享内存 | 30% | 基本框架，功能有限 |
| 进程间通信 | 20% | 管道读取有严重 bug |
| 设备驱动 | 55% | UART 和 VirtIO 块设备可用 |
| 同步机制 | 70% | 自旋锁和睡眠锁正确 |
| 程序加载 | 55% | 静态 ELF 可用，动态链接未完成 |

**整体完整度**：约 **52%**（以 Linux 内核功能子集为基准）。

---

## 六、创新性分析

### 6.1 自研 SBI 固件

项目未使用标准的 OpenSBI 或 RustSBI，而是自行实现了一个极简的 M-mode 固件。这体现了一定的底层理解能力，但实现过于简单，仅完成定时器中断转发。

### 6.2 ext4 文件系统适配

在 xv6 原始文件系统基础上替换为 ext4 文件系统驱动，是一个有意义的尝试。实现了 ext4 超级块解析、块组描述符解析、inode 读取和目录遍历。但实现深度有限，不支持 extent tree、日志等 ext4 核心特性。

### 6.3 Demand Paging

在 trap 处理中实现了按需分页，当发生页面错误时动态分配物理页面。这在 xv6 基础上是一个进步，但缺少 COW 和页面置换算法。

### 6.4 丰富的系统调用接口

尝试实现了 70+ 个 Linux 兼容系统调用，覆盖了进程管理、文件系统、信号、共享内存、I/O 多路复用等多个领域，体现了对 Linux 系统调用接面的广泛理解。

### 6.5 总体创新性评价

项目的创新性主要体现在**广度扩展**而非**深度创新**。大部分工作是将 xv6 的简单实现替换为更接近 Linux 的接口和功能，但实现深度普遍不足。自研 SBI 是一个亮点，但功能过于简单。

---

## 七、代码质量与工程问题

### 7.1 代码组织

- 所有内核源文件平铺在根目录，无子目录分层
- 头文件统一放在 `include/` 目录
- 仓库中包含大量非源码文件（反汇编输出、测试结果、预编译二进制、比赛文档），整洁度低

### 7.2 代码风格

- 中英文注释混用
- 大量调试代码未清理（`printf("woc\n")`、`printf("yichu\n")` 等）
- 大量被注释掉的代码块
- 变量命名不一致（混合使用驼峰、下划线、拼音）

### 7.3 已知 Bug

1. **piperead 直接返回**：`return n;` 在函数开头，管道读取完全不可用
2. **sys_kill 杀死自身**：`return kill(myproc()->pid)` 而非目标 pid
3. **walkaddr 逻辑错误**：无效 PTE 仍返回物理地址
4. **mappages 重复赋值**：同一 PTE 赋值执行三次
5. **sigprocmask 掩码错误**：不可屏蔽信号的掩码计算逻辑有误
6. **argfd 缺少返回值**：`sysfproc.c` 中的 `argfd` 函数在成功路径无 return 语句

### 7.4 安全问题

- 无用户空间地址验证的完整实现
- `walkaddr` 不检查 PTE_U 位的有效性
- 无 ASLR（地址空间布局随机化）
- 无栈保护（编译选项 `-fno-stack-protector`）

---

## 八、其他信息

### 8.1 构建系统

- 使用 GNU Make 构建
- 交叉编译工具链：`riscv64-linux-gnu-gcc`
- 编译选项：`-fno-stack-protector -nostdlib -fno-builtin -march=rv64gc -mabi=lp64d`
- 生成两个目标：`kernel-qemu`（内核）和 `sbi-qemu`（SBI 固件）
- 无增量构建优化（所有 .c 文件通过 wildcard 收集）

### 8.2 测试程序

`fs/` 目录包含 45 个预编译的用户态测试程序，覆盖：
- 基本系统调用测试（fork、clone、pipe、mmap 等）
- 文件系统操作（open、read、write、mkdir 等）
- 进程管理（exit、wait、waitpid 等）
- 时间相关（gettimeofday、times、sleep 等）
- 系统信息（uname、getpid、getppid 等）

### 8.3 文档

仓库包含比赛文档（`操作系统决赛文档.docx`/`.pdf`）和 README.md，但代码内文档（注释）质量较低。

### 8.4 Docker 支持

提供了 `Dockerfile`，用于构建环境的容器化。

---

## 九、总结

ruaruaos 是一个基于 xv6-riscv 进行广泛功能扩展的竞赛级操作系统内核项目。项目在以下方面做出了有意义的尝试：

**优势**：
1. 系统调用接口覆盖面广（70+ 个），接近 Linux 兼容
2. 实现了 ext4 文件系统的读取功能
3. 自研 SBI 固件体现了底层理解
4. 实现了 demand paging、信号机制、共享内存、多线程等高级特性
5. 支持 VirtIO 块设备驱动

**不足**：
1. 许多子系统实现不完整或存在严重 bug（如管道读取不可用）
2. 代码质量较低，大量调试代码未清理
3. 多核支持实际上不工作
4. 缺少 COW、页面置换、高级调度器等关键机制
5. 文件系统写入功能不完整
6. 动态链接支持未完成
7. 仓库整洁度低，包含大量非源码文件

总体而言，该项目展现了作者对操作系统核心概念的广泛理解，以及在有限时间内追求功能广度的策略。但在实现深度和代码质量方面存在明显不足，多个关键子系统存在功能性缺陷。