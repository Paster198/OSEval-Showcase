# StarsOS 项目初步调查报告

## 一、项目概述

StarsOS 是一个基于 RISC-V 架构的类 Unix 操作系统内核，由中国科学技术大学交流生（西南科技大学）开发，面向 OS 内核比赛。项目使用 C 语言编写，运行于 QEMU 模拟的 RISC-V 64 位 virt 机器上，采用 OpenSBI 作为引导固件。

内核代码总量约 14,645 行（`.c` 和 `.S` 文件），头文件约 5,588 行，用户态库约 666 行。

## 二、仓库文件组织结构

```
.
├── Makefile              # 主构建文件
├── include.mk            # 构建配置（被 Makefile 包含）
├── README.md             # 项目说明
├── StarsOS-说明文档.md    # 项目说明文档
├── kernel/               # 内核源码（核心）
│   ├── boot/             # 引导启动
│   ├── dev/              # 设备驱动
│   ├── fs/               # 文件系统
│   ├── futex/            # Futex 同步机制
│   ├── ipc/              # 进程间通信
│   ├── lib/              # 内核工具库
│   ├── lock/             # 锁机制
│   ├── mm/               # 内存管理
│   ├── proc/             # 进程/线程管理
│   ├── signal/           # 信号机制
│   ├── syscall/          # 系统调用
│   └── trap/             # 异常/中断处理
├── include/              # 头文件（与 kernel/ 子目录一一对应）
│   ├── arch/riscv/       # RISC-V 架构相关
│   ├── asm/              # 汇编相关
│   ├── dev/              # 设备驱动头文件
│   ├── fs/               # 文件系统头文件
│   ├── futex/            # Futex 头文件
│   ├── ipc/              # IPC 头文件
│   ├── lib/              # 库头文件
│   ├── lock/             # 锁头文件
│   ├── mm/               # 内存管理头文件
│   ├── proc/             # 进程管理头文件
│   ├── signal/           # 信号头文件
│   ├── sys/              # 系统调用/错误码头文件
│   ├── trap/             # 陷阱头文件
│   └── user/             # 用户态接口头文件
├── user/                 # 用户态运行时库（syscall封装、stdio、stdlib等）
├── linker/               # 链接脚本
│   ├── kernel.ld         # 内核链接脚本（入口 0x80200000）
│   └── user.ld           # 用户程序链接脚本（入口 0x10000）
├── scripts/              # 构建辅助脚本
│   └── bin_to_c.py       # 将 ELF 二进制转为 C 数组
├── docs/                 # 参考文档（PDF）
├── riscv-syscalls-testing/  # 测试用例仓库（含交叉编译工具链）
└── tmp/                  # 临时文件目录
```

## 三、子系统划分

根据目录结构和代码文件分布，项目实现了以下子系统：

