## 项目结构初步调查报告

### 一、仓库基本信息

该项目名为 **Project Aurora（极光内核）**，是一个面向 OS 竞赛内核赛道的 Rust 组件化操作系统内核。使用 Rust workspace 组织，基于 RISC-V64 架构，运行于 QEMU virt 平台。

- **工具链**：Rust 1.75.0 (stable)，目标三元组 `riscv64gc-unknown-none-elf`，使用 `rust-lld` 作为链接器
- **构建系统**：Cargo workspace + GNU Make（顶层 `Makefile` 作为统一入口）
- **许可证**：见 `LICENSE` 文件

---

### 二、目录结构总览

```
.
├── Cargo.toml                  # Rust workspace 根配置
├── Cargo.lock
├── Makefile                    # 统一构建/运行/测试入口
├── rust-toolchain.toml         # Rust 工具链版本固定
├── .cargo/config.toml          # Cargo 目标配置(linker script等)
├── arch/
│   └── riscv64/                # 架构相关汇编文件
│       ├── entry.S             # 内核启动入口 (_start)
│       ├── trap.S              # trap 处理汇编入口
│       ├── context.S           # 上下文切换汇编
│       └── linker.ld           # 链接脚本 (基址 0x80200000)
├── modules/                    # 内核服务模块
│   ├── axruntime/              # 内核运行时（核心调度/进程/内存/系统调用等）
│   ├── axfs/                   # 文件系统实现（ext4/FAT32/devfs/procfs/memfs）
│   └── axnet/                  # 网络栈封装（smoltcp 适配层）
├── crates/
│   └── axvfs/                  # VFS 抽象层（trait 与共享类型定义）
├── apps/                       # 用户态测试/演示程序
│   ├── shell/                  # 交互式 shell
│   ├── tcp_echo/               # TCP echo 测试
│   ├── udp_echo/               # UDP echo 测试
│   ├── fs_smoke/               # 文件系统冒烟测试
│   └── net_bench/              # 网络性能基准测试
├── scripts/                    # 构建/运行/测试/辅助脚本（20个）
├── tools/                      # 提交物导出、ELF 构造等工具
├── tests/self/                 # 自测用例
├── docs/                       # 设计文档与开发过程记录
│   ├── design/                 # 子模块设计文档（11篇）
│   └── process/                # 开发周志、调试报告等
├── build_env/                  # 构建环境说明与依赖列表
└── platforms/
    └── qemu-riscv64/           # 平台 README
```

---

### 三、子系统初步识别

#### 1. 启动与基础设施 (Bootstrap)
| 相关文件 | 说明 |
|---|---|
| `arch/riscv64/entry.S` | 内核入口 `_start`：关中断、清零 BSS、设栈、跳转 `rust_main` |
| `arch/riscv64/linker.ld` | 链接脚本，基址 `0x80200000`，输出 `.text/.rodata/.data/.bss` |
| `modules/axruntime/src/main.rs` | Rust 入口 `rust_main`，依次初始化各子系统 |
| `modules/axruntime/src/console.rs` | 基于 SBI 的控制台输出 |
| `modules/axruntime/src/sbi.rs` | SBI ecall 封装（console putchar、shutdown） |
| `modules/axruntime/src/dtb.rs` | 设备树解析，提取内存、UART、virtio、PLIC 信息 |

#### 2. 内存管理 (MM)
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/mm.rs` (~1379行) | Sv39 页表管理，物理/虚拟地址映射，用户页映射，CoW 缺页处理 |

#### 3. Trap 与中断
| 相关文件 | 说明 |
|---|---|
| `arch/riscv64/trap.S` | Trap 底层汇编入口与返回 |
| `modules/axruntime/src/trap.rs` (~389行) | Trap 分发、TrapFrame 定义、中断控制 |
| `modules/axruntime/src/plic.rs` | PLIC 中断控制器驱动 |

#### 4. 进程与任务管理
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/task.rs` (~378行) | 任务控制块 (TCB)、任务状态、任务表 |
| `modules/axruntime/src/scheduler.rs` | RunQueue 就绪队列、轮询调度 |
| `modules/axruntime/src/runtime.rs` (~666行) | 运行时核心：tick 计数、调度钩子、idle loop、任务切换 |
| `modules/axruntime/src/context.rs` | CPU 上下文保存/恢复 |
| `modules/axruntime/src/process.rs` (~225行) | 进程表、wait/exit 逻辑、僵尸进程回收 |
| `modules/axruntime/src/stack.rs` | 内核栈分配与管理 |

#### 5. 系统调用 (Syscall)
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/syscall.rs` (~6416行) | 系统调用分发与实现，覆盖文件/网络/进程/内存/futex 等 |

#### 6. 用户态支持
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/user.rs` (~852行) | 用户镜像 ELF 加载、用户地址空间构造 |
| `apps/` 下各目录 | 用户态测试程序（裸机 `#![no_std]`，通过 `ecall` 发起系统调用） |

