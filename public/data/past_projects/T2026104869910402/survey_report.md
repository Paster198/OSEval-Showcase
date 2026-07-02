## StellaOS 项目初步调查报告

### 一、项目概述

StellaOS 是一个用 Rust 语言编写的 OS 内核，面向 **RISC-V64 (Sv39)** 与 **LoongArch64** 双指令集架构，以 QEMU 虚拟机为主要运行平台。项目基于 rCore-Tutorial-v3 开发，引入 polyhal（Byte-OS）硬件抽象层以支持双架构。截至初赛，提供 160+ 个 Linux/POSIX 系统调用。

---

### 二、仓库顶层结构

```
StellaOS/
├── os/                    # 内核主体
├── filesystem/            # 独立文件系统 crate（VFS + 多种 FS 实现）
├── user/                  # 用户态库 + initproc（含各测试套件脚本）
├── sync/                  # 内核同步原语 crate（ksync）
├── bootloader/            # 引导固件（rustsbi-qemu.bin）
├── patches/               # 本地 patch 的第三方依赖
│   ├── polyhal/           #   硬件抽象层（CPU/IRQ/MMU/定时器/控制台等）
│   ├── polyhal-boot/      #   启动协议宏
│   ├── polyhal-trap/      #   陷入帧与陷入分发
│   └── lose-net-stack/    #   用户态 TCP/IP 网络栈
├── vendor/                # 完全 vendored 的 Rust 第三方 crate（~90 个）
├── scripts/               # 构建/测试/评测辅助脚本
├── dotcargo/              # cargo vendor 配置 + per-target rustflags
├── Makefile               # 顶层构建文件
├── Makefile.local         # 本地覆盖
├── Dockerfile             # 容器化构建环境
└── README.md / StellaOS初赛ppt.pptx
```

---

### 三、子系统划分

#### 1. 架构抽象层 — `os/src/arch/`

| 路径 | 职责 |
|---|---|
| `os/src/arch/mod.rs` | 架构无关 trait/re-export |
| `os/src/arch/riscv64/` | RISC-V64 专用：trap 入口、信号帧布局、块设备探测、virtio 传输 |
| `os/src/arch/loongarch64/` | LoongArch64 专用：同上对应实现 |
| `patches/polyhal/` | 更底层的硬件抽象（页表、IRQ、定时器、控制台、percpu、kcontext 等），覆盖 riscv64/loongarch64/aarch64/x86_64 |

#### 2. 内存管理 — `os/src/mm/`

| 文件 | 职责 |
|---|---|
| `frame_allocator.rs` | 物理帧分配器 |
| `heap_allocator.rs` | 内核堆分配器 |
| `page_alloc.rs` | polyhal 页分配适配 |
| `memory_set.rs` | 虚拟地址空间 (MemorySet + MapArea + MapBackend) |
| `address.rs` | 物理/虚拟地址类型与转换 |
| `translate.rs` | 用户态缓冲区安全读写（`translated_ref/str/byte_buffer`） |
| `elf.rs` | ELF 加载解析 |
| `shm.rs` | System V 共享内存 (shmget/shmat/shmdt/shmctl) |

#### 3. 进程与任务管理 — `os/src/task/`

| 文件 | 职责 |
|---|---|
| `task.rs` | TCB 定义、任务状态 |
| `process.rs` | PCB 定义、进程生命周期 |
| `manager.rs` | 任务/进程全局管理器（就绪队列、pid2process 映射） |
| `processor.rs` | 当前任务/进程、调度入口 `run_tasks` |
| `id.rs` | PID/TID 分配、内核栈分配 |
| `context.rs` / `switch.rs` | 上下文结构与切换 |
| `signal.rs` | POSIX 信号：pending/blocked 集合、sigaction、信号帧 |
| `futex.rs` | futex() 系统调用后端 |
| `action.rs` | 信号处理动作 |
| `clone_flags.rs` | clone 标志位解析 |
| `boot_pt.rs` | 启动阶段页表管理 |
| `auxv.rs` | 辅助向量 (auxv) |
| `probe.rs` | 内核探针（调度/系统调用/阻塞跟踪） |

