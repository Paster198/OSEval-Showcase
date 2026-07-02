## ShellCore 内核项目初步分析报告

### 一、项目概览

ShellCore 是一个基于 Rust 语言开发的宏内核（Monolithic Kernel）OS 项目，基于 rCore-Tutorial-v3 ch7 逐步开发而来。项目自 2026 年 1 月创建，目标架构为 RISC-V 64（riscv64gc）和 LoongArch 64，目前处于持续迭代阶段。

---

### 二、顶层目录结构

| 路径 | 说明 |
|------|------|
| `os/` | 内核主体代码（Rust），包含所有内核子系统 |
| `user/` | 用户态程序库与初始化程序（initproc），作为内核的 companion 项目 |
| `user-la/` | LoongArch 用户程序构建输出 |
| `bootloader/` | RustSBI 固件二进制（QEMU RISC-V） |
| `bl-new-qemu/` | 新版本 QEMU 使用的 RustSBI 固件 |
| `docs/` | 项目文档、初赛文档、开发日志及图片 |
| `tester-maker/` | 测试辅助工具（测试用例生成、过滤脚本） |
| `.cargo/` | Cargo 镜像源配置（rsproxy） |
| `Makefile` | 顶层构建入口，编排内核与用户程序编译及 QEMU 启动 |

---

### 三、内核子系统划分（`os/src/`）

#### 3.1 架构层（`arch/`）

| 子目录/文件 | 说明 |
|-------------|------|
| `arch/mod.rs` | 架构条件编译入口，根据 target_arch 引入 riscv 或 la 模块 |
| `arch/riscv/` | RISC-V 64 架构相关代码 |
| `arch/la/` | LoongArch 64 架构相关代码 |

两个架构目录结构对称，各含：

| 模块 | 文件 | 说明 |
|------|------|------|
| 配置 | `config.rs` | 架构常量（页大小、内核地址空间布局、CPU 核心数等） |
| 陷入/异常 | `trap/mod.rs`, `trap/context.rs` | 中断/异常处理入口、TrapContext 定义 |
| 内存管理 | `mm/mod.rs`, `mm/pte.rs` | 页表项定义、地址映射辅助 |
| SBI 接口 | `sbi.rs` | SBI 调用封装（RISC-V）/ IPI 与核间启动封装（LoongArch） |
| 定时器 | `timer.rs` | 时钟中断设置与处理 |
| 驱动 | `drivers/mod.rs`, `drivers/block/` | virtio-blk、virtio-net 驱动、PCI 枚举（LA） |
| IPI | `ipi.rs`（LA 独有） | LoongArch IPI 核间中断 |
| 入口 | `entry.asm` | 启动汇编入口（设置栈、跳转 rust_main） |

#### 3.2 内存管理（`mm/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | 模块入口 |
| `address.rs` | 虚拟/物理地址抽象（PhysAddr, VirtAddr, PhysPageNum, VirtPageNum） |
| `page_table.rs` | 页表结构（SV39 / LA 页表） |
| `frame_allocator.rs` | 物理页帧分配器（FrameTracker） |
| `heap_allocator.rs` | 内核堆分配器 |
| `memory_set.rs` | 地址空间管理（MemorySet, MapArea） |
| `mmap.rs` | mmap 系统调用实现（文件映射、匿名映射、页缓存） |
| `user_buffer.rs` | 用户态缓冲区读写辅助 |
| `flags.rs` | 页表项标志位 |
| `id.rs` | 内存相关 ID 分配 |

