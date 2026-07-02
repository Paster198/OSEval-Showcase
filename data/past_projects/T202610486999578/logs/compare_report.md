# 对比分析报告

## 一、项目概览

下表列出当前项目（StarryOS / NexusCore）与五个选中对比项目的基本信息：

| 属性 | StarryOS (NexusCore, 当前项目) | 海南大学-StarryOS | 天津理工-WenyiOS | 燕山大学-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| **内核类型** | 宏内核 | 宏内核 | 宏内核 | Unikernel风格宏内核 | 宏内核 | 宏内核 |
| **生态基础** | ArceOS + 补丁层 | ArceOS | ArceOS (starry-next分支) | ArceOS 组件化框架 | ArceOS/Starry-next | ArceOS/Starry/rCore |
| **支持架构** | RISC-V, LoongArch, AArch64 (x86_64部分) | RISC-V, x86_64, AArch64, LoongArch64 | x86_64, AArch64, RISC-V, LoongArch64 | RISC-V, LoongArch64, AArch64, x86_64 | RISC-V, LoongArch64 (AArch64/x86存根) | RISC-V (仅) |
| **自有代码量** | ~63,360行 | ~33,000行 (估计) | ~10,400行 | ~5,750行 | ~22,800行 | ~61,441行 |
| **系统调用数** | ~269个 | ~100+个 | ~100+个 | ~99个 | ~200个 | ~101个 |
| **综合完整度** | 85% | 78% | ~70% | 60-65% | 83% | 75% |

---

## 二、架构设计对比

| 维度 | StarryOS (NexusCore) | 海南大学-StarryOS | 天津理工-WenyiOS | 燕山大学-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| **分层方式** | 系统调用层 + 内核子系统 + 补丁增强ArceOS | 入口层 + API层 + 核心层 | 入口层(starry) + API层 + 核心层 | 入口层 + 核心层 + API层 | API层(xapi) + 核心层(xcore) + 模块层(xmodules) | 异步syscall层 + 内核crate + HAL层 |
| **模块化程度** | 极高：每个子系统独立目录，伪文件系统分6种独立实现 | 高：按子系统分文件，含独立crate（lwext4_rust, page_table_multiarch） | 高：核心逻辑集中在starry-core，系统调用在starry-api | 高：以5750行代码实现43文件，极简但清晰 | 极高：167源文件，6个独立子crate，三层严格分离 | 极高：339源文件，50个workspace crate，按子系统彻底解耦 |
| **资源隔离机制** | scope_local + ActiveScope自动切换 | AxNamespace命名空间隔离 | AxNamespace命名空间隔离 | AxNamespace命名空间隔离 | 进程级资源管理 | BTreeMap全局任务表 |
| **ArceOS集成方式** | patches目录覆盖6个crate，非侵入式扩展 | 直接依赖，含crates扩展 | 基于starry-next分支二次开发 | 深度复用ArceOS基座，降低自有代码 | 在arceos基座上构建xapi/xcore/xmodules | Starry基础上自建 |
| **架构创新** | Unikernel到宏内核演进 + 补丁机制 | COW + 分片Futex | Trampoline固定地址映射 | Unikernel编译期嵌入用户程序 | LRU页缓存 + VMA按需加载 | async/await异步系统调用模型 |

**分析**：NexusCore在架构上最突出的特点是**补丁层机制**——通过`[patch.crates-io]`覆盖上游crate而非fork，这与freeOS直接依赖ArceOS、WenyiOS分支开发的策略形成对比，在可维护性和上游跟随能力上更优。StarryX的三层严格分离（xapi/xcore/xmodules）在模块化方面最为规范，而KeepOnOS的50个crate解耦达到极致但复杂度也最高。

---

## 三、子系统实现深度对比

