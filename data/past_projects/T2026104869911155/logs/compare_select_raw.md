```json
[
   {
      "id": 72,
      "name": "Chronix",
      "select_reason": "同为Rust自研单体内核，支持RISC-V与LoongArch双架构，内置异步调度且覆盖约两百个系统调用。技术路线与OSoldierBoy高度重合，适于对比双架构实现与异步/同步机制的设计取舍。"
   },
   {
      "id": 32,
      "name": "MinotaurOS",
      "select_reason": "同为Rust自研单体内核，以全异步和统一事件总线构建百余个系统调用的调度体系。可与OSoldierBoy的SyscallResult异步调度进行深度比较，揭示不同异步模型的工程影响。"
   },
   {
      "id": 69,
      "name": "StarryOS",
      "select_reason": "基于ArceOS组件化框架的Rust宏内核，多架构与完整信号/写时复制支持，与OSoldierBoy的零外部依赖自研路线形成鲜明对比，可探讨组件化与全自研的架构差异。"
   },
   {
      "id": 49,
      "name": "Pantheon OS",
      "select_reason": "同为Rust自研内核，实现了EXT4文件系统与无栈协程调度。文件系统类型相同但调度模型差异明显，适合对比EXT4只读与协程调度的实现策略。"
   },
   {
      "id": 65,
      "name": "TatlinOS",
      "select_reason": "同为双架构Rust自研内核，采用懒分配/写时复制内存管理并兼容百余系统调用与POSIX信号。与OSoldierBoy在跨架构抽象和内存管理策略上高度可比。"
   }
]
```