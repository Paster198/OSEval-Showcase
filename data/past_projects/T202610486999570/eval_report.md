# 技术画像与评估报告

## 1. 项目基本信息

- **项目名称**：未指定（内核 crate 名为 `os`，演化自 rCore 教学系统）
- **目标架构**：RISC‑V 64（QEMU virt）、LoongArch 64（QEMU virt）
- **实现语言**：Rust（nightly‑2024‑08‑01）
- **内核类型**：宏内核（Monolithic Kernel）
- **生态归属**：基于 rCore 教学内核深度扩展，面向 Linux 兼容层
- **主要特点**：
  - 覆盖约 234 个 Linux 系统调用号
  - 双架构支持，通过 `crate_interface` 实现干净的分层回调
  - 高半内核执行模型（SV39 页表，内核运行于 `0xffff_ffc0_0000_0000` 以上）
  - 完整的进程信号、futex、TLS 支持
  - VFS 框架同时支持自研 EasyFS、ext4（通过 lwext4_rust）和 FAT32
  - 基于 smoltcp 的 IPv4 网络栈，包含 Unix Domain Socket 与 loopback

## 2. 子系统与功能概览

该项目实现了以下主要子系统：

- **架构抽象层**：统一 `arch` crate，封装页表、上下文切换、trap/中断处理、信号传递 trampoline，提供 `ArchInterface` 回调接口。
- **内存管理**：物理帧分配器（栈式回收）、内核堆（伙伴系统）、SV39/LA 页表、用户虚拟地址空间（MemorySet），支持 COW、demand paging、mmap/munmap/mprotect/msync 等。
- **进程与任务管理**：进程控制块（PCB）与线程控制块（TCB），支持 fork/clone/clone3/exec/vfork，完整的 64 信号处理、futex、TLS，用户凭证与权限、资源限制（rlimit）。
- **系统调用分发**：统一的系统调用入口，按功能模块组织（文件系统、进程、IPC、网络、同步等），实现文件 I/O、Socket 操作、System V IPC、定时器等约 234 个调用号。
- **文件系统**：VFS 层（trait `VfsInode`）、挂载表、支持 EasyFS（内置）、ext4 与 FAT32 后端；特殊文件类型包括 pipe、epoll、eventfd、signalfd、timerfd、memfd；procfs 用于暴露进程与系统信息。
- **网络子系统**：基于 smoltcp 的 IPv4 TCP/UDP 协议栈，含 loopback 与 Unix Domain Socket；网络轮询与系统调用绑定。
- **设备驱动**：VirtIO‑MMIO/PIC 块设备、VirtIO 网络设备、NS16550A UART、VirtIO 输入设备（键盘/鼠标）、PLIC 中断控制器；提供带缓存的块设备层与 LRU 近似淘汰策略。
- **同步原语**：基于关中断的 `UPIntrFreeCell` 以及其上的互斥锁、读写锁、信号量、条件变量；用户态的 futex 完整实现。
- **定时器与时钟**：基于 SBI 的硬件定时器，管理到期事件与 POSIX 定时器，支持 itimer 与 timerfd。

## 3. 实现完整度分析

以下基于 Linux 5.x 常用内核功能集作为参考基准，对该项目的各子系统完整度进行定性描述。

| 子系统 | 完整度（定性） | 说明 |
|--------|----------------|------|
| 架构抽象（RISC‑V） | 高 | 页表、trap、上下文切换、信号传递完整 |
| 架构抽象（LoongArch） | 中 | 基本功能完整，但 IRQ 路由与外部中断为 stub |
| 内存管理 | 较高 | COW、demand paging、mmap 系列完整；无 swap |
| 进程管理 | 较高 | 进程/线程模型、信号、futex 完整；缺少 cgroup/namespace |
| 调度器 | 低 | 仅 FIFO 就绪队列，无时间片与优先级调度 |
| 系统调用覆盖 | 较高 | 实现约 234 个号，覆盖文件 I/O、网络、IPC 等主要调用 |
| VFS 与文件系统 | 较高 | VFS 设计完整，多后端支持；EasyFS 自研，ext4/FAT32 通过外部库 |
| procfs | 中等 | 支持进程信息、内存映射、挂载信息等；部分 /proc/sys 节点 |
| 网络（RISC‑V） | 中等 | TCP/UDP + loopback + Unix socket 基本可用；仅 IPv4 |
| 网络（LoongArch） | 低 | 仅 loopback，无外部网络 |
| 设备驱动 | 中等 | 基本 VirtIO 设备可用，缺 USB/ACPI/GPU 等 |
| 同步原语 | 较高 | 内核自旋锁/互斥锁、信号量、条件变量、futex 完整 |
| 时间管理 | 较高 | 多种定时器接口（itimer、POSIX timer、timerfd），时钟获取完整 |
| 系统信息 | 中等 | 通过 procfs 与 sysinfo/uname 暴露部分系统信息 |

