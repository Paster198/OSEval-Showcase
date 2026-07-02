# AuroraKernel 深入技术分析报告

## 一、分析范围与方法

本报告基于对仓库全部源文件的系统化阅读与分析。分析覆盖了以下维度：

1. **完整源代码审阅**：逐个审阅了全部约 40,509 行源文件（C、汇编、头文件、链接脚本）。
2. **架构契约层**：`include/arch/` 中 9 个头文件中全部 `static inline` 函数的语义分析。
3. **子系统实现**：进程管理、内存管理、文件系统、系统调用、设备抽象、基础库共计 6 大共享子系统的逐文件分析。
4. **双架构后端**：RISC-V 后端（约 599 行）与 LoongArch64 后端（约 5,565 行）的逐模块对比。
5. **构建系统**：顶层 Makefile、公共配置、RISC-V 和 LoongArch64 各自的 Makefile 分析。
6. **用户态**：initcode、系统调用封装库、测试入口的分析。

注意：本报告未包含实际运行测试，因为环境中的 QEMU 工具需要特定文件系统镜像和用户态二进制负载，这些在当前分析环境中不可用。

---

## 二、项目总览

| 属性 | 值 |
|------|----|
| 内核类型 | 宏内核（Monolithic Kernel） |
| 目标架构 | RISC-V 64-bit (rv64gc)、LoongArch64 |
| 源代码规模 | ~40,509 行（含 C、汇编、头文件） |
| 共享核心层 | ~23,968 行 C |
| RISC-V 后端 | ~599 行（C + 汇编） |
| LoongArch64 后端 | ~5,565 行（C + 汇编） |
| 用户态 | ~1,852 行 |
| 架构抽象头文件 | ~1,059 行 |
| 页表模型 | RISC-V: Sv39 三级页表；LoongArch64: LA64 三级页表 + DMW 直接映射窗口 |
| 最大进程数 | 64 (NPROC) |
| 文件系统 | FAT32（读写）、EXT4（只读）、VFS 抽象层、pipe、procfs、memfile |
| 设备模型 | VirtIO-MMIO (RISC-V)、VirtIO-PCI (LoongArch64) |

---

## 三、架构抽象契约层详细分析

### 3.1 设计模式

AuroraKernel 的双架构支持通过 `include/arch/` 下的 9 个头文件实现。其核心设计模式是：**条件编译 + static inline 函数**。

```c
// 典型模式（摘自 include/arch/trapframe.h）
static inline uint64 arch_tf_user_pc(const trapframe_t *tf)
{
#if defined(__loongarch64)
    return tf->era;      // LA: ERA CSR
#else
    return tf->epc;      // RV: EPC CSR
#endif
}
```

这种模式允许共享内核代码（`kernel/proc/`、`kernel/syscall/`、`kernel/fs/` 等）通过调用 `arch_*` 前缀的函数，无需任何条件编译即可跨架构工作。

### 3.2 契约文件功能矩阵

| 契约文件 | 提供的函数 | RISC-V 后端 | LoongArch64 后端 |
|----------|-----------|------------|-----------------|
| `cpu.h` | `arch_cpu_id()` | `r_tp()` | CSR CPUID 读取 |
| `intr.h` | `arch_intr_on/off/get/push/pop` | SSTATUS SIE 控制 | CRMD IE 控制 |
| `mmu.h` | `arch_mmu_page_token/write_token/flush_tlb/current_token` | SATP 操作 + `sfence_vma` | 全部为 stub（返回 0），TLB 使用 `invtlb` |
| `proc.h` | `arch_proc_context_init/kstack_base/trapframe_*/prepare_user_return/user_return` | 基于 `memlayout.h` KSTACK 宏 + `trap_user_return()` | 委托给 `la_proc_*` 外部函数 |
| `syscall.h` | `arch_syscall_is_user_trap/advance_tf_user_pc/tf_number/tf_arg/set_return/advance_user_pc` | 检查 trap code == 8（U-mode ecall） | 检查 trap code == 0xb（LA syscall） |
| `trapframe.h` | `arch_tf_*` 全部 trapframe 访问器 (约 20 个函数) | 字段名 `epc`, `kernel_satp`, `kernel_sp` 等 | 字段名 `era`, `kernel_token`, `kernel_stack` 等 |
| `trapframe_types.h` | 定义 `trapframe_t` 结构体 | 40 字段 RISC-V trapframe（280 字节） | 32 字段 LA trapframe（320 字节），含 `kernel_metadata_valid` 守卫字段 |
| `time.h` | `arch_time_now/schedule_next/enable_supervisor_timer/clear_timer_interrupt` | SBI `set_timer` + RDTIME | `rdtime.d` + TCFG CSR + ECFG CSR |
| `trap.h` | `arch_trap_set_vector/enable_hart_interrupts/code/is_interrupt/from_kernel/saved_pc/status/cause/value/set_saved_pc/set_status` + `arch_trap_clear_software_interrupt` | STVEC/SSTATUS/SCAUSE/SEPC/STVAL + SBI 软件中断清除 | EENTRY/ECFG/ESTAT/ERA/BADV + IOCSR 中断清除 |

### 3.3 关键架构差异处理