### 3.1 系统调用层

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| 系统调用数量 | **269** | ~100+ | ~100+ | ~99 | ~200 | ~101 |
| 分发机制 | 枚举match分支 | 枚举match分支 | 枚举match分支 | 枚举match分支 | 枚举match分支 | 异步分发+deal_result |
| 架构适配 | cfg条件编译，x86_64兼容旧调用 | cfg条件编译 | cfg条件编译 | cfg条件编译 | cfg条件编译 | RISC-V专用 |
| io_uring | **已实现** | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| BPF/eBPF | **完整Map+最小解释器** | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| inotify/fanotify | **完整实现** | 未实现 | 未实现 | 未实现 | 部分ioctl | 未实现 |
| sendfile/splice | **已实现** | 未实现 | 未实现 | 未实现 | 已实现 | 未实现 |

NexusCore在系统调用覆盖面（269 vs 最高200）上具有**压倒性优势**，特别是io_uring、BPF、inotify/fanotify等高级Linux特性在其他五个项目中均未实现。

### 3.2 内存管理

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| COW写时复制 | **完整（4种后端）** | 已实现 | 未实现 | **未实现** | 已实现 | 未实现 |
| 大页支持 | 支持(HUGETLB) | 支持(4K/2M/1G) | 未明确支持 | 支持(4K/2M/1G) | 支持(2M/1G) | 未明确支持 |
| 文件映射后端 | FileBackend + page cache | FileBackend | 基础文件映射 | 基础文件映射 | LRU页缓存+脏页回写 | 文件后端+延迟分配 |
| brk堆管理 | 完整动态扩展 | 简单实现 | **固定64KB** | **固定64KB** | 完整动态 | 基础实现 |
| ASLR | 已实现(mmap_rnd) | 未明确 | 未明确 | 未明确 | 未明确 | 未明确 |
| 帧引用计数 | 全局FRAME_TABLE | 未明确 | 未明确 | 未明确 | 未明确 | Bitmap+Slab/Buddy |
| swap交换 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |

NexusCore的内存管理子系统在**COW实现深度**和**后端抽象多样性**上领先。StarryX的LRU页缓存+脏页回写机制是独特的亮点。WenyiOS和freeOS的brk固定64KB是明显局限。KeepOnOS的Bitmap+Slab/Buddy两级物理分配器在物理内存管理层有独立实现。

### 3.3 文件系统

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| VFS抽象 | **FileLike trait + 多态** | FilesystemOps/NodeOps trait | FileLike trait | FileLike trait | FileLike trait | RootDirectory + VFS |
| ext4支持 | 通过axfs | **lwext4_rust绑定** | lwext4_rust绑定 | 未明确 | 已支持 | 已支持 |
| FAT支持 | 通过axfs | 基础支持 | vfat(mount简化) | 未明确 | 已支持 | 已支持+内存模拟链接 |
| /proc完整度 | **极高** (完整进程树) | 硬编码静态数据 | 部分实现 | 仅/proc/self/exe | 完整(含进程信息) | **空壳**(ramfs挂载空目录) |
| /sys支持 | **已实现** | 未明确 | 未明确 | 未实现 | 已实现 | **空壳** |
| /dev设备 | **15+设备含TTY/PTY** | 基础设备节点 | 基础设备节点 | 基础设备节点 | 含TTY基础支持 | 基础设备节点 |
| tmpfs | **独立实现(256M+64M)** | 基础tmpfs | 未明确 | 未实现 | 独立实现 | 未明确 |
| tracefs | **已实现(LTP兼容)** | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| journalfs | **已实现(带崩溃恢复)** | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| 管道缓冲区 | 未明确 | yield等待 | **256字节+yield** | **256字节+yield** | **64KB环形缓冲** | VecDeque环形缓冲 |

NexusCore在伪文件系统方面具有**无可争议的领先优势**：六种文件系统（proc/sys/dev/tmpfs/journalfs/tracefs）均达到高度完整，其中journalfs（带事务日志和崩溃恢复）和tracefs（LTP兼容）是独有特性。StarryX的64KB管道缓冲区和sendfile/splice是文件I/O性能上的亮点。KeepOnOS通过内存映射模拟FAT32链接是一个巧妙的工程妥协。

