# OS 内核项目初步调查报告

## 一、仓库顶层文件组织结构

```
repo/
├── .git/                    # Git 仓库元数据
├── .gitignore / .dockerignore
├── Dockerfile               # Docker 构建环境（Ubuntu 22.04 + QEMU 7.0 + Rust nightly）
├── Makefile                 # 顶层构建入口（rv / la / all / debug / clean）
├── rust-toolchain.toml      # Rust 工具链声明：nightly-2024-08-01
├── README.md / TODO.md
├── run.sh / run-la.sh / run_fixed.sh  # QEMU 运行脚本
├── merge_chain.sh           # 合并脚本
│
├── os/                      # [核心] 内核主 crate
├── arch/                    # [核心] 架构抽象层 crate
├── easy-fs/                 # [核心] 简易文件系统库 crate
├── easy-fs-fuse/            # [工具] 文件系统镜像制作工具（FUSE 风格）
├── user/                    # [核心] 用户态程序库 + initcode
│
├── bootloader/              # SBI 固件二进制（rustsbi-qemu.bin）
├── busybox/                 # busybox musl 版本
├── vendor/                  # 所有第三方 Rust 依赖的本地副本（约 140+ crate）
├── scripts/                 # 构建/分析辅助脚本
├── docs/                    # 文档（设计文档、开发规范、AI 使用说明等）
├── analysis/                # LTP 分析报告
├── tmp/                     # 环境安装脚本
│
├── la-ld.so / la-libc.so.6  # LoongArch 动态链接器和 libc
├── la-netperf               # LoongArch 网络性能测试工具
├── pthread_cancel_small / .c# 测试程序
└── ltp_glibc_musl_comparison.txt / iozone-short.md
```

---

## 二、子系统划分

### 1. 架构抽象层（`arch/`）

- **目录**：`arch/src/`
- **职责**：封装所有架构相关代码，通过 `ArchInterface` trait 回调内核。
- **支持架构**：
  - **RISC-V 64**（`arch/src/riscv64/`）：页表（SV39）、上下文切换、中断/异常处理、SBI 调用、时钟、信号传递（sigtrx）、Unaligned 访问处理。
  - **LoongArch 64**（`arch/src/loongarch64/`）：页表、上下文切换、中断/异常处理、SBI 调用、时钟、信号传递。
- **公共代码**：`arch/src/api.rs`（ArchInterface trait 定义）、`arch/src/platform.rs`（平台设备描述模型）、`arch/src/pagetable.rs`（通用页表代码）。

### 2. 内核核心（`os/`）

内核主 crate，按功能模块组织在 `os/src/` 下：

#### 2.1 内存管理（`os/src/mm/`）
- 物理帧分配器（`frame_allocator.rs`）
- 内核堆分配器（`heap_allocator.rs`）
- 虚拟地址空间 / MemorySet 管理（`memory_set.rs`）
- 地址空间策略（`address_space_policy.rs`）

#### 2.2 进程/任务管理（`os/src/task/`）
- 进程管理（`process.rs`，约 1524 行）
- 任务调度（`task.rs`、`processor.rs`、`manager.rs`）
- 上下文切换（`context.rs`、`switch.rs`、`switch.S`）
- 信号处理（`signal.rs`）
- Futex 支持（`futex.rs`）
- TLS 支持（`tls.rs`）
- 辅助向量（`auxv.rs`）
- 任务 ID 分配（`id.rs`）
- 架构特定用户上下文（`user_context_riscv64.rs`、`user_context_loongarch64.rs`）
- Init 进程嵌入（`initproc_embed_*.rs`）

#### 2.3 系统调用（`os/src/syscall/`）
- 总代码量约 16437 行
- 子模块：`fs.rs`（文件系统 syscall，6238 行）、`process.rs`（进程 syscall，5995 行）、`thread.rs`、`sync.rs`、`ipc.rs`（2509 行）、`user_mem.rs`、`errno.rs`
- 实现了约 200+ 个 syscall 号（覆盖 Linux RISC-V syscall ABI 的绝大多数常用调用）

#### 2.4 文件系统（`os/src/fs/`）
- **VFS 层**（`vfs/`）：`core.rs`（451 行）、`file.rs`（318 行）、`mount.rs`（107 行）
- **支持的文件系统后端**：
  - **EasyFS**（`vfs/easyfs/`）：基于 `easy-fs` crate 的简易文件系统
  - **ext4**（`vfs/ext4/`）：通过 `lwext4_rust` 绑定，可选 feature
  - **FAT32**（`vfs/fat32/`）：通过 `rust-fatfs`，默认尝试挂载
- **特殊文件类型**：`pipe.rs`（管道）、`stdio.rs`（标准输入输出）、`epoll.rs`、`eventfd.rs`、`signalfd.rs`、`timerfd.rs`、`memfd.rs`
- **procfs**（`vfs/procfs.rs`，1057 行）

#### 2.5 网络子系统（`os/src/net/`）
- 基于 **smoltcp** 协议栈
- `mod.rs`：全局 `NetStack` 结构体，管理 VirtIO 网络设备和 loopback
- `socket_file.rs`：TCP/UDP socket 文件实现
- `syscall.rs`：socket 相关系统调用（socket/bind/listen/accept/connect/sendto/recvfrom 等）
- `unix_socket.rs`：Unix domain socket
- LoongArch64 上使用 `net_stub.rs`（返回 ENOSYS）

