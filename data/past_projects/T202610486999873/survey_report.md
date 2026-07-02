## 项目结构分析

### 一、项目概述

**ScintillaOS** 是武汉大学参赛队面向全国大学生操作系统设计大赛开发的操作系统内核。基于 rCore 教学内核扩展，采用 Rust 编写，目标是在 QEMU RISC-V 平台提供兼容 Linux ABI 的用户程序运行环境。

---

### 二、顶层目录结构

| 路径 | 用途 |
|------|------|
| `os/src/` | 内核主体源码（Rust） |
| `user/src/` | 用户态运行时库、系统调用封装、测试程序（Rust） |
| `lwext4_rust/` | lwext4 嵌入式 Ext4 实现的 Rust 绑定及 C 源码 |
| `basic/` | basic 测试用例（C 语言），含构建脚本和测试 runner |
| `documents/` | 开发日志、架构文档、测试记录等 Markdown 文档 |
| `vendor/` | 离线依赖（polyhal、smoltcp、virtio-drivers 等大量第三方 crate） |
| `scripts/` | 评测辅助脚本（`educg_eval.py`） |
| `cargo_config/` | Cargo 离线配置 |
| `lua-tests/` | Lua 测试资源 |
| `tmp/` | 临时文件目录 |
| `.vscode/` | VS Code 开发配置 |

根目录关键文件：
- `Makefile`（426 行）：构建、运行、调试的入口
- `Cargo.toml`：工作区配置，包含 `os` 和 `user` 两个成员
- `rust-toolchain.toml`：指定 nightly-2025-02-01 工具链，目标平台含 riscv64/loongarch64/x86_64/aarch64
- `run-gui.sh`：RISC-V QEMU 快速启动脚本

---

### 三、内核源码结构 (`os/src/`)

内核模块共计约 **17,000 行 Rust 代码**，按子系统划分：

#### 1. 入口与启动 (`main.rs`，约 250 行)
- 内核入口点：初始化堆、日志、物理帧分配器、根文件系统挂载、网络、任务调度
- 中断/陷阱处理：`kernel_interrupt` 统一分发 SysCall、PageFault（Load/Store/Instruction）、Timer、IllegalInstruction 等

#### 2. 任务管理 (`task/`，约 3,200 行)
| 文件 | 行数 | 职责 |
|------|------|------|
| `task.rs` | 987 | `TaskControlBlock`/`TaskControlBlockInner` 结构定义、任务状态管理 |
| `mod.rs` | 1,012 | 调度器（FIFO 就绪队列 + 时钟轮转）、sleep/阻塞/唤醒、信号处理框架、itimers |
| `action.rs` | ~50 | `SignalAction` 信号处理动作定义 |
| `fp.rs` | ~280 | 浮点状态保存/恢复 |
| `manager.rs` | ~100 | 任务队列管理、PID→TCB 映射 |
| `pid.rs` | ~60 | PID 分配/回收 |
| `processor.rs` | ~150 | 当前任务指针、上下文切换、调度入口 `run_tasks` |
| `signal.rs` | ~65 | `SignalFlags` 信号位掩码 |

#### 3. 内存管理 (`mm/`，约 2,600 行)
| 文件 | 行数 | 职责 |
|------|------|------|
| `memory_set.rs` | 1,736 | 地址空间管理：ELF 装载、`mmap`/`munmap`/`mprotect`、COW、按需分页、页错误处理 |
| `frame_allocator.rs` | ~180 | 物理帧分配/释放 |
| `heap_allocator.rs` | ~40 | 内核堆初始化 |
| `page_table.rs` | ~70 | 页表查询辅助（`translated_ref` 等） |
| `vpn_range.rs` | ~65 | VPN 范围迭代器 |

#### 4. 文件系统 (`fs/`，约 3,800 行)
| 文件 | 行数 | 职责 |
|------|------|------|
| `vfs.rs` | 1,197 | VFS 层：超级块、Dentry 缓存、挂载点、路径解析、`File` trait、文件描述符表 |
| `inode.rs` | 1,366 | Inode 操作（基于 lwext4）、文件读写、目录遍历 |
| `proc.rs` | ~700 | procfs 伪文件系统实现 |
| `stdio.rs` | ~470 | 标准输入/输出/错误文件描述符 |
| `pipe.rs` | ~320 | 匿名管道实现 |
| `block_device_stream.rs` | ~150 | 块设备流式读写适配 |
| `mod.rs` | ~225 | 公共类型（`Kstat`）、模块导出 |

#### 5. 系统调用 (`syscall/`，约 9,100 行)
| 文件 | 行数 | 职责 |
|------|------|------|
| `mod.rs` | 550 | 系统调用常量定义（约 110 个 syscall 编号）及分发函数 |
| `fs.rs` | 3,821 | 文件系统相关系统调用实现 |
| `process.rs` | 4,897 | 进程/内存/信号相关系统调用实现 |

