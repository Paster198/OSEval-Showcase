# SystemNQB OS 内核项目技术报告

## 1. 项目概述

**项目名称**: SystemNQB  
**开发团队**: 长春理工大学 - 你起吧  
**目标架构**: RISC-V 64位 (riscv64gc)  
**基础框架**: 基于 xv6-riscv 进行二次开发  
**语言构成**: C 语言为主体（内核核心逻辑），Rust 语言为辅（文件系统 ext4 实现、内存分配器），汇编（启动、上下文切换、trampoline）  
**代码规模**: 约 10,370 行（含头文件和用户态），其中 C 源码约 7,648 行，Rust 源码约 1,200 行（不含自动生成的 bindings）

---

## 2. 构建与测试结果

### 2.1 构建结果

**构建状态**: 成功

构建过程完整执行，所有目标文件均成功编译链接：
- C 代码使用 `riscv64-linux-gnu-gcc` 交叉编译
- Rust 代码使用 `cargo build --target riscv64gc-unknown-none-elf` 编译
- 使用 `bindgen` 自动生成 C-to-Rust FFI 绑定
- 最终生成 `kernel/kernel` 可执行文件（约 3.2 MB）

### 2.2 运行测试结果

**运行状态**: 内核启动失败（panic）

在 QEMU 中运行时的输出：

```
OpenSBI v1.3
Platform Name: riscv-virtio,qemu
Platform HART Count: 3

xv6 kernel is booting
boot hart: 0
_entry: 0x0000000080200000
etext: 0x0000000080253000
.text size: 339968

initcode start: 0x000000008020944e
initcode end: 0x000000008020ac52
initcode size: 6148
ext4 init ok
console ok
rs::panic: panicked at third/ext4_rs/src/ext4_impls/inode.rs:22:21:
attempt to divide by zero
```

**失败原因分析**:

内核在初始化 ext4 文件系统时发生除零错误。根据 `ext4_rs` 源码第 22 行：

```rust
let group = (inode_num - 1) / inodes_per_group;
```

问题在于 `inodes_per_group` 为 0，这通常是因为：
1. 没有提供有效的 ext4 文件系统镜像（`sdcard-load.img` 是空文件）
2. ext4_rs 库在读取超级块时未能正确解析文件系统元数据
3. README 中明确提到："mkfs.ext4默认block size为什么是1k呢"，暗示 ext4_rs 对非 4096 字节块大小的支持存在问题

**README 自述问题**:
- "目前看ffi没问题，ext4基本功能也还算正常，init能跑。但是exec毁了，busybox就起不来。没时间了。"
- "Rust好像挺费栈，4k不够用。"
- "ext4_rs作者到底懂不懂ext4啊"

---

## 3. 子系统详细分析

### 3.1 进程管理子系统

**核心文件**: `kernel/proc.c` (900行), `kernel/swtch.S`, `kernel/sched.h`, `kernel/proc.h`  
**Rust 辅助**: `src/task.rs`  
**完整度**: 85%

#### 3.1.1 进程结构

```c
struct proc {
  struct spinlock lock;
  enum procstate state;        // UNUSED, USED, SLEEPING, RUNNABLE, RUNNING, ZOMBIE
  void *chan;                  // 睡眠通道
  int killed;                  // 是否被杀死
  int xstate;                  // 退出状态
  int tgid;                    // 线程组ID（进程ID）
  int pid;                     // 线程ID
  uint64 set_child_tid;
  uint64 clear_child_tid;
  struct proc *parent;         // 父进程
  uint64 kstack;               // 内核栈虚拟地址
  uint64 sz;                   // 进程内存大小
  pagetable_t pagetable;       // 用户页表
  struct trapframe *trapframe; // 陷阱帧
  struct context context;      // 上下文切换结构
  struct filedesc ofile[NOFILE];  // 打开的文件（NOFILE=128）
  char cwd_path[MAXPATH];      // 当前工作目录路径
  char name[16];               // 进程名
  struct mmap_t mmaptable[NMMAP]; // mmap 映射表（NMMAP=10）
};
```

**关键特性**:
- 最大进程数: 64 (NPROC)
- 最大 CPU 数: 8 (NCPU)
- 每进程内核栈: 4 页 (KSTACKPG=4)
- 支持线程组（tgid/pid 分离）

#### 3.1.2 进程创建与 clone

```c
int clone(int flags, uint64 stackva, uint64 ptidva, uint64 tls, uint64 ctidva)
{
  // 分配进程结构
  if((np = allocproc()) == 0) return -1;
  
  // 复制用户内存
  if(uvmcopy(p->pagetable, np->pagetable, p->sz) < 0) { ... }
  
  // 复制 trapframe
  *(np->trapframe) = *(p->trapframe);
  
  // 设置新栈
  if(stackva) np->trapframe->sp = stackva;
  
  // 子进程返回 0
  np->trapframe->a0 = 0;
  
  // 复制文件描述符
  for(i = 0; i < NOFILE; i++)
    if(p->ofile[i].f) np->ofile[i].f = filedup(p->ofile[i].f);
  
  // 处理 clone flags
  if(flags & CLONE_THREAD) np->tgid = p->tgid;
  if(flags & CLONE_PARENT_SETTID && ptidva) { ... }
  if(flags & CLONE_CHILD_SETTID && ctidva) { ... }
}
```

