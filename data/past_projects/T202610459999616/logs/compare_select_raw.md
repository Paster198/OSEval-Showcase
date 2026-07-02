```json
[
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "同基于ArceOS组件化框架的宏内核，采用Rust语言，与PulseOS生态相同。KeepOnOS支持三种架构、百余系统调用和多种调度算法，可对比组件化设计、系统调用覆盖与调度器实现。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "同属ArceOS生态，支持LoongArch等四架构，采用Unikernel方式部署宏内核。其命名空间资源隔离与信号跳板设计，可与PulseOS的传统宏内核进程模型对比架构选择与实现路径。"
  },
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "基于ArceOS的四架构宏内核，实现了分片Futex表、写时复制、完整VFS与SystemV IPC。其futex优化与PulseOS的FutexTable设计有直接可比性，便于评估并发性能策略。"
  },
  {
    "id": 70,
    "name": "AstrancE",
    "select_reason": "同为ArceOS生态，支持四架构。其可插拔陷阱处理、多后端内存映射绑定方式，与PulseOS的exec原子替换和扁平FrameTable形成鲜明对照，可探讨内核扩展性设计。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为Rust宏内核且支持RISC-V与LoongArch双架构，但采用异步无栈协程调度和多种文件系统，与PulseOS的传统线程调度路线差异显著，适合对比不同并发模型的效果与复杂度。"
  }
]
```