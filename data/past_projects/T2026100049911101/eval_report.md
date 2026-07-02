# NCAIOS 操作系统内核技术画像与评估报告

## 一、项目基本信息

- 项目名称：NCAIOS
- 目标架构：RISC-V（已验证）、x86_64、AArch64、LoongArch64（代码支持但未全部验证）
- 实现语言：Rust
- 生态归属：基于 ByteOS 架构，使用 Rust 异步生态（async/await、futures）
- 主要特点：
    - 全异步内核架构，系统调用基于 Rust async/await 实现
    - 编译期驱动自动注册（linkme 分布式切片）
    - 基于设备树（FDT）的设备发现与匹配
    - 利用 Arc 实现简洁的写时复制（COW）fork
    - VFS 层支持多种文件系统（ramfs、devfs、procfs、ext4）
    - 支持动态链接 ELF 加载（可运行 musl libc + busybox）
    - Cargo workspace 组织，模块化程度较高
- 代码规模：约 110 个 Rust 源文件，总计约 13,430 行代码，19 个 crate

## 二、子系统实现及功能概览

### 2.1 内核入口与中断处理
- 实现多阶段内核启动（硬件初始化、内存分配器设置、驱动加载、任务调度启动）
- 中断分发支持：页错误（COW）、定时器中断、非法指令处理、外部中断
- 页错误处理区分内核/用户地址，用户态缺页触发 COW 或延迟分配

### 2.2 系统调用子系统
- 实现约 75 个 Linux 兼容系统调用，涵盖文件 I/O、进程管理、内存管理、信号、网络、时间、共享内存、系统信息等
- 采用异步实现：read/write 等阻塞调用返回 Future，在数据未就绪时让出 CPU
- 支持 poll/ppoll/pselect/epoll 多路复用
- 文件描述符管理完整（openat、dup、pipe、fcntl 等）

### 2.3 进程与线程管理
- 分离 PCB（进程控制块）与 TCB（线程控制块），支持线程组
- 实现 fork（COW）、clone（线程克隆）、execve（含动态链接器加载）、exit、wait4 等核心原语
- 支持 ELF 解析、动态链接器递归加载、用户栈初始化（argv/envp/auxv）
- 进程间关系维护（父进程、子进程列表、退出码收集）

### 2.4 内存管理
- 页式内存管理，基于位图的物理帧分配器
- 用户态内存区域（MemSet/MemArea）管理
- 实现 mmap/munmap/mprotect/brk，支持匿名映射、文件映射
- 延迟分配：匿名映射仅记录区域，缺页时分配物理页
- COW：通过 Arc<FrameTracker> 共享物理页，写时复制

### 2.5 文件系统（VFS 及具体实现）
- VFS 接口：INodeInterface trait（20 个方法），基于路径解析和挂载点管理
- ramfs：纯内存文件系统，按页存储，支持目录、文件、符号链接
- devfs：提供 stdin/stdout/stderr、null、zero、urandom、rtc 等设备节点，支持 tty 及 termios ioctl
- procfs：提供 /proc/meminfo、/proc/mounts、/proc/interrupts
- ext4（ext4rsfs）：基于纯 Rust 库，支持基本读写，存在已知 desc_size=0 兼容性问题
- 挂载点自动创建，支持多文件系统堆叠

### 2.6 设备驱动
- 设备抽象层（DeviceType 枚举），支持 BLOCK、NET、UART、RTC、INT、INPUT 等
- 基于 linkme 的编译期驱动注册与 FDT 设备匹配
- VirtIO 驱动：块设备（VirtIO-Blk）和网络设备（VirtIO-Net），支持 MMIO 和 PCI 传输
- 其他驱动：NS16550A UART、PLIC（RISC-V）、Goldfish RTC、RAM 磁盘

### 2.7 同步原语与并发
- 锁机制：使用 spin::Mutex、spin::RwLock
- 自定义 LazyInit：延迟一次性初始化容器
- Futex 实现：基于 BTreeMap 的用户态地址等待队列，支持 futex_wait/futex_wake/requeue，等待可被信号中断
- 异步执行器：单核 FIFO 调度，提供 yield、select 宏

