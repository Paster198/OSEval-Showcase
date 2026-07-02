## OurKernel2026 项目初步分析报告

### 一、项目概览

该项目名为 **OurKernel2026**（内部库名 `starry-core`），是一个基于 **ArceOS** 框架的宏内核操作系统，使用 Rust 语言编写。项目继承自 Undefined-OS，面向操作系统内核比赛（OS竞赛），目标是提供丰富的 Linux/POSIX 兼容性。

- **仓库来源**：GitLab (gitlab.eduxiji.net)
- **许可证**：GPL-3
- **Rust 工具链**：nightly-2025-05-20
- **支持架构**：RISC-V 64、x86_64、AArch64、LoongArch64

---

### 二、项目顶层结构

```
repo/
├── Cargo.toml / Cargo.lock    # Rust workspace 定义，根 package
├── Makefile                    # 顶层构建入口
├── build.rs                    # 构建脚本：链接用户态测例到内核镜像
├── build_img.sh                # 磁盘镜像制作脚本
├── README.md
├── LICENSE
│
├── src/                        # 内核主入口与系统调用分发
├── core/                       # starry-core：内核核心状态管理
├── api/                        # ourkernel2026-api：POSIX API 层
├── process/                    # ourkernel2026-process：进程/线程模型
├── modules/                    # 独立可复用模块
│   ├── vfs/                    #   ourkernel2026-vfs：VFS 抽象层
│   ├── lwext4_rust/            #   ext4 文件系统 Rust 绑定（含 C 源码）
│   └── page_table_multiarch/   #   多架构页表支持
├── arceos/                     # ArceOS 框架（HAL、驱动、调度器等）
├── apps/oscomp/                # 竞赛测例启动器与评测脚本
├── configs/                    # 各架构内核配置 (TOML)
├── scripts/                    # 构建/测试辅助脚本
├── bin/axconfig-gen             # 预编译构建辅助工具
├── vendor/                     # 离线 Rust 依赖源码
├── docs/                       # 文档（基线说明、创新范围、进度报告等）
├── 00_提交材料/                 # 竞赛提交材料（设计文档、演示视频等）
└── syscall_trace/              # syscall_trace：proc-macro，系统调用跟踪宏
```

Cargo workspace 成员：

| 成员 | 路径 | 说明 |
|------|------|------|
| `ourkernel2026` | `.` | 根 package，内核入口 |
| `starry-core` | `core/` | 内核核心状态（地址空间、任务、资源、共享内存） |
| `ourkernel2026-api` | `api/` | POSIX 兼容 API 层（接口定义 + 实现） |
| `ourkernel2026-process` | `process/` | 进程/线程/进程组/会话模型 |
| `ourkernel2026-vfs` | `modules/vfs/` | 可复用 VFS 抽象 |
| `syscall-trace` | `syscall_trace/` | proc-macro，系统调用跟踪 |

---

### 三、子系统划分

#### 1. 内存管理 (MM)

| 路径 | 职责 |
|------|------|
| `core/src/mm.rs` | 用户地址空间创建、内核映射拷贝、信号 trampoline 映射、ELF 加载、用户栈/堆映射 |
| `src/mm.rs` | 页错误 (page fault) 处理，区分内核/用户态缺页，SIGSEGV 发送 |
| `api/src/imp/mm/` | brk、mmap、munmap、mprotect 等系统调用实现 |
| `api/src/interface/mm/` | 共享内存 (shm) 相关用户接口 |
| `modules/page_table_multiarch/` | 多架构页表条目与页表抽象 |

#### 2. 进程与任务管理

| 路径 | 职责 |
|------|------|
| `process/src/` | 进程 (Process)、线程 (Thread)、进程组 (ProcessGroup)、会话 (Session) 的数据模型，纯数据结构，无外部依赖 |
| `core/src/process.rs` | ProcessData：地址空间、信号管理器、futex 表、共享内存、资源限制等进程级状态 |
| `core/src/task.rs` | TaskExt（任务扩展数据）：绑定 Process/Thread、时间统计、命名空间。提供 `current_process`、`current_thread` 等访问器 |
| `core/src/ctypes.rs` | CloneFlags、WaitFlags、TimeStat 等类型定义 |
| `api/src/imp/task/` | clone、execve、exit、futex、wait、schedule、signal、thread 等系统调用实现 |
| `api/src/interface/task/` | 面向用户态的任务接口 |

#### 3. 文件系统 (VFS + 物理文件系统)

| 路径 | 职责 |
|------|------|
| `modules/vfs/src/` | 通用 VFS 抽象：Filesystem、Mountpoint、Node（文件/目录）、Path、类型定义 |
| `src/fs/` | 内核文件系统初始化：挂载 devfs、procfs、tmpfs |
| `src/fs/mount.rs` | `mount_all()`：统一挂载入口 |
| `src/fs/dynamic/` | 动态文件系统框架（DynamicFs、DynamicDir），用于构建伪文件系统 |
| `src/fs/imp/dev.rs` | /dev 设备文件系统（null、zero、random、rtc0 等设备） |
| `src/fs/imp/proc.rs` | /proc 伪文件系统（stat、cpuinfo、meminfo 等） |
| `src/fs/imp/tmp.rs` | /tmp 内存文件系统 |
| `api/src/core/fs/` | 文件系统核心抽象：文件、目录、管道、epoll、fd 表、挂载、stdio 等 |
| `api/src/core/file/` | 文件描述符管理：fd 分配、epoll、管道、memfd、stdio |
| `api/src/imp/fs/` | 文件系统相关系统调用实现（open、read、write、stat、poll 等） |
| `api/src/interface/fs/` | 文件系统面向用户接口 |
| `modules/lwext4_rust/` | ext4 文件系统：C 语言 lwext4 库的 Rust 绑定（通过 bindgen） |

