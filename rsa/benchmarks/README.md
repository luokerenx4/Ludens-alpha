# RSA Benchmark

Benchmark 是 RSA 的统一评测接口。内置 Harness 工况和 workspace 的 Python 评测共用定义、报告契约、运行日志、比较和看板；评测算法由作者编写。执行记录保存发生过什么，报告保存怎样测量和判断，两者分开。

## 使用

在目标 workspace 中运行：

```sh
rsa bench list
rsa bench help ws-recovery
rsa bench run ws-recovery
rsa bench run perception-lifecycle --repeat 2
rsa bench run capability-reuse --seconds 180 --requests 30
rsa bench run python/benchmarks/clamp.py:evaluate --args '{"samples":1000}'
rsa bench history python/benchmarks/clamp.py:evaluate
rsa bench compare <本次-run-id> <基线-run-id>
rsa bench schema
rsa bench validate report.json
```

目录、帮助、结果和比较输出 JSON。`run` 显式指定一个评测 ID，支持 `--args '<JSON object>'` 和 `--repeat`；批量运行可用普通 shell 循环显式列出 ID。内置工况保留 `--model/--seconds/--requests/--seed` 便捷选项，默认模型 `openai-codex/gpt-6.1-sol`、180 秒、30 次请求和 seed 7。workspace 评测的 `--seconds` 是进程预算，另留 30 秒清理时间，函数参数放在 `--args`。结果进入当前 workspace 的 `logs/`。

执行前通过 `help` 阅读评测范围：`capability-reuse` 会调用在线模型，其他内置工况使用模拟设备或传输。这里没有 `offline/live` 许可或 `--live` 开关。workspace 评测是作者自己的 Python 代码，可以调用设备、访问网络或运行模型；RSA 不把它当成沙盒。设备动作仍须已有 Baseware 控制权，评测不会自动接管或重试动作。条件由作者声明，调用事实由日志记录；没有调用日志不等于没有副作用。

## 编写 workspace 评测

用 `from rsa_tools import benchmark` 标记顶层函数，提供类型标注和 docstring。静态发现不导入代码，规则与 `@capability` 相同；ID 是 `python/<相对文件路径>:<函数名>`。评测不进入 Controller 目录，也不注入 OMP 工具。

```python
from rsa_tools import benchmark, current_benchmark

@benchmark(targets=["python/vision.py:detect"], protocol="1")
def evaluate(dataset: str, checkpoint: str) -> dict:
    """Measure detection accuracy on a labeled dataset."""
    record = current_benchmark()
    record.conditions(dataset=dataset, dataset_revision="v3")
    record.subject("model", path=checkpoint, revision="epoch-12")
    # 自己加载数据、调用能力，计算 accuracy 和 all_detected。
    return {
        "metrics": {
            "accuracy": {"value": accuracy, "unit": "ratio", "direction": "higher"},
            "peak_memory": {"value": None, "unit": "B", "reason": "Not sampled."},
        },
        "checks": {
            "all_detected": {"passed": all_detected, "expected": True, "actual": all_detected},
        },
    }
```

`targets` 可省略或关联多个能力；`title`、`scope` 描述名称和适用范围。`protocol` 是作者维护的评测口径版本，默认 `"1"`：改变数据划分、评分含义或判断标准时更新它；单纯改进被测能力不需要改评测口径。实际评测代码另存 SHA/revision，修改实现不会自动判为不可比。`benchmarks/` 只是建议目录，不是发现条件。

报告只包含 `metrics` 与 `checks`，两者都可省略；`{}` 是合法的无指标报告。每个 key 是稳定指标或检查项 ID，不重复填 `id`：

- metric 要有 `value`（有限数值或 `null`）和非空 `unit`；`label`、`direction`（`higher/lower/none`）、缺测说明 `reason` 可选。缺测用 `null`，不写 0 或 NaN。
- check 只要求 `passed`（`true/false/null`）；`null` 表示证据不足。`label`、`expected`、`actual` 和 `evidenceSeq` 可选；期望值和实际值可以是布尔、数值、对象等 JSON 值。没有 label 时显示 key。
- `evidenceSeq` 若提供，引用本次 `events.jsonl` 中的正整数序号。它不是数据集的帧序号；图像和逐样本结果可保存为附件。

