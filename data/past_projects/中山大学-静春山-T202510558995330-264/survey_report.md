## SpringOS 项目结构分析

### 项目概述
SpringOS是基于xv6-riscv的操作系统内核项目，由中山大学"静春山"队伍开发，支持RISC-V和LoongArch双架构，可在QEMU模拟器及VisionFive2、龙芯2K1000LA开发板上运行。

### 目录结构

```
.
├── boot/              # 启动代码（按架构分离）
│   ├── rv/           # RISC-V启动
│   ├── la/           # LoongArch启动
│   ├── vf2/          # VisionFive2启动
│   └── 2k1000/       # 龙芯2K1000启动
├── kernel/           # 内核核心代码
│   ├── drive/        # 设备驱动（含架构特定子目录）
│   ├── fs/          # 文件系统（VFS、EXT4、lwext4库）
│   ├── mm/          # 内存管理
│   ├── proc/        # 进程管理
│   ├── syscall/     # 系统调用
│   ├── trap/        # 中断异常处理（含架构特定子目录）
│   ├── lock/        # 锁机制
│   ├── util/        # 工具函数
│   ├── rv/ la/ vf2/ 2k1000/  # 架构特定链接脚本
├── include/          # 头文件
│   ├── fs/          # 文件系统头文件（VFS、EXT4）
│   ├── dev/         # 设备头文件
│   ├── proc/        # 进程头文件
│   ├── syscall/     # 系统调用头文件
│   └── lock/        # 锁头文件
├── user/            # 用户空间程序
├── tools/           # 工具脚本
├── mkfs/            # 文件系统镜像制作
├── basic/ final/ judge/  # 测试与评测
└── Makefile         # 构建配置
```

### 已实现的子系统

1. **进程管理** (`kernel/proc/`)
   - 进程控制、程序执行

2. **内存管理** (`kernel/mm/`)
   - Buddy分配器、内核内存分配、虚拟内存

3. **文件系统** (`kernel/fs/`)
   - VFS虚拟文件系统抽象层
   - EXT4文件系统实现（集成lwext4库）
   - 块设备I/O、管道、控制台、RAM磁盘

4. **系统调用** (`kernel/syscall/`)
   - 系统调用分发、文件操作、进程操作、信号处理

5. **中断与异常处理** (`kernel/trap/`)
   - 架构特定的中断处理、信号机制

6. **设备驱动** (`kernel/drive/`)
   - UART串口驱动（架构特定实现）

7. **同步机制** (`kernel/lock/`, `kernel/util/`)
   - 自旋锁、睡眠锁、Futex

8. **信号系统** (`kernel/syscall/syssig.c`, `kernel/trap/signal.c`)
   - 完整的Linux兼容信号实现

### 构建工具需求

- **RISC-V工具链**：`riscv64-linux-gnu-gcc`、`riscv64-linux-gnu-ld`等
- **LoongArch工具链**：`loongarch64-linux-gnu-gcc`、`loongarch64-linux-gnu-ld`等
- **模拟器**：`qemu-system-riscv64`、`qemu-system-loongarch64`
- **标准工具**：GCC、GNU Make、GNU ld、objcopy、objdump
- **文件系统工具**：mkfs相关工具

项目采用C语言编写，架构特定代码与通用代码分离良好，支持多架构构建。