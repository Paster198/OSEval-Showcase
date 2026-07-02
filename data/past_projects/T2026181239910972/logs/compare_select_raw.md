```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同属独立实现的双架构（RISC-V/LoongArch）Rust宏内核，均追求Linux兼容性并实现百余系统调用与信号机制；对比可考察两者在VFS、页缓存、COW等内存管理策略上的差异。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为独立Rust宏内核且支持双架构，采用Frame状态机管理CoW、Zram与Swap等多级OOM处理；与Anemone对比能凸显内存子系统的深度与交换机制的有无。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "采用Rust异步协作式调度并支持四架构，与传统抢占式设计的Anemone形成鲜明路线对比；适合分析异步模型对系统调用兼容性与模块化带来的不同影响。"
  },
  {
    "id": 60,
    "name": "SubsToKernel",
    "select_reason": "基于rCore教程演进的双架构宏内核，实现了COW、动态链接与富Futex；可对比从教程继承与从零构建在架构抽象和系统调用覆盖率上的不同路径。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "基于无栈协程的异步双架构内核，集成完整网络协议栈与五种文件系统；与Anemone对比能突出异步环境下驱动整合、并发性能及缺失网络功能的代价。"
  }
]
```