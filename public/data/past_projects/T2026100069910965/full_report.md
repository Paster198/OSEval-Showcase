# OSKernel2026 深度技术分析报告

## 一、分析范畴与测试结果

### 1.1 分析方法

本报告对仓库中全部 38 个源文件（`.c`、`.S`、`.h`、`.ld`）及 Makefile 进行了逐行阅读和分析。分析方法包括：源码静态审查、构建验证、代码路径跟踪、接口交叉对照。

### 1.2 构建测试

**RISC-V 构建：成功。** 使用 `riscv64-linux-gnu-gcc` 编译，生成 ELF64 可执行文件 `kernel-rv`，体积约 496 KB（含调试信息），其中 text 段 64,752 字节，data 段 16,664 字节，BSS 段约 31.5 MB（主要来自进程内核栈池和 ramfs 页缓存）。

```
$ size kernel-rv
   text    data     bss      dec      hex
  64752   16664  33062912  33144328  1f9be08
```

**LoongArch 构建：失败。** 环境未安装 `loongarch64-linux-gnu-gcc` 或等效编译器。

### 1.3 源代码统计

| 类别 | 文件数 | 总行数 |
|------|:------:|:------:|
| C 源文件 | 22 | ~7,900 |
| 汇编文件 | 7 | ~870 |
| 头文件 | 21 | ~1,100 |
| 链接脚本 | 2 | ~80 |
| Makefile | 1 | ~70 |
| **总计** | **53** | **~10,020** |

---

## 二、子系统全面分析

### 2.1 构建系统（`Makefile`，约 70 行）

**功能概览：** 双架构交叉编译自动化。

**实现细节：**
- 自动检测 RISC-V 工具链，优先级为 `riscv64-linux-gnu-gcc` -> `riscv64-linux-gcc` -> `riscv64-unknown-elf-gcc`。
- LoongArch 工具链优先级为 `loongarch64-linux-gnu-gcc` -> `loongarch64-linux-musl-gcc`。
- 通用 CFLAGS：`-O2 -g -std=gnu11 -Wall -Wextra -ffreestanding -fno-builtin -nostdlib -fno-stack-protector -ffunction-sections -fdata-sections`。
- RISC-V 特有：`-march=rv64gc -mabi=lp64 -mcmodel=medany -DARCH_RISCV`。
- LoongArch 特有：`-march=loongarch64 -mabi=lp64d -mcmodel=normal -DARCH_LOONGARCH`。
- 链接使用 `--gc-sections --build-id=none`，各架构独立链接脚本。
- 使用 `-MMD -MP` 生成自动依赖文件。
- 架构无关文件从 `kernel/`、`mm/`、`fs/`、`drivers/`、`lib/` 自动收集，与架构相关源文件叠加。

**完整度：** 完整可用（RISC-V），LoongArch 需安装编译器。

---

### 2.2 架构层 — RISC-V（`arch/riscv/`，11 个文件）

#### 2.2.1 启动入口（`boot.S`，24 行汇编）

```
_start:
    bnez a0, park       # 非 hart 0 休眠
    la sp, boot_stack_top
    # 清零 BSS
    call kmain          # kmain(hartid, dtb)
park:
    wfi
    j park
```

**特点：** 只让 hart 0 启动内核，其他 hart 永久休眠于 `wfi` 循环。BSS 清零使用 8 字节写入以加速。启动栈 64 KB。

#### 2.2.2 内核 Trap 向量（`trapentry.S`，约 70 行汇编）

内核态 trap 入口保存和恢复全部 32 个整数寄存器（除 `tp` 以外），遵循 xv6 风格。关键点：
- 使用 `sp` 作为帧基址，在栈上分配 256 字节帧。
- `tp` 未从栈恢复（保留当前 hartid）。
- 返回使用 `sret`。

#### 2.2.3 用户态 Trap 蹦床（`trampoline.S`，约 120 行汇编）

```asm
uservec:
    csrw    sscratch, a0        # 暂存用户 a0
    li      a0, TRAPFRAME       # a0 = TRAPFRAME VA
    # 保存全部通用寄存器到 trapframe
    # ...
    ld      sp, 8(a0)           # 切换到内核栈
    ld      t1, 16(a0)          # usertrap()
    ld      t0, 0(a0)           # 内核 satp
    sfence.vma zero, zero
    csrw    satp, t0             # 切换到内核页表
    jr      t1                   # 进入 usertrap()
```

**关键设计决策：** 不使用 `sscratch` 存储 trapframe 地址（xv6 方式），而是直接用 `li a0, TRAPFRAME` 加载固定虚拟地址。`sscratch` 仅用于暂存用户 `a0`。这简化了初始化，但要求每个用户页表都映射 TRAPFRAME 页面。

`userret` 则执行逆操作：切换到用户 satp，从 TRAPFRAME 恢复全部寄存器，`sret` 返回用户态。

#### 2.2.4 上下文切换（`swtch.S`，28 行汇编）

保存/恢复 14 个 callee-saved 寄存器：`ra, sp, s0-s11`。布局对齐 `struct context`（`ra@0, sp@8, s0..s11@16..`）。返回使用 `ret`（即 `jalr zero, ra, 0`）。

#### 2.2.5 Sv39 页表管理（`mmu.c`，约 260 行）

**内核页表：**
```c
// 用 1 GiB gigapage 恒等映射低 4 GiB
for (int i = 0; i < NGIGA; i++) {
    u64 pa = (u64)i << 30;
    kernel_pagetable[i] = (PA2PTE(pa)) | PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D;
}
```
此外还在内核页表中映射 trampoline 页面（`PTE_R | PTE_X`），确保从用户态 trap 进入时能在内核页表中执行。

**用户页表：**
- `proc_pagetable()` 创建用户页表，映射 TRAMPOLINE 和 TRAPFRAME。
- `mappages()` 使用三级 walk 分配页表中间节点（level 2 -> 1 -> 0）。
- `walkaddr()` 返回 level-0 PTE 对应的物理地址（要求 PTE_U 已设置）。
- `uvmalloc()` 从 `oldsz` 增长到 `newsz`，逐页分配并清零。
- `uvmfree()` 先 unmap 全部 leaf 页面（释放物理页），再递归释放页表中间节点。

