```json
[
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "同为自研C语言宏内核，均从零实现支持Extent特性的ext4文件系统与ELF动态链接，技术路线高度重合，可直接对比ext4实现深度与系统调用兼容性。"
  },
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "同为自研C语言宏内核，均支持ext4文件系统与ELF动态链接，但TOYOS额外支持FAT32双文件系统与mmap，可对比文件系统架构设计与动态链接实现策略。"
  },
  {
    "id": 28,
    "name": "cabbageOS",
    "select_reason": "同为自研C语言宏内核，均实现Buddy物理分配器与ext4/FAT32双文件系统，但cabbageOS支持多核与COW，可对比单核vs多核架构及内存管理设计取舍。"
  },
  {
    "id": 20,
    "name": "StarsOS",
    "select_reason": "同为自研C语言宏内核，但StarsOS采用被动映射与initcall自动注册机制，文件系统仅支持FAT32，可对比主动映射vs被动映射及文件系统选型差异。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "虽基于xv6基座，但同样实现了ext4文件系统、动态链接ELF与写时复制，可对比自研内核与xv6派生内核在设计复杂度、代码复用度及创新空间上的差异。"
  }
]
```