# 对比分析报告

## 一、对比项目总览

本报告将 Oblivion OS（当前项目）与五个同生态（xv6衍生、C语言）且均宣称支持双架构或具有可比功能集的竞赛内核进行多维度对比。六个项目的基本面如下：

| 属性 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|------|------------|-----|-----------|----------|---------|-------|
| 团队 | -- | 武汉大学 | 吉林大学 | 中山大学 | 华中科技大学 | 中南大学 |
| 基础内核 | xv6-riscv | xv6 | xv6-riscv | xv6-riscv | xv6 | xv6-riscv |
| 语言 | C | C | C | C | C | C |
| 宣称架构 | RV64+LA64 | RV64+LA64 | RV64+LA64 | RV64+LA64 | RV64+LA64 | RV64 |
| LA64实质 | 探针（预录制） | 真实内核 | 部分实现 | 真实内核+真机 | 真实内核 | 无 |
| 内核代码量 | ~24,000行 | ~56,000行 | ~51,000行 | ~48,000行 | ~13,000行 | ~10,000行 |
| 系统调用数 | ~32(xv6)+50+(Linux) | 144 | 81 | 80+ | 80+ | ~70 |
| 构建系统 | Makefile | Makefile | Makefile | Makefile | CMake+Make | Makefile |

## 二、架构设计对比

| 维度 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|------|------------|-----|-----------|----------|---------|-------|
| 内核类型 | Monolithic | Monolithic | Monolithic | Monolithic | Monolithic | Monolithic |
| 分层架构 | 非正式分层（平台宏隔离） | 正式三层：HAL/HSAI/Kernel | 目录分层（arch/fs/mm/sched） | 目录分层（boot/kernel/user） | CMake目录分层 | 目录分层（kernel子目录） |
| 架构隔离方式 | #ifdef宏+独立目录 | HAL独立目录+统一接口 | arch/子目录完全分离 | boot/kernel下架构子目录 | riscv/loongarch子目录 | 仅RV64，无此需求 |
| 模块化程度 | 中等 | 高 | 中等 | 高 | 中等 | 中等 |
| 双架构真实性 | 不对称：RV64真实，LA64探针 | 对称：双架构均真实 | 不对称：RV64完整，LA64部分 | 对称：双架构均真实且上真机 | 对称：双架构均真实 | 不适用 |

**架构设计评述**：

SC7的三层架构（HAL/HSAI/Kernel）是六个项目中架构解耦最为彻底的，通过HAL层统一硬件差异、HSAI层提供架构无关服务、Kernel层专注核心逻辑，实现了真正意义上的双架构对等支持。SpringOS虽然未明确声明分层架构，但其`boot/`和`kernel/`下的架构子目录分离方式同样实现了良好的架构隔离，而且在真实硬件上的运行验证了其架构抽象的扎实性。相比之下，Oblivion OS使用`#ifdef QEMU`/`#ifdef VISIONFIVE2`等条件编译宏进行平台区分，这种方式在小规模项目中可行，但扩展性和可维护性均不如目录级别的架构分离。

Oblivion OS的双页表架构（每进程同时维护用户态页表和内核态页表副本）是一个有特色的设计选择，使得`copyin`/`copyout`可以隐式处理COW和lazy allocation的页面错误，在六个项目中属于独有的设计模式。

## 三、子系统实现深度对比

### 3.1 内存管理子系统

| 能力项 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|--------|------------|-----|-----------|----------|---------|-------|
| 物理页分配 | 空闲链表+引用计数 | 伙伴系统(0-10阶)+Slab | 单链表空闲页 | Buddy分配器 | 伙伴系统(线段树) | 空闲链表+Buddy |
| 小块内存分配 | 无（仅页级） | Slab(8-1024字节) | 无（整页分配） | 无 | Slab（未启用） | Buddy |
| 虚拟内存管理 | Sv39三级页表 | 多级页表 | Sv39三级页表 | Sv39+LA四级页表 | Sv39+LA四级页表 | Sv39三级页表 |
| COW | 完整实现 | 完整实现 | 未实现 | 未实现 | 未实现 | 完整实现 |
| Lazy Allocation | 完整实现 | 支持PROT_NONE延迟 | mmap按需调页 | mmap按需调页 | 未实现 | mmap懒分配 |
| 共享内存 | 未实现 | System V共享内存 | 未实现 | 未实现 | 未实现 | System V共享内存 |
| 页面置换 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| VMA管理 | 无显式VMA | 双向循环链表 | 链表 | 链表 | 链表 | 链表 |

