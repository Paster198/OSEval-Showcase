# FrostVista OS（霜见内核）技术深度分析报告

## 1. 分析范围与方法

本报告基于对 FrostVista OS 仓库源代码的完整审查，涵盖所有 132 个源文件（17544 行代码，含 .c/.h/.S）。分析方法包括：

- **静态代码审查**：逐文件阅读所有内核子系统实现
- **构建验证**：使用 `riscv64-unknown-elf-gcc` (GCC 13.2.0) 成功编译内核 ELF 文件
- **架构分析**：拆解内存布局、启动流程、中断路径、系统调用分发等关键路径

未进行 QEMU 运行时测试，原因是 `all` 目标默认配置为 EXT4 根文件系统（需要外部 `sdcard-rv.img`），该镜像文件在仓库中不存在。但源代码层面的完整审查已能覆盖所有实现细节。

---

## 2. 项目概览

FrostVista OS 是一个面向 **RISC-V 64 (Sv39)** 的紧凑型教学/实验内核。其设计风格深受 xv6 影响，但在文件系统、内存管理和用户态 ABI 方面进行了大量自主扩展。当前版本号 **0.6**（v1.0 表示交互式 Shell 可用，v1.1 表示 VMA/mmap 里程碑达成）。

### 2.1 核心特征

| 维度 | 描述 |
|------|------|
| **架构** | RISC-V 64-bit，Sv39 三级分页，rv64imac_zicsr_zifencei |
| **启动方式** | M-mode 裸机直接启动（bare）和 OpenSBI 代理启动（opensbi）双模式 |
| **地址模型** | High-half kernel（内核虚拟地址基址 `0xFFFFFFC0_80000000`）|
| **内存模型** | 128MB DRAM（`0x80000000` - `0x88000000`）|
| **多核支持** | SMP 框架（NCPU=16），但当前调度器主要处理单核 |
| **许可证** | 未在 README 中明确声明，仓库包含 LICENSE 文件 |

---

## 3. 子系统详细拆解

### 3.1 启动引导子系统

**文件**：`arch/riscv/boot/start.S`, `mstart.c`, `smode.c`

#### 3.1.1 入口点

启动入口定义在 `start.S` 的 `_start` 标签：
```asm
_start:
    la sp, _stack_top         # 设置16KB内核栈
    # 清零 .bss 段
    la t0, _bss_start
    la t1, _bss_end
1:  bgeu t0, t1, 2f
    sd zero, 0(t0)
    addi t0, t0, 8
    j 1b
2:
#ifdef OPEN_SBI_BOOT
    mv tp, a0                  # OpenSBI 传递 hartid
    call s_mode_start          # 直接进入 S-mode
#else
    call mstart                # 从 M-mode 开始
#endif
```

两种启动路径的区别：
- **bare 模式**：从 M-mode 开始，`mstart()` 配置 PMP、代理中断/异常给 S-mode，然后通过 `mret` 切换到 S-mode
- **opensbi 模式**：OpenSBI 固件已完成 M-mode 初始化，内核直接从 S-mode 启动

#### 3.1.2 M-mode 初始化 (`mstart.c`)

```c
void mstart(void) {
    w_pmpaddr0(~0ULL);           // 配置 PMP：允许访问全部物理地址
    w_pmpcfg0(0x0f);             // A=1(TOR), X=1, W=1, R=1
    w_satp(0);                   // 禁用分页
    sfence_vma();
    
    // 设置 M-mode trap 处理入口
    w_mtvec((uint64) m_trap_handler);
    
    // 设置 MPP=S，使 mret 切换到 S-mode
    x = r_mstatus();
    x &= ~MSTATUS_MPP_MASK;
    x |= MSTATUS_MPP_S;
    w_mstatus(x);
    
    // 代理中断和异常给 S-mode
    w_mideleg((1 << 5) | (1 << 9));     // STI(5) + SEI(9)
    w_medeleg((1 << 1) | (1 << 2) | (1 << 3) | (1 << 8) | (1 << 12) | (1 << 13) | (1 << 15));
    
    w_mepc((uint64) s_mode_start);
    asm volatile("mret");        // 跳转到 S-mode
}
```

M-mode trap handler（`mtrap.c`）仅处理两类事件：
- **MTI 中断**（`mcause==7`）：CLINT 定时器触发，设置 STIP 位通知 S-mode
- **S-mode ecall**（`mcause==9`）：转发 SBI 调用（`set_timer`），在 M-mode 直接操作 CLINT 寄存器

#### 3.1.3 S-mode 初始化 (`smode.c`)

```c
void s_mode_start() {
    trapinit();          // 设置 stvec = kernelvec
    pre_uart_init();     // 早期 UART 输出
    uart_init();         // 正式初始化 NS16550
    kvminit();           // 创建内核页表（恒等映射 + 高半映射）
    kvminithart();       // 启用 Sv39 分页（写 satp）
    plic_init_uart();    // PLIC 中断控制器初始化
    display_banner();    // 打印启动横幅
    timerinit();         // 启用时钟中断（SIE_STIE）
    
    early_mode = 0;      // 退出早期模式，切换到高地址虚拟地址访问
    
    // 跳转到高地址执行
    uint64 target = (uint64) high_mode_start + KERNEL_VIRT_OFFSET;
    switch_to_high_address(target, KERNEL_VIRT_OFFSET);
}
```

`switch_to_high_address` 是一个巧妙的汇编序列：
```asm
sfence.vma
add sp, sp, %1        # SP 加上虚拟偏移量
jr %0                 # 跳转到高地址
```

这是从低地址恒等映射平滑过渡到高半核的关键步骤。

#### 3.1.4 完整初始化 (`high_mode_start`)

```c
void high_mode_start() {
    trapinit();              // 重新设置 stvec（现在使用高地址）
    kalloc_init();           // 初始化物理页分配器
    clear_low_memory_mappings(); // 清除低地址恒等映射
    procinit();              // 进程表初始化
    vfs_init();              // VFS 初始化
    virtio_disk_init();      // VirtIO 块设备
    binit();                 // 块缓存初始化
    icache_init();           // inode 缓存初始化
    user_init();             // 创建第一个用户进程（/init）
    scheduler();             // 进入调度循环
}
```

---

### 3.2 内存管理子系统

#### 3.2.1 物理内存分配器 (`kernel/mm/kalloc.c`)

基于**空闲链表**的简单分配器：

