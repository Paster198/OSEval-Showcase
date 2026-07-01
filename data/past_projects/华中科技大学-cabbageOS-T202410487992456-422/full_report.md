# cabbageOS 内核技术分析报告

## 1. 分析范围与方法

### 1.1 分析内容

本报告基于对 cabbageOS 内核项目的完整源码审查，涵盖以下方面：

- **源码结构分析**：遍历整个仓库的目录结构、文件组织和模块划分
- **核心子系统实现**：深入分析内存管理、进程/线程管理、文件系统、IPC、同步机制、驱动、系统调用等子系统的实现细节
- **汇编层分析**：检查启动代码、上下文切换、中断/异常处理、用户态/内核态切换等底层实现
- **构建系统分析**：审查 CMake 配置、Makefile、工具链配置和镜像制作流程
- **平台支持分析**：分析 QEMU 和 VisionFive2 两个平台的适配代码
- **依赖库分析**：检查 Rust 实现的 virtio-drivers 和 sdcard 驱动集成方式

### 1.2 测试情况

**未进行运行时测试**，原因如下：

1. **构建依赖缺失**：项目需要 `sudo mount` 权限来制作文件系统镜像，当前环境不支持
2. **镜像制作流程复杂**：需要先执行 `make-image` 生成文件系统镜像，该过程涉及 `mkfs.ext4`/`mkfs.vfat` 和 `mount`/`umount` 操作
3. **Rust 依赖编译**：VisionFive2 平台需要编译 Rust 实现的 sdcard 驱动，增加构建复杂度
4. **测试用例依赖外部资源**：`tests/oscomp` 和 `tests/final` 目录包含竞赛测试用例，需要特定的运行环境

因此，本报告的分析完全基于静态代码审查。

---

## 2. 子系统概览与完整度评估

### 2.1 子系统列表

cabbageOS 实现了以下核心子系统：

| 子系统 | 核心文件数 | 代码行数（估算） | 完整度评估 |
|--------|-----------|----------------|-----------|
| 启动与平台层 | 6 | ~800 | 90% |
| 内存管理 | 7 | ~2500 | 85% |
| 进程/线程管理 | 5 | ~3000 | 90% |
| 文件系统（VFS） | 7 | ~2000 | 80% |
| 文件系统（FAT32） | 8 | ~3500 | 85% |
| 文件系统（ext4） | 3 + lwext4 | ~1500 + 外部库 | 75% |
| 文件系统（procfs） | 6 | ~800 | 70% |
| IPC（管道/共享内存/信号） | 4 | ~1800 | 85% |
| 同步机制 | 5 | ~1200 | 90% |
| 驱动层 | 6 | ~1500 | 80% |
| 系统调用 | 8 | ~4000 | 95% |
| 汇编层 | 5 | ~600 | 95% |
| 内核库 | 8 | ~2000 | 85% |

**整体完整度**：约 85%（基于 Linux 内核核心功能的覆盖程度）

---

## 3. 各子系统详细实现分析

### 3.1 启动与平台层

#### 3.1.1 启动流程

**入口点**：`kernel/platform/qemu/entry/entry.S`

```assembly
.section .text
.global _entry
_entry:
    la sp, stack0
    li t0, 1024*4
    mv t1, a0          # a0 包含 hartid（由 SBI 传入）
    addi t1, t1, 1
    mul t0, t0, t1
    add sp, sp, t0     # 为每个 hart 分配独立栈
    call start         # 跳转到 C 代码
spin:
    j spin
```

**设计特点**：
- 支持多核启动，每个 hart 拥有独立的 4KB 栈空间
- 通过 `a0` 寄存器接收 hartid，存储在 `tp` 寄存器中供后续使用
- 栈空间静态分配在 `stack0[NCPU][4096]` 数组中

**C 入口**：`kernel/platform/qemu/src/start.c`

```c
void start(long hartid, uint64 _dtb_entry) {
    w_tp(hartid);      # 将 hartid 写入 tp 寄存器
    main();            # 跳转到主初始化函数
}
```

#### 3.1.2 主初始化流程

**文件**：`kernel/platform/qemu/src/main.c`

