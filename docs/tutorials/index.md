# Tutorials · 教程概览

本目录按实际操作旅程拆分为五个独立专题，覆盖从首次安装、准备模拟器/桌面驱动、启停工作区，到编写自适应代码与调试验证的完整流程。

## 五步上手路径

| 阶段 | 专题文档 | 解决什么问题 | 核心命令 / 入口 |
| --- | --- | --- | --- |
| **1. 安装与启停** | [**安装与工作区启停**](quickstart.md) | 装好五组件依赖、选定 `RSA_PYTHON`、用 `rsa init / up / auto / down` 跑起一个工作区 | `rsa init` · `rsa up` · `rsa auto on` · `rsa down` |
| **2. 设备准备** | [**设备与驱动准备**](devices.md) | 编译或配置 mGBA、Ryubing、Azahar、Cua 桌面驱动，或接入外部驱动包 | `dofile(...)` · `build.sh` · `launch.sh` · `baseware driver discover` |
| **3. 能力与留档** | [**工作区与能力编程**](workspace.md) | 理解工作区文件布局，声明 `@capability` 与 `@record`，调用设备与本地 Python 能力 | `rsa controller` · `rsa_tools.Client` · `.rsa/timeline/` |
| **4. 感知与动作** | [**常驻感知与动作循环**](perception-and-action.md) | 编写 30Hz 常驻 `perception.py` 与 `action.py`，查询历史时空轴并管理自动注入与录像参数 | `rsa perception reload` · `rsa observe` · `rsa action reload` |
| **5. 调试与验证** | [**控制台调试与验证**](debugging-and-verification.md) | 前台单组件联调、使用 Dashboard 与 Ludens Pet 桌宠、查阅脚本命名约定、运行离线与实机测试 | `baseware serve` · `rsa run` · `http://127.0.0.1:3015` |

## 关联参考

- 需要了解系统五组件边界、Shiori 控制周期与 OMP 会话装配，见 [架构与边界](../reference/architecture.md)。
- 需要查阅设备工具 schema、控制权租约与驱动包协议，见 [Baseware 设计理念与能力契约](../reference/baseware.md) 与 [Driver Bridge 协议](../reference/driver-bridge-protocol.md)。
- 需要排查运行事件、模型输入收据或 Dashboard 索引机制，见 [日志与调用链](../reference/logging.md)。
- 需要运行或编写 Harbor 评测任务，见 [Benchmark](../reference/benchmark.md)。