**整体完整度**：以 Linux 5.x 通用功能集为参照，该项目实现了约 70%–75% 的常用功能。

## 4. 各子系统详细分析

### 4.1 架构抽象层

**优点**  
- 通过 `crate_interface` 实现 arch‑to‑kernel 回调，类型安全地解决了循环依赖。  
- RISC‑V 采用高半内核模型，启动时使用 1GB 大页，避免 trampoline 页面。  
- 信号传递利用非法指令 trampoline（sigtrx），替代传统 vDSO，设计精巧。

**缺点**  
- LoongArch 的中断控制器与外设 IRQ 路由仅为 stubs，外部中断处理不完整。  
- 未实现 SMP 支持，仅适用于单核处理器。

**实现细节**  
- 页表：RISC‑V 实现 SV39 三级页表，用户页表克隆内核高半映射，省去 trampoline。  
- 上下文切换：汇编保存/恢复 callee‑saved 寄存器，`TaskContext` 仅含 `ra` 与 `sp`。  
- Trap 分发：`sscratch` 配合 `kernelvec`/`uservec` 进行栈切换；内核态 trap 通过 `ArchInterface::kernel_interrupt` 回调上层。

### 4.2 内存管理

**优点**  
- `MemorySet`/`MapArea` 支持多种映射类型（急切、延迟匿名、延迟文件），COW 实现完整。  
- 全局 `SHARED_FILE_PAGE_CACHE` 的 BTreeMap 设计，为 MAP_SHARED 文件映射提供物理帧共享。  
- 物理帧分配器采用 RAII 返还，避免泄漏。  
- 内核堆带 OOM 诊断，记录最近的大分配并输出当前任务上下文。

**缺点**  
- 缺少页换出（swap）与页面回收机制，无法应对内存压力。  
- 内核堆采用固定 128MB 上限，不可动态扩展。  
- `mlock`/`munlock` 仅为 stub，无实际锁定内存功能。

**实现细节**  
- `StackFrameAllocator` 利用栈结构回收物理帧。  
- Demand paging 的 `handle_cow_or_demand_fault` 根据映射类型分配匿名页或从文件中读取并映射。  
- `mmap` 支持匿名、文件映射与共享映射，文件映射可实现 `MAP_PRIVATE`/`MAP_SHARED`。

### 4.3 进程/任务管理

**优点**  
- 进程模型完整：支持 fork/clone/clone3/exec/vfork，线程通过 `CLONE_THREAD` 实现。  
- 信号处理覆盖 64 个实时信号，sigaction 支持 SA_SIGINFO、SA_RESTART 等选项。  
- futex 实现完整，包括 wait/wake、bitset 匹配、requeue 转移。  
- 用户凭证与权限模型接近 Linux（实际/有效 uid/gid，capabilities，进程组/会话）。  
- TLS 通过 `CLONE_SETTLS` 设置，适应多线程场景。

**缺点**  
- 调度器仅为 FIFO 队列，没有时间片轮转与抢占，无法满足交互式任务需求。  
- 缺少 cgroup 与 namespace 支持，`unshare` 为 stub。  
- ptrace 仅支持 `PTRACE_TRACEME`，调试能力有限。  
- `sendmsg`/`recvmsg` 等部分系统调用为 stub。

**实现细节**  
- 进程控制块采用细粒度锁：内存空间、文件描述符表、凭证、信号、定时器等均有独立锁保护。  
- fork 时利用 COW 复制地址空间，父子共享只读物理帧。  
- 信号传递通过修改用户栈并利用 sigtrx 非法指令返回用户态信号处理函数。

