# SC7 操作系统内核项目 -- 初步调查报告

## 一、项目概况

SC7（SmartCore7）是武汉大学团队基于 MIT XV6 操作系统开发的教学用操作系统内核，使用 C 语言编写，同时支持 **RISC-V 64** 和 **LoongArch 64** 双架构。项目参加 OS 内核比赛，包含初赛、决赛一阶段、决赛现场赛等多个阶段的迭代。

## 二、仓库文件组织结构

```
.
├── Makefile                  # 顶层构建文件，管理双架构编译与QEMU启动
├── README.md                 # 项目说明与工具链指南
├── LICENSE
├── hal/                      # 硬件抽象层 (Hardware Abstraction Layer)
│   ├── loongarch/            #   LoongArch 架构相关（汇编入口、上下文切换、trap向量、UART、链接脚本等）
│   └── riscv/                #   RISC-V 架构相关（汇编入口、SBI接口、上下文切换、trap向量、UART、链接脚本等）
├── hsai/                     # 硬件抽象服务层 (Hardware Service Abstraction Interface)
│   ├── hsai_trap.c           #   trap/异常处理（架构无关部分）
│   ├── hsai_mem.c            #   内存管理服务
│   ├── hsai_service.c        #   通用服务
│   ├── plic.c                #   PLIC中断控制器
│   ├── print.c               #   内核打印
│   └── timer.c               #   定时器管理
├── kernel/                   # 内核核心
│   ├── SC7_start_kernel.c    #   内核启动入口
│   ├── process.c             #   进程管理
│   ├── thread.c              #   线程管理
│   ├── exec.c                #   程序加载执行
│   ├── syscall.c             #   系统调用实现（最大文件，10479行）
│   ├── vma.c                 #   虚拟内存区域管理
│   ├── vmem.c                #   虚拟内存管理
│   ├── pmem.c                #   物理内存管理
│   ├── signal.c              #   信号机制
│   ├── futex.c               #   Futex 同步
│   ├── socket.c              #   Socket 接口
│   ├── namespace.c           #   命名空间
│   ├── procfs.c              #   proc 文件系统
│   ├── slab_common.c         #   Slab 分配器
│   ├── spinlock.c            #   自旋锁
│   ├── sleeplock.c           #   睡眠锁
│   ├── string.c              #   字符串工具函数
│   ├── console.c             #   控制台
│   ├── cpu.c                 #   CPU 管理
│   ├── loop.c                #   Loop 设备
│   ├── figlet.c              #   ASCII 艺术字
│   ├── test.c                #   测试代码
│   ├── fs/                   #   文件系统子系统
│   │   ├── ext4*.c           #     ext4 文件系统实现（基于 lwext4 改进，约20个文件）
│   │   ├── vfs_ext4.c        #     VFS 到 ext4 的适配层
│   │   ├── vfs_vfat.c        #     VFS 到 VFAT 的适配层
│   │   ├── fs.c              #     VFS 通用层
│   │   ├── file.c            #     文件操作
│   │   ├── inode.c           #     inode 管理
│   │   ├── bio.c             #     块 I/O
│   │   ├── blockdev.c        #     块设备
│   │   ├── pipe.c            #     管道
│   │   ├── fifo.c            #     FIFO
│   │   └── list.c / qsort.c  #     数据结构工具
│   └── driver/               #   设备驱动
│       ├── loongarch/        #     LoongArch 驱动（PCI、VirtIO 磁盘、VirtIO PCI）
│       └── riscv/            #     RISC-V 驱动（virt 平台设备）
├── include/                  # 头文件
│   ├── hal/                  #   HAL 层头文件（loongarch/riscv 各一套）
│   ├── hsai/                 #   HSAI 层头文件
│   └── kernel/               #   内核头文件（含 fs/ 子目录）
├── user/                     # 用户空间程序
│   ├── include/              #   用户库头文件
│   ├── loongarch/            #   LoongArch 用户程序（initcode、系统调用封装）
│   └── riscv/                #   RISC-V 用户程序（initcode、系统调用封装）
├── doc/                      # 文档（设计文档PDF、开发日志、各子系统说明）
├── tmp/                      # 临时文件与测试用例（busybox、hello.elf 等）
└── *.sh                      # 辅助脚本（代码行数统计、反汇编、QEMU调试）
```

