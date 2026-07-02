# Sustcore OS 内核技术分析报告

## 一、分析方法与过程

本次分析采用以下方法对 Sustcore 项目进行全面调查：

1. **静态源码审查**：逐文件阅读内核核心子系统的头文件和实现文件，覆盖约 513 个源码文件中的关键路径。
2. **结构分析**：通过 `find`、`wc`、`cat` 等工具建立项目的物理结构和逻辑组织视图。
3. **接口追踪**：从 syscall 入口向下追踪调用链，理解各子系统的交互方式。
4. **概念建模**：从能力系统（Capability）、内存管理、任务调度、VFS 等维度建立概念模型。
5. **跨架构对比**：比较 RISC-V64 和 LoongArch64 两套架构实现的异同。

**未进行构建与运行测试**：原因在于该项目的构建系统要求 GCC 15+ 版本（`flags.mk`：`GCC_VERSION_MAJOR >= 15`），而当前分析环境不提供 GCC 15 交叉编译器。`LoongArch_cross_toolchain` 和 `RISC-V_cross_toolchain` 的具体 GCC 版本未满足此要求。然而，静态源码审查已足够覆盖代码结构、接口定义和实现逻辑的完整分析。

---

## 二、项目总体评估

### 2.1 项目规模

| 指标 | 数值 |
|---|---|
| 总源码文件数 | ~513（182 `.cpp`、21 `.c`、268 `.h`、42 `.S`） |
| 总代码行数 | ~114,009 行 |
| 支持架构 | RISC-V64 (Sv39)、LoongArch64 |
| 编程语言 | C++（GNU++23）、C（GNU18）、汇编 |
| 内核类型 | Capability-based 混合内核（Hybrid Kernel） |

### 2.2 总体实现完整度评估

基于对所有子系统的源码审查，以"可运行多用户进程的操作系统内核"为基准，Sustcore 的总体实现完整度约为 **75-80%**。以下是各子系统的具体分析。

---

## 三、子系统详细拆解

### 3.1 能力系统（Capability System）— `kernel/cap/`

#### 3.1.1 架构设计

Sustcore 采用**两级索引的能力空间（CSpace）** 设计：

- **CSpace**：每个 CHolder（能力持有者）拥有一个 CSpace，包含 4096 个 CGroup。
- **CGroup**：每个 CGroup 包含 256 个 Capability 槽位。
- **总容量**：每个进程最多持有 1,048,576 个 Capability。

CapIdx 是 64 位值，编码格式：

```
| 保留位 (48位) | Valid标志 (1位) | CGroup索引 (12位) | Slot索引 (8位) |
```

代码位置：`include/sustcore/capability.h`:

```cpp
constexpr b64 MASK_VALID  = 0x1000000000000000;
constexpr b64 MASK_SLOT   = 0x00000000000000FF;
constexpr b64 MASK_GROUP  = 0x00000000000FFF00;
constexpr size_t CSPACE_SIZE  = 1ULL << CALC_MASK_WIDTH<MASK_GROUP>(); // 4096
constexpr size_t CGROUP_SLOTS = 1ULL << CALC_MASK_WIDTH<MASK_SLOT>();  // 256
```

#### 3.1.2 Payload 类型

定义了 15 种 Payload 类型（`include/sustcore/capability.h`）：

| PayloadType | 说明 |
|---|---|
| INTOBJ | 中断对象 |
| SINTOBJ | 软件中断对象 |
| VFILE | 虚拟文件 |
| VDIR | 虚拟目录 |
| NOTIF | 通知对象 |
| MUTEX | 互斥锁 |
| PCB | 进程控制块 |
| TCB | 线程控制块 |
| ENDPOINT | IPC 端点 |
| MEMORY | 内存区域 |
| REPLY | 一次性调用回复 |
| VMOUNT | 虚拟挂载点 |
| PIPE_READ_END | 管道读端 |
| PIPE_WRITE_END | 管道写端 |

#### 3.1.3 权限模型

权限使用 64 位位图（`kernel/object/perm.h`）：

- **基础权限位**（低 16 位）：CLONE、MIGRATE、MIGRATE_ONCE、READ、WRITE、EXECUTE、MAP、QUERY 等。
- **派生权限位**（高 48 位）：各 Payload 类型特定的权限。

权限检查通过 `perm::imply()` 实现：

```cpp
constexpr bool imply(b64 owned, b64 required) noexcept {
    return BITS_IMPLIES(owned, required);
}
```

#### 3.1.4 CHolder 操作

CHolder 提供完整的能力管理接口（`kernel/cap/cholder.h`）：

- `insert(idx, payload, perm)` — 插入能力
- `lookup(idx)` — 查找能力
- `remove(idx)` — 移除能力
- `clone(src_idx)` — 克隆能力（校验 CLONE 权限；对 Memory 触发 COW）
- `derive(src_idx, new_perm)` — 派生（克隆后降级权限）
- `downgrade(idx, new_perm)` — 降级权限
- `transfer_to(dst, src_idx)` — 传递能力（MIGRATE/MIGRATE_ONCE/CLONE 三种模式）
- `copy_all_to(dst)` — 批量复制所有能力

**能力传递逻辑**（`kernel/cap/cholder.cpp` `transfer_to()`）：

- 若持有 CLONE 权限：复制能力到目标，源槽位保留。
- 若持有 MIGRATE 或 MIGRATE_ONCE：在目标插入成功后消费源槽位。目标能力清除 MIGRATE_ONCE 位。

#### 3.1.5 Payload 生命周期管理

Payload 使用引用计数管理（`kernel/cap/capability.h` `Payload`）：

```cpp
void keep() { _refcount++; }
void release() {
    _refcount--;
    if (_refcount == 0) { destruct(); }
}
```

Capability 构造时调用 `keep()`，析构时调用 `release()`。

#### 3.1.6 CHolderManager（全局能力持有者管理）

通过单例模式管理所有 CHolder（`kernel/cap/cholder.cpp`）：

```cpp
static cap::CHolderManager inst_cholder_manager;
```

提供 `create_holder()`、`get_holder()`、`remove_holder()` 等接口。使用 `std::unordered_map` 存储所有 Holder。

