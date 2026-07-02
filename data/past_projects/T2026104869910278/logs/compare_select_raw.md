```json
[
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "同基于rCore，均通过lwext4封装ext4，实现百余POSIX系统调用、信号帧、futex与共享内存，功能重叠度高但仅支持riscv64，可对比双架构扩展与信号嵌套等细节差异。"
  },
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同基于rCore并支持riscv64/loongarch64双架构，使用lwext4实现ext4，但系统调用仅73个，可比较双架构硬件抽象层设计与系统调用扩展策略。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同基于rCore且支持双架构，但从零自研ext4文件系统与轻量网络栈，而非封装C库，可对比文件系统实现路径与网络子系统设计差异。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于XV6的C语言宏内核，同样支持riscv64与loongarch64、实现ext4、信号、futex、共享内存等，基座与语言不同，可对比不同生态下实现相似Linux兼容性的架构差异。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "基于ArceOS组件化框架的Unikernel宏内核，支持四架构，利用独立页表信号跳板、共享内存与futex且代码量较小，可对比组件化与整体式rCore在双架构支持上的设计取舍。"
  }
]
```