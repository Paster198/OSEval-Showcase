# OS 内核项目技术画像与评估报告

## 一、项目基本信息

| 项目属性 | 详情 |
|----------|------|
| **项目名** | 未给出显式名称（基于 xv6-riscv 深度扩展） |
| **目标指令集架构** | RISC-V 64（RV64） |
| **特权级架构** | RISC-V 特权架构 S 态，Sv39 虚拟内存 |
| **实现语言** | C（主语言），少量 RISC-V 汇编（trampoline、switch、入口） |
| **生态归属** | xv6 教学内核体系，引入 Linux ABI 兼容层 |
| **构建工具链** | riscv64-unknown-elf- GCC、GNU Make |
| **外部依赖** | lwext4 库（ext4 用户态库移植）、musl/glibc RISC-V 动态链接器 |
| **主要特点** | 1. 完整 VFS 抽象层，桥接 xv6 原生 FS 和 ext4 后端<br>2. 约 90 个 Linux 系统调用的兼容实现（clone/futex/mmap/socket 等）<br>3. COW fork 与大页（2MB）的统一处理<br>4. 线程组模型支持 CLONE_THREAD/CLONE_VM/CLONE_FILES/CLONE_FS<br>5. ELF 动态链接器加载与路径自动重定向（glibc/musl）<br>6. 内核内 socket（UDP）及简单 virtio-net 网络栈 |

## 二、实现的子系统与功能

| 子系统 | 涵盖功能 |
|--------|----------|
| **内存管理** | Per-CPU 物理页分配器、大页（2MB）分配、引用计数、Sv39 三级页表管理、COW fork、mmap/munmap（文件映射/匿名映射）、按需分页（vmfault）、mprotect、CLONE_VM 共享页表、brk/sbrk、大页自动降级 |
| **进程/线程管理** | fork/clone、线程组（CLONE_THREAD）、CLONE_VM/CLONE_FILES/CLONE_FS 语义、文件描述符表同步、exit/exit_group、wait4、futex、信号（RT 信号子集）、CPU 亲和性绑定 |
| **文件系统** | VFS 抽象层（多后端、挂载点管理、最长前缀匹配路径解析）、xv6 原生 FS（完整读写、目录操作、日志）、ext4 后端（通过 lwext4 库，支持文件/目录/硬链接/符号链接，日志禁用）、路径重定向（用于 Linux 动态库查找）、utimensat 时间戳覆盖表 |
| **网络** | virtio-net 驱动（RX/TX 双队列）、内核内 socket（UDP 数据报和 stream 式 accept 模拟）、AR P 回复（仅处理首个请求）、手动构建 UDP/IP/Ethernet 包 |
| **同步原语** | 自旋锁、睡眠锁、读写自旋锁、futex（支持 WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP/BITSET 及超时）、robust futex |
| **设备驱动** | UART（16550A 兼容）、virtio 块设备（支持多设备）、PLIC 中断控制器 |
| **时间管理** | ticks 时钟中断、基于 ext4 超级块时间戳的系统时间推算、nanosleep/clock_gettime/clock_nanosleep/gettimeofday/times |
| **系统调用 ABI** | 约 90 个 Linux syscall（文件 I/O、进程、内存、网络、时间、信号、futex 等），10 余个 xv6 私有 syscall |
| **ELF 加载与动态链接** | PT_INTERP 动态链接器加载、PT_LOAD 段映射、Linux ABI 兼容初始栈与 auxv 构建、非 ELF 回退到 busybox sh 执行 |
| **其他** | KCSAN 数据竞争检测（可选编译）、/dev/null, /dev/zero 字符设备 |

## 三、各子系统实现细节与优缺点

### 3.1 内存管理

