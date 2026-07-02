# SockCore 操作系统内核 — 技术画像与评估报告

---

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| **项目名称** | SockCore |
| **架构支持** | RISC-V64 (riscv64gc) / LoongArch64 (la64) |
| **实现语言** | Rust（内核主体），少量内嵌汇编（RISC-V asm / LoongArch asm） |
| **生态归属** | 独立内核（非 Linux/BSD 衍生），兼容 Linux 系统调用接口（约 53 个 syscall 编号） |
| **内核类型** | 单体内核（monolithic kernel） |
| **调度模型** | 单核协作式调度 |
| **虚拟内存** | RISC-V Sv39 三级页表 / LoongArch 软件管理三级页表 + DMW 直接映射窗口 |
| **文件系统支持** | RamFS（读写）、DevFS（设备节点）、EXT4（只读） |
| **块设备驱动** | VirtIO-MMIO（RISC-V）、VirtIO-PCI Legacy I/O（LoongArch） |
| **用户态支持** | 支持静态链接 ELF（ET_EXEC / ET_DYN）加载运行，传入 argv/envp/auxv |
| **源码规模** | 约 9,533 行 Rust 源码（32 个源文件），约 1,500 行内嵌汇编 |
| **测试基础设施** | 34 个 C 测试用例 + Python 自动化脚本 + 内核内置 runner 框架（约 3,400 行） |
| **构建工具链** | Cargo + rust-lld + GNU Make，目标三元组 riscv64gc-unknown-none-elf / loongarch64-unknown-none |
| **许可协议** | 未在仓库中明确声明（无 LICENSE 文件） |

---

## 二、子系统实现概览

SockCore 内核由以下 11 个子系统构成：

| 序号 | 子系统 | 源码行数 | 核心功能 |
|------|--------|---------|---------|
| 1 | 架构适配层 | ~1,080 | RISC-V Sv39 页表、LoongArch 三级页表 + TLB 软件重填、SBI/UART/MMIO、trap 入口/退出、上下文切换 |
| 2 | 异常/中断处理 | ~200 | Trap 分发（ecall syscall、缺页异常、非法指令），LoongArch 专用异常码处理 |
| 3 | 内存管理 | ~440 | Bump 物理帧分配器、内核堆（bump 分配器）、Sv39PageTable 页表操作、用户页回收池 |
| 4 | 文件系统 | ~660 | VFS 抽象（INode trait, FdTable, FileHandle）、RamFS 读写、DevFS 设备节点、EXT4 只读（含 extent 树） |
| 5 | 设备驱动 | ~575 | VirtIO-MMIO 块设备、VirtIO-PCI Legacy I/O 块设备 |
| 6 | 系统调用 | ~1,950 | 50+ 个 Linux 风格系统调用（文件 I/O、进程管理、内存管理、时间、信息查询） |
| 7 | 进程管理 | ~440 | PID 分配、Process 结构体、协作式调度器（fork/clone/execve/wait4/exit）、Zombie 状态管理 |
| 8 | ELF 加载器 | ~155 | 静态 ELF 解析、段加载、PIE 检测、RISC-V64/LoongArch64 双架构支持 |
| 9 | 测试框架 | ~3,400 | 用例自动发现、真实 ELF/兼容回退双路径执行、setjmp/longjmp 错误恢复、标记输出 |
| 10 | 同步原语 | ~60 | 自旋锁（SpinMutex），基于 AtomicBool + Acquire/Release 内存序 |
| 11 | 控制台 | ~30 | `print!`/`println!` 宏，逐字节调用架构 putchar |

---

## 三、各子系统实现完整度与评价

### 3.1 架构适配层

**实现完整度**：RISC-V 后端约 90%，LoongArch 后端约 75%。

**RISC-V 后端实现细节**：

- 启动入口 `_start` 在 `.text.entry` 段正确设置栈指针并跳转 `arch_init`。
- Trap 向量完整保存/恢复 38 个寄存器（32 GPR + sepc/sstatus/scause/stval/kernel_sp/user_satp），TrapFrame 共 304 字节。
- 利用 `sscratch` CSR 实现用户态/内核态 sp 原子交换。
- SBI 调用封装完整（console_putchar 和 shutdown）。
- 内存布局固定为 256 MiB 物理内存，内核链接地址 `0x80200000`。

**LoongArch 后端实现细节**：

