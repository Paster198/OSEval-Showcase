## 项目名称与技术栈

- **项目名称**：MangoCore（又名 NPUCore / Aspera）
- **编程语言**：Rust（`#![no_std]` 裸机内核）+ 少量汇编（LoongArch/RISC-V）
- **代码规模**：约 2923 个 `.rs` 源文件，合计约 55,273 行 Rust 代码
- **架构支持**：riscv64（RISC-V 64-bit）和 loongarch64（LoongArch 64-bit）
- **运行环境**：QEMU virt / OpenSBI（RISCV），QEMU virt（LoongArch）
- **许可证**：GPLv3

---

## 一、文件组织结构

```
repo/
├── os/                          # 【内核主体】操作系统内核源码与构建
│   ├── Cargo.toml               # 内核 cargo 清单（特性开关、依赖声明）
│   ├── Makefile                 # 内核顶层构建入口，调度 rv64.mk / la64.mk
│   ├── make/
│   │   ├── rv64.mk              # RISC-V 64 构建脚本
│   │   └── la64.mk              # LoongArch 64 构建脚本
│   ├── src/
│   │   ├── main.rs              # 内核入口（#![no_std]）
│   │   ├── lang_items.rs[.rv/.la]  # Rust 语言项（架构相关）
│   │   ├── console.rs           # 控制台输出
│   │   ├── drivers/             # 设备驱动
│   │   ├── fs/                  # 文件系统
│   │   ├── hal/                 # 硬件抽象层
│   │   ├── mm/                  # 内存管理
│   │   ├── net/                 # 网络协议栈
│   │   ├── syscall/             # 系统调用
│   │   ├── task/                # 任务/进程管理
│   │   ├── math/                # 数学工具
│   │   ├── utils/               # 通用工具
│   │   ├── timer.rs             # 定时器
│   │   └── trace.rs / panic_diag.rs  # 诊断与追踪
│   ├── vendor/                  # 第三方 Rust crate 源码（离线依赖）
│   ├── initramfs/               # initramfs 内容
│   └── buildfs.sh / build_initramfs.sh  # 文件系统构建辅助脚本
│
├── user/                        # 【用户态程序】用户库 + 测试程序
│   ├── Cargo.toml
│   ├── Makefile
│   ├── src/
│   │   ├── lib.rs               # 用户库入口
│   │   ├── syscall.rs / syscall.S  # 系统调用封装
│   │   ├── usr_call.rs          # 用户态调用封装
│   │   ├── console.rs / lang_items.rs
│   │   └── bin/                 # 用户态可执行程序
│   │       ├── init.rs          # init 进程
│   │       ├── initproc.rs      # 初始进程（守护/测试管理）
│   │       ├── ltprunner.rs     # LTP 测试运行器
│   │       ├── fs_test.rs       # 文件系统测试
│   │       ├── inet_test.rs     # 网络测试
│   │       └── unix_test.rs     # Unix socket 测试
│   ├── fs/                      # 预置 rootfs 目录结构
│   └── vendor/                  # 用户态第三方依赖
│
├── bootloader/                  # 【引导固件】
│   └── fw_payload.bin           # OpenSBI/RustSBI 固件镜像
│
├── dependency/                  # 【本地依赖/外部crate补丁】
│   ├── riscv/                   # RISC-V 寄存器定义
│   ├── rustsbi/                 # RustSBI 接口
│   ├── smoltcp/                 # 网络协议栈（smoltcp）
│   ├── virtio-drivers/          # virtio 驱动
│   ├── dep_iso/src/             # 同构驱动（AHCI、e1000、ixgbe）
│   ├── dep_pci/pci/             # PCI 总线驱动
│   └── rlibc/                   # 最小 C 库
│
├── scripts/                     # 【辅助脚本】
│   ├── run_full_test.py         # 全量测试运行
│   ├── run_test_docker_parallel.sh  # Docker 并行测试
│   ├── auto_exclude_ltp.py / auto_include_ltp.py  # LTP 用例管理
│   ├── analyze_drift.py         # 时间漂移分析
│   └── make_mbr_tools_disk.py   # MBR 磁盘工具
│
├── judge/                       # 【评测脚本】
│   ├── run.py / run_judge.py    # 评测入口
│   ├── judge_basic-*.py         # 基础测试评测
│   ├── judge_ltp-*.py           # LTP 评测
│   ├── judge_libctest-*.py      # libc 测试评测
│   ├── judge_iperf-*.py         # 网络性能评测
│   ├── judge_netperf-*.py       # 网络性能评测
│   └── ...（共约 20 个评测脚本）
│
├── tools/
│   └── kernel-mcp/server.py     # 内核 MCP 调试服务
│
├── docs/                        # 【文档】
├── references/                  # 【参考资料】
│   └── debugging-patterns.md
│
├── cargo-config/                # Cargo 配置（镜像/离线）
├── cargo-checksums/             # Cargo vendor 校验和
├── cc-codex/                    # Codex 配置文件
├── .github/                     # CI 配置
├── docker-compose.yml           # Docker 开发环境
├── Makefile                     # 顶层构建入口
├── run_test.sh                  # 测试运行脚本
├── how-to-run.md                # 运行/评测说明
├── README.md                    # 项目说明
├── copymusl.sh / copyglibc.sh   # libc 复制脚本
└── 演示视频.mp4 / MangoCore.pptx
```

