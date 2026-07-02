```json
[
  {
    "id": 65,
    "name": "TatlinOS",
    "select_reason": "同为双架构(RISC-V+LoongArch)的Rust宏内核，均实现懒分配、写时复制、页缓存及百余Linux系统调用，技术路线高度相似，可进行全方位镜像对比。"
  },
  {
    "id": 50,
    "name": "Nonix OS",
    "select_reason": "基于rCore生态且同样使用lwext4_rust实现Ext4文件系统，双架构支持类似，但系统调用数较少(73个)，对比可揭示框架复用与独立开发的选择代价。"
  },
  {
    "id": 66,
    "name": "Explosion OS",
    "select_reason": "同为Rust双架构宏内核，但选择从零自研完整EXT4文件系统，与RespOS依赖外部C库(lwext4)形成鲜明对照，可探讨自研与绑定的设计权衡。"
  },
  {
    "id": 52,
    "name": "Eonix",
    "select_reason": "采用异步语法、RCU和无锁结构，与RespOS的传统同步调度和锁机制迥异，适合对比不同并发模型在宏内核下的适用性与工程复杂度。"
  },
  {
    "id": 64,
    "name": "NPUcore-BLOSSOM",
    "select_reason": "同为Rust双架构宏内核，支持EXT4与FAT32双文件系统、写时复制及信号机制，但文件系统覆盖面更广，可比较文件系统兼容性与实现深度。"
  }
]
```