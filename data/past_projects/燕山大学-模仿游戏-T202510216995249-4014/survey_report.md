# freeOS (starry-next) 项目初步调查报告

## 项目概述

freeOS 是一款采用 Unikernel 设计风格的宏内核操作系统，基于 ArceOS 组件生态构建。项目使用 Rust 语言编写，支持 RISC-V 64、LoongArch64、AArch64 和 x86_64 四种架构。项目仓库名为 starry-next，来源于 oscomp（全国大学生操作系统比赛）。

## 仓库文件组织结构

```
starry-next/
├── src/                    # 内核主程序入口（顶层 crate: starry）
│   ├── main.rs             # 系统主函数，初始化文件系统和 init 进程，遍历执行测试用例
│   ├── entry.rs            # 用户程序加载和执行入口
│   ├── mm.rs               # 顶层内存管理相关
│   └── syscall.rs          # 系统调用分发器（约 99 个系统调用入口）
├── core/                   # starry-core crate：内核核心功能
│   └── src/
│       ├── lib.rs
│       ├── file/           # 文件系统核心实现（含 procfs）
│       │   ├── mod.rs
│       │   └── proc/       # /proc 虚拟文件系统
│       ├── futex.rs        # Futex 互斥锁实现
│       ├── mm.rs           # 内存管理核心实现
│       ├── shm.rs          # 共享内存管理实现
│       ├── task.rs         # 任务/进程管理核心实现
│       └── time.rs         # 时间统计功能
├── api/                    # starry-api crate：系统调用接口层
│   └── src/
│       ├── lib.rs
│       ├── file/           # 文件对象抽象（fs、net、pipe、stdio）
│       ├── imp/            # 系统调用具体实现
│       │   ├── fs/         # 文件系统相关 syscall（ctl、fd_ops、io、mount、stat、pipe、io_mpx）
│       │   │   └── io_mpx/ # I/O 多路复用（epoll、poll、select）
│       │   ├── mm/         # 内存相关 syscall（brk、mmap、shm）
│       │   ├── task/       # 任务相关 syscall（clone、execve、exit、schedule、thread、wait）
│       │   ├── futex.rs    # futex syscall
│       │   ├── signal.rs   # 信号 syscall
│       │   ├── resources.rs# 资源限制 syscall
│       │   ├── sys.rs      # 系统信息 syscall
│       │   ├── time.rs     # 时间 syscall
│       │   └── temp.rs     # 临时/占位实现
│       ├── path.rs         # 路径处理工具
│       ├── ptr.rs          # 用户空间指针安全访问
│       ├── signal.rs       # 信号处理 API
│       ├── socket.rs       # 网络套接字 API
│       └── time.rs         # 时间相关 API
├── arceos/                 # ArceOS 基座框架（本地副本）
│   ├── modules/            # ArceOS 内核模块
│   │   ├── axalloc         # 内存分配器
│   │   ├── axconfig        # 配置管理
│   │   ├── axdriver        # 设备驱动
│   │   ├── axfs            # 文件系统
│   │   ├── axhal           # 硬件抽象层
│   │   ├── axmm            # 内存管理
│   │   ├── axnet           # 网络
│   │   ├── axruntime       # 运行时
│   │   ├── axsync          # 同步原语
│   │   └── axtask          # 任务调度
│   ├── api/                # ArceOS 用户态 API
│   ├── ulib/               # 用户态库
│   └── ...
├── apps/                   # 测试应用程序
│   ├── junior/             # 初级测试用例
│   ├── nimbos/             # NimboOS 测试用例（含 C 和 Rust 程序）
│   ├── libc/               # libc 测试用例
│   └── oscomp/             # 操作系统比赛评测脚本和用例
├── configs/                # 各架构配置文件（aarch64/riscv64/loongarch64/x86_64.toml）
├── scripts/                # 构建脚本、测试脚本、依赖获取脚本
│   └── make/oscomp.mk      # 比赛专用构建规则
├── vendor/                 # Rust 依赖的本地 vendor 副本
├── docs/                   # 文档和图片
├── Cargo.toml              # Rust workspace 配置
├── Cargo.lock              # 依赖锁定文件
├── Makefile                # 顶层 Makefile
├── build.rs                # Rust 构建脚本（将用户程序二进制嵌入内核镜像）
├── build_img.sh            # 文件系统镜像构建脚本
├── rv.sh / la.sh           # RISC-V / LoongArch 快捷运行脚本
├── kernel-rv               # 预编译的 RISC-V 内核二进制
└── kernel-la               # 预编译的 LoongArch 内核二进制
```

## 子系统划分

根据代码目录结构和文件内容，该项目实现了以下子系统：

| 子系统 | 主要代码位置 | 说明 |
|--------|-------------|------|
| **系统调用分发** | `src/syscall.rs` | 统一入口，约 99 个 Linux 兼容系统调用 |
| **进程/线程管理** | `core/src/task.rs`, `api/src/imp/task/` | clone、execve、exit、wait、调度、线程管理 |
| **内存管理** | `core/src/mm.rs`, `core/src/shm.rs`, `api/src/imp/mm/`, `src/mm.rs` | mmap、brk、共享内存（SHM） |
| **文件系统** | `core/src/file/`, `api/src/file/`, `api/src/imp/fs/` | VFS 层、文件读写、目录操作、挂载、stat、pipe |
| **I/O 多路复用** | `api/src/imp/fs/io_mpx/` | epoll、poll、select |
| **网络/套接字** | `api/src/socket.rs`, `api/src/file/net.rs` | socket 操作 |
| **信号处理** | `api/src/signal.rs`, `api/src/imp/signal.rs` | Linux 信号机制 |
| **Futex** | `core/src/futex.rs`, `api/src/imp/futex.rs` | 快速用户态互斥锁 |
| **时间管理** | `core/src/time.rs`, `api/src/time.rs`, `api/src/imp/time.rs` | 时间统计与系统调用 |
| **资源限制** | `api/src/imp/resources.rs` | rlimit 等 |
| **ProcFS** | `core/src/file/proc/` | /proc 虚拟文件系统 |
| **用户程序加载** | `src/entry.rs`, `build.rs` | ELF 加载、用户程序嵌入 |

## 构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust 工具链**（nightly-2025-05-20） | 编译内核主体代码 |
| **GNU Make** | 顶层构建编排 |
| **musl 交叉编译工具链**（riscv64/aarch64/x86_64/loongarch64） | 编译用户态测试程序 |
| **QEMU**（system + linux-user） | 模拟运行内核 |
| **Python 3** | 评测脚本 |
| **dosfstools / mkfs 工具** | 制作文件系统镜像 |
| **dtc**（设备树编译器） | 设备树处理（ArceOS 内部使用） |
| **libclang** | Rust bindgen 依赖 |

构建流程概要：先通过 `scripts/get_deps.sh` 拉取 ArceOS 基座，再通过 `make user_apps` 编译用户程序并制作磁盘镜像，最后通过 `make build` 或 `make oscomp_build` 使用 Cargo 编译内核 ELF/二进制。`build.rs` 负责将用户程序二进制以 `.incbin` 方式嵌入内核数据段。