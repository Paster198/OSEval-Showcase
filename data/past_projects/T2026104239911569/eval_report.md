# RmikuOS 技术画像与评估报告

---

## 一、项目基本信息

| 属性 | 内容 |
|------|------|
| 项目名称 | RmikuOS |
| 架构 | RISC-V 64 (riscv64gc) / LoongArch 64 |
| 实现语言 | Rust (内核) + C/少量 Rust (用户态) |
| 生态归属 | 独立内核，非 Linux/BSD 衍生；Rust 裸机生态 |
| 代码规模 | 内核约 18,000 行，用户态约 12,000 行，总计约 30,000 行 |
| 构建系统 | Cargo + Makefile；用户态使用 Python 脚本 + GCC/rustc 裸机编译 |
| 启动方式 | OpenSBI (RISC-V) / U-Boot (LoongArch) 加载 ELF |
| 根文件系统 | ext4 (只读) + tmpfs + FAT |
| 突出特点 | 双架构支持；自适应 alpha 调度器；VirtIO MMIO/PCI 双传输层 |
| 用户交互 | 交互式 Shell，支持管道、重定向、内建命令 |
| 测试规模 | 55 个 C 测试程序 + 10 个 Rust 用户程序 |

---

## 二、实现的子系统与功能

### 2.1 架构引导层

- RISC-V 64 完整引导（OpenSBI → 汇编入口 → Sv39 分页使能 → 高半虚拟地址切换）
- LoongArch 64 完整引导（DMW 初始映射 → 4 级页表建立 → 高半虚拟地址切换）
- 多核启动框架（主核初始化 + 从核等待）
- 链接脚本支持 LMA/VMA 分离

### 2.2 陷阱与中断处理

- 用户态/内核态陷阱入口分发（汇编保存全部寄存器）
- RISC-V：Supervisor Timer 中断、U-mode ECALL、断点、非法指令、Load/Store/取指错误、页错误
- LoongArch：软件 TLB refill、完整异常编码体系
- 系统调用路由（40 个系统调用号）
- `sscratch` 机制区分用户态/内核态来源

### 2.3 内存管理

- 物理帧分配器（栈式 + 回收链表，支持单帧和连续帧分配）
- 内核堆（16MB，buddy_system_allocator，注册为全局分配器）
- RISC-V Sv39 三级页表抽象（map/unmap/translate）
- LoongArch 四级页表抽象
- 虚拟地址空间 MemorySet（Identical/Linear/Framed 三种映射类型）
- ELF64 加载器（静态 ET_EXEC 解析，段映射，栈分配）
- mmap/munmap 匿名映射（first-fit + 相邻空闲区间合并）
- 用户地址空间布局（Trampoline、TrapContext、栈、堆、mmap 区域）
- 内核直接映射区覆盖 DRAM 和 MMIO 区域

### 2.4 进程管理

- 进程-线程两级模型
- fork（完整地址空间复制，FD 表继承，调度参数继承）
- exec（从文件系统加载 ELF 替换进程映像）
- waitpid（支持 -1 任意子进程和指定 PID 等待）
- exit（Zombie 状态，唤醒等待父进程）
- getpid

### 2.5 线程管理

- thread_create（共享地址空间和 FD 表，pass 初始化为进程内最小）
- thread_exit（Zombie 标记，唤醒 join 等待者）
- thread_join
- 独立内核栈（每线程 128KB，连续物理帧分配）
- 栈溢出检测（magic guard: 0xdead_beef_cafe_babe）

### 2.6 调度器

- 两级 Stride 调度（进程级选择 + 线程级选择）
- 自适应 alpha 调度：effective_tickets = base_tickets × n^(alpha/100)
- alpha ∈ [0, 100]，连续可调，运行时通过系统调用修改
- 纯整数定点数幂算法（无浮点，Newton 迭代开方）
- 缩放因子缓存
- 调度统计查询与重置
- 用户态票数查询/设置

### 2.7 系统调用

40 个系统调用，覆盖：
- 进程：exit、fork、exec、waitpid、getpid、yield、sleep
- 线程：thread_create、thread_exit、thread_join
- 文件：open、close、read、write、getdents、chdir、getcwd、stat、fstat、dup2、pipe、mkdir、create、unlink、rmdir、remove_recursive
- 内存：mmap、munmap
- 调度：set/get_thread_tickets、set/get_process_tickets、set/get_my_tickets、set/get_sched_alpha、get_process_sched_stat、reset_sched_stat
- 系统：get_ticks、shutdown

### 2.8 文件系统

