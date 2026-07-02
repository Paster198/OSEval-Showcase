## 项目结构分析报告

### 一、项目概览

**Sustcore** 是一个面向 RISC-V 与 LoongArch64 的 Capability-based 混合内核，使用 C++（GNU++23 标准）和少量 C/汇编实现。总计约 **513 个源码文件**（182个`.cpp`、21个`.c`、268个`.h`、42个`.S`），代码总量约 **11.6 万行**。项目从零构建，除 libfdt 及少量第三方头文件外未使用第三方库。

---

### 二、顶层目录结构

| 目录/文件 | 用途 |
|---|---|
| `kernel/` | 内核主体代码 |
| `include/` | 内核及用户态公共头文件 |
| `libs/` | 用户态库（供模块使用） |
| `module/` | 用户态模块与测试程序 |
| `third_party/` | 第三方库和头文件（libfdt、elf.h、errno.h等） |
| `script/` | 构建脚本（Makefile 片段） |
| `tools/` | 辅助工具（配置生成、日志生成、注释统计等） |
| `initrd/` | 初始 ramdisk 相关内容 |
| `docs/` | 设计文档（按子系统分类） |
| `articles/` | 相关文章 |
| `compdoc/` | 组件文档 |
| `config-ref/` | 配置参考文档 |
| `Makefile` | 顶层 Makefile |
| `flags.mk` | 公共编译标志 |
| `Doxygen` | Doxygen 文档配置 |

---

### 三、子系统划分

#### 1. 架构层（Architecture）— `kernel/arch/`

支持两个架构，各含独立子目录：

- **RISC-V64** (`kernel/arch/riscv64/`)
  - `int/` — 异常与中断处理（`exception.cpp`, `trap.S`）
  - `mem/` — Sv39 页表实现（`sv39.cpp`, `sv39.h`）
  - `device/` — RISC-V 平台设备：CLINT、PLIC、CPU、FDT 解析等
  - `ctx.h`, `ctxlayout.h` — 上下文切换与布局
  - `csr.h` — CSR 寄存器定义
  - `entry.S`, `hart.S` — 入口与 HART 相关汇编
  - `setup.cpp`, `ext_context.cpp` — 架构初始化

- **LoongArch64** (`kernel/arch/loongarch64/`)
  - `int/` — 异常与中断处理（`exception.cpp`, `trap.S`）
  - `mem/` — LA64 页表管理（`pageman.cpp`, `pageman.h`, `refill.S`）
  - `device/` — LoongArch 平台设备：CPU、时钟、中断控制器（EIOINTC、PLATIC）、FDT 解析
  - `ctx.h`, `ctxlayout.h` — 上下文切换与布局
  - `csr.h`, `csrnum.h` — CSR 寄存器定义
  - `entry.S`, `hart.S` — 入口与 HART 相关汇编
  - `setup.cpp`, `ext_context.cpp` — 架构初始化

#### 2. 启动层（Boot）— `kernel/boot/`

- **SBI 启动** (`kernel/boot/sbi/`)：RISC-V 的 SBI 模式启动，含 `boot.S`、`sbi_boot.cpp`、`sbi_post_boot.cpp`、链接脚本 `sbi.ld`
- **LA 启动** (`kernel/boot/laboot/`)：LoongArch64 的启动，含 `boot.S`、`la_boot.cpp`、`la_post_boot.cpp`、链接脚本 `laboot.ld`

#### 3. 内存管理（Memory Management）— `kernel/mem/`

- Buddy 分配器（`buddy.cpp`, `buddy.h`）
- SLUB 分配器（`slub.cpp`, `slub.h`）
- VMA（虚拟内存区域）管理（`vma.cpp`, `vma.h`）
- GFP（Get Free Page）页面分配（`gfp.cpp`, `gfp.h`）
- 内核地址空间管理（`kaddr.cpp`, `kaddr.h`）
- 通用分配器接口（`alloc.cpp`, `alloc.h`）

#### 4. 虚拟文件系统（VFS）— `kernel/vfs/`

