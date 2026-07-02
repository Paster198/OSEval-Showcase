## 项目初步调查报告

### 一、项目概况

该项目名为 **httos**（启动日志中显示为 "AdddOS"），是一个支持 **RISC-V** 和 **LoongArch（龙芯）** 双架构的操作系统内核。项目位于 `/work` 目录下。

### 二、顶层目录结构

```
/
├── CMakeLists.txt          # 顶层 CMake 构建入口，定义架构选择和编译选项
├── Makefile                # Make 封装，提供 build/qemu/clean 等快捷目标
├── README / readme.md      # 项目说明
├── .gdbinit.tmpl-riscv     # RISC-V GDB 初始化模板
├── kernel/                 # 内核核心源码
├── include/                # 内核头文件（与 kernel 目录对应）
├── include2/               # newlib C 库头文件（用户态程序编译用）
├── user/                   # 用户态程序
├── scripts/                # 构建/运行辅助脚本
├── data/                   # 构建过程挂载点（mnt/）
└── doc/                    # 项目文档与笔记
```

### 三、内核子系统划分

#### 1. 启动与初始化（Boot）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/boot/main.c` | 内核主入口 `main()`，依次初始化各子系统 |
| `kernel/boot/riscv/entry.S` | RISC-V 架构入口汇编 |
| `kernel/boot/loongarch/entry.S` | LoongArch 架构入口汇编 |
| `kernel/boot/riscv/start.c` | RISC-V 的 `start()` 函数，从 M 态切到 S 态后跳转 `main()` |
| `kernel/boot/*/initcode.S` | 第一个用户进程（init）的内嵌代码 |

#### 2. 内存管理（Memory）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/mem/buddysystem.c` | 伙伴分配器，用于物理页帧管理 |
| `kernel/mem/slab.c` | Slab 分配器，用于内核对象分配 |
| `kernel/mem/kalloc.c` | 物理页分配器封装 |
| `kernel/mem/vm.c` | 虚拟内存管理（页表创建/映射/拷贝/释放） |
| `kernel/mem/trampoline.S` | 用户态/内核态切换的跳板页 |
| `kernel/mem/uart.c` | UART 串口输出支持 |
| `include/mem/` | 对应头文件：`memlayout.h`（内存布局）、`buddysystem.h`、`slab.h`、`kalloc.h`、`mem.h` |

#### 3. 进程管理（Process）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/proc/proc.c` | 进程核心管理（创建、调度、fork、wait、exit 等），约 30KB，最大的内核文件 |
| `kernel/proc/exec.c` | `exec` 系统调用实现（ELF 加载），约 20KB |
| `kernel/proc/signal.c` | 信号处理（sigaction, sigprocmask, sigreturn 等） |
| `kernel/proc/socket.c` | Socket 实现，约 20KB |
| `kernel/proc/pipe.c` | 管道实现 |
| `kernel/proc/semaphore.c` | 信号量同步原语 |
| `kernel/proc/spinlock.c` | 自旋锁 |
| `kernel/proc/sleeplock.c` | 睡眠锁 |
| `kernel/proc/riscv/swtch.S` | RISC-V 上下文切换汇编 |
| `kernel/proc/loongarch/swtch.S` | LoongArch 上下文切换汇编 |
| `kernel/proc/*/sig_trampoline.S` | 信号返回跳板 |
| `include/proc/proc.h` | 进程控制块（PCB）结构定义，`trapframe.h`，`signal.h`，`socket.h` |

#### 4. 文件系统（File System）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/fs/vfs/file.c` | VFS 文件层（file_operations，文件描述符管理） |
| `kernel/fs/vfs/fs.c` | VFS 文件系统注册与挂载 |
| `kernel/fs/vfs/inode.c` | VFS inode 管理层 |
| `kernel/fs/vfs/ops.c` | VFS 操作接口 |
| `kernel/fs/ext4/vfs_ext4_ext.c` | ext4 适配层（将 lwext4 接入 VFS），约 30KB |
| `kernel/fs/ext4/vfs_ext4_blockdev_ext.c` | ext4 块设备适配 |
| `kernel/fs/ext4/lwext4/` | **lwext4** 第三方 ext4 库（~30+ 文件，涵盖 ext4 全部核心功能：inode、extent、journal、dir、xattr 等） |
| `include/fs/vfs/` | VFS 头文件 |
| `include/fs/ext4/` | ext4 头文件 |

#### 5. 系统调用（System Call）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/sys/syscall.c` | 系统调用分发入口，参数提取 |
| `kernel/sys/sysfile.c` | 文件相关系统调用（~32KB，最大 sys 文件） |
| `kernel/sys/sysmem.c` | 内存相关系统调用（brk, mmap, munmap 等） |
| `kernel/sys/sysproc.c` | 进程相关系统调用（fork, wait, exit 等） |
| `kernel/sys/sysothers.c` | 其他杂项系统调用 |
| `kernel/sys/syssig.c` | 信号相关系统调用 |
| `kernel/sys/plic.c` | RISC-V PLIC 中断控制器 |
| `include/sys/syscall.h` | 系统调用号定义（约 90+ 系统调用） |

#### 6. 陷阱与中断处理（Trap）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/trap/riscv/trap.c` | RISC-V 陷阱处理（中断/异常分发、系统调用入口） |
| `kernel/trap/riscv/kernelvec.S` | RISC-V 内核态陷阱向量 |
| `kernel/trap/loongarch/trap.c` | LoongArch 陷阱处理 |
| `kernel/trap/loongarch/kernelvec.S` | LoongArch 内核态陷阱向量 |
| `kernel/trap/loongarch/uservec.S` | LoongArch 用户态陷阱入口 |
| `kernel/trap/loongarch/tlbrefill.S` | LoongArch TLB 重填 |
| `kernel/trap/loongarch/apic.c` | LoongArch APIC 中断控制器 |
| `kernel/trap/loongarch/extioi.c` | LoongArch 扩展 I/O 中断控制器 |

