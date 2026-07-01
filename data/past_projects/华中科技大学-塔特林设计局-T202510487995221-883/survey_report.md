# TatlinOS 内核项目初步分析报告

## 项目概述

TatlinOS 是一个基于 Rust 语言编写的操作系统内核项目，参加 OSKernel2025 比赛。该项目基于 2024 年 TrustOS 项目进行开发，支持两种目标架构：**RISC-V 64位** 和 **LoongArch 64位**。项目使用 Rust nightly-2024-02-03 工具链，采用 `no_std` 裸机开发模式。

---

## 仓库文件组织结构

```
.
├── Makefile                 # 顶层构建入口
├── rust-toolchain.toml      # Rust 工具链版本锁定 (nightly-2024-02-03)
├── README.md                # 项目说明
├── LICENSE                  # 许可证
├── .gitignore
├── .vscode/                 # VS Code 配置
├── Docs/                    # 文档目录
│   ├── TrustOsDocs/         # 继承自 TrustOS 的文档
│   ├── 初赛文档/            # 初赛阶段文档
│   ├── 决赛文档/            # 决赛阶段文档（含网络、上板等）
│   └── 使用指南.md
├── make_scripts/            # 构建脚本
│   ├── riscv64.mk           # RISC-V 64 构建配置
│   ├── loongarch64.mk       # LoongArch 64 构建配置
│   └── user.mk              # 用户态程序构建配置
├── os/                      # 内核代码（核心）
│   ├── dotcargo/            # Cargo 配置模板
│   ├── linkers/             # 链接脚本目录
│   ├── src/                 # 内核源码
│   └── vendor/              # 第三方依赖（离线 vendor）
├── user/                    # 用户态程序
│   ├── dotcargo/            # Cargo 配置模板
│   ├── src/                 # 用户态源码
│   │   ├── arch/            # 架构相关代码
│   │   └── bin/             # 用户程序（测试套件等）
│   └── vendor/              # 第三方依赖
├── cty/                     # C 类型绑定库
└── lwext4_rust/             # lwext4 文件系统的 Rust 封装
```

---

## 内核子系统分析

内核源码位于 `os/src/` 目录下，包含以下子系统：

### 1. 架构抽象层 (`arch/`)
- 支持 `riscv64` 和 `loongarch64` 两种架构
- 每种架构下包含 QEMU 平台适配代码：
  - `console.rs` — 串口控制台输出
  - `context/` — 寄存器上下文、任务上下文、陷入上下文
  - `cpu.rs` — CPU 相关操作（hart ID、关机等）
  - `memory_layout.rs` — 内存布局定义
  - `page_table.rs` — 页表操作
  - `time.rs` — 时钟频率与定时器
  - `tlb.rs` — TLB 管理
  - `trap_interface.rs` — 陷入接口（中断使能、陷入原因获取等）
  - `asms/` — 汇编代码

### 2. 内存管理 (`mm/`)
- `address.rs` — 物理/虚拟地址、页号定义
- `frame_alloc/` — 物理页帧分配器（含页缓存）
- `heap_allocator.rs` — 内核堆分配器
- `map_area.rs` — 内存映射区域
- `memory_set/` — 地址空间管理（MemorySet）
- `page_fault_handler.rs` — 缺页异常处理
- `shm.rs` — 共享内存（shmget/shmat/shmctl）
- `user_buffer.rs` — 用户缓冲区抽象
- `group.rs` — 内存分组管理
- `mmap_bad_address.rs` — 不良地址追踪

### 3. 任务/进程管理 (`task/`)
- `task/` — 任务控制块（TCB）和进程（Process）定义
- `manager.rs` — 任务管理器（调度队列）
- `processor.rs` — 处理器抽象（每核当前任务）
- `switch.rs` — 上下文切换
- `kernel_stack.rs` — 内核栈管理
- `futex.rs` — Futex 实现
- `tid.rs` — 线程 ID 分配
- `aux.rs` — 辅助向量（ELF auxiliary vector）
- `sysinfo.rs` — 系统信息

### 4. 文件系统 (`fs/`)
- `vfs.rs` — 虚拟文件系统层
- `ext4_lw/` — ext4 文件系统实现（基于 lwext4 Rust 封装）
  - `inode.rs`、`dirent.rs`、`sb.rs` — inode、目录项、超级块
