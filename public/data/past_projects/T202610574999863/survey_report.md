## 项目结构

```
OSKernel2025-T202610574999863/
├── .git/                          # Git 版本控制
├── .gitignore                     # 忽略构建产物、编辑器临时文件等
├── Dockerfile                     # Docker 构建文件（定义评估环境）
├── Makefile                       # 顶层 Makefile，驱动全项目构建
├── README.md                      # 空文件
├── os日志.txt                     # 参赛队伍开发日志（约 2292 行）
├── docs/
│   └── design.md                  # 设计文档（目前为空）
├── scripts/
│   ├── build.sh                   # 构建脚本（封装 make）
│   ├── run_riscv.sh               # RISC-V 一键构建+运行
│   └── run_loongarch.sh           # LoongArch 一键构建+运行
└── kernel/
    ├── Makefile                   # 内核 Makefile，控制编译流程
    ├── include/                   # 内核公共头文件
    │   ├── types.h                # 基础类型定义（int8_t ~ uint64_t 等）
    │   ├── defs.h                 # 架构相关定义（UART、QEMU 关机、页对齐）
    │   ├── elf.h                  # ELF64 格式定义与加载接口
    │   ├── pmm.h                  # 物理内存管理器接口
    │   ├── vmm.h                  # 虚拟内存管理器接口
    │   ├── trap.h                 # 陷阱/异常处理接口
    │   ├── proc.h                 # 进程控制块(PCB)与进程管理接口
    │   ├── sched.h                # 调度器接口（轮转调度）
    │   ├── syscall.h              # 系统调用号、数据结构与接口
    │   ├── fs.h                   # VFS（虚拟文件系统）接口
    │   ├── ramfs.h                # RAM 文件系统接口
    │   ├── devfs.h                # 设备文件系统接口
    │   └── test_runner.h          # 测试运行器接口
    ├── src/                       # 架构无关的内核源码
    │   ├── main.c                 # 内核入口 (kernel_main)
    │   ├── pmm.c                  # 物理内存管理器（位图分配器）
    │   ├── vmm.c                  # 虚拟内存管理器（架构无关层）
    │   ├── trap.c                 # 陷阱处理（架构无关层）
    │   ├── proc.c                 # 进程管理（PCB 分配/回收、fork/wait/exit）
    │   ├── sched.c                # 调度器（轮转调度，架构无关层）
    │   ├── syscall.c              # 系统调用分发（36 个系统调用实现）
    │   ├── fs.c                   # VFS 实现（inode/dentry/file 表、路径解析）
    │   ├── ramfs.c                # RAM 文件系统实现
    │   ├── devfs.c                # 设备文件系统实现（/dev/console、/dev/null）
    │   ├── elf_loader.c           # ELF 加载器（支持 ELF 和 flat binary）
    │   ├── test_runner.c          # 比赛测试运行器（模拟 judge 流程）
    │   └── ltp_data.h             # LTP 测试用例名列表（1209 行，仅数据）
    └── arch/                      # 架构相关源码
        ├── riscv64/               # RISC-V 64-bit (rv64imac_zicsr, Sv39)
        │   ├── boot.S             # 启动入口（栈设置、BSS清零）
        │   ├── linker.ld          # 链接脚本（内核加载地址 0x80200000）
        │   ├── mmu.h              # Sv39 页表定义与 CSR 宏
        │   ├── trap_entry.S       # 陷阱入口汇编（保存/恢复寄存器）
        │   ├── trap.c             # 架构相关陷阱处理（中断号解码）
        │   ├── switch.S           # 上下文切换汇编
        │   ├── sched.c            # 架构相关调度（时钟中断设置）
        │   ├── vmm.c              # Sv39 页表操作（map/unmap/protect）
        │   ├── user_entry.S       # 用户模式入口（切换到 U-mode）
        │   ├── user_prog.S        # 内嵌用户测试程序
        │   ├── user_prog.ld       # 用户程序链接脚本
        │   ├── user_libctest.S    # 内嵌 libctest 测试程序
        │   ├── user_ltp.S         # 内嵌 LTP 测试程序
        │   └── user_hackbench.S   # 内嵌 hackbench 负载程序
        └── loongarch64/           # LoongArch 64-bit
            ├── boot.S             # 启动入口
            ├── linker.ld          # 链接脚本（加载地址 0x200000）
            ├── mmu.h              # 3 级页表定义与 CSR 宏
            ├── trap_entry.S       # 陷阱入口汇编
            ├── trap.c             # 架构相关陷阱处理
            ├── switch.S           # 上下文切换汇编
            ├── sched.c            # 架构相关调度（时钟中断设置）
            ├── vmm.c              # 页表操作（map/unmap/protect）
            ├── user_entry.S       # 用户模式入口（切换到 PLV3）
            ├── user_prog.S        # 内嵌用户测试程序
            ├── user_prog.ld       # 用户程序链接脚本
            ├── user_libctest.S    # 内嵌 libctest 测试程序
            ├── user_ltp.S         # 内嵌 LTP 测试程序
            └── user_hackbench.S   # 内嵌 hackbench 负载程序
```

