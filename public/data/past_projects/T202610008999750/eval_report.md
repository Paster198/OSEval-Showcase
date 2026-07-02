# Starry 内核项目技术画像与评估报告

## 一、项目基本信息

| 条目 | 内容 |
|------|------|
| **项目名称** | Starry (starry-next) |
| **架构** | x86_64, AArch64, RISC-V64, LoongArch64 |
| **实现语言** | Rust |
| **内核类型** | 组件化宏内核 |
| **生态归属** | 基于 ArceOS 框架（Unikernel 框架）改造的宏内核 |
| **代码规模** | 约 121,131 行 Rust 代码（含 vendored 依赖，532 个 .rs 源文件） |
| **系统调用数量** | 约 102 个 (约为 Linux 5.x 全部系统调用的 25% 左右) |
| **用户态 ABI 兼容** | 兼容 Linux ABI (musl 和 glibc) |
| **构建方式** | Cargo workspace + Makefile + [patch] 离线依赖 |
| **测试体系** | 四层测试用例集 (junior/libc/nimbos/oscomp) |
| **项目定位** | 教学/比赛型操作系统内核项目 |
| **核心创新** | 组件化宏内核架构、类型擦除进程扩展、BusyBox applet 自动映射、多 libc 自动适配 |

---

## 二、子系统实现概览

### 已实现的核心子系统

1. **系统调用分发层** (src/syscall.rs)
   - 通过 `#[register_trap_handler(SYSCALL)]` 注册为陷阱处理器
   - 约 100 个系统调用的完整分发
   - 内置时间统计切换和进程定时器检查

2. **进程管理子系统** (axprocess + starry-core + api/imp/task/)
   - fork/clone/execve/exit/wait4 完整实现
   - 支持线程和进程的创建与管理
   - 进程组/会话管理
   - 僵尸进程回收和子进程过继机制

3. **内存管理子系统** (core/src/mm.rs + api/src/imp/mm/)
   - 用户地址空间创建与销毁
   - ELF 加载（支持 PT_INTERP 递归）
   - mmap/munmap/mprotect/brk
   - 缺页异常处理

4. **文件系统子系统** (api/src/file/ + api/src/imp/fs/)
   - FileLike trait 统一抽象（File/Directory/Pipe/Socket）
   - 文件描述符表管理（稀疏数组，最多 1024 个 fd）
   - 匿名管道（环形缓冲区，256 字节）
   - openat/getdents64/stat 系列/utimensat 等
   - 硬链接管理和引用计数
   - vfat 文件系统挂载/卸载

5. **信号子系统** (axsignal + api/src/imp/signal.rs + api/src/signal.rs)
   - 64 个信号（SIGHUP=1 ~ SIGRT32=64）
   - 完整的信号动作管理（默认/忽略/处理函数）
   - 进程级和线程级信号管理器分离
   - 信号排队和优先级
   - 信号栈支持 (sigaltstack)
   - rt_sigreturn 和 trampoline 机制
   - 信号投递时机：系统调用返回用户态前 (POST_TRAP)

6. **Futex 子系统** (core/src/futex.rs + api/src/imp/futex.rs)
   - FUTEX_WAIT/WAKE/REQUEUE/CMP_REQUEUE
   - 进程级 FutexTable（以用户地址为键）
   - 等待队列自动清理机制

7. **网络/Socket 子系统** (api/src/file/net.rs + api/src/imp/fs/socket.rs)
   - UDP/TCP socket 封装（基于 smoltcp）
   - 本地回环最小兼容层
   - sendto/recvfrom/listen/connect/accept

8. **时间子系统** (core/src/time.rs + api/src/imp/time.rs)
   - 任务级时间统计（用户态/内核态纳秒计数）
   - 进程间隔定时器 (ITIMER_REAL/VIRTUAL/PROF)
   - clock_gettime/gettimeofday/nanosleep/times/getrusage

9. **轮询子系统** (api/src/imp/fs/poll.rs)
   - ppoll 和 pselect6 实现
   - 基于 FileLike::poll() 的就绪状态查询

10. **系统信息子系统** (api/src/imp/sys.rs)
    - getuid/geteuid/getgid/getegid (固定返回值 0/1)
    - uname (返回 "Starry")
    - sysinfo (运行时间和内存统计)
    - prlimit64 (RLIMIT_NOFILE/STACK/AS)
    - getrandom (基本随机数生成)

---

## 三、子系统的实现完整程度