**MMU 差异**：
- RISC-V 使用 SATP CSR 保存根页表物理地址。LoongArch64 不使用 SATP 等价物，而是配置 DMW (Direct Mapping Window) 寄存器实现内核直接映射，并通过 PGD CSR 配置用户页表基址。在 `mmu.h` 中，LA 的 `arch_mmu_page_token()` 和 `arch_mmu_write_token()` 直接返回 0/空操作——这意味着共享层对 MMU 令牌的操作在 LA 上变为 no-op。

**Trapframe 差异**：
- RISC-V trapframe 包含 `kernel_satp`、`kernel_sp`、`kernel_trap`、`kernel_hartid` 4 个内核元数据字段。
- LA trapframe 包含 `kernel_token`、`kernel_stack`、`kernel_trap`、`kernel_cpu_id`、`kernel_metadata_valid` 5 个字段，其中 `kernel_metadata_valid` 作为守卫验证返回元数据的完整性。

**进程上下文差异**：
- RISC-V 的 `context_t` 包含 14 个 callee-saved 寄存器 (ra, sp, s0-s11)。
- LA 的 `context_t` 用 `fp` 替代了 RISC-V 的 `s9`, `s10`, `s11`，共计 12 个寄存器。

---

## 四、进程管理子系统

### 4.1 总体架构

进程管理子系统由以下文件组成（共享层 + 架构后端配合）：

| 文件 | 代码行数 | 职责 |
|------|----------|------|
| `kernel/proc/proc.c` | 1,549 | 进程生命周期核心（fork/clone/execve/exit/wait）、第一个进程创建、fork_return |
| `kernel/proc/exec.c` | 1,020 | ELF 加载器，支持 FAT32/VFS/EXT4/memfile 多路径 |
| `kernel/proc/scheduler_core.c` | 116 | 调度器核心：进程选择、入队、上下文切换调度 |
| `kernel/proc/table.c` | 104 | 进程表存储与槽位管理 |
| `kernel/proc/child_lifecycle.c` | 275 | 子进程生命周期策略：槽位预留/释放、wait 匹配、kill 验证 |
| `kernel/proc/exit_lifecycle.c` | 42 | 进程退出状态管理（zombie 标记、wait_status 编码） |
| `kernel/proc/fd_table.c` | 126 | 文件描述符表管理 |
| `kernel/proc/pid.c` | 40 | PID 分配器 |
| `kernel/proc/defaults.c` | 58 | 进程默认字段初始化 |
| `kernel/proc/cpu.c` | 33 | 每 CPU 数据结构（当前进程引用） |

### 4.2 proc_t 结构体分析

`proc_t` 共约 50 个字段，按功能可分为：

- **调度状态**：`lk`（自旋锁）、`state`（6 状态机）、`kstack`、`ctx`
- **身份标识**：`pid`、`parent`、`pgid`、`sid`、`gid`、`egid`、`supp_groups[]`
- **内存空间**：`pgtbl`、`heap_top`、`ustack_pages`、`mmap`、`mmap_alloc`、`shared_vm`、`vm_owner`
- **文件与 I/O**：`filelist[128]`、`fd_flags[128]`、`cwd`、`cwd_path`、`exe_path`
- **trapframe 相关**：`tf`、`arch_fd_owner`
- **信号处理**：`sig_mask`、`sig_actions[64]`、`pending_signal`、`in_signal`、`sig_frame_sp`、`sigcancel_ready`、`killed`
- **线程/Futex**：`clear_child_tid`、`robust_list_head`、`robust_list_len`、`pthread_base`
- **资源限制**：`rlimit_cur[16]`、`rlimit_max[16]`
- **其他**：`sleep_space`、`exit_state`、`umask`

### 4.3 进程状态机

```
UNUSED → USED → RUNNABLE ↔ RUNNING → ZOMBIE → UNUSED
                   ↑           ↓
                   +—— SLEEPING ←+
```

`USED` 状态是新增的中间状态，用于标记已分配但未入队的进程槽位（如 clone 创建的子进程在 `proc_child_slot_reserve` 后处于 USED 状态，需调用者显式入队）。

### 4.4 fork/clone 实现

- **proc_fork(uint64 stack)**：复制当前进程的地址空间（通过 `uvm_copy_pgtbl`），创建子进程。子进程的上下文入口设置为 `fork_return`。
- **proc_clone(flags, stack, ptid, tls, ctid)**：支持 CLONE_VM（共享地址空间，通过 `uvm_share_pgtbl`）和 CLONE_VFORK 等标志。对于 CLONE_VM，设置 `shared_vm=1` 并建立 `vm_owner` 链接。参数顺序在不同架构上有所差异（RISC-V 和 LA 的 tls/ptid 寄存器映射不同）。

### 4.5 调度器

调度器采用**简单轮询（Round-Robin）** 算法：

```c
// scheduler_core.c - 调度器核心循环
proc_t *proc_scheduler_pick_runnable_from(cpu_t *c, proc_t *start) {
    for (p = start; p < proc_table_end(); p++) {
        spinlock_acquire(&p->lk);
        if (p->state == RUNNABLE) {
            p->state = RUNNING;
            proc_set_current(c, p);
            return p;
        }
        spinlock_release(&p->lk);
    }
    return 0;
}
```

