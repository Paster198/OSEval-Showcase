## 项目初步调查结果

---

### 一、项目结构总览

```
.
├── Cargo.toml              # 内核 crate: my-os (RISC-V 64 裸机)
├── build.rs                # 构建脚本: 编译时注入版本信息 + 自动生成 link_app.S
├── Makefile                # 顶层构建: make all → kernel-rv + kernel-la
├── .cargo/config.toml      → cargo-config/config.toml (构建时复制)
├── run_test.sh             # 一键编译+QEMU运行脚本
├── run_debug.sh            # 一键编译+QEMU GDB stub+连接 GDB 脚本
├── debug.gdb               # GDB 调试命令脚本
│
├── src/                    # 内核源码 (RISC-V 64)
│   ├── main.rs             # 内核入口: rust_main
│   ├── entry.asm           # 汇编入口 _start, __alltraps, __restore
│   ├── linker.ld           # 链接脚本 (BASE=0x80200000)
│   ├── lang_items.rs       # #[panic_handler] — 寄存器 dump + 栈回溯
│   ├── sbi.rs              # SBI 封装: console_putchar, shutdown
│   ├── console.rs          # print!/println! 宏 (通过 SBI 输出串口)
│   ├── batch.rs            # 批处理应用管理器
│   ├── link_app.S          # 自动生成: 嵌入用户应用二进制 (.incbin)
│   ├── syscall/
│   │   ├── mod.rs          # 系统调用分发
│   │   ├── fs.rs           # sys_write / sys_read
│   │   └── process.rs      # sys_exit / sys_getpid / sys_yield
│   ├── trap/
│   │   ├── mod.rs          # trap::init (stvec 设置)
│   │   ├── handler.rs      # trap_handler: 异常/ecall 分发
│   │   └── context.rs      # TrapContext 结构体 + app_init
│   └── utils/
│       ├── mod.rs
│       ├── banner.rs       # 内核启动 Banner
│       ├── log.rs          # info!/warn!/error! 彩色日志宏
│       ├── memory.rs       # 内存布局打印
│       └── panic.rs        # Registers 结构体 + print_registers + print_backtrace
│
├── user/                   # 用户态应用程序
│   ├── Cargo.toml          # user-apps crate (含 lib + 4 个 bin)
│   ├── Makefile            # 构建用户应用并生成 .bin
│   ├── cargo-config/       # 用户态编译配置
│   └── src/
│       ├── lib.rs          # user_lib: println!/print!/exit/getpid/yield_
│       ├── syscall.rs      # 用户侧 ecall 封装
│       ├── linker.ld       # 用户程序链接脚本 (BASE=0x80400000)
│       └── bin/
│           ├── 00_hello.rs     # Hello world
│           ├── 01_power.rs     # 3^10 计算
│           ├── 02_write_str.rs # user_lib 集成测试
│           └── 03_fib.rs       # 斐波那契数列
│
├── la-kernel/              # LoongArch 64 存根内核
│   ├── mk_stub.py          # 纯 Python 手写 ELF (无工具链依赖)
│   ├── Cargo.toml          # la-os crate (未实际编译)
│   └── src/
│       ├── main.rs         # 占位: 无限循环
│       └── linker.ld       # LoongArch 链接脚本 (BASE=0x9000000000200000)
│
├── cargo-config/           # 内核编译配置模板
│   └── config.toml
│
├── scripts/
│   ├── gen_link_app.py     # 扫描 .bin → 生成 src/link_app.S
│   └── cleanup-vendor.py   # vendor 目录清理脚本
│
├── vendor/                 # vendored Rust 依赖 (离线编译用, ~45 crate)
│
└── docs/                   # 文档
    ├── design-doc.md       # 设计方案文档
    ├── ch2-teammate-guide.md
    └── superpowers/        # 开发计划与规格 (内部管理用)
```

---

### 二、已实现的子系统

