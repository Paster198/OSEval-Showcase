# OSKernel2026 深入技术分析报告

## 1. 分析方法概述

本次分析对项目进行了以下维度的全面调查：

1. **全量源码审查**：逐个阅读所有 44 个源文件（共约 22,743 行代码），包括 `kernel/`、`arch/riscv/`、`arch/loongarch/`、`include/` 所有文件。
2. **构建验证**：使用 `riscv64-unknown-elf-gcc` 成功完成 RISC-V 目标的完整构建，验证了 Makefile 构建流程的正确性。
3. **QEMU 启动测试**：在无磁盘镜像条件下启动 QEMU，验证 OpenSBI 固件加载和内核入口的正常执行（内核因无块设备而正常关机）。
4. **交叉引用分析**：通过 `#include` 依赖链、`__attribute__((weak))` 符号覆盖、`extern` 声明追踪子系统间的交互关系。
5. **接口契约分析**：分析 VFS 的 `file_operations`、`inode_operations`、`super_operations` 等接口在各文件系统中的实现情况。

## 2. 构建与测试结果

### 2.1 构建测试

RISC-V 构建成功完成，无警告（使用 `-Wall -Wextra -Werror`），生成 ELF 文件 `kernel-rv` (187,776 字节)。

```
riscv64-unknown-elf-gcc -std=gnu11 -ffreestanding -fno-builtin ...
-nostdlib -T arch/riscv/linker.ld -o kernel-rv [20个.o文件]
```

musl 动态加载器嵌入功能未触发（`/opt/riscv64-linux-musl-cross/.../libc.so` 不存在）。

LoongArch 构建未测试（`loongarch64-linux-gnu-gcc` 不在当前环境）。

### 2.2 QEMU 启动测试

在无磁盘镜像的条件下启动 QEMU，观察结果：
- OpenSBI v1.3 正常初始化，进入 S 模式。
- 内核入口 `_start (0x80200000)` 正常执行。
- `virtio_blk_init()` 返回 false（无 VirtIO 块设备），`mount_root_filesystem()` 返回 false。
- 内核随后初始化 devfs、procfs、tmpfs、进程系统和定时器。
- `ext4_run_test_scripts()` 因为无 EXT4 文件系统而快速返回。
- `platform_shutdown()` 通过 SBI 正常关机。

**结论**：内核的启动路径和平台初始化在所有子系统均可用时工作正常。完整功能测试需要附带 EXT4 磁盘镜像。

## 3. 子系统实现详情

### 3.1 平台抽象层（Platform Abstraction Layer）

#### 接口定义 (`include/platform.h`)

定义了 8 个平台无关函数：

```c
void platform_putc(char c);
void platform_shutdown(void) __attribute__((noreturn));
const char *platform_name(void);
uintptr_t platform_dma_addr(const void *addr);
void platform_fence_io(void);
uintptr_t platform_virtio_mmio_base(unsigned index);
uintptr_t platform_memory_end(void);
void platform_paging_init(void);
```

#### RISC-V 实现 (`arch/riscv/platform.c`)

- **UART 串口**：通过 MMIO 访问 NS16550 兼容 UART，基址 `0x10000000`，输出前轮询 LSR 寄存器等待发送就绪。
- **VirtIO MMIO**：4 个设备槽位，起始地址 `0x10001000`，步长 `0x1000`。
- **DRAM**：起始地址 `0x80000000`，大小 2 GiB。
- **DMA**：直接返回内核物理地址（无 IOMMU）。
- **IO 屏障**：使用 RISC-V `fence iorw, iorw` 指令。
- **关机**：通过 SBI System Reset 扩展（`a7=0x53525354`）调用 `ecall`。

```c
void platform_shutdown(void) {
    register uintptr_t a0 asm("a0") = 0;
    register uintptr_t a7 asm("a7") = 0x53525354;
    asm volatile("ecall" : "+r"(a0) : "r"(a7) : "memory");
    for (;;) { asm volatile("wfi"); }
}
```

#### LoongArch 实现 (`arch/loongarch/platform.c`)

- **UART**：基址 `0x1fe001e0`（DMW 直接映射窗口）。
- **DRAM**：保守配置 448 MiB（避免与 MMIO 区域冲突）。
- **DMA**：屏蔽高 4 位地址（`addr & 0x0fffffffffffffff`）。
- **关机**：通过 ACPI GED 寄存器（`0x100e001c`）写入 S5 休眠值。
- **分页初始化**：`platform_paging_init()` 为空实现——LoongArch 使用固件提供的 DMW 直接映射。

#### 完整度评估

| 功能 | RISC-V | LoongArch |
|------|--------|-----------|
| 串口输出 | 完成 | 完成 |
| 关机 | 完成（SBI） | 完成（ACPI GED） |
| VirtIO 基址 | 完成 | 完成 |
| DMA 地址 | 完成 | 完成 |
| IO 屏障 | 完成 | 完成 |
| 内存上限 | 2 GiB 硬编码 | 448 MiB 硬编码 |

**不足**：内存大小硬编码而非通过设备树动态获取。

---

### 3.2 内存管理 (`kernel/mm.c` + `kernel/mm.h`)

#### 设计架构

从链接符号 `__kernel_end` 向上管理所有物理内存。同时提供：
- **堆分配器**（`kmalloc`/`kfree`）：基于空闲链表的 first-fit 算法
- **页分配器**（`page_alloc`/`page_free`）：独立单向空闲链表

两者共享 `heap_next` 增长边界，无固定分区。

#### kmalloc/kfree 实现细节

```c
struct heap_block {
    size_t size;
    struct heap_block *next;
};
```

每个分配块前面有 `heap_block` 头，请求大小按 16 字节对齐：

1. **分配路径**：遍历按地址排序的空闲链表，first-fit 查找满足大小的块。如果剩余空间足够再容纳一个 `heap_block` + 最小对齐，则拆分该块。链表中无合适块时从 `heap_next` 线性增长。
2. **释放路径**：`heap_insert_block()` 按地址顺序将块插入空闲链表，并与物理相邻的前后块立即合并。

```c
void kfree(void *ptr) {
    struct heap_block *block = (struct heap_block *)((uint8_t *)ptr - sizeof(struct heap_block));
    heap_insert_block(block);
}
```

3. **合并逻辑**：通过比较指针地址判断物理相邻性，合并相邻块时更新 `size` 字段并调整链表。

#### page_alloc/page_free 实现细节

