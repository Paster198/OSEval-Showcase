```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为Rust宏内核，均支持EXT4与完整信号机制，但TatlinOS已实现LoongArch双架构抽象，与OSKernel预留的HAL设计形成直接对比。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "同为Rust宏内核，均支持EXT4，但采用异步无栈协程调度，与OSKernel的同步回调式调度形成根本性技术路线差异。"
  },
  {
    "id": 68,
    "name": "NPUcore-Aspera",
    "select_reason": "同为Rust宏内核，均采用自研HAL并支持EXT4，但具备ZRAM/Swap等高级内存回收机制，直击OSKernel无交换功能的短板。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "基于xv6(C语言)移植EXT4并支持信号，与OSKernel的Rust自研路线在相同核心功能实现上形成跨语言、跨基座的横向对比。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "采用基于能力的微内核架构，与OSKernel的宏内核设计在进程管理、资源隔离与通信模型上构成根本性架构哲学对比。"
  }
]
```