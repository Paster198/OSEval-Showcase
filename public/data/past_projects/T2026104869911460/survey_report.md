# AsyncBridge OS 内核项目 — 初步分析报告

## 一、项目概览

| 项目属性 | 详情 |
|----------|------|
| 项目名称 | AsyncBridge / NoAxiom |
| 编程语言 | Rust |
| Rust 工具链 | nightly-2024-05-01 |
| 支持架构 | RISC-V 64 (riscv64gc-unknown-none-elf)、LoongArch 64 (loongarch64-unknown-linux-gnu) |
| 内核类型 | 宏内核（Monolithic），异步运行时驱动 |
| 许可证 | 见 LICENSE 文件（18,017 字节） |

---

## 二、目录结构总览

```
repo/
├── Makefile                      # 顶层构建入口，支持 build/run/clean/gdb 等目标
├── rust-toolchain.toml            # Rust 工具链声明
├── rustfmt.toml                   # Rust 格式化配置
├── README.md                      # 项目自述
├── docs/                          # 设计文档与答辩材料
│   ├── AsyncBridge-操作系统内核设计.pptx
│   ├── 武汉大学_AsyncBridge_内核实现赛道_设计方案文档.pdf
│   ├── 武汉大学_AsyncBridge_内核实现赛道_设计方案文档.txt
│   └── figures/                   # 文档插图
├── scripts/                       # 测试与分析脚本
│   ├── analyze_ltp_tpass.py       # LTP 测试通过率分析
│   ├── ltp_score_plan.py          # LTP 评分方案
│   └── run_scout_tests.ps1        # 测试运行脚本 (PowerShell)
├── NoAxiom/                       # 内核主工作区（Cargo Workspace）
│   ├── Cargo.toml                 # 工作区清单，成员 = ["kernel"]
│   ├── Cargo.lock
│   ├── cargo-config.toml          # Cargo 配置模板
│   ├── Makefile                   # 内核级 Makefile (调用 cargo build)
│   ├── kernel/                    # 内核主体 (255 个 .rs 文件)
│   │   ├── Cargo.toml             # 内核 crate 依赖声明
│   │   ├── Makefile               # 内核构建规则
│   │   ├── build.rs               # 构建脚本
│   │   └── src/                   # 内核源代码
│   ├── lib/                       # 内核支持库 (165 个 .rs 文件)
│   │   ├── arch/                  # 架构抽象层 (RISC-V / LoongArch)
│   │   ├── config/                # 编译期配置
│   │   ├── driver/                # 设备驱动框架
│   │   ├── driver_ahci/           # AHCI 磁盘驱动
│   │   ├── ext4_rs/               # ext4 文件系统库
│   │   ├── fatfs/                 # FAT 文件系统库
│   │   ├── include/               # 错误码定义
│   │   ├── kfuture/               # 异步 Future 工具
│   │   ├── ksync/                 # 同步原语 (Mutex, RwLock, Semaphore, Barrier 等)
│   │   ├── memory/                # 低级内存管理 (帧分配器、堆)
│   │   ├── platform/              # 平台内存布局
│   │   └── scripts/               # 链接脚本生成 (mk_ld.sh)
│   └── vendor/                    # vendored 依赖 (含 async-task 等)
└── user/                          # 用户态程序 (Cargo Workspace)
    ├── Cargo.toml                 # 工作区清单，成员 = ["libd", "apps/*"]
    ├── Makefile                   # 用户程序构建规则
    ├── cargo-config.toml
    ├── libd/                      # 用户库：syscall 封装、entry、堆管理
    │   ├── src/
    │   │   ├── arch/{rv64,la64}/  # 架构相关 syscall 实现
    │   │   ├── syscall/           # syscall 包装与宏
    │   │   ├── entry.rs           # 用户程序入口
    │   │   ├── heap.rs            # 用户堆
    │   │   └── ...
    │   └── ...
    └── apps/
        ├── run_busybox/           # BusyBox 启动器
        └── run_tests/             # LTP 测试运行器
```

---

## 三、子系统划分

### 1. 入口与引导 (`kernel/src/entry/`)
- `main.rs` — 内核主函数 `rust_main`，harts 自旋等待 `boot_broadcast` 后进入事件循环 `run_task()`
- `init.rs` — Boot hart 初始化（BSS、帧分配器、堆、内核页表、驱动探测、文件系统、时钟、init 进程），唤醒其他 hart
- `init_proc.rs` — init 进程创建：通过内嵌 ELF (`link_apps.S`) 将用户程序作为二进制数组链接进内核，加载为 init 进程

### 2. 内存管理 (`kernel/src/mm/`)
- `memory_set.rs` — 虚拟地址空间管理，ELF 加载
- `map_area.rs` — VMA（虚拟内存区域）管理
- `mmap_manager.rs` — mmap 系统调用实现
- `page_table.rs` — 页表操作
- `shm.rs` — 共享内存
- `user_ptr.rs` — 用户态指针安全访问
- `validate.rs` — 用户指针合法性校验

