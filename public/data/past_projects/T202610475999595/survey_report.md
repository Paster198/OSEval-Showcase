# OS 内核项目初步分析报告

## 项目概要

该项目 **OSKernel2026-SGYB** 是基于 **xv6-riscv**（MIT 6.1810 教学操作系统）的修改版本，目标平台为 **RISC-V 64位（Sv39页表）**，运行于 QEMU `virt` 机器上。项目在标准 xv6 基础上新增了多个系统调用和一些功能扩展（如延迟内存分配），适用于 OS 内核竞赛。

---

## 1. 仓库文件组织结构

```
repo/
├── Makefile                         # 顶层构建文件（GNU Make）
├── build.sh                         # 简化构建脚本
├── README                           # 原始 xv6 README
├── README.md                        # GitLab 项目模板（未填写实际内容）
├── LICENSE                          # MIT 许可证
├── test-xv6.py                      # xv6 自动化测试脚本（QEMU 交互测试）
├── kernel/                          # 内核源码（扁平结构，无子目录）
│   ├── main.c                       # 内核入口与子系统初始化
│   ├── entry.S                      # M-mode 启动入口（_entry）
│   ├── start.c                      # M-mode 初始化与切换到 S-mode
│   ├── kernel.ld                    # 内核链接脚本
│   ├── defs.h                       # 全局函数声明汇总
│   ├── riscv.h                      # RISC-V CSR 操作内联函数
│   ├── memlayout.h                  # 物理/虚拟内存布局定义
│   ├── types.h                      # 基础类型定义
│   ├── param.h                      # 系统参数（进程数、文件数等上限）
│   ├── elf.h                        # ELF 可执行文件格式定义
│   ├── vm.c / vm.h                  # 虚拟内存管理（页表操作）
│   ├── kalloc.c                     # 物理页分配器
│   ├── proc.c / proc.h              # 进程管理与调度
│   ├── swtch.S                      # 上下文切换（汇编）
│   ├── trampoline.S                 # 用户态/内核态跳板（汇编）
│   ├── kernelvec.S                  # 内核态 trap 向量（汇编）
│   ├── trap.c                       # 陷阱/中断处理
│   ├── plic.c                       # PLIC 中断控制器驱动
│   ├── spinlock.c / spinlock.h      # 自旋锁
│   ├── sleeplock.c / sleeplock.h    # 睡眠锁
│   ├── syscall.c / syscall.h        # 系统调用分发框架
│   ├── sysproc.c                    # 进程相关系统调用实现
│   ├── sysfile.c                    # 文件系统相关系统调用实现
│   ├── fs.c / fs.h                  # 文件系统核心（inode/dinode/目录/位图）
│   ├── file.c / file.h              # 文件描述符层
│   ├── log.c                        # 日志系统（崩溃恢复）
│   ├── bio.c / buf.h                # 磁盘块缓存
│   ├── pipe.c                       # 管道实现
│   ├── exec.c                       # exec 系统调用（ELF 加载）
│   ├── console.c                    # 控制台输入输出（行缓冲）
│   ├── uart.c                       # NS16550 UART 驱动
│   ├── printf.c                     # 内核格式化输出
│   ├── virtio_disk.c / virtio.h     # virtio 块设备驱动
│   ├── string.c                     # 字符串/内存工具函数
│   ├── fcntl.h                      # 文件控制常量
│   └── stat.h                       # stat 结构体定义
├── user/                            # 用户空间程序（扁平结构）
│   ├── init.c / sh.c                # 初始化进程 / Shell
│   ├── cat.c / echo.c / grep.c / ls.c / wc.c / ...  # 标准 Unix 工具
│   ├── usertests.c                  # 用户态测试集（~3200行）
│   ├── grind.c                      # 压力测试
│   ├── forktest.c / forphan.c / dorphan.c / zombie.c  # 进程相关测试
│   ├── logstress.c / stressfs.c     # 文件系统压力测试
│   ├── myCall.c                     # 自定义系统调用测试
│   ├── ulib.c                       # 用户库（字符串、mem操作、sbrk封装）
│   ├── umalloc.c                    # 用户态 malloc/free
│   ├── printf.c                     # 用户态 printf
│   ├── user.h                       # 用户程序公共头文件
│   ├── user.ld                      # 用户程序链接脚本
│   └── usys.pl                      # Perl 脚本：自动生成系统调用桩
├── mkfs/
│   └── mkfs.c                       # 文件系统镜像生成工具
├── testsuits-for-oskernel/          # 竞赛测试套件目录（当前为空）
└── .workbuddy/
    └── memory/                      # 开发日志（5篇 Markdown）
```

