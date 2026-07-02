## 项目初步调查报告

### 一、仓库文件组织结构

仓库根目录包含以下顶层元素：

| 路径 | 类型 | 说明 |
|------|------|------|
| `source/` | 目录 | **主体内核源码**，170 个 Rust 源文件，约 84,389 行 |
| `arch/` | 目录 | 架构相关汇编文件（RISC-V 的 boot.S、trap.S、user_v45.S） |
| `config/` | 目录 | 运行策略配置（real_run_policy.json） |
| `docs/` | 目录 | 迭代 commit message、竞赛主线计划、代码暴露报告等 |
| `docx1/` | 目录 | 47 次迭代的详细实现流程文档（iter_01 ~ iter_47） |
| `Makefile` | 文件 | 统一构建入口，产出 `kernel-rv`（RISC-V）和 `kernel-la`（LoongArch） |
| `Cargo.toml` | 文件 | Rust workspace 配置，members = ["source"] |
| `build.rs` | 文件 | 根构建脚本，声明 user/init.elf 重跑条件 |
| `README.md` | 文件 | 项目概览文档 |
| `OSKernel2026-X-design.docx` | 文件 | 设计方案文档 |
| `OSKernel2026-X-presentation.pptx` | 文件 | 项目演示文稿 |

`source/` 目录内部组织：

```
source/
├── arch/                    # 架构层：契约 + RISC-V + LoongArch64 实现
│   ├── contract/            # 架构中立硬件抽象契约（12 个子模块）
│   ├── riscv64/             # RISC-V 64 平台实现（含 trap_block 子目录）
│   └── loongarch64/         # LoongArch64 平台实现（含 trap_block 子目录）
├── bin/                     # 内核二进制入口（riscv64_kernel.rs, loongarch64_kernel.rs）
├── build/                   # 链接脚本（riscv64.ld, loongarch64.ld）
├── core/                    # 内核核心子系统（9 个子模块）
│   ├── block.rs             # 块设备抽象
│   ├── fs/                  # 文件系统（ext4, fd, page_cache, stat, vfs）
│   ├── loader/              # ELF 加载器
│   ├── mm/                  # 内存管理
│   ├── random.rs            # 伪随机数
│   ├── scheduler/           # EDF 调度器（含 futex 阻塞）
│   ├── syscall/             # Linux 系统调用兼容层
│   ├── task/                # 进程/任务模型
│   └── time/                # 时间子系统
├── kernel/                  # 内核编排层
│   ├── boot.rs              # 启动主线
│   ├── exec/                # 程序执行路径（含 discovery/script）
│   ├── exec_buffer.rs       # exec 临时缓冲区
│   ├── linker.rs            # 链接边界符号
│   ├── scheduler/           # 调度器编排（user_task）
│   └── syscall_runtime/     # 系统调用运行时（含 vfs_backend/notify）
├── official/                # 评测输出适配（judge_output, user_output）
├── lib.rs                   # crate 根
├── panic.rs                 # panic 处理
└── build.rs                 # Cargo 构建脚本
```

---

### 二、已实现的子系统

根据源码目录结构和模块声明，该项目实现了以下子系统：

1. **架构抽象与平台适配** — 通过 `arch/contract` 定义跨架构硬件契约，`arch/riscv64` 和 `arch/loongarch64` 分别提供具体实现。覆盖：启动（boot）、块设备（block）、控制台（console）、上下文切换（context）、停机（halt）、MMU、定时器（timer）、Trap 向量、用户态入口（user_entry）、FDT 解析、硬件就绪检查（readiness）、边界模式（boundary）。

2. **内存管理** — 物理页帧分配（frame）、内核地址空间组织（foundation）、页表操作（page_table）、用户地址空间（address_space）、缺页处理（fault）、用户内存拷贝（user_copy）。

3. **进程与任务管理** — 进程生命周期与状态（process）、凭据管理（credentials）、信号处理（signal）、线程退出恢复（robust）、单进程运行时（single，含 memory_runtime、process_runtime、slots）、用户态入口（user_entry）。

4. **调度器** — EDF（Earliest Deadline First）实时调度核心，支持 64 个任务槽位，含睡眠阻塞和 futex 等待队列。

