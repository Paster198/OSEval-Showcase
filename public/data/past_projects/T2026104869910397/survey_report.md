# CoreCraft OS 内核项目 — 初步调查分析

## 1. 项目结构概览

该项目名为 **CoreCraft**，是一个基于 Rust 语言开发的 OS 内核，采用 Cargo workspace 组织。顶层 `Cargo.toml` 声明了 13 个子 crate 作为 workspace members。

### 1.1 顶层目录结构

```
repo/
├── Cargo.toml              # workspace 根配置
├── Makefile                # 构建入口，产出 kernel-rv / kernel-la
├── rust-toolchain.toml     # 固定 nightly-2024-05-01 工具链
├── README.md
├── arch/                   # [crate] 架构抽象层
├── os/                     # [crate] 内核主二进制 (kernel entry)
├── vfs-defs/               # [crate] VFS 接口定义 (trait/类型)
├── vfs/                    # [crate] VFS 实现 (devfs/procfs/memfs/tmpfs/ext4)
├── lwext4/                 # [crate] 轻量 ext4 文件系统 (C FFI 封装)
├── virtio-drivers/         # [crate] VirtIO 设备驱动 (块/网络/GPU/输入/VSock)
├── isomorphic_drivers/     # [crate] 真实硬件驱动 (AHCI/e1000/ixgbe)
├── device/                 # [crate] 块设备抽象层
├── buffer/                 # [crate] 块缓存 (LRU block cache)
├── config/                 # [crate] 内核编译期常量配置
├── logger/                 # [crate] 日志子系统
├── sync/                   # [crate] 同步原语封装
├── system-result/          # [crate] 系统错误类型 (SysError/SysResult)
├── time/                   # [crate] 时间类型 (TimeSpec/TimeVal)
├── visionfive2-sd/         # [crate] VisionFive2 开发板 SD 卡驱动
├── vendor/                 # 本地 vendored 依赖 (16 个)
├── docs/                   # 开发计划/笔记文档 (16 个 md)
├── images/                 # 架构图/校徽
├── testinit/               # 测试用户态初始化程序 (la/rv 两套)
└── system-result/          # 系统错误码定义
```

### 1.2 workspace 成员依赖关系 (粗略)

```
os  (内核主 crate)
 ├── arch          (架构抽象: RISC-V/LoongArch)
 ├── vfs           (具体文件系统)
 │    ├── vfs-defs  (VFS trait 定义)
 │    ├── lwext4    (ext4 后端)
 │    └── device    (块设备抽象)
 ├── virtio-drivers (VirtIO 设备)
 ├── isomorphic_drivers (AHCI/e1000/ixgbe)
 ├── config / buffer / device / time / logger / sync / system-result
 └── vendor/*      (bitflags, fdt, riscv, loongArch64, pci, 等)
```

---

## 2. 子系统识别与归属

按照代码目录和模块边界，该项目实现了以下子系统：

### 2.1 架构抽象层 (`arch/`)

| 子目录/文件 | 职责 |
|---|---|
| `arch/src/lib.rs` | 统一导出，`#[cfg_attr]` 选择 RISC-V / LoongArch |
| `arch/src/riscv64/` | RISC-V 64: 启动、页表、中断、SBI、上下文切换、定时器、信号跳板、非对齐访问 |
| `arch/src/loongarch64/` | LoongArch 64: 启动、页表、控制台、上下文切换、定时器、陷进、信号跳板、非对齐访问 |
| `arch/src/addr.rs` | 物理/虚拟地址类型 |
| `arch/src/pagetable.rs` | 通用页表抽象 |
| `arch/src/api.rs` | `ArchInterface` trait — 架构无关的内核接口定义 |
| `arch/src/time.rs` | 架构时间接口 |

### 2.2 内存管理 (`os/src/mm/`)

| 文件 | 职责 |
|---|---|
| `mod.rs` | MM 子系统入口 |
| `memory_set.rs` | 进程地址空间 (MemorySet) |
| `page_table.rs` + `page_table_driver/` | 页表操作 |
| `frame.rs` + `frame_allocator.rs` + `frame_tracker.rs` | 物理帧分配/跟踪 |
| `heap_allocator.rs` | 内核堆分配器 (buddy system) |
| `vma_manager.rs` | VMA (虚拟内存区域) 管理 |
| `vpn_range.rs` | VPN 范围操作 |
| `address_space_allocator.rs` | 地址空间分配 |
| `shm.rs` | 共享内存 (IPC) |
| `fault_handler.rs` | 缺页异常处理 |
| `flags.rs` | 映射权限/Mmap 标志 |
| `types.rs` | 访存类型/错误原因 |