#### 3.3 进程管理（`process/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | 进程管理入口，核心数据结构导出 |
| `pcb.rs` | 进程控制块（PCB），管理地址空间、文件描述符表、信号等 |
| `task/tcb.rs` | 线程控制块（TCB） |
| `task/context.rs` | 任务上下文（寄存器快照） |
| `task/signal.rs` | 信号处理 |
| `task/action.rs` | 任务动作 |
| `manager.rs` | 全局任务管理器（TASK_MANAGER） |
| `processor.rs` | 当前核处理器状态（PROCESSOR），控制任务切换 |
| `schedule.rs` | 调度策略实现 |
| `switch.rs` | 任务上下文切换（`__switch`） |
| `id.rs` | PID/TID 分配、KernelStack |
| `clone.rs` | clone 系统调用相关（fork/vfork） |

#### 3.4 文件系统（`fs/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | FS 模块入口，File trait 定义 |
| `inode.rs` | OSInode 统一索引节点 |
| `file_tree.rs` | 目录项缓存树（Dentry），路径解析，ROOT_DENTRY |
| `dir_entry.rs` | DirEntry 结构 |
| `pipe.rs` | 匿名管道 |
| `fifo.rs` | 命名管道（FIFO） |
| `stdio.rs` | 标准输入/输出/错误 |
| `tmpfs.rs` | 内存文件系统（Tmpfs），环境初始化 |
| `procfs.rs` | proc 虚拟文件系统（进程信息导出） |
| `devfs.rs` | 设备文件系统 |
| `memfd.rs` | memfd_create 支持 |
| `epoll.rs` | epoll 事件通知机制 |
| `ino.rs` | inode 编号分配 |
| `userpagefault.rs` | 用户态缺页信息 |

#### 3.5 Ext4 文件系统（`ext4fs/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | Ext4 模块入口 |
| `superblock.rs` | Ext4 超级块解析 |
| `blockgroup.rs` | 块组描述符 |
| `ext4inode.rs` | Ext4 inode 磁盘结构与操作 |
| `ext4.rs` | Ext4 文件系统挂载与管理 |
| `ext4_dir_entry.rs` | Ext4 目录项 |
| `vfs.rs` | Ext4 到 VFS 适配层 |

#### 3.6 驱动层（`drivers/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | 驱动模块入口 |
| `block/mod.rs`, `block/block_dev.rs`, `block/block_cache.rs` | 块设备抽象接口、块缓存 |
| `loopdev.rs` | Loop 设备管理器 |

#### 3.7 网络子系统（`net/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | 基于 smoltcp 协议栈的网络接口初始化与轮询 |
| `socket.rs` | Socket 抽象与管理（TCP/UDP/RAW） |
| `netlink.rs` | Netlink 通信支持 |

#### 3.8 IPC 子系统（`ipc/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | IPC 模块入口 |
| `msg.rs` | System V 消息队列 |
| `shm.rs` | System V 共享内存 |
| `namespace.rs` | IPC 命名空间隔离 |

#### 3.9 同步原语（`sync/`）

| 文件 | 说明 |
|------|------|
| `mod.rs` | 同步模块入口 |
| `mp.rs` | MPSafeCell（多核安全互斥容器） |
| `semaphore.rs` | 信号量、等待队列、条件变量 |

#### 3.10 系统调用（`syscall/`）

| 文件 | 行数 | 说明 |
|------|------|------|
| `mod.rs` | 515 | 系统调用分发入口，约 317 个 syscall 编号定义及统一分发 |
| `process.rs` | 4958 | 进程/线程相关系统调用（fork, exec, exit, waitid, clone, tkill, futex 等），最大文件 |
| `fs.rs` | 2178 | 文件系统相关系统调用（openat, read, write, lseek, stat, ioctl, mount 等） |
| `net.rs` | 1233 | 网络相关系统调用（socket, bind, listen, accept, sendmsg, recvmsg 等） |
| `bpf.rs` | 650 | BPF 系统调用 |
| `ipc.rs` | 516 | IPC 系统调用（shmget, msgget, semget 等） |
| `mm.rs` | 197 | 内存管理系统调用（mmap, munmap, brk, mprotect 等） |
| `prctl.rs` | 168 | prctl 系统调用 |
| `errno.rs` | 145 | errno 错误码定义 |

