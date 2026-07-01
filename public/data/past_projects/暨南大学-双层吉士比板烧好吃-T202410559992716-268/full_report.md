# OSKernel2024-X2 (暨南大学-双层吉士比板烧好吃) 内核项目技术报告

---

## 一、分析概述

本报告对该 OS 内核项目进行了以下分析工作：

1. **完整的源码阅读**：逐文件阅读了全部 25 个 C 源文件、7 个汇编文件、22 个头文件及 2 个链接脚本。
2. **构建验证**：使用环境中提供的 `riscv64-linux-gnu-gcc 13.3.0` 和 GNU Make 执行了完整构建，记录了所有编译警告。
3. **QEMU 运行测试**：使用 `qemu-system-riscv64` 加载构建产物（`kernel-qemu` + `sbi-qemu` + `fat32.img`），观察了内核启动过程及全部自动化测试用例的执行结果。
4. **子系统拆解分析**：对引导启动、内存管理、进程管理、中断处理、文件系统、设备驱动、系统调用、IPC、同步机制等子系统进行了逐一深入分析。

---

## 二、构建与测试结果

### 2.1 构建结果

构建命令 `make all` 成功完成，生成了两个 ELF 产物：

| 产物 | 大小 | 说明 |
|------|------|------|
| `kernel-qemu` | 210,536 字节 | S-mode 内核 ELF |
| `sbi-qemu` | 18,872 字节 | M-mode SBI 固件 ELF |

构建过程中产生了大量编译警告（约 30+ 条），主要类别如下：

- **隐式函数声明**：`strchr`、`snstr`、`emake`、`enext` 等函数在使用前未声明。
- **控制流到达非 void 函数末尾**：`bget()`、`alloc_clus()` 等函数缺少返回值。
- **指针与整数类型不匹配**：`page.c` 中使用 `uint32_t` 存储 64 位地址，存在截断风险。
- **运算符优先级警告**：`fs.c` 中 FAT 时间戳解析的位运算与算术运算混合时缺少括号。
- **未使用变量**：`filewrite()` 中的 `r`、`readi()`/`writei()` 中的 `bp` 等。
- **重复定义**：`syscall.h` 中 `SYS_fstat`、`SYS_sleep`、`SYS_uname`、`SYS_getppid`、`SYS_getpid` 存在重复宏定义。

### 2.2 QEMU 运行测试结果

内核在 QEMU virt 机器上成功启动，自动执行了 FAT32 镜像中预置的全部测试用例。测试结果汇总如下：

| 测试用例 | 结果 | 说明 |
|----------|------|------|
| test_chdir | 通过 | 成功切换到 `/test_chdir` 目录 |
| test_mkdir | 通过 | 成功创建目录 |
| test_brk | 通过 | 堆内存分配正常，16384 -> 16448 -> 16512 |
| test_clone | 通过 | 子进程成功创建，pid=6 |
| test_close | 通过 | 关闭 fd 3 成功 |
| test_dup | 通过 | 复制文件描述符到 fd 3 |
| test_dup2 | 通过 | 从 fd 100 复制成功 |
| test_execve | 通过 | 成功执行 test_echo 程序 |
| test_exit | 通过 | 进程退出正常 |
| test_fstat | 通过 | 返回 dev=0, inode=12287, size=52 |
| test_getcwd | 通过 | 获取根目录 `/` |
| test_getdents | 通过 | 读取目录项成功 |
| test_getpid | 通过 | 返回 pid=16 |
| test_gettimeofday | 通过 | 时间间隔 1 微秒 |
| test_mmap | 通过 | 读取文件内容 "Hello, mmap successfully!" |
| test_mount | **失败** | 输出 "mnt zhaobudao"，mount 返回 -1 |
| test_munmap | 通过 | 返回 0 |
| test_open | 通过 | 成功读取文本文件 |
| test_openat | 通过 | 相对路径打开成功 |
| test_pipe | 通过 | 管道读写正常 |
| test_read | 通过 | 文件读取正常 |
| test_sleep | 通过 | 睡眠功能正常 |
| test_times | 通过 | 返回 tms_utime=4000, tms_stime=228000 |
| test_umount | **失败** | 依赖 mount，同样失败 |
| test_uname | 通过 | 返回 "RuaruaOs Qemu 1.0 1.0 riscv CN" |
| test_unlink | 通过 | 文件删除成功 |
| test_wait | 通过 | 等待子进程成功，wstatus=0 |
| test_waitpid | 通过 | 等待指定 pid 成功，wstatus=3 |
| test_write | 通过 | 写入输出正常 |
| test_yield | 通过 | 多进程交替执行正常 |
| test_fork | 通过 | 父子进程正常执行 |
| test_getppid | 通过 | 返回 ppid=1 |

**通过率：30/32（93.75%）**。仅 `test_mount` 和 `test_umount` 失败，原因是 `sys_mount()` 实现不完整，无法找到挂载点路径。

---

## 三、子系统详细分析

### 3.1 引导启动子系统（M-mode SBI 固件）

**源文件**：`boot.S`、`timer.c`、`timervec.S`
**链接脚本**：`bootloader.ld`
**加载地址**：`0x80000000`（SRAM 起始）

#### 实现细节

该子系统实现了一个简易的 M-mode 固件，替代标准 SBI（如 OpenSBI/RustSBI），作为 QEMU 的 `-bios` 参数加载。其启动流程如下：

