```json
[
  {
    "id": 15,
    "name": "SleepOS",
    "select_reason": "同属xv6基座，均实现COW与被动调页，且进程与线程分离设计高度相似，可直接对比内存管理与并发模型。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同为xv6衍生，支持COW、ext4/FAT32双文件系统及动态链接ELF，可对比文件系统扩展与动态加载实现路线。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "基于rCore与Rust，功能集高度重叠（COW、信号、共享内存），可跨基座对比功能实现深度与内存安全策略。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "采用Rust无栈协程异步调度，与BirdOS的传统动态优先级调度形成架构级对比，可揭示调度策略对系统特性的影响。"
  },
  {
    "id": 55,
    "name": "F7LY OS",
    "select_reason": "同为xv6衍生但改用C++并集成完整网络协议栈，与BirdOS的C语言UDP栈形成语言选型与网络深度对比。"
  }
]
```