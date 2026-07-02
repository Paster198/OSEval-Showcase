# OSKernel2026-X 深入技术分析报告

## 一、分析方法概述

本报告基于对仓库中约 2608 个源文件（1306 个 C 文件、1118 个头文件、140 个汇编文件、44 个 Rust 文件）的系统性源代码审查。分析方法包括：

1. **静态代码审查**：逐文件阅读核心子系统实现（内核核心、架构层、竞赛应用层、驱动层），理解每个函数的控制流与数据流。
2. **构建系统分析**：审查 Makefile、SConscript、rtconfig.py 和 rtconfig.h，理解构建流程、宏开关和编译选项。
3. **启动流程跟踪**：从 `_start` 汇编入口开始，追踪 `entry()` → `rtthread_startup()` → `main()` → `oskernel_real_run_tests()` 的完整调用链。
4. **跨层交互分析**：分析内核 trap 处理如何桥接到竞赛团队自定义的用户态 syscall 处理器，以及 EXT4 扫描器如何与 RT-Thread 设备驱动框架交互。
5. **配置与功能矩阵分析**：通过 `rtconfig.h` 和 `.config` 确认哪些 RT-Thread 子系统和组件被启用，哪些被禁用。

测试方面，由于环境限制，未进行 QEMU 实际运行测试，分析完全基于源代码审查。

---

## 二、项目概览

OSKernel2026-X 是基于 **RT-Thread 5.x（版本号 0x50200）** 的操作系统内核竞赛项目，面向操作系统设计赛内核实现赛道。目标平台为 QEMU RISC-V64 `virt` 机器，同时为 LoongArch64 提供初赛阶段最小入口（stub）。

**关键特征：**

| 特征 | 值 |
|---|---|
| 内核基线 | RT-Thread 5.x |
| 主要目标架构 | RISC-V64 (rv64imafdc, lp64, medany) |
| 次要目标架构 | LoongArch64 (stub) |
| 构建入口 | `make all` |
| 产物 | `kernel-rv` (RISC-V64 ELF), `kernel-la` (LoongArch64 ELF) |
| 配置模式 | UP (单核), 未启用 RT_USING_SMART |
| 内核代码总量 | 约 99,000+ 行（含 RT-Thread 完整组件树） |
| 竞赛自研代码 | 约 9,000 行（applications/ 目录） |

---

## 三、构建系统详细分析

### 3.1 构建入口（根 Makefile）

```makefile
# 关键路径设置
export RTT_ROOT := $(CURDIR)/rt-thread
export RTT_CC_PREFIX ?= riscv64-unknown-elf-
export PYTHONPATH := $(CURDIR)/tools/python:$(PYTHONPATH)

# RISC-V64 构建
$(SCONS) -C $(BSP)
cp $(BSP)/rtthread.elf kernel-rv

# LoongArch64 构建
$(LA_CC) -nostdlib -static -ffreestanding ... -o kernel-la \
    tools/loongarch_basic_stub.S tools/loongarch_basic_stub.c
```

根 Makefile 极简，仅做三件事：
1. 设置环境变量指向仓库内 RT-Thread 源码
2. 调用内置 SCons (Python 模块) 构建 RISC-V64 BSP
3. 使用 LoongArch GCC 编译 stub 为独立 ELF

### 3.2 SCons 构建层次

SCons 构建入口为 `machines/qemu-virt-riscv64/SConstruct`，它：

1. 读取 `rtconfig.py` → 设置工具链（riscv64-unknown-elf-gcc）
2. 调用 `PrepareBuilding()` → 递归收集 rt-thread/src/、libcpu/、components/ 的所有 SConscript
3. BSP 级 SConscript 收集 driver/ 和 applications/ 的源文件
4. 链接生成 `rtthread.elf`

### 3.3 编译选项

```python
DEVICE = '-mcmodel=medany -march=rv64imafdc -mabi=lp64'
CFLAGS = DEVICE + '-ffreestanding -fno-common -ffunction-sections -fdata-sections ...'
LFLAGS = DEVICE + '-nostartfiles -nostdlib -Wl,--gc-sections ... -T link.lds' + '-lgcc -static'
```

构建模式为 debug（`-O0 -ggdb`），链接脚本为 `link.lds`（位于 `machines/qemu-virt-riscv64/`），内核加载地址为 `0x80200000`。

---

## 四、启动流程详细分析

### 4.1 汇编入口 (`startup_gcc.S`)

```
_start (0x80200000):
  1. 保存 hartid 到 boot_hartid
  2. 清零 sie, sip
  3. 设置 stvec = trap_entry
  4. 清零所有通用寄存器
  5. 禁用 FPU (清除 SSTATUS_FS)
  6. 设置 SUM 位 (允许内核访问用户内存)
  7. 设置 gp = __global_pointer$
  8. 设置 sp = __stack_start__ + __STACKSIZE__
  9. 清零 sscratch
  10. 调用 init_bss (清零 BSS 段)
  11. 初始化早期 MMU 页表（若启用 ARCH_MM_MMU）
  12. 调用 sbi_init()
  13. 调用 primary_cpu_entry()
```

### 4.2 C 入口链

```
primary_cpu_entry()
  → rt_hw_interrupt_disable()
  → entry()                               # components.c
    → rtthread_startup()                  # components.c
      → rt_hw_board_init()                # board.c
        → rt_system_heap_init()           # 堆初始化
        → plic_init()                     # PLIC 中断控制器
        → rt_hw_interrupt_init()          # 中断描述符表
        → rt_hw_uart_init()               # NS16550 UART
        → rt_console_set_device("uart0")
        → rt_hw_tick_init()               # 时钟节拍
        → rt_components_board_init()      # 板级组件自动初始化
      → rt_show_version()
      → rt_system_timer_init()
      → rt_system_scheduler_init()
      → rt_application_init()             # 创建 main 线程
      → rt_system_timer_thread_init()
      → rt_thread_idle_init()
      → rt_thread_defunct_init()
      → rt_system_scheduler_start()       # 永不返回

main 线程:
  main_thread_entry()
    → rt_components_init()                # 组件自动初始化
    → main()                              # applications/main.c
      → start_shutdown_watchdog()         # 600 秒看门狗
      → oskernel_real_run_tests()         # 测试运行器主循环
      → qemu_virt_poweroff()
```

