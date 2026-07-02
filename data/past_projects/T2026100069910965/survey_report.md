## OSKernel2026 项目初步分析报告

### 一、项目概览

该项目是一个从零实现的 C 语言 OS 内核，参赛于 2026 年 OS 内核实现竞赛。项目同时支持 **RISC-V 64** 和 **LoongArch 64** 双架构，在 QEMU 9.2.1 下运行。核心设计决策是让 PID 1 运行真实 busybox 解释器来执行测试脚本，以逐字节匹配官方期望输出。

---

### 二、文件组织结构

```
.
├── Makefile                  # 顶层构建文件（双架构编译）
├── README.md                 # 项目说明
├── COMMON_ERRORS.md          # 常见问题记录
├── process                   # 未知用途文件（52KB，非源代码）
├── arch/                     # 架构相关代码
│   ├── riscv/                #   RISC-V 架构（11 个文件）
│   │   ├── boot.S            #     启动入口（hart 过滤、BSS 清零）
│   │   ├── linker.ld         #     链接脚本（加载地址 0x80200000）
│   │   ├── trap.c            #     内核态 trap 分发
│   │   ├── trapentry.S       #     内核 trap 向量（全寄存器保存/恢复）
│   │   ├── trampoline.S      #     用户态 trap 蹦床（satp 切换）
│   │   ├── usertrap.c        #     用户态 trap 处理
│   │   ├── swtch.S           #     上下文切换汇编
│   │   ├── mmu.c             #     Sv39 页表管理
│   │   ├── sbi.c             #     SBI 调用（UART、关机、定时器）
│   │   ├── timer.c           #     SBI 周期时钟（100Hz）
│   │   └── fdt.c             #     设备树内存解析
│   └── loongarch/            #   LoongArch 架构（8 个文件）
│       ├── boot.S            #     启动入口
│       ├── linker.ld         #     链接脚本
│       ├── trap.c            #     内核 trap 分发
│       ├── trapentry.S       #     trap 向量
│       ├── usertrap.c        #     用户态 trap 处理
│       ├── swtch.S           #     上下文切换
│       ├── mmu.c             #     软件 TLB 填充
│       └── power.c           #     ACPI 关机
├── kernel/                   # 内核核心（8 个文件）
│   ├── main.c                #   内核入口、子系统初始化、PID1 测试运行器
│   ├── proc.c                #   进程表、内核线程、轮转调度、sleep/wakeup
│   ├── cpu.c                 #   per-CPU 状态（单核）
│   ├── elf.c                 #   ELF64 加载器（PT_LOAD + auxv 所需信息）
│   ├── exec.c                #   exec_user/exec_replace（完整初始栈构建）
│   ├── syscall.c             #   系统调用按号分发表
│   ├── sysfile.c             #   文件相关系统调用（open/close/read/write/stat/pipe 等）
│   └── sysproc.c             #   进程相关系统调用（fork/clone/execve/wait4/mmap 等）
├── mm/                       # 内存管理（2 个文件）
│   ├── pmm.c                 #   物理页帧分配器（4KiB 空闲链表 + 引用计数）
│   └── kheap.c               #   内核堆分配器（地址有序、合并）
├── fs/                       # 文件系统（3 个文件 + 子目录）
│   ├── file.c                #   文件对象层（ext4 inode / ramfs / pipe / console 路由）
│   ├── pipe.c                #   阻塞字节流管道（环形缓冲区）
│   └── ext4/
│       └── ext4.c            #   只读 ext4 驱动（超级块、inode、extent 树、目录查找）
├── drivers/                  # 设备驱动（1 个文件）
│   └── virtio_blk.c          #   virtio-blk 块设备驱动（MMIO、轮询）
├── lib/                      # 库函数（2 个文件）
│   ├── printf.c              #   printk/snprintk 格式化输出
│   └── string.c              #   字符串和内存操作（strlen/strcmp/memcpy/memset 等）
├── include/                  # 头文件
│   ├── kernel/               #   内核头文件（16 个）
│   │   ├── types.h           #     定宽类型、NULL、bool
│   │   ├── param.h           #     全局常量（PGSIZE、NPROC、NOFILE 等）
│   │   ├── memlayout.h       #     虚拟地址布局（TRAMPOLINE/TRAPFRAME/USTACK）
│   │   ├── proc.h            #     进程模型与调度器接口
│   │   ├── vm.h              #     虚拟内存接口（页表/copyin-out）
│   │   ├── mm.h              #     物理/内核内存管理 API
│   │   ├── syscall.h         #     Linux 通用 ABI 系统调用号（约 120+ 个）
│   │   ├── trap.h            #     trap 与定时器接口
│   │   ├── riscv.h           #     RISC-V CSR/PTE/中断位内联封装
│   │   ├── loongarch.h       #     LoongArch CSR 常量定义
│   │   ├── elf.h             #     ELF64 结构定义
│   │   ├── errno.h           #     Linux 负 errno
│   │   ├── printk.h          #     内核打印接口
│   │   ├── kio.h             #     架构中立控制台/中断/关机接口
│   │   ├── compiler.h        #     编译器辅助宏
│   │   └── addr.h            #     地址相关宏
│   ├── fs/                   #   文件系统头文件（4 个）
│   │   ├── file.h            #     文件对象、ramfs、pipe 接口
│   │   ├── ext4.h            #     ext4 驱动接口
│   │   ├── fcntl.h           #     文件控制常量
│   │   └── stat.h            #     文件状态结构
│   └── drivers/              #   驱动头文件（1 个）
│       └── blkdev.h          #     块设备抽象接口
├── docs/                     # 文档（8 个文件）
│   ├── architecture.md       #   架构与文件树说明
│   ├── roadmap.md            #   路线图
│   ├── progress.md           #   进度跟踪
│   └── ...                   #   答辩、LTP 计划等
└── tools/                    # 工具与测试（16 个文件）
    ├── contest.sh / contest.ps1   #   竞赛辅助脚本
    ├── smoke-*.sh                 #   冒烟测试脚本（basic/busybox/heavy/iozone/mmap/pipe 等）
    ├── user-rv.ld                 #   用户程序链接脚本
    └── usertests/                 #   用户态测试代码
```

