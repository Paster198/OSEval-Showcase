```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust自研宏内核，支持riscv64与loongarch64双架构，均实现COW、EXT4文件系统、信号与页缓存，技术栈和设计目标高度重合，适合深度对比实现细节与架构取舍。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为Rust自研宏内核，支持双架构且拥有统一HAL层，均实现EXT4与COW，其内存回收与多级OOM机制与GoodOS的帧分配器形成互补视角，利于评估内存管理子系统。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust自研宏内核且支持双架构，但采用异步调度模型并实现约两百个系统调用，与GoodOS的同步FIFO调度形成鲜明对比，可深入分析调度器与系统调用兼容策略。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为Rust自研宏内核，支持双架构且具备完整VFS与丰富文件系统，其深度异步驱动与网络协议栈实现可对比GoodOS网络栈缺失与异步运行时的未集成状态。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "基于ArceOS组件化框架的Rust宏内核，同样支持多架构并实现信号、页缓存与VMA，其模块化设计与GoodOS的自研分层架构形成生态路线对比，凸显自研与框架复用的权衡。"
  }
]
```