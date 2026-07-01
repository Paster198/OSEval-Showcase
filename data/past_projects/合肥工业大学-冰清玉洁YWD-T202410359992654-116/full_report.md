# OS内核项目技术报告：合肥工业大学 - 冰清玉洁YWD

---

## 一、项目概述

本项目是一个基于 **xv6-riscv** 教学操作系统进行深度改造的操作系统内核，项目名称为"冰清玉洁YWD"，由合肥工业大学团队开发，参加2024年OS内核比赛。项目使用 **C语言** 编写内核主体，辅以少量汇编代码，支持 **RISC-V 64位** 架构，目标平台为 **QEMU virt** 虚拟机和 **Kendryte K210** 开发板。

### 代码规模

| 类别 | 行数 |
|------|------|
| 内核C/汇编源文件 (`kernel/*.c`, `kernel/*.S`) | 16,526 行 |
| 内核头文件 (`kernel/include/*.h`) | 7,076 行 |
| 用户态程序 (`xv6-user/`) | 5,604 行 |
| **总计** | **约 29,206 行** |

---

## 二、构建与测试结果

### 2.1 构建过程

构建使用 `riscv64-linux-gnu-gcc` 交叉编译工具链，通过 GNU Make 驱动。构建过程中发现以下问题：

1. **`xv6-user/usys.pl` 拼写错误**：第58-60行使用了 `enrty` 而非 `entry`，导致 Perl 脚本执行失败。
2. **`SYS_setargv` 未定义**：`usys.pl` 中引用了 `SYS_setargv`，但 `sysnum.h` 中仅定义了 `SYS_getargv`（编号203），名称不匹配。
3. **`sh.c` 无限递归警告**：GCC 13 检测到 `runcmd()` 函数的无限递归模式，需添加 `-Wno-infinite-recursion` 标志。
4. **`ostest.c` 缺少头文件**：`ostest.c` 中 `#include "string.h"` 无法找到对应文件。

修复上述问题后，内核二进制文件 `target/kernel`（约 901KB）成功生成。

### 2.2 QEMU 运行测试

使用以下命令启动 QEMU：
```
qemu-system-riscv64 -machine virt -kernel target/kernel -m 8M -nographic -smp 2 \
  -bios bootloader/SBI/sbi-qemu -drive file=disk.img,if=none,format=raw,id=x0 \
  -device virtio-blk-device,drive=x0,bus=virtio-mmio-bus.0
```

**测试结果：启动失败。** RustSBI 固件在跳转至内核入口地址 `0x80200000` 后，hart 0 触发了 `InstructionFault` 异常（`mepc: 0x80004282`），导致系统 panic。分析原因：

- 预编译的 `sbi-qemu` 固件版本为 0.1.1，与当前内核可能存在兼容性问题。
- 内核入口代码 `entry_qemu.S` 中栈空间计算方式（`add t0, a0, 1; slli t0, t0, 14`，即每核 16KB 栈）与 RustSBI 传递的 hartid 可能存在不匹配。
- 该固件为仓库预编译的二进制文件，无法在当前环境中重新编译验证。

**结论：由于 RustSBI 固件兼容性问题，无法在当前环境中完成完整的运行时测试。**

---

## 三、子系统详细分析

### 3.1 启动引导子系统

**相关文件**：`kernel/entry_qemu.S`, `kernel/entry_k210.S`, `bootloader/SBI/`

**实现细节**：

项目使用 **RustSBI** 作为 SBI（Supervisor Binary Interface）固件，提供 M-mode 到 S-mode 的跳转服务。内核入口代码极为简洁：

```asm
.section .text
.globl _entry
_entry:
    add t0, a0, 1        # hartid + 1
    slli t0, t0, 14      # 乘以 16384 (16KB per hart)
    la sp, boot_stack
    add sp, sp, t0       # 设置每核独立栈
    call main
```

每个 hart 分配 16KB 的启动栈空间（`boot_stack` 区域共 `4096 * 4 * 2 = 32KB`，支持 2 核）。RustSBI 将 hartid 通过 `a0` 寄存器传递，DTB 地址通过 `a1` 传递（但内核未使用 DTB）。

**完整度评估**：基本完整，但 K210 平台的入口代码未做深入验证。RustSBI 版本较旧（0.1.1），使用的是 legacy SBI 调用接口（v0.1），而非 SBI v0.2+ 的标准化接口。

---

### 3.2 内存管理子系统

