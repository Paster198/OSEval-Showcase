# yungekc OS 内核项目初步调查报告

## 一、项目概况

yungekc（云客）是一个采用 C 语言开发的通用操作系统内核，面向 **2026 年全国大学生计算机系统能力大赛操作系统设计赛「内核实现」赛道**。项目基于武汉大学 2025 年参赛作品 **SC7 (SmartCore7)** 进行功能扩展与系统重构，同时参考了 MIT xv6-riscv、lwext4、XN6 等项目。支持 **RISC-V 64** 和 **LoongArch 64** 双指令集架构。

- 源码总规模：约 209 个源文件（`.c` / `.h` / `.S`），约 **72,860 行**代码。
- 仓库中已包含预编译内核镜像（`kernel-rv`、`kernel-la`），可直接在 QEMU 上运行。

---

## 二、顶层文件结构

```
/
├── Makefile              # 顶层构建入口（LoongArch 默认, RISC-V 并行）
├── Dockerfile            # Docker 构建环境（Ubuntu 24.04 + 双架构交叉工具链）
├── build.bat / run.bat   # Windows 构建/运行辅助脚本
├── addpath.bat / .ps1    # 路径设置脚本
├── cal_lines.sh          # 代码行数统计
├── disasm_kernel.sh      # 内核反汇编脚本
├── verify_usertest.bat   # 用户态测试验证
│
├── entry.S               # RISC-V 内核入口（_start, trap_vector）
├── entry_la.S            # LoongArch 内核入口
├── link.ld               # RISC-V 链接脚本（加载地址 0x80200000）
├── link_la.ld            # LoongArch 链接脚本（加载地址 0x90000000）
├── virt.dtb              # RISC-V 设备树二进制
│
├── kernel-rv             # 预编译 RISC-V 内核镜像
├── kernel-la             # 预编译 LoongArch 内核镜像
│
├── hal/                  # 硬件抽象层（架构相关）
├── hsai/                 # 硬件-软件抽象接口层（架构无关服务）
├── kernel/               # 内核核心逻辑
├── include/              # 公共头文件
├── user/                 # 用户态程序
├── doc/                  # 文档与开发日志
├── docker/               # Docker 工具链配置
│
└── *.md / *.pdf / *.pptx / *.mp4  # 项目文档、设计方案与演示材料
```

---

## 三、源码目录结构与子系统划分

### 3.1 `hal/` — 硬件抽象层（Hardware Abstraction Layer）

按架构分为两个子目录。负责最底层的架构相关代码。

| 目录/文件 | 所属子系统 | 说明 |
|---|---|---|
| `hal/riscv/entry.S` | 启动 / 异常处理 | RISC-V 内核入口、trap 向量、上下文切换 |
| `hal/riscv/kernelvec.S` | 异常处理 | RISC-V 内核态 trap 处理 |
| `hal/riscv/trampoline.S` | 内存管理 | RISC-V 页表切换跳板 |
| `hal/riscv/sigtrampoline.S` | 信号处理 | RISC-V 信号返回跳板 |
| `hal/riscv/switch.S` | 调度 | RISC-V 上下文切换 |
| `hal/riscv/start.c` | 启动 | RISC-V 早期初始化 |
| `hal/riscv/uart.c` | 字符设备驱动 | RISC-V NS16550 UART |
| `hal/riscv/sbi.c` | SBI 接口 | OpenSBI 调用封装 |
| `hal/loongarch/entry.S` | 启动 | LoongArch 内核入口 |
| `hal/loongarch/kernelvec.S` | 异常处理 | LoongArch 内核态 trap |
| `hal/loongarch/merrvec.S` | 异常处理 | LoongArch 机器错误处理 |
| `hal/loongarch/tlbrefill.S` | 内存管理 | LoongArch TLB 重填 |
| `hal/loongarch/trampoline.S` | 内存管理 | LoongArch 页表切换跳板 |
| `hal/loongarch/sigtrampoline.S` | 信号处理 | LoongArch 信号返回跳板 |
| `hal/loongarch/swtch.S` | 调度 | LoongArch 上下文切换 |
| `hal/loongarch/uart.c` | 字符设备驱动 | LoongArch UART |
| `hal/loongarch/ipi.c` | 多核 | LoongArch 核间中断 |
| `hal/loongarch/ld.script` | 构建 | LoongArch 链接脚本 |
| `hal/riscv/ld.script` | 构建 | RISC-V 链接脚本 |

