综合分析完成。下面是初步探索结果报告。

---

# OS 内核项目初步分析报告

## 一、项目概览

该项目名为 **OSKernel C Base Model**，是一个面向操作系统内核比赛的 C 语言内核模型。主要目标平台为 RISC-V64（QEMU virt），同时包含一个实验性的 LoongArch64 启动模型。项目采用 BSD 2-Clause License。

## 二、文件组织结构

```
.
├── Makefile                  # 顶层构建文件（RISC-V 和 LoongArch 双目标）
├── README.md                 # 项目说明
├── Dockerfile                # Docker 构建环境
├── command                   # 一键 Docker 运行命令
├── LICENSE                   # 许可证
├── linker/                   # 链接脚本
│   ├── riscv64.ld            #   RISC-V64 内核链接脚本
│   ├── loongarch64.ld        #   LoongArch64 内核链接脚本
│   └── user.ld               #   用户态 ELF 链接脚本
├── src/                      # 内核源码
│   ├── arch/                 #   架构相关代码
│   │   ├── riscv64/          #     RISC-V64 架构
│   │   │   ├── boot.S        #       启动入口
│   │   │   ├── trap.S        #       陷阱向量汇编
│   │   │   ├── trap.c        #       陷阱初始化与处理
│   │   │   └── user.S        #       用户态入口
│   │   └── loongarch64/      #     LoongArch64 架构
│   │       ├── boot.S        #       启动入口
│   │       ├── minikernel.c  #       最小内核（ext4 扫描器）
│   │       └── virtio_pci_blk.c  #   PCI virtio 块设备驱动
│   ├── drivers/              #   设备驱动
│   │   ├── uart.c            #     UART 串口
│   │   ├── virtio_blk.c      #     virtio MMIO 块设备
│   │   └── virtio_net.c      #     virtio MMIO 网络设备
│   ├── include/              #   公共头文件（共 20 个）
│   │   ├── types.h / compiler.h / panic.h / printk.h / string.h
│   │   ├── riscv.h / memlayout.h / trap.h / syscall.h / elf.h
│   │   ├── task.h / vm.h / fs.h / ext4.h / block.h / net.h
│   │   ├── uart.h / user.h / errno.h / selftest.h
│   ├── kernel/               #   内核通用逻辑（共 12 个源文件）
│   │   ├── main.c            #     内核主入口
│   │   ├── syscall.c         #     系统调用分发与实现（最大文件，5756 行）
│   │   ├── task.c            #     任务/进程管理
│   │   ├── vm.c              #     虚拟内存管理
│   │   ├── fs.c              #     虚拟文件系统层
│   │   ├── ext4.c            #     ext4 文件系统只读支持
│   │   ├── elf.c             #     ELF 加载器
│   │   ├── printk.c / panic.c / string.c  # 基础库
│   │   ├── selftest.c        #     自检逻辑
│   │   └── user_stack.c      #     用户栈管理
│   └── user/                 #   用户态程序
│       ├── init.c            #     用户态 init shell（35321 字节，最复杂）
│       ├── init.S            #     用户态入口汇编
│       ├── test_echo.S       #     测试回显程序
│       └── read_disk.S       #     磁盘读取测试
├── testbin/                  # 预编译比赛测试二进制（36 个）
├── tools/                    # 测试镜像制作脚本（7 个）
└── docs/                     # 文档
```

## 三、子系统分析

### 3.1 架构启动层

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| RISC-V64 启动 | `src/arch/riscv64/boot.S` | `_start` 入口，16 KiB 启动栈，BSS 清零，跳转 `kernel_main` |
| LoongArch64 启动 | `src/arch/loongarch64/boot.S` | LoongArch 入口 |

RISC-V64 内核加载基址为 `0x80200000`，LoongArch64 为 `0x02000000`。

### 3.2 异常与陷阱处理

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| 陷阱入口 | `src/arch/riscv64/trap.S` | 汇编级陷阱向量，保存/恢复 TrapFrame |
| 陷阱分发 | `src/arch/riscv64/trap.c` | 异常名称打印、时钟中断设置、syscall 分发 |
| 用户态切换 | `src/arch/riscv64/user.S` | `enter_user_mode` 切换到 U-mode |

### 3.3 内存管理

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| 虚拟内存 | `src/kernel/vm.c` | Sv39 页表管理、物理页分配器（基于空闲链表）、页映射/解映射 |
| 内存布局 | `src/include/memlayout.h` | 地址空间布局定义 |

### 3.4 进程/任务管理

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| 任务调度 | `src/kernel/task.c` | 最多 256 个任务，支持 `TASK_RUNNABLE`/`TASK_RUNNING`/`TASK_ZOMBIE`/`TASK_BLOCKED`/`TASK_SLEEPING` 等状态 |
| 任务结构 | `src/include/task.h` | 任务控制块定义、文件描述符表、管道、信号 |

实现的关键功能：`task_clone_current`、`task_wait`、`task_request_resched`、信号处理（sigaction/sigprocmask/sigaltstack）、futex、robust list。

### 3.5 系统调用

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| 系统调用 | `src/kernel/syscall.c` | 155 个已注册 syscall（共定义 SYS_MAX=436） |

