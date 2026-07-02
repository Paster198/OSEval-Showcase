## 项目初步调查报告

### 一、项目概览

该项目名为 **unit00**，是一个基于 Rust 编写的 RISC-V 64 位操作系统内核，面向 OS 内核竞赛设计。项目以 Cargo workspace 方式组织，目标平台为 `riscv64gc-unknown-none-elf`，使用 SV39 分页机制，运行于 QEMU `virt` 机器上。内核定位为 "stage-1" 实现，即功能覆盖广泛但实现上以单机、单节点、简化路径为主。

---

### 二、仓库文件组织结构

```
/
├── Cargo.toml              # workspace 根配置
├── Makefile                 # 构建入口（含比赛评测合约 target: kernel-rv, kernel-la）
├── README.md
├── SUBMISSION.md
├── .cargo/                  # cargo 构建配置（由 cargo_hidden/ 复制生成）
├── cargo_hidden/            # .cargo 的持久化副本（因评测系统过滤隐藏目录）
│   └── config.toml          # rustflags（链接脚本路径）、构建目标
├── .github/                 # CI 配置
└── kernel/                  # 内核主 crate
    ├── Cargo.toml
    ├── linker.ld            # RISC-V 链接脚本（入口 0x80200000）
    ├── la_stub.S            # LoongArch 占位 stub（非功能内核）
    └── src/
        ├── main.rs          # 内核入口 + FDT 内存探测
        ├── console.rs       # NS16550 UART 驱动
        ├── trap.rs          # 陷阱/中断处理
        ├── sbi.rs           # SBI ecall 封装
        ├── timer.rs         # RISC-V 定时器
        ├── elf.rs           # ELF 格式解析
        ├── exec.rs          # ELF 加载与 exec 实现
        ├── ext4.rs          # EXT4 只读元数据读取
        ├── rootfs.rs        # Stage-1 静态只读根文件系统
        ├── procfs.rs        # /proc 伪文件系统
        ├── contest.rs       # 竞赛测试脚本调度
        ├── virtio_blk.rs    # virtio-mmio 块设备驱动
        ├── virtio_net.rs    # virtio-mmio 网络设备探测
        ├── user_smoke.S     # 内嵌用户态冒烟测试程序
        ├── mm/              # 内存管理子系统
        ├── task/            # 任务/进程管理子系统
        └── syscall/         # 系统调用子系统
```

---

### 三、子系统划分

#### 1. 启动与初始化（Boot & Init）

| 文件 | 说明 |
|------|------|
| `kernel/linker.ld` | 链接脚本，定义 `_start` 入口、BSS 段、内核栈（256KB） |
| `kernel/src/main.rs` | 汇编入口 `_start`（BSS 清零、栈设置），Rust 入口 `rust_main`；FDT 解析探测物理内存大小；页表初始化、用户态 trampoline 安装、内核服务启动 |

#### 2. 内存管理（Memory Management）

| 文件 | 行数 | 说明 |
|------|------|------|
| `kernel/src/mm/mod.rs` | 4 | 模块入口 |
| `kernel/src/mm/frame.rs` | 425 | 物理页帧分配器（`alloc_frame`、`dec_ref`、`frame_init`） |
| `kernel/src/mm/page_table.rs` | 389 | SV39 页表管理（`PTEFlags`、`PTEntry`、`PageTable`、内核/用户映射） |

#### 3. 陷阱与中断处理（Trap Handling）

| 文件 | 行数 | 说明 |
|------|------|------|
| `kernel/src/trap.rs` | 320 | `stvec` 初始化、内核陷阱处理器 `kernel_trap_handler`、用户态陷阱分派（syscall/缺页/定时器） |

#### 4. 系统调用（System Call）

这是最大的子系统，总代码约 22,000+ 行。按功能分组：

