# RespOS 项目初步调查报告

## 一、项目概述

RespOS 是一个使用 Rust 编写的教学与竞赛型操作系统内核，面向全国大学生操作系统比赛。支持 **RISC-V 64** 和 **LoongArch 64** 双架构，目标是与 Linux ABI 兼容，能够运行比赛镜像中的 musl/glibc 用户态测试程序。

- **总 Rust 源文件数**：336 个
- **总 Rust 代码行数**：约 10 万行（含 vendor 目录下的第三方库）
- **内核核心代码 (os/src)**：约 36,000 行

---

## 二、仓库目录结构

```
repo/
├── Makefile                  # 顶层构建文件 (双架构构建入口)
├── README.md                 # 项目说明文档
├── LICENSE                   # 许可证
├── rustfmt.toml              # Rust 格式化配置
│
├── os/                       # 【内核主体】
│   ├── Cargo.toml            # 内核 crate 清单
│   ├── Makefile              # 内核独立构建脚本
│   ├── build.rs              # 构建脚本 (嵌入用户程序二进制)
│   ├── cargo/                # 架构相关的 cargo 配置模板
│   │   ├── config-riscv64.toml
│   │   └── config-loongarch64.toml
│   └── src/                  # 内核源代码
│       ├── main.rs           # 内核入口
│       ├── console.rs        # 内核控制台输出 (串口)
│       ├── lang_item.rs      # Rust 语言项
│       ├── loader.rs         # 用户程序加载器
│       ├── link_app.S        # (构建生成) 嵌入的用户程序
│       ├── arch/             # 架构适配层 (HAL)
│       ├── drivers/          # 设备驱动
│       ├── fs/               # 文件系统
│       ├── mm/               # 内存管理
│       ├── mutex/            # 锁机制
│       ├── net/              # 网络协议栈
│       ├── signal/           # 信号处理
│       ├── syscall/          # 系统调用
│       ├── task/             # 任务/进程管理
│       └── utils/            # 工具函数
│
├── user/                     # 【用户态运行时】
│   ├── Cargo.toml
│   ├── Makefile
│   ├── build.rs
│   ├── cargo/                # 架构相关 cargo 配置
│   └── src/
│       ├── lib.rs            # 用户库 (系统调用封装、堆分配器)
│       ├── console.rs        # 用户态输出
│       ├── syscall.rs        # 系统调用封装
│       └── bin/              # 13 个用户程序
│           ├── initproc.rs      # 初始进程 (testrunner 启动器)
│           ├── testrunner.rs    # 测例运行器 (核心)
│           ├── user_shell.rs    # 简单 Shell
│           ├── cat.rs, cp.rs, ls.rs, true.rs   # busybox 风格工具
│           ├── hello_world.rs, sleep.rs, power.rs
│           ├── pipetest.rs, sig_simple.rs
│           └── net_loopback_smoke.rs
│
├── bootloader/               # 【引导程序】
│   └── rustsbi-qemu.bin      # RustSBI QEMU 固件 (RISC-V)
│
├── vendor/                   # 【第三方库 (fork/本地化)】
│   ├── smoltcp/              # TCP/IP 协议栈
│   ├── lwext4_rust/          # ext4 文件系统 Rust 绑定
│   └── riscv/                # RISC-V 寄存器/CSR crate
│
├── scripts/                  # 【辅助脚本】
│   ├── get_img.sh            # 下载测试镜像
│   ├── check.sh              # 提交检查
│   └── gen_ltp_csv.sh        # LTP 日志生成
│
├── judge/                    # 【评测辅助】
│   ├── baseline/             # Linux 基线 LTP 日志
│   ├── ltp_report.py         # LTP 报告生成
│   ├── ltp_compare.py        # LTP 对比脚本
│   └── filter-ltp-log.py     # LTP 日志过滤
│
└── docs/                     # 【文档】
    ├── 初赛文档/              # 初赛提交用 PDF/PPT
    ├── dev-log.md            # 开发日志
    ├── mm模块基础说明.md
    ├── task模块核心功能说明.md
    ├── ltp-fs-abi-design.md
    ├── ltp-performance-optimization.md
    ├── signal-merge-review.md
    └── ...
```

---

## 三、子系统划分

### 1. 架构适配层 (HAL) —— `os/src/arch/`

