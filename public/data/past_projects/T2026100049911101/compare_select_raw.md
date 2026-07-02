```json
[
  {
    "id": 44,
    "name": "MonkeyOS",
    "select_reason": "同为ByteOS生态的Rust宏内核，两者共享异步调度、polyhal硬件抽象等基座。直接对比可揭示NCAIOS在驱动注册、VFS设计、COW实现等方面相对于基座项目的独立创新与架构演进。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "均采用Rust异步语法实现内核任务调度，且支持多架构。对比可分析两者在async/await使用模式、执行器设计、阻塞操作语义化等方面的不同取舍，评估异步范式的工程实践差异。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "采用Rust无栈协程实现异步调度，与NCAIOS的async/await形成显著的实现路径对比。比较可揭示两种异步模型在内核态的性能特征、代码复杂度及可维护性方面的实际差异。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "作为微内核采用能力模型进行资源管理，与NCAIOS的宏内核FDT驱动发现、VFS统一抽象形成鲜明架构对比。比较可凸显两种内核设计哲学在安全性、可扩展性及性能方面的不同权衡。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust异步宏内核且系统调用覆盖度达约两百个，远超NCAIOS的75个。对比可分析高兼容性目标下异步架构的扩展策略、内存分配器优化及负载均衡等高级特性实现的差距。"
  }
]
```