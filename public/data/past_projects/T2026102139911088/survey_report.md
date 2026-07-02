## HITOS 项目初步调查报告

### 一、项目概览

HITOS 是一个基于 Rust 语言开发的 OS 内核项目，采用 Cargo workspace 组织，支持 **RISC-V 64** 和 **LoongArch 64** 两种指令集架构。内核总代码量约 11 万行（Rust + 少量汇编），定位为一个兼容 Linux 系统调用接口的宏内核。

---

### 二、仓库文件组织结构

```
T2026102139911088/repo/
├── Cargo.toml              # workspace 配置，包含 4 个成员
├── Makefile                 # 顶层 Makefile：构建、运行、Docker 入口
├── README.md
├── HITOS_doc.pdf / .txt     # 项目文档
├── .gitignore
├── cargo-config/            # 交叉编译 cargo 配置
│   ├── config.toml          # RISC-V 配置
│   ├── config_loongarch64.toml
│   └── root-config.toml
├── os/                      # 【内核主模块】~110K 行
│   ├── Cargo.toml
│   ├── Makefile             # 内核级 Makefile
│   ├── build.rs             # 构建脚本（生成 link_app.asm）
│   ├── src/
│   │   ├── main.rs / lib.rs     # 内核入口
│   │   ├── entry.asm / entry_loongarch.S  # 启动入口汇编
│   │   ├── linker.ld / linker_loongarch.ld
│   │   ├── arch/            # 架构相关
│   │   ├── syscall/         # 系统调用实现
│   │   ├── task/            # 进程/任务管理
│   │   ├── fs/              # 虚拟文件系统
│   │   ├── mm/              # 内存管理
│   │   ├── net/             # 网络栈封装
│   │   ├── bpf/             # BPF 子系统
│   │   ├── drivers/         # 设备驱动
│   │   ├── trap/            # 陷阱分发
│   │   ├── console/         # 控制台输出
│   │   ├── sbi/             # RISC-V SBI 接口
│   │   └── utils/           # 工具模块
│   └── tools/
├── user/                    # 【用户态程序】~11K 行
│   ├── Cargo.toml
│   ├── build.rs / build.py
│   └── src/
│       ├── lib.rs           # 用户库入口
│       ├── syscall/         # 用户态 syscall 封装
│       └── bin/             # 用户程序
│           ├── 00shell.rs / shell/       # Shell
│           ├── init_proc.rs              # init 进程
│           ├── cat.rs, ls.rs, ps.rs ...  # 常用工具
│           ├── ltp_dependence/           # LTP 测试框架适配
│           ├── lmbench_dependence/       # LMBench 适配
│           └── *_smoke.rs               # 各种冒烟测试
├── ext4-fs/                 # 【ext4 文件系统库】~3.5K 行 (no_std)
│   ├── Cargo.toml
│   └── src/                 # ext4 读取、VFS、块缓存
├── ext4-fs-packer/          # 【ext4 镜像打包工具】(host binary)
│   ├── Cargo.toml
│   ├── src/main.rs
│   ├── extra/               # 通用 extra 文件
│   ├── extra-riscv64/       # RISC-V 架构 LTP 补丁
│   └── extra-loongarch64/   # LoongArch 架构 LTP 补丁
├── vendor/                  # 【vendored 第三方库】
│   ├── smoltcp/             # 网络协议栈（下游修改版）
│   ├── virtio-drivers/      # VirtIO 驱动
│   ├── virtio-drivers-pci/  # VirtIO PCI 传输层
│   └── cargo-vendor/        # 167 个 crates 的离线缓存
└── img/                     # 预构建基础磁盘镜像 (.tar.xz)
```

---

### 三、子系统划分

