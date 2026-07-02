## 项目初步调查结果

### 一、项目概览

**OSKernel** 是一个使用 Rust 语言编写的面向 RISC-V 64 的 UNIX-like 微内核操作系统，遵循 POSIX 标准。项目同时预留了 amd64 和 LoongArch64 架构支持（后两者当前仅为占位）。

- **内核代码量**: 约 25,280 行 Rust + 349 行汇编（RISC-V 入口/上下文切换/trap）
- **版本**: v0.1.0，处于活跃开发阶段，最新提交为 HAL 抽象层重构

---

### 二、顶层文件结构

```
.
├── Makefile            — 构建入口，封装 cargo build + QEMU 启动
├── README.md           — 项目说明与进度总览
├── build/              — 构建产物输出目录（riscv64/amd64/loongarch64/tmp）
├── docs/               — 设计文档（26 篇系列文档）+ RISC-V 参考资料
├── kernel/             — 内核源码（Rust cargo 项目）
│   ├── Cargo.toml
│   ├── build.rs        — 构建脚本，设置链接脚本路径
│   ├── cargo-config/   — cargo 配置备份（因评测系统过滤隐藏目录）
│   └── src/            — 内核 Rust 源码
├── tools/              — 辅助工具脚本 + RustSBI 固件
│   ├── firmware/       — rustsbi-qemu.bin
│   ├── run-qemu.sh     — QEMU 启动脚本
│   ├── gdb-connect.sh  — GDB 连接脚本
│   └── analyze.sh      — 内核分析脚本
└── user/               — 用户程序（裸机 ELF，内嵌进内核）
    ├── init/           — PID 1 初始化进程
    ├── hello/          — Hello World 测试程序
    ├── tls_test/       — TLS 线程局部存储测试
    └── tls_test_c/     — C 语言 TLS 测试（仅有目录）
```

---

### 三、子系统划分

内核源码按功能模块组织在 `kernel/src/` 下，各子系统及代码量如下：

| 子系统 | 路径 | 代码量 | 职责 |
|--------|------|--------|------|
| **arch** | `arch/riscv64/` | ~1,600 行 | RISC-V 架构相关：启动汇编、链接脚本、CPU 屏障、PLIC 中断控制器、UART 驱动、SBI 封装、Sv39 MMU、trap 框架、任务上下文切换 |
| **hal** | `hal/` | ~950 行 | 硬件抽象层：对 arch 层的薄包装，提供 CPU/MMU/定时器/固件/IRQ/上下文/trap 的架构无关接口 |
| **mm** | `mm/` | ~2,370 行 | 内存管理：物理页帧分配器、Sv39 页表、地址空间 (AddressSpace)、虚拟内存区域 (VmArea)、缺页异常处理 |
| **sched** | `sched/` | ~3,740 行 | 进程调度：PID 位图分配器、TCB、时间片轮转调度器、exec、fd 管理、信号机制 (sigaction/sigprocmask/sigreturn)、waitpid/exit 进程回收 |
| **syscall** | `syscall/` | ~4,290 行 | 系统调用框架：遵循 Linux RISC-V ABI 编号，分发到 I/O 类 (read/write/close/pipe/dup)、进程类 (exit/fork/exec/waitpid)、信号类、内存类 (brk/mmap/munmap)、文件类 (openat/getdents64)、时间类 |
| **fs** | `fs/` | ~4,760 行 | 虚拟文件系统：VFS 层 + RamFs (内存文件系统) + DevFs (设备文件) + ProcFs (进程信息) + EXT4 只读驱动 (超级块/BGDT/inode/extent 树/目录) |
| **loader** | `loader/` | ~1,300 行 | ELF64 加载器：PT_LOAD 段映射、BSS 清零、PT_INTERP 动态链接器支持、用户栈分配、TLS 线程局部存储 |
| **ipc** | `ipc/pipe/` | ~490 行 | 进程间通信：POSIX 管道（4KB 环形缓冲区、阻塞/唤醒/EOF、引用计数） |
| **drivers** | `drivers/virtio_blk/` | ~400 行 | 设备驱动：Virtio MMIO v1 (legacy) 块设备驱动 |
| **tty** | `tty/` | ~240 行 | 终端服务层：后端注册 (UART)、行规程框架、POSIX termios 常量、print!/println! 宏 |
| **klog** | `klog.rs` | ~140 行 | 内核日志系统：结构化日志宏 (kinfo!/kwarn!/kdebug!)，带级别过滤 |
| **errno** | `errno.rs` | ~80 行 | Linux 兼容错误码常量 |
| **test** | `test/` | ~4,710 行 | 内核健全性测试：覆盖帧分配/页表/多任务/U-mode syscall/Virtio/管道/ELF加载/信号/waitpid/EXT4/TTY/TLS 共 49 项 |
| **main** | `main.rs` | ~200 行 | 内核入口 `kernel_main`：初始化序列 + `boot_init` (嵌入 init ELF) + idle 循环 |

**架构层次关系**（从上到下）：

```
syscall / fs / ipc / loader   ← 上层服务
        sched                 ← 进程调度
        mm                    ← 内存管理
        hal                   ← 硬件抽象层（薄门面）
        arch/riscv64          ← 架构具体实现
```

关键设计模式：**回调注入解耦**。`arch::trap::handler` 通过注册函数指针（syscall 分发、信号投递、用户态缺页）避免 arch 层反向依赖 sched/syscall；`sched::fd` 通过 `FdCallbacks` 解耦对 ipc/fs 的引用计数依赖。

---

### 四、构建工具需求

根据 Makefile 和项目配置分析，构建该项目的工具链需求如下：

| 工具 | 用途 | 当前环境状态 |
|------|------|-------------|
| **Rust 工具链** (rustc, cargo) | 编译内核及用户程序 | Rust_toolchain 可用（但缺 cargo-binutils） |
| **RISC-V 裸机目标** `riscv64gc-unknown-none-elf` | 内核与用户程序交叉编译目标 | 需 `rustup target add` |
| **GNU Make** | 顶层构建编排 | 可用 |
| **QEMU** (`qemu-system-riscv64`) | 模拟运行 | 可用 |
| **RustSBI 固件** (`rustsbi-qemu.bin`) | RISC-V SBI 实现 | 项目内置 (`tools/firmware/`) |
| **用户程序编译** (cargo build --release) | 编译 init/hello/tls_test | 同 Rust 工具链 |
| **链接脚本** (`kernel/src/arch/riscv64/boot/linker.ld`) | 内核链接 | 已提供 |

用户程序 init 通过 `include_bytes!` 宏在编译时嵌入内核镜像，因此构建流程为：**先编译用户程序 → 再编译内核**。

当前仓库中存在预编译的用户程序产物 (`user/build/init`)，也保留了完整的 user 源码和 target 目录。