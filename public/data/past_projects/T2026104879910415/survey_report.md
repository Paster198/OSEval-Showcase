# OS 内核项目初步调查报告

## 项目概述

该项目名为 **VOS**（VOS-kernel），是基于 **ArceOS** 操作系统框架构建的竞赛级 Linux 兼容内核，参赛目标为 2026 年全国大学生操作系统设计赛"内核实现"赛道。项目采用 Rust 语言编写，目标架构为 **RISC-V64** 和 **LoongArch64**，以 QEMU 虚拟环境为主要运行平台。

---

## 仓库文件组织结构

```
/
├── kernel/                  # 【核心】VOS 内核主 crate（比赛核心代码）
│   ├── Cargo.toml           #   内核 crate 清单（依赖 ArceOS 各子模块）
│   ├── build.rs             #   构建脚本（环境变量重编译触发）
│   ├── assets/              #   内置运行时资产（glibc locale/gconv/libgcc）
│   └── src/                 #   内核源代码（~43,600 行 Rust）
│       ├── main.rs          #     入口：模块装配，委托给 init
│       ├── init.rs          #     启动编排：挂载评测盘、发现/执行测试组
│       ├── arch.rs          #     架构 ABI 胶水：RV64/LA64 trap frame 差异收口
│       ├── trap.rs          #     trap/syscall 接入与 page fault 处理
│       ├── user.rs          #     用户态 trap 栈与进入 glue
│       ├── exec/            #     ELF 装载与执行链（含运行时探测）
│       ├── fs/              #     文件系统层（ext4/VFS/procfs/sysfs/ramfs）
│       ├── syscall/         #     Linux 系统调用分发层
│       └── task/            #     进程/线程运行时管理
│
├── arceos/                  # ArceOS 上游框架（复用构建链与基础模块）
│   ├── modules/             #   ArceOS 内核模块
│   │   ├── axhal/           #     硬件抽象层
│   │   ├── axmm/            #     内存管理
│   │   ├── axtask/          #     任务调度原语
│   │   ├── axalloc/         #     全局分配器
│   │   ├── axfs/            #     文件系统框架
│   │   ├── axnet/           #     网络栈
│   │   ├── axdriver/        #     设备驱动框架
│   │   ├── axruntime/       #     运行时启动
│   │   ├── axsync/          #     同步原语
│   │   ├── axlog/           #     日志
│   │   ├── axconfig/        #     配置
│   │   ├── axdisplay/       #     显示
│   │   ├── axdma/           #     DMA
│   │   ├── axipi/           #     IPI 核间中断
│   │   └── axns/            #     命名空间
│   ├── api/                 #   对外 API（arceos_api, arceos_posix_api, axfeat）
│   ├── ulib/                #   用户库（axstd, axlibc）
│   ├── configs/custom/      #   平台配置（RV64/LA64/x86_64 QEMU）
│   ├── examples/            #   示例应用
│   ├── scripts/             #   构建辅助脚本
│   └── tools/               #   板级工具
│
├── scripts/                 # 比赛交付脚本
│   ├── run_autotest.sh      #   官方 autotest 本地复现
│   ├── run_local_test.sh    #   宿主机本地测试
│   ├── run_qemu.sh          #   QEMU 启动封装
│   ├── make_test_fs.sh      #   测试文件系统制作
│   ├── prepare_autotest_env.sh
│   ├── local_qemu_runner.py #   Python QEMU runner
│   └── ...                  #   其他辅助脚本
│
├── autotest-for-oskernel/   # 官方评测框架本地副本
├── docs/                    # 技术文档（LTP 统计、测试指南、问题分析）
│   └── dev/                 #   开发期文档
├── blog/                    # 开发日志（~90 篇，按时间线记录开发过程）
├── third_party/rust/        # 第三方 Rust 依赖（vendor 目录，离线构建）
├── cargo_config/            # 仓库级 Cargo 配置（替代 .cargo）
├── Makefile                 # 根级构建入口（`make all` → kernel-rv + kernel-la）
├── Dockerfile               # 比赛工具链 Docker 镜像
├── 任务书.md                # 比赛任务说明
├── 注意事项.md              # 注意事项
└── VOSDashboard.md          # 当前得分分析（已退役，以官方 runner 为准）
```

---

## 子系统划分

### 1. 系统调用层（`kernel/src/syscall/`，~16,300 行）

| 文件 | 行数 | 职责 |
|------|------|------|
| `mod.rs` | 1,006 | 总分发器：syscall 号到处理函数的映射 |
| `fs.rs` | 3,998 | 文件系统 syscall（open/read/write/stat/mount 等） |
| `process.rs` | 2,525 | 进程管理 syscall（fork/execve/wait4/exit 等） |
| `memory.rs` | 1,970 | 内存管理 syscall（mmap/munmap/brk/mprotect 等） |
| `fdprobe.rs` | 1,164 | fd 探测与资源统计 |
| `poll.rs` | 1,117 | poll/ppoll/select/pselect/epoll 系列 |
| `thread.rs` | 1,094 | 线程相关 syscall（clone/set_tid_address 等） |
| `net.rs` | 904 | 网络 syscall（socket/bind/connect/sendto/recvfrom 等） |
| `time.rs` | 863 | 时间相关 syscall（clock_gettime/nanosleep 等） |
| `io.rs` | 537 | I/O 多路复用相关 |
| `signal.rs` | 482 | 信号相关 syscall（kill/tkill/rt_sigaction 等） |
| `futex.rs` | — | futex 系统调用 |
| `compat.rs` | 429 | 兼容性处理 |

### 2. 任务/进程管理层（`kernel/src/task/`，~16,500 行）