- VFS 抽象层（Inode trait + File trait + 挂载系统）
- ext4（只读，基于 ext4-view crate）
- tmpfs（完整 CRUD，支持目录递归删除）
- FAT（完整读写，基于修改版 fatfs 库，逐扇区 read-modify-write）
- 管道（512 字节环形缓冲区，阻塞读/写语义，引用计数）
- stdin/stdout（UART 轮询）
- 路径规范化（. 和 .. 处理）、最长前缀挂载匹配
- 文件描述符表管理（分配/回收/继承）

### 2.9 块设备

- BlockDevice trait 抽象
- VirtIO-MMIO 块设备驱动（Legacy 和 Modern 传输模式）
- VirtIO-PCI 块设备驱动（PCI 能力解析，common_cfg/notify_cfg/isr_cfg）
- Split Virtqueue 实现（描述符环、Available 环、Used 环）
- 块缓存（64 块 LRU-like，写回策略，Drop 自动 sync）
- RamDisk（嵌入镜像支持）
- 磁盘发现（magic 号 0xef53 识别 ext4 根盘）

### 2.10 PCI 总线

- ECAM 配置空间访问（8/16/32 位读写）
- BAR 解析与分配
- 总线枚举（bus 0，32 设备，8 功能）
- VirtIO 设备识别

### 2.11 I/O 与日志

- NS16550A 兼容 UART 驱动（轮询）
- 控制台输出（print!/println! 宏，SpinLock 保护）
- 日志系统（log crate，ANSI 彩色输出，级别过滤）

### 2.12 同步原语

- SpinLock（CAS 自旋）
- Mutex<T>（泛型自旋锁 + RAII MutexGuard）

### 2.13 定时器

- RISC-V：SBI set_timer（one-shot 模式，约 50ms 间隔）
- LoongArch：CSR 定时器（周期模式）

### 2.14 用户态

- C 运行时（crt0 启动 + 系统调用汇编包装）
- Rust 用户库（syscall 包装 + 高层 API）
- Shell（内建命令、管道、重定向、行编辑）
- 55 个 C 测试 + 10 个 Rust 用户程序

---

## 三、各子系统实现完整程度

| 子系统 | 完整程度 | 关键缺失 |
|--------|----------|----------|
| 架构引导 | 高（双架构引导完整；SMP 框架存在） | 多核调度未实质完成（单调度器全局锁，从核仅参与 idle 循环） |
| 陷阱处理 | 中高（完整的异常/中断/系统调用分发） | 无信号机制；用户态中断无转发；LoongArch 的 C 侧分发链未完全验证 |
| 内存管理 | 中（页表/帧分配器/ELF 加载器/mmap 完整） | 无 COW；无页面换出/换入；无 demand paging；无共享内存 |
| 进程管理 | 中高（fork/exec/waitpid/exit 完整） | 无进程组/session；fork 为全量复制（无 COW 优化） |
| 线程管理 | 中高（create/exit/join 完整；独立内核栈） | 无 TLS；无 futex |
| 调度器 | 高（Stride + 自适应 alpha；用户态可控） | 无多核负载均衡；无实时调度策略 |
| 系统调用 | 中高（40 个系统调用，覆盖面较广） | 无 socket/poll/select；无信号相关；无 times |
| VFS | 中（Inode/File 抽象清晰；挂载系统合理） | 无符号链接；无权限检查；无 inode 缓存 |
| ext4 | 低（仅只读，依赖第三方 crate） | 无写入；文件名仅限 ASCII；无扩展属性 |
| tmpfs | 高（完整 CRUD + 目录递归） | 无文件锁；无 inode 时间戳更新 |
| FAT | 中（完整读写） | 无目录创建/删除；无长文件名 |
| 块设备 | 中高（VirtIO MMIO/PCI 完整；块缓存有效） | 无 NVMe/AHCI；virtio-blk 为同步 I/O（无中断完成通知） |
| PCI | 中（ECAM 完善；BAR 分配） | 无 MSI/MSI-X；无 PCIe 高级特性 |
| I/O | 中（UART 完善） | 无中断驱动 I/O；无多控制台 |
| 同步 | 低（仅 SpinLock 和基础的 Mutex） | 无读写锁；无信号量；无条件变量；无 RCU |
| 用户态 | 中高（55+ 测试；Shell 功能较完善） | 无动态链接支持 |

---

## 四、各子系统优缺点与实现细节

### 4.1 架构引导

**优点**：
- 双架构共享大部分平台无关代码，通过 `#[cfg]` 和模块路径重导出实现清晰的平台抽象
- RISC-V 引导流程规范：三级引导页表（恒等映射 + 高半直接映射）、`satp` 切换后栈地址无缝迁移
- LoongArch 引导覆盖全面：DMW 初始映射、4 级页表建立、CSR 详细配置（CRMD/EENTRY/PGDL/PGDH/PWCL/PWCH/STLBPS/TLBRENTRY/DMW0-3）
- 链接脚本精确控制 LMA/VMA 分离，符号导出完整