```asm
# boot.S - _start 入口
_start:
    la sp, stack0
    li a0, 1024*4
    csrr a1, mhartid
    bnez a1, _sti          # 非 0 号核进入 wfi 等待
    addi a1, a1, 1
    mul a0, a0, a1
    add sp, sp, a0         # 设置栈指针
```

0 号 hart 执行以下初始化序列：

1. **mstatus 配置**：将 MPP 设为 S-mode（值 `0x800`，即 `10` 二进制），使 `mret` 后进入 S-mode。
2. **mepc 设置**：设为 `0x80200000`，即内核入口地址。
3. **satp 清零**：关闭 M-mode 的地址翻译。
4. **异常/中断委托**：`medeleg` 和 `mideleg` 均设为 `0xffff`，将大部分异常和中断委托给 S-mode。
5. **PMP 配置**：`pmpaddr0` 设为 `0x3fffffffffffffff`，`pmpcfg0` 设为 `0xf`（NAPOT 模式，RWX 全权限），允许 S-mode 访问全部物理内存。
6. **定时器初始化**：调用 `timerinit()` 配置 CLINT 定时器。
7. **mret**：跳转到 S-mode 内核。

```c
// timer.c - 定时器初始化
void timerinit(){
    int id = r_mhartid();
    int interval = 100000;
    *(uint64_t*)CLINT_MTIMECMP(id) = *(uint64_t*)CLINT_MTIME + interval;
    uint64_t *scratch = &timer_scratch[id][0];
    scratch[3] = CLINT_MTIMECMP(id);
    scratch[4] = interval;
    w_mscratch((uint64_t)scratch);
    w_mtvec((uint64_t) timervec);
    w_mstatus(r_mstatus() | MSTATUS_MIE);
    w_mie(r_mie() | MIE_MTIE);
}
```

定时器中断处理（`timervec.S`）在 M-mode 执行：读取 `mscratch` 指向的 scratch 区域，更新 `mtimecmp` 为当前 `mtime + interval`，然后通过 `csrw sip, 2` 设置 S-mode 软件中断（SSIP），最后 `mret` 返回。

**完整度评估**：基本完整。实现了 M-mode 到 S-mode 的特权级切换和定时器中断转发。但存在以下问题：
- 仅 0 号核执行初始化，其余核进入 `wfi` 死循环，**不支持多核启动**。
- `medeleg`/`mideleg` 设为 `0xffff` 仅覆盖低 16 位，高位异常（如 store page fault 等）可能未被委托。
- 定时器间隔固定为 100000 个时钟周期，不可配置。

---

### 3.2 内核入口与初始化

**源文件**：`start.S`、`kernel.c`
**链接脚本**：`os.ld`
**加载地址**：`0x80200000`

#### 实现细节

`start.S` 中的 `_start_kernel` 是 S-mode 内核入口：

```asm
_start_kernel:
    add t0, a0, 1
    slli t0, t0, 14          # (hartid+1) * 16384
    la sp, boot_stack
    add sp, sp, t0           # 每个核 16KB 栈
    call start_boot
```

`kernel.c` 中的 `start_boot()` 执行内核初始化序列：

```c
void start_boot(void) {
    if(cpuid() == 0) {
        consoleinit();        // UART + 控制台
        kinit();              // 物理页分配器
        kvminit();            // 内核页表
        kvminithart();        // 开启分页
        procinit();           // 进程表
        trapinit();           // trap 向量
        trapinithart();       // 安装内核 trap 向量
        plicinit();           // PLIC 中断控制器
        plicinithart();       // PLIC per-hart 配置
        binit();              // 块缓存
        iinit();              // inode 表
        fileinit();           // 文件表
        virtio_disk_init();   // VirtIO 块设备
        userinit();           // 第一个用户进程
        started = 1;
    } else {
        while(started == 0);  // 等待 0 号核完成
        kvminithart();
        trapinithart();
        plicinithart();
    }
    scheduler();              // 进入调度循环
}
```

**完整度评估**：完整。初始化顺序合理，遵循 xv6 的标准流程。但多核支持有限——非 0 号核虽然参与了调度，但由于 M-mode 固件中非 0 号核进入 `wfi` 死循环，实际上只有 0 号核在运行。

---

### 3.3 内存管理子系统

**源文件**：`kalloc.c`（74 行）、`vm.c`（386 行）、`page.c`（195 行）

#### 3.3.1 物理页分配器（kalloc.c）

采用经典的 **空闲链表** 分配器，与 xv6 完全一致：

```c
struct {
    struct spinlock lock;
    struct run *freelist;
    uint64_t npage;
} kmem;

void kinit() {
    initlock(&kmem.lock, "kmem");
    freerange(end, (void *)PHYSTOP);  // end ~ 128MB
}
```

- 管理范围：从内核 BSS 段末尾（`end` 符号）到 `PHYSTOP`（`0x80000000 + 128MB`）。
- 每页 4096 字节，释放时用 `0x01` 填充（检测 use-after-free），分配时用 `0x05` 填充。
- 提供 `freemem_amount()` 返回空闲内存量。
- 使用自旋锁保护并发访问。

**完整度**：完整且正确。

#### 3.3.2 虚拟内存管理（vm.c）

实现 SV39 三级页表管理，核心功能包括：

