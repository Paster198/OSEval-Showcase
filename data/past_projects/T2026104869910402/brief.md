StellaOS 是一个面向 RISC-V64 和 LoongArch64 双架构的宏内核操作系统项目，基于 rCore-Tutorial 演化而来，通过引入 polyhal 硬件抽象层获得了跨架构能力，并在系统调用兼容性、文件系统实现和进程管理深度上做了显著工程增强。

该项目核心特点包括：实现了约 168 个 Linux 兼容系统调用，覆盖文件 I/O、进程管理、信号、网络、IPC 和同步等主要类别；采用统一的 VFS 框架支持 ext4（含读写）、VFAT、tmpfs、devfs、procfs 等六种文件系统，并配备基于 LRU 的统一页缓存和 dentry 缓存；实现了完整的 COW fork、mmap/munmap/mprotect/mremap、共享内存以及两阶段缺页处理，有效解决了锁内文件 I/O 的重入问题；实现了 64 信号支持、可嵌套信号处理、实时信号队列和 sigaltstack 等完整的 POSIX 信号子系统；通过 futex、eventfd、阻塞互斥锁、条件变量和计数信号量提供了丰富的同步机制，并在条件变量的 wait_with_mutex 中通过关中断原子窗口消除了经典信号丢失问题。

技术亮点包括：利用用户态 lose-net-stack 协议栈提供 TCP/UDP 网络功能；通过高精度定时器堆和 per-task CPU 时间统计支持多种时钟源；设计上通过 ksync 的 trait 抽象将同步原语与内核解耦，展现了良好的模块化思想。项目通过 12 个测试套件的自动化验证，在功能完备性和稳定性上达到了较高的竞赛项目水准。