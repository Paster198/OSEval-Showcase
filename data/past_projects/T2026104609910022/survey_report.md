## 项目初步调查结果

---

### 一、项目概览

**项目名称**: HPU OS  
**开发语言**: Rust (no_std, no_main)  
**目标架构**: RISC-V 64 (riscv64gc-unknown-none-elf) / LoongArch 64 (loongarch64-unknown-none)  
**项目性质**: 2026年全国大学生计算机系统能力大赛操作系统赛参赛项目  
**参考基础**: rCore-Tutorial-v3（架构框架）、NPUcore（功能实现）  
**总代码规模**:
- RISC-V 内核: 约 10,800 行 (Rust + 汇编)
- LoongArch 内核: 约 11,100 行 (Rust + 汇编)
- 用户程序: 约 190 行

---

### 二、仓库文件组织结构

```
repo/
├── Cargo.toml               # RISC-V 内核的 crate 清单
├── Cargo.lock
├── Makefile                  # 顶层构建入口 make all → kernel-rv + kernel-la
├── rust-toolchain.toml       # 指定 nightly-2025-05-20 工具链
├── run_qemu.sh              # QEMU 启动脚本
├── README.md
├── .gitignore
│
├── cargo-config/            # .cargo 目录的备份（评测系统过滤隐藏目录）
│   └── config.toml           # Cargo 构建配置（目标三元组、linker 参数）
│
├── src/                     # 【RISC-V 内核源码】
│   ├── main.rs               # 内核入口 rust_main()
│   ├── linker.ld             # 链接脚本（基址 0x80200000）
│   ├── entry.asm             # 启动汇编
│   ├── config.rs             # 内核配置常量
│   ├── console.rs            # 控制台输出
│   ├── sbi.rs                # RISC-V SBI 调用封装
│   ├── lang_items.rs         # panic_handler 等语言项
│   ├── timer.rs              # 时钟中断管理
│   ├── input.rs              # 输入处理
│   ├── test_runner.rs        # 评测测试编排器（~16,400 行）
│   ├── mm/                   # 【内存管理子系统】
│   │   ├── mod.rs
│   │   ├── address.rs        # 物理/虚拟地址抽象
│   │   ├── page_table.rs     # Sv39 页表
│   │   ├── frame_allocator.rs # 物理帧分配器
│   │   ├── heap_allocator.rs  # 内核堆分配器（基于 buddy_system_allocator）
│   │   └── memory_set.rs     # 地址空间管理 (MemorySet)
│   ├── task/                 # 【任务管理子系统】
│   │   ├── mod.rs
│   │   ├── task.rs           # 进程控制块 (TaskControlBlock)
│   │   ├── manager.rs        # 任务管理器
│   │   ├── processor.rs      # 处理器调度
│   │   ├── context.rs        # 任务上下文
│   │   ├── switch.S          # 上下文切换汇编
│   │   ├── elf.rs            # ELF 加载器
│   │   └── pid.rs            # PID 分配
│   ├── trap/                 # 【陷阱处理子系统】
│   │   ├── mod.rs            # 陷阱初始化与分发
│   │   ├── context.rs        # TrapContext 结构
│   │   └── trap.S            # 陷阱入口/恢复汇编 (__alltraps, __restore)
│   ├── syscall/              # 【系统调用子系统】
│   │   ├── mod.rs            # syscall 分发（~100+ 个 syscall ID）
│   │   ├── fs.rs             # 文件相关系统调用实现
│   │   ├── process.rs        # 进程相关系统调用实现（~2,300 行，最大模块）
│   │   └── errno.rs          # 错误码定义
│   ├── fs/                   # 【文件系统子系统】
│   │   ├── mod.rs
│   │   ├── ext4.rs           # EXT4 只读驱动
│   │   ├── vfs.rs            # 虚拟文件系统抽象
│   │   ├── fd_table.rs       # 文件描述符表
│   │   └── manager.rs        # 文件系统管理器（~2,200 行，含大量内嵌数据）
│   └── drivers/              # 【设备驱动子系统】
│       ├── mod.rs
│       └── block.rs          # virtio-blk 块设备驱动（~1,000 行）
│
├── src-la/                  # 【LoongArch 内核源码】（目录结构对称）
│   ├── main.rs               # 内核入口 loongarch_main()
│   ├── linker.ld             # 链接脚本
│   ├── entry.S               # 启动汇编
│   ├── loongarch_csr.rs      # LoongArch CSR/DMW 操作（RISC-V 无对应）
│   ├── (其余模块结构与 src/ 一一对应)
│   └── ...                   # mm/, task/, trap/, syscall/, fs/, drivers/
│
├── user/                    # 【嵌入式用户程序】
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # initproc: Hello + getpid + exit
│   │   ├── lib.rs            # 用户库: syscall 封装、格式化输出
│   │   └── linker.ld         # 用户程序链接脚本
│   └── cargo-config/         # cargo 配置备份
│
├── docs/                    # 【文档】
│   ├── HPU_OS.pptx           # 演示文稿
│   └── 说明文档.docx          # 说明文档
│
└── loongarc-package/        # 【LoongArch 评测打包工具】
    ├── README.md
    ├── CHANGELOG.md
    ├── build.bat
    ├── run-qemu.sh
    ├── run-qemu-wsl.sh
    └── diff-summary.txt
```

---

### 三、实现的子系统

