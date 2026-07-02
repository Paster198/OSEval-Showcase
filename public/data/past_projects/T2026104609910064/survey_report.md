## 项目初步调查报告

### 一、项目概况

本项目 **OSKernel2026** 是一个基于 Rust 语言开发的 OS 内核，参加 2026 年全国大学生计算机系统能力大赛（操作系统内核实现赛道）。项目基于 [rCore-Tutorial-v3](https://github.com/rcore-os/rCore-Tutorial-v3) ch8 分支及 [SubsToKernel](https://github.com/wdlin233/osrepo)（北京科技大学 2025 年参赛作品）进行增量开发。队伍信息：河南理工大学，"外卖只点拼好饭"，成员霍启晨、李辉、孙铭浩。

### 二、仓库文件组织结构

```
repo/
├── .git/                          # Git 仓库元数据
├── .gitignore                     # Git 忽略规则
├── LICENSE                        # 开源许可证
├── Makefile                       # 顶层 Makefile（支持 ARCH=riscv64/loongarch64）
├── README.md                      # 项目说明
├── rust-toolchain.toml            # Rust 工具链版本固定（nightly-2025-01-18）
├── build_all.sh                   # 双架构（RISC-V + LoongArch）构建脚本（Docker 内）
├── build_loong.sh                 # LoongArch 单架构构建脚本（Docker 内）
├── run_qemu.sh                    # QEMU 快速启动脚本（RISC-V，ext4 验证）
├── run_test.sh                    # 完整测例运行脚本
├── docs/                          # 参赛文档
│   ├── design_doc.md              # 系统设计方案文档
│   └── img/                       # 图片（含测试截图）
├── os/                            # 内核主 crate
│   ├── Cargo.toml                 # 内核依赖声明
│   ├── Makefile                   # 内核构建 Makefile
│   ├── build.rs                   # 构建脚本（动态生成链接脚本）
│   ├── linker.lds                 # 链接脚本模板
│   ├── cargo/                     # Cargo 离线编译配置
│   ├── vendor/                    # 依赖项离线 vendor（cty 等）
│   ├── libs/                      # 第三方库
│   │   ├── lwext4_rsut/           # ext4 文件系统 C 库的 Rust 绑定
│   │   └── smoltcp/               # 嵌入式 TCP/IP 协议栈
│   └── src/                       # 内核源代码
│       ├── main.rs                # 内核入口点
│       ├── boot.rs                # 启动代码（RISC-V & LoongArch 内联汇编）
│       ├── config.rs              # 内核常量配置
│       ├── lang_items.rs          # panic handler 等语言项
│       ├── logging.rs             # 日志系统
│       ├── system.rs              # uname 系统信息
│       ├── timer.rs               # 定时器（TimeVal, TimeSpec, Itimerval）
│       ├── trap.rs                # Trap 处理（使用 polyhal 框架）
│       ├── boards/qemu.rs         # QEMU 板级配置（时钟频率、MMIO、关机）
│       ├── mm/                    # 内存管理子系统
│       ├── task/                  # 任务/进程管理子系统
│       ├── fs/                    # 文件系统子系统
│       ├── syscall/               # 系统调用子系统
│       ├── net/                   # 网络子系统
│       ├── sync/                  # 同步原语子系统
│       ├── signal/                # 信号处理子系统
│       ├── drivers/               # 设备驱动子系统
│       ├── hal/                   # 硬件抽象层
│       ├── users/                 # 用户/组管理
│       └── utils/                 # 工具模块
└── user/                          # 用户态程序
    ├── Cargo.toml
    ├── Makefile
    ├── build.rs
    ├── linker.lds
    ├── cargo/                     # Cargo 离线配置
    ├── vendor/                    # 依赖 vendor
    └── src/
        ├── lib.rs                 # 用户库（系统调用封装）
        ├── syscall.rs             # 系统调用接口
        ├── console.rs             # 控制台 I/O
        ├── lang_items.rs          # 用户态 panic handler
        └── bin/                   # 用户程序
            ├── initproc.rs        # 初始进程（init）
            ├── user_shell.rs      # 用户 Shell
            ├── usertest.rs        # 用户测试
            └── test_waitpid.rs    # waitpid 测试
```

### 三、子系统划分

| 子系统 | 核心目录 | 主要职责 | 关键文件 |
|--------|---------|---------|---------|
| **内存管理 (mm)** | `os/src/mm/` | SV39 页表、物理帧分配、堆分配、内存集合、共享内存、CoW | `page_table.rs`, `frame_allocator.rs`, `memory_set.rs`, `heap_allocator.rs`, `shm.rs`, `page_fault_handler.rs` |
| **任务管理 (task)** | `os/src/task/` | 进程(PCB)、线程(TCB)、调度器(stride)、futex、PID/TID 分配 | `process.rs`, `task.rs`, `manager.rs`, `processor.rs`, `stride.rs`, `futex.rs` |
| **文件系统 (fs)** | `os/src/fs/` | VFS 抽象层、ext4 文件系统、设备文件系统、管道、stdio | `vfs/`, `ext4_lw/`, `devfs.rs`, `pipe.rs`, `stdio.rs`, `fstruct.rs`, `fsidx.rs`, `mount.rs` |
| **系统调用 (syscall)** | `os/src/syscall/` | 所有系统调用的分发与实现 | `mod.rs`（分发）, `fs.rs`, `process.rs`, `mem.rs`, `net.rs`, `sync.rs`, `signal.rs`, `thread.rs` |
| **网络 (net)** | `os/src/net/` | TCP/UDP 套接字、DNS、回环接口、轮询 | `socket/` (tcp.rs, udp.rs, dns.rs, loopback.rs), `socket_impl.rs`, `lazy_init.rs` |
| **同步 (sync)** | `os/src/sync/` | 互斥锁、信号量、条件变量、UP 安全单元、银行家算法（死锁检测） | `mutex.rs`, `semaphore.rs`, `condvar.rs`, `up.rs`, `banker_algo.rs` |
| **信号 (signal)** | `os/src/signal/` | POSIX 信号集（SIGHUP~SIGSYS 共 31 种）、信号动作表、信号栈 | `signal.rs`, `sigact.rs` |
| **设备驱动 (drivers)** | `os/src/drivers/` | VirtIO 块设备、VirtIO 网卡、磁盘抽象层、设备 trait 定义 | `virtio/blk.rs`, `virtio/net.rs`, `disk.rs`, `device.rs` |
| **硬件抽象层 (hal)** | `os/src/hal/` | 架构相关抽象：RISC-V 与 LoongArch trap、UART、控制台 | `arch/`, `trap/` (含 trap_rv.s, trap_la.s), `utils/console.rs` |
| **定时器 (timer)** | `os/src/timer.rs` | 时间结构 (TimeVal, TimeSpec, Itimerval)、定时器中断、时钟获取 | 含 `ITIMER_REAL/VIRTUAL/PROF` 三种 itimer |
| **用户管理 (users)** | `os/src/users/` | 用户与用户组管理，UID/GID | `users.rs`, `group.rs`, `id.rs` |
| **工具 (utils)** | `os/src/utils/` | 错误类型定义、字符串工具、hart ID、调用栈回溯 | `error.rs`, `string.rs`, `hart.rs` |

### 四、代码规模

| 类别 | 行数 |
|------|------|
| 内核 Rust 源码 (`os/src/*.rs`) | ~22,400 行 |
| 内核汇编 (`os/src/**/*.s`) | ~480 行 |
| 用户库 Rust 源码 (`user/src/*.rs`) | ~1,200 行 |
| 第三方库 Rust 源码 (`os/libs/`) | ~59,200 行（含 lwext4_rsut 和 smoltcp） |
| **Rust 源码总计**（不含 vendor 和 target） | **~83,000 行** |

### 五、构建工具与依赖

1. **Rust 工具链**: `nightly-2025-01-18`，包含 `rust-src`, `llvm-tools-preview`, `rustfmt`, `clippy`
2. **构建系统**: Cargo + Makefile（支持 `ARCH=riscv64` 和 `ARCH=loongarch64`）
3. **容器环境**: Docker（基于 `docker.educg.net/cg/os-contest:20250226` 或 `zhouzhouyi/os-contest:20260510`）
4. **关键依赖**（`os/Cargo.toml`）:
   - `virtio-drivers`: 0.6.0（VirtIO 块设备与网卡驱动）
   - `smoltcp`: 本地路径（嵌入式 TCP/IP 协议栈）
   - `lwext4_rust`: 本地路径（ext4 文件系统的 C/Rust 绑定库）
   - `riscv` / `loongarch64`: 架构相关寄存器操作
   - `buddy_system_allocator`, `spin`, `lazy_static`, `bitflags`, `hashbrown` 等基础组件
   - `xmas-elf`: ELF 文件解析
5. **链接方案**: `build.rs` 动态生成架构特定的链接脚本（RISC-V 基址 `0x80200000`，LoongArch 基址 `0x82000000`）
6. **模拟环境**: QEMU（RISC-V virt 机器、LoongArch 机器）
7. **构建模式**: 离线编译（`CARGO_NET_OFFLINE=true`），使用 vendored 依赖

### 六、架构支持

项目明确支持双架构：

- **RISC-V64** (`riscv64gc-unknown-none-elf`)：基于 OpenSBI，SV39 页表
- **LoongArch64** (`loongarch64-unknown-none`)：直接启动，使用 DMW 进行地址映射