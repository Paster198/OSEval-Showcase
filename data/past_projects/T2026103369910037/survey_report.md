# MeteorOS-X 项目初步调查报告

## 一、项目概览

**MeteorOS-X** 是一个基于 ArceOS 框架构建的 **RISC-V (RV64) / LoongArch 宏内核操作系统**，使用 Rust 语言为主要开发语言，辅以少量 C 和汇编。项目起源于全国大学生计算机系统能力大赛操作系统原理赛道，当前处于持续改进与维护阶段。代码规模约为 **47,285 行 Rust** 和 **6,609 行 C**，另有约 8 个汇编文件。

---

## 二、顶层文件结构

```
repo/
├── Cargo.toml          # Rust workspace 配置（17 个模块 + 5 个 API/ulib + 3 个 example）
├── Makefile             # 主构建入口（支持 riscv64, loongarch64, x86_64, aarch64）
├── build_disk.sh        # 磁盘镜像构建脚本（ext4/FAT32）
├── build_disk2.sh       # 多磁盘镜像构建脚本
├── rustfmt.toml         # Rust 格式化配置
├── .clang-format        # C 格式化配置
├── .gitmodules          # 子模块（linux_apps/kilo）
│
├── modules/             # 内核核心模块（17 个子系统）
├── crates/              # 基础工具 crates（6 个）
├── api/                 # API 层（3 个）
├── ulib/                # 用户态库（Rust axstd + C axlibc）
├── examples/            # 内核入口（3 个：init, simple_unikernel, oscomp_test）
├── user/                # 用户态程序（34 个应用 + user_runtime）
├── scripts/             # 构建辅助脚本
├── tools/               # 平台相关工具和辅助脚本
├── disk/                # 磁盘示例 C 程序
└── linux_apps/          # Linux 风格 C 应用（含 kilo 编辑器子模块）
```

---

## 三、子系统划分

### 3.1 内核核心模块 (`modules/`)

| 模块目录 | crate 名 | 所属子系统 | 说明 |
|----------|----------|-----------|------|
| `axhal` | `axhal` | **硬件抽象层 (HAL)** | 架构相关代码（RISC-V / LoongArch 的上下文切换、trap 处理）、平台相关代码（QEMU virt 的 boot、console、irq、timer、mem）、页表操作、TLS |
| `axconfig` | `axconfig` | **平台配置** | 平台常量与参数定义，支持 pc-x86、qemu-virt-riscv、qemu-virt-aarch64、qemu-virt-loongarch、raspi4-aarch64 共 5 种平台，含 TOML 配置与 build.rs 生成机制 |
| `axmem` | `axmem` | **内存管理** | 物理页帧分配、堆分配器、地址空间管理（MemorySet）、页表抽象 |
| `axalloc` | `axalloc` | **内存分配器** | 页分配和字节级分配器实现 |
| `axtask` | `axtask` | **任务管理** | 任务结构体、运行队列、等待队列、定时器、调度 API、单核任务管理 |
| `axprocess` | `axprocess` | **进程管理** | 进程结构体、进程管理器、调度器（processor）、上下文切换（含汇编 switch.S）、信号处理、信号量、条件变量、进程 ID 分配 |
| `axsync` | `axsync` | **同步原语** | 内核同步机制（基于 spinlock 等） |
| `axruntime` | `axruntime` | **运行时** | 内核初始化、Lang items、多核启动 (mp)、设备树解析 (dtb)、trap 分发 |
| `axdriver` | `axdriver` | **设备驱动** | PCI/MMIO 总线抽象、virtio 驱动框架、ixgbe 网卡驱动、驱动注册宏 |
| `axnet` | `axnet` | **网络栈** | 基于 smoltcp 的 TCP/UDP/DNS 实现、监听表、地址管理 |
| `axfs` | `axfs` | **文件系统** | ext4、FAT32、ramfs、devfs 多种 FS 实现；VFS 抽象层（dentry、file、mount、namespace、path）；页缓存；ELF 加载器 |
| `axfs-vfs` | `axfs_vfs` | **VFS 抽象** | VFS 类型与接口定义（供 axfs 使用） |
| `axfilelike` | `axfilelike` | **类文件抽象** | 统一的类文件接口 |
| `axdisplay` | `axdisplay` | **显示子系统** | virtio-gpu 图形输出 |
| `axlog` | `axlog` | **日志系统** | 内核日志输出 |
| `axns` | `axns` | **名字服务** | 命名服务（含测试） |
| `axsyscall` | `axsyscall` | **系统调用** | 完整的 syscall 实现：fs、net、task、vm、signal、sync、io、select/poll、随机数、misc 等分类 |