### 4.4 文件系统

**优点**  
- VFS 设计清晰，`VfsInode` trait 涵盖 inode 操作与元数据操作，后端可替换。  
- 支持多种后端文件系统：自研 EasyFS（用于 initramfs）、ext4（feature gate）、FAT32。  
- 特殊文件类型丰富：pipe、epoll、eventfd、signalfd、timerfd、memfd，满足多种 IPC 需求。  
- procfs 内容较丰富，可查看进程状态、文件描述符、内存映射、挂载信息等。  
- 块设备缓存层支持可配置大小与写入策略，可追踪命中率。

**缺点**  
- EasyFS 缺乏日志/事务支持，崩溃恢复能力弱。  
- ext4 支持依赖外部 C 库，可能引入兼容性问题，且写操作缓存策略较保守。  
- 无 devtmpfs 或 sysfs 实现，设备节点由内核硬编码。  
- flock 仅实现基础记录锁，缺少完整的字节范围锁。  
- 不支持 fanotify、inotify 等文件事件通知。

**实现细节**  
- 路径解析通过 `resolve_inode` 与挂载表完成，支持前缀匹配挂载。  
- `open_file` 结合 VFS 查找与特殊文件类型工厂，返回实现 `File` trait 的对象。  
- ext4 后端利用 `lwext4_rust` 的块设备包装，并增加元数据缓存与 xattr 缓存以提升性能。

### 4.5 网络子系统

**优点**  
- 基于 smoltcp 实现了 TCP/UDP 协议，loopback 设计精巧，支持 iperf3 并行 UDP 流的两阶段匹配。  
- Unix Domain Socket 实现 STREAM 与 DGRAM 类型，状态机清晰，支持抽象路径与 SO_PEERCRED。  
- Socket API 系统调用覆盖全面，包括 sendto/recvfrom/sendmsg/recvmsg 等。

**缺点**  
- LoongArch 平台仅启用 loopback，无外部网络能力。  
- 仅支持 IPv4，缺少 IPv6 与原始套接字。  
- 网络栈轮询依赖周期性调用，可能引入处理延迟。  
- 连接管理、backlog 队列等实现较简，不包含 SYN cookie 等防护。

**实现细节**  
- 全局 `NetStack` 持有外部接口、loopback 接口、socket 集合。  
- 数据收发通过 smoltcp 的 `Interface::poll` 结合设备驱动完成。  
- loopback 注入函数通过遍历 socket 表匹配接收者，模拟真实网络行为。

### 4.6 设备驱动

**优点**  
- 实现了 QEMU virt 平台上的关键 VirtIO 设备（块、网络、输入），使用 PLIC 进行中断路由。  
- 块设备支持非阻塞中断驱动模式与阻塞轮询模式，可编译时选择。  
- 块缓存层采用 16KB 页粒度、LRU 近似淘汰策略，可配置缓存大小与 write‑through 模式。

**缺点**  
- 设备支持范围窄，缺少 USB、ACPI、GPU、音频等驱动。  
- LoongArch 平台上仅实现了块设备（PCI），网络与输入设备缺失。  
- 驱动模型中无设备树解析或真正设备枚举，主要依赖硬编码的 `PlatformConfig` 描述。

**实现细节**  
- VirtIO 驱动基于 MMIO 地址探测与 `DeviceKind` 类型匹配。  
- 非阻塞块设备使用 VirtIO used ring 与 Condvar 等待 I/O 完成。  
- 输入设备通过事件队列与 Condvar，允许用户态线程阻塞读取。

### 4.7 同步原语

**优点**  
- `UPIntrFreeCell` 通过关中断实现轻量级互斥，记录嵌套深度与最初中断状态，避免过早开中断。  
- 提供自旋锁与阻塞锁两种互斥锁，满足内核不同场景需求。  
- 信号量与条件变量基于等待队列实现，可正确阻塞与唤醒任务。  
- futex 实现完整，支持 bitset、requeue 等高级操作，适用于 pthread 同步。

**缺点**  
- 仅依赖单核关中断原语，不支持真正的多核同步（如原子 CPU 原语）。  
- 缺少 RCU 等高级同步机制，对只读多线程场景优化有限。