每次调用 `swtch()` 执行上下文切换，将当前 CPU 上下文与目标进程上下文交换。切换后释放进程锁。在 RISC-V 端，首次创建进程通过 `proc_scheduler_run_prepared_once` 来保证新进程一定会被选中运行。

### 4.6 ELF 加载器

`exec.c` 中的 ELF 加载器是一个显著改进点。它通过 `exec_file_t` 抽象统一了四种文件来源：

1. **FAT32**：通过 `fat32_namei()` + `fat32_read()`
2. **VFS/EXT4**：通过 `ext4_path_resolve()` + `ext4_read_file()`
3. **memfile**：通过 `memfile_open()` + `memfile_read()`
4. **动态链接器别名**：自动将 `/lib/ld-musl-riscv64-sf.so.1` 等路径映射到 `/musl/lib/libc.so`

加载器还实现了：
- Shebang (`#!`) 解释器支持
- 动态链接器自动加载（PT_INTERP 段解析）
- 辅助向量（AT_PHDR、AT_PHENT、AT_PHNUM、AT_PAGESZ、AT_BASE、AT_ENTRY）设置
- 用户栈上的 argv/envp 布局
- 栈 canary（随机生成）

---

## 五、内存管理子系统

### 5.1 总体架构

内存管理分为三层：

| 层 | 文件 | 职责 |
|----|------|------|
| 物理页分配 | `pmem.c` | 空闲链表管理、内核/用户分区、引用计数 |
| 内核虚拟内存 | `kvm.c` | 内核页表初始化、设备 MMIO 映射、内核栈映射 |
| 用户虚拟内存 | `uvm.c` | 用户页表管理、fork 复制/共享、mmap/munmap、缺页处理 |
| mmap 区域管理 | `mmap.c` | mmap_region 空闲链表分配/释放 |
| 内核内存分配 | `kmalloc.c` | 基于空闲链表的小块内核内存分配器 |

而 LoongArch64 后端还有自己的内存管理补充：

| 文件 | 职责 |
|------|------|
| `mm/layout.c` | 链接器符号与直接映射地址转换 |
| `mm/memory_discovery.c` | 从 FDT (Flattened Device Tree) 解析可用内存区域 |
| `mm/memory_map.c` | 内存区域验证与冲突检测 |
| `mm/vm.c` | LA64 页表操作（vm_getpte/mappages/unmappages） |
| `mm/pmem_boot.c` | 启动期物理页初始化 |
| `mm/address.c` | 物理-DMW 直接映射地址转换 |

### 5.2 物理页分配器

`pmem.c` 实现了双区域分配器：

```c
static alloc_region_t kern_region, user_region;
```

- 内核区域占物理内存的 1/16（最少 1024 页），用户区域占其余部分
- 每个区域维护独立的空闲链表和自旋锁
- 实现了引用计数机制（`page_refs[]`），支持页面共享（用于 CLONE_VM 和 MAP_SHARED）

关键 API：
- `pmem_alloc(bool in_kernel)`：分配一个零填充页
- `pmem_free(uint64 page, bool in_kernel)`：释放页（引用计数减至 0 时回收）
- `pmem_ref_page(uint64 page, bool in_kernel)`：增加引用计数

### 5.3 虚拟内存管理

**RISC-V 端（kvm.c）**：
- 使用标准 Sv39 三级页表
- 内核页表映射：UART、VIRT_TEST、VirtIO、CLINT、PLIC、内核代码段、内核数据段、trampoline、每个进程的内核栈（含 guard 页）
- 页表遍历 `vm_getpte` 支持按需分配中间页表

**LoongArch64 端（mm/vm.c）**：
- 同样使用三级页表结构，但 PTE 编码不同：
  ```c
  pte_t pte = PA_TO_PTE(pa) | LA_PTE_V | LA_PTE_D | LA_PTE_MAT_CC | LA_PTE_P;
  if (perm & PTE_U) pte |= LA_PTE_PLV3;  // 用户态特权级
  ```
- 每次映射/解映射后调用 `la_invalidate_tlb_all()` 刷新 TLB

### 5.4 用户态地址空间布局

```
+------------------+  VA_MAX (1<<38)
|    TRAMPOLINE    |  1 page  (用户/内核切换代码)
+------------------+
|    TRAPFRAME     |  1 page  (trap 上下文暂存)
+------------------+
|  KSTACK[NPROC-1] |  2+1 pages × NPROC (内核栈含guard)
|       ...        |
|     KSTACK[0]    |
+------------------+
|  USER_STACK_TOP  |
|    user stack    |  默认 1 page，按需增长
+------------------+
|    MMAP_END      |
|    mmap region   |  8096 pages (~32MB)
|   MMAP_BEGIN     |
+------------------+
|    heap          |  动态增长
|   heap_top       |
+------------------+
|   code + data    |  可变大小
+------------------+
|   guard page     |  1 page (不可访问)
+------------------+  USER_BASE (0x1000)
```

### 5.5 mmap 实现

uvm.c 中的 mmap 实现采用了**空闲区间链表**策略：

1. 进程的 `mmap` 链表维护所有可映射的空闲区间
2. `uvm_mmap_recorded` 从空闲链表中切分出请求的区域
3. `uvm_mmap_handle_fault` 按需分配物理页（延迟分配），支持匿名映射和文件映射
4. `uvm_munmap` 释放映射区域并合并回空闲链表

