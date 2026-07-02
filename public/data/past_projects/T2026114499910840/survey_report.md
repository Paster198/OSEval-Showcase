## 项目初步调查结果

### 项目概述

**项目名称**: Neo Aether Operating System (naos)
**上游仓库**: [aether-os-studio/naos](https://github.com/aether-os-studio/naos)
**许可证**: GPLv3
**版本号**: 0.10.0（定义于 `kernel/src/settings.h`）
**主要语言**: C（搭配少量架构相关汇编 .S 文件），未使用 Rust
**代码规模**: 约 301,545 行（含内核源码、模块、第三方库、用户空间脚本）

---

### 一、顶层目录结构

```
.
├── GNUmakefile          # 顶层构建入口
├── flake.nix            # Nix 开发环境（可选，支持 Clang 工具链包装）
├── init                 # initramfs 中的 init 脚本
├── rootfs-init          # 根文件系统初始化脚本（含 LTP 测试编排）
├── mkinitcpio.sh        # initramfs 构建辅助脚本
├── limine.conf          # Limine 引导器配置
├── initramfs-riscv64.img    # 预构建的 RISC-V initramfs 镜像
├── initramfs-loongarch64.img # 预构建的 LoongArch initramfs 镜像
├── libgcc_riscv64.a     # 预提供的 RISC-V libgcc
├── libgcc_loongarch64.a # 预提供的 LoongArch libgcc
├── build/               # 共享构建配置 (common-env.mk)
├── docs/                # 设计文档（fs.md, process.md, module.md）
├── images/              # 项目截图
├── kernel/              # 内核核心代码与构建
├── modules/             # 可加载内核模块（.ko）
└── user/                # 用户空间 initramfs/rootfs 构建
```

---

### 二、内核子系统划分 (`kernel/src/`)

| 目录 | 子系统 | 说明 |
|---|---|---|
| `acpi/` | ACPI 子系统 | 基于 UACPI 实现，含 ACPI 表解析、解释器、命名空间、电源管理等 |
| `arch/` | 架构相关层 | 四个架构：`aarch64/`, `loongarch64/`, `riscv64/`, `x86_64/`，每个含 irq、mm、task、syscall、smp、time、drivers 等子目录 |
| `block/` | 块设备层 | 通用块设备抽象与分区管理 |
| `boot/` | 引导协议层 | 支持 Limine（多架构）、SBI（RISC-V）、laboot（LoongArch）三种引导协议 |
| `bpf/` | BPF 子系统 | Berkeley Packet Filter socket filter 实现 |
| `dev/` | 设备管理层 | 通用设备抽象 |
| `drivers/` | 内核内置驱动 | bus（PCI/USB）、drm（DRM 显示框架）、fdt（设备树电源管理）、fb/fbtty（帧缓冲终端）、pty、serial、tty、rtc、clockevent、input、logger、SMBIOS 等 |
| `fs/` | 文件系统层 | VFS 核心 (`vfs/`)、procfs (`proc/`)、syscall 层 (`syscall/`：epoll/eventfd/signalfd/timerfd/poll/memfd/pidfd/mountfd)、tmpfs、devtmpfs、configfs、pipe、initramfs、cgroupfs (`vfs/cgroup/`) |
| `init/` | 内核初始化 | 主入口、初始化回调链 |
| `irq/` | 中断管理 | IRQ 管理器与软中断机制 |
| `libs/` | 公共库 | klibc、hashmap、rbtree、llist/lqueue、mutex、string_builder、skb_buff、ELF 解析、termios、libfdt（设备树操作）、flanterm（终端渲染）、tinycrypt（ECC/SHA-256/AES 密码库） |
| `mm/` | 内存管理 | 物理页分配器、buddy 分配器、页表管理、VMA 红黑树、mmap/brk/mprotect/munmap/mremap、共享内存(shm)、缺页处理 |
| `mod/` | 内核模块支持 | 模块动态链接器 (dlinker)、模块签名校验 (modchk) |
| `net/` | 网络子系统 | socket 接口、网络设备抽象、netlink、Berkeley socket filter |
| `task/` | 进程/线程管理 | 调度器、task_struct、fork/vfork/clone/clone3/execve/execveat、信号处理、futex、ptrace、keyring、namespace |

每个架构目录 (`arch/<arch>/`) 内又细分为：
- `irq/`：中断/异常入口、trap 处理
- `mm/`：架构相关内存管理
- `task/`：上下文切换、信号栈帧、fork 汇编、ptrace
- `syscall/`：系统调用表 (`nr.h`)、系统调用分发
- `smp/`：多核启动
- `time/`：架构相关时钟
- `drivers/`：架构特有驱动（GIC、PS/2、PL011、local APIC timer、HPET、串口等）

---

### 三、可加载内核模块 (`modules/`)

| 目录 | 模块类别 | 内容 |
|---|---|---|
| `modules/drivers/e1000/` | 网卡驱动 | Intel E1000 网卡 |
| `modules/drivers/nvme/` | 存储驱动 | NVMe SSD 驱动 |
| `modules/drivers/virtio/` | virtio 驱动 | virtio-blk、virtio-gpu、virtio-net、virtio-sound、MMIO/PCI 传输 |
| `modules/drivers/usb/` | USB 主机控制器 | XHCI (USB 3.x) |
| `modules/drivers/hub/` | USB 集线器 | USB Hub 驱动 |
| `modules/drivers/hid/` | 人机接口设备 | USB HID 驱动 |
| `modules/drivers/msc/` | 大容量存储 | USB Mass Storage |
| `modules/drivers/sound/` | 声音驱动 | 声音子系统接口 |
| `modules/drivers/rtw88/` | WiFi 驱动 | Realtek rtw88（Linux 驱动移植，由 `BUILD_LINUX_DRIVERS` 控制） |
| `modules/fs/ext/` | 文件系统 | ext 文件系统实现 |
| `modules/net/netserver/` | 网络协议栈 | 基于 lwIP 的 TCP/IP 协议栈（含 IPv4/IPv6、DHCP、DNS、socket API） |
| `modules/lcompat/` | Linux 兼容层 | (当前为空目录) |

---

### 四、编译构建工具需求

根据 `build/common-env.mk` 和 `kernel/GNUmakefile` 分析：

**必备工具链**（按架构各需一套 GNU 交叉编译工具链）：
- `x86_64-linux-gnu-gcc/ld/nm/objcopy`
- `aarch64-linux-gnu-gcc/ld/nm/objcopy`
- `riscv64-linux-gnu-gcc/ld/nm/objcopy`
- `loongarch64-linux-gnu-gcc/ld/nm/objcopy`

**其他构建工具**：
- GNU Make（核心构建系统）
- NASM（x86_64 架构汇编）
- Python 3（模块签名脚本 `kernel/scripts/sign_module.py`）
- awk（kallsyms 符号生成 `kernel/scripts/gen-kallsyms.awk`）
- shell 脚本工具（bash, find, mkdir, cp 等标准 Unix 工具）
- dtc（设备树编译器，通过 FDT 相关代码间接需要）
- QEMU（模拟运行，`qemu-system-{riscv64,loongarch64,x86_64,aarch64}`）
- mkfs.vfat / mcopy / dd（文件系统镜像制作）
- Git（获取 Limine bootloader 等外部依赖）

**可选工具链**：
- Clang/LLVM（通过 `flake.nix` 提供 Clang 包装器支持，可替代 GCC）
- Nix（若使用 `flake.nix` 开发环境）

**外部依赖**（构建时自动获取）：
- Limine bootloader（从 GitHub 克隆 v11.x-binary 分支）
- EDK2 OVMF firmware（UEFI 固件镜像，用于 Limine 引导的架构）

---

### 五、项目关键特性（基于 README 与目录结构综合）

1. **多架构支持**：x86_64、AArch64、RISC-V 64、LoongArch64
2. **多引导协议**：Limine、SBI（RISC-V）、laboot（LoongArch）
3. **POSIX/Linux API 兼容**：实现大量 Linux 风格系统调用
4. **内存管理**：物理页分配、buddy 分配器、页表管理、VMA 红黑树、mmap 系列
5. **进程与线程**：fork/vfork/clone/clone3、execve/execveat、信号、futex、ptrace
6. **VFS 虚拟文件系统**：支持 tmpfs、devtmpfs、procfs、sysfs、ext 模块
7. **内核模块机制**：.ko 模块动态加载、ECC P-256 签名校验
8. **网络支持**：内核 socket 层 + lwIP 协议栈模块
9. **现代设备驱动**：virtio、NVMe、XHCI、HID、MSC、E1000、基础声音驱动
10. **DRM 显示框架**：包含 DRM 核心、ioctl 接口、plain framebuffer 后端