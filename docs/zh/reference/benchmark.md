# Benchmark

Ludens 评测系统遵循 [Harbor Framework](https://github.com/harbor-framework/harbor/tree/f3a5a923f6d722472c9e797af836ae4425fb215f)（固定参考版本 `f3a5a9`，Schema `1.4`）的 Task、Verifier、Reward 与 Dataset 文件约定，并针对本机实验环境实现 `ludens-native` Profile。

核心架构原则是**执行内核唯一与评判解耦**：所有评测任务统一由 **Shiori** 调度执行、管理预算与取消清理；被测程序只负责在运行期产出客观事实（Artifacts），独立的 `tests/test.sh` Verifier 则从已落盘产物计算数值 Reward。重新评分（`verify`）只运行 Verifier，绝不重跑被测程序或模型。

## 入口与运行所有权

### 1. `rsa bench` CLI 命令全集

在目标工作区下执行 `rsa bench --help` 可查看全部子命令：

```sh
# 发现、帮助与静态契约校验
rsa bench list
rsa bench help ludens/ws-recovery
rsa bench schema [task|reward|dataset]
rsa bench validate task /path/to/task
rsa bench validate reward /path/to/verifier-or-reward.json
rsa bench validate dataset /path/to/dataset.toml

# 执行评测与独立重评
rsa bench run ludens/ws-recovery [--config run.json] [--args '{"k":"v"}'] [--seconds 60] [--repeat 3] [--no-verify]
rsa bench verify <run-id> --reason "Regrade fixed measurements"
rsa bench verify <run-id> --task /path/to/updated-task --reason "Updated grading criteria"

# 历史查询、单次详情、版本对比与数据集聚合
rsa bench history [namespace/task] [--limit 20]
rsa bench get <run-id[@verification-id]>
rsa bench verifications <run-id>
rsa bench compare <run-id[@verification-id]> <baseline-run-id[@verification-id]>
rsa bench aggregate <dataset.toml> <run-id-1> <run-id-2> --policy all|graded
```

- **退出码语义**：`rsa bench run` 在执行完成且评分有效（含得分为 `0`）时返回 `0`；被测程序执行失败返回 `1`；执行成功但 Verifier 缺失或评分失败返回 `2`。
- **静态校验**：`schema` 输出内置的 `ludens-native` 契约导引（`guideOnly: true`）；`validate` 使用静态解析器检查文件结构与字段，绝不执行任务代码或 Verifier 脚本。

### 2. 运行配置绑定（Run Bindings）

Harbor 任务包只描述“测什么与怎么判分”，而“运行什么程序”由独立的 JSON 运行配置（Run Binding）声明。系统自动从仓库 `rsa/benchmarks/runs/` 与工作区 `<workspace>/benchmarks/runs/` 扫描配置，并按 JSON 内的 `"task"` 字段关联到对应 Task（若任务仅有唯一绑定则作为默认配置，否则需通过 `--config <path>` 指定）：

```json
{
  "task": "my-org/example",
  "argv": ["{python}", "{workspace}/benchmarks/measure.py", "--out", "{artifacts}"],
  "workspace": "isolated",
  "seconds": 30
}
```

运行配置支持的占位符与执行语义：

| 占位符 / 字段 | 解析值与边界 |
| --- | --- |
| `{rsa}` / `{python}` / `{bun}` | RSA 包根目录（仓库中的 `rsa/`）、选定框架 Python 解释器（`RSA_PYTHON`）与 Bun 可执行文件路径。 |
| `{workspace}` | 作者所在的原工作区绝对路径。 |
| `{workdir}` | 本次试验的实际执行目录（`workspace: "isolated"` 时为每次试验独立创建的隔离目录）。 |
| `{artifacts}` | 本次试验独占的产物输出目录（`logs/<run-id>/artifacts`）。 |
| `{task}` / `{param.<key>}` | 本次固定后的 Task 目录路径，以及默认 `parameters` 与 CLI `--args` 合并后的参数值。 |
| `Shiori 执行模式` | 普通命令运行于 Shiori `program` 模式，不启动模型；需要 Agent 参与的任务（如 `ludens/capability-reuse`）则通过公共 [host.ts](../../rsa/src/harness/host.ts) 挂载完整 OMP、Controller 与感知循环。预算由外层 Runtime 统一计时（含启动耗时），到期后给予最多 2 秒收尾期写出事实。 |

## Task 与 Dataset

### 1. Task 目录结构与内容摘要（Digest）

仓库内置任务位于 `rsa/benchmarks/tasks/`，工作区自定义任务位于 `<workspace>/benchmarks/tasks/`：

```text
benchmarks/tasks/example/
├── task.toml          # Harbor 1.4 任务元数据（必填）
├── instruction.md     # 任务说明与目标（必填）
├── environment/       # 输入材料、固定夹具或依赖声明（必填）
├── tests/
│   ├── test.sh        # 独立评分唯一入口脚本（必填）
│   └── verify.py      # 由 test.sh 调用的具体评分实现（可选，也可用 TS）
└── solution/          # 可选参考解（不作为被测程序运行）
```

最小 `task.toml` 示例：

```toml
schema_version = "1.4"

[task]
name = "my-org/example"
version = "1"
description = "Measure a capability on fixed examples."
```

- **命名与内容寻址固定**：`ludens-native` 要求 `task.name` 必须采用 `org/name` 命名空间格式。Shiori 按 Harbor 发布文件选择规则计算确定性 `sha256:<64位十六进制>` 内容摘要（Digest）：根目录选择 `task.toml`、`instruction.md`、可选 `README.md` 与 `trajectory.json`，再扫描 `environment/`、`tests/`、`solution/`、`steps/` 并应用 `.gitignore` / `.harborignore` 排除规则（见 [task.ts](../../rsa/src/benchmark/task.ts)）。运行前将选定文件快照固定至 `<workspace>/.rsa/benchmarks/tasks/<digest 十六进制部分>/`。
- **执行溯源分离**：被测外部脚本或模型权重不纳入 Task 包摘要，而是由 Shiori 在 `input.json` 与 `manifest.json` 中自动记录 Git commit/dirty 状态、实际 `argv`、预算及模型标识，或由被测程序通过 `current_trial().subject(...)` 显式登记。

### 2. Dataset 清单（`dataset.toml`）

Dataset 采用 Harbor `1.0` 格式，通过任务名与精确的 `sha256` 摘要锁定任务集合（仓库内置清单见 [rsa/benchmarks/dataset.toml](../../rsa/benchmarks/dataset.toml)）：

```toml
schema_version = "1.0"

[dataset]
name = "my-org/suite"
version = "1"

[[tasks]]
name = "my-org/example"
digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

修改任何内置任务文件后，必须同步更新 `dataset.toml` 中对应的 `digest`，系统绝不静默使用摘要不匹配的同名任务。

## Python 辅助登记是可选的

被测 Python 程序只需直接读取环境变量 `RSA_BENCH_ARTIFACTS` 并写入测量文件（如 `measurements.json`）即可完成试验，无需强制导入任何框架包。若需结构化登记实验条件、被测模型版本或自动收集进程内 `@capability` 调用统计，可选用 `rsa_tools.current_trial()`（完整示例见 [clamp.py](../../rsa/benchmarks/examples/clamp.py)）：

```python
from rsa_tools import current_trial

trial = current_trial()  # 读取 RSA_BENCH_* 环境变量；非 Shiori 试验环境调用会直接报错
trial.conditions(dataset_revision="v3", seed=7)
trial.subject("model", path="weights.pt", revision="epoch-12")
samples = measure(already_loaded_model, dataset)
trial.artifact("measurements.json", samples)
trial.limitations("Only daylight samples were measured.")
trial.flush()
```

- **职责边界**：`current_trial()` 仅负责在产物目录生成 `artifacts/context.json`（含 `conditions`、`subjects`、`artifacts`、`limitations` 以及本地 observer 捕获的进程内 `@capability` 调用次数与 `codeSHA`），不接管设备、不写 Shiori 事件流。
- **产物与媒体引用**：`trial.artifact("name.json", value)` 写入新 JSON 文件（禁止覆盖同名文件）；`trial.artifact(external_path)` 按内容哈希复制外部文件；对于已录制的 `.rsa/timeline/` 媒体，传入 `trial.artifact(media)` 即可核验并登记原件引用与视频 PTS，无需重复复制图片或视频字节。

## 事实、评分与重评

### 1. Verifier 环境变量与 `reward.json` 契约

Shiori 在启动 `tests/test.sh` 时清理实时设备 socket、控制 `epoch` 与模型凭据环境变量，并注入以下四个路径变量。Native Profile 运行普通本机进程；`isolated` 仅分配独立执行目录，环境变量清理不提供文件系统或网络隔离。

| 环境变量 | 指向路径与用途 |
| --- | --- |
| `RSA_BENCH_TASK_DIR` | 本次评分使用的固定任务包目录（`.rsa/benchmarks/tasks/<digest 十六进制部分>/`）。 |
| `RSA_BENCH_INPUT` | 本次评分输入清单 JSON（含 trial 元数据与证据路径引用）。 |
| `RSA_BENCH_ARTIFACTS` | 被测程序产出的 `logs/<run-id>/artifacts/` 目录，供评分器读取事实；不施加文件系统只读权限。 |
| `RSA_BENCH_VERIFIER_DIR` | 本次评分独占的输出目录（`logs/<run-id>/verifier/<verification-id>/`）。 |

`tests/test.sh` 将最终数值评分写入 `$RSA_BENCH_VERIFIER_DIR/reward.json`（可选将详细诊断写入同目录的 `details.json`）：

```json
{"accuracy": 0.94, "latency_ms": 12.3, "success": 1}
```

- **扁平有限数值映射**：`reward.json` 必须是扁平的 `Record<string, number>`，所有值均为有限数字（`finite number`，不限制在 `0..1` 区间，也不预设统一的 `passed` 字段）；空对象可解析，但没有提供任何得分维度，不能据此判定任务成功。可读取单值 `reward.txt`，但当 `reward.json` 存在时以 JSON 为准。
- **缺失维度处理**：无法测量的指标维度应直接从对象中省略并在 `details.json` 说明原因，严禁写入 `null`、`NaN` 或用假 `0` 填充。当整个 Verifier 失败或未产出合法文件时，投影结果的 `verifier_result.rewards` 为 `null`。

### 2. 多版本重评、对比与数据集聚合

- **无损重评（`rsa bench verify`）**：每次执行 `verify` 都会在 `verifier/<new-verification-id>/` 下追加一条独立评分记录，并在评分结束后原子更新当前默认 verification 指针；失败评分也成为当前版本，不自动回退使用上次分数。原执行状态（`trial.json`）与历史评分版本完整保留。若传入 `--task <new-task-dir>`，系统会将新任务包固定并记录新的评分 Task 摘要，同时保留试验原本的执行 Task 身份。
- **双试验对比（`rsa bench compare`）**：对比两次试验（或同一试验的两个评分版本 `run-id@ver-id`）的任务摘要、参数、`conditions`、`subjects` 与数值维度差值。仅对双方均存在的指标计算差值，缺失维度保持缺失而不补零；当实验条件或被测版本不同时明确标注差异，不直接宣称能力提升。
- **数据集聚合（`rsa bench aggregate`）**：对显式选定的一组 trial 执行统计。默认按 Task 分组输出 `byTask`（采用 Harbor 均值语义：缺失或 `null` 计为 `0`，同时输出 `total / valid / error` 计数）；若 Dataset 声明了自定义 `metric.py`（接收 `-i <JSONL> -o <JSON>`），则校验文件摘要后调用该脚本计算跨任务聚合指标。`--policy all` 保留全部选定试验，`--policy graded` 显式剔除无有效评分的试验并记录原因。

## 文件与展示

单次 Benchmark 运行在 `workspace/logs/<run-id>/` 下的完整落盘结构：

```text
workspace/logs/<run-id>/
├── manifest.json                  # 运行环境、Git 来源与外部事件源登记
├── input.json                     # 实际执行的 argv、cwd、预算与参数
├── trial.json                     # Shiori 提交的执行终态与产物引用
├── events.jsonl                   # Shiori 写入的运行与评分生命周期事件
├── stdout.log / stderr.log        # 被测程序标准输出与错误输出
├── artifacts/                     # 被测程序产出的 measurements.json、可选 context.json 等
└── verifier/<verification-id>/    # 每次独立评分一个子目录
    ├── input.json                 # 本次评分输入清单
    ├── verification.json          # 评分 Task 摘要、状态、耗时与错误信息
    ├── reward.json                # 唯一数值成绩原件
    ├── details.json               # 可选任务私有诊断详情
    └── stdout.log / stderr.log    # Verifier 脚本输出
```

CLI 与 Dashboard 的 Benchmark 视图直接读取 `Trial + Verification + Reward` 三元组，展示各维度的数值成绩、`details.json` 诊断以及执行/评分日志，并支持在界面中一键复制运行命令或切换基线版本进行对比。

在 **Benchmark → 评测目录** 中，没有任务时链接到任务指南；任务尚无运行时提供绑定版本的终端命令。历史按任务名称筛选，包含各个版本；选中的摘要只绑定命令，不限制历史版本。筛选无结果和旧页为空分别提供重置操作。缺失或格式错误的运行、基线链接可重试或清除，不丢失任务选择；任务移出当前目录后仍可通过固定链接读取历史。浏览、刷新、阅读指南与复制命令均不会启动评测或调用模型。

切换历史筛选或分页时，任务包列表保持可见，保留键盘焦点，并显示读取失败状态。保留的目录只属于当前工作区的身份与位置；工作区变更后不会沿用。历史行始终对应当前查询。窄屏下任务使用单列列表；选择任务后可查看完整版本摘要与任务包路径。同名任务存在多个已发现版本时，必须先明确选择版本，才会提供运行命令。

任务筛选、所选运行与比较基线相互独立。切换或清除任务筛选会保留明确选中的运行和基线。从历史选择一次运行后读取其详情；清除运行选择会显示未选状态，不会自动打开历史第一行。

## 内置任务与证据边界

仓库内置 8 个标准评测任务（定义于 `rsa/benchmarks/tasks/` 与 `rsa/src/benchmark/cases/`）：

| Task 名称 | 运行模式与被测对象 | 核心验证指标与证据边界 |
| --- | --- | --- |
| `ludens/perception-lifecycle` | 离线 · 真实 Python + 合成媒体 | 验证常驻采样、`reload` 热更新、历史查询、故障恢复与归档不可变性（不测真实模拟器与 GPU 模型）。 |
| `ludens/control-handoff` | 离线 · 真实 Runtime / Baseware + 模拟驱动 | 验证人工交还中断延迟、输入归零释放与旧 `epoch` 严格拒绝。 |
| `ludens/ws-recovery` | 离线 · 真实 Codex Provider + 模拟传输与虚拟时钟 | 验证连接制限到期、`1012` 断连退避、SSE 恢复、全量历史重连 WS 及已提交工具不重放。 |
| `ludens/background-compaction` | 离线 · 原生 OMP Maintenance + 受控流 | 验证后台候选摘要在上下文增长后保留复用、尾部消息无损重放、Span 归属与取消打断（固定 256k 阈值夹具）。 |
| `ludens/capability-reuse` | **在线模型** · 公共 Host 装配 + 隔离合成装配台 | 验证 Agent 在空技能/空感知初始状态下自主编写函数，并在跨批次订单与不同模型轮次间实现真实有效复用。 |
| `ludens/clamp` | 离线 · 普通 Python 程序 | 测量已加载 Python `@capability` 函数的样本计算输出与单次调用耗时。 |
| `ludens/video-storage` | 离线 · 双流合成图像 + PyAV 编码器 | 测量 MP4 视频分段编码吞吐、历史冷帧解码精度与进程 RSS 内存占用。 |
| `ludens/index-memory` | 离线 · 隔离缓存目录 + Dashboard Builder | 测量冷历史索引构建子进程峰值内存、查询分页准确性与退出后缓存释放（不替代线上 Next.js 压测）。 |

**`ludens/capability-reuse` 复用证据判定规则**：其独立评分器 [evaluate.ts](../../rsa/benchmarks/tasks/capability-reuse/tests/evaluate.ts) 仅从执行期已记录的事件流与审计事实判定，绝不重跑工作区代码。有效复用要求同一自主创建的 Python 函数在**两个独立订单批次**、**不同模型推理轮次**中被真实调用并产生被环境接受的成功设备终态；仅创建文件、仅 `import` 而未调用、或仅在任务结束后做 AST 静态盘点，均不计入有效复用得分。
