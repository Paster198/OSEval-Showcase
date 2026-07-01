# F7LY OS 内核项目深度技术分析报告

## 1. 项目概述

F7LY OS 是一款基于 Xv6 教学操作系统进行大规模改造和扩展的内核项目，由武汉大学团队开发。项目使用 **C++23** 作为主要开发语言（禁用异常和 RTTI），支持 **RISC-V** 和 **LoongArch** 双架构。内核入口地址为 `0x80200000`（RISC-V），采用 S-Mode 运行（由 OpenSBI 从 M-Mode 跳转）。

项目代码规模：内核源文件（.cc/.cpp/.c/.S/.s）共 **134 个**，头文件（.h/.hh/.hpp）共 **182 个**，第三方库 EASTL 作为独立子模块编译为静态库。

---

## 2. 构建与测试结果

### 2.1 构建尝试

尝试使用环境中可用的 `riscv64-unknown-elf-g++`（GCC 13.2.0）替代 Makefile 中指定的 `riscv64-linux-gnu-g++` 进行编译。构建失败，原因是内核核心头文件 `kernel/types.hh` 依赖 `<sys/types.h>`，而 `riscv64-unknown-elf-` 工具链为裸机（bare-metal）工具链，不提供 POSIX 系统头文件。环境中未安装 `riscv64-linux-gnu-g++`（仅有 `riscv64-linux-gnu-gcc`，无 C++ 编译器），因此无法完成构建。

**构建失败原因总结**：
- Makefile 指定 `CROSS_COMPILE := riscv64-linux-gnu-`，需要 `riscv64-linux-gnu-g++`
- 环境中仅有 `riscv64-linux-gnu-gcc`（C 编译器），未安装对应的 `g++`（C++ 编译器）
- 备用的 `riscv64-unknown-elf-g++` 为裸机工具链，缺少 `<sys/types.h>` 等 Linux 系统头文件
- 项目依赖 Linux 系统头文件（如 `<sys/types.h>`、`<asm-generic/statfs.h>`、`<linux/sysinfo.h>`、`<termios.h>` 等），这是项目设计上的选择

### 2.2 测试缺失说明

由于构建未能成功，无法进行 QEMU 运行测试。以下分析完全基于源代码静态审查。

---

## 3. 子系统详细拆解

### 3.1 启动模块（kernel/boot/）

**文件组成**：
- `riscv/entry.S` — 汇编入口，设置栈并调用 `start()`
- `riscv/start.cc` — S-Mode 初始化，关闭分页，设置 trap 向量，调用 `main()`
- `riscv/main.cc` — 内核主初始化流程
- `riscv/initcode.S` — 内嵌的初始用户进程二进制
- `riscv/fuckyou.cc` — ASCII art 打印（调试/展示用）
- `loongarch/` — 对应的 LoongArch 架构实现

**启动流程**（RISC-V）：
```
OpenSBI (M-Mode) -> entry.S (S-Mode) -> start() -> main()
```

`entry.S` 中根据 hartid 计算每个核心的栈偏移（每核 4KB*2），然后调用 `start()`。`start()` 关闭分页（`satp=0`），将 `stvec` 设为死循环 `trap_loop`，保存 hartid 到 `tp` 寄存器，然后调用 `main()`。

`main()` 的初始化顺序：
1. `k_printer.init()` — 初始化打印子系统（含 UART 和 Console）
2. `trap_mgr.init()` / `trap_mgr.inithart()` — 中断/异常处理初始化
3. `plic_mgr.init()` / `plic_mgr.inithart()` — PLIC 中断控制器初始化
4. `k_pm.init()` — 进程管理器初始化
5. `k_pmm.init()` — 物理内存管理器初始化
6. `k_vmm.init()` — 虚拟内存管理器初始化（创建内核页表，启用分页）
7. `k_hmm.init()` — 堆内存管理器初始化
8. `k_smm.init()` — 共享内存管理器初始化
9. `SlabAllocator::init()` — Slab 分配器初始化
10. 注册标准输入/输出/错误设备
11. `k_tm.init()` — 定时器管理器初始化
12. `k_syscall_handler.init()` — 系统调用处理器初始化
13. `k_pm.user_init()` — 创建初始用户进程
14. `virtio_disk_init()` — VirtIO 磁盘驱动初始化
15. `init_fs_table()` / `binit()` / `fileinit()` / `inodeinit()` — 文件系统初始化
16. `vfs_ext4_init()` — ext4 文件系统层初始化
17. `k_vfs.dir_init()` — VFS 目录初始化（创建 /dev/misc/rtc、/usr、/usr/lib 等）
18. `k_fifo_manager.init()` — FIFO 管理器初始化
19. `LoopControlDevice::init_loop_control()` — Loop 设备初始化
20. `k_scheduler.start_schedule()` — 启动调度器（不返回）

