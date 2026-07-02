## OS 内核项目初步调查报告

### 一、项目概要

该项目是一个基于 **xv6**（MIT 6.1810 教学操作系统）的 RISC-V 多处理器操作系统内核，采用 ANSI C 编写。仓库根目录位于 `/mnt/c/Users/horbs/Desktop/OS_review_agent/OSEval_Small/workspace/T2026102599911006/repo`。项目在原始 xv6 的基础上做了若干扩展，包括 EXT4 只读文件系统驱动和 Linux 兼容系统调用层。

---

### 二、仓库文件组织结构

```
repo/
├── .clang-format              # 代码格式化配置
├── .dir-locals.el             # Emacs 目录局部变量
├── .editorconfig              # 编辑器配置
├── .gdbinit.tmpl-riscv        # GDB 初始化模板（RISC-V）
├── .gitignore
├── LICENSE
├── Makefile                   # 顶层构建入口
├── README                     # 项目说明（原始xv6 README）
├── Riscv输出.txt              # QEMU启动日志（有ROM重叠警告）
├── test-xv6.py                # Python自动化测试脚本
│
├── kernel/                    # 内核源码（.c, .h, .S, .ld）
│   ├── main.c                 # 内核入口，初始化所有子系统
│   ├── entry.S                # 内核入口汇编（跳转到start/0x80200000）
│   ├── start.c                # 早期启动（机器模式 -> 监管模式）
│   ├── kernel.ld              # 链接脚本
│   ├── kernelvec.S            # 内核态Trap向量
│   ├── trampoline.S           # 用户/内核态切换跳板
│   ├── swtch.S                # 上下文切换汇编
│   ├── riscv.h                # RISC-V CSR相关内联函数与宏
│   ├── defs.h                 # 全局函数声明汇总
│   ├── types.h                # 基本类型定义
│   ├── param.h                # 系统参数常量（NPROC=64等）
│   ├── memlayout.h            # 物理/虚拟内存布局定义
│   ├── elf.h                  # ELF格式定义
│   ├── fcntl.h                # 文件控制常量
│   ├── stat.h                 # stat结构体
│   ├── proc.h / proc.c        # 进程管理
│   ├── vm.h / vm.c            # 虚拟内存管理（页表）
│   ├── kalloc.c               # 物理页分配器
│   ├── spinlock.h / spinlock.c # 自旋锁
│   ├── sleeplock.h / sleeplock.c # 睡眠锁
│   ├── bio.c / buf.h          # 块缓冲区缓存
│   ├── fs.h / fs.c            # xv6原生文件系统（inode层）
│   ├── file.h / file.c        # 文件描述符层
│   ├── log.c                  # 日志层（文件系统崩溃一致性）
│   ├── pipe.c                 # 管道
│   ├── exec.c                 # exec系统调用实现
│   ├── syscall.h / syscall.c  # 原生系统调用分发
│   ├── sysproc.c              # 进程相关系统调用
│   ├── sysfile.c              # 文件系统相关系统调用
│   ├── linux_syscalls.h       # Linux兼容syscall层
│   ├── linux_syscalls.c       # Linux兼容syscall dispatch（二分查找表）
│   ├── ext4.h / ext4.c        # EXT4只读文件系统驱动
│   ├── ext4_disk.c            # EXT4磁盘块读取（独立virtio设备）
│   ├── virtio.h / virtio_disk.c # virtio块设备驱动
│   ├── trap.c                 # Trap处理
│   ├── plic.c                 # PLIC中断控制器
│   ├── uart.c                 # UART串口驱动
│   ├── console.c              # 控制台输入输出
│   ├── printf.c               # 格式化输出
│   └── string.c               # 字符串/内存工具函数
│
├── user/                      # 用户程序
│   ├── user.h                 # 用户态系统调用与库函数声明
│   ├── user.ld                # 用户程序链接脚本
│   ├── usys.pl                # Perl脚本生成syscall桩代码(usys.S)
│   ├── ulib.c                 # 用户态C库函数
│   ├── umalloc.c              # 用户态malloc/free
│   ├── printf.c               # 用户态printf
│   ├── init.c                 # 第一个用户进程（sh启动）
│   ├── sh.c                   # Shell
│   ├── usertests.c            # 大量用户态测试（3265行）
│   ├── grind.c                # 压力测试
│   ├── logstress.c            # 日志压力测试
│   ├── forktest.c             # fork压力测试
│   ├── stressfs.c             # 文件系统压力测试
│   └── (cat, echo, grep, ls, mkdir, rm, wc, kill, ln, ...)
│
└── mkfs/                      # 文件系统镜像制作工具
    └── mkfs.c                 # 创建xv6文件系统镜像（运行于主机）
```

---

### 三、子系统划分