### 4.3 QEMU 关机机制

`main.c` 实现了一个四层 fallback 关机策略：
1. SBI SRST 扩展 (cold reboot / warm reboot / shutdown)
2. SBI legacy shutdown
3. Finisher 寄存器写入 (`0x100000` 写入 `0x5555`)
4. 所有方法在 while(1) 循环中依次尝试，确保 QEMU 必定退出

---

## 五、子系统详细拆解

### 5.1 内核核心（RT-Thread Kernel Core）

#### 5.1.1 线程管理 (`thread.c`, 1223 行)

实现了完整的 RT-Thread 线程模型：

- **线程结构体** `struct rt_thread`：继承自 `rt_object`，包含栈指针、入口函数、优先级、时间片、状态、链表节点等
- **核心操作**：
  - `rt_thread_create()` / `rt_thread_init()`：创建/初始化线程，分配栈空间
  - `rt_thread_startup()`：将线程插入调度队列
  - `rt_thread_delete()` / `rt_thread_detach()`：删除/分离线程
  - `rt_thread_suspend()` / `rt_thread_resume()`：挂起/恢复线程
  - `rt_thread_yield()`：主动让出 CPU
  - `rt_thread_delay()` / `rt_thread_mdelay()`：延时等待
  - `rt_thread_control()`：线程控制接口
- **线程状态机**：INIT → READY → RUNNING → SUSPEND/CLOSE
- **线程退出处理** `_thread_exit()`：清理持有的互斥锁、从等待队列移除、加入 defunct 列表
- **互斥锁嵌套**：线程持有的互斥锁记录在 `taken_object_list` 链表中，退出时自动释放

#### 5.1.2 调度器

当前配置为 UP 模式，使用 `scheduler_up.c`（730 行）。

**就绪队列结构：**
```c
rt_list_t rt_thread_priority_table[RT_THREAD_PRIORITY_MAX];  // 每优先级一个链表
rt_uint32_t rt_thread_ready_priority_group;                   // 32-bit 位图
```

**调度算法：**
- 基于优先级的抢占式调度（32 个优先级，RT_THREAD_PRIORITY_MAX=32）
- 同优先级线程时间片轮转
- 使用 `__rt_ffs()` 位扫描指令查找最高就绪优先级

**关键函数：**
- `_scheduler_get_highest_priority_thread()`：使用位图查找最高优先级就绪线程
- `rt_schedule_insert_thread()`：将线程插入就绪队列
- `rt_schedule_remove_thread()`：从就绪队列移除线程
- `rt_schedule()`：触发调度器，执行上下文切换
- `rt_enter_critical()` / `rt_exit_critical()`：临界区保护

调度器锁实现使用原子操作 `rt_atomic_t rt_scheduler_lock_nest`，支持嵌套锁定。

#### 5.1.3 IPC 机制 (`ipc.c`, 4040 行)

这是内核中最大的单个文件，实现了完整的线程间通信机制：

| IPC 对象 | 关键操作 | 特点 |
|---|---|---|
| **信号量 (semaphore)** | `rt_sem_init/create/take/release/trytake` | 计数信号量，支持 FIFO/PRIO 等待 |
| **互斥锁 (mutex)** | `rt_mutex_init/create/take/release/trytake` | 优先级继承/优先级天花板协议，嵌套锁 |
| **事件 (event)** | `rt_event_init/create/send/recv` | 多事件标志位，支持 AND/OR 触发，可选清除 |
| **邮箱 (mailbox)** | `rt_mb_init/create/send/recv/send_wait/urgent` | 固定大小消息（支持 64-bit），紧急消息优先 |
| **消息队列 (messagequeue)** | `rt_mq_init/create/send/recv/send_wait/urgent` | 可变长度消息，支持紧急消息 |

**IPC 等待机制：**
- 统一的 `rt_ipc_object_suspend()` / `rt_ipc_object_resume()`
- 等待线程按优先级排列或 FIFO
- 支持带超时的等待

**优先级继承**：互斥锁支持完整的优先级继承协议，在 `mutex->owner->priority` 和 `mutex->original_priority` 之间管理。

#### 5.1.4 内存管理

RT-Thread 提供多种内存分配策略：

| 分配器 | 文件 | 大小 | 特点 |
|---|---|---|---|
| **小内存管理器** | `mem.c` (667 行) | 基于 lwIP mem 算法 | 空闲块链表，适合资源受限场景 |
| **内存堆** | `memheap.c` (998 行) | 多堆管理 | 支持多个不连续堆区域 |
| **内存池** | `mempool.c` (412 行) | 固定大小块 | 快速分配/释放，无碎片 |
| **SLAB 分配器** | `slab.c` (856 行) | 类 Solaris slab | 当前配置为堆后端 (`RT_USING_SLAB_AS_HEAP`) |

当前配置使用 SLAB 作为内核堆分配器，配置了 `RT_USING_SLAB_AS_HEAP` 和 `RT_USING_MEMTRACE`。

#### 5.1.5 定时器与时钟

**软件定时器** (`timer.c`, 871 行)：
- 使用内核系统节拍（tick）为时基
- 支持单次和周期模式
- 定时器线程优先级 = 4，栈大小 = 16384
- 通过 `rt_timer_start/stop/control` 管理

**系统时钟** (`clock.c`, 261 行)：
- `RT_TICK_PER_SECOND = 100`（10ms 一个节拍）
- `rt_tick_get()` 返回系统启动以来的节拍数
- `rt_tick_from_millisecond()` 进行毫秒到节拍的转换

**硬件定时器** (`tick.c`, 76 行)：
- 使用 RISC-V `mtime`/`mtimecmp` 寄存器
- 通过 SBI `sbi_set_timer()` 设置下一个定时器中断
- CPUTIME_TIMER_FREQ = 10000000 (10MHz)

#### 5.1.6 信号 (`signal.c`, 683 行)

实现了 POSIX 风格的线程间信号：
- `rt_thread_kill()`：向线程发送信号
- 信号安装：`rt_signal_install()`
- 信号屏蔽：`rt_signal_mask()`
- 信号等待：`rt_signal_wait()`
- 默认处理：终止线程（部分信号）

#### 5.1.7 对象管理 (`object.c`, 814 行)

