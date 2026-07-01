# noob is not RISV-V -- OS 内核项目技术分析报告

---

## 一、项目概述

### 1.1 基本信息

| 项目属性 | 内容 |
|----------|------|
| 项目名称 | noob is not RISV-V（递归缩写） |
| 来源 | 吉利学院（GUC），OS 竞赛项目 |
| 目标架构 | RISC-V 64 位（rv64imac） |
| 开发语言 | C 语言为主，RISC-V 汇编辅助 |
| 运行平台 | QEMU virt 机器，2 CPU，128MB 内存 |
| 代码规模 | 内核约 25 个 C 源文件 + 3 个汇编文件 + 28 个头文件；SBI 固件 3 个 C 文件 + 2 个汇编文件 |
| 构建系统 | GNU Make + 交叉编译工具链（riscv64-unknown-elf-gcc） |

### 1.2 构建测试结果

**内核构建**：成功。所有 25 个 C 源文件和 3 个汇编文件均编译通过，链接生成 `kernel-qemu`（319KB ELF）。

**SBI 固件构建**：成功。生成 `sbi-qemu`（200KB 裸二进制镜像），通过自定义 `capture_elf` 工具从 ELF 提取。

**用户态程序构建**：需要先构建外部测试套件 `riscv-syscalls-testing` 的 `libulib.a`，然后编译 3 个用户程序。由于构建流程依赖 `sudo mount` 挂载 FAT 镜像写入文件，在沙箱环境中无法完整执行。

**QEMU 运行测试**：由于 `sdcard.img` 和 `initrd.img` 的制作依赖 `sudo mount`（loop 设备挂载），在沙箱环境中无法完成完整的端到端测试。尝试使用 `mcopy` 替代方案制作 FAT 镜像，但完整的 QEMU 启动流程需要所有镜像就绪，因此未进行运行时测试。

---

## 二、项目架构与子系统划分

### 2.1 整体架构

项目采用三层架构：

```
+--------------------------------------------------+
|  用户态 (U-mode)                                  |
|  initcode / test / test_syscall / oscomp tests    |
+--------------------------------------------------+
|  内核 (S-mode)                                    |
|  进程/线程管理 | VMM | PMM | FS | 驱动 | 调度器   |
+--------------------------------------------------+
|  SBI 固件 (M-mode)                                |
|  引导 | 定时器转发 | PMP 配置                      |
+--------------------------------------------------+
|  QEMU virt 硬件                                   |
|  UART | VirtIO | PLIC | CLINT                     |
+--------------------------------------------------+
```

### 2.2 子系统清单

| 子系统 | 源文件 | 完整度评估 |
|--------|--------|-----------|
| SBI 固件 | `sbi/entry.S`, `sbi/start.c`, `sbi/timer.c`, `sbi/mtvec.S` | 基本完整 |
| 引导与陷阱处理 | `strap.c`, `stvec.S`, `trampoline.S`, `csr.c` | 基本完整 |
| 物理内存管理 (PMM) | `pmm.c` | 完整（Buddy + Slab） |
| 虚拟内存管理 (VMM) | `vmm.c` | 基本完整 |
| VirtIO 块设备驱动 | `virtio_disk.c` | 完整 |
| 块 I/O 缓存 | `bio.c` | 完整 |
| FAT32 文件系统 | `fat32.c` | 较完整 |
| VFS 抽象层 | `fs.c` | 较完整 |
| 文件描述符管理 | `file.c` | 较完整 |
| 进程管理 | `process.c` | 基本完整 |
| 线程管理 | `thread.c` | 基本完整 |
| 协程调度器 | `coro.c`, `coro_switch.S` | 基本完整 |
| 系统调用分发 | `syscall.c` | 部分实现（约 20 个） |
| 文件相关系统调用 | `sysfile.c` | 部分实现 |
| ELF 加载器 | `elf.c` | 基本完整 |
| 同步机制 | `spinlock.c`, `waitqueue.c` | 基本完整 |
| UART 驱动 | `uart.c` | 基本完整（仅输出） |
| 控制台 | `console.c` | 基本完整（仅输出） |
| PLIC 中断控制器 | `plic.c` | 完整 |
| CPU 管理 | `cpu.c` | 不完整（单核硬编码） |
| 打印库 | `print.c`, `dagaslib.c` | 完整 |