**完整度评估**：85%。启动流程完整，覆盖了从 Bootloader 到用户进程启动的全链路。但仅支持单核启动（`smp 1`），多核初始化逻辑未实现。

---

### 3.2 内存管理子系统（kernel/mem/）

#### 3.2.1 物理内存管理器（PhysicalMemoryManager）

采用 **伙伴系统（Buddy System）** 管理物理页面。

```cpp
void PhysicalMemoryManager::init()
{
    memlock.init("memlock");
    pa_start = reinterpret_cast<uint64_t>(end);
    pa_start = (pa_start + PGSIZE - 1) & ~(PGSIZE - 1);
    _buddy = reinterpret_cast<BuddySystem *>(pa_start);
    pa_start += BSSIZE * PGSIZE;
    memset(_buddy, 0, BSSIZE * PGSIZE);
    _buddy->Initialize(pa_start);
}
```

物理内存起始地址从内核 BSS 段末尾（`end` 符号）开始，页对齐后预留 `BSSIZE` 页用于 Buddy 系统的树结构存储，之后才是可分配的物理内存区域。

核心接口：
- `alloc_page()` — 分配单个物理页（4KB），清零后返回
- `free_page(void *pa)` — 释放物理页
- `kmalloc(size_t size)` — 按页分配连续内存
- `kcalloc(uint n, size_t size)` — 分配并清零

#### 3.2.2 伙伴系统（BuddySystem）

使用完全二叉树实现，树节点状态包括 `NODE_UNUSED`、`NODE_USED`、`NODE_SPLIT`、`NODE_FULL`。

```cpp
int BuddySystem::Alloc(int size)
{
    int actual_size = size == 0 ? 1 : NextPowerOfTwo(size);
    int length = 1 << level;
    // 从根节点向下搜索合适大小的块
    // 找到后标记为 NODE_USED，并向上标记父节点
    // 返回页号偏移
}
```

分配时将请求大小向上取到 2 的幂次，从根节点开始向下搜索。如果当前节点过大则分裂（`NODE_SPLIT`），如果找到合适大小的空闲块则标记为已用。释放时通过 `Combine()` 尝试与兄弟节点合并。

管理的总页数为 `PGNUM`（由 `platform.hh` 定义），树层级通过 `while (!((1 << level) & PGNUM))` 计算。

#### 3.2.3 虚拟内存管理器（VirtualMemoryManager）

核心功能：
- **内核页表创建**（`kvmmake()`）：映射内核代码段、数据段、trampoline 页、所有进程的内核栈
- **页表映射**（`map_pages()`）：将虚拟地址范围映射到物理地址，支持 RISC-V 和 LoongArch 两种 PTE 格式
- **用户空间管理**：`vmalloc()`/`vmdealloc()` 用于用户堆的扩展和收缩
- **地址拷贝**：`copy_in()`/`copy_out()` 在用户空间和内核空间之间拷贝数据，支持缺页时的懒分配（检查 VMA 区域）
- **mmap 支持**：`sys_mmap()` 实现文件映射和匿名映射，支持 `MAP_SHARED`/`MAP_PRIVATE`/`MAP_ANONYMOUS` 等标志
- **mprotect**：修改内存区域保护属性
- **缺页异常处理**：`mmap_handler()` 处理 mmap 区域的缺页异常

RISC-V 架构下通过 `satp` 寄存器切换页表，LoongArch 通过 `pgdl`/`pwcl`/`pwch` 等 CSR 配置硬件页表遍历器。

#### 3.2.4 堆内存管理器（HeapMemoryManager）

采用双层管理：
- **粗粒度**：独立的 BuddySystem 实例管理堆区域的物理页
- **细粒度**：`liballoc` 分配器（`_k_allocator_fine`）在粗粒度分配的页面上进行更细粒度的内存分配

#### 3.2.5 Slab 分配器（SlabAllocator）

实现经典的 Slab 分配算法，预定义 5 个缓存大小：16、32、64、128、256 字节。

```cpp
void SlabAllocator::init()
{
    caches[0] = new SlabCache(16);
    caches[1] = new SlabCache(32);
    caches[2] = new SlabCache(64);
    caches[3] = new SlabCache(128);
    caches[4] = new SlabCache(256);
}
```

每个 `SlabCache` 管理三条链表：`free_slabs_`（全空闲）、`partial_slabs_`（部分使用）、`full_slabs_`（全满）。每个 Slab 占用一个物理页，元数据存储在页面头部，剩余空间划分为固定大小的对象，通过链表串联空闲对象。当空闲 Slab 数量超过 `DEFAULT_MAX_FREE_SLABS_ALLOWED` 时自动回收。

