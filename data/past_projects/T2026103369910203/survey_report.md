## DDUOS 操作系统内核项目初步调查报告

### 一、项目概览

DDUOS 是一个用 Rust 编写的现代化、异步优先的操作系统内核，支持 **RISC-V 64** 和 **LoongArch 64** 两种架构。项目采用 Cargo workspace 组织，Rust nightly-2025-01-18 工具链，总代码量约 **6.3 万行** Rust 代码（不含测试用例和外部依赖）。

---

### 二、顶层目录结构

| 目录/文件 | 功能 |
|---|---|
| `kernel/` | 内核主 crate，包含系统调用、任务管理、虚拟内存、陷阱处理等核心模块 |
| `lib/` | 22 个独立的库 crate，实现 VFS、驱动、网络栈、文件系统、同步原语等子系统 |
| `user/` | 用户态程序，含 init 进程、shell、各类测试程序 |
| `docs/` | 设计文档（PDF + PPT） |
| `submit/` | 比赛提交物（Cargo 配置、vendor 依赖包） |
| `testcase/` | 预编译的测试用例（busybox、LTP、lua、iperf 等） |
| `Cargo.toml` | workspace 根清单，定义共享依赖 |
| `Makefile` | 顶层构建入口，支持 build、run、fs-img 等目标 |
| `Dockerfile` | Docker 构建环境（含 QEMU 9.2.1、RISC-V/LoongArch 交叉工具链） |
| `rust-toolchain.toml` | 固定工具链版本 nightly-2025-01-18，目标为 riscv64gc-unknown-none-elf 和 loongarch64-unknown-none |

---

### 三、子系统划分与对应代码

#### 1. 系统调用层 (kernel/src/syscall/) —— 12,127 行

最庞大的内核模块，按功能分为：
- `fs.rs` — 文件系统相关系统调用
- `mm.rs` — 内存管理系统调用（mmap/munmap/mprotect 等）
- `process.rs` — 进程管理系统调用（fork/clone/execve/wait 等）
- `net.rs` — 网络 socket 系统调用
- `signal.rs` — 信号相关系统调用
- `io.rs` — I/O 系统调用
- `poll.rs` — poll/select/epoll 多路复用
- `time.rs` — 时间相关系统调用
- `sche.rs` — 调度相关
- `bpf.rs`, `fanotify.rs`, `fsmount.rs`, `key.rs`, `misc.rs`, `user.rs` — 其他高级系统调用

#### 2. 任务管理 (kernel/src/task/) —— 4,358 行

- `task.rs` — 任务控制块 (TCB) 核心定义
- `manager.rs` — 任务调度管理器
- `process_manager.rs` — 进程管理器
- `threadgroup.rs` — 线程组与进程组
- `futex.rs` — Futex 实现
- `signal/` — 信号处理框架（含 sigreturn trampoline 汇编）
- `cap.rs` — Capability 权限控制
- `mask.rs` — CPU 亲和性掩码
- `time.rs`, `time_stat.rs`, `timeid.rs` — 任务时间统计
- `wait_queue.rs` — 等待队列
- `future.rs`, `taskf.rs` — 异步任务支持

#### 3. 虚拟内存管理 (kernel/src/vm/ + lib/mm/) —— 3,555 + 905 行

- `kernel/src/vm/addr_space.rs` — 地址空间管理
- `kernel/src/vm/page_table.rs` — 页表操作（Sv39 / LoongArch DMW）
- `kernel/src/vm/mmap.rs` — mmap 实现
- `kernel/src/vm/vm_area.rs` — VMA 区域管理
- `kernel/src/vm/elf.rs` — ELF 加载器（静态+动态）
- `kernel/src/vm/shm.rs` — System V 共享内存
- `kernel/src/vm/user_ptr.rs` — 用户指针安全访问
- `lib/mm/src/` — 物理帧分配、堆分配器、页缓存

#### 4. 陷阱与中断处理 (kernel/src/trap/ + lib/arch/) —— 949 + 903 行

- `kernel/src/trap/mod.rs` — 陷阱分发
- `kernel/src/trap/trap_handler/` — 内核态/用户态陷阱处理（分 RISC-V / LoongArch）
- `kernel/src/trap/trap_syscall.rs` — 系统调用分发
- `kernel/src/trap/trap_context.rs` — 陷阱上下文保存/恢复
- `kernel/src/trap/rv_trap.s`, `loong_trap.s` — 架构相关汇编入口
- `lib/arch/src/interrupt/` — 中断控制器抽象
- `lib/arch/src/trap/` — 架构级陷阱定义

#### 5. 处理器管理 (kernel/src/processor/) —— 190 行

- `hart.rs` — HART（硬件线程）管理
- `mod.rs` — 处理器调度核心

#### 6. 文件系统与 VFS (lib/vfs/ + lib/osfs/ + lib/ext4/ + lib/fat32/) —— 4,443 + 15,276 + 1,616 + 752 行

- **VFS 层** (`lib/vfs/`)：统一的 Dentry/Inode/File/SuperBlock 接口，路径解析，文件句柄管理
- **特殊文件系统** (`lib/osfs/`)：最大的库，实现：
  - `/proc` 文件系统（进程信息、内存映射、挂载信息、中断统计等）
  - `/dev` 设备文件系统（null, zero, full, urandom, rtc, tty, loop, shm, stdio）
  - `/sys` 文件系统
  - Pipe 管道、`epoll`、`eventfd`、`timerfd`、`signalfd`
  - `inotify`、`fanotify`、`io_uring`、`userfaultfd`
  - BPF、perf、memfd、fscontext、opentree 等高级特性
