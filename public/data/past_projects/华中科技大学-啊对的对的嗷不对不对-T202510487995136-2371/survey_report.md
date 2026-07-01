# AddddOS 项目初步分析报告

## 一、项目概述

**项目名称**：AddddOS
**队伍名称**：啊对的对的，嗷不对不对
**学校**：华中科技大学
**项目基础**：基于 MIT xv6 (RISC-V 版本) 进行扩展开发，同时移植了 LoongArch 架构支持。
**目标平台**：RISC-V 64 位 (QEMU virt) 和 LoongArch 64 位 (QEMU virt)

---

## 二、仓库文件组织结构

```
.
├── CMakeLists.txt          # 顶层 CMake 构建配置
├── Makefile                # 顶层 Make 入口（封装 cmake 调用）
├── README / readme.md      # 项目说明文档
├── .gdbinit.tmpl-riscv     # GDB 调试模板
├── disk-la.img             # 龙芯架构磁盘镜像（512MB）
│
├── kernel/                 # 内核源码（核心）
│   ├── boot/               # 启动引导代码
│   │   ├── riscv/          # RISC-V 入口 (entry.S, initcode.S, start.c)
│   │   ├── loongarch/      # LoongArch 入口 (entry.S, initcode.S)
│   │   └── main.c          # 内核主函数（两架构共用）
│   ├── driver/             # 设备驱动
│   │   ├── bio.c           # 块 I/O 缓冲层（共用）
│   │   ├── riscv/          # RISC-V virtio_disk 驱动
│   │   └── loongarch/      # LoongArch PCI + virtio 驱动
│   ├── fs/                 # 文件系统
│   │   ├── vfs/            # 虚拟文件系统层 (file.c, fs.c, inode.c, ops.c)
│   │   └── ext4/lwext4/    # lwext4 第三方 EXT4 实现（约20个 .c 文件）
│   ├── lib/                # 内核工具库 (printf, string, ctype, qsort, console)
│   ├── mem/                # 内存管理
│   │   ├── kalloc.c        # 内核页分配
│   │   ├── buddysystem.c   # 伙伴系统分配器
│   │   ├── slab.c          # Slab 分配器
│   │   ├── vm.c            # 虚拟内存/页表管理
│   │   ├── uart.c          # UART 串口驱动
│   │   └── trampoline.S    # RISC-V 专用 trampoline 页
│   ├── proc/               # 进程管理
│   │   ├── proc.c          # 进程核心（fork, exit, wait, scheduler 等）
│   │   ├── exec.c          # ELF 加载执行
│   │   ├── pipe.c          # 管道
│   │   ├── signal.c        # 信号机制
│   │   ├── socket.c        # Socket 网络接口
│   │   ├── semaphore.c     # 信号量
│   │   ├── spinlock.c      # 自旋锁
│   │   ├── sleeplock.c     # 睡眠锁
│   │   ├── riscv/          # RISC-V 上下文切换 (swtch.S, sig_trampoline.S)
│   │   └── loongarch/      # LoongArch 上下文切换 (swtch.S, sig_trampoline.S)
│   ├── sys/                # 系统调用实现
│   │   ├── syscall.c       # 系统调用分发（324行）
│   │   ├── sysfile.c       # 文件相关系统调用（1524行）
│   │   ├── sysproc.c       # 进程相关系统调用（356行）
│   │   ├── sysmem.c        # 内存相关系统调用（234行）
│   │   ├── sysothers.c     # 其他系统调用（175行）
│   │   ├── syssig.c        # 信号相关系统调用（110行）
│   │   └── plic.c          # RISC-V PLIC 中断控制器
│   ├── trap/               # 异常与中断处理
│   │   ├── riscv/          # RISC-V trap (kernelvec.S, trap.c)
│   │   └── loongarch/      # LoongArch trap (kernelvec.S, uservec.S, merror.S, tlbrefill.S, apic.c, extioi.c, trap.c)
│   └── linker/             # 链接脚本
│       ├── riscv/kernel.ld
│       └── loongarch/kernel.ld
│
├── include/                # 内核头文件（按子系统组织）
│   ├── fs/                 # 文件系统头文件（vfs + ext4/lwext4）
│   ├── mem/                # 内存管理头文件
│   ├── proc/               # 进程管理头文件
│   ├── lock/               # 锁机制头文件
│   ├── sys/                # 系统调用头文件
│   ├── trap/               # 中断/异常头文件
│   ├── dev/                # 设备驱动头文件（PCI, virtio）
│   ├── lib/                # 工具库头文件
│   └── *.h                 # 通用头文件 (types.h, defs.h, param.h 等)
│
├── include2/               # RISC-V newlib 工具链头文件（C/C++ 标准库头文件，仅 RISC-V 构建时引入）
│
├── user/                   # 用户态程序
│   ├── app/                # 用户应用程序源码 (cat, echo, grep, sh, ls, init 等)
│   ├── deps/               # 用户态库 (ulib.c, printf.c, umalloc.c, usys.S)
│   ├── init/               # initcode 汇编（第一个用户进程）
│   ├── bin/                # 预编译的用户态二进制文件
│   │   ├── riscv/          # RISC-V 架构预编译二进制
│   │   ├── loongarch/glibc/# LoongArch glibc 编译的二进制
│   │   ├── loongarch/musl/ # LoongArch musl 编译的二进制
│   │   └── busybox         # BusyBox 二进制
│   ├── tests/              # 测试用例 (signal_test.c)
│   ├── user.ld             # RISC-V 用户程序链接脚本
│   └── user-loongarch.ld   # LoongArch 用户程序链接脚本
│
├── scripts/                # 运行/调试脚本
│   ├── qemu.sh             # RISC-V QEMU 启动脚本
│   ├── qemu-loongarch.sh   # LoongArch QEMU 启动脚本
│   ├── qemu-gdb.sh         # RISC-V GDB 调试启动
│   ├── qemu-loongarch-gdb.sh
│   ├── objdump-files.sh    # 反汇编脚本
│   └── kill.sh             # 终止脚本
│
├── doc/                    # 项目文档
│   ├── final.md            # 决赛测例实现记录
│   ├── fs-ext4.md          # EXT4 文件系统文档
│   ├── syscall-*.md        # 各子系统系统调用文档
│   ├── 内存管理.md
│   ├── 现场赛设计方案.md
│   └── busybox.md
│
└── data/                   # 数据/挂载目录
```