#### 3.1.7 实现完整度：**90%**

能力系统是 Sustcore 的核心设计亮点，实现了完整的：
- 两级索引 CSpace
- 引用计数 Payload 生命周期
- 细粒度权限模型
- CLONE/MIGRATE/MIGRATE_ONCE 传递语义
- 与 COW 内存管理的深度集成

---

### 3.2 任务管理（Task Management）— `kernel/task/`

#### 3.2.1 进程与线程模型

采用 **1:1 进程-线程模型**：PCB（进程控制块）和 TCB（线程控制块）分离。

**PCB 结构**（`kernel/task/task_struct.h`）：

```cpp
struct PCB : public util::tree_base::TreeBase<PCB> {
    pid_t pid;
    bool is_kernel;
    int exit_code;
    std::atomic<bool> exiting;
    std::atomic<bool> recycle_queued;
    util::IntrusiveList<TCB, &TCB::list_head> threads;
    util::owner<TaskMemoryManager *> tmm;     // 内存管理器
    cap::CHolder *cholder;                     // 能力空间
    VirAddr entrypoint;
    VirAddr linuxproc_entrypoint;
    VirAddr linux_subsystem_entry;
    bool is_linux_process;
    ProcState *proc_state;
    SignalState signal_state;
    CapIdx pcb_cap;
    CapIdx main_tcb_cap;
};
```

PCB 采用树形结构（继承 `TreeBase<PCB>`），支持进程父子关系。

**TCB 结构**：

```cpp
struct TCB {
    tid_t tid;
    PCB *task;
    bool is_kernel;
    KThreadEntry kentry;
    void *karg;
    constexpr static size_t KSTACK_PAGES = 96;  // 384KB 内核栈
    void *kstack_bottom;
    char *ksp;
    PhyAddr kstack_phy;
    Context kernel_ctx;
    util::owner<ExtContext *> ext_ctx;
    // 调度数据
    BootThreadRole boot_role;
    schd::ClassType schd_class;
    schd::SchedMeta basic_entity;
    schd::rr::Entity rr_entity;
    // 等待数据
    wait::wd_t wait_wd;
    wait::WaitPredicate wait_predicate;
    bool timeout;
    bool signal_interrupted;
    // Syscall 状态
    SyscallInfo syscall_info;
};
```

#### 3.2.2 线程状态

TCB 支持 8 种状态（`kernel/schd/schdbase.h`）：

```
EMPTY -> INITIALIZATION -> READY -> RUNNING -> YIELD
                                               -> INTERRUPTIBLE_WAITING
                                               -> UNINTERRUPTIBLE_WAITING
                                               -> DYING
```

#### 3.2.3 信号机制

实现了类 Linux 的信号系统（`kernel/task/signal.cpp`）：

- 支持 64 个信号（`MAX_SIGNALS = 64`）
- 信号掩码（pending_mask、blocked_mask）
- SigAction 结构（handler、mask、flags、restorer）
- 支持 SIGKILL、SIGUSR1、SIGSEGV、SIGUSR2、SIGTERM、SIGCHLD
- 默认信号处理（忽略 SIGCHLD，终止 SIGTERM/SIGKILL/SIGSEGV）
- 信号帧在用户栈上的布局（RISC-V64 和 LoongArch64 各自实现）
- Linux ABI 兼容的信号返回机制

#### 3.2.4 等待/同步机制

实现了完整的等待子系统（`kernel/task/wait.cpp`、`kernel/task/wait.h`）：

- `WaitReasonManager`：全局等待原因管理器
- `WaitContext`：等待上下文，支持信号中断
- `Promise/Future` 异步模型：用于 Endpoint 收发、Notification 等
- 超时等待：`nanosleep`、`timed_wait`
- 等待谓词（WaitPredicate）：由等待线程设置，由唤醒方检查

#### 3.2.5 实现完整度：**85%**

- 进程/线程生命周期管理完整
- 信号机制支持多个标准信号
- 等待/同步机制设计完善
- 缺少：进程组、会话、作业控制；线程 join 等

---

### 3.3 调度器（Scheduler）— `kernel/schd/`

#### 3.3.1 多级调度类

实现了 5 个调度类（优先级从高到低）：

| 调度类 | 优先级 | 说明 |
|---|---|---|
| RT | 5 | 实时 FIFO |
| INIT | 4 | 初始化专用 |
| RR | 3 | 轮转调度（时间片=5 ticks） |
| FCFS | 2 | 先来先服务 |
| IDLE | 1 | 空闲调度（永远可运行） |

每个调度类继承 `BaseSched<SU>` 模板基类（`kernel/schd/schdbase.h`），实现：
- `enqueue()` — 入队
- `dequeue()` — 出队
- `pick_next()` — 选择下一个运行单元
- `put_prev()` — 放回当前运行单元
- `yield()` — 主动放弃 CPU
- `on_tick()` — 时钟滴答处理
- `check_preempt_curr()` — 抢占检查

#### 3.3.2 核心调度逻辑

`Scheduler::schedule()`（`kernel/task/scheduler.cpp`）：

1. 关中断保护
2. 获取当前 TCB
3. 检查 NEED_RESCHED 标志和抢占禁用状态
4. 调用 `prepare_prev_task()` 处理当前任务
5. 调用 `prepare_next_task()` 选择下一个任务
6. 执行上下文切换 `switch_to()`

#### 3.3.3 上下文切换

`switch_to()` 流程：

```cpp
void Scheduler::switch_to(TCB *prev, TCB *next) {
    if (prev->ext_ctx_live) save_ext_context(*prev->ext_ctx);
    prepare_switch(next);
    if (!next->ext_ctx_live) {
        restore_ext_context(*next->ext_ctx);
        next->ext_ctx_live = true;
    }
    __switch_to(prev->kernel_context_ptr(), next->kernel_context_ptr());
    // 返回后恢复扩展上下文
    restore_ext_context(*current->ext_ctx);
}
```

`prepare_switch()` 调用 `switch_pgd()` 切换地址空间，更新 `env::hart_ctx`。

#### 3.3.4 抢占控制

