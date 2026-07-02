```json
[
   {
      "id": 41,
      "name": "unknown",
      "select_reason": "同基于xv6，均实现ext4文件系统与Linux兼容系统调用，直接对比自研ext4驱动与移植lwext4方案的实现差异。"
   },
   {
      "id": 8,
      "name": "xv6-sifive",
      "select_reason": "同基于xv6，扩展45个Linux系统调用并支持多FAT32挂载，可对比系统调用兼容层的实现策略与文件系统架构。"
   },
   {
      "id": 16,
      "name": "Hajimi-OS",
      "select_reason": "同基于xv6，扩展46个Linux系统调用并引入VMA管理，可对比内存管理与惰性分配策略的异同。"
   },
   {
      "id": 34,
      "name": "BugOS",
      "select_reason": "同基于xv6，移植lwext4实现ext4，支持60余个Linux系统调用，对比ext4集成方式与系统调用覆盖度。"
   },
   {
      "id": 47,
      "name": "REMOS",
      "select_reason": "同基于xv6，移植开源库实现完整ext4，扩展50个系统调用并采用每进程独立内核页表，对比双页表与内存优化。"
   }
]
```