```c
void main() {
    if (atomic_read4((int *) &first) == 0) {
        first = 1;
        hartids[cpuid()] = 1;
        console_init();           # 1. 控制台初始化
        null_zero_dev_init();     # 2. /dev/null, /dev/zero 初始化
        printf_init();            # 3. printf 初始化
        hartinit();               # 4. hart 初始化（设置 SSTATUS_SUM）
        printf("\nCabbageOS kernel is booting\n\n");
        mm_init();                # 5. 内存管理初始化（Buddy 系统）
        vmas_init();              # 6. VMA 表初始化
        kvm_init();               # 7. 内核页表创建
        kvm_init_hart();          # 8. 启用分页
        proc_init();              # 9. 进程表初始化
        tcb_init();               # 10. 线程表初始化
        timer_init();             # 11. 定时器初始化
        trap_init();              # 12. 陷阱向量初始化
        trap_init_hart();         # 13. 安装内核陷阱向量
        plic_init();              # 14. PLIC 初始化
        plic_init_hart();         # 15. PLIC hart 配置
        b_init();                 # 16. 缓冲区缓存初始化
        file_init();              # 17. 文件表初始化
        inode_table_init();       # 18. inode 表初始化
        vfs_ext_init();           # 19. ext4 初始化
        futex_hash_init();        # 20. futex 哈希表初始化
        disk_init();              # 21. 磁盘初始化
        comp_init();              # 22. 创建初始进程
        __sync_synchronize();
        started = 1;
        __sync_synchronize();
        start_all_harts();        # 23. 启动其他 hart
    } else {
        # 其他 hart 的初始化路径
        while (atomic_read4((int *) &started) == 0);
        __sync_synchronize();
        hartinit();
        kvm_init_hart();
        trap_init_hart();
        plic_init_hart();
    }
    thread_scheduler();           # 24. 进入调度器
}
```

**初始化顺序分析**：
- 采用严格的依赖顺序，确保每个子系统在其依赖项就绪后初始化
- 使用原子变量 `first` 和 `started` 实现多核同步
- 第一个 hart 完成所有初始化后，通过 `start_all_harts()` 唤醒其他 hart

#### 3.1.3 链接器脚本

**文件**：`kernel/platform/qemu/linker/linker.ld`

```ld
OUTPUT_ARCH( "riscv" )
ENTRY( _entry )

SECTIONS
{
  . = 0x80200000;  # 内核加载地址（QEMU -kernel 跳转目标）

  .text : {
    *(.text .text.*)
    . = ALIGN(0x1000);
    _trampoline = .;
    *(trampsec)    # trampoline 代码段
    . = ALIGN(0x1000);
    ASSERT(. - _trampoline == 0x1000, "error: trampoline larger than one page");
    _sigreturn = .;
    *(sigret_sec)  # 信号返回代码段
    . = ALIGN(0x1000);
    ASSERT(. - _sigreturn == 0x1000, "error: sigreturn larger than one page");
    PROVIDE(etext = .);
  }

  .rodata : { ... }
  .data : { ... }
  .bss : {
    PROVIDE(bss_start = .);
    ...
    PROVIDE(bss_end = .);
  }
  PROVIDE(end = .);
}
```

**设计特点**：
- trampoline 和 sigreturn 代码段被强制对齐到页边界，确保可以独立映射
- 使用 `ASSERT` 确保这些关键代码段不超过一页（4KB）
- 导出 `bss_start`、`bss_end`、`end` 等符号供内核使用

---

### 3.2 内存管理子系统

#### 3.2.1 Buddy 伙伴系统分配器

**文件**：`kernel/src/mm/buddy.c`

**核心数据结构**：

```c
struct page {
    int allocated;           # 分配状态
    int order;               # 块大小（2^order 页）
    struct list_head list;   # 空闲链表节点
    struct spinlock lock;    # 页锁（用于 COW）
    int count;               # 引用计数（用于 COW）
    uint64 flags;            # 页标志
    struct address_space *mapping;  # 页缓存映射
    uint64 pagecache_idx;    # 页缓存索引
};

struct phys_mem_pool {
    uint64 start_addr;
    uint64 mem_size;
    struct page *page_metadata;
    struct spinlock lock;
    struct free_list freelists[BUDDY_MAX_ORDER + 1];  # 14 个空闲链表（order 0-13）
};

extern struct phys_mem_pool mem_pools[NCPU];  # 每个 CPU 一个内存池
```

**内存布局**：

```
+---------------------------+ <-- 0x80200000 (KERNBASE)
|     kernel img region     |
+---------------------------+ <-- end (kernel.ld 导出)
|    page_metadata region   |  # struct page 数组
+---------------------------+ <-- START_MEM (0xa4000000)
|          MEMORY           |
|           ...             |
+---------------------------+ <-- PHYSTOP (0x80000000 + 3GB)
```

