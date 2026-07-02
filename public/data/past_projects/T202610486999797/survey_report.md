# AuroraKernel 项目初步探索报告

## 1. 项目概要

AuroraKernel 是一个面向全国大学生计算机系统能力大赛（操作系统设计赛-内核实现赛道）的**宏内核**项目，目标是在 QEMU 环境下同时支持 **RISC-V 64-bit** 与 **LoongArch64** 双架构。项目基于 xv6 风格结构演进而来，采用"共享语义、后端适配"的架构，核心共享层与架构后端通过一组 `include/arch/` 头文件中的 `static inline` 函数（即"架构契约层"）进行解耦。

## 2. 仓库目录结构

```
.
├── include/                     # 公共头文件与架构抽象契约
│   ├── arch/                    # 架构差异抽象层：cpu、mmu、proc、syscall、trap、trapframe
│   ├── dev/                     # 设备接口：block、console、plic、sbi、timer、uart、virtio
│   ├── fs/                      # 文件系统接口：VFS、FAT32、EXT4、pipe、procfs、memfile 等
│   ├── lib/                     # 基础库接口：lock、print、str
│   ├── mem/                     # 内存接口：kmalloc、mmap、pmem、vmem
│   ├── proc/                    # 进程接口：proc、scheduler、fd_table、elf、pid 等
│   ├── syscall/                 # 系统调用接口：syscall、sysfunc、sysnum
│   ├── trap/                    # trap 接口
│   ├── common.h                 # 全局类型定义与常量
│   ├── memlayout.h              # RISC-V 物理/虚拟内存布局（RISC-V 侧使用）
│   └── riscv.h                  # RISC-V 寄存器操作宏
├── kernel/                      # 内核源代码
│   ├── arch/
│   │   ├── riscv64/             # RISC-V 架构后端
│   │   │   ├── boot/            # 启动入口 (main.c, start.c)
│   │   │   ├── dev/             # 架构设备 (plic, sbi, timer, uart)
│   │   │   ├── trap/            # 异常/trap (trap.S, trampoline.S)
│   │   │   ├── proc/            # 上下文切换 (swtch.S)
│   │   │   ├── entry.S          # 内核入口
│   │   │   ├── kernel.ld        # 链接脚本
│   │   │   └── Makefile
│   │   └── loongarch64/         # LoongArch64 架构后端
│   │       ├── platform/        # 平台抽象 (boot_info, cpu, csr, early_console, irq, timer)
│   │       ├── trap/            # trap 处理 (trap_entry.S, tlb_refill.S, user_return.S, proc_return)
│   │       ├── proc/            # 进程支持 (swtch.S, current, kstack, prepare, scheduler_return)
│   │       ├── mm/              # 架构内存管理 (address, layout, memory_discovery, memory_map, vm, pmem_boot)
│   │       ├── fs/              # 文件系统运行时钩子 (runtime_hooks, user_copy)
│   │       ├── storage/         # 存储子系统 (PCI, VirtIO-PCI block, ext4_probe)
│   │       ├── shared/          # 共享内核对象（从 kernel/ 编译到 shared/）
│   │       ├── entry.S / boot.c # 入口
│   │       ├── kernel.ld        # 链接脚本
│   │       └── Makefile
│   ├── dev/                     # 共享设备层 (block, console, timer, virtio)
│   ├── fs/                      # 共享文件系统 (VFS, FAT32, EXT4, pipe, memfile, procfs, buffer cache 等)
│   ├── lib/                     # 共享基础库 (print, spinlock, sleeplock, str)
│   ├── mem/                     # 共享内存管理 (kmalloc, kvm, mmap, pmem, uvm)
│   ├── proc/                    # 共享进程管理 (proc, scheduler, exec, fork/exit/wait, fd_table, pid)
│   ├── syscall/                 # 共享系统调用层 (syscall 分发, sysfile, sysproc 系列)
│   └── trap/                    # 共享 trap 处理 (trap_kernel, trap_user)
├── user/                        # 用户态代码 (initcode, 测试程序启动器, 用户库)
├── mkfs/                        # 文件系统镜像制作工具 (mkfs.c)
├── docs/                        # 文档与开发记录
│   ├── competition/             # 竞赛相关
│   ├── dev-context/             # 开发上下文（各测试组件兼容性）
│   ├── la/                      # LoongArch 专项文档
│   ├── ltp-musl-rv-context.md   # LTP 测试上下文
│   ├── meta/                    # 功能路线图与状态
│   └── test-tools/              # 测试工具说明
├── picture/                     # 设计图例
├── Makefile                     # 顶层 Makefile
├── common.mk                    # 公共构建变量与工具链配置
├── Dockerfile                   # Docker 构建环境
├── design.md                    # 系统设计文档 (中文)
├── AuroraKernel设计文档.pdf     # 完整设计文档 PDF
├── AuroraKernel设计文档.txt     # 设计文档纯文本
├── xv6-vs-ours.md               # 与 xv6 对比文档
├── oscomp_syscall.md            # 系统调用参考
└── fat32-info.md                # FAT32 设计说明
```

