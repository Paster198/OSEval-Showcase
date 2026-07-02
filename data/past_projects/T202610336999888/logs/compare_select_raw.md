```json
[
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "同为ArceOS生态的宏内核项目，均支持riscv64+loongarch64多架构，且均实现百余系统调用、完整信号处理、IPC共享内存及命名空间机制，是技术上最接近的同期竞品。"
  },
  {
    "id": 70,
    "name": "AstrancE",
    "select_reason": "同为ArceOS生态的2025年宏内核项目，可插拔陷阱处理机制与OrayS的linkme分布式注册形成设计对比，闭包生成器实现procfs与OrayS的合成文件系统路径各异，比较价值高。"
  },
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "同为ArceOS生态的四架构宏内核项目，分片Futex表设计减少多核锁竞争，与OrayS的Futex实现形成性能优化路径对比，同时集成SystemV IPC与完整信号处理。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "同基于ArceOS组件化框架，但采用Unikernel部署方式运行宏内核功能，与OrayS传统宏内核路径形成鲜明技术路线对比，可评估两种方案的取舍。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "基于rCore生态而非ArceOS，但同为Rust宏内核且实现百余POSIX系统调用、写时复制及ext4文件系统，对比不同基座上构建Linux兼容层的实现策略差异。"
  }
]
```