- `FLAGS_PREEMPT_DISABLED`：临时禁用抢占
- `FLAGS_NEED_RESCHED`：标记需要重新调度
- `check_preempt_curr()`：仅当新任务的调度类优先级**严格高于**当前任务时才触发抢占

#### 3.3.5 实现完整度：**85%**

- 多级调度类设计清晰
- RR 时间片机制有效
- 完整的入队/出队/抢占逻辑
- 缺少：负载均衡（多核）、调度统计、CGroup 调度、优先级继承等

---

### 3.4 内存管理（Memory Management）— `kernel/mem/`

#### 3.4.1 Buddy 分配器

实现了一个完整的 Buddy 页框分配器（`kernel/mem/buddy.h`、`buddy.cpp`）：

- 最大 order：15（对应 128MB 连续页）
- FreeBlock 池预分配 512 个块，运行时动态扩展
- 双向链表管理空闲块
- 支持 `get_free_page(page_count)`、`put_page(paddr, page_count)`
- 支持按 order 分配/释放

关键数据结构：

```cpp
struct FreeBlock {
    PhyAddr paddr;
    size_t order;
    FreeBlock *prev;
    FreeBlock *next;
};
static constexpr int MAX_BUDDY_ORDER = 15;
```

实现了完整的伙伴合并（`find_buddy_node`）和分裂逻辑。

#### 3.4.2 SLUB 分配器

实现了一个模板化的 SLUB 分配器（`kernel/mem/slub.h`）：

- 小对象（< 2048 字节）：每 Slab 一页，freelist 管理空闲对象
- 大对象（>= 2048 字节）：直接通过 GFP 分配整页
- 三种 Slab 状态：EMPTY、PARTIAL、FULL
- 使用侵入式链表（IntrusiveList）管理 Slab
- 统计信息：total_slabs、objects_inuse、objects_total、memory_usage_bytes

```cpp
template <typename ObjType>
class Slub {
    util::IntrusiveList<SlabHeader> partial{};
    util::IntrusiveList<SlabHeader> full{};
    util::IntrusiveList<SlabHeader> empty{};
    size_t inuse_objects_ = 0;
};
```

#### 3.4.3 GFP（Get Free Page）

带引用计数的页框分配器（`kernel/mem/gfp.h`）：

- 底层委托给 BuddyAllocator
- 维护全局引用计数数组（最大追踪 4GB 内存）
- `get_free_page()` 分配并初始化引用计数为 1
- `put_page()` 降低引用计数，归零时归还 Buddy
- `keep_page()` 增加引用计数（用于 COW 共享）
- `ref_count()` 查询引用计数

#### 3.4.4 VMA（虚拟内存区域）

完整的 VMA 管理系统（`kernel/mem/vma.h`）：

- VMA 类型：CODE、DATA、STACK、HEAP、SHARE
- 增长方式：FIXED、GROW_UP、GROW_DOWN、SHRINK_UP、SHRINK_DOWN
- 每个 VMA 关联一个 Memory Capability
- VMA 权限：PROT_R、PROT_W、PROT_X、PROT_SHARE
- TaskMemoryManager 管理进程的所有 VMA

关键操作：

```cpp
Result<util::nonnull<VMA *>> add_vma(...);     // 创建 VMA
Result<util::nonnull<VMA *>> locate(vaddr);     // 地址定位
Result<void> remove_vma(vma);                   // 移除 VMA
Result<VirArea> grow_vma(vma, varea);           // 增长 VMA
Result<void> protect_memory_cow(memory);        // COW 保护
Result<bool> on_np(vaddr);                      // 缺页处理
Result<bool> on_wp(vaddr);                      // 写保护处理
```

#### 3.4.5 Memory Payload

面向能力系统的内存抽象（`kernel/object/memory.h`、`memory.cpp`）：

```cpp
struct MemoryPayload : public _PayloadHelper<PayloadType::MEMORY> {
    size_t memsz;                    // 承诺大小
    bool shared;                     // 是否共享
    bool continuity;                 // 是否要求物理连续
    MemoryGrowth growth;             // 增长方式
    util::owner<Capability *> file;  // 后端文件（文件映射内存）
    size_t file_offset;
    size_t file_backed_len;
    std::unordered_map<size_t, PhyPage> phy_pages;  // 已分配物理页
};
```

实现了：
- 懒分配：`ensure_page()` 按需分配物理页
- COW：`fork()` 拆分共享页，`clone_payload()` 创建 COW 共享
- 文件后端：`file_backed()` 按需从文件读取页内容
- 读写：`read()`/`write()` 支持跨页操作和 COW 语义
- 调整大小：`resize()` 支持连续/非连续模式
- 同步：`sync()` 将脏页写回文件后端

#### 3.4.6 页表管理

**RISC-V64（Sv39）**：`kernel/arch/riscv64/mem/sv39.h`
- 三级页表（L0/L1/L2）
- 支持 4K/2M/1G 大页
- PTE 位：V（有效）、RWX（权限）、U（用户）、G（全局）、A（访问）、D（脏）
- `query_page()` 遍历页表返回 PTE 指针和页面大小
- `map_page()`/`unmap_page()` 单页操作
- `map_range()`/`unmap_range()` 范围操作
- `modify_pte()`/`modify_flags()` 修改 PTE 标志

**LoongArch64**：`kernel/arch/loongarch64/mem/pageman.h`
- 类似的多级页表管理
- 使用 LA64 特有 CSR 和 TLB 刷新指令

#### 3.4.7 实现完整度：**90%**

内存管理是 Sustcore 最完善的子系统之一：
- Buddy + SLUB + GFP 三层分配器链路完整
- VMA 管理支持多种类型和增长方式
- Memory Payload 与能力系统深度集成
- COW 实现完整（clone、fork、缺页处理、写保护处理）
- 文件后端内存映射（file-backed memory）
- Sv39 和 LA64 双架构页表实现

---

### 3.5 虚拟文件系统（VFS）— `kernel/vfs/`

#### 3.5.1 VFS 核心架构

VFS 是 Sustcore 最庞大、最复杂的子系统（vfs.cpp 约 2724 行，ext4.cpp 约 3305 行）。

