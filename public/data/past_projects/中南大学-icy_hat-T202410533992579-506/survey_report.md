## HatOS 项目初步调查报告

### 一、项目概述

HatOS 是一个面向 **RISC-V 64位架构**的宏内核类 Unix 操作系统，使用 **C 语言和汇编语言**编写，以 OpenSBI 作为底层固件支持，目标运行平台为 QEMU（qemu-system-riscv64），同时有 VisionFive2 开发板的适配尝试。项目由中南大学何煦独立完成，部分代码基于 xv6-riscv 修改，并集成了 lwext4（ext4文件系统）和 buddy（伙伴分配器）两个第三方库。项目总代码量约 **26,459 行**（含第三方库）。

---

### 二、仓库文件组织结构

```
.
├── boot/                    # 启动引导代码
│   ├── entry.S              #   入口汇编（_entry）
│   ├── start.c              #   C 语言启动初始化
│   └── main.c               #   内核主函数入口
├── kernel/                  # 内核核心代码
│   ├── kernel.ld            #   内核链接脚本（入口地址 0x80200000）
│   ├── driver/              #   设备驱动
│   ├── fs/                  #   文件系统
│   ├── lock/                #   同步锁机制
│   ├── mm/                  #   内存管理
│   ├── proc/                #   进程管理
│   ├── signal/              #   信号机制
│   ├── syscall/             #   系统调用
│   ├── trap/                #   异常与中断处理
│   └── util/                #   工具函数
├── include/                 # 头文件
│   ├── defs.h               #   全局函数声明
│   ├── types.h              #   基础类型定义
│   ├── param.h              #   系统参数常量
│   ├── memlayout.h          #   内存布局定义
│   ├── riscv.h              #   RISC-V CSR 寄存器操作
│   ├── fs/                  #   文件系统相关头文件
│   ├── lib/                 #   库/工具头文件
│   ├── proc/                #   进程相关头文件
│   └── syscall/             #   系统调用相关头文件
├── user/                    # 用户态程序与测试
│   ├── Makefile             #   用户程序构建
│   ├── include/             #   用户态头文件（syscall, stdio 等）
│   ├── userentry.S          #   用户程序入口汇编
│   ├── user.ld              #   用户程序链接脚本
│   ├── libMain.c / *.c      #   用户态 C 库实现
│   ├── test*.c              #   测试程序
│   └── binToC.py            #   二进制转 C 数组脚本（嵌入内核）
├── doc/                     # 项目文档
├── Makefile                 # 顶层构建文件
├── .clang-format            # 代码格式化配置
└── .gdbinit.tmpl-riscv      # GDB 调试模板
```

---

### 三、子系统划分

#### 1. 启动子系统 (`boot/`)
- `entry.S`：汇编入口，设置初始栈并跳转
- `start.c`：M-mode 初始化，配置 PMP、委托中断至 S-mode，跳转至 main
- `main.c`：内核主函数，依次初始化各子系统后进入调度器

#### 2. 内存管理子系统 (`kernel/mm/`)
| 文件 | 功能 |
|------|------|
| `pmm.c` | 物理内存管理（页分配/释放，基于 buddy 伙伴分配器） |
| `vmm.c` | 虚拟内存管理（页表创建/映射/拷贝/COW、内核页表） |
| `umm.c` | 用户内存管理（mmap 区域初始化、brk 扩展） |
| `maprw.c` | mmap 缺页处理（MAP_SHARED/MAP_PRIVATE 懒分配） |
| `shm.c` | 共享内存（System V shmget/shmat/shmdt） |
| `mmfix.c` | 内核内存修复/调整 |
| `buddy_malloc.c` | buddy 伙伴分配器封装 |

#### 3. 进程管理子系统 (`kernel/proc/`)
| 文件 | 功能 |
|------|------|
| `proc.c` | 进程创建、fork、exit、wait、进程表管理 |
| `scheduler.c` | 调度器（轮转调度） |
| `exec.c` | execve 实现（ELF 加载） |
| `sleep.c` | 进程睡眠/唤醒机制 |
| `time.c` | 进程时间统计 |
| `uproc.c` | 用户进程相关辅助 |

#### 4. 文件系统子系统 (`kernel/fs/`)
| 文件/目录 | 功能 |
|-----------|------|
| `fs.c` | VFS 层抽象接口 |
| `fd.c` | 文件描述符管理（open/close/dup/fcntl 等） |
| `file.c` | 文件操作抽象 |
| `bio.c` | 块 I/O 缓冲层 |
| `console.c` | 控制台设备驱动 |
| `pipe.c` | 管道实现 |
| `ext4_fs.c` / `ext4_fd.c` | ext4 文件系统适配层 |
| `fat32/` | FAT32 文件系统实现（可选，通过编译宏切换） |
| `lwext4/` | 第三方 lwext4 库（ext4 核心实现，约 18,000 行） |

#### 5. 设备驱动子系统 (`kernel/driver/`)
| 文件 | 功能 |
|------|------|
| `virtio.c` | VirtIO 块设备驱动 |
| `sd.c` | SD 卡驱动（VisionFive2 适配） |
| `disk.c` | 磁盘抽象层 |
| `ramdisk.c` / `sd_ramdisk.S` | RAM Disk 实现 |
| `uart.c` | UART 串口驱动 |
| `plic.c` | PLIC 中断控制器驱动 |

