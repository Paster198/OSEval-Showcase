# KunikOS 操作系统内核技术画像与评估报告

---

## 一、项目基本信息

| 条目 | 内容 |
|------|------|
| **项目名称** | KunikOS |
| **架构** | RISC-V64 (riscv64gc) + LoongArch64 (loongarch64) |
| **实现语言** | Rust（无 unsafe 之外的 FFI） |
| **生态归属** | 独立内核（非 Linux/BSD/RTOS 衍生），零第三方 crate 依赖 |
| **HAL 设计** | 编译期单态化 HAL 缝（同一内核 crate 对两套 ISA 一字不改） |
| **代码规模** | 18 个源文件，约 4167 行（含空行/注释）；HAL 约 1200 行（RV64）+ 1500 行（LA64） |
| **构建产物** | RISC-V64 ELF 1.6 MiB；LoongArch64 ELF 可通过编译 |
| **目标场景** | 全国大学生系统能力大赛（OS 内核赛道） |
| **核心特点** | 双 ISA 共享内核策略、从零手写 LA64 软件 TLB 重填与 PCIe ECAM 枚举、ext4 只读 + 全量内存文件系统、约 102 个 Linux ABI 系统调用 |

---

## 二、子系统实现清单

| 子系统 | 实现状态 | 说明 |
|--------|----------|------|
| 内存管理（分页/帧分配/内核堆） | 已实现 | Sv39（RV64）+ 四级软件 TLB（LA64）；64 MiB 首次适配堆分配器 |
| 进程管理（fork/clone/execve/wait4） | 部分实现 | RV64 完整；LA64 缺 fork/clone（stub） |
| 文件系统（ext4 + VFS） | 部分实现 | 只读 ext4（extent 树）+ 全量内存文件 + 合成 proc/sys |
| 块设备驱动（virtio-blk） | 已实现 | MMIO（legacy+modern）+ PCI modern 两条路径 |
| 网络子系统 | 部分实现 | 纯内存回环 UDP+TCP 配对，无硬件网络栈 |
| 系统调用层 | 已实现 | 约 102 个 syscall，`asm-generic` 编号体系 |
| 用户态切换 | 已实现 | 完整的上下文保存/恢复、trap 分发、超时机制 |
| 定时器/时间管理 | 已实现 | SBI set_timer（RV64）+ TCFG（LA64）；`clock_gettime`/`nanosleep` |
| 同步原语 | 已实现 | futex（busy-wait 简化）、自旋锁（堆分配器用 AtomicBool CAS） |
| 信号处理 | 部分实现 | 信号掩码真存储，投递为 no-op |
| 管道 | 已实现 | 单向字节流，fork 后语义隔离 |
| 启动管线 | 已实现 | 堆自检 → trap 往返 → 分页 → 块设备探测 → 测试集自动选择 |

---

## 三、各子系统实现完整度分析

### 3.1 硬件抽象层（khal）

**完整度：RISC-V64 约 90%；LoongArch64 约 70%**

**RISC-V64 侧实现**：
- Sv39 三级页表：1 GiB 大页恒等映射 RAM + 4 KB 页映射 MMIO，完整
- SBI 接口封装（console_putchar / shutdown / set_timer）：覆盖度足够，无额外 SBI 调用依赖
- 陷入处理：内核态仅 breakpoint，用户态完整处理 ecall + 定时器中断 + 通用异常（打印后终止）
- 用户态切换：`sscratch` 原子交换 sp、`sret` 返回、全寄存器保存/恢复，实现完整
- ELF 加载：PT_LOAD 段遍历、brk 设置、栈映射、初始栈布局（auxv 含 AT_PHDR/AT_PHENT/AT_PHNUM 等共 6 条），与 musl libc 兼容
- fork/clone：`spawn_child` 完整实现，通过 `walk_user_writable` 遍历快照用户可写页
- `mark_shared`：完整实现（标记区间，fork 时跳过）
- 时间：`rdtime` 指令，100 ns/tick
- `frame_watermark`：有返回值，用于帧分配器水位重置

**LoongArch64 侧实现**：
- 四级软件 TLB：`__la_tlb_refill` 从零手写，使用 `lddir`/`ldpte`/`tlbfill` 链式遍历，无效映射填 NR|NX 占位，实现完整且正确
- MMU 开启过程：DA 直址 → 恒等映射建立 → PWCL/PWCH/PGDL 配置 → TLB 重填入口安装 → `CRMD.PG=1` 翻转，步骤严格
- PCIe ECAM 枚举：遍历 bus 0 32 槽位、64 位 BAR 分配、capability 链表解析、现代 virtio-pci 握手，功能完整
- 用户态切换：`SAVE0` 原子交换 sp、`KernelContext` 保存 12 个 callee-saved 寄存器、`ertn` 返回，实现完整
- ELF 加载：auxv 含 AT_PHDR/AT_PHENT/AT_PHNUM/AT_PAGESZ/AT_RANDOM/AT_NULL 共 12 条，比 RV64 更丰富（AT_PHDR 用于 musl TLS 定位）
- 时间：`rdtime.d` 指令，10 ns/tick
- **缺失**：`spawn_child` 为 stub（直接返回 0），导致 fork/clone/wait4 流程在 LA64 上无法验证
- **缺失**：`mark_shared` 为 no-op（MAP_SHARED 在 fork 时无法被正确跳过）
- **缺失**：无 `frame_watermark` 实现（用内部 KERNEL_WATERMARK 常量替代）