**内存管理评述**：

Oblivion OS与HatOS是仅有的两个同时实现COW和Lazy Allocation的项目。Oblivion的COW实现通过`PTE_COW`标志位（复用RISC-V RSW位）和引用计数机制，在`uvmcopy`时标记共享、在page fault时按需拆分的路径清晰完整。SC7虽然在COW方面也有实现，但其VMA线性查找在大规模地址空间下存在性能隐患。Re-XVapor、SpringOS、AddddOS三者均未实现COW，fork时采用全量内存复制，这是一个显著的功能差距。

SC7的伙伴系统+Slab两层分配器设计是六个项目中物理内存管理最为完善的。Oblivion和Re-XVapor仅支持4KB页级分配，缺乏小块内存分配能力，这在内核频繁分配小对象时会造成严重的内存浪费。

### 3.2 进程管理子系统

| 能力项 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|--------|------------|-----|-----------|----------|---------|-------|
| 进程模型 | 标准xv6进程 | 进程+POSIX线程 | 进程-线程分离(线程组) | 进程+clone线程 | 进程+clone线程 | 标准xv6进程 |
| 进程槽位 | NPROC=50 | 静态池 | 16进程/64线程 | NPROC=64 | 静态表 | NPROC=512 |
| 调度算法 | RR+Priority+MLFQ(3种) | 轮询遍历 | FIFO轮转 | 简单轮转 | 轮转(RR) | FIFO |
| 线程支持 | clone_proc（基础） | POSIX线程取消机制 | 完整线程组(CLONE_VM等) | clone(CLONE_VM/CLONE_FILES) | clone | 无显式线程 |
| 资源限制 | 无 | rlimit完整支持 | rlimit数组(部分) | 无 | 无 | rlimit结构(部分) |
| 命名空间 | 无 | UTS命名空间 | 无 | 无 | 无 | 无 |
| 进程组/会话 | 无 | 完整支持 | 无 | 无 | 无 | 无 |

**进程管理评述**：

Oblivion OS在调度器方面表现出色，是六个项目中唯一实现了三种可切换调度算法（RR、Priority、MLFQ）的内核，且MLFQ包含动态优先级调整的完整实现。然而在进程模型方面，SC7和Re-XVapor的线程组设计明显更为成熟——SC7支持完整的POSIX线程取消机制，Re-XVapor实现了Linux风格的线程组模型（通过`CLONE_VM`、`CLONE_THREAD`等标志位）。Oblivion的`clone_proc`仅支持基本的子栈指针参数，线程语义较弱。

SC7的进程组/会话管理和rlimit资源限制是Oblivion完全缺失的功能维度，这限制了Oblivion在运行复杂用户态程序（如需要job control的shell）时的兼容性。

### 3.3 文件系统子系统

| 能力项 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|--------|------------|-----|-----------|----------|---------|-------|
| VFS抽象层 | 条件分支分发 | 完整VFS层 | 完整VFS层(inode_ops/file_ops/fs_ops) | 完整VFS层 | VFS层 | VFS层(函数指针) |
| EXT4支持 | 只读(自实现) | 完整读写(lwext4) | 完整读写(lwext4) | 完整读写(lwext4) | 完整读写(lwext4) | 完整读写(lwext4) |
| FAT32支持 | 完整读写 | VFAT支持 | xv6fs(保留) | 无 | 无 | FAT32(编译时切换) |
| 其他FS | 无 | procfs | procfs(基础) | procfs | procfs+devfs | 无 |
| 写支持(EXT4) | 无 | 有(log/extent/xattr) | 有 | 有 | 有 | 有 |
| 符号链接 | 无 | 完整支持 | 部分支持 | 完整支持 | 支持 | 支持 |
| 硬链接 | 无 | 支持 | 支持 | 支持 | 支持 | 无 |
| 块缓存 | LRU双向链表 | 有 | 有 | 无高级缓存 | LRU双向链表 | LRU双向链表 |

