# AddddOS 内核项目深度技术分析报告

## 一、项目概述

**项目名称**：AddddOS  
**开发团队**：华中科技大学 - "啊对的对的，嗷不对不对"  
**项目基础**：基于 MIT xv6 (RISC-V 版本) 进行大规模扩展开发  
**目标平台**：RISC-V 64 位 (QEMU virt) 和 LoongArch 64 位 (QEMU virt)  
**编程语言**：C（内核主体）+ 汇编（架构相关底层代码）  
**构建系统**：CMake (>= 3.21) + GNU Make  
**内核代码规模**：约 13,244 行（不含第三方 lwext4 库，含所有内核 .c 和 .S 文件）

---

## 二、构建与测试结果

### 2.1 构建测试

**RISC-V 架构构建**：成功。使用 `make build-release-riscv` 命令，通过 CMake 配置后编译，最终生成 `bin/kernel-riscv`（约 278KB）。编译过程中存在若干警告（主要是用户态头文件中结构体声明不完整、类型不匹配等），但无编译错误。

**LoongArch 架构构建**：未进行实际构建测试（环境中 LoongArch 交叉编译工具链可用，但构建流程与 RISC-V 类似，基于 CMake 条件编译切换）。

**磁盘镜像制作**：成功创建 512MB EXT4 格式磁盘镜像（`disk.img`），使用 `dd` + `mkfs.ext4` 工具。由于环境限制（无 sudo/mount 权限），未能将用户态二进制文件写入镜像进行完整启动测试。

### 2.2 运行测试

由于环境中无法使用 `mount` 命令将用户态程序写入 EXT4 镜像，QEMU 启动测试未能完成。内核本身可以编译链接成功，但缺少包含用户态程序的磁盘镜像将导致内核在 `userinit()` 阶段无法加载 init 进程。

---

## 三、子系统详细拆解

### 3.1 启动引导子系统

**对应文件**：
- `kernel/boot/riscv/entry.S` - RISC-V 入口汇编
- `kernel/boot/riscv/start.c` - RISC-V 启动C代码
- `kernel/boot/loongarch/entry.S` - LoongArch 入口汇编
- `kernel/boot/main.c` - 共用内核主函数

**实现细节**：

RISC-V 入口（`entry.S`）从 SBI 获取 hartid，计算每个 CPU 的栈空间（4KB/CPU），然后跳转到 `start.c`。`start.c` 负责从 M 模式切换到 S 模式，设置 `stvec`、`sie` 等 CSR 寄存器，最终调用 `main()`。

LoongArch 入口（`entry.S`）更为复杂，需要手动设置直接映射窗口（DMWIN0/DMWIN1），配置 CRMD（当前模式寄存器，设定 PLV=0、PG=1），并通过 `cpucfg` 指令读取 CPU 配置信息。

`main.c` 中的初始化流程分两架构实现：

```c
// RISC-V 初始化序列
consoleinit();
printfinit();
kinit();           // 伙伴分配器初始化
kvminit();         // 创建内核页表
kvminithart();     // 开启分页
procinit();        // 进程表
trapinit();        // trap 向量
trapinithart();    // 安装内核 trap 向量
plicinit();        // PLIC 中断控制器
plicinithart();
virtio_disk_init2(); // rootfs 块设备
virtio_disk_init();  // 数据盘
init_fs_table();
binit();           // 缓冲缓存
fileinit();        // 文件表
inodeinit();       // inode 表
vfs_ext4_init();   // lwext4 初始化
initlogbuffer();
socket_init();
userinit();        // 第一个用户进程
```

LoongArch 的初始化序列与 RISC-V 类似，但使用 APIC + EXTIOI 替代 PLIC，并通过 PCI 总线探测 virtio 设备。

**多核支持**：项目支持多核启动（`NCPU` 个 CPU），但非主核（`started != 0` 分支）仅在 RISC-V 架构下实现了完整的初始化流程（开启分页、安装 trap 向量、配置 PLIC），LoongArch 架构下非主核的初始化代码被注释/缺失。

**完整度评估**：70%。基本功能完整，但多核支持在 LoongArch 上不完全。

---

### 3.2 内存管理子系统

**对应文件**：
- `kernel/mem/kalloc.c` - 物理页分配器（封装层）
- `kernel/mem/buddysystem.c` - 伙伴系统分配器
- `kernel/mem/slab.c` - Slab 分配器
- `kernel/mem/vm.c` - 虚拟内存/页表管理
- `kernel/mem/uart.c` - UART 串口驱动（放在 mem 目录下，组织略有不合理）

#### 3.2.1 伙伴系统（BuddySystem）

