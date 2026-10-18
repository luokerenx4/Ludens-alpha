# 开发约定

- `rsa/` 是 Harness、能力契约与设备提供者；`rsa-dashboard/` 是日志 API 和看板；`rsa-companion/` 是 Alice Pet。
- Harness 只依赖 Sensor / Controller 契约，具体设备只在 provider 和应用装配层出现。
- 各组件独立安装和验证，使用各自锁文件。运行数据和任务 workspace 不进仓库。
- 工作区由模型生成的 skill / memory 不手工整理，不注入游戏攻略。
- 默认验证使用离线测试。真实设备测试、接管和进程重启会影响正在运行的游戏，按当前任务授权操作。
- 架构边界清楚、实现简单；不要为目录整理引入额外兼容层或构建框架。
- 独立改动完成并通过相关验证后及时提交；提交前检查文件范围与大小，保持运行数据、本机配置和凭据在仓库外。
- 启动任务先进入目标 workspace：`rsa init` 生成 `rsa.json`，`rsa up --dry-run` 核对计划，`rsa up` 启动，`rsa services` 检查，再按授权 `rsa auto on`。`rsa auto off` 交还控制，`rsa down` 停止本工作区管理的服务；预算、模型或 Host 代码修改使用 `rsa down --keep-emulator` / `rsa up` 保留当前游戏后加载。详见 `rsa/README.md`，不要把开发者运维说明写入游戏 agent 的工作区指令。