**代码量统计**（基于 `wc -l`）：

| 位置 | 行数 |
|------|------|
| 内核 C 源码 (`kernel/*.c`) | ~5,250 行 |
| 内核头文件 (`kernel/*.h`) | ~1,000 行 |
| 内核汇编 (`kernel/*.S`) | ~275 行 |
| 用户程序 (`user/*.c`) | ~5,250 行 |
| **总计** | **~11,800 行** |

---

## 2. 子系统划分

基于 `main.c` 的初始化顺序和 `defs.h` 的函数分类，内核划分为以下子系统：

### 2.1 启动与平台初始化
- **文件**: `entry.S`, `start.c`, `main.c`, `kernel.ld`
- **职责**: M-mode 启动 → 初始化特权寄存器 → 委托中断到 S-mode → `mret` 切换到 S-mode → 进入 `main()` → 依次初始化各子系统 → 进入调度器

### 2.2 内存管理
- **文件**: `vm.c`/`vm.h`, `kalloc.c`, `memlayout.h`, `riscv.h`（页表宏）
- **职责**: Sv39 三级页表操作、虚拟地址映射、用户地址空间管理、物理页分配/释放、写时复制基础设施（`uvmcopy`）、缺页处理（`vmfault`，支持延迟分配）

### 2.3 进程管理
- **文件**: `proc.c`/`proc.h`, `swtch.S`, `kernelvec.S`
- **职责**: 进程结构体管理（`struct proc`）、6状态模型（UNUSED/USED/SLEEPING/RUNNABLE/RUNNING/ZOMBIE）、调度器（轮转）、`fork`/`exit`/`wait`/`kill`、上下文切换、CPU 状态管理

### 2.4 同步原语
- **文件**: `spinlock.c`/`spinlock.h`, `sleeplock.c`/`sleeplock.h`
- **职责**: 自旋锁（关中断+`__sync_lock_test_and_set`）、睡眠锁（基于自旋锁+`sleep`/`wakeup`）

### 2.5 陷阱与中断
- **文件**: `trap.c`, `trampoline.S`, `plic.c`, `kernelvec.S`
- **职责**: 用户态/内核态 trap 处理、时钟中断、设备中断分发、PLIC 中断控制器配置、trampoline 页映射

### 2.6 系统调用层
- **文件**: `syscall.c`/`syscall.h`, `sysproc.c`, `sysfile.c`
- **职责**: 系统调用分发（通过 `syscalls[]` 函数指针表）、参数提取（`argint`/`argaddr`/`argstr`）、结果写回用户空间。实现了 26 个系统调用（详见第3节）

### 2.7 文件系统
- **文件**: `fs.c`/`fs.h`, `file.c`/`file.h`, `bio.c`/`buf.h`, `log.c`, `mkfs/mkfs.c`
- **职责**: V6 风格文件系统 —— 超级块、inode/dinode、目录项、位图管理、磁盘块缓存（NBUF个缓冲区）、日志系统（写前日志/崩溃恢复）、文件描述符层

### 2.8 管道
- **文件**: `pipe.c`
- **职责**: 基于环形缓冲区的匿名管道，支持 `pipe`、`piperead`、`pipewrite`

### 2.9 ELF 加载器
- **文件**: `exec.c`, `elf.h`
- **职责**: 解析 ELF 可执行文件、加载程序段、设置用户栈、初始化 trampoline/trapframe 映射

### 2.10 设备驱动
- **文件**: `uart.c`（UART）, `virtio_disk.c`/`virtio.h`（virtio 块设备）, `console.c`（控制台行缓冲层）
- **职责**: NS16550 UART 输入输出、virtio-mmio 磁盘读写、控制台行编辑（退格/Ctrl-U/Ctrl-D/Ctrl-P）

