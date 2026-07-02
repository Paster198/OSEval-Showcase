# uuOS 内核项目深度技术分析报告

## 一、分析过程说明

本报告基于对仓库源代码的逐文件阅读、构建尝试以及对 QEMU 模拟运行路径的分析。具体分析工作包括：

1. 阅读并分析竞赛内核部分全部 12 个 C 源文件、6 个头文件、6 个架构汇编/链接脚本文件，总计约 4,648 行
2. 尝试使用 `riscv64-linux-gnu-gcc` 工具链构建 RISC-V 版本内核（LoongArch 交叉编译器不可用，未构建）
3. 对构建过程中发现的编译错误进行了诊断和记录
4. 对 STM32 安全 RTOS 部分进行了概要审阅

---

## 二、构建测试结果

### 2.1 RISC-V 构建

使用环境提供的 `riscv64-linux-gnu-gcc` (GCC 13) 和 `riscv64-linux-gnu-ld` (Binutils 2.42) 进行构建。

**构建过程中发现并需要修复的问题：**

| # | 问题 | 位置 | 严重程度 |
|---|------|------|---------|
| 1 | `virtio_blk.c:297` 重复定义局部变量 `data_buf` | `src/kernel/virtio_blk.c` | 编译错误 |
| 2 | 缺少 `_zicsr` 扩展：CSR 指令（如 `csrr`、`csrw`）在 `rv64imac` 中不被默认包含 | `Makefile` 编译选项 | 编译错误 |
| 3 | `OUTPUT_ARCH("riscv64")` 不被 `riscv64-linux-gnu-ld` 识别 | `src/arch/riscv/linker.lds` | 链接错误 |
| 4 | `entry.S` 与 `trap_entry.S` 重复定义全局符号 `trap_vector` | 架构汇编文件 | 链接错误 |

修复后成功生成 `kernel-rv` ELF 可执行文件，大小为 30,328 字节。

**编译警告：**

| 文件 | 警告内容 |
|------|---------|
| `ext4.c:333` | 未使用变量 `max_entries` |
| `elf_loader.c:201` | 未使用变量 `page_file_offset` |
| `elf_loader.c:163` | 未使用变量 `mem_size` |
| `elf_loader.c:101` | 未使用参数 `load_base` |
| `elf_loader.c:261` | 函数 `file_read_cb` 已定义但从未使用 |

这些警告表明 ELF 加载器中存在未清理的遗留代码路径（基于回调的流式加载方案被废弃，改为先全部读入内存再解析）。

### 2.2 LoongArch 构建

LoongArch 交叉编译器 (`loongarch64-linux-gnu-gcc`) 在当前环境中不可用，因此未能构建 `kernel-la`。从代码分析来看，LoongArch 版本的 `enter_user_process` 和 `map_page` 仅为返回 0 或打印"暂未实现"的空壳桩函数。

---

## 三、子系统实现清单

竞赛内核部分包含以下子系统，按功能层次自底向上排列：

| 层次 | 子系统 | 核心文件 | 代码量 | 实现状态 |
|------|--------|---------|--------|---------|
| 硬件抽象 | 平台抽象层 (SBI/关机) | `sbi.c`, `sbi.h` | ~170 行 | RISC-V 完整，LoongArch 基本可用 |
| 硬件抽象 | UART 控制台 | `uart.c`, `uart.h`, `printf.c`, `printf.h` | ~365 行 | 双架构完整 |
| 硬件抽象 | virtio-blk 块设备驱动 | `virtio_blk.c`, `virtio_blk.h` | ~430 行 | 仅 RISC-V (MMIO) |
| 基础库 | 字符串/内存操作 | `string.c`, `string.h` | ~165 行 | 完整 |
| 基础库 | 类型定义 | `types.h` | ~66 行 | 完整 |
| 内存管理 | 物理内存分配器 | `alloc.c`, `alloc.h` | ~220 行 | 完整 |
| 存储 | EXT4 只读文件系统 | `ext4.c`, `ext4.h` | ~812 行 | 基本完整 |
| 进程管理 | 进程抽象 + Sv39 页表 | `proc.c`, `proc.h` | ~425 行 | RISC-V 完整，LoongArch 桩 |
| 系统调用 | ecall 分发 + 7 个 syscall | `syscall.c`, `syscall.h` | ~260 行 | 基本可用 |
| 程序加载 | ELF64 加载器 | `elf_loader.c`, `elf_loader.h` | ~400 行 | 基本完整 |
| 测试框架 | 脚本扫描 + ELF 测试执行 | `test_runner.c`, `test_runner.h` | ~330 行 | 完整 |
| 架构相关 | RISC-V 入口/陷阱/链接 | `arch/riscv/*` | ~454 行 | 完整 |
| 架构相关 | LoongArch 入口/陷阱/链接 | `arch/loongarch/*` | ~394 行 | 部分可用 |

