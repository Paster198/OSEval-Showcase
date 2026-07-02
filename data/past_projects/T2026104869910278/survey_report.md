# OSOSOS 内核项目初步分析报告

## 一、项目概览

OSOSOS 是一款基于 Rust 语言开发的单核宏内核操作系统，以 rCore-Tutorial v3 的 chapter8 为起点进行了全栈重构。支持 **RISC-V 64 (RV64GC)** 和 **LoongArch 64 (LA64)** 两种指令集架构。声称内核主体原创代码近万行。

## 二、仓库顶层结构

```
repo/
├── r-core/                       # 内核源码与构建系统（主目录）
├── docs/                         # 发布文档（PDF / PPTX）
├── docs_source/                  # 文档 LaTeX 源码与流程图
├── tmplate_for_docs/             # 文档模板
├── Makefile                      # 顶层构建入口（make rv / make la / make submit）
├── README.md                     # 项目说明
├── casesall.txt                  # LTP 测试用例列表
├── ld-linux-riscv64-lp64d.so.1   # RISC-V 动态链接器
├── LICENSE                       # 许可证
└── .gitignore / .vscode          # 工程配置
```

## 三、内核源码结构 (r-core/)

### 3.1 一级子目录

| 目录 | 用途 | 代码规模 |
|------|------|----------|
| `r-core/os/` | **内核主 crate**，核心实现 | ~26,000 行 Rust + ~370 行汇编 |
| `r-core/user/` | 用户态程序（initproc, idleproc）与用户库 | ~900 行 Rust |
| `r-core/lwext4_rust/` | ext4 文件系统 C 库的 Rust FFI 封装 | ~3,400 行 Rust + C 源码 |
| `r-core/virtio-drivers/` | RISC-V MMIO VirtIO 驱动（legacy） | ~700 行 Rust |
| `r-core/virtio-drivers-la/` | LoongArch PCI VirtIO 驱动（含网络/套接字） | ~10,300 行 Rust |
| `r-core/riscv/` | RISC-V 寄存器定义 crate | 辅助库 |
| `r-core/bootloader/` | RustSBI 固件二进制 | 预编译 |

### 3.2 内核源代码 (`r-core/os/src/`) 子系统划分

内核源码按功能模块清晰组织为以下子系统：

#### (1) 进程与线程管理 (`task/`) — 约 4,420 行

| 文件 | 功能 |
|------|------|
| `mod.rs` (1,340行) | 进程管理入口，综合调度逻辑 |
| `process.rs` (1,105行) | 进程控制块 (PCB)，进程创建/退出/等待 |
| `cred.rs` (799行) | 进程凭证 (UID/GID/capabilities) |
| `id.rs` (374行) | PID/TID 分配，内核栈管理 |
| `manager.rs` (222行) | 全局任务管理器 (TASK_MANAGER) |
| `processor.rs` (144行) | 处理器调度 (PROCESSOR)，当前任务上下文 |
| `signal.rs` (192行) | 信号标志与操作 |
| `task.rs` (163行) | 任务控制块 (TCB)，任务状态 |
| `context.rs` (32行) | 任务上下文切换数据结构 |
| `action.rs` (35行) | 信号动作处理 |
| `switch.rs` / `switch-rv.S` / `switch-la.S` | 上下文切换汇编 |

#### (2) 内存管理 (`mm/`) — 约 2,420 行

| 文件 | 功能 |
|------|------|
| `memory_set.rs` (1,052行) | 虚拟地址空间 (MemorySet)，映射管理 |
| `page_table.rs` (448行) | Sv39 / LA 页表操作 |
| `frame_allocator.rs` (408行) | 物理页帧分配器 |
| `address.rs` (310行) | 虚拟/物理地址抽象 |
| `mod.rs` (78行) | MM 子系统入口，flush 操作 |
| `tlb.rs` (79行) | LoongArch TLB 管理 |
| `heap_allocator.rs` (47行) | 内核堆分配器 |
| `tlbfill.S` (28行) | LoongArch TLB 填充汇编 |

