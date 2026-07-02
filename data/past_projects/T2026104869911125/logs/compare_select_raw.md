```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同为XV6生态、RISC-V与LoongArch双架构，移植ext4文件系统，采用C语言实现。与F7LY的C++实现形成语言与工程风格直接对照。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同为XV6生态、双架构、移植ext4，实现Linux风格线程组分离。与F7LY精细化进程线程模型高度相似，便于深入对比进程管理设计。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "同为宏内核且支持LoongArch，但采用Rust异步语法、RCU与无锁结构。与同步C++的XV6路线完全不同，可对比异步/同步架构取舍。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "采用微内核架构与能力模型，与F7LY宏内核形成架构范式对比。可分析资源管理、IPC开销及系统调用兼容路径的差异。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为双架构宏内核且集成完整网络协议栈，但基于Rust无栈协程异步调度与五种文件系统。对比F7LY同步C++网络栈实现，展示技术多样性。"
  }
]
```