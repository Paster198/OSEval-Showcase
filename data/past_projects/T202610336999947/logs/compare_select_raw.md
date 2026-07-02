```json
[
  {
    "id": 5,
    "name": "OSKernel2024-KeepOnOS",
    "select_reason": "同为ArceOS基座，是早期代表性参赛项目，率先将组件化Unikernel改造为宏内核，支持三种架构及百余系统调用，与当前基础版对比可揭示ArceOS在兼容层与模块化方面的演进路径。"
  },
  {
    "id": 43,
    "name": "Undefined-OS",
    "select_reason": "同为ArceOS基座，2025年项目，实现进程组与会话层次模型、统一文件描述符抽象、系统调用追踪宏，与当前项目对比可展示如何从基础组件化内核扩展出完整的POSIX进程管理框架。"
  },
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "同为ArceOS基座，强调命名空间机制实现进程级资源隔离、信号处理与IPC共享内存，与当前项目的axns命名空间设计直接对应，可比较资源隔离方案的实现深度与完整性。"
  },
  {
    "id": 53,
    "name": "starry-next",
    "select_reason": "同为ArceOS基座，采用Unikernel部署方式运行宏内核功能，利用AxNamespace实现进程隔离，独立页表映射信号跳板，与当前项目在部署模式、命名空间用法上形成鲜明对比。"
  },
  {
    "id": 70,
    "name": "AstrancE",
    "select_reason": "同为ArceOS基座，基于linkme实现可插拔陷阱处理、支持静态与动态链接ELF加载、基于闭包生成procfs，其陷阱与文件系统实现方式与当前项目的中断处理、procfs模拟有直接可比较性。"
  }
]
```