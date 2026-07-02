## 项目初步调查结果

### 一、项目概览

该项目名为 **wll_OS**，是一个面向操作系统大赛的类 Unix 教学/竞赛型 Rust 内核。项目支持 **RISC-V64** 与 **LoongArch64** 双架构，以 Linux 兼容的系统调用接口运行真实用户态程序（glibc/musl libc 测试、BusyBox、LTP 等）。

---

### 二、顶层文件组织结构

```
repo/
├── Cargo.toml              # 工作空间根清单，仅包含 os 成员 + patch 覆盖
├── Cargo.lock              # 锁定依赖版本
├── Makefile                # 主构建入口（make all / build / check）
├── rust-toolchain.toml     # 固定工具链: nightly-2025-01-18
├── Dockerfile / Dockerfile.eval / docker-compose.yml  # Docker 构建/评测环境
├── build.sh / build.ps1 / build2.ps1 / build_kernels.sh / build_la.ps1  # 构建脚本
├── run_qemu.sh / run_qemu.ps1 / run_qemu.bat / ...   # QEMU 启动脚本
├── run_test.sh / run_simple.bat / ...                # 测试运行脚本
├── create_kernel_zip.py    # 打包内核评测产物
├── la.dtb                  # LoongArch 设备树
├── 12345初赛*              # 初赛文档/视频/PPT
├── README.md               # 项目说明
├── EVALUATION.md           # 评测环境搭建说明
│
├── os/                     # ★ 内核主 crate
│   ├── Cargo.toml          # 内核 crate 清单（含依赖、target rustflags、features）
│   ├── build.rs            # 构建脚本（生成预加载应用、链接脚本、ext4 预载）
│   ├── src/                # 内核 Rust 源代码
│   └── user/               # 用户态辅助 C 代码（libctest_extra.c）
│
├── patch/                  # ★ 本地 patch 的 polyhal 系列 crate
│   ├── polyhal/            # 硬件抽象层 (核心)
│   ├── polyhal-boot/       # 启动支持
│   └── polyhal-trap/       # 陷入/中断处理
│
├── docs/                   # 文档
│   ├── architecture.md     # 系统架构说明
│   ├── syscalls.md         # 系统调用说明
│   ├── syscall-matrix.md   # 系统调用矩阵（详细状态）
│   ├── filesystem.md       # 文件系统说明
│   ├── memory-management.md
│   ├── process-management.md
│   ├── elf-loader.md
│   ├── blocking-semantics.md
│   └── ...                 # 开发日志、审计、回归基线等
│
├── plans/                  # 开发计划文档（团队协作、增量开发方案）
├── scripts/                # 辅助脚本（perf runner、judge、vendor 管理等）
├── testdata/               # 评测用 judge 脚本（judge_*.py）+ postwork
├── vendor/                 # 离线 vendored 依赖 crate（~75 个）
├── vendor_hidden/          # 另一份 vendor 副本（结构相同，用于隐藏恢复）
├── offline_crate_sources/  # 额外离线 crate 源（buddy_system_allocator、sbi-spec）
└── oscargo/config.toml     # .cargo/config.toml 模板（vendor源配置）
```

---

### 三、内核子系统结构 (`os/src/`)

内核源码按功能划分为以下子系统模块：

