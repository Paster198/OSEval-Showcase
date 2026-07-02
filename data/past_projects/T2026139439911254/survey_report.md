# luwu OS 内核项目初步分析报告

## 一、项目概览

**luwu** 是一个使用 Rust 编写的玩具/教学操作系统内核，支持 **RISC-V 64** 和 **LoongArch 64** 两种指令集架构。项目采用 Cargo workspace 组织，使用 `no_std` 裸机方式构建，最终产物为可直接由 QEMU 加载的扁平内核镜像。

---

## 二、仓库文件组织结构

```
repo/
├── Cargo.toml                  # workspace 根配置，定义 5 个子 crate
├── rust-toolchain.toml         # 固定 Rust nightly 工具链版本
├── Makefile                    # 大赛评测入口 (make all -> kernel-rv + kernel-la)
├── Justfile                    # 日常开发入口 (just build / run / smoke)
├── Dockerfile                  # 容器化构建环境
├── .cargo/config.toml          # cargo 构建目标目录配置
├── README.md
├── docs/
│   ├── design.md               # 整体设计文档
│   ├── architecture.md         # 架构差异说明
│   ├── bootloader.md           # 启动流程与 BootInfo ABI
│   └── env.md                  # 开发环境与构建指南
├── tools/
│   └── rust-analyzer-check     # VS Code rust-analyzer 辅助脚本
├── luwu-common/                # 公共抽象层：trait、类型、常量
│   └── src/                    # 8 个源文件
├── luwu-kernel/                # 架构无关内核逻辑
│   └── src/                    # 20 个模块
├── luwu-ext4/                  # 独立 ext4 文件系统实现
│   └── src/                    # 约 60 个源文件，7 个子模块
├── luwu-riscv/                 # RISC-V 架构实现
│   ├── build.rs
│   ├── linker-riscv64gc.ld
│   └── src/                    # 4 个源文件
└── luwu-loongarch/             # LoongArch 架构实现
    ├── build.rs
    ├── linker-loongarch64.ld
    └── src/                    # 4 个源文件
```

总代码量约 **16,700 行 Rust**（luwu-common: ~1,450 行, luwu-kernel: ~4,700 行, luwu-ext4: ~10,500 行, 两个架构 crate 各约 600 行）。

---

## 三、子系统划分

### 3.1 架构抽象层 — `luwu-common`

定义所有架构无关的 **trait 接口、类型和常量**。内核上层通过泛型参数 `<A: KernelArch>` 使用这些 trait，编译期单态化到具体架构。核心抽象包括：

| Trait | 职责 |
|---|---|
| `ArchBoot` | 早期启动信息补全 (FDT/EFI 解析) |
| `ArchConsole` | 串口输出 |
| `ArchCpu` | CPU 控制（idle、halt、栅障等） |
| `ArchPaging` | 页表操作 |
| `ArchTimer` | 定时器中断 |
| `ArchTrap` | 异常/中断处理 |
| `ArchUser` | 用户态切换 |
| `ArchUserPaging` | 用户页表创建与管理 |

还提供：
- **BootInfo** 结构体：统一启动信息（魔数、版本、内存区域、FDT/EFI 指针）
- **FDT 解析器**：从设备树提取内存布局
- **EFI 辅助**：LoongArch 下通过 EFI config table 定位 FDT
- **TrapFrame / UserTrapContext**：异常帧与用户态上下文类型

### 3.2 架构无关内核 — `luwu-kernel`

是内核的 **主体逻辑**，不依赖任何特定 ISA。源文件及对应子系统：

| 源文件 | 子系统 | 行数 |
|---|---|---|
| `kernel.rs` | 入口 (`kernel_main`)、模块声明 | 119 |
| `init.rs` | 初始化任务调度（InitTask 定义、OSCOMP 测试任务） | 350 |
| `process.rs` | 进程管理（进程表、PID、调度、clone/exec） | 709 |
| `syscall/` | 系统调用（9 个子模块：fd、fs_ops、io_read、io_write、mem、misc、task、stat、dirents） | ~1,100 |
| `async_rt.rs` | 协作式异步运行时（Waker、Scheduler、Sleepers） | 420 |
| `memory.rs` | 物理内存规范化与 frame 分配 | 80 |
| `address_space.rs` | 虚拟地址空间布局（用户栈、mmap、TLS、堆） | 183 |
| `heap.rs` | 内核堆分配器（FreeListAllocator） | 195 |
| `user_paging.rs` | 用户页表管理（UserMemory） | 511 |
| `user.rs` | 用户程序加载（ELF 解析、UserTask 创建） | 201 |
| `elf.rs` | ELF 文件解析（program headers、INTERP、TLS） | 217 |
| `trap.rs` | 内核态 trap 分发与 panic | 190 |
| `console.rs` | 内核控制台输出 | 76 |
| `fs.rs` | 文件系统挂载接口（ext4 挂载封装） | 57 |
| `block.rs` | 块设备抽象（BlockError、BlockResult） | 34 |
| `shell.rs` | 交互式内核 shell（命令行解析与执行） | 57 |
| `virtio/` | VirtIO 驱动（blk、mmio、pci、queue 共 4 个模块） | ~500 |

