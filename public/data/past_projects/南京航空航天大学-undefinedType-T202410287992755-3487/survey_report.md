# OS 内核项目分析报告

## 项目结构

```
.
├── Build/              # 编译输出目录
├── Doc/                # 项目文档（11篇 Markdown 文档）
├── Img/                # 用户程序镜像
├── Include/            # 头文件目录（与 Kernel 结构对应）
│   ├── Arch/          # 架构相关定义（RISC-V）
│   ├── Driver/        # 驱动头文件
│   ├── File/          # 文件系统头文件
│   ├── Library/       # 库函数头文件
│   ├── Memory/        # 内存管理头文件
│   ├── Process/       # 进程管理头文件
│   ├── Synchronize/   # 同步原语头文件
│   └── Trap/          # 异常/中断/系统调用头文件
├── Kernel/             # 内核源代码（约 5557 行）
│   ├── Boot/          # 启动代码（Start.S, main.cpp）
│   ├── Driver/        # 设备驱动（PLIC, VirtIO 磁盘）
│   ├── File/          # 文件系统（FAT32, VFS, 文件对象）
│   ├── Library/       # 内核库函数（字符串, 输出）
│   ├── Memory/        # 内存管理（物理页, 虚拟内存, slab）
│   ├── Process/       # 进程管理（进程控制, ELF 解析）
│   ├── Synchronize/   # 同步机制（信号量, 自旋锁）
│   └── Trap/          # 异常处理（Trap, 系统调用）
├── Linker/             # 链接脚本（Kernel.ld, user.ld）
├── SBI_BIN/            # SBI 固件（OpenSBI）
├── Test/               # 测试套件（oscomp 竞赛测试用例）
├── User/               # 用户态程序
├── makefile            # 构建脚本
└── kernel-qemu         # 编译后的内核镜像
```

## 子系统实现

### 1. 启动子系统 (Boot)
- **文件**: `Kernel/Boot/Start.S` (39行), `Kernel/Boot/main.cpp` (398行)
- **功能**: RISC-V 启动汇编、内核主入口、初始化流程
- **入口点**: `kernel_entry`，加载地址 `0xFFFFFFFF80200000`（虚拟地址）/ `0x80200000`（物理地址）

### 2. 内存管理子系统 (Memory)
- **物理内存管理 (PMM)**: `Kernel/Memory/pmm.cpp` (180行)
  - 基于页的分配器，管理 128MB 物理内存（0x80000000-0x88000000）
  - 页大小 4KB，使用 PAGE 结构体管理
  
- **虚拟内存管理 (VMM)**: `Kernel/Memory/vmm.cpp` (5行，实现较少)
  - SV39 分页机制支持
  - 虚拟内存空间管理
  
- **Slab 分配器**: `Kernel/Memory/slab.cpp` (195行)
  - 支持 64B、512B、4KB 三种规格的内存分配
  - 提供 `kmalloc`/`kfree` 接口

### 3. 进程管理子系统 (Process)
- **进程控制**: `Kernel/Process/Process.cpp` (611行)
  - 进程状态：None、Allocated、Initing、Ready、Running、UserRunning、Sleeping、Terminated
  - 支持内核线程和用户进程
  - 时间片轮转调度（Round Robin）
  - 进程创建、切换、终止
  
- **ELF 解析**: `Kernel/Process/parseELF.cpp` (302行)
  - 解析 ELF 格式可执行文件
  - 从文件系统加载用户程序
  
- **进程入口**: `Kernel/Process/ProcessEntry.S` (10行)
  - 进程切换的汇编入口

### 4. 文件系统子系统 (File)
- **FAT32 文件系统**: `Kernel/File/FAT32.cpp` (871行)
  - 完整的 FAT32 实现
  - 文件读写、目录遍历
  
- **虚拟文件系统 (VFS)**: `Kernel/File/vfsm.cpp` (325行)
  - 统一的文件访问接口
  - 支持挂载点管理
  
