```json
[
   {
      "id": 36,
      "name": "ByteOS",
      "select_reason": "同为四架构宏内核，采用Rust异步调度，与NAOS的C同步模型形成语言与调度策略对比，且系统调用兼容度均较高。"
   },
   {
      "id": 72,
      "name": "Chronix",
      "select_reason": "无基座宏内核，覆盖约200个系统调用，实现负载均衡，与NAOS在系统调用丰富度和SMP支持上可横向对比。"
   },
   {
      "id": 65,
      "name": "TatlinOS",
      "select_reason": "无基座Rust宏内核，支持双架构，具懒分配与COW，百余系统调用，与NAOS在内存管理和系统调用兼容性上可比较。"
   },
   {
      "id": 55,
      "name": "F7LY OS",
      "select_reason": "基于Xv6的C++双架构宏内核，含完整网络协议栈，与NAOS在网络子系统及文件系统实现上可对比。"
   },
   {
      "id": 5,
      "name": "OSKernel2024-KeepOnOS",
      "select_reason": "基于ArceOS组件化框架的Rust宏内核，支持三架构，百余系统调用，与NAOS从零构建的C宏内核形成生态与设计哲学对比。"
   }
]
```