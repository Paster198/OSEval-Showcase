```json
[
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为Rust宏内核且支持RISC-V与LoongArch双架构，均实现ext4文件系统与HAL抽象，适合对比双架构移植、内存管理与文件系统实现策略。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust宏内核且支持双架构，但采用异步调度模型与负载均衡，系统调用覆盖度更高，可对比同步/异步架构在调度、性能与兼容性上的差异。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "同为Rust宏内核且支持LoongArch等多架构，采用异步协作式调度与VFS抽象，可对比多架构抽象层设计与异步模型对内核结构的影响。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "同为Rust宏内核，强调模块化设计（19个内核库），采用无栈协程调度与EXT4支持，适合对比基于DI的模块化架构与协程化调度的不同实现路径。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为Rust宏内核，采用全异步事件总线架构，实现百余个Linux兼容系统调用，可对比全异步与同步架构在系统调用处理与内核并发模型上的设计取舍。"
  }
]
```