## 项目结构

```
.
├── AGENTS.md
├── CHANGELOG.md
├── DESIGN.md                  # 空文件（占位）
├── Makefile                   # 顶层 Makefile，分发到 oskernel/
├── README.md                  # 项目模板 README（未实质填写）
├── REFERENCE.md
├── RUNNER_STATUS.md
├── baseline-rcore/            # 空目录（baseline 参考内核）
├── docs/                      # 项目文档（设计、状态、计划等）
├── oskernel/                  # ★ 主内核代码
│   ├── Makefile               #   内核构建入口
│   ├── Dockerfile             #   Docker 构建环境
│   ├── rust-toolchain.toml    #   Rust 工具链配置（nightly-2025-02-18）
│   ├── bootloader/            #   预编译 SBI bootloader 二进制
│   │   └── rustsbi-qemu.bin
│   ├── os/                    #   ★ 内核主体
│   │   ├── Cargo.toml
│   │   ├── Makefile
│   │   ├── build.rs
│   │   └── src/
│   │       ├── main.rs        #   内核入口
│   │       ├── la_main.rs     #   LoongArch 最小启动内核
│   │       ├── config.rs      #   内核常量配置
│   │       ├── entry.asm      #   汇编入口
│   │       ├── linker-qemu.ld #   RISC-V 链接脚本
│   │       ├── linker-la.ld   #   LoongArch 链接脚本
│   │       ├── linux_abi.rs   #   Linux ABI 常量（errno、syscall 号、文件标志等）
│   │       ├── lang_items.rs  #   Rust 语言项
│   │       ├── logging.rs     #   日志
│   │       ├── console.rs     #   控制台抽象
│   │       ├── sbi.rs         #   SBI 接口封装
│   │       ├── timer.rs       #   定时器抽象
│   │       ├── arch/          #   架构相关代码
│   │       │   ├── riscv64/   #     RISC-V 64 位
│   │       │   └── loongarch64/#    LoongArch 64 位
│   │       ├── boards/        #   板级配置（qemu.rs）
│   │       ├── drivers/       #   设备驱动
│   │       │   ├── block/     #     块设备（VirtIO Block）
│   │       │   ├── bus/       #     总线（VirtIO MMIO 传输层）
│   │       │   ├── chardev/   #     字符设备（NS16550a UART）
│   │       │   ├── gpu/       #     GPU（virtio-gpu，含 framebuffer）
│   │       │   ├── input/     #     输入设备（virtio-keyboard, virtio-mouse）
│   │       │   └── net/       #     网络设备（virtio-net）
│   │       ├── fs/            #   文件系统
│   │       │   ├── ext4/      #     EXT4 文件系统实现
│   │       │   ├── inode.rs   #     inode 抽象
│   │       │   ├── pipe.rs    #     管道
│   │       │   └── stdio.rs   #     标准输入输出
│   │       ├── mm/            #   内存管理
│   │       ├── net/           #   网络协议栈
│   │       ├── sync/          #   同步原语
│   │       ├── syscall/       #   系统调用实现
│   │       ├── task/          #   任务/进程管理
│   │       ├── trap/          #   中断/异常处理
│   │       ├── runner/        #   测试运行器（自动化脚本执行框架）
│   │       └── assert/        #   位图资源（desktop.bmp 等）
│   ├── easy-fs/               #   简易文件系统库（类 FAT 的 inode 文件系统）
│   ├── easy-fs-fuse/          #   easy-fs 镜像制作工具
│   └── user/                  #   用户态程序
│       └── src/
│           ├── bin/           #     60+ 个用户态测试/示例程序
│           ├── syscall.rs     #     用户态 syscall 封装
│           ├── task.rs        #     用户态任务 API
│           ├── sync.rs        #     用户态同步原语
│           └── net.rs         #     用户态网络
├── scripts/                   # 辅助脚本（日志分析、运行脚本等）
└── testsuits-for-oskernel/    # 空目录（测试套件）
```

---

## 子系统识别

### 1. 架构抽象层（`os/src/arch/`）

