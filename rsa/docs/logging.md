# 运行日志契约

日志是事实来源。分析器、Dashboard、Pet 和 Benchmark 从中生成各自视图；模型或函数执行成功不等于环境任务成功。评测由作者定义指标和断言，不把游戏评分规则写入 Harness。

## 职责与来源

| source.component | 职责 | 当前实现 |
| --- | --- | --- |
| `shiori` | Agent Loop、模型请求、工具调度、会话/压缩 | `implementation=omp`，`implementationVersion=18.9.1` |
| `rsa` | 环境循环、控制周期、统一能力入口、Python 进程启动 | RSA 宿主 |
| `workspace` | 工作区程序中装饰器入口的实际调用 | `implementation=python` |
| `baseware` | 设备操作权、统一 Controller 与采样结果 | 独立 Baseware 服务；driver 信息见 manifest |
| `dashboard` | 日志投影、读取高水位 | Dashboard activity API |
| `pet` | 读取日志、气泡队列、提交展示 | Alice Pet |
| `benchmark` | 评测生命周期、固定工况与 workspace 自定义指标/断言 | `rsa bench` / Python SDK |

Shiori 是稳定的架构角色，不是 OMP 的另一个包名。代码仍在 `src/harness/omp/`；换内核时保留角色，改变实现标注。实现配置和模型仍分别记录，不能仅凭角色名比较性能。

## 事件与时间

RSA 和 Baseware 的 schema 2 JSONL 包含：

- `runId` 或 `serviceId`、`seq`、`at`、`atMs`：当前写入者的文件顺序与时间。
- `source`：产生事实的组件和实现。
- `origin`：`eventId/clockId/seq/at/atMs`。产生事件的进程生成一次，落盘和转发保持不变；RSA 复制观测文件后可替换本地路径，但不重新创造事实身份。
- `trace`：`traceId/spanId/parentSpanId` 是调用关系；`epoch/modelCallId/requestId/httpId/toolCallId/operationId` 保留原业务身份。
- `type/data`：操作语义和事实内容。

`atMs` 是本进程单调时钟，不能跨 `clockId` 相减。转发的顶层时间表示 RSA 收到并记录的时间，`origin` 表示源时间。墙钟可用于粗略端到端延迟，但不能用它断言网络与执行各占多少。

大请求、响应和工具正文按 SHA-256 存在 `payloads/`，模型原始流存在 `streams/`，图像存在 `observations/`。原始流行也保留 source/trace。认证头不进入传输日志。manifest 自动记录代码 commit/dirty 状态、三份运行提示与 workspace AGENTS 的 SHA-256，以及 Shiori 实现、模型、driver 和预算。dirty 标记只说明当时有未提交修改，不代表完整代码快照。

## 调用树与终态

```text
Shiori invoke_agent
├── chat                    模型请求及其 HTTP/WS 记录
├── compaction              后台候选准备 / 前台维护（独立 operation）
│   └── compaction-http     HTTP 到响应头，不代表摘要就绪
└── execute_tool            OMP 工具调用及原生后台生命周期

Workspace shell            与 Shiori 共用 run/epoch，未推断具体父工具
├── capability              rsa controller 入口 / 设备 API
│   ├── discovery           静态发现 Python 函数
│   └── python_call         CLI 启动的 Python 入口
└── python_call             直接运行工作区 Python 程序
    └── python_call         同进程 import / Client.call
        └── capability
            └── device      Baseware execute
```

`capability_start/end` 覆盖 list/help/call，含参数/ID/epoch 拒绝。`outcome` 为 `success/error/cancelled`，终态带本地 `durationMs`。同一工具内并发调用相同函数也使用不同 span。

`python_capability/result` 是能力 span 的细节，保存函数位置、源码 hash、参数与结果。进程启动异常和取消均记录终态后沿原路径抛出；普通 Python helper 内部语句不逐行打点。`python_capabilities_start/python_capabilities` 对应独立 discovery 子 span。直接调用 Python runner 也生成独立 span。

`python_call_start/end` 来自工作区 Python 进程，覆盖被 `@capability` 标记的直接调用和本地 `Client.call("python/...")`。每次调用产生独立子 span，记录 ID、函数位置、注册时的源码 hash、PID、耗时及成功/错误；参数和返回值保持原生 Python 对象，不写入日志。嵌套的 `rsa_tools.Client` 设备调用继承当前 span 与 epoch。普通未装饰 helper 不逐函数追踪；直接使用底层 Baseware SDK 时保留其显式或环境 trace。

RSA 插件通过 OMP 已有环境缓存接口为 shell 注入 `RSA_WORKSPACE`、`RSA_RUN_ID`、socket 与 epoch。同一批并行 bash 共用周期环境，因此不在其中注入某个工具的 span；跨 shell 边界保留 run/epoch，Python/设备内部保留真实子链。日志通过现有 RSA socket 接收，校验 runId 并保留源时钟和原 epoch；未注入运行上下文时，装饰函数可作为普通 Python 代码运行。日志发送失败只报告诊断，不替换函数结果或重试动作。进程被强制结束时，本地函数可能只有 start；分析保留 pending，不伪造函数正常返回。