## 3. 子系统划分

### 3.1 架构抽象契约层 (`include/arch/`)

这是双架构支持的关键。通过 `#if defined(__loongarch64)` 条件编译，将 RISC-V 和 LoongArch64 的差异封装在 `static inline` 辅助函数中。主要契约文件：

| 文件 | 合约内容 |
|------|----------|
| `cpu.h` | CPU ID 获取 (`arch_cpu_id`) |
| `mmu.h` | 页表 token / TLB 刷新 (`arch_mmu_*`) |
| `proc.h` | 进程上下文、内核栈、trapframe 分配/映射、用户态返回 (`arch_proc_*`) |
| `syscall.h` | 系统调用号/参数/返回值读取、用户态 PC 推进 (`arch_syscall_*`) |
| `trapframe.h` | trapframe 字段访问器 (`arch_tf_*`) |
| `trapframe_types.h` | trapframe 结构体定义 |
| `intr.h` | 中断开关 (`arch_intr_on/off`) |
| `trap.h` | (当前为空或轻量，委托给 trapframe) |
| `time.h` | 时间相关抽象 |

### 3.2 共享内核层 (`kernel/` 下非 arch 目录)

这些是架构无关（通过 `include/arch/` 契约间接使用架构功能）的内核子系统：

| 目录 | 子系统 | 代码量(行) | 职责 |
|------|--------|-----------|------|
| `kernel/proc/` | 进程管理 | 3,363 | 进程生命周期(fork/exec/exit/wait)、PID 分配、调度器核心、FD 表、ELF 加载 |
| `kernel/syscall/` | 系统调用 | 8,913 | syscall 分发、文件系统调用(sysfile)、进程系统调用(sysproc)及各类 light 兼容层 |
| `kernel/fs/` | 文件系统 | 8,702 | VFS 框架、FAT32、EXT4、pipe、memfile、procfs、buffer cache、路径解析、挂载管理 |
| `kernel/mem/` | 内存管理 | 1,386 | 物理页分配(pmem)、内核页表(kvm)、用户虚拟内存(uvm)、mmap、kmalloc |
| `kernel/trap/` | Trap 处理 | 266 | 内核态 trap 与用户态 trap 的共享处理逻辑 |
| `kernel/dev/` | 设备抽象 | 539 | 块设备抽象、console、timer、VirtIO 共享层 |
| `kernel/lib/` | 基础库 | 436 | 格式化输出、自旋锁、睡眠锁、字符串操作 |

### 3.3 RISC-V 架构后端 (`kernel/arch/riscv64/`)

| 子目录 | 代码量(行) | 职责 |
|--------|-----------|------|
| `boot/` | 81 | C 入口 `main()`：依次初始化各子系统，启动第一个进程 |
| `dev/` | 230 | PLIC 中断控制器、SBI 调用、timer、UART |
| `trap/` | 251 | 异常向量(trap.S)、trampoline(用户/内核切换) |
| `proc/` | 37 | 上下文切换汇编(swtch.S) |
| 根目录 | 22 | entry.S 启动汇编、kernel.ld 链接脚本 |

