# RocketOS 内核项目初步分析报告

## 一、项目概述

该项目是基于哈尔滨工业大学火箭队 RocketOS（`init` 分支）扩展的 Rust 宏内核操作系统，面向 OS 内核竞赛。支持 **RISC-V 64** 和 **LoongArch 64** 双架构，在 QEMU 下配合 glibc/musl 双 C 库运行完整评测流程。内核总计约 **86,000 行** Rust + 汇编代码，分布于约 306 个源文件中。

---

## 二、仓库顶层文件组织结构

| 路径 | 说明 |
|---|---|
| `os/` | **内核主代码**，包含所有核心子系统 |
| `user/` | **用户态程序**（用户库 + initproc、shell、测例入口） |
| `scripts/` | **辅助脚本**，LTP 日志分析、评分、白名单生成等 |
| `img/` | **磁盘镜像**相关（Makefile、rv/la 占位目录） |
| `doc/` | **技术文档**（初赛文档、调试汇总、各子系统修复说明） |
| `docs/` | **决赛文档**（含 Typst 源文件、组件与内容目录） |
| `debug/` | 测试结果记录（RISC-V 测试结果文件） |
| `Makefile` | **顶层构建入口**，协调 os/user 双架构构建与运行 |
| `README.md` | 项目说明文档 |
| `rust-toolchain` | 指定 Rust 工具链版本：`nightly-2025-01-18` |
| `copy_tests.sh` / `ltp_auto.sh` / `ltp_test.txt` / `passed_ltp_cases.txt` | LTP 测例管理与自动化脚本 |

---

## 三、内核子系统划分

### 1. 架构层 (`os/src/arch/`) — 约 8,594 行

| 子模块 | RISC-V (`riscv64/`) | LoongArch (`la64/`) |
|---|---|---|
| 入口/启动 | `entry.S` | `entry.S`, `load_img.S` |
| 陷阱/中断 | `trap/trap.S`, `trap/mod.rs`, `trap/context.rs`, `trap/irq.rs` | `trap/context.rs`, `trap/mem_access.rs` |
| 上下文切换 | `switch/switch.S`, `switch/mod.rs` | `switch/switch.S`, `switch/mod.rs` |
| 跳板页 | `trampoline/trampoline.S`, `trampoline/mod.rs` | `trampoline/trampoline.S`, `trampoline/mod.rs` |
| 内存管理 | `mm/page_table.rs`, `mm/mod.rs` | `mm/page_table.rs`, `mm/mod.rs` |
| 定时器 | `timer.rs` | `timer.rs`, `register/timer/` (CSR 寄存器定义) |
| 平台支持 | `boards/qemu.rs` | `boards/qemu.rs`, `board/2k1000.rs` |
| SBI | `sbi.rs` | `sbi.rs` |
| 回溯 | `backtrace/` | `backtrace/` |
| 其他 | `config.rs`, `hart.rs`, `lang_items.rs`, `virtio_blk.rs` | `config.rs`, `hart.rs`, `lang_items.rs`, `kern_stack.rs`, `serial/ns16550a.rs`, `tlb.rs`, `tlb_refill.S`, `syscall_id.rs` |

LoongArch 明显比 RISC-V 多了**完整的 CSR 寄存器定义层**（`register/base/`、`register/mmu/`、`register/ras/`、`register/timer/`），以及独立的 TLB 重填逻辑和 NS16550A 串口驱动。

### 2. 内存管理 (`os/src/mm/`) — 约 5,765 行

| 文件 | 说明 |
|---|---|
| `address.rs` | 物理地址、虚拟地址、页号类型定义 |
| `frame_allocator.rs` | 物理帧分配器 |
| `heap_allocator.rs` | 内核堆分配器 |
| `memory_set.rs` | 地址空间（MemorySet）管理，约 103KB，非常庞大 |
| `area.rs` | 虚拟内存区域（MapArea）管理，含 mmap 支持 |
| `page.rs` | 页面抽象 |
| `msg.rs` | **System V 消息队列** |
| `sem.rs` | **System V 信号量** |
| `shm.rs` | **System V 共享内存** |

### 3. 进程与任务管理 (`os/src/task/`) — 约 5,498 行

