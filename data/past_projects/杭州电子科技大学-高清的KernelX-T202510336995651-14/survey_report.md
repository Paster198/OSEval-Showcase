# KernelX OS 内核项目初步调查报告

## 一、项目概述

KernelX 是一个基于 **RT-Thread Smart** 的微内核操作系统，使用 C 语言开发，由杭州电子科技大学团队（张逸轩、刘镇睿、丁宏阳）为操作系统内核比赛构建。项目核心工作是在 RT-Thread 实时操作系统基础上进行缺陷修复、系统调用 Linux 兼容化改造和功能扩展，以通过比赛测例。

---

## 二、仓库文件组织结构

```
.
├── Containerfile            # Docker 容器构建配置
├── Makefile                 # 顶层 Makefile（仅调用 oscomp/init.sh）
├── README.md                # 项目说明文档
├── run.py                   # 自动化构建/启动脚本（含工具链检索与 Docker 管理）
├── gen_bear.sh              # 生成 compile_commands.json 的辅助脚本
├── docs/                    # 项目文档
│   ├── components/          # 组件文档
│   ├── img/                 # 文档图片
│   ├── KernelX-介绍.md
│   ├── KernelX-环境.md
│   └── RT-Thread-介绍.md
├── machines/                # 板级支持（构建入口）
│   ├── qemu-virt-riscv64/   # RISC-V 64 位 QEMU 虚拟机（主力平台）
│   └── qemu-loongarch/      # LoongArch QEMU 虚拟机
├── oscomp/                  # 比赛测试相关
│   ├── init.sh
│   └── rv/                  # RISC-V 测试用例构建目录
│       ├── Makefile
│       └── src/             # 测试代码（basic, busybox, iozone, libc, lua）
├── rt-thread/               # RT-Thread 内核源码（项目主体）
│   ├── src/                 # 内核核心代码
│   ├── include/             # 内核公共头文件
│   ├── libcpu/              # 架构相关 CPU 支持代码
│   ├── components/          # 组件/子系统
│   ├── bsp/                 # 板级支持包
│   ├── tools/               # 构建工具（SCons 辅助 Python 脚本）
│   └── examples/            # 示例代码
└── toolchains/              # 交叉编译工具链安装脚本
    ├── install_ubuntu.sh
    ├── qemu-virt-riscv64/
    └── qemu-longarch/
```

---

## 三、子系统识别与目录映射

### 1. 内核核心 -- `rt-thread/src/`

| 功能 | 关键文件 |
|------|----------|
| 线程管理 | `thread.c` |
| 调度器（单核/多核） | `scheduler_up.c`, `scheduler_mp.c`, `scheduler_comm.c` |
| IPC（信号量/邮箱等） | `ipc.c` |
| 中断管理 | `irq.c` |
| 内核内存管理 | `mem.c`, `memheap.c`, `mempool.c`, `slab.c` |
| 定时器/时钟 | `timer.c`, `clock.c` |
| 信号 | `signal.c` |
| 对象管理 | `object.c` |
| SMP 支持 | `cpu_mp.c`, `cpu_up.c` |
| 内核 C 库 | `klibc/`（kstring, kstdio, kerrno, vsnprintf, vsscanf） |

内核核心代码量约 **20,492 行**（C/H 文件合计）。

### 2. 轻量级进程（LWP）子系统 -- `rt-thread/components/lwp/`

这是项目**最核心的扩展区域**，实现用户态进程/进程管理，代码量约 **41,250 行**。

| 功能 | 关键文件/目录 |
|------|---------------|
| 系统调用实现 | `lwp_syscall.c`, `syscall/`（按功能分文件：fs, process, thread, signal, mm, sched, clock, timer, sync, device, event, sal 等） |
| 进程管理 | `lwp.c`, `lwp_pid.c`, `lwp_pgrp.c`, `lwp_session.c`, `lwp_jobctrl.c` |
| 用户态内存管理 | `lwp_mm.c`, `lwp_user_mm.c` |
| 信号机制 | `lwp_signal.c` |
| Futex | `lwp_futex.c`, `lwp_futex_table.c` |
| 进程间通信 | `lwp_ipc.c` |
| 共享内存 | `lwp_shm.c` |
| 终端/TTY | `terminal/`（基于 FreeBSD TTY 移植，含 pts, ptmx, tty_disc 等） |
| vDSO | `vdso/` |
| ELF 加载 | `lwp_elf.c` |
| 架构相关 | `arch/`（risc-v/rv64, aarch64, arm, x86/i386） |

### 3. 设备文件系统（DFS）-- `rt-thread/components/dfs/`

包含两个版本：
- **dfs_v1**：基础 VFS 实现（dfs, dfs_file, dfs_fs, dfs_posix）
- **dfs_v2**：增强版 VFS，新增 dentry, vnode, mnt, pcache, seq_file, file_mmap 等模块

