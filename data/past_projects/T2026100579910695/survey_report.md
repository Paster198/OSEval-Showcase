## Chronix OS 内核项目初步调查

### 1. 项目概况

**Chronix** 是一个使用 Rust 语言实现的宏内核操作系统，支持 **RISC-V 64** 和 **LoongArch 64** 两种硬件架构。项目采用 Rust Workspace 管理多个 crate，共包含约 **248 个 Rust 源文件**、约 **45,000 行代码**。

---

### 2. 仓库文件组织结构

```
repo/
├── os/                          # 内核核心 crate
│   └── src/
│       ├── main.rs              # 内核入口点
│       ├── banner.rs            # 启动 banner
│       ├── config.rs            # 配置
│       ├── lang_items.rs        # Rust 语言项（no_std 环境支持）
│       ├── linker-*.ld          # 链接脚本 (RISC-V / LoongArch)
│       ├── devices/             # 设备管理层
│       ├── drivers/             # 驱动管理层
│       ├── executor/            # 异步任务执行器
│       ├── fs/                  # 文件系统子系统
│       ├── ipc/                 # 进程间通信 (SysV)
│       ├── mm/                  # 内存管理子系统
│       ├── net/                 # 网络子系统 (TCP/UDP/IP)
│       ├── processor/           # 处理器管理 (多核支持)
│       ├── signal/              # 信号子系统
│       ├── sync/                # 同步原语
│       ├── syscall/             # 系统调用层
│       ├── task/                # 任务/进程管理
│       ├── timer/               # 定时器子系统
│       ├── trap/                # 陷阱/中断处理
│       └── utils/               # 内核工具函数
├── hal/                         # 硬件抽象层 crate
│   ├── hal-marco/               # HAL 派生宏
│   └── src/
│       ├── board/               # 板级支持 (dtbs/)
│       ├── component/           # 架构组件抽象
│       │   ├── addr/            #   地址抽象
│       │   ├── console/         #   控制台/UART
│       │   ├── constant/        #   架构常量
│       │   ├── entry/           #   内核入口
│       │   ├── instruction/     #   指令封装
│       │   ├── irq/             #   中断抽象
│       │   ├── pagetable/       #   页表操作
│       │   ├── signal/          #   信号处理
│       │   ├── timer/           #   时钟抽象
│       │   └── trap/            #   陷阱处理
│       ├── interface/           # 接口定义 (allocator, mapper)
│       └── util/                # HAL 工具 (backtrace, mutex, bitfield)
├── user/                        # 用户库与用户程序 crate
│   └── src/
│       ├── bin/                 # 用户程序 (shell, initproc, 测试程序等)
│       ├── lib.rs               # 用户库 (_start 入口)
│       ├── syscall.rs           # 系统调用封装
│       └── console.rs           # 控制台 I/O
├── utils/                       # 独立工具 crate
│   ├── range-map/               #   区间映射数据结构
│   └── segment-tree/            #   线段树数据结构
├── ext4fs/                      # ext4 文件系统子模块 (git submodule, 空目录)
├── mk/                          # Makefile 构建模块
│   ├── config.mk                #   构建参数配置
│   ├── kernel.mk                #   内核构建规则
│   ├── fs.mk                    #   磁盘镜像构建规则
│   ├── qemu.mk                  #   QEMU 模拟运行配置
│   ├── user.mk                  #   用户程序构建规则
│   ├── tests.mk                 #   测试相关规则
│   └── utils.mk                 #   构建辅助函数
├── scripts/                     # 辅助脚本
│   ├── run-*-oj.sh              #   在线评测执行脚本
│   ├── run-ltp-*.sh             #   LTP 测试执行脚本
│   └── archive.sh / vendor.sh   #   归档/解压脚本
├── docs/                        # 项目文档与优化指南
├── etc/                         # 系统配置文件 (passwd, group, hosts 等)
├── attach/                      # 附加资源 (busybox git, 动态库等)
├── cargo/                       # Cargo 构建配置模板
├── sdcard-la.img                # LoongArch SD 卡镜像
├── testcase.tar.xz              # 测试用例压缩包
├── vendor.tar.xz                # 第三方依赖压缩包
├── *.dts                        # 设备树源文件
├── Dockerfile                   # Docker 构建环境
├── Makefile / Makefile.sub      # 顶层构建入口
├── Cargo.toml / Cargo.lock      # Rust workspace 配置
└── rust-toolchain.toml          # Rust 工具链配置 (nightly)
```