- 启动入口使用硬编码栈地址 `0x07F00000`，内核链接地址 `0x200000`。
- Trap 向量使用 `SAVE0`-`SAVE2` 暂存寄存器完成上下文切换，使用独立 `la_trap_stack`。
- **软件 TLB 重填处理器**：从 TLBRBADV 和 PGDL CSR 提取信息，遍历三级页表，利用 TLBFILL 指令成对填充 TLB 条目（偶数/奇数 PTE 同时写入）。这是 LoongArch 后端最具技术含量的组件。
- DMW 实现内核恒等映射，避免为内核地址空间维护页表。
- 提供两套用户态入口（`enter_user_mode` 分页模式 + `enter_user_mode_nopaging` 无分页模式），尚未统一。
- UART 输出通过 MMIO 操作 `0x1FE001E0`。

**优点**：

- 双架构共享接口设计良好，`arch/mod.rs` 通过条件编译导出统一 API。
- LoongArch TLB 软件重填实现完整且正确处理成对条目特性。
- RISC-V 端 Trap 处理成熟，利用 sscratch 实现无额外访存的 sp 交换。

**缺陷**：

- LoongArch 两套用户态路径并存，维护负担大，行为一致性难以保证。
- 无中断控制器驱动（RISC-V 端缺 PLIC/CLINT，LoongArch 端缺中断处理）。
- RISC-V 端无多核启动支持。

---

### 3.2 异常/中断处理

**实现完整度**：约 85%。

**实现细节**：

- `handle_trap` 根据 `scause` 分发：用户态 ecall（系统调用）完整处理；缺页异常调用 `handle_user_page_fault` 按需分配页；若分配失败且 runner 活跃则通过 `recover_user_fault_to_runner` 恢复。
- RISC-V 端在 syscall 调用前后设置/清除 SSTATUS.SUM 位以允许 S 模式访问用户页。
- LoongArch 端使用独立异常码体系（`LA_ECODE_SYS=11`、`LA_ECODE_TLBI/PIL/PIS/PIF/PME` 等）。
- `TrapFrame` 结构双架构共用，通过条件编译实现架构特定的寄存器访问（如 `syscall_number()` 在 RISC-V 读 a7/regs[17]，在 LoongArch 读 a7/regs[11]）。

**优点**：

- 缺页按需分配与 runner 错误恢复配合良好，用户程序崩溃不会导致内核 panic。
- 双架构共用 TrapFrame 结构减少代码重复。

**缺陷**：

- 设备中断完全未处理（无中断控制器驱动），所有 I/O 依赖轮询。
- 非法指令异常仅打印调试信息后关机，无可恢复的错误处理路径。

---

### 3.3 内存管理

**实现完整度**：约 70%。

**实现细节**：

- **物理帧分配器**：`BumpFrameAllocator` 单调递增分配，`alloc()` 和 `alloc_contiguous(n)` 正常，但 `dealloc` 不存在。已分配物理页不可回收。
- **内核堆**：`SimpleHeap` 基于 bump 指针，32 MiB 固定大小。`dealloc` 仅递减计数器，不回收内存。
- **页表**：`Sv39PageTable` 实现 `PageTable` trait（map/unmap/translate/activate），`walk_create` 按需分配中间页表页，`copy_user_pages` 仅复制 USER 映射（内核映射指针共享），`unmap_leaf` 反向遍历清除叶子 PTE。
- **用户页回收**：`RECYCLED_USER_PAGES` 数组（最多 16,384 个条目）提供有限的用户页重用，`alloc_page()` 优先从池中取。

**优点**：

- `copy_user_pages` 的内核映射共享设计避免了双重维护内核页表的开销。
- 用户页回收池缓解了 BumpFrameAllocator 不释放的问题。

**缺陷**：

- 物理帧分配器和内核堆均不支持真正释放，内存使用不可逆增长。
- 无页面换出（swap）机制。
- 无 COW（Copy-On-Write），fork 时全部用户页物理复制，浪费内存。
- `BumpFrameAllocator::new(PhysAddr::new(0), 0)` 作为 fallback 哨兵值的设计不够直观。

---

### 3.4 文件系统

**实现完整度**：约 75%。

**VFS 层实现细节**：