**内核页表创建**（`kvmmake()`）：
```c
kvmmap(kpgtbl, Uart0, Uart0, PGSIZE, PTE_R | PTE_W);
kvmmap(kpgtbl, VIRTIO0, VIRTIO0, PGSIZE, PTE_R | PTE_W);
kvmmap(kpgtbl, PLIC, PLIC, 0x400000, PTE_R | PTE_W);
kvmmap(kpgtbl, KERNBASE, KERNBASE, (uint64_t)etext-KERNBASE, PTE_R | PTE_X);
kvmmap(kpgtbl, (uint64_t)etext, (uint64_t)etext, PHYSTOP-(uint64_t)etext, PTE_R | PTE_W);
kvmmap(kpgtbl, TRAMPOLINE, (uint64_t)trampoline, PGSIZE, PTE_R | PTE_X);
proc_mapstacks(kpgtbl);
```

映射策略：
- UART0（`0x10000000`）：1 页，RW
- VirtIO0（`0x10001000`）：1 页，RW
- PLIC（`0x0c000000`）：4MB，RW
- 内核代码段（`0x80200000` ~ `etext`）：RX
- 内核数据段（`etext` ~ `PHYSTOP`）：RW
- Trampoline 页：映射到虚拟地址空间顶部（`MAXVA - PGSIZE`），RX
- 每个进程的内核栈：通过 `proc_mapstacks()` 映射

**页表遍历**（`walk()`）：
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

**用户空间管理**：
- `uvmalloc()`：按需分配用户页面
- `uvmdealloc()`：释放用户页面
- `uvmcopy()`：fork 时复制用户页表（完整复制，非 COW）
- `uvmfree()`：释放用户页表及所有映射页面
- `copyout()`/`copyin()`/`copyinstr()`：内核与用户空间数据拷贝

**完整度**：基本完整。缺少 Copy-on-Write（COW）优化，fork 时执行完整页面复制。`walkaddr()` 中检查了 `PTE_U` 标志，但内核空间映射未设置 `PTE_U`，这是正确的。

#### 3.3.3 备用页分配器（page.c）

这是一个独立于 `kalloc` 的页分配器，使用 **位图式首次适配** 算法：

```c
struct Page {
    uint8_t flags;  // bit 0: PAGE_TAKEN, bit 1: PAGE_LAST
};

void page_init(void) {
    _num_pages = (HEAP_SIZE / PAGE_SIZE) - 8;
    // 前 8 页用作页描述符数组
    _alloc_start = _align_page(HEAP_START + 8 * PAGE_SIZE);
}
```

该模块使用 `uint32_t` 类型存储地址，在 64 位系统上存在截断风险。在 `kernel.c` 的 `start_boot()` 中，`page_init()` 被注释掉，**该模块未被实际使用**。它可能是早期开发阶段的遗留代码。

**完整度**：未使用，属于死代码。

---

### 3.4 进程管理子系统

**源文件**：`proc.c`（约 500 行）、`exec.c`（约 180 行）、`entry.S`、`user.c`

#### 3.4.1 进程表与进程结构

```c
#define NPROC 64
struct proc proc[NPROC];

struct proc {
    struct spinlock lock;
    enum procstate state;       // UNUSED/USED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE
    void *chan;                 // 睡眠等待通道
    int killed;                 // 是否被 kill
    int xstate;                 // 退出状态
    int pid;
    struct proc *parent;
    uint64_t kstack;            // 内核栈虚拟地址
    uint64_t sz;                // 进程内存大小
    pagetable_t pagetable;      // 用户页表
    pagetable_t kpagetable;     // 内核页表（未使用）
    struct trapframe *trapframe;
    struct context context;     // 调度上下文
    struct file *ofile[NOFILE]; // 文件描述符表（16 个）
    struct dirent *cwd;         // 当前工作目录
    char name[16];
};
```

#### 3.4.2 调度器

采用 **轮转调度（Round-Robin）** 算法：

