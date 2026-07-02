```json
[
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为无基座Rust宏内核，支持RISC-V与龙芯双架构，实现统一HAL层、CoW、Swap、Ext4/FAT32双文件系统等，技术路线高度相似，适合直接比较架构设计与工程取舍。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为无基座Rust双架构宏内核，兼容百余个系统调用，实现懒分配与写时复制，可对比内存管理与系统调用覆盖的差异与共性。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "同样是无基座Rust宏内核且支持RISC-V与龙芯，但采用异步协作式调度而非whuse的抢占式模型，驱动方式与调度理念形成鲜明对比。"
  },
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "基于ArceOS框架的Rust多架构宏内核，与whuse完全独立实现形成对照，可比较框架复用与自研在架构抽象、开发效率及系统调用兼容性上的得失。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于xv6的C语言双架构宏内核，对比不同编程语言与生态基座在双架构支持、文件系统与系统调用实现上的架构差异。"
  }
]
```