| 文件 | 行数 | 职责 |
|------|------|------|
| `mod.rs` | 3,072 | 核心进程/线程抽象（Process/Thread/Pid/Tid） |
| `fd.rs` | 6,868 | 文件描述符表、epoll、socket、管道、splice |
| `wait.rs` | 2,832 | 阻塞等待、调度器就绪队列、park/wake 机制 |
| `signal.rs` | 1,315 | 信号投递、信号状态、signal frame |
| `memory.rs` | 734 | 进程地址空间、mmap 区域、共享内存 |
| `futex.rs` | 619 | Futex 等待/唤醒 |
| `clone.rs` | — | clone/fork 实现 |
| `path.rs` | — | 当前工作目录状态 |
| `procfs.rs` | — | /proc 信息渲染 |
| `robust.rs` | — | robust futex 列表 |
| `ltp_trace.rs` | — | LTP 调试追踪 |

### 3. 文件系统层（`kernel/src/fs/`，~7,000 行）

| 文件 | 行数 | 职责 |
|------|------|------|
| `rootfs.rs` | 4,182 | VFS 根文件系统、挂载管理、ramfs、ext4 衔接 |
| `procfs.rs` | 1,507 | procfs 实现 |
| `runtime_assets.rs` | 590 | 内置 glibc 运行时资产（locale/gconv） |
| `ext4.rs` | — | ext4 只读访问封装 |
| `ext4_vfs.rs` | — | ext4 到 VFS 的适配层 |
| `myfs.rs` | — | 最薄内存根文件系统（启动用） |
| `sysfs.rs` | — | sysfs 实现 |
| `mod.rs` | 23 | 模块入口 |

### 4. 执行链（`kernel/src/exec/`，~1,800 行）

| 文件 | 行数 | 职责 |
|------|------|------|
| `mod.rs` | 1,702 | ELF 解析/装载、execve 实现、auxv 构建 |
| `runtime_profile.rs` | — | 官方 runtime 探测（glibc/musl） |

### 5. 顶层入口与架构胶水（~1,900 行）

| 文件 | 行数 | 职责 |
|------|------|------|
| `init.rs` | 1,248 | 最小启动控制流：挂载评测盘、发现测试组、执行用户程序 |
| `trap.rs` | 438 | trap 分发、page fault 处理、用户异常 |
| `arch.rs` | — | RISC-V/LoongArch ABI 差异收口 |
| `user.rs` | 141 | 用户态 trap 栈 |
| `main.rs` | 44 | 顶层模块装配与入口 |

### 6. ArceOS 框架复用层

VOS 直接复用 ArceOS 的以下子系统：

- **axhal**（硬件抽象层）：平台启动、中断控制、时钟、页表操作
- **axmm**（内存管理）：地址空间、共享页、页表操作
- **axalloc**（全局分配器）：物理/字节级内存分配
- **axtask**（任务调度原语）：底层任务结构
- **axfs**（文件系统框架）：块设备访问、Disk 抽象
- **axnet**（网络栈）：virtio-net 驱动、socket 层
- **axdriver**（设备驱动框架）：virtio-blk/net 驱动
- **axruntime**（运行时）：底层初始化流程
- **axsync**（同步原语）：Mutex 等
- **axlog**：日志输出

---

## 构建工具与依赖

### 核心构建工具

| 工具 | 用途 |
|------|------|
| **Rust 工具链**（rustc, cargo, rustup） | 主要编译工具链。使用 `nightly-2025-05-20` 版本 |
| **GNU Make** | 顶层构建编排（`make all`） |
| **Docker** | 官方 autotest 评测容器化运行 |
| **QEMU**（qemu-system-riscv64, qemu-system-loongarch64） | 虚拟硬件模拟 |
| **OpenSBI/RustSBI** | RISC-V SBI 固件 |
| **Python 3** | QEMU runner / autotest 脚本 |

### 交叉编译目标

| 架构 | Rust Target |
|------|-------------|
| RISC-V64 | `riscv64gc-unknown-none-elf` |
| LoongArch64 | `loongarch64-unknown-none-softfloat` |

### 关键依赖库

- **ext4-view**：ext4 只读文件系统解析
- **riscv**：RISC-V 架构寄存器/CSR 操作
- **page_table_entry**：页表项抽象
- **memory_addr**：物理/虚拟地址类型
- **axerrno**：Linux errno 映射
- **linkme** / **lazyinit**：链接期/延迟初始化

### 构建入口

```bash
make all              # 生成 kernel-rv (RISC-V) 和 kernel-la (LoongArch)
make contest-autotest # 运行官方评测
make local-test       # 宿主机本地测试
```

构建过程**完全离线**：通过 `cargo_config/` 和 `third_party/rust/vendor/` 实现零外网访问。

---

## 初步评估总结

1. **代码规模**：内核核心代码约 43,600 行 Rust（39 个源文件），加上 ArceOS 框架模块（约 17 个子模块），总体规模较大。
2. **架构清晰**：采用分层架构——ArceOS 提供硬件抽象与基础驱动，VOS 在之上实现 Linux 兼容层（syscall 分发、进程/线程管理、VFS、内存管理）。
3. **双架构支持**：RISC-V64 和 LoongArch64，通过 `arch.rs` 收口架构差异。
4. **比赛针对性**：代码围绕官方评测流程设计——从 ext4 评测盘读取测试组、依次装载执行 ELF、收集退出状态。
5. **开发过程记录完善**：`blog/` 含约 90 篇开发日志，`docs/dev/` 含 LTP 统计、问题分析等文档。
6. **测试覆盖**：支持 basic/busybox/libcbench/libctest/lmbench/lua/ltp/iozone/iperf/netperf 共 10 个官方测试组，兼容 glibc 和 musl 两种运行时。