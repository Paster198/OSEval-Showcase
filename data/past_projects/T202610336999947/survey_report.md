## 项目结构分析

### 1. 目录结构总览

```
repo/
├── Makefile                          # 顶层构建入口（构建内核 + 测试套件）
├── arceos/                           # ArceOS 内核主仓库
│   ├── Cargo.toml                    # Rust workspace 定义
│   ├── Cargo.lock
│   ├── Makefile                      # 内核构建脚本
│   ├── rust-toolchain.toml           # Rust nightly-2025-05-20
│   ├── modules/                      # 内核子模块（共16个）
│   ├── api/                          # 对外 API 层（3个crate）
│   ├── ulib/                         # 用户态库（2个crate）
│   ├── configs/                      # 平台配置文件
│   ├── examples/                     # 示例应用程序
│   ├── scripts/make/                 # Makefile 片段
│   └── tools/                        # 板级支持工具
├── compat/                           # 比赛兼容与运行层
│   ├── oscomp-runner/                # 比赛运行器应用（Rust）
│   └── tools/                        # 构建/磁盘制作/测试运行脚本
└── testsuits-for-oskernel/           # 测试套件集合
    ├── basic/ busybox/ lua/ iozone/  # 各类基准与功能测试
    ├── unixbench/ iperf/ netperf/    # 性能测试
    ├── libc-bench/ libc-test/        # libc 测试
    ├── lmbench_src/ ltp-full-*/      # 系统测试
    ├── rt-tests-2.7/                 # 实时性测试
    └── scripts/ runtime/ config/     # 测试基础设施
```

---

### 2. 子系统划分

#### 2.1 硬件抽象层 — `axhal`

| 源文件 | 职责 |
|--------|------|
| `lib.rs` | 平台选择（x86_64/riscv64/aarch64/loongarch64），入口初始化 |
| `mem.rs` | 物理内存区域管理 |
| `paging.rs` | 页表操作封装 |
| `time.rs` | 时间接口（重新导出 axplat 实现） |
| `irq.rs` | 中断注册 |
| `percpu.rs` | Per-CPU 数据初始化 |
| `tls.rs` | 线程局部存储 |

平台特定实现通过外部 crate（`axplat-x86-pc`, `axplat-riscv64-qemu-virt`, `axplat-aarch64-qemu-virt`, `axplat-loongarch64-qemu-virt`）注入。

#### 2.2 驱动框架 — `axdriver`

- 统一设备抽象：`AxNetDevice` / `AxBlockDevice` / `AxDisplayDevice`
- 支持静态分发（编译期确定）和动态分发（trait object）两种模式
- 总线支持：MMIO（设备树探测）和 PCI
- 已支持的 VirtIO 设备：virtio-blk、virtio-net、virtio-gpu
- 额外设备驱动：`ixgbe.rs`（Intel 10GbE 网卡）

#### 2.3 内存管理 — `axmm` / `axalloc` / `axdma`

- **axmm**：地址空间管理（`AddrSpace`），后端支持线性映射（`linear.rs`）和动态分配（`alloc.rs`）
- **axalloc**：全局堆分配器，支持 slab 和 buddy 两种算法，基于bitmap页分配
- **axdma**：DMA 一致性内存分配

#### 2.4 任务管理 — `axtask`

- 支持多种调度策略：FIFO 协作式（默认）、Round-Robin 抢占式、CFS 完全公平调度
- 提供任务创建、睡眠、定时器、等待队列等原语
- SMP 支持

#### 2.5 同步原语 — `axsync`

- `Mutex`（多任务环境使用阻塞锁，单任务环境退化为 `SpinNoIrq`）
- 重新导出 `kspin` 提供的自旋锁

#### 2.6 核间中断 — `axipi`

- Per-CPU IPI 事件队列
- 支持单播和多播回调

#### 2.7 文件系统 — `axfs`

- 统一的 VFS 接口（`api/file.rs`, `api/dir.rs`）
- 支持 FAT（`fatfs.rs`）、RAMFS（`/tmp`）、DEVFS（`/dev`）
- 允许用户自定义文件系统（`myfs.rs`，通过 `MyFileSystemIf` trait）

