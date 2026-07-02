## 项目结构分析报告

### 一、仓库整体结构

本项目名为 **PwnMyOS**，是基于 **Nonix** 继续开发的 OS 内核项目，面向 2026 年全国大学生计算机系统能力大赛操作系统设计赛。采用 Rust 语言编写，主要支持 **RISC-V64** 与 **LoongArch64** 两种架构。

```
repo/
├── Cargo.toml              # Rust workspace 配置
├── Makefile                 # 主构建脚本
├── rust-toolchain.toml      # Rust 工具链 (nightly-2025-02-01)
├── README.md
├── .gitignore
├── cache.txt                # GDB 调试命令备忘
├── runall.sh                # 批量运行脚本
├── os/                      # [核心] 内核主 crate
│   ├── Cargo.toml
│   └── src/
├── user/                    # [核心] 用户态测试程序 crate
│   ├── Cargo.toml
│   ├── Makefile
│   └── src/
├── lwext4_rust/             # [核心] ext4 文件系统绑定 crate
│   ├── Cargo.toml
│   ├── build.rs
│   └── src/
├── bootloader/              # SBI 固件 (rustsbi-qemu.bin)
├── patch/                   # 本地 patched 依赖 (cty, polyhal, virtio-drivers)
├── vendor/                  # 大量 vendored 第三方 crates
├── tests/                   # Python 测试脚本 (12个)
└── 初赛提交材料/             # 初赛文档
```

### 二、内核子系统划分

以下基于 `os/src/` 目录结构分析各子系统（按代码规模排序）：

| 子系统 | 目录 | 代码量 | 说明 |
|--------|------|--------|------|
| **系统调用** | `os/src/syscall/` | ~4,418 行 | 约 60+ 个 Linux 兼容系统调用，覆盖进程管理、文件系统、内存映射、信号等 |
| **文件系统** | `os/src/fs/` | ~4,385 行 | VFS 层 + ext4 (lwext4) + devfs + pipe + socket + stdio + mount |
| **内存管理** | `os/src/mm/` | ~2,021 行 | 物理页帧分配器、堆分配器、页表管理、内存集(MemorySet)、mmap |
| **任务管理** | `os/src/task/` | ~1,879 行 | 进程/线程管理、调度、PID 分配、上下文切换、等待状态 |
| **设备驱动** | `os/src/drivers/` | ~683 行 | virtio-blk 块设备驱动 |
| **工具/辅助** | `os/src/utils/` | ~549 行 | 错误码、hart 管理、字符串工具 |
| **信号处理** | `os/src/signal/` | ~323 行 | 信号标志、信号动作、信号表 |
| **陷阱/中断** | `os/src/trap/` | ~173 行 | 陷入处理、中断分发 |
| **配置** | `os/src/config/` | ~68 行 | 架构相关常量、RISC-V/LoongArch 配置 |
| **同步原语** | `os/src/sync/` | ~44 行 | UPSafeCell 内部可变性封装 |
| **顶层模块** | `os/src/*.rs` | ~348 行 | main入口、控制台、日志、时钟、语言项 |

### 三、关键依赖与分层架构

1. **硬件抽象层 (HAL)**：依赖于 `polyhal` (本地 patched 版本)，提供跨架构的页表、中断、上下文切换、Percpu、定时器等抽象。`polyhal-trap` 提供 trapframe 定义。

2. **文件系统**：通过 `lwext4_rust` 绑定 C 库 `lwext4` 实现 ext4 支持，构建时依赖 bindgen 和 C 交叉编译工具链。

3. **块设备**：virtio-blk 驱动，通过 `virtio-drivers` (本地 patched) 实现。

4. **用户态**：`user/` crate 编译为独立二进制，包含 fork、文件操作、信号等测试程序。

### 四、构建工具需求

根据 `Makefile` 和 `Cargo.toml` 分析：

| 工具类别 | 具体工具 | 用途 |
|----------|----------|------|
| **Rust 工具链** | `rustc`, `cargo`, `rust-src`, `llvm-tools-preview` | 内核和用户程序编译 |
| **Rust target** | `riscv64gc-unknown-none-elf`, `loongarch64-unknown-none` | 交叉编译目标 |
| **Rust 辅助** | `rust-objdump`, `rust-objcopy` (cargo-binutils) | 反汇编、strip |
| **Docker** | `docker.educg.net/cg/os-contest:20260510` | 官方构建/测评容器 |
| **QEMU** | `qemu-system-riscv64`, `qemu-system-loongarch64` | 模拟运行 |
| **C 交叉工具链** | RISC-V musl GCC (bootlin), LoongArch GCC | `lwext4_rust` 的 C 库编译 |
| **文件系统工具** | `mkfs.ext4`, `dd` 等 | 磁盘镜像制作 |
| **GDB** | `gdb-multiarch` | 调试 |

`lwext4_rust` 编译时需要通过 `bindgen` 生成 Rust FFI 绑定到 C 的 `lwext4` 库，需要对应的 C 交叉编译器（RISC-V musl 和 LoongArch GCC）。

### 五、初步评估

- **项目成熟度**：内核总代码量约 14,891 行（`os/src/`），加上 `lwext4_rust` 和 `user/`，整体规模中等偏大，属于较完整的内核项目。
- **系统调用覆盖**：从 syscall 模块可见支持 60+ 个 Linux 兼容系统调用，覆盖度较高。
- **架构支持**：RISC-V64 和 LoongArch64 双架构，通过 polyhal 实现硬件抽象。
- **文件系统**：集成 ext4（基于 lwext4 C 库），支持设备文件系统、管道、socket 等。
- **测试体系**：`tests/` 目录含 12 个 Python 测试脚本，覆盖信号、futex、clone、utimensat 等语义验证；`user/test/` 含用户态功能测试。