## 项目结构

```
StarryX/
├── Cargo.toml              # 工作区根配置，定义 workspace 成员和依赖
├── Cargo.lock
├── Makefile                # 顶层构建入口（make all / make rv / make la）
├── rust-toolchain.toml     # 指定 nightly-2025-01-18 工具链
├── README.md
├── .gitignore
├── src/                    # 内核入口（main.rs, entry.rs, syscall.rs, mm.rs）
├── xapi/                   # POSIX 系统调用 API 层（约 43 个文件）
├── xcore/                  # 内核核心逻辑层（约 56 个文件）
├── xmodules/               # 可复用内核模块（约 63 个文件，6 个子 crate）
├── arceos/                 # 基座 OS（ArceOS 框架，含 HAL、驱动、内存、网络等）
├── xtest/                  # 测试脚本与配置（busybox 配置、Redis 补丁等）
├── bin/                    # 自定义构建辅助二进制
├── vendor/                 # 第三方依赖（vendored crates）
└── docs/                   # 文档（初赛/决赛 PDF、PPT、学习日志）
```

## 初步调查结果

### 1. 项目定位

StarryX 是一个基于 **ArceOS/Starry-next** 的**宏内核**（Monolithic Kernel）实现，面向全国大学生操作系统内核赛。项目使用 **Rust** 编写，采用 `no_std` 裸机环境，支持多架构运行。

### 2. 支持的架构

根据 `rust-toolchain.toml` 和 `Makefile`，项目支持以下架构：
- **riscv64**（主要目标，含 QEMU virt 和 VisionFive2 板卡）
- **loongarch64**（含 QEMU virt 和 2K1000 硬件平台）
- **aarch64**（代码中有配置，但 Makefile 未直接暴露运行入口）
- **x86_64**（代码中有配置，但 Makefile 未直接暴露运行入口）

### 3. 子系统划分

| 子系统 | 主要目录 | 说明 |
|--------|----------|------|
| **系统调用入口** | `src/syscall.rs`, `xapi/` | `xapi` 实现约 200 项 POSIX 系统调用，按模块分为 fs/mm/task/net/ipc/iomux/sys |
| **进程管理** | `xapi/src/task/`, `xcore/src/task/`, `xmodules/xprocess/` | 进程/线程创建（clone）、执行（execve）、退出、等待、调度、futex、凭证管理 |
| **内存管理** | `xapi/src/mm/`, `xcore/src/mm/`, `xmodules/xvma/` | brk、mmap、页缓存、用户空间访问、写时复制（COW） |
| **文件系统** | `xapi/src/fs/`, `xcore/src/fs/` | VFS 层（proc/tmp/dev 伪文件系统）、EXT4/FAT 支持、文件描述符管理、mount、loop 设备 |
| **信号系统** | `xapi/src/task/signal.rs`, `xcore/src/task/signal.rs`, `xmodules/xsignal/` | 信号发送、处理、多架构信号上下文（含 aarch64/loongarch64/riscv/x86_64） |
| **IPC（进程间通信）** | `xapi/src/ipc/`, `xcore/src/ipc/` | System V 消息队列（msg）、信号量（sem）、共享内存（shm） |
| **网络** | `xapi/src/net/`, `xcore/src/net/` | TCP/UDP 套接字、端口复用、socket 选项 |
| **I/O 多路复用** | `xapi/src/iomux/` | epoll、poll、select |
| **内核核心** | `xcore/` | 内核对象定义（进程结构、文件结构、VFS 挂载、IPC 对象等） |
| **基座框架** | `arceos/` | ArceOS 组件化框架，提供 HAL（axhal）、驱动（axdriver）、内存分配（axalloc）、调度（axtask）、同步（axsync）、网络（axnet）等底层模块 |
| **通用工具** | `xmodules/xutils/`, `xmodules/xcache/`, `xmodules/xuspace/`, `xmodules/kernel_elf_parser/` | C 类型定义、时间处理、缓存、用户空间指针、ELF 解析与用户栈初始化 |

### 4. 代码规模

- `xapi`：约 43 个文件（系统调用 API 实现层）
- `xcore`：约 56 个文件（内核核心逻辑层）
- `xmodules`：约 63 个文件（6 个独立子 crate）
- `src`：5 个文件（入口与初始化）
- `arceos`：完整的基座框架（大量模块，非本项目原创）

### 5. 构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust nightly-2025-01-18** | 主编译器，含 rust-src、llvm-tools 组件 |
| **cargo** | Rust 包管理与构建 |
| **GNU Make** | 顶层构建编排（Makefile 调用 arceos 子 Makefile） |
| **RISC-V 交叉编译工具链** | 链接与构建 riscv64 目标 |
| **LoongArch 交叉编译工具链** | 链接与构建 loongarch64 目标 |
| **QEMU** | 运行与调试（riscv64/loongarch64） |
| **wget/xz** | 下载测试用 sdcard 镜像 |
| **dtc**（可能） | 设备树编译（ArceOS 框架内部使用） |
| **Docker**（可选） | 官方提供的容器化构建环境 |

构建流程为：`Makefile` → `arceos/Makefile`（defconfig + build）→ cargo 编译整个 workspace → 生成裸机二进制（`.bin` 或 `.elf`）。