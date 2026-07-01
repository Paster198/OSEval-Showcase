# Chronix 内核项目初步调查报告

## 项目概述

Chronix 是一个使用 Rust 实现的多核宏内核操作系统，支持 RISC-V 64 和 LoongArch 64 两个硬件平台。项目来自哈尔滨工业大学（深圳），参加 OS 内核比赛，已满分通过决赛线上测例。

## 仓库文件组织结构

```
.
├── Cargo.toml / Cargo.lock / rust-toolchain.toml   # Rust workspace 配置
├── Makefile / Makefile.sub                         # 顶层构建入口
├── mk/                                             # 构建脚本片段（config/kernel/fs/qemu/user/tests/utils）
├── os/                                             # 内核主体（Rust crate）
├── hal/                                            # 硬件抽象层（Rust crate）
├── user/                                           # 用户态程序（Rust crate）
├── utils/                                          # 工具 crates（range-map, segment-tree）
├── cargo/                                          # .cargo 配置（setup 时复制到 .cargo）
├── scripts/                                        # 辅助脚本
├── docs/                                           # 文档资源
├── attach/ / etc/                                  # 附加文件
├── *.dts                                           # 设备树源文件（qemu-riscv64/qemu-loongarch64/vf2）
├── testcase.tar.xz / vendor.tar.xz                 # 测试用例与 vendor 依赖归档
├── Dockerfile                                      # 容器构建
└── Chronix-*.pdf                                   # 比赛文档与 PPT
```

## 子系统划分

基于 `os/src` 目录结构，内核实现以下子系统：

| 子系统 | 目录 | 说明 |
|---|---|---|
| 进程/任务管理 | `os/src/task/`, `os/src/processor/`, `os/src/executor/` | 统一进程/线程模型、多核调度、负载均衡、异步协程执行器 |
| 内存管理 | `os/src/mm/` (allocator, page_table, vm, user) | SLAB 分配器、页表、用户空间映射、COW、懒分配 |
| 文件系统 | `os/src/fs/` (vfs, ext4, fat32, tmpfs, procfs, devfs, pipefs, page) | VFS 架构、Dentry 缓存、页缓存、多文件系统支持 |
| 设备与驱动 | `os/src/devices/`, `os/src/drivers/` (block, net, serial, dma) | MMIO、PCI、串口、PLIC、SDIO、块设备/网络设备驱动 |
| 网络 | `os/src/net/` (tcp, udp, raw, socket, socketpair, crypto, listen_table) | TCP/UDP 套接字、IPv4/IPv6、回环设备、加密 |
| 系统调用 | `os/src/syscall/` (fs, mm, process, net, signal, ipc, futex, time 等) | Linux 兼容系统调用接口 |
| 信号机制 | `os/src/signal/` (action, handler, manager, msg_queue) | 标准/实时信号、排队机制 |
| IPC | `os/src/ipc/` (sysv) | System V 进程间通信 |
| 同步原语 | `os/src/sync/` (mutex, up/semaphore, lazy) | 互斥锁、信号量 |
| 定时器 | `os/src/timer/` (clock, timer, timed_task, recoder) | 时钟、定时任务 |
| 陷阱处理 | `os/src/trap/` | 异常与中断入口 |
| 硬件抽象层 | `hal/src/` (board, component, interface, util) | 多架构适配（riscv64/loongarch64），含地址、页表、中断、信号、定时器、陷阱等抽象 |

## 构建工具需求

- **Rust 工具链**：nightly-2025-01-18，需 `rust-src`、`llvm-tools`、`cargo-binutils`
- **目标架构**：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none`
- **QEMU**：用于运行和测试（riscv64/loongarch64）
- **mkfs.ext4 / mkfs.vfat / mcopy / dd**：制作磁盘镜像（`mk/fs.mk`）
- **mkimage (U-Boot)**：生成 zImage
- **dtc**：设备树编译（仓库含 .dts 和预编译 .dtb）
- **GNU Make**：构建编排
- **GDB (multiarch / loongarch64)**：调试
- **vendor.tar.xz**：离线依赖（用于无网络构建）