已实现的 syscall 涵盖以下类别：
- **文件 I/O**：openat, close, read, write, readv, writev, pread64, pwrite64, lseek, sendfile
- **文件系统**：getdents64, mkdirat, unlinkat, linkat, renameat, mount, umount2, statfs, fstatfs, readlinkat, newfstatat, fstat, utimensat, statx
- **进程管理**：exit, exit_group, clone (标记为 unimplemented), execve (标记为 unimplemented), wait4, kill, tkill, tgkill
- **内存管理**：brk, mmap, munmap, mremap, mprotect, msync, mincore
- **时间相关**：nanosleep, clock_gettime, clock_nanosleep, gettimeofday, times, timerfd_create/settime/gettime
- **网络**：socket, bind, listen, accept4, connect, sendto, recvfrom, sendmsg, recvmsg, getsockname, getpeername, setsockopt, getsockopt, shutdown
- **信号**：rt_sigaction, rt_sigprocmask, rt_sigsuspend, rt_sigtimedwait, rt_sigqueueinfo
- **其他**：getpid, getppid, getuid, gettid, uname, sysinfo, getcwd, chdir, pipe2, dup, dup3, fcntl, ioctl, epoll_create1, epoll_ctl, epoll_pwait, eventfd2, futex, sched_yield, getrandom, rseq 等

其中 5 个 syscall 标记为 `sys_unimplemented`（包括 clone, execve, clone3, vfork）。

### 3.6 文件系统

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| 虚拟文件系统 | `src/kernel/fs.c` | VFS 层，内存文件系统（memfs），支持文件/目录操作、文件描述符管理，最多 2048 个文件 |
| Ext4 支持 | `src/kernel/ext4.c` | ext4 只读读取，超级块解析、inode 查找、目录遍历、文件缓存 |
| 块设备抽象 | `src/include/block.h` | 块设备接口 |

### 3.7 ELF 加载器

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| ELF 加载 | `src/kernel/elf.c` | ELF64 验证、段加载、动态解释器路径提取、`elf_interp_is_optional` 判断 |

支持 ET_EXEC 和 ET_DYN 类型，基于 Sv39 页表加载。

### 3.8 设备驱动

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| UART | `src/drivers/uart.c` | NS16550 兼容 UART 轮询输出 |
| virtio-blk (MMIO) | `src/drivers/virtio_blk.c` | virtio MMIO 块设备，支持扇区读写 |
| virtio-net (MMIO) | `src/drivers/virtio_net.c` | virtio MMIO 网络设备，报文收发 |
| virtio-blk (PCI) | `src/arch/loongarch64/virtio_pci_blk.c` | LoongArch PCI 版 virtio 块设备 |

### 3.9 LoongArch64 最小内核

`src/arch/loongarch64/minikernel.c` 是一个独立的最小内核，不同于 RISC-V 的完整内核。它仅实现：
- 串口输出
- ext4 磁盘扫描（遍历测试脚本目录并输出"skip"信息）
- 关机（通过 GED 寄存器）

该内核**不支持用户态 ELF 执行**，主要用于展示 LoongArch 平台的基本启动能力。

### 3.10 用户态程序

| 程序 | 文件 | 说明 |
|------|------|------|
| init shell | `src/user/init.c` | 类 shell 用户程序，支持脚本执行、内建命令（echo, cat, ls, mkdir, touch, rm, cp, mv, chmod 等）、环境变量 |
| test_echo | `src/user/test_echo.S` | 测试用回显程序 |
| read_disk | `src/user/read_disk.S` | 测试磁盘读取 |

## 四、构建工具要求

根据 Makefile 分析，构建该项目需要以下工具链：

| 工具 | 用途 |
|------|------|
| `riscv64-unknown-elf-gcc` / `ld` / `objcopy` / `objdump` | RISC-V64 裸机交叉编译、链接、反汇编 |
| `loongarch64-linux-gnu-gcc` / `ld` / `objdump` | LoongArch64 交叉编译（仅用于 minikernel） |
| GNU Make | 构建编排 |
| QEMU (`qemu-system-riscv64`) | RISC-V64 内核模拟运行 |
| Docker（可选） | 容器化构建与运行（基于 `zhouzhouyi/os-contest:20260510` 镜像） |

构建产物：
- `kernel-rv` — RISC-V64 内核 ELF
- `kernel-la` — LoongArch64 内核 ELF
- `build/kernel-rv.asm` — RISC-V64 内核反汇编

## 五、初步总体评价

该项目是一个在比赛框架下开发的中等规模 OS 内核。核心能力集中在 RISC-V64 平台，LoongArch64 仅为辅助展示。从代码量来看（总计约 12,000 行 C/汇编），已经实现了较完整的系统调用接口（155 个）、虚拟内存管理、任务调度、信号处理、VFS/Ext4 文件系统和 virtio 设备驱动。用户态方面配备了一个较为完善的 init shell 作为测试载体。clone/execve 在 syscall 层面标记为 `sys_unimplemented`，但 task.c 中已有 `task_clone_current` 的实现。