## Chronix OS 内核项目探索报告

### 一、项目概况

Chronix 是一个用 Rust 编写的 OS 内核项目，支持 **RISC-V 64** 和 **LoongArch 64** 两种架构。项目采用 Rust 的 workspace 机制组织多个子 crate，构建系统基于 GNU Make 和 Cargo，目标平台为 QEMU 虚拟机。

---

### 二、顶层文件与目录结构

```
.
├── Cargo.toml          # workspace 清单，定义全部 crate 与共享依赖
├── Cargo.lock
├── Makefile            # 顶层构建入口（kernel-rv/kernel-la/disk-img/run-rv/...）
├── Makefile.sub        # 子构建入口，包含 mk/*.mk 各构建片段
├── rust-toolchain.toml # 固定工具链版本 nightly-2025-01-18
├── Dockerfile          # 容器化构建/运行环境
├── README.md
├── LICENSE             # GPLv3(?)
│
├── os/                 # 【核心 crate】内核主体
├── hal/                # 【硬件抽象层 crate】
├── user/               # 【用户态 crate】用户库与示例/测试程序
├── utils/              # 【工具 crate】
│   ├── range-map/
│   └── segment-tree/
│
├── mk/                 # Makefile 片段（config/kernel/fs/qemu/user/tests/utils）
├── scripts/            # 构建/测试/判题脚本
│   └── vendor-patches/ # 第三方测试组件补丁
├── etc/                # 用户空间配置文件（passwd, hosts, resolv.conf 等）
├── attach/             # 预编译二进制（git, libpcre2-8, libz）供用户态使用
├── cargo/              # Cargo 配置覆盖
├── .vscode/            # 编辑器配置
├── qemu-riscv64.dts    # RISC-V QEMU 设备树源文件
├── qemu-loongarch64.dts# LoongArch QEMU 设备树源文件
├── vf2.dts             # VF2 开发板设备树
├── vendor.tar.xz       # 第三方测试套件压缩包
└── testcase.tar.xz     # 测试用例压缩包
```

---

### 三、子系统划分

#### 3.1 核心内核 `os/src/`

| 目录/文件 | 子系统 | 功能描述 |
|---|---|---|
| `main.rs` | 内核入口 | 多核启动、初始化序列（pre_main → main） |
| `mm/` | 内存管理 | 页表(`page_table.rs`)、用户内存管理(`user.rs`)、帧分配器(`frame_allocator.rs`)、堆分配器(`heap_allocator.rs`)、Slab分配器(`slab_allocator.rs`)、内核/用户虚拟内存空间(`vm/kvm/`、`uvm.rs`) |
| `fs/` | 文件系统 | VFS 抽象层(`vfs/`)、FAT32(`fat32/`)、EXT4(`ext4/`)、devfs(`devfs/`)、procfs(`procfs/`)、tmpfs(`tmpfs/`)、pipe(`pipe.rs`, `pipefs.rs`)、页缓存(`page/`)、stdio |
| `task/` | 任务管理 | 进程/线程结构(`task.rs`)、调度(`schedule.rs`)、TID分配(`tid.rs`)、Capability(`cap.rs`)、信号处理(`signal.rs`)、任务管理器(`manager.rs`) |
| `syscall/` | 系统调用 | 按功能分为: `fs.rs`, `io.rs`, `mm.rs`, `process.rs`, `signal.rs`, `net.rs`, `time.rs`, `futex.rs`, `sche.rs`, `fd.rs`, `misc.rs`, `reboot.rs`, `sys_error.rs`，以及 SysV IPC(`ipc/sysv.rs`) |
| `net/` | 网络栈 | TCP(`tcp.rs`)、UDP(`udp.rs`)、raw socket(`raw.rs`)、socketpair(`socketpair.rs`)、地址管理(`addr.rs`)、监听表(`listen_table.rs`)、加密(`crypto.rs`) |
| `trap/` | 异常/中断 | 陷阱处理(`mod.rs`) |
| `timer/` | 定时器 | 时钟(`clock.rs`)、定时任务(`timed_task.rs`)、记录器(`recoder.rs`)、FFI(`ffi.rs`) |
| `signal/` | 信号 | 信号管理(`manager.rs`)、处理器(`handler.rs`)、信号动作(`action.rs`)、消息队列(`msg_queue.rs`) |
| `ipc/` | 进程间通信 | SysV 消息队列(`sysv/msg.rs`)、共享内存(`sysv/shm.rs`) |
| `sync/` | 同步原语 | 自旋互斥锁(`mutex/spin_mutex.rs`)、自旋读写锁(`mutex/spin_rw_mutex.rs`)、up/down信号量(`up.rs`)、惰性初始化(`lazy.rs`) |
| `processor/` | CPU管理 | 处理器上下文(`context.rs`)、处理器管理(`processor.rs`)、调度(`schedule.rs`) |
| `executor/` | 异步执行器 | 异步任务调度(`mod.rs`) |
| `drivers/` | 设备驱动 | 块设备：virtio-blk, PCI blk, MMIO blk, MMC/SDIO；网络：virtio-net, loopback；串口：UART；DMA |
| `devices/` | 设备管理层 | 缓冲缓存(`buffer_cache.rs`)、设备管理器(`manager.rs`)、MMIO、PCI、PLIC、SDIO |
| `config.rs` | 内核配置 | 编译期配置常量 |
| `banner.rs` | 启动横幅 | 内核启动信息打印 |
| `utils/` | 内核工具 | 内核内部工具函数 |

