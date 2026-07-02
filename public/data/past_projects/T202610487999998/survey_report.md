## 项目初步调查报告

### 一、项目结构

```
.
├── Makefile                  # 顶层构建入口，生成 kernel-rv 和 kernel-la
├── README.md                 # GitLab 默认模板，无实质内容
├── .gitignore
├── kernel/
│   ├── Makefile              # 内核构建文件
│   ├── arch/
│   │   ├── riscv64/          # RISC-V 64 架构支持
│   │   │   ├── entry.S       # 启动入口（BSS清零、栈初始化）
│   │   │   ├── trap.S        # 用户态陷阱处理（user_enter/resume/trap_entry）
│   │   │   ├── arch.c        # SBI调用（putchar/shutdown）
│   │   │   └── linker.ld     # 链接脚本（基址 0x80200000）
│   │   └── loongarch64/      # LoongArch 64 架构支持
│   │       ├── entry.S       # 启动入口（含 DMW 窗口配置）
│   │       ├── arch.c        # UART输出 + GED关机
│   │       └── linker.ld     # 链接脚本（基址 0x9000000090000000）
│   ├── common/               # 内核公共代码
│   │   ├── main.c            # 内核主逻辑：挂载EXT4、发现测试用例、调度运行
│   │   ├── print.c           # kprintf/kputs 格式化输出
│   │   ├── string.c          # memset/memcpy/memcmp/strlen
│   │   └── virtio.c          # VirtIO-blk 块设备驱动（RISC-V MMIO + LoongArch PCI）
│   ├── fs/                   # 文件系统
│   │   ├── ext4.c            # EXT4 只读实现（超级块、inode、extent、目录遍历）
│   │   └── fd.c              # 用户文件描述符管理（FD分配/释放、管道缓冲区）
│   ├── proc/                 # 进程管理
│   │   └── user.c            # ELF加载器、页表管理、用户态执行、系统调用分发（~4500行）
│   ├── syscall/              # 系统调用兼容层
│   │   └── linux_compat.c    # stat/statx/statfs/rlimit 结构体填充
│   └── include/              # 头文件
│       ├── block.h           # 块设备接口（block_init/read_sector/read）
│       ├── ext4.h            # EXT4 接口声明
│       ├── kernel.h          # 内核核心声明（kmain、kprintf、字符串函数）
│       ├── linux_compat.h    # Linux兼容结构体填充函数声明
│       ├── syscall.h         # 系统调用号宏定义（约140个）及错误码
│       ├── user.h            # 用户态ELF运行接口
│       └── user_fd.h         # 用户FD类型与数据结构定义
└── scripts/
    ├── oscontest-common.sh   # Docker 运行环境封装
    ├── run-qemu-test.sh      # QEMU 测试启动脚本（rv/la）
    ├── build-testsuits.sh    # 测试套件构建与镜像制作脚本
    └── docker-test.sh        # Docker 测试快捷脚本
```

### 二、子系统划分

| 子系统 | 对应目录/文件 | 功能概要 |
|--------|-------------|---------|
| **架构层** | `kernel/arch/riscv64/`, `kernel/arch/loongarch64/` | 启动入口（`_start`）、BSS清零、栈设置、MMIO/UART/SBI字符输出、系统关机、RISC-V 用户态陷阱入口与恢复 |
| **块设备驱动** | `kernel/common/virtio.c` | VirtIO-blk 遗留接口驱动，同时支持 RISC-V MMIO 和 LoongArch PCI 传输方式，提供 `block_init`/`block_read_sector`/`block_read` |
| **EXT4 文件系统** | `kernel/fs/ext4.c` | EXT4 只读实现：超级块解析、inode 读取、extent 树遍历、目录项遍历、路径查找、测试用例发现 |
| **文件描述符层** | `kernel/fs/fd.c` | 用户态 FD 表管理：支持 EXT4 文件、内存文件、目录、管道、console、eventfd、epoll、timerfd 等 15 种 FD 类型 |
| **进程/用户态管理** | `kernel/proc/user.c` | ELF64 加载器（静态+动态链接解释器）、RISC-V Sv39 页表管理、用户态堆栈/堆/MMAP 管理、系统调用分发（约 140 个 syscall）、虚拟文件系统操作（mem file/dir）、管道、clone/fork 模拟 |
| **系统调用兼容** | `kernel/syscall/linux_compat.c` | 为 `fstat`/`statx`/`statfs`/`getrlimit` 等系统调用填充 Linux ABI 兼容结构体 |
| **公共库** | `kernel/common/print.c`, `kernel/common/string.c` | 格式化输出（`kprintf`/`kputs`）、基础字符串/内存操作（`memset`/`memcpy`/`memcmp`/`strlen`） |
| **内核主控** | `kernel/common/main.c` | 初始化块设备和 EXT4，发现测试用例 ELF 文件，按分组（basic/ltp/lua/busybox/libctest/libcbench/iozone/lmbench/cyclictest/iperf/netperf）调度运行，对缺失的测试输出模拟通过结果 |

### 三、构建工具要求

根据 `kernel/Makefile` 和 `scripts/` 分析，构建和测试需要：

| 工具 | 用途 |
|------|------|
| **RISC-V Linux GNU 交叉编译器** | 生成 `kernel-rv`（自动搜索 `riscv64-linux-gnu-gcc` / `riscv64-linux-musl-gcc` / `riscv64-unknown-elf-gcc` 等） |
| **LoongArch Linux GNU 交叉编译器** | 生成 `kernel-la`（自动搜索 `loongarch64-linux-gnu-gcc` / `loongarch64-linux-musl-gcc` 等） |
| **GNU Make** | 构建自动化 |
| **Docker** | 测试执行环境（镜像 `zhouzhouyi/os-contest:20260510`），QEMU 和测试套件编译均在容器内完成 |
| **QEMU**（容器内） | `qemu-system-riscv64` / `qemu-system-loongarch64` 模拟运行 |
| **mkfs.ext4, mount**（容器内） | 制作 EXT4 测试镜像 |

当前项目为**纯 C 实现**（约 6659 行代码），`.gitignore` 中包含 Rust 相关路径（`kernel/target/`、`kernel/.cargo/` 等）但仓库中无任何 `.rs` 文件，表明 Rust 迁移在规划中但尚未开始。