**初始化逻辑**：

```c
void mm_init() {
    pagemeta_start = (struct page *) PGROUNDUP((uint64) end);
    for (int i = 0; i < NCPU; i++) {
        init_buddy(&mem_pools[i], 
                   (struct page *) PGROUNDUP((uint64) end) + i * PAGES_PER_CPU,
                   (uint64) START_MEM + i * PAGES_PER_CPU * PGSIZE, 
                   PAGES_PER_CPU);
    }
}
```

**分配算法**：

```c
struct page *buddy_get_pages(struct phys_mem_pool *pool, const uint64 order) {
    pop_off();  # 禁用中断
    acquire(&pool->lock);
    
    # 从 order 开始向上查找
    for (int i = order; i <= BUDDY_MAX_ORDER; i++) {
        const struct list_head *lists = &pool->freelists[i].lists;
        if (!list_empty(lists)) {
            page = list_first_entry(lists, struct page, list);
            list_del(&page->list);
            pool->freelists[page->order].num--;
            break;
        }
    }
    
    if (page == NULL) {
        release(&pool->lock);
        return NULL;
    }
    
    # 如果找到的块大于请求，进行分裂
    if (page->order > order) {
        page = split_page(pool, order, page);
    }
    page->allocated = 1;
    release(&pool->lock);
    return page;
}
```

**分裂算法**：

```c
static struct page *split_page(struct phys_mem_pool *pool, const uint64 order, struct page *page) {
    while (page->order > order) {
        page->order--;
        struct page *buddy = get_buddy(pool, page);  # 计算伙伴页
        buddy->order = page->order;
        list_add(&buddy->list, &pool->freelists[buddy->order].lists);
        pool->freelists[buddy->order].num++;
    }
    return page;
}
```

**合并算法**：

```c
static struct page *merge_page(struct phys_mem_pool *pool, struct page *page) {
    if (page->order == BUDDY_MAX_ORDER) return page;
    
    struct page *buddy = get_buddy(pool, page);
    if (buddy == NULL) return page;
    
    # 如果伙伴空闲且 order 相同，合并
    if (buddy->allocated == 0 && buddy->order == page->order) {
        list_del(&buddy->list);
        pool->freelists[buddy->order].num--;
        
        # 合并后的页是两者中地址较小的
        struct page *merge = ((uint64) buddy < (uint64) page ? buddy : page);
        merge->order++;
        return merge_page(pool, merge);  # 递归合并
    }
    return page;
}
```

**伙伴计算**：

```c
static struct page *get_buddy(struct phys_mem_pool *pool, struct page *page) {
    const uint64 this_off = page_to_offset(pool, page);
    # 通过异或计算伙伴偏移（关键位翻转）
    const uint64 buddy_off = this_off ^ (1UL << (page->order + 12));
    
    if (buddy_off >= pool->mem_size) return NULL;
    return offset_to_page(pool, buddy_off);
}
```

**完整度评估**：90%
- 实现了完整的 Buddy 系统（分配、释放、分裂、合并）
- 支持多 CPU 内存池，减少锁竞争
- 支持跨 CPU 内存窃取（`steal_mem`）
- 缺少内存压缩和 NUMA 支持

#### 3.2.2 内核内存分配器

**文件**：`kernel/src/mm/kalloc.c`

```c
void *kmalloc(const size_t size) {
    uint64 order;
    if (size <= PGSIZE) {
        order = 0;
    } else {
        order = size_to_page_order(size);  # 计算所需的 order
    }
    
    push_off();
    const int id = cpuid();
    struct page *page = buddy_get_pages(&mem_pools[id], order);
    
    if (page == NULL) {
        page = steal_mem(id, order);  # 从其他 CPU 窃取
        if (page == NULL) return 0;
    }
    
    acquire(&page->lock);
    page->count = 1;
    release(&page->lock);
    return (void *) page_to_pa(page);
}

void kfree(void *pa) {
    struct page *page = pa_to_page((uint64) pa);
    acquire(&page->lock);
    page->count--;
    if (page->count >= 1) {
        release(&page->lock);
        return;  # 仍有引用，不释放
    }
    release(&page->lock);
    
    const int id = get_pages_cpu(page);
    buddy_free_pages(&mem_pools[id], page);
}
```

