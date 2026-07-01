# BITOS 项目初步调查报告

## 一、项目概述

BITOS 是一个基于 Rust 语言编写的 RISC-V 64 位操作系统内核项目，目标平台为 QEMU virt 机器（riscv64gc-unknown-none-elf）。项目使用 RustSBI 作为引导固件，采用 Cargo workspace 管理多 crate，并通过 Makefile 封装构建与运行流程。

## 二、仓库文件组织结构

```
.
├── Cargo.toml              # Workspace 根配置，包含 5 个成员 crate
├── Cargo.lock
├── Makefile                # 构建/运行/调试入口
├── README.md
├── todo.md                 # 开发待办事项
├── oscomp_syscalls.md      # 操作系统竞赛系统调用参考文档
├── asm.txt                 # 反汇编输出（约 3MB）
├── .cargo/                 # Cargo 配置
├── bootloader/             # RustSBI QEMU 固件二进制 (rustsbi-qemu.bin)
├── docs/                   # 项目文档（环境搭建、用户态程序、内存管理、进程管理等）
├── dependencies/           # 本地 vendored 依赖库（16 个）
├── kernel/                 # 内核主 crate
├── init/                   # init 进程 crate（第一个用户态进程）
├── user/                   # 用户态应用程序 crate
├── bitos_lib/              # 用户态库（系统调用封装）
└── fat32-fs/               # FAT32 文件系统实现 crate
```

## 三、Workspace 成员 Crate

| Crate | 用途 |
|-------|------|
| `kernel` | 操作系统内核主体 |
| `init` | init 进程，内核启动后加载的第一个用户态进程 |
| `user` | 用户态应用程序（含 app1、app2 两个二进制） |
| `bitos_lib` | 用户态共享库，封装系统调用接口（syscall/fs、mm、process、time）及简易 I/O |
| `fat32-fs` | 独立的 FAT32 文件系统实现（含 block_cache、dentry、FAT 表、VFS 层等） |

## 四、内核子系统分析

### 4.1 内存管理（`kernel/src/mm/`）

| 文件 | 功能 |
|------|------|
| `buddy.rs` | 伙伴系统物理内存分配器 |
| `slub.rs` | SLUB 风格内核堆分配器 |
| `address.rs` | 物理地址/虚拟地址抽象 |
| `phys_mem_region.rs` | 物理内存区域描述 |
| `virt_mem/page_table.rs` | 页表操作 |
| `virt_mem/virt_mem_space.rs` | 通用虚拟地址空间管理 |
| `virt_mem/kernel_virt_mem_space.rs` | 内核虚拟地址空间 |
| `virt_mem/app_virt_mem_space.rs` | 用户态应用虚拟地址空间 |
| `virt_mem/virt_mem_region.rs` | 虚拟内存区域（VMR）及权限 |

关键参数：内存起始 0x8000_0000，大小 128MB，页大小 4KB，伙伴系统最大阶 11（最大连续块 4MB），内核堆 16MB。支持 ASID。

### 4.2 进程管理（`kernel/src/process/`）

| 文件 | 功能 |
|------|------|
| `process.rs` | 进程控制块（PCB）定义，含 pid、状态、内核上下文、虚拟地址空间、父子关系、fd 表、cwd |
| `process_manager.rs` | 进程管理器，基于 BTreeMap 管理所有 PCB，含调度、上下文切换 |
| `context.rs` | 用户态/内核态上下文定义 |
| `switch.asm` | 上下文切换汇编实现 |
| `user_app_loader.rs` | 用户态 ELF 程序加载器 |

进程状态：New -> Ready -> Running -> Waiting/Zombie -> Terminated。

### 4.3 文件系统（`kernel/src/fs/`）

