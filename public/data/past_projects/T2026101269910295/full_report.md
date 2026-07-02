# oskernel2026-tmtos 深入技术分析报告

## 一、分析范围与方法

本报告基于对仓库全部源代码的逐文件审查，辅以必要的脚本工具进行代码规模统计。分析覆盖以下维度：

| 分析维度 | 方法 |
|---------|------|
| 构建系统 | 完整阅读 Makefile，分析编译选项、链接脚本、构建产物 |
| 内存管理 | 阅读 kalloc.c / vm.c / memlayout.h 全部实现 |
| 进程管理 | 阅读 proc.c 全部 1305 行，包含 fork/clone/wait/exit/scheduler |
| 系统调用 | 阅读 syscall.c 全部 2837 行 + sysfile.c 全部 2864 行 + sysnum.h |
| 文件系统 | 阅读 file.c、ext4_glue.c、lwext4 全部源码、pipe.c、bio.c、virtio_disk.c |
| ELF 加载器 | 阅读 exec_elf.c 全部 1386 行 |
| 测试运行器 | 阅读 teststub.c 全部 3259 行 + la_basic.c 全部 4979 行 |
| 中断/陷阱 | 阅读 trap.c、intr.c、plic.c、kernelvec.S、trampoline.S |
| 同步原语 | 阅读 spinlock.c、sleeplock.c |
| LoongArch | 阅读 main_la.c、la_lib.c、la_basic.c、la_virtio_pci.c、entry_la.S、la_trap_user.S |
| 链接脚本 | 阅读 qemu.ld、la.ld |
| 设备驱动 | 阅读 uart.c、console.c、timer.c |

---

## 二、项目概述

### 2.1 项目身份

- **名称**：oskernel2026-tmtos
- **队伍**：再来两次（内蒙古大学）
- **赛道**：2026 全国大学生计算机系统能力大赛·操作系统内核实现赛
- **代码来源**：MIT xv6-riscv → HUST-OS xv6-k210 → 剥离回 QEMU virt + 自研改造
- **总代码量**：约 49,000 行（不含文档与 lwext4 库），加上 lwext4 引入的约 16,000 行，总体约 65,000 行 C + 汇编

### 2.2 架构策略

- **RISC-V 64（主线）**：完整内核。实现了分页、进程管理、全部系统调用、EXT4 文件系统、ELF 加载器、测试运行器、完整信号与定时器支持
- **LoongArch 64（辅线）**：最小化内核。包含 virtio-pci 块设备驱动、EXT4 挂载、用户态 ELF 加载与系统调用模拟器。共享 lwext4 驱动。主要用于满足双架构要求

### 2.3 构建产物

- `kernel-rv`：RISC-V 64 位 ELF，由 `riscv64-linux-gnu-gcc` 编译，链接地址 0x80200000
- `kernel-la`：LoongArch 64 位 ELF，由 `loongarch64-linux-gnu-gcc` 编译，链接地址 0x9000000000200000

---

## 三、各子系统详细拆解

### 3.1 内存管理

#### 3.1.1 物理页分配器 (`kernel/kalloc.c`, 约 80 行)

基于 xv6 原始 `kalloc` 演化而来：

```c
// 典型 kalloc 架构：freelist 单链表，每页可分配 4096 字节
struct run { struct run *next; };
struct { struct spinlock lock; struct run *freelist; } kmem;
```

- `kinit()` 将物理内存区间 [end, PHYSTOP] (0x80200000 内核尾 → 0xC0000000) 的页面推入 freelist
- `kalloc()` 从 freelist 取一页，返回零填充的 4096 字节页面
- `kfree(void *pa)` 将页面归还 freelist
- 使用自旋锁 `kmem.lock` 保护分配器
- **无页面引用计数、无 slab/伙伴分配器、无 NUMA 感知**

#### 3.1.2 虚拟内存管理 (`kernel/vm.c`, 约 774 行)

实现完整的 Sv39 三级页表管理：

**关键函数与能力**：

| 函数 | 功能 |
|------|------|
| `kvminit()` | 创建内核页表：直映射 UART、virtio、CLINT、PLIC 等 MMIO 区域；映射内核代码段（R+X）、数据段和物理 RAM（R+W）；映射 trampoline 页面 |
| `kvminithart()` | 写 `satp` CSR 使能分页，`sfence_vma` 刷新 TLB |
| `walk(pagetable, va, alloc)` | 三级页表遍历核心函数，必要时分配中间页表页 |
| `mappages(pagetable, va, size, pa, perm)` | 以页为单位建立映射 |
| `vmunmap(pagetable, va, npages, do_free)` | 解除映射，可选释放物理页 |
| `vmunmap_maybe(...)` | `vmunmap` 的非 panic 版本（用于 clone 清理等场景） |
| `uvmalloc(pagetable, kpagetable, oldsz, newsz)` | 增长用户地址空间，同时映射到用户页表和内核页表 |
| `uvmcopy(old, new, knew, sz)` | fork 时的 copy-on-write 替代：直接拷贝物理页 |
| `uvmfree(pagetable, sz)` | 释放整个用户页表及其物理页 |
| `uvmcreate()` | 分配空页表 |
| `walkaddr(pagetable, va)` | 查询虚拟地址对应的物理地址 |
| `copyin2/copyout2/copyinstr2` | 基于当前进程 `kpagetable` 的内核侧 copy-in/out，避免使用临时 `myproc()->pagetable` 切换 |

**内存布局** (RISC-V)：

```
物理地址空间:
  0x00001000            QEMU boot ROM
  0x02000000            CLINT
  0x0C000000            PLIC
  0x10000000            UART0
  0x10001000            virtio MMIO
  0x80000000            OpenSBI (RustSBI_BASE)
  0x80200000            KERNBASE (内核加载地址)
  0xC0000000            PHYSTOP

虚拟地址空间:
  0x3F00000000L         VIRT_OFFSET (内核高地址映射偏移)
  VKSTACK=0x3EC0000000  内核栈 (每个进程 4 页, KSTACK_PAGES=4)
  TRAMPOLINE=MAXVA-PGSIZE  用户/内核跳板页
  TRAPFRAME=TRAMPOLINE-PGSIZE  陷阱帧页
  MAXUVA=0x80000000     用户态最大虚拟地址 (RUSTSBI_BASE)
```

**mmap 实现**：通过 `sys_mmap` 在进程的 `mmap_areas[]` (每个进程 32 个条目) 中记录映射区域，实际页表建立使用 `uvmalloc` 和 `mappages`。支持 `MAP_FIXED`、`MAP_ANONYMOUS`、`MAP_PRIVATE`，不支持 `MAP_SHARED` 文件映射。

