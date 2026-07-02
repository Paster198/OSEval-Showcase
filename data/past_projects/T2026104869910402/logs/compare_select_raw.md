```json
[
   {
      "id": 50,
      "name": "unknown",
      "select_reason": "同源于 rCore 生态，均基于 polyhal 实现 riscv64 与 loongarch64 双架构硬件抽象；文件系统、信号、futex 等 POSIX 兼容能力高度重叠，可对比宏内核的架构实现与跨平台策略。"
   },
   {
      "id": 36,
      "name": "ByteOS",
      "select_reason": "同为宏内核且依赖 polyhal 跨架构抽象，支持四架构；但 ByteOS 采用 Rust 异步协作式调度，与当前项目的同步抢占式设计形成技术路线对比，可深入分析调度与并发模型差异。"
   },
   {
      "id": 30,
      "name": "AronaOS",
      "select_reason": "基于 rCore 并实现 FAT32 与 ext4 双文件系统、协程异步调度及 COW；与当前项目在文件系统和内存管理功能相似，但调度模型完全不同，适于比较异步/同步内核的设计权衡。"
   },
   {
      "id": 64,
      "name": "NPUcore-BLOSSOM",
      "select_reason": "自研 Rust 宏内核，同样实现 ext4 与 FAT32、COW、信号机制，且支持 riscv64 与 loongarch64 双架构；无生态依赖的独立实现与当前项目在多架构支持、内存与文件系统完备性上高度可比。"
   },
   {
      "id": 23,
      "name": "ChaOS",
      "select_reason": "基于 rCore 生态的宏内核，集成 ext4 文件系统与大量 Linux 兼容系统调用，单架构但实现深度相当；对比可揭示从 rCore 衍生到跨架构扩展中的架构重构与模块剥离策略。"
   }
]
```