# 项目初步调查报告

## 一、项目基本信息

- **项目名称**：oskernel2026-tmtos
- **参赛队伍**：再来两次（内蒙古大学）
- **比赛**：2026 全国大学生计算机系统能力大赛 · 操作系统内核实现赛
- **项目来源**：基于 MIT xv6-riscv，经 HUST-OS xv6-k210 改造后，再剥离回 QEMU virt 平台
- **许可证**：MIT（原始 xv6）+ BSD-2-Clause（lwext4）

## 二、仓库顶层结构

```
.
├── Makefile              # 主构建文件，make all → kernel-rv + kernel-la
├── README.md             # 项目说明、进度、测试状态
├── LICENSE               # MIT 许可证
├── .gitignore
├── kernel/               # 内核源码（主体）
├── xv6-user/             # 传统 xv6 用户态程序（保留，非评测主线）
├── linker/               # 链接脚本（RISC-V + LoongArch）
├── docs/                 # 设计文档、协作规范、测试矩阵
└── scripts/              # 辅助脚本（构建测试镜像）
```

## 三、内核子系统划分

### 1. 内存管理
| 文件 | 功能 |
|------|------|
| `kernel/kalloc.c` | 物理页分配器（约 2KB） |
| `kernel/vm.c` | 虚拟内存管理、页表操作、mmap/munmap/brk（约 18KB） |
| `kernel/include/kalloc.h` | 物理分配器接口 |
| `kernel/include/vm.h` | 虚拟内存接口 |
| `kernel/include/memlayout.h` | 内存布局常量 |

### 2. 进程管理
| 文件 | 功能 |
|------|------|
| `kernel/proc.c` | 进程管理：fork/clone/wait/exit/kill/调度器（约 34KB） |
| `kernel/swtch.S` | 内核上下文切换汇编 |
| `kernel/include/proc.h` | 进程结构体定义（proc, cpu, context 等） |
| `kernel/include/param.h` | 系统参数：NPROC=128, NCPU=2, NOFILE=128 等 |

### 3. 系统调用
| 文件 | 功能 |
|------|------|
| `kernel/syscall.c` | Linux generic ABI 系统调用分发（约 73KB，最大文件之一） |
| `kernel/sysfile.c` | 文件系统相关系统调用（约 75KB） |
| `kernel/sysproc.c` | 进程相关系统调用（约 10KB） |
| `kernel/include/syscall.h` | 系统调用声明 |
| `kernel/include/sysnum.h` | 系统调用号定义：Linux generic（17~452）+ xv6 内部（5000+） |

### 4. 文件系统
| 文件 | 功能 |
|------|------|
| `kernel/file.c` | 文件描述符层：FD_DEVICE/FD_PIPE/FD_EXT4/FD_MEM/FD_SOCKET（约 24KB） |
| `kernel/bio.c` | 块缓冲区缓存（约 3.5KB） |
| `kernel/ext4_glue.c` | lwext4 ↔ 内核桥接层：malloc/块设备/qsort 桩（约 6KB） |
| `kernel/fat32.c` | 旧 FAT32 驱动，保留但非 EXT4 主数据路径（约 30KB） |
| `kernel/lwext4/` | 引入的 EXT4 驱动（BSD-2-Clause），约 22 个 C 源文件 |
| `kernel/include/file.h` | 文件结构体定义（file, memfile_ref, devsw） |
| `kernel/include/buf.h` | 缓冲区头定义 |
| `kernel/include/fat32.h` | FAT32 接口 |
| `kernel/include/ext4_glue.h` | ext4 桥接接口 |

### 5. ELF 加载器
| 文件 | 功能 |
|------|------|
| `kernel/exec_elf.c` | EXT4 上 ET_EXEC/ET_DYN RISC-V 静态 ELF 加载器（约 44KB） |
| `kernel/exec.c` | 传统 FAT32 exec 加载（约 5KB） |
| `kernel/include/exec_elf.h` | ELF 加载器接口 |
| `kernel/include/elf.h` | ELF 结构定义 |

### 6. 中断与陷阱
| 文件 | 功能 |
|------|------|
| `kernel/trap.c` | 陷阱处理（约 8KB） |
| `kernel/intr.c` | 中断处理入口（约 1KB） |
| `kernel/kernelvec.S` | 内核陷阱向量（约 2KB） |
| `kernel/trampoline.S` | 用户态↔内核态跳板（约 4KB） |
| `kernel/plic.c` | PLIC 中断控制器（约 1.5KB） |
| `kernel/include/trap.h` | 陷阱帧定义 |
| `kernel/include/plic.h` | PLIC 寄存器定义 |

### 7. 定时器
| 文件 | 功能 |
|------|------|
| `kernel/timer.c` | 定时器中断 + watchdog 轮询（约 1KB） |
| `kernel/include/timer.h` | 定时器接口 |

