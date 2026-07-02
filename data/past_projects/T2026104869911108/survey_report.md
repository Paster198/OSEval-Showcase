## 项目初步调查报告

### 一、项目概览

该项目名为 **starry-next**（亦称 Starry），是一个基于 **ArceOS 框架** 的 Rust 宏内核 OS 项目，参加全国大学生计算机系统能力大赛（OS 内核实现赛道）。项目以 ArceOS（一个 Rust unikernel 框架）为基础，在其上增加了完整的进程模型、系统调用接口和用户态支持，从而将其扩展为一个类 Linux 的宏内核。

- **编程语言**：Rust（`nightly-2025-05-20`，edition 2024）
- **支持架构**：RISC-V 64、x86_64、AArch64、LoongArch64
- **构建系统**：Cargo（Rust 原生）+ GNU Make
- **许可证**：GPL-3.0 / Apache-2.0 / MulanPSL-2.0

---

### 二、顶层目录结构

| 目录/文件 | 说明 |
|---|---|
| `src/` | 内核入口、系统调用分发、用户程序启动 |
| `core/` | 宏内核核心模块（进程/内存/同步/futex） |
| `api/` | 系统调用具体实现（文件、内存、任务、信号、网络等） |
| `crates/` | 本地 crate 依赖：`axprocess`、`axsignal` |
| `arceos/` | ArceOS 框架（unikernel 基础），以 git submodule 方式引入 |
| `apps/` | 用户态测试用例集（oscomp、nimbos、libc、junior） |
| `configs/` | 各架构的平台配置文件（`.toml`） |
| `patches/` | 对 ArceOS 框架的补丁文件 |
| `vendor/` | 第三方依赖的本地 vendored 副本（含定制修改） |
| `scripts/` | 构建、测试、环境配置等辅助脚本 |
| `docs/` | 设计文档、基线报告、答辩材料、演示视频 |
| `Cargo.toml` | Rust workspace 根配置 |
| `Makefile` | 顶层构建入口 |
| `build.rs` | Cargo 构建脚本（链接用户态应用二进制数据） |
| `rust-toolchain.toml` | Rust 工具链版本锁定 |

---

### 三、子系统划分

#### 1. 硬件抽象层（HAL）— `arceos/modules/axhal/`

- 架构相关代码：`arch/{x86_64, riscv, aarch64, loongarch64}/`
- CPU 管理、中断/异常处理、分页、内存属性、TLS（线程局部存储）、Trap 帧
- 平台相关驱动（QEMU virt 等）

#### 2. 内存管理 — `arceos/modules/axmm/` + `core/src/mm.rs`

- **ArceOS 侧**：地址空间（`AddrSpace`）、页帧管理、后端页表操作
- **core 侧**：用户地址空间创建、ELF 加载器、内核到用户空间拷贝、trampoline 映射

#### 3. 任务调度 — `arceos/modules/axtask/` + `core/src/task.rs`

- 任务结构、运行队列、等待队列、定时器、任务扩展接口
- 用户线程/进程管理（Thread, Process, ProcessGroup, Session）
- 进程数据（`ProcessData`）、线程数据（`ThreadData`）

#### 4. 进程管理 — `crates/axprocess/`

- `Process` 结构定义、`Thread` 结构、PID 管理、`init_proc`、fork 构建器模式

#### 5. 信号处理 — `crates/axsignal/`

- 信号结构（`Signo`）、信号队列、信号掩码、`sigaction`、信号 trampoline 页

#### 6. 同步原语 — `arceos/modules/axsync/`

- 自旋锁 Mutex、其他同步工具

#### 7. 文件系统 — `arceos/modules/axfs/`

- VFS 层（文件操作接口、目录、挂载点）
- 具体文件系统实现：FAT32（`rust-fatfs`）、ext4（`lwext4_rust`）、自定义 `myfs`
- 设备文件支持

#### 8. 网络栈 — `arceos/modules/axnet/`

- 基于 `smoltcp` 的 TCP/IP 协议栈封装

#### 9. 设备驱动 — `arceos/modules/axdriver/`

- virtio 驱动（块设备、网络）
- PCI 总线、ixgbe 网卡
- 块设备抽象、网络设备抽象

#### 10. 系统调用接口 — `src/syscall.rs` + `api/`