### 3.2 基础工具 crates (`crates/`)

| 目录 | 说明 |
|------|------|
| `memory_addr` | 物理/虚拟地址类型抽象 |
| `page_table` | 页表数据结构与操作 |
| `page_table_entry` | 页表项定义 |
| `spinlock` | 自旋锁实现 |
| `kernel_guard` | 内核守卫机制 |
| `axerrno` | 错误码定义 |

### 3.3 API 层 (`api/`)

| 目录 | 说明 |
|------|------|
| `axfeat` | 特性开关宏（feature flags） |
| `meteoros_api` | MeteorOS 对外 API（display, fs, mem, net, task） |
| `syslib` | 用户态系统调用库（syscall 封装、数据结构定义） |

### 3.4 用户库 (`ulib/`)

| 目录 | 说明 |
|------|------|
| `axstd` | Rust 用户态标准库替代（fs, net, io, thread, sync, process, time, env） |
| `axlibc` | C 库兼容层：Rust 侧（23 个 .rs 文件）+ C 侧（38 个 .c 文件），覆盖 POSIX 主要 API（stdio, stdlib, string, pthread, socket, signal, mmap, stat, poll/select 等） |

### 3.5 用户程序 (`user/`)

包含 34 个用户态应用：`shell`, `cat`, `chmod`, `clear`, `cp`, `df`, `echo_server`, `fs_bench`, `fstest`, `futex_test`, `ln`, `loop_test`, `ls`, `memtest`, `mkdir`, `mount`, `mv`, `nettest`, `poll_test`, `ps`, `pwd`, `readlink`, `remote_server`, `rm`, `rmdir`, `signal_test`, `sleep`, `sleep_test`, `stat`, `sync`, `task_test`, `thread_test`, `touch`, `umount`, `utimensat_test`。另有 `user_runtime` 提供用户态运行时支持。

---

## 四、架构与平台支持

| 架构 | 支持状态 | QEMU 平台 |
|------|---------|-----------|
| **RISC-V 64** | 主要目标（完整实现） | `qemu-virt-riscv` |
| **LoongArch 64** | 辅助目标（完整实现） | `qemu-virt-loongarch` |
| x86_64 | 配置定义存在，HAL 未实现 | `pc-x86`（仅 config） |
| AArch64 | 配置定义存在，HAL 未实现 | `qemu-virt-aarch64`, `raspi4-aarch64`（仅 config） |

HAL 层 (`axhal/src/platform/mod.rs`) 实际仅编译启用了 riscv64 和 loongarch64 两种架构，其他架构会触发 `compile_error!`。

---

## 五、构建工具依赖

根据 `README.md`、`Makefile` 和 `Cargo.toml`，构建需要以下工具：

### 必需工具
- **Rust 工具链**（rustc, cargo, rustup）+ `rust-src` 组件
- **cargo-binutils**：提供 `rust-objcopy`、`rust-objdump`
- **axconfig-gen**：内核配置代码生成
- **cargo-axplat**：平台配置处理
- **QEMU**：`qemu-system-riscv64` 或 `qemu-system-loongarch64`

### 可选（构建 C 应用和磁盘镜像）
- **RISC-V musl 交叉编译工具链** (`riscv64-linux-musl-cross`)
- **libclang-dev**：C 应用构建依赖
- **mkfs.ext4 / mkfs.vfat**：磁盘镜像格式化
- **GDB** (`gdb-multiarch`)：调试
- **clang-format**：C 代码格式化

### Makefile 关键构建变量
- `ARCH`：目标架构（默认 `riscv64`）
- `FEATURES`：启用的模块特性（如 `fs,ext4fs,irq`）
- `BLK`：块设备支持（`y/n`）
- `NET`：网络支持（`y/n`）
- `APP`：入口应用路径（默认 `examples/init`）
- `FS`：文件系统类型（`ext4`/`fat`）

---

## 六、初步总结

该项目是一个结构清晰、模块化程度较高的宏内核项目。其继承自 ArceOS 的模块化设计，以 Rust workspace 方式组织，内核模块之间通过明确的 crate 依赖解耦。已实现的子系统覆盖了操作系统核心功能的完整链条：

**内存管理 -> 进程/任务管理 -> 文件系统 (ext4/FAT32/ramfs/devfs + VFS) -> 网络栈 (smoltcp) -> 系统调用 -> 用户库 (Rust + C) -> 用户程序**

当前实际可运行的架构为 RISC-V 64 和 LoongArch 64，运行环境为 QEMU 模拟器。