| 目录 | 说明 |
|---|---|
| `arch/riscv64/` | RISC-V 64 位：boot、console、context 切换、CSR 操作、MM、shutdown、syscall 入口、timer、trap、用户态切换 |
| `arch/loongarch64/` | LoongArch 64 位：同上结构，外加 `entry.S`（汇编入口） |
| `boards/qemu.rs` | QEMU virt 板级配置（内存布局、MMIO 地址、PLIC、设备初始化、IRQ 路由） |

### 2. 驱动子系统（`os/src/drivers/`）

| 子目录 | 内容 | 代码量 |
|---|---|---|
| `block/` | VirtIO Block 驱动 (`virtio_blk.rs`) | ~145 行 |
| `bus/` | VirtIO MMIO 传输层 (`virtio.rs`) | ~49 行 |
| `chardev/` | NS16550a UART 驱动 | ~203 行 |
| `gpu/` | virtio-gpu 驱动，framebuffer 操作 | ~110 行 |
| `input/` | virtio-keyboard + virtio-mouse 驱动 | ~122 行 |
| `net/` | virtio-net 驱动封装 | ~46 行 |

### 3. 内存管理（`os/src/mm/`，~1185 行）

- `address.rs`：物理/虚拟地址抽象（`PhysAddr`、`VirtAddr`、`PhysPageNum`、`VirtPageNum`）
- `frame_allocator.rs`：物理页帧分配器
- `heap_allocator.rs`：内核堆分配器（基于 `buddy_system_allocator`）
- `page_table.rs`：页表操作（Sv39 页表）
- `memory_set.rs`：内存集合（地址空间管理：`MapArea`、`MemorySet`）

### 4. 文件系统（`os/src/fs/`，~1826 行）

- `mod.rs`：VFS 抽象（`File` trait、`FileMetadata`、`FsBackend` 枚举）
- `inode.rs`：inode 抽象 + 文件查找/打开逻辑，桥接 easy-fs 和 ext4
- `pipe.rs`：管道实现
- `stdio.rs`：标准输入输出
- `ext4/`：EXT4 只读实现（superblock、group descriptor、inode 读取，~1094 行）

### 5. 网络协议栈（`os/src/net/`，~609 行）

- `mod.rs`：网络初始化、网卡轮询
- `socket.rs`：Socket 抽象
- `tcp.rs`：TCP socket 实现（基于 `lose-net-stack`）
- `udp.rs`：UDP socket 实现
- `port_table.rs`：端口号分配管理

### 6. 进程/任务管理（`os/src/task/`，~1616 行）

- `process.rs`：进程控制块（PCB）、`execve`、`fork`、`waitpid` 等
- `processor.rs`：处理器调度（当前任务上下文切换）
- `task.rs`：任务控制块（TCB）、线程抽象
- `manager.rs`：PID/TID 管理器
- `id.rs`：PID/TID 分配回收
- `context.rs`：任务上下文
- `switch.rs` + `switch.S`：上下文切换汇编
- `fd_meta.rs`：文件描述符元数据
- `signal.rs`：信号处理

### 7. 同步原语（`os/src/sync/`，~340 行）

- `mutex.rs`：互斥锁（基于 `UPIntrFreeCell` 的自旋锁风格）
- `condvar.rs`：条件变量
- `semaphore.rs`：信号量
- `up.rs`：`UPIntrFreeCell`（关中断保护的内部可变性容器）

### 8. 系统调用（`os/src/syscall/`，~6757 行）

这是最大的子系统，按功能分文件：

| 文件 | 行数 | 说明 |
|---|---|---|
| `mod.rs` | 395 | 总入口，syscall 路由分发 |
| `fs.rs` | 2985 | 文件系统相关 syscall（openat, read, write, close, lseek, getdents64, stat, mount 等） |
| `process.rs` | 1515 | 进程管理 syscall（fork, exec, waitpid, brk, mmap, munmap 等） |
| `compat.rs` | 623 | 兼容层（不同调用约定的参数转换） |
| `mm.rs` | 288 | 内存管理 syscall |
| `sync.rs` | 431 | 同步相关 syscall（futex, mutex, semaphore, condvar） |
| `time.rs` | 218 | 时间相关 syscall |
| `thread.rs` | 93 | 线程 syscall |
| `signal.rs` | 98 | 信号 syscall |
| `net.rs` | 53 | 网络 syscall（socket, bind, listen, accept, connect 等） |
| `gui.rs` | 34 | GUI syscall（framebuffer 操作） |
| `input.rs` | 24 | 输入事件 syscall |

