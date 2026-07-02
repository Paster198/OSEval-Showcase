## 项目结构速览

该项目是一个基于 Rust 编写的 OS 内核，队名 **NameNotFound**（西安电子科技大学）。其核心特征是**组件化架构**：模块之间不直接 `use` 彼此，而是通过声明 **Need / Provide**（需要/提供）由生成器在编译期静态接线。

### 顶层目录布局

```
.
├── kernel/                    # 内核主体代码（arch / l0 / l1 / l2 分层）
│   ├── src/                   # 源代码
│   │   ├── arch/              #   架构抽象层（RISC-V / LoongArch）
│   │   ├── l0/                #   内核机制层（物理页、堆、陷阱、调度、设备...）
│   │   ├── l1/                #   OS 对象语义层（任务、VFS、IPC、ELF...）
│   │   ├── l2/                #   系统调用 ABI 层（Linux ABI、syscall 入口、shell）
│   │   ├── generated/         #   生成器产出的接线代码
│   │   ├── bin/               #   各平台入口点 (qemu_riscv64 / qemu_loongarch64)
│   │   ├── init.rs            #   InitResult 类型定义
│   │   └── lib.rs             #   内核库根
│   ├── linker/                # 链接脚本
│   │   ├── riscv64-qemu.ld    #   RISC-V (BASE=0x80200000)
│   │   └── loongarch64-qemu.ld#   LoongArch (PHYS_BASE=0x00400000)
│   ├── Cargo.toml
│   └── Makefile               # 子构建与 QEMU 运行
├── crate/ext4_rs/             # 外部 ext4 文件系统 crate
├── tools/
│   ├── archgen/               # 架构生成器（核心：解析 module.toml，生成接线代码）
│   ├── docker/                # Docker 测试镜像
│   ├── qemu/                  # 本地 QEMU 构建脚本
│   ├── testdisk/              # 测试磁盘镜像构建
│   └── testsuite/             # 测试套件资产准备
├── cargo/config.toml          # Cargo 配置（build-std 等）
├── config.mk                  # 顶层构建配置（特性开关、测试开关）
├── services.toml              # 全局服务/副作用定义（98 个 service，8 个 effect）
├── Makefile                   # 顶层 Makefile（构建、测试、QEMU 启动）
├── Cargo.toml                 # workspace 定义
├── rust-toolchain.toml        # nightly-2025-01-18
├── project-design.md          # 详细设计文档
└── docs/                      # 文档（AI 记录 / 人类 / 生成）
```

### 代码规模

| 范围 | Rust 文件数 | 代码行数 |
|------|------------|---------|
| kernel/src | 254 | ~22,144 |
| crate/ext4_rs | ~20+ | ~8,816 |
| tools/archgen | 1 | ~1,778 |
| **合计** | **~283** | **~32,738** |

共有 **48 个模块**定义了 `module.toml`（其中 47 个 `enabled=true`，`tcp_core` 为 `false`）。

---

## 子系统识别

### 架构层 (`kernel/src/arch/`)

不参与 Need/Provide 体系，由 L0 直接调用。包含两套 ISA 后端：

- `arch/imp/riscv64.rs` — RISC-V 64 位后端
- `arch/imp/loongarch64.rs` — LoongArch 64 位后端
- `arch/imp/generic.rs` — 通用/桩实现

提供的抽象：`barrier`、`boot`、`cache`、`console`、`cpu`、`debug`、`dma`、`irq`、`mmio`、`smp`、`syscall`、`thread`、`timer`、`trap`、`vm`。

### L0 —— 内核机制层

去掉用户态仍然有意义的基础机制。按 Stage 排序：

| Stage | 目录 | 模块 | 功能 |
|-------|------|------|------|
| 00 | `00_raw` | `raw_panic` | 原始 panic 停机 |
| 00 | `00_seed` | `boot_info_seed` | 从固件获取原始启动信息（内存布局、DTB、命令行） |
| 00 | `00_seed` | `cpu_raw` | 原始 CPU 信息 |
| 00 | `00_seed` | `panic_halt` | Panic 后停机 |
| 05 | `05_arch` | `arch_primitives` | CPU local / IRQ flag / 原始自旋锁 |
| 10 | `10_early_output` | `early_console` | 早期字节输出（轮询串口） |
| 10 | `10_early_output` | `panic_early_print` | panic 时早期打印 |
| 20 | `20_boot_memory` | `boot_memory` | 标准化内存图、initrd |
| 30 | `30_page` | `page_alloc` | 物理页分配 |
| 30 | `30_page` | `page_map` | 页表映射 |
| 40 | `40_heap` | `kernel_heap` | 内核堆分配 |
| 40 | `40_heap` | `dynamic_log` | 动态日志（堆后可用） |
| 50 | `50_trap` | `trap_core` | 异常/上下文切换 |
| 50 | `50_trap` | `user_copy_raw` | 用户态内存拷贝 |
| 60 | `60_irq_time` | `irq_core` | 中断管理 |
| 60 | `60_irq_time` | `clock_alarm` | 时钟与闹钟 |
| 70 | `70_run` | `scheduler` | 任务调度器 |
| 70 | `70_run` | `wait_work` | 等待队列 |
| 80 | `80_device` | `device_core` | 总线/DMA/字符设备/块设备框架 + virtio-mmio-blk + virtio-pci-blk |
| 85 | `85_storage` | `ext4_core` | ext4 文件系统适配器 |
| 90 | `90_ready` | `l0_ready` | L0 就绪标记 |

### L1 —— OS 对象语义层

用户间接触及、但不绑具体 ABI：