合并逻辑全面处理了四种切分情况：完全匹配、开头相同、结尾相同、中间切分（需创建新节点）。

---

## 六、文件系统子系统

### 6.1 总体架构

文件系统是 AuroraKernel 中代码量最大的子系统（约 8,965 行），实现了多层抽象：

```
应用层（libc open/read/write）
        ↓
   系统调用层 (syscall/sysfile.c)
        ↓
   VFS 抽象层 (fs/vfs.c + fs/file.c)
    ↙        ↓        ↘
 FAT32    EXT4    伪文件系统
(读写)   (只读)   (pipe/procfs/memfile/dev)
```

### 6.2 VFS 抽象层

**文件系统注册与探测**（`kernel/fs/vfs.c`）：

```c
struct vfs_fs_type {
    const char *name;
    int  (*probe)(buf_t *sector0);
    int  (*mount)(struct vfs_super_block *sb);
    struct vfs_fs_type *next;
};
```

- 启动时注册 FAT32 和 EXT4 两种文件系统类型
- 探测引擎读取磁盘扇区 0 并依次调用各类型的 `probe` 函数
- FAT32 探测：检查 `bytes_per_sector == 512` 且 `fat_count > 0`
- EXT4 探测：读取扇区 2（superblock 位于偏移 1024），检查 `s_magic == 0xEF53`

**VFS 操作表**：

定义了三层操作表：
- `vfs_super_operations`：超级块操作（read_inode、write_inode、statfs、sync_fs）
- `vfs_inode_operations`：inode 操作（lookup、create、link、unlink、mkdir、rmdir、rename、readlink、symlink）
- `vfs_file_operations`：文件操作（open、read、write、flush、release、fsync、llseek）

### 6.3 FAT32 实现

FAT32 是一个全功能的读写实现（约 1,792 行），包括：

- **BPB 解析**：启动扇区读取、FAT 表定位、数据区计算
- **簇链遍历**：`next_cluster()` 从 FAT 表读取下一簇号
- **节点缓存**：32 个条目的固定大小缓存，基于 first_cluster 索引
- **目录遍历**：`fat32_dirlookup()` 按 8.3 文件名查找
- **文件读写**：`fat32_read()` 和 `fat32_write()` 支持跨簇读/写
- **文件创建/删除**：`fat32_create()`、`fat32_unlink()`
- **簇分配/释放**：`fat32_alloc_cluster()` 搜索空闲簇
- **长文件名（LFN）支持**：`fat32_lfn_entry` 结构处理，读取 Unicode 长文件名

### 6.4 EXT4 实现

EXT4 是只读实现（约 1,497 行），主要参考 lwext4 库。功能包括：

- **超级块解析**：完整解析 1024 字节的超块结构体
- **块组描述符**：支持 32 和 64 字节两种大小
- **Inode 读取**：从 inode 表读取指定 inode 号的结构体
- **多级 Extent 树**：实现了 Extent Header → Extent Index → Extent Leaf 的三级搜索
- **目录遍历**：EXT4 目录项迭代，支持线性目录和 HTree 索引目录
- **路径解析**：`ext4_path_resolve()` 逐级解析路径名
- **文件读取**：`ext4_read_file()` 支持跨块边界读取
- **元数据缓存**：inode 缓存（128 项）、lookup 缓存（128 项）、目录块缓存（16 项）

### 6.5 管道实现

`kernel/fs/pipe.c` 实现了标准 UNIX pipe：
- 环形缓冲区（PIPESIZE 字节）
- 阻塞读写（reader 等待 writer，writer 等待 reader）
- `pipeclose` 处理读端/写端关闭
- `pipe_poll` 支持 POLLIN/POLLOUT/POLLHUP 事件
- `pipe_poll_sleep` 支持带超时的轮询等待

### 6.6 memfile 实现

`kernel/fs/memfile.c` 实现了内存中的文件系统（约 832 行），用于：
- `/etc/passwd` 等 LTP 测试所需的配置文件
- 最多 32 个文件，每个最大 1MB
- 支持文件、目录、白名单条目（用于 overlay 删除标记）
- 支持 hard link、mkdir、unlink 操作
- umask 支持

### 6.7 procfs 实现

`kernel/fs/file_procfs_light.c` 提供了 proc 文件系统的轻量实现：
- `/proc/meminfo`：返回伪内存统计
- `/proc/mounts`：返回挂载点信息
- `/proc/uptime`：系统运行时间
- `/proc/sys/kernel/pid_max`：PID 上限
- `/proc/<pid>/stat`、`/proc/<pid>/cmdline`、`/proc/<pid>/status`
- `/proc/self/exe`：当前可执行文件路径

### 6.8 路径解析

`kernel/fs/namespace_path_light.c` 和 `kernel/fs/path_object_light.c` 提供了：
- `.` 和 `..` 处理
- 符号链接解析（`readlinkat`）
- VFS 路径规范化（`file_resolve_vfs_path`）
- 多文件系统路径的命名空间查找

### 6.9 设备文件

`kernel/fs/file_device.c` 和 `kernel/fs/file_regular.c` 处理设备文件：
- `/dev/console`
- `/dev/null`
- `/dev/zero`
- `/dev/urandom`、`/dev/random`
- `/dev/rtc`、`/dev/rtc0`