**优点**：
- 编译期单态化设计使内核 crate 完全架构无关，HAL 接口契约非常精简（约 30 个导出符号）
- LA64 软件 TLB 重填是项目中最具技术深度的组件，正确实现与硬件 TLB 重填入口（`TLBRENTRY`）的集成
- PCIe ECAM 驱动在无任何 PCI 库辅助下完成全链路枚举

**缺点**：
- LA64 与 RV64 的功能不对称（fork 是重大差异），但接口契约未在编译期或运行期对此做出明确标记（调用方需自行确保仅在 RV64 上使用 fork）
- 两架构的 ELF 加载逻辑高度相似但分别重复实现（各约 120 行），未见共享的 ELF 解析抽象

---

### 3.2 内存管理

**完整度：约 70%**

**分页与帧分配**（khal 内部实现）：
- RV64：Sv39 三级硬件页表遍历。启动用 1 GiB 大页（`ROOT[2]` 的单个 PTE）恒等映射 `0x80000000` 起的全部 RAM。帧分配器起点为 `_ekernel` 向上对齐 4 KB，线性获取，无回收——每次 `reset_user_space` 通过 `frame_watermark` 重置分配器水位实现帧的批量回收。
- LA64：四级 4 KB 软件填 TLB。启动时恒等映射低 256 MiB（`0x0..0x1000_0000`）为 coherent cached，MMIO 区使用 strongly-ordered uncached 属性。`PGDL` 指向根页表，`TLBRENTRY` 安装重填入口。分配器同 RV64 的线性模型。

**内核堆**（`heap.rs`，约 149 行）：
- 算法：首次适配（first-fit）+ 相邻合并（coalescing），最小粒度 16 字节，16 字节对齐。
- 容量：64 MiB 静态区域。
- 并发：单 hart 顺序执行，使用 AtomicBool CAS 自旋锁仅满足 `GlobalAlloc` trait 的 `Sync` 约束。
- 初始化：惰性初始化——首次分配时将从 `.bss` 中获得的全零区域初始化为单一大空闲块。
- 正确性：经引导阶段测试（`Vec::with_capacity` + `extend_from_slice` 成功），验证了基本分配/释放/合并逻辑。

**用户空间内存管理**（khal 提供原语，kunikos 内核调用）：
- `set_user_brk` / `user_brk`：brk 堆管理，逐页向上增长（LA64 动态分配起始位置，RV64 紧随 ELF 段之后）
- `user_mmap`：在固定 VA 区域（LA64 为 `0x200000000` 起，RV64 为地址空间高区）分配匿名页
- `mark_shared`：标记 mmap 区间为 `MAP_SHARED`，fork 时跳过快照（仅 RV64 有效）

**优点**：
- 帧分配器的"水位重置"策略巧妙：在顺序执行模型的测试场景下，避免了页回收器（page reclaimer）的实现复杂度
- 内核堆分配器仅 149 行，但正确处理了块分裂、相邻合并、对齐等基本需求
- LA64 的 MMIO 映射使用正确的一致性属性（coherent cached vs. strongly-ordered uncached）

**缺点**：
- 帧分配器无回收（释放的单页无法重用），依赖"测试用例间全局重置"规避此问题
- 内核堆 64 MiB 固定容量，无动态扩展机制
- 无页表回收/Page Cache/swap，但对赛题场景非必需
- 内核堆的空闲链表维护在已分配块的元数据中——分配过的块若顺序释放则可合并，但长期运行的碎片化程度不可控

---

### 3.3 进程管理

**完整度：RV64 约 65%；LA64 约 30%**

