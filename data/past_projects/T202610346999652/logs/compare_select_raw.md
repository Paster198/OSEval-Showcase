```json
[
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "同基于ArceOS的宏内核，均采用Unikernel部署方式实现Linux ABI兼容，并都使用Rust语言与多架构支持（riscv64/loongarch64等）。二者在进程隔离、信号、VFS等核心子系统上高度重叠，技术路线最为接近，适合直接对比设计决策与实现完整度。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "同为ArceOS生态的宏内核，使用Rust，支持四架构（含riscv64和loongarch64）。StarryX实现了类似的内存管理（VMA按需加载）和System V IPC，与当前项目在模块化设计、信号机制和文件系统方面有大量可对比之处，可展现同一生态下的不同架构取舍。"
  },
  {
    "id": 43,
    "name": "Undefined-OS",
    "select_reason": "同属ArceOS生态、Rust、多架构宏内核。该项目实现了进程组、会话层次模型和统一文件描述符抽象，与当前项目的进程与命名空间管理形成对比，可比较进程模型与伪文件系统框架的差异。"
  },
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "与当前项目同名且均基于ArceOS，但来自不同团队。两者都进行了Linux系统调用兼容、多架构支持和VFS构建，比较它们可揭示在相同基础设施上独立发展的不同侧重点和优化策略。"
  },
  {
    "id": 25,
    "name": "TOYOS",
    "select_reason": "不同于ArceOS生态的自研C语言宏内核，实现了FAT32/ext4双文件系统、ELF动态链接和55个系统调用。该项目的纯C自研路线与当前项目的Rust+ArceOS路线形成鲜明对比，可比较两种极端技术栈在Linux兼容性上的实现差异与工程成本。"
  }
]
```