**支持的 clone flags**:
- `CLONE_THREAD`: 创建线程（共享 tgid）
- `CLONE_PARENT_SETTID`: 在父进程空间设置 tid
- `CLONE_CHILD_SETTID`: 在子进程空间设置 tid
- `CLONE_CHILD_CLEARTID`: 子进程退出时清除 tid

#### 3.1.3 调度器

```c
void scheduler(void)
{
  struct proc *p;
  struct cpu *c = mycpu();
  c->proc = 0;
  for(;;){
    intr_on();
    for(p = proc; p < &proc[NPROC]; p++) {
      acquire(&p->lock);
      if(p->state == RUNNABLE) {
        p->state = RUNNING;
        c->proc = p;
        swtch(&c->context, &p->context);
        c->proc = 0;
      }
      release(&p->lock);
    }
  }
}
```

**调度策略**: 简单的轮转调度（Round-Robin），遍历进程表寻找 RUNNABLE 状态的进程。

#### 3.1.4 Rust 侧进程管理

`src/task.rs` 中定义了 Rust 侧的进程分配接口：

```rust
pub type Task = proc_;

static TASK_POOL: Pool<UnsafeCell<Task>, NPROC_USZ> = Pool::new_uninit();

pub fn allocproc() -> Option<PoolRef<'static, UnsafeCell<Task>, NPROC_USZ>> {
    let pagetable = PageTable::new();
    let trapframe = TrapFrame::new();
    let context = unsafe { zeroed() };
    
    let task = Task {
        lock,
        state: procstate_USED,
        pid: unsafe { allocpid() },
        pagetable: unsafe { transmute(pagetable) },
        trapframe: unsafe { transmute(trapframe) },
        ...
    };
    TASK_POOL.alloc(|| UnsafeCell::new(task))
}
```

**注意**: Rust 侧的 `allocproc` 实现并未被实际使用，C 侧的 `allocproc` 仍是主要实现。

---

### 3.2 内存管理子系统

**核心文件**: `kernel/vm.c` (457行), `kernel/kalloc.c`, `kernel/memlayout.h`  
**Rust 辅助**: `src/mm.rs`, `src/pagetable.rs`, `src/pool.rs`  
**第三方**: `third/buddy_system_allocator`（Rust 侧伙伴系统分配器）  
**完整度**: 90%

#### 3.2.1 物理内存布局

```c
#define MBASE 0x80000000L
#define KERNBASE 0x80200000L
#define PHYSTOP (MBASE + 1024*1024*1024)  // 1GB

#define MEMDISK 0xA0000000L
#define FREEBEGIN 0xB0000000L

#define TRAMPOLINE (MAXVA - PGSIZE)
#define TRAPFRAME (TRAMPOLINE - PGSIZE)
#define MMAPSTOP (TRAPFRAME - PGSIZE)
```

**内存布局**:
- `0x80000000 - 0x80200000`: OpenSBI 固件
- `0x80200000 - etext`: 内核代码段
- `etext - PHYSTOP`: 内核数据段 + 物理页分配区
- `0xA0000000`: 内存磁盘（MEMDISK）
- `0xB0000000`: 空闲内存起始（FREEBEGIN）

#### 3.2.2 物理页分配器

C 侧的 `kalloc.c` 将分配请求转发给 Rust 侧：

```c
void kinit() {
  rs_kalloc_init((void*)FREEBEGIN, (void*)PHYSTOP);
}

void kfree(void *pa) {
  rs_kfree(pa);
}

void *kalloc(void) {
  return rs_kalloc();
}
```

Rust 侧使用伙伴系统分配器：

```rust
#[global_allocator]
static GLOBAL: LockedHeap<64> = LockedHeap::empty();

pub fn do_heap_init(begin: usize, end: usize) {
    unsafe {
        GLOBAL.lock().init(begin, end - begin);
    }
}

pub unsafe fn do_kalloc() -> *mut u8 {
    allocpage() as _
}

pub unsafe fn allocpage() -> *mut [u8; PGSIZE] {
    GLOBAL.alloc(Layout::from_size_align(PGSIZE, PGSIZE).unwrap()) as _
}
```

**特点**:
- 使用 `buddy_system_allocator` crate 的 `LockedHeap<64>`
- 支持 64 个不同大小的块（从 4KB 到更大）
- 同时作为 Rust 的 `#[global_allocator]` 和 C 的物理页分配器

#### 3.2.3 虚拟内存管理

**内核页表**:

```c
pagetable_t kvmmake(void) {
  kpgtbl = (pagetable_t) kalloc();
  memset(kpgtbl, 0, PGSIZE);

  // UART 寄存器
  kvmmap(kpgtbl, UART0, UART0, PGSIZE, PTE_R | PTE_W);

  // VirtIO MMIO
  kvmmap(kpgtbl, VIRTIO0, VIRTIO0, PGSIZE, PTE_R | PTE_W);

  // PLIC
  kvmmap(kpgtbl, PLIC, PLIC, 0x400000, PTE_R | PTE_W);

  // 内核代码段（可执行）
  kvmmap(kpgtbl, KERNBASE, KERNBASE, (uint64)etext-KERNBASE, PTE_R | PTE_X);

  // 内核数据段 + 物理内存
  kvmmap(kpgtbl, (uint64)etext, (uint64)etext, PHYSTOP-(uint64)etext, PTE_R | PTE_W);

  // Trampoline
  kvmmap(kpgtbl, TRAMPOLINE, (uint64)trampoline, PGSIZE, PTE_R | PTE_X);

  // 每进程内核栈
  proc_mapstacks(kpgtbl);
  
  return kpgtbl;
}
```

