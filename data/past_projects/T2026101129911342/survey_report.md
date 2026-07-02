## KunikOS 项目初步调查结果

---

### 一、仓库文件组织结构

```
.
├── Cargo.toml              # Cargo workspace 根配置
├── Makefile                # 构建封装（build + QEMU 运行）
├── rust-toolchain.toml     # Rust 工具链版本与编译目标声明
├── README.md               # 项目说明
├── NOTICE                  # 开源借鉴致谢
├── LICENSE-MIT / LICENSE-APACHE  # 双许可证
├── docs/
│   ├── DESIGN.md           # 完整设计文档
│   └── PRINCIPLES.md       # 工程准则
├── kernel/                 # 架构无关内核（核心 crate: kunikos）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # 内核入口 + 测试框架（harness）
│       ├── syscall.rs      # 系统调用分发层（102 个系统调用）
│       ├── fs.rs           # 文件描述符表 + 内存文件存储
│       ├── ext4.rs         # ext4 只读文件系统
│       ├── virtio_blk.rs   # virtio-blk 块设备驱动
│       ├── net.rs          # 内存回环网络（loopback socket）
│       ├── heap.rs         # 内核堆分配器（空闲链表）
│       └── lang.rs         # panic handler
├── khal/                   # 硬件抽象层（核心 crate: khal）
│   ├── Cargo.toml
│   ├── linker/
│   │   ├── riscv64.ld      # RISC-V64 链接脚本
│   │   └── loongarch64.ld  # LoongArch64 链接脚本
│   └── src/
│       ├── lib.rs          # HAL 公共接口（编译期 cfg 分发）
│       ├── riscv64.rs      # RISC-V64 平台实现
│       └── loongarch64.rs  # LoongArch64 平台实现
└── user/
    └── hello.c             # 用户态测试程序（musl 静态编译）
```

总计 **18 个源文件**（含链接脚本），代码总量约 **4095 行**。

---

### 二、子系统划分

该项目采用严格的双层架构：`khal`（硬件抽象层）+ `kernel`（架构无关内核）。

| 子系统 | 所属文件 | 职责概要 |
|---|---|---|
| **硬件抽象层** | `khal/src/lib.rs`、`riscv64.rs`、`loongarch64.rs` | 编译期 `cfg` 分发，封装控制台 I/O、关机、陷入/异常处理、分页、用户态切换、ELF 加载、定时器中断等全部架构差异 |
| **启动与测试框架** | `kernel/src/main.rs` | 内核入口 `kunikos_main`，按序初始化各子系统，根据磁盘内容自动选择测试集（basic / libc-test / lua / LTP）并执行 |
| **内存管理** | `kernel/src/heap.rs` + `khal` 中的分页/帧分配 | 内核堆：64 MiB 静态区上的空闲链表分配器（首次适配+合并）；khal 中实现页表创建、帧分配、动态映射 |
| **陷入/异常/中断** | `khal` 中的 trap handler | RISC-V `stvec` 与 LoongArch `EENTRY` 入口，保存/恢复上下文，分发系统调用、断点、定时器中断 |
| **系统调用层** | `kernel/src/syscall.rs` | 按 `asm-generic` 统一编号分发 102 个系统调用，语义对齐 Linux（`write`、`mmap`、`futex`、`ppoll`、`rt_sigprocmask` 等） |
| **文件系统** | `kernel/src/fs.rs` + `kernel/src/ext4.rs` | `fs.rs`：进程 fd 表 + 内存 inode 存储（文件数据全量载入内存）；`ext4.rs`：ext4 只读驱动（超级块解析、extent 树、目录项遍历） |
| **块设备驱动** | `kernel/src/virtio_blk.rs` | virtio-blk 驱动，RISC-V 走 MMIO 传输，LoongArch 走 PCI 现代传输（ECAM 枚举 + BAR 分配），共用 split virtqueue 核心逻辑 |
| **网络** | `kernel/src/net.rs` | 单进程内存回环网络，支持 UDP 数据报投递和 TCP connect/listen/accept 配对，满足 libc-test socket 测试 |
| **Panic 处理** | `kernel/src/lang.rs` | `panic_handler`：打印信息后关机 |

---

### 三、构建工具概览

基于 `Makefile` 和 `Cargo.toml` 分析，构建该项目需要以下工具：

| 工具 | 用途 |
|---|---|
| **Rust 工具链** `nightly-2026-05-28` | 编译内核本体，需 `rust-src`、`rustfmt`、`clippy` 组件 |
| **RISC-V 裸机目标** `riscv64gc-unknown-none-elf` | RISC-V64 内核交叉编译 |
| **LoongArch 裸机目标** `loongarch64-unknown-none-softfloat` | LoongArch64 内核交叉编译 |
| **GNU Make** | `make all` / `make run-rv` / `make run-la` 构建与运行 |
| **QEMU** (`qemu-system-riscv64` / `qemu-system-loongarch64`) | 模拟运行 |
| **RISC-V musl GCC** (`riscv64-linux-musl-gcc`) | 编译 `user/hello.c` 用户态测试程序（可选） |

关键构建命令：
- `make all` — 产出 `kernel-rv`（RISC-V64）与 `kernel-la`（LoongArch64）
- `make run-rv` / `make run-la` — 在 QEMU 上运行对应架构内核
- 链接脚本由 `RUSTFLAGS="-C link-arg=-T<ld>"` 在编译时指定

该项目为 **零外部依赖**（`Cargo.lock` 仅含 `khal` 与 `kunikos` 两个成员），无第三方 crate 依赖。