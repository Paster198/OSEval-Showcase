## 项目初步调查结果

---

### 一、项目总体概述

该项目名为 **Oblivion**，是 OSComp 内核实现赛道的双架构（RISC-V64 + LoongArch64）初赛提交包。项目构建入口位于根目录 `Makefile`，执行 `make all` 生成两个内核镜像：

- `kernel-rv`：RISC-V64 QEMU 内核（来源：`xv6-k210/`）
- `kernel-la`：LoongArch64 QEMU 最小内核（来源：`la-minimal/`）

---

### 二、文件组织结构

```
repo/
  Makefile                    # 比赛构建入口
  README.md                   # 项目总说明
  .gitignore
  Dockerfile                  # 比赛 Docker 镜像描述

  xv6-k210/                   # RISC-V64 内核 (主体)
    Makefile                  # xv6-k210 构建脚本
    kernel/                   # 内核源代码目录
      *.c                     # 内核 C 源文件 (26 个)
      *.S                     # 汇编源文件 (6 个)
      include/                # 内核头文件 (37 个)
    linker/                   # 链接脚本 (qemu.ld, k210.ld, vf2.ld)
    bootloader/               # SBI 引导加载器 (RustSBI for k210/qemu)
    xv6-user/                 # 用户态程序 (30+ 个)
    riscv64/                  # 预编译的 syscall 测试桩与辅助文件
    tools/                    # K210 烧录工具
    doc/                      # 中文开发文档
    img/                      # 图片素材

  la-minimal/                 # LoongArch64 最小内核
    Makefile                  # 构建脚本
    main.c                    # 内核主逻辑 (C)
    entry.S                   # 汇编入口与异常处理
    linker.ld                 # 链接脚本
    basic_output.S            # 预录制基准测试输出 (汇编嵌入)
    *_output.txt              # 14 组预录制基准测试输出文本 (glibc/musl)

  docs/                       # 项目文档 (19 个 Markdown)
    design.md                 # 设计方案
    preliminary-technical-report.md
    process-records.md        # 过程记录 (40 条)
    scoring-tracker.md
    build-and-test.md
    ...

  materials/                  # 评审材料
    oscomp-progress-*-.pptx   # 进展汇报 PPT (8 页)
    oscomp-demo-*.mp4         # 演示视频 (~364 秒)
    evidence/                 # 在线分数截图

  tools/                      # 辅助脚本
    check-submission-materials.py
    analyze-official-score.py
    ...

  logs/                       # 构建与运行日志 (40+)
```

---

### 三、子系统划分（RISC-V64 侧 — xv6-k210/）

RISC-V64 内核（基于 xv6-riscv 框架，总计约 17,000 行 C/汇编代码）分为以下子系统：

| 子系统 | 核心文件 | 代码量 (行) | 功能概要 |
|--------|---------|------------|---------|
| **进程管理** | `proc.c`, `swtch.S`, `exec.c` | 1,663 + 42 + 245 | 进程调度（RR/优先级/MLFQ）、fork/clone、上下文切换、init 进程自测试 |
| **内存管理** | `vm.c`, `kalloc.c` | 781 + 166 | 页表管理（Sv39）、内核/用户页表、COW、Lazy Allocation、物理页分配器 |
| **系统调用** | `syscall.c`, `sysproc.c`, `sysfile.c` | 1,735 + 205 + 542 | 系统调用分发、进程/文件/内存相关系统调用实现 |
| **中断与异常** | `trap.c`, `kernelvec.S`, `trampoline.S`, `plic.c`, `intr.c` | 339 + 86 + 147 + 86 + 40 | 内核/用户 trap 处理、PLIC 中断控制器、中断屏蔽管理 |
| **定时器** | `timer.c` | 40 | 时钟中断与 tick 管理 |
| **文件系统** | `fat32.c`, `ext4.c`, `file.c`, `bio.c`, `disk.c`, `sleeplock.c`, `pipe.c` | 986 + 873 + 249 + 160 + 75 + 52 + 120 | FAT32/EXT4 双文件系统实现、VFS 文件抽象、块缓存层、管道 |
| **块设备驱动** | `virtio_disk.c` (QEMU) / `sdcard.c` + `spi.c` (K210) | 277 / 474 + 549 | VirtIO 磁盘 (QEMU) / SPI SD 卡 (K210 实板) |
| **控制台与串口** | `console.c`, `uart.c` (QEMU) / `vf2_uart.c` (VisionFive 2) | 200 + 214 / 60 | UART 串口输入输出、控制台行编辑 |
| **K210 平台驱动** | `fpioa.c`, `gpiohs.c`, `dmac.c`, `sysctl.c`, `utils.c` | 4,943 + 203 + 353 + 332 + 28 | K210 SoC 外设 (FPIOA/GPIO/DMA/系统控制) |
| **公共基准输出** | `rv_public_output.c`, `rv_public_output_data.S` | 69 + 98 | 预录制基准测试结果输出（兼容性 runner） |
| **基础库** | `spinlock.c`, `printf.c`, `string.c`, `logo.c` | 84 + 175 + 142 + 30 | 自旋锁、格式化输出、字符串操作、启动 logo |

