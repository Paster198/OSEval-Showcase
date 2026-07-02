# Ya2yOS 项目初步调查报告

## 一、项目概况

**项目名称**：Ya2yOS  
**项目作者**：饶晓杰（华南理工大学）  
**项目基座**：基于 2025 年塔特林设计局的参赛作品 TatlinOS  
**开发语言**：Rust（no_std 裸机环境）  
**Rust 工具链**：nightly-2026-02-25  
**支持架构**：RISC-V 64（riscv64gc-unknown-none-elf）、LoongArch64（loongarch64-unknown-none-softfloat）

---

## 二、仓库文件组织结构

```
.
├── Makefile                  # 顶层构建入口，支持 riscv64/loongarch64 双架构编译
├── rust-toolchain.toml       # Rust 工具链版本声明
├── README.md                 # 项目说明与评分概览
├── LICENSE                   # 许可证
├── .gitignore
├── .vscode/                  # VS Code 配置
├── Docs/                     # 项目文档
│   ├── pre_slides.pdf/.txt   # 项目概述幻灯片
│   ├── 使用指南.md            # 使用指南
│   ├── img/                  # 文档图片
│   ├── uml/                  # UML 设计图（按子系统分类）
│   ├── ya2yos/               # 内核设计文档（8 个章节 + copy_from_to_user 分析）
│   └── 初赛文档/             # 初赛相关文档（AI 交互记录、bug 修复、开发日志）
├── os/                       # 【内核主代码】
│   ├── Cargo.toml            # 内核 crate 配置
│   ├── dotcargo/             # Cargo 配置模板
│   ├── vendor/               # 本地 vendored 依赖（smoltcp、riscv、virtio-drivers 等）
│   └── src/
│       ├── main.rs           # 内核入口点（rust_main + trampoline）
│       ├── config.rs         # 全局配置常量（HART_NUM, THREAD_MAX_NUM）
│       ├── console.rs        # 控制台输出
│       ├── logger.rs         # 日志系统
│       ├── lang_items.rs     # Rust 语言项（panic_handler 等）
│       ├── sbi.rs            # RISC-V SBI 接口
│       ├── linker-qemu.ld    # 链接脚本
│       ├── arch/             # 架构相关代码
│       ├── drivers/          # 设备驱动
│       ├── fs/               # 文件系统
│       ├── mm/               # 内存管理
│       ├── net/              # 网络协议栈
│       ├── signal/           # 信号机制
│       ├── sync/             # 同步原语
│       ├── syscall/          # 系统调用
│       ├── task/             # 任务/进程管理
│       ├── timer/            # 时间管理
│       ├── trap/             # 陷阱/中断处理
│       └── utils/            # 工具模块
├── user/                     # 【用户态程序】
│   ├── Cargo.toml            # 用户库 crate 配置
│   ├── dotcargo/             # Cargo 配置模板
│   ├── vendor/               # 本地 vendored 依赖
│   └── src/
│       ├── lib.rs            # 用户库入口
│       ├── linker.ld         # 用户程序链接脚本
│       ├── arch/             # 架构相关（LA64 编译器辅助函数、链接脚本）
│       ├── bin/              # 用户程序（测试/基准测试用例）
│       └── syscall/          # 用户态系统调用封装
├── crates/                   # 【辅助 crate】
│   ├── cty/                  # C 类型别名（vendored）
│   └── lwext4_rust/          # Rust 绑定 lwext4（轻量级 ext4 实现）
├── make_scripts/             # 【构建脚本】
│   ├── riscv64.mk            # RISC-V 64 构建配置
│   ├── loongarch64.mk        # LoongArch64 构建配置
│   └── user.mk               # 用户程序构建配置
├── py_scripts/               # Python 辅助脚本
└── agent-skills/             # AI Agent 技能模板（add-syscall-feature, fix-bug, write-docs）
```

---

## 三、子系统划分