**实现的功能**（均指 RV64）：
- `fork`：非 COW 的"全量快照"实现。通过 `walk_user_writable` 遍历所有用户可写 PTE，用 `Box<[u8; 4096]>` 逐页保存物理内容。子进程在副本陷入帧上同步运行（`a0=0, sepc+=4`），退出后逐页还原父进程内存。
- `clone`：支持 `CLONE_VM` 标志 → 线程路径（共享地址空间，直接运行子 trace）；无 `CLONE_VM` → fork 路径。支持 `CLONE_CHILD_SETTID`/`CLONE_CHILD_CLEARTID`（写 ctid 指针）。
- `execve`：完整实现（ext4 加载 → `load_elf` → `exec_replace` 单向进入新程序）。
- `wait4`：通过 32 槽僵尸表（`[Option<(pid, exit_code)>; 32]`）记录子进程退出状态，`wait4` 按 pid 查询。无多级进程树，仅记录一级父子关系。
- `getpid`／`getppid`／`gettid` 等标识符 syscall：已实现。

**未实现的功能**：
- LA64 的 `spawn_child` 为 stub，无法执行 fork/clone/wait4
- 无进程调度器——子进程同步执行完毕才返回父进程（赛题场景下所有测试程序串行，此模型可接受）
- 无多核/多 hart 并行
- 无进程优先级、cgroup、命名空间
- 仅 32 个僵尸槽位，超限行为未定义（代码中无溢出保护）
- 无真实信号投递（仅有掩码存储与 no-op 的"投递"）

**优点**：
- "同步 fork + 内存快照/还原"模型在没有调度器的前提下提供了语义正确的 fork，足以通过 LTP fork 相关测试
- fd 表的 `fork_push/fork_pop` 机制确保子进程的 fd 操作不影响父进程，语义正确
- 通过 `CLONE_VM` 标志区分线程与进程，为 pthread 创建提供了基础支持

**缺点**：
- LA64 侧功能缺失严重，双架构功能对称性差
- fork 的性能极差（逐页 `Box::new` 分配+拷贝+释放），但赛题场景无性能基准
- 僵尸表无溢出处理，连 fork 超过 32 个进程会导致静默失败
- 无进程树概念，`getppid` 在深层 fork 后可能返回错误值

---

### 3.4 文件系统

**完整度：约 55%**

**ext4 只读驱动**（`ext4.rs`，约 218 行）：
- 超级块解析：魔数验证、块大小（仅 4096）、inode 大小、inodes_per_group、块组数量
- 块组描述符表缓存：跨多块读取后缓存于 `Vec<u8>`
- extent 树遍历：支持多级索引（栈式遍历，depth>0 时读取子节点叶），叶节点收集 `(ee_block, ee_start, ee_len)` 三元组
- 文件读取：按 extent 列表批量读取，同文件内连续块合并为单次 DMA 请求（最多 64 KiB/次）；逻辑块空隙置零（支持稀疏文件）
- 目录遍历：仅支持根目录（inode 2）的直接查找，`lookup_root` 按名匹配目录项，`list_root` 列出全部名字
- **不支持**：间接块（indirect block）、写入、子目录递归、符号链接、扩展属性、日志、inode 权限/时间戳持久化

**内存文件系统**（`fs.rs`，约 729 行）：
- 数据模型：`Node { name, data: Vec<u8>, dir, names, atime, mtime }`，文件内容全量常驻内存
- fd 表：per-process 64 槽（`MAXFD=64`），fd 0/1/2 默认 Console，支持 `Fd::File`/`PipeR`/`PipeW`/`Null`/`Zero`/`Socket`/`Console`
- 管道：`PipeBuf { buf: Vec<u8>, rpos: usize }`，单向字节流，写端追加/读端推进，读空返回 0（EOF）
- fork 隔离：`fork_push` 保存父进程 fd 表快照到全局栈，子进程在活表上独立操作，`fork_pop` 还原
- 合成文件：动态响应 `/proc/meminfo`, `/proc/cpuinfo`, `/proc/sys/...`, `/proc/self/exe`, `/sys/devices/system/cpu/online` 等约 15 个路径，通过字符串匹配合成返回内容
- 路径解析：支持 `.`、`..`、绝对/相对路径，`chdir` 实现为文本级路径规范化（分隔 → 压栈/弹栈 → 重组）
- 文件操作：`openat`/`close`/`read`/`write`/`lseek`/`ftruncate`/`pread`/`pwrite`/`readv`/`writev`/`dup`/`dup3`/`pipe2`/`getdents64`/`stat`/`fstat`/`fstatat`/`statx`/`mkdir`/`unlink`/`getcwd`/`chdir`/`truncate`/`faccessat` 等均基于内存模型实现

**优点**：
- ext4 驱动虽仅 218 行，但正确实现了 extent 树的多级遍历，支持大文件和稀疏文件
- 全量内存模型配合"每次测试 reset"策略，语义完全正确且无回写复杂度
- 合成 `/proc` 文件系统以最小代价满足了 LTP 框架的大量路径访问需求
- 路径规范化处理正确（支持 `..` 越界处理和绝对/相对路径混合）