**设计特点**：
- 使用引用计数支持 Copy-on-Write
- 优先从当前 CPU 的内存池分配，失败时跨 CPU 窃取
- 提供 `kzalloc`（清零分配）和 `kcalloc`（数组分配）变体

#### 3.2.3 虚拟内存管理

**文件**：`kernel/src/mm/vm.c`

**内核页表创建**：

```c
pagetable_t kvmmake(void) {
    const pagetable_t kpgtbl = kzalloc(PGSIZE);
    
    # UART 寄存器映射
    kvm_map(kpgtbl, UART0, UART0, PGSIZE, PTE_R | PTE_W, COMMONPAGE);
    
    # VirtIO 磁盘映射
    kvm_map(kpgtbl, VIRTIO0, VIRTIO0, PGSIZE, PTE_R | PTE_W, COMMONPAGE);
    
    # PLIC 映射（4MB）
    kvm_map(kpgtbl, PLIC, PLIC, 0x400000, PTE_R | PTE_W, SUPERPAGE);
    
    # CLINT_MTIME 映射
    kvm_map(kpgtbl, CLINT_MTIME, CLINT_MTIME, PGSIZE, PTE_R, COMMONPAGE);
    
    # 内核代码段（只读+可执行）
    vaddr_t super_aligned_sz = SUPERPG_DOWN((uint64) etext - KERNBASE);
    if (super_aligned_sz != 0) {
        kvm_map(kpgtbl, KERNBASE, KERNBASE, super_aligned_sz, PTE_R | PTE_X, SUPERPAGE);
    }
    kvm_map(kpgtbl, KERNBASE + super_aligned_sz, KERNBASE + super_aligned_sz,
            (uint64) etext - KERNBASE - super_aligned_sz, PTE_R | PTE_X, COMMONPAGE);
    
    # 内核数据段（可读写）
    super_aligned_sz = SUPERPG_DOWN(PHYSTOP - (uint64) etext);
    kvm_map(kpgtbl, (uint64) etext, (uint64) etext, PHYSTOP - (uint64) etext - super_aligned_sz, 
            PTE_R | PTE_W, COMMONPAGE);
    kvm_map(kpgtbl, SUPERPG_ROUNDUP((uint64) etext), SUPERPG_ROUNDUP((uint64) etext), 
            super_aligned_sz, PTE_R | PTE_W, SUPERPAGE);
    
    # Trampoline 映射
    kvm_map(kpgtbl, TRAMPOLINE, (uint64) trampoline, PGSIZE, PTE_R | PTE_X, COMMONPAGE);
    
    # 为每个线程映射内核栈
    tcb_mapstacks(kpgtbl);
    
    return kpgtbl;
}
```

**页表遍历**：

```c
int walk(pagetable_t pagetable, uint64 va, int alloc, int low_level, pte_t **pte) {
    if (va >= MAXVA) panic("walk");
    
    for (int level = LEVELS - 1; level > low_level; level--) {
        pte_t *pte_tmp = &pagetable[PN(level, va)];
        if (*pte_tmp & PTE_V) {
            # 检查是否为叶子节点（超级页）
            if ((*pte_tmp & PTE_R) || (*pte_tmp & PTE_X)) {
                *pte = pte_tmp;
                ASSERT(level == 1);  # 仅支持 2MB 超级页
                return level;
            }
            pagetable = (pagetable_t) PTE2PA(*pte_tmp);
        } else {
            if (!alloc || (pagetable = (pde_t *) kzalloc(PGSIZE)) == 0) {
                *pte = 0;
                return -1;
            }
            *pte_tmp = PA2PTE(pagetable) | PTE_V;
        }
    }
    *pte = (pte_t *) &pagetable[PN(low_level, va)];
    return 0;
}
```

**设计特点**：
- 支持 Sv39 三级页表（4KB 普通页 + 2MB 超级页）
- 内核使用直接映射（物理地址 = 虚拟地址）
- Trampoline 映射到最高虚拟地址，用户态和内核态共享

#### 3.2.4 VMA（虚拟内存区域）管理

**文件**：`kernel/src/mm/vma.c`

**数据结构**：

```c
struct vma {
    vma_type type;           # VMA_STACK, VMA_HEAP, VMA_TEXT, VMA_FILE, VMA_ANON, VMA_INTERP
    struct list_head node;   # 链表节点
    vaddr_t startva;         # 起始虚拟地址
    size_t size;             # 大小
    uint32 perm;             # 权限（PERM_READ, PERM_WRITE, PERM_EXEC, PERM_SHARED）
    int used;                # 使用状态
    int fd;                  # 文件描述符（文件映射）
    uint64 offset;           # 文件偏移（文件映射）
    struct file *vm_file;    # 文件指针（文件映射）
};

struct vma vmas[NVMA];  # 全局 VMA 池（3000 个）
```