内核对象容器系统：
- 所有内核对象（线程、IPC、定时器、设备等）继承自 `rt_object`
- 按类型分类管理，每种类型维护一个对象链表
- `rt_object_find()` 按名称查找对象
- 对象创建时自动分配名称（如 "thread", "sem", "mutex" 等前缀 + 序号）

#### 5.1.8 空闲线程 (`idle.c`, 215 行)

- 优先级最低（31），栈大小 = 16384
- 执行 `rt_thread_idle_excute()`：
  - 调用 idle hook 列表中的函数
  - 调用 `rt_defunct_execute()` 回收僵死线程资源

#### 5.1.9 组件自动初始化 (`components.c`, 286 行)

基于链接器 section 的自动初始化框架：
```c
// 初始化分为多个级别，通过链接器排序
__rt_init_rti_board_start ... __rt_init_rti_board_end    // 板级初始化
__rt_init_rti_board_end  ... __rt_init_rti_end            // 组件初始化
```
通过 `INIT_BOARD_EXPORT()`, `INIT_COMPONENT_EXPORT()` 等宏注册初始化函数。

### 5.2 RISC-V64 架构层

#### 5.2.1 Trap 处理

**汇编入口** (`common64/interrupt_gcc.S`)：
```asm
trap_entry:
    csrrw   sp, sscratch, sp       # 区分内核/用户 trap
    bnez    sp, _save_context      # sscratch != 0 表示来自用户态
_from_kernel:
    csrr    sp, sscratch
_save_context:
    SAVE_ALL                        # 保存全部寄存器到栈帧
    csrw    sscratch, zero          # 标记为"正在内核态"
    RESTORE_SYS_GP
    # 区分系统调用和中断
    call    handle_trap             # C 处理函数
```

**C 处理函数** (`common64/trap.c`, `handle_trap()`)：
```c
void handle_trap(rt_ubase_t scause, rt_ubase_t stval, rt_ubase_t sepc,
                 struct rt_hw_stack_frame *sp)
{
    // 1. 检查 SCAUSE：外部中断 → plic_handle_irq()
    // 2. 定时器中断 → tick_isr()
    // 3. 用户态 ecall → os_user_ecall_handle(sp)  [弱引用，由竞赛代码重写]
    // 4. 用户态异常 → os_user_fault_handle()       [弱引用，由竞赛代码重写]
}
```

**关键设计点**：内核通过 `rt_weak` 声明了两个钩子函数 `os_user_ecall_handle()` 和 `os_user_fault_handle()`，竞赛团队在 `os_user_exec.c` 中用自己的实现覆盖了它们。这是一个优雅的解耦设计——内核不需要知道用户态 syscall 的具体实现。

#### 5.2.2 上下文切换 (`common64/context_gcc.S`)

实现了 RISC-V 标准的上下文保存/恢复：

```asm
RESERVE_CONTEXT:          # 保存 s0-s11, ra, tp, sstatus
RESTORE_CONTEXT:          # 恢复上述寄存器 + sret

rt_hw_context_switch:     # 线程切换
    RESERVE_CONTEXT
    STORE sp, (a0)        # 保存 from 线程栈指针
    LOAD  sp, (a1)        # 加载 to 线程栈指针
    RESTORE_CONTEXT
    sret
```

栈帧结构由 `stackframe.h` 定义，按寄存器索引排列。

#### 5.2.3 MMU / 页表 (`common64/mmu.c`, 994 行)

实现了 SV39 页表管理：

- `rt_hw_aspace_switch()`：切换地址空间，写入 satp CSR
- `rt_hw_mmu_map_init()`：初始化内核地址空间
- `rt_hw_mmu_setup()`：建立内核映射
- 支持 ASID（地址空间标识符）管理（`common64/asid.c`）
- 支持 TLB 刷新操作
- 内核重映射支持（`ARCH_REMAP_KERNEL`）

**页表结构**：
```c
volatile rt_ubase_t MMUTable[512 * RT_CPUS_NR];  // 每核 4KB 对齐
```

#### 5.2.4 PLIC 中断控制器 (`virt64/plic.c`, 156 行)

完整的 PLIC 驱动：

- `plic_init()`：设置阈值、优先级、使能中断
- `plic_set_priority()`：设置中断源优先级（7 级）
- `plic_irq_enable/disable()`：使能/禁用特定中断源
- `plic_claim()`：读取 claim 寄存器，获取待处理中断 ID
- `plic_complete()`：写入 complete 寄存器，通知中断处理完毕
- `plic_handle_irq()`：claim → 调用 ISR → complete 的标准流程

#### 5.2.5 SBI 封装 (`common64/sbi.c`, 264 行)

完整的 OpenSBI/RustSBI 兼容层：

- 自动检测 SBI 规范版本（legacy 0.1 vs 0.2+）
- 检测 SBI 实现（OpenSBI, RustSBI, BBL, KVM, Diosix）
- 探测扩展（TIME, IPI, RFENCE, HSM）
- 封装 `sbi_set_timer()`, `sbi_send_ipi()`, `sbi_remote_fence_i()`, `sbi_hsm_hart_start()` 等
- 向后兼容 legacy SBI

### 5.3 BSP 与驱动层

#### 5.3.1 板级初始化 (`board.c`)

```c
void rt_hw_board_init(void) {
    rt_system_heap_init(RT_HW_HEAP_BEGIN, RT_HW_HEAP_END);
    plic_init();
    rt_hw_interrupt_init();
    rt_hw_uart_init();
    rt_console_set_device("uart0");
    rt_hw_tick_init();
    rt_components_board_init();
}
```

#### 5.3.2 NS16550 UART 驱动 (`drv_uart.c`)

- 基于 MMIO，基址 `0x10000000`（QEMU virt 平台）
- 配置为 115200 波特率、8 位数据位、无校验
- 实现 RT-Thread serial 设备框架接口：
  - `_uart_configure()`：串口配置
  - `_uart_control()`：控制命令
  - `_uart_putc()` / `_uart_getc()`：字符收发
- 默认参考时钟 = 11.0592 MHz

#### 5.3.3 VirtIO 驱动 (`drv_virtio.c`, `drv_virtio.h`)

完整的 VirtIO MMIO 传输层：

