# RSA Benchmark

Benchmark 是 RSA 的统一评测接口。内置 Harness 工况和 workspace 的 Python 评测共用目录、参数 schema、结果、日志与看板；执行方式由各自适配器负责。评测算法由作者编写，RSA 不预设游戏评分、训练方法或自动优化循环。

## 使用

在目标 workspace 中运行：

```sh
rsa bench list
rsa bench help ws-recovery
rsa bench run ws-recovery
rsa bench run all --repeat 2
rsa bench run capability-reuse --live --seconds 180 --requests 30
rsa bench help python/benchmarks/clamp.py:evaluate
rsa bench run python/benchmarks/clamp.py:evaluate --args '{"samples":1000}'
rsa bench history python/benchmarks/clamp.py:evaluate
rsa bench compare <本次-run-id> <基线-run-id>
```

`list/help/history/compare` 输出 JSON，`all` 只选择内置 Harness 工况。`run` 支持 `--args '<JSON object>'`、`--repeat` 和 `--live`。内置工况保留 `--model/--seconds/--requests/--seed` 便捷选项，默认模型 `openai-codex/gpt-6.1-sol`、180 秒、30 次请求和 seed 7。workspace 评测的 `--seconds` 是进程运行预算，另留 30 秒清理时间，函数参数放在 `--args`。结果统一进入当前 workspace 的 `logs/`。

标为 `live` 的评测只有显式加 `--live` 才由 CLI 执行，否则记录为 skipped。内置工况使用临时工作区和独立进程，不操作当前游戏；workspace 评测运行作者自己的代码，可能按其实现调用设备。设备操作仍须已有操作权，benchmark 不自动接管或重试动作。

## 编写 workspace 评测

用 `from rsa_tools import benchmark` 标记顶层函数，提供类型标注和 docstring。静态发现不导入代码，规则与 `@capability` 相同；ID 是 `python/<相对文件路径>:<函数名>`。评测不进入 Controller 目录，也不注入 OMP 工具。

```python
from rsa_tools import benchmark

@benchmark(targets=["python/vision.py:detect"])
def evaluate(dataset: str, checkpoint: str) -> dict:
    """Measure detection accuracy on a labeled dataset."""
    # 自己加载数据、调用能力并计算 accuracy。
    return {
        "metrics": [
            {"id": "accuracy", "value": accuracy, "unit": "ratio", "direction": "higher"}
        ],
        "conditions": {"dataset": dataset},
        "subjects": [{"id": "model", "path": checkpoint}],
    }
```

`targets` 可省略，也可关联多个能力或组件；`title`、`scope` 和 `mode="offline" | "live"` 是可选声明。目录 schema 描述 JSON 参数，模型对象、tensor 和辅助函数留在普通 Python 代码里。`benchmarks/` 只是建议目录，不是发现条件。完整可执行的小例子见 [examples/clamp.py](examples/clamp.py)：复制到 workspace 的 `benchmarks/clamp.py` 后即可运行，不依赖模型或设备。

直接 import 后调用评测函数，或者用 `from rsa_tools.benchmarks import run` 再执行 `run(id, arguments)`，都在当前 Python 进程评测并记录结果。直接调用返回原函数结果；可复用进程内已加载的模型和状态。CLI 每次新开一个 Python 入口，多个 CLI 调用不共享内存。修改代码后，已有进程须重新启动才加载新版本；记录使用实际加载版本的身份。

直接调用 `mode="live"` 函数本身就是显式执行，不另加 CLI 的确认开关。纯本地评测无需启动 RSA Host 或 Baseware，结果照常落盘。

返回值可省略 `metrics` 或 `checks`。每项 metric 有稳定 `id`、数值或 `null`、`unit`，可选 `label` 与 `direction`（`higher/lower/none`）。每项 check 有 `id/label/passed/expected/actual/evidenceSeq`；`passed=null` 表示证据不足，`evidenceSeq` 引用本次日志，没有引用时用空数组。不要用零代替缺失数值，也不要用同一个指标 ID 表示不同含义。

需要在执行前登记条件、被测模型或产物时：

```python
from rsa_tools import current_benchmark

record = current_benchmark()             # 只能在评测内使用
record.conditions(dataset_revision="v3")
record.subject("model", path="weights.pt", revision="epoch-12")
plot_path = record.run_dir / "artifacts" / "errors.png"
# 自己将图表写到 plot_path。
record.artifact(plot_path, label="Error examples")
```

`conditions` 记录评测条件；`subjects` 记录被测对象引用，可显式提供 `path/sha256/revision`。返回字典也可包含这些字段以及 `artifacts`、`limitations`。产物写入本次 `run_dir/artifacts/`，避免后续覆盖工作文件改变历史证据。RSA 不扫描并复制整个 workspace，也不自动归档数据集或模型权重；只写路径不会检测文件内容变化，需作者声明版本或 hash。模型在内存中继续训练时，由作者声明被测时刻的版本，不从文件名推测其状态。

## 结果、日志与比较

每次评测有独立的 `workspace/logs/<run-id>/`：

```text
manifest.json       # 工作区、评测定义及关联
benchmark.json      # schema v2 的定义快照、参数、状态、指标和证据
events.jsonl        # schema v2 的事件、source、origin 和 trace
artifacts/          # 本次评测产物
```

