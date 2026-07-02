# F7LY OS 内核项目技术画像与评估报告

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| 项目名称 | F7LY OS |
| 架构 | RISC-V64 (rv64)、LoongArch64 (la64) |
| 实现语言 | C++23 (freestanding) + 少量汇编 |
| 内核类型 | 宏内核 (Monolithic Kernel) |
| 生态归属 | Linux 兼容生态（系统调用 ABI 对齐 Linux，兼容 Linux 用户态程序） |
| 代码规模 | 约 140,000 行（含第三方库 EASTL、lwext4、Open-NPStack） |
| 外部依赖 | EASTL、lwext4、Open-NPStack |
| 构建工具 | GNU Make + GCC (linux-gnu 工具链) |
| 主要特点 | 双架构 C++23 宏内核；完整 ext4 文件系统；260+ 系统调用；Maple Tree VMA 索引；VmObject 抽象层次；termios 完整实现；EASTL 集成 |

---

## 二、子系统与功能实现

### 2.1 子系统实现清单

| 子系统 | 核心文件 | 实现状态 |
|--------|---------|---------|
| 启动子系统 | `kernel/boot/` | 完整（SMP 多核启动、架构差异处理） |
| 异常/中断子系统 | `kernel/trap/` | 完整（嵌套中断、PLIC/APIC/EXTIOI） |
| 内存管理 | `kernel/mem/` | 完整（伙伴系统、Slab 分配器、VMM/PMM/HMM、COW） |
| 进程管理 | `kernel/proc/` | 完整（PCB、调度器、信号、futex、POSIX 定时器） |
| 文件系统 | `kernel/fs/` | 完整（VFS + ext4 + FAT32、块层、VirtIO 驱动） |
| 系统调用 | `kernel/sys/` | 完整（260+ 系统调用、架构感知的参数布局） |
| 网络子系统 | `kernel/net/` | 基本完整（TCP/UDP/IP/ICMP/ARP、BSD Socket） |
| 设备管理 | `kernel/devs/` | 完整（设备框架、控制台 termios、DTB 解析） |
| 共享内存 | `kernel/shm/` | 完整（SysV SHM、IPC namespace） |
| 时间管理 | `kernel/tm/` | 完整（多 POSIX 时钟、POSIX 定时器） |
| 内核库 | `kernel/libs/` | 完整（C++ ABI 桩、klib、EASTL 适配） |

---

## 三、各子系统实现细节与评估

### 3.1 启动子系统

**实现内容**：
- RISC-V：`entry.S` 实现逐核独立栈分配（4KB × hartid），通过 OpenSBI 获取 DTB
- LoongArch：`entry.S` 兼容 LoongArch 启动约定，`DtbManager::find_dtb_and_initrd()` 主动探测 DTB
- 统一的 `main.cc` 初始化流程，涵盖所有子系统按序初始化

**优点**：
- SMP 多核启动设计合理，每核独立栈空间消除竞态条件
- 两架构启动路径高度统一，`main.cc` 中仅需少量条件编译分支

**不足**：
- LoongArch 的 `find_dtb_and_initrd()` 依赖于特定固件传递约定，兼容性范围未文档化
- 启动栈大小固定 4KB/hart，极端嵌套中断场景下存在溢出风险

**完整度**：约 90%

---

### 3.2 内存管理子系统

**实现内容**：
- **BuddySystem**：树形伙伴分配器，支持连续多页分配/释放，节点状态管理完整（UNUSED/USED/SPLIT/FULL）
- **PMM**：物理页管理器，支持单页/多页分配、引用计数、COW 保留
- **VMM**：虚拟内存管理器，实现 `map_pages`/`vmunmap`/`copy_in`/`copy_out`/`resolve_cow_page`/`allocate_vma_page`
- **页表**：RISC-V Sv39 三级页表，LoongArch LA64 页表
- **Slab 分配器**：5 级缓存，free/partial/full 三链表管理，支持内存回收
- **HMM**：内核堆分配器，整合 BuddySystem（粗粒度）与 L_Allocator（细粒度）
- **ProcessMemoryManager**（3,086 行）：VMA 管理、程序段管理、堆管理、mmap 游标、共享内存集成

