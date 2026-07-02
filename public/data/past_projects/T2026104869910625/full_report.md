# S-OS (SuperOS) 深度技术分析报告

## 一、分析过程概述

本报告基于对项目源代码的完整遍历分析，覆盖了：
- 全部 65 个 C 源文件和 12 个汇编源文件的逐文件阅读
- 83 个头文件的接口分析
- 编译验证：对 RISC-V 架构下的核心源文件进行了独立编译测试，全部通过（无错误、无警告）
- 构建系统分析：分析了基于 GNU Make 的递归构建体系

## 二、构建测试结果

**RISC-V 构建测试（部分）：**
- 用户态 initcode 编译、链接、二进制提取、头文件生成全部成功。
- 内核核心模块（process.c、vmem.c、pmem.c、vma.c、slab_common.c、exec.c、spinlock.c、sleeplock.c）独立编译通过。
- 文件系统模块（ext4.c、ext4_fs.c、ext4_extent.c、ext4_journal.c、ext4_dir_idx.c、file.c、inode.c、bio.c、vfs_ext4.c、pipe.c）独立编译通过。
- syscall.c（4605 行）独立编译通过。
- **完整构建缺失原因**：系统缺少 LoongArch 交叉编译工具链，而顶层 Makefile 的 `all` 目标强制同时构建两架构。子 Makefile 依赖顶层 `export` 的变量，无法独立运行。

---

## 三、项目整体架构

S-OS 采用经典的三层宏内核架构，在双指令集架构之间实现了良好的隔离：

```
┌──────────────────────────────────────────────────────────┐
│          用户态 (User Space)                              │
│   initcode ──> syscall ──> busybox/glibc/musl/LTP        │
├──────────────────────────────────────────────────────────┤
│          系统调用层 (syscall.c: 4605行, 119+ syscall)     │
├──────────────────────────────────────────────────────────┤
│          内核核心层                                       │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │ 进程/  │ │ 内存   │ │ 文件系统  │ │ 同步/信号/Futex │ │
│  │ 线程   │ │ 管理   │ │ (EXT4)   │ │                 │ │
│  └────────┘ └────────┘ └──────────┘ └─────────────────┘ │
├──────────────────────────────────────────────────────────┤
│          HSAI 硬件服务抽象接口层                           │
│  hsai_trap.c / hsai_mem.c / plic.c / print.c             │
├──────────────────────────────────────────────────────────┤
│          HAL 硬件抽象层                                   │
│  ┌─────────────────────┐ ┌────────────────────────────┐  │
│  │ RISC-V 64 (7个文件)  │ │ LoongArch 64 (8个文件)     │  │
│  │ entry.S trampoline.S │ │ entry.S trampoline.S      │  │
│  │ switch.S kernelvec.S │ │ swtch.S kernelvec.S       │  │
│  │ start.c sbi.c uart.c │ │ tlbrefill.S merrvec.S     │  │
│  └─────────────────────┘ │ uart.c                     │  │
│                          └────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 四、子系统详细拆解

### 4.1 架构适配层 (HAL)

HAL 层为两个目标架构各提供一套独立汇编/C实现，接口由 `include/hal/` 下的头文件定义。

#### 4.1.1 RISC-V 64 HAL (`hal/riscv/`)

**entry.S — 内核入口**
```asm
.global _entry
_entry:
    la sp, entry_stack
    call start
spin:
    j spin
```
从 QEMU `-kernel` 加载后直接跳转到 `_entry`，设置简单的内核栈后跳转到 C 代码 `start()`。

**start.c — 机器模式初始化**
```c
void start() {
    w_sie(r_sie() | SIE_SEIE | SIE_STIE | SIE_SSIE);
    w_tp(0);
    timer_init();
    sos_start_kernel();
}
```
在 SBI 模式下（`#if defined SBI`），直接开启中断并进入内核主函数。非 SBI 模式（已废弃的路径）则设置 M 态委托、PMP 配置后通过 `mret` 进入 S 态。

**trampoline.S — 用户态/内核态切换蹦床**
这是内核最关键的一段汇编。`uservec` 处理从用户态进入内核：
1. 通过 `csrrw a0, sscratch, a0` 交换 a0 和 TRAPFRAME 地址
2. 保存全部 32 个用户寄存器到 trapframe
3. 恢复内核栈指针（`ld sp, 8(a0)`）
4. 恢复内核页表（`ld t1, 0(a0)` → `csrw satp, t1`）
5. 跳转到 `usertrap()`

`userret` 执行反向操作：恢复用户页表、恢复寄存器、`sret` 返回用户态。

**switch.S — 上下文切换**
```asm
swtch:
    sd ra, 0(a0)
    sd sp, 8(a0)
    sd s0, 16(a0)
    ...
    ld ra, 0(a1)
    ld sp, 8(a1)
    ...
    ret
```
保存 callee-saved 寄存器（ra、sp、s0-s11）到 `old` context，从 `new` context 恢复。

**sbi.c — OpenSBI 接口封装**
封装了 `set_timer()`、`console_putchar()` 等 SBI ecall，对上层透明。

**uart.c — NS16550 UART 驱动**
基于 MMIO 的 `put_char_sync()` 实现，地址为 `UART0 (0x10000000)`。

#### 4.1.2 LoongArch 64 HAL (`hal/loongarch/`)

**entry.S — 内核入口**
```asm
_entry:
    li.d  $t0, 0x900000000000001f   # DMWIN0: CA, PLV0
    csrwr $t0, LOONGARCH_CSR_DMWIN0
    li.d  $t0, 0x8000000000000001   # DMWIN1: UA, PLV0
    csrwr $t0, LOONGARCH_CSR_DMWIN1
    ...
    bl    sos_start_kernel
```
设置两个直接映射窗口（DMW），使 0x8000... 和 0x9000... 两个地址空间范围的访问直接映射到物理地址，绕过 TLB。同时清零 BSS 段。

**trampoline.S — 用户态/内核态切换**
使用 LoongArch 的 `csrwr $a0, LOONGARCH_CSR_SAVE0` 机制保存/恢复 TRAPFRAME 地址。保存全部 23 个通用寄存器（含 `$r21`、`$fp`）。恢复时通过 `csrwr $a1, LOONGARCH_CSR_PGDL` 切换页表，`ertn` 返回用户态。

**swtch.S — 上下文切换**
保存/恢复 ra、sp、s0-s8、fp 共 12 个寄存器，通过 `jirl $zero, $ra, 0` 跳转。

