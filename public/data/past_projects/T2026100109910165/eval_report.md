# OSKernel2026 技术画像与评估报告

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| **项目名称** | OSKernel2026 |
| **目标架构** | RISC-V (RV64 Sv39, 主要)、LoongArch (LA64, 骨架) |
| **实现语言** | C (GNU11) + 汇编 (RISC-V / LoongArch) |
| **生态归属** | 独立 freestanding UNIX-like 内核，兼容 Linux 系统调用接口 |
| **构建系统** | GNU Make，单 Makefile 支持双架构条件编译 |
| **运行平台** | QEMU virt (RISC-V)、QEMU virt (LoongArch, 有限) |
| **固件依赖** | OpenSBI (RISC-V SBI 1.3)、LoongArch 固件 DMW |
| **代码规模** | 约 22,700 行 (44 个源文件)，其中 RISC-V trap 层占 31.1% |
| **主要特点** | VFS 统一抽象、Sv39 三级页表、只读 EXT4 extent 支持、ELF64 动态链接、70+ Linux 兼容系统调用 |

## 二、子系统实现清单

| 子系统 | 实现状态 | 关键模块/文件 |
|--------|----------|---------------|
| 平台抽象层 | RISC-V 完整，LoongArch 基础 | `arch/riscv/platform.c`, `arch/loongarch/platform.c` |
| 内存分配器 | 基本完整 (first-fit 堆 + 单页分配器) | `kernel/mm.c` |
| 虚拟文件系统 (VFS) | 框架完整 | `kernel/vfs.c` |
| EXT4 文件系统 (只读) | 部分完整 | `kernel/ext4.c` |
| tmpfs 内存文件系统 | 基本完整 | `kernel/tmpfs.c` |
| devfs 设备文件系统 | 骨架 + 1 个功能设备 | `kernel/devfs.c` |
| procfs 信息文件系统 | 基本完整 (内联于 VFS) | `kernel/vfs.c` (内联实现) |
| 管道 (Pipe) | 基本完整 | `kernel/pipe.c` |
| 控制台 | 最小实现 (仅 write) | `kernel/console.c` |
| VirtIO 块设备驱动 | 仅读取、轮询 | `kernel/virtio_blk.c` |
| 进程管理 | 框架完整 | `kernel/proc.c` |
| ELF64 加载器 | 完整 (含动态链接、shebang) | `kernel/elf.c` |
| 用户地址空间 (Sv39) | 完整 | `arch/riscv/user.c` |
| RISC-V Trap 与系统调用 | 完整 | `arch/riscv/trap.c`, `arch/riscv/trap_entry.S` |
| 调度器 | 最小实现 (简单轮转) | `arch/riscv/sched.c` |
| 时钟与定时器 | 基础实现 | `arch/riscv/timer.c` |
| 信号处理 | 框架完整 | `arch/riscv/trap.c` (内联) |
| Futex | 基本操作支持 | `arch/riscv/trap.c` (内联) |
| SysV 共享内存 | 基本接口 | `arch/riscv/trap.c` (内联) |
| Socket 接口 | 全部 stub | `arch/riscv/trap.c` (内联) |
| LoongArch 用户态 | 未实现 | `arch/loongarch/trap.c`, `arch/loongarch/user.c` |

## 三、各子系统实现完整度与细节评估

### 3.1 内存管理

**实现内容**：
- `kmalloc` / `kfree`：基于空闲链表的 first-fit 堆分配器，按 16 字节对齐，释放时按地址顺序合并相邻块。
- `page_alloc` / `page_free`：独立单向空闲链表，每次分配单页 (4096 字节) 并清零。
- 分配起点为链接符号 `__kernel_end`，单向增长至 `heap_end` (2 GiB 上限硬编码)。
- `mm_total_mem()` / `mm_free_mem()`：统计函数，空闲内存统计不包含页空闲链表中的页面（近似值）。

**未实现**：
- 多页连续分配 (仅单页)
- 伙伴系统或 slab/slub
- SMP 并发锁 (全局状态无保护)
- kfree 合法性检查 (不验证头部魔数或边界)

**实现完整度**：约 50%（以 Linux 内核内存管理为基准）。核心分配功能可用，但缺乏高效的多页分配策略和并发安全保护。

