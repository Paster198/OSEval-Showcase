# LetsgOS 项目初步调查报告

## 一、项目基本信息

- **项目名称**：LetsgOS
- **内核形态**：Rust 宏内核，Linux ABI 兼容
- **支持架构**：RISC-V64（riscv64gc-unknown-none-elf）、LoongArch64（loongarch64-unknown-none）
- **基础来源**：基于 rustflyer/NighthawkOS（2025 年一等奖作品）演进
- **主要依赖协议栈**：smoltcp（网络）、lwext4_rust + rust-fatfs（文件系统）、virtio-drivers（块/网设备）
- **代码规模**：约 66,130 行 Rust 代码 + 少量汇编/C

## 二、仓库顶层结构

```
.
|-- kernel/              # 内核主体 crate（~24,500 行 Rust）
|-- lib/                 # 20+ 库 crate（~35,000 行 Rust）
|-- user/                # 用户态程序（~6,500 行 Rust）
|-- docs/                # 文档与设计材料
|-- submit/              # 提交材料（prebuilt 内核、config.toml、vendor）
|-- patches/             # 第三方代码补丁
|-- tools/               # 辅助脚本
|-- Makefile             # 顶层构建入口
|-- Cargo.toml           # Cargo workspace 定义
|-- Cargo.lock           # 依赖锁定
|-- Dockerfile           # Docker 构建环境定义
|-- rust-toolchain.toml  # Rust 工具链版本锁定
|-- README.md
|-- NOTICE.md
|-- THIRD_PARTY.md
|-- LICENSE
|-- LTPtestcase.txt
```

## 三、内核子系统识别（kernel/src/）

| 目录/文件 | 子系统 | 说明 |
|-----------|--------|------|
| `main.rs` | 内核初始化 | BSS 清零、堆/页分配器、页表、设备树探测、驱动、FS、ELF loader、executor、init 任务 |
| `boot.rs` | 启动引导 | BSS 段清零、多核启动（start_harts） |
| `entry/` | 架构入口 | RISC-V64 与 LoongArch64 的 `_start` 入口 |
| `trap/` | 陷阱/中断处理 | 内核陷阱、用户陷阱、上下文切换、中断返回、系统调用分发（含汇编陷阱入口） |
| `syscall/` | 系统调用 | 文件系统（fs, fsmount）、进程、信号、内存管理、网络、时间、I/O、poll、BPF、fanotify、key、sched、misc、user |
| `task/` | 进程/任务管理 | 任务控制块、进程管理器、线程组、信号处理、futex、capabilities、wait_queue、TID 分配、时间统计 |
| `vm/` | 虚拟内存管理 | 页表、地址空间、mmap、ELF 加载、共享内存、VM area、用户指针校验、IO 映射 |
| `net/` | 网络子系统 | 地址绑定、接口管理、消息传递、socket 抽象 |
| `processor/` | 处理器管理 | Hart（硬件线程）状态管理 |
| `osdriver/` | 设备驱动管理 | 设备树探测、驱动管理器 |
| `loader.rs` | ELF 加载器 | 用户程序 ELF 加载 |
| `logging.rs` | 日志 | 日志开关/过滤 |
| `lang_item.rs` | Rust 语言项 | `#[panic_handler]` 等 |

### 内核代码量分布（Top 子系统）

| 子系统（文件） | 代码行数 | 占比 |
|---------------|---------|------|
| 系统调用-文件系统（fs.rs） | 3,938 | 16.1% |
| 系统调用-进程（process.rs） | 2,062 | 8.4% |
| 虚拟内存-VM area | 1,210 | 4.9% |
| 系统调用-信号（signal.rs） | 1,027 | 4.2% |
| 系统调用-时间（time.rs） | 948 | 3.9% |
| 任务-taskf | 782 | 3.2% |
| 系统调用-网络（net.rs） | 774 | 3.2% |
| 任务-task | 700 | 2.9% |
| 虚拟内存-user_ptr | 681 | 2.8% |
| 虚拟内存-page_table | 586 | 2.4% |

## 四、库 crate 与子系统映射（lib/）

| 库 crate | 对应子系统 | 核心功能 |
|----------|-----------|---------|
| `arch/` | 架构抽象层 | 控制台、Hart、中断、MMU、页表项、定时器、陷阱的 RISC-V/LA 双实现 |
| `config/` | 内核配置 | 板级配置、设备、文件系统、inode、内存布局、进程、SBI、信号、时间、VFS 的编译期常量 |
| `driver/` | 设备驱动 | VirtIO 块设备、VirtIO 网络、UART 8250、PLIC 中断控制器、DW_MSHC SD 卡、Loopback 网卡 |
| `mm/` | 物理内存管理 | 物理页帧分配器（frame）、堆分配器（heap）、页缓存（page_cache）、地址抽象 |
| `vfs/` | 虚拟文件系统 | Dentry、Inode、File、SuperBlock、路径解析、挂载、文件句柄、kstat、目录项 |
| `osfs/` | OS 内建文件系统 | devfs、procfs、sysfs、tmpfs、etcfs、pipefs、以及 special 层（epoll/eventfd/signalfd/timerfd/inotify/bpf/io_uring/memfd） |
| `ext4/` | EXT4 磁盘文件系统 | 超级块、inode、目录、文件、dentry、ext 操作 |
| `fat32/` | FAT32 磁盘文件系统 | 超级块、inode、目录、文件、dentry（基于 rust-fatfs） |
| `net/` | 网络协议栈 | smoltcp 封装（SocketSet、Interface）、TCP、UDP、Unix socket、地址/端口管理、bench |
| `executor/` | 异步执行器 | 基于 async_task 的多核异步任务调度 |
| `timer/` | 定时器 | 定时器管理、异步超时、事件 |
| `signal/` | 信号类型 | 信号编号、SigInfo、SigDetails 类型定义 |
| `shm/` | 共享内存 | 共享内存页管理、标志位、ID 管理 |
| `systype/` | 系统类型 | SysError、内存标志、rlimit、rusage、splice、时间类型、内核接口定义 |
| `id_allocator/` | ID 分配 | PID/TID/FD 等 ID 的分配与回收 |
| `mutex/` | 锁原语 | SpinLock（关中断）、UP（单核）锁 |
| `logger/` | 日志系统 | 基于 log crate 的内核日志 |
| `pps/` | 处理器特权状态 | 任务切换时的 CPU 状态保存/恢复（satp/sepc/sstatus 或 LA 等效寄存器） |
| `osfuture/` | 异步工具 | Waker 获取、block_on |
| `common/` | 通用工具 | RingBuffer、AtomicFlags |
| `polyhal-macro/` | 过程宏 | `#[arch_entry]`、`#[arch_interrupt]`、percpu 变量宏 |
| `simdebug/` | 调试宏 | `when_debug!` 条件编译宏 |