**缺点**：
- 文件系统完全的只读：ext4 驱动只读，内存操作不写回，断电丢失所有修改
- ext4 仅支持 4096 字节块，不支持间接块——对仅 extent 格式的现代 ext4 可工作，但严格来说不完整
- 目录仅支持根目录一级，无子目录递归，`openat` 搭配子路径会失败
- 合成文件数量有限，若 LTP 测试访问未预置的 `/proc` 路径会得到错误数据
- fd 表 64 槽上限对复杂测试可能不足

---

### 3.5 virtio-blk 块设备驱动

**完整度：约 80%**

**共用核心**（virtio-blk 协议层，约 300 行）：
- split virtqueue：16 描述符（`QSIZE=16`），`desc`/`avail`/`used` 三区以 `#[repr(C, align(4096))]` 精确排布满足设备对齐要求
- 单次读请求：3 描述符链（BlkReq 16B 输出 + 数据缓冲输入 + 状态字节输入），通知设备后自旋等待 `used.idx` 变化
- DMA 直接写入目标缓冲区：无弹跳缓冲、无地址翻译（VA=PA）
- 批量读优化：连续物理块合并为单次请求，最大 64 KiB（`DATA_MAX=0x10000`）

**RISC-V64 传输层**（virtio-mmio，约 80 行）：
- 扫描 `0x10001000` 起的 8 个 MMIO 槽位（stride 0x1000）
- 支持 legacy（QueuePFN）和 modern（VIRTIO_F_VERSION_1 协商+三区分别配置）两条路径

**LoongArch64 传输层**（virtio-pci modern，约 100 行）：
- ECAM 枚举：bus 0，32 槽位，读 vendor/device/class/revision 寄存器
- 64 位 BAR 解析：BAR0/1 地址从 ECAM 读出，在预映射窗口 `0x40000000..0x41000000` 中分配
- 现代能力解析：偏移 0x34 找 capability pointer，遍历链表找 vendor-specific (0x09)，解析 bar/offset/length 定位 common_cfg/notify_cfg/isr_cfg/device_cfg
- 现代握手：设备 ID 验证、feature 协商、队列配置、DRIVER_OK 置位

**不支持**：
- 写请求（仅有 VIRTIO_BLK_T_IN 的读路径，无 VIRTIO_BLK_T_OUT）
- 多队列、VIRTIO_F_INDIRECT_DESC、MSI-X 中断
- 16 描述符对高并发场景可能不够（但顺序执行模型下单次仅一个请求在飞）

**优点**：
- 共用协议层在 MMIO 和 PCI 两条传输路径间完全复用，未受传输介质差异影响
- LA64 PCI 现代路径手写能力突出，在无 PCI 库依赖下完成全链路枚举与配置
- 批量读优化（连续块合并）将大文件（如 1 MiB ELF）的 I/O 往返次数压缩约 16 倍

**缺点**：
- 仅支持读，不支持写——配合内存文件系统的"不回写"策略可工作，但严格限制了文件系统的能力
- 描述符仅 16 个，对于大文件批量读（合并后单次 64 KiB）足够，但读复杂 extent 布局的文件可能多次往返
- 自旋等待无超时机制——若设备无响应，内核将永久挂起

---

### 3.6 网络子系统

**完整度：约 40%**

**实现功能**：
- socket 创建：`socket(AF_INET, type, 0)`，支持 `SOCK_DGRAM`（UDP）和 `SOCK_STREAM`（TCP）
- UDP 数据报：`sendto` 按端口推入目标 socket 的 `dgrams: Vec<Vec<u8>>`；`recvfrom` 从队列取出并返回源端口
- TCP 模拟：`listen` 标记 socket，`connect` 查找 listening socket 并创建 peer socket 推入 `backlog`，`accept` 从 backlog 弹出并分配新 fd
- 地址管理：`bind`、`getsockname`、端口号大端序解析
- 与 fd 表集成：`Fd::Socket(usize)` 和 `install_socket`

**不支持**：
- 无真实网络设备驱动
- 无 IP 层（无路由、无 ARP）
- 无 TCP 状态机（无三次握手、无超时重传、无流控、无拥塞控制）
- 无 epoll/kqueue 事件通知
- 无 `SOCK_RAW`、`AF_UNIX`、`AF_PACKET` 等 socket 类型

**优点**：
- 纯内存回环模型在单进程 LTP socket 测试中语义正确
- TCP 模拟通过 listen/connect/accept 配对使 `socketpair` 语义可工作
- 代码量极少（159 行），零外部依赖

**缺点**：
- 无法通过任何需要真实 TCP 语义的测试（如双向数据流、半关闭、keepalive）
- TCP backlog 无大小限制，`connect` 过多会导致内存无界增长
- 无端口冲突检测（可重复 bind 同一端口）

---

### 3.7 系统调用层

**完整度：约 75%**