核心接口层次（`kernel/vfs/ops.h`）：

```
IFsDriver（文件系统驱动）
  └── ISuperblock（超级块）
        └── IINode（索引节点）
              ├── IFile（文件）
              ├── IDirectory（目录）
              └── ISymlink（符号链接）
```

**IFile 接口**（文件操作）：

```cpp
class IFile : public IINode {
    virtual Result<size_t> read(off_t offset, void *buf, size_t len) = 0;
    virtual Result<size_t> write(off_t offset, const void *buf, size_t len) = 0;
    virtual Result<size_t> size() = 0;
    virtual Result<void> sync() = 0;
    virtual Result<void> truncate(size_t new_size) = 0;
    virtual Result<void> ioctl(size_t cmd, syscall::UBuffer &&arg) = 0;
    virtual FileCachePolicy file_cache() const;
};
```

**IDirectory 接口**（目录操作）：

```cpp
class IDirectory : public IINode {
    virtual Result<inode_t> lookup(std::string_view name) = 0;
    virtual Result<inode_t> mkfile(std::string_view name, const char *options) = 0;
    virtual Result<inode_t> mkdir(std::string_view name, const char *options) = 0;
    virtual Result<size_t> entry_count() = 0;
    virtual Result<DirectoryEntryInfo> entry_at(size_t index) = 0;
    virtual Result<void> unlink(std::string_view name) = 0;
    virtual Result<void> rmdir(std::string_view name) = 0;
    virtual Result<void> link(std::string_view name, inode_t target) = 0;
    virtual Result<void> rename(...) = 0;
    virtual Result<inode_t> symlink(...) = 0;
    virtual Result<void> sync() = 0;
};
```

#### 3.5.2 VFS 核心类

- **VFS**：全局 VFS 单例，提供路径解析、文件操作路由
- **VFsDriver**：文件系统驱动包装器（引用计数）
- **VSuperblock**：超级块包装器，包含 inode 缓存
- **VINode**：inode 包装器，支持页缓存（CachedFilePage）
- **VFile**：文件包装器（持有 VINode 引用）
- **VDirectory**：目录包装器
- **VMount**：挂载点管理

#### 3.5.3 页缓存（Page Cache）

实现了完整的类 Linux 页缓存机制（`kernel/vfs/vfs.cpp`）：

- 双链表 LRU 淘汰：`inactive_list` + `active_list`
- RCU 风格的读保护：`PageCacheReadGuard`
- 缓存统计：hits、misses、invalidations、writebacks、evictions
- 脏页回写
- 文件页与 Memory Payload 的集成
- 最大缓存页数：1024 页（4MB）

```cpp
constexpr size_t kMaxPageCachePages = 1024;
static VINode::CachedFilePage *inactive_head = nullptr;
static VINode::CachedFilePage *inactive_tail = nullptr;
static VINode::CachedFilePage *active_head   = nullptr;
static VINode::CachedFilePage *active_tail   = nullptr;
```

#### 3.5.4 已实现的文件系统

**ext4**（`kernel/vfs/ext4.cpp`、`ext4.h`，约 3305 行）：
- 完整的 ext4 超级块解析和校验
- Extent 树遍历（支持最大深度 5）
- 目录项解析（线性目录，含 file_type）
- 文件/目录的创建、删除、读写
- 符号链接支持
- inode 分配与释放
- 支持的特性：FILETYPE、EXTENTS、64BIT、FLEX_BG、SPARSE_SUPER、LARGE_FILE 等
- 块 IO 基于 BufferCache 层

**tmpfs**（`kernel/vfs/tmpfs.h`）：
- 纯内存文件系统
- 节点的内存存储（TmpFSNode）
- 完整的文件/目录操作
- 符号链接支持

**procfs**（`kernel/vfs/procfs.h`）：
- 进程信息伪文件系统
- `/proc/meminfo`：内存统计
- `/proc/mounts`：挂载信息
- `/proc/<pid>/`：进程目录
- `/proc/self/`：自引用符号链接
- 支持 cmdline、environ、exe、cwd、root 链接

**tarfs**（`kernel/vfs/tarfs.h`）：
- 基于 tar 归档的只读文件系统
- 用于 initramfs
- 支持 ustar 格式
- 目录树自动构建

**devfs**（`kernel/vfs/device.h`）：
- 设备文件系统（`/sys/dev/`）
- 块设备节点和字符设备节点
- 字符设备工厂注册机制

#### 3.5.5 路径解析

VFS 实现了完整的路径解析（`kernel/vfs/vfs.cpp`）：

- 相对路径 vs 绝对路径
- 符号链接跟随（`O_NOFOLLOW` 选项）
- 挂载点遍历
- `"."` 和 `".."` 处理
- 路径合法性校验

#### 3.5.6 实现完整度：**80%**

VFS 是最为重量级的子系统：
- ext4 实现非常详细（3305 行），涵盖主要文件操作
- 5 种文件系统类型
- 页缓存机制完整
- 路径解析健壮
- 缺少：ext4 日志（journal）支持、更多 ext4 特性（extent 深度>1 的完整实现需要验证）、VFS 层的 inode 缓存回收策略细化

---

### 3.6 系统调用（Syscall）— `kernel/syscall/`

#### 3.6.1 系统调用号定义

约 80 个系统调用（`include/sustcore/syscall.h`），分为：

**稳定接口**（`SYSCALL_BASE = 0xFFFF0000`）：