**VMA 分配**：

```c
static struct vma *alloc_vma(void) {
    acquire(&vmas_lock);
    for (int i = 0; i < NVMA; i++) {
        if (vmas[i].used == 0) {
            vmas[i].used = 1;
            release(&vmas_lock);
            return &vmas[i];
        }
    }
    release(&vmas_lock);
    return 0;
}
```

**VMA 映射**：

```c
struct vma *vma_map_range(struct mm_struct *mm, uint64 va, size_t len, uint64 perm, uint64 type) {
    struct vma *vma = alloc_vma();
    if (vma == NULL) return 0;
    
    vma->startva = PGROUNDDOWN(va);
    if (len < PGSIZE) len = PGSIZE;
    vma->size = PGROUNDUP(len);
    vma->perm = perm;
    vma->type = type;
    
    if (add_vma_to_vmspace(&mm->head_vma, vma) < 0) {
        goto free_vma;
    }
    return vma;
    
free_vma:
    free_vma(vma);
    return 0;
}
```

**VMA 分裂**：

```c
int split_vma(struct mm_struct *mm, struct vma *vma, unsigned long addr, int new_below) {
    struct vma *new = alloc_vma();
    if (!new) return -1;
    
    # 复制 VMA 属性
    *new = *vma;
    
    if (new_below) {
        # 新 VMA 在下方
        new->startva = addr;
        new->size = vma->startva + vma->size - addr;
        vma->size = addr - vma->startva;
    } else {
        # 新 VMA 在上方
        new->startva = addr;
        new->size = vma->startva + vma->size - addr;
        vma->size = addr - vma->startva;
    }
    
    # 插入新 VMA
    list_add(&new->node, &vma->node);
    return 0;
}
```

**完整度评估**：85%
- 实现了完整的 VMA 管理（分配、释放、分裂、合并）
- 支持多种 VMA 类型（栈、堆、代码、文件、匿名、解释器）
- 缺少 VMA 合并优化和内存保护键（MPK）支持

#### 3.2.5 mmap/munmap 实现

**文件**：`kernel/src/mm/mmap.c`

```c
void *do_mmap(vaddr_t addr, size_t length, int prot, int flags, struct file *fp, off_t offset) {
    struct mm_struct *mm = proc_current()->mm;
    vaddr_t mapva = 0;
    
    if (addr == 0) {
        mapva = find_mapping_space(mm, addr, length);  # 自动选择地址
    } else {
        if ((flags & MAP_FIXED) == 0) {
            return MAP_FAILED;
        }
        
        # 处理 MAP_FIXED：可能需要分裂现有 VMA
        uint64 start = addr;
        uint64 end = addr + length;
        struct vma *vma;
        if ((vma = find_vma_for_va(mm, addr)) != NULL) {
            if (start != vma->startva) {
                if (split_vma(mm, vma, start, 1) < 0) return MAP_FAILED;
            }
            if (end != vma->startva + vma->size) {
                if (split_vma(mm, vma, end, 0) < 0) return MAP_FAILED;
            }
            del_vma_from_vmspace(&mm->head_vma, vma);
            mapva = addr;
        }
    }
    
    if (flags & MAP_ANONYMOUS || fp == NULL) {
        if (vma_map(mm, mapva, length, mkperm(prot, flags), VMA_ANON) < 0) {
            return MAP_FAILED;
        }
    } else {
        if (vma_map_file(mm, mapva, length, mkperm(prot, flags), VMA_FILE, offset, fp) < 0) {
            return MAP_FAILED;
        }
    }
    
    return (void *) (mapva);
}
```

**munmap 实现**：

```c
uint64 sys_munmap(void) {
    vaddr_t addr;
    size_t length;
    arg_addr(0, &addr);
    arg_ulong(1, &length);
    
    struct mm_struct *mm = proc_current()->mm;
    struct vma *vma, *next;
    
    # 遍历所有与 [addr, addr+length) 重叠的 VMA
    list_for_each_entry_safe(vma, next, &mm->head_vma, node) {
        if (vma->startva + vma->size > addr && vma->startva < addr + length) {
            vmspace_unmap(mm, vma->startva, vma->size);
        }
    }
    
    return 0;
}
```

