## RmikuOS 项目初步调查报告

### 一、项目概览

**RmikuOS** 是一个基于 Rust 语言编写的操作系统内核，目标架构为 **RISC-V 64 (riscv64gc)** 和 **LoongArch 64**。项目使用 Cargo 作为内核构建系统，并通过 Makefile + 自定义 Python 脚本编排整体构建流程。

---

### 二、仓库顶层结构

| 目录/文件 | 用途 |
|-----------|------|
| `kernel/` | 内核源代码主体 (Rust + 少量汇编) |
| `user/` | 用户态程序、用户库、根文件系统内容 |
| `third_party/` | 第三方库（仅 `fatfs`） |
| `vendor/` | Cargo vendor 依赖（bitflags, buddy_system_allocator, ext4-view, log, spin 等） |
| `scripts/` | 调度数据分析/绘图脚本（Python） |
| `docs/` | 文档图片 |
| `logs/` | 日志目录 |
| `cargo-config/` | Cargo 配置模板（链接脚本、交叉编译目标） |
| `Cargo.toml` | 内核 crate 清单 |
| `Makefile` | 顶层构建入口（编译 RISC-V 和 LoongArch 内核） |
| `build.rs` | Cargo 构建脚本（汇编引导代码编译、链接脚本指定） |
| `run.sh` | QEMU 启动脚本（支持两种架构） |

---

### 三、内核子系统划分

#### 1. 架构层 (`kernel/src/arch/`)
- **文件**：`boot.S`（引导入口）、`linker.ld`（链接脚本）、`mod.rs`（平台常量）
- **支持架构**：`riscv64/`、`loongarch64/`
- **职责**：引导启动、链接布局定义、架构相关常量（`MAX_HARTS`、`MEMORY_START/END` 等）

#### 2. 陷阱与中断 (`kernel/src/trap/`)
- **文件**：`mod.rs` + 架构子目录（`riscv64/`、`loongarch64/`）
- **内容**：`trap.S`（异常入口汇编）、`context.rs`（TrapContext）、`tlb_refill.S`（LA TLB 重填）
- **职责**：中断/异常/系统调用的入口分发

#### 3. 内存管理 (`kernel/src/mm/`)
- **文件**：`address.rs`、`frame_allocator.rs`、`heap.rs`、`page_table/`、`memory_set.rs`、`map_area.rs`、`elf.rs`、`user_layout.rs`、`config.rs`
- **支持架构**：`riscv64.rs`、`loongarch64.rs`
- **职责**：物理帧分配、内核堆管理、页表抽象（RISC-V Sv39 / LA）、虚拟地址空间（MemorySet）、ELF 加载、用户地址空间布局

#### 4. 任务管理 (`kernel/src/task/`)
- **文件**：`process.rs`、`thread.rs`、`manager.rs`、`manager_wrapper.rs`、`processor.rs`、`context.rs`、`switch.rs`、`switch_*.S`、`kernel_stack.rs`
- **职责**：进程控制块 (PCB)、线程控制块 (TCB)、调度器（支持 stride/ticket 调度及自适应 alpha）、上下文切换、内核栈管理、多核支持

#### 5. 系统调用 (`kernel/src/syscall/`)
- **文件**：`mod.rs`、`fs.rs`、`process.rs`、`thread.rs`
- **职责**：40 个系统调用的路由与实现，涵盖进程、线程、文件系统、调度控制、管道、内存映射等

#### 6. 文件系统 (`kernel/src/fs/`)
- **文件**：`file.rs`、`inode.rs`、`path.rs`、`common_file.rs`、`dirent.rs`、`flag.rs`、`stat.rs`、`mount.rs`、`pipe.rs`、`stdio.rs`
- **具体实现**：`ext4fs.rs`、`fatfs.rs`、`tmpfs.rs`、`initramfs.rs`
- **职责**：类 VFS 抽象层（Inode + File trait），实现 ext4、FAT、tmpfs 三种文件系统，支持管道、目录操作、路径解析、挂载

#### 7. 块设备 (`kernel/src/block/`)
- **文件**：`device.rs`、`blockio.rs`、`cache.rs`、`ramdisk.rs`、`discover_disks.rs`、`ext4_image.rs`
- **VirtIO 驱动**：`virtio_blk.rs`、`virtio_mmio.rs`、`virtio_pci.rs`、`virtio_pci_blk.rs`、`virtio_probe.rs`、`virtio_queue.rs`
- **职责**：块设备抽象、块缓存（BlockCache）、Ramdisk、VirtIO-MMIO 和 VirtIO-PCI 块设备驱动、磁盘自动发现