**优点**：
- 多层次分配器设计（Buddy → Slab → L_Allocator）覆盖不同粒度需求
- VMA 管理采用自实现的 Maple Tree（B+Tree 风格，扇出 12），提供 O(logN) 查找
- VmObject 抽象层次（Anon/File/SysvShm）统一了匿名内存、文件映射、SysV SHM 的页面管理
- COW 实现完整，通过 `retain_page`/`page_ref_count`/`resolve_cow_page` 串联
- 引用计数与页面共享机制为高效 fork 打下基础

**不足**：
- Maple Tree 实现中的并发控制机制未见明确设计（VMA 查找路径的锁策略）
- Slab 分配器仅 5 个固定大小级别，对非对齐大小的对象分配效率可能降低
- `ProcessMemoryManager` 代码量大但注释稀疏，理解维护成本高
- 缺少大页（huge page）支持

**完整度**：约 88%

---

### 3.3 进程管理子系统

**实现内容**：
- **PCB**：完整的进程控制块，含 pid/tid/tgid/pgid/sid、凭证（uid/gid/补充组/capability 五集）、调度信息（nice/策略/CPU 亲和性）、文件系统上下文（cwd/root/umask/文件描述符表）、7 种状态
- **调度器**：优先级调度（O(N) 扫描），支持 SCHED_OTHER/SCHED_FIFO/SCHED_RR，信号感知优先级提升
- **信号**：31 标准信号 + SIGCANCEL + 实时信号（34-64），`rt_sigaction`/`rt_sigprocmask`/`rt_sigpending`/`rt_sigtimedwait`/`rt_sigreturn`/`sigaltstack`，架构对齐的 sigframe 和 mcontext
- **futex**：`FUTEX_WAIT`/`WAKE`/`WAIT_BITSET`/`WAKE_BITSET`/`REQUEUE`/`CMP_REQUEUE`/PI futex/Robust futex
- **POSIX 定时器**：`timer_create`/`timer_settime`/`timer_gettime`/`timer_delete`，SIGEV_SIGNAL/SIGEV_THREAD_ID 通知
- **VMA 管理**：VmArea 结构、Maple Tree 索引、VMASpace 封装

**优点**：
- PCB 设计极其详尽，credential 体系（uid/gid 全套 + supplementary groups + Linux capabilities 五集）逼近 Linux 真实模型
- 信号处理帧结构（sigframe）与 Linux ABI 对齐，含指定架构的 mcontext 定义
- futex 实现覆盖主流操作和 PI/robust 扩展，与 Linux 用户态锁库兼容性好
- POSIX 定时器支持 per-process 和 per-thread 定时器
- VMA 通过 Maple Tree 索引，查找效率优于简单链表

**不足**：
- 调度器为全局大运行队列的 O(N) 扫描，无 per-CPU 运行队列或红黑树优化，扩展性有限
- 调度策略未实现 SCHED_DEADLINE 和完整的 SCHED_BATCH/SCHED_IDLE
- 进程数量上限 `num_process` 为编译期常量，不支持动态扩容
- 缺少 cgroup 资源控制

**完整度**：约 92%

---

### 3.4 文件系统子系统

**实现内容**：
- **三层架构**：VFS 层 → ext4 适配层 → lwext4 底层
- **lwext4 完整移植**：超级块、块分配器、inode 分配器、inode 操作、目录操作、HTree 目录索引、extent、JBD 日志、块缓存、CRC32、xattr、MBR 分区表、mkfs
- **VFS 文件类型**：普通文件、目录、设备文件、管道、socket、epoll、虚拟文件
- **块层**：bio 请求抽象、buffer cache
- **块设备驱动**：RISC-V VirtIO MMIO、LoongArch VirtIO PCI、mClock 调度器、RAM disk、loop 设备
- **文件锁**：BSD flock、POSIX 记录锁、OFD 锁（`fcntl.hh`）
- **虚拟文件系统**：树形结构组织（`vfile_tree_node`，最多 128 子节点），支持动态路径

**优点**：
- ext4 支持程度极高：extent、JBD 日志、HTree 目录索引、xattr 均已实现，达到可读写真实 ext4 磁盘的水平
- VFS 架构清晰：文件类型枚举 + 多态实现类，支持管道/socket/设备/epoll 等特殊文件
- 块层支持 mClock 调度器，提供 I/O 优先级控制
- 虚拟文件系统树形结构与动态路径解析配合，`/proc/<pid>/stat` 等可按进程动态生成
- 文件描述符表容量 1024，接近 Linux 默认值

