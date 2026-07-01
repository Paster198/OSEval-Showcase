## Pantheon OS 内核项目结构分析

### 项目概述

**Pantheon** 是一个基于 RISC-V 64 位硬件平台实现的宏内核操作系统，采用无栈协程架构，支持多核 CPU。项目使用 Rust 语言编写，目标平台包括 QEMU virt 和 StarFive VisionFive2 开发板。

### 仓库文件组织结构

```
Pantheon/
├── pantheon/              # 核心代码目录
│   ├── kernel/            # 内核主程序
│   ├── lib/               # 内核库集合（19个库）
│   └── user/              # 用户态程序和库
├── part/                  # 二进制部件（SBI固件、磁盘镜像）
├── tests/                 # 测试文件
├── docs/                  # 文档
├── Cargo.toml             # Rust workspace 配置
├── Makefile               # 构建脚本
└── rust-toolchain.toml    # Rust 工具链版本
```

### 实现的子系统

#### 1. 进程与任务管理 (`kernel/src/task/`)
- 任务调度器 (`schedule.rs`)
- 处理器管理 (`processor.rs`)
- 线程组支持 (`thread_group.rs`)
- 进程退出处理 (`exit.rs`)
- 初始化进程 (`initproc/`)

#### 2. 内存管理 (`kernel/src/kmm/`)
- 虚拟内存管理 (`kvmm.rs`)
- 内存集合 (`memory_set.rs`)
- 内存映射 (`mmap.rs`)

#### 3. 文件系统 (`kernel/src/fs/`)
- ext4 文件系统 (`ext4/`)
- 临时文件系统 (`tmp/`)
- 管道 (`pipe.rs`)
- 套接字文件 (`socketfile.rs`)
- 页缓存 (`page_cache.rs`)
- 文件描述符表 (`fdtable.rs`)
- 挂载管理 (`mount.rs`)
- 标准I/O (`stdio.rs`)
- 随机设备 (`urandom.rs`)

#### 4. 网络子系统 (`kernel/src/knet/`)
- TCP 协议 (`tcp.rs`)
- UDP 协议 (`udp.rs`)
- Unix 域套接字 (`unix.rs`)
- 地址管理 (`address.rs`)
- 端口管理 (`port_manager.rs`)
- 基于 smoltcp 实现

#### 5. 进程间通信 (`kernel/src/ipc/`)
- 共享内存 (`shm.rs`)
- 信号机制 (`signal.rs`)

#### 6. 设备管理 (`kernel/src/devices/`)
- 块设备 (`Block/`) - 支持 virtio、内存镜像、VF2 SD卡
- GPU 设备 (`GPU/`)
- 随机数设备 (`Random/`)
- UART 串口 (`Uart/`)
- PLIC 中断控制器 (`plic.rs`)

#### 7. 设备驱动 (`kernel/src/drivers/`)
- VirtIO 块设备驱动 (`Block/virtio/`)
- VirtIO GPU 驱动
- VirtIO 输入设备驱动
- UART 驱动 (`Uart/`)
- 设备探测 (`Probe/`)

#### 8. 系统调用 (`kernel/src/syscall/`)
- 文件系统调用 (`impls/fs.rs`)
- 内存管理调用 (`impls/mm.rs`)
- 网络调用 (`impls/net.rs`)
- 进程管理调用 (`impls/process.rs`)
- 信号调用 (`impls/signal.rs`)
- GUI 调用 (`impls/gui.rs`)
- I/O 调用 (`impls/io.rs`)
- Futex 调用 (`syscall/futex.rs`)

#### 9. 陷阱与中断处理 (`kernel/src/trap/`)
- 陷阱处理程序 (`handler.rs`)
- 汇编入口 (`trap.S`)

#### 10. I/O 多路复用 (`kernel/src/io/`)
- 文件描述符集合 (`fdset.rs`)
- Poll 文件描述符 (`pollfd.rs`)

#### 11. 平台支持 (`kernel/src/platform/`)
- QEMU RISC-V 平台 (`Qemu_Riscv/`)
- StarFive VisionFive2 平台 (`Starfive2_Riscv/`)
- 基础 RISC-V 支持 (`Base_Riscv/`)

### 内核库 (`pantheon/lib/`)

| 库名 | 功能 |
|------|------|
| `arch` | 架构相关代码 |
| `config` | 配置管理 |
| `executor` | 异步执行器（无栈协程） |
| `fat32` | FAT32 文件系统实现 |
| `hart` | 硬件线程管理 |
| `kalloc` | 内核内存分配器 |
| `klog` | 内核日志系统 |
| `kmem` | 内核内存管理基础 |
| `kpath` | 路径处理 |
| `ksync` | 同步原语 |
| `ktime` | 时间管理 |
| `lwext4_rust` | ext4 文件系统（C库绑定） |
| `nix` | Unix 风格工具 |
| `task` | 任务结构定义 |
| `trap` | 陷阱结构定义 |
| `utils` | 通用工具 |
| `vfs` | 虚拟文件系统层 |
| `virtio-drivers2` | VirtIO 驱动 |
| `visionfive2-sd` | VisionFive2 SD卡驱动 |

### 用户态程序 (`pantheon/user/`)

**应用程序**:
- `initproc` - 初始化进程
- `shell` / `shell2` - 命令行解释器
- `step1` - 初赛测试程序
- `runtests` - 测试运行器
- `editor` - 文本编辑器
- `paint` - 绘图程序
- `gui_simple` - 简单GUI应用
- `window_manager` - 窗口管理器
- `uitest` - UI测试
- `FILE_SELECT` - 文件选择器

**用户库**:
- `libd` - 用户态库，包含系统调用封装、GUI支持、事件处理

### 构建工具需求

1. **Rust 工具链**: rustc, cargo, rust-objcopy
2. **RISC-V 交叉编译工具链**: riscv64-unknown-elf-gdb (调试)
3. **QEMU**: qemu-system-riscv64 (RISC-V 64位模拟器)
4. **SBI 固件**: RustSBI (part/bin/rustsbi-qemu.bin)
5. **构建工具**: GNU Make
6. **文件系统工具**: mkfs.ext4, dd, losetup, mount (制作磁盘镜像)
7. **设备树工具**: dtc (可选，用于设备树转换)

### 技术特点

- 使用 Rust 的 async/await 实现无栈协程
- 支持 VirtIO 设备（块设备、网络、GPU、输入设备）
- 实现了完整的 POSIX 风格系统调用接口
- 支持 ext4 和 FAT32 文件系统
- 实现了 TCP/IP 网络栈（基于 smoltcp）
- 包含 GUI 支持（VirtIO GPU）
- 支持多核处理器