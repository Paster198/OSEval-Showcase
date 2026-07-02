```json
[
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "直接基于Re-XVapor代码基线开发，同属xv6生态、C语言、riscv64，实现进程-线程双层模型与lwext4的ext4支持。对比可清晰展现本次参赛在原有基础上的改进、增强与取舍。"
  },
  {
    "id": 45,
    "name": "10183_BOOT",
    "select_reason": "同属xv6+lwext4技术路线，同样实现了线程模型、ext4文件系统与ELF动态链接。横向对比可揭示类似技术方案在架构设计、系统调用兼容性与工程实现上的不同选择。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "基于ArceOS组件化框架与Rust语言，支持四架构的宏内核。与LastWhisper的C/xv6路线形成鲜明对比，可深入分析不同生态、语言安全保障与多架构抽象策略的优劣。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "唯一入选的微内核项目，以能力模型与迁移式通信实现严格资源管理。与LastWhisper的宏内核设计形成根本性架构对比，展示两种内核类型在性能、安全与复杂度上的权衡。"
  },
  {
    "id": 32,
    "name": "MinotaurOS",
    "select_reason": "全异步Rust内核，采用统一事件总线与协程调度，而LastWhisper使用简单轮转调度。二者在调度模型、并发范式及语言安全性上形成强烈反差，有利于展现不同设计理念的影响。"
  }
]
```