**用户页表**:

```c
pagetable_t proc_pagetable(struct proc *p) {
  pagetable = uvmcreate();
  
  // 映射 trampoline（无 PTE_U，仅内核可访问）
  mappages(pagetable, TRAMPOLINE, PGSIZE, (uint64)trampoline, PTE_R | PTE_X);
  
  // 映射 trapframe
  mappages(pagetable, TRAPFRAME, PGSIZE, (uint64)(p->trapframe), PTE_R | PTE_W);
  
  return pagetable;
}
```

**页表操作**:

```c
// 三级页表遍历（Sv39）
pte_t *walk(pagetable_t pagetable, uint64 va, int alloc) {
  for(int level = 2; level > 0; level--) {
    pte_t *pte = &pagetable[PX(level, va)];
    if(*pte & PTE_V) {
      pagetable = (pagetable_t)PTE2PA(*pte);
    } else {
      if(!alloc || (pagetable = (pde_t*)kalloc()) == 0) return 0;
      memset(pagetable, 0, PGSIZE);
      *pte = PA2PTE(pagetable) | PTE_V;
    }
  }
  return &pagetable[PX(0, va)];
}
```

#### 3.2.4 mmap/munmap

```c
uint64 mmap(uint64 start, int len, int prot, int flags, int fd, int off) {
  struct proc *p = myproc();
  
  // 查找空闲 mmap 槽位
  for(i = 0; i < NMMAP; i++) {
    if(!p->mmaptable[i].used) {
      p->mmaptable[i].used = 1;
      p->mmaptable[i].ip = f->ip;
      p->mmaptable[i].start = start;
      p->mmaptable[i].len = len;
      p->mmaptable[i].off = off;
      
      // 映射页面
      for(uint64 a = start; a < start + len; a += PGSIZE) {
        mem = kalloc();
        mappages(p->pagetable, a, PGSIZE, (uint64)mem, PTE_R|PTE_U|PTE_W|PTE_X);
      }
      
      return start;
    }
  }
  return -1;
}
```

**限制**:
- 最大 mmap 数量: 10 (NMMAP)
- 不支持 MAP_SHARED 的写回
- 不支持文件映射的按需加载

---

### 3.3 文件系统子系统

**核心文件**: `kernel/fs.c` (513行), `kernel/fs.h`, `kernel/bio.c` (186行), `kernel/log.c`  
**Rust 实现**: `src/fs.rs` (167行)  
**第三方**: `third/ext4_rs`（ext4 文件系统 Rust 实现）  
**完整度**: 70%（基本功能实现，但存在严重 bug）

#### 3.3.1 文件系统架构

```
用户空间
    ↓ 系统调用
sysfile.c (系统调用实现)
    ↓
fs.c (inode 管理、目录操作)
    ↓
bio.c (块缓冲)
    ↓
ext4_rs (Rust ext4 实现)
    ↓
磁盘设备
```

#### 3.3.2 块缓冲层

```c
struct {
  struct spinlock lock;
  struct buf buf[NBUF];  // NBUF = 30
  struct buf head;       // LRU 链表头
} bcache;

struct buf* bread(uint dev, uint blockno) {
  b = bget(dev, blockno);
  if(!b->valid) {
    // 从内存磁盘读取
    memmove(b->data, (void*)(BSIZE*b->blockno+MEMDISK), BSIZE);
    b->valid = 1;
  }
  return b;
}

void bwrite(struct buf *b) {
  // 写入内存磁盘
  memmove((void*)(BSIZE*b->blockno+MEMDISK), b->data, BSIZE);
}
```

**特点**:
- 使用 LRU 策略管理缓冲区
- 当前实现使用内存磁盘（MEMDISK），而非 VirtIO 块设备
- VirtIO 驱动代码存在但被禁用（`virtio_disk_init` 直接 return）

#### 3.3.3 ext4 集成

C 侧接口：

```c
void fsinit(int dev) {
  rs_ext4_init(dev);
}

void ilock(struct inode *ip) {
  acquiresleep(&ip->lock);
  if(ip->valid == 0) {
    int ret = rs_inode_read(ip->rs.inum, &ip->rs);
    ip->valid = 1;
  }
}

int readi(struct inode *ip, int user_dst, uint64 dst, uint off, uint n) {
  return rs_readi(&ip->rs, user_dst, dst, off, n);
}
```

Rust 侧实现：

```rust
static mut EXT4FS: MaybeUninit<Ext4> = MaybeUninit::uninit();

pub fn do_ext4_init(dev: i32) {
    unsafe {
        EXT4FS.write(Ext4::open(Arc::new(Disk(dev))));
    }
    println!("ext4 init ok");
}

pub fn do_inode_read(inum: u32, p: *mut Ext4InodeRef) -> i32 {
    unsafe {
        let fs = EXT4FS.assume_init_ref();
        p.write(fs.get_inode_ref(inum));
    }
    0
}

pub fn do_readi(ip: *const Ext4InodeRef, user_dst: i32, dst: u64, off: u32, n: u32) -> i32 {
    let mut v = vec![0u8; n as _];
    unsafe {
        let fs = EXT4FS.assume_init_ref();
        let len = fs.read_at((*ip).inode_num, off as _, &mut v).unwrap();
        either_copyout(user_dst, dst, v.as_mut_ptr() as _, len as _);
        len as _
    }
}
```

**块设备接口**:

