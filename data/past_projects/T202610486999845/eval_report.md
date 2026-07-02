# alRED OS 内核项目技术画像与评估报告

## 一、项目基本信息

| 条目 | 内容 |
|---|---|
| 项目名称 | alRED OS (OSKernel2026-alREDy) |
| 目标架构 | RISC-V64 (rv64gc) 为主，LoongArch64 为辅 |
| 实现语言 | Rust (edition 2024)，少量 RISC-V/LoongArch 汇编 |
| 代码规模 | RISC-V 端约 47,200 行；LoongArch 端约 3,800 行 |
| 生态归属 | 面向全国大学生计算机系统能力大赛 OS 内核设计赛 |
| 运行环境 | QEMU virt 机器，OpenSBI/RustSBI 固件 |
| 核心特点 | 大规模 Linux ABI 兼容层(282 个 syscall)；Eager Fork 快照机制；内存 Overlay VFS；Compat Bridge 渐进式测试迁移策略 |

---

## 二、子系统实现总览

| 子系统 | 涉及文件 | 代码量(行) | 实现完整度 | 核心功能 |
|---|---|---|---|---|
| 启动与初始化 | `main.rs`, `entry.asm`, `lang_items.rs`, `linker-qemu.ld` | ~150 | 完整 | BSS 清零，陷阱向量设置，SBI 关机 |
| 陷阱/异常处理 | `trap/trap.S`, `trap/mod.rs`, `trap/context.rs`, `arch.rs` | ~400 | 完整(当前需求) | 系统调用分发，页错误懒分配，信号投递 |
| SBI 接口层 | `sbi.rs` | ~80 | 完整 | 字符输出，关机 |
| 同步原语 | `sync/up.rs` | ~35 | 完整(单核) | UPSafeCell (基于 RefCell) |
| 设备驱动 | `drivers/virtio.rs` | ~330 | 60% | 单队列轮询只读 virtio-blk，Legacy/Modern 双模式 |
| 文件系统 | `fs/ext4.rs` | ~430 | 85% | 只读 EXT4 解析，extent 映射，目录遍历 |
| 内存管理 | `task/user.rs` | ~2,200 | 80% | Sv39 页表，静态帧池(~80MB)，懒分配，fork 快照，协作线程 |
| ELF 加载器 | `loader/elf.rs` | ~430 | 90% | 静态/动态 ELF，musl/glibc 双链接器 |
| 系统调用层 | `syscall/mod.rs`, `syscall/fs.rs`, `syscall/process.rs` | ~30,000 | 60%/75%* | 282 个 Linux syscall，Overlay VFS，futex，信号，socket 模拟 |
| 评测 Harness | `platform/contest/mod.rs` | ~12,100 | 85% | 11 个测试组自动执行，compat bridge |
| LoongArch 端 | `os-la/` 下所有文件 | ~3,800 | 15% | 框架存在，缺 MMU 后端和用户态运行 |

*注: 60% 为相对完整 Linux ABI 实现的基准；75% 为相对竞赛测试集需求的基准。

---

## 三、子系统详析

### 3.1 启动与初始化子系统

**实现细节**:
- 汇编入口 `_start` 在 `.text.entry` 段设置 64KB 启动栈，跳转 `rust_main`
- `clear_bss()` 通过 `sbss`/`ebss` 符号归零 BSS 段
- 链接脚本将内核基址设为 `0x80200000` (RISC-V QEMU virt 默认加载地址)
- Panic 处理通过 SBI System Reset Extension 实现关机

**优点**: 实现精简高效，无冗余初始化步骤；panic 信息包含位置和消息，便于调试。

**缺点**: 启动栈大小(64KB)固定，无溢出检测机制。

**完整度**: 完整覆盖内核启动到主循环的最小路径。

---

### 3.2 架构抽象与陷阱处理

**RISC-V 端细节**:
- `arch.rs` 封装 `sstatus`, `stvec`, `scause`, `stval`, `time`, `satp` 等关键 CSR
- `sstatus.FS` 预设为 Dirty，避免用户态浮点指令触发异常（为 LTP/libc 格式化路径设计）
- 陷阱入口 `__alltraps` 通过 `sscratch` 交换用户栈与内核栈指针，分配 34×8=272 字节 TrapContext
- x4(tp) 被明确保留，因为 pthread 线程切换依赖 TLS/TCB 指针
- 所有中断（含时钟中断）直接返回用户态，无抢占式调度
- 页错误路由至 `task::handle_user_page_fault()` 支持懒分配

