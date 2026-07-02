[
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同为基于rCore的Rust宏内核，均支持RISC-V与LoongArch双架构，且从零自研完整EXT4文件系统。对比可评估EXT4实现深度、架构抽象层设计及内存管理高级特性（如COW）的差异。"
  },
  {
    "id": 60,
    "name": "SubsToKernel",
    "select_reason": "同为基于rCore的Rust双架构内核，实现了COW、延迟分配、动态链接与完整Futex。可对比分析HPU OS在内存管理、动态加载和同步机制方面的缺失与简化策略。"
  },
  {
    "id": 23,
    "name": "ChaOS",
    "select_reason": "同属rCore生态的Rust宏内核，集成ext4文件系统并支持多硬件平台。对比双方在文件系统（均含ext4）与平台适配（双架构 vs 双开发板）的工程化差异。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为Rust双架构自研宏内核，支持EXT4+FAT32双文件系统及COW/Swap等高级内存管理。可对比文件系统多样性、内存回收能力与系统调用实现策略。"
  },
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "虽为C语言自研单架构内核，但支持ext4与FAT32双文件系统、动态链接与mmap。从不同语言路线对比ext4实现、动态加载和系统调用兼容性的设计取舍。"
  }
]