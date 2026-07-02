## 项目探索报告：OSKernel2026-LastWhisper（"最后的轻语"）

---

### 一、项目概览

该项目为 2026 年全国大学生计算机系统能力大赛操作系统设计赛（内核实现赛道）参赛作品，队伍名"最后的轻语"。项目基于公开的 `xv6-riscv` 衍生基线（Re-Xvapor）继续开发，以 **RISC-V 为主得分架构**，LoongArch 为辅助架构。

**项目目标**：构建一条可构建、可启动、可运行、可稳定返回成绩的工程闭环。具体包括：
- 根目录 `make all` 生成 `kernel-rv`（RISC-V）与 `kernel-la`（LoongArch）内核 ELF；
- RISC-V 为主得分架构，通过 QEMU/OpenSBI 启动，挂载 EXT4 测试镜像，运行 Linux 静态 ELF 用户程序；
- 支持 `basic-musl`、`basic-glibc`、`libctest-musl`、`lua-musl`、`busybox-glibc`、`busybox-musl` 测试组。

---

### 二、文件组织结构

```
/
├── Makefile                  # 顶层 Makefile（构建入口）
├── README.md                 # 项目说明
├── PLAN-final.md             # 最终执行计划与总结
├── ROUTE.md                  # 开发路线文档
├── LICENSE                   # 许可证
├── Dockerfile                # Docker 构建环境
├── .clang-format / .editorconfig / .gitignore  # 工程配置文件
├── conf/
│   └── lab.mk                # 实验配置（仅含 LAB=util）
├── include/
│   └── wait.h                # 顶层共享头文件（用户态 wait 相关）
├── kernel/                   # 内核源码（主体）
│   ├── Makefile              # 内核构建规则
│   ├── syscall.c             # 系统调用分发（参数解析）
│   ├── sysproc.c             # 进程相关系统调用实现
│   ├── sysother.c            # 其他杂项系统调用实现
│   ├── arch/                 # 架构相关代码
│   │   ├── riscv/            # RISC-V 架构（entry.S, kernelvec.S, trampoline.S 等）
│   │   ├── loongarch/        # LoongArch 架构（pci, ahci, 中断等外设驱动）
│   │   └── qemu/             # QEMU 通用外设（console, plic, uart）
│   ├── atomic/               # 同步原语
│   ├── fs/                   # 文件系统
│   │   ├── vfs/              # VFS 抽象层
│   │   ├── ext4*.c           # EXT4 文件系统实现（含日志、extent、目录索引等）
│   │   ├── xv6fs.c           # xv6 原生文件系统
│   │   ├── procfs.c          # procfs 伪文件系统
│   │   ├── virtio_disk.c     # virtio-blk 块设备驱动
│   │   └── sysfile.c         # 文件相关系统调用
│   ├── include/              # 内核头文件（~110个头文件）
│   ├── init/                 # 内核初始化
│   ├── ipc/                  # 进程间通信（futex, pipe, signal）
│   ├── lib/                  # 内核库函数（printf, string, qsort, snprintf, queue）
│   ├── mm/                   # 内存管理（kalloc, vm, mmap）
│   └── sched/                # 调度与进程/线程管理（proc, sched, thread, trap）
├── user/                     # 用户态程序
│   ├── Makefile              # 用户程序构建规则
│   ├── user.ld / loongarch_user.ld  # 用户程序链接脚本
│   ├── usys.pl / loongarch_usys.pl  # 系统调用桩生成脚本
│   ├── asm/
│   │   └── initcode.S        # init 进程入口汇编
│   ├── init/
│   │   └── init.c            # 用户态 init 进程（主要测试编排）
│   ├── lib/                  # 用户态库（printf, ulib, umalloc）
│   ├── include/
│   │   └── user.h            # 用户态头文件
│   └── src/                  # 独立用户程序（echo, forktest, ln, mkdir, rm 等）
├── scripts/                  # 构建与运行辅助脚本
│   ├── syscall.tbl           # 系统调用号表（约80+系统调用）
│   ├── sysgen.sh             # 系统调用代码生成脚本
│   ├── run-qemu-rv.sh        # RISC-V QEMU 启动脚本
│   ├── build-kernel-la-minimal.sh  # LoongArch 最小内核构建脚本
│   ├── check-env.sh          # 环境检查脚本
│   └── ...                   # 其他辅助脚本
└── docs/                     # 项目文档（设计文档、测试结果、图片等）
```

---

### 三、子系统划分

根据目录结构和代码分布，该项目实现了以下子系统：