| 子系统 | 对应目录 | 主要文件 | 代码行数（约） | 说明 |
|--------|----------|----------|---------------|------|
| **引导启动** | `kernel/boot/` | `initial_entry.S`, `kernel_start.c` | ~250 | 汇编入口 + C 语言内核初始化 |
| **设备驱动** | `kernel/dev/` | `uart.c`, `virtio.c`, `disk.c`, `plic.c`, `timer.c`, `console.c` | ~900 | UART串口、VirtIO块设备/网络、PLIC中断控制器、定时器 |
| **文件系统** | `kernel/fs/` | `fat32/`, `fd/`, `devfs/`, `proc/`, `socket.c`, `buf.c`, `cluster.c` | ~4,500 | FAT32文件系统、VFS抽象层、文件描述符管理、管道、设备文件系统、proc文件系统、Socket |
| **内存管理** | `kernel/mm/` | `pmm.c`, `vmm.c`, `kmalloc.c`, `vmtools.c` | ~800 | 物理页帧管理、虚拟内存/页表管理、内核堆分配 |
| **进程/线程管理** | `kernel/proc/` | `proc_interface.c`, `thread.c`, `sched.c`, `switch.S`, `wait.c`, `sleep.c`, `times.c` | ~1,800 | 进程创建/销毁、线程管理、调度器、上下文切换、等待/睡眠 |
| **系统调用** | `kernel/syscall/` | `sys_entry.c`, `sys_fs.c`, `sys_proc.c`, `sys_mm.c`, `sys_mmap.c`, `sys_socket.c` 等 | ~2,500 | 系统调用入口及分发，覆盖文件、进程、内存、信号、调度、Socket等 |
| **异常/中断处理** | `kernel/trap/` | `trampoline.S`, `kernel_vector.S`, `user_trap.c`, `kernel_trap.c`, `trap_timer.c`, `trap_page_fault.c` | ~800 | 用户态/内核态陷阱处理、定时器中断、缺页异常 |
| **信号机制** | `kernel/signal/` | `signal.c`, `itimer.c`, `signaltrampoline.S` | ~500 | POSIX 信号处理、间隔定时器 |
| **Futex** | `kernel/futex/` | `futex_event.c`, `futex_interface.c` | ~200 | 快速用户态互斥锁 |
| **IPC** | `kernel/ipc/` | `shm.c` | ~100 | 共享内存 |
| **锁机制** | `kernel/lock/` | `mutex.c` | ~100 | 互斥锁 |
| **内核工具库** | `kernel/lib/` | `printf.c`, `vprint.c`, `string.c`, `elf.c`, `hashmap.c`, `wchar.c`, `elf.c` | ~1,500 | 格式化输出、字符串操作、ELF解析、哈希表、宽字符 |
| **用户态库** | `user/` | `syscallLib.c`, `stdio.c`, `stdlib.c`, `string.c`, `main.c`, `clone.S` | ~670 | 系统调用封装、标准I/O、字符串、程序入口 |

## 四、构建工具需求

| 工具 | 用途 | 备注 |
|------|------|------|
| **riscv64-unknown-elf-gcc** | C 编译器 | 使用仓库内附带的 kendryte-toolchain 或系统 PATH 中的版本 |
| **riscv64-unknown-elf-ld** | 链接器 | 同上 |
| **riscv64-unknown-elf-objcopy** | 二进制转换 | 同上 |
| **GNU Make** | 构建系统 | 主 Makefile + include.mk |
| **Python3** | 辅助脚本 | `scripts/bin_to_c.py` 将用户程序 ELF 嵌入内核 |
| **qemu-system-riscv64** | 模拟器运行 | QEMU virt 机器，OpenSBI 固件 |
| **dd / mkfs.vfat / mount** | 文件系统镜像制作 | 制作 FAT32 格式的 sdcard.img |
| **GDB** (riscv64) | 调试 | 可选，用于 `make debug` |

构建流程概要：
1. 编译用户态程序为 `user.elf`（使用 `linker/user.ld` 链接）
2. 通过 `bin_to_c.py` 将 `user.elf` 转为 C 数组源文件 `user.c`，再编译为 `user.x`
3. 编译所有内核 `.c` 和 `.S` 文件
4. 使用 `linker/kernel.ld` 将内核目标文件与 `user.x` 链接为最终内核镜像 `kernel-qemu`
5. 制作 FAT32 格式的 `sdcard.img` 磁盘镜像（包含测试用例文件）

## 五、初步观察

- **架构**：纯 RISC-V 64 位，目标机器为 QEMU virt 平台，使用 SBI 接口与固件交互。
- **文件系统**：实现了较完整的 FAT32 文件系统，并在此基础上构建了 VFS 抽象层，支持设备文件（null、zero、urandom、tty、vda）、proc 文件系统（meminfo、mounts）和 Socket。
- **进程模型**：支持多进程和多线程，包含调度器、上下文切换、fork/clone/exec/wait 等核心机制。
- **系统调用覆盖面广**：从 `sysnames.c`（289行）和多个 `sys_*.c` 文件来看，系统调用数量较多，覆盖文件操作、进程管理、内存映射、信号、Socket、Futex、IPC 等。
- **用户程序嵌入方式**：用户程序被编译为 ELF 后以 C 数组形式嵌入内核镜像，属于静态嵌入方式。
- **代码规模**：内核约 1.5 万行 C/汇编代码，属于中等规模的竞赛级 OS 内核项目。