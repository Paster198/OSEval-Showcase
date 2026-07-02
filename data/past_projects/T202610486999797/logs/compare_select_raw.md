```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同为xv6生态、C语言、支持RISC-V与LoongArch双架构的宏内核，实现了伙伴系统/Slab分配器、VFS与ext4，与AuroraKernel在双架构抽象与内存管理上方向一致，适合比较架构契约与功能深度。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同为xv6生态、C语言、双架构（riscv64/loongarch64）宏内核，实现了Linux风格线程组分离、ext4、mmap按需调页与ELF动态链接，与当前项目在进程模型与ABI兼容性上高度可比。"
  },
  {
    "id": 63,
    "name": "SpringOS",
    "select_reason": "同为xv6生态、C语言、双架构宏内核，适配真机并集成lwext4实现EXT4，具备完整信号处理，与AuroraKernel在双架构设备适配与文件系统集成策略上形成良好对照。"
  },
  {
    "id": 67,
    "name": "AddddOS",
    "select_reason": "同为xv6生态、C语言、双架构宏内核，引入伙伴系统与EXT4，实现80余个系统调用和VFS，是当前项目直接参考的对象之一，比较可揭示设计继承与改进之处。"
  },
  {
    "id": 69,
    "name": "StarryOS",
    "select_reason": "基于ArceOS组件化框架的Rust宏内核，支持四架构，采用Unikernel部署方式，与当前C/xv6的双架构实现形成鲜明技术路线对比，可评估架构抽象与生态选择的优劣。"
  }
]
```