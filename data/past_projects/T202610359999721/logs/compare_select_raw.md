```json
[
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "同为微内核且基于能力模型，但语言为C，可直接对比能力系统设计、通信模型和架构取舍。"
  },
  {
    "id": 58,
    "name": "NexusOS",
    "select_reason": "同为Rust内核且内置能力模型，基于Asterinas框架的宏内核实现在能力抽象上可与本项目微内核能力系统形成结对比较。"
  },
  {
    "id": 59,
    "name": "KernelX",
    "select_reason": "同为微内核但基于RT-Thread生态，技术栈与设计理念差异明显，能在微内核实现路径上提供对照。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "同为Rust多架构内核但采用ArceOS组件化宏内核/Unikernel路线，与本项目微内核形成架构范式上的对比。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "同为Rust多架构内核但全面采用异步调度与无锁结构，与本项目同步IPC微内核在并发模型上构成技术路线对比。"
  }
]
```