- `INode` trait 定义 11 个方法，全部提供默认实现，留给具体文件系统按需覆盖。
- `FileHandle` 封装 `Arc<dyn INode>` + 偏移量 + 标志，支持 read/write（自动推进偏移）、seek（SEEK_SET/SEEK_CUR/SEEK_END）。
- `FdTable` 使用 `Vec<Option<Arc<SpinMutex<FileHandle>>>>`，支持 alloc/alloc_shared/alloc_shared_min/alloc_shared_at/fork_clone/close 操作。
- `fork_clone` 执行浅克隆（所有 fd 共享同一 FileHandle），与 POSIX 语义不完全一致。

**RamFS 实现细节**：

- `RamFile` 基于 `Vec<u8>`，支持读写和截断。
- `RamDir` 基于 `Vec<DirItem>`，lookup 为 O(n) 线性搜索。
- 支持 mkdir/unlink/rename（rename 通过移除旧目标再修改源条目名实现覆盖）。

**EXT4 只读实现细节**：

- 超级块解析：从扇区 2 读取，验证魔数 `0xEF53`，提取块大小和 inodes_per_group。
- 块描述符表：计算 GDT 起始块，定位特定块组的 inode 表。
- Inode 读取：通过 `(inode_num-1)/ipg` 和 `(inode_num-1)%ipg` 定位，精确映射 256 字节磁盘 inode 布局。
- **Extent 树遍历**：从 inode 的 block[60] 读取 Extent Header，验证魔数 `0xF30A`；depth=0 时在叶子 extent 中二分查找；depth>0 时递归遍历索引节点。这是 EXT4 驱动中技术要求最高的实现。
- 文件读取：逐块遍历，通过 extent_lookup 定位物理块，处理跨块边界和稀疏文件（空洞填零）。
- 目录读取：解析 EXT4 目录项结构（dirent），提取 inode 号、文件名和文件类型。

**优点**：

- VFS 抽象层设计清晰，INode trait 的默认实现方法使得新文件系统接入成本低。
- EXT4 extent 树遍历实现正确且完整，支持现代 EXT4 默认分配策略。
- RamFS 基本文件和目录操作功能齐全。

**缺陷**：

- EXT4 只读，不支持写入、日志、权限检查（mode/uid/gid 全部忽略）。
- RamFS 目录查找为线性搜索 O(n)，大量文件时性能差。
- `fork_clone` 的 fd 表浅拷贝导致父子进程共享 FileHandle 偏移量，与 POSIX 语义有偏差。
- 无路径名缓存（dcache），每次路径解析从根目录重新遍历。
- DevFS 仅提供 null 和 zero 两个设备节点。

---

### 3.5 设备驱动

**实现完整度**：约 65%。

**VirtIO-MMIO 实现细节**：

- 设备发现：先尝试给定基地址，再扫描 8 个 MMIO 槽位（`0x10001000` 起），通过魔数 `0x74726976` 和设备 ID=2 识别块设备。
- 初始化流程完整：复位 → ACKNOWLEDGE → DRIVER → FEATURES_OK → DRIVER_OK。
- 支持 virtio v1（64 位地址寄存器 `0x080`-`0x0a4`）和 v1 legacy（32 位寄存器 `0x028`-`0x040`）两个版本。
- DMA 结构为 4096 字节对齐的 `VirtIoDma`，8 个描述符 + Avail/Used 环 + 请求头 + 512 字节数据缓冲区 + 状态字节。
- 扇区读取使用三描述符链，自旋等待最多 20,000,000 次迭代，最多重试 4 次。

**VirtIO-PCI Legacy I/O 实现细节**（仅 LoongArch）：

- 使用 I/O 端口指令（`io_r8/r16/r32`、`io_w8/w16/w32`）访问设备。
- 队列大小扩至 256，DMA 结构 `VirtIoPciDma` 相应增大（8192 字节对齐）。
- 通过 `io_w32(base, 8, pfn)` 设置 vring 物理页帧号（legacy PCI 接口）。

**优点**：

- VirtIO-MMIO 支持 v1 和 legacy 两个版本，兼容性较好。
- LoongArch 平台使用 VirtIO-PCI 合理（QEMU loongarch64 virt 平台无 MMIO 块设备）。
- 扇区读取带重试机制和超时检测。

**缺陷**：

- 仅支持块设备，无网络、输入设备、显示驱动。
- 块设备读取为轮询方式（自旋等待），无中断驱动 I/O。
- 无 DMA 缓冲区管理策略，描述符数量有限（MMIO 仅 8 个，PCI 虽增至 256 但仍有限）。
- 无设备热插拔支持。

