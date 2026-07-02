# UESTC OS Kernel 2026 — 技术画像与评估报告

## 项目基本信息

| 属性 | 内容 |
|------|------|
| **项目名称** | UESTC OS Kernel 2026 |
| **架构支持** | RISC-V 64（主力）、LoongArch 64（主力）、x86_64（部分移植）、AArch64（部分移植） |
| **实现语言** | Rust |
| **代码规模** | 约 40,500 行（不含 vendor 及 ext4_rs-1.3.1 外部 crate） |
| **生态归属** | 基于 RustOsWhu 二次开发，集成 ext4_rs、lose-net-stack、virtio-drivers(rcore-os fork) 等外部组件 |
| **构建状态** | RISC-V 64 release 构建成功（63秒），产物 os.bin 大小 1009K |
| **核心特点** | crate_interface 解耦的 HAL 层、双架构（RISC-V/LA）完整支持、VFS 多文件系统分层架构、独立 TCP/IP 协议栈、130+ 系统调用 |

---

## 子系统及功能实现概况

| 子系统 | 已实现功能 | 未实现/不完整部分 |
|--------|-----------|------------------|
| **进程管理** | TCB 含 30+ 字段、fork/clone(完整 CloneFlags)/execve(含动态链接器)/waitpid(WSTOPPED/WNOHANG)/exit_group、FIFO 调度、33种信号+信号队列+sigaction+信号掩码、Futex(含 bitset/requeue)、间隔定时器(setitimer)、prctl(NAME/PDEATHSIG)、set_tid_address、robust_list | 无进程组/会话管理、无优先级调度/CFS、无 cgroup |
| **内存管理** | Sv39/LA64 三级页表、伙伴系统堆分配器(80MB)、栈式页帧分配器(FrameTracker RAII)、COW(引用计数触发复制)、懒分配(页错误时按需映射)、mmap(MAP_ANONYMOUS/PRIVATE/SHARED/FIXED)/munmap/mprotect/mremap/brk、共享内存(shmget/shmat) | 无 NUMA 支持、无大页支持、无页面回收/交换、无 KSM |
| **文件系统(VFS)** | Dentry/Inode/File/SuperBlock 四层抽象、ext4 读写（基于 ext4_rs 引擎，含 extent 树）、devfs(null/zero/urandom/tty/rtc)、procfs(meminfo/mounts/exe)、tmpfs（基于 memfs）、LRU 块缓存(512B)、路径解析(含挂载点遍历) | ext4 日志(journal)未完整支持、无磁盘配额 |
| **网络子系统** | ARP 协议(表查询/缓存)、IP 数据包构造、TCP 三次握手+序列号/确认号跟踪+连接状态机(5状态)+窗口管理、UDP 简化实现、校验和计算、Socket trait 统一接口、socket/bind/listen/accept/connect/sendto/recvfrom/setsockopt 系统调用 | **物理驱动为空桩**，网络协议栈无法实际收发数据；无 IPv6、无 ICMP 完整实现、无 TCP 拥塞控制 |
| **设备驱动** | VirtIO 框架(MMIO/PCI)、virtio-blk(完整接入块设备层)、virtio-console、PLIC 中断控制器 | virtio-net 驱动存在但内核接入为空桩、virtio-gpu/input/socket 未接入 |
| **时间管理** | BinaryHeap 定时器管理、Futex 超时唤醒、clock_gettime/nanosleep/clock_nanosleep、setitimer、timerfd_create/settime/gettime | 无高精度定时器、无 tickless 模式 |
| **同步原语** | 基于 spin::Mutex 的自旋锁（UP 适用） | 无 SMP 支持（无 RCU、无 per-CPU 锁、无 MCS 锁） |
| **系统调用** | 约 130+ 个，覆盖进程/内存/文件/信号/网络/时间/系统信息/共享内存/epoll/eventfd/signalfd/timerfd/pipe | 部分系统调用为 ENOSYS 存根（如 ptrace、ioprio、capget/capset） |

---

## 各子系统实现完整度与实现细节

### 进程管理子系统

**完整度**：约 85%（POSIX 进程管理核心功能基本完整，缺少进程组与会话管理）

