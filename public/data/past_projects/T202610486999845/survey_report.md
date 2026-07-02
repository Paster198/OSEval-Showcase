## 项目初步调查结果

### 一、项目概览

项目名称为 **alRED OS**（OSKernel2026-alREDy），是一个用 Rust 编写的双架构 OS 内核，面向全国大学生计算机系统能力大赛 OS 内核设计赛。同时维护 **RISC-V64** 和 **LoongArch64** 两套评测入口，目前 RISC-V64 为真实实现主线。

---

### 二、顶层目录结构

```
.
├── Makefile                  # 顶层双架构构建与本地评测入口
├── os/                       # RISC-V64 内核实现（主线）
├── os-la/                    # LoongArch64 内核实现
├── user/                     # 早期教学/本地用户程序（测试用）
├── rv-placeholder/           # 历史占位产物（仅输出占位信息后关机）
├── scripts/                  # Docker 本地评测与 LTP 辅助脚本
├── Dockerfile                # 容器化构建
├── .github/                  # CI 配置
├── .devcontainer/            # 开发容器配置
├── README.md                 # 项目说明
├── alRED OS设计文档.pdf      # 阶段性设计文档
└── AI辅助编程声明.md          # AI 辅助编程声明
```

---

### 三、源码文件组织（`os/` 与 `os-la/`）

两个架构目录的源码布局**基本一致**，各自包含相同的模块集合，按行数规模排列如下：

| 模块路径 | 行数(RV) | 行数(LA) | 子系统归属 |
|---|---|---|---|
| `src/platform/contest/mod.rs` | 12,117 | 12,874 | **评测 harness** — 挂载测试盘、发现脚本、调度测试组、维护平台日志协议 |
| `src/syscall/fs.rs` | 21,209 | 21,131 | **文件系统系统调用** — fd 表、overlay VFS、pipe、socket stub、mount、ioctl、mqueue、IPC |
| `src/syscall/process.rs` | 8,712 | 9,084 | **进程系统调用** — 进程/线程、exec、fork、wait、信号、futex 和时间 |
| `src/syscall/mod.rs` | 928 | 929 | **系统调用分发** — syscall 号定义与路由（约 70+ 个 syscall）、返回类型 |
| `src/task/user.rs` | 2,213 | 2,529 | **任务管理** — 用户地址空间、页表、lazy allocation、fork 快照、协作线程 |
| `src/loader/elf.rs` | 425 | 1,046 | **ELF 加载器** — 解析 ELF64、加载动态解释器、构造用户栈和 auxv |
| `src/fs/ext4.rs` | 431 | 431 | **EXT4 文件系统** — 只读 EXT4 挂载、inode 遍历、文件读取 |
| `src/drivers/virtio.rs` | 327 | 503 | **设备驱动** — QEMU virtio-blk 设备访问 |
| `src/batch.rs` | 164 | 164 | **批处理子系统** — 内核栈/用户栈结构、AppManager |
| `src/trap/mod.rs` | 98 | 97 | **陷阱处理** — 中断/异常入口与分发 |
| `src/sbi.rs` | 74 | 33 | **SBI 调用封装** — 字符输出、关机 |
| `src/arch.rs` | 71 | 82 | **架构相关** — CSR 读写、特权级操作 |
| `src/console.rs` | 40 | 58 | **控制台输出** — 基于 SBI 的 println 实现 |
| `src/logging.rs` | 47 | 47 | **日志** — log crate 集成 |
| `src/main.rs` | 45 | 45 | **内核入口** — 清 BSS、初始化、进入 harness |
| `src/trap/context.rs` | 36 | 30 | **陷阱上下文** — TrapContext 结构定义 |
| `src/sync/up.rs` | 35 | 35 | **同步原语** — UPSafeCell（单核互斥） |
| `src/task/mod.rs` | 22 | 22 | 任务模块入口 |
| `src/lang_items.rs` | 19 | 19 | **语言项** — panic handler |
| `src/fs/mod.rs` | 8 | 8 | 文件系统模块入口 |
| `src/drivers/mod.rs` | 8 | 8 | 驱动模块入口 |
| `src/platform/mod.rs` | 8 | 8 | 平台模块入口 |
| `src/sync/mod.rs` | 5 | 5 | 同步模块入口 |
| `src/platform/contest/basic.rs` | 40 | 40 | 基础测试组 fallback runner |
| `src/loader/mod.rs` | 12 | 11 | 加载器模块入口 |
| — | — | — | — |
| `src/contest.rs` | — | 14 | LA 专用：占位 harness |
| `src/fallback.rs` | — | 38 | LA 专用：no_core 兜底内核 |