**缺点**：
- 多核启动仅为框架：从核自旋等待 → 进入 idle 循环后不再参与实际调度
- 从核在初始化完成后未被纳入调度域，实为单核系统

**实现细节**：
- RISC-V 引导页表仅 3 个 1GB 大页条目覆盖关键区域，初始化后再重建完整页表
- 临时物理栈每核 64KB，hartid 存储在 `tp` 寄存器中供 Rust 侧读取

### 4.2 陷阱处理

**优点**：
- RISC-V 陷阱入口使用 `csrrw sp, sscratch, sp` 原子交换优雅区分用户态/内核态来源
- TrapContext 保存完整（32 个 GPR + 4 个 CSR）
- 系统调用分发链清晰（trap 入口 → handle_syscall → syscall 路由表）
- LoongArch 侧支持软件 TLB refill（168 行汇编）

**缺点**：
- 内核态异常一律 panic（含内核缺页），缺乏容错能力
- 无用户态信号机制，无法向用户进程异步通知事件
- 无用户态中断转发机制
- 断点异常仅跳过（`sepc += 4`），未与调试器集成

**实现细节**：
- `__restore_user` 和 `__restore` 分别处理用户/内核态返回，在 `sstatus.SPP` 判断基础上设定 `sscratch`
- 调度检查仅在 `from_user && should_schedule` 时触发，内核态代码不会被抢占

### 4.3 内存管理

**优点**：
- 帧分配器设计合理：栈式线性增长 + 回收链表，支持连续帧分配/search，双重释放检测
- 页表抽象层次清晰：PageTable/PageTableEntry/PteFlags 分离，RISC-V 和 LoongArch 各自实现
- MemorySet 支持三种映射类型（Identical/Linear/Framed），满足内核和用户态需求
- ELF 加载器完整处理 PT_LOAD 段，正确映射 Trampoline 和 TrapContext 页
- mmap 实现 first-fit 分配 + 相邻空闲区间合并，逻辑正确

**缺点**：
- 无可 copy-on-write 优化，fork 时全量复制地址空间（每个 Framed 区域逐页拷贝数据）
- 无页面换出/换入机制，物理内存用尽即无法分配
- 无 demand paging，ELF 加载时全部页立即分配
- 无共享内存（SHM）支持
- 内核直接映射区域硬编码为从 MEMORY_START 开始，灵活度不够

**实现细节**：
- `alloc_contiguous_frames` 在 recycled 链表中搜索时先排序再查找连续范围，算法正确性有保障
- `map_kernel_areas` 对 MMIO 区域单独处理（不含 X 权限），DRAM 区域授予 R+W+X 权限
- TLS 相关的用户空间预留区域在布局常量中声明但线程创建时未实际使用

### 4.4 进程管理

**优点**：
- fork/exec/waitpid/exit 生命周期完整，状态转换正确
- FD 表 fork 时调用 File trait 的 `on_fork()` 钩子递增管道引用计数
- exec 时通过 `close_non_standard_fds_on_exec()` 关闭 fd≥3 的文件
- 子进程列表维护正确，waitpid 能在进程退出时正确唤醒父进程

**缺点**：
- fork 为全量复制，未实现 COW，内存开销大
- 无进程组/session/job control 概念
- 无 setuid/setgid 等权限管理
- 无进程资源限制 (rlimit)

**实现细节**：
- `fork_from()` 复制 MemorySet 时调用 `clone_framed_area_data()` 逐页拷贝数据
- waitpid 基于 block/wake 模型：父进程封堵到 WaitPid 原因，子进程 exit 时遍历 PCB 唤醒等待者

### 4.5 线程管理

**优点**：
- 线程与进程的正确共享语义（地址空间 + FD 表）
- 每线程独立内核栈（128KB，连续物理帧，magic guard）
- thread_join 正确实现阻塞等待

**缺点**：
- 无线程本地存储（TLS）支持（尽管用户布局中预留了相关区域）
- 无 futex 等用户态同步原语支持
- 无线程优先级概念（与调度器的 tickets 机制可部分替代）
- 线程栈溢出检测仅限 magic guard 检查，未在每次上下文切换时主动校验

**实现细节**：
- 新线程的 `pass` 初始化为进程内所有线程 `pass` 的最小值，确保新线程首次调度不因 pass 偏大被延迟
- TrapContext 放置在内核栈顶部固定偏移处，`__task_entry` 直接通过 `trap_cx_addr` 跳转

### 4.6 调度器

**优点**：
- 自适应 alpha 调度器为项目核心创新点：引入连续参数 α ∈ [0,100]，控制就绪线程数到有效票数的映射曲线
- 纯整数定点数幂算法（`sched_thread_scale`）确保在任何 RISC-V 裸机环境零外部依赖运行
- 缩放因子缓存（`scale_cache` + `cache_alpha`）保证高频查询下的计算开销最小
- 用户态可通过 `set_sched_alpha` 动态调整，配合 20+ 调度测试程序形成实验框架
- 两级 Stride 调度正确实现（进程级选 pass 最小的含就绪线程进程，线程级在选中进程中选最小 pass 线程）