| 子系统 | 实现完整度（相对于 Linux 0.1 级别完整内核） | 评估依据 |
|--------|----|------|
| 系统调用分发 | 90% | 约 102 个系统调用，覆盖文件、进程、内存、信号、时间、网络等主要类别。缺失：部分 prctl 子命令、高级文件操作（fallocate、sync 等）、cgroup、seccomp |
| 进程管理 | 85% | fork/clone/execve/exit/wait 核心语义完整，clone flags 大部分实现。缺失：命名空间隔离仅接受标志但无实际隔离、subreaper、core dump |
| 内存管理 | 80% | ELF 加载、mmap/munmap/mprotect/brk 核心功能完整。缺失：mremap、madvise、mincore、CoW 物理页面共享优化、共享内存 |
| 文件系统 | 75% | 基本文件 I/O、目录操作、状态查询、管道功能完整。缺失：完整权限模型、文件锁（flock/fcntl lock）、aio、inotify、命名管道 (FIFO) |
| 信号 | 90% | 信号发送、阻塞、处理、等待、信号栈功能完整。缺失：SA_SIGINFO 的扩展信息完整传递、core dump、job control 的 STOP/CONT 完整实现 |
| Futex | 85% | FUTEX_WAIT/WAKE/REQUEUE/CMP_REQUEUE 完整。缺失：FUTEX_WAIT_BITSET/WAKE_BITSET、FUTEX_LOCK_PI、robust futex 退出清理 |
| 网络/Socket | 70% | 基本 TCP/UDP socket 操作完整。缺失：IPv6、Unix domain socket、setsockopt 实际实现、epoll、完整非阻塞语义 |
| 时间 | 80% | 时间获取、睡眠、进程定时器完整。缺失：高精度定时器接口、clock_gettime 的更多时钟类型 (CLOCK_PROCESS_CPUTIME_ID 等) |
| 管道 | 85% | 匿名管道读写、阻塞、EOF、EPIPE 语义完整。缺失：O_NONBLOCK 完整实现、F_SETPIPE_SZ |
| 轮询 | 75% | ppoll/pselect6 基本语义完整。缺失：阻塞式 poll 等待（当前为即时查询+sleep 循环）、epoll |
| 系统信息 | 60% | 最小兼容存根，大部分为固定返回值或 no-op |

**OS 内核整体实现完整度估计**：约 75%~80%（基于支持典型用户态基准程序运行所需的功能覆盖率。评估基准为：能够运行 BusyBox shell、libc 测试套件、基本编译器工具链的 Linux 兼容内核）。

---

## 四、各子系统的优缺点及实现细节

### 4.1 系统调用分发层

**优点**：
- 统一的时间统计和定时器检查插入点，设计清晰
- 系统调用号使用 derive 宏自动生成 `Sysno` 枚举，类型安全
- x86_64 额外支持旧 ABI 系统调用，兼容性考虑周全

**缺点**：
- match 分支约 100 个，缺乏分类抽象，未来扩展可维护性会下降
- 未实现的系统调用统一返回 ENOSYS，无更细粒度的错误码

**实现细节**：
```rust
fn handle_syscall(tf: &mut TrapFrame, syscall_num: usize) -> isize {
    let sysno = Sysno::from(syscall_num as u32);
    time_stat_from_user_to_kernel();      // 进入内核态时间戳
    check_process_itimers();              // 检查进程定时器
    let result = match sysno {
        // 约 100 个 match 分支
        _ => Err(LinuxError::ENOSYS)
    };
    let ans = result.unwrap_or_else(|err| -err.code() as _);
    time_stat_from_kernel_to_user();      // 返回用户态时间戳
    ans
}
```

### 4.2 进程管理子系统

**优点**：
- clone 标志位覆盖全面（14 个标志中 11 个完整实现）
- execve 的 shebang 递归解析和 BusyBox applet 映射体现了对实际测试场景的深入理解
- 僵尸进程回收和 wait4 的 PID/进程组过滤语义正确
- 类型擦除的进程扩展数据设计实现了良好的可扩展性

**缺点**：
- CLONE_NEW* 命名空间标志仅被接受但无实际隔离效果，可能误导用户程序
- fork 仅在 x86_64 上直接支持，其他架构通过 clone 模拟
- ProcessData 中 heap_bottom/heap_top 使用 AtomicUsize 但无 CAS 循环保护