**不足**：
- ext4 日志虽已实现但未深度验证崩溃一致性（无测试覆盖证据）
- 虚拟文件系统最大 128 子节点/目录，对 `/proc` 等大型虚拟目录可能不足
- 缺少 VFS 层缓存（dentry cache/inode cache），路径解析每次都穿透到 ext4
- 块缓存（`buf.hh`）为简单 LRU 链表，非多级缓存

**完整度**：约 93% (ext4 部分极高); 约 85% (整体 VFS 工程化程度)

---

### 3.5 系统调用子系统

**实现内容**：
- 306 个枚举项（去重后约 260+ 有效系统调用）
- 涵盖：进程管理（15+）、文件操作（35+）、目录操作（10+）、文件系统（15+）、内存管理（15+）、信号（15+）、时间（15+）、Socket/网络（20+）、IPC（12+）、调度（8+）、安全/凭证（15+）、杂项（20+）
- `syscall_handler.cc`（21,801 行）实现全部处理逻辑
- 系统调用号与 Linux RISC-V/LoongArch ABI 对齐

**优点**：
- 系统调用覆盖面广，260+ 的数量远超一般教学/比赛内核（通常 50-100 个）
- 与 Linux ABI 严格对齐（如 `SYS_read=63`），用户态程序无需修改即可运行
- 架构感知的参数布局（如 `UserStatLayout` 区别 RISC-V/LoongArch）

**不足**：
- `syscall_handler.cc` 单一文件过长（21,801 行），严重违反关注点分离原则
- 部分系统调用仅有枚举定义但无实际实现（需逐个比对确认数量）
- 部分复杂系统调用（如 `prctl`、`bpf`）的实现深度有限，仅覆盖子集
- 缺少系统调用过滤/审计机制（seccomp 未实现）

**完整度**：约 88% (数量维度); 约 70% (深度维度)

---

### 3.6 网络子系统

**实现内容**：
- **协议栈**：Open-NPStack 移植，含 Ethernet、ARP、IP、ICMP、TCP（2,207 行）、UDP
- **TCP**：完整状态机（LISTEN→SYN_RCVD→ESTABLISHED→...）、超时重传、拥塞控制
- **驱动**：RISC-V VirtIO MMIO 网卡驱动（双队列：RX queue 0, TX queue 1，32 描述符/队列）、LoongArch VirtIO PCI 网卡驱动
- **BSD Socket**：TCP/UDP/RAW socket、AF_INET/AF_INET6/AF_UNIX、阻塞/非阻塞、UNIX domain socket 本地路径绑定

**优点**：
- 完整的第三方 TCP/IP 协议栈集成，包含 TCP 状态机和拥塞控制
- 双架构网卡驱动均有实现（MMIO 和 PCI 模式各一套）
- BSD Socket 实现支持 IPv4/IPv6/UNIX 多种协议族
- 本地回环数据报队列实现

**不足**：
- Open-NPStack 为外部项目，与内核的集成适配层代码质量参差不齐
- TCP 拥塞控制的具体算法未在代码中明确识别（可能仅最基础的实现）
- IPv6 支持程度不如 IPv4（确认仅在 socket 枚举中有定义）
- 无 DHCP 客户端实现
- 无 netfilter/iptables 等防火墙机制

**完整度**：约 72%

---

### 3.7 设备管理子系统

**实现内容**：
- `DeviceManager`：统一设备注册表（`DeviceTableEntry[]`），区分为块设备/字符设备
- 控制台：中断驱动输入缓冲、stdin/stdout/stderr 的 VirtualDevice 实现
- **termios**：完整实现（规范模式行编辑、原始模式、信号字符处理、本地标志/输入标志/输出标志/控制标志）
- UART 驱动（ns16550a 兼容）
- RAM disk、loop 设备
- DTB 解析（`DtbManager`，含 initrd 扫描）
- LoongArch 特有：PCI 总线枚举、VirtIO 磁盘驱动（PCI 模式）、磁盘分区/MBR 解析

**优点**：
- termios 实现完整度高，涵盖规范模式、原始模式以及各类终端控制标志
- 设备框架区分块设备/字符设备/流设备，层次清晰
- DTB 解析器能提取 initrd 等关键信息
- LoongArch 版 PCI 总线枚举为设备发现提供完整基础设施

