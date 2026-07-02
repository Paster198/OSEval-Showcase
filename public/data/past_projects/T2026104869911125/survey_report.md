## F7LY OS 项目初步调查

### 一、仓库文件组织结构

```
repo/
├── Makefile                  # 顶层构建脚本 (471行)
├── README.md                 # 项目说明
├── AGENTS.md                 # AI 辅助开发指南
├── .gitignore
├── kernel/                   # 内核主体代码
│   ├── platform.hh           # 跨架构平台抽象头
│   ├── types.hh              # 基本类型定义
│   ├── boot/                 # 启动模块（含 entry.S、main.cc、initcode.S）
│   ├── trap/                 # 异常/中断处理模块
│   ├── mem/                  # 内存管理模块
│   ├── proc/                 # 进程管理模块
│   ├── sys/                  # 系统调用模块
│   ├── fs/                   # 文件系统模块（含 VFS、ext4、FAT32、块设备驱动）
│   ├── devs/                 # 设备管理模块（UART、控制台、块/字符设备框架、DTB）
│   ├── net/                  # 网络模块（Open-NPStack 移植 + VirtIO Net）
│   ├── hal/                  # 硬件抽象层（CSR 定义等）
│   ├── libs/                 # 内核基础库（klib、内存分配器、信号量、列表等）
│   ├── link/                 # 链接脚本
│   ├── shm/                  # 共享内存 / IPC
│   └── tm/                   # 时间管理模块
├── user/                     # 用户态程序
│   ├── app/                  # initcode、shell
│   ├── deps/                 # 用户态头文件
│   ├── syscall_lib/          # 用户态系统调用封装库
│   └── user_lib/             # 用户态测试代码
├── thirdparty/
│   └── EASTL/                # EA Standard Template Library (C++ STL替代)
├── scripts/
│   ├── run/                  # QEMU 运行辅助脚本
│   ├── dev/                  # 代码统计与 git 烟雾测试
│   ├── images/               # sdcard 镜像恢复脚本
│   └── mount/                # 镜像挂载脚本
├── tools/
│   └── ltp/judge/            # LTP 测试评判工具
├── docs/                     # 设计文档、架构图
├── agent_docs/               # AI 辅助开发相关文档
├── plan_docs/                # 开发计划与修复记录
├── scoreboard/               # 评测记分板（按架构和 libc 分类）
└── logs/                     # 空日志目录
```

### 二、子系统概览

项目实现了一个**双架构 (RISC-V64 + LoongArch64) C++ 宏内核**，包含以下子系统：

| 子系统 | 对应目录 | 代码量（估算） | 说明 |
|--------|---------|---------------|------|
| **启动 (Boot)** | `kernel/boot/{riscv,loongarch}/` | ~15KB | entry.S、main.cc、initcode.S，初始化 CPU、设置栈、跳入内核主函数 |
| **异常/中断 (Trap)** | `kernel/trap/{riscv,loongarch}/` | ~55KB | 中断向量、PLIC/APIC/EXTIOI 驱动、trap 分发处理、用户态 trap 入口 |
| **内存管理 (Mem)** | `kernel/mem/{riscv,loongarch}/` | ~130KB | 物理页管理、伙伴系统、堆分配器、slab 分配器、页表、VMA、mmap、用户地址空间 |
| **进程管理 (Proc)** | `kernel/proc/{riscv,loongarch}/` | ~570KB | 进程创建/销毁、调度器、信号处理、futex、管道、POSIX 定时器、VMA Maple Tree、进程内存管理器、capability |
| **文件系统 (FS)** | `kernel/fs/` | ~1.1MB | VFS 层 (virtual_fs)、ext4 完整实现 (lwext4 风格)、FAT32 支持、文件类型抽象 (普通文件/目录/设备/管道/socket/虚拟文件)、块缓存 (bio)、VirtIO 块设备驱动 |
| **系统调用 (Sys)** | `kernel/sys/` | ~820KB | 240+ 系统调用的 handler、syscall 定义表、sysio/sysproc 子模块 |
| **设备管理 (Devs)** | `kernel/devs/{riscv,loongarch}/` | ~80KB | 设备管理器、UART、控制台 (含 termios)、ramdisk、loop 设备、DTB 解析、自旋锁、块/字符设备框架、VirtIO 磁盘 (LA) |
| **网络 (Net)** | `kernel/net/` | ~180KB | Open-NPStack 协议栈移植、VirtIO Net 适配层、BSD Socket 兼容层 |
| **硬件抽象 (HAL)** | `kernel/hal/{riscv,loongarch}/` | ~30KB | CSR 寄存器定义与操作封装 (RISC-V) / 汇编宏 (LoongArch) |
| **内核库 (Libs)** | `kernel/libs/` | ~80KB | C++ ABI 支持、klib、EASTL 分配器适配、信号量、列表、排序、字符串、打印等 |
| **共享内存 (SHM)** | `kernel/shm/` | ~70KB | System V 共享内存管理器、IPC 参数定义 |
| **时间管理 (TM)** | `kernel/tm/` | ~50KB | 定时器管理、时间子系统、rusage、timex |
| **链接脚本 (Link)** | `kernel/link/{riscv,loongarch}/` | ~2.5KB | 内核链接脚本 |
| **用户态 (User)** | `user/` | ~250KB | initcode、shell、系统调用封装、用户态测试用例 |

