MeteorOS-X 是一个基于 ArceOS 框架构建的 RISC-V/LoongArch 宏内核操作系统，主体采用 Rust 语言开发，代码规模约五万余行。项目定位为一个兼容 Linux ABI 的多进程内核，能够运行独立的 C 和 Rust 用户程序，涵盖 shell、文件工具、网络服务、信号测试等三十余个应用。

核心特点在于其分层模块化架构：硬件抽象层支持 RISC-V 的完整 S-mode/U-mode 特权切换、Sv39 页表、PLIC 中断与 SMP 多核，LoongArch 适配部分实现；内存管理提供基于伙伴系统的物理页分配、ELF 加载、缺页处理等能力；进程管理实现 fork/exec、FIFO 与时间片调度、信号处理及 futex 同步；文件系统设计出独立的 VFS 层，包含 dentry 缓存、挂载命名空间与路径遍历器，同时支持 ext4、FAT32、ramfs 和 devfs；网络栈基于 smoltcp 提供 TCP/UDP 及 DNS 解析；系统调用层实现 90 余个系统调用，兼容 RISC-V Linux ABI。

项目的亮点在于将原本为 unikernel 设计的 ArceOS 框架成功改造为多进程宏内核，通过双调度器融合内核协程与用户进程调度，利用 trait 接口实现模块间编译期解耦，并将 TrapFrame 置于内核栈顶以简化管理。同时，双语言用户库 axstd 与 axlibc 兼顾了 Rust 安全性和 C 兼容性，展现了较强的工程整合能力。