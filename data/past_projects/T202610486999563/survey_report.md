## 项目初步调查结果

### 一、项目概览

该项目是一个用 Rust 编写的操作系统内核，项目名称为 **whuse**（可从 crate 命名推断）。项目基于 Rust nightly-2025-01-18 工具链，采用 `#![no_std]` 裸机方式构建。目标架构为 **RISC-V 64** 和 **LoongArch 64**，运行于 QEMU virt 平台。

---

### 二、文件组织结构

```
.
├── Cargo.toml              # 工作区清单（workspace），16 个成员 crate
├── Makefile                # 顶层构建入口，委托给 tools/xtask
├── cargo_config.toml       # Cargo 配置（vendor 源、target 特定 rustflags）
├── rust-toolchain.toml     # 工具链版本锁定
├── crates/                 # 内核核心 crate（12 个）
├── platform/               # 平台二进制目标（3 个）
├── tools/                  # 构建/测试辅助工具
│   ├── xtask/              # Rust 构建编排工具（xtask 模式）
│   ├── dev/                # Shell 脚本（竞赛环境阶段测试）
│   ├── oscomp/             # 竞赛评测配置（LTP 白/黑名单、profile）
│   └── rootfs/             # 预置根文件系统骨架（busybox init/sh）
├── third_party/            # 第三方库补丁（fdt, virtio-drivers）
├── vendor/                 # 依赖 vendoring（20 个 crate）
└── docs/                   # 开发计划文档
```

---

### 三、子系统划分

#### 1. HAL（硬件抽象层）—— 4 个 crate

| Crate | 职责 |
|---|---|
| `hal-api` | 定义 HAL 接口 trait：`HalPlatform`、`HalMemory`、`HalCpu`、`HalTimer`、`HalInterrupt`、`HalBlockDevice`、`HalCharDevice`、`HalNetDevice`、`HalPlatformLifecycle`，以及统一的 `HalBundle` 注册机制 |
| `hal-riscv64-virt` | RISC-V QEMU virt 平台 HAL 实现：NS16550 UART、VirtIO MMIO 块设备、PLIC 中断、SBI 定时器、页表操作 |
| `hal-loongarch64-virt` | LoongArch QEMU virt 平台 HAL 实现：UART、VirtIO PCI 块设备、LoongArch CSR 定时器/中断、页表操作 |
| `hal-virtio` | VirtIO 设备发现与 DMA 内存管理：FDT 解析、VirtIO MMIO/PCI 发现、`VirtioDmaArena` |

#### 2. 内存管理（MM）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `mm` | 物理帧分配器（`FrameAllocator`）、虚拟地址空间（`AddressSpace`）：支持匿名映射、共享映射、固定地址映射、mmap/munmap/mprotect/brk 操作、ELF 加载器（`ElfBinaryLoader`）、页表克隆（fork 用）、RISC-V 和 LoongArch PTE 常量 |

#### 3. 进程管理（proc）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `proc` | 进程控制块（`Process`）：进程状态、凭证（uid/gid）、信号状态（`SignalState`）、文件描述符表、地址空间、线程组管理、父子关系。`ProcessTable`：全局进程表管理，支持 fork/clone/execve/exit/wait 语义、futex 鲁棒列表 |

#### 4. 任务调度（task）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `task` | 任务管理（`Task`、`TaskState`）、等待队列（`WaitQueue`）、调度器（`Scheduler`）：支持 Ready/Running/Blocked/Exited 状态机、时间片轮转、yield |

#### 5. 虚拟文件系统（VFS）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `vfs` | `KernelVfs`：内存文件系统树、目录/文件/字符设备/管道/proc/socket 节点类型、挂载点管理（ext4 块设备挂载）、文件句柄（`FileHandle`）、VFS 操作：open/read/write/seek/getdents/stat/mkdir/unlink/link/mount/umount/rename/symlink 等。内建 proc 伪文件系统（meminfo/uptime/stat/version/maps 等）|

#### 6. EXT4 文件系统（fs-ext4）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `fs-ext4` | 基于 `ext4-view` 库的 EXT4 只读访问实现：`Ext4Mount` 封装、元数据读取、目录遍历、文件读取 |

#### 7. 系统调用（syscall）—— 1 个 crate（9 个域模块）

| Crate | 职责 |
|---|---|
| `syscall` | `SyscallDispatcher` 统一分发，按域拆分为 10 个模块：`fs_domain`（文件系统调用）、`mm_domain`（内存管理调用）、`task_domain`（进程/线程管理调用）、`signal_domain`（信号/futex 调用）、`io_mpx_domain`（I/O 多路复用：epoll/poll/select）、`ipc_domain`（System V 共享内存）、`net_domain`（socket 调用）、`time_domain`（时间/时钟调用）、`sys_domain`（系统信息/凭证管理）、`resources_domain`（资源限制/syslog） |

