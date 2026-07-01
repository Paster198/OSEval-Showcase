# OSakura 内核项目深度技术分析报告

## 一、项目概述

OSakura 是武汉大学开发的一个面向 RISC-V 64 位架构的教学/竞赛级操作系统内核，参考了 2024 年华东师范大学 ECNU 九队的参赛作品进行改进。项目使用 C 语言编写，面向 QEMU virt 机器平台，采用 OpenSBI 作为固件引导，内核加载地址为 `0x80200000`。

项目采用 GPLv3 许可证，代码规模约 **9633 行**（含 `.c` 和 `.S` 文件），属于中等规模的竞赛级内核。

---

## 二、构建与测试

### 2.1 构建环境分析

项目使用 `riscv64-unknown-elf-` 前缀的交叉编译工具链，构建系统为 GNU Make。顶层 `Makefile` 递归调用 `kernel/` 和 `user/` 子目录。

**构建流程**：
1. 编译用户态库和 `initcode.c`，将 `initcode` 编译为字节数组嵌入内核
2. 递归编译内核各子模块
3. 链接生成 `kernel-rv` ELF 文件
4. 使用 `objcopy` 生成 `os.bin` 裸二进制

**QEMU 启动参数**：
- 机器类型：`virt`
- 内存：128MB
- CPU 核心数：1（单核）
- 固件：OpenSBI (`-bios default`)
- 存储：VirtIO 块设备挂载 `sdcard.img`
- 网络：VirtIO 网络设备（user 模式）

### 2.2 构建测试结果

由于项目需要 `sdcard.img` 文件系统镜像（包含用户程序和 ext4 文件系统），且镜像制作脚本需要 `sudo` 权限进行 mount 操作，在当前环境中无法完整构建和运行。但通过对源码的静态分析，可以确认：

- 内核代码结构完整，各模块依赖关系清晰
- 编译选项合理：`-mcmodel=medany`、`-fno-stack-protector`、`-nostdlib` 等
- 链接脚本定义了明确的内存布局

---

## 三、子系统详细分析

### 3.1 启动引导子系统（boot）

**文件**：`kernel/boot/Entry.S`、`start.c`、`main.c`

**启动流程**：
```
OpenSBI (M-mode) → Entry.S (S-mode) → start.c → main.c
```

**Entry.S** 是内核入口点，负责：
- 根据 `hartid` 计算内核栈地址：`sp = kernel_stack + (hartid + 1) * 4096`
- 调用 `start()` 函数

**start.c** 完成基本初始化：
```c
void start(uint64 hartid, uint64 dtb_entry)
{
    w_satp(0);                                    // 关闭分页
    w_sie(r_sie() | SIE_SEIE | SIE_STIE);         // 使能外部和时钟中断
    w_stvec((uint64)trap_loop);                   // 临时 trap 处理
    w_tp(hartid);                                 // 保存 hartid
    main();                                       // 进入主初始化
}
```

**main.c** 按顺序初始化各子系统：
1. `cons_init()` / `print_init()` - 控制台和打印
2. `pmem_init()` - 物理内存管理
3. `uvm_init()` / `kvm_init()` / `kvm_inithart()` - 虚拟内存
4. `proc_init()` - 进程表
5. `timer_init()` / `trap_init()` / `trap_inithart()` - 中断和异常
6. `plic_init()` / `plic_inithart()` - 中断控制器
7. `virtio_disk_init()` / `buf_init()` - 磁盘和缓冲
8. `procfs_init()` - 虚拟文件系统
9. `proc_userinit()` - 创建第一个用户进程
10. `proc_schedule()` - 进入调度循环

**多核支持**：代码中保留了多核启动的框架（`first`/`other` 标志），但当前被禁用（`other = true` 被注释），仅支持单核运行。

---

### 3.2 进程管理子系统（proc）

**文件**：`kernel/proc/proc.c`、`cpu.c`、`exec.c`、`Swtch.S`

