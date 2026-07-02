## 项目初步调查结果

### 1. 项目概览

**Nexus OS** 是一个使用 **Rust** 语言编写的多核宏内核操作系统，面向 **RISC-V64** 和 **LoongArch64** 两种指令集架构。项目目标是在内核中直接运行 Linux 用户态程序（如 busybox、bash、GCC、Python 等），并通过 Linux 兼容的系统调用接口对外提供服务。

整体代码量（不含 vendor 与构建产物）：约 **23.5 万行 Rust**，分布在 **241 个源文件**中。

---

### 2. 仓库文件组织结构

```
repo/
├── Makefile                       # 顶层构建入口（make all 生成 kernel + disk 镜像）
├── justfile                       # Just 命令入口（开发/运行/检查）
├── flake.nix / flake.lock         # Nix flake 开发环境
├── rust-toolchain.toml            # Rust 工具链声明（nightly-2025-01-18）
├── .envrc                         # direnv 自动加载
├── .gitignore
├── README.md
├── documentation/                 # 设计文档与 PPT（PDF）
│   ├── 初赛设计文档.pdf
│   └── 初赛PPT.pdf
├── cargo/
│   └── config.toml                # Cargo 离线构建配置（vendor 源映射）
├── justfiles/                     # 模块化 Just 命令定义
│   ├── build.just
│   ├── run.just
│   ├── check.just
│   ├── image.just
│   ├── ai-demo-rootfs.just
│   └── ltp-rootfs-assets.just
├── vendor/                        # 离线构建的 Rust 依赖源码（约 50 个 crate）
│   ├── riscv/, riscv-macros/, riscv-pac/    # RISC-V 寄存器定义
│   ├── loongArch64/                          # LoongArch 寄存器定义
│   ├── smoltcp/                              # TCP/IP 协议栈
│   ├── virtio-drivers/                       # VirtIO 驱动
│   ├── rsext4/ (在 os/third_party/)          # Ext4 文件系统
│   ├── zerocopy/, spin/, lock_api/           # 基础工具库
│   ├── e2fsprogs/                            # ext4 工具
│   └── oscomp-libc-test/                     # libc 测试用例
├── os/                            # **内核主体**（Cargo workspace 核心 package）
│   ├── Cargo.toml
│   ├── build.rs                   # 构建脚本（链接脚本等）
│   ├── src/                       # 内核源码（所有子系统）
│   └── third_party/
│       └── rsext4/                # Ext4 文件系统实现（fork/集成）
├── user/                          # 用户态测试程序（Rust 编写的独立 ELF）
│   ├── init/                      # 内核 init 进程
│   ├── fs_smoke/                  # 文件系统冒烟测试
│   └── fs_exec_probe/             # 文件系统 exec 探测
└── tools/                         # 构建/评测辅助脚本（Python）
    ├── build_nexus_assets_image.py
    ├── build_glibc_runtime_assets.py
    ├── build_e2fsprogs_assets.py
    ├── patch_libctest_assets.py
    ├── oscomp_score.py
    ├── judge_ltp.py
    └── test_judge_ltp.py
```

---

### 3. 子系统划分与对应目录/文件