| 文件/目录 | 行数 | 覆盖的 syscall 类别 |
|-----------|------|---------------------|
| `syscall.rs` | 339 | 模块入口，集中 re-export |
| `syscall/dispatcher.rs` | 385 | 系统调用分发表 |
| `syscall/nr.rs` | 232 | 系统调用号定义 |
| `syscall/abi.rs` | 588 | 系统调用 ABI 类型与常量 |
| `syscall/errno.rs` | 56 | Linux errno 定义 |
| `syscall/usermem.rs` | 322 | 用户内存安全读写 |
| `syscall/user_layout.rs` | 28 | 用户地址空间布局常量 |
| `syscall/fs_ops.rs` | 1195 | 文件系统操作（openat, read, write, stat, getdents 等） |
| `syscall/fs_mutation.rs` | 1319 | 文件系统变更（mkdir, unlink, rename, symlink 等） |
| `syscall/fs_path.rs` | 1366 | 路径解析与遍历 |
| `syscall/fd_ops.rs` | 367 | 文件描述符操作（dup, fcntl, close 等） |
| `syscall/fd_readiness.rs` | 316 | FD 就绪状态检查 |
| `syscall/fd_util.rs` | 48 | FD 工具函数 |
| `syscall/io_ops.rs` | 1104 | I/O 操作（read/write 分派） |
| `syscall/io_ops/special_fd.rs` | - | 特殊 FD（eventfd, timerfd 等）读写 |
| `syscall/io_transfer.rs` | 18 | I/O 传输模块入口 |
| `syscall/io_transfer/vectored.rs` | - | readv/writev/preadv/pwritev |
| `syscall/io_transfer/positioned.rs` | - | pread64/pwrite64 |
| `syscall/io_transfer/splice.rs` | - | vmsplice |
| `syscall/io_transfer/copy_range.rs` | - | sendfile/copy_file_range |
| `syscall/memory_ops.rs` | 110 | 内存操作模块入口 |
| `syscall/memory_ops/mapping.rs` | - | mmap/munmap/mprotect/brk |
| `syscall/memory_ops/advice.rs` | - | madvise/msync/mlock 系列 |
| `syscall/memory_ops/mempolicy.rs` | - | mbind/set_mempolicy/get_mempolicy |
| `syscall/memory_ops/range.rs` | 72 | 地址范围校验 |
| `syscall/process_ops.rs` | 3245 | 进程操作（fork, clone, exit, wait, kill, tkill 等） |
| `syscall/signal.rs` | 3293 | 信号处理（sigaction, sigprocmask, rt_sigreturn 等） |
| `syscall/futex_ops.rs` | 715 | futex 操作（含 PI futex） |
| `syscall/socket_ops.rs` | 1077 | 套接字操作入口 |
| `syscall/socket_ops/addr.rs` | 271 | 套接字地址处理 |
| `syscall/socket_ops/msg.rs` | 896 | sendmsg/recvmsg |
| `syscall/socket_ops/sockopt.rs` | 782 | getsockopt/setsockopt |
| `syscall/time_ops.rs` | 1199 | 时间相关（clock_gettime, nanosleep, timerfd 等） |
| `syscall/time_util.rs` | 127 | 时间工具函数 |
| `syscall/poll_ops.rs` | 1091 | poll/ppoll/select/pselect6 |
| `syscall/event_ops.rs` | 435 | eventfd 操作 |
| `syscall/sched_ops.rs` | 564 | 调度相关（sched_yield, setpriority, sched_setaffinity 等） |
| `syscall/identity_ops.rs` | 732 | 身份相关（getuid, setuid, getgid, capget/capset 等） |
| `syscall/exec_ops.rs` | 270 | execveat |
| `syscall/mount_ops.rs` | 192 | mount/umount |
| `syscall/system_ops.rs` | 535 | 系统操作（uname, sysinfo, reboot 等） |
| `syscall/misc_ops.rs` | 167 | 杂项（getrandom 等） |
| `syscall/cwd_ops.rs` | 142 | 当前工作目录操作 |
| `syscall/device_ops.rs` | 282 | 设备操作（ioctl 等） |
| `syscall/fcntl_lock.rs` | 561 | 文件锁（fcntl setlk/getlk） |
| `syscall/klog.rs` | 27 | syslog |
| `syscall/ext4_fd.rs` | 53 | EXT4 文件 FD |
| `syscall/proc_fd.rs` | 549 | /proc FD 实现 |
| `syscall/regular_file.rs` | 519 | 普通文件读写 |
| `syscall/process_lookup.rs` | 100 | 进程查找辅助 |

#### 5. 任务与进程管理（Task & Process）

| 文件 | 行数 | 说明 |
|------|------|------|
| `task/mod.rs` | 15 | 模块入口 |
| `task/process.rs` | 2556 | 进程结构体、地址空间、凭证、信号队列、futex key、mmap 区域、rlimit、POSIX 定时器等 |
| `task/scheduler.rs` | 1641 | 全局进程列表、PID 分配、调度器（`current`, `schedule`, wake 系列） |
| `task/trapframe.rs` | 100 | TrapFrame 结构定义 |
| `task/thread_group.rs` | 81 | 线程组管理 |
| `task/fd.rs` | 1069 | 文件描述符表、FdEntry、FdKind、OpenFile |
| `task/pipe.rs` | 280 | 管道实现 |
| `task/socket.rs` | 1489 | Unix 域套接字实现 |
| `task/inet_socket.rs` | 2447 | INET 套接字（IPv4/IPv6 TCP/UDP） |
| `task/epoll.rs` | 208 | epoll 实例管理 |
| `task/eventfd.rs` | 124 | eventfd 实现 |
| `task/timerfd.rs` | 145 | timerfd 实现 |
| `task/signalfd.rs` | 72 | signalfd 实现 |
| `task/pidfd.rs` | 30 | pidfd 实现 |
| `task/inotify.rs` | 465 | inotify 实现 |
| `task/scratchfs.rs` | 1728 | 可写内存文件系统（用于 /tmp 等） |