#### 4. 系统调用层

| 路径 | 职责 |
|------|------|
| `src/syscall.rs`（560行） | 系统调用分发中心：注册 SYSCALL 陷阱处理，根据 sysno 分发到 api 层实现 |
| `api/src/interface/` | 各子系统面向用户态的接口定义 |
| `api/src/imp/` | 各子系统系统调用的具体实现 |
| `syscall_trace/src/lib.rs` | proc-macro `#[syscall_trace]`：自动为系统调用函数添加参数/返回值日志 |

#### 5. 信号处理

| 路径 | 职责 |
|------|------|
| `api/src/imp/task/signal.rs` | 信号发送、处理等系统调用实现 |
| 外部依赖 `axsignal` | 提供 SignalManager、SignalActions 等底层信号基础设施 |

#### 6. 网络

| 路径 | 职责 |
|------|------|
| `api/src/imp/net/` | socket、socketaddr 相关系统调用 |

#### 7. 资源管理

| 路径 | 职责 |
|------|------|
| `core/src/resource.rs` | ResourceLimits：rlimit 资源限制（CPU、FSIZE、NOFILE、STACK 等） |

#### 8. 共享内存 (IPC)

| 路径 | 职责 |
|------|------|
| `core/src/shared_memory.rs` | SharedMemory / SharedMemoryManager：基于页分配器的共享内存段管理 |

#### 9. 时间管理

| 路径 | 职责 |
|------|------|
| `core/src/ctypes.rs`（TimeStat） | 用户态/内核态时间统计、定时器管理 |
| `api/src/core/time.rs` | 时间相关核心抽象 |

#### 10. 竞赛评测框架

| 路径 | 职责 |
|------|------|
| `src/oscomp_runner.rs` | 评测计划解析、Shell 调用 |
| `src/test_manifest.rs` | 测试清单处理 |
| `apps/oscomp/` | 评测脚本（judge_basic.py、judge_busybox.py、judge_iozone.py 等） |

---

### 四、构建工具与依赖

#### 必需工具

| 工具 | 用途 |
|------|------|
| Rust nightly-2025-05-20 | 编译工具链（通过 `RUSTUP_TOOLCHAIN` 环境变量指定） |
| `axconfig-gen`（`bin/` 目录） | 从 TOML 配置生成编译期常量 |
| RISC-V GCC (cross) | RISC-V 架构交叉编译（用户态应用） |
| LoongArch GCC (cross) | LoongArch 架构交叉编译 |
| `mkfs.ext4` / `mkfs.vfat` | 制作磁盘镜像 |
| GNU Make | 构建编排 |

#### 核心外部依赖（来自 ArceOS 生态）

| 依赖 | 用途 |
|------|------|
| `axfeat` | ArceOS 特性门控框架 |
| `axhal` | 硬件抽象层（陷阱、分页、架构相关） |
| `axmm` | 地址空间管理（支持 CoW） |
| `axtask` | 任务调度 |
| `axalloc` | 物理页分配器 |
| `axfs-ng` | 文件系统上下文与操作 |
| `axnet` | 网络栈 |
| `axns` | 命名空间抽象 |
| `axsync` | 同步原语 |
| `axsignal` | 信号基础设施 |
| `axconfig` | 平台配置常量 |
| `axlog` | 日志 |
| `axdisplay` / `axdriver_display` | 显示驱动（GUI 特性） |
| `arceos_posix_api` | POSIX API 兼容基础设施 |

#### 编译目标

- `riscv64gc-unknown-none-elf`
- `x86_64-unknown-none`
- `aarch64-unknown-none` / `aarch64-unknown-none-softfloat`
- `loongarch64-unknown-none-softfloat`

#### 构建特性 (features)

- `fp_simd`：浮点/SIMD 支持
- `lwext4_rs`：ext4 文件系统
- `sched_rr`：轮转调度
- `gui`：显示支持

---

### 五、初步评估摘要

该项目是一个中等规模的 Rust 宏内核项目，在 ArceOS 框架基础上实现了较完整的 POSIX 兼容层。其架构层次清晰：

1. **底层**由 ArceOS（`arceos/`目录）提供 HAL、驱动、调度、分配器等基础设施；
2. **核心层**（`core/`、`process/`）管理进程/线程模型、地址空间、资源限制、共享内存等内核状态；
3. **API 层**（`api/`）是系统调用的实现主体，分为接口定义(`interface/`)、具体实现(`imp/`)和核心抽象(`core/`)三个子层；
4. **VFS 层**（`modules/vfs/`）提供可复用的文件系统抽象，`src/fs/` 在此基础上构建 devfs、procfs、tmpfs；
5. **系统调用分发**（`src/syscall.rs`）集中处理所有系统调用路由。

项目已适配四个 CPU 架构，支持 ext4 文件系统（通过 C 库 lwext4 的 Rust 绑定），具备完整的进程/线程模型、信号机制、管道、epoll、共享内存等 POSIX 特性。