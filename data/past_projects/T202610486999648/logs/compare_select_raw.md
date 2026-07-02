```json
[
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "同为Rust宏内核，支持四架构与百余系统调用，实现VFS与COW，但采用异步协作式调度，与当前项目抢占式调度形成技术路线对比。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "支持三架构的Rust异步宏内核，使用RCU与无锁结构优化关键路径，可对比高并发场景下的同步原语与架构设计。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "自研异步网络协议栈并集成五种文件系统，与当前项目自研网络栈可比，展示不同异步模型下的网络子系统实现。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "基于ArceOS组件化架构的多架构宏内核，模块化设计与跨架构抽象方式与当前无基座内核形成基座差异对比。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "从零完整自研EXT4文件系统，对比当前项目使用ext4_rs库的路线，反映文件系统实现深度与工程复用的不同选择。"
  }
]
```