**写时复制（COW）：**
- `uvmcopy_cow()` fork 时使用：将父进程所有可写页面标记为 COW（`PTE_COW = 1<<8`），清除 W 位，增加引用计数，子进程映射同一物理页。
- `uvmcow()` 处理 COW 故障：分配新页，复制内容，更新 PTE 为可写。
- `copyout()` 在写入用户地址前先调用 `uvmcow()` 处理潜在的 COW 页面。
- `uvmcopy_page()` 直接深拷贝一页（非 COW 路径）。
- `uvmshare_page()` 将其他线程的页面共享到当前进程（用于同 tgid 线程间的缺页共享）。

**页保护：**
- `uvmprotect()` 修改指定虚拟地址范围的权限，支持分配缺失页面（`alloc_missing=1`），处理 COW 页面的写时复制。

#### 2.2.6 SBI 调用（`sbi.c`，约 30 行）

通过 `ecall` 封装标准 SBI 调用：
- `sbi_putchar()` / `sbi_getchar()` 使用 legacy SBI v0.1 扩展（EID 0x01/0x02）。
- `sbi_set_timer()` 使用 SBI TIME 扩展（EID 0x54494D45）。
- `sbi_shutdown()` 使用 SRST 扩展（EID 0x53525354）。

#### 2.2.7 定时器（`timer.c`，约 20 行）

100 Hz 周期定时器。`timer_init()` 设置第一次中断（约 10ms），`timer_tick()` 在每次中断时重新设置下一次中断。全局变量 `g_ticks` 单调递增。

#### 2.2.8 设备树内存解析（`fdt.c`，约 60 行）

简单解析设备树（FDT）中 `/memory` 节点的 `reg` 属性，提取 RAM 基址和大小。使用大端序读取（FDT 标准），支持 32 位和 64 位 `#address-cells`/`#size-cells`。

#### 2.2.9 内核 Trap 处理（`trap.c` + `usertrap.c`）

**`kerneltrap()`：**处理来自 S 模式的 trap，仅处理设备中断（timer/soft/external）。对未知异常触发 panic。timer 中断时调用 `yield()` 触发抢占。

**`usertrap()`：**处理来自 U 模式的 trap：
- `scause == 8`（ecall）：系统调用，`epc += 4` 跳过 ecall 指令后调用 `syscall()`。
- 中断：timer 中断触发 `yield()`。
- 缺页异常（scause 12/13/15）：调用 `proc_handle_page_fault()` 尝试 COW 处理或线程间共享。
- 其他异常：打印信息并 `proc_exit(-1)`。

**`usertrapret()`：**设置 trampoline 信息（`kernel_satp/kernel_sp/kernel_trap/kernel_hartid`），切换 `sstatus` 到 U-mode（`SPP=0, SPIE=1`），跳转到 trampoline 中的 `userret`。

**`forkret()`：**新进程首次调度时的入口，直接调用 `usertrapret()` 跳回用户态。

#### 2.2.10 链接脚本（`linker.ld`）

- 加载地址：`0x80200000`（OpenSBI 默认加载地址上方 2 MiB）。
- `.trampoline` 段对齐到 4K 并放置在 `.text` 段末尾。
- 丢弃 `.comment`、`.note`、`.eh_frame`、`.riscv.attributes`。

---

### 2.3 架构层 — LoongArch（`arch/loongarch/`，8 个文件）

#### 2.3.1 启动入口（`boot.S`）

与 RISC-V 类似：BSS 清零，设置栈，调用 kmain。不区分多核（hartid 传入 0）。加载地址为 DMW 映射窗口 `0x9000000000200000`。

#### 2.3.2 Trap 向量（`trapentry.S`）

LoongArch 实现了两条异常入口：
- **`kernelvec`：**用户态 trap。利用 CSR `SAVE0`（0x30）= trapframe、`SAVE1`（0x31）= 内核栈顶，在栈上使用前暂存 `t0/t1` 到 `SAVE2/SAVE3`。保存所有通用寄存器后切换到内核栈，调用 `usertrap()`。
- **`tlbrvec`：**TLB 重填向量。使用硬件页表遍历指令 `lddir`（level 2 -> 1），然后用 `ldpte` 装载相邻两个 TLB 条目，最后 `tlbfill`。

#### 2.3.3 用户态返回（`la_userret`）

从 trapframe 恢复全部寄存器后执行 `ertn`（LoongArch 的异常返回指令）。

#### 2.3.4 上下文切换（`swtch.S`）

保存/恢复 LoongArch callee-saved 寄存器（`r1=ra, r3=sp, r22-r31=s0-s9, fp=s8` 等），12 个寄存器，`jr r1` 返回。

#### 2.3.5 软件 TLB 管理（`mmu.c`）

**双模式地址空间：**
- 内核使用 DMW（直接映射窗口）`0x9000_0000_0000_0000`：无需 TLB，直接映射到物理地址 `[0, 2^48)`。
- 用户地址通过软件填充的 TLB 转换。

**关键设计：**
- 页表存储原始物理地址（不含 DMW 偏移），通过 `kva_to_pa()`/`pa_to_kva()` 转换。
- Leaf PTE 使用 LoongArch TLB 条目格式（含 PLV、MAT、NX、NR、D 位），使 TLB 重填处理程序可直接装载。
- COW 使用 PTE bit 60（`LA_PTE_COW`），与 RISC-V 对应。
- `kvm_enable()` 配置 DMW 窗口：`DMW0 = 0x9000_0000_0000_0000`（MAT=Cache Coherent, PLV0），启用 `CRMD_PG` 开启分页。

**与 RISC-V 的差异：**
- LoongArch 无 trampoline 机制，trapframe 通过 CSR SAVE0 传递。
- 需要周期性 `loongarch_invtlb_all()` 刷新 TLB。
- ASID 基于 `pid & 0x3ff`。
- `proc_pagetable()` 仅分配空页表（不映射 trampoline/trapframe）。

#### 2.3.6 ACPI 关机（`power.c`）

通过 ACPI 进行 QEMU 虚拟机关机。未能在环境中验证。

#### 2.3.7 链接脚本（`linker.ld`）

加载地址 `0x9000000000200000`（DMW 窗口内 2 MiB 偏移），其余与 RISC-V 相同。

---

### 2.4 进程管理（`kernel/proc.c`，714 行 + `kernel/cpu.c`，14 行）

#### 2.4.1 进程表