**实现规模**：约 102 个系统调用号被分发（含完整实现和"平凡满足"两类）

**真实现（约 60 个）**：
- 文件 I/O 全系列：openat/close/read/write/lseek/ftruncate/pread/pwrite/readv/writev/getdents64/dup/dup3/pipe2/fstat/fstatat/statx
- 目录操作：getcwd/mkdir/unlink/chdir
- 内存管理：brk/mmap/munmap/mprotect
- 进程管理（仅 RV64）：clone/execve/wait4/exit/set_tid_address
- 时间：gettimeofday/clock_gettime/nanosleep/clock_nanosleep
- 网络 socket API：socket/bind/listen/accept/connect/getsockname/sendto/recvfrom/setsockopt
- futex：FUTEX_WAIT/FUTEX_WAKE（忙等简化）
- ppoll：同步标 fd 就绪
- getrandom：LCG 伪随机数

**"平凡满足"（约 35 个）**：语义合法的退化实现或返回固定值/errno
- 信号：sigaction/sigprocmask（掩码真存储，投递 no-op）、kill/TKILL/tgkill（返回 0）
- 资源限制：prlimit/getrlimit/setrlimit（RLIMIT_NOFILE 真处理，其余返回大值）
- 内存锁：mlock/munlock/mlockall/munlockall（恒成功）
- 同步：msync（恒成功）、set_robust_list（恒 0）
- 调度：sched_yield/sched_getaffinity/sched_setaffinity（返回 0）
- 权限：getuid/setuid/chmod/fchown 系列（返回 root=0 或恒成功）
- 其他：fcntl（有限支持）、mount/umount2（恒 0）、mknodat/symlinkat/linkat（返回 -EPERM 或 -ENOSYS）

**未实现的系统调用**：约 40 个——返回 `-ENOSYS`(-38)，如 sendfile、splice、copy_file_range、ioprio_set、capset 等

**优点**：
- 102 个系统调用的分发覆盖了 libc-test 和 LTP 框架所需的主要接口
- "平凡满足"类系统调用设计合理——在保证语义不冲突的前提下最小化实现（如 mlock 在无交换的内核中恒成功是正确的）
- getrandom 使用 LCG 以时间 CSR 为种子，虽非密码学安全但满足了 musl libc 初始化随机性需求
- ppoll 的同步就绪标记策略在顺序执行模型下语义正确

**缺点**：
- futex 的忙等实现而非睡眠/唤醒——虽通过 pthread join 测试，但严重浪费 CPU 时间
- 信号投递完全 no-op——满足 libc 初始化需求但无法处理任何实际的信号场景
- 部分"平凡满足"可能隐藏真实错误（如 mount/mlock 恒成功可能导致测试误判）
- 系统调用号全量硬编码于 `match` 中，新增调用需修改内核主体

---

### 3.8 同步原语

**完整度：约 35%**

**实现的原语**：
- futex：FUTEX_WAIT 忙等比较 `*addr == val`（上限约 5 秒，防止死锁）；FUTEX_WAKE 恒返回 0
- 内核堆分配器自旋锁：`AtomicBool` CAS 实现，保护空闲链表操作
- 无其他内核级锁（无 Mutex/RwLock/Semaphore/Condvar 等）

**未实现**：
- 无真正的睡眠/唤醒机制（futex 无等待队列）
- 无多核同步（内核仅支持单 hart 顺序执行）
- 无 RCU/RCU-sched/seq_lock 等高级同步原语

**优点**：
- futex 的忙等实现简单可靠，在单 hart 顺序执行模型下不会产生竞争
- 堆分配器的自旋锁纯粹为满足 Rust `GlobalAlloc` trait 的并发安全签名需求，实际场景中无竞争

**缺点**：
- futex 非真正睡眠使其无法用于需要阻塞等待的场景（如生产者-消费者模型）
- 无等待队列意味着 FUTEX_WAKE 的"唤醒"语义完全丧失
- 若未来引入多 hart 支持，现有同步原语完全不足以提供正确性保证

---

### 3.9 交互设计

**完整度：约 60%**

**人机交互**：
- 启动日志：从 `[KunikOS] booting on riscv64/loongarch64` 到各阶段自检结果均有 `kprintln` 输出，清晰展示引导进度
- 错误信息：trap 异常、系统调用错误均有描述性输出（如 `khal trap from user: scause=..., stval=..., sepc=...`）
- 无交互式 shell、无命令行、无调试器接口

**程序交互**：
- 用户程序通过标准 Linux ABI（ecall + 系统调用号）与内核交互
- 标准输入/输出/错误（fd 0/1/2）绑定 Console，支持 ANSI 转义序列直写
- 初始环境变量：`LTP_IPC_PATH=/ltpipc`（供 LTP 框架 IPC 测试使用）