```c
void scheduler(void) {
    struct proc *p;
    struct cpu *c = mycpu();
    c->proc = 0;
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

上下文切换通过 `entry.S` 中的 `swtch` 汇编函数实现，保存/恢复 callee-saved 寄存器（ra, sp, s0-s11）。

#### 3.4.3 进程创建

`allocproc()` 分配进程结构，`userinit()` 创建第一个用户进程：

```c
void userinit(void) {
    struct proc *p;
    p = allocproc();
    initproc = p;
    uvmfirst(p->pagetable, initcode, sizeof(initcode));
    p->sz = PGSIZE;
    p->trapframe->epc = 0x0;
    p->trapframe->sp = PGSIZE;
    safestrcpy(p->name, "initcode", sizeof(p->name));
    p->cwd = namei("/");
    p->state = RUNNABLE;
}
```

`initcode` 是一段嵌入在 `proc.c` 中的裸二进制代码（约 1308 字节），它通过 `ecall` 调用 `exec` 系统调用加载 `/init` 程序。

#### 3.4.4 fork 与 clone

`fork()` 实现标准的 Unix fork 语义：
- 分配新进程
- 复制用户内存（`uvmcopy`）
- 复制文件描述符（增加引用计数）
- 复制 trapframe（子进程返回值为 0）

`clone()` 实现类似 Linux clone 的功能，接受一个栈指针参数：
```c
int clone(uint64_t stack) {
    // ... 与 fork 类似，但子进程使用传入的栈指针
    np->trapframe->sp = stack;
}
```

#### 3.4.5 ELF 加载器（exec.c）

```c
int exec(char *path, char **argv) {
    // 1. 通过 namei 查找文件
    ip = namei(path);
    // 2. 读取 ELF 头
    readi(ip, 0, (uint64_t)&elf, 0, sizeof(elf));
    // 3. 创建新页表
    pagetable = proc_pagetable(p);
    // 4. 加载每个 LOAD 段
    for(i = 0; i < elf.phnum; i++) {
        uvmalloc(pagetable, sz, ph.vaddr + ph.memsz, flags2perm(ph.flags));
        loadseg(pagetable, ph.vaddr, ip, ph.off, ph.filesz);
    }
    // 5. 分配用户栈（2 页，guard page + stack page）
    uvmalloc(pagetable, sz, sz + 2*PGSIZE, PTE_W);
    uvmclear(pagetable, sz-2*PGSIZE);  // guard page
    // 6. 拷贝参数到栈
    // 7. 切换页表
}
```

`flags2perm()` 将 ELF 段标志转换为页表权限：
```c
int flags2perm(int flags) {
    int perm = 0;
    if(flags & 0x1) perm = PTE_X;
    if(flags & 0x2) perm |= PTE_W;
    return perm;
}
```

**完整度评估**：基本完整。fork 使用完整复制而非 COW。`clone()` 仅实现了栈指针传递，未实现 Linux clone 的完整语义（如共享地址空间、信号等）。`kpagetable` 字段存在但未被使用（每个进程独立的内核页表未实现）。

---

### 3.5 中断与异常处理子系统

**源文件**：`trap.c`（内嵌于 `kernel.c`）、`kernelvec.S`、`trampoline.S`

#### 3.5.1 内核态 Trap 处理

`kernelvec.S` 保存全部 32 个通用寄存器到内核栈，调用 `kerneltrap()`：

```c
void kerneltrap() {
    int which_dev = 0;
    if((which_dev = kernel_devintr()) == 0) {
        panic("kerneltrap");  // 未预期的内核态异常直接 panic
    }
    if(which_dev == 2 && myproc() != 0 && myproc()->state == RUNNING)
        yield();
}
```

内核态发生非中断异常时直接 panic，不做恢复。

#### 3.5.2 用户态 Trap 处理

通过 trampoline 页面实现用户态到内核态的切换：

```asm
# trampoline.S - uservec
uservec:
    csrw sscratch, a0          # 保存 trapframe 指针
    li a0, TRAPFRAME
    # 保存所有用户寄存器到 trapframe
    sd ra, 40(a0) ... sd t6, 280(a0)
    # 从 trapframe 加载内核信息
    ld sp, 8(a0)               # kernel_sp
    ld tp, 32(a0)              # kernel_hartid
    ld t0, 16(a0)              # kernel_trap 函数指针
    ld t1, 0(a0)               # kernel_satp
    csrw satp, t1              # 切换到内核页表
    sfence.vma zero, zero
    jr t0                      # 跳转到 usertrap()
```

`usertrap()` 处理三类事件：
1. **系统调用**（`scause == 8`）：调用 `syscall()` 分发
2. **设备中断**：调用 `user_devintr()` 处理
3. **其他异常**：标记进程为 killed

#### 3.5.3 中断分发

项目实现了三个几乎相同的中断分发函数（`devintr()`、`user_devintr()`、`kernel_devintr()`），区别仅在于时钟中断处理函数不同：

| 函数 | 时钟处理 | 使用场景 |
|------|----------|----------|
| `devintr()` | `clockintr()` | 未使用 |
| `user_devintr()` | `user_clockintr()` | 用户态 trap |
| `kernel_devintr()` | `super_clockintr()` | 内核态 trap |

这种设计用于区分用户态和内核态的时钟计数，支持 `times()` 系统调用。

**完整度评估**：基本完整。三个中断分发函数存在大量代码重复。`kernelvec.S` 中恢复寄存器时遗漏了 `tp`（`ld tp, 24(sp)` 被跳过），可能导致内核态 `tp` 寄存器值不正确。

---

### 3.6 文件系统子系统（FAT32）

**源文件**：`fs.c`（约 950 行）、`bcache.c`（约 100 行）

这是本项目最具特色的子系统，将 xv6 原有的简单文件系统替换为 **FAT32** 文件系统。

#### 3.6.1 FAT32 初始化

```c
int fat32_init() {
    struct buf *b = bread(0, 0);
    // 解析 BPB（BIOS Parameter Block）
    fat.bpb.byts_per_sec = *(uint16_t*)(b->data + 11);
    fat.bpb.sec_per_clus = *(b->data + 13);
    fat.bpb.rsvd_sec_cnt = *(uint16_t*)(b->data + 14);
    fat.bpb.fat_cnt = *(b->data + 16);
    fat.bpb.fat_sz = *(uint32_t*)(b->data + 36);
    fat.bpb.root_clus = *(uint32_t*)(b->data + 44);
    // 计算数据区起始扇区
    fat.first_data_sec = fat.bpb.rsvd_sec_cnt + fat.bpb.fat_cnt * fat.bpb.fat_sz;
}
```

#### 3.6.2 目录项结构

项目定义了 FAT32 的短文件名和长文件名目录项：

```c
typedef struct short_name_entry {
    char     name[11];
    uint8_t  attr;
    uint8_t  _nt_res;
    uint8_t  _crt_time_tenth;
    uint16_t _crt_time;
    uint16_t _crt_date;
    uint16_t _lst_acce_date;
    uint16_t fst_clus_hi;
    uint16_t _lst_wrt_time;
    uint16_t _lst_wrt_date;
    uint16_t fst_clus_lo;
    uint32_t file_size;
} __attribute__((packed)) short_name_entry_t;