#### 3.2.1 物理内存分配器 (`kalloc.c`)

**核心设计**：基于空闲链表的页分配器，附带引用计数机制。

物理内存范围为 `kernel_end` 至 `PHYSTOP`（`0x80600000`），即约 4MB 可用物理内存。分配器引入了一个 **内存管理表 `mm_table`**，用于跟踪每个物理页的引用计数：

```c
char *mm_table;       // 每页一个字节的引用计数
uint64 pa_addr_start; // 可用物理内存起始地址

void kfree(void *pa) {
    int index = ((uint64)pa - pa_addr_start) / PGSIZE;
    if (mm_table[index] > 1) {
        --mm_table[index];  // 引用计数减1，不释放
        return;
    }
    // 引用计数为1时真正释放
    memset(pa, 1, PGSIZE);
    // 加入空闲链表...
    --mm_table[index];
}
```

这一设计是为了支持 **写时复制（CoW）** 和 **mmap 共享映射** 而引入的。`kalloc_two_pages()` 函数一次性分配两个连续物理页，用于特殊场景。

**完整度评估**：约 75%。引用计数机制是一个有意义的改进，但存在以下问题：
- `mm_table` 本身占用物理内存，减少了可用页数。
- `kfree` 中对 `pa` 的合法性检查使用 `kernel_end` 而非 `pa_addr_start`，可能导致边界条件错误。
- 缺少内存碎片整理机制。

#### 3.2.2 虚拟内存管理 (`vm.c`)

**核心设计**：Sv39 三级页表，每进程独立内核页表。

项目的一个显著特点是 **每个进程拥有独立的内核页表**（`p->kpagetable`），而非共享全局内核页表。这意味着：

```c
// 在 scheduler() 中，每次进程切换时：
w_satp(MAKE_SATP(p->kpagetable));  // 切换到进程的内核页表
sfence_vma();
swtch(&c->context, &p->context);
w_satp(MAKE_SATP(kernel_pagetable));  // 切回全局内核页表
sfence_vma();
```

内核页表的虚拟地址偏移为 `VIRT_OFFSET = 0x3F00000000L`，即物理地址 `0x80000000` 映射到虚拟地址 `0x3F80000000`。设备寄存器（UART、PLIC、CLINT、VirtIO 等）均通过此偏移进行直接映射。

**页表遍历**（`walk` 函数）实现了标准的 Sv39 三级页表查找：

```c
pte_t *walk(pagetable_t pagetable, uint64 va, int alloc) {
    if (va >= MAXVA) panic("walk");
    for (int level = 2; level > 0; level--) {
        pte_t *pte = &pagetable[PX(level, va)];
        if (*pte & PTE_V)
            pagetable = (pagetable_t)PTE2PA(*pte);
        else {
            if (!alloc || (pagetable = (pde_t*)kalloc()) == NULL)
                return NULL;
            memset(pagetable, 0, PGSIZE);
            *pte = PA2PTE(pagetable) | PTE_V;
        }
    }
    return &pagetable[PX(0, va)];
}
```

**用户/内核数据拷贝**：项目实现了 `copyin2`/`copyout2` 函数，通过进程的内核页表（而非用户页表）进行地址转换，避免了用户页表不可信的问题：

```c
int copyout2(uint64 dstva, const char *src, uint64 len) {
    // 通过当前进程的内核页表进行地址转换
    struct proc *p = myproc();
    uint64 pa = kwalkaddr(p->kpagetable, dstva);
    // ...
}
```

**完整度评估**：约 70%。独立内核页表是一个有创意的设计，但增加了 TLB 刷新开销和内存消耗。`mappages_test` 函数（非页对齐映射）存在潜在的对齐问题。

---

### 3.3 进程管理子系统

#### 3.3.1 进程控制块 (`proc.h`)

```c
struct proc {
    struct spinlock lock;
    enum procstate state;        // UNUSED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE
    struct proc *parent;
    void *chan;                  // 睡眠通道
    int killed;
    int xstate;
    int pid;
    uint64 kstack;               // 内核栈虚拟地址
    uint64 sz;                   // 进程内存大小
    uint64 static_sz;            // 静态内存大小
    pagetable_t pagetable;       // 用户页表
    pagetable_t kpagetable;      // 独立内核页表
    struct trapframe *trapframe;
    struct context context;
    struct file *ofile[NOFILE];  // 打开文件表 (101个)
    struct dirent *cwd;
    struct mapped_file mfile;    // mmap映射信息
    struct tms ti;               // 时间统计
    struct my_seg my_seg;        // ELF段信息（用于按需加载）
    struct proc *next;           // 空闲链表指针
    uint64 priority_proc;        // 优先级 (0最高, 2最低)
    uint64 slot;                 // 时间片数量
};
```

