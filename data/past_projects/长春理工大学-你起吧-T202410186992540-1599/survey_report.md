## 项目概览

**项目名称**: SystemNQB

**目标架构**: RISC-V 64位 (riscv64gc)

**项目来源**: 基于 xv6-riscv 进行二次开发，参加 OS 内核比赛项目。

**语言构成**: C 语言为主体（内核核心逻辑），Rust 语言为辅（文件系统 ext4 实现、部分基础设施），汇编（启动、上下文切换、trampoline）。

---

## 仓库文件组织结构

```
.
├── kernel/           # 内核 C 源码（主体）
│   ├── *.c           # C 源文件（约 25 个）
│   ├── *.h           # 头文件（约 20 个）
│   ├── *.S           # 汇编文件（entry, trampoline, swtch, kernelvec, kinitcode）
│   └── kernel.ld     # 链接脚本
├── src/              # Rust 源码（静态库）
│   ├── lib.rs        # Rust crate 入口
│   ├── fs.rs         # ext4 文件系统 Rust 实现（通过 ext4_rs 库）
│   ├── mm.rs         # 内存管理相关
│   ├── pagetable.rs  # 页表相关
│   ├── task.rs       # 任务/进程相关
│   ├── trapframe.rs  # 陷阱帧相关
│   ├── pool.rs       # 对象池
│   ├── console.rs    # 控制台
│   ├── logging.rs    # 日志
│   ├── bindings.rs   # bindgen 自动生成的 C FFI 绑定
│   ├── ffi_export.rs # Rust 导出给 C 的函数
│   ├── ffi_import.rs # Rust 导入 C 的函数
│   ├── infra.rs      # 基础设施
│   └── lang.rs       # Rust 语言特性支持
├── user/             # 用户态程序
│   ├── initcode.S    # 初始用户进程（嵌入内核）
│   ├── init.c        # init 进程
│   ├── ulib.c        # 用户态库
│   ├── printf.c      # 用户态 printf
│   ├── umalloc.c     # 用户态 malloc
│   ├── user.h        # 用户态头文件
│   └── user.ld       # 用户态链接脚本
├── third/            # 第三方依赖
│   ├── buddy_system_allocator/  # 伙伴系统内存分配器（Rust crate）
│   └── ext4_rs/                 # ext4 文件系统实现（Rust crate）
├── mkfs/             # 文件系统镜像制作工具
│   └── mkfs.c        # mkfs 工具源码
├── Makefile          # 构建系统
├── Cargo.toml        # Rust crate 配置
├── Cargo.lock        # Rust 依赖锁定
├── gen_syscall_*.sed # 系统调用表/函数自动生成脚本
└── gen_usys.sed      # 用户态系统调用桩生成脚本
```

---

## 子系统分析

### 1. 进程管理子系统
- **核心文件**: `kernel/proc.c` (900行), `kernel/swtch.S`, `kernel/sched.h`, `kernel/proc.h`
- **Rust 辅助**: `src/task.rs`
- **功能**: 进程创建/销毁、上下文切换、调度器、进程状态管理、clone/fork、wait/exit
- **参数**: 最大 64 进程 (NPROC)，最大 8 CPU (NCPU)

### 2. 内存管理子系统
- **核心文件**: `kernel/vm.c` (457行), `kernel/kalloc.c`, `kernel/memlayout.h`
- **Rust 辅助**: `src/mm.rs`, `src/pagetable.rs`, `src/pool.rs`
- **第三方**: `third/buddy_system_allocator`（Rust 侧伙伴系统分配器）
- **功能**: 物理页分配、虚拟内存管理、页表操作、mmap/munmap、用户/内核地址空间
- **物理内存上限**: 1GB (PHYSTOP = MBASE + 1GB)

### 3. 文件系统子系统
- **核心文件**: `kernel/fs.c` (513行), `kernel/fs.h`, `kernel/bio.c` (186行), `kernel/log.c`
- **Rust 实现**: `src/fs.rs` (167行) -- 通过 `ext4_rs` 库实现 ext4 文件系统
- **第三方**: `third/ext4_rs`（ext4 文件系统 Rust 实现）
- **功能**: ext4 文件系统读写、inode 管理、目录操作、块缓冲、日志
- **备注**: 初赛使用手搓 FAT32，复赛切换为 ext4（通过 ext4_rs 库）