### 3.2 `hsai/` — 硬件-软件抽象接口（Hardware-Software Abstract Interface）

架构无关的内核服务层，为上层内核提供统一接口。

| 文件 | 所属子系统 | 说明 |
|---|---|---|
| `hsai_trap.c` | 异常/中断处理 | 统一陷阱分发（用户态/内核态 trap、缺页、时钟中断、设备中断） |
| `hsai_mem.c` | 内存管理 | 架构相关的内存起始地址查询 |
| `hsai_service.c` | 平台服务 | CPU ID 查询、membarrier 等杂项服务 |
| `plic.c` | 中断控制器 | RISC-V PLIC 中断控制器驱动 |
| `timer.c` | 时钟管理 | 架构无关的计时器接口 |
| `print.c` | 控制台输出 | 内核打印 |

### 3.3 `kernel/` — 内核核心

#### 3.3.1 `kernel/` 根目录（进程/内存/同步/IPC/其他）

| 文件 | 所属子系统 | 代码量（行） | 说明 |
|---|---|---|---|
| `process.c` | 进程管理 | ~76,000 字节 | 进程/线程生命周期、调度器 |
| `thread.c` | 线程管理 | ~5,200 字节 | 线程创建与管理 |
| `exec.c` | 程序加载 | ~27,000 字节 | ELF 加载、execve 实现 |
| `syscall.c` | 系统调用 | ~310,000 字节 | 170+ Linux 兼容系统调用分发 |
| `signal.c` | 信号处理 | ~38,000 字节 | POSIX 信号发送/接收/处理 |
| `futex.c` | 同步 | ~15,000 字节 | 快速用户态互斥量 |
| `vma.c` | 虚拟内存 | ~65,000 字节 | VMA 链表管理（mmap/munmap/mprotect） |
| `vmem.c` | 虚拟内存 | ~30,000 字节 | 多级页表、地址翻译、copyin/copyout |
| `pmem.c` | 物理内存 | ~37,000 字节 | Buddy System 页分配器 |
| `slab_common.c` | 内存分配 | ~12,000 字节 | Slab 分配器 |
| `spinlock.c` | 同步 | ~2,800 字节 | 自旋锁 |
| `sleeplock.c` | 同步 | ~800 字节 | 睡眠锁 |
| `socket.c` | 网络 | ~2,600 字节 | Socket 接口 |
| `procfs.c` | 文件系统 | ~21,000 字节 | proc 文件系统 |
| `namespace.c` | 命名空间 | ~3,000 字节 | UTS 命名空间 |
| `console.c` | 控制台 | ~10,000 字节 | 行缓冲控制台输入 |
| `timer.c` | 时钟管理 | ~5,200 字节 | 内核定时器 |
| `string.c` | 基础库 | ~15,000 字节 | 字符串/内存操作 |
| `loop.c` | 块设备 | ~5,400 字节 | Loop 设备 |
| `figlet.c` | 工具 | ~22,000 字节 | ASCII Art 输出 |
| `cpu.c` | SMP | ~640 字节 | CPU 管理 |
| `test.c` | 测试 | ~26,000 字节 | 内核自测框架 |
| `yungekc_start_kernel.c` | 启动 | ~4,400 字节 | 内核启动主流程 |
| `SC7_start_kernel.c` | 启动（兼容） | ~4,900 字节 | 评测兼容入口 |

#### 3.3.2 `kernel/fs/` — 文件系统

约 **22,000 行**代码，实现了完整的文件系统栈。

