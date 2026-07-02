# F423OS 项目初步调查报告

## 一、项目概述

F423OS 是基于 **xv6-riscv** 改造的 2026 操作系统内核赛初赛作品。项目采用 C 语言编写，主目标架构为 **RISC-V 64**（RV64），同时包含一个 LoongArch64 的最小占位桩（minimal stub）。核心任务是读取官方 EXT4 测试镜像并执行 Linux 用户态测试程序（musl/glibc 编译的 binary）。

## 二、顶层目录结构

```
/
├── Makefile                     # 顶层构建入口，串联 RV 与 LA 构建
├── README.md                    # 项目说明
├── F423OS-初赛PPT.pptx           # 答辩 PPT
├── OSKernel2026-F423操作系统内核设计文档.docx   # 设计方案 Word
├── .gitignore
│
├── kernel-riscv/                # ★ 主内核（RV64），基于 xv6-riscv 改造
│   ├── Makefile                 #    内核构建文件
│   ├── kernel/                  #    内核源码（~11600 行 C/汇编）
│   ├── user/                    #    xv6 风格用户态程序
│   ├── mkfs/                    #    mkfs 工具（构建 xv6 fs.img）
│   └── test-xv6.py              #    xv6 测试脚本
│
├── kernel-loongarch/            # LoongArch64 最小占位桩
│   ├── Makefile                 #    支持本地或 Docker 构建
│   ├── entry.S                  #    入口汇编
│   ├── start.c                  #    启动代码（打印后 poweroff）
│   └── kernel.ld                #    链接脚本
│
├── common/                      # 跨架构共享头文件
│   ├── linux_syscall.h          #    Linux syscall 编号定义
│   ├── errno.h                  #    Linux errno 定义
│   └── abi_notes.md             #    ABI 兼容层设计边界说明
│
├── user/                        # 用户态辅助程序（预留目录）
│   ├── init-runner/             #    init runner（空，仅 .gitkeep）
│   └── testbench/               #    测试台（空，仅 .gitkeep）
│
├── ext4-port/                   # EXT4 移植（空，仅 .gitkeep）
│
├── scripts/                     # 构建与测试辅助脚本（~24 个）
│   ├── run-autotest.sh          #    自动化测试入口
│   ├── check-env.sh             #    环境检查
│   ├── test-*.sh                #    各项针对性测试
│   ├── qemu-rv-local.sh         #    本地 QEMU 启动
│   └── make-kernel-la-placeholder.py
│
├── docs/                        # 设计文档与测试记录
│   ├── draft.md                 #    设计方案源稿
│   ├── PLAN-final.md            #    总体路线与分层
│   ├── syscall-status.md        #    syscall 实现状态
│   ├── testcase-status.md       #    测试用例状态
│   ├── fs-design.md             #    文件系统设计
│   ├── elf-loader.md            #    ELF 加载器设计
│   ├── risk-log.md              #    风险与停线记录
│   ├── MODIFIED_FILES.md        #    修改清单
│   ├── AI_USAGE.md              #    AI 使用说明
│   ├── CONTRIBUTIONS.md         #    贡献说明
│   ├── meetings/                #    会议记录（空）
│   ├── weekly/                  #    周报（空）
│   └── test-results/            #    历次测试结果（~27 个文件）
│
└── logs/                        # 运行日志目录（空）
    ├── autotest/
    ├── boot/
    └── qemu/
```

## 三、子系统划分

### 1. 内存管理子系统
| 文件 | 行数 | 功能 |
|------|------|------|
| `kalloc.c` | 82 | 物理页分配器（`kalloc`/`kfree`/`kinit`） |
| `vm.c` | 491 | 虚拟内存管理（页表操作、`mmap`/`munmap`/`mprotect`） |
| `vm.h` | 2 | 虚存头文件 |
| `memlayout.h` | 62 | 内存布局常量定义 |

### 2. 进程管理子系统
| 文件 | 行数 | 功能 |
|------|------|------|
| `proc.c` | 859 | 进程调度、`fork`/`wait`、Linux 进程状态管理、VMA/FD 管理 |
| `proc.h` | 196 | 进程结构体（`proc`）、`cpu`、`trapframe`、ABI 枚举、Linux FD/VMA 定义 |
| `swtch.S` | 42 | 上下文切换汇编 |
| `param.h` | 14 | 系统参数（`NPROC=64`, `NCPU=8` 等） |

### 3. 陷阱与中断子系统
| 文件 | 行数 | 功能 |
|------|------|------|
| `trap.c` | 219 | 用户态/内核态 trap 处理、时钟中断 |
| `trampoline.S` | 149 | 用户态/内核态切换蹦床 |
| `kernelvec.S` | 64 | 内核态 trap 向量 |
| `plic.c` | 47 | PLIC 中断控制器初始化 |

### 4. 系统调用子系统（xv6 原生 ABI）
| 文件 | 行数 | 功能 |
|------|------|------|
| `syscall.c` | 154 | xv6 系统调用分发（`syscall()`）、参数提取 |
| `syscall.h` | 22 | xv6 系统调用号 |
| `sysproc.c` | 109 | xv6 进程相关 syscall（`exit`、`fork`、`wait` 等） |
| `sysfile.c` | 506 | xv6 文件相关 syscall（`open`、`read`、`write` 等） |

