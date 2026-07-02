```json
[
    {
        "id": 63,
        "name": "SpringOS",
        "select_reason": "同为xv6基座，同时支持RISC-V与LoongArch双架构，集成EXT4文件系统，具备完整信号处理，与tmtos在架构和文件系统选择上高度一致，适合直接对比双架构实现深度与测试覆盖。"
    },
    {
        "id": 34,
        "name": "BugOS",
        "select_reason": "同基于xv6且采用lwext4实现EXT4，扩展60余个Linux兼容系统调用，实现POSIX信号处理，与tmtos技术栈重叠度高，可对比在单架构下系统调用扩展与文件系统集成的实现差异。"
    },
    {
        "id": 61,
        "name": "Re-XVapor",
        "select_reason": "同基于xv6并移植lwext4实现EXT4，支持RISC-V与LoongArch双架构，提供动态链接加载与Futex机制，适合对比双架构EXT4集成、动态加载及IPC实现的异同。"
    },
    {
        "id": 38,
        "name": "HatOS",
        "select_reason": "同基于xv6，支持ext4与FAT32双文件系统，实现了写时复制与动态链接ELF加载，内存管理策略与tmtos的全量拷贝形成技术路线对比，可评估COW取舍的实际影响。"
    },
    {
        "id": 67,
        "name": "AddddOS",
        "select_reason": "同基于xv6，支持RISC-V与LoongArch双架构，集成EXT4并扩展80余个系统调用，可在双架构实现完整性、物理内存管理优化（伙伴系统）等方面与tmtos进行横向比较。"
    }
]
```