---

### 3.6 系统调用

**实现完整度**：约 80%。

**实现细节**：

- 定义了 53 个系统调用号常量，完全遵循 Linux RISC-V64 系统调用约定。
- 核心分发函数 `syscall(tf: &mut TrapFrame)` 通过 `match sysno` 路由到具体实现。
- 用户空间内存访问提供了类型安全接口（`user_read_byte`、`user_read_bytes`、`user_write_bytes`、`user_write_u32/u64/usize`、`user_zero_bytes`）。
- RISC-V 利用 SSTATUS.SUM 直接访问用户地址；LoongArch 需通过软件页表遍历转换虚拟地址到物理地址。

**关键系统调用实现状态**：

| 类别 | 完整实现 | 部分实现/存根 |
|------|---------|-------------|
| 文件 I/O | write, read, openat, close, lseek, getdents64, pread64, pwrite64, fstat, fstatat, dup, dup3, fcntl, sendfile(仅返回大小), pipe2（含预填充负载） | ioctl（始终返回 -ENOTTY） |
| 进程管理 | fork, clone（含 CLONE_PARENT_SETTID/CHILD_SETTID/CHILD_CLEARTID）, execve, wait4, exit, getpid, getppid | clone 不支持 CLONE_VM/CLONE_THREAD（返回 -EAGAIN） |
| 内存管理 | brk（含收缩回收），mmap（含 MAP_FIXED/NOREPLACE 和文件映射），munmap, madvise | mprotect 未实现 |
| 时间 | nanosleep（忙等待），gettimeofday，clock_gettime，times | 时间值均为模拟值（基于 FAKE_TIME_MS） |
| 信息查询 | uname, sysinfo, statfs, getrusage, getrandom | 大部分返回硬编码模拟数据 |
| 同步 | futex(FUTEX_WAIT) 始终返回 -EAGAIN | 完整 futex 未实现 |

**优点**：

- 系统调用覆盖范围广，50+ 个 syscall 覆盖了文件 I/O、进程管理、内存管理、时间、信息查询等主要类别。
- 用户空间内存访问接口类型安全，双架构适配良好。
- 按需缺页处理与 brk 自动扩展配合良好。

**缺陷**：

- 部分系统调用存在硬编码行为（pipe2 预填充测试负载、futex 始终 -EAGAIN、ioctl 始终 -ENOTTY），限制了运行任意用户程序的能力。
- nanosleep 使用忙等待实现，浪费 CPU 时间。
- 时间相关系统调用返回模拟时间而非真实时钟。
- 无信号处理机制（signal/sigaction/sigreturn 完全缺失）。

---

### 3.7 进程管理

**实现完整度**：约 60%。

**调度器实现细节**：

- **协作式单核调度**：不依赖时钟中断抢占。fork/clone 后的子进程进入 `PENDING_CHILDREN` 队列，仅在父进程调用 wait4 时切换到子进程运行。
- **进程状态机**：Running → Zombie(exit_code)（进程退出后）/ Waiting（等待子进程）。
- **地址空间复制**：RISC-V 上通过 `Sv39PageTable::copy_user_pages` 递归复制（仅 USER 映射，内核映射共享）；LoongArch 上仅复制 `0x40000000` 以下的用户页。
- **上下文切换**：`try_run_child` 保存父进程 TrapFrame 到 `PARENT_TF`，设置 sp 指向子进程 TrapFrame，跳转 `trap_return` 开始执行子进程。
- **进程回收**：exit 时当前进程标记为 Zombie，从 `PARENT_TF` 恢复父进程上下文。

**优点**：

- 协作式调度模型简单高效，避免了抢占式调度器的复杂开销（时间中断、优先级队列等）。
- 进程间切换路径极致精简（恢复 TrapFrame → trap_return），延迟低。
- fork/wait4/exit 的完整生命周期已打通。

**缺陷**：

- 无双核/多核支持。
- 无线程支持（clone 不支持 CLONE_VM/CLONE_THREAD）。
- 无抢占机制，计算密集型进程会永久占用 CPU。
- 无优先级调度，所有进程平等。
- LoongArch 端地址空间复制仅复制低 4 GiB 用户页，限制了大型应用程序的地址空间使用。
- fork 后的子进程不是由调度器自主选择运行，而是严格依赖父进程调用 wait4。

---

### 3.8 ELF 加载器