**缺点**：
- 仅单核调度（全局 TASK_MANAGER 锁），多核负载均衡未实现
- 无实时调度策略支持
- alpha 参数的全局性：所有进程共享同一个 alpha 值，无法实现进程级差异化调度策略
- 调度器仅基于 pass 值，无任务优先级/deadline 等其他维度

**实现细节**：
- 定点数基数为 `SCALE = 1<<20`（约 10^6），`sqrt_fp()` 通过 Newton 迭代实现，精度满足调度需求
- `update_process_stride_by_alpha()` 在进程选择阶段动态计算 effective_tickets 和 stride
- `BIG_STRIDE` 和 `tickets` 的默认值分别为常量（100 票基准）

### 4.7 系统调用

**优点**：
- 40 个系统调用覆盖面广，远超同类教学内核
- 用户态数据访问通过 `read_current_user_bytes/write_current_user_bytes` 进行逐页验证，安全性较好
- 路径参数通过规范化函数处理（normalize_path），防御基础路径穿越
- 调度控制系统调用提供完整的用户态调度实验接口

**缺点**：
- 无 socket 系统调用（socket/bind/listen/accept/connect/send/recv）
- 无 poll/select/epoll 等多路复用
- 无信号系统调用（sigaction/sigprocmask/kill）
- 无 time/times/clock_gettime 等时间查询系统调用
- getcwd 实现通过遍历挂载表反推路径，非通过 inode 反向查找，语义不完全正确

**实现细节**：
- `sys_read/sys_write` 使用内核堆分配的中间缓冲区（`vec![0u8; len]`），通过 File trait 读取后再逐页拷贝到用户空间
- `sys_exec` 先通过 VFS 读入完整 ELF 到内核内存，再调用 `MemorySet::from_elf()` 解析加载

### 4.8 文件系统 (VFS)

**优点**：
- Inode/File 双层抽象清晰：Inode 负责目录树操作（lookup/create/mkdir/unlink），File 负责数据读写
- 挂载系统采用最长前缀匹配，支持 `/`、`/tmp`、`/fat` 多挂载点
- 路径规范化正确实现 `.` 和 `..` 处理
- 管道实现引用计数和阻塞语义，符合 POSIX 行为（读端全关返回 0/写端全关返回 EPIPE）

**缺点**：
- 无符号链接
- 无文件权限检查（所有文件对所有用户可读/可写/可执行取决于文件系统实现而非权限位）
- 无统一的 inode 缓存，每次 lookup 穿透到具体文件系统
- 无文件锁 (flock/fcntl)
- getdents 的目录项格式为自定义的 64 字节结构，与 Linux `dirent64` 不兼容

**实现细节**：
- 管道使用 512 字节固定环形缓冲区，读阻塞和写阻塞通过 `block_current_on_pipe_read/write` 实现
- File trait 的 `on_fork()` 和 `on_close_kind()` 钩子分别用于 fork 时引用计数递增和 close 时递减

### 4.9 ext4 文件系统

**优点**：
- 成功挂载真实的 ext4 根文件系统并提供只读访问
- 通过 CachedBlockReader 适配块设备，分离关注点

**缺点**：
- 完全只读，不支持任何写入操作
- 依赖第三方 `ext4-view` crate（仅支持 ext4 基本读取，不支持 extent tree 之外的高级特性）
- 文件名仅支持 ASCII（非 UTF-8 文件名被跳过）
- 无 ext4 journal 支持
- 大文件性能依赖 crate 内部实现

**实现细节**：
- 打开文件时检查 flags，若含 O_WRONLY/O_RDWR/O_APPEND 则拒绝，返回 None

### 4.10 tmpfs

**优点**：
- 完整 CRUD 实现：create/mkdir/unlink/rmdir/remove_recursive
- BTreeMap 有序存储，目录枚举天然按名排序
- 文件数据使用 `Arc<Mutex<Vec<u8>>>` 支持多引用共享
- rmdir 正确检查目录非空

**缺点**：
- 无文件时间戳 (atime/mtime/ctime) 更新
- 无文件锁
- 无 inode 编号分配策略（全部为 0 或默认值）

**实现细节**：
- `remove_recursive` 递归遍历 BTreeMap，深度优先删除子节点
- 文件写入使用 `write()` 追加到 `Vec<u8>`，支持 O_APPEND

### 4.11 FAT 文件系统

**优点**：
- 完整读写能力，基于修改为 no_std 的 fatfs 库
- BlockIo 适配器正确实现逐扇区 read-modify-write
- FatFile 维护独立的文件偏移，支持 seek 和 append

