## 项目结构与初步调查结果

### 1. 仓库顶层文件组织结构

```
.
├── README.md                    # 项目说明文档
├── LICENSE                      # 许可证
├── Makefile                     # 顶层构建/运行/镜像准备脚本
├── rust-toolchain               # Rust 工具链版本: nightly-2025-01-18
├── os/                          # 内核源码 (Rust)
├── user/                        # 用户态程序源码 (Rust)
├── scripts/                     # 辅助脚本 (diff_cases.py, ltp_allowlist.sh)
├── docs/                        # 初赛文档、演示PPT
├── image/                       # 架构示意图
├── img/                         # 磁盘镜像 (disk.tar.xz, disk-la.tar.xz) 及解包 Makefile
├── ltp_testcode.sh              # LTP 测试脚本
├── ltp_pass_list.txt            # LTP 通过列表
├── LTP_all.txt                  # LTP 全部测试用例清单
├── *.log / *.txt                # 各类序列输出日志和辅助文本文件
└── *.bak                        # 备份文件
```

### 2. 子系统识别与代码归属

#### 2.1 架构适配层 (`os/src/arch/`)

| 子系统 | 目录/文件 | 说明 |
|--------|-----------|------|
| RISC-V 64 架构 | `os/src/arch/riscv64/` | boards(qemu), config, mm(page_table), sbi, switch, timer, trampoline, trap(context/irq/trap.S), virtio_blk, entry.S, lang_items |
| LoongArch 64 架构 | `os/src/arch/la64/` | boards(qemu/2k1000), config, drivers(pci/mem_allocator), mm(page_table), register(数十个CSR寄存器定义), sbi, serial(ns16550a), switch, timer, tlb/tlb_refill, trampoline, trap(context/timer/trap.S), virtio_blk, entry.S, kern_stack, lang_items, syscall_id |

两个架构各自实现了独立的启动入口、异常/中断处理、MMU/TLB 管理、上下文切换和定时器。

#### 2.2 内存管理 (`os/src/mm/`)

`address.rs`, `area.rs`, `frame_allocator.rs`, `heap_allocator.rs`, `memory_set.rs`, `page.rs`, `shm.rs`

实现虚拟地址、物理帧分配、堆分配、内存集合（地址空间）、共享内存等。

#### 2.3 进程/任务管理 (`os/src/task/`)

`task.rs`, `manager.rs`, `processor.rs`, `context.rs`, `id.rs`, `kstack.rs`, `scheduler.rs`, `signal.rs`, `wait.rs`, `aux.rs`, `rusage.rs`

包含进程控制块、PID 分配、内核栈、上下文切换接口、等待/退出、资源使用统计等。

#### 2.4 调度器 (`os/src/sched/`)

`mod.rs`（Scheduler trait 定义），`fifo.rs`（FIFO 调度），`prio.rs`（优先级调度），`cfs.rs`（CFS 公平调度）

#### 2.5 系统调用 (`os/src/syscall/`)

`mod.rs`（总入口/分发），`fs.rs`, `mm.rs`, `net.rs`, `sched.rs`, `signal.rs`, `task.rs`, `util.rs`, `errno.rs`

按功能域划分的系统调用实现，覆盖文件系统、内存、网络、调度、信号、进程管理等。

#### 2.6 文件系统 (`os/src/fs/`)

| 子模块 | 目录/文件 | 说明 |
|--------|-----------|------|
| VFS 核心 | `dentry.rs`, `inode.rs`, `file.rs`, `fdtable.rs`, `fd_set.rs`, `namei.rs`, `path.rs`, `mount.rs`, `manager.rs`, `page_cache.rs`, `kstat.rs`, `uapi.rs` | 目录项缓存、inode 操作、文件描述符表、路径解析、挂载管理、页缓存 |
| 管道 | `pipe.rs` | 匿名管道 |
| 标准IO | `stdio.rs` | Stdin/Stdout |
| procfs | `proc/` (13 个文件) | cpuinfo, meminfo, pid, fd, maps, smaps, pagemap, status, mounts, exe, tainted, pid_max |
| devfs | `dev/` (7 个文件) | null, zero, tty, rtc, urandom, loop_device |
| tmpfs | `tmp/mod.rs` | 临时文件系统 |
| etc | `etc/mod.rs` | 系统配置 |
| 旧版兼容层 | `old/` | inode_trait, os_inode_old, path_old |

#### 2.7 EXT4 文件系统 (`os/src/ext4/`)

`super_block.rs`, `block_group.rs`, `inode.rs`, `dentry.rs`, `extent_tree.rs`, `block_op.rs`, `fs.rs`

EXT4 只读支持的完整实现，包括超级块解析、块组描述符、inode、extent 树、目录项。

#### 2.8 FAT32 文件系统 (`os/src/fat32/`)