#### 3.3.2 进程分配机制

项目将原版 xv6 的静态进程数组改为 **动态空闲链表** 方式：

```c
struct proc *proc_freelist = NULL;  // 空闲链表头
struct spinlock proc_freelist_lock;

static struct proc *allocproc_test(void) {
    pagetable_t kpt = (pagetable_t)kalloc();
    memmove(kpt, kernel_pagetable, PGSIZE);  // 拷贝内核页表
    
    char *pstack = kalloc();  // 为进程PCB分配物理页
    mappages(kpt, VKSTACK, PGSIZE, (uint64)pstack, PTE_R | PTE_W);
    
    struct proc *kstack_proc = (struct proc *)pstack;
    memset(kstack_proc, 0, sizeof(struct proc));
    initlock(&kstack_proc->lock, "proc");
    kstack_proc->slot = 1;
    kstack_proc->priority_proc = 2;
    kstack_proc->next = proc_freelist;
    proc_freelist = kstack_proc;
    // ...
}
```

每个进程的 PCB（进程控制块）被放置在一个独立的物理页中，并通过内核页表映射到固定虚拟地址 `VKSTACK`（`0x3EC0000000`）。这意味着所有进程共享同一个虚拟地址作为内核栈，但由于每个进程有独立的内核页表，实际映射到不同的物理页。

**完整度评估**：约 65%。空闲链表设计存在明显问题：
- `allocproc_test` 函数中，新创建的进程被立即加入空闲链表，然后又被取出使用，逻辑混乱。
- 变量 `f` 用于控制首次分配的特殊行为，但逻辑不完整。
- `proc_freelist1` 和 `proc_freelist2` 被声明但从未使用。

#### 3.3.3 调度器

调度器采用 **简单的轮转调度（Round-Robin）** 算法：

```c
void scheduler(void) {
    struct cpu *c = mycpu();
    c->proc = 0;
    for (;;) {
        intr_on();
        int found = 0;
        for (p = proc_freelist; p != NULL; p = p->next) {
            acquire(&p->lock);
            if (p->state == RUNNABLE) {
                p->state = RUNNING;
                c->proc = p;
                w_satp(MAKE_SATP(p->kpagetable));
                sfence_vma();
                swtch(&c->context, &p->context);
                w_satp(MAKE_SATP(kernel_pagetable));
                sfence_vma();
                c->proc = 0;
                found = 1;
            }
            release(&p->lock);
        }
        if (found == 0) {
            intr_on();
            asm volatile("wfi");  // 等待中断，降低功耗
        }
    }
}
```

**时间片机制**：在定时器中断处理中实现：

```c
// trap.c - usertrap()
if (which_dev == 2) {  // 定时器中断
    p->slot--;
    if (p->slot == 0) {
        p->slot = 1;  // 重置时间片
        yield();
    }
}
```

**优先级调度**：虽然 `proc` 结构体中包含 `priority_proc` 字段，且提供了 `sys_setpriority` 系统调用，但调度器中 **并未实际使用优先级**。相关代码被注释掉：

```c
// sysproc.c - sys_setpriority()
p->priority_proc = n;
// remove_proc_from_list(p);   // 被注释
// insert_proc_in_list(p);     // 被注释
```

**完整度评估**：约 60%。调度器基本可用，但优先级调度功能未完成。时间片默认为1（即每个定时器中断都可能触发调度），粒度较粗。`wfi` 指令的使用是一个优化点。

#### 3.3.4 进程创建 (`do_clone`)

`fork` 和 `clone` 系统调用共用 `do_clone` 函数：

```c
int do_clone(uint64 stack, uint64 flags) {
    struct proc *np = allocproc_test();
    // 共享父进程的用户内存（写时复制）
    proc_share(p->pagetable, np->pagetable, np->kpagetable, p->sz);
    np->sz = p->sz;
    np->parent = p;
    *(np->trapframe) = *(p->trapframe);
    if (stack != 0) np->trapframe->sp = stack;
    np->trapframe->a0 = 0;  // 子进程返回0
    // 复制文件描述符
    for (i = 0; i < NOFILE; i++)
        if (p->ofile[i]) np->ofile[i] = filedup(p->ofile[i]);
    np->cwd = edup(p->cwd);
    np->state = RUNNABLE;
    return pid;
}
```