**缺点**：
- 无目录创建/删除功能
- 无长文件名支持（受 fatfs 库限制）
- 写入性能因每扇区 read-modify-write 受限于块缓存策略

**实现细节**：
- `BlockIo` 实现 `fatfs::Read + Write + Seek` trait，在 `write` 时先读扇区 → 修改 → 写回
- FAT 挂载点为 `/fat`，与 ext4 `/` 隔离

### 4.12 块设备

**优点**：
- 同时支持 VirtIO-MMIO (RISC-V) 和 VirtIO-PCI (LoongArch) 两种传输层
- Virtqueue 实现完整（描述符环/Available 环/Used 环），使用连续物理帧分配
- 块缓存使用 Arc 引用计数实现简单的 LRU-like 淘汰
- 磁盘发现通过扫描 magic 号自动识别文件系统类型

**缺点**：
- I/O 为同步轮询模式（提交请求后 `while` 循环等待 used 环更新），无法利用中断降低 CPU 开销
- 无 NVMe/AHCI/SATA 等其他块设备驱动
- RAM Disk 仅用于静态嵌入镜像，非通用 ramdisk
- 块缓存容量硬编码为 64 块（32KB），无自适应调整
- 同设备并发 I/O 受限于全局块缓存管理器锁

**实现细节**：
- VirtIO-MMIO 同时支持 Legacy（QueuePFN）和 Modern（desc/avail/used 三环）模式
- VirtIO-PCI 通过 PCI 配置空间的能力链表解析各寄存器区域，处理 BAR 地址到内核虚拟地址的转换
- 块缓存淘汰策略：遍历所有缓存块，优先淘汰 `Arc::strong_count == 1` 的块（无外部引用）

### 4.13 PCI 总线

**优点**：
- ECAM 访问正确实现（通过 volatile 指针 + 内核直接映射）
- BAR 解析支持 32/64-bit 和 I/O/Memory 类型
- 总线枚举扫描完整（bus 0 全 32 设备 8 功能）

**缺点**：
- 仅扫描 bus 0，未处理多总线拓扑（PCI-PCI bridge 未处理）
- 无 MSI/MSI-X 中断支持
- 无 PCIe 高级特性（AER/ACS/ASPM 等）
- BAR 分配基于硬编码基地址递增，未查询固件资源分配

**实现细节**：
- `ensure_mem_bar` 仅在 BAR 值为 0（未分配）时写入新基地址，允许固件预分配的值保留
- VirtIO 设备识别基于固定的 vendor/device ID（0x1af4/0x1042/0x1001）

### 4.14 同步原语

**优点**：
- SpinLock 和 Mutex<T> 实现简洁，满足裸机环境需求
- MutexGuard 使用 RAII 模式，正确在 Drop 时释放锁

**缺点**：
- 同步原语种类严重不足：无读写锁、信号量、条件变量、屏障
- 无阻塞锁（即持锁期间不可睡眠的约束未在类型系统层面保证）
- 无死锁检测或预防机制
- 自旋锁在持锁期间禁用中断的场景未显式处理

**实现细节**：
- SpinLock 直接使用 `core::sync::atomic::AtomicBool` CAS 实现
- Mutex<T> 基于 `UnsafeCell` + `AtomicBool`，未使用硬件提供的原子指令优化（如 LR/SC）

### 4.15 定时器

**优点**：
- RISC-V 和 LoongArch 各自实现平台时钟，接口统一（`init` + `tick`）
- RISC-V 使用 SBI 标准时钟接口，兼容性好

**缺点**：
- RISC-V 为 one-shot 模式，每次中断需重新设置，中断延迟有抖动
- 无高精度定时器接口（如 `clock_gettime`）
- 无定时器列表/定时事件管理（仅 tick 计数），不支持 `setitimer/alarm`
- 时间间隔硬编码为 500,000 ticks，无运行时调整

**实现细节**：
- `tick()` 返回布尔值表示是否应触发调度（当前始终返回 true 或基于简单逻辑）
- 全局 `TICK` 计数器单调递增，供 `get_ticks` 系统调用查询

### 4.16 I/O 与日志

**优点**：
- UART 驱动正确处理 NS16550A 状态寄存器（LSR 的 THR 空和 RBR 就绪位）
- 日志系统支持级别过滤和 ANSI 彩色输出
- LoongArch 提供早期引导阶段的物理地址输出宏 (PUTCH_PHYS)

**缺点**：
- UART 为纯轮询模式，输入/输出均阻塞等待，无中断驱动
- 无多控制台/虚拟终端支持
- 无 framebuffer/图形输出

**实现细节**：
- `println!` 宏通过 `CONSOLE_LOCK` 自旋锁确保原子输出
- 陷阱日志 `_trap_log` 在消息前附加 hart ID