**测试框架集成**：
- 启动管线自动根据磁盘内容选择测试集（libc-test/LTP/lua/basic）
- LTP 模式下遍历根目录 ELF 并逐一运行，输出 FAIL 标记
- 无测试结果汇总、无 PASS/FAIL 统计

**优点**：
- 引导日志分级清晰，关键阶段（heap/trap/paging/virtio-blk）均进行自检并输出结果
- 测试集自动选择逻辑实用，同一内核镜像可适配不同测试磁盘

**缺点**：
- 无用户交互界面（无可输入的命令行），所有行为预编程在启动管线中
- 测试输出格式单一（仅 `FAIL LTP CASE name: code`），无 PASS 计数器、无总览

---

## 四、动态测试设计及结果

### 4.1 测试环境

| 项目 | 配置 |
|------|------|
| 模拟器 | QEMU virt (riscv64) |
| SBI 固件 | OpenSBI v1.3 |
| 内存 | 128 MiB (RISC-V64) / 256 MiB (LoongArch64) |
| 块设备 | virtio-blk (无磁盘镜像时设备缺失) |

### 4.2 裸机启动测试（已执行）

**测试条件**：无磁盘镜像，仅验证引导管线。

**测试结果**（完整输出）：

```
OpenSBI v1.3 ... Boot HART Domain: root ...
[KunikOS] booting on riscv64
[KunikOS] heap ready: [0, 1, 4, 9, 16, 25, 36, 49]
[khal] trap handled: breakpoint, resume at 0x80202176
[KunikOS] trap round-trip ok
[KunikOS] paging + frame alloc + dynamic map ok (paged-heap-ok)
[KunikOS] boot pipeline ok
[KunikOS] no virtio-blk device
```

**逐阶段验证结果**：

| 阶段 | 预期行为 | 实际结果 |
|------|----------|----------|
| _start → kunikos_main | 栈设置成功，进入 Rust | 通过 |
| 堆冒烟测试 | Vec push 8 个平方数 | 通过（输出 `[0,1,4,9,16,25,36,49]`） |
| trap 安装 + ebreak 往返 | 内核态陷入 → breakpoint 处理 → 跳过指令 | 通过（`resume at 0x80202176`） |
| 分页开启 + 帧分配 + 动态映射 | Sv39 开启后 Vec::with_capacity/extend_from_slice 成功 | 通过（`paged-heap-ok`） |
| virtio-blk 探测 | 扫描 MMIO 槽位，无设备时优雅退出 | 通过（`no virtio-blk device`） |

### 4.3 功能测试（基于设计文档，未在本次环境中执行）

以下为设计文档声明的测试通过率，本报告仅引述不作验证。

| 测试集 | RISC-V64 | LoongArch64 |
|--------|----------|-------------|
| basic（32 个独立 ELF） | 32/32 | 32/32 |
| libc-test（musl libc 测试套件） | 94/95 | 93/95 |
| lua（9 个脚本） | 9/9 | — |
| LTP（Linux Test Project） | 约 106 个用例 | 约 194/243（约 80%） |

### 4.4 静态检查结果

| 检查项 | RISC-V64 | LoongArch64 |
|--------|----------|-------------|
| 交叉编译（`cargo build --release`） | 通过 | 通过 |
| clippy lint（`cargo clippy --release`） | 零警告 | 零警告 |

### 4.5 测试评价

**优点**：
- 裸机引导管线的每个关键阶段均设有自检点，可在无测试磁盘时验证内核基础正确性
- 双架构 clippy 零警告体现了较高的代码质量

**局限**：
- 本次环境未挂载磁盘镜像，未能执行 libc-test/LTP 等上层测试
- 所有功能测试数据来源于项目文档，未经本报告独立验证
- LA64 的 QEMU 启动测试未在本环境中执行（仅有交叉编译验证）

---

## 五、细则评价表格

### 5.1 内存管理

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 已实现，完整度约 70% |
| **关键发现** | 1. RV64 Sv39 和 LA64 四级软件 TLB 两套完全不同的分页机制均正确实现。2. 帧分配器采用线性分配+水位重置策略，无单页回收。3. 内核堆使用首次适配算法，支持相邻合并，经引导阶段自检验证。 |
| **评价** | LA64 的软件 TLB 重填是项目中最具技术挑战性的组件，实现质量较高。但帧分配器缺乏单页回收能力，依赖"测试间全局重置"，在需要长期运行的场景下会耗尽物理内存。内核堆分配器功能基本完整但算法简单，无碎片整理的工程考量合理（4167 行代码规模下）。 |