- `files/` — 各类文件对象
  - `os_file.rs` — 普通文件
  - `pipe.rs` — 管道
  - `socket.rs` — 套接字
  - `devfs.rs` — 设备文件系统
  - `stdio.rs` — 标准输入/输出
  - `string_file.rs` — 字符串文件
- `mount.rs` — 挂载表管理
- `kernel_fs_ops/` — 内核文件系统操作（初始化文件、打开等）
- `stat.rs`、`fstruct.rs`、`fs_info.rs` — 文件状态与结构定义
- `socket_defs.rs` — 套接字相关定义

### 5. 系统调用 (`syscall/`)
实现了约 100+ 个 Linux 兼容系统调用，按功能分组：
- `fs.rs` — 文件操作（open、read、write、lseek、ioctl、getdents64 等）
- `memory.rs` — 内存操作（mmap、munmap、mprotect、brk、mremap 等）
- `process/` — 进程操作（clone、execve、exit、wait4、sleep 等）
- `signal.rs` — 信号操作（sigaction、sigprocmask、sigreturn 等）
- `time.rs` — 时间操作（clock_gettime、nanosleep、gettimeofday 等）
- `net.rs` — 网络操作（socket、bind、listen、accept、connect 等）
- `options.rs` — 系统调用选项与标志

### 6. 陷入/异常处理 (`trap/`)
- `mod.rs` — 陷入处理主逻辑（trap_handler）
- `trap_types.rs` — 异常与中断类型定义

### 7. 信号系统 (`signal/`)
- `sigact.rs` — 信号动作定义
- `signal.rs` — 信号发送、处理、检查

### 8. 定时器 (`timer/`)
- `mod.rs` — 定时器主逻辑
- `rtc.rs` — 实时时钟
- `timespec.rs`、`itimeval.rs`、`timedata.rs`、`tms.rs` — 时间结构体

### 9. 设备驱动 (`drivers/`)
- `virtio/` — VirtIO 块设备驱动（含 PCI 支持）
- `ramdisk/` — RAM 磁盘驱动
- `vf2/` — VisionFive2 开发板 SD 卡驱动
- `disk.rs` — 磁盘抽象
- `device.rs` — 设备抽象
- `cache.rs` — 缓存管理

### 10. 同步原语 (`sync/`)
- `up.rs` — 单处理器互斥锁封装
- `mod.rs` — 同步模块入口

### 11. 工具模块 (`utils/`)
- `error.rs` — 错误码定义
- `id_allocator.rs` — ID 分配器
- `simple_range.rs` — 简单范围结构
- `string.rs` — 字符串工具

---

## 用户态程序 (`user/`)

用户态包含多类测试程序：
- `basic/` — 基础功能测试
- `pre_tests/` — 预赛测试套件
- `final_tests/` — 决赛测试套件
- `ltp/` — Linux Test Project 测试
- `lmbench/` — 性能基准测试
- `libctest/` — C 标准库兼容性测试
- `lua/` — Lua 解释器
- `git/` — Git 相关测试
- `init_so/` — 动态链接库初始化
- `utils/` — 工具程序
- `initproc.rs` — init 进程

---

## 编译构建所需工具

| 工具 | 用途 | 状态 |
|------|------|------|
| Rust nightly-2024-02-03 | 编译器 | 可用（rustup） |
| rust-src | Rust 标准库源码（用于 no_std 编译） | 可用 |
| llvm-tools-preview | rust-objdump、rust-objcopy | 可用 |
| GNU Make | 构建编排 | 可用 |
| QEMU (riscv64) | RISC-V 64 模拟运行 | 可用 |
| QEMU (loongarch64) | LoongArch 64 模拟运行 | 可用 |
| riscv64gc-unknown-none-elf target | RISC-V 裸机编译目标 | 需通过 rustup 安装 |
| loongarch64-unknown-none target | LoongArch 裸机编译目标 | 需通过 rustup 安装 |
| GDB (riscv64/loongarch64) | 调试 | 可用 |
| dtc (Device Tree Compiler) | 设备树编译 | 可用 |
| OpenSBI/RustSBI | RISC-V SBI 固件 | 可用 |
| 磁盘镜像 (sdcard-*.img) | 测试用文件系统镜像 | 需确认是否存在 |

构建流程：通过顶层 `Makefile` 指定 `TARGET_ARCH=riscv64` 或 `TARGET_ARCH=loongarch64`，依次构建用户态程序、内核，最终生成内核二进制文件并通过 QEMU 启动。项目使用 vendor 模式（离线依赖），无需网络下载 crate。