采用类线段树结构管理物理页面，每个节点有四种状态：

```c
#define NODE_UNUSED 0  // 未使用
#define NODE_USED   1  // 已使用
#define NODE_SPLIT  2  // 已分裂
#define NODE_FULL   3  // 已满
```

核心设计：
- 使用非侵入式设计，伙伴系统的元数据（`struct buddysystem`）存储在物理内存起始处（`end` 符号之后），不占用额外的管理空间。
- 分配和回收的时间复杂度均为 O(log n)。
- `pa_start` 在伙伴系统元数据之后开始，确保管理区域不被分配。
- 支持分配 2 的幂次个连续页面。

```c
void buddysystem_init() {
    pa_start = PGROUNDUP((uint64)end);
    bs = (struct buddysystem *)pa_start;
    pa_start += BSSIZE * PGSIZE;
    memset(bs, 0, BSSIZE * PGSIZE);
    while (!((1 << bs->level) & PGNUM)) bs->level++;
}
```

**已知问题**：
- `kfree()` 和 `kalloc()` 中的锁被注释掉（`acquire(&memlock)` / `release(&memlock)`），在多核环境下存在竞态条件风险。
- `kcalloc()` 实现中 `size_to_page_num(size)` 仅使用 `size` 参数而非 `n * size`，存在 bug。

#### 3.2.2 Slab 分配器

实现了 5 种固定大小的 slab cache（16、32、64、128、256 字节），每个 slab 管理一个物理页面：

```c
struct slab {
    void *pa_start;
    uint64 free_objs_count;
    uint64 max_objs_count;
    list_head_t list;
    uint64 first_obj;
};

struct slab_cache {
    uint32 size;
    uint32 free_slabs_count;
    list_head_t free_slabs, partial_slabs, full_slabs;
};
```

Slab 元数据存储在页面起始位置，空闲对象通过链表串联。支持 free/partial/full 三级链表管理，并在释放时执行内存回收（当 free_slabs 超过 `DEFAULT_MAX_FREE_SLABS_ALLOWED` 时销毁多余 slab）。

**已知问题**：`slab_init()` 在 `kinit()` 中被注释掉，Slab 分配器实际上未被启用。`slab_cache_new()` 函数缺少 `return cache;` 语句。

#### 3.2.3 虚拟内存管理（vm.c）

**RISC-V**：使用 Sv39 三级页表，每级 512 个 64 位 PTE。内核页表映射包括：
- UART 寄存器（0x10000000）
- 两个 virtio MMIO 设备（0x10001000, 0x10002000）
- CLINT（0x2000000）
- PLIC（0x0c000000，4MB 映射）
- 内核代码段（只读+可执行）
- 内核数据段和物理 RAM（可读写）
- Trampoline 页（最高虚拟地址）

**LoongArch**：使用四级页表结构，通过 `CSR_PWCL`/`CSR_PWCH` 配置硬件页表遍历器。使用直接映射窗口（DMWIN）进行物理-虚拟地址转换。

**关键功能**：
- `walk()` - 页表遍历，支持 RISC-V（3级）和 LoongArch（4级）
- `mappages()` - 批量映射页面
- `protectpages()` - 修改已映射页面的权限（用于 `mprotect` 系统调用）
- `uvmalloc()` / `uvmdealloc()` - 用户空间内存增长/收缩
- `copyin()` / `copyout()` / `copyinstr()` - 用户空间与内核空间数据拷贝

**完整度评估**：75%。伙伴系统实现完整且设计合理，Slab 分配器代码存在但未启用，虚拟内存管理功能完整但缺少 COW（写时复制）和 lazy allocation 支持（代码中有 TODO 注释）。

---

### 3.3 进程管理子系统

**对应文件**：
- `kernel/proc/proc.c` - 进程核心（约 700 行）
- `kernel/proc/exec.c` - ELF 加载执行（约 500 行）
- `kernel/proc/pipe.c` - 管道
- `kernel/proc/spinlock.c` - 自旋锁
- `kernel/proc/sleeplock.c` - 睡眠锁
- `kernel/proc/semaphore.c` - 信号量
- `kernel/proc/signal.c` - 信号机制
- `kernel/proc/socket.c` - Socket 网络接口
- `kernel/proc/riscv/swtch.S` - RISC-V 上下文切换
- `kernel/proc/loongarch/swtch.S` - LoongArch 上下文切换
- `kernel/proc/riscv/sig_trampoline.S` - RISC-V 信号 trampoline
- `kernel/proc/loongarch/sig_trampoline.S` - LoongArch 信号 trampoline