```rust
struct Disk(i32);
impl BlockDevice for Disk {
    fn read_offset(&self, offset: usize) -> Vec<u8> {
        let max = BSIZE as usize - offset % BSIZE as usize;
        let mut v = vec![0u8; max];
        let addr = v.as_mut_ptr() as _;
        let cnt = unsafe { breadoffset(self.0 as _, offset as _, addr, max as _) };
        v.truncate(cnt as _);
        v
    }

    fn write_offset(&self, offset: usize, data: &[u8]) {
        unsafe {
            bwriteoffset(self.0 as _, offset as _, data.as_ptr() as _, data.len() as _);
        }
    }
}
```

#### 3.3.4 inode 结构

```c
struct rs_inode_ref {
  uint32 inum;
  uint16 mode;        // 文件类型和权限
  uint16 uid;
  uint32 size;
  uint32 atime;
  uint32 ctime;
  uint32 mtime;
  uint32 dtime;
  uint16 gid;
  uint16 links_count;
  uint32 blocks;
  uint32 flags;
  uint32 block[15];   // 数据块指针
  // ... ext4 扩展字段
};

struct inode {
  uint dev;
  int ref;
  struct sleeplock lock;
  int valid;
  struct rs_inode_ref rs;
};
```

#### 3.3.5 目录操作

```c
struct inode* namei(char *path) {
  return nameiparent(path, name);
}

struct inode* create(char *path, short type, short major, short minor) {
  ip = nameiparent(path, name);
  ilock(ip);
  
  // 查找是否已存在
  inum = rs_dirlookup(ip->rs.inum, name);
  if(inum != 0) {
    // 已存在，返回现有 inode
    return iget(ip->dev, inum);
  }
  
  // 创建新文件/目录
  inum = rs_create(ip->rs.inum, name, type);
  return iget(ip->dev, inum);
}
```

#### 3.3.6 日志系统

```c
// log.c - 空实现
void initlog(int dev, struct superblock *sb) {}
void begin_op(void) {}
void end_op(void) {}
void log_write(struct buf *b) {}
```

**问题**: 日志系统完全未实现，文件系统操作不具备崩溃恢复能力。

---

### 3.4 系统调用子系统

**核心文件**: `kernel/syscall.c` (118行), `kernel/syscall.h`, `kernel/sysproc.c` (318行), `kernel/sysfile.c` (681行)  
**完整度**: 75%（声明了大量系统调用，但许多未实现）

#### 3.4.1 系统调用表

系统调用采用 Linux RISC-V 兼容编号方案，通过 sed 脚本自动生成：

```c
// gen_syscall_table.sed 生成
static uint64 (*syscalls[])() = {
[SYS_getcwd] sys_getcwd,
[SYS_dup] sys_dup,
[SYS_dup3] sys_dup3,
[SYS_fcntl] sys_fcntl,
[SYS_openat] sys_openat,
[SYS_close] sys_close,
[SYS_read] sys_read,
[SYS_write] sys_write,
[SYS_exit] sys_exit,
[SYS_clone] sys_clone,
[SYS_execve] sys_execve,
[SYS_mmap] sys_mmap,
[SYS_munmap] sys_munmap,
// ... 更多系统调用
};
```

#### 3.4.2 已实现的系统调用

**进程管理**:
- `sys_exit`, `sys_exit_group`: 进程退出
- `sys_clone`, `sys_fork`: 进程/线程创建
- `sys_wait4`, `sys_wait`: 等待子进程
- `sys_getpid`, `sys_gettid`, `sys_getppid`: 获取进程 ID
- `sys_kill`: 发送信号（简单实现）
- `sys_sched_yield`: 让出 CPU

**内存管理**:
- `sys_brk`, `sys_sbrk`: 调整堆大小
- `sys_mmap`, `sys_munmap`: 内存映射

**文件系统**:
- `sys_openat`, `sys_open`: 打开文件
- `sys_close`: 关闭文件
- `sys_read`, `sys_write`, `sys_writev`: 读写文件
- `sys_lseek`: 文件定位
- `sys_fstat`, `sys_fstatat`: 获取文件状态
- `sys_mkdir`, `sys_mkdirat`: 创建目录
- `sys_unlinkat`, `sys_unlink`: 删除文件
- `sys_getcwd`, `sys_chdir`: 工作目录操作
- `sys_getdents64`: 读取目录项
- `sys_dup`, `sys_dup3`: 复制文件描述符
- `sys_pipe2`: 创建管道
- `sys_fcntl`: 文件控制

**时间**:
- `sys_gettimeofday`: 获取时间
- `sys_clock_gettime`: 获取时钟
- `sys_nanosleep`: 纳秒级睡眠
- `sys_times`: 获取进程时间

**其他**:
- `sys_uname`: 获取系统信息
- `sys_set_tid_address`: 设置线程 ID 地址

#### 3.4.3 系统调用分发

```c
void syscall(void) {
  int num;
  struct proc *p = myproc();

  num = p->trapframe->a7;
  
  if(num > 0 && num < NELEM(syscalls) && syscalls[num]) {
    p->trapframe->a0 = syscalls[num](
      p->trapframe->a0,
      p->trapframe->a1,
      p->trapframe->a2,
      p->trapframe->a3,
      p->trapframe->a4,
      p->trapframe->a5
    );
  } else {
    printf("%d %s: unknown syscall %d\n", p->pid, p->name, num);
    p->trapframe->a0 = -ENOSYS;
  }
}
```