**优点**：
- 分配合并逻辑正确，按地址排序插入空闲链表可实现物理相邻块的合并。
- 页分配器与堆分配器共享增长边界，无固定分区限制。

**缺点**：
- first-fit 可能导致严重的外部碎片，长时间运行后碎片化风险高。
- 无 free 验证机制，双重释放或随机地址释放会导致堆损坏且难以调试。
- 硬编码 2 GiB 内存上限，无法适配不同规格的 QEMU 配置。

---

### 3.2 进程管理

**实现内容**：
- 完整的进程控制块 (`struct proc`，110+ 字段)：状态、地址空间、内核上下文、trap frame、16 KiB 内核栈、PID/PPID/TGID、退出码、信号挂起/掩码/处理动作、mmap 区域表 (512 条目)、文件描述符表 (128 条目)、cwd、umask、定时器、futex 等待状态。
- 进程表：64 个静态槽位，单调递增 PID 分配。
- 状态机：`UNUSED → READY → RUNNING → (WAITING/ZOMBIE/DEAD) → UNUSED`。
- `proc_create()`：槽位分配 + 地址空间复制 + trap frame 分配。
- `proc_fork()`：支持 `CLONE_VM`、`CLONE_SETTLS`、`CLONE_CHILD_SETTID`、`CLONE_CHILD_CLEARTID` 等标志，fd 表增加引用计数，管道继承。
- `proc_exit()`：关闭所有 fd、释放地址空间、主线程进入 ZOMBIE、向父进程发送 SIGCHLD、唤醒等待父进程。
- `proc_destroy()`：回收所有资源并重置槽位为 UNUSED。
- `wait4` 实现：支持 `WNOHANG`、`WUNTRACED`、`__WALL` 等选项。

**未实现**：
- 进程组/会话管理 (setsid/setpgid 系统调用存在但仅返回 0)
- 资源限制 (rlimit)
- cgroup
- 就绪队列等高效调度数据结构
- 进程亲和性 (sched_setaffinity/getaffinity 为 stub)

**实现完整度**：约 65%。fork/exec/exit/wait 核心路径完整且经过系统调用集成，线程组支持基本可用，但缺乏资源管控和高级调度策略。

**优点**：
- `struct proc` 设计紧凑但覆盖面广，将信号、内存映射、文件描述符、futex 等集成到单一结构中，减少了间接引用。
- fork 的 fd 引用计数和管道继承逻辑正确，避免了常见的文件描述符泄漏问题。
- 僵尸进程回收与父进程通知 (SIGCHLD) 路径完整。

**缺点**：
- 进程表固定 64 槽位且线性扫描 (`find_proc_by_pid_local()`)，扩展性差。
- 无就绪队列，调度器需全表扫描查找就绪进程。
- `CLONE_THREAD` 与线程组主线程的区分处理 (ZOMBIE vs DEAD) 代码路径较复杂，存在边界条件风险。

---

### 3.3 文件系统

#### 3.3.1 VFS 框架

**实现内容**：
- 四层核心结构：`super_block` (超级块)、`inode` (索引节点)、`dentry` (目录项)、`file` (打开文件)。
- 操作接口：`inode_operations` (lookup/mkdir/create)、`file_operations` (read/write/readdir/truncate/open)。
- 路径解析 (`vfs_path_walk`)：按 `/` 分割组件，支持挂载点穿越、`.` 和 `..` 导航。
- 挂载系统：全局 `mount_list` 单向链表，`vfs_do_mount()` 创建挂载结构。
- 全局文件表：1024 槽位，引用计数管理。

**未实现**：
- inode cache / dentry cache (每次路径解析均委托给具体文件系统)
- 权限检查 (无 UID/GID 验证)
- 符号链接 (`symlink`/`readlink` 系统调用为 stub)
- 文件锁 (flock/fcntl 锁定)
- `mmap` 文件映射的页缓存

**实现完整度**：约 60%。核心抽象层设计合理，足以支撑多种文件系统的统一访问，但缺少缓存和权限模型。

**优点**：
- 统一抽象设计良好：EXT4、tmpfs、devfs、procfs、pipe 均通过 `file_operations` / `inode_operations` 接入，系统调用层无需区分底层实现。
- 挂载点穿越逻辑与路径解析解耦清晰。
- procfs 内联于 VFS 模块，减少了模块间依赖。

