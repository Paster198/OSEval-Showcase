```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust从零构建的宏内核，均支持RISC-V与LoongArch双架构，实现懒分配与写时复制，系统调用兼容数均在百余级别，可直接对比实现规模与技术深度。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust宏内核且支持双架构，但Chronix采用异步调度模型，系统调用覆盖约200个，与当前项目的传统CFS调度形成鲜明架构路线对比。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为Rust无生态宏内核、双架构支持，兼容EXT4与FAT32双文件系统，实现COW与磁盘交换，具备类似的Linux兼容目标，适合横向对比内存与文件系统设计。"
  },
  {
    "id": 55,
    "name": "F7LY OS",
    "select_reason": "采用C++23与Xv6基座，但同样支持RISC-V与LoongArch双架构，实现百余系统调用与完整ext4，集成网络栈，可比较语言生态与架构抽象差异。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "基于ArceOS组件化框架的Rust宏内核，支持多架构及System V IPC，拥有LRU页缓存与信号机制，可与当前从零构建的项目形成生态与模块化设计对比。"
  }
]
```