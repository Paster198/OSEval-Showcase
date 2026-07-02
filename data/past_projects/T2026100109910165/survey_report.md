现在我已经拥有了足够的信息来完成初步分析。以下是我的报告。

---

# OSKernel2026 项目初步调查报告

## 1. 仓库文件组织结构

项目位于仓库根目录，包含以下顶层单元：

```
.
├── Makefile                  # 顶层构建文件（RISC-V + LoongArch）
├── Dockerfile                # 比赛统一构建镜像
├── LICENSE                   # BSD-3-Clause
├── README.md                 # 项目说明
├── arch/
│   ├── riscv/                # RISC-V 架构相关代码（7 源文件 + 1 链接脚本）
│   └── loongarch/            # LoongArch 架构相关代码（5 源文件 + 1 链接脚本）
├── include/                  # 平台无关公共头文件（8 个头文件）
├── kernel/                   # 平台无关内核核心代码（18 个源文件 + 13 个头文件）
├── scripts/                  # 运行与调试脚本（3 个脚本）
└── docs/                     # 设计文档、开发指南、变更日志（6 个 Markdown 文件）
```

总代码量约 22,281 行（含汇编与头文件），其中 kernel/ 约 6,900 行 C + 约 1,000 行头文件，arch/riscv/ 约 15,600 行（含 trap.c ~7,068 行、trapbk.c ~6,799 行），arch/loongarch/ 约 250 行。

## 2. 子系统划分

根据代码结构、`#include` 依赖关系和 `kmain` 初始化顺序，可识别出以下子系统：

### 2.1 启动与平台抽象层（Platform Layer）

| 目录/文件 | 作用 |
|-----------|------|
| `include/platform.h` | 平台无关接口：串口输出、关机、DMA 地址转换、IO 屏障、VirtIO MMIO 基址、物理内存上限、分页初始化 |
| `arch/riscv/platform.c` | RISC-V QEMU virt 平台实现：UART0、VirtIO MMIO、2GB DRAM、SBI 关机 |
| `arch/loongarch/platform.c` | LoongArch QEMU virt 平台实现：UART0、VirtIO MMIO、448MB DRAM、ACPI GED 关机 |
| `arch/riscv/entry.S` | RISC-V 内核入口点汇编 |
| `arch/loongarch/entry.S` | LoongArch 内核入口点汇编 |
| `arch/riscv/linker.ld` | RISC-V 链接脚本 |
| `arch/loongarch/linker.ld` | LoongArch 链接脚本 |

### 2.2 内存管理（Memory Management）

| 目录/文件 | 作用 |
|-----------|------|
| `kernel/mm.c` + `kernel/mm.h` | 页分配器、堆分配器（基于空闲链表）、页对齐与清零 |
| `include/uaccess.h` + `kernel/uaccess.c` | 用户态/内核态数据拷贝安全接口 |

该子系统提供 `kmalloc`/`kfree` 风格的堆分配和物理页分配。RISC-V 路径额外在 `arch/riscv/user.c` 中实现 Sv39 页表构建和用户地址空间管理。

### 2.3 虚拟文件系统（VFS）

| 目录/文件 | 作用 |
|-----------|------|
| `kernel/vfs.c` + `kernel/vfs.h` | 核心 VFS：super_block、inode、dentry、file、挂载点管理，文件/目录操作，路径解析，文件描述符分配，全局文件表 |
| `include/errno.h` | POSIX 风格错误码（EPERM、ENOENT 等约 80+ 定义） |
| `include/open_flags.h` | open() 标志位定义（O_RDONLY、O_CREAT、O_CLOEXEC 等） |

VFS 是最大的内核模块（`vfs.c` 约 1,815 行），提供统一的文件对象模型。所有后续文件系统都通过 `file_operations`、`inode_operations`、`super_operations` 接口注册。

### 2.4 文件系统实现

| 目录/文件 | 类型 | 行数 | 说明 |
|-----------|------|------|------|
| `kernel/ext4.c` + `kernel/ext4.h` | EXT4（只读） | ~1,275 | EXT4 超级块解析、inode 读取、extent 遍历、目录项读取、测试脚本执行 |
| `kernel/tmpfs.c` + `kernel/tmpfs.h` | tmpfs | ~415 | 内存驻留临时文件系统，支持读写、目录、文件的简易实现 |
| `kernel/devfs.c` + `kernel/devfs.h` | devfs | ~332 | 设备文件系统，挂载于 `/dev` |
| `kernel/console.c` + `kernel/console.h` | 控制台 | ~22 | 控制台设备文件，提供 stdin/stdout 通道 |
| `kernel/pipe.c` + `kernel/pipe.h` | 管道 | ~129 | 进程间管道通信，通过 VFS 的 file_operations 暴露 |

### 2.5 块设备驱动

| 目录/文件 | 作用 |
|-----------|------|
| `kernel/virtio_blk.c` + `kernel/virtio_blk.h` | VirtIO 块设备 MMIO 驱动，提供扇区级读写接口，供 EXT4 使用 |

### 2.6 进程管理（Process Management）

| 目录/文件 | 作用 |
|-----------|------|
| `kernel/proc.c` + `include/process.h` | 进程表管理、PID 分配、文件描述符表、管道表、内存文件表、信号槽、进程状态机 |
| `include/user.h` | 用户空间描述结构体：`user_space`、`user_load_segment`、`user_tls_template` |
| `arch/riscv/user.c` | RISC-V Sv39 用户地址空间构建：页表创建、stack/heap/tls/vdso 映射、aux 向量设置 |
| `arch/loongarch/user.c` | LoongArch 占位（函数体返回 false，参数全 (void) 忽略） |
| `arch/riscv/sched.c` | RISC-V 调度器：上下文切换、首次用户帧初始化、satp 切换 |