`proc_share` 函数实现了父子进程间的 **写时复制（Copy-on-Write）** 语义，通过共享物理页并增加引用计数来实现。

---

### 3.4 中断与异常处理子系统

#### 3.4.1 陷阱处理 (`trap.c`)

陷阱处理分为用户态陷阱（`usertrap`）和内核态陷阱（`kerneltrap`）两条路径。

**用户态陷阱处理流程**：

```c
void usertrap(void) {
    w_stvec((uint64)kernelvec);  // 重定向到内核陷阱向量
    p->trapframe->epc = r_sepc();
    
    if (r_scause() == 8) {       // 系统调用
        p->trapframe->epc += 4;  // 跳过 ecall 指令
        intr_on();
        syscall();
    } else if ((which_dev = devintr(0)) != 0) {
        // 设备中断
    } else if (page_fault() != 0) {
        // 页面错误处理
    } else {
        p->killed = 1;           // 未知异常，杀死进程
    }
    // 时间片耗尽则让出CPU
    if (which_dev == 2) {
        p->slot--;
        if (p->slot == 0) { p->slot = 1; yield(); }
    }
    usertrapret();
}
```

#### 3.4.2 页面错误处理

项目实现了 **按需页面分配（Lazy Allocation）** 和 **按需代码加载（Demand Paging）**：

```c
int page_fault() {
    uint64 scause = r_scause();
    uint64 addr = r_stval();
    
    if (scause == 15)       return do_store_fault(addr);  // 写错误
    else if (scause == 13)  return do_load_fault(addr);   // 读错误
    else if (scause == 12)  return do_ins_fault(addr);    // 指令错误
    return -1;
}
```

**写错误处理**（`do_store_fault`）实现了写时复制：

```c
int do_store_fault(uint64 addr) {
    pte_t *pte = walk(p->pagetable, addr, 0);
    if ((*pte & PTE_R) == 0) {
        // 页不存在，分配新页
        char *mem = kalloc();
        *pte = PA2PTE((uint64)mem) | PTE_R | PTE_W | PTE_X | PTE_U | PTE_V;
    } else {
        // 页存在但只读（CoW），复制页内容
        char *mem = kalloc();
        memmove(mem, (char*)PTE2PA(*pte), PGSIZE);
        *pte = PA2PTE((uint64)mem) | flags | PTE_W;
        kfree((void*)PTE2PA(*pte));  // 减少原页引用计数
    }
    // 同步更新内核页表
    *kpte = *pte & ~PTE_U;
    return 1;
}
```

**指令错误处理**（`do_ins_fault`）实现了按需从磁盘加载 ELF 段：

```c
int do_ins_fault(uint64 addr) {
    // 遍历进程的ELF段信息
    for (int j = 0; j < p->my_seg.num; ++j) {
        if (addr >= my.vaddr && addr < my.vaddr + my.filesz) {
            uvmalloc(p->pagetable, p->kpagetable, tmp_addr, tmp_addr + PGSIZE);
            loadseg(p->pagetable, tmp_addr, p->myep, my.off + (tmp_addr - my.vaddr), msz);
            return 1;
        }
    }
    return -1;
}
```

**完整度评估**：约 65%。页面错误处理是一个重要的扩展功能，但实现存在以下问题：
- `do_store_fault` 中 CoW 路径先 `kalloc` 新页再 `kfree` 旧页，在高内存压力下可能失败。
- `do_load_fault` 对已存在但无效的页直接分配零页，未检查是否为合法访问。
- `do_ins_fault` 要求 `vaddr` 必须页对齐，否则 panic，限制了 ELF 段的灵活性。
- 所有页面错误处理中缺少对 `sfence.vma` 的调用，可能导致 TLB 不一致。

---

### 3.5 系统调用子系统

#### 3.5.1 系统调用表

项目实现了 **52 个系统调用**，涵盖以下类别：

