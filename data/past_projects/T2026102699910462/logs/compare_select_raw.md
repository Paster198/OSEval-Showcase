```json
[
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为无生态Rust双架构宏内核，均实现ext4等文件系统，但NPUcore-BLOSSOM额外包含COW、压缩内存与交换分区等高级内存管理，适合对比内存子系统的深度和复杂度。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为无生态Rust双架构宏内核，均兼容百余Linux系统调用与完整信号机制，但TatlinOS强调双架构统一抽象与高代码复用率，可比较架构抽象的设计策略。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为无生态Rust双架构宏内核，均支持ext4与多级内存管理，但Aspera实现了Zram、Swap和CoW等更复杂的内存回收机制，可对比内存管理成熟度。"
  },
  {
    "id": 71,
    "name": "Nighthawk OS",
    "select_reason": "同为无生态Rust双架构宏内核，但采用异步无栈协程调度，与SudoOS-Plus的同步多队列调度形成鲜明对比，可展示不同调度模型对内核设计的影响。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "基于ArceOS组件化框架的Rust多架构宏内核，与SudoOS-Plus从零构建的自研路线迥异，适合比较组件化复用与完全自研在工程复杂度、可维护性上的差异。"
  }
]
```