---

## 七、系统调用子系统

### 7.1 总体架构

系统调用层分为两个调度路径：

**RISC-V 路径**：传统跳转表
```c
static uint64 (*syscalls[])(void) = {
    [SYS_exec]    sys_exec,
    [SYS_brk]     sys_brk,
    [SYS_mmap]    sys_mmap,
    ...
};
```
通过 `syscall()` 函数从 `myproc()->tf` 读取参数，调用跳转表中的函数。

**LoongArch64 路径**：`syscall_dispatch_light_number`
```c
static int syscall_dispatch_light_number(int num, trapframe_t *tf, uint64 *ret) {
    switch (num) {
    case SYS_exec:
    case SYS_execve:
        *ret = la_shared_execve_from_trapframe(tf);
        return 1;
    ...
    }
}
```
LA 端因为 trap 处理路径不同（没有进入共享的 `syscall()` 函数），所以需要单独的 dispatch 路径。它直接操作 trapframe。

### 7.2 系统调用覆盖

总共约 90+ 个系统调用号，按类别分：

| 类别 | 系统调用 | 实现文件 |
|------|---------|----------|
| 进程 | fork, clone, exec, execve, exit, exit_group, wait, wait4 | sysproc.c, syscall.c |
| 内存 | brk, mmap, munmap, mprotect, madvise, msync | sysproc_mem_common.c, sysproc_mem_light.c |
| 文件 | open, openat, read, readv, write, writev, pread64, lseek, close, dup, dup3, fcntl, fstat, newfstatat, statx, statfs, fstatfs, getdents64, getcwd, chdir, mkdir, mkdirat, link, linkat, unlink, unlinkat, renameat, renameat2, mount, umount, readlinkat, faccessat, utimensat, sendfile64, ioctl, pipe2 | sysfile.c, sysfile_light.c |
| Socket | socket, bind, listen, accept, connect, getsockname, getpeername, sendto, recvfrom, setsockopt, getsockopt | sysfile_socket_light.c |
| 信号 | kill, tkill, rt_sigaction, rt_sigprocmask, rt_sigtimedwait | sysproc_signal_common.c, sysproc_control_light.c |
| Futex | futex (wait/wake/requeue, 含 PI 和 PRIVATE 标志) | sysproc_futex_light.c |
| 时钟/时间 | clock_gettime, clock_nanosleep, gettimeofday, times, nanosleep, sysinfo | sysproc_time_light.c |
| 身份 | getpid, getppid, getuid, geteuid, getgid, getegid, gettid | sysproc_identity.c |
| 杂项 | uname, sched_yield, shutdown, set_tid_address, set_robust_list, get_robust_list, prlimit64, getrandom, membarrier, syslog | sysproc_control_light.c, sysproc_misc.c, sysproc_runtime_metadata_light.c |

### 7.3 Futex 实现

`sysproc_futex_light.c`（200 行）实现了较为完整的 futex 机制：

- **FUTEX_WAIT**：拷贝用户态值、验证相等性、在 futex 地址上睡眠
- **FUTEX_WAKE**：唤醒最多指定数量的等待者
- **FUTEX_REQUEUE**：将等待者从一个 futex 转移到另一个（支持 CMP_REQUEUE）
- **超时支持**：绝对和相对超时（基于 `arch_time_now()` 定时器 tick）
- **信号中断**：检查 `SIGCANCEL` 挂起信号

### 7.4 Socket 模拟

`sysfile_socket_light.c`（903 行）提供了 socket 系统调用的 stub 实现：
- 所有 socket 操作返回 `-ENOTSOCK(88)` 或 `-EOPNOTSUPP(95)`
- 用于满足 libc-test 和 LTP 测试框架对 socket 系统调用存在性的检查

### 7.5 "Light" 后缀文件的含义

`_light` 后缀表示该文件是**轻量兼容层**，提供足以让测试框架通过的 stub 或简化实现，而不是完整的 Linux 语义。例如：
- `sysfile_light.c`：通过 trapframe 直接处理文件系统调用（用于 LA 路径）
- `sysproc_control_light.c`：信号和进程控制 stub（uname 返回固定字符串，sched_yield 直接调用 proc_yield）
- `sysproc_time_light.c`：时钟相关 stub

---

## 八、Trap 处理子系统

### 8.1 RISC-V Trap 路径

**内核态 trap**：
```
kernel_vector (trap.S)
  → 保存 32 个通用寄存器到内核栈
  → trap_kernel_handler()
    → 中断：timer (→ timer_interrupt_handler + proc_yield)
            软件中断 (clear)
            外部中断 (PLIC: UART + VirtIO)
    → 异常：panic
  → 恢复寄存器
  → sret
```

**M-mode 时钟中断**：
```
timer_vector (trap.S)
  → 更新 CLINT_MTIMECMP
  → 触发 S-mode 软件中断 (sip=2)
  → mret
```

**用户态 trap**：
```
user_vector (trampoline.S)
  → 保存用户寄存器到 p->trapframe
  → 切换到内核页表 (SATP)
  → 跳转到 trap_user_handler()
    → 系统调用：syscall() 分发
    → 缺页：uvm_mmap_handle_fault()
    → 时钟中断：proc_yield()
  → user_return(trapframe, pgtbl)
    → 切换到用户页表
    → 恢复寄存器
    → sret
```

