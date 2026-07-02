[
  {
    "id": 60,
    "name": "SubsToKernel",
    "select_reason": "当前项目的直接继承基座，同样基于 rCore 并支持 RISC-V 与 LoongArch 双架构，共享银行家算法等核心特性，可对比增量贡献与演化路径。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为 Rust 宏内核，支持 RISC-V 与 LoongArch 双架构、EXT4 及 FAT32 双文件系统，实现 COW 与信号机制，功能覆盖高度一致，适合全面横向对比。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "采用 Rust 无栈协程的异步宏内核，双架构支持，集成多种文件系统与网络协议栈，在调度与 I/O 模型上与当前同步内核形成鲜明对比。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "微内核架构，基于能力模型实现严格资源隔离与迁移式通信，与当前宏内核设计形成宏观架构层级的对照，可考察不同内核结构对功能实现的影响。"
  },
  {
    "id": 58,
    "name": "NexusOS",
    "select_reason": "基于 Asterinas 的全异步宏内核，以类型系统实现零成本能力模型和纯 Rust 静态分发 VFS，双架构支持，在安全性与并发模型上与当前 rCore 基座项目形成技术路线差异。"
  }
]