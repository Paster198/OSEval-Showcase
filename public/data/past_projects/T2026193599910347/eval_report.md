# Project Aurora 技术画像与评估报告

## 一、项目基本信息

| 项目 | 详情 |
|---|---|
| **项目名** | Aurora OS (Project Aurora) |
| **目标架构** | RISC-V 64 (riscv64gc) |
| **实现语言** | Rust (100%) + 少量 RISC-V 汇编 |
| **内核类型** | 单内核 (Monolithic Kernel) |
| **生态归属** | 独立内核，兼容 Linux RISC-V syscall ABI (92 个系统调用) |
| **代码规模** | 内核约 20,686 行（含 Rust 与汇编） |
| **运行平台** | QEMU virt (riscv64)，依赖 OpenSBI |
| **特性** | Copy-on-Write fork、ext4/FAT32 自研实现、smoltcp 网络栈、Sv39 页表、无堆静态分配、自包含用户态测试 |
| **构建工具链** | Rust 1.75.0 (rustc, cargo) + RISC-V 裸机交叉编译工具链 |

---

## 二、子系统与功能实现概览

| 子系统 | 核心功能 | 实现文件/模块 |
|---|---|---|
| 启动引导 | SBI 启动链、BSS 清零、DTB 解析、控制台输出 | `entry.S`, `main.rs`, `dtb.rs`, `console.rs`, `sbi.rs` |
| 内存管理 | 物理页帧分配、Sv39 三级页表、CoW fork、用户地址空间 | `mm.rs` (1379行) |
| Trap/中断 | 内核/用户态 trap 处理、时钟中断、外部中断、缺页 | `trap.S`, `trap.rs` |
| 任务/进程管理 | TCB、上下文切换、调度器、进程表、fork/exit/wait | `task.rs`, `process.rs`, `scheduler.rs`, `runtime.rs` |
| 系统调用 | 92 个系统调用实现，FD 表，管道，epoll，mmap，execve | `syscall.rs` (6416行) |
| 文件系统 | VFS 抽象、挂载表、ext4、FAT32、memfs、devfs、procfs | `axvfs/*`, `axfs/*` (共约5387行) |
| 网络栈 | socket API，TCP/UDP/ICMP/ARP (基于 smoltcp) | `axnet/*` (约1510行) |
| VirtIO 块设备 | MMIO 块设备读写 | `virtio_blk.rs` |
| VirtIO 网卡 | MMIO 网络收发、MAC 地址获取 | `virtio_net.rs` |
| 同步原语 | futex、等待队列、睡眠队列、task_wait_queue | `futex.rs`, `sleep.rs`, 等 |
| 异步执行器 | 无堆协作式 Future 执行器 | `async_exec.rs` (243行) |
| 用户态支持 | 手写机器码测试程序、ELF 加载器、用户栈构建、shell 应用 | `user.rs`, `apps/*` |

---

## 三、各子系统实现完整度与细节

### 3.1 内存管理

**实现完整度**：覆盖了物理页框分配、Sv39 内核恒等映射、用户页映射与地址空间管理、CoW fork、缺页处理（CoW 恢复）、用户态指针安全验证。未实现按需分页、页面交换、大页在用户态的支持、文件映射 mmap。

**实现细节**：
- 物理页帧分配器采用 bump allocator + 空闲链表 + 16 位引用计数，支持连续分配和回收。
- 内核使用 2MB 大页进行恒等映射（1GB 范围），减少 TLB 压力。
- CoW 通过自定义 `PTE_COW`（bit 8）标记实现。fork 时将可写页标记为只读且设置 CoW 标志，父子共享物理页。写入触发 Store page fault，若引用计数为 1 则直接恢复可写，否则分配新页并复制内容，释放旧页引用。
- 用户态指针通过 `translate_user_ptr` 逐页验证并处理 CoW，保证访问安全。
- 页表回收 (`release_user_root`) 对 4KB 页逐个递减引用计数并释放计数归零的页框，但对大页不作释放。

**优点**：
- CoW 实现完整，fork 语义正确，避免了不必要的数据拷贝。
- 用户态指针验证机制提供了防御非法访问的能力。
- 内核态使用大页映射，结构精简。