- **文件对象**: `Kernel/File/FileObject.cpp` (466行)
  - 文件描述符管理
  - 文件操作抽象
  
- **路径工具**: `Kernel/File/pathtool.cpp` (127行)
  - 路径解析和处理

### 5. 设备驱动子系统 (Driver)
- **PLIC 中断控制器**: `Kernel/Driver/Plic.cpp` (78行)
  - RISC-V 平台级中断控制器驱动
  
- **VirtIO 磁盘驱动**: `Kernel/Driver/VirtioDisk.cpp` (295行)
  - VirtIO 块设备驱动
  - 扇区读写（512字节/扇区）
  - 基于 VirtIO MMIO 接口

### 6. 异常与中断子系统 (Trap)
- **Trap 处理**: `Kernel/Trap/Trap.cpp` (190行)
  - 异常和中断的统一处理入口
  - 时钟中断、页错误等处理
  
- **Trap 入口**: `Kernel/Trap/TrapEntry.S` (148行)
  - 汇编级别的 trap 入口和上下文保存/恢复
  
- **系统调用**: `Kernel/Trap/Syscall/Syscall.cpp` (1023行)
  - 实现了约 60+ 个系统调用
  - 包括：进程管理（fork, clone, execve, wait4, exit）
  - 文件操作（open, close, read, write, mkdir, unlink）
  - 内存管理（mmap, munmap, brk, mprotect）
  - 进程信息（getpid, getppid, uname, times）
  - 同步机制（futex）
  - 时间相关（gettimeofday, clock_gettime, nanosleep）

### 7. 同步子系统 (Synchronize)
- **信号量**: `Kernel/Synchronize/Synchronize.cpp` (162行)
  - 基于等待队列的信号量实现
  - 支持 wait/signal 操作
  
- **自旋锁**: `Include/Synchronize/SpinLock.hpp`
  - 简单的自旋锁实现

### 8. 内核库 (Library)
- **字符串操作**: `Kernel/Library/Kstring.cpp` (111行)
  - memcpy, memset, strcmp 等基础函数
  
- **内核输出**: `Include/Library/KoutSingle.hpp`
  - 内核打印功能，支持多种输出类型（Info, Error, Test, Fault）

## 构建工具需求

### 必需工具
1. **RISC-V 交叉编译工具链**
   - `riscv64-unknown-elf-g++` (C++ 编译器)
   - `riscv64-unknown-elf-ld` (链接器)
   - `riscv64-unknown-elf-objcopy` (目标文件转换)
   
2. **构建工具**
   - GNU Make

3. **QEMU 模拟器**
   - `qemu-system-riscv64`
   - 配置：virt 机器，256MB 内存，2 核 SMP

4. **SBI 固件**
   - OpenSBI (`SBI_BIN/opensbi-qemu.elf`)

5. **文件系统镜像**
   - 磁盘镜像 (`SBI_BIN/a.img`)
   - 用户程序镜像 (`Img/User.img`)

### 编译参数
- C++ 标准：C++17
- 编译选项：`-nostdlib -fno-exceptions -fno-rtti -mcmodel=medany`
- 目标架构：RISC-V 64位
- 输出格式：ELF64 Little-Endian

### 测试工具
- CMake 3.13+（用于构建测试用例）
- Python（测试脚本）
- GCC（测试用例编译）

## 项目特点

1. **教学/竞赛项目**：从文档和测试用例看，这是一个 OS 竞赛或教学项目
2. **单核到多核**：支持 SMP（2核），但实现可能以单核为主
3. **C++ 实现**：使用 C++17 特性，面向对象设计
4. **模块化设计**：清晰的子系统划分，头文件与实现分离
5. **测试覆盖**：包含完整的 oscomp 测试套件（40+ 测试用例）
6. **代码规模**：内核代码约 5557 行，属于小型但功能相对完整的内核