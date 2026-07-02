## SockCore 操作系统内核 — 初步调查报告

---

### 一、项目概览

**SockCore** 是一个使用 Rust 编写的双架构（RISC-V64 + LoongArch64）操作系统内核，采用单体内核结构，目标平台为 QEMU 虚拟环境。项目源码约 9500 行 Rust 代码，涵盖从启动、内存管理、文件系统到系统调用与进程管理的完整链路。

---

### 二、仓库文件组织结构

```
repo/
├── .git/                    # Git 版本控制
├── .gitignore
├── AI_USAGE.md              # AI 使用说明
├── Cargo.toml               # Rust workspace 配置
├── Cargo.lock
├── LICENSE                  # Mulan PSL v2
├── Makefile                 # 统一构建入口
├── README.md                # 项目说明
├── THIRD_PARTY.md           # 第三方来源说明
├── test_framework.h         # 测试框架头文件 (x86 host)
├── basic_tests/             # 本地基础校验材料（C 测试用例 + Python 测试脚本）
│   ├── *.c                  # 各类系统调用测试用例（fork, mmap, clone, ...）
│   ├── *_test.py            # 对应 Python 测试脚本
│   ├── build-single-testcase.sh
│   ├── run-all.sh
│   ├── ssh_run.py / ktool.py / test_runner.py / test_base.py
├── cargo_home/              # 非隐藏 Cargo 配置（供 Makefile 恢复 .cargo）
├── kernel/                  # 内核源码
│   ├── Cargo.toml           # 内核 crate 配置
│   ├── user/                # 用户态示例程序（hello.S, hello.c, smoke.rs, 链接脚本）
│   └── src/                 # 内核 Rust 源码
│       ├── main.rs          # 内核入口 + 初始化逻辑
│       ├── console.rs       # 控制台输出（print!/println! 宏）
│       ├── panic.rs         # panic 处理
│       ├── elf.rs           # 静态 ELF 加载器（RISC-V64 + LoongArch64）
│       ├── sync.rs          # 自旋锁（SpinMutex）
│       ├── runner.rs        # 测试用例运行管理（约3300行，最大模块）
│       ├── arch/            # 架构相关代码
│       │   ├── mod.rs       # 条件编译导出
│       │   ├── riscv64.rs   # RISC-V64 架构实现
│       │   └── loongarch64.rs # LoongArch64 架构实现
│       ├── driver/          # 设备驱动
│       │   ├── mod.rs
│       │   └── virtio_mmio.rs # VirtIO-MMIO + VirtIO-PCI 块设备驱动
│       ├── fs/              # 文件系统
│       │   ├── mod.rs
│       │   ├── vfs.rs       # 虚拟文件系统抽象（INode, FdTable, FileHandle）
│       │   ├── ramfs.rs     # 内存文件系统
│       │   ├── devfs.rs     # 设备文件系统
│       │   └── ext4.rs      # EXT4 只读文件系统
│       ├── memory/          # 内存管理
│       │   ├── mod.rs
│       │   ├── address.rs   # 物理/虚拟地址抽象
│       │   ├── frame.rs     # 帧分配器（BumpFrameAllocator）
│       │   ├── heap.rs      # 内核堆分配器
│       │   └── pagetable.rs # 页表（Sv39 等）
│       ├── syscall/         # 系统调用
│       │   ├── mod.rs       # syscall 分发与实现（约1581行）
│       │   ├── context.rs   # 进程上下文
│       │   ├── number.rs    # 系统调用号定义
│       │   └── user.rs      # 用户空间内存访问辅助
│       ├── task/            # 任务/进程管理
│       │   ├── mod.rs       # PID 分配
│       │   ├── process.rs   # 进程结构（Process, ProcessState）
│       │   └── scheduler.rs # 调度器（进程 spawn、调度、退出）
│       └── trap/            # 异常/中断处理
│           ├── mod.rs       # trap 分发（RISC-V/LoongArch）
│           └── context.rs   # TrapFrame 定义
├── linker/                  # 双平台链接脚本
│   ├── riscv64.ld           # RISC-V64 链接脚本（入口 0x80200000）
│   └── loongarch64.ld      # LoongArch64 链接脚本（入口 0x200000）
└── submission/              # 提交材料
    ├── 设计方案文档.md
    ├── 项目 PPT.pdf
    └── 演示视频.mp4
```

---

### 三、子系统划分