**优点**：
- TCB 结构覆盖 Linux 任务控制块的主要字段（含信号处理、Futex、间隔定时器、线程名、退出码、父进程死亡信号等），设计完整。
- 信号子系统实现了完整的 POSIX 信号处理流程：33种信号支持、信号队列按发送顺序存储、sigaction 结构体区分 RISC-V 与 LoongArch 布局差异、信号处理中通过 TrapFrame 备份实现上下文保存/恢复、sigreturn 蹦床使用静态页表映射避免每个进程单独映射。
- Futex 实现使用基于物理地址 + PID 的 `FutexKey` 进行唯一标识，避免跨地址空间的虚拟地址碰撞，支持 wait/wake/bitset/requeue 四种操作。
- clone 系统调用支持完整的 `CloneFlags`（VM/FS/FILES/SIGHAND/THREAD/SETTLS/CHILD_CLEARTID/PARENT_SETTID 等），满足 pthread 创建需求。
- execve 支持动态链接器（ld.so）加载，通过 `DL_INTERP_OFFSET = 0x15_0000_0000` 固定映射解释器。

**缺点**：
- 调度器仅为基于 `VecDeque` 的 FIFO 时间片轮转，无优先级区分，无法满足实时性需求。
- 缺少进程组（PGID）和会话（SID）管理，影响 shell 作业控制和终端信号分发。
- 等待队列仅用于 Futex，未扩展用于通用阻塞等待（如 pipe/套接字读写阻塞）。

**实现细节**：
- 上下文切换路径：`suspend_current_and_run_next()` → `schedule()` 从 `ready_queue` 头部取任务 → `context_switch_pt(from, to, page_table_token)` 同时切换内核上下文（callee-saved 寄存器）和用户页表（写 satp 寄存器 + sfence.vma）。
- PID/TID 管理使用 `PID2TCB`（BTreeMap）+ `TidAllocator` 分配唯一标识符。

---

### 内存管理子系统

**完整度**：约 80%（核心虚拟内存管理完整，缺少页面回收/交换及 NUMA 支持）

**优点**：
- Sv39 页表实现完整，PTE 标志位支持标准 RISC-V 位（V/R/W/X/U/G/A/D）及自定义 COW 标志（bit 8），同时条件编译支持 T-HEAD C906 扩展。
- COW 实现逻辑清晰：`handle_cow_addr()` 检测 COW 标志及页帧引用计数，若引用计数 >1 则分配新物理页、复制内容并重新映射为可写，触发 COW 断点后原页帧引用计数递减。
- 懒分配在页错误的 `handle_lazy_addr()` 中按需分配零填充物理页，支持 Heap 和 Mmap 区域。
- MemorySet 通过 `MapAreaType` 区分 Heap/Stack/Mmap/Shm 四种区域类型，布局清晰。
- 共享内存通过 `add_shm_area()` 将同一组物理页帧映射到多个进程的地址空间，页帧使用引用计数管理生命周期。
- LoongArch 64 页表同样完整，支持 PLV 权限级别控制、TLB 刷新使用 `invtlb` 指令，且实现了独立的 TLB refill 异常处理路径（使用 `lddir`/`ldpte` 指令加速）。

**缺点**：
- 无页面回收机制（无 LRU 页面链表、无 kswapd），在内存压力下无法回收页面。
- 无与磁盘的页面交换（swap），无法支持超出物理内存的虚拟内存总量。
- 堆分配器基于外部 `buddy_system_allocator` crate，未针对内核场景优化（如 DMA 区域、冷热页分离）。
- 无大页（HugeTLB）支持，TLB 覆盖率受限。

**实现细节**：
- `FrameTracker` 采用 RAII 模式：分配时从 `StackFrameAllocator.recycled` 弹出空闲页帧，drop 时自动 push 回去。`frame_alloc_persist()` 用于页表等持久分配，返回的 `PhysPage` 不会被自动回收。
- 用户内存布局：`USER_STACK_TOP = 0x13_0000_0000`，`USER_MMAP_TOP = 0x11_0000_0000`，动态链接器映射至 `0x15_0000_0000`。

---

### 文件系统（VFS）子系统

**完整度**：约 78%（VFS 抽象层与多文件系统支持完整，ext4 日志支持不完整）

