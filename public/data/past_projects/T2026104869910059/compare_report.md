现在生成完整的对比分析报告：

---

# 对比分析报告

## 一、项目概览

| 维度 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 | 宏内核 |
| **支持架构** | RISC-V, LoongArch | RISC-V, LoongArch | RISC-V | RISC-V, LoongArch | RISC-V, LoongArch(部分) | RISC-V, x86_64, AArch64, LoongArch |
| **实现语言** | Rust + C(lwext4) | Rust + C(lwext4) | Rust | Rust | Rust | Rust |
| **代码规模(Rust)** | ~26,250行 | ~10,979行 | ~14,625行 | ~37,531行 | ~49,442行 | ~15,000行(估) |
| **系统调用数** | ~99 | 73 | 105 | 117 | ~75 | 100+ |
| **生态归属** | polyhal | polyhal | rCore | 自研HAL | rCore派生 | 自研polyhal |
| **调度模型** | FIFO同步 | FIFO同步 | FIFO同步 | FIFO同步 | FIFO同步 | 异步协作式 |

---

## 二、架构设计对比

### 2.1 内核类型与分层方式

| 维度 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **硬件抽象层** | polyhal(双架构) | polyhal(双架构) | 无独立HAL(单架构) | 自研HAL(双架构) | Trait+cfg_if(双架构部分) | polyhal(四架构) |
| **模块化程度** | 中(直接依赖polyhal) | 中(直接依赖polyhal) | 中(基于rCore模块) | 高(HAL完整隔离) | 高(7个独立crate) | 高(94个vendor crate) |
| **分层清晰度** | 良好 | 良好 | 良好 | 优秀 | 优秀 | 优秀 |
| **架构可移植性** | 中等(依赖polyhal升级) | 中等 | 低(单架构硬编码) | 高(自研HAL可控) | 低(LoongArch仅20%) | 高(四架构成熟) |

**分析**：
- Ferriswheel OS与Nonix OS均依赖外部polyhal框架，移植性受制于框架演进，但双架构均已实际可用。
- NPUcore-Aspera的自研HAL展示了最强的架构抽象能力，LAFlex页表的内联汇编优化体现了针对特定架构的深度优化。
- ByteOS以四架构支持领跑，但每个架构的优化深度不如NPUcore-Aspera。
- TrustOS仅支持RISC-V，架构灵活性最低，但代码可在单架构上做更深优化。

### 2.2 调度器设计

这是六个项目差异最显著的维度：

| 维度 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **调度算法** | FIFO协作式 | FIFO协作式 | FIFO协作式 | FIFO协作式 | FIFO协作式 | 异步FIFO协作式 |
| **时间片** | 无 | 无 | 无 | 无 | 无 | 无 |
| **优先级** | 无 | 无 | 无 | 无 | 有字段未使用 | 无 |
| **抢占式** | 否 | 否 | 否 | 否 | 否 | 否 |
| **多核支持** | 无 | 无 | 无 | 无 | 框架存在但未启用 | 有(多核任务分发) |
| **空闲处理** | 检查定时器(不关机) | 标准循环 | 标准循环 | 标准循环 | 标准循环 | hlt_if_idle |

**分析**：
- 全部六个项目均采用协作式调度，无一实现抢占式调度，这是比赛级内核的普遍特征。
- ByteOS的异步执行器模型是唯一的差异化设计：利用Rust Future/Waker机制将任务封装为异步任务，提供了更现代的任务管理范式。但其Waker实现为空操作，阻塞唤醒逻辑不完整。
- Ferriswheel OS的空闲处理（检查挂起定时器而非立即关机）是一个务实的细节改进，确保nanosleep能正确唤醒。
- Explosion OS定义了`priority`字段但未在调度中使用，暴露了"设计预留但未实现"的模式。

---

## 三、子系统实现对比

### 3.1 内存管理子系统

