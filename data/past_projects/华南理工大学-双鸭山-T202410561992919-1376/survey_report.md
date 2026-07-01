# OS 内核项目初步调查报告

## 一、项目基本信息

- **项目名称**: os（未命名品牌，来自华南理工大学参赛队伍 T202410561992919）
- **开发语言**: Rust（nightly-2024-02-03）
- **目标架构**: RISC-V 64位（riscv64gc-unknown-none-elf）
- **运行平台**: QEMU virt 机器，使用 RustSBI 作为 bootloader
- **参考项目**: rCore-Tutorial v3、Linux、Titanix、Maturin

## 二、仓库顶层结构

```
.
├── bootloader/          # SBI 固件（rustsbi-qemu.bin）
├── dependency/          # 本地依赖库
│   ├── bitmap-allocator-main/   # 位图分配器
│   └── riscv/                   # RISC-V CSR 操作库
├── os/                  # 内核主体
│   ├── src/             # 内核源码
│   ├── vendor/          # Cargo 离线依赖（约 41 个 crate）
│   ├── doc/             # 设计文档（内存、同步、中断、文件系统、进程模块）
│   ├── cargo-submit/    # 提交用 cargo 配置
│   ├── Cargo.toml       # Rust 包定义
│   ├── Cargo.lock       # 依赖锁定
│   └── Makefile         # 构建脚本
├── testcases/           # 用户态测试用例（ELF 二进制）
│   └── riscv64/         # 约 35 个测试程序
├── Makefile             # 顶层入口 Makefile
├── rust-toolchain.toml  # Rust 工具链配置
└── README.md
```

## 三、子系统划分

根据 `os/src/` 目录结构，该项目实现了以下子系统：

### 1. 内存管理子系统 (`os/src/mm/`)

| 文件/目录 | 职责 |
|-----------|------|
| `allocator/heap.rs` | 堆内存分配 |
| `allocator/frame.rs` | 物理页帧分配 |
| `address.rs` | 地址类型定义与转换 |
| `page_table.rs` | 页表管理 |
| `memory_set/mem_set.rs` | 地址空间（MemorySet）管理 |
| `memory_set/page_fault.rs` | 缺页异常处理 |
| `vma.rs` | 虚拟内存区域（VMA） |
| `vma_range/` | VMA 范围管理 |
| `cow.rs` | Copy-on-Write 机制 |
| `pma.rs` | 物理内存属性（PMA） |
| `type_cast.rs` | 类型转换辅助 |

### 2. 进程管理子系统 (`os/src/process/`)

| 文件/目录 | 职责 |
|-----------|------|
| `pcb.rs` | 进程控制块（PCB） |
| `pid.rs` | PID 分配器 |
| `context.rs` | 进程上下文 |
| `schedule.rs` | 调度器 |
| `switch.S` / `switch.rs` | 上下文切换（汇编+Rust） |
| `kstack.rs` | 内核栈管理 |
| `loader/` | ELF 加载器（含动态链接、栈初始化） |
| `hart/` | 硬件线程（hart）管理、CPU 本地变量 |
| `trap/` | 陷入（trap）处理，含汇编入口 |

### 3. 文件系统子系统 (`os/src/fs/`)

| 文件/目录 | 职责 |
|-----------|------|
| `fat32/` | FAT32 文件系统完整实现（BPB、FAT表、目录项、inode、block cache 等） |
| `dentry.rs` | 目录项（dentry）与路径解析 |
| `inode.rs` | inode 抽象 |
| `file.rs` | 文件抽象 |
| `file_system.rs` | 文件系统管理器（VFS 层，支持 mount/umount） |
| `fd_table.rs` | 文件描述符表 |
| `page_cache.rs` | 页缓存 |
| `stdio.rs` | 标准输入输出 |
| `pipe.rs` | 管道 |
| `info.rs` | 文件元信息（TimeSpec、InodeMode 等） |