#### 7. 同步原语
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/futex.rs` | Futex 实现 |
| `modules/axruntime/src/wait.rs` + `wait_queue.rs` | 等待队列 |
| `modules/axruntime/src/sleep.rs` + `sleep_queue.rs` | 睡眠队列 |
| `modules/axruntime/src/task_wait_queue.rs` | 任务级等待队列 |

#### 8. 文件系统
| 相关文件 | 说明 |
|---|---|
| `crates/axvfs/src/lib.rs` | VFS 接口定义：`VfsOps` trait、`FileOps` trait、`DirEntry`、`Metadata` 等 |
| `modules/axfs/src/lib.rs` | 文件系统模块聚合 |
| `modules/axfs/src/block.rs` | 块设备抽象与写回缓存 |
| `modules/axfs/src/ext4.rs` (~2585行) | ext4 实现（挂载、目录查找、extent 读写） |
| `modules/axfs/src/fat32.rs` (~1457行) | FAT32 实现 |
| `modules/axfs/src/devfs.rs` | 设备文件系统 |
| `modules/axfs/src/procfs.rs` | proc 文件系统 |
| `modules/axfs/src/memfs.rs` | 内存文件系统 |
| `modules/axfs/src/mount.rs` | 挂载点与挂载表管理 |
| `modules/axruntime/src/fs.rs` | 根文件系统初始化，内存盘/块设备选择 |
| `modules/axruntime/src/virtio_blk.rs` (~526行) | VirtIO 块设备 MMIO 驱动 |

#### 9. 网络
| 相关文件 | 说明 |
|---|---|
| `modules/axnet/src/lib.rs` | 网络栈接口：`NetDevice` trait、`AxSocket`、错误类型 |
| `modules/axnet/src/smoltcp_impl.rs` (~1463行) | 基于 smoltcp 0.10 的协议栈实现（TCP/UDP/ARP/socket API） |
| `modules/axruntime/src/virtio_net.rs` (~556行) | VirtIO 网卡 MMIO 驱动 |

#### 10. 异步执行器
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/async_exec.rs` | 最小无堆异步执行器（固定 16 槽位） |

#### 11. 定时器与时钟
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/time.rs` | 时钟初始化与 tick 管理 |

#### 12. CPU 辅助
| 相关文件 | 说明 |
|---|---|
| `modules/axruntime/src/cpu.rs` | CPU 辅助（WFI 等） |

---

### 四、构建工具需求

根据 `build_env/apt-deps.txt` 和构建脚本分析，构建该项目需要：

| 工具 | 用途 |
|---|---|
| **Rust 工具链 (1.75.0)** | 编译内核与用户程序，需安装 `rust-src`、`rustfmt`、`clippy`、`llvm-tools-preview` |
| **rustup target `riscv64gc-unknown-none-elf`** | RISC-V 裸机目标 |
| **build-essential** | 宿主编译基础工具（GCC 等） |
| **clang / lld** | 编译器基础设施（部分依赖） |
| **qemu-system-riscv64** | 模拟运行 (`make run`、测试) |
| **gdb-multiarch** | 多架构调试 (`make gdb`) |
| **Python 3** | 辅助脚本（如 `tools/build_init_elf.py`、`scripts/net_perf_send.py`） |
| **Git** | 版本管理与脚本依赖 |

构建流程为：`cargo build -p axruntime --target riscv64gc-unknown-none-elf`，由 `scripts/build.sh` 驱动，支持多种 feature flag 切换（`user-test`、`user-shell`、`sched-demo`、`ext4-write-test`、`net-loopback-test`、`user-tcp-echo`、`user-udp-echo`、`user-fs-smoke`）。

---

### 五、代码规模概览

| 模块/目录 | 代码行数（近似） |
|---|---|
| `axruntime` (内核主体) | ~13,343 行 Rust |
| `axfs` (文件系统) | ~5,387 行 Rust |
| `axnet` (网络栈) | ~1,510 行 Rust |
| `axvfs` (VFS 抽象) | ~147 行 Rust |
| `arch/riscv64` (汇编) | ~299 行汇编 |
| **内核总计** | **~20,686 行** |
| `apps/` (用户态程序) | 5 个用户程序，各自 ~数百行 |

最大的两个文件是 `syscall.rs` (~6416行) 和 `ext4.rs` (~2585行)，分别承载系统调用分发/实现和 ext4 文件系统逻辑。

---

### 六、总结

Project Aurora 是一个面向 RISC-V64 QEMU 平台的 Rust 宏内核项目，已实现以下主要子系统：

- **启动与基础设施**：OpenSBI → 内核入口 → DTB 解析 → 各子系统初始化
- **内存管理**：Sv39 页表、CoW、用户页映射
- **任务/进程管理**：TCB、RunQueue、进程表、wait/exit、futex
- **系统调用**：类 Linux ABI（覆盖文件、网络、进程、内存等）
- **文件系统**：VFS 抽象层 + ext4/FAT32/devfs/procfs/memfs 多后端 + virtio-blk 驱动
- **网络**：smoltcp 协议栈适配 + virtio-net 驱动
- **异步执行器**：最小无堆协作式调度
- **用户态支持**：ELF 加载 + 5 个用户态冒烟/测试程序