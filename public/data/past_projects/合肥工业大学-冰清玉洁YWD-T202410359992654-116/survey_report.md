## 项目结构

```
.
├── Makefile              # 主构建文件
├── kernel/               # 内核源代码
│   ├── include/          # 内核头文件
│   ├── *.c, *.S          # 内核实现文件
├── xv6-user/             # 用户态程序
├── bootloader/SBI/       # RustSBI 引导程序 (Rust)
├── linker/               # 链接脚本 (qemu.ld, k210.ld)
├── initcode/             # 初始进程代码
├── tools/                # 辅助工具 (kflash.py)
├── debug/                # 调试配置 (OpenOCD)
├── mydoc/                # 项目文档
├── temp/                 # 临时文件系统镜像内容
├── disk.img              # 磁盘镜像
└── fw_jump.elf           # 固件跳转文件
```

## 初步调查结果

### 1. 项目概述

这是一个基于 **xv6-riscv** 的操作系统内核项目，项目名称为"冰清玉洁YWD"，参加 2024 年 OS 内核比赛。项目使用 **C 语言**编写内核，支持两个目标平台：
- **QEMU** (riscv64 virt 虚拟机)
- **K210** (Kendryte K210 开发板)

### 2. 已实现的子系统

| 子系统 | 相关文件 | 说明 |
|--------|----------|------|
| **启动引导** | `entry_qemu.S`, `entry_k210.S`, `bootloader/SBI/` | RustSBI 作为 SBI 固件，支持双平台启动 |
| **内存管理** | `vm.c`, `kalloc.c` | 虚拟内存管理、物理页分配器 |
| **进程管理** | `proc.c`, `swtch.S`, `trampoline.S` | 进程调度、上下文切换、最多 50 个进程、2 核 SMP |
| **中断/异常处理** | `trap.c`, `kernelvec.S`, `intr.c`, `timer.c` | 陷阱处理、定时器中断 |
| **系统调用** | `syscall.c`, `sysproc.c`, `sysfile.c` | 约 40+ 个系统调用 |
| **文件系统** | `fat32.c`, `bio.c`, `file.c`, `exec.c` | FAT32 文件系统实现 |
| **管道** | `pipe.c` | 进程间通信 |
| **设备驱动** | `virtio_disk.c`, `disk.c`, `console.c`, `plic.c` | VirtIO 磁盘、控制台、PLIC 中断控制器 |
| **K210 专用驱动** | `spi.c`, `gpiohs.c`, `fpioa.c`, `sdcard.c`, `dmac.c`, `sysctl.c` | SD 卡、SPI、GPIO、DMA 等 |
| **用户程序** | `xv6-user/` | shell、cat、ls、grep 等约 20 个用户程序 |

### 3. 系统调用列表 (基于 sysnum.h)

项目实现了约 **45 个系统调用**，包括：
- 进程管理: `fork`, `exit`, `wait`, `clone`, `exec`, `execve`, `kill`, `getpid`, `getppid`
- 文件操作: `open`, `openat`, `read`, `write`, `close`, `mkdir`, `mkdirat`, `remove`, `rename`
- 内存管理: `sbrk`, `mmap`, `munmap`
- 其他: `pipe`, `pipe2`, `dup`, `dup3`, `times`, `uname`, `sched_yield`, `gettimeofday`, `mount`, `umount2` 等

### 4. 构建工具需求

| 工具 | 用途 |
|------|------|
| `riscv64-linux-gnu-gcc` | C 交叉编译器 |
| `riscv64-linux-gnu-ld` | 链接器 |
| `riscv64-linux-gnu-objcopy` | 二进制转换 |
| `riscv64-linux-gnu-objdump` | 反汇编 |
| `qemu-system-riscv64` | RISC-V 模拟器 |
| `make` | 构建系统 |
| `cargo/rustc` | 编译 RustSBI (可选) |
| `mkfs.vfat` | 创建 FAT32 文件系统镜像 |
| `dd` | 磁盘镜像操作 |

### 5. 代码规模统计

内核 C/汇编代码总计约 **16,500 行**，其中：
- `fpioa.c`: 4,943 行 (K210 引脚复用，最大文件)
- `proc.c`: 1,553 行 (进程管理)
- `fat32.c`: 1,378 行 (FAT32 文件系统)
- `sysfile.c`: 1,248 行 (文件系统相关系统调用)
- `vm.c`: 853 行 (虚拟内存)

### 6. 项目特点

1. **双平台支持**: 通过条件编译 (`#ifdef QEMU`) 支持 QEMU 和 K210
2. **FAT32 文件系统**: 替代了原版 xv6 的简单文件系统
3. **红黑树**: 引入了 Linux 内核的红黑树实现 (`rbtree.c`)
4. **SMP 支持**: 支持多核处理器 (默认 2 核)
5. **虚拟内存**: 使用 Sv39 分页机制，物理内存范围 0x80200000 - 0x80600000 (4MB)