#### 3.2.6 页表实现（RISC-V）

三级页表结构，`walk()` 函数遍历页表查找虚拟地址对应的 PTE：

```cpp
Pte PageTable::walk(uint64 va, bool alloc)
{
    PageTable current_pt = *this;
    for (int level = 2; level > 0; level--)
    {
        const uint64 index = PX(level, va);
        Pte pte = current_pt.get_pte(index);
        if (pte.is_valid()) {
            PageTable next_level;
            next_level.set_base(PTE2PA(pte.get_data()));
            current_pt = next_level;
        } else {
            if (!alloc) return Pte(0);
            // 分配新页表页
            void *new_page = k_pmm.alloc_page();
            // ...
        }
    }
    return current_pt.get_pte(PX(0, va));
}
```

#### 3.2.7 Trampoline 与信号 Trampoline

- `trampoline.S`：实现用户态与内核态之间的切换，映射在固定的虚拟地址（`TRAMPOLINE`），在用户页表和内核页表中都有映射。`uservec` 保存用户寄存器、切换到内核栈和内核页表、跳转到 `usertrap()`。`userret` 执行反向操作。
- `sig_trampoline.S`：信号处理的 trampoline，包含 `sig_handler` 函数，通过 `ecall` 调用 `rt_sigreturn` 系统调用返回。

**完整度评估**：80%。物理内存管理（Buddy System + Slab）和虚拟内存管理（三级页表、mmap、mprotect）实现较为完整。但缺页异常处理中标注了 `TODO("pagefault_handler")`，懒分配逻辑存在但不完善。Copy-on-Write 未实现（fork 时直接深拷贝）。

---

### 3.3 进程管理子系统（kernel/proc/）

#### 3.3.1 进程控制块（PCB / Pcb）

进程池 `k_proc_pool[num_process]` 为全局静态数组。每个 PCB 包含：

- **基本标识**：`_global_id`、`_pid`、`_tid`、`_ppid`、`_pgid`、`_tgid`、`_sid`
- **用户/组标识**：`_uid`、`_euid`、`_suid`、`_fsuid`、`_gid`、`_egid`、`_sgid`、`_fsgid`
- **状态管理**：`_state`（UNUSED/USED/RUNNING/SLEEPING/ZOMBIE 等）、`_chan`（睡眠通道）、`_killed`、`_xstate`
- **调度信息**：`_slot`（时间片）、`_priority`（优先级）、`_cpu_mask`（CPU 亲和性）
- **内存管理**：`_kstack`（内核栈）、`_trapframe`（用户上下文保存区）、`_memory_manager`（ProcessMemoryManager 指针）
- **文件系统**：`_cwd`（当前工作目录）、`_cwd_name`、`_ofile`（打开文件表）、`_umask`
- **线程同步**：`_futex_addr`、`_clear_tid_addr`、`_robust_list`
- **信号处理**：`_sigactions`（信号处理函数表，引用计数共享）、`_sigmask`、`_signal`（待处理信号位图）
- **资源限制**：`_rlim_vec[RLIM_NLIMITS]`（RLIMIT_STACK、RLIMIT_NOFILE、RLIMIT_FSIZE 等）
- **时间统计**：`_start_tick`、`_user_ticks`、`_stime`、`_cutime`、`_cstime`

#### 3.3.2 进程内存管理器（ProcessMemoryManager）

统一管理进程的地址空间，包括：
- 程序段（text/data/bss）记录
- 堆区域管理（`heap_start`/`heap_end`）
- VMA（Virtual Memory Area）管理，最多 `NVMA` 个区域
- 页表管理
- 引用计数支持（`ref_count`），用于 `clone` 时线程共享地址空间
- `clone_for_fork()` — 深拷贝整个地址空间（程序段 + 堆 + VMA）
- `share_for_thread()` — 增加引用计数，共享页表

#### 3.3.3 调度器（Scheduler）

采用 **优先级调度** 算法：

```cpp
void Scheduler::start_schedule()
{
    for (;;) {
        cpu->interrupt_on();
        priority = get_highest_proirity(); // 找到最高优先级（数值最小）
        for (p = k_proc_pool; p < &k_proc_pool[num_process]; p++) {
            if (p->_state != ProcState::RUNNABLE || p->_priority > priority)
                continue;
            p->_lock.acquire();
            if (p->get_state() == ProcState::RUNNABLE) {
                p->_state = ProcState::RUNNING;
                cpu->set_cur_proc(p);
                swtch(cur_context, &p->_context);
                cpu->set_cur_proc(nullptr);
            }
            p->_lock.release();
        }
    }
}
```