**缺点**：
- 无 inode/dentry 缓存导致每次路径查找均需深入到具体文件系统（对于 EXT4 意味着遍历目录数据块），性能低下。
- 符号链接缺失使得该特性对 POSIX 兼容性形成硬伤。
- `file` 结构中的 `f_owns_metadata` 字段引入了释放语义的耦合，增加理解成本。

#### 3.3.2 EXT4（只读）

**实现内容**：
- 超级块解析：魔数验证 (`0xEF53`)、块大小 (1024-4096 字节)、块组描述符、inode 大小/结构。
- Inode 读取：通过块组描述符表定位 inode 表，按 inode 号索引读取。
- Extent 遍历：支持 depth=0 (叶子节点在 inode 内) 和 depth=1 (一层索引节点)，解析 `ee_block`、`ee_start_lo/hi`、`ee_len`。
- 文件数据读取 (`ext4_read_inode_range`)：遍历 extent 树定位数据块，支持跨 extent 读取。
- 目录遍历 (`ext4_iterate_dirents`)：解析 EXT4 目录项结构 (inode、rec_len、name_len、file_type、name)，支持分页读取 (start_index)。
- 目录项缓存：全局 `cached_dirents[8192]` 数组，首次扫描目录时填充，后续 `find_cached_dirent()` 查找无需读盘。
- 测试脚本系统：递归扫描根目录 (深度 ≤ 4)，识别 `*_testcode.sh`，按优先级排序后通过 busybox sh 执行。

**未实现**：
- 文件写入、创建、删除
- 深层 extent (depth ≥ 2)
- 间接块映射 (传统 inode 数据映射方式)
- 日志 (journal)
- 扩展属性 (xattr)

**实现完整度**：约 45%（以可读写 EXT4 为基准），约 75%（以只读 EXT4 数据访问为基准）。

**优点**：
- 支持 extent 映射（而非固定间接块），适配现代 EXT4 格式。
- 目录项缓存策略针对评测场景（文件系统内容固定）设计，避免了重复磁盘 I/O。
- 测试脚本优先级排序机制体现了面向评测的工程务实性。

**缺点**：
- extent 深度仅支持 0-1，无法处理大文件或高度碎片化的 EXT4 文件系统。
- 目录项缓存无失效机制——若文件系统内容在运行时发生变化（尽管当前只读），缓存将不准确。
- 依赖 VirtIO 单扇区读取，每次读取 512 字节，对于大块数据读取效率极低。

#### 3.3.3 tmpfs

**实现内容**：
- 文件创建、读写、截断。
- 动态扩容：初始容量 64 字节，每次翻倍 (`capacity *= 2`) 直到满足需求。
- 目录创建与遍历 (`readdir` 输出文件名列表)。
- 通过 VFS `vfs_link_child()` 和 `vfs_find_child()` 管理目录树。

**未实现**：
- 文件删除 (unlink/rmdir 未明确实现)
- 时间戳 (atime/mtime/ctime)
- 权限位实际生效（mode 字段被存储但未在访问时检查）

**实现完整度**：约 70%。基本读写可用，但缺少删除和时间戳支持。

**优点**：
- 扩容策略简单有效，翻倍扩容在频繁小写入场景下可减少重新分配次数。
- 与 VFS 的集成干净：所有目录操作委托给 VFS 的标准 dentry 操作。

**缺点**：
- 每次扩容均通过 `kmalloc` 分配新缓冲区并 `kmemcpy` 旧数据，无原地扩展策略，大文件写入内存开销和碎片化风险高。
- 无文件删除导致 `/tmp` 在长期运行后无法释放已用空间。
- `truncate` 扩展时逐字节写零填充，效率极低。

#### 3.3.4 devfs

**实现内容**：
- 8 个静态设备节点：null、zero、tty、console、random、urandom、cpu_dma_latency、misc/rtc。
- `cpu_dma_latency`：实现读写回调，维护 32 字节静态缓冲区。
- 其他 7 个设备：read/write 回调为 NULL，返回 0（无实际数据语义）。

**未实现**：
- null 的丢弃写入和返回 EOF 读取
- zero 的返回零字节语义
- random/urandom 的随机数生成
- tty/console 的读取和 termios