#### 2.6 设备驱动（`os/src/drivers/`）
- **块设备**（`block/`）：VirtIO Block（MMIO）、VirtIO Block PCI（LoongArch）、缓存块设备层
- **总线**（`bus/`）：VirtIO HAL 实现（RISC-V / LoongArch 各一）
- **字符设备**（`chardev/`）：NS16550A UART
- **输入设备**（`input/`）：VirtIO Input（键盘 + 鼠标）
- **网络设备**（`net/`）：VirtIO Net（smoltcp Device trait 实现）
- **中断控制器**（`plic.rs`）：RISC-V PLIC

#### 2.7 同步原语（`os/src/sync/`）
- `mutex.rs`、`condvar.rs`、`semaphore.rs`、`up.rs`（基于 `UPIntrFreeCell` 等底层机制）

#### 2.8 陷阱/中断处理（`os/src/trap/`）
- 架构相关的用户态 trap 处理（`user_trap_riscv64.rs`、`user_trap_loongarch64.rs`）
- 上下文保存/恢复（`context.rs`、`trap.S`）

#### 2.9 板级支持（`os/src/boards/`）
- `qemu.rs`：RISC-V QEMU virt 板（设备初始化、PLIC 路由、IRQ 分发）
- `qemu_la.rs`：LoongArch64 QEMU virt 板（当前为 stubs）

#### 2.10 其他
- **启动**（`boot.rs`）：`rust_main` 入口，初始化所有子系统后进入调度循环
- **日志**（`logging.rs`）、**控制台**（`console.rs`）
- **加载器**（`loader.rs`）：从内核嵌入数据段加载用户程序
- **配置**（`config.rs`）：栈大小、堆大小、页大小等常量
- **SBI 封装**（`sbi.rs`）：封装 SBI ecall

### 3. 用户态支持（`user/`）

- `user/src/lib.rs`：用户库（提供 syscall 封装、entry point、allocator 等）
- `user/src/bin/initcode.rs`：init 进程代码
- `user/src/linker.ld` / `linker-loongarch64.ld`：链接脚本
- `user/Makefile` + `user/build.py`：构建系统

### 4. 简易文件系统库（`easy-fs/` + `easy-fs-fuse/`）

- `easy-fs/`：嵌入式文件系统实现（`no_std`，基于 block device trait）
- `easy-fs-fuse/`：主机端工具，用于将用户程序目录打包成文件系统镜像

### 5. 第三方依赖（`vendor/`）

约 140+ 个 crate 的本地副本，关键依赖包括：
- **smoltcp**：TCP/IP 协议栈
- **virtio-drivers** / **virtio-drivers-old**：VirtIO 设备驱动
- **lwext4_rust**：ext4 文件系统 Rust 绑定
- **rust-fatfs**：FAT32 文件系统
- **riscv** / **loongArch64**：架构寄存器定义与操作
- **buddy_system_allocator**：伙伴系统分配器
- **spin** / **lazy_static**：同步原语
- **xmas-elf**：ELF 解析
- **crate_interface**：跨 crate 接口调用

---

## 三、构建工具需求

根据 `Makefile`、`Dockerfile` 和 `rust-toolchain.toml` 分析：

| 工具类型 | 具体工具 | 用途 |
|---------|---------|------|
| **Rust 工具链** | `rustc`、`cargo`（nightly-2024-08-01） | 编译内核、用户程序、文件系统工具 |
| **Rust 组件** | `rust-src`、`llvm-tools-preview`、`rustfmt`、`clippy` | 源码级编译、LTO、格式化 |
| **Cargo 工具** | `cargo-binutils`（提供 `rust-objcopy`、`rust-objdump`） | 二进制处理 |
| **交叉编译目标** | `riscv64gc-unknown-none-elf`、`loongarch64-unknown-none` | RISC-V / LoongArch 裸机目标 |
| **QEMU** | `qemu-system-riscv64`（7.0.0） | RISC-V 模拟 |
| **Docker** | Docker | 构建环境容器化 |
| **Python** | Python 3 | 用户程序构建脚本 |
| **GDB** | `riscv64-unknown-elf-gdb` | 调试 |

构建流程概览：
1. `user/` 编译用户程序为 ELF → 转为 bin
2. `easy-fs-fuse/` 将用户程序打包成 `fs.img`
3. `os/` 编译内核 ELF → 转为 bin（嵌入 initproc）
4. QEMU 加载 `rustsbi-qemu.bin`（SBI）+ 内核 bin + `fs.img`（VirtIO 块设备）

---

## 四、初步评估总结

该项目是一个基于 Rust 的宏内核（monolithic kernel），其设计源自 rCore 教学系统，但已显著扩展至接近 Linux 兼容的层次：

1. **双架构支持**：RISC-V 64（完整功能）+ LoongArch 64（基础功能，IRQ/网络为 stubs）。
2. **丰富的系统调用**：实现了约 200+ 个 Linux 兼容的 syscall（基于 RISC-V syscall ABI），覆盖文件、进程、IPC、网络、同步、内存管理等。
3. **多文件系统支持**：easy-fs（自研）、ext4（通过 lwext4_rust）、FAT32（通过 rust-fatfs），支持 procfs。
4. **网络支持**：基于 smoltcp 的 TCP/UDP + loopback + Unix domain socket（RISC-V）。
5. **设备驱动**：VirtIO 块设备、网络设备、输入设备（键盘/鼠标）、NS16550A UART、PLIC 中断控制器。
6. **同步原语**：mutex、condvar、semaphore、futex。
7. **高级特性**：epoll、eventfd、signalfd、timerfd、memfd、mmap/munmap/mprotect、信号处理、TLS。

代码规模：内核主体约 37000 行（`os/src`）+ 架构层约 4200 行（`arch/src`）+ 用户库约 2200 行（`user/src`）+ 文件系统库约 1100 行（`easy-fs/src`）= **总计约 45000 行 Rust 源码**（不含 vendor 第三方代码和汇编）。