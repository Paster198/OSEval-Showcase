```json
[
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "同为无生态Rust宏内核，支持含LoongArch的多架构与硬件抽象层，但采用异步协作调度，与KunikOS同步顺序执行形成鲜明对比，可深入比较架构抽象与调度模型。"
  },
  {
    "id": 51,
    "name": "RuOK OS",
    "select_reason": "C++实现双架构宏内核，具备HSAI跨架构硬件抽象层，与KunikOS的Rust HAL形成语言与设计模式对比，同为从零构建的双架构内核。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "Rust双架构且亮点包含“LAFlex页表内联汇编优化TLB填充”，与KunikOS的软件TLB重填直接可比，技术深度高度一致，适合对比页表与TLB管理策略。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "Rust三架构，采用异步调度与RCU无锁结构，与KunikOS同步顺序和简单自旋锁形成对比，跨架构抽象与内核并发模型均有较高比较价值。"
  },
  {
    "id": 71,
    "name": "Nighthawk OS",
    "select_reason": "Rust双架构，基于异步无栈协程与跨架构支持，直接对比KunikOS的同步顺序执行与硬件抽象设计，可揭示同步与异步在相同架构约束下的工程取舍。"
  }
]
```