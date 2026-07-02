该 OS 内核是一个采用 Rust 语言实现的宏内核（Monolithic Kernel）项目，同时支持 RISC-V 64 和 LoongArch 64 两种硬件架构。其技术定位为面向竞赛与教学场景的 Linux ABI 兼容内核，通过单一二进制镜像运行用户态程序，在确保 Rust 安全性的前提下提供了接近 Linux 的系统调用兼容层。

项目的核心特点包括：完整的虚拟文件系统（VFS）抽象，支持 EXT4 读写的 extent 树操作、FAT32 只读以及 procfs、devfs 等伪文件系统；实现了基于 smoltcp 的 TCP/UDP/Unix Socket 及 AF_ALG 加密套接字协议栈；具备 COW fork、惰性分配、mmap、System V 共享内存等内存管理能力；信号子系统完整支持 SA_SIGINFO、SA_RESTART 等高级特性；并通过超过 120 个系统调用提供丰富的进程管理、文件操作与网络功能。

亮点在于 EXT4 的写入支持，包括 inode 分配、extent 分裂与 fallocate 操作，这在国内竞赛项目中较为少见；双架构统一抽象下的 TLB 重填处理与 PCI 枚举也体现了较强的架构适配能力；此外，642 个 LTP 测试用例的通过率（约 68.3%）反映出该项目在 Linux ABI 兼容性上的扎实投入，整体完成度在同类 Rust 宏内核中处于较前水平。