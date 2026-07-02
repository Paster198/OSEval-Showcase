```json
[
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "同为C语言自研宏内核且均实现ext4文件系统（含Extent特性）与ELF动态链接，技术路线高度一致，可直接对比ext4实现深度、系统调用覆盖及动态链接方案的差异。"
  },
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "同为C语言自研宏内核，均支持ext4文件系统与ELF动态链接，且TOYOS额外支持FAT32双文件系统及mmap，对比可揭示NoobKernel在文件系统多样性和内存映射方面的缺失。"
  },
  {
    "id": 28,
    "name": "cabbageOS",
    "select_reason": "同为C语言自研宏内核，均采用Buddy物理内存管理与ext4/FAT32双文件系统，但cabbageOS具备COW与多核支持，对比可凸显NoobKernel在内存优化与并发能力方面的差距。"
  },
  {
    "id": 42,
    "name": "ASVOS",
    "select_reason": "同为C/xv6基座的宏内核且均支持ext4，但ASVOS移植lwext4库而NoobKernel自研ext4，形成'外部库移植'与'从零自研'的典型技术路线对比，可评估两种策略的利弊。"
  },
  {
    "id": 20,
    "name": "StarsOS",
    "select_reason": "同为C语言自研宏内核但采用不同的文件系统路线（FAT32而非ext4），且具备被动映射、COW及initcall机制，对比可展示不同设计哲学在内存管理与模块初始化方面的取舍。"
  }
]
```