### 2.11 工具与支持
- **文件**: `string.c`, `printf.c`, `types.h`, `param.h`
- **职责**: 内核态 `memmove`/`memset`/`strlen`/`strncpy` 等基础函数、内核 `printf`/`panic`

### 2.12 用户空间
- **目录**: `user/`
- **职责**: 用户程序（shell + Unix 工具 + 测试程序）、用户库（`ulib.c`/`umalloc.c`/`printf.c`）、系统调用桩生成脚本（`usys.pl`）

---

## 3. 系统调用清单（与标准 xv6 的差异）

项目在标准 xv6 系统调用基础上新增/修改了以下调用：

| 系统调用 | 编号 | 来源 | 说明 |
|----------|------|------|------|
| `fork` | 1 | xv6 标准 | — |
| `exit` | 2 | xv6 标准 | — |
| `wait` | 3 | xv6 标准 | — |
| `pipe` | 4 | xv6 标准 | — |
| `read` | 5 | xv6 标准 | — |
| `kill` | 6 | xv6 标准 | — |
| `exec` | 7 | xv6 标准 | — |
| `fstat` | 8 | xv6 标准 | — |
| `chdir` | 9 | xv6 标准 | — |
| `dup` | 10 | xv6 标准 | — |
| `getpid` | 11 | xv6 标准 | — |
| `sbrk` | 12 | xv6 标准 | **修改**: 支持 `SBRK_LAZY` 延迟分配模式 |
| `pause` | 13 | xv6 标准 | — |
| `uptime` | 14 | xv6 标准 | — |
| `open` | 15 | xv6 标准 | — |
| `write` | 16 | xv6 标准 | — |
| `getcwd` | 17 | **新增** | 获取当前工作目录路径 |
| `mknod` | 170 | **新增** | 创建设备节点 |
| `unlink` | 18 | xv6 标准 | — |
| `link` | 19 | xv6 标准 | — |
| `mkdir` | 20 | xv6 标准 | — |
| `close` | 21 | xv6 标准 | — |
| `myFirstCall` | 22 | **新增** | 竞赛自定义调用，返回 22 |
| `times` | 153 | **新增** | 获取进程 CPU 时间统计 |
| `uname` | 160 | **新增** | 获取系统信息 |
| `gettimeofday` | 169 | **新增** | 获取当前时间 |
| `getppid` | 173 | **新增** | 获取父进程 PID |
| `sched_yield` | 124 | **新增** | 主动让出 CPU |

---

## 4. 构建工具需求

根据 `Makefile` 分析，构建需要以下工具：

| 工具 | 用途 |
|------|------|
| **RISC-V 交叉编译工具链** (`riscv64-*-elf-*` 或 `riscv64-*-linux-gnu-*`) | 编译内核和用户程序；Makefile 自动检测可用的工具链前缀 |
| **GNU Make** | 构建系统 |
| **QEMU** (`qemu-system-riscv64`, 版本 >= 7.2) | 模拟运行 |
| **Perl** | 运行 `usys.pl` 生成系统调用桩 |
| **主机 GCC** | 编译 `mkfs/mkfs.c`（文件系统镜像生成工具，在主机上运行） |
| **GDB** (可选) | 调试（`make qemu-gdb`） |
| **Python 3** (可选) | 运行 `test-xv6.py` 自动化测试 |

构建命令：
- `make` 或 `make qemu` — 构建并启动 QEMU
- `make clean` — 清理构建产物
- `make fs.img` — 仅重建文件系统镜像

---

## 5. 初步评估说明

- 这是一个**小型教学/竞赛型内核**（约 11,800 行总代码），以简洁性和可理解性为设计目标。
- 内核采用**宏内核结构**，所有内核代码编译为一个单一 `kernel` 可执行文件，运行在 S-mode。
- 文件组织为**扁平结构**（无模块子目录），子系统划分通过函数前缀和头文件约定实现。
- 新增的系统调用编号与 Linux RISC-V ABI 不完全一致（这是已知问题，`.workbuddy/memory/2026-05-06.md` 中记录的 BUG-8）。
- `testsuits-for-oskernel/` 目录当前为空，竞赛测试套件尚未就位。