- **分发层**（`src/syscall.rs`）：通过 Trap 进入，按系统调用号分发至 `api/` 中的具体实现
- **实现层**（`api/src/imp/`）：
  - `fs/` — 文件操作（open, read, write, stat, getdents, ioctl, mount 等）
  - `mm/` — 内存管理（mmap, munmap, brk, shm 等）
  - `task/` — 进程/线程操作（clone, execve, exit, wait, fork 等）
  - `signal.rs` — 信号相关系统调用
  - `net.rs` — socket 相关系统调用
  - `time.rs` — 时间相关系统调用
  - `futex.rs` — futex 系统调用
  - `sys.rs` — 系统信息类调用

#### 11. 命名空间 — `arceos/modules/axns/`

- 文件描述符表、当前目录、根目录等命名空间抽象

#### 12. 运行时 — `arceos/modules/axruntime/`

- Rust `lang_items`（`#[no_std]` 运行时支持）、多核 SMP 启动

#### 13. 内存分配器 — `arceos/modules/axalloc/`

- 内核堆分配器、页分配器

#### 14. 日志 — `arceos/modules/axlog/`

- 内核日志输出（`ax_println!`、`info!`、`error!` 等宏）

#### 15. 配置 — `arceos/modules/axconfig/`

- 平台级常量配置（地址空间布局、设备基地址等）

---

### 四、系统调用覆盖度

从 `src/syscall.rs` 的 dispatch 表中统计，实现了约 **130+** 个 Linux 系统调用，涵盖：

- **进程管理**：fork, clone, clone3, execve, exit, exit_group, wait, waitpid, getpid, getppid, gettid
- **文件 IO**：open, openat, read, write, readv, writev, pread64, pwrite64, lseek, close, dup, dup2, dup3, sendfile, copy_file_range, splice
- **文件系统**：stat, fstat, lstat, statx, getdents64, mkdirat, linkat, unlinkat, renameat, renameat2, mount, umount2, chdir, getcwd, fcntl, ioctl, ftruncate, fallocate
- **内存管理**：mmap, munmap, mprotect, mremap, brk, madvise, msync, mlock, mlockall, shmget, shmat, shmdt, shmctl
- **信号**：rt_sigaction, rt_sigprocmask, rt_sigpending, rt_sigreturn, rt_sigtimedwait, rt_sigqueueinfo, kill, tkill, sigaltstack, signalfd4, pidfd_send_signal
- **网络**：socket, bind, connect, listen, accept, accept4, sendto, recvfrom, sendmsg, recvmsg, getsockopt, setsockopt, shutdown, socketpair, getpeername, getsockname
- **时间**：clock_gettime, clock_getres, clock_nanosleep, nanosleep, gettimeofday, times
- **同步**：futex, set_robust_list, get_robust_list
- **调度**：sched_yield, sched_getparam, sched_setparam, sched_getscheduler 等
- **其它**：getrandom, rseq, prctl, arch_prctl, uname, set_tid_address, membarrier 等

---

### 五、编译构建所需工具

1. **Rust 工具链**：`nightly-2025-05-20`，含 `rust-src`、`llvm-tools`、`rustfmt`、`clippy`
2. **交叉编译目标**：
   - `riscv64gc-unknown-none-elf`
   - `x86_64-unknown-none`
   - `aarch64-unknown-none` / `aarch64-unknown-none-softfloat`
   - `loongarch64-unknown-none` / `loongarch64-unknown-none-softfloat`
3. **musl 交叉编译器**（构建测例用）：RISC-V 和 LoongArch 的 musl 工具链（通过 `scripts/ensure_toolchains.sh` 下载到 `.toolchains/`）
4. **GNU Make**：顶层构建编排
5. **QEMU**：模拟运行（支持 4 种架构的 `qemu-system-*`）
6. **Docker**（可选）：容器化构建与评测环境
7. **Cargo**（Rust 包管理器 + 构建系统）

---

### 六、初步评估概要

该项目是一个功能相当完整的宏内核实现。它以 ArceOS unikernel 框架为基底，在其上叠加了进程模型、完整的 Linux 兼容系统调用层（130+ 个 syscall）、信号机制、Socket 网络栈，并支持 4 种 CPU 架构。代码组织清晰：ArceOS 框架提供底层 HAL/MM/FS/NET/调度/驱动等基础设施，`core/` 和 `api/` 提供宏内核扩展与 Linux syscall 兼容层，`crates/` 提供进程和信号的抽象数据结构。测试用例覆盖基础系统调用、BusyBox、Lua、libc-test 等，文档和构建系统也较为完备。