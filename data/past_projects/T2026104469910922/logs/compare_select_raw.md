[
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同为xv6基底的宏内核，均实现写时复制、缺页懒分配、ext4文件系统及多文件系统支持，HatOS还具备动态链接与信号机制，适合比较功能成熟度与设计取舍。"
  },
  {
    "id": 21,
    "name": "冰清玉洁YWD",
    "select_reason": "同为xv6扩展内核，实现独立内核页表、COW、按需加载与52个系统调用，但文件系统侧重FAT32，可对比不同文件系统路线的实现复杂度与兼容性。"
  },
  {
    "id": 27,
    "name": "xv6",
    "select_reason": "基于xv6并移植lwext4库实现ext4支持，与FrostVista自研ext4读取器形成鲜明对比，可比较自主实现与外部库集成的工程权衡。"
  },
  {
    "id": 7,
    "name": "OSKernel2024-idk",
    "select_reason": "采用Rust异步协程调度与基数树页缓存，技术路线与FrostVista的C同步调度迥异，适合对比并发模型、内存管理与系统调用的设计差异。"
  },
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "同为C语言宏内核，支持FAT32+ext4双文件系统、动态链接与mmap，系统调用更丰富，可对比双文件系统架构、虚拟内存与ABI兼容的成熟度。"
  }
]