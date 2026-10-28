# Benchmark

Ludens 使用 Harbor 的 Task、Verifier、Reward 和 Dataset 文件约定。Shiori 是唯一 runner：日常 Agent 和评测共用 Host 的控制、预算、取消与清理；执行程序记录事实，独立 verifier 从已保存产物评分。重新评分不会重新执行动作或被测模型。

Harbor 契约参考固定版本 [`f3a5a9`](https://github.com/harbor-framework/harbor/tree/f3a5a923f6d722472c9e797af836ae4425fb215f)。本实现采用 `ludens-native` profile，不引入 Harbor runner，也不承诺任意 Harbor 任务可以直接在 macOS 运行。

## 入口与运行所有权

在目标 workspace 执行 `rsa bench --help` 查看完整参数：

```sh
rsa bench list
rsa bench schema task
rsa bench validate task /path/to/task
rsa bench validate reward /path/to/verifier
rsa bench validate dataset /path/to/dataset.toml
rsa bench help ludens/ws-recovery
rsa bench run ludens/ws-recovery
rsa bench history
rsa bench get <run-id>
rsa bench verify <run-id> --reason "Regrade fixed measurements"
rsa bench verify <run-id> --task <new-task-directory> --reason "Updated grading criteria"
rsa bench compare <run-id@verification-id> <baseline-run-id@verification-id>
rsa bench aggregate <dataset.toml> <run-id> <another-run-id> --policy all
```

`schema` 返回固定版本的契约说明（`guideOnly`），不是完整的官方 JSON Schema；`validate` 使用实际静态解析器校验，不执行任务或评分脚本。

`run` 执行任务并安排 verifier；`verify` 只重评已保存事实，追加一个 verification。`get`、`history`、`compare` 和 Dashboard 只读记录。`aggregate` 消费指定 Dataset 与明确选择的 trial/verification，不发起测量。命令的选择和筛选参数以 CLI help 为准。

执行绑定放在任务包以外的运行配置中。仓库 Task 从 `rsa/benchmarks/runs/` 发现绑定，工作区 Task 从 `<workspace>/benchmarks/runs/` 发现绑定，按 JSON 的 `task` 字段匹配，不要求配置文件与任务同名。唯一绑定可直接运行；没有绑定或存在多个绑定时，需要显式 `--config <path>`。Dashboard 为每个绑定提供包含配置路径的完整运行命令。

配置明确指定 Task、argv、cwd、工作区方式、预算和参数，任务 metadata 不决定运行方式、权限或设备接管。例如，工作区的 `benchmarks/runs/local.json` 可以运行一个普通 Python 测量程序：

```json
{
  "task": "my-org/example",
  "argv": ["{python}", "{workspace}/benchmarks/measure.py"],
  "workspace": "isolated",
  "seconds": 30
}
```

argv 是参数数组，不经过 shell 拼接；支持 `{rsa}`、`{python}`、`{bun}`、`{workspace}`、`{workdir}`、`{artifacts}`、`{task}` 和 `{param.key}`。`{workspace}` 始终是作者的原工作区；`{workdir}` 是本次执行工作区，isolated 模式下为单独分配的目录。省略 `cwd` 时在执行工作区启动；显式相对 `cwd` 和相对 `--config` 都从原工作区解析，不受启动 CLI 的目录影响。

Shiori 的 program 模式运行普通命令，不经过模型推理。需要 Agent 的任务仍使用 [公共 Host 装配](../../rsa/src/harness/host.ts)，包括 OMP、Controller、感知和控制周期，不另写一个 Agent loop。离线场景也通过同一个 Shiori 生命周期启动和取消。测量预算由外层 Runtime 统一计时，包含启动时间；内置 module 测量及其嵌套 Host 共享 `ctx.budget` 的截止时间，不重新获得一整段预算。预算到期允许测量停止并写出事实，沿用最多两秒的进程收尾期限；普通命令超时、程序失败或被强制终止仍是执行错误。用户取消通过独立的 `ctx.signal` 传递，不当作正常测量完成。场景内部的 `finally` 继续负责关闭自己创建的资源。

先读任务说明和绑定确认副作用：`capability-reuse` 使用在线模型，其余内置场景使用合成设备、数据或传输。Native profile 是普通本机进程，不是权限沙盒。默认 verifier 不继承 live socket、控制 epoch 或模型凭据；脚本仍具有当前用户的普通系统权限。不要把环境变量清理等同于文件系统或网络隔离。

## Task 与 Dataset

仓库任务在 `rsa/benchmarks/tasks/`；workspace 任务在 `benchmarks/tasks/`。一项任务由以下文件定义：

```text
benchmarks/tasks/example/
  task.toml
  instruction.md
  environment/       输入材料、依赖声明或锁文件
  tests/test.sh      独立评分入口
  tests/verify.py    或 verify.ts
  solution/          可选参考解，不作为被测程序
```

最小配置示例：

```toml
schema_version = "1.4"

[task]
name = "my-org/example"
version = "1"
description = "Measure a capability on fixed examples."
```

Ludens 要求 `task.name` 使用 `org/name`，这是比 Harbor 默认值更明确的本地约束。`task.toml`、说明、tests、environment 等被纳入 package digest；任务名称/版本标签不能代替内容 digest。外部执行入口和依赖源码不自动进入 Task digest，执行版本应单独记录为 subject/provenance。Shiori 保留 Git commit/dirty 来源信息，并在 `input.json` 记录实际 argv、cwd、预算和参数，不扫描整个源码树或对 argv 指向的文件逐一计算 hash；需要的模型、权重等版本由作者显式登记。ROM、权重、既有视频和大日志保持引用，不打包复制。

Shiori 将实际任务包固定到 workspace 的 `.rsa/benchmarks/tasks/<digest>/`。执行和默认重评使用该固定版本。修改 verifier 后是新的 Task digest；显式选择新任务包重评时保留原执行的 Task 身份，并为新 verification 记录新的评分 Task 身份。

Dataset 使用 Harbor `dataset.toml` 格式：

```toml
schema_version = "1.0"

[dataset]
name = "my-org/suite"
version = "1"

[[tasks]]
name = "my-org/example"
digest = "sha256:<64 位内容摘要>"
```

引用按名称和完整 digest 匹配本地任务；缺少精确版本时报告错误，不自动换成同名最新版本。仓库 [dataset.toml](../../rsa/benchmarks/dataset.toml) 列出当前内置任务。修改任务内容后必须同步它的 digest。

## Python 辅助登记是可选的

Python 使用普通函数和 import，可以直接向 `RSA_BENCH_ARTIFACTS` 写测量产物，不必 import `rsa_tools` 或生成 `context.json`。`current_trial()` 是可选的登记辅助；`@capability`/`@record` 仍用于能力和时空轴，评测没有额外的生命周期装饰器。

```python
from rsa_tools import current_trial

trial = current_trial()  # 身份和目录由 Shiori 分配；普通 REPL 中会报错
trial.conditions(dataset_revision="v3", seed=7)
trial.subject("model", path="weights.pt", revision="epoch-12")
samples = measure(already_loaded_model, dataset)
trial.artifact("measurements.json", samples)
trial.limitations("Only daylight samples were measured.")
trial.flush()
```

`current_trial()` 读取 `RSA_BENCH_TRIAL_ID`、`RSA_BENCH_RUN_DIR`、`RSA_BENCH_ARTIFACTS`、`RSA_BENCH_TASK_DIR` 和 `RSA_BENCH_INPUT`，缺少上下文直接报错。它不创建 run、不接管设备、不提交终态、不写 Shiori 的事件流。同一受管 Python 程序内可以复用已加载的对象；没有任意外部 REPL 或其他进程的自动纳管。每个 trial 的 context.json 由一个测量程序写入；作者启动的子进程应把测量交回父程序汇总，不应各自调用 current_trial() 争写同一清单。

Python 只写 `artifacts/context.json` 和作者明确生成的产物。context 记录 trialId、workspace 以及 conditions、subjects、artifacts、limitations 和实际 capability 调用统计，不是第二份 trial 或成绩。正常进程退出会 flush；常驻程序在交还结果前应显式 flush。被硬杀前尚未 flush 的内存统计不完整，不能推断成功。

本地 observer 收集实际调用的 capability 和加载时 codeSHA，覆盖顶层函数及实例方法，且不要求逐次调用进入持久日志。统计证明该版本在本进程参与执行，不证明另一常驻进程的效果，也不自动证明任务成功。普通 Python 调用保留对象，不强制序列化模型参数或返回对象。完整示例见 [clamp.py](../../rsa/benchmarks/examples/clamp.py)。

`artifact("samples.json", value)` 新建 JSON 产物，不覆盖已有文件；`artifact(path)` 按内容 hash 命名并复制外部文件，已位于产物目录内的文件直接登记。这些操作不保证文件之后不可修改。已录制媒体用 `artifact(media)` 或 `artifact(media["timeline"])`，核对 canonical record 身份、片段与 PTS 后保持引用，不复制图片或视频。视频仍是近似重建帧；gap、丢失和未收尾按原件状态报告，不补取当前画面。

## 事实、评分与重评

执行程序输出任务自己定义的最小事实，例如输入输出样本、真实动作终态、RSS 时间序列、冷解码误差或 capability 调用链。内置程序通常写 `artifacts/measurements.json`；这是任务私有结构，不是全系统通用 report schema。

Verifier 的 native 路径约定是：

| 环境变量 | 含义 |
| --- | --- |
| `RSA_BENCH_TASK_DIR` | 本次固定任务包 |
| `RSA_BENCH_INPUT` | 本次评分输入清单，含 trial 和证据引用 |
| `RSA_BENCH_ARTIFACTS` | 本次执行的产物目录 |
| `RSA_BENCH_VERIFIER_DIR` | 本次 verification 独占的输出目录 |

`tests/test.sh` 读取原始事实，把成绩写入 `$RSA_BENCH_VERIFIER_DIR/reward.json`，丰富解释可写 `details.json`。不写全局 `/logs/verifier`、`/tests` 或 `/solution`。Native 环境并未实现 Harbor 默认 Linux/container、云资源、skills 安装等全部执行语义；不支持的要求应在开始前报告。

```json
{"accuracy": 0.94, "latency_ms": 12.3, "success": 1}
```

reward 唯一公共结构是扁平的 `string -> 有限数字` 对象，没有通用 checks、passed、单位或方向字段，也不要求分数在 0 到 1 之间。可读取 Harbor `reward.txt` 的一个有限数值；同时存在时 JSON 优先。缺测维度省略并在 details 解释，不能写 null、NaN 或假零。整个评分不可用时，读取投影的 `verifier_result.rewards` 为 null；磁盘不写 `reward.json: null`。空对象不证明任务成功。

执行状态与评分状态各自记录。正常执行得到低 reward 不算执行错误；verifier 失败也不会改写原执行状态。缺失或无效 reward 应修复 verifier 后重评，不能为此自动再跑动作。

普通文件保存 run 内的路径引用，不要求 hash 封存；日志保留已记录前缀或明确事件的位置，timeline 保留 canonical 记录与媒体位置。重评读取当前保存的产物，开发时可以修正产物再重评，不重做动作，也不对全部文件做前后完整性扫描。缺失文件和不可用媒体照实报告，不从实时环境补取；数据是否足够评分由任务 verifier 决定。读取 reward 使用所选 verification 目录中的当前文件，不另验封存摘要；它不是不可变档案，需要保留评分修订时应使用 `verify` 追加版本，而不是覆盖旧 reward。

## 文件与展示

```text
workspace/logs/<run-id>/
  manifest.json                  已有运行/设备来源登记
  trial.json                     Shiori 提交执行状态与事实引用
  events.jsonl                   Shiori 唯一写入的运行事件
  input.json                     实际执行配置
  stdout.log / stderr.log        执行程序输出
  artifacts/                     measurements、可选 context 等产物
  verifier/<verification-id>/
    input.json                   本次评分输入
    verification.json            评分版本、状态、错误与证据
    reward.json                  唯一成绩原件
    details.json                 可选诊断
    stdout.log / stderr.log
```

一个 trial 可有多个 verification。默认选择的 verification 指针在评分完成后原子更新，失败不会偷偷复用上次分数；旧版本保留，可明确选择。重新评分不是新试验。Dashboard/Electron 共同读取 Trial + Verification + Reward，不再保留另一份 outcome 列表。独立 CLI 重评的事件位于 verifier/<id>/，不会向原执行日志以新序号重复写入。Pet 沿既有活动来源消费生命周期，零 reward 不自动显示为系统故障；独立重评不会切换游戏关注来源，不保证额外弹出重评气泡。

CLI 与 Dashboard 都展示执行附件，以及所选 verification 自己的 `details.json`、stdout 和 stderr。失败评分的诊断同样可读；details 是任务自己的 JSON 或文本，不增加统一 checks/report schema。

`compare` 比较任务/评分口径、参数、conditions 与两次执行/评分状态。差异是解释信息，不是计算资格门禁：双方都具有的数值维度始终给出差值，缺失维度保持缺失，不补零。条件不同会明确列出，不把差值直接解释成能力提升。subject 变化独立展示；同一次执行的不同 verification 不是独立样本，Dashboard 可把指定评分版本设为基线。

`aggregate` 记录 Dataset digest、trial 与 verification 选择、过滤策略和 metric 版本，不因选择了不同 verifier digest 而拒绝默认聚合；哪些评分应当一起统计由调用者决定，同一次执行不能用多个评分版本重复计数。自定义 `metric.py` 接收 `-i <JSONL> -o <JSON>`，每行是 reward map 或 null，输出有限数值 JSON map。内置默认按 Task 身份分组输出 `byTask`，各组使用 Harbor 的均值语义：缺失维度/null 计为零，同时展示 total/valid/error 计数。这个分组是 Ludens 的展示约定，避免把异构任务的同名维度默默合成一个分数；需要跨 Task 聚合时，Dataset 明确提供 `metric.py`。`--policy all` 保留所有选择；`--policy graded` 显式排除评分不可用项并记录原因。metric 输入本身没有执行异常信息，不能靠它猜测哪些行应当消失。

## 内置任务与证据边界

| Task | 测量范围 |
| --- | --- |
| `ludens/perception-lifecycle` | 真实 Python、合成模型/媒体：持续采样、reload、历史、修复、不可变归档；不测 PyTorch/设备 |
| `ludens/control-handoff` | 真实 Runtime/Baseware/Python、模拟驱动：中断、释放、旧 epoch 拒绝；不测真实模拟器延迟 |
| `ludens/ws-recovery` | 真实 provider、模拟 WS/HTTP 和虚拟冷却：回退、全量恢复、delta、工具不重放 |
| `ludens/background-compaction` | 原生 OMP maintenance/V2、受控 SSE/token：候选复用、尾部保留、归属和取消；fixture 显式固定 256k 阈值 |
| `ludens/capability-reuse` | 真实模型、隔离装配台：两批订单、自创函数、跨批有效复用；不证明长期泛化 |
| `ludens/clamp` | 已加载 Python 函数的样本结果与调用时间；不采内存 |
| `ludens/video-storage` | 双流合成图像的编码、冷查询与 RSS；名义 sample_hz 不等于有效采集率 |
| `ludens/index-memory` | 隔离缓存重建、真实历史查询与索引释放；不代替在线 Next.js 内存测量 |

`capability-reuse` 使用新 session、空 skills/memory、空感知入口和公共 Host 装配，不预填解法。普通 import、本地 API 和 controller 调用都可形成证据，装饰器和查询目录不是学习的必要条件。完成订单须有环境接受和成功设备终态；复用须关联同一自主函数、两批、不同模型轮次与真实订单。

[该任务的 verifier](../../rsa/benchmarks/tasks/capability-reuse/tests/evaluate.ts) 从执行阶段已保存的必要事件判定，不重新运行 workspace 代码。直接 import 的静态分析覆盖简单 Python shell 调用，不覆盖任意动态控制流；证据不足的复用维度省略，不能等同“没学会”。后台命令仅提交成功、无关 helper、只 import、仅有文件或结束后 AST 盘点，都不算有效复用。实现与测试分别见 [cases](../../rsa/src/benchmark/cases/) 和 [开发文档](../tutorials/development.md)。

Native `metric.py` 使用当前配置的 Python 环境，支持随 Dataset 声明并校验 digest 的同目录文件；不自动创建 Harbor 的 uv/PEP 723 依赖环境。模型名称也被记录为 subject，运行参数或模型配置不同会提示差异，但不阻止展示数值变化，也不自动宣称公平对照。
