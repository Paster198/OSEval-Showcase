# RyOS 内核项目初步调查报告

## 一、项目概况

RyOS 是一个基于 Rust 语言开发的 OS 内核项目，采用 RISC-V 64（riscv64）和 LoongArch 64（loongarch64）双架构支持。项目使用 Cargo workspace 管理多个子 crate，以 QEMU 作为主要模拟运行平台，总 Rust 代码量约 65K 行（其中内核约 58K 行、HAL 层约 5K 行、用户库约 3K 行）。

## 二、文件组织结构

```
repo/
├── Cargo.toml              # Workspace 根配置
├── Cargo.lock              # 依赖锁文件
├── Makefile                 # 顶层构建入口
├── Makefile.sub             # 构建核心逻辑（由 Makefile include）
├── rust-toolchain.toml      # Rust 工具链版本锁定 (nightly-2025-01-18)
├── README.md                # 项目说明
├── RyOS技术文档.{pdf,docx,txt}  # 技术文档（多格式）
├── 开发历程.md              # 开发历程记录
│
├── os/                      # ★ 内核核心 crate
│   ├── Cargo.toml
│   ├── cargo/config.toml    # Cargo 配置（链接脚本等）
│   └── src/
│       ├── main.rs          # 内核入口
│       ├── config.rs        # 全局常量
│       ├── lang_items.rs    # Rust 语言项（panic_handler 等）
│       ├── banner.rs        # 启动横幅
│       ├── cgroup.rs        # cgroup 资源隔离
│       ├── linker-*.ld      # 链接脚本（riscv64/loongarch64）
│       ├── devices/         # 设备抽象层
│       ├── diag/            # 诊断与可观测性子系统
│       ├── drivers/         # 设备驱动
│       ├── executor/        # 异步执行器与调度
│       ├── fs/              # 文件系统
│       ├── ipc/             # 进程间通信
│       ├── mm/              # 内存管理
│       ├── net/             # 自研网络栈
│       ├── processor/       # 处理器上下文/抢占
│       ├── signal/          # 信号处理
│       ├── smp/             # 多核支持（IPI/TLB）
│       ├── sync/            # 同步原语
│       ├── syscall/         # 系统调用
│       ├── task/            # 任务管理
│       ├── timer/           # 定时器
│       ├── trap/            # 陷入处理
│       └── utils/           # 工具函数
│
├── hal/                     # ★ 硬件抽象层 (Hardware Abstraction Layer)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs
│   │   ├── board/           # 板级定义 (riscv64/loongarch64)
│   │   ├── component/       # 硬件组件抽象
│   │   │   ├── addr/        # 地址空间
│   │   │   ├── console/     # 控制台
│   │   │   ├── constant/    # 常量
│   │   │   ├── entry/       # 入口
│   │   │   ├── instruction/ # 指令
│   │   │   ├── irq/         # 中断控制器
│   │   │   ├── pagetable/   # 页表
│   │   │   ├── signal/      # 信号
│   │   │   ├── timer/       # 定时器
│   │   │   └── trap/        # 陷入
│   │   ├── interface/       # 接口定义（分配器/映射器）
│   │   └── util/            # HAL 工具
│   └── hal-marco/           # HAL 辅助宏
│
├── user/                    # ★ 用户库与用户程序
│   ├── Cargo.toml
│   ├── Makefile
│   └── src/
│       ├── lib.rs           # 用户库
│       ├── syscall.rs       # 用户态系统调用封装
│       └── bin/             # 用户程序
│           ├── initproc.rs  # 初始进程
│           ├── shell.rs / user_shell.rs  # Shell
│           ├── autotest.rs  # 自动测试
│           └── ...          # 其他测试程序
│
├── utils/                   # 独立工具库
│   ├── range-map/           # 范围映射数据结构
│   └── segment-tree/        # 线段树数据结构
│
├── mk/                      # 构建系统碎片文件
│   ├── config.mk            # 构建配置
│   ├── kernel.mk            # 内核编译规则
│   ├── fs.mk                # 磁盘镜像制作
│   ├── qemu.mk              # QEMU 运行参数
│   ├── user.mk              # 用户程序编译
│   ├── tests.mk             # 测试
│   └── utils.mk             # 工具
│
├── scripts/                 # 辅助脚本（启动/测试/性能等）
├── docs/                    # 文档与 SVG 图
├── etc/                     # 系统配置模板（passwd, hosts 等）
├── attach/                  # 附加文件（环境变量脚本等）
└── testcase.tar.xz / vendor.tar.xz  # 测试用例与vendor依赖归档
```

