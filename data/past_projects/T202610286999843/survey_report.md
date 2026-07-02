# OS 内核项目初步调查报告

## 1. 项目概述

该项目基于 **xv6-riscv**（MIT 的教学操作系统），并进行了大幅扩展，支持双架构（RISC-V 和 LoongArch）、EXT4 文件系统、以及丰富的 Linux 兼容系统调用。项目面向 OS 内核比赛场景，包含完整的用户态测试程序和 BusyBox 集成。

---

## 2. 顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `kernel/` | 内核源代码（所有内核子系统） |
| `user/` | 用户态程序源代码 |
| `mkfs/` | 文件系统镜像制作工具 (`mkfs.c`) |
| `docs/` | 大量开发文档（EXT4、LoongArch 移植、双架构统一等） |
| `codex-basic-syscall-bundle/` | 基础系统调用测试集参考实现 |
| `codex_busy_box/` | BusyBox 集成与验收脚本 |
| `Makefile` | GNU Make 构建系统（顶层） |
| `test-xv6.py` | QEMU 自动化测试脚本 |
| `.trae/specs/` | 集成规格说明（如 xv6-OpenSBI 集成） |

---

## 3. 内核子系统划分

### 3.1 架构相关层（Architecture Layer）

该项目同时支持两种 CPU 架构，采用文件命名后缀区分：RISC-V 文件使用原名，LoongArch 文件使用 `-la` 后缀。

**RISC-V 架构文件：**

| 文件 | 功能 |
|---|---|
| `kernel/entry.S` | 内核入口汇编 |
| `kernel/start.c` | 早期启动（机器模式到监管模式切换） |
| `kernel/kernelvec.S` | 内核态中断向量 |
| `kernel/swtch.S` | 上下文切换汇编 |
| `kernel/trampoline.S` | 用户态/内核态切换跳板 |
| `kernel/trap.c` | 陷阱/中断处理 |
| `kernel/vm.c` | 虚拟内存管理（页表操作） |
| `kernel/uart.c` | NS16550 UART 驱动 |
| `kernel/plic.c` | RISC-V PLIC 中断控制器 |
| `kernel/virtio_disk.c` | VirtIO 块设备驱动 |
| `kernel/riscv.h` | RISC-V 特定寄存器/指令定义 |

**LoongArch 架构文件：**

| 文件 | 功能 |
|---|---|
| `kernel/entry-la.S` | LoongArch 内核入口 |
| `kernel/start-la.c` | LoongArch 早期启动 |
| `kernel/kernelvec-la.S` | LoongArch 内核中断向量 |
| `kernel/swtch-la.S` | LoongArch 上下文切换 |
| `kernel/uservec-la.S` | LoongArch 用户态中断入口 |
| `kernel/trap-la.c` | LoongArch 陷阱处理 |
| `kernel/vm-la.c` | LoongArch 虚拟内存管理 |
| `kernel/uart-la.c` | LoongArch UART 驱动 |
| `kernel/apic-la.c` | LS7A PCH-PIC (APIC) 初始化与控制 |
| `kernel/extioi-la.c` | 扩展 IO 中断控制器 |
| `kernel/tlbrefill-la.S` | TLB 重填异常处理 |
| `kernel/merror-la.S` | 机器错误异常处理 |
| `kernel/virtio_disk-la.c` | LoongArch VirtIO 块设备驱动 |
| `kernel/loongarch.h` | LoongArch 特定寄存器/指令定义 |

**架构无关头文件：** `kernel/arch.h`, `kernel/memlayout.h`, `kernel/asm.h`

### 3.2 进程管理子系统

| 文件 | 功能 |
|---|---|
| `kernel/proc.c` | 进程创建 (`fork`/`userinit`)、调度 (`scheduler`)、睡眠/唤醒、`exit`/`wait`、`mmap` 区域管理 |
| `kernel/proc.h` | 进程控制块 (`struct proc`)、CPU 状态 (`struct cpu`)、上下文 (`struct context`)、陷阱帧 (`struct trapframe`) |
| `kernel/param.h` | 系统参数常量（最大进程数 64、文件数、inode 数等） |

### 3.3 虚拟内存子系统

| 文件 | 功能 |
|---|---|
| `kernel/vm.c` (RISC-V) / `kernel/vm-la.c` (LoongArch) | 内核页表创建 (`kvminit`)、用户地址空间管理 (`uvmcreate`/`uvmalloc`/`uvmfree`/`uvmcopy`)、页表遍历 (`walk`)、`copyin`/`copyout`、按需调页 (`vmfault`) |
| `kernel/vm.h` | 页表类型别名 |
| `kernel/kalloc.c` | 物理页分配器 (`kalloc`/`kfree`/`kinit`) |

### 3.4 系统调用子系统

| 文件 | 功能 |
|---|---|
| `kernel/syscall.c` | 系统调用分发 (`syscall()`)，约 80+ 个系统调用注册 |
| `kernel/syscall.h` | 系统调用号定义（xv6 原生 + Linux RISC-V 兼容） |
| `kernel/sysproc.c` | 进程相关系统调用实现（`fork`、`exit`、`wait`、`kill`、`sbrk`、`mmap`、`clone` 等） |
| `kernel/sysfile.c` | 文件相关系统调用实现（`open`、`read`、`write`、`mkdir`、`mount`、`getdents64`、`statfs` 等，约 2000 行） |

### 3.5 文件系统子系统