| Stage | 目录 | 模块 | 功能 |
|-------|------|------|------|
| 10 | `10_identity` | `context_core` | 当前上下文/凭证/命名空间 |
| 20 | `20_task` | `task_mm_signal` | 任务/用户内存/信号 |
| 30 | `30_vfs` | `vfs_fd` | VFS/fd/mount/tmpfs/procfs/devfs |
| 31 | `31_vfs_cache` | `page_cache` | 页面缓存 |
| 40 | `40_ipc_net_device` | `ipc_net_device` | IPC、socket、tty |
| 40 | `40_ipc_net_device` | `tcp_core` | TCP 协议栈（**禁用**） |
| 50 | `50_bridge` | `elf` | ELF 加载器 |
| 50 | `50_bridge` | `exec` | exec 执行逻辑 |
| 50 | `50_bridge` | `exit_wait` | 退出/等待 |
| 50 | `50_bridge` | `file_mapping` | 文件映射 (mmap) |
| 50 | `50_bridge` | `fork` | fork |
| 50 | `50_bridge` | `futex` | futex |
| 50 | `50_bridge` | `pipe_file` | 管道 |
| 50 | `50_bridge` | `poll` | poll/select |
| 50 | `50_bridge` | `proc_export` | /proc 导出 |
| 50 | `50_bridge` | `ptrace` | ptrace |
| 50 | `50_bridge` | `socket_file` | socket 文件 |
| 60 | `60_user_boot` | `user_boot` | 挂根、启动 init |
| 90 | `90_ready` | `l1_ready` | L1 就绪标记 |

### L2 —— 系统调用 ABI 层

只做翻译，不做策略：

| Stage | 目录 | 模块 | 功能 |
|-------|------|------|------|
| 10 | `10_abi` | `linux_abi` | Linux 结构体布局、syscall 编号 |
| 20 | `20_syscall_args` | `syscall_args` | 参数解析、errno 映射 |
| 30 | `30_syscall_handlers` | `syscall_handlers` | 各 syscall 薄实现（进程/内存/时间/IPC/socket/misc） |
| 30 | `30_syscall_handlers` | `sys_fs` | 文件系统 syscall |
| 30 | `30_syscall_handlers` | `sys_signal` | 信号 syscall |
| 40 | `40_table` | `syscall_table` | 系统调用分发表 |
| 50 | `50_syscall_entry` | `syscall_entry` | 系统调用入口 + 第一个用户进程 |
| 90 | `90_shell` | `shell_init` | 测试套件 runner / shell |

### 工具与辅助

- **archgen**（`tools/archgen/`）：解析所有 `module.toml` 和 `services.toml`，生成 `mod.rs`、`need.rs` 和 `kernel/src/generated/init_plan.rs`。
- **ext4_rs**（`crate/ext4_rs/`）：独立 ext4 文件系统实现 crate。
- **测试辅助**（`tools/testdisk/`、`tools/testsuite/`）：构建测试磁盘镜像、准备测试资产。

---

## 编译构建与工具链需求

| 要素 | 详情 |
|------|------|
| **语言** | Rust（`no_std`） |
| **工具链** | `nightly-2025-01-18`，需 `rust-src` + `llvm-tools-preview` |
| **目标平台** | `riscv64gc-unknown-none-elf`、`loongarch64-unknown-none-softfloat` |
| **构建系统** | GNU Make（顶层 + kernel 子目录）+ Cargo |
| **代码生成** | `cargo run -p archgen -- gen`（在 cargo build 前运行） |
| **关键 cargo 参数** | `-Z build-std=core,alloc` |
| **镜像转换** | `llvm-objcopy` 或 `rust-objcopy`（RISC-V 二进制剥离） |
| **模拟器** | QEMU 9.2.1（RISC-V 和 LoongArch） |
| **固件** | OpenSBI（RISC-V） |
| **文件系统** | ext4（通过 `crate/ext4_rs`），镜像用 `mkfs.ext4` |
| **测试镜像** | xz/zstd 压缩的 sdcard 镜像，含 musl/glibc 测试套件 |
| **可选工具** | Docker（比赛测试环境） |

典型构建流程：

```
make gen           # 生成接线代码
make check-arch    # cargo check (RISC-V)
make all           # 产出 kernel-rv, kernel-la, disk.img, disk-la.img
make qemu-rv       # QEMU 运行 RISC-V
make test-rv       # 运行测试套件
```

---

## 初步总结

1. **架构独特性**：该项目不是传统的单体内核结构，而是采用 Need/Provide 依赖注入 + Level/Stage 分层 + Effect 副作用约束的三维模块化管理。生成器 `archgen` 在编译前解析所有 `module.toml`，生成接线代码，确保依赖方向始终从高层到低层、从高 Stage 到低 Stage。

2. **已实现子系统**：覆盖了从启动（boot_info、early_console）、内存管理（page_alloc、page_map、kernel_heap）、中断与陷阱（trap、irq、clock_alarm）、调度（scheduler、wait_work）、设备驱动（virtio mmio/pci block、console、net）、文件系统（VFS、ext4、tmpfs、procfs、devfs、page_cache）、进程管理（task、fork、exec、exit_wait、futex、signal）、IPC（pipe、socket、poll）到完整 Linux ABI 系统调用层的全套子系统。

3. **双架构支持**：RISC-V 64（`riscv64gc-unknown-none-elf`）和 LoongArch 64（`loongarch64-unknown-none-softfloat`），各有独立链接脚本和入口。

4. **未完成/禁用的模块**：`tcp_core`（L1, stage 40）标记为 `enabled = false`，TCP 协议栈尚未实现。

5. **构建依赖**：核心依赖为 Rust nightly 工具链、GNU Make、QEMU。无其他重型第三方运行时依赖。