**实现完整度**：约 40%。骨架和注册机制完整，但仅 1 个设备有实际功能。

**优点**：
- 设备节点注册与 VFS 深度集成，通过 `devfs_node_desc` 描述符和可选回调实现灵活的设备扩展。
- `cpu_dma_latency` 的读写路径正确，展示了设备回调的可用性。

**缺点**：
- 核心设备 (null/zero/random/tty) 无实际语义，导致依赖这些设备的用户程序行为异常。
- 无动态设备注册接口。

#### 3.3.5 管道 (Pipe)

**实现内容**：
- 全局管道表：128 个槽位，每个管道含 4096 字节环形缓冲区。
- 阻塞读写：缓冲区空时读端 yield 等待，缓冲区满时写端 yield 等待。
- 非阻塞模式：返回 `-EAGAIN`。
- 读端关闭检测：写端返回 `-EPIPE`。
- 信号中断检测：阻塞等待期间检查 `signal_pending`，返回 `-EINTR`。
- 逐字节用户/内核数据传输 (`read_user8`/`write_user8`)。

**未实现**：
- splice/sendfile 零拷贝传输
- poll/select 显式支持 (仅通过 yield 隐式等待)

**实现完整度**：约 80%。POSIX 管道语义 (阻塞/非阻塞/EPIPE/EINTR) 均正确实现。

**优点**：
- 阻塞/非阻塞模式切换、EPIPE、EINTR 等边界语义完整，与 Linux 行为一致性好。
- 管道端点在进程 fork 时正确继承，退出时正确解绑 (proc_exit 中 fd 关闭触发管道端点清理)。

**缺点**：
- 逐字节复制 (`read_user8`/`write_user8` 每字节一次用户态访问) 效率极低。
- 4 KiB 固定缓冲区限制了大块数据传输的吞吐量。

---

### 3.4 交互设计

**实现内容**：
- 串口输出 (`platform_putc` → NS16550 UART MMIO)。
- 串口输入（代码中存在 `getchar` 引用但串口输入读取路径未验证）。
- 控制台 `write` 操作：逐字节从用户缓冲区读取并输出到串口。
- 无图形界面、无终端控制 (termios) 支持。

**实现完整度**：约 30%。输出路径可用，输入路径不明确，控制台语义不全。

**优点**：
- 串口输出实现简洁，通过 NS16550 的 LSR 寄存器轮询实现流控。
- 内核打印功能 (`kputc`/`kputs`/`kputhex64`/`format`) 自包含，无外部依赖。

**缺点**：
- 控制台不支持 `read` 操作，用户程序无法从终端读取输入。
- 无 termios 支持 (tcgetattr/tcsetattr 等)，限制了交互式程序的行为。

---

### 3.5 同步原语

**实现内容**：
- Futex 系统调用：支持 `FUTEX_WAIT`、`FUTEX_WAKE`、`FUTEX_WAIT_BITSET`、`FUTEX_WAKE_BITSET`、`FUTEX_REQUEUE`、`FUTEX_CMP_REQUEUE`、`FUTEX_WAKE_OP`。
- `FUTEX_WAIT`：检查用户空间值是否匹配 `futex_wait_val`，匹配则设置 `futex_waiting` 标志并 yield。
- `FUTEX_WAKE`：扫描进程表唤醒最多 `val` 个等待同一地址的进程。
- `FUTEX_REQUEUE` / `FUTEX_CMP_REQUEUE`：从源 futex 地址迁移等待者到目标地址。

**未实现**：
- Futex PI (优先级继承)
- Futex robust list
- 内核内的锁原语 (自旋锁/互斥锁：所有内核数据结构无并发保护)

**实现完整度**：约 55%。基本的 WAIT/WAKE 语义正确，CMP_REQUEUE 等较复杂操作的实现路径存在。

**优点**：
- Futex 是用户态同步的核心基础设施，WAIT/WAKE 正确实现即可支撑 pthread_mutex/pthread_cond 等 NPTL 同步原语。
- 进程表扫描唤醒方式虽低效但在 64 进程限制下可接受。