#### 3.2.6 缺页异常处理

**文件**：`kernel/src/mm/pagefault.c`

```c
int page_fault(uint64 cause, pagetable_t pagetable, vaddr_t st_val) {
    if (PGROUNDDOWN(st_val) >= MAXVA) {
        printf("exceed the MAXVA");
        return -1;
    }
    
    const struct vma *vma = find_vma_for_va(proc_current()->mm, st_val);
    if (vma != NULL) {
        if (!CHECK_PERM(cause, vma)) {
            PAGEFAULT("permission checked failed");
            return -1;
        }
        
        pte_t *pte;
        const int level = walk(pagetable, st_val, 0, 0, &pte);
        if (pte == NULL || (*pte == 0)) {
            # 页未映射：分配物理页
            uvm_alloc(pagetable, PGROUNDDOWN(st_val), PGROUNDUP(st_val + 1), perm_vma2pte(vma->perm));
            
            if (vma->type == VMA_FILE) {
                # 文件映射：从文件读取内容
                const paddr_t pa = walk_addr(pagetable, st_val);
                struct inode *f_inode;
                if (vma->vm_file->f_type == FAT32)
                    f_inode = vma->vm_file->f_data.f_vnode->data;
                else
                    f_inode = vfs_ext_namei(vma->vm_file->f_data.f_vnode->path);
                
                f_inode->i_op->lock(f_inode);
                f_inode->i_op->read(f_inode, 0, pa, vma->offset + PGROUNDDOWN(st_val) - vma->startva, PGSIZE);
                f_inode->i_op->unlock(f_inode);
            }
        } else {
            const uint64 pa = PTE2PA(*pte);
            const uint flags = PTE_FLAGS(*pte);
            
            # Copy-on-Write 处理
            if (is_a_cow_page(flags)) {
                return cow(pte, level, pa, flags);
            }
            return -1;
        }
    } else {
        PAGEFAULT("va is not in the vmas");
        return -1;
    }
    
    return 0;
}
```

**COW 实现**：

```c
int cow(pte_t *pte, const int level, const paddr_t pa, const int flags) {
    void *mem;
    if (level == SUPERPAGE) {
        if ((mem = kmalloc(SUPERPGSIZE)) == 0) return -1;
        memmove(mem, (void *) pa, SUPERPGSIZE);
    } else if (level == COMMONPAGE) {
        if ((mem = kmalloc(PGSIZE)) == 0) return -1;
        memmove(mem, (void *) pa, PGSIZE);
    } else {
        return -1;
    }
    
    *pte = PA2PTE((uint64) mem) | flags | PTE_W;
    kfree((void *) pa);  # 释放原页（引用计数减 1）
    return 0;
}
```

**完整度评估**：85%
- 实现了按需分页（Demand Paging）
- 支持文件映射的缺页加载
- 实现了 Copy-on-Write
- 缺少写时复制的优化（如零页映射）

---

### 3.3 进程/线程管理子系统

#### 3.3.1 PCB/TCB 分离设计

**核心数据结构**：

**进程控制块（PCB）**：`include/proc/pcb_life.h`

```c
struct proc {
    struct spinlock lock;
    char name[30];
    pid_t pid;
    enum procstate state;  # PCB_UNUSED, PCB_USED, PCB_ZOMBIE
    struct tms p_times;
    int exit_stat;
    int killed;
    
    # 内存管理
    struct mm_struct *mm;
    
    # 文件描述符
    struct file *_ofile[NOFILE];  # 128 个
    int max_ofile;
    int cur_ofile;
    struct file_vnode cwd;
    
    # 状态队列
    struct list_head state_list;
    
    # 进程家族关系
    struct proc *parent;
    struct proc *first_child;
    struct list_head sibling_list;
    
    # 线程组
    struct thread_group *tg;
    pid_t ctid;
    
    struct spinlock tlock;
    
    # IPC 命名空间
    struct ipc_namespace *ipc_ns;
    struct sysv_shm sysvshm;
    
    # 资源限制
    struct rlimit rlim[RLIM_NLIMITS];
    
    # 等待通道
    struct semaphore sem_wait_chan_parent;
    struct semaphore sem_wait_chan_self;
    
    # 定时器
    struct timer_list real_timer;
    
    # OOM 评分
    int oom_score_adj;
};
```

**线程控制块（TCB）**：`include/proc/tcb_life.h`

