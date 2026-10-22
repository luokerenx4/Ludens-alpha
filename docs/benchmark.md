# Benchmark

内置工况与 workspace 评测共用定义、执行、报告、日志和看板。**执行记录事实，报告给出测量与判定；修报告不重跑动作。**

## 运行与编写

在目标 workspace 执行，参数见 `rsa bench --help`：

```sh
rsa bench list
rsa bench help ws-recovery
rsa bench run ws-recovery
rsa bench run python/benchmarks/clamp.py:evaluate --args '{"samples":1000}' --repeat 2
rsa bench history
rsa bench schema
rsa bench validate report.json
```

输出 JSON，结果在 `workspace/logs/`。run 指定一个 ID，批量用 shell 循环。内置支持 model/seconds/requests/seed，默认 `openai-codex/gpt-6.1-sol`、180 秒、30 请求、seed 7。workspace 的 seconds 是进程预算，另留 30 秒清理，函数参数放 args。

**先读 help 确认副作用**：capability-reuse 调用在线模型，其余内置使用模拟设备/传输。无 offline/live 许可开关；workspace 评测是普通 Python，可访问网络、设备、模型，不是沙盒。设备仍需既有控制权，评测不自动接管或重试动作。

`@benchmark` 标记有类型标注/docstring 的顶层函数。静态发现不导入代码；ID 为 `python/<相对路径>:<函数名>`，不进入 Controller/OMP 工具。benchmarks/ 是建议目录。

```python
from rsa_tools import benchmark, current_benchmark

@benchmark(targets=["python/vision.py:detect"], protocol="1")
def evaluate(dataset: str, checkpoint: str) -> dict:
    """Measure detection on a labeled dataset."""
    record = current_benchmark()
    record.conditions(dataset=dataset, dataset_revision="v3")
    record.subject("model", path=checkpoint, revision="epoch-12")
    # 自己采集/读取数据、调用能力并计算 accuracy 和 usable。
    return {
        "metrics": {
            "accuracy": {"value": accuracy, "unit": "ratio", "direction": "higher"},
            "peak_memory": {"value": None, "unit": "B", "reason": "Not sampled."},
        },
        "checks": {"usable": {"passed": usable, "expected": True, "actual": usable}},
    }
```

targets 可省略或关联多个能力，title/scope 描述名称/范围。protocol 默认 `"1"`，改数据划分、评分或判定时更新；源码 SHA/revision 独立记录，实现修改不自动改变口径。

报告唯一作者契约是 [report.schema.json](../rsa/benchmarks/report.schema.json)，Python、TypeScript 和 `rsa bench schema/validate` 使用同一份：

| 字段 | 要求 |
| --- | --- |
| metrics | 可选 map，key 是稳定 ID；value 为有限数值或 null，unit 非空；label、direction（higher/lower/none）、reason 可选 |
| checks | 可选 map，key 是稳定 ID；passed 为 true/false/null；label、expected、actual、evidenceSeq 可选 |

expected/actual 可用任意 JSON 值，null 表示缺测/证据不足，不用 0/NaN 冒充。evidenceSeq 引用本次事件正整数序号，不是帧号。`{}` 合法但不证明任务成功。完整例子见 [clamp.py](../rsa/benchmarks/examples/clamp.py)。

直接 import 或 `rsa_tools.benchmarks.run(id, arguments)` 在**当前进程**执行、记日志并返回原结果，复用模型；格式问题只记诊断，不抛异常重做动作。CLI 每次独立入口；已有进程需重启才加载改动，记录实际版本。纯本地评测不依赖 Host/Baseware。

## 条件、对象和附件

元数据在 `current_benchmark()` 登记：

```python
record.conditions(camera="top", dataset_revision="v3")
record.subject("model", path="weights.pt", revision="epoch-12")
record.artifact("errors.png", label="Error examples")
record.limitations("Only daylight samples were measured.")
seq = record.record("sample_verified", {"frame": 42})
```

conditions 描述比较条件；subject 引用对象、不复制模型/数据集，应声明版本/SHA，包括内存训练时的被测版本。artifact 归档并记 hash，原文件覆盖不影响附件；可在 `record.run_dir / "artifacts"` 生成后登记。条件是作者声明，实际调用看日志；无日志不证明无副作用。

## 执行和版本化报告

```text
workspace/logs/<run-id>/
  manifest.json          工作区、定义和关联
  benchmark.json         schema v3 执行事实、参数、条件、对象、附件
  reports/<id>.raw.json  验证前原始返回，无法表达为 JSON 时保留 rawText
  reports/<id>.json      不可变报告、验证问题、口径和修正关系
  events.jsonl           生命周期及 source/origin/trace
  artifacts/            评测产物
```