| 类别 | 系统调用 | 数量 |
|------|----------|------|
| 进程管理 | `fork`, `exit`, `wait`, `wait4`, `kill`, `getpid`, `getppid`, `clone`, `exec`, `execve`, `sched_yield` | 11 |
| 文件操作 | `open`, `openat`, `read`, `write`, `close`, `dup`, `dup3`, `mkdir`, `mkdirat`, `chdir`, `getcwd`, `remove`, `rename`, `fstat`, `fstatat`, `getdents64`, `linkat`, `unlinkat` | 18 |
| 内存管理 | `sbrk`, `mmap`, `munmap` | 3 |
| 管道/IPC | `pipe`, `pipe2` | 2 |
| 系统信息 | `uname`, `times`, `gettimeofday`, `sysinfo`, `uptime` | 5 |
| 设备/挂载 | `dev`, `mount`, `umount2`, `finit` | 4 |
| 调试/调度 | `trace`, `test_proc`, `sleep`, `nanosleep`, `setslot`, `setpriority`, `getargv` | 7 |

#### 3.5.2 系统调用分发

```c
void syscall(void) {
    int num = p->trapframe->a7;
    if (num > 0 && num < NELEM(syscalls) && syscalls[num]) {
        p->trapframe->a0 = syscalls[num]();
        // trace 功能
        if ((p->tmask & (1 << num)) != 0) {
            printf("pid %d: %s -> %d\n", p->pid, sysnames[num], p->trapframe->a0);
        }
    }
}
```

系统调用号采用 Linux RISC-V ABI 编号（如 `fork=1`, `exit=93`, `read=63`, `write=64`），体现了向 Linux 兼容方向的努力。

**完整度评估**：约 70%。系统调用数量丰富，但部分实现存在问题：
- `sys_waitpid` 中 `argaddr(0, &options)` 应为 `argaddr(2, &options)`，参数索引错误。
- `sys_times` 直接写入用户地址 `t->tms_cstime = ...`，未通过 `copyout` 进行安全检查。
- `sys_uname` 同样直接写入用户地址。
- `sys_getargv` 功能不完整，仅声明但未实现有效逻辑。

---

### 3.6 文件系统子系统

#### 3.6.1 FAT32 文件系统 (`fat32.c`)

项目用 **FAT32** 文件系统替代了原版 xv6 的简单文件系统，这是一个重大的架构变更。

**BPB（BIOS Parameter Block）解析**：

```c
static struct {
    uint32 first_data_sec;
    uint32 data_sec_cnt;
    uint32 data_clus_cnt;
    uint32 byts_per_clus;
    struct {
        uint16 byts_per_sec;
        uint8  sec_per_clus;
        uint16 rsvd_sec_cnt;
        uint8  fat_cnt;
        uint32 hidd_sec;
        uint32 tot_sec;
        uint32 fat_sz;
        uint32 root_clus;
    } bpb;
} fat;
```

**目录项缓存**：使用 50 个条目的双向链表缓存（`ecache`），支持长文件名（LFN）和短文件名（SFN）：

```c
static struct entry_cache {
    struct spinlock lock;
    struct dirent entries[ENTRY_CACHE_NUM];  // 50个缓存条目
} ecache;
```

**簇分配**：通过线性扫描 FAT 表寻找空闲簇：

```c
static uint32 alloc_clus(uint8 dev) {
    uint32 sec = fat.bpb.rsvd_sec_cnt;
    uint32 const ent_per_sec = fat.bpb.byts_per_sec / sizeof(uint32);
    for (uint32 i = 0; i < fat.bpb.fat_sz; i++, sec++) {
        b = bread(dev, sec);
        for (uint32 j = 0; j < ent_per_sec; j++) {
            if (((uint32 *)(b->data))[j] == 0) {
                ((uint32 *)(b->data))[j] = FAT32_EOC + 7;
                bwrite(b); brelse(b);
                zero_clus(clus);
                return clus;
            }
        }
    }
    panic("no clusters");
}
```

**挂载支持**：项目实现了 `mount`/`umount` 系统调用，支持最多 8 个挂载点：

```c
struct fstype dev_fat[8];  // 挂载设备集合
int mount_num = 0;

int do_mount(struct dirent *mountpoint, struct dirent *dev) {
    // 将dev的文件系统信息保存到dev_fat数组
    // 修改mountpoint的指向
}
```

**链接支持**：通过自定义属性 `ATTR_LINK (0x40)` 实现硬链接：

```c
int link(char *oldpath, struct file *f1, char *newpath, struct file *f2) {
    // 创建新的目录项指向同一个簇
}
```