| 子系统 | 主要文件 | 说明 |
|--------|----------|------|
| **启动与初始化** | `entry.S`, `start.c`, `main.c`, `kernel.ld`, `kernelvec.S`, `trampoline.S` | 从机器模式进入监管模式，初始化各子系统，多核启动支持 |
| **进程管理** | `proc.c`, `proc.h`, `swtch.S` | 进程表、调度器、fork/exit/wait、上下文切换、CPU管理 |
| **虚拟内存管理** | `vm.c`, `vm.h`, `kalloc.c`, `memlayout.h` | 页表操作（walk/mappages/uvm系列）、物理页分配（kalloc/kfree）、按需调页（vmfault） |
| **同步原语** | `spinlock.c`, `spinlock.h`, `sleeplock.c`, `sleeplock.h` | 自旋锁（关中断）、睡眠锁（允许持有期间睡眠） |
| **Trap与中断** | `trap.c`, `plic.c`, `kernelvec.S`, `trampoline.S` | Trap初始化、用户/内核Trap处理、PLIC中断控制器驱动、时钟中断 |
| **文件系统（xv6原生）** | `fs.c`, `fs.h`, `bio.c`, `buf.h`, `log.c`, `file.c`, `file.h`, `pipe.c` | inode层、目录操作、块缓存、日志（write-ahead logging）、文件描述符层、管道 |
| **EXT4只读驱动（扩展）** | `ext4.c`, `ext4.h`, `ext4_disk.c` | 独立于xv6原生FS的第二文件系统，通过独立virtio块设备访问，支持只读操作 |
| **磁盘驱动** | `virtio_disk.c`, `virtio.h` | virtio-mmio块设备驱动，支持两个virtio磁盘（bus.0用于EXT4, bus.1用于xv6 FS） |
| **系统调用** | `syscall.c`, `syscall.h`, `sysproc.c`, `sysfile.c`, `linux_syscalls.c`, `linux_syscalls.h` | 原生xv6 syscall（fork/read/write等）+ Linux兼容层（l_read/l_write/l_clone等映射） |
| **设备驱动（串口/控制台）** | `uart.c`, `console.c`, `printf.c` | UART寄存器级驱动、控制台行缓冲、格式化输出 |
| **基础库** | `string.c`, `types.h`, `riscv.h`, `param.h`, `elf.h` | 字符串操作、RISC-V CSR操作、类型定义、系统参数 |
| **用户程序与测试** | `user/`目录下所有文件 | Shell、标准工具、测试套件（usertests/grind/logstress等） |
| **文件系统镜像制作** | `mkfs/mkfs.c` | 主机端工具，基于fs.h格式创建xv6文件系统镜像 |
| **自动化测试** | `test-xv6.py` | Python测试脚本，通过QEMU管道运行用户程序并验证输出 |

---

### 四、构建工具需求

根据 `Makefile` 分析，构建该项目需要以下工具：

| 工具类别 | 具体工具 | 用途 |
|----------|----------|------|
| **RISC-V交叉编译链** | `riscv64-unknown-elf-gcc`, `riscv64-unknown-elf-ld`, `riscv64-unknown-elf-objdump`, `riscv64-unknown-elf-objcopy`（或 `riscv64-linux-gnu-` 等前缀变体） | 编译内核和用户程序 |
| **主机C编译器** | `gcc` | 编译 `mkfs/mkfs.c`（在主机上运行） |
| **Perl** | `perl` | 运行 `user/usys.pl` 生成 syscall 汇编桩代码 |
| **QEMU** | `qemu-system-riscv64`（版本 >= 7.2） | RISC-V虚拟机，运行内核 |
| **GNU Make** | `make` | 构建系统 |
| **可选** | `clang-format` | 代码格式化（`make fmt`） |
| **可选** | `gdb` | 调试（`make qemu-gdb`） |

Makefile 通过自动检测 `TOOLPREFIX`（依次尝试 `riscv64-unknown-elf-`、`riscv64-elf-`、`riscv64-none-elf-`、`riscv64-linux-gnu-`、`riscv64-unknown-linux-gnu-`）来确定交叉编译工具链前缀。

关键构建目标：
- `make all` — 构建 `kernel-rv`, `kernel-la`, `disk.img`, `disk-rv.img`, `disk-la.img`
- `make qemu` — 构建内核 + 文件系统镜像，并在 QEMU 中运行
- `make fs.img` — 仅构建文件系统镜像（使用 `mkfs/mkfs` 打包用户程序）

---

### 五、初步观察要点

1. **这是一个基于xv6的扩展项目**：内核保留了xv6的经典结构（约12,800行代码），但新增了 EXT4 只读驱动和 Linux 兼容系统调用层。

2. **EXT4支持是独立子系统**：`ext4.c`/`ext4_disk.c` 使用独立的 virtio 块设备（bus.0），与 xv6 原生文件系统（bus.1）并行运行。ext4_disk_init 需要传入已占用的 MMIO 基地址以避免冲突。

3. **双系统调用接口**：除了 xv6 原生 syscall（约22个），还有 `linux_syscalls.c` 提供 Linux 系统调用号到 xv6 syscall 的映射（使用排序表+二分查找），支持 `read`、`write`、`openat`、`clone`、`execve` 等 Linux 风格的调用。

4. **Riscv输出.txt 中的 QEMU 命令行与实际 Makefile 不同**：该文件记录了使用 `kernel-rv`、`sdcard-rv.img`、virtio-net 等的启动命令，可能与比赛评测环境相关。

5. **用户程序测试丰富**：包含 `usertests.c`（3,265行）、`grind.c`（351行）、`logstress.c`、`forktest.c`、`forphan.c`、`dorphan.c`、`memcould.c` 等专门的压力和边界测试程序。