**文件系统评述**：

Oblivion OS的EXT4实现是六个项目中唯一采用自实现而非集成lwext4的方案，这在代码自主可控性方面具有独特价值。然而，这也意味着其EXT4支持仅为只读——不支持文件写入、创建、删除、符号链接和硬链接。其他五个项目中，SC7、Re-XVapor、SpringOS、AddddOS均通过集成lwext4实现了完整的EXT4读写支持，包括extent树、日志、xattr等高级特性。

Oblivion是唯一同时提供FAT32完整读写和EXT4只读的内核，其在`fat32.c`中通过`ext4_active()`条件分支实现的双文件系统调度是简洁有效的设计。但相比SC7的VFS抽象层（支持mount/umount/statfs等完整VFS语义）或HatOS的VFS函数指针抽象，Oblivion的VFS设计较为原始——本质上是在FAT32函数内部做条件分发，而非通过统一的文件系统操作接口。

### 3.4 系统调用与兼容性

| 能力项 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|--------|------------|-----|-----------|----------|---------|-------|
| xv6原生调用 | 32个 | 纳入144个体系 | 纳入81个体系 | 纳入80+体系 | 纳入80+体系 | 纳入70个体系 |
| Linux ABI兼容 | 50+（进程名匹配） | 原生Linux ABI | 原生Linux ABI | 原生Linux ABI | 原生Linux ABI | 原生Linux ABI |
| 信号系统调用 | 存根（返回0） | 完整64信号 | 31信号+基础Futex | 完整64信号 | 信号支持 | 完整信号 |
| Futex | 未实现 | 完整(FUTEX_WAITV等) | 基础(FUTEX_WAIT/WAKE) | 基础Futex | 基础Futex | 未实现 |
| mmap | 简化（growproc+读文件） | 完整实现 | 按需调页实现 | 延迟分配 | 基础实现 | 懒分配+共享 |
| 动态链接支持 | auxv向量构建 | 支持 | ELF动态链接器加载 | 支持 | 支持 | 完整musl动态链接 |
| 网络相关调用 | 无 | socket桩 | 无 | 无 | 本地socket | sys_socket→exit(0) |

**系统调用评述**：

Oblivion OS的Linux ABI兼容层采用了独特的进程名匹配策略（`is_linux_abi_proc()`），而非直接遵循Linux系统调用号标准。这是一种务实的竞赛策略——以最小成本兼容公开测试二进制，但缺乏通用性。其他五个项目均原生使用Linux标准系统调用编号，兼容性更为普适。

SC7以144个系统调用遥遥领先，覆盖了进程、文件、内存、信号、时间、用户/组权限等几乎所有POSIX核心领域。Oblivion的系统调用数量（32个xv6原生+50余个Linux兼容）在总量上与Re-XVapor（81个）、SpringOS（80+个）和AddddOS（80+个）相近，但信号相关系统调用几乎全部为存根（返回0或SIGCHLD），这是一个明显的实现缺口。

Oblivion完全未实现Futex同步原语，而SC7、Re-XVapor、SpringOS和AddddOS均提供了Futex支持。Futex是用户态pthread库实现高效同步的基础，缺失Futex意味着Oblivion无法支持现代多线程用户程序。

### 3.5 中断与异常处理

| 能力项 | Oblivion OS | SC7 | Re-XVapor | SpringOS | AddddOS | HatOS |
|--------|------------|-----|-----------|----------|---------|-------|
| 多核中断 | PLIC（RV64） | PLIC+多核启动 | PLIC | PLIC+EXTIOI(LA) | PLIC+APIC+EXTIOI(LA) | PLIC |
| 定时器 | SBI定时器 | 定时器管理 | SBI定时器 | SBI/CSR定时器 | 时钟中断 | SBI定时器 |
| 缺页处理 | COW+Lazy统一处理 | 缺页异常处理 | mmap缺页 | mmap延迟分配 | mmap缺页(仅mmap区) | COW+Lazy+mmap |
| LA64异常支持 | 最小（仅同步异常） | 完整trap处理 | 部分实现 | 完整+ALE非对齐模拟 | 完整 | 无 |
| 信号跳板 | 无 | 有 | trampoline桩 | 嵌套信号上下文栈 | sig_trampoline | 固定地址跳板页 |

