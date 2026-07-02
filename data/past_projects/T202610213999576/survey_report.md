# QuasarOS 内核项目初步调查报告

## 一、项目概述

**Quasar** 是一个面向 2026 操作系统内核设计赛的 Rust `no_std` 内核项目，同时在 **RISC-V64** 和 **LoongArch64** 两个架构上提供接近 Linux 用户态 ABI 的运行环境。项目基于去年东北赛区 OS 内核设计赛项目继续演进。

- **内核总代码量**：约 85,700 行（174 个 `.rs`/`.S` 文件）
- **用户态代码量**：约 5,800 行
- **许可证**：项目根目录有 `LICENSE` 文件

---

## 二、仓库文件组织结构

```
repo/
├── Makefile                    # 顶层构建编排：user + os → kernel-rv / kernel-la
├── README.md                   # 项目说明与架构概要
├── .gitignore
├── LICENSE
├── os/                         # Rust no_std 内核（主体）
│   ├── Cargo.toml              # 内核 crate 依赖声明
│   ├── Makefile                # 内核构建规则
│   ├── build.rs                # 构建脚本：将用户态 ELF 打包进内核镜像
│   ├── cargo-config/           # 评测环境备用 .cargo 配置
│   └── src/
│       ├── main.rs             # 内核入口与启动顺序
│       ├── console.rs          # SBI 串口输出（print/println）
│       ├── global_logger.rs    # 全局日志
│       ├── lang_item.rs        # Rust no_std 语言项
│       ├── linker-rv.ld        # RISC-V 链接脚本
│       ├── linker-la.ld        # LoongArch 链接脚本
│       ├── arch/               # 架构抽象层
│       ├── drivers/            # 设备驱动（VirtIO block/net）
│       ├── fs/                 # 文件系统（VFS + 多后端）
│       ├── loader/             # ELF 解析与内置程序加载
│       ├── mm/                 # 内存管理
│       ├── net/                # 网络子系统
│       ├── process/            # 进程管理
│       ├── signal/             # 信号子系统
│       ├── syscall/            # 系统调用分发与实现
│       └── uapi/               # Linux ABI 常量定义
├── user/                       # 用户态库与内置程序
│   ├── Cargo.toml
│   ├── Makefile
│   ├── build.rs
│   └── src/
│       ├── lib.rs              # 用户库入口
│       ├── syscall.rs          # 系统调用封装
│       ├── console.rs          # 用户态输出
│       ├── lang_item.rs        # 用户态语言项
│       ├── linker-rv.ld / linker-la.ld
│       └── bin/
│           ├── boot/           # init、testmgr、ltp_runner、osh
│           ├── tools/          # awk/cp/file/gzip/ln/mv/readelf/sed/seq/wc/which
│           └── net/            # ifconfig/ip/netstat
├── scripts/                    # 评测与 LTP 辅助脚本
│   ├── score_all.py            # 总评分脚本
│   ├── score/                  # 各测试项评分脚本 (basic/busybox/cyclictest/iozone/iperf/libcbench/libctest/lmbench/ltp/lua/netperf)
│   ├── run_ltp_filter.sh       # LTP 用例过滤运行
│   └── run_ltp_case_snapshot.sh
├── docx/                       # 文档与演示材料
│   ├── QuasarOS-初赛文档.pdf
│   ├── QuasarOS 初赛PPT.pptx
│   ├── ai使用说明.md
│   ├── debug.md
│   ├── img/00-内核架构图.png
│   └── log/Development-Log.md
└── git-etc-misc/               # Git 与日志杂项
    ├── git.md
    └── log.md
```

---

## 三、子系统划分

### 1. 架构抽象层 — `os/src/arch/`

| 子模块 | 路径 | 说明 |
|--------|------|------|
| RISC-V 架构 | `arch/riscv/` | config、trap（含汇编入口）、mm（页表标志/TLB）、timer、sbi、drivers（VirtIO transport） |
| LoongArch 架构 | `arch/loongarch/` | 与 RISC-V 对称的 config、trap、mm、timer、sbi、drivers |
| 架构门面 | `arch/mod.rs` | 通过 `#[cfg(target_arch)]` 在编译期选择具体架构 |