### 2.3 进程/任务管理 (`os/src/task/`)

| 文件 | 职责 |
|---|---|
| `mod.rs` | 任务子系统入口，全局 TASK_MANAGER/PROCESSOR/PID_ALLOCATOR |
| `task.rs` | TaskControlBlock (TCB) |
| `manager.rs` | 任务管理器 (创建/调度/信号发送) |
| `processor.rs` | 单核处理器调度 |
| `signal.rs` | 信号处理 (sigaction/sigreturn/信号投递) |
| `action.rs` | 信号动作 |
| `futex.rs` | Futex (快速用户空间锁) |
| `fdtable.rs` | 文件描述符表 |
| `pidfd.rs` | pidfd 支持 |
| `tid.rs` | 线程 ID 分配 |
| `aux.rs` | 辅助向量 (auxv) |
| `info.rs` | sysinfo/utsname |

### 2.4 系统调用 (`os/src/syscall/`)

| 文件 | 行数 | 职责 |
|---|---|---|
| `mod.rs` | 1914 | 系统调用分发 (237 个 syscall 常量定义) |
| `fs.rs` | 6628 | 文件系统相关系统调用 (最大模块) |
| `process.rs` | 5061 | 进程管理系统调用 |
| `memory.rs` | 961 | 内存管理系统调用 (mmap/munmap/brk 等) |
| `signal.rs` | 857 | 信号系统调用 |
| `timesyscall.rs` | 1162 | 时间相关系统调用 |

### 2.5 文件系统

| 模块 | 位置 | 职责 |
|---|---|---|
| VFS 接口层 | `vfs-defs/` | Dentry/Inode/SuperBlock/File/FileSystemType trait 定义, Kstat, StatFs |
| VFS 实现层 | `vfs/` | 文件系统管理器, 统一挂载逻辑 |
| devfs | `vfs/src/devfs/` | `/dev` 文件系统: null, zero, tty, rtc, urandom, block, cpu_dma_latency |
| procfs | `vfs/src/procfs/` | `/proc` 文件系统: cpuinfo, meminfo, stat, status, mounts, maps, exe, ns, pagemap, partitions, interrupts, self |
| memfs | `vfs/src/memfs/` | 内存文件系统 (dentry/file/inode) |
| tmpfs | `vfs/src/tmpfs/` | 临时文件系统 |
| ext4 | `lwext4/` | 轻量 ext4 实现 (C 库 FFI 封装), 作为根文件系统 |
| 内核 FS 胶水 | `os/src/fs/` | inode 操作, pipe (管道), stdio (标准输入输出) |
| 块缓存 | `buffer/` | LRU 块缓存层, 用于文件系统与块设备之间 |

### 2.6 设备驱动

| 模块 | 位置 | 职责 |
|---|---|---|
| VirtIO 框架 | `virtio-drivers/` | VirtIO 传输层 (MMIO/PCI), 块设备, 网络, 控制台, GPU, 输入, VSock |
| 真实硬件驱动 | `isomorphic_drivers/` | AHCI (SATA), e1000 (Intel 网卡), ixgbe (Intel 10GbE) |
| 内核驱动层 | `os/src/drivers/` | virtio_blk, pci_virtio_blk, sata_block, sdcard |
| 块设备抽象 | `device/` | BlockDevice trait |
| SD 卡 | `visionfive2-sd/` | VisionFive2 开发板 SD 卡寄存器级驱动 |

### 2.7 网络与 Socket

| 模块 | 位置 | 职责 |
|---|---|---|
| AF_ALG Socket | `os/src/socket/mod.rs` | AF_ALG 协议族 (内核加密 API): socket/bind/accept/setsockopt |
| 加密后端 | `os/src/socket/crypto.rs` | 算法注册表, 支持 md5/sha1/sha2/sha3/sm3/hmac |

### 2.8 AIO (异步 IO)