**中断与异常评述**：

Oblivion在RISC-V侧的缺页处理路径是最为完整的之一：统一入口`uvm_handle_page_fault()`先检查COW再检查lazy allocation，逻辑清晰且经过良好的测试覆盖。SpringOS的LoongArch非对齐访问软件模拟（ALE处理）是一个独特亮点——通过解析触发异常的load/store指令操作码在软件层面模拟非对齐内存访问，这体现了对硬件细节的深入理解。

Oblivion在LoongArch64侧的异常处理仅为最小实现：仅支持同步异常（系统调用write/exit），中断保持禁用。这与SC7、SpringOS、AddddOS在LoongArch侧的完整中断控制器驱动（EXTIOI/APIC）形成鲜明对比。

## 四、双架构实现真实性对比

这是区分六个项目最关键的维度之一：

| 项目 | RISC-V64 | LoongArch64 | LA64实质 |
|------|----------|-------------|----------|
| SC7 | 完整内核 | 完整内核 | 真实实现，通过HAL/HSAI层对称支持 |
| SpringOS | 完整内核 | 完整内核 | 真实实现，且在龙芯2K1000LA真机上运行 |
| AddddOS | 完整内核 | 完整内核 | 真实实现，独立完成PCI枚举+EXTIOI移植 |
| Re-XVapor | 完整内核 | 部分实现 | 部分AHCI/PCI驱动，未完整集成 |
| Oblivion OS | 完整内核 | 探针 | 预录制输出runner，非真实内核 |
| HatOS | 完整内核 | 无 | 不适用 |

SC7、SpringOS、AddddOS三个项目在LoongArch64侧均实现了真实可运行的内核，其中SpringOS更是实现了在真实龙芯硬件上的运行。Oblivion的LoongArch64侧仅约420行代码，功能限定为早期串口输出、受控异常处理和PLV3用户态预录制输出打印——它不具备进程管理、内存管理、文件系统或中断处理能力。虽然项目文档坦率承认这一设计选择，但这意味着Oblivion并非真正意义上的双架构内核。

## 五、技术亮点对比

| 项目 | 核心亮点 | 创新程度 |
|------|---------|---------|
| Oblivion OS | 双页表架构（copyin/copyout隐式处理COW）；三种可切换调度算法(RR/Priority/MLFQ)；自实现EXT4只读解析；Linux ABI进程名匹配兼容层 | 中等 |
| SC7 | HAL/HSAI/Kernel三层架构解耦；144个系统调用(六项目最多)；POSIX线程取消机制；rlimit+UTS命名空间；procfs | 高 |
| Re-XVapor | Linux风格线程组模型；系统调用表脚本自动生成；ELF动态链接加载；ext4+lwext4完整集成 | 中等 |
| SpringOS | 双架构真机适配(VisionFive2+2K1000LA)；LoongArch非对齐访问软件模拟；PCI子系统枚举；完整64信号机制 | 高 |
| AddddOS | 线段树伙伴系统（O(log n)）；LoongArch PCI总线枚举+EXTIOI移植；本地Socket通信；CMake现代化构建 | 中等 |
| HatOS | 位置无关内核(PIC)设计；固定地址信号跳板页面(安全创新)；COW+lazy alloc+共享内存三者并存；编译时双FS切换 | 中等 |

## 六、不足与缺失对比

| 项目 | 主要缺陷 | 严重程度 |
|------|---------|---------|
| Oblivion OS | LA64侧为探针非真实内核；EXT4只读；信号为存根；无Futex；无网络；VFS设计原始；Linux ABI进程名匹配脆弱 | 高 |
| SC7 | O(N)调度器；VMA线性查找；静态池限制；网络缺失；Futex静态数组易耗尽 | 中 |
| Re-XVapor | 无COW；仅16进程/64线程硬限制；无小块内存分配；仅FIFO调度；无网络 | 高 |
| SpringOS | 无COW；无页面置换；简单RR调度；无sigaltstack；无网络；lwext4高耦合 | 中 |
| AddddOS | 内存分配器锁被注释(并发缺陷)；Slab未启用；kcalloc逻辑错误；无COW/Lazy；信号量惊群；无网络 | 高 |
| HatOS | 仅RV64；FIFO调度；fork硬编码延时规避Bug；wakeup全表扫描退化；MAP_SHARED+懒分配冲突；无Futex/网络 | 中 |