```c
static virtio_device_init_handler virtio_device_init_handlers[] = {
    [VIRTIO_DEVICE_ID_BLOCK]   = rt_virtio_blk_init,    // virtio-blk
    [VIRTIO_DEVICE_ID_NET]     = rt_virtio_net_init,    // virtio-net
    [VIRTIO_DEVICE_ID_CONSOLE] = rt_virtio_console_init,
    [VIRTIO_DEVICE_ID_GPU]     = rt_virtio_gpu_init,
    [VIRTIO_DEVICE_ID_INPUT]   = rt_virtio_input_init,
};
```

- 扫描 MMIO 区域（基址 `0x10001000`，最多 8 个设备，从 IRQ 1 开始分配）
- 自动识别 VirtIO 设备 ID 并调用对应的 init handler
- 支持 VirtIO 1.0 现代接口

### 5.4 竞赛应用层（核心创新部分）

这是团队自研的核心，约 8,961 行代码，实现了一个完整的"OS on OS"用户态执行框架。

#### 5.4.1 EXT4 只读扫描器 (`judge_ext4_scan.c`, 883 行)

**设计目标**：在无 OS 文件系统栈的情况下，直接从裸 virtio-blk 设备读取 EXT4 文件。

**核心数据结构**：
```c
struct ext4_layout {
    rt_uint32_t block_size;        // 1024 << log2(block_size)
    rt_uint32_t inodes_per_group;
    rt_uint32_t inode_size;        // 通常 256 字节
    rt_uint32_t desc_size;         // 组描述符大小
    rt_uint64_t gdt_offset;        // GDT 偏移
};

struct ext4_cached_file {
    int used;
    char directory[96];
    char path[128];
    void *data;
    rt_size_t size;
    rt_uint64_t total_size;
};
```

**实现的功能**：
- **Superblock 解析**：从偏移 1024 读取 superblock，验证 EXT4 magic (`0xef53`)，提取块大小、每组的 inode 数、inode 大小等
- **Inode 读取**：通过 block group descriptor 定位 inode table，计算偏移并读取
- **Extent Tree 遍历**：支持 EXT4 extent tree（`EXT4_EXTENTS_FL`），递归遍历 extent 节点和叶子节点
- **Legacy 间接块遍历**：也支持传统的间接块映射
- **目录遍历**：扫描目录块中的 `ext4_dir_entry_2` 结构，按名称查找
- **路径解析**：多级目录查找（如 `glibc/basic_testcode.sh`）
- **文件读取**：按 extent/block 映射读取文件数据，支持限制读取大小
- **文件缓存**：最多缓存 96 个已读取文件，避免重复磁盘 I/O

**读取粒度**：
- 使用 512 字节扇区对齐的 `read_bytes()` 函数
- 通过 `rt_device_read(dev, sector_offset, buffer, 1)` 逐扇区读取
- 自动处理跨扇区字节级别的读取

#### 5.4.2 ELF 加载器 (`os_elf_loader.c`, 330 行)

**支持的 ELF 格式**：
- ELFCLASS64（64 位）
- ELFDATA2LSB（小端）
- ET_EXEC 和 ET_DYN 类型
- EM_RISCV (243), EM_LOONGARCH (258)
- PT_LOAD, PT_DYNAMIC, PT_INTERP 程序头

**加载流程**：
```c
os_elf_load_from_ext4():
  1. 读取 ELF header (64 字节)
  2. 验证魔数、class、端序、类型、机器码
  3. parse_phdrs(): 读取 program header table
     - 识别 PT_LOAD 段：记录 vaddr, memsz, filesz, offset, flags
     - 识别 PT_DYNAMIC：记录 dynamic_vaddr, dynamic_size
     - 识别 PT_INTERP：读取解释器路径
  4. load_segment_data(): 逐段读取文件数据到内存
  5. 最多支持 8 个 LOAD 段 (OS_ELF_MAX_SEGMENTS)
```

**内存管理**：为每个 LOAD 段分配独立的内存块（最大 16MB/段），通过 `rt_malloc()` 在堆上分配。

#### 5.4.3 用户镜像管理器 (`os_user_image.c`, 165 行)

将 ELF 加载结果转换为可映射的用户镜像：

```c
struct os_user_image {
    rt_uint64_t entry;                              // 入口地址
    rt_uint64_t aux_entry, aux_base;                // AT 辅助向量
    rt_uint64_t phdr, phent, phnum;                 // Program header 信息
    rt_uint64_t low_vaddr, high_vaddr;              // 虚拟地址范围
    rt_uint32_t mapping_count;
    struct os_user_mapping mappings[OS_USER_IMAGE_MAX_MAPPINGS];
};
```

- `os_user_image_build()`：从 ELF image 构建映射描述
  - 按 page (4096) 对齐各 LOAD 段
  - 为 BSS 段（memsz > filesz）填充零
  - 计算 program header 在虚拟地址空间中的位置
- `os_user_image_destroy()`：释放映射内存

#### 5.4.4 用户态执行与 Syscall 处理 (`os_user_exec.c`, 4581 行)

这是整个项目中最复杂、最核心的模块，实现了一个**轻量级用户态进程执行环境**。

**A. SV39 页表管理**

```c
// 三级页表结构
static rt_uint32_t sv39_index(rt_uint64_t va, unsigned int shift);
// VPN[2] (30:38) → L1 → VPN[1] (21:29) → L0 → VPN[0] (12:20) → PTE

// PTE 格式
static rt_uint64_t sv39_pte(rt_uint64_t pa, rt_uint64_t flags);
// PTE = (pa >> 12) << 10 | flags
// flags: PTE_V(1), PTE_R(2), PTE_W(4), PTE_X(8), PTE_U(16),
//        PTE_G(32), PTE_A(64), PTE_D(128)
```

**核心操作**：
- `alloc_aligned_page()`：分配 4KB 对齐的物理页（通过 2*PAGE_SIZE 分配确保对齐）
- `ensure_next_table()`：按需创建下一级页表
- `map_page()`：4KB 页映射（创建三级页表结构）
- `walk_leaf_pte()`：遍历页表找叶子 PTE
- `map_range_identity()`：恒等映射地址范围
- `map_kernel_1g_leaf()`：1GB 大页映射（用于内核代码段 `0x80000000`）

**B. 用户态进入与退出**

