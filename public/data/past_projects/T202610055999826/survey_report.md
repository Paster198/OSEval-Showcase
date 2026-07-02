## 项目结构概览

### 一、仓库顶层文件组织结构

```
LemonCore/
├── .cargo/                     # Cargo 构建配置（链接目标目录）
├── .git/                       # Git 版本控制
├── .vscode/                    # VS Code 编辑器配置
├── .gitignore
├── Cargo.toml                  # Rust 项目清单（包名 lemoncore，edition 2024）
├── Cargo.lock
├── rust-toolchain.toml         # Rust 工具链配置（nightly-2025-01-18）
├── Makefile                    # 顶层构建系统（双架构支持）
├── build_bb.sh                 # BusyBox 交叉编译辅助脚本
├── linker-riscv64-qemu.ld      # RISC-V64 内核链接脚本
├── linker-loongarch64-qemu.ld  # LoongArch64 内核链接脚本
├── README.md                   # 项目说明（英文）
├── reademe.md                  # 另一份说明
├── LemonCore初赛设计文档.pdf    # 初赛设计文档（PDF）
├── LemonCore初赛设计文档.txt    # 初赛设计文档（纯文本）
├── LemonCore初赛演示PPT.pptx    # 初赛演示 PPT
├── scripts/
│   ├── run-rv-oj.sh            # RISC-V 评测脚本（Chronix 风格）
│   └── run-la-oj.sh            # LoongArch 评测脚本
├── src/                        # 内核源码（Rust）
├── user/                       # 用户态启动程序（汇编）
├── cargo-config/               # cargo 配置模板（.cargo 来源）
├── hello.txt                   # 测试用文件
├── hello_ext                   # 测试用 ELF
├── fs.img / fs-ext4.img / fs-la.img / fs-la-official.img / fs-official.img
│                               # 多种 EXT4 文件系统镜像
├── kernel-la / kernel-rv       # 预编译内核 ELF（LoongArch / RISC-V）
└── qemu-la.log / qemu-la-user.log
    # QEMU 运行日志
```

### 二、src/ 内核源码子系统划分

源码文件共约 11,100 行 Rust（不含汇编和链接脚本），按模块化组织：

#### 1. 架构层 `src/arch/`（约 1,120 行 Rust + 8 个汇编文件）

| 目录 / 文件 | 行数 | 职能 |
|---|---|---|
| `arch/mod.rs` | 17 | 条件编译导出：`#[cfg(arch_riscv64)]` / `#[cfg(arch_loongarch64)]`，定义 `ArchPageTable` 类型别名 |
| `arch/riscv64/mod.rs` | 179 | RISC-V64 架构抽象：CSR 操作（stvec/satp/sie/time）、SBI 调用（timer/shutdown）、上下文切换入口、trap 入口设置 |
| `arch/riscv64/mm.rs` | 240 | Sv39 三级页表实现（`RiscvPageTable`），实现 `PageTable` trait |
| `arch/riscv64/context.rs` | 25 | RISC-V 任务上下文（`TaskContext`），由 switch.S 定义 |
| `arch/riscv64/entry.S` | - | 内核入口汇编（`_start`） |
| `arch/riscv64/trap.S` | - | trap 向量入口（`__alltraps`） |
| `arch/riscv64/switch.S` | - | 任务上下文切换汇编（`__switch_task_context`） |
| `arch/riscv64/qemu.rs` | 0 | 预留，未实现 |
| `arch/riscv64/timer.rs` | 0 | 预留，未实现 |
| `arch/loongarch64/mod.rs` | 297 | LoongArch64 架构抽象：CSR 操作（CSR_ECFG/CSR_EENTRY/CSR_PGDL 等）、DMW/TLB 操作、上下文切换、trap 分发（`loongarch64_kernel_trap_handler`） |
| `arch/loongarch64/mm.rs` | 302 | LA64 四级页表实现（`LoongArchPageTable`），含 TLB refill handler 初始化（`init_page_walker`） |
| `arch/loongarch64/entry.S` | - | 内核入口汇编 |
| `arch/loongarch64/trap.S` | - | trap 向量入口 |
| `arch/loongarch64/switch.S` | - | 上下文切换汇编 |
| `arch/loongarch64/qemu.rs` | 0 | 预留 |
| `arch/loongarch64/timer.rs` | 0 | 预留 |