唯一作者契约在 [report.schema.json](report.schema.json)，CLI `schema` 导出同一份 JSON Schema，Python 与 TypeScript 使用它验证完整报告并一次返回各字段问题。`rsa bench validate report.json` 只读数据，不运行评测函数。

完整可执行例子见 [examples/clamp.py](examples/clamp.py)：复制到 workspace 的 `benchmarks/clamp.py` 后即可运行，不依赖模型或设备，包含指标、检查、缺测、条件、源码引用与附件。

直接 import 后调用评测函数，或用 `from rsa_tools.benchmarks import run` 执行 `run(id, arguments)`，都在当前 Python 进程评测并记日志，可复用已加载的模型和状态。直接调用返回原函数结果；报告无效时记录问题并在 stderr 给出修正入口，不因报告格式抛异常重做动作。CLI 每次新开一个 Python 入口。修改代码后，已有进程须重新启动才加载新版本；记录保留实际加载版本的身份。纯本地评测无需启动 RSA Host 或 Baseware。

条件和产物通过 context 登记，不混入返回报告：

```python
record = current_benchmark()  # 只能在评测内使用
record.conditions(camera="top", dataset_revision="v3")
record.subject("model", path="weights.pt", revision="epoch-12")
record.artifact("errors.png", label="Error examples")
record.limitations("Only daylight samples were measured.")
seq = record.record("sample_verified", {"frame": 42})
# 返回检查项时可以用 evidenceSeq=[seq] 引用这个事件。
```

`artifact` 将工作区文件归档到本次运行并记录 hash；也可直接生成 `record.run_dir / "artifacts" / ...` 后登记。后续覆盖工作文件不会改变附件。`subject` 记录被测对象引用，不复制整个数据集或模型；作者应声明版本或 SHA。模型在内存中继续训练时，要声明被测时刻的版本，不从文件名猜测状态。

## 执行、报告与修正

每次评测有独立的 `workspace/logs/<run-id>/`：

```text
manifest.json       # 工作区、评测定义及关联
benchmark.json      # schema v3：执行事实、参数、条件、对象与附件
reports/<id>.raw.json # 验证前先保存原始返回；不能表示为 JSON 时保留 rawText
reports/<id>.json   # 不可变报告：原始返回、验证问题、规范化测量、口径与修正关系
events.jsonl        # 生命周期、source、origin 和 trace
artifacts/          # 本次评测产物
```

内置工况的隔离工作区位于本次运行内，成绩仍归调用方 workspace。Agent 发起评测时保留 `parentRunId` 与调用链。Python SDK 在本地写开始记录，Host 不在线也可使用；内部能力调用可同时进入评测与父 Host 日志，保留同一 origin，不另算一次调用或评测。

函数正常返回后先归档原始报告再验证，报告格式错误不会把已完成的执行变成失败。执行有 `running/completed/error/cancelled`；加载错误保留实际 `ImportError` 等信息，运行异常保留原异常。没有终态的记录仍是未完成，硬杀进程不伪造正常结束。

报告通过验证后才有规范化指标与检查；`verdict` 来自 checks：`passed/failed/inconclusive`，没有 checks 为 `null`。检查未通过是一次已完成的评测。报告缺失或无效则显示待补充/修正，不能用空指标装成一次成功。CLI `run` 退出码 0 表示完成且报告有效、没有失败/待定检查，1 表示执行异常/取消或检查失败/待定，2 表示执行完成但报告待补充/修正。非零返回不能直接理解为需要重跑动作。

动作已经做完，只是报告字段有误时，读取本次保存的原报告、附件和日志，修正一份 JSON，再提交：

```sh
rsa bench validate corrected.json
rsa bench report <run-id> --file corrected.json --reason "Correct numeric check values"
# 评分规则改变时显式声明新的口径
rsa bench report <run-id> --file rescored.json --protocol 2 --reason "Re-evaluate saved samples"
rsa bench compare <run-id>@<report-id> <baseline-run-id>@<baseline-report-id>
```

`report` 只保存新报告，不导入评测代码、不调用设备、不改参数或原执行状态。报告保留前一版本和修正理由；修十次仍是一次试验。对异常执行补报告也不能把它改成正常完成。只有需要新测量时才再次 `run`。

`history` 按运行列出，默认展示最新报告；比较和分享可固定到 `<run-id>@<report-id>`。看板同样区分执行、报告与判定，旧报告不会被新修正覆盖。schema v3 是当前契约；旧文件不在读取时自动改写。