调度器为无限循环，每次找到最高优先级的可运行进程并切换。时间片由 trap 中的 `timeslice` 计数器控制，每 5 个时钟中断触发一次 `yield()`。

上下文切换通过 `swtch.S` 实现，保存/恢复 callee-saved 寄存器（ra, sp, s0-s11）。

#### 3.3.4 信号机制（Signal）

支持 POSIX 信号，包括：
- `sigAction()` — 设置/获取信号处理函数（`rt_sigaction` 系统调用）
- `sigprocmask()` — 设置/获取信号屏蔽掩码（`rt_sigprocmask`）
- `sigsuspend()` — 原子地替换信号掩码并等待信号
- `add_signal()` — 向进程添加信号
- `handle_sync_signal()` — 处理同步信号（如 SIGSEGV、SIGBUS、SIGILL）
- 信号 trampoline 通过 `sig_trampoline.S` 实现用户态信号处理函数的调用和返回

支持的信号包括标准信号（SIGHUP 到 SIGRTMAX）和实时信号。SIGKILL 和 SIGSTOP 不可被屏蔽或捕获。

#### 3.3.5 Futex

实现 Linux futex 语义：
- `futex_wait()` — 原子地检查值并睡眠，支持超时
- `futex_wakeup()` — 唤醒等待在指定地址上的进程
- 支持信号中断（返回 `EINTR`）
- 支持 `FUTEX_REQUEUE` 操作

#### 3.3.6 POSIX 定时器

全局静态定时器数组 `g_timers[32]`，支持：
- `timer_create` / `timer_settime` / `timer_gettime` / `timer_delete`
- 周期性和一次性定时器
- 定时器到期时发送指定信号
- 在时钟中断中检查到期定时器（`check_expired_timers()`）

#### 3.3.7 管道（Pipe）

基于环形缓冲区实现，支持：
- 阻塞/非阻塞模式
- 读写端关闭检测
- SIGPIPE 信号（写端关闭时）
- 动态调整管道大小（`set_pipe_size()`，范围 `min_pipe_size` 到 `max_pipe_size`）
- FIFO（命名管道）通过 `FifoManager` 管理

#### 3.3.8 进程创建与执行

- `fork()` — 创建子进程，深拷贝地址空间、文件表、信号处理等
- `clone()` / `clone3()` — 支持线程创建（`CLONE_VM`/`CLONE_THREAD`/`CLONE_FILES` 等标志）
- `exec()` / `execve()` — 加载 ELF 可执行文件，支持解释器（interpreter）
- `exit()` / `exit_group()` — 进程退出，清理资源，发送 SIGCHLD
- `wait4()` — 等待子进程退出，支持 WNOHANG

**完整度评估**：85%。进程管理功能丰富，包括 fork/clone/exec/exit/wait、信号、futex、POSIX 定时器、管道等。但调度器为简单的优先级调度（非 CFS），不支持动态优先级调整。线程支持通过 clone 实现但完整度有待验证。

---

### 3.4 文件系统子系统（kernel/fs/）

#### 3.4.1 VFS 层

文件系统采用多层架构：

**文件类型体系**（面向对象设计）：
- `file`（基类）— 定义 read/write/lseek/stat 等虚函数接口
- `normal_file` — 普通文件，底层通过 lwext4 操作
- `directory_file` — 目录文件
- `pipe_file` — 管道文件，封装 `Pipe` 对象
- `socket_file` — 套接字文件，封装 onpstack BSD socket
- `device_file` — 设备文件，转发到设备管理器
- `virtual_file` — 虚拟文件（procfs 风格），通过 `VirtualContentProvider` 动态生成内容

**虚拟文件系统（VirtualFileSystem）**：
树形结构管理虚拟文件节点（`vfile_tree_node`），支持：
- `/proc/self/exe` — 当前进程可执行文件路径
- `/proc/meminfo` — 内存信息
- `/proc/cpuinfo` — CPU 信息
- `/proc/version` — 内核版本字符串
- `/proc/mounts` — 挂载信息
- `/proc/self/fd/N` — 文件描述符符号链接
- `/etc/passwd` — 用户信息（硬编码）
- `/dev/block` — 块设备信息

#### 3.4.2 ext4 文件系统（lwext4 移植）

移植了 lwext4（轻量级 ext4 实现），包含完整的 ext4 功能模块：
- `ext4_balloc` — 块分配
- `ext4_ialloc` — inode 分配
- `ext4_inode` — inode 操作
- `ext4_dir` / `ext4_dir_idx` — 目录操作
- `ext4_extent` — extent 树管理
- `ext4_journal` — 日志（journaling）
- `ext4_xattr` — 扩展属性
- `ext4_super` — 超级块管理
- `ext4_bcache` — 块缓存
- `ext4_mkfs` — 格式化
- `ext4_crc32` — CRC32 校验