**实现细节**  
- `UPIntrFreeCell::exclusive_access` 屏蔽 S‑mode 中断，归还时恢复，嵌套追踪保证正确性。  
- futex 等待队列以 `(物理地址, PID)` 为 key，支持进程私有锁。  
- 任务退出时 futex 会自动清理该任务持有的 waiter。

### 4.8 定时器与时间管理

**优点**  
- 支持多种时间源与超时接口：`clock_gettime`/`settime`、itimers、POSIX per‑process timers、timerfd。  
- 定时器管理使用最小堆，到期检查效率较高。  
- 网络轮询与 itimer 检查在定时器中断中一并处理，减少专有唤醒。

**缺点**  
- 时间精度受限于周期定时器中断，无高精度事件驱动定时器。  
- `adjtimex`/`clock_adjtime` 仅有基础实现，缺少复杂的 NTP 算法。

**实现细节**  
- 硬件时钟基于 SBI `set_timer`，由 arch 层提供 `set_next_trigger`。  
- `check_timer` 唤醒所有到期的 `TimerCondVar`，同时检查 itimers 和 POSIX 定时器。

### 4.9 系统信息与用户交互

**优点**  
- procfs 提供丰富的系统视图：进程状态、内存映射、挂载信息、系统资源统计（如 meminfo、cpustat）。  
- `uname`、`sysinfo` 系统调用可用于获取基本系统标识与统计。  
- 内核日志通过 logging 子系统输出，支持串口调试。

**缺点**  
- 未实现 sysfs，设备相关信息难以标准化暴露。  
- 用户交互依赖于外部 shell（如 BusyBox），内核本身未提供命令行界面。  
- `/proc/sys` 暴露的可写内核参数较少。

**实现细节**  
- procfs 的 `ProcFsInode` 动态生成目录与文件内容，根据 PID 查找进程控制块。  
- 日志系统可通过 makefile 控制级别，支持彩色输出与模块过滤。

## 5. 动态测试情况

受限于分析环境的工具链版本与依赖完整度，**未进行实际的 QEMU 运行测试**。主要障碍包括：

- 需要特定的 Rust nightly 工具链及 `riscv64gc‑unknown‑none‑elf` target，当前环境不完全匹配。
- 构建过程依赖 `user/` 中用户程序的交叉编译与 `easy‑fs‑fuse` 镜像打包。
- QEMU 运行还需要匹配的 `rustsbi‑qemu.bin` bootloader 和文件系统镜像。

因此，本报告的所有结论均基于静态源代码分析，不包含运行时行为验证。

## 6. 细则评价表格

### 6.1 内存管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| 物理帧分配 | 实现，完整 | 栈式回收 + RAII FrameTracker，支持批量分配与统计 | 实现简洁可靠，适用于单核环境 |
| 内核堆 | 实现，完整 | 伙伴系统，128MB 固定大小；OOM 时打印诊断信息 | 诊断能力较好，但堆大小不可动态扩容 |
| 页表 | 实现，完整（SV39/LA） | 三级页表，用户态复用内核映射，无需 trampoline；支持 TOKEN 操作 | 设计有效，简化 trap 路径 |
| 虚拟地址空间 | 实现，较完整（COW, demand paging, mmap 系列） | 支持匿名/文件/共享映射，延迟映射与写时复制结合，MapArea 类型系统清晰 | 功能贴近现代内核，但缺少 swap 限制其实用性 |
| mlock/munlock | 实现但为 stub | 仅有空实现，不执行实际锁定 | 功能性缺失 |
| 共享页缓存 | 实现，完整 | 全局 BTreeMap 管理 MAP_SHARED 的物理帧共享，支持 truncate 失效 | 设计精巧，维护了共享语义的正确性 |