| 类别 | 文件 | 说明 |
|---|---|---|
| **VFS 层** | `fs.c` | 虚拟文件系统接口 |
| | `file.c` | 文件描述符管理 |
| | `inode.c` | VFS inode 管理 |
| | `vfs_ext4.c` | ext4 适配层 |
| | `vfs_vfat.c` | VFAT 适配层 |
| **ext4 实现** | `ext4.c` | ext4 核心 |
| | `ext4_balloc.c` | 块分配 |
| | `ext4_bcache.c` | 块缓存 |
| | `ext4_bitmap.c` | 位图操作 |
| | `ext4_block_group.c` | 块组管理 |
| | `ext4_blockdev.c` | 块设备抽象 |
| | `ext4_crc32.c` | CRC32 校验 |
| | `ext4_dir.c` | 目录操作 |
| | `ext4_dir_idx.c` | 目录索引 |
| | `ext4_extent.c` | Extent 树 |
| | `ext4_fs.c` | 文件系统操作 |
| | `ext4_hash.c` | 目录哈希 |
| | `ext4_ialloc.c` | inode 分配 |
| | `ext4_inode.c` | inode 操作 |
| | `ext4_journal.c` | 日志 |
| | `ext4_mbr.c` | MBR 分区 |
| | `ext4_mkfs.c` | 格式化 |
| | `ext4_super.c` | 超级块 |
| | `ext4_trans.c` | 事务 |
| | `ext4_xattr.c` | 扩展属性 |
| | `ext4_debug.c` | 调试支持 |
| **其他** | `bio.c` | 块 I/O 缓冲 |
| | `blockdev.c` | 块设备抽象 |
| | `pipe.c` | 匿名管道 |
| | `fifo.c` | 命名管道（FIFO） |
| | `list.c` | 通用链表 |
| | `qsort.c` | 快速排序 |

#### 3.3.3 `kernel/driver/` — 设备驱动

| 架构 | 文件 | 说明 |
|---|---|---|
| `loongarch/` | `pci.c` | PCI 总线枚举 |
| | `virtio_pci.c` | VirtIO PCI 传输层 |
| | `virtio_disk.c` | VirtIO 块设备驱动 |
| `riscv/` | `virt.c` | RISC-V QEMU virt 平台驱动（包含 PLIC、VirtIO 等） |

### 3.4 `include/` — 头文件

分三层组织：

| 目录 | 说明 | 关键头文件 |
|---|---|---|
| `include/`（顶层） | 架构相关定义、跨模块接口 | `riscv.h`, `loongarch.h`, `syscall.h`, `vfs.h`, `mm.h`, `proc.h`, `elf.h`, `virtio.h`, `virtio_blk.h`, `virtio_net.h`, `net.h`, `pipe.h`, `ext4.h`, `ramfs.h` |
| `include/kernel/` | 内核子系统接口 | `process.h`, `signal.h`, `futex.h`, `vma.h`, `vmem.h`, `pmem.h`, `syscall_ids.h`, `spinlock.h`, `sleeplock.h`, `socket.h`, `procfs.h`, `namespace.h`, `thread.h`, `timer.h`, `tree.h`, `queue.h` 等 |
| `include/kernel/fs/` | 文件系统内部接口 | `ext4.h`, `ext4_types.h`, `ext4_inode.h`, `ext4_journal.h`, `ext4_fs.h`, `ext4_dir.h`, `file.h`, `inode.h`, `vfs_ext4.h`, `list.h`, `stat.h`, `fcntl.h` 等 |
| `include/hsai/` | HSAI 层接口 | `hsai.h`, `hsai_trap.h`, `hsai_mem.h`, `hal.h`, `timer.h`, `plic.h`, `uart.h` |
| `include/hal/` | HAL 层架构头文件 | RISC-V 和 LoongArch 特定定义 |

### 3.5 `user/` — 用户态

| 目录/文件 | 说明 |
|---|---|
| `user/riscv/user.c` | RISC-V 用户态测试程序（~2,600 行） |
| `user/riscv/usertest.c` | RISC-V 用户测试用例 |
| `user/riscv/usys.S` | RISC-V 系统调用跳板 |
| `user/riscv/user_initcode.ld` | RISC-V 用户程序链接脚本 |
| `user/loongarch/user.c` | LoongArch 用户态测试程序（~2,100 行） |
| `user/loongarch/usys.S` | LoongArch 系统调用跳板 |
| `user/loongarch/user_initcode.ld` | LoongArch 用户程序链接脚本 |
| `user/include/` | 用户态公共头文件（`userlib.h`, `usercall.h`, `print.h`, `string.h`, `sh.h` 等） |

### 3.6 `doc/` — 文档

| 文件 | 说明 |
|---|---|
| `yungekc_overview.md` | 项目概览 |
| `yungekc_初赛设计方案文档.md` | 初赛设计方案 |
| `commit_log.md` | 提交日志（~54KB） |
| `filesystem.md` | 文件系统设计文档 |
| `process_management.md` | 进程管理文档 |
| `virtual_memory.md` | 虚拟内存文档 |
| `physical_memory.md` | 物理内存文档 |
| `syscall.md` | 系统调用文档 |
| `timer.md` | 时钟管理文档 |
| `user_program.md` | 用户程序文档 |
| `initcode.md` | initcode 设计 |
| `项目部署运行文档.md` | 部署运行指南 |
| `reports/` | 比赛输出报告 |
| `yungekc_log/` | 开发调试日志 |