**实现细节**：
- 物理页分配：每个 CPU 维护独立空闲链表，分配时优先本地，本地不足时从其他 CPU 窃取页（每次至多 8 页）。
- 大页：预留物理内存顶部 16 个 2MB 超级页，通过 `superalloc`/`superfree` 管理，带独立引用计数。
- 引用计数：为 4KB 页和 2MB 页分别维护引用计数数组；常见操作如 COW、uvmshare 增加引用，释放时仅在引用计数归零才归还物理内存。
- 页表管理：`walk` 及其变体支持识别 `PTE_LEAF`（2MB 大页），`uvmunmap` 中部分解除大页时自动将大页降级为 512 个 4KB 页并复制内容。
- COW：`uvmcopy` 中所有可写 PTE 标记为 `PTE_COW`，不复制物理页；写时通过 `vmfault` 分配新页并更新 PTE；`copyout`/`copyin` 也感知 COW 并自动断裂。
- mmap：VMA 记录保存在 `linux_mm` 的固定数组中（`NVMA=64`），`vmfault` 在缺页时按需分配，支持文件映射（从 VFS 读取）和匿名映射。
- mprotect：实时更新 VMA 权限与已映射 PTE，必要时分裂 VMA。
- CLONE_VM：线程共享同一 `linux_mm` 和页表；`uvmshare` 为子线程创建页表别名，对 COW 页若仅有一个引用则直接恢复可写。

**优点**：
- 将 COW、大页、按需分页和 mmap 整合于一个简化的 `vmfault` 入口，设计紧凑。
- 大页降级机制避免了释放大页时的碎片浪费，兼顾灵活性与内存利用率。
- Per-CPU 空闲链和 CPU 间窃取平衡了分配效率和内存利用率。
- 引用计数为共享映射和 COW 提供一致的生命周期管理。

**不足**：
- 大页数量固定（16 个），无法动态扩展，限制了应用可用的大页容量。
- 匿名映射不支持交换或页面回收，内存压力下无法换出。
- VMA 数量上限为 64，且使用固定数组而非动态结构，可能限制复杂程序的地址空间使用。
- 缺乏对 `madvise`、`msync` 等高级内存管理调用的真实支持（`madvise` 实现仅返回成功，未执行任何操作）。

### 3.2 进程与线程管理

**实现细节**：
- 进程结构体 `proc`：含标准 xv6 字段，并扩展 Linux 兼容字段（`mm`、线程组指针、信号掩码、futex 相关字段、文件描述表标志、CPU 亲和性）。
- 线程组：`linux_thread_group` 结构体以单向链表组织成员，记录 `tgid`、线程计数、退出状态；通过 `exit_group` 可一次性退出所有线程。
- `forkat`：统一处理 fork/clone，根据参数决定是否共享页表、文件表、文件系统上下文，以及是否加入线程组。
- 文件表同步：`CLONE_FILES` 情形下，文件描述符发生更改时，`linux_sync_file_table` 将变更传播至线程组内所有线程的文件描述符数组。
- 调度：xv6 经典的优先级统一轮转调度，增加 CPU 亲和性（`pincpu`）支持；Linux 线程强制绑定到 CPU 0（防止共享 VM 线程并发引发的数据竞争）。
- 退出与等待：支持 `exit_group`、孤儿进程收养、`wait4`（Linux 语义）和 `kwait`（xv6 语义）。

**优点**：
- 线程组模型正确实现了 `CLONE_THREAD` 语义，支持线程间 `gettid`、`exit_group`、`futex` 等交互。
- 文件表同步机制保证了线程间文件描述符操作的一致性，设计精细。
- 通过共享 `linux_mm` 实现 CLONE_VM，避免了部分冗余拷贝。

**不足**：
- 全局内核锁粒度较大，限制了在多核上真正并行运行共享 VM 的线程（因此 Linux 线程被绑定到 CPU 0）。
- 调度器仍为简单轮转，无优先级、无抢占延迟控制、无负载均衡，实时性较弱。
- 无 cgroup、namespace、资源限制等隔离机制。
- 进程数量受限于 `NPROC` 固定数组（与 xv6 一致），无法动态扩展。

### 3.3 文件系统

**实现细节**：
- VFS 层：定义 `vfs_inode_ops` 和 `vfs_file_ops` 操作表；挂载管理采用固定数组（16 个挂载槽），初始挂载 xv6 FS（`/`）和 EXT4（`/ext4`）；路径解析使用最长前缀匹配，支持进程根目录和当前目录（`vfs_cwd`），并包含 Linux 动态库路径重定向。
- xv6 后端：将原有 `fs.c` 的函数包装为 VFS 操作；根目录 `readdir` 会附加挂载点子目录条目。
- ext4 后端：通过 `lwext4_port.c` 适配块设备（经 buffer cache）和内存分配，提供文件/目录创建、删除、读写、重命名、符号链接、目录遍历等操作；lwext4 的日志和扩展属性被编译时禁用。
- 其他声明但未实现的后端：`VFS_PROC`、`VFS_TMPFS`、`VFS_DEVFS`（仅枚举值存在）。

