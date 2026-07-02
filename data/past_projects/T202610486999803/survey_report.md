## A20OS 项目初步调查报告

---

### 一、仓库顶层结构

| 路径 | 用途 |
|------|------|
| `kernel/` | 内核核心源代码 |
| `user/` | 用户态程序、C 库、第三方移植 |
| `docs/` | 设计与赛事文档 |
| `scripts/` | 辅助脚本（根文件系统覆盖层生成等） |
| `Makefile` | 顶层构建入口（约 1481 行） |
| `Dockerfile` | 构建环境容器定义 |
| `README.md` | 项目说明 |
| `mksh.dump` | mksh 相关转储文件（约 4MB） |
| `.gitignore` | Git 忽略规则 |

---

### 二、内核子系统划分

内核代码位于 `kernel/`，按功能和层次划分子系统：

| 子系统 | 目录 | 规模（行数） | 职责描述 |
|--------|------|:---------:|----------|
| **ABI 层** | `kernel/abi/` | 12,122 | 双重 ABI 实现：Linux ABI（POSIX 兼容，约 22 个 syscall 实现文件）与 Native ABI（能力导向的 A20 原生接口，约 12 个 syscall 实现文件） |
| **VFS/文件系统** | `kernel/fs/` | 14,099 | 模块化 VFS 框架及具体文件系统：ext4、FAT32、ramfs、devfs、procfs、sysfs、cgroupfs、memfd、pipe、anonfd，外加页缓存、块缓存、文件锁、inotify、xattr、rootfs overlay |
| **架构相关层** | `kernel/arch/` | 8,368 | 四架构支持：riscv64、loongarch64、aarch64、x86_64；各含启动汇编、上下文切换、陷阱处理、平台抽象等 |
| **头文件** | `kernel/include/` | 6,190 | 跨子系统公共头文件（core、mm、fs、net、proc、ipc、sys、abi、bpf、cg、drivers） |
| **驱动程序** | `kernel/drivers/` | 4,855 | 块设备（virtio-blk、loop、dw_sdio）、网络（virtio-net、ls2k_gmac、starfive_gmac）、字符设备（UART、PTY）、总线（PCI、virtio-mmio）、驱动核心框架 |
| **内存管理** | `kernel/mm/` | 4,700 | VMO/VMAR 内存容器模型、页帧分配、slab 分配器、对象缓存、ELF 加载、缺页处理、OOM 管理、cgroup 内存控制 |
| **网络栈** | `kernel/net/` | 4,251 | socket 层（INET/Unix/ALG/netlink）、lwIP 集成（NO_SYS=1 模式）、网络配置、轮询驱动进度模型 |
| **进程管理** | `kernel/proc/` | 3,817 | 任务/线程管理、调度器、fork/exec/exit/wait、信号、PID 管理、cgroup CPU 控制 |
| **IPC** | `kernel/ipc/` | 1,462 | Channel 通信、Event、eventfd、timerfd、SysV 信号量与共享内存 |
| **核心基础设施** | `kernel/core/` | 1,265 | 锁、同步原语、时间管理、panic、klog、printf、字符串操作、随机数、启动参数 |
| **平台/板级支持** | `kernel/platform/` | 728 | 6 个板级目标：qemu-virt（4 架构）+ visionfive2 + ls2k1000 |
| **BPF** | `kernel/bpf/` | 494 | 简易 BPF 虚拟机 |
| **系统调用分发** | `kernel/syscall/` | 336 | 系统调用入口与公共逻辑 |
| **内核入口** | `kernel/main.c` | 249 | 内核启动主流程 |
| **外部依赖** | `kernel/external/` | 64,770 | 内嵌 lwIP 协议栈源码 |

---

### 三、用户态程序结构

