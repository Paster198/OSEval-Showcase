```json
[
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "同为Rust宏内核，基于rCore生态，均实现百余个系统调用、ext4文件系统与信号处理，且支持写时复制，是与本项目最相似的技术路线对比对象。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为Rust自研宏内核，均支持ext4文件系统、信号机制和写时复制，且具备内存压缩、OOM处理等高级特性，可对比功能完整度与内存管理策略。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "基于C语言和xv6生态的宏内核，同时支持ext4与FAT32，具备信号处理、动态链接与COW，可从语言与生态差异角度进行对比分析。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "Rust异步宏内核，实现百余个系统调用与多种文件系统，采用全异步事件总线架构，与本项目传统同步设计形成鲜明对比，可分析调度与I/O模型差异。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "C语言微内核，基于能力模型与迁移式通信，与本项目宏内核设计范式完全不同，适于从内核架构、资源隔离与系统调用实现路径进行对比。"
  }
]
```