| 子系统 | 主要目录/文件 | 行数（约） | 职责概述 |
|--------|--------------|-----------|---------|
| **架构适配** | `kernel/src/arch/` | ~1080 | RISC-V64 和 LoongArch64 的 SBI/启动、页表、trap 初始化、上下文切换、关机等 |
| **异常/中断处理** | `kernel/src/trap/` | ~200 | 捕获并分发异常（ecall、缺页等），RISC-V 与 LoongArch 分别处理 |
| **内存管理** | `kernel/src/memory/` | ~440 | 物理帧分配（BumpFrameAllocator）、内核堆、地址抽象、页表操作 |
| **文件系统** | `kernel/src/fs/` | ~660 | VFS 抽象层（INode/FdTable/FileHandle）、RamFS、DevFS、EXT4 只读 |
| **设备驱动** | `kernel/src/driver/` | ~575 | VirtIO-MMIO 块设备（RISC-V）、VirtIO-PCI 块设备（LoongArch） |
| **系统调用** | `kernel/src/syscall/` | ~1950 | 40+ 个 Linux 风格系统调用分发与实现（含进程上下文、用户内存访问） |
| **任务/进程管理** | `kernel/src/task/` | ~440 | PID 分配、Process 结构、进程调度器（spawn/fork/exec/wait/exit） |
| **ELF 加载** | `kernel/src/elf.rs` | ~155 | 静态 ELF 解析与段加载，支持 RISC-V64 和 LoongArch64 |
| **测试运行框架** | `kernel/src/runner.rs` / `kernel/src/runner/` | ~3400 | 测试用例发现、执行策略（兼容/真实ELF）、结果判定与评分 |
| **同步原语** | `kernel/src/sync.rs` | ~60 | 自旋锁（SpinMutex） |
| **控制台** | `kernel/src/console.rs` | ~30 | print!/println! 宏实现 |
| **基础测试** | `basic_tests/` | — | C 语言系统调用测试用例 + Python 测试框架 |

---

### 四、编译构建所需工具

根据 `Makefile` 和 `Cargo.toml` 分析，构建该项目的工具链需求为：

| 工具类别 | 所需工具 | 用途 |
|----------|---------|------|
| **Rust 工具链** | `cargo`、`rustc`、`rustup` | 编译内核（Workspace 构建） |
| **Rust 目标** | `riscv64gc-unknown-none-elf` | RISC-V64 裸机目标 |
| **Rust 目标** | `loongarch64-unknown-none` | LoongArch64 裸机目标 |
| **链接器** | `rust-lld` (通过 `.cargo/config.toml` 指定) | 使用项目自定义链接脚本 |
| **模拟器** | `qemu-system-riscv64` | RISC-V64 运行测试 |
| **模拟器** | `qemu-system-loongarch64` | LoongArch64 运行测试 |
| **可选** | Docker (`zhouzhouyi/os-contest:20260510`) | 推荐容器构建环境 |
| **测试辅助** | `gcc` (RISC-V/LoongArch 交叉编译) | `basic_tests/` 中 C 用例编译 |

构建流程：
1. `make all` 触发 `cargo build --target riscv64gc-unknown-none-elf --release` 和 `cargo build --target loongarch64-unknown-none --release`
2. 产物分别拷贝为 `kernel-rv` 和 `kernel-la`

---

### 五、初步判断

1. **成熟度**：该项目是一个功能较完整的教学/竞赛级内核，实现了从裸机启动到用户态 ELF 程序运行的完整链路，支持 RISC-V64 和 LoongArch64 双架构。

2. **架构风格**：单体内核，多数模块通过条件编译 (`#[cfg(target_arch = ...)]`) 实现双架构复用，架构相关代码集中在 `arch/` 和 `trap/` 中。

3. **文件系统**：提供了 VFS 抽象层，底层支持 RamFS（内存）、DevFS（设备节点）和 EXT4（只读磁盘），通过 VirtIO 块设备驱动访问。

4. **系统调用**：实现了约 40+ 个 Linux 风格系统调用，覆盖文件 I/O、进程管理（fork/clone/execve/wait4）、内存管理（mmap/munmap/brk）、时间等。

5. **测试体系**：`runner.rs` 模块（约 3300 行）是一套较完整的测试运行框架，支持从 EXT4 磁盘加载 ELF 测试用例、兼容模式回退、结果收集与报告。`basic_tests/` 提供了本地 C 语言测试用例和 Python 测试脚本。