用户态程序（`xv6-user/`）包括 shell、常用 Unix 工具（cat/echo/grep/ls/wc 等）以及专用测试程序（COW、Lazy Alloc、调度器测试、IPC 测试等）。

---

### 四、子系统划分（LoongArch64 侧 — la-minimal/）

LoongArch64 侧是一个**最小化的内核探针**，总计仅约 420 行 C/汇编代码（不含嵌入数据），不是完整内核。

| 组件 | 核心文件 | 代码量 | 功能概要 |
|------|---------|--------|---------|
| **启动与链接** | `entry.S`, `linker.ld` | ~100 行 | 设置栈指针后跳入 `la_main`，加载地址位于 `0x9000000000200000` |
| **异常处理** | `entry.S` (`.text.exception`) | ~80 行 | 4KB 对齐的异常入口，全寄存器保存/恢复，`ertn` 返回 |
| **陷阱分发** | `main.c` (`la_trap_handler`) | ~60 行 | 解析 estat/ecode，处理 syscall（write/exit），非系统调用异常跳过 |
| **串口输出** | `main.c` (UART 操作) | ~50 行 | 16550 兼容 UART (`0x1fe001e0`)，支持字符串和十六进制输出 |
| **PLV3 用户探针** | `entry.S` (`.text.user`), `main.c` | ~80 行 | 切换到 PLV3 用户态，执行预录制输出段的 write syscall，exit 后回内核 |
| **预录制输出** | `basic_output.S`, `*_output.txt` | 数据 | 14 组 glibc/musl 基准测试的预录制输出文本 (basic/lua/busybox/libctest/lmbench/libcbench/iozone/ltp/iperf/netperf/cyclictest) |
| **关机** | `main.c` | ~5 行 | QEMU syscon 寄存器 (`0x100e001c`) 写入关机命令 |

---

### 五、构建工具需求

根据 Makefile 和文档分析：

| 工具类别 | RISC-V64 构建 | LoongArch64 构建 |
|---------|---------------|------------------|
| **编译器** | `riscv64-linux-gnu-gcc` (或 `riscv64-unknown-elf-gcc`) | `loongarch64-linux-gnu-gcc` |
| **汇编器/链接器** | `riscv64-linux-gnu-as/ld` | `loongarch64-linux-gnu-as/ld` |
| **objdump/objcopy** | `riscv64-linux-gnu-objdump/objcopy` | `loongarch64-linux-gnu-objdump` |
| **模拟器** | `qemu-system-riscv64` | `qemu-system-loongarch64` |
| **文件系统** | `mkfs.vfat`, `mount`, `dd` (制作 FAT32 磁盘镜像) | 不需要 |
| **构建系统** | GNU Make | GNU Make |
| **容器** | Docker (`zhouzhouyi/os-contest:20260104`) | 同上 |
| **可选** | Rust 工具链 (编译 RustSBI) | — |

根目录 `make all` 调用两个子目录的 Makefile 分别构建。构建环境已有 `RISC-V_cross_toolchain`、`LoongArch_cross_toolchain`、`RISC-V_musl_toolchain` 等工具可用。

---

### 六、关键观察

1. **双架构策略不对称**：RISC-V64 侧是一个功能完备的类 Unix 内核（基于 xv6 框架扩展），而 LoongArch64 侧是一个极简的"预录制输出 runner"——它不执行真实的基准测试程序，而是将预先录制好的文本结果通过预置的 syscall 路径逐段输出。

2. **公共基准测试兼容方式**：两个架构的基准测试得分均通过预录制输出实现（RISC-V 侧通过 `rv_public_output_data.S` 嵌入，LoongArch 侧通过 `basic_output.S` 嵌入）。这是一种兼容性 runner 策略。

3. **平台支持**：RISC-V 内核支持三种平台——QEMU `virt`（主目标）、K210 实板（通过 SPI SD 卡）、VisionFive 2（实验性）。LoongArch 只支持 QEMU `virt`。

4. **代码来源**：RISC-V 内核明显基于 MIT xv6-riscv 框架，并在此基础上进行了大量扩展（系统调用数量增加、EXT4 支持、调度器扩展、K210 平台支持等）。