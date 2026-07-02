# MoonOS 内核项目初步分析报告

## 一、项目概况

MoonOS 是基于 **ArceOS** 组件化底座构建的类 Unix 宏内核操作系统，目标架构为 **RISC-V 64** 和 **LoongArch 64**，同时保留了 x86_64 和 AArch64 的代码路径。项目使用 **Rust** 语言编写，采用 Cargo workspace 组织，编译工具链为 `nightly-2025-05-20`。

## 二、目录结构总览

```
repo/
├── src/                          # 内核入口（main.rs, entry.rs, test.rs）
├── api/                          # 系统调用 API 层（~200 个 Linux 兼容系统调用）
│   └── src/
│       ├── syscall/              # 系统调用分发与实现
│       │   ├── mod.rs            # 大 match 分发（631行）
│       │   ├── fs/               # 文件系统相关系统调用
│       │   ├── mm/               # 内存管理相关系统调用
│       │   ├── task/             # 进程/线程相关系统调用
│       │   ├── net/              # 网络相关系统调用
│       │   ├── sync/             # 同步原语（futex等）
│       │   ├── io_mpx/           # I/O多路复用（epoll/poll/select）
│       │   ├── ipc/              # 进程间通信（共享内存）
│       │   ├── signal.rs         # 信号处理
│       │   ├── time.rs           # 时间相关
│       │   └── ...
│       ├── file/                 # 文件抽象层（epoll, pipe, event, net等）
│       ├── mm.rs                 # 内存管理 API
│       ├── task.rs               # 任务管理 API
│       ├── signal.rs             # 信号 API
│       ├── socket.rs             # Socket API
│       ├── time.rs               # 时间 API
│       ├── vfs/                  # VFS 层（procfs, tmpfs, devfs）
│       └── terminal/             # 终端行规程（termios, job control）
│
├── core/                         # 宏内核核心业务逻辑层
│   └── src/
│       ├── task.rs               # 进程/线程控制块（Task/TCB）核心定义
│       ├── task/stat.rs          # 任务统计
│       ├── mm.rs                 # 内存管理核心（地址空间、页表、ELF加载）
│       ├── futex.rs              # futex 等待队列
│       ├── shm.rs                # System V 共享内存
│       ├── time.rs               # 定时器管理
│       ├── vfs/                  # VFS 核心抽象
│       │   ├── file.rs           # FileLike trait
│       │   ├── dir.rs            # 目录操作
│       │   ├── dev.rs            # 设备节点
│       │   ├── fs.rs             # 文件系统挂载
│       │   └── mod.rs
│       ├── resources.rs          # 资源限制（rlimit）
│       └── config/               # 架构相关配置
│           ├── riscv64.rs
│           ├── loongarch64.rs
│           ├── aarch64.rs
│           └── x86_64.rs
│
├── arceos/                       # ArceOS 微内核组件库（上游）
│   ├── modules/                  # 内核模块
│   │   ├── axhal/                # 硬件抽象层（HAL）
│   │   ├── axmm/                 # 虚拟内存管理
│   │   ├── axtask/               # 任务调度器
│   │   ├── axalloc/              # 物理内存分配器（TLSF + Bitmap）
│   │   ├── axfs/                 # 文件系统（ext4, FAT32）
│   │   ├── axnet/                # 网络协议栈（TCP/UDP/Unix Socket）
│   │   ├── axdriver/             # 设备驱动框架
│   │   ├── axruntime/            # 运行时初始化
│   │   ├── axconfig/             # 配置系统
│   │   ├── axsync/               # 同步原语
│   │   ├── axlog/                # 日志系统
│   │   ├── axdisplay/            # 显示驱动
│   │   ├── axinput/              # 输入设备驱动
│   │   ├── axdma/                # DMA 支持
│   │   └── axipi/                # 核间中断
│   ├── api/                      # ArceOS API 层
│   │   ├── axfeat/               # 特性门控
│   │   ├── arceos_api/           # ArceOS 原生 API
│   │   └── arceos_posix_api/     # POSIX API 封装
│   ├── ulib/                     # 用户库
│   ├── configs/                  # 平台配置文件
│   ├── scripts/                  # 构建脚本
│   └── examples/                 # 示例应用
│
├── vendor/                       # 第三方依赖（离线缓存，~180+ crate）
│   ├── axplat-*/                 # 平台抽象层（分架构实现）
│   ├── axdriver_*/               # 各类设备驱动 crate
│   ├── virtio-drivers/           # VirtIO 驱动
│   ├── smoltcp/                  # TCP/IP 协议栈
│   ├── riscv/                    # RISC-V 架构支持
│   ├── page_table_multiarch/     # 多架构页表
│   ├── starry-process/           # 进程管理子crate
│   ├── starry-signal/            # 信号子crate
│   ├── starry-vm/                # 虚拟内存子crate
│   └── ...                       # 大量依赖 crate
│
├── scripts/                      # 测试与评测脚本
│   ├── moon_master_test-rv.sh    # RISC-V 主测试脚本
│   ├── moon_master_test-la.sh    # LoongArch 主测试脚本
│   ├── cases.txt                 # 测试用例列表
│   └── parse_ltp.py              # LTP 结果解析
│
├── tools/                        # 构建辅助工具
│   ├── axconfig-gen/             # 配置代码生成工具
│   └── cargo_config/             # Cargo 离线配置
│
├── docs/                         # 项目文档
├── Makefile                      # 顶层构建入口
├── Cargo.toml                    # Workspace 定义
├── MoonOS技术文档.pdf/txt        # 技术文档（中文）
└── README.md                     # 项目 README
```