**缺点**：
- 内核自身无任何锁机制——SMP 场景下所有内核数据结构均不安全。
- `FUTEX_WAKE_OP` 操作因在用户态执行条件操作而存在 TOCTOU 风险。
- 无超时等待 (FUTEX_WAIT 不支持绝对/相对超时，尽管系统调用接口接受 timeout 参数)。

---

### 3.6 资源管理

**实现内容**：
- 物理内存：kmalloc/page_alloc 提供动态内存分配。
- 文件描述符：每进程 128 槽位，引用计数管理。
- 全局文件表：1024 槽位，引用计数管理。
- 管道表：128 槽位。
- 进程表：64 槽位。
- 虚拟地址空间：mmap 区域表（每进程 512 条目）、brk 管理。

**未实现**：
- 资源配额与限制 (rlimit，`prlimit64` 系统调用为 stub)
- 资源使用统计 (taskstats)
- 内存压力下的分配失败处理 (kmalloc 耗尽 `heap_end` 后行为未定义)

**实现完整度**：约 45%。有静态上限的资源池管理，但无动态限制和配额机制。

**优点**：
- 静态数组 + 引用计数模式简单明确，分配和释放路径清晰。
- 进程退出时资源回收路径集中 (`proc_exit` → 关闭 fd → 释放地址空间 → 释放 trap frame)。

**缺点**：
- 硬编码上限 (64 进程、1024 文件、128 管道) 限制了系统规模。
- 无资源饥饿防护——任何进程可消耗全部可用内存。
- `mm_free_mem()` 统计值不包括页空闲链表，内存压力判断不准确。

---

### 3.7 时间管理

**实现内容**：
- 定时器中断：基于 SBI Timer 扩展，频率 10 MHz，中断间隔 0.1 秒。
- `timer_handle_interrupt()`：递增 `tick_count`，设置下次中断。
- `timer_usec()`：读取 RISC-V `time` CSR 并转换为微秒。
- 系统调用：`clock_gettime` (CLOCK_REALTIME/MONOTONIC)、`clock_getres`、`nanosleep`、`clock_nanosleep`、`gettimeofday`、`times`、`getitimer`/`setitimer`（部分为 stub）。
- 循环定时器保护：在 `ext4_run_test_scripts` 的脚本执行循环中定期调用 `scheduler()`。

**未实现**：
- 高精度定时器 (hrtimer)
- RTC 读取实际时间（`gettimeofday` 返回 0 基准）
- POSIX 定时器完整实现 (`timer_create`/`timer_settime` 为 stub)
- `timer_usec` 的 10 MHz 频率假设硬编码，未从设备树或 SBI 查询

**实现完整度**：约 50%。基础时钟框架和周期性中断可用，但缺乏实际时间来源和高精度支持。

**优点**：
- SBI Timer 接口使用正确，定时器中断在 RISC-V 上可靠触发。
- `timer_usec()` 直接读取硬件 CSR 避免了软件维护的误差累积。

**缺点**：
- `CLOCK_REALTIME` 无实际时间来源，返回从零开始计数的值。
- 100 毫秒的调度粒度较粗，影响交互响应性。
- `gettimeofday` 缺乏底层 RTC 驱动支持。

---

### 3.8 系统信息

**实现内容**：
- `/proc` 文件系统（内联于 VFS 模块）：
  - 固定节点：`/proc/mounts`、`/proc/meminfo`、`/proc/uptime`、`/proc/stat`、`/proc/self/`。
  - 动态 PID 目录：`/proc/<pid>/status`、`/proc/<pid>/cmdline`。
  - `uptime`：基于 `tick_count` / 10 计算秒数。
  - `meminfo`：输出 `mm_free_mem()` 和 `mm_total_mem()` 信息。
- 系统调用：`uname` (返回固定值 "OSKernel2026")、`sysinfo`、`getrandom` (实现为 32 字节固定种子)。

**未实现**：
- `/proc/cpuinfo`、`/proc/meminfo` 详细字段（仅有基本内存统计）
- `/proc/version`、`/proc/devices`、`/proc/filesystems`
- `sysinfo` 的详细字段（仅填充 uptime 和 freeram 部分字段）
- `getrandom` 的真正随机源

**实现完整度**：约 40%。基本信息接口存在，但信息种类和准确性有限。