**brk 实现**：`sys_brk` 直接操作 `p->brk` 和通过 `growproc()` 扩展 `p->sz`。

**munmap 实现**：`sys_munmap` 遍历 `mmap_areas` 找到对应区域，调用 `vmunmap_maybe` 解除映射并释放物理页。

#### 3.1.3 内存管理完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| 物理页分配 | 完整 | freelist 单向链表 |
| Sv39 页表管理 | 完整 | 三级遍历、映射、解除映射 |
| 内核页表 | 完整 | 直映射 MMIO + 内核代码/数据 |
| fork 内存拷贝 | 完整 | 全量拷贝（非 COW） |
| mmap/munmap | 基本完整 | 支持匿名映射，不支持文件映射 |
| brk | 完整 | 程序断点扩展 |
| mprotect | stub | 返回 0（无实际操作） |
| 页面共享（CLONE_VM） | 完整 | 通过 `uvmshare` 共享父进程物理页 |
| 写时复制 (COW) | 未实现 | fork 使用全量拷贝 |
| 页面回收/交换 | 未实现 | 无 swap |
| 大页支持 | 未实现 | 仅 4KB 页 |

---

### 3.2 进程管理 (`kernel/proc.c`, 1305 行)

#### 3.2.1 核心数据结构

```c
struct proc {
  struct spinlock lock;
  enum procstate state;       // UNUSED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE
  struct proc *parent;
  int pid;
  // ... 完整字段见下文

  // 内存
  pagetable_t pagetable;      // 用户页表
  pagetable_t kpagetable;     // 内核页表（用于 copyin/copyout 加速）
  uint64 sz;                  // 进程地址空间大小
  uint64 brk;                 // 程序断点

  // 信号处理
  uint64 sigmask;             // 阻塞信号掩码
  uint64 sigpending;          // 待处理信号位图
  struct proc_sigaction sigactions[65];  // 信号处理器 (1-64)
  int sigactive;
  uint64 sigsavedmask;
  struct trapframe sigtf;     // 信号返回上下文

  // 定时器
  struct proc_itimerval itimers[3];    // ITIMER_REAL/VIRTUAL/PROF
  uint64 itimer_deadline[3];           // 定时器截止 tick

  // 线程/CLONE_VM
  int is_thread;
  struct proc *vm_leader;

  // 文件描述符
  struct file *ofile[NOFILE];          // NOFILE=128
  uint8 ofile_cloexec[NOFILE];

  // 凭证
  uint32 uid, euid, suid, gid, egid, sgid;
  uint32 groups[PROC_NGROUPS];         // 16 个附加组
  uint32 umask;
  int ngroups;

  // mmap 记录
  struct proc_mmap_area mmap_areas[32];

  // 资源限制
  int nofile_limit;
  uint64 stack_limit;

  // 时间统计
  uint64 utime, stime, cutime, cstime;

  // ...
};
```

#### 3.2.2 进程生命周期

**创建 (`allocproc`)**：
1. 从 `proc[NPROC]` (NPROC=128) 中寻找 UNUSED 槽位
2. 先回收 ZOMBIE 线程 (`is_thread`)
3. 分配 `pid`（自增全局计数器 `nextpid`，spinlock 保护）
4. 分配 trapframe 页
5. 创建用户页表 + 内核页表（映射 trampoline、trapframe）
6. 设置 `context.ra = forkret` 作为首次调度入口

**fork**：
```c
int fork(void) {
  np = allocproc();
  uvmcopy(p->pagetable, np->pagetable, np->kpagetable, p->sz);
  np->sz = p->sz;
  // 复制 trapframe，子进程 a0=0
  *(np->trapframe) = *(p->trapframe);
  np->trapframe->a0 = 0;
  // 复制 fd 表（filedup 增加引用计数）
  for(i = 0; i < NOFILE; i++)
    if(p->ofile[i]) np->ofile[i] = filedup(p->ofile[i]);
  np->state = RUNNABLE;
  return pid;
}
```

**clone** (支持 CLONE_VM/CLONE_FILES/CLONE_SETTLS 等标志)：
```c
int clone(uint64 flags, uint64 stack, uint64 ptid, uint64 tls, uint64 ctid) {
  np = allocproc();
  if (flags & CLONE_VM) {
    uvmshare(p->pagetable, np->pagetable, np->kpagetable, p->sz);
    np->is_thread = 1;        // 标记为线程
    np->vm_leader = p->vm_leader ? p->vm_leader : p;
  } else {
    uvmcopy(...);
  }
  np->trapframe->a0 = 0;
  if (stack != 0) np->trapframe->sp = stack;  // 新栈
  if (flags & CLONE_SETTLS) np->trapframe->tp = tls;
  // ... 复制信号、凭证、mmap 等
  np->state = RUNNABLE;
  return pid;
}
```

**exit**：
- 触发 `clear_child_tid` futex 唤醒
- 如果非线程进程，杀死同 `vm_leader` 的所有线程
- 关闭所有文件描述符
- 将子进程 reparent 给 `initproc`
- 累积时间到父进程 `cutime/cstime`
- 状态设为 ZOMBIE，向父进程发送 SIGCHLD
- 调用 `sched()` 放弃 CPU

**wait/waitpid**：
- 支持 `pid_to_wait == -1`（等待任意子进程）或指定 PID
- 支持 `WNOHANG` 选项
- 返回 `ECHILD`（-10）表示无子进程
- `wait_kernel` 是内核侧版本，供测试运行器使用

**调度器** (`scheduler()`):
- 简单的轮询调度：遍历 `proc[]`，选择第一个 RUNNABLE 进程
- 无优先级、无时间片、无多级队列
- 通过 `swtch(struct context*, struct context*)` 进行上下文切换
- 切换时同时切换 `satp` 到进程的 `kpagetable`

**上下文切换** (`kernel/swtch.S`):
- 保存/恢复 callee-saved 寄存器（ra, sp, s0-s11）
- 使用 RISC-V 汇编实现

#### 3.2.3 信号处理

实现了较完整的 POSIX 信号机制：

- `sys_rt_sigaction`：注册信号处理器（支持 SA_SIGINFO 以外的标准语义）
- `sys_rt_sigprocmask`：阻塞/解除阻塞信号
- `sys_kill/sys_tkill/sys_tgkill`：发送信号
- `signal_send(int pid, int sig)`：向目标进程设置 `sigpending` 位
- `proc_signal_deliver()`：在 `usertrapret` 前调用，检查待处理信号并设置用户态 handler 调用上下文
- `proc_signal_return()`：`rt_sigreturn` 系统调用实现，恢复保存的 trapframe

信号处理在返回用户态之前由 `usertrap` → `proc_signal_deliver()` 链触发。

