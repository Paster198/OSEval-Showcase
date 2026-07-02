## 项目初步调查报告

### 一、项目概述

该项目名为 **RocketOS**（参赛名"缺页不缺奖"），是一个使用 **Rust** 语言编写的 OS 内核，面向 2025 年全国大学生计算机系统能力大赛。支持 **RISC-V 64** 和 **LoongArch 64** 两种架构，内核总代码量约 **52,714 行 Rust 源码**（217 个 `.rs` 文件）。

---

### 二、仓库顶层结构

```
.
├── Makefile            # 顶层构建编排（含 QEMU 运行命令）
├── README.md           # 项目简介
├── LICENSE             # 许可证
├── rust-toolchain      # Rust 工具链版本：nightly-2025-01-18
├── .gitignore
├── os/                 # 【内核源码】
├── user/               # 【用户态程序】
├── scripts/            # 【辅助脚本】（LTP 测试处理、日志抓取等）
├── img/                # 【磁盘镜像】（含 Makefile 和压缩镜像包）
├── doc/                # 【文档】（设计文档 PDF + 演示 PPT）
├── ltp_test.txt        # LTP 测试用例列表
├── ltp_auto.sh         # LTP 自动化脚本
└── copy_tests.sh       # 测试用例拷贝脚本
```

---

### 三、内核子系统划分

内核源码位于 `os/src/`，按目录/模块划分如下：

#### 1. 架构层 (`arch/`)
- **`riscv64/`** — RISC-V 64 位支持
  - `boards/qemu.rs` — QEMU virt 板级支持
  - `trap/` — 中断/异常处理（含 context 和 irq）
  - `switch/` — 上下文切换（汇编 trampoline）
  - `mm/page_table.rs` — RISC-V 页表操作
  - `timer.rs` / `sbi.rs` / `virtio_blk.rs` / `config.rs`
- **`la64/`** — LoongArch 64 位支持
  - `boards/` — QEMU 和 2K1000 板级支持
  - `register/` — 完整的 LoongArch CSR 寄存器定义（base、mmu、timer、ras 四大类，约 50+ 文件）
  - `trap/` — 中断/异常处理
  - `drivers/` — LoongArch 平台驱动（PCI、内存分配器）
  - `trampoline/` / `switch/` / `mm/` / `timer.rs` / `tlb.rs` / `virtio_blk.rs`

#### 2. 内存管理 (`mm/`)
- `memory_set.rs` — 虚拟地址空间管理（~88KB，最大单文件）
- `page.rs` — 物理页帧管理
- `frame_allocator.rs` — 物理帧分配器
- `heap_allocator.rs` — 内核堆分配器
- `area.rs` — 内存区域（VMA）管理
- `address.rs` — 地址抽象
- `shm.rs` — System V 共享内存

#### 3. 进程/任务管理 (`task/`)
- `task.rs` — 任务控制块（TCB），~68KB，核心数据结构
- `manager.rs` — 任务管理器（创建、销毁、等待队列、定时器）
- `scheduler.rs` — 调度器
- `processor.rs` — 处理器抽象与任务切换
- `context.rs` — 任务上下文
- `id.rs` — PID 分配器
- `signal.rs` — 任务级信号处理
- `rusage.rs` / `wait.rs` / `aux.rs` / `kstack.rs`

#### 4. 文件系统 (`fs/`) — VFS 层
- `dentry.rs` — 目录项缓存（dentry cache）
- `inode.rs` — 索引节点抽象
- `file.rs` — 文件对象
- `fdtable.rs` / `fd_set.rs` — 文件描述符表
- `namei.rs` — 路径解析（~43KB）
- `mount.rs` — 挂载点管理
- `pipe.rs` — 管道
- `special.rs` — 特殊文件节点
- `page_cache.rs` / `stdio.rs` / `path.rs` / `kstat.rs` / `uapi.rs`
- 子文件系统：
  - **`dev/`** — devfs（null, zero, urandom, tty, rtc, loop_device）
  - **`proc/`** — procfs（cpuinfo, meminfo, pid, status, maps, smaps, mounts, fd, exe, pagemap, tainted, pid_max）
  - **`tmp/`** — tmpfs
  - **`etc/`** — etcfs（mtab）
  - **`old/`** — 旧版兼容层

