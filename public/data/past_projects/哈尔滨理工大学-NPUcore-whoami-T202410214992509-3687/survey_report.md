## NPUcore 项目初步调查报告

### 一、项目概述

**项目名称**：NPUcore（西北工业大学教学操作系统）

**开发语言**：Rust（含少量汇编）

**目标架构**：RISC-V 64位（rv64gc）

**目标平台**：QEMU virt、Kendryte K210、SiFive HiFive Unmatched (Fu740)

**Rust 工具链版本**：nightly-2022-04-11

**项目来源**：基于 OSKernel2023-NPUcore-plus 进行开发

---

### 二、仓库文件组织结构

```
.
├── os/                     # 内核主体代码（76个Rust源文件）
│   ├── src/
│   │   ├── arch/           # 架构相关代码（RISC-V 64）
│   │   ├── boards/         # 板级配置（qemu/k210/fu740）
│   │   ├── drivers/        # 设备驱动
│   │   ├── fs/             # 文件系统
│   │   ├── mm/             # 内存管理
│   │   ├── syscall/        # 系统调用
│   │   ├── task/           # 进程/线程管理
│   │   ├── main.rs         # 内核入口
│   │   ├── timer.rs        # 定时器
│   │   └── console.rs      # 控制台输出
│   └── Makefile
├── user/                   # 用户态程序（Rust）
├── easy-fs/                # easy-fs 文件系统库
├── easy-fs-fuse/           # FUSE 文件系统工具
├── bootloader/             # 引导加载程序二进制
├── rustsbi-k210/           # K210 平台 SBI 固件
├── bash-5.1.16/            # Bash 5.1.16 移植
├── dependency/             # 本地依赖库（riscv, virtio-drivers, k210-hal等）
├── vendor/                 # 第三方 crate（约35个）
├── docs/                   # 项目文档
├── Makefile                # 顶层构建脚本
├── rust-toolchain          # nightly-2022-04-11
├── sbi-qemu                # QEMU SBI 固件二进制
└── os.bin                  # 预编译内核二进制
```

---

### 三、子系统划分

#### 1. 内存管理子系统（`os/src/mm/`，9个文件）

| 文件 | 职责 |
|------|------|
| `address.rs` | 物理/虚拟地址抽象（PhysAddr, VirtAddr, PhysPageNum, VirtPageNum） |
| `frame_allocator.rs` | 物理页帧分配器 |
| `heap_allocator.rs` | 内核堆分配器 |
| `map_area.rs` | 内存映射区域（Frame, MapFlags, MapPermission） |
| `map_linearmap.rs` | 线性映射 |
| `memory_set.rs` | 地址空间管理（MemorySet, KERNEL_SPACE） |
| `page_table.rs` | 页表管理，用户空间数据拷贝 |
| `zram.rs` | 压缩内存（zram，条件编译） |

#### 2. 进程/线程管理子系统（`os/src/task/`，9个文件）

| 文件 | 职责 |
|------|------|
| `task.rs` | 进程控制块（TaskControlBlock, TaskStatus） |
| `manager.rs` | 任务调度器（就绪队列、可中断等待队列、OOM处理） |
| `processor.rs` | 处理器抽象（当前任务、调度入口） |
| `context.rs` | 任务上下文（TaskContext） |
| `pid.rs` | 进程标识符、内核栈管理 |
| `elf.rs` | ELF 加载（含动态链接器支持） |
| `signal.rs` | 信号机制 |
| `threads.rs` | 线程支持 |

#### 3. 文件系统子系统（`os/src/fs/`，20个文件）

| 目录/文件 | 职责 |
|-----------|------|
| `fat32/` | FAT32 文件系统实现（8个文件：bitmap, dir_iter, efs, inode, layout, vfs等） |
| `ext4/` | ext4 文件系统（仅lib.rs，可能为部分实现） |
| `dev/` | 设备文件（null, zero, pipe, tty, hwclock, socket） |
| `directory_tree.rs` | 目录树管理（VFS层） |
| `file_trait.rs` | 文件抽象 trait |
| `filesystem.rs` | 文件系统抽象 |
| `cache.rs` | 页缓存 |
| `poll.rs` | I/O 多路复用（poll/select） |
| `swap.rs` | 交换分区（条件编译） |
| `layout.rs` | 文件系统布局定义 |