#### 3.2.4 进程管理完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| fork | 完整 | 全量内存拷贝 |
| clone | 完整 | 支持 CLONE_VM/CLONE_FILES/CLONE_SETTLS/CLONE_PARENT_SETTID/CLONE_CHILD_CLEARTID/CLONE_CHILD_SETTID |
| exit/exit_group | 完整 | exit_group 杀死所有同 vm_leader 线程 |
| wait/waitpid/wait4 | 完整 | 支持 WNOHANG，支持按 PID 等待 |
| 调度器 | 基础 | 轮询，无优先级 |
| 上下文切换 | 完整 | swtch.S |
| 信号处理 | 较完整 | 支持 1-64 信号注册/发送/处理/返回 |
| 定时器 (itimer) | 完整 | ITIMER_REAL/VIRTUAL/PROF + 超时信号发送 |
| 进程凭证 (uid/gid) | 完整 | uid/euid/suid/gid/egid/sgid + 附加组 + umask |
| 资源限制 (rlimit) | 部分 | NOFILE/STACK |
| cgroup/namespace | 未实现 | 无 |
| ptrace | 未实现 | 无 |
| 进程优先级/NICE | 未实现 | 无 |
| CPU 亲和性 | 未实现 | 无 |

---

### 3.3 系统调用层 (`kernel/syscall.c`, 2837 行 + `kernel/sysfile.c`, 2864 行)

#### 3.3.1 系统调用 ABI

采用 **Linux generic (asm-generic/unistd.h) ABI**：
- 系统调用号范围：17~452（Linux generic 编号）
- xv6 原有系统调用号搬迁至 5000+ 保留区
- `sysnum.h` 定义了约 154 个系统调用号常量

#### 3.3.2 系统调用分发

```c
// 系统调用表（约 140+ 个条目）
static uint64 (*syscalls[])(void) = {
  [SYS_getcwd]        sys_getcwd,
  [SYS_write]         sys_write,         // 64
  [SYS_read]          sys_read,          // 63
  [SYS_openat]        sys_openat,        // 56
  [SYS_close]         sys_close,         // 57
  [SYS_mmap]          sys_mmap,          // 222
  [SYS_munmap]        sys_munmap,        // 215
  [SYS_brk]           sys_brk,           // 214
  [SYS_clone]         sys_clone,         // 220
  [SYS_clone3]        sys_clone3,
  [SYS_execve]        sys_exec,          // 221
  [SYS_wait4]         sys_waitpid,       // 260
  [SYS_exit]          sys_exit,          // 93
  [SYS_exit_group]    sys_exit_group,    // 94
  [SYS_futex]         sys_futex,         // 98
  [SYS_getdents64]    sys_getdents64,    // 61
  [SYS_pipe2]         sys_pipe2,         // 59
  [SYS_dup3]          sys_dup3,          // 24
  [SYS_fcntl]         sys_fcntl_stub,    // stub
  [SYS_ioctl]         sys_ioctl_stub,    // stub
  [SYS_rt_sigaction]  sys_rt_sigaction,  // 134
  [SYS_rt_sigprocmask]sys_rt_sigprocmask, // 135
  [SYS_kill]          sys_kill,          // 129
  // ... 约 120 个 Linux ABI 条目 + 12 个 xv6 内部条目
};
```

**真实实现（约 90 个）**包括但不限于：
- 文件 I/O：read/write/readv/writev/pread64/pwrite64/preadv/pwritev/openat/close/lseek
- 文件元数据：fstat/fstatat/statfs/fstatfs/getdents64/faccessat/utimensat/readlinkat/fchmod/fchmodat/fchown/fchownat
- 目录操作：mkdirat/unlinkat/linkat/symlinkat/renameat/renameat2/chdir/getcwd
- 进程：fork/clone/clone3/execve/exit/exit_group/wait4
- 内存：brk/mmap/munmap/msync
- IPC：pipe2 (真实)/shmget/shmat/shmdt/shmctl (真实)
- 网络：socket/bind/listen/accept/accept4/connect/sendto/recvfrom/getsockname/setsockopt (真实、基于内核内 sock 表)
- 信号：kill/tkill/tgkill/rt_sigaction/rt_sigprocmask/rt_sigtimedwait/rt_sigreturn
- 定时器：nanosleep/clock_nanosleep/clock_gettime/clock_getres/getitimer/setitimer
- 其他：getpid/getppid/getuid/geteuid/getgid/getegid/uname/times/gettimeofday/sysinfo/sched_yield/umask/getrlimit/setrlimit/prlimit64/getrusage/futex/set_tid_address/sync/fsync/fdatasync/pselect6/ppoll/mount/umount2/truncate/ftruncate/sendfile

**Stub 实现（约 38 个）**：
- `sys_fcntl_stub`：仅支持 F_GETFD/F_SETFD/F_DUPFD_CLOEXEC → 分别委托给 `sys_dup3`
- `sys_ioctl_stub`：对 TIOCGWINSZ 返回固定 80x24 终端尺寸，其他返回 ENOTTY
- `sys_getrandom_stub`：返回固定字节（用于满足 musl 初始化）
- `sys_madvise_stub`：直接返回 0
- `sys_mprotect_stub`：直接返回 0
- `sys_prctl_stub`：部分支持（PR_SET_NAME/PR_GET_NAME/PR_SET_PDEATHSIG 等）
- `sys_capget_stub/sys_capset_stub`：返回空能力集
- `sys_setpgid_stub/sys_getpgid_stub/sys_getsid_stub/sys_setsid_stub`：返回 0
- `sys_sendfile_stub`：返回 -ENOSYS
- 时间相关 stub：`sys_clock_settime_stub/sys_adjtimex_stub/sys_clock_adjtime_stub`
- 未知系统调用：`syscall()` 中返回 `-ENOSYS`（38 号错误）

#### 3.3.3 系统调用完整度评估

以比赛要求的约 30 个规范系统调用为基准，加上测试实际需要的系统调用，共计约 120 个条目。其中约 90 个有真实实现，约 30 个为 stub。

---

### 3.4 文件系统

#### 3.4.1 文件描述符层 (`kernel/file.c`, 1018 行)

定义了统一的文件类型：

