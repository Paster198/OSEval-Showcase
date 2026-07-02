```json
[
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为全异步宏内核且自研无生态依赖，均采用统一事件/等待模型桥接阻塞语义，对比异步运行时、调度器与事件总线设计异同极具价值。"
  },
  {
    "id": 19,
    "name": "asynclear",
    "select_reason": "同样基于Rust异步模型实现内核调度与系统调用，均为自研宏内核，对比其异步架构、任务调度与类型安全策略可揭示不同设计权衡。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "采用无栈协程调度架构，与当前项目基于async-task的有栈协程形成鲜明对比，可深入剖析两种异步模型的性能与复杂度差异。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "同为Rust异步宏内核，支持多架构（含riscv64和loongarch64），可比较硬件抽象层、跨架构异步驱动设计及系统调用兼容性策略。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "基于Rust异步语法实现内核任务调度，支持多架构（x86_64/riscv64/loongarch64），对比异步系统调用模型与跨架构宏内核工程的实现异同。"
  }
]
```