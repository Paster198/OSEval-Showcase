```json
[
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "PwnMyOS 的直接前身项目，同样基于 rCore 与 polyhal 实现 RISC-V/LoongArch 双架构支持，并通过 lwext4 集成 ext4。两者在技术栈、系统调用范围和设计理念上一脉相承，是观察演进与改进的理想基线。"
  },
  {
    "id": 35,
    "name": "TrustOS",
    "select_reason": "同为 rCore 生态的 Rust 宏内核，均使用 lwext4 实现 ext4 文件系统并提供百余个 POSIX 系统调用，在信号、共享内存等 IPC 机制上与 PwnMyOS 高度重叠，适合比较文件系统集成深度与兼容性策略。"
  },
  {
    "id": 23,
    "name": "ChaOS",
    "select_reason": "同为 rCore 衍生、Rust 语言、支持 ext4 的宏内核，但 ChaOS 面向多平台（含真机），其 TCB 统一模型和架构抽象与 PwnMyOS 基于 polyhal 的双架构方案可形成互补性对比。"
  },
  {
    "id": 47,
    "name": "REMOS",
    "select_reason": "以 C 语言基于 xv6 移植 lwext4 实现 ext4，与 PwnMyOS 形成语言与生态的鲜明对照。两者均依赖外部 ext4 库，但分别采用 C 与 Rust，可比较安全性、开发效率及移植复杂度差异。"
  },
  {
    "id": 48,
    "name": "WenyiOS",
    "select_reason": "基于 ArceOS 组件化框架的 Rust 宏内核，支持四种架构和百余个系统调用，其模块化、可重用设计理念与 PwnMyOS 基于 rCore 的单体内核路径完全不同，适合进行架构哲学与扩展性方面的对比。"
  }
]
```