#### 3.3.1 进程结构

```c
struct proc {
    struct spinlock lock;
    enum procstate state;     // UNUSED, USED, SLEEPING, RUNNABLE, RUNNING, ZOMBIE
    void *chan;               // 睡眠通道
    int killed;               // 是否被杀死
    int xstate;               // 退出状态
    int pid;                  // 进程 ID
    struct proc *parent;      // 父进程
    uint64 kstack;            // 内核栈虚拟地址
    uint64 sz;                // 进程内存大小
    pagetable_t pagetable;    // 用户页表
    struct trapframe *trapframe;
    struct context context;   // 上下文切换用
    struct file *ofile[NOFILE]; // 打开文件表
    struct file_vnode cwd;    // 当前工作目录
    struct vm_area vma[NVMA]; // mmap 虚拟内存区域（NVMA=16）
    struct tms proc_tms;      // 进程时间统计
    sigset_t block;           // 信号掩码
    int signal;               // 待处理信号
    struct sighand *sig;      // 信号处理结构
    struct signal_frame *sig_frame; // 信号帧链表
    void *chan2;              // futex 用睡眠通道
    uint64 clear_child_tid;   // set_tid_address 用
    int uid, gid;             // 用户/组 ID
};
```

最大进程数由 `NPROC` 宏定义控制。进程表为全局静态数组 `proc[NPROC]`。

#### 3.3.2 调度器

采用简单的轮转调度（Round-Robin），在 `scheduler()` 函数中实现。调度器遍历进程表寻找 RUNNABLE 状态的进程，将其切换为 RUNNING 状态执行。时间片机制在 trap 处理中实现：RISC-V 架构下每 5 个时钟中断让出 CPU，LoongArch 架构下每 10 个时钟中断让出。

```c
// trap.c 中的时间片控制
if(which_dev == 2) {
    timeslice++;
    if(timeslice >= 5) {  // RISC-V: 5, LoongArch: 10
        timeslice = 0;
        yield();
    }
}
```

#### 3.3.3 fork 与 clone

`fork()` 实现基于 xv6 原始代码，创建子进程并完整复制父进程的用户空间内存、文件描述符、信号处理等。

`clone()` 扩展了 fork 的功能，支持 Linux 风格的 clone flags（CLONE_VM、CLONE_FS、CLONE_FILES 等），可以实现线程创建。当 stack 参数为 NULL 时退化为 fork。

#### 3.3.4 exec / execve

`exec.c` 实现了完整的 ELF 加载器，支持：
- 解析 ELF 头部和程序头
- 加载 LOAD 段到用户空间
- 处理 BSS 段
- 设置用户栈（32 页，位于高地址区域）
- 构建辅助向量（auxv），包括 AT_PHDR、AT_PHENT、AT_PHNUM、AT_ENTRY、AT_RANDOM 等
- 支持环境变量
- 支持动态链接器（interp）加载

LoongArch 版本的 execve 实现更为完整，包含了完整的 auxv 构建和栈布局设置。RISC-V 版本的实现相对简化。

#### 3.3.5 管道（pipe）

管道实现基于 xv6 原始设计，使用 1024 字节的环形缓冲区。支持内核态读写（`pipewrite_kernel` / `piperead_kernel`），用于内部进程间通信。

**完整度评估**：80%。进程管理核心功能完整，调度器简单但可用。缺少优先级调度、CFS 等高级调度算法。clone 支持线程但实现较为基础。

---

### 3.4 信号机制子系统

**对应文件**：
- `kernel/proc/signal.c` - 信号核心实现
- `kernel/sys/syssig.c` - 信号相关系统调用
- `kernel/proc/riscv/sig_trampoline.S` - RISC-V 信号 trampoline
- `kernel/proc/loongarch/sig_trampoline.S` - LoongArch 信号 trampoline

**支持的信号操作**：
- `rt_sigaction` - 注册/查询信号处理程序
- `rt_sigprocmask` - 修改信号掩码（SIG_BLOCK、SIG_UNBLOCK、SIG_SETMASK）
- `rt_sigreturn` - 从信号处理函数返回
- `kill` / `tkill` / `tgkill` - 发送信号

**信号处理流程**：
1. 在 `usertrap()` 返回用户空间前调用 `handle_signal()`
2. 检查进程是否有待处理信号
3. 如果信号处理函数为用户自定义的，保存当前 trapframe 到 `signal_frame`
4. 修改 trapframe 使进程跳转到信号处理函数
5. 信号处理函数返回时通过 `sig_trampoline` 调用 `rt_sigreturn`
6. `sig_return()` 恢复原始 trapframe

