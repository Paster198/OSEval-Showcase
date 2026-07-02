# 项目初步调查结果

## 一、项目概况

- **项目名称**：BirdOS（参赛名称：OSKernel2026_mini）
- **队伍**：KernelTrap（中山大学）
- **基础**：基于 xv6-riscv 宏内核，目标架构仅支持 riscv64
- **基线仓库**：https://github.com/laojiahuo2003/bird-OS.git
- **规模**：内核约 10,028 行，用户态约 7,177 行，共 109 个源文件（.c/.h/.S/.ld/.pl）

## 二、目录组织与子系统划分

```
/
├── Makefile                    # 顶层构建脚本
├── README.md                   # 项目说明
├── .editorconfig / .gitignore  # 工程配置
├── .gdbinit.tmpl-riscv         # GDB 初始化模板
├── .vscode/                    # VSCode 配置
├── packets.pcap                # 网络抓包文件
│
├── kernel/                     # --- 内核源码 ---
│   ├── kernel.ld               # RISC-V 链接脚本（入口 0x80000000）
│   ├── main.c                  # 内核入口，初始化各子系统
│   ├── start.c                 # 启动阶段代码
│   ├── syscall.c               # 系统调用分发层
│   ├── sysproc.c               # 进程相关系统调用实现
│   ├── sysfile.c               # 文件相关系统调用实现
│   ├── sysnet.c                # 网络相关系统调用实现
│   │
│   ├── asm/                    # [汇编/上下文切换]
│   │   ├── entry.S             # 内核入口汇编
│   │   ├── swtch.S             # 上下文切换
│   │   ├── trampoline.S        # 内核/用户态跳板
│   │   └── kernelvec.S         # 内核态中断向量
│   │
│   ├── proc/                   # [进程管理子系统]
│   │   ├── proc.c              # 进程调度、创建、退出等（1073行，最大单文件）
│   │   ├── exec.c              # exec 系统调用实现
│   │   ├── pipe.c              # 管道通信
│   │   └── messagequeue.c      # System V 风格消息队列
│   │
│   ├── mm/                     # [内存管理子系统]
│   │   ├── vm.c                # 虚拟内存、页表、mmap、COW、懒分配
│   │   ├── kalloc.c            # 物理页面分配器
│   │   └── sharemem.c          # 共享内存实现
│   │
│   ├── filesystem/             # [文件系统子系统]
│   │   ├── fs.c                # 文件系统核心（inode、目录、路径解析）
│   │   ├── bio.c               # 块缓冲层（buffer cache）
│   │   ├── file.c              # 文件描述符管理层
│   │   └── log.c               # 日志（crash recovery）
│   │
│   ├── network/                # [网络子系统]
│   │   ├── net.c               # UDP/IP/ARP 协议栈
│   │   ├── e1000.c             # e1000 网卡驱动
│   │   └── pci.c               # PCI 总线枚举
│   │
│   ├── driver/                 # [设备驱动]
│   │   ├── console.c           # 控制台
│   │   ├── uart.c              # UART 串口驱动
│   │   ├── virtio_disk.c       # virtio 磁盘驱动
│   │   └── ramdisk.c           # RAM 磁盘
│   │
│   ├── interrupt/              # [中断子系统]
│   │   ├── trap.c              # 陷阱/中断处理
│   │   └── plic.c              # PLIC 平台级中断控制器
│   │
│   ├── lock/                   # [同步原语]
│   │   ├── spinlock.c          # 自旋锁
│   │   └── sleeplock.c         # 睡眠锁
│   │
│   ├── lib/                    # [内核工具库]
│   │   ├── printf.c            # 格式化输出
│   │   └── string.c            # 字符串/内存操作
│   │
│   └── include/                # [内核头文件]（21个）
│       ├── defs.h              # 全局函数声明
│       ├── proc.h / fs.h / memlayout.h / net.h / ... 等
│       └── 各数据结构定义（buf, file, inode, spinlock, sleeplock, stat, mbuf 等）
│
├── user/                       # --- 用户态程序 ---
│   ├── user.h                  # 用户库函数声明（53个系统调用封装）
│   ├── usys.pl                 # Perl 脚本生成系统调用跳板汇编
│   ├── program/                # 用户实用程序（约31个）
│   │   ├── init.c / sh.c       # init 进程 & shell
│   │   ├── cat / echo / grep / ls / wc / kill / sleep / ln / rm / mkdir 等标准工具
│   │   ├── initcode.S          # 第一个用户态进程加载器
│   │   ├── ulib.c / umalloc.c / printf.c / uthread.c  # 用户库
│   │   └── setp / trace / sysinfo / statistics / symlink / chmod / savei / recoveri 等
│   └── test/                   # 功能测试用例（约16个）
│       ├── usertests.c         # 综合测试（xv6 原有）
│       ├── cowtest.c / lazytest.c / mmaptest.c / sharemm.c  # 内存测试
│       ├── msgtest.c           # 消息队列测试
│       ├── nettest.c / server.py / ping.py  # 网络测试
│       ├── symlinktest.c / chmodtest.c / recoveritest.c / bigfiletest.c  # 文件系统测试
│       ├── alarmtest.c         # 定时提醒测试
│       ├── sh_rw_lock.c / sh_rw_nolock.c  # 读写锁/信号量测试
│       ├── kalloctest.c / bcachetest.c    # 锁粒度测试
│       └── forktest.c          # fork 压力测试
│
└── docs/                       # --- 文档 ---
    ├── README.md               # 项目概览
    ├── 开发日志.md
    ├── 添加系统调用说明.md
    ├── document/               # 各子系统设计文档
    │   ├── 进程管理.md
    │   ├── 内存管理.md
    │   ├── 文件系统.md
    │   ├── 系统调用.md
    │   └── 网络设备.md
    ├── draft/                  # 设计草稿
    └── img/                    # 架构图与测试截图
```

