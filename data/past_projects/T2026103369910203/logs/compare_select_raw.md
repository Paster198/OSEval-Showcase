```json
[
   {
      "id": 56,
      "name": "NoAxiom-OS",
      "select_reason": "与当前项目技术路线高度重合：均为自研Rust异步无栈协程内核，均支持riscv64+loongarch64双架构，均实现VFS与多种文件系统。可直接对比异步调度、架构抽象、文件系统集成的设计差异。"
   },
   {
      "id": 72,
      "name": "Chronix",
      "select_reason": "同为自研Rust异步内核且支持riscv64+loongarch64双架构，系统调用覆盖约200个，实现负载追踪与多核负载均衡。可对比异步运行时的调度策略、多核支持及系统调用兼容性的实现深度。"
   },
   {
      "id": 36,
      "name": "ByteOS",
      "select_reason": "同为Rust异步内核但支持四架构（含riscv64与loongarch64），兼容百余POSIX系统调用。规模更大、架构更广，可对比硬件抽象层设计、跨架构代码复用策略及异步系统调用实现路径。"
   },
   {
      "id": 32,
      "name": "MinotaurOS",
      "select_reason": "同为全异步Rust自研内核，采用统一事件总线而非工作窃取调度，实现100+系统调用。单架构但异步设计理念不同，可对比事件驱动vs任务窃取两种异步范式的架构影响。"
   },
   {
      "id": 68,
      "name": "NPUcore-Aspera",
      "select_reason": "同为自研Rust双架构内核但采用传统同步设计，实现统一HAL层、Zram+Swap、Ext4+FAT32双文件系统。可对比异步vs同步内核在内存管理深度、I/O路径设计上的根本差异。"
   }
]
```