- VFS 核心（`vfs.cpp`, `vfs.h` 约 11 万 bytes）
- **ext4** 文件系统实现（`ext4.cpp`, `ext4.h`）
- **tmpfs** 内存文件系统（`tmpfs.cpp`, `tmpfs.h`）
- **procfs** 进程文件系统（`procfs.cpp`, `procfs.h`）
- **tarfs** tar 归档文件系统（`tarfs.cpp`, `tarfs.h`）
- 设备文件系统接口（`device.cpp`, `device.h`）
- 文件操作接口定义（`ops.h`）

#### 5. 任务管理（Task Management）— `kernel/task/`

- 任务结构与生命周期（`task.cpp`, `task.h`, `task_struct.h`）
- 任务创建（`task_create.cpp`）
- 调度器（`scheduler.cpp`, `scheduler.h`）
- 启动引导（`bootstrap.cpp`）
- 信号机制（`signal.cpp`）
- 等待/同步机制（`wait.cpp`, `wait.h`）

#### 6. 调度器（Scheduler）— `kernel/schd/`

- 调度器基类（`schdbase.h`）
- FCFS 调度器（`fcfs.h`）
- 轮转调度器 RR（`rr.h`）
- 实时调度器 RT（`rt.h`）
- 空闲调度器（`idle.h`）
- 初始化调度器（`init.h`）

#### 7. 系统调用（Syscall）— `kernel/syscall/` 与 `kernel/cap/`

- `kernel/syscall/`：系统调用分发与实现
  - Capability 相关：`cap.cpp`, `endpoint.cpp`, `memory.cpp`, `notif.cpp`, `pipe.cpp`, `shutdown.cpp`, `task.cpp`, `vfs.cpp`, `syscall.cpp`
  - 用户态访问辅助（`uaccess.h`）
- `kernel/cap/`：Capability 机制核心
  - `capability.cpp`, `capability.h` — Capability 类型定义
  - `cholder.cpp`, `cholder.h` — Capability 持有者
  - `permission.h` — 权限定义

#### 8. 内核对象（Object）— `kernel/object/`

Capability 系统所管理的对象类型实现：
- Endpoint（`endpoint.cpp`, `endpoint.h`）
- Memory（`memory.cpp`, `memory.h`）
- Notification（`notif.cpp`, `notif.h`）
- Pipe（`pipe.cpp`, `pipe.h`）
- Task（`task.cpp`, `task.h`）
- Mutex（`mutex.cpp`, `mutex.h`）
- 虚拟目录/文件/挂载点（`vdir.cpp`, `vfile.cpp`, `vmount.cpp`）
- 中断对象（`intobj.cpp`, `intobj.h`）
- 权限管理（`perm.h`）

#### 9. 设备管理（Device）— `kernel/device/`

- CPU 抽象（`cpu.cpp`, `cpu.h`）
- PCI 总线（`pci.cpp`, `pci.h`）
- 中断控制器图（`ic_graph.cpp`, `ic_graph.h`）
- 设备模型（`model.cpp`, `model.h`）
- 资源管理（`resource.cpp`, `resource.h`）
- FDT 设备树解析（`kernel/device/fdt/`）

#### 10. 驱动层（Driver）— `kernel/driver/`

- 驱动框架：`base.cpp`/`base.h`、`factory.cpp`/`factory.h`、`model.cpp`/`model.h`
- **VirtIO** 驱动：`virtio.cpp`/`virtio.h`、`virtio-blk.cpp`/`virtio-blk.h`
- **PCI Host** 驱动（`pci_host.cpp`, `pci_host.h`）
- 时钟驱动（`clock.cpp`, `clock.h`）
- 串口驱动（`serial.cpp`, `serial.h`）
- 系统控制电源管理（`syscon-poweroff.cpp`）
- 中断控制器头文件（`int/`）：PLIC、CLINT、RISC-V INTC
- RTC 驱动（`rtc/`）：Goldfish RTC、LS7A RTC

#### 11. 块 IO 层（Block IO）— `kernel/bio/`

- 块设备抽象（`blk.cpp`, `blk.h`）
- 块设备请求管理（`block.cpp`, `block.h`, `request.cpp`, `request.h`）
- 缓冲区/页缓存（`buffer.cpp`, `buffer.h`）

#### 12. ELF 加载器（Executable Loader）— `kernel/exe/`

- ELF 加载器实现（`elfloader.cpp`, `elfloader.h`）
- 任务执行相关（`task.h`）

