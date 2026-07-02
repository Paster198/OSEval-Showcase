```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同为xv6基座且支持RISC-V与LoongArch双架构；均实现ext4文件系统、大量系统调用扩展和内存管理优化，技术路线高度重合，适合对比架构移植、ext4集成能力及调度/同步等高级特性。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同为xv6基座、C语言、RISC-V与LoongArch双架构；移植lwext4实现ext4，引入mmap按需调页和ELF动态链接，与当前项目在ext4集成方式和用户程序加载方面形成明确对照。"
  },
  {
    "id": 67,
    "name": "AddddOS",
    "select_reason": "同基于xv6、支持双架构并集成外部ext4库，扩展八十余个系统调用且构建统一VFS抽象，与当前项目在系统调用覆盖和文件系统分层设计上有直接可比性。"
  },
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "同为xv6基座，集成lwext4实现ext4，扩展六十余个Linux兼容系统调用并支持信号处理，虽仅单架构，但其ext4集成模式和系统调用扩展策略与当前项目高度一致。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同为xv6基座内核，同时支持ext4与FAT32双文件系统，并实现动态链接和写时复制，其双文件系统架构设计与当前项目形成对照，可对比文件系统抽象层的实现差异。"
  }
]
```