---

## 四、各子系统实现细节详细拆解

### 4.1 启动与引导序列

**RISC-V 入口** (`src/arch/riscv/entry.S`)：

1. OpenSBI 以 S-mode 跳转到 `_start`（地址 `0x80200000`），`a1` 寄存器保存设备树指针
2. 保存 DTB 地址到全局变量 `dtb_addr`
3. 设置内核栈指针为 `kernel_stack_top`（64KB BSS 区域）
4. 将 `stvec` CSR 设置为 `trap_vector` 地址
5. 启用 S-mode 软件中断（`sie` CSR）
6. 清零 BSS 段（`_bss_start` 到 `_bss_end`）
7. `jal kernel_main` 跳转到 C 入口
8. 若 `kernel_main` 返回，调用 `kernel_shutdown`

**C 主函数初始化序列** (`src/kernel/main.c` -> `kernel_main()`)：

```
阶段 0: early_boot_msg (SBI 控制台输出字符)
阶段 1: console_init() -> uart_init() (ns16550)
         输出启动横幅
         alloc_init() (8MB 静态堆)
阶段 2: virtio_blk_init() (扫描 MMIO 区域)
         选择第一个设备作为测试磁盘
阶段 3: ext4_mount() (读取超级块，验证魔数 0xEF53)
阶段 4: proc_init() + syscall_init()
         初始化物理页分配器、进程表
阶段 5: test_runner_init()
阶段 6: 列出根目录内容 (ext4_readdir on inode 2)
阶段 7: test_runner_discover() 扫描 *_testcode.sh
         若无脚本则扫描 .elf 文件直接加载
阶段 8: test_runner_run_all() 执行测试
阶段 9: kernel_shutdown() (SBI SRST)
```

**LoongArch 入口** (`src/arch/loongarch/entry.S`) 流程类似但使用 LoongArch 专用指令：`la.local`、`st.d`/`ld.d`、`csrwr`、`ertn` 等，内核加载地址为 `0x90000000`。

### 4.2 控制台 I/O 子系统

#### UART 驱动 (`src/kernel/uart.c`)

基于 **NS16550A** 兼容 UART 的 MMIO 驱动：

- 寄存器通过 `volatile uint8_t*` 直接访问
- 基地址：RISC-V 为 `0x10000000`，LoongArch 为 `0x1fe001e0`
- 初始化序列：禁用中断 → 设置 DLAB → 配置波特率分频器 (1) → 8N1 格式 → 启用/清空 FIFO
- `uart_putc()`：忙等 `LSR_TX_EMPTY` 位后写 `THR`
- `uart_getc()`：忙等 `LSR_RX_READY` 位后读 `RBR`

**特点**：所有 I/O 均为忙等轮询，无中断驱动。寄存器定义完整（10 个寄存器偏移 + LSR/FCR/LCR 位掩码）。

#### printf 实现 (`src/kernel/printf.c`)

完全自包含的 printf 实现，不依赖 libc：

- `vsnprintf_core()` 核心引擎：支持双模式输出（回调函数 或 缓冲区写入）
- 格式说明符支持：`%s`、`%c`、`%d`/`%i`、`%u`、`%x`、`%p`、`%%`
- 标志支持：`0`（零填充）、宽度、`l`/`ll` 长度修饰符、`z`（size_t）
- `printf()` 通过回调 `out_char` 逐个字符输出到 UART
- `putchar()` 自动在 `\n` 前插入 `\r`

### 4.3 内存管理子系统

#### 物理内存分配器 (`src/kernel/alloc.c`)

基于**边界标记 (boundary-tag)** 算法的显式空闲链表分配器：

- **静态堆**：`uint8_t heap_area[8 * 1024 * 1024]`，编译时预分配的 8MB 数组
- **块头部** (`block_t`)：包含 `size`（bit0 = 分配标志）、`next`、`prev` 指针
- **空闲链表**：双向链表，按地址顺序维护，采用首次适配 (first-fit) 策略
- **分裂策略**：当剩余空间 ≥ `BLOCK_MIN_SIZE`（32 字节）时分裂
- **合并策略**：释放时尝试向后合并（向前合并注释中声明跳过，因无法确定前一块大小，这是经典边界标记方案的缺陷）
- **对齐**：16 字节对齐（`BLOCK_ALIGN`），头部大小向上对齐到 16 字节
- **API**：`kmalloc`/`kfree`/`kcalloc`/`krealloc` + 页级包装 `alloc_page`/`free_page`/`alloc_pages`/`free_pages`

**关键代码片段**（首次适配搜索）：

