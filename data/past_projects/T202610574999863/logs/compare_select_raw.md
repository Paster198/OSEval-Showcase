```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同基于XV6的单体内核，均采用C语言并支持RISC-V与LoongArch双架构，文件系统、内存管理、系统调用等模块高度可比。"
  },
  {
    "id": 67,
    "name": "AddddOS",
    "select_reason": "同基于XV6的C语言单体内核，支持双指令集架构，实现了伙伴系统和EXT4文件系统，可对比架构抽象与功能深度。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同基于XV6的C语言双架构内核，实现了线程组分离、EXT4及动态链接，可对比进程模型与文件系统演进路径。"
  },
  {
    "id": 63,
    "name": "SpringOS",
    "select_reason": "同基于XV6的C语言双架构内核，适配真机开发板并集成EXT4，架构可移植性及设备适配策略值得比较。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "采用Rust异步无栈协程调度，同样支持RISC-V与LoongArch双架构，技术路线完全不同，可对比同步/异步设计决策。"
  }
]
```