```c
static struct proc proctab[NPROC];  // NPROC=128
static char kstacks[NPROC][KSTACK_SIZE];  // 每进程 16 KiB 内核栈
```

- 单核模型：`struct cpu the_cpu`，`mycpu()` 直接返回其地址，`myproc()` 返回 `the_cpu.proc`。
- 进程状态：`UNUSED, USED, SLEEPING, RUNNABLE, RUNNING, ZOMBIE`。

#### 2.4.2 进程分配与初始化（`proc_alloc()`）

从 `proctab` 中找到第一个 `UNUSED` 槽位，分配递增 pid，初始化：
- `tgid = pgid = sid = pid`（默认每个进程是独立的进程组和会话）。
- `uid = euid = 0`（root），`umask = 022`。
- `ngroups = 1, groups[0] = 0`。
- `mmap_top = USTACK_TOP - USTACK_PAGES * PGSIZE`（栈下方作为 mmap 区域）。
- `cwd = "/"`。

#### 2.4.3 调度器

**轮转调度（round-robin）：**
```c
void scheduler(void) {
    for (;;) {
        for (int i = 0; i < NPROC; i++) {
            if (proctab[i].state == RUNNABLE) {
                the_cpu.proc = &proctab[i];
                proctab[i].state = RUNNING;
                swtch(&the_cpu.ctx, &proctab[i].ctx);
                the_cpu.proc = NULL;
            }
        }
        if (all_idle) break;  // 无进程可运行则退出
    }
}
```

- `yield()` 由 timer tick 触发，主动让出 CPU。
- `sched()` 在 `proc_exit()`/`sleep()` 等场景调用，切换到调度器上下文。
- **无优先级、无时间片配置**，仅依赖 100Hz 时钟中断进行抢占。

#### 2.4.4 睡眠/唤醒机制

```c
void sleep(void *chan) {
    struct proc *p = myproc();
    p->chan = chan;
    p->state = SLEEPING;
    sched();
}
void wakeup(void *chan) {
    for (int i = 0; i < NPROC; i++)
        if (proctab[i].state == SLEEPING && proctab[i].chan == chan)
            proctab[i].state = RUNNABLE;
}
void wakeup_n(void *chan, int max) { /* 限制唤醒数量 */ }
```

经典的 xv6 风格睡眠/唤醒，`chan` 为任意地址。存在经典的丢失唤醒问题——依赖调用者在 `sleep()` 前持有锁（本项目因单核且关中断，实际安全）。

#### 2.4.5 进程退出（`proc_exit()` / `proc_exit_signal()`）

- 关闭所有文件描述符。
- 将子进程的 `parent` 重新指向 `init` 进程。
- 通知父进程（wakeup）。
- 对于线程（`is_thread`）：释放用户页表、trapframe，标记为 UNUSED。
- 信号终止：xstate 编码为 `0x10000 | sig`，由 `wait4()` 解码。

#### 2.4.6 缺页处理（`proc_handle_page_fault()`）

多阶段恢复策略：
1. 尝试 COW 处理（`uvmcow`）。
2. 在同 tgid 的其他进程中查找该页面并共享（`uvmshare_page`）。
3. 尝试按需分配栈页面（`uvmprotect` with `alloc_missing=1`）。
4. 检查 VMA 权限并分配页面。
5. 尝试在兄弟进程中查找该地址并复制。

#### 2.4.7 kill 机制

`proc_kill()` 支持 `kill/tkill/tgkill`：
- 信号 1-31 中部分信号直接终止进程树。
- 信号 9 (SIGKILL) 无条件终止。
- `p->killed` 标志在 trap 返回时被 `usertrap()` 检查并调用 `proc_exit_signal()`。

#### 2.4.8 内核线程（`kthread_create()`）

创建不拥有用户页表的内核线程，分配 `kstack` 和 `ctx`，设置 `entry` 函数指针。`kthread_exit()` 将该线程标记为 UNUSED。

---

### 2.5 系统调用层（`kernel/syscall.c` 751 行 + `kernel/sysfile.c` 1443 行 + `kernel/sysproc.c` 928 行）

#### 2.5.1 系统调用分发

`syscall()` 从 `p->trapframe->a7` 读取系统调用号，通过 `switch` 语句分发到约 90+ 个处理函数。返回值写入 `p->trapframe->a0`。

**覆盖的系统调用号（约 130+ 个宏定义）：**
- 文件 I/O（约 40 个）：openat/close/read/write/readv/writev/pread/pwrite/dup/dup3/lseek/fstat/fstatat/faccessat/readlinkat/utimensat/ftruncate/fallocate/fchmod/fchmodat/statx/getdents64/pipe2/getcwd/chdir/mkdirat/unlinkat/symlinkat/linkat/renameat2/fcntl/sendfile 等。
- 进程（约 15 个）：clone/clone3/wait4/execve/getpid/getppid/gettid/exit/exit_group 等。
- 内存（约 6 个）：mmap/munmap/mprotect/brk 等。
- 信号（约 5 个）：kill/tkill/tgkill/rt_sigaction/rt_sigprocmask。
- 调度（约 12 个）：sched_yield/sched_getaffinity/sched_setaffinity/sched_setscheduler 等。
- IPC（4 个）：shmget/shmat/shmdt/shmctl。
- 网络（约 13 个）：socket/bind/listen/accept/connect/sendto/recvfrom 等。
- 时间（约 8 个）：nanosleep/clock_gettime/clock_nanosleep/gettimeofday/times 等。
- 杂项（约 20 个）：uname/sysinfo/getrandom/futex/ioctl/prctl/prlimit64 等。

#### 2.5.2 文件系统调用（`sysfile.c`）

**`sys_openat()`：**
- 从用户空间获取路径字符串。
- 通过 `resolve_at()` 解析绝对路径（支持 `AT_FDCWD` 和目录 fd）。
- 路径别名解析：`maybe_alias_lib_path()` 自动将 `/lib/`、`/lib64/` 路径重定向到 `/glibc/` 或 `/musl/` 对应目录。
- 文件类型分发：`/dev/*`（设备）、ramfs 节点、ext4 inode。
- 支持 `O_CREAT | O_EXCL`、`O_TRUNC`、`O_APPEND`。
- 返回新 fd（最小可用编号）。

