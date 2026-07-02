## 项目初步调查结果

### 一、项目概况

该项目名为 **Chronix**，是华中科技大学队伍"跟我做一辈子OS"参加 2026 年全国大学生计算机系统能力大赛 OS 内核实现赛道的提交仓库。项目基于 2025 年大赛一等奖项目 Chronix 整理适配，使用 Rust 编写，目标为 RISC-V 64 与 LoongArch 64 双架构宏内核。

### 二、顶层文件组织结构

```
.
├── Cargo.toml              # Rust workspace 根配置
├── Cargo.lock              # 依赖锁定文件
├── Makefile                # 顶层构建入口（make all 生成内核+磁盘镜像）
├── Makefile.sub            # 被 Makefile 引用的子 Makefile
├── rust-toolchain.toml     # Rust 工具链配置（nightly-2025-01-18）
├── Dockerfile              # 容器构建环境
├── README.md               # 项目说明
├── BASELINE.md             # 基线声明
├── 注意事项.md              # 比赛注意事项
├── LICENSE                 # GPLv3 许可证
│
├── os/                     # 内核主 crate
│   ├── Cargo.toml
│   ├── src/                # 内核源码
│   └── cargo/              # cargo 配置模板
│
├── hal/                    # 硬件抽象层 crate
│   ├── Cargo.toml
│   ├── build.rs
│   ├── src/                # HAL 源码
│   ├── hal-marco/          # HAL 过程宏子 crate
│   └── cargo/              # cargo 配置模板
│
├── user/                   # 用户态程序 crate
│   ├── Cargo.toml
│   ├── Makefile
│   ├── src/bin/            # 用户程序二进制入口
│   └── cargo/
│
├── utils/                  # 工具 crate
│   ├── range-map/          # 区间映射数据结构
│   └── segment-tree/       # 线段树数据结构
│
├── mk/                     # Makefile 片段（被 Makefile.sub 引用）
│   ├── config.mk           # 构建参数配置
│   ├── kernel.mk           # 内核构建规则
│   ├── fs.mk               # 文件系统镜像构建规则
│   ├── qemu.mk             # QEMU 运行与调试规则
│   ├── user.mk             # 用户程序构建规则
│   ├── tests.mk            # 测试规则
│   └── utils.mk            # 工具规则
│
├── scripts/                # 辅助脚本
│   ├── run-rv-oj.sh        # RISC-V 评测运行脚本
│   ├── run-la-oj.sh        # LoongArch 评测运行脚本
│   ├── run-ltp-rv.sh       # RISC-V LTP 测试脚本
│   ├── run-ltp-la.sh       # LoongArch LTP 测试脚本
│   ├── host_client.py      # 宿主机通信客户端
│   ├── vendor.sh           # vendor 依赖处理
│   └── archive.sh          # 归档脚本
│
├── etc/                    # 系统配置文件（passwd, hosts, nsswitch.conf 等）
├── docs/                   # 文档
│   ├── LTP.md              # LTP 测试说明
│   └── assets/             # 架构图等资源
│
├── cargo/                  # cargo 全局配置（构建时复制为 .cargo）
├── testcase.tar.xz         # 测试用例压缩包
├── vendor.tar.xz           # vendored 依赖压缩包
├── qemu-riscv64.dts        # RISC-V QEMU 设备树源文件
├── qemu-loongarch64.dts    # LoongArch QEMU 设备树源文件
└── vf2.dts                 # StarFive VisionFive2 设备树
```

### 三、子系统划分

依据各目录和源文件，内核子系统划分如下：

#### 1. 硬件抽象层（HAL） — `hal/src/`

