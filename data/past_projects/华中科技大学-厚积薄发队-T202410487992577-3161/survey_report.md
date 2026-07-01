## 项目结构

该仓库是一个基于 RISC-V 架构的操作系统内核项目，主要目录结构如下：

```
.
├── kernel/              # 内核核心代码
│   ├── deps/           # 依赖库（如 sdcard 驱动）
│   ├── include/        # 内核头文件
│   │   ├── driver/     # 设备驱动接口
│   │   ├── fs/         # 文件系统接口（含 ext4）
│   │   ├── ipc/        # 进程间通信接口
│   │   ├── mm/         # 内存管理接口
│   │   ├── proc/       # 进程管理接口
│   │   ├── sys/        # 系统调用接口
│   │   └── utils/      # 工具函数
│   └── src/            # 内核源代码实现
│       ├── driver/     # 设备驱动实现
│       ├── fs/         # 文件系统实现（含 ext4）
│       ├── ipc/        # 进程间通信实现
│       ├── mm/         # 内存管理实现
│       ├── proc/       # 进程管理实现
│       ├── sys/        # 系统调用实现
│       └── utils/      # 工具函数实现
├── xv6-user/           # 用户态程序
├── linker/             # 链接脚本
├── scripts/            # 构建脚本
├── tools/              # 辅助工具
├── Makefile            # 主构建文件
├── CMakeLists.txt      # CMake 构建配置
└── README.md           # 项目说明
```

## 实现的子系统

根据目录结构和 Makefile 分析，该项目实现了以下核心子系统：

1. **进程管理子系统** (`kernel/src/proc`, `kernel/include/proc`)
   - 进程创建、调度、终止等核心功能

2. **内存管理子系统** (`kernel/src/mm`, `kernel/include/mm`)
   - 物理内存和虚拟内存管理

3. **文件系统子系统** (`kernel/src/fs`, `kernel/include/fs`)
   - 支持 ext4 文件系统
   - 包含 SD 卡驱动支持

4. **设备驱动子系统** (`kernel/src/driver`, `kernel/include/driver`)
   - virtio 块设备驱动（用于 QEMU）
   - SD 卡驱动（用于 VisionFive 硬件）

5. **系统调用子系统** (`kernel/src/sys`, `kernel/include/sys`)
   - 提供用户态程序与内核交互的接口

6. **进程间通信子系统** (`kernel/src/ipc`, `kernel/include/ipc`)
   - 支持信号、futex 等 IPC 机制

## 构建工具需求

根据 Makefile 和 README 分析，构建该项目需要以下工具：

1. **交叉编译工具链**
   - `riscv64-unknown-elf-gcc` (RISC-V GCC 编译器)
   - `riscv64-unknown-elf-ld` (RISC-V 链接器)
   - `riscv64-unknown-elf-objcopy` (目标文件转换工具)
   - `riscv64-unknown-elf-objdump` (反汇编工具)

2. **构建系统**
   - GNU Make
   - CMake（用于内核构建）

3. **模拟器**
   - QEMU 7.0.0 (`qemu-system-riscv64`)

4. **文件系统工具**
   - `dd` (创建文件系统镜像)
   - `mkfs.ext4` (格式化 ext4 文件系统)
   - `mount`/`umount` (挂载文件系统镜像)

5. **调试工具**
   - GDB (多架构版本 `gdb-multiarch`)

## 项目特点

1. **双平台支持**：项目支持 QEMU 虚拟平台和 VisionFive 硬件平台
2. **用户态程序**：包含多个用户态程序（init, sh, cat, grep, ls 等），类似 xv6 操作系统
3. **现代文件系统**：支持 ext4 文件系统，相比原始 xv6 的简单文件系统更为复杂
4. **IPC 机制**：实现了信号和 futex 等现代进程间通信机制

该项目是一个教学和研究性质的操作系统内核，基于 xv6 的设计理念，但扩展了更多现代操作系统特性。