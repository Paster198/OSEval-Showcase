## 项目结构

```
.
├── Makefile                    # 顶层构建脚本
├── README.md                   # 项目说明
├── LICENSE                     # 许可证
├── kernel/                     # 操作系统内核
│   ├── Makefile
│   ├── kernel.ld               # 内核链接脚本
│   ├── main.c                  # 内核入口
│   ├── *.c / *.S               # 内核源文件（约25个）
│   └── include/                # 内核头文件（约28个）
├── sbi/                        # SBI 固件（M-mode 引导）
│   ├── Makefile
│   ├── sbi.ld
│   ├── entry.S                 # SBI 入口汇编
│   ├── start.c                 # SBI C 入口
│   ├── timer.c                 # 定时器
│   └── mtvec.S                 # 机器模式陷阱向量
├── user/                       # 用户态程序
│   ├── Makefile
│   ├── initcode.c              # init 进程
│   ├── test.c                  # 测试程序
│   └── test_syscall.c          # 系统调用测试
├── utils/                      # 构建辅助工具
│   ├── Makefile
│   └── capture_elf.c           # ELF 提取工具（主机 gcc 编译）
└── riscv-syscalls-testing/     # 系统调用测试套件（外部）
    ├── user/                   # 用户态库与测试用例
    │   ├── lib/                # 用户态运行时库（crt, syscall, stdio 等）
    │   └── src/oscomp/         # OS 竞赛系统调用测试（约30+个测试）
    └── check_tests.py
```

## 初步调查结果

### 1. 项目基本信息

- **项目名称**：noob is not RISV-V（递归缩写命名风格）
- **来源**：GUC（推测为中国科学院大学相关课程/竞赛项目）
- **目标架构**：RISC-V 64 位（rv64）
- **开发语言**：C 语言为主，辅以少量汇编（.S 文件）
- **运行平台**：QEMU virt 机器，2 CPU，128MB 内存

### 2. 子系统划分

根据源文件命名和头文件，内核实现了以下子系统：

| 子系统 | 相关文件 | 说明 |
|--------|----------|------|
| **引导与陷阱处理** | `strap.c`, `stvec.S`, `trampoline.S`, `csr.c` | 中断/异常入口、陷阱帧、CSR 操作 |
| **中断控制器** | `plic.c`, `clint.h` | PLIC 外部中断、CLINT 定时器中断 |
| **物理内存管理** | `pmm.c` | 物理页帧分配器 |
| **虚拟内存管理** | `vmm.c` | 页表管理、内核/用户地址空间映射 |
| **块设备驱动** | `virtio_disk.c`, `virtio.h`, `virtio_disk.h` | VirtIO 块设备驱动 |
| **块 I/O 缓存** | `bio.c`, `buf.h` | 块缓冲区缓存层 |
| **文件系统** | `fat32.c`, `fs.c` | FAT32 文件系统实现 + VFS 抽象层 |
| **进程管理** | `process.c` | 进程创建、生命周期管理 |
| **线程管理** | `thread.c` | 线程创建、调度状态 |
| **调度器** | `coro.c`, `coro_switch.S` | 基于协程（coroutine）的调度器 |
| **系统调用** | `syscall.c`, `sysfile.c` | 系统调用分发与文件相关系统调用 |
| **文件描述符** | `file.c` | 文件描述符表管理 |
| **ELF 加载** | `elf.c` | ELF 可执行文件解析与加载 |
| **同步机制** | `spinlock.c`, `waitqueue.c` | 自旋锁、等待队列 |
| **串口/控制台** | `uart.c`, `console.c` | UART 驱动、控制台 I/O |
| **CPU 管理** | `cpu.c` | 多核 CPU 状态管理 |
| **打印** | `print.c`, `dagaslib.c` | printf 实现、辅助库 |
| **测试** | `test.c` | 内核自测代码 |

### 3. SBI 固件

项目自带一个简易 SBI 实现（`sbi/` 目录），运行在 M-mode，提供基本的定时器服务和 S-mode 引导功能。构建后通过 `capture_elf` 工具提取为裸二进制镜像，作为 QEMU 的 `-bios` 参数传入。

### 4. 用户态与测试

- `user/` 目录包含 3 个用户程序：`initcode`（init 进程）、`test`、`test_syscall`
- `riscv-syscalls-testing/` 是一个外部系统调用测试套件，覆盖约 30+ 个 Linux 兼容系统调用（brk, clone, execve, fork, mmap, pipe, wait 等），带有 Python 自动化测试脚本
- 用户态程序使用 `rv64imac` 指令集，链接到 `libulib.a` 用户态运行时库

### 5. 构建工具需求

| 工具 | 用途 | 可用性 |
|------|------|--------|
| `riscv64-unknown-elf-gcc` | RISC-V 交叉编译器 | 可用（RISC-V cross toolchain） |
| `riscv64-unknown-elf-ld` | RISC-V 链接器 | 可用 |
| `riscv64-unknown-elf-objdump` | 反汇编 | 可用 |
| `riscv64-unknown-elf-gdb` | 调试 | 可用 |
| `qemu-system-riscv64` | RISC-V 模拟器 | 可用 |
| `gcc`（主机） | 编译 utils/capture_elf | 可用 |
| `make` | 构建系统 | 可用 |
| `dd` / `mkfs.vfat` | 文件系统镜像制作 | 可用 |
| `sudo` / `mount` | 挂载镜像写入文件 | 沙箱环境可能受限 |

**注意**：构建流程中 `sdcard.img` 和 `initrd.img` 的制作依赖 `sudo mount` 将镜像挂载为 loop 设备后拷贝文件，这在沙箱环境中可能无法执行。可能需要寻找替代方案（如 `mcopy` 直接写入 FAT 镜像）。