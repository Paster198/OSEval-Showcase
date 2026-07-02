```json
[
   {
      "id": 64,
      "name": "NPUcore-BLOSSOM",
      "select_reason": "同为无基座Rust双架构内核，均实现EXT4+FAT32、COW、信号等。可对比内存压缩/回收与StellarOS的懒分配/COW实现路径，分析VMM创新差异。"
   },
   {
      "id": 65,
      "name": "TatlinOS",
      "select_reason": "同为无基座Rust双架构内核，强调懒分配COW、页缓存和百余syscall。与StellarOS的EEVDF调度、squeue网络串行化形成不同优化方向对比。"
   },
   {
      "id": 72,
      "name": "Chronix",
      "select_reason": "同为无基座Rust双架构内核，采用异步调度、自研分配器、约200个syscall。可与StellarOS的同步EEVDF进行调度模型与并发设计深度对比。"
   },
   {
      "id": 56,
      "name": "NoAxiom-OS",
      "select_reason": "同为无基座Rust双架构内核，异步协程、五文件系统、网络协议栈。可与StellarOS的同步squeue串行化和多FS实现比较架构取舍。"
   },
   {
      "id": 68,
      "name": "NPUcore-Aspera",
      "select_reason": "同为无基座Rust双架构内核，强调HAL统一抽象、内存压缩与Swap。可对比StellarOS的HAL契约固化和OOM处理机制的设计哲学。"
   }
]
```