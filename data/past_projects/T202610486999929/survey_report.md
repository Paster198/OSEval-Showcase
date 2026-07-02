## Remilia OS 内核项目 —— 初步调查报告

### 一、项目整体结构

```
.
├── Cargo.toml                  # Cargo 工作区根配置
├── Cargo.lock
├── Makefile                    # 比赛测试套件构建与QEMU运行
├── justfile                    # Nix环境下的开发构建与运行
├── flake.nix / flake.lock      # Nix开发环境声明
├── rust-toolchain.toml         # Rust nightly 工具链固定
├── cargo-vendor-config.toml    # 离线vendor配置
├── vendor/                     # 依赖crate的vendor缓存（19个crate）
├── crates/
│   ├── scarlet/                # ★ 内核主crate（binary）
│   │   ├── build.rs            # 链接脚本生成 + initramfs构建
│   │   ├── ext4_rs_fixed/      # 内嵌的ext4文件系统库（fork修复版）
│   │   ├── src/
│   │   │   ├── main.rs         # 内核入口
│   │   │   ├── arch/           # 架构相关代码
│   │   │   ├── mm/             # 内存管理
│   │   │   ├── fs/             # 虚拟文件系统
│   │   │   ├── process/        # 进程与线程管理
│   │   │   ├── sched/          # 调度器
│   │   │   ├── syscall/        # 系统调用
│   │   │   ├── signal/         # POSIX信号
│   │   │   ├── net/            # 网络协议栈
│   │   │   ├── tokei/          # 时钟子系统（时计）
│   │   │   ├── irq/            # 中断请求子系统
│   │   │   ├── smp/            # 多核引导
│   │   │   ├── sync/           # 内核同步原语
│   │   │   ├── trap/           # 陷阱处理
│   │   │   ├── boot/           # 启动信息
│   │   │   ├── initramfs/      # initramfs (cpio) 支持
│   │   │   ├── loader/         # ELF加载器
│   │   │   ├── macros/         # 内核宏
│   │   │   ├── util/           # 工具函数
│   │   │   ├── log.rs          # 日志系统
│   │   │   ├── test.rs         # 内核内测试框架
│   │   │   └── competition.rs  # 比赛相关集成
│   │   └── init-{riscv64,loongarch64}.elf  # 预编译init进程ELF
│   ├── devil/                  # ★ DTB（设备树）解析库（no_std）
│   │   └── src/                # DTB parser (lib.rs + 模块)
│   ├── sakuya/                 # ★ 用户态端到端测试运行器
│   │   ├── src/main.rs         # 编译C测试程序 + QEMU运行 + 判定
│   │   └── tests/              # 测试用例目录
│   └── scarlet-test-macros/    # ★ 内核内测试属性宏
│       └── src/lib.rs          # #[scarlet_test] proc-macro
├── README.md / README.zh-CN.md
├── development-design.pdf      # 开发设计文档
├── development-design.txt
├── remilia_progress_report_detailed.pptx  # 进度报告
└── AGENTS.md                   # AI agent开发指南
```

### 二、各 Crate 职责

| Crate | 类型 | 职责 |
|-------|------|------|
| **scarlet** | binary (内核) | OS内核本体，`#![no_std]` + `#![no_main]`，约36,400行Rust |
| **devil** | library | 零分配DTB（Flattened Device Tree）解析器，`#![no_std]` |
| **sakuya** | binary (host) | 用户态测试运行器：编译C测试->initramfs->QEMU->判定 |
| **scarlet-test-macros** | proc-macro | `#[scarlet_test]` 属性宏，将测试函数注册到 `.scarlet_tests` 段 |

### 三、子系统识别

根据 `crates/scarlet/src` 目录结构和代码内容，内核实现了以下子系统：

