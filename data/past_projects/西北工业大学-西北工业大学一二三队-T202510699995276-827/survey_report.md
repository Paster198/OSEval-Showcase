# NPUcore_for_oscomp2025 项目初步调查报告

## 一、项目概述

本项目名为 **NPUcore_for_oscomp2025**，由西北工业大学三位同学基于 NPUcore-lwext4 框架开发，是面向 2025 年操作系统内核赛道的竞赛操作系统。项目支持 **RISC-V** 和 **LoongArch** 双架构平台，使用 **Rust** 语言编写，采用 `no_std` 裸机内核开发模式。

## 二、仓库顶层结构

```
.
├── bootloader/          # 引导加载程序（预编译的 fw_payload.bin）
├── dependency/          # 本地依赖库（vendored）
├── doc/                 # 文档（技术报告、PPT、PDF 等）
├── os/                  # 内核主体代码
├── user/                # 用户态程序与测试套件
├── util/                # 工具（mkimage、QEMU 2K1000 模拟器）
├── Makefile             # 顶层构建入口
├── copyglibc.sh         # glibc 复制脚本
├── copymusl.sh          # musl libc 复制脚本
├── LICENSE              # 许可证
└── README.md            # 项目说明
```

## 三、内核子系统划分

内核代码位于 `os/src/` 目录下，共约 **170 个 Rust 源文件**，可划分为以下子系统：

### 1. 硬件抽象层（HAL）— `os/src/hal/`

负责屏蔽不同架构和平台的差异，包含三个子模块：

| 子模块 | 路径 | 说明 |
|--------|------|------|
| 架构支持 | `hal/arch/riscv/` | RISC-V 架构：入口汇编、链接脚本、SBI 调用、SV39 页表、上下文切换、中断陷入 |
| 架构支持 | `hal/arch/loongarch64/` | LoongArch64 架构：入口汇编、链接脚本、寄存器定义（CSR/TLB/定时器/RAS）、上下文切换、中断陷入、ACPI、TLB 管理 |
| 平台配置 | `hal/platform/` | 具体板级支持：RISC-V（QEMU/Fu740/K210/VisionFive2）、LoongArch（QEMU/2K1000） |
| 配置 | `hal/configs/` | TOML 格式的板级硬件配置描述文件 |

### 2. 内存管理（MM）— `os/src/mm/`

| 文件 | 说明 |
|------|------|
| `address.rs` | 地址抽象（物理地址/虚拟地址） |
| `frame_allocator.rs` | 物理页帧分配器 |
| `heap_allocator.rs` | 内核堆分配器 |
| `map_area.rs` | 内存映射区域 |
| `memory_set.rs` | 地址空间（MemorySet）管理 |
| `page_table.rs` | 页表管理 |
| `zram.rs` | ZRAM 压缩内存（用于 OOM 处理） |

特性标志中包含 `swap`、`zram`、`oom_handler`，表明实现了交换分区和内存不足处理机制。

### 3. 进程/任务管理（Task）— `os/src/task/`

| 文件 | 说明 |
|------|------|
| `task.rs` | 进程/任务控制块 |
| `threads.rs` | 线程支持 |
| `context.rs` | 上下文定义 |
| `elf.rs` | ELF 加载器 |
| `manager.rs` | 任务管理器 |
| `pid.rs` | PID 分配 |
| `processor.rs` | 处理器调度 |
| `signal.rs` | 信号机制 |

### 4. 文件系统（FS）— `os/src/fs/`

文件系统子系统规模较大（约 40 个文件），实现了 VFS 层和两种具体文件系统：

| 子模块 | 说明 |
|--------|------|
| VFS 层 | `vfs.rs`、`inode.rs`、`dirent.rs`、`filesystem.rs`、`file_descriptor.rs`、`file_trait.rs`、`directory_tree.rs`、`cache.rs`、`poll.rs`、`layout.rs`、`timestamp.rs`、`swap.rs` |
| FAT32 | `fat32/`（7 个文件）：FAT32 文件系统实现 |
| EXT4 | `ext4/`（16 个文件）：EXT4 文件系统实现，含超级块、块分配、inode、extent、目录项、CRC 校验等 |
| 设备文件 | `dev/`：null、zero、urandom、pipe、tty、hwclock、interrupts、socket 等伪文件系统 |

