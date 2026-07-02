## 项目初步调查结果

---

### 一、项目概述

该项目名为 **NPUcore-Ovo**，是一个面向全国大学生计算机系统能力大赛（操作系统设计赛）内核实现赛道的竞赛操作系统内核。基于 Rust（no_std）编写，支持 **RISC-V 64** 和 **LoongArch 64** 双架构。项目基于 `NPUcore-BLOSSOM` 框架迭代开发，数据结构与命名风格部分参考 Linux 内核。

---

### 二、顶层文件组织结构

```
.
├── Makefile                  # 顶层构建入口，代理到 os/Makefile
├── README.md                 # 项目说明
├── kernel-qemu               # 预编译内核二进制（QEMU用，raw binary）
├── move.sh                   # 辅助脚本
├── 全国赛调试记录.md          # 调试记录
├── 开发日志.md                # 开发日志
├── os/                       # ★ 内核源代码（Rust workspace 主包）
├── user/                     # ★ 用户态库与用户程序（Rust 包）
├── bootloader/               # SBI 固件镜像（fw_payload.bin 等）
├── dependency/               # 第三方依赖 crate 源码（vendored）
├── apps/                     # C 语言用户应用（kilo 编辑器、tetris 游戏）
├── docs/                     # 设计文档与架构文档
├── tools/                    # 本地自动化测试脚本
├── util/                     # 实用工具（mkimage、QEMU 2K1000 二进制）
└── local-autotest-full/      # （用途待确认）
```

---

### 三、子系统划分与目录归属

#### 1. 硬件抽象层 (HAL) —— `os/src/hal/`

| 子目录/文件 | 职责 |
|---|---|
| `hal/arch/riscv/` | RISC-V 架构相关：页表 (sv39)、SBI 调用、上下文切换 (switch.S)、陷入处理 (trap)、内核栈、链接脚本 |
| `hal/arch/loongarch64/` | LoongArch 架构相关：LAFlex 页表、SBI、上下文切换、陷入处理、链接脚本、ACPI |
| `hal/platform/riscv/` | RISC-V 平台板级支持：QEMU virt、VisionFive2、K210、FU740 |
| `hal/platform/loongarch64/` | LoongArch 平台板级支持：QEMU virt、2K1000 开发板 |
| `hal/configs/` | 架构/平台配置文件（TOML 格式） |
| `hal/mod.rs` | HAL 模块入口 |

#### 2. 内存管理 (MM) —— `os/src/mm/`

| 文件 | 职责 |
|---|---|
| `address.rs` | 虚拟/物理地址抽象 |
| `page_table.rs` | 页表管理（sv39/LAFlex 统一抽象） |
| `memory_set.rs` | 进程地址空间 (MemorySet) |
| `map_area.rs` | 内存映射区域管理 |
| `frame_allocator.rs` | 物理帧分配器 |
| `heap_allocator.rs` | 内核堆分配器 |
| `bitmap_alloc.rs` | 位图分配器 |
| `memory_builder.rs` | 地址空间构建辅助 |
| `zram.rs` | ZRAM 压缩内存 |
| `mod.rs` | MM 模块入口 |

#### 3. 进程/任务管理 (Task) —— `os/src/task/`

| 文件 | 职责 |
|---|---|
| `task.rs` | 任务控制块 (TCB) 定义 |
| `manager.rs` | 任务管理器（创建、回收、查找） |
| `processor.rs` | 处理器管理（Per-CPU 结构） |
| `cfs_scheduler.rs` | CFS 公平调度器 |
| `sched_class.rs` | 调度类抽象（RT/CFS/Idle） |
| `context.rs` | 任务上下文字段定义 |
| `elf.rs` | ELF 加载器 |
| `pid.rs` | PID 分配器 |
| `signal.rs` | 信号处理 |
| `state_machine.rs` | 任务状态机 |
| `threads.rs` | 线程管理 |
| `mod.rs` | Task 模块入口 |

#### 4. 文件系统 (FS) —— `os/src/fs/`

| 子目录/文件 | 职责 |
|---|---|
| `fs/ext4/` | EXT4 文件系统实现（超级块、inode、extent、块分配、目录项、CRC） |
| `fs/fat32/` | FAT32 文件系统实现（inode、布局、目录迭代、位图） |
| `fs/dev/` | 设备文件系统（proc、anon、pipe、tty、null/zero、urandom、socket、block、tun、hwclock、interrupts） |
| `vfs.rs` | 虚拟文件系统抽象 |
| `filesystem.rs` | 文件系统挂载管理 |
| `file_descriptor.rs` | 文件描述符表 |
| `file_trait.rs` | 文件操作 trait |
| `inode.rs` | VFS inode 抽象 |
| `directory_tree.rs` | 目录树（挂载点、路径解析） |
| `dirent.rs` | 目录项 |
| `cache.rs` | 页面缓存 (Page Cache) |
| `layout.rs` | 磁盘布局抽象 |
| `poll.rs` | 多路复用 (poll/select) |
| `swap.rs` | Swap 交换空间 |
| `timestamp.rs` | 文件时间戳 |

#### 5. 网络协议栈 (Net) —— `os/src/net/`

| 文件 | 职责 |
|---|---|
| `mod.rs` | 网络模块入口，基于 smoltcp |
| `tcp.rs` | TCP Socket 实现 |
| `udp.rs` | UDP Socket 实现 |
| `unix.rs` | Unix Domain Socket |
| `address.rs` | 网络地址抽象 |
| `config.rs` | 网络配置 |

