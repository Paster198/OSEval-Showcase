## 项目初步调查报告

### 一、项目概览

该项目名称为 **MyGO!!!!! OS**，是一个基于 Rust 编写的通用操作系统内核，采用 Cargo workspace 组织，支持 **LoongArch64**（龙架构）和 **RISC-V 64** 两种指令集架构。项目使用 vendored dependencies（`vendor/` 目录），以减少对外部网络的依赖。

---

### 二、顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `kernel/` | 内核二进制主 crate，包含入口点、syscall 实现、设备初始化、调度初始化、基准测试 |
| `arch/` | 架构特定代码：LoongArch64 与 RISC-V64 的引导、分页、异常/中断处理、syscall frame 操作、上下文切换、VDSO |
| `hal/` | 硬件抽象层（HAL），定义控制台、内存、平台、调度器、时间、用户上下文等抽象接口 |
| `general/` | 架构无关的通用实现：设备驱动框架、VFS 具体实现（procfs/sysfs/devtmpfs/tmpfs）、固件解析（ACPI/DTB）、IPC（共享内存）、内存管理通用部分 |
| `libs/` | 独立的功能库，共 16 个子 crate（详见下文） |
| `userland/` | 用户态根文件系统（`rootfs-la`、`rootfs-rv`）及 LTP 测试场景 |
| `third/` | 第三方代码（busybox-1.36.1，通过 git submodule 管理） |
| `vendor/` | vendored 的 Rust 依赖（约 100+ crate） |
| `scripts/` | 辅助脚本：QEMU 启动、磁盘镜像制作、busybox 准备 |
| `docs/` | 技术文档（Typst 格式） |
| `cargo-config/` | Cargo 构建配置模板 |
| `Cargo.toml` | workspace 根配置 |
| `Makefile` | 顶层构建编排 |
| `rust-toolchain.toml` | 指定 Rust 工具链为 `nightly-2025-05-20` |

---

### 三、子系统划分

#### 1. 进程管理子系统
- **`kernel/src/syscalls/process.rs`** (4079 行)：进程相关系统调用的内核实现（fork/clone/execve/exit/wait 等）。
- **`libs/sched/`**：核心调度与任务管理。
  - `task.rs`：任务控制块（TCB）
  - `spawn.rs`：任务派生
  - `operation.rs`：进程操作（execve、exit 等）
  - `signal.rs`：信号处理
  - `wait.rs`：等待子进程
  - `scheduler.rs` / `eevdf.rs`：EEVDF 调度器实现
  - `runqueue.rs`：运行队列
  - `pid.rs`：PID 管理
  - `rlimit.rs`：资源限制
  - `group.rs`：进程组管理
  - `sync.rs` / `mutex.rs`：同步原语
- **`kernel/src/user.rs`** (1213 行)：用户态任务加载与管理。

#### 2. 内存管理子系统
- **`libs/allocator/`**：物理/虚拟内存分配器。
  - `buddy.rs`：Buddy 算法页分配器
  - `slab.rs`：Slab 分配器
  - `vmem.rs`：虚拟内存区域管理
  - `gc.rs`：内存回收
  - `managed.rs`：托管内存
  - `kheap.rs`：内核堆
  - `stats.rs`：分配统计
- **`libs/mm/`**：通用内存管理抽象（VmArea、文件映射、权限标志）。
- **`general/src/mm/`**：架构无关的内存管理通用逻辑（页错误处理、VmSpace、用户访问、烟雾测试）。
- **`arch/{riscv64,loongarch64}/mm/`**：架构特定的页表操作、内存布局、页错误解码、用户拷贝。

#### 3. 文件系统子系统
- **`libs/vfs/`**：虚拟文件系统层（VFS）。
  - `dentry.rs`：目录项缓存
  - `inode.rs`：索引节点
  - `superblock.rs`：超级块
  - `mount.rs`：挂载管理
  - `fdtable.rs`：文件描述符表
  - `file.rs`：文件对象
  - `path.rs`：路径解析
  - `pipe.rs`：管道
  - `epoll.rs` / `eventfd.rs` / `signalfd.rs` / `timerfd.rs`：事件通知机制
  - `flock.rs` / `record_lock.rs` / `lease.rs`：文件锁
  - `socket.rs` / `net_socket.rs` / `netlink_socket.rs`：套接字抽象
  - `cred.rs`：权限凭证