### 5.2 进程管理

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 部分实现，RV64 约 65%，LA64 约 30% |
| **关键发现** | 1. fork 采用非 COW 的全量快照+还原策略，语义正确但性能代价极大。2. clone 正确区分 CLONE_VM 线程与进程。3. LA64 的 spawn_child 为 stub，导致 fork/clone 在 LA64 上完全不可用。4. 无调度器，子进程同步执行。 |
| **评价** | "同步 fork"在无调度器的约束下是一个合理的工程设计。但内存快照策略（每页 Box::new 分配+拷贝+释放）在大地址空间场景下可能极其缓慢。LA64 侧功能缺失严重，是双架构功能不对称性最突出的表现，直接影响 LTP 测试通过率差异（RV64 约 106 vs LA64 约 194——注意 LA64 通过率更高可能源于不同测试集）。 |

### 5.3 文件系统

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 部分实现，完整度约 55% |
| **关键发现** | 1. ext4 驱动仅 218 行但实现了 extent 树多级遍历，支持稀疏文件。2. 全量内存文件模型消除了回写复杂性，配合每测试 reset 语义正确。3. 合成 /proc 文件系统以最小代价满足了 LTP 框架需求。4. 不支持写入、子目录、间接块、符号链接。 |
| **评价** | 以 947 行（ext4 218 + fs 729）实现了一个能通过 libc-test 和 LTP 的文件系统栈，工程效率极高。合成 /proc 的思路务实且有效。局限在于 ext4 驱动严格只读且仅支持根目录——对于复杂文件操作测试不够用，但在赛题既定测试集内已足够。 |

### 5.4 交互设计

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 部分实现，完整度约 60% |
| **关键发现** | 1. 启动日志引导管线清晰，各阶段自检结果显式输出。2. 测试集根据磁盘内容自动选择。3. 无任何交互式界面、命令解析或运行时控制。 |
| **评价** | 面向自动化测试的设计思路使交互设计着重于日志可读性和测试自动选择。在 OS 比赛场景下这是务实的取舍——交互式 shell 不贡献测试通过率。LTP 模式下逐个 ELF 运行的 FAIL 标记输出格式虽简朴但足够使用。 |

### 5.5 同步原语

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 部分实现，完整度约 35% |
| **关键发现** | 1. futex 采用 busy-wait 而非睡眠/唤醒，FUTEX_WAKE 恒返回 0。2. 内核仅有一个自旋锁（堆分配器用），无 Mutex/RwLock/信号量。3. 单 hart 顺序执行模型使竞态条件不存在。 |
| **评价** | 在单 hart 顺序执行的前提下，当前同步原语实现虽简化但足够。但若内核未来引入中断驱动 I/O 或多 hart 支持，现有同步机制完全不足以提供正确性。futex 的 busy-wait 上限（约 5 秒）是一个带有工程经验值的务实设计——既防止死锁又满足 pthread 初始化语义。 |

### 5.6 资源管理

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 基本实现，完整度约 60% |
| **关键发现** | 1. fd 表 64 槽 per-process，fork 时有快照/恢复机制。2. 僵尸进程表 32 槽，无溢出保护。3. 帧分配器水位重置机制实现用户空间内存的批量回收。4. RLIMIT_NOFILE 真处理（返回 64）。5. 无内核资源耗尽保护、无 OOM killer。 |
| **评价** | 资源管理采用静态上限策略（fd 64、僵尸 32、堆 64 MiB），在赛题的有限测试集内不会触发上限。但缺乏动态资源监控和优雅降级机制——一旦超出上限，行为未定义（僵尸表溢出静默覆盖，fd 表溢出返回错误但错误传播路径不完整）。帧分配器水位重置是简洁有效的资源回收策略。 |

### 5.7 时间管理

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 已实现，完整度约 80% |
| **关键发现** | 1. RV64 读 rdtime（100ns/tick）+ SBI set_timer 实现超时。2. LA64 读 rdtime.d（10ns/tick）+ TCFG 周期模式定时器。3. clock_gettime/gettimeofday/nanosleep/clock_nanosleep 均已实现。4. 定时器中断处理正确区分"周期 tick"和"超时"两种事件（超时则 kill 用户程序）。 |
| **评价** | 时间子系统实现质量较高，双架构的时间 CSR 读取、定时器配置、中断处理均正确。超时机制直接 kill 用户程序（exit code 124）而非发送 SIGALRM，是一种简化但有效的策略。nanosleep 的实现（从代码中可知基于 arm_timeout 和 yield 循环）在无调度器的顺序执行模型下语义正确（精确延迟而非上下文切换）。 |

