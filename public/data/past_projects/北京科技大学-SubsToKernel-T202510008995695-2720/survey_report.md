# SubsToKernel 项目结构分析

## 项目概述

SubsToKernel 是基于 rCore-Tutorial-v3 的 ch8 分支开发的操作系统内核，由北京科技大学参赛队伍为 2025 春秋季开源操作系统训练营设计实现。项目使用 Rust 语言开发，支持 RISC-V 64 位和 LoongArch 64 位两种架构。

## 仓库结构

```
.
├── Makefile                 # 顶层构建脚本
├── README.md               # 项目说明文档
├── rust-toolchain.toml     # Rust 工具链配置 (nightly-2025-01-01)
├── os/                     # 内核实现
│   ├── src/               # Rust 源代码 (101 个 .rs 文件)
│   ├── libs/              # 外部库
│   │   ├── lwext4_rsut/   # ext4 文件系统实现 (C + Rust 绑定)
│   │   └── smoltcp/       # TCP/IP 网络协议栈
│   ├── vendor/            # 依赖库源码
│   ├── cargo/             # Cargo 配置
│   ├── build.rs           # 构建脚本 (生成链接脚本)
│   ├── linker.lds         # 链接脚本模板
│   └── Makefile           # 内核构建脚本
├── user/                   # 用户态程序
│   ├── src/
│   │   ├── bin/           # 用户程序 (initproc, user_shell, usertest 等)
│   │   ├── lib.rs         # 用户库
│   │   └── syscall.rs     # 系统调用接口
│   └── Makefile           # 用户程序构建脚本
└── docs/                   # 参赛文档
    ├── prel/              # 初赛文档
    ├── final/             # 决赛文档
    └── site/              # 现场赛文档
```

## 内核子系统

### 1. 启动与初始化 (Boot)
- **文件**: `main.rs`, `boot.rs`, `config.rs`
- **汇编**: `task/initproc_rv.S`, `task/initproc_la.S`
- **功能**: 内核入口、BSS 段清理、子系统初始化、初始进程加载

### 2. 内存管理 (Memory Management)
- **目录**: `mm/`
- **核心文件**: 
  - `address.rs` - 地址抽象
  - `frame_allocator.rs` - 物理页帧分配器
  - `heap_allocator.rs` - 堆内存分配
  - `memory_set.rs` - 地址空间管理
  - `page_table.rs` - 页表管理
  - `map_area.rs` - 内存映射区域
  - `shm.rs` - 共享内存
  - `page_fault_handler.rs` - 缺页异常处理
  - `group.rs` - 内存组管理

### 3. 进程与任务管理 (Task/Process)
- **目录**: `task/`
- **核心文件**:
  - `task.rs` - 任务控制块
  - `process.rs` - 进程管理
  - `manager.rs` - 任务管理器
  - `processor.rs` - 处理器管理
  - `context.rs` - 上下文结构
  - `switch.rs` - 上下文切换
  - `stride.rs` - Stride 调度算法
  - `futex.rs` - 快速用户态互斥锁
  - `alloc.rs` - 任务分配
  - `id.rs` - 任务 ID 管理
  - `aux.rs` - 辅助向量

### 4. 文件系统 (File System)
- **目录**: `fs/`
- **子目录**:
  - `vfs/` - 虚拟文件系统层
  - `ext4_lw/` - ext4 文件系统实现 (基于 lwext4)
- **核心文件**:
  - `devfs.rs` - 设备文件系统
  - `pipe.rs` - 管道
  - `stdio.rs` - 标准输入输出
  - `dirent.rs` - 目录项
  - `mount.rs` - 挂载管理
  - `stat.rs` - 文件状态
  - `fsidx.rs` - 文件系统索引
  - `fstruct.rs` - 文件结构

### 5. 系统调用 (System Calls)
- **目录**: `syscall/`
- **分类实现**:
  - `fs.rs` - 文件系统调用
  - `process.rs` - 进程管理调用
  - `mem.rs` - 内存管理调用
  - `net.rs` - 网络调用
  - `signal.rs` - 信号调用
  - `sync.rs` - 同步调用
  - `thread.rs` - 线程调用
  - `tid.rs` - 线程 ID 调用
  - `uname.rs` - 系统信息调用
  - `options.rs` - 选项处理
  - `sys_result.rs` - 返回值封装

### 6. 设备驱动 (Drivers)
- **目录**: `drivers/`
- **子目录**: `virtio/`
- **核心文件**:
  - `virtio/blk.rs` - VirtIO 块设备驱动
  - `virtio/net.rs` - VirtIO 网络设备驱动
  - `device.rs` - 设备抽象
  - `disk.rs` - 磁盘管理

