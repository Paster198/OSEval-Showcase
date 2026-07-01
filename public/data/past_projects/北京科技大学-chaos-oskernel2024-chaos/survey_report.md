# ChaOS 内核项目初步调查报告

## 项目基本信息

- **项目名称：** ChaOS
- **参赛队伍：** chaos（北京科技大学）
- **竞赛：** OSKernel 2024
- **开发语言：** Rust（辅以少量 RISC-V 汇编）
- **目标架构：** RISC-V 64 位（riscv64gc）
- **目标平台：** QEMU virt 虚拟机、StarFive VisionFive2（JH7110）开发板
- **Rust 工具链：** nightly-2024-02-03

---

## 仓库文件组织结构

```
.
├── Makefile                    # 顶层构建编排
├── rust-toolchain.toml         # Rust 工具链版本锁定
├── Dockerfile                  # Docker 构建环境
├── jh7110-visionfive2_dtb.dtb # VisionFive2 设备树二进制
├── README.md                   # 项目说明与使用指南
├── LICENSE                     # 许可证
│
├── os/                         # 内核主体
│   ├── Cargo.toml              # 内核 Rust 包定义
│   ├── Makefile                # 内核构建脚本
│   ├── build.rs                # Cargo 构建脚本
│   ├── vendor/                 # 离线依赖包（vendored）
│   ├── libs/                   # 本地子库
│   │   ├── ext4_rs/            #   ext4 文件系统实现
│   │   └── visionfive2-sd/     #   VisionFive2 SD 卡驱动
│   └── src/                    # 内核源码
│       ├── main.rs             #   内核入口
│       ├── entry.S             #   QEMU 启动汇编
│       ├── entry_visionfive2.S #   VF2 启动汇编
│       ├── linker-qemu.ld      #   QEMU 链接脚本
│       ├── linker-vf2.ld       #   VF2 链接脚本
│       ├── link_initproc.S     #   初始进程 ELF 嵌入
│       ├── mm/                 #   内存管理子系统
│       ├── task/               #   任务/进程/线程管理子系统
│       ├── syscall/            #   系统调用子系统
│       ├── fs/                 #   文件系统子系统
│       ├── block/              #   块设备抽象
│       ├── drivers/            #   设备驱动
│       ├── trap/               #   陷阱/异常处理
│       ├── sync/               #   同步原语
│       ├── boards/             #   板级支持
│       ├── timer.rs            #   定时器
│       ├── sbi.rs              #   SBI 接口
│       ├── console.rs          #   控制台输出
│       ├── logging.rs          #   日志系统
│       ├── config.rs           #   内核配置常量
│       └── utils/              #   工具模块
│
├── user/                       # 用户态程序
│   ├── Cargo.toml              # 用户库 Rust 包定义
│   ├── Makefile                # 用户态构建脚本
│   └── src/
│       ├── lib.rs              #   用户库（syscall 封装）
│       ├── syscall.rs          #   系统调用号定义
│       └── bin/                #   用户程序
│           ├── initproc.rs     #     初始进程
│           ├── user_shell.rs   #     用户 shell
│           └── usertests_simple.rs # 简单测试
│
├── bootloader/                 # SBI 固件
│   └── rustsbi-qemu.bin        #   预编译的 RustSBI（QEMU 用）
│
├── testcase_sourcecode/        # 测试用例
│   ├── *.c                     #   C 语言测试源码（约 30+ 个）
│   ├── *_test.py               #   Python 测试脚本
│   └── test_runner.py          #   测试运行器
│
└── docs/                       # 项目文档
    ├── 初赛文档.md
    ├── 决赛第一阶段文档.md
    ├── 内存管理.md
    ├── 文件系统.md
    ├── 开发日志与bug记录.md
    └── ...
```

---

## 子系统分析

基于源码目录结构和模块声明，该项目实现了以下子系统：

### 1. 内存管理（`os/src/mm/`）
- **文件：** `address.rs`, `config.rs`, `frame_allocator.rs`, `heap_allocator.rs`, `memory_set.rs`, `page_table.rs`
- **功能：** SV39 分页虚拟内存架构、物理页帧分配器、内核堆分配器、页表管理、地址空间映射（MemorySet）
- **依赖：** `buddy_system_allocator`

