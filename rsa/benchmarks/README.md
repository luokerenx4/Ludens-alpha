# Harness benchmarks

这四个 case 验证当前 Harness 的关键路径。前三个在真实实现上注入本地故障，第四个使用真实模型探索一个独立的图像环境。它们不操作正在运行的游戏。

```sh
rsa bench list
rsa bench run all                    # 运行三个离线 case；模型 case 记为 skipped
rsa bench run all --repeat 2         # 生成两组独立结果，供看板比较
rsa bench run capability-reuse --live --seconds 180 --requests 30
```

`--seed` 默认 7，`--model` 默认 `openai-codex/gpt-6.1-sol`，`--output` 可指定结果根目录。模型 case 沿用标准 RSA prompt、Low、WS auto、Infinity 图片预算和 256000 原生压缩阈值。每次都创建新的 workspace / OMP session，初始 skills、memory 为空，不携带游戏经验。没有手工填入解法、能力脚本或技能。

| Case | 检查 | 范围与限制 |
| --- | --- | --- |
| `control-handoff` | 原始 driver / 嵌套 Python 长动作中断，输入释放，旧 epoch 拒绝 | 真实 Runtime、socket、Baseware 和 Python；模拟可中断设备，释放延迟不是模拟器性能 |
| `ws-recovery` | 到期 → SSE 冷却 → WS 全历史恢复 → delta，已交付工具不重放 | 真实 OMP provider；模拟 WS/HTTP，并虚拟推进冷却时间，不测在线网络性能 |
| `background-compaction` | 后台候选复用、尾部保留、晚到归属、取消后不提交 | 真实 OMP maintenance / V2；注入接近阈值的 token 计数和受控 SSE，不下调生产阈值 |
| `capability-reuse` | 两批订单完成、新能力创建、主动发现、跨批次实际复用 | 真实模型与 PNG 传感器；短时同会话学习，不代表长期泛化 |

模型 case 的装配台只有 `set` 与 `submit` 两种最小操作。Agent 自己观察目标、发现接口、决定是否写 Python。复用必须同时有成功的新能力调用、不同模型轮次、不同批次，以及其后代设备调用完成订单的证据。结束后的独立 AST 盘点可证明能力创建，但不能算 Agent 主动发现；直接 import helper 也不冒充统一能力接口调用。空函数、无关调用、脚本数量和 Agent 自述不算学会。手动做完任务但未沉淀能力，会出现任务通过、复用失败的结果。

## 结果与看板

结果默认存于仓库外的 `artifacts/rsa/benchmarks/<case-run>/workspace/logs/<run-id>/`，与普通 workspace 一样在现有目录索引登记。日志仍使用 schema v2 的 `events.jsonl`、payload/stream sidecar、source 和 trace；评测自身事件的 `source.component` 为 `benchmark`。

`benchmark.json` 是结果摘要：case/version、模式、参数、代码/prompt provenance、checks、metrics、limitations。每项 check 保留 expected / actual / evidenceSeq，可回到原事件。大请求体不复制到结果文件。过程异常或超时保留 `error` 结果和 worker 日志；每次运行追加新目录。

看板的 **Benchmark → 基准用例** 展示所有 indexed workspace 的基准结果，不受游戏 workspace 筛选影响。可以选择历史结果、同 case/version/mode 基线、查看检查证据、跳转原运行。模型、seed 或预算不同时会提示；粗略比较足够，不能据此声称因果改进。运行仍由 CLI 显式发起，看板只读。

- `passed`：全部检查通过。
- `failed`：至少一项检查失败，包含模型没完成任务/没复用能力的正常评测结果。
- `inconclusive`：关键证据缺失或没有可判定检查。
- `error`：用例基础设施异常或进程超时。
- `skipped`：未启用 `--live`，没有测试模型 case。

退出码 0 表示本次只有通过或跳过；出现 failed/inconclusive/error 为 1。WS 无重放场景和压缩取消场景包含预期错误事件，应按 case 检查项解释，不能直接算成真实游戏故障率。

## 增加或修改 case

用例目录是 `src/benchmark/cases/`，共同契约见 `src/benchmark/types.ts`，元数据唯一来源为 `cases.json`。case 实现 `run(ctx)` 并在 finally 清理服务；runner 给每个 case 一个独立进程，避免故障注入的全局状态污染其他运行。语义或判定变化时提升 case version。保留真实路径和少量有意义的负例，不为生成成绩向 Agent 注入方案。

离线验证：

```sh
bun test tests/benchmark-*.test.ts
bun run check
```