### 2. 内存管理 — `os/src/mm/`

| 源文件 | 功能 |
|--------|------|
| `address.rs` | `PhysAddr`/`VirtAddr`/`PhysPageNum`/`VirtPageNum` 地址抽象 |
| `frame_allocator.rs` | 物理页帧分配器 (`FrameTracker`) |
| `page_table.rs` | 页表操作 |
| `memory_set.rs` + `memory_set/` | 用户地址空间 (`MemorySet`)、VMA 管理、fork COW、ELF 加载、用户态访问 |
| `map_area.rs` | `MapArea` / `MapType` / 文件映射后端 |
| `layout.rs` | 用户态虚拟地址布局 |
| `swap.rs` | 页面交换 |
| `vmalloc.rs` | 内核虚拟地址分配 |
| `mod.rs` | 内核堆分配器 (`KernelHeapAllocator`)，含堆压力回收机制 |

### 3. 进程管理 — `os/src/process/`

| 源文件 | 功能 |
|--------|------|
| `pcb.rs` | 进程控制块 (`ProcessControlBlock`)、进程状态、TrapContext 帧 |
| `manager.rs` | 进程管理器：PID 分配、ready queue、当前进程切换、僵尸回收 |
| `exec/` | execve 执行链路：路径解析、ELF 镜像加载、解释器、shebang、TLS、栈初始化 |
| `current.rs` | 当前进程快速查询 |
| `comm.rs` | 进程名（prctl PR_SET_NAME） |
| `fault.rs` | 用户态缺页异常处理 |
| `recycle.rs` | 僵尸进程资源延迟回收 |
| `shared.rs` | 线程组共享结构（凭证、fd table、fs context、signal、SysV sem、rlimit） |

### 4. 文件系统 — `os/src/fs/`

| 子模块 | 路径 | 功能 |
|--------|------|------|
| VFS 核心 | `vfs_core/` | inode、dentry、file、superblock、mount、namei、address_space (page cache)、权限检查 |
| VFS 操作 | `vfs_core/ops/` | 约 20 个文件：create/remove/rename/regular_io/mmap/poll/pipe/lock_notify/path/metadata/xattr/virtual_file 等 |
| VFS API | `vfs_core/api.rs` | 对外统一 VFS 调用入口 |
| ext4 磁盘层 | `ext4/` | ext4 磁盘格式解析 (`ext4.rs` + `layout.rs`) |
| 文件系统后端 | `filesystems/` | ext4fs、ramfs、procfs、sysfs、devfs、pipefs、anon_inode |
| 块缓存 | `block/` | 块设备缓存层 (`cache.rs`) |
| fd 表 | `fdtable.rs` | 文件描述符表、FD_CLOEXEC |

### 5. 网络子系统 — `os/src/net/`

| 源文件 | 功能 |
|--------|------|
| `mod.rs` | 网络子系统入口、loopback/eth0 设备抽象、ifreq/ifconf ioctl、Netlink 信息导出 |
| `socket.rs` | 通用 socket 结构与地址族 |
| `tcp.rs` | TCP socket（基于 smoltcp） |
| `udp.rs` | UDP socket |
| `icmp.rs` | ICMP socket |
| `local.rs` | AF_UNIX 本地 socket |
| `netlink.rs` | NETLINK 最小兼容 |
| `packet.rs` | AF_PACKET 原始 socket |
| `alg.rs` | AF_ALG 加密算法 socket |
| `smol.rs` | smoltcp 协议栈初始化和轮询 |

### 6. 信号子系统 — `os/src/signal/`

| 源文件 | 功能 |
|--------|------|
| `mod.rs` | 信号递送核心：signal frame 安装、sigtimedwait、mask 管理、trampoline |
| `runtime.rs` | 信号运行时状态：pending 队列、mask 表、waiter 管理 |
| `constants.rs` | 信号编号、标志位、si_code 等常量 |
| `types.rs` | sigaction、siginfo、ucontext、stack_t 等 ABI 类型 |

### 7. 系统调用层 — `os/src/syscall/`