### 三、架构相关的代码分布

项目采用**按模块拆分架构相关代码**的模式：每个主要子系统 (`boot`, `trap`, `mem`, `proc`, `devs`, `fs/drivers`, `hal`, `link`) 内部均按 `riscv/` 和 `loongarch/` 子目录存放架构特定实现，通用逻辑则直接放在模块根目录下。例如：

- `kernel/boot/riscv/main.cc` — RISC-V 启动入口
- `kernel/boot/loongarch/main.cc` — LoongArch 启动入口
- `kernel/trap/riscv/trap.cc` — RISC-V trap 处理
- `kernel/trap/loongarch/trap.cc` — LoongArch trap 处理
- `kernel/mem/riscv/pagetable.cc` — RISC-V 页表
- `kernel/mem/loongarch/pagetable.cc` — LoongArch 页表

架构选择通过 `platform.hh` 中的 `#ifdef RISCV` / `#ifdef LOONGARCH` 宏完成。

### 四、构建工具链需求

根据 Makefile 分析，构建需要以下工具：

**必须：**
- GNU Make
- RISC-V 交叉编译工具链：`riscv64-linux-gnu-gcc/g++/ld/objcopy/objdump`
- LoongArch 交叉编译工具链：`loongarch64-linux-gnu-gcc/g++/ld/objcopy/objdump`
- QEMU 9.2.1+ (`qemu-system-riscv64` / `qemu-system-loongarch64`)

**编译标准：**
- C++23 freestanding 环境
- 架构特定编译标志：RISC-V (`-mcmodel=medany`)、LoongArch (`-march=loongarch64 -mabi=lp64d -mcmodel=normal`)
- EASTL 作为静态库 (`libeastl.a`) 参与链接

**主要构建目标：**
| Make 目标 | 说明 |
|-----------|------|
| `make` / `make all` | 同时构建 RISC-V 和 LoongArch |
| `make riscv` | 构建 RISC-V 内核 |
| `make loongarch` | 构建 LoongArch 内核 |
| `make run` | 构建并运行（评测模式，`-snapshot`） |
| `make shell` | 构建并运行（交互 shell 模式） |
| `make debug` | 构建并以 GDB 调试模式启动 QEMU |
| `make clean` | 清理构建产物 |

### 五、关键统计

- **内核源文件总数**：约 360 个（`.cc` / `.hh` / `.h` / `.S`）
  - C++ 源文件 (`.cc`)：140 个
  - 头文件 (`.hh` / `.h`)：206 个
  - 汇编文件 (`.S`)：14 个
- **内核代码总行数**：约 110,000 行（不含第三方 EASTL）
- **包含第三方 EASTL 后总行数**：约 140,000 行
- **系统调用数量**：240+（`syscall_defs.hh` 中定义）
- **支持架构**：RISC-V64、LoongArch64