### 4. 系统调用子系统
- **核心文件**: `kernel/syscall.c` (118行), `kernel/syscall.h`, `kernel/sysproc.c` (318行), `kernel/sysfile.c` (681行)
- **功能**: 实现了大量 Linux 兼容系统调用（编号 0-294 + 自定义 400-402, 501-504, 1030, 1062），涵盖进程、文件、内存、信号、IPC 等
- **自动生成**: 通过 sed 脚本从 `syscall.h` 自动生成系统调用分发表和用户态桩代码

### 5. 陷阱/中断处理子系统
- **核心文件**: `kernel/trap.c` (222行), `kernel/trampoline.S` (151行), `kernel/kernelvec.S`
- **Rust 辅助**: `src/trapframe.rs`
- **功能**: 用户态/内核态切换、异常处理、时钟中断、设备中断

### 6. 设备驱动子系统
- **UART**: `kernel/uart.c` (195行) -- 串口驱动
- **控制台**: `kernel/console.c` (196行) -- 控制台 I/O
- **VirtIO 磁盘**: `kernel/virtio_disk.c` (348行) -- VirtIO 块设备驱动
- **PLIC**: `kernel/plic.c` -- 中断控制器驱动
- **RAM Disk**: `kernel/ramdisk.c` -- 内存磁盘（备用）

### 7. 文件/管道子系统
- **核心文件**: `kernel/file.c` (190行), `kernel/pipe.c` (130行), `kernel/exec.c` (281行)
- **功能**: 文件描述符管理、管道、ELF 加载执行

### 8. 同步子系统
- **核心文件**: `kernel/spinlock.c`, `kernel/sleeplock.c`
- **功能**: 自旋锁、睡眠锁

### 9. 用户态
- **文件**: `user/` 目录下少量文件
- **功能**: 最小化的 init 进程、用户态库函数（printf, malloc, 系统调用封装）
- **测试**: 依赖外部测试套件 `testsuits-for-oskernel`

---

## 构建工具链需求

| 工具 | 用途 | 状态 |
|------|------|------|
| `riscv64-linux-gnu-gcc` | C 交叉编译 | 可用 |
| `riscv64-linux-gnu-ld` | 链接 | 可用 |
| `riscv64-linux-gnu-objcopy` | 二进制转换 | 可用 |
| `riscv64-linux-gnu-objdump` | 反汇编 | 可用 |
| `cargo` / `rustc` | Rust 编译（target: riscv64gc-unknown-none-elf） | 可用 |
| `bindgen` | C-to-Rust FFI 绑定生成 | 可用 |
| `qemu-system-riscv64` | 模拟器运行 | 可用 |
| `gcc` (host) | 编译 mkfs 工具 | 可用 |
| `sed` | 系统调用表自动生成 | 可用 |
| `make` | 构建编排 | 可用 |
| `OpenSBI` (bios default) | SBI 固件 | 可用 |

---

## 代码规模统计

- **C 源码 + 汇编 + Rust 源码**: 约 7,648 行（不含头文件和用户态）
- **最大文件**: `src/bindings.rs` (1,203行，自动生成), `kernel/proc.c` (900行), `kernel/sysfile.c` (681行)
- **总体规模**: 约 10,370 行（含头文件和用户态）

---

## 初步判断

1. 该项目是一个 **C + Rust 混合编写** 的 RISC-V 操作系统内核，从 xv6-riscv 演化而来。
2. 内核主体逻辑仍为 C 语言，Rust 主要用于 ext4 文件系统实现和部分基础设施（内存分配、对象池等），通过 FFI 双向调用。
3. 系统调用接口采用 **Linux RISC-V 兼容** 编号方案，覆盖面广但实现完整度需进一步验证。
4. 项目 README 自述 ext4 集成存在问题（exec/busybox 无法正常工作），且开发时间不足。
5. 构建流程清晰，所有所需工具在当前环境中均可用。