**kernelvec.S — 内核态异常向量**
在内核栈上保存全部 23 个寄存器后调用 C 函数 `kerneltrap()`，返回时恢复。

**merrvec.S — 机器错误异常向量**
调用 `machine_trap()` 处理机器级异常。

**tlbrefill.S — TLB 重填处理**
当 TLB 缺失时硬件自动跳转到此入口进行页表遍历和 TLB 填充。这是 LoongArch 特有的硬件辅助机制。

**uart.c — LoongArch UART 驱动**
基于 LS7A 桥片的 UART 实现（地址 `0x800000001FE001E0`）。

#### 4.1.3 架构宏差异对比

| 特性 | RISC-V 64 | LoongArch 64 |
|------|-----------|--------------|
| 页表级数 | 3 (Sv39) | 4 |
| 页大小 | 4KB | 4KB |
| 虚拟地址宽度 | 39位 (MAXVA=0x4000000000) | 48位 |
| 直接映射窗口 | 无 (所有映射通过页表) | 有 (DMW0/DMW1) |
| 内核基址 | 0x80200000 (SBI) | 0x90041000 |
| TRAMPOLINE | MAXVA - PGSIZE | MAXVA - PGSIZE |
| 上下文切换寄存器数 | 14 (ra,sp,s0-s11) | 12 (ra,sp,s0-s8,fp) |
| 返回用户态指令 | sret | ertn |
| 定时器机制 | SBI set_timer / stimecmp | 倒计时自动装载 |
| 中断控制 | PLIC + sie/sip | ECFG + ESTAT |

---

### 4.2 HSAI 层 (硬件服务抽象接口)

HSAI 层是 HAL 和内核核心之间的桥梁，通过条件编译 (`#if defined RISCV`) 屏蔽架构差异。

#### 4.2.1 Trap 分发 (`hsai_trap.c`)

**hsai_trap_init()** — 设置异常入口：
```c
void hsai_trap_init(void) {
#if defined RISCV
    w_stvec((uint64)kernelvec);
#else
    w_csr_ecfg(ecfg);           // 例外配置
    w_csr_eentry((uint64)kernelvec);
    w_csr_tlbrentry((uint64)handle_tlbr);
    w_csr_merrentry((uint64)handle_merr);
    timer_init();
    w_csr_euen(FPE_ENABLE);    // 启用浮点
#endif
}
```

**usertrap()** — 用户态异常处理主函数（位于 hsai_trap.c 中）：
- 通过 `r_scause()`/`r_csr_estat()` 获取异常原因
- 系统调用（ecall）：调用 `syscall(trapframe)` 分发
- 缺页异常：调用 `pagefault_handler()` 按需分配物理页
- 时钟中断：调用 `yield()` 触发调度
- 设备中断：调用 `devintr()` 判断并分发

**pagefault_handler()** — 缺页处理：
```c
int pagefault_handler(uint64 addr) {
    // 1. 在进程VMA列表中查找addr所属的VMA
    // 2. 从Buddy分配器分配物理页
    // 3. 通过mappages()建立虚拟地址到物理页的映射
    // 4. 权限设为 R|W|X|D|U
}
```

**架构相关接口封装**：hsai_set_usertrap()、hsai_set_csr_to_usermode()、hsai_set_csr_sepc()、hsai_get_arg()、hsai_swtch()、hsai_set_trapframe_* 系列函数均通过条件编译适配双架构。

#### 4.2.2 内存硬件配置 (`hsai_mem.c`)

**hsai_config_pagetable()** — 激活内核页表：
```c
void hsai_config_pagetable(pgtbl_t kernel_pagetable) {
#if defined RISCV
    w_satp(MAKE_SATP(kernel_pagetable));  // Sv39模式
    sfence_vma();
#else
    w_csr_pgdl(...);
    w_csr_pgdh(...);
    invtlb 0x0, $zero, $zero;
    w_csr_stlbps(0xcU);
    w_csr_pwcl(...);  // 配置页表遍历控制
    w_csr_pwch(...);
#endif
}
```

#### 4.2.3 PLIC 中断控制器 (`plic.c`)
RISC-V 平台的 PLIC 初始化（plicinit/plicinthart）、中断声明（plic_claim）和完成（plic_complete）。

#### 4.2.4 内核打印 (`print.c`)
完整的 printf 实现，支持 `%d %u %x %lx %llx %p %s %%`，带自旋锁保护。同时实现了 panic/assert 框架（含红色高亮输出和 LoongArch 平台关机）。

---

### 4.3 进程与线程管理子系统

#### 4.3.1 进程管理 (`kernel/process.c`, 1419行)

**进程池设计：**
```c
#define NPROC (256)
struct proc pool[NPROC];
char kstack[NPROC][PAGE_SIZE];
```
静态分配 256 个进程槽位，每个进程预分配一个内核栈页。

**进程结构体 (`proc_t`)**：
- 基础属性：pid、pgid、sid、uid、gid、umask
- 状态管理：state (UNUSED/USED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE)、exit_state、killed、term_signal
- 内存管理：pagetable、sz、virt_addr、vma 链表
- 线程管理：main_thread、thread_queue（链表）
- 文件描述符：ofile[NOFILE] (NOFILE=128)
- 信号：sig_set、sigaction[SIGRTMAX+1]、sig_pending
- 定时器：itimer、alarm_ticks、timer_active
- 同步：lock (自旋锁)、chan (睡眠通道)
- 共享内存：sharememory[MAX_SHAREMEMORY_REGION_NUM]

**核心进程操作：**

- **allocproc()**：遍历进程池找 UNUSED 槽位，分配 pid、trapframe（通过 Buddy 分配一页）、页表（proc_pagetable）、主线程，初始化 VMA。

- **fork()**：复制当前进程。关键步骤：
  1. `allocproc()` 创建新进程
  2. `uvmcopy()` 逐页复制用户地址空间
  3. 增加文件引用计数 (filedup)
  4. 复制 VMA 链表
  5. 设置子进程返回值为 0

- **exec()**：见 4.3.3 ELF 加载器。

- **exit()**：关闭所有文件描述符、唤醒父进程、将子进程托孤给 initproc、设置 ZOMBIE 状态、调用 sched()。

- **wait()**：遍历进程池查找 ZOMBIE 子进程，调用 freeproc() 释放资源。

