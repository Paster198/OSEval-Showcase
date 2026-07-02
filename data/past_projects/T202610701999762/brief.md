NameNotFound 是一个采用编译期静态依赖注入架构的 Rust 操作系统内核项目。它通过 `module.toml` + 代码生成器 `archgen` + 全局 `services.toml` 契约，将 47 个功能模块以 99 个 Service 接口和 8 个 Effect 副作用约束进行组件化绑定，实现了模块间零直接耦合。

该内核的技术定位是一个能运行 Linux 兼容用户空间程序的实验性内核，其核心特点在于三层架构分解（L0 内核机制、L1 OS 对象语义、L2 系统调用 ABI），以及 RISC-V 64（Sv39）与 LoongArch 64 双 ISA 后端的完整支持，包括汇编级异常入口、软件 TLB 重填和上下文切换。

项目亮点包括：编译期自动解析依赖图并生成初始化顺序，利用 Effect deny 机制在编译阶段防止循环依赖与层级违反；集成了完整 ext4 文件系统（extent 格式）、ELF 动态链接加载器、信号处理、futex 和 epoll 等同步原语；提供 70 余个 Linux 系统调用，具备运行 BusyBox shell 和 libc-test 测试套件的能力。整体架构在模块化程度与可移植性上展现了独特的设计创新。