## 比较

同一评测 ID、口径、参数与 conditions 下才标为可比；实际源码 revision 和 subjects 的变化作为改进对象保留。只有同 ID、单位与方向的指标才计算差值。条件变化时仍可查看两份报告，但不能直接把差值解释为能力提高。同一次执行的两个报告会明确标注，不能算成两次独立试验。

Dashboard 的 **Benchmark → 评测目录** 列出内置和 workspace 评测，可查看历史、报告错误、具体报告版本、基线和证据，并跳转原运行。网页与 Electron 使用同一视图；运行与报告提交由 CLI 或 Python 发起，看板只读。

## 内置 Harness 工况

这些工况用于重复核查系统路径。离线工况在真实实现上注入本地条件；能力复用工况使用真实模型探索独立图像环境。

| Case | 检查 | 范围与限制 |
| --- | --- | --- |
| `perception-lifecycle` | 空实现自举、进程内缓存、helper/权重显式 reload、失败修复和不可变结果归档 | 真实 Python 感知进程，合成模型文件与媒体；不运行 PyTorch、设备或在线模型 |
| `control-handoff` | 原始 driver / 嵌套 Python 长动作中断，输入释放，旧 epoch 拒绝 | 真实 Runtime、socket、Baseware 和 Python；模拟可中断设备，释放延迟不是模拟器性能 |
| `ws-recovery` v2 | Besiege 6h 连接到期与 Mario Maker 8h 响应中关闭 1012，分别验证 SSE 冷却 → WS 全历史恢复 → delta、已交付工具不重放 | 生产故障驱动的 TDD 特例；真实 OMP provider，模拟 WS/HTTP，虚拟推进冷却时间；只测本地处理开销 |
| `background-compaction` | 后台候选复用、尾部保留、晚到归属、取消后不提交 | 真实 OMP maintenance / V2；注入接近阈值的 token 计数和受控 SSE，不下调生产阈值 |
| `capability-reuse` v3 | 两批订单完成、自主创建 Python 函数、跨批次实际复用 | 真实模型、空感知入口与 PNG 传感器；允许直接 import 或统一接口调用，不代表长期泛化 |

模型工况沿用 OMP 原生系统提示词和 RSA 工作区 `AGENTS.md` 模板、Low、WS auto、Infinity 图片预算和 256000 原生压缩阈值；每次新建 OMP session，skills、memory 为空，不携带游戏经验或预填解法。

v3 从空的感知实现开始，Agent 自行用设备采样，并可实现 `perception.py`；不预填默认截图。此前 v2 使用预填采样，两版成绩不视为相同条件。

装配台只有 `set` 与 `submit` 两种最小操作。Agent 自己观察目标、发现接口、决定是否写 Python。复用要求同一个自主创建的函数在不同批次、不同模型轮次中成功使用，并有设备调用完成订单的证据。普通函数即可，不要求装饰器或事先查询目录。接口选择只作诊断，不决定是否学会。

统一接口使用原 capability / Baseware 调用链。直接 import 则联合成功写入的源码 payload、执行命令 AST、成功 `exec_result` 与同 exec 下的设备订单判定；只 import 未调用、空函数或无关 helper 加手动操作不能计入。该静态识别不执行 Agent 脚本，也不覆盖任意 Python 控制流、依赖副作用或 write 后全部编辑历史；复杂情况保留待定，须核对原日志。结束后的 AST 盘点只证明文件存在。脚本数量、Agent 自述和文件体积不等于学会。

旧 v1 曾要求统一接口调用，误将跨两批直接 import、完成 6/6 订单的结果判为 failed。v2 更正此口径；旧结果保留，重评须注明原日志与新判定版本，不冒充新一轮模型运行。故障工况中的预期错误，也不能直接当成真实游戏故障率。

## 开发与验证

内置元数据在 `cases.json`，实现为 `src/benchmark/cases/*.ts` 的 `run(ctx)`，返回同一份作者报告；条件、被测对象、产物和限制写入 `ctx.metadata`。各 case 在 finally 清理服务；独立 worker 隔离故障注入的全局状态。语义或判定变化时提升 `cases.json` 的 version，它作为评测口径 `protocolVersion`。新增 workspace 评测不需要修改 Harness、Baseware 或 OMP。

```sh
bun test tests/benchmark-*.test.ts
bun run check
```

默认验证离线，不调用付费模型或当前设备。