| 文件 | 说明 |
|---|---|
| `task.rs` | 核心任务结构体（约 98KB），含进程组、线程组、资源等 |
| `manager.rs` | 任务管理器，含全局任务表、定时器管理 |
| `scheduler.rs` | 调度器入口，含调度策略分发 |
| `processor.rs` | 处理器抽象，管理当前运行任务 |
| `context.rs` | 任务上下文（保存/恢复寄存器） |
| `id.rs` | PID 分配器 |
| `kstack.rs` | 内核栈管理 |
| `timer.rs` | POSIX 定时器与 timerfd |
| `signal.rs` | 任务级信号处理 |
| `aux.rs` | 辅助向量（auxv） |
| `rusage.rs` | 资源使用统计 |
| `wait.rs` | wait/waitpid 语义 |

### 4. 调度器 (`os/src/sched/`) — 约 664 行

| 文件 | 说明 |
|---|---|
| `cfs.rs` | CFS（完全公平调度器），条件编译启用 |
| `fifo.rs` | FIFO 实时调度器 |
| `prio.rs` | 优先级调度 |
| `idle.rs` | 空闲任务 |

### 5. 系统调用 (`os/src/syscall/`) — 约 13,920 行

| 文件 | 行数 | 说明 |
|---|---|---|
| `fs.rs` | 4,577 | 文件系统相关系统调用 |
| `task.rs` | 2,254 | 进程/线程相关系统调用 |
| `mm.rs` | 1,413 | 内存管理相关系统调用 |
| `net.rs` | 1,605 | 网络相关系统调用 |
| `util.rs` | 1,409 | 辅助系统调用 |
| `signal.rs` | 794 | 信号相关系统调用 |
| `mod.rs` | 770 | 系统调用分发入口 |
| `sched.rs` | 603 | 调度相关系统调用 |
| `epoll.rs` | 230 | epoll 系统调用 |
| `stub_fd.rs` | 132 | stub fd 系统调用 |
| `errno.rs` | 133 | 错误码定义 |

### 6. 文件系统 (`os/src/fs/`) — 约 23,873 行

**VFS 核心层**：

| 文件 | 行数 | 说明 |
|---|---|---|
| `dentry.rs` | 26,182 | 目录项缓存 |
| `file.rs` | 22,012 | 文件抽象与 FileOp |
| `namei.rs` | 47,302 | 路径解析 |
| `mount.rs` | 19,522 | 挂载系统（含 MS_BIND、MS_MOVE） |
| `fdtable.rs` | 21,161 | 文件描述符表 |
| `pipe.rs` | 30,118 | 管道实现 |
| `inode.rs` | 7,820 | inode 抽象 |
| `fanotify.rs` | 83,259 | fanotify 实现 |
| `file_lock.rs` | 22,503 | 文件记录锁 |
| `fs_context.rs` | 21,949 | fsopen/fsconfig 上下文 API |
| `epoll.rs` | 8,873 | epoll 实例管理 |
| `eventfd.rs` | 5,228 | eventfd |
| `inotify.rs` | 4,245 | inotify |
| `kstat.rs` | 7,874 | stat 信息 |
| `uapi.rs` | 14,183 | 用户态 API 类型 |

**特殊文件系统**：

| 目录 | 说明 |
|---|---|
| `dev/` | `/dev` 文件系统（null、zero、urandom、tty、rtc、loop_device） |
| `proc/` | `/proc` 文件系统（cpuinfo、meminfo、maps、smaps、pagemap、status、fd、mounts 等） |
| `etc/` | `/etc` 文件系统 |
| `tmp/` | `/tmp` 临时文件系统 |

### 7. ext4 文件系统 (`os/src/ext4/`) — 约 8,060 行

| 文件 | 行数 | 说明 |
|---|---|---|
| `inode.rs` | 102,567 | ext4 inode 操作 |
| `mod.rs` | 39,081 | ext4 文件系统主体 |
| `block_op.rs` | 42,156 | 块操作 |
| `super_block.rs` | 12,400 | 超级块 |
| `block_group.rs` | 11,350 | 块组管理 |
| `extent_tree.rs` | 4,722 | extent 树 |

### 8. FAT32 文件系统 (`os/src/fat32/`) — 约 1,324 行

基础的 FAT32 支持：dentry、file、fs、inode、layout、时间处理。

### 9. 网络栈 (`os/src/net/`) — 约 6,497 行

| 文件 | 行数 | 说明 |
|---|---|---|
| `socket.rs` | 98,621 | Socket 抽象与管理 |
| `tcp.rs` | 34,930 | TCP socket |
| `udp.rs` | 15,944 | UDP socket |
| `unix.rs` | 13,556 | Unix 域 socket |
| `mod.rs` | 32,259 | 网络栈初始化，基于 smoltcp |
| `loopback.rs` | 10,576 | 回环设备 |
| `listentable.rs` | 10,995 | 监听表 |
| `alg.rs` | 23,636 | 网络算法（校验和等） |
| `addr.rs` | 2,322 | 地址处理 |
| `socketpair.rs` | 7,576 | socketpair |