| 文件/目录 | 功能 |
|-----------|------|
| `inode.rs` | Inode 抽象 |
| `dirent.rs` | 目录项 |
| `file.rs` | 文件抽象 |
| `file_system.rs` | 文件系统类型与管理器 |
| `fd_table.rs` | 文件描述符表 |
| `path.rs` | 路径解析 |
| `hash_name.rs` / `hash_table.rs` | 名称哈希与哈希表 |
| `fat32_tmp/` | FAT32 文件系统适配层 |
| `devfs/` | 设备文件系统（null、zero、block_device） |
| `procfs/` | 进程文件系统 |
| `testfs/` | 测试用文件系统 |
| `pipe.rs` | 管道 |
| `stdio.rs` | 标准输入/输出 |
| `page_cache.rs` | 页缓存 |
| `radix_tree.rs` | 基数树（用于页缓存索引） |
| `uio.rs` | 用户/内核 I/O 向量 |
| `kstat.rs` | 文件状态信息 |
| `utsname.rs` | 系统名称信息 |

### 4.4 系统调用（`kernel/src/syscall/`）

| 文件 | 涵盖的系统调用 |
|------|---------------|
| `fs.rs` | getcwd、open、close、read、write、stat、dirent 等文件相关调用 |
| `process.rs` | exit、nanosleep、fork、exec、waitpid 等进程相关调用 |
| `mm.rs` | brk、mmap、munmap（部分为桩实现） |
| `time.rs` | gettimeofday |
| `other.rs` | uname（桩实现） |

### 4.5 异常与中断处理（`kernel/src/trap/`）

- `trap_handler.asm`：陷入处理汇编入口（跳板机制，位于 TRAMPOLINE_VIRT_ADDR）
- `mod.rs`：Trap 分发，处理 SupervisorTimer 中断和 UserEnvCall 异常
- `syscall.rs`：系统调用分发

### 4.6 设备驱动（`kernel/src/driver/`）

| 文件 | 功能 |
|------|------|
| `block/virtio_blk.rs` | VirtIO 块设备驱动 |
| `block/buffer_cache.rs` | 块设备缓冲区缓存 |
| `block/io_device.rs` | I/O 设备抽象 |
| `qemu.rs` | QEMU 平台特定配置 |

### 4.7 其他模块

| 文件/目录 | 功能 |
|-----------|------|
| `console.rs` | 串口控制台输出（通过 SBI） |
| `sbi.rs` | SBI 接口封装 |
| `time.rs` | 时间管理（定时器中断） |
| `sync/up.rs` | 单核安全单元（UPSafeCell） |

## 五、Vendored 依赖（`dependencies/`）

共 16 个本地依赖：sbi-rt、riscv、spin-rs、bitflags、buddy_system_allocator、linked-list-allocator、xmas-elf、lazy-static、virtio-drivers、hashbrown、rust-fatfs、easy-fs、fu740-hal、fu740-pac、rustsbi、async-task。

## 六、构建工具需求

| 工具 | 用途 | 必要性 |
|------|------|--------|
| Rust nightly 工具链（rustc、cargo） | 编译 Rust 代码 | 必需 |
| cargo-binutils（rust-objcopy） | ELF 转 BIN | 必需 |
| rust-src、llvm-tools-preview | Rust 组件 | 必需 |
| QEMU（qemu-system-riscv64） | 模拟运行 | 运行必需 |
| RustSBI 固件（rustsbi-qemu.bin） | 引导加载 | 运行必需（已提供于 bootloader/） |
| riscv64-unknown-elf-gdb | 调试 | 可选 |
| dtc（设备树编译器） | 设备树相关 | 未直接使用 |

构建命令为 `make build`，运行命令为 `make run`，调试命令为 `make debug` + `make gdb`。

## 七、初步判断

1. 该项目是一个面向操作系统竞赛的 RISC-V 内核，结构清晰，子系统划分明确。
2. 已实现的子系统包括：内存管理（伙伴系统 + SLUB + 分页虚拟内存）、进程管理（PCB + 调度 + 上下文切换）、文件系统（VFS + FAT32 + DevFS + ProcFS + 管道）、系统调用（文件/进程/内存/时间）、异常处理（跳板机制）、块设备驱动（VirtIO）。
3. 部分系统调用（brk、mmap、munmap、uname）目前为桩实现（返回 0），尚未完成。
4. 项目为单核设计（sync 模块仅有 UPSafeCell，无 SMP 支持）。
5. 当前仅支持 RISC-V 64 位架构。