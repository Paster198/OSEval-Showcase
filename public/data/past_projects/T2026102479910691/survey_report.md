# OS 内核项目初步分析报告

## 一、项目概览

该项目名为 **OSKernel2026-X**，是一个面向竞赛/教学场景的微型操作系统内核。项目整体规模约 **2232 行代码**（含汇编、C、头文件、链接脚本及 Makefile），采用平面化目录结构，所有内核源码集中在单一 `kernel/` 目录下。

## 二、文件组织结构

```
repo/
├── .gitignore           # 忽略 *.o, *.img, kernel-rv, kernel-la, testsuits/
├── Makefile             # 构建脚本
├── README.md            # 项目说明（模板，未填写实质内容）
├── linker.ld            # RISC-V 内核链接脚本（入口 0x80200000）
├── la_linker.ld         # LoongArch 内核链接脚本（入口 0x90000000）
├── run.sh               # 快速运行脚本（Docker 方式）
└── kernel/
    ├── types.h           # 基础类型定义
    ├── uart.c / uart.h   # UART 串口驱动
    ├── mm.c / mm.h       # 内存管理
    ├── proc.c / proc.h   # 进程管理
    ├── trap.c / trap.h   # 陷阱处理（C 部分）
    ├── trap_entry.S      # 陷阱入口/返回（汇编）
    ├── syscall.c / syscall.h  # 系统调用
    ├── elf.c / elf.h     # ELF 加载器
    ├── virtio.c / virtio.h    # VirtIO 块设备驱动
    ├── ext4.c / ext4.h   # EXT4 文件系统（只读）
    ├── start.S           # 内核启动入口（汇编）
    ├── main.c            # 内核主函数
    ├── la_entry.S        # LoongArch 最小启动桩
    └── test_user.S       # 嵌入式用户态测试程序
```

## 三、子系统划分

### 1. 启动与初始化子系统
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/start.S` | 96 | RISC-V 内核入口 `_start`，BSS 清零，构建 Sv39 恒等映射页表（含 2MB 大页），启用分页后跳转 `kmain` |
| `linker.ld` | 28 | RISC-V 链接脚本，入口 `_start`，加载地址 `0x80200000`，预留 16KB 内核栈 |
| `kernel/main.c` | 131 | 内核主函数 `kmain`，初始化各子系统，驱动测试流程 |

### 2. 基础类型定义 (`kernel/types.h`, 22 行)
定义 `uint8`-`uint64`、`int8`-`int64`、`size_t`、`ssize_t`、`uintptr_t`、`intptr_t`、`pid_t` 及 `NULL`。

### 3. 串口驱动子系统
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/uart.h` | 8 | 声明 `uart_init`、`uart_putc`、`uart_puts` |
| `kernel/uart.c` | 33 | NS16550 兼容 UART，基址 `0x10000000`，轮询方式输出 |

### 4. 内存管理子系统 (MM)
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/mm.h` | 44 | 定义页大小 `PAGE_SIZE`(4096)、PTE 标志位、Sv39 三级页表结构、内存布局常量 |
| `kernel/mm.c` | 113 | 物理页分配器（`kalloc_page`/`kfree_page`/`kalloc_zero`），Sv39 页表操作（`uvm_create`/`uvm_map`/`uvm_alloc`/`uvm_free`/`walk_pgtbl`） |

内存布局：内核驻留 `0x80200000`-`0x80800000`（6MB），物理内存上限 `0x88000000`（128MB），用户栈顶 `0x80000000`。

### 5. 进程管理子系统
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/proc.h` | 54 | 定义进程状态枚举（UNUSED/EMBRYO/RUNNING/SLEEPING/RUNNABLE/ZOMBIE）、`struct file`、`struct proc`、文件描述符表 |
| `kernel/proc.c` | 131 | 进程表（最多 64 进程）、进程分配/释放、调度器框架、文件描述符管理 |

每个进程持有独立页表 (`pgtbl`)、内核栈 (`kstack[512]`)、最多 16 个打开文件描述符。

