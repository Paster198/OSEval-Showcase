```json
[
  {
    "id": 43,
    "name": "Undefined-OS",
    "select_reason": "同基于ArceOS的宏内核，支持四架构，实现了进程组与会话模型、伪文件系统框架，便于对比架构设计与系统调用兼容性。"
  },
  {
    "id": 57,
    "name": "StarryX",
    "select_reason": "同基于ArceOS的四架构宏内核，强调模块化设计与System V IPC，在文件系统与进程模型上与当前项目技术路线接近，具有横向对比价值。"
  },
  {
    "id": 70,
    "name": "AstrancE",
    "select_reason": "同基于ArceOS的四架构宏内核，提供可插拔陷阱处理和动态生成procfs等创新，技术实现策略不同，适合对比架构灵活性。"
  },
  {
    "id": 49,
    "name": "Pantheon OS",
    "select_reason": "采用无栈协程的统一异步调度模型，与当前项目的抢占式线程调度形成鲜明对比，可评估不同并发模型对系统调用兼容性的影响。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "基于Rust异步语法与RCU无锁设计，支持多架构，其异步任务调度和性能优化策略与当前项目形成技术路线互补，具有深度比较价值。"
  }
]
```