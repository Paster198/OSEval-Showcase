## StarryOS 内核项目初步调查报告

### 一、项目概览

该项目名为 **StarryOS**（仓库名 `starry-next`），是一个基于 **ArceOS** 框架构建的 Rust 宏内核（monolithic kernel）项目。项目定位为支持多架构（RISC-V、LoongArch、x86_64、AArch64）的通用操作系统内核，具备完整的用户态进程支持、系统调用接口、文件系统、网络协议栈以及自定义调度器等子系统。

项目采用 Cargo workspace 结构组织，分为两个主要 workspace：根 workspace（`starry`）和内嵌的 ArceOS workspace（`arceos/`）。

---

### 二、顶层目录结构

| 目录/文件 | 用途 |
|-----------|------|
| `Cargo.toml` | 根 workspace 配置，workspace 名为 `starry`，包含 `api`、`core` 两个成员 |
| `Makefile` | 顶层构建入口，封装 QEMU 参数、架构选择（riscv64/loongarch64）、rootfs 下载等 |
| `rust-toolchain.toml` | Rust 工具链版本锁定 |
| `src/` | 内核入口点：`main.rs`（内核主函数）、`entry.rs`（init 进程启动逻辑） |
| `core/` | StarryOS 核心 crate（`starry-core`）：进程管理、内存管理、VFS、调度器等核心子系统 |
| `api/` | StarryOS API crate（`starry-api`）：系统调用层、文件抽象、信号处理、socket API 等 |
| `arceos/` | ArceOS 框架（独立 workspace），提供 HAL、驱动、网络栈、文件系统等基础能力 |
| `deps/` | 自定义依赖库：VDSO 构建/辅助、ELF 解析器、调度器 HAL、虚拟队列 VDSO 等 |
| `vdso/`、`vdso_example/` | VDSO（Virtual Dynamic Shared Object）核心库与示例 |
| `vdso_output/`、`vdso_vqueue_output/`、`vdso_vsched2_output/` | 预构建的 VDSO 共享库产物（libvdsoexample、libvqueue、libvsched2） |
| `tests/` | 用户态测试程序（helloworld、vdso_test、vipc_test、vsched2_test） |
| `scripts/` | CI 测试脚本 (`ci-test.py`) 和烧录脚本 (`flash.sh`) |
| `docs/` | 文档（目前仅 `x11.md`） |

---

### 三、子系统划分

#### 1. 内核核心层（`core/` — `starry-core` crate）

这是 StarryOS 的核心实现，直接依赖 ArceOS 各模块：

| 子系统 | 对应文件/目录 | 功能描述 |
|--------|--------------|----------|
| **架构配置** | `core/src/config/{riscv64,loongarch64,x86_64,aarch64}.rs` | 各架构的常量与配置 |
| **进程/线程管理** | `core/src/task.rs`、`core/src/task/stat.rs` | 进程控制块（ProcessData）、线程（Thread）、PID 管理、任务统计 |
| **用户态内存管理** | `core/src/mm.rs` | ELF 加载（`load_user_app`）、用户地址空间创建（`new_user_aspace_empty`）、内核数据拷贝 |
| **虚拟文件系统** | `core/src/vfs/{mod,dev,dir,file,fs}.rs` | VFS 抽象层，设备文件、目录、文件操作 |
| **自定义调度器 (vSched2)** | `core/src/vsched/{mod,context,task,trap,trapframe,trap_vector,stack,smp,userdata}.rs` | 用户态协程式调度框架，包含陷阱帧处理、栈管理、SMP 支持等 |
| **Futex** | `core/src/futex.rs` | 快速用户态互斥锁支持 |
| **共享内存** | `core/src/shm.rs` | System V 共享内存 |
| **IPC** | `core/src/vipc.rs` | 进程间通信（当前被注释） |
| **资源管理** | `core/src/resources.rs` | 进程资源限制（rlimits） |
| **时间管理** | `core/src/time.rs` | 定时器、告警任务 |

#### 2. 系统调用与 API 层（`api/` — `starry-api` crate）

| 子系统 | 对应文件/目录 | 功能描述 |
|--------|--------------|----------|
| **系统调用入口** | `api/src/syscall/mod.rs` | 系统调用分发 |
| **文件系统调用** | `api/src/syscall/fs/{mod,ctl,event,fd_ops,io,memfd,mount,pidfd,pipe,signalfd,stat}.rs` | 文件相关系统调用实现 |
| **内存系统调用** | `api/src/syscall/mm/{mod,brk,mincore,mmap}.rs` | mmap、brk 等 |
| **网络系统调用** | `api/src/syscall/net/{mod,cmsg,io,name}.rs` | socket、sendmsg、recvmsg 等 |
| **I/O 多路复用** | `api/src/syscall/io_mpx/{mod,epoll,poll,select}.rs` | epoll、poll、select |
| **IPC 系统调用** | `api/src/syscall/ipc/{mod,msg,shm}.rs` | 消息队列、共享内存 IPC |
| **文件抽象** | `api/src/file/{mod,epoll,event,fs,net,pidfd,pipe,signalfd}.rs` | 文件描述符表、各类文件类型的抽象 |
| **信号处理** | `api/src/signal.rs` | 信号发送与处理 |
| **Socket 抽象** | `api/src/socket.rs` | Socket 层抽象 |
| **任务 API** | `api/src/task.rs` | 用户任务创建接口 |
| **终端** | `api/src/terminal.rs` | TTY 终端支持 |
| **VFS API** | `api/src/vfs/` | 文件系统挂载、设备节点等 |