typedef struct long_name_entry {
    uint8_t  order;
    uint16_t name1[5];
    uint8_t  attr;
    uint8_t  _type;
    uint8_t  checksum;
    uint16_t name2[6];
    uint16_t _fst_clus_lo;
    uint16_t name3[2];
} __attribute__((packed)) long_name_entry_t;
```

#### 3.6.3 簇链管理

```c
static uint32_t read_fat(uint32_t cluster) {
    uint32_t fat_sec = fat_sec_of_clus(cluster, 1);
    struct buf *b = bread(0, fat_sec);
    uint32_t next_clus = *(uint32_t*)(b->data + fat_offset_of_clus(cluster));
    brelse(b);
    return next_clus;
}

static uint32_t alloc_clus(uint8_t dev) {
    // 线性扫描 FAT 表寻找空闲簇
    for (uint32_t i = 0; i < fat.bpb.fat_sz; i++, sec++) {
        b = bread(dev, sec);
        for (uint32_t j = 0; j < ent_per_sec; j++) {
            if (((uint32_t*)(b->data))[j] == 0) {
                ((uint32_t*)(b->data))[j] = FAT32_EOC + 7;
                bwrite(b);
                brelse(b);
                zero_clus(clus);
                return clus;
            }
        }
    }
}
```

#### 3.6.4 目录缓存（entry_cache）

```c
struct entry_cache {
    struct spinlock lock;
    struct dirent entries[50];
} ecache;
```

使用 50 个 `dirent` 结构的双向链表缓存，与 xv6 的 inode 缓存类似。每个 `dirent` 包含文件名（最长 266 字符）、属性、首簇号、文件大小、当前簇、引用计数、父目录指针等。

#### 3.6.5 路径解析

```c
struct dirent* namei(char *path) {
    // 支持绝对路径和相对路径
    // 逐级解析目录分量
    // 支持 "." 和 ".."
}
```

#### 3.6.6 文件读写

`readi()` 和 `writei()` 通过簇链遍历实现文件的顺序读写：

```c
int readi(struct dirent *ep, int user_dst, uint64_t dst, uint32_t off, uint32_t n) {
    // 定位到 off 所在的簇
    // 通过 rw_clus() 读取数据
    // 沿簇链继续读取
}
```

#### 3.6.7 长文件名支持

`generate_shortname()` 为长文件名生成 8.3 格式的短文件名，`dirlookup()` 同时匹配长文件名和短文件名。

**完整度评估**：较为完整。实现了 FAT32 的核心功能，包括：
- BPB 解析
- 簇链读写
- 长/短文件名目录项
- 文件创建、删除、截断
- 目录创建
- 路径解析（绝对/相对路径）

不足之处：
- 不支持 FAT32 的 FSInfo 扇区
- 簇分配采用线性扫描，效率较低
- 不支持 FAT 表冗余（仅使用 FAT1）
- `mount`/`umount` 功能未实现
- 时间戳解析存在运算符优先级错误

---

### 3.7 块缓存子系统

**源文件**：`bcache.c`

实现了一个 **LRU 双向链表** 块缓存，容量为 30 个块：

```c
struct {
    struct spinlock lock;
    struct buf buf[30];
    struct buf head;
} bcache;
```

`bget()` 查找缓存命中时直接返回，未命中时从链表尾部（最近最少使用）回收 `refcnt == 0` 的块。每个块配有独立的睡眠锁。

**完整度**：完整。但缓存容量仅 30 块，对于 FAT32 文件系统（需要频繁访问 FAT 表）可能偏小。`bget()` 在所有块都被引用时缺少 panic 或等待机制，直接 fall through 到函数末尾（编译警告已指出）。

---

### 3.8 VirtIO 块设备驱动

**源文件**：`virtio_disk.c`

实现了 VirtIO MMIO 块设备驱动，遵循 VirtIO 1.1 规范：

```c
void virtio_disk_init(void) {
    // 设备识别与特性协商
    status |= VIRTIO_CONFIG_S_ACKNOWLEDGE;
    status |= VIRTIO_CONFIG_S_DRIVER;
    // 关闭不需要的特性
    features &= ~(1 << VIRTIO_BLK_F_RO);
    features &= ~(1 << VIRTIO_BLK_F_SCSI);
    // ...
    // 初始化 virtqueue
    *R(VIRTIO_MMIO_QUEUE_NUM) = NUM;  // NUM = 8
}
```

每次磁盘 I/O 使用 3 个描述符链：
1. 请求头（`virtio_blk_req`）：类型 + 扇区号
2. 数据缓冲区（512 字节）
3. 状态字节

使用 `sleep`/`wakeup` 机制等待 I/O 完成。中断处理函数 `virtio_disk_intr()` 在 PLIC 中断触发时处理已完成的请求。

**完整度**：完整。实现了基本的块设备读写。但 VirtIO MMIO 寄存器写入使用了非标准的偏移量（如 `*R(0x028)` 和 `*R(0x040)` 代替标准的 `QUEUE_DESC_LOW/HIGH`），这可能是为了适配特定 QEMU 版本。

---

### 3.9 UART 串口驱动

**源文件**：`uart.c`

实现了 16550 UART 驱动：

```c
int uart_init() {
    uart_write_reg(IER, 0x00);     // 关中断
    uart_write_reg(LCR, lcr | (1 << 7));  // DLAB=1
    uart_write_reg(DLL, 0x03);     // 波特率分频
    uart_write_reg(DLM, 0x00);
    uart_write_reg(LCR, lcr | (3 << 0));  // 8N1
    uart_write_reg(FCR, (1 << 0) | (3 << 1));  // FIFO 使能
    uart_write_reg(IER, (1 << 0) | (1 << 1));  // 收发中断
}
```

发送使用 32 字节环形缓冲区 + 中断驱动。接收在中断处理中直接调用 `consoleintr()`。同时提供同步发送 `uartputc_sync()` 用于 BACKSPACE 等需要立即输出的场景。

**完整度**：完整。

---

### 3.10 系统调用子系统

**源文件**：`syscall.c`、`sysfile.c`、`sysfproc.c`

#### 3.10.1 系统调用分发

```c
static uint64_t (*syscalls[])(void) = {
    [SYS_fork]    sys_fork,     // 1
    [SYS_exit]    sys_exit,     // 93
    [SYS_wait]    sys_wait,     // 3
    [SYS_pipe]    sys_pipe,     // 59
    [SYS_read]    sys_read,     // 63
    [SYS_write]   sys_write,    // 64
    [SYS_open]    sys_open,     // 56
    [SYS_close]   sys_close,    // 57
    [SYS_exec]    sys_exec,     // 7 (execve=221 也映射到此)
    [SYS_clone]   sys_clone,    // 220
    [SYS_mmap]    sys_mmap,     // 222
    [SYS_munmap]  sys_munmap,   // 215
    // ... 共约 30 个
};