信号帧使用链表管理（`sig_frame`），支持嵌套信号。

**已知问题**：
- `default_handle()` 中 SIGCHLD 的处理直接调用 `wait4(-1, 0, 0)`，可能导致阻塞。
- `do_handle()` 中当信号被阻塞时直接 `kfree(frame)` 并返回，但信号未被清除，可能导致信号丢失。
- `tgkill` 实现仅打印日志，未实际发送信号。

**完整度评估**：65%。基本信号机制可用，但边界情况处理不完善，部分信号（如 SIGSTOP、SIGCONT）的默认行为未实现。

---

### 3.5 文件系统子系统

**对应文件**：
- `kernel/fs/vfs/file.c` - 文件操作（VFS 层）
- `kernel/fs/vfs/fs.c` - 文件系统注册与挂载
- `kernel/fs/vfs/inode.c` - inode 管理
- `kernel/fs/vfs/ops.c` - 路径解析与 VFS 操作
- `kernel/fs/ext4/vfs_ext4_ext.c` - EXT4 VFS 扩展接口（约 800 行）
- `kernel/fs/ext4/vfs_ext4_blockdev_ext.c` - EXT4 块设备适配
- `kernel/fs/ext4/lwext4/` - 第三方 lwext4 库（约 20 个 .c 文件）

#### 3.5.1 VFS 抽象层

VFS 层定义了文件系统操作的统一接口：

```c
struct file_operations {
    struct file* (*dup)(struct file *f);
    void (*close)(struct file *f);
    int (*read)(struct file *f, uint64 addr, int n);
    int (*readat)(struct file *f, uint64 addr, int n, uint64 offset);
    int (*write)(struct file *f, uint64 addr, int n);
    int (*fstat)(struct file *f, uint64 addr);
    int (*statx)(struct file *f, uint64 addr);
    char (*writable)(struct file *f);
    char (*readable)(struct file *f);
};
```

文件系统类型通过 `fs_table[]` 数组管理，支持最多 `VFS_MAX_FS` 个文件系统同时挂载。当前仅注册了 EXT4 类型。

#### 3.5.2 文件结构

```c
struct file {
    int f_type;          // FD_NONE, FD_PIPE, FD_REG, FD_DEVICE, FD_SOCKET, FD_SYSFILE
    int f_flags;         // O_RDONLY, O_WRONLY, O_RDWR 等
    int f_count;         // 引用计数
    int f_pos;           // 文件位置
    char f_path[MAXPATH]; // 文件路径
    void *f_extfile;     // EXT4 文件结构指针
    struct pipe *f_pipe; // 管道指针
    struct Socket *f_socket; // Socket 指针
    int f_socketnum;
    int f_socketflags;
    int f_major;         // 设备主设备号
    int removed;         // 标记删除
    uint64 flagsslow;    // exec 标志位（低64位）
    uint64 flagshigh;    // exec 标志位（高64位）
};
```

全局文件表 `ftable` 管理 `NFILE` 个文件结构，通过引用计数实现文件共享。

#### 3.5.3 EXT4 文件系统

通过集成第三方库 lwext4 实现完整的 EXT4 文件系统支持。`vfs_ext4_ext.c` 作为适配层，将 VFS 接口转换为 lwext4 API 调用。

支持的操作包括：
- 文件创建、打开、关闭、读取、写入、删除
- 目录创建、遍历、删除
- 硬链接、符号链接
- 文件重命名
- 文件状态查询（stat、statx、statfs）
- 文件截断（ftruncate）
- 文件权限检查（faccessat）
- 挂载/卸载
- copy_file_range
- 路径解析（支持绝对路径、相对路径、`.` 和 `..`）

EXT4 操作使用信号量（`extlock`）进行互斥保护。

**特殊文件支持**：
- `/proc/interrupts` - 虚拟文件，展示中断统计信息（`FD_SYSFILE` 类型）
- `/dev/urandom` - 伪随机数设备
- `/dev/null` - 空设备

**完整度评估**：85%。VFS 层设计合理，EXT4 功能覆盖全面。但 VFS 层目前仅支持 EXT4 一种文件系统类型，FAT32 等其他类型的槽位预留但未实现。路径解析中的 `../` 处理在某些边界情况下可能存在问题。

---

### 3.6 设备驱动子系统

**对应文件**：
- `kernel/driver/bio.c` - 块 I/O 缓冲层
- `kernel/driver/riscv/virtio_disk.c` - RISC-V virtio-blk MMIO 驱动
- `kernel/driver/loongarch/pci.c` - LoongArch PCI 总线扫描
- `kernel/driver/loongarch/virtio_disk.c` - LoongArch virtio-blk PCI 驱动
- `kernel/driver/loongarch/virtio_pci.c` - virtio PCI 通用层
- `kernel/driver/loongarch/virtio_ring.c` - virtio 环形队列