---

## 二、子系统识别与划分

根据目录结构和源码内容，该项目实现了以下子系统：

### 1. 硬件抽象层（HAL）— `os/src/hal/`

| 子目录 | 内容 | 归属说明 |
|--------|------|----------|
| `hal/arch/riscv/` | SV39 页表、RISC-V trap 处理、上下文切换、SBI 调用、链接脚本 | RISC-V 架构后端 |
| `hal/arch/loongarch64/` | LoongArch CSR 寄存器、TLB 管理、trap 处理、DMW 直接映射窗口、ACPI | LoongArch 架构后端 |
| `hal/platform/riscv/` | QEMU / FU740 / K210 平台定义 | RISC-V 平台支持 |
| `hal/platform/loongarch64/` | QEMU / 2K1000 平台定义 | LoongArch 平台支持 |
| `hal/configs/` | 平台配置 TOML（设备树、内存布局等） | 配置数据 |

### 2. 内存管理（MM）— `os/src/mm/`

| 文件 | 内容 |
|------|------|
| `address.rs` | 虚拟/物理地址抽象 |
| `address_space.rs` | 地址空间管理 |
| `frame_allocator.rs` | 物理页帧分配器 |
| `frame_store.rs` | 页帧存储 |
| `heap_allocator.rs` | 内核堆分配器 |
| `page_table.rs` | 页表操作 |
| `vma.rs` / `vma_set.rs` | 虚拟内存区域（VMA）管理 |
| `mmap.rs` | mmap 实现 |
| `page_fault.rs` | 缺页异常处理 |
| `filemap.rs` | 文件映射 |
| `zram.rs` | zRAM 压缩内存 |
| `uaccess.rs` | 用户态内存访问 |
| `kernel_space.rs` | 内核空间映射 |
| `sysctl.rs` | 内存 sysctl 接口 |
| `heap_trace.rs` | 堆追踪诊断 |

### 3. 任务与进程管理 — `os/src/task/`

| 文件 | 内容 |
|------|------|
| `task.rs` (1641行) | 任务控制块（TCB）核心 |
| `process.rs` | 进程控制块（PCB） |
| `processor.rs` | 调度器（单核抢占式） |
| `manager.rs` (2267行) | 任务管理器 |
| `process_manager.rs` | 进程管理器 |
| `elf.rs` | ELF 加载器 |
| `pid.rs` | PID/TID 分配与管理 |
| `threads.rs` | 线程管理 |
| `signal/` | 信号子系统（action/delivery/pending/wait） |
| `sleep.rs` | 睡眠/唤醒机制 |
| `context.rs` | 上下文抽象 |
| `completion.rs` | completion 同步原语 |
| `quota.rs` | 配额管理 |
| `ipc_namespace.rs` | IPC 命名空间 |
| `mount_namespace.rs` | 挂载命名空间 |
| `net_namespace.rs` | 网络命名空间 |
| `perf.rs` | 性能统计 |
| `registry.rs` | 注册表 |

