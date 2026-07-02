```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为无生态自研Rust宏内核，支持RISC-V与LoongArch双架构，实现懒分配、COW、页缓存、POSIX信号及百余系统调用，技术特征与CoreCraft高度相似，适合进行自研双架构内核设计的平行对比。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "基于rCore生态但仍保持自研完整EXT4文件系统，与CoreCraft集成lwext4的方式形成‘自研文件系统 vs. C库FFI集成’的对比；同时均支持双架构、COW与mmap，可分析框架基座对设计复杂度的影响。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为自研Rust双架构宏内核，兼容EXT4与FAT32，拥有更激进的内存特性（OOM处理、压缩内存、磁盘交换），与CoreCraft基础内存管理形成层次化比较，可评估内存子系统设计的深度差异。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为自研Rust双架构宏内核，但采用无栈协程异步调度与深度异步驱动集成，与CoreCraft的同步协程调度形成明确的‘同步 vs. 异步’技术路线对比，可分析调度模型对内核架构与扩展性的影响。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为自研Rust双架构宏内核，基于异步模型并实现负载追踪、多核负载均衡、十三级缓存分配器及约两百个系统调用，展示异步内核在性能和并发方面的探索，与CoreCraft同步设计形成另一种技术演进参照。"
  }
]
```