```c
struct file {
  enum { FD_NONE, FD_PIPE, FD_ENTRY, FD_DEVICE, FD_EXT4, FD_MEM, FD_SOCKET } type;
  int ref;                 // 引用计数
  char readable, writable, append;
  uint32 status_flags;     // O_NONBLOCK/O_DIRECT/O_APPEND
  struct pipe *pipe;       // FD_PIPE
  struct dirent *ep;       // FD_ENTRY (FAT32)
  uint off;                // 文件偏移
  short major;             // FD_DEVICE 设备号
  char ext4path[MAXPATH];  // FD_EXT4 路径
  uint8 ext4_isdir;        // FD_EXT4 目录标志
  void *mem;               // FD_MEM 数据
  uint mem_size;
  struct memfile_ref *mem_ref; // FD_MEM 命名文件引用
  uint8 mem_isdir;
  struct ksock *sock;      // FD_SOCKET
  // 时间戳和权限
  uint64 atime_sec, atime_nsec, mtime_sec, mtime_nsec;
  uint32 mode, uid, gid;
};
```

**六个文件类型**的读写路径：

| 类型 | read | write | 特点 |
|------|------|-------|------|
| FD_PIPE | `piperead()` | `pipewrite()` | 字节流，阻塞读/写，512 字节循环缓冲区 |
| FD_DEVICE | `devsw[major].read/write` | 同上 | console(UART) / null / zero / rtc |
| FD_ENTRY | `eread()` (FAT32) | `ewrite()` (FAT32) | 保留的旧 FAT32 路径 |
| FD_EXT4 | `ext4_fopen→fread→fclose` | `ext4_fopen2→fwrite→fclose` | 每次 I/O 重新 open/seek/read/close（路径驱动） |
| FD_MEM | `memfile_page()` 分页读写 | 同左 | 内存文件系统（tmpfs 替代） |
| FD_SOCKET | 内核内 sock 表读/写 | 同左 | 基本的 UDP/TCP 模拟（loopback 风格） |

**内存文件系统 (FD_MEM/MEMFILE)**：在 `file.c` 中实现了一个完整的临时文件系统，通过 `memfile_open_named/memfile_mkdir_named/memfile_fifo_named/memfile_symlink_named/memfile_unlink_named` 等 API 提供文件/目录/命名管道/符号链接操作，支持 `/proc`、`/dev`、`/tmp` 等虚拟路径。

#### 3.4.2 lwext4 集成 (`kernel/ext4_glue.c`, 184 行)

```c
// ext4_glue.c 为 lwext4 库提供三个桩：

// 1. 内存分配：使用 kalloc/kfree 分配整页
void *ext4_user_malloc(size_t size)  // ≤4096 字节，分配整页
void *ext4_user_calloc(...)
void *ext4_user_realloc(...)
void ext4_user_free(void *ptr)

// 2. 块设备 I/O：通过 virtio_disk_rw 逐扇区读写
blockdev_bread/bwrite → virtio_disk_rw(struct buf*, 0/1)
// bsize=512，每次读写一个扇区，per-call 分配/释放临时 buf

// 3. qsort：插入排序（lwext4 dir_idx 代码引用但实际只读挂载时不调用）
void qsort(void *base, size_t n, size_t sz, ...)
```

**ext4 锁策略**：使用 sleeplock (`ext4_lock`) 保护所有 lwext4 调用。sleeplock 而非 spinlock 是因为磁盘 I/O 可能睡眠（等待 virtio 完成中断）。

```c
// 在 sysfile.c 中定义
struct sleeplock ext4_lock;
void ext4_acquire() { acquiresleep(&ext4_lock); }
void ext4_release() { releasesleep(&ext4_lock); }
```

#### 3.4.3 EXT4 文件操作

**open** (`sys_openat`)：
1. 解析 dirfd（支持 AT_FDCWD）
2. 检查 in-memory 特殊文件（`/dev/null`, `/proc/...`）
3. 检查 memfile（`/tmp` 下文件）
4. 否则使用 lwext4：`ext4_dir_open` 检查目录，`ext4_fopen2` 打开/创建文件
5. 分配 `struct file`（type=FD_EXT4），保存路径和标志

**read** (`fileread` 中 FD_EXT4 分支)：
```c
ext4_acquire();
ext4_file ef;
ext4_fopen(&ef, f->ext4path, "rb");
ext4_fseek(&ef, f->off, 0);  // SEEK_SET
while(total < n) {
  ext4_fread(&ef, kbuf, chunk, &got);
  copyout2(addr+total, kbuf, got);
  total += got;
}
ext4_fclose(&ef);
ext4_release();
```

**write** (`filewrite` 中 FD_EXT4 分支)：类似 read，但使用 `ext4_fopen2(..., O_RDWR)` + `ext4_fwrite`。

**getdents64**：通过 `ext4_dir_open/ext4_dir_entry_next` 遍历目录，构造 `linux_dirent64` 结构体序列化到用户空间。

#### 3.4.4 文件系统完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| EXT4 读取 | 完整 | 通过 lwext4 实现 |
| EXT4 写入 | 完整 | 通过 lwext4 实现 |
| 目录遍历 | 完整 | ext4_dir_open / ext4_dir_entry_next |
| 文件元数据 (fstat) | 完整 | ext4_fstat → fill_kstat_for_file |
| 管道 (pipe) | 完整 | 512 字节循环缓冲区 + spinlock |
| 内存文件系统 | 完整 | 命名文件、目录、符号链接、FIFO |
| 设备文件 | 基本完整 | console/null/zero/rtc |
| Socket (UDP/TCP) | 基础 | 内核内 sock 表，简单 loopback 模拟 |
| FAT32 | 保留旧代码 | 非主数据路径 |
| inode 缓存 | 依赖 lwext4 | lwext4 自带 bcache |
| 块缓存 (bio.c) | 保留但未在 EXT4 路径使用 | lwext4 使用自己的 bcache |
| ext4 日志 | 禁用 | CONFIG_JOURNALING_ENABLE=0 |
| ext4 xattr | 禁用 | CONFIG_XATTR_ENABLE=0 |
| ext4 写入时复制 | 未实现 | 无 |
| 磁盘配额 | 未实现 | 无 |

---

### 3.5 ELF 加载器 (`kernel/exec_elf.c`, 1386 行)

#### 3.5.1 核心能力

**`exec_elf_ext4(const char *path, char *const argv[], char *const envp[])`**:
替换当前进程的地址空间并加载 ELF。

**`exec_elf_ext4_proc(struct proc *p, const char *path, char *const argv[], char *const envp[])`**:
在任意进程（非当前进程）上加载 ELF。供测试运行器使用，避免替换 initproc 的地址空间。

#### 3.5.2 ELF 加载流程

1. **ELF 头验证**：检查 magic (0x7F 'E' 'L' 'F')、e_machine (EM_RISCV=0xF3)、e_type (ET_EXEC/ET_DYN)

2. **PT_INTERP 处理**（动态链接器支持）：
   - 读取解释器路径
   - 在可执行文件所在 ABI root 下查找解释器（`/musl/lib/ld-musl-riscv64.so.1`、`/glibc/lib/ld-linux-riscv64-lp64d.so.1`）
   - 支持回退策略：`libc.so` → `/musl/lib/` 搜索