## 三、子系统划分

根据代码结构与文件内容，该项目实现了以下子系统：

| 子系统 | 主要代码位置 | 代码行数（约） | 说明 |
|--------|-------------|---------------|------|
| **系统调用** | `kernel/syscall.c` | 10,479 | 最大的单文件，实现 POSIX 系统调用接口 |
| **进程管理** | `kernel/process.c`, `kernel/exec.c` | 3,167 | 进程创建/销毁/调度/ELF加载 |
| **线程管理** | `kernel/thread.c` | 189 | 多线程支持 |
| **虚拟内存** | `kernel/vma.c`, `kernel/vmem.c` | 2,915 | VMA 管理与页表管理 |
| **物理内存** | `kernel/pmem.c`, `kernel/slab_common.c` | 1,586 | 伙伴系统 + Slab 分配器 |
| **文件系统(ext4)** | `kernel/fs/ext4*.c` | ~16,000 | 基于 lwext4 改进的 ext4 实现 |
| **VFS 层** | `kernel/fs/fs.c`, `vfs_ext4.c`, `vfs_vfat.c`, `file.c`, `inode.c` | ~4,000 | 虚拟文件系统抽象层 |
| **块 I/O 与设备** | `kernel/fs/bio.c`, `blockdev.c` | 528 | 块设备 I/O |
| **管道与 FIFO** | `kernel/fs/pipe.c`, `fifo.c` | 594 | IPC 管道 |
| **信号机制** | `kernel/signal.c` | 983 | POSIX 信号 |
| **Futex** | `kernel/futex.c` | 357 | 快速用户态互斥 |
| **Socket** | `kernel/socket.c` | 85 | Socket 接口（初步实现） |
| **设备驱动** | `kernel/driver/` | ~1,375 | VirtIO 磁盘/PCI/串口 |
| **HAL 层** | `hal/loongarch/`, `hal/riscv/` | ~1,500 | 架构相关的汇编与底层代码 |
| **HSAI 层** | `hsai/` | ~2,696 | 架构无关的 trap/定时器/中断/打印服务 |
| **用户空间** | `user/` | ~4,892 | initcode、用户库、系统调用封装 |
| **其它** | `kernel/console.c`, `cpu.c`, `namespace.c`, `procfs.c`, `loop.c` 等 | ~2,500 | 控制台、CPU、命名空间、procfs、loop 设备 |

**项目总代码量：约 56,662 行**（含汇编与用户空间）。

## 四、构建工具链需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| `loongarch64-linux-gnu-gcc` (GCC 13.x) | LoongArch 交叉编译 | 可用 |
| `riscv64-linux-gnu-gcc` (GCC 13.x) | RISC-V 交叉编译 | 可用 |
| `loongarch64-linux-gnu-ld` | LoongArch 链接 | 可用 |
| `riscv64-linux-gnu-ld` | RISC-V 链接 | 可用 |
| `qemu-system-loongarch64` (9.x) | LoongArch 模拟运行 | 可用 |
| `qemu-system-riscv64` (9.x) | RISC-V 模拟运行 | 可用 |
| `make` (GNU Make) | 构建系统 | 可用 |
| `gdb` (交叉架构) | 调试 | 可用 |
| `objcopy` / `objdump` (交叉架构) | 二进制工具 | 可用 |

构建系统使用 **GNU Make**，顶层 Makefile 通过递归调用子目录 Makefile（`hal/`, `kernel/`, `hsai/`, `user/`）完成编译，最终由链接器使用架构特定的链接脚本（`hal/*/ld.script`）生成内核镜像。RISC-V 架构使用 OpenSBI 作为固件引导。