#### 6. 系统调用 (Syscall) —— `os/src/syscall/`

| 文件 | 职责 |
|---|---|
| `dispatch.rs` | 系统调用分发 |
| `fs.rs` | 文件系统相关系统调用 |
| `process.rs` | 进程管理相关系统调用 |
| `net.rs` | 网络相关系统调用 |
| `io_ops.rs` | I/O 操作相关系统调用 |
| `context.rs` | 系统调用上下文 |
| `errno.rs` | 错误码定义 |
| `syscall_id.rs` | 系统调用号定义 |
| `syscall_macro.rs` | 系统调用辅助宏 |
| `mod.rs` | Syscall 模块入口 |

#### 7. 设备驱动 (Drivers) —— `os/src/drivers/`

| 子目录/文件 | 职责 |
|---|---|
| `drivers/block/` | 块设备驱动：VirtIO-BLK、VirtIO-BLK-PCI、SATA AHCI、内存模拟块设备、DMA 池 |
| `drivers/serial/` | 串口驱动：NS16550A |
| `mod.rs` | Drivers 模块入口 |

#### 8. 其它内核模块 —— `os/src/`

| 文件 | 职责 |
|---|---|
| `main.rs` | 内核入口点，初始化流程 |
| `timer.rs` | 时钟管理与定时器 |
| `console.rs` | 控制台输出（串口） |
| `lang_items.rs` | Rust `#[lang]` 项（panic_handler 等） |
| `load_img.S` / `load_img-rv.S` | 内核镜像加载汇编 |
| `preload_app.S` / `preload_app-rv.S` | 预装应用汇编 |
| `utils/` | 工具函数：错误处理 (`kerror.rs`)、中断守卫、随机数、遥测 (`telemetry.rs`)、追踪 (`trace.rs`) |
| `math/` | 数学辅助函数 |

#### 9. 用户态 —— `user/`

| 子目录/文件 | 职责 |
|---|---|
| `user/src/lib.rs` | 用户库 (user_lib) |
| `user/src/syscall.rs` | 用户态系统调用封装 |
| `user/src/usr_call.rs` | 用户态调用封装 |
| `user/src/bin/` | 用户程序：initproc（初始化进程）、yield_bench |
| `user/fs/` | 文件系统镜像内容（bin/bash、etc、root、var） |
| `user/testcases/` | 测试用例 |

#### 10. 第三方依赖（Vendored）—— `dependency/`

| 子目录 | 说明 |
|---|---|
| `dependency/riscv/` | RISC-V 架构 crate |
| `dependency/rlibc/` | 简易 C 库 |
| `dependency/virtio-drivers/` | VirtIO 驱动 crate |
| `dependency/rustsbi/` | RustSBI 实现 |
| `dependency/dep_iso/` | isomorphic_drivers（含 AHCI、E1000 网卡等） |
| `dependency/dep_pci/` | PCI 总线驱动 |

---

### 四、构建工具链需求

根据 Makefile 与 Cargo.toml 分析，构建该项目需要以下工具：

| 工具 | 用途 |
|---|---|
| **Rust nightly-2025-01-18** | 编译器（需要大量 nightly 特性） |
| **rust-src** | 标准库源码（no_std 构建需要） |
| **llvm-tools / cargo-binutils** | rust-objdump、rust-objcopy（生成二进制与反汇编） |
| **RISC-V target: `riscv64gc-unknown-none-elf`** | RISC-V 交叉编译 |
| **LoongArch target: `loongarch64-unknown-none`** | LoongArch 交叉编译 |
| **GNU Make** | 构建自动化（顶层 Makefile + os/Makefile + os/make/{rv64,la64}.mk） |
| **QEMU** | 模拟运行（RISC-V virt / LoongArch virt） |
| **OpenSBI / RustSBI** | RISC-V SBI 固件（预编译在 bootloader/） |
| **mkimage**（U-Boot 工具） | LoongArch 2K1000 板级镜像制作（预编译在 util/） |
| **mkfs.ext4 / mkfs.vfat / mcopy / dd** | 文件系统镜像制作 |

---

### 五、初步结论

1. **项目规模**：内核源码约 187 个 Rust 文件 + 10 个汇编文件，代码量较大，属于中等偏上规模的竞赛内核项目。

2. **架构设计**：采用分层设计——HAL 层隔离硬件差异，上层子系统（MM、Task、FS、Net、Syscall）与架构解耦。支持 RISC-V（sv39 页表）和 LoongArch（LAFlex 页表）双架构。

3. **功能完整度**：实现了现代操作系统的核心子系统——进程管理（CFS 调度 + RT 调度 + 多核 SMP）、虚拟内存（分页 + CoW + ZRAM + Swap）、文件系统（FAT32 + EXT4 + VFS + 设备文件）、网络协议栈（基于 smoltcp 的 TCP/UDP）、以及大量兼容 Linux 的系统调用。

4. **构建方式**：使用 Rust nightly 工具链 + GNU Make，通过 feature flags 切换架构和平台。构建入口为 `os/Makefile`，实际构建规则在 `os/make/rv64.mk` 和 `os/make/la64.mk`。

5. **可进入下一步深入分析**：建议下一步关注 (a) 内核初始化流程 (`main.rs`)、(b) HAL 层架构抽象的具体实现方式、(c) 进程调度与多核支持、(d) 文件系统的具体实现深度。