3. **PT_LOAD 段加载**：
   - 非页对齐 vaddr 支持：逐页加载，偏移量计算精细
   - `uvmalloc(pagetable, kpagetable, sz, ph->vaddr+ph->memsz)` 预分配地址空间
   - `load_phdr()` 通过 ext4 seek+read 逐段加载，使用 32KB 缓冲区

4. **可执行文件缓存**（用于 busybox/ld/librt）：
   ```c
   #define EXEC_CACHE_SLOTS 2
   #define EXEC_CACHE_MAX (4*1024*1024)  // 4MB
   ```
   频繁加载的可执行文件（busybox、ld-musl、libc.so）被缓存在 4MB 的静态缓冲区中，避免重复从 ext4 读取。

5. **共享只读页面**（实验性）：`map_cached_readonly_segment()` 为缓存的 ELF 创建共享只读映射，使用 `PTE_SHARED` 标志。

6. **栈布局**（Linux SysV psABI 约定）：
   ```
   高地址: envp strings + argv strings + AT_RANDOM bytes
          padding to 16B alignment
          auxv[]: AT_NULL, AT_PAGESZ, AT_RANDOM, AT_PHDR, AT_PHENT, AT_PHNUM, ...
          envp[]: NULL-terminated pointer array
          argv[]: NULL-terminated pointer array
   低地址 SP: argc (uint64)
   ```
   栈预分配 128 页（`EXEC_ELF_STACK_PAGES`），栈底有保护页。

7. **auxv 向量**：AT_PAGESZ, AT_RANDOM, AT_FLAGS, AT_ENTRY, AT_BASE, AT_UID, AT_EUID, AT_GID, AT_EGID, AT_EXECFN, AT_PHENT, AT_PHNUM, AT_PHDR

8. **提交**：替换 `p->pagetable`、`p->kpagetable`、`p->sz`、`p->brk`；设置 `epc=elf.entry`、`sp=栈顶`、`a0=0`、`a1=0`；释放旧页表

#### 3.5.3 ELF 加载器完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| ET_EXEC 静态 ELF | 完整 | 标准静态可执行文件 |
| ET_DYN PIE ELF | 完整 | 位置无关可执行文件 |
| PT_INTERP 动态链接器 | 完整 | 加载 ld-musl/ld-linux + 可执行文件 |
| 非页对齐段 | 完整 | 逐页加载，精确偏移处理 |
| auxv 向量 | 完整 | 12 个 auxv 条目 |
| 栈布局 | 完整 | Linux psABI 兼容 |
| argv/envp | 完整 | EXEC_ELF_MAXARG=32, MAXENV=32 |
| 可执行文件缓存 | 完整 | 2 槽位 × 4MB |
| 动态重定位 | 未实现 | 依赖解释器处理 |
| 共享库依赖解析 | 未实现 | 解释器负责 |
| TLS 初始化 | 未实现 | 无 TLS 支持 |
| GOT/PLT 重定位 | 未实现 | 依赖解释器 |

---

### 3.6 中断与陷阱处理

#### 3.6.1 RISC-V 陷阱体系

**trampoline.S**：用户态↔内核态切换跳板（单页，映射到 TRAMPOLINE 地址）
- `uservec`：用户态进入内核的入口点，保存所有用户寄存器到 trapframe，切换 satp 到内核页表
- `userret`：内核返回用户态的出口，恢复用户寄存器，切换 satp 到用户页表，sret

**kernelvec.S**：内核态陷阱向量
- 保存所有寄存器到内核栈
- 调用 `kerneltrap()`

**trap.c**：
- `usertrap()`：处理来自用户态的异常/系统调用/中断
  - scause=8 → 系统调用分发 (`syscall()`)
  - scause=13/15 (page fault) 在 [0, TRAPFRAME) 且 ≥ p->sz 范围内 → 自动 `growproc()` 扩展栈
  - scause=2 且 sepc=0 → 静默终止进程（处理 exit 后空 PC 返回）
- `kerneltrap()`：处理内核态异常，支持定时器中断触发的 yield
- `devintr()`：分发外部中断（UART、virtio 磁盘）和定时器中断

#### 3.6.2 PLIC 中断控制器 (`kernel/plic.c`)

完整实现了 QEMU virt 平台 PLIC 的初始化和中断 claim/complete 流程。

---

### 3.7 定时器 (`kernel/timer.c`, 约 30 行)

```c
void timer_tick() {
  acquire(&tickslock);
  ticks++;
  wakeup(&ticks);
  release(&tickslock);
  proc_itimer_tick();      // 检查各进程的 itimer 是否到期
  watchdog_check();        // 检查测试运行器 watchdog 超时
  set_next_timeout();      // 设置下一个 SBI 定时器中断
}
```

- 时间基准：QEMU virt `timebase = 10MHz` (TIMER_FREQ=10000000)
- 间隔：`INTERVAL` 约 100ms（QEMU 默认）
- `r_time()` 读取 `rdtime` CSR

---

### 3.8 测试运行器 (`kernel/teststub.c`, 3259 行)

#### 3.8.1 架构

测试运行器是 forkret 中调用的 `runtests()` 函数，运行在 initproc 进程上下文中。整体流程：

```
runtests()
  ├── ext4_glue_init()              挂载 EXT4
  ├── scan_dir()                    扫描测试镜像
  ├── install_console_fds()         设置控制台
  ├── prepare_busybox_workspace()   准备 busybox 工作区
  │
  ├── run_libctest_groups()         libctest (static + dynamic)
  ├── run_basic_for_abi() × 2       basic 测试 (musl/glibc)
  ├── run_busybox_groups()          busybox 测试
  ├── run_lua_groups()              lua 测试
  ├── run_libcbench_groups()        libcbench 测试
  ├── run_lmbench_groups()          lmbench 测试
  ├── emit_empty_other_groups()     空组标记
  └── run_ltp_full_groups()         LTP 优先级用例集
```

#### 3.8.2 测试执行机制

每个测试用例通过 fork-exec-wait 模式运行：

```c
kernel_spawn_test(path, name, cwd)
  → allocproc()                 // 分配新进程
  → install_console_fds_on(np)  // 设置 stdin/stdout/stderr
  → exec_elf_ext4_proc(np, path, argv, envp)  // 加载 ELF
  → np->state = RUNNABLE       // 启动
  → return pid

// 父进程等待：
watchdog_pid = pid;
watchdog_deadline = r_time() + timeout;
wait_kernel(&status, pid, 1);   // 轮询等待（WNOHANG）
// 超时检测 + kill + reap_zombies
```

