## 项目初步调查报告

### 一、项目总体结构

该项目名为 **Starry Next**，是基于开源框架 [ArceOS](https://github.com/arceos-org/arceos) 的 OS 内核比赛项目。整个仓库的组织如下：

```
OSKernel2026/
├── .axconfig.toml              # 根级平台配置（QEMU virt 设备布局等）
├── .gitignore
├── Dockerfile                   # 比赛评测容器镜像定义
├── Makefile                     # 顶层构建入口（kernel-rv / kernel-la）
├── oscontest-env.sh             # 工具链 PATH 环境脚本
├── kernel/                      # 内核主体目录
│   ├── Makefile                 # 内核构建调度（按 ARCH 调用 starry-next）
│   ├── README.md                # 说明内核布局变更
│   ├── starry-next/             # ★ 真正内核源码树（基于 ArceOS 的 vendored 版本）
│   ├── legacy_fake/             # 旧版"假内核"脚手架，仅作参考保留
│   ├── overlay/                 # 相对 upstream 的本地修改补丁及锁文件
│   └── scripts/                 # 构建辅助脚本（bootstrap、LA BIOS 等）
└── tools/                       # 构建/测试/评测辅助脚本
```

### 二、内核源码树内部结构（`kernel/starry-next/`）

```
starry-next/
├── Cargo.toml / Cargo.lock      # Rust 项目定义，crate 名 "starry"
├── Makefile                     # 内核级 Makefile（封装 arceos 构建流程）
├── build.rs                     # 构建脚本：嵌入运行时文件（musl/glibc loader/libc）
├── build_img.sh
├── src/                         # ★ Starry 自有内核代码
│   ├── main.rs                  # 内核入口、比赛看门狗、测试组调度
│   ├── mm.rs                    # 用户态内存管理（mmap/brk/mprotect/ELF 加载）
│   ├── task.rs                  # 进程/线程管理（fork/exec/clone/wait/pid）
│   ├── signal.rs                # 信号处理子系统
│   ├── loader.rs                # ELF 文件解析与加载
│   ├── timekeeping.rs           # 时间与定时器管理
│   ├── usercopy.rs              # 用户空间安全读写
│   ├── diag.rs                  # 诊断/日志
│   ├── ctypes.rs                # C 类型常量定义
│   └── syscall_imp/             # 系统调用实现
│       ├── mod.rs               # 系统调用路由分发
│       ├── fs/                  # 文件系统相关（io/ctl/fd_ops/stat/pipe/xattr/aio）
│       ├── mm/                  # 内存相关（mmap/brk）
│       ├── task/                # 任务相关（schedule/thread/keys）
│       └── utils/               # 工具类（misc/time/timerfd/sysv_ipc/system_info）
├── arceos/                      # ArceOS 框架（vendored）
│   ├── modules/                 # 内核模块
│   │   ├── axhal/               # 硬件抽象层（4 架构 + 多平台）
│   │   ├── axmm/                # 内存管理（地址空间、页表）
│   │   ├── axtask/              # 任务调度（run_queue/wait_queue/timer）
│   │   ├── axsync/              # 同步原语（Mutex）
│   │   ├── axalloc/             # 物理/虚拟内存分配器
│   │   ├── axfs/                # 文件系统（fatfs/ext4_rust/ramfs/vfs）
│   │   ├── axnet/               # 网络栈（smoltcp TCP/UDP/DNS）
│   │   ├── axdriver/            # 设备驱动框架（VirtIO/PCI/ramdisk）
│   │   ├── axruntime/           # 运行时初始化（lang_items/mp）
│   │   ├── axconfig/            # 编译期平台配置生成
│   │   ├── axlog/               # 日志系统
│   │   ├── axdisplay/           # 显示子系统
│   │   ├── axdma/               # DMA 子系统
│   │   └── axns/                # 命名空间
│   ├── api/                     # 对外 API
│   │   ├── arceos_api/          # 基础 API
│   │   └── arceos_posix_api/    # POSIX 兼容 API（文件/网络/线程/信号/epoll/select/pipe）
│   └── ulib/                    # 用户库
│       ├── axstd/               # Rust std 子集（线程/同步/IO/网络/进程）
│       └── axlibc/              # C 库子集（60+ 头文件，40+ C 源文件）
├── apps/                        # 测试应用清单（oscomp 等）
├── configs/                     # Starry 级架构配置（riscv64/loongarch64/x86_64/aarch64）
├── patches/                     # 对上游 crate 的本地覆盖（axerrno/axfs_ramfs/scheduler）
├── vendor/                      # 第三方 vendored crates（100+ Rust crates）
├── scripts/                     # 辅助脚本
└── cargo-config/                # Cargo 配置模板
```

### 三、子系统识别

根据目录和模块划分，该内核实现了以下子系统：

| 子系统 | 对应代码位置 | 说明 |
|---|---|---|
| **硬件抽象层 (HAL)** | `arceos/modules/axhal/` | 支持 riscv64/loongarch64/x86_64/aarch64，含 trap/中断/时钟/页表/上下文切换/TLS |
| **内存管理** | `arceos/modules/axmm/` + `src/mm.rs` | 物理页分配（axalloc）、虚拟地址空间、mmap/brk/mprotect/mremap、ELF 加载 |
| **任务管理** | `arceos/modules/axtask/` + `src/task.rs` | 线程调度（RR）、进程模型、fork/clone/exec/wait、PID 管理、命名空间 |
| **同步原语** | `arceos/modules/axsync/` | Mutex、WaitQueue |
| **文件系统** | `arceos/modules/axfs/` + `src/syscall_imp/fs/` | VFS 层，支持 FAT32 (fatfs)、EXT4 (lwext4_rust)、RAMFS、DevFS，含 pipe/eventfd |
| **网络栈** | `arceos/modules/axnet/` | 基于 smoltcp 的 TCP/UDP/DNS、socket 接口 |
| **设备驱动** | `arceos/modules/axdriver/` | VirtIO (blk/net/gpu)、PCI、RAM disk、UART (16550/PL011/dw_apb) |
| **POSIX API** | `arceos/api/arceos_posix_api/` | 文件 IO、socket、epoll/select、pthread、signal、resource、time |
| **系统调用** | `src/syscall_imp/` | Linux 兼容系统调用路由与实现（约 17,800 行） |
| **信号处理** | `src/signal.rs` | 完整的 POSIX 信号（64 信号），含 sigaction/sigreturn/sigtimedwait 等 |
| **时间管理** | `src/timekeeping.rs` | nanosleep/clock_gettime/timerfd/ITIMER |
| **C 库** | `arceos/ulib/axlibc/` | 60+ C 头文件，40+ C 实现文件，覆盖大部分 POSIX 函数 |
| **Rust 标准库** | `arceos/ulib/axstd/` | Rust std 子集，供内核和用户态使用 |
| **运行时嵌入** | `build.rs` | 将 musl/glibc 的 loader 和 libc 嵌入内核镜像 |
| **比赛评测框架** | `src/main.rs` | 看门狗、测试组调度、输出评分解析 |

### 四、目标架构与平台

- **主要目标**：RISC-V 64 (riscv64-qemu-virt) 和 LoongArch 64 (loongarch64-qemu-virt)
- **辅助支持**：x86_64 (QEMU q35/PC) 和 AArch64 (QEMU virt/Raspi4/Phytium Pi/BSTA1000B)

### 五、构建工具链

项目构建依赖以下工具：

| 工具类别 | 具体工具 |
|---|---|
| **Rust 工具链** | rustc/cargo (nightly-2025-01-18)，cargo-binutils |
| **RISC-V 交叉编译** | riscv64-linux-musl-gcc/ld/objcopy（bootlin 工具链） |
| **LoongArch 交叉编译** | loongarch64-linux-musl-gcc/ld/objcopy（或 loongarch64-linux-gnu） |
| **模拟器** | qemu-system-riscv64, qemu-system-loongarch64 (10.0.2) |
| **固件** | OpenSBI（RISC-V），自定义 LA BIOS（kernel/scripts/la-qemu-bios.S） |
| **构建系统** | GNU Make（顶层 + arceos 层），Cargo |
| **容器化** | Docker（基于 zhouzhouyi/os-contest:20260104 镜像） |

构建流程为：顶层 `make all` 依次调用 `kernel-rv` 和 `kernel-la`，进入 `kernel/starry-next/` 后通过 `make test_build` 先构建 arceos 框架，再编译 starry crate，最后生成 `kernel-rv` 和 `kernel-la` 两个内核二进制文件。

### 六、初步判断

1. **项目性质**：这是一个成熟的 OS 内核项目，基于 ArceOS 模块化框架，面向 OS 内核比赛场景做了大量适配和增强。代码量较大（仅 starry 自有代码约 30,000+ 行 Rust，syscall 实现约 18,000 行）。

2. **核心贡献**：相比上游 ArceOS，该项目在 `overlay/starry-next-local.patch` 中维护了 34 个文件的修改（+1662/-270 行），主要集中在系统调用增强、POSIX 兼容性、LoongArch 支持、比赛评测集成等方面。

3. **legacy_fake 目录**：该目录是旧版比赛框架的"假内核"（仅输出文本绕过评测），已被当前真实内核替代，仅作参考保留。

4. **双架构策略**：RISC-V 和 LoongArch 通过条件编译共享同一套内核源码，仅在 HAL 层和编译配置层面区分。