---

### 3. 子系统划分与归属

| 子系统 | 所属目录 | 说明 |
|--------|----------|------|
| **硬件抽象层 (HAL)** | `hal/` | 提供架构无关的抽象接口，每个 component 同时包含 RISC-V 和 LoongArch 两套实现 |
| **内核入口与初始化** | `os/src/main.rs`, `hal/src/component/entry/` | 内核启动流程、多核唤醒 |
| **内存管理** | `os/src/mm/` | 页表管理、帧分配器、SLAB 分配器、堆分配器、用户内存映射 (uvm)、内核虚拟内存 (kvm) |
| **进程/任务管理** | `os/src/task/`, `os/src/processor/` | 统一进程/线程模型、调度器、任务控制块、TID 分配、负载均衡 |
| **异步执行器** | `os/src/executor/` | 基于 `async-task` 的无栈协程执行器 |
| **系统调用** | `os/src/syscall/` | 约 300+ 系统调用的分发与实现（FS/IO/MM/NET/PROCESS/SIGNAL/TIME/IPC 等） |
| **文件系统** | `os/src/fs/` | VFS 框架 + ext4 + FAT32 + tmpfs + procfs + devfs + pipefs |
| **网络子系统** | `os/src/net/` | TCP/UDP 套接字、Loopback、IPv4/IPv6、加密套件 (AES/SHA2/Salsa20) |
| **信号处理** | `os/src/signal/` | 标准信号 + 实时信号、信号排队、用户自定义处理 |
| **进程间通信** | `os/src/ipc/` | SysV 共享内存 (SHM) |
| **设备管理** | `os/src/devices/` | 设备注册/查找、MMIO、PCI、PLIC、串口、SDIO、缓冲区缓存 |
| **驱动层** | `os/src/drivers/` | virtio-blk、MMC、PCI block、MMIO block、virtio-net、loopback、UART 串口、DMA |
| **时钟与定时器** | `os/src/timer/` | 定时任务管理、时钟源抽象、FFI 接口 |
| **中断与陷阱** | `os/src/trap/` | 中断/异常分发处理 |
| **同步原语** | `os/src/sync/` | Spin 互斥锁、读写锁、UpCell |
| **用户库** | `user/` | 用户态系统调用封装、运行时支持、用户程序 (shell, initproc, 测试用例等) |
| **工具库** | `utils/` | range-map、segment-tree 数据结构 |
| **构建系统** | `mk/`, `Makefile`, `Makefile.sub` | 多架构交叉编译、磁盘镜像制作、QEMU 运行 |

---

### 4. 构建工具需求

根据 `Dockerfile`、`Makefile` 和 `rust-toolchain.toml` 分析，构建该项目需要：

| 工具类别 | 具体工具 | 用途 |
|----------|----------|------|
| **Rust 工具链** | rustc (nightly), cargo, rust-src, llvm-tools-preview | 内核与用户程序编译 |
| **交叉编译目标** | `riscv64gc-unknown-none-elf`, `loongarch64-unknown-none` | 两种架构的裸机目标 |
| **Cargo 辅助** | cargo-binutils (rust-objcopy, rust-objdump) | ELF 转 binary、反汇编 |
| **QEMU 模拟器** | qemu-system-riscv64 (≥7.0), qemu-system-loongarch64 | 模拟运行 |
| **镜像制作** | dd, mkfs.ext4, e2fsprogs | 磁盘镜像构建 |
| **U-Boot 工具** | mkimage | 生成 zImage (RISC-V) |
| **通用工具** | git, python3, wget, curl, chmod, cp, rm | 辅助脚本 |
| **调试工具** | gdb-multiarch / riscv64-unknown-elf-gdb / loongarch64-linux-gnu-gdb | 内核调试 |
| **固件** | OpenSBI / RustSBI | RISC-V SBI 固件 |

构建通过 `make setup && make all` 完成，生成 RISC-V 和 LoongArch 的内核二进制文件以及 ext4 格式的磁盘镜像。