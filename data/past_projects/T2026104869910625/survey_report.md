# S-OS (SuperOS) 项目初步分析报告

## 一、项目概况

S-OS (SuperOS) 是一个面向全国大学生计算机系统能力大赛 OS 赛道的宏内核操作系统项目，队伍编号 T2026104869910625，来自武汉大学。项目基于 xv6 源码和 oskernel2025 智核速启队编写，采用 C 语言实现，支持 **RISC-V 64** 和 **LoongArch 64** 双指令集架构。

**代码规模概览：**
- C 源文件：65 个（总约 37,853 行有效代码）
- 汇编源文件（.S）：12 个
- 头文件：83 个（总约 9,702 行）
- 文档：`docx/` 目录下约 11 个 Markdown 文档

---

## 二、项目文件组织结构

```
.
├── Makefile                  # 顶层构建入口，双架构编译
├── README.md                 # 项目说明与运行方法
├── LICENSE                   # 许可证
├── .gitignore
│
├── include/                  # 头文件目录（83个）
│   ├── kernel/               #   内核通用头文件（~33个）
│   │   └── fs/               #     文件系统头文件（~28个，EXT4为主）
│   ├── hal/                  #   HAL层头文件
│   │   ├── riscv/            #     RISC-V架构头文件（2个）
│   │   └── loongarch/        #     LoongArch架构头文件（2个）
│   └── hsai/                 #   HSAI层头文件（5个）
│
├── kernel/                   # 内核核心源码
│   ├── sos_start_kernel.c    #   内核入口（初始化→调度器）
│   ├── process.c             #   进程管理（~1419行）
│   ├── thread.c              #   线程管理（~58行）
│   ├── syscall.c             #   系统调用实现（~4605行）
│   ├── exec.c                #   ELF加载器（~795行）
│   ├── vmem.c                #   虚拟内存管理（~754行）
│   ├── pmem.c                #   物理内存Buddy分配器（~1087行）
│   ├── vma.c                 #   VMA管理（~777行）
│   ├── slab_common.c         #   SLAB小对象分配器（~353行）
│   ├── spinlock.c            #   自旋锁（~125行）
│   ├── sleeplock.c           #   睡眠锁（~58行）
│   ├── timer.c               #   定时器（~315行）
│   ├── signal.c              #   信号处理（~59行）
│   ├── futex.c               #   快速用户态互斥量（~145行）
│   ├── socket.c              #   Socket接口（~88行）
│   ├── console.c             #   控制台（~225行）
│   ├── string.c              #   字符串操作（~169行）
│   ├── figlet.c              #   ASCII艺术字（~1123行）
│   ├── test.c                #   内核测试（~916行）
│   ├── cpu.c                 #   CPU管理（~46行）
│   ├── driver/               #   设备驱动
│   │   ├── riscv/virt.c      #     RISC-V VirtIO MMIO块设备（~317行）
│   │   └── loongarch/        #     LoongArch驱动
│   │       ├── virtio_disk.c #       VirtIO块设备PCI（~590行）
│   │       ├── virtio_pci.c  #       VirtIO-PCI传输层（~289行）
│   │       └── pci.c         #       PCI总线枚举（~142行）
│   └── fs/                   # 文件系统（28个C文件）
│       ├── ext4.c            #     EXT4总控（~3056行）
│       ├── ext4_journal.c    #     JBD2日志（~1908行）
│       ├── ext4_extent.c     #     Extent树（~1885行）
│       ├── ext4_fs.c         #     文件系统注册（~1639行）
│       ├── ext4_xattr.c      #     扩展属性（~1430行）
│       ├── ext4_dir_idx.c    #     HTree目录索引（~1294行）
│       ├── vfs_ext4.c        #     VFS EXT4接口（~1306行）
│       ├── file.c            #     文件对象操作（~1098行）
│       ├── ext4_mkfs.c       #     文件系统创建（~774行）
│       ├── ext4_dir.c        #     目录操作（~662行）
│       ├── ... (其余17个EXT4相关模块)
│       ├── pipe.c            #     匿名管道（~180行）
│       ├── inode.c           #     Inode管理（~483行）
│       ├── fs.c              #     文件系统注册（~273行）
│       ├── bio.c / blockdev.c / ext4_bcache.c / ext4_blockdev.c  # 块设备与缓存
│       ├── list.c / qsort.c  #     工具
│       └── vfs_vfat.c        #     VFAT兼容层（~122行）
│
├── hal/                      # 硬件抽象层（架构相关汇编 + UART）
│   ├── riscv/                # RISC-V（8个文件）
│   │   ├── entry.S           #   内核入口
│   │   ├── start.c           #   机器模式启动
│   │   ├── switch.S          #   上下文切换
│   │   ├── trampoline.S      #   用户态↔内核态蹦床
│   │   ├── kernelvec.S       #   内核态异常向量
│   │   ├── sbi.c             #   OpenSBI接口封装
│   │   ├── uart.c            #   NS16550 UART驱动
│   │   └── ld.script / sbi_ld.script  # 链接脚本
│   └── loongarch/            # LoongArch（8个文件）
│       ├── entry.S           #   内核入口
│       ├── kernelvec.S       #   内核态异常向量
│       ├── merrvec.S         #   机器错误异常向量
│       ├── swtch.S           #   上下文切换
│       ├── tlbrefill.S       #   TLB缺失重填
│       ├── trampoline.S      #   用户态↔内核态蹦床
│       ├── uart.c            #   LoongArch UART驱动
│       └── ld.script         #   链接脚本
│
├── hsai/                     # 硬件服务抽象接口层（4个文件）
│   ├── hsai_trap.c           #   Trap分发（usertrap/kerneltrap/devintr）
│   ├── hsai_mem.c            #   内存硬件配置（页表激活、TLB flush、DMW）
│   ├── plic.c                #   PLIC中断控制器（RISC-V）
│   └── print.c               #   内核打印（printf等）
│
├── user/                     # 用户态initcode入口程序
│   ├── include/              #   用户态头文件
│   ├── riscv/                #   RISC-V initcode
│   │   ├── user.c            #     用户入口（~2208行，含测试用例）
│   │   ├── usys.S            #     系统调用跳板
│   │   └── user_initcode.ld  #     链接脚本
│   └── loongarch/            #   LoongArch initcode
│       ├── user.c            #     用户入口（~1970行）
│       ├── usys.S            #     系统调用跳板
│       └── user_initcode.ld  #     链接脚本
│
├── docx/                     # 项目文档
│   ├── 总体设计.md
│   ├── 代码目录说明.md
│   ├── 开发进展记录.md
│   ├── AI使用说明.md
│   ├── design/               #   设计文档
│   │   ├── 架构与Trap.md
│   │   ├── 内存管理.md
│   │   ├── 任务与调度.md
│   │   ├── 系统调用与用户态.md
│   │   ├── 文件系统与加载器.md
│   │   └── 驱动管理.md
│   └── components/           #   组件文档
│       ├── 同步原语.md
│       └── 用户程序.md
│
├── image/                    # 图片资源（logo.png）
└── 初赛提交/                 # 初赛提交材料（PPT + 文档）
```