### 4. 系统调用 — `os/src/syscall/`

| 文件 | 内容 |
|------|------|
| `mod.rs` | 系统调用分发入口 |
| `fs.rs` (6794行) | 文件系统相关系统调用 |
| `syscall_id.rs` | 系统调用号定义（约 218 个） |
| `syscall_macro.rs` | 系统调用宏 |
| `errno.rs` | 错误码定义 |
| `flock.rs` | 文件锁 |
| `utils.rs` | 工具函数 |
| `process/` | 进程相关系统调用 |
| `process/ids.rs` | UID/GID 等身份管理 |
| `process/ipc.rs` | SysV IPC（信号量/消息队列/共享内存） |
| `process/clone.rs` | clone/fork 实现 |
| `process/exec.rs` | execve 实现 |
| `process/futex.rs` | futex 实现 |
| `process/signal.rs` | 信号相关系统调用 |
| `process/time.rs` | 时间相关系统调用 |
| `process/mm.rs` | 内存相关系统调用 |
| `process/lifecycle.rs` | 进程生命周期 |
| `process/bpf.rs` | BPF 支持 |
| `process/keyring.rs` | 密钥环 |
| `process/misc.rs` | 其他杂项系统调用 |

### 5. 文件系统 — `os/src/fs/`

| 子目录/文件 | 内容 |
|-------------|------|
| `vfs/` | 虚拟文件系统层（file/inode/mount/dentry_cache/posix_lock/propagation/fcntl/fasync/event） |
| `ext4/` | ext4 文件系统实现（superblock/extent/inode/direntry/balloc/block_group等，约 19 个文件） |
| `fat32/` | FAT32 文件系统实现（layout/fat_inode/dir_iter/bitmap） |
| `tmpfs/` | 内存文件系统（40348 行, 含大量内嵌测试） |
| `ramfs/` | RAM 文件系统 |
| `procfs/` | proc 虚拟文件系统（cpuinfo/meminfo/mounts/stat/pid 等） |
| `sysfs/` | sysfs 虚拟文件系统（含诊断文件 diag.rs） |
| `dev/` | 设备文件系统（null/zero/full/urandom/pipe/pty/tty/block/rtc） |
| `initramfs.rs` | initramfs 支持 |
| `page_cache.rs` | 页面缓存 |
| `reclaim.rs` | 页面回收 |
| `swap.rs` | 交换分区支持 |
| `eventfd.rs` / `eventpoll.rs` / `poll.rs` | 事件通知机制 |
| `timerfd.rs` | 定时器 fd |
| `pidfd.rs` | pidfd 支持 |

### 6. 网络协议栈 — `os/src/net/`

| 子目录/文件 | 内容 |
|-------------|------|
| `adapter.rs` | 网络适配器抽象 |
| `config.rs` | 网络配置 |
| `iface.rs` | 网络接口 |
| `routing.rs` / `neighbour.rs` | 路由与邻居 |
| `net_core.rs` | 核心网络逻辑 |
| `ioctl.rs` | 网络 ioctl |
| `router_device.rs` | 路由设备 |
| `posix.rs` | POSIX 网络接口 |
| `socket/` | 套接字层 |
| `socket/mod.rs` | 套接字核心 |
| `socket/inet/stream/` | TCP 流套接字 |
| `socket/inet/datagram/` | UDP 数据报套接字 |
| `socket/inet/raw/` | RAW 套接字 |
| `socket/unix/stream/` | Unix 域流套接字 |
| `socket/unix/datagram/` | Unix 域数据报套接字 |
| `socket/netlink/` | Netlink 套接字（含 route 子模块） |
| `socket/packet.rs` | Packet 套接字 |
| `syscall/` | 网络系统调用（bind/connect/sendmsg/recvmsg 等 17 个文件） |

### 7. 设备驱动 — `os/src/drivers/`