### 3.4 网络子系统

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| 协议支持 | UDP + ICMP + packet | TCP/UDP基础 | TCP/UDP基础 | **仅对象封装** | TCP/UDP/Unix域 | TCP/UDP(基于smoltcp) |
| rtnetlink | **完整实现(1010行)** | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| 网络命名空间 | **完整CLONE_NEWNET** | 部分 | 部分 | 未实现 | 未实现 | 未实现 |
| 虚拟网络设备 | **veth/dummy/vti/loopback** | 基础 | 基础 | 未实现 | 未实现 | 基础 |
| IPv6 | 基础支持 | 未明确 | **未实现** | 地址转换 | 未明确 | **未实现** |
| 系统调用接入 | 完整 | 完整 | 完整 | **未接入主分发器** | 完整 | 完整 |

NexusCore的网络子系统是六个项目中**唯一完整实现rtnetlink协议和网络命名空间**的，这使其具备`ip link`/`ip addr`/`ip netns`等标准Linux网络管理工具的运行能力。freeOS虽然封装了Socket对象但未接入系统调用分发器，网络功能实际不可用。

### 3.5 进程管理与同步

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| clone标志覆盖 | **25个标志** | 多个标志 | 多个标志 | 多个标志 | 完整 | 多个标志 |
| execve能力 | shebang+脚本重定向 | ELF+解释器 | ELF加载 | ELF加载 | ELF+shebang | ELF加载 |
| 多线程execve | 支持 | 未明确 | **返回EAGAIN** | **不支持** | 支持 | 支持 |
| 进程组/会话 | 完整 | **桩实现** | 未明确 | **setsid占位** | 完整 | 完整 |
| 调度策略 | 依赖axtask | 依赖axtask | 依赖axtask | 依赖axtask | 依赖axtask | **FIFO/RR/CFS可选** |
| CPU亲和性 | 未明确 | 未明确 | 未明确 | 未明确 | 未明确 | **已支持** |
| futex实现 | **分片表+Private/Shared+file-backed+robust+futex_waitv** | 分片表+基础操作 | 基础WAIT/WAKE/REQUEUE | WAIT/WAKE/REQUEUE | WAIT/WAKE/REQUEUE/BITSET+robust | WAIT/WAKE/REQUEUE/BITSET+robust |

NexusCore在futex实现上达到**六个项目中的最高水平**：支持进程私有、共享内存、文件映射三种键空间，以及bitset、requeue、robust list、futex_waitv。KeepOnOS在调度策略上具有独特优势（三种算法可选+CPU亲和性）。WenyiOS和freeOS在多线程execve上的限制降低了POSIX兼容性。

### 3.6 信号与IPC

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| 信号机制 | **完整(含sigqueue/timedwait)** | 完整 | Trampoline机制 | 固定地址Trampoline | 多架构Trampoline | SA_SIGINFO+嵌套 |
| SIGSTOP/SIGCONT | 未完全实现 | 未实现 | **未实现** | **未实现** | 未明确 | **标记unimplemented** |
| CoreDump | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| System V 消息队列 | **完整实现** | 未实现 | 未实现 | 未实现 | **完整实现** | 未实现 |
| System V 信号量 | 未实现 | **完整(含SEM_UNDO)** | 未实现 | 未实现 | **完整(含SEM_UNDO)** | 未实现 |
| System V 共享内存 | **完整实现** | **完整(含GC)** | **完整(含GC)** | 完整 | **完整实现** | 已实现 |
| POSIX IPC | 未实现 | 未实现 | 未实现 | 未实现 | **未实现** | 未实现 |

NexusCore和StarryX在IPC方面各有侧重：NexusCore实现了消息队列+共享内存（缺信号量），StarryX实现了全部三种System V IPC（消息队列+信号量+共享内存）。海南StarryOS实现了信号量+共享内存（含SEM_UNDO），WenyiOS和freeOS仅有共享内存（含GC回收是亮点）。六个项目均未实现POSIX IPC（mq_*/sem_open/shm_open）。SIGSTOP/SIGCONT作业控制是所有项目的共同缺陷。

### 3.7 设备与交互

