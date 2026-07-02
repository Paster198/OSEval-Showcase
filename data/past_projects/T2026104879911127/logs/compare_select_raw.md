```json
[
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "同为ArceOS基座的宏内核，技术路线高度一致，很可能是MoonOS的前身或同系列演进版本，适合直接对比架构与功能的迭代。"
  },
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "基于ArceOS实现命名空间隔离机制，而MoonOS缺失命名空间支持，可对比资源隔离设计与多架构适配策略。"
  },
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "较早的ArceOS宏内核项目，支持多种调度算法与处理器亲和性，与MoonOS的单一RR调度形成鲜明对比，可评估调度子系统演进。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "同为Starry系列ArceOS宏内核，实现完整System V IPC（含信号量与消息队列），而MoonOS仅实现共享内存，可比较IPC完备性设计。"
  },
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "基于ArceOS实现分片Futex表以减少锁竞争，MoonOS则采用私有Futex表，可对比同步机制设计与多核并发优化思路。"
  }
]
```