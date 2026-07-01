## ASVOS 内核项目初步调查报告

### 项目概述

ASVOS 是一个用 C 语言编写的、面向 RISC-V 架构的宏内核操作系统，基于 uCore-ch8 分支进行大幅修改和重构。项目参加了 OS 内核比赛，目标平台包括 QEMU 模拟器和 StarFive VisionFive 2 (VF2) 开发板。

---

### 仓库文件组织结构

```
.
├── bootloader/          # SBI 固件（RustSBI QEMU 二进制）
├── docs/                # 比赛各阶段文档与技术说明
├── include/             # 内核头文件
│   ├── dev/             #   设备驱动头文件
│   ├── fs/              #   文件系统头文件（含 ext4 子目录）
│   ├── lib/             #   内核库头文件
│   ├── mm/              #   内存管理头文件
│   ├── sched/           #   进程调度头文件
│   └── syscall/         #   系统调用头文件
├── init/                # 初始化脚本（usershell、busybox 等启动配置）
├── scripts/             # 构建脚本与链接器脚本
├── src/                 # 内核源码
│   ├── boot/            #   启动代码
│   ├── dev/             #   设备驱动
│   ├── fs/              #   文件系统实现（含 ext4 子目录）
│   ├── lib/             #   内核工具库
│   ├── mm/              #   内存管理
│   ├── sched/           #   进程调度与中断处理
│   └── syscall/         #   系统调用实现
├── user/                # 用户态程序与 C 库
│   ├── include/         #   用户态头文件
│   ├── lib/             #   用户态 C 库（syscall、stdio、stdlib 等）
│   └── src/             #   用户态应用程序
├── Makefile             # 顶层构建文件
└── README.md
```

---

### 子系统划分

| 子系统 | 源码目录 | 头文件目录 | 主要文件 | 功能描述 |
|--------|----------|------------|----------|----------|
| **启动引导** | `src/boot/` | — | `entry_qemu.S`, `entry_vf2.S`, `main.c` | 内核入口汇编与初始化主函数 |
| **设备驱动** | `src/dev/` | `include/dev/` | `virtio_disk.c`, `sdcard.c`, `plic.c`, `timer.c`, `sbi.c`, `fdt.c`, `disk.c` 等 | VirtIO 块设备、SD 卡（VF2）、PLIC 中断控制器、定时器、SBI 接口、FDT 解析 |
| **文件系统** | `src/fs/`, `src/fs/ext4/` | `include/fs/`, `include/fs/ext4/` | `fat32.c`, `fs.c`, `file.c`, `bio.c`, `pipe.c`, `console.c`, `nfs.c`, ext4 系列（移植自 lwext4） | FAT32、ext4（移植）、VFS 抽象层、块 I/O、管道、控制台设备 |
| **内存管理** | `src/mm/` | `include/mm/` | `kalloc.c`, `malloc.c`, `vm.c` | 物理页分配、堆内存分配、虚拟内存与页表管理 |
| **进程调度** | `src/sched/` | `include/sched/` | `proc.c`, `queue.c`, `signal.c`, `sync.c`, `trap.c`, `intr.c`, `switch.S`, `trampoline.S`, `kernelvec.S` | 进程/线程管理、调度队列、信号机制、同步互斥、陷阱/中断处理、上下文切换 |
| **系统调用** | `src/syscall/` | `include/syscall/` | `syscall.c`, `syscall_ids.h` | 系统调用分发与实现 |
| **内核库** | `src/lib/` | `include/lib/` | `printf.c`, `string.c`, `stdlib.c`, `elfloader.c`, `binloader.c`, `utils.c` | 内核 printf、字符串操作、ELF/BIN 加载器、工具函数 |
| **用户态** | `user/` | `user/include/` | `user/lib/`（C 库）, `user/src/`（应用程序） | 用户态 C 库（syscall 封装、stdio、stdlib）、测试程序与 shell |

---

### 构建工具需求

| 工具 | 用途 | Makefile 中指定 |
|------|------|-----------------|
| `riscv64-unknown-elf-gcc` | C 编译器与汇编器 | `CC`, `AS` |
| `riscv64-unknown-elf-ld` | 链接器 | `LD` |
| `riscv64-unknown-elf-objcopy` | 目标文件转换 | `OBJCOPY` |
| `riscv64-unknown-elf-objdump` | 反汇编与符号表导出 | `OBJDUMP` |
| `riscv64-unknown-elf-gdb` | 调试器 | `GDB` |
| `qemu-system-riscv64` | RISC-V 64 位模拟器 | `QEMU` |
| `python3` | 构建辅助脚本（initproc 生成等） | `PY` |
| RustSBI (`rustsbi-qemu.bin`) | SBI 固件，作为 QEMU bios | 已预编译存放于 `bootloader/` |

内核链接基地址为 `0x80200000`，入口符号为 `_entry`。构建支持两种架构目标：`qemu`（默认）和 `vf2`（开发板），通过 `ARCH` 变量切换，不同架构会包含/排除对应的设备驱动源文件。

用户态程序使用独立的 CMake/Make 构建系统（`user/CMakeLists.txt` 和 `user/Makefile`），使用相同的 RISC-V 交叉编译工具链。