```json
[
   {
      "id": 65,
      "name": "TatlinOS",
      "select_reason": "与当前项目同为纯Rust单体内核、支持riscv64+loongarch64双架构、无外部基座依赖，且实现百余系统调用与COW等高级特性，是横向对比最直接的竞品项目。"
   },
   {
      "id": 56,
      "name": "NoAxiom-OS",
      "select_reason": "同为纯Rust无基座双架构单体内核，但采用无栈协程异步调度，与当前项目EDF同步调度形成鲜明对比，可深入比较两种调度范式的设计权衡与实现复杂度。"
   },
   {
      "id": 72,
      "name": "Chronix",
      "select_reason": "同为双架构Rust单体内核，覆盖约200个系统调用量级与当前项目相当，但基于异步模型设计，对比可揭示同步EDF与全异步路线在系统调用覆盖度、阻塞语义处理上的优劣。"
   },
   {
      "id": 59,
      "name": "KernelX",
      "select_reason": "采用微内核架构且基于RT-Thread生态，与当前项目单体内核零依赖路线构成架构范式对比，可分析两种内核模型在系统调用兼容性、性能隔离方面的差异。"
   },
   {
      "id": 60,
      "name": "SubsToKernel",
      "select_reason": "基于rCore生态构建的双架构Rust内核，与当前项目零基座自研路线形成生态依赖性对比，可评估复用成熟基座对开发效率与系统完整度的影响。"
   }
]
```