| 类别 | 系统调用 | 数量 |
|---|---|---|
| 任务管理 | PCB_KILL, TCB_KILL, PCB_FORK, PCB_GETPID, PCB_CREATE_THREAD, TCB_YIELD, PCB_EXECVE, TCB_WAIT, TCB_GET_TID, PCB_MAP, PCB_UNMAP, PCB_QUERY_VADDR, PCB_QUERY_VSPACE | 13 |
| 通知 | NOTIF_CREATE, NOTIF_SIGNAL, NOTIF_UNSIGNAL, NOTIF_CHECK, NOTIF_WAIT | 5 |
| 能力 | CAP_CLONE, CAP_DOWNGRADE, CAP_DERIVE, CAP_LOOKUP, CAP_REMOVE | 5 |
| IPC | ENDPOINT_CREATE, ENDPOINT_SEND, ENDPOINT_RECV, ENDPOINT_SEND_ASYNC, ENDPOINT_RECV_ASYNC, ENDPOINT_CALL, ENDPOINT_REPLY | 7 |
| 内存 | MEM_CREATE, MEM_UNMAP, MEM_RESIZE, MEM_QUERY, MEM_SYNC | 5 |
| VFS | OPEN, OPENDIR, READ, WRITE, SIZE, SYNC, MKFILE, MKDIR, GETDENTS, UNLINK, RMDIR, TRUNCATE, RENAME, SYMLINK, LINK, STAT, LSTAT, READLINK, FSTAT, GETATTR, GETATTR_AT, SETATTR, SETATTR_AT, CHOWN, CHOWN_AT, IOCTL, FCHOWNAT | 27 |
| 挂载 | MNT_CREATE, MNT_MOUNT, MNT_UMOUNT, MNT_ROOT, MNT_STATE | 5 |
| procfs | PCB_PROCFS_GET, PCB_PROCFS_REDIRECT | 2 |
| 管道 | PIPE_CREATE, PIPE_READ, PIPE_WRITE | 3 |
| 信号 | PCB_SIGACTION, PCB_SIGNAL, PCB_WAITSIG, PCB_SIGMASK | 4 |
| 时间 | TCB_TIMEOUT_WAIT | 1 |
| 统计 | VFS_STATFS | 1 |

**不稳定接口**（`SYS_UNSTABLE_BASE = 0xFFC00000`）：
- WRITE_SERIAL, CREATE_PROCESS, CREATE_POSIX_PROCESS, SHUTDOWN
- VFS_PAGE_CACHE_STATS, TIME_NOW_NS, TCB_NANOSLEEP
- PCB_EXECVE_POSIX, GETRTCTIME_NS, BLOCK_FOREVER

#### 3.6.2 系统调用分发

```cpp
RetPack dispatch_sync(util::nonnull<task::TCB *> tcb,
                      util::nonnull<Context *> trap_context,
                      const ArgPack &args);
```

分发逻辑根据系统调用号路由到具体处理函数。每个处理函数：
1. 从 CHolder 查找 Capability
2. 构造对应的 Object（如 MemoryObject、EndpointObject）
3. 权限检查
4. 执行操作

#### 3.6.3 用户态访问（UAccess）

`kernel/syscall/uaccess.h` 提供安全的用户态内存访问：

- `UBuffer`：带缓冲的用户态缓冲区，支持 `sync_from_user()` / `commit_to_user()`
- `UString`：用户态字符串
- 边界检查防止内核越权访问

#### 3.6.4 实现完整度：**80%**

- 系统调用覆盖了主要操作系统功能
- 权限检查与能力系统集成良好
- UAccess 安全机制到位
- 缺少：更多 POSIX 兼容调用（如 poll/select、mmap/munmap 相关变体）

---

### 3.7 对象系统（Object）— `kernel/object/`

实现了 Capability 系统所需的各种对象类型：

| 对象 | 文件 | 说明 |
|---|---|---|
| Endpoint | endpoint.h/cpp | IPC 端点，支持同步/异步 send/recv/call/reply |
| Memory | memory.h/cpp | 内存区域，支持懒分配、COW、文件后端、resize |
| Notification | notif.h/cpp | 通知对象，24 位信号位图，支持 signal/wait |
| Pipe | pipe.h/cpp | 匿名管道，环形缓冲区，容量 4096 字节 |
| Task | task.h/cpp | PCB/TCB payload |
| Mutex | mutex.h/cpp | 互斥锁 |
| VFile | vfile.h/cpp | 虚拟文件能力 |
| VDir | vdir.h/cpp | 虚拟目录能力 |
| VMount | vmount.h/cpp | 虚拟挂载点能力 |
| IntObj | intobj.h/cpp | 中断对象 |
| Perm | perm.h | 权限定义（各 Payload 类型的权限位） |

#### 3.7.1 Endpoint（IPC 端点）

```cpp
struct EndpointPayload : public _PayloadHelper<PayloadType::ENDPOINT> {
    util::IntrusiveList<EndpointMessage> messages;
    util::IntrusiveList<PendingEndpointSend> pending_sends;
    util::IntrusiveList<PendingEndpointRecv> pending_recvs;
};
```

- 消息队列 + 发送/接收等待队列
- 支持同步和异步模式
- `endpoint_call` + `endpoint_reply` 实现 RPC 模式（ReplyPayload）

#### 3.7.2 Notification

```cpp
struct NotificationPayload : public _PayloadHelper<PayloadType::NOTIF> {
    std::atomic<b32> signalbits = 0;      // 24 位信号
    std::vector<wait::Promise<bool>> waiters[24];
    SpinLocker spinlock;
};
```

- 24 个独立信号位
- 每信号位独立的等待队列
- 原子操作保证信号状态一致性

#### 3.7.3 Pipe

```cpp
struct PipePayload : public util::refc<PipePayload> {
    util::RingBuffer<byte> buffer;   // 环形缓冲区
    size_t capacity;                  // 默认 4096
    size_t read_ends;
    size_t write_ends;
    SpinLocker lock;
    wait::wd_t readable_wd;
    wait::wd_t writable_wd;
};
```

- 经典的读写端分离设计
- PipeReadEndPayload/PipeWriteEndPayload 各自独立的能力
- 支持阻塞/非阻塞模式

#### 3.7.4 实现完整度：**85%**

- Endpoint 的 IPC 模型设计完善
- Notification 的 signal/wait 机制可用
- Pipe 实现经典
- 中断对象将硬件中断暴露为 Capability

---

### 3.8 ELF 加载器（Executable Loader）— `kernel/exe/`

实现了一个 ELF64 加载器（`kernel/exe/elfloader.cpp`、`elfloader.h`）：