void syscall() {
    int sys_index = p->trapframe->a7;
    if(sys_index > 0 && sys_index < NELEM(syscalls) && syscalls[sys_index]) {
        p->trapframe->a0 = syscalls[sys_index]();
    }
}
```

#### 3.10.2 系统调用实现详情

| 系统调用 | 编号 | 实现状态 | 备注 |
|----------|------|----------|------|
| fork | 1 | 完整 | 标准 fork 语义 |
| exit | 93 | 完整 | 支持退出状态 |
| wait/wait4 | 3/260 | 完整 | wait4 复用 wait 实现 |
| exec/execve | 7/221 | 完整 | ELF 加载 |
| clone | 220 | 部分 | 仅传递栈指针 |
| read | 63 | 完整 | 支持文件/管道/设备 |
| write | 64 | 完整 | 支持文件/管道/设备 |
| open | 56 | 完整 | 支持 O_CREATE/O_TRUNC/O_APPEND |
| openat | - | 部分 | 通过 sys_open 实现 |
| close | 57 | 完整 | 引用计数管理 |
| dup/dup2/dup3 | 23/24 | 完整 | fd 复制 |
| fstat | 8/80 | 完整 | 返回 kstat 结构 |
| mkdir | 34 | 完整 | 创建目录 |
| chdir | 49 | 完整 | 切换工作目录 |
| getcwd | 17 | 完整 | 获取当前路径 |
| unlink | 35 | 完整 | 删除文件 |
| getdents | 61 | 完整 | 读取目录项 |
| pipe | 59 | 完整 | 半双工管道 |
| brk/sbrk | 214 | 完整 | 堆管理 |
| mmap | 222 | 部分 | 仅支持文件映射，固定读 27 字节 |
| munmap | 215 | 部分 | 仅调用 uvmdealloc |
| sleep | 101 | 完整 | 毫秒级睡眠 |
| times | 153 | 完整 | 返回进程时间 |
| gettimeofday | 169 | 部分 | 基于 ticks 模拟，非真实时间 |
| uname | 160 | 完整 | 返回系统信息 |
| getpid | 172 | 完整 | |
| getppid | 173 | 完整 | 遍历进程表查找父进程 |
| yield | 124 | 完整 | 主动让出 CPU |
| kill | 6 | 完整 | 标记进程为 killed |
| mount | 40 | **未实现** | 仅查找路径，无实际挂载逻辑 |
| umount2 | 39 | **未实现** | 仅查找路径，无实际卸载逻辑 |

#### 3.10.3 mmap 实现分析

```c
void* sys_mmap(void) {
    int size = argraw(1);
    int perm = argraw(3);
    int off = argraw(5);
    uint64_t va = uvmalloc(myproc()->pagetable, myproc()->sz, myproc()->sz + size, perm);
    struct file *f;
    argfd(4, 0, &f);
    readi(f->ip, 1, va, 0, 27);  // 硬编码读取 27 字节
    return (void *)va;
}
```

该实现存在明显问题：
- 硬编码读取 27 字节而非使用 `size` 参数
- 未实现内存映射的延迟加载（demand paging）
- 未实现 MAP_SHARED/MAP_PRIVATE 语义
- 未实现文件写回

**完整度评估**：系统调用接口覆盖面较广（30+ 个），但部分实现（mmap、mount、umount、gettimeofday）为简化版本或桩实现。

---

### 3.11 IPC 子系统（管道）

**源文件**：`pipe.c`

实现了标准的半双工管道：

```c
struct pipe {
    struct spinlock lock;
    char data[PIPESIZE];    // PIPESIZE = 512
    uint32_t nread;
    uint32_t nwrite;
    int readopen;
    int writeopen;
};
```

- 使用环形缓冲区（512 字节）
- 写满时写端 sleep，读端读取后 wakeup
- 读空时读端 sleep，写端写入后 wakeup
- 一端关闭时唤醒另一端

**完整度**：完整。与 xv6 原版一致。

---

### 3.12 同步机制

**源文件**：`spinlock.c`、`sleeplock.c`

#### 自旋锁

```c
void acquire(struct spinlock *lock) {
    push_off();  // 关中断
    while(__sync_lock_test_and_set(&lock->locked, 1) != 0) { }
    __sync_synchronize();
    lock->cpu = mycpu();
}
```

使用 GCC 内置原子操作实现 test-and-set。`push_off`/`pop_off` 支持嵌套关中断。

#### 睡眠锁

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

基于自旋锁 + sleep/wakeup 实现，适用于长时间持锁场景（如磁盘 I/O）。

**完整度**：完整。

---

### 3.13 PLIC 中断控制器

**源文件**：`plic.c`

```c
void plicinit(void) {
    *(uint32_t*)(PLIC + Uart0_IRQ * 4) = 1;   // UART 优先级
    *(uint32_t*)(PLIC + VIRTIO0_IRQ * 4) = 1;  // VirtIO 优先级
}