```c
void *page_alloc(void) {
    if (free_list != 0) {
        uint8_t *page = (uint8_t *)free_list;
        free_list = *(uintptr_t *)page;  // 空闲链表的next指针存于页首8字节
        zero_page(page);
        return page;
    }
    // 否则从heap_next向上增长
    uintptr_t aligned_next = align_up(heap_next, PAGE_SIZE);
    // ... 
}
```

释放时将页面首 8 字节用作链表指针，插入空闲链表头。

#### 统计函数

- `mm_total_mem()`：返回 `heap_end`
- `mm_free_mem()`：汇总尾部未用空间 + 空闲链表块大小（**不包括**页空闲链表，因此是近似值）

#### 完整度评估

| 特性 | 状态 | 说明 |
|------|------|------|
| 基本 kmalloc/kfree | 完成 | first-fit，合并相邻块 |
| page_alloc/page_free | 完成 | 独立链表，返回清零页 |
| 多页连续分配 | 未实现 | 每次仅分配一页 |
| SMP 锁 | 未实现 | 无并发保护 |
| 伙伴系统 | 未实现 | 无 |
| slab/slub | 未实现 | 无 |
| 双重释放检测 | 未实现 | `kfree` 不验证头部合法性 |

---

### 3.3 虚拟文件系统（VFS）(`kernel/vfs.c` + `kernel/vfs.h`)

VFS 是整个内核最大的模块（约 1,815 行），是文件系统架构的核心枢纽。

#### 核心数据结构

```c
struct super_block {
    struct dentry *s_root;
    struct file_system_type *s_type;
    unsigned long s_blocksize;
    void *s_dev_private;
    void *s_fs_info;
    const struct super_operations *s_op;
};

struct inode {
    unsigned long i_ino;
    unsigned int i_mode;       // S_IFDIR / S_IFREG 等
    unsigned int i_nlink;
    size_t i_size;
    size_t i_blocks;
    const struct inode_operations *i_op;
    const struct file_operations *i_fop;
    struct super_block *i_sb;
    void *i_private;           // FS 私有数据（如 ext4 inode_no、tmpfs_node）
};

struct dentry {
    char d_name[VFS_DENTRY_NAME_MAX]; // 最多 31 字符
    struct inode *d_inode;
    struct dentry *d_parent;
    bool is_mountpoint;
    struct dentry *d_child_next;    // 兄弟链表
    struct dentry *d_subdirs_head;  // 子目录链表头
};

struct file {
    int f_count;
    struct dentry *f_dentry;
    size_t f_pos;
    unsigned int f_flags;
    const struct file_operations *f_op;
    void *f_private;
    uint8_t f_owns_metadata;   // 释放时是否负责释放 dentry+inode
};
```

#### 操作接口

```c
struct inode_operations {
    int (*lookup)(struct inode *dir, const char *name, struct dentry **result);
    int (*mkdir)(struct inode *dir, const char *name, unsigned int mode);
    int (*create)(struct inode *dir, const char *name, unsigned int mode);
};

struct file_operations {
    long (*read)(struct file *file, void *buf, size_t len);
    long (*write)(struct file *file, const void *buf, size_t len);
    long (*readdir)(struct file *file, void *buf, size_t len);
    long (*truncate)(struct file *file, size_t len);
    long (*open)(struct inode *inode, struct file *file);
};
```

#### 路径解析

`vfs_path_walk()` 是核心路径解析函数：
1. 从根 dentry 或指定 cwd inode 开始。
2. 调用 `get_next_component()` 逐级分割路径。
3. 遇到挂载点时穿越到对应文件系统的根 dentry。
4. 调用 `vfs_find_child()` 查找子节点，若不存在则通过 `inode->i_op->lookup()` 委托给文件系统。
5. 支持 `.` 和 `..` 导航。

#### 挂载系统

- 全局挂载链表 `mount_list`（单向链表）。
- `vfs_do_mount()`：创建 mount 结构，调用 `fs_type->mount()` 获取 super_block，将 `mnt_mountpoint` 指向目标 dentry。
- 路径解析时，若遇到 `is_mountpoint == true` 的 dentry，则穿越到对应挂载的 `s_root`。

#### 全局文件表

```c
struct file global_file_table[SYS_MAX_FILES]; // 1024 个槽位
```

以 `f_count` 引用计数管理，`global_file_alloc()` 线性扫描空闲槽位。

#### procfs 集成（VFS 内联实现）

VFS 模块内部包含完整的 procfs 实现（非独立模块）：

- **procfs_node**：节点描述符，支持 DIR/REG 两种类型，可选 `read_cb` 回调。
- **procfs_template**：用于批量创建 `/proc` 下的固定节点（`self/`, `mounts`, `meminfo`, `uptime`, `stat`）。
- **动态 PID 目录**：`/proc/<pid>/status` 和 `/proc/<pid>/cmdline` 在 lookup 时动态生成 inode。
- procfs 注册为独立文件系统类型 `"procfs"`，通过 `register_filesystem()` 注册。

#### VFS 提供的工具函数

- `vfs_alloc_dentry()`、`vfs_alloc_inode()`、`vfs_alloc_super_block()`、`vfs_alloc_mount()`
- `vfs_link_child()`：将子 dentry 加入父 dentry 的 `d_subdirs_head` 链表
- `vfs_find_child()`：按名称在子目录链表中查找
- `vfs_create_file()`：创建路径上的中间目录和最终文件（占位 inode）
- `vfs_open()` / `vfs_open_at()`：路径解析 + 创建/打开文件对象

#### 完整度评估

| 特性 | 状态 | 说明 |
|------|------|------|
| super_block/inode/dentry/file 结构 | 完成 | 轻量但完整 |
| 路径解析 | 完成 | 支持挂载点穿越、`.`/`..` |
| 挂载系统 | 完成 | 多文件系统挂载 |
| 全局文件表 | 完成 | 1024 槽位，引用计数 |
| 文件操作接口 | 基本完成 | 5 个操作，缺少 mmap/ioctl/poll |
| inode 操作接口 | 基本完成 | 3 个操作，缺少 symlink/rename |
| 缓存/回收 | 未实现 | 无 inode cache、dentry cache |
| 权限检查 | 未实现 | 无 UID/GID 检查 |
| 文件锁 | 未实现 | 无 |
| 符号链接 | 未实现 | 无 symlink 操作 |

---

### 3.4 文件系统实现

#### 3.4.1 EXT4（只读）(`kernel/ext4.c` + `kernel/ext4.h`)

约 1,275 行，实现只读 EXT4 文件系统。