---

## 五、OS 内核整体实现完整度

综合评估，RmikuOS 的实现完整度可定位为**中等偏上**。

**已实现的完整功能链路**：
- 启动 → 内存初始化 → 设备发现 → 文件系统挂载 → Shell 交互 → 用户程序执行
- 进程/线程完整生命周期（fork/exec/waitpid/exit + thread_create/join/exit）
- 多文件系统统一挂载访问
- 调度器具备可调参数和用户态控制接口

**完全缺失的核心子系统**：
- 网络协议栈（无 socket 层及以下任何实现）
- 信号机制
- 页面置换/demand paging

**仅具框架的部分**：
- 多核调度（仅主核执行调度，从核 idle）
- 同步原语（仅自旋锁和基本互斥锁）

**量化参考**（以 Linux 0.11 或同等教学内核的功能集为基准的粗估覆盖）：
- 核心进程模型：实现约 80% 的功能点
- 内存管理：实现约 60% 的功能点
- 文件系统：实现约 65% 的功能点
- 设备驱动：实现约 50% 的功能点
- 网络：0%
- 整体功能覆盖：约 55%~65%

---

## 六、动态测试设计与结果

### 6.1 测试设计概述

RmikuOS 的测试体系包含三个层次：

**层次一：内核自测**
- 在 `kernel/src/test/` 中实现（约 1,200 行）
- 在内核初始化阶段顺序执行
- 覆盖：堆分配/释放、帧分配器单帧和连续帧分配/回收、页表 map/unmap、MemorySet 创建和地址翻译

**层次二：用户态功能测试（C 程序）**
- 55 个独立测试程序，置于 `/tests/` 目录
- 覆盖：基础 I/O（hello、cat_stdin、cat_motd、echo_args）
- 覆盖：进程管理（fork_wait、fork_stride_test、getpid_sleep、open_exec、busy）
- 覆盖：线程（thread_test、thread_stride_test、thread_malloc_test）
- 覆盖：调度实验（stride_ticket_test、alpha_sched_test、adaptive_alpha_test、edge_deadline_test、dynamic_load_exp 等约 20 个）
- 覆盖：文件系统（crud_test、open_test、stat_test、fs_stress）
- 覆盖：管道（pipe_test、pipe_stress）
- 覆盖：mmap（mmap_test、mmap_stress、mmap_reuse_test）

**层次三：Rust 用户程序**
- 10 个 Rust 用户程序：rust_hello、rust_fibonacci、rust_estimate_pi、bank_system、editor、library_system 等
- 验证 Rust 用户库和 allocator 在用户态的正确性

### 6.2 构建与交互式运行测试结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| 内核 release 编译（RISC-V） | 通过 | 产生 34MB ELF |
| 55 个 C 测试程序编译 | 通过 | RISC-V 裸机 GCC |
| 5 个 C bin 程序编译 | 通过 | 含 Shell |
| ext4 根文件系统制作 (32MB) | 通过 | 含 /bin、/tests、/etc、/tmp、/fat |
| FAT 镜像制作 (32MB) | 通过 | 预先填充测试数据 |
| QEMU RISC-V 启动至 Shell | 通过 | `qemu-system-riscv64 -machine virt` |
| Shell 内建命令 (ls/exit/cd/pwd) | 通过 | — |
| ext4 文件读取 (cat /etc/motd) | 通过 | — |
| 用户程序执行 (/tests/hello) | 通过 | — |
| 线程测试 (/tests/thread_test) | 通过 | 多线程创建和 join |
| fork/wait 测试 (/tests/fork_wait) | 通过 | 子进程创建和回收 |
| 管道和重定向 (echo foo \| cat) | 通过 | Shell 管道语法 |
| 关机 (shutdown) | 通过 | 调用 SBI shutdown |

### 6.3 测试评价

- 测试覆盖面较广，涵盖操作系统各核心子系统
- 调度器测试尤为突出（20+ 个专门测试程序 + Python 分析脚本）
- 文件系统测试覆盖 CRUD + 压力场景
- 管道测试覆盖基本功能和压力场景
- 测试均为功能验证型，无基准性能测试
- 缺少网络相关测试（因子系统不存在）
- 无可自动化执行的回归测试框架（需手动在 Shell 中逐个执行）

---

## 七、细则评价表格

### 7.1 内存管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。物理帧分配器完整（单帧+连续帧+回收）；内核堆完整（16MB buddy）；RISC-V Sv39 和 LoongArch 四级页表完整；MemorySet 和 ELF 加载器完整；mmap 匿名映射完整。缺失 COW、页面置换、demand paging、共享内存。完整度约 60%。 |
| 关键发现 | 帧分配器的回收链表支持连续帧分配时的搜索，算法正确；内核直接映射区域对 MMIO 使用非执行权限，安全意识好；fork 为全量复制，内存开销 O(地址空间大小)。 |
| 评价 | 内存管理子系统覆盖了操作系统运行所需的基本功能，帧分配器、页表抽象和地址空间管理设计清晰。主要局限在于缺乏 COW（影响 fork 性能）和页面置换（限制可用内存），使其在面对内存压力场景时能力不足。 |

