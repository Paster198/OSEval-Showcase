## 项目初步调查结果

### 一、文件组织结构

该项目是基于 xv6-riscv 魔改的 OS 内核，根目录结构如下：

```
/
├── kernel/                    # 内核源码（主体）
│   ├── *.c, *.h              # 内核核心模块（约40个C文件）
│   ├── arch/                  # 硬件抽象层（HAL）
│   │   ├── riscv/            #   RISC-V 架构（7个文件：汇编+链接脚本+C）
│   │   └── loongarch/        #   LoongArch 架构（13个文件：汇编+链接脚本+C）
│   ├── mm/                    # 内存管理（mm.c, vma.c）
│   ├── vfs/                   # VFS 虚拟文件系统层（vfs.c, vfs.h）
│   ├── fs-ext4/               # ext4 文件系统移植层（含 lwext4 库源码）
│   │   └── lwext4/           #   lwext4 第三方库（include/ + src/）
│   ├── net/                   # 网络 socket 层 + lwIP 适配（4个C文件）
│   ├── lwip/                  # lwIP 协议栈源码（完整第三方库，331个C/H文件）
│   └── include/              # 内核通用数据结构（llist, rbtree）
├── user/                      # 用户态程序（约20个C程序+链接脚本）
├── mkfs/                      # 文件系统镜像构建工具（mkfs.c）
├── docs/                      # 内核文档（12章MD文档）
├── test-results/              # 本地测试结果
├── test_filter                # 测试过滤器配置
├── Makefile                   # 顶层构建脚本（339行）
├── .gitlab-ci.yml             # CI 配置
└── README.md                  # 项目说明
```

### 二、子系统划分

该项目实现了 **8 个子系统**，各子系统与目录/文件的对应关系如下：

| 子系统 | 对应目录/文件 | 说明 |
|--------|--------------|------|
| **HAL 硬件抽象层** | `kernel/arch/riscv/`, `kernel/arch/loongarch/` | 双架构支持：引导(start)、异常入口(entry)、内核向量(kernelvec)、上下文切换(swtch)、页表切换(trampoline)、PLIC中断控制器、virtio磁盘驱动。LoongArch 额外包含 TLB 重填(tlbrefill)、PCI 枚举、virtio PCI 传输层。 |
| **系统调用层** | `kernel/syscall.c`, `kernel/syscall.h`, `kernel/sysproc.c`, `kernel/sysfile.c`, `kernel/sysnet.c` | Linux 5.10 ABI 兼容，定义约128个系统调用号，分发至各处理函数。 |
| **进程管理** | `kernel/proc.c`, `kernel/proc.h`, `kernel/exec.c`, `kernel/trap.c` | 进程生命周期管理（fork/clone/exec/exit/wait4）、调度器、trap 处理。 |
| **内存管理** | `kernel/buddy.c`, `kernel/buddy.h`, `kernel/slab.c`, `kernel/slab.h`, `kernel/vm.c`, `kernel/vm.h`, `kernel/mm/mm.c`, `kernel/mm/vma.c`, `kernel/page.h` | 三层架构：伙伴系统（物理页分配）、slab 分配器（内核对象）、VMA（用户地址空间管理 + 按需换页）。 |
| **文件系统** | `kernel/vfs/vfs.c`, `kernel/vfs/vfs.h`, `kernel/xv6_fs.c`, `kernel/xv6_fs.h`, `kernel/bio.c`, `kernel/log.c`, `kernel/file.c`, `kernel/pipe.c`, `kernel/fs-ext4/`（含 lwext4 库） | 双文件系统+统一VFS：xv6 原生 FS 挂载于 `/`，lwext4 ext4 FS 挂载于 `/ext4`，块缓存层(bio)和日志(log)为 xv6 FS 服务。 |
| **信号处理** | `kernel/signal.c`, `kernel/signal.h` | 支持 Linux 兼容信号机制（rt_sigaction, rt_sigprocmask, kill/tkill/tgkill, rt_sigreturn 等）。 |
| **同步机制** | `kernel/spinlock.c`, `kernel/spinlock.h`, `kernel/sleeplock.c`, `kernel/sleeplock.h`, `kernel/futex.c`, `kernel/futex.h`, `kernel/shm.c`, `kernel/shm.h` | 三层同步：spinlock（短临界区）、sleeplock（长临界区）、futex（用户空间锁争用）。另含 System V 共享内存。 |
| **网络支持** | `kernel/net/socket.c`, `kernel/net/loopback.c`, `kernel/net/lwip_arch.c`, `kernel/lwip/`（完整 lwIP 协议栈） | socket 层向上提供 Linux 兼容的 socket API（socket/bind/listen/accept/connect/sendto/recvfrom 等），向下对接 lwIP TCP/IP 协议栈。 |

### 三、构建工具需求

从 `Makefile` 分析，构建该项目需要以下工具：

| 工具 | 用途 |
|------|------|
| **RISC-V 交叉编译工具链** (`riscv64-buildroot-linux-musl-` 或其 GNU 变体) | 编译 RISC-V 内核和用户程序 |
| **LoongArch 交叉编译工具链** (`loongarch64-linux-gnu-`) | 编译 LoongArch 内核和用户程序 |
| **GNU Make** | 构建自动化 |
| **perl** | 生成用户态系统调用桩代码 (`usys.pl`) |
| **主机 gcc** | 编译 `mkfs/mkfs` 工具（在主机上运行） |
| **Docker**（推荐方式） | README 中指定使用 `zhouzhouyi/os-contest:20260510` 镜像 |

关键构建产物：
- `kernel-rv`：RISC-V 内核 ELF 二进制
- `kernel-la`：LoongArch 内核 ELF 二进制
- `disk.img`：多架构磁盘镜像（同时包含 RISC-V 和 LoongArch 用户程序二进制）

构建流程为"先编译 RISC-V 内核 -> 清理共享对象 -> 编译 LoongArch 内核 -> 分别编译两架构用户程序 -> 打包成统一 disk.img"。

### 四、初步判断

1. **代码规模**：内核部分（不含 lwIP 第三方库）约 18,000 行 C/汇编代码；lwIP 协议栈约 33,000 行；用户态程序约 2,500 行。总计约 18.4 万行（含 lwIP 的 331 个文件）。

2. **架构特征**：采用"教学内核（xv6）骨架 + 大量 Linux ABI 兼容层"的策略。保留了 xv6 的进程调度、自旋锁、块缓存等核心机制，在此基础上引入了 VMA 内存管理、VFS 虚拟文件系统、ext4 支持、信号机制、futex 和网络协议栈。

3. **第三方代码依赖**：集成了 lwext4（ext4 文件系统库）和 lwIP（TCP/IP 协议栈）两个主要的外部库，均位于 `kernel/fs-ext4/lwext4/` 和 `kernel/lwip/` 目录下。