| 子系统 | 关键文件 | 功能概要 |
|--------|---------|---------|
| **启动与初始化** | `entry.asm`, `main.rs`, `linker.ld` | 汇编入口→`rust_main`→BSS清零→内存布局打印→Banner→trap/batch初始化 |
| **SBI 接口** | `sbi.rs` | 封装 OpenSBI `console_putchar` 和 `system_reset` |
| **控制台输出** | `console.rs` | `print!`/`println!` 宏，通过 SBI 逐字节输出到串口 |
| **日志系统** | `utils/log.rs` | `info!`/`warn!`/`error!` 彩色日志宏 (ANSI 转义码) |
| **启动信息** | `utils/banner.rs` | ASCII 艺术 Banner，显示版本/构建时间/Git commit |
| **内存信息** | `utils/memory.rs` | 打印 .text/.rodata/.data/.bss/stack 段地址范围 |
| **Panic 增强** | `lang_items.rs`, `utils/panic.rs` | 捕获全部 31 个 GPR + 4 个 CSR，帧指针链栈回溯 |
| **Trap 管理** | `trap/mod.rs`, `trap/handler.rs`, `trap/context.rs` | RISC-V S-mode trap 处理，stvec 设置，异常/ecall 分发 |
| **上下文切换** | `entry.asm` (`__alltraps`/`__restore`), `trap/context.rs` | U-mode ↔ S-mode 特权级切换，完整寄存器保存/恢复 |
| **系统调用** | `syscall/mod.rs`, `syscall/fs.rs`, `syscall/process.rs` | `write`/`read`/`exit`/`getpid`/`yield` 五个系统调用 |
| **批处理管理** | `batch.rs` | 嵌入多用户程序，顺序加载到 `0x80400000`，fence.i 刷新 I-cache，自动调度 |
| **用户程序库** | `user/src/lib.rs`, `user/src/syscall.rs` | 用户侧 `println!`/`print!`/`exit`/`getpid` 封装 |
| **LoongArch 存根** | `la-kernel/` | 纯 Python 生成最小 LoongArch ELF（占位无限循环），无实际内核功能 |

---

### 三、构建工具需求

| 工具 | 用途 | 使用位置 |
|------|------|---------|
| **Rust 工具链** (rustc/cargo, nightly) | 编译内核与用户程序 | `cargo build` |
| `riscv64gc-unknown-none-elf` target | RISC-V 裸机目标三元组 | `.cargo/config.toml` |
| **rust-objcopy** (cargo-binutils) | ELF→raw binary 脱壳 | `build.rs`, `user/Makefile`, `run_test.sh` |
| **QEMU** (qemu-system-riscv64) | RISC-V 模拟运行 | `run_test.sh`, `run_debug.sh` |
| **OpenSBI** (QEMU 内置) | SBI 固件 (M-mode→S-mode) | QEMU `-kernel` 自动加载 |
| **Python 3** | 生成 link_app.S, 生成 LoongArch stub | `scripts/gen_link_app.py`, `la-kernel/mk_stub.py` |
| **GDB** (riscv64-unknown-elf-gdb 或 gdb-multiarch) | 内核调试 | `run_debug.sh` |
| **Git** | build.rs 获取 commit hash | `build.rs` |
| **GNU Make** | 顶层构建编排 | `Makefile` |
| **chrono** (Rust crate) | build.rs 获取构建时间 | `Cargo.toml` → `[build-dependencies]` |

---

### 四、初步评估摘要

1. **项目性质**: 基于 Rust 的 RISC-V 64 裸机教学内核，参考 rCore-Tutorial-Book v3 实现，定位为"内核实现"竞赛赛道。

2. **已实现链路**: 完整覆盖从 QEMU 启动 (OpenSBI→`_start`→`rust_main`) 到用户程序加载运行的闭环：内核初始化 → Trap 设置 → 批处理加载 → U-mode 执行 → ecall 系统调用 → S-mode 处理 → 应用调度。

3. **代码规模**: 内核约 800 行 Rust + 143 行汇编，结构清晰、模块化程度较好。

4. **当前局限性**:
   - 无页表/虚拟内存（用户程序运行在物理地址 `0x80400000`）
   - 无进程调度（批处理顺序执行，`sys_yield` 为存根）
   - 无文件系统（`sys_read` 为存根，仅支持 stdout 写入）
   - 无中断处理（stvec 仅处理异常，中断直接 panic）
   - LoongArch 仅为占位存根，无实际内核功能
   - 用户程序直接操作物理地址，无地址空间隔离

5. **构建特点**: 采用 vendored 依赖实现离线编译，build.rs 自动扫描用户程序并嵌入内核，Makefile 统一编排 RISC-V 内核和 LoongArch 存根的构建。