```c
block_t *b = free_list;
while (b) {
    if (IS_FREE(b) && GET_SIZE(b) >= need) {
        remove_free(b);
        if (GET_SIZE(b) >= need + BLOCK_MIN_SIZE) {
            // 分裂
            size_t old_size = GET_SIZE(b);
            b->size = need;
            SET_USED(b);
            block_t *newb = NEXT_BLOCK(b);
            newb->size = old_size - need;
            insert_free(newb);
        } else {
            SET_USED(b);
        }
        return BLOCK_TO_DATA(b);
    }
    b = b->next;
}
```

**局限性**：
- 向前合并未实现（注释中声明跳过），长期运行会产生外部碎片
- 无内存保护/越界检测
- 静态 8MB 堆上限硬编码，无动态扩展能力

#### 物理页分配器 (`src/kernel/proc.c`)

页表分配使用独立的简单 bump 分配器：

```c
static uint8_t *next_free_page = NULL;

void paging_init(void) {
    next_free_page = (uint8_t *)ALIGN_UP((uintptr_t)&_kernel_end, PAGE_SIZE);
}

uintptr_t alloc_page_table(void) {
    uint8_t *page = next_free_page;
    next_free_page += PAGE_SIZE;
    memset(page, 0, PAGE_SIZE);
    return (uintptr_t)page;
}
```

- 从内核 BSS 段末尾线性增长
- 不释放（纯 bump 分配器）
- 与内核堆 (`heap_area`) 可能重叠——两者均从 `_kernel_end` 之后开始分配，存在冲突风险（`heap_area` 是静态 8MB 数组，`next_free_page` 从 `_kernel_end` 开始，如果 8MB 堆与 bump 分配器区域重叠，将导致数据损坏）

### 4.4 块设备驱动子系统

#### virtio-blk MMIO 驱动 (`src/kernel/virtio_blk.c`)

实现 virtio 传统 (legacy) MMIO 传输接口的块设备驱动：

**设备初始化流程**（遵循 virtio spec v1.0 legacy 章节）：

1. 扫描 MMIO 区域 `0x10001000`-`0x10008000`（8 个槽位，步长 `0x1000`）
2. 读取 Magic Value 寄存器，验证 `0x74726976`（"virt"）
3. 验证 Device ID = 2（块设备）
4. 设备初始化序列：Reset → ACKNOWLEDGE → DRIVER → 特性协商（跳过）→ FEATURES_OK → 队列配置 → DRIVER_OK
5. 分配并配置 virtqueue（描述符表 + available ring + used ring）
6. 分配 8KB IO 缓冲区
7. 读取设备容量（配置空间偏移 0x100，64 位分两次读取）

**IO 请求流程** (`virtio_blk_do_request`)：

使用 3 个描述符的链式请求：
- 描述符 0：请求头（读/写 + 扇区号），设备读取
- 描述符 1：数据缓冲区，读操作设备写入（`VIRTQ_DESC_F_WRITE`），写操作设备读取
- 描述符 2：状态字节（1 字节），设备写入

同步等待通过忙等 used ring 的 `idx` 变化实现：

```c
while (used->idx == used_idx) {
    __asm__ __volatile__("fence r,r" ::: "memory");
}
```

**已发现 Bug**：`data_buf` 变量在第 283 行和第 297 行被重复定义，导致编译错误。第 297 行是遗留的死代码。

**局限性**：仅支持 RISC-V MMIO 传输。LoongArch 使用 PCI virtio，当前完全未实现（`types.h` 注释提及但无对应代码）。驱动仅支持单队列（queue 0），无中断，使用忙等轮询。

### 4.5 文件系统子系统

#### EXT4 只读实现 (`src/kernel/ext4.c`)

这是一个约 730 行的 EXT4 只读文件系统实现，支持从 EXT4 格式磁盘读取文件和遍历目录。

**支持的 EXT4 特性**：

| 特性 | 支持状态 | 说明 |
|------|---------|------|
| 超级块解析 | 完整 | 支持 64 位块计数、灵活块组大小 |
| 块组描述符 | 完整 | 支持 32 字节和 64 字节两种格式 |
| Inode 读取 | 完整 | 支持动态 inode 大小（≥128 字节） |
| 区段树 (extent tree) | 完整 | 支持任意深度的区段树遍历 |
| 目录遍历 | 完整 | 支持可变长度目录项 |
| 文件读取 | 完整 | 带单块缓存 |
| 直接/间接块映射 | **不支持** | 仅支持 ext4 区段树，回退到间接块的代码为桩 |
| 写操作 | **不支持** | 只读实现 |
| 符号链接 | **不支持** | 类型常量已定义但未实现解析 |
| 日志 (journal) | **不支持** | 无日志回放 |

**区段树遍历算法**（核心代码）：

