# TOYOS 内核项目初步分析报告

## 一、项目概述

该项目名为 **TOYOS**，由华东师范大学 ECNU九队开发，基于 **xv6-riscv** 教学操作系统，目标平台为 **RISC-V 64位**，支持 QEMU virt 虚拟机和星光二代（VisionFive）开发板。项目使用 **C 语言**编写，采用 GNU Make 递归构建系统，交叉编译工具链为 `riscv64-unknown-elf-*`。

## 二、仓库文件组织结构

```
.
├── Makefile              # 顶层构建入口，负责QEMU启动、镜像生成
├── Common.mk             # 公共编译配置（交叉编译器、CFLAGS、LDFLAGS）
├── README.md             # 项目说明
├── LICENSE               # GPL许可证
├── .gdbinit.tmpl-riscv   # GDB调试模板
├── .vscode/              # VS Code配置
├── docs/                 # 设计文档（6篇Markdown + 图片）
├── include/              # 内核头文件（按子系统分目录）
│   ├── common.h          # 全局类型定义和常量
│   ├── riscv.h           # RISC-V寄存器/指令操作
│   ├── sbi.h             # SBI调用接口
│   ├── memlayout.h       # 内存布局定义
│   ├── boot/             # （无头文件）
│   ├── dev/              # 设备驱动头文件
│   ├── fs/               # 文件系统头文件（base/fat32/ext4）
│   ├── lib/              # 库函数头文件
│   ├── lock/             # 锁机制头文件
│   ├── mem/              # 内存管理头文件
│   ├── proc/             # 进程管理头文件
│   ├── signal/           # 信号机制头文件
│   ├── syscall/          # 系统调用头文件
│   └── trap/             # 中断/异常头文件
├── kernel/               # 内核源代码（按子系统分目录）
│   ├── Makefile          # 内核构建入口
│   ├── boot/             # 启动代码（Entry.S, start.c, main.c）
│   ├── dev/              # 设备驱动（UART、VirtIO磁盘、PLIC、定时器等）
│   ├── fs/               # 文件系统
│   │   ├── base/         # 公共缓冲缓存层（buf.c）
│   │   ├── fat32/        # FAT32文件系统实现（7个源文件）
│   │   └── ext4/         # ext4文件系统实现（7个源文件）
│   ├── lib/              # 内核库（printf、字符串操作）
│   ├── lock/             # 锁（spinlock、sleeplock）
│   ├── mem/              # 内存管理（物理内存、内核虚拟内存、用户虚拟内存）
│   ├── proc/             # 进程管理（进程生命周期、调度、ELF加载、上下文切换）
│   ├── signal/           # 信号机制
│   ├── syscall/          # 系统调用分发与实现
│   └── trap/             # 中断/异常处理（内核态和用户态trap）
├── linker/               # 链接脚本
│   ├── kernel.ld         # QEMU内核链接脚本（入口0x80200000）
│   ├── machine.ld        # 开发板内核链接脚本（入口0x40200000）
│   └── user.ld           # 用户程序链接脚本（入口0x0）
├── user/                 # 用户态程序
│   ├── Makefile          # 用户程序构建入口 + 文件系统镜像生成
│   ├── initcode.c        # init进程（嵌入内核的初始用户进程）
│   ├── include/          # 用户态头文件（系统调用封装、标准库声明）
│   ├── lib/              # 用户态C库（stdio、stdlib、string、syscall、clone）
│   └── src/              # 用户态测试程序（约40个独立程序）
└── sdcard/               # SD卡镜像相关
    └── busybox_testcode.sh
```

## 三、子系统分析

基于代码结构和文档，该项目实现了以下 **10 个子系统**：

