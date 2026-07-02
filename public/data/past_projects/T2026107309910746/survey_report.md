## 项目初步调查报告

### 一、项目概况

该项目是一个基于 **xv6** 教学操作系统的扩展内核项目，面向 **RISC-V 64位** 多处理器架构。项目在经典 xv6 的基础上进行了大量扩展，引入了 Linux ABI 兼容层、VFS 抽象、ext4 文件系统支持、网络协议栈、mmap、COW（Copy-on-Write）等现代操作系统特性。从项目结构来看，它同时是一个教学/竞赛项目，包含多个实验（lab）及其评分脚本。

---

### 二、目录结构

```
.
├── conf/                  # 实验配置 (lab.mk: LAB=all)
├── kernel/                # 内核源码（核心）
│   ├── lwext4/            # 第三方 lwext4 库（ext4 文件系统实现）
│   │   ├── include/       # lwext4 头文件
│   │   └── src/           # lwext4 源文件（25个 .c 文件）
│   ├── *.c               # 内核 C 源文件（约 30 个）
│   ├── *.h               # 内核头文件（约 25 个）
│   ├── *.S               # 汇编源文件（entry, swtch, trampoline, kernelvec）
│   └── kernel.ld          # 链接脚本
├── user/                  # 用户空间程序（~40 个）
│   ├── *.c               # 用户程序源文件
│   ├── user.h            # 用户库头文件
│   ├── ulib.c            # 用户库
│   ├── umalloc.c         # 用户态内存分配
│   ├── usys.pl           # 系统调用桩生成脚本 (Perl)
│   └── user.ld           # 用户程序链接脚本
├── mkfs/                  # 文件系统镜像制作工具
│   └── mkfs.c
├── Makefile               # 顶层构建文件
├── grade-lab-*            # 各实验评分脚本 (util/cow/mmap/net/lock/pgtbl/traps)
├── gradelib.py            # 评分库
├── test-xv6.py            # xv6 测试脚本
├── nettest.py             # 网络测试辅助脚本
└── README                 # 项目说明
```

---

### 三、子系统划分

#### 1. 启动与初始化
| 文件 | 说明 |
|------|------|
| `kernel/entry.S` | 内核入口汇编 |
| `kernel/start.c` | C 入口，设置栈、跳转 main |
| `kernel/main.c` | 内核主初始化流程 |

#### 2. 内存管理
| 文件 | 说明 |
|------|------|
| `kernel/kalloc.c` | 物理页分配器（per-CPU freelist）、大页分配、引用计数 |
| `kernel/vm.c` | 虚拟内存管理：页表操作、mmap/munmap、COW、用户内存布局 |
| `kernel/memlayout.h` | 物理/虚拟地址布局定义 |

#### 3. 进程与线程管理
| 文件 | 说明 |
|------|------|
| `kernel/proc.c` | 进程/线程管理（创建、调度、退出、等待）、Linux 线程组 (thread_group)、futex |
| `kernel/proc.h` | 进程控制块（PCB）、VMA、Linux MM 结构、线程组结构 |
| `kernel/swtch.S` | 上下文切换汇编 |
| `kernel/sysproc.c` | 进程相关系统调用（fork/clone/execve/wait/exit/futex 等） |

#### 4. 同步原语
| 文件 | 说明 |
|------|------|
| `kernel/spinlock.c` / `.h` | 自旋锁 |
| `kernel/sleeplock.c` / `.h` | 睡眠锁 |
| `kernel/rwlock.c` / `.h` | 读写锁 (rwspinlock) |

#### 5. 文件系统
| 文件 | 说明 |
|------|------|
| `kernel/bio.c` / `buf.h` | 块缓存层（buffer cache） |
| `kernel/log.c` | 日志层（崩溃恢复） |
| `kernel/fs.c` / `fs.h` | xv6 原生文件系统（inode、目录、路径解析） |
| `kernel/file.c` / `file.h` | 文件描述符层 |
| `kernel/sysfile.c` | 文件相关系统调用（大量 Linux 兼容 syscall） |
| `kernel/vfs.c` / `vfs.h` | **VFS 抽象层**：统一 xv6 FS、ext4、procfs、tmpfs、devfs |
| `kernel/lwext4_port.c` | lwext4 到 xv6 的适配层（块设备、内存分配、锁） |
| `kernel/lwext4_stubs.c` | lwext4 桩函数 |
| `kernel/lwext4_xv6.h` | lwext4 与 xv6 接口定义 |
| `kernel/lwext4/` | 第三方 **lwext4** 库（完整 ext4 文件系统实现） |