```c
struct IdleMM {
    struct IdleMM *next;
};

struct freeMemory {
    struct IdleMM *freelist;
    int size;
};
```

- `kalloc_init()`：初始化时将 `_kernel_end` 到 `PHYSTOP_HIGH`（128MB 高地址）的所有物理页加入空闲链表
- `kalloc()`：从链表头部取一页，返回高地址虚拟地址（`PA2VA` 转换后的）
- `kfree(void *va)`：验证地址合法性（必须在高地址范围内、页对齐、且在 `_kernel_end` 和 `PHYSTOP_HIGH` 之间），清零后放回链表
- `ekalloc()`：早期内存分配器，在内核页表建立之前使用，直接从 `_kernel_end` 线性分配物理页并返回物理地址

关键设计：所有 kalloc/kfree 操作都在高地址（`>= 0xFFFFFFC0_00000000`）上进行，内核访问物理内存均需经过 `VA2PA`/`PA2VA` 转换。

#### 3.2.2 虚拟内存管理 (`arch/riscv/mm/vm.c`)

**页表结构**：标准 RISC-V Sv39 三级页表（9-bit VPN × 3 levels + 12-bit offset）

核心函数：

- **`walk(pagetable, va, alloc)`**：递归遍历页表，如果 `alloc=1` 且中间页表缺失则分配新页。这是所有页表操作的基础。注意 `early_mode` 标志：早期模式下 PTE 中的地址直接作为物理地址使用，分页开启后需要 `PA2VA` 转换。

```c
pte_t *walk(pagetable_t pagetable, uint64 va, int alloc) {
    for (int i = 3 - 1; i > 0; i--) {
        pte_t *pte = &pagetable[VPN_GET(va, i)];
        if (*pte & PTE_V) {
            uint64 pa = PTE2PA(*pte);
            pagetable = early_mode ? (pagetable_t)pa : (pagetable_t)PA2VA(pa);
        } else {
            if (!alloc || (pagetable = (pte_t *)pt_alloc_page_pa()) == 0)
                return 0;
            memset(pagetable, 0, PGSIZE);
            *pte = PA2PTE(early_mode ? pagetable : VA2PA(pagetable)) | PTE_V;
        }
    }
    return &pagetable[VPN_GET(va, 0)];
}
```

- **`mappages(pagetable, va, pa, size, perm)`**：将物理地址范围映射到虚拟地址。PA 必须是真实物理地址（非高地址）。
- **`kvmmap`**：`mappages` 的简单封装。
- **`kvmunmap(pagetable, va, size, do_free_pa)`**：解除映射，可选释放物理页。
- **`uvmalloc`**：分配物理页并映射到用户页表，设置 `PTE_U` 标志。
- **`uvmdealloc`**：回收用户内存区域。
- **`uvmcopy(old, new)`**：逐页复制用户地址空间（fork 使用）。遍历所有用户页表条目，为每个有效映射分配新物理页并复制内容。**支持 COW（写时复制）**：当检测到 PTE_COW 标志时，共享物理页而非复制，并将父子页表条目标记为只读。
- **`uvmfree(pagetable, p)`**：完全释放用户地址空间，包括堆和栈区域。
- **`uvmcreate()`**：创建新用户页表，将内核高半映射（索引 256-511）从内核页表复制过来。

**copyin/copyout**：用户-内核数据交换的核心。`copyin` 从用户虚拟地址读取到内核缓冲区，`copyout` 反之。通过 `walk_addr` 将用户 VA 解析为物理地址，然后直接访问内核高地址映射进行 `memmove`。关键安全特性：验证 PTE 权限（`PTE_W|PTE_U` 用于 copyout，`PTE_U` 用于 copyin）。

#### 3.2.3 内核地址空间布局

来自 `linker.ld` 和 `machine.h`：

```
物理地址:
  0x80000000 - 0x88000000  : DRAM (128MB)
  
虚拟地址 (高半核):
  0xFFFFFFC0_80000000 - 0xFFFFFFC0_88000000 : 内核映射
  
内核内部:
  .text / .rodata   (只读+执行)
  _divide 边界
  .data / .bss       (读写)
  _stack_bottom - _stack_top (16KB 内核栈)
  _kernel_end        (内核结束，之后为可用内存)
```

内核页表同时创建低地址恒等映射和高地址映射。启动完成后通过 `clear_low_memory_mappings()` 清除低地址映射（`kernel_table[0..2]=0`），仅保留高地址。

#### 3.2.4 mmap/VMA 子系统 (`kernel/mm/mmap.c`)

v1.1 新增的 mmap 支持，实现了惰性分配：

- **`do_mmap(addr, len, prot, flags, fd, offset)`**：创建 VMA
  - 仅支持 `MAP_PRIVATE` 类型
  - 支持 `MAP_ANONYMOUS`（匿名映射）和私有只读文件映射
  - 拒绝 `MAP_FIXED`（addr 必须为 0）
  - 拒绝可写文件映射
  - VMA 起始地址从 `MMAP_START`（64MB）开始线性搜索空闲区间
  - **惰性分配**：不立即分配物理页，仅记录 VMA 元数据

- **`do_munmap(addr, len)`**：解除映射
  - 支持完整 VMA 释放
  - 支持头部/尾部裁剪
  - 暂不支持中间分裂（一个 VMA 分裂为两个）

- **`find_free_range(len)`**：在 VMA 表中寻找不与已有 VMA 重叠的空闲区间，向上增长直到 `stack_bottom`

- **VMA fault 处理**：
  - `handle_vma_fault(va)`：在页面错误时调用，查找覆盖此地址的 VMA
  - `handle_anonymous_vma_fault(vma, va)`：分配并映射匿名页
  - `handle_file_vma_fault(vma, va)`：从文件读取一页并映射

**写时复制 (COW)**：
- PTE_COW 标志位定义在 `PTE_COW (1 << 8)`（RISC-V 保留位）
- `is_cow_fault(pagetable, va)`：检测页面是否标记为 COW
- `handle_cow_fault(pagetable, va)`：分配新物理页，复制内容，清除 COW 标志，重新映射为读写

COW 在 `uvmcopy`（fork）中使用：父进程的所有可写页面在子进程中标记为 COW，父子页面均设置为只读。

#### 3.2.5 页面错误处理

在 `usertrap()` 中处理两类页面错误（`scause==13` 加载页错误，`scause==15` 存储/AMO 页错误）：

