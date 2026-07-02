```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为无生态自研Rust宏内核，支持RISC-V与LoongArch双架构，实现懒分配、COW、页缓存及百余系统调用与信号，技术栈高度重合，适合直接对比架构设计、实现深度与代码复用策略。"
  },
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "用C语言自研支持Extent特性的ext4文件系统与procfs，与RocketOS的ext4核心实现相似，可对比不同语言下ext4 extent树、动态链接及多文件系统抽象层的实现差异。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为无生态Rust双架构宏内核，但采用全异步调度模型，覆盖约两百系统调用，与RocketOS的同步模型形成鲜明对比，可深入分析并发模型、负载均衡与性能取舍。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "基于rCore生态但从零自研完整的ext4文件系统与轻量网络栈，与RocketOS的自研ext4和集成smoltcp路径不同，可比较‘生态基座+自研核心模块’与纯自研的工程权衡。"
  },
  {
    "id": 12,
    "name": "Being[3]++",
    "select_reason": "早期无生态Rust异步内核，基于async-task实现异步优先调度与COW、懒分配，VFS+FAT32，与RocketOS的同步架构对比，可以展现调度器、同步原语及Waker集成等设计哲学差异。"
  }
]
```