#### 8. 内核核心（kernel-core）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `kernel-core` | 内核主循环与集成：`Kernel` 结构体将所有子系统组装在一起（内存、进程、调度、VFS、系统调用分发器），实现 trap 处理、中断服务、信号分发、看门狗（OS 竞赛用超时监控）、用户态启动流程（init 进程创建、busybox 环境搭建）。分为 `lib_riscv.inc.rs`（3335 行）和 `lib_loongarch.inc.rs`（3645 行）两个平台特定的 include 文件 |

#### 9. 用户态初始化（user-init）—— 1 个 crate

| Crate | 职责 |
|---|---|
| `user-init` | 提供内嵌的用户态 busybox 二进制镜像及初始化脚本（通过 `include_bytes!` 嵌入），供内核在启动时构建初始根文件系统 |

#### 10. 平台二进制目标（platform）—— 3 个 crate

| Crate | 职责 |
|---|---|
| `whuse-riscv64-virt` | RISC-V 内核镜像入口：链接脚本 `linker.ld`、汇编入口 `entry.S`、buddy allocator、全局堆初始化、启动内核 |
| `whuse-loongarch64-virt` | LoongArch 内核镜像入口：同上结构 |
| `whuse-loongarch64-bootrom` | LoongArch 平台 bootrom 存根（最小 panic handler，用于 QEMU 直接加载内核的启动链） |

---

### 四、依赖关系图（crate 级别）

```
platform/{riscv64-virt, loongarch64-virt}
  └── kernel-core
        ├── syscall ──────┬── proc ────┬── mm ─── hal-api
        │                 │            └── vfs ──┬─ fs-ext4 ─── hal-api
        │                 │                      └─ hal-api
        │                 ├── task
        │                 ├── mm
        │                 ├── vfs
        │                 ├── user-init ─── proc, vfs
        │                 └── hal-api
        ├── proc, task, mm, vfs, fs-ext4, user-init, hal-api
        └── hal-api

hal-{riscv64,loongarch64}-virt
  ├── hal-api
  ├── hal-virtio ─── fdt, virtio-drivers
  └── virtio-drivers
```

---

### 五、构建工具需求

1. **Rust 工具链**：`nightly-2025-01-18`，profile `minimal`，需要 `rust-src` 组件（用于 `-Zbuild-std` 等裸机构建特性）
2. **交叉编译目标**：
   - `riscv64gc-unknown-none-elf`（RISC-V 64）
   - `loongarch64-unknown-none`（LoongArch 64）
3. **QEMU**：用于模拟运行，支持 `qemu-system-riscv64` 和 `qemu-system-loongarch64`
4. **Docker**（可选）：竞赛模式下使用容器化评测环境
5. **Cargo xtask**：构建编排由 `tools/xtask` 完成，包括交叉编译、镜像制作、QEMU 启动
6. **文件系统工具**：内核镜像输出为 `kernel-rv` 和 `kernel-la`；根文件系统通过 busybox 静态链接构建

---

### 六、代码规模概览

| 组件 | 行数（约） |
|---|---|
| kernel-core (RISC-V) | 3,335 |
| kernel-core (LoongArch) | 3,645 |
| syscall | 9,472 |
| vfs | 3,075 |
| proc | 2,432 |
| mm | 1,886 |
| hal-riscv64-virt | 1,103 |
| hal-loongarch64-virt | 1,151 |
| fs-ext4 | 519 |
| user-init | 525 |
| hal-virtio | 385 |
| task | 349 |
| hal-api | 220 |
| platform 入口 | ~550 |
| **核心总计** | **~28,600** |

---

### 七、关键特征总结

- **双架构支持**：RISC-V 64 和 LoongArch 64，通过 HAL 抽象层实现平台解耦
- **完整内存管理**：虚拟地址空间、页表操作、按需映射、CoW 友好的克隆机制
- **进程模型**：支持 fork/clone/execve 的完整 UNIX 进程语义，含线程组、信号、futex
- **文件系统**：内存 VFS 层 + EXT4 只读支持 + proc 伪文件系统 + 管道/socket 特殊节点
- **丰富的系统调用**：覆盖文件 I/O、内存管理、进程管理、信号、socket 网络、IPC、时间、epoll 等多个域
- **竞赛导向**：内建看门狗超时监控、busybox 环境适配、OS 竞赛评测集成（stage1/stage2 测试流程）
- **构建系统**：基于 Cargo workspace + xtask 模式，支持本地 QEMU 和 Docker 容器两种运行模式