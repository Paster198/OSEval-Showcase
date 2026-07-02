## 项目初步分析报告

---

### 一、项目概览

**项目名称**: RustMicroOS  
**项目描述**: 基于 Rust 语言的微内核操作系统，面向 RISC-V 64-bit 和 LoongArch64 双架构，参赛项目。  
**代码规模**: 
- 内核源码（`kernel/src`）约 258 个 Rust 源文件，合计约 135,682 行代码
- 整个 workspace 包含内核、用户空间库、文件系统制作工具三个 crate

---

### 二、仓库文件组织结构

```
repo/
├── kernel/                     # 内核 crate（核心）
│   ├── Cargo.toml
│   ├── build.rs                # 构建脚本（根据架构选择链接脚本）
│   ├── loongarch64-unknown-none.json  # LoongArch64 自定义 target JSON
│   ├── linker.ld / linker-la.ld       # 链接脚本（RISC-V / LoongArch64）
│   ├── src/                    # 内核源码（约 258 个 .rs 文件，~135K 行）
│   └── tests/                  # 内核集成测试
├── user/                       # 用户空间库 + 应用程序 crate
│   ├── Cargo.toml
│   ├── build.rs
│   └── src/
│       ├── lib.rs              # 用户库（syscall 封装、文件系统、io_uring）
│       └── bin/                # 用户程序（sh, ls, cat, echo, init 等 19 个）
├── tools/mkfs/                 # FAT32 文件系统镜像制作工具 crate
├── vendor/                     # 离线依赖 vendored（~110 个 crate）
├── tests/                      # 外部测试文件（property tests, musl 测试二进制等）
├── scripts/                    # 构建/运行/测试辅助脚本（~45 个）
├── local-judge/                # 本地评测脚本与诊断
├── reference-works/            # 参考作品
├── doc/                        # 项目文档（设计文档、开发计划、答辩材料等）
├── docs/                       # 架构分析、Linux 兼容性审计等
├── .cargo/config.toml          # Cargo 配置（target、runner、vendor 源）
├── cargo-config/config.toml    # .cargo/config.toml 的模板副本
├── Cargo.toml                  # workspace 根配置
├── Makefile                    # 顶层构建文件（双架构编译）
├── rust-toolchain.toml         # Rust 工具链配置（nightly-2025-02-01）
└── README.md
```

---

### 三、子系统初步划分

根据 `kernel/src/` 下的目录结构和各模块职责，将内核划分为以下子系统：

| 子系统 | 目录/文件 | 功能描述 |
|--------|----------|---------|
| **架构层 (Arch)** | `arch/` | RISC-V64 和 LoongArch64 双架构支持：上下文切换、陷阱处理、内存管理底层、定时器、启动汇编、HAL trait |
| **内存管理 (MM)** | `mm/` | 物理帧分配（buddy）、页表管理、地址空间、Slab 分配器、Per-CPU 缓存、TLB 管理、ASID、页面缓存、Swap、内存 cgroup、NUMA mempolicy、PMEM |
| **进程调度 (Sched)** | `sched/` | MLFQ 调度器、实时调度（deadline）、进程创建/退出/fork/wait、SMP 多核启动、优先级继承互斥锁、POSIX 定时器、进程追踪(ptrace)、等待队列 |
| **系统调用 (Syscall)** | `syscall/` | 60+ 个 syscall 处理模块，覆盖：进程管理、文件系统、内存、信号、socket、IPC、io_uring、futex、poll/epoll、cgroup、capability 等 |
| **虚拟文件系统 (FS/VFS)** | `fs/` | VFS 抽象层、FAT32 文件系统、ext4（只读）、ramfs、devfs、procfs、sysfs、cgroupfs、memcgfs、bindfs、管道、epoll、eventfd、signalfd、timerfd、文件锁、splice |
| **能力安全 (Capability)** | `capability/` | 基于能力的访问控制：CapType、CapRights、CNode、派生与撤销 |
| **进程间通信 (IPC)** | `ipc/` | 微内核 IPC：同步消息传递、异步通知、System V 消息队列/信号量/共享内存 |
| **网络协议栈 (Net)** | `net/` | 基于 smoltcp 的 TCP/IP：TCP（含拥塞控制/重传）、UDP、ICMP、DNS、socket API、loopback、原始套接字、Netlink、AF_ALG、zerocopy |
| **设备驱动 (Driver)** | `driver/` | VirtIO 驱动框架：VirtIO-Blk、VirtIO-Net（PCI + MMIO transport）、UART 用户态驱动框架 |
| **异步运行时 (Async RT)** | `async_rt/` | 内核级异步运行时 |
| **eBPF 子系统** | `ebpf/` | eBPF 验证器、JIT 编译器、Maps、程序类型 |
| **io_uring** | `io_uring/` | Linux 兼容 io_uring：SQ/CQ 环形缓冲区、批量 I/O、SQPOLL、链式操作 |
| **程序加载器 (Loader)** | `loader/` | ELF 加载器 |
| **程序执行 (Exec)** | `exec/` | execve 执行路径、脚本解释器、BusyBox applet 回退 |
| **评测运行器 (Runner)** | `runner/` | 自动评测：标记输出、测试脚本扫描、执行与超时处理、shell |
| **GDB Stub** | `gdb/` | 内核级 GDB 远程调试协议支持 |
| **安全子系统 (Security)** | `security/`、`secure/` | 密钥环(keyring)、Landlock 沙箱、启动链验证与度量 |
| **seccomp** | `seccomp/` | cBPF seccomp 过滤器 |
| **CHERI 能力模拟** | `cheri/` | CHERI 硬件能力（内存边界/权限检查）软件模拟 |
| **Hypervisor** | `hypervisor/` | 虚拟化支持、VirtIO 半虚拟化 |
| **热补丁 (Livepatch)** | `livepatch/` | 内核热补丁支持 |
| **形式化验证 (Formal)** | `formal/` | IPC 规约、能力操作验证、属性验证报告生成 |
| **电源管理 (Power)** | `power/` | 电源策略管理 |
| **同步原语 (Sync)** | `sync/` | SpinLock、中断保护临界区 |
| **安全编程抽象 (Safety)** | `safety/` | KRef 引用计数、类型状态模式 |
| **无锁数据结构 (Lockfree)** | `lockfree/` | 无锁并发数据结构 |
| **性能基准 (Benchmark)** | `benchmark/` | 性能基准测试框架 |
| **辅助模块** | `config.rs`、`cmdline.rs`、`console.rs`、`error.rs`、`lang_items.rs`、`random.rs`、`main.rs` | 内核配置、命令行解析、控制台、统一错误类型、Rust 语言项、随机数、入口 |