**实现完整度**：约 85%。

**实现细节**：

- `parse_elf` 验证魔数、64 位、小端、可执行类型（ET_EXEC 或 ET_DYN），检查目标架构（RISC-V: EM_RISCV=243, LoongArch: EM_LOONGARCH=258）。
- 返回 `LoadedElf { entry, segments, is_pie }`。
- `load_elf_segments` 遍历 PT_LOAD 段，调用闭包完成页表映射和数据复制，关注点分离良好。
- PIE (ET_DYN) 检测已做，但当前基址固定为 0。

**优点**：

- 解析和静态加载完整，关注点分离设计好。
- 双架构支持（通过 EM_RISCV/EM_LOONGARCH 判断）。
- PIE 检测已为未来动态链接预留接口。

**缺陷**：

- 无动态链接器（ld.so），仅支持静态链接 ELF。
- PIE 检测虽存在，但未实现真正的地址随机化或基址偏移。
- 无 shebang（#!）脚本支持。

---

### 3.9 测试框架

**实现完整度**：约 90%。

**实现细节**：

- **用例发现**：从 EXT4 根目录扫描组目录，由 `enabled_group` (policy.rs) 控制启用组。
- **执行策略**：`CompatOnly`（兼容模式输出硬编码结果）、`RealElf`（真实 ELF 执行）、`RealElfWithCompatFallback`（先 ELF 后回退）。
- **真实 ELF 执行**：分配用户页表 → 加载段 → 构造用户栈（64 页，压入 argv/envp/auxv）→ 设置 TrapFrame → setjmp 保存 runner 上下文 → 跳转 trap_return。
- **错误恢复**：`JumpBuf`（14 个寄存器：sp/ra/s0-s11）实现 setjmp/longjmp 风格恢复，`return_to_runner` 恢复 JumpBuf 后跳回 runner 主循环。
- **编译时配置**：通过 25+ 个 `option_env!` 宏在编译时确定测试策略（如 `RV_DISABLE_REAL_LUA`、`LA_REAL_ELF_NOPAGING`、`SCORE_COMPAT_MODE` 等）。

**优点**：

- 完整的用例发现/执行/判定/恢复机制。
- 真实 ELF 和兼容模式双路径，灵活适应测试需求。
- setjmp/longjmp 错误恢复保证测试连续性，单个用例崩溃不影响后续测试。
- 高度可配置的编译时环境变量驱动设计。
- 用户栈构造包含 argv/envp/auxv，兼容标准用户程序。

**缺陷**：

- runner 本身占用约 3,400 行代码（约占内核 35%），比重较大。
- 兼容模式本质上是通过硬编码输出来满足评分要求，降低了测试的真实性。
- 环境变量配置过多（25+），学习成本较高。

---

### 3.10 同步原语

**实现完整度**：约 80%。

**实现细节**：

- `SpinMutex<T>` 基于 `AtomicBool` 实现，`lock()` 使用 Acquire 内存序忙等待，`unlock()` 使用 Release 内存序。`try_lock()` 提供非阻塞版本。
- 要求 `T: Send` 保证线程安全。

**优点**：

- 实现正确，内存序选择恰当（Acquire/Release 保证临界区内可见性）。
- 在单核协作式调度场景下，自旋锁足以保护中断/异常嵌套场景的共享状态。

**缺陷**：

- 仅有 SpinMutex，缺少 Condvar、Semaphore、RwLock 等高级同步原语。
- 自旋等待无退避策略（如 exponential backoff），在争用时 CPU 消耗高。

---

### 3.11 控制台

**实现完整度**：约 85%。

**实现细节**：

- `print!`/`println!` 宏基于 `core::fmt::Write` trait，通过 `Writer` 结构逐字节调用架构 `putchar`。

**优点**：

- 实现简洁，满足基本调试输出需求。

**缺陷**：

- 无缓冲输出，每次字节单独调用 putchar，效率低。
- 无终端控制功能（ANSI 转义序列、颜色等）。
- 无键盘输入驱动（stdin 始终返回 EOF/0 字节）。

---

## 四、动态测试设计与结果

由于当前环境缺少 Rust 的 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 目标（需 rustup 安装），且测试所需的磁盘镜像 `test.img` 不在仓库中，**本次评估未能执行构建与 QEMU 运行测试**。以下分析基于源码静态审查。

### 4.1 测试体系设计

测试分为两层：