#### 3.4.4 未实现/存根系统调用

许多系统调用在 `syscall.h` 中声明但未实现，返回 `-ENOSYS`：
- 信号相关: `sys_rt_sigaction`, `sys_rt_sigprocmask`, `sys_rt_sigreturn`
- IPC: `sys_msgget`, `sys_semget`, `sys_shmget`
- 网络: `sys_socket`, `sys_bind`, `sys_connect`
- 其他: `sys_ioctl`, `sys_mount`, `sys_umount2`

---

### 3.5 陷阱/中断处理子系统

**核心文件**: `kernel/trap.c` (222行), `kernel/trampoline.S` (151行), `kernel/kernelvec.S`  
**完整度**: 90%

#### 3.5.1 用户态陷阱处理

```c
void usertrap(void) {
  // 检查是否来自用户态
  if((r_sstatus() & SSTATUS_SPP) != 0)
    panic("usertrap: not from user mode");

  // 设置内核陷阱向量
  w_stvec((uint64)kernelvec);

  struct proc *p = myproc();
  p->trapframe->epc = r_sepc();
  
  if(r_scause() == 8) {
    // 系统调用
    if(killed(p)) exit(-1);
    p->trapframe->epc += 4;  // 跳过 ecall 指令
    intr_on();
    syscall();
  } else if((which_dev = devintr()) != 0) {
    // 设备中断
  } else {
    // 未知异常
    printf("usertrap(): unexpected scause %p pid = %d\n", r_scause(), p->pid);
    setkilled(p);
  }

  if(killed(p)) exit(-1);
  
  // 时钟中断时让出 CPU
  if(which_dev == 2) yield();

  usertrapret();
}
```

#### 3.5.2 Trampoline 代码

```asm
uservec:    
    # 保存 a0 到 sscratch
    csrw sscratch, a0
    
    # 加载 TRAPFRAME 地址
    li a0, TRAPFRAME
    
    # 保存所有用户寄存器到 TRAPFRAME
    sd ra, 40(a0)
    sd sp, 48(a0)
    # ... 保存所有寄存器
    
    # 恢复 a0
    csrr t0, sscratch
    sd t0, 112(a0)
    
    # 设置内核栈指针
    ld sp, 8(a0)
    
    # 设置 hartid
    ld tp, 32(a0)
    
    # 加载 usertrap 地址
    ld t0, 16(a0)
    
    # 切换到内核页表
    ld t1, 0(a0)
    sfence.vma zero, zero
    csrw satp, t1
    sfence.vma zero, zero
    
    # 跳转到 usertrap
    jr t0
```

#### 3.5.3 内核态陷阱处理

```c
void kerneltrap() {
  uint64 sepc = r_sepc();
  uint64 sstatus = r_sstatus();
  uint64 scause = r_scause();
  
  if((sstatus & SSTATUS_SPP) == 0)
    panic("kerneltrap: not from supervisor mode");
  if(intr_get() != 0)
    panic("kerneltrap: interrupts enabled");

  if((which_dev = devintr()) == 0) {
    printf("scause %p\n", scause);
    panic("kerneltrap");
  }

  // 时钟中断时让出 CPU
  if(which_dev == 2 && myproc() != 0 && myproc()->state == RUNNING)
    yield();

  // 恢复寄存器
  w_sepc(sepc);
  w_sstatus(sstatus);
}
```

#### 3.5.4 设备中断处理

```c
int devintr() {
  uint64 scause = r_scause();

  if((scause & 0x8000000000000000L) && (scause & 0xff) == 9) {
    // 外部中断（PLIC）
    int irq = plic_claim();
    
    if(irq == UART0_IRQ) {
      uartintr();
    } else if(irq == VIRTIO0_IRQ) {
      virtio_disk_intr();
    }
    
    if(irq) plic_complete(irq);
    return 1;
  } else if(scause == 0x8000000000000005L) {
    // 时钟中断
    if(cpuid() == 0) clockintr();
    
    // 清除 STIP 位
    w_sip(r_sip() & ~(1<<5));
    set_next_trigger();
    return 2;
  }
  return 0;
}
```

---

### 3.6 设备驱动子系统

**完整度**: 60%

#### 3.6.1 UART 驱动

```c
void uartputc(int c) {
  sbi_console_putchar(c);  // 使用 SBI 调用
  return;
  // 以下代码被禁用
  acquire(&uart_tx_lock);
  // ... 缓冲区操作
}

void uartputc_sync(int c) {
  sbi_console_putchar(c);  // 使用 SBI 调用
  return;
  // 以下代码被禁用
  push_off();
  while((ReadReg(LSR) & LSR_TX_IDLE) == 0);
  WriteReg(THR, c);
  pop_off();
}
```

**特点**: UART 输出完全依赖 SBI 调用，未使用硬件 UART 寄存器。

#### 3.6.2 VirtIO 块设备驱动

```c
void virtio_disk_init(void) {
  // TODO: sdcard
  return;  // 直接返回，未初始化
  // 以下代码未执行
  initlock(&disk.vdisk_lock, "virtio_disk");
  // ... VirtIO 初始化
}
```

**问题**: VirtIO 驱动代码存在但被禁用，当前使用内存磁盘。

#### 3.6.3 内存磁盘