- **clone()**：支持 CLONE_VM、CLONE_FS、CLONE_FILES、CLONE_THREAD 等标志，实现 Linux 兼容的线程创建。clone_thread() 创建共享同一进程结构的轻量级线程。

- **scheduler()**：简单的轮转调度器，遍历进程池中的 RUNNABLE 进程，在每个进程内遍历 thread_queue 找可运行线程，通过 hsai_swtch() 切换上下文。

- **sleep_on_chan()/wakeup()**：经典的睡眠/唤醒同步原语，基于 chan 地址匹配。

#### 4.3.2 线程管理 (`kernel/thread.c`, 58行)

**线程设计：**
```c
#define THREAD_NUM 1024
typedef struct thread {
    enum thread_state state;  // t_UNUSED/t_USED/t_SLEEPING/t_RUNNABLE/t_RUNNING/t_ZOMBIE/t_TIMING
    struct proc *p;
    void *chan;
    int tid;
    uint64 awakeTime;        // futex 超时唤醒时间
    uint64 kstack;           // 线程内核栈
    uint64 vtf;              // trapframe虚拟地址
    uint64 sz;
    struct trapframe *trapframe;
    context_t context;
    struct list_elem elem;   // 线程链表节点
    uint64 clear_child_tid;
} thread_t;
```

采用 **1:1 线程模型**：每个线程有独立的内核栈、trapframe 和 context。线程通过 `thread_queue` 链表组织在所属进程中。调度器在进程内遍历线程队列选择可运行线程。

`alloc_thread()` 从全局 `free_thread` 链表中取一个空闲线程，分配内核栈和 trapframe。

#### 4.3.3 ELF 加载器 (`kernel/exec.c`, 795行)

**exec() 函数流程：**

1. **脚本检测**：`is_sh_script()` 检测 `#!` shebang，若为脚本则替换为 busybox sh 执行。

2. **ELF 头验证**：读取 ELF header，验证 magic number (`0x464C457F`)。

3. **PT_LOAD 段加载**：
   - 遍历所有程序头
   - 对 PT_LOAD 段调用 `uvm_grow()` 扩展虚拟地址空间
   - 调用 `loadseg()` 加载段内容到内存
   - 支持 PIE（位置无关可执行文件），设置 load_bias = 0x10000

4. **动态链接支持**：
   - 检测 PT_INTERP 段获取解释器路径
   - 支持四种解释器路径：
     - `/lib/ld-linux-riscv64-lp64d.so.1` (RISC-V glibc)
     - `/lib/ld-musl-riscv64-sf.so.1` 或 `/lib/ld-musl-riscv64.so.1` (RISC-V musl)
     - `/lib64/ld-musl-loongarch-lp64d.so.1` (LoongArch musl)
     - `/lib64/ld-linux-loongarch-lp64d.so.1` (LoongArch glibc)
   - 加载解释器 ELF 到用户空间
   - 设置解释器的入口地址为 AT_ENTRY

5. **辅助向量 (AUX vector) 构造**：
   - AT_PHDR、AT_PHENT、AT_PHNUM、AT_PAGESZ
   - AT_BASE（解释器基地址）、AT_ENTRY
   - AT_UID、AT_EUID、AT_GID、AT_EGID
   - AT_RANDOM（16字节随机数）
   - AT_SECURE

6. **用户栈构造**：依次压入 envp、argv、argc，设置初始 SP。

#### 4.3.4 信号处理 (`kernel/signal.c`, 59行)

实现了基础的 POSIX 信号接口：
- **sigaction**：为进程设置信号处理函数（仅记录，未实现实际信号递送）
- **sigprocmask**：支持 SIG_BLOCK、SIG_UNBLOCK、SIG_SETMASK
- 进程结构体中维护了 `sig_set`（信号掩码）、`sig_pending`（挂起信号集）、`sigaction` 数组
- 强制确保 SIGTERM、SIGKILL、SIGSTOP 不被阻塞

---

### 4.4 内存管理子系统

#### 4.4.1 Buddy System 物理页分配器 (`kernel/pmem.c`, 1087行)

**核心数据结构：**
```c
typedef struct {
    uint64 mem_start, mem_end;
    uint64 total_pages;
    uint64 *bitmap;            // 位图，标记每个物理页的使用状态
    buddy_node_t *nodes;       // 每个物理页的元数据
    struct list free_lists[BUDDY_MAX_ORDER + 1];  // 各阶空闲链表
} buddy_system_t;
```

**分配算法：**
1. `buddy_alloc(order)`：从 free_lists[order] 开始查找，若该阶无空闲块则向更高阶查找并分割（split），分割出的伙伴块加入低阶空闲链表
2. `buddy_free(addr, order)`：释放块后检查伙伴是否也空闲，若是则合并（coalesce）为更高阶块

**元数据自管理：**
初始化时元数据（bitmap + nodes）占用的页面被标记为已使用并设置特殊标记 `order = -1`，确保不会被分配出去。

**辅助函数：**
- `pmem_alloc_pages(n)`：分配 n 个连续物理页（通过 buddy_alloc）
- `pmem_free_pages(addr, n)`：释放 n 个物理页
- `kfree()`：释放单个对象（优先 SLAB，大对象走 buddy）
- 调试支持：`debug_buddy` 标志、`buddy_check_integrity()` 完整性检查

#### 4.4.2 虚拟内存管理 (`kernel/vmem.c`, 754行)

**多级页表实现：**

**walk()** — 页表遍历核心函数：
```c
pte_t *walk(pgtbl_t pt, uint64 va, int alloc) {
    for (int level = PT_LEVEL - 1; level > 0; level--) {
        pte = &pt[PX(level, va)];
        if (*pte & PTE_V)
            pt = (pgtbl_t)(PTE2PA(*pte) | dmwin_win0);
        else if (alloc)
            pt = (pgtbl_t)pmem_alloc_pages(1);
            *pte = PA2PTE(pt) | PTE_WALK | dmwin_win0;
        else return NULL;
    }
    return &pt[PX(0, va)];
}
```
通过 `PT_LEVEL`（RISC-V=3, LoongArch=4）和 `PX()` 宏自动适配页表级数。LoongArch 使用 `dmwin_win0` 将物理地址映射到可直接访问的虚拟地址窗口。