**第一层：本地 C 测试用例（`basic_tests/`）**

- 34 个 C 程序，覆盖文件操作、目录操作、进程管理、内存管理、时间等类别。
- 每个测试配套 Python 测试脚本，使用 `ssh_run.py`/`ktool.py` 等工具自动化执行。
- `test_framework.h` 提供精简测试宏（`TEST_START`/`TEST_END`/`assert`）。

**第二层：内核内置 runner 框架（`kernel/src/runner.rs`）**

- 从 EXT4 磁盘自动发现测试组和用例。
- 支持三种执行策略（真实 ELF/兼容模式/回退）。
- 捕获退出代码，输出竞赛标记（`!TEST FINISH!` 等）。
- setjmp/longjmp 恢复机制保障测试连续性。

### 4.2 测试覆盖分析

| 功能域 | 测试文件数 | 覆盖的系统调用 |
|--------|-----------|---------------|
| 文件 I/O | 9 | write, read, openat, close, dup, dup2, lseek |
| 目录操作 | 6 | getcwd, chdir, getdents, mkdir, unlink |
| 进程管理 | 8 | fork, clone, execve, exit, wait, waitpid, getpid, getppid |
| 内存管理 | 4 | brk, mmap, munmap |
| 时间 | 3 | nanosleep, gettimeofday, times |
| 其他 | 4 | pipe, uname, fstat, yield |

测试覆盖了约 65% 已实现的系统调用（53 个 syscall 中约 34 个有对应测试）。未覆盖的主要是信息查询类 syscall（sysinfo/statfs/getrusage 等）和存根 syscall（futex/ioctl）。

### 4.3 测试设计的优缺点

**优点**：

- 两层测试体系（本地 C 测试 + 内核内置 runner）兼顾了开发阶段的快速验证和竞赛环境的自动化评分。
- runner 的错误恢复机制显著增强了测试的鲁棒性。
- 编译时环境变量驱动的策略切换提供了良好的灵活性。

**缺陷**：

- 兼容模式（`CompatOnly`）输出硬编码结果，实质上绕过了真实的功能验证。
- 部分测试用例预填充了期望结果（如 pipe2 预填充 `"  Write to pipe successfully.\n"`），测试的真实性存疑。
- 无压力测试或并发测试（受限于单核协作式调度，这类测试本身无法实施）。

---

## 五、细则评价表格

### 5.1 内存管理

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（物理帧分配、内核堆、Sv39 页表、用户页回收池） |
| **完整度** | 约 70% |
| **关键发现** | 1. BumpFrameAllocator 和 SimpleHeap 均不支持真正释放，内存使用不可逆增长。2. RECYCLED_USER_PAGES 数组（最大 16384 条目）提供有限的用户页重用。3. Sv39PageTable 的 `copy_user_pages` 中内核映射采用指针共享而非物理复制，设计巧妙。4. 无 COW、无页面换出、无页面回收策略。 |
| **评价** | 基础的物理/虚拟内存管理功能可用，能支撑测试用例运行。但分配器不支持释放的设计决定限制了长期稳定性和任意负载的运行能力。用户页回收池是可行的权宜方案，但上限固定（16384 页 = 64 MiB），超出后无回退策略。 |

### 5.2 进程管理

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（fork/clone/execve/wait4/exit、PID 分配、Zombie 状态） |
| **完整度** | 约 60% |
| **关键发现** | 1. 协作式单核调度器，无抢占和时钟中断。2. fork 的子进程不立即运行，进入 PENDING_CHILDREN 队列等待父进程 wait。3. 进程切换仅通过保存/恢复 TrapFrame 实现，路径极简。4. 不支持线程（CLONE_VM/CLONE_THREAD 返回 -EAGAIN）。5. LoongArch 端地址空间复制仅覆盖低 4 GiB 用户页。 |
| **评价** | 进程核心生命周期（创建、执行、等待、退出）完整，符合竞赛场景的基本需求。协作式调度模型简化了实现复杂度，但也从根本上限制了并发和多核扩展的可能性。无线程支持使得以多线程为基础的用户程序无法运行。 |

