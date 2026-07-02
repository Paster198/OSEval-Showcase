```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为自研Rust宏内核，均支持RISC-V与LoongArch双架构，实现COW与百余系统调用，可对比架构抽象与内存管理设计的异同。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为自研Rust宏内核且双架构，但采用无栈协程异步调度，集成网络协议栈与五种文件系统，可深入对比同步与异步内核设计范式。"
  },
  {
    "id": 55,
    "name": "F7LY OS",
    "select_reason": "均支持双架构与ext4文件系统，并实现完整网络协议栈，但使用C++/EASTL而非Rust，可比较不同语言生态下的网络栈与系统设计。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为自研Rust宏内核且双架构，专注内存管理（Zram/Swap/多级OOM），可对比内存子系统深度与交换机制的设计思路。"
  },
  {
    "id": 23,
    "name": "ChaOS",
    "select_reason": "基于rCore生态的Rust宏内核，同样实现ext4与多平台支持，可对比从零自研与基于教程内核演进的工程路线差异。"
  }
]
```