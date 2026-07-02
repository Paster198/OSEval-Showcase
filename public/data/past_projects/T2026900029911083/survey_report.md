# OSuperBeauty OS 内核项目 — 初步调查报告

## 1. 项目概述

该项目名为 **OSuperBeauty**，是一个基于 **xv6 (RISC-V)** 教学操作系统深度扩展的内核项目，同时新增了 **LoongArch** 架构支持。项目为参加 OS 内核竞赛而开发，名称为 "OSuperBeauty"（在启动时会打印 ASCII 艺术字横幅）。

项目源码总规模约 **59,800 行**（含 `.c`、`.h`、`.S` 文件），其中内核部分约 37,000 行 C 代码、22,000 行头文件（含 ext4 库）、726 行汇编。

---

## 2. 仓库顶层文件组织结构

```
repo/
├── boot/                  # 启动代码 (架构相关入口、初始化)
│   ├── main.c             # 内核主入口 main()
│   ├── rv/                # RISC-V 启动汇编 (entry.S, start.c, initcode)
│   └── la/                # LoongArch 启动汇编 (entry.S, initcode)
├── kernel/                # 内核核心子系统
│   ├── proc/              # 进程管理
│   ├── mm/                # 内存管理
│   ├── fs/                # 文件系统 (VFS, ext4, pipe, console, bio)
│   ├── syscall/           # 系统调用
│   ├── trap/              # 陷阱/中断 (架构相关)
│   ├── drive/             # 设备驱动
│   ├── lock/              # 锁与同步
│   └── util/              # 工具函数
├── include/               # 内核头文件 (与 kernel/ 对应)
├── user/                  # 用户态程序源码
├── mkfs/                  # 文件系统镜像制作工具 (mkfs.c)
├── tools/                 # RAM 磁盘镜像创建脚本
├── testsh/                # 测试与评测脚本
├── mydocs/                # 开发文档/笔记 (38 篇)
├── site/                  # 远程测试相关脚本
├── Makefile               # 构建系统 (553 行)
├── kernel-rv              # 预编译的 RISC-V 内核镜像
└── *.md, *.pptx, *.txt    # 文档与演示材料
```

---

## 3. 子系统划分

### 3.1 启动子系统 (Boot)

| 路径 | 说明 |
|------|------|
| `boot/main.c` | 内核主入口 `main()`，执行所有子系统初始化 |
| `boot/rv/entry.S` | RISC-V S-mode 入口汇编 |
| `boot/rv/start.c` | RISC-V 早期初始化 (M-mode → S-mode 切换) |
| `boot/rv/initcode.S` / `initcode-sh.S` | 首个用户进程的代码 |
| `boot/la/entry.S` | LoongArch 入口汇编 |
| `boot/la/initcode.S` / `initcode-sh.S` | LoongArch 首个用户进程代码 |

### 3.2 进程管理 (Process)

| 路径 | 说明 |
|------|------|
| `kernel/proc/proc.c` (1,148 行) | 进程调度、创建、销毁、状态管理 |
| `kernel/proc/exec.c` (529 行) | 可执行文件加载 (ELF 解析与 execve) |
| `include/proc/proc.h` | 进程结构体定义 (含 context、cpu、trapframe、vma 等) |

### 3.3 内存管理 (Memory Management)

| 路径 | 说明 |
|------|------|
| `kernel/mm/vm.c` (778 行) | 虚拟内存管理、页表操作、mmap/munmap/mprotect |
| `kernel/mm/buddy.c` (319 行) | Buddy 伙伴系统页分配器 |
| `kernel/mm/kalloc.c` (44 行) | 物理页分配封装 |
| `include/memlayout.h` | 内存布局定义 (RISC-V / LoongArch / VF2) |
| `include/buddy.h`, `include/kalloc.h`, `include/mem.h` | 对应头文件 |

### 3.4 文件系统 (File System)

| 路径 | 说明 |
|------|------|
| `kernel/fs/vfs/file.c` (407 行) | VFS 文件描述符层 |
| `kernel/fs/vfs/fs.c` (101 行) | VFS 文件系统注册与查找 |
| `kernel/fs/vfs/inode.c` (48 行) | VFS inode 操作 |
| `kernel/fs/vfs/ops.c` (201 行) | VFS 操作接口 |
| `kernel/fs/VFS_ext.c` (1,108 行) | VFS ↔ ext4 桥接层 |
| `kernel/fs/VFS_block.c` (193 行) | 块设备抽象 |
| `kernel/fs/lwext4/` (**17,464 行 C**) | lwext4 库 — 完整的 ext4 文件系统实现 |
| `kernel/fs/bio.c` | 块缓存 (buffer cache) |
| `kernel/fs/pipe.c` (164 行) | 管道实现 |
| `kernel/fs/console.c` | 控制台输入/输出 |
| `include/fs/` | VFS、ext4 对应头文件 |

### 3.5 系统调用 (System Call)

| 路径 | 说明 |
|------|------|
| `kernel/syscall/syscall.c` (274 行) | 系统调用分发 |
| `kernel/syscall/sysproc.c` (1,816 行) | 进程相关系统调用 (fork, clone, execve, mmap, futex, signal 等) |
| `kernel/syscall/sysfile.c` (1,346 行) | 文件系统相关系统调用 (openat, read, write, sendfile, ppoll 等) |
| `kernel/syscall/syssig.c` | 信号相关系统调用 |
| `include/syscall/syscall.h` | 系统调用号定义 (**93 个系统调用**) |