---

## 三、各子系统详细分析

### 3.1 SBI 固件（M-mode）

#### 3.1.1 引导流程

SBI 固件链接地址为 `0x8000000`，是 QEMU virt 机器的默认入口。

```c
// sbi/entry.S
.section .entry
.global _entry
_entry:
    auipc sp, KMEMORY / 4096
    call start
```

入口汇编设置栈指针后跳转到 `start()` 函数。`start()` 执行以下初始化：

```c
// sbi/start.c
int start(){
    // 仅 hart 0 继续执行，其余 hart 进入死循环
    if(mhartid != 0){ while(1); }
    
    // 设置 MPP 为 S-mode
    C_CSR(mstatus, MSTATUS_MPP_MASK);
    S_CSR(mstatus, MSTATUS_MPP_S);
    
    // 设置 mepc 为内核入口 0x80200000
    W_CSR(mepc, (uint64) 0x80200000);
    
    // 禁用分页
    W_CSR(satp, 0);
    
    // 配置 PMP：允许 S-mode 访问全部物理内存
    W_CSR(pmpaddr0, PMPADDR0_S_TOR);
    W_CSR(pmpcfg0, PMPCFG_R | PMPCFG_W | PMPCFG_X | PMPCFG_A_TOR);
    
    // 委托异常和中断到 S-mode
    W_CSR(medeleg, EXC_MASK);
    W_CSR(mideleg, S_INTR_MASK);
    
    // 初始化定时器
    timer_init();
    
    // mret 跳转到 S-mode
    asm("mret");
}
```

#### 3.1.2 定时器中断转发

SBI 的 `mtvec.S` 实现了 M-mode 陷阱处理，专门处理机器模式定时器中断：

```asm
// sbi/mtvec.S
mtvec:
    csrrw a0, mscratch, a0
    sd a1, 0(a0)
    sd a2, 8(a0)
    sd a3, 16(a0)
    
    # 将下一次定时器中断时间写入 MTIMECMP
    ld a1, 24(a0)  # CLINT_MTIMECMP
    ld a2, 32(a0)  # interval (1000000 cycles)
    ld a3, 0(a1)
    add a3, a3, a2
    sd a3, 0(a1)
    
    # 触发 S-mode 软件中断
    li a1, 2
    csrw sip, a1
    
    ld a3, 16(a0)
    ld a2, 8(a0)
    ld a1, 0(a0)
    csrrw a0, mscratch, a0
    mret
```

定时器间隔为 1,000,000 个时钟周期。M-mode 定时器中断被转换为 S-mode 软件中断（SSIP），由内核的 `dev_intr()` 处理。

#### 3.1.3 评估

SBI 固件功能极简，仅提供引导和定时器转发两项服务。不支持 SBI 规范中的 console 服务（`ecall` from M-mode）、IPI 发送等标准功能。多核支持不完整（hart 1 直接进入死循环）。

---

### 3.2 内核引导与陷阱处理

#### 3.2.1 内核入口

内核链接地址为 `0x80200000`，入口函数为 `main()`。初始化顺序如下：

```c
// kernel/main.c
int main(){
    intr_off();
    uartinit();           // UART 初始化
    strap_init();         // 设置内核陷阱向量 stvec
    pmem_init();          // 物理内存管理初始化（Buddy + Slab）
    kvminit();            // 内核虚拟内存初始化（Sv39 页表）
    virtio_disk_init();   // VirtIO 块设备初始化
    block_cache_init();   // 块缓存初始化
    plic_init();          // PLIC 中断控制器初始化
    plic_init_hart();
    init_as_scheduler();  // 初始化调度器协程
    process_pool_init();  // 进程池初始化
    thread_pool_init();   // 线程池初始化
    intr_on();            // 开启中断
    filesystem_init(FS_TYPE_FAT32);  // FAT32 文件系统初始化
    install_initrd_img(); // 安装 initrd 镜像
    // ... 挂载 initrd 到 /mnt ...
    console_init();       // 控制台初始化
    // ... 创建 init 进程并加载 ELF ...
    scheduler_loop();     // 进入调度循环
}
```