```c
// 从根节点开始，逐层向下遍历
while (depth > 0) {
    // 在索引节点中二分查找合适的子节点
    for (int i = entries - 1; i >= 0; i--) {
        if (le32(idx[i].ei_block) <= logical_block) {
            uint64_t child_block = le32(idx[i].ei_leaf_lo) |
                                  ((uint64_t)le32(idx[i].ei_leaf_hi) << 32);
            read_block(fs, child_block, node_buf);
            found = 1;
            break;
        }
    }
    depth--;
}
// 在叶节点中查找物理块
for (int i = 0; i < entries; i++) {
    if (logical_block >= ee_block && logical_block < ee_block + ee_len) {
        *physical_block = block_start + (logical_block - ee_block);
        return 0;
    }
}
```

**目录遍历**：按 `rec_len` 步进遍历目录块中的变长目录项，跳过已删除项（`inode == 0`）。

**文件读取缓存**：
- 每个打开文件维护一个块缓存（`cache_block` + `cache_block_no`）
- 单块 LRU 策略：仅在请求的块与缓存块不同时才发起磁盘读取
- 不支持预读

**超级块验证**：

```c
if (le16(sb->s_magic) != EXT4_SUPER_MAGIC)    // 0xEF53
```

**重要说明**：RISC-V 和 LoongArch 均为小端架构，`le16`/`le32`/`le64` 函数直接返回原值（恒等映射），这一点正确但若未来移植到大端平台需要重写。

### 4.6 进程管理子系统

#### 进程控制块 (`src/kernel/proc.h`)

```c
typedef struct process {
    int      pid;
    int      state;              // FREE/READY/RUNNING/ZOMBIE
    uintptr_t page_table;        // 页表根物理地址
    uintptr_t entry_point;
    uintptr_t user_stack;        // 固定 USER_STACK_TOP = 0x80000000
    uint64_t  exit_code;
    void     *trap_frame;
    int      fd_table[16];       // ext4 文件描述符映射
} process_t;
```

- 最多 16 个进程（`MAX_PROCS`）
- 全局进程表 `g_proc_table[16]`
- 调度为**协作式**：一次只运行一个进程，`enter_user_process()` 阻塞直到进程退出
- 进程状态：FREE → READY → RUNNING → ZOMBIE → FREE（无 READY→RUNNING 调度器）

#### Sv39 页表操作（仅 RISC-V）

**三级页表映射** (`map_page`)：

```c
int map_page(uintptr_t root_ppn, uintptr_t vaddr,
             uintptr_t paddr, uint64_t flags) {
    uint64_t *l2 = (uint64_t *)root_ppn;
    int i2 = VPN2(vaddr);  // bits 38:30
    int i1 = VPN1(vaddr);  // bits 29:21
    int i0 = VPN0(vaddr);  // bits 20:12

    if (!(l2[i2] & PTE_V)) {
        uintptr_t l1_page = alloc_page_table();
        l2[i2] = make_pte(l1_page, PTE_V);
    }
    l1 = (uint64_t *)pte_to_ppn(l2[i2]);

    if (!(l1[i1] & PTE_V)) {
        uintptr_t l0_page = alloc_page_table();
        l1[i1] = make_pte(l0_page, PTE_V);
    }
    l0 = (uint64_t *)pte_to_ppn(l1[i1]);

    l0[i0] = make_pte(paddr, flags);
    sfence.vma  // 单地址 TLB 刷新
}
```

支持的用户态 PTE 标志组合：
- `PTE_USER_RW`：`V | R | W | U | A | D`
- `PTE_USER_RX`：`V | R | X | U | A`
- `PTE_USER_RWX`：`V | R | W | X | U | A | D`

**用户态进入机制** (`_enter_user_trampoline`，`src/arch/riscv/trap_entry.S`)：

1. 在 `ctx` 中保存内核 `ra` 和 `sp`
2. 保存恢复点 (label `1`) 到全局变量 `g_kernel_return_ra`/`g_kernel_return_sp`
3. 写入 `satp` 切换到用户页表 + `sfence.vma`
4. 将内核 `sp` 存入 `sscratch`（供 trap 入口时交换使用）
5. 设置 `sstatus.SUM = 1`（允许 S-mode 访问用户页）
6. `sepc = entry`，切换到用户栈，`sret` 进入 U-mode

**用户态退出机制**（通过 `sys_exit`）：

1. `sys_exit` 恢复内核页表（从 `ctx->satp` 重建）
2. 设置 `g_return_to_kernel = 1`
3. trap 返回路径检测该标志 → 走 `return_to_kernel` 分支
4. 从 `g_kernel_return_sp` 恢复内核栈
5. 设置 `sepc = g_kernel_return_ra`（回到 trampoline 的 label `1`）
6. `sret` 回到 trampoline → 恢复 `ra` → `ret` 回到 `enter_user_process()` 调用者