---

## 四、构建工具需求

根据 `Makefile` 和 `Dockerfile` 分析，构建该项目需要以下工具链：

### 4.1 编译工具链

| 工具 | 用途 |
|---|---|
| **LoongArch 交叉工具链** (`loongarch64-linux-gnu-*`) | LoongArch 64 架构编译 |
| GCC 13 (`gcc-13-loongarch64-linux-gnu`) | C 编译器（LoongArch） |
| binutils (`binutils-loongarch64-linux-gnu`) | 链接器、objcopy、objdump 等 |
| **RISC-V 交叉工具链** (`riscv64-linux-gnu-*`) | RISC-V 64 架构编译 |
| GCC (`gcc-riscv64-linux-gnu`) | C 编译器（RISC-V） |
| `riscv64-linux-gnu-ld` | RISC-V 链接器 |
| **GNU Make** | 构建系统 |

注意：RISC-V 工具链前缀可通过 `RISCV_TOOLPREFIX` 覆盖（如 `riscv64-unknown-elf-`）。

### 4.2 模拟与运行

| 工具 | 用途 |
|---|---|
| `qemu-system-riscv64` | RISC-V 模拟 |
| `qemu-system-loongarch64` | LoongArch 模拟 |

### 4.3 构建方式

- **本地构建**：需安装上述两个架构的交叉工具链和 QEMU，执行 `make all`。
- **Docker 构建**：使用提供的 `Dockerfile`（基于 Ubuntu 24.04），预装了所有必要工具链。
- RISC-V 构建使用 OpenSBI 固件（`SBI=1` 模式），内核加载于 `0x80200000`。
- LoongArch 构建支持 QEMU `virt` 机器类型（`QEMU=virt`），内核加载于 `0x90000000`。

---

## 五、子系统全景总结

该项目实现的子系统及其在各目录中的分布：

| 子系统 | 核心实现位置 | 主要文件 |
|---|---|---|
| **启动流程** | `hal/`、根目录、`kernel/` | `entry.S`, `entry_la.S`, `yungekc_start_kernel.c`, `SC7_start_kernel.c`, `start.c` |
| **异常/中断处理** | `hal/`、`hsai/` | `kernelvec.S`, `trampoline.S`, `tlbrefill.S`, `merrvec.S`, `hsai_trap.c`, `plic.c` |
| **系统调用** | `kernel/`、`include/kernel/` | `syscall.c`（170+ 调用）, `syscall_ids.h` |
| **进程管理** | `kernel/` | `process.c`, `thread.c`, `exec.c`, `cpu.c` |
| **调度与上下文切换** | `hal/`、`kernel/` | `swtch.S`/`switch.S`, `process.c` |
| **虚拟内存** | `kernel/` | `vma.c`, `vmem.c` |
| **物理内存** | `kernel/` | `pmem.c`, `slab_common.c` |
| **信号处理** | `kernel/`、`hal/` | `signal.c`, `sigtrampoline.S` |
| **同步机制** | `kernel/` | `spinlock.c`, `sleeplock.c`, `futex.c` |
| **文件系统 (VFS+ext4)** | `kernel/fs/` | 30 个文件，完整 ext4 实现 |
| **设备驱动** | `kernel/driver/` | VirtIO 块设备、PCI、UART、PLIC |
| **Socket 网络** | `kernel/` | `socket.c` |
| **procfs** | `kernel/` | `procfs.c` |
| **命名空间** | `kernel/` | `namespace.c` |
| **时钟管理** | `hsai/`、`kernel/` | `timer.c`, `hsai/timer.c` |
| **控制台 I/O** | `kernel/` | `console.c` |
| **Loop 设备** | `kernel/` | `loop.c` |
| **HSAI 抽象层** | `hsai/` | 架构无关陷阱分发、内存查询、平台服务 |

该内核在架构设计上采用了清晰的 **HAL → HSAI → Kernel** 三层结构，将架构相关代码（HAL）与架构无关的内核逻辑（Kernel）通过中间抽象接口层（HSAI）解耦，实现了对 RISC-V 和 LoongArch 双架构的支持。文件系统部分规模尤为突出，ext4 的实现包含约 22,000 行代码，涵盖了块分配、Extent 树、日志、目录索引、扩展属性等完整特性。