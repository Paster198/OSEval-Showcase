## OSoldierBoy 内核项目初步调查报告

---

### 1. 项目结构

```
repo/
├── .git/                    # Git 仓库
├── .gitignore               # 忽略 target/、构建产物
├── Cargo.toml               # Rust 项目清单
├── Cargo.lock               # 依赖锁文件
├── Makefile                 # 顶层构建入口
├── README.md                # 项目说明
├── arch/                    # 链接脚本
│   ├── riscv64.ld           # RISC-V 链接脚本
│   └── loongarch64.ld       # LoongArch 链接脚本
├── src/                     # 内核源代码
│   ├── main.rs              # 内核入口 (rust_main)
│   ├── console.rs           # 串口控制台输出
│   ├── contest.rs           # 比赛测试框架入口
│   ├── panic.rs             # panic 处理
│   ├── arch/                # 架构相关代码
│   │   ├── mod.rs           # 架构条件编译入口
│   │   ├── riscv64.rs       # RISC-V 平台代码
│   │   ├── riscv64.S        # RISC-V 汇编（启动、陷入、用户态切换）
│   │   ├── loongarch64.rs   # LoongArch 平台代码
│   │   └── loongarch64.S    # LoongArch 汇编（启动）
│   ├── mm/                  # 内存管理子系统
│   │   ├── mod.rs           # 模块入口 + BSS清零 + 初始化
│   │   ├── frame.rs         # 物理页帧分配器
│   │   ├── heap.rs          # 内核堆分配器
│   │   ├── paging.rs        # Sv39 页表管理
│   │   └── user.rs          # 用户地址空间管理
│   ├── task/                # 任务/进程管理子系统
│   │   ├── mod.rs           # 用户任务、系统调用实现（~183个syscall）
│   │   └── riscv64.rs       # RISC-V 陷入处理与用户态入口
│   ├── fs/                  # 文件系统子系统
│   │   ├── mod.rs           # 模块入口
│   │   ├── ext4.rs          # EXT4 只读文件系统支持
│   │   └── file.rs          # 文件抽象层（VFS-like，含管道/socket/proc等）
│   ├── elf/                 # ELF 加载器
│   │   └── mod.rs           # ELF 解析与加载规划
│   └── drivers/             # 设备驱动
│       ├── mod.rs           # 模块入口
│       ├── block.rs         # 块设备抽象 trait
│       └── block/
│           └── virtio_mmio.rs  # VirtIO-MMIO 块设备驱动
├── tests/                   # 用户态测试 C 程序
│   ├── abi_static.c
│   ├── compat_static.c
│   ├── exec_child_static.c
│   ├── exec_parent_static.c
│   ├── file_read_static.c
│   ├── fsmeta_static.c
│   ├── getdents_static.c
│   ├── identity_static.c
│   ├── lifecycle_static.c
│   ├── misc_static.c
│   ├── path_static.c
│   ├── pipedup_static.c
│   ├── tmpwrite_static.c
│   └── vecio_static.c
└── docs/                    # 开发进度日志（Phase 20-51）
    └── oscomp-progress-*.md
```

---

### 2. 子系统划分

| 子系统 | 主要源文件 | 代码量 | 功能概要 |
|--------|-----------|--------|---------|
| **架构层 (arch)** | `src/arch/riscv64.rs`, `riscv64.S`, `loongarch64.rs`, `loongarch64.S`, `arch/*.ld` | ~190 行 Rust + ~200 行汇编 + 2 链接脚本 | RISC-V 与 LoongArch 双架构支持；启动入口、UART 串口、SBI 调用、定时器、用户态切换、陷入处理 |
| **内存管理 (mm)** | `src/mm/frame.rs`, `heap.rs`, `paging.rs`, `user.rs`, `mod.rs` | ~2,059 行 | 物理页帧分配器、内核堆分配器、Sv39 页表管理、用户地址空间（含 mmap、brk、ELF 加载映射） |
| **任务/进程管理 (task)** | `src/task/mod.rs`, `task/riscv64.rs` | ~14,298 行 | 用户任务结构体、~183 个 Linux 兼容系统调用、fork/clone/execve、信号处理、futex、调度、定时器 |
| **文件系统 (fs)** | `src/fs/file.rs`, `ext4.rs`, `mod.rs` | ~12,851 行 | EXT4 只读支持、VFS 风格文件抽象层（含管道、socket、epoll、inotify、fanotify、合成 /proc、文件锁等） |
| **ELF 加载器 (elf)** | `src/elf/mod.rs` | ~467 行 | ELF 解析（支持静态 PIE、动态链接器的 PT_INTERP/PT_DYNAMIC）、加载规划生成 |
| **设备驱动 (drivers)** | `src/drivers/block.rs`, `block/virtio_mmio.rs` | ~524 行 | 块设备抽象 trait、VirtIO-MMIO 块设备探测与读写 |
| **控制台 (console)** | `src/console.rs` | ~47 行 | 通过架构 UART 输出，提供 `print!`/`println!` 宏 |
| **比赛接口 (contest)** | `src/contest.rs` | ~41 行 | 比赛测试框架入口，定义脚本搜索路径与测试计划 |
| **Panic 处理** | `src/panic.rs` | ~9 行 | `#[panic_handler]`，panic 时打印信息并关机 |