| 子目录/文件 | 内容 |
|-------------|------|
| `block/` | 块设备驱动（virtio_blk、virtio_blk_pci、sata_blk、mem_blk、block_dev、partition） |
| `net/` | 网络设备驱动（virtio_net、veth） |
| `serial/` | 串口驱动（ns16550a） |

### 8. 用户库 — `user/src/`

| 文件 | 内容 |
|------|------|
| `lib.rs` | 用户库入口（allocator、TLS、panic handler） |
| `syscall.rs` / `syscall.S` | 系统调用封装（17317 行 syscall.rs，含丰富封装） |
| `usr_call.rs` | 用户态辅助调用 |

### 9. 依赖模块 — `dependency/`

| 目录 | 用途 |
|------|------|
| `smoltcp/` | 嵌入式 TCP/IP 协议栈 |
| `virtio-drivers/` | virtio 设备驱动 |
| `riscv/` | RISC-V 架构寄存器定义 |
| `rustsbi/` | RustSBI 引导接口 |
| `dep_pci/pci/` | PCI 总线枚举与配置 |
| `dep_iso/` | 同构驱动（AHCI SATA、e1000/ixgbe 网卡） |

---

## 三、编译构建工具需求

基于对 `Makefile`、`os/make/rv64.mk`、`os/make/la64.mk` 和 `Cargo.toml` 的分析，构建该项目需要以下工具：

| 工具类别 | 具体工具 | 用途 |
|----------|---------|------|
| **Rust 工具链** | `rustup`, `cargo`, `rustc` | 内核与用户程序编译 |
| **RISC-V 工具链** | `nightly-2025-01-18`（RISC-V target: `riscv64gc-unknown-none-elf`） | RISC-V 架构编译 |
| **LoongArch 工具链** | `nightly-2024-05-01`（LoongArch target: `loongarch64-unknown-linux-gnu`） | LoongArch 架构编译 |
| **LLVM 工具** | `rust-objcopy`, `rust-objdump`（来自 `llvm-tools-preview`） | RISC-V ELF 处理 |
| **LoongArch 交叉工具** | `loongarch64-linux-gnu-objcopy`, `loongarch64-linux-gnu-objdump` | LoongArch ELF 处理 |
| **容器** | Docker + `docker compose` | 统一构建环境 |
| **模拟器** | QEMU（`qemu-system-riscv64` / `qemu-system-loongarch64`） | 内核运行 |
| **文件系统工具** | `mkfs.ext4`, `mkfs.vfat`, `dd` | 制作 rootfs 镜像 |
| **固件** | OpenSBI / RustSBI（预编译在 `bootloader/`） | RISC-V SBI 固件 |
| **脚本** | Python 3 | 测试运行与评测 |
| **其他** | `wget`, `xz`, `tar` | 下载测例镜像与 QEMU |

构建流程：顶层 `make all` -> `os/Makefile` 调度 -> 按架构选择 `make/rv64.mk` 或 `make/la64.mk` -> `cargo build` + 用户程序编译 + 文件系统镜像制作。Docker 环境为推荐构建方式，镜像为 `docker.educg.net/cg/os-contest:20250614`。

---

## 四、初步评估总结

该项目是一个较为完整的 Rust 操作系统内核，具有以下特征：

1. **双架构支持**：同时支持 RISC-V 和 LoongArch，HAL 层做架构抽象
2. **子系统覆盖面广**：实现了进程管理、虚拟内存（SV39 + DMW）、多文件系统（ext4/FAT32/tmpfs/ramfs/procfs/sysfs/devfs）、完整网络协议栈（TCP/UDP/Unix/Netlink/Raw/Packet）、SysV IPC、信号、futex、epoll 等
3. **系统调用兼容性**：约 218 个 Linux 兼容系统调用
4. **评测体系完善**：内置 judge 目录含 20+ 评测脚本，覆盖 LTP、libc-test、cyclictest、iperf、netperf、iozone、lmbench 等
5. **代码量**：内核约 55,000 行 Rust，其中 fs/syscall/task 三个子系统占比最大
6. **构建依赖**：以 Docker 容器化构建为主，依赖两个不同版本的 Rust nightly 工具链