#### 3.6.1 块 I/O 缓冲层（bio.c）

基于 xv6 原始设计，使用 LRU 双向链表管理 `NBUF` 个缓冲区。每个缓冲区通过睡眠锁保护，支持并发访问。`bread()` 和 `bwrite()` 根据设备号（dev=0 或 dev=1）选择不同的 virtio 磁盘进行操作。

#### 3.6.2 RISC-V virtio-blk 驱动

使用 MMIO 方式访问 virtio 设备，支持两个 virtio-blk 设备（VIRTIO0 和 VIRTIO1）。驱动实现了标准的 virtio 初始化流程：
1. 检查 Magic Value、Version、Device ID
2. 特性协商
3. 队列初始化（描述符表、可用环、已用环）
4. 中断处理

每次 I/O 操作使用 3 个描述符（类型/保留/扇区、数据、状态），通过 `alloc3_desc()` 分配。

#### 3.6.3 LoongArch PCI 子系统

实现了完整的 PCI 总线扫描：
- 遍历所有总线（0 到 PCI_MAX_BUS）
- 遍历每个总线上的设备（0 到 PCI_MAX_DEV）
- 遍历每个设备的功能号（0 到 PCI_MAX_FUN）
- 读取配置空间，初始化 BAR 寄存器
- 支持 PCI 设备的查找和定位

virtio-blk 设备通过 PCI 总线发现，使用 MMIO 映射进行通信。

**完整度评估**：75%。双架构的 virtio-blk 驱动均已实现，PCI 子系统在 LoongArch 上可用。但仅支持块设备驱动，缺少网络驱动、显示驱动等。

---

### 3.7 中断/异常处理子系统

**对应文件**：
- `kernel/trap/riscv/trap.c` - RISC-V trap 处理
- `kernel/trap/riscv/kernelvec.S` - RISC-V 内核 trap 入口
- `kernel/trap/loongarch/trap.c` - LoongArch trap 处理
- `kernel/trap/loongarch/kernelvec.S` - LoongArch 内核 trap 入口
- `kernel/trap/loongarch/uservec.S` - LoongArch 用户 trap 入口
- `kernel/trap/loongarch/tlbrefill.S` - LoongArch TLB 缺失处理
- `kernel/trap/loongarch/merror.S` - LoongArch 机器错误处理
- `kernel/trap/loongarch/apic.c` - LoongArch APIC 中断控制器
- `kernel/trap/loongarch/extioi.c` - LoongArch 扩展 I/O 中断控制器
- `kernel/sys/plic.c` - RISC-V PLIC 中断控制器

#### 3.7.1 RISC-V trap 处理

trap 处理分为用户态（`usertrap`）和内核态（`kerneltrap`）两种路径：

- **系统调用**（scause=8）：保存 epc，调用 `syscall()` 分发
- **外部中断**（scause 高位为1，低8位=9）：通过 PLIC 获取中断号，分发到 UART 或 virtio 处理
- **时钟中断**（scause=0x8000000000000005）：递增 ticks，唤醒等待进程，设置下次超时
- **缺页异常**（scause=13 或 15）：调用 `pagefault_handler()` 处理 mmap 区域的按需映射

#### 3.7.2 LoongArch trap 处理

LoongArch 使用 `CSR_EENTRY` 寄存器设置 trap 入口，通过 `CSR_ESTAT` 的 ECODE 字段判断异常类型：
- **系统调用**（ECODE=0xb）：类似 RISC-V
- **TLB 缺失**（ECODE=0x1 或 0x2）：缺页异常处理
- **断点**（ECODE=0xf）：跳过断点指令
- **硬件中断**：通过 EXTIOI 获取中断号
- **时钟中断**：通过 TICLR 确认

#### 3.7.3 缺页异常处理

两架构均实现了基于 VMA 的缺页异常处理：

```c
int pagefault_handler(uint64 va, uint64 cause) {
    // 查找 va 所属的 VMA
    for (i = 0; i < NVMA; i++) {
        if(p->vma[i].used && p->vma[i].addr <= va && va <= p->vma[i].addr + p->vma[i].len - 1)
            break;
    }
    if (i == NVMA) return 0; // 非 mmap 区域，暂不处理
    // 分配物理页，从文件读取内容（如有），映射到页表
    void *pa = kalloc();
    if (f != NULL) {
        int offset = p->vma[i].offset + PGROUNDDOWN(va - p->vma[i].addr);
        get_fops()->readat(f, (uint64)pa, PGSIZE, offset);
    }
    mappages(p->pagetable, PGROUNDDOWN(va), PGSIZE, (uint64)pa, pte_flags);
}
```