#### 3.2.2 陷阱向量与处理

内核有两套陷阱入口：

**内核态陷阱**（`stvec.S`）：保存全部 32 个通用寄存器到内核栈，调用 `strap_handler()`，仅处理设备中断。

**用户态陷阱**（`trampoline.S`）：使用 `sscratch` CSR 交换 trapframe 指针，保存用户寄存器到 trapframe，切换到内核页表和内核栈，跳转到 `usertrap()`。

```asm
// kernel/trampoline.S - uservec
uservec:
    csrrw a0, sscratch, a0    # 交换 trapframe 指针
    sd ra, 40(a0)              # 保存用户寄存器到 trapframe
    sd sp, 48(a0)
    # ... 保存所有寄存器 ...
    ld sp, 8(a0)               # 加载内核栈指针
    ld tp, 32(a0)              # 加载 hartid
    ld t0, 16(a0)              # 加载 usertrap 地址
    ld t1, 0(a0)               # 加载内核页表
    csrw satp, t1              # 切换页表
    jr t0                      # 跳转到 usertrap
```

`usertrap()` 根据 `scause` 分发处理：

```c
// kernel/strap.c
void usertrap() {
    switch (scause) {
    case SCAUSE_ECALL:           // 系统调用
        resolve_ecall();
        goto return_to_user;
    case SCAUSE_LOAD_PAGE_FAULT: // 缺页异常
    case SCAUSE_STORE_AMO_PAGE_FAULT:
        if (resolve_page_fault()) goto return_to_user;
        else { sys_exit(-1); goto switch_to; }
    default:                     // 设备中断
        if((which_dev = dev_intr()) == 0) {
            resolve_unknown_trap();
            goto switch_to;
        } else {
            thread_pool[tid].state = T_READY;
            goto switch_to;
        }
    }
}
```

#### 3.2.3 返回用户态

`entry_to_user()` 函数负责从内核返回到用户态：

```c
void entry_to_user(){
    W_CSR(sepc, thread_pool[tid].trapframe->epc);
    C_CSR(sstatus, SSTATUS_SPP);  // 设置 SPP=0 (U-mode)
    W_CSR(sscratch, thread_pool[tid].trapframe);
    switch_stack_pagetable(...);   // 切换栈页表
    set_strap_uservec();           // 设置用户陷阱向量
    ((userret_t*)(TRAMPOLINE + USER_RET_OFFSET))(
        thread_pool[tid].trapframe, 
        ATP(tid, thread_pool[tid].stack_pagetable));
}
```

#### 3.2.4 评估

陷阱处理框架基本完整，支持 ecall 系统调用、缺页异常和设备中断三种用户态陷阱。但存在以下问题：
- 内核态陷阱处理（`strap_handler`）在遇到未知陷阱时进入死循环而非 panic
- `sfence.vma` 调用被注释掉，可能导致 TLB 一致性问题
- 软件中断（定时器）的处理函数体为空（`TODO: clock_intr()`），意味着时间片轮转调度未实现

---

### 3.3 物理内存管理（PMM）

#### 3.3.1 Buddy 系统

物理内存管理采用 Buddy 分配器，基于二叉树实现：

```c
// kernel/pmm.c
#define IS_POW2(x) (!((x)&((x)-1)))
#define LE_CHILD(x) ((x) << 1)
#define RI_CHILD(x) ((x) << 1 | 1)
#define PARENT(x) ((x) >> 1)

int buddy_size;
uint32 buddy_tree[KMEMORY / PG_SIZE]; // 静态数组，128MB/4KB = 32768 个节点
```