### 5.8 系统信息

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 部分实现，完整度约 55% |
| **关键发现** | 1. sysinfo 系统调用返回合理数据（uptime、totalram 等）。2. uname 通过合成 /proc/sys/kernel/osrelease 等路径提供内核版本信息。3. /proc/cpuinfo 和 /proc/meminfo 返回合成数据。4. statfs/fstatfs 返回合成 ext4 超级块信息。5. 无真实的硬件拓扑信息、无温度/频率/电源管理信息。 |
| **评价** | 系统信息查询功能以满足 LTP 框架需求为目标实现，合成数据的数值经过挑选（如 262144 kB total memory）以确保测试框架的解析不报错。`sysinfo` 的 uptime 基于时间 CSR 计算。对于教学内核而言，信息丰富度合理。 |

### 5.9 双架构兼容性（补充条目）

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 部分实现，设计完整性约 85%，实现对称性约 70% |
| **关键发现** | 1. 编译期单态化 HAL 缝是实现双架构兼容的核心机制，设计优雅且高效。2. RV64 与 LA64 共享 100% 的非 HAL 代码（kunikos crate + virtio-blk 核心 + ext4 + fs + net）。3. 但 LA64 的 spawn_child 为 stub、mark_shared 为 no-op，导致 fork/MAP_SHARED 等语义在 LA64 上不可用。4. ELF 加载器的 auxv 在两架构间存在差异（LA64 多出 AT_PHDR/AT_PHENT/AT_PHNUM）。5. LA64 需要额外的 PCIe ECAM 驱动（RV64 使用 MMIO 传输层）。 |
| **评价** | 编译期单态化 HAL 缝是项目的核心架构创新，它使得内核策略代码（约 2500 行）真正实现了一次编写双架构复用。但"缝"的两侧不对称——LA64 的 stub/no-op 破坏了接口契约的一致性。理想情况下，`spawn_child` 在 LA64 上应返回 `-ENOSYS` 而非静默成功（返回 0），以向上层明确暴露功能缺失。 |

### 5.10 构建系统与工程质量（补充条目）

| 评价项 | 内容 |
|--------|------|
| **是否实现及完整度** | 已实现，完整度约 85% |
| **关键发现** | 1. Cargo workspace 结构清晰，零外部依赖。2. 链接脚本（lds）为两架构分别提供。3. 通过 RUSTFLAGS 传递链接脚本路径和 extra link args。4. 双架构 clippy 零警告，代码质量较高。5. 无 CI/CD 配置、无自动化测试脚本。6. 无文档生成（无 doc comments）。 |
| **评价** | 构建系统简洁有效，Cargo workspace 使用规范。零外部依赖在 Rust 生态中高度非典型且需要较大工程量。clippy 零警告说明开发者对 Rust 代码质量有明确要求。但缺乏 CI 配置使得回归测试无法自动化，缺乏文档注释降低了代码的可维护性。 |

---

## 六、总结评价

KunikOS 是一个以 OS 比赛为导向、从零构建的双架构教学内核。其在约 4167 行 Rust 代码中实现了以下核心能力：

1. **RISC-V64 和 LoongArch64 双 ISA 支持**，通过编译期单态化 HAL 缝实现了内核策略代码的无差别复用。
2. **两套完全不同的分页机制**：Sv39 硬件页表遍历（RV64）和四级软件 TLB 重填（LA64），后者从零手写且正确与 TLB 重填入口集成。
3. **从 ECAM 枚举到手写现代 virtio-pci 传输路径**的完整 LoongArch virtio-blk 驱动，无任何外部 PCI 库依赖。
4. **约 102 个 Linux ABI 系统调用**的覆盖度，支持文件 I/O、进程管理（RV64）、内存管理、时间、socket、futex 等主要子系统。
5. **只读 ext4（含 extent 多级索引树）+ 全量内存文件系统 + 合成 /proc**，以约 947 行代码通过 libc-test 和 LTP 框架所需的文件操作。

项目的核心优势在于**工程效率和关键技术深度**：在极少代码量内实现了双架构支持，且 LA64 的软件 TLB 和 PCIe ECAM 驱动触及了底层系统编程的高难度领域。

项目的核心局限在于**单 hart 顺序执行模型**和 **LA64 与 RV64 的功能不对称**。前者是约 4100 行代码规模下的合理取舍，后者则是 HAL 接口契约完整性上的明显不足——`spawn_child` 的 silent stub 可能让依赖 fork 的测试在 LA64 上以非预期方式通过或失败。此外，文件系统只读、网络仅内存回环、futex 为 busy-wait 等简化使得内核无法在真实的复杂应用场景下工作，但在赛题限定的测试集范围内是充分的。

**综合评估**：KunikOS 在 OS 内核赛道的语境下，以高度压缩的代码规模实现了令人印象深刻的功能覆盖度和双架构支持能力。其编译期 HAL 缝合设计、LA64 软件 TLB 重填、以及"够用就好"的各子系统简化策略，共同构成了一个在技术深度与工程效率之间取得良好平衡的作品。LA64 侧的 fork 缺失和部分 HAL API 的不对称性是当前最值得改进的方向。