#### 3. ArceOS 基础框架（`arceos/`）

此为独立 workspace，提供底层硬件抽象和基础内核能力：

| 模块 | 路径 | 功能 |
|------|------|------|
| **axhal** | `arceos/modules/axhal/` | 硬件抽象层：中断、内存初始化、页表、per-CPU、时间、TLS，支持 RISC-V/x86_64/AArch64/LoongArch |
| **axconfig** | `arceos/modules/axconfig/` | 编译期平台配置生成 |
| **axalloc** | `arceos/modules/axalloc/` | 全局内存分配器 |
| **axmm** | `arceos/modules/axmm/` | 内存管理：地址空间（AddrSpace）、COW、文件映射后端 |
| **axtask** | `arceos/modules/axtask/` | 内核任务调度：run queue、wait queue、定时器、futures |
| **axruntime** | `arceos/modules/axruntime/` | 运行时初始化：BSS 清零、内存初始化、驱动初始化、SMP 启动 |
| **axsync** | `arceos/modules/axsync/` | 同步原语（Mutex） |
| **axfs** | `arceos/modules/axfs/` | 文件系统：支持 ext4 和 FAT，高层 API |
| **axnet** | `arceos/modules/axnet/` | 网络栈：TCP、UDP、Unix socket、vsock |
| **axdriver** | `arceos/modules/axdriver/` | 设备驱动：virtio、PCI、MMIO 总线，GIC 中断控制器、ixgbe 网卡 |
| **axdisplay** | `arceos/modules/axdisplay/` | 显示子系统 |
| **axinput** | `arceos/modules/axinput/` | 输入子系统 |
| **axlog** | `arceos/modules/axlog/` | 日志系统 |
| **axdma** | `arceos/modules/axdma/` | DMA 支持 |
| **axipi** | `arceos/modules/axipi/` | 核间中断（IPI） |
| **asynctask** | `arceos/modules/asynctask/` | 异步任务（当前被注释禁用） |
| **trampoline** | `arceos/modules/trampoline/` | 异步系统调用跳板（当前被注释禁用） |
| **axfeat** | `arceos/api/axfeat/` | 编译期特性标志整合 |
| **arceos_api** | `arceos/api/arceos_api/` | ArceOS 内部 API |
| **arceos_posix_api** | `arceos/api/arceos_posix_api/` | POSIX API 实现 |
| **axstd** | `arceos/ulib/axstd/` | 用户态标准库 |
| **axlibc** | `arceos/ulib/axlibc/` | 用户态 libc 实现 |

#### 4. 自定义依赖（`deps/`）

| 库 | 路径 | 功能 |
|----|------|------|
| **build_vdso** | `deps/build_vdso/` | 构建时代码生成：生成 VDSO API 和 wrapper |
| **elf_parser** | `deps/elf_parser/` | ELF 解析器，支持 RISC-V/AArch64/x86_64，含 AUX vector 和用户栈初始化 |
| **vdso_helper** | `deps/vdso_helper/` | VDSO 运行时辅助：日志、可变配置、vvar 数据页 |
| **vqueue_vdso** | `deps/vqueue_vdso/` | 基于共享内存的虚拟队列（IPC 通道），通过 VDSO 暴露给用户态 |
| **vsched_hal** | `deps/vsched_hal/` | 调度器硬件抽象：RISC-V/AArch64/x86_64 上下文切换汇编 |
| **vsched2** | `deps/vsched2/` | vSched2 调度器（空目录，实际依赖外部 crate `libvsched2`） |
| **vipc** | `deps/vipc/` | IPC 库（空目录，可能依赖外部 crate） |

#### 5. VDSO 体系（`vdso/`、`vdso_example/`、`vdso_output*/`）

VDSO 机制允许内核将部分代码以共享库形式映射到用户态地址空间，避免频繁的系统调用。项目包含三套预构建的 VDSO：
- **libvdsoexample**：示例 VDSO
- **libvqueue**：虚拟队列 VDSO（高速 IPC）
- **libvsched2**：vSched2 调度器 VDSO

---

### 四、构建工具需求

根据 `Makefile` 和 `Cargo.toml` 分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| **Rust 工具链**（rustc、cargo） | 主要编译工具，由 `rust-toolchain.toml` 指定版本 |
| **RISC-V 交叉编译工具链** | RISC-V 目标：`riscv64gc-unknown-none-elf` |
| **LoongArch 交叉编译工具链** | LoongArch 目标：`loongarch64-unknown-none-softfloat` |
| **GNU Make** | 构建编排 |
| **QEMU** | 模拟运行（支持 RISC-V virt、LoongArch virt） |
| **curl** | 下载预构建的 rootfs 镜像 |
| **xz** | 解压 rootfs 镜像 |
| **mkfs.ext4 / mount** | 文件系统镜像操作（`copy_tests` 目标） |

`Cargo.toml` 中的 `[package.metadata.vendor-filter]` 显式声明目标平台为 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none-softfloat`。

默认构建目标为 **RISC-V**（`ARCH := riscv64`），可通过 `make la` 切换到 LoongArch。QEMU 默认启用块设备（`BLK := y`）和网络（`NET := y`）。