| 子系统 | 代码量 | 所在目录 | 职责 |
|--------|--------|----------|------|
| **系统调用** | ~60K 行 / 81 文件 | `os/src/syscall/` | Linux 兼容系统调用接口：文件系统、内存、进程、信号、网络、POSIX MQ、SysV IPC、futex、epoll、调度等 |
| **虚拟文件系统** | ~21K 行 / 27 文件 | `os/src/fs/` | VFS 层：ext4 inode、procfs、cgroupfs、pipe、eventfd、timerfd、pidfd、fanotify、socket、tty、stdio、挂载命名空间 |
| **任务/进程管理** | ~11K 行 / 22 文件 | `os/src/task/` | 进程控制块、PID 分配、运行队列、公平/实时调度、互斥锁/条件变量/信号量、信号处理、阻塞睡眠 |
| **内存管理** | ~8.7K 行 / 16 文件 | `os/src/mm/` | 帧分配器、堆分配器、页表（架构分派）、VMA/mmap、缺页处理、ELF 加载器、DTB 解析 |
| **架构层** | ~4.5K 行 / 22 文件 | `os/src/arch/` | RISC-V 与 LoongArch 的 trap 处理、页表、任务上下文、ASID、CSR 定义 |
| **网络栈** | ~750 行 / 2 文件 | `os/src/net/` | 基于 smoltcp 的 per-namespace 网络栈、回环设备 |
| **BPF** | ~1.4K 行 / 7 文件 | `os/src/bpf/` | cBPF/eBPF 程序、map、运行时、验证器 |
| **块设备驱动** | ~662 行 / 3 文件 | `os/src/drivers/` | VirtIO 块设备驱动 |
| **控制台** | ~84 行 | `os/src/console/` | 串口输出 |
| **SBI 接口** | ~164 行 | `os/src/sbi/` | RISC-V SBI 调用封装 |
| **工具** | ~187 行 | `os/src/utils/` | ID 分配器 |
| **ext4 文件系统** | ~3.5K 行 | `ext4-fs/` | ext4 读取实现（no_std），块缓存、extent 支持 |
| **用户态程序** | ~11K 行 | `user/` | Shell、常用工具、LTP/lmbench 测试框架适配、冒烟测试 |
| **镜像打包** | ~3K 行 | `ext4-fs-packer/` | 基于 mke2fs 的 ext4 镜像制作工具 |

---

### 四、构建工具需求

根据 `Makefile` 和 `build.rs` 分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| **Rust 工具链** (rustc, cargo) | 编译内核、用户程序、ext4 库、打包工具 |
| **RISC-V 交叉编译 target** (`riscv64gc-unknown-none-elf`) | RISC-V 架构内核编译 |
| **LoongArch 交叉编译 target** (`loongarch64-unknown-none`) | LoongArch 架构内核编译 |
| **GNU Make** | 构建流程编排 |
| **QEMU** (`qemu-system-riscv64` / `qemu-system-loongarch64`) | 模拟运行 |
| **rust-objcopy / llvm-objcopy** (可选) | 从 ELF 提取 raw binary |
| **mke2fs** (e2fsprogs) | ext4 镜像制作（由 ext4-fs-packer 调用） |
| **Docker** (可选) | 通过 `make start-docker` 进入官方构建容器 |

关键依赖 crates（均已 vendor）：smoltcp、virtio-drivers、buddy_system_allocator、spin、lazy_static、xmas-elf、fdt，以及 WireGuard 加密相关（blake2、chacha20poly1305、x25519-dalek）。

---

### 五、初步判断

1. **架构定位**：该项目是一个面向 Linux 兼容的宏内核，系统调用接口覆盖面广（文件系统、网络、进程、信号、IPC 等），远超教学 OS 的范畴。

2. **双架构支持**：RISC-V 和 LoongArch 均有完整的 trap 处理、页表和任务上下文实现，RISC-V 侧额外支持多核启动（SBI HSM）。

3. **文件系统**：自研 ext4 只读实现（~3.5K 行），VFS 层提供了 procfs、cgroupfs、pipe、eventfd、timerfd 等丰富的伪文件系统和特殊文件类型。

4. **网络**：基于下游修改版 smoltcp，支持 TCP/UDP、Unix socket、netlink、WireGuard，支持网络命名空间。

5. **测试体系**：用户态集成了 LTP 和 LMBench 测试框架适配，以及大量冒烟测试用例，表明项目经过了较为系统的兼容性验证。