内置工况的隔离工作区位于本次运行内，成绩仍归调用方 workspace。正在运行的 Agent 中发起评测时，`parentRunId` 和 trace 保留父运行与调用链。Python SDK 在本地写开始记录并原子更新结果，Host 不在线也可使用。评测生命周期只写本次日志；内部 Python 能力调用可同时记录在评测与父 Host，保留同一 origin，不另算一次调用或评测。

执行状态与判定分开：

| 字段 | 值与含义 |
| --- | --- |
| `status` | `running`、`completed`、`error`、`cancelled`、`skipped` |
| `verdict` | 完成后由 checks 得出 `passed`、`failed`、`inconclusive`；没有 checks 为 `null` |

仅有指标的评测可以正常 completed。断言失败是一次完成的评测，程序异常才是 error。开始后没有终态的记录保留未完成事实；直接进程被硬杀时不能伪造正常结束。CLI 退出码 0 表示完成且没有失败/待定断言，或显式跳过；异常、取消和失败/待定判定为 1。

统一契约与比较规则在 [contract.ts](../src/benchmark/contract.ts)。比较显示定义 revision、模式、参数与 conditions 的差异；subjects 的变化单独展示，便于比较代码或模型改进。只有同 ID、单位与方向的指标才计算差值。条件变化时仍可查看两份结果，但不能把差值直接解释成能力提高。定义和历史成绩各自保留，不用新规则悄悄改写旧成绩。

Dashboard 的 **Benchmark → 评测目录** 动态列出内置和 workspace 评测，可以查看历史、选基线、核对检查证据、跳转原运行。网页与 Electron 使用同一视图；运行由 CLI 或 Python 显式发起，看板只读。旧 schema v1 结果可在 `rsa/` 运行一次 `bun scripts/migrate-benchmarks-v1.ts --root <artifactRoot>`（或 `--workspace <workspace>`）升级：先备份原文件为 `benchmark.v1.json` / `manifest.v1.json`，保留原成绩与导入标记，不重新执行评测；重复运行跳过 schema v2。

## 内置 Harness 工况

这四个工况用于重复核查系统路径。前三个在真实实现上注入本地故障，第四个使用真实模型探索独立图像环境。

| Case | 检查 | 范围与限制 |
| --- | --- | --- |
| `control-handoff` | 原始 driver / 嵌套 Python 长动作中断，输入释放，旧 epoch 拒绝 | 真实 Runtime、socket、Baseware 和 Python；模拟可中断设备，释放延迟不是模拟器性能 |
| `ws-recovery` v2 | Besiege 6h 连接到期与 Mario Maker 8h 响应中关闭 1012，分别验证 SSE 冷却 → WS 全历史恢复 → delta、已交付工具不重放 | 生产故障驱动的 TDD 特例；真实 OMP provider，模拟 WS/HTTP，虚拟推进冷却时间；只测本地处理开销 |
| `background-compaction` | 后台候选复用、尾部保留、晚到归属、取消后不提交 | 真实 OMP maintenance / V2；注入接近阈值的 token 计数和受控 SSE，不下调生产阈值 |
| `capability-reuse` v2 | 两批订单完成、自主创建 Python 函数、跨批次实际复用 | 真实模型与 PNG 传感器；允许直接 import 或统一接口调用，不代表长期泛化 |

模型工况沿用标准 RSA prompt、Low、WS auto、Infinity 图片预算和 256000 原生压缩阈值；每次新建 OMP session，skills、memory 为空，不携带游戏经验或预填解法。

装配台只有 `set` 与 `submit` 两种最小操作。Agent 自己观察目标、发现接口、决定是否写 Python。复用要求同一个自主创建的函数在不同批次、不同模型轮次中成功使用，并有设备调用完成订单的证据。普通函数即可，不要求装饰器或事先查询目录。接口选择只作诊断，不决定是否学会。

统一接口使用原 capability / Baseware 调用链。直接 import 则联合成功写入的源码 payload、执行命令 AST、成功 `exec_result` 与同 exec 下的设备订单判定；只 import 未调用、空函数或无关 helper 加手动操作不能计入。该静态识别不执行 Agent 脚本，也不覆盖任意 Python 控制流、依赖副作用或 write 后全部编辑历史；复杂情况保留待定，须核对原日志。结束后的 AST 盘点只证明文件存在。脚本数量、Agent 自述和文件体积不等于学会。

旧 v1 曾要求统一接口调用，误将跨两批直接 import、完成 6/6 订单的结果判为 failed。v2 更正此口径；旧结果保留，重评须注明原日志与新判定版本，不冒充新一轮模型运行。故障工况中的预期错误，也不能直接当成真实游戏故障率。

## 开发与验证

内置元数据在 `cases.json`，实现为 `src/benchmark/cases/*.ts` 的 `run(ctx)`。各 case 在 finally 清理服务；独立 worker 隔离故障注入的全局状态。语义或判定变化时提升版本。新增 workspace 评测不需要修改 Harness、Baseware 或 OMP。

```sh
bun test tests/benchmark-*.test.ts
bun run check
```

默认验证离线，不调用付费模型或当前设备。
