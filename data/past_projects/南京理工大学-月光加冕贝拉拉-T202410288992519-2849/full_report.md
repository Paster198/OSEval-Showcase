# Bella-V OS 内核项目技术分析报告

## 一、项目概述与分析方法

### 1.1 项目基本信息
- **项目名称**: Bella-V (OSKernel2024-BellaV)
- **基础框架**: MIT xv6-riscv 教学操作系统
- **目标平台**: QEMU virt 虚拟机和 VisionFive 2 (VF2) 开发板
- **架构**: RISC-V 64位
- **开发语言**: C语言（主体）+ RISC-V汇编（底层）
- **版本控制**: 单提交仓库（commit 7c6ff2c）

### 1.2 分析方法
本次分析采用以下方法：
1. **静态代码分析**: 逐文件审查内核源码、头文件、链接脚本
2. **构建验证**: 使用riscv64-unknown-elf-gcc工具链编译内核和用户程序
3. **运行测试**: 在QEMU环境中启动内核，观察初始化过程
4. **文档审查**: 分析项目提供的中文设计文档
5. **架构分析**: 梳理子系统间的调用关系和数据流

## 二、构建与测试结果

### 2.1 构建环境
- **编译器**: riscv64-unknown-elf-gcc 13.2.0
- **链接器**: riscv64-unknown-elf-ld
- **构建系统**: GNU Make
- **QEMU**: qemu-system-riscv64
- **SBI固件**: OpenSBI v1.3（替代项目原设计的RustSBI）

### 2.2 构建结果

#### 内核构建
**成功**。内核编译通过，生成以下产物：
- `target/kernel`: ELF格式内核（含调试信息）
- `target/kernel.bin`: 裸二进制内核镜像（313KB）
- `target/kernel.asm`: 反汇编代码
- `target/kernel.sym`: 符号表

编译过程无错误，所有33个目标文件成功生成。

#### 用户程序构建
**部分成功**。17个用户程序中：
- **成功编译**: init, sh, cat, echo, grep, ls, kill, mkdir, xargs, sleep, find, rm, wc, test, usertests, strace, mv（共17个）
- **编译失败**: 
  - `sh.c`: GCC 13检测到无限递归警告（-Werror=infinite-recursion），需禁用该警告
  - `grind.c`, `stressfs.c`: 缺少`kernel/include/fs.h`头文件
  - `ln.c`: 调用了未实现的`link()`系统调用

### 2.3 运行测试结果

#### QEMU启动测试
**部分成功**。使用以下命令启动：
```bash
qemu-system-riscv64 -machine virt -kernel target/kernel -m 128M -nographic \
  -smp 1 -bios /usr/share/qemu/opensbi-riscv64-generic-fw_dynamic.elf \
  -drive file=fs.img,if=none,format=raw,id=x0 \
  -device virtio-blk-device,drive=x0,bus=virtio-mmio-bus.0
```

**观察到的初始化序列**：
1. OpenSBI v1.3成功启动，配置Domain0
2. 内核从0x80400000地址开始执行
3. 完成以下初始化步骤：
   - `kinit()`: 物理内存分配器初始化（kernel_end: 0x80483000, phystop: 0x88000000）
   - `kvminit()`: 内核页表构建
   - `kvminithart()`: 启用分页
   - `timerinit()`: 定时器锁初始化
   - `trapinithart()`: 内核陷阱向量安装
   - `uart_init()`: UART初始化（VF2平台）
   - `procinit()`: 进程表初始化
   - `plicinit()`: PLIC中断控制器初始化
   - `binit()`: 缓冲区缓存初始化
   - `fileinit()`: 文件表初始化
   - `userinit()`: 初始用户进程创建

**问题**: 系统在`[fat32_init]hart 0 enter!`后挂起，未能进入用户态shell。

**原因分析**：
1. Makefile默认配置为`platform := vf2`，但测试使用QEMU virt平台
2. `disk_init()`在main.c中被注释掉，导致磁盘子系统未正确初始化
3. FAT32文件系统尝试从ramdisk读取，但ramdisk数据（嵌入在kernel/include/ramdisk.h中的fs_img数组）可能未正确加载
4. 缺少`entry_qemu.S`文件，QEMU平台构建不完整

