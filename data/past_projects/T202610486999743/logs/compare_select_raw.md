```json
[
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust异步宏内核，支持riscv64+loongarch64双架构，系统调用数接近200，HAL设计相似，异步调度与负载均衡可直接对比。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为Rust无栈协程异步宏内核，支持双架构，集成VFS与多种文件系统，技术路线高度一致，可比较异步模型与文件系统深度。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust宏内核双架构，但采用传统调度，可对比调度策略、内存管理与系统调用实现思路的差异。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "同为Rust无栈协程宏内核，实现EXT4文件系统与页缓存，虽单架构，但技术路线相似，可比较架构扩展性与调度设计。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "基于ArceOS生态的Rust宏内核，支持多架构，组件化设计思想与当前自研生态形成鲜明对比，利于分析生态依赖性。"
  }
]
```