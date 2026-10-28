# 开发约定

- 现行文档统一放根目录 `docs/`，组件 README 只作入口；修改契约时同步对应文档，不另写一份重复说明。历史设计在 `docs/history/`，不作为当前接口依据。
- 施工计划走根目录 [PLANS.md](PLANS.md)：施工前在 `plans/` 写计划并用 `[[plans/<name>]]` 双链索引，完成施工后删除计划文件并清除索引，不留已完工 plan。
- 守住 [架构边界](docs/architecture.md)：Baseware 管 driver、设备协议和输入仲裁；RSA 通过客户端发现能力；Shiori 统一运行生命周期，Agent 模式当前使用 OMP。优先用 OMP 原生工具和扩展机制，功能性改动尽量留在我们的代码。Dashboard 是唯一主界面，Electron 复用它。
- [Workspace](docs/workspace.md) 是普通 Coding 工作区。模型自己组织 Python、训练、后台程序和常驻感知；能力不自动塞进 OMP 工具列表。不要把任务知识、屏幕布局或训练框架写进 Harness / driver，也不另包执行服务或沙盒。
- [日志](docs/logging.md) 保留来源和跨进程调用关系；[Benchmark](docs/benchmark.md) 采用 Harbor 任务和评分约定，Shiori 是唯一 runner。直接 import 也算复用，调用成功不等于任务成功，评分修正不重跑动作。
- 各组件使用自己的锁文件，运行数据和任务 workspace 留在仓库外。模型生成的 skill / memory 不手工整理，不注入游戏攻略。
- 按 [开发与运行指南](docs/development.md) 启停和验证。默认做相关离线检查；真实设备接管、重启或在线模型测试按当前任务授权，不影响其他运行。
- 实现保持简单，不为整理引入兼容层或构建框架。独立改动验证后及时提交；提交前检查范围与大小，排除运行数据、本机配置和凭据。