**LoongArch 状态**：`enter_user_process`、`map_page` 等函数为桩实现（返回常量或打印"暂未实现"），用户态进程支持完全不可用。

### 4.7 系统调用子系统

#### 系统调用分发 (`src/kernel/syscall.c`)

使用 RISC-V Linux syscall 编号：

| syscall | 编号 | 实现状态 | 说明 |
|---------|------|---------|------|
| `SYS_write` | 64 | **完整** | 向 stdout/stderr 输出字符串（逐字符 putchar），不支持文件写入 |
| `SYS_read` | 63 | **部分** | stdin 返回 0；支持从已打开的 ext4 fd 读取 |
| `SYS_openat` | 56 | **部分** | 仅从根目录查找文件，忽略 dirfd/flags/mode。存在用户态地址转换问题（见下文） |
| `SYS_close` | 57 | **完整** | 关闭 ext4 fd 并清理进程 fd 表 |
| `SYS_exit` | 93 | **完整** | 设置退出码 → 切换回内核页表 → 触发返回内核路径 |
| `SYS_brk` | 214 | **桩** | 始终返回 0 |
| `SYS_fstat` | 80 | **桩** | 清零 144 字节 statbuf，始终返回 0 |
| `SYS_getdents64` | 61 | **桩** | 始终返回 0（表示无更多目录项） |

**Trap 分发流程**：

```c
void trap_handler(trap_frame_t *frame) {
    uint64_t scause = frame->scause;
    if (is_interrupt) return;  // 忽略中断
    switch (cause_code) {
    case SCAUSE_ECALL_U:  // 8: User-mode ecall
        switch (frame->a7) {
        case SYS_write: ...
        case SYS_exit: sys_exit(); return;  // 特殊：不修改 sepc
        }
        frame->a0 = ret;
        frame->sepc += 4;  // 跳过 ecall 指令
    }
}
```

**`sys_openat` 的地址转换问题**：

```c
uintptr_t phys_addr = walk_page(g_current_proc->page_table, (uintptr_t)pathname);
if (!phys_addr) {
    phys_addr = (uintptr_t)pathname;  // 回退：内核直接访问
}
```

这里存在严重问题：`walk_page` 返回的是物理地址，但内核运行在启用 MMU 的环境下，代码中直接将该物理地址作为指针解引用（`const char *path = (const char *)phys_addr`）。在全映射的内核空间（identity mapping）中这恰好能工作，但如果内核页表与用户页表不是 identity 映射关系，就会访问错误地址。当前因内核使用 OpenSBI 设置的 identity mapping，此缺陷尚未暴露。

### 4.8 ELF 加载器子系统

#### ELF64 程序加载 (`src/kernel/elf_loader.c`)

**加载流程**：

1. 从 EXT4 读取完整 ELF 文件到内核堆内存
2. 验证 ELF 魔数 (`0x7F 'E' 'L' 'F'`)、64 位类别、小端编码
3. 分配根页表（`alloc_page_table()`）
4. 遍历程序头，处理 `PT_LOAD` 段：
   - 按页对齐后逐页分配物理页
   - 建立 Sv39 映射（根据 `p_flags` 设置 PTE 权限）
   - 将文件数据复制到物理页（`memcpy` 逐字节）
   - `.bss` 区域（`memsz > filesz`）因 `memset(phys_page, 0, PAGE_SIZE)` 而自动清零
5. 调用 `elf_setup_stack()` 分配 256KB 用户栈（`0x80000000 - 256KB` 到 `0x80000000`）
6. 返回入口点（`ehdr->e_entry`）和页表根

**遗留代码**：`elf_load_internal` 接受 `read_fn` 回调参数用于流式加载，但所有调用点均传入 `NULL`，改为先完整读取 ELF 文件到内存。`file_read_cb` 函数是此遗留路径的残余，从未被调用。

**用户栈设置** (`elf_setup_stack`)：

```c
for (uintptr_t va = stack_top - USER_STACK_SIZE; va < stack_top; va += PAGE_SIZE) {
    uint8_t *phys_page = alloc_page();
    map_page(page_table_root, va, (uintptr_t)phys_page, PTE_USER_RW);
}
```

栈顶预留但未向栈中写入 `argc`/`argv`/`envp`（参数均被忽略）。

### 4.9 测试运行器子系统

#### 测试框架 (`src/kernel/test_runner.c`)

基于磁盘上的 shell 脚本风格测试定义：

**测试发现** (`test_runner_discover`)：
- 遍历根目录（inode 2）
- 匹配 `*_testcode.sh` 文件
- 调用 `parse_script()` 解析