| 模块 | 位置 | 职责 |
|---|---|---|
| AIO | `os/src/aio/mod.rs` | Linux 原生 AIO: io_setup/io_submit/io_getevents/io_cancel/io_destroy |

### 2.9 基础设施

| 模块 | 位置 | 职责 |
|---|---|---|
| 配置 | `config/` | 编译期常量: 栈大小, 堆大小, 用户栈/堆, 页大小等 |
| 日志 | `logger/` | 基于 log crate + crate_interface 的日志输出 |
| 同步 | `sync/` | 基于 spin crate 的 Mutex/Once 封装 |
| 系统错误 | `system-result/` | SysError 枚举 (errno), SysResult 类型别名 |
| 时间 | `time/` | TimeSpec, TimeVal, TimeZone, ITimerVal |
| 控制台 | `os/src/console.rs` | 内核控制台输出 |
| 语言项 | `os/src/lang_items.rs` | Rust `#[lang]` 项: panic_handler, alloc_error_handler 等 |
| 测试框架 | `os/src/test_runtime.rs` | 测试运行时 (LTP 测试支持) |
| 定时器 | `os/src/timer.rs` | 内核定时器 |

### 2.10 构建支持文件

| 文件 | 用途 |
|---|---|
| `os/src/linker-riscv64.ld` | RISC-V 链接脚本 (VMA 0xffffffc080200000) |
| `os/src/linker-loongarch64.ld` | LoongArch 链接脚本 |
| `os/src/linker-qemu.ld` | QEMU 通用链接脚本 |
| `os/cargo-config.toml` | 各目标平台的 rustflags (链接脚本路径, 功能开关) |
| `os/build.rs` | 构建脚本 (监视线程用户程序变更) |
| `testinit/la/`, `testinit/rv/` | 用户态测试程序 (busybox, initproc_runner, mm_*_probe, poweroff 等) |

---

## 3. 构建系统分析

### 3.1 构建工具需求

| 工具 | 用途 |
|---|---|
| **Rust nightly-2024-05-01** | 固定工具链，需 `rust-src` 和 `llvm-tools-preview` 组件 |
| **`-Z build-std=core,alloc,compiler_builtins`** | 重新编译标准库核心组件 (LoongArch 因 `-Ctarget-feature=-ual` 需此选项) |
| **riscv64-linux-gnu-objcopy** | RISC-V 内核 ELF 后处理: 调整 LMA 从高半虚拟地址到物理地址 0x80200000 |
| **GNU Make** | 顶层 Makefile 编排构建 |
| **QEMU** (可选，本地运行) | RISC-V: `qemu-system-riscv64`, LoongArch: `qemu-system-loongarch64` |
| **SD 卡镜像** (可选，本地运行) | `/workspace/sdcard-rv.img`, `/workspace/sdcard-la.img` |

### 3.2 构建目标

| 目标 | 产物 | 三元组 |
|---|---|---|
| `kernel-rv` | RISC-V 64 内核 ELF | `riscv64gc-unknown-none-elf` |
| `kernel-la` | LoongArch 64 内核 ELF | `loongarch64-unknown-none` |

### 3.3 构建流程 (简化)

```
make all
  ├── prepare: 恢复 .cargo/config.toml, 安装 rust-src
  ├── kernel-la: cargo build --release --target loongarch64-unknown-none
  └── kernel-rv:
        ├── cargo build --release --target riscv64gc-unknown-none-elf
        └── riscv64-linux-gnu-objcopy (调整 LMA + 入口地址)
```

---

## 4. 初步评估摘要

- **代码规模**: 约 54,000 行 Rust 代码 (不含 vendor 和 virtio-drivers 自身)，其中系统调用模块最大 (~16,000 行分布在 fs/process/memory/signal/time)。
- **架构支持**: RISC-V 64 和 LoongArch 64 双架构，通过 `arch` crate 的 `#[cfg_attr]` 实现条件编译。
- **子系统覆盖**: 涵盖内存管理、进程/线程/信号、VFS (devfs/procfs/tmpfs/memfs/ext4)、块设备驱动 (VirtIO/AHCI/SD)、网络驱动 (e1000/ixgbe)、Socket (AF_ALG)、AIO、Futex、共享内存、管道等。
- **测试基础设施**: `testinit/` 目录包含针对 LTP 测试套件的用户态探针程序，`docs/` 目录包含大量 LTP 相关测试计划。