**不足**：
- 设备数量上限 `DEV_TBL_LEN` 为编译期常量
- 字符设备驱动仅实现了 UART，缺少其他常见设备驱动（如 RTC、Watchdog）
- LoongArch 的设备驱动依赖 PCI 总线枚举的健全性，但 PCI 实现本身可能有覆盖不全的问题

**完整度**：约 80%

---

### 3.8 共享内存子系统

**实现内容**：
- SysV SHM 全套操作：`shmget`/`shmat`/`shmdt`/`shmctl`
- 使用 EASTL `unordered_map` 管理共享段
- IPC namespace 隔离（`ipc_ns_id`）
- 完整权限/时间戳/进程信息记录
- `auto_destroy_on_last_detach` 支持（与 mmap MAP_SHARED 共用 SHM 后端）
- `/proc/sys/kernel/shmmax`/`shmmni`/`shmall` 可调参数
- 与 VmObject 系统集成（`SysvShmVmObject`）

**优点**：
- SysV SHM 实现完整，与 Linux ABI 对齐
- 通过 VmObject 抽象与 mmap MAP_SHARED 共用后端，设计简洁
- 支持 IPC namespace，为容器化提供基础
- 可调参数通过 `/proc` 暴露

**不足**：
- 未实现 POSIX 共享内存（`shm_open`/`shm_unlink`，基于文件系统的 `/dev/shm`）
- IPC namespace 的支持程度未在代码中充分验证

**完整度**：约 85%

---

### 3.9 时间管理子系统

**实现内容**：
- POSIX 时钟：`CLOCK_REALTIME`/`CLOCK_MONOTONIC`/`CLOCK_BOOTTIME`/`CLOCK_PROCESS_CPUTIME_ID`/`CLOCK_THREAD_CPUTIME_ID`
- 系统调用：`clock_gettime`/`clock_settime`/`clock_getres`/`nanosleep`/`clock_nanosleep`
- `gettimeofday` 兼容
- timex/adjtimex 时钟调整
- rusage 进程资源使用统计

**优点**：
- 多时钟支持完善，涵盖实时/单调/启动/进程/线程多种时钟源
- POSIX 定时器与进程管理子系统紧密集成
- rusage 提供进程级资源消耗统计

**不足**：
- `clock_settime` 的实现依赖于持久化时间存储（RTC），未见 RTC 驱动支持
- `adjtimex` 的完整度不确定（通常需要硬件时钟同步支持）
- 高精度定时器（hrtimer）未实现，时间精度受 tick 限制

**完整度**：约 82%

---

## 四、动态测试设计与结果

### 4.1 本次评估的构建测试

**测试方法**：尝试使用环境中的工具链对项目进行 RISC-V 交叉编译构建。

**测试结果**：**构建失败**。

**原因分析**：
- 项目指定依赖 `riscv64-linux-gnu-g++`（Linux GNU C++ 交叉编译器）
- 环境中仅有 `riscv64-linux-gnu-gcc`（C 编译器）和 `riscv64-unknown-elf-g++`（裸机 C++ 编译器）
- 裸机工具链缺少 Linux 系统头文件（`<sys/types.h>`、`<cstddef>`），内核代码和 EASTL 库依赖这些头文件
- LoongArch 交叉编译工具链完整缺失

**结论**：无法执行运行时测试（QEMU 启动、系统调用验证、性能测试等）。

### 4.2 项目中存在的测试证据

项目代码中未发现正式的单元测试或集成测试文件（如 `tests/` 目录、GTest 等测试框架引用）。仅在 `Makefile` 中有构建目标，无可识别的测试目标。

---

## 五、细则评价表格

### 5.1 内存管理

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 88% |
| 关键发现 | 多层次分配器设计（Buddy → Slab → L_Allocator）；自实现 VmaMapleTree（B+Tree 扇出 12）用于 VMA 索引；VmObject 三层抽象（Anon/File/SysvShm）统一页面管理；COW 通过 retain_page/resolve_cow_page 实现；RISC-V Sv39 和 LoongArch LA64 双架构页表实现 |
| 评价 | 内存管理是该项目的技术核心亮点。Buddy System 的实现规范，Slab 分配器的三链表管理到位。Maple Tree 和 VmObject 抽象层次在同类项目中属于先进设计。主要不足在于 Slab 仅 5 个固定级别、缺少大页支持、Maple Tree 并发控制设计未见明确。 |