已实现的系统调用涵盖：文件操作（open/read/write/close/stat/getdents 等）、进程管理（fork/clone/exec/waitpid/exit 等）、内存管理（brk/mmap/munmap/mprotect 等）、信号（kill/sigaction/sigreturn 等）、时间（nanosleep/clock_gettime 等）、网络 socket、System V 共享内存等。

#### 6. 网络 (`net/`，约 2,600 行)
| 文件 | 行数 | 职责 |
|------|------|------|
| `mod.rs` | 562 | 基于 smoltcp 的 VirtIO 网卡初始化、IP 配置、轮询、阻塞唤醒 |
| `socket.rs` | ~250 | Socket 结构体、统一文件描述符管理 |
| `syscall.rs` | 2,031 | Socket 相关系统调用（socket/bind/listen/connect/accept/sendto/recvfrom 等） |

#### 7. 设备驱动 (`drivers/`，约 500 行)
| 文件 | 职责 |
|------|------|
| `block/mod.rs`, `block/virtio_blk.rs`, `block/ram_blk.rs`, `block/device.rs` | VirtIO 块设备驱动、RAM 块设备、块设备抽象 |
| `net/mod.rs`, `net/virtio_net.rs` | VirtIO 网卡驱动 |

#### 8. 同步原语 (`sync/`，约 70 行)
- `up.rs`：UPIntrFreeCell 等单核同步封装（基于 `UPSafeCell`）

#### 9. 其他
- `config.rs`：内核配置常量
- `console.rs`：串口控制台输出
- `logging.rs`：日志系统
- `lang_items.rs`：Rust `no_std` 语言项

---

### 四、用户态 (`user/src/`)

- **运行时库**（`lib.rs`、`syscall.rs`）：用户态堆分配器、系统调用封装、`_start` 入口
- **用户程序**（`bin/` 目录，约 45 个）：包括 `initproc`（初始化进程）、`basic_runner`、`contest_runner`（评测 runner）、`ltp_runner`、`iperf_runner`、`user_shell`，以及 `forktest`、`pipetest`、`sig_tests` 等各类功能测试

---

### 五、lwext4 绑定 (`lwext4_rust/`)

- `src/bindings.rs`（88 KB）：lwext4 C 库的 Rust FFI 绑定（bindgen 自动生成）
- `src/blockdev.rs`：块设备适配层
- `src/file.rs`：文件操作 Rust 封装
- `src/ulibc.rs`：C 标准库桩函数
- `c/lwext4/`：嵌入式 Ext4 C 实现源码
- `build.rs`：通过 Make 编译 lwext4 C 库

---

### 六、编译构建工具需求

综合 `Makefile`、`rust-toolchain.toml`、`Cargo.toml` 和 `lwext4_rust/build.rs`：

| 工具 | 用途 |
|------|------|
| Rust 工具链 (nightly-2025-02-01) | 内核和用户程序编译，目标平台 riscv64gc/x86_64/aarch64/loongarch64 |
| cargo-binutils (rust-objcopy/rust-objdump) | 内核二进制生成、反汇编 |
| GNU Make | 顶层构建编排 |
| QEMU (qemu-system-riscv64 等) | 模拟运行 |
| OpenSBI/RustSBI | RISC-V SBI 固件 |
| C 交叉编译器 (RISC-V/LoongArch musl-gcc) | basic 测试用例和 lwext4 C 库编译 |
| CMake | lwext4 C 库构建（作为备选路径） |
| mkfs.ext4 / mkfs.vfat / dd | 文件系统镜像制作 |
| Python 3 | 评测脚本 (`educg_eval.py`)、basic 测试 runner |

当前环境中有 RISC-V/LoongArch/AArch64 交叉编译工具链、Rust 工具链、QEMU、dtc、mkfs.ext4 等可用。

---

### 七、初步调查总结

1. **项目规模**：内核约 17,000 行 Rust、用户态约 3,000 行 Rust、lwext4 绑定约 3,500 行 Rust + 大量 C 代码，总计为中等偏大内核项目。

2. **子系统完整度**：
   - 进程管理：较完整（fork/clone/exec/wait/信号/线程组）
   - 内存管理：较完整（Sv39 页表、mmap/munmap、COW、按需分页）
   - 文件系统：以 Ext4 为核心，具备 VFS/Dentry 缓存/路径解析/procfs/pipe
   - 网络：具备基于 smoltcp 的 TCP/UDP socket 支持
   - 设备驱动：VirtIO 块设备和网卡

3. **架构特点**：
   - 单 CPU 同步模型（UPIntrFreeCell）
   - 主目标 RISC-V 64（QEMU virt），保留 LoongArch/AArch64/x86_64 构建路径
   - 基于 polyhal 硬件抽象层，具备多架构潜力
   - Cargo workspace + vendored dependencies 实现离线构建

4. **与教学内核的关系**：基于 rCore-Tutorial-v3 扩展，但文件系统从 FAT 迁移至 Ext4（通过 lwext4），网络栈引入 smoltcp，系统调用数量大幅扩充至约 110 个。