| 子系统 | 目录/文件 | 简要说明 |
|--------|-----------|----------|
| **HAL（硬件抽象层）** | `os/src/hal/` | 为 RISC-V64 和 LoongArch64 提供统一的启动、trap、中断、时钟、IPI、上下文切换、页表刷新、MMIO 等接口。架构实现位于 `hal/imp/arch/{riscv64,loongarch64}/`，平台实现位于 `hal/imp/platform/{fdt,qemu_virt}.rs` |
| **内存管理 (MM)** | `os/src/mm/` | 页表管理 (`page_table/`)、页帧分配 (`frame/`)、内核堆与 Slab 分配 (`heap/`)、虚拟内存对象 (`vmo/`)、虚拟地址空间 (`vmar/`、`vm_space.rs`)、内核空间映射 (`kspace/`)、缺页处理、TLB 刷新、用户程序加载 (`user_program.rs`) |
| **进程管理** | `os/src/process.rs` | 进程对象：pid/ppid/children/zombie/reap 协议、信号、rlimit、exit 状态等（~7000 行单文件） |
| **线程与调度** | `os/src/thread/` | 线程对象、调度器 (`scheduler.rs`)、处理器上下文 (`processor.rs`)、内核栈、抢占、原子模式、clone 支持、异常处理、线程本地存储 |
| **CPU 本地状态** | `os/src/cpu/` | 关中断、当前 hart 标记等 per-CPU 状态 |
| **SMP 支持** | `os/src/smp.rs` | 处理器间中断调用（IPI），用于 TLB 刷新等场景 |
| **文件系统 (VFS)** | `os/src/fs/` | VFS 框架：路径解析 (`path/`)、目录项缓存 (`dentry`)、挂载 (`mount`)、inode 句柄、fd 表、fs_context；具体文件系统：Ext4 (`ext4/`)、tmpfs、procfs、sysfs、devpts、pipe、pty、memfd、eventfd、signalfd、timerfd、epoll、inotify、fanotify、dnotify、mqueue、flock、lease、pidfd 等 |
| **系统调用** | `os/src/syscall/` | Linux 系统调用分发框架与密集表 (`syscall.rs` ~2400 行 + `table.rs`)，按领域分为：`fs.rs`(~20500 行)、`proc.rs`(~9200 行)、`net.rs`(~18900 行)、`mm.rs`、`ipc.rs`(~4100 行)、`futex.rs`、`epoll.rs`、`eventfd.rs`、`inotify.rs`、`fanotify.rs`、`memfd.rs`、`signalfd.rs`、`timerfd.rs`、`mqueue.rs`、`keyctl.rs`、`rseq.rs` 等 |
| **网络栈** | `os/src/net/` | 基于 socket 接口：本地回环和 IPv4 TCP/UDP。外部通信由 `smoltcp` 处理协议栈，`virtio-net` 提供帧级收发 (`device.rs`、`stack.rs`) |
| **设备驱动** | `os/src/drivers/` | 块设备层 (`block/`)、VirtIO 传输层 (`virtio/transport/{mmio,pci}.rs`)、VirtIO 块设备 (`virtio/blk/`)、VirtIO 网络 (`virtio/net/`)、平台设备 (`platform/`：UART16550、syscon poweroff) |
| **同步原语** | `os/src/sync/` | SpinLock、Mutex、RwLock、Once、WaitQueue、RCU、Guard 传递机制 |
| **时间管理** | `os/src/time.rs` | 单调时间、实时时间、周期 tick、定时睡眠、睡眠队列（~24000 行） |
| **用户态执行** | `os/src/user.rs` | 用户态上下文接口、trap 进入/返回 |
| **随机数** | `os/src/random.rs` | ChaCha20 内核随机数生成器 |
| **错误处理** | `os/src/error.rs` | POSIX errno 枚举、`Error` 类型 |
| **日志/输出** | `os/src/logger.rs`、`os/src/printk.rs` | 内核日志基础设施 |
| **资源诊断** | `os/src/resource_accounting.rs` | 资源生命周期诊断记录（原子计数器，57 万行，包含大量条件编译的统计路径） |
| **内核测试** | `os/src/ktest/` | 内核内置测试（`fs.rs` ~7800 行，`mm.rs`），通过 `ktest` feature 启用 |
| **OSComp 运行器** | `os/src/oscomp_runner/` | 比赛评测运行框架：basic、busybox、LTP、AI demo、catalog、full_catalog 等场景 |
| **超时机制** | `os/src/runner_timeout.rs` | 运行超时检测（~79000 行，包含大量条件编译的 failpoint 注入逻辑） |

---

### 4. 编译构建工具链

| 工具/依赖 | 用途 |
|-----------|------|
| **Rust nightly-2025-01-18** | 内核与用户程序编译，目标三元组：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none` |
| **Cargo** | Rust 包管理与构建（使用 `--frozen` 离线模式） |
| **Make** | 顶层构建编排（`make all`） |
| **Just** | 开发工作流命令（构建、运行、检查、镜像制作） |
| **Nix (flake)** | 可重现开发环境，提供 Rust 工具链、QEMU、交叉编译器等 |
| **Python 3** | 资产镜像构建脚本（glibc runtime、e2fsprogs、libc test 补丁、镜像打包） |
| **QEMU** | RISC-V64 与 LoongArch64 模拟运行 |
| **OpenSBI/RustSBI** | RISC-V 的 SBI 固件 |
| **交叉编译工具链** | `riscv64-linux-gnu-*`、`loongarch64-linux-gnu-*`（用于构建用户态资产），`riscv64gc-unknown-none-elf`（内核裸机目标） |
| **e2fsprogs** | ext4 文件系统工具（mkfs.ext4 等） |
| **设备树编译器 (dtc)** | 设备树处理 |

构建产物：
- `kernel-rv` / `kernel-la`：RISC-V64 / LoongArch64 内核 ELF
- `disk.img` / `disk-rv.img` / `disk-la.img`：对应的磁盘镜像（ext4 文件系统，包含用户态资产）