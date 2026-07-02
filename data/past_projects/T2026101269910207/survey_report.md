# OSKernel2026-X 项目初步调查

## 一、项目概述

OSKernel2026-X 是基于 **RT-Thread 5.x** 的操作系统内核竞赛项目，面向操作系统设计赛内核实现赛道。目标平台为 **QEMU RISC-V64 `virt`** 机器，同时在 LoongArch64 上提供初赛阶段最小入口（stub）。构建入口为仓库根目录的 `make all`，产物为 `kernel-rv`（RISC-V64 ELF）和 `kernel-la`（LoongArch64 ELF）。

## 二、仓库文件组织结构

```
.
├── Makefile                       # 根构建入口
├── DESIGN.md                      # 设计文档
├── README.md                      # 项目说明
├── THIRD_PARTY_NOTICES.md         # 第三方代码声明
├── Dockerfile                     # Docker 构建环境
│
├── rt-thread/                     # RT-Thread 内核（经剪裁适配）
│   ├── src/                       # 内核核心源文件
│   ├── include/                   # 内核头文件
│   ├── components/                # 内核组件
│   ├── libcpu/                    # 多架构 CPU 支持（18种架构）
│   └── tools/                     # SCons 构建脚本
│
├── machines/                      # 板级支持包（BSP）
│   └── qemu-virt-riscv64/         # 当前唯一的目标 BSP
│       ├── applications/          # 应用层（runner、ELF加载等）
│       ├── driver/                # 板级驱动（UART、virtio）
│       ├── link.lds               # 链接脚本
│       ├── rtconfig.h             # 内核配置头文件
│       ├── .config                # Kconfig 配置
│       └── run.sh                 # 本地运行脚本
│
├── compat/                        # 构建兼容适配层
│   ├── include/                   # 兼容头文件
│   └── libc_compat.c              # libc 辅助符号
│
├── tools/                         # 辅助工具
│   ├── python/SCons/              # 内置 SCons 模块
│   └── loongarch_basic_stub.S/.c  # LoongArch64 最小入口 stub
│
└── docs/                          # 文档与过程材料
    ├── 工程化设计方案.pdf/.docx/.txt
    └── 项目汇报PPT.pptx
```

## 三、已实现的子系统及其粗略归属

### 1. 内核核心（`rt-thread/src/`）

| 子系统/模块 | 关键文件 | 说明 |
|---|---|---|
| **线程管理** | `thread.c` (40KB) | 线程创建、删除、调度、挂起/恢复 |
| **调度器（UP）** | `scheduler_up.c` (24KB) | 单核优先级调度 |
| **调度器（MP）** | `scheduler_mp.c` (52KB) | 多核调度支持 |
| **调度器（通用）** | `scheduler_comm.c` (17KB) | 调度通用逻辑 |
| **CPU多核管理** | `cpu_mp.c`, `cpu_up.c` | SMP 启动与 CPU 管理 |
| **IPC 机制** | `ipc.c` (138KB) | 信号量、互斥锁、事件、邮箱、消息队列 |
| **内存管理** | `mem.c` (24KB), `memheap.c` (33KB), `mempool.c` (11KB), `slab.c` (26KB) | 多种内存分配策略 |
| **对象管理** | `object.c` (25KB) | 内核对象容器 |
| **定时器** | `timer.c` (24KB) | 软件定时器 |
| **时钟** | `clock.c` (6KB) | 系统时钟节拍 |
| **信号** | `signal.c` (19KB) | 线程间信号 |
| **中断管理** | `irq.c` (4KB) | 中断抽象层 |
| **组件初始化** | `components.c` (7KB) | 组件自动初始化框架 |
| **空闲线程** | `idle.c` (5KB) | 空闲任务 |
| **klibc** | `src/klibc/` | 内核 libc 子集（printf/scanf/string） |
| **defunct** | `defunct.c` (5KB) | 僵死线程回收 |

### 2. 架构层——RISC-V64 支持（`rt-thread/libcpu/risc-v/`）

| 子目录 | 内容 |
|---|---|
| `virt64/` | RISC-V64 virt 平台支持：中断处理(plic)、MMU(SV39)、trap、缓存、启动代码 |
| `common64/` | RISC-V64 通用代码：上下文切换(汇编)、trap分发、MMU页表操作、SBI调用、backtrace |
| `rv64/` | RISC-V64 基础：trap、cpuport、encoding头文件 |
| `common/` | RISC-V 通用：原子操作、上下文切换、中断处理、trap通用逻辑 |

### 3. 组件层（`rt-thread/components/`）