```c
// bio.c 中的实现
struct buf* bread(uint dev, uint blockno) {
  b = bget(dev, blockno);
  if(!b->valid) {
    // 从 MEMDISK (0xA0000000) 读取
    memmove(b->data, (void*)(BSIZE*b->blockno+MEMDISK), BSIZE);
    b->valid = 1;
  }
  return b;
}
```

**特点**: 使用 QEMU 的 `-device loader` 将文件系统镜像加载到 `0xA0000000`。

#### 3.6.4 PLIC 驱动

```c
void plicinit(void) {
  // 设置 UART 和 VirtIO 中断优先级
  *(uint32*)(PLIC + UART0_IRQ*4) = 1;
  *(uint32*)(PLIC + VIRTIO0_IRQ*4) = 1;
}

void plicinithart(void) {
  int hart = cpuid();
  // 启用 S-mode 中断
  *(uint32*)PLIC_SENABLE(hart) = (1 << UART0_IRQ) | (1 << VIRTIO0_IRQ);
  // 设置优先级阈值为 0
  *(uint32*)PLIC_SPRIORITY(hart) = 0;
}
```

---

### 3.7 文件/管道子系统

**核心文件**: `kernel/file.c` (190行), `kernel/pipe.c` (130行), `kernel/exec.c` (281行)  
**完整度**: 85%

#### 3.7.1 文件结构

```c
struct file {
  enum { FD_NONE, FD_PIPE, FD_INODE, FD_DEVICE } type;
  int ref;
  int statusflags;
  char readable;
  char writable;
  struct pipe *pipe;
  struct inode *ip;
  uint off;
  short major;
  char path[MAXPATH];
};
```

#### 3.7.2 管道实现

```c
struct pipe {
  struct spinlock lock;
  char data[PIPESIZE];  // PIPESIZE = 512
  uint nread;
  uint nwrite;
  int readopen;
  int writeopen;
};

int pipewrite(struct pipe *pi, uint64 addr, int n) {
  acquire(&pi->lock);
  while(i < n) {
    if(pi->readopen == 0 || killed(pr)) {
      release(&pi->lock);
      return -1;
    }
    if(pi->nwrite == pi->nread + PIPESIZE) {
      wakeup(&pi->nread);
      sleep(&pi->nwrite, &pi->lock);
    } else {
      char ch;
      if(copyin(pr->pagetable, &ch, addr + i, 1) == -1) break;
      pi->data[pi->nwrite++ % PIPESIZE] = ch;
      i++;
    }
  }
  wakeup(&pi->nread);
  release(&pi->lock);
  return i;
}
```

#### 3.7.3 ELF 加载执行

```c
int execve(char *path, char **argv, char **envp) {
  // 打开文件
  if((ip = namei(path)) == 0) {
    end_op();
    return -1;
  }
  ilock(ip);
  
  // 检查 ELF 魔数
  if(readi(ip, 0, (uint64)&elf.magic, 0, 4) != 4 || elf.magic != ELF_MAGIC) {
    iunlockput(ip);
    end_op();
    return shebang_delegate(path, argv, envp);  // 尝试 shebang
  }
  
  // 读取 ELF 头
  if(readi(ip, 0, (uint64)&elf, 0, sizeof(elf)) != sizeof(elf)) goto bad;
  
  // 创建新页表
  if((pagetable = proc_pagetable(p)) == 0) goto bad;
  
  // 加载程序段
  for(i=0, off=elf.phoff; i<elf.phnum; i++, off+=sizeof(ph)) {
    if(readi(ip, 0, (uint64)&ph, off, sizeof(ph)) != sizeof(ph)) goto bad;
    if(ph.type != ELF_PROG_LOAD) continue;
    
    sz1 = uvmalloc(pagetable, sz, ph.vaddr + ph.memsz, flags2perm(ph.flags));
    if(loadseg(pagetable, ph.vaddr, ip, ph.off, ph.filesz) < 0) goto bad;
  }
  
  // 分配用户栈
  sz = PGROUNDUP(sz);
  sz1 = uvmalloc(pagetable, sz, sz + (USTACKPG+1)*PGSIZE, PTE_W);
  uvmclear(pagetable, sz-(USTACKPG+1)*PGSIZE);  // 栈保护页
  
  // 准备参数和环境变量
  // ...
  
  // 设置辅助向量（auxiliary vector）
  alloc_aux(AT_HWCAP, 0);
  alloc_aux(AT_PAGESZ, PGSIZE);
  alloc_aux(AT_PHDR, ph.vaddr);
  alloc_aux(AT_PHENT, elf.phentsize);
  alloc_aux(AT_PHNUM, elf.phnum);
  alloc_aux(AT_BASE, interp_start_addr);
  alloc_aux(AT_ENTRY, elf.entry);
  alloc_aux(AT_UID, 0);
  alloc_aux(AT_EUID, 0);
  alloc_aux(AT_GID, 0);
  alloc_aux(AT_EGID, 0);
  alloc_aux(AT_SECURE, 0);
  alloc_aux(AT_RANDOM, sp);
  alloc_aux(AT_NULL, 0);
  
  // 提交新映像
  oldpagetable = p->pagetable;
  p->pagetable = pagetable;
  p->sz = sz;
  p->trapframe->epc = elf.entry;
  p->trapframe->sp = sp;
  proc_freepagetable(oldpagetable, oldsz);
  
  return 0;
}
```

**Shebang 支持**:

```c
int shebang_delegate(char *path, char **argv, char **envp) {
  char *b_argv[MAXARG + 3] = {"/busybox", "sh", path, 0};
  for(int i = 0; i < MAXARG && argv[i]; ++i)
    b_argv[i+3] = argv[i];
  return execve(b_argv[0], b_argv, envp);
}
```