---

## 三、子系统划分

基于目录结构和文件内容，该系统可划分为以下 **7 个核心子系统**：

### 3.1 架构适配层 (HAL — `hal/`)

以汇编为主的架构相关代码，为 RISC-V64 和 LoongArch64 各提供一套实现。职责包括：
- 内核启动入口与栈设置
- 用户态/内核态切换蹦床（trampoline）
- 内核态异常/中断向量与分发
- 上下文切换（switch/swtch）
- TLB 重填处理（LoongArch 特有）
- UART 串口驱动（各架构独立实现）
- 链接脚本

### 3.2 硬件服务抽象接口层 (HSAI — `hsai/`)

介于 HAL 和内核核心之间的硬件服务层，封装平台无关接口：
- **Trap 分发**：`hsai_trap.c` 负责 usertrap/kerneltrap/devintr 的分发逻辑
- **内存硬件配置**：`hsai_mem.c` 负责页表激活、TLB flush、DMW 配置等
- **PLIC 中断控制器**：`plic.c`（RISC-V 平台）
- **内核打印**：`print.c` 提供 printf 等格式化输出

### 3.3 进程与线程管理子系统 (`kernel/process.c`, `kernel/thread.c`, `kernel/exec.c`, `kernel/signal.c`)

- **进程管理**：进程池（NPROC=256）、进程创建（fork/clone）、ELF 加载（exec）、进程退出（exit）、等待（wait）、调度器
- **线程管理**：线程池管理，轻量级线程分配
- **ELF 加载器**：支持动态链接器加载（glibc + musl，双架构）、shebang 脚本、argv/envp/auxv 栈构造
- **信号处理**：信号发送（kill）、sigaction 等

### 3.4 内存管理子系统 (`kernel/pmem.c`, `kernel/vmem.c`, `kernel/vma.c`, `kernel/slab_common.c`)

- **物理内存**：Buddy System 物理页分配器
- **虚拟内存**：多级页表遍历/映射/解映射、用户空间分配（uvmalloc）、copyin/copyout
- **VMA**：虚拟内存区域管理，支持用户栈/堆增长
- **SLAB 分配器**：内核小对象分配

### 3.5 文件系统子系统 (`kernel/fs/`)