**实现细节**：
clone 的地址空间处理是三路分支：
1. CLONE_VM 置位（线程）：直接共享地址空间和页表
2. CLONE_VM 清零 + CLONE_VFORK 置位：共享地址空间但页表可写（vfork 语义）
3. 普通 fork：通过 AddrSpace::try_clone() 创建 CoW 副本

execve 的 ExecPlan 结构体系统管理了从路径解析到 ELF 加载的完整状态：
```rust
pub struct ExecPlan {
    pub image_path: String,   // 实际二进制路径
    pub argv: Vec<String>,    // 参数列表
    pub exe_path: String,     // /proc/self/exe 返回的路径
    pub task_name: String,    // 任务名称
}
```

### 4.3 内存管理子系统

**优点**：
- ELF 加载器支持递归加载解释器（PT_INTERP），兼容 musl 和 glibc
- 多架构页表处理正确（x86_64/RISC-V 复制内核映射，AArch64/LoongArch64 使用独立页表寄存器）
- mmap 支持大页（2MB/1GB），MAP_HUGETLB/MAP_HUGE_1GB
- 缺页异常区分用户态和内核态触发源，分别处理

**缺点**：
- brk 仅修改边界记录，不进行实际的物理页分配或释放，依赖缺页处理延迟分配
- Copy-on-Write 的页面共享优化未完全实现（fork 时复制页表但物理页可能在后续 mmap 中被重新分配）
- mprotect 不支持 PROT_GROWSDOWN/PROT_GROWSUP
- 无 mremap 实现
- 用户堆大小固定为 1MB（RISC-V64），无动态扩展机制

**实现细节**：
内核映射复制仅在 x86_64 和 RISC-V 上需要：
```rust
// 进程退出时清理复制的内核映射，避免误影响内核页表
clear_kernel_mappings(&mut aspace);
```
mmap 的文件映射实现：
```rust
// 先分配内存，再从 fd 读取文件内容
uspace.map_alloc(vaddr, size, prot, flags, shared, page_size)?;
let data = read_all_from_fd(fd)?;
uspace.write(vaddr, page_size, &data)?;
```
这种方式在文件较大时可能产生不必要的内存拷贝开销。

### 4.4 文件系统子系统

**优点**：
- FileLike trait 实现了统一的多类型文件抽象（File/Directory/Pipe/Socket）
- 伪 inode 分配通过 FNV-1a 变体哈希确保不同文件获得不同 inode 号
- 管道实现支持信号中断（EINTR）、EOF 和 EPIPE 语义
- fd 表使用 FlattenObjects（稀疏数组），最大 1024 个 fd
- 通过 AxNamespace 实现进程级 fd 表隔离

**缺点**：
- 管道缓冲区仅 256 字节，容量较小
- O_NONBLOCK 在管道上的实现不完整（注释提及但无完整测试覆盖）
- O_TMPFILE 通过创建命名临时文件实现，非原子操作
- 没有文件锁实现（flock/fcntl SETLK）
- 硬链接管理使用全局 BTreeMap，可能成为并发瓶颈

**实现细节**：
管道使用条件变量等待：
```rust
// 读端空时阻塞等待，检查待处理信号
if self.buffer.is_empty() {
    if self.write_count.load() == 0 {
        return Ok(0);  // EOF
    }
    // 等待写入或信号
    self.read_wq.wait_until(|_| !self.buffer.is_empty() || signal_pending())?;
}
```
Drop 通知机制：任一端析构时唤醒对端等待者。

### 4.5 信号子系统

**优点**：
- 进程级和线程级信号管理器分离，符合 POSIX 规范
- 信号排队支持（最多 8 个 RT 信号排队）
- signal trampoline 支持架构相关汇编实现
- 信号投递时机在系统调用返回用户态前（POST_TRAP），符合 Linux 语义
- kill 的 pid 语义实现正确（>0 进程、0 进程组、-1 广播、<-1 进程组）

**缺点**：
- rt_sigreturn 的异常检测（SIGSEGV 栈溢出）可能不完整
- SA_SIGINFO 标志下 siginfo 的 si_code 和 si_addr 信息不够丰富
- 信号栈 (sigaltstack) 与正常栈的切换边界检测有待完善
- core dump 完全未实现