## 三、子系统划分

### 1. 硬件抽象层（HAL）—— `hal/`

将架构相关代码与内核核心逻辑分离，支持 riscv64 和 loongarch64。包含：

| 组件 | 路径 | 职责 |
|------|------|------|
| 板级定义 | `hal/src/board/` | 平台参数、设备树、内存布局 |
| 页表 | `hal/src/component/pagetable/` | 架构相关页表操作 |
| 中断控制器 | `hal/src/component/irq/` | PLIC / EIOINTC 抽象 |
| 定时器 | `hal/src/component/timer/` | 架构相关定时器 |
| 陷入处理 | `hal/src/component/trap/` | 陷阱帧、stvec 设置 |
| 控制台 | `hal/src/component/console/` | UART 驱动的 HAL 接口 |
| 入口 | `hal/src/component/entry/` | 启动入口汇编 |
| 指令 | `hal/src/component/instruction/` | sfence.vma、fence.i 等 |

### 2. 内核核心（OS）—— `os/src/`

#### 2.1 内存管理 (`mm/`)
- 帧分配器（`allocator/frame_allocator.rs`）
- 堆分配器（`allocator/heap_allocator.rs`）
- SV39 页表（`page_table.rs`）
- 用户地址空间 / VMA（`vm/uvm.rs`）
- 内核地址空间（`vm/kvm/`）
- ASID 分配器（`asid.rs`，SMP only）
- 帧泄漏诊断（`diag.rs`，framediag feature）

#### 2.2 文件系统 (`fs/`)
- VFS 抽象层（`vfs/`：dentry, inode, file, superblock, fstype）
- 自研 ext4 实现（`ext4_native/`：纯 Rust，含 superblock, inode, directory, extent, journal, bitmap, group_desc）
- 自研 FAT32 实现（`fat32/`：BPB, FAT, directory, inode）
- tmpfs（`tmpfs/`）
- procfs（`procfs/`：cpuinfo, meminfo, mounts, self/, stat, status, maps, fd）
- devfs（`devfs/`：null, zero, urandom, tty, rtc, loop）
- pipefs（`pipefs.rs`）
- 页面缓存（`page/`：cache, reclaim）
- stdio（`stdio.rs`）

#### 2.3 网络栈 (`net/`) —— 自研
- 以太网帧构建 / 校验和（`wire_util.rs`）
- ARP 协议（`arp/`）
- TCP 协议栈（`tcp/`：状态机、重传、拥塞控制、延迟确认、持久定时器、环形缓冲区、socket API）
- UDP 协议栈（`udp/`）
- IP 地址（`addr.rs`）
- 软中断（`softirq.rs`）
- 后端抽象（`backend/`：含 net_impl, tcp_ops）
- 定时器轮（`timer_wheel.rs`）
- 连接分片（`conn_shard.rs`）
- 唤醒器（`waker.rs`）
- 加密（`crypto.rs`）
- Netlink socket（`netlink_socket.rs`）
- Socket / socketpair（`socket.rs`, `socketpair.rs`）

#### 2.4 进程/任务管理 (`task/`)
- 任务结构（`task.rs`：TaskBlock, RunState）
- 任务管理器（`manager.rs`：全局 TASK_MANAGER）
- 调度器（`schedule.rs`）：work-stealing 调度算法
- 任务文件系统上下文（`fs.rs`）
- 信号关联（`signal.rs`）
- TID/PID 分配（`tid.rs`）
- 抢占能力（`cap.rs`）

