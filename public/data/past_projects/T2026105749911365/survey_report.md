# OSKernel2026-X 项目初步调查分析

## 一、项目概述

该项目名为 **OSKernel2026-X**，是一个基于 xv6-riscv 深度改造的操作系统内核，目标架构为 **RISC-V 64位**，运行在 **S-mode**（Supervisor模式）下，依赖 **OpenSBI** 作为固件层。项目定位是参加 OS 内核竞赛，所有改造由 AI（Claude Code / Claude Opus 4.8）辅助完成，约 30 轮迭代。

内核总计约 **8757 行源代码**（含 `.c`、`.h`、`.S` 文件），其中内核核心约 8450 行，mkfs 工具约 307 行。

---

## 二、仓库文件组织结构

```
repo/
├── kernel/           # 内核全部源代码（.c, .h, .S, .ld）
│   ├── *.c           # C 源文件（约 24 个）
│   ├── *.h           # 头文件（约 18 个）
│   ├── *.S           # 汇编文件（4 个：entry.S, kernelvec.S, swtch.S, trampoline.S）
│   ├── kernel.ld     # 链接脚本
│   └── *.o, *.d      # 编译产物（已存在，非源码）
├── mkfs/             # 文件系统镜像制作工具（仅 mkfs.c）
├── doc/              # AI 辅助开发文档
│   ├── 00-ai-prompts-catalog.md   # AI 提示词完整目录
│   ├── 01-ext4-filesystem.md      # ext4 只读文件系统文档
│   ├── 02-dynamic-elf-syscall.md  # 动态ELF + Linux 系统调用文档
│   ├── 03-contest-adaptation.md   # 竞赛环境适配文档
│   ├── 04-static-elf-test.md      # 静态ELF测试验证文档
│   └── README.md                  # 文档总览
├── Makefile          # 构建系统
├── Dockerfile        # Docker 构建环境（基于 zhouzhouyi/os-contest:20260510）
├── README.md         # 项目 README（GitLab 默认模板，无实质内容）
├── hello             # 预编译的静态 RISC-V ELF 测试程序
├── test_hello.c      # 静态 ELF 测试程序源码
├── testfs.img        # 预置文件系统镜像（1MB，用于 MEMFS 模式）
├── kernel-rv         # 预编译内核二进制（RISC-V）
└── kernel-la         # LoongArch 占位文件（仅为满足比赛提交格式）
```

---

## 三、子系统划分

### 3.1 内存管理子系统
| 文件 | 功能 |
|------|------|
| `kernel/vm.c` (491行) | 内核页表创建、用户页表管理、页映射、写时复制（uvmcopy）、懒分配页故障处理（vmfault）、copyin/copyout |
| `kernel/kalloc.c` (82行) | 物理页帧分配器（kalloc/kfree/kinit），基于空闲链表 |
| `kernel/memlayout.h` (59行) | 物理地址布局定义（KERNBASE=0x80200000, PHYSTOP=126MB, UART/VIRTIO/PLIC 基地址） |
| `kernel/vm.h` (2行) | 虚拟内存相关声明 |

### 3.2 进程管理子系统
| 文件 | 功能 |
|------|------|
| `kernel/proc.c` (767行) | 进程表管理、调度器、fork/exit/wait/kill、用户态初始化、contest 执行入口 |
| `kernel/proc.h` (109行) | 进程结构体（含 contest 字段）、CPU 结构体、trapframe、进程状态枚举 |
| `kernel/swtch.S` (42行) | 上下文切换汇编（保存/恢复 callee-saved 寄存器） |
| `kernel/param.h` (14行) | 系统参数常量（NPROC=64, NCPU=8, NOFILE=16 等） |

### 3.3 系统调用子系统
| 文件 | 功能 |
|------|------|
| `kernel/syscall.c` (206行) | 系统调用分发器，基于 Linux RISC-V 调用号（a7寄存器），argint/argaddr/argstr 参数提取 |
| `kernel/syscall.h` (56行) | 40+ Linux RISC-V 系统调用号定义（openat=56, read=63, write=64, mmap=222, brk=214 等） |
| `kernel/sysproc.c` (170行) | 进程相关系统调用实现（exit, fork, brk, exit_group, getpid, sched_yield 等） |
| `kernel/sysfile.c` (864行) | 文件系统系统调用（openat, read, write, mmap, fstat, getdents64, dup, pipe, mkdirat, unlinkat 等） |