**关键内存操作：**
- **mappages()**：在 [va, va+len) 建立到 [pa, pa+len) 的页面对齐映射
- **vmunmap()**：解除映射，可选是否释放物理页
- **uvmalloc()**：扩展用户空间（sz→newsz），逐页分配物理内存并映射
- **uvmdealloc()**：收缩用户空间
- **uvmcopy()**：逐页复制（fork 使用），浅复制物理页
- **copyin()/copyout()**：内核与用户空间之间的数据复制，通过 walkaddr 逐页翻译后 memmove
- **copyinstr()**：从用户空间复制以 null 结尾的字符串

**vmem_init()** — 内核页表初始化：
- RISC-V：映射 UART0、VIRTIO0、PLIC、内核代码段、内核数据段、trampoline
- LoongArch：仅映射 trampoline（代码/数据通过 DMW 直接映射）
- 两架构均映射进程内核栈区域（proc_mapstacks）

**freewalk()**：递归释放多级页表结构。

#### 4.4.3 VMA 管理 (`kernel/vma.c`, 777行)

**VMA 链表结构：**
```c
struct vma {
    enum VMA_TYPE type;   // NONE, MMAP, STACK, HEAP
    uint64 addr, end;     // 虚拟地址范围 [addr, end)
    uint64 perm;          // 页表权限位
    int flags;            // MAP_PRIVATE/MAP_SHARED/MAP_ANONYMOUS
    int fd, offset;       // 文件映射参数
    struct vma *prev, *next;  // 双向链表
};
```

**核心操作：**
- **vma_init()**：分配哨兵 VMA 节点，预留 `USER_MMAP_START` 区域
- **alloc_mmap_vma()**：在 VMA 链表中查找合适位置插入新 VMA，支持 MAP_FIXED 精确地址映射
- **find_mmap_vma()**：根据地址查找所属 VMA（用于 page fault 处理）
- **free_vma_list()**：释放整个 VMA 链表

**mmap() 实现：**
1. 通过 `get_mmapperms()` 将 POSIX PROT_* 转换为架构相关的页表权限位
2. 分配 VMA 节点
3. 逐页分配物理内存并建立映射（匿名映射）或读取文件内容（文件映射）
4. 支持 MAP_SHARED（共享映射，通过 walk 检测已有映射避免重复分配）
5. 文件映射超出部分填零

**munmap() 实现：**
遍历 VMA 链表找到与 [start, start+len) 重叠的 VMA，支持三种情况：
- 完全覆盖：删除整个 VMA
- 部分覆盖（头部）：调整 VMA->addr
- 部分覆盖（尾部）：调整 VMA->end
- 中间截断：分裂 VMA 为两部分
每步操作对应调用 `vmunmap()` 释放页表映射和物理内存。

**brk() 实现：**
扩展/收缩进程数据段（heap），通过 VMA 管理实现，`growproc()` 调用 `uvm_grow()`/`uvmdealloc()`。

#### 4.4.4 SLAB 分配器 (`kernel/slab_common.c`, 353行)

**设计：**
- 8 个固定大小的 kmem_cache：8B、16B、32B、64B、128B、256B、512B、1024B
- 每个 kmem_cache 维护 `free_slab` 和 `full_slab` 两个链表
- SLAB 页头部存储 magic number 用于验证

**slab_alloc()：**
1. `__slab_size()` 将请求大小向上对齐到最近的 2^n
2. `__fine_kmem_cache()` 查找对应缓存
3. `__alloc_from_kmem_cache()` 从 free_slab 中取出 object

**slab_free()：**
通过地址反查所属 SLAB 页（利用页对齐），将 object 插回 SLAB 的 object 链表。若 SLAB 原在 full_slab 链表（free==0），则移回 free_slab。

**初始化技巧：**
slab 系统初始化时需要给自己分配元数据结构，但此时 SLAB 尚未就绪。使用 `simple_alloc()` 从启动页中顺序分配临时内存作为过渡方案。

---

### 4.5 文件系统子系统

#### 4.5.1 概述

文件系统是 S-OS 最大的子系统，包含 28 个源文件（约 20,684 行），基于开源的 **lwext4** 库移植和适配。实现了从底层块设备到高层 VFS 接口的完整 EXT4 文件系统栈。

#### 4.5.2 块设备层

**bio.c — 缓冲区缓存：**
```c
struct buf bcache.buf[NBUF];  // NBUF = 3000
```
- **bget(dev, blockno)**：LRU 缓存查找/分配
- **bread(dev, blockno)**：获取缓存块，无效时触发磁盘读取
- **bwrite(buf)**：写回脏块到磁盘
- **brelse(buf)**：释放引用，移到 LRU 头部
- 使用睡眠锁（sleeplock）保护每个 buf

**blockdev.c — EXT4 块设备接口适配：**
将 lwext4 的 `ext4_blockdev_iface` 接口桥接到内核的 buf 缓存层：
```c
static int blockdev_read(struct ext4_blockdev *bdev, void *buf, 
                          uint64_t blk_id, uint32_t blk_cnt) {
    for(int i = 0; i < blk_cnt; i++) {
        struct buf *b = bread(0, blk_id + i);
        memmove(buf, b->data, BSIZE);
        brelse(b);
    }
}
```

**ext4_bcache.c / ext4_blockdev.c：**
提供 lwext4 内部使用的块缓存和块设备抽象层。

#### 4.5.3 lwext4 核心模块

**ext4.c (3056行)** — EXT4 高级操作：
- 设备注册/注销 (`ext4_device_register/unregister`)
- 文件操作：`ext4_fopen/fclose/fread/fwrite/fseek/ftruncate`
- 目录操作：`ext4_dir_open/close/entry_get/entry_next`
- 路径解析与 inode 操作：`ext4_raw_inode_fill`、`ext4_inode_get`
- 链接操作：`ext4_link/unlink/symlink`
- 挂载点管理：`ext4_mount/umount`

**ext4_extent.c (1885行)** — Extent 树：
- 完整的 Extent 树实现（替代传统间接块映射）
- Extent 分裂（split）、合并、查找、插入、删除
- 支持 initialized/unwritten extent 区分
- 树深度遍历、路径管理 (ext4_extent_path)

**ext4_journal.c (1908行)** — JBD2 日志：
- 日志超级块读取与验证
- 事务提交（commit）与恢复（replay）
- 撤销（revoke）条目管理（RB-Tree）
- 校验和（CRC32c）验证
- 日志空间管理（wrap-around 处理）