#### 3.2.1 进程结构

```c
typedef struct proc {
    spinlock_t lk;              // 进程锁
    int pid;                    // 进程 ID
    procstate_t state;          // 状态：UNUSED/USED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE
    void* channel;              // 休眠通道
    bool killed;                // 是否被杀死
    int exit_state;             // 退出状态
    struct proc* parent;        // 父进程
    uint64 sz;                  // 用户地址空间大小 [0, sz]
    uint64 vm_allocable;        // mmap 可分配地址起点
    vm_region_t* vm_head;       // mmap 区域链表
    uint64 kstack;              // 内核栈地址
    context_t ctx;              // 上下文（用于 swtch）
    trapframe_t* tf;            // 陷阱帧
    pgtbl_t pagetable;          // 用户页表
    fat32_inode_t* fat32_cwd;   // FAT32 当前目录
    fat32_file_t* fat32_ofile[NOFILE];  // FAT32 打开文件表
    ext4_inode_t* ext4_cwd;     // ext4 当前目录
    ext4_file_t* ext4_ofile[NOFILE];    // ext4 打开文件表
    sigaction_t sigactions[NSIG];       // 信号处理程序
    sigset_t sig_pending;               // 待处理信号
    sigset_t sig_set;                   // 信号掩码
    sigframe_t* sig_frame;              // 信号帧
} proc_t;
```

进程结构同时维护 FAT32 和 ext4 两套文件系统指针，通过编译时宏 `FS_FAT32` 选择使用哪一套。

#### 3.2.2 进程生命周期

**创建（alloc_proc）**：
- 在 `procs[NPROC]` 数组中查找空闲槽位
- 分配 trapframe 物理页
- 创建用户页表并映射 trampoline 和 trapframe
- 设置上下文（`ra = forkret`，`sp = kstack + PAGE_SIZE`）

**fork（proc_fork）**：
- 分配新进程结构
- 复制父进程的页表和物理页（`uvm_copy_pagetable`）
- 复制 trapframe 和打开文件表
- 设置子进程返回值为 0

**exec（proc_exec）**：
- 解析 ELF 文件头
- 支持动态链接（检测 `ELF_PROG_INTERP` 段）
- 加载程序段到内存
- 构建用户栈（argv、envp、auxv）
- 支持输出重定向（硬编码的 `echo > file` 处理）

**退出（proc_exit）**：
- 关闭所有打开文件
- 释放用户内存
- 将子进程重新父化给 initproc
- 进入 ZOMBIE 状态并唤醒父进程

**等待（proc_wait）**：
- 遍历进程表查找 ZOMBIE 子进程
- 回收资源并返回退出状态

#### 3.2.3 调度器

采用简单的**轮转调度（Round-Robin）**算法：

```c
void proc_schedule()
{
    cpu_t* cpu = mycpu();
    cpu->myproc = NULL;
    while(1) {        
        intr_on();
        for(p = procs; p < procs + NPROC; p++) {
            spinlock_acquire(&p->lk);
            if(p->state == RUNNABLE) {
                p->state = RUNNING;                  
                cpu->myproc = p;
                swtch(&cpu->ctx, &p->ctx);    
                cpu->myproc = NULL;
            }
            spinlock_release(&p->lk);
        }
    }
}
```

调度器持续遍历进程表，找到 RUNNABLE 状态的进程即切换执行。抢占式调度代码被注释掉，当前为协作式调度（依赖时钟中断唤醒）。

#### 3.2.4 上下文切换（Swtch.S）

保存 callee-saved 寄存器（ra, sp, s0-s11），实现进程间控制流切换。

---

### 3.3 内存管理子系统（mem）

**文件**：`kernel/mem/pmem.c`、`kvm.c`、`uvm.c`、`Mem.S`

#### 3.3.1 物理内存管理（pmem.c）

采用**空闲链表**管理物理页，分为两个独立池：