通过 `vfs_ext4_blockdev` 将 lwext4 的块设备接口适配到内核的 VirtIO 磁盘驱动。

#### 3.4.3 块缓冲层（bio.cc）

实现块设备缓冲缓存（`binit()`），管理磁盘块的读写缓存。

#### 3.4.4 文件系统挂载

支持多文件系统挂载，通过 `fs_table[VFS_MAX_FS]` 管理。`fs_ops_table` 注册 ext4 的操作函数。路径解析通过 `get_absolute_path()` 处理相对路径、`.`、`..` 等。

#### 3.4.5 FIFO 管理器

`FifoManager` 使用 `eastl::unordered_map` 管理命名管道，支持创建、打开（读/写端计数）、关闭和删除。

**完整度评估**：75%。VFS 层设计合理，文件类型体系完整。ext4 通过 lwext4 移植获得较完整的功能。但路径解析中的 `../` 处理代码注释中自述"非常容易出错"，存在潜在 bug。FAT 文件系统仅在 `fs_ops_table` 中预留了位置但未实现。ramfs 未实现。

---

### 3.5 设备驱动子系统（kernel/devs/）

#### 3.5.1 UART 驱动

16550 UART 驱动，支持：
- 同步/异步字符发送和接收
- 环形缓冲区
- 中断驱动接收
- 波特率配置（115200）
- 输入/输出缓冲区大小查询和刷新（用于 `tcflush` ioctl）

#### 3.5.2 设备管理器（DeviceManager）

全局设备表 `_device_table[DEV_TBL_LEN]`，支持：
- 块设备和字符设备注册/搜索/移除
- 预注册 stdin/stdout/stderr（设备号 0/1/2）
- 通过名称查找设备

#### 3.5.3 VirtIO 磁盘驱动

RISC-V 通过 MMIO 方式访问 VirtIO 块设备，LoongArch 通过 PCI 总线访问。实现包括：
- VirtIO 设备初始化（特性协商、队列设置）
- 块读写请求
- 中断处理

#### 3.5.4 Loop 设备

实现 Linux loop 设备语义：
- `LoopDevice` — 将文件映射为块设备
- `LoopControlDevice` — 管理最多 `MAX_LOOP_DEVICES` 个 loop 设备
- 支持 `LOOP_SET_FD`、`LOOP_CLR_FD`、`LOOP_SET_STATUS`、`LOOP_GET_STATUS` 等 ioctl

#### 3.5.5 流设备（StreamDevice）

抽象基类，为字符设备提供流式读写接口。Console 的 stdin/stdout/stderr 通过 `StreamDevice` 与 UART 连接。

#### 3.5.6 PCI 总线（LoongArch）

LoongArch 架构下实现 PCI 总线枚举和设备发现。

**完整度评估**：70%。UART 和 VirtIO 磁盘驱动功能完整。Loop 设备实现较为完整。但缺少其他常见设备驱动（如 RTC、键盘、帧缓冲等）。VirtIO 网卡驱动在网络子系统中实现。

---

### 3.6 网络协议栈子系统（kernel/net/）

#### 3.6.1 架构概述

网络子系统基于 **onpstack**（Open Network Protocol Stack）第三方协议栈构建，包含：

```
BSD Socket API (socket.cc)
    |
TCP/UDP/ICMP (ip/)
    |
ARP/Ethernet (ethernet/)
    |
Netif/Route (netif/)
    |
VirtIO Net Driver (drivers/)
```

#### 3.6.2 VirtIO 网卡驱动

RISC-V 通过 MMIO 初始化，LoongArch 通过 PCI（未完全实现）。

```cpp
void virtio_net_init_mmio()
{
    // 检查设备 magic/version/device_id/vendor_id
    // 特性协商（仅启用 VIRTIO_NET_F_MAC）
    // 初始化 RX 队列（queue 0）和 TX 队列（queue 1）
    // 预填充 RX 缓冲区
    // 读取 MAC 地址
}
```

#### 3.6.3 TCP/IP 协议栈

onpstack 提供完整的 TCP 实现：
- 三次握手（SYN/SYN-ACK/ACK）
- 超时重传（指数退避）
- FIN 四次挥手
- TIME_WAIT 状态处理
- 滑动窗口

UDP 实现：无连接数据报传输。

ICMP：Echo Request/Reply（ping）。

ARP：地址解析协议。

#### 3.6.4 BSD Socket API

```cpp
SOCKET socket(INT family, INT type, INT protocol, EN_ONPSERR *penErr);
void close(SOCKET socket);
// connect, bind, listen, accept, send, recv 等
```

