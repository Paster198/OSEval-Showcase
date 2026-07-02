## 项目初步调查报告

### 一、项目概览

**OS_mod** 是一个使用 Rust 语言（`no_std` / `#![no_main]`）从零编写的双架构现代操作系统内核，参赛队为"不讲不讲队"，赛道为全国大学生计算机系统能力大赛·操作系统设计赛·内核实现赛道。目标架构为 **RISC-V 64GC（Sv39）** 和 **龙芯 LoongArch 64**，支持在 QEMU 及物理开发板（VisionFive 2 / 2K1000LA）上运行。

---

### 二、仓库顶层文件结构

```
repo/
├── Cargo.toml              # Rust 项目配置（包名: os_mod_kernel, edition 2021）
├── Cargo.lock              # 依赖锁定文件
├── rust-toolchain.toml     # Rust nightly-2025-01-18，目标: riscv64gc-unknown-none-elf, loongarch64-unknown-none
├── Makefile                # 主构建入口（双架构内核构建、测试门禁）
├── README.md               # 项目自述
├── LICENSE                 # Mulan PSL v2
├── .gitignore / .gitattributes
├── src/                    # 内核源代码（Rust）
├── boot/                   # 启动汇编（riscv64.S, loongarch64.S）
├── linker/                 # 链接脚本（riscv64.ld, loongarch64.ld）
├── cargo-config/           # Cargo 离线构建配置
├── scripts/                # 构建、测试、验证脚本（~30个 .sh/.py 文件）
├── docs/                   # 开发计划文档
├── kernel-rv-genuine       # 预编译 RISC-V 内核 ELF（带 AddrSpace 真实 VM）
├── kernel-rv-fencefix      # 预编译 RISC-V 内核 ELF（fence 修复版）
├── kernel-la-probe         # 预编译 LoongArch 内核 ELF（探测版）
└── *.pdf / *.txt / *.pptx  # 项目文档与路演材料
```

---

### 三、子系统划分

#### 1. 架构抽象层（Architecture Layer）

| 文件/目录 | 行数 | 职责 |
|-----------|------|------|
| `src/arch/mod.rs` | 45 | 架构模块入口 |
| `src/arch/riscv64.rs` | 692 | RISC-V 64GC：UART、SBI 调用（shutdown/timer）、CSR 操作、用户态陷阱帧、定时器中断、Sv39 satp 构建 |
| `src/arch/loongarch64.rs` | 635 | LoongArch 64：UART、ACPI 关机、CSR 操作（CRMD/PRMD/TCFG）、定时器中断、DMW 配置、用户态陷阱帧 |
| `boot/riscv64.S` | ~4,776 B | RISC-V 启动向量、栈初始化、陷阱入口（保存/恢复寄存器） |
| `boot/loongarch64.S` | ~15,281 B | LoongArch 启动向量、栈初始化、Trap/TLB Refill 处理、上下文保存/恢复 |
| `linker/riscv64.ld` | - | RISC-V 链接脚本（基址 0x80200000） |
| `linker/loongarch64.ld` | - | LoongArch 链接脚本（基址 0x90000000） |
| `src/mmio.rs` | 41 | MMIO 读写原语 |

#### 2. 内存管理（Memory Management）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/paging.rs` | 1,192 | 页表构建核心：Sv39 PTE 位定义、三级页表遍历/映射/解除映射、LoongArch TLBELO 常量、`PageTable` trait 抽象。所有逻辑为纯算术运算，可在宿主机单元测试 |
| `src/vm.rs` | 2,910 | 真实虚拟内存重写（`addrspace` feature）：`AddrSpace<PT: PageTable>` 泛型地址空间、按需分页、写时复制 (COW)、引用计数帧分配器 (`FrameAllocator`)、`MAP_SHARED` 共享内存、文件映射。编译受 feature 门控 |
| `src/user.rs` | 1,903 | 用户地址空间定义（`USER_BASE=0x1000`, `USER_SIZE=40 MiB`）、用户内存读写接口 (`UserMemory`)、`UserMemoryAccess` trait、初始栈与 auxiliary vector 构建、动态链接器加载支持 |

#### 3. 进程管理（Process Management）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/process.rs` | 3,589 | 核心进程运行时：`ProcessRuntime` 调度器（协作+抢占式）、进程/线程生命周期（fork/clone/execve/exit/wait4）、管道（pipe/FIFO）、回环套接字（socket/bind/listen/connect/accept/send/recv）、futex 阻塞、nanosleep 阻塞、文件描述符表、线程组管理 |
| `src/signal.rs` | 591 | POSIX 信号状态机：信号 disposition（ignore/default/handler）、pending/blocked 掩码、sigaction/sigprocmask/sigreturn、SIGALRM+setitimer 定时器信号。纯状态逻辑，宿主可测 |
| `src/run_budget.rs` | 55 | 用户运行预算（`UserRunBudget`）——确保所有用户进程在抢占式定时器预算内运行 |