#### 3.2 硬件抽象层 `hal/src/`

| 目录 | 功能描述 |
|---|---|
| `board/` | 板级定义：QEMU RISC-V (`riscv64.rs`)、QEMU LoongArch (`loongarch64.rs`)；内嵌编译好的 DTB |
| `component/` | 架构相关组件：地址空间(`addr/`)、控制台(`console/`)、常量(`constant/`)、入口点(`entry/`)、指令封装(`instruction/`)、中断控制器(`irq/`)、页表操作(`pagetable/`)、信号(`signal/`)、定时器(`timer/`)、陷阱(`trap/`) |
| `interface/` | 抽象接口：分配器接口(`allocator.rs`)、映射器接口(`mapper.rs`) |
| `util/` | HAL 工具函数 |
| `hal-marco/` | 过程宏 crate（辅助 HAL 实现） |

#### 3.3 用户态 `user/`

| 文件 | 功能 |
|---|---|
| `src/lib.rs` | 用户库（系统调用封装、标准库替代） |
| `src/syscall.rs` | 用户态系统调用接口 |
| `src/lang_items.rs` | Rust 语言项（如 panic handler） |
| `src/console.rs` | 控制台 I/O |
| `src/linker.ld` | 用户程序链接脚本 |
| `src/bin/` | 用户程序：`initproc.rs`(初始进程)、`user_shell.rs`(Shell)、`autotest.rs`(自动化测试入口)、以及 echo/hello_world/tcp/udp/test_epoll/test_shm 等测试程序 |

#### 3.4 工具库 `utils/`

| crate | 功能 |
|---|---|
| `range-map` | 区间映射数据结构 |
| `segment-tree` | 线段树数据结构 |

---

### 四、构建工具

构建该项目需要的工具链如下：

| 类别 | 工具 | 用途 |
|---|---|---|
| **Rust 工具链** | `rustc/cargo` (nightly-2025-01-18) | 编译内核与用户程序 |
| | `rust-src` | 标准库源码（`#![no_std]` 编译需要） |
| | `llvm-tools`, `cargo-binutils` | objcopy、objdump (rust-objcopy/rust-objdump) |
| **RISC-V 目标** | `riscv64gc-unknown-none-elf` target | RISC-V 裸机编译 |
| **LoongArch 目标** | `loongarch64-unknown-none` target | LoongArch 裸机编译 |
| **交叉编译工具链** | `riscv64-linux-musl-gcc` / `riscv64-linux-gnu-gcc` | 编译 RISC-V 测试用例（busybox, lua, libc-test 等） |
| | `loongarch64-linux-musl-gcc` / `loongarch64-linux-gnu-gcc` | 编译 LoongArch 测试用例 |
| **QEMU** | `qemu-system-riscv64` / `qemu-system-loongarch64` | 模拟运行 |
| **文件系统工具** | `mkfs.ext4`, `dd` | 制作 EXT4 磁盘镜像 |
| **U-Boot 工具** | `mkimage` | 制作 zImage（可选） |
| **调试** | `gdb-multiarch` / `riscv64-unknown-elf-gdb` / `loongarch64-linux-gnu-gdb` | 内核调试 |
| **脚本工具** | Python 3, bash, `tar`, `xz`, `chmod` 等 | 测试与构建脚本 |

---

### 五、初步调查总结

1. **代码规模**：`.rs` 文件总计约 56,744 行（不含外部测试套件和 vendor），其中内核代码（`os/src/`）约 28,727 行，构成项目主体。

2. **架构设计**：采用经典的分层架构——HAL 层隔离硬件差异，内核层实现通用 OS 逻辑，用户库封装系统调用。HAL 通过 trait 接口定义抽象，针对 RISC-V 和 LoongArch 分别在 `component/` 下提供具体实现。

3. **子系统完备度**：覆盖了现代 OS 的主要子系统——内存管理（页表+多种分配器）、VFS 多层文件系统（FAT32/EXT4/devfs/procfs/tmpfs+页缓存）、完整的进程/线程管理、丰富的系统调用（涵盖 fs/io/mm/net/ipc/signal/time/futex 等多个类别）、完整的 TCP/UDP 网络栈（基于 smoltcp）、信号机制、SysV IPC、异步执行器和同步原语。

4. **测试与基准**：项目集成了大量外部测试套件——busybox、lua、libc-test、iozone、UnixBench、iperf、netperf 等，表明该项目面向较为完整的 Linux 兼容性。