| 内存池 | 范围 | 用途 |
|--------|------|------|
| 内核池（kmem） | `[KERNEL_DATA, USER_BASE)` | 内核数据结构、页表 |
| 用户池（umem） | `[USER_BASE, USER_END)` | 用户进程数据 |

- `KERNEL_PAGE_NUM = 1024`（4MB 内核空间）
- `USER_END = 0x88000000`（128MB 物理内存上限）

**限制**：`pmem_alloc_pages` 仅支持分配单页（`assert(npages == 1)`），不支持多页连续分配。

#### 3.3.2 内核虚拟内存（kvm.c）

内核页表建立以下映射：
- UART 寄存器（`UART_BASE`）
- VirtIO 寄存器（`VIO_BASE`）
- PLIC 寄存器（`PLIC_BASE`，4MB）
- RTC 寄存器（`RTC_BASE`）
- 内核代码区（`KERNEL_BASE` → `KERNEL_TEXT`，RX）
- 内核数据区（`KERNEL_TEXT` → `USER_END`，RW）
- Trampoline（`TRAMPOLINE`，RX）
- 各进程内核栈（`KSTACK(i)`，RW）

采用 **SV39** 分页模式（三级页表）。

#### 3.3.3 用户虚拟内存（uvm.c）

用户地址空间布局：
```
VA_MAX (0x3FFFFFFFF)
├── Trampoline（代码区，RX）
├── Trapframe（数据区，RW）
├── mmap 可分配区域（向下增长）
├── 用户栈和数据区 [0, sz]（向上增长）
└── 0x0
```

**mmap 实现**：
- 使用 `vm_region_t` 双向链表管理映射区域
- 支持 `MAP_ANONYMOUS` 和 `MAP_PRIVATE`
- 支持文件映射（从 ext4 读取内容）
- `vm_region_list[N_VM_REGION=128]` 静态数组管理

**brk 实现**：
- 通过 `uvm_grow` / `uvm_ungrow` 动态增减物理页
- 支持向上扩展和向下收缩

---

### 3.4 文件系统子系统（fs）

**文件**：`kernel/fs/` 目录下

#### 3.4.1 架构设计

文件系统采用**操作函数表**模式实现多文件系统支持：

```c
typedef struct {
    int fs_type;
    uint64 (*fs_getcwd)(uint64 dst, int size);
    uint64 (*fs_openat)(int fd, char* path, int flags, uint16 mode);
    uint64 (*fs_read)(int fd, uint64 dst, int len);
    // ... 更多操作
} FS_OP_t;

FS_OP_t FS_OP;  // 全局操作表
```

初始化时根据编译选项注册 ext4 或 FAT32 的操作函数。

#### 3.4.2 ext4 文件系统实现

**核心数据结构**：

```c
// 超级块（内存中）
typedef struct {
    uint64 block_count;
    uint32 inode_count;
    uint32 block_per_group;
    uint32 inode_per_group;
    uint16 inode_size;
    // ...
} ext4_superblock_t;

// inode（内存中）
typedef struct ext4_inode {
    sleeplock_t lk;
    uint32 dev;
    uint32 inum;
    int ref;
    uint16 mode;
    uint64 size;
    uint16 nlink;
    ext4_extent_node_t node;  // extent 树
    struct ext4_inode* par;   // 父目录
    char name[EXT4_NAME_LEN];
    char path[PATH_LEN];
    struct ext4_inode* next;
    struct ext4_inode* prev;
} ext4_inode_t;
```

**Extent 树支持**：使用 ext4 的 extent 树（而非传统的块指针）管理文件数据块，支持稀疏文件和大文件。

**目录管理**：
- 目录项（dirent）存储在单个 4KB block 中
- 支持创建、删除、查找目录项
- 路径解析支持绝对路径和相对路径