### 3.4 LoongArch64 架构后端 (`kernel/arch/loongarch64/`)

| 子目录 | 代码量(行) | 职责 |
|--------|-----------|------|
| `platform/` | 401 | 平台抽象：启动信息、CPU CSR、早期串口、中断控制器(EXTIOI)、timer |
| `trap/` | 478 | 异常入口(trap_entry.S)、TLB refill、用户态返回、进程返回 |
| `proc/` | 1,064 | 上下文切换(swtch.S)、当前进程、内核栈分配、scheduler 返回、元数据验证 |
| `mm/` | 1,005 | 地址空间、内存布局、内存发现(从固件)、内存映射、VM 操作、启动阶段物理页 |
| `fs/` | 133 | 运行时钩子(runtime_hooks)、用户态拷贝(user_copy) |
| `storage/` | 3,234 | PCI 枚举、VirtIO-PCI 块设备(配置/队列/块操作)、EXT4 直接探针 |
| `shared/` | — | 编译时从 `kernel/{dev,fs,proc,syscall,mem,lib}` 拉入共享代码 |

### 3.5 用户态 (`user/`)

包含 initcode（用户态第一个进程）、测试程序选择器、用户库(系统调用封装)。支持通过 `TEST_COMPONENT` 变量选择不同测试负载：basic、busybox、libctest、ltp-musl、Lua、iperf。

## 4. 构建系统

### 4.1 工具链

| 架构 | 默认工具链前缀 | 编译器标志 |
|------|---------------|-----------|
| RISC-V 64 | `riscv64-linux-gnu-` | `-march=rv64gc_zifencei -mcmodel=medany -mno-relax` |
| LoongArch64 | `loongarch64-linux-gnu-` | `-march=loongarch64 -mabi=lp64d` |

### 4.2 构建流程

- **RISC-V**：`make kernel-rv` -> 进入 `kernel/arch/riscv64/`，编译架构目标文件 + 从 `kernel/{dev,fs,lib,mem,proc,syscall,trap}` 编译共享内核对象到 `shared/` 子目录，链接生成 `kernel-rv` ELF。
- **LoongArch64**：`make kernel-la` -> 进入 `kernel/arch/loongarch64/`，编译六个模块的架构目标文件(platform/trap/proc/mm/fs/storage) + 从共享内核目录编译到 `shared/`，链接生成 `kernel-la` ELF。
- 用户态 initcode 通过 `make -C user ARCH=<arch> init` 单独构建。
- 文件系统镜像由 `mkfs/mkfs.c` 制作（FAT32 格式）。

### 4.3 运行环境

- **RISC-V**：`qemu-system-riscv64 -machine virt`，使用 VirtIO-MMIO 块设备
- **LoongArch64**：`qemu-system-loongarch64`，使用 VirtIO-PCI 块设备 + VirtIO 网卡

推荐使用 Docker 镜像 `zhouzhouyi/os-contest:20260510` 作为构建环境。

## 5. 关键特征总结

1. **双架构支持**：通过 `include/arch/` 中的条件编译 + `static inline` 函数实现架构差异封装，共享内核代码无需修改即可跨架构编译。
2. **文件系统丰富**：支持 FAT32（读写）、EXT4（读取路径+元数据缓存）、VFS 抽象层、Buffer Cache、pipe、procfs、memfile、设备文件。
3. **进程管理完整**：fork/clone/execve/exit/wait 生命周期、brk/mmap/munmap/mprotect 内存管理。
4. **Linux ABI 兼容**：存在大量 `_light` 后缀的兼容层文件，逐步覆盖 Linux 系统调用。
5. **测试体系**：覆盖 basic/busybox/libc-test/LTP-musl/Lua/iperf 等多种测试负载。
6. **代码规模**：共享层约 23,968 行 C，RISC-V 后端约 621 行（C+汇编），LoongArch64 后端约 5,753 行（C+汇编），总计约 30,000+ 行。