| 组件 | 目录 | 说明 |
|---|---|---|
| **DFS（虚拟文件系统）** | `dfs/` | DFS v1/v2 框架、ELM FatFs、devfs、romfs |
| **设备驱动框架** | `drivers/` | 涵盖 serial、virtio、block、net、spi、i2c、pci、usb、watchdog 等 40+ 类设备驱动 |
| **Finsh/Shell** | `finsh/` | 命令行 shell（msh），支持历史和符号表 |
| **LWP（轻量级进程）** | `lwp/` | 用户态进程支持：ELF加载、syscall、信号、futex、共享内存、PID管理、终端TTY、vdso |
| **内存管理** | `mm/` | 虚拟地址空间(aspace)、匿名页、页分配器、memblock、缺页处理、ioremap |
| **网络** | `net/` | lwIP 协议栈、SAL 套接字抽象层、netdev 网络设备管理 |
| **POSIX 兼容** | `libc/` | POSIX 接口（文件IO、stdio、poll/select、pipe、clock/timer、aio 等） |
| **mprotect** | `mprotect/` | 内存保护 |
| **FAL** | `fal/` | Flash 抽象层 |
| **Rust 支持** | `rust/` | Rust 内核模块框架（core、rt_macros、examples） |
| **工具** | `utilities/` | ulog、rt-link、资源管理、ADT 数据结构库（AVL/bitmap/hashmap） |
| **legacy** | `legacy/` | 旧版兼容接口（dfs、fdt、ipc、usb） |

### 4. 竞赛应用层（`machines/qemu-virt-riscv64/applications/`）

| 文件 | 大小 | 功能 |
|---|---|---|
| `main.c` | 2.7KB | BSP 应用入口 |
| `os_test_runner.c` | 75KB | **主测试运行器**：调度评测流程、识别测试组、解析脚本 |
| `judge_ext4_scan.c` | 22KB | **EXT4 只读扫描器**：直接解析 EXT4 镜像、枚举目录、读取脚本 |
| `os_elf_loader.c` | 8.9KB | **ELF 加载器**：解析 ELF header、program header |
| `os_user_image.c` | 4.7KB | **用户镜像准备**：构建用户内存布局 |
| `os_user_exec.c` | 116KB | **用户态执行与 syscall**：U-mode 进入、ecall 处理（write、exit 等） |

### 5. 板级驱动（`machines/qemu-virt-riscv64/driver/`）

| 文件 | 说明 |
|---|---|
| `board.c/.h` | 板级初始化 |
| `drv_uart.c/.h` | NS16550 UART 驱动 |
| `drv_virtio.c/.h` | virtio 传输层 |
| `virt.h` | virt 平台常量 |
| `asm/sbiasm.h`, `asm/sbidef.h` | SBI 汇编定义 |

### 6. LoongArch64 stub（`tools/`）

| 文件 | 大小 | 说明 |
|---|---|---|
| `loongarch_basic_stub.S` | 5KB | LoongArch64 汇编入口 |
| `loongarch_basic_stub.c` | 144KB | LoongArch64 最小测试执行 stub（含 EXT4 解析等） |

### 7. 构建兼容层（`compat/`）

| 文件 | 说明 |
|---|---|
| `libc_compat.c` | 补充缺失的 libc 符号 |
| `include/` | 构建适配头文件 |

## 四、编译构建工具分析

构建使用以下工具链：

1. **SCons**（Python 构建系统）：通过 `python3 -m SCons` 调用，内置在 `tools/python/SCons/` 中，不依赖系统安装
2. **RISC-V GNU 工具链**：`riscv64-unknown-elf-gcc`（可通过 `RTT_CC_PREFIX` 环境变量覆盖），参数：`-march=rv64imafdc -mabi=lp64 -mcmodel=medany`
3. **LoongArch64 GCC**（可选）：用于构建 `kernel-la` stub
4. **根 Makefile**：极简封装，仅设置环境变量、调用 SCons、复制产物

构建流程：`make all` → SCons 进入 `machines/qemu-virt-riscv64/` → 编译内核+组件+BSP驱动+竞赛应用 → 链接生成 `rtthread.elf` → 复制为 `kernel-rv`；同时用 LoongArch GCC 编译 `kernel-la`。

## 五、关键特征与状态

- **当前配置**（`.config`）：单核 UP 模式，`CONFIG_RT_USING_SMART` 未启用（即内核内置的完整 LWP 用户态进程子系统尚未配置使用），实际用户态执行通过竞赛团队自行开发的 `os_user_exec.c` 实现 SV39 页表和 U-mode ecall 处理。
- **代码规模**：约 2900+ 个 C/H/汇编/Rust/Python 源文件，总计约 99,000 行。
- **当前开发重点**：评测 EXT4 镜像只读解析、测试脚本识别、RISC-V64 ELF 加载、用户态执行与 syscall 处理（write/exit 已验证）。
- **支持驱动**：virtio-blk（评测磁盘）、virtio-net、UART、PLIC 中断控制器、RISC-V MMU (SV39)。