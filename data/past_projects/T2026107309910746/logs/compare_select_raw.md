```json
[
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "同属xv6生态，同样基于lwext4实现ext4支持，配套60余个Linux兼容系统调用及POSIX信号，与当前项目技术路线高度重合，便于量化对比功能完整度。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同为xv6宏内核，集成lwext4、mmap按需调页、ELF动态链接、信号与futex，并实现线程组分离，几乎覆盖当前项目所有核心特性，是评估同类最佳实践的理想参照。"
  },
  {
    "id": 47,
    "name": "REMOS",
    "select_reason": "同样基于xv6并使用lwext4，支持每进程独立内核页表与伙伴分配器，可对比内存管理设计差异，同时提供50个系统调用，适合进行系统调用覆盖度的横向比较。"
  },
  {
    "id": 24,
    "name": "ruaruaos",
    "select_reason": "同为xv6宏内核，但选择自研ext4解析而非依赖lwext4，拥有70余个系统调用及信号机制，与当前项目形成实现路径对比，可分析库集成与自主实现的设计权衡。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同属xv6生态，同时支持ext4与FAT32双文件系统，具备COW、动态链接和完整信号机制，与当前项目的VFS双后端设计直接可比较，检验多文件系统共存方案的优劣。"
  }
]
```