支持 `AF_INET`（IPv4）和 `AF_INET6`（IPv6，条件编译）。

#### 3.6.5 内核 Socket 文件

`socket_file` 类将 BSD Socket 封装为 VFS 文件对象，支持：
- `bind()`、`listen()`、`accept()`、`connect()`
- `send()`、`recv()`、`sendto()`、`recvfrom()`
- `setsockopt()`、`getsockopt()`
- `poll()` 就绪检测（`read_ready()`/`write_ready()`）
- 非阻塞模式

#### 3.6.6 网络栈集成

`f7ly_network.cc` 提供统一的网络栈初始化入口：
1. 加载 onpstack 核心
2. 初始化 VirtIO 网卡适配器
3. 注册网络接口

**完整度评估**：70%。协议栈功能完整（TCP/UDP/ICMP/ARP），BSD Socket API 齐全。但主要依赖第三方 onpstack，内核自身的集成层较薄。LoongArch 架构的网卡驱动未完全实现。网络栈在 `main()` 中未被调用初始化（代码中未见 `init_network_stack()` 调用），可能需要在用户空间手动触发。

---

### 3.7 系统调用子系统（kernel/sys/）

#### 3.7.1 系统调用分发

`SyscallHandler` 使用函数指针数组 `_syscall_funcs[]` 实现系统调用分发。通过 `BIND_SYSCALL(name)` 宏注册系统调用处理函数。

```cpp
void SyscallHandler::init()
{
    for (auto &func : _syscall_funcs)
        func = &SyscallHandler::_default_syscall_impl; // 默认 panic
    BIND_SYSCALL(fork);
    BIND_SYSCALL(read);
    // ... 120+ 系统调用
}
```

#### 3.7.2 已注册的系统调用（约 120+ 个）

| 类别 | 系统调用 |
|------|---------|
| **进程管理** | fork, clone, clone3, exec, execve, exit, exit_group, wait, wait4, kill_signal, tkill, tgkill, getpid, getppid, gettid, setpgid, getpgid, setsid, getsid |
| **内存管理** | brk, mmap, munmap, mremap, mprotect, madvise, membarrier |
| **文件操作** | openat, close, read, write, readv, writev, pread64, pwrite64, preadv, pwritev, lseek, dup, dup3, fcntl, ioctl, sendfile, readahead |
| **文件系统** | mkdirat, unlinkat, linkat, renameat2, symlinkat, readlinkat, getcwd, chdir, fchdir, chroot, mount, umount2, statfs, fstatfs, sync, fsync, fdatasync, ftruncate, truncate, fallocate, faccessat, fstatat, fstat, statx, getdents64, utimensat, mknod, mknodat |
| **信号** | rt_sigaction, rt_sigprocmask, rt_sigtimedwait, rt_sigreturn |
| **时间** | clock_gettime, clock_nanosleep, nanosleep, setitimer, gettimeofday, times |
| **IPC** | pipe2, futex, set_tid_address, set_robust_list, get_robust_list |
| **共享内存** | shmget, shmctl, shmat |
| **网络** | socket, socketpair, bind, listen, accept, connect, getsockname, getpeername, sendto, recvfrom, setsockopt, getsockopt, sendmsg |
| **调度** | sched_yield, sched_getaffinity |
| **信息** | uname, sysinfo, getrusage, getrandom, syslog, pselect6, ppoll |
| **权限** | setuid, setgid, getuid, geteuid, getgid, getegid, fchmod, fchmodat, fchmodat2, fchown, fchownat, prlimit64 |
| **扩展属性** | setxattr, lsetxattr, fsetxattr, getxattr, lgetxattr, fgetxattr, listxattr, llistxattr, flistxattr, removexattr, lremovexattr, fremovexattr |
| **其他** | shutdown, readlinkat, fchmodat2 |

**完整度评估**：80%。系统调用覆盖面广，涵盖了 Linux 兼容性的主要方面。但部分系统调用标注为 `todo`，实际实现可能不完整（如 `pread64`、`pwrite64`、`pselect6`、`clone3` 等）。

---

### 3.8 中断与异常处理子系统（kernel/trap/）

#### 3.8.1 RISC-V 中断处理

**内核态中断**（`kernelvec.S` -> `kerneltrap()`）：
- 保存全部 32 个通用寄存器到内核栈
- 调用 `wrap_kerneltrap()` -> `kerneltrap()`
- 支持嵌套中断
- 时钟中断触发 `timertick()`，每 5 个时钟中断触发 `yield()`