**脚本解析** (`parse_script`)：
- 读取整个 .sh 文件到内存（最大 64KB）
- 按行分割，跳过空行和 `#` 注释
- 从每行提取 ".elf" 引用作为测试命令
- 从文件名提取测试组名（`basic_testcode.sh` → `basic`）

**测试执行** (`run_elf_test`)：
1. 在根目录查找 ELF 文件
2. 调用 `elf_load()` 加载到用户空间
3. `proc_create()` 创建进程
4. `enter_user_process()` 进入用户态执行
5. 等待进程退出并获取退出码
6. `proc_destroy()` 清理

**输出格式**：使用 `#### OS COMP TEST GROUP START/END <name> ####` 标记包裹每个测试组，这是面向自动化评测系统的标准化输出。

### 4.10 平台抽象层

#### SBI 接口 (`src/kernel/sbi.h`, `src/kernel/sbi.c`)

**RISC-V 部分**：
- `sbi_ecall()`：封装 ecall 内联汇编，支持 8 个参数（a0-a7），返回 a0/a1
- `sbi_console_putchar()`：通过 DBCN 扩展输出早期调试字符
- `sbi_shutdown()`：通过 SRST 扩展触发系统关机
- `sbi_set_timer()`：通过 TIME 扩展设置定时器（未在代码中使用）

**LoongArch 部分**：
- `la_shutdown()`：尝试三种关机方式：GPIO magic address (`0x10000000 = 0x5555`)、semihosting (`break 0`)、最终 fallback 到 `idle 0` 死循环
- `la_early_putchar()`：直接写 UART MMIO（等待 `LSR_TX_EMPTY`）

**kernel_shutdown()**：统一关机函数，先输出 `#### OS COMP: SHUTDOWN ####` 标记再调用平台关机。

### 4.11 架构相关汇编

#### RISC-V trap 入口 (`src/arch/riscv/trap_entry.S`)

主 trap 向量 `trap_vector`：

1. `csrrw sp, sscratch, sp` — 原子交换：用户 sp → sscratch，内核 sp → sp
2. 分配 272 字节 trap 帧
3. 保存全部 32 个通用寄存器 + `scause`/`sepc`/`stval`
4. 调用 C 函数 `trap_handler(trap_frame_t *frame)`
5. 检查 `g_return_to_kernel` 标志决定返回路径：
   - **返回用户态**：恢复寄存器 → 从 trap 帧恢复用户 sp → 将内核 sp 放回 sscratch → `sret`
   - **返回内核态**：从 `g_kernel_return_sp` 恢复 sp → 设置 `sepc` 为恢复点 → `sret`

**一个注意点**：t0 寄存器在交换 sp 时被覆盖，其用户态值丢失。代码显式地在 trap 帧中保存 `zero` 作为 t0 占位（第 32(sp) 偏移处），但文档注释写的是"caller-saved, 可接受"。

#### LoongArch trap 入口 (`src/arch/loongarch/trap_entry.S`)

CSR 编号使用硬编码（如 `0x0`=CRMD、`0x6`=ERA、`0x7`=BADV、`0x19`=PGDL、`0x30`=暂用作 sscratch 等效），注释中标注"待验证"。整个 LoongArch 用户态支持处于实验阶段。

---

## 五、OS 内核各部分的交互

### 5.1 内核启动交互图

```
OpenSBI (M-mode)
    │
    └─[sret]──> _start (entry.S)
                    │
                    ├─ 设置 stvec = trap_vector
                    ├─ 清零 BSS
                    └─[jal]──> kernel_main()
                                    │
                                    ├─ console_init() ──> uart_init()
                                    ├─ alloc_init()     ──> 初始化静态堆
                                    ├─ virtio_blk_init()──> 扫描 MMIO 设备
                                    ├─ ext4_mount()    ──> 读取超级块, 验证
                                    ├─ proc_init()     ──> 设置物理页 bump 分配器
                                    ├─ syscall_init()
                                    ├─ test_runner_init()
                                    ├─ test_runner_discover() ──> 扫描 .sh 脚本
                                    ├─ test_runner_run_all()
                                    │       │
                                    │       └─[每个 ELF]──> elf_load()
                                    │           ├─ ext4_open/read ──> 读 ELF 文件
                                    │           ├─ alloc_page_table() ──> bump 分配
                                    │           ├─ alloc_page() ──> kmalloc (堆)
                                    │           └─ map_page() ──> 构建 Sv39 页表
                                    │       └─ proc_create()
                                    │       └─ enter_user_process()
                                    │           └─ _enter_user_trampoline() ──> sret
                                    │                   │
                                    │       [用户态 ELF 运行]
                                    │       ecall ──> trap_vector ──> trap_handler
                                    │           │                        │
                                    │           │                    sys_exit()
                                    │           │                        │
                                    │           │              g_return_to_kernel=1
                                    │           │                        │
                                    │           └── return_to_kernel ────┘
                                    │                   │
                                    │           _enter_user_trampoline 恢复点
                                    │                   │
                                    │           enter_user_process() 返回退出码
                                    │
                                    └─ kernel_shutdown() ──> sbi_shutdown()
```