### 5. Linux ABI 兼容层（★ 核心新增，规模最大）
| 文件 | 行数 | 功能 |
|------|------|------|
| `linux_syscall.c` | **3181** | Linux RISC-V syscall 实现全集（60+ 个 syscall） |
| `linux_exec.c` | 360 | Linux ELF 可执行文件/DYN 加载器 |
| `contest_runner.c` | 717 | 竞赛自动评测编排器（顺序执行 basic/busybox/libctest/lua 等测试） |
| `common/linux_syscall.h` | 73 | Linux syscall 号常量 |
| `common/errno.h` | 24 | Linux 风格 errno |

### 6. 文件系统子系统
| 文件 | 行数 | 功能 |
|------|------|------|
| `fs.c` | 721 | xv6 文件系统核心（inode、目录、路径解析） |
| `fs.h` | 60 | 文件系统结构定义 |
| `bio.c` | 152 | 块缓存（buffer cache） |
| `buf.h` | 11 | 缓存头 |
| `log.c` | 236 | xv6 日志层（写事务） |
| `file.c` | 179 | 文件描述符管理 |
| `file.h` | 40 | 文件结构 |
| `pipe.c` | 134 | 管道实现 |
| `fcntl.h` | 5 | fcntl 常量 |
| `stat.h` | 11 | stat 结构 |

### 7. EXT4 只读读取器
| 文件 | 行数 | 功能 |
|------|------|------|
| `ext4_lite.c` | 522 | 轻量 EXT4 解析（超级块、extent 树、目录项遍历） |
| `ext4_lite.h` | 32 | EXT4 结构体与常量 |

### 8. ELF 加载子系统
| 文件 | 行数 | 功能 |
|------|------|------|
| `exec.c` | 177 | xv6 原生 ELF 加载（`kexec`） |
| `linux_exec.c` | 360 | Linux ELF 加载（静态 + 动态解释器） |
| `elf.h` | 42 | ELF 结构定义 |

### 9. 设备驱动子系统
| 文件 | 行数 | 功能 |
|------|------|------|
| `uart.c` | 160 | NS16550 UART 驱动 |
| `console.c` | 200 | 控制台（输入/输出） |
| `virtio_disk.c` | 372 | VirtIO 块设备驱动 |
| `virtio.h` | 103 | VirtIO 结构定义 |

### 10. 同步原语
| 文件 | 行数 | 功能 |
|------|------|------|
| `spinlock.c` | 116 | 自旋锁 |
| `spinlock.h` | 8 | |
| `sleeplock.c` | 52 | 睡眠锁 |
| `sleeplock.h` | 9 | |

### 11. 启动与基础库
| 文件 | 行数 | 功能 |
|------|------|------|
| `entry.S` | 27 | 内核入口汇编 |
| `start.c` | 65 | 早期启动（machine mode -> supervisor mode） |
| `main.c` | 45 | 内核主函数（初始化各子系统） |
| `kernel.ld` | 47 | 链接脚本 |
| `printf.c` | 152 | 格式化输出 |
| `string.c` | 106 | 字符串/内存操作 |
| `riscv.h` | 380 | RISC-V 特权架构宏 |
| `types.h` | 10 | 基础类型定义 |
| `sbi.c` | 44 | SBI 调用封装 |
| `defs.h` | 211 | 全内核函数原型汇总 |

### 12. LoongArch64 桩
| 文件 | 行数 | 功能 |
|------|------|------|
| `entry.S` | 4 | 设置栈指针，跳转 `la_main` |
| `start.c` | 25 | 输出 booting/poweroff，ACPI 关机 |
| `kernel.ld` | 22 | LA 链接脚本 |
| `Makefile` | 29 | LA 构建（支持 Docker 回退） |

## 四、代码规模概览

以 `kernel-riscv/kernel/` 目录计，全部 `.c`、`.h`、`.S` 文件共约 **11658 行**。其中：

- **Linux ABI 兼容层**（`linux_syscall.c` + `linux_exec.c` + `contest_runner.c` + `common/`）是最大的新增模块，约 4300+ 行，占总量的 **37%** 以上。
- 原 xv6 核心（进程、内存、FS、驱动等）约 7300 行。
- 最大单文件是 `linux_syscall.c`（3181 行），实现了 60+ 个 Linux syscall。

## 五、构建工具需求

### RISC-V 内核（主构建目标）
- **交叉编译器**：`riscv64-unknown-elf-gcc` 或 `riscv64-linux-gnu-gcc`（Makefile 自动探测，优先级依次为 `unknown-elf` > `elf` > `none-elf` > `linux-gnu` > `unknown-linux-gnu`）
- **链接器**：对应前缀的 `ld`
- **objdump/objcopy**：对应前缀
- **GNU Make**
- **Perl**：用于生成 `usys.S`（用户态 syscall 桩）
- **QEMU**：`qemu-system-riscv64` >= 7.2（用于本地测试）

### LoongArch 内核
- **交叉编译器**：`loongarch64-linux-gnu-gcc`（可选，若无则自动回退到 Docker）
- **Docker**：镜像 `zhouzhouyi/os-contest:20260510`（作为回退构建方案）

### 本地测试
- **bash**：所有测试脚本使用 bash
- **Python 3**：部分辅助脚本（如 `list-a4-remaining.py`）

### 宿主机工具
- `gcc`（宿主）：用于编译 `mkfs/mkfs.c`（构建 xv6 文件系统镜像）
- `dtc`（可选）：Device Tree 编译（在脚本中可能使用）