### 7.2 进程管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。fork/exec/waitpid/exit/getpid 完整；进程-线程两级模型正确；FD 表继承和 on_fork 钩子正确；子进程追踪和僵尸回收正确。缺失进程组/session、资源限制、权限管理。完整度约 75%。 |
| 关键发现 | 进程生命周期完整，waitpid 支持 -1 和指定 PID；exec 时正确关闭 fd≥3；fork 继承调度参数（tickets/pass/stride）。 |
| 评价 | 进程管理是 RmikuOS 实现最完整的子系统之一。POSIX 基本进程语义得到遵守，FD 表跨 fork 的引用计数管理通过 File trait 的钩子函数设计较为优雅。 |

### 7.3 文件系统

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。VFS 抽象层（Inode + File trait）、挂载系统、ext4（只读）、tmpfs（完整 CRUD）、FAT（完整读写）、管道（阻塞语义+引用计数）。缺失符号链接、权限检查、inode 缓存、文件锁。完整度约 65%。 |
| 关键发现 | 三种文件系统统一在 VFS 下工作，挂载系统采用最长前缀匹配；tmpfs 支持递归删除目录；管道实现符合 POSIX 阻塞语义和引用计数；ext4 仅可读但能加载真实 ext4 镜像；FAT 的 read-modify-write 适配正确。 |
| 评价 | 文件系统抽象设计合理，多文件系统挂载框架具备良好的扩展性。tmpfs 实现最完整，ext4 和 FAT 有各自的功能局限。整体上文件系统是可用的，但距实用仍有差距（无写入的 ext4 限制了根文件系统的灵活性）。 |

### 7.4 交互设计

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。交互式 Shell + UART 控制台 + 日志系统。Shell 支持内建命令（cd/pwd/ls/exit/shutdown/mkdir/touch/rm/rmdir）、管道、输入/输出重定向、行编辑（退格）、外部命令搜索路径。完整度约 70%。 |
| 关键发现 | Shell 实现管道通过 fork + dup2 + exec 的标准模式；PATH 搜索从 /etc/path 文件读取；输入/输出重定向支持 <、> 和 >>。 |
| 评价 | 交互设计超出典型教学内核水平。Shell 功能较丰富（管道和重定向是亮点），但行编辑仅支持退格，不支持左右移动、上下历史等高级功能。日志系统支持级别过滤和彩色输出，便于调试。 |

### 7.5 同步原语

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 部分实现。SpinLock（CAS 自旋）和 Mutex<T>（泛型自旋锁+RAII 守卫）。缺失读写锁、信号量、条件变量、屏障、RCU。完整度约 25%。 |
| 关键发现 | 同步原语是 RmikuOS 最薄弱的子系统之一。全局仅依赖自旋锁/互斥锁保护共享数据；无阻塞同步原语（信号量/条件变量），导致等待场景依赖 busy-loop 或专门的 block/wake 机制。 |
| 评价 | 当前同步原语足以支撑单核环境下的基本互斥需求，但种类和能力的严重不足使其在复杂并发场景下表达能力受限。信号量和条件变量的缺失直接影响用户态线程同步（如缺乏 futex 等价物）。 |

### 7.6 资源管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。文件描述符表（含分配/回收/继承）；物理帧（分配/回收/泄漏检测）；内核栈（分配/回收+溢出检测）；mmap 区域（first-fit+合并）。缺失全局资源配额、进程级资源限制。完整度约 55%。 |
| 关键发现 | FD 表使用 `free_fds` 向量回收已关闭的 fd 号，提高 fd 号复用效率；内核栈在 Drop 时自动回收连续物理帧；物理帧双重释放检测增强鲁棒性。 |
| 评价 | 资源管理以局部正确性为主，各类资源的分配/回收路径完整。缺乏全局视角的资源监控和限制机制，无法防止单个进程耗尽系统资源。 |

### 7.7 时间管理

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 部分实现。全局 tick 计数器（get_ticks 系统调用）；基于 tick 的 sleep 系统调用；one-shot/周期定时器。缺失 wall-clock 时间、高精度定时器、定时器事件/闹钟、time/times 系统调用。完整度约 30%。 |
| 关键发现 | 定时器仅驱动 tick 计数和调度，时间间隔硬编码；sleep 基于 tick 轮询，精度受限于 tick 间隔（约 50ms）；无 RTC 或时间戳支持。 |
| 评价 | 时间管理是最薄弱的子系统之一。仅满足调度器的基本需求（tick 计数），缺乏与真实时间的关联和用户态可用的时间查询接口。 |