| 子系统 | 目录/文件 | 角色 | 关键源文件 |
|--------|----------|------|-----------|
| **入口与初始化** | `main.rs` | 内核入口、模块声明、页分配器、平台初始化 | `main.rs` (465行) |
| **配置** | `config/` | 架构相关常量与配置（RISC-V/LoongArch 两套） | `config/mod.rs`, `config/rv.rs`, `config/la.rs` |
| **内存管理** | `mm/` | 物理帧分配、页表、虚拟地址空间、ELF加载、堆分配 | `frame_allocator.rs`, `page_table.rs`, `memory_set.rs`, `map_area.rs`, `elf_loader.rs`, `heap_allocator.rs` |
| **进程/任务管理** | `task/` | TCB、调度器、PID分配、上下文切换、等待队列、评测harness | `task.rs`, `manager.rs`, `processor.rs`, `context.rs`, `pid.rs`, `wait_queue.rs`, `harness.rs` |
| **文件系统** | `fs/` | VFS框架、MemFS内存文件系统、ext4卷、VFAT、文件描述符、块设备抽象 | `vfs.rs`, `mod.rs` (MemFS), `fd.rs`, `ext4_vol.rs`, `vfat.rs`, `block_dev.rs` |
| **系统调用** | `syscall/` | 系统调用分发、按领域分类处理 | `mod.rs` (分发+调用号定义), `fs.rs`, `mm.rs`, `process.rs`, `signal.rs`, `net.rs`, `other.rs`, `user.rs` |
| **中断/陷入** | `trap/` | 异常/中断处理、系统调用入口、前台驱动模式 | `mod.rs`, `interrupts.rs` |
| **驱动** | `drivers/` | VirtIO块设备驱动（MMIO for RISC-V, PCI for LoongArch） | `mod.rs`, `hal.rs`, `virtio_mmio_blk.rs`, `virtio_pci_blk.rs` |
| **定时器** | `timer.rs` | 时钟管理、时间片、sleep/timeout等待队列 | `timer.rs` (192行) |
| **控制台** | `console.rs` | 串口输出（putchar） | `console.rs` |
| **工具** | `utils/` | 错误码定义、字符串工具 | `error.rs`, `mod.rs` |
| **语言项** | `lang_items.rs` | Rust no_std 所需语言项（panic handler 等） | `lang_items.rs` |
| **日志** | `logging.rs` | 内核日志宏 | `logging.rs` |
| **汇编入口** | `entry_riscv64.asm`, `entry_loongarch64.asm` | 架构相关启动汇编 | 两个 .asm 文件 |
| **链接脚本** | `linker_riscv64.lds`, `linker_loongarch64.lds` | 内核内存布局 | 两个 .lds 文件 |

---

### 四、子系统归属初步判定

基于目录结构和文件内容，各子系统职责如下：

1. **内存管理子系统 (mm/)**：物理页帧分配（基于 `buddy_system_allocator`）、页表抽象、虚拟地址空间 (`MemorySet`)、mmap/munmap/mprotect/brk 支持、ELF 程序加载器。

2. **进程管理子系统 (task/)**：`TaskControlBlock`（含凭证、文件系统上下文、内存上下文、信号处理）、线程组 (`ThreadGroup`)、调度器 (`Processor` + `manager`)、PID 分配、任务上下文切换 (`TaskContext`)、等待队列 (`WaitQueue`)、评测 harness（用于驱动测试流程）。

3. **文件系统子系统 (fs/)**：
   - **VFS 层** (`vfs.rs`)：统一文件操作接口（open/read/write/truncate/mkdir/unlink/rename/symlink/mount 等），权限检查。
   - **MemFS** (`mod.rs`)：内存中的文件系统实现，支持常规文件、目录、符号链接、设备节点、FIFO、Socket。
   - **文件描述符表** (`fd.rs`)：进程级 FD 管理，支持 pipe、socketpair、eventfd、epoll。
   - **ext4 卷** (`ext4_vol.rs`)：基于 `ext4_rs` 的 ext4 只读/读写支持。
   - **VFAT** (`vfat.rs`)：VFAT 文件系统支持。
   - **块设备抽象** (`block_dev.rs`)：统一 VirtIO 块设备接口。

4. **系统调用子系统 (syscall/)**：约 130+ 个 Linux 兼容系统调用，按领域分为：
   - `fs.rs`：文件/目录操作（openat, read, write, lseek, stat, getdents64, mount, ...）
   - `mm.rs`：内存操作（brk, mmap, munmap, mprotect, madvise, shm*）
   - `process.rs`：进程操作（clone, execve, exit, wait4, sched_*, getpid, ...）
   - `signal.rs`：信号操作（kill, tkill, sigaction, sigprocmask, sigreturn, ...）
   - `net.rs`：网络操作（socket, bind, listen, accept, connect, sendto, recvfrom, ...）
   - `other.rs`：其他（futex, getrandom, times, uname, sysinfo, ...）
   - `user.rs`：用户态辅助