**优点**：
- VFS 抽象设计清晰，使得新旧文件系统可无缝共存，且允许进程拥有独立的根/当前目录。
- ext4 后端借助 lwext4 库提供了对 Linux 常用文件系统格式的读/写支持，并支持符号链接和硬链接。
- 动态链接库路径重定向机制缓解了不同 libc 的路径差异，提高了实用兼容性。

**不足**：
- ext4 日志完全禁用，异常断电可能导致文件系统不一致。
- procfs、tmpfs、devfs 无实际实现，许多依赖这些文件系统的 Linux 工具（如 `mount -t proc`、`top` 等）将无法正常工作。
- 挂载管理虽具备 mount/umount 系统调用，但挂载点数量和动态性受限。
- lwext4 分配器采用固定大小追踪表（256 个），长期运行可能耗尽情句。

### 3.4 网络

**实现细节**：
- 驱动：virtio-net 基于 MMIO，配置两个 virtqueue（RX/TX），初始化 MAC 地址并协商特性。
- 内核内 socket：复用 `struct file`，增加 socket 相关字段，支持 SOCK_DGRAM 和 SOCK_STREAM 类型；数据报通过查找目标端口直接入队到接收者的套接字队列；流式连接通过 listen/connect/accept 模拟（不经过网络协议栈真实三次握手）。
- UDP/IP 发送：手动构建 Ethernet、IP、UDP 头部；接收路径解析 IP/UDP 并根据端口入队。
- ARP：仅回复收到的第一个 ARP 请求，无缓存。

**优点**：
- 无需复杂的网络协议栈，即提供了基本的 socket API，可用于简单的 UDP 通信。
- virtio-net 驱动实现了双队列收发，遵循 virtio 规范。
- 内核内 socket 模型减少了数据拷贝（在同一系统内的进程间通信），并提供了统一的 socket 语义。

**不足**：
- 无 TCP 支持，无法运行依赖 TCP 的绝大多数网络应用。
- ARP 实现极为简陋，不能适应动态网络环境。
- 无 DNS 解析功能（仅头文件中预留），网络地址只能使用 IP。
- 无路由、无 socket 选项（setsockopt 为空实现）等高级特性。
- 网络初始化失败将导致内核 panic（由于未配置 virtio-net 设备），缺少优雅的错误处理。

### 3.5 同步原语

**实现细节**：
- 自旋锁：基于 `amoswap`，使用 `push_off`/`pop_off` 禁用/恢复中断。
- 睡眠锁：自旋锁 + `sleep`/`wakeup`，持有期间允许阻塞。
- 读写自旋锁：支持读共享、写独占，用于 `tickslock` 等场景。
- futex：实现核心操作（WAIT/WAKE/REQUEUE/CMP_REQUEUE/WAKE_OP/WAIT_BITSET/WAKE_BITSET），支持基于 ticks 或实时时钟的超时，支持 robust list 清理；futex 键编码为 `(tgid << 48) | uaddr` 以避免跨进程冲突。

**优点**：
- 提供自旋锁、睡眠锁、读写锁等多种锁原语，适应不同场景。
- futex 实现覆盖了主流的快速用户空间互斥量所需操作，且超时和 bitset 支持较为完整。
- robust futex 处理增强了稳定性。

**不足**：
- 未实现优先级继承（PI）futex，实时性场景受限。
- 缺少 RCU、条件变量、完成量等高级同步机制。
- 锁粒度在全局层面仍然较粗（大内核锁），影响多核扩展性。

### 3.6 时间管理

**实现细节**：
- 时钟中断：每 100ms（通过 `SIE_STIE`）触发，CPU 0 更新全局 `ticks`，使用读写自旋锁保护。
- 时间基准：未使用 RTC，通过 ext4 超级块中的 `s_mtime`/`s_wtime` 字段作为初始时间，再叠加 `ticks` 推算当前实时时间。
- 系统调用：实现了 `clock_gettime`（CLOCK_REALTIME/MONOTONIC）、`nanosleep`、`clock_nanosleep`、`gettimeofday`、`times`。

**优点**：
- 利用 ext4 磁盘时间戳提供系统时间，在没有硬件 RTC 的环境中仍可产生有意义的时间值。
- 支持高精度睡眠和单调时钟，满足常见用户程序需求。