| 路径 | 用途 |
|------|------|
| `user/init.c` | 用户态 init 进程 |
| `user/init_common/` | init 运行时公共设置 |
| `user/cmds/` | 内置命令（约 28 个）：ls、ps、ping、wget、netstat 及各类压力/边界测试 |
| `user/liba20c/` | 轻量 C 库（基于 Linux ABI 的 syscall 封装） |
| `user/liba20rt/` | Native ABI 运行时库（能力、Channel、VMO 等 A20 原生概念） |
| `user/tests/` | liba20c 与 Native handle 测试 |
| `user/archive/` | 历史参考代码（a20coreutils、a20libc、a20sh 等） |
| `user/contest_init/` | 比赛测试入口（LTP 黑名单、运行脚本） |
| `user/extra/` | GCC 交叉编译器辅助构建脚本 |
| `user/rootfs_overlay/` | 根文件系统覆盖层（/etc 配置） |
| `user/external/` | 第三方移植：**musl**（libc）、**sbase**（coreutils）、**mksh**（shell）、**tlse**（TLS 库）、**fastfetch**、**vim**、**git**、**zlib**、**binutils**、**musl-cross-make** |

---

### 四、构建系统与所需工具

#### 4.1 内核构建工具链

根据 `Makefile` 与 `Dockerfile` 分析，内核编译使用 **GNU Make** 驱动，核心工具如下：

- **交叉编译器（GCC）**：四套交叉工具链
  - `riscv64-unknown-elf-gcc`（RISC-V 裸机）
  - `loongarch64-linux-gnu-gcc`
  - `aarch64-linux-gnu-gcc`
  - `x86_64-linux-gnu-gcc`
- **binutils**：对应的 `ld`、`objcopy`、`objdump`
- **文件系统工具**：`mkfs.fat`、`mkfs.ext4`、`dd`、`losetup`（可选）
- **QEMU**：四个架构的 QEMU 模拟器
  - `qemu-system-riscv64`
  - `qemu-system-loongarch64`
  - `qemu-system-aarch64`
  - `qemu-system-x86_64`
- **Python 3**：用于生成根文件系统覆盖层脚本
- **Docker**：可选，提供 `Dockerfile` 构建全架构编译环境

#### 4.2 用户态构建工具链

- **musl** 作为 libc（通过 `musl-cross-make` 交叉编译）
- **sbase**（coreutils）—— 从源码编译
- **mksh**（shell）—— 从源码编译
- **tlse**（TLS 库）—— 从源码编译
- 可选移植目标：fastfetch、vim、git、zlib、binutils

#### 4.3 构建参数

- `ARCH`：riscv64（默认）、loongarch64、aarch64、x86_64
- `ABI`：linux（Linux ABI）、native（A20 Native ABI）、both（双 ABI）
- `MODE`：release（默认 -O3）、debug
- `NR_CPUS`：SMP 核心数（默认 1，多核需通过门禁检查）
- `BOARD`：qemu-virt-{arch}（默认）、visionfive2、ls2k1000

---

### 五、初步观察要点

1. **混合内核设计**：内核在单一特权空间中运行所有驱动、网络栈和文件系统（宏内核特征），但在抽象层面引入了面向能力的 Handle、VMO/VMAR 内存容器、Channel 通信机制（微内核理念）。

2. **双重 ABI**：同时支持 Linux 兼容 ABI（可运行 musl 编译的 Linux 程序）和 Native ABI（A20 原生能力模型接口），两种 ABI 可同时编译进内核。

3. **四架构支持**：riscv64、loongarch64、aarch64、x86_64，均已在 QEMU virt 平台上完成支持。此外还有两个物理板卡目标（VisionFive 2、LS2K1000）。

4. **文件系统丰富**：实现了 ext4、FAT32、ramfs、devfs、procfs、sysfs、cgroupfs 等多种文件系统，通过 VFS 统一框架管理，还包含页缓存、块缓存、inotify 等高级特性。

5. **网络栈**：内嵌 lwIP 协议栈（约 65K 行），以 NO_SYS=1 模式运行，上层封装了 Linux 兼容的 socket 接口（TCP/UDP/RAW/Unix/ALG）。

6. **测试体系完备**：用户态 cmds 中包含大量测试命令（系统调用烟雾测试、各子系统的压力/边界测试），以及 LTP 测试集成框架。

7. **代码规模**：内核代码总计约 127K 行（含 lwIP 约 65K 行外部代码），纯自研内核逻辑约 62K 行；用户态程序约 9.6K 行（不含外部移植项目）。