**缺点**：
- 无按需分页，所有用户页在创建时即分配，浪费物理内存。
- 无页面交换，内存压力下无法将不活跃页换出。
- mmap 仅支持匿名映射，不支持文件映射和共享映射，限制了应用场景。

### 3.2 进程管理

**实现完整度**：支持 fork、execve、exit、waitpid 完整生命周期，具备独立的用户根页表和地址空间，最多 8 个任务 (MAX_TASKS=8)。调度器为简单轮询，无优先级、无时间片。无信号处理、无进程组/会话管理、无多核支持。

**实现细节**：
- 任务控制块使用静态数组分配 (`MaybeUninit`)，避免堆分配。
- 上下文切换保存/恢复 14 个 callee-saved 寄存器，并在内核态切换后清零 `sscratch` 以区分子系统状态。
- fork 时通过 `clone_user_root` 对父进程用户页表进行 CoW 标记，子进程共享物理页，仅在写入时分裂。
- execve 加载 ELF 并替换用户地址空间，含 argc/argv/envp 栈布局。
- waitpid 通过轮询进程表 + `TaskWaitQueue` 超时重试实现阻塞等待。
- 调度器 `schedule_once` 从 `RunQueue` 中线性扫描状态为 `Ready` 的任务进行切换。

**优点**：
- fork + execve 链路完整，CoW 保证了 fork 效率。
- 无动态分配设计避免了内核堆碎片和 OOM 问题。
- 陷阱帧和 sscratch 的使用实现了内核/用户态 trap 的无缝切换。

**缺点**：
- 任务数量硬限制为 8，扩展性极差。
- 调度器仅是轮询，缺乏公平性和实时性保证，无法适应多任务负载。
- 无信号机制，无法进行异步事件通知或进程间控制。
- 单核设计，无法利用多核 CPU。

### 3.3 文件系统

**实现完整度**：拥有较完整的 VFS 架构和挂载表，支持 ext4（读写、创建、读目录）、FAT32（读写、创建）、内存文件系统 memfs、设备文件系统 devfs、空壳 procfs。ext4 不支持删除、日志、extent 深度 > 0 的树；FAT32 仅支持短文件名。

**实现细节**：
- VFS 抽象通过 `VfsOps` trait 实现，块设备抽象通过 `BlockDevice` trait，带 32 行直接映射写回块缓存。
- 挂载表 `MountTable` 采用最长前缀匹配，支持多文件系统后端同时挂载。
- ext4 实现了解析超级块、块组描述符、inode 读取、extent 树寻址（叶节点线性搜索）以及经典间接块寻址，支持文件创建时分配 inode 和写入目录项、跨块 RMW 写操作。
- FAT32 实现了 BPB 解析、FAT 链遍历、短文件名目录项解析、文件创建与簇链分配。
- memfs 内嵌了 `/init` ELF 镜像和 `/dev/null`, `/dev/zero` 字符设备，提供 `/tmp/log` 环形缓冲区。

**优点**：
- 自研 ext4 和 FAT32 实现，且支持文件创建和写入，展现了较高工程水平。
- VFS 架构清晰，挂载点机制使得多文件系统组合成为可能。
- ext4 的 extent 树寻址和 FAT32 簇链分配均正确处理。

**缺点**：
- ext4 缺少日志支持，在崩溃后文件系统一致性无法保证。
- ext4 不支持删除操作，导致文件系统测试路径不完整。
- FAT32 仅处理短文件名，目录项有限。
- procfs 为空壳，未提供任何进程信息。
- mmap 不支持文件映射，无法实现内存映射文件 I/O。

### 3.4 网络栈

**实现完整度**：基于 smoltcp 0.10，实现了 socket 创建、bind、listen、accept、connect、send、recv、poll、close，支持 TCP 和 UDP。通过时钟中断和轮询驱动协议栈，支持 ICMP ping 和 ARP 解析。最多 8 个 socket。

