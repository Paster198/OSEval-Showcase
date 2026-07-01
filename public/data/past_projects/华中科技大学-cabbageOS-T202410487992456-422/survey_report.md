# cabbageOS 项目初步分析报告

## 项目基本信息

- **项目名称**: cabbageOS（构建系统中称为 hustOS）
- **所属学校**: 华中科技大学
- **目标架构**: RISC-V 64位
- **主要平台**: QEMU virt 机器（主），VisionFive2 开发板（辅）
- **开发语言**: C（内核主体），Rust（部分依赖库），汇编（启动与上下文切换）
- **构建系统**: CMake + GNU Make，支持 Ninja 加速

## 仓库顶层结构

```
.
├── bootloader/       # SBI 固件（预编译的 OpenSBI ELF）
├── kernel/           # 内核源码
│   ├── dep/          # 外部依赖（Rust 实现的 virtio-drivers、sdcard 驱动）
│   ├── platform/     # 平台相关代码（qemu、visionfive）
│   └── src/          # 内核核心源码
├── include/          # 内核头文件
├── user/             # 用户态程序
├── tool/             # 辅助工具（syscall 表生成、xxd 等）
├── scripts/          # 构建/运行脚本（QEMU 启动、镜像制作等）
├── tests/            # 竞赛测试用例（oscomp）
├── doc/              # 开发文档
├── Makefile          # 顶层 Makefile
├── CMakeLists.txt    # 顶层 CMake 配置
├── init.mk           # 构建宏定义与镜像制作逻辑
└── toolchain.cmake   # RISC-V 交叉编译工具链配置
```

## 子系统划分

### 1. 启动与平台层（bootloader / kernel/platform）

| 目录 | 说明 |
|------|------|
| `bootloader/` | 预编译的 OpenSBI 固件（opensbi.elf），作为 SBI 引导层 |
| `kernel/platform/qemu/` | QEMU 平台入口：entry.S（汇编入口）、start.c（C 入口）、main.c、trap.c、virtio_disk.c、bio.c、linker.ld |
| `kernel/platform/visionfive/` | VisionFive2 平台入口：结构与 QEMU 类似，额外包含 SD 卡测试代码 |

### 2. 内存管理子系统（mm）

| 文件 | 说明 |
|------|------|
| `kernel/src/mm/buddy.c` | Buddy 伙伴系统分配器 |
| `kernel/src/mm/kalloc.c` | 内核内存分配（kmalloc/kfree） |
| `kernel/src/mm/mm.c` | mm_struct 管理（地址空间描述） |
| `kernel/src/mm/vm.c` | 虚拟内存页表操作 |
| `kernel/src/mm/vma.c` | VMA（虚拟内存区域）管理 |
| `kernel/src/mm/mmap.c` | mmap/munmap 实现 |
| `kernel/src/mm/pagefault.c` | 缺页异常处理 |

### 3. 进程/线程管理子系统（proc）

| 文件 | 说明 |
|------|------|
| `kernel/src/proc/pcb_life.c` | 进程控制块（PCB）生命周期管理 |
| `kernel/src/proc/tcb_life.c` | 线程控制块（TCB）生命周期管理 |
| `kernel/src/proc/sched.c` | 调度器（基于队列的状态机调度） |
| `kernel/src/proc/exec.c` | execve 实现（ELF 加载） |
| `kernel/src/proc/pcb_mm.c` | 进程地址空间管理 |

项目采用 PCB/TCB 分离设计，支持多线程。进程状态包括 UNUSED、USED、ZOMBIE；线程状态包括 UNUSED、USED、RUNNABLE、SLEEPING、RUNNING。

### 4. 文件系统子系统（fs）

| 目录/文件 | 说明 |
|-----------|------|
| `kernel/src/fs/vfs/` | VFS 抽象层：file.c、inode.c、fs.c、ops.c、mpage.c、filemap.c、inode_writeback.c |
| `kernel/src/fs/fat32/` | FAT32 文件系统实现（自研） |
| `kernel/src/fs/ext4/lwext4/` | ext4 文件系统（基于 lwext4 第三方库） |
| `kernel/src/fs/procfs/` | procfs 伪文件系统（stat、meminfo、mounts、smaps、oom_score_adj） |
| `kernel/src/fs/dev.c` | 设备文件支持 |
| `kernel/src/fs/poll.c` | poll 机制 |
| `kernel/src/fs/select.c` | select 机制 |

支持 FAT32 和 ext4 两种文件系统，可通过构建参数选择。

### 5. 进程间通信子系统（ipc）

| 文件 | 说明 |
|------|------|
| `kernel/src/ipc/pipe.c` | 管道（pipe）实现 |
| `kernel/src/ipc/shm.c` | 共享内存（System V SHM） |
| `kernel/src/ipc/signal.c` | POSIX 信号机制（sigaction、sigprocmask） |
| `kernel/src/ipc/ipc_ops.c` | IPC 通用操作 |

### 6. 同步与原子操作子系统（atomic）

| 文件 | 说明 |
|------|------|
| `kernel/src/atomic/spinlock.c` | 自旋锁 |
| `kernel/src/atomic/semaphore.c` | 信号量 |
| `kernel/src/atomic/cond.c` | 条件变量 |
| `kernel/src/atomic/futex.c` | Futex（基于哈希表实现） |
| `kernel/src/atomic/atomic.c` | 原子操作 |