### 2.8 网络
- 基于 lose-net-stack 提供 TCP/UDP 协议栈
- 实现 socket/bind/listen/accept/connect/sendto/recvfrom 等系统调用
- 网络数据收发通过 VirtIO-Net 驱动，报文处理在异步上下文中流转

### 2.9 时间管理
- 支持 gettimeofday、clock_gettime（REALTIME/MONOTONIC）、nanosleep、clock_nanosleep
- 定时器中断每 10ms 触发一次，用作调度时钟
- 部分实现 setitimer（仅 ITIMER_REAL）

### 2.10 信号处理
- 实现 sigaction、sigprocmask、sigsuspend、sigtimedwait、sigreturn
- 支持用户自定义信号处理函数及默认动作（终止/忽略）
- 信号在用户态返回路径（entry_point）检查并分发

## 三、各子系统实现完整程度

| 子系统 | 完整度（基于生产级 Linux 对应功能估算） | 主要缺失 |
|--------|----------------------------------------|---------|
| 系统调用 | 约 75% | 部分 ioctl、prlimit、cgroup、namespace 相关 |
| 进程管理 | 约 70% | 完整 rlimit、cgroup、job control、core dump |
| 内存管理 | 约 60% | 页面回收、swap、KSM、大页、MADV_DONTNEED |
| 文件系统（VFS） | 约 65% | inode/dentry 缓存、文件锁、ACL、配额 |
| 文件系统（ext4） | 约 50% | 写时事务安全、日志回放、desc_size 兼容性 |
| 信号处理 | 约 60% | siginfo 传递、SIGSTOP/SIGCONT 完整语义 |
| 网络 | 约 40% | IPv6、Unix domain socket、socket 选项详细实现 |
| 同步原语 | 约 50% | robust list 处理、PI futex、完整 requeue |
| 设备驱动 | 约 55% | NVMe、USB、图形、DMA 引擎 |
| 中断处理 | 约 60% | MSI/MSI-X、中断亲和性、bottom half |
| 定时器 | 约 50% | 高精度定时器、tickless、完整 itimer |
| 多核支持 | 约 20% | Secondary harts 仅 spin，未参与调度 |

**内核整体实现完整度（按功能覆盖粗略加权）：约 55%**

## 四、各子系统优缺点及实现细节

### 4.1 内存管理
- 优点：
    - 清晰的页管理模型，FrameTracker 实现 RAII 自动回收
    - COW 利用 Arc 强计数判断共享，实现简洁
    - 延迟分配降低 fork 后实际内存消耗
- 缺点：
    - 帧分配器使用线性扫描位图，分配连续多页效率较低
    - 无页面回收或交换，长时间运行可能内存耗尽
    - 多核内存一致性未处理（SMP 未启用）
- 实现细节：MemSet 中 MapTrack 的 Arc<FrameTracker> 既用于物理页生命周期管理，也用于 COW 共享检测；MemArea::sub_area 支持裁剪并回写文件映射的脏页。

### 4.2 进程管理
- 优点：
    - fork/clone/exec/wait 完成度高，支持线程与进程区分
    - ELF 加载支持动态链接器，可运行现实世界的 musl 程序
    - 进程树结构清晰，父进程可回收子进程退出状态
- 缺点：
    - 缺少进程优先级和公平调度（执行器为简单 FIFO）
    - 无进程会计（accounting）和资源限制的完整实现
    - 无法暂停/恢复进程组（job control 缺失）
- 实现细节：execve 递归加载解释器（PT_INTERP），失败回退至 busybox 执行；stack 初始化按 Linux ABI 填充 auxv。

### 4.3 文件系统
- 优点：
    - VFS 接口统一，挂载点管理灵活，支持多类型文件系统
    - ramfs/devfs/procfs 实现完整且可用
    - 异步 I/O 接口与执行器集成良好
