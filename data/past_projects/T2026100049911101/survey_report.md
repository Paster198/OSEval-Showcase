# NCAIOS 项目初步调查报告

## 一、项目概述

NCAIOS 是一个基于 ByteOS 架构开发的操作系统内核，使用 **Rust** 语言编写。项目采用 **Workspace** 结构管理多个 crate，支持 **RISC-V、x86_64、AArch64、LoongArch64** 四种 CPU 架构。构建系统同时提供 **GNU Make**（`Makefile`）和 **Deno/TypeScript**（`byteos` 脚本）两套入口。项目总规模约 **110 个 Rust 源文件、13,430 行代码**（不含自动生成的 lock 和二进制文件）。

---

## 二、顶层目录结构

```
repo/
├── kernel/             # 内核主程序
├── filesystem/         # 文件系统层（7 个子 crate）
├── driver/             # 设备驱动（5 个子 crate）
├── crates/             # 核心基础库（5 个子 crate）
├── config/             # 平台配置与链接脚本
├── scripts/            # 构建辅助脚本（TypeScript + Make 片段）
├── tests/              # 测试用例（含 RISC-V 测试程序）
├── tools/              # 测试用文件系统内容
│   └── testcase-riscv64/   # busybox + musl 动态库
├── Cargo.toml          # workspace 根清单
├── Cargo.lock
├── Makefile            # GNU Make 构建入口
├── byteos              # Deno/TypeScript 构建入口
├── byteos.yaml         # 平台配置（target、驱动选择等）
├── rust-toolchain.toml # Rust 工具链版本锁定
├── Dockerfile          # Docker 构建环境
└── docker-compose.yml
```

---

## 三、子系统划分

### 3.1 内核主程序（`kernel/`）

**位置**: `kernel/src/`

是整个操作系统的核心入口，直接面向硬件，管理中断、系统调用、任务调度和用户态交互。

| 子模块 | 文件 | 职责 |
|--------|------|------|
| 入口与中断 | `main.rs`, `panic.rs` | 内核入口 `_start`、中断分发 `kernel_interrupt`、页错误处理 |
| 系统调用 | `syscall/mod.rs`, `fd.rs`, `mm.rs`, `task.rs`, `signal.rs`, `socket.rs`, `time.rs`, `shm.rs`, `sys.rs` | 约 9 类系统调用的实现（文件描述符、内存映射、进程/线程、信号、socket 网络、定时器、共享内存、系统信息） |
| 系统调用类型 | `syscall/types/mod.rs`, `mm.rs`, `poll.rs`, `signal.rs`, `time.rs` | 系统调用参数/返回类型的定义 |
| 任务管理 | `tasks/mod.rs`, `task.rs`, `exec.rs`, `elf.rs`, `initproc.rs`, `filetable.rs`, `stack.rs`, `shm.rs`, `memset.rs`, `async_ops.rs` | 用户任务结构体、ELF 加载（含动态链接）、进程 `exec`、init 进程、文件描述符表、栈管理、共享内存、异步操作（futex） |
| 用户态 | `user/mod.rs`, `entry.rs`, `signal.rs`, `socket_pair.rs` | 用户任务容器、用户态入口、信号分发、socket pair |
| 网络 | `socket.rs` | 内核态 socket 实现，基于 `lose-net-stack` |
| 工具 | `utils/mod.rs`, `useref.rs` | 用户指针安全引用 |
| 常量 | `consts.rs` | 用户栈顶、动态链接地址等常量 |

### 3.2 文件系统层（`filesystem/`）

**位置**: `filesystem/`，包含 7 个子 crate：

| Crate | 路径 | 说明 |
|-------|------|------|
| **vfscore** | `filesystem/vfscore/src/lib.rs` | VFS 核心接口定义：`INodeInterface` trait、`FileSystem` trait、`FileType`、`DirEntry`、`Stat`、`SeekFrom` 等。是文件系统的抽象基础 |
| **fs** | `filesystem/fs/src/` | VFS 实现层：文件系统初始化 `init()`、dentry 挂载点管理、`File` 抽象、`PathBuf`、管道 `pipe`、FatFs shim |
| **ext4rsfs** | `filesystem/ext4rsfs/src/lib.rs` | 基于纯 Rust 库 `ext4_rs` 的 ext4 文件系统实现 |
| **ext4fs** | `filesystem/ext4fs/src/lib.rs` | 另一个 ext4 实现 |
| **ramfs** | `filesystem/ramfs/src/lib.rs` | 纯内存文件系统，基于 BTreeMap |
| **devfs** | `filesystem/devfs/src/` | 设备文件系统，提供 `/dev/tty`, `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/rtc`, `/dev/shm`, `/dev/sdx` 等设备节点 |
| **procfs** | `filesystem/procfs/src/` | proc 文件系统，提供 `/proc/meminfo`, `/proc/interrupts`, `/proc/mounts` |

### 3.3 设备驱动（`driver/`）

**位置**: `driver/`，包含 5 个子 crate：

| Crate | 路径 | 说明 |
|-------|------|------|
| **kvirtio** | `driver/kvirtio/src/` | VirtIO 驱动：块设备 (`virtio_blk.rs`)、网络设备 (`virtio_net.rs`)、输入设备 (`virtio_input.rs`)、通用 VirtIO 实现 (`virtio_impl.rs`) |
| **kramdisk** | `driver/kramdisk/src/lib.rs` | RAM 磁盘块设备驱动 |
| **ns16550a** | `driver/ns16550a/src/lib.rs` | NS16550A UART 串口驱动 |
| **general-plic** | `driver/general-plic/src/` | PLIC 平台级中断控制器驱动 |
| **kgoldfish-rtc** | `driver/kgoldfish-rtc/src/lib.rs` | Goldfish RTC 实时时钟驱动 |

