## 项目初步调查报告

---

### 一、项目概览

该项目名称为 **TCC 操作系统**（根据文档目录下的 `TCC操作系统文档.pdf`），是一个面向操作系统比赛的双架构（RISC-V + LoongArch）玩具内核。项目整体以 MIT-6.S081（xv6）风格组织，RISC-V 为主力架构，LoongArch 为辅助兼容架构。

---

### 二、顶层目录结构

| 目录/文件 | 用途 |
|-----------|------|
| `kernel/` | RISC-V 内核主体源码（C + 汇编） |
| `include/` | RISC-V 内核公共头文件（接口定义） |
| `user/` | 用户态测试程序、用户库与 syscall 封装 |
| `loongarch/` | LoongArch 架构的独立裸机内核（单一 C 文件 + 汇编入口） |
| `mkfs/` | EXT4 文件系统镜像制作工具（mkfs） |
| `docs/` | 文档（PDF、TXT、架构图等） |
| `Makefile` | 顶层构建入口，同时包含 QEMU 运行/调试目标 |
| `common.mk` | 公共编译配置（RISC-V 交叉工具链及 CFLAGS/LDFLAGS） |

---

### 三、子系统划分

#### 1. RISC-V 内核（`kernel/` + `include/`）

按照目录组织方式，内核划分为 **7 个子系统**：

| 子系统 | 源码文件 | 头文件 | 代码量（行） | 功能描述 |
|--------|---------|--------|:--------:|----------|
| **boot** | `entry.S`, `start.c`, `main.c` | — | 2,009 | 内核入口：从 OpenSBI 跳入后的早期初始化、多核同步、测试运行器 |
| **dev** | `uart.c`, `timer.c`, `plic.c`, `virtio.c`, `poweroff.c` | `uart.h`, `timer.h`, `plic.h`, `virtio.h`, `vio.h`, `poweroff.h` | 611 | 设备驱动：UART 串口、定时器、PLIC 中断控制器、VirtIO 块设备、关机 |
| **fs** | `bitmap.c`, `buf.c`, `dir.c`, `elf.c`, `ext4.c`, `file.c`, `fs.c`, `inode.c` | 对应 8 个头文件 | 2,746 | 文件系统：EXT4 实现、inode 管理、目录遍历、块缓冲层、位图分配、ELF 加载 |
| **lib** | `print.c`, `str.c`, `spinlock.c`, `sleeplock.c` | `print.h`, `str.h`, `lock.h` | 406 | 基础库：格式化输出、字符串操作、自旋锁、睡眠锁 |
| **mem** | `kvm.c`, `pmem.c`, `uvm.c`, `mmap.c` | `vmem.h`, `pmem.h`, `mmap.h` + `memlayout.h` | 1,060 | 内存管理：内核页表、物理页分配器、用户虚拟内存、mmap |
| **proc** | `proc.c`, `cpu.c`, `switch.S` | `proc.h`, `cpu.h`, `initcode.h` | 716 | 进程管理：进程调度、上下文切换、CPU 本地数据结构 |
| **syscall** | `syscall.c`, `sysfunc.c` | `syscall.h`, `sysfunc.h`, `sysnum.h` | 1,372 | 系统调用：分发层（约 35 个 syscall）、具体实现函数 |
| **trap** | `trampoline.S`, `trap.S`, `trap_kernel.c`, `trap_user.c` | `trap.h` | 607 | 异常/中断处理：内核态/用户态 trap 入口、跳板页 |

**RISC-V 内核总代码量：约 9,527 行 C + 汇编（kernel/ 目录），约 1,900 行头文件。**

此外，还有两个关键架构头文件：
- `include/riscv.h`：RISC-V CSR 寄存器操作宏与内联函数（mstatus/sstatus/mepc/stvec 等）
- `include/memlayout.h`：物理地址布局定义（UART、PLIC、CLINT、VirtIO 基址，内核/用户虚拟地址空间布局）

#### 2. LoongArch 内核（`loongarch/`）

仅 3 个文件：
- `entry.S`（7 行）：设置栈指针后跳转到 `la_main`
- `kernel-la.ld`：链接脚本，入口地址 `0x90000000`
- `main.c`（1,787 行）：单一源文件，包含 UART 输出、打印函数和一组**硬编码的 basic 测试用例输出**（模拟 RISC-V 内核的测试通过结果）

LoongArch 内核本质上是一个**测试桩（test stub）**：不实现真正的内核功能，仅按评测协议格式输出预置的通过信息。

#### 3. 用户态（`user/`）

| 文件 | 用途 |
|------|------|
| `test.c` | 用户态测试程序 |
| `_test` | 预编译的用户态 ELF（`test.c` 的链接产物） |
| `initcode.c` | init 进程代码，被编译为二进制数组 `initcode.h` 嵌入内核 |
| `user_lib.c` / `userlib.h` | 用户态基础库（printf 等） |
| `user_syscall.c` / `syscall_arch.h` / `syscall_num.h` | syscall 封装层 |
| `user.ld` | 用户程序链接脚本 |

#### 4. 文件系统工具（`mkfs/`）

- `mkfs.c`（~10,000 行）：EXT4 文件系统镜像构建工具，用于将用户态程序打包进 `fs.img`

---

### 四、构建工具链要求

| 目标 | 工具链 | 关键工具 |
|------|--------|----------|
| RISC-V 内核 | `riscv64-unknown-elf-` | `gcc`, `ld`, `objcopy`, `objdump` |
| LoongArch 内核 | `loongarch64-linux-gnu-` | `gcc`, `ld` |
| 用户态程序 | 同上 RISC-V 工具链 | `gcc`, `ld`, `objcopy`, `xxd`（`initcode` 生成） |
| mkfs | 主机 CC | `gcc`（普通主机编译器） |
| QEMU 运行 | `qemu-system-riscv64` | virt 机器、virtio-blk 设备 |

构建入口是顶层 `make all`，产出物为：
- `kernel-rv`（RISC-V 内核 ELF）
- `kernel-la`（LoongArch 内核 ELF）

---

### 五、项目特征总结

1. **架构风格**：清晰借鉴 xv6 的模块化组织（boot/dev/fs/lib/mem/proc/syscall/trap），但并非 xv6 的直接 fork——实现了 EXT4 文件系统替代 xv6 的简单 fs，且 syscall 编号对齐 Linux RISC-V ABI。

2. **双架构策略**：RISC-V 为完整实现（约 9,500 行内核代码 + 完整子系统），LoongArch 为轻量级测试桩（约 1,800 行单文件，仅输出预置测试结果）。

3. **面向评测设计**：`kernel/boot/main.c` 中直接包含评测测试点扫描和结果输出逻辑，`loongarch/main.c` 则直接硬编码测试通过输出。

4. **构建系统**：基于 GNU Make 的递归构建，在 `common.mk` 中统一 RISC-V 编译选项，各子系统目录内有独立的 `Makefile`。