`buddy_alloc()` 从根节点向下搜索满足大小要求的空闲块，分配后向上更新父节点的最大空闲块大小。`buddy_free()` 释放后尝试与兄弟节点合并。

物理内存起始地址由链接脚本中的 `pmem_base` 符号确定（内核 BSS 段之后的第一个页对齐地址），结束地址为 `MAX_PA - KSTACK_SIZE * CPUS`。

#### 3.3.2 Slab 分配器

小对象分配使用 Slab 分配器，支持 8 种大小类别（8B 到 2KB）：

```c
// kernel/pmm.c
#define MIN_SLAB_OBJECT_SIZE 8
#define MAX_SLAB_OBJECT_SIZE PG_SIZE / 2  // 2048 bytes
#define MAX_KMEM_CACHE 9

struct kmem_cache_struct{
    int object_size;
    int object_num;
    int offset;
    slab_t* slab_list;
} kmem_cache_list[MAX_KMEM_CACHE];
```

每个 slab 占用一个物理页（4KB），头部存放 `slab_t` 元数据和空闲链表。大于 2KB 的分配直接走 Buddy 系统。

#### 3.3.3 评估

PMM 实现较为完整，Buddy + Slab 的组合是成熟的设计。但存在以下问题：
- `buddy_tree` 数组为静态分配，占用 `32768 * 4 = 128KB` 的 BSS 空间
- `palloc()` 和 `pfree()` 没有使用 `pmm_lock` 进行保护（锁已声明但未使用）
- `kfree()` 通过检查地址是否页对齐来区分 Buddy 分配和 Slab 分配，这种方式不够健壮
- 调试填充（分配填 'N'，释放填 'U'）在生产环境中应移除

---

### 3.4 虚拟内存管理（VMM）

#### 3.4.1 页表管理

采用 RISC-V Sv39 三级页表，每级 512 个 PTE，每页 4KB：

```c
// kernel/include/vmm.h
#define PTE_V 0x1  // Valid
#define PTE_R 0x2  // Read
#define PTE_W 0x4  // Write
#define PTE_X 0x8  // Execute
#define PTE_U 0x10 // User
#define PTE_A 0x40 // Accessed
#define PTE_D 0x80 // Dirty
```

`walk()` 函数遍历三级页表，支持按需分配中间页表：

```c
pte_t *walk(pagetable_t pagetable, uint64 va, int alloc) {
    for (int level = 2; level > 0; level--) {
        pte_t *pte = &pagetable[PTE_INDEX(va, level)];
        if (*pte & PTE_V) {
            pagetable = (pagetable_t)PTE2PA(*pte);
        } else if (alloc) {
            pagetable = palloc();
            memset(pagetable, 0, PG_SIZE);
            *pte = PA2PTE(pagetable) | PTE_V;
        } else return 0;
    }
    return &pagetable[PTE_INDEX(va, 0)];
}
```

#### 3.4.2 内核地址空间

`kvminit()` 建立内核页表，映射以下区域：

| 虚拟地址范围 | 物理地址 | 权限 | 用途 |
|-------------|---------|------|------|
| `0x10001000` | `0x10001000` | RW | VirtIO MMIO |
| `0x10000000` | `0x10000000` | RW | UART0 |
| `0x0c000000` | `0x0c000000` | RW | PLIC (4MB) |
| `0x80000000` | `0x80000000` | RWX | 内核代码+数据 |
| `PMEM0` | `PMEM0` | RW | 物理内存池 |
| `TRAMPOLINE` | trampoline | RX | 跳板页 |
| `HEAP_SPACE` | 动态分配 | RW | 内核堆 |

内核页表使用 ASID=MAX_THREAD(256)，用户页表使用 ASID=tid。

#### 3.4.3 用户地址空间与 VM 区域管理

每个进程维护一个 `vm_t` 链表，记录所有虚拟内存区域：