**不足**：
- 初始时间受限于 ext4 超级块中的时间戳，通常为镜像制作时间，不是实际墙钟时间。
- 没有定时器 API（如 `timer_create`、`setitimer`），仅支持了基本的 `nanosleep` 和 alarm（xv6 私有调用）。
- 时钟中断周期固定（100ms），无动态 tick 或高精度计时器。

### 3.7 系统信息

**实现细节**：
- `uname`：返回硬编码的 sysname（`Linux`）、release（`6.2.0`）、machine（`riscv64`）等信息。
- `sysinfo`：返回固定的总内存大小（256MB）和可用内存（由物理页分配器计算）。
- `getrandom`：始终返回全零，未实现真实随机数。
- `syslog`：简单实现，用于内核信息输出。

**优点**：
- 提供 `uname` 和 `sysinfo` 使许多 Linux 工具可以初步运行（如 `uname -a`）。
- `sysinfo` 的可用内存信息与实际分配器保持同步。

**不足**：
- 固定内存大小（256MB）无法反映实际硬件 RAM。
- `getrandom` 无随机性，影响依赖高质量随机数的应用安全。
- 缺少 `/proc/cpuinfo`、`/proc/meminfo` 等伪文件系统，大量系统监控工具无法正常工作。
- `syslog` 实现简单，未提供完整的日志分类和环形缓冲。

### 3.8 交互设计

**实现细节**：
- 控制台：UART 驱动支持串口输入输出，`consoleinit` 初始化控制台，内核 panic 信息、启动日志等输出到控制台。
- Shell：没有内建 shell，但通过 ELF 加载器可以执行 busybox sh；x v6 原有的简单 shell（`sh`）作为用户程序存在。
- 用户界面：命令行交互，无图形环境。
- 系统调用接口：Linux 风格系统调用号用于参数传递（a0-a5, a7），便于移植 Linux 用户程序。

**优点**：
- 控制台输出可帮助开发者调试和了解内核运行状态。
- 可运行 busybox 和标准 shell，提供与 Linux 相似的命令行体验（前提是能够正常启动到用户态）。
- exec 支持脚本文件（回退到 busybox sh），增强了交互便利性。

**不足**：
- QEMU 启动测试中因网络驱动 panic，未能到达用户态 shell；交互性未得到实际验证。
- 无多控制台或虚拟终端支持。
- 无图形或字符界面的输入输出增强功能（如光标控制、行编辑等），完全依赖 busybox 自带的终端控制。

### 3.9 其他补充条目

#### 设备驱动

| 方面 | 说明 |
|------|------|
| 实现 | virtio 块设备（支持两个设备，用于 sdcard 和 fs.img）、virtio-net（MMIO）、PLIC、UART |
| 关键发现 | 块设备驱动支持多设备，与 buffer cache 集成；virtio-net 初始化失败会导致 `panic`，无降级策略 |
| 评价 | 覆盖了基础存储和串口，但缺少 PCI 枚举、DMA 等通用总线框架，设备支持面窄；错误处理刚性 |

#### 信号机制

| 方面 | 说明 |
|------|------|
| 实现 | 仅支持 RT 信号（sig>=32），通过 `rt_sigaction` 注册，信号递送构建 sigframe 和 ucontext |
| 关键发现 | 实现了跨线程的 `tkill`/`tgkill`，但传统信号（SIGINT、SIGTERM 等）未实现 |
| 评价 | 足以支撑 glibc 内部信号机制，但对应用程序的信号支持严重不足，多数 POSIX 信号无法送达 |

#### 系统调用 ABI 与 Linux 兼容

| 方面 | 说明 |
|------|------|
| 实现 | 约 90 个 Linux 系统调用，涵盖文件 I/O、进程、内存、网络、futex、时间、信号等 |
| 关键发现 | 实现了诸如 `sendfile`、`getdents64`、`ppoll`、`renameat2` 等较复杂的调用；部分调用为桩（返回 0） |
| 评价 | Linux ABI 兼容层是内核的最大亮点，使得未经修改的 RISC-V 二进制可运行，但桩调用可能掩盖功能缺失带来的运行错误 |

#### 动态链接与程序加载