### 3.6 陷阱与中断 (Trap & Interrupt)

| 路径 | 说明 |
|------|------|
| `kernel/trap/rv/trap.c` (9,780 行 RISC-V 实现) | RISC-V 陷阱处理 |
| `kernel/trap/la/trap.c` (18,207 行 LoongArch 实现) | LoongArch 陷阱处理 |
| `kernel/trap/rv/kernelvec.S` | RISC-V 内核态陷阱向量 |
| `kernel/trap/rv/trampoline.S` | RISC-V 用户态/内核态切换蹦床 |
| `kernel/trap/rv/swtch.S` | RISC-V 上下文切换汇编 |
| `kernel/trap/la/swtch.S` | LoongArch 上下文切换汇编 |
| `kernel/trap/rv/sigtrampoline.S` | RISC-V 信号处理蹦床 |
| `kernel/trap/signal.c` (273 行) | 信号处理通用逻辑 |

### 3.7 设备驱动 (Device Driver)

| 路径 | 说明 |
|------|------|
| `kernel/drive/uart.c` (254 行) | UART 串口驱动 |
| `kernel/drive/rv/plic.c` | RISC-V PLIC 中断控制器 |
| `kernel/drive/rv/virtio_disk.c` | RISC-V virtio 块设备驱动 |
| `kernel/drive/la/pci.c` (12,716 行) | LoongArch PCI 总线枚举 |
| `kernel/drive/la/virtio_pci.c` | LoongArch virtio PCI 传输层 |
| `kernel/drive/la/virtio_disk.c` | LoongArch virtio 块设备 |
| `kernel/drive/la/virtio_ring.c` | LoongArch virtio ring 操作 |

### 3.8 锁与同步 (Locking)

| 路径 | 说明 |
|------|------|
| `kernel/lock/spinlock.c` | 自旋锁实现 |
| `kernel/lock/sleeplock.c` | 睡眠锁实现 |
| `include/lock/lock.h` | 锁接口定义 |
| `include/lock/semaphore.h` | 信号量定义 |

### 3.9 工具函数 (Utilities)

| 路径 | 说明 |
|------|------|
| `kernel/util/printf.c` (427 行) | 内核格式化输出 |
| `kernel/util/string.c` (295 行) | 字符串/内存操作 |
| `kernel/util/futex.c` (99 行) | Futex 实现 |
| `kernel/util/qsort.c` | 排序实现 |

### 3.10 用户态程序

| 路径 | 说明 |
|------|------|
| `user/init-rv.c` / `user/init-la.c` | 启动脚本 (init 进程) |
| `user/sh.c` | Shell |
| `user/usertests.c` (2,925 行) | 用户态测试集 |
| `user/grind.c` | 压力测试 |
| 其他 | cat, echo, grep, ls, mkdir, rm, wc, ln, kill, zombie, futex, sigtest, sendtest 等 |

---

## 4. 构建系统分析

### 4.1 所需工具

根据 `Makefile` 分析，项目需要：

| 工具 | 用途 |
|------|------|
| `riscv64-linux-gnu-gcc` (及配套 binutils) | RISC-V 交叉编译 |
| `loongarch64-linux-gnu-gcc` (及配套 binutils) | LoongArch 交叉编译 |
| `qemu-system-riscv64` | RISC-V QEMU 模拟 |
| `qemu-system-loongarch64` | LoongArch QEMU 模拟 |
| GNU Make | 构建自动化 |
| `mkfs.ext4` | ext4 文件系统镜像制作 |
| `dd`, `losetup`, `mount` | 磁盘镜像操作 (需要 sudo) |

### 4.2 主要构建目标

| 目标 | 说明 |
|------|------|
| `make all` / `make kernel-la` | 编译 LoongArch 内核 (默认) |
| `make kernel-rv` | 编译 RISC-V 内核 |
| `make qemu` | 编译并运行 RISC-V 内核 |
| `make qemu-la` | 编译并运行 LoongArch 内核 |
| `make qemu-sh` | 编译运行 RISC-V (shell 变体, busysbox) |
| `make qemu-la-sh` | 编译运行 LoongArch (shell 变体) |
| `make clean` | 清理构建产物 |

### 4.3 架构支持

- **RISC-V**: 主要目标平台，支持 QEMU `virt` 机器和 VisionFive2 真实硬件 (`#ifdef VF2`)
- **LoongArch**: 第二目标平台，支持 Loongson 2K1000LA

架构相关代码通过 `kernel/*/rv/` 和 `kernel/*/la/` 分离，通用代码位于对应父目录，Makefile 通过后缀 `-rv.o` / `-la.o` 区分架构编译产物。

---

## 5. 超出标准 xv6 的主要扩展

1. **ext4 文件系统** — 集成 lwext4 库，支持完整 ext4 读写
2. **VFS 抽象层** — 支持多文件系统挂载
3. **信号机制** — 完整的 POSIX 信号支持 (sigaction, sigprocmask, 信号递送)
4. **Futex** — 快速用户空间互斥锁
5. **mmap/munmap/mprotect** — 内存映射
6. **clone** — 线程支持
7. **poll/ppoll** — I/O 多路复用
8. **Buddy 分配器** — 伙伴系统物理内存管理
9. **93 个系统调用** — 远超标准 xv6 的约 20 个
10. **双架构** — RISC-V + LoongArch
11. **Busybox 兼容** — 支持运行 Busybox 用户空间