| 子系统 | 所在目录 | 核心功能 |
|--------|----------|----------|
| **内存管理** | `src/mm/`, `src-la/mm/` | Sv39 页表 / LA 页表 + DMW，物理帧分配器，伙伴系统堆分配器，地址空间 (MemorySet) |
| **任务管理** | `src/task/`, `src-la/task/` | 进程控制块 (PCB)，调度器，ELF 加载，上下文切换，PID 分配，fork/clone/execve/wait4 |
| **陷阱处理** | `src/trap/`, `src-la/trap/` | 中断/异常入口 (`__alltraps`)，trap 分发，上下文保存/恢复 (`__restore`)，ecall/缺页/时钟中断处理 |
| **系统调用** | `src/syscall/`, `src-la/syscall/` | ~100+ 个 Linux syscall 号注册，涵盖文件、进程、信号、时间、网络、内存等类别 |
| **文件系统** | `src/fs/`, `src-la/fs/` | EXT4 只读驱动，VFS 抽象层，文件描述符表，管道 (pipe2)，inode 操作 |
| **设备驱动** | `src/drivers/`, `src-la/drivers/` | virtio-blk 块设备驱动 (virtio-mmio / virtio-pci) |
| **计时器** | `src/timer.rs`, `src-la/timer.rs` | 时钟中断设置 (RISC-V: SBI, LA: CSR TCFG/TICLR) |
| **控制台** | `src/console.rs`, `src-la/console.rs` | 串口输出 / log 系统 |
| **评测框架** | `src/test_runner.rs`, `src-la/test_runner.rs` | 自动扫描 EXT4 磁盘 `/basic` 目录，串行执行测试，输出标准标记 |

---

### 四、子系统与文件的对应关系（粗略）

| 子系统 | RISC-V 源文件 | LoongArch 源文件 |
|--------|--------------|-----------------|
| 启动与入口 | `src/main.rs`, `src/entry.asm`, `src/linker.ld`, `src/lang_items.rs` | `src-la/main.rs`, `src-la/entry.S`, `src-la/linker.ld`, `src-la/lang_items.rs` |
| 配置 | `src/config.rs` | `src-la/config.rs` |
| 控制台 | `src/console.rs` | `src-la/console.rs` |
| SBI/固件接口 | `src/sbi.rs` | `src-la/sbi.rs` |
| 架构 CSR | (使用 `riscv` crate) | `src-la/loongarch_csr.rs` |
| 内存管理 | `src/mm/*` (6 文件) | `src-la/mm/*` (6 文件) |
| 任务管理 | `src/task/*` (8 文件) | `src-la/task/*` (8 文件) |
| 陷阱处理 | `src/trap/*` (3 文件) | `src-la/trap/*` (3 文件) |
| 系统调用 | `src/syscall/*` (4 文件) | `src-la/syscall/*` (4 文件) |
| 文件系统 | `src/fs/*` (5 文件) | `src-la/fs/*` (5 文件) |
| 设备驱动 | `src/drivers/*` (2 文件) | `src-la/drivers/*` (2 文件) |
| 计时器 | `src/timer.rs` | `src-la/timer.rs` |
| 输入 | `src/input.rs` | `src-la/input.rs` |
| 评测框架 | `src/test_runner.rs` | `src-la/test_runner.rs` |

---

### 五、编译构建工具链

| 类别 | 所需工具 |
|------|----------|
| **Rust 工具链** | `rustc` nightly-2025-05-20, `cargo`, `rustup`（需安装 rust-src 组件） |
| **RISC-V 目标** | `riscv64gc-unknown-none-elf` target |
| **LoongArch 目标** | `loongarch64-unknown-none` target（通过 `-Zbuild-std=core,alloc` 构建） |
| **辅助工具** | `rust-objdump`, `rust-objcopy`（用于反汇编/二进制处理） |
| **QEMU** | `qemu-system-riscv64`（RISC-V virt 机器）, `qemu-system-loongarch64`（LA virt 机器） |
| **外部依赖 (crate)** | `sbi-rt`, `riscv`, `buddy_system_allocator`, `spin`, `lazy_static`, `bitflags`, `xmas-elf`, `log` |
| **构建方式** | `make all` 生成 `kernel-rv` (RISC-V ELF) 和 `kernel-la` (LoongArch ELF) |

构建流程为: `make all` → 恢复 `.cargo` 配置 → 编译用户程序 → 编译 RISC-V 内核（嵌入用户 ELF） → 编译 LoongArch 内核 → 输出 `kernel-rv` 和 `kernel-la`。

---

### 六、初步判断总结

1. **双架构设计**: RISC-V 和 LoongArch 两套内核代码基本**镜像对称**，`src/` 与 `src-la/` 目录结构一致，仅在架构相关部分（CSR 操作、页表格式、异常入口汇编）有差异。

2. **子系统完整度**: 覆盖了 OS 内核竞赛所需的六大核心子系统——内存管理、进程管理、文件系统、系统调用、设备驱动、中断处理。系统调用数量庞大（注册了 100+ 个 Linux syscall ID），但实际实现可能多为 stub。

3. **代码分布不均**: `syscall/process.rs`（~2,300 行）和 `fs/manager.rs`（~2,200 行）是最大的模块，`test_runner.rs`（~16,400 行）占据了 RISC-V 内核总代码量的大部分（约 60%），表明评测兼容性是项目的重点工程。

4. **构建依赖**: 需要 nightly Rust 工具链、两个交叉编译目标，以及 QEMU 模拟器。LoongArch 构建使用 `-Zbuild-std=core,alloc` 特性来编译 core/alloc 库。