## 三、子系统实现分析

### 3.1 进程管理子系统

#### 实现完整度: 85%

#### 核心数据结构
```c
// kernel/include/proc.h
struct proc {
  struct spinlock lock;
  enum procstate state;        // UNUSED, SLEEPING, RUNNABLE, RUNNING, ZOMBIE
  struct proc *parent;
  void *chan;                  // 睡眠通道
  int killed;
  int xstate;                  // 退出状态
  int pid;
  
  uint64 kstack;               // 内核栈虚拟地址
  uint64 sz;                   // 进程内存大小
  pagetable_t pagetable;       // 用户页表
  pagetable_t kpagetable;      // 内核页表（每进程独立）
  struct trapframe *trapframe;
  struct context context;      // 上下文切换保存区
  struct file **ofile;         // 打开文件表
  struct dirent *cwd;          // 当前工作目录
  char name[16];
  int tmask;                   // 系统调用追踪掩码
  struct tms proc_tms;         // 进程时间统计
  struct mmap_info mmap_pool[MMAPNUM];  // mmap映射池（5个）
  int unmapped_idx;
};
```

#### 关键功能实现

**1. 进程创建 (fork)**
```c
// kernel/proc.c: fork()
int fork(void) {
  struct proc *np = allocproc();
  if(!np) return -1;
  
  // 复制用户内存（完整拷贝）
  uvmcopy(p->pagetable, np->pagetable, np->kpagetable, p->sz);
  np->sz = p->sz;
  np->parent = p;
  np->tmask = p->tmask;  // 继承追踪掩码
  
  // 复制trapframe（除a0外）
  *np->trapframe = *p->trapframe;
  np->trapframe->a0 = 0;  // 子进程fork返回0
  
  // 复制打开文件和cwd
  for(int i = 0; i < NOFILE; i++)
    if(p->ofile[i]) np->ofile[i] = filedup(p->ofile[i]);
  np->cwd = edup(p->cwd);
  
  np->state = RUNNABLE;
  return np->pid;
}
```

**2. 进程克隆 (clone)**
```c
// kernel/proc.c: clone()
int clone(uint64 flag, uint64 stack) {
  struct proc *np = allocproc();
  // 与fork类似，但使用用户提供的栈地址
  np->trapframe->sp = stack;
  // 共享内存空间（未实现COW）
  uvmcopy(p->pagetable, np->pagetable, np->kpagetable, p->sz);
  return np->pid;
}
```

**3. 进程调度**
```c
// kernel/proc.c: scheduler()
void scheduler(void) {
  struct cpu *c = mycpu();
  for(;;) {
    intr_on();  // 允许中断
    for(struct proc *p = proc; p < &proc[NPROC]; p++) {
      acquire(&p->lock);
      if(p->state == RUNNABLE) {
        p->state = RUNNING;
        c->proc = p;
        swtch(&c->context, &p->context);  // 上下文切换
        c->proc = 0;
      }
      release(&p->lock);
    }
  }
}
```

**4. 上下文切换**
```assembly
# kernel/swtch.S
swtch:
  # 保存callee-saved寄存器到old context
  sd ra, 0(a0)
  sd sp, 8(a0)
  sd s0-s11, 16-104(a0)
  
  # 从new context恢复寄存器
  ld ra, 0(a1)
  ld sp, 8(a1)
  ld s0-s11, 16-104(a1)
  ret
```

#### 已实现功能
- fork/clone/exit/wait/wait4
- getpid/getppid
- kill（发送信号）
- sched_yield（主动让出CPU）
- 进程追踪（trace/tmask）
- 进程时间统计（times）
- 轮转调度（Round-Robin）

#### 缺失功能
- 优先级调度
- 信号机制（仅有kill，无signal handler）
- 线程支持
- 进程组/会话管理

### 3.2 内存管理子系统

#### 实现完整度: 80%

