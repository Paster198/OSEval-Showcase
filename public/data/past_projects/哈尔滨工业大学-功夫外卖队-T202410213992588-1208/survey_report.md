# OS内核项目初步分析报告

## 项目结构

```
.
├── bootloader/          # 引导加载程序
│   └── rustsbi-qemu.bin # RustSBI QEMU固件
├── os/                  # 操作系统内核
│   ├── src/
│   │   ├── boards/      # 板级配置 (qemu.rs, k210.rs)
│   │   ├── drivers/     # 设备驱动
│   │   ├── fs/          # 文件系统
│   │   ├── mm/          # 内存管理
│   │   ├── syscall/     # 系统调用
│   │   ├── task/        # 进程/任务管理
│   │   ├── trap/        # 异常/中断处理
│   │   ├── main.rs      # 内核入口
│   │   ├── sbi.rs       # SBI接口
│   │   ├── timer.rs     # 定时器
│   │   └── utsname.rs   # 系统信息
│   ├── Cargo.toml
│   └── Makefile
├── user/                # 用户态程序
│   ├── src/
│   │   ├── bin/         # 用户程序 (initproc, user_shell)
│   │   ├── lib.rs       # 用户库
│   │   └── syscall.rs   # 系统调用封装
│   ├── Cargo.toml
│   └── Makefile
├── fat32/               # FAT32文件系统实现
│   └── src/
├── fat32-fuse/          # FAT32镜像制作工具
│   ├── src/
│   └── riscv64/         # 测试文件
├── Makefile             # 顶层构建脚本
├── Dockerfile           # 构建环境配置
└── LICENSE
```

## 已实现的子系统

### 1. 内存管理子系统 (mm/)
- **物理内存管理**: frame_allocator.rs - 物理页帧分配器
- **虚拟内存管理**: memory_set.rs - 地址空间管理
- **页表管理**: page_table.rs - 页表操作
- **地址抽象**: address.rs - 物理/虚拟地址转换
- **堆分配器**: heap_allocator.rs - 内核堆内存

### 2. 进程/任务管理子系统 (task/)
- **任务控制块**: task.rs - TCB定义与管理
- **进程调度**: manager.rs, processor.rs - 调度器实现
- **上下文切换**: switch.S, switch.rs, context.rs - 任务切换
- **进程标识**: pid.rs - PID分配与管理
- **信号机制**: signal.rs, action.rs - POSIX信号支持

### 3. 文件系统子系统 (fs/)
- **FAT32实现**: 独立的fat32库，支持FAT32文件系统
- **VFS抽象**: inode.rs - 文件inode管理
- **管道**: pipe.rs - 进程间通信管道
- **标准I/O**: stdio.rs - 标准输入输出
- **文件信息**: info.rs - 文件状态信息

### 4. 系统调用子系统 (syscall/)
- **文件系统调用**: fs.rs - 文件操作相关
- **进程调用**: process.rs - 进程管理相关
- 支持约30个系统调用，包括：
  - 文件操作: open, read, write, close, dup, mkdir, unlink等
  - 进程管理: fork, exec, wait, exit, getpid等
  - 内存管理: mmap, munmap, brk
  - 信号: kill, sigaction, sigprocmask, sigreturn
  - 其他: yield, times, uname, gettimeofday等

### 5. 异常/中断处理子系统 (trap/)
- **陷入处理**: mod.rs - 异常和中断分发
- **上下文管理**: context.rs - 陷入上下文
- **汇编入口**: trap.S - 低级陷入处理

### 6. 设备驱动子系统 (drivers/)
- **块设备**: block模块 - VirtIO块设备驱动
- 支持QEMU的VirtIO设备

### 7. 定时器子系统 (timer.rs)
- 基于RISC-V定时器的时间片管理
- 支持100Hz时钟中断

### 8. SBI接口 (sbi.rs)
- 与RustSBI固件的接口
- 提供定时器、控制台、关机等基础服务

## 构建工具需求

### 必需工具
1. **Rust工具链**:
   - rustc (nightly版本)
   - cargo
   - rustup
   - rust-src组件
   - llvm-tools-preview组件
   - 目标平台: riscv64gc-unknown-none-elf

2. **QEMU模拟器**:
   - qemu-system-riscv64 (用于运行和调试)

3. **RustSBI固件**:
   - bootloader/rustsbi-qemu.bin (已提供)

4. **二进制工具**:
   - rust-objdump (反汇编)
   - rust-objcopy (格式转换)

### 可选工具
- GDB (riscv64-unknown-elf-gdb) - 用于调试
- Docker - 提供预配置构建环境
- tmux - 用于调试会话管理

### 依赖库
- spin (自旋锁)
- riscv (RISC-V寄存器访问)
- lazy_static (延迟初始化)
- buddy_system_allocator (内存分配)
- bitflags (位标志)
- xmas-elf (ELF解析)
- virtio-drivers (VirtIO驱动)
- fat32 (本地FAT32库)

## 项目特点

1. **架构**: RISC-V 64位，支持QEMU和K210开发板
2. **语言**: 纯Rust实现，no_std环境
3. **多核支持**: 支持SMP（对称多处理），默认2核
4. **文件系统**: 基于FAT32，支持基本文件操作
5. **进程模型**: 支持fork/exec/wait等Unix风格进程管理
6. **信号机制**: 实现了POSIX信号机制
7. **内存管理**: 支持虚拟内存、mmap等高级特性

该项目是一个教学性质的操作系统内核，基于清华大学的rCore-Tutorial-V3，实现了现代操作系统的核心功能。