**块管理**：
- `ext4_block_alloc` / `ext4_block_free`：通过 block bitmap 分配/释放块
- `ext4_block_read` / `ext4_block_write`：块级读写

**inode 管理**：
- 双向循环链表管理活跃 inode
- `ext4_rooti` 作为链表头
- 支持 inode 缓存和引用计数

#### 3.4.3 FAT32 文件系统实现

结构与 ext4 类似，包含：
- `fat32_cluster.c`：簇链管理
- `fat32_dir.c`：目录操作
- `fat32_file.c`：文件操作
- `fat32_inode.c`：inode 模拟
- `fat32_pipe.c`：管道
- `fat32_sys.c`：系统调用实现

#### 3.4.4 虚拟文件系统（procfs.c）

提供以下虚拟文件：

| 路径 | 类型 | 功能 |
|------|------|------|
| `/proc/meminfo` | 只读 | 内存信息（硬编码值） |
| `/proc/mounts` | 只读 | 挂载信息 |
| `/etc/localtime` | 只读 | 时区信息（CST-8） |
| `/etc/adjtime` | 只读 | 时间调整信息 |
| `/etc/passwd` | 只读 | 用户信息 |
| `/etc/group` | 只读 | 组信息 |
| `/dev/misc/rtc` | 读写 | RTC 时间 |
| `/dev/rtc` | 读写 | RTC 时间（别名） |

实现方式：在 `sys_openat` 中检查路径是否为虚拟文件，若是则分配虚拟文件描述符（`VFILE_FD_BASE = 1000`），读写时调用对应的处理函数。

#### 3.4.5 缓冲层（base/buf.c）

- `NBUF` 个 buf 组成的双向循环链表
- LRU 替换算法
- 睡眠锁保护并发访问
- 封装 `virtio_disk_rw` 为 `buf_read` / `buf_write`

#### 3.4.6 管道（pipe）

- 环形缓冲区实现（`PIPE_SIZE` 字节）
- 支持读写端独立关闭
- 使用 `proc_sleep` / `proc_wakeup` 实现阻塞 I/O

---

### 3.5 设备驱动子系统（dev）

**文件**：`kernel/dev/` 目录下

#### 3.5.1 UART 驱动（uart.c）

- 16550A UART 驱动
- 38.4K 波特率，8 位数据
- 发送缓冲区（32 字节）+ 流控
- 中断驱动的收发

#### 3.5.2 VirtIO 块设备驱动（virtio_disk.c）

- MMIO 方式的 VirtIO 块设备
- 虚拟队列（virtqueue）管理
- 描述符链分配/释放
- 中断驱动的 I/O 完成通知

#### 3.5.3 PLIC 驱动（plic.c）

- 平台级中断控制器
- 使能 UART 和 VirtIO 中断
- 中断优先级和阈值配置

#### 3.5.4 定时器驱动（timer.c）

- 基于 SBI 的定时器
- `timer_setNext` 设置下一次中断
- `timer_get_tv` / `timer_get_ts` 获取时间

#### 3.5.5 RTC 驱动（rtc.c）

- Goldfish RTC 设备
- 读取实时时钟

#### 3.5.6 控制台驱动（console.c）

- 整合 UART 输入输出
- 行编辑和回显
- 输入缓冲区管理

---

### 3.6 陷阱与异常处理子系统（trap）

**文件**：`kernel/trap/Trampoline.S`、`Trap.S`、`trap_kernel.c`、`trap_user.c`

#### 3.6.1 Trampoline 机制

Trampoline 代码被映射到虚拟地址空间顶部（`VA_MAX - PAGE_SIZE`），在用户页表和内核页表中具有相同的虚拟地址，确保页表切换时代码执行不中断。

**uservec**（用户态 → 内核态）：
1. 保存 `a0` 到 `sscratch`
2. 将所有通用寄存器保存到 trapframe
3. 从 trapframe 读取内核页表、栈指针、trap 处理函数地址
4. 切换页表（`sfence.vma` + `csrw satp`）
5. 跳转到 `trap_user()`