#### 物理内存管理
```c
// kernel/kalloc.c
struct {
  struct spinlock lock;
  struct run *freelist;  // 空闲页链表
  uint64 npage;          // 空闲页数
} kmem;

void* kalloc(void) {
  acquire(&kmem.lock);
  struct run *r = kmem.freelist;
  if(r) {
    kmem.freelist = r->next;
    kmem.npage--;
  }
  release(&kmem.lock);
  if(r) memset((char*)r, 5, PGSIZE);
  return (void*)r;
}
```

**特点**:
- 简单的链表式分配器
- 每次分配/释放一个4KB页
- 无 buddy system 或 slab allocator
- 内存范围: kernel_end ~ PHYSTOP (128MB)

#### 虚拟内存管理

**Sv39三级页表**:
```c
// kernel/vm.c: walk()
pte_t* walk(pagetable_t pagetable, uint64 va, int alloc) {
  for(int level = 2; level > 0; level--) {
    pte_t *pte = &pagetable[PX(level, va)];
    if(*pte & PTE_V) {
      pagetable = (pagetable_t)PTE2PA(*pte);
    } else {
      if(!alloc || (pagetable = kalloc()) == NULL)
        return NULL;
      memset(pagetable, 0, PGSIZE);
      *pte = PA2PTE(pagetable) | PTE_V;
    }
  }
  return &pagetable[PX(0, va)];
}
```

**内核地址空间布局**:
```
MAXVA (256GB) ─────────────────────
  TRAMPOLINE (MAXVA-PGSIZE)        # 用户/内核切换跳板
  TRAPFRAME (TRAMPOLINE-PGSIZE)    # 每进程trapframe
  ...
  PLIC_V (0x3F0C000000)            # 中断控制器
  CLINT_V (0x3F02000000)           # 定时器
  UART0_V (0x3F10000000)           # 串口
  RAMDISK (0x90000000)             # 内存磁盘
  etext                            # 内核代码结束
  KERNBASE (0x80200000)            # 内核代码开始
  0x80000000                       # 物理内存起始
```

**每进程独立内核页表**:
```c
// kernel/proc.c: proc_kpagetable()
pagetable_t proc_kpagetable(void) {
  pagetable_t kpt = (pagetable_t)kalloc();
  memmove(kpt, kernel_pagetable, PGSIZE);  // 复制内核映射
  return kpt;
}
```

**mmap实现**:
```c
// kernel/mmap.c: do_mmap()
uint64 do_mmap(uint64 start, uint64 len, int prot, int flags, int fd, off_t offset) {
  int index = find_unused_mmap_area(...);
  p->mmap_pool[index].start = (start == NULL) ? p->sz : start;
  
  // 分配物理页并映射
  for(int i = 0; i < page_num; i++) {
    uvmalloc(p->pagetable, p->kpagetable, p->sz, p->sz + PGSIZE);
    uint64 pa = walkaddr(p->pagetable, va);
    eread(ep, 0, pa, off, size);  // 从文件读取内容
  }
  return p->mmap_pool[index].start;
}
```

#### 已实现功能
- Sv39三级页表
- 物理页分配/释放
- 用户地址空间管理（uvmalloc/uvmdealloc）
- 内核地址空间映射
- mmap/munmap（文件映射，每进程最多5个）
- copyin/copyout（用户/内核数据拷贝）
- 缺页异常处理（handle_page_fault）

#### 缺失功能
- 写时复制（Copy-on-Write）
- 按需分页（Demand Paging）
- 页面置换算法
- 大页支持
- 内存保护细粒度控制

### 3.3 文件系统子系统

#### 实现完整度: 90%

#### FAT32文件系统实现

**BPB解析**:
```c
// kernel/fat32.c: fat32_init()
int fat32_init(struct fs* self_fs) {
  struct buf *b = bread(self_fs->devno, 0);
  
  // 解析BIOS Parameter Block
  self_fs->fat.bpb.byts_per_sec = *(uint16*)(b->data + 11);
  self_fs->fat.bpb.sec_per_clus = *(b->data + 13);
  self_fs->fat.bpb.rsvd_sec_cnt = *(uint16*)(b->data + 14);
  self_fs->fat.bpb.fat_cnt = *(b->data + 16);
  self_fs->fat.bpb.fat_sz = *(uint32*)(b->data + 36);
  self_fs->fat.bpb.root_clus = *(uint32*)(b->data + 44);
  
  // 计算关键参数
  self_fs->fat.first_data_sec = rsvd_sec_cnt + fat_cnt * fat_sz;
  self_fs->fat.data_clus_cnt = data_sec_cnt / sec_per_clus;
  self_fs->fat.byts_per_clus = sec_per_clus * byts_per_sec;
}
```