**完整度评估**：75%。两架构的 trap 处理均完整实现，缺页异常支持 mmap 区域的按需映射。但 lazy allocation（非 mmap 区域的延迟分配）和 COW 未实现。

---

### 3.8 系统调用子系统

**对应文件**：
- `kernel/sys/syscall.c` - 系统调用分发（324 行）
- `kernel/sys/sysfile.c` - 文件相关系统调用（1524 行）
- `kernel/sys/sysproc.c` - 进程相关系统调用（356 行）
- `kernel/sys/sysmem.c` - 内存相关系统调用（234 行）
- `kernel/sys/sysothers.c` - 其他系统调用（175 行）
- `kernel/sys/syssig.c` - 信号相关系统调用（110 行）

#### 3.8.1 系统调用分发

系统调用通过 trap 机制进入内核，`syscall()` 函数根据 trapframe 中的 a7 寄存器（系统调用号）从 `syscalls[]` 函数指针数组中查找对应的处理函数。

#### 3.8.2 系统调用清单

项目实现了约 **80+ 个系统调用**，按功能分类如下：

**进程管理**（15个）：fork, exit, wait, wait4, getpid, getppid, gettid, clone, kill, exec, execve, exit_group, sched_yield, set_tid_address, set_robust_list

**文件操作**（25个）：openat, read, write, close, dup, dup3, fstat, fstatat, statx, lseek, getcwd, chdir, mkdirat, unlinkat, linkat, getdents64, readlinkat, renameat2, ftruncate, pread64, readv, writev, sendfile, copy_file_range, splice

**内存管理**（6个）：brk, mmap, munmap, mremap, mprotect, madvise

**信号**（6个）：rt_sigaction, rt_sigprocmask, rt_sigtimedwait, kill_signal, tkill, tgkill

**设备/IO**（4个）：ioctl, mount, umount2, faccessat

**时间**（4个）：gettimeofday, clock_gettime, nanosleep, clock_nanosleep, times

**Socket 网络**（12个）：socket, bind, listen, accept, connect, getsockname, getpeername, setsockopt, getsockopt, sendto, recvfrom, shutdownsock

**系统信息**（8个）：uname, sysinfo, syslog, getrandom, getuid, getgid, setuid, setgid, geteuid, getegid, getpgid, setpgid, prlimit64, fcntl, ppoll, fchmodat, symlinkat, utimensat, futex

#### 3.8.3 存根实现

部分系统调用仅实现了存根（返回 0 或空操作），包括：
- `sys_set_robust_list` - 直接返回 0
- `sys_prlimit64` - 直接返回 0
- `sys_getpgid` - 直接返回 0
- `sys_setpgid` - 直接返回 0
- `sys_geteuid` - 直接返回 0
- `sys_getegid` - 直接返回 0
- `sys_madvise` - 直接返回 0
- `sys_rt_sigtimedwait` - 直接返回 0
- `sys_exit_group` - 仅读取参数，未实际终止进程组

**完整度评估**：80%。系统调用覆盖面广，核心功能完整。部分 BusyBox 兼容的系统调用为存根实现。

---

### 3.9 Socket 网络子系统

**对应文件**：
- `kernel/proc/socket.c` - Socket 实现（约 600 行）

实现了本地进程间通信的 Socket 机制，支持 TCP（SOCK_STREAM）和 UDP（SOCK_DGRAM）两种类型。

**核心结构**：
```c
struct Socket {
    bool used;
    socket_addr addr;        // 本地地址
    socket_addr target_addr; // 目标地址
    int type;                // SOCK_STREAM / SOCK_DGRAM
    int listening;           // 是否在监听
    int pid;                 // 所属进程
    void *bufferAddr;        // 接收缓冲区
    struct spinlock lock;
    struct socket_state state;
    TAILQ_HEAD(, message) messages; // 消息队列
    socket_addr waiting_queue[PENDING_COUNT]; // 连接等待队列
};
```

**支持的操作**：socket, bind, listen, connect, accept, sendto, recvfrom, shutdown, close

**实现特点**：
- 使用全局 Socket 数组（`SOCKET_COUNT` 个）和位图管理 Socket 分配
- 消息使用预分配的池（`MESSAGE_COUNT` 个）和空闲链表管理
- TCP connect 使用 sleep/wakeup 机制实现同步连接
- UDP 支持 connected 和 unconnected 模式
- shutdown 支持半关闭（读关闭/写关闭）