| 子系统 | 主要目录/文件 | 规模（源文件数） | 职责 |
|---|---|---|---|
| **架构层（Arch）** | `kernel/arch/riscv/`, `kernel/arch/loongarch/`, `kernel/arch/qemu/` | ~25 个 .c/.S 文件 | 启动入口、陷阱向量、上下文切换、架构寄存器操作、外设驱动（PLIC、UART、AHCI、PCI） |
| **内存管理（MM）** | `kernel/mm/` | 3 个 .c 文件 | 物理页分配（kalloc）、虚拟内存管理（vm）、mmap/munmap 实现 |
| **进程与调度（Sched）** | `kernel/sched/` | 4 个 .c 文件 | 进程管理（proc）、线程管理（thread）、调度器（sched）、陷阱处理（trap） |
| **文件系统（FS）** | `kernel/fs/`（含 `vfs/` 子目录） | ~38 个 .c 文件 | VFS 抽象层、EXT4 完整实现（含日志、extent、目录索引、xattr）、xv6fs、procfs、virtio-blk 驱动、块缓冲层 |
| **进程间通信（IPC）** | `kernel/ipc/` | 4 个 .c 文件 | futex、pipe、signal 发送与处理 |
| **同步原语（Atomic）** | `kernel/atomic/` | 4 个 .c 文件 | spinlock、sleeplock、条件变量（cond）、信号量（semaphore） |
| **内核库（Lib）** | `kernel/lib/` | 5 个 .c 文件 | printf、snprintf、string 操作、qsort、queue |
| **系统调用层** | `kernel/syscall.c`, `kernel/sysproc.c`, `kernel/sysother.c` | 3 个 .c 文件 | 系统调用分发、参数解析；约 80+ 个 Linux 兼容系统调用 |
| **初始化（Init）** | `kernel/init/` | 2 个 .c 文件 | 内核启动入口、BSS 清零、各子系统初始化编排 |
| **用户态（User）** | `user/` | ~15 个 .c/.S 文件 | init 进程（测试编排）、用户库（printf、malloc）、简单用户程序（echo、mkdir、rm 等） |

---

### 四、关键特征

1. **双架构支持**：RISC-V（主得分架构，完整实现）与 LoongArch（最小可说明内核）。
2. **EXT4 文件系统**：实现了完整的 EXT4 只读/读写支持，包括日志（journal）、extent 树、目录哈希索引（dir_idx）、扩展属性（xattr）、块分配等子模块，代码量约 500KB+。
3. **Linux ABI 兼容**：通过 `scripts/syscall.tbl` 定义了约 80+ 个 Linux 兼容系统调用，覆盖文件操作、进程管理、内存管理、信号、时间、futex 等。
4. **VFS 抽象**：支持 EXT4、xv6fs、procfs 三种文件系统类型，通过 VFS 层统一访问。
5. **多核支持**：RISC-V 架构下支持通过 OpenSBI 启动多核（`NCPU`），包含自旋锁等 SMP 同步机制。
6. **块设备抽象**：支持 virtio-blk（RISC-V/QEMU）和 AHCI（LoongArch）两种块设备驱动。

---

### 五、构建工具需求

根据 `Makefile` 和 `scripts/` 分析，构建该项目的工具链需求如下：

| 类别 | 所需工具 | 用途 |
|---|---|---|
| **RISC-V 交叉编译工具链** | `riscv64-unknown-elf-gcc`、`riscv64-linux-gnu-gcc` 或 `riscv64-unknown-linux-gnu-gcc`（自动探测）；对应 `ld`、`objdump`、`objcopy` | 编译 RISC-V 内核与用户程序 |
| **LoongArch 交叉编译工具链** | `loongarch64-linux-gnu-gcc`（GCC 13.2.0）及对应 binutils | 编译 LoongArch 内核与用户程序 |
| **QEMU** | `qemu-system-riscv64`（RISC-V）、`qemu-system-loongarch64`（LoongArch，如有） | 模拟运行内核 |
| **QEMU 工具** | `qemu-img` | 创建 overlay 磁盘镜像 |
| **GNU Make** | `make` | 构建系统 |
| **Perl** | `perl` | 运行 `usys.pl` 系统调用桩生成脚本 |
| **Python** | `python3` | 运行 `bin2c.py`（二进制转 C 数组） |
| **Docker** | `docker` | 官方评测环境容器（`zhouzhouyi/os-contest:20260510`） |
| **其他标准工具** | `bash`、`git`、`grep`、`sed`、`find` 等 | 构建辅助 |

构建入口：`make all`（默认 RISC-V），产物为 `kernel-rv` 和 `kernel-la`。可通过 `ARCH=riscv` 或 `ARCH=loongarch` 指定架构。