| 特性 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **物理帧分配器** | 栈式 | Buddy系统 | 栈式 | 栈式 | 栈式 | 位图 |
| **COW** | **无** | 有 | 有 | 有 | 有 | 有 |
| **懒加载** | 无 | 有 | 有 | 有 | 无(全量映射) | 有 |
| **mmap** | 有(MAP_SHARED/PRIVATE) | 有(共享组机制) | 有(分组管理) | 有 | 有(含Bitmap管理器) | 有 |
| **mprotect** | 无 | 有 | 有 | 有 | 有 | 无 |
| **System V共享内存** | 有 | 有 | 有 | 有 | 无 | 有 |
| **Swap** | 无 | 无 | 无 | **有(16MB)** | 无 | 无 |
| **Zram压缩** | 无 | 无 | 无 | **有(LZ4,2048页)** | 无 | 无 |
| **OOM处理** | 无 | 无 | 无 | **有(三层回收)** | 无 | 无 |
| **页缓存** | 无 | 无 | 无 | 有 | 仅框架 | 无 |

**分析**：
- **NPUcore-Aspera在内存管理上遥遥领先**：Frame状态机（InMemory/Compressed/SwappedOut/Unallocated）、Zram压缩、Swap交换、三层OOM回收构成了六个项目中最完整的内存管理方案。
- Ferriswheel OS是六个项目中**唯一没有实现COW的**，这是其内存管理最显著的短板。fork时全量复制所有物理页，内存效率最低。
- Nonix OS的mmap共享组机制是解决fork后共享内存物理帧生命周期管理的创新方案，设计思路值得参考。
- Explosion OS的MmapManager使用Bitmap管理mmap区域（16MB=4096页），是独特的实现方式，但PageCache仅具框架未完成集成。

### 3.2 文件系统子系统

| 特性 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **ext4实现方式** | lwext4(C绑定) | lwext4(C绑定) | lwext4(C绑定) | **自研Ext4** | **自研Ext4(7000行)** | lwext4(C绑定) |
| **FAT32** | 无 | 无 | 无 | **有** | 无 | **有** |
| **Ext4 Extent** | 继承自lwext4 | 继承自lwext4 | 继承自lwext4 | **自研完整实现** | **自研完整实现** | 继承自lwext4 |
| **VFS抽象** | File trait | File trait+FileClass | Inode+File trait | File trait(downcast) | File trait | VFS+vfscore |
| **管道缓冲区** | 32字节 | 32字节 | **64KB** | 有 | 有 | 有 |
| **目录缓存(Dentry)** | 无 | 无 | 无 | **有(全局树缓存)** | 无 | **有(DentryNode)** |
| **块缓存** | 无 | 无 | 无 | **有** | 无 | 无 |
| **/proc** | 无(LA有VFS注册) | 有(虚拟文件注册表) | 部分(devfs) | 部分(meminfo等) | 有(静态) | **有(ProcFS)** |
| **设备文件** | /dev/null/zero | 无 | /dev/null/zero/random/tty | Pipe/TTY/Null/Zero/Urandom | 无 | DevFS |
| **挂载管理** | 双设备挂载 | 仅记录信息 | 挂载表 | 完整挂载 | 无 | **多挂载点** |
| **符号链接** | 继承自lwext4 | 继承自lwext4 | 继承自lwext4 | 无 | 继承自自研 | 不完整 |
| **文件权限** | 继承自lwext4 | 继承自lwext4 | 继承自lwext4 | 有 | 继承自自研 | 无UID/GID检查 |

**分析**：
- **ext4实现路线出现根本性分叉**：Ferriswheel OS、Nonix OS、TrustOS、ByteOS采用lwext4 C库绑定（复用约20,000行C代码），而NPUcore-Aspera和Explosion OS选择从零自研。前者获得成熟的ext4特性支持但受制于C库的FFI开销和调试困难；后者获得完全的代码可控性但工程量巨大（Explosion OS约7,000行）。
- ByteOS的文件系统生态最丰富：FAT32+Ext4+RAMFS+DevFS+ProcFS五合一，Dentry缓存加速路径解析。
- NPUcore-Aspera同时支持FAT32和自研Ext4（含Extent树），且实现了块缓存和目录树缓存，是自研路线中最完整的。
- Ferriswheel OS和Nonix OS的管道缓冲区仅32字节，与TrustOS的64KB差距显著，严重制约管道I/O吞吐量。