内核中规模最大的子系统（28 个源文件，合计约 18,000+ 行）：
- **EXT4 原生实现**：完整的读写支持，包括 Extent 树、HTree 目录索引、JBD2 日志、块分配器、Inode 分配器、超级块、扩展属性、CRC32 校验、MBR 分区表、mkfs 等
- **VFS 层**：文件对象（file.c）、Inode 管理（inode.c）、文件系统注册与查找（fs.c）
- **VFAT 兼容层**：`vfs_vfat.c`
- **管道**：`pipe.c` 匿名管道
- **块设备抽象**：`blockdev.c`、`bio.c`（块 I/O 缓冲区）、`ext4_bcache.c`（块缓存）

### 3.6 设备驱动子系统 (`kernel/driver/`)

- **RISC-V**：VirtIO MMIO 块设备驱动
- **LoongArch**：VirtIO 块设备 PCI 驱动（含 PCI 总线枚举、VirtIO-PCI 传输层）

### 3.7 系统调用子系统 (`kernel/syscall.c`)

规模最大的单文件（~4605 行），实现 50+ 系统调用，覆盖：
- 进程类（fork, clone, execve, exit, wait4, getpid 等）
- 文件类（open, read, write, close, lseek, stat, getdents 等）
- 内存类（mmap, munmap, brk 等）
- 时间类（gettimeofday, nanosleep, clock_gettime 等）
- 信号类（kill, sigaction, sigprocmask, sigreturn 等）
- 事件类（epoll, eventfd, timerfd）
- Socket 类
- Futex、membarrier 等

### 3.8 同步原语与基础设施

- **自旋锁**：`kernel/spinlock.c`（push_off/pop_off + 原子指令）
- **睡眠锁**：`kernel/sleeplock.c`
- **Futex**：`kernel/futex.c`

### 3.9 其他辅助模块

- **定时器**：`kernel/timer.c`
- **控制台**：`kernel/console.c`
- **Socket**：`kernel/socket.c`
- **字符串**：`kernel/string.c`
- **内核测试**：`kernel/test.c`
- **ASCII 艺术字**：`kernel/figlet.c`

---

## 四、构建工具需求

根据 Makefile 分析，编译构建该项目的工具链需求如下：

### 4.1 LoongArch 64 构建路径

| 工具 | 用途 |
|------|------|
| `loongarch64-linux-gnu-gcc` | C 编译器 + 汇编器 |
| `loongarch64-linux-gnu-ld` | 链接器 |
| `loongarch64-linux-gnu-objcopy` | 二进制提取 |
| `loongarch64-linux-gnu-objdump` | 反汇编 |
| `loongarch64-linux-gnu-ar` | 静态库归档 |
| GNU Make | 构建控制 |
| Python 3 | initcode 头文件生成 |

### 4.2 RISC-V 64 构建路径

| 工具 | 用途 |
|------|------|
| `riscv64-linux-gnu-gcc` | C 编译器 + 汇编器 |
| `riscv64-linux-gnu-ld` | 链接器 |
| `riscv64-linux-gnu-objcopy` | 二进制提取 |
| `riscv64-linux-gnu-objdump` | 反汇编 |
| GNU Make | 构建控制 |
| Python 3 | initcode 头文件生成 |

### 4.3 运行环境

- **LoongArch**：`qemu-system-loongarch64`，搭配 VirtIO-blk PCI 和 VirtIO-net PCI 设备
- **RISC-V**：`qemu-system-riscv64`，搭配 OpenSBI（default bios）、VirtIO-blk MMIO 和 VirtIO-net 设备
- 官方 Docker 镜像：`zhouzhouyi/os-contest:20260510`

---

## 五、初步判断

1. **双架构设计**：该项目在架构适配层（HAL）为 RISC-V64 和 LoongArch64 各维护一套代码，HSAI 层和内核核心层代码大部分共享。两套架构使用不同的交叉编译工具链和不同的 QEMU 参数启动。

2. **宏内核架构**：所有子系统（进程管理、内存管理、文件系统、设备驱动、网络）均在内核态运行，符合宏内核特征。

3. **EXT4 文件系统是核心亮点**：`kernel/fs/` 子目录下有 28 个源文件实现了较完整的 EXT4 读写支持，代码量约占整个内核的半数。

4. **系统调用兼容 Linux ABI**：`syscall.c` 文件近 5000 行，覆盖 Linux 常见系统调用类别，采用双架构各自体系的系统调用号。

5. **构建系统基于 GNU Make**：顶层 Makefile 协调子目录的递归构建，通过 `TEST_PROFILE` 变量控制测试配置。构建产物为 `kernel-la` 和 `kernel-rv` 两个内核二进制文件。

6. **用户态最小运行时**：`user/` 目录仅包含 initcode 入口程序，不包含完整的用户态 C 库；用户程序（如 busybox、LTP 测试）通过磁盘镜像提供。