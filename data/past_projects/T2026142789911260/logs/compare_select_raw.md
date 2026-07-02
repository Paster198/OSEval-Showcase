[
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "同为自研Rust单体内核，均支持Sv39和EXT4文件系统，而调度模型截然不同：本项目为简单协作轮询，Pantheon采用无栈协程异步调度，便于对比同步与异步架构设计。"
  },
  {
    "id": 13,
    "name": "BITOS",
    "select_reason": "同为自研Rust单体内核，均实现伙伴系统物理内存管理与Sv39分页；但文件系统为FAT32+DevFS，与当前EXT4实现形成对比，利于分析不同文件系统集成策略。"
  },
  {
    "id": 62,
    "name": "OSakura",
    "select_reason": "同为单体内核，均实现EXT4文件系统支持；语言为C，与当前Rust实现形成鲜明对比，可比较内存安全、代码复杂度和扩展性方面的差异。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为自研Rust单体内核，但设计理念完全不同：MinotaurOS采用全异步内核与统一事件总线，本项目为同步协作调度，便于深入比较内核并发模型。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "微内核架构与当前单体内核形成根本性差异；基于能力模型的资源管理与本项目全局状态管理对比，可展示不同内核架构在安全性和复杂度上的权衡。"
  }
]