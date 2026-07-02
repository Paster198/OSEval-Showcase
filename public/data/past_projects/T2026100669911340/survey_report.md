## 项目结构分析报告

---

### 一、仓库顶层概览

该仓库名为 **uuOS**，实为一个**双目标项目**：

| 部分 | 目标平台 | 构建产物 | 性质 |
|------|---------|---------|------|
| **src/ + Makefile** | RISC-V 64 / LoongArch 64 (QEMU) | `kernel-rv`, `kernel-la` | OS 内核挑战赛作品 |
| **Syscall/ + start/ + Libary/** | STM32F103C8 (ARM Cortex-M3) | 裸机固件 (.hex/.bin) | 安全 RTOS 固件（原项目） |

二者共享项目名、文档和部分设计理念，但代码层面**完全独立**，通过不同的构建体系编译。根目录 Makefile 仅构建 RISC-V/LoongArch 内核部分；STM32 部分需通过 Keil MDK（`1_test.uvprojx`）构建。

---

### 二、目录树结构

```
uuOS/
├── Makefile                    # 顶层构建：生成 kernel-rv / kernel-la
├── README.md                   # 项目总体说明（侧重 STM32 安全 RTOS）
├── 核心架构.md / 设计.md        # 架构设计文档
├── 1_test.uvprojx              # Keil MDK 工程文件（STM32 固件）
│
├── src/                        # ===== 竞赛内核部分 =====
│   ├── kernel/                 #     平台无关内核代码
│   │   ├── main.c              #       内核主入口 / 启动序列
│   │   ├── uart.c/h            #       UART 串口驱动
│   │   ├── printf.c/h          #       格式化输出
│   │   ├── string.c/h          #       基础字符串操作
│   │   ├── alloc.c/h           #       边界标记内存分配器 (boundary-tag)
│   │   ├── virtio_blk.c/h      #       virtio-blk MMIO 块设备驱动
│   │   ├── ext4.c/h            #       EXT4 只读文件系统
│   │   ├── elf_loader.c/h      #       ELF64 用户程序加载器
│   │   ├── proc.c/h            #       进程管理 + Sv39 页表
│   │   ├── syscall.c/h         #       系统调用分发 (ecall 处理)
│   │   ├── sbi.c/h             #       SBI 接口包装 (关机等)
│   │   ├── test_runner.c/h     #       内核内测试框架
│   │   └── types.h             #       公共类型定义
│   └── arch/
│       ├── riscv/              #     RISC-V 架构相关
│       │   ├── entry.S         #       内核入口汇编 (设置栈, 跳转 main)
│       │   ├── trap_entry.S    #       陷阱入口 / 用户态进出 trampoline
│       │   └── linker.lds      #       链接脚本
│       └── loongarch/          #     LoongArch 架构相关
│           ├── entry.S         #       同上，LoongArch 版本
│           ├── trap_entry.S    #       同上，LoongArch 版本
│           └── linker.lds      #       同上，LoongArch 版本
│
├── Syscall/                    # ===== STM32 安全 RTOS 核心 =====
│   ├── main.c                  #     主程序入口 / 主循环
│   ├── syscall.h               #     SVC 系统调用接口定义
│   ├── sec_core.c/h            #     安全核心 (HMAC-SHA256 / 状态机 / 审计)
│   ├── aes_sw.c/h              #     AES-256 软件实现
│   ├── ch340_comm.c/h          #     帧协议串行通信 (CH340)
│   ├── usb_hid.c/h             #     USB HID 协议栈
│   ├── rgb_led.c/h             #     物理状态指示 LED 驱动
│   ├── stm32f10x_it.c/h        #     中断服务例程 (SVC/PendSV/SysTick)
│   └── stm32f10x_conf.h        #     外设配置头文件
│
├── start/                      # ===== STM32 启动与 CMSIS =====
│   ├── startup_stm32f10x_*.s   #     各型号启动文件 (8 种变体)
│   ├── system_stm32f10x.c/h    #     系统时钟初始化
│   ├── core_cm3.c/h            #     Cortex-M3 内核访问层
│   └── stm32f10x.h             #     寄存器定义头文件
│
├── Libary/                     # ===== STM32 标准外设库 =====
│   ├── stm32f10x_gpio.c/h      #     GPIO 驱动
│   ├── stm32f10x_usart.c/h     #     串口驱动
│   ├── stm32f10x_spi.c/h       #     SPI 驱动
│   ├── stm32f10x_tim.c/h       #     定时器驱动
│   ├── stm32f10x_dma.c/h       #     DMA 驱动
│   ├── stm32f10x_rcc.c/h       #     时钟控制
│   ├── stm32f10x_flash.c/h     #     Flash 操作
│   ├── stm32f10x_exti.c/h      #     外部中断
│   ├── stm32f10x_adc.c/h       #     ADC 驱动
│   ├── stm32f10x_i2c.c/h       #     I2C 驱动
│   ├── stm32f10x_can.c/h       #     CAN 驱动
│   ├── stm32f10x_sdio.c/h      #     SDIO 驱动
│   ├── stm32f10x_fsmc.c/h      #     FSMC 驱动
│   ├── stm32f10x_bkp.c/h       #     备份寄存器
│   ├── stm32f10x_pwr.c/h       #     电源管理
│   ├── stm32f10x_rtc.c/h       #     RTC 驱动
│   ├── stm32f10x_iwdg.c/h      #     独立看门狗
│   ├── stm32f10x_wwdg.c/h      #     窗口看门狗
│   ├── stm32f10x_dac.c/h       #     DAC 驱动
│   ├── stm32f10x_crc.c/h       #     CRC 计算
│   ├── stm32f10x_cec.c/h       #     CEC 驱动
│   ├── stm32f10x_dbgmcu.c/h    #     调试支持
│   └── misc.c/h                #     杂项 NVIC 配置
│
├── Tests/                      # ===== STM32 固件测试 =====
│   ├── test_runner.c/h         #     裸机测试框架 (LED 信号)
│   ├── test_svc.c              #     SVC 系统调用测试 (11 用例)
│   ├── test_crypto.c           #     SHA-256/HMAC/AES 测试 (10 用例)
│   ├── test_protocol.c         #     帧协议编解码测试 (10 用例)
│   ├── test_handshake.c        #     握手协议仿真测试 (10 用例)
│   ├── test_fsm.c              #     状态机铁闸审计测试 (10 用例)
│   └── test_report.md          #     测试报告
│
├── exe/                        # ===== 上位机工具 (PC 端) =====
│   ├── secret_net0/            #     MasterTask.exe (密网任务注入)
│   ├── secret_net1/            #     MasterRecover.exe (密网数据恢复)
│   └── work_net0/              #     Agent.exe (工控数据采集代理)
│
├── 文档管理/                    #     设计文档/图表
├── DebugConfig/                 #     Keil 调试配置
└── .gitignore
```

---

### 三、竞赛内核部分 (src/) 子系统划分

该部分是 OS 内核挑战赛的主体，总计约 **4,648 行**（含架构汇编），由以下子系统构成：

| 子系统 | 核心文件 | 代码量 | 职责 |
|--------|---------|--------|------|
| **启动与引导** | `main.c`, `arch/*/entry.S`, `arch/*/linker.lds` | ~550 行 | 汇编入口、BSS 清零、栈设置、内核主初始化序列 |
| **控制台 I/O** | `uart.c/h`, `printf.c/h`, `string.c/h` | ~435 行 | NS16550A UART 驱动、printf 格式化输出、基础字符串函数 |
| **内存管理** | `alloc.c/h` | ~220 行 | 基于边界标记的物理内存分配器，8MB 静态堆，16 字节对齐 |
| **块设备驱动** | `virtio_blk.c/h` | ~430 行 | virtio-blk MMIO (legacy) 驱动，支持块读写 |
| **文件系统** | `ext4.c/h` | ~812 行 | EXT4 只读文件系统实现，支持超级块/块组描述符/inode/目录遍历/文件读取 |
| **进程管理** | `proc.c/h` | ~425 行 | Sv39 页表管理、用户进程创建、上下文切换、trampoline 调度 |
| **系统调用** | `syscall.c/h` | ~257 行 | ecall 陷阱分发，实现 write/read/exit 等基础调用 |
| **ELF 加载** | `elf_loader.c/h` | ~400 行 | ELF64 程序加载器，解析程序头，加载段到用户地址空间 |
| **平台抽象** | `sbi.c/h` | ~160 行 | SBI 封装（关机等），平台无关接口 |
| **测试框架** | `test_runner.c/h` | ~330 行 | 内核内测试运行器，从 EXT4 加载 .sh 脚本执行测试 |
| **架构相关 (RISC-V)** | `arch/riscv/*` | ~454 行 | 汇编入口、陷阱处理、用户态 trampoline、链接脚本 |
| **架构相关 (LoongArch)** | `arch/loongarch/*` | ~394 行 | 同上，LoongArch 版本 |
| **公共类型** | `types.h` | ~66 行 | 统一类型定义 (`uint64_t` 等) |

---

### 四、构建工具需求

从 Makefile 分析，竞赛内核部分构建需要：

| 工具 | 用途 | 对应环境变量 |
|------|------|-------------|
| `riscv64-linux-gnu-gcc` | RISC-V 内核 C/汇编编译 | `RISCV_CC` |
| `riscv64-linux-gnu-ld` | RISC-V 内核链接 | `RISCV_LD` |
| `riscv64-linux-gnu-objcopy` | (预留) | `RISCV_OBJCOPY` |
| `loongarch64-linux-gnu-gcc` | LoongArch 内核 C/汇编编译 | `LA_CC` |
| `loongarch64-linux-gnu-ld` | LoongArch 内核链接 | `LA_LD` |
| `loongarch64-linux-gnu-objcopy` | (预留) | `LA_OBJCOPY` |
| GNU Make | 构建编排 | — |
| `dd` / `mkfs.ext4` | 可选：制作 disk.img | — |

STM32 固件部分需 Keil MDK (ARMCC/ARMASM) 或可适配的 ARM GCC 工具链。

---

### 五、关键初步观察

1. **双架构支持**：竞赛内核同时支持 RISC-V 64 (rv64imac) 和 LoongArch 64，通过条件编译和独立的架构汇编文件实现。

2. **内核类型**：竞赛内核为**宏内核雏形**（非微内核），所有驱动和子系统编译在同一内核镜像中，具备进程隔离（Sv39 页表 + U-mode）能力。

3. **STM32 部分**：原项目为真正的**安全微内核 RTOS**，利用 ARM MPU 实现硬件飞地隔离，具备 HMAC-SHA256 挑战-应答认证、AES-256 加密、状态机铁闸等安全机制。

4. **代码复用**：两个部分在代码层面完全独立，但 `src/kernel/` 中的某些模块（如 alloc、string）的设计思想可能借鉴了 STM32 版本。

5. **构建目标**：Makefile 只关注生成 `kernel-rv` 和 `kernel-la` 两个 ELF 内核文件，运行于 QEMU 的 virt 平台，依赖 OpenSBI 固件。