#### 7. 设备驱动（Driver）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/driver/bio.c` | 块 I/O 缓冲层 |
| `kernel/driver/riscv/virtio_disk.c` | RISC-V virtio 磁盘驱动 |
| `kernel/driver/loongarch/virtio_disk.c` | LoongArch virtio 磁盘驱动 |
| `kernel/driver/loongarch/virtio_pci.c` | LoongArch virtio PCI 传输层 |
| `kernel/driver/loongarch/virtio_ring.c` | LoongArch virtio ring 缓冲区管理 |
| `kernel/driver/loongarch/pci.c` | LoongArch PCI 设备枚举 |
| `include/dev/virtio.h` | virtio 通用定义 |
| `include/dev/pci/` | PCI 相关头文件 |

#### 8. 内核库（Kernel Library）

| 目录 / 文件 | 说明 |
|---|---|
| `kernel/lib/console.c` | 控制台输出 |
| `kernel/lib/printf.c` | 格式化打印 |
| `kernel/lib/string.c` | 字符串操作 |
| `kernel/lib/qsort.c` | 快速排序 |
| `kernel/lib/ctype.c` | 字符分类函数 |

#### 9. 同步原语（Lock）

| 目录 / 文件 | 说明 |
|---|---|
| `include/lock/spinlock.h` | 自旋锁 |
| `include/lock/sleeplock.h` | 睡眠锁 |
| `include/lock/semaphore.h` | 信号量 |

### 四、用户态程序

| 路径 | 说明 |
|---|---|
| `user/deps/` | 用户库：`ulib.c`（系统调用封装）、`printf.c`、`umalloc.c`、`usys.pl`（系统调用桩生成脚本） |
| `user/init/` | init 进程：`initcode.S`（嵌入内核的初始代码） |
| `user/app/` | 用户应用源码：`sh.c`（Shell）、`ls.c`、`cat.c`、`echo.c`、`grep.c`、`wc.c`、`kill.c`、`mkdir.c`、`rm.c`、`zombie.c`、`shutdown.c`、`init-riscv.c`、`init-loongarch.c` |
| `user/tests/` | 测试程序：`signal_test.c` |
| `user/bin/` | 预编译二进制（busybox、libc 测试脚本、架构特定测试程序等） |
| `include2/` | newlib 标准 C 头文件（供用户程序 `#include` 使用） |

### 五、构建系统

#### 构建工具链需求

| 组件 | 工具 |
|---|---|
| 构建系统 | **CMake**（>= 3.21）+ **Make** |
| RISC-V 交叉编译器 | `riscv64-unknown-elf-gcc`（裸机工具链） |
| LoongArch 交叉编译器 | `loongarch64-linux-gnu-gcc` |
| 模拟器 | QEMU（`qemu-system-riscv64` / `qemu-system-loongarch64`） |
| 调试 | `riscv64-unknown-elf-gdb` |
| 文件系统镜像 | `dd`、`mkfs.ext4`、`debugfs`、`md5sum` |

#### 构建目标

Makefile 提供以下主要目标：

- `build-release-riscv` / `build-release-loongarch`：Release 构建
- `build-debug-riscv` / `build-debug-loongarch`：Debug 构建
- `qemu-riscv` / `qemu-loongarch`：构建并启动 QEMU
- `make-image` / `make-image-force`：制作 ext4 根文件系统镜像
- `all`：构建双架构内核 + 镜像
- `clean`：清理构建产物

当前环境中已具备所有必要的工具链（RISC-V 交叉工具链、LoongArch 交叉工具链、QEMU、CMake、Make 等）。

### 六、系统调用概览

从 `include/sys/syscall.h` 统计，该系统约定义了 **90+ 个系统调用**，覆盖：

- **进程**：`fork`、`exit`、`wait`、`execve`、`clone`、`getpid`、`getppid` 等
- **文件**：`openat`、`read`、`write`、`close`、`mkdirat`、`unlinkat`、`getdents64`、`fstat`、`statx`、`chdir`、`getcwd`、`fcntl`、`ioctl`、`sendfile`、`copy_file_range` 等
- **内存**：`brk`、`mmap`、`munmap`、`mprotect`、`mremap`、`madvise` 等
- **信号**：`rt_sigaction`、`rt_sigprocmask`、`rt_sigtimedwait`、`rt_sigreturn`、`kill`、`tkill`、`tgkill` 等
- **同步**：`futex`、`sched_yield`
- **网络**：`socket`
- **其他**：`times`、`uname`、`gettimeofday`、`nanosleep`、`syslog`、`sysinfo`、`shutdown` 等

### 七、整体架构判断

该项目的整体架构参考了 **xv6** 的设计风格（从 proc、trapframe、spinlock、sleeplock、file、inode 等概念可以看出明显的 xv6 血统），但在以下方面做了大量扩展：

1. **双架构支持**：同时支持 RISC-V 和 LoongArch；
2. **完整的 ext4 文件系统**：通过集成 lwext4 库实现了 ext4 读写支持；
3. **丰富的系统调用**：远超 xv6 的基础集合，达到可运行 busybox 的程度（定义了约 90+ 个系统调用）；
4. **信号机制**：支持完整的 POSIX 信号（sigaction, sigprocmask, sigreturn 等）；
5. **Socket 支持**：`kernel/proc/socket.c` 约 20KB 的实现；
6. **内存管理增强**：引入伙伴分配器 + slab 分配器，替代 xv6 的简单空闲链表；
7. **VFS 抽象层**：为多文件系统支持设计了 VFS 接口层。