```c
if (cause == 13 || cause == 15) {
    uint64 tval = r_stval();
    if (tval != 0 && current_proc->heap_top > tval 
        && current_proc->heap_bottom <= tval) {
        // 堆区惰性分配
        handle_page_fault(current_proc->pagetable, tval);
    } else if (tval > current_proc->heap_top 
               && tval < current_proc->stack_bottom) {
        // mmap VMA 惰性分配
        handle_vma_fault(tval);
    } else {
        // 非法访问，进程变为 ZOMBIE
        current_proc->state = ZOMBIE;
    }
}
```

`handle_page_fault` 简单分配一页并映射为 `PTE_V|PTE_R|PTE_W|PTE_U`。用于 brk 堆区的惰性增长。

---

### 3.3 进程管理子系统

**文件**：`kernel/core/proc.c`，`kernel/core/exec.c`

#### 3.3.1 进程结构

```c
struct Process {
    enum proc_state state;         // UNUSED, USED, RUNNABLE, RUNNING, SLEEPING, ZOMBIE
    struct spinlock lock;
    void *chan;                    // sleep/wakeup 通道
    int pid;
    char name[16];
    struct file *ofile[NOFILE];    // 文件描述符表 (NOFILE=128)
    char cwd[PATH_MAX];            // 当前工作目录 (PATH_MAX=128)
    int exit_code;
    uint64 kstack;                 // 内核栈（4KB）
    struct Process *parent;
    pagetable_t pagetable;
    struct context *context;       // 内核上下文（调度用）
    struct trapframe *trapframe;   // 用户态陷阱帧
    uint64 size;
    uint64 heap_bottom, heap_top;  // 堆区间
    uint64 stack_bottom, stack_top;// 栈区间
    struct vm_area_struct vm_area[NVMA]; // NVMA=16
};
```

进程数量上限 `NPROC=64`。

#### 3.3.2 进程生命周期

**`alloc_process()`**：
- 在 proc 数组中查找 UNUSED 槽位
- 分配内核栈（`kalloc()`，4KB）
- 创建用户页表（`uvmcreate()`）
- 在栈顶下方放置 trapframe（`kstack + PGSIZE - sizeof(trapframe)`）
- 分配 context 结构，设置 `context->ra = usertrapret`
- 设置 `context->sp` 指向 trapframe 下方

**`user_init()`**：创建第一个用户进程
- 硬编码一段 RISC-V 机器码作为 `/init` 程序的 bootstrap：
  ```c
  uint8 user_code[] = {
      0x17, 0x05, 0x00, 0x00, ... // auipc a0, 0x0
      // ... ecall exec("/init") ...
      0x2f, 0x69, 0x6e, 0x69, 0x74, 0x00 // "/init\0"
  };
  ```
- 映射到用户地址空间 0x0
- 打开 `/dev/tty` 作为 stdin/stdout/stderr
- 设置进程状态为 RUNNABLE

**`fork()`**：
- 调用 `alloc_process()` 创建子进程
- 通过 `uvmcopy()` 复制地址空间（带 COW 支持）
- 复制 trapframe、文件描述符表（`filedup` 增加引用计数）
- 复制 VMA 元数据
- 设置 `trapframe->a0 = 0`（子进程返回 0）

**`execve_kernel(path, argv, argc)`**：
- 解析 ELF 头，验证魔数 `0x464C457F`
- 创建新用户页表
- 遍历 ELF Program Headers，加载各 LOAD 段
- 支持嵌入式 `/init`（`HAVE_EMBEDDED_INIT`）：直接从编译时嵌入的 `init_code` 数组读取
- 构建 Linux 风格的初始用户栈：
  ```
  [高位地址]
    AT_NULL=0, 0
    AT_EXECFN, argv[0]指针
    AT_RANDOM, 16字节随机数
    AT_SECURE=0
    AT_EGID=0, AT_GID=0, AT_EUID=0, AT_UID=0
    AT_ENTRY, eh.entry
    AT_PAGESZ, 4096
    AT_PHNUM, AT_PHENT, AT_PHDR
    envp[0]=0  (空环境变量)
    argv[argc]=0
    argv[0..argc-1]
    argc
  [sp->低位地址]
  ```
- 包含保护页（`uvmalloc` 映射权限为 0 的页面）
- 分配 2 页用户栈（`EXEC_STACK_PAGES=2`）
- 切换到新地址空间后释放旧的

**`exit(exit_code)`**：
- 关闭所有打开的文件描述符
- 将子进程的父进程重新指定给 init 进程（`proc[0]`）
- 唤醒父进程
- 状态变为 ZOMBIE
- 清理所有 VMA 映射
- 调用 `sched()` 让出 CPU

**`wait4(pid, wstatus, options)`**：
- 支持 `pid=-1`（等待任意子进程）或指定 pid
- 支持 `WNOHANG` 选项
- 通过 `sleep(cur, &cur->lock)` 阻塞等待
- 子进程退出时通过 `wakeup` 唤醒父进程
- 返回前调用 `freeproc` 清理子进程

**`brk(addr)`**：
- 堆区间限制在 `[heap_bottom, stack_bottom)`
- 支持扩展和收缩（`uvmdealloc`）
- 返回 0 时返回当前堆顶

#### 3.3.3 调度器

```c
void scheduler(void) {
    for (;;) {
        intr_on();
        int found = 0;
        for (p = proc; p < &proc[NPROC]; p++) {
            acquire(&p->lock);
            if (p->state == RUNNABLE) {
                p->state = RUNNING;
                found = 1;
                // 设置 CPU 状态
                c->proc = myproc;
                w_sscratch(p->kstack + PGSIZE);
                w_satp(MAKE_SATP(VA2PA(p->pagetable)));
                sfence_vma();
                swtch(&c->context, p->context);
                // 从 swtch 返回后恢复内核页表
                c->proc = 0;
                w_satp(MAKE_SATP(VA2PA(kernel_table)));
                sfence_vma();
            }
            release(&p->lock);
        }
        if (!found) {
            __asm__ volatile("wfi");  // 无就绪进程时休眠
        }
    }
}
```

调度算法为简单的**轮转调度**：遍历进程表，选择第一个 RUNNABLE 进程。没有优先级或时间片概念。`yield()` 可由时钟中断触发。