### 5.3 文件系统

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（VFS 抽象、RamFS 读写、DevFS、EXT4 只读） |
| **完整度** | 约 75% |
| **关键发现** | 1. VFS 层设计清晰，INode trait 的默认方法降低新文件系统接入成本。2. RamFS 功能齐全但目录查找为 O(n) 线性搜索。3. EXT4 extent 树遍历实现完整，支持现代 EXT4 默认分配策略。4. EXT4 仅支持只读，无日志和权限检查。5. `fork_clone` 的 fd 表浅拷贝导致父子进程共享 FileHandle 偏移量。 |
| **评价** | 文件系统层次结构清晰，RamFS 提供完整的读写支持，EXT4 只读读取链路（超级块→GDT→inode→extent→数据块）完整且正确。VFS 抽象层的存在使得未来扩展文件系统类型较为方便。但 fd 表浅拷贝的语义偏差和高复杂度操作（O(n) 查找、无 dcache）是明显的不足。 |

### 5.4 交互设计

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（print!/println! 控制台输出） |
| **完整度** | 约 60% |
| **关键发现** | 1. 控制台输出基于架构 putchar 逐字节调用，无缓冲。2. stdin(fd=0) 始终返回 0 字节（EOF）。3. stdout/stderr 通过 sys_write 直接调用 putchar 输出。4. 无键盘输入驱动，无终端控制功能。5. 系统信息类 syscall（uname/sysinfo/statfs）返回硬编码模拟数据。 |
| **评价** | 基本的文本输出功能可用，满足调试需求。但无输入能力和终端控制使得交互限于单向输出。系统信息类系统调用的硬编码返回值足以支撑固定测试用例，但不能反映真实系统状态。 |

### 5.5 同步原语

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（SpinMutex） |
| **完整度** | 约 50% |
| **关键发现** | 1. SpinMutex 基于 AtomicBool + Acquire/Release 内存序，实现正确。2. 自旋等待无退避策略。3. 缺少 Condvar、Semaphore、RwLock、屏障等高级原语。4. 单核协作式调度场景下，SpinMutex 的实际用途限于防止嵌套 trap 的临界区干扰。 |
| **评价** | 自旋锁实现正确且满足当前单核场景需求。但同步原语的单一性限制了在更复杂并发场景下的应用。考虑到内核本身未实现多核/多线程，同步原语的简化在定位上是合理的。 |

### 5.6 资源管理

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 部分（物理帧分配、用户页回收池、fd 表、PID 分配） |
| **完整度** | 约 55% |
| **关键发现** | 1. BumpFrameAllocator 和 SimpleHeap 不回收资源。2. RECYCLED_USER_PAGES 提供有限页回收（上限 16384 条目）。3. fd 表在 close 时释放条目回到 None 状态。4. PID 分配器（顺序递增）无回收机制。5. 进程退出时地址空间复制未回收子进程分配的内存（依赖 munmap 和回收池）。 |
| **评价** | 资源管理存在明显的"只分不还"倾向。物理内存和内核堆的不可回收性在短期测试中影响有限，但在长期运行场景下不可接受。fd 表和回收池是少数具备回收能力的资源管理组件。 |

### 5.7 时间管理

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（gettimeofday/clock_gettime/nanosleep/times） |
| **完整度** | 约 40% |
| **关键发现** | 1. 所有时间值基于模拟计数器 FAKE_TIME_MS（系统调用触发时递增）。2. nanosleep 通过忙等待循环递减 FAKE_TIME_MS 实现，非真实定时器。3. 无硬件定时器驱动（CLINT/CSR time 等）。4. clock_gettime 对不同时钟 ID 返回不同硬编码偏移值。 |
| **评价** | 时间相关系统调用的接口存在，但底层无真实时钟源。模拟时间的实现使得程序可"运行"但不反映真实时间流逝。缺少定时器中断是实现抢占式调度和超时机制的关键障碍。 |

### 5.8 系统信息

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（uname/sysinfo/statfs/getrusage/proc 伪文件系统） |
| **完整度** | 约 65% |
| **关键发现** | 1. uname 返回 sysname="Linux"、release="5.10.0-sockcore"、machine 依架构为 "riscv64" 或 "loongarch64"。2. proc 伪文件系统预置 meminfo/mounts/stat/uptime 和进程相关文件（1/stat、1/status、1/cmdline）。3. 大部分数据为硬编码常量。4. statfs 返回模拟的 fs 信息。 |
| **评价** | 该系统调用的兼容性目标明确（使 busybox/libc 测试能获取预期格式的系统信息）。proc 伪文件系统的预填充设计合理，覆盖了 busybox 常用查询路径。但信息的真实性有限，仅服务于已知测试用例。 |

