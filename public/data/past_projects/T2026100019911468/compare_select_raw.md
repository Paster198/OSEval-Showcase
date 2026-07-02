```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同属xv6生态的C语言monolithic内核，明确支持riscv64与loongarch64双架构，实现完整VFS+ext4、写时复制、伙伴系统等，与当前项目在架构选择和功能集上高度一致，适合对比双架构实现深度与代码质量。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "基于xv6的C语言双架构内核，采用lwext4移植实现ext4、支持mmap按需调页、ELF动态链接和信号机制，与当前项目在ext4只读及Linux兼容层思路上相似，可对比第三方库集成与系统调用兼容策略。"
  },
  {
    "id": 63,
    "name": "SpringOS",
    "select_reason": "同为xv6衍生、C语言且支持riscv/loongarch双架构的内核，具备完整ext4与类Linux信号处理，并适配真机开发板，其龙芯支持更具实质性，可与当前项目浅层LA探针形成鲜明对比，评估真实双架构演进路径。"
  },
  {
    "id": 67,
    "name": "AddddOS",
    "select_reason": "xv6双架构C内核，强调伙伴系统物理内存管理与外部库ext4集成，提供八十余系统调用，与当前项目在系统调用扩展和内存分配器设计上路径相似，适合对比COW缺失情况下的内存管理权衡。"
  },
  {
    "id": 38,
    "name": "HatOS",
    "select_reason": "同是基于xv6的C内核，虽仅支持riscv64，但实现COW、lazy alloc、ext4+FAT32双文件系统、动态链接和完整信号，功能集与当前项目高度重叠，是单架构下功能深度的理想参照系，可突出双架构化的成本与收益。"
  }
]
```