**ext4_dir_idx.c (1294行)** — HTree 目录索引：
- 基于 HTree 的目录索引实现
- dx_root 信息管理、hash 版本控制
- 索引节点条目增删查
- 目录项排序（ext4_dir_dx_sort）

**ext4_fs.c (1639行)** — 文件系统管理：
- 超级块读写与验证
- 特性检查（features_compatible/incompatible/read_only）
- 间接块限制计算
- 文件系统初始化/清理

**ext4_super.c (242行)** — 超级块操作：
- 超级块读写、校验、块大小获取
- inode 计数、空闲块计数管理

**ext4_inode.c (321行)** — Inode 操作：
- Inode 读写、类型判断、访问时间更新
- 数据块数量计算

**ext4_balloc.c (641行)** — 块分配器：
- 数据块分配与释放
- 块位图管理

**ext4_ialloc.c (347行)** — Inode 分配器：
- Inode 分配与释放
- Inode 位图管理

**ext4_xattr.c (1430行)** — 扩展属性：
- xattr 读写、列举、删除
- xattr block/inode 管理

**ext4_mkfs.c (774行)** — 文件系统创建：
- 从已有超级块信息创建完整的 EXT4 文件系统结构
- 块组描述符、inode 表初始化

**ext4_hash.c (317行)** — 目录 Hash：
- 支持 TEA 和 Half MD4 两种 hash 算法
- 用于 HTree 目录索引

**ext4_mbr.c (205行)** — MBR 分区表：
- MBR 分区表解析
- 分区类型识别

**ext4_crc32.c (144行)** — CRC32 校验：
- CRC32c 计算
- 用于日志和元数据校验

**ext4_block_group.c (81行)** — 块组描述符：
- 块组描述符读写
- inode/block 位图块号获取

**ext4_bitmap.c (159行)** — 位图操作：
- 位图查找空闲位、设置/清除位

**ext4_trans.c (94行)** — 事务支持：
- 事务开始/结束
- 块事务操作

**ext4_debug.c (55行)** — 调试支持。

#### 4.5.4 VFS 层

**fs.c (273行)** — 文件系统注册：
- 文件系统表 `fs_table[VFS_MAX_FS]`
- `init_fs()` 注册 EXT4 和 VFAT 两种文件系统
- `fs_mount()/fs_umount()` 挂载/卸载
- `get_fs_from_path()` 通过路径前缀匹配查找所属文件系统
- `dir_init()` 创建 /dev/null、/proc、/tmp、/usr/lib 等必要目录

**vfs_ext4.c (1306行)** — VFS-EXT4 桥接层：
- 将 lwext4 的 C API 封装为 VFS 接口
- 线程安全的递归睡眠锁（vfs_ext4_os_lock/unlock）
- 文件操作：`vfs_ext4_open/close/read/write/lseek/readat`
- 目录操作：`vfs_ext4_mkdir/rmdir`
- 文件创建/删除：`vfs_ext4_create/unlink/symlink/mknod`
- 属性操作：`vfs_ext4_fstat/chmod/chown`
- 挂载操作：`vfs_ext4_mount/umount`
- busybox /proc 虚拟文件系统兼容（/proc/self/oom_score_adj、/proc/mounts、/proc/meminfo 等）

**vfs_vfat.c (122行)** — VFAT 兼容层（基础实现）。

**file.c (1098行)** — 文件对象管理：
- 文件描述符表管理（每个进程最多 NOFILE=128 个，系统级 NFILE=1024）
- `filealloc/filedup/fileclose`
- `fileread/filewrite`（支持设备文件和普通文件）
- `filestat` 文件状态查询
- busybox 虚拟 /proc 文件支持（进程 stat、oom_score_adj 等）
- `get_file_ops()` 返回当前文件系统操作函数表

**inode.c (483行)** — Inode 管理：
- Inode 缓存（NINODE=1024）
- `namei()` 路径名到 inode 的解析（含符号链接跟踪）
- `get_absolute_path()` 相对路径转绝对路径
- `ialloc/iget/iput/free_inode`

**pipe.c (180行)** — 匿名管道：
- `pipealloc()` 创建管道（一对 file 结构，一个读端一个写端）
- `pipewrite()/piperead()` 基于内核缓冲区的流式读写
- 管道缓冲区大小：512 字节
- 睡眠/唤醒同步（读写端互相等待）

#### 4.5.5 EXT4 功能覆盖

| 特性 | 支持状态 |
|------|---------|
| 超级块读写与校验 | 完整 |
| Extent 树（替代间接块） | 完整（含分裂/合并/查找） |
| HTree 目录索引 | 完整（TEA/Half MD4 hash） |
| JBD2 日志 | 完整（含恢复/撤销/CRC32c） |
| 块分配/Inode分配 | 完整 |
| 扩展属性 (xattr) | 完整 |
| 符号链接 | 完整 |
| 硬链接 | 完整 |
| 文件创建/删除/重命名 | 完整 |
| mkfs (创建文件系统) | 完整 |
| MBR 分区表 | 完整 |
| 64位块号支持 | 完整 |
| 柔性块组 (flex_bg) | 部分 |
| 写时复制/快照 | 未实现 |
| 加密 | 未实现 |

---

### 4.6 设备驱动子系统

#### 4.6.1 RISC-V VirtIO MMIO 块设备 (`kernel/driver/riscv/virt.c`, 317行)

**初始化流程：**
1. 验证 Magic Value (0x74726976)、Version、Device ID (2=block)、Vendor ID
2. 特性协商（禁用 RO、SCSI、WCE、MQ、ANY_LAYOUT、EVENT_IDX、INDIRECT_DESC）
3. 队列设置（队列 0、大小 NUM=32、共享内存地址）
4. 设置 DRIVER_OK 状态

**读写流程 (virtio_rw)：**
- 分配三个描述符：请求头（type+sector）、数据缓冲区（512B buf）、状态字节
- 通过 avail ring 通知设备
- 忙等（`while(b->disk == 1)`）等待中断完成
- 中断处理函数 `virtio_disk_intr()` 扫描 used ring，更新 buf 状态

**同步机制：** 使用忙等而非睡眠，适用于单核简单场景。

#### 4.6.2 LoongArch VirtIO PCI 块设备 (`kernel/driver/loongarch/virtio_disk.c`, 590行)

与 RISC-V 版本相似但通过 PCI 总线访问：
- PCI 配置空间访问（`virtio_pci.c`）
- 队列和描述符管理与 RISC-V 版本类似
- 使用自旋锁保护磁盘操作

