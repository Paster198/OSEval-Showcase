```json
[
  {
    "id": 20,
    "name": "StarsOS",
    "select_reason": "同为自研C语言宏内核，采用被动映射机制与写时复制，与当前项目的引用计数COW实现形成对照，比较内存管理设计哲学。"
  },
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "同为自研C语言宏内核，均支持ext4与ELF动态链接，对比文件系统实现与用户态兼容（双文件系统 vs 当前merfs+ext4）。"
  },
  {
    "id": 28,
    "name": "cabbageOS",
    "select_reason": "同为自研C语言宏内核，实现Buddy系统、COW、多核与双文件系统，功能集重叠度高，适合对比架构设计、物理内存分配与多核支持。"
  },
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "同为自研C语言宏内核，专注于ext4的Extent特性实现，与当前项目手写ext4 extent解析形成深度技术对比。"
  },
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "基于xv6的C语言宏内核，通过lwext4集成ext4，与当前从零自研、手写ext4形成技术路线差异，对比基座扩展与自主实现的权衡。"
  }
]
```