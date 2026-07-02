[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust宏内核，支持riscv64+loongarch64双架构，实现百余Linux syscall与COW，页缓存设计相似，可在架构抽象与syscall兼容性上深入比较。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同样从零自研ext4读写、双架构抽象与COW机制，且均实现网络栈，适合对比文件系统与硬件抽象的具体实现策略。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "Rust双架构宏内核，具备ext4+FAT32、COW、信号与OOM处理，与WaterOS在内存与文件子系统上有大量可比功能点。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust双架构宏内核但采用异步调度模型，约200个syscall，对比WaterOS的同步模型可凸显调度架构差异对系统设计的影响。"
  },
  {
    "id": 36,
    "name": "ByteOS",
    "select_reason": "支持四架构的异步Rust宏内核，跨架构HAL与百余POSIX syscall对比WaterOS的三层分层设计，可比较可移植性与调度策略。"
  }
]