#### 4.6.3 PCI 总线枚举 (`kernel/driver/loongarch/pci.c`, 142行)

```c
uint64 pci_device_probe(uint16 vendor_id, uint16 device_id) {
    for (int bus = 0; bus < 255; bus++)
        for (int dev = 0; dev < 32; dev++) {
            uint64 off = (bus << 16) | (dev << 11) | (func << 8);
            volatile uint32 *base = (volatile uint32 *)PCI_ADDR(off);
            if (base[0] == pci_id) { /* 匹配 */ }
        }
}
```
遍历 PCI 总线枚举设备，基于 ECAM 地址空间（0x20000000）。

#### 4.6.4 VirtIO-PCI 传输层 (`kernel/driver/loongarch/virtio_pci.c`, 289行)

封装 PCI 配置空间中的 VirtIO 能力结构（capability）定位，提供 `virtio_pci_find_capability()`、`virtio_pci_get_bar()` 等接口。

---

### 4.7 系统调用子系统 (`kernel/syscall.c`, 4605行)

#### 4.7.1 系统调用分发

```c
void syscall(struct trapframe *trapframe) {
    uint64 a[8];
    for (int i = 0; i < 8; i++)
        a[i] = hsai_get_arg(trapframe, i);
    switch (a[7]) {
        case SYS_write: ...
        case SYS_read: ...
        // 119+ case branches
    }
    hsai_set_trapframe_epc(trapframe, ...);  // 设置返回值
}
```
从 trapframe 提取 a0-a7 八个参数寄存器，a7 为系统调用号，通过 switch-case 分发。系统调用号使用 Linux 标准编号（如 SYS_write=64, SYS_read=63 等）。

#### 4.7.2 实现的系统调用清单（119个）

**进程类 (12个)：**
fork, clone, clone3, execve, exit, exit_group, wait, getpid, getppid, gettid, set_tid_address, sched_yield

**文件类 (28个)：**
openat, close, read, write, readv, writev, pread, dup, dup3, pipe2, fstat, fstatat, statx, getdents64, getcwd, chdir, mkdirat, unlinkat, symlinkat, readlinkat, renameat2, fcntl, ioctl, fchmod, fchmodat, fchown, fchownat, mknod

**内存类 (6个)：**
mmap, munmap, brk, mprotect, mremap, madvise

**信号类 (7个)：**
kill, tkill, tgkill, rt_sigaction, rt_sigprocmask, rt_sigtimedwait, signalfd4

**时间类 (10个)：**
gettimeofday, clock_gettime, clock_getres, clock_nanosleep, nanosleep, times, getitimer, settimer, timerfd_create, utimensat

**Socket/网络类 (12个)：**
socket, bind, connect, listen, accept, getsockname, sendto, recvfrom, setsockopt, shutdown, sendfile64, ppoll

**事件/同步类 (8个)：**
futex, epoll_create1, epoll_ctl, epoll_pwait, eventfd2, set_robust_list, get_robust_list, membarrier

**系统信息类 (10个)：**
uname, sysinfo, syslog, statfs, getuid, geteuid, getgid, getegid, getresuid, getresgid, getrusage, prlimit64

**其他 (26个)：**
mount, umount, faccessat, sched_setaffinity, sched_getaffinity, setpgid, getpgid, getsid, setsid, getgroups, setgid, setuid, umask, llseek, sync, ftruncate, fsync, fdatasync, shmget, shmat, shmctl, pidfd_open, pselect6_time32, getrandom

#### 4.7.3 关键系统调用实现细节

**sys_openat：** 支持 O_CREAT、O_DIRECTORY、O_TRUNC 等标准 flags，路径解析通过 namei()，创建新文件通过 vfs_ext4_create()。

**sys_ioctl：** 实现了丰富的 ioctl 命令：FIONBIO、FIONREAD、TCGETS/TCSETS（终端属性）、TIOCGWINSZ（窗口大小）、FIOCLEX/FIONCLEX。

**sys_fcntl：** 支持 F_DUPFD、F_DUPFD_CLOEXEC、F_GETFD/SETFD、F_GETFL/SETFL。

**sys_prlimit64：** 支持 RLIMIT_NOFILE 资源限制查询/设置。

**/proc 虚拟文件兼容：** 大量代码用于支持 busybox 的 /proc 查询（进程 stat、oom_score_adj、mounts、meminfo 等），在 syscall 层通过 `busybox_virtual_*` 系列函数直接在内存中构造响应。

---

### 4.8 同步原语与基础设施

#### 4.8.1 自旋锁 (`kernel/spinlock.c`, 125行)

```c
void acquire(struct spinlock *lk) {
    push_off();  // 关中断，嵌套计数
    while(__sync_lock_test_and_set(&lk->locked, 1) != 0);
    __sync_synchronize();
    lk->cpu = mycpu();
}

void release(struct spinlock *lk) {
    lk->cpu = 0;
    __sync_synchronize();
    __sync_lock_release(&lk->locked);
    pop_off();  // 恢复中断状态
}
```
使用 GCC 内置原子操作（`__sync_lock_test_and_set`/`__sync_lock_release`）实现。`push_off/pop_off` 提供嵌套的中断禁用/恢复（记录 intena 状态）。

#### 4.8.2 睡眠锁 (`kernel/sleeplock.c`, 58行)

```c
void acquiresleep(struct sleeplock *lk) {
    acquire(&lk->lk);  // 先拿自旋锁保护状态
    while (lk->locked)
        sleep_on_chan(lk, &lk->lk);  // 睡眠等待
    lk->locked = 1;
    lk->pid = myproc()->pid;
    release(&lk->lk);
}
```
基于自旋锁+睡眠/唤醒机制，适用于可能长时间持有的锁（如 inode 锁、buf 锁）。

#### 4.8.3 Futex (`kernel/futex.c`, 145行)

实现快速的用户态互斥量：
- **futex_wait(addr, thread, ts)**：在 addr 上等待，支持超时（t_TIMING 状态）
- **futex_wake(addr, n)**：唤醒最多 n 个等待者
- **futex_requeue(addr, n, newAddr)**：将等待者重新排队
- **futex_clear(thread)**：清除线程在所有 futex 上的等待
- 全局 futex_queue[FUTEX_COUNT] 管理等待关系

---

### 4.9 定时器子系统 (`kernel/timer.c`, 315行)