### 3.3 进程与信号管理

| 特性 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **fork/clone** | 全量复制(无COW) | COW | COW | COW | COW(含fork_cow) | COW |
| **exec** | 完整(动态链接+PIE) | 完整(动态链接+脚本) | 完整(动态链接+脚本) | 完整(动态链接) | 完整(动态链接+脚本) | 完整(动态链接) |
| **clone flags** | 基本 | 支持VM/FILES等 | **完整** | 完整 | 完整 | 完整 |
| **线程模型** | 有(thread_create) | 有(通过clone) | **完整CLONE_THREAD** | 有(通过clone) | 有(通过clone) | 有(通过clone) |
| **TLS支持** | 有 | 有 | **有** | 有 | 有 | 有 |
| **信号定义** | 有标志位 | 32个标准信号 | 31个标准信号 | **64种信号** | 64位掩码 | **标准+实时信号** |
| **信号处理函数调用** | **无(仅标志)** | 有框架但sigreturn panic | **完整(用户栈信号帧)** | **完整** | 仅致命信号终止 | **完整(上下文保存恢复)** |
| **SA_SIGINFO** | 无 | 无 | **有** | **有** | 无 | 无 |
| **SA_RESTART** | 无 | 无 | **有** | 无 | 无 | 无 |
| **Futex** | 有(无超时) | 无 | **有(含超时/REQUEUE)** | **有(含超时/REQUEUE)** | 无 | 有(WAIT/WAKE/REQUEUE) |

**分析**：
- **TrustOS在信号机制上表现最优**：实现了用户栈信号帧构建、SA_SIGINFO详细上下文传递、SA_RESTART系统调用重启，接近Linux的信号处理完整度。
- Ferriswheel OS的信号机制是六个项目中最薄弱的：仅实现了信号标志的设置和查询，完全缺失用户态信号处理函数调用。`rt_sigaction`返回0（桩函数）。
- Nonix OS的信号框架完整但存在致命缺陷：sigreturn触发panic，导致自定义信号处理函数执行后无法正常返回。
- Ferriswheel OS是唯一没有COW的项目，fork性能在所有项目中最低。

### 3.4 系统调用覆盖

| 类别 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **文件I/O** | ~25 | ~20 | 42 | ~35 | ~25 | 32 |
| **进程管理** | ~10 | ~8 | 18 | ~15 | ~12 | 15 |
| **内存管理** | 4 | 4 | 8 | ~8 | 5 | 6 |
| **信号** | ~10(多桩) | ~8(sigreturn panic) | 8(完整) | ~8(完整) | 4(基础) | 7(完整) |
| **时间** | 6 | 5 | 7 | ~6 | 6 | 8 |
| **网络** | 6(仅本地) | 0 | 13(多桩) | ~12(loopback) | ~8(自研协议栈) | 12 |
| **同步** | 4(自定义) | 0 | 4(Futex完整) | ~4(Futex完整) | 0 | 1(Futex基础) |
| **System V IPC** | 4 | 有(shmget等) | 有 | 有 | 无 | 有 |
| **桩函数数量** | ~15 | ~10 | ~5 | ~8 | ~10 | ~5 |
| **总ID数** | ~99 | 73 | 105 | 117 | ~75 | 100+ |

**分析**：
- NPUcore-Aspera定义了最多的系统调用ID（117个），覆盖面最广。
- TrustOS的105个系统调用实现质量最高：特别是Futex的REQUEUE操作、信号的SA_SIGINFO都是高级特性。
- Ferriswheel OS的~99个系统调用数量处于中上水平，但其中约15个为桩函数（返回0），实际有效实现约84个。
- Explosion OS虽然系统调用数最少（~75），但其自研EXT4对应的文件系统调用实现质量较高。

### 3.5 设备驱动与网络