#### 3.8.3 Watchdog 机制

- **per-test watchdog**：在 `timer_tick()` 中每 tick 由 `watchdog_check()` 轮询，超时后 kill 子进程
- **global deadline**：7100 秒，在 `timer_tick()` 中检查，到期后直接 `sbi_shutdown()`
- **LTP stop reserve**：90 秒预留，防止 LTP 运行时超出全局 deadline

#### 3.8.4 各测试组实现

| 测试组 | 实现策略 |
|--------|---------|
| basic (31 个测试) | 逐个 fork-exec-wait 运行，60s timeout，检查退出码 |
| busybox | 真实执行 BusyBox applet，通过解析 busybox_cmd.txt + 脚本改写运行 |
| lua | 在 RV 上通过 busybox sh 执行 test.sh，LA 上直接运行 lua 解释器 |
| libctest | 运行官方 runtest.exe，static+dynamic 两套，每用例 20s timeout |
| libcbench | 运行 `/musl/libc-bench` 和 `/glibc/libc-bench`，180s timeout |
| lmbench | 运行 lmbench 二进制，45s timeout，带 step budget 防卡死 |
| LTP | 优先级排序（syscalls→syscalls-ipc→ipc→fs→...），运行 runtest 文件中的用例，解析 Summary 输出 |
| iozone | 空组标记（不作为当前主线） |

#### 3.8.5 关键机制

- **Zombie 清理**：`reap_zombies()` 每轮测试后回收所有 ZOMBIE 进程并杀死孤儿进程
- **LTP 临时文件清理**：`clean_ltp_temporary_files()` 清理 `/dev/shm/ltp_*` 和 `/tmp/LTP_*`/`/tmp/ltp_*`
- **ABI 区分**：musl-rv、glibc-rv、musl-la、glibc-la 四个 ABI 变体分别运行
- **禁止伪造成功**：LTP runner 明确检查输出是否为 "clean"（不含人工构造的 PASS 标记），只有真实的 Summary 输出才计分
- **输出捕获**：通过 FD_MEM 文件捕获子进程输出，用于后续解析

---

### 3.9 LoongArch 辅线

#### 3.9.1 启动 (`kernel/entry_la.S` + `kernel/main_la.c`)

```c
// main_la.c: 通过 DMW1 直接窗口访问 UART (0x900000001fe001e0)
void la_main(void) {
  la_puts("[kernel-la] LoongArch64 bring-up kernel booted\n");
  la_basic_main();  // 进入测试运行器
  la_shutdown();    // GED S5 sleep
}
```

- 无 MMU 配置（依赖 DMW1 直映射窗口 0x9000_0000_0000_0000 → PA）
- UART 基址：0x1fe001e0（QEMU LA virt NS16550）
- 关机：写 GED_SLEEP_CTL 寄存器

#### 3.9.2 virtio-pci 块设备驱动 (`kernel/la_virtio_pci.c`, 572 行)

完整实现了 PCI 总线枚举 + virtio-blk 初始化的轮询读路径：

1. **PCI ECAM 枚举**：扫描 bus 0，查找 vendor=0x1af4 device=0x2 (virtio-blk)
2. **BAR 分配**：解析 BAR0-BAR5，分配 MMIO 地址
3. **virtio 能力解析**：通过 PCI capabilities 链表查找 virtio-pci 能力结构
4. **virtio 设备初始化**：ACKNOWLEDGE → DRIVER → FEATURES_OK → DRIVER_OK 状态序列
5. **virtqueue 设置**：分配描述符表、available ring、used ring
6. **轮询读扇区**：`la_virtio_blk_read_sector()` 通过 virtqueue 提交读请求并轮询等待

**关键限制**：
- 仅支持读（VIRTIO_BLK_T_IN），不支持写
- 轮询模式（非中断驱动）
- 最大队列深度：256 (VQ_MAX)

#### 3.9.3 LoongArch 测试运行器 (`kernel/la_basic.c`, 4979 行)

与 RISC-V 测试运行器类似但精简，具有：
- 用户态系统调用模拟器（约 70 个系统调用的 LA 版本）
- ELF 加载器（EM_LOONGARCH=0x102）
- 基本的进程模拟（MAX_PROC=64, MAX_FD=128）
- basic/busybox/lua/libctest/lmbench/ltp 测试组运行能力

#### 3.9.4 LoongArch 完整度评估

| 功能 | 状态 | 说明 |
|------|------|------|
| 基本启动 | 完整 | QEMU LA virt 平台 |
| UART 输出 | 完整 | NS16550 @ 0x1fe001e0 |
| virtio-blk 读 | 完整 | PCI virtio 轮询读 |
| EXT4 挂载 | 完整 | 共享 lwext4 |
| ELF 加载 (LA) | 完整 | 支持 ET_EXEC/ET_DYN |
| 用户态 syscall 模拟 | 较完整 | 约 70 个 syscall 的内核模拟 |
| 多进程 | 有限 | 最大 64 进程，简化调度 |
| MMU/分页 | 未实现 | 使用 DMW 直映射 |
| 中断处理 | 最小 | 仅 smoke test 用 trap |
| virtio-blk 写 | 未实现 | 仅读路径 |

---

### 3.10 同步原语

#### 3.10.1 自旋锁 (`kernel/spinlock.c`)

基于 GCC `__sync_lock_test_and_set` / `__sync_lock_release` 原子操作：
- `push_off()/pop_off()` 管理中断禁用嵌套计数
- `holding()` 检查当前 CPU 是否持有锁

#### 3.10.2 睡眠锁 (`kernel/sleeplock.c`)

基于自旋锁 + `sleep()/wakeup()` 机制：
- `acquiresleep`：获取内部自旋锁后，若锁被持有则 `sleep` 等待
- `releasesleep`：清除锁定标志并 `wakeup` 等待者

---

### 3.11 设备驱动

#### 3.11.1 UART (`kernel/uart.c`, 197 行)

- NS16550 兼容 UART 驱动
- 物理地址：0x10000000（QEMU virt）
- 支持中断驱动的接收（通过 `consoleintr` 处理输入）
- 轮询发送

#### 3.11.2 控制台 (`kernel/console.c`, 191 行)

- 在 UART 之上提供行缓冲输入
- 支持退格 (Ctrl-H)、Ctrl-U 删除行
- 通过 `consoleread/consolewrite` 提供设备接口

#### 3.11.3 virtio-mmio 块设备 (`kernel/virtio_disk.c`, 300 行)

基于 xv6 原始 virtio 驱动：
- 通过 MMIO 寄存器与 QEMU virtio-blk 设备通信
- 支持单队列（深度 8）
- `virtio_disk_rw(struct buf *b, int write)` 提交 I/O 并睡眠等待完成
- 中断处理 `disk_intr()` 唤醒等待者

