[
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为NPUcore系列，均支持RISC-V与LoongArch双架构、EXT4与FAT32、CoW及信号机制，直接体现同一基线的功能迭代与设计取舍。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同一NPUcore分支，双架构且同样实现Zram/Swap、多层OOM、Ext4，技术路线高度重合，便于对比内存管理与文件系统的具体策略差异。"
  },
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "从零实现支持Extent树的ext4文件系统，与NPUcore-Ovo的自研ext4 extent形成文件系统深度的正面对比，同时考察不同语言（C/Rust）下的实现差异。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust双架构无基座内核，实现CoW、页缓存和百余系统调用，可比较调度、异步机制及架构抽象设计，展现不同自研路线的优劣势。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "基于ArceOS生态的多架构Rust内核，采用组件化设计并实现完整IPC与VMA，与NPUcore-Ovo的自研HAL形成架构哲学对比，考察可复用性与灵活性的取舍。"
  }
]