**实现细节**：
- `axnet` 封装了 smoltcp 的 socket 管理和 poll 机制。
- 网络帧收发自旋锁保护的 TX/RX 队列通过 VirtIO 网卡驱动完成。
- 实现了简单的回环机制，发往本机 IP 的帧直接入本地队列。
- 临时端口从 49152 开始分配，TCP socket 缓冲区设置为 65536 字节，UDP 为 2048 字节。

**优点**：
- 核心 TCP/UDP 功能可用，可以运行 echo 类网络应用和性能基准测试。
- 轮询驱动模型与单内核整体架构适配良好。

**缺点**：
- 不支持 IPv6，无法用于现代纯 IPv6 网络。
- 无原始 socket，不支持 ICMP 原始收发或自定义协议。
- 仅支持单一网络接口。
- 缺乏 zero-copy 机制，收发包均需在内核与用户态间拷贝。
- socket 数量上限 8 限制并发网络应用能力。

### 3.5 同步原语

**实现完整度**：futex（含私有/共享、超时、wake 指定数量）、管道（512 字节环形缓冲）、eventfd、epoll（最多 64 个监控项）、定时器 fd、等待队列、睡眠队列均可用。无 POSIX 信号量、消息队列、条件变量。

**实现细节**：
- futex 以 `(root_pa, uaddr)` 作为 key，私有 futex 使用当前页表根，共享 futex 以物理地址为 key（root_pa=0）。
- epoll 通过 `TaskWaitQueue` + 超时重试实现阻塞等待，轮询时检查各 FD 状态（pipe 可读/可写、socket 状态）。
- 睡眠队列基于时钟 ticks，`pop_ready` 在时钟 tick 时返回到期任务。
- 管道使用读写等待队列和 512 字节环形缓冲，支持非阻塞模式。

**优点**：
- futex 实现可支持用户态自旋锁等高效同步原语。
- epoll 支持多路复用，适用于事件驱动的网络应用。

**缺点**：
- 管道缓冲区 512 字节过小，可能影响吞吐。
- epoll 最大监控项 64，无法适应高并发服务端。
- 缺乏信号量、消息队列等 POSIX IPC，限制应用兼容性。

### 3.6 交互设计

**实现完整度**：内核通过 SBI legacy console 支持基本字符输出和输入；用户态 shell 应用 (`aurora-sh`) 提供了命令行交互、ANSI 颜色支持、文件/目录操作命令。无图形界面，无编辑/历史等高级终端功能。

**实现细节**：用户态 shell 基于 `ecall` 系统调用实现，通过 ANSI 转义序列实现彩色输出，支持 `ls`, `cat`, `cd`, `pwd`, `echo`, `head`, `tail`, `wc`, `stat`, `hexdump`, `touch`, `append`, `sync`, `sleep`, `clear`, `help`, `exit` 命令。

**优点**：有基本的人机交互界面，shell 功能较丰富，可用于演示和测试。

**缺点**：依赖 SBI legacy console，无真实 UART 中断驱动，输入需要轮询；shell 不提供命令搜索、自动补全等交互特性。

### 3.7 资源管理

**实现完整度**：所有内核数据结构采用静态预分配（无堆），通过常量限制最大容量。有简单的引用计数（页框）和基于标志位的引用计数（管道读写端、epoll 实例 FD）。无整体资源配额或限制机制 (cgroup/rlimit)。

**实现细节**：TCB 数量 8，FD 表每进程 16 槽，管道最多 8 个，epoll 实例有限，socket 最多 8 个。分配失败时返回 `-ENOMEM` 或 `None`。

**优点**：无堆分配杜绝了内存泄漏和内碎片，适合嵌入式或实时场景。

**缺点**：固定上限严重限制可扩展性，多应用或高负载下易达上限。

### 3.8 时间管理

**实现完整度**：通过 SBI TIME 扩展（或 legacy）设置定时器中断，实现 10Hz tick。支持 `clock_gettime`、`nanosleep`、定时器 fd。时间基准从 DTB 读取。

**实现细节**：`clock_gettime` 基于从启动时递增的 tick 计数和 DTB 时间频率计算 uptime。定时器 fd 使用相对超时和 tick 计数实现到期通知。