- **`libs/extfs/`**：ext2/3/4 文件系统驱动（超级块、inode、extent、目录、符号链接、写支持）。
- **`libs/fatfs/`**：FAT12/16/32 文件系统驱动（BPB、FAT 表、目录项、LFN 长文件名）。
- **`general/src/vfs/`**：VFS 具体实现。
  - `procfs.rs`：proc 文件系统
  - `sysfs.rs`：sysfs 文件系统
  - `devtmpfs.rs`：设备临时文件系统
  - `tmpfs.rs`：内存文件系统
  - `blockfs.rs`：块文件系统适配
  - `user_api/`：面向用户的块设备/网络套接字/TTY/ioctl 接口
  - `device_files/`：设备文件投影（RTC、loop、CPU DMA latency）
- **`kernel/src/syscalls/fs.rs`** (4368 行)：文件系统相关系统调用实现。

#### 4. 系统调用子系统
- **`kernel/src/syscalls/mod.rs`**：系统调用注册与分发入口。
- **`kernel/src/syscalls/nr.rs`** (355 行)：定义了 346 个 Linux asm-generic syscall 编号常量（从 SYS_IO_SETUP=0 到 SYS_FILE_SETATTR=469，另有私有号 SYS_MYGO_SCHED_INFO=510）。
- **`kernel/src/syscalls/fs.rs`**：文件系统系统调用（4368 行）
- **`kernel/src/syscalls/process.rs`**：进程管理系统调用（4079 行）
- **`kernel/src/syscalls/mm.rs`**：内存管理系统调用（482 行）
- **`kernel/src/syscalls/signal.rs`**：信号系统调用（389 行）
- **`kernel/src/syscalls/ipc.rs`**：IPC 系统调用（343 行）
- **`kernel/src/syscalls/syslog.rs`**：syslog 系统调用（82 行）
- **`general/src/syscall.rs`**：架构无关的系统调用分发框架（`SyscallFrameOps` 注入、`SyscallContext`、表驱动分发）。

#### 5. 设备驱动子系统
- **`general/src/dev/`**：设备驱动框架。
  - `block.rs` / `block_sync.rs`：块设备抽象与同步后端
  - `bio.rs`：块 I/O 请求
  - `pci.rs`：PCI 总线枚举
  - `pnp.rs`：即插即用设备枚举
  - `virtio.rs` / `virtio_mmio.rs`：VirtIO 框架
  - `irq.rs`：中断请求管理
  - `msi.rs`：MSI 中断
  - `rtc.rs`：实时时钟框架
  - `drivers/`：具体驱动实现：
    - `virtio_blk.rs` / `virtio_block_common.rs`：VirtIO 块设备
    - `virtio_net.rs`：VirtIO 网络设备
    - `virtio_pci.rs`：VirtIO PCI 传输
    - `uart16550.rs`：NS16550 UART
    - `plic.rs`：RISC-V PLIC 中断控制器
    - `loongson_irq.rs`：龙芯中断控制器
    - `ls7a_rtc.rs`：龙芯 7A RTC
    - `goldfish_rtc.rs`：Goldfish RTC
    - `random.rs`：硬件随机数
    - `fw_cfg.rs`：QEMU fw_cfg
    - `cfi_flash.rs`：CFI Flash
    - `syscon.rs`：系统控制器
    - `loopback.rs`：回环设备

#### 6. 网络子系统
- **`libs/mygo-smoltcp/`**：fork 自 smoltcp 0.12.0 的 TCP/IP 协议栈，支持 IPv4/IPv6、TCP、UDP、以太网。
- **`libs/net/`**：网络栈封装层。
  - `stack.rs` (4958 行)：协议栈核心
  - `interface.rs`：网络接口管理
  - `adapter.rs`：设备适配器
  - `socket.rs`：套接字封装
  - `route.rs`：路由表
  - `config.rs` / `tuning.rs`：配置与调优
- **`libs/socket/`**：套接字状态机（连接管理、I/O、等待队列）。