| 指标 | NexusCore | 海南-StarryOS | 天津-WenyiOS | 燕山-freeOS | 杭电-StarryX | 南开-KeepOnOS |
|---|---|---|---|---|---|---|
| TTY子系统 | **N_TTY行规程+PTM/PTS** | 基础终端 | 基础控制台 | 部分ioctl | 基础TTY(/dev/tty) | 基础交互 |
| 终端作业控制 | 部分实现 | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |
| loop设备 | **已实现(loop-control+16设备)** | 未明确 | 未明确 | 未实现 | 已实现 | 未明确 |
| 帧缓冲 | /dev/fb0 | 未明确 | 未明确 | 未实现 | 未明确 | VirtIO GPU |
| 硬件平台 | QEMU virt | QEMU + VisionFive2 | QEMU | QEMU | QEMU + VisionFive2 | QEMU + **VisionFive2** |
| 自定义硬件驱动 | 未明确 | PCI/SD/VirtIO | dwmac/fxmac/ixgbe/SD | 未明确 | 未明确 | **PLIC/RTC/SD自主实现** |

NexusCore的TTY子系统是唯一完整实现N_TTY线路规程和PTM/PTS伪终端对的，这使其具备了运行交互式终端程序（如vim等）的基础能力。KeepOnOS在硬件适配方面最为突出，自主实现了PLIC中断控制器和RTC驱动，且同时支持QEMU和VisionFive2实体开发板。

---

## 四、技术亮点与创新对比

| 项目 | 核心亮点 |
|---|---|
| **NexusCore (当前)** | (1) **补丁层架构**——非侵入式扩展ArceOS，兼顾上游跟随与定制；(2) **scope_local资源隔离**——任务切换时的自动scope切换，消除显式current指针；(3) **file-backed futex**——通过(device,inode)哈希实现跨进程文件futex；(4) **journalfs**——唯一实现带事务日志和崩溃恢复的内存文件系统；(5) **bpftrace兼容**——最小eBPF解释器+ringbuf map；(6) **LTP白名单嵌入**——编译时嵌入测试配置，运行时自适应 |
| **海南-StarryOS** | (1) **分片Futex表**——基于SMP核心数的哈希分片，降低多核锁竞争；(2) **多架构页表crate**——独立抽象RISC-V/AArch64/x86/LA四种页表；(3) **lwext4 ext4完整支持**——通过C库绑定实现完整ext4 |
| **天津-WenyiOS** | (1) **固定地址Trampoline**——映射至0x4001_0000，避免用户栈复制；(2) **共享内存垃圾回收**——含完整引用计数和自动回收；(3) **10,400行代码实现100+调用**——代码密度高 |
| **燕山-freeOS** | (1) **5750行极简代码覆盖99个syscall**——代码效率最高；(2) **Unikernel编译期嵌入**——用户程序通过.incbin链接，无传统init进程；(3) **自动化评分脚本**——内置judge_basic.py等多套评测脚本 |
| **杭电-StarryX** | (1) **LRU页缓存+脏页回写**——唯一实现完整页面淘汰策略；(2) **最完整System V IPC**——同时实现消息队列+信号量+共享内存；(3) **sendfile/splice零拷贝**——高级I/O接口实现；(4) **~200 syscall**——选中项目中syscall数最高 |
| **南开-KeepOnOS** | (1) **async/await异步系统调用**——六个项目中唯一采用异步模型；(2) **CFS/RR/FIFO三种调度**——调度策略最丰富且有CPU亲和性；(3) **VisionFive2硬件适配**——自主PLIC/RTC/SD驱动；(4) **FAT32链接内存模拟**——巧妙的工程妥协解决FAT32先天缺陷 |

---

## 五、不足与缺失对比

| 项目 | 主要缺陷 |
|---|---|
| **NexusCore (当前)** | TCP依赖axnet(smoltcp)缺乏自主实现；无swap交换机制；PID/用户/cgroup命名空间为空壳；x86_64支持不完整(仅cfg条件编译)；部分Capability为空壳 |
| **海南-StarryOS** | procfs硬编码静态数据无法反映系统动态状态；进程组/会话管理为桩实现；epoll采用轮询遍历非事件驱动；管道使用yield而非等待队列；部分rlimit为桩 |
| **天津-WenyiOS** | brk堆固定64KB限制严重；多线程execve直接返回EAGAIN；管道仅256字节且使用yield；mount仅记录不实际挂载；I/O多路复用为忙等待；rlimit未实质enforce |
| **燕山-freeOS** | 网络系统调用未接入主分发器（功能不可用）；brk固定64KB；无COW机制；管道256字节+yield；epoll 1000次循环硬编码防止死锁；权限检查基本缺失；Unikernel风格限制通用性 |
| **杭电-StarryX** | epoll底层依赖poll转换非真正事件驱动；msync/madvise为存根；缺失Raw Socket和Netlink；信号中断重启机制不完善；无cgroups和完整namespace |
| **南开-KeepOnOS** | procfs/sysfs为空壳（仅ramfs空目录）；SIGSTOP/SIGCONT标记unimplemented；内核栈数量硬编码110个；缺失epoll；仅支持RISC-V单架构；资源限制多为桩函数 |

