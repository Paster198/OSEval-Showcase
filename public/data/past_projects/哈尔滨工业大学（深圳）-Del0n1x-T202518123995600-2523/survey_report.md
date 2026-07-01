# Del0n1x OS 内核项目初步分析报告

## 项目概述

Del0n1x 是一个使用 Rust 语言编写的跨架构操作系统内核，同时适配 **RISC-V 64** 和 **LoongArch 64** 两种指令集架构。项目目标是实现一个 Linux 兼容的多核操作系统，支持进程调度、文件系统、网络等功能。项目参加了 OS 内核比赛，决赛现场赛总分 145 分，排名第 8。

内核代码规模约 **36,791 行**（含 Rust 源文件与汇编文件），共 **217 个 Rust 源文件**。

---

## 仓库文件组织结构

```
.
├── os/                     # 内核主体代码
│   ├── src/                # 内核源码
│   ├── linker/             # 链接脚本（按平台和架构区分）
│   ├── scripts/            # 内核构建辅助脚本
│   ├── Cargo.toml          # Rust 包配置
│   └── Makefile            # 内核构建入口
├── user/                   # 用户态程序
│   ├── src/bin/            # 用户态可执行文件（initproc, shell等）
│   ├── Cargo.toml
│   └── Makefile
├── bootloader/             # 引导固件（RustSBI QEMU 二进制）
├── vendor.tar.gz           # 第三方依赖包（未解压）
├── doc/                    # 设计文档（Typst 格式）
├── report/                 # 过程文档与图片
├── scripts/                # 辅助脚本（LTP 测试结果解析等）
├── Makefile                # 顶层 Makefile（编排构建、Docker等）
├── rust-toolchain.toml     # Rust 工具链锁定（nightly-2025-01-18）
├── *.pdf                   # 初赛/决赛/现场赛文档
└── README.md
```

---

## 子系统划分

### 1. 硬件抽象层 (HAL) — `os/src/hal/`

为内核提供统一的硬件访问接口，内部按架构分为两个实现：

| 子目录 | 说明 |
|--------|------|
| `hal/rv64/` | RISC-V 64 实现：中断控制、SBI 调用、启动引导、页表、TLB、Trap 处理 |
| `hal/la64/` | LoongArch 64 实现：IOCSR、中断控制、启动引导、页表、TLB、Trap 处理、非对齐访问 |
| `hal/mod.rs`, `hal/utils.rs` | 公共接口与工具 |

每个架构实现内部进一步划分为 `arch/`（架构特性）、`entry/`（启动入口）、`mem/`（地址与页表）、`trap/`（陷入处理）、`config/`（平台配置）。

### 2. 内存管理 — `os/src/mm/`

| 文件 | 说明 |
|------|------|
| `heap_allocator.rs` | 堆内存分配器 |
| `frame_allocator.rs` | 物理页帧分配器 |
| `page_table.rs` | 页表管理 |
| `address.rs` | 地址类型定义（物理/虚拟地址、页号） |
| `page.rs` | 页抽象 |
| `memory_space/` | 虚拟内存空间管理，含 VMA（虚拟内存区域） |
| `user_ptr.rs` | 用户态指针安全访问 |

支持 CoW（写时复制）和懒分配等优化。

### 3. 进程/任务管理 — `os/src/task/`

| 文件 | 说明 |
|------|------|
| `task.rs` | 任务控制块（TCB）定义 |
| `executor.rs` | 无栈协程调度器（全局 Executor） |
| `sched.rs` | 调度策略 |
| `processor.rs` | 每核处理器状态管理 |
| `manager.rs` | 进程/线程管理器 |
| `pid.rs` | PID 分配器 |
| `fd.rs` | 文件描述符表 |
| `futex.rs` | Futex 同步机制 |
| `context.rs` | 上下文切换 |
| `switch.S` / `switch.rs` | 上下文切换汇编与 Rust 封装 |
| `thread_group.rs` | 线程组管理 |
| `ipc.rs` | 进程间 IPC 相关 |
| `aux.rs` | ELF 辅助向量 |

### 4. 文件系统 — `os/src/fs/`

| 子目录/文件 | 说明 |
|-------------|------|
| `vfs/` | 虚拟文件系统层（dentry、inode、file、super_block） |
| `ext4/` | ext4 文件系统实现（基于 lwext4 C 库的 Rust 绑定） |
| `devfs/` | 设备文件系统（tty、null、zero、urandom、rtc、loop 设备等） |
| `procfs/` | proc 文件系统（meminfo、mounts、interrupts 等） |
| `socketfs/` | Socket 文件系统 |
| `dirent.rs` | 目录项缓存 |
| `page_cache.rs` | 页缓存 |
| `pipe.rs` | 管道（支持读者/写者同步） |
| `mount.rs` | 挂载管理 |
| `path.rs` | 路径解析 |
| `fanotify.rs` | 文件变更通知 |
| `stat.rs` | 文件状态 |
| `ffi.rs` / `ltp.rs` | FFI 接口与 LTP 测试支持 |