#### (3) 文件系统 (`fs/`) — 约 3,680 行

| 文件 | 功能 |
|------|------|
| `inode.rs` (925行) | 核心 inode 抽象，ext4 文件操作 |
| `socket.rs` (801行) | 套接字文件类型 (TCP/UDP) |
| `proc.rs` (552行) | procfs 伪文件系统 |
| `mod.rs` (359行) | VFS 层，File trait，路径解析 |
| `pipe.rs` (216行) | 匿名管道 |
| `mqueue.rs` (216行) | POSIX 消息队列 |
| `dev.rs` (158行) | 设备文件 |
| `fanotify.rs` (147行) | fanotify 文件监控 |
| `stdio.rs` (71行) | 标准输入/输出/错误 |
| `file_cap.rs` (63行) | 文件能力集 |
| `memfile.rs` (58行) | 内存文件 |
| `eventfd.rs` (54行) | eventfd 事件通知 |
| `dummy.rs` (32行) | 占位文件类型 |
| `pidfile.rs` (25行) | PID 文件 |

#### (4) 系统调用 (`syscall/`) — 约 11,980 行（最大子系统）

| 文件 | 功能 |
|------|------|
| `process.rs` (4,267行) | 进程管理相关系统调用 (fork/execve/clone/prctl 等) |
| `fs.rs` (3,136行) | 文件系统相关系统调用 (open/read/write/mount 等) |
| `socket.rs` (1,077行) | 网络套接字系统调用 |
| `mod.rs` (765行) | 系统调用号定义，syscall 总入口分发 |
| `mq.rs` (686行) | POSIX 消息队列系统调用 |
| `sig.rs` (549行) | 信号相关系统调用 |
| `cred.rs` (490行) | 凭证/权限系统调用 |
| `errno.rs` (251行) | 错误码定义 (约 130 种 errno) |
| `shm.rs` (249行) | 共享内存系统调用 |
| `sync.rs` (210行) | 同步原语系统调用 (futex) |
| `fanotify.rs` (154行) | fanotify 系统调用 |
| `thread.rs` (112行) | 线程相关系统调用 |
| `path.rs` (31行) | 路径检查辅助 |

#### (5) 同步原语 (`sync/`) — 约 340 行

| 文件 | 功能 |
|------|------|
| `mutex.rs` (136行) | 互斥锁 (基于 spin) |
| `semaphore.rs` (91行) | 信号量 |
| `up.rs` (51行) | UPSafeCell (安全内部可变性包装) |
| `condvar.rs` (48行) | 条件变量 |
| `mod.rs` (11行) | 模块导出 |

#### (6) 异常与中断处理 (`trap/`) — 约 1,230 行

| 文件 | 功能 |
|------|------|
| `mod.rs` (1,113行) | trap_handler 主逻辑，异常/中断分发、syscall 入口 |
| `context.rs` (113行) | Trap 上下文数据结构 |
| `trap-rv.S` (126行) | RISC-V 陷入/返回汇编 |
| `trap-la.S` (136行) | LoongArch 陷入/返回汇编 |

#### (7) 设备驱动 (`drivers/`) — 约 490 行

| 文件 | 功能 |
|------|------|
| `block/mod.rs` (117行) | 块设备抽象，ext4 全局实例 |
| `block/virtio_blk.rs` (131行) | RISC-V MMIO VirtIO 块设备 |
| `block/pci_virtio_blk.rs` (178行) | LoongArch PCI VirtIO 块设备 |
| `virtio.rs` (51行) | VirtIO 传输层辅助 |
| `mod.rs` (8行) | 模块导出 |

#### (8) 架构相关 (`arch/` + `boards/`) — 约 250 行

| 文件 | 功能 |
|------|------|
| `boards/qemu.rs` (141行) | QEMU 板级支持，关机方法 |
| `arch/info.rs` (102行) | LoongArch 架构信息打印 |
| `arch/mod.rs` (6行) | 模块导出 |

