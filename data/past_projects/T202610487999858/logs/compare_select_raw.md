```json
[
  {
    "id": 54,
    "name": "SC7",
    "select_reason": "同为monolithic/xv6/C的双架构(riscv64+loongarch64)内核，均实现伙伴系统、ext4、POSIX线程与futex，且SC7额外支持写时复制，直接可比。"
  },
  {
    "id": 61,
    "name": "Re-XVapor",
    "select_reason": "同为xv6/C双架构内核，均移植lwext4实现ext4，提供mmap按需调页、ELF动态链接与futex，技术栈高度重叠，适合对比功能完备度。"
  },
  {
    "id": 63,
    "name": "SpringOS",
    "select_reason": "同为xv6/C双架构内核，集成ext4与信号处理并适配真机，可对比其实硬件适配与非对齐访问模拟等差异。"
  },
  {
    "id": 34,
    "name": "BugOS",
    "select_reason": "同为xv6/C生态，也通过lwext4集成ext4并实现信号与六十余系统调用，单架构与小特性集可作为基线对比httos的架构扩展深度。"
  }
]
```