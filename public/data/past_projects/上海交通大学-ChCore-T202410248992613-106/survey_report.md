## 项目概述

**ChCore** 是一款基于 **RISC-V 架构的微内核操作系统**，由上海交通大学软件学院学生团队开发，原型来自上海交通大学《操作系统：原理与实现》课程的教学型操作系统。项目采用木兰宽松许可证（Mulan PSL v2）。

---

## 仓库文件组织结构

```
.
├── kernel/                    # 微内核核心代码
├── user/                      # 用户态代码（系统服务、库、应用）
├── chcore-busybox/            # 定制版 BusyBox（适配 ChCore）
├── scripts/                   # 构建脚本、QEMU 启动脚本、CI 脚本等
├── docs/                      # 项目文档（架构设计、实现说明）
├── testcases/                 # 测试用例
├── chbuild                    # 主构建入口脚本（封装 CMake）
├── CMakeLists.txt             # 顶层 CMake 构建文件
├── config.cmake               # 全局配置项定义
├── Makefile                   # 顶层 Makefile（简化构建流程）
├── allbuild.sh                # 全量构建脚本
│
├── [第三方基准测试/工具目录]
│   ├── iozone/                # IO 性能测试
│   ├── iperf/                 # 网络性能测试
│   ├── lmbench/               # 系统性能基准测试
│   ├── ltp/                   # Linux Test Project
│   ├── lua/                   # Lua 解释器
│   ├── netperf/               # 网络性能测试
│   ├── rt-tests/              # 实时性测试
│   ├── unixbench/             # Unix 基准测试
│   ├── libc-bench/            # libc 基准测试
│   ├── libc-test/             # libc 兼容性测试
│   └── time-test/             # 时间相关测试
│
└── libtirpc-build/            # TI-RPC 库构建产物
```

---

## 子系统划分

### 1. 微内核（kernel/）

内核代码约 **345 个源文件**（.c/.h/.S），仅支持 **RISC-V 64 位**架构。

| 目录 | 所属子系统 | 说明 |
|------|-----------|------|
| `kernel/arch/riscv64/boot/` | 启动 | 内核引导启动代码 |
| `kernel/arch/riscv64/mm/` | 内存管理（架构相关） | RISC-V 页表、TLB 等 |
| `kernel/arch/riscv64/sched/` | 调度（架构相关） | 上下文切换等 |
| `kernel/arch/riscv64/irq/` | 中断（架构相关） | RISC-V 中断处理 |
| `kernel/arch/riscv64/drivers/` | 驱动 | 平台相关驱动 |
| `kernel/arch/riscv64/machine/` | 机器抽象 | 硬件抽象层 |
| `kernel/arch/riscv64/plat/` | 平台适配 | 支持 qemu_virt 和 visionfive2 两个平台 |
| `kernel/arch/riscv64/sync/` | 同步原语 | 架构相关同步机制 |
| `kernel/mm/` | 内存管理（通用） | 物理/虚拟内存管理 |
| `kernel/sched/` | 进程调度（通用） | 调度策略实现 |
| `kernel/ipc/` | 进程间通信 | 微内核 IPC 机制 |
| `kernel/irq/` | 中断管理（通用） | 中断分发与处理 |
| `kernel/object/` | 对象/Capability | Capability 资源管理 |
| `kernel/syscall/` | 系统调用 | 系统调用入口与分发 |
| `kernel/lib/` | 内核工具库 | 内核内部使用的通用工具函数 |
| `kernel/include/` | 内核头文件 | 各子系统公共头文件 |
| `kernel/user-include/` | 用户态共享头文件 | 内核与用户态共享的 UAPI 定义 |

### 2. 用户态系统服务（user/system-services/system-servers/）

| 目录 | 所属子系统 | 说明 |
|------|-----------|------|
| `procmgr/` | 进程管理 | 进程管理器（fork、execve、signal 等） |
| `tmpfs/` | 文件系统 | 内存文件系统 |
| `ext4/` | 文件系统 | ext4 文件系统支持 |
| `fat32/` | 文件系统 | FAT32 文件系统支持 |
| `fs_base/` | 文件系统基础 | 文件系统公共基础代码 |
| `fsm/` | 文件系统管理 | 文件系统管理器 |
| `shmmgr/` | 共享内存管理 | 共享内存管理器 |
| `lwip/` | 网络协议栈 | 基于 lwIP 的网络服务 |
| `drivers/` | 用户态驱动 | 用户态设备驱动 |
| `chcore_shell/` | Shell | ChCore 定制 Shell |

### 3. 用户态库（user/chcore-libs/ 和 user/system-services/chcore-libc/）

| 目录 | 所属子系统 | 说明 |
|------|-----------|------|
| `chcore-libc/libchcore/` | ChCore 系统调用库 | 封装 ChCore 原生系统调用 |
| `chcore-libc/musl-libc/` | C 标准库 | 适配 ChCore 的 musl libc |
| `sys-libs/libpipe/` | Pipe 库 | 管道实现 |
| `sys-libs/dev_messenger/` | 设备消息 | 设备消息传递库 |
| `sys-libs/libohtee/` | 安全/TEE | OpenTrustee 相关库 |

### 4. 用户态应用（user/apps/）

包含示例应用：C++ 支持示例、动态链接示例、ramdisk 重建、简单 HTTP 服务器等。

### 5. 定制 BusyBox（chcore-busybox/）

针对 ChCore 定制的 BusyBox，包含大量标准 Unix 工具（coreutils、networking、shell 等），用于提供 POSIX 兼容的用户态命令环境。

---

## 构建工具需求

| 工具 | 用途 | 备注 |
|------|------|------|
| **CMake** (>= 3.14) | 主构建系统 | 通过 `chbuild` 脚本封装 |
| **RISC-V 交叉编译工具链** | 编译内核和用户态代码 | 使用 `riscv64-buildroot-linux-gnu-` (glibc) |
| **GNU Make** | CMake 后端构建执行 | - |
| **QEMU** (riscv64) | 模拟运行 | 配置中 `CHCORE_QEMU=ON` |
| **OpenSBI/RustSBI** | RISC-V SBI 固件 | QEMU 启动所需 |
| **Python3** | 构建辅助脚本 | repo 工具等 |
| **Git** | 版本管理 | - |
| **dtc** | 设备树编译 | RISC-V 平台可能需要 |

构建流程：`chbuild defconfig <平台>` -> `chbuild build` -> 生成 `build/kernel.img`。

支持的目标平台：
- `riscv64`（QEMU virt）
- `riscv64_visionfive2`（VisionFive2 开发板）
- `riscv64_testenv`（测试环境配置）

---

## 初步判断

1. **架构**：纯微内核架构，内核仅提供线程调度、内存管理、IPC、Capability 等最小功能集；文件系统、进程管理、网络协议栈、共享内存管理均以用户态系统服务器形式实现。
2. **目标平台**：仅支持 RISC-V 64 位，面向 QEMU 虚拟平台和 VisionFive2 硬件。
3. **POSIX 兼容性**：通过二进制重写和定制 musl libc 两条路径实现 POSIX 接口适配，是项目的核心技术亮点。
4. **代码规模**：内核约 345 个源文件，用户态约 2523 个源文件（含定制 BusyBox 和 libc），整体规模适中。
5. **测试覆盖**：集成了多种第三方基准测试和兼容性测试套件（LTP、lmbench、unixbench、libc-test 等），表明项目注重功能验证和性能评估。