| 子模块 | 路径 | 覆盖范围 |
|--------|------|----------|
| 分发入口 | `mod.rs` | ~200 个 syscall number 定义与分派 |
| 文件系统 | `fs/` | open/read/write/stat/getdents/rename/mount/ioctl/xattr/splice/copy_file_range 等 |
| 内存 | `mm.rs` | brk/mmap/munmap/mprotect/mremap/msync/madvise 等 |
| 进程 | `process/` | clone/clone3/exec/wait/exit/futex/rlimit/prctl/capability/sched/shm 等 |
| 信号 | `signal/mod.rs` | rt_sigaction/rt_sigprocmask/rt_sigsuspend/rt_sigtimedwait/kill/tkill |
| 时间 | `time/` | clock/nanosleep/getrusage/timer/timerfd |
| 网络 | `net.rs` | socket/bind/listen/connect/accept/send/recv/setsockopt 等 |
| 系统信息 | `system/` | uname/sysinfo |
| 用户访问 | `uaccess.rs` | 用户态指针 checked copy |

### 8. 设备驱动 — `os/src/drivers/`

- `block.rs`：VirtIO 块设备驱动封装
- `net.rs`：VirtIO 网络设备驱动封装

### 9. ELF 加载器 — `os/src/loader/`

- `elf.rs`：ELF 头解析、程序头、TLS 模板、动态重定位、解释器路径
- `builtin.rs`：从内核镜像中获取内置用户程序数据
- `mod.rs`：聚合导出

### 10. UAPI 常量 — `os/src/uapi/`

Linux 用户态 ABI 常量：errno、signal、socket、ioctl、poll、mm、fs、futex、process、termios、elf、auxv。

### 11. 用户态程序 — `user/`

用户库 (`src/lib.rs`) 提供 syscall 封装，内置程序分为三类：
- **启动/管理**：`init`、`testmgr`、`ltp_runner`、`osh`（shell）
- **工具**：awk、cp、file、gzip、ln、mv、readelf、sed、seq、wc、which
- **网络**：ifconfig、ip、netstat

---

## 四、编译构建工具需求

根据 `Makefile`、`Cargo.toml` 和 `build.rs` 分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| **Rust 工具链** (rustc, cargo) | 内核与用户态编译。需要 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 两个 cross-target |
| **GNU Make** | 顶层与子目录构建编排 |
| **Rust 依赖 crate**（cargo 自动拉取） | buddy_system_allocator、spin、bitflags、hashbrown、riscv、lazy_static、virtio-drivers、xmas-elf、smoltcp、log |

构建流程：
1. `make kernel-rv` 或 `make kernel-la` 在顶层 `Makefile` 中先构建 `user/` 目录的用户程序，再构建 `os/` 目录的内核，最后将产物 ELF 复制到项目根目录。
2. `os/build.rs` 在编译期读取 `user/Cargo.toml` 的 `[[bin]]` 清单，将已构建的用户态 ELF 通过 `.incbin` 方式嵌入内核镜像。
3. 支持 `MODE=release` / `MODE=debug` 以及 `LOG` 日志级别控制。

编译产物：`kernel-rv`（RISC-V 内核 ELF）和 `kernel-la`（LoongArch 内核 ELF）。

---

## 五、初步评估总结

该项目是一个**中等规模**（内核约 8.6 万行 Rust）的类 Linux 内核实现，覆盖了操作系统核心子系统的广泛范围：

- **已实现**：内存管理（含 mmap/COW/swap）、VFS 框架与多后端文件系统（ext4/ramfs/procfs/sysfs/devfs/pipefs）、完整的进程生命周期管理（fork/clone/exec/wait/exit）、信号子系统、约 200 个 Linux 系统调用、基于 smoltcp 的网络栈（TCP/UDP/ICMP/AF_UNIX）、VirtIO 块设备和网络驱动。
- **双架构支持**：RISC-V64 和 LoongArch64，通过编译期 `#[cfg]` 切换。
- **比赛导向**：内核功能以支撑 LTP、busybox、libc-test、lmbench、iozone、iperf、netperf 等评测基准为目标。