### 5. 网络模块 — `os/src/net/`

| 文件 | 说明 |
|------|------|
| `tcp.rs` | TCP 套接字 |
| `udp.rs` | UDP 套接字 |
| `unix.rs` | Unix 域套接字 |
| `socket.rs` | 套接字抽象层 |
| `dev.rs` | 网络设备驱动接口 |
| `manager.rs` | 网络管理器 |
| `net_async.rs` | 异步网络支持 |
| `addr.rs` | 地址定义 |
| `ffi.rs` | FFI 接口 |

底层使用 **smoltcp** 网络协议栈。

### 6. 信号系统 — `os/src/signal/`

| 文件 | 说明 |
|------|------|
| `do_signal.rs` | 信号处理核心逻辑 |
| `sig_pending.rs` | 待处理信号队列 |
| `sig_stack.rs` | 信号栈 |
| `sig_struct.rs` | 信号结构体 |
| `ffi.rs` | FFI 接口 |

支持用户自定义信号和 sigreturn 机制。

### 7. IPC 系统 — `os/src/ipc/`

| 文件 | 说明 |
|------|------|
| `shm.rs` | System V 共享内存 |
| `mod.rs` | IPC 模块入口 |

### 8. 同步与定时 — `os/src/sync/`

| 子目录/文件 | 说明 |
|-------------|------|
| `mutex/` | 多种锁实现（spin、sleep、NoIrq 等） |
| `time/` | 时间管理（TimeVal、TimeSpec、时间戳、itimerval 等） |
| `timer.rs` | 定时器（时间轮 + 最小堆混合结构） |
| `time_async.rs` | 异步定时等待 |
| `once/` | Once 初始化原语 |
| `interrupt.rs` | 中断控制封装 |
| `misc.rs` | 协程挂起/唤醒工具 |

### 9. 系统调用 — `os/src/syscall/`

| 文件 | 说明 |
|------|------|
| `fs.rs` | 文件系统相关系统调用 |
| `process.rs` | 进程管理系统调用 |
| `mm.rs` | 内存管理系统调用 |
| `net.rs` | 网络系统调用 |
| `sync.rs` | 同步系统调用 |
| `io.rs` / `io_async.rs` | I/O 系统调用（同步与异步） |
| `ffi.rs` | FFI 接口 |

### 10. 设备驱动 — `os/src/drivers/`

| 子目录 | 说明 |
|--------|------|
| `virtio_driver/` | VirtIO 块设备驱动（含 PCI 枚举） |
| `tty/` | TTY 子系统（termios、串口驱动 ns16550a） |
| `irqchip/rv64/` | RISC-V PLIC 中断控制器驱动 |
| `irqchip/la64/` | LoongArch 中断控制器驱动（EIOINTC、LIOINTC、PCH-PIC） |
| `vf2/` | 星光二板块 SD 卡驱动（DesignWare SDIO） |
| `2k1000la/` | 龙芯 2K1000 板级驱动（NS16550A 串口） |
| `device/` | 设备管理框架（设备号、设备核心、IRQ、UART） |
| `disk.rs` | 块设备抽象 |

### 11. 用户态程序 — `user/`

包含 initproc、autorun、busybox shell（glibc/musl 版本）、user_shell、TCP/UDP 测试程序等。编译为裸机 ELF 后写入文件系统镜像。

---

## 构建工具链需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| **Rust nightly** (nightly-2025-01-18) | 内核与用户程序编译 | 可用（rustup） |
| **cargo** | Rust 包管理与构建 | 可用 |
| **rust-src** | 编译 no_std 目标所需 | 可用 |
| **llvm-tools / cargo-binutils** | rust-objcopy、rust-objdump | 可用 |
| **riscv64gc-unknown-none-elf** target | RISC-V 内核编译目标 | 可用 |
| **loongarch64-unknown-none** target | LoongArch 内核编译目标 | 可用 |
| **QEMU** (riscv64, loongarch64) | 模拟运行 | 可用 |
| **RustSBI** 固件 | RISC-V QEMU 引导 | 可用（bootloader/ 目录） |
| **GNU Make** | 构建编排 | 可用 |
| **dtc** | 设备树编译 | 可用 |
| **GDB** (riscv64, loongarch64) | 调试 | 可用 |
| **ext4 镜像工具** (mkfs.ext4, dd) | 文件系统镜像制作 | 可用 |
| **lwext4 C 库**（预编译 .a） | ext4 文件系统 FFI | 已提供（liblwext4-*.a） |
| **vendor 依赖** | 第三方 Rust crate | 需从 vendor.tar.gz 解压 |

构建入口为 `os/Makefile`，通过 `make run ARCH=riscv64` 或 `make run ARCH=loongarch64` 启动。顶层 `Makefile` 提供 `make all` 一键构建双架构内核。