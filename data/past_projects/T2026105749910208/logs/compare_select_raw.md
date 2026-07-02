```json
[
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同基于polyhal实现双架构硬件抽象，同为Rust宏内核。对比可从rCore衍生与独立实现的架构差异，以及在相同HAL下系统调用、内存管理、文件系统的设计取舍。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "同为Rust宏内核且支持riscv64与loongarch64，但基于ArceOS组件化框架。可对比独立构建与框架化构建在模块复用、架构抽象、信号与IPC实现上的不同路径。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同样为自研Rust宏内核，支持riscv64与loongarch64双架构，实现COW、百余系统调用。两者在内存管理、进程模型与技术选型上高度相似，适合深度横向比较。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同属双架构Rust宏内核且从零实现ext4文件系统。可与wll_OS对比ext4集成方式、页缓存与回写机制，以及VFS层的自研思路差异。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "全异步Rust宏内核，系统调用覆盖面广。可与wll_OS的同步调度、前台驱动模式形成鲜明对比，分析不同调度模型对兼容性、复杂度和性能的影响。"
  }
]
```