5. **系统调用层** — Linux ABI 兼容的系统调用分发，覆盖：进程控制（process_control）、进程生命周期（process_lifecycle）、进程运行时（process_runtime）、进程 VM（process_vm）、内存管理（memory，含 advice/locking/numa/shared_file）、文件路径操作（fs_path，含 metadata/mount/pipe/xattr）、文件读写（fd_read/fd_write）、信号（signal，含 codec/kill/state/wait）、时间（time）、定时器 FD（timerfd）、事件 FD（eventfd）、信号 FD（signalfd）、epoll、inotify、消息队列（mqueue）、socket、poll、UIO、调度（sched）、系统信息（system）、SysV 消息/信号量（sysv_msg/sysv_sem）、AIO、keyring、trace。

6. **文件系统** — VFS 框架（路径解析、挂载、overlay 文件系统、builtin 节点、proc 文件系统、元数据、扩展属性）、ext4 只读支持（extents、inode）、文件描述符层（epoll、eventfd、inotify、mqueue、pipe、signalfd、socket、timerfd）、页缓存（page_cache）、stat 编码。

7. **ELF 加载器** — ELF 段解析与映射、辅助向量构造、解释器支持、栈初始化。

8. **块设备层** — 块扇区抽象、块缓存（8 槽位）。

9. **时间子系统** — 单调时钟、实时时钟偏移、定时器中断计数、进程间隔定时器、进程 CPU 时间统计。

10. **随机数** — 软件伪随机数发生器。

11. **内核编排层** — 启动主线串联、exec 执行路径（含脚本发现）、系统调用运行时（路径解析、VFS 后端、inotify 通知、exec 运行时）。

12. **评测适配层** — 用户态输出转发（stdout/stderr）、评测输出适配。

13. **panic 处理** — 裸机 panic handler，通过架构控制台输出后停机。

---

### 三、子系统与目录/文件对应关系

| 子系统 | 主要目录/文件 |
|--------|--------------|
| 架构抽象契约 | `source/arch/contract/` （12 个文件） |
| RISC-V 64 平台 | `source/arch/riscv64/`，`arch/riscv64/`（汇编） |
| LoongArch64 平台 | `source/arch/loongarch64/` |
| 内核二进制入口 | `source/bin/riscv64_kernel.rs`，`source/bin/loongarch64_kernel.rs` |
| 链接脚本 | `source/build/riscv64.ld`，`source/build/loongarch64.ld` |
| 内存管理 | `source/core/mm/`（6 文件） |
| 进程/任务 | `source/core/task/`（7 文件） |
| EDF 调度器 | `source/core/scheduler/`（含 blocking/futex） |
| 系统调用 | `source/core/syscall/`（29 文件） |
| VFS/文件系统 | `source/core/fs/`（20 文件，含 ext4、fd、vfs、page_cache、stat） |
| ELF 加载 | `source/core/loader/`（3 文件） |
| 块设备 | `source/core/block.rs` |
| 时间 | `source/core/time/mod.rs` |
| 随机数 | `source/core/random.rs` |
| 启动编排 | `source/kernel/boot.rs` |
| 执行路径 | `source/kernel/exec/`（含 discovery/script） |
| 调度编排 | `source/kernel/scheduler/`（含 user_task） |
| 系统调用运行时 | `source/kernel/syscall_runtime/`（5 文件） |
| 链接符号 | `source/kernel/linker.rs` |
| 评测适配 | `source/official/`（2 文件） |
| panic | `source/panic.rs` |
| 构建脚本 | `source/build.rs`，根 `build.rs` |

---

### 四、编译构建所需工具

根据 `Makefile`、`Cargo.toml` 和 `source/build.rs` 分析，构建所需工具链如下：

| 工具 | 用途 | 必要性 |
|------|------|--------|
| **Rust / Cargo** | 核心构建系统，编译内核源码 | 必须 |
| **rustup** | 管理 Rust 工具链和目标 | 必须 |
| **RISC-V 目标 `riscv64gc-unknown-none-elf`** | RISC-V 64 裸机交叉编译 | 必须 |
| **LoongArch 目标 `loongarch64-unknown-none`** | LoongArch64 裸机交叉编译 | 必须 |
| **rust-src 组件** | `no_std` 裸机内核依赖 core/alloc 源码 | 必须 |
| **Python 3** | `build_init_elf.py`（Makefile 中已注释） | 可选 |
| **Bash** | Makefile 显式指定 `SHELL := /bin/bash` | 必须 |
| **GNU Make** | 构建编排 | 必须 |
| **conda** | 可选的环境激活（Makefile 中有 conda activate osdev 逻辑） | 可选 |

构建命令为 `make all`，最终产物为 `kernel-rv`（RISC-V ELF）和 `kernel-la`（LoongArch ELF）。项目不依赖外部 crate（`source/Cargo.toml` 中 `[dependencies]` 为空），是纯 `no_std` 裸机内核实现。