### 2. 任务/进程/线程管理（`os/src/task/`）
- **文件：** `process.rs`, `task.rs`, `manager.rs`, `processor.rs`, `context.rs`, `switch.rs`, `res.rs`, `resource.rs`, `signal.rs`, `sigaction.rs`
- **功能：** 进程控制块（PCB）、线程控制块（TCB）、调度器、上下文切换、信号机制、进程创建（clone/fork）、资源管理
- **特性：** 支持多线程（threads Vec 管理）、信号处理、僵尸进程回收

### 3. 系统调用（`os/src/syscall/`）
- **文件：** `fs.rs`, `process.rs`, `signal.rs`, `sync.rs`, `thread.rs`, `time.rs`, `ppoll.rs`, `errno.rs`
- **已实现的系统调用（约 50+ 个）：** 涵盖文件操作（openat, read, write, close, dup, getdents64, fstat, chdir, mkdirat, unlinkat, linkat, mount, umount）、进程管理（clone, execve, wait4, exit, exit_group）、内存管理（mmap, munmap, brk）、信号（sigaction, sigprocmask, sigtimedwait, kill, sigreturn）、时间（clock_gettime, gettimeofday, times）、同步（mutex, semaphore, condvar -- 部分已注释）、线程（thread_create, waittid）、信息获取（getpid, getppid, gettid, getuid, getgid, uname）等

### 4. 文件系统（`os/src/fs/`）
- **文件：** `defs.rs`, `dentry.rs`, `file.rs`, `fs.rs`, `inode.rs`, `path.rs`, `pipe.rs`, `stdio.rs`
- **功能：** VFS 抽象层（Inode/Dentry 模型）、ext4 文件系统支持（通过 `ext4_rs` 本地库）、管道（pipe）、标准 I/O、路径解析、文件系统挂载管理
- **依赖：** 本地 `libs/ext4_rs` 库

### 5. 块设备（`os/src/block/`）
- **文件：** `block_cache.rs`, `block_dev.rs`
- **功能：** 块设备抽象接口、块缓存机制

### 6. 设备驱动（`os/src/drivers/`）
- **文件：** `mod.rs`（内含 block 子模块）
- **功能：** VirtIO 块设备驱动
- **依赖：** `virtio-drivers` crate

### 7. 陷阱/异常处理（`os/src/trap/`）
- **文件：** `mod.rs`, `context.rs`（以及汇编文件 `trap.S`, `init_entry.S`）
- **功能：** 用户态/内核态陷阱入口、异常分发（系统调用、页错误、非法指令、定时器中断）、信号检查

### 8. 同步原语（`os/src/sync/`）
- **文件：** `condvar.rs`, `semaphore.rs`, `up.rs`
- **功能：** 条件变量、信号量、UP（单处理器）锁封装
- **注意：** 部分同步相关系统调用在 `syscall/mod.rs` 中已被注释掉

### 9. 定时器（`os/src/timer.rs`）
- **功能：** 定时器中断管理、时间获取、睡眠、定时器事件检查

### 10. 板级支持（`os/src/boards/`）
- **文件：** `qemu.rs`, `visionfive2.rs`
- **功能：** 针对不同硬件平台的配置（时钟频率、内存布局、关机方式）
- **通过 Cargo features 切换：** `qemu`（默认）和 `visionfive2`

---

## 构建工具需求

| 工具 | 用途 | 状态 |
|------|------|------|
| Rust nightly-2024-02-03 | 内核与用户态编译 | 可用（rustup） |
| riscv64gc-unknown-none-elf target | 裸机 RISC-V 目标 | 可用（rustup target） |
| rust-src | 标准库源码（no_std 构建需要） | 可用 |
| llvm-tools-preview | LLVM 工具（objcopy 等） | 可用 |
| cargo / cargo-binutils | Rust 包管理与二进制工具 | 可用 |
| QEMU 7.0.0 (riscv64-softmmu) | 系统模拟运行 | 可用 |
| RISC-V GCC 交叉编译器 | 用户态 C 测试用例编译 | 可用 |
| GNU Make | 构建编排 | 可用 |
| dtc | 设备树编译（VF2 平台） | 可用 |
| wget / gzip | 下载和解压 sdcard 镜像 | 可用 |
| RustSBI (预编译) | SBI 固件（已包含在 bootloader/ 中） | 可用 |

构建流程概要：`make all` 依次执行 `cargo fmt` -> 编译用户态程序 -> 编译内核 -> 复制 SBI 和内核二进制文件。`make run` 在此基础上下载 sdcard 镜像并启动 QEMU。