### 4. 系统调用子系统 (`os/src/syscall/`)

| 文件 | 职责 |
|------|------|
| `mod.rs` | 系统调用分发（定义了约 90 个 syscall 编号，实际实现约 30 个） |
| `fs.rs` | 文件系统相关 syscall（read, write, open, close, dup, chdir, mkdir, mount, umount 等） |
| `mm.rs` | 内存相关 syscall（brk, mmap, munmap, mprotect） |
| `process.rs` | 进程相关 syscall（clone, execve, exit, wait4, getpid, getppid, yield） |
| `timer.rs` | 时间相关 syscall（gettimeofday, nanosleep, times） |
| `error.rs` | 错误码定义 |

### 5. 设备驱动子系统 (`os/src/driver/`)

| 文件/目录 | 职责 |
|-----------|------|
| `mod.rs` | 块设备/字符设备 trait 定义 |
| `qemu/virt_block.rs` | VirtIO 块设备驱动 |

### 6. 同步原语子系统 (`os/src/sync/`)

| 文件 | 职责 |
|------|------|
| `spin_mutex.rs` | 自旋锁实现 |
| `interrupt.rs` | 中断开关控制（push_off/push_on） |

### 7. 其他辅助模块

| 文件/目录 | 职责 |
|-----------|------|
| `timer/` | 定时器管理 |
| `config/` | 内核配置（fs、mm、task、timer 参数） |
| `boards/qemu.rs` | QEMU 平台特定配置 |
| `utils/` | 工具函数（路径处理、字符串、栈追踪、flag 检查等） |
| `console.rs` | 控制台输出 |
| `logging.rs` | 日志系统 |
| `sbi.rs` | SBI 调用封装 |
| `lang_items.rs` | Rust no_std 语言项 |
| `entry.S` | 内核入口汇编 |
| `linker.ld` | 链接脚本 |

## 四、构建工具需求

根据 Makefile 和配置文件分析：

| 工具 | 用途 | 状态 |
|------|------|------|
| `rustc` (nightly-2024-02-03) | Rust 编译器 | 需要确认版本 |
| `cargo` | 包管理与构建 | 可用 |
| `rust-src` | 编译核心库所需 | 可用 |
| `llvm-tools-preview` | 提供 rust-objcopy/rust-objdump | 可用 |
| `cargo-binutils` | rust-objcopy/rust-objdump 命令 | 可用 |
| `qemu-system-riscv64` | 模拟器运行 | 可用 |
| `mkfs.vfat` | 制作 FAT32 文件系统镜像 | 可用 |
| `dd` | 创建空镜像文件 | 可用 |
| RustSBI (bootloader) | SBI 固件 | 已包含在 bootloader/ 目录 |

构建流程：顶层 Makefile 复制 cargo 配置后进入 `os/` 目录，cargo 以 `--offline` 模式使用 vendor 目录中的依赖进行编译，然后通过 `rust-objcopy` 生成二进制镜像，最后用 `mkfs.vfat` 制作 FAT32 文件系统镜像。

## 五、初步观察

1. **架构完整度**: 项目覆盖了内存管理、进程管理、文件系统、系统调用、设备驱动、同步原语等核心子系统，结构较为完整。
2. **文件系统**: 仅实现了 FAT32，通过 VFS 层提供了 mount/umount 能力。
3. **系统调用**: 定义了约 90 个 syscall 编号，但实际实现了约 30 个，覆盖了初赛测试用例所需的基本调用。
4. **多核支持**: 代码中有 `multi_hart` feature flag，但当前默认未启用，主 hart 之外的核心进入空循环。
5. **测试用例**: 提供了 35 个 RISC-V 64 位 ELF 测试程序，涵盖进程、文件、内存、时间等 syscall。
6. **文档**: `os/doc/` 下有 5 份中文设计文档，覆盖内存、同步、中断、文件系统、进程模块。