### 5. 设备驱动（Drivers）— `os/src/drivers/`

| 子模块 | 说明 |
|--------|------|
| 块设备 | `block/`：VirtIO 块设备、VirtIO PCI 块设备、SATA 块设备、内存块设备 |
| 串口 | `serial/`：NS16550A UART 驱动 |

### 6. 网络子系统（Net）— `os/src/net/`

| 文件 | 说明 |
|------|------|
| `tcp.rs` | TCP 协议支持 |
| `udp.rs` | UDP 协议支持 |
| `unix.rs` | Unix 域套接字 |
| `address.rs` | 网络地址抽象 |
| `config.rs` | 网络配置 |

底层使用 `smoltcp` 网络协议栈库。

### 7. 系统调用（Syscall）— `os/src/syscall/`

| 文件 | 说明 |
|------|------|
| `mod.rs` | 系统调用分发 |
| `fs.rs` | 文件系统相关系统调用 |
| `process.rs` | 进程相关系统调用 |
| `net.rs` | 网络相关系统调用 |
| `errno.rs` | 错误码定义 |
| `syscall_id.rs` | 系统调用号定义 |
| `syscall_macro.rs` | 系统调用宏 |

据 README 描述，支持或不完全支持的系统调用多达 **100 个**。

### 8. 其他模块

| 文件/目录 | 说明 |
|-----------|------|
| `main.rs` | 内核入口 |
| `console.rs` | 控制台输出 |
| `timer.rs` | 定时器管理 |
| `lang_items.rs` | Rust `no_std` 语言项实现 |
| `math/` | 数学运算辅助 |
| `utils/` | 工具模块（错误处理、随机数） |

## 四、用户态与测试

- `user/src/`：用户态库（`user_lib`），包含系统调用封装、initproc 等
- `user/fs/`：文件系统镜像所需的目录结构（bin、etc、root、var）
- `user/busybox_lua_testsuites/`：LoongArch 平台的 busybox/lua 测试套件

## 五、本地依赖库

| 依赖 | 路径 | 说明 |
|------|------|------|
| `riscv` | `dependency/riscv/` | RISC-V CSR 寄存器访问库 |
| `rustsbi` | `dependency/rustsbi/` | RustSBI 固件接口 |
| `virtio-drivers` | `dependency/virtio-drivers/` | VirtIO 设备驱动 |
| `dep_pci` | `dependency/dep_pci/` | PCI 总线驱动 |
| `dep_iso` | `dependency/dep_iso/` | isomorphic_drivers 驱动框架 |
| `rlibc` | `dependency/rlibc/` | 裸机 C 库函数实现 |

## 六、构建工具链需求

| 工具 | 用途 |
|------|------|
| **Rust 工具链** | `rustc`（nightly-2025-01-18）、`cargo`、`rust-src`、`llvm-tools` — 内核与用户态编译 |
| **RISC-V 交叉编译工具链** | `riscv64-unknown-elf-gcc/ld/as/objdump/objcopy` — RISC-V 架构链接与汇编 |
| **LoongArch 交叉编译工具链** | `loongarch64-unknown-elf-gcc/ld/as` — LoongArch 架构链接与汇编 |
| **QEMU** | RISC-V 和 LoongArch 系统模拟器（项目自带 LoongArch 2K1000 的定制 QEMU） |
| **GNU Make** | 构建系统入口 |
| **mkimage** | 内核镜像打包（`util/mkimage`） |
| **dtc** | 设备树编译（可能用于 RISC-V 平台） |
| **文件系统工具** | `mkfs.ext4`、`mkfs.vfat`、`mcopy`、`dd` — 制作文件系统镜像 |
| **OpenSBI/RustSBI** | RISC-V SBI 固件（`bootloader/fw_payload.bin`） |
| **Python** | 辅助脚本（可能用于测试自动化） |

构建系统采用分层 Makefile 结构：顶层 `Makefile` 调用 `os/Makefile`，后者根据目标架构分发到 `os/make/rv64.mk` 或 `os/make/la64.mk`。默认配置为 `board_rvqemu + block_virt`（RISC-V QEMU + VirtIO 块设备），文件系统默认 `ext4`。