```c
// 进入用户态
enter_user_mode(entry, user_sp, kernel_sp):
    1. csrw sscratch, kernel_sp    # 保存内核栈指针
    2. 设置 sstatus: SPP=0 (用户态), SUM=1 (允许访问用户内存)
    3. csrw sepc, entry
    4. mv sp, user_sp
    5. sret                          # 跳转到用户态

// 返回内核态
return_to_runner():
    1. 通知非本地退出
    2. csrw satp, zero              # 切换到裸机模式
    3. sfence.vma
    4. restore_runner_context()     # 恢复运行器上下文
```

**上下文保存/恢复**：通过 `save_runner_context()` / `restore_runner_context()` 使用裸函数（`__attribute__((naked))`）保存和恢复所有 callee-saved 寄存器，实现了类似 `setjmp/longjmp` 的机制。

**C. Syscall 处理（约 80+ 个 syscall）**

```c
int os_user_ecall_handle(struct rt_hw_stack_frame *sp) {
    syscall_id = sp->a7;  // a7 寄存器传递 syscall 号
    switch (syscall_id) {
        case SYS_READ:        // 63
        case SYS_WRITE:       // 64
        case SYS_OPENAT:      // 56
        case SYS_CLOSE:       // 57
        case SYS_EXIT:        // 93
        case SYS_EXIT_GROUP:  // 94
        case SYS_MMAP:        // 222
        case SYS_BRK:         // 214
        case SYS_CLONE:       // 220
        case SYS_EXECVE:      // 221
        case SYS_WAIT4:       // 260
        // ... 等总计约 80 个
    }
}
```

**实现的 syscall 详细说明**：

| 类别 | Syscall | 实现程度 |
|---|---|---|
| **文件 I/O** | read, write, readv, writev, pread64, pwrite64, lseek, sendfile | 完整实现，基于 mem_file 和 EXT4 |
| **文件管理** | openat, close, dup, dup3, fcntl, ioctl, mkdirat, unlinkat, renameat, faccessat, chdir, getcwd | 完整实现 |
| **文件状态** | fstat, newfstatat, statfs, fstatfs, statx, readlinkat | 完整实现 |
| **文件截断** | truncate, ftruncate, fallocate | 完整实现 |
| **目录** | getdents64 | 完整实现 |
| **内存管理** | mmap, brk, munmap, mprotect, msync, madvise | mmap/brk 完整，其他返回 0 |
| **进程管理** | exit, exit_group, clone, execve, wait4 | 完整实现（含 fork snapshot） |
| **时间** | nanosleep, clock_gettime, clock_getres, clock_nanosleep, gettimeofday, times | 完整实现（使用虚拟时间） |
| **系统信息** | uname, sysinfo, getpid, getppid, gettid, getuid, geteuid, getgid, getegid | 完整实现 |
| **资源限制** | getrlimit, setrlimit, prlimit64, getrusage | 完整实现 |
| **信号** | kill, tkill, tgkill, rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigtimedwait, rt_sigqueueinfo, rt_sigreturn, sigaltstack | 部分实现（信号屏蔽位管理，实际不发送信号） |
| **Socket** | socket, bind, listen, accept, connect, sendto, recvfrom, setsockopt, getsockname | 模拟实现（单字节缓冲区） |
| **其他** | umask, prctl, getcpu, getrandom, membarrier, sched_yield, sched_getaffinity, sched_setaffinity | 大部分返回 0 或固定值 |
| **挂载** | mount, umount2 | 返回 0（无需操作） |

**D. 虚拟文件系统（内存文件）**

在用户态执行环境中实现了一个简化的 in-memory 文件系统：

```c
struct os_mem_file {
    int used, removed, is_dir;
    char path[OS_PATH_MAX];
    rt_uint8_t *data;           // 动态分配
    rt_size_t size, capacity;
    rt_int64_t atime_sec, atime_nsec, mtime_sec, mtime_nsec;
};
```

- 最多 128 个文件 (`OS_MAX_MEM_FILES`)
- 自动从 EXT4 加载文件到内存
- 支持目录创建、文件写入（`ensure_mem_capacity` 扩容）
- 支持 unlink（标记 removed）和后续 re-create
- 伪文件自动生成：`proc/mounts`, `proc/meminfo`, `proc/version`, `proc/self/maps`, `proc/self/stat`, `dev/null`

**E. 文件描述符系统**

```c
struct os_fd {
    int type;        // OS_FD_FREE, CONSOLE, EXT4_FILE, MEM_FILE, DIR, PIPE_*, ZERO, SOCKET
    int flags;       // O_APPEND, O_NONBLOCK, FD_CLOEXEC, O_DIRECTORY
    int mem_index;   // 关联的 mem_file 或 pipe 索引
    int peer_fd;     // pipe 的对端 fd
    rt_size_t offset;
    rt_uint64_t size;
    struct judge_ext4_file file;
    char path[128];
};
```

- 默认 fd 0 = `/dev/null`, fd 1/2 = CONSOLE
- `pipe2` 实现：分配一对 fd，共享一个 `os_pipe` 结构体（2048 字节环形缓冲区）
- `dup/dup3`：复制 fd 条目

**F. Clone/Fork 机制**

```c
syscall_clone():
  1. fork_snapshot_begin(): 快照所有用户页面的当前状态
  2. 分配子进程栈（clone_stack_next 向下增长）
  3. 复制父进程栈内容到子进程栈
  4. 保存当前帧到 g_saved_parent_frame
  5. 设置子进程 PID
  6. 修改 sp 帧中的 a0 = 0（子进程返回 0）
  7. 子进程返回后设置 g_emulated_child_active = 0
```

这是一个高度简化的 fork/clone 实现：
- 使用页面快照（CoW 的简化替代方案）
- 子进程退出时恢复父进程的页面快照
- 不支持多级 clone（`g_emulated_child_active` 防止嵌套）

**G. Execve 机制**

```c
request_execve_from_user():
  1. 从用户空间复制路径
  2. normalize_path_to() 规范化路径
  3. 复制 argv 列表
  4. 设置 g_exec_requested = 1
  5. 返回 OS_USER_EXEC_STATUS_EXECVE 给 runner

// runner 在 os_test_runner.c 中处理：
if (status == OS_USER_EXEC_STATUS_EXECVE) {
    os_user_exec_take_execve_request(exec_path, ...);
    // 递归调用 inspect_elf_candidate_depth_args() 加载新程序
}
```