| 特性 | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **VirtIO块设备** | 有(双设备) | 有(MMIO+PCI) | 有 | 有(MMIO+PCI) | 有 | 有 |
| **VirtIO网卡** | 无 | 无 | 无 | 无 | **有** | **有** |
| **SATA驱动** | 无 | 无 | 无 | **有** | 无 | 无 |
| **串口** | 有 | 有 | 有 | 有(NS16550A) | 有(NS16550A) | 有(NS16550A) |
| **RTC** | 无 | 无 | 无 | 无 | 无 | **有(Goldfish)** |
| **中断控制器** | 基本 | 基本 | 基本 | 基本 | **PLIC完整** | **PLIC+GIC** |
| **多板级支持** | QEMU virt | QEMU virt | QEMU+VisionFive2 | QEMU+K210+FU740 | QEMU virt | QEMU多架构 |
| **网络协议栈** | 仅本地socket | 无 | 仅socketpair | smoltcp(loopback) | **自研(ARP/IP/TCP/UDP)** | smoltcp(TCP/UDP) |
| **TCP状态机** | 无 | 无 | 无 | smoltcp内置 | 不完整 | smoltcp内置 |

**分析**：
- ByteOS的设备驱动覆盖面最广：VirtIO块/网、NS16550A、Goldfish RTC、PLIC/GIC、FDT解析。
- Explosion OS是唯一同时自研网络协议栈并实现VirtIO网卡驱动的项目，但其TCP缺乏重传和拥塞控制。
- NPUcore-Aspera的SATA驱动和K210/FU740板级支持扩展了真实硬件适配范围。
- Ferriswheel OS的设备驱动仅覆盖基本需求（VirtIO块设备+UART），双块设备挂载管理是其实用特点。

---

## 四、技术亮点汇总

### Ferriswheel OS 亮点与不足

**亮点**：
- 双架构（RISC-V+LoongArch）均达到可用水平，通过polyhal实现
- ext4文件系统通过lwext4集成成熟稳定，双块设备挂载管理实用
- 动态链接加载机制完整（musl+glibc双兼容），AuxV构造符合Linux ABI
- AIO回调兼容（musl的`__aio_wake`）展现了细致的用户态兼容处理
- 同步原语丰富（自旋锁/阻塞锁/信号量/条件变量/Futex）
- 空闲调度器检查定时器避免错误关机

**不足**：
- **无COW**（最大短板）：fork时全量复制物理页
- **信号仅标志位**：无用户态信号处理函数调用，`rt_sigaction`为桩
- FIFO调度器无优先级/时间片/多核
- 管道缓冲区仅32字节
- 无VFS缓存/页缓存/目录缓存
- 无Swap/Zram/页面置换
- 无网络协议栈（仅本地socket）
- /proc伪文件系统仅在LoongArch内核有初步VFS注册

### Nonix OS 亮点与不足

**亮点**：
- mmap共享组机制创新地解决了fork后共享内存物理帧生命周期管理
- COW+懒加载内存管理完整
- 通过polyhal实现RISC-V+LoongArch双架构
- System V共享内存API完整
- 虚拟文件注册表支持/proc动态内容

**不足**：
- sigreturn未实现（触发panic），信号处理致命缺陷
- 管道缓冲区仅32字节
- 物理帧分配器虽为Buddy但受全局锁限制
- 挂载管理仅为信息记录，非真正挂载逻辑
- 单核仅hart 0启动

### TrustOS 亮点与不足

**亮点**：
- **信号机制最完整**：用户栈信号帧、SA_SIGINFO、SA_RESTART
- mmap共享组管理与COW结合良好
- Futex支持WAIT/WAKE/REQUEUE及超时
- 多板级适配（QEMU+VisionFive2）
- 系统调用实现质量高（105个，桩函数少）
- 管道64KB，显著大于其他项目

**不足**：
- **仅支持RISC-V单架构**
- FIFO调度无优先级
- 物理帧栈式分配器碎片化风险
- 无VFS页缓存
- 网络系统调用多为桩
- 无Swap/Zram

### NPUcore-Aspera 亮点与不足