**实现细节**：
信号处理函数调用前在用户栈上构造 SignalFrame：
```rust
fn setup_signal_frame(user_stack, ucontext, siginfo, trapframe) {
    // 在用户栈上分配 frame 空间
    // 填充 ucontext、siginfo_t、返回地址（trampoline）
    // 修改 trapframe 的 PC 跳转到信号处理函数
    // 修改 trapframe 的 SP 指向新栈帧
}
```
信号投递流程：
1. 发送方 (kill/tkill) → ProcessSignalManager → PendingSignals + 等待队列唤醒
2. 接收方 (POST_TRAP) → check_signals → dequeue → setup_signal_frame → 修改 trapframe
3. 返回用户态后自动执行信号处理函数
4. 处理函数末尾调用 trampoline → rt_sigreturn 恢复上下文

### 4.6 Futex 子系统

**优点**：
- 核心操作（WAIT/WAKE/REQUEUE/CMP_REQUEUE）全部实现
- WaitQueueGuard 自动清理机制避免内存泄漏
- 支持 FUTEX_PRIVATE_FLAG、支持超时

**缺点**：
- FUTEX_WAIT_BITSET/WAKE_BITSET 未实现（影响 pthread 条件变量的高效实现）
- FUTEX_LOCK_PI 未实现（影响 pthread 互斥锁的优先级继承）
- robust futex 的退出清理仅存储了链表头，未实现遍历和唤醒

**实现细节**：
FutexTable 核心结构：
```rust
pub struct FutexTable(Mutex<BTreeMap<usize, Arc<WaitQueue>>>);
// 以用户空间地址为键，等待队列为值
// WaitQueueGuard 在 Drop 时检查是否可清理（引用计数=1 且队列为空）
```
CMP_REQUEUE 的实现需要原子地验证 futex 值、唤醒部分等待者、将剩余等待者迁移到另一个 futex。

### 4.7 网络/Socket 子系统

**优点**：
- 基础 TCP/UDP socket 操作完整
- 本地回环兼容层以最小代价支持了同机 socket 通信测试
- Socket 类型通过枚举统一管理

**缺点**：
- 完全依赖 smoltcp，仅支持 IPv4
- 无 epoll 支持（ppoll/pselect6 为即时查询）
- setsockopt 对 SO_REUSEADDR/SO_RCVTIMEO/SO_SNDTIMEO 仅接受参数，无实际行动
- TCP 连接的 EINPROGRESS 错误码处理不完整
- 无 shutdown 系统调用实现
- 回环兼容层使用全局静态变量，存在并发竞态风险

**实现细节**：
本地回环兼容层的核心：
```rust
// 发送端检测到目标端口在本地绑定且目标 IP 是本机地址
// → 将数据包推入回环缓冲区而非走网络栈
static UDP_LOOPBACK_PACKETS: Mutex<VecDeque<UdpPacket>> = ...;
static TCP_LOOPBACK_CONNECTIONS: Mutex<VecDeque<TcpConnectionRequest>> = ...;
```
此设计仅适用于简单测试场景，生产环境下存在严重的并发安全问题。

### 4.8 时间子系统

**优点**：
- 任务级时间统计（用户态/内核态纳秒精度）
- 进程定时器同时支持同步检查（系统调用入口）和异步触发（独立内核任务）
- sleep 被信号中断后返回剩余时间的语义正确

**缺点**：
- 时间统计使用系统调用次数作为精度边界，在纯计算型任务中可能不准确
- 异步定时器任务使用周期性唤醒，精度受限
- clock_gettime 仅支持 CLOCK_REALTIME 和 CLOCK_MONOTONIC

**实现细节**：
进程定时器的双路径检查：
```rust
// 路径 1：同步检查，每次系统调用入口
fn handle_syscall(tf, syscall_num) {
    time_stat_from_user_to_kernel();
    check_process_itimers();  // 检查定时器是否到期
    // ...
}

// 路径 2：异步检查，针对阻塞在 pipe 等系统调用中的进程
// schedule_process_timer_task() 启动独立内核任务，周期性检查
```
setitimer 时同时启动异步监控任务，避免进程在阻塞时无法收到定时器信号。

---

## 五、动态测试的设计和结果

### 5.1 测试架构设计

项目设计了一套分层的测试体系，通过 Python 脚本自动编排：

| 测试层级 | 测试内容 | 测试用例数（估计） | 目的 |
|---------|------|---------|------|
| apps/junior/ | 基础系统调用（brk、chdir、clone 等） | ~10 | 内核最小功能集验证 |
| apps/libc/ | libc 兼容性（helloworld、signal、mmap、sleep） | ~30 | C 库功能验证 |
| apps/nimbos/ | C + Rust 双语言测试 | ~20 | 综合功能验证 |
| apps/oscomp/ | 比赛评测集（basic/busybox/iozone/iperf/ltp/lua） | ~50 | 比赛综合评分 |

