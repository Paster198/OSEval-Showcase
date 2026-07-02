```json
[
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为自研Rust双架构内核，均涉及TLB软件填充优化，但Aspera实现了更完整的内存管理（OOM、Zram、Swap、CoW），可对比架构抽象深度与内存子系统的设计取舍。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为自研Rust双架构同步内核，TatlinOS实现了懒分配、写时复制和百余系统调用，功能完备性远超LemonCore，适合对比系统调用覆盖度与设计选择。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为自研Rust双架构内核但采用异步协程调度与异步驱动模型，与LemonCore的同步FIFO调度形成鲜明对比，可探讨不同调度范式对复杂度与性能的影响。"
  },
  {
    "id": 60,
    "name": "SubsToKernel",
    "select_reason": "基于成熟的rCore教程框架构建的Rust双架构内核，与LemonCore从零自研形成直接对照，可评估框架化开发对代码复用、开发效率与最终质量的影响。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于XV6生态的C语言双架构内核，与LemonCore的Rust自研形成语言与生态双重对比，可分析内存安全、开发效率及EXT4实现（移植库 vs 自研）的差异。"
  }
]
```