**LoongArch 端细节**:
- `arch.rs` 使用 `csrwr`/`csrrd` 操作 LoongArch CSR (CRMD, ECFG, ERA 等)
- `write_satp()` 为占位实现，仅执行 `dbar 0`
- 用户态特权级通过 `PRMD_PPLV_USER | PRMD_PIE` 设定

**优点**: RISC-V 端完整覆盖当前所有异常类型；浮点 CSRs 预设避免大量 LTP 测试异常；tp 保留设计适配 pthread 需求。

**缺点**: 无时钟中断驱动的抢占调度；无 FPU 上下文懒保存机制；LoongArch 端仅为框架。

**完整度**: RISC-V 端 90% (缺抢占调度和 FPU 懒保存)；LoongArch 端 20%。

---

### 3.3 SBI 接口层

**实现细节**:
- 同时支持 legacy SBI (`console_putchar` EID=1) 和 SBI v0.2+ (SRST extension EID=0x53525354)
- `shutdown(failure)` 通过 SRST extension 关机，failure=true 时报告系统失败

**优点**: 实现简洁，精确覆盖所需功能。

**缺点**: 仅支持字符输出和关机两个原语，无 timer 等扩展 SBI 功能调用。

**完整度**: 完整覆盖内核所需的最小 SBI 接口。

---

### 3.4 同步原语

**实现细节**:
- 仅提供 `UPSafeCell<T>` (基于 `RefCell`)，通过 `unsafe impl Sync` 标记为线程安全
- 获取借用失败时直接 panic

**优点**: 在单核无抢占环境下正确且高效。

**缺点**: 实际使用中大部分全局状态直接使用 `static mut` 而非该原语；`#![allow(static_mut_refs)]` 被广泛使用，说明同步原语未充分覆盖业务需求。

**完整度**: 原语本身的单核场景完整度为 100%，但在项目中的实际应用覆盖度约为 20%。

---

### 3.5 设备驱动子系统

**实现细节**:
- 单队列轮询式 virtio-blk 驱动，同时支持 Legacy MMIO 和 Modern MMIO
- 通过 `VIRTIO_MMIO_VERSION` 寄存器自动检测传输模式
- 队列深度: 8 描述符，每次 I/O 使用 3 描述符，最多支持 2 个并发请求
- 仅支持 `VIRTIO_BLK_T_IN` (读操作)，每次读取一个 512 字节扇区
- MMIO 基址硬编码为 `0x1000_1000`

**优点**: Legacy/Modern 双模式兼容性好；自动版本检测机制灵活。

**缺点**: 无写操作支持；无多队列或中断驱动 I/O；硬编码 MMIO 基址降低了可移植性；轮询模式降低 I/O 效率。

**完整度**: 60% (基准: 全功能 virtio-blk 驱动，含读写、中断驱动、多队列)。

---

### 3.6 文件系统子系统

**实现细节**:
- 从 1024 字节偏移处读取 superblock，验证 magic (0xEF53)
- 支持 block_size 1024/2048/4096，inode_size 通常 256 字节
- 检测 `FEATURE_INCOMPAT_64BIT` 标志
- 目录遍历通过线性扫描目录项实现
- 文件读取支持 extent 映射 (`EXT4_EXTENTS_FL`)，递归解析 extent 树/内部节点/叶子节点
- `for_each_child` 提供带回调的流式遍历，用于 LTP bin 目录枚举

**优点**: 仅实现只读需求，代码量精简；extent 解析正确处理了内部节点递归和叶子节点数据块映射。

**缺点**: 不支持间接块映射(仅 extent)；不支持符号链接内联数据读取；不支持写操作和日志恢复。

**完整度**: 85% (基准: 完整只读 EXT4 实现，含所有映射方式和符号链接快速路径)。

---

### 3.7 内存管理子系统