### 5.2 关键数据流

**文件读取路径**：
```
test_runner
  → elf_load(fs, inode)
    → ext4_open(fs, inode)
      → read_inode(fs, inode)
        → get_inode_table_block()
          → read_gdt()
            → read_block()
              → virtio_blk_read(dev, sector, buf, num_sectors)
                → virtio_blk_do_request()  // 构建 virtqueue 请求
    → ext4_read(fs, fd, buf, len)
      → file_map_block() → extent_map_logical_to_physical()
      → read_block() → virtio_blk_read()
```

**用户态输出路径**：
```
用户 ELF: write(1, "hello", 5) → ecall
  → trap_vector (汇编)
    → trap_handler (C)
      → sys_write(1, "hello", 5)
        → putchar('h') → uart_putc('h') → MMIO 写 0x10000000
```

---

## 六、OS 内核实现完整度评估

### 6.1 整体评估

以"能够在 QEMU 上启动、挂载 EXT4 磁盘、加载并运行用户态 ELF 程序"作为基线目标，对各维度评分：

| 维度 | 完整度 | 评分依据 |
|------|--------|---------|
| 启动引导 | 85% | RISC-V 完整；LoongArch 入口完整但用户态为桩 |
| 控制台 I/O | 90% | printf 功能完善；缺输入支持、中断驱动 |
| 内存管理 | 60% | 物理分配器基本可用；缺向前合并；页表分配与堆可能重叠；无虚拟内存管理（缺按需分页、写时复制） |
| 块设备驱动 | 70% | RISC-V virtio-blk MMIO 可用；LoongArch PCI 未实现；仅支持单队列轮询 |
| 文件系统 | 65% | EXT4 只读基本可用；支持区段树；缺间接块、符号链接、写操作、日志 |
| 进程管理 | 50% | RISC-V Sv39 可用；无调度器（协作式）；LoongArch 完全为桩；缺多进程并发 |
| 系统调用 | 35% | 7 个 syscall 中 4 个桩；缺 fork/exec/wait 等核心调用；地址转换有缺陷 |
| ELF 加载 | 70% | 基本可加载静态 ELF；缺动态链接、重定位；遗留代码未清理 |
| 测试框架 | 75% | 脚本发现和测试执行完整；依赖特定文件名格式 |
| 双架构支持 | 40% | RISC-V 较完整；LoongArch 大量桩代码 |

**加权综合完整度：约 58%**（以 RISC-V 为主要评估目标）

### 6.2 重大缺失项

1. **无调度器**：进程模型是"运行一个，等待退出"的协作式模型，无时间片、无抢占、无上下文切换
2. **LoongArch 用户态完全不可用**：`enter_user_process`/`map_page` 为桩
3. **无中断处理**：所有 I/O 均为忙等轮询，trap_handler 显式忽略中断
4. **无 fork/exec**：无法从用户态创建新进程
5. **sys_openat 地址转换缺陷**：用户态指针直接当物理地址使用
6. **物理页与堆内存区域可能重叠**

---

## 七、设计创新性分析

### 7.1 创新点

| 创新点 | 具体体现 | 创新程度 |
|--------|---------|---------|
| **双架构宏内核框架** | 统一的平台无关内核代码（`src/kernel/`）+ 架构相关目录（`arch/riscv/`、`arch/loongarch/`），通过条件编译和独立的汇编入口/陷阱文件实现双架构支持 | 中等。双架构设计本身是成熟模式，但在此规模的内核中实现较为完整 |
| **trampoline 用户态进出机制** | `_enter_user_trampoline` + `g_return_to_kernel` 标志 + `sscratch` 交换的组合设计，实现了从内核态进入用户态并阻塞等待退出的语义，类似于简化版的 `setjmp`/`longjmp` 跨特权级实现 | 中等。该机制在不引入完整调度器的前提下实现了基本的用户态隔离执行 |
| **脚本驱动的测试框架** | 通过解析磁盘上的 `*_testcode.sh` 文件自动发现和串行执行 ELF 测试用例，输出标准化的评测标记 | 低-中等。测试框架设计实用但技术深度有限 |
| **EXT4 区段树遍历** | 在不到 200 行的辅助函数中实现了完整的 ext4 extent tree 遍历（包括多级索引节点和叶节点查找） | 中等。在紧凑实现中支持任意深度区段树遍历有一定技术含量 |