**优点**：
- procfs 模板化设计允许快速添加新的固定信息节点和动态 PID 目录。
- 动态 PID 目录通过 `lookup` 时生成 inode 的方式，避免了预先为所有进程创建条目的开销。

**缺点**：
- `meminfo` 统计不准确（空闲内存不含页链表），程序依赖 `/proc/meminfo` 决策时可能误判。
- `getrandom` 使用固定种子，不符合系统随机数接口的安全预期。

---

### 3.9 平台抽象与构建系统

**平台抽象**：
- 接口层 (`include/platform.h`) 定义 8 个平台无关函数，RISC-V 实现完整，LoongArch 基础。
- RISC-V：NS16550 UART、SBI 关机、VirtIO MMIO 4 槽位、`fence iorw,iorw` IO 屏障。
- LoongArch：DMW 直接映射串口、ACPI GED 关机、`dbar 0` IO 屏障。
- 硬编码内存大小 (RV: 2 GiB, LA: 448 MiB)，未解析设备树。

**构建系统**：
- 单 Makefile，通过 `ARCH_RISCV` / `ARCH_LOONGARCH` 条件编译。
- 分别使用 `riscv64-unknown-elf-gcc` 和 `loongarch64-linux-gnu-gcc`。
- 编译参数严格 (`-Wall -Wextra -Werror -ffreestanding -fno-builtin`)。
- musl 动态加载器嵌入为条件编译特性（依赖交叉编译的 `libc.so` 存在）。

**构建验证**：RISC-V 目标构建成功，无警告，生成 187,776 字节 ELF 文件。LoongArch 工具链不在当前环境，未测试。

**优点**：
- 平台抽象接口简洁，仅 8 个函数覆盖启动所需全部平台差异。
- `__attribute__((weak))` 允许架构无关代码安全编译在未完全实现的架构上。

**缺点**：
- 内存大小和设备地址硬编码限制了可移植性——无法仅通过设备树适配不同 QEMU 配置。
- LoongArch 构建未在当前环境验证。

---

## 四、OS 内核整体实现完整度

以 Linux 内核为完整实现基准 (100%)：

| 维度 | 完整度 | 关键差距 |
|------|--------|----------|
| 内存管理 | 50% | 无伙伴系统、slab、COW、页面换出、SMP 锁 |
| 进程管理 | 65% | 无 rlimit、cgroup、优先级调度、就绪队列 |
| 文件系统 | 55% | EXT4 只读、无符号链接、无 inode/dentry cache |
| I/O 子系统 | 40% | 仅轮询 VirtIO 读取、无中断驱动、无网络协议栈 |
| 同步原语 | 45% | 内核无锁、futex 操作不完整 |
| 系统调用覆盖 | 50% | 70+ 个实现中有 20+ 个为 stub (socket 全部为 stub) |
| 用户态兼容性 | 70% | 可运行 busybox sh + 脚本，但缺少完整 POSIX 环境 |
| 多核支持 | 0% | 单核，所有数据结构无锁 |
| **综合估计** | **约 50%** | 以 Linux 为基准的综合完整度 |

以竞赛评测目标（运行 busybox + 测试脚本）为基准 (100%)：

| 维度 | 完整度 |
|------|--------|
| RISC-V 路径 | 85-90% |
| LoongArch 路径 | 15-20%（仅能启动和输出串口） |

---

## 五、动态测试设计与结果

### 5.1 构建测试

| 测试项 | 结果 | 备注 |
|--------|------|------|
| RISC-V 目标构建 | 通过 | `riscv64-unknown-elf-gcc`, 无警告, 生成 187,776 字节 ELF |
| musl 嵌入 | 跳过 | `/opt/riscv64-linux-musl-cross/.../libc.so` 不存在 |
| LoongArch 构建 | 未执行 | `loongarch64-linux-gnu-gcc` 不在当前环境 |

### 5.2 QEMU 启动测试（无磁盘镜像）