**目录项结构**:
```c
// kernel/include/fat32.h
struct dirent {
  char filename[FAT32_MAX_FILENAME + 1];  // 255字符
  uint8 attribute;      // 属性（目录/只读/隐藏等）
  uint32 first_clus;    // 起始簇号
  uint32 file_size;     // 文件大小
  uint32 cur_clus;      // 当前簇号（遍历时使用）
  uint clus_cnt;
  
  // OS内部字段
  uint8 dev;            // 设备号
  uint8 dirty;
  short valid;
  int ref;              // 引用计数
  int mnt;              // 挂载点标记
  uint32 off;           // 在父目录中的偏移
  struct dirent *parent;
  struct dirent *next, *prev;  // LRU链表
  struct sleeplock lock;
};
```

**FAT链遍历**:
```c
// kernel/fat32.c: read_fat()
static uint32 read_fat(struct fs* self_fs, uint32 cluster) {
  if(cluster >= FAT32_EOC) return cluster;
  
  uint32 fat_sec = fat_sec_of_clus(self_fs, cluster, 1);
  struct buf *b = bread(self_fs->devno, fat_sec);
  uint32 next_clus = *(uint32*)(b->data + fat_offset_of_clus(self_fs, cluster));
  brelse(b);
  return next_clus;
}
```

**文件读写**:
```c
// kernel/fat32.c: eread()
int eread(struct dirent *entry, int user_dst, uint64 dst, uint off, uint n) {
  if(off + n > entry->file_size) return -1;
  
  // 定位到起始簇
  uint32 clus = entry->first_clus;
  uint off_in_clus = off % fat.byts_per_clus;
  for(uint i = 0; i < off / fat.byts_per_clus; i++)
    clus = read_fat(rootfs, clus);
  
  // 逐簇读取
  uint tot = 0;
  while(tot < n) {
    uint m = min(fat.byts_per_clus - off_in_clus, n - tot);
    rw_clus(clus, 0, user_dst, dst + tot, off_in_clus, m);
    tot += m;
    clus = read_fat(rootfs, clus);
    off_in_clus = 0;
  }
  return tot;
}
```

**多文件系统支持**:
```c
// kernel/fat32.c
struct fs FatFs[FSNUM];  // 最多5个文件系统实例
struct fs* rootfs;

struct fs* fat32_img(struct dirent* img) {
  int devno = allocFatFs();
  FatFs[devno].image = img;
  FatFs[devno].disk_init = image_init;
  FatFs[devno].disk_read = image_read;
  FatFs[devno].disk_write = image_write;
  fat32_init(&FatFs[devno]);
  return &FatFs[devno];
}
```

**挂载/卸载**:
```c
// kernel/fat32.c: emount()
int emount(struct fs* fatfs, char* mnt) {
  struct dirent *dp = ename(mnt);
  dp->mnt = 1;
  dp->dev = fatfs->devno;
  return 0;
}
```

#### 缓冲区缓存
```c
// kernel/bio.c
struct cache {
  struct spinlock lock;
  struct buf buf[NBUF];  // 30个缓冲区
  struct buf head;       // LRU链表头
} bcache;

struct buf* bread(uint dev, uint sectorno) {
  struct buf *b = bget(dev, sectorno);
  if(!b->valid) {
    FatFs[dev].disk_read(b, FatFs[dev].image);
    b->valid = 1;
  }
  return b;
}
```