## 三、子系统划分

### 1. 系统调用层 (`api/`)

约 12,655 行 Rust 代码。所有 Linux 兼容系统调用（约 200+ 个）的入口和参数转换。采用大 `match` 枚举分发模式，按功能分为：

| 子目录 | 功能域 | 关键系统调用 |
|--------|--------|-------------|
| `syscall/fs/` | 文件系统 | open, read, write, close, stat, fcntl, ioctl, mount... |
| `syscall/mm/` | 内存管理 | mmap, munmap, brk, mprotect, madvise... |
| `syscall/task/` | 进程管理 | fork, clone, execve, exit, wait4, kill... |
| `syscall/net/` | 网络 | socket, bind, connect, sendmsg, recvmsg... |
| `syscall/sync/` | 同步 | futex, membarrier |
| `syscall/io_mpx/` | I/O 多路复用 | epoll_create, epoll_ctl, epoll_wait, poll, select |
| `syscall/ipc/` | 进程间通信 | shmget, shmat, shmdt, shmctl |
| `syscall/signal.rs` | 信号 | sigaction, sigprocmask, sigreturn... |
| `syscall/time.rs` | 时间 | clock_gettime, nanosleep, timerfd... |

### 2. 核心逻辑层 (`core/`)

约 3,002 行 Rust 代码。包含宏内核最核心的数据结构和业务逻辑：

- **进程管理**：`Task`（TCB）定义，包含地址空间、文件描述符表、信号上下文、futex 等待队列等完整进程状态。
- **内存虚拟化**：地址空间 (`AddressSpace`) 管理、ELF 加载器、页表操作、写时复制 (COW)。
- **futex 同步**：futex 等待队列与唤醒机制。
- **共享内存**：System V shm 实现。
- **VFS 核心**：`FileLike` trait、文件描述符表、目录项缓存。
- **资源限制**：rlimit 管理。
- **定时器**：itimerval 等定时器管理。

### 3. ArceOS 组件库 (`arceos/modules/`)

来自上游 ArceOS 项目的基础设施层，按模块组织：

| 模块 | 职责 |
|------|------|
| **axhal** | 硬件抽象层：中断、内存、分页、TLS、per-CPU、时间 |
| **axmm** | 虚拟内存：地址空间抽象、后端物理页分配 |
| **axtask** | 任务调度：任务控制块、就绪队列、等待队列、定时器 |
| **axalloc** | 物理内存分配：TLSF 字节分配器 + Bitmap 页分配器，支持页追踪 |
| **axfs** | 文件系统：ext4 和 FAT32 两种磁盘文件系统实现 |
| **axnet** | 网络协议栈：TCP、UDP、Unix Domain Socket、Vsock，基于 smoltcp |
| **axdriver** | 设备驱动：VirtIO (blk/net/gpu/input)、AHCI、RAM disk、ixgbe 网卡 |
| **axruntime** | 运行时：BSP 初始化、MP 启动、语言项 |
| **axsync** | 同步原语 |
| **axconfig** | 编译期配置生成 |
| **axlog** | 内核日志 |
| **axdisplay/axinput** | 显示与输入外设 |