#### 5. ext4 文件系统 (`ext4/`)
- `mod.rs` — 核心实现（~91KB）
- `inode.rs` — ext4 inode 操作（~91KB）
- `block_op.rs` — 块操作
- `super_block.rs` / `block_group.rs` / `extent_tree.rs` / `dentry.rs` / `fs.rs`

#### 6. FAT32 文件系统 (`fat32/`)
- `dentry.rs` / `inode.rs` / `file.rs` / `fat.rs` / `layout.rs` / `fs.rs` / `time.rs` / `mod.rs`

#### 7. 网络子系统 (`net/`)
- `mod.rs` — 基于 smoltcp 协议栈的封装（~21KB）
- `socket.rs` — Socket 核心实现（~93KB，最大文件之一）
- `tcp.rs` — TCP socket
- `udp.rs` — UDP socket
- `unix.rs` — Unix Domain Socket
- `loopback.rs` — 回环设备
- `listentable.rs` — 监听端口表
- `addr.rs` / `alg.rs` / `socketpair.rs`

#### 8. 系统调用 (`syscall/`)
- `mod.rs` — 系统调用分发入口（~27KB）
- `fs.rs` — 文件系统相关系统调用（~131KB，最大文件）
- `mm.rs` — 内存相关系统调用
- `task.rs` — 进程/线程相关系统调用（~52KB）
- `net.rs` — 网络相关系统调用（~52KB）
- `signal.rs` / `sched.rs` / `util.rs` / `errno.rs`

#### 9. 设备驱动 (`drivers/`)
- **`block/`** — 块设备驱动（block_cache, block_dev, virtio-blk）
- **`net/`** — 网络设备驱动（virtio-net，~21KB）

#### 10. 信号子系统 (`signal/`)
- `mod.rs` / `sig_frame.rs` / `sig_handler.rs` / `sig_stack.rs` / `sig_struct.rs`

#### 11. 同步原语
- **`mutex/`** — 自旋锁（spin_mutex），含 RISC-V 和 LoongArch 架构特定实现
- **`futex/`** — Futex 快速用户态锁（含 robust_list、优先级队列）

#### 12. 其他模块
- **`time/`** — 时间管理（config, mod）
- **`serial/`** — NS16550A 串口驱动
- **`timer.rs`** — 内核定时器
- **`loader.rs`** — ELF 程序加载器
- **`logging.rs`** — 日志系统
- **`console.rs`** — 控制台抽象
- **`utils.rs`** — 通用工具函数

---

### 四、用户态程序 (`user/`)

- `src/bin/` — 用户程序入口（initproc, user_shell, testsuits, testsocketpair, submit_script）
- `src/archive/` — 归档测试程序（forktest, usertests, matrix, shell 等约 20 个）
- `src/lib.rs` — 用户库（含 syscall 封装）
- `src/syscall.rs` / `src/console.rs` / `src/lang_items.rs`

---

### 五、构建工具需求

| 工具 | 用途 |
|------|------|
| **Rust nightly-2025-01-18** | 编译器（含 `rust-src`, `cargo-binutils`） |
| **GNU Make** | 构建编排 |
| **rust-objcopy** | RISC-V 目标文件的 strip 和格式转换 |
| **loongarch64-linux-gnu-objcopy** | LoongArch 目标文件的 strip 和格式转换 |
| **qemu-system-riscv64** | RISC-V QEMU 虚拟机（virt 机器） |
| **qemu-system-loongarch64** | LoongArch QEMU 虚拟机 |
| **OpenSBI** | RISC-V SBI 固件（QEMU 内建 default） |
| **dtc** | 设备树编译（用于生成 out.dtb） |
| **外部依赖（Cargo）** | smoltcp（网络栈）、virtio-drivers、buddy_system_allocator、zerocopy、spin、hashbrown、aes/salsa20（加密）等 |

构建产物：
- RISC-V：`os/target/riscv64gc-unknown-none-elf/release/os.bin`
- LoongArch：`os/target/loongarch64-unknown-none/release/os`

---

### 六、初步评估

该项目是一个功能较为完整的 Unix-like 内核，覆盖了操作系统核心子系统：内存管理、进程管理、文件系统（VFS + ext4 + FAT32 + procfs + devfs + tmpfs）、网络协议栈（TCP/UDP/Unix Socket）、信号机制、futex 同步、共享内存等。代码组织清晰，架构相关代码与平台无关代码分离良好，采用了 Rust 的模块化设计。从 LTP 测试集成来看，该项目面向较高的兼容性目标。