| 阶段 | 结果 | 观察 |
|------|------|------|
| OpenSBI 初始化 | 通过 | v1.3 正常加载，进入 S 模式 |
| 内核入口 (_start) | 通过 | `0x80200000` 正常执行 |
| VirtIO 块设备探测 | 预期失败 | `virtio_blk_init()` 返回 false (无设备) |
| 根文件系统挂载 | 预期失败 | `mount_root_filesystem()` 返回 false |
| devfs/procfs/tmpfs 初始化 | 通过 | 三个内存文件系统正常挂载 |
| 进程系统初始化 | 通过 | `proc_system_init()` 完成 |
| 定时器初始化 | 通过 | `timer_system_init()` 启用时钟中断 |
| 测试脚本执行 | 跳过 | `ext4_run_test_scripts()` 因无 EXT4 快速返回 |
| 系统关机 | 通过 | `platform_shutdown()` 通过 SBI 正常关机 |

### 5.3 功能测试

**未执行**。完整功能测试需要：
1. 创建包含 EXT4 文件系统的 VirtIO 磁盘镜像。
2. 镜像中放置 busybox 二进制、测试脚本和必要的 libc 动态库。
3. 重新启动 QEMU 加载该镜像，观察测试脚本执行结果。

### 5.4 内建测试机制

EXT4 模块中包含 `ext4_run_test_scripts()` 测试框架：
- 自动扫描根目录下 `*_testcode.sh` 文件（深度 ≤ 4）。
- 按优先级排序：basic → busybox → lua → iperf3 → hwpmc → unixbench → cyclictest。
- 通过 busybox sh 依次执行每个脚本。
- 每个脚本执行后调用 `scheduler()` 进行进程调度。
- 该框架在无 EXT4 时快速返回（未触发）。

---

## 六、细则评价

| 评价条目 | 是否实现 | 完整度 | 关键发现 | 评价 |
|----------|----------|--------|----------|------|
| **内存管理** | 是 | 50% | first-fit 堆分配器 + 单页分配器，无伙伴系统/slab/SMP 锁，空闲内存统计不精确 | 基础分配功能可用。分配与释放路径正确（按地址合并相邻块），但缺乏高效多页分配策略和并发保护。first-fit 策略在长时间运行下碎片化风险显著。 |
| **进程管理** | 是 | 65% | 64 静态槽位、完整 fork/exec/exit/wait4 路径、支持 CLONE 标志、信号框架、mmap 区域管理 | 核心进程生命周期管理完整。fork 的 fd 引用计数和管道继承逻辑正确。线程组 (tgid) 主线程/子线程的 ZOMBIE/DEAD 状态区分明确。但固定 64 槽位且线性扫描限制扩展性。 |
| **文件系统** | 是 | 55% | VFS 统一抽象层完整，EXT4 只读 extent 支持，tmpfs 可读写，devfs 骨架，procfs 内联实现 | VFS 设计是项目的最大亮点：四层结构清晰，挂载系统解耦良好，多种文件系统统一接入。EXT4 只读 extent 支持对评测负载足够，但无写入和深层 extent。devfs 核心设备语义缺失。 |
| **交互设计** | 部分 | 30% | 串口输出可用，控制台仅 write 操作，无 termios，串口输入路径不明确 | 输出路径满足基本需求，但无控制台 read 和 termios 限制了交互式程序的使用。调试日志依赖内核内部 `kputc` 而非通过用户态。 |
| **同步原语** | 部分 | 45% | Futex WAIT/WAKE 基本正确，CMP_REQUEUE 路径存在但未验证，内核无锁 | 用户态同步基础设施存在，可支撑 pthread 基本操作。但内核自身无并发保护——所有全局数据结构在 SMP 场景下不安全，当前单核环境下无实际问题。 |
| **资源管理** | 部分 | 45% | 静态上限资源池 (64 进程/1024 文件/128 管道)，引用计数模式，无 rlimit | 资源分配和回收路径清晰，进程退出时资源回收集中。硬编码上限和缺乏配额机制限制了系统在资源竞争场景下的健壮性。 |
| **时间管理** | 是 | 50% | SBI Timer 中断 0.1s 粒度，`timer_usec()` 读取硬件 CSR，CLOCK_REALTIME 无实际时间源 | 周期性定时和微秒级时间查询可用。但缺乏 RTC 驱动导致 REALTIME 时钟无意义（从零计数），100ms 调度粒度较粗。 |
| **系统信息** | 部分 | 40% | /proc 有 mounts/meminfo/uptime/stat/pid 目录，uname/sysinfo/getrandom 存在但信息不完整 | procfs 模板化设计允许快速扩展，但现有信息节点数量和准确性有限。meminfo 空闲内存统计偏差可能误导依赖该信息的程序。 |
| **平台抽象** | 是 | RISC-V 90%, LA 70% | 8 函数接口，RISC-V 完整，LoongArch 仅平台初始化 | 平台接口设计简洁有效。双架构通过条件编译和 weak 符号实现编译时适配。内存和设备地址硬编码是主要局限性。 |
| **构建系统** | 是 | 80% | 单 Makefile 双架构，GCC 严格编译参数，musl 嵌入为条件编译特性 | 构建系统简洁且可靠（RISC-V 构建零警告通过）。LoongArch 构建未验证。musl 嵌入特性增强了动态链接程序的部署便利性。 |
| **系统调用覆盖** | 部分 | 50% | 70+ 个系统调用实现，其中约 20+ 个为 stub (socket 全部为 stub)，约 55 个有实际逻辑 | 以评测需求为导向的选择性实现：I/O、文件系统、进程管理、信号、futex 等核心调用有完整逻辑；网络和高级资源控制为 stub。策略务实但限制了评测范围外的应用兼容性。 |