### 3.3 ext4 文件系统 — `luwu-ext4`

一个 **独立、可复用的 ext4 文件系统库**，不依赖内核其他模块，仅依赖 `BlockDevice` trait。子模块：

| 子模块 | 职责 | 行数 |
|---|---|---|
| `layout/` | ext4 磁盘数据结构定义（superblock、inode、block_group、extent、dir_entry、htree、checksum） | ~1,330 |
| `io/` | 块 I/O 抽象（block_reader、block_writer、buffer_cache） | ~350 |
| `fs_core/` | 核心操作（路径解析、inode 读写、文件读写、目录读写、extent 遍历/修改、符号链接） | ~2,280 |
| `fs/` | 高层文件系统操作（mount、create、read、write、link、rename、remove、orphan、journal_ops） | ~970 |
| `journal/` | JBD2 日志（commit、checkpoint、descriptor、recovery、revoke、transaction、engine、superblock） | ~870 |
| `fs_alloc/` | 块与 inode 分配器（bitmap、block_alloc、inode_alloc） | ~630 |
| `alloc_bits/` | 位图操作辅助 | ~145 |
| `traits/` | VFS 抽象接口（FileSystem、InodeOps、BlockDevice、BlockAllocator、Journal） | ~230 |

### 3.4 架构实现层 — `luwu-riscv` / `luwu-loongarch`

每个架构 crate 实现 `luwu-common` 定义的 trait。代码量精简，每个包含：

- **`main.rs`**：入口 `_start`（汇编 + Rust early boot）、架构 trait 实现
- **`paging.rs`**：架构特定页表操作（Sv39/RISC-V，LoongArch 页表）
- **`trap.rs`**：架构特定 trap 入口与处理
- **`build.rs`**：传递链接脚本路径给 rustc
- **`linker-*.ld`**：架构特定链接脚本

---

## 四、编译构建工具需求

基于 `Dockerfile`、`rust-toolchain.toml`、`Makefile` 和 `Justfile` 分析：

| 类别 | 工具 |
|---|---|
| **Rust 工具链** | `rustc`、`cargo`（nightly-2025-01-18），组件 `rust-src`、`llvm-tools-preview`、`rustfmt` |
| **交叉编译目标** | `riscv64gc-unknown-none-elf`、`loongarch64-unknown-none` |
| **模拟器** | `qemu-system-riscv64`、`qemu-system-loongarch64` |
| **构建辅助** | `just`（开发用）、GNU `make`（评测用） |
| **容器环境** | Docker (`debian:trixie-slim`)，安装 `e2fsprogs`、`dosfstools`、`mtools` 等文件系统工具 |
| **CI** | GitHub Actions（仅用于同步到 GitLab，非构建 CI） |

构建流程简单：`make all` 分别对两个架构执行 `cargo build --release -p luwu-{riscv,loongarch}`，生成 `kernel-rv` 和 `kernel-la` 两个扁平内核镜像。

---

## 五、初步判断

1. **项目定位**：面向 OS 比赛的教学内核，AI 辅助编写。核心采用 "trait 抽象 + 泛型架构" 设计模式，架构隔离清晰。
2. **完成度较高的子系统**：ext4 文件系统是最庞大且实现最深入的部分（超过 10,000 行），包含 JBD2 日志、extent、HTree 等高级特性。进程管理、系统调用、VirtIO 块设备驱动也已具备基本形态。
3. **处于早期阶段的子系统**：网络栈未见实现（Justfile 中 QEMU 命令行虽有 virtio-net 设备但内核侧未搜索到网络相关模块）；调度器是简单的协作式模型；SMP 多核支持仅预留了注释。
4. **架构支持**：RISC-V 和 LoongArch 均以 QEMU `virt` 机器为基准，通过 OpenSBI（RISC-V）或直接加载（LoongArch DMW0 窗口）启动，尚未接入真实硬件。