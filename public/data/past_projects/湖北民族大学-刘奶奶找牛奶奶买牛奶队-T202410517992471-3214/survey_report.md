## 项目初步调查报告

### 一、项目概述

本项目是一个基于 **rCore-Tutorial v3 (ch8 分支)** 的 RISC-V 操作系统内核，使用 **Rust** 语言编写。目标平台为 **RISC-V 64 位 (riscv64gc)**，运行于 QEMU virt 虚拟机上。项目在 rCore-Tutorial 基础上扩展了 FAT32 文件系统支持，并尝试适配 ext4 文件系统，同时实现了部分 POSIX 兼容系统调用。

---

### 二、仓库文件组织结构

```
.
├── bootloader/              # SBI 固件（RustSBI QEMU 二进制）
├── dependencies/            # 直接引用的第三方 Rust crate
│   ├── core2/               # no_std 兼容的 core2 库
│   ├── k210-hal/            # K210 硬件抽象层
│   ├── k210-pac/            # K210 外设访问层
│   ├── k210-soc/            # K210 SoC 驱动
│   ├── riscv/               # RISC-V 寄存器与内联汇编库
│   └── virtio-drivers/      # VirtIO 设备驱动
├── modified_dependencies/   # 修改过的第三方 crate
│   ├── rust-fatfs/          # 修改版 FAT 文件系统库
│   └── rust-fscommon/       # 修改版文件系统公共库
├── easy-fs/                 # 简易文件系统（rCore 原生）库
├── easy-fs-fuse/            # easy-fs 的 FUSE 用户态工具
├── fat32-fuse/              # FAT32 镜像生成工具（用户态 Rust 程序）
├── os/                      # 内核主体
│   ├── .cargo/config        # Cargo 构建配置（目标、链接器脚本、vendor 源）
│   ├── cargo/config         # 备用 cargo 配置（Makefile 中交换使用）
│   ├── vendor/              # 离线 vendor 依赖
│   ├── Cargo.toml           # 内核 crate 清单
│   └── src/                 # 内核源码
├── user/                    # 用户态程序库与测试用例
│   ├── Cargo.toml
│   └── src/
├── testsuits/               # 预编译的测评用例（按系统调用分类的目录）
├── Makefile                 # 顶层构建入口
├── README.md                # 技术文档
└── LICENSE                  # 许可证
```

---

### 三、子系统划分

根据源码目录结构与模块声明，内核 (`os/src/`) 包含以下子系统：

| 子系统 | 对应目录/文件 | 说明 |
|--------|--------------|------|
| **内存管理 (MM)** | `os/src/mm/` | SV39 三级页表、物理帧分配器、堆分配器、地址空间管理（`address.rs`, `frame_allocator.rs`, `heap_allocator.rs`, `memory_set.rs`, `page_table.rs`） |
| **进程/任务管理 (Task)** | `os/src/task/` | 进程控制块 (PCB)、任务控制块 (TCB)、调度器、内核栈分配、PID 管理、上下文切换（含汇编 `switch.S`）、信号机制 |
| **陷阱/异常处理 (Trap)** | `os/src/trap/` | 中断与异常入口（`trap.S`）、Trap 上下文管理、系统调用分发 |
| **系统调用 (Syscall)** | `os/src/syscall/` | 向用户态提供的系统调用接口，涵盖文件系统 (`fs.rs`)、进程管理 (`process.rs`)、线程 (`thread.rs`)、同步 (`sync.rs`)、系统信息 (`sys_info.rs`) |
| **文件系统 (FS)** | `os/src/fs/` | 文件描述符抽象、inode 接口、管道 (pipe)、标准 I/O (stdio) |
| **FAT32 文件系统** | `os/src/fatfs/` | FAT32 文件系统的内核侧实现（boot sector、目录项、文件读写、FAT 表、LFN 长文件名支持） |
| **ext4 文件系统接口** | `os/src/ext4fs_interface/` | ext4 文件系统适配层（基于 lwext4_rust），含磁盘抽象、VFS 操作、VirtIO 实现、设备树读取 |
| **设备驱动 (Drivers)** | `os/src/drivers/` | 块设备抽象 (`block/`)、VirtIO 块设备驱动 (`virtio_blk.rs`) |
| **同步原语 (Sync)** | `os/src/sync/` | 互斥锁 (mutex)、信号量 (semaphore)、条件变量 (condvar)、UP 安全单元 (`up.rs`) |
| **定时器 (Timer)** | `os/src/timer.rs` | 基于 SBI 的定时器中断管理 |
| **SBI 接口** | `os/src/sbi.rs` | 与 SBI 固件交互的底层接口 |
| **控制台输出** | `os/src/console.rs` | 内核打印输出 |
| **启动入口** | `os/src/entry.asm`, `os/src/main.rs` | 汇编入口、内核初始化流程 |
| **链接脚本** | `os/src/linker-qemu.ld` | 内核二进制链接布局 |

**用户态 (`user/src/`)** 包含：
- 系统调用封装库 (`syscall.rs`)：通过 `ecall` 指令调用内核
- 约 50 个测试程序 (`bin/`)：涵盖进程管理 (fork/exec/exit/wait)、同步 (mutex/semaphore/condvar)、文件系统 (read/write/pipe)、线程等

---

### 四、已实现的系统调用

根据 `os/src/syscall/mod.rs` 中的分发逻辑，内核已实现以下系统调用（共约 30 个）：

| 类别 | 系统调用 |
|------|---------|
| 文件 I/O | `dup`, `dup3`, `open`, `close`, `read`, `write`, `pipe`, `fstat`, `chdir`, `getcwd`, `mkdirat` |
| 进程管理 | `clone` (替代 fork), `exec`, `waitpid` (wait4), `exit`, `getpid`, `getppid`, `yield`, `kill` |
| 线程 | `thread_create`, `gettid`, `waittid` |
| 内存 | `brk`, `mmap` (已注释) |
| 同步 | `mutex_create/lock/unlock`, `semaphore_create/up/down`, `condvar_create/signal/wait` |
| 系统信息 | `gettimeofday`, `times`, `uname` |
| 其他 | `sleep` |

注意：`mmap` 在分发函数中已被注释掉，`fork` 已被 `clone` 替代。

---

### 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|---------------|
| **Rust 工具链** (rustc, cargo) | 编译内核与用户态 Rust 代码 | 可用 |
| **riscv64gc-unknown-none-elf 目标** | 裸机 RISC-V 64 位编译目标 | 需确认是否已安装 |
| **QEMU (riscv64)** | 运行与调试内核 | 可用 |
| **RustSBI 固件** | SBI 引导 | 可用（`bootloader/rustsbi-qemu.bin`） |
| **GNU Make** | 顶层构建编排 | 可用 |
| **dd / mkfs 等** | 文件系统镜像制作 | 可用 |
| **GCC (RISC-V 交叉编译)** | 可能用于编译用户态 C 测试程序 | 可用 |

构建流程（根据 Makefile）：
1. 使用 `cargo build` 编译内核（目标 `riscv64gc-unknown-none-elf`，release 模式）
2. 将编译产物复制为 `kernel-qemu`
3. 复制 RustSBI 固件为 `sbi-qemu`
4. 使用 FAT32 镜像 (`fat.img`) 作为虚拟磁盘
5. 通过 `qemu-system-riscv64` 启动，配置 virtio-blk 块设备和 virtio-net 网络设备

内核依赖通过 **vendor 目录** 离线管理（`.cargo/config` 中配置了 `vendored-sources`），不依赖网络下载。