```c
struct vm_struct {
    pagetable_t pagetable;
    uint64 va;
    uint64 size;
    int type;       // VM_PA_SHARED, VM_LAZY_ALLOC, VM_THREAD_STACK, VM_NO_FORK, VM_NO_ALLOC, VM_GLOBAL
    uint64 perm;
    pm_t* pm;       // 关联的物理内存
    vm_t* next;
};
```

支持的 VM 类型标志：
- `VM_PA_SHARED`：共享物理页（如 trampoline、fork 时的 COW 前身）
- `VM_LAZY_ALLOC`：延迟分配（用户栈）
- `VM_THREAD_STACK`：线程栈
- `VM_NO_FORK`：fork 时不复制
- `VM_NO_ALLOC`：不自动分配物理页（堆区域）
- `VM_GLOBAL`：全局映射

#### 3.4.4 缺页异常处理

```c
int resolve_page_fault(){
    vm_t* vm = vm_lookup(thread->stack_vm, stval);
    if(vm == NULL) return 0;
    if(vm->type & VM_LAZY_ALLOC){
        vm_insert_pm(vm, alloc_pm(PG_FLOOR(stval - vm->va), 0, PG_SIZE));
        return 1;
    }
    return 0;
}
```

仅支持用户栈的延迟分配缺页处理。其他类型的缺页直接终止进程。

#### 3.4.5 堆管理

内核和用户空间各有独立的堆管理器，基于链表实现：

```c
void heap_init(pagetable_t pagetable, int user){
    brk_t* brk_first = (brk_t*) va2pa(pagetable, HEAP_SPACE);
    brk_first->next = NULL;
    brk_first->size = PG_SIZE - sizeof(brk_t);
    brk_first->used = 0;
}
```

`vmalloc_r()` 在堆区域分配内存，支持按需扩展（映射新物理页）。`vfree_r()` 释放内存并尝试合并相邻空闲块。

#### 3.4.6 评估

VMM 实现较为完整，支持内核/用户页表分离、VM 区域管理和缺页异常。但存在以下问题：
- `sfence.vma` 调用被大量注释掉，依赖 ASID 机制但实现可能不正确
- 每个线程有独立的 `stack_pagetable`，通过 `switch_stack_pagetable()` 复制除栈区域外的所有 PTE，这是一种非标准的设计
- 堆管理器没有锁保护
- `walk_and_free()` 会释放所有子页表，但不区分物理页是否需要释放

---

### 3.5 进程与线程管理

#### 3.5.1 进程/线程分离设计

项目采用了进程和线程分离的设计，这在 OS 竞赛项目中较为少见：

```c
// kernel/include/process.h
struct process_struct{
    spinlock_t lock;
    enum PROCESS_STATE state;  // UNUSED, USED, ZOMBIE
    int64 pid;
    wait_queue_t *wait_child, *wait_self;
    int exit_id;
    vm_t* vm_list;             // 虚拟内存区域链表
    vm_t* arg_vm;              // 参数页
    vm_t* heap_vm;             // 堆区域
    pagetable_t pagetable;     // 进程页表（共享）
    process_t* parent;
    process_t* child_list;     // 子进程链表
    process_t **prev, *next;
    int thread_count;
    file_t *open_files[MAX_FD]; // 文件描述符表（256个）
    inode_t *cwd;              // 当前工作目录
};

// kernel/include/thread.h
struct thread_struct{
    thread_t* next;
    spinlock_t lock;
    wait_queue_t* waiting;
    enum THREAD_STATE state;   // UNUSED, PREPARING, RUNNING, READY, SLEEPING
    trapframe_t* trapframe;
    vm_t* stack_vm;            // 线程栈 VM 区域
    pagetable_t stack_pagetable; // 线程独立栈页表
    process_t* process;        // 所属进程
    uint64 tid;
};
```

进程池和线程池均为静态数组（各 256 个），通过空闲链表管理分配/释放。

#### 3.5.2 fork 实现

