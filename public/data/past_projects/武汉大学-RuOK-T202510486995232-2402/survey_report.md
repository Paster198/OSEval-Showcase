## 项目初步调查报告

### 一、项目基本信息

- **项目名称**：RuOK 队 OS 内核设计项目（全国操作系统大赛参赛作品）
- **主要语言**：C++（内核主体），C（部分底层代码、用户态程序），汇编（架构相关入口/上下文切换），Rust（SBI 固件）
- **支持架构**：RISC-V（rv64gc）和 LoongArch（loongarch64），双架构支持
- **代码规模**：内核及 HAL/HSAI/用户态源码合计约 48,841 行（含头文件）
- **设计渊源**：LoongArch 部分基于武汉大学"俺争取不掉队"队内核改进；RISC-V 部分延续 xv6 设计思路

---

### 二、仓库文件组织结构

```
.
├── Makefile              # 顶层构建脚本，控制全项目编译、链接、运行
├── start.sh              # LoongArch QEMU 启动脚本
├── kernel/               # 内核核心代码
│   ├── fs/               #   文件系统子系统
│   ├── mm/               #   内存管理子系统
│   ├── pm/               #   进程管理子系统
│   ├── syscall/          #   系统调用子系统
│   ├── tm/               #   定时器/时间管理子系统
│   ├── klib/             #   内核库（打印、字符串、回溯等）
│   ├── include/          #   内核头文件（按子系统分目录）
│   └── xn6_start_kernel.cc  # 内核入口主函数
├── hal/                  # 硬件抽象层（架构+平台相关代码）
│   ├── riscv/            #   RISC-V 架构实现
│   │   ├── qemu/         #     QEMU virt 平台适配
│   │   ├── k210/         #     K210 平台适配
│   │   └── SBI/          #     RustSBI 固件（预编译二进制+源码）
│   └── loongarch/        #   LoongArch 架构实现
│       ├── qemu/         #     QEMU 平台适配
│       └── qemu_2k1000/  #     LS2K1000 平台适配
├── hsai/                 # 硬件-软件抽象接口层（跨架构统一接口）
│   ├── ata/              #   ATA/AHCI 磁盘驱动
│   ├── uart/             #   UART 串口驱动
│   ├── intr/             #   中断管理抽象
│   ├── mem/              #   内存接口抽象
│   ├── smp/              #   多核/自旋锁
│   └── include/          #   HSAI 头文件（接口定义）
├── user/                 # 用户态 init 程序
│   ├── riscv/            #   RISC-V 用户态系统调用入口
│   ├── loongarch/        #   LoongArch 用户态系统调用入口
│   └── user_init.c       #   init 进程主程序
├── thirdparty/           # 第三方库
│   └── EASTL/            #   EA Standard Template Library（C++ 容器库）
├── doc/                  # 项目文档
└── riscv64-lp64d-glibc.tar.bz2.*  # RISC-V glibc 交叉工具链分卷包
```

---

### 三、子系统划分

| 子系统 | 主要目录 | 功能概述 |
|--------|----------|----------|
| **进程管理 (pm)** | `kernel/pm/` | 进程控制块(PCB)、进程管理器、调度器（优先级调度）、进程间通信（管道、信号、共享内存）、futex、sleep lock |
| **内存管理 (mm)** | `kernel/mm/` | 物理内存管理（Buddy 分配器）、虚拟内存管理、页表管理、堆内存管理、用户空间流/栈流 |
| **文件系统 (fs)** | `kernel/fs/` | VFS 层（dentry、inode、buffer、path）、ext4 文件系统、FAT32 文件系统、ramfs、文件抽象（普通文件、设备文件、管道文件）、目录项缓存 |
| **系统调用 (syscall)** | `kernel/syscall/` | 系统调用分发与处理，已绑定约 40+ 个系统调用（read/write/fork/clone/execve/mmap/pipe/mount 等） |
| **时间管理 (tm)** | `kernel/tm/` | 定时器管理器、时钟接口 |
| **内核库 (klib)** | `kernel/klib/` | 打印输出、字符串操作、栈回溯、C++ ABI 支持、全局 operator new/delete、函数对象 |
| **硬件抽象层 (HAL)** | `hal/` | 架构相关的入口代码(entry.S)、上下文切换(swtch.S)、异常/中断处理、TLB管理、页表操作、平台设备驱动（virtio磁盘、PCI、AHCI等） |
| **硬件-软件抽象接口 (HSAI)** | `hsai/` | 跨架构统一接口层：虚拟CPU、虚拟中断管理器、虚拟内存接口、UART驱动、ATA/AHCI驱动、设备管理器、自旋锁 |
| **用户态** | `user/` | init 进程（user_init.c）、架构相关系统调用入口汇编 |
| **第三方库** | `thirdparty/EASTL/` | EA STL，提供 C++ 容器（string、unordered_map、vector 等）支持 |

---

### 四、编译构建所需工具

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| **RISC-V Linux GNU 交叉编译器** (`riscv64-linux-gcc/g++`) | 编译 RISC-V 架构内核及用户态代码 | 可用（环境中提供 RISC-V Linux GNU 工具链） |
| **LoongArch 交叉编译器** (`loongarch64-linux-gnu-gcc/g++`) | 编译 LoongArch 架构内核 | 可用 |
| **GNU Make** | 构建系统 | 可用 |
| **GNU ld** (交叉链接器) | 链接内核 ELF | 可用 |
| **objcopy / objdump** | 二进制处理与反汇编 | 可用 |
| **QEMU** (`qemu-system-riscv64`, `qemu-system-loongarch64`) | 模拟运行 | 可用（RISC-V 和 LoongArch 环境均有） |
| **OpenSBI / RustSBI** | RISC-V SBI 固件 | 可用（仓库内已含预编译的 `sbi-qemu` 和 `sbi-k210` 二进制） |
| **dd / mkfs.ext4** | 制作文件系统镜像 | 可用 |
| **dtc** (设备树编译器) | 设备树处理 | 可用 |
| **Rust 工具链** (rustc/cargo) | 编译 RustSBI 固件（如需重新编译） | 可用 |

**注意事项**：
- Makefile 中 RISC-V 工具链路径指向项目自带的 `riscv64-lp64d--glibc--stable-2022.08-1`（从分卷压缩包解压），构建时可能需要先解压或修改 `TOOLPREFIX` 指向环境中已有的交叉编译器。
- 项目使用 C++17（RISC-V）/ C++23（LoongArch）标准，需要对应版本的 g++ 支持。
- 编译产物输出到 `build-{arch}-{platform}/` 目录，最终链接为 `kernel.elf`。