### 5.9 设备驱动（补充条目）

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（VirtIO-MMIO、VirtIO-PCI Legacy I/O 块设备） |
| **完整度** | 约 45% |
| **关键发现** | 1. MMIO 设备扫描支持 virtio v1 和 legacy 两个版本。2. PCI Legacy I/O 为 LoongArch 平台专用。3. 所有 I/O 为轮询方式（自旋等待），无中断驱动。4. 仅支持块设备，无网络/输入/显示/音频驱动。 |
| **评价** | 块设备读取驱动能正确完成 EXT4 镜像的数据读取，满足文件系统只读需求。但驱动类型的单一性和轮询方式在通用性方面严重不足。 |

### 5.10 双架构支持（补充条目）

| 评价维度 | 结论 |
|----------|------|
| **是否实现** | 是（RISC-V64 + LoongArch64） |
| **完整度** | 约 75% |
| **关键发现** | 1. 约 80% 内核代码在两架构间共享。2. RISC-V 后端成熟度高于 LoongArch。3. LoongArch 后端存在两套用户态入口（分页/无分页），未统一。4. 用户内存访问方式存在本质差异（RISC-V 利用 SSTATUS.SUM，LoongArch 需软件页表遍历）。5. 系统调用语义双架构一致（共享 syscall 实现代码）。 |
| **评价** | 双架构共享设计是本项目的核心亮点。条件编译 + trait 抽象的架构隔离方式有效。LoongArch 后端的软件 TLB 重填具有技术深度，但两套用户态路径并存的现状增加了维护负担。总体显示出对 RISC-V 和 LoongArch 两种架构底层特性的深入理解。 |

---

## 六、总结评价

SockCore 是一个面向操作系统竞赛场景、使用 Rust 语言开发的双架构（RISC-V64 + LoongArch64）单体内核。内核实现了从裸机启动、内存管理、文件系统、设备驱动、系统调用到进程管理和用户态 ELF 程序执行的完整链路。项目配套了分层测试体系（34 个 C 测试用例 + Python 自动化脚本 + 内核内置 runner 框架），并通过编译时环境变量实现了高度可配置的测试策略。

**核心优势**：

1. **双架构共享设计**：约 80% 的内核代码在 RISC-V 和 LoongArch 之间复用，架构隔离清晰，系统调用语义一致。

2. **完整的功能链路**：启动 → 内存管理 → 文件系统（EXT4 只读 + RamFS 读写）→ 进程管理（fork/clone/execve/wait4/exit 完整生命周期）→ 用户态 ELF 执行（含 argv/envp/auxv 传递）全线贯通。

3. **具备技术深度的局部实现**：EXT4 extent 树遍历、LoongArch 软件 TLB 重填（正确处理成对条目特性）、setjmp/longjmp 风格的用户程序错误恢复、协作式进程调度的精简切换路径。

4. **成熟的测试基础设施**：双路径执行策略（真实 ELF + 兼容回退）、错误恢复机制、编译时可配置的测试编排。

**核心局限**：

1. **资源管理的不可逆性**：物理帧分配器和内核堆均不支持真正释放，依赖固定容量的回收池作为缓解手段。

2. **单核协作式调度的本质限制**：无抢占、无多核、无线程、无定时器中断，从根本上制约了通用性和可扩展性。

3. **部分系统调用的硬编码行为**：pipe2 预填充负载、futex 始终返回 -EAGAIN、ioctl 始终返回 -ENOTTY、时间系统调用返回模拟值。这类行为在竞赛测试场景下可接受，但意味着内核并非真正的通用操作系统。

4. **LoongArch 后端未完全收敛**：分页模式和无分页模式两套路径并存，增加了行为不一致的风险和维护成本。

5. **设备驱动类型单一**：仅有块设备读取能力，无网络、输入设备、中断控制器驱动。

**综合评定**：SockCore 是一个**实现质量较好、功能覆盖广泛、在竞赛场景定位下具备明确优势**的教学/竞赛操作系统内核。其在双架构支持、EXT4 只读驱动、测试框架和 LoongArch TLB 软件重填等方面展现出超出多数同类项目的技术深度。同时，在资源管理、抢占式调度、设备驱动多样性和系统调用真实性等方面的简化也是明确的。项目整体处于同类型竞赛内核的**中上水平**，其双架构共享设计尤其值得肯定。