**实现细节**:
- Sv39 三级页表，用户空间 0..0x0e80_0000 (~232MB)，内核 0x8000_0000 起恒等映射 128MB (2MB 大页)
- 静态帧池: `USER_FRAMES` 约 80MB (20 * 1024 - 4 个帧)，使用 u16 作为帧索引
- 懒分配: 页错误处理仅映射已 `reserve_user_range` 但未分配物理帧的页
- Eager Fork 快照: `MAX_FORK_FRAMES` 为 4800 帧(约 19MB)，支持 3 层嵌套 fork
- 协作线程: `MAX_PENDING_THREADS` 63 个，`MAX_READY_THREADS` 64 个，每个线程独立 32KB 内核栈
- 共享内存: MAP_SHARED 匿名页在 fork 后父子共享物理帧
- 信号 Trampoline: `__signal_rt_sigreturn_stub` 放置在栈区下方一页

**优点**: Eager Fork 是在无 MMU 上下文切换环境中的创新 fork 替代方案；懒分配使虚拟地址空间远大于物理帧池；静态帧池避免了动态分配器的复杂度；partial fork (FORK_SKIP) 优化了 I/O 密集型测试的内存开销。

**缺点**: 无 COW (Copy-On-Write) fork，fork 内存开销大；无页面回收/swap；无透明大页；帧分配器采用线性扫描，效率较低；协作线程模型不支持抢占式多任务。

**完整度**: 80% (基准: 含 COW fork、页面回收、多级分配器的完整单核虚拟内存管理)。

---

### 3.8 ELF 加载器

**实现细节**:
- 支持 ET_EXEC (静态 PIE) 和 ET_DYN (动态 PIE)
- 动态解释器基址: `DYNAMIC_LINKER_BASE` = 0x200_0000
- 自动检测 musl ld 或通过 INTERP 段检测 glibc ld
- 解析 ELF64 header 并验证 magic、class、endianness、machine (RISC-V: 243)
- PT_LOAD 段按页对齐加载，PT_PHDR 记录并传递给 auxv
- 用户栈构造包含 argc、argv、envp、auxv 的完整 Linux 兼容布局
- 特殊模式: `run_user_program_with_args_preserve_overlay()` 支持跨命令 overlay 保留

**优点**: 完整支持静态/动态 ELF 和 musl/glibc 双链接器；auxv 传递规范；特殊加载模式适配 lmbench 等测试需求。

**缺点**: 未见 PT_TLS (TLS 段) 的初始化处理；依赖动态链接器自行处理重定位，无内核级重定位支持；无 ASLR。

**完整度**: 90% (基准: 含 TLS 初始化和 ASLR 的完整 ELF 加载器)。

---

### 3.9 系统调用层

**实现细节**:
- `syscall::syscall()` 分发约 282 个系统调用分支
- `SyscallResult` 枚举区分普通返回值(`Value`)和上下文切换(`Switch`，clone/execve)
- Overlay VFS: 底层为 EXT4 只读 backing，覆盖层为 `MemFile` 数组，支持读、写、truncate
- 文件描述符表: `MAX_FD` = 1024，支持 15+ 种文件类型
- 套接字: AF_INET/AF_INET6 通过 127.0.0.1/::1 模拟 loopback，AF_UNIX 通过路径匹配，固定大小 packet 缓冲区
- Futex: 高度裁剪，无真正等待队列，通过线程上下文排队间接实现同步
- 进程管理: 完整实现 clone/fork/execve/wait/信号/futex 路径
- System V IPC: 信号量、消息队列、共享内存均有实现

**优点**: 282 个已注册系统调用是目前所见 OS 比赛项目中数量最多的之一；Overlay VFS 使测试程序可在只读镜像上写入；文件描述符类型丰富(15+ 种)；System V IPC 完整实现。

**缺点**: 大量系统调用为 stub 或简化实现(如 bpf 仅处理少数命令，套接字无真实网络栈)；syscall/fs.rs 和 syscall/process.rs 中存在 150+ 个 `static mut` 全局变量，耦合度极高；futex 实现无真正等待队列，PI futex 直接返回 0。

**完整度**: 60% (相对完整 Linux ABI)；75% (相对竞赛测试集需求)。

---

### 3.10 评测 Harness

**实现细节**:
- 顶层 `run_contest_groups()` 按顺序调度 11 个测试组
- 每个测试组在 EXT4 中查找对应目录，按 musl -> glibc 顺序遍历
- 发现 `*_testcode.sh` 脚本或可执行文件后逐条解释或直接执行
- 输出平台要求的日志格式
- Compat bridge: 9 种分类 bridge，约出现 59 次，生成等价通过输出
- LTP 输出跟踪: 解析 LTP 的 passed/failed/broken/skipped/warnings 统计行