辅助文件：
- `src/entry.asm` — 汇编入口（各架构）
- `src/linker-qemu.ld` — 链接脚本（RV: 0x80200000，LA: 0x200000）
- `src/trap/trap.S` — 陷阱汇编入口
- `build.rs` — 构建脚本（嵌入用户程序二进制 / 查找 libgcc_s.so.1）
- `cargo-config.toml` — Cargo 目标配置
- `scripts/qemu-ver-check.sh` — QEMU 版本检查

---

### 四、子系统识别

根据源码结构和模块划分，该项目实现的主要子系统如下：

| 子系统 | 涉及模块 | 功能描述 |
|---|---|---|
| **启动与初始化** | `main.rs`, `entry.asm`, `lang_items.rs`, `linker-qemu.ld` | BSS 清零、控制台初始化、陷阱初始化，进入平台 harness |
| **架构抽象层** | `arch.rs`, `trap/trap.S`, `trap/context.rs`, `trap/mod.rs` | RISC-V/LoongArch 特权级操作、CSR 读写、中断/异常入口与上下文保存恢复 |
| **SBI 接口** | `sbi.rs` | 封装 SBI ecall：字符输出、关机 |
| **控制台与日志** | `console.rs`, `logging.rs` | 基于 SBI 的格式化输出、log crate 支持 |
| **设备驱动** | `drivers/virtio.rs` | virtio-mmio 块设备驱动，提供块级读取接口 |
| **文件系统** | `fs/ext4.rs`, `fs/mod.rs` | 只读 EXT4 实现：挂载、inode 解析、目录遍历、文件读取 |
| **ELF 加载器** | `loader/elf.rs`, `loader/mod.rs` | ELF64 解析、动态链接器加载、用户栈与 auxv 构造 |
| **任务管理** | `task/mod.rs`, `task/user.rs` | 用户地址空间管理、页表、lazy allocation、fork 快照、协作线程 |
| **系统调用层** | `syscall/mod.rs`, `syscall/fs.rs`, `syscall/process.rs` | 70+ Linux 兼容系统调用：文件 IO、进程管理、信号、futex、epoll、inotify、xattr、pipe、socket stub、mmap/munmap、时间等 |
| **同步原语** | `sync/mod.rs`, `sync/up.rs` | 单核 UPSafeCell（基于静态借用检查的互斥） |
| **评测 Harness** | `platform/mod.rs`, `platform/contest/mod.rs`, `platform/contest/basic.rs` | 测试盘挂载、脚本扫描、测试组调度（basic/busybox/lua/libcbench/libctest/iozone/lmbench/cyclictest/iperf/netperf/LTP）、compat bridge、平台日志协议 |
| **用户程序（user/）** | `user/src/bin/*.rs`, `user/src/lib.rs`, `user/src/syscall.rs` | 早期测试用独立用户程序（hello_world, store_fault, power, priv_inst, priv_csr, test_basic/brk/chdir/clone） |

---

### 五、编译构建工具需求

根据 `Makefile`、`build.rs` 和 `Cargo.toml` 分析，构建该项目的工具链需求为：

**RISC-V64 构建（`os/`）：**
- Rust 工具链：`rustc`, `cargo`（edition 2024）
- 交叉编译目标：`riscv64gc-unknown-none-elf`
- 辅助工具：`rust-objdump`, `rust-objcopy`（来自 `cargo-binutils`）
- 链接脚本：`src/linker-qemu.ld` → 自动复制为 `src/linker.ld`
- 模拟器：`qemu-system-riscv64`（版本 >= 7）
- 可选：`riscv64-linux-gnu-gcc`（用于查找 `libgcc_s.so.1` 运行时库）

**LoongArch64 构建（`os-la/`）：**
- Rust 工具链：`rustc`, `cargo`
- 交叉编译目标：`loongarch64-unknown-none`
- 辅助工具：`rust-objdump`
- 模拟器：`qemu-system-loongarch64`
- 若目标未预装则回退到 `fallback.rs`（no_core 最小内核），或通过 `BUILD_LA_WITH_BUILD_STD=1` 使用 `-Zbuild-std=core`

**用户程序构建（`user/`）：**
- 目标：`riscv64gc-unknown-none-elf`（或 `loongarch64-unknown-none`）
- 依赖：`riscv` crate（RISC-V 内联汇编支持）

**顶层构建：**
- GNU Make
- Docker（可选，用于容器化构建与评测）