### 3.4 核心基础库（`crates/`）

**位置**: `crates/`，包含 5 个子 crate：

| Crate | 路径 | 说明 |
|-------|------|------|
| **executor** | `crates/executor/src/` | 异步任务执行器：提供 `async` 任务调度、`select` 宏、线程管理、`AsyncTask` 抽象 |
| **runtime** | `crates/runtime/src/` | 运行时内存管理：基于 buddy system 的帧分配器 (`frame.rs`)、堆初始化 (`heap.rs`) |
| **sync** | `crates/sync/src/lib.rs` | 同步原语：基于 `spin` crate 的 `Mutex`/`RwLock`、自定义 `LazyInit`（延迟初始化容器） |
| **libc-types** | `crates/libc-types/src/` | Linux 兼容类型定义：信号 (`signal.rs`)、时间 (`time.rs`)、内存映射 (`mman.rs`)、poll/epoll (`poll.rs`, `epoll.rs`)、fcntl、ioctl、futex、resource、sched、termios、utsname 等。按架构 (`arch/`) 区分 ABI |
| **devices** | `crates/devices/src/` | 设备抽象层：`Driver` trait 定义 (`device.rs`)、设备注册与发现（基于 FDT 解析 + `linkme` 分布式切片）、全局设备集 `DeviceSet`、IRQ 管理器 |

### 3.5 构建系统与配置（`config/`, `scripts/`）

| 组件 | 文件 | 说明 |
|------|------|------|
| 平台 YAML 配置 | `byteos.yaml` | 定义 7 种平台组合（riscv64-qemu, riscv64-vf2, x86_64-qemu, x86_64-generic, aarch64-qemu, loongarch64-qemu, loongarch64-2k1000），每平台指定 target、驱动、board 等 |
| 驱动配置文件 | `config/qemu.toml`, `k210.toml`, `cv1811h.toml` | 各平台驱动列表和特性开关 |
| 链接脚本 | `config/linker-general.ld`, `linker-k210.ld`, `linker-x86_64.ld`, `kernel/linker.lds.S` | 链接脚本，`build.rs` 根据架构动态生成 |
| GNU Make | `Makefile`, `scripts/config.mk` | Make 构建入口，支持 `build`/`run`/`boot`/`debug`/`fs-img` 等目标；通过 yq 解析 `byteos.yaml` |
| Deno/TS 工具 | `byteos`, `scripts/cli-build.ts`, `scripts/cli-qemu.ts`, `scripts/cargo.ts`, `scripts/platform.ts` | TypeScript 构建工具（Deno 运行时），调用 cargo 构建、rust-objcopy 转换、QEMU 启动 |

### 3.6 测试与工具（`tests/`, `tools/`）

| 组件 | 说明 |
|------|------|
| `tests/test.rs` | Rust 测试程序 |
| `tests/helloworld.c` | C 测试程序 |
| `tests/test.bash` | 测试脚本 |
| `tools/testcase-riscv64/` | RISC-V 测试用例：busybox + musl libc 动态库，内核启动后自动执行 `/bin/busybox ash` |

---

## 四、外部依赖概览

| 外部 crate | 用途 |
|-----------|------|
| `polyhal` (0.4.0) | 硬件抽象层：页表、中断、定时器、内存区域 |
| `polyhal-boot` / `polyhal-trap` | 启动与 trap 帧管理 |
| `fdt-parser` (0.4.12) | Flattened Device Tree 解析 |
| `lose-net-stack` | 用户态网络协议栈（TCP/UDP） |
| `xmas-elf` (0.9.0) | ELF 文件解析 |
| `ext4_rs` | 纯 Rust ext4 文件系统库 |
| `syscalls` | 系统调用号定义 |
| `buddy_system_allocator` | 伙伴系统物理内存分配器 |
| `spin` | 自旋锁（Mutex/RwLock） |
| `linkme` | 分布式切片（用于驱动自动注册） |
| `downcast-rs` | 动态类型转换 |
| `hashbrown` | 高性能 HashMap |
| `futures-lite` | 轻量 Future 支持 |
| `bit_field` | 位域操作 |

---

## 五、构建工具链总结

构建该项目需要的工具：

1. **Rust 工具链**: `nightly-2025-02-01`，组件包括 `rust-src`、`rustfmt`、`clippy`、`llvm-tools-preview`、`rust-analyzer`；目标架构包括 `riscv64gc-unknown-none-elf`、`riscv64imac-unknown-none-elf`、`x86_64-unknown-none`、`aarch64-unknown-none-softfloat`、`loongarch64-unknown-none`
2. **cargo-binutils**: 提供 `rust-objcopy` 用于 ELF 到 binary 的转换
3. **GNU Make**: 主要构建入口
4. **yq** (v4.44.6+): 解析 `byteos.yaml` 供 Makefile 使用
5. **QEMU**: 多架构模拟（`qemu-system-riscv64`、`qemu-system-x86_64`、`qemu-system-aarch64`、`qemu-system-loongarch64`）
6. **文件系统工具**: `mkfs.ext4`、`mkfs.vfat`、`dd`、`mount`/`umount`
7. **Deno**（可选）: TypeScript 构建工具 `./byteos` 的运行时
8. **Docker**（可选）: 提供容器化构建环境

典型的构建命令为：
```bash
make PLATFORM=riscv64-qemu run
```