## 五、构建工具链

### Rust 工具链
- **编译器**：Rust nightly-2025-01-18（由 `rust-toolchain.toml` 锁定）
- **组件**：llvm-tools
- **裸机目标**：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none`
- **关键工具**：cargo-binutils（提供 `rust-objdump`、`rust-objcopy`）

### 交叉编译工具链（Docker 镜像内）
- `riscv64-linux-musl-cross`：RISC-V musl 交叉编译
- `loongarch64-linux-musl-cross`：LoongArch musl 交叉编译
- `gcc-13.2.0-loongarch64-linux-gnu`：LoongArch Linux GNU 交叉编译
- `gcc-riscv64-linux-gnu` / `binutils-riscv64-linux-gnu`：RISC-V Linux GNU 交叉编译

### 模拟器
- **QEMU 9.2.1**：自编译，支持 `loongarch64-softmmu`、`riscv64-softmmu`、`aarch64-softmmu`、`x86_64-softmmu`

### 构建入口
- **顶层**：`make all`（从预编译产物解压 `kernel-rv` 和 `kernel-la`）
- **从源码构建**：`make build-all-from-source`（使用 vendor 依赖 + patch）
- **Docker**：提供完整 Dockerfile，构建包含所有工具链和 QEMU 的 Docker 镜像

### 构建流程概要
```
make build-all-from-source
  ├── 解压 vendor.tar.gz（离线依赖）
  ├── 应用 smoltcp 补丁
  ├── make build ARCH=riscv64 LOG= MODE=release  → kernel-rv
  └── make build ARCH=loongarch64 LOG= MODE=release → kernel-la

make build（单架构）
  ├── cd kernel && cargo build --offline（编译内核）
  └── cd user && cargo build --offline  （编译用户态程序）
      └── [LA only] 编译 la_cyclic_sched_shim.so（musl shim）
```

## 六、系统调用覆盖范围概览

根据 `kernel/src/syscall/` 的文件划分，该系统实现了以下系统调用组：

| 系统调用组 | 文件 | 说明 |
|-----------|------|------|
| 文件系统 | `fs.rs` (3,938行) | open/read/write/close/lseek/getdents/stat 等 |
| 文件系统挂载 | `fsmount.rs` (591行) | mount/umount/fsconfig 等 |
| 进程管理 | `process.rs` (2,062行) | fork/clone/execve/exit/wait 等 |
| 信号 | `signal.rs` (1,027行) | kill/sigaction/sigreturn 等 |
| 时间 | `time.rs` (948行) | clock_gettime/nanosleep/timerfd 等 |
| 网络 | `net.rs` (774行) | socket/bind/listen/accept/send/recv 等 |
| 内存管理 | `mm.rs` (595行) | mmap/munmap/mprotect/brk 等 |
| BPF | `bpf.rs` (524行) | bpf 系统调用 |
| I/O 多路复用 | `poll.rs` (162行) | poll/select 等 |
| 调度 | `sche.rs` (273行) | sched_yield/sched_setaffinity 等 |
| fanotify | `fanotify.rs` (266行) | fanotify 文件监控 |
| key | `key.rs` (307行) | 内核密钥管理 |
| 用户/组 | `user.rs` (322行) | getuid/getgid 等 |
| 杂项 | `misc.rs` (200行) | uname/reboot 等 |

## 七、项目整体架构特征

1. **双架构支持**：通过 `arch/` 库的 trait 抽象 + `#[cfg(target_arch = ...)]` 条件编译实现 RISC-V 与 LoongArch 双架构覆盖。

2. **Linux ABI 兼容**：系统调用编号和语义向 Linux 靠拢，用户态使用 musl/glibc 编译的测试程序可直接运行。

3. **异步内核**：使用 `async-task` + 自研 `executor` 实现内核级异步任务调度，配合 `osfuture` 提供 `block_on` 和 `take_waker` 等原语。

4. **VFS 抽象**：完整的分层 VFS 架构（VFS 抽象层 -> EXT4/FAT32 磁盘 FS -> OS 内建 FS（devfs/procfs/sysfs/tmpfs/pipefs/special））。

5. **网络栈**：基于 smoltcp（社区嵌入式网络栈），封装了 TCP/UDP/Unix socket 和 socket set 管理。

6. **构建模式**：支持 debug/release 模式，支持预编译 vendor 离线构建，支持 Docker 容器化构建环境。