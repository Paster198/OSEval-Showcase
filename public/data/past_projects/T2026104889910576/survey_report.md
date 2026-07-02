## OSKernel2026-AllNull 项目初步调查报告

---

### 一、项目概览

该项目是一个面向 QEMU `virt` 机器的 **RISC-V 64 位**操作系统内核，目标定位为操作系统竞赛类负载。项目规模约 **24,759 行**（含注释和空行），包含 **69 个源文件**（`.c`、`.S`）和 **61 个头文件**（`.h`）。整体结构清晰，按子系统分目录组织。

---

### 二、目录结构

```
.
├── include/                 # 内核公共头文件（按子系统分组）
│   ├── fs/                  # VFS、inode、dentry、file、super 等定义
│   ├── hal/                 # RISC-V、SBI、PLIC、VirtIO、块设备、网络设备接口
│   ├── ipc/                 # pipe 接口
│   ├── misc/                # 通用工具：list、hashtable、radix_tree、printf、
│   │                          string、lz4、sha2、bitmap、errno 等
│   ├── mm/                  # 内存管理：buddy、slab、kmalloc、页表、VMA、bcache 等
│   ├── platform/            # 平台配置（QEMU virt 机器参数）
│   ├── sync/                # 自旋锁、原子操作、等待队列
│   ├── syscall/             # 系统调用号定义、分发接口
│   ├── task/                # 进程、内核线程、调度器定义
│   └── trap/                # trapframe 和陷入处理声明
├── src/
│   ├── async/               # 异步框架（仅有空 Makefile，无实现）
│   ├── boot/                # 内核入口（entry.S、main.c）
│   ├── fs/                  # VFS 核心实现 + ext4 子模块
│   │   └── ext4/            # EXT4 文件系统实现
│   ├── hal/                 # 硬件抽象层：timer、PLIC、块设备 + VirtIO 子模块
│   │   └── virtio/          # VirtIO-MMIO 传输层、块设备驱动、网络设备驱动
│   ├── ipc/                 # pipe 实现
│   ├── misc/                # 通用辅助函数实现
│   ├── mm/                  # 物理内存管理、虚拟内存管理、块缓存
│   ├── sync/                # 自旋锁和等待队列实现
│   ├── syscall/             # 系统调用实现（syscall.c + 顶层 syscall.c）
│   ├── task/                # 进程管理、调度、上下文切换
│   ├── trap/                # trap 处理、trampoline、内核向量
│   └── user/                # 内嵌 init 程序与用户态测试程序
├── scripts/
│   ├── kernel.ld            # 内核链接脚本
│   └── init.ld              # 用户态 init 程序链接脚本
├── docs/
│   └── modules/             # 各模块设计文档（11 个模块 + 技术方案）
├── video/                   # 录屏文件
├── Makefile                 # 顶层构建文件
├── rules.mk                 # 通用模块构建规则模板
├── .clang-format            # 代码格式化配置
└── README.md                # 项目说明
```

---

### 三、已实现的子系统

| 子系统 | 目录 | 规模（行） | 核心内容 |
|--------|------|-----------|----------|
| **引导启动** | `src/boot/` | ~262 | 内核入口汇编、main 函数初始化全系统 |
| **内存管理** | `src/mm/` | ~2,956 | Buddy 物理页分配器、Slab 分配器、kmalloc、Sv39 页表管理、VMA、用户内存辅助（uvm）、块缓存（bcache） |
| **硬件抽象层** | `src/hal/` | ~1,525 | RISC-V CSR/SBI 封装、PLIC 中断控制器、TIMER、块设备抽象、VirtIO-MMIO 传输层、VirtIO 块设备驱动、VirtIO 网络设备驱动 |
| **异常与陷入** | `src/trap/` | ~521 | trampoline 跳板、内核向量、trap 分发处理 |
| **进程管理** | `src/task/` | ~515 | 进程结构管理、FIFO 调度器、上下文切换、内核线程 |
| **同步原语** | `src/sync/` | ~194 | 自旋锁、等待队列 |
| **文件系统** | `src/fs/` | ~5,290 | VFS 五层模型（superblock、inode、dentry、file、fd_table）、namei 路径解析、EXT4 文件系统读写/创建/删除/目录操作 |
| **进程间通信** | `src/ipc/` | ~192 | pipe 管道实现 |
| **系统调用** | `src/syscall/` | ~6,068 | 96 个系统调用号定义（兼容 Linux RISC-V ABI），约 5,000 行实现代码 |
| **辅助工具** | `src/misc/` | ~3,234 | string、printf、errno、radix_tree、hashtable、LZ4 解压、SHA-256、list |
| **用户态程序** | `src/user/` | ~1,861 | 内嵌 init 测试运行器、hello/pipe_test/syscall_test 测试 ELF |
| **异步框架** | `src/async/` | 0 | 仅占位 Makefile，无代码 |

