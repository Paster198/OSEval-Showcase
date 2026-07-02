```json
[
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "同为基于能力模型的内核，ChCore是微内核而Sustcore为混合内核，两者均将能力作为核心安全抽象，对比可评估不同内核类型下能力系统的设计取舍与性能差异。"
  },
  {
    "id": 51,
    "name": "RuOK OS",
    "select_reason": "均采用C++实现且支持RISC-V与LoongArch双架构，都自研ext4文件系统，可对比语言特性运用、架构抽象层次及文件系统实现的工程复杂度。"
  },
  {
    "id": 55,
    "name": "F7LY OS",
    "select_reason": "基于xv6但全面引入C++23及EASTL，同样支持双架构与ext4，比较可揭示现代C++对改造经典内核的收益，以及不同基座下的架构设计差异。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "采用Rust无栈协程的异步调度与Sustcore的传统多级调度形成鲜明对比；同为双架构、多文件系统，可对比异步vs同步调度对I/O性能和复杂度的影响。"
  },
  {
    "id": 58,
    "name": "NexusOS",
    "select_reason": "基于Asterinas框架的能力模型通过Rust类型系统零成本实现，与Sustcore用C++模板和引用计数实现的能力系统形成对照，可评估不同语言对能力安全机制的支撑效果。"
  }
]
```