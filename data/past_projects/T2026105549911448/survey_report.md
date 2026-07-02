## 项目初步调查分析报告

### 一、项目概览

该项目名为 **xiande-OS**，是一个面向 2026 年全国大学生计算机系统能力大赛（OS 内核实现赛题）的竞赛内核。使用 Rust 编写（`no_std` + `alloc`），支持 RISC-V64 和 LoongArch64 双架构，运行于 QEMU `virt` 平台。内核直接构建出可被评测机启动的 ELF 文件，并在一次启动中运行完整的竞赛测试套件。

---

### 二、仓库文件组织结构

```
repo/
├── Cargo.toml                # Rust workspace 根配置（kernel + xtask）
├── Cargo.lock                # 依赖锁定文件
├── Makefile                  # 顶层构建入口（make all）
├── Dockerfile                # 可复现构建环境
├── README.md                 # 项目说明文档
├── LICENSE                   # MIT OR Apache-2.0
├── .gitignore
│
├── kernel/                   # ★ 内核主 crate
│   ├── Cargo.toml            #   内核依赖与 feature flags 定义
│   ├── build.rs              #   构建脚本（嵌入用户程序、链接脚本选择）
│   ├── linker.ld             #   RISC-V 链接脚本
│   ├── linker-la.ld          #   LoongArch 链接脚本
│   ├── cargo/config.toml     #   内核专用 cargo 配置（目标三元组、rustflags）
│   └── src/                  #   内核全部源代码（约 31,000 行 Rust）
│       ├── main.rs           #      入口：kmain()
│       ├── arch/             #      架构后端
│       ├── mm/               #      内存管理
│       ├── fs/               #      虚拟文件系统
│       ├── task/             #      任务管理与调度
│       ├── syscall/          #      系统调用
│       ├── net/              #      网络栈
│       ├── drivers/          #      设备驱动
│       ├── sync/             #      同步原语
│       ├── signal.rs         #      信号处理
│       ├── loader/           #      ELF 加载器
│       ├── console.rs        #      内核控制台输出
│       ├── contest_runner.rs #      竞赛测试套件编排器
│       ├── ksyms.rs          #      内核符号表
│       └── vdso.rs           #      vDSO 支持
│
├── xtask/                    # ★ 自动化任务 crate (cargo xtask)
│   ├── Cargo.toml
│   └── src/main.rs           #      build/qemu 子命令
│
├── user/                     #   预编译的用户态二进制文件与测试用例
│   ├── busybox.elf           #      嵌入式 BusyBox
│   ├── git.elf / real_git.elf
│   ├── dyn_hello.elf         #      动态链接测试程序
│   ├── ld-musl-riscv64.so.1  #      musl 动态链接器
│   ├── disk.img              #      测试用文件系统镜像（8 MiB）
│   └── *.c /*.elf            #      各种测试程序源代码和预编译 ELF
│
├── scripts/                  #   辅助脚本
│   ├── gen_ksyms.py          #      内核符号表生成（Python）
│   ├── build_la_stub.sh      #      LoongArch 占位内核构建
│   ├── la_stub.S             #      LoongArch 占位 stub 汇编
│   ├── mini-disk.sh          #      微型磁盘镜像制作
│   └── run-mini.sh           #      微型运行脚本
│
├── cargo/                    #   Cargo 全局配置（评测机会复制到 .cargo/）
│   └── config.toml           #      xtask alias + vendor 源配置
│
├── vendor/                   #   全部第三方 Rust crate 的本地副本（离线构建用）
│   └── (37 个 vendored crates: spin, smoltcp, virtio-drivers,
│        buddy_system_allocator, riscv, sbi-rt, fdt, xmas-elf 等)
│
└── docs/                     #   设计文档
    ├── 设计文档.md
    ├── benchmark-blockers.md
    ├── shm-iozone-investigation.md
    └── 答辩PPT.pptx
```

---

### 三、子系统划分