---

### 四、编译构建工具需求

根据 `Makefile`、`rust-toolchain.toml`、`Cargo.toml` 分析：

| 需求类别 | 具体工具 |
|----------|---------|
| **Rust 工具链** | nightly-2025-02-01，组件：`rust-src`、`llvm-tools-preview`；Target：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none` |
| **RISC-V 交叉编译** | `riscv64-linux-gnu-gcc`（CC）、`riscv64-unknown-elf-objcopy/objdump`、OpenSBI 固件 |
| **LoongArch 交叉编译** | `loongarch64-linux-gnu-gcc`（CC）、`rust-objcopy`/`rust-objdump` |
| **模拟器** | QEMU：`qemu-system-riscv64`、`qemu-system-loongarch64` |
| **构建系统** | GNU Make、Cargo |
| **文件系统镜像** | `tools/mkfs`（FAT32 制作工具，依赖 clap/fatfs）、或外部 ext4 镜像 |
| **编译器包装** | 创建 musl-gcc → gnu-gcc 转发脚本（lwext4 C 库交叉编译） |
| **设备树** | dtc（推测，用于 DTB 解析） |
| **离线依赖** | `vendor/` 目录提供全部 vendored 依赖 |

核心构建流程：`make all` → 先构建 `user/` 用户程序，再分别编译 RISC-V64 和 LoongArch64 内核 ELF，输出 `kernel-rv` 和 `kernel-la`。

---

### 五、初步评估要点

1. **代码组织**：采用 Rust workspace 单仓结构，内核、用户库、工具分离，结构清晰。内核内部按子系统以目录划分，模块化程度高。

2. **子系统覆盖度**：项目展现出极高的覆盖面，不仅包含传统 OS 内核的基础子系统（内存管理、进程调度、文件系统、网络），还集成了大量现代/高级特性（io_uring、eBPF、seccomp、能力安全、CHERI、形式化验证、热补丁、GDB stub 等）。

3. **双架构支持**：通过条件编译和架构抽象层同时支持 RISC-V64 和 LoongArch64，HAL trait 提供了架构无关接口。

4. **参赛特征明显**：存在专门的 `runner/` 评测模块、`local-judge/` 本地评测工具、大量测试脚本和符合竞赛格式的输出规范。

5. **外部依赖策略**：内核不依赖 libc（`no_std`），使用 `virtio-drivers`、`smoltcp`、`ext4-view` 等生态 crate，所有依赖通过 `vendor/` 离线提供。