#### 2.5 异步执行器 (`executor/`)
- 基于 `async-task` 的异步运行时
- 双 lane 就绪队列（woken / round_robin）
- 与调度器紧密协作

#### 2.6 处理器管理 (`processor/`)
- 上下文切换（`context.rs`）
- per-HART 处理器状态（`processor.rs`：PROCESSORS）
- 抢占检查

#### 2.7 同步原语 (`sync/`)
- 自旋锁（`mutex/spin_mutex.rs`）
- 自旋读写锁（`mutex/spin_rw_mutex.rs`）
- UP 安全单元（`up.rs`）
- 异步互斥量（`async_mutex.rs`，SMP only）
- 条件锁（`condlock.rs`）
- 缓存行对齐（`cache_aligned.rs`）
- lazy 初始化（`lazy.rs`）

#### 2.8 系统调用 (`syscall/`)
- 完整 Linux 兼容系统调用接口，按功能分组：
  - `fs.rs`：文件操作（open, read, write, stat, ...）
  - `mm.rs`：内存管理（mmap, brk, mprotect, ...）
  - `process.rs`：进程管理（fork, execve, wait4, clone, ...）
  - `net.rs`：网络（socket, bind, connect, send, recv, ...）
  - `signal.rs`：信号（kill, sigaction, sigreturn, ...）
  - `time.rs`：时间（clock_gettime, nanosleep, ...）
  - `futex.rs`：futex
  - `sche.rs`：调度控制（sched_setaffinity 等）
  - `io.rs`、`fd.rs`、`misc.rs`、`reboot.rs`、`uaccess.rs`
  - `ipc/`：System V IPC（`sysv.rs`）

#### 2.9 设备与驱动 (`devices/` + `drivers/`)
- 设备管理器（`manager.rs`）：device registry
- PCI 扫描（`pci.rs`）
- MMIO（`mmio.rs`）
- PLIC（`plic.rs`）
- 缓冲区缓存（`buffer_cache.rs`）
- 块设备驱动：virtio-blk, PCI blk, MMIO blk, MMC/SD
- 网络驱动：virtio-net, loopback
- 串口驱动：UART
- DMA 驱动

#### 2.10 信号处理 (`signal/`)
- 信号动作管理（`action.rs`）
- 信号处理器（`handler.rs`）
- 信号管理器（`manager.rs`）
- 消息队列（`msg_queue.rs`）

#### 2.11 定时器 (`timer/`)
- 定时器核心（`timer.rs`）
- 时钟（`clock.rs`）
- 时限任务（`timed_task.rs`）
- 时间记录器（`recoder.rs`）

#### 2.12 SMP 支持 (`smp/`)
- IPI 核间中断（`ipi.rs`，feature-gated）
- TLB shootdown（`tlb.rs`）

#### 2.13 诊断子系统 (`diag/`)
- 飞行记录仪（`flight_recorder.rs`）
- pstore（`pstore.rs`）
- 心跳（`heartbeat.rs`）
- 锁依赖检测（`lockdep.rs`）
- 网络自检（`netcheck.rs`）

#### 2.14 cgroup 资源隔离 (`cgroup.rs`)
- CPU 控制器（份额/配额/带宽）
- 内存控制器（计数）
- IO 控制器（计数）

#### 2.15 IPC (`ipc/`)
- System V 共享内存（`sysv/shm.rs`）

#### 2.16 工具模块 (`utils/`)
- 异步工具（`async_utils.rs`）
- 路径解析（`path.rs`）
- 环形缓冲区（`ring_buffer.rs`）
- 字符串工具（`string.rs`）
- 宏工具（`macro_utils.rs`）