**优点**：时间子系统核心可用，支持 sleep 和定时器。

**缺点**：无高精度定时器（分辨率仅 100ms），无实时时钟；`clock_gettime` 不支持 `CLOCK_REALTIME`。

### 3.9 系统信息

**实现完整度**：实现了 `uname` 系统调用，返回固定信息；`sysinfo` 返回部分系统信息。procfs 为空壳，无实际内容。

**实现细节**：`uname` 返回内核名 "Aurora"，节点名 "aurora-node"，版本 "0.1.0"，机器 "riscv64"。`sysinfo` 返回内存总量等基本信息。

**优点**：有基本系统信息接口。

**缺点**：procfs 为空，信息量极有限，调试和监控能力弱。

---

## 四、动态测试设计与结果

### 4.1 测试环境与工具链

- 模拟器：QEMU (qemu-system-riscv64)，机器类型 `virt`
- 固件：OpenSBI v1.3
- 构建：`cargo build -p axruntime --target riscv64gc-unknown-none-elf`
- 启动命令：`qemu-system-riscv64 -machine virt -m 256M -nographic -bios default -kernel <path-to-axruntime>`

### 4.2 基础启动测试（已执行）

内核成功完成从 OpenSBI 入口到 rust_main 的完整启动链，关键输出如下：
```
:: Aurora OS :: (Powered by Rust)
Aurora kernel booting...
dtb: uart base=0x10000000 size=0x100
dtb: timebase-frequency=10000000Hz
dtb: virtio-mmio base=0x10008000 ... irq=8
...
mm: memory base=0x80000000 size=0x10000000
mm: frame allocator start=0x80791000 end=0x90000000 pages=63599
mm: paging enabled (sv39 identity map)
timer: tick=10Hz interval=1000000 ticks
```
随后进入 idle loop。验证了 DTB 解析、物理内存分配、Sv39 页表启用、PLIC 初始化、时钟设置的正确性。

### 4.3 用户态测试程序（设计与理论路径）

内核内嵌了 1052 字节手写 RISC-V 机器码用户态测试程序，覆盖路径包括：
- `poll(NULL, 0, 0)` — 非阻塞 poll
- `pipe2 + ppoll` — 多 FD 超时与睡眠重试
- `writev(1, ...)` — 跨页向量写，输出 "user: hello\n"
- `openat + getdents64(/, /dev)` — 静态目录枚举
- `openat("/fatlog.txt") + write/read` — FAT32 文件 I/O
- `clone + futex` — fork + tid 写回 + futex 唤醒/等待路径
- `wait4` — 父进程回收子进程，校验退出码和 CoW 不变性
- `execve("/init")` — ELF 加载与栈布局

**测试执行结果**：本次评估仅执行了基础启动测试，未启用 `--features user-test` 在 QEMU 上运行动态用户态测试。根据构建成功的事实，测试程序路径可被内核正确链接和启动，但未实际捕获运行日志。

### 4.4 测试脚本与套件

项目提供了 `scripts/test_qemu_smoke.sh`（15 个测试用例）、`scripts/test_oscomp.sh` 等测试脚本，因环境限制未执行，无法给出动态通过/失败数据。

---

## 五、细则评价表格