#### 8. PCI 总线 (`kernel/src/pci/`)
- **文件**：`mod.rs`、`ecam.rs`、`bar.rs`、`probe.rs`
- **职责**：PCI ECAM 配置空间访问、BAR 解析、设备枚举

#### 9. I/O 子系统 (`kernel/src/io/`)
- **文件**：`uart.rs`、`console.rs`、`logger.rs`
- **职责**：UART 串口驱动、控制台输出、日志系统

#### 10. 同步原语 (`kernel/src/sync/`)
- **文件**：`spin.rs`、`sync.rs`、`up.rs`
- **职责**：自旋锁（Mutex）、UP 环境下的无锁包装

#### 11. 定时器 (`kernel/src/timer/`)
- **文件**：`mod.rs` + `riscv64.rs` / `loongarch64.rs`
- **职责**：架构相关的时钟中断配置与 ticks 计数

#### 12. 内核自测 (`kernel/src/test/`)
- **文件**：`heap_test.rs`、`frame_alloc_test.rs`、`page_table_test.rs`、`memory_set_test.rs`、`user_test.rs`、`block_test.rs`、`block_cache_tset.rs`、`test_fat_mount.rs`、`test_pci_write_read.rs`、`test_second_disk_rw.rs`、`loader/` 等
- **职责**：内核各子系统的单元/集成测试，在内核启动流程中被调用

#### 13. 其他模块
- **`math.rs`**：数学工具函数
- **`panic.rs`**：panic 处理
- **`shutdown.rs`**：系统关机
- **`oscomp.rs`**：OS 比赛评测 stub（输出测试组标记后关机）

---

### 四、用户态程序

| 路径 | 说明 |
|------|------|
| `user/src/shell.c` | Shell 程序 |
| `user/src/cat.c`、`echo.c`、`grep.c`、`ls.c` | 标准命令行工具 |
| `user/include/*.h` | C 用户库头文件（系统调用包装、类型定义） |
| `user/lib/crt0_*.S` | C 运行时启动（入口 `_start`） |
| `user/lib/syscall_*.S` | 系统调用汇编包装 |
| `user/tests/` | 50+ 测试程序（C/汇编/Rust），覆盖 fork、线程、调度、管道、mmap、FS 等场景 |
| `user/rust/programs/` | Rust 用户程序（bank_system、editor、library_system 等 10 个） |
| `user/rootfs/` | 根文件系统内容（/etc、/home、/share、/tests） |
| `user/build.py` | 用户程序跨架构构建脚本 |
| `user/mkfs_ext4.sh` | ext4 根文件系统镜像制作 |

---

### 五、构建工具需求

根据 `Makefile`、`build.rs`、`run.sh` 和 `user/build.py` 分析，构建该项目需要：

| 工具 | 用途 |
|------|------|
| **cargo** (Rust 工具链) | 内核编译 |
| **rustup** 目标：`riscv64gc-unknown-none-elf`、`loongarch64-unknown-none` | 交叉编译目标 |
| **riscv64-unknown-elf-gcc** / **objcopy** / **objdump** | RISC-V 用户程序编译 |
| **loongarch64-unknown-linux-gnu-gcc** / **objcopy** / **objdump** | LoongArch 用户程序编译及内核链接 |
| **Python 3** | 用户程序构建脚本 (`user/build.py`) |
| **mkfs.ext4** | 根文件系统镜像制作 |
| **QEMU** (`qemu-system-riscv64` / `qemu-system-loongarch64`) | 模拟运行 |
| **GNU Make** | 顶层构建编排 |

---

### 六、子系统规模估算 (代码行数)

| 子系统 | 代码行数 (含 .rs / .S / .ld) |
|--------|------|
| task（任务管理） | ~3,400 |
| block（块设备） | ~2,850 |
| mm（内存管理） | ~2,510 |
| fs（文件系统） | ~2,290 |
| trap（陷阱中断） | ~1,500 |
| arch（架构引导） | ~1,200 |
| test（内核自测） | ~1,045 |
| syscall（系统调用） | ~545 |
| pci（PCI 总线） | ~419 |
| io（I/O） | ~232 |
| timer（定时器） | ~147 |
| sync（同步） | ~143 |
| **内核核心代码总计** | **~14,500** |

用户态约 11,800 行（C 测试 + Rust 用户程序 + 工具源码）。