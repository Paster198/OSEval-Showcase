```json
[
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为无生态自研Rust异步宏内核，支持RISC-V与龙芯双架构，基于无栈协程调度，集成五种文件系统与完整网络栈，技术路线高度相似，适合深入对比异步实现与架构设计。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "同为无生态自研Rust异步宏内核，支持三种架构，侧重RCU与无锁优化，系统调用覆盖广泛，可比较异步调度策略和并发模型差异。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于XV6的C语言宏内核，同样支持RISC-V与龙芯双架构，技术路线与Chronix的Rust异步设计形成鲜明对比，可比较语言、生态和内核结构的不同。"
  },
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "基于ArceOS组件化框架的Rust宏内核，支持四种架构，采用Unikernel部署方式，与Chronix的完全自研路线构成生态选择的典型对比。"
  },
  {
    "id": 71,
    "name": "Nighthawk OS",
    "select_reason": "同为哈工大深圳队伍的Rust异步宏内核，采用无栈协程，支持双架构，可进行同校横向对比，分析不同实现的异步VMA处理与文件系统设计。"
  }
]
```