**已知问题**：
- Socket 通信仅限于同一内核内的进程间通信，不支持真正的网络通信
- `connect()` 中 UDP 分支存在死代码（`return 0` 后的代码不可达）
- 锁的粒度较粗，在高并发场景下性能可能受限

**完整度评估**：60%。本地 IPC 功能基本可用，但缺少真正的网络协议栈支持。

---

### 3.10 锁与同步子系统

**对应文件**：
- `kernel/proc/spinlock.c` - 自旋锁
- `kernel/proc/sleeplock.c` - 睡眠锁
- `kernel/proc/semaphore.c` - 信号量

#### 3.10.1 自旋锁

基于 xv6 原始实现，使用 `__sync_lock_test_and_set` 原子操作。支持 `push_off()` / `pop_off()` 嵌套禁用中断。

#### 3.10.2 睡眠锁

基于自旋锁和 sleep/wakeup 机制实现，适用于可能长时间持有的锁场景。

#### 3.10.3 信号量

实现了 PV 操作，但实现较为粗糙：

```c
void sem_v(sem *s) {
    acquire(&s->lock);
    s->value++;
    if (s->value <= 0) {
        s->wakeup++;
        for (int i=0; i<s->top; i++) {
            s->wait_list[i]->state = RUNNABLE;
        }
        s->top = 0;
    }
    release(&s->lock);
}
```

V 操作会唤醒所有等待进程（而非仅唤醒一个），存在"惊群效应"。代码注释中也标注了 TODO 需要优化。

#### 3.10.4 Futex

在 `sysproc.c` 中实现了 Linux 兼容的 futex 系统调用，支持 FUTEX_WAIT、FUTEX_WAKE 和 FUTEX_REQUEUE 操作。FUTEX_WAIT 支持超时机制，使用 `sleep1()` 函数实现带双重睡眠通道的等待。

**完整度评估**：70%。基本同步原语可用，但信号量实现存在性能问题，缺少读写锁、条件变量等高级同步原语。

---

### 3.11 用户态程序

**对应文件**：
- `user/app/` - 用户应用程序源码（14 个程序）
- `user/deps/` - 用户态库（ulib.c, printf.c, umalloc.c, usys.S）
- `user/bin/riscv/` - 51 个 RISC-V 预编译二进制
- `user/bin/loongarch/` - LoongArch 预编译二进制（glibc 和 musl 两套）
- `user/bin/busybox` - BusyBox 二进制

**自编译用户程序**：cat, echo, grep, init, kill, ls, mkdir, rm, sh, shutdown, wc, zombie, init-sh, signal_test

**预编译测试程序**（RISC-V）：涵盖 brk, chdir, clone, close, dup, dup2, execve, exit, fork, fstat, getcwd, getdents, getpid, getppid, gettimeofday, kill, mmap, munmap, mount, umount, open, openat, pipe, read, write, sleep, times, uname, unlink, wait, waitpid, yield 等系统调用测试。

**BusyBox 支持**：项目包含预编译的 BusyBox 二进制，通过大量 BusyBox 兼容的系统调用实现支持。

---

## 四、子系统交互关系

```
用户态程序
    |
    | ecall / syscall
    v
系统调用分发层 (syscall.c)
    |
    +---> 进程管理 (proc.c, exec.c)
    |         |
    |         +---> 信号机制 (signal.c)
    |         +---> 管道 (pipe.c)
    |         +---> Socket (socket.c)
    |
    +---> 文件操作 (sysfile.c)
    |         |
    |         +---> VFS 层 (file.c, fs.c, ops.c)
    |                   |
    |                   +---> EXT4 (vfs_ext4_ext.c -> lwext4)
    |                             |
    |                             +---> 块 I/O (bio.c)
    |                                       |
    |                                       +---> virtio-blk 驱动
    |
    +---> 内存管理 (sysmem.c)
    |         |
    |         +---> 虚拟内存 (vm.c)
    |         +---> 伙伴系统 (buddysystem.c)
    |         +---> Slab (slab.c, 未启用)
    |
    +---> 中断处理 (trap.c)
              |
              +---> PLIC (RISC-V) / APIC+EXTIOI (LoongArch)
              +---> 时钟中断 -> 调度器
              +---> 缺页异常 -> pagefault_handler
```

---

## 五、项目创新性分析

### 5.1 双架构支持