**总计 Rust 代码：30,521 行；汇编：~1,600 行 (RISC-V) + ~370 行 (LoongArch)；C 测试代码：~370 行。**

---

### 3. 子系统归属判断

- **arch/** 目录：全部属于架构抽象层。按条件编译 (`#[cfg(target_arch = "...")]`) 分派到 riscv64 或 loongarch64 模块。
- **mm/** 目录：全部属于内存管理子系统，职责清晰：frame（物理页）、heap（内核堆）、paging（页表）、user（用户态地址空间）。
- **task/** 目录：进程/任务管理子系统。`mod.rs` 包含用户任务结构与全部系统调用实现；`riscv64.rs` 包含 RISC-V 特定的陷入处理和用户态入口逻辑。
- **fs/** 目录：文件系统子系统。`ext4.rs` 实现 EXT4 磁盘结构解析；`file.rs` 实现文件描述符表、各类文件类型（普通文件/目录/管道/socket/epoll/inotify/fanotify/eventfd 等）、路径解析、文件元数据。
- **elf/** 目录：ELF 程序加载器。
- **drivers/** 目录：设备驱动层，目前仅有块设备（VirtIO-MMIO）。
- **console.rs**：控制台/日志子系统。
- **contest.rs**：比赛测试编排逻辑。
- **panic.rs**：异常处理。

---

### 4. 构建工具需求

根据 `Makefile` 和 `Cargo.toml` 分析：

| 工具 | 用途 | 是否必需 |
|------|------|---------|
| **Rust 工具链** (`cargo`, `rustup`) | 构建管理器与工具链管理 | 是 |
| **nightly-2025-05-20** | 指定 Rust nightly 版本 | 是（项目使用 `#![feature(alloc_error_handler)]`） |
| **rust-lld** | LLVM 链接器（`-C linker=rust-lld`） | 是 |
| **RISC-V target** (`riscv64gc-unknown-none-elf`) | RISC-V 裸机交叉编译目标 | 是（通过 `rustup target add`） |
| **LoongArch target** (`loongarch64-unknown-none-softfloat`) | LoongArch 裸机交叉编译目标 | 是（通过 `rustup target add`） |
| **GNU Make** | 构建编排 | 是 |

无需外部 C 编译器（项目无 C 编译依赖，tests/ 中的 C 文件是纯测试数据不参与内核构建）。依赖均由 Cargo 管理，`Cargo.toml` 当前无外部 crate 依赖（`[dependencies]` 为空），所有功能（如 `alloc`）来自 Rust 标准库的 `core`/`alloc` 以及手写实现。

---

### 5. 初步评估

该项目是一个面向 OS 内核比赛的、基于 Rust 的单体内核（monolithic kernel），具有以下特点：

- **架构支持**：双架构（RISC-V 64 + LoongArch 64），RISC-V 实现更完整（含完整陷入处理与用户态切换），LoongArch 目前仅具启动和串口输出能力。
- **系统调用**：实现了约 183 个 Linux 兼容系统调用，覆盖进程管理、文件 I/O、信号、socket、futex、epoll、inotify、fanotify、cgroup 等。
- **文件系统**：EXT4 只读支持，具备丰富的 VFS 抽象层，支持管道、socketpair、合成 /proc（含 pid/user namespace 信息）。
- **内存管理**：具备物理页帧分配、内核堆、Sv39 分页、用户地址空间映射（含 mmap/brk/栈）。
- **用户态支持**：支持静态 ELF 加载、动态链接（PT_INTERP）、脚本执行。
- **无外部依赖**：完全自包含，未使用任何第三方 crate。