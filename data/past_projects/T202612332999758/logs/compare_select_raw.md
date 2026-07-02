```json
[
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "同为纯Rust自研宏内核（无xv6/rCore基座），支持riscv64/loongarch64/x86_64三架构，均基于异步语法实现内核任务调度，均实现完整Linux克隆语义与百余系统调用，技术路线高度一致但具体实现（RCU/无锁结构 vs AsyncMutex/work-stealing）形成对比。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为无基座纯Rust宏内核，支持riscv64/loongarch64双架构，均基于Rust无栈协程的异步调度架构，均实现多种文件系统与完整VFS抽象，均深度集成网络协议栈。两者自研程度极高，但NoAxiom-OS实现了五种文件系统且无标准while RyOS自研TCP协议栈，可进行异步架构实现路径对比。"
  },
  {
    "id": 12,
    "name": "Being[3]++",
    "select_reason": "同为无基座纯Rust宏内核，基于async-task实现异步优先调度架构，内存管理支持COW与按需懒分配，实现完整VFS抽象层与FAT32，与RyOS的异步执行器、COW实现和VFS设计形成同技术路线的细粒度对比，可揭示不同实现深度的差异。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为无基座纯Rust宏内核，全异步内核设计与统一事件总线机制，支持COW与多类型内存区域抽象，集成多种文件系统与异步页缓存机制，实现百余个类Linux兼容系统调用。与RyOS在异步架构选型、系统调用完备度、文件系统集成深度上高度可比，可进行工程规模与架构演进路径的横向比较。"
  },
  {
    "id": 19,
    "name": "asynclear",
    "select_reason": "同为无基座纯Rust宏内核，采用异步模型实现非阻塞内核任务调度，利用类型系统保障内核内存与并发安全，实现页缓存机制支持文件后备内存映射。与RyOS在异步内核设计哲学、类型安全内存管理、页缓存实现上形成对照，可评估不同异步运行时选型（async-task vs 自定义）对内核架构的影响。"
  }
]
```