**优点**：
- VFS 四层抽象（SuperBlock/Inode/Dentry/File）通过 trait object 实现多态，支持 `downcast_arc` 向下转型，设计清晰。
- Dentry 维护父子关系（BTreeMap 子节点索引），状态机包含 Invalid/Valid/Dirty 三态，具备基本的一致性保证。
- 全局 dentry cache（`DENTRY_CACHE_MANAGER`）减少重复查找。
- 文件系统挂载系统支持层级挂载：ext4 挂载到 `/` → devfs 挂载到 `/dev` → procfs 挂载到 `/proc` → tmpfs 挂载到 `/tmp`。
- ext4 采用双层架构：VFS 适配层（500 行）与 ext4_rs 引擎（6,618 行）分离，引擎独立可维护。引擎包含超级块解析、块组描述符、inode 分配/释放、extent 树操作、目录项搜索/创建/删除及 CRC 校验。
- 块缓存（buffer crate）基于 LRU 策略，Drop 时自动写回脏块，减少上层对同步的显式关注。
- 特殊文件系统辅助类型丰富：epoll（完整的事件轮询与兴趣列表）、eventfd、signalfd、timerfd、pipe、stdio。

**缺点**：
- ext4 日志（journal）未完整支持，异常断电可能导致文件系统不一致。
- 无文件锁（flock/fcntl 文件锁）实现，多进程文件并发访问安全性不足。
- 块缓存大小固定为 512B，未适配 4K 块设备。
- 路径解析无符号链接循环检测（可能导致无限递归挂起）。

**实现细节**：
- `Ext4Disk` 包装 `Arc<dyn BlockDevice>` 实现 ext4_rs 的 `BlockDevice` trait，桥接内核块设备层与 ext4 引擎。
- 块设备同步通过 `buffer::block_cache_sync_all()` 在执行 `sync/fsync` 系统调用时触发。

---

### 网络子系统

**完整度**：约 45%（协议栈代码完整但物理驱动缺失，实际功能不可用）

**优点**：
- lose-net-stack 独立实现了 ARP 协议（含 ARP 表缓存查询、ARP 请求构造与响应处理）、IP 数据包构造、TCP 状态机（Unconnected/WaitingForSynAck/WaitingForData/WaitingForFinAck/Closed 五状态）、序列号/确认号跟踪及窗口管理、UDP 简化实现。
- TCP 三次握手完整（SYN → SYN-ACK → ACK），连接管理通过 `TcpServer` + `TcpConnection` 分离监听套接字与已连接套接字。
- 套接字通过 `SocketInterface` trait 统一 TCP/UDP 接口，并通过实现 `vfs_defs::File` trait 将其纳入文件描述符体系。
- 网络层系统调用覆盖完整（socket/bind/listen/accept/connect/sendto/recvfrom/sendmsg/setsockopt/getsockopt/shutdown/getsockname/getpeername）。

**缺点**：
- **关键缺陷**：`os/src/drivers/net.rs` 中的 `NetDevice::recv()` 和 `NetDevice::send()` 为空桩实现（返回 `Ok(0)`），实际的 VirtIO-net 硬件收发初始化代码已被注释。这导致网络协议栈代码完整但完全无法与外界通信。
- 无 IPv6 支持。
- TCP 无拥塞控制（Slow Start/Congestion Avoidance/Fast Retransmit/Fast Recovery），仅有基本窗口管理。
- 无完整的 socket 选项支持（SO_REUSEADDR/SO_KEEPALIVE/TCP_NODELAY 等存根处理）。

**实现细节**：
- `NET_SERVER` 全局实例硬编码 MAC 地址 `52:54:00:12:34:56` 及 IP 地址 `10.0.2.15`。
- `create_socket_pair()` 用于 `socketpair()` 系统调用，创建本地互联的 TCP 套接字对。

---

### 设备驱动子系统

**完整度**：约 45%（框架完整但仅块设备实际接入使用）

**优点**：
- VirtIO 驱动框架 fork 自 rcore-os，支持 MMIO 和 PCI 两种传输层，通过 `VirtioHal` trait 适配内核的物理内存访问方式。
- virtio-blk 驱动完整接入块设备层，作为 ext4 的下层存储。
- RISC-V 平台中断控制器 PLIC 驱动完整，管理 VirtIO 设备中断分发。

