```json
[
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "同为自研无基座C宏内核，均从零实现ext4文件系统与trampoline特权级切换；TOYOS进一步支持ext4+FAT32双文件系统、mmap及动态链接，可与uuOS对比功能完整度与技术路线取舍。"
  },
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "同为自研无基座C宏内核，均实现ext4 extent树遍历与ELF加载；OSakura提供六十余个syscall、动态链接及procfs，可直接对比ext4实现深度、VFS抽象设计及系统调用扩展策略。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于xv6基座但同样覆盖RISC-V与LoongArch双架构，并实现ext4文件系统、伙伴内存管理与POSIX线程；可对比复用成熟框架与自研路线在双架构支持、文件系统集成上的工程差异。"
  },
  {
    "id": 51,
    "name": "RuOK OS",
    "select_reason": "同为双架构（RISC-V + LoongArch）宏内核，使用C++与EASTL构建，实现ext4哈希树目录索引及跨架构HSAI硬件抽象层；可对比不同语言范式下的架构抽象设计与双架构推进深度。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "采用微内核与能力模型，与uuOS的宏内核设计形成根本性对比；同为C语言RISC-V平台，可剖析系统调用路径、资源隔离及安全边界权衡，突显不同内核结构的设计哲学差异。"
  }
]
```