**上下文切换** (`swtch.S`)：保存/恢复 callee-saved 寄存器（ra, sp, s0-s11），通过 `ret` 跳转到目标进程的 `context->ra`。

---

### 3.4 同步原语

#### 3.4.1 自旋锁 (`kernel/core/spinlock.c`)

```c
struct spinlock {
    int locked;
    struct cpu *cpu;    // 持有锁的 CPU
    char *name;
};
```

- `acquire(lk)`：先 `push_off()` 禁用中断，然后 `__sync_lock_test_and_set` 原子获取锁，最后 `__sync_synchronize` 内存屏障
- `release(lk)`：`__sync_synchronize` + `__sync_lock_release`，然后 `pop_off()`
- `push_off/pop_off`：管理嵌套中断禁用/恢复，记录第一层的中断状态

#### 3.4.2 睡眠锁 (`kernel/core/sleeplock.c`)

```c
struct sleeplock {
    int locked;
    struct spinlock lock;    // 保护 sleeplock 内部状态
    char *name;
    int pid;                 // 持有锁的进程
};
```

- `acquiresleep(lk)`：自旋等待 `lk->lock`，检查 `lk->locked`，若已被持有则 `sleep(lk, &lk->lock)`
- `releasesleep(lk)`：清除 locked 标志，`wakeup(lk)`

#### 3.4.3 sleep/wakeup 机制

```c
void sleep(void *chan, struct spinlock *lk) {
    if (lk != &p->lock) {
        acquire(&p->lock);
        release(lk);
    }
    p->chan = chan;
    p->state = SLEEPING;
    sched();
    p->chan = 0;
    if (lk != &p->lock) {
        release(&p->lock);
        acquire(lk);
    }
}
```

经典的 xv6 式 sleep/wakeup：进程在某个 channel 上睡眠，wakeup 扫描所有进程找到匹配 channel 的 SLEEPING 进程并设为 RUNNABLE。

---

### 3.5 陷阱/中断/异常处理

**文件**：`arch/riscv/trap/trap.c`, `mtrap.c`, `Uservec.S`, `kernelvec.S`, `mtrapvec.S`, `swtch.S`

#### 3.5.1 中断向量

三个 trap 入口：
- **`mtrapvec.S`**：M-mode 入口（仅 bare 启动模式），处理 MTI 和 SBI ecall
- **`kernelvec.S`**：S-mode 内核态 trap 入口，保存/恢复全部 32 个通用寄存器
- **`uservec.S`**：S-mode 用户态 trap 入口

#### 3.5.2 用户态 trap 路径

`uservec` 汇编：
```asm
uservec:
    csrrw sp, sscratch, sp     # 交换 sp 和 sscratch（内核栈）
    addi sp, sp, -256          # 分配 trapframe 空间
    # 保存所有寄存器到 trapframe
    sd ra, 0(sp)
    ...
    call usertrap               # 进入 C handler
```

`usertrap()` C 函数：
- 从 SPP 位验证来自用户模式
- 设置 stvec 为 kernelvec（内核态 trap 使用）
- 根据 scause 分发：
  - **定时器中断 (5)**：设置下一次定时器，调用 `yield()`
  - **外部中断 (9)**：PLIC claim，根据 IRQ 号分发到 UART 或 VirtIO
  - **ecall from U-mode (8)**：`tf->epc += 4`，调用 `syscall()`，然后 `yield()`
  - **页面错误 (13, 15)**：惰性分配/COW/VMA fault 处理

`usertrapret()` 返回用户态：
```c
void usertrapret(void) {
    intr_off();
    // 释放进程锁
    w_stvec((uint64) uservec);     // 恢复用户态 trap 向量
    // 设置 SPP=User
    x = r_sstatus();
    x &= ~SSTATUS_U_SPP;
    x |= SSTATUS_SPIE;
    w_sstatus(x);
    w_sepc(p->trapframe->epc);
    userret(p->trapframe);         // 汇编恢复寄存器 + sret
}
```

#### 3.5.3 PLIC 外部中断处理

已知问题：存在 PLIC 虚假触发（spurious interrupt），即 `plic_claim_interrupt` 返回 0 但 SEIP 仍挂起。FIXME workaround：检测到 IRQ=0 时屏蔽 SEIE，待定时器中断路径重新启用。

---

### 3.6 系统调用子系统

**文件**：`kernel/core/syscall.c`, `sysproc.c`, `sysfile.c`

#### 3.6.1 系统调用分发

```c
static uint64 (*syscalls[])() = {
    [SYS_write] = sys_write,
    [SYS_fork] = sys_fork,
    [SYS_exit] = sys_exit,
    [SYS_exit_group] = sys_exit,          // 同 exit
    [SYS_set_tid_address] = sys_set_tid_address,
    [SYS_wait4] = sys_wait4,
    [SYS_getpid] = sys_getpid,
    [SYS_brk] = sys_brk,
    [SYS_open] = sys_openat,              // open 映射到 openat
    [SYS_read] = sys_read,
    [SYS_close] = sys_close,
    [SYS_dup] = sys_dup,
    [SYS_fstat] = sys_fstat,
    [SYS_exec] = sys_exec,
    [SYS_mmap] = sys_mmap,
    [SYS_munmap] = sys_munmap,
    [SYS_mount] = sys_mount,
    [SYS_umount2] = sys_umount2,
    [SYS_dup3] = sys_dup3,
    [SYS_pipe2] = sys_pipe2,
    [SYS_getdents64] = sys_getdents64,
    [SYS_lseek] = sys_lseek,
    ... (共38个系统调用)
};
```

系统调用号遵循 **Linux RISC-V** 约定（如 `SYS_write=64`, `SYS_read=63`, `SYS_mmap=222`）。

参数获取通过 `argraw(n)` 直接从 trapframe 中读取 a0-a5 寄存器。

`fetch_user_str(pagetable, dst, src_va, max_len)` 逐字节 `copyin` 获取用户空间字符串。

#### 3.6.2 进程类系统调用 (`sysproc.c`)