### 7.2 设计局限

1. **协作式而非抢占式**：`enter_user_process` 阻塞等待进程退出，这意味着一次只能运行一个用户进程
2. **地址空间布局固定**：用户栈固定在 `0x80000000`，加载基址固定在 `0x10000`，无 ASLR
3. **静态堆 8MB 硬编码**：无动态扩展能力

---

## 八、STM32 安全 RTOS 部分概要

该部分与竞赛内核在代码层面完全独立，基于 ARM Cortex-M3 + MPU：

| 子系统 | 核心文件 | 功能 |
|--------|---------|------|
| 安全核心 | `sec_core.c/h` | HMAC-SHA256 挑战-应答、AES-256 加密、6 态状态机、自毁逻辑 |
| 密码算法 | `aes_sw.c/h` | AES-256 软件实现 |
| 通信协议 | `ch340_comm.c/h`, `usb_hid.c/h` | 帧协议串行通信、USB HID 协议栈 |
| 系统调用 | `syscall.h` | ARM SVC 指令封装，包含握手指令等 5 个协议命令 |
| 状态指示 | `rgb_led.c/h` | 物理 LED 状态指示 |
| 测试框架 | `Tests/` | 裸机测试（LED 信号），含 51 个测试用例 |
| 上位机工具 | `exe/` | Windows 端 MasterTask/MasterRecover/Agent 程序 |

该部分设计文档中描述了精心设计的安全协议（HMAC 挑战-应答握手、会话密钥派生、单向状态机铁闸），但竞赛内核部分完全没有继承这些安全特性。

---

## 九、其它发现

### 9.1 代码质量问题

1. **重复变量定义**：`virtio_blk.c:283,297` — 两处定义同名局部变量 `data_buf`
2. **未使用函数**：`elf_loader.c` 中 `file_read_cb` (44 行) 从未被调用
3. **未使用变量**：`ext4.c` 中 `max_entries`、`elf_loader.c` 中 `page_file_offset`、`mem_size`、`load_base`
4. **重复符号**：`entry.S` 和 `trap_entry.S` 均定义全局 `trap_vector`（构建时需删除其一）
5. **内存布局冲突风险**：`heap_area[8MB]`（BSS 段内）与 `next_free_page` bump 分配器可能重叠

### 9.2 项目结构问题

1. **双目标项目混杂**：STM32 安全 RTOS 与竞赛内核共享仓库但无代码复用，文档混用（README 完全针对 STM32 安全产品，与竞赛内核无关）
2. **Makefile 兼容性**：`-march=rv64imac` 不含 `_zicsr` 扩展，与较新工具链不兼容；`OUTPUT_ARCH("riscv64")` 不被 Linux-targeted 链接器识别
3. **LoongArch 为二等公民**：大量桩代码、CSR 编号待验证、用户态完全不可用

### 9.3 内核类型判定

竞赛内核应归类为**协作式宏内核雏形**：
- 所有驱动、文件系统、进程管理均编译在同一内核镜像中（宏内核特征）
- 具备地址空间隔离（Sv39 + U-mode）（现代宏内核特征）
- 但缺少抢占式调度器，进程执行模型为协作式阻塞等待

---

## 十、总结

uuOS 竞赛内核是一个约 4,600 行的双架构（RISC-V 64 + LoongArch 64）宏内核雏形。其 RISC-V 部分实现了一条完整的端到端路径：从 OpenSBI 启动 → 初始化控制台/内存/块设备 → 挂载 EXT4 磁盘 → 加载 ELF64 用户程序 → 通过 Sv39 页表隔离在 U-mode 执行 → 处理有限的系统调用 → 关机。

**主要优势**：
- 子系统覆盖面广：完整覆盖了启动、控制台、内存管理、块设备驱动、文件系统、进程隔离、系统调用、ELF 加载、测试框架
- 关键路径可用：能够在 QEMU virt 平台完成"启动→加载 ELF→运行用户程序→退出"的完整流程
- 双架构框架清晰：平台无关代码与架构相关代码分离良好

**主要不足**：
- LoongArch 支持严重欠缺（用户态完全为桩）
- 构建需要多处修复才能通过
- 无调度器、无中断处理、无 fork/exec
- 系统调用覆盖率低（7 个中 4 个为桩）
- 存在内存布局冲突风险和地址转换缺陷
- 代码中存在重复定义、未使用函数等质量问题

该内核在目标场景（OS 内核挑战赛的基础测试框架）下具备基本可用性，但离一个可投入实际使用的操作系统内核还有显著距离。其设计重点明确放在"展示从磁盘加载 ELF 并在隔离的用户态执行"这一核心能力上，而非追求完整的 POSIX 兼容性或生产级可靠性。