---

## 子系统划分与粗略分析

### 1. 物理内存管理 (PMM)
- **代码**: `kernel/src/pmm.c`（135 行）、`kernel/include/pmm.h`
- **功能**: 基于位图的物理页分配器。每个位代表一个 4 KB 页（0=空闲，1=已分配）。最大跟踪 1 GB 物理内存（262144 页）。提供 `pmm_alloc_page()`、`pmm_free_page()`、`pmm_num_free()` 三个接口。

### 2. 虚拟内存管理 (VMM)
- **代码**: `kernel/src/vmm.c`（72 行，架构无关层）、`kernel/include/vmm.h`
- **架构层**: `kernel/arch/riscv64/vmm.c`（218 行）、`kernel/arch/riscv64/mmu.h`（Sv39）；`kernel/arch/loongarch64/vmm.c`（342 行）、`kernel/arch/loongarch64/mmu.h`（3 级页表）
- **功能**: 支持页表建立、单页映射/取消映射、权限修改、用户态可访问标记。RISC-V 使用 Sv39 虚拟地址方案，LoongArch 使用 3 级页表+DMW 直接映射窗口。提供 `vmm_map_page()`、`vmm_arch_map_page()`、`vmm_arch_protect_page()`、`vmm_arch_set_user_bit()` 等接口。内核启动时建立全物理内存的恒等映射。

### 3. 进程管理 (Proc)
- **代码**: `kernel/src/proc.c`（607 行）、`kernel/include/proc.h`
- **功能**: 维护最多 16 个进程的 PCB 表，每个进程拥有 4 页（16 KB）内核栈。支持 `proc_create()`（内核线程）、`proc_create_user()`（用户进程）、`proc_fork()`、`proc_wait()`/`proc_waitpid()`、`proc_exit()`/`proc_exit_code()`。PCB 包含：PID、PPID、状态（UNUSED/READY/RUNNING/BLOCKED/ZOMBIE）、上下文（callee-saved 寄存器）、FDT、brk、cwd、信号处理表（32 个信号）。

### 4. 调度器 (Sched)
- **代码**: `kernel/src/sched.c`（119 行，架构无关）、`kernel/include/sched.h`
- **架构层**: `kernel/arch/riscv64/sched.c`（106 行）、`kernel/arch/loongarch64/sched.c`（118 行）；`kernel/arch/riscv64/switch.S`（76 行）、`kernel/arch/loongarch64/switch.S`（72 行）
- **功能**: 轮转调度（Round-Robin），时间片为 10 个时钟滴答。`schedule()` 选取下一个 READY 进程。`switch_to()` 保存当前进程 callee-saved 寄存器并恢复下一个进程。RISC-V 使用 `mtimecmp` 定时器中断，LoongArch 使用稳定计数器。

### 5. 陷阱/异常处理 (Trap)
- **代码**: `kernel/src/trap.c`（394 行）、`kernel/include/trap.h`
- **架构层**: `kernel/arch/riscv64/trap_entry.S`（202 行）、`kernel/arch/riscv64/trap.c`（22 行）；`kernel/arch/loongarch64/trap_entry.S`（229 行）、`kernel/arch/loongarch64/trap.c`（22 行）
- **功能**: 统一的陷阱入口，保存完整寄存器帧（32 个通用寄存器 + epc/status/cause/tval）。`trap_handler()` 解码异常原因并分发：系统调用（ecall/syscall）转发给 `syscall_handler()`，时钟中断触发 `sched_tick()`，页错误、非法指令等打印诊断信息。