| 子系统 | 目录 | 规模（行） | 说明 |
|--------|------|-----------|------|
| **架构层 (arch)** | `arch/{riscv64,loongarch64,shared}` | ~5000+ | RISC-V 64和LoongArch 64双架构支持：上下文切换、页表、陷阱、定时器、控制台、PLIC/EIOINTC中断控制器、VirtIO块/网络设备 |
| **内存管理 (mm)** | `mm/` | ~5000+ | Buddy物理帧分配器、Slab内核堆分配器、页表抽象、MemorySet（地址空间管理）、COW故障处理、TLB shootdown |
| **虚拟文件系统 (fs)** | `fs/` | ~4000+ | VFS抽象（Vnode trait）、Ramfs、Devfs、Procfs、Pipe、ext4适配、ext4挂载、文件描述符表、挂载点管理 |
| **进程管理 (process)** | `process/` | ~1600+ | 进程（Process）：地址空间+文件容器；线程（Thread）：可调度执行上下文、线程状态机、TID分配 |
| **调度器 (sched)** | `sched/` | ~5000+ | 优先级继承、Futex、Robust List、CFS-like公平调度类、RT调度类、Idle调度类 |
| **系统调用 (syscall)** | `syscall/` | ~9000+ | fd操作、IO、内存、进程、调度、信号、socket、poll/epoll、timerfd、time、mount、IPC、stubs等 |
| **网络 (net)** | `net/` | 中等 | 完整TCP/IP协议栈：Ethernet、ARP、IPv4、TCP、UDP、socket层 |
| **信号 (signal)** | `signal/` | ~200+ | POSIX信号（1-31号），bitmask pending/blocked，信号帧save/restore |
| **时钟 (tokei)** | `tokei/` | ~700+ | 三层设计：Clocksource（全局硬件计数器）、Clockevent（per-hart定时器）、Timekeeper（单调纳秒时钟），10ms tick |
| **IRQ子系统** | `irq/` | ~300+ | Linux风格的IRQ域（IrqDomain）、per-IRQ描述符表、IrqChip trait、亲和力设置 |
| **SMP** | `smp/` | ~500+ | 多核拓扑管理，最多8个hart，HartState生命周期 |
| **同步原语 (sync)** | `sync/` | ~400+ | 自研ticket-based自旋锁、IRQ安全变体、TLB shootdown |
| **启动 (boot)** | `boot.rs` + `boot_info.rs` | ~1200+ | DTB解析、VirtIO块设备发现、启动信息收集 |
| **ELF加载器** | `loader/` | ~600+ | 用户程序ELF加载 |
| **initramfs** | `initramfs/` | 小 | CPIO newc格式支持 |
| **日志** | `log.rs` | 小 | 多通道日志系统 |

### 四、目标架构

- **RISC-V 64** (`riscv64gc-unknown-none-elf`)：Sv39 MMU、OpenSBI、VirtIO MMIO设备
- **LoongArch 64** (`loongarch64-unknown-none`)：LA64 MMU、VirtIO PCI设备

### 五、构建工具链

**编译该内核需要使用以下工具：**

| 工具 | 用途 | 来源 |
|------|------|------|
| Rust nightly 工具链 | 编译所有Rust代码（需`#![feature(...)]`） | `rust-toolchain.toml`固定 |
| Cargo | 构建管理，`--offline`模式使用vendor | Rust工具链自带 |
| riscv64gc-unknown-none-elf target | RISC-V裸机目标 | rustup |
| loongarch64-unknown-none target | LoongArch裸机目标 | rustup |
| QEMU (riscv64 & loongarch64) | 模拟运行 | 系统包管理器或Nix |
| Nix (可选) | 可复现开发环境 | Nix包管理器 |

**构建命令（来自`justfile`和`Makefile`）：**

```
# 开发构建
just build              # cargo build --release --target riscv64gc-unknown-none-elf
just run                # 构建+QEMU运行

# Makefile目标
make all                # 构建kernel-rv + kernel-la
make qemu ARCH=riscv64  # QEMU运行（默认riscv64，可选loongarch64）
```

**关键依赖crate（vendor目录）：**
`spin`、`riscv`、`loongArch64`、`qemu-exit`、`bitflags`、`log`、`lock_api`、`critical-section`等19个。

**特殊构建产物：**
- `build.rs`在编译时生成：链接脚本（`linker.ld`）、initramfs CPIO镜像（内嵌预编译init ELF）
- `ext4_rs_fixed/`：内嵌的ext4文件系统库（从上游fork并修复），作为本地依赖直接编译

### 六、初步判断

1. **项目成熟度较高**：160+个源文件、约46000行Rust代码（仅scarlet crate），覆盖了从启动到网络协议的完整OS内核栈。

2. **双架构支持**：通过清晰的 `arch/{riscv64,loongarch64,shared}` 分层实现了RISC-V和LoongArch双架构，共享层抽取得当。

3. **完整的Linux兼容层意图**：系统调用覆盖广泛（fd、socket、poll/epoll、timerfd、futex、信号等），procfs提供了`/proc/{pid}/maps`、`/proc/{pid}/stat`等，显然以运行Linux用户程序为目标。

4. **自研组件较多**：自旋锁、调度器、IRQ子系统、时钟子系统均为自研实现，而非简单包装外部crate。

5. **比赛导向**：存在`competition.rs`、预编译init ELF、Makefile中的测试套件集成、sakuya端到端测试运行器等，表明该项目为OS内核比赛设计。