### 3.4 文件系统子系统
| 文件 | 功能 |
|------|------|
| `kernel/fs.c` (1050行) | ext4 只读驱动核心：超级块解析、块组描述符表加载、extent 树遍历（bmap）、目录遍历、inode 管理；兼容 xv6 原始格式 |
| `kernel/fs.h` (187行) | ext4 磁盘数据结构：超级块、组描述符（64字节版）、inode、extent 节点头、目录项 |
| `kernel/ext4_write.c` (456行) | ext4 最小写支持：块分配（balloc）、inode 分配（ialloc）、目录链接/删除、inode 更新、truncate |
| `kernel/bio.c` (152行) | 缓冲区缓存（LRU 链表），bread/bwrite/brelse |
| `kernel/log.c` (248行) | 简易日志系统（begin_op/end_op），ext4 模式下禁用日志 |
| `kernel/file.c` (186行) | 文件描述符管理（filealloc/fileclose/filedup/fileread/filewrite） |
| `kernel/file.h` (43行) | 文件结构体、设备类型（FD_NONE/FD_PIPE/FD_INODE/FD_DEVICE） |
| `kernel/pipe.c` (134行) | 管道实现（pipealloc/piperead/pipewrite/pipeclose） |
| `kernel/buf.h` (11行) | 缓冲区结构体 |
| `kernel/stat.h` (23行) | stat 结构体（兼容 Linux） |
| `kernel/fcntl.h` (7行) | 文件控制常量（O_RDONLY/O_WRONLY/O_RDWR/O_CREATE） |

### 3.5 ELF 加载与执行子系统
| 文件 | 功能 |
|------|------|
| `kernel/exec.c` (339行) | 动态 ELF 加载器：PT_INTERP 解释器解析、PIE 基址加载、aux vector 构建（AT_PHDR/AT_ENTRY/AT_BASE/AT_PAGESZ）、Linux ABI 栈布局、PT_TLS 支持 |
| `kernel/elf.h` (74行) | ELF 头定义、Program Header 定义、常量（ET_DYN, PT_INTERP, PT_TLS, AT_* 系列, PIE_BASE） |

### 3.6 中断/异常/陷阱处理子系统
| 文件 | 功能 |
|------|------|
| `kernel/trap.c` (236行) | 用户态/内核态陷阱处理（usertrap/kerneltrap），系统调用分发，页故障处理，设备中断分发 |
| `kernel/trampoline.S` (149行) | 用户态↔内核态切换的蹦床代码（uservec/userret） |
| `kernel/kernelvec.S` (64行) | 内核态陷阱向量（kernelvec/kerneltrap） |
| `kernel/plic.c` (48行) | PLIC 中断控制器驱动（初始化、claim、complete） |

### 3.7 设备驱动子系统
| 文件 | 功能 |
|------|------|
| `kernel/virtio_disk.c` (303行) | virtio 块设备驱动（legacy/modern 双模式），支持 MEMFS 模式（镜像嵌入内核二进制） |
| `kernel/virtio.h` (103行) | virtio MMIO 寄存器定义和队列结构 |
| `kernel/uart.c` (160行) | NS16550 UART 驱动（初始化、中断处理、同步/异步输出） |
| `kernel/console.c` (200行) | 控制台抽象层（consoleinit/consoleintr/consputc） |

### 3.8 同步原语子系统
| 文件 | 功能 |
|------|------|
| `kernel/spinlock.c` (116行) | 自旋锁（acquire/release/initlock），支持嵌套关中断（push_off/pop_off） |
| `kernel/spinlock.h` (8行) | 自旋锁结构体 |
| `kernel/sleeplock.c` (52行) | 睡眠锁（acquiresleep/releasesleep），用于文件系统等长时间临界区 |
| `kernel/sleeplock.h` (9行) | 睡眠锁结构体 |

### 3.9 竞赛测试执行器
| 文件 | 功能 |
|------|------|
| `kernel/contest.c` (250行) | 竞赛测试自适应扫描与执行：根目录扫描、test group 标记输出、SBI 关机、多目录测试调度 |

