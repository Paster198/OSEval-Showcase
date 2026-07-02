# 项目初步分析报告：Falcores (NighthawkOS)

## 一、项目概览

该项目是一个名为 **NighthawkOS**（代号 Falcores）的 OS 内核，由 Rust 语言编写，面向 **RISC-V 64** 和 **LoongArch 64** 两种架构。项目使用 Rust workspace 组织，采用异步执行模型，支持运行 Linux 兼容用户态程序（如 busybox、lua、gcc、vim、git 等）。

## 二、项目文件组织结构

```
repo/
├── kernel/                    # 内核主 crate
│   ├── Cargo.toml
│   ├── Makefile
│   ├── build.rs               # 构建脚本（生成链接脚本、嵌入用户程序等）
│   ├── linker.ld              # 链接脚本模板
│   └── src/
│       ├── main.rs            # 内核入口 (rust_main)
│       ├── entry/             # 架构相关入口 (entry.S)
│       ├── boot.rs            # 启动 (BSS清零、多核启动)
│       ├── trap/              # 异常/中断处理 (含架构特定的 trap handler)
│       ├── syscall/           # 系统调用实现 (~13000行，涵盖大部分Linux syscall)
│       ├── task/              # 任务/调度 (含信号、futex、等待队列等)
│       ├── vm/                # 虚拟内存管理 (页表、mmap、地址空间)
│       ├── processor/         # 处理器抽象 (hart管理)
│       ├── net/               # 网络相关 (socket、地址等)
│       ├── osdriver/          # OS驱动管理 (设备树探测)
│       ├── loader.rs          # 用户程序加载
│       ├── logging.rs         # 日志
│       └── lang_item.rs       # Rust语言项
│
├── lib/                       # 库 crate (共22个子crate)
│   ├── arch/                  # 架构抽象层 (console, hart, interrupt, mm, pte, time, trap)
│   ├── config/                # 配置 (board, device, fs, inode, mm, process, sig, time, vfs)
│   ├── driver/                # 设备驱动 (block: virtblk/dw_mshc, net: virtnet/loopback, serial, plic)
│   ├── mm/                    # 内存管理 (address, frame, heap, page_cache)
│   ├── vfs/                   # 虚拟文件系统 (dentry, inode, file, path, dcache, mount, stat)
│   ├── osfs/                  # OS特殊文件系统 (procfs, devfs, sysfs, tmpfs, pipe, etc.)
│   ├── ext4/                  # EXT4 文件系统实现 (基于 lwext4_rust)
│   ├── fat32/                 # FAT32 文件系统实现 (基于 rust-fatfs)
│   ├── net/                   # 网络协议栈 (基于 smoltcp, TCP/UDP/Unix socket)
│   ├── signal/                # 信号 (SigInfo, SigDetails 等类型定义)
│   ├── timer/                 # 定时器 (Timer, TimerManager, async timer, timeout)
│   ├── executor/              # 异步执行器 (基于 async-task, 支持多hart任务队列)
│   ├── osfuture/              # 异步原语 (take_waker, block_on, yield_now, suspend_now)
│   ├── mutex/                 # 锁 (SpinNoIrqLock 等)
│   ├── shm/                   # 共享内存 (shmget/shmat/shmdt)
│   ├── id_allocator/          # ID分配器
│   ├── logger/                # 日志系统
│   ├── common/                # 通用工具 (AtomicFlags, RingBuffer)
│   ├── systype/               # 系统类型 (SysError, rlimit, rusage, 内存标志等)
│   ├── pps/                   # 处理器特权状态 (sstatus/sepc/satp 等)
│   ├── polyhal-macro/         # 过程宏 (arch_entry, def_percpu, define_arch_mods)
│   └── simdebug/              # 模拟调试支持
│
├── user/                      # 用户态程序
│   ├── Cargo.toml
│   ├── Makefile
│   └── src/
│       ├── lib.rs             # 用户库 (syscall封装、堆分配、_start)
│       ├── syscall.rs         # 系统调用号常量
│       ├── bin/               # 用户程序 (shell, init_proc, 各种测试等)
│       ├── ltpauto.rs         # LTP自动测试
│       └── linker.ld          # 用户程序链接脚本
│
├── scripts/ltp/               # LTP测试脚本
├── tools/                     # 辅助Python脚本 (LTP覆盖率审计、输出规范化)
├── testcase/                  # 测试用例目录 (riscv64, loongarch64)
├── img-data/                  # 文件系统镜像数据 (common, riscv64, loongarch64)
├── submit/                    # 提交用配置和vendor缓存
├── .cargo/config.toml         # Cargo配置 (离线构建、vendor源)
├── Cargo.toml                 # Workspace定义和依赖
├── Makefile                   # 顶层构建文件 (支持riscv64/loongarch64)
├── rust-toolchain.toml        # Rust工具链版本: nightly-2025-01-18
├── TestRequirement.txt        # 比赛测试要求说明
└── kernel_snippet.rs          # 学习用代码片段（非构建部分）
```

## 三、实现的子系统

根据代码分析，该项目实现了以下子系统：