**优点**: 测试组覆盖全面(11 个大类)；Compat bridge 策略务实，保证评测流程不断；LTP 输出跟踪自动解析测试结果。

**缺点**: 约一半 LTP case 通过 bridge 而非真实执行；部分测试组(如 iperf/netperf)依赖模拟网络栈，结果可信度存疑。

**完整度**: 85% (基准: 完全自动化的竞赛测试流程)。

---

## 四、动态测试设计与结果

### 4.1 现有测试框架

项目包含以下测试能力:

1. **用户态测试程序** (`user/` 目录，9 个早期测试):
   - `00hello_world.rs`, `01store_fault.rs`, `02power.rs`, `03priv_inst.rs`, `04priv_csr.rs`
   - `test_basic.rs`, `test_brk.rs`, `test_chdir.rs`, `test_clone.rs`
   - 通过 `make run TEST=1` 执行，用于本地开发调试
   - 竞赛版本中不再使用

2. **CI 测试**:
   - GitHub Actions 流水线，安装 QEMU 7.0.0 并运行用户态测试
   - 构建 Rust doc 并部署到 GitHub Pages

3. **竞赛测试集** (通过评测 harness):
   - 11 个测试组，约 59 个 compat bridge case
   - 依赖外部 EXT4 测试盘镜像(当前环境不具备)

### 4.2 测试结果说明

由于项目的内核作为评测专用 harness 运行，脱离官方测试盘无法完成完整引导，**本报告未进行 QEMU 实测**。所有功能评估均基于静态代码审查和架构分析。

上述 compat bridge 统计数据(约 59 处)间接表明: 至少 59 个 LTP case 依赖 bridge 输出而非真实执行；剩余 LTP case、busybox、lua、libcbench、libctest、iozone、lmbench、cyclictest、iperf、netperf 等测试组的实际通过率无法从代码中确定，需在竞赛环境中实测验证。

---

## 五、细则评价表格

### 5.1 内存管理

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，80% |
| 关键发现 | 采用 Sv39 三级页表 + 静态帧池(~80MB) + 懒分配设计；创新性地实现了 Eager Fork 快照机制(FORK_FRAMES 4800 帧 ≈ 19MB)，无需 MMU 上下文切换 | 即可支持类 Unix fork 语义；协作线程模型依赖显式切换点，无抢占调度 |
| 评价 | 在单核竞赛场景下，Eager Fork 是实用且创新的设计选择；懒分配和静态帧池策略有效平衡了实现复杂度与功能需求。主要不足是缺少 COW fork 导致内存开销较大，以及没有页面回收机制 |

### 5.2 进程管理

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，75% |
| 关键发现 | 完整实现 clone/fork/execve/wait/exit 生命周期；信号机制支持全部 POSIX 实时信号(rt_sigaction/procmask/suspend/timedwait/return)；futex 实现高度裁剪，无真正等待队列，通过协作线程排队间接实现同步；支持 set_tid_address/robust_list 等 pthread 基础设施 |  |
| 评价 | 进程管理功能覆盖竞赛需求较完整，信号机制尤其完善。但 futex 实现的简化程度较高(无 PI futex，等待队列基于协作模型)，在有竞争条件的复杂多线程场景下可能存在问题。调度器为协作式，不支持抢占 |

### 5.3 文件系统

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，85% |
| 关键发现 | 实现只读 EXT4 解析器(extent 映射、目录遍历) + 内存 Overlay VFS(MemFile 数组) + /proc/sys/dev 伪文件系统 stub；支持文件描述符类型 15+ 种 |  | 种(含 pipe/socket/epoll/eventfd/timerfd/signalfd/inotify/mqueue/aio/bpf)，为竞赛测试集提供了丰富的文件系统接口 |
| 评价 | Overlay VFS 是实用创新，解决了只读镜像上测试程序需写文件的矛盾。EXT4 解析器精简但覆盖核心需求。文件描述符类型丰富。主要不足是不支持写回磁盘和间接块映射 |

