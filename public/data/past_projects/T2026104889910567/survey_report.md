## 项目初步调查报告

### 一、项目基本信息

- **项目名称**：NoobKernel
- **许可证**：项目根目录含 `LICENSE` 文件
- **代码规模**：约 156 个源文件（`.c`、`.S`、`.h`），总计约 18,000 行代码
- **目标平台**：RISC-V 64 (QEMU virt)，同时保留 LoongArch64/Loongson 源码预留

---

### 二、目录组织结构

```
repo/
├── Makefile              # 顶层 Makefile：工具链设置、编译参数、构建目标
├── rules.mk              # 通用模块构建模板（Makefile 函数）
├── README.md             # 项目文档
├── LICENSE
├── include/              # 头文件目录（与 src 结构镜像对应）
│   ├── config.h          # 内核配置常量
│   ├── arch/             # 架构相关头文件 (riscv64, loongarch64)
│   ├── fs/               # 文件系统头文件
│   ├── hal/              # 硬件抽象层头文件
│   ├── ipc/              # 进程间通信头文件
│   ├── misc/             # 杂项/工具头文件（printf, string, list, 等）
│   ├── mm/               # 内存管理头文件
│   ├── platform/         # 平台相关头文件 (qemu_virt, loongson)
│   ├── sync/             # 同步原语头文件
│   ├── syscall/          # 系统调用头文件
│   ├── task/             # 进程/调度头文件
│   └── trap/             # 异常/中断头文件
├── src/                  # 内核源码目录
│   ├── arch/             # 架构相关汇编/S (riscv64, loongarch64)
│   ├── async/            # 异步机制（目录存在但为空壳）
│   ├── boot/             # 内核启动入口
│   ├── fs/               # 文件系统实现
│   ├── hal/              # 硬件抽象层 + virtio 子模块
│   ├── ipc/              # 管道实现
│   ├── misc/             # 工具库（printf, string, sha2, lz4, 等）
│   ├── mm/               # 内存管理实现
│   ├── platform/         # 平台相关代码 (qemu_virt, loongson)
│   ├── sync/             # 自旋锁实现
│   ├── syscall/          # 系统调用分发与实现
│   ├── task/             # 进程管理/调度
│   └── trap/             # 异常/中断处理
├── user/                 # 用户态测试程序
│   ├── autoinit.c        # 自动化测试入口
│   ├── testrunner.c      # 测试运行器
│   ├── dyntest.c         # 动态测试
│   ├── mmaptest.c        # mmap 测试
│   ├── shell.c           # 简易 shell
│   └── linker.ld         # 用户程序链接脚本
├── build/QEMU/           # 构建输出目录（预置了已构建产物）
├── scripts/              # 链接脚本与辅助脚本
│   ├── kernel.ld         # 内核链接脚本（默认 riscv64）
│   ├── gdb_watch.gdb     # GDB 调试脚本
│   ├── riscv64/kernel.ld
│   └── loongarch64/kernel.ld
```

---

### 三、子系统划分

| 子系统 | 源码位置 | 头文件位置 | 说明 |
|--------|---------|-----------|------|
| **启动 (boot)** | `src/boot/` | — | BSS 清零、各子系统顺序初始化、首个用户进程创建 |
| **架构层 (arch)** | `src/arch/riscv64/`, `src/arch/loongarch64/` | `include/arch/` | entry.S、上下文切换、trampoline、内核向量、idle |
| **平台层 (platform)** | `src/platform/qemu_virt/`, `src/platform/loongson/` | `include/platform/` | PLIC 配置、定时器、串口控制台 |
| **硬件抽象层 (HAL)** | `src/hal/`, `src/hal/virtio/` | `include/hal/` | PLIC、Timer、UART、块设备抽象、VirtIO MMIO、VirtIO Block |
| **异常/中断 (trap)** | `src/trap/` | `include/trap/` | 用户态/内核态 trap 入口与返回、中断分发 |
| **系统调用 (syscall)** | `src/syscall/` | `include/syscall/` | Linux 5.10 RISC-V syscall 编号体系、分发器、copyin/copyout |
| **进程管理 (task)** | `src/task/` | `include/task/` | PCB、进程状态、调度队列、上下文切换、内核线程 |
| **内存管理 (mm)** | `src/mm/` | `include/mm/` | 物理页管理、Buddy分配器、Slab、kmalloc、页表、VMA、COW、page cache、block cache |
| **文件系统 (fs)** | `src/fs/` | `include/fs/` | VFS 抽象层、Ramfs、Ext4（超级块/索引节点/目录/文件操作）、namei、fd table |
| **进程间通信 (ipc)** | `src/ipc/` | `include/ipc/` | 管道 (pipe) 实现、信号结构定义 |
| **同步 (sync)** | `src/sync/` | `include/sync/` | 自旋锁 |
| **工具库 (misc)** | `src/misc/` | `include/misc/` | printf、字符串、list、hashtable、radix_tree、SHA-256、LZ4、errno |
| **异步 (async)** | `src/async/` | — | 空壳模块，仅有 Makefile，暂无实现 |
| **用户态程序** | `user/` | — | autoinit、testrunner、shell、dyntest、mmaptest |