execve 不实际替换当前进程的地址空间，而是通过返回特殊状态码让 runner 重新加载新的 ELF。最大递归深度 = 4。

**H. Syscall 预算**

```c
#define OS_SYSCALL_BUDGET 20000
g_user_syscall_budget = OS_SYSCALL_BUDGET;
// 每次 syscall 递减，耗尽则终止用户程序
```

防止用户程序死循环或恶意消耗资源。

#### 5.4.5 测试运行器 (`os_test_runner.c`, 2760 行)

**运行模式**：

| 模式 | 触发脚本 | 行为 |
|---|---|---|
| `RUN_MODE_PREVIEW` | 默认 | 仅 dump ELF 信息，不实际执行 |
| `RUN_MODE_SMOKE` | `oskernel_user_smoke.sh` | 执行 smoke 测试 |
| `RUN_MODE_BASIC` | `basic_testcode.sh` | 执行 basic 测试，每 ABI 限制 48 次 |
| `RUN_MODE_LUA` | `lua_testcode.sh` | 执行 Lua 测试 |
| `RUN_MODE_EXEC` | `libcbench_testcode.sh`, `iozone_testcode.sh` | 直接执行 ELF |
| `RUN_MODE_BUSYBOX` | `busybox_testcode.sh` | busybox 命令执行，带管道支持 |

**脚本解析能力**：
- 跳过包装器命令：`env`, `timeout`, `time`, `nice`, `taskset`, `chrt`
- 识别 shell 元字符并跳过复杂 shell 构造
- 提取可执行文件路径和参数
- 支持重定向检测：`>`, `>>`, `<`, `|`
- 支持 BusyBox 管道（最多 2048 字节缓冲区）
- 支持 `echo` 和 `cd` 命令处理
- 递归解析脚本深度限制 = 4

**libctest 支持**：
- 解析 libctest 测试用例列表
- 自动构建测试用例路径（支持多种命名约定）
- 每个测试用例单独 exec 执行
- 限制每 ABI 128 个测试用例

**ABI 探测顺序**：`glibc` → `musl`，逐个 ABI 执行同类测试。

### 5.5 LoongArch64 最小入口 (`tools/`)

#### 5.5.1 汇编入口 (`loongarch_basic_stub.S`, 5KB)

```asm
_start:
    la.local $sp, stack_top
    bl       loongarch_basic_main
    bl       loongarch_poweroff

loongarch_enter_user:          # 保存 callee-saved 寄存器，跳转到用户程序
loongarch_user_after_exit:     # 恢复 callee-saved 寄存器，返回
loongarch_trap_entry:          # 基本 trap 处理
```

#### 5.5.2 C 实现 (`loongarch_basic_stub.c`, 144KB)

这是一个完全自包含的 freestanding 实现（不依赖 RT-Thread），包括：

- **UART 驱动**：直接操作 LA UART 基址 `0x1fe001e0`
- **PCI 配置空间扫描**：在 `0x20000000` 扫描 PCI 设备
- **VirtIO MMIO 驱动**：直接操作 VirtIO 寄存器
  - 传统 VirtIO 接口和现代 VirtIO 接口双支持
  - VirtIO block 设备队列管理（256 条描述符）
- **EXT4 解析器**：与 RISC-V 版本类似的只读扫描逻辑
- **ELF 加载器**：支持 EM_RISCV (243) 和 EM_LOONGARCH (258)
- **用户态执行**：syscall 处理（约 60+ 个 syscall）
- **测试执行**：basic、busybox、libctest 测试框架
- **QEMU 关机**：多种关机方法（SBI、finisher、PCI）

LoongArch64 stub 当前状态：**功能较完整但仍在开发中**。它独立于 RT-Thread，作为一个最小化证明-of-concept 实现。

### 5.6 RT-Thread 组件层

#### 5.6.1 设备虚拟文件系统 (DFS)

当前配置启用：
- `RT_USING_DFS_V2`：DFS v2 框架
- `RT_USING_DFS_ELMFAT`：FatFs 文件系统
- `RT_USING_DFS_DEVFS`：设备文件系统
- `RT_USING_DFS_ROMFS`：ROM 文件系统
- `DFS_USING_POSIX`：POSIX 文件接口
- `DFS_FD_MAX = 32`

但实际上，竞赛代码**绕过了 DFS 框架**，直接通过 `rt_device_find("virtio-blk0")` + `rt_device_read()` 读取磁盘，并且自己实现了一套 in-memory 文件系统。

#### 5.6.2 Finsh Shell

- `RT_USING_FINSH` + `FINSH_USING_MSH`
- 支持命令历史（10 行）
- 支持符号表
- 支持 Tab 补全
- 优先级 20，栈 16384

#### 5.6.3 网络栈 (lwIP + SAL)

- lwIP 2.0.3，使用 SAL 套接字抽象层
- 配置静态 IP (`192.168.1.30`)
- 支持 TCP、UDP、RAW
- 支持 DHCP、DNS、ICMP、IGMP
- 通过 virtio-net 驱动与 QEMU 通信

#### 5.6.4 POSIX 兼容层

启用组件：
- `RT_USING_POSIX_FS`、`RT_USING_POSIX_DEVIO`、`RT_USING_POSIX_STDIO`
- `RT_USING_POSIX_POLL`、`RT_USING_POSIX_SELECT`
- `RT_USING_POSIX_TERMIOS`、`RT_USING_POSIX_AIO`
- `RT_USING_POSIX_DELAY`、`RT_USING_POSIX_CLOCK`、`RT_USING_POSIX_TIMER`
- `RT_USING_POSIX_PIPE`

#### 5.6.5 Rust 支持 (`components/rust/`)

包含 Rust 内核模块框架：
- `core/`：Rust core 库集成
- `rt_macros/`：Rust 过程宏
- `examples/`：Rust 内核模块示例

---

## 六、子系统间的交互关系

### 6.1 启动与初始化交互

```
汇编启动(startup_gcc.S)
  → board.c: primary_cpu_entry()
    → components.c: entry() → rtthread_startup()
      → board.c: rt_hw_board_init()       [初始化硬件]
      → components.c: rt_application_init()  [创建 main 线程]
      → scheduler_up.c: rt_system_scheduler_start()  [启动调度]
```