- 缺点：
    - ext4 存在已知 bug（desc_size=0 导致 panic），兼容性受限
    - 无 inode 或 dentry 缓存，路径解析效率低
    - 无文件锁或持久化安全机制
- 实现细节：路径解析通过 MOUNTED_FS 反向扫描获取最近挂载点；File::async_read 使用 WaitBlockingRead Future 轮询底层 inode 的 poll 状态。

### 4.4 交互设计（用户接口 / Shell / 终端）
- 优点：
    - 通过 devfs 提供 tty 设备，支持基本行编辑（字符回显）和 termios ioctl
    - 可从 initproc 自动探测并启动 shell（busybox ash 等）
- 缺点：
    - Tty 实现使用简单的 VecDeque 缓冲区，无规范模式处理，行规程不完整
    - 缺少多个虚拟终端和会话管理
    - 无 job control，导致常见 shell 操作受限
- 实现细节：Tty::readat 非阻塞，无数据时返回 EWOULDBLOCK，从而与异步 I/O 和 poll 兼容。

### 4.5 同步原语
- 优点：
    - Futex 实现支持基本的用户态锁唤醒，可被信号中断（符合 POSIX 语义）
    - spin::Mutex/RwLock 提供内核内部临界区保护
- 缺点：
    - Futex requeue 未完整实现条件变量迁移
    - 缺少 robust futex 处理（set_robust_list 仅存储指针）
    - 无 PI futex（优先级继承）
- 实现细节：WaitFutex Future 在每次 poll 时检查组内是否仍包含当前任务，并检查 pending 信号，实现 ERESTARTSYS 语义。

### 4.6 资源管理
- 优点：
    - 物理页通过 FrameTracker 自动回收
    - 文件描述符表和地址空间在进程退出时清理
    - 共享内存支持 shmget/shmat/shmctl(IPC_RMID) 基本管理
- 缺点：
    - 缺少全局资源配额（如文件打开数限制仅记录但不强制）
    - 无 cgroup 或用户资源隔离
    - 网络 socket 缺少地址重用等资源回收细节
- 实现细节：shm 管理通过 PCB 内的 Vec<MapedSharedMemory> 跟踪，IPC_RMID 仅标记删除，待所有附加进程断开后清理。

### 4.7 时间管理
- 优点：
    - 提供 clock_gettime 支持单调时钟和实时时钟
    - nanosleep/clock_nanosleep 基于 Future 实现，可被信号中断
- 缺点：
    - 定时器精度受限于 10ms 周期 tick，高精度睡眠实际为忙碌轮询
    - setitimer 仅支持 ITIMER_REAL，且未与信号有效集成
    - 无 NTP 或时钟调整接口
- 实现细节：WaitUntilsec Future 在每次 poll 时检查当前时间是否达到目标，未达目标则 Pending。

### 4.8 系统信息
- 优点：
    - uname 伪装为 Linux 5.10.0-7-riscv64，兼容多数用户态工具
    - procfs 导出内存、挂载点、中断统计等基础信息
    - getrandom 提供伪随机数生成器
- 缺点：
    - UID/GID 均为存根（始终返回 0），无权限模型
    - 缺少 sysfs、cpuinfo 等更多系统信息接口
    - prlimit64 仅支持 RLIMIT_NOFILE 查询，无法设置
- 实现细节：getrandom 使用 LCG 线性同余生成器，非密码学安全。

## 五、动态测试设计与结果

### 5.1 测试环境
- 模拟器：QEMU (riscv64)
- 内核配置：ramfs 模式，无 ext4 块设备
- 硬件：VirtIO-blk、NS16550A UART、PLIC、Goldfish RTC

### 5.2 测试项目与结果