#### 3.11 其他内核模块

| 文件 | 说明 |
|------|------|
| `main.rs` | 内核入口（rust_main），初始化流程编排，多核启动 |
| `timer.rs` | 高精度定时器、TimeSpec/TimeVal 定义 |
| `console.rs` | 控制台输出（基于 SBI） |
| `logging.rs` | 日志系统初始化 |
| `lang_items.rs` | Rust 语言项（panic_handler 等） |
| `auth/mod.rs` | 文件权限检查（UID/GID/文件模式） |

---

### 四、用户程序（`user/`）

| 文件 | 说明 |
|------|------|
| `src/lib.rs` | 用户库，提供 `_start` 入口、堆初始化、系统调用封装 |
| `src/syscall.rs` | 系统调用汇编封装（ecall/syscall）与用户态 syscall 函数 |
| `src/console.rs` | 用户态控制台 I/O |
| `src/bin/initproc.rs` | 默认初始化程序（初赛测评脚本） |
| `src/bin/initproc_sh.rs` | BusyBox shell 初始化程序 |
| `src/bin/initproc_ltp.rs` | LTP 测试初始化程序 |
| `src/linker-rv.ld`, `src/linker-la.ld` | 用户程序链接脚本 |

---

### 五、构建工具链总结

构建该项目需要以下工具和目标组件：

1. **Rust 工具链**：nightly-2026-01-01，含 `rust-src`、`llvm-tools-preview`、`rustfmt`、`clippy`、`rust-analyzer` 组件
2. **目标三元组**：
   - `riscv64gc-unknown-none-elf`（RISC-V 裸机）
   - `loongarch64-unknown-none`（LoongArch 裸机）
3. **模拟器**：QEMU（riscv64 和 loongarch64 变体），支持 virtio-blk/net
4. **构建工具**：GNU Make、Cargo（含 rust-objcopy）
5. **SBI 固件**：RustSBI（预编译二进制随仓库提供）
6. **外部依赖 crate**：smoltcp（网络栈）、buddy_system_allocator、virtio-drivers、spin、lazy_static、xmas-elf、zerocopy、bitflags、log
7. **文件系统镜像**：预制的 ext4 格式 sdcard 镜像（`sdcard-rv.img`、`sdcard-la.img`）

---

### 六、项目规模概览

| 指标 | 数值 |
|------|------|
| 内核源码总行数（.rs） | 约 27,500 行 |
| 架构代码（RISC-V + LoongArch） | 约 2,200 行 |
| 系统调用实现总行数 | 约 10,000 行 |
| 用户程序库 | 约 500 行（不含 initproc） |
| 支持架构数 | 2（RISC-V 64, LoongArch 64） |
| 系统调用总数（定义） | 约 317 个 |
| 独立子系统数 | 约 13 个 |

---

### 七、整体架构特征

该项目是典型的宏内核架构，具有以下显著特征：

1. **双架构支持**：通过条件编译（`#[cfg(target_arch)]`）同时支持 RISC-V 和 LoongArch，大部分内核代码（进程管理、文件系统、网络栈、系统调用）与架构无关。
2. **VFS 层设计**：抽象了统一的 File trait 和 OSInode，支持多种文件系统后端（Tmpfs、Procfs、Devfs、Ext4、Pipe、FIFO、Memfd）。
3. **Ext4 完整实现**：拥有独立的 ext4 只读/读写支持模块（ext4fs），包括超级块、块组、inode、目录项及 VFS 适配层。
4. **丰富系统调用**：覆盖文件 I/O、进程管理、内存管理、网络 socket、IPC（消息队列/共享内存/信号量）、信号、epoll、futex、BPF 等 Linux 兼容语义。
5. **基于 smoltcp 的网络栈**：支持 TCP/UDP/ICMP/RAW socket、netlink。
6. **多核支持**：通过 MPSafeCell、SBI IPI 实现多核启动与调度。