#### 6. 异常与中断子系统 (`kernel/trap/`)
| 文件 | 功能 |
|------|------|
| `trap.c` | 用户态 trap 处理（系统调用分发、缺页异常） |
| `interupt.c` | 内核态中断处理 |
| `timer.c` | 定时器管理 |
| `uservec.S` | 用户态到内核态切换汇编 |
| `kernelvec.S` | 内核态中断入口汇编 |
| `swtch.S` | 上下文切换汇编 |

#### 7. 信号子系统 (`kernel/signal/`)
| 文件 | 功能 |
|------|------|
| `signal.c` | 信号发送、处理、sigaction/sigreturn |
| `sigevent.c` | 信号事件队列管理 |
| `itimer.c` | 间隔定时器（setitimer/getitimer） |
| `sigtrampoline.S` | 信号处理返回跳板 |

#### 8. 系统调用子系统 (`kernel/syscall/`)
| 文件 | 功能 |
|------|------|
| `syscall.c` | 系统调用分发表（约 70 个已注册的系统调用） |
| `sys_fs.c` | 文件系统相关系统调用 |
| `sys_proc.c` | 进程相关系统调用（clone/exec/wait/exit 等） |
| `sys_mm.c` | 内存相关系统调用（brk/mmap/munmap/mprotect） |
| `sys_signal.c` | 信号相关系统调用 |
| `sys_info.c` | 系统信息系统调用（uname/sysinfo/gettimeofday 等） |

#### 9. 同步锁子系统 (`kernel/lock/`)
- `spinlock.c`：自旋锁
- `sleeplock.c`：睡眠锁

#### 10. 工具函数 (`kernel/util/`)
- `printf.c`：内核格式化输出
- `string.c`：字符串操作函数
- `debug.c`：调试辅助（页表打印、回溯）
- `qsort.c`：快速排序
- `path.c`：路径处理

---

### 四、已实现的系统调用（约 70 个）

涵盖以下类别：
- **文件操作**：openat, close, read, write, pread64, pwrite64, readv, writev, lseek, getdents64, linkat, unlinkat, mkdirat, symlinkat, faccessat, fstat, fstatat, fcntl, ioctl, chdir, getcwd, sendfile, sync, fsync, ppoll, pselect6, utimensat
- **进程管理**：clone, execve, wait4, exit, exit_group, getpid, getppid, gettid, set_tid_address, sched_yield
- **内存管理**：brk, mmap, munmap, mprotect, msync, madvise
- **信号**：rt_sigaction, rt_sigreturn, rt_sigprocmask, kill, setitimer, getitimer
- **系统信息**：uname, sysinfo, gettimeofday, clock_gettime, times, getrandom, syslog, reboot
- **身份**：getuid, geteuid, getegid, getpgid
- **挂载**：mount, umount2

---

### 五、构建工具需求

| 工具 | 用途 | 当前环境可用性 |
|------|------|----------------|
| `riscv64-unknown-elf-gcc` | RISC-V 裸机交叉编译器 | 可用（RISC-V cross toolchain） |
| `riscv64-unknown-elf-ld` | 链接器 | 可用 |
| `riscv64-unknown-elf-as` (gas) | 汇编器 | 可用 |
| `riscv64-unknown-elf-objcopy` | 目标文件转换 | 可用 |
| `riscv64-unknown-elf-objdump` | 反汇编 | 可用 |
| `qemu-system-riscv64` | QEMU 模拟器 | 可用 |
| `GNU Make` | 构建系统 | 可用 |
| `Python3` | 用户程序二进制转 C 数组脚本 | 可用 |
| `OpenSBI` (bios default) | SBI 固件 | 可用 |
| `mkfs.ext4` / `dd` | 文件系统镜像制作 | 可用 |
| `mkimage` (U-Boot) | 制作 uImage（VisionFive2 用） | 可用 |
| `GDB` | 调试 | 可用 |

构建命令为 `make all`（编译内核），`make qemu`（编译并运行），用户程序通过 `user/Makefile` 单独构建后以二进制形式嵌入内核镜像。

---

### 六、关键设计特征

1. **内存布局**：物理内存 128MB（0x80000000 - 0x88000000），内核虚拟地址通过偏移 0x3f00000000 直接映射，用户空间 3GB，用户栈 2MB。
2. **多核支持**：最多 3 个 CPU（NCPU=3），默认启动 2 核（CPUS=2）。
3. **文件系统双模式**：通过编译宏 `FSTYPE` 在 ext4 和 FAT32 之间切换，默认使用 ext4。
4. **平台适配**：支持 QEMU virt 机器、QEMU sifive_u 机器和 VisionFive2 开发板三种平台配置。
5. **COW（写时复制）**：在 vmm.c 中实现了 fork 时的写时复制机制。
6. **信号机制**：实现了完整的 POSIX 信号处理流程，包括信号队列、sigaction、sigreturn 跳板。
7. **共享内存**：通过父子进程共享页表项实现 MAP_SHARED，使用独立 buddy 分配器管理 System V 共享内存。