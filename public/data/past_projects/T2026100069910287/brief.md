OwnSome 是一个基于 Rust 异步协程实现的单地址空间宏内核操作系统，兼容 POSIX 接口，支持 RISC-V 64 和 LoongArch 64 双架构。项目规模约 6.3 万行 Rust，划分为 24 个库 crate，实现了 206 个系统调用，覆盖进程管理、虚拟内存、文件系统、网络、信号和定时器等核心领域。

其核心技术特色是全异步系统调用架构，大量系统调用以 async fn 的形式实现，配合基于 async-task 的协作式调度器与工作窃取机制，使任务能够在阻塞等待时高效让出 CPU。虚拟内存子系统支持按需分配、写时拷贝、文件映射以及 mmap、mremap 和 mprotect 等操作。虚拟文件系统框架完备，集成 ext4 与 FAT32 磁盘文件系统，并提供 procfs、sysfs、devfs、tmpfs 等伪文件系统以及 epoll、inotify、eventfd、timerfd、signalfd 等特殊文件。网络栈基于自维护的 smoltcp 实现了 TCP、UDP 和 Unix 域套接字。

项目亮点包括利用 Rust 类型系统实现的用户态内存安全访问设计、基于枚举和函数指针的模块化虚拟内存区域缺页处理，以及通过硬件抽象层实现的双架构条件编译体系。整体工作展现了异步 Rust 在操作系统内核领域的创新应用。