---

### 四、子系统与代码文件对应关系

| 子系统 | 源文件 |
|--------|--------|
| **Boot** | `src/boot/entry.S`、`src/boot/main.c` |
| **MM** | `src/mm/buddy.c`、`src/mm/slab.c`、`src/mm/kalloc.c`、`src/mm/pm.c`、`src/mm/early.c`、`src/mm/pagetable.c`、`src/mm/vma.c`、`src/mm/vm.c`、`src/mm/uvm.c`、`src/mm/bcache.c` |
| **HAL** | `src/hal/plic.c`、`src/hal/timer.c`、`src/hal/blk.c`、`src/hal/virtio/virtq.c`、`src/hal/virtio/virtio_mmio.c`、`src/hal/virtio/virtio_blk.c`、`src/hal/virtio/virtio_net.c`、`src/hal/virtio/device.c` |
| **Trap** | `src/trap/trap.c`、`src/trap/trampoline.S`、`src/trap/kernelvec.S` |
| **Task** | `src/task/proc.c`、`src/task/sched.c`、`src/task/kthread.c`、`src/task/switch.S`、`src/task/idle.S`、`src/task/kthread_entry.S` |
| **Sync** | `src/sync/spinlock.c`、`src/sync/wait.c` |
| **FS** | `src/fs/vfs.c`、`src/fs/super.c`、`src/fs/inode.c`、`src/fs/dentry.c`、`src/fs/file.c`、`src/fs/namei.c`、`src/fs/fd_table.c`、`src/fs/ext4/ext4.c` |
| **IPC** | `src/ipc/pipe.c` |
| **Syscall** | `src/syscall.c`（顶层，~1084行）、`src/syscall/syscall.c`（实现，~4984行） |
| **Misc** | `src/misc/string.c`、`src/misc/printf.c`、`src/misc/errno.c`、`src/misc/radix_tree.c`、`src/misc/hashtable.c`、`src/misc/lz4.c`、`src/misc/sha2.c` |
| **User** | `src/user/init.c`、`src/user/init.S`、`src/user/hello.c`、`src/user/pipe_test.c`、`src/user/syscall_test.c` |

---

### 五、构建系统

**构建工具要求**（基于 Makefile 分析）：

| 工具 | 用途 |
|------|------|
| `riscv64-unknown-elf-gcc` | RISC-V 裸机 C 编译器 |
| `riscv64-unknown-elf-ld` | RISC-V 链接器 |
| `riscv64-unknown-elf-objcopy` | 目标文件格式转换 |
| `riscv64-unknown-elf-objdump` | 反汇编/符号表导出 |
| `qemu-system-riscv64` | RISC-V QEMU 虚拟机 |
| `gdb-multiarch` | 多架构调试器（可选） |
| `mkfs.ext4` | EXT4 镜像制作（可选） |

**构建流程**：
- 顶层 `Makefile` 使用 `MODULES` 列表（boot、misc、mm、hal、trap、task、sync、fs、ipc、syscall）驱动构建
- `rules.mk` 提供通用模块模板（`module_template`），自动发现 `.c`/`.S` 源文件、处理依赖、支持子模块递归
- 模块先通过 `ld -r` 部分链接为单个 `.o`，最终链接为 `kernel` 镜像
- 用户态 init 程序独立编译链接后通过 `objcopy -O binary` + `ld -r -b binary` 嵌入内核
- 链接脚本 `scripts/kernel.ld` 定义内核基址为 `0x80200000`，包含 trampoline 段对齐

**编译选项关键点**：
- `-mcmodel=medany`（RISC-V 中型代码模型）
- `-ffreestanding -nostdlib -nostdinc`（独立环境）
- `-fno-omit-frame-pointer -ggdb`（调试支持）
- 存在针对 `sha2.c` 的 GCC ICE 变通（改用 `-O1`）

---

### 六、关键特征总结

1. **单核 RISC-V 64 位**内核，面向 QEMU `virt` 机器
2. **96 个系统调用号**定义，覆盖文件 I/O、进程管理、内存管理、socket 兼容桩、futex 等，以 Linux RISC-V ABI 为目标
3. **VFS + EXT4** 构成的主要文件系统栈，支持常规读写/创建/删除/目录操作
4. **VirtIO-MMIO** 块设备与网络设备驱动
5. **基于 trampoline** 的用户态/内核态切换机制
6. **内嵌 init 用户态程序**，可作为 BusyBox 加载器
7. **LoongArch** 占位目标（`kernel-la`），当前无实际代码
8. **异步框架**（`src/async/`）仅有空 Makefile，无实现