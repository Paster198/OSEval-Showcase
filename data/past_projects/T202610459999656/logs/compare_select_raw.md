```json
[
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为全异步Rust宏内核，但采用统一事件总线而非异步运行时，在异步模型设计哲学上形成鲜明对比，比较异步内核的不同实现路径。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "同为支持多架构的Rust异步宏内核，均实现VFS与写时复制，在硬件抽象层设计和POSIX系统调用兼容方面具有直接可比性。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "均支持ext4文件系统与异步调度，Pantheon采用无栈协程+十九个内核库的模块化设计，与NexusOS的异步运行时架构形成方法学对比。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同基于Rust异步架构且深度集成VFS，NoAxiom支持五种文件系统并与异步驱动紧密耦合，与NexusOS静态分发VFS形成设计理念对照。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为双架构Rust异步内核，Chronix侧重负载追踪与多核均衡，NexusOS侧重全异步运行时，在异步调度策略与多核扩展路径上形成互补比较。"
  }
]
```