**`sys_read()` / `sys_write()`：**
直接调用 `file_read()`/`file_write()`，由文件对象层处理具体类型。

**`sys_pread64()` / `sys_pwrite64()`：**
使用内核缓冲区逐块处理（512 字节块），调用 `file_pread_k()`/`file_pwrite_k()` 进行不更新文件偏移的读写。

**`sys_readv()` / `sys_writev()`：**
遍历 `iovec` 数组，逐元素调用 `file_read()`/`file_write()`。

**`sys_getdents64()`：**
遍历目录项，构造 Linux 兼容的 `dirent64` 结构（对齐 8 字节），通过回调函数 `dents_cb` 填充。支持 ext4 和 ramfs 目录。

**`sys_statx()`：**
返回简化的 `statx` 结构（256 字节），填充 `stx_mask=STATX_BASIC_STATS`、`stx_mode`、`stx_size`、`stx_ino`、`stx_blocks`。支持 `AT_EMPTY_PATH`。

**`sys_pipe2()`：**
调用 `pipe_alloc()` 创建管道对，分配两个 fd，写回用户空间。

**`sys_getcwd()` / `sys_chdir()` / `sys_mkdirat()` / `sys_unlinkat()` / `sys_symlinkat()` / `sys_linkat()` / `sys_renameat2()`：**
基础文件系统操作，均通过 ramfs 或 ext4 查找实现。

**Socket 系列调用：**
实现了本地回环 TCP/UDP socket 模拟：
- `socket()`：分配 `FD_SOCKET` 类型文件。
- `bind()`：注册端口到全局 `socktab[64]`。
- `connect()`：查找目标端口的监听 socket，创建配对连接。
- `accept()`：从 listener 的 `sock_pending` 取出连接。
- `sendto()`/`recvfrom()`：UDP 通过 `find_bound_socket()` 查找目标投递数据；TCP 通过 `f->sock_peer` 传递。
- 数据缓冲在 `sock_rx[]` 环形缓冲区（16 KB）。

**`sys_fcntl()`：**
支持 `F_DUPFD`/`F_DUPFD_CLOEXEC`（dup 到指定起始 fd）、`F_GETFD`/`F_SETFD`（stub）、`F_GETFL`/`F_SETFL`。

#### 2.5.3 进程系统调用（`sysproc.c`）

**`sys_clone()` / `sys_clone3()`：**
- `clone3()` 解析 `struct clone_args`（64+ 字节），提取 flags/stack/tls/child_tid/parent_tid。
- 调用 `clone()`：调用 `proc_alloc()` 创建子进程，复制页表（`uvmcopy_cow`），设置 `tgid` 和 `is_thread`。

**`sys_wait4()`：**
- 支持 `WNOHANG`、`WUNTRACED`。
- 扫描进程表，查找目标 pid 的 ZOMBIE 子进程。
- 信号终止检测（`xstate & 0x10000`）：设置 `WIFSIGNALED`/`WTERMSIG`。
- 无子进程时返回 `-ECHILD`。

**`sys_execve()`：**
- 从用户空间复制路径、argv、envp。
- 相对路径解析为绝对路径。
- 调用 `exec_replace()` 替换当前进程映像。

**`sys_getpid()` / `sys_getppid()` / `sys_gettid()` / `sys_getuid()` / `sys_geteuid()` 等：**
直接返回进程结构体中对应字段。`getpid()` 返回 `tgid`，`gettid()` 返回 `pid`。

**`sys_setuid()` / `sys_setgid()` / `sys_setreuid()` / `sys_setregid()`：**
设置进程凭据，`setuid` 同时设置 real/effective/saved uid。

**`sys_setpgid()` / `sys_setsid()` / `sys_getpgid()` / `sys_getsid()`：**
进程组和会话管理，有基本的权限检查（不能加入其他会话的进程组）。

**`sys_nanosleep()`：**
RISC-V：忙等待直到 `g_ticks` 到达目标值（通过 `yield()` 让出 CPU）。
LoongArch：直接推进 `g_ticks`（模拟时间流逝）。

**`sys_mmap()`：**
- 支持 `MAP_ANONYMOUS`、`MAP_SHARED`、`MAP_FIXED`、`MAP_FIXED_NOREPLACE`。
- 从 `mmap_top` 向下生长分配虚拟地址空间。
- 文件映射：从 `mapf`（ramfs/ext4）读取数据。
- 共享映射 ramfs 文件时直接借用 ramfs 的物理页（增加引用计数）。
- 记录 VMA 描述符到 `p->vmas[]`。

**`sys_munmap()` / `sys_mprotect()`：**
调用 `uvmunmap()`/`uvmprotect()`，更新 VMA。

**`sys_shmget()` / `sys_shmat()` / `sys_shmdt()` / `sys_shmctl()`：**
System V 共享内存实现（最多 16 个段，每段最多 256 页）：
- `shmget()`：创建/查找段，分配物理页。
- `shmat()`：将段的物理页映射到用户地址空间，使用引用计数。
- `shmdt()`：unmap 并减少附加计数，支持延迟销毁。
- `shmctl(IPC_RMID)`：标记移除。

**`sys_uname()`：**
返回固定字符串 `sysname="Linux"`、`release="5.15.0"`、`machine="riscv64"` 或 `"loongarch64"`。

**`sys_sysinfo()`：**
构造 `sysinfo` 结构，`uptime = g_ticks / 100`，`totalram = freeram = 128 MiB`。

**`sys_gettimeofday()` / `sys_clock_gettime()` / `sys_times()`：**
时间相关系统调用，均基于 `g_ticks`。

---

### 2.6 程序加载器（`kernel/elf.c`，120 行 + `kernel/exec.c`，513 行）

#### 2.6.1 ELF64 加载器（`elf.c`）

```c
int elf_load(pagetable_t pt, const u8 *elf, u64 elflen,
             u64 dyn_base, struct elf_info *info);
```

**实现细节：**
- 验证 ELF magic、64位标识。
- 读取 `e_type`：`ET_EXEC` 使用 `bias=0`，`ET_DYN` 使用 `bias=dyn_base`（`ELF_MAIN_BASE = 0x20000000` 或 `ELF_INTERP_BASE = 0x40000000`）。
- 遍历 `PT_LOAD` 段：逐页分配物理帧，映射到用户页表，复制文件数据。
- 处理 `PT_INTERP`：提取动态链接器路径到 `info->interp`。
- 处理 `PT_PHDR`：记录程序头表虚拟地址（用于 AT_PHDR auxv）。
- 返回 `elf_info`：`entry`、`aux_entry`、`base`、`sz`、`phdr`、`phnum`、`phent`。

