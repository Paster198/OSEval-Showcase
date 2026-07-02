```json
[
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "同基于ArceOS的宏内核，采用Unikernel部署与AxNamespace进程隔离，独立页表映射信号跳板，与当前项目在架构演进和资源隔离方案上具有直接可比性。"
  },
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "同基于ArceOS的多架构宏内核，额外实现进程级命名空间隔离，与当前项目欠缺的命名空间形成明确对比，可探讨资源隔离深度差异。"
  },
  {
    "id": 46,
    "name": "ChCore",
    "select_reason": "微内核架构，基于能力模型的资源管理与可插拔调度，与当前宏内核形成类型学和调度模型的双重对比。"
  },
  {
    "id": 72,
    "name": "Chronix",
    "select_reason": "纯异步调度宏内核，覆盖约200个系统调用并实现多核负载均衡，其内核异步模型与当前vSched2用户态调度框架构成显著技术路线对照。"
  },
  {
    "id": 5,
    "name": "KeepOnOS",
    "select_reason": "同基于ArceOS的多架构宏内核，支持多种经典调度算法与CPU亲和性，可与当前创新的用户态调度vSched2进行调度机制的直接比较。"
  }
]
```