## 七、整体成熟度综合评分

以下评分以竞赛级操作系统内核的预期功能集为基准（100%），涵盖功能广度、实现深度、工程质量、双架构真实性、创新性五个维度：

| 项目 | 功能广度 | 实现深度 | 工程质量 | 双架构真实性 | 创新性 | 综合评分 |
|------|---------|---------|---------|-------------|-------|---------|
| SC7 | 95% | 85% | 80% | 95% | 85% | **88%** |
| SpringOS | 85% | 80% | 85% | 95% | 85% | **86%** |
| HatOS | 75% | 80% | 65% | N/A | 80% | **75%** (单架构) |
| Oblivion OS | 70% | 70% | 70% | 20% | 75% | **61%** |
| Re-XVapor | 75% | 65% | 65% | 50% | 70% | **65%** |
| AddddOS | 70% | 55% | 50% | 80% | 65% | **64%** |

**评分说明**：

- **功能广度**：衡量各子系统（进程、内存、文件系统、信号、同步、网络等）的功能覆盖率。SC7以144个系统调用和覆盖POSIX多领域的实现位居第一。
- **实现深度**：衡量各功能实现的完整程度（如COW是否真正按引用计数拆分、调度器是否支持多策略等）。HatOS和SpringOS在内存管理方面较深。
- **工程质量**：衡量代码组织、并发安全性、错误处理、构建系统等方面的成熟度。SpringOS的真机验证为其工程质量提供了最有力的背书。
- **双架构真实性**：衡量LoongArch64侧是否为真实可运行内核。SC7和SpringOS在此维度表现最佳。
- **创新性**：衡量独特技术贡献。SpringOS的ALE模拟和真机适配、HatOS的PIC设计和信号跳板、SC7的三层架构均具有较高创新性。

## 八、各项目总结评价

### SC7（武汉大学）——综合实力最强的双架构内核

SC7是六个项目中功能覆盖最广、架构设计最规范的内核。其HAL/HSAI/Kernel三层架构实现了真正意义上的双架构对等支持，144个系统调用覆盖了POSIX标准的绝大多数核心领域。内存管理方面，伙伴系统+Slab的两层分配器设计在物理内存管理上最为完整。进程管理方面，POSIX线程取消机制和rlimit资源限制是其他项目所不具备的。主要不足在于调度器和VMA查找均采用O(N)线性算法，以及网络协议栈的缺失。综合评分88%，位居第一。

### SpringOS（中山大学）——真机验证的双架构标杆

SpringOS的核心竞争力在于其双架构支持不仅停留在QEMU模拟器层面，而是成功运行于VisionFive2（RISC-V）和龙芯2K1000LA（LoongArch）真实硬件开发板。LoongArch平台的非对齐访问软件模拟体现了对硬件细节的深入理解。VFS+EXT4完整实现、64信号机制、PCI枚举等子系统均达到了较高完成度。主要不足在于未实现COW和页面置换，调度算法仅为简单轮转。综合评分86%，位居第二。

### HatOS（中南大学）——单架构下功能密度最高的精巧内核

HatOS是六个项目中唯一仅支持RISC-V64架构的，但在约10,000行自写内核代码内实现了COW、lazy allocation、System V共享内存、ext4+FAT32双文件系统、完整信号机制和动态链接支持，功能密度极高。位置无关内核设计和固定地址信号跳板页面展现了设计巧思。主要不足在于FIFO调度器过于基础、fork中的硬编码延时workaround暴露了底层并发控制缺陷、以及wakeup全表扫描的性能退化。综合评分75%（单架构评分），若仅比较RISC-V侧功能深度，与SC7和SpringOS处于同一梯队。

### Re-XVapor（吉林大学）——架构设计合理但受限严重的实用内核