#### 2. 内存管理 `src/mm/`（约 1,844 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `mm/mod.rs` | 66 | 内存子系统初始化入口：帧分配器 → 堆分配器 → 内核页表构建 |
| `mm/address.rs` | 132 | 物理/虚拟地址与页号类型定义（`PhysAddr`, `VirtAddr`, `PhysPageNum`, `VirtPageNum`, `VPNRange`） |
| `mm/frame_allocator.rs` | 159 | 栈式回收物理帧分配器（最大 65536 帧，双重释放检测），含 COW 引用计数 |
| `mm/heap_allocator.rs` | 657 | 内核堆分配器（8MB，基于 linked-list 的 bump + free-list），实现 `GlobalAlloc` |
| `mm/memory_set.rs` | 770 | 用户地址空间管理（`MemorySet` + `MapArea`）：支持 mmap/munmap/brk/mprotect，架构成熟的内存布局（RISC-V 栈在 `0x8000_0000`，LoongArch 栈在 `0x7FFF_FFFF_F000`） |
| `mm/page_table.rs` | 60 | `PageTable` trait + `MapPermission`（统一分页接口） |

#### 3. 异常与中断处理 `src/trap/`（约 277 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `trap/mod.rs` | 22 | trap 初始化：设置 stvec/trap 入口 |
| `trap/context.rs` | 113 | 双架构 `TrapContext` 定义（保存通用寄存器 + sstatus/sepc/scause/stval 等） |
| `trap/handler.rs` | 142 | RISC-V trap 分发：系统调用（a7=id）、定时器中断、页错误→进程终止、断点 |

LoongArch 的 trap 分发直接在 `arch/loongarch64/mod.rs` 的 `loongarch64_kernel_trap_handler` 中实现。

#### 4. 进程管理 `src/task/`（约 2,562 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `task/mod.rs` | 878 | 进程管理核心：fork/exec/wait/exit/clone、信号投递、僵尸回收、内核线程测试 |
| `task/task.rs` | 596 | 进程控制块 `TaskControlBlock`：含 pid、状态、内存集、文件表、CWD、父子关系、信号掩码、内核栈等 |
| `task/processor.rs` | 193 | 处理器核心抽象：当前任务指针、`run()` 主循环（调度 + 执行） |
| `task/scheduler.rs` | 374 | 协作式调度器：支持 Exit/Yield/Preempt/Block 四种调度原因，通过 `switch_to_scheduler_stack` 切换上下文 |
| `task/manager.rs` | 58 | 任务管理器：就绪队列管理 |
| `task/context.rs` | 34 | 任务上下文类型定义 |
| `task/kernel_stack.rs` | 184 | 内核栈分配与管理 |
| `task/wait_queue.rs` | 99 | 等待队列（阻塞/唤醒） |
| `task/sleep_queue.rs` | 76 | 休眠队列（定时唤醒） |
| `task/context_test.rs` | 100 | 上下文切换自测代码 |

#### 5. 系统调用 `src/syscall/`（约 1,968 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `syscall/mod.rs` | 163 | 系统调用分发表（约 64 个 Linux 兼容调用号），`syscall()` 主分发函数 |
| `syscall/fd.rs` | 1,158 | 文件 IO 系统调用：read/write/openat/close/dup/pipe/getdents64/stat/fstat/faccessat/mmap/munmap/mprotect/getrandom/futex/writev 等 |
| `syscall/task.rs` | 461 | 进程系统调用：fork/clone/clone3/execve/waitpid/exit/exit_group/getpid/getppid/kill/tkill 等 |
| `syscall/mm.rs` | 15 | 内存系统调用：brk |
| `syscall/time.rs` | 140 | 时间系统调用：nanosleep/times/gettimeofday/clock_gettime/uname |
| `syscall/errno.rs` | 31 | errno 常量定义（ENOENT/EINVAL/ENOTDIR/EIO/ENODEV/ENOTTY 等） |

#### 6. 文件系统 `src/fs/`（约 1,262 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `fs/mod.rs` | 10 | 文件系统初始化入口 |
| `fs/ext4.rs` | 1,218 | EXT4 只读支持：超级块解析、extent 树遍历、目录项读取、稀疏文件（hole）处理、VFS 页缓存（预加载 initproc/childproc） |
| `fs/test_scanner.rs` | 34 | 测试扫描工具（从磁盘扫描测试脚本） |

#### 7. 设备驱动 `src/drivers/`（约 1,076 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `drivers/mod.rs` | 81 | 驱动初始化入口 + 块设备读写统一接口（`block_read_bytes`/`block_write_bytes`） |
| `drivers/serial.rs` | 41 | UART 串口驱动（双架构：RISC-V 地址 `0x1000_0000`，LA 地址 `0x8000_0000_1fe0_01e0`） |
| `drivers/virtio_mmio.rs` | 570 | RISC-V VirtIO MMIO 块设备驱动（队列、描述符链、读写扇区） |
| `drivers/virtio_pci.rs` | 384 | LoongArch VirtIO PCI 块设备驱动 |

#### 8. 程序加载器 `src/loader/`（约 1,022 行）