**userret**（内核态 → 用户态）：
1. 切换回用户页表
2. 从 trapframe 恢复所有通用寄存器
3. 执行 `sret` 返回用户态

#### 3.6.2 内核态陷阱处理（trap_kernel.c）

```c
void trap_kernel()
{
    reg cause = r_scause();
    if(cause & 0x8000000000000000) { // 中断
        switch (cause & 0xf) {
            case 5: timer_interrupt_handler(true); break;
            case 9: external_interrupt_handler(); break;
        }
    } else { // 异常
        panic("Unknown Kernel Exception!");
    }
}
```

内核态异常直接 panic，不尝试恢复。

#### 3.6.3 用户态陷阱处理（trap_user.c）

```c
void trap_user(void)
{
    reg scause = r_scause();
    if(scause & 0x8000000000000000) { // 中断
        switch (cause_code) {
            case 5: timer_interrupt_handler(false); break;
            case 9: external_interrupt_handler(); break;
        }
    } else { // 异常
        switch (cause_code) {
            case 8: // 系统调用
                p->tf->epc += 4;
                syscall();
                break;
            default:
                proc_setkilled(p);
        }
    }
    trapret_user();
}
```

用户态异常会导致进程被杀死。

---

### 3.7 系统调用子系统（syscall）

**文件**：`kernel/syscall/syscall.c`、`sysfile.c`、`sysproc.c`

#### 3.7.1 系统调用表

共实现约 **60 个系统调用**，按功能分类：

**文件操作（30 个）**：
- 基本 I/O：`openat`、`close`、`read`、`write`、`lseek`
- 向量 I/O：`readv`、`writev`、`pread64`、`pwrite64`
- 目录操作：`getcwd`、`chdir`、`mkdirat`、`getdents64`
- 文件管理：`linkat`、`unlinkat`、`renameat2`、`dup`、`dup2`
- 管道：`pipe2`
- 状态查询：`fstat`、`fstatat`、`faccessat`、`statfs`
- 其他：`fcntl`、`ioctl`、`sendfile`、`ppoll`、`utimensat`、`mount`、`umount2`

**进程操作（15 个）**：
- 生命周期：`clone`、`execve`、`exit`、`exit_group`、`wait4`
- 信息查询：`getpid`、`getppid`、`getuid`、`geteuid`、`getegid`、`gettid`
- 调度：`sched_yield`、`kill`
- 其他：`set_tid_address`、`nanosleep`

**内存操作（5 个）**：
- `brk`、`mmap`、`munmap`、`mprotect`、`madvice`

**信号操作（4 个）**：
- `rt_sigaction`、`rt_sigprocmask`、`rt_sigtimedwait`、`rt_sigreturn`

**其他（6 个）**：
- `times`、`gettimeofday`、`clock_gettime`、`uname`、`sysinfo`、`syslog`、`prlimit`、`shutdown`

#### 3.7.2 参数传递

系统调用参数通过 trapframe 中的寄存器传递：
- `a0`-`a5`：6 个参数
- `a7`：系统调用号
- 返回值写入 `a0`

提供辅助函数：
- `arg_int(n, &val)`：读取整数参数
- `arg_addr(n, &addr)`：读取地址参数
- `arg_str(n, buf, maxlen)`：读取字符串参数
- `fetch_addr(addr, &val)`：从用户空间读取 64 位值
- `fetch_str(addr, buf, maxlen)`：从用户空间读取字符串

---

### 3.8 信号机制子系统（signal）

**文件**：`kernel/signal/signal.c`

支持 31 种标准信号（`SIGHUP` 至 `SIGSYS`）：

```c
#define NSIG 31

typedef struct {
    uint64 handler;    // 处理函数地址
    uint64 flags;      // 标志
    uint64 restorer;   // 恢复函数
    uint64 mask;       // 掩码
} sigaction_t;

typedef uint64 sigset_t;  // 信号集（位图）
```

