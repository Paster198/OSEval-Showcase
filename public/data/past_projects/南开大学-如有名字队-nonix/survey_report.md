# Nonix OS 内核项目初步调查报告

## 一、项目概述

Nonix 是一个面向 OSKernel2025 比赛的 Rust 操作系统内核项目，基于 rCore-Tutorial 和 TrustOS 演进而来。项目支持 **RISC-V 64** 和 **LoongArch 64** 双架构，使用 **ext4** 文件系统，通过 `polyhal` 硬件抽象层实现多架构适配。内核主体代码约 **10,979 行** Rust 代码（`os/src/` 目录）。

---

## 二、仓库文件组织结构

```
.
├── Cargo.toml              # Workspace 根配置，包含 os 和 user 两个成员
├── Makefile                # 顶层构建脚本，支持 riscv64/loongarch64 双架构
├── rust-toolchain.toml     # Rust 工具链配置 (nightly-2025-02-01)
├── README.md               # 项目说明文档
├── runall.sh               # 批量运行脚本
├── os/                     # 内核主体
│   ├── src/
│   │   ├── main.rs         # 内核入口
│   │   ├── config/         # 架构相关配置 (la.rs / rv.rs)
│   │   ├── console.rs      # 控制台输出
│   │   ├── drivers/        # 设备驱动 (VirtIO 块设备)
│   │   ├── fs/             # 文件系统 (ext4 + VFS)
│   │   ├── mm/             # 内存管理 (SV39, mmap, SHM)
│   │   ├── signal/         # POSIX 信号机制
│   │   ├── sync/           # 同步原语
│   │   ├── syscall/        # 系统调用 (70+ 个)
│   │   ├── task/           # 进程/线程管理
│   │   ├── timer.rs        # 定时器
│   │   ├── trap/           # 中断/异常处理
│   │   ├── utils/          # 工具模块 (错误类型, 字符串)
│   │   ├── lang_items.rs   # Rust 语言项
│   │   └── logging.rs      # 日志
│   ├── build.rs            # 构建脚本
│   ├── linker*.lds         # 链接脚本 (riscv64/loongarch64)
│   └── Cargo.toml
├── user/                   # 用户态程序和测试
│   ├── src/bin/            # 可执行文件 (initproc, test, user_shell, finaltest)
│   ├── test/               # 用户态测试用例 (fork, sleep, matrix 等)
│   └── Cargo.toml
├── lwext4_rust/            # ext4 文件系统 Rust 绑定
│   ├── c/lwext4/           # lwext4 C 源码
│   ├── src/                # Rust FFI 绑定
│   └── build.rs
├── bootloader/             # SBI 引导固件 (rustsbi-qemu.bin)
├── patch/                  # 本地补丁依赖
│   ├── polyhal/            # 多架构硬件抽象层
│   ├── virtio-drivers/     # VirtIO 驱动补丁
│   └── cty/                # C 类型绑定补丁
├── vendor/                 # 离线依赖包 (cargo vendor)
└── doc/                    # 设计文档 (PDF/PPTX)
```

---

## 三、子系统划分

| 子系统 | 对应目录/文件 | 代码行数(约) | 说明 |
|--------|-------------|-------------|------|
| **系统调用** | `os/src/syscall/` | ~2,833 | 实现约 70+ 个 Linux 兼容系统调用 |
| **文件系统** | `os/src/fs/` | ~2,474 | 基于 lwext4 的 ext4 适配，含 VFS、管道、stdio、挂载表 |
| **内存管理** | `os/src/mm/` | ~2,111 | 物理帧分配、堆、虚拟内存映射、mmap/munmap、共享内存、写时复制 |
| **进程/任务管理** | `os/src/task/` | ~1,241 | PCB、PID 分配、调度器、上下文切换、ELF 加载、clone/fork/exec |
| **设备驱动** | `os/src/drivers/` | ~683 | VirtIO 块设备驱动，基于 polyhal 传输层抽象 |
| **工具模块** | `os/src/utils/` | ~563 | 错误类型定义、字符串处理、多核管理 |
| **信号机制** | `os/src/signal/` | ~323 | POSIX 信号定义、信号动作表、信号标志位 |
| **定时器** | `os/src/timer.rs` | ~161 | 时钟中断与定时器管理 |
| **中断/异常** | `os/src/trap/` | ~149 | 基于 polyhal-trap 的陷入处理 |
| **同步原语** | `os/src/sync/` | ~34 | UPSafeCell 等内核同步工具 |
| **用户态** | `user/` | - | 用户态库、initproc、测试程序 |
| **ext4 绑定库** | `lwext4_rust/` | - | lwext4 C 库的 Rust FFI 封装 |
| **硬件抽象层** | `patch/polyhal/` | - | 多架构 HAL (RISC-V/LoongArch/AArch64/x86_64) |

---

## 四、系统调用覆盖范围

项目实现了约 **70+ 个系统调用**，按类别划分：

- **文件系统** (~30个): openat, close, read, write, lseek, mkdirat, unlinkat, linkat, renameat2, getdents64, readlinkat, fstat, fstatat, statfs, statx, mount, umount2, chdir, getcwd, pipe, splice, readv, writev, pread64, faccessat, ftruncate, fsync, copy_file_range, utimesat, ioctl, fcntl, dup, dup3, pselect6, ppoll
- **内存管理** (~7个): mmap, munmap, mprotect, brk, shmget, shmat, shmctl
- **进程管理** (~15个): clone, exec, exit, exit_group, wait4, getpid, getppid, gettid, setpgid, getpgid, yield, set_tid_address, set_robust_list, prlimit
- **信号** (~6个): sigaction, sigprocmask, sigkill, sigsuspend, sigtimedwait, sigreturn
- **其他** (~12个): uname, times, getrusage, gettimeofday, clock_gettime, clock_nanosleep, nanosleep, syslog, getrandom, getuid/euid, getgid/egid, shutdown

---

## 五、构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust nightly** (nightly-2025-02-01) | 内核编译，需 `rust-src`、`llvm-tools-preview` 组件 |
| **rust-objcopy / rust-objdump** | 生成二进制内核镜像、反汇编 (cargo-binutils) |
| **cargo** | Rust 包管理与构建 |
| **C 编译器** (GCC/Clang) | 编译 lwext4 C 库 (通过 lwext4_rust/build.rs) |
| **QEMU** (qemu-system-riscv64 / qemu-system-loongarch64) | 内核运行与调试 |
| **RustSBI** (bootloader/rustsbi-qemu.bin) | RISC-V 架构 SBI 引导固件 |
| **GDB** (可选) | 内核调试 |
| **Docker** (可选) | 官方容器化构建环境 |

目标编译架构：
- `riscv64gc-unknown-none-elf`
- `loongarch64-unknown-none`

---

## 六、关键依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| **polyhal** | 本地补丁 (patch/) | 多架构硬件抽象层，提供页表、中断、设备发现等底层接口 |
| **lwext4_rust** | 本地路径 | ext4 文件系统 Rust FFI 绑定 |
| **virtio-drivers** | 本地补丁 (patch/) | VirtIO 设备驱动 |
| **buddy_system_allocator** | vendor/ | 堆内存分配器 |
| **bitflags** | vendor/ | 位标志操作 |
| **xmas-elf** | vendor/ | ELF 文件解析 |
| **spin** | vendor/ | 自旋锁 |
| **lazy_static** | vendor/ | 延迟初始化 |
| **fdt** | vendor/ | Flattened Device Tree 解析 |
| **log** | vendor/ | 日志框架 |
| **cty** | 本地补丁 (patch/) | C 类型绑定 |