**亮点**：
- **内存管理最全面**：Frame状态机+COW+Zram(LZ4)+Swap+三层OOM回收
- **LAFlex页表**：LoongArch TLB Refill内联汇编优化
- **双文件系统**：自研FAT32+自研Ext4(含Extent树)
- 自研HAL设计优秀，代码复用率高
- 目录树全局缓存+块缓存+页缓存
- 系统调用ID最多（117个）

**不足**：
- **网络仅loopback**（smoltcp），无真实网卡驱动
- FIFO调度无优先级
- Zram/Swap容量固定，无动态调整
- Ext4无日志机制
- ProcFS节点覆盖不足
- 单核运行

### Explosion OS 亮点与不足

**亮点**：
- **从零自研Ext4**（~7,000行）：含Extent树、块分配、Inode管理
- **自研网络协议栈**（lose-net-stack）：ARP/IPv4/TCP/UDP
- 独立crate架构（7个crate）模块化程度高
- COW Fork+mmap/mprotect内存管理完整
- 时间管理子系统完备（11种ClockId）
- 代码总量最大（~49,442行）

**不足**：
- **调度器最简单**：FIFO且priority字段未使用
- LoongArch仅完成约20%
- TCP缺乏状态机/重传/拥塞控制
- Ext4无日志机制
- 同步原语依赖单核中断禁用
- 信号仅支持致命信号终止

### ByteOS 亮点与不足

**亮点**：
- **唯一四架构支持**（RISC-V/x86_64/AArch64/LoongArch）
- **唯一异步执行器**：基于Rust Future/Waker的协作式调度
- **文件系统生态最丰富**：FAT32+Ext4+RAMFS+DevFS+ProcFS五合一
- Dentry缓存加速路径解析
- 信号机制完整（标准+实时信号+上下文保存恢复）
- 100+系统调用覆盖广泛

**不足**：
- **异步Waker为空操作**：阻塞唤醒逻辑不完整
- 无时间片/抢占式调度
- 无Swap/Zram
- 无UID/GID权限检查
- 部分系统调用实现不完整
- 无文件系统日志
- 依赖外部polyhal（受制于框架演进）

---

## 五、整体成熟度综合对比

以"运行标准Linux用户态程序（busybox/LTP）的能力"为基准，综合各维度评分：

| 维度(权重) | Ferriswheel OS | Nonix OS | TrustOS | NPUcore-Aspera | Explosion OS | ByteOS |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **内存管理(20%)** | 60 | 80 | 80 | **95** | 75 | 75 |
| **文件系统(20%)** | 75 | 78 | 80 | **88** | 82 | **88** |
| **进程/信号(20%)** | 55 | 62 | **90** | 82 | 65 | 78 |
| **系统调用(15%)** | 72 | 68 | **88** | 85 | 70 | 82 |
| **架构可移植性(10%)** | 80 | 80 | 40 | **90** | 55 | **95** |
| **调度与并发(5%)** | 55 | 50 | 55 | 55 | 50 | **65** |
| **设备/网络(10%)** | 50 | 45 | 50 | 60 | **72** | 70 |
| **加权总分** | **65.3** | **68.2** | **75.8** | **81.7** | **70.0** | **80.1** |

### 综合排名

| 排名 | 项目 | 加权分 | 核心优势 | 核心短板 |
|:---:|------|:---:|------|------|
| 1 | **NPUcore-Aspera** | 81.7 | 内存管理最全面(状态机+Zram+Swap+OOM)，自研双文件系统+HAL | 网络仅loopback，单核 |
| 2 | **ByteOS** | 80.1 | 四架构+异步调度+五文件系统生态 | 异步Waker不完整，无Swap |
| 3 | **TrustOS** | 75.8 | 信号机制最优，系统调用质量最高 | 仅单架构(RISC-V) |
| 4 | **Explosion OS** | 70.0 | 自研Ext4+自研网络协议栈，工程量最大 | 调度最简，LoongArch未完成 |
| 5 | **Nonix OS** | 68.2 | mmap共享组创新，COW+懒加载 | sigreturn致命缺陷 |
| 6 | **Ferriswheel OS** | 65.3 | 双架构+动态链接完整，ext4成熟 | **无COW，信号仅标志位** |

---

## 六、分类评价