#### 4. 系统调用接口（Syscall Interface）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/syscall/mod.rs` | 7,393 | 系统调用总调度（约 100+ 个 syscall 号）、`SyscallContext` 结构体、VFS 节点类型、运行时可写文件池、errno 常量 |
| `src/syscall/context.rs` | 53 | `ProcessState`、`UserMemoryAccess` trait、`SyscallOutput` trait（界定内核与用户空间边界） |
| `src/syscall/file.rs` | 1,050 | 文件/目录/stat 类系统调用：openat、close、dup/dup3、fcntl、mkdirat、unlinkat、linkat、renameat2、chdir、getcwd、getdents64、fstat/newfstatat/statx、mount/umount2、ioctl 等 |
| `src/syscall/io.rs` | 305 | 读写 I/O：read/write、pread64/pwrite64、readv/writev、preadv/pwritev（含 v2 变体） |
| `src/syscall/memory.rs` | 253 | 内存管理：brk、mmap、mprotect、munmap |
| `src/syscall/time.rs` | 269 | 时间相关：nanosleep、clock_gettime、gettimeofday、times。支持安装真实时钟源 |
| `src/syscall/info.rs` | 231 | 信息/存根：uname、sysinfo、getrandom、prctl、getrlimit/setrlimit/prlimit64、getrusage |
| `src/syscall/storage.rs` | 221 | 运行时 VFS 外部数据存储池（大文件内容溢出到固定槽位） |

#### 5. 文件系统（File System）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/fs/ext4.rs` | 1,401 | 真实 ext4 只读解析器：超级块验证（magic 0xEF53）、extent 树遍历、inode 读取、目录项枚举、路径解析、脚本发现（`MAX_SCRIPT_BYTES=16KiB`） |
| `src/block.rs` | 206 | 块设备抽象：`BlockDevice` trait、`BlockError` 错误类型、设备诊断快照 |

#### 6. VirtIO 驱动（Block Device Driver）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/virtio/mod.rs` | 4 | VirtIO 子模块入口 |
| `src/virtio/blk.rs` | 68 | VirtIO 块设备请求封装（读请求 header） |
| `src/virtio/queue.rs` | 208 | VirtIO 队列（virtqueue）管理：描述符环、available/used 环 |
| `src/virtio/mmio.rs` | 473 | VirtIO-MMIO 传输层：设备发现、初始化、队列设置、读写操作 |
| `src/virtio/pci.rs` | 594 | VirtIO-PCI 传输层：PCI 配置空间扫描、设备发现、MSI-X 中断 |

#### 7. ELF 加载器（ELF Loader）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/elf.rs` | 1,004 | ELF64 解析：ET_EXEC/ET_DYN、PT_LOAD/PT_INTERP/PT_TLS 段、RISC-V (EM=243) 和 LoongArch (EM=258) 支持、动态链接器加载、TLS 段处理 |
| `src/exec_cache.rs` | 194 | ELF 镜像缓存（LRU 语义，2 槽位），避免重复从 ext4 读取 |

#### 8. 脚本与基准测试运行时（Script & Benchmark Runtime）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/runner.rs` | 614 | 脚本运行器主循环：解析 marker、调度用户态执行、输出收集 |
| `src/script.rs` | 150 | 脚本 marker（START/END）提取与解析 |
| `src/script_exec.rs` | 370 | 脚本命令解析与执行计划：命令解析、参数展开、条件判断 |
| `src/script_runtime/mod.rs` | 11 | 脚本运行时子模块入口 |
| `src/script_runtime/busybox_words.rs` | 99 | BusyBox shell 词法分析（引号处理） |
| `src/script_runtime/lines.rs` | 87 | 按行分割、空白裁剪 |
| `src/script_runtime/nesting.rs` | 44 | 脚本嵌套深度守卫（防止无限递归） |
| `src/script_runtime/shell_test.rs` | 157 | Shell 测试内置命令（如 `[` / `test`）模拟 |
| `src/scoring.rs` | 79 | 评分输出格式化（marker 前缀/后缀、fallback 分组） |

