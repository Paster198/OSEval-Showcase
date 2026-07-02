```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同为xv6宏内核、同时支持RISC-V与LoongArch双架构、均集成ext4文件系统和futex，但SC7额外实现写时复制与Slab分配器，是双架构路线上的直接参考对象。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同为xv6宏内核、支持RISC-V与LoongArch、均集成lwext4，但Re-XVapor引入了线程组、动态链接和信号等更完整的POSIX语义，可对比进程/线程模型设计。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同为xv6宏内核，虽仅支持RISC-V，但实现了ext4与FAT32双文件系统、信号和动态链接，可比较文件系统抽象层次和多文件系统设计。"
  },
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "不同基座(rcore而非xv6)但同样实现RISC-V/LoongArch双架构和lwext4集成，可对比不同内核框架下的硬件抽象与文件系统移植策略。"
  },
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "同为xv6宏内核、早期移植lwext4的典型项目，支持60余个系统调用与信号，可对比ext4桥接层与系统调用兼容性的演进路径。"
  }
]
```