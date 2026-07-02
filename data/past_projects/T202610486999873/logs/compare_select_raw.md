```json
[
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同rCore生态，均通过lwext4集成ext4文件系统，系统调用数量相近（73 vs 110），且都支持多架构（riscv64+loongarch64），可深入对比扩展路径与VFS设计。"
  },
  {
    "id": 23,
    "name": "ChaOS",
    "select_reason": "同rCore生态，同样集成ext4并支持多平台（QEMU/VisionFive2），采用TCB统一模型管理进程与线程，可对比进程模型与系统调用实现深度。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "采用Rust异步、RCU无锁结构的多架构内核，与ScintillaOS的传统FIFO调度形成截然不同的技术路线，可对比调度模型与并发性能设计。"
  },
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "基于xv6/C生态实现ext4、COW、多架构等与ScintillaOS相似的高级特性，但基座语言不同，可对比不同生态达成相似功能集的方法与代价。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust宏内核，支持双架构且兼容百余系统调用，实现懒分配与COW等现代内存管理，与ScintillaOS功能集高度重叠，可比较架构抽象与代码复用。"
  }
]
```