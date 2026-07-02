## 项目初步调查报告

### 一、基本信息

| 项目 | 内容 |
|------|------|
| 项目名称 | weijun-eos-kernel |
| 编程语言 | Rust (edition 2021) |
| 目标架构 | riscv64gc-unknown-none-elf (RISC-V 64-bit, Sv39) |
| Rust 工具链 | 1.88.0 (稳定版) |
| 构建系统 | Cargo (通过顶层 Makefile 调用) |
| 运行环境 | QEMU virt 机器, OpenSBI, 512MB DRAM |
| 用途 | OS 大赛参赛项目 |

---

### 二、仓库文件组织结构

```
repo/
├── .gitignore                    # 忽略 sdcard*, kernel-rv, test 文件等
├── .vscode/
│   └── settings.json             # rust-analyzer 配置 (riscv64gc目标)
├── Makefile                      # 顶层构建/模拟脚本
├── PROBLEMS.md                   # 开发者记录的问题笔记
├── README.md                     # 简要使用说明
├── rust-toolchain.toml           # Rust 工具链配置
├── min_run_testcode              # 预编译的 ELF 测试程序 (嵌入内核)
├── apps/
│   └── exam_folder.c             # 一个 C 测试用例 (stat 根目录)
├── docs/
│   ├── 00-PREPARE.md             # 开发环境搭建 (Rustup 镜像)
│   ├── README.md                 # 大赛链接
│   └── tech/
│       └── MEMORY.md             # 内存布局说明 (0x80000000~0xA0000000)
└── kernel/                       # 内核主体
    ├── .gitignore                # 忽略 target/
    ├── Cargo.lock
    ├── Cargo.toml                # 依赖声明
    ├── memory.x                  # 链接器脚本 (入口 0x80200000)
    └── src/
        ├── main.rs               # 内核核心 (~1831行)
        ├── syscalls.rs           # 系统调用实现 (~1844行)
        ├── paging.rs             # 页表/内存管理 (~238行)
        ├── fs.rs                 # 文件系统/块设备 (~173行)
        ├── buftool.rs            # 缓冲区写入工具 (~54行)
        └── utils.rs              # log!/trace! 宏 (~15行)
```

---

### 三、子系统划分

#### 1. 启动与入口 (`kernel/src/main.rs`)

- **`_start()`**：裸函数入口，位于 `.text.init` 段；清零 BSS、设置栈指针、跳转 `kmain`
- **`kmain(hartid, dtb_entry)`**：内核主函数，打印 banner，初始化各子系统，调用 `run()` 进入用户态
- **`run()`**：初始化堆、页分配器（物理内存区间 `0x95000000~0xA0000000`）、根页表（DRAM + MMIO 直接映射）、安装 `stvec` 指向 `temporary_trap_entry`、初始化 virtio-blk 和 ext4 文件系统、加载并执行初始用户程序

#### 2. 陷阱/中断处理 (`kernel/src/main.rs`)

- **汇编部分**：`temporary_trap_entry`（内联全局汇编）—— 保存全部 GPR + CSR（`sepc`/`sstatus`/`scause`/`stval`）到 `TrapFrame`，调用 Rust 的 `temporary_trap_handler`，然后从 `TrapFrame` 恢复并 `sret`
- **`TrapFrame`**：完整保存 31 个通用寄存器 + sp + 4 个 CSR
- **`TrapKind`**：分类解析 `scause`：UserEcall(8)、Breakpoint(3)、InstructionPageFault(12)、LoadPageFault(13)、StorePageFault(15)、IllegalInstruction(2)、Unknown
- **`temporary_trap_handler()`**：根据 `TrapKind` 分发：用户 ecall → `dispatch_syscall`；缺页/非法指令 → `unrecoverable()` 打印信息后死循环

#### 3. 系统调用 (`kernel/src/syscalls.rs` + `main.rs` 中的 `dispatch_syscall`)

覆盖约 **50+ 个系统调用**，按功能分组：

| 类别 | 系统调用 |
|------|----------|
| 文件系统 | `openat`, `close`, `read`, `write`, `readv`, `writev`, `getdents64`, `mkdirat`, `unlinkat`, `linkat`, `chdir`, `getcwd`, `mount`, `umount2`, `newfstatat`, `fstat`, `utimensat`, `access`, `faccessat` |
| 进程管理 | `clone`, `execve`, `wait4`, `exit`, `exit_group`, `getpid`, `getppid`, `gettid`, `sched_yield` |
| 内存管理 | `brk`, `mmap`, `munmap`, `mprotect`, `madvise` |
| 时间 | `nanosleep`, `clock_gettime`, `clock_nanosleep`, `gettimeofday`, `times` |
| I/O 控制 | `ioctl`, `fcntl`, `dup`, `dup3`, `pipe2`, `ppoll` |
| 信号（桩） | `rt_sigaction`, `rt_sigprocmask`, `rt_sigsuspend`, `rt_sigreturn`（大多数直接返回 0） |
| 系统信息 | `uname`, `prlimit64`, `set_tid_address`, `set_robust_list` |
| 用户/组 | `getuid`, `geteuid`, `getgid`, `getegid`, `setsid`（均返回 0） |

`SyscallOp` 枚举统一解析 `a7` 系统调用号 + `a0~a5` 参数，`dispatch_syscall` 进行分发。

#### 4. 进程管理 (`kernel/src/main.rs`)

