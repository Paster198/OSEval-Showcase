```json
[
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同为rCore生态的Rust宏内核，且是极少数同时支持RISC-V与LoongArch双架构的项目，通过polyhal实现硬件抽象。两者在双架构系统调用覆盖、VFS及ext4/FAT32支持上路径高度一致，适合对比架构抽象与跨平台实现的差异。"
  },
  {
    "id": 23,
    "name": "ChaOS",
    "select_reason": "同为rCore生态Rust宏内核，支持RISCV与VisionFive2双平台，完整实现SV39分页、VFS与ext4，提供50余个Linux兼容系统调用。与当前项目在文件系统、进程模型方面可进行细粒度功能对比。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "同为rCore生态Rust宏内核，实现百余个POSIX系统调用及写时复制、信号处理、Futex、基于lwext4的ext4文件系统，与当前项目在信号传递、Futex及ext4集成等技术点上高度匹配，便于衡量兼容性深度。"
  },
  {
    "id": 30,
    "name": "AronaOS",
    "select_reason": "同属rCore衍生Rust宏内核，但其采用基于Rust异步协程的协作式调度、FAT32与ext4双文件系统、页表级写时复制。与当前项目的传统FIFO调度与同步设计形成鲜明技术路线对比，可比较调度模型对系统设计与性能的影响。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "基于ArceOS组件化生态的Rust宏内核，支持三种架构、百余系统调用。与当前项目虽生态不同，但在系统调用覆盖、多架构支持及内存安全设计上有相似目标，可对比组件化与非组件化架构的实现复杂度与扩展性。"
  }
]
```