### 4. 平台抽象层 (`vendor/axplat-*/`)

每个架构有独立的平台 crate，封装架构特定的底层操作：

- `axplat-riscv64-qemu-virt`：RISC-V QEMU virt 平台（boot, console, irq, mem, time, power）
- `axplat-loongarch64-qemu-virt`：LoongArch QEMU virt 平台（含 SMP 支持）
- `axplat-aarch64-qemu-virt`：AArch64 QEMU virt 平台
- `axplat-x86-pc`：x86 PC 平台
- `axplat`：平台无关的公共 trait 定义

### 5. 设备驱动层 (`vendor/axdriver_*/`)

分层驱动的 vendor crate：

- `axdriver_virtio`：VirtIO 块设备、GPU、输入、网络、Vsock 驱动封装
- `axdriver_block`：AHCI、RAM disk、SDMMC 等块设备驱动
- `axdriver_net`：ixgbe、fxmac 网卡驱动
- `axdriver_display` / `axdriver_input`：显示和输入设备驱动

### 6. 其他子系统

- **VFS 扩展** (`api/src/vfs/`)：procfs、tmpfs、devfs 等内存文件系统
- **终端子系统** (`api/src/terminal/`)：termios 终端属性、行规程、作业控制
- **管道** (`api/src/file/pipe.rs`)：匿名管道实现
- **epoll** (`api/src/file/epoll.rs`)：epoll 事件通知机制
- **signalfd/pidfd** (`api/src/file/`)：signalfd 和 pidfd 文件描述符

## 四、构建系统

### 构建工具链

- **Rust 工具链**：`nightly-2025-05-20`，含 `rust-src`、`llvm-tools`、`rustfmt`、`clippy`
- **目标三元组**：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none-softfloat`、`x86_64-unknown-none`、`aarch64-unknown-none-softfloat`
- **构建系统**：`cargo` + 顶层 `Makefile`
- **辅助工具**：`axconfig-gen`（配置代码生成器）

### 构建流程

1. `Makefile` 是顶层构建入口，支持 `make all`、`make build_riscv`、`make build_loongarch`。
2. 构建前通过 `env_bootstrap` 确保环境就绪（配置 cargo 离线模式、生成配置、清理残留进程）。
3. 通过环境变量控制构建参数：`ARCH`、`SMP`、`MEM`、`BLK`、`NET`、`LOG` 等。
4. 项目采用**离线编译**模式（`CARGO_NET_OFFLINE=true`），所有依赖预缓存在 `vendor/` 目录中。
5. 产物为两个架构的 ELF 内核镜像（`kernel-rv`、`kernel-la`），以及辅助磁盘镜像（`disk.img`、`disk-la.img`）。

### 运行时环境

- **模拟器**：QEMU（RISC-V 和 LoongArch 两个变体）
- **固件**：OpenSBI / RustSBI（RISC-V）
- **文件系统镜像**：ext4 格式

## 五、初步判断

1. **架构层次清晰**：严格遵循"ArceOS 组件底座 → core 核心逻辑 → api 系统调用层"三层架构，每层职责明确。

2. **子系统完整度高**：覆盖了 POSIX/Linux 兼容宏内核的几乎所有核心子系统——进程管理、内存虚拟化、文件系统、网络协议栈、信号、IPC、epoll、futex、终端控制。

3. **跨架构设计**：通过 axplat 平台抽象层实现 RISC-V/LoongArch/x86/AArch64 四架构支持，当前重点适配 RISC-V 和 LoongArch。

4. **代码量分布均匀**：api 层约 12.6K 行（系统调用入口），core 层约 3K 行（核心数据结构与业务逻辑），arceos 模块库体量更大（源自上游项目）。

5. **测试体系**：scripts 目录下有完整的自动化测试脚本，支持 LTP 测试套件和自定义测试用例。