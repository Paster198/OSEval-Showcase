```json
[
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同为 Rust 宏内核、riscv64/loongarch64 双架构，均自研完整 ext4 与轻量网络栈，并实现 COW、mmap 等高级内存管理，技术路线高度重合，极具深度对比价值。"
  },
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "同为 rCore 生态的 Rust 宏内核，同样支持 riscv64/loongarch64 双架构，通过 lwext4 适配 ext4，与本项目基于 ext4_rs 的集成方案形成对照，可比较移植策略差异。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为 Rust 宏内核、双架构，具备 ext4 与 FAT32 双文件系统、完整信号与 CoW，且引入 OOM 处理与交换机制，可为本项目提供内存管理进阶发展的参考。"
  },
  {
    "id": 56,
    "name": "NoAxiom-OS",
    "select_reason": "同为 Rust 宏内核、双架构，但采用无栈协程异步调度与五种文件系统的完全异步设计，与本项目的同步 FIFO 调度形成鲜明技术路线对比。"
  },
  {
    "id": 43,
    "name": "Undefined-OS",
    "select_reason": "基于 ArceOS 组件化框架的 Rust 宏内核，支持四架构，采用动态构建的伪文件系统框架与进程组模型，为本项目提供不同生态与架构思路的对比样本。"
  }
]
```