底层支持：`lib/memory/` 提供帧分配器 (`frame.rs`)、内核堆 (`heap.rs`)、地址工具 (`address.rs`, `utils.rs`)

### 3. 虚拟文件系统 (`kernel/src/fs/`)
VFS 核心 (`vfs/`):
- `vfs/basic/` — VFS 核心抽象：dentry、inode、file、filesystem、superblock
- `vfs/impls/devfs/` — 设备文件系统：null、zero、full、urandom、tty、rtc、loopdev、loop_control、cpu_dma_latency
- `vfs/impls/proc/` — procfs：cpuinfo、meminfo、stat、status、uptime、mounts、interrupts、maps、exe、fd、timerslack
- `vfs/impls/ext4/` — ext4 文件系统 VFS 适配层
- `vfs/impls/rust_fat32/` — FAT32 文件系统 VFS 适配层
- `vfs/impls/ramfs/` — 内存文件系统

文件系统特性：
- `fdtable.rs` — 文件描述符表
- `pagecache.rs` — 页缓存
- `blockcache.rs` — 块缓存
- `path.rs` — 路径解析
- `pipe.rs` — 管道
- `epoll.rs` — epoll
- `eventfd.rs` / `timerfd.rs` / `signalfd.rs` / `memfd.rs` / `pidfd.rs` / `anonfd.rs` — 各类 fd
- `dnotify.rs` — 目录通知
- `flock.rs` / `lease.rs` / `record_lock.rs` — 文件锁
- `mqueue.rs` — POSIX 消息队列
- `netlink.rs` — netlink socket
- `socketpair.rs` — socketpair
- `procfile.rs` — 进程文件描述符
- `nsfd.rs` — 命名空间 fd
- `manager.rs` — FS 全局管理器

底层支持：`lib/ext4_rs/`（ext4 库）、`lib/fatfs/`（FAT 库）

### 4. 进程与任务管理 (`kernel/src/task/`)
- `task.rs` — 任务控制块核心实现（15,491 行）
- `fork.rs` — fork 实现
- `execve.rs` — execve 实现
- `exit.rs` — 进程退出
- `wait.rs` — 等待子进程
- `signal.rs` — 任务级信号处理
- `futex.rs` — futex 实现
- `namespace.rs` — 命名空间
- `manager.rs` — 全局任务管理器
- `pcb.rs` — 进程控制块
- `tcb.rs` — 线程控制块
- `taskid.rs` — 任务 ID 分配
- `status.rs` / `terminate.rs` — 进程状态与终止
- `memory.rs` — 任务内存相关
- `context.rs` — 上下文切换

### 5. 调度器 (`kernel/src/sched/`)
- `scheduler.rs` — 多级调度器：实时 (FIFO) + 普通 (Expired/CFS)，含 `MultiLevelScheduler`
- `runtime.rs` — `MultiLevelRuntime`：基于 `async-task` 的异步运行时
- `cfs/cfs.rs` — CFS (完全公平调度) 实现
- `cfs/sched_entity.rs` — CFS 调度实体
- `cfs/sched_info.rs` — CFS 调度信息
- `sched_entity.rs` — 通用调度元数据
- `spawn.rs` — 任务派生（spawn_utask / spawn_ktask）
- `vsched.rs` — Scheduler / Runtime trait 抽象
- `utils.rs` — block_on 等辅助函数

### 6. 系统调用接口 (`kernel/src/syscall/`)
共支持 **293 个系统调用**（基于 `include/syscall_id.rs` 中的枚举定义），按模块拆分：
- `fs.rs` (4,438 行) — 文件系统相关
- `process.rs` (1,696 行) — 进程管理
- `mm.rs` (1,045 行) — 内存管理
- `net.rs` (1,520 行) — 网络
- `io.rs` (1,183 行) — I/O 操作
- `signal.rs` — 信号相关
- `sched.rs` — 调度相关
- `time.rs` — 时间相关
- `ipc.rs` — IPC
- `syscall.rs` — 系统调用分发器
- `system.rs` / `others.rs` — 系统信息与其他

### 7. 信号处理 (`kernel/src/signal/`)
- `sig_manager.rs` — 信号管理器
- `sig_action.rs` — 信号处理动作（handler/sigaction）
- `sig_set.rs` — 信号集操作
- `sig_info.rs` / `sig_detail.rs` — 信号信息
- `sig_stack.rs` — 信号栈 (sigaltstack)
- `interruptable.rs` — 可中断等待
- `signal.rs` — 通用信号逻辑

### 8. 网络子系统 (`kernel/src/net/`)
基于 `smoltcp` 协议栈：
- `tcpsocket.rs` (26,153 行) — TCP socket 实现
- `udpsocket.rs` (14,814 行) — UDP socket 实现
- `socket.rs` — socket 抽象
- `socketfile.rs` — socket 与 VFS file 的桥接
- `socket_set.rs` — socket 集合管理
- `port_manager.rs` — 端口分配
- `poll.rs` — 网络 poll
- `handle.rs` — socket 句柄