#### 2.6.2 程序执行器（`exec.c`）

**初始栈构建（`build_stack()`）：**
按照 System V ABI 规范构建用户初始栈：
```
[high address]
  strings (argv, envp)
  AT_RANDOM (16 bytes)
  auxv[]   (AT_NULL terminated)
  envp[]   (NULL terminated)
  argv[]   (NULL terminated)
  argc
[low address]  <- sp
```
auxv 包含：`AT_PHDR, AT_PHENT, AT_PHNUM, AT_PAGESZ, AT_BASE, AT_FLAGS, AT_ENTRY, AT_UID, AT_EUID, AT_GID, AT_EGID, AT_HWCAP, AT_CLKTCK, AT_SECURE, AT_RANDOM, AT_NULL`。

**可执行文件查找链（`setup_image_depth()`）：**

深度最多 4 层的递归解析：
1. **直接路径查找**：ext4_lookup() -> ramfs_lookup()。
2. **BusyBox applet 回退**：如果路径名在 53 个已知 applet 列表中且文件不存在，查找 busybox 并以 `argv[0] = basename` 重新执行。
3. **Shebang 回退**：检测 `#!`，提取解释器路径（busybox sh）。
4. **动态链接器加载**：检测 `PT_INTERP`，加载动态链接器（如 `/lib/ld-musl-*.so.1`），使用 `resolve_interp()` 查找实际路径。

**动态链接器解析（`resolve_interp()`）：**
- 优先查找解释器原始路径。
- 根据 `cwd` 或程序路径判断 glibc/musl 分组。
- 在对应分组下查找 `/lib/` 或 `/lib64/` 中的文件。
- 特殊回退：musl 的 `ld-musl-*.so.1` 不在时尝试 `/musl/lib/libc.so`。

**执行模式：**
- `exec_user()` + `exec_user_cwd()`：创建新进程运行程序。
- `exec_replace()`：替换当前进程映像（execve 实现）。
- 两者均调用 `setup_image()` 构建新页表和栈。

---

### 2.7 内存管理（`mm/pmm.c`，106 行 + `mm/kheap.c`，112 行）

#### 2.7.1 物理页帧分配器（`pmm.c`）

**数据结构：**
- 空闲链表：利用空闲页面前 8 字节存储 `struct run *next`。
- 引用计数数组：`u16 refcnt[MAX_REF_PAGES]`（最多 262,144 页 = 1 GiB）。
- 每个物理页在初始化时被 `kfree_page()` 加入空闲链表（初始 refcnt=1）。

**分配/释放：**
```c
void *kalloc_page(void) {
    struct run *r = freelist;
    freelist = r->next;
    refcnt[idx] = 1;
    memset(r, 0, PGSIZE);  // 清零
    return r;
}
void kfree_page(void *pa) {
    if (--refcnt[idx] > 0) return;  // 引用计数递减
    memset(pa, 1, PGSIZE);  // 毒化（检测 use-after-free）
    r->next = freelist;
    freelist = r;
}
void kref_page(void *pa) { refcnt[idx]++; }  // 增加引用计数
```

**特点：** 零元数据开销（空闲链表嵌入空闲页），引用计数支持 COW 和共享内存，毒化模式帮助调试。

#### 2.7.2 内核堆分配器（`kheap.c`）

**地址有序空闲链表 + 合并：**
```c
struct hdr {
    size_t size;         // 含头部
    struct hdr *next;    // 空闲链表指针
};
```

- `kmalloc(n)`：遍历空闲链表寻找 >= `need` 的块，切割后返回 `(char*)hdr + HDR`。
- `kfree(p)`：将释放块插入有序链表，与相邻块合并。
- `grow()`：从页帧分配器获取新页加入堆。
- 单次分配上限为 `PGSIZE - HDR`（约 4080 字节）。更大的对象应使用 `kalloc_page()`。

---

### 2.8 文件系统（`fs/file.c`，约 830 行 + `fs/pipe.c`，约 100 行 + `fs/ext4/ext4.c`，396 行）

#### 2.8.1 文件对象层（`file.c`）

**文件类型枚举：**
```c
enum file_type { FD_NONE, FD_DEVICE, FD_INODE, FD_RAMFS, FD_PIPE, FD_SOCKET };
```

**全局文件表：** `static struct file ftable[NFILE]`（NFILE=256），基于引用计数的分配/释放。

**设备文件：** 实现了 DEV_CONSOLE（串口输出）、DEV_NULL（写丢弃/读EOF）、DEV_ZERO（读返回零）、DEV_RANDOM（读返回伪随机数，基于 LCG）。

**ramfs（内存文件系统）：**
- 最多 1024 个节点（`ramtab[NRAM]`，NRAM=1024）。
- 按绝对路径索引的平面表（非树形）。
- 每个文件的页面按需分配（最多 `RAMFS_MAX_PAGES = 2048` 页 = 8 MiB）。
- `file_init()` 预填充 `/dev/*`、`/etc/*`、`/bin/*`（busybox applet 存根）、`/tmp/*`、`/proc/*` 等。
- procfs 文件提供静态内容（`/proc/mounts`、`/proc/meminfo`、`/proc/1/stat` 等）。
- 支持符号链接（`is_symlink` + `target`）。
- `ramfs_rename()` 支持目录重命名及其下所有条目的路径前缀更新。

**文件读写：**
- `file_read()`/`file_write()`：按文件类型分发到 ext4、ramfs、pipe、socket、device。
- `file_read_k()`/`file_write_k()`：内核缓冲区变体（用于 sendfile 等）。
- `file_pread_k()`/`file_pwrite_k()`：不更新文件偏移的变体。
- `file_stat()`：填充 `struct kstat`。

#### 2.8.2 管道（`pipe.c`）

**阻塞字节流管道：**
- 环形缓冲区 512 字节（`PIPESIZE=512`）。
- `pipe_read()`：缓冲区空且写端打开时阻塞（sleep），逐字节 copyout。
- `pipe_write()`：缓冲区满时阻塞（sleep），逐字节 copyin。
- `pipe_close()`：标记读/写端关闭，唤醒对端。