进程表容量为 64 个进程，每进程最多 128 个文件描述符，512 个 mmap 区域，128 个管道。进程状态机包含：UNUSED、READY、RUNNING、WAITING、ZOMBIE、DEAD。

### 2.7 ELF 加载器

| 目录/文件 | 作用 |
|-----------|------|
| `kernel/elf.c` + `kernel/elf.h` | ELF64 解析：ELF header、program header、PT_LOAD/PT_INTERP/PT_TLS 段处理、动态解释器加载、shebang 脚本支持 |

### 2.8 系统调用与异常处理（Arch-Specific Trap/Syscall）

| 目录/文件 | 作用 |
|-----------|------|
| `arch/riscv/trap.c` | 核心系统调用分发（~7,068 行）：约 70+ 系统调用号，涵盖文件、进程、信号、定时器、内存、socket 等 |
| `arch/riscv/trap_entry.S` | 异常入口汇编：保存/恢复上下文 |
| `arch/riscv/trap.h` | `riscv_trap_frame` 结构定义，trap 处理函数声明 |
| `arch/riscv/trapbk.c` | 备用的 trap 处理实现（~6,799 行，可能为实验备份） |
| `arch/loongarch/trap.c` | LoongArch 占位（只有空的 `scheduler`、`fork_ret`、`loongarch_trap_placeholder`） |

### 2.9 时钟与定时器

| 目录/文件 | 作用 |
|-----------|------|
| `arch/riscv/timer.c` | RISC-V SBI timer 扩展：定时器中断处理、tick 计数、微秒时间 |
| `arch/loongarch/timer.c` | LoongArch 占位定时器 |
| `include/timer.h` | 时钟 ID 定义（CLOCK_REALTIME、CLOCK_MONOTONIC 等）、timespec 结构 |

### 2.10 辅助模块

| 目录/文件 | 作用 |
|-----------|------|
| `kernel/print.c` + `kernel/print.h` | 内核打印：`kputs`/`kprintf` 通过 `platform_putc` 输出 |
| `kernel/string.c` + `kernel/string.h` | 基础字符串操作：`kmemcpy`、`kmemset`、`kstrlen`、`kstrcmp` 等 |
| `include/syslog.h` | syslog 设施码与优先级定义 |
| `kernel/main.c` | 内核入口 `kmain`：串联所有子系统初始化 |

## 3. 子系统依赖关系

子系统间的依赖大致遵循以下自顶向下的分层结构（从 README 和 design.md 确认）：

```
用户程序
  → ecall
体系结构 trap / syscall (arch/*/trap.c, arch/*/trap_entry.S)
  → 进程、内存、信号 (kernel/proc.c, kernel/mm.c, arch/*/user.c, arch/*/sched.c)
    → VFS / ELF / 文件描述符 (kernel/vfs.c, kernel/elf.c)
      → EXT4 / tmpfs / devfs / pipe / console (kernel/ext4.c, kernel/tmpfs.c, ...)
        → VirtIO 块设备 (kernel/virtio_blk.c)
          → QEMU 虚拟硬件 (通过 include/platform.h)
```

## 4. 构建工具需求

根据 `Makefile` 分析：

| 构建目标 | 所需工具 |
|----------|----------|
| `kernel-rv`（RISC-V） | `riscv64-unknown-elf-gcc`（裸机交叉编译器）+ `riscv64-unknown-elf-objcopy` |
| `kernel-la`（LoongArch） | `loongarch64-linux-gnu-gcc` + `loongarch64-linux-gnu-objcopy` |
| musl 动态加载器嵌入（可选） | `/opt/riscv64-linux-musl-cross/.../libc.so`（由 RISC-V musl 工具链提供） |
| 运行（RISC-V） | `qemu-system-riscv64`（QEMU virt 机器，OpenSBI 固件） |
| 运行（LoongArch） | `qemu-system-loongarch64` |
| 容器构建 | Docker（镜像 `zhouzhouyi/os-contest:20260104`） |

编译选项均为 freestanding C（`-ffreestanding -fno-builtin -nostdlib`），无标准库依赖。RISC-V 使用 `-march=rv64gc -mabi=lp64d -mcmodel=medany`，LoongArch 使用 `-march=loongarch64 -mabi=lp64d`。

## 5. 实现完成度摘要

| 子系统 | RISC-V | LoongArch |
|--------|--------|-----------|
| 启动与串口 | 完成 | 完成 |
| 内存分配（堆/页） | 完成 | 完成（共用 kernel/mm.c） |
| 分页/用户地址空间 | Sv39 完成 | 未实现（user.c 为占位） |
| VirtIO 块设备 | 完成 | 未验证 |
| EXT4（只读） | 完成 | 未验证（共用 kernel/ext4.c） |
| VFS/文件系统挂载 | 完成 | 共用代码，未验证用户态 |
| ELF 加载器 | 完成 | 共用代码，未验证 |
| 进程管理/调度 | 完成（轮转调度，单核） | 未实现 |
| 系统调用（~70+） | 基本完成 | 未实现（trap.c 为空） |
| 信号/futex/管道 | 最小实现 | 未实现 |
| socket 接口 | 最小兼容实现 | 未实现 |