### 5.2 测试编排机制

- 测试列表由 `testcase_list_config.toml` 定义
- 通过 `scripts/testcase_list_gen.py` 自动生成测试运行脚本
- 支持构建验证（make all）、QEMU 运行（make run）、GDB 调试（make debug）

### 5.3 测试方法分析

**优势**：
- 分层测试设计合理，从单系统调用到完整应用程序层层递进
- 自动化测试编排，减少人工干预
- 支持多种架构的测试

**不足**：
- 未见单元测试代码（Rust 的 `#[test]` 模块）
- 缺乏内核级回归测试套件（单独的子系统测试）
- 测试框架依赖 QEMU 外部环境，无纯模拟的轻量测试

### 5.4 测试结果（基于代码审查，未实际执行）

由于当前分析环境不具备必要的工具链和磁盘镜像，无法执行运行时测试。但从代码实现可以推断：

**极高概率通过的测试**：
- 基本进程操作（fork/execve/exit/wait）
- 信号发送和接收
- 基本内存操作（brk/mmap/munmap）
- 管道读写
- 时钟和睡眠

**可能存在问题的测试**：
- 高并发场景下的信号竞态
- 网络 socket 的高负载测试
- 大文件 I/O（管道缓冲区仅 256 字节）
- epoll 相关测试（未实现）
- 非阻塞 I/O 的正确性

---

## 六、细则评价表格

| 条目 | 是否实现 | 完整度评价 | 关键发现 | 评价 |
|------|---------|-----------|---------|------|
| **进程管理** | 是 | 85%（相对于 Linux 0.1 级别完整内核） | clone 14 个主要标志中 11 个完整实现；execve 的 shebang 递归解析和 BusyBox applet 映射是独特设计；fork 仅在 x86_64 直接支持，其余架构通过 clone 模拟 | 克隆、执行、退出、等待的核心语义实现完整，进程组和会话管理也涵盖了基本需求。CLONE_NEW* 标志仅接受但无隔离，对某些应用程序可能是误导 |
| **内存管理** | 是 | 80%（相对于 Linux 0.1 级别完整内核） | ELF 加载支持递归解释器（PT_INTERP）；mmap 支持大页（2MB/1GB）；brk 仅修改边界不实际分配物理页；CoW 页面共享优化未完全实现 | 核心内存操作（mmap/munmap/mprotect/brk）齐全，ELF 加载兼容 musl 和 glibc。缺页异常处理区分了用户态和内核态触发源。缺失 mremap、madvise 等高级接口 |
| **文件系统** | 是 | 75%（相对于 Linux 0.1 级别完整内核） | FileLike trait 统一了 4 种文件类型；管道容量仅 256 字节；伪 inode 分配使用 FNV-1a 哈希；硬链接管理使用全局 BTreeMap | 基本文件 I/O 和目录操作功能齐全，管道阻塞语义和信号中断正确处理。权限模型缺失严重（无 UID/GID 校验），文件锁未实现 |
| **交互设计** | 是 | 85%（相对于 OS 比赛评测需求） | 通过条件编译支持 4 种架构；编译时环境变量（OSKERNEL_TRACE_PIPE 等）启用子系统调试追踪；BusyBox applet 自动路径映射 | 开发者工具链完善：make 构建、GDB 调试、clippy 代码检查。需要 nightly Rust 工具链，限制了可移植性。内核与用户交互仅通过 Linux ABI，无自定义接口 |
| **同步原语** | 是（依赖 ArceOS） | 不适用 | Mutex、自旋锁、WaitQueue（条件变量）由 ArceOS 框架提供，非本内核实现 | 未独立评估。从使用角度看，管道、futex、信号等待队列均正确使用 WaitQueue 实现阻塞/唤醒语义 |
| **资源管理** | 是 | 75%（相对于 Linux 0.1 级别完整内核） | 通过 AxNamespace 实现进程级 fd 表、当前目录、fd 限制隔离；文件描述符使用 FlattenObjects 稀疏数组（最大 1024）；僵尸进程自动回收（过继子进程给 init） | 基本资源生命周期管理正确：进程退出时清理 fd、子进程过继、僵尸回收。缺失进程级内存限制（RLIMIT_AS 未完全强制）、磁盘配额 |
| **时间管理** | 是 | 80%（相对于 Linux 0.1 级别完整内核） | 任务级时间统计（纳秒用户态/内核态计数）；进程定时器双路径（同步+异步）检查；sleep 可被信号中断并返回剩余时间 | 时间获取和基本定时器功能齐全。时间统计精度受限于系统调用次数粒度，异步定时器使用周期性轮询而非精确硬件定时器中断 |
| **系统信息** | 是 | 60%（相对于 Linux 0.1 级别完整内核） | getuid/geteuid 返回固定值 0/1；uname 返回 "Starry"；sysinfo 仅填充运行时间和内存总量；syslog、membarrier 为最小兼容存根 | 提供了必要的系统信息返回以支持 libc 初始化，但大部分为固定值或最小语义实现，未反映真实系统状态 |
| **进程间通信** | 部分 | 65%（相对于 Unix IPC 全集） | 匿名管道完整；信号完整；Futex 完整（基本操作）；Unix domain socket 未实现；共享内存未实现；命名管道未实现 | 基本 IPC 机制（管道、信号、futex）齐全，可支持典型并发编程模式。缺少 Unix domain socket 和共享内存限制了复杂 IPC 场景 |
| **网络通信** | 部分 | 70%（相对于 Linux 0.1 级别完整内核） | TCP/UDP socket 基本操作完整；仅支持 IPv4；本地回环通过兼容层实现；setsockopt 无实际操作；无 epoll | 基础网络功能可用，但深度不足：无 IPv6、无 epoll 高性能 I/O、非阻塞语义不完整。smoltcp 依赖限制了网络栈能力 |