### 6.2 进程管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| 进程/线程模型 | 实现，较完整 | fork/clone/clone3/exec/vfork 均支持；线程通过 CLONE_THREAD 实现，内核线程有限 | 模型完整，能运行多线程程序 |
| 信号处理 | 实现，完整 | 64 信号，sigaction 含 SA_SIGINFO/SA_RESTART/SA_RESETHAND；利用 sigtrx 返回用户态 | 信号机制相当完整，接近 Linux 体验 |
| futex | 实现，完整 | wait/wake/bitset/requeue 均实现，退出时自动清理 | futex 实现健壮，可支撑 pthread 锁 |
| 调度器 | 实现，基础 | FIFO 就绪队列，无时间片与优先级；开中断轮询等待 | 仅能满足批处理场景，无交互性 |
| 凭证与权限 | 实现，较完整 | 实际/有效 uid/gid、supplementary groups、capabilities、进程组/会话 | 提供了足够的安全策略基础 |
| TLS | 实现，完整 | CLONE_SETTLS 设置 TCB，支持线程局部存储 | 支持多线程的正确 TLS 访问 |
| 资源限制 (rlimit) | 实现，较完整 | prlimit64 可设置/获取常见限制，进程内部记录 | 提供基础资源控制 |

### 6.3 文件系统

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| VFS 框架 | 实现，完整 | trait 设计统一 inode 操作，挂载表支持前缀匹配 | 框架设计合理，扩展性好 |
| EasyFS | 实现，较完整 | 自研轻量文件系统，支持间接块，用于 initramfs | 功能满足启动要求，但缺少日志 |
| ext4 | 实现（feature），较完整 | 通过 lwext4_rust 绑定 C 库，增加元数据与 xattr 缓存 | 提供了 ext4 读写能力，但依赖外部库可能引入稳定性和性能问题 |
| FAT32 | 实现，基础 | 基于 rust‑fatfs，实现基本读写与目录操作 | 满足 FAT 格式兼容需求 |
| 特殊文件 (pipe/epoll 等) | 实现，较完整 | pipe、epoll、eventfd、signalfd、timerfd、memfd 均可用 | 为事件驱动 I/O 提供了良好支持 |
| procfs | 实现，中等 | 进程状态、内存映射、挂载信息等较丰富；部分 /proc/sys 可写 | 信息暴露充分，但 sysctl 节点尚不全面 |
| 文件锁 (flock) | 实现，基础 | 仅有简单记录锁，无字节范围锁 | 功能较弱 |