### 6. 陷阱/中断处理子系统
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/trap.h` | 29 | 定义 `struct trapframe`（含 32 个通用寄存器 + sepc + sstatus） |
| `kernel/trap_entry.S` | 111 | 陷阱入口汇编：保存/恢复完整寄存器上下文、sscratch 交换机制、`sret` 返回 |
| `kernel/trap.c` | 93 | C 层陷阱分发（`trap_handler`），处理 `ecall from U/S`、时钟中断，初始化 `stvec`/`sie` |

### 7. 系统调用子系统
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/syscall.h` | 41 | 定义 ~30 个系统调用号（遵循 Linux RISC-V ABI） |
| `kernel/syscall.c` | 495 | 系统调用分发与实现，包括文件 I/O、进程控制、内存管理、时间等 |

实现的主要系统调用：`read`、`write`、`openat`、`close`、`exit`、`brk`、`mmap`、`munmap`、`execve`、`clone`、`wait4`、`getpid`、`getdents64`、`dup`/`dup3`、`pipe2`、`mount`/`umount2`、`chdir`、`mkdirat`、`unlinkat`、`sched_yield`、`nanosleep`、`times`、`uname`、`gettimeofday` 等。

### 8. ELF 加载子系统
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/elf.h` | 50 | 定义 `elf64_hdr`、`elf64_phdr` 结构体及常量 |
| `kernel/elf.c` | 99 | ELF64 解析与加载（验证魔数、架构、加载 LOAD 段到进程地址空间） |

### 9. VirtIO 块设备驱动
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/virtio.h` | 11 | 声明 `virtio_init`、`virtio_read`、`virtio_open`、`blk_dev_ready` |
| `kernel/virtio.c` | 285 | MMIO 接口 VirtIO 块设备驱动，参考 xv6-riscv，支持扇区读写 |

### 10. EXT4 文件系统（只读）
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/ext4.h` | 10 | 声明 `ext4_init`、`ext4_open`、`ext4_list_root`、`ext4_scan_testcode` |
| `kernel/ext4.c` | 232 | 最小只读 EXT4 驱动，解析超级块、块组描述符、inode，支持目录遍历和文件读取 |

### 11. LoongArch 桩代码
| 文件 | 代码行数 | 说明 |
|------|----------|------|
| `kernel/la_entry.S` | 27 | 最小 LoongArch64 启动代码：输出 "LA" 到 UART 后尝试 ACPI 关机 |
| `la_linker.ld` | 15 | LoongArch 链接脚本，入口 `0x90000000` |

### 12. 用户态测试桩 (`kernel/test_user.S`, 21 行)
汇编实现的极小用户态测试程序：通过 `write` 系统调用输出 "Hello from user mode!" 后调用 `exit`。

## 四、构建工具需求

通过分析 `Makefile`，构建该项目需要以下工具：

| 工具 | 用途 |
|------|------|
| **riscv64-unknown-elf-gcc** | RISC-V 裸机交叉编译器，编译内核 C/汇编源文件 |
| **loongarch64-linux-musl-gcc** | LoongArch 交叉编译器（路径 `/opt/loongarch64-linux-musl-cross/bin/`），编译 LoongArch 桩 |
| **GNU Make** | 构建自动化 |
| **qemu-system-riscv64** | RISC-V QEMU 虚拟机，运行内核 |

RISC-V 编译选项：`-march=rv64imafdc -mabi=lp64d -mcmodel=medany`，目标为 RISC-V 64 位 GC 扩展（含浮点和压缩指令）。

运行命令使用 `qemu-system-riscv64 -machine virt`，配置 128MB 内存，挂载 VirtIO 块设备（`ext4-test.img`），无图形界面。

## 五、初步总结

该项目是一个结构清晰、规模紧凑的教学型/竞赛型 OS 内核，具有以下特征：

1. **目标架构**：主要面向 RISC-V 64 位（Sv39 虚拟内存），附带一个极简 LoongArch 桩。
2. **子系统覆盖**：内存管理（物理/虚拟）、进程管理、陷阱/中断、系统调用（~30 个）、ELF 加载、VirtIO 块设备、EXT4 只读文件系统、UART 驱动。
3. **代码组织**：平面目录结构，每个子系统由 `.c` + `.h` 对构成，无嵌套模块。
4. **外部依赖**：仅有交叉编译工具链和 QEMU，无第三方库依赖。
5. **参考实现**：VirtIO 驱动注释标明参考 xv6-riscv，整体设计风格与 xv6 类似。
6. **测试框架**：`main.c` 内置了 12 个测试组名（basic、busybox、lua、libctest、iozone、unixbench、iperf、libcbench、lmbench、netperf、cyclictest、ltp），支持从 EXT4 磁盘镜像扫描测试用例或回退到内置列表。