### 7.8 系统信息

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 部分实现。getpid；调度统计查询（get_process_sched_stat/reset_sched_stat）；调度参数查询（tickets/alpha）。缺失 uname、sysinfo、/proc 类伪文件系统、CPU/内存使用率查询。完整度约 25%。 |
| 关键发现 | 系统信息主要通过调度相关系统调用暴露，面向调度实验场景设计。缺乏通用系统信息查询接口。 |
| 评价 | 系统信息模块以服务调度实验为主，与通用操作系统的系统信息需求有较大差距。 |

### 7.9 设备驱动

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。VirtIO-MMIO 块设备（完整）；VirtIO-PCI 块设备（完整）；NS16550A UART（完整）；PCI 总线枚举（基本完整）。缺失 NVMe/AHCI/SATA、网卡驱动、中断控制器驱动（依赖 SBI）、DMA 框架。完整度约 45%。 |
| 关键发现 | VirtIO 驱动支持 MMIO 和 PCI 双传输层是亮点；Split Virtqueue 实现完整；块设备 I/O 为同步轮询模式；无任何网络设备驱动。 |
| 评价 | 设备驱动以支撑基本系统（存储+输入输出）为目标，块设备驱动深度较好（双传输层），但广度不足。网络设备完全缺失导致整个网络栈无法构建。 |

### 7.10 调度器

| 评价维度 | 内容 |
|----------|------|
| 是否实现及完整度 | 已实现。进程-线程两级 Stride 调度；自适应 alpha 调度（连续参数+定点数幂算法）；用户态调度参数查询/设置；调度统计。缺失多核负载均衡、实时调度、组调度。完整度约 75%。 |
| 关键发现 | 自适应 alpha 调度器是项目核心创新：用纯整数定点数算法实现 n^(alpha/100)，alpha 连续可调，用户态可控；配套 20+ 测试程序和数据分析脚本形成实验框架；alpha 缓存机制保证高频查询效率。 |
| 评价 | 调度器是 RmikuOS 实现深度最高、创新性最强的子系统。相比同类教学内核通常实现的简单 Round-Robin 或固定 Stride，自适应 alpha 提供了连续可调的调度策略空间，具有教学和实验价值。局限在于单核和全局 alpha 参数。 |

---

## 八、总结评价

RmikuOS 是一个从零实现的 Rust 语言教学/实验型操作系统内核，支持 RISC-V 64 和 LoongArch 64 双架构，代码总量约 30,000 行。

**核心优势**：
1. **双架构支持**：共用大部分核心代码，通过条件编译和平台抽象层实现 RISC-V 和 LoongArch 的并行支持，架构设计清晰。
2. **创新的调度器**：自适应 alpha 调度器是项目的核心亮点，实现了连续可调的调度策略空间，纯整数定点数幂算法具备良好的可移植性，配套的用户态测试和数据分析脚本使其具备教学实验平台的潜力。
3. **较完整的进程模型**：进程-线程两级模型实现扎实，fork/exec/waitpid 和 thread_create/join/exit 语义正确，FD 表继承和管道引用计数管理通过 trait 钩子函数实现，设计优雅。
4. **实用的文件系统支持**：VFS + 三种文件系统（ext4/tmpfs/FAT）统一挂载，可加载真实 ext4 根文件系统启动交互式 Shell，Shell 支持管道和重定向。
5. **深入的块设备驱动**：同时支持 VirtIO-MMIO 和 VirtIO-PCI 两种传输层，Virtqueue 实现完整。
6. **丰富的测试体系**：55 个 C 测试 + 10 个 Rust 用户程序 + 内核自测，调度器测试尤为详实。

**主要短板**：
1. **网络栈完全缺失**：无 socket 接口及以下任何网络协议栈实现，是最大功能缺口。
2. **内存管理缺乏关键优化**：无 COW（fork 全量复制）、无页面置换、无 demand paging。
3. **同步原语严重不足**：仅 SpinLock 和基础 Mutex，缺乏信号量、条件变量、读写锁等。
4. **多核调度未完成**：从核初始化后仅 idle 循环，实质为单核系统。
5. **ext4 只读**：根文件系统只读限制了运行时的灵活性。
6. **无信号机制**：缺少进程间异步通知能力。

**总体评价**：RmikuOS 在设计清晰度、调度器深度和双架构支持方面表现突出，体现了开发者对操作系统核心机制的扎实理解。项目在进程管理、文件系统和块设备驱动方面达到了较好的完成度，但在内存管理优化、同步原语和网络方面存在显著不足。整体为一个有明确创新点、实现质量中等偏上的教学/实验型内核项目。