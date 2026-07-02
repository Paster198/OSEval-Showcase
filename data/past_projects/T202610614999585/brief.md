Starry OS 是一个基于 ArceOS 组件化运行基座构建的类 Unix 宏内核，采用 Rust 语言编写，代码总量约 46,200 行。项目以全国大学生系统能力竞赛为目标场景，在 ArceOS 的硬件抽象、任务调度和网络协议栈之上，通过 starry-api、starry-core 和 starry-config 三层 Crate 结构实现了丰富的 POSIX 兼容性。

内核支持 riscv64、loongarch64、aarch64 和 x86_64 四种架构，并针对 RISC-V 和 LoongArch 维护了独立的 LTP 测试集。其核心特点包括：通过 `scope_local!` 宏和 `TaskExt` trait 在不修改 ArceOS 核心调度器的前提下注入进程模型与文件描述符表等复杂状态；利用 COW 地址空间、多级 ELF 缓存和按需分页实现高效的 fork/exec 路径；基于 smoltcp 提供 IPv4/IPv6 双栈支持，并实现了 Unix Domain Socket 与 epoll 多路复用；信号子系统支持标准信号、实时信号、信号栈和 robust futex 等机制。

项目在系统调用覆盖率上达到约 75% 的 POSIX 核心功能，并通过大量边界条件处理和嵌入式 libgcc_s 等措施实现了对 LTP 测试集的深度适配。其实用主义工程风格与清晰的模块边界使其在竞赛场景中展现出较强的实用性。