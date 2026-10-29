# Reference · 组件与契约

本目录定义 Ludens 的系统架构、进程职责边界、设备控制协议、运行日志归档格式以及 Harbor 评测契约。所有契约均以仓库源码实现为唯一基准。

## 架构分层与参考地图

| 层级 | 核心关注点 | 规范文档 | 权威源码位置 |
| --- | --- | --- | --- |
| **系统拓扑与控制循环** | 五组件边界、Shiori 执行内核、OMP 会话装配、控制权 `epoch` 与跨进程存储归属 | [架构与边界](architecture.md) | `rsa/src/harness/runtime.ts` · `rsa/src/harness/omp/session.ts` |
| **设备服务与能力目录** | CUA 原生工具结构、`ExecutionResult` 信封、`requiresControl` 仲裁、外部驱动包发现与加载 | [Baseware 设计理念与能力契约](baseware.md) | `baseware/src/contracts.ts` · `baseware/src/catalog.ts` |
| **模拟器底层通信** | TCP 单客户端行协议、`HELLO / OWN / APPLY / CAPTURE / TOUCH` 指令集与错误码 | [Driver Bridge 协议](driver-bridge-protocol.md) | `baseware/src/drivers/bridge.ts` · `baseware/src/drivers/*/provider.ts` |
| **可观测性与控制台消费** | `normal / full` 记录模式、`.rsa/timeline/` 与 `.rsa/archive/` 存储、Trace 配对、Dashboard 冷热索引与回放 | [日志与调用链](logging.md) | `rsa/src/harness/events.ts` · `shared/log-archive.ts` · `rsa-dashboard/lib/` |
| **评测与独立评分** | Harbor 1.4 Native Profile、`task.toml / dataset.toml`、`current_trial()`、`reward.json` 与 8 个内置任务 | [Benchmark](benchmark.md) | `rsa/src/benchmark/` · `rsa/benchmarks/` |

## 阅读建议

- **接入新模拟器或硬件驱动**：先读 [Baseware 设计理念与能力契约](baseware.md#driver-包与启动描述)，再对照 [Driver Bridge 协议](driver-bridge-protocol.md) 实现模拟器侧 TCP 桥与 TypeScript Provider。
- **理解 Agent 如何感知环境并下发动作**：阅读 [架构与边界](architecture.md#会话与-loop)、[工作区与能力编程](../tutorials/workspace.md) 与 [常驻感知与动作循环](../tutorials/perception-and-action.md)。
- **消费运行日志、排查模型上下文或修改 Dashboard**：阅读 [日志与调用链](logging.md)。
- **编写新评测任务或复核评分结果**：阅读 [Benchmark](benchmark.md)。