5. **中断/陷入子系统 (trap/)**：处理用户态陷入（系统调用）、异常（非法指令、段错误转 SIGILL/SIGSEGV）、定时器中断。支持"前台驱动模式"用于同步评测。

6. **驱动子系统 (drivers/)**：VirtIO-MMIO（RISC-V 设备树枚举）和 VirtIO-PCI（LoongArch ECAM 枚举）块设备驱动。

7. **定时器子系统 (timer.rs)**：10MHz 时钟基准、时间片调度（10ms/50ms）、sleep 等待队列。

8. **硬件抽象层**：通过本地 patch 的 `polyhal` / `polyhal-boot` / `polyhal-trap` 三个 crate 提供架构无关的页面分配、启动、陷入帧等抽象。

---

### 五、构建工具需求

基于 Makefile、Cargo.toml 和 build.rs 的分析，构建该项目需要：

| 工具 | 用途 | 说明 |
|------|------|------|
| **Rust 工具链** `nightly-2025-01-18` | 编译内核 | 固定版本，需 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 目标 |
| **Cargo** | Rust 构建系统 | 使用 `--locked --offline` 模式，依赖 vendored crates |
| **GNU Make** | 顶层构建编排 | `make all` / `make build` / `make check` |
| **python3** | vendor checksum 刷新、评测脚本 | `scripts/refresh_vendor_checksums.py` |
| **xz** (可选) | 解压 SD 卡镜像 | `sdcard-rv.img.xz` / `sdcard-la.img.xz` |
| **QEMU** (运行时) | 模拟 RISC-V/LoongArch | 用于运行和测试内核 |
| **OpenSBI/RustSBI** (运行时) | RISC-V SBI 固件 | QEMU 启动时加载 |
| **Docker** (可选) | 评测环境 | `docker-compose.yml` + `Dockerfile` |

构建流程：`make` → `prepare-cargo-config`（恢复 vendor、刷新 checksum、复制 cargo config）→ `cargo build --locked --offline --release --target <target>`。内核最终产物为 `target/<target>/release/wll_OS`，分别复制为 `kernel-rv` 和 `kernel-la`。

---

### 六、关键外部依赖 (Cargo)

| 依赖 | 版本 | 用途 |
|------|------|------|
| `polyhal` 系列 | 0.4.0 (本地 patch) | 硬件抽象层（页分配、启动、陷入帧） |
| `buddy_system_allocator` | 0.11.0 | 物理页帧伙伴分配器 |
| `spin` | 0.9.8 | 自旋锁（内核同步） |
| `lazy_static` | 1.4.0 | 延迟初始化静态变量 |
| `ext4_rs` | 1.3.3 | ext4 文件系统解析 |
| `ext4-view` | 0.9.3 | ext4 镜像构建时预载 |
| `virtio-drivers` | 0.7.4 | VirtIO 块设备驱动 |
| `flat_device_tree` | 3.1.1 | 设备树解析 |
| `riscv` | 0.11 | RISC-V 架构特定寄存器/指令封装 |
| `loongArch64` | 0.2 (optional) | LoongArch 架构特定支持 |
| `bitflags` | 2.4.0 | 位标志宏 |
| `log` | 0.4 | 日志接口 |

---

### 七、初步总结

该项目是一个结构完整、模块化程度较高的 Rust 教学/竞赛内核，具有以下特点：

- **双架构支持**：RISC-V64（默认）和 LoongArch64，通过 `polyhal` 抽象层和条件编译 (`#[cfg]`) 实现。
- **子系统划分清晰**：内存管理、进程管理、文件系统（VFS + MemFS + ext4 + VFAT）、系统调用、中断/陷入、驱动、定时器等模块各自独立。
- **系统调用覆盖较广**：约 130+ 个 Linux 兼容系统调用，覆盖文件 IO、进程管理、内存管理、信号、网络 socket、同步原语（futex）等。
- **评测导向设计**：内置评测 harness、judge 脚本、bounded LTP slice，面向大赛评测流程优化。
- **离线构建**：全部依赖 vendored，支持 `--offline` 构建。
- **构建系统**：Makefile + Cargo，支持 feature flags（dev-preload, libctest, iozone, lmbench, ltp）控制构建行为。