### 7. 硬件抽象层 (HAL)
- **目录**: `hal/`
- **子目录**:
  - `arch/` - 架构相关代码 (RISC-V 和 LoongArch)
  - `trap/` - 异常和中断处理
  - `utils/` - 工具函数
- **核心文件**:
  - `arch/loongarch.rs`, `arch/uart.rs`, `arch/info.rs`
  - `trap/context.rs` - 陷阱上下文
  - `trap/trap_rv.s`, `trap/trap_la.s` - 汇编陷阱处理
  - `utils/console.rs` - 控制台输出

### 8. 网络子系统 (Networking)
- **目录**: `net/`
- **子目录**: `socket/`
- **核心文件**:
  - `socket/tcp.rs` - TCP 套接字
  - `socket/udp.rs` - UDP 套接字
  - `socket/dns.rs` - DNS 解析
  - `socket/loopback.rs` - 回环接口
  - `socket/listen_table.rs` - 监听表
  - `socket/addr.rs` - 地址管理
  - `socket_impl.rs` - 套接字实现
  - `lazy_init.rs` - 延迟初始化

### 9. 同步原语 (Synchronization)
- **目录**: `sync/`
- **核心文件**:
  - `mutex.rs` - 互斥锁
  - `semaphore.rs` - 信号量
  - `condvar.rs` - 条件变量
  - `up.rs` - UP 锁
  - `banker_algo.rs` - 银行家算法 (死锁避免)

### 10. 信号处理 (Signal)
- **目录**: `signal/`
- **核心文件**:
  - `signal.rs` - 信号机制
  - `sigact.rs` - 信号动作

### 11. 用户管理 (Users)
- **目录**: `users/`
- **核心文件**:
  - `users.rs` - 用户管理
  - `id.rs` - 用户 ID
  - `group.rs` - 用户组

### 12. 工具模块 (Utilities)
- **目录**: `utils/`
- **核心文件**:
  - `error.rs` - 错误处理
  - `hart.rs` - 硬件线程
  - `string.rs` - 字符串工具

### 13. 其他模块
- `timer.rs` - 定时器管理
- `system.rs` - 系统信息
- `logging.rs` - 日志系统
- `lang_items.rs` - Rust 语言项

## 架构支持

项目支持两种目标架构，通过条件编译实现：

1. **RISC-V 64-bit** (`riscv64gc-unknown-none-elf`)
   - 基地址: 0x80200000 (OpenSBI)
   - 汇编文件后缀: `_rv`

2. **LoongArch 64-bit** (`loongarch64-unknown-none`)
   - 基地址: 0x82000000
   - 汇编文件后缀: `_la`

## 构建工具需求

### 必需工具
- **Rust 工具链**: nightly-2025-01-01
  - rustc, cargo
  - rust-src (标准库源码)
  - llvm-tools-preview (用于 rust-objcopy)
  - cargo-binutils
- **QEMU**: 
  - qemu-system-riscv64
  - qemu-system-loongarch64
- **C 编译器**: 用于编译 lwext4 库 (通过 build.rs)

### 可选工具
- **GDB**: 调试支持
  - gdb-multiarch (RISC-V)
  - loongarch64-unknown-linux-gnu-gdb (LoongArch)
- **objdump**: 反汇编分析

### 外部依赖
- **smoltcp**: 轻量级 TCP/IP 协议栈 (本地路径依赖)
- **lwext4_rsut**: ext4 文件系统实现 (C 库 + Rust 绑定)
- **virtio-drivers**: VirtIO 设备驱动框架
- 其他 Rust crates: lazy_static, log, bitflags, xmas-elf, spin, hashbrown 等

## 用户态程序

用户态包含简单的测试程序：
- `initproc.rs` - 初始进程
- `user_shell.rs` - 用户 shell
- `usertest.rs` - 测试程序
- `test_waitpid.rs` - waitpid 测试

## 项目特点

1. **教学导向**: 基于 rCore-Tutorial，结构清晰，模块化良好
2. **双架构支持**: 同时支持 RISC-V 和 LoongArch
3. **功能完整**: 实现了进程管理、内存管理、文件系统、网络、同步等核心子系统
4. **现代技术栈**: 使用 Rust 语言，集成现代网络协议栈和文件系统
5. **竞赛项目**: 针对操作系统设计竞赛优化，包含完整的文档和测试用例