### 5.2 进程管理

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 92% |
| 关键发现 | PCB 包含完整 Linux 兼容 credential 体系（uid/gid/补充组/capability 五集）；调度器支持 SCHED_OTHER/FIFO/RR；信号处理含 rt_sig* 全套 + sigaltstack；futex 覆盖 WAIT/WAKE/BITSET/REQUEUE/PI/ROBUST；POSIX 定时器支持 SIGEV_SIGNAL/SIGEV_THREAD_ID |
| 评价 | 进程管理是该项目中实现最完善的子系统。credential 和 capability 的完整性在非 Linux 内核中极为罕见。futex 的 PI 和 robust 支持达到较高水平。主要不足在于 O(N) 调度器扫描性能和缺少 cgroup。 |

### 5.3 文件系统

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 93% (ext4)；约 85% (VFS 整体) |
| 关键发现 | lwext4 完整移植（超级块、块分配器、inode 分配器、HTree 目录索引、extent、JBD 日志、xattr、CRC32、mkfs）；VFS 三层架构；7 种文件类型（普通、目录、设备、管道、socket、epoll、虚拟）；RISC-V MMIO 和 LoongArch PCI 双 VirtIO 驱动；BSD flock/POSIX 记录锁/OFD 锁；树形虚拟文件系统 |
| 评价 | ext4 的支持程度是该项目的最大技术亮点，extent、JBD 日志、HTree 目录索引、xattr 的实现使其达到了可用的文件系统水平。VFS 文件类型多样化（含 socket/epoll 特殊文件）符合现代需求。主要不足在于缺少 dentry cache/inode cache、虚拟文件系统子节点限制 128、JBD 日志的崩溃一致性未经充分验证。 |

### 5.4 交互设计

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是（用户接口层面） |
| 完整度 | 约 80% |
| 关键发现 | 控制台中断驱动输入缓冲；完整 termios（规范模式行编辑、原始模式、信号字符处理）；彩色 ANSI 终端日志输出（printfGreen/printfRed）；`/proc` 虚拟文件系统提供系统信息查询（含动态路径如 `/proc/<pid>/stat`） |
| 评价 | 交互设计方面最突出的实现是 termios 完整支持，对标 Linux tty 层。彩色日志输出便于开发者调试。`/proc` 提供标准化的状态查询接口。缺少正式的 shell 交互层说明（虽有 initcode 机制但未深入验证）。 |

### 5.5 同步原语

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 78% |
| 关键发现 | 内核信号量（`semaphore.cc`）；futex（WAIT/WAKE/BITSET/REQUEUE/PI/ROBUST）；自旋锁（通过 PLIC/APIC 中断管理间接实现）；嵌套中断 push_intr_off/pop_intr_off 机制 |
| 评价 | 同步原语以内核信号量和 futex 为主。futex 的实现覆盖度较高（含 PI 和 robust）。但代码中未见明确的自旋锁/互斥锁/rw 锁/kmutex 等典型内核同步原语抽象接口，可能内联在具体子系统中。缺少完整的锁层次设计文档。 |

### 5.6 资源管理

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 76% |
| 关键发现 | 物理内存通过 BuddySystem + PMM 管理；文件描述符表容量 1024；进程数量编译期常量；设备表编译期常量；内存回收（Slab memory_recycle）；进程退出时资源清理（僵尸进程回收） |
| 评价 | 基础和必要的资源管理机制已实现。物理内存管理和文件描述符表设计规范。但多种资源上限为编译期常量（进程数、设备数、Slab 缓存级别），缺乏动态可调能力。缺少完整的资源配额和记账（cgroup/rlimit 仅部分支持）。 |

### 5.7 时间管理

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 82% |
| 关键发现 | 多 POSIX 时钟（REALTIME/MONOTONIC/BOOTTIME/PROCESS_CPUTIME/THREAD_CPUTIME）；clock_gettime/settime/getres；nanosleep/clock_nanosleep；POSIX 定时器；gettimeofday 兼容；timex/adjtimex；rusage 进程统计；tick 间隔通过 cycles_per_tick 确定 |
| 评价 | 时间管理接口覆盖完善。多时钟源的设计与 Linux 模式对齐良好。主要不足在于缺少 RTC 驱动支撑 clock_settime 的持久化、无高精度定时器（hrtimer）实现、时间精度受 tick 限制。 |