---

### 3.8 同步子系统

**核心文件**: `kernel/spinlock.c`, `kernel/sleeplock.c`  
**完整度**: 95%

#### 3.8.1 自旋锁

```c
void acquire(struct spinlock *lk) {
  push_off();  // 禁用中断
  if(holding(lk)) panic("acquire");

  // 原子交换
  while(__sync_lock_test_and_set(&lk->locked, 1) != 0)
    ;

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

#### 3.8.2 睡眠锁

```c
void acquiresleep(struct sleeplock *lk) {
  acquire(&lk->lk);
  while (lk->locked) {
    sleep(lk, &lk->lk);  // 等待锁释放
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

---

### 3.9 用户态

**文件**: `user/` 目录下少量文件  
**完整度**: 70%

#### 3.9.1 init 进程

```c
// user/init.c
int main(void) {
  // 打开控制台
  if(open("/console", O_RDWR) < 0) {
    // 如果失败，使用 fd 0, 1, 2
  }
  
  // 执行 shell
  char *argv[] = { "sh", 0 };
  exec("sh", argv);
  
  // 如果 exec 失败，退出
  exit(0);
}
```

#### 3.9.2 用户态库

```c
// user/ulib.c
int strlen(const char *p) {
  int n;
  for(n = 0; p[n]; p++) n++;
  return n;
}

void* memset(void *dst, int c, uint n) {
  char *cdst = (char *) dst;
  int i;
  for(i = 0; i < n; i++) cdst[i] = c;
  return dst;
}
```

#### 3.9.3 系统调用桩

```asm
# user/usys.S (自动生成)
.globl fork
fork:
    li a7, 502
    ecall
    ret

.globl exit
exit:
    li a7, 93
    ecall
    ret

.globl wait
wait:
    li a7, 503
    ecall
    ret
```

---

## 4. 子系统交互分析

### 4.1 C-Rust FFI 交互

**C 调用 Rust**:

```c
// kalloc.c
void rs_kalloc_init(void *begin, void *end);
void *rs_kalloc(void);
void rs_kfree(void *pa);

// fs.c
void rs_ext4_init(int dev);
int rs_inode_read(uint inum, struct rs_inode_ref *p);
void rs_inode_writeback(struct rs_inode_ref *ip);
int rs_readi(const struct rs_inode_ref *ip, int user_dst, uint64 dst, uint off, uint n);
int rs_writei(uint ino, int user_src, uint64 src, uint off, uint n);
uint rs_dirlookup(uint idir, const char *name);
int rs_unlink(const char *path);
uint rs_create(uint idir, const char *name, short typ);
int rs_getdents(uint inum, uint64 bufva, int len);
```

**Rust 调用 C**:

```rust
// ffi_import.rs
pub use crate::bindings::{
    acquire, breadoffset, bwriteoffset, consputc, 
    either_copyin, either_copyout, release, 
    BSIZE, PGSIZE, T_DEVICE, T_DIR, T_FILE,
};
```

### 4.2 系统调用流程

```
用户程序
    ↓ ecall
trampoline.S (uservec)
    ↓ 保存寄存器，切换页表
trap.c (usertrap)
    ↓ 识别系统调用
syscall.c (syscall)
    ↓ 查表分发
sysproc.c / sysfile.c (sys_xxx)
    ↓ 参数解析，调用内核函数
proc.c / fs.c / vm.c (内核函数)
    ↓ 可能调用 Rust 函数
fs.rs / mm.rs (Rust 实现)
    ↓ 返回结果
trap.c (usertrapret)
    ↓ 恢复寄存器，切换页表
trampoline.S (userret)
    ↓ sret
用户程序
```

### 4.3 中断处理流程

```
硬件中断
    ↓
kernelvec.S (kernelvec)
    ↓ 保存寄存器
trap.c (kerneltrap)
    ↓ 识别中断类型
trap.c (devintr)
    ↓
    ├─ UART 中断 → uartintr → consoleintr
    ├─ VirtIO 中断 → virtio_disk_intr
    └─ 时钟中断 → clockintr → wakeup
    ↓
kernelvec.S (恢复寄存器)
    ↓ sret
继续执行
```

---

## 5. 项目完整度评估

### 5.1 各子系统完整度

| 子系统 | 完整度 | 说明 |
|--------|--------|------|
| 进程管理 | 85% | 基本功能完整，线程支持有限 |
| 内存管理 | 90% | 物理/虚拟内存管理完整，mmap 基础实现 |
| 文件系统 | 70% | ext4 集成存在问题，日志未实现 |
| 系统调用 | 75% | 声明多但实现不完整，许多返回 ENOSYS |
| 陷阱处理 | 90% | 用户/内核陷阱处理完整 |
| 设备驱动 | 60% | UART 依赖 SBI，VirtIO 未启用 |
| 文件/管道 | 85% | 基本功能完整，exec 支持 shebang |
| 同步机制 | 95% | 自旋锁和睡眠锁完整 |
| 用户态 | 70% | 最小化实现，依赖外部测试套件 |

### 5.2 整体完整度

**整体完整度**: 约 75%

**主要问题**:
1. **文件系统崩溃**: ext4 初始化时除零错误，无法正常运行
2. **exec 失败**: README 明确提到 "exec毁了，busybox就起不来"
3. **日志未实现**: 文件系统无崩溃恢复能力
4. **VirtIO 未启用**: 使用内存磁盘而非真正的块设备
5. **信号未实现**: 信号相关系统调用为存根

---

## 6. 设计创新性分析

### 6.1 C + Rust 混合架构

**创新点**: 将 Rust 引入传统 xv6 内核，用于文件系统和内存分配器实现。

**优点**:
- 利用 Rust 的内存安全特性减少内存错误
- 复用现有的 Rust 生态库（ext4_rs, buddy_system_allocator）
- 通过 FFI 实现 C-Rust 双向调用

**缺点**:
- 增加了构建复杂度（需要 bindgen、cargo）
- FFI 边界容易出错（类型不匹配、生命周期问题）
- Rust 的栈使用较大，4KB 内核栈可能不够

### 6.2 对象池设计

`src/pool.rs` 实现了一个通用的对象池：

```rust
pub struct Pool<T, const N: usize> {
    internal: UnsafeCell<MaybeUninit<PoolInternal<T, N>>>,
}

impl<T, const N: usize> Pool<T, N> {
    pub fn alloc(&self, f: impl FnOnce() -> T) -> Option<PoolRef<T, N>> {
        let internal = self.internal_lock();
        for j in &mut internal.data {
            let i = unsafe { j.get().as_mut().unwrap_unchecked() };
            if i.1.is_none() {
                i.1.replace(f());
                i.0 += 1;
                ret = Some(PoolRef { pool: self, target: j });
                break;
            }
        }
        self.internal_unlock();
        ret
    }
}
```

**特点**:
- 支持引用计数（`PoolRef` 的 `dup` 和 `Drop`）
- 使用自旋锁保护
- 泛型设计，可复用

**问题**: 当前未被实际使用，C 侧仍使用原有的进程分配机制。

### 6.3 Linux 兼容系统调用

**创新点**: 采用 Linux RISC-V 系统调用编号，提高兼容性。

**优点**:
- 可直接运行 Linux RISC-V 用户程序
- 支持 busybox 等工具

**缺点**:
- 许多系统调用未实现，返回 ENOSYS
- 信号机制未实现，影响许多程序运行

---

## 7. 其他信息

### 7.1 构建系统

**Makefile 特点**:
- 自动生成系统调用表（`gen_syscall_table.sed`, `gen_syscall_functions.sed`）
- 自动生成用户态系统调用桩（`gen_usys.sed`）
- 使用 bindgen 生成 Rust FFI 绑定
- 支持增量编译（`.d` 依赖文件）

### 7.2 第三方依赖

| 依赖 | 用途 | 版本 |
|------|------|------|
| ext4_rs | ext4 文件系统实现 | 本地修改版 |
| buddy_system_allocator | 伙伴系统内存分配器 | 0.9.0 |
| log | Rust 日志框架 | 0.4 |

### 7.3 已知问题（来自 README）

1. "完全没时间，队友比我更忙，所以摆了。"
2. "初赛使用的FAT32是对照spec手搓的。很粗糙，但能用。"
3. "复赛使用的EXT4，看了一眼lwext4，实在不想折腾CMake和整理一堆include，所以用了ext4_rs。"
4. "ext4_rs的接口也是一言难尽。"
5. "目前看ffi没问题，ext4基本功能也还算正常，init能跑。但是exec毁了，busybox就起不来。没时间了。"
6. "Rust好像挺费栈，4k不够用。"
7. "ext4_rs作者到底懂不懂ext4啊，仿佛根本没理解extent tree"
8. "mkfs.ext4默认block size为什么是1k呢。"

---

## 8. 总结

### 8.1 项目优点

1. **架构设计合理**: 基于 xv6 的清晰架构，模块化设计良好
2. **C-Rust 混合**: 尝试将 Rust 引入内核开发，具有前瞻性
3. **Linux 兼容**: 系统调用编号兼容 Linux，提高可用性
4. **代码质量**: C 代码风格统一，注释清晰
5. **构建系统**: Makefile 设计完善，支持自动生成

### 8.2 项目缺点

1. **核心功能不可用**: 文件系统初始化失败，exec 无法工作
2. **开发时间不足**: README 明确表示时间不够，许多功能未完成
3. **ext4_rs 问题**: 第三方库存在 bug，影响文件系统功能
4. **测试不足**: 无法运行完整的用户程序进行测试
5. **文档缺失**: 除 README 外缺乏技术文档

### 8.3 改进建议

1. **修复 ext4 初始化**: 检查超级块解析逻辑，确保 `inodes_per_group` 正确
2. **启用 VirtIO**: 使用真正的块设备而非内存磁盘
3. **实现日志系统**: 提高文件系统可靠性
4. **完善信号机制**: 实现基本的信号处理
5. **增加内核栈大小**: 解决 Rust 栈溢出问题
6. **补充测试**: 添加单元测试和集成测试

### 8.4 总体评价

SystemNQB 是一个具有创新性的 OS 内核项目，尝试将 Rust 引入传统 xv6 内核。项目架构设计合理，代码质量较高，但由于开发时间不足和第三方库问题，核心功能（文件系统、exec）无法正常工作。作为 OS 内核比赛的参赛作品，展示了团队的技术能力和创新意识，但在完整性和可用性方面仍有较大提升空间。

**评分**: 65/100
- 架构设计: 80/100
- 代码质量: 75/100
- 功能完整度: 50/100
- 创新性: 70/100
- 可用性: 40/100