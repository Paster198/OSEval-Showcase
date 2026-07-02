WHUSP 是一个面向操作系统内核比赛的宏内核项目，采用 Rust 语言开发，支持 RISC-V 64 和 LoongArch 64 双架构，致力于提供与 Linux 高度兼容的用户空间 ABI，能够运行标准 musl libc 编译的可执行程序和 LTP 测试套件。

该项目规模约 77,000 行内核代码，涵盖约 280 个系统调用号的实现，系统调用覆盖度在同类比赛项目中表现突出。其核心特点包括：实现了包含 EXT4、FAT、tmpfs、overlayfs、procfs、devfs、cgroupfs 和 staticfs 在内的 8 种文件系统，提供了统一的 VFS 抽象层并内置脏页缓存、小文件读缓存和预读机制；任务管理采用 CFS 调度器，支持多调度策略、完整的 futex（含优先级继承）、ptrace 调试接口和 seccomp 过滤；内存管理实现了 Sv39 三级页表、写时复制、按需分页、System V 共享内存和页面缓存等机制。

项目的技术亮点包括手工构建的 vDSO ELF 以提供免系统调用的时钟访问、利用重复模式优化零区域的稀疏 tmpfs 实现、块设备 I/O 的非阻塞与同步双路径设计、RISC-V 架构上 ASID 支持的运行时自动探测，以及通过 52 个性能剖析点和 `/proc/oskernel/perf` 接口实现的系统化性能分析框架。详尽的 procfs 实现几乎完整覆盖了 Linux 的 `/proc` 接口。