#### 4. 文件系统 — `filesystem/` + `os/src/fs/`

`filesystem/` 是一个独立的 crate，实现了完整的 VFS 框架：

| 模块 | 职责 |
|---|---|
| `vfs/` | VFS 核心：Dentry 树、dentry cache (LRU)、文件描述符、挂载管理 |
| `vfs_defs/` | 公共定义：Inode trait、FileSystemType trait、SuperBlock、Stat、Flags、Error |
| `ext4fs/` | ext4 文件系统实现（包装 ext4_rs 库） |
| `vfatfs/` | VFAT (FAT12/16/32) 支持 |
| `devfs/` | 设备文件系统（/dev/null, /dev/zero, /dev/urandom, /dev/rtc, /dev/tty, /dev/console, /dev/loop*） |
| `procfs/` | proc 文件系统（/proc/meminfo, /proc/mounts, /proc/self/exe） |
| `ramfs/` | 内存文件系统 |
| `tmpfs/` | 临时文件系统 |
| `fat/` | FAT 卷探测 |
| `device.rs` | 块设备抽象 + MBR 分区扫描 |
| `page_cache.rs` | 页缓存 |
| `ext4_rs/` | ext4 库（fork，含 inode/block/extent/balloc/ialloc/dir 完整实现） |

`os/src/fs/` 层负责将 filesystem crate 接入内核（挂载根 FS、pipe、eventfd）。

#### 5. 系统调用 — `os/src/syscall/`

约 160+ 个系统调用，按领域拆分：

| 文件 | 覆盖范围 |
|---|---|
| `fs.rs` | openat, close, read, write, readv, writev, pread64, pwrite64, lseek, getdents64, stat, fstat, statfs, fstatat, statx, mkdirat, unlinkat, linkat, symlinkat, readlinkat, renameat2, truncate, ftruncate, fallocate, fchmod, fchmodat, fchownat, faccessat, utimensat, mount, umount2, chdir, fchdir, getcwd, dup, dup3, pipe2, fcntl, ioctl, sendfile, sync, fsync, fdatasync, mknod, flock, getrandom |
| `process.rs` | exit, exit_group, clone, exec, waitpid, brk, mmap, munmap, mprotect, mremap, madvise, mincore, mlock, mlockall, munlockall, prctl, getuid, geteuid, getgid, getegid, getpid, getppid, gettid, getpgid, setpgid, setsid, getgroups, setgroups, setuid, setresuid, setgid, setresgid, getresuid, getresgid, umask, uname, sysinfo, getrlimit, setrlimit, prlimit64, getrusage, capget, capset, sched_* |
| `signal.rs` | kill, tkill, tgkill, rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigtimedwait, rt_sigreturn, sigaltstack |
| `sync.rs` | futex, eventfd2 |
| `thread.rs` | thread_create, waittid, set_tid_address, set_robust_list, get_robust_list |
| `time.rs` | nanosleep, clock_gettime, clock_settime, clock_getres, clock_nanosleep, times, setitimer, pselect6, ppoll |
| `net.rs` | socket, socketpair, bind, listen, accept, accept4, connect, sendto, recvfrom, getsockname, getpeername, setsockopt, getsockopt, shutdown |
| `ipc.rs` | shmget, shmctl, shmat, shmdt, semget, semctl, semop |
| `gui.rs` / `input.rs` | framebuffer, framebuffer_flush, event_get, key_pressed (自定义) |
| `stub.rs` | 占位/未实现的 syscall（返回 ENOSYS） |

#### 6. 网络子系统 — `os/src/net/` + `patches/lose-net-stack/`

- `lose-net-stack`：用户态 TCP/IP 协议栈（TCP/UDP/ARP），作为 vendored crate
- `os/src/net/mod.rs`：桥接层，实现 `NetInterface` trait，支持 loopback (127.0.0.0/8) 本地回环、ARP 自应答
- virtio-net 驱动位于 `os/src/drivers/net/`