**核心功能：**
- **RTC 校准**：通过 Goldfish RTC (RISC-V) 或 LS7A RTC (LoongArch) 读取墙上时间，校准 CPU 时钟频率
- **boot_time 计算**：启动时从 RTC 获取并校验（范围 2000-2100 年）
- **定时器中断处理 (timer_tick)**：更新全局 ticks，刷新所有进程的 itimer，发送 SIGALRM
- **进程定时器 (refresh_process_timer)**：检查 itimer 到期并设置 SIGALRM 信号
- **gettimeofday/clock_gettime 支持**：将 CPU ticks 转换为秒+微秒/纳秒

**架构差异：**
- RISC-V：通过 SBI `set_timer()` 设置下一次中断，或直接写 `stimecmp`
- LoongArch：倒计时定时器（自动装载），通过 CSR_TCFG 配置

---

### 4.10 Socket 子系统 (`kernel/socket.c`, 88行)

提供基本的 socket 框架：
- sock_bind：绑定本地地址/端口
- sock_listen、sock_accept、sock_connect：连接管理
- sock_sendto、sock_recvfrom：数据收发
- 套接字状态机：SOCKET_UNBOUND → SOCKET_BOUND → SOCKET_LISTENING → SOCKET_CONNECTED
- 网络层为桩实现（stub），主要用于满足 LTP/busybox 兼容性需求

---

### 4.11 用户态 Initcode (`user/`)

#### RISC-V (`user/riscv/`)

**usys.S** — 系统调用跳板：
```asm
GEN_USER_SYSCALL write 64
GEN_USER_SYSCALL fork 300
...
```
通过宏 `GEN_USER_SYSCALL` 为每个系统调用生成 ecall 包装函数。

**user.c (2208行)** — 用户态测试框架：
用户态 initcode 作为第一个用户进程（PID=1），负责执行测试用例。包含：
- 内置 basic 测试（brk、chdir、close、dup、fork、mmap 等 33 个单测）
- busybox 集成测试
- libc-test 静态/动态链接测试
- LTP 测试套件（精选 musl/glibc 测试用例列表，约 80+ 个）
- lua、iozone、lmbench 等基准测试
- 测试用例调度与结果收集

#### LoongArch (`user/loongarch/`)

**usys.S** — 与 RISC-V 版本使用相同的系统调用号体系。

**user.c (1970行)** — LoongArch 版本的用户态测试框架，测试用例略有差异。

---

## 五、各子系统交互分析

### 5.1 启动流程

```
_entry (汇编)
  └─> start() / _entry LA
        └─> timer_init()
              └─> RTC 校准定时器频率
        └─> sos_start_kernel()
              ├─> chardev_init()          // UART初始化
              ├─> printfinit()            // 打印锁初始化
              ├─> thread_init()           // 线程池初始化
              ├─> proc_init()             // 进程池初始化
              ├─> pmem_init()             // Buddy分配器初始化
              ├─> vmem_init()             // 内核页表初始化
              ├─> slab_init()             // SLAB分配器初始化
              ├─> hsai_trap_init()        // 设置异常向量
              ├─> plicinit/plicinthart()  // PLIC中断控制器
              ├─> virtio_disk_init()      // VirtIO块设备
              ├─> init_fs()               // 文件系统注册
              ├─> binit()                 // buf缓存初始化
              ├─> fileinit()              // 文件表初始化
              ├─> inodeinit()             // inode缓存初始化
              ├─> vfs_ext4_init()         // EXT4挂载点初始化
              ├─> init_process()          // 创建init进程
              └─> scheduler()             // 进入调度循环
```

### 5.2 系统调用处理路径

```
用户程序 ecall
  └─> uservec (trampoline.S)
        └─> 保存寄存器到 trapframe
        └─> 切换内核页表
        └─> usertrap() (hsai_trap.c)
              └─> 判断 scause/estat
              └─> 系统调用分支:
                    └─> syscall(trapframe) (syscall.c)
                          └─> switch(a[7])
                                ├─> sys_write → vfs_ext4_write → lwext4
                                ├─> sys_fork  → allocproc → uvmcopy
                                ├─> sys_execve → exec → ELF加载
                                ├─> sys_mmap  → mmap → VMA + mappages
                                └─> ...
                    └─> 设置返回值到 trapframe
              └─> usertrapret()
                    └─> userret (trampoline.S)
                          └─> 恢复用户页表
                          └─> 恢复寄存器
                          └─> sret/ertn 返回用户态
```

### 5.3 缺页处理路径

```
硬件触发缺页异常
  └─> uservec → usertrap()
        └─> pagefault_handler(addr)
              ├─> 在进程VMA链表中查找
              ├─> Buddy分配物理页
              ├─> mappages() 建立映射
              └─> 返回重试触发指令
```

### 5.4 磁盘读写路径

```
vfs_ext4_read(file, buf, len)
  └─> lwext4: ext4_fread()
        └─> ext4_extent_find()  // Extent树查找
        └─> ext4_blockdev->bread()
              └─> blockdev_read()
                    └─> bread(dev, blkno)  // buf缓存
                          └─> bget() LRU查找/分配
                          └─> virtio_rw(b, READ)  // 物理读取
                                ├─> 构造VirtIO请求描述符
                                ├─> 通知设备
                                └─> 等待中断完成
```

---

## 六、实现完整度评估

### 6.1 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 架构适配 (HAL) | **85%** | 双架构基本完整，LoongArch 的 IOCSR 扩展中断控制器部分注释掉未实现 |
| Trap/异常处理 | **80%** | 用户态/内核态 trap 完整，缺页处理可用。信号递送框架存在但未在 trap 返回时实际调用信号处理函数 |
| 进程管理 | **75%** | fork/clone/exec/exit/wait 完整。进程组、会话、资源限制部分实现。调度器为简单轮转（无优先级） |
| 线程管理 | **70%** | 1:1 线程模型基本可用。clone_thread 在代码中调用了 `exit(0)`（疑似调试遗留），线程 TLS 设置通过 CLONE_SETTLS 标志支持 |
| 内存管理 | **85%** | Buddy+SLAB+页表+VMA 完整。缺少页面回收（无 swap）、COW（fork 时全量复制）、THP 等高级特性 |
| 文件系统 (EXT4) | **80%** | lwext4 移植较完整，extent/jbd2/htree/xattr 均有实现。缺少 ACL、加密、快照。写操作未经过完整事务保护 |
| VFS 层 | **70%** | 基本框架完整，支持 EXT4/VFAT 双文件系统。但 VFAT 层仅为基础桩实现 |
| 设备驱动 | **75%** | RISC-V VirtIO MMIO 和 LoongArch VirtIO PCI 块设备驱动可用。网络设备驱动仅有配置（启动参数中有 net 设备但无实际网络栈） |
| 系统调用 | **75%** | 119 个系统调用覆盖主要类别，但部分为桩实现（如 socket 系列无实际网络栈、信号递送未完全实现） |
| 同步原语 | **85%** | 自旋锁、睡眠锁、Futex 实现完整。缺少 RCU、读写锁、信号量等 |
| 定时器 | **80%** | RTC 校准、定时器中断、itimer 基本完整。缺少高精度定时器（hrtimer） |