### 8. 同步原语
| 文件 | 功能 |
|------|------|
| `kernel/spinlock.c` | 自旋锁（约 2KB） |
| `kernel/sleeplock.c` | 睡眠锁（约 1KB） |
| `kernel/include/spinlock.h` | 自旋锁定义 |
| `kernel/include/sleeplock.h` | 睡眠锁定义 |

### 9. 设备驱动
| 文件 | 功能 |
|------|------|
| `kernel/uart.c` | NS16550 UART 驱动（约 5KB） |
| `kernel/console.c` | 控制台抽象（约 4KB） |
| `kernel/virtio_disk.c` | virtio-mmio 块设备驱动（约 8KB） |
| `kernel/disk.c` | 磁盘抽象层（约 0.7KB） |
| `kernel/la_virtio_pci.c` | LoongArch virtio-pci 块设备驱动（约 15KB） |

### 10. IPC（进程间通信）
| 文件 | 功能 |
|------|------|
| `kernel/pipe.c` | 管道实现（约 2.5KB） |
| `kernel/include/pipe.h` | 管道结构体 |

### 11. 测试运行器
| 文件 | 功能 |
|------|------|
| `kernel/teststub.c` | RISC-V 测试运行器：basic/busybox/lua/libctest/libcbench/ltp 真实执行（约 73KB） |
| `kernel/la_basic.c` | LoongArch 测试运行器：basic/busybox/lua/libctest/lmbench/ltp（约 140KB，最大文件） |

### 12. 架构特定代码

**RISC-V 主线**：
| 文件 | 功能 |
|------|------|
| `kernel/entry_qemu.S` | RISC-V QEMU 启动入口 |
| `kernel/main.c` | RISC-V 子系统初始化序列 |
| `kernel/kernelvec.S` | 内核陷阱向量 |
| `kernel/trampoline.S` | 用户态切换跳板 |

**LoongArch 辅线**：
| 文件 | 功能 |
|------|------|
| `kernel/entry_la.S` | LoongArch 启动入口 |
| `kernel/main_la.c` | LoongArch 启动与运行器调用 |
| `kernel/la_lib.c` | LoongArch 辅助库（UART、字符串等） |
| `kernel/la_trap_user.S` | LoongArch 用户态陷阱处理 |
| `kernel/la_user_smoke.S` | LoongArch 用户态冒烟测试 |

### 13. 基础库
| 文件 | 功能 |
|------|------|
| `kernel/printf.c` | 格式化输出 |
| `kernel/string.c` | 字符串/内存操作 |
| `kernel/logo.c` | 启动 Logo 打印 |

### 14. 用户态程序（xv6-user/）
保留的传统 xv6 用户程序（cat, echo, grep, ls, kill, mkdir, rm, wc, sh 等约 30 个），但实际评测使用 EXT4 镜像中的官方测试二进制，这些程序主要用于本地 FAT32 镜像测试。

## 四、构建工具需求

根据 Makefile 分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| `riscv64-linux-gnu-gcc` (13.x) | RISC-V 内核编译 |
| `riscv64-linux-gnu-ld` | RISC-V 内核链接 |
| `riscv64-linux-gnu-objdump/objcopy` | 目标文件处理 |
| `loongarch64-linux-gnu-gcc` | LoongArch 内核编译 |
| `loongarch64-linux-gnu-ld` | LoongArch 内核链接 |
| `loongarch64-linux-gnu-objdump` | LoongArch 反汇编 |
| `qemu-system-riscv64` (10.x) | RISC-V 模拟（本地测试） |
| `perl` | 生成 xv6-user/usys.S |
| Docker | 官方构建环境 `zhouzhouyi/os-contest:20260510` |
| `mkfs.vfat`/`mkfs.ext4`/`dd` | 文件系统镜像制作（本地测试） |
| `git` | 获取测试套件 |

## 五、初步判断

1. **架构策略**：RISC-V 为主力开发线（完整的内存管理、进程管理、EXT4 文件系统），LoongArch 为辅线（最小化内核，主要用于满足双架构要求）。两架构共享 lwext4 文件系统驱动。

2. **代码量分布**：测试运行器（`teststub.c`、`la_basic.c`）和系统调用（`syscall.c`、`sysfile.c`）占据最大代码量，合计约 360KB。这符合比赛项目特征——大量精力投入在测试适配和系统调用兼容上。

3. **文件系统演进**：项目经历了从 FAT32 到 EXT4 的迁移。FAT32 代码保留但已不处于主数据路径，当前通过引入的 lwext4 库和自写的桥接层 `ext4_glue.c` 访问 EXT4 镜像。

4. **系统调用 ABI**：采用 Linux generic ABI（与 RISC-V Linux 一致），系统调用号对齐 Linux asm-generic/unistd.h，同时将 xv6 原生系统调用号迁移至 5000+ 区域以避免冲突。

5. **构建产物**：`make all` 产出两个 ELF 文件——`kernel-rv`（RISC-V）和 `kernel-la`（LoongArch），分布在仓库根目录，供评测器加载。