---

### 三、子系统划分

| 子系统 | 目录/文件 | 代码量（行） | 核心职责 |
|--------|-----------|:----------:|----------|
| **构建系统** | `Makefile` | ~70 | 双架构交叉编译，自动检测工具链，生成 `kernel-rv` 和 `kernel-la` |
| **架构层 - RISC-V** | `arch/riscv/` | 773 + 349 (汇编) | Sv39 页表、trap 入口/返回、上下文切换、SBI 调用、定时器、设备树 |
| **架构层 - LoongArch** | `arch/loongarch/` | 576 + 169 (汇编) | 软件 TLB 管理、trap 入口、ACPI 关机（尚在追赶 RISC-V 进度） |
| **进程管理** | `kernel/proc.c`, `kernel/cpu.c` | 728 | 进程表、内核线程、轮转调度器、sleep/wakeup、proc_alloc/proc_exit |
| **系统调用** | `kernel/syscall.c`, `kernel/sysfile.c`, `kernel/sysproc.c` | 3122 | Linux ABI 兼容 syscall 分发（约 120+ 号），文件/进程/内存相关实现 |
| **程序加载** | `kernel/elf.c`, `kernel/exec.c` | 633 | ELF64 解析加载、用户初始栈（argc/argv/envp/auxv）构建 |
| **内核入口** | `kernel/main.c` | 324 | 子系统依次初始化、PID1 测试运行器 |
| **内存管理** | `mm/pmm.c`, `mm/kheap.c` | 218 | 物理页帧分配器（空闲链表+引用计数）、内核堆（地址有序+合并） |
| **文件系统** | `fs/file.c`, `fs/pipe.c`, `fs/ext4/ext4.c` | 1334 | VFS 文件对象层、ramfs（可写）、ext4（只读、extent 树）、阻塞管道 |
| **块设备驱动** | `drivers/virtio_blk.c` | 328 | virtio-blk over MMIO（legacy + modern 双模式，轮询 I/O） |
| **库函数** | `lib/printf.c`, `lib/string.c` | 276 | 裸机 printk 格式化输出、字符串/内存操作 |
| **头文件** | `include/` | 16 + 4 + 1 | 类型定义、接口声明、常量、系统调用号 |

---

### 四、构建工具链

根据 Makefile 分析，构建需要以下工具：

| 工具 | 用途 | 备选方案（自动检测） |
|------|------|---------------------|
| **RISC-V 交叉编译器** | 编译 `kernel-rv` | `riscv64-linux-gnu-gcc` → `riscv64-linux-gcc` → `riscv64-unknown-elf-gcc` |
| **LoongArch 交叉编译器** | 编译 `kernel-la` | `loongarch64-linux-gnu-gcc` → `loongarch64-linux-musl-gcc` |
| **GNU Make** | 构建自动化 | 必需 |
| **QEMU** | 本地冒烟测试 | `qemu-system-riscv64` / `qemu-system-loongarch64` |
| **Docker** | 竞赛官方验证环境 | `zhouzhouyi/os-contest:20260510` |

编译选项方面：
- 通用：`-O2 -g -std=gnu11 -ffreestanding -fno-builtin -nostdlib -fno-stack-protector`
- RISC-V：`-march=rv64gc -mabi=lp64 -mcmodel=medany`
- LoongArch：`-march=loongarch64 -mabi=lp64d -mcmodel=normal`
- 链接：`-nostdlib -static -no-pie --gc-sections --build-id=none`

环境中已有的 `RISC-V_musl_toolchain`、`RISC-V_linux_gnu_toolchain`、`RISC-V_cross_toolchain` 和 `LoongArch_cross_toolchain` 均能覆盖构建需求。

---

### 五、当前实现状态摘要

根据 `docs/architecture.md` 和 `README.md`：

- **Phase 0-4 已完成（RISC-V）**：骨架启动、内存管理+进程调度、VFS+ext4 读取+ELF 加载、fork/exec/wait（通过 basic 测试组）、真实 busybox shell（通过 busybox 测试组）。
- **Phase 5（signals + threads）**：进行中，目标通过 libc-test。
- **Phase 6（LoongArch 对等）**：LoongArch 可启动到 banner，核心功能仍在追赶 RISC-V。
- **Phase 7（广度）**：LTP、lua、更多系统调用。