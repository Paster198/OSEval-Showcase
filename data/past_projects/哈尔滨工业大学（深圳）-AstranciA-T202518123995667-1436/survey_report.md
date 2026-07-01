## AstrancE OS 项目初步调查报告

### 一、项目结构

该项目是一个基于 ArceOS 框架开发的宏内核操作系统，采用 Rust 语言编写。仓库包含两个主要部分：

**1. AstrancE/ - 内核主体（480个Rust源文件，约76,572行代码）**
```
AstrancE/
├── api/              # API接口层
├── configs/          # 平台配置文件
├── crates/           # 工具库和扩展组件
├── modules/          # 核心内核模块
├── src/              # 内核入口
├── ulib/             # 用户态库
├── examples/         # 示例程序
├── scripts/          # 构建脚本
└── tools/            # 辅助工具
```

**2. App_oscomp/ - 应用测试框架（3个Rust源文件）**
```
App_oscomp/
├── src/              # 测试入口程序
├── configs/          # 架构配置
├── rootfs/           # 根文件系统（riscv64/loongarch64）
├── scripts/          # 构建脚本
└── bin/              # 工具二进制
```

### 二、已实现的子系统

根据代码结构分析，该项目实现了以下核心子系统：

**1. 内存管理子系统**
- `modules/axalloc` - 内存分配器
- `modules/axmm` - 虚拟内存管理（支持mmap、COW、共享内存）
- `crates/axmm_crates/` - 内存管理工具库（memory_addr、memory_set）
- `crates/page_table_multiarch` - 多架构页表支持

**2. 文件系统子系统**
- `modules/axfs` - 文件系统主模块
- `crates/axfs_crates/axfs_vfs` - 虚拟文件系统层
- `crates/axfs_crates/axfs_devfs` - 设备文件系统
- `crates/axfs_crates/axfs_procfs` - 进程文件系统
- `crates/axfs_crates/axfs_ramfs` - 内存文件系统
- `crates/lwext4_rust` - ext4文件系统支持

**3. 进程与任务管理子系统**
- `modules/axtask` - 任务调度与线程管理
- `crates/axprocess` - 进程管理
- `ulib/axmono/src/task/` - 用户态任务管理

**4. 系统调用子系统**
- `ulib/axsyscall` - 系统调用接口（50+ POSIX调用）
- `ulib/axmono/src/syscall/` - 系统调用实现（io、ipc、mm、process、signal、time等）

**5. 信号处理子系统**
- `modules/axsignal` - 信号机制核心
- `ulib/axmono/src/task/signal.rs` - 信号处理逻辑

**6. 硬件抽象层（HAL）**
- `modules/axhal` - 硬件抽象层主模块
  - `arch/` - 架构相关代码（aarch64、loongarch64、riscv、x86_64）
  - `platform/` - 平台适配（QEMU virt、VisionFive2、2K1000等）

**7. 设备驱动子系统**
- `modules/axdriver` - 驱动框架
- `crates/axdriver_crates/` - 驱动组件（base、block、net、pci、virtio）
- `crates/virtio-drivers` - VirtIO设备驱动

**8. 网络子系统**
- `modules/axnet` - 网络协议栈（基于smoltcp）

**9. 同步与IPC子系统**
- `modules/axsync` - 同步机制（锁、信号量）
- `modules/axns` - 命名空间与资源隔离

**10. 用户态支持库**
- `ulib/axlibc` - C标准库封装
- `ulib/axstd` - Rust标准库封装
- `ulib/axmono` - 宏内核用户态支持（ELF加载、进程管理、内存映射）

### 三、目录与子系统对应关系

| 目录 | 所属子系统 | 功能说明 |
|------|-----------|----------|
| `modules/axalloc` | 内存管理 | 物理内存分配 |
| `modules/axmm` | 内存管理 | 虚拟内存、mmap、COW |
| `modules/axfs` | 文件系统 | 文件系统接口 |
| `modules/axtask` | 进程管理 | 任务调度、线程管理 |
| `modules/axsignal` | 信号处理 | POSIX信号机制 |
| `modules/axhal` | 硬件抽象 | 多架构、多平台适配 |
| `modules/axdriver` | 设备驱动 | 驱动框架 |
| `modules/axnet` | 网络 | TCP/IP协议栈 |
| `modules/axsync` | 同步机制 | 锁、信号量 |
| `modules/axns` | 命名空间 | 资源隔离 |
| `crates/axmm_crates` | 内存管理 | 页表、内存集合 |
| `crates/axfs_crates` | 文件系统 | VFS、devfs、procfs |
| `crates/axdriver_crates` | 设备驱动 | 块设备、网络设备 |
| `crates/page_table_multiarch` | 内存管理 | 多架构页表 |
| `ulib/axsyscall` | 系统调用 | 系统调用分发 |
| `ulib/axmono` | 用户态支持 | ELF加载、进程管理 |
| `ulib/axlibc` | 用户态库 | C库兼容层 |

### 四、构建工具需求

**必需工具：**
1. **Rust工具链**
   - Rust nightly-2025-01-18
   - cargo、rustc
   - rust-src、llvm-tools、rustfmt、clippy
   - 目标架构支持：riscv64gc-unknown-none-elf、loongarch64-unknown-none、aarch64-unknown-none、x86_64-unknown-none

2. **构建系统**
   - GNU Make
   - Bash shell

3. **模拟器**
   - QEMU（支持riscv64、loongarch64）

4. **交叉编译工具链**
   - RISC-V GCC工具链（用于用户态程序）
   - LoongArch GCC工具链（用于用户态程序）

5. **文件系统工具**
   - mkfs.ext4
   - dd、losetup

**可选工具：**
- cargo-binutils（用于二进制处理）
- Python（辅助脚本）
- Git（源码管理）

**构建流程：**
项目使用分层Makefile系统，根目录Makefile协调App_oscomp和AstrancE的构建。支持通过feature flags进行功能裁剪，可针对不同架构（RISC-V、LoongArch）和平台（QEMU、开发板）生成对应的内核镜像。