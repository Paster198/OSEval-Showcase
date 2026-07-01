## 项目结构分析

### 1. 仓库文件组织结构

该项目采用扁平化结构，主要文件和目录分布如下：

**根目录（内核源码）**
- 内核核心源码文件（.c 和 .S 文件）直接位于根目录
- 构建配置文件：`Makefile`, `os.ld`（链接脚本）
- 构建产物：`build/` 目录存放编译生成的 .o 文件
- 最终内核镜像：`kernel-qemu`

**子目录**
- `include/` - 内核头文件（28个头文件）
- `sbi/` - 自定义 SBI（Supervisor Binary Interface）固件实现
- `fs/` - 用户态程序（测试程序和基础工具）
- `init/` - 初始化代码
- `test/` - 测试相关代码
- `image/` - 镜像相关（仅包含 README）

**辅助文件**
- `mkfs.c` - 文件系统镜像制作工具
- `busybox` - 预编译的 busybox 工具集
- `Dockerfile` - 容器化构建环境配置

### 2. 实现的子系统

根据源码分析，该内核实现了以下核心子系统：

**进程管理子系统**
- `proc.c` (32KB) - 进程管理核心实现
- `thread.c` - 线程支持
- `exec.c`, `exec1.c` - 程序加载与执行
- 支持 fork、clone、execve、wait 等系统调用
- 实现了完整的信号机制（31种标准信号 + 实时信号）

**内存管理子系统**
- `kalloc.c` - 物理页框分配器
- `vm.c` (10KB) - 虚拟内存管理
- `page.c` - 页面管理
- `sysshm.c` - 共享内存支持
- 支持 mmap/munmap 系统调用

**文件系统子系统**
- `fs.c` (24KB) - 文件系统核心实现（支持 ext4）
- `file.c` - 文件描述符管理
- `bcache.c` - 块设备缓存
- `virtio_disk.c` - VirtIO 块设备驱动
- `sysfile.c` (30KB) - 文件系统相关系统调用
- 支持 mount/umount、目录操作等

**进程间通信子系统**
- `pipe.c` - 管道实现
- `signal.c` - 信号处理
- `sysshm.c` - 共享内存

**设备驱动子系统**
- `uart.c` - UART 串口驱动
- `virtio_disk.c` - VirtIO 块设备驱动
- `plic.c` - PLIC 中断控制器驱动
- `console.c` - 控制台驱动

**系统调用子系统**
- `syscall.c` (10KB) - 系统调用分发
- `sysfile.c` - 文件系统系统调用
- `sysfproc.c` (15KB) - 进程相关系统调用
- `sys_pselect.c` - I/O 多路复用

**中断与异常处理子系统**
- `trap.c` (12KB) - 陷阱处理
- `kernelvec.S` - 内核态中断向量
- `trampoline.S` - 用户态/内核态切换

**同步机制子系统**
- `spinlock.c` - 自旋锁
- `sleeplock.c` - 睡眠锁
- `sys_pselect.c` - 包含 futex 支持

### 3. 目录与代码文件归属

| 目录/文件 | 所属子系统 | 说明 |
|-----------|-----------|------|
| `proc.c`, `thread.c` | 进程管理 | 进程/线程核心 |
| `exec.c`, `exec1.c` | 进程管理 | 程序加载 |
| `kalloc.c`, `vm.c`, `page.c` | 内存管理 | 内存分配与虚拟内存 |
| `fs.c`, `file.c`, `bcache.c` | 文件系统 | 文件系统核心 |
| `virtio_disk.c` | 设备驱动 | 块设备驱动 |
| `syscall.c`, `sysfile.c`, `sysfproc.c` | 系统调用 | 系统调用实现 |
| `trap.c`, `kernelvec.S` | 中断处理 | 中断与异常 |
| `pipe.c`, `signal.c` | 进程间通信 | IPC 机制 |
| `uart.c`, `console.c`, `plic.c` | 设备驱动 | 字符设备与中断控制器 |
| `spinlock.c`, `sleeplock.c` | 同步机制 | 锁实现 |
| `printf.c`, `string.c` | 内核工具 | 基础库函数 |
| `include/` | 全局 | 内核头文件 |
| `sbi/` | 固件 | SBI 实现 |
| `fs/` | 用户空间 | 用户态测试程序 |

### 4. 编译构建所需工具

根据 `Makefile` 分析，构建该项目需要以下工具：

**必需工具链**
- **RISC-V 交叉编译器**: `riscv64-linux-gnu-gcc`（用于编译内核和 SBI）
- **RISC-V 链接器**: `riscv64-linux-gnu-ld`
- **RISC-V 二进制工具**: `riscv64-linux-gnu-objcopy`, `riscv64-linux-gnu-objdump`
- **GNU Make**: 构建系统

**运行环境**
- **QEMU**: `qemu-system-riscv64`（RISC-V 64位系统模拟器）
- **GDB**: `gdb-multiarch`（多架构调试器，可选）

**编译参数**
- 目标架构: `rv64gc`（RISC-V 64位，通用指令集 + 压缩指令集）
- ABI: `lp64d`（64位长整型 + 双精度浮点）
- 内核加载地址: `0x80200000`
- 内存配置: 128MB
- SMP: 支持多核（默认2核，可配置）

**构建目标**
- `kernel-qemu`: 主内核镜像
- `sbi-qemu`: SBI 固件镜像
- `all`: 默认目标，构建上述两者

**特殊说明**
- 项目包含预编译的 `busybox` 二进制文件（1.3MB）
- `fs/` 目录包含大量预编译的用户态测试程序（约50个）
- 使用 VirtIO 设备进行块设备和网络模拟