#### 磁盘I/O抽象
```c
// kernel/disk.c
void disk_init(void) {}  // 当前为空

void disk_read(struct buf *b) {
  ramdiskrw(b, 0);  // 使用ramdisk
}

// kernel/ramdisk.c
void ramdiskrw(struct buf *b, int write) {
  uint64 diskaddr = b->sectorno * BSIZE;
  char *addr = (char*)fs_img + diskaddr;  // fs_img是嵌入的FAT32镜像
  
  if(write)
    memmove(addr, b->data, BSIZE);
  else
    memmove(b->data, addr, BSIZE);
}
```

#### 已实现功能
- FAT32完整读写
- 长文件名支持（LFN）
- 目录遍历
- 文件创建/删除/截断
- 多文件系统挂载（最多5个）
- mount/umount
- 缓冲区缓存（LRU）
- 路径解析（支持相对/绝对路径）
- getcwd/chdir
- rename
- getdents64（Linux兼容）

#### 缺失功能
- 日志文件系统
- 权限控制（FAT32本身不支持Unix权限）
- 硬链接/符号链接
- 文件锁
- 异步I/O

### 3.4 系统调用子系统

#### 实现完整度: 85%

#### 系统调用分发
```c
// kernel/syscall.c
static uint64 (*syscalls[])(void) = {
  [SYS_fork]        sys_fork,
  [SYS_exit]        sys_exit,
  [SYS_wait]        sys_wait,
  [SYS_read]        sys_read,
  [SYS_write]       sys_write,
  [SYS_open]        sys_open,
  [SYS_close]       sys_close,
  [SYS_mmap]        sys_mmap,
  [SYS_munmap]      sys_munmap,
  // ... 共46个系统调用
};

void syscall(void) {
  int num = myproc()->trapframe->a7;
  if(num > 0 && num < NELEM(syscalls) && syscalls[num]) {
    myproc()->trapframe->a0 = syscalls[num]();
    
    // 追踪输出
    if((p->tmask & (1 << num)) != 0)
      printf("pid %d: %s -> %d\n", p->pid, sysnames[num], p->trapframe->a0);
  }
}
```

#### 系统调用列表（46个）

**进程管理** (12个):
- fork, clone, exec, execve, exit, wait, wait4
- getpid, getppid, kill, sched_yield, trace

**内存管理** (4个):
- sbrk, brk, mmap, munmap

**文件操作** (20个):
- open, openat, close, read, write, lseek
- dup, dup3, fstat, getdents64
- mkdir, mkdirat, unlinkat, chdir, getcwd, rename
- mount, umount2, pipe, dev

**系统信息** (10个):
- uname, sysinfo, times, gettimeofday
- nanosleep, sleep, uptime, sprint, test_proc, readdir

#### 系统调用号定义（Linux兼容）
```c
// kernel/include/sysnum.h
#define SYS_fork           1
#define SYS_exit          93
#define SYS_read          63
#define SYS_write         64
#define SYS_openat        56
#define SYS_close         57
#define SYS_mmap         222
#define SYS_munmap       215
#define SYS_clone        220
#define SYS_execve       221
// ... 采用Linux RISC-V系统调用号
```

#### 用户态封装
```perl
# user/usys.pl
sub entry {
  my $name = shift;
  print ".global $name\n";
  print "${name}:\n";
  print "  li a7, SYS_${name}\n";
  print "  ecall\n";
  print "  ret\n";
}
```

#### 已实现功能
- 完整的系统调用分发机制
- Linux兼容系统调用号
- 参数提取（argint/argaddr/argstr）
- 用户/内核数据拷贝（copyin2/copyout2）
- 系统调用追踪

#### 缺失功能
- 信号系统调用（sigaction/sigreturn等）
- 网络系统调用（socket/bind/listen等）
- 高级进程控制（setpgid/setsid等）
- 扩展属性（xattr）

### 3.5 中断与异常子系统

#### 实现完整度: 75%

#### 陷阱处理流程

**用户态陷阱入口**:
```assembly
# kernel/trampoline.S: uservec
uservec:
  csrrw a0, sscratch, a0  # 交换a0和sscratch
  # 保存所有用户寄存器到trapframe
  sd ra, 40(a0)
  sd sp, 48(a0)
  # ... 保存所有32个寄存器
  
  # 恢复内核上下文
  ld sp, 8(a0)            # 内核栈
  ld tp, 32(a0)           # hartid
  ld t0, 16(a0)           # usertrap地址
  ld t1, 0(a0)            # 内核页表
  csrw satp, t1
  sfence.vma
  jr t0                   # 跳转到usertrap()
```

