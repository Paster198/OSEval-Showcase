```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust宏内核且无生态，均支持riscv64与loongarch64双架构，系统调用覆盖度均在百级以上，直接可比双架构抽象设计与功能完备性。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为全异步Rust宏内核（无生态），均实现百余个系统调用，对比异步调度模型、事件总线与I/O架构可揭示不同异步设计取舍。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "采用无栈协程调度，与Chronix的有栈协程形成技术路线对比，可分析不同协程模型对内核并发、内存占用与实时性的影响。"
  },
  {
    "id": 73,
    "name": "Del0n1x",
    "select_reason": "同为无生态Rust内核，支持双架构且使用无栈协程，并实现了分级OOM回收与页缓存脏块追踪，与Chronix可对比内存管理与高级调度机制。"
  },
  {
    "id": 12,
    "name": "Being[3]++",
    "select_reason": "均基于async-task实现有栈协程调度，同为无生态Rust宏内核，可比较异步优先调度、内存管理（COW/懒分配）及文件系统设计的成熟度差异。"
  }
]
```