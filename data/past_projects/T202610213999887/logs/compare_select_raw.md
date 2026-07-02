```json
[
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为Rust自研宏内核、RISC-V与龙芯双架构、EXT4与FAT32双文件系统、COW与内存压缩等高级内存管理，技术栈高度重合，适合对比文件系统与内存管理实现深度。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "基于rCore但自研EXT4及网络协议栈，同时支持双架构和COW，可比较文件系统自研路径与生态依赖差异，评估从零构建与框架复用的取舍。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为Rust无生态宏内核、双架构，但采用无栈协程异步调度，与当前项目传统抢占式调度形成鲜明对比，可展示不同并发模型的设计取舍与性能特点。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "基于能力模型的微内核，与当前宏内核架构哲学完全不同，可对比内核结构对隔离性、通信开销及安全模型的影响，提供架构互补视角。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "基于ArceOS组件化框架的宏内核，实现SystemV IPC与信号，与当前项目在基座选型上截然不同，可比较组件化复用与全自研在开发效率与可维护性上的差异。"
  }
]
```