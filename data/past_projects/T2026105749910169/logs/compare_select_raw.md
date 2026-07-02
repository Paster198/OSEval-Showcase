```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "与OS_mod高度同构：均从零构建Rust宏内核，支持riscv64+loongarch64双架构，实现COW、懒分配、POSIX信号及百余系统调用。可深入对比双架构抽象策略、页表泛型化设计与内存管理实现的异同。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为双架构Rust宏内核但采用全异步调度模型，与OS_mod的协作+抢占式同步调度形成鲜明对比。可比较异步vs同步在系统调用延迟、调度开销、负载均衡等方面的架构取舍与性能差异。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为双架构Rust宏内核，但支持EXT4+FAT32双文件系统、ZRAM压缩与Swap交换机制，在文件系统和内存管理深度上超越OS_mod的只读ext4。可对比文件系统架构与内存回收策略。"
  },
  {
    "id": 12,
    "name": "Being[3]++",
    "select_reason": "同为从零构建的Rust宏内核，基于async-task实现异步优先调度，深度集成Waker的异步睡眠锁，COW与按需懒分配机制成熟。可对比异步调度原语设计与COW实现路径的差异。"
  },
  {
    "id": 17,
    "name": "DuckOs",
    "select_reason": "同为从零构建的Rust宏内核，缺页异常采用Trait多态分发设计，引入VmaRange中间层灵活管理内存区间，与OS_mod的AddrSpace<PT>泛型地址空间形成有趣的架构设计对比。"
  }
]
```