**共同缺陷**：六个项目均未实现swap交换、POSIX IPC、cgroups、完整的CoreDump机制、seccomp。除NexusCore外均未实现io_uring和BPF。除KeepOnOS外均未自建调度器。

---

## 六、整体成熟度综合评分

以"能够运行标准Linux用户态程序（如BusyBox、Lua、LTP基础用例）的通用Linux兼容宏内核"为100%基准：

| 项目 | 系统调用 | 内存管理 | 文件系统 | 网络 | 进程/信号 | IPC | 设备/交互 | **加权综合** |
|---|---|---|---|---|---|---|---|---|
| **NexusCore** | 95% | 85% | 95% | 80% | 85% | 75% | 85% | **87%** |
| **StarryX** | 90% | 80% | 85% | 75% | 85% | 85% | 70% | **82%** |
| **海南-StarryOS** | 75% | 75% | 80% | 70% | 75% | 70% | 65% | **74%** |
| **KeepOnOS** | 75% | 80% | 70% | 65% | 70% | 50% | 80% | **71%** |
| **WenyiOS** | 70% | 65% | 70% | 65% | 75% | 65% | 55% | **68%** |
| **freeOS** | 70% | 60% | 65% | 40% | 70% | 60% | 50% | **61%** |

评分说明：
- **NexusCore (87%)**：269个系统调用、6种伪文件系统、rtnetlink+net namespace、io_uring+BPF、journalfs独有，使其在系统调用覆盖面、文件系统和网络子系统上远超其他项目
- **StarryX (82%)**：~200 syscall + 完整System V IPC三项（独有消息队列+信号量）+ LRU页缓存+sendfile/splice，在IPC完整度和I/O性能优化上领先
- **海南-StarryOS (74%)**：100+ syscall + COW + 分片Futex + ext4完整支持，核心扎实但动态系统信息缺失
- **KeepOnOS (71%)**：异步调度模型+CFS三种调度+VisionFive2硬件适配是独特优势，但仅RISC-V单架构和procfs/sysfs空壳严重拉低分值
- **WenyiOS (68%)**：Trampoline+共享内存GC设计良好，但brk固定64KB和多线程execve返回EAGAIN等硬限制影响实用性
- **freeOS (61%)**：5750行极简代码实现99个syscall，代码效率最高，但网络不可用、无COW、Unikernel风格限制通用性

---

## 七、各项目总结评价

### StarryOS (NexusCore) —— 当前项目

综合实力最强的项目。269个系统调用、六种伪文件系统、io_uring、BPF/eBPF、rtnetlink、网络命名空间、journalfs等高级特性均为独有。补丁层架构设计体现了优秀的工程判断力——既保持了与ArceOS上游的兼容性，又实现了深度定制。scope_local资源隔离和file-backed futex展现出对Linux内核机制的深刻理解。主要不足在于TCP依赖外部协议栈、缺少swap和cgroups。适合作为ArceOS生态中Linux兼容层的标杆参考实现。

### 杭州电子科技大学-StarryX

在六个对比项目中整体排名第二。最突出的优势是System V IPC的完整实现（唯一同时支持消息队列、信号量、共享内存三项）和LRU页缓存+脏页回写机制。~200个系统调用数量在选中项目中最高。三层严格分离的模块化架构（xapi/xcore/xmodules）工程规范性最佳。主要短板是epoll底层基于poll转换而非真正事件驱动，以及网络子系统缺乏rtnetlink深度。与NexusCore相比，在高级Linux特性（io_uring、BPF、网络命名空间、journalfs）上存在显著差距。