---

## 七、总结评价

Starry 是一个设计目标明确、工程执行良好的操作系统内核项目。其在约 12 万行 Rust 代码中，以组件化宏内核的架构方式，实现了接近 75%~80% 的 Linux 兼容宏内核功能。项目最突出的特点在于对用户态兼容性的深入处理——多 libc 自动适配、shebang 递归解析、BusyBox applet 映射等实现体现了对评测场景的精准把握，而非泛泛的系统调用存根堆砌。

**核心优势**：

1. **组件化宏内核设计**：基于 ArceOS 的模块化框架构建完整宏内核，而非传统的单体式结构。这种设计使得每个子系统（进程管理、信号、futex 等）作为独立 crate 存在，在保持宏内核性能的同时获得了良好的模块边界。

2. **Linux ABI 兼容深度**：约 102 个系统调用的实现覆盖了进程管理、内存管理、文件系统、信号、时间、网络等主要子系统，能够运行 musl 和 glibc 编译的用户程序，包括 BusyBox shell。

3. **多架构统一支持**：通过条件编译在统一代码库中支持 x86_64、AArch64、RISC-V64、LoongArch64 四种架构，架构差异处理合理（页表复制策略、指令集特定系统调用等）。

4. **开发者工具链完善**：编译时追踪日志、GDB 调试支持、clippy 静态检查、完全离线构建能力，体现了成熟的工程习惯。

**主要局限**：

1. **文件系统深度不足**：缺少完整的权限模型、文件锁、命名管道实现。管道容量 256 字节限制了 IPC 性能。

2. **网络子系统单薄**：仅支持 IPv4，依赖 smoltcp 的有限能力，无 epoll 高性能 I/O 接口，本地回环实现存在并发安全隐患。

3. **部分实现为最小兼容存根**：syslog、membarrier、sysinfo 等系统调用仅返回固定值或不执行实际操作，虽然不妨碍基本程序运行，但在需要这些功能的场景下会暴露问题。

4. **进程隔离不完整**：CLONE_NEW* 命名空间标志被接受但无实际隔离效果，rlimit 的内存限制未强制实施。

5. **缺少运行时单元测试**：未见 Rust `#[test]` 模块的内核级单元测试，测试体系仅依赖外部集成测试。

**整体评价**：

Starry 在一众教学/比赛型 OS 内核项目中，属于功能完整度和工程化水平均处于较高区间的作品。其代码组织清晰、子系统职责明确、对 Linux ABI 的理解深入，能够作为学习 Rust 宏内核开发和多架构 OS 设计的优秀范本。同时，其明显的性能优化缺失（如 CoW 页面共享、I/O 路径内存拷贝）、网络深度不足、以及部分子系统的单点瓶颈（如伪 inode 分配的全局锁），也说明项目更侧重于功能覆盖而非生产级质量。总体而言，这是一个在有限的代码规模内达成了显著功能完整度的精心设计作品。