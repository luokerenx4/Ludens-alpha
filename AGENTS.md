# 开发约定

- `rsa/` 是 Harness、能力契约与设备提供者；`rsa-dashboard/` 是日志 API 和看板；`rsa-companion/` 是 Alice Pet。
- Harness 只依赖 Sensor / Controller 契约，具体设备只在 provider 和应用装配层出现。
- 各组件独立安装和验证，使用各自锁文件。运行数据和任务 workspace 不进仓库。
- 工作区由模型生成的 skill / memory 不手工整理，不注入游戏攻略。
- 默认验证使用离线测试。真实设备测试、接管和进程重启会影响正在运行的游戏，按当前任务授权操作。
- 架构边界清楚、实现简单；不要为目录整理引入额外兼容层或构建框架。
