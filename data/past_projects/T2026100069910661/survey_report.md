## 项目初步调查报告

### 一、项目概况

该项目名为 **OSKernel2025-X**，托管于 GitLab (gitlab.eduxiji.net)，是一个面向 **RISC-V 64 位** 架构的操作系统内核项目（比赛项目）。当前仓库仅包含一个提交（`91fcafc`，提交信息："能够启动"），项目处于极早期阶段。

---

### 二、文件组织结构

```
/
├── Makefile              # 顶层构建文件（构建、运行、调试目标）
├── include.mk            # 编译工具链与编译选项配置
├── kernel.ld             # RISC-V 链接脚本
├── README.md             # GitLab 默认模板 README（未填写项目信息）
├── include/
│   └── purchar.h         # 字符输出头文件（SBI putchar 封装）
├── kernel/
│   ├── Makefile          # 内核模块构建文件
│   ├── start.S           # RISC-V 汇编启动代码
│   ├── init.c            # 内核主入口（C 语言）
│   ├── start.o           # 已编译的目标文件
│   └── init.o            # 已编译的目标文件
└── target/
    └── mos               # 最终链接生成的 ELF 可执行内核镜像
```

代码总量约 **197 行**（含注释），结构极为精简。

---

### 三、构建工具链

| 用途 | 工具 |
|------|------|
| 交叉编译器 | `riscv64-linux-gnu-gcc` |
| 链接器 | `riscv64-linux-gnu-ld` |
| 模拟器 | `qemu-system-riscv64`（`-machine virt -m 2G -nographic`） |
| 调试器 | `gdb-multiarch`（可选） |
| 构建系统 | GNU Make |
| 固件 | OpenSBI（默认，QEMU 内置） |

编译目标架构为 `rv64imafdc`，内存模型为 `medany`，使用独立环境（`-nostdlib -ffreestanding`）。

---

### 四、子系统分析

#### 4.1 已实现的子系统

| 子系统 | 对应文件 | 实现状态 | 说明 |
|--------|----------|----------|------|
| **启动引导** | `kernel/start.S` | 已实现 | 设置内核栈（4KiB），跳转到 `mips_init` |
| **SBI 控制台输出** | `include/purchar.h` | 已实现 | 通过 `ecall` 调用 SBI `CONSOLE_PUTCHAR`（a7=0x1）输出单个字符 |

当前内核行为：启动后通过 SBI 调用依次输出 `Hello,RISC-V!`，随后进入死循环（`halt()`）。

#### 4.2 规划中（已注释）的子系统

`kernel/init.c` 中包含大量注释代码，揭示了项目的架构规划。这些子系统尚未实现：

| 子系统 | 代码中的线索 | 推测功能 |
|--------|-------------|----------|
| **物理内存检测** | `mips_detect_memory(ram_low_size)` | 探测可用物理内存范围 |
| **虚拟内存管理** | `mips_vm_init()`, `page_init()` | 页表初始化、虚拟内存映射 |
| **进程/环境管理** | `env_init()`, `ENV_CREATE()`, `ENV_CREATE_PRIORITY()` | 进程控制块初始化、进程创建（支持优先级） |
| **进程调度** | `schedule(0)` | 调度器入口 |
| **管道（IPC）** | `user_icode` | 通过管道实现进程间通信 |
| **文件系统** | `fs_serv`, `user_fstest`, `user_devtst` | 文件系统服务进程与测试 |
| **用户程序** | `user_bare_loop`, `user_tltest`, `user_fktest`, `user_pingpong` | 各类用户态测试程序 |

从命名约定（`mips_*`、`ENV_CREATE`、`fs_serv`、`icode`）来看，该项目架构设计参考了经典的 **MOS（MIPS Operating System）** 教学操作系统，正在将其移植到 RISC-V 平台。当前完成度约为引导阶段的 5-10%。

---

### 五、链接脚本关键信息

- **入口点**：`_start`（定义于 `start.S` 的 `.text.boot` 段）
- **基地址**：`0x80200000`（OpenSBI 默认跳转地址）
- **内核结束地址**：`0x80400000`（总空间 2MiB）
- **段布局**：`.text` → `.data` → `.bss`（包含 4KiB 内核栈），均按 4K 对齐

---

### 六、目录与子系统的映射关系

| 目录/文件 | 所属子系统 |
|-----------|-----------|
| `kernel/start.S` | 启动引导 |
| `kernel/init.c` | 内核主入口 + 各子系统初始化框架（规划中） |
| `include/purchar.h` | 控制台 I/O（SBI 封装） |
| `kernel.ld` | 链接/内存布局 |
| `Makefile` + `include.mk` + `kernel/Makefile` | 构建系统 |
| `target/` | 构建产物 |