---

### 3.12 构建系统 (`Makefile`)

#### 3.12.1 RISC-V 编译配置

- 工具链：`riscv64-linux-gnu-gcc` (13.x)
- 模型：`-mcmodel=medany`
- 优化：`-O -fno-omit-frame-pointer`
- 独立环境：`-ffreestanding -fno-common -nostdlib -mno-relax`
- 代码压缩：`-ffunction-sections -fdata-sections` + `--gc-sections`
- lwext4 配置：禁用日志 (`CONFIG_JOURNALING_ENABLE=0`)、禁用 xattr (`CONFIG_XATTR_ENABLE=0`)、块缓存 64 条目、使用用户态 malloc
- 链接地址：0x80200000

#### 3.12.2 LoongArch 编译配置

- 工具链：`loongarch64-linux-gnu-gcc` (14.x preferred)
- 模型：`-mcmodel=normal`
- SIMD 禁用：`-msimd=none`
- 链接地址：0x9000000000200000

#### 3.12.3 条件编译

通过环境变量控制测试运行器行为：
- `TESTS=...`：筛选特定 basic 测试
- `BENCH_ONLY`：仅运行 benchmark 组
- `LIBCTEST_ONLY` / `LTP_ONLY`：仅运行指定组
- `LTP_FULL_ONLY` / `LTP_LIMIT` / `LTP_START`：控制 LTP 范围
- `LIBCTEST_STATIC_LIMIT` / `LIBCTEST_DYNAMIC_LIMIT`：控制 libctest 用例数

---

## 四、OS 内核各部分的交互

### 4.1 系统调用完整路径

```
用户态程序
  │ ecall
  ▼
trampoline.S:uservec
  │ 保存寄存器到 trapframe，切换 satp
  ▼
trap.c:usertrap()
  │ scause==8 → intr_on() → syscall()
  ▼
syscall.c:syscall()
  │ 读取 a7 作为系统调用号，查 syscalls[] 表
  │ 未知调用号 → return -ENOSYS
  ▼
具体的 sys_* 函数
  │ 从 trapframe 读取参数 (argraw/argint/argaddr/argstr)
  │ 调用子系统函数
  ▼
返回 → usertrap() → usertrapret()
  │ 恢复 stvec 到 trampoline
  │ 设置 trapframe.kernel_satp/sp/trap/hartid
  │ sret → trampoline.S:userret
  ▼
trampoline.S:userret
  │ 恢复用户寄存器，切换 satp 到用户页表
  │ sret → 用户态
```

### 4.2 进程创建与执行流程

```
fork/clone syscall
  → allocproc()            # 分配 proc 槽位 + PID
  → uvmcopy/uvmshare       # 复制或共享地址空间
  → 设置 trapframe         # a0=0, sp=新栈
  → state=RUNNABLE

scheduler() 选择 RUNNABLE 进程
  → state=RUNNING
  → swtch(&c->context, &p->context)
  → forkret()              # 首次调度时进入 runtests()
      或 usertrapret()     # 返回用户态

execve syscall
  → exec_elf_ext4()        # 加载新 ELF
     → 读取 ELF 头
     → 创建新页表
     → 加载 PT_LOAD 段
     → 处理 PT_INTERP（动态链接器）
     → 布局栈（argv/envp/auxv）
     → 替换 pagetable + sz + epc + sp
     → 释放旧页表
  → usertrapret()          # 从新入口点执行
```

### 4.3 文件 I/O 路径

```
read/write syscall
  → argfd() 获取 struct file*
  → fileread() / filewrite()
     [FD_EXT4]:
       → ext4_acquire()       # 获取 sleeplock
       → ext4_fopen/fseek/fread/fclose
       → ext4_release()
       → copyout2/copyin2     # 用户空间数据搬移
     [FD_PIPE]:
       → piperead()/pipewrite()
     [FD_MEM]:
       → memfile_page()       # 分页访问内存文件
     [FD_DEVICE]:
       → devsw[major].read/write
```

### 4.4 中断处理链

```
硬件中断 (定时器/UART/virtio)
  → PLIC 路由
  → stvec → kernelvec.S → kerneltrap()
     → devintr()
        [定时器]: → timer_tick() → proc_itimer_tick() + watchdog_check()
        [UART]:   → uartintr() → consoleintr()
        [virtio]: → disk_intr() → wakeup(&disks[i].vring_used)
     → yield() (如果是定时器中断且在进程上下文中)
  → sret
```

### 4.5 测试运行器与内核的交互

```
initproc 创建 (userinit)
  → forkret()
    → runtests()  # 永不返回，测试完成后 sbi_shutdown()
      ├── ext4_glue_init()           # 挂载文件系统
      ├── kernel_spawn_test()        # 每个测试:
      │     ├── allocproc()          # 分配子进程
      │     ├── exec_elf_ext4_proc() # 加载测试 ELF
      │     └── state=RUNNABLE       # 释放到调度器
      ├── watchdog_pid=pid           # 设置看门狗
      │     watchdog_deadline=...
      ├── wait_kernel(&status, pid, 1)  # 轮询等待
      ├── reap_zombies()             # 清理僵尸进程
      └── 输出结果 / GROUP 标记
```

---

## 五、OS 内核实现完整度总结

### 5.1 按子系统评价

以完整 Linux 兼容内核为基准（实现完整度百分比为粗略估计）：

| 子系统 | 实现程度 | 评分依据 |
|--------|---------|---------|
| 物理内存管理 | 60% | 有分配器但无伙伴系统/slab/引用计数 |
| 虚拟内存管理 | 70% | 完整 Sv39 + mmap/munmap/brk，缺 COW/swap/大页 |
| 进程管理 | 75% | fork/clone/exit/wait 完整，缺优先级/时间片/cgroup |
| 系统调用 | 75% | ~90 个真实实现/~30 个 stub/~120 个条目 |
| 信号处理 | 70% | 注册/发送/处理/返回完整，缺 siginfo_t |
| 定时器 | 70% | itimer/gettime/nanosleep 完整 |
| EXT4 文件系统 | 55% | 读/写/目录遍历完整，依赖 lwext4，日志和 xattr 禁用 |
| 管道 | 80% | 完整管道实现（512B 缓冲区） |
| 内存文件系统 | 65% | 命名文件/目录/符号链接/FIFO 完整 |
| Socket | 30% | 基础内核内实现，不支持真实网络 |
| ELF 加载 | 70% | 静态/PIE/动态解释器加载，缺 TLS/GOT 重定位 |
| 设备驱动 | 50% | virtio-blk/UART/PLIC，缺其他设备 |
| 同步 | 85% | 自旋锁+睡眠锁完整 |
| 测试运行器 (RV) | 85% | basic/busybox/lua/libctest/libcbench/ltp 均真实执行 |
| 测试运行器 (LA) | 55% | basic/busybox/部分 lua/libctest/ltp |