**用户态中断**（`trampoline.S` -> `usertrap()`）：
- 通过 trampoline 切换到内核栈和内核页表
- 根据 `scause` 分发：
  - `cause == 8`：系统调用（ecall），调用 `invoke_syscaller()`
  - `cause == 0x8000000000000005`：时钟中断
  - `cause == 9`（外部中断）：通过 PLIC 分发到 UART 或 VirtIO
  - `cause == 12/13/15`：缺页异常，调用 `mmap_handler()`
  - 其他异常：根据类型发送 SIGBUS/SIGILL/SIGTRAP/SIGSEGV/SIGSYS

**PLIC 中断控制器**：
- 初始化时配置 UART0_IRQ 和 VIRTIO0_IRQ 的优先级
- `claim()` / `complete()` 接口

#### 3.8.2 LoongArch 中断处理

- `kernelvec.S` / `uservec.S` — 对应的汇编入口
- `apic.cc` — 本地 APIC 中断控制器
- `extioi.cc` — 扩展 I/O 中断控制器
- `tlbrefill.S` — TLB 缺失处理
- `merror.S` — 机器错误处理
- `trap_func_wrapper.cc` — 统一的 trap 处理包装

#### 3.8.3 中断统计

`interrupt_stats.cc` 提供中断计数统计功能。

**完整度评估**：80%。RISC-V 中断处理完整，支持内核态/用户态 trap、系统调用、时钟中断、外部中断和缺页异常。LoongArch 中断处理框架完整但细节实现可能不如 RISC-V 成熟。

---

### 3.9 硬件抽象层（kernel/hal/）

- `cpu.cc` — CPU 操作封装：中断开关（`push_intr_off()`/`pop_intr_off()`）、FPU 使能、时间读取
- 架构特定 CSR 操作：`rv_csr.hh`（RISC-V）、`la_csr.hh`（LoongArch）
- `read_tp()` — 读取 hartid/coreid

**完整度评估**：75%。基本的 CPU 操作封装完整，但抽象层次较低，许多架构相关代码散布在其他模块中（通过 `#ifdef RISCV` / `#elif defined(LOONGARCH)` 条件编译）。

---

### 3.10 时间管理子系统（kernel/tm/）

- `TimerManager` — 核心定时器管理
  - `get_time_val()` — 获取当前时间（timeval 格式）
  - `sleep_n_ticks()` — 按 tick 数睡眠
  - `clock_gettime()` — 支持 8 种时钟类型（CLOCK_REALTIME、CLOCK_MONOTONIC、CLOCK_PROCESS_CPUTIME_ID 等）
- `timer_interface.cc` — 硬件时间戳获取接口

**完整度评估**：75%。时间管理功能基本完整，支持多种时钟类型。但时间精度依赖硬件定时器频率，且注释中提到 RISC-V 和 LoongArch 的时间实现存在差异需要统一。

---

### 3.11 共享内存子系统（kernel/shm/）

实现 System V 风格的共享内存：

```cpp
void ShmManager::init(uint64 base, uint64 size)
{
    shm_base = base;
    shm_size = size;
    next_shmid = 1;
    free_blocks.push_back({base, size});
    segments = new eastl::unordered_map<int, shm_segment>();
}
```

- `shmget()` — 创建/获取共享内存段
- `shmat()` — 附加共享内存到进程地址空间
- `shmctl()` — 控制操作（IPC_RMID、IPC_STAT、IPC_SET 等）
- 内存分配采用 First Fit 策略
- 支持权限检查（owner/group/other）
- 空闲块合并

**完整度评估**：70%。基本的 System V 共享内存语义已实现，但缺少 IPC_PRIVATE 的完整处理和共享内存的引用计数跟踪。

---

### 3.12 内核库（kernel/libs/）

| 文件 | 功能 |
|------|------|
| `string.cc` | 字符串操作（memcpy、memset、strcmp、strlen 等） |
| `klib.cc` | 内核工具函数（panic、assert、atoi 等） |
| `printer.cc` | 彩色打印输出（printfWhite/Green/Red/Cyan/Blue 等） |
| `semaphore.cc` | 信号量实现（P/V 操作，支持最大值限制和 try 操作） |
| `qsort.cc` | 快速排序 |
| `global_operator.cc` | C++ 全局 new/delete 运算符重载 |
| `__cxx_abi.cc` | C++ ABI 支持（纯虚函数调用、全局对象构造等） |
| `liballoc_allocator.cc` | liballoc 内存分配器封装 |
| `function.cc` | 函数对象支持 |
| `common.cc` | 通用工具 |

**完整度评估**：80%。内核基础库功能齐全，信号量实现完整（含等待队列和最大值限制）。

---

### 3.13 用户态（user/）

