## F7LY OS 项目初步调查报告

### 1. 项目概述

**F7LY OS** 是一款基于 Xv6 修改的教学用操作系统内核，支持 **RISC-V** 和 **LoongArch** 双架构。项目使用 C++ 作为主要开发语言（C++23 标准），辅以 C 和汇编语言。内核链接入口地址为 `0x80200000`（RISC-V）。

### 2. 仓库文件组织结构

```
.
├── Makefile                  # 顶层构建脚本，支持双架构编译
├── README.md                 # 项目说明
├── kernel/                   # 内核源代码（核心）
│   ├── boot/                 # 启动模块（riscv/loongarch 子目录）
│   ├── devs/                 # 设备驱动模块
│   ├── fs/                   # 文件系统模块
│   ├── hal/                  # 硬件抽象层
│   ├── libs/                 # 内核基础库
│   ├── link/                 # 链接脚本
│   ├── mem/                  # 内存管理模块
│   ├── net/                  # 网络协议栈模块
│   ├── proc/                 # 进程管理模块
│   ├── shm/                  # 共享内存模块
│   ├── sys/                  # 系统调用模块
│   ├── tm/                   # 时间管理模块
│   └── trap/                 # 中断与异常处理模块
├── user/                     # 用户态代码
│   ├── app/                  # 用户应用程序（initcode）
│   ├── deps/                 # 用户态依赖头文件
│   ├── syscall_lib/          # 系统调用封装库
│   └── user_lib/             # 用户态测试库
├── thirdparty/EASTL/         # 第三方库：EA STL（C++ 标准模板库）
├── busybox/                  # BusyBox 预编译二进制（riscv/loongarch）
├── docs/                     # 设计文档（PDF）
├── doc/                      # 其他文档
├── debug_*.gdb               # GDB 调试脚本
├── qemu-loongarch.sh         # LoongArch QEMU 启动脚本
├── test.sh                   # 测试脚本
└── mount-*.sh                # 文件系统镜像挂载脚本
```

### 3. 子系统分析

根据目录结构和源文件内容，该项目实现了以下子系统：

| 子系统 | 对应目录 | 主要文件数 | 说明 |
|--------|----------|-----------|------|
| **启动模块** | `kernel/boot/` | 7 | 从 Bootloader 跳转到内核 main，支持双架构启动流程 |
| **内存管理** | `kernel/mem/` | 9 | 物理内存管理（伙伴系统）、虚拟内存、页表、堆分配、Slab 分配器、信号 trampoline |
| **进程管理** | `kernel/proc/` | 10 | 进程创建/调度、信号机制、管道、Futex、POSIX 定时器、上下文切换 |
| **文件系统** | `kernel/fs/` | 38 | VFS 层、ext4（lwext4 移植）、FAT、ramfs、FIFO、管道文件、Socket 文件、目录项缓存 |
| **设备驱动** | `kernel/devs/` | 10 | UART、控制台、VirtIO 磁盘驱动、PCI 总线、Loop 设备、流设备 |
| **网络协议栈** | `kernel/net/` | 22 | 基于 onpstack 的完整 TCP/IP 栈：TCP、UDP、ICMP、ARP、Ethernet、BSD Socket API、VirtIO 网卡驱动 |
| **系统调用** | `kernel/sys/` | 1 | 系统调用分发与处理 |
| **中断/异常** | `kernel/trap/` | 11 | 中断向量表、PLIC（RISC-V）、APIC/EXTIOI（LoongArch）、内核态/用户态 trap 处理 |
| **硬件抽象层** | `kernel/hal/` | 2+ | CPU 操作封装、架构相关上下文切换 |
| **时间管理** | `kernel/tm/` | 2 | 定时器管理、时间接口 |
| **共享内存** | `kernel/shm/` | 1 | System V 风格共享内存管理 |
| **内核库** | `kernel/libs/` | 11 | 字符串操作、内存分配器、排序、信号量、C++ ABI 支持、打印输出 |

### 4. 架构支持情况

项目采用"通用代码 + 架构特定子目录"的组织方式。以下模块包含架构特定实现：

- `boot/` — riscv、loongarch 各有独立的 entry.S 和 main.cc
- `devs/` — 磁盘驱动和 PCI 有架构特定实现
- `hal/` — CPU 操作有架构特定实现
- `link/` — 各有独立的链接脚本 kernel.ld
- `mem/` — 页表管理和信号 trampoline 有架构特定实现
- `proc/` — 上下文切换汇编有架构特定实现
- `trap/` — 中断处理、内核/用户向量有架构特定实现

### 5. 构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| `riscv64-linux-gnu-gcc/g++` | RISC-V 交叉编译 | 可用 |
| `loongarch64-linux-gnu-gcc/g++` | LoongArch 交叉编译 | 可用 |
| `qemu-system-riscv64` | RISC-V 模拟运行 | 可用 |
| `qemu-system-loongarch64` | LoongArch 模拟运行 | 可用 |
| GNU Make | 构建系统 | 可用 |
| GNU ld / objcopy / objdump / size | 链接与二进制处理 | 可用 |
| GDB (multiarch) | 调试 | 可用 |
| OpenSBI (RISC-V SBI firmware) | RISC-V 启动固件（-bios default） | 可用 |
| EASTL (thirdparty) | C++ 标准模板库（静态编译为 libeastl.a） | 仓库内自带 |

### 6. 代码规模统计

- 内核源文件（.c/.cc/.cpp/.S/.s）：**134 个**
- 内核头文件（.h/.hh/.hpp）：**182 个**
- 用户态文件：**约 12 个**
- 第三方库（EASTL）：独立子模块，编译为静态库

### 7. 初步观察

- 项目使用 C++23 标准开发内核，禁用了异常和 RTTI，这在 OS 内核项目中较为少见。
- 网络模块集成了名为 "onpstack" 的第三方 TCP/IP 协议栈，包含完整的 TCP/UDP/ICMP/ARP 实现。
- 文件系统模块移植了 lwext4（轻量级 ext4 实现），并通过 VFS 层统一抽象。
- 用户态部分较为精简，主要包含 initcode（初始进程）和系统调用封装库。
- BusyBox 以预编译二进制形式提供，分别针对 RISC-V 和 LoongArch 架构。