| 文件 | 功能 |
|---|---|
| `kernel/bio.c` | 块缓冲区缓存（`bread`/`bwrite`/`brelse`） |
| `kernel/buf.h` | 缓冲区结构体 (`struct buf`) |
| `kernel/fs.c` | 原始 xv6 文件系统（inode 管理、目录操作、路径解析） |
| `kernel/fs.h` | 文件系统数据结构（超级块、dinode、目录项） |
| `kernel/ext4.c` | **EXT4 文件系统实现**（约 1400 行）：超级块读取、挂载、inode 读写、extent 树遍历、目录操作、块分配/释放 |
| `kernel/ext4.h` | EXT4 数据结构定义（超级块、组描述符、inode、extent 节点） |
| `kernel/log.c` | 文件系统日志（崩溃一致性） |
| `kernel/mkfs/mkfs.c` | 构建主机上的文件系统镜像制作工具 |

### 3.6 文件管理子系统

| 文件 | 功能 |
|---|---|
| `kernel/file.c` | 文件描述符表管理（`filealloc`/`fileclose`/`fileread`/`filewrite`） |
| `kernel/file.h` | 文件结构体 (`struct file`) |
| `kernel/pipe.c` | 管道实现 (`pipealloc`/`pipeclose`/`piperead`/`pipewrite`) |
| `kernel/fcntl.h` | 文件控制常量 |

### 3.7 程序执行子系统

| 文件 | 功能 |
|---|---|
| `kernel/exec.c` | ELF 可执行文件加载 (`kexec`)，支持 shebang 脚本执行 |
| `kernel/elf.h` | ELF 格式定义 |

### 3.8 同步原语

| 文件 | 功能 |
|---|---|
| `kernel/spinlock.c` | 自旋锁（含 `push_off`/`pop_off` 中断禁用嵌套） |
| `kernel/spinlock.h` | 自旋锁结构体 |
| `kernel/sleeplock.c` | 睡眠锁（基于自旋锁的长期锁定） |
| `kernel/sleeplock.h` | 睡眠锁结构体 |

### 3.9 控制台与输出

| 文件 | 功能 |
|---|---|
| `kernel/console.c` | 控制台输入/输出抽象层 |
| `kernel/printf.c` | 内核格式化打印 (`printf`) |
| `kernel/string.c` | 字符串/内存操作函数 |

### 3.10 设备驱动

| 文件 | 功能 |
|---|---|
| `kernel/virtio_disk.c` / `kernel/virtio_disk-la.c` | VirtIO 块设备驱动（支持大块读写 `virtio_disk_rw_large`） |
| `kernel/virtio.h` | VirtIO 寄存器/描述符定义 |
| `kernel/uart.c` / `kernel/uart-la.c` | UART 串口驱动 |
| `kernel/plic.c` | RISC-V PLIC 中断控制器 |
| `kernel/apic-la.c` / `kernel/extioi-la.c` | LoongArch 中断控制器 |

---

## 4. 用户态程序

`user/` 目录包含标准 xv6 用户程序及比赛测试程序：

| 类别 | 程序 |
|---|---|
| 标准工具 | `cat`, `echo`, `grep`, `ls`, `mkdir`, `rm`, `wc`, `ln`, `sh` (shell) |
| 进程测试 | `forktest`, `forphan`, `dorphan`, `zombie`, `kill` |
| 压力测试 | `usertests`, `grind`, `stressfs`, `logstress`, `testsh` |
| 比赛集成 | `basic_runner`, `busybox_runner` |
| 用户库 | `ulib.c`, `umalloc.c`, `printf.c`, `usys.pl`/`usys-la.pl` (系统调用桩生成) |

---

## 5. 构建系统分析

### 5.1 构建工具需求

| 工具 | 用途 |
|---|---|
| **RISC-V 交叉编译工具链** (`riscv64-*-elf-` 或 `riscv64-linux-gnu-`) | 编译 RISC-V 内核与用户程序 |
| **LoongArch 交叉编译工具链** (`loongarch64-linux-gnu-`) | 编译 LoongArch 内核与用户程序 |
| **GNU Make** | 构建自动化 |
| **Perl** | 生成系统调用桩 (`usys.pl`/`usys-la.pl`) |
| **mkfs.ext4** | 创建 EXT4 磁盘镜像 |
| **QEMU** (riscv64 或 loongarch64) | 模拟运行 |
| **GCC (主机原生)** | 编译 `mkfs/mkfs` 文件系统制作工具 |
| **mount/umount, dd, mknod, cp** | 磁盘镜像内容组装（Makefile 中直接使用） |

### 5.2 构建流程

1. `make` 默认同时构建 RISC-V 和 LoongArch 两个架构
2. 通过 `ARCH=riscv` 或 `ARCH=loongarch` 选择架构
3. 内核镜像 (`kernel-rv`/`kernel-la`) + EXT4 磁盘镜像 (`disk-rv.img`/`disk-la.img`)
4. `qemu` 目标启动 RISC-V 版本（使用 OpenSBI 默认固件）
5. QEMU 配置：`-machine virt`，128MB RAM，最多 8 核 SMP，两个 virtio-blk 设备（SD 卡 + EXT4 盘），virtio-net 网络设备

---

## 6. 关键特性总结

1. **双架构支持**：RISC-V 64 (rv64g) 和 LoongArch 64，通过条件编译和架构特定文件实现
2. **EXT4 文件系统**：完整的 EXT4 只读/读写支持，含 extent 树、inode 管理、目录操作
3. **Linux 兼容系统调用**：约 70+ 个 Linux RISC-V 系统调用号，覆盖进程、文件、内存、时间、信号等
4. **mmap/munmap/mprotect**：支持匿名内存映射
5. **双磁盘挂载**：支持 rootfs 和 sdcard 两个 EXT4 分区
6. **/proc 伪文件系统**：基本的进程信息、内存信息、挂载信息
7. **BusyBox 集成**：通过 `busybox_runner` 支持运行 BusyBox
8. **基本系统调用测试集**：`codex-basic-syscall-bundle/` 提供标准测试用例