#### (9) 顶层模块 — 约 1,060 行

| 文件 | 功能 |
|------|------|
| `main.rs` (101行) | 内核入口 `rust_main()`，子系统初始化 |
| `config.rs` (103行) | 内核配置常量 (页大小、内存布局等) |
| `timer.rs` (218行) | 时钟中断处理、定时器管理 |
| `batch.rs` (157行) | 测例批量执行框架 |
| `loader.rs` (70行) | ELF 加载器 |
| `logging.rs` (47行) | 日志系统初始化 |
| `sbi.rs` (51行) | RISC-V SBI 调用封装 |
| `console.rs` (69行) | RISC-V 控制台输出 |
| `la_console.rs` (31行) | LoongArch 控制台输出 |
| `heap_alloc.rs` (26行) | 内核堆初始化 |
| `lang_items.rs` (30行) | Rust 语言项 (panic_handler 等) |
| `la_shutdown.rs` (8行) | LoongArch 关机 |
| `entry-rv.asm` (11行) | RISC-V 汇编入口 |
| `entry-la.asm` (32行) | LoongArch 汇编入口 |
| `linker-rv.ld` (52行) | RISC-V 链接脚本 |
| `linker-la.ld` (55行) | LoongArch 链接脚本 |

## 四、构建系统分析

### 4.1 需要的工具链

| 工具 | 用途 |
|------|------|
| **Rust nightly-2024-05-01** | 内核及用户程序编译（`rust-toolchain.toml` 指定） |
| **rust-src, llvm-tools-preview** | 标准库源码（build-std）、objcopy/objdump |
| **cargo-binutils** (rust-objcopy, rust-objdump) | 二进制处理 |
| **GNU Make** | 顶层与 r-core/user 构建控制 |
| **Python 3** | 用户程序构建辅助脚本 (`build.py`) |
| **QEMU** (riscv64 / loongarch64) | 模拟运行 |
| **GDB (gdb-multiarch)** | 调试 |
| **RISC-V musl 交叉工具链** (bootlin) | lwext4 C 库编译 |
| **cc / cmake** (通过 build.rs) | lwext4 C 库编译 |
| **bindgen** | 生成 Rust FFI 绑定 |

### 4.2 构建目标

- **RISC-V**: `riscv64gc-unknown-none-elf`
- **LoongArch**: `loongarch64-unknown-none`（使用 `-Z build-std` 构建）

### 4.3 构建流程

1. `make rv` / `make la` 先编译用户态程序 (`r-core/user/`)，生成 `initproc` 和 `idleproc`
2. 将用户程序二进制复制到内核源码目录
3. 使用 cargo 编译内核 crate，链接生成 `kernel-rv` 或 `kernel-la`
4. QEMU 启动时加载内核 ELF，挂载 virtio 磁盘镜像 (`sdcard-rv.img` / `sdcard-la.img`)

## 五、子系统总结

该项目实现了以下完整子系统：

1. **进程管理** — PCB/TCB、进程组、会话、调度器、凭证系统 (UID/GID/capabilities)
2. **内存管理** — Sv39/LA 页表、物理帧分配、写时复制 (CoW)、惰性分配、TLB 管理
3. **文件系统** — VFS 抽象层、ext4 (FFI)、procfs、pipe、devfs、socket、mqueue、eventfd、fanotify
4. **系统调用** — 约 103 个系统调用，覆盖进程、文件、信号、网络、同步、共享内存、消息队列
5. **信号机制** — 完整信号发送/递送/处理
6. **网络协议栈** — 基于 VirtIO-net 的 TCP/UDP 套接字实现
7. **同步原语** — Mutex、Condvar、Semaphore、futex
8. **中断/异常处理** — 统一的陷入入口与分发
9. **设备驱动** — VirtIO 块设备 (MMIO + PCI)，VirtIO 网络设备
10. **定时器** — 时钟中断与定时器管理
11. **双架构支持** — RISC-V 64 与 LoongArch 64，各自独立的汇编入口、链接脚本和驱动变体