| 子系统 | 主要源文件/目录 | 行数（约） | 功能概述 |
|--------|----------------|-----------|----------|
| **架构后端** (`arch`) | `kernel/src/arch/{riscv64,loongarch64}/` | ~1,500 | 陷阱处理、上下文切换、MMU 操作、定时器、关机、控制台 I/O。通过 `arch/mod.rs` 做统一抽象，上层代码无 ISA 条件编译。 |
| **内存管理** (`mm`) | `kernel/src/mm/{mod,address,frame,heap,memory_set,page_table}.rs` | ~1,750 | Sv39 页表、帧分配器（基于 buddy_system_allocator）、内核堆、地址空间管理（MemorySet/VmArea）。通过设备树检测物理内存边界。 |
| **任务管理** (`task`) | `kernel/src/task/mod.rs` | ~2,480 | 进程/线程结构（Task）、调度器、fork/clone/execve/wait 内核侧逻辑、kstack 管理、僵尸回收、vfork 阻塞、定时器管理等。 |
| **系统调用** (`syscall`) | `kernel/src/syscall/{mod,nr,keys,socket,sysv_ipc}.rs` | ~13,500 | 系统调用分发（约 200+ 个 syscall）：文件 I/O、进程管理、信号、网络 socket、SysV IPC、定时器、扩展属性、ioctl 等。`mod.rs` 约 9,850 行。 |
| **虚拟文件系统** (`fs`) | `kernel/src/fs/{mod,ext2,ext4,fat32,tmpfs,devfs,procfs,pipe,socket,notify}.rs` | ~5,600 | VFS 抽象层（Inode trait）、文件描述符表。支持 ext2/ext4（读/写）、FAT32、tmpfs（内存文件系统）、devfs、procfs、管道、Unix域socket、inotify/fanotify。 |
| **设备驱动** (`drivers`) | `kernel/src/drivers/{mod,virtio_blk,virtio_net,pci}.rs` | ~1,050 | virtio-blk（块设备）、virtio-net（网络设备）。支持 virtio-mmio（RISC-V）和 virtio-pci（LoongArch）两种传输层。 |
| **网络栈** (`net`) | `kernel/src/net/{mod,loopback}.rs` | ~780 | smoltcp 集成：IP 10.0.2.15/24、默认网关、TCP/UDP socket、本地回环 (127.0.0.1)。 |
| **同步原语** (`sync`) | `kernel/src/sync/{mod,spinlock,futex}.rs` | ~650 | 基于 `spin::Mutex` 的抢占比锁、futex 系统调用、RwLock 重导出。 |
| **信号处理** | `kernel/src/signal.rs` | ~1,100 | POSIX 信号：sigaction、信号掩码、信号递送、sigreturn、替代信号栈、SA_RESTORER 页面。 |
| **ELF 加载器** (`loader`) | `kernel/src/loader/mod.rs` | ~270 | 静态/动态 ELF 加载、PT_INTERP 解析、PIE 重定位、程序断点（brk）管理。 |
| **vDSO** | `kernel/src/vdso.rs` + `kernel/src/vdso/*` | ~100 | 预编译 vDSO ELF，映射至每个地址空间，提供 `__vdso_rt_sigreturn`，支持 glibc 的 `AT_SYSINFO_EHDR`。 |
| **竞赛编排器** | `kernel/src/contest_runner.rs` | ~1,140 | 扫描评测磁盘映像，按优先级运行各测试组（basic→lua→busybox→ltp→libctest→iperf/netperf→benchmarks），超时包装。 |
| **内核符号表** (`ksyms`) | `kernel/src/ksyms.rs` | ~120 | 内嵌符号表，崩溃时自解析 `function+offset`。通过两遍构建链接过程嵌入。 |
| **控制台** | `kernel/src/console.rs` | ~30 | 内核日志输出（`println!` / `print!` 宏），委托到架构后端。 |

---

### 四、架构特征

1. **双架构支持**：RISC-V64（主要）和 LoongArch64，通过 `#[cfg(target_arch)]` 选择后端，上层代码完全架构无关。
2. **竞赛模式**：`contest` feature（默认开启），内核启动后直接挂载评测磁盘映像，自动编排运行测试用例，完成后关机。
3. **内嵌用户态**：busybox、git、动态链接器等作为字节数组编译进内核，挂载到 `/bin` 下作为初始运行环境。
4. **两遍构建**：先构建含空符号表的内核，再从中提取符号、重新链接，使崩溃日志自带函数名解析。

---

### 五、构建工具依赖

| 工具 | 用途 | 必需 |
|------|------|------|
| **Rust 稳定版工具链**（rustc、cargo） | 编译内核和 xtask | 是 |
| **rustup** | 安装 `riscv64gc-unknown-none-elf` 和 `loongarch64-unknown-none` 目标 std | 推荐 |
| **GNU Make** | 顶层构建入口 `make all` | 是 |
| **Python 3** | 内核符号表生成脚本 `gen_ksyms.py` | 否（缺失时退化为无符号表内核） |
| **QEMU**（qemu-system-riscv64 / qemu-system-loongarch64） | 运行与测试 | 否（仅用于运行） |
| **bash** | Makefile 和辅助脚本中的 shell 步骤 | 是 |
| **curl** | 中国大陆镜像探测（可选） | 否 |

所有第三方 Rust 依赖已通过 `vendor/` 目录离线化，构建不需要网络。Dockerfile 提供基于 `rust:1.94-slim-bookworm` 的完整可复现构建环境。