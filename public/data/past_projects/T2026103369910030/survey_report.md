# KernelX OS 内核项目初步调查报告

## 1. 项目概述

KernelX 是一个从零开始自主设计、以 Rust 为主要开发语言的类 UNIX 宏内核。项目支持 RISC-V 64-bit（主线）和 LoongArch 64-bit 两种架构，可在 QEMU 及部分真实开发板上运行。内核核心代码约 64,700 行 Rust 代码，分布在 335 个 `.rs` 源文件中。

## 2. 仓库文件组织结构

```
<仓库根>/
├── README.md                     # 项目说明与完成情况
├── Makefile                      # 顶层 Makefile，代理到 kernelx/
├── build.sh                      # 一键构建脚本（磁盘镜像 + 内核）
├── build-kernel.sh               # 内核构建脚本（riscv + loongarch 两架构）
├── build-disk.sh                 # 磁盘镜像构建脚本
├── build-local-la.sh             # LoongArch 本地构建脚本
├── run.sh                        # QEMU（RISC-V）运行脚本
├── run-la.sh                     # QEMU（LoongArch）运行脚本
├── ltp_test_status.csv           # LTP 测试状态矩阵
├── scripts/                      # 仓库级辅助脚本
│   ├── prepare-fat32-image.sh
│   ├── sync_kernelx_dev.sh
│   ├── sync_ltp_test_status.sh
│   └── update_ltp_testcode.py
├── testcode-rv/                  # RISC-V 测试代码与根文件系统内容
│   ├── bin/                      # 预编译二进制
│   ├── data/                     # 测试数据
│   ├── runtest.sh                # 测试执行入口
│   └── *_testcode.sh             # 各类测试脚本（busybox/lmbench/iperf等）
├── testcode-la/                  # LoongArch 测试代码与根文件系统内容
│   ├── bin/                      # 预编译二进制
│   ├── data/                     # 测试数据
│   ├── runtest.sh                # 测试执行入口
│   └── *_testcode.sh             # 各类测试脚本
├── docs/                         # 项目文档（latex/static/quick-start.md）
└── kernelx/                      # 内核核心源码（详见下）
```

### kernelx/ 目录结构

```
kernelx/
├── Cargo.toml                    # Rust 工程配置与依赖声明
├── Cargo.lock
├── Makefile                      # 内核级 Makefile（代理到 build.mk）
├── build.mk                      # 核心构建逻辑
├── rust-toolchain.toml           # 指定 nightly Rust 工具链
├── rustfmt.toml
├── Dockerfile                    # 容器化构建环境
├── config/
│   ├── Kconfig                   # 内核配置项定义（408行，约50个配置项）
│   ├── config.mk                 # 配置解析 Makefile
│   └── .config                   # 实际配置快照（由 menuconfig 生成）
├── src/                          # 内核主体 Rust 源代码（335个.rs文件）
│   ├── main.rs                   # 内核入口
│   ├── arch/                     # 架构抽象层
│   ├── driver/                   # 设备驱动框架
│   ├── fs/                       # 虚拟文件系统与各类文件系统实现
│   ├── kernel/                   # 内核核心子系统
│   ├── klib/                     # 内核公用库
│   ├── kvm/                      # KVM 虚拟化支持
│   └── net/                      # 网络协议栈
├── clib/                         # C 语言底层库（启动/陷阱/内存/文件系统绑定）
│   ├── src/                      # C/汇编源文件
│   ├── include/                  # 头文件
│   └── lib/                      # 第三方 C 库（libfdt, lwext4, tlsf）
├── vdso/                         # vDSO 实现
├── usertests/                    # 用户态测试程序构建系统
├── scripts/                      # 内核级辅助脚本
│   ├── build.rs                  # Cargo build.rs（bindgen/链接配置）
│   ├── linker/                   # 链接脚本
│   ├── qemu.mk                   # QEMU 启动配置
│   ├── gen_symbols.py            # 符号表生成
│   └── cmake/                    # CMake 辅助
├── vendor/                       # Rust 依赖的 vendor 缓存（~90个crate）
├── docs/                         # 内核文档
│   ├── arch.md, boot.md, driver.md, filesystem.md
│   ├── ipc.md, memory.md, task.md, utask.md
│   └── static/                   # 静态资源（含架构图 struct.svg）
└── .github/                      # CI 配置
```

## 3. 已实现的子系统

### 3.1 架构抽象层（`src/arch/`）

| 子目录/文件 | 职责 |
|---|---|
| `arch/mod.rs` | 架构无关的类型别名与 `arch_export!` 宏（统一接口） |
| `arch/riscv/` | RISC-V 64-bit 具体实现：页表、CSR、PLIC、SBI 驱动、任务上下文切换、KVM |
| `arch/loongarch/` | LoongArch 64-bit 具体实现：页表、CSR、EIOINTC、PCH-PIC、任务上下文、启动 |

### 3.2 设备驱动框架（`src/driver/`）