**超级块解析（`ext4_probe()`）**：
1. 从 VirtIO 块设备读取扇区 2（EXT4 超级块）。
2. 验证魔数 `0xEF53`。
3. 解析：`log_block_size`、`blocks_per_group`、`inodes_per_group`、`inode_size`、`desc_size`。
4. 支持的块大小：1024 到 4096 字节。

**Inode 读取（`read_inode()`）**：
1. 计算 inode 所在块组：`(inode_no - 1) / inodes_per_group`。
2. 读取组描述符表获取 inode 表块号。
3. 计算 inode 在表内的偏移并读取。

**Extent 遍历（`read_extent_leaf_range()`）**：
- 支持 depth=0（叶子节点直接在 inode 内）和 depth=1（一层索引节点）。
- 不支持 depth >= 2 的深层 extent 树。
- 解析 extent 的 `ee_block`、`ee_start_lo`/`ee_start_hi`、`ee_len`，定位数据块。

**数据读取（`ext4_read_inode_range()`）**：
```c
bool ext4_read_inode_range(uint32_t inode_no, uint64_t offset,
                           uint8_t *out, uint32_t len, uint32_t *read_len);
```
- 读取 inode，检查 extent flag。
- 遍历 extent 树定位目标偏移的数据块。
- 支持跨 extent 的读取。

**目录遍历（`ext4_iterate_dirents()`）**：
- 读取目录 inode 数据块。
- 解析 EXT4 目录项结构：`inode`(4B)、`rec_len`(2B)、`name_len`(1B)、`file_type`(1B)、`name`(变长)。
- 通过回调函数处理每个目录项。
- 维护 `start_index` 支持分页读取（getdents64）。

**目录项缓存**：
- 全局缓存数组 `cached_dirents[8192]`，在首次扫描时填充。
- `find_cached_dirent()` 用于后续快速查找。
- `ext4_lookup_path()` 使用缓存的 dirent 进行路径解析。

**测试脚本系统**：
- `ext4_run_test_scripts()`：递归扫描根目录（深度 ≤ 4），识别 `*_testcode.sh` 文件。
- 按优先级排序（`basic` > `busybox` > `lua` > `cyclictest` > ...）。
- 加载 busybox inode，以 `sh <script_name>` 运行每个脚本。
- 每个脚本运行后调用 `scheduler()` 执行调度。

**EXT4 支持的 inode 操作**：
- `ext4_inode_lookup`：在目录中按名称查找。
- `ext4_inode_is_dir()`：检查 inode 的 mode 字段。

**EXT4 文件操作**：
- `ext4_file_read`：从 inode 读取数据。
- `ext4_dir_read`：读取目录项。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| 超级块解析 | 完成 |
| inode 读取 | 完成 |
| extent 遍历 | 完成（depth 0-1） |
| 文件数据读取 | 完成（只读） |
| 目录遍历 | 完成 |
| dirent 缓存 | 完成（8192 条目） |
| 路径查找 | 完成 |
| 文件写入 | 未实现（只读） |
| 深层 extent (>depth 1) | 未实现 |
| 间接块映射 | 未实现 |
| 日志 | 未实现 |
| ext4 创建/删除 | 未实现 |

---

#### 3.4.2 tmpfs (`kernel/tmpfs.c` + `kernel/tmpfs.h`)

约 415 行，内存驻留可读写临时文件系统。

**数据结构**：
```c
struct tmpfs_node {
    unsigned long ino;
    unsigned int mode;
    size_t size;
    size_t capacity;
    uint8_t *data;       // 文件数据缓冲区
    struct dentry *dentry;
};
```

**实现特点**：
- `tmpfs_write()`：动态扩容策略——容量从 64 字节起步，每次翻倍直到满足需求。使用 `kmalloc` 分配新缓冲区并 `kmemcpy` 旧数据。
- `tmpfs_read()`：从 `node->data + file->f_pos` 直接复制。
- `tmpfs_readdir()`：遍历 dentry 子链表，每行输出一个文件名。
- `tmpfs_truncate()`：扩展时用零填充（逐字节 write），收缩时仅更新 size。
- `tmpfs_create()` / `tmpfs_mkdir()`：分配 node + inode + dentry，通过 `vfs_link_child` 加入父目录。
- `tmpfs_lookup()`：通过 `vfs_find_child()` 查找。

**注册**：
- 通过 `register_filesystem()` 注册为 `"tmpfs"`。
- `tmpfs_init()` 创建并挂载 `/tmp`。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| 文件创建/读写/截断 | 完成 |
| 目录创建/遍历 | 完成 |
| 动态扩容 | 完成 |
| 文件删除 | 未明确实现 |
| 权限位实际检查 | 未实现 |
| 时间戳 | 未实现 |

---

#### 3.4.3 devfs (`kernel/devfs.c` + `kernel/devfs.h`)

约 332 行，设备文件系统。

**设备节点**（8 个）：
```c
static const struct devfs_node_desc devfs_items[] = {
    { DEVFS_NODE_NULL,            "null",            0, 0 },
    { DEVFS_NODE_ZERO,            "zero",            0, 0 },
    { DEVFS_NODE_TTY,             "tty",             0, 0 },
    { DEVFS_NODE_CONSOLE,         "console",         0, 0 },
    { DEVFS_NODE_RANDOM,          "random",          0, 0 },
    { DEVFS_NODE_URANDOM,         "urandom",         0, 0 },
    { DEVFS_NODE_CPU_DMA_LATENCY, "cpu_dma_latency", read_cpu_dma_latency, write_cpu_dma_latency },
    { DEVFS_NODE_RTC,             "misc/rtc",        0, 0 },
};
```

**实现特点**：
- 每个设备节点关联可选的 `read_cb` / `write_cb` 回调（类型为 `uint64_t (*)(uint64_t offset, uint8_t *out, uint64_t len)`）。
- `cpu_dma_latency` 是唯一实现读写回调的设备（维护静态 32 字节缓冲区）。
- `devfs_lookup()`：查找时动态创建 inode/dentry 并加入父目录。
- 注册为 `"devfs"` 文件系统类型，挂载于 `/dev`。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| 基本设备节点注册 | 完成（8 个） |
| cpu_dma_latency 读写 | 完成 |
| null/zero/random 数据语义 | 未实现（read/write 回调为 NULL，返回 0） |
| tty/console 语义 | 未实现 |

---

#### 3.4.4 管道 (`kernel/pipe.c` + `kernel/pipe.h`)

约 129 行，进程间通信管道。

**全局管道表**：
```c
struct proc_pipe proc_pipe_table[PROC_PIPE_MAX]; // 128 个管道
```

每个管道有 4096 字节环形缓冲区，`head`/`len` 维护读写位置，`read_open`/`write_open` 跟踪端点状态。