void plicinithart(void) {
    int hart = cpuid();
    *(uint32_t*)PLIC_SENABLE(hart) = (1 << Uart0_IRQ) | (1 << VIRTIO0_IRQ);
    *(uint32_t*)PLIC_SPRIORITY(hart) = 0;  // 阈值 0，接受所有中断
}
```

仅启用了 UART（IRQ 10）和 VirtIO（IRQ 1）两个中断源。

**完整度**：完整。

---

### 3.14 用户态程序

**源文件**：`user/` 目录

#### 内置编译的用户程序

| 程序 | 源文件 | 功能 |
|------|--------|------|
| init | init.c | 初始化进程，启动 shell |
| sh | sh.c | 命令行 shell，支持管道、重定向、后台执行 |
| ls | ls.c | 目录列表 |
| cat | cat.c | 文件内容输出 |
| echo | echo.c | 字符串输出 |
| grep | grep.c | 模式匹配 |
| wc | wc.c | 行数/字数统计 |
| mkdir | mkdir.c | 创建目录 |
| rm | rm.c | 删除文件 |
| kill | kill.c | 终止进程 |
| forktest | forktest.c | fork 压力测试 |
| stressfs | stressfs.c | 文件系统压力测试 |
| grind | grind.c | 综合压力测试 |
| zombie | zombie.c | 僵尸进程测试 |

#### 预编译测试二进制

`user/` 和 `fs/` 目录中包含约 40 个预编译的 RISC-V ELF 二进制文件，覆盖了全部系统调用测试用例。这些二进制文件通过 `mkfs.vfat` 写入 FAT32 镜像。

Shell（`sh.c`）实现了完整的命令解析器，支持：
- 简单命令执行（EXEC）
- I/O 重定向（`<`、`>`、`>>`）
- 管道（`|`）
- 命令列表（`;`）
- 后台执行（`&`）
- 内置 `cd` 命令

---

## 四、子系统交互关系

```
用户程序 (sh, init, ...)
    |
    | ecall (系统调用)
    v
trampoline.S (uservec/userret)
    |
    v
trap.c (usertrap -> syscall)
    |
    +---> syscall.c (分发)
    |       |
    |       +---> sysfproc.c (fork, exec, wait, clone, exit, ...)
    |       |       |
    |       |       +---> proc.c (进程管理)
    |       |       |       |
    |       |       |       +---> vm.c (页表管理)
    |       |       |       +---> kalloc.c (物理页分配)
    |       |       |
    |       |       +---> exec.c (ELF 加载)
    |       |               |
    |       |               +---> fs.c (FAT32 文件读取)
    |       |
    |       +---> sysfile.c (open, read, write, close, ...)
    |               |
    |               +---> file.c (文件描述符管理)
    |               |       |
    |               |       +---> pipe.c (管道 IPC)
    |               |       +---> fs.c (FAT32 读写)
    |               |               |
    |               |               +---> bcache.c (块缓存)
    |               |                       |
    |               |                       +---> virtio_disk.c (VirtIO 驱动)
    |               |
    |               +---> console.c (控制台 I/O)
    |                       |
    |                       +---> uart.c (UART 驱动)
    |
    +---> 中断处理
            |
            +---> PLIC (plic.c) -> UART/VirtIO 中断
            +---> 时钟中断 (M-mode timervec -> S-mode software interrupt)