| 文件 | 行数 | 职能 |
|---|---|---|
| `loader/mod.rs` | 4 | 模块导出 |
| `loader/elf.rs` | 963 | ELF64 加载器：支持从 EXT4 磁盘加载（`load_elf_from_disk`）和从内置数组加载，支持 ET_EXEC/ET_DYN/PIE，含 argv 栈布局 |
| `loader/initproc.rs` | 55 | 内置用户程序注册表（initproc/childproc） |

#### 9. 其它模块

| 文件 | 行数 | 职能 |
|---|---|---|
| `main.rs` | 55 | 内核入口 `kernel_main`（双架构版本），依次初始化 trap → mm → drivers → fs → task → run |
| `logging.rs` | 27 | `print!/println!/kprint!` 宏定义，通过串口输出 |
| `config.rs` | 0 | 预留，空文件 |
| `sync/mod.rs` + `sync/up.rs` | 0 | 同步原语，预留未实现 |
| `time/mod.rs` + `time/timer_queue.rs` | 0 | 时间管理，预留未实现 |

### 三、子系统总结

根据上述分析，LemonCore 内核实现了以下子系统：

| 子系统 | 状态 | 关键实现 |
|---|---|---|
| **架构抽象** | 已实现 | RISC-V64 + LoongArch64 双架构，条件编译 + `PageTable` trait 统一接口 |
| **内存管理** | 已实现 | 栈式帧分配器（含 COW 引用计数）、8MB 内核堆、Sv39/LA64 四级页表、mmap/brk/mprotect |
| **进程管理** | 已实现 | 单核协作式调度、fork/exec/wait/clone/clone3、僵尸回收、信号投递（SIGKILL/SIGTERM） |
| **系统调用** | 已实现 | 约 64 个 Linux 兼容系统调用 |
| **文件系统** | 已实现 | EXT4 只读（超级块/extent 树/稀疏文件）、VFS 页缓存 |
| **设备驱动** | 已实现 | VirtIO MMIO 块设备（RISC-V）、VirtIO PCI 块设备（LoongArch）、UART 串口 |
| **ELF 加载器** | 已实现 | 支持 ET_EXEC/ET_DYN/PIE，从磁盘或内置数组加载 |
| **同步原语** | 未实现 | `sync/` 模块为空 |
| **时间管理** | 部分实现 | 定时器中断 + nanosleep 可用，但 `time/` 模块文件为空（逻辑分散在 syscall/time.rs 和 arch 中） |

### 四、编译构建工具需求

根据 `Makefile`、`Cargo.toml`、`rust-toolchain.toml` 分析：

**必需工具：**
- **Rust 工具链**：nightly-2025-01-18，targets：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none`
- **Cargo**（Rust 包管理器+构建系统）
- **GNU Make**（顶层构建编排）
- **RISC-V Linux GNU 交叉编译工具链**：`riscv64-linux-gnu-gcc`（编译 user/ 下的汇编启动程序）
- **LoongArch Linux GNU 交叉编译工具链**：`loongarch64-linux-gnu-gcc`（同上）

**可选工具：**
- **mkfs.ext4 + debugfs**：制作 `disk.img` 辅助磁盘镜像（含评测脚本）
- **QEMU**：`qemu-system-riscv64` / `qemu-system-loongarch64`（本地运行测试）
- **Docker**：LoongArch 交叉编译和运行（官方评测镜像 `docker.educg.net/cg/os-contest:20250226`）

**构建流程**（`make all`）：
1. `make disk-img`：创建 ext4 磁盘镜像并注入 run-oj.sh 脚本
2. `make user`：用交叉 GCC 编译 `user/<arch>/*.S` 为 ELF
3. `make build`：通过 Cargo 编译内核（条件编译选择架构），产物在 `target/<target>/<mode>/lemoncore`
4. `make image`：复制产物为 `kernel-rv` 或 `kernel-la`

### 五、初步判断

1. **项目规模**：约 11,100 行 Rust 内核代码 + 汇编启动/陷阱入口，属于中型宏内核项目。
2. **架构设计**：采用经典的宏内核分层架构，模块边界清晰，通过 `PageTable` trait 实现了架构无关的内存管理接口。
3. **实现完整度**：涵盖了 OS 内核核心子系统（进程、内存、文件系统、驱动、系统调用），但同步原语和完整的时间子系统尚为空壳。
4. **双架构支持**：RISC-V64 更成熟（Sv39 + VirtIO MMIO），LoongArch64 处于适配阶段（LA64 四级页表 + VirtIO PCI，部分功能如定时器中断在代码中保留但注释为 "Timer disabled until interrupt handling is integrated"）。
5. **编译构建**：利用 Rust 的 `cfg(feature)` 条件编译实现双架构切换，Makefile 封装了交叉编译和用户程序构建。