luwu OS 内核是一个以 Rust 语言实现的、支持 RISC-V 64 与 LoongArch 64 双架构的教学/竞赛用操作系统内核，总代码量约一万七千行。

该项目的核心特点在于文件系统与架构抽象两个维度的深度实现。在文件系统层面，luwu 包含一个超过一万行的独立 ext4 实现（占总代码量 63%），覆盖 extent tree 管理、HTree 目录索引、JBD2 日志引擎、块/Inode 分配器以及 CRC32c 校验和等高级特性，远超一般教学内核的水平，且该实现仅依赖 `BlockDevice` trait，可直接复用于其他 Rust OS 项目。在架构抽象层面，项目通过 9 个 Rust trait 构成 `KernelArch` 超级 trait 体系，利用泛型零成本抽象将约四千七百行内核核心代码在两个 ISA 间完全共享，无需任何条件编译分支。RISC-V 采用 Sv39 页表配合 1GiB 大页映射，LoongArch 则实现了含软件 TLB refill 的三级 4KiB 页表与 DMW 直接映射窗口。

luwu 还实现了协作式异步运行时、基于 buddy 思想的物理页帧分配器、支持 fork/clone/execve 的进程管理、约 75 个系统调用以及同时支持 MMIO 与 PCI 双 transport 的 VirtIO 块设备驱动。上述特性使其能够运行 busybox 和 glibc/musl 用户态程序。