#### 4. 系统调用子系统（`os/src/syscall/`，5个文件）

| 文件 | 职责 |
|------|------|
| `fs.rs` | 文件系统相关系统调用（open, read, write, dup, pipe, mkdir, link, mount等） |
| `process.rs` | 进程相关系统调用（clone, execve, fork, wait4, exit, futex等） |
| `socket.rs` | 网络套接字系统调用（socket, bind, listen, connect, sendto, recvfrom等） |
| `errno.rs` | 错误码定义 |
| `mod.rs` | 系统调用分发（约90个系统调用） |

#### 5. 设备驱动子系统（`os/src/drivers/`，5个文件）

| 目录/文件 | 职责 |
|-----------|------|
| `block/virtio_blk.rs` | VirtIO 块设备驱动 |
| `block/mem_blk.rs` | 内存块设备 |
| `block/block_dev.rs` | 块设备抽象 |
| `serial/ns16550a.rs` | NS16550A 串口驱动 |

#### 6. 架构相关子系统（`os/src/arch/rv64/`，约10个文件）

| 文件 | 职责 |
|------|------|
| `trap/` | 中断/异常处理（trap_handler, 上下文保存恢复） |
| `sv39.rs` | SV39 页表实现 |
| `sbi.rs` | SBI 调用接口 |
| `switch.rs` | 上下文切换（__switch） |
| `time.rs` | 时钟/定时器 |
| `config.rs` | 板级配置 |
| `board/` | QEMU/K210/Fu740 板级初始化 |
| `syscall_id.rs` | 系统调用号定义 |

#### 7. 其他组件

| 组件 | 说明 |
|------|------|
| `timer.rs` | 内核定时器（ITimerVal, TimeSpec, Times） |
| `easy-fs/` | 独立的 easy-fs 文件系统库（8个源文件） |
| `user/` | 用户态库和程序（initproc 等） |
| `bash-5.1.16/` | Bash shell 的 RISC-V 移植 |

---

### 四、系统调用覆盖范围

根据 `syscall/mod.rs` 中的分发逻辑，该项目实现了约 **90 个系统调用**，涵盖：

- **文件 I/O**：open, openat, close, read, write, readv, writev, pread, pwrite, lseek, sendfile, splice, dup, dup2, dup3, pipe2, getdents64, readlinkat, fstat, fstatat, statfs, ftruncate, fsync, utimensat
- **文件系统操作**：mkdirat, unlinkat, linkat, renameat2, mount, umount2, chdir, getcwd, faccessat, faccessat2
- **进程管理**：clone, execve, exit, exit_group, wait4, getpid, getppid, gettid, setpgid, getpgid, set_tid_address
- **内存管理**：mmap, munmap, mprotect, msync, brk, sbrk
- **信号**：kill, tkill, sigaction, sigprocmask, sigtimedwait, sigreturn
- **同步**：futex, set_robust_list, get_robust_list
- **时间**：clock_gettime, nanosleep, getitimer, setitimer, times, gettimeofday
- **网络**：socket, bind, listen, accept, connect, getsockname, getpeername, sendto, recvfrom, setsockopt
- **其他**：uname, sysinfo, getrusage, umask, syslog, prlimit, membarrier, pselect6, ppoll, ioctl, fcntl

---

### 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|----------------|
| Rust nightly-2022-04-11 | 编译内核和用户程序 | 需确认版本匹配 |
| cargo | Rust 包管理/构建 | 可用 |
| rust-objcopy (cargo-binutils) | 生成二进制镜像 | 可用 |
| rust-objdump | 反汇编 | 可用 |
| rust-src | 编译 no_std 代码 | 可用 |
| llvm-tools-preview | LLVM 工具 | 可用 |
| QEMU riscv64 | 运行模拟 | 可用 |
| RISC-V musl 交叉编译器 | 编译 Bash | **缺失** |
| GNU Make | 构建编排 | 可用 |
| mkfs.vfat / mcopy | 制作 FAT32 文件系统镜像 | 可用 |
| OpenSBI/RustSBI | SBI 固件 | 可用 |

**关键注意事项**：RISC-V musl 交叉编译工具链在当前环境中缺失，这将影响 Bash 的编译。顶层 `Makefile` 的 `all` 目标依赖 Bash 的编译产物，因此完整构建可能需要绕过 Bash 编译步骤或寻找替代方案。