- 支持 ET_EXEC 和 ET_DYN（PIE）两种 ELF 类型
- 架构识别：EM_RISCV（RISC-V）和 EM_LOONGARCH（LoongArch）
- PT_LOAD 段解析：将 ELF 段映射为 Memory-backed VMA
- 段权限映射：PF_R/PF_W/PF_X -> VMA::PROT_R/VMA::PROT_W/VMA::PROT_X
- PT_INTERP 解释器支持
- PT_PHDR 和 PT_TLS 段识别
- 懒加载：不立即分配物理页，依赖缺页异常
- 堆创建：为进程创建 heap VMA
- 栈创建：为用户进程分配栈空间
- 入口点计算
- 地址空间随机化（ASLR）：通过 `GENERIC_PROCESS_BASE` 等常量定义加载基址

#### 实现完整度：**75%**

- 基本的 ELF 加载功能完整
- 支持动态链接器（INTERP）
- 缺少：动态链接（ld.so 的完整运行时支持）、TLS 的完整实现

---

### 3.9 块 IO 层（Block IO）— `kernel/bio/`

#### 3.9.1 架构

- **IBlockDeviceOps**：块设备操作接口
- **BlockRequestQueue**：请求队列
- **BlockRequestLayer**：请求层
- **BufferCache**：缓冲区缓存，按块大小管理
- **BlkManager**：全局块设备管理器

#### 3.9.2 BlkManager

```cpp
class BlkManager {
    std::unordered_map<size_t, RegisteredBlockDevice> _devices;
    // 每个设备：IBlockDeviceOps + BufferCache + BlockRequestQueue + worker TCB
};
```

- 设备注册时创建独立的 BufferCache 和请求队列
- 为每个块设备启动内核工作线程（RR 调度类）
- `register_device()/unregister_device()`

#### 3.9.3 BufferCache

缓冲区缓存（`kernel/bio/buffer.h`）：
- 按块大小索引的缓存管理
- 缓冲区状态：CLEAN、DIRTY、LOCKED
- 支持 read/write/sync 操作
- 通过 BlockRequestLayer 与底层设备通信

#### 3.9.4 实现完整度：**70%**

- 基本的块 IO 路径完整
- BufferCache 实现了缓冲区管理
- 缺少：IO 调度器、合并写入、预读、更复杂的缓存淘汰策略

---

### 3.10 驱动层（Driver）— `kernel/driver/`

#### 3.10.1 VirtIO 驱动

实现了完整的 VirtIO MMIO 驱动框架（`kernel/driver/virtio/virtio.h`、`virtio.cpp`）：

- MMIO 寄存器布局定义（256 字节公共配置空间）
- 设备探测：Magic Value、Version、Device ID 校验
- 特性协商：设备特性与驱动特性的交集
- Virtqueue 管理：Descriptor Table、Available Ring、Used Ring
- DMA 缓冲区管理
- 中断处理
- VirtIO PCI 传输支持
- virtio-blk 块设备驱动

**VirtIO 状态机**：ACKNOWLEDGE -> DRIVER -> FEATURES_OK -> DRIVER_OK

#### 3.10.2 其他驱动

- **串口驱动**（`kernel/driver/serial.cpp`）：Early serial 和运行时串口
- **时钟驱动**（`kernel/driver/clock.cpp`）：时钟源抽象
- **PCI Host**（`kernel/driver/pci_host.cpp`）：PCI 总线枚举
- **中断控制器**（`kernel/driver/int/`）：PLIC、CLINT、RISC-V INTC 头文件
- **RTC 驱动**（`kernel/driver/rtc/`）：Goldfish RTC、LS7A RTC
- **电源管理**（`kernel/driver/syscon-poweroff.cpp`）：系统关机

#### 3.10.3 实现完整度：**65%**

- VirtIO 框架相对完整
- 驱动数量有限
- 缺少：网络驱动、图形驱动、USB 驱动等

---

### 3.11 架构层（Architecture）— `kernel/arch/`

#### 3.11.1 RISC-V64

- **异常处理**（`kernel/arch/riscv64/int/exception.cpp`）：
  - 19 种异常类型的完整处理
  - 页异常分类：缺页、写保护、执行保护、访问错误、A/D 位错误
  - 通过 `TaskMemoryManager::on_np()` / `on_wp()` 处理缺页和 COW
  - ECALL 处理分发到 syscall 层
  - 非法指令检测与报告

- **中断处理**（`kernel/arch/riscv64/int/trap.S`，231 行汇编）：
  - 上下文保存/恢复
  - 中断向量分发

- **上下文**（`kernel/arch/riscv64/ctx.h`）：
  - 32 个通用寄存器 + sepc + sstatus + kstack_sp
  - ExtContext 包含 32 个浮点寄存器 + fcsr
  - 上下文布局通过静态断言验证

- **Sv39 页表**（`kernel/arch/riscv64/mem/sv39.h`）：
  - 完整的三级页表实现（见 3.4.6 节）

#### 3.11.2 LoongArch64

- **异常处理**（`kernel/arch/loongarch64/int/exception.cpp`）：
  - 25 种异常类型（含子码区分）
  - 页异常：LOAD/STORE/FETCH PAGE INVALID、PAGE MODIFICATION、PAGE NOT READABLE/EXECUTABLE、PRIVILEGE VIOLATION
  - 系统调用、断点、非法指令、地址不对齐等

- **上下文**（`kernel/arch/loongarch64/ctx.h`）：
  - 32 个通用寄存器 + era + crmd + prmd + estat
  - ExtContext 包含 32 个 256 位向量寄存器（v[32][2]）+ fcc + fcsr
  - LA64 特有的 CSR 管理（CRMD、PRMD）

- **页表**（`kernel/arch/loongarch64/mem/pageman.h`）：
  - LA64 多级页表实现
  - TLB 重填异常处理（refill.S）

#### 3.11.3 架构 Trait 系统

使用 C++20 Concepts 定义架构抽象（`kernel/arch/trait.h`）：

- `EarlySerialTrait`：早期串口
- `InitializationTrait`：架构初始化
- `ArchPageManTrait`：页表管理器（含 RWX、PTE 信息读取、页标志、修改器等子概念）
- `ContextTrait`：上下文（支持 UTHREAD_TRAMPOLINE/USER_THREAD/KTHREAD 三种初始化模式）
- `InterruptTrait`：中断管理
- `IdleTrait`：空闲循环