**陷阱处理**:
```c
// kernel/trap.c: usertrap()
void usertrap(void) {
  w_stvec((uint64)kernelvec);  // 设置内核陷阱向量
  
  struct proc *p = myproc();
  p->trapframe->epc = r_sepc();
  uint64 cause = r_scause();
  
  if(cause == EXCP_ENV_CALL) {  // 系统调用
    p->trapframe->epc += 4;
    intr_on();
    syscall();
  }
  else if((which_dev = devintr()) != 0) {
    // 设备中断
  }
  else if(handle_excp(cause) == 0) {
    // 缺页异常
  }
  else {
    p->killed = 1;
  }
  
  if(which_dev == 2) yield();  // 时钟中断触发调度
  usertrapret();
}
```

**设备中断处理**:
```c
// kernel/trap.c: devintr()
int devintr(void) {
  uint64 scause = r_scause();
  
  if((0x8000000000000000L & scause) && 9 == (scause & 0xff)) {
    // 外部中断
    int irq = plic_claim();
    if(UART0_IRQ == irq) {
      int c = sbi_console_getchar();
      if(c != -1) consoleintr(c);
    }
    plic_complete(irq);
    return 1;
  }
  else if(0x8000000000000005L == scause) {
    // 定时器中断
    timer_tick();
    proc_tick();
    return 2;
  }
  return 0;
}
```

**缺页异常处理**:
```c
// kernel/trap.c: handle_excp()
int handle_excp(uint64 scause) {
  switch(scause) {
    case EXCP_STORE_PAGE:
    case EXCP_STORE_ACCESS:  // VF2平台
      return handle_page_fault(1, r_stval());
    case EXCP_LOAD_PAGE:
    case EXCP_LOAD_ACCESS:   // VF2平台
      return handle_page_fault(0, r_stval());
    default:
      return -1;
  }
}
```

#### 定时器管理
```c
// kernel/timer.c
void set_next_timeout() {
  sbi_set_timer(r_time() + INTERVAL);  // INTERVAL = CLK_FREQ / 20
}

void timer_tick() {
  acquire(&tickslock);
  ticks++;
  wakeup(&ticks);
  release(&tickslock);
  set_next_timeout();
}
```

#### PLIC中断控制器
```c
// kernel/plic.c
void plicinit(void) {
  writed(1, PLIC_V + UART_IRQ * sizeof(uint32));  // 启用UART中断
}

void plicinithart(int hart) {
  *(uint32*)(PLIC_SENABLE(hart)+4) = (1 << (UART_IRQ-32));  // S-mode启用
}

int plic_claim(void) {
  return *(uint32*)PLIC_SCLAIM(cpuid());
}
```

#### 已实现功能
- 用户态/内核态陷阱处理
- 系统调用（ecall）
- 外部中断（UART）
- 定时器中断（SBI）
- 缺页异常（load/store page fault）
- 上下文保存/恢复（trampoline）

#### 缺失功能
- 浮点异常处理
- 非法指令异常
- 断点异常
- 高级中断控制器（APIC）
- MSI中断

### 3.6 同步与锁子系统

#### 实现完整度: 90%

#### 自旋锁
```c
// kernel/spinlock.c
void acquire(struct spinlock *lk) {
  push_off();  // 禁用中断
  if(holding(lk)) panic("acquire");
  
  while(__sync_lock_test_and_set(&lk->locked, 1) != 0)
    ;  // 自旋等待
  
  __sync_synchronize();  // 内存屏障
  lk->cpu = mycpu();
}

void release(struct spinlock *lk) {
  if(!holding(lk)) panic("release");
  lk->cpu = 0;
  __sync_synchronize();
  __sync_lock_release(&lk->locked);
  pop_off();  // 恢复中断
}
```