**特点：** 简单且正确。管道关闭时正确唤醒对端（读端关闭时返回0/错误）。

#### 2.8.3 ext4 只读驱动（`ext4.c`）

**超级块解析（`ext4_mount()`）：**
- 读取偏移 1024 字节的超级块，验证 magic（0xEF53）。
- 支持 64bit 特性（`INCOMPAT_64BIT`）。
- 提取 `block_size`、`inode_size`、`inodes_per_group`、`desc_size` 等。

**块缓存：** 64 个条目的 LRU 风格缓存（`block_cache_hand` 轮转）。

**Extent 树遍历（`extent_map()`）：**
- 从 inode 的 `i_block` 区域（60 字节）读取根节点。
- 支持任意深度的 interior node 遍历（最多 8 层保护）。
- Leaf 节点中二分查找目标逻辑块号。

**目录遍历（`ext4_readdir_from()`）：**
- 从指定偏移开始遍历目录块。
- 解析 `ext4_dir_entry_2` 结构（inode、rec_len、name_len、file_type）。
- 通过回调函数返回目录项。
- 维护目录偏移用于 `getdents64()` 的分批读取。

**路径解析（`ext4_lookup()`）：**
- 从根 inode 2 开始，逐级查找。
- 128 条目的 LRU 查找缓存（`lookup_cache`）加速热路径。

**文件读取（`ext4_pread()`）：**
- 读取 inode 获取文件大小。
- 逻辑块号 -> extent_map -> 物理块号。
- 使用块缓存读取数据。
- 稀疏文件支持（physical=0 时返回零填充）。

---

### 2.9 块设备驱动（`drivers/virtio_blk.c`，328 行）

#### 2.9.1 RISC-V：virtio-blk over MMIO

**设备发现：** 扫描 `0x10001000 + N*0x1000`（最多 8 个 MMIO 槽），匹配 magic=0x74726976 和 device_id=2。

**Legacy（version=1）模式：**
- 描述符表、available ring、used ring 放在连续 4 页对齐区域。
- `GUEST_PAGE_SIZE=4096`、`QUEUE_ALIGN=4096`。
- `QUEUE_PFN` 传递物理页帧号。

**Modern（version=2）模式：**
- 各 ring 独立页面对齐。
- 通过 `QUEUE_DESC_LOW/HIGH`、`DRIVER_DESC_LOW/HIGH`、`DEVICE_DESC_LOW/HIGH` 传递 64 位地址。
- `QUEUE_READY=1` 激活队列。

**I/O 操作（`blk_read()`/`blk_write()`）：**
- 构造 `struct virtio_blk_req`（type + sector）。
- 填充两个描述符：请求描述符 + 数据描述符（读时 `VRING_DESC_F_WRITE` 在数据描述符上设置）。
- 通过 `QUEUE_NOTIFY` 通知设备。
- 轮询 used ring 等待完成。
- **无中断驱动，仅轮询。**

#### 2.9.2 LoongArch：virtio-blk over PCI

**设备发现：** 扫描 PCI 配置空间（`0x20000000`），匹配 vendor=0x1AF4、device=0x1001（legacy virtio-blk）。

**I/O 端口访问：** 通过 `0x18004000` 区域的 I/O 端口操作。

**Legacy 模式：** 使用 PCI BAR0 的 I/O 端口，与 MMIO legacy 类似但通过 PCI I/O 空间访问寄存器。

---

### 2.10 库函数（`lib/printf.c`，173 行 + `lib/string.c`，103 行）

#### 2.10.1 printf 系列

- `printk()`：直接输出到 UART。
- `snprintk()`/`vsnprintk()`：格式化到缓冲区。
- `panic()`：输出 `[panic] ` 前缀后调用 `arch_halt()`。
- 格式支持：`%d`、`%u`、`%x`/`%X`、`%p`、`%c`、`%s`、`%%`，支持宽度、零填充、`l`/`z` 长度修饰符。
- 使用 `struct sink` 抽象输出目标（UART 或缓冲区）。

#### 2.10.2 字符串/内存函数

完整实现：`memset`、`memcpy`、`memmove`（正确处理重叠）、`memcmp`、`strlen`、`strcmp`、`strncmp`、`strcpy`、`strlcpy`、`strchr`。

---

### 2.11 内核入口（`kernel/main.c`，约 324 行）

#### `kmain()` 初始化序列：

1. `arch_early_init()`：初始化 UART 和平台特定功能。
2. 解析设备树获取 RAM 范围（RISC-V），或使用默认值（LoongArch）。
3. `pmm_init(base, ram_end)`：初始化物理页帧分配器。
4. `kheap_init()`：初始化内核堆。
5. `kvm_init()` + `kvm_enable()`：创建内核页表并启用分页。
6. `trap_init()` + `timer_init()`：设置 trap 向量和定时器。
7. `blk_init()`：探测 virtio-blk 设备。
8. `ext4_mount()`：挂载 EXT4 文件系统。
9. `file_init()`：初始化 ramfs（预填充 /dev、/proc、/bin 等）。
10. `proc_init()`：初始化进程表。
11. `run_test_scripts()`：扫描测试脚本并逐一执行。

#### 测试运行器（`run_test_scripts()`）：

- 从 EXT4 根目录递归扫描（最大深度 4）所有 `*_testcode.sh` 文件。
- 按阶段排序：basic -> busybox -> cyclictest -> iozone -> iperf -> netperf -> libcbench -> libctest -> lmbench -> lua -> ltp。
- 查找最近的 busybox 并作为 shell 执行脚本。
- 环境变量：`PATH=.:/:/bin:/musl:/glibc`、`HOME=/`。

---

### 2.12 头文件体系（`include/`，21 个文件）