- **ext4** (`lib/ext4/`)：基于 lwext4_rust 的 ext4 磁盘文件系统
- **FAT32** (`lib/fat32/`)：基于 rust-fatfs 的 FAT32 文件系统

#### 7. 网络协议栈 (kernel/src/net/ + lib/net/) —— 971 + 2,790 行

- `lib/net/`：基于 smoltcp 的完整 TCP/IP 协议栈封装
  - TCP 状态机、监听表、接收 Future
  - UDP socket、Unix domain socket
  - 设备抽象、接口管理、端口映射
- `kernel/src/net/`：内核侧 socket 操作、地址管理、sockopt

#### 8. 设备驱动 (lib/driver/ + kernel/src/osdriver/) —— 3,291 + 871 行

- **块设备**：VirtIO blk、JH7110 dw-mshc (MMC/SD)
- **网络设备**：VirtIO net、Loopback
- **串口**：UART 16550 / ns16550a / SiFive UART
- **中断控制器**：PLIC
- **设备探测**：基于设备树 (FDT) 的自动设备发现与匹配

#### 9. 同步原语 (lib/mutex/) —— 720 行

提供多种锁实现：自旋锁、睡眠锁、乐观锁、共享锁、自旋转睡眠锁。

#### 10. 异步运行时 (lib/executor/ + lib/osfuture/) —— 332 + 204 行

- `lib/executor/`：多 HART 异步任务执行器，支持工作窃取
- `lib/osfuture/`：OS Future 类型定义

#### 11. 定时器管理 (lib/timer/) —— 306 行

定时器管理器、异步定时器、定时事件。

#### 12. 信号系统 (lib/signal/ + kernel/src/task/signal/) —— 346 行 + 信号处理子模块

信号类型定义、信号处理框架、sigreturn 机制。

#### 13. 配置系统 (lib/config/) —— 930 行

板级配置、设备树配置、文件系统配置、内存布局配置、进程配置等。

#### 14. 架构抽象层 (lib/arch/) —— 903 行

为 RISC-V 和 LoongArch 提供统一的接口：控制台、HART 操作、中断、页表项 (PTE)、时间、陷阱处理。

#### 15. 共享内存 (lib/shm/) —— 172 行

System V 共享内存 ID 管理与标志定义。

#### 16. 辅助库

- `lib/systype/` (726 行)：系统类型定义（错误码、内存标志、时间结构、rlimit 等）
- `lib/common/` (276 行)：通用工具（环形缓冲区、原子标志）
- `lib/id_allocator/` (84 行)：ID 分配器
- `lib/logger/` (185 行)：日志系统
- `lib/polyhal-macro/` (219 行)：过程宏（per-CPU 变量等）
- `lib/simdebug/` (145 行)：仿真调试工具
- `lib/pps/` (139 行)：功能未详

#### 17. 用户态程序 (user/) —— 4,608 行

- `init_proc.rs` / `init_proc-rv.rs` / `init_proc-la.rs`：初始化进程（架构特定）
- `shell.rs`：简易 shell
- 测试程序：`clone_test`, `file_test`, `sleep_test`, `time_test` 等
- `syscall.rs`：用户态系统调用封装
- `ltpauto.rs`：LTP 自动测试框架

---

### 四、编译构建工具需求

从 `Dockerfile`、`Makefile`、`rust-toolchain.toml` 和 `Cargo.toml` 分析，构建该项目需要：

| 工具 | 用途 | 来源 |
|---|---|---|
| Rust nightly-2025-01-18 | 内核及库编译 | rust-toolchain.toml |
| cargo (含 llvm-tools) | Rust 构建系统 + objcopy/objdump | rust-toolchain.toml |
| riscv64-linux-musl-cross | RISC-V 用户态程序交叉编译 | Dockerfile |
| loongarch64-linux-gnu-gcc / loongarch64-linux-musl-cross | LoongArch 用户态交叉编译 | Dockerfile |
| QEMU 9.x | 模拟运行 (riscv64-softmmu, loongarch64-softmmu) | Dockerfile |
| GNU Make | 顶层构建编排 | Makefile |
| Docker (可选) | 容器化构建环境 | Dockerfile |
| mkfs.ext4, dd, mount | 文件系统镜像制作 | Makefile (fs-img 目标) |

构建流程通过 `make build ARCH=riscv64` 触发，底层调用 `cargo build --offline`（离线模式，依赖预 vendor）。内核支持 debug/release 两种模式，通过 `MODE` 变量控制。

---

### 五、初步评估

该项目是一个功能较为完整的研究/竞赛型操作系统内核，具有以下特征：

1. **Linux ABI 兼容度高**：自称实现 100+ 个 Linux 兼容系统调用，可运行 BusyBox、LTP 等标准用户态程序，这一点从 osfs 库的实现广度（procfs、epoll、io_uring、fanotify 等）可以佐证。
2. **异步优先设计**：自研异步运行时（executor + osfuture），区别于传统同步内核设计。
3. **双架构支持**：RISC-V 64 和 LoongArch 64，架构抽象层设计清晰。
4. **子系统覆盖面广**：从 VFS、多文件系统、TCP/IP 网络栈到高级 I/O（epoll、io_uring）均有实现。
5. **工程化程度高**：Docker 构建环境、离线 vendor 依赖、Makefile 多目标构建、LTP 测试框架集成。