Shell 执行与后台进程管理复用 OMP 原生工具，不再产出自定义 `exec/exec_result`。`tool_start` 保留原生参数，`tool_update` 保留原生进度，`tool_end` 保留原生结果的 artifact 引用与 `isError`，按 epoch/modelCallId/toolCallId 关联；Dashboard/Pet 将流中的工具调用和这组事件合并成一张卡。工具耗时只到工具返回，后台任务/服务的启动成功不等于进程结束或设备动作成功；其后设备调用保留启动时注入的控制 epoch 和 trace，不能归到当时最新的模型轮次。旧 `exec` 日志仍可回看命令区间，但不补造新 `bash` 的命令耗时、退出码或后台寿命。

原生 `bash` 返回的 `details.async` / `details.service` 记录为 `background_start`，冻结启动工具的 trace 子 span；OMP 的 `async-result` / `launch-completion` 消息按 jobId 或 service name + PID 记录 `background_result`，保留原生状态与通知 artifact。晚到通知仍归属启动周期，未知启动不借用当前 epoch；同名服务不同 PID 不合并。只观察原生通知，不轮询或代管后台进程；通知被 OMP 抑制时不伪造完成，状态仍可由 Agent 的原生 `proc` 查询。

工作区感知进程以 `perception_status` 记录 unimplemented/loading/ready/stopped/error、generation、PID 和入口源码 hash；`perception_observe_start/end` 记录本次读取的状态、结果、耗时及终态。结果含 snapshot ID、工作区提供的 sequence、可选 sampledAt/sources，以及 reused 标记。入口源码、实际导入的工作区模块版本清单 `sources.json` 与 stderr 位于 run 的 `perception/<generation>/`，选中的媒体复制进 `observations/`。重复读取同 generation/sequence 保留同一归档；不能把读取时间当成新采样时间。`observation_context` 与 `model_start.observations` 保留实际送入模型的输入身份；空实现或失败只有文字诊断，没有默认截图回退。取消读取不杀感知进程，迟到结果不归入已取消的模型调用。

带新 PID 的 `perception_status` 是该 generation 的后台 trace 根。初始化和后台采样沿此 trace 记录，不继承触发重载的模型请求或控制 epoch；同步 `observe()` 内的调用沿对应读取 span 记录。模型输入编码失败另记 `perception_input_error`，通过结果 ID 关联原读取，不把读取成功等同于输入成功。

Baseware 为每次 Controller 调用生成子 span，`command/execution/execution_error` 为统一执行生命周期，记录 `controllerId` 与已知的 `requiresControl`。媒体调用的 `observation_start/end/error` 和每条 `observation` 共用这个 span，保留采样区间、帧号与媒体路径；它们是同一次操作的采样详情，不另算一次设备调用。采样结果使用 `controllerId`；历史日志读取时仍识别旧 `sensorId`。trace 是观测信息，不授予操作权；epoch 校验和取消行为保持独立。

OMP 的 `shiori_span_start/end` 使用原生 OTel ID；局部 BasicTracerProvider 负责生成真实 ID 和取得最终状态，不注册全局 provider。`captureMessageContent=none` 避免再复制一份正文；原始请求仍保留在现有 payload 中。`shiori_run_end` 原样保存原生 summary/coverage，范围是一次 `agentLoop`，一次 RSA 接管可含多个 loop。OMP 工具覆盖记录当前启用的原生工具及 observe；宏覆盖须看能力日志。

后台候选在 OMP 创建时通过 `omp.compaction.speculation` diagnostics channel 固定 `operationId`，RSA 用 AsyncLocalStorage 保留创建时的 epoch 和子 span；HTTP 是该候选的子 span，重试声明复用候选身份。候选准备以 `started → armed / failed / cancelled` 闭合，后续 `waiting / applied / invalidated` 仍引用同一 operation。`armed` 表示摘要可用，`applied` 只表示选中候选进入提交；HTTP end 只表示收到响应头。前台 `auto_compaction_start/end` 是另一段维护 span，结束事件保留开始时身份与单调时钟耗时。以上均不改变压缩调度、阈值或请求内容。

事件归属按显式 `trace.epoch`，不按写入时的当前周期或控制事件序号截断；交还控制后的完成、重试和清理仍留在原 epoch。控制起止只决定活跃时长和动作频率分母。旧日志缺失的候选身份保持未知，不按时间相邻、snapshot leaf 或当前 epoch 补猜。

## 消费与分析

