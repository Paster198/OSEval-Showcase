```json
[
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为无基座Rust宏内核，均支持riscv64+loongarch64双架构，同时实现ext4与FAT32双文件系统、COW机制。技术栈和架构目标高度重合，对比可揭示不同设计决策在相同约束下的优劣。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为无基座Rust宏内核，支持riscv64+loongarch64双架构，兼容百余Linux系统调用。高度相似的技术路线使模块化设计、代码复用率等工程维度的对比具有直接参考价值。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为无基座Rust宏内核，支持双架构且覆盖约200个系统调用，但采用Rust异步模型实现内核调度。与MyGO的EEVDF同步调度形成调度策略层面的直接对比，可评估不同调度范式的实现复杂度与性能差异。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "基于rCore生态的Rust宏内核，同样支持双架构且从零自研ext4文件系统。不同基座选择（rCore vs 无基座）使两者在开发效率、架构约束和自主可控性方面的对比富有洞察价值。"
  },
  {
    "id": 58,
    "name": "NexusOS",
    "select_reason": "基于Asterinas框架的Rust宏内核，采用异步运行时与基于类型系统的能力模型，与MyGO的注入式分层同步架构形成最大技术路线差异。对比可展现安全性保障与架构灵活性的不同路径选择。"
  }
]
```