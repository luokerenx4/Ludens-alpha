# 开发约定

- 目前处于开发态，无需也请勿进行任何向下兼容。
- 现行文档按类放在 `docs/tutorials/`（怎么跑）、`docs/reference/`（组件与契约）、`docs/insights/`（为什么这么做）
- 新增或修改 `package.json` 脚本时，遵循 [脚本命名与命令目录](docs/tutorials/development.md#脚本命名与命令目录)，同步调用方与文档。
- 施工计划走根目录 [PLANS.md](PLANS.md)：施工前在 `plans/` 写计划并用 `[[plans/<name>]]` 双链索引，完成施工后删除计划文件并清除索引，不留已完工 plan。
- [Benchmark](docs/reference/benchmark.md) 采用 Harbor 任务和评分约定
- 动手改代码前先同步远程上游（`git fetch` / 变基或合并到最新），避免在过期基线上施工。
- 原则上，任何修改都应该使用 PR 提交而不是直接推 main。
- 开发调试时，无需使用 electron 态，直接使用前端观看即可。