```c
struct tcb {
    spinlock_t lock;
    thread_state_t state;  # TCB_UNUSED, TCB_USED, TCB_RUNNABLE, TCB_RUNNING, TCB_SLEEPING
    struct proc *p;
    
    tid_t tid;
    int tidx;  # 线程在进程内的索引
    
    int exit_status;
    int killed;
    
    struct list_head state_list;
    
    # 信号
    int sigpending;
    struct sighand *sig;
    sigset_t blocked;
    struct sigpending pending;
    struct sigpending shared_pending;
    sig_t sigprocessing;
    
    # 内核栈和上下文
    uint64 kstack;
    struct trapframe *trapframe;
    struct context ctx;
    
    char name[THREAD_NAME_MAXLEN];
    
    struct list_head thread;  # 线程组链表
    
    void *chan;
    struct list_head wait_list;
    struct Queue *wait_chan_entry;
    
    uint64 set_child_tid;
    uint64 clear_child_tid;
    
    uint64 time_out;
    
    uint64 tms_utime;
    uint64 tms_stime;
};
```

**线程组**：

```c
struct thread_group {
    spinlock_t lock;
    tid_t thread_group_id;
    int thread_idx;
    atomic_t thread_cnt;
    struct list_head threads;
    struct tcb *group_leader;
};
```

**设计特点**：
- PCB 和 TCB 分离，支持多进程多线程模型
- 每个进程拥有一个线程组，线程组内共享地址空间和文件描述符
- 使用 `tidx` 索引线程在进程内的位置，用于 trapframe 映射

#### 3.3.2 进程生命周期管理

**文件**：`kernel/src/proc/pcb_life.c`

**进程分配**：

```c
struct proc *alloc_proc(void) {
    struct proc *p;
    p = (struct proc *) Queue_provide_atomic(&unused_p_q, 1);
    if (p == NULL) return 0;
    
    acquire(&p->lock);
    
    p->pid = alloc_pid;
    cnt_pid_inc;
    
    PCB_Q_changeState(p, PCB_USED);
    
    p->first_child = NULL;
    INIT_LIST_HEAD(&p->sibling_list);
    
    # 分配线程组
    if ((p->tg = (struct thread_group *) kalloc()) == 0) {
        free_proc(p);
        release(&p->lock);
        return 0;
    }
    thread_group_init(p->tg);
    
    # 分配 IPC 命名空间
    if ((p->ipc_ns = (struct ipc_namespace *) kalloc()) == 0) {
        free_proc(p);
        release(&p->lock);
        return 0;
    }
    
    shm_init_ns(p->ipc_ns);
    INIT_LIST_HEAD(&p->sysvshm.shm_clist);
    proc_prlimit_init(p);
    
    # 分配内存管理结构
    p->mm = alloc_mm();
    if (p->mm == 0) {
        free_proc(p);
        release(&p->lock);
        return 0;
    }
    INIT_LIST_HEAD(&p->mm->head_vma);
    
    p->real_timer.expires = 0;
    p->real_timer.interval = 0;
    INIT_LIST_HEAD(&p->real_timer.list);
    
    sem_init(&p->sem_wait_chan_parent, 0, "wait_parent");
    sem_init(&p->sem_wait_chan_self, 0, "wait_self");
    
    return p;
}
```

**进程创建**：

```c
struct proc *create_proc() {
    struct tcb *t = NULL;
    struct proc *p = NULL;
    
    if ((p = alloc_proc()) == 0) return 0;
    if ((t = alloc_thread(thread_forkret)) == 0) {
        free_proc(p);
        return 0;
    }
    
    proc_join_thread(p, t, NULL);  # 将线程加入进程
    
    release(&t->lock);
    return p;
}
```

**clone 实现**：