**缺点**：
- virtio-net 驱动代码存在（在 virtio-drivers crate 中）但内核接入层（`os/src/drivers/net.rs`）为空桩，实际未启用。
- virtio-gpu、virtio-input、virtio-socket 驱动存在于 virtio-drivers crate 但未在内核中接入使用。
- 无设备树（Device Tree）动态设备发现，设备初始化依赖硬编码。

---

### 时间管理子系统

**完整度**：约 65%（基本定时功能完整，但精度和效率受限）

**优点**：
- 基于 `BinaryHeap`（最小堆）的定时器管理，支持 Futex 超时和 StoppedTask 定时器。
- 每次时钟中断时调用 `check_futex_timer()` 遍历堆顶超时定时器并唤醒对应等待者。
- 系统调用覆盖较好：`nanosleep`、`clock_gettime`、`clock_nanosleep`、`gettimeofday`、`times`、`setitimer`、`timerfd` 系列。

**缺点**：
- 无高精度定时器（hrtimer），时钟粒度受限于 tick 频率。
- 无 tickless（NO_HZ）模式，空闲时仍保持周期性时钟中断，功耗效率低。
- `times` 系统调用的时间统计（`TCBTms`）仅在时钟中断时更新，精度为 tick 级。

---

### 同步原语

**完整度**：约 35%（UP 环境可用，SMP 环境受限）

**优点**：
- 基于 `spin::Mutex` 的自旋锁适配单核 Rust 内核场景，使用简单。
- Futex 为进程间同步提供了用户空间高效的同步机制。

**缺点**：
- 无 SMP 支持所需的同步机制：无 RCU（Read-Copy-Update）、无 per-CPU 数据结构锁、无 MCS 锁等可扩展自旋锁。
- 无读写锁（RwLock）、无顺序锁（seqlock）。
- 全局 `FUTEX_Q: BTreeMap` 使用自旋锁保护，在多核竞争下可扩展性差。

---

## 动态测试设计

### 测试框架

项目未包含自动化测试框架（无 Rust `#[test]` 或集成测试代码）。用户程序（`user/src/` 下 28 个用户程序）可作为系统调用功能测试的手动用例。

### 建议测试方案

由于当前环境受限（缺少 ext4 文件系统镜像制作工具及完整 QEMU 启动链），本次评估未进行动态测试。以下是基于代码分析的关键功能测试建议：

| 测试类别 | 测试内容 | 验证目标 |
|----------|---------|---------|
| **进程创建** | fork/execve 后子进程正确继承 fd 表和信号处理设置 | 进程管理、fd 表继承 |
| **信号处理** | 发送 SIGUSR1 → 自定义处理函数执行 → sigreturn 恢复原执行流 | 信号处理完整性 |
| **Futex** | 多进程 Futex wait/wake 正确同步 | Futex 实现正确性 |
| **COW 内存** | fork 后父子进程写入同一页 → 触发 COW → 各自拥有独立物理页 | COW 机制验证 |
| **mmap** | mmap MAP_SHARED 映射同一文件 → 一进程写入，另一进程可见 | 共享映射一致性 |
| **ext4 读写** | 创建文件 → 写入数据 → 关闭 → 重新打开读取 → 数据一致 | ext4 持久化正确性 |
| **管道通信** | pipe 创建 → 写端写入 → 读端读取 → 数据一致 | 管道缓冲区管理 |
| **epoll** | epoll 监听多个 fd → fd 就绪时正确返回 | epoll 事件通知 |
| **TCP 收发** | （需要网络驱动启用后）socket → connect → send → recv | 网络协议栈 |

---

## 细则评价表格

### 内存管理

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已实现，约 80% |
| **关键发现** | 1. 页帧分配器使用 RAII FrameTracker，自动回收机制降低内存泄漏风险。<br>2. COW 实现通过引用计数（>1 触发复制）判断共享状态，逻辑正确。<br>3. 懒分配在页错误时按需分配零填充页，避免 fork 时的不必要复制。<br>4. LoongArch TLB refill 异常独立路径使用 `lddir`/`ldpte` 指令加速，是架构特性的有效利用。 |
| **评价** | 核心虚拟内存管理完整，COW、懒分配、共享内存均实现。缺失的页面回收与交换限制了在内存受限场景下的适用性，但作为比赛项目定位可接受。 |

