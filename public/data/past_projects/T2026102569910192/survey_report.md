# SWTC 项目结构与初步调查

## 项目概述

SWTC 是一个面向 2026 年全国大学生操作系统大赛初赛评测的双架构内核项目，队伍名称为 `sudo_win_the_cscc`，来自上海电力大学。项目在同一个仓库中产出两个目标架构的内核 ELF：`kernel-rv`（RISC-V64）和 `kernel-la`（LoongArch64）。主语言为 Rust，辅以少量汇编、Makefile 和 Shell。

---

## 1. 顶层文件组织结构

```
repo/
├── GNUmakefile / Makefile     # 根构建入口，`make all` 生成 kernel-rv 和 kernel-la
├── README.md                  # 项目说明文档
├── SWTC-初赛文档.pdf / .txt    # 初赛文档
├── docs/                      # 文档与图片素材
│   ├── assets/                # 架构图、评测截图
│   ├── preliminary-report.md  # 初赛报告
│   └── progress.md            # 开发进度
├── tools/                     # 辅助脚本（PDF 生成等）
├── SWTC/                      # ★ RISC-V64 主线
│   ├── Makefile               #   顶层占位 Makefile（all:）
│   ├── rust-toolchain.toml    #   nightly-2025-02-01, riscv64gc-unknown-none-elf
│   ├── kernel/                #   RISC-V 内核本体
│   ├── user/                  #   用户态程序（initproc, shell, runtestcase）
│   ├── dependencies/          #   本地依赖（riscv crate, heapless）
│   └── vendor/                #   Rust crate 离线 vendor
└── SWTC-la/                   # ★ LoongArch64 主线
    ├── Makefile               #   构建入口，支持 ARCH=loongarch64 / riscv64
    ├── Cargo.toml             #   workspace 根配置
    ├── rust-toolchain.toml    #   nightly-2025-05-20, loongarch64-unknown-none
    ├── src/                   #   内核入口、syscall 分发、MM 初始化
    ├── xapi/                  #   Linux syscall API 层
    ├── xcore/                 #   核心内核服务层
    ├── xmodules/              #   内核模块
    │   ├── xcache/            #     页缓存
    │   ├── xprocess/          #     进程/线程/组/会话管理
    │   ├── xsignal/           #     信号处理（多架构）
    │   ├── xuspace/           #     用户空间内存管理
    │   ├── xutils/            #     工具集（C 类型定义、时间等）
    │   ├── xvdso/             #     vDSO
    │   └── xvma/              #     虚拟内存区管理
    ├── arceos/                #   ArceOS 组件化内核框架
    │   ├── modules/           #     模块：axhal, axmm, axtask, axfs-ng, axnet 等共 15 个
    │   └── crates/            #     基础 crate：allocator, axerrno, axio, axsched 等
    ├── dependencies/xapi/     #   xapi 的依赖副本
    ├── scripts/make/          #   构建辅助脚本
    ├── cargo-config/          #   Cargo 离线配置
    └── vendor/                #   离线 vendor
```

---

## 2. 子系统划分

### 2.1 SWTC (RISC-V64) 内核子系统

| 子系统 | 目录/文件 | 代码量（行） | 说明 |
|--------|-----------|------|------|
| **入口与板级支持** | `entry.S`, `main.rs`, `boards/`, `config/`, `panic/` | ~500 | 启动入口、QEMU/U740 板级配置、panic 处理 |
| **内存管理** | `mm/` | ~4070 | 页表、帧分配器（伙伴系统）、堆分配器、回收分配器、内存空间（VMA）、COW、共享内存、用户指针校验 |
| **文件系统** | `fs/` | ~6195 | VFS 框架、FAT32 实现、devfs、procfs、tmpfs、页缓存、管道、文件描述符表、inode |
| **进程管理** | `process/` | ~1701 | 进程管理器、线程调度、TID 分配、资源管理、退出处理 |
| **处理器管理** | `processor/` | ~458 | Hart 管理、上下文切换、环境抽象 |
| **系统调用** | `syscall/` | ~4756 | 分 9 个子模块：fs、mm、process、net、signal、sync、time、dev、resource |
| **中断与陷入** | `trap/` | ~699 | 内核陷入、用户陷入、陷入上下文 |
| **信号** | `signal/` | ~552 | 信号上下文、信号处理器、信号队列 |
| **同步原语** | `sync/` | ~909 | 自旋锁、睡眠锁、可重入锁、futex、邮箱 |
| **网络** | `net/` | ~1603 | TCP、UDP、Unix 域套接字（基于 smoltcp） |
| **定时器与 IO 多路复用** | `timer/` | ~654 | 定时任务、超时任务、poll 队列、epoll 基础 |
| **设备驱动** | `driver/` | ~1170 | PLIC、UART（QEMU/FU740）、virtio-blk、SPI、SD 卡 |
| **工具集** | `utils/` | ~1500 | 错误类型、哈希表、基数树、路径解析、随机数、栈回溯、字符串工具 |
| **ELF 加载器** | `loader.rs` | ~150 | 用户程序 ELF 加载 |
| **异步执行器** | `executor/` | ~90 | 基于 async-task 的协程执行器 |

**用户态程序** (`SWTC/user/src/bin/`)：
- `initproc.rs` — 初始进程
- `shell.rs` — 简易 Shell
- `runtestcase.rs` — 测试用例运行器