#### 6. 进程加载（exec）
| 文件 | 说明 |
|------|------|
| `kernel/exec.c` / `exec.h` | ELF 加载器，支持 Linux ABI（动态链接器、auxv） |

#### 7. 管道
| 文件 | 说明 |
|------|------|
| `kernel/pipe.c` | 管道实现（512 字节缓冲区） |

#### 8. 网络
| 文件 | 说明 |
|------|------|
| `kernel/net.c` / `net.h` | 网络协议栈（UDP/IP、ARP、socket bind/send/recv） |
| `kernel/virtio_net.c` | virtio-net 网卡驱动 |

#### 9. 设备驱动
| 文件 | 说明 |
|------|------|
| `kernel/uart.c` | UART 串口驱动 |
| `kernel/virtio_disk.c` / `virtio.h` | virtio 块设备驱动 |
| `kernel/plic.c` | PLIC 平台级中断控制器 |
| `kernel/devzero.c` | /dev/null、/dev/zero 设备 |
| `kernel/console.c` | 控制台输入输出 |

#### 10. 中断与陷阱
| 文件 | 说明 |
|------|------|
| `kernel/trap.c` | 中断/异常/系统调用处理 |
| `kernel/trampoline.S` | 用户态/内核态切换蹦床 |
| `kernel/kernelvec.S` | 内核态中断向量 |

#### 11. 系统调用
| 文件 | 说明 |
|------|------|
| `kernel/syscall.c` / `syscall.h` | 系统调用分发、参数获取 |

#### 12. 调试与工具
| 文件 | 说明 |
|------|------|
| `kernel/kcsan.c` | KCSAN 内核并发检测器（基于 GCC ThreadSanitizer） |
| `kernel/printf.c` | 内核 printf |
| `kernel/sprintf.c` | 内核 sprintf |
| `kernel/string.c` | 字符串/内存操作 |
| `kernel/sbi.c` | OpenSBI 接口调用 |

#### 13. 用户空间程序
位于 `user/` 目录，约 30 个用户程序，包括：
- 基础工具：`cat`, `echo`, `ls`, `grep`, `wc`, `find`, `rm`, `mkdir`, `ln`, `kill`, `sleep`
- Shell：`sh`
- 测试程序：`usertests`, `grind`, `cowtest`, `mmaptest`, `nettest`, `pgtbltest`, `alarmtest`, `forktest`, `stressfs`, `logstress`, `sandbox` 等

---

### 四、构建工具需求

根据 `Makefile` 分析，构建该项目需要以下工具：

| 工具 | 用途 |
|------|------|
| **RISC-V 交叉编译工具链** (`riscv64-unknown-elf-` 或 `riscv64-linux-gnu-`) | 编译内核和用户程序（GCC、ld、objdump、objcopy） |
| **QEMU** (`qemu-system-riscv64` >= 7.2) | 模拟运行 |
| **GNU Make** | 构建系统 |
| **Perl** | 生成 `usys.S`（系统调用桩） |
| **Python 3** | 运行评分和测试脚本 |
| **Host GCC** | 编译 `mkfs/mkfs`（文件系统镜像制作工具） |

Makefile 会自动探测可用的 RISC-V 工具链前缀（按优先级：`riscv64-unknown-elf-` → `riscv64-elf-` → `riscv64-linux-gnu-` → `riscv64-unknown-linux-gnu-`）。

---

### 五、关键特性概览

1. **RISC-V 64 位**多核支持（默认 3 个 CPU）
2. **Linux ABI 兼容**：支持 Linux 风格系统调用（clone、futex、mmap、sendto/recvfrom 等），兼容 Linux 动态链接器，可加载 Linux ELF
3. **VFS 抽象层**：统一管理多种文件系统类型（xv6 native、ext4、procfs、tmpfs、devfs）
4. **ext4 支持**：通过集成的 lwext4 库提供 ext4 读写能力
5. **Copy-on-Write (COW)**：写时复制页面
6. **mmap/munmap**：内存映射支持
7. **网络栈**：UDP/IP 协议栈，基于 virtio-net
8. **线程**：Linux clone 语义的线程支持（共享 VM、文件表、文件系统上下文）
9. **信号**：简化的 Linux RT 信号机制
10. **KCSAN**：内核级并发竞态检测

LoongArch 目标在 Makefile 中仅有占位（`kernel-la` 直接复制 RISC-V 内核），表明 LoongArch 后端尚未实现。