**核心读写函数**：
- `pipe_read_to_user_by_file()`：当缓冲区为空时，若写端仍打开则 yield 等待（阻塞读）；非阻塞模式下返回 `-EAGAIN`；支持信号中断返回 `-EINTR`。
- `pipe_write_from_user_by_file()`：当缓冲区满时，yield 等待；若读端已关闭返回 `-EPIPE`。
- 使用 `read_user8`/`write_user8` 逐字节进行用户/内核数据传输。

**端点管理**：
- `pipe_attach_file()`：将 `pipe_read_ops` 或 `pipe_write_ops` 绑定到 `file->f_op`。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| 环形缓冲区读写 | 完成 |
| 阻塞/非阻塞语义 | 完成 |
| 读端关闭检测（EPIPE） | 完成 |
| 信号中断检测 | 完成 |
| poll/select 支持 | 间接（通过 yield） |
| splice/sendfile | 未实现 |

---

#### 3.4.5 控制台 (`kernel/console.c` + `kernel/console.h`)

约 22 行，最小控制台实现。仅实现 `write` 操作：逐字节通过 `read_user8` 读取用户缓冲区，调用 `kputc`（即 `platform_putc`）输出到串口。

---

### 3.5 块设备驱动：VirtIO Block (`kernel/virtio_blk.c`)

约 288 行，实现 VirtIO MMIO 块设备驱动（仅读取方向）。

#### 初始化流程（`virtio_blk_init()`）

1. 扫描 8 个 MMIO 槽位，通过 Magic (0x74726976) 和 Device ID (2) 识别块设备。
2. 识别版本（v1 Legacy 或 v2 Modern）。
3. Modern 设备：协商 `VIRTIO_F_VERSION_1` feature 标志。
4. 设置 8 条描述符的 virtqueue。
5. Modern 路径：分离的 descriptor/available/used 环形缓冲区。
6. Legacy 路径：连续的队列区域，通过 `QUEUE_PFN` 寄存器传递物理地址。

#### 读取操作（`virtio_blk_read_sector()`）

使用 3 条描述符链：
1. 描述符 0：设备可读的 VirtIO 块请求头（`type=VIRTIO_BLK_T_IN`, sector）。
2. 描述符 1：设备可写的 512 字节数据缓冲区（`VRING_DESC_F_WRITE`）。
3. 描述符 2：设备可写的状态字节。

提交后轮询 `used->idx`（带自旋上限 `READ_SPIN_LIMIT = 100000000`），等待设备完成。

#### 限制

- 仅支持单扇区读取（512 字节）。
- 无中断驱动——使用忙轮询。
- 每次只提交一个请求（无请求队列并发）。
- 无写入路径（EXT4 只读，不需要）。

---

### 3.6 进程管理 (`kernel/proc.c` + `include/process.h`)

#### 进程控制块 (`struct proc`)

结构体约 110+ 字段，是内核中最大的单一结构：

```c
struct proc {
    enum proc_state state;           // 进程状态
    struct user_space *space;        // 用户地址空间
    struct kernel_context context;   // 内核上下文（调度用）
    void *trap_frame_page;           // trap frame 物理页
    uint64_t trap_frame_va;          // trap frame 虚拟地址
    uint8_t kstack[16384];           // 16 KiB 内核栈
    bool owns_user_space;            // 是否拥有地址空间
    uint64_t pid, ppid, tgid;       // 进程/父进程/线程组ID
    uint64_t exit_code;              // 退出状态
    // futex 相关
    uint64_t futex_wait_uaddr;       // 等待地址
    uint32_t futex_wait_val;         // 等待值
    uint8_t futex_waiting;           // 是否在等待
    // 信号相关
    uint64_t signal_pending;         // 待处理信号位图
    uint64_t signal_mask;            // 阻塞信号位图
    struct proc_signal_action signal_actions[65]; // 信号处理动作
    uint64_t signal_alt_stack_sp;    // 信号备用栈
    // 内存映射
    struct proc_mmap_region mmap_regions[512]; // mmap 区域
    uint64_t brk;                    // 堆顶
    uint64_t mmap_next;              // 下次 mmap 起始地址
    // 文件描述符
    struct file_descriptor_entry fd_table[128]; // FD 表
    int next_fd;                     // 下次分配起始
    uint32_t cwd_inode_no;           // 当前工作目录 inode
    uint32_t umask;                  // 文件创建掩码
    // 时钟
    uint64_t real_timer_deadline_usec;
    uint64_t real_timer_interval_usec;
    uint8_t real_timer_armed;
};
```

#### 进程表

```c
struct proc proc_table[PROC_MAX_PROCS]; // 64 个槽位
static uint64_t next_pid;                // 单调递增 PID
```

#### 进程状态机

```
PROC_UNUSED → PROC_READY → PROC_RUNNING
                  ↑              ↓ (阻塞)
                  |         PROC_WAITING
                  |              ↓ (退出)
                  |         PROC_ZOMBIE → PROC_UNUSED (回收)
                  |              ↓ (线程组非主线程)
                  |         PROC_DEAD → PROC_UNUSED
```

#### 关键函数

**`proc_create()`**：
1. 扫描 `proc_table` 找 `PROC_UNUSED` 槽位。
2. 复制或分配 `user_space`。
3. 调用 `proc_reset_runtime()` 初始化运行时状态。
4. 分配 trap frame 页面。
5. 分配 PID（`next_pid++`）。

**`proc_fork()`**：
1. 分配子进程槽位。
2. 根据 `CLONE_VM` 标志决定共享或复制地址空间。
3. 复制父进程运行时状态（`copy_runtime()`）：fd 表（增加引用计数）、mmap 区域、brk、cwd 等。
4. 继承管道文件描述符。
5. 子进程 `ppid = parent->pid`。

**`proc_exit()`**：
1. 处理 `clear_child_tid`（futex wake）。
2. 关闭所有文件描述符（包括管道端点解绑）。
3. 释放地址空间和 trap frame。
4. 进程组主线程设为 `PROC_ZOMBIE`，子线程设为 `PROC_DEAD`。
5. 唤醒等待该子进程的父进程。
6. 向父进程发送 `SIGCHLD`。

**`proc_destroy()`**：
- 关闭 fd → 释放资源 → 重置为 `PROC_UNUSED`。

#### 进程发现