| 系统调用 | 实现状态 | 备注 |
|---------|---------|------|
| `sys_fork` | 完整 | 调用 `fork()` |
| `sys_exit` | 完整 | 调用 `exit(exit_code)` |
| `sys_wait4` | 部分 | 支持 `WNOHANG`，不支持进程组 |
| `sys_getpid` | 完整 | 返回 `p->pid` |
| `sys_brk` | 完整 | 惰性堆分配 |
| `sys_getppid` | 完整 | |
| `sys_gettimeofday` | 完整 | 从 `r_time()` 读取，精度为 tick |
| `sys_times` | 存根 | 返回当前时间，进程时间统计为 0 |
| `sys_uname` | 完整 | 返回 "FrostVistaOS" 等固定字符串 |
| `sys_nanosleep` | 完整 | 忙等待 + yield |
| `sys_sched_yield` | 完整 | 调用 `yield()` |
| `sys_setpriority` | 存根 | 无调度优先级，直接返回 0 |
| `sys_set_tid_address` | 存根 | 返回 pid，不记录 tid 地址 |
| `sys_getuid/setuid/getgid/setgid` | 存根 | 返回 0 |

#### 3.6.3 文件类系统调用 (`sysfile.c`)

| 系统调用 | 实现状态 | 备注 |
|---------|---------|------|
| `sys_write` | 完整 | 支持文件、管道、设备 |
| `sys_read` | 完整 | 支持流设备部分读取 |
| `sys_open` | 完整 | 映射到 `openat` |
| `sys_openat` | 完整 | 支持 `AT_FDCWD`、绝对/相对路径、O_CREAT、O_TRUNC、O_APPEND |
| `sys_close` | 完整 | |
| `sys_dup` | 完整 | 引用计数 |
| `sys_dup3` | 完整 | 指定新 fd 编号 |
| `sys_fstat` | 完整 | 填充 `linux_stat` 结构 |
| `sys_exec` | 完整 | 支持 argv/envp，最多 16 个参数 |
| `sys_getcwd` | 完整 | |
| `sys_chdir` | 完整 | 验证目标为目录 |
| `sys_mkdirat` | 完整 | |
| `sys_unlinkat` | 完整 | 不支持 flags |
| `sys_linkat` | **未实现** | 返回 -1 |
| `sys_getdents64` | **未实现** | 返回 -1 |
| `sys_pipe2` | 完整 | 匿名管道 |
| `sys_lseek` | 完整 | |
| `sys_mount` | 完整 | |
| `sys_umount2` | 完整 | |
| `sys_shutdown` | 完整 | SBI 关机 |

---

### 3.7 文件系统子系统

#### 3.7.1 VFS 层 (`kernel/fs/vfs.c`)

统一 VFS 接口定义在 `include/kernel/fs.h`：

```c
struct vfs_inode_ops {
    struct vfs_inode *(*lookup)(...);
    int (*create)(...);
    int (*link)(...);
    int (*unlink)(...);
    int (*mkdir)(...);
    int (*rmdir)(...);
    int (*rename)(...);
    int (*stat)(...);
    int (*truncate)(...);
};

struct vfs_file_ops {
    int (*read)(struct file *f, uint8 *buffer, uint32 size);
    int (*write)(struct file *f, uint8 *buffer, uint32 size);
    int (*readdir)(...);
    int (*lseek)(...);
    int (*close)(...);
};
```

**VFS 路径解析**：

- `vfs_lookup_at(node, path)`：从指定节点开始，逐分量查找。**先检查挂载表**（`vfs_lookup_mount`），未命中则调用具体文件系统的 `lookup` 操作
- `vfs_create_at(start, path, type)`：路径遍历 + 叶节点创建
- `vfs_normalize_path(dst, path)`：处理 `.` 和 `..` 分量，规范化路径
- `vfs_make_absolute_path(dst, path)`：相对路径转绝对路径（基于进程 cwd）

**挂载系统**：
- `vfs_mount_at(parent, name, root)`：将文件系统挂载到指定目录
- 支持最大 8 个挂载点（`VFS_MAX_MOUNTS=8`）
- `vfs_mount_fs(path, root)`：高层挂载接口

**vfs_iput**：减少 inode 引用计数并调用 `put_inode()`。通过 `vfs_ilock/vfs_iunlock` 提供统一的锁接口。

#### 3.7.2 Easy-FS (`kernel/fs/easyfs/`)

自研简易磁盘文件系统，布局如下：

```
块 1:  超级块 (魔数 0x0B8EE2E0)
块 2:  inode 位图
块 3:  数据块位图
块 4-10: inode 区 (每块 64 个 inode，共 448 个)
块 11-4095: 数据区 (4085 个数据块)
```

**磁盘 inode 结构**（64 字节）：
```c
struct disk_inode {
    uint16 type;         // 文件/目录
    uint16 nlinks;
    uint32 size;
    uint32 blocks[12];   // 直接+间接块指针
    uint32 padding[2];
};
```

**间接块布局**：
- `blocks[0..9]`：10 个直接数据块（NDIRECT=10）
- `blocks[10]`：单级间接块（SINDIRECT_INDEX），存储 1024 个数据块号（NINDIRECT=BSIZE/4）
- `blocks[11]`：双级间接块（DINDIRECT_INDEX），存储 1024 个单级间接块号（NDINDIRECT=1024×1024）
- 最大文件：10 + 1024 + 1,048,576 = 1,049,610 块 ≈ 4GB

**`bmap(ip, block_num)`**：将逻辑块号映射到物理磁盘块号，支持三级查找。缺失时自动分配新块。

**`easyfs_itrunc(ip, size)`**：递归释放直接、单级间接和双级间接块。

**`dirlink(dp, name, inum)`**：在目录中创建目录项（28 字节名称 + 4 字节 inode 号）。

#### 3.7.3 EXT4 只读支持 (`kernel/fs/ext4fs/`)

最令人印象深刻的功能之一：**从零实现了 EXT4 只读读取器**，无需任何外部库。

**支持特性**：
- 超级块解析（魔数 0xEF53，偏移 1024 字节）
- 64-bit 特性支持（`EXT4_FEATURE_INCOMPAT_64BIT`）
- Extent 树遍历（仅 depth=0 叶节点）
- 块大小：通过 `s_log_block_size` 动态计算（`1024 << log_block_size`）
- inode 大小：支持 256 字节 inode（`EXT4_FEATURE_RO_COMPAT_EXTRA_ISIZE`）
- 灵活的块组描述符大小（64-bit 模式）

**不支持特性**：
- 深度 > 0 的 extent 索引节点
- 非 extent 的间接块映射
- 日志（`EXT4_FEATURE_COMPAT_HAS_JOURNAL` 被静默接受但未使用）
- 写入操作
- 目录哈希索引（`EXT4_FEATURE_COMPAT_DIR_INDEX`）
- 元数据校验和（`EXT4_FEATURE_RO_COMPAT_METADATA_CSUM` 被标记为支持但未实际验证）

