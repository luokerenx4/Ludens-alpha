# 开发约定

- `baseware/` 是独立设备服务、driver、CLI/API/MCP；`rsa/` 是 Harness、Shiori 和工作区能力；`rsa-dashboard/` 是日志 API 与统一运行 / Benchmark / Alice 界面；`rsa-companion/` 是加载同一界面的 Electron 壳与原生 Pet。不要另建一套桌面主 UI。Shiori 是 Agent Loop 内核的语义名称，当前实现为 OMP，代码仍在 `rsa/src/harness/omp/`。
- 日志来源按职责标注 source.component，实现/版本独立标注；转发保留 origin，跨进程调用传 traceId/spanId/parentSpanId。Shiori 复用 OMP 原生 telemetry，分析与 UI 消费已有事实；不要把调用成功当任务成功。契约见 `rsa/docs/logging.md`。
- Harness 通过 Baseware 客户端发现和调用 Sensor / Controller，不导入具体 driver。设备协议与输入仲裁留在 Baseware；RSA 用 `rsa controller` / `rsa_tools.Client` 统一访问原始设备和工作区 Python 装饰器能力，按需查询，不自动注册为 OMP 工具。MCP 不默认注入。
- 各组件独立安装和验证，使用各自锁文件。运行数据和任务 workspace 不进仓库。
- 工作区由模型生成的 skill / memory 不手工整理，不注入游戏攻略。
- 默认验证使用离线测试。真实设备测试、接管和进程重启会影响正在运行的游戏，按当前任务授权操作。
- 架构边界清楚、实现简单；不要为目录整理引入额外兼容层或构建框架。
- 独立改动完成并通过相关验证后及时提交；提交前检查文件范围与大小，保持运行数据、本机配置和凭据在仓库外。
- 启动任务先进入目标 workspace：`rsa init` 生成 `rsa.json`，`rsa up --dry-run` 核对计划，`rsa up` 启动，`rsa services` 检查，再按授权 `rsa auto on`。`rsa auto off` 交还控制，`rsa down` 停止本工作区管理的服务；预算、模型或 Host 代码修改使用 `rsa down --keep-emulator` / `rsa up` 保留当前游戏后加载。详见 `rsa/README.md`，不要把开发者运维说明写入游戏 agent 的工作区指令。