| 子目录 | 职责 |
|---|---|
| `driver/device.rs`, `driver.rs`, `manager.rs`, `matcher.rs` | 统一设备驱动框架：设备模型、驱动注册/匹配、基于设备树的发现 |
| `driver/block/` | 块设备驱动：virtio-blk、loop 设备、StarFive SDIO |
| `driver/char/` | 字符设备驱动：ns16550a 串口、virtio-console、TTY 层 |
| `driver/net/` | 网络设备驱动：virtio-net |
| `driver/virtio/` | virtio 传输层抽象（MMIO/PCI） |
| `driver/rtc/` | RTC 驱动：goldfish、LS7A |
| `driver/pci.rs`, `driver/pmu.rs` | PCI 总线支持、PMU |

### 3.3 文件系统（`src/fs/`）

| 子目录 | 职责 |
|---|---|
| `fs/vfs/` | VFS 层：dentry、inode、挂载、超级块表、路径解析、文件操作 |
| `fs/file/` | 文件描述符模型 |
| `fs/inode/` | inode 缓存、文件锁（BSD/POSIX）、索引节点管理 |
| `fs/ext4/` | ext4 文件系统（基于 C 库 lwext4 的绑定，通过 bindgen 生成 FFI） |
| `fs/ext4_native/` | 原生 Rust ext4 实现 |
| `fs/devfs/` | 设备文件系统 |
| `fs/procfs/` | proc 文件系统（含 task、sys 等节点） |
| `fs/tmpfs/` | 临时文件系统 |
| `fs/memfs/` | 内存文件系统 |
| `fs/memtreefs/` | 内存树文件系统 |
| `fs/vfat/` | VFAT/FAT32 文件系统 |
| `fs/exfat/` | exFAT 文件系统 |
| `fs/rootfs/` | 根文件系统初始化 |

### 3.4 内核核心子系统（`src/kernel/`）

| 子目录 | 职责 |
|---|---|
| `kernel/main.rs` | 内核启动流程（kinit） |
| `kernel/config.rs` | 内核编译期配置常量 |
| `kernel/trap.rs` | 异常/中断处理框架 |
| `kernel/mm/` | 内存管理：地址空间、页分配、ELF 加载、映射区域、交换（swap） |
| `kernel/scheduler/` | 调度器与调度策略 |
| `kernel/syscall/` | 系统调用：mm、fs、task、ipc、event、socket、futex、time、misc 等 |
| `kernel/task/` | 任务管理：TCB、文件描述符表、PID 分配、UTS namespace |
| `kernel/event/` | 事件通知：epoll、poll、timerfd、eventfd、posix_timer、fanotify、waitqueue |
| `kernel/ipc/` | 进程间通信：管道、信号、消息队列、信号量、共享内存、Unix 域套接字 |
| `kernel/kthread/` | 内核线程框架 |
| `kernel/usync/` | 用户态同步原语：futex |

### 3.5 网络协议栈（`src/net/`）

| 子目录 | 职责 |
|---|---|
| `net/protocol/` | 协议实现：ARP、DHCP、Ethernet、ICMP、IPv4、TCP、UDP |
| `net/socket/` | 套接字层：AF_INET、AF_NETLINK、RAW、TCP、UDP |
| `net/interface/` | 网络接口管理层：端口管理、ARP 缓存、DHCP 客户端 |
| `net/manager/` | 网络管理器 |

### 3.6 KVM 虚拟化（`src/kvm/`，feature-gated）

| 文件 | 职责 |
|---|---|
| `kvm/addrspace.rs` | 虚拟机地址空间管理 |
| `kvm/vtask.rs` | 虚拟任务 |
| `kvm/vtaskset.rs` | 虚拟任务集合 |

### 3.7 内核公用库（`src/klib/`）

| 子目录/文件 | 职责 |
|---|---|
| `klib/kalloc.rs` | 内核内存分配器 |
| `klib/ksync/` | 同步原语：spinlock、mutex、rwlock、sleeplock、lockdep |
| `klib/backtrace/` | 栈回溯支持 |
| `klib/klog.rs`, `klib/dmesg.rs` | 内核日志系统 |
| `klib/print.rs` | 格式化输出 |
| `klib/ring.rs` | 环形缓冲区 |
| `klib/lru.rs` | LRU 缓存 |
| `klib/pagearray.rs` | 页数组 |
| `klib/crc32c.rs` | CRC32C 校验 |
| `klib/random.rs` | 随机数 |
| `klib/defer.rs` | 延迟执行 |
| `klib/initcell.rs` | 初始化单元 |
| `klib/utils.rs` | 工具函数 |

### 3.8 C 语言底层库（`clib/`）

以 C 和汇编实现的底层代码：

- **启动入口**：RISC-V 和 LoongArch 的 entry.S、init.c
- **陷阱处理**：kerneltrap.S、usertrap.S、FPU 保存/恢复
- **内存**：内核页表设置（mapkernel.c）、TLSF 内存分配器
- **ext4 C 绑定**：通过 lwext4 库提供 ext4 操作（inode、read、write、link、truncate）
- **设备树**：libfdt 用于设备树解析