执行状态 running/completed/error/cancelled，异常保留 errorPhase 和原错误。函数返回先存报告再验证；报告错误不改 completed。无终态仍未完成，不把硬杀当正常结束。

有效报告才投影指标/checks；completed 且有效才有 verdict（passed/failed/inconclusive），无 checks 为 null。`rsa bench run` 退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成、报告有效，只有指标或全部检查通过 |
| 1 | 执行异常/取消，或检查失败/待定 |
| 2 | 执行完成，报告缺失/无效 |

非零不意味着重跑；字段错误可依据原报告、附件和事件修正：

```sh
rsa bench validate corrected.json
rsa bench report <run-id> --file corrected.json --reason "Correct numeric check values"
rsa bench report <run-id> --file rescored.json --protocol 2 --reason "Re-evaluate saved samples"
rsa bench compare <run-id>@<report-id> <baseline-run-id>@<baseline-report-id>
```

report 只追加报告和 benchmark_report 事件，保留 previousReportId/reason，不导入评测、不调用设备、不改执行。异常补报告仍异常，修十次仍一次试验；新测量才再 run。history 默认最新报告，可固定报告 ID；读取不自动改写旧文件。

Python 本地写生命周期，保留 parentRunId/trace；能力事件可转发父 Host，origin 不变，不重复计数。内置隔离 workspace 在 run 内，成绩归调用方；离线无接管不伪造 control，看板读完整 run。详见 [日志](logging.md)。

## 比较和看板

两次都 completed、报告有效，且 ID/protocol/参数/conditions 相同才可比。revision/subjects 的变化保留；指标 ID/单位/方向相同才算差值。条件不同不直接归因能力提高，同次执行的报告不算独立试验。

Dashboard **Benchmark → 评测目录** 展示定义、历史、报告版本、错误、基线、证据及原运行。网页/Electron 共用只读视图，CLI/Python 发起评测/报告。结构见 [contract.ts](../rsa/src/benchmark/contract.ts)。

## 内置工况与证据边界

| Case | 范围 |
| --- | --- |
| perception-lifecycle v2 | 真实 Python、合成模型/媒体：持续采样、历史查询、reload、修复、不可变归档；不测 PyTorch/设备 |
| control-handoff | 真实 Runtime/Baseware/Python、模拟驱动：中断、释放、旧 epoch 拒绝；不测模拟器性能 |
| ws-recovery v2 | 真实 provider、模拟 WS/HTTP、虚拟时间：SSE 冷却→WS 全量→delta、工具不重放；见 [测试依据](development.md#ws-恢复测试依据) |
| background-compaction | 真实 OMP maintenance/V2、受控 SSE/token：复用、尾部、晚到归属、取消；保持 256k 阈值 |
| capability-reuse v3 | 真实模型、隔离装配台：两批订单、自创函数、跨批复用；不证明长期泛化 |

`capability-reuse` 使用 OMP 原生提示词与 workspace AGENTS 模板、Low、WS auto、Infinity 图片预算、256000 原生压缩阈值；新 session、空 skills/memory、空感知入口，不预填解法。v2 曾预填采样，与 v3 不视为同条件。装配台只有 set/submit，Agent 自己发现接口并决定是否写代码。

复用必须有同一自主函数跨两批、不同模型轮次的成功调用和完成订单证据。普通直接 import、本地 API、controller 均可；装饰器和查询目录不是学习的必要条件。判定实现见 [reuse-evaluator.ts](../rsa/src/benchmark/fixtures/reuse-evaluator.ts)：

- 统一接口及本地装饰器调用依匹配源码版本的成功终态、真实子链和设备订单归因；不重复计入 runner 内部调用。
- 普通 import 联合成功 write 的源码、简单 Python shell 命令 AST、原生 bash `tool_end` 结果 artifact 和同链订单。成功结果可省略 exitCode，后台/服务仅启动成功不算执行完成；旧日志仍识别 exec/exec_result。
- 只 import 未调用、无关 helper 配手动操作、结束后 AST 盘点不证明复用。静态分析不覆盖任意控制流、动态导入、依赖副作用或 write 后全部编辑历史；证据不足为待定，不等于没有学会。
- shell 缺失父工具/模型轮次时不能用时间补因果；跨轮判定可能待定，函数内部真实调用仍可单独查看。

重评旧日志注明新口径和原因，不算新试验。脚本数量、自述、体积不计成绩，注入错误不是真实故障率。

内置定义见 [cases.json](../rsa/benchmarks/cases.json)、实现见 [cases/](../rsa/src/benchmark/cases/)：run(ctx) 返回作者报告，ctx.metadata 存元数据，finally 清理，worker 隔离注入状态。改判定需提升 version（protocolVersion）。workspace 评测无需改 Harness/Baseware/OMP。验证见 [开发文档](development.md)。