---

## 七、总结评价

OSKernel2026 是一个面向 RISC-V QEMU virt 平台的自包含 UNIX-like 教学/竞赛型操作系统内核，代码规模约 22,700 行，以 C 和汇编实现。

**核心优势**：

1. **VFS 统一抽象设计成熟**：将 EXT4（磁盘）、tmpfs（内存）、devfs（设备）、procfs（信息）、pipe（IPC）、console（终端）六种文件系统统一到 `file_operations` / `inode_operations` 接口下，系统调用层完全无感底层差异，是本项目架构设计的最大亮点。

2. **Sv39 页表管理扎实**：用户地址空间布局（ELF 段、堆、mmap、VDSO、TLS、trampoline）规划合理，trampoline 页面机制为地址空间切换提供了精巧的解决方案。地址空间复制逻辑正确识别共享区域（trampoline/VDSO/SHM）。

3. **ELF 加载能力突出**：支持 PIE (`ET_DYN`)、动态解释器 (`PT_INTERP`)、shebang (`#!`)、TLS 模板 (`PT_TLS`)、符号表查找，甚至可嵌入 musl 动态加载器。这在同类教学内核中较为少见。

4. **系统调用实现策略务实**：70+ 个系统调用的选择性实现以竞赛评测需求为导向——I/O 操作、文件系统操作、进程管理、信号等核心路径有完整逻辑，futex 和管道边界语义（阻塞/非阻塞/EPIPE/EINTR）处理正确。

5. **工程规范性好**：`-Wall -Wextra -Werror` 零警告构建、weak 符号架构适配、单 Makefile 双架构管理、代码结构分层清晰（arch/kernel/include 三级分离）。

**主要不足**：

1. **无 SMP 支持**：所有内核数据结构全局无锁，调度器为单核轮转扫描。这是从教学内核向实用内核跨越的最大障碍。

2. **EXT4 只读**：无法创建、修改或删除文件，依赖磁盘上预先准备好的文件系统内容。

3. **无中断驱动的块设备 I/O**：VirtIO 使用忙轮询等待，每次 512 字节，I/O 效率极低。

4. **Socket 全部为 stub**：所有网络调用返回成功但不传输数据，无任何网络协议栈实现。

5. **内存分配器简单**：first-fit 堆 + 单页分配器缺乏高效多页分配策略，无 COW、页面换出、伙伴系统等现代内核标配。

6. **LoongArch 仅为骨架**：仅完成平台初始化和串口输出，用户态（trap/页表/系统调用）全部未实现。

**综合评定**：该项目作为 OS 竞赛内核赛道作品，RISC-V 路径实现了以竞赛评测为目标的完整功能闭环，在 VFS 抽象、Sv39 页表管理、ELF 加载等核心子系统上展现了扎实的工程能力。其模块分层清晰、接口契约明确、系统调用兼容性策略务实，是一个质量较高的教学/竞赛级内核实现。核心短板集中于性能（无中断驱动 I/O、无缓存）和可扩展性（无 SMP、固定上限资源池）方面，以及 LoongArch 路径的实现显著滞后于 RISC-V。