**Extent 读取流程**：
```
ext4_read_file(fs, inode, offset, dst, len)
  -> ext4_find_extent(inode, logical_block)
     -> ext4_read_extent_header: 解析 extent 树头
     -> ext4_read_extent: 线性搜索匹配的 extent 条目
  -> 计算物理块号 → 字节偏移 → 缓存块号
  -> bread(dev, cache_block) → memcpy → brelse
```

**目录查找**：
```
ext4_lookup_in_dir(fs, dir, name, ino, file_type)
  -> 遍历 extent 树
  -> 对每个数据块调用 ext4_lookup_in_dir_block
     -> 解析 ext4_dir_entry_2 记录
     -> ext4_name_eq 名称匹配
```

#### 3.7.4 devtmpfs (`kernel/fs/devtmpfs/devtmpfs.c`)

内存设备文件系统，最大支持 8 个设备节点：

```c
static struct vfs_inode dev_nodes[DEVTMPFS_MAX_NODES];  // 8
```

- `devtmpfs_register(name, type, f_ops)`：注册设备节点
- 当前仅注册了 `tty` 设备
- tty 读：调用 `hal_console_getc()` 轮询获取字符，无输入时 `yield()`
- tty 写：调用 `hal_console_putc()` 逐字符输出，受自旋锁保护

#### 3.7.5 块缓存 (`kernel/fs/block_cache.c`)

类似 xv6 的 LRU 块缓冲层：

```c
struct bcache {
    struct spinlock bcache_lock;
    struct buf head;                // LRU 双向链表哨兵
    struct buf buf[NNUM];           // 缓冲区数组
};
```

- `bget(dev, blkno)`：在缓存中查找或分配缓冲区，从 LRU 尾部选择干净缓冲区
- `bread(dev, blockno)`：`bget` + 如无效则 `virtio_disk_rw` 读取
- `bwrite(buffer)`：写回磁盘
- `brelse(b)`：释放缓冲区锁，减少引用计数，移到 MRU 头部

#### 3.7.6 inode 缓存 (`kernel/fs/inode_cache.c`)

```c
struct inode_cache {
    struct spinlock lock;
    struct vfs_inode head;              // LRU 链表哨兵
    struct vfs_inode inodes[NINODES];   // inode 数组
};
```

- `get_inode(dev, ino)`：命中计数+1，未命中从 LRU 尾部回收
- `put_inode(ip)`：减少引用计数，最后一次引用且 `nlinks==0` 时清理并回收

**重要细节**：`get_inode` 在 miss 时分配 `ip->private_data = kalloc()`，但**不调用文件系统特定的 ilock** 来加载磁盘数据。实际的磁盘 inode 读取由各文件系统在各自的操作函数（如 `easyfs_ilock`）中完成。

---

### 3.8 文件描述符与管道

#### 3.8.1 文件描述符表 (`kernel/core/file.c`)

- 全局文件表 `ftable[NFILE]`（NFILE=128）+ 自旋锁
- 每进程最多打开 `NOFILE=128` 个文件
- `openat(dirfd, path, flags)`：核心打开逻辑
  - `resolve_open_path`：处理 `AT_FDCWD`、绝对/相对路径
  - 支持 `O_CREAT`、`O_TRUNC`、`O_APPEND`
  - 通过 VFS 层创建/查找文件
- `dup(fd)` / `dup3(oldfd, newfd, flags)`：文件描述符复制
- `fileclose(f)`：引用计数递减，归零时释放资源（管道或 inode）
- `filestat(fd, user_st_addr)`：填充 `linux_stat` 结构

#### 3.8.2 管道 (`kernel/core/pipe.c`)

512 字节环形缓冲区：

```c
struct pipe {
    struct spinlock lock;
    char buf[PIPE_BUF_SIZE];    // 512
    uint nread, nwrite;
    int readable, writable;
};
```

- `pipe_alloc(read, write)`：分配管道和一对文件结构
- `pipe_read(pi, buffer, size)`：逐字节 `copyout`，缓冲区空且可写时睡眠
- `pipe_write(pi, buffer, size)`：逐字节 `copyin`，缓冲区满时睡眠，读端关闭返回 -1（SIGPIPE 语义）
- `pipe_close(pi, writable)`：标记端关闭，唤醒等待者，两端均关闭时释放

---

### 3.9 设备驱动

#### 3.9.1 VirtIO 块设备 (`kernel/driver/virtio_blk.c`)

支持 **VirtIO-MMIO v1.1** 和 **v1.0 legacy** 双模式：

- **初始化流程**：
  1. 验证 Magic Value (`0x74726976`)、Version、Device ID
  2. 设备复位 → ACKNOWLEDGE → DRIVER → 协商特性 → FEATURES_OK
  3. 分配 virtqueue（legacy 模式需要连续 2 页，v1.1 模式使用分散分配）
  4. 设置 queue descriptors/avail/used 地址

- **I/O 流程**（`virtio_disk_rw(buffer, write)`）：
  1. 分配 3 个描述符（请求头 + 数据缓冲区 + 状态字节）
  2. 填充 `virtio_blk_req`（type/sector）
  3. 设置描述符链
  4. 更新 avail ring
  5. 写入 QueueNotify 寄存器
  6. `sleep(buffer, &driver.blk_lock)` 等待完成
  7. 中断处理 `virtio_disk_intr()` 扫描 used ring，设置 `buffer->done=1`，`wakeup(buffer)`
  8. 释放描述符链

- 描述符管理：空闲链表（`free_desc_idx`），`alloc_desc`/`free_chain`/`insert_free_desc_list`

#### 3.9.2 PLIC 中断控制器 (`arch/riscv/driver/PLIC.c`)

- `plic_init_uart()`：初始化 UART（优先级 1）和 VirtIO（优先级 2）中断
- 使用 S-mode context（`2 * hartid + 1`）
- 标准 PLIC 接口：set_priority、enable_interrupt、set_threshold、claim_interrupt、complete_interrupt

#### 3.9.3 UART 驱动 (`arch/riscv/driver/uart.c`)

NS16550 兼容串口：
- 寄存器通过 MMIO 访问
- 支持 TX/RX FIFO
- 接收中断触发时调用 `uartintr()` 将字符送入控制台缓冲区

