```json
[
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同属无基座 Rust 异步宏内核，均采用无栈协程调度、跨 RISC-V/LoongArch 双架构、深度集成多种文件系统与网络栈，与 TxKernel 的 Step 引擎和异步模型形成直接技术路线对比。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为无基座 Rust 异步宏内核，支持双架构、覆盖约二百系统调用，且引入负载追踪与多核负载均衡，可与 TxKernel 在异步调度策略、系统调用完整度和多核可伸缩性上进行深入比较。"
  },
  {
    "id": 58,
    "name": "NexusOS",
    "select_reason": "基于 Asterinas 框架的 Rust 异步宏内核，采用类型系统驱动的能力模型与全异步运行时，与 TxKernel 自研 EBR/Zone/Cap 的安全架构形成不同的安全设计哲学对照。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为无基座 Rust 宏内核，支持 RISC-V/LoongArch 双架构、兼容百余系统调用及 POSIX 信号，但采用传统同步调度，可对比异步与同步内核在复杂度与性能上的取舍。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "基于 ArceOS 组件化框架的 Rust 宏内核，支持三架构、百余系统调用和多种调度算法，与 TxKernel 自研单体式设计形成鲜明的架构风格对比，可从可复用性与模块化角度评估。"
  }
]
```