## 三、子系统总览

| 子系统 | 目录/文件 | 代码规模 | 职责 |
|--------|-----------|----------|------|
| **进程管理** | `kernel/proc/` | ~1,674 行 | 进程调度（动态优先级）、创建/退出、exec、管道、消息队列 |
| **内存管理** | `kernel/mm/` | ~1,071 行 | 物理页分配、虚拟内存、写时复制(COW)、懒分配、mmap、共享内存 |
| **文件系统** | `kernel/filesystem/` | ~1,379 行 | 混合索引（三级间接块）、buffer cache 细粒度锁、ACL 权限、文件恢复 |
| **网络子系统** | `kernel/network/` | ~592 行 | e1000 网卡驱动、PCI 枚举、UDP/IP/ARP 协议 |
| **中断/陷阱** | `kernel/interrupt/` | ~448 行 | 陷阱分发、PLIC 中断管理 |
| **设备驱动** | `kernel/driver/` | ~702 行 | UART 串口、virtio 磁盘、console、ramdisk |
| **同步原语** | `kernel/lock/` | ~171 行 | 自旋锁、睡眠锁 |
| **系统调用层** | `kernel/syscall.c` + `sysproc.c` + `sysfile.c` + `sysnet.c` | ~1,777 行 | 53 个系统调用分发与实现（xv6 原有 21 个 + 新增约 32 个） |
| **汇编/启动** | `kernel/asm/` + `start.c` | ~406 行 | 内核入口、上下文切换、trampoline、中断向量 |
| **工具库** | `kernel/lib/` | ~238 行 | printf、string 操作 |

## 四、构建工具需求

根据 Makefile 分析，构建本项目需要：

| 工具 | 用途 |
|------|------|
| `riscv64-unknown-elf-*` 或 `riscv64-linux-gnu-*` | RISC-V 交叉编译工具链（GCC、ld、objdump、objcopy） |
| `qemu-system-riscv64` | 模拟运行（QEMU ≥ 0.11，推荐 5.1.0） |
| `perl` | 生成 `usys.S`（系统调用用户态跳板） |
| `gcc`（主机） | 编译 `mkfs/mkfs.c`（文件系统镜像制作工具） |
| `python3` | 网络测试脚本（server.py、ping.py） |
| `make` | 构建自动化 |

QEMU 启动参数摘要：`-machine virt -bios none -m 128M -smp 3`，使用 virtio-blk 磁盘和 e1000 网卡，通过 `-netdev user` 提供用户态网络。

## 五、初步判断

1. **项目定位**：xv6-riscv 的增强版教学/竞赛内核，宏内核架构，单地址空间。
2. **成熟度**：代码量适中（内核约 1 万行），实现 53 个系统调用，覆盖进程、内存、文件系统、网络四大块，较原始 xv6（约 8,000 行内核，21 个系统调用）有明显扩充。
3. **新增亮点**：e1000 网络驱动与 UDP/IP 栈、消息队列与共享内存 IPC、写时复制/懒分配/mmap 现代内存特性、三级间接块文件索引、细粒度锁优化、信号量、内核线程等。
4. **文档完善**：提供了各子系统的中文设计文档和开发日志，测试用例较丰富。