**完整度评估**：约 70%。FAT32 实现覆盖了核心功能（读写、目录遍历、创建/删除、长文件名），但存在以下不足：
- 簇分配采用线性扫描，效率低下，缺少空闲簇位图。
- FAT 表缓存未实现（代码注释中提到 "should be a cache layer for FAT table"）。
- 缺少 FSInfo 扇区支持。
- 挂载功能的实现较为粗糙，`dev_fat[0].bpb.tot_sec = dev_fat->bpb.tot_sec` 存在指针使用错误。
- 长文件名支持存在，但未做完整的 Unicode 处理。

#### 3.6.2 缓冲区缓存 (`bio.c`)

项目对原版 xv6 的缓冲区缓存进行了重构，采用 **哈希链表 + 空闲链表** 的双链表设计：

```c
#define NBUFLIST 4

struct {
    struct spinlock lock;
    struct buf head;
} listcache[NBUFLIST];  // 4个哈希桶

struct {
    struct spinlock lock;
    struct buf head;
} freecache;  // 空闲缓冲区链表

int listhash(uint dev, uint sectorno) {
    return (dev + sectorno) & (NBUFLIST - 1);
}
```

`bget` 函数首先在哈希链表中查找目标块，若未找到则从空闲链表中分配。当缓冲区被占用时，请求者通过 `sleep(b, NULL)` 进入睡眠等待。

**完整度评估**：约 65%。哈希分桶设计减少了锁竞争，但：
- 仅 4 个哈希桶，在大量 I/O 时仍可能产生冲突。
- `bget` 中使用 `sleep(b, NULL)` 而非持有锁的 sleep，可能导致竞态条件。
- 缺少 LRU 淘汰策略，空闲链表的回收顺序不确定。

---

### 3.7 设备驱动子系统

#### 3.7.1 VirtIO 磁盘驱动 (`virtio_disk.c`)

实现了 VirtIO legacy MMIO 接口的块设备驱动，使用描述符环（descriptor ring）进行异步 I/O：

```c
static struct disk {
    char pages[2*PGSIZE];       // 描述符环内存（页对齐）
    struct VRingDesc *desc;     // 描述符数组
    uint16 *avail;              // 可用环
    struct UsedArea *used;      // 已用环
    char free[NUM];             // 描述符空闲标记
    uint16 used_idx;
    struct { struct buf *b; char status; } info[NUM];
    struct spinlock vdisk_lock;
} __attribute__((aligned(PGSIZE))) disk;
```

每次 I/O 操作使用 3 个描述符：头部（类型+扇区号）、数据、状态。驱动通过 `sleep`/`wakeup` 机制等待 I/O 完成。

**完整度评估**：约 80%。实现较为完整，但使用 legacy VirtIO 接口（v0.9），未支持 VirtIO 1.0+ 标准。

#### 3.7.2 K210 平台驱动

项目为 K210 平台实现了以下驱动：

| 驱动 | 文件 | 功能 |
|------|------|------|
| SPI | `spi.c` | SPI 总线通信 |
| GPIO | `gpiohs.c` | 高速 GPIO 控制 |
| FPIOA | `fpioa.c` (4,943行) | 引脚复用配置 |
| SD卡 | `sdcard.c` | SD 卡读写（通过 SPI） |
| DMA | `dmac.c` | DMA 控制器 |
| 系统控制 | `sysctl.c` | 时钟和复位控制 |

**完整度评估**：K210 驱动代码量较大（`fpioa.c` 单独占 4,943 行），但由于缺少 K210 硬件，无法验证其功能正确性。

#### 3.7.3 控制台驱动 (`console.c`)

通过 SBI 调用实现字符级 I/O，支持行编辑（退格、kill line、EOF）和进程列表打印（Ctrl+P）。

---

### 3.8 同步机制子系统

#### 3.8.1 自旋锁 (`spinlock.c`)

标准的测试-设置自旋锁，使用 RISC-V 的 `amoswap.w.aq` 原子指令：

```c
void acquire(struct spinlock *lk) {
    push_off();  // 禁用中断
    while (__sync_lock_test_and_set(&lk->locked, 1) != 0)
        ;
    __sync_synchronize();  // 内存屏障
    lk->cpu = mycpu();
}
```

#### 3.8.2 睡眠锁 (`sleeplock.c`)

基于自旋锁和 `sleep`/`wakeup` 机制的睡眠锁，适用于长时间持锁场景。

**完整度评估**：约 85%。同步机制实现完整且正确，但缺少读写锁、条件变量等高级同步原语。

---