- `find_proc_by_pid_local()`：线性扫描进程表。
- `proc_find_waitable_zombie()`：查找指定 PID 或任意子进程中的僵尸进程。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| 进程创建/销毁 | 完成 |
| fork/clone | 完成（含 CLONE_VM, CLONE_SETTLS, CLONE_CHILD_SETTID 等） |
| exit/wait4 | 完成 |
| 僵尸回收 | 完成 |
| 管道继承 | 完成 |
| 线程组 (tgid) | 基本完成 |
| 进程组/会话 | 未实现 |
| 资源限制 (rlimit) | 未实现 |
| cgroup | 未实现 |

---

### 3.7 RISC-V 用户地址空间 (`arch/riscv/user.c`)

约 1,084 行，实现 Sv39 页表管理。

#### 地址空间布局

| 区域 | 地址范围 | 用途 |
|------|----------|------|
| 用户程序 | 动态（load_bias + 段偏移） | ELF PT_LOAD 段 |
| 堆 (heap) | `0x3f00000000` 起 | brk 系统调用扩展 |
| mmap | `0x3f10000000` 起 | mmap 匿名/文件映射 |
| 共享内存 | `0x3f70000000` | SysV 共享内存 |
| VDSO | `0x3ff7ffd000` | rt_sigreturn 跳板 |
| TLS | `0x3efff00000` | 线程局部存储 |
| 用户栈 | 动态（trap frame 下方） | 用户栈 |
| Trap Frame | `0x3ffffff000 - N*4K` | 每进程一页 |
| Trampoline | `0x3ffffff000` | 用户/内核共享页面 |

#### 页表构建（`user_space_build()`）

1. 分配根页表（level 2）和中间级页表。
2. 映射 trampoline 页面（同时存在于内核和用户页表）。
3. 映射 VDSO 页面。
4. 调用 `user_space_map_image()` 映射 ELF 段：遍历 `user_load_segment[]`，对每个段按页映射（复制数据，零填充 bss 部分）。
5. 分配用户栈（最多 64 页 = 256 KiB）：
   - 最底部一页用作 stack guard（无读权限，触发段错误）。
   - 之上 1 页用作初始栈。
   - 剩余页面预映射但按需使用。
6. 写入 AT_RANDOM 16 字节、aux 向量（13 对 AT_xxx/值）、环境字符串、参数字符串、argv 指针数组、argc。
7. 设置 `space->stack_top`、`space->entry`、`space->thread_pointer` 等。

#### 地址空间复制（`user_space_alloc_copy()`）

- 分配新根页表，递归遍历三级页表树。
- 叶页面对普通用户页面分配新物理页并复制数据。
- 共享区域（trampoline、VDSO、共享内存）保持相同物理页映射。

#### Supervisor 页面映射

- `user_space_map_supervisor_page()`：将物理页面以 supervisor 权限（无 U 标志）映射到用户页表，用于 trap frame。
- 这允许内核在用户页表激活时访问 trap frame。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| Sv39 三级页表 | 完成 |
| ELF 段映射 | 完成 |
| 用户栈构建 | 完成（含 aux 向量） |
| 地址空间复制 | 完成 |
| 共享区域识别 | 完成（trampoline/VDSO/SHM） |
| 堆初始化 | 完成 |
| COW (写时复制) | 未实现 |
| 页换出/换入 | 未实现 |
| Huge page | 未实现 |

---

### 3.8 ELF 加载器 (`kernel/elf.c` + `kernel/elf.h`)

约 755 行，完整的 ELF64 加载器。

#### 加载流程

**`elf_load_user_space()`**：
1. 从 EXT4 读取 ELF header（64 字节），验证魔数 `/x7fELF`、64 位、小端、版本。
2. 检查 machine 类型（EM_RISCV=243 / EM_LOONGARCH=258）与编译架构匹配。
3. 读取 program headers，依次处理 `PT_LOAD`、`PT_INTERP`、`PT_TLS`：
   - `PT_LOAD`：收集到 `load_segments[]` 数组。
   - `PT_INTERP`：记录动态解释器路径，通过 `lookup_interpreter_path()` 在 EXT4 中查找。
   - `PT_TLS`：记录 TLS 模板信息。
4. 类型为 `ET_DYN` 时启用 load_bias（PIE 支持）。
5. 如果有解释器：
   - 加载解释器 ELF 的 `PT_LOAD` 段到 `ELF_INTERP_BASE (0x3e80000000)`。
   - 在解释器的符号表中查找 `__libc_start_main` 获取入口。
6. 构建 `user_space`，映射所有段，设置栈和 aux 向量。

**Shebang 支持**（`parse_shebang()`）：
- 读取文件前 128 字节。
- 若以 `#!` 开头，提取解释器路径和可选参数。
- 重写 argv 为：`解释器 解释器参数 脚本路径 原始参数...`。

**musl 动态加载器嵌入**（条件编译）：
- 若构建时找到 musl `libc.so`，将其以二进制嵌入内核镜像。
- `elf_load_inode()` 可为动态链接的 ELF 程序在 `/lib/ld-musl-riscv64.so.1` 创建内存文件，指向嵌入的加载器。

#### 完整度评估