| 方面 | 说明 |
|------|------|
| 实现 | ELF 解析 + PT_INTERP 加载，自动搜索 glibc/musl 动态链接器路径，Linux 栈布局 |
| 关键发现 | 能够自动重定向 `/lib/ld-musl-*` 等路径到 ext4 上的实际文件，具有一定的工程实用性 |
| 评价 | 动态链接支持使得运行复杂 C 程序成为可能，路径选择逻辑体现设计细心 |

## 四、动态测试设计与结果

本次评估仅进行了基础启动测试：

- **测试环境**：QEMU system riscv64 (v8.2.2)，配置 256MB RAM，`-machine virt`，未提供 virtio-net 设备。
- **测试方法**：使用项目默认生成的 `kernel/kernel` 和 `fs.img` 启动：  
  `qemu-system-riscv64 -machine virt -bios none -kernel kernel/kernel -drive file=fs.img,if=none,format=raw,id=x0 -device virtio-blk-device,drive=x0 -nographic`
- **结果**：OpenSBI 成功加载内核，内核顺利执行了控制台、内存、页表、进程、中断、PLIC、buffer cache、i 节点、文件描述符表、VFS、virtio 块设备等初始化；在 `virtio_net_init()` 因找不到 virtio-net 设备而触发 `panic`。调用栈：`main → virtio_net_init → panic`。
- **未执行部分**：后续的 `init` 进程创建、第一个用户态程序启动、shell 运行、文件系统操作等均未实际执行，因此未进行任何功能性测试。

结论：内核核心初始化流程正常，但缺乏网络设备会阻止系统进入用户态，无法验证更上层的子系统。项目未提供自动化测试套件或测试用例。

## 五、细则评价表

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|------|------------------|----------|------|
| **内存管理** | 覆盖了物理页/大页分配、引用计数、Sv39 页表、COW、mmap/munmap/mprotect、按需分页、CLONE_VM 共享等核心机制 | COW 与大页统一处理，`vmfault` 同时支持按需分页和 COW 断裂；大页降级机制设计精巧 | 实现较为全面，在同等规模内核中属于较高水平；但缺乏 swap 和页面回收，VMA 数量受限 |
| **进程管理** | 实现了 fork/clone/线程组/exit_group/wait4/futex 等，基本涵盖 POSIX 线程关键语义 | 线程组模型和文件表同步设计细致；但 Linux 线程被强制绑定 CPU 0 以避免并发问题 | 功能较完整，满足多数多线程程序需求；受限于大内核锁，多核扩展性差 |
| **文件系统** | VFS 抽象层、xv6 原生 FS 和 ext4 后端均已实现并可用；procfs/tmpfs/devfs 仅有声明 | VFS 操作表和挂载管理使双文件系统共存成为可能；ext4 日志禁用，一致性依赖下层 | VFS 扩展性强，ext4 集成是重要成就，但伪文件系统缺席导致一些工具无法运行 |
| **交互设计** | 提供串口控制台，可执行 busybox sh；无图形界面或终端高级功能 | 启动测试因网络驱动 panic，未能进入 shell；交互性存疑 | 设计上具备交互能力，但未实际验证完成度；缺少虚拟终端和行编辑等常见特性 |
| **同步原语** | 自旋锁、睡眠锁、读写自旋锁、futex（含超时、bitset、robust）已实现 | futex 操作覆盖主流用例，键编码避免冲突；无 PI futex 和 RCU 等高级机制 | 满足常见同步需求，尤其在用户空间互斥方面表现较好；高级同步抽象缺失 |
| **资源管理** | 资源管理主要体现在文件描述符表、buffer cache、inode 表、VMA 数组等固定数组分配 | 所有资源容器均采用固定大小数组，无动态扩展能力，如文件描述符上限为 128，VMA 上限 64 | 基本满足教学和竞赛场景，但缺乏资源限制和审计；长期运行可能面临资源耗尽 |
| **时间管理** | 基于 ticks 和 ext4 时间戳提供时间服务，实现 clock_gettime、nanosleep 等 | 利用 ext4 时间戳弥补无 RTC 的缺陷，方法简便有效；但初始时间不准 | 满足基本需求，但缺乏高精度定时器和动态 tick |
| **系统信息** | 实现 uname、sysinfo，getrandom 固定返回零 | uname 返回固定值，内存信息与分配器同步；无伪文件系统支撑 | 信息提供有限，`/proc` 和 `/sys` 缺失导致大量用户空间工具不可用 |
| **网络子系统** | virtue-net 驱动、内核内 socket（UDP）、简易 ARP；TCP 不支持 | UDP 数据报可工作，socket API 设计巧妙；但 TCP 缺失和 ARP 简陋极大限制实用性 | 功能不完整，仅可用于简单 UDP 测试，无法支撑典型网络应用 |
| **设备驱动** | virtio 块、virtio-net、PLIC、UART；无 PCI 枚举 | 驱动与 buffer cache、中断控制器等集成良好；但 virtio-net 初始化失败直接 panic | 覆盖基础设备，但缺乏总线框架和健壮的错误处理 |
| **信号机制** | 仅支持 RT 信号（sig>=32），通过 rt_sigaction/sigprocmask/rt_sigreturn 提供基本处理 | 足以支持 glibc 的内部信号使用，但对应用层传统信号几乎全部缺失 | 作为兼容手段有效，但完整性很低 |
| **系统调用 ABI** | 约 90 个 Linux 系统调用实现，涵盖文件、进程、内存、网络、futex 等 | 实现了 sendfile、ppoll、renameat2 等复杂调用，但部分调用仅返回成功（桩） | Linux 二进制兼容性较好，是项目最大亮点；桩调用可能引入隐蔽行为 |
| **动态链接与加载** | ELF PT_INTERP 加载、动态链接器路径搜索、Linux 栈布局和 auxv 构建 | 自动处理 /lib/ld-musl-* 等路径重定向，减少用户配置负担 | 实现稳固，使得复杂 C 程序执行成为可能 |