### 9. 中断/异常处理（`os/src/trap/`，~335 行）

- `mod.rs`：trap 处理入口、系统调用分发、中断处理
- `context.rs`：Trap 上下文结构
- `trap.S`：汇编 trap 入口/出口

### 10. 测试运行器（`os/src/runner/`，~1127 行）

自动化测试框架，解析并执行 shell 脚本格式的测试用例，支持超时机制、结果矩阵输出。用于运行 glibc/musl/busybox/lua 等测试套件。

### 11. easy-fs 简易文件系统（`easy-fs/` + `easy-fs-fuse/`）

- `easy-fs/`：类 FAT 的 inode 文件系统库（~1000+ 行），含 bitmap、block_cache、layout、vfs
- `easy-fs-fuse/`：主机端工具，将用户程序目录打包为 easy-fs 镜像

### 12. 用户态程序（`user/src/bin/`，60+ 个程序）

涵盖：同步测试（mutex、semaphore、condvar、peterson、eisenberg）、进程测试（fork、exec、exit）、文件 I/O 测试、网络测试（TCP HTTP server、UDP）、GUI 测试（snake、图形绘制）、协程测试（stackful/stackless）、综合测试（usertests、user_shell）等。

---

## 构建系统与工具依赖

### 构建工具链

| 需求 | 说明 |
|---|---|
| Rust 工具链 | `nightly-2025-02-18`，需 `rust-src`、`llvm-tools`、`rustfmt`、`clippy` 组件 |
| 目标平台 | `riscv64gc-unknown-none-elf`（主）、`loongarch64-unknown-none`（辅） |
| cargo-binutils | `rust-objcopy`、`rust-objdump` |
| QEMU | `qemu-system-riscv64` >= 7.0.0 |
| SBI | RustSBI（预编译 `rustsbi-qemu.bin`） |
| 链接脚本 | `linker-qemu.ld`（RISC-V）、`linker-la.ld`（LoongArch） |

### 构建流程

1. **RISC-V 内核**：`make kernel-rv` -> `os/Makefile build` -> cargo build (release) -> objcopy 生成 raw binary -> 与 easy-fs 镜像一起被 QEMU 加载
2. **LoongArch 内核**：`make kernel-la` -> 直接调用 `rustc` 编译 `la_main.rs`（最小启动内核，无完整功能）
3. **文件系统镜像**：easy-fs-fuse 将 `user/src/bin/` 下的用户程序 ELF 打包为 `fs.img`

### 外部依赖（Cargo）

| 依赖 | 用途 |
|---|---|
| `riscv` (rcore-os) | RISC-V 寄存器/指令封装 |
| `virtio-drivers` (rcore-os) | VirtIO 设备驱动 |
| `lose-net-stack` | 用户态 TCP/IP 协议栈 |
| `buddy_system_allocator` | 伙伴系统物理内存分配 |
| `xmas-elf` | ELF 文件解析 |
| `easy-fs` (本地) | 简易文件系统 |
| `embedded-graphics` + `tinybmp` | GUI 图形绘制 |
| `sbi-rt` | SBI runtime 接口 |

---

## 小结

该项目是一个基于 Rust 的类 Unix 宏内核，从 rCore-Tutorial-v3 演进而来，当前主要特点：

- **主目标架构**：RISC-V 64（QEMU virt），**辅助架构**：LoongArch 64（仅最小启动）。
- **核心子系统齐全**：内存管理、进程/线程管理、文件系统（easy-fs + EXT4 双后端）、网络协议栈、设备驱动、同步原语、信号处理。
- **Linux ABI 兼容**：实现了 80+ 个 Linux 系统调用号（含扩展的自定义 syscall），覆盖文件 I/O、进程、线程、同步、网络、时间、内存映射等。
- **测试框架完善**：内置 runner 子系统支持自动化运行外部测试套件（glibc/musl/busybox/lua）。
- **总代码量**：约 22,265 行 Rust + 少量汇编（不含 baseline-rcore、testsuits 等空目录）。