| 组件 | 路径 | 说明 |
|------|------|------|
| 地址空间 | `hal/src/component/addr/` | 虚拟地址/物理地址抽象，分 RISC-V 和 LoongArch 实现 |
| 控制台 | `hal/src/component/console/` | 串口输出，含 UART 驱动 |
| 常量定义 | `hal/src/component/constant/` | 架构常量（内核栈大小、地址空间布局等） |
| 内核入口 | `hal/src/component/entry/` | 内核启动入口（`_start`），分架构实现 |
| 指令封装 | `hal/src/component/instruction/` | 特权指令封装（如 sfence.vma、hart 管理） |
| 中断控制器 | `hal/src/component/irq/` | PLIC（RISC-V）、EIOINTC/PLATIC（LoongArch） |
| 页表 | `hal/src/component/pagetable/` | 页表操作（映射、查询、遍历） |
| 信号帧 | `hal/src/component/signal/` | 信号栈帧处理，分架构 |
| 时钟 | `hal/src/component/timer/` | 时钟中断设置与读取 |
| 陷阱 | `hal/src/component/trap/` | 陷阱入口与上下文保存/恢复 |
| 平台 | `hal/src/board/` | 板级支持（设备树解析、内存布局），含 QEMU 与 VF2 |
| 接口 | `hal/src/interface/` | 分配器接口、MMIO 映射接口 |
| 工具 | `hal/src/util/` | 互斥锁、位域、回溯等 |

#### 2. 进程与调度 — `os/src/processor/`、`os/src/task/`、`os/src/executor/`

- **处理器管理** (`processor/`)：per-CPU 结构，上下文切换（`context.rs`）
- **任务管理** (`task/`)：TaskControlBlock（进程/线程控制块）、PID/TID 分配、进程组、文件描述符表、调度器
- **协程执行器** (`executor/`)：基于 `async-task` 的无栈协程运行时，支持 SMP 负载均衡

#### 3. 内存管理 — `os/src/mm/`

- **帧分配器** (`allocator/frame_allocator.rs`)：物理页帧分配
- **堆分配器** (`allocator/heap_allocator.rs`)：内核堆（基于 buddy system）
- **SLAB 分配器** (`allocator/slab_allocator.rs`)：内核对象缓存
- **页表** (`page_table.rs`)：页表逻辑封装
- **用户虚拟内存** (`vm/uvm.rs`)：用户地址空间管理（按需加载、写时复制、懒分配）
- **内核虚拟内存** (`vm/kvm/`)：内核地址空间动态映射（分 RISC-V 和 LoongArch）

#### 4. 文件系统 — `os/src/fs/`

- **VFS** (`vfs/`)：虚拟文件系统层（dentry、inode、file、superblock、fstype），含路径缓存（DCACHE）
- **Ext4** (`ext4/`)：基于 `lwext4_rust` 的 Ext4 文件系统
- **FAT32** (`fat32/`)：基于 `fatfs` 的 FAT32 文件系统
- **tmpfs** (`tmpfs/`)：内存文件系统
- **devfs** (`devfs/`)：设备文件系统（/dev/null、/dev/zero、/dev/tty、/dev/urandom 等）
- **procfs** (`procfs/`)：进程文件系统（/proc/cpuinfo、/proc/meminfo、/proc/mounts、/proc/self/ 等）
- **pipefs** (`pipefs.rs`)：管道文件系统
- **页缓存** (`page/`)：文件页缓存（page cache）
- **通用工具** (`utils.rs`、`fs.rs`)

#### 5. 系统调用 — `os/src/syscall/`

按功能划分的 syscall 实现模块：

| 文件 | 涵盖范围 |
|------|----------|
| `mod.rs` | syscall 分发、ID 枚举（包含 300+ 个 syscall 编号） |
| `process.rs` | 进程/线程管理（clone、execve、wait、exit 等） |
| `fs.rs` | 文件系统操作（open、read、write、mkdir、mount 等） |
| `mm.rs` | 内存管理（mmap、munmap、brk、mremap 等） |
| `io.rs` | I/O 多路复用（select、poll、epoll 等） |
| `net.rs` | 网络（socket、bind、listen、accept、sendto 等） |
| `signal.rs` | 信号（sigaction、sigreturn、kill、tkill 等） |
| `time.rs` | 时间（clock_gettime、nanosleep、timerfd 等） |
| `futex.rs` | futex 机制 |
| `sche.rs` | 调度（sched_yield、nice、getpriority 等） |
| `fd.rs` | 文件描述符（dup、fcntl、eventfd 等） |
| `misc.rs` | 杂项（uname、reboot、syslog 等） |
| `reboot.rs` | 重启相关 |
| `ipc/` | IPC 系统调用分发 |

#### 6. 网络 — `os/src/net/`