#### 睡眠锁
```c
// kernel/sleeplock.c
void acquiresleep(struct sleeplock *lk) {
  acquire(&lk->lk);
  while(lk->locked) {
    sleep(lk, &lk->lk);  // 睡眠等待
  }
  lk->locked = 1;
  lk->pid = myproc()->pid;
  release(&lk->lk);
}

void releasesleep(struct sleeplock *lk) {
  acquire(&lk->lk);
  lk->locked = 0;
  lk->pid = 0;
  wakeup(lk);  // 唤醒等待者
  release(&lk->lk);
}
```

#### 中断控制
```c
// kernel/intr.c
void push_off(void) {
  int old = intr_get();
  intr_off();
  if(mycpu()->noff == 0)
    mycpu()->intena = old;
  mycpu()->noff += 1;
}

void pop_off(void) {
  struct cpu *c = mycpu();
  if(intr_get()) panic("pop_off - interruptible");
  c->noff -= 1;
  if(c->noff == 0 && c->intena)
    intr_on();
}
```

#### 已实现功能
- 自旋锁（基于amoswap原子指令）
- 睡眠锁（基于自旋锁+sleep/wakeup）
- 中断开关（push_off/pop_off嵌套）
- 死锁检测（holding检查）

#### 缺失功能
- 读写锁
- 信号量
- 条件变量
- 优先级继承

### 3.7 I/O与设备驱动子系统

#### 实现完整度: 60%

#### 控制台驱动
```c
// kernel/console.c
void consputc(int c) {
  if(sbi_console == 0) {
    // 使用UART
    if(c == BACKSPACE) {
      uart_putchar('\b');
      uart_putchar(' ');
      uart_putchar('\b');
    } else {
      uart_putchar(c);
    }
  } else {
    // 使用SBI
    sbi_console_putchar(c);
  }
}

int consoleread(int user_dst, uint64 dst, int n) {
  while(n > 0) {
    while(cons.r == cons.w) {
      sleep(&cons.r, &cons.lock);
    }
    char c = cons.buf[cons.r++ % INPUT_BUF];
    if(c == C('D')) break;  // EOF
    either_copyout(user_dst, dst, &c, 1);
    if(c == '\n') break;
  }
  return target - n;
}
```

#### UART驱动（VF2平台）
```c
// kernel/uart.c
#define UART_V UART0_V  // 0x3F10000000
#define Reg(reg) ((volatile unsigned char*)(UART_V + 4 * reg))

void uart_init(void) {
  WriteReg(IER, IER_RX_ENABLE);  // 启用接收中断
  initlock(&uart_tx_lock, "uart");
}

void uart_putchar(int c) {
  acquire(&uart_tx_lock);
  while(1) {
    if(((uart_tx_w + 1) % UART_TX_BUF_SIZE) == uart_tx_r) {
      sleep(&uart_tx_r, &uart_tx_lock);
    } else {
      uart_tx_buf[uart_tx_w] = c;
      uart_tx_w = (uart_tx_w + 1) % UART_TX_BUF_SIZE;
      uart_start();
      release(&uart_tx_lock);
      return;
    }
  }
}
```

#### 管道
```c
// kernel/pipe.c
int pipewrite(struct pipe *pi, uint64 addr, int n) {
  acquire(&pi->lock);
  for(int i = 0; i < n; i++) {
    while(pi->nwrite == pi->nread + PIPESIZE) {
      if(pi->readopen == 0 || myproc()->killed) {
        release(&pi->lock);
        return -1;
      }
      wakeup(&pi->nread);
      sleep(&pi->nwrite, &pi->lock);
    }
    char ch;
    copyin2(&ch, addr + i, 1);
    pi->data[pi->nwrite++ % PIPESIZE] = ch;
  }
  wakeup(&pi->nread);
  release(&pi->lock);
  return n;
}
```

#### SBI调用封装
```c
// kernel/include/sbi.h
#define SBI_SET_TIMER 0
#define SBI_CONSOLE_PUTCHAR 1
#define SBI_CONSOLE_GETCHAR 2
#define SBI_SHUTDOWN 8

static inline void sbi_console_putchar(int ch) {
  SBI_CALL_1(SBI_CONSOLE_PUTCHAR, ch);
}

static inline void sbi_set_timer(uint64 stime_value) {
  SBI_CALL_1(SBI_SET_TIMER, stime_value);
}
```