#### 2.8 网络栈 — `axnet`

- 基于 smoltcp 的 TCP/UDP 实现
- 提供类 POSIX 的 `TcpSocket` / `UdpSocket` API
- DNS 查询支持

#### 2.9 命名空间 — `axns`

- 资源隔离框架，用于分组系统资源（地址空间、工作目录、文件描述符等）
- 同时支持 unikernel（全局单一命名空间）和宏内核（每进程一个命名空间）模型

#### 2.10 日志系统 — `axlog`

- 多级别日志（error/warn/info/debug/trace），编译期级别过滤
- 通过 `LogIf` trait 对接底层输出

#### 2.11 图形显示 — `axdisplay`

- 基于 framebuffer 的直接显存写入

#### 2.12 平台配置 — `axconfig`

- 编译期常量（通过宏生成），包含架构、平台、设备参数等

#### 2.13 运行时 — `axruntime`

- 内核启动入口（`rust_main`），执行完整初始化序列：
  BSS清零 → PerCPU初始化 → 内存发现 → 分配器初始化 → 页表初始化 → 设备驱动初始化 → 文件系统/网络/显示子系统初始化 → SMP启动 → 中断注册 → 进入应用 `main()`

---

### 3. API 与用户库

| 层 | Crate | 说明 |
|----|-------|------|
| 原生 API | `arceos_api` | 封装各模块能力：display/fs/mem/net/task |
| POSIX API | `arceos_posix_api` | 完整 POSIX 兼容：fd_ops/fs/io/io_mpx(epoll+select)/net/pipe/pthread/resources/stdio/sys/task/time |
| Rust std 兼容 | `axstd` | 模拟 `std::fs`, `std::net`, `std::thread`, `std::sync` 等 |
| C 库兼容 | `axlibc` | C 源文件实现 libc 函数（printf, pthread, mmap, socket 等），桥接至 arceos_posix_api |

---

### 4. 比赛运行器 — `compat/oscomp-runner`

- 一个 ArceOS 应用程序，负责从 ext4 启动盘导入测试文件系统
- 支持 RISC-V 和 LoongArch 两种架构
- 通过 `build_runner.sh` 调用 arceos Makefile 完成构建

---

### 5. 构建工具链需求

| 工具 | 用途 |
|------|------|
| **cargo** (Rust nightly-2025-05-20) | Rust 编译与依赖管理，需要 `rust-src`, `llvm-tools`, `rustfmt`, `clippy` |
| **rust-lld** | 链接（`LD = rust-lld -flavor gnu`） |
| **riscv64-linux-musl-gcc / loongarch64-linux-musl-gcc** | C 应用交叉编译（axlibc 及测试套件） |
| **cargo-axplat** | 平台信息查询（`cargo axplat info`） |
| **QEMU** | 模拟运行（RISC-V virt / LoongArch virt） |
| **mkfs.ext4 / mkfs.vfat** | 测试磁盘镜像制作 |
| **GDB (gdb-multiarch)** | 调试 |
| **Docker** | 测试套件编译环境 |

支持的架构目标三元组：
- `x86_64-unknown-none`
- `riscv64gc-unknown-none-elf`
- `aarch64-unknown-none-softfloat`
- `loongarch64-unknown-none-softfloat`

---

### 6. 初步总结

该项目是 **ArceOS** —— 一个 Rust 编写的组件化 unikernel 操作系统，被改造为 OS 内核比赛参赛项目。其核心特征：

- **组件化模块架构**：通过 Rust Cargo feature 系统按需组合内核能力
- **多架构支持**：x86_64、RISC-V、AArch64、LoongArch
- **兼容层丰富**：同时提供 ArceOS 原生 API、POSIX API、Rust std 兼容层、C libc 兼容层
- **比赛集成**：通过 `compat/oscomp-runner` 和 `testsuits-for-oskernel` 实现与 OS 比赛评测框架的对接