#### 3.11.4 实现完整度：**85%**

- 双架构实现对称且完整
- 异常/中断处理路径覆盖全面
- 页表操作完整
- Traits 系统设计优雅，保证架构代码的类型安全

---

### 3.12 启动过程（Boot）— `kernel/boot/`

#### 3.12.1 RISC-V SBI 启动

`kernel/boot/sbi/sbi_boot.cpp` 实现 SBI 模式下的引导：

1. 校验内核大小（< 32MB）、分页区域（> 64KB）、DTB 魔数（0xD00DFEED）
2. 分配根页表（`page_alloc()` 从可回收区域分配）
3. 设置恒等映射（PA 0x80000000~0xC00000000 的 1GB 映射）
4. 设置 KPA 映射（物理地址 + KPA_OFFSET）
5. 映射内核到高地址（KVA_OFFSET）
6. 映射 DTB
7. 返回 satp 值（SATP_SV39_BASE | PPN）
8. 跳转到内核入口

#### 3.12.2 LoongArch 启动

`kernel/boot/laboot/` 提供 LA64 的引导支持。

#### 3.12.3 实现完整度：**80%**

---

### 3.13 设备管理（Device）— `kernel/device/`

- **设备模型**（`model.cpp/h`）：全局设备管理器，管理 Platform、中断控制器图、设备列表
- **PCI 总线**（`pci.cpp/h`）：PCI 设备枚举
- **中断控制器图**（`ic_graph.cpp/h`）：IRQ 路由
- **FDT 解析**（`fdt/`）：设备树解析，支持 compatible 匹配、reg 解析、中断解析、状态过滤
- **CPU 抽象**（`cpu.cpp/h`）：CPU 核心管理
- **资源管理**（`resource.cpp/h`）：MMIO 区域管理

#### 实现完整度：**70%**

---

### 3.14 用户态库（Libraries）— `libs/`

| 库 | 说明 |
|---|---|
| **basecpp** | 基础 C++ 运行时（IO、字符串、路径、类型转换） |
| **sbi** | SBI 调用封装（控制台、传统调用等） |
| **kmod** | 内核模块支持（文件操作、内存分配、系统调用封装） |
| **linuxss-libc** | Linux 子系统 libc 兼容层（malloc、stdio、系统调用头文件） |
| **rpc** | RPC 通信库（packet、session） |

#### 实现完整度：**60%**

- 基础功能可用
- libc 兼容层功能有限（仅覆盖模块所需）

---

### 3.15 用户态模块（Modules）— `module/`

30 个用户态测试/功能模块：

| 类别 | 模块 | 数量 |
|---|---|---|
| 系统 | init, default, contest-runner, linux-subsystem | 4 |
| fork/exec | test_fork, test_execve | 2 |
| 线程 | test_thread | 1 |
| 信号 | test_signal | 1 |
| 内存 | test_meminfo | 1 |
| procfs | test_procfs | 1 |
| ext4 | test_ext4_read, test_ext4_create, test_ext4_rw, test_ext4_symlink, test_ext4_permission | 5 |
| 文件 IO | test_file_rw_a, test_file_rw_b, test_file_backed_memory | 3 |
| 页缓存 | test_page_cache, test_page_cache_perf | 2 |
| ELF | test-elf-demand, test-elf-demand-perf, test-elf-demand-perf-child | 3 |
| RPC | test_rpc_server, test_rpc_client | 2 |
| Endpoint | test_endpoint_master, test_endpoint_slave, test_call_service, test_call_user | 4 |
| 评测 | test_fs_score, test-linux | 2 |

#### 实现完整度：模块覆盖了主要内核功能的测试

---

### 3.16 Linux 子系统（Linux Subsystem）— `module/linux-subsystem/`

为用户进程提供 Linux ABI 兼容层：

- `basic.cpp`：基础系统调用模拟
- `clone.cpp`：clone/fork 实现
- `fdtable.cpp/h`：文件描述符表
- `file.cpp/h`：文件操作
- `pipe.cpp/h`：管道操作
- `thread.cpp`：线程管理
- `signal_return.S`：信号返回跳板（RISC-V64/LA64 各一份）
- `clone_return.S`：clone 返回跳板

#### 实现完整度：**50%**

- 提供了基本的 Linux ABI 兼容
- 覆盖了常用的文件 IO、进程管理、信号

---

## 四、子系统交互概览

```
用户态模块
    │
    │ ECALL（系统调用）
    ▼
┌──────────────────────────────────────────────┐
│  异常处理（arch/*/int/exception.cpp）         │
│    └─> ECALL 分发到 syscall::dispatch_sync()  │
└──────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│  系统调用层（kernel/syscall/）                │
│    ├─> CHolder::lookup() 查找 Capability     │
│    ├─> 构造 Object（MemoryObject等）         │
│    ├─> 权限检查（perm::imply）                │
│    └─> 执行操作                              │
└──────────────────────────────────────────────┘
    │                    │
    ▼                    ▼
┌──────────────┐  ┌──────────────────────┐
│  对象层       │  │  VFS 层               │
│  (object/)   │  │  (vfs/)              │
│  Memory      │  │  ├─ VFS 路径解析      │
│  Endpoint    │  │  ├─ VINode/VFile     │
│  Notification│  │  ├─ ext4/tmpfs/procfs│
│  Pipe        │  │  └─ Page Cache       │
│  Task        │  └──────────┬───────────┘
└──────┬───────┘             │
       │                     ▼
       │            ┌──────────────────────┐
       │            │  Block IO (bio/)      │
       │            │  ├─ BufferCache      │
       │            │  ├─ BlockRequestQueue│
       │            │  └─ BlkManager       │
       │            └──────────┬───────────┘
       │                       │
       ▼                       ▼
┌──────────────────────────────────────────────┐
│  内存管理（kernel/mem/）                      │
│  ├─ VMA（虚拟内存区域）                       │
│  ├─ TaskMemoryManager（地址空间管理）          │
│  ├─ PageMan（页表操作）                       │
│  ├─ GFP（引用计数页分配）                     │
│  ├─ SLUB（小对象分配）                        │
│  └─ Buddy（页框分配）                         │
└──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│  架构层（kernel/arch/）                       │
│  ├─ 页表管理（Sv39 / LA64 Pageman）          │
│  ├─ 上下文切换（__switch_to）                │
│  ├─ 异常/中断处理                            │
│  └─ TLB 管理                                │
└──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│  调度器（kernel/schd/ + kernel/task/）        │
│  ├─ 多级调度（RT > INIT > RR > FCFS > IDLE） │
│  ├─ 上下文切换                               │
│  ├─ 抢占控制                                 │
│  └─ 等待/唤醒                                │
└──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│  驱动层（kernel/driver/）                     │
│  ├─ VirtIO（MMIO + PCI）                     │
│  ├─ 串口 / 时钟 / RTC                        │
│  └─ 中断控制器                               │
└──────────────────────────────────────────────┘
```