### 3.9 vDSO（`vdso/`）

为特定系统调用（如 `gettimeofday`）提供用户态快速路径。

## 4. 子系统与目录/文件的粗略对应关系

| 子系统 | 主要目录 |
|---|---|
| 架构抽象 | `src/arch/`, `clib/src/arch/` |
| 设备驱动 | `src/driver/` |
| 虚拟文件系统 | `src/fs/vfs/`, `src/fs/file/`, `src/fs/inode/` |
| 具体文件系统 | `src/fs/ext4/`, `src/fs/ext4_native/`, `src/fs/devfs/`, `src/fs/procfs/`, `src/fs/tmpfs/`, `src/fs/memfs/`, `src/fs/memtreefs/`, `src/fs/vfat/`, `src/fs/exfat/` |
| 内存管理 | `src/kernel/mm/` |
| 任务管理 | `src/kernel/task/` |
| 调度器 | `src/kernel/scheduler/` |
| 系统调用 | `src/kernel/syscall/` |
| IPC | `src/kernel/ipc/` |
| 事件通知 | `src/kernel/event/` |
| 内核线程 | `src/kernel/kthread/` |
| 用户同步 | `src/kernel/usync/` |
| 网络协议栈 | `src/net/` |
| KVM 虚拟化 | `src/kvm/` |
| 内核工具库 | `src/klib/` |
| C 底层库 | `clib/` |
| vDSO | `vdso/` |
| 用户态测试 | `usertests/` |

## 5. 编译构建所需工具

根据 `build.mk`、`build.rs`、`config/Kconfig` 和 `Cargo.toml` 的分析，构建 KernelX 需要以下工具链：

### 5.1 必需工具

| 工具 | 用途 |
|---|---|
| **Rust nightly 工具链** | 内核主体编译（通过 `rust-toolchain.toml` 指定 nightly channel）；目标：`riscv64gc-unknown-none-elf` 或 `loongarch64-unknown-none` |
| **C 交叉编译器** | 编译 `clib/` 中的 C/汇编代码（RISC-V: `riscv64-unknown-elf-gcc` 或 `riscv64-linux-gnu-gcc`；LoongArch: `loongarch64-linux-gnu-gcc`） |
| **GNU Make** | 构建编排 |
| **bindgen** (Rust) + **libclang** | 生成 ext4 的 Rust FFI 绑定 |
| **objcopy** | 将 ELF 内核转换为原始二进制 Image |
| **ar** | 打包 `libkernelx_clib.a` 静态库 |
| **cmake** | clib 中 C 代码的构建系统 |
| **kconfig-frontends**（`kconfig-conf`, `kconfig-mconf`） | 内核配置系统（menuconfig/defconfig 等） |

### 5.2 可选/条件工具

| 工具 | 条件 | 用途 |
|---|---|---|
| **QEMU**（riscv64/loongarch64） | `make run` | 模拟运行 |
| **Python 3** | backtrace/调试支持 | 符号表生成(`gen_symbols.py`) |
| **dtc** (device tree compiler) | QEMU DTS | 设备树编译 |
| **mkfs.ext4 / mke2fs** | 磁盘镜像构建 | 制作 ext4 根文件系统镜像 |
| **mkfs.vfat / dosfstools** | FAT 磁盘镜像 | 制作 FAT 镜像 |
| **Docker** | 容器化构建 | 使用 `Dockerfile` 构建 |
| **GDB** | 调试 | 内核调试 |
| **llvm-objdump** | 反汇编 | 生成 `kernel.asm` |

### 5.3 关键 Rust 依赖

`Cargo.toml` 声明的主要外部依赖：

- `buddy_system_allocator`：伙伴系统内存分配器
- `spin`：自旋锁
- `virtio-drivers`：virtio 驱动库
- `device_tree_parser` / `fdt`：设备树解析
- `bitflags`, `bitvec`, `bitfield-struct`：位操作
- `visionfive2-sd`：StarFive 开发板 SD 卡驱动
- `bindgen`（构建依赖）：C 头文件绑定生成

## 6. 初步评估概要

- **代码规模**：内核主体约 64,700 行 Rust，外加约 3,000 行 C/汇编（clib）。335 个 Rust 源文件。
- **架构支持**：RISC-V 64-bit（主线）和 LoongArch 64-bit，通过统一的 `arch` trait 抽象。
- **子系统完整度**：实现了类 UNIX 内核的核心子系统：内存管理（含 swap）、进程/线程管理、VFS（含 9 种文件系统）、完整的网络协议栈（TCP/IP）、多类 IPC、epoll/eventfd/timerfd、信号、futex、KVM 虚拟化。
- **配置系统**：基于 Kconfig 的灵活配置，约 50 个配置项。
- **构建系统**：多层 Makefile + Cargo + CMake 混合构建，支持交叉编译。
- **测试体系**：具备 LTP 测试状态追踪、独立用户态测试构建系统（usertests）、QEMU CI 看门狗。