### 3.9 红黑树 (`rbtree.c`)

项目从 Linux 内核移植了红黑树实现（约 400 行），包含插入、删除、颜色修复等完整操作。但在当前代码中 **未发现红黑树的实际使用场景**，可能是为未来的调度器或内存管理预留的数据结构。

---

### 3.10 用户态程序

项目包含约 20 个用户态程序：

| 程序 | 功能 |
|------|------|
| `init.c` | 初始进程，打开控制台并启动 shell |
| `sh.c` | Shell，支持管道、重定向、后台执行、环境变量 |
| `cat.c` | 文件内容输出 |
| `echo.c` | 字符串输出 |
| `grep.c` | 模式匹配 |
| `ls.c` | 目录列表 |
| `mkdir.c` | 创建目录 |
| `rm.c` | 删除文件 |
| `find.c` | 文件查找 |
| `wc.c` | 字数统计 |
| `xargs.c` | 参数传递 |
| `sleep_.c` | 睡眠 |
| `kill.c` | 进程终止 |
| `mv.c` | 文件移动/重命名 |
| `strace.c` | 系统调用跟踪 |
| `test.c` | 系统信息测试 |
| `usertests.c` | 综合测试 |
| `ostest.c` | OS竞赛测试框架 |
| `YzY.c` | 自定义测试程序 |
| `sacrifice.c` | 牺牲进程（用于测试） |

Shell 实现了环境变量管理（`export` 命令），支持最多 16 个环境变量。

---

### 3.11 mmap 内存映射

`do_mmap` 实现了文件到内存的映射：

```c
uint64 do_mmap(uint64 start, long len, int prot, int flags, int fd, long off) {
    if (start == 0) start_address = alloc_v_space(len);
    if (p->mfile.valid == 1) return -1;  // 每进程仅支持一个映射
    // 检查边界...
    start_map(start_address, len, prot, file->ep, off);
    p->mfile.baseaddr = start_address;
    p->mfile.len = PGROUNDUP(len);
    return start_address;
}
```

**限制**：每个进程仅支持一个文件映射，`MAP_SHARED` 和 `MAP_PRIVATE` 互斥检查通过 `file->map_pid` 实现。`do_munmap` 在取消映射前会调用 `syn_disk` 将修改同步回磁盘。

---

## 四、子系统交互关系

```
用户程序 (xv6-user/)
    |
    | ecall (系统调用)
    v
trampoline.S (uservec) --> trap.c (usertrap) --> syscall.c (syscall)
    |                                              |
    |                                              +--> sysproc.c (进程管理)
    |                                              +--> sysfile.c (文件操作)
    |                                              +--> proc.c (mmap/clone)
    |
    | 中断
    v
kernelvec.S --> trap.c (kerneltrap) --> devintr()
    |                                      |
    |                                      +--> timer.c (定时器)
    |                                      +--> plic.c --> virtio_disk.c / console.c
    |
    v
scheduler() --> swtch.S (上下文切换)
    |
    v
vm.c (页表管理) <-- kalloc.c (物理内存)
    |
    v
fat32.c (文件系统) --> bio.c (缓冲缓存) --> disk.c --> virtio_disk.c / sdcard.c
```

关键交互路径：
1. **系统调用路径**：用户态 `ecall` -> `trampoline.S` 保存寄存器 -> 切换内核页表 -> `usertrap` 分发 -> `syscall` 查表执行 -> `usertrapret` 返回。
2. **I/O 路径**：`fileread/filewrite` -> `eread/ewrite` (FAT32) -> `bread/bwrite` (缓冲缓存) -> `disk_read/disk_write` -> `virtio_disk_rw` (VirtIO) -> 中断完成。
3. **进程切换路径**：`yield` -> `sched` -> `swtch` (保存/恢复 callee-saved 寄存器) -> 调度器选择下一进程 -> `swtch` 恢复 -> 切换内核页表。

---

## 五、项目创新性分析

### 5.1 创新点

1. **每进程独立内核页表**：这是本项目最显著的设计创新。每个进程拥有独立的内核页表，使得内核空间的映射可以按进程定制（如内核栈映射到固定虚拟地址 `VKSTACK`），简化了地址管理。但代价是每次进程切换需要两次 `satp` 写入和 `sfence.vma`，增加了 TLB 刷新开销。

2. **物理页引用计数**：在页分配器中引入引用计数表（`mm_table`），为写时复制和共享映射提供了基础设施，这是对原版 xv6 的重要改进。

