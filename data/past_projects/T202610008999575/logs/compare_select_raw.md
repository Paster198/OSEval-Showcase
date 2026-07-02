```json
[
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同属rCore生态、Rust语言与riscv64/loongarch64双架构，均实现ext4支持。可对比双架构硬件抽象、ext4实现路径（自研 vs lwext4移植）及mmap/懒加载等内存管理策略。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同属rCore生态、Rust与riscv64/loongarch64双架构，均从零自研ext4文件系统。可深入对比extent树、块分配等ext4核心实现完整性，以及双架构条件编译与自研网络栈差异。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同采用Rust并支持riscv64/loongarch64双架构，均实现统一硬件抽象、COW与页缓存。可对比架构抽象粒度、内存管理设计及百余系统调用的兼容性覆盖范围。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同支持riscv64/loongarch64双架构与ext4文件系统，并实现内存压缩与交换等高级内存管理。可对比多级OOM处理、双文件系统共存及页面回收机制的实现深度。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为Rust宏内核，实现百余系统调用与ext4支持，但采用全异步事件总线设计。可对比同步调度与异步调度的架构取舍、信号与IPC机制的实现差异。"
  }
]
```