`layout.rs`, `fat.rs`, `inode.rs`, `dentry.rs`, `file.rs`, `fs.rs`, `time.rs`

FAT32 文件系统的实现。

#### 2.9 网络子系统 (`os/src/net/`)

`mod.rs`, `socket.rs`, `socketpair.rs`, `tcp.rs`, `udp.rs`, `unix.rs`, `loopback.rs`, `listentable.rs`, `addr.rs`, `alg.rs`

基于 smoltcp 协议栈，支持 TCP/UDP/Unix Domain Socket、loopback、socketpair、监听表。

#### 2.10 信号 (`os/src/signal/`)

`sig_struct.rs`, `sig_frame.rs`, `sig_handler.rs`, `sig_stack.rs`

信号的发送、处理、栈帧、处理函数注册。

#### 2.11 Futex (`os/src/futex/`)

`futex.rs`, `queue.rs`, `robust_list.rs`, `flags.rs`, `jhash.rs`

futex 等待/唤醒/requeue 操作、robust list 支持。

#### 2.12 时间 (`os/src/time/`)

`mod.rs`, `config.rs`

时间相关的 clock_gettime、nanosleep、adjtimex 等系统调用实现。

#### 2.13 设备驱动

| 驱动 | 位置 | 说明 |
|------|------|------|
| VirtIO 块设备 | `os/src/arch/*/virtio_blk.rs` | RISC-V/LoongArch 各自实现 |
| 块设备缓存 | `os/src/drivers/block/` | block_cache, block_dev |
| 网络设备 | `os/src/drivers/net/` | smoltcp 设备和网卡驱动集成 |
| NS16550A 串口 | `os/src/serial/`, `os/src/arch/la64/serial/` | 串口驱动 |
| PCI 总线 (LA64) | `os/src/arch/la64/drivers/pci.rs` | LoongArch PCI 初始化 |

#### 2.14 基础工具/库

| 模块 | 位置 | 说明 |
|------|------|------|
| 互斥锁 | `os/src/mutex/` | SpinMutex, SpinNoIrqLock (riscv/la64 各自实现) |
| 双向链表 | `os/src/index_list/` | 基于索引的安全双向链表 |
| 控制台 | `os/src/console.rs` | SBI 控制台输出 |
| 日志 | `os/src/logging.rs` | 全局 logger |
| 加载器 | `os/src/loader.rs` | 用户程序加载 |
| 定时器类型 | `os/src/timer.rs` | TimeSpec, TimeVal, StatxTimeStamp |
| 工具函数 | `os/src/utils.rs` | C 字符串转换、时间日期等 |

#### 2.15 用户态程序 (`user/src/`)

- **库**：`lib.rs`, `syscall.rs`, `lang_items.rs`, `console.rs`, `linker.ld`
- **二进制程序** (`bin/`)：`initproc.rs`, `user_shell.rs`, `testsuits.rs`, `testsocketpair.rs`, `submit_script.rs`, `shell/`
- **归档测试** (`archive/`)：forktest, usertests, matrix, hello_world 等经典测试

### 3. 编译构建工具需求

| 工具类别 | 具体工具 | 用途 |
|----------|----------|------|
| Rust 工具链 | `rustc`, `cargo` (nightly-2025-01-18) | 内核及用户程序编译 |
| RISC-V 交叉编译 | `riscv64gc-unknown-none-elf` target, `rust-objcopy` | RISC-V 内核二进制生成 |
| LoongArch 交叉编译 | `loongarch64-unknown-none` target, `loongarch64-linux-gnu-objcopy` | LoongArch 内核二进制生成 |
| QEMU | `qemu-system-riscv64`, `qemu-system-loongarch64` | 模拟运行 |
| SBI 固件 | OpenSBI (QEMU 内置 `-bios default`) | RISC-V SBI 层 |
| 磁盘工具 | `mkfs.ext4`, `mkfs.vfat`, `mount`, `dd`, `gunzip` | 磁盘镜像构建和挂载 |
| 调试 | `riscv64-unknown-elf-gdb`, `loongarch64-linux-gnu-gdb` | 内核调试 |

### 4. 总体评估

该项目是一个 Rust 编写的宏内核 OS，代码总量约 **5.2 万行 Rust** + **约 630 行汇编**。支持 **RISC-V 64** 和 **LoongArch 64** 双架构，子系统覆盖较为完整：内存管理、进程管理、调度（含 CFS）、完整的文件系统栈（VFS + EXT4 + FAT32 + procfs + devfs + tmpfs + pipe）、网络协议栈（基于 smoltcp，支持 TCP/UDP/Unix Socket）、信号、futex、系统时钟等。构建工具链同时依赖 Rust 工具链和 GNU 交叉编译工具链。