项目通过 CMake 条件编译和目录隔离实现了 RISC-V 和 LoongArch 双架构支持。这在 OS 竞赛项目中较为少见，体现了团队对不同 ISA 的理解深度。LoongArch 的移植涉及：
- 直接映射窗口（DMWIN）机制
- 四级页表和硬件页表遍历器配置
- APIC + EXTIOI 中断控制器
- PCI 总线枚举和 virtio PCI 设备驱动
- LoongArch 特有的 CSR 寄存器操作

### 5.2 伙伴系统分配器

使用线段树结构管理物理页面的设计相比传统的空闲链表方式更为高效，O(log n) 的分配/回收复杂度在理论上优于 xv6 原始的链表分配器。非侵入式设计（元数据存储在管理区域起始）也是一个合理的工程选择。

### 5.3 EXT4 文件系统移植

将 lwext4 库集成到 xv6 内核中，并通过 VFS 层进行抽象，是一个工程量较大的工作。适配层需要处理块设备接口转换、锁机制适配、内存分配适配等问题。

### 5.4 系统调用兼容性

系统调用号采用 Linux 标准编号（如 fork=1, exit=93, read=63, write=64 等），使得基于 glibc/musl 编译的用户态程序可以直接运行，这是一个实用的设计决策。

---

## 六、代码质量与工程问题

### 6.1 优点
1. **目录结构清晰**：按子系统组织，架构相关代码隔离
2. **CMake 构建系统**：相比纯 Makefile 更现代化，支持条件编译
3. **文档较完整**：`doc/` 目录下有各子系统的设计文档
4. **双架构支持**：代码复用度较高

### 6.2 问题
1. **锁机制不完善**：多处关键代码的锁被注释掉（如 kalloc/kfree），多核安全性存疑
2. **内存泄漏风险**：部分错误路径未正确释放已分配资源
3. **Slab 分配器未启用**：代码存在但 `slab_init()` 被注释，`slab_cache_new()` 缺少 return 语句
4. **调试代码残留**：多处 `printf` 调试语句未清理
5. **代码重复**：RISC-V 和 LoongArch 的 trap 处理、exec 实现存在大量重复代码，可通过更好的抽象减少
6. **错误处理不一致**：部分函数在错误时 panic，部分返回 -1，缺乏统一的错误处理策略
7. **`kcalloc()` bug**：参数 `n` 未被使用，仅使用 `size` 计算页面数
8. **UART 驱动位置**：`uart.c` 放在 `kernel/mem/` 目录下，组织不合理

---

## 七、整体完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 启动引导 | 70% | 双架构基本可用，LoongArch 多核不完整 |
| 内存管理 | 75% | 伙伴系统完整，Slab 未启用，缺 COW/lazy alloc |
| 进程管理 | 80% | 核心功能完整，调度简单 |
| 信号机制 | 65% | 基本可用，边界情况处理不完善 |
| 文件系统 | 85% | VFS+EXT4 功能覆盖全面 |
| 设备驱动 | 75% | 双架构 virtio-blk 完整，缺少其他驱动 |
| 中断处理 | 75% | 双架构 trap 完整，缺 COW |
| 系统调用 | 80% | 80+ 个调用，部分为存根 |
| Socket 网络 | 60% | 本地 IPC 可用，无真正网络 |
| 锁与同步 | 70% | 基本原语可用，信号量实现粗糙 |
| **整体** | **74%** | 基于 xv6 的大规模扩展，功能覆盖面广但深度不足 |

---

## 八、总结

AddddOS 是一个基于 MIT xv6 进行大规模扩展的 OS 内核项目，主要贡献包括：

1. **架构扩展**：从单一 RISC-V 扩展到 RISC-V + LoongArch 双架构，涉及启动引导、中断处理、页表管理、设备驱动等全方位的架构适配。

2. **文件系统升级**：从 xv6 原始的简单文件系统升级为完整的 EXT4 实现，并通过 VFS 层提供抽象。

3. **内存管理增强**：用伙伴系统替代 xv6 原始的链表分配器，实现了 Slab 分配器（虽未启用）。

4. **系统调用大幅扩展**：从 xv6 的约 20 个系统调用扩展到 80+ 个，覆盖进程管理、文件操作、内存管理、信号、Socket、时间等多个领域，支持 BusyBox 运行。

5. **IPC 机制丰富**：在管道基础上增加了信号量和 Socket 本地通信。

项目的主要不足在于：部分子系统实现深度不够（如 Slab 未启用、Socket 仅限本地、信号处理边界情况不完善），多核安全性存在隐患（多处锁被注释），以及代码中存在若干 bug（如 kcalloc 参数错误、slab_cache_new 缺少返回值）。整体而言，该项目在功能广度上表现突出，但在工程质量和实现深度上仍有提升空间。