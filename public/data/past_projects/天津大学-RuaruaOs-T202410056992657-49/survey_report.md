## 项目初步调查报告

### 一、项目基本信息

- **项目名称**：ruaruaos
- **作者**：李福鹏（天津大学）
- **目标架构**：RISC-V 64位（rv64gc）
- **运行平台**：QEMU virt 机器（RISC-V），也提及了 K210 硬件平台
- **项目性质**：OS 内核比赛项目，基于 xv6-riscv 进行大量扩展开发
- **代码规模**：约 92,987 行（含汇编），其中内核 C 源码约 9,000+ 行，其余为汇编（含 iozone 测试汇编约 83,000 行）

### 二、文件组织结构

```
.
├── 内核源码（根目录，扁平结构）
│   ├── 启动与汇编：start.S, entry.S, mem.S, trampoline.S, kernelvec.S, SignalTrampoline.S, test.S
│   ├── 内核入口：kernel.c
│   ├── 内存管理：kalloc.c, vm.c, page.c
│   ├── 进程/线程管理：proc.c, thread.c
│   ├── 文件系统：fs.c, file.c, bcache.c, disk.c, virtio_disk.c
│   ├── 系统调用：syscall.c, sysfile.c, sysfproc.c, sysshm.c, sys_pselect.c
│   ├── 程序加载：exec.c, exec1.c
│   ├── 中断/异常：trap.c, plic.c
│   ├── 同步机制：spinlock.c, sleeplock.c
│   ├── 设备驱动：uart.c, console.c, virtio_disk.c
│   ├── 信号机制：signal.c
│   ├── 管道：pipe.c
│   ├── 工具函数：string.c, printf.c
│   └── 用户态辅助：user.c
│
├── include/          -- 内核头文件（defs.h, proc.h, fs.h, file.h, riscv.h, syscall.h 等）
├── sbi/              -- 自定义 SBI 固件（boot.S, timer.c, timervec.S）
├── build/            -- 编译产物目录（.o 目标文件）
├── fs/               -- 用户态测试程序（预编译的 ELF 二进制，如 fork, clone, mmap, pipe 等）
├── init/             -- 初始化进程相关（initcode.S, Makefile）
├── test/             -- 测试用例（init-for-test.S, libc-bench）
├── image/            -- 项目文档图片
├── docx/             -- 比赛文档（初赛文档.md, 设计分析 PDF）
├── os.ld             -- 内核链接脚本（入口 _start_kernel，加载地址 0x80200000）
├── Makefile          -- 主构建文件
├── mkfs.c            -- 文件系统镜像制作工具（主机端）
├── Dockerfile        -- Docker 构建文件
└── 预编译产物         -- kernel-qemu, sbi-qemu, busybox, _sh 等
```

### 三、子系统识别

| 子系统 | 主要源文件 | 说明 |
|--------|-----------|------|
| **启动引导** | start.S, entry.S, mem.S, sbi/boot.S | 内核入口、早期初始化、自定义 SBI 固件 |
| **内存管理** | kalloc.c, vm.c, page.c | 物理页分配器、虚拟内存（页表管理）、用户空间内存管理（mmap/sbrk） |
| **进程管理** | proc.c, thread.c | 进程创建/调度/退出、多线程支持（clone）、进程状态管理 |
| **文件系统** | fs.c, file.c, bcache.c, disk.c, virtio_disk.c | ext4 文件系统实现、块缓存、VirtIO 磁盘驱动 |
| **系统调用** | syscall.c, sysfile.c, sysfproc.c, sysshm.c, sys_pselect.c | 系统调用分发、文件类/进程类/共享内存类/pselect 系统调用 |
| **程序加载** | exec.c, exec1.c | ELF 可执行文件加载（execve） |
| **中断与异常** | trap.c, plic.c, kernelvec.S, trampoline.S | Trap 处理、PLIC 中断控制器、用户态/内核态切换 |
| **信号机制** | signal.c, SignalTrampoline.S | POSIX 信号支持（含信号蹦床） |
| **进程间通信** | pipe.c | 管道 |
| **同步机制** | spinlock.c, sleeplock.c | 自旋锁、睡眠锁 |
| **设备驱动** | uart.c, console.c, virtio_disk.c | UART 串口、控制台、VirtIO 块设备 |
| **共享内存** | sysshm.c | System V 风格共享内存（shmget/shmat/shmdt/shmctl） |
| **工具/基础设施** | string.c, printf.c, user.c | 字符串操作、内核打印、用户态辅助 |

### 四、构建工具需求

| 工具 | 用途 | 状态 |
|------|------|------|
| `riscv64-linux-gnu-gcc` | 交叉编译 C 源码 | 可用 |
| `riscv64-linux-gnu-ld` | 链接内核 | 可用 |
| `riscv64-linux-gnu-objcopy` | 二进制格式转换 | 可用 |
| `riscv64-linux-gnu-objdump` | 反汇编 | 可用 |
| `qemu-system-riscv64` | 运行/调试内核 | 可用 |
| `gdb-multiarch` | 远程调试 | 可用 |
| `GNU Make` | 构建系统 | 可用 |

构建命令为 `make all`，生成两个目标：`kernel-qemu`（内核镜像）和 `sbi-qemu`（自定义 SBI 固件）。运行命令为 `make run`，通过 QEMU 以 VirtIO 块设备挂载 `sdcard.img` 磁盘镜像启动。

### 五、初步观察

1. **代码组织扁平**：内核源码全部放在根目录，未采用子目录分层结构，仅头文件放在 `include/` 中。
2. **基于 xv6-riscv 深度改造**：保留了 xv6 的基本架构（trap、proc、fs 等），但进行了大量扩展，包括 ext4 文件系统、多线程、信号机制、共享内存等。
3. **自定义 SBI**：项目包含自研的 SBI 固件（`sbi/` 目录），处理定时器中断和启动引导，而非完全依赖 OpenSBI/RustSBI。
4. **测试程序预编译**：`fs/` 目录包含大量预编译的用户态测试程序（约 40+ 个），覆盖系统调用测试场景。
5. **仓库包含大量非源码文件**：如 busybox 二进制、反汇编输出（.asm）、测试结果文件（res.txt）、比赛文档等，仓库整洁度较低。