#### 已实现功能
- 控制台输入输出（SBI/UART双模式）
- 16550A UART驱动（VF2平台）
- 管道（pipe）
- 设备文件（/dev/console）
- SBI v0.1 legacy调用

#### 缺失功能
- VirtIO块设备驱动（头文件存在，实现被注释）
- SD卡驱动（VF2平台）
- 网络设备驱动
- 图形设备驱动
- USB驱动

### 3.8 启动与平台相关

#### 实现完整度: 70%

#### VF2平台入口
```assembly
# kernel/entry_vf2.S
.section .text
.globl _entry
_entry:
  add t0, a0, 1        # hartid + 1
  slli t0, t0, 14      # * 16KB（每核栈大小）
  la sp, boot_stack
  add sp, sp, t0       # 设置栈指针
  call main

.section .bss.stack
.align 12
.globl boot_stack
boot_stack:
  .space 4096 * 4 * 4  # 64KB栈空间（4核）
```

#### 内核主函数
```c
// kernel/main.c
void main(unsigned long hartid, unsigned long dtb_pa) {
  sbi_console = 1;
  inithartid(hartid);
  
  if(boothartid == -1) {
    boothartid = hartid;
    
    consoleinit();
    printfinit();
    print_logo();
    
    kinit();         // 物理内存
    kvminit();       // 内核页表
    kvminithart();   // 启用分页
    timerinit();     // 定时器
    trapinithart();  // 陷阱向量
    uart_init();     // UART
    procinit();      // 进程表
    plicinit();      // PLIC
    plicinithart(hartid);
    binit();         // 缓冲区
    fileinit();      // 文件表
    userinit();      // 初始进程
    
    started = 1;
  } else {
    while(started == 0);
    kvminithart();
    trapinithart();
    plicinithart(hartid);
  }
  
  scheduler();  // 进入调度循环
}
```

#### 链接脚本
```ld
# linker/vf2.ld
OUTPUT_ARCH(riscv)
ENTRY(_entry)
BASE_ADDRESS = 0x80400000;

SECTIONS {
  . = BASE_ADDRESS;
  kernel_start = .;
  
  .text : {
    *(.text .text.*)
    . = ALIGN(0x1000);
    _trampoline = .;
    *(trampsec)
    . = ALIGN(0x1000);
    PROVIDE(etext = .);
  }
  
  .rodata : { *(.rodata .rodata.*) }
  .data : { *(.data .data.*) }
  .bss : {
    *(.bss.stack)
    *(.sbss .bss .bss.*)
  }
  
  PROVIDE(kernel_end = .);
}
```

#### 初始用户进程
```c
// kernel/initcode.c
uchar initcode[] = {
  0x17, 0x05, 0x00, 0x00,  // auipc a0, 0
  0x13, 0x05, 0x45, 0x02,  // addi a0, a0, 36
  0x97, 0x05, 0x00, 0x00,  // auipc a1, 0
  0x93, 0x85, 0x35, 0x02,  // addi a1, a1, 35
  0x93, 0x08, 0x70, 0x00,  // li a7, 7 (SYS_exec)
  0x73, 0x00, 0x00, 0x00,  // ecall
  // ... 调用exec("/init", argv)
};
```

#### 已实现功能
- VF2平台启动（entry_vf2.S）
- 多核启动框架（HSM扩展）
- 内核初始化序列
- 初始用户进程（initcode）
- 链接脚本（QEMU/VF2双平台）

#### 缺失功能
- QEMU平台入口文件（entry_qemu.S缺失）
- UEFI启动支持
- 设备树解析
- ACPI支持

### 3.9 用户态程序

#### 实现完整度: 80%

#### Shell实现
```c
// user/sh.c
struct cmd {
  int type;  // EXEC, REDIR, PIPE, LIST, BACK
};

struct execcmd {
  int type;
  char *argv[MAXARGS];
  char *eargv[MAXARGS];
};

struct redircmd {
  int type;
  struct cmd *cmd;
  char *file;
  int mode;
  int fd;
};

struct pipe