### 9. 时间管理 (`kernel/src/time/`)
- `timer.rs` — 内核定时器（软件定时器）
- `clock.rs` — 时钟源抽象
- `gettime.rs` — 获取时间
- `time_info.rs` — 时间信息结构
- `time_slice.rs` — 时间片管理
- `timeout.rs` — 超时机制
- `namespace.rs` — 时间命名空间
- `timex.rs` — adjtimex/clock 调整

### 10. 异常与中断处理 (`kernel/src/trap/`)
- `utrap_handler.rs` — 用户态陷入处理（syscall、page fault 等）
- `ktrap_handler.rs` — 内核态异常处理
- `ext_int.rs` — 外部中断
- `soft_int.rs` — 软中断/IPI

### 11. I/O 异步桥 (`kernel/src/io/`)
- `async_bridge.rs` (12,896 行) — 核心：统一异步等待模型（Event/Ready/Completion），将阻塞系统调用转换为异步 Future
- `ppoll.rs` — ppoll 实现
- `pselect.rs` — pselect 实现

### 12. 进程间通信 (`kernel/src/ipc.rs`)
- System V IPC：消息队列、信号量、共享内存

### 13. CPU 管理 (`kernel/src/cpu/`)
- `cpu.rs` —  percpu 数据结构
- `hartid.rs` — hart ID 获取

### 14. 类型定义与常量
- `kernel/src/include/` — 各子系统类型定义（fs, mm, net, io, sched, time, process, futex, ipc, resource）、syscall ID 枚举、错误码
- `kernel/src/constant/` — 运行时常量（banner, fs, io, net, sched, time）

### 15. 工具与支持
- `kernel/src/utils/` — 日志 (`log.rs`)、事件 (`event.rs`)、hook (`loghook.rs`)、宏 (`macros.rs`)、交叉调用 (`crossover.rs`)
- `kernel/src/panic.rs` — panic handler，打印寄存器、内存信息后关机
- `kernel/src/profile.rs` — 性能剖析（文件系统操作耗时统计）

### 16. 设备驱动 (`lib/driver/`)
- 驱动模型：probe（设备树/PCI 探测）、realize（设备初始化）
- 块设备：virtio-blk、AHCI、VF2 SD 卡
- 字符设备：NS16550A、UART 8250
- 网络：loopback
- 显示：virtio-gpu
- 中断控制器：PLIC
- 调试：debug console、debug serial

### 17. 同步原语 (`lib/ksync/`)
- 异步锁：Mutex、RwLock、Semaphore、Barrier、OnceCell
- 阻塞锁：SpinLock、async Mutex
- `cell.rs` — SyncUnsafeCell

### 18. 架构抽象 (`lib/arch/`)
- `common/` — 架构无关 trait 定义（Asm、Boot、Interrupt、Memory、Time、Trap）
- `rv64/` — RISC-V 64 实现（含寄存器定义、上下文切换汇编）
- `la64/` — LoongArch 64 实现

---

## 四、构建工具链

| 工具 | 用途 |
|------|------|
| Rust nightly-2024-05-01 | 编译器 (rustc, cargo) |
| RISC-V 交叉编译工具链 | riscv64-unknown-elf-objdump/objcopy 等 |
| LoongArch 交叉编译工具链 | loongarch64-linux-gnu-objdump/objcopy 等 |
| rust-objcopy | 内核二进制剥离 |
| QEMU | 模拟器 (qemu-system-riscv64 / qemu-system-loongarch64) |
| dtc | 设备树编译/反编译 |
| OpenSBI/RustSBI | RISC-V SBI 固件 (QEMU 内建 default) |
| MUSL / glibc | 用户程序编译（通过 `LIB_NAME` 变量选择） |
| mkfs 工具 | 文件系统镜像制作（Makefile 中通过外部 TEST_DIR 引用） |
| Docker (可选) | 容器化构建环境 (`zhouzhouyi/os-contest:20260510`) |

构建入口：**顶层 `make`**，通过变量控制：
- `ARCH_NAME=riscv64|loongarch64`
- `INIT_PROC=busybox|runtests`
- `MULTICORE=1|...`
- `LOG=OFF|...`

---

## 五、初步评估

该项目是一个规模较大的 Rust 宏内核，代码总量（不含 vendor 和用户态）约 **77,000 行 Rust 代码**（kernel + lib），用户态约 285,000 行（含大量 LTP 测试用例代码）。内核实现了类 Linux 的完整子系统：VFS（支持 ext4/FAT32/ramfs/devfs/procfs）、完整的进程管理（fork/execve/exit/wait/namespace）、基于 CFS 的异步多核调度器、基于 smoltcp 的 TCP/UDP 网络栈、System V IPC、信号处理、futex、epoll 和丰富的文件描述符类型。系统调用覆盖 293 个 Linux syscall。项目特色在于**全异步内核设计**（AsyncBridge），通过 `kernel/src/io/async_bridge.rs` 将阻塞语义的系统调用统一转换为异步 Future，在自定义的 `MultiLevelRuntime` 上执行。