```json
[
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同为xv6基座且均自研ext4与动态ELF加载，可深度对比文件系统实现、COW与信号机制的完整度。"
  },
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "同在xv6上实现ext4，但采用移植lwext4库的方式，与当前自研路线形成鲜明对照，可比较工程复杂性与兼容性。"
  },
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "同为C语言自研ext4且支持动态链接，但无xv6基础，适合对比独立构建与基于教学OS改造的设计差异。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "微内核架构与当前宏内核形成根本性设计对比，可探讨能力模型、通信开销与系统调用兼容策略。"
  },
  {
    "id": 30,
    "name": "AronaOS",
    "select_reason": "基于rCore的Rust异步宏内核，对比C与Rust在安全性、并发模型及文件系统集成上的不同技术路线。"
  }
]
```