#### 9. 基准测试适配器（Benchmark Adapters）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/bench/mod.rs` | 10 | 适配器模块入口 |
| `src/bench/adapter.rs` | 106 | 适配器 trait 与身份标识 |
| `src/bench/unsupported.rs` | 13 | 不支持基准的通用 fallback |
| `src/busybox.rs` | 568 | BusyBox 真实 shell 执行 |
| `src/lua.rs` | 88 | Lua 解释器执行 |
| `src/libctest.rs` | 345 | musl libc 测试套件 |
| `src/libcbench.rs` | 188 | libc 性能基准 |
| `src/lmbench.rs` | 241 | Lmbench 性能基准 |
| `src/ltp.rs` | 486 | Linux Test Project (LTP) 测试套件 |
| `src/cyclictest.rs` | 133 | Cyclictest 实时性基准 |
| `src/iozone.rs` | 290 | IOzone 文件系统基准 |
| `src/unixbench.rs` | 434 | UnixBench 系统基准 |
| `src/iperf.rs` | 67 | iPerf 网络基准（回环） |
| `src/netperf.rs` | 79 | Netperf 网络基准（回环） |
| `src/lua.rs` | 88 | Lua 基准 |

#### 10. 运行时策略（Runtime Policy）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/runtime/mod.rs` | 9 | 运行时策略模块入口 |
| `src/runtime/budget.rs` | 147 | 运行 tick 预算（`RunTickBudget`）：确保所有用户态profile在抢占式定时器预算内运行 |
| `src/runtime/resources.rs` | 78 | 集中式资源策略配置（`ResourceProfile`）：进程限制、内存槽位、ELF 大小上限、脚本限制等 |
| `src/runtime/session.rs` | 35 | 运行时会话管理 |

#### 11. 能力分类（Capability）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/capability.rs` | 387 | 脚本组分类（Basic/BusyBox/Lua/LibcTest 等）、能力等级（Real/PartialReal/CompatibilityRenderer/Unsupported）、架构特定能力策略 |

#### 12. 基础设施（Infrastructure）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/main.rs` | 10,723 | 内核入口 `kernel_main`：初始化、脚本发现→执行主循环、所有基准组的调度与 fallback 逻辑、用户态执行路径 |
| `src/lib.rs` | 271 | 库入口 + 大量编译时契约/行为测试（~384+ 个 host test） |
| `src/panic.rs` | 7 | panic 处理 |
| `src/shutdown.rs` | 15 | 关机处理 |
| `src/console.rs` | 45 | 控制台输出 |
| `src/byte.rs` | 48 | 字节序转换（`u16_le`/`u32_le`/`u64_le`） |
| `src/fixed.rs` | 72 | 固定容量列表（`FixedList`） |
| `src/riscv_user.rs` | 673 | RISC-V 用户态指令模拟（指令访问故障恢复） |

---

### 四、构建工具与依赖

基于 `Makefile`、`Cargo.toml` 和 `rust-toolchain.toml` 分析：

| 工具/依赖 | 用途 |
|-----------|------|
| **Rust nightly-2025-01-18** | 编译器 + Cargo，目标三元组 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` |
| **clang** | 编译 RISC-V/LoongArch 启动汇编（`boot/riscv64.S`, `boot/loongarch64.S`） |
| **GNU ld** (via Cargo rustc) | 链接内核 ELF（`-C link-arg=-T<linker-script>`） |
| **QEMU** | RISC-V virt 和 LoongArch virt 模拟（评测 Docker 镜像：`zhouzhouyi/os-contest:20260510`） |
| **mkfs.ext4 / bash** | 构建测试用 ext4 磁盘镜像 |
| **Cargo 离线模式** | `cargo-config/config.toml` 强制 `offline = true`，无需网络 |

构建命令：
- `make all` → 双架构内核（`kernel-rv` + `kernel-la`）
- `make kernel-rv` → 仅 RISC-V（features: `arch-riscv64 stage1-per-process stage1-lazy-demand addrspace`）
- `make kernel-la` → 仅 LoongArch（features: `arch-loongarch64 la-addrspace-probe`）
- `make test-host` → 宿主机单元测试（无需 QEMU，384+ 测试用例）

---

### 五、初步印象总结

1. **代码规模**：总 Rust 代码约 42,750 行（其中 `main.rs` 约 10,700 行，`syscall/mod.rs` 约 7,400 行，`process.rs` 约 3,600 行，`vm.rs` 约 2,900 行），加上约 20,000 字节的汇编启动代码。

2. **架构特征**：该项目呈现明显的"比赛内核"特征——有一个巨大的 `main.rs` 作为中心调度枢纽，大量基准测试适配器以独立模块存在，系统调用实现较为完整但面向评分测试集优化。

3. **核心子系统完整性**：进程管理、内存管理（含 MMU 分页与 COW）、文件系统（ext4 只读）、VirtIO 块设备驱动、ELF 加载器（含动态链接）、信号机制、管道/套接字 IPC 均有所实现。

4. **feature 门控策略**：真实 VM（`addrspace` feature）通过 Rust feature flag 与快照路径隔离，可在不改变既有评分地板的前提下逐步迁移。

5. **测试体系**：384+ 宿主机单元测试覆盖架构无关的核心逻辑（页表遍历、引用计数、COW 语义等），另有大量 `verify-*.sh` 脚本用于 QEMU 实跑门禁。