### 10. 驱动程序 (`os/src/drivers/`) — 约 4,814 行

| 目录/文件 | 说明 |
|---|---|
| `block/block_cache.rs` | 块缓存 |
| `block/block_dev.rs` | 块设备抽象 |
| `block/ramdisk.rs` | 内存盘 |
| `block/sdio.rs` | SDIO 驱动 |
| `net/mod.rs` | virtio-net 驱动（约 21KB） |
| `net/netdevice.rs` | 网络设备抽象 |
| `net/starfive/` | 昉·星光2 板载网卡驱动 |
| `net/la2000/` | LA2000 板载网卡驱动 |
| `mod.rs` | 设备初始化，设备树解析 |

### 11. 信号 (`os/src/signal/`) — 约 1,177 行

信号处理、信号帧构建、信号处理器管理、信号栈。

### 12. Futex (`os/src/futex/`) — 约 1,039 行

Futex 等待队列、哈希表、robust list。

### 13. BPF (`os/src/bpf/`) — 约 1,614 行

eBPF 指令解释器、map、link、attr、系统调用接口。

### 14. 其他基础模块

| 模块 | 行数 | 说明 |
|---|---|---|
| `time/` | 276 | 时间配置（时区等） |
| `mutex/` | 321 | 自旋锁（含 no-IRQ 变体，riscv/la64 分别实现） |
| `serial/` | ~2,000 | NS16550A 串口驱动 |
| `index_list/` | 1,372 | 自定义双向链表（支持多种迭代器） |
| `console.rs` | 58 | 控制台输出 |
| `logging.rs` | 62 | 日志系统 |
| `loader.rs` | 75 | 内嵌用户程序的加载器 |
| `timer.rs` | 269 | 内核定时器基础设施 |
| `utils.rs` | 468 | 通用工具函数 |
| `main.rs` | 221 | 内核入口 |

---

## 四、用户态程序 (`user/`)

| 路径 | 说明 |
|---|---|
| `src/lib.rs` | 用户库，封装常用系统调用 |
| `src/bin/initproc.rs` | init 进程（约 33KB），负责 LTP/busybox/lmbench/iperf 等测例执行 |
| `src/bin/user_shell.rs` | 用户 Shell |
| `src/bin/testsuits.rs` | 测试套件入口 |
| `src/bin/submit_script.rs` | 提交脚本 |
| `src/bin/shell/` | Shell 命令实现 |
| `src/archive/` | 历史/归档测试程序 |
| `src/ltp_patches/` | LTP 测例补丁 |
| `src/la_musl_libc_patches/` | LoongArch musl libc 补丁（二进制） |
| `src/linker.ld` / `src/linker_loongarch.ld` | 链接脚本 |

---

## 五、编译构建工具需求

基于对 `Makefile`、`Cargo.toml`、`build.rs` 的分析，构建该项目需要：

| 类别 | 工具 | 用途 |
|---|---|---|
| **Rust 工具链** | `cargo`、`rustc`、`rust-objcopy`、`rust-objdump` | 内核与用户程序编译、二进制处理 |
| **Rust 版本** | `nightly-2025-01-18` | 需要 nightly 特性（`#![feature(...)]`） |
| **RISC-V 目标** | `riscv64gc-unknown-none-elf` | RISC-V 裸机目标 |
| **LoongArch 目标** | `loongarch64-unknown-none` | LoongArch 裸机目标 |
| **LoongArch 交叉工具** | `loongarch64-linux-gnu-objcopy`、`loongarch64-linux-gnu-objdump`、`loongarch64-linux-gnu-gdb` | LoongArch 二进制处理与调试 |
| **QEMU** | `qemu-system-riscv64`、`qemu-system-loongarch64` | 模拟运行 |
| **OpenSBI** | 固件镜像 | RISC-V SBI 支持 |
| **磁盘工具** | `mkfs.ext4`、`mkfs.vfat`、`mount`/`umount`、`dd` | 测例盘制作与挂载 |
| **其他** | `gzip`、`mkimage`（U-Boot 工具） | VF2 板级镜像制作 |
| **构建编排** | GNU Make | 顶层构建流程 |

Rust 依赖中值得注意的外部 crate：`smoltcp`（网络协议栈）、`virtio-drivers`（virtio 驱动）、`dw_sd`（SD 卡驱动）、`fdt`（设备树解析）、`xmas-elf`（ELF 解析）、以及加密相关 crate（`salsa20`、`aes`、`hmac` 等）。