#### 7. 设备驱动 — `os/src/drivers/`

| 模块 | 设备 |
|---|---|
| `block/virtio_blk.rs` | virtio-blk（VDA 根文件系统 + VDB 辅助盘） |
| `bus/virtio.rs` | virtio MMIO 传输层 HAL |
| `chardev/ns16550a.rs` | NS16550A UART 串口（控制台输出） |
| `net/` | virtio-net 网卡驱动 |
| `gpu/` | virtio-gpu 图形输出（framebuffer + 光标） |
| `input/` | virtio-input 键盘 + 鼠标 |
| `plic.rs` | RISC-V PLIC 中断控制器 |

#### 8. 同步原语 — `sync/` (ksync) + `os/src/sync/`

| 原语 | 说明 |
|---|---|
| `Mutex` / `MutexSpin` / `MutexBlocking` | 互斥锁（阻塞 + 自旋） |
| `Condvar` | 条件变量 |
| `Semaphore` | 信号量 |
| `UPIntrFreeCell` / `UPSafeCellRaw` | 单核关中断互斥容器 |
| 支持 `lock_debug` 特性进行死锁检测 |

#### 9. 中断/陷入 — `os/src/trap/`

- 用户态陷入处理：syscall 分发、page fault 处理、信号注入
- 内核态中断：定时器 + PLIC 外部中断（块设备、网络）
- `context.rs`：TrapFrame 类型定义

#### 10. 定时器 — `os/src/timer.rs`

- 100 Hz 周期性 tick
- 基于二叉堆的高精度定时器（用于 nanosleep / futex 超时等）
- ITIMER_REAL 支持（SIGALRM）
- `clock_gettime` 支持多种时钟源

#### 11. 用户态支持 — `user/`

| 内容 | 说明 |
|---|---|
| `user/src/lib.rs` | 用户库：syscall 封装、console、file I/O、信号处理、同步原语 |
| `user/src/bin/initproc/` | init 进程，集成 basic / busybox / lua / libctest / iozone / unixbench / iperf / libcbench / lmbench / netperf / cyclictest / ltp 共 12 个测试套件脚本 |

---

### 四、构建工具链

| 工具 | 用途 |
|---|---|
| **Rust nightly-2025-02-18** (`os/rust-toolchain.toml`) | 内核 + 用户编译（含 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` target） |
| **cargo** + **offline mode** | 构建管理（全部依赖 vendored 到 `vendor/`） |
| **rust-objcopy** (llvm-tools) | 剥离/转换内核 ELF |
| **GNU Make** | 顶层构建编排 |
| **QEMU** (qemu-system-riscv64 / qemu-system-loongarch64) | 模拟运行 |
| **rust-gdb / gdb-multiarch** | 调试 |
| **Docker** | 容器化构建环境 |

顶层 `make all` 产出：`kernel-rv`（RISC-V ELF）、`kernel-la`（LoongArch ELF）、`disk.img`、`disk-la.img`。

---

### 五、子系统依赖关系（粗略）

```
user/initproc
    └── user_lib (系统调用封装)
            │
============│== 内核/用户边界 ================
            │
os/ (内核)
  ├── arch/       ←→  patches/polyhal, polyhal-boot, polyhal-trap
  ├── mm/         ←→  arch (页表操作)
  ├── task/       ←→  mm (地址空间), trap (上下文), timer (调度)
  ├── trap/       ←→  syscall (分发), arch (入口), task (上下文)
  ├── syscall/    ←→  fs, net, task, mm, timer
  ├── fs/         ←→  filesystem/ (VFS), drivers/block
  ├── net/        ←→  patches/lose-net-stack, drivers/net
  ├── drivers/    ←→  vendor/virtio-drivers, arch (MMIO)
  ├── sync/       ←→  sync/ (ksync), task (阻塞/唤醒)
  └── timer/      ←→  polyhal (硬件定时器), task (唤醒)
```

该项目整体架构清晰，模块边界明确，通过 VFS、HAL 等抽象层实现了较好的解耦和双架构支持。