```c
int sys_fork(){
    thread_t* thread_new = alloc_thread();
    init_thread(thread_new);
    process_t* process_new = fork_process(thread->process);
    attach_to_process(thread_new, process_new);
    init_thread_manager_coro(thread_new->tid);
    clone_thread(thread, thread_new);
    thread_new->trapframe->epc += 4;  // 跳过 ecall 指令
    thread_new->trapframe->a0 = 0;    // 子进程返回 0
    release_spinlock(&thread_new->lock);
    return process_new->pid;
}
```

`fork_process()` 复制 VM 区域链表，共享物理内存（`VM_PA_SHARED`），但不实现写时复制（COW）。`clone_thread()` 复制 trapframe 并共享栈的物理内存。

#### 3.5.3 exec 实现

```c
int sys_exec(char* path){
    char* buf = kmalloc(MAX_PATH);
    copy_to_pa(buf, (uint64)path, MAX_PATH, 1);
    thread_t* thread = thread_pool + get_tid();
    reset_stack(thread);           // 释放旧栈
    exec_process(thread->process, buf); // 清除 VM 列表并重新加载 ELF
    entry_main(thread);            // 重新初始化入口
    thread->trapframe->epc -= 4;
    set_arg(thread->process, 1, &buf);
    kfree(buf);
    return 0;
}
```

#### 3.5.4 进程退出与等待

```c
void release_process(process_t* process){
    vm_list_free(process, 1);
    if(process->parent != NULL)
        awake_wait_queue(process->parent->wait_child, process->pid);
    awake_wait_queue(process->wait_self, process->pid);
    free_wait_queue(process->wait_child);
    free_wait_queue(process->wait_self);
    free_user_pagetable(process->pagetable);
    // 处理孤儿进程...
    if(process->parent == NULL) release_zombie(process);
    else process->state = ZOMBIE;
}
```

`sys_wait()` 使用等待队列实现阻塞等待子进程退出。

#### 3.5.5 评估

进程/线程分离的设计是有意义的尝试，但实现中存在多处问题：
- fork 不实现 COW，直接共享物理页，父子进程写同一内存
- `sys_fork()` 中 `epc += 4` 跳过 ecall 是正确的，但 `sys_exec()` 中 `epc -= 4` 的原因不明确
- 进程退出时释放 VM 列表的深度为 1，可能遗漏嵌套资源
- `get_current_proc()` 通过 `get_tid()` 间接获取进程，假设线程与进程一一对应

---

### 3.6 协程调度器

#### 3.6.1 设计思路

调度器采用协程（coroutine）实现上下文切换，每个线程对应一个管理协程：

```c
// kernel/include/coro.h
typedef struct env_struct {
    uint64 ra;   // 返回地址
    uint64 sp;   // 栈指针
    uint64 s[12]; // s0-s11 保存寄存器
} env_t;

typedef struct coro_struct{
    env_t env;
    uint64 coro_stack_bottom;
    uint64 coro_stack_size;
} coro_t;
```

上下文切换通过 `coro_setjmp`/`coro_longjmp` 实现（类似 `setjmp`/`longjmp`）：

```asm
// kernel/coro_switch.S
coro_setjmp:
    sd ra, 0(a0)
    sd sp, 8(a0)
    sd s0, 16(a0)
    # ... 保存 s0-s11 ...
    li a0, 0
    ret

coro_longjmp:
    ld ra, 0(a0)
    ld sp, 8(a0)
    # ... 恢复 s0-s11 ...
    addi a0, a1, 0
    ret
```

#### 3.6.2 调度循环

```c
void scheduler_loop(){
    while (1) {
        for (int i = 0; i < MAX_THREAD; i++){
            if (try_acquire_spinlock(&thread_pool[i].lock) != 0){
                if(thread_pool[i].state == T_READY){
                    thread_pool[i].state = T_RUNNING;
                    switch_coro(&thread_manager_coro[i]);
                } else release_spinlock(&thread_pool[i].lock);
            }
        }
    }
}
```

调度器遍历所有线程，找到 READY 状态的线程并切换到其管理协程。管理协程的入口为 `entry_to_user()`，直接返回用户态执行。

#### 3.6.3 调度触发点