### 进程管理

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已实现，约 85% |
| **关键发现** | 1. TCB 字段几乎覆盖 Linux task_struct 的主要内容，包括信号处理、Futex、间隔定时器等高级特性。<br>2. 信号处理流程完整，从发送（kill/tkill/tgkill）到默认动作执行或用户自定义处理函数调用，再到 sigreturn 恢复，链路完整。<br>3. clone 的 CloneFlags 实现全面，满足 pthread 创建需求。<br>4. execve 支持动态链接器加载，满足复杂用户程序运行需求。 |
| **评价** | 进程管理是该内核最完善的子系统之一。信号和 Futex 的实现尤其详尽。调度器仅 FIFO 是最薄弱的环节，缺少优先级调度限制了实时性和交互性。 |

### 文件系统

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已实现，约 78% |
| **关键发现** | 1. VFS 四层抽象（SuperBlock/Inode/Dentry/File）设计清晰，trait object 多态使多文件系统支持成为可能。<br>2. ext4_rs 引擎与 VFS 适配层分离，架构上便于独立升级。<br>3. devfs/procfs/tmpfs 提供基本的设备文件和临时文件支持。<br>4. LRU 块缓存减少磁盘 I/O，Drop 自动写回简化同步模型。<br>5. epoll/eventfd/signalfd/timerfd 等特殊文件类型实现丰富。 |
| **评价** | VFS 架构设计良好，ext4 支持是该内核的一大亮点。主要不足在于 ext4 日志未完整支持导致可靠性受限，以及缺少文件锁。 |

### 交互设计

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已部分实现，约 60% |
| **关键发现** | 1. crate_interface 接口定义使 arch 与 os 解耦，arch 定义接口签名而 os 实现，避免循环依赖。<br>2. `TrapFrameArgs` 枚举 + Index trait 实现架构无关的寄存器访问，内核核心代码无需了解具体寄存器编号。<br>3. 命令行参数通过 `procfs` 的 cmdline 文件暴露，但与 Linux /proc 语义有差异。<br>4. 无 VT/终端子系统，交互仅限于串口控制台。 |
| **评价** | 架构层面的解耦设计优秀，但用户交互层面仅支持基本的串口输入输出。缺少终端控制（termios）、作业控制（job control）等交互特性。 |

### 同步原语

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已部分实现，约 35% |
| **关键发现** | 1. 基于 `spin::Mutex` 的自旋锁适用于单核环境，使用简单。<br>2. Futex 实现完整，为用户空间提供高效的同步机制。<br>3. 无读写锁、顺序锁、RCU 等高级原语，无法支持 SMP 的高性能并发场景。<br>4. 全局数据结构（如 FUTEX_Q）使用单一自旋锁保护，扩展性受限。 |
| **评价** | 当前同步原语仅满足单核需求。若转向 SMP 支持，同步子系统需要大量补充工作（RCU、per-CPU 锁等）。不适合多核部署场景。 |

### 资源管理

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已部分实现，约 60% |
| **关键发现** | 1. 文件描述符表（FdTable）通过 Arc<Mutex<>> 管理，支持跨进程共享（clone 时指定 CLONE_FILES）。<br>2. 页帧使用 FrameTracker RAII 自动回收，避免显式释放疏忽。<br>3. PID/TID 通过 TidAllocator 统一分配与回收。<br>4. 无资源限制（rlimit 虽有 getrlimit/prlimit64 系统调用但内部未强制限制实际资源使用）。<br>5. 无 cgroup 资源控制。 |
| **评价** | 基本资源（内存页帧、fd、PID）的分配与回收管理到位。但缺少资源配额和限制机制，无法防止单个进程耗尽系统资源。 |

### 时间管理

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已部分实现，约 65% |
| **关键发现** | 1. 基于 BinaryHeap 的定时器管理支持有序超时检查，时间复杂度 O(log n)。<br>2. Futex 超时通过定时器唤醒实现，支持带超时的同步等待。<br>3. timerfd 实现完整，可将定时器事件统一到 epoll 事件循环。<br>4. 时间统计（TCBTms）仅在 tick 级更新，精度有限。<br>5. 无高精度定时器，无 tickless 模式。 |
| **评价** | 基础定时功能满足基本需求，timerfd 与 epoll 的集成是亮点。但缺少高精度定时器和 tickless 模式，在需要低延迟响应的场景下精度不足。 |

