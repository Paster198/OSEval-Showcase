## 项目初步调查报告

### 一、项目概述

该项目为 **OSKernel2024-X2** 操作系统内核竞赛项目，基于 xv6 (MIT 教学操作系统) 进行改造，目标架构为 **RISC-V 64位**，运行于 QEMU virt 虚拟机平台。项目使用 C 语言编写内核，汇编语言处理底层启动和上下文切换，文件系统采用 **FAT32** 格式（区别于 xv6 原生的简单文件系统）。

---

### 二、文件组织结构

```
.
├── 内核源码（根目录）
│   ├── 启动与引导: boot.S, start.S, mem.S, entry.S
│   ├── 中断与异常: kernelvec.S, trampoline.S, timervec.S
│   ├── 内核主逻辑: kernel.c, trap.c, timer.c
│   ├── 内存管理:   kalloc.c, vm.c, page.c
│   ├── 进程管理:   proc.c, exec.c, user.c
│   ├── 文件系统:   fs.c, bcache.c, virtio_disk.c, file.c
│   ├── 系统调用:   syscall.c, sysfile.c, sysfproc.c
│   ├── IPC:        pipe.c
│   ├── 设备驱动:   uart.c, console.c, plic.c
│   ├── 同步机制:   spinlock.c, sleeplock.c
│   ├── 工具函数:   string.c, printf.c
│   └── 链接脚本:   os.ld, bootloader.ld
├── include/          -- 内核头文件（22个 .h 文件）
├── user/             -- 用户态程序源码及预编译二进制
│   ├── 用户库:       ulib.c, usys.S, printf.c, umalloc.c
│   ├── 用户程序:     init.c, sh.c, ls.c, cat.c, echo.c, grep.c 等
│   ├── 链接脚本:     user.ld
│   └── 预编译二进制:  fork, execve, mmap, clone, pipe, wait 等（约40个）
├── fs/               -- 用于写入 FAT32 镜像的用户程序副本
├── build/            -- 编译产物（.o 目标文件）
├── mkfs/             -- 文件系统镜像制作相关
├── Makefile          -- 构建脚本
├── Dockerfile        -- 容器化构建环境
├── sbi-qemu          -- 自制的简易 SBI 固件（M-mode bootloader）
└── kernel-qemu       -- 编译好的内核 ELF 文件
```

---

### 三、子系统划分

| 子系统 | 主要源文件 | 说明 |
|--------|-----------|------|
| **引导启动 (Boot/SBI)** | `boot.S`, `start.S`, `mem.S`, `timer.c`, `timervec.S`, `bootloader.ld` | 自制 M-mode bootloader，完成寄存器初始化、PMP配置、时钟中断设置后通过 `mret` 进入 S-mode |
| **内存管理** | `kalloc.c`, `vm.c`, `page.c` | 物理页分配器（kalloc）、虚拟内存页表管理（vm）、mmap 等页面映射（page） |
| **进程管理** | `proc.c`, `exec.c`, `entry.S`, `user.c` | 进程创建/调度/退出、ELF 加载执行（exec）、上下文切换（entry.S/swtch） |
| **中断/异常处理** | `trap.c`, `kernelvec.S`, `trampoline.S` | S-mode trap 入口、内核态/用户态切换的 trampoline 页面 |
| **时钟中断** | `timer.c`, `timervec.S` | M-mode 定时器中断处理，通过软件中断委托给 S-mode |
| **中断控制器 (PLIC)** | `plic.c` | 平台级中断控制器初始化与中断分发 |
| **文件系统 (FAT32)** | `fs.c`, `bcache.c`, `virtio_disk.c` | FAT32 文件系统实现（长/短文件名目录项、簇链管理）、块缓存（LRU双向链表）、VirtIO 块设备驱动 |
| **文件描述符/VFS** | `file.c`, `sysfile.c`, `sysfproc.c` | 文件描述符管理、文件相关系统调用（open/read/write/close/dup 等）、进程相关系统调用（fork/exec/wait 等） |
| **管道 (Pipe)** | `pipe.c` | 半双工管道实现，支持读写端阻塞/唤醒 |
| **串口驱动 (UART)** | `uart.c` | 16550 UART 驱动，支持中断驱动的收发 |
| **控制台** | `console.c` | 控制台读写，行缓冲输入处理 |
| **系统调用** | `syscall.c`, `sysfile.c`, `sysfproc.c` | 系统调用分发与实现，涵盖约 30+ 个系统调用 |
| **同步原语** | `spinlock.c`, `sleeplock.c` | 自旋锁与睡眠锁 |
| **用户态程序** | `user/` 目录下各 `.c` 文件 | init、shell(sh)、ls、cat、echo、grep、wc 等基础用户程序 |

---

### 四、系统调用覆盖

根据 `user/` 目录下的预编译二进制和源码，项目实现了以下系统调用（约 30+ 个）：

- **进程管理**: fork, execve, exit, wait, waitpid, getpid, getppid, clone, yield, sleep, times
- **内存管理**: brk, mmap, munmap
- **文件操作**: open, openat, close, read, write, dup, dup2, fstat, getdents, unlink, chdir, getcwd, mkdir
- **文件系统**: mount, umount
- **IPC**: pipe
- **其他**: uname, gettimeofday

---

### 五、构建工具链需求

| 工具 | 用途 | Makefile 中的引用 |
|------|------|-------------------|
| `riscv64-linux-gnu-gcc` | 交叉编译 C/ASM 源码 | `CC = ${CROSS_COMPILE}gcc` |
| `riscv64-linux-gnu-ld` | 链接内核和用户程序 | `LINKER = ${CROSS_COMPILE}ld` |
| `riscv64-linux-gnu-objcopy` | 生成 initcode 二进制 | `OBJCOPY = ${CROSS_COMPILE}objcopy` |
| `riscv64-linux-gnu-objdump` | 反汇编调试 | `OBJDUMP = ${CROSS_COMPILE}objdump` |
| `qemu-system-riscv64` | 运行内核 | `QEMU = qemu-system-riscv64` |
| `gdb-multiarch` | 调试 | `GDB = gdb-multiarch` |
| `mkfs.vfat` | 制作 FAT32 文件系统镜像 | `fs` 目标中使用 |
| `dd` | 创建空白镜像文件 | `fs` 目标中使用 |
| `mount/umount` | 挂载镜像写入文件 | `fs` 目标中使用（需 sudo） |
| `GNU Make` | 构建编排 | Makefile |

**编译参数**: `-march=rv64gc -mabi=lp64d -fno-stack-protector -nostdlib -fno-builtin`

**QEMU 配置**: virt 机器、128MB 内存、2 核 SMP、VirtIO 块设备 + 网络设备、使用自制 SBI 固件（`sbi-qemu`）作为 BIOS。

---

### 六、初步观察

1. **项目成熟度**: 项目已具备较完整的内核子系统，包括自制的 M-mode bootloader、FAT32 文件系统、VirtIO 驱动、管道 IPC、以及较丰富的系统调用接口，整体完成度较高。
2. **代码组织**: 内核源码平铺在根目录，未做子目录分层，规模适中（约 25 个 C 文件 + 7 个 ASM 文件），头文件集中在 `include/` 目录。
3. **仓库卫生**: 根目录存在较多编译产物（`.o`、`.map`、`kernel-qemu`、`sbi-qemu`、`fat32.img` 等）和临时文件（`diff.txt`、`res.txt`、`test.txt`），未通过 `.gitignore` 有效管理。
4. **用户态**: `user/` 和 `fs/` 目录中包含大量预编译的用户态 ELF 二进制文件，这些是竞赛测试用例所需的程序。