| 测试项 | 方法 | 结果 | 备注 |
|--------|------|------|------|
| 内核构建 | `cargo build -p kernel --target riscv64gc-unknown-none-elf --release` | 通过 | 生成 500KB 二进制 |
| 内核启动 | QEMU 运行，观察串口输出 | 通过 | 完整初始化，进入任务调度 |
| 内存初始化 | 内核日志显示 detected memory | 通过 | 正确识别约 990MB 可用内存 |
| 驱动加载 | 日志显示 FDT 解析和 VirtIO 探测 | 通过 | 25 个设备节点匹配 |
| 文件系统挂载 | 日志挂载点列表 | 通过 | ramfs、devfs、procfs 正确挂载 |
| initproc 任务执行 | initproc 代码执行并尝试启动 shell | 通过 | 按序探测 shell，全部失败后执行内置测试脚本 |
| ext4 块设备启动 | 加载预置磁盘镜像，引导 ext4 根 | 失败 | ext4_rs 中 desc_size=0 触发除零 panic |
| 异步调度器 | 观察 initproc 多任务调度 | 通过 | 任务轮转正常 |

### 5.3 未测试项目
- x86_64 / AArch64 / LoongArch64 架构构建与运行（编译工具链或 QEMU 命令限制）
- 网络功能测试（需特定 QEMU 网络配置）
- 多核场景（secondary hart 仅自旋，无法测试）
- 信号处理用户空间验证（未部署专用测试程序）

## 六、细则评价表格

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|----------------|----------|------|
| 内存管理 | 是，约60% | 位图帧分配器、Arc驱动的COW、延迟匿名页分配，但缺乏回收与交换 | 核心机制可用，COW设计优雅，但缺少高级内存管理，长时间运行有风险 |
| 进程管理 | 是，约70% | 完整进程生命周期（fork/clone/exec/wait）、动态链接ELF，但无优先级和job control | 支持复杂用户态应用，调度策略过于简单，缺乏资源控制 |
| 文件系统 | 是，约55% | 统一VFS，ramfs/devfs/procfs完整，ext4有已知bug，路径解析无缓存 | 多文件系统架构清晰，但持久化文件系统可靠性和性能不足 |
| 交互设计 | 部分，约40% | Tty设备可用但行规程简陋，无job control，shell支持限于简单命令 | 基本的用户交互可行，复杂终端应用和作业控制不可用 |
| 同步原语 | 是，约50% | spin锁、Futex基本可用，支持信号中断等待，但缺少robust和PI特性 | 满足简单并发需求，对复杂多线程库支持有限 |
| 资源管理 | 部分，约35% | 自动回收物理页、文件表清理，但无全局配额或cgroup，无权限模型 | 基础资源生命周期管理正确，缺少隔离与限制 |
| 时间管理 | 是，约50% | 时间获取和睡眠可用，10ms tick精度低，定时器支持有限 | 提供POSIX基础时钟，但高精度和复杂定时器需求无法满足 |
| 系统信息 | 部分，约40% | uname伪装Linux，procfs导出部分信息，getrandom非安全随机 | 足以欺骗简单工具，但不适合安全敏感应用，信息导出有限 |
| 网络 | 部分，约40% | TCP/UDP基本socket操作可用，但缺少IPv6、Unix socket、完整选项 | 简单网络通信可能工作，生产环境不可用 |
| 多核/调度 | 极低，约15% | Secondary harts仅自旋，单核FIFO调度 | 多核硬件未利用，调度无优先级，整体并发能力受限 |

## 七、总结评价

NCAIOS 是一个面向 RISC-V 架构的竞赛/教学型操作系统内核，在有限代码规模内实现了较为完整的类 POSIX 功能集。该项目展现了以下突出优点：全异步内核架构与 Rust 语言特性的创造性结合、编译期驱动自动注册、清晰的 VFS 分层、以及可实际运行动态链接用户程序的执行能力。

同时，项目存在明显的局限性：多核几乎未启用、ext4 存在缺陷、调度与资源管理机制简陋、网络栈不成熟、缺乏安全与隔离模型等。这些不足符合其竞赛背景，并不降低其作为学习范例和进一步研发基础的价值。

总体而言，NCAIOS 在实现完整性、设计新颖性和工程组织方面均达到了较高水准，是一个优秀的内核赛道作品，具备持续演进的潜力。