### 5.2 总体实现完整度

**综合评分：约 65-70%**（相对于一个完整的 Linux 兼容教学/竞赛内核）。

---

## 六、创新性分析

### 6.1 架构创新

1. **双架构策略**：RISC-V 完整内核 + LoongArch 最小内核共享 lwext4 文件系统驱动，两条线代码在同一仓库中融洽共存。LoongArch 侧的 `la_basic.c` 采用独立实现（非代码共享），但它复用了 lwext4 库的块设备接口。

2. **路径驱动的 EXT4 文件操作**：FD_EXT4 文件通过保存绝对路径来实现，每次 I/O 重新 open/seek→read/write→close。这种方式虽然性能较低但简化了文件锁管理——不需要 inode 缓存和复杂的引用计数。对比赛测试场景而言是正确的工程取舍。

3. **sleeplock 保护文件系统**：识别了 lwext4 磁盘 I/O 需要睡眠等待的特性，采用 sleeplock 而非 spinlock 保护临界区，避免自旋时持有锁的死锁风险。

### 6.2 工程创新

1. **ELF 可执行文件缓存**：针对 busybox、ld-musl、libc.so 等频繁加载的二进制实现了 4MB 静态缓存，减少 ext4 I/O 次数。这是针对比赛场景的实用优化。

2. **多级 watchdog 机制**：per-test watchdog（10-210s 不等）+ global deadline（7100s）+ LTP stop reserve（90s），层层防护确保测试不会因单个用例卡死而整体超时。

3. **禁止伪造成功的工程纪律**：
   - LTP runner 通过 `ltp_output_is_clean()` 检查输出中是否包含人工构造的 PASS 标记
   - busybox runner 通过 `strip_busybox_group_markers_in_buf()` 防止脚本中的 echo 命令被误判为测试结果
   - 所有 GROUP 标记在测试运行器的代码中显式输出，而非从镜像文件中读取

4. **内存文件系统的命名文件支持**：实现了完整的 `/tmp`、`/dev/shm`、`/proc` 虚拟文件系统，支持命名文件、目录、符号链接、FIFO，满足 LTP 等测试套件对临时文件操作的需求。

5. **busybox 测试的命令注入与脚本改写**：busybox runner 通过 `stream_busybox_cmd_file_in_buf()`、`suppress_busybox_command_output_in_buf()`、`quote_busybox_line_condition_in_buf()` 等函数，在运行时解析和改写 busybox_cmd.txt，使得同一测试脚本能在不同环境下正确执行。

### 6.3 设计上的局限性

1. **非 COW fork**：fork 执行全量内存拷贝，多进程创建开销较大。但考虑到比赛测试主要是短生命周期进程，影响有限。
2. **EXT4 路径驱动 I/O**：每次 read/write 都需要重新 open 文件，对需要大量小 I/O 的场景效率较低。
3. **LoongArch 侧缺乏 MMU**：不支持真正的分页用户态隔离，依赖 DMW 直映射窗口。
4. **无动态链接器实现**：ELF 加载器能加载解释器，但依赖解释器（ld-musl/ld-linux）自身处理重定位和库加载。

---

## 七、测试与验证

### 7.1 已进行的测试（根据 README 和代码）

由于无法在当前环境中直接构建和运行（需要 Docker 镜像 `zhouzhouyi/os-contest:20260510` 和特定的测试套件仓库），以下为根据文档和代码推断的测试状态：

| 测试组 | RISC-V | LoongArch |
|--------|--------|-----------|
| basic (31 个) | 通过（已作为回归基线） | 通过（已作为回归基线） |
| busybox | 曾满分，近期修复中 | 不卡死为底线 |
| lua | 修复过 RV/glibc 评分问题 | 尝试真实执行 |
| libctest (static) | ~200 个 testcase success | 已真实执行 runtest.exe |
| libctest (dynamic) | 已跑 | 新增 dynamic 套件 |
| libcbench | 27 个 benchmark 完整输出 | 受限于 LA 能力 |
| lmbench | 规避卡死点 | 规避卡死点 |
| LTP (priority) | 真实 Summary 输出 | 保守用例集，真实 Summary |
| iozone/cyclictest/iperf/netperf | 未作为主线 | 未作为主线 |

### 7.2 构建测试缺失原因

当前环境缺少以下条件，无法进行实际构建测试：
- Docker 镜像 `zhouzhouyi/os-contest:20260510` 不在本地
- 官方测试套件仓库需要额外 clone
- 构建 EXT4 测试镜像需要 4GB+ 磁盘空间和 root 权限（losetup）

---

## 八、项目总结

`oskernel2026-tmtos` 是一个在 xv6-riscv 基础上大幅改造而成的竞赛操作系统内核。项目的核心贡献体现在以下几个方面：

1. **系统调用层的全面扩展**：从 xv6 的约 20 个系统调用扩展到约 120 个，采用 Linux generic ABI，并实现了约 90 个有实际功能的系统调用（包括文件操作、信号处理、定时器、权限管理、共享内存、socket 等）。这是项目最大的工程投入。

2. **EXT4 文件系统的集成**：通过引入 lwext4 库并编写桥接层 (`ext4_glue.c`)，实现了对评测器提供的 EXT4 镜像的完整读写支持，同时保留了 FAT32 兼容代码。

3. **ELF 加载器的增强**：支持 ET_EXEC 和 ET_DYN（PIE）ELF，支持动态链接器（PT_INTERP），支持非页对齐段加载，实现了 Linux SysV psABI 兼容的栈布局和 auxv 向量。

4. **全面的测试运行器**：basic/busybox/lua/libctest/libcbench/lmbench/LTP 七大测试组的真实执行支持，包括多级 watchdog、输出捕获与解析、zombie 清理等健壮性机制。

5. **LoongArch 双架构支持**：尽管实现程度较浅（无 MMU、无中断驱动块设备），但满足了比赛的双架构要求，具备基本的启动、EXT4 读取和测试运行能力。

6. **工程纪律**：项目明确禁止伪造测试输出，坚持真实执行官方二进制并基于退出状态判分——这在竞赛项目中是值得肯定的品质。

项目的薄弱环节主要包括：无写时复制、无动态链接器、EXT4 路径驱动 I/O 效率较低、LoongArch 侧缺乏真正的进程隔离。这些约束在当前比赛场景下是可以接受的工程取舍。