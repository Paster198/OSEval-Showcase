```json
[
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同使用polyhal实现RISC-V与LoongArch双架构，均通过lwext4集成ext4文件系统，系统调用数量与兼容目标相近，可直接对比硬件抽象层设计、ext4绑定方式及用户态兼容性演进路径。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "同为Rust内核且依赖lwext4实现ext4，但基于rCore并实现了写时复制与完整信号递送，可对比在相同文件系统基座上子系统实现的深度差异，揭示功能取舍与复杂度的权衡。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为自研Rust内核并支持RISC-V与LoongArch双架构，具备CoW、多层OOM及Zram等高级内存特性，可对比自研路线的设计复杂度、内存管理成熟度及双架构统一抽象策略。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同样支持双架构，但选择从零自研完整ext4文件系统而非移植lwext4，可对比文件系统实现路线的工程成本、性能特征与可维护性，反映技术决策的根本差异。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "采用Rust异步协作式调度与polyhal多架构抽象，与当前FIFO同步调度形成鲜明对比，可比较调度模型、并发控制及硬件抽象复用的不同技术路径及其对系统性能与扩展性的影响。"
  }
]
```