Re-XVapor的线程组模型是六项目中最接近Linux语义的，进程-线程分离、CLONE_VM/CLONE_THREAD等标志位支持、以及系统调用自动生成机制展现了良好的软件工程素养。ELF动态链接加载和lwext4集成使其能够运行glibc/musl链接的真实用户程序。然而，16进程/64线程的硬限制和物理内存仅支持页级分配是其最大的短板，在并发场景下严重受限。未实现COW使其在fork大内存进程时性能显著劣于Oblivion和HatOS。综合评分65%。

### AddddOS（华中科技大学）——潜力大但工程质量堪忧的双架构内核

AddddOS的LoongArch侧适配工作（PCI枚举、EXTIOI移植、四级页表）在技术难度上具有较高价值，线段树实现的伙伴系统在算法复杂度上优于其他项目的链表方案。然而，核心内存分配器的锁被注释导致多核并发安全性形同虚设，Slab分配器已编写但未启用，kcalloc存在参数计算错误——这些工程质量问题严重削弱了其技术价值。综合评分64%。

### Oblivion OS（当前项目）——特色鲜明但不对称的双架构提交

Oblivion OS在RISC-V64侧展现了扎实的内核开发能力：COW和lazy allocation的完整实现、三种可切换调度算法、以及自实现EXT4只读解析均体现了对操作系统核心机制的深入理解。双页表架构和Linux ABI兼容层的进程名匹配策略虽然实用但缺乏优雅性。其最大的结构性问题是LoongArch64侧并非真实内核——约420行代码的内核探针仅能打印预录制基准测试输出，这使得"双架构"标签缺乏实质支撑。同时，信号机制为存根、无Futex支持、EXT4只读等缺失限制了其作为通用操作系统的实用性。综合评分61%，若仅评估RISC-V侧，评分可上调至约72%。

## 九、评审意见

Oblivion OS项目在RISC-V64架构上展示了较为扎实的操作系统内核开发功底，其COW与lazy allocation的完整实现、三种调度算法的切换设计以及自实现EXT4解析器均体现了一定的技术深度。双页表架构在copyin/copyout路径中隐式处理页面错误的做法是一个有特色的工程选择，在六个对比项目中属于独有设计。

然而，在与其他五个同生态项目的横向对比中，Oblivion OS暴露出几个结构性问题：

第一，LoongArch64侧的"双架构"宣称名不副实。SC7和SpringOS在LoongArch64侧均实现了完整的内核功能，且SpringOS已验证在真实龙芯硬件上运行；AddddOS也独立完成了LoongArch的PCI枚举和EXTIOI移植。相比之下，Oblivion约420行的内核探针仅实现了预录制输出的打印功能，不具备进程管理、内存管理、文件系统或中断处理能力，本质上是竞赛兼容策略的产物而非真正的跨架构工程实践。

第二，内核功能的深度不均衡。虽然Oblivion在内存管理（COW+lazy allocation）和调度器（三种算法）方面表现突出，但其信号机制几乎全部为存根、Futex完全缺失、EXT4仅支持只读——这些缺失使其在运行现代多线程用户程序时的能力受到严重制约。相比之下，HatOS在更小的代码规模内实现了更均衡的功能集（COW+lazy+共享内存+完整信号+ext4完整支持）。

第三，VFS和Linux ABI兼容层的设计偏向实用主义但缺乏架构优雅性。VFS通过`ext4_active()`条件分支而非统一操作接口进行分发，Linux ABI通过进程名字符串匹配而非标准系统调用号进行识别——这些设计选择在竞赛场景中有效，但限制了内核的通用性和可扩展性。

总体而言，Oblivion OS在RISC-V64单架构上的技术实力与Re-XVapor、AddddOS处于相近水平，优于基础xv6教学内核但距SC7和SpringOS仍有明显差距。其最显著的技术贡献在于COW+lazy allocation+多调度器的组合实现以及自研EXT4解析器。建议后续方向：（1）将LoongArch64侧从探针提升为真实内核，至少实现基础进程模型和内存管理；（2）完善信号机制和Futex支持以支撑多线程用户程序；（3）重构VFS层为统一操作接口以提升文件系统可扩展性。