### 4. 内存管理组件 -- `rt-thread/components/mm/`

| 功能 | 文件 |
|------|------|
| 地址空间管理 | `mm_aspace.c` |
| 页管理 | `mm_page.c` |
| 缺页异常处理 | `mm_fault.c` |
| 匿名页管理 | `mm_anon.c` |
| 内核内存 | `mm_kmem.c` |
| memblock | `mm_memblock.c` |
| IO 重映射 | `ioremap.c` |
| AVL 树适配 | `avl_adpt.c` |

### 5. 内存保护组件 -- `rt-thread/components/mprotect/`

实现 `mprotect` 系统调用所需的内存区域保护功能，含示例代码。

### 6. 设备驱动框架 -- `rt-thread/components/drivers/`

涵盖 30 余个驱动子系统，主要包括：

| 驱动类别 | 子目录 |
|----------|--------|
| VirtIO | `virtio/`（virtio-blk, virtio-net, virtio-console, virtio-gpu, virtio-input） |
| 块设备 | `block/`, `nvme/`, `scsi/`, `mtd/` |
| 串口 | `serial/` |
| 网络 | 通过 `net/` 组件 |
| PCI | `pci/` |
| 其他 | pin, spi, i2c, usb, audio, graphic, dma, rtc, watchdog, thermal, sensor 等 |

### 7. 网络子系统 -- `rt-thread/components/net/`

- **lwIP** 协议栈（含 1.4.1, 2.0.3, 2.1.2 三个版本）
- **SAL**（Socket Abstraction Layer）
- **AT** 命令框架
- **netdev** 网络设备管理
- DHCP/NAT 扩展

### 8. C 标准库适配 -- `rt-thread/components/libc/`

- 支持 musl, newlib, picolibc, armlibc, dlib 多种编译器 libc
- POSIX 兼容层：pthreads, signal, ipc, io, delay, libdl, tls
- C++ 支持

### 9. CPU 架构支持 -- `rt-thread/libcpu/`

| 架构 | 目录 | 本项目使用情况 |
|------|------|----------------|
| RISC-V | `risc-v/`（common, common64, rv64, virt64, starfive, t-head, vector） | **主力架构** |
| LoongArch | `loongarch/common/` | 辅助架构 |
| AArch64, ARM, MIPS, PPC 等 | 各自目录 | 未在本项目中使用 |

### 10. 其他组件

| 组件 | 目录 | 功能 |
|------|------|------|
| finsh | `components/finsh/` | RT-Thread 内置 Shell |
| vbus | `components/vbus/` | 虚拟总线 |
| fal | `components/fal/` | Flash 抽象层 |
| utilities | `components/utilities/` | ulog（日志）、libadt（数据结构）、utest（单元测试）、resource 等 |
| legacy | `components/legacy/` | 旧版兼容（dfs, fdt, ipc, usb） |

---

## 四、目标平台

| 平台 | 架构 | 构建入口 | QEMU 配置 |
|------|------|----------|-----------|
| QEMU virt RISC-V 64 | riscv64 | `machines/qemu-virt-riscv64/` | virt 机器, 256M RAM, VirtIO blk/net/serial |
| QEMU virt LoongArch | loongarch64 | `machines/qemu-loongarch/` | virt 机器 |

---

## 五、构建工具链需求

| 工具 | 用途 | 必要性 |
|------|------|--------|
| **SCons** | 主构建系统（RT-Thread 使用 SCons + Python 脚本） | 必须 |
| **RISC-V GCC 交叉编译器** | 编译内核（`riscv64-unknown-elf-gcc` 或 `riscv64-linux-musleabi-gcc`） | 必须 |
| **LoongArch GCC 交叉编译器** | LoongArch 平台编译 | 可选 |
| **Python 3** | 构建脚本运行环境，需 kconfiglib, tqdm, requests, yaml 库 | 必须 |
| **GNU Make** | 测试用例构建（`oscomp/rv/Makefile`） | 必须 |
| **QEMU riscv64** | 运行与调试（`qemu-system-riscv64`） | 运行必须 |
| **mkfs.fat / dd** | 制作测试磁盘镜像 | 运行必须 |
| **pkgs** | RT-Thread 包管理器（下载第三方包如 lwext4） | 首次构建必须 |
| **GDB** | 调试（已提供 `.gdbinit`） | 可选 |
| **dtc** | 设备树编译 | 可选 |

构建流程：在 `machines/qemu-virt-riscv64/` 目录下执行 `pkgs --update` 后运行 `scons -j$(nproc)` 生成 `rtthread.bin`，再通过 `run.sh` 脚本使用 QEMU 启动。测试用例在 `oscomp/rv/` 下通过 `make all` 编译为磁盘镜像。