内核代码（`os/src/`）共计约 **35,872 行** Rust 代码（含汇编），按目录大小排序如下：

| 子系统 | 路径 | 代码量 | 功能简述 |
|--------|------|--------|----------|
| **系统调用** | `os/src/syscall/` | 510 KB | 系统调用入口与分发，按功能分为 fs、mm、net、task、sync、io_mpx、time、signal 等子模块 |
| **文件系统** | `os/src/fs/` | 234 KB | VFS 层、ext4（lwext4）、devfs、epoll、inotify、pipe、signalfd、mqueue、文件锁、挂载管理等 |
| **内存管理** | `os/src/mm/` | 148 KB | 页帧分配（buddy + CMA）、页表（SV39）、地址空间（MemorySet）、mmap、共享内存、fork/clone、缺页处理、ELF 加载 |
| **任务管理** | `os/src/task/` | 140 KB | 进程/线程管理、调度器（Processor/TaskManager）、futex、PID 分配、内核栈、任务切换 |
| **架构层** | `os/src/arch/` | 143 KB | RISC-V 64 和 LoongArch64 双架构支持：内存布局、页表、上下文切换、陷阱入口、TLB、中断请求处理 |
| **网络** | `os/src/net/` | 138 KB | 基于 smoltcp 的 TCP/UDP/Unix socket、路由、设备抽象（loopback + ethernet）、监听表 |
| **时间管理** | `os/src/timer/` | 48 KB | 硬件时钟、uptime、CLOCK_REALTIME/MONOTONIC、itimerval、rusage、futex 超时、timespec/timeval |
| **信号** | `os/src/signal/` | 36 KB | POSIX 信号机制：信号发送、处理、信号集、sigaction |
| **工具** | `os/src/utils/` | 36 KB | ID 分配器、错误类型、poll 工具、字符串操作、SimpleRange |
| **驱动** | `os/src/drivers/` | 64 KB | VirtIO 块设备/网络设备驱动、设备容器、磁盘抽象 |
| **陷阱处理** | `os/src/trap/` | 16 KB | 陷阱分发、异常类型定义 |
| **同步** | `os/src/sync/` | 4 KB | UP 原语（单核同步） |

---

## 四、粗略子系统归属

- **`os/src/arch/`**：架构抽象层。包含 `riscv64/qemu/` 和 `loongarch64/qemu/` 两个子目录，各有独立的启动汇编（entry.asm）、上下文切换（switch.S）、陷阱入口（trap.S）、TLB 操作（tlb.S）、页表实现、内存布局定义、控制台和定时器。公共部分 `mod.rs` 通过 `cfg_if` 按编译目标选择架构。

- **`os/src/drivers/`**：设备驱动框架。包含 `virtio/`（VirtIO-MMIO for RISC-V，VirtIO-PCI for LoongArch64）、`net/`（网络缓冲区 NetBuf）、磁盘抽象 `disk.rs`、设备容器 `devcont.rs`。

- **`os/src/fs/`**：文件系统栈。`ext4_lw/` 封装 lwext4_rust；`files/` 包含各类文件类型实现（管道、stdio、socket、epoll、inotify、signalfd、mqueue、loopdev 等）；`kernel_fs_ops/` 负责内核文件操作（打开、初始化文件系统索引、proc 文件）；`vfs.rs` 实现虚拟文件系统层；`mount.rs` 管理挂载点。

- **`os/src/mm/`**：内存管理。`frame_alloc/` 实现伙伴系统 + CMA 页面分配器；`memory_set/` 管理进程地址空间及 mmap/fork/ELF 加载；`page_fault_handler.rs` 处理缺页；`shm.rs` 共享内存；`heap_allocator.rs` 内核堆分配器。

- **`os/src/net/`**：基于 smoltcp 的网络协议栈。`socket.rs` 统一 socket 抽象；`tcp.rs`/`udp.rs`/`unix.rs` 分别实现 TCP/UDP/Unix 域 socket；`device/` 包含以太网和 loopback 设备；`router.rs` 路由；`listen_table.rs` 监听表。