---

## 五、设计创新性分析

### 5.1 Capability-based 安全模型（高创新性）

Sustcore 以 Capability 作为一等公民贯穿整个内核设计，而非事后添加的访问控制层。这在教学/竞赛类内核中较为罕见：

1. **所有内核资源通过 Capability 访问**：文件、内存、IPC 端点、通知、管道、中断等全部通过 Capability 引用。
2. **细粒度权限模型**：64 位权限位图，基础权限 + 类型特定权限。
3. **能力传递语义**：CLONE（共享）、MIGRATE（转移）、MIGRATE_ONCE（一次性转移），支持最小权限原则。
4. **能力与 COW 深度集成**：clone Memory Capability 时自动触发 COW 设置。

### 5.2 异步 IPC 模型（中高创新性）

Endpoint 的 Promise/Future 异步模型：

- 发送方和接收方通过等待队列解耦
- 支持同步和异步两种模式
- `endpoint_call` + `endpoint_reply` 的 RPC 模式
- ReplyPayload 作为一次性能力，使用后自动销毁

### 5.3 Memory Payload 的设计（中高创新性）

Memory Payload 将虚拟内存管理抽象为能力对象：

- 文件后端内存映射（file-backed memory）
- 承诺大小与实际分配分离（lazy allocation）
- 连续性选项（物理连续 vs 非连续）
- 增长/收缩约束（growth: FIXED/GROW_UP/GROW_DOWN 等）
- 与 VMA 的清晰分离（VMA 描述映射关系，MemoryPayload 管理物理页）

### 5.4 多调度类 + 可扩展框架（中等创新性）

- 模板化的调度器基类设计
- 5 个调度类按优先级组织
- 每个调度类独立管理自己的就绪队列
- 通用的 RQ（RunQueue）结构支持不同调度类

### 5.5 C++20/23 现代特性应用（中等创新性）

- Concepts 定义架构 Trait，提供编译期接口检查
- `Result<T>` 错误处理模式（类似 Rust）
- RAII 资源管理
- `util::owner<T>` 所有权标注
- 模板化的 SLUB 分配器
- constexpr 大量用于编译期计算（页大小、掩码等）

### 5.6 双架构支持（中等创新性）

- RISC-V64 和 LoongArch64 的对称实现
- 架构 Trait 系统保证接口一致性
- LoongArch 是较新的国产架构，其内核支持本身就具有创新意义

### 5.7 完整度较高的 ext4 实现（中等创新性）

- 从零实现的 ext4 文件系统读取/写入支持
- 覆盖了主要的 ext4 特性
- 在竞赛项目中较为少见

---

## 六、项目优势

1. **架构清晰**：能力系统、VFS、内存管理三大核心子系统设计合理，接口明确。
2. **代码质量高**：C++ 现代特性运用得当，RAII、Concepts、Result 模式提高了代码安全性。
3. **功能覆盖广**：从启动到用户态进程、从文件系统到 IPC，形成了完整的内核功能闭环。
4. **文档详尽**：各子系统有 Doxygen 注释，`docs/`、`compdoc/`、`config-ref/` 目录有设计文档。
5. **测试模块丰富**：30 个用户态测试模块覆盖了主要功能路径。
6. **双架构支持**：同时支持 RISC-V64 和 LoongArch64，展现了良好的可移植性设计。

---

## 七、项目不足与改进方向

1. **多核支持缺失**：调度器缺少负载均衡，中断处理未考虑多核 affinity。
2. **网络栈缺失**：无 TCP/IP 协议栈实现。
3. **驱动覆盖有限**：仅支持 VirtIO 块设备和基本串口/时钟。
4. **ext4 部分特性缺失**：日志（journal）不支持，extent 深度>1 的实现需验证。
5. **动态链接支持不完整**：ELF 加载器支持 INTERP 但运行时动态链接支持有限。
6. **POSIX 兼容性有限**：缺少 poll/select、mmap/munmap、完整的信号集等。
7. **无用户态管理工具**：缺少 shell、系统管理命令等。
8. **构建依赖重**：要求 GCC 15+，构建环境要求较高。

---

## 八、总结

Sustcore 是一个设计精良、实现详实的 Capability-based 混合内核。项目从零构建，代码量约 11.4 万行，涵盖能力系统、内存管理（Buddy+SLUB+GFP+VMA+COW）、VFS（含 ext4/tmpfs/procfs/tarfs/devfs 五种文件系统及页缓存）、任务管理（进程/线程/信号/等待）、多级调度器、IPC（Endpoint/Notification/Pipe）、设备驱动（VirtIO）、ELF 加载器、双架构支持等完整功能。

核心理念是以 Capability 作为资源访问的统一抽象，配合 C++ 现代特性实现类型安全的内核设计。该项目在能力系统的完整实现、Memory Payload 与 COW 的深度集成、ext4 文件系统的从零实现、双架构（含 LoongArch）支持等方面展现了高度的技术水平和创新性。

作为竞赛/教学项目，Sustcore 的实现完整度（约 75-80%）在同类项目中处于较高水平，尤其在文件系统和能力安全模型方面表现突出。主要不足在于缺少多核优化、网络栈和更完善的 POSIX 兼容性。