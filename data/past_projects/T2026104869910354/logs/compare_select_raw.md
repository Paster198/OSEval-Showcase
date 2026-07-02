```json
[
  {
    "id": 23,
    "name": "ChaOS",
    "select_reason": "同为rCore宏内核并集成ext4文件系统，均基于Rust实现并追求Linux系统调用兼容性，可直接比较ext4集成方式与VFS设计。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "基于rCore且通过lwext4实现完整ext4，拥有百余系统调用、COW、信号处理等更完善特性，可对比实现深度与技术路线选择。"
  },
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "rCore宏内核并支持riscv64与loongarch64双架构，通过polyhal抽象硬件，与当前项目的双架构尝试形成对照，可比较硬件抽象与文件系统移植策略。"
  },
  {
    "id": 60,
    "name": "SubsToKernel",
    "select_reason": "同为rCore宏内核且支持双架构，引入COW、延迟分配、Futex等高级特性，对比可揭示当前项目在内存管理与同步原语上的差距。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "基于ArceOS的组件化宏内核，多架构、百余系统调用，设计理念与传统rCore宏内核截然不同，用以比较不同生态和架构思路的优劣。"
  }
]
```