### 5.8 系统信息

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 75% |
| 关键发现 | `/proc` 虚拟文件系统；`sysinfo` 系统调用（`sysinfo.hh`）；`uname` 系统调用；设备树解析（`DtbManager`）；中断统计管理器（`intr_stats`）；进程资源使用统计（`rusage`） |
| 评价 | 系统信息主要通过 `/proc` 虚拟文件系统暴露，支持动态路径（如按 PID 生成状态文件）。中断统计管理器提供有用的诊断信息。缺少更全面的内核统计接口（如 `/proc/meminfo` 的详细字段、`/proc/slabinfo` 等）。 |

### 5.9 可移植性（补充条目）

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是（双架构） |
| 完整度 | 约 85% |
| 关键发现 | 同时支持 RISC-V64 和 LoongArch64；架构特定代码组织为 `riscv/` 和 `loongarch/` 子目录；通用代码约 70%+ 通过 `#ifdef` 条件编译和 `platform.hh` 抽象共享；架构差异包括：SBI vs 裸机、Sv39 vs LA64 页表、PLIC vs APIC+EXTIOI、VirtIO MMIO vs PCI |
| 评价 | 双架构支持是该项目的核心特色之一。架构代码组织清晰，共享度高。但 LoongArch 的网络驱动、部分设备驱动的完成度略低于 RISC-V。构建依赖 linux-gnu 工具链降低了可移植构建的灵活性。 |

### 5.10 网络支持（补充条目）

| 评价维度 | 内容 |
|---------|------|
| 是否实现 | 是 |
| 完整度 | 约 72% |
| 关键发现 | Open-NPStack TCP/IP 协议栈集成；TCP 状态机完整（2,207 行）；VirtIO Net 驱动（RISC-V MMIO + LoongArch PCI）；BSD Socket（TCP/UDP/RAW/UNIX）；AF_INET/AF_INET6/AF_UNIX 协议族 |
| 评价 | 网络子系统具备核心 TCP/IP 功能，VirtIO 驱动双架构均已实现。主要差距在于：IPv6 支持深度不足、缺少 DHCP 客户端、无防火墙机制、Open-NPStack 集成层代码质量参差。 |

---

## 六、总结评价

F7LY OS 是一个**技术跨度大、系统调用覆盖广的双架构 C++23 宏内核项目**。

**核心优势**：

1. **子系统覆盖全面**：260+ 系统调用、完整 ext4 文件系统、BSD Socket 协议栈、SysV SHM、POSIX 定时器/信号/futex 等构成较为完整的内核功能集。
2. **ext4 支持程度突出**：lwext4 的完整移植（含 extent、JBD 日志、HTree、xattr）达到了可读写真实 ext4 磁盘镜像的水平，这是该项目最鲜明的技术标识。
3. **进程模型设计精细**：credential/capability 体系、信号处理、futex（含 PI/robust）、POSIX 定时器的实现逼近 Linux 真实模型。
4. **内存管理架构先进**：Buddy → Slab → L_Allocator 三级分配，Maple Tree VMA 索引，VmObject 三层抽象，COW 机制构成层次化的内存管理体系。
5. **架构可移植性**：RISC-V64 和 LoongArch64 共享约 70% 通用代码，架构特定模块组织清晰。

**主要不足**：

1. **代码工程化水平不均衡**：`syscall_handler.cc` 单一文件 21,801 行，是明显的架构性问题；部分组件注释稀疏，维护成本高。
2. **构建依赖限制**：依赖 `linux-gnu-g++` 工具链，在裸机工具链环境下无法构建，降低了可复现性。
3. **调度器性能瓶颈**：单核 O(N) 扫描全局运行队列，无 per-CPU 队列或高效数据结构（如红黑树），限制了多进程场景下的扩展性。
4. **网络子系统集成度**：Open-NPStack 的集成适配、IPv6 支持、DHCP 等工程化配套不完整。
5. **缺乏测试体系**：项目中未识别出正式的单元测试或集成测试框架，代码质量保障手段不足。
6. **部分功能深度有限**：如 `prctl`/`bpf` 等复杂系统调用仅实现子集；缺少大页、cgroup、dentry cache 等现代 Linux 内核特性。

**综合评定**：该项目在单一赛道作品中展现出**较高的技术密度和工程规模**，特别在文件系统和进程管理层面达到了不错的完成度。其作为 C++23 双架构宏内核，设计理念和代码组织具有一定的学习和参考价值。但在代码工程化、性能优化、测试保障和构建可复现性方面存在可改进空间。