### 内存管理深度梯队

- **第一梯队（完整内存管理）**：NPUcore-Aspera（唯一具备Swap+Zram+OOM的项目）
- **第二梯队（COW+mmap完整）**：Nonix OS、TrustOS、Explosion OS、ByteOS
- **第三梯队（基础内存管理）**：Ferriswheel OS（无COW）

### 文件系统实现路线分叉

- **C库绑定路线**（快速获得成熟ext4）：Ferriswheel OS、Nonix OS、TrustOS、ByteOS
- **自研路线**（完全代码可控）：NPUcore-Aspera、Explosion OS

两种路线各有优劣：C库绑定路线开发效率高、功能稳定，但存在FFI开销和调试困难；自研路线工程量大，但可控性强且可针对内核特性优化。NPUcore-Aspera在自研路线上做到了双文件系统+完整缓存，是自研路线的标杆。

### 信号机制成熟度

- **完整实现**：TrustOS（SA_SIGINFO+SA_RESTART）、NPUcore-Aspera、ByteOS
- **框架存在但有关键缺陷**：Nonix OS（sigreturn panic）
- **基础实现（仅致命信号）**：Explosion OS
- **最小实现（仅标志位）**：Ferriswheel OS

### 架构可移植性

- **极致**：ByteOS（四架构）
- **优秀**：NPUcore-Aspera（自研HAL双架构）、Nonix OS（polyhal双架构）、Ferriswheel OS（polyhal双架构）
- **受限**：Explosion OS（LoongArch仅20%）
- **单点**：TrustOS（仅RISC-V）

---

## 七、评审意见

Ferriswheel OS是一个定位清晰、工程务实的比赛级操作系统内核。在六个对比项目中，其系统调用覆盖数量（约99个）处于中上水平，ext4文件系统通过lwext4 C库绑定获得了成熟稳定的支持，动态链接加载机制（musl/glibc双兼容）和双架构（RISC-V+LoongArch）实现也体现了良好的工程广度。

然而，与对比项目相比，Ferriswheel OS在两个核心子系统上存在明显短板：

**其一，内存管理缺乏COW（写时复制）机制。** 全部五个对比项目均实现了COW，而Ferriswheel OS在fork时执行全量物理页复制。这不仅导致进程创建性能显著劣于其他项目，也意味着在运行fork密集型测试（如LTP的fork测试）时内存效率最低。考虑到Ferriswheel OS已实现mmap的MAP_SHARED机制（通过`is_shared`标志和`shared_frames`向量），其代码基础已具备扩展COW的条件，这一缺失主要是实现优先级的选择问题。

**其二，信号机制仅为标志位级别。** Ferriswheel OS是六个项目中唯一未实现用户态信号处理函数调用的。TrustOS的信号帧构建、SA_SIGINFO传递和SA_RESTART重启代表了比赛内核中信号实现的最高水平。Ferriswheel OS的`rt_sigaction`返回0（桩函数），这意味着任何依赖信号处理的用户态程序（如通过`kill -SIGUSR1`测试进程间通信的用例）将完全无法工作。

**优势方面**，Ferriswheel OS的同步原语体系（自旋锁/阻塞锁/信号量/条件变量/Futex）在六个项目中种类最为丰富。进程级同步原语管理（将mutex/semaphore/condvar列表存储在PCB中）的设计简化了进程退出时的资源回收。双块设备挂载管理和AIO回调兼容（musl的`__aio_wake`处理）也体现了对用户态兼容性的细致考量。

**综合建议**：Ferriswheel OS若要在比赛或技术评估中获得更高评价，最优先的改进方向是实现COW机制（直接影响fork性能基准测试）和补全信号处理函数调用路径（涉及`rt_sigaction`/`sigreturn`/用户栈信号帧构建）。这两个改进将使其加权评分从65.3提升至约75分，进入TrustOS所在的中上梯队。中长期来看，参考NPUcore-Aspera的Frame状态机设计引入页面置换机制，以及参考ByteOS的多架构抽象经验进一步优化polyhal使用方式，将有助于缩小与顶尖项目的差距。