### 8.2 LoongArch64 Trap 路径

**异常入口**（`trap/trap_entry.S`）：
```
la_exception_entry
  → SELECT_TRAPFRAME 宏：用户态 trap 从当前进程获取 tf，内核态用栈上空间
  → 保存 32 个通用寄存器 + ERA/PRMD/ESTAT/BADV
  → 如果是用户态 trap，切换到内核栈
  → la_trap_handle(tf)
  → 恢复所有寄存器 + ERA/PRMD
  → ertn (异常返回)
```

**TLB Refill**（`trap/tlb_refill.S`）：
```
la_tlb_refill_entry (3 级遍历，DMW 直接映射窗口)
  → CSR_PGD → lddir(level 3) → lddir(level 2) → lddir(level 1)
  → ldpte(0), ldpte(1) → tlbfill

la_shared_tlb_refill_entry (2 级遍历，用户态页表)
  → CSR_PGD → lddir(level 2) → lddir(level 1)
  → ldpte(0), ldpte(1) → tlbfill
```

**用户态返回**（`trap/user_return.S`）：
```
la_user_return(tf)
  → 从 tf 恢复 ERA, PRMD
  → 恢复 32 个通用寄存器
  → ertn
```

### 8.3 LA Trap 处理分发

`la_trap_handle()` 按优先级分发：
1. 外部中断（PCIe IRQ）
2. 时钟中断
3. 系统调用（ecode == 0xb → `syscall_dispatch_light_number`）
4. 缺页异常（→ `uvm_mmap_handle_fault`）
5. 未识别 trap → panic

---

## 九、设备抽象层

### 9.1 块设备层

`kernel/dev/block.c`（43 行）定义了块设备操作接口：

```c
typedef struct {
    void (*rw)(struct buf *buf, bool write);
} block_device_ops_t;
```

- 支持单个块设备的注册
- RISC-V 端使用 VirtIO-MMIO（`kernel/dev/virtio.c`），通过 PCI 不可知的总线连接
- LoongArch64 端使用 VirtIO-PCI（`kernel/arch/loongarch64/storage/virtio_pci_*.c`）

### 9.2 LoongArch64 存储子系统

LA 后端的存储子系统包括：

| 文件 | 职责 |
|------|------|
| `pci.c` | PCI ECAM 扫描器：枚举 bus 0 上的设备，查找 VirtIO 块设备 |
| `virtio_pci_config.c` | VirtIO PCI 能力解析：common/notify/isr/device 配置区域 |
| `virtio_pci_queue.c` | VirtIO 队列管理：描述符表、available ring、used ring |
| `virtio_pci_block.c` | VirtIO 块设备驱动：扇区读写、中断处理、设备注册 |
| `ext4_probe.c` | EXT4 直接探针：绕过 VFS 直接从磁盘读取并挂载 EXT4 |
| `ext4_probe_dir.c` | EXT4 目录遍历探针 |
| `ext4_probe_lookup.c` | EXT4 路径查找探针 |
| `ext4_probe_read.c` | EXT4 文件读取探针 |

LA 端的 EXT4 探针（`ext4_probe_*.c`）是一个**独立于共享层 ext4.c 的完整 EXT4 实现**（约 2,269 行），用于启动阶段直接从 VirtIO-PCI 块设备探测并加载根文件系统。这暗示了共享层 ext4.c 和 LA 的 ext4_probe 之间存在功能重复，可能是开发过程中的两个阶段（早期 LA 专用探针 → 后来统一到共享层的 ext4.c）。

### 9.3 VirtIO 块设备对比

| 特性 | RISC-V (dev/virtio.c) | LoongArch64 (storage/virtio_pci_*.c) |
|------|----------------------|-------------------------------------|
| 传输模式 | VirtIO-MMIO | VirtIO-PCI (Modern/Transitional) |
| 队列数量 | 1 个请求队列 | 1 个请求队列 (queue 0) |
| 中断处理 | 通过 PLIC | 通过 EXTIOI + LS7A 中断控制器 |
| 扇区大小 | 512 字节 | 512 字节 |
| PCI 枚举 | 不需要 | ECAM 扫描 bus 0 全部 32 设备 |
| BAR 分配 | 不需要 | BAR 0 (MEM64) 大小探测 + MMIO 地址分配 |
| 设备特性协商 | 固定 | VIRTIO_F_VERSION_1 等特性协商 |

---

## 十、基础库

| 文件 | 职责 |
|------|------|
| `kernel/lib/spinlock.c` | 自旋锁：`spinlock_init/acquire/release/holding`，使用 `__sync_lock_test_and_set` |
| `kernel/lib/sleeplock.c` | 睡眠锁：`sleeplock_init/acquire/release/holding`，在竞争时调用 `proc_sleep` |
| `kernel/lib/print.c` | 格式化输出：`printf` 支持 %d/%x/%p/%s/%c/%l/%n，通过 UART 输出 |
| `kernel/lib/str.c` | 字符串操作：`strlen/strcmp/strncmp/strncpy/strlcpy/memset/memmove/strchr` |

---

## 十一、双架构对比总结