### 6. 系统调用 (Syscall)
- **代码**: `kernel/src/syscall.c`（1253 行）、`kernel/include/syscall.h`
- **功能**: 实现 36 个系统调用，涵盖：文件 I/O（open/read/write/close）、进程管理（fork/execve/exit/wait/waitpid/clone）、内存管理（brk/mmap/munmap/mprotect）、文件系统（mkdir/unlink/getdents/chdir/getcwd/mount/umount）、信号（sigaction/sigreturn/kill）、时间（gettimeofday/times/sleep）、信息（getpid/getppid/uname/fstat/dup/dup2/pipe）。提供 `ksyscall()` 内核内部直接调用接口。

### 7. 虚拟文件系统 (VFS) + RAM 文件系统 + 设备文件系统
- **代码**: `kernel/src/fs.c`（765 行）、`kernel/src/ramfs.c`（197 行）、`kernel/src/devfs.c`（262 行）
- **头文件**: `kernel/include/fs.h`、`kernel/include/ramfs.h`、`kernel/include/devfs.h`
- **功能**: VFS 层维护全局 inode 表（512 个）、dentry 表（512 个）、file 表（512 个），支持路径解析、挂载点、基于 inode 编号的当前工作目录。ramfs 在物理内存页中存储文件数据。devfs 提供 `/dev/console`（UART 字符设备）和 `/dev/null`。

### 8. ELF 加载器
- **代码**: `kernel/src/elf_loader.c`（212 行）、`kernel/include/elf.h`
- **功能**: 解析 ELF64 头，遍历 PT_LOAD 段，将代码/数据复制到用户空间并零填充 BSS。也支持 flat binary（直接复制到 USER_CODE_BASE）。

### 9. 测试运行器 (Test Runner)
- **代码**: `kernel/src/test_runner.c`（3532 行）、`kernel/include/test_runner.h`
- **辅助数据**: `kernel/src/ltp_data.h`（1209 行，LTP 测试用例名列表）
- **功能**: 模拟 OSKernel2025 比赛的评估流程：扫描根文件系统中的测试脚本，调度匹配的内置处理程序，通过 VFS 输出比赛格式的测试结果。这是整个仓库中最大的单个源文件。

### 10. 用户态测试程序（内嵌）
- **代码**（每个架构各一份）: `user_prog.S`、`user_libctest.S`、`user_ltp.S`、`user_hackbench.S`
- **功能**: 内嵌在 `kernel/arch/<arch>/user_*.S` 中的汇编语言测试程序。它们被标记为 `.data` 段中的二进制 blob，由 `sys_execve()` 加载到用户空间。`user_entry.S` 提供切换到用户模式的机制（RISC-V 用 `sret` 切换 U-mode，LoongArch 用 `ertn` 切换 PLV3）。

---

## 构建工具需求

根据 `Makefile` 和 `Dockerfile` 分析，构建该项目需要：

| 工具 | 用途 | 来源 |
|------|------|------|
| `riscv64-linux-gnu-gcc` (GCC 11+) | RISC-V 内核交叉编译 | Ubuntu apt |
| `loongarch64-linux-gnu-gcc` (GCC 8/13) | LoongArch 内核交叉编译 | 预装在 `/opt/` |
| GNU Make | 构建自动化 | 系统自带 |
| `qemu-system-riscv64` (≥8.2) | RISC-V 模拟运行 | 预装在 `/opt/qemu-bin-9.2.1/` |
| `qemu-system-loongarch64` (≥8.2) | LoongArch 模拟运行 | 预装在 `/opt/qemu-bin-9.2.1/` |
| `dd` | 创建空的 disk.img | 系统自带 |

该项目是纯 C + 汇编的裸机内核，使用 `-ffreestanding -nostdlib -nostartfiles` 编译，不依赖标准 C 库。两个架构共用 `kernel/src/` 中的架构无关代码，架构相关代码在 `kernel/arch/<arch>/` 中。

---

## 总体印象

- **总代码量**: 约 11261 行（C + 汇编，不含数据文件 `ltp_data.h` 和 `os日志.txt`）
- **架构**: 单体内核，双架构支持（RISC-V 64 + LoongArch 64），面向 OSKernel2025 比赛评估
- **子系统完整度**: 覆盖了内存管理（物理+虚拟）、进程管理、调度、陷阱/中断、系统调用（36 个）、VFS（ramfs+devfs）、ELF 加载、信号处理等核心子系统
- **代码组织**: 明确的架构无关层（`kernel/src/`）+ 架构相关层（`kernel/arch/<arch>/`）分离，头文件集中在 `kernel/include/`
- **构建方式**: 两层 Makefile 系统，顶层 `make all` 生成 `kernel-rv`（RISC-V）和 `kernel-la`（LoongArch）两个 ELF 文件，以及可选的 `disk.img`