### 3.10 启动与初始化子系统
| 文件 | 功能 |
|------|------|
| `kernel/entry.S` (22行) | S-mode 入口（从 a0 获取 hartid，设置栈，跳转 start） |
| `kernel/start.c` (28行) | 早期初始化：S-mode CSR 设置、定时器初始化、跳转 main |
| `kernel/main.c` (48行) | 内核主函数：顺序初始化所有子系统（console→kalloc→vm→proc→trap→plic→bio→fs→file→virtio→userinit），然后进入调度器 |
| `kernel/kernel.ld` (48行) | 链接脚本，基址 0x80200000（为 OpenSBI 留 2MB） |

### 3.11 工具与辅助
| 文件 | 功能 |
|------|------|
| `kernel/printf.c` (152行) | 格式化输出（printf/panic），支持串口输出 |
| `kernel/string.c` (106行) | 字符串/内存操作（memset/memmove/memcmp/strlen/safestrcpy 等） |
| `kernel/riscv.h` (380行) | RISC-V 特权架构 CSR 和内联汇编宏 |
| `kernel/types.h` (10行) | 基础类型定义（uint/uint64/pde_t 等） |
| `kernel/defs.h` (212行) | 全局函数声明汇总 |
| `kernel/errno.h` (22行) | 错误码定义 |
| `mkfs/mkfs.c` (307行) | 主机端文件系统镜像制作工具（xv6 格式） |

---

## 四、主要技术特点

1. **从 M-mode 迁移到 S-mode**：原 xv6-riscv 直接在机器态运行，该项目改为在 Supervisor 态运行，依赖 OpenSBI 处理 M-mode 事务，启动 hart 标识从 `mhartid` CSR 改为通过 `a0` 寄存器从 OpenSBI 获取。

2. **ext4 文件系统完整支持**：实现了 ext4 的只读驱动（超级块解析、extent 树遍历、64位块组描述符、目录项扫描），并进一步实现了 ext4 最小写支持（块分配、inode 分配、目录操作）。

3. **动态 ELF 加载**：支持 PT_INTERP 解释器加载和 PIE 可执行文件，构建 Linux ABI 标准的 aux vector 和栈布局。已知问题：动态链接器的 GOT/PLT 初始化未完全解决，sepc=0x0 崩溃问题仍存在。

4. **Linux RISC-V 系统调用 ABI**：完全替换 xv6 原有调用号，支持 40+ Linux 系统调用（mmap、brk、openat、getdents64 等）。

5. **竞赛评分适配**：contest.c 实现自动扫描 ext4 根目录、按组执行测试、输出竞赛标记、SBI 关机。

---

## 五、编译构建工具需求

基于 Makefile 分析，构建该内核需要以下工具：

| 工具 | 用途 | 必需性 |
|------|------|--------|
| RISC-V 交叉编译工具链（riscv64-unknown-elf-gcc 或同等） | 编译内核 C/汇编源码 | **必需** |
| RISC-V 链接器（riscv64-unknown-elf-ld） | 链接内核 ELF | **必需** |
| RISC-V objdump/objcopy | 生成反汇编和符号表 | 可选（调试用） |
| qemu-system-riscv64（>= 7.2） | 模拟运行 | **必需**（运行用） |
| GNU Make | 构建自动化 | **必需** |
| GCC（主机原生） | 编译 mkfs/mkfs.c | **必需** |
| Docker | 容器化构建（基于 zhouzhouyi/os-contest:20260510） | 可选（竞赛提交用） |
| clang-format | 代码格式化 | 可选 |
| Perl | 用户态 usys.S 生成 | 当前不需要（无 user/ 目录） |
| bc | QEMU 版本检查 | 可选 |

Makefile 自动检测工具链前缀，按优先级尝试：`riscv64-unknown-elf-` → `riscv64-elf-` → `riscv64-none-elf-` → `riscv64-linux-gnu-` → `riscv64-unknown-linux-gnu-`。

当前环境中已提供 **RISC-V 裸机交叉编译工具链**、**RISC-V Linux GNU 交叉编译工具链**、**QEMU RISC-V 环境**，可以满足该项目的编译与运行需求。