3. **按需页面加载**：通过页面错误处理实现了延迟分配（lazy allocation）和按需从磁盘加载 ELF 段（demand paging），减少了进程启动时的内存占用。

4. **FAT32 文件系统替代**：用 FAT32 替代 xv6 的简单文件系统，使得系统可以与主机交换文件，提高了实用性。

5. **挂载机制**：实现了 `mount`/`umount` 系统调用，支持多文件系统挂载，这在 xv6 衍生项目中较为少见。

### 5.2 创新程度评估

整体创新性属于 **中等偏低** 水平。项目的核心改进（独立内核页表、引用计数、按需加载）是有意义的探索，但实现质量参差不齐。FAT32 文件系统和红黑树移植属于已有实现的集成，而非原创设计。优先级调度等功能虽有框架但未完成。

---

## 六、项目完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 启动引导 | 75% | 双平台支持，但 RustSBI 版本过旧 |
| 物理内存管理 | 75% | 引用计数机制有价值，但边界处理不完善 |
| 虚拟内存管理 | 70% | 独立内核页表有创意，但 TLB 管理不够严谨 |
| 进程管理 | 65% | 空闲链表设计混乱，优先级调度未完成 |
| 调度器 | 60% | 基本轮转可用，优先级/时间片功能不完整 |
| 中断/异常处理 | 65% | 页面错误处理有创意但存在正确性问题 |
| 系统调用 | 70% | 数量丰富（52个），部分实现有参数错误 |
| FAT32 文件系统 | 70% | 核心功能完整，性能和健壮性不足 |
| 缓冲区缓存 | 65% | 哈希分桶设计合理，但锁使用有隐患 |
| 设备驱动 | 80% | VirtIO 驱动完整，K210 驱动未验证 |
| 同步机制 | 85% | 自旋锁和睡眠锁实现正确 |
| 用户程序 | 75% | Shell 功能丰富，测试程序覆盖主要系统调用 |

**整体完整度**：约 **70%**（以"一个可启动、可交互、能运行基本用户程序的操作系统内核"为基准）。

---

## 七、其他发现

### 7.1 代码质量问题

1. **大量注释掉的代码**：`proc.c` 中存在大量被注释掉的旧版代码（如原版 `allocproc`），与新代码混杂，严重影响可读性。
2. **调试代码残留**：多处 `printf` 调试输出未清理（如 `printf("-----------etext-------%p\n", ...)`）。
3. **变量命名不规范**：如 `f`、`kpagetableyzy`、`allocproc_test` 等命名缺乏语义。
4. **重复的 `return 0`**：`fat32_init` 函数末尾有两个连续的 `return 0;`。
5. **`usys.pl` 拼写错误**：`enrty` 应为 `entry`，`SYS_setargv` 应为 `SYS_getargv`。

### 7.2 安全性问题

1. `sys_times` 和 `sys_uname` 直接写入用户地址，未通过 `copyout` 进行地址验证。
2. `sys_waitpid` 参数索引错误（`argaddr(0, &options)` 应为 `argaddr(2, &options)`）。
3. 页面错误处理中缺少对非法地址的充分检查。

### 7.3 设计决策

- 物理内存仅 4MB（`0x80200000` - `0x80600000`），对于运行多个用户程序较为紧张。
- QEMU 启动参数中 `-m 8M` 分配了 8MB 内存，但内核仅使用前 4MB。
- 最大进程数 50，最大打开文件数 200，对于教学项目足够。

---

## 八、总结

本项目是基于 xv6-riscv 的一次有意义的改造尝试，主要贡献在于：引入每进程独立内核页表、物理页引用计数、FAT32 文件系统、按需页面加载、mmap 内存映射、mount/umount 挂载机制等。系统调用数量从原版 xv6 的约 20 个扩展到 52 个，向 Linux ABI 靠拢。

然而，项目在实现质量上存在明显不足：代码中存在大量未完成的实验性代码（优先级调度、进程空闲链表）、拼写错误导致的构建失败、参数索引错误、直接写入用户地址的安全隐患，以及 RustSBI 固件兼容性问题导致的启动失败。这些问题表明项目处于开发中期状态，尚未经过充分的测试和代码审查。

从竞赛角度评估，该项目展示了团队对操作系统核心概念的理解和一定的创新能力，但在工程化程度、代码质量和功能完整性方面仍有较大的提升空间。