---

### 四、主要子系统详细情况

**1. 启动路径** (`src/boot/main.c`)

内核启动后按顺序初始化：BSS 清零 → CPU 初始化 → 物理内存初始化 → PLIC → trap → UART → 内核页表 → 运行队列 → 块设备 → block cache → VirtIO → VFS → Ramfs/Ext4 → Timer → 首个用户进程 → 调度器启用。

**2. 异常/中断与系统调用** (`src/trap/` + `src/syscall/`)

采用 RISC-V 标准 trap 机制，含 trampoline 页实现用户态/内核态切换。系统调用采用 Linux 5.10 RISC-V generic 编号体系（`syscall.h` 中定义了约 50+ 个系统调用号），`syscall.c` 实现统一分发，`uspace.c` 实现 `copyin/copyout/copyinstr` 用户态安全访问。

**3. 进程管理** (`src/task/` + `src/syscall/proc.c`)

实现完整 PCB（`struct proc`），含 trapframe、context、进程状态（UNUSED/IDLE/RUNNABLE/RUNNING/SLEEPING/ZOMBIE）、父子关系、运行队列。支持 `clone`、`execve`（ELF 加载）、`wait4`、`exit`、信号处理、`sleep/wakeup`。

**4. 内存管理** (`src/mm/`)

分层设计：物理页管理 (`pm.c`) → Buddy 分配器 (`buddy.c`) → Slab 分配器 (`slab.c`) → kmalloc (`kalloc.c`) → 页表 (`pagetable.c`) → VMA (`vma.c`) → 虚拟内存/COW (`vm.c`) → block cache (`bcache.c`)。

**5. 文件系统** (`src/fs/`)

VFS 抽象层支持注册/挂载/路径查找，包括 super_block、inode、dentry、file、mount 等抽象。实现了 Ramfs（内存文件系统）和 Ext4（块设备文件系统，含超级块/索引节点/目录/文件操作）。`fd_table.c` 实现文件描述符表管理。

**6. 设备驱动** (`src/hal/` + `src/hal/virtio/`)

VirtIO MMIO 传输层 (`virtio_mmio.c`)、VirtQueue (`virtq.c`)、VirtIO Block 设备 (`virtio_blk.c`)。块设备抽象层 (`blk.c`)。PLIC 中断控制器、Timer、UART 串口。

---

### 五、构建系统

**构建工具**：
- 交叉编译工具链：`riscv64-unknown-elf-gcc`、`riscv64-unknown-elf-ld`、`riscv64-unknown-elf-objcopy`、`riscv64-unknown-elf-objdump`
- 调试器：`gdb-multiarch`
- 模拟器：`qemu-system-riscv64`
- 脚本：Python 3
- 构建系统：GNU Make（递归 make，每个模块有自己的 Makefile，通过 `rules.mk` 模板统一处理）

**编译参数**：
- C 标准：`-std=gnu11`
- 优化级别：`-O0`，启用调试信息 `-ggdb`
- RISC-V 代码模型：`-mcmodel=medany`
- 独立环境：`-ffreestanding -fno-common -nostdlib -mno-relax -nostdinc`

**构建产物**：`build/QEMU/kernel`（ELF 内核镜像）及其汇编文件 `kernel.asm` 和符号表 `kernel.sym`。用户程序通过 `objcopy` 以二进制形式嵌入内核。

**运行方式**：`make run` 使用 QEMU (`qemu-system-riscv64 -nographic -machine virt -m 1G -bios default -smp 1`) 启动内核。

---

### 六、初步评估

该项目是一个面向全国大学生计算机系统能力大赛操作系统内核赛道的 RISC-V 64 宏内核项目。代码组织结构清晰，采用模块化设计，`src/` 与 `include/` 形成镜像结构。实现了从启动、中断/异常处理、系统调用、进程管理、内存管理到文件系统和设备驱动的完整内核运行链路。当前 LoongArch64 和 Loongson 平台代码作为预留存在但项目主验证平台为 RISC-V64 QEMU virt。`async` 模块仅是空壳，暂无实质实现。`build/QEMU/` 目录下预置了已编译的内核镜像和中间产物，表明项目已在当前环境中完成过构建。