#### 3.9.4 定时器 (`arch/riscv/driver/timer.c`)

- M-mode 预初始化：配置 MTIE，设置 mtimecmp 为无穷大
- S-mode 初始化：启用 SIE_STIE，通过 SBI `set_timer` 设置下一次中断（1000000 ticks ≈ 0.1s @10MHz）

---

### 3.10 用户态运行时

#### 3.10.1 用户库 (`user/ulib.c`)

提供基本的 POSIX 风格封装：
- `syscall(num, a0, a1, a2)` / `syscall4` / `syscall6`：内联汇编 ecall
- `write`, `read`, `open`, `close`, `dup`, `fork`, `exec`, `execve`, `execv`, `wait`, `waitpid`
- `malloc`（通过 `sbrk` 基于 `brk` 系统调用实现）
- `printf`：支持 `%d`、`%s`，256 字节内部缓冲区
- `strlen`, `memcpy`, `memset`, `strcmp`, `strncmp`, `strcpy`, `strncpy`, `strchr`
- `mmap`, `munmap`, `chdir`, `mkdir`, `getcwd`, `getpid`, `getppid`
- `gettimeofday`, `times`, `uname`, `nanosleep`, `sched_yield`
- `lseek`, `dup3`, `pipe2`, `unlink`, `shutdown`

#### 3.10.2 Shell (`user/bin/fvsh.c`)

交互式命令 Shell：
- 提示符 `fvsh> `
- 行编辑：支持退格键（`\b`/`DEL`）
- 内置命令：`help`、`pwd`、`cd`、`exit`
- 外部命令：通过 `fork` + `execv` 执行
- 参数解析：空格分隔，最多 15 个参数
- **不支持**：管道（`|`）、重定向（`>`, `<`）、后台执行（`&`）

---

### 3.11 测试框架

**文件**：`test/test_runner.c`, `test/test_*.c`, `scripts/run_tests.py`

约 40 个专项测试（约 4000 行代码），覆盖：
- Easy-FS：基本 I/O、目录项、间接块、双重间接块、大文件、itrunc、mkdir、unlink、路径解析、偏移量
- 进程：fork、wait、exit、execv、getuid、set_tid_address
- 文件：open、fstat、VFS 路径
- 管道：系统调用 pipe 综合测试（540 行，最详细的测试）
- mmap：匿名映射、文件映射、fork 继承、execve 后清理、惰性分配
- Shell：交互测试、脚本测试
- 其他：write、brk、io、COW、busybox 兼容性

测试编译为 `/init` 嵌入内核镜像，启动时自动运行。

---

## 4. 子系统交互分析

### 4.1 系统调用完整路径

以 `write(fd, buf, len)` 为例：

```
用户态: write() -> ecall
  ↓
uservec.S: 保存寄存器到 trapframe
  ↓
usertrap(): scause==8 → syscall()
  ↓
syscall(): tf->a7==SYS_write → sys_write()
  ↓
sys_write():
  1. argint/argaddr 获取参数
  2. 验证 fd 和文件权限
  3. 若为管道: pipe_write(file->pipe, ...)
     若为普通文件: file->node->default_f_ops->write(file, buf, len)
       ↓
     easyfs_vfs_write():
       vfs_ilock(f->node)
       easyfs_write_inode(ip, ...):
         遍历写入范围:
           bmap(ip, block_num) → balloc(dev) 按需分配
           bread(dev, addr) → memmove → bwrite(bp) → brelse(bp)
         iupdate(ip) 同步元数据
       vfs_iunlock(f->node)
  ↓
usertrapret() → userret → sret
```

### 4.2 页面错误处理路径

```
用户访问未映射地址
  ↓
硬件触发页面错误 (scause=13/15)
  ↓
uservec → usertrap()
  ↓
判断 tval 位置:
  [heap_bottom, heap_top): handle_page_fault(pagetable, tval)
    → kalloc() + mappages(PTE_V|PTE_R|PTE_W|PTE_U)
  
  (heap_top, stack_bottom): handle_vma_fault(tval)
    → find_overlapping_vma(tval, PGSIZE)
    → 匿名: handle_anonymous_vma_fault(vma, va)
        → kalloc() + kvmmap(vma->vm_page_prot)
    → 文件: handle_file_vma_fault(vma, va)
        → kalloc() + vfs_read_at(file->node, ...) + kvmmap()
  
  其他: 进程 → ZOMBIE
```

### 4.3 中断处理路径

```
CLINT 定时器到期 → MTI (M-mode)
  ↓
mtrapvec → m_trap():
  mcause==7 → 设置 STIP, 清除 mtimecmp
  ↓
(mret 返回 S-mode)
kernelvec → s_trap_handler():
  scause 最高位==1, code==5 (STI)
  → sbi_set_timer(r_time() + 1000000)
  → 返回 (不做 yield，S-mode 中断上下文)
  
或者，在用户态:
uservec → usertrap():
  code==5 → sbi_set_timer() → yield()
  → 调度器选择下一个 RUNNABLE 进程
```

---

## 5. 实现完整度评估

基于标准现代教学/实验内核的功能期望，自行定义评估基准如下：

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| **启动引导** | 90% | bare + opensbi 双模式，缺少设备树解析和多核启动协调 |
| **物理内存管理** | 75% | 基础空闲链表，缺少页面引用计数、内存压缩、NUMA 感知 |
| **虚拟内存管理** | 80% | Sv39 完整实现，含 COW、惰性分配、VMA，但缺少共享映射、大页、mprotect |
| **进程管理** | 70% | fork/exec/exit/wait 完整，调度器简陋（无优先级、无时间片），无信号、无线程 |
| **系统调用** | 60% | 38 个系统调用，覆盖基本 POSIX，缺少 getdents64、linkat、信号相关 |
| **同步原语** | 65% | 自旋锁+睡眠锁+sleep/wakeup，无 RCU、无读写锁、无信号量 |
| **VFS** | 70% | 统一的 inode/file_ops，挂载系统，路径规范化；缺少 rename、rmdir、readdir |
| **Easy-FS** | 85% | 直接+单间接+双间接块，位图分配，目录操作；缺少权限位、时间戳 |
| **EXT4 只读** | 40% | 支持 extent 叶节点和基本目录遍历；缺少深度 extent 索引、间接块、日志 |
| **devtmpfs** | 40% | 仅 tty 设备，最大 8 节点 |
| **块缓存** | 80% | LRU 缓存、脏写回；缺少预读、写合并 |
| **管道** | 85% | 环形缓冲区、阻塞读写、SIGPIPE 语义 |
| **VirtIO 块设备** | 75% | legacy+v1.1 双模式；仅支持同步 I/O，缺少多队列 |
| **PLIC/UART/Timer** | 80% | 基本功能正常，PLIC 有虚假中断 workaround |
| **用户态运行时** | 55% | 基本 syscall wrapper 和 printf，缺少 malloc/free（有 sbrk 基元）、动态链接器 |
| **Shell** | 30% | 基本交互，缺少管道、重定向、脚本、作业控制 |