#### 7. IPC 子系统
- **`general/src/ipc/`**：进程间通信。
  - `shm.rs` (710 行)：System V 共享内存
- **`kernel/src/syscalls/ipc.rs`**：IPC 系统调用实现。

#### 8. 信号子系统
- **`libs/sched/src/signal.rs`**：信号集、信号队列、信号发送与处理。
- **`kernel/src/syscalls/signal.rs`**：信号相关系统调用。

#### 9. 架构支持
- **`arch/src/riscv64/`** (25 文件)：RISC-V 64 架构实现。
- **`arch/src/loongarch64/`** (22 文件)：LoongArch64 架构实现。
- 各架构均包含：引导、ABI 定义、EFI stub、异常/中断处理、分页、syscall frame 操作、任务上下文切换、VDSO、heap 虚拟化、加载器。

#### 10. 固件与平台初始化
- **`general/src/firmware/`**：ACPI 与 DTB 固件解析。
- **`kernel/src/acpi.rs`** (1430 行)：ACPI 启动路径。
- **`kernel/src/dtb/`**：DTB 启动路径。
- **`kernel/src/device_init.rs`**：设备子系统统一初始化流程。
- **`kernel/src/initramfs.rs`**：initramfs 加载。
- **`kernel/src/vdso.rs`**：VDSO 支持。

#### 11. 辅助库
- **`libs/elf/`**：ELF 可执行文件解析（格式检测、加载、类型定义）。
- **`libs/efi/`**：EFI 支持（含 C 代码）。
- **`libs/errno/`**：错误码定义。
- **`libs/log/`**：内核日志子系统。
- **`libs/ktest/`**：内核单元测试框架。
- **`libs/acpi/`**：ACPI 表解析库（fork 自 rust-osdev/acpi）。

#### 12. 测试与基准测试
- **`kernel/src/bench.rs`** (3608 行)：分层性能基准测试（L0-L8：内存带宽、裸块设备、FAT32/ext4 顺序/随机读写、元数据操作）。
- **`userland/ltp-scenarios/`**：8 类 LTP 测试场景（event/fs/io/ipc/memory/process/signal/time）。
- **`libs/ktest/`**：支持 `#[ktest]` 属性的内核态测试宏框架。

---

### 四、构建工具链需求

根据 `Makefile`、`cargo-config/config.toml` 和 `kernel/build.rs` 分析：

| 工具 | 用途 |
|---|---|
| **Rust nightly-2025-05-20** | 编译内核及所有 Rust crate |
| **Cargo** | 构建编排（workspace，vendored dependencies） |
| **rust-lld** | 链接器（通过 `-Clink-arg=-Tkernel/linker/*.ld` 使用自定义链接脚本） |
| **LoongArch64 cross GCC** (`loongarch64-linux-gnu-gcc`) | 编译 EFI C 代码、busybox |
| **RISC-V musl cross GCC** (`riscv64-linux-musl-gcc`) | 编译 busybox（RISC-V） |
| **GNU Make** | 顶层构建编排（Makefile） |
| **cpio** | 打包 initramfs |
| **busybox** | 用户态根文件系统 |
| **QEMU** | 模拟运行（LoongArch64 virt 机器、RISC-V） |
| **mkfs.fat / mke2fs / debugfs / mtools** | 可选：制作 FAT32 和 ext4 磁盘镜像用于基准测试 |

链接脚本位于 `kernel/linker/` 目录下，包含四种变体：
- `qemu-loongarch64.ld` / `qemu-loongarch64-debug.ld`
- `qemu-riscv64.ld` / `qemu-riscv64-debug.ld`

---

### 五、代码规模概览

| 层次 | 大致代码行数（仅 `.rs` 文件） |
|---|---|
| `kernel/src/` | ~15,800 行（含 syscalls ~10,500 行） |
| `general/src/` | ~38,900 行 |
| `libs/` | ~65,000 行 |
| `arch/` | ~架构特定，两个架构各约 2000-3000 行 |
| `hal/` | ~500 行（接口定义为主） |

总代码量约 12 万行 Rust 代码，涵盖了一个较为完整的宏内核所应具备的主要子系统。