Dashboard 的 activity 投影保留来源和调用关联，并返回投影耗时与读取高水位。Pet 的读取、队列变化和 `display_dispatched` 写入 `workspace/logs/consumers/`，每进程独立文件；无变化的轮询不重复记录。提交展示表示主进程调用了展示接口，不证明屏幕已经完成绘制。连接时略过已完成历史是展示策略，不作为日志丢失。

`python3 scripts/analyze-run.py <run> --epoch <epoch>` 离线生成分析：

- 原有模型/工具/设备/观测/压缩指标；时延统计增加 nearest-rank p95。动作频率只计需要控制权的成功执行，`requiresControl: false` 的采样调用保留在执行明细中，不算输入动作；旧日志未声明时沿用原动作口径。
- 按 source 统计事件；能力、Python runner、本地 Python 调用与 discovery 按显式 span 配对，保留 late cleanup 和 pending。本地调用单列 `localPythonCalls`，不并入设备动作数。
- Shiori spans 与原生 loop summary 单列；旧日志缺 span 时不从名字/顺序猜测宏调用。

**禁止相加的包含关系**：原生 Shiori usage 与现有 model usage；工具耗时与其内部 exec/宏/设备耗时；capability span 与 Python 细节耗时。上述数据描述同一工作的不同层次。

现有 hooks 仍不能拆开上传、网络和服务端排队。源帧号前进、宏 exit 0、skill 被读取或写入都不证明任务推进。环境评分、能力收益和固定 benchmark case 留给独立评测层，不能把游戏知识放进 Harness。

## Benchmark

内置工况和工作区 `@benchmark` 共用 schema v3 的执行记录 `benchmark.json` 与独立的版本化报告 `reports/<id>.json`；事件仍采用上述 schema v2 格式。每次评测有独立 `workspace/logs/<run-id>/`。定义快照、参数、conditions、subjects、provenance 和附件引用属于执行事实；模型权重和数据集不自动复制，显式登记的附件归档并记录 hash。

函数返回后先保存 `reports/<id>.raw.json`，再验证并生成报告；格式错误保留原始数据和完整字段诊断，不改写 `completed` 执行状态。报告的 checks / metrics 经验证后才投影给 CLI 和看板，`verdict` 只在正常完成且报告有效时成立。检查的 expected / actual 使用 JSON 值，evidenceSeq 可选并引用本次事件；缺测用 null，不能用零或 NaN 冒充测量。

`benchmark_start/end` 描述执行，`benchmark_report` 描述报告保存、口径和验证问题。`rsa bench report` 追加报告及该事件，不重新发出执行开始、也不重做动作；报告携带 previousReportId 与 reason。执行异常与加载异常分别保留 errorPhase，异常执行即使补了有效报告也仍是异常。比较可固定 runId@reportId，修正不算新试验。接口和比较口径见 [Benchmark 说明](../benchmarks/README.md)。

Python 评测在调用进程写记录，不要求 Host 在线；有父运行时保留 `parentRunId` 与 trace。评测生命周期只写本次日志，内部 Python 能力调用可同时写入本次与父 Host 日志，并保留同一 origin。CLI、Python SDK 与 Dashboard 使用同一执行与报告身份，不按转发次数累计成绩。直接进程被硬杀而没有终态时保留未完成记录；受控 worker 的异常和取消由外层收尾，不能编造正常返回。

离线 WS/压缩 case 会产生真实实现的 trace epoch，但没有 Runtime 接管，因此不伪造 `control`。看板对没有接管周期的基准读取完整 run；事件的原 trace 仍可核对。故障注入中的预期错误不能直接当成真实运行故障率。

`benchmark_reuse_inventory` 是结束后的只读 AST 盘点，只证明文件中存在有效能力；不能算 Agent 主动发现或调用。能力复用接受普通 Python 函数的直接 import 和统一接口调用，不要求装饰器或事先查询目录。统一接口使用 capability / Baseware 原调用链；直接 import 则联合成功写入的源码、原生 `bash` 命令 AST、`tool_end.result` artifact 中的成功终态和同一调用链完成订单的设备事件，跨批次、不同模型轮次判定。OMP 成功结果可省略 exitCode，后台或服务启动成功不能替代完成终态；旧日志仍接受 `exec/exec_result`。只 import 未调用、无关 helper 与手动动作混用不能作为有效复用证据；静态分析无法识别的调用保留待定，不等于没有学会。接口选择与目录查询单独作为诊断指标，不能把“没走 controller”记成学习失败。原日志重评要标明新 case version 与重评原因。

原生 bash 默认只向子进程传递 run/epoch；缺少跨 shell 的模型轮次或父工具关联时，上述跨轮复用判定会保留待定，不能用时间邻近补出因果关系。工作区函数内部的真实调用和设备结果仍可独立查看。

直接 import 判定是有限的静态证据分析，不是 Python 执行追踪：未分析依赖导入副作用，也未重建成功 `write` 后经 `edit` 或 shell 改写的完整源码历史。这些情况需要核对原日志，不能仅凭结果摘要断言归因。