| 子模块 | 路径 | 代码量 (行) | 职责 |
|--------|------|------------|------|
| RISC-V 64 架构 | `os/src/arch/rv64/` | ~1,200 | RISC-V 启动、中断、页表、上下文切换、定时器、SBI |
| LoongArch 64 架构 | `os/src/arch/loongarch64/` | ~1,600 | LoongArch 启动、TLB refill、CSR 寄存器、PCI、定时器 |

二者结构对称，各包含：`config`(板级配置)、`entry`(启动)、`trap`(陷入/异常)、`mm`(页表)、`task`(上下文切换)、`interrupt`(中断分发)、`timer`(时钟)、`sbi`(SBI调用)。

### 2. 任务管理 —— `os/src/task/`

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `task.rs` | 2,177 | 进程控制块 (TCB) 核心数据结构、资源管理 |
| `scheduler.rs` | 542 | 调度器：阻塞/唤醒/退出/抢占等调度原语 |
| `manager.rs` | 49 | 全局任务管理器 (PID 分配) |
| `processor.rs` | 92 | 当前任务获取/切换 |
| `context.rs` | 40 | 任务上下文 (callee-saved 寄存器) |
| `kstack.rs` | 138 | 内核栈管理 |
| `tid.rs` | 68 | 线程 ID 分配 |
| `aux.rs` | 45 | 辅助数据结构 |
| `futex/` | ~750 | futex 系统调用实现 (wait/queue) |

采用**无栈协程式调度**模型，全局统一 executor。

### 3. 内存管理 —— `os/src/mm/`

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `memory_set.rs` | 2,504 | 地址空间管理 (MemorySet), mmap, CoW, lazy allocation, 文件映射 |
| `address.rs` | 359 | 虚拟地址/物理地址/页号抽象 |
| `frame_allocator.rs` | 153 | 物理页帧分配器 (buddy system) |
| `heap_allocator.rs` | 24 | 内核堆分配器初始化 |
| `mod.rs` | 259 | copy_from_user/copy_to_user, 用户缓冲区校验 |

### 4. 文件系统 —— `os/src/fs/`

| 子模块 | 路径 | 代码量 | 职责 |
|--------|------|--------|------|
| VFS 层 | `vfs/` | ~260 | 虚拟文件系统抽象 (dentry, inode, super_block) |
| ext4 | `ext4/` | ~1,100 | ext4 文件系统实现 (基于 lwext4_rust) |
| procfs | `proc/` | ~2,200 | /proc 伪文件系统 (cpuinfo, meminfo, mounts, stat, maps, smaps 等) |
| devfs | `dev/` | ~800 | /dev 设备文件 (null, zero, random, shm, tty, rtc, loop 等) |
| 核心 | `namei.rs`, `file.rs`, `pipe.rs` 等 | ~3,500 | 路径解析、文件描述符表、管道、页缓存、dentry 缓存、挂载管理 |

### 5. 系统调用 —— `os/src/syscall/`

总计约 11,250 行。定义了约 90+ 个系统调用号（覆盖 Linux ABI 常用调用）：

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `fs.rs` | 3,665 | 文件 I/O 相关系统调用 (open/read/write/stat/getdents 等) |
| `process.rs` | 1,852 | 进程管理 (fork/exec/wait/exit/kill 等) |
| `net.rs` | 1,104 | 网络 (socket/bind/listen/connect 等) |
| `special_fd.rs` | 969 | eventfd, epoll, inotify 等特殊 fd |
| `time.rs` | 903 | 时间相关 (clock_gettime/nanosleep/timerfd 等) |
| `mod.rs` | 747 | 系统调用分发入口、所有系统调用号常量 |
| `signal.rs` | 585 | 信号 (sigaction/sigprocmask/sigreturn 等) |
| `ipc.rs` | 559 | 进程间通信 (pipe/shmget/shmat 等 SysV) |
| `mm.rs` | 440 | 内存 (mmap/munmap/mprotect/brk 等) |
| `system.rs` | 227 | 系统信息 (uname/sysinfo 等) |
| `errno.rs` | 196 | 错误码定义 (EINVAL/ENOENT 等) |

### 6. 信号处理 —— `os/src/signal/`

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `sig_struct.rs` | 322 | 信号帧、信号集数据结构 |
| `sig_info.rs` | 178 | siginfo_t 结构 |
| `sig_handler.rs` | 121 | sigaction 处理 |
| `sig_stack.rs` | 75 | 信号栈、ucontext |
| `mod.rs` | ~80 | 信号分发入口 (每次 trap 返回前检查未决信号) |