### 2.2 SWTC-la (LoongArch64) 内核子系统

| 子系统 | 目录 | 代码量（行） | 说明 |
|--------|------|------|------|
| **内核入口** | `src/` | ~1144 | main、entry、syscall 分发、MM 初始化、init.sh/test.sh 嵌入 |
| **Linux ABI (xapi)** | `xapi/src/` | ~7124 | fs（io/mount/stat/fd_ops）、iomux（epoll/poll/select）、ipc（msg/sem/shm）、mm（brk/mmap）、net（socket/sockopt）、sys（time/resource）、task（clone/execve/exit/futex/signal/schedule/thread/wait） |
| **内核核心服务 (xcore)** | `xcore/src/` | ~8228 | fs（VFS：dev/proc/tmp/loop/tty/pipe/epoll/eventfd/fanotify/pidfd）、ipc、mm（init/page_cache/uspace）、net（socket/sockaddr）、sys（resources/time）、task（api/cred/futex/proc/signal/stat）、vdso（安装/数据/镜像） |
| **进程模块** | `xmodules/xprocess/` | ~891 | 进程、线程、进程组、会话 |
| **信号模块** | `xmodules/xsignal/` | ~1538 | 信号 action/pending/types，多架构支持（aarch64/loongarch64/riscv/x86_64） |
| **用户空间** | `xmodules/xuspace/` | ~426 | 用户空间指针与内存操作 |
| **虚拟内存区** | `xmodules/xvma/` | ~221 | VMA 管理 |
| **页缓存** | `xmodules/xcache/` | ~377 | 文件页缓存 |
| **工具集** | `xmodules/xutils/` | ~1044 | C 类型定义（fs/ipc/mm/net/sys/task）、BTreeMap、时间 |
| **vDSO** | `xmodules/xvdso/` | ~387 | loongarch64/riscv64 vDSO 支持 |
| **ArceOS 框架** | `arceos/modules/` | — | axalloc、axconfig、axdriver、axfeat、axfs-ng、axhal、axlog、axmm、axnet、axns、axruntime、axsync、axtask（共 15 个模块） |

---

## 3. 粗略架构关系

项目采用清晰的**分层 + 双主线**架构：

```
┌──────────────────────────────────────────────┐
│              根 Makefile (make all)            │
│         产出 kernel-rv + kernel-la             │
├────────────────────┬─────────────────────────┤
│   SWTC (RISC-V64)  │  SWTC-la (LoongArch64)   │
│                    │                          │
│  user/ (用户态)     │  xapi/ (Linux ABI 层)     │
│  ─────────────────│  ──────────────────────  │
│  kernel/           │  xcore/ (内核服务层)       │
│  ├─ syscall/       │  xmodules/ (模块层)        │
│  ├─ fs/            │  ├─ xprocess/xsignal/...  │
│  ├─ mm/            │  └─ xvma/xcache/xvdso/... │
│  ├─ process/       │  arceos/ (框架层)          │
│  ├─ net/           │  ├─ axhal/axmm/axtask/... │
│  ├─ sync/signal/   │  └─ crates/               │
│  └─ driver/trap/   │                          │
│  基于 Titanix 架构  │  基于 ArceOS/StarryX 架构  │
└────────────────────┴─────────────────────────┘
```

- **SWTC (RISC-V)** 采用传统单体内核结构，自研程度高，覆盖了从板级支持到文件系统、网络协议栈的完整链路。
- **SWTC-la (LoongArch)** 基于 ArceOS 组件化内核框架，通过 xapi/xcore/xmodules 三层实现了 Linux ABI 兼容，复用 ArceOS 的 HAL、内存管理、任务调度等基础能力。

---

## 4. 构建工具需求

### 4.1 RISC-V (SWTC) 构建

| 工具 | 用途 |
|------|------|
| Rust 工具链 `nightly-2025-02-01` | 内核与用户程序编译 |
| `riscv64gc-unknown-none-elf` target | RISC-V 裸机目标 |
| `cargo` | Rust 构建管理 |
| `rust-objcopy` | ELF → binary 转换 |
| `rust-lld` | 链接（生成 kernel-rv wrapper） |
| GNU Make | 构建编排 |
| `mkfs.vfat` | 文件系统镜像制作（本地测试用） |
| QEMU `qemu-system-riscv64` | 模拟运行 |

### 4.2 LoongArch (SWTC-la) 构建

| 工具 | 用途 |
|------|------|
| Rust 工具链 `nightly-2025-05-20` | 内核编译 |
| `loongarch64-unknown-none` target | LoongArch 裸机目标 |
| `cargo` | Rust 构建管理 |
| `rust-objcopy` | ELF → binary 转换 |
| `cmake` | lwext4_rust C 库构建 |
| `loongarch64-linux-musl-gcc` | 交叉编译 C 组件 |
| GNU Make | 构建编排 |
| QEMU (LoongArch) | 模拟运行 |

### 4.3 通用辅助工具

- Git（版本管理）
- Python（PDF 生成等）
- curl / xz（下载 rootfs 镜像）

根构建通过 `make all` 串行执行 RISC-V 和 LoongArch 两条构建管线，两套工具链通过 `RUSTUP_TOOLCHAIN` 环境变量隔离，vendor 目录均支持离线构建。