### 系统信息

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已部分实现，约 55% |
| **关键发现** | 1. uname 系统调用返回 sysname/nodename/release/version/machine 信息。<br>2. sysinfo 返回 uptime/loads/totalram/freeram/sharedram/bufferram/totalswap/freeswap/procs 等信息。<br>3. procfs 提供 meminfo（内存使用）、mounts（挂载表）、exe（执行路径）文件。<br>4. 无 /proc/cpuinfo、/proc/stat、/proc/pid/status 等详细进程和系统信息接口。<br>5. 无 sysfs 实现。 |
| **评价** | 基本的系统信息查询接口已实现，但 procfs 和 sysinfo 的信息丰富度较低，限制了系统监控和诊断能力。 |

### 架构可移植性

| 评价维度 | 内容 |
|----------|------|
| **是否实现及完整度** | 已部分实现，约 60% |
| **关键发现** | 1. RISC-V 64 和 LoongArch 64 为完整的主力架构，页表、中断、上下文切换、信号蹦床均实现。<br>2. x86_64 和 AArch64 为部分移植状态：x86_64 有 GDT/IDT/APIC/页表但启动入口未完整；AArch64 有 EL1 切换/MMU/GIC 但无信号蹦床。<br>3. 硬件抽象通过 ArchInterface trait 和 TrapFrameArgs 枚举实现架构无关化，新架构移植工作量可控。<br>4. 信号蹦床的静态页表映射方案为 RISC-V 特化，x86/AArch64 需要单独实现。 |
| **评价** | 双主力架构支持在同类 Rust 内核中较为罕见，架构解耦设计降低了移植成本。但非主力架构的完成度较低，实际无法运行。 |

---

## 总结评价

UESTC OS Kernel 2026 是一个基于 Rust 语言、在 RustOsWhu 上游基础上进行深度二次开发的双架构（RISC-V 64 与 LoongArch 64）宏内核项目。项目代码规模约 40,500 行（不含外部 crate），整体架构采用 crate_interface 实现 HAL 层解耦，设计合理，模块化程度良好。

**主要技术优势**：
1. 进程管理子系统是项目最完整部分，TCB 设计详尽，信号处理（33 种信号、队列、sigaction、sigreturn）、Futex（含 bitset/requeue）、clone（完整 CloneFlags）的实现达到较高水平。
2. 内存管理包含 COW、懒分配、共享内存等现代内核必备特性，页表支持 RISC-V Sv39 和 LoongArch LA64，RAII FrameTracker 修复了手动内存管理的泄漏风险。
3. VFS 分层架构设计清晰，ext4 通过双层适配模式（VFS 适配层 + ext4_rs 引擎）实现读写支持，是项目的重要工程成果。
4. 130+ 系统调用覆盖了 POSIX 的主要功能面（进程、内存、文件、信号、网络、时间、epoll 等），运行复杂用户程序的能力较强。

**主要不足**：
1. **网络子系统不可用**：独立实现的 TCP/IP 协议栈代码质量可接受，但物理网络驱动为空桩，导致整个网络功能无法实际运行。这是项目完整性上最突出的缺陷。
2. 调度器仅为 FIFO，缺少优先级调度和 CFS，影响多任务场景下的响应性和公平性。
3. 同步原语仅适用于单核，无 SMP 支持所需的高级同步机制。
4. ext4 日志未完整实现，文件系统可靠性在异常断电场景下存在风险。
5. x86_64 和 AArch64 架构支持为部分移植状态，无法实际运行。

**总体定位**：该项目在进程管理、信号处理、VFS 和 ext4 支持方面展现了扎实的系统编程能力，是一个具备运行复杂用户程序潜力的宏内核。网络驱动的缺失和单核同步限制使其在完整性和可用性上仍有明显缺口。作为操作系统比赛作品，其在核心子系统的深度实现与多架构适配方面的探索值得肯定。