| 头文件 | 行数 | 内容 |
|--------|:----:|------|
| `types.h` | 18 | 定宽整数类型、size_t、bool |
| `param.h` | 14 | PGSIZE、NPROC=128、NOFILE=128、NVMA=32、KSTACK_SIZE=16KB |
| `memlayout.h` | 19 | MAXVA、TRAMPOLINE、TRAPFRAME、USTACK |
| `proc.h` | 112 | 进程结构体、调度器接口、context、trapframe |
| `vm.h` | 33 | 页表操作接口、PERM 宏、COW/保护操作 |
| `mm.h` | 14 | 物理内存/堆分配器接口 |
| `syscall.h` | 150 | 约 130+ 个 Linux 系统调用号宏 |
| `trap.h` | 18 | trap 初始化、g_ticks、timer_tick |
| `riscv.h` | 72 | RISC-V CSR 内联函数、PTE 标志位、SSTATUS 位 |
| `loongarch.h` | 78 | LoongArch CSR 常量、内联读写函数 |
| `elf.h` | 26 | ELF 加载接口、elf_info、ELF_MAIN_BASE=0x20000000 |
| `errno.h` | 28 | 30 个标准 errno 宏 |
| `printk.h` | 14 | printk/panic 接口声明 |
| `kio.h` | 20 | 架构中立 I/O 接口（uart、shutdown、intr） |
| `compiler.h` | 18 | likely/unlikely、container_of、__packed |
| `addr.h` | 27 | 内核 VA/PA 转换（RISC-V 恒等，LoongArch DMW） |
| `file.h` (fs/) | 95 | 文件对象、ramnode、pipe、socket 接口 |
| `ext4.h` | 27 | ext4 驱动接口（只读） |
| `fcntl.h` | 15 | open 标志、AT_FDCWD |
| `stat.h` | 38 | Linux 兼容 struct kstat |
| `blkdev.h` | 11 | 块设备接口（blk_read/blk_write） |

---

## 三、子系统交互分析

### 3.1 系统调用路径

```
用户程序 (ecall)
  -> uservec (trampoline.S): 保存寄存器, 切换 satp
    -> usertrap(): scause==8 -> epc+=4, syscall()
      -> syscall(): switch(a7) 分发
        -> sys_xxx(): 通过 trapframe 读取参数
          -> copyin()/copyout(): 通过 walkaddr() 翻译用户地址
          -> proc_alloc()/file_alloc()/kalloc_page() 等内核服务
        <- 返回值写入 trapframe->a0
      <- 返回
    <- usertrapret(): 设置 trampoline 参数, 跳转 userret
  <- userret: 切换 satp, 恢复寄存器, sret
```

### 3.2 进程创建路径

```
fork() / clone()
  -> proc_alloc(): 分配 UNUSED 槽位
  -> uvmcopy_cow(): 复制页表(COW)
  -> clone 时设置 tgid, is_thread, clear_child_tid
  -> ctx.ra = forkret, ctx.sp = kstack+KSTACK_SIZE
  -> state = RUNNABLE
  -> 调度到后: forkret() -> usertrapret() -> userret
```

### 3.3 文件读取路径

```
sys_read(fd, buf, n)
  -> file_read(f, uaddr, n)
    -> FD_INODE: ext4_pread(ino, kbuf, off, chunk) + copyout
    -> FD_RAMFS: ramfs_read_user(rn, off, uaddr, n)
    -> FD_PIPE: pipe_read(pi, uaddr, n)
    -> FD_DEVICE: random_read_user/zero_read_user
    -> FD_SOCKET: socket_dequeue_user
  <- 返回实际读取字节数
```

### 3.4 中断与调度路径

```
时钟中断 (STIE)
  -> kerneltrap() [内核态] 或 usertrap() [用户态]
    -> dev_intr() 识别为 timer (which==2)
      -> timer_tick(): g_ticks++, 清除中断, 设置下次中断
    -> yield(): 当前进程设为 RUNNABLE
      -> sched(): swtch(&p->ctx, &cpu->ctx)
        -> scheduler() 选择下一个 RUNNABLE 进程
```

---

## 四、实现完整度评估

### 4.1 RISC-V 架构（完整度：高 ~90%）

| 组件 | 完整度 | 说明 |
|------|:------:|------|
| 启动/BSS清零 | 100% | 多核过滤、BSS清零 |
| Sv39 页表 | 95% | COW、共享、按需分配、保护 |
| 内核 trap | 100% | 全寄存器保存/恢复 |
| 用户 trap/蹦床 | 100% | trampoline+sret |
| 上下文切换 | 100% | callee-saved 寄存器 |
| SBI 调用 | 80% | 仅 console/timer/shutdown |
| 定时器 | 90% | 100Hz，无高精度支持 |
| 设备树 | 70% | 仅解析 /memory 节点 |

### 4.2 LoongArch 架构（完整度：中 ~70%）

| 组件 | 完整度 | 说明 |
|------|:------:|------|
| 启动 | 100% | 基本启动 |
| 软件 TLB | 80% | 三级页表、COW、共享、缺页 |
| 异常入口 | 90% | 含 TLB 重填向量 |
| 定时器 | 80% | 基于 CSR 的定时器 |
| ACPI 关机 | 60% | 实现但未验证 |
| PCI virtio | 60% | 实现但未验证 |
| 综合 | 70% | 核心功能有，但环境不完整 |

### 4.3 进程管理（完整度：中高 ~75%）

| 功能 | 完整度 | 说明 |
|------|:------:|------|
| 进程创建/销毁 | 90% | exec/fork/clone/exit |
| 线程支持 | 70% | 共享页表、tgid、clear_child_tid |
| COW fork | 95% | 完整的 COW 链 |
| 调度器 | 50% | 仅为轮转调度，无优先级 |
| 睡眠/唤醒 | 80% | 经典实现，有丢失唤醒风险 |
| 信号 | 20% | 仅 kill/tkill 终止，无信号处理 |
| 进程组/会话 | 70% | 基本 API 支持 |

### 4.4 系统调用（完整度：中 ~65%）

约 130+ 个系统调用号定义，实际实现了约 90 个：
- 完整实现（~40个）：openat/close/read/write/readv/writev/pread/pwrite/dup/dup3/lseek/pipe2/getcwd/chdir/mkdirat/unlinkat/readlinkat/symlinkat/renameat2/fcntl/fstat/fstatat/statx/getdents64/getpid/getppid/gettid/getuid/geteuid/getgid/getegid/setuid/setgid/setreuid/setregid/getpgid/getsid/setpgid/setsid/sched_yield/uname/gettimeofday/clock_gettime/sysinfo/nanosleep/clock_nanosleep/times/mmap/munmap/mprotect/brk/clone/clone3/wait4/execve/fork/shmat/shmdt/shmget/shmctl/socket/bind/listen/accept/connect/sendto/recvfrom 等。
- Stub 实现（~30个）：返回 0 或 -ENOSYS。
- 未实现（~40个）：如 sendmsg/recvmsg/epoll 相关等。