## 六、总结评价

该项目以一个教学型内核（xv6-riscv）为起点，进行了规模可观的扩展，尤其集中在 Linux ABI 兼容层和文件系统支持两大方向。代码总量约 16,760 行（不含 lwext4 第三方库），涉及内存管理、进程/线程、VFS、ext4、网络、同步、信号、系统调用等众多子系统。

**主要成就**：
- **Linux ABI 兼容**：约 90 个 Linux 系统调用的实现，加之 COW、mmap、futex、线程组等机制，使得未经修改的 RISC-V Linux 二进制文件可以直接运行，这在教学内核中较为罕见。
- **VFS 与 ext4**：清晰的 VFS 设计将 xv6 原生 FS 与成熟 ext4 库有机结合，提供了对主流 Linux 文件系统的读写和目录操作能力，扩展了内核的存储管理边界。
- **内存管理深度**：同时实现了 COW fork、大页（2MB）、按需分页 mmap、CLONE_VM 共享等高级特性，且通过统一的 `vmfault` 处理，体现出较高的集成度。
- **线程组与同步**：CLONE_THREAD 语义的实现及 futex 的丰富支持，为用户态 POSIX 线程和同步原语提供了坚实基础。

**主要局限**：
- **网络能力薄弱**：仅有 UDP 支持，TCP 缺失，ARP 仅处理首个请求，且驱动初始化失败直接 panic，使内核无法在缺省 QEMU 配置下启动到用户态。
- **文件系统一致性风险**：ext4 日志被禁用，文件系统元数据可能因非正常关机受损。
- **伪文件系统缺失**：procfs、tmpfs、devfs 等仅有类型声明却无代码实现，导致 `/proc`、`/tmp`（内存文件系统）等功能缺失，大量 Linux 工具无法正常运行。
- **信号支持残缺**：传统 POSIX 信号几乎未实现，仅 RT 信号子集可工作，应用层信号处理严重受限。
- **扩展性与健壮性受限**：内核大量使用固定大小数组（进程数、文件数、挂载点数、VMA 数等），全局锁粒度较粗，限制了多核性能与长时间运行的稳定性。

**综合评估**：该项目在 Linux 二进制兼容性和文件系统整合方面做出了较为深入的工作，整体功能覆盖达到足以运行部分标准 Linux 用户程序的水平，展现了扎实的工程实现能力。然而网络、信号、伪文件系统等子系统的缺失，以及 ext4 日志禁用等折中处理，使得内核离一个实用操作系统仍有显著差距。在 OS 内核竞赛语境下，该项目可视为一个以兼容性和文件系统为特色的技术展示品，其扩展深度和技术正确性值得肯定，但整体完整度与生产级系统尚有不小距离。