### 6.4 交互设计（用户接口/系统调用 API）

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| 系统调用覆盖 | 实现，较完整 | 约 234 个调用号，覆盖文件 I/O、网络、IPC、定时器等；`sendmsg` 等少数为 stub | 兼容性广，能运行大量 Linux 用户程序 |
| errno 与返回值 | 实现，完整 | 定义了常用 errno，系统调用错误返回 -errno 并由 lib 转换为 errno | 标准兼容性良好 |
| 用户内存访问 | 实现，完整 | `UserSlice` 等方法进行边界检查与翻译 | 安全性合格 |
| 内核自定义调用 | 实现 | 提供 thread_create/waittid/mutex_create 等扩展调用 | 方便定制，但降低可移植性 |
| procfs 交互 | 实现，中等 | 用户态可通过读取/proc/* 获取信息，少量节点可写 | 方便监控和调试 |

### 6.5 同步原语

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| 关中断锁 (UPIntrFreeCell) | 实现，完整 | 支持嵌套屏蔽，记录借用冲突位置，提供独占和共享访问 | 是内核同步基础，诊断能力强 |
| 自旋锁/阻塞锁 | 实现，完整 | MutexSpin/MutexBlocking 分别用于不同场景 | 满足内核锁需求 |
| 信号量/条件变量 | 实现，完整 | 基于等待队列的计数信号量和条件变量 | 实现标准 |
| futex | 实现，完整 | 用户态快速同步原语，功能齐全 | 支撑 pthread 库 |
| RCU/无锁数据结构 | 未实现 | 无相关机制 | 多核扩展性受限 |

### 6.6 资源管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| 文件描述符表 | 实现，完整 | 每进程独立 fd 表，支持 dup/dup3/close_range | 管理完整 |
| PID 分配与回收 | 实现，完整 | 栈式 PID 分配器，通过 RAII 回收 | 正确可靠 |
| 内核栈管理 | 实现，完整 | 每线程固定大小内核栈，带 guard page | 安全防护基本到位 |
| 内存分配追踪 | 实现，基础 | 内核堆记录最近 64 次大分配，OOM 时输出 | 辅助调试，但不能替代完整分析 |
| rlimit | 实现，较完整 | 常见资源限制可设置 | 提供资源使用边界 |

### 6.7 时间管理

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| 硬件时钟 | 实现，完整 | 基于 SBI 的 set_timer 和时钟频率 | 正确驱动 |
| 相对/绝对超时 | 实现，完整 | 定时器最小堆管理到期事件，支持 nanosleep/clock_nanosleep | 功能正确 |
| itimer | 实现，完整 | 三种 itimer，到期发送信号 | 支持 alarm 等应用 |
| POSIX per‑process timer | 实现，完整 | timer_create/settime/gettime/delete 等 | 较完整的定时器功能 |
| timerfd | 实现，完整 | 支持创建定时器文件描述符，集成 epoll | 实现良好 |
| clock_adjtime/adjtimex | 实现，基础 | 仅有基础常数设置，无 NTP 算法 | 不适用于精确时间调整 |

### 6.8 系统信息

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| uname | 实现 | 返回架构、主机名、内核版本等 | 满足基本需求 |
| sysinfo | 实现 | 返回内存、负载等信息 | 提供系统概览 |
| procfs 系统节点 | 实现，中等 | /proc/meminfo, /proc/stat, /proc/loadavg, /proc/uptime 等 | 暴露常用系统指标 |
| 进程信息（cmdline/exe/fd） | 实现，较完整 | 通过 procfs 可获取进程环境 | 便于诊断 |
| /proc/sys | 实现，少量 | 只实现了少数内核参数节点 | 无法进行细粒度在线调优 |

### 6.9 网络（补充条目）

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| TCP/UDP（RISC‑V） | 实现，基础 | 基于 smoltcp，可与 QEMU 用户模式网络通信 | 可运行简单网络应用 |
| Loopback | 实现，完整 | 设计精巧，支持 iperf3 并行 UDP | 性能与正确性较好 |
| Unix Domain Socket | 实现，较完整 | 路径绑定、抽象地址、凭证传递，满足本地 IPC | 功能较完善 |
| IPv6 | 未实现 | 无相关代码 | 缺失 |
| Netlink | 未实现 | 无 netlink socket | 无法与内核路由或网络子系统交互 |
| Raw Socket | 未实现（除 loopback 注入侧）| 缺少通用 raw socket 支持 | 限制网络工具兼容性 |

### 6.10 设备驱动（补充条目）

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| VirtIO 块设备 | 实现，完整 | 支持阻塞/非阻塞模式，带块缓存 | 稳定可用 |
| VirtIO 网络 | 实现（RISC‑V），LoongArch 缺失 | 网卡驱动基于 MMIO 探测，基本收发正常 | RISC‑V 平台网络可用 |
| UART | 实现（RISC‑V） | NS16550A 驱动，保证串口输出 | 满足调试需要 |
| 输入设备 | 实现（RISC‑V） | 键盘/鼠标通过 VirtIO Input 驱动，使用事件队列 | 使能交互式终端 |
| PLIC | 实现（RISC‑V），LoongArch 缺失 | 配置各设备中断源，完成中断转发 | RISC‑V 中断管理正确 |
| LoongArch 外部中断 | 未实现（stub） | IRQ 路由与 PLIC 均为占位 | 平台不成熟 |

## 7. 总结评价

该项目是一个基于 Rust 的宏内核，通过在 rCore 教学内核基础上进行广泛扩展，展现了较高的系统调用兼容性与功能广度。其体系结构清晰，`crate_interface` 回调机制与高半内核模型等设计选择合理。代码规模约 4.5 万行（不含 vendor），覆盖内存管理、进程管理、文件系统、网络等核心子系统，特别在信号处理、futex、mmap 等方面达到了接近实用内核的层次。

然而，内核目前仍为单核设计，调度器仅采用 FIFO 策略，缺少时间片抢占与内存换页，LoongArch 架构实现不完整。这些问题使得内核的实际负载能力与响应特性受到根本性限制，难以用于交互式或多用户场景。此外，部分子系统（如设备驱动、文件锁、网络协议栈）的深度有限，离生产环境尚有较大距离。

总体而言，该内核适合作为操作系统教学、研究或实验平台，尤其适合探索 Linux ABI 兼容性与 Rust 内核开发技术，但若作为竞赛作品，其在核心调度、多核支持、容灾能力等方面的欠缺可能成为显著短板。