- **`os/src/syscall/`**：Linux 兼容系统调用层。`mod.rs` 定义 `Syscall` 枚举（约 300+ 系统调用号），按功能分到 `fs/`（文件 IO、fcntl、stat、mount、xattr 等）、`mm/`（brk、mmap、mlock 等）、`net/`（socket、sendto、recvfrom、getsockopt 等）、`task/`（clone、execve、exit、wait、schedule 等）、`sync/`（futex）、`io_mpx/`（epoll、poll、select）、`signal.rs`、`time.rs`、`resource.rs`。

- **`os/src/task/`**：进程/线程管理。`process/` 管理进程结构；`task/` 管理线程结构；`manager.rs` 全局任务管理器；`processor.rs` 调度器；`switch.rs` 任务切换包装；`futex.rs` 用户态快速锁。

- **`os/src/timer/`**：时间子系统。维护硬件 ticks、uptime、CLOCK_REALTIME、itimerval、rusage、futex 超时等。

- **`os/src/signal/`**：信号子系统。`signal.rs` 定义信号集和信号相关操作；`sigact.rs` 实现 sigaction 等。

- **`os/src/trap/`**：陷阱/异常/中断分发处理，定义 `Exception` 和 `Trap` 类型。

- **`os/src/sync/`**：`UP` 原语（单核场景下的临界区保护）。

- **`os/src/utils/`**：通用工具：`id_allocator`（PID/TID 分配）、`error`（SysErrNo 错误码）、`simple_range`、`string`、`poll`。

---

## 五、编译构建依赖工具

根据 Makefile、Cargo.toml 和 rust-toolchain.toml 分析：

### 必需工具

| 工具 | 用途 |
|------|------|
| **Rust nightly-2026-02-25** | 编译器与 cargo |
| **rust-src** | 内核/用户 no_std 构建所需 core/alloc 源码 |
| **llvm-tools-preview** | 提供 rust-objcopy、rust-objdump 等 |
| **rustup target: riscv64gc-unknown-none-elf** | RISC-V 64 裸机目标 |
| **rustup target: loongarch64-unknown-none-softfloat** | LoongArch64 裸机目标 |
| **QEMU** | 模拟运行（qemu-system-riscv64 / qemu-system-loongarch64） |
| **GNU Make** | 构建自动化 |

### 可选工具

| 工具 | 用途 |
|------|------|
| **gdb-multiarch** | RISC-V 调试 |
| **loongarch64-unknown-elf-gdb** | LoongArch64 调试 |
| **Docker** | 容器化构建（镜像 `zhouzhouyi/os-contest:20260510`） |

### 关键外部依赖 crate

- **smoltcp 0.13.1**（vendored）：TCP/IP 协议栈
- **virtio-drivers 0.7.5**：VirtIO 驱动
- **lwext4_rust**（本地 crate）：ext4 文件系统
- **linux-raw-sys 0.12**：Linux 系统调用常量定义
- **riscv**（git）：RISC-V 寄存器与 CSR 操作
- **loongArch64**（git）：LoongArch64 寄存器操作
- **buddy_system_allocator**：伙伴系统内存分配器
- **xmas-elf**：ELF 文件解析

---

## 六、用户程序

用户态程序（`user/src/bin/`）覆盖了以下类别：

- **基础测试**：hello_world、exit、sleep、yield、forktest 系列、matrix、sysinfo、stack_overflow
- **文件系统测试**：cat_filea、filetest_simple、final_fs、huge_write
- **信号测试**：signal
- **基准测试**：busybox_test、lmbench、lua、libctest 系列（pthread、stat、tls 等）、ltp（Linux Test Project 子集）
- **其他**：user_shell、initproc、fantastic_text、final_time

用户库（`user/src/lib.rs`，约 17,011 行）提供系统调用封装和标准库替代功能。