### 4.5 内存管理（完整度：中等 ~65%）

| 功能 | 完整度 | 说明 |
|------|:------:|------|
| 物理页分配器 | 85% | 空闲链表+引用计数，最多 1GiB |
| 内核堆 | 75% | 有序合并，单次分配 ≤ 4080 字节 |
| 用户页表 | 90% | 完整的 COW/共享/保护 |
| mmap | 70% | 匿名+文件映射，共享映射优化 |
| mprotect | 80% | 支持按需分配 |
| 栈自动增长 | 50% | 仅缺页处理时尝试分配 |

### 4.6 文件系统（完整度：中高 ~70%）

| 功能 | 完整度 | 说明 |
|------|:------:|------|
| VFS 文件对象层 | 90% | 统一接口，6 种类型 |
| ext4 只读 | 85% | superblock、inode、extent、目录 |
| ext4 写入 | 0% | 完全未实现 |
| ramfs | 85% | 创建/删除/读写/重命名/符号链接 |
| /proc 模拟 | 60% | 少量静态文件 |
| 管道 | 90% | 阻塞环形缓冲区 |
| Socket (本地回环) | 50% | 基本 TCP/UDP 模拟 |

### 4.7 块设备驱动（完整度：中等 ~55%）

| 功能 | 完整度 | 说明 |
|------|:------:|------|
| virtio-blk MMIO (legacy) | 90% | RISC-V 可用 |
| virtio-blk MMIO (modern) | 80% | RISC-V 可用 |
| virtio-blk PCI (legacy) | 50% | LoongArch，未验证 |
| 中断驱动 | 0% | 仅轮询 |
| 写入支持 | 70% | 实现但 ext4 不可写 |

---

## 五、创新性分析

### 5.1 架构创新

1. **真正的 BusyBox Shell 驱动测试**（高创新性）
   与多数参赛项目在内核中模拟 shell 输出不同，本项目让 PID 1 运行**真实 busybox 二进制**来解释测试脚本。这意味着测试输出由真正的 `busybox sh` 产生，逐字节匹配官方期望输出。实现需要完整的 Linux ABI 兼容性（auxv、shebang、动态链接器加载、53 个 busybox applet 自动路由）。

2. **双架构统一内核核心**（中等创新性）
   通用内核代码（`kernel/`、`mm/`、`fs/`、`drivers/`）通过 `ARCH_RISCV`/`ARCH_LOONGARCH` 宏条件编译，架构特定代码隔离在 `arch/` 目录。RISC-V Sv39 和 LoongArch 软件 TLB 共享统一的 `vm.h` 接口（`mappages`/`walkaddr`/`uvmcopy_cow` 等）。

3. **智能路径解析与别名**（中等创新性）
   `maybe_alias_lib_path()` 和 `resolve_interp()` 实现了 `glibc`/`musl` 分组的自动库路径重定向，支持 `/lib/ld-linux-riscv64-lp64d.so.1` 自动映射到 `/glibc/lib64/ld-linux-riscv64-lp64d.so.1`，以及 `/lib/libc.so.6` -> `/glibc/lib64/libc.so` 的别名。对 53 个 busybox applet 的自动识别和路由减少了文件系统依赖。

4. **ramfs + ext4 混合文件系统**（低创新性）
   可写 ramfs 层支持测试过程中的文件创建/修改，只读 ext4 提供测试数据和二进制文件。预填充的 `/proc` 和 `/dev` 模拟提供了必要的伪文件系统接口。

### 5.2 技术特点

- **COW 的 PTE 位复用**：利用 RISC-V PTE bit 8（`PTE_COW`）和 LoongArch PTE bit 60（`LA_PTE_COW`）标记写时复制页面，是 xv6 风格的扩展。
- **共享内存直接物理页借用**：mmap 共享映射 ramfs 文件时直接引用 ramfs 物理页（`kref_page`），避免数据拷贝。
- **LRU 风格缓存**：ext4 块缓存（64 条目）和目录查找缓存（128 条目）使用轮转指针实现简单 LRU 替换。

---

## 六、综合总结

**OSKernel2026** 是一个在 C 语言中从零实现的 OS 内核，以参加 2026 年 OS 内核实现竞赛为目标。项目同时支持 RISC-V 64 和 LoongArch 64 架构。

### 优势

1. **真实二进制兼容性**：能加载并运行未经修改的静态链接 musl/glibc busybox，这要求准确的 auxv 栈构建、动态链接器加载、以及广泛的系统调用覆盖。
2. **代码结构清晰**：架构相关与通用内核分离，接口定义明确（`vm.h`、`proc.h`、`file.h`、`kio.h` 等）。
3. **系统调用覆盖广泛**：实现了约 90 个 Linux 兼容系统调用，远超最小子集。
4. **COW 实现完整**：fork 时的写时复制机制在两架构上均完整实现。
5. **ext4 extent 树支持**：正确处理了现代 ext4 文件系统的 extent 布局（非传统间接块）。

### 不足

1. **信号系统基本缺失**：仅有 `kill`/`tkill` 终止进程，无用户态信号处理（`sigaction` 为 stub）。
2. **调度器过于简单**：仅轮转调度，无优先级、无 CFS、无多核支持（所有次核被 `park`）。
3. **ext4 不可写**：限制了大范围的文件系统测试场景。
4. **网络栈是模拟的**：socket 实现在内核内部闭环，无真实网络设备驱动。
5. **LoongArch 未完成**：核心功能存在但未达到与 RISC-V 同等的测试通过状态。
6. **无用户态中断驱动 I/O**：virtio-blk 使用轮询模式，无真实的中断驱动块设备 I/O。
7. **部分系统调用为 stub**：许多返回 0 或 -ENOSYS 的调用可能在更复杂测试中暴露问题。

### 定位

该项目处于竞赛 Phase 4 完成、Phase 5（signals+threads）进行中的状态。其核心竞争力在于通过真实 busybox shell 运行测试脚本实现逐字节输出匹配。在 2026 年 OS 内核竞赛的背景下，该项目在文件系统和系统调用兼容性方面表现突出，但在调度器、信号处理和网络方面还有显著的提升空间。