- **`Process`**：包含 pid、parent、children、状态 (`ProcessState`: Ready/Running/Waiting/Zombie/Dead)、页表索引、堆区间、mmap 区域、工作目录 (`Path`)、文件描述符表 (`[Fd; 128]`)、`TrapFrame`、`KernelContext`
- **`KernelCore`**：全局内核状态——页表列表 (`Vec<AddressSpace>`)、ext4 设备/文件系统、物理页分配器、进程列表、当前进程索引、全局文件资源表 (`Vec<FdResource>`)、管道列表 (`Vec<Pipe>`)
- **调度器**：协作式轮询 (`schedule()`)——在 Ready 进程中循环选择；`sched_in()` 通过 `context_switch`/`context_reset` 汇编切换内核上下文和 `satp`
- **进程创建**：`spawn_process()` 从 ext4 加载 ELF→`spawn_process_with_elf()` 解析 ELF 的 LOAD 段、构建用户栈（argv/envp/auxv）、返回 `TrapFrame`
- **Clone**：深拷贝页表（通过 `MyPagingHandler::deep_clone`），创建新进程
- **Execve**：复用当前进程，重新加载 ELF
- **进程退出**：标记 Zombie，释放文件资源/管道/mmap，唤醒父进程

#### 5. 内存管理 (`kernel/src/paging.rs` + `main.rs` 部分)

- **`MyPagingHandler`**：物理页帧分配器，基于伙伴系统（18 阶 free_area），管理 `0x95000000~0xA0000000` 区间
- **`AddressSpace`**：包装 `Sv39PageTable` + 引用计数
- **`map_pages()` / `unmap_pages()`**：按页映射/解除映射，调用分配器的 `alloc`/`free`
- **`KernelCore::new_pt()`**：创建新地址空间，分配内核栈、映射 DRAM 和 MMIO 区域
- 页表库来自 `page_table_entry` + `page_table_multiarch` crate，硬件为 RISC-V Sv39

#### 6. 文件系统与块设备 (`kernel/src/fs.rs`)

- **`VirtIoDisk`**：实现 `rsext4::BlockDevice` trait，基于 VirtIO-MMIO 块设备
- **`init_virtio_blk()`**：扫描 `0x10001000~0x10008000` 的 MMIO 基地址，识别 `DeviceType::Block`，初始化 `VirtIOBlk` 驱动，用 `Jbd2Dev` 包装后挂载 ext4（只读模式 `use_journal=false`）
- ext4 文件系统操作依赖 `rsext4` crate（open/read/ls/mkdir 等）
- **`FdResource`** 枚举：Stdin/Stdout/Stderr/File/PipeRead/PipeWrite

#### 7. 管道 (`kernel/src/main.rs`)

- **`Pipe`** 结构：基于 `VecDeque<u8>` 的环形缓冲区 + readers/writers PID 列表

#### 8. 辅助模块

- **`buftool.rs`**：`BufWriter`——向原始指针按小端序写入 u8/u16/u32/u64
- **`utils.rs`**：`log!` 宏（通过 SBI putchar 输出）、`trace!` 宏（默认禁用，编译时剔除）

#### 9. SBI 接口 (`kernel/src/main.rs`)

- `sbi_putchar` / `sbi_getchar`（直接读 UART MMIO `0x10000000`）、`sbi_call`、`sbi_shutdown`

---

### 四、外部依赖 (kernel/Cargo.toml)

| Crate | 用途 | 版本 |
|-------|------|------|
| `rsext4` | ext4 文件系统读写 | 0.4.1 |
| `virtio-drivers` | VirtIO 块设备驱动 | 0.13.0 |
| `page_table_entry` + `page_table_multiarch` | Sv39 页表管理 | 0.6.1 |
| `xmas-elf` | ELF 文件解析 | 0.10.0 |
| `linked_list_allocator` | 内核堆分配器 | 0.10.6 |
| `memory_addr` | 物理/虚拟地址类型 | 0.4.1 |
| `bitflags` + `lazy_static` | 位标志宏 + 延迟初始化 | 2.11.1 / 1.5.0 |

---

### 五、构建与模拟工具链

- **编译**：Rust 1.88.0 + `riscv64gc-unknown-none-elf` target，`cargo rustc --release` 通过 `memory.x` 链接脚本生成裸机 ELF
- **模拟**：QEMU (`qemu-system-riscv64`) + `-machine virt -m 512M` + OpenSBI 固件 + virtio-blk 磁盘镜像
- **测试应用构建**：`riscv64-linux-musl-cross` 工具链，静态链接 musl
- **推荐工具链组件**：`llvm-tools-preview`、`rust-src`、`rustfmt`、`clippy`

---

### 六、初步评估

该项目是一个 **RISC-V 64 位单体内核**，采用 Rust 语言实现，面向 OS 大赛评测环境。代码总量约 4155 行（不含依赖），集中于 `main.rs` 和 `syscalls.rs` 两大文件。

**已实现的子系统较完整**：进程创建与切换（clone/execve）、ext4 文件系统、VirtIO 块设备、管道、约 50+ 个 POSIX 系统调用、Sv39 虚拟内存。信号处理仅有桩实现，缺少抢占式调度（协作式轮询）、网络栈、多核支持等。项目仍处于活跃开发中（`PROBLEMS.md` 记录了已知的 mmap/buddy 等问题）。