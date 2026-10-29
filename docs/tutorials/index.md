# Tutorials · 怎么跑起来

本目录面向初次接入或日常实验的操作者，覆盖从本机环境安装、模拟器/桌面驱动准备、工作区启停，到在工作区编写常驻感知与动作程序的完整流程。

## 快速上手路径

| 步骤 | 目标 | 核心命令 / 入口 | 对应章节 |
| --- | --- | --- | --- |
| 1. 安装组件 | 安装五组件依赖并配置 CLI `PATH` 与 OMP 模型凭据 | `bun install` / `uv sync` / `npm ci` / `pnpm build` | [安装](development.md#安装) |
| 2. 准备设备 | 编译或启动目标环境桥（mGBA / Ryubing / Azahar / Cua） | `dofile(...)` / `build.sh` & `launch.sh` / `cua-driver` | [设备准备](development.md#设备准备) |
| 3. 初始化并启动工作区 | 在仓库外创建独立工作区，拉起后台服务并移交控制权 | `rsa init` → `rsa up` → `rsa auto on` | [工作区启动与停止](development.md#工作区启动与停止) |
| 4. 编写感知与动作 | 实现 `perception.py` 与 `action.py`，声明 `@capability` 与 `@record` | `rsa perception reload` / `rsa action reload` / `rsa observe` | [Workspace 与自适应代码](workspace.md) |
| 5. 观测、评测与验证 | 在控制台查看实时调用链与回放，或运行 Harbor 评测任务 | `http://127.0.0.1:3015` / `rsa bench run` | [独立组件与控制台](development.md#独立组件与控制台) · [Benchmark](../reference/benchmark.md) |

## 教程目录

- [**开发与运行**](development.md)：前置依赖、四大内置环境（mGBA / Ryubing / Azahar / Cua）与外部驱动准备、`rsa.json` 配置、工作区启停生命周期、独立组件调试及离线/实机验证。
- [**Workspace 与自适应代码**](workspace.md)：工作区目录契约、`@capability` 与 `@record` 装饰器、统一能力调用入口、`.rsa/timeline/` 时空轴留档、`perception.py` 常驻感知与历史查询、`action.py` 常驻动作及后台程序边界。

## 关联参考

- 需要了解组件边界、Shiori 控制周期与 OMP 会话装配，见 [架构与边界](../reference/architecture.md)。
- 需要查阅设备工具 schema、控制权租约与驱动包协议，见 [Baseware 设计理念与能力契约](../reference/baseware.md) 与 [Driver Bridge 协议](../reference/driver-bridge-protocol.md)。
- 需要排查运行事件、模型输入收据或 Dashboard 索引机制，见 [日志与调用链](../reference/logging.md)。