### 海南大学-StarryOS

同属ArceOS生态的早期宏内核实现。COW机制和分片Futex表设计展现了性能优化意识，lwext4 ext4绑定提供了完整的磁盘文件系统支持。但procfs采用硬编码静态数据、进程组/会话管理为桩实现、epoll采用轮询遍历等妥协设计限制了其作为通用操作系统的实用性。与NexusCore相比，虽然在基础架构上相似，但在系统调用覆盖面（100+ vs 269）、伪文件系统深度和网络子系统完整性上存在代际差距。

### 南开大学-KeepOnOS (ZeroOS)

技术路线最独特。async/await异步系统调用模型在所有对比项目中独树一帜，CFS/RR/FIFO三种调度策略和CPU亲和性支持体现了对调度子系统的深度投入。VisionFive2实体开发板的PLIC/RTC/SD自主驱动展现了优秀的底层硬件能力。但仅支持RISC-V单架构、procfs/sysfs为空壳（仅ramfs挂载空目录）、SIGSTOP/SIGCONT标记为unimplemented、缺少epoll等缺陷严重限制了应用兼容性。适合作为异步内核调度模型的实验平台。

### 天津理工大学-WenyiOS

代码密度较高（10,400行实现100+系统调用），Trampoline固定地址映射和共享内存垃圾回收是设计亮点。但brk固定64KB、多线程execve返回EAGAIN、管道仅256字节且使用yield、mount不实际执行等妥协设计使其在POSIX严格兼容性上存在明显短板。与NexusCore相比，在内存管理灵活性、文件系统深度和网络能力上差距明显。更适合作为ArceOS宏内核的早期快速原型参考。

### 燕山大学-freeOS (starry-next)

以5750行自有代码实现99个系统调用，代码效率在所有项目中最高。AxNamespace资源隔离和固定地址信号跳板设计体现了"少即是多"的工程哲学。但其Unikernel风格（用户程序编译期嵌入）从根本上限制了通用性；网络系统调用未接入主分发器导致网络功能实际不可用；brk固定64KB、无COW、epoll硬编码1000次循环等简化设计在运行复杂应用时会遇到瓶颈。适合作为最小化Linux兼容层的概念验证。

---

## 八、评审意见

从操作系统内核比赛的评审视角出发，综合六个基于ArceOS生态的宏内核项目的深度对比分析，StarryOS（NexusCore）在以下方面表现突出：

**系统调用覆盖面与深度**：实现269个Linux系统调用，远超其他五个项目（最高约200个），且是唯一实现io_uring、BPF/eBPF解释器、inotify、fanotify、rtnetlink完整协议和网络命名空间的项目。这表明团队对Linux内核接口体系有全面深入的理解。

**伪文件系统完整度**：六种伪文件系统（proc、sys、dev、tmpfs、journalfs、tracefs）均达到高度完成度，其中journalfs（带事务日志和崩溃恢复）和tracefs（LTP兼容）为独有特性。N_TTY线路规程和PTM/PTS伪终端对的完整实现也远超其他项目的基础TTY支持。

**架构设计的工程判断力**：补丁层（patches）机制而非fork的方式扩展ArceOS框架，体现了优秀的软件工程素养——在保持上游兼容性的同时实现深度定制。scope_local资源隔离模型消除了传统内核中显式的current指针查找，设计优雅。

**futex实现的深度**：支持进程私有、共享内存、文件映射三种键空间，以及bitset、requeue、robust list、futex_waitv，达到生产级水平，是六个项目中唯一能正确处理跨文件futex同步的。

**主要待改进方向**：TCP协议栈自主实现（目前依赖smoltcp）、swap交换机制、cgroups资源控制、完整的SIGSTOP/SIGCONT作业控制，以及x86_64架构的完整适配。

综合来看，NexusCore在ArceOS生态的宏内核项目中处于**领先地位**，其系统调用覆盖广度、伪文件系统深度和网络子系统的完整性均达到该生态内的最高水平，具备作为操作系统教学、内核研究和Linux兼容层实验的优秀参考价值。