信号相关系统调用：
- `rt_sigaction`：注册信号处理程序
- `rt_sigprocmask`：修改信号掩码
- `rt_sigtimedwait`：等待信号
- `rt_sigreturn`：从信号处理程序返回

---

### 3.9 同步与锁子系统（lock）

**文件**：`kernel/lock/spinlock.c`、`sleeplock.c`

#### 3.9.1 自旋锁（spinlock）

```c
typedef struct spinlock {
    uint locked;       // 锁状态
    char* name;        // 调试用名称
    int cpu;           // 持有者 CPU
} spinlock_t;
```

- 使用 `__sync_lock_test_and_set` 原子操作
- 支持中断嵌套计数（`push_off` / `pop_off`）

#### 3.9.2 睡眠锁（sleeplock）

```c
typedef struct sleeplock {
    spinlock_t lk;     // 保护内部状态
    uint locked;       // 锁状态
    int pid;           // 持有者进程
    char* name;        // 调试用名称
} sleeplock_t;
```

- 基于自旋锁 + `proc_sleep` / `proc_wakeup` 实现
- 适用于长时间持有的场景（如文件系统操作）

---

### 3.10 内核库（lib）

**文件**：`kernel/lib/print.c`、`string.c`

#### 3.10.1 打印库（print.c）

- `printf`：格式化输出（支持 `%d`、`%x`、`%p`、`%s` 等）
- `panic`：内核 panic 处理
- 输出通过 UART 或控制台

#### 3.10.2 字符串库（string.c）

- `memset`、`memcpy`、`memmove`
- `strlen`、`strcmp`、`strncmp`、`strncpy`、`strcat`、`strcpy`

---

## 四、子系统交互分析

### 4.1 系统调用流程

```
用户程序 → ecall → Trampoline(uservec) → trap_user() → syscall() → sys_xxx()
                                                                    ↓
                                              FS_OP.fs_xxx() ← 文件系统操作
                                                                    ↓
                                              ext4_sys_xxx() ← ext4 实现
                                                                    ↓
                                              ext4_inode_xxx() ← inode 操作
                                                                    ↓
                                              ext4_block_xxx() ← 块操作
                                                                    ↓
                                              buf_read/write() ← 缓冲层
                                                                    ↓
                                              virtio_disk_rw() ← 设备驱动
```

### 4.2 进程调度流程

```
时钟中断 → timer_interrupt_handler() → proc_wakeup(&ticks)
                                            ↓
进程运行 → proc_yield() → proc_sched() → swtch() → proc_schedule()
                                                        ↓
                                              选择 RUNNABLE 进程 → swtch()
```

### 4.3 内存分配流程

```
用户 mmap → sys_mmap() → uvm_mmap() → uvm_region_alloc()
                                          ↓
                                    pmem_alloc_pages() ← 物理页分配
                                          ↓
                                    vm_mappages() ← 页表映射
```

---

## 五、实现完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 启动引导 | 90% | 单核完整，多核框架存在但禁用 |
| 进程管理 | 85% | 核心功能完整，调度算法简单 |
| 内存管理 | 80% | 基本功能完整，缺少多页分配、COW |
| ext4 文件系统 | 85% | 核心功能完整，extent 支持，缺少 journal |
| FAT32 文件系统 | 80% | 基本功能完整 |
| 虚拟文件系统 | 60% | 仅支持少量硬编码路径 |
| 设备驱动 | 75% | 核心设备完整，缺少网络驱动实现 |
| 陷阱处理 | 90% | 完整实现 |
| 系统调用 | 80% | 数量充足，部分为桩实现 |
| 信号机制 | 70% | 基本框架存在，细节待完善 |
| 同步机制 | 90% | 自旋锁和睡眠锁完整 |

**整体完整度**：约 **80%**（以教学/竞赛内核为基准）