### 3. 用户态 (`user/`)
- 用户库（`lib.rs`）：提供 syscall 封装、内存分配、控制台
- 用户程序（`bin/`）：initproc、shell、多种测试程序（网络、信号、共享内存、COW等）

## 四、构建系统概览

### 构建工具链
- **Rust**：nightly-2025-01-18（RISC-V 和 LoongArch 目标）
- **Cargo**：workspace 管理，含 `cargo-binutils`、`rust-src`、`llvm-tools-preview`
- **GNU Make**：顶层 Makefile + `mk/*.mk` 碎片化构建系统
- **QEMU**：`qemu-system-riscv64` 和 `qemu-system-loongarch64`
- **OpenSBI / RustSBI**：RISC-V SBI 固件
- **mkimage**（U-Boot 工具）：用于生成 zImage
- **mkfs.ext4**：制作 ext4 磁盘镜像
- **dd, mount, cp**：磁盘镜像制作工具

### 主要构建目标
| 目标 | 说明 |
|------|------|
| `make all` | 构建 disk.img + RISC-V 内核 + LoongArch 内核 |
| `make kernel-rv` | 仅构建 RISC-V 内核 |
| `make kernel-la` | 仅构建 LoongArch 内核 |
| `make run-rv` | 构建并 QEMU 运行 RISC-V |
| `make run-la` | 构建并 QEMU 运行 LoongArch |
| `make test-rv` | 构建测试版内核并运行自动测试 |
| `make disk-img` | 制作 ext4 磁盘镜像（1GB） |
| `make debug-rv` | GDB 调试 RISC-V |
| `make verify` | 本地性能验证 |

### 关键 feature flags
| Feature | 说明 |
|---------|------|
| `smp` | 多核支持（最多 4 核） |
| `net` | 自研网络栈 |
| `net_outbound` | 外网出站 |
| `fat32` | FAT32 文件系统支持 |
| `autotest` | 自动测试模式 |
| `work_steal` | 工作窃取调度 |
| `lockdep` | 锁依赖检测 |
| `diag` | 飞行记录仪 |
| `heartbeat` | 心跳观测 |
| `oops` | 增强 panic 诊断 |
| `verifyperf` | 性能基准模式 |
| `framediag` | 帧泄漏诊断 |

## 五、关键依赖

### 运行时依赖（Crates.io）
- `bitflags`, `log`, `lazy_static`, `spin`, `buddy_system_allocator`
- `virtio-drivers`（VirtIO 设备驱动）
- `async-task`（异步任务运行时）
- `hashbrown`（HashMap）
- `rand`（随机数）
- `sbi-rt`、`riscv`、`plic`（RISC-V）
- `salsa20`, `aes`, `polyval`, `sha2`, `sha1`, `hmac`（加密）

### Git 依赖
- `bitmap-allocator`（位图分配器）
- `fdt`（设备树解析）
- `fatfs`（FAT 文件系统，仅 legacy）
- `xmas-elf`（ELF 解析）
- `lwext4_rust`（ext4 库，已基本被自研替代）

## 六、初步评估

该项目是一个功能较为完整、代码规模较大（约 65K 行 Rust）的 OS 内核，具有以下特征：

1. **自研程度较高**：网络栈、ext4 文件系统、FAT32 文件系统均为自研实现，不依赖第三方 smoltcp/fatfs/ext4 crate。
2. **架构支持**：RISC-V 64 和 LoongArch 64 双架构。
3. **多核支持**：通过 feature flag 控制，支持 work-stealing 调度、IPI、TLB shootdown。
4. **系统调用兼容性**：实现了较完整的 Linux 兼容系统调用接口。
5. **VFS 层设计**：支持 ext4、FAT32、tmpfs、procfs、devfs、pipefs 多种文件系统。
6. **诊断能力**：飞行记录仪、锁依赖检测、心跳、pstore 等可观测性基础设施。
7. **cgroup 资源隔离**：CPU/内存/IO 三资源的统一抽象与强制执行。