### 6.2 总体完整度评估

以运行 busybox + LTP 精选测试套件为基准，S-OS 的内核核心功能完整度约为 **78%**。能够支持多进程、多线程、动态链接 ELF 加载、EXT4 文件系统读写、管道、信号、Futex 等关键 Linux 兼容特性。主要短板在于网络栈、信号递送和部分高级内存管理特性。

---

## 七、设计创新性分析

### 7.1 双指令集架构的 HAL/HSAI 分层设计

S-OS 最显著的设计特点是其 **HAL → HSAI → Kernel Core** 三层架构：

- **HAL 层**：每个架构独立维护一套汇编和 C 代码（各 7-8 个文件），实现最底层的寄存器操作、上下文切换、异常入口
- **HSAI 层**：通过条件编译和统一接口封装，向上层提供架构无关的 API（如 `hsai_swtch()`、`hsai_get_arg()`、`hsai_set_usertrap()` 等）
- **Kernel Core**：完全架构无关的纯 C 代码

这种设计使得添加新架构只需实现 HAL 层的约 8 个文件（约 500-800 行汇编 + C），而无需修改内核核心代码。相比 Linux 内核庞大的 `arch/` 目录树，这是一种更轻量但有效的多架构支持方案。

### 7.2 dmwin 直接映射窗口的利用

LoongArch 架构下，内核利用 DMW0/DMW1 直接映射窗口避免了大段内核地址空间的页表映射开销：
```c
#define dmwin_win0 (0x9UL << 60)  // 0x9000...
#define dmwin_win1 (0x8UL << 60)  // 0x8000...
```
在 walk() 函数中通过 `dmwin_win0` 将物理地址转换为可直接访问的虚拟地址，这对 RISC-V 代码也是透明的（RISC-V 下 `dmwin_win0 = 0x0`）。

### 7.3 lwext4 嵌入式 EXT4 的完整移植

将 lwext4 库完整移植到自研内核是一项工作量巨大的工程。S-OS 不仅移植了基础的文件读写，还实现了：
- Extent 树的完整操作（分裂、合并、查找）
- JBD2 日志的事务提交和恢复
- HTree 目录索引
- MBR 分区表支持
- mkfs 文件系统创建能力
- 扩展属性 (xattr)

大多数教学内核仅实现 FAT 或简化文件系统，S-OS 的 EXT4 实现在比赛项目中具有明显竞争力。

### 7.4 广泛的应用兼容性

S-OS 通过实现 119 个 Linux 兼容系统调用和 /proc 虚拟文件系统，能够直接运行未经修改的 busybox、glibc/musl 动态链接程序、LTP 测试套件、lua、iozone、lmbench 等真实世界应用。这种兼容性水平在教学内核中较为少见。

---

## 八、其它重要信息

### 8.1 代码来源与版权

- **lwext4**：`kernel/fs/` 下的大部分文件（ext4*.c）来源于 lwext4 开源项目（BSD 许可证），版权归属于 Grzegorz Kostka 等原作者
- **xv6 基础**：`kernel/spinlock.c`、`kernel/sleeplock.c`、`kernel/bio.c`、部分 `kernel/fs/file.c` 的框架借鉴了 xv6-riscv
- **自研部分**：进程/线程管理、VMA、ELF 加载器、系统调用、HAL/HSAI 层、设备驱动、用户态测试框架等为核心团队自研

### 8.2 构建系统特点

- 顶层 Makefile 通过 `export` 向子 Makefile 传递工具链变量
- 用户态 initcode 编译为二进制后通过 Python 脚本转换为 C 头文件嵌入内核
- 通过 `TEST_PROFILE` 变量控制不同测试配置（smoke/submit/probe/ltp-musl/ltp-glibc）
- 构建产物为 `kernel-la`（LoongArch）和 `kernel-rv`（RISC-V）

### 8.3 内核测试套件

- **basic**：33 个单测（进程/文件/内存/时间）
- **busybox**：集成测试
- **libc-test**：静态和动态链接的 C 库测试
- **LTP**：精选的 80+ 个 musl LTP 测试用例
- **lua/iozone/lmbench**：基准性能测试

### 8.4 已知限制

1. **单核**：`NUMCPU=1`，未实现 SMP 支持
2. **clone_thread 缺陷**：`kernel/process.c:clone_thread()` 函数中有一行 `exit(0);`，疑似未完成的调试代码
3. **非完整 JBD2 事务**：写操作可能绕过完整的事务保护
4. **无页面回收**：不支持 swap 和页面回写
5. **网络栈为桩**：socket 系统调用存在但无实际网络栈实现
6. **信号递送不完整**：信号处理函数注册了但 trap 返回路径未实际调用

---

## 九、项目总结

S-OS 是一个具有竞争力的全国大学生计算机系统能力大赛宏内核项目。其在以下方面表现突出：

1. **双架构支持**：RISC-V 64 和 LoongArch 64 两套完整的 HAL 实现，HSAI 层设计合理
2. **EXT4 文件系统**：基于 lwext4 的完整移植是最大亮点，包含 extent 树、HTree 索引、JBD2 日志等高级特性
3. **系统调用覆盖**：119 个 Linux 兼容系统调用，可运行 busybox、glibc/musl 动态链接程序
4. **内存管理**：Buddy + SLAB + 多级页表 + VMA 的完整内存管理体系
5. **ELF 加载器**：支持静态/动态链接、多架构解释器、PIE、shebang 脚本

主要待完善领域：信号递送、线程管理的代码质量、网络栈、SMP 支持。总体而言，这是一个功能较为完整、架构设计合理的学生竞赛操作系统项目。