---

## 六、设计创新性分析

### 6.1 多文件系统抽象层

通过 `FS_OP_t` 函数指针表实现文件系统抽象，允许编译时切换 ext4/FAT32，这是一个实用的设计。

### 6.2 虚拟文件系统实现

procfs 的实现采用轻量级方案：在系统调用层拦截特定路径，分配虚拟文件描述符，无需修改底层文件系统代码。这种方式简单但有效。

### 6.3 动态链接支持

`exec.c` 中实现了对 ELF 动态链接程序的加载，包括：
- 检测 `PT_INTERP` 段
- 加载解释器（如 `ld-linux-riscv64-lp64d.so`）
- 计算加载基址偏移

### 6.4 输出重定向

在 `proc_exec` 中硬编码实现了 shell 输出重定向（`>` 和 `>>`），虽然实现方式不够优雅，但体现了对实际需求的考虑。

### 6.5 双文件系统并存

进程结构同时维护 FAT32 和 ext4 两套文件指针，虽然增加了内存开销，但提供了灵活性。

---

## 七、代码质量与问题

### 7.1 优点

1. **注释充分**：中文注释详细，函数功能说明清晰
2. **断言使用**：大量使用 `assert` 进行运行时检查
3. **模块化设计**：各子系统边界清晰
4. **锁保护**：关键数据结构都有适当的锁保护

### 7.2 问题与限制

1. **单页分配限制**：`pmem_alloc_pages` 仅支持单页分配，限制了大块内存分配效率

2. **硬编码值**：
   - procfs 中的内存信息为硬编码
   - `sys_times` 返回固定值 100
   - 输出重定向硬编码在 `proc_exec` 中

3. **权限检查缺失**：`check_flags` 函数直接返回 `true`，未实现文件权限检查

4. **管道读取问题**：`ext4_pipe_read` 中当管道为空时直接返回 0 而非阻塞，可能导致忙等待

5. **目录大小限制**：ext4 目录项限制在单个 4KB block 中，限制了目录内文件数量

6. **缺少 Copy-on-Write**：fork 时完整复制物理页，内存效率较低

7. **抢占式调度禁用**：时钟中断中的抢占调度代码被注释

8. **网络驱动缺失**：QEMU 启动参数包含网络设备，但内核中无网络驱动实现

---

## 八、其他信息

### 8.1 用户态支持

**initcode**：第一个用户进程，编译为字节数组嵌入内核，负责执行 `/init` 程序。

**用户库**：
- `stdio.c`：基本 I/O 函数
- `stdlib.c`：内存分配、进程控制
- `syscall.c`：系统调用封装

### 8.2 链接脚本

**kernel.ld**：
- 入口点：`_entry`
- 加载地址：`0x80200000`
- 段布局：`.text` → `.rodata` → `.data` → `.bss`

**user.ld**：
- 入口点：`_start`
- 加载地址：`0x0`（用户空间）

### 8.3 测试代码

`kernel/test/test_execve.c` 包含 execve 测试，验证程序加载和执行。

---

## 九、总结

OSakura 是一个结构清晰、功能相对完整的 RISC-V 教学/竞赛级操作系统内核。项目实现了操作系统的核心子系统，包括进程管理、内存管理、文件系统、设备驱动、系统调用等。

**主要成就**：
- 完整的 ext4 文件系统实现（含 extent 支持）
- 60+ 系统调用的实现
- 动态链接程序加载支持
- 多文件系统抽象层设计

**主要不足**：
- 调度算法过于简单（纯轮转）
- 缺少 Copy-on-Write 优化
- 部分功能为桩实现或硬编码
- 仅支持单核运行

**适用场景**：
- 操作系统教学实验
- 操作系统竞赛参赛
- RISC-V 平台内核开发参考

项目代码质量良好，注释充分，适合作为学习 RISC-V 操作系统内核的参考资料。