- 设备中断发生时，当前线程状态设为 `T_READY`，调用 `sched()` 切换回调度器
- 系统调用 `sys_exit()` 调用 `sched()`
- 系统调用 `sys_wait()` 中线程进入 `T_SLEEPING` 状态后调用 `sched()`
- 未知陷阱导致进程终止时调用 `sched()`

#### 3.6.4 评估

协程调度器的设计是本项目的一个创新点，但存在明显局限：
- 调度策略为简单的轮询（round-robin 的退化版），没有优先级、时间片等机制
- 定时器中断处理函数为空（`TODO: clock_intr()`），无法实现抢占式调度
- 多核支持不完整：`get_cpu_id()` 硬编码返回 0，`cpu` 为全局单例
- 每个线程的管理协程栈仅 1 页（4KB），位于内核地址空间的 `CORO_SPACE` 区域

---

### 3.7 文件系统

#### 3.7.1 VFS 抽象层

VFS 层定义了 superblock、inode、file 三层抽象：

```c
// kernel/include/fs.h
struct superblock_struct {
    superblock_t *parent;
    uint32 identifier;
    uint32 block_size;
    uint32 fs_type;
    union { uint32 id_in_parent; uint32 real_dev; };
    int root_id;
    void *extra;
    // 操作函数指针
    int (*lookup_inode)(inode_t *dir, char *filename, inode_t *node);
    int (*read_inode)(inode_t *node, int offset, int size, void *buffer);
    int (*write_inode)(inode_t *node, int offset, int size, int cover, void *buffer);
    void (*update_inode)(inode_t *node);
    int (*create_inode)(inode_t *dir, char *filename, uint8 type, uint8 major, inode_t *inode);
    int (*get_dirent)(inode_t *node, int size, dirent_t *dirent);
    // ...
};
```

inode 缓存采用静态数组（128 个），通过双向链表管理 LRU 顺序。

#### 3.7.2 FAT32 实现

FAT32 实现较为完整，支持：

- **BPB 解析**：解析 BIOS Parameter Block，提取扇区大小、簇大小、FAT 表位置等
- **FAT 链遍历**：通过 `get_next_cid()` 遍历簇链
- **目录项解析**：支持 SFN（8.3 短文件名）和 LFN（长文件名）
- **文件读写**：`fat32_read_inode()` 和 `fat32_write_inode()` 支持跨簇读写
- **文件创建**：`fat32_create_inode()` 支持创建文件和目录
- **目录创建**：创建 `.` 和 `..` 条目
- **FAT 表更新**：`set_fat()` 和 `fresh_fat()` 更新 FAT 表并写回磁盘
- **簇分配**：`get_free_cluster()` 和 `add_cluster()` 分配新簇

```c
// kernel/fat32.c - FAT32 初始化
int fat32_superblock_init(inode_t *node, superblock_t *parent, superblock_t *sb, uint32 identifier){
    // 读取 BPB
    struct buf *b = read_block(parent, 0);
    // 解析 BPB 字段
    fat32_info->bytes_per_sector = ...;
    fat32_info->sectors_per_cluster = ...;
    fat32_info->reserved_sectors = ...;
    fat32_info->fat_cnt = ...;
    fat32_info->sectors_per_fat = ...;
    fat32_info->root_cid = ...;
    // 读取 FAT 表到内存
    fat32_info->fat = kmalloc(fat32_info->fat_blocks * BSIZE);
    // 设置操作函数指针
    sb->lookup_inode = fat32_lookup_inode;
    sb->read_inode = fat32_read_inode;
    sb->write_inode = fat32_write_inode;
    sb->create_inode = fat32_create_inode;
    // ...
}
```

#### 3.7.3 挂载机制

支持文件系统挂载，通过 inode 的 `is_mnt`、`mnt_sb`、`mnt_root_id` 字段实现：

```c
int mount_inode(inode_t *dir, superblock_t *sb) {
    dir->mnt_sb = sb;
    dir->mnt_root_id = sb->root_id;
    dir->is_mnt = 1;
    return 1;
}
```