### 1. 架构抽象层 (`lib/arch`, `kernel/src/entry`, `kernel/src/trap`)
- 支持 RISC-V 64 (S-mode) 和 LoongArch 64 双架构
- 通过条件编译 (`#[cfg(target_arch = "...")]`) 和 `define_arch_mods!` 宏实现架构多态
- 涵盖：控制台、Hart管理、中断、内存管理(MMU/页表项)、定时器、异常/陷入处理

### 2. 内存管理 (`lib/mm`, `kernel/src/vm`)
- 页帧分配器 (frame allocator)
- 堆分配器 (heap allocator)
- 页表管理 (page table)
- 地址空间管理 (addr_space, vm_area)
- mmap/munmap/mprotect/brk 系统调用
- 共享内存 (shm)
- 页缓存 (page_cache)

### 3. 进程/线程管理 (`kernel/src/task`, `kernel/src/processor`)
- 任务结构体 (Task, TaskState)
- 进程管理器 (process_manager)
- 线程组 (threadgroup)
- PID/TID 分配 (tid, id_allocator)
- 等待队列 (wait_queue)
- futex 支持
- capabilities 支持

### 4. 调度器 (`lib/executor`, `lib/osfuture`)
- 基于 async-task 的异步执行模型
- 多 Hart 任务队列
- 优先级任务队列
- block_on / yield_now / suspend_now 异步原语
- 超时控制 (TimeoutFuture)

### 5. 信号处理 (`lib/signal`, `kernel/src/task/signal`)
- 完整的 Linux 信号支持 (SIGACTION, SIGPROCMASK, SIGRETURN, SIGTIMEDWAIT 等)
- 信号信息结构 (SigInfo, SigDetails)
- pidfd 信号发送
- sigreturn trampoline (RISC-V 和 LoongArch 汇编)

### 6. 文件系统 (`lib/vfs`, `lib/osfs`, `lib/ext4`, `lib/fat32`)
- **VFS 层**：dentry、inode、file、superblock、dcache、路径解析、挂载点管理
- **EXT4**：基于 lwext4_rust 实现完整的 EXT4 读写
- **FAT32**：基于 rust-fatfs 实现 FAT32 读写
- **特殊文件系统**：
  - procfs (`/proc`)
  - devfs (`/dev`)
  - sysfs (`/sys`)
  - tmpfs (内存文件系统)
  - etcfs、varfs
  - pipefs (管道)
- fanotify 支持

### 7. 网络协议栈 (`lib/net`, `kernel/src/net`)
- 基于 smoltcp 的 TCP/IP 协议栈
- TCP、UDP、Unix Domain Socket
- 端口映射 (portmap)
- 网络接口管理 (interface, device)
- 异步网络轮询

### 8. 设备驱动 (`lib/driver`)
- VirtIO 块设备驱动 (virtblk)
- VirtIO 网络设备驱动 (virtnet)
- DW MSHC (DesignWare Mobile Storage Host Controller) SD卡驱动
- UART 16550 串口驱动
- PLIC 中断控制器
- Loopback 网络设备
- 设备树 (FDT) 探测

### 9. 系统调用 (`kernel/src/syscall`)
- 实现了约 **120+** 个 Linux 兼容系统调用
- 涵盖：进程管理、文件IO、内存管理、信号、网络、时间、poll/select、futex、bpf 等
- 总代码量约 12700 行

### 10. 定时器 (`lib/timer`)
- Timer/TimerManager 管理
- 异步定时器 (sleep_ms, run_with_timeout)
- 定时器事件 (IEvent)

### 11. 启动流程 (`kernel/src/boot`, `kernel/src/loader`)
- BSS段清零
- 多核启动 (hart_start)
- 用户程序嵌入 (通过 linkapp.asm)
- ELF 加载

## 四、构建工具需求

根据 `Cargo.toml`、`Makefile`、`rust-toolchain.toml` 和 `.cargo/config.toml` 分析：

| 工具/依赖 | 说明 |
|---|---|
| Rust nightly-2025-01-18 | 核心编译工具链，含 llvm-tools |
| cargo (含 cargo-binutils) | Rust 包管理器和构建系统 |
| GNU Make | 顶层构建编排 |
| RISC-V target: `riscv64gc-unknown-none-elf` | RISC-V 裸机交叉编译目标 |
| LoongArch target: `loongarch64-unknown-none` | LoongArch 裸机交叉编译目标 |
| rust-objdump / rust-objcopy | 用于生成反汇编和二进制 |
| QEMU (>= 9.2.1) | 模拟运行 (qemu-system-riscv64 / qemu-system-loongarch64) |
| mkfs.ext4 / mount / dd | 制作 EXT4 文件系统镜像 |
| OpenSBI / RustSBI | RISC-V SBI 固件 (通过 QEMU `-bios default`) |
| GDB (可选) | 调试 (riscv64-unknown-elf-gdb / loongarch64-linux-gnu-gdb) |
| Docker (可选) | 容器化构建环境 |

构建采用 **离线模式** (`--offline`)，依赖通过 `submit/vendor.tar.gz` 预缓存的 vendor 目录提供，不需要网络访问。