### 6.2 Trap 处理交互

```
硬件 trap
  → interrupt_gcc.S: trap_entry          [保存上下文]
    → trap.c: handle_trap()              [分发]
      → plic.c: plic_handle_irq()        [外部中断]
      → tick.c: tick_isr()               [定时器中断]
      → os_user_exec.c: os_user_ecall_handle()  [用户态 syscall]
      → os_user_exec.c: os_user_fault_handle()  [用户态异常]
```

### 6.3 测试执行交互

```
main.c: oskernel_real_run_tests()
  → judge_ext4_scan.c: judge_ext4_has_script()    [检查脚本存在]
  → os_test_runner.c: inspect_one_script()         [解析脚本]
    → os_elf_loader.c: os_elf_load_from_ext4()     [加载 ELF]
    → os_user_image.c: os_user_image_build()       [构建用户镜像]
    → os_user_exec.c: os_user_exec_run_smoke_at_args()  [执行用户程序]
      → map_user_image()                           [建立 SV39 页表]
      → switch_to_page_table()                     [切换地址空间]
      → enter_user_mode()                          [进入 U-mode]
        → [用户程序运行, ecall]
          → os_user_ecall_handle()                 [处理 syscall]
            → syscall_write/read/open/...          [各 syscall 实现]
            → return_to_runner()                   [返回 kernel]
```

### 6.4 设备访问层次

```
竞赛应用层:
  judge_ext4_scan.c → rt_device_find("virtio-blk0") → rt_device_read()

RT-Thread 设备框架:
  rt_device_read() → virtio_blk device → drv_virtio.c

VirtIO 传输层:
  drv_virtio.c → MMIO 寄存器操作 → QEMU VirtIO 设备
```

### 6.5 内核与竞赛代码的弱引用接口

```c
// trap.c (RT-Thread 内核)
rt_weak int os_user_ecall_handle(struct rt_hw_stack_frame *sp) { return 0; }
rt_weak int os_user_fault_handle(long scause, ...) { return 0; }

// os_user_exec.c (竞赛代码 - 覆盖弱引用)
int os_user_ecall_handle(struct rt_hw_stack_frame *sp) { ... }
int os_user_fault_handle(long scause, ...) { ... }
```

---

## 七、各子系统实现完整度评估

### 7.1 评估基准定义

以下完整度基于以下基准：
- **100%**：功能完整，涵盖该子系统的所有标准操作，边界条件处理充分
- **75%**：核心功能完整，部分边界条件或高级功能未实现
- **50%**：基础功能存在，但不完整
- **25%**：仅存骨架代码或 stub

### 7.2 评估结果

| 子系统 | 完整度 | 说明 |
|---|---|---|
| **RT-Thread 线程管理** | 95% | 完整的 create/delete/startup/suspend/resume/yield/delay/control，含互斥锁嵌套处理 |
| **RT-Thread 调度器 (UP)** | 90% | 完整的优先级抢占式调度 + 时间片轮转，位图加速，临界区保护 |
| **RT-Thread IPC** | 95% | 信号量/互斥锁/事件/邮箱/消息队列全功能，含优先级继承 |
| **RT-Thread 内存管理** | 90% | SLAB + memheap + mempool 三套分配器，当前以 SLAB 为堆后端 |
| **RT-Thread 定时器** | 90% | 完整的软件定时器框架，单次/周期模式 |
| **RT-Thread 信号** | 85% | 完整的信号安装/屏蔽/等待/发送 |
| **RISC-V64 Trap 处理** | 90% | 完整的 S-Mode trap 分发，含中断/异常/系统调用 |
| **RISC-V64 MMU (SV39)** | 85% | 完整的页表操作，支持 ASID，支持内核重映射 |
| **RISC-V64 上下文切换** | 90% | 高效的汇编实现，含 callee-saved 寄存器保存 |
| **PLIC 驱动** | 95% | 完整的 claim/complete/priority/threshold 操作 |
| **SBI 封装** | 90% | 完整的 OpenSBI 0.2+ 兼容，含 extension 探测 |
| **UART 驱动** | 85% | NS16550 基本驱动，115200 8N1 配置 |
| **VirtIO 驱动** | 90% | 完整的 blk/net/console/gpu/input 设备枚举与初始化 |
| **EXT4 只读扫描器** | 75% | 支持 superblock/inode/extent/legacy block/dir 遍历/路径解析/文件缓存；不支持写入，不支持哈希树目录 |
| **ELF 加载器** | 70% | 支持 ET_EXEC/ET_DYN/PT_LOAD/PT_DYNAMIC/PT_INTERP；不支持重定位、动态链接 |
| **用户镜像管理器** | 80% | 完整的段对齐/BSS清零/PHDR 定位 |
| **用户态执行 (SV39)** | 80% | 完整的 SV39 三级页表、恒等映射、用户栈、AUX 向量；不支持 ASID、不支持 CoW |
| **Syscall 实现** | 75% | 约 80+ syscall，核心 I/O/文件/进程/内存/时间 syscall 完整；网络/信号为 stub |
| **虚拟文件系统 (in-memory)** | 70% | 完整文件 CRUD/目录/管道/伪文件；无权限检查、无真正持久化 |
| **Clone/Fork** | 50% | 页面快照机制，仅单级 fork，不支持 CoW |
| **Execve** | 60% | 通过返回状态码实现，递归深度限制 4 |
| **测试运行器** | 80% | 支持 smoke/basic/busybox/libctest/lua 五种模式，脚本解析、参数提取 |
| **LoongArch64 Stub** | 40% | 含 EXT4/ELF/60+ syscall/busybox/libctest；仍在开发中，未与 RT-Thread 集成 |
| **DFS 框架** | N/A | 配置启用但竞赛代码未使用，直接操作块设备 |
| **lwIP 网络栈** | N/A | 配置启用但竞赛代码未使用 |
| **Finsh Shell** | N/A | 配置启用但竞赛运行不依赖 |
| **POSIX 兼容层** | N/A | 配置启用但竞赛代码自己实现了兼容层 |
| **Rust 模块** | N/A | 仅框架存在，竞赛未使用 |

