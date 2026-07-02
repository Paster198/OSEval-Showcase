```json
[
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为Rust宏内核，支持RISC-V与LoongArch双架构，采用无栈协程异步调度架构，实现五种文件系统与完整VFS，与Chronix的设计路线高度相似，适合直接对比异步实现细节与系统调用兼容度。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "基于Rust异步语法的宏内核，支持x86_64、riscv64、loongarch64三架构，采用RCU与无锁结构优化关键路径，可在异步模型、多架构抽象与并发性能方面与Chronix形成鲜明对比。"
  },
  {
    "id": 58,
    "name": "NexusOS",
    "select_reason": "全异步内核设计且基于类型系统的零成本能力模型，纯Rust实现静态分发VFS，与Chronix同为多架构异步宏内核，但在安全抽象与资源管理路径上存在不同哲学，具有对比价值。"
  },
  {
    "id": 73,
    "name": "Del0n1x",
    "select_reason": "同样采用无栈协程实现内核异步调度，支持双架构，实现了页缓存与脏块追踪、分级释放的内存溢出处理，与Chronix的激进回收机制可进行内存管理策略的直接比较。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "基于ArceOS组件化框架的宏内核，以Unikernel方式部署，支持四种架构，与Chronix从零自研的独立内核形成生态路线对比，可分析组件化框架与全自研架构的优劣。"
  }
]
```