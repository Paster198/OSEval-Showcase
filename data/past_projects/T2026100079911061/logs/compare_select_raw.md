```json
[
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为Rust自研monolithic内核，支持双架构，实现ext4与FAT32双文件系统、写时复制及信号机制，且具备内存压缩与swap等高级内存管理，与unit00在技术栈和功能目标上高度可比。"
  },
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "Rust自研双架构内核，实现懒分配与写时复制、页缓存、百余系统调用及完整信号处理，架构风格与unit00相近但采用更模块化的设计，适合对比系统调用兼容性与内存管理策略。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "同为Rust自研riscv64 monolithic内核，但采用全异步协程调度与事件总线架构，与unit00的传统抢占式调度形成鲜明对比，可深入分析异步vs同步设计在内核性能与复杂度上的权衡。"
  },
  {
    "id": 28,
    "name": "cabbageOS",
    "select_reason": "C语言自研内核，与unit00的Rust实现形成语言范式对比，同时二者均具备伙伴系统、写时复制、按需分页及双文件系统支持，可比较不同语言下类似功能的实现复杂度与安全性。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "基于rCore生态的Rust内核，完整实现ext4、futex、信号等机制，拥有百余系统调用，与unit00的无基座自研路线形成“生态与自研”技术路径对比，便于评估框架复用与从零构建的优劣势。"
  }
]
```