### 7. 网络协议栈 —— `os/src/net/`

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `socket.rs` | 781 | 套接字 FileOp 封装 |
| `tcp.rs` | 769 | TCP 流式套接字 |
| `udp.rs` | 373 | UDP 数据报套接字 |
| `loopback.rs` | ~50 | 回环设备 |
| `listen.rs` | ~80 | TCP 监听表 (SYN 队列) |
| `addr.rs` | ~80 | 地址转换 |
| `mod.rs` | ~150 | 全局 SocketSet、接口轮询、初始化 |

基于 smoltcp 实现，当前支持 IPv4 回环通信。

### 8. 设备驱动 —— `os/src/drivers/`

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `virtio/mod.rs` | 121 | VirtIO 传输层抽象 (MMIO/Pci) |
| `virtio/block_dev.rs` | 81 | VirtIO 块设备驱动 |
| `disk.rs` | ~30 | 磁盘抽象 traits |
| `device.rs` | ~20 | 设备元数据 |
| `mod.rs` | ~30 | 块设备类型导出 (架构适配) |

### 9. 同步原语 —— `os/src/mutex/`

| 文件 | 代码行 | 职责 |
|------|--------|------|
| `spin.rs` | 137 | 自旋锁 |
| `sleep.rs` | 198 | 睡眠锁 (阻塞式) |
| `ffi.rs` | ~10 | C ABI 互斥锁封装 |

### 10. 用户态运行时 —— `user/src/`

- `lib.rs` (~380 行): 用户库入口 `_start`、堆分配器、系统调用封装
- `syscall.rs` (~300 行): 约 70+ 个系统调用封装函数
- `bin/testrunner.rs` (~2,500+ 行): 核心测例运行器，负责按比赛镜像组织运行 basic、busybox、libc-bench、libctest、LTP、iozone、iperf、netperf、lmbench、cyclictest 等测例

---

## 四、编译构建工具需求

根据 Makefile 和 Cargo 配置分析，构建该项目需要：

| 类别 | 工具 | 用途 |
|------|------|------|
| **Rust 工具链** | `cargo` | 内核和用户程序编译 |
| | `rustc` (nightly) | 需要 `#![feature(...)]` 等多项 nightly 特性 |
| | `rustup target add riscv64gc-unknown-none-elf` | RISC-V 交叉编译目标 |
| | `rustup target add loongarch64-unknown-none` | LoongArch 交叉编译目标 |
| | `rust-objcopy`, `rust-objdump`, `rust-readobj` | ELF 处理 (strip, 分析) |
| | `rust-src`, `llvm-tools-preview` | Rust 标准库源码与 LLVM 工具 |
| **模拟器** | `qemu-system-riscv64` | RISC-V 模拟 |
| | `qemu-system-loongarch64` | LoongArch 模拟 |
| **固件** | RustSBI (`rustsbi-qemu.bin`) | RISC-V SBI 固件 (已内置在 bootloader/) |
| **调试** | `riscv64-unknown-elf-gdb` / `loongarch64-unknown-linux-gnu-gdb` | 内核调试 |
| | `tmux` | 调试会话管理 |
| **构建** | GNU Make | 顶层和子目录构建控制 |
| **其他** | bash, curl/wget, tar, xz | 镜像下载解压 |

该项目**不依赖 cargo**（因环境中缺失 cargo），但 Makefile 多处调用 `cargo build`。当前环境提供的 C_toolchain、RISC-V/LoongArch 交叉编译工具链、QEMU 等均可满足构建需求。

---

## 五、初步评估摘要

- **项目规模**：内核核心约 3.6 万行 Rust 代码，加上用户态和 vendor 库后总计约 10 万行，属于较大规模的教学竞赛内核。
- **子系统完整性**：涵盖 HAL、进程调度、内存管理 (含 mmap/CoW/lazy alloc)、VFS (含 ext4/procfs/devfs/tmpfs)、信号、管道、网络 (TCP/UDP/loopback)、futex、epoll、timerfd 等，覆盖较全面。
- **双架构支持**：RISC-V 64 和 LoongArch 64 双架构，通过配置文件和条件编译实现，架构差异收敛在 `arch/` 层。
- **Linux ABI 兼容**：实现约 90+ 个系统调用，可直接运行 musl/glibc 编译的用户程序。
- **构建方式**：依赖 Rust nightly 工具链 + cargo + QEMU，构建产物为 ELF 内核镜像 (`kernel-rv` / `kernel-la`)。