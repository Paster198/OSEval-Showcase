```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同为XV6生态C语言宏内核，均支持RISC-V与龙芯双架构、伙伴系统+Slab分配器及EXT4文件系统，技术栈高度重合，便于直接对比实现成熟度。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同属XV6生态C双架构，移植lwext4实现EXT4，且实现mmap按需调页、ELF动态链接、信号与Futex，可横向评估系统调用兼容性。"
  },
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "较早（2024）的XV6生态C单架构项目，率先移植lwext4实现EXT4与POSIX信号，作为技术演进参照，揭示当前项目在双架构与功能扩展上的进步。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "采用Rust+rCore生态，从零自研EXT4而非移植库，同样支持双架构，对比可凸显不同语言与文件系统实现策略下的工程复杂度与安全性差异。"
  },
  {
    "id": 63,
    "name": "SpringOS",
    "select_reason": "同为XV6生态C双架构，集成EXT4并适配真机开发板，实现龙架构非对齐访问软件模拟，在硬件适配深度上形成有益对照。"
  }
]
```