---

## 三、子系统识别

基于目录结构和源码内容，该项目实现了以下子系统：

| 子系统 | 对应目录 | 说明 |
|--------|----------|------|
| **启动引导** | `kernel/boot/` | 双架构入口、内核初始化流程 |
| **内存管理** | `kernel/mem/` | 伙伴系统 + Slab 分配器 + 虚拟内存/页表管理 |
| **进程管理** | `kernel/proc/` | 进程创建/销毁/调度、上下文切换、管道、信号量 |
| **信号机制** | `kernel/proc/signal.c`, `kernel/sys/syssig.c` | POSIX 信号支持 (rt_sigaction, rt_sigprocmask, rt_sigreturn 等) |
| **文件系统** | `kernel/fs/` | VFS 抽象层 + lwext4 (EXT4 文件系统实现) |
| **设备驱动** | `kernel/driver/` | 块 I/O 层、virtio-blk 磁盘驱动（RISC-V 用 MMIO，LoongArch 用 PCI） |
| **中断/异常处理** | `kernel/trap/` | 内核态/用户态 trap 处理，RISC-V 用 PLIC，LoongArch 用 APIC+EXTIOI |
| **系统调用** | `kernel/sys/` | 约 80+ 个系统调用，覆盖进程、文件、内存、信号、网络等 |
| **锁与同步** | `kernel/proc/spinlock.c`, `sleeplock.c`, `semaphore.c` | 自旋锁、睡眠锁、信号量 |
| **Socket 网络** | `kernel/proc/socket.c` | Socket 接口（bind, listen, accept, connect, sendto, recvfrom 等） |
| **用户态 Shell** | `user/app/` | sh, cat, ls, grep, echo 等基本命令 |
| **BusyBox 支持** | `user/bin/busybox` | 预编译 BusyBox 二进制，用于扩展测试 |

---

## 四、构建工具链需求

| 工具 | 用途 | 环境中可用性 |
|------|------|-------------|
| **CMake** (>= 3.21) | 构建系统主配置 | 可用 |
| **GNU Make** | 顶层构建入口 | 可用 |
| **riscv64-unknown-elf-gcc** | RISC-V 裸机交叉编译器 | 可用 (RISC-V cross toolchain) |
| **loongarch64-linux-gnu-gcc** | LoongArch 交叉编译器 | 可用 (LoongArch cross toolchain) |
| **qemu-system-riscv64** | RISC-V 模拟器 | 可用 |
| **qemu-system-loongarch64** | LoongArch 模拟器 | 可用 |
| **mkfs.ext4** | 制作 EXT4 文件系统镜像 | 可用 |
| **dd** | 创建磁盘镜像 | 可用 |
| **mount/umount** | 挂载镜像写入初始文件 | 需要 root 权限，可能受限 |
| **riscv64-unknown-elf-objcopy** | 生成纯二进制 initcode | 可用 |
| **loongarch64-linux-gnu-objcopy** | 生成纯二进制 initcode | 可用 |
| **GDB** | 调试 | 可用 |

**构建流程**：`Makefile` -> `CMake` 配置 -> 编译内核 + 用户程序 -> `dd` + `mkfs.ext4` 制作文件系统镜像 -> QEMU 启动。

---

## 五、初步观察

1. **双架构支持**：项目通过 CMake 条件编译和目录分离（`riscv/` vs `loongarch/`）实现 RISC-V 和 LoongArch 双架构支持，共用代码通过 `#ifdef RISCV` / `#ifdef LOONGARCH` 宏区分。

2. **文件系统**：从 xv6 原始的简单文件系统升级为完整的 EXT4 实现，集成了第三方库 lwext4，并实现了 VFS 抽象层。

3. **系统调用数量**：根据 `include/sys/syscall.h`，定义了约 80+ 个系统调用号，涵盖进程管理、文件操作、内存管理、信号、网络 Socket、BusyBox 兼容等。

4. **预编译二进制**：`user/bin/` 下包含大量预编译的用户态测试程序（RISC-V 和 LoongArch 各一套），包括 glibc 和 musl 两种 C 库编译版本。

5. **内核代码规模**：内核系统调用实现部分约 2723 行，加上其他子系统，整体内核代码量估计在 8000-12000 行（不含 lwext4 第三方库）。