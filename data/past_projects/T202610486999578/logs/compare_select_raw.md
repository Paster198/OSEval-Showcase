```json
[
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "同为ArceOS生态宏内核，支持四架构，实现写时复制、futex、SystemV IPC、信号等，与当前项目高度相似，适合对比同一框架下的不同实现深度与迭代路径。"
  },
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "基于ArceOS的宏内核，统一四架构，百余个系统调用，实现信号、共享内存及命名空间，为ArceOS生态内较早的宏内核集成案例，可对比架构演进与接口覆盖度。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "基于ArceOS组件化框架的宏内核，采用Unikernel部署方式，实现信号跳板、共享内存与futex，与当前项目同生态但集成模式不同，可对比部署差异与资源隔离策略。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "ArceOS生态宏内核，支持多架构及完整SystemV IPC与信号机制，包含LRU页缓存与VMA按需加载，技术栈与当前项目高度重合，适合比较内存管理与IPC实现。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "早期ArceOS宏内核，支持三架构、百余系统调用、多种调度及处理器亲和性，作为同生态的早期参考，可对比系统调用覆盖度与模块化设计进化。"
  }
]
```