`lookup_inode()` 在查找时检查 `is_mnt` 标志，自动切换到挂载的文件系统。

#### 3.7.4 initrd 镜像处理

内核启动时将 initrd 镜像（位于物理地址 `0x84200000`）写入根文件系统的 `initrd.img` 文件，然后挂载到 `/initrd_mnt`：

```c
void install_initrd_img(){
    inode_t* inode = create_inode(get_root(), "initrd.img", 0, T_FILE);
    write_inode(inode, 0, INITRDIMG_SIZE, 1, (void*) INITRDIMG0);
    file_mkdirat(get_root(),"initrd_mnt",0);
    inode_t* mnt_inode = lookup_inode(get_root(),"initrd_mnt");
    superblock_t *sb = alloc_superblock();
    fat32_superblock_init(initrd, initrd->sb, sb, get_new_sb_identifier());
    mount_inode(mnt_inode, sb);
}
```

#### 3.7.5 评估

FAT32 实现是本项目中较为完整的子系统之一。但存在以下问题：
- FAT 表整体读入内存，对于大磁盘会消耗大量内存
- `MAX_CLUSTER_SIZE` 限制为 4KB（512*8），不支持更大的簇
- LFN 到 ASCII 的转换丢失了非 ASCII 字符
- 没有实现文件删除（`unlink`）和 FAT 链释放
- 写操作的 `cover` 参数语义不清晰

---

### 3.8 块 I/O 缓存

#### 3.8.1 实现

块缓存采用 LRU 策略，缓存大小为 `MAXOPBLOCKS * 3 = 30` 个块：

```c
// kernel/bio.c
struct {
    spinlock_t lock;
    struct buf buf[NBUF];
    struct buf head;  // LRU 链表头
} block_cache;
```

`get_block()` 首先查找缓存，未命中时回收 LRU 末尾的干净块。脏块在回收前自动刷写。

提供了字节级读写接口 `read_bytes_to_buffer()` 和 `write_bytes_to_disk()`，支持跨块读写。

#### 3.8.2 评估

实现基本完整，但缓存大小仅 30 个块（15KB），对于 FAT32 操作可能不够。`write_block()` 仅标记脏位，不立即写回，依赖 `flush_cache_to_disk()` 或 LRU 回收时刷写。

---

### 3.9 VirtIO 块设备驱动

#### 3.9.1 实现

驱动使用 VirtIO MMIO legacy 接口（版本 1），初始化流程：

1. 验证 Magic Value、Version、Device ID、Vendor ID
2. 协商特性（禁用 SCSI、多队列等）
3. 设置队列大小（8 个描述符）
4. 分配描述符表、可用环、已用环

I/O 操作使用三描述符链：请求头 + 数据 + 状态。

```c
void virtio_disk_rw(struct buf *b, int write) {
    // 分配 3 个描述符
    alloc3_desc(idx);
    // 设置请求头
    buf0->type = write ? VIRTIO_BLK_T_OUT : VIRTIO_BLK_T_IN;
    buf0->sector = b->block_id * (BSIZE / 512);
    // 设置描述符链
    disk.desc[idx[0]] = {addr: buf0, len: sizeof(req), flags: NEXT, next: idx[1]};
    disk.desc[idx[1]] = {addr: b->data, len: BSIZE, flags: NEXT|WRITE, next: idx[2]};
    disk.desc[idx[2]] = {addr: &status, len: 1, flags: WRITE, next: 0};
    // 提交到可用环
    disk.avail->ring[disk.avail->idx % NUM] = idx[0];
    *R(VIRTIO_MMIO_QUEUE_NOTIFY) = 0;
    // 等待完成（忙等待）
    while(b->disk == 1) ;
}
```

#### 3.9.2 评估

驱动使用忙等待（`while(b->disk == 1)`）而非中断等待，这意味着磁盘 I/O 是同步阻塞的。中断处理函数 `virtio_disk_intr()` 已实现但未被有效利用（因为忙等待在