#### 6. 文件系统（Filesystem）

| 文件 | 行数 | 说明 |
|------|------|------|
| `kernel/src/rootfs.rs` | - | Stage-1 静态只读根文件系统：硬编码目录树，含 `/dev`、`/sys`、`/proc`、`/bin`、`/etc` 等路径 |
| `kernel/src/ext4.rs` | - | Stage-1 只读 EXT4 元数据解析器，支持 extents、目录遍历、符号链接 |
| `kernel/src/procfs.rs` | - | /proc 伪文件系统动态生成（进程信息、挂载表、内存信息等） |
| `kernel/src/elf.rs` | - | ELF 二进制解析（ET_EXEC / ET_DYN），含动态链接器探测 |
| `kernel/src/exec.rs` | - | execve 实现：ELF 加载、地址空间构建、辅助向量、解释器（interpreter）支持 |

#### 7. 设备驱动（Device Drivers）

| 文件 | 说明 |
|------|------|
| `kernel/src/console.rs` | NS16550 UART 驱动（MMIO 基址 0x1000_0000），提供 `puts`/`putchar`/`read_char` |
| `kernel/src/virtio_blk.rs` | virtio-mmio 块设备驱动（只读、单队列、512B 扇区），支持 legacy 和 modern 寄存器布局 |
| `kernel/src/virtio_net.rs` | virtio-mmio 网络设备探测（仅 MAC 地址发现，未实现数据路径） |

#### 8. 平台抽象层（SBI / Timer）

| 文件 | 说明 |
|------|------|
| `kernel/src/sbi.rs` | RISC-V SBI ecall 封装（关机） |
| `kernel/src/timer.rs` | RISC-V `time` CSR 读取 + SBI `set_timer` |

#### 9. 竞赛集成（Contest Integration）

| 文件 | 说明 |
|------|------|
| `kernel/src/contest.rs` | 竞赛测试脚本发现与调度：解析 EXT4 镜像中的 `_testcode.sh` 文件，格式化竞赛输出标记，支持 busybox/lua/iperf/netperf/lmbench/unixbench/libcbench/cyclictest/hackbench/iozone/ltp 等测试套件 |
| `kernel/src/user_smoke.S` | 内嵌 RISC-V 用户态冒烟测试程序（寄存器保留验证 + getpid） |

---

### 四、构建工具需求

根据 `Makefile` 和 `.cargo/config.toml` 分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| **Rust 工具链**（nightly 版本之一：`nightly-2025-02-01`、`nightly-2025-05-20`、`nightly-2025-01-18` 或 `nightly`） | 编译内核 Rust 代码 |
| **RISC-V 裸机目标** `riscv64gc-unknown-none-elf` | Rust 交叉编译目标 |
| **cargo** | Rust 构建管理 |
| **LoongArch 交叉工具链**（`loongarch64-linux-gnu-as`、`loongarch64-linux-gnu-ld`） | 汇编/链接 LoongArch stub |
| **QEMU**（`qemu-system-riscv64`） | 模拟运行（`make run`/`make qemu`） |
| **GNU Make** | 构建编排 |

其他开发辅助工具：`rustfmt`（格式化）、`clippy`（lint）。

---

### 五、架构支持状态

| 架构 | 状态 |
|------|------|
| **RISC-V 64** | 完整实现（`riscv64gc-unknown-none-elf`） |
| **LoongArch 64** | 仅占位 stub（`la_stub.S`，汇编后 idle 循环，非功能内核） |

---

### 六、关键设计特征摘要

1. **单内核镜像**：所有功能编译为单一 `unit00` ELF，链接地址 `0x80200000`。
2. **Stage-1 哲学**：大量模块标记为 "stage-1"，表示当前实现偏重功能覆盖而非生产级完备性（如 EXT4 只读、网络仅探测 MAC、单队列 virtio 等）。
3. **SV39 分页**：RISC-V 三级页表（512GB 内核空间 + 512GB 用户空间）。
4. **系统调用覆盖广泛**：实现了 Linux 兼容的约 200+ 个系统调用，涵盖文件、进程、信号、futex、socket、epoll、timerfd、inotify 等。
5. **无标准库**：`#![no_std]` + `#![no_main]`，使用 `core` 库和裸指针操作硬件。
6. **内嵌 rootfs**：根文件系统以硬编码方式提供 `/dev`、`/proc`、`/sys`、`/etc` 等标准路径。