### 5.4 交互设计

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，90% |
| 关键发现 | 评测 harness 自动扫描 EXT4 测试盘目录，按 musl/glibc 顺序遍历并执行测试；输出符合平台竞赛日志格式；Compat bridge 分类(9 大类)自动生成等价通过输出，保证评测流程不断 |  |
| 评价 | 交互设计完全面向竞赛自动化评测优化，无用户交互界面，所有行为由 harness 自动驱动。Compat bridge 机制体现了"先让流程跑通，再逐类替换为真实实现"的务实工程策略。不足是 bridge case 数量较多(约 59 个)，反映了真实执行能力的缺口 |

### 5.5 同步原语

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现(单核)，实际使用覆盖度约 20% |
| 关键发现 | 仅提供 UPSafeCell(基于 RefCell) 单核互斥原语，用于早期 batch 子系统；syscall 和 task 层广泛使用 `static mut` + `#![allow(static_mut_refs)]` 直接操作全局可变状态，而非使用该原语 |  |
| 评价 | 同步原语的实现在单核无抢占环境下正确，但设计上未被业务层广泛采纳。全局可变状态的过度使用大幅增加了代码耦合度和维护难度。若未来引入多核或抢占，需要大规模重构 |

### 5.6 资源管理

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，60% |
| 关键发现 | 物理帧池使用静态数组分配(约 80MB)，无动态页面回收；fork 快照帧池独立(约 19MB)，支持最多 3 层嵌套；文件描述符表静态分配(MAX_FD=1024)，支持 CLOEXEC 清理和跨 exec 保留；协作线程独立内核栈(32KB/线程) |  |
| 评价 | 资源管理采用静态预分配策略，避免了动态分配器的复杂性，但限制了可扩展性。无资源限额(rlimit 为 stub)、无 cgroup、无 namespace 支持。在竞赛场景下功能足够，但不是通用 OS 的资源管理方案 |

### 5.7 时间管理

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，70% |
| 关键发现 | 通过 RISC-V `time` CSR 读取时间；实现 clock_gettime/settime/getres、nanosleep、clock_nanosleep、timer_create/delete/settime/gettime/getoverrun、adjtimex、clock_adjtime 等时间系统调用；gettimeofday/settimeofday 基于相同机制 |  |
| 评价 | 时间系统调用覆盖较全面，timerfd 也通过文件描述符机制支持。但缺少高精度定时器中断驱动的实际睡眠机制(nanosleep 可能依赖协作调度点而非硬件定时器)，且未实现完整的 NTP 时间同步(adjtimex 可能为 stub) |

### 5.8 系统信息

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，50% |
| 关键发现 | 实现 sys_uname(返回内核名称/版本/架构)、sys_sysinfo(返回内存/交换分区/进程数统计)、sys_times(返回进程 CPU 时间)、sys_getrusage(资源使用统计)等系统信息调用；/proc 伪文件系统通过特殊路径处理提供 /proc/mounts 等兼容入口 |  |
| 评价 | 系统信息接口覆盖了竞赛测试集的基本需求。但 sysinfo 返回的数据来自静态分配的资源计数，准确性有限；/proc 仅提供最小兼容入口，非完整 procfs 实现 |

### 5.9 设备驱动

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，60% |
| 关键发现 | 仅实现单队列轮询只读 virtio-blk 驱动，支持 Legacy/Modern MMIO 双模式；无网络设备驱动、无输入设备驱动、无显示设备驱动；MMIO 基址硬编码为 0x1000_1000 |  |
| 评价 | 驱动实现精简且覆盖核心需求(只读块设备)，Legacy/Modern 双模式兼容性好。主要不足是只读限制(无法测试写磁盘的用例)、硬编码 MMIO 基址、无中断驱动 I/O。作为竞赛 harness 内核，驱动需求有限，该实现策略合理 |

### 5.10 网络支持

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现(本地模拟)，30% |
| 关键发现 | 套接字系统调用通过本地缓冲区模拟: AF_INET/AF_INET6 通过 127.0.0.1/::1 loopback 模拟通信，AF_UNIX 通过路径匹配实现 socketpair，数据传递通过固定大小 packet 缓冲区；iperf/netperf 测试通过 harness 直接调用 socket API 而非真实网络栈 |  |
| 评价 | 网络支持仅为满足测试集的本地模拟，非真实网络栈。无 TCP 协议语义(三次握手、拥塞控制等)，无 ARP/IP 路由，无真实网络设备驱动。对于竞赛中的 iperf/netperf 测试，结果仅有形式意义 |