- **TCP** (`tcp.rs`)：TCP 协议实现（基于 smoltcp）
- **UDP** (`udp.rs`)：UDP 协议实现
- **Socket** (`socket.rs`)：socket 抽象层
- **地址** (`addr.rs`)：网络地址管理
- **监听表** (`listen_table.rs`)：端口监听
- **加密** (`crypto.rs`)：网络加密（AES-GCM、Salsa20、SHA2、HMAC）
- **Raw socket** (`raw.rs`)：原始套接字
- **Socketpair** (`socketpair.rs`)：socketpair 机制

#### 7. 设备驱动 — `os/src/drivers/`、`os/src/devices/`

- **块设备**：virtio-blk（分 RISC-V/LoongArch）、MMC/SDIO、PCI 块设备、MMIO 块设备
- **网络设备**：virtio-net、loopback
- **串口**：UART 驱动
- **DMA**：分架构实现
- **设备管理**：PCI 总线、MMIO、PLIC 中断控制器、SDIO、缓冲区缓存

#### 8. 信号 — `os/src/signal/`

- 信号动作 (`action.rs`)
- 信号处理 (`handler.rs`)
- 信号管理器 (`manager.rs`)
- 消息队列 (`msg_queue.rs`)

#### 9. IPC — `os/src/ipc/`

- System V 共享内存 (`sysv/shm.rs`)

#### 10. 同步原语 — `os/src/sync/`

- 自旋互斥锁 (`mutex/spin_mutex.rs`)
- 自旋读写锁 (`mutex/spin_rw_mutex.rs`)
- UP-safe 单元 (`up.rs`)
- 惰性初始化 (`lazy.rs`)

#### 11. 时钟与定时器 — `os/src/timer/`

- 时钟 (`clock.rs`)
- 定时器 (`timer.rs`)
- 定时任务 (`timed_task.rs`)
- 时间记录器 (`recoder.rs`)

#### 12. 陷阱处理 — `os/src/trap/`

- 统一的异常/中断入口和分发逻辑

#### 13. 工具 — `os/src/utils/`、`utils/`

- 区间映射 (`utils/range-map`)
- 线段树 (`utils/segment-tree`)
- 异步工具 (`os/src/utils/async_utils.rs`)
- 环形缓冲区 (`os/src/utils/ring_buffer.rs`)
- 路径解析 (`os/src/utils/path.rs`)
- 字符串工具 (`os/src/utils/string.rs`)

#### 14. 用户程序 — `user/src/bin/`

- `initproc.rs`：初始化进程
- `shell.rs` / `user_shell.rs`：Shell
- `autotest.rs`：自动测试
- `tcp.rs` / `udp.rs` / `virtnet.rs`：网络测试
- `test_shm.rs`：共享内存测试
- `test_sig1.rs`：信号测试
- `test_cow.rs`：写时复制测试
- `test_mremap.rs`：mremap 测试
- `float_test.rs`：浮点测试
- `hello_world.rs` / `echo.rs` / `brk_write.rs`：基础功能测试

### 四、构建工具需求

根据 `Makefile`、`Makefile.sub`、`rust-toolchain.toml` 及各 `.mk` 文件分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| Rust nightly-2025-01-18 | 编译工具链 |
| `rust-src` 组件 | 内核构建所需 |
| `llvm-tools` 组件 | 提供 llvm 工具链 |
| `cargo-binutils`（rust-objcopy、rust-objdump） | 二进制处理 |
| `riscv64gc-unknown-none-elf` target | RISC-V 交叉编译 |
| `loongarch64-unknown-none` target | LoongArch 交叉编译 |
| GNU Make | 构建编排 |
| QEMU（qemu-system-riscv64 / qemu-system-loongarch64） | 模拟运行 |
| `mkimage`（U-Boot tools） | 生成 zImage（可选） |
| Device Tree Compiler（dtc） | 设备树编译（开发用） |
| 磁盘工具（mkfs.ext4、mkfs.vfat、dd、mcopy、losetup） | 制作磁盘镜像 |
| Python 3 | 辅助脚本（host_client.py 等） |
| Git、tar、gzip、xz | 源码与 vendor 管理 |

构建入口为根目录的 `make all`，产出物为：
- `kernel-rv`：RISC-V 64 内核 ELF
- `kernel-la`：LoongArch 64 内核 ELF
- `disk-rv.img`：RISC-V 磁盘镜像
- `disk-la.img`：LoongArch 磁盘镜像