---

## 八、整体架构评估

### 8.1 项目的分层架构

```
┌─────────────────────────────────────────────────┐
│  竞赛应用层 (applications/)                       │
│  ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
│  │EXT4 扫描器│ │ELF 加载器│ │用户态执行+syscall│  │
│  └───────────┘ └──────────┘ └────────────────┘  │
│  ┌──────────────────────────────────────────┐    │
│  │          测试运行器 (Test Runner)         │    │
│  └──────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│  RT-Thread 内核核心                              │
│  ┌────┐ ┌────┐ ┌─────┐ ┌────┐ ┌──────┐        │
│  │线程│ │调度│ │IPC  │ │内存│ │定时器│        │
│  └────┘ └────┘ └─────┘ └────┘ └──────┘        │
├─────────────────────────────────────────────────┤
│  RT-Thread 组件层 (DFS, lwIP, Finsh, POSIX)     │
│  [大部分已配置但竞赛代码未使用]                    │
├─────────────────────────────────────────────────┤
│  RISC-V64 架构层                                 │
│  ┌────┐ ┌────┐ ┌────┐ ┌──────┐ ┌────┐         │
│  │Trap│ │MMU │ │Ctx │ │PLIC  │ │SBI │         │
│  └────┘ └────┘ └────┘ └──────┘ └────┘         │
├─────────────────────────────────────────────────┤
│  BSP/驱动层                                      │
│  ┌─────┐ ┌───────┐ ┌────────┐                  │
│  │UART │ │VirtIO │ │NS16550 │                  │
│  └─────┘ └───────┘ └────────┘                  │
└─────────────────────────────────────────────────┘
```

### 8.2 架构设计创新点

1. **"OS on OS"双层架构**：在 RT-Thread 内核上构建了一个用户态进程执行环境。这是最大的架构创新——不是替换内核，而是在一个成熟 RTOS 上叠加用户态支持。

2. **弱引用桥接设计**：通过 `rt_weak` 声明的 `os_user_ecall_handle()` 和 `os_user_fault_handle()` 将内核 trap 处理无缝桥接到竞赛代码，无需修改 RT-Thread 核心。

3. **绕过而非替换**：竞赛代码选择性地绕过 RT-Thread 的 DFS、LWP、POSIX 等组件，直接用更轻量的实现替代。例如使用自研的 in-memory 文件系统代替 DFS + FatFs。

4. **EXT4 直接解析**：不依赖任何文件系统中间层，直接从块设备读取 raw EXT4 结构，极大减小了依赖和代码体积。

5. **Syscall 预算机制**：通过 `g_user_syscall_budget` 限制用户程序的 syscall 数量，防止恶意或异常程序耗尽内核资源。

6. **execve 的"协作式"实现**：与标准内核在 trap handler 中直接替换地址空间不同，竞赛代码通过返回特殊状态码让 runner 重新加载新程序，保持了代码的简单性。

7. **双架构策略**：RISC-V64 作为主目标（完整实现），LoongArch64 作为独立 stub（最小实现），为后续完整 LoongArch 移植预留了清晰的边界。

### 8.3 设计局限与不足

1. **Clone/Fork 简化过度**：页面快照机制在内存使用上效率低，且不支持多级 clone。实际竞赛测试中可能遇到需要真正 fork 语义的场景。

2. **Execve 递归限制**：深度 4 的限制可能在复杂测试场景（如 shell 脚本多层嵌套 exec）中触发。

3. **Signal 处理不完整**：虽然定义了信号屏蔽位，但实际不向用户程序发送信号，可能导致依赖信号的程序异常。

4. **文件系统非持久化**：in-memory 文件系统在用户程序退出后数据丢失（除非显式写回 EXT4）。

5. **Syscall 实现覆盖不完整**：socket 系列 syscall 为极简模拟，网络相关测试可能失败。

6. **未使用 RT-Thread SMART 模式**：`CONFIG_RT_USING_SMART` 未启用，RT-Thread 自带的 LWP（轻量级进程）能力未被利用，竞赛团队从头实现了一套。

---

## 九、代码质量与工程化

### 9.1 代码组织

- **竞赛自研代码**（`applications/`）：高度模块化，每个文件职责清晰
- **RT-Thread 内核**：标准 RT-Thread 5.x 代码结构，工业级质量
- **构建系统**：SCons + Makefile 双层封装，适配竞赛评测环境

### 9.2 代码风格

- 竞赛代码采用直接、简洁的风格
- 大量使用静态全局变量管理状态（如 `g_user_exec_active`, `g_fd_table`）
- 手动实现字符串操作函数（`kernel_strlen`, `kernel_str_eq` 等），减少对 libc 依赖
- 错误处理以返回 `-1`/`0` 为主，缺少详细的错误码分类

### 9.3 测试与验证覆盖

- 通过 EXT4 镜像中的脚本驱动测试
- 支持 glibc 和 musl 两个 ABI 的测试程序
- 测试覆盖：basic（系统调用基础）、busybox（命令集）、libctest（musl libc 测试套件）
- 限制：未进行单元测试或内核自身的回归测试

---

## 十、总结

OSKernel2026-X 是一个设计巧妙的竞赛操作系统项目。其核心策略是**利用 RT-Thread 成熟的底层基础设施（线程调度、中断管理、设备驱动、内存分配），在其上构建一个轻量级用户态进程执行环境**。这种"站在巨人肩膀上"的方法使其能够快速实现竞赛所需的用户程序执行能力。

项目的主要技术成就包括：
1. 完整的 SV39 用户态页表管理
2. 约 80 个 Linux-compatible syscall 的实现
3. 直接从 EXT4 块设备读取文件的只读扫描器
4. 支持 RISC-V64 ELF 加载和执行的完整工具链
5. 内建 in-memory 文件系统和管道支持
6. 双 ABI (glibc/musl) 测试框架

主要不足：
1. Clone/Fork 实现过于简化
2. Signal 处理不完整
3. 网络 syscall 为 stub 实现
4. 未与 RT-Thread 的 LWP/SMART 子系统集成
5. LoongArch64 端口尚未与 RT-Thread 主线合并

总体而言，该项目在竞赛约束下展现了务实的设计思路和扎实的系统编程能力，其"OS on OS"架构是竞赛场景下的合理选择。