### 5.11 构建系统

| 评价维度 | 内容 |
|---|---|
| 是否实现及完整度 | 已实现，85% |
| 关键发现 | Rust toolchain 固定 nightly-2025-02-18；支持 `make run LOG=off` 启动 QEMU(128MB RAM, 单核)；CI 配置 GitHub Actions 自动构建文档和用户态测试；链接脚本自动复制机制；`os-la/` 共享 |  | 大部分业务代码 |
| 评价 | 构建系统清晰可用，固定 toolchain 版本保证了可复现性。CI 流水线实现了持续集成。不足是未提供直接构建竞赛测试镜像的脚本，测试依赖外部 EXT4 镜像 |

---

## 六、总结评价

### 6.1 综合完整度评估

| 评估维度 | 完整度 | 说明 |
|---|---|---|
| 启动与初始化 | 100% | 内核启动到主循环的最小路径完全实现 |
| 陷阱/异常处理 | 90% | 覆盖所有当前需求的异常类型 |
| 内存管理 | 80% | Sv39 + 静态帧池 + 懒分配 + Eager Fork，缺 COW |
| 进程管理 | 75% | clone/fork/execve/wait/信号完整，缺真实调度器 |
| 文件系统 | 85% | 只读 EXT4 + Overlay VFS，覆盖 15+ 文件类型 |
| 系统调用层 | 60%/75%* | 282 个注册 syscall，大量简化/stub |
| 设备驱动 | 60% | 仅只读 virtio-blk |
| 网络支持 | 30% | 本地模拟，非真实网络栈 |
| 评测 Harness | 85% | 11 个测试组 + 9 类 compat bridge |
| **总体 (RISC-V64)** | **70%** | 基准: 面向竞赛的完整 OS 内核 |

*60% 相对完整 Linux ABI；75% 相对竞赛测试集需求。

### 6.2 项目定性评价

alRED OS 是一个**工程规模大、目标明确、策略务实**的竞赛导向型 OS 内核项目。

**核心优势**:

1. **系统调用覆盖广度突出**: 282 个已注册 Linux 系统调用，覆盖文件 I/O、进程管理、信号、futex、epoll、socket、System V IPC、POSIX 消息队列、AIO、扩展属性等主要领域，是目前同类项目中数量最多的之一。

2. **Eager Fork 快照机制具有创新性**: 在无 MMU 上下文切换的单核环境中，通过全量内存快照 + 恢复的方式实现了类 Unix fork 语义，并支持 partial fork 优化和 3 层嵌套，在受限环境下具备明确的工程价值。

3. **Overlay VFS 设计实用**: 通过在只读 EXT4 上叠加内存文件层，使需要写文件系统的测试程序可正常运行，且支持跨 exec 的 overlay 保留模式。

4. **Compat Bridge 策略务实**: 将测试用例按能力分层处理，保证了评测流程的完整性，同时为内核功能的渐进增强提供了清晰的路线图。

**主要不足**:

1. **全局可变状态过度使用**: syscall/fs.rs 和 syscall/process.rs 中 150+ 个 `static mut` 变量削弱了代码的可维护性和扩展性，在单核环境下功能正确但对后续演进不利。

2. **Compat bridge 占比较高**: 约 59 个 LTP case 依赖 bridge 输出，说明内核在存储、网络、调度、cgroup 等方面仍有较大能力缺口。

3. **缺少真实调度器和多核支持**: 时钟中断被忽略，所有线程调度依赖协作模型，是项目向通用 OS 演进的显著障碍。

4. **LoongArch64 端差距大**: 架构框架存在，但 `write_satp()` 为占位，用户态运行未实现，大量代码共享但缺乏后端支撑。

### 6.3 适用场景

该项目适用于: 全国大学生计算机系统能力大赛 OS 内核设计赛，特别是需要在单核 QEMU virt 环境中运行 BusyBox、LTP、lmbench 等测试集、且希望以 Rust 实现大规模 Linux ABI 兼容层的队伍。Eager Fork 和 Overlay VFS 的设计思路对资源受限环境下的 OS 开发具有参考价值。