| 子系统 | 目录 | 核心源文件数 | 代码行数（约） | 说明 |
|--------|------|-------------|---------------|------|
| **启动引导 (boot)** | `kernel/boot/` | 3 | ~200 | OpenSBI -> Entry.S -> start.c -> main.c，S-mode启动 |
| **设备管理 (dev)** | `kernel/dev/` | 8 | ~1200 | UART(16550/8250)、VirtIO块设备、PLIC中断控制器、定时器、RTC、RAM磁盘、控制台 |
| **文件系统 (fs)** | `kernel/fs/` | 15 | ~4200 | 三层架构：base缓冲缓存层 + FAT32实现 + ext4实现（决赛新增） |
| **内核库 (lib)** | `kernel/lib/` | 2 | ~300 | printf格式化输出、字符串操作 |
| **锁机制 (lock)** | `kernel/lock/` | 2 | ~200 | 自旋锁(spinlock)、睡眠锁(sleeplock) |
| **内存管理 (mem)** | `kernel/mem/` | 4 | ~800 | 物理页帧分配、内核页表、用户页表管理、mmap支持 |
| **进程管理 (proc)** | `kernel/proc/` | 5 | ~1200 | 进程创建/销毁、fork/exec/wait/exit、调度、ELF加载、上下文切换 |
| **信号机制 (signal)** | `kernel/signal/` | 1 | ~200 | POSIX信号（rt_sigaction/sigprocmask/sigreturn等） |
| **系统调用 (syscall)** | `kernel/syscall/` | 3 | ~1500 | 约55个系统调用（文件/进程/内存/信号/其他） |
| **中断异常 (trap)** | `kernel/trap/` | 4 | ~500 | 内核态/用户态trap处理、Trampoline跳转、定时器中断 |

**用户态**包含约40个独立测试程序，覆盖文件操作、进程管理、内存映射等系统调用，以及一个简易shell。

## 四、系统调用覆盖

项目注册了约 **55 个系统调用**，按类别分布：
- **文件系统**：29个（openat、read、write、getdents64、mkdirat、mount、fstat、sendfile等）
- **进程管理**：14个（clone、execve、wait4、exit、getpid、kill等）
- **内存管理**：5个（brk、mmap、munmap、mprotect、madvice）
- **信号机制**：4个（rt_sigaction、rt_sigprocmask、rt_sigtimedwait、rt_sigreturn）
- **其他**：7个（times、gettimeofday、clock_gettime、uname、sysinfo、syslog、ppoll等）

## 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| `riscv64-unknown-elf-gcc` | C交叉编译器 | 可用（RISC-V GCC） |
| `riscv64-unknown-elf-ld` | 链接器 | 可用（RISC-V ld） |
| `riscv64-unknown-elf-objcopy` | 二进制转换 | 可用（RISC-V objcopy） |
| `riscv64-unknown-elf-objdump` | 反汇编 | 可用（RISC-V objdump） |
| `qemu-system-riscv64` | RISC-V模拟器 | 可用 |
| `GNU Make` | 构建系统 | 可用 |
| `mkfs.ext4` | ext4文件系统镜像制作 | 可用 |
| `mkfs.vfat` | FAT32文件系统镜像制作 | 可用 |
| `dd` | 镜像文件创建 | 可用 |
| `mount/umount` | 文件系统挂载（需sudo） | 受限（sandbox环境） |
| `xxd` | initcode嵌入头文件 | 需确认 |
| `OpenSBI` | S-mode固件（QEMU -bios default） | 可用 |
| `mkimage` | U-Boot镜像制作（开发板用） | 可用 |
| `GDB` | 调试 | 可用 |

**注意事项**：
- 当前 `Common.mk` 中 `PLATFORM` 默认设为 `visionfive`（开发板），QEMU构建需改为 `qemu` 或通过参数覆盖。
- 文件系统镜像生成（`user/Makefile` 中的 `sdcard.img` 目标）需要 `sudo mount`，在沙箱环境中可能受限。
- 交叉编译器前缀为 `riscv64-unknown-elf-`，需确认环境中实际可用的前缀是否匹配（可能需要适配为 `riscv64-linux-gnu-` 或其他可用前缀）。

## 六、代码规模统计

| 部分 | 源文件数 | 代码行数（约） |
|------|---------|---------------|
| 内核 C/汇编 | ~35 | ~9,300 |
| 内核头文件 | ~25 | ~2,000 |
| 用户态程序 | ~45 | ~2,100 |
| 链接脚本 | 3 | ~100 |
| **合计** | **~108** | **~13,500** |

这是一个中等规模的教学/竞赛级操作系统内核，核心功能较为完整，文件系统部分（ext4）为决赛阶段独立撰写的新增模块。