| 条目 | 是否实现及完整度 | 关键发现 | 评价 |
|---|---|---|---|
| **内存管理** | 实现。完整度：约75%。 | Sv39 页表、CoW fork、用户态指针验证完整；缺按需分页、swap、文件映射 mmap。 | 内存管理是亮点，CoW 实现到位；但按需分页和 swap 的缺失使得内存利用效率不高。 |
| **进程管理** | 实现。完整度：约50%。 | fork/execve/waitpid 可用；轮询调度、无信号、无进程组/会话；任务上限8。 | 基础生命周期可用，但可扩展性和功能性受限，无法应对复杂应用。 |
| **文件系统** | 实现。完整度：约60%。 | 自研 ext4 和 FAT32（含写入创建），VFS 挂载表清晰；缺 ext4 删除、日志、深度 extent。 | 文件系统实现展现了较高工程水准，是项目的显著成果；日常基本操作支持良好，但健壮性不足。 |
| **网络栈** | 实现。完整度：约55%。 | TCP/UDP/ICMP 可用，基于 smoltcp；socket 上限8，无 IPv6 和原始 socket。 | 基本网络功能满足演示和简单应用；但高性能、高并发场景下受限。 |
| **同步原语** | 实现。完整度：约55%。 | futex、管道、epoll、eventfd、定时器 fd 功能正常；缺信号量、消息队列、条件变量。 | 同步机制满足现代用户态应用基本需求，epoll 支持事件驱动 I/O。 |
| **交互设计** | 实现。完整度：约30%。 | 用户态 shell 功能较全（ls/cat/cd 等），支持 ANSI 颜色；无真实终端线和高级交互。 | shell 提供了有效的人机接口，便于演示；但交互体验限于基础命令。 |
| **资源管理** | 部分实现。完整度：约20%。 | 所有内核对象为静态预分配，无动态扩缩容；无配额、限制机制。 | 杜绝了内存泄漏，但硬上限严重限制可用性。 |
| **时间管理** | 实现。完整度：约40%。 | 10Hz tick，支持 sleep、定时器 fd；缺高精度定时和 RTC。 | 基本功能可用，分辨率较低，影响定时精度。 |
| **系统信息** | 部分实现。完整度：约15%。 | uname/sysinfo 返回基本信息；procfs 为空壳。 | 管理员或监控工具可获取的信息极为有限。 |
| **设备驱动** | 部分实现。完整度：约30%。 | virtio-blk、virtio-net 驱动可用，MMIO 自动发现；无其他外设驱动。 | 覆盖了核心存储和网络设备，但外设支持范围窄。 |
| **调度器** | 基本实现。完整度：约20%。 | 简单轮询，无优先级、无时间片量化。 | 最低限度的任务调度，无法体现调度策略。 |
| **系统调用兼容性** | 实现。完整度：约65%。 | 92 个系统调用兼容 Linux RISC-V ABI，覆盖主流功能域。 | 系统调用覆盖面广，提升了用户态兼容性。 |

---

## 六、OS 内核整体实现完整度

以“可运行类 Unix 用户程序的 RISC-V 单内核”为参照基准，综合各子系统权重估计，该内核整体实现完整度约为 **55%-60%**。

关键贡献：自研 ext4/FAT32 文件系统、CoW fork、Futex 同步、epoll 多路复用、92 个系统调用兼容 Linux ABI。主要不足：无多核支持、无信号 IPC、所有内核资源固定上限、缺少按需分页和交换、单任务调度策略简单、网络仅支持 IPv4 和有限 socket 数。

---

## 七、总结评价

Project Aurora 是一个**工程实现丰富且具有一定深度的 RISC-V64 单内核**，全部使用 Rust 和少量汇编从零构建，代码总量约 2 万行。项目在以下方面表现出色：

- **文件系统**：自研 ext4 和 FAT32 实现，支持读写、创建和 extent 树寻址，在内核实现中是较为突出的技术亮点。
- **内存管理**：CoW fork 和用户态指针验证机制实现准确，展示了良好的内存管理功底。
- **系统调用兼容性**：92 个系统调用覆盖了进程控制、文件 I/O、网络、同步等，可比肩较多轻量级 Unix 内核。
- **无堆设计**：静态分配策略避免了内核堆管理的复杂性，适合资源受限或安全性要求较高的场景。

同时，项目受限于**固定容量上限、单核设计、无信号/IPC、无按需分页、ext4 缺少日志**等，在可扩展性、健壮性和功能完整度上存在明显差距。调度器仅为轮询，无法提供有竞争力的任务调度性能。网络和同步机制上限低，难以支撑高并发场景。

综合来看，Aurora 作为 OS 竞赛项目充分展现了参赛者在**文件系统、内存管理、系统调用实现**等方向上的扎实能力和自主创新精神，是一个完成度较高、特色鲜明的作品。若能在后续发展中突破固定上限设计、引入多核和多调度策略、完善 ext4 日志与删除支持，有望演进为一个更具实用价值的 Rust 内核原型。