| 特性 | 状态 |
|------|------|
| ELF64 解析 | 完成 |
| PT_LOAD 段加载 | 完成 |
| PT_INTERP / 动态链接 | 完成 |
| PT_TLS | 完成 |
| PIE (ET_DYN) | 完成 |
| Shebang (#!) | 完成 |
| 符号表查找 | 完成 |
| musl 加载器嵌入 | 完成（条件编译） |
| 延迟绑定 (lazy binding) | 依赖解释器 |
| ET_REL 目标文件 | 不支持 |

---

### 3.9 RISC-V Trap 与系统调用 (`arch/riscv/trap.c` + `arch/riscv/trap_entry.S`)

这是整个内核最大的组件（trap.c 约 7,068 行），是用户态与内核态的唯一桥梁。

#### Trap 入口 (`trap_entry.S`)

**用户态异常处理（`riscv_uservec`/`riscv_trap_entry`）**：
1. 保存 `sp` 到 `sscratch`（在 trampoline 页中执行，因为切换 satp 后普通内核地址不可见）。
2. 将 32 个通用寄存器、`sepc`、`sstatus`、`satp` 保存到 trap frame。
3. 加载内核 `satp` 并执行 `sfence.vma`。
4. 切换到内核栈和内核 trap handler。
5. 调用 `riscv_trap_handler()`。

**Trap 恢复（`riscv_trap_restore`）**：
1. 切换回用户 `satp` 并 `sfence.vma`。
2. 恢复 `stvec` 指向用户态入口。
3. 恢复 `sepc`、`sstatus`、所有寄存器。
4. `sret` 返回用户态。

**内核态异常处理（`riscv_kernelvec`）**：
- 独立的内核 trap 栈（4 KiB）。
- 保存/恢复上下文后调用 `riscv_trap_handler()`。

#### Trap 分发（`riscv_trap_handler()`）

```c
void riscv_trap_handler(struct riscv_trap_frame *frame,
                        uint64_t scause, uint64_t stval)
```

处理以下异常类型：

| scause | 类型 | 处理 |
|--------|------|------|
| 8 (User Ecall) | 系统调用 | syscall 分发 |
| 12 (Inst Page Fault) | 指令缺页 | 延迟 mmap 处理或终止 |
| 13 (Load Page Fault) | 加载缺页 | 延迟 mmap 处理或终止 |
| 15 (Store Page Fault) | 存储缺页 | 延迟 mmap 处理或终止 |
| `0x8000000000000005` | 定时器中断 | `timer_handle_interrupt()` |

**延迟 mmap 缺页处理**（`handle_lazy_mmap_fault()`）：
- 在 mmap 区域中查找触发缺页的地址。
- 若为匿名映射（`MAP_ANONYMOUS`），分配并清零新页。
- 若为文件映射，从文件读取数据。
- 设置正确的 PTE 权限（R/W/X/U）。

#### 系统调用分发

通过 `frame->regs[17]`（a7）获取系统调用号，在约 150 行的 `switch` 语句中分发到 55+ 个处理函数。

**已实现的系统调用（按功能分组）**：

**I/O 操作（9 个）**：
- `SYS_READ` (63)、`SYS_WRITE` (64)、`SYS_READV` (65)、`SYS_WRITEV` (66)
- `SYS_PREAD64` (67)、`SYS_PWRITE64` (68)、`SYS_PREADV` (69)、`SYS_PWRITEV` (70)
- `SYS_LSEEK` (62)

**文件系统操作（18 个）**：
- `SYS_OPENAT` (56)、`SYS_CLOSE` (57)、`SYS_DUP` (23)、`SYS_DUP3` (24)
- `SYS_FCNTL` (25)、`SYS_IOCTL` (29)、`SYS_FTRUNCATE` (46)
- `SYS_MKDIRAT` (34)、`SYS_UNLINKAT` (35)、`SYS_RENAMEAT` (38)、`SYS_RENAMEAT2` (276)
- `SYS_FACCESSAT` (48)、`SYS_FACCESSAT2` (439)、`SYS_CHMODAT` (53)、`SYS_CHOWNAT` (54)
- `SYS_READLINKAT` (78)、`SYS_UTIMENSAT` (88)
- `SYS_FSTATAT` (79)、`SYS_FSTAT` (80)、`SYS_STATFS` (43)、`SYS_FSTATFS` (44)
- `SYS_GETDENTS64` (61)、`SYS_GETCWD` (17)
- `SYS_CHDIR` (49)、`SYS_UMASK` (166)

**进程管理（16 个）**：
- `SYS_CLONE` (220)、`SYS_EXECVE` (221)、`SYS_EXIT` (93)、`SYS_EXIT_GROUP` (94)
- `SYS_WAIT4` (260)、`SYS_GETPID` (172)、`SYS_GETPPID` (173)、`SYS_GETTID` (178)
- `SYS_GETUID` (174)、`SYS_GETEUID` (175)、`SYS_GETGID` (176)、`SYS_GETEGID` (177)
- `SYS_SETSID` (157)、`SYS_SETPGID` (154)、`SYS_PRCTL` (167)、`SYS_ALARM` (95)

**内存管理（8 个）**：
- `SYS_BRK` (214)、`SYS_MMAP` (222)、`SYS_MUNMAP` (215)、`SYS_MPROTECT` (226)
- `SYS_SHMGET` (194)、`SYS_SHMAT` (196)、`SYS_SHMDT` (197)、`SYS_SHMCTL` (195)

**Socket（14 个，最小 stub）**：
- `SYS_SOCKET` (198)、`SYS_BIND` (200)、`SYS_LISTEN` (201)、`SYS_ACCEPT` (202)
- `SYS_CONNECT` (203)、`SYS_SENDTO` (206)、`SYS_RECVFROM` (207)
- `SYS_SETSOCKOPT` (208)、`SYS_GETSOCKOPT` (209)、`SYS_SHUTDOWN` (210)
- `SYS_SENDMSG` (211)、`SYS_RECVMSG` (212)、`SYS_GETSOCKNAME` (204)、`SYS_GETPEERNAME` (205)

**信号（8 个）**：
- `SYS_RT_SIGACTION` (134)、`SYS_RT_SIGPROCMASK` (135)
- `SYS_RT_SIGTIMEDWAIT` (137)、`SYS_RT_SIGRETURN` (139)
- `SYS_SIGALTSTACK` (132)、`SYS_KILL` (129)、`SYS_TKILL` (130)、`SYS_TGKILL` (131)

**时钟与定时器（10 个）**：
- `SYS_CLOCK_GETTIME` (113)、`SYS_CLOCK_GETRES` (114)
- `SYS_CLOCK_NANOSLEEP` (115)、`SYS_NANOSLEEP` (101)
- `SYS_GETTIMEOFDAY` (169)、`SYS_TIMES` (153)
- `SYS_GETITIMER` (102)、`SYS_SETITIMER` (103)
- `SYS_TIMER_CREATE` (107)、`SYS_TIMER_SETTIME` (110)

**同步（1 个）**：
- `SYS_FUTEX` (98)：支持 WAIT/WAKE/WAIT_BITSET/WAKE_BITSET/REQUEUE/CMP_REQUEUE/WAKE_OP。

**其他（7 个）**：
- `SYS_UNAME` (160)、`SYS_SYSINFO` (179)、`SYS_GETRANDOM` (278)
- `SYS_SCHED_YIELD` (124)、`SYS_SCHED_SETAFFINITY` (122)、`SYS_SCHED_GETAFFINITY` (123)
- `SYS_PRLIMIT64` (261)

**返回固定值（stub）的系统调用**：
- `SYS_IOPRIOSET` (30)、调度器参数设置/获取（118-121）、`SYS_GET_MEMPOLICY` (236)、`SYS_MLOCK` (228)、`SYS_MADVISE` (233)、`SYS_SYNC` (81)、`SYS_FSYNC` (82)、`SYS_FDATASYNC` (83)、`SYS_SYNC_FILE_RANGE` (84)、`SYS_LOG` (116)

---

### 3.10 调度器 (`arch/riscv/sched.c`)

约 101 行，基于静态进程表的轮转调度。

```c
void scheduler(void) {
    struct proc *table = proc_table_base();
    while (1) {
        int found = 0;
        for (uint32_t i = 0; i < PROC_MAX_PROCS; i++) {
            struct proc *p = &table[i];
            if (p->state != PROC_READY) continue;
            found = 1;
            p->state = PROC_RUNNING;
            riscv_set_current_process(p);
            riscv_resume_kernel_context(&p->context, &scheduler_ctx);
            // 从进程返回后...
            riscv_set_current_process(0);
            if (p->state == PROC_RUNNING) p->state = PROC_READY;
            if (p->state == PROC_WAITING || p->state == PROC_ZOMBIE) continue;
            if (p->state != PROC_UNUSED) proc_destroy(p);
        }
        if (!found) return;
    }
}
```

**上下文切换**（`riscv_context_switch` in `trap_entry.S`）：
- 保存：`sp, ra, s0-s11` 共 13 个寄存器（`kernel_context` 结构）。
- 恢复：目标进程的 13 个寄存器 + `ret`。

**首次用户帧初始化**（`init_first_user_frame()`）：
- 清零所有 GPR。
- 设置 `sp = space->stack_top`、`tp = space->thread_pointer`。
- 设置 `sepc = space->entry`。
- `sstatus = SPIE | VS_DIRTY | FS_DIRTY | SUM`。

---

### 3.11 时钟与定时器 (`arch/riscv/timer.c`)

约 50 行，基于 SBI Timer 扩展。

- 定时器频率：10 MHz（`TIMER_HZ = 10000000`）。
- 中断间隔：1,000,000 周期 = 0.1 秒（`TIMER_INTERVAL`）。
- `timer_handle_interrupt()`：递增 `tick_count`，设置下次中断。
- `timer_usec()`：读取 RISC-V `time` CSR 并转换为微秒。

---

### 3.12 辅助模块

#### 内核打印 (`kernel/print.c`)

- `kputc()` → `platform_putc()`
- `kputs()`：输出以 NUL 结尾的字符串。
- `kputhex64()`：以 `0x` 前缀输出 64 位十六进制值。

#### 字符串操作 (`kernel/string.c`)

自实现的 `kmemcpy`、`kmemset`、`kmemcmp`、`kstrlen`、`kstrcmp`、`kstrncmp`，以及 `ksnprintf`（支持 `%s`、`%c`、`%d`、`%lu`、`%0lu`）。

#### 用户态访问 (`kernel/uaccess.c`)

所有函数标记为 `__attribute__((weak))`，由架构代码覆盖：
- RISC-V 版本通过 `user_addr_in_space()` 在用户页表中解析地址，转换为物理地址后直接访问。
- 未覆盖架构上所有函数返回 `false`/空操作。

---

## 4. LoongArch 架构状态

LoongArch 架构处于**骨架阶段**：

| 文件 | 状态 |
|------|------|
| `platform.c` | 完成（60 行）——UART、DMA、VirtIO 基址、ACPI GED 关机 |
| `entry.S` | 完成——栈初始化、跳转 kmain |
| `linker.ld` | 完成——基本段布局 |
| `timer.c` | 占位（最小实现） |
| `trap.c` | 占位——空 `scheduler()`、空 `fork_ret()`、空 `loongarch_trap_placeholder()` |
| `user.c` | 占位——函数返回 `false`，参数未使用 |

LoongArch 可以启动并输出到串口，但无用户态支持、无系统调用、无分页、无调度器。所有与用户态交互的代码路径在 LoongArch 上不可用。

---

## 5. 子系统交互分析

### 5.1 启动顺序依赖

```
kmain()
 ├─ riscv_kernel_trap_init()    # 必须先于任何用户态活动
 ├─ mm_init()                    # 所有后续模块依赖 kmalloc/page_alloc
 ├─ vfs_init()                   # 建立根文件系统骨架
 ├─ platform_paging_init()       # RISC-V 为空（页表在 user.c 中管理）
 ├─ virtio_blk_init()            # 探测块设备
 ├─ ext4_probe()                 # 读取超级块，验证 EXT4
 ├─ vfs_mount_root()             # 挂载 EXT4 到 /
 ├─ devfs_init()                 # 依赖 VFS，挂载 /dev
 ├─ mount_procfs()               # 依赖 VFS，挂载 /proc
 ├─ tmpfs_init()                 # 依赖 VFS，挂载 /tmp
 ├─ proc_system_init()           # 依赖 mm，初始化进程表
 ├─ timer_system_init()          # 启用时钟中断
 └─ ext4_run_test_scripts()      # 依赖以上所有子系统
```

### 5.2 关键跨模块交互

1. **系统调用 → VFS → 文件系统 → 块设备**：`sys_write(fd)` → `proc_fd_file(fd)` → `file->f_op->write()` → (若为 ext4) `ext4_file_read()` → `ext4_read_inode_range()` → `virtio_blk_read_sector()`。

2. **execve → ELF 加载器 → 用户地址空间 → 调度器**：`sys_execve()` → `elf_load_user_space()` → `user_space_build()` → 替换 `current_process->space` → 返回用户态时 `scheduler()` 调度。

3. **fork → 进程管理 → 地址空间复制**：`sys_clone()` → `proc_fork()` → `user_space_alloc_copy()` → 子进程 trap frame 初始化 → 返回 PID。

4. **信号投递**：调度器在 `usertrap_return` 前检查 `signal_pending`，若有信号则构造信号帧并修改 `sepc` 指向信号处理函数。

---

## 6. 整体实现完整度评估

以 Linux 内核对应功能为基准（100%），本项目的实现完整度估算如下：

| 子系统 | 完整度 | 依据 |
|--------|--------|------|
| 平台启动 | 90%（RV）/ 70%（LA） | RV 完整，LA 缺 trap/用户态 |
| 内存分配 | 50% | 无伙伴系统、slab、SMP 锁 |
| VFS 框架 | 60% | 核心结构完整，缺缓存/锁/权限 |
| EXT4（只读） | 45% | 支持 extent，缺写入/日志/深层树 |
| tmpfs | 70% | 基本读写完整，缺删除/时间戳 |
| devfs | 40% | 骨架+1个实际设备 |
| 管道 | 80% | 阻塞/非阻塞/信号中断均支持 |
| 控制台 | 30% | 仅 write，无 read/termios |
| VirtIO 块设备 | 50% | 仅读取+轮询，无中断/写入 |
| 进程管理 | 65% | fork/exec/exit/wait 完整，缺 rlimit/cgroup |
| ELF 加载器 | 85% | PIE/动态链接/shebang 支持 |
| 用户地址空间 | 70% | Sv39 完整，缺 COW/page cache |
| 系统调用 | 60% | ~70+ 个，socket 为 stub |
| 信号 | 65% | 基本框架完整 |
| Futex | 55% | 基本操作支持，PI/WAKE_OP 为 stub |
| 调度器 | 25% | 简单轮转，无优先级/SMP |
| 时钟 | 50% | 基本时间查询，无高精度 |
| 共享内存 (SysV) | 40% | 基本 shmget/shmat/shmdt/shmctl |

**总体估算：约 55-60% 的功能完整度**（以实用 OS 内核为基准），若以本项目自身目标（比赛评测通过）的 RISC-V 路径为基准，则约 **85-90%**。

---

## 7. 设计创新性分析

### 7.1 架构设计创新

1. **统一的 VFS 文件对象模型**：将 EXT4（磁盘）、tmpfs（内存）、devfs（设备）、procfs（信息）、pipe（IPC）、console（终端）全部统一到 `file_operations`/`inode_operations` 接口下。这是一个设计良好的抽象层，使得系统调用层无需区分底层文件系统类型。

2. **Trampoline 页面机制**：将用户态 trap 入口代码映射到固定高地址页面（`0x3ffffff000`），同时在用户和内核页表中可见。这是对 RISC-V Sv39 地址空间切换问题的精巧解决方案——在执行 `csrw satp` 和 `sfence.vma` 之间保持取指连续性。

3. **procfs 内联于 VFS**：procfs 作为 VFS 模块的内置功能而非独立文件系统，通过 `procfs_node` 模板和动态 PID 目录实现了灵活的 `/proc` 文件系统。这种设计减少了模块边界开销。

4. **基于目录项缓存的 EXT4 路径查找**：预扫描并缓存 8192 个目录项，后续路径查找无需再次访问磁盘。这是针对评测场景（文件系统内容固定）的有效优化。

5. **musl 动态加载器嵌入**：条件编译时可将 musl `libc.so` 嵌入内核镜像，在内存中创建 `/lib/ld-musl-riscv64.so.1` 文件，使动态链接的用户程序无需磁盘上的加载器文件。

### 7.2 工程实践创新

1. **测试脚本优先级排序**：EXT4 模块根据测试脚本名称分配优先级（basic → busybox → lua → ... → unixbench），确保关键测试先执行。

2. **Shebang 和脚本后缀自动处理**：`.sh` 文件自动使用 busybox sh 解释器，`#!` 行自动解析。这是对 POSIX 约定的正确实现。

3. **weak 符号架构适配**：`proc_current()`、`read_user8()` 等使用 `__attribute__((weak))`，允许架构无关代码在未实现架构上安全编译。

4. **单一 Makefile 双架构**：通过 `ARCH_RISCV`/`ARCH_LOONGARCH` 宏和条件编译，一个 Makefile 同时支持两个架构。

### 7.3 创新性局限

- 整体设计是 Linux 内核的简化克隆，VFS 接口、EXT4 布局、系统调用号等均直接参照 Linux。
- "创新"更多体现在工程适应性和精简取舍上，而非新算法或新架构范式。
- Socket 实现仅为 stub——所有网络调用返回成功但不执行实际网络 I/O。

---

## 8. 其他信息

### 8.1 代码统计

| 位置 | 行数 | 占比 |
|------|------|------|
| `arch/riscv/trap.c` | 7,068 | 31.1% |
| `arch/riscv/trapbk.c` | 6,799 | 29.9% |
| `kernel/vfs.c` | 1,815 | 8.0% |
| `kernel/ext4.c` | 1,275 | 5.6% |
| `arch/riscv/user.c` | 1,084 | 4.8% |
| `kernel/elf.c` | 755 | 3.3% |
| `kernel/proc.c` | 575 | 2.5% |
| `kernel/tmpfs.c` | 415 | 1.8% |
| `arch/riscv/trap_entry.S` | 345 | 1.5% |
| `kernel/devfs.c` | 332 | 1.5% |
| 其余 | 2,279 | 10.0% |
| **总计** | **22,743** | **100%** |

注：`trapbk.c`（6,799 行）是 `trap.c` 的备份/实验版本，其中约 6,500 行与 `trap.c` 重复。

### 8.2 已知限制（来自设计文档和代码审查）

1. **无 SMP 支持**：所有数据结构无锁保护，调度器单核轮转。
2. **EXT4 只读**：无法创建、修改或删除 EXT4 上的文件。
3. **Socket 为 stub**：所有网络操作返回成功但不传输数据。
4. **无设备树解析**：内存大小、设备地址硬编码。
5. **无中断驱动的块设备**：使用忙轮询等待 VirtIO 完成。
6. **LoongArch 用户态未实现**。
7. **无符号链接支持**。

### 8.3 备份文件

`arch/riscv/trapbk.c`（6,799 行）是 `trap.c` 的备份/实验副本。其系统调用实现使用了不同的编码风格（如 `fd_kind` 数组而非 `fd_table`），可能是早期版本的遗留。构建系统**不编译**此文件。

---

## 9. 总结

OSKernel2026 是一个面向 RISC-V QEMU virt 平台的 freestanding 教学/竞赛型操作系统内核。它在约 22,700 行 C 和汇编代码中实现了一个自包含的 UNIX-like 环境，包含：

- **完整的内核基础设施**：内存分配器、VFS 框架、进程管理、调度器、系统调用层。
- **只读 EXT4 文件系统**：支持 extents、目录遍历、文件读取。
- **内存文件系统**：tmpfs 提供 `/tmp`、devfs 提供 `/dev`、procfs 提供 `/proc`。
- **用户态支持**：ELF64 加载（含动态链接和 shebang）、Sv39 虚拟地址空间、信号处理、futex、管道。
- **约 70+ 个 Linux 兼容系统调用**，足以运行 busybox、shell 脚本等评测负载。

该项目展现了扎实的操作系统工程能力，特别是在 VFS 统一抽象、Sv39 页表管理、Trampoline 页面机制、ELF 加载和 shebang 处理等方面。LoongArch 架构处于早期骨架阶段，仅完成平台初始化和串口输出。关键短板包括：无 SMP、EXT4 只读、无网络协议栈、无 COW 页面共享。

在比赛评测的目标场景下，RISC-V 路径的实现完整度约为 **85-90%**，具备运行标准 busybox + 测试脚本的能力。作为教学/竞赛项目，其代码结构清晰、模块分层合理、注释和设计文档充分，是理解操作系统内核实现原理的良好参考。