| 维度 | RISC-V 64 | LoongArch64 |
|------|-----------|-------------|
| 系统调用 trap | ecall from U-mode (code=8) | syscall (ecode=0xb) |
| MMU 模型 | Sv39 (SATP-based) | LA64 三级页表 + DMW 直接映射窗口 |
| TLB 管理 | sfence_vma | invtlb 指令 |
| 时钟 | SBI set_timer + CLINT | rdtime.d + TCFG CSR |
| 中断控制器 | PLIC | LS7A INT + EXTIOI (IOCSR) |
| 块设备 | VirtIO-MMIO | VirtIO-PCI |
| 上下文切换 | swtch 保存 14 个 callee-saved 寄存器 | swtch 保存 12 个寄存器（fp 代替 s9/s10/s11） |
| 用户态返回 | trampoline + sret | user_return + ertn |
| 内核入口 | M-mode → S-mode (start.c) | DMW 直接映射 + _entry |
| 异常入口 | kernel_vector/user_vector | la_exception_entry |
| 内核栈 | 2 页 + 1 guard 页，通过 KSTACK(id) 分布 | 2 页 + 1 guard 页，通过 la_proc_kstack_base(id) 分布 |
| 内存发现 | 链接脚本定义 ALLOC_BEGIN/END | FDT 解析 + 冲突检测 |
| 早期串口 | SBI console_putchar / ns16550a UART | 直接 MMIO 0x1fe001e0 (ns16550a) |

---

## 十二、内核各子系统交互

### 12.1 启动流程

**RISC-V**：
```
_entry.S → start.c → main()
  → sbi_console_putchar → print_init → pmem_init → kvm_init → kvm_inithart
  → trap_kernel_init → trap_kernel_inithart → mmap_init → virtio_disk_init
  → proc_init → file_init → mount_init → timer_init → arch_intr_on
  → proc_make_first → proc_scheduler
```

**LoongArch64**：
```
_entry.S → la_boot_main()
  → la_boot_info_init → la_mm_discover_boot_memory_candidates
  → la_mm_validate_boot_memory_candidates → la_mm_promote_boot_memory_candidates
  → la_platform_init_cpu → la_mm_validate_allocator_range
  → la_pmem_boot_init_if_enabled → mmap_init → file_init → mount_init
  → light_runtime_install → proc_init → la_irq_init
  → la_virtio_pci_block_probe → la_boot_enter_shared_scheduler
    → proc_pid_reserve_min → timer_create → timer_init
    → proc_make_first → proc_scheduler
```

### 12.2 系统调用路径

```
用户程序 (ecall/syscall)
    ↓
trap 入口 (user_vector / la_exception_entry)
    ↓
trap_user_handler / la_trap_handle
    ↓
syscall() / syscall_dispatch_light_number
    ↓
各 sys_* 函数
    ↓
内核子系统 (proc/fs/mem)
    ↓
arch_tf_set_return → 用户态返回
```

### 12.3 文件系统交互

```
系统调用 (SYS_open / SYS_read 等)
    ↓
sysfile.c / sysfile_light.c
    ↓
file.c (file_t 抽象)
    ↓
    ├── FAT32: fat32_namei / fat32_read / fat32_write
    ├── EXT4:  ext4_path_resolve / ext4_read_file (共享层)
    │   └── ext4_blockdev_glue → buf_read / buf_release
    ├── Pipe: pipealloc / piperead / pipewrite
    ├── procfs: file_from_proc
    ├── memfile: memfile_open / memfile_read / memfile_write
    └── 设备: console / null / zero / urandom / rtc
    ↓
Buffer Cache (buf.c)
    ↓
块设备 (virtio.c / virtio_pci_block.c)
```

---

## 十三、实现完整度评估

### 13.1 各子系统完整度

| 子系统 | 完整度 | 评估依据 |
|--------|--------|----------|
| 进程管理 | 85% | fork/clone/exec/exit/wait 生命周期完整，clone 支持 CLONE_VM/CLONE_VFORK；缺少 cgroup、namespace、完整信号递送框架 |
| 内存管理 | 80% | 物理页分配、虚拟内存、mmap/munmap 功能齐备；缺 COW（写时复制）、swap、NUMA、大页支持 |
| 文件系统 (FAT32) | 90% | 读写、目录、LFN 均实现；缺少 FAT12/16、exFAT、权限检查、文件锁 |
| 文件系统 (EXT4) | 60% | 只读、inode/目录/extent 树均实现；缺少写操作、日志、HTree 完整支持、扩展属性 |
| VFS 抽象 | 75% | 框架完整，支持注册/探测/挂载；操作表尚未被统一使用，新旧路径并存 |
| 系统调用 | 70% | ~90+ 系统调用，覆盖进程/文件/内存/socket/futex；大量 stub 实现，缺乏完整 POSIX 语义 |
| 调度器 | 40% | 简单轮询，无优先级、无 CFS、无多核负载均衡、无可配置时间片 |
| 设备驱动 | 60% | VirtIO 块设备完善（双架构）；缺少网络驱动（只有 PCI 网卡设备声明）、缺少 USB、显示 |
| 同步原语 | 60% | 自旋锁、睡眠锁、futex 基本实现；缺少读写锁、RCU、完成量、信号量 |
| 中断处理 | 70% | RISC-V PLIC + LA EXTIOI 均实现；LA 端为单核、未实现 IPI |
| 架构抽象 | 80% | 9 个契约文件覆盖 MMU/进程/系统调用/trap/时间/中断；LA 和 RV 路径在 syscall dispatch 上尚未完全统一（存在 syscall_dispatch_light_number vs syscalls[] 两套代码路径） |