#### 13. 配置系统（Config）— `kernel/config/`

- 配置检测器（`detector.h`）

#### 14. 内核测试框架（Test）— `kernel/test/`

内核内部测试，覆盖数据结构与基础组件：
- array, buddy, capability, coroutine, expected, functional, meta, optional, path, printf, raii, ranges, ringbuf, slub, source_location, string, string_view, tree, unordered_map, unordered_set, vector, wait 等

#### 15. 用户态库（Libraries）— `libs/`

- **basecpp**：基础 C++ 运行时支持（IO、字符串、路径、类型转换等）
- **sbi**：SBI 调用封装（`sbi.c`, `sbi_base.c`, `sbi_dbcn.c`, `sbi_legacy.c` 等）
- **kmod**：内核模块支持库（文件操作、内存分配、系统调用封装、运行时初始化）
- **linuxss-libc**：Linux 子系统 libc 兼容层（malloc、stdio、内存管理、系统调用头文件等）
- **rpc**：RPC 通信库（`packet.cpp`, `session.cpp`）

#### 16. 用户态模块/测试（Modules）— `module/`

约 30 个模块，包括：
- 系统模块：`init`, `default`, `contest-runner`, `linux-subsystem`
- 功能测试：`test_fork`, `test_execve`, `test_thread`, `test_signal`, `test_meminfo`, `test_procfs`
- 文件系统测试：`test_ext4_read`, `test_ext4_create`, `test_ext4_rw`, `test_ext4_symlink`, `test_ext4_permission`
- 文件操作测试：`test_file_rw_a`, `test_file_rw_b`, `test_file_backed_memory`
- 页缓存测试：`test_page_cache`, `test_page_cache_perf`
- ELF 按需加载测试：`test-elf-demand`, `test-elf-demand-perf`, `test-elf-demand-perf-child`
- RPC 测试：`test_rpc_server`, `test_rpc_client`
- Capability 测试：`test_endpoint_master`, `test_endpoint_slave`, `test_call_service`, `test_call_user`
- 评测相关：`test_fs_score`, `test-linux`

#### 17. 头文件组织（Include）— `include/`

- `include/std/`：C 标准库头文件（assert, ctype, math, stdio, stdlib, string 等）+ C++ 头文件
- `include/sus/`：内核工具类（list, map, tree, ringbuf, logger, coroutine, raii, owner, nonnull, refcount, units, reflection 等）
- `include/sustcore/`：内核公共接口（addr, attr, boot, bootstrap, capability, errcode, execve, files, msg, syscall, syscall_str, sysret 等）
- `include/kmod/`：内核模块系统调用接口
- `include/rpc/`：RPC 通信接口（buffer, metahelper, packet, session, typeparse）
- `include/sbi/`：SBI 接口（sbi.h, sbi_enum.h）
- `third_party/include/`：elf.h, errno.h, multiboot2.h, libfdt, C 标准补充头文件

---

### 四、构建工具需求

根据 `flags.mk`、`script/build/compilers.mk`、`script/build/arch/*.mk` 及 `Makefile` 分析：

| 工具 | 用途 | 说明 |
|---|---|---|
| **RISC-V 交叉编译器** | 编译 RISC-V64 目标 | 前缀 `riscv64-unknown-elf-`，GCC 15+ |
| **LoongArch64 交叉编译器** | 编译 LoongArch64 目标 | 前缀 `loongarch64-unknown-elf-`，GCC 15+ |
| **GNU Make** | 构建系统 | 顶层 Makefile + script/build/*.mk |
| **Python 3** | 配置解析、代码生成 | 读取 config.json，工具脚本 |
| **GNU Binutils** | objcopy, ld, ar | 随交叉编译器提供 |
| **bear**（可选） | 生成 compile_commands.json | 用于 IDE 支持 |
| **QEMU** | 模拟运行 | riscv64 和 loongarch64 |
| **mkfs.ext4, mkfs.vfat, dd** 等（可选） | 磁盘镜像制作 | 非核心编译必须 |

构建系统支持 `debug` 和 `release` 两种模式，C 标准为 `gnu18`，C++ 标准为 `gnu++23`，使用 `-nostdlib -ffreestanding` 的裸机编译模式。禁用 RTTI 和异常（`-fno-rtti -fno-exceptions`）。