- `app/initcode-rv.cc` / `initcode-la.cc` — 初始用户进程，负责启动 shell
- `syscall_lib/` — 系统调用封装库（`syscall.cc`、`printf.cc`）
- `user_lib/user_test.cc` — 用户态测试程序
- `deps/` — 用户态依赖头文件
- 用户态链接脚本：`user-riscv.ld`、`user-loongarch.ld`

用户态使用 BusyBox 预编译二进制（`busybox/riscv/` 和 `busybox/loongarch/`）作为 shell 和常用工具。

---

## 4. 子系统交互关系

```
用户进程 (BusyBox shell)
    |
    | ecall (系统调用)
    v
系统调用分发器 (syscall_handler.cc)
    |
    +---> 进程管理 (proc_manager, scheduler)
    |         |
    |         +---> 内存管理 (vmm, pmm, slab)
    |         +---> 信号处理 (signal)
    |         +---> Futex / POSIX 定时器
    |
    +---> 文件系统 (VFS -> ext4/lwext4)
    |         |
    |         +---> 块缓冲 (bio)
    |         +---> VirtIO 磁盘驱动
    |         +---> Loop 设备
    |         +---> 虚拟文件 (procfs)
    |         +---> FIFO 管理器
    |
    +---> 网络 (socket_file -> onpstack -> VirtIO Net)
    |
    +---> 共享内存 (shm_manager)
    |
    +---> 设备管理 (device_manager -> UART/Console)

中断流：
硬件中断 -> PLIC/APIC -> kernelvec/uservec -> trap.cc -> devintr()
    |
    +---> UART 中断 -> console_intr
    +---> VirtIO 磁盘中断 -> virtio_disk_intr
    +---> 时钟中断 -> timertick -> yield (每5次)
```

---

## 5. 项目完整度评估

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 启动模块 | 85% | 完整的单核启动流程，多核未实现 |
| 内存管理 | 80% | Buddy+Slab+mmap 完整，COW 未实现 |
| 进程管理 | 85% | fork/clone/exec/signal/futex 完整 |
| 文件系统 | 75% | VFS+ext4 完整，路径解析有隐患 |
| 设备驱动 | 70% | UART+VirtIO 磁盘完整，缺少其他设备 |
| 网络协议栈 | 70% | TCP/IP 完整（依赖 onpstack），LoongArch 网卡未完成 |
| 系统调用 | 80% | 120+ 系统调用注册，部分标注 todo |
| 中断处理 | 80% | RISC-V 完整，LoongArch 框架完整 |
| 时间管理 | 75% | 多种时钟类型支持 |
| 共享内存 | 70% | System V 基本语义 |
| 内核库 | 80% | 基础功能齐全 |
| **总体** | **~77%** | 功能覆盖面广，部分模块依赖第三方库 |

---

## 6. 设计创新性分析

### 6.1 C++23 内核开发

项目选择 C++23 作为内核开发语言，这在 OS 内核项目中较为少见。通过禁用异常和 RTTI、重载全局 `new`/`delete` 运算符、实现 C++ ABI 支持函数，在保持内核自由环境特性的同时利用了 C++ 的面向对象特性。文件类型体系（`file` 基类 + 多种派生类）和 VFS 虚拟文件提供者（`VirtualContentProvider` 基类 + 多种内容生成器）都体现了 C++ 多态的优势。

### 6.2 双架构支持

同时支持 RISC-V 和 LoongArch 两种指令集架构，通过条件编译（`#ifdef RISCV` / `#elif defined(LOONGARCH)`）和架构特定子目录实现。这种设计在教学和竞赛场景中具有实用价值。

### 6.3 EASTL 集成

使用 EA STL（Electronic Arts Standard Template Library）作为内核中的标准模板库，提供了 `eastl::string`、`eastl::unordered_map`、`eastl::vector`、`eastl::unique_ptr` 等容器和智能指针，显著提升了代码的表达力和开发效率。

### 6.4 虚拟文件系统（procfs 风格）

在内核中实现了类似 Linux procfs 的虚拟文件系统，通过 `VirtualContentProvider` 抽象基类动态生成 `/proc/meminfo`、`/proc/cpuinfo`、`/proc/version` 等内容，这对于 BusyBox 等用户空间工具的兼容性非常重要。

### 6.5 统一的进程内存管理器

`ProcessMemoryManager` 将进程的地址空间管理（程序段、堆、VMA、页表）统一封装，通过引用计数支持线程间地址空间共享（`CLONE_VM`），设计思路接近 Linux 的 `mm_struct`。

---

## 7. 其他项目信息

### 7.1 代码质量观察

- 代码注释以中文为主，包含大量调试输出（`printfRed`/`printfGreen` 等彩色打印）
- 存在部分调试性质的文件名（如 `fucky