**整体内核实现完整度**：约 **65%**（基于各子系统等权平均）。核心路径（启动→进程→文件→I/O）可用，但许多子系统处于"最小可用"状态。

---

## 6. 设计创新性分析

### 6.1 创新点

1. **EXT4 只读读取器的自主实现**
   在不依赖任何外部库的情况下，从零构建了 EXT4 文件系统读取器。这在内核教学项目中非常罕见。实现直接操作 EXT4 超级块字段偏移、extent 树遍历和目录项解析，展示了深厚的文件系统理解。

2. **双启动模式的无缝切换**
   `bare` 和 `opensbi` 两种启动路径通过条件编译和运行时检测优雅共存。`mstart.c` 中的 M-mode 初始化仅约 60 行代码完成 PMP 配置、中断代理和模式切换。

3. **早期模式 (early_mode) 地址转换策略**
   `early_mode` 全局标志解决了内核从物理地址恒等映射过渡到高半虚拟地址的经典难题。`walk()` 函数根据此标志动态选择地址转换方式，使得同一段页表操作代码在分页启用前后均可工作。

4. **手写机器码引导用户态**
   `user_init()` 中硬编码 RISC-V 指令作为第一个用户进程的代码，直接内存复制到用户页表中执行 `exec("/init")`。这是一种精巧的自举手段。

5. **VMA O(1) 固定槽位设计**
   NVMA=16 的固定数组而非动态链表，配合线性搜索。在小型内核场景下简化了锁和内存管理，避免了复杂的区间树。

### 6.2 受 xv6 影响的方面

- 进程调度器的 `swtch` 机制
- sleep/wakeup 同步范式
- 块缓存和 inode 缓存的 LRU 设计
- Easy-FS 的磁盘布局和 bmap 逻辑
- 文件描述符表结构

### 6.3 独创性程度的平衡

FrostVista 在 xv6 基础上进行了显着的自主扩展：mmap/VMA 子系统、EXT4 只读读取器、devtmpfs、Linux ABI 兼容层均为原创实现。它不是简单的 xv6 移植，而是一个具有明确技术追求的教学/实验内核。

---

## 7. 构建与测试评估

### 7.1 构建系统

基于 GNU Make 的模块化构建系统：
- `mk/config.mk`：用户可配置默认值
- `mk/toolchain.mk`：自动检测可用的 RISC-V 工具链（riscv64-elf、riscv64-unknown-elf、riscv64-linux-gnu）
- `mk/sources.mk`：动态源文件发现
- `mk/fs.mk`：文件系统特性组合选择
- `mk/build.mk`：用户态测试嵌入、内核 ELF 链接

成功使用 `riscv64-unknown-elf-gcc 13.2.0` 构建（编译选项：`-march=rv64imac_zicsr_zifencei -mabi=lp64 -mcmodel=medany -O2`）。

### 7.2 已知构建问题

- `all` 目标硬编码为 `BOOT=opensbi FS_LIST="ext4 devtmpfs" ROOTFS=ext4`，覆盖命令行参数
- 用户态程序使用 `-N -e _start -Ttext 0x10000` 链接（非标准链接脚本），产生 RWX 段警告
- 缺少 `cargo` 工具（Rust 工具链不完整），但不影响本 C 项目

### 7.3 测试结果

未进行 QEMU 运行时测试（需要 ext4 磁盘镜像 `sdcard-rv.img`）。但代码中有完整的测试框架（约 40 个测试、4000 行测试代码），且测试被设计为自动嵌入内核运行。

---

## 8. 其他发现

### 8.1 已知问题

1. **PLIC 虚假中断**：代码中明确标注了 PLIC SEIP 虚假触发问题及其 FIXME workaround
2. **进程结构体过大**：注释提到 `NOFILE=128` 导致 `struct Process` 过大，曾导致 exec 时内核栈溢出
3. **inode 缓存引用计数问题**：`put_inode` 中 `nlinks==0` 时的清理逻辑不完整（有 FIXME 注释）
4. **`sys_linkat` 和 `sys_getdents64` 完全未实现**
5. **调度器无时间片**：进程可无限运行直到自愿 yield

### 8.2 代码质量

- 注释详尽（中文+英文混合），许多关键设计决策有解释
- 使用 LOG 模块进行分级日志（TRACE/DEBUG/INFO/WARN/ERROR）
- 有 `.clang-format`、`.clang-tidy`、`.clangd` 配置
- 函数普遍有 Doxygen 风格文档注释，包含 Context、Return、Lock contract 说明

### 8.3 版本路线图

来自 `releases.md`：
- v1.0：交互式 Shell（已达成）
- v1.1：VMA/mmap（已达成）
- 未来计划未知

---

## 9. 总结

FrostVista OS 是一个在 xv6 基础上进行了大量自主研发的 RISC-V 64 位教学内核。其最突出的技术成就包括：

1. **自主研发的 EXT4 只读文件系统读取器**——在同类型项目中极为罕见
2. **完整的 Sv39 虚拟内存管理**——含 COW、VMA、惰性分配、mmap/munmap
3. **双模式启动系统**——bare metal 和 OpenSBI 均无缝支持
4. **Linux RISC-V ABI 兼容**——38 个系统调用使用标准 Linux 编号
5. **三层文件系统架构**——VFS + Easy-FS（读写）+ EXT4（只读）+ devtmpfs

项目的主要局限在于：调度器过于简单（无优先级、无时间片），部分系统调用未实现（getdents64、linkat），Shell 功能有限（无管道/重定向），以及已知的 PLIC 虚假中断问题。

总体而言，这是一个具备明确技术追求、代码质量良好、文档详尽的教学/实验内核项目，展现了作者在操作系统核心概念上的扎实功底。