```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为自研Rust双架构宏内核，实现懒分配与COW、百余个系统调用。其内存管理与fork策略可与alRED的eager fork快照及静态帧池形成直接对比。"
  },
  {
    "id": 73,
    "name": "Del0n1x",
    "select_reason": "同为自研Rust双架构宏内核，系统调用约200个，采用异步无栈协程。其异步调度与页缓存机制可与alRED的协作式线程及自研overlay VFS进行多维度对照。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "基于ArceOS组件化框架的三架构宏内核，百余个系统调用。与完全自研的alRED在架构理念、模块化程度和生态依赖上形成鲜明对比。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于XV6的C语言双架构宏内核，实现伙伴系统、Slab分配器及ext4文件系统。与Rust自研的alRED在语言栈、内存分配策略和文件系统实现上构成互补对比。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "自研Rust异步内核，支持双架构与五种文件系统。其深度异步模型和多文件系统抽象可与alRED的同步协作式模型及只读EXT4+内存overlay进行异同比较。"
  }
]
```