### 13.2 整体完整度

以 xv6 为基准（60%），以 Linux 为基准（约 8%）。AuroraKernel 处于"比赛级教学内核"水平：
- **已具备**：完整进程模型、双文件系统、基本 VFS、mmap、信号、futex、双架构
- **显著缺失**：多核调度优化、写时复制、完整网络栈、设备树统一管理、用户权限模型

---

## 十四、设计创新性分析

### 14.1 架构契约层模式（创新点：中）

通过 `include/arch/` 中的 `static inline` 条件编译函数作为架构差异契约，是一个有效的设计选择。这种模式介于"头文件宏"和"完整 HAL 层"之间，代码开销小（函数在编译时内联），但共享代码仍可以看到架构相关的条件编译（如在 `proc.h` 中的 `#if defined(__loongarch64)`）。

**优势**：零函数调用开销、编译时类型检查、共享代码无需 `#ifdef`。
**局限**：新增第三架构需要修改所有契约文件、无法在运行时切换架构、契约扩展需要修改头文件。

### 14.2 exec 多路径文件抽象（创新点：中）

`exec_file_t` 联合体统一了 FAT32/VFS/EXT4/memfile 四种可执行文件来源，使得 ELF 加载器无需关心底层文件系统类型。类似 Linux 的 `struct file_operations` 但更轻量。

### 14.3 LoongArch64 FDT 内存发现（创新点：中低）

在 LA 后端实现了完整的 FDT 解析器（`memory_discovery.c`，569 行），从 QEMU 提供的设备树中提取可用内存区域。这比 RISC-V 端依赖链接脚本硬编码更灵活，更接近真实硬件启动流程。

### 14.4 syscall_dispatch_light 路径（创新点：低）

LA 端的 `syscall_dispatch_light_number` 本质上是将 RISC-V 的跳转表 dispatch 复制了一份用 switch-case 实现。这不是新设计，而是适配 LA trap 路径的工程折中。长期来看应该统一到同一套 dispatch 机制。

### 14.5 双文件系统共存与 VFS 框架（创新点：中）

VFS 注册/探测/挂载框架设计参考了 Arceos（Rust）的 `FilesystemOps` trait，在 C 中实现了类似的多态。FAT32（读写）和 EXT4（只读）共享同一套文件操作路径。这是相比于 xv6（单一文件系统）的显著进步。

---

## 十五、其他重要信息

### 15.1 代码引用关系

从代码注释中可以看到 AuroraKernel 参考了多个外部项目：

- **xv6-riscv** (MIT)：基础结构和调度器
- **lwext4** (BSD 2-Clause)：EXT4 超级块、inode、extent 树结构
- **Arceos/axfs-ng-vfs** (MIT/MPL-2.0)：VFS 框架设计灵感
- **T202510589995148-2209**：VFS 探针架构参考
- **T202510487995136-2371**：LA64 上下文切换 `swtch.S` 参考

### 15.2 测试负载

设计文档提到通过 `TEST_COMPONENT` 变量支持多种测试：
- **basic**：基础功能测试
- **busybox**：BusyBox 工具集
- **libctest**：musl libc 测试套件
- **ltp-musl**：Linux Test Project (musl 版本)
- **Lua**：Lua 解释器
- **iperf**：网络性能测试（仅 LA 架构有网卡设备声明）

### 15.3 安全考虑

- 用户态内核态隔离通过页表实现（U 位控制）
- 内核栈含 guard 页防止栈溢出污染
- 系统调用参数通过 `uvm_copyin` 从用户空间拷贝
- 物理页释放时填充垃圾数据（`memset(..., 1, PGSIZE)`）
- 缺少：KASLR、SMAP/SMEP（硬件特性）、更完整的能力检查

---

## 十六、总结

AuroraKernel 是一个在 xv6 基础上进行了显著扩展的教学/竞赛宏内核。其核心特点与价值在于：

1. **双架构支持**：通过 9 个架构契约头文件实现了 RISC-V 64 和 LoongArch64 的并行支持。约 24,000 行的共享核心代码在两个架构上无需修改即可编译运行。这是一项非平凡的工程成就。

2. **文件系统丰富度**：实现了 FAT32（读写）、EXT4（只读）、VFS 抽象层、pipe、procfs、memfile、设备文件的完整堆栈，超越了大多数教学内核。

3. **Linux ABI 兼容性**：通过 ~90+ 的系统调用、futex、信号、clone 等实现，达到了运行 musl libc 测试套件和部分 LTP 用例的水平。

4. **内存管理进阶特性**：mmap/munmap/mprotect、延迟分配、引用计数、CLONE_VM 共享页面、空闲区间合并等。

5. **工程化程度**：模块化目录结构、统一的构建系统（双架构共享顶层 Makefile）、架构契约的明确定义、参考来源标注。

主要不足在于：调度器过于简单、系统调用存在大量 stub、双架构的 syscall dispatch 路径尚未统一、LA 端存在新旧两套 EXT4 探针的代码重复。但这些不足在竞赛/教学内核的上下文中是可接受的。