```

---

## 五、项目整体实现完整度评估

以 xv6-riscv 为基准，结合 OS 内核竞赛的常见要求，评估各维度完整度：

| 维度 | 完整度 | 说明 |
|------|--------|------|
| 引导启动 | 85% | 自制 M-mode 固件，但多核启动不完整 |
| 内存管理 | 80% | 基本页分配和 SV39 页表完整，缺少 COW |
| 进程管理 | 85% | fork/exec/wait/clone 完整，调度器简单 |
| 中断处理 | 80% | 用户态/内核态 trap 完整，代码重复较多 |
| 文件系统 | 85% | FAT32 核心功能完整，mount/umount 未实现 |
| 设备驱动 | 80% | UART + VirtIO 完整，无网络设备驱动 |
| 系统调用 | 75% | 30+ 个调用，部分为桩实现 |
| IPC | 70% | 仅管道，无信号、消息队列等 |
| 同步机制 | 90% | 自旋锁 + 睡眠锁完整 |
| 用户态生态 | 75% | 基础工具 + 测试用例，缺少编辑器等 |
| **总体** | **约 80%** | 以 xv6 为基准，FAT32 替换是主要增量 |

---

## 六、设计创新性分析

### 6.1 自制 M-mode SBI 固件

项目未使用标准 OpenSBI 或 RustSBI，而是自行实现了一个精简的 M-mode 固件。这体现了对 RISC-V 特权级架构的深入理解，包括：
- M-mode 到 S-mode 的特权级切换
- PMP（Physical Memory Protection）配置
- 中断委托机制
- CLINT 定时器管理

### 6.2 FAT32 文件系统替换

将 xv6 原生的简单文件系统替换为 FAT32 是本项目最大的工程增量。这需要：
- 理解 FAT32 规范（BPB、FAT 表、簇链、目录项格式）
- 实现长文件名（LFN）支持
- 适配 xv6 的 VFS 层（dirent 结构替代 inode）
- 处理 FAT32 与 xv6 块缓存的集成

### 6.3 用户态/内核态时钟分离

通过三个独立的中断分发函数（`devintr`/`user_devintr`/`kernel_devintr`），分别统计用户态和内核态的时钟滴答数，为 `times()` 系统调用提供数据。这是一种简洁的实现方式。

### 6.4 创新性局限

- 调度器仍为简单的轮转调度，未实现优先级调度或 CFS
- fork 未使用 COW 优化
- 无网络协议栈
- 无信号机制
- 无虚拟文件系统（VFS）抽象层

---

## 七、其他发现

### 7.1 代码质量问题

1. **重复代码**：`devintr()`、`user_devintr()`、`kernel_devintr()` 三个函数约 90% 代码相同。`sysfile.c` 和 `sysfproc.c` 中各自定义了 `argraw()` 和 `argfd()` 函数。
2. **死代码**：`page.c` 整个模块未被使用。`user.c` 中的 `user_task0/1/2()` 和 `os_main()` 为空函数。`fs.c` 中的 `balloc()`、`bfree()`、`readsb()` 未被使用。
3. **硬编码值**：`sys_mmap()` 中硬编码读取 27 字节。`sys_fstat()` 中的 `kstat` 结构体直接内联在函数中。
4. **注释语言混杂**：代码注释混合使用中文和英文，部分中文注释使用拼音（如 "zhu wen jian"、"mei ge shan qu zi jie shu"）。
5. **`syscall.h` 重复定义**：`SYS_fstat`、`SYS_sleep`、`SYS_uname`、`SYS_getppid`、`SYS_getpid` 存在重复宏定义，后者覆盖前者。
6. **`trampoline.S` 中 `timervec` 重复定义**：`timervec` 同时在 `timervec.S` 和 `trampoline.S` 中定义，可能导致链接冲突。

### 7.2 安全性问题

1. `sys_open()` 中路径缓冲区固定为 260 字节，但 `argstr()` 的 `MAXPATH` 也为 260，边界处理不够严谨。
2. `sys_mount()` 和 `sys_umount2()` 中路径缓冲区仅 20 字节，存在溢出风险。
3. `printf()` 使用全局静态缓冲区 `out_buf[1000]`，在多核环境下不安全。
4. `exec()` 中 `namei()` 返回 0 时进入 `while(1)` 死循环而非返回错误。

### 7.3 仓库卫生

- 根目录存在大量编译产物（`.o`、`.map`、`kernel-qemu`、`sbi-qemu`）
- 存在临时文件（`diff.txt`、`res.txt`、`test.txt`、`first.c`、`first.out`）
- 无 `.gitignore` 文件
- `USERCALL.S` 文件位于根目录，用途不明确（似乎是用户态系统调用包装的备用版本）

---

## 八、总结

本项目是一个基于 xv6-riscv 改造的 RISC-V 64 位教学/竞赛操作系统内核，命名为 "RuaruaOs"。项目的核心工作是将 xv6 的简单文件系统替换为 FAT32 文件系统，并自制了 M-mode SBI 固件。项目实现了约 30 个系统调用，覆盖了进程管理、内存管理、文件操作、IPC 等核心功能。

**主要优点**：
- FAT32 文件系统实现较为完整，支持长文件名
- 自制 M-mode 固件体现了对底层架构的理解
- 构建和运行流程完整，自动化测试通过率 93.75%
- Shell 功能完整，支持管道和重定向

**主要不足**：
- mount/umount 功能未实现
- mmap 实现过于简化（硬编码 27 字节）
- 多核支持形同虚设（M-mode 固件中非 0 号核进入死循环）
- 代码重复和死代码较多
- 缺少 COW、信号、网络等高级特性