```c
int do_clone(int flags, uint64 stack, pid_t p_tid, uint64 tls, const pid_t *c_tid) {
    struct proc *oldp = proc_current();
    struct tcb *oldt = thread_current();
    
    # 确定克隆类型
    int clone_thread = (flags & CLONE_THREAD) != 0;
    int clone_vm = (flags & CLONE_VM) != 0;
    int clone_files = (flags & CLONE_FILES) != 0;
    
    struct proc *newp;
    struct tcb *newt;
    
    if (clone_thread) {
        # 克隆线程：共享进程
        newp = oldp;
        if ((newt = alloc_thread(thread_forkret)) == 0) return -1;
        proc_join_thread(newp, newt, NULL);
    } else {
        # 克隆进程：创建新进程
        if ((newp = create_proc()) == 0) return -1;
        newt = newp->tg->group_leader;
        
        # 复制地址空间
        if (clone_vm) {
            # 共享地址空间（需要实现页表共享）
            newp->mm = oldp->mm;
        } else {
            # 复制地址空间（COW）
            if (uvm_copy(oldp->mm->pagetable, newp->mm->pagetable) < 0) {
                free_proc(newp);
                return -1;
            }
            vma_copy(oldp->mm, newp->mm);
        }
        
        # 复制文件描述符
        if (clone_files) {
            for (int fd = 0; fd < NOFILE; fd++) {
                if (oldp->_ofile[fd]) {
                    newp->_ofile[fd] = file_dup(oldp->_ofile[fd]);
                }
            }
        }
        
        # 设置父子关系
        newp->parent = oldp;
        appendChild(oldp, newp);
    }
    
    # 复制 trapframe
    memmove(newt->trapframe, oldt->trapframe, PGSIZE);
    newt->trapframe->a0 = 0;  # 子进程返回 0
    
    if (stack != 0) {
        newt->trapframe->sp = stack;
    }
    
    # 处理 CLONE_CHILD_SETTID 和 CLONE_CHILD_CLEARTID
    if (flags & CLONE_CHILD_SETTID) {
        newt->set_child_tid = c_tid;
    }
    if (flags & CLONE_CHILD_CLEARTID) {
        newt->clear_child_tid = c_tid;
    }
    
    TCB_Q_changeState(newt, TCB_RUNNABLE);
    release(&newt->lock);
    
    if (!clone_thread) {
        release(&newp->lock);
    }
    
    return newp->pid;
}
```

**exit 实现**：

```c
void do_exit(int status) {
    struct proc *p = proc_current();
    struct tcb *t = thread_current();
    
    # 关闭所有打开的文件
    for (int fd = 0; fd < NOFILE; fd++) {
        if (p->_ofile[fd]) {
            generic_fileclose(p->_ofile[fd]);
            p->_ofile[fd] = 0;
        }
    }
    
    # 释放所有线程
    struct tcb *t_cur, *t_tmp;
    acquire(&p->tg->lock);
    list_for_each_entry_safe(t_cur, t_tmp, &p->tg->threads, thread) {
        if (t_cur != t) {
            list_del(&t_cur->thread);
            free_thread(t_cur);
        }
    }
    release(&p->tg->lock);
    
    # 将子进程重新父化给 init
    re_parent(p);
    
    # 设置退出状态
    p->exit_stat = status;
    PCB_Q_changeState(p, PCB_ZOMBIE);
    
    # 唤醒等待的父进程
    sem_v(&p->parent->sem_wait_chan_parent);
    
    # 释放线程
    free_thread(t);
    
    # 调度
    thread_sched();
}
```

**waitpid 实现**：

```c
int waitpid(pid_t pid, uint64 status, int options) {
    struct proc *p = proc_current();
    struct proc *child;
    int havekids;
    
    for (;;) {
        havekids = 0;
        
        # 遍历所有子进程
        struct proc *child_cur = p->first_child;
        while (child_cur != NULL) {
            acquire(&child_cur->lock);
            
            if (pid == -1 || child_cur->pid == pid) {
                havekids = 1;
                
                if (child_cur->state == PCB_ZOMBIE) {
                    # 找到僵尸进程
                    int cpid = child_cur->pid;
                    if (status != 0) {
                        copy_out(p->mm->pagetable, status, (char *)&child_cur->exit_stat, sizeof(int));
                    }
                    
                    # 从家族树中移除
                    deleteChild(p, child_cur);
                    free_proc(child_cur);
                    release(&child_cur->lock);
                    return cpid;
                }
            }
            
            release(&child_cur->lock);
            child_cur = nextsibling(child_cur);
        }
        
        if (!havekids || proc_is_killed(p)) {
            return -1;
        }
        
        # 等待子进程状态变化
        if (options & WNOHANG) {
            return 0;
        }
        
        sem_p(&p->sem_wait_chan_parent);
    }
}
```

**完整度评估**：90%
- 实现了完整的进程/线程生命周期管理
- 支持 clone 系统调用（线程和进程创建）
- 实现了进程家族关系管理（父子、兄弟）
- 支持 waitpid 的多种选项（WNOHANG 等）
- 缺少进程组