### 7. 驱动子系统（driver）

| 文件 | 说明 |
|------|------|
| `kernel/src/driver/uart.c` | UART 串口驱动（QEMU） |
| `kernel/src/driver/uart8250.c` | UART 8250 驱动 |
| `kernel/src/driver/console.c` | 控制台驱动 |
| `kernel/src/driver/ramdisk.c` | RAM Disk 驱动 |
| `kernel/platform/qemu/src/virtio_disk.c` | VirtIO 块设备驱动（QEMU） |
| `kernel/dep/sdcard/` | SD 卡驱动（Rust，VisionFive2 平台） |
| `kernel/dep/virtio-drivers/` | VirtIO 设备驱动库（Rust，第三方） |

### 8. 系统调用子系统（syscall）

| 文件 | 说明 |
|------|------|
| `kernel/src/syscall/syscall.c` | 系统调用入口与参数获取 |
| `kernel/src/syscall/syscall_table.c` | 系统调用表（由工具自动生成） |
| `kernel/src/syscall/sysproc.c` | 进程类系统调用（fork/clone、exec、wait、exit 等） |
| `kernel/src/syscall/sysfile.c` | 文件类系统调用（open、read、write、stat 等） |
| `kernel/src/syscall/sysipc.c` | IPC 类系统调用（pipe、shm、signal 等） |
| `kernel/src/syscall/sysmisc.c` | 杂项系统调用（uname、gettimeofday 等） |
| `kernel/src/syscall/sysinfo.c` | sysinfo 系统调用 |
| `kernel/src/syscall/syscallnew.c` | 扩展系统调用 |
| `tool/syscall.tbl` | 系统调用定义表（约 133 项） |
| `tool/syscall-final.tbl` | 决赛用系统调用表（约 138 项） |

### 9. 汇编层（asm）

| 文件 | 说明 |
|------|------|
| `kernel/src/asm/kernelvec.S` | 内核态中断/异常向量 |
| `kernel/src/asm/trampoline.S` | 用户态/内核态切换跳板 |
| `kernel/src/asm/swtch.S` | 上下文切换 |
| `kernel/src/asm/sigret.S` | 信号返回 |
| `kernel/src/asm/sddata.S` | 内嵌数据段 |

### 10. 内核库（lib）

| 文件 | 说明 |
|------|------|
| `kernel/src/lib/string.c` | 字符串操作 |
| `kernel/src/lib/printf.c` | 内核 printf |
| `kernel/src/lib/sprintf.c` | sprintf |
| `kernel/src/lib/queue.c` | 通用队列 |
| `kernel/src/lib/radix_tree.c` | 基数树 |
| `kernel/src/lib/timer.c` | 定时器 |
| `kernel/src/lib/qsort.c` | 快速排序 |
| `kernel/src/lib/ctype.c` | 字符类型判断 |

### 11. 用户态程序（user）

| 目录/文件 | 说明 |
|-----------|------|
| `user/bin/` | 基本命令行工具：sh、cat、echo、ls、grep、kill、mkdir、rm、wc、git 等 |
| `user/deps/` | 用户态库：syscall 封装、printf、malloc、clone 汇编 |
| `user/tests/` | 系统调用测试程序（futex、signal、fcntl、readv 等） |
| `user/ltp/` | LTP（Linux Test Project）测试框架适配 |
| `user/include/` | 用户态头文件（stdio、stdlib、string、unistd） |

## 构建工具需求

| 工具 | 用途 |
|------|------|
| `riscv64-unknown-elf-gcc` | RISC-V 裸机交叉编译器 |
| `riscv64-unknown-elf-objcopy` | 二进制格式转换 |
| `riscv64-unknown-elf-objdump` | 反汇编 |
| `riscv64-unknown-elf-gdb` | 调试 |
| `cmake` (>= 3.10) | 构建配置 |
| `ninja`（可选） | 加速构建 |
| `make` | 顶层构建入口 |
| `python3` | 系统调用表自动生成 |
| `qemu-system-riscv64` | 模拟器运行 |
| `mkfs.ext4` / `mkfs.vfat` | 文件系统镜像制作 |
| `dd`、`mount`/`umount` | 镜像操作 |
| `clang-format`（可选） | 代码格式化 |
| Rust 工具链 | 编译 virtio-drivers 和 sdcard 依赖（通过 Cargo） |

## 初步观察

1. **架构风格**: 项目整体风格受 xv6 影响明显（trapframe、pagetable、proc 结构等命名），但在此基础上进行了大量扩展，形成了较为完整的类 Linux 内核架构。

2. **PCB/TCB 分离**: 支持多进程多线程模型，进程和线程有独立的生命周期管理和状态队列。

3. **双文件系统**: 同时实现了自研 FAT32 和集成 lwext4 的 ext4，通过 VFS 层统一抽象。

4. **Rust 依赖**: 底层 VirtIO 驱动和 SD 卡驱动使用 Rust 实现，通过 CMake 集成到 C 内核中。

5. **竞赛导向**: 项目明确面向操作系统竞赛（oscomp），支持多种运行目标（tests、bin、comp、busybox、final），包含 LTP 测试适配。

6. **系统调用覆盖**: 约 133-138 个系统调用，覆盖进程管理、文件操作、内存映射、IPC、信号、futex 等核心功能。