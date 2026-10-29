# 日志与调用链

离线分析器、Dashboard 网页控制台、Ludens Pet 桌宠与 Benchmark 评分器共同消费同一套持久化运行事实。系统的记录准则是：**连续高频能力按需留档数据并定期汇总统计，主动决策与设备变更完整记录事件，内部嵌套调用链按诊断级别追踪**。

## 记录模式

### 1. `normal` 与 `full` 模式对比

在 `rsa.json` 的 `logging.diagnostics`（或 CLI `--diagnostics`）中设置日志模式，启动时写入 `manifest.json`，Python 子进程通过环境变量 `RSA_LOG_DIAGNOSTICS` 继承（`rsa status` 的 `logging.diagnostics` 与 `basewareDiagnostics` 分别显示 Host 与 Baseware 的实际生效模式）：

| 模式 | 记录范围 | 落盘位置 |
| --- | --- | --- |
| `normal`（默认） | 完整保留模型调用、工具执行、主动能力调用、设备输入及终态（`action_start / action_end`）、控制权变迁、常驻进程生命周期与故障区间；对携带 `trace.recordingPurpose = "continuous-perception"` 或 `"continuous-action"` 的常驻循环内部只读调用链，省略逐次调用事件与日志 RPC（标注 `@record` 的结果仍正常写入 `.rsa/timeline/`）。 | `logs/<run-id>/events.jsonl` 与 Baseware `events/` |
| `full` | 在 `normal` 基础上，额外记录常驻感知/动作循环内部的每一次嵌套 Python 调用与 Baseware 只读查询明细（不重复复制媒体或经历事件）。 | 独立写入 `logs/<run-id>/diagnostics.jsonl` 与 Baseware `diagnostics/` 分段 |

### 2. 周期聚合统计与故障区间合并

为避免 30Hz 常驻循环刷爆事件流，连续采样与动作循环采用 **5 秒固定窗口统计 + 故障区间（Fault Span）合并**：

- **5 秒窗口统计**：常驻感知每 5 秒写入 `perception_stats`（按能力 ID 与 `codeSHA` 汇总窗口内的调用次数、异常数、耗时 `total/min/max`、采样尝试/完成/录制数，以及视频编码器累计计数与当前队列快照）；Baseware 独立写入 `device_sampling_stats`；常驻动作每 5 秒写入 `action_stats`（含 `stepHz` 与窗口 `step` 增量）。进程正常停止时自动补写尾段统计。
- **故障区间合并**：连续感知首次出错时立即写入 `perception_fault` / `device_sampling_error`，后续同类重试错误仅累加区间内的 `fault.count`，即便成功与失败交替出现也不会每帧反复开关故障事件。待观察到恢复成功且历经至少一个完整 5 秒窗口无同类错误（或进程正常停止）时，闭合该故障区间。常驻动作首次异常则写入 `action_fault` 并立即停止动作循环，待停止或重载收尾时写入 `action_fault_end`。

## 文件与事件身份

### 1. 存储布局与多源归并

单次运行目录 `workspace/logs/<run-id>/` 的文件组成：

工作区目录由全局 `$LUDENS_HOME/registry/<id>.json` 定位，稳定身份来自 `.rsa/workspace.json`；registry 只索引路径，运行事实不保存在源码仓库旁。目录搬动后重新 `rsa workspace open <path>` 即可登记；历史 `manifest.json` 中的原始运行信息仍保留。

| 文件 / 目录 | 内容与归属 |
| --- | --- |
| `manifest.json` | 工作区路径、模型、Driver 列表、预算、生效日志模式、Shiori 实现版本、Git/提示词哈希及 `eventSources` 外部事实源声明。 |
| `events.jsonl` | RSA 写入的 Schema v2 主事件流（保存调用身份、统计与内容引用）。 |
| `diagnostics.jsonl` | `full` 模式下的高频内部调用诊断流，按需分页读取。 |
| `streams/` | 模型流式响应分片（`rsa-stream-v1` 格式，小根节点内联，大节点引用 `.rsa/archive/`）。 |
| `perception/<gen>/` · `action/<gen>/` | 对应代次的入口信息、实际导入的工作区源码清单 `sources.json` 与进程 `stderr`。 |

跨运行共享的三类底层存储：

1. **Baseware 设备事实源（`logs/baseware/`）**：每个 Baseware 实例独立维护 `source.json`、`events/` 与 `diagnostics/`（按 1 小时或 256 MiB 切段），事件以 `origin.eventId = "<serviceId>:<seq>"` 唯一标识。RSA 在 `manifest.json` 的 `eventSources` 中记录 `{sourceId, root, format, recordingId, windows}`；读取端通过 [shared/event-sources.ts](../../shared/event-sources.ts) 按需归并。动作启动时冻结 `recordingId`，即便动作在窗口关闭后晚到结束，仍精确归属原运行。
2. **工作区时空轴（`.rsa/timeline/`）**：存放跨 run 共享的感知与能力留档——`video/<id>.mp4` 及配套状态文件 `.mp4.json`（区分 `pending / ready / error`）、非视频去重媒体 `objects/<sha256>.bin`、以及分段记录 `segments/`（含 JSONL、定长 `.idx` 索引与 `.meta.json`）。关闭持久化（`RSA_PERCEPTION_PERSIST=0`）时仅使用 `window-<pid>-.../` 临时窗口。
3. **内容寻址结构化归档（`.rsa/archive/`）**：由 [shared/log-archive.ts](../../shared/log-archive.ts) 统一读写。模型消息、工具定义与大参数/结果存为 `objects/<sha256>.json.gz`（使用 `encoding: "rsa-json-v1"` 与 tagged JSON 区分内部引用与用户 `$ref` 字段）。日志中的图像/音频数据不重复存盘，而是引用 `.rsa/timeline/` 资产，并在 `.rsa/archive/media/<sha256>.json` 维护轻量级哈希到视频帧的映射索引（内存 LRU 上限 4096 项）。

上述 Baseware 路径由工作区编排显式指定。独立 `baseware serve` 省略 `--data-dir` 时使用 `$LUDENS_HOME/logs/baseware/<socket-name>/`；显式目录始终优先。共享桌宠的偏好与后台日志在 `$LUDENS_HOME/pet/`，其针对工作区的消费事件仍写入 `<workspace>/logs/consumers/`。

### 2. 事件通用信封结构

每条 JSONL 事件均包含写入者顶层标识（`runId` 或 `serviceId`、递增 `seq`、墙钟 `at`、单调时钟 `atMs`）以及以下四个核心块（定义见 [rsa/src/harness/events.ts](../../rsa/src/harness/events.ts)）：

- **`source`**：产生该语义的职责组件（`shiori`、`rsa`、`workspace`、`baseware`、`benchmark`、`dashboard`、`pet`）及其具体实现与版本。
- **`origin`**：源进程首次生成该事实的 `{eventId, clockId, seq, at, atMs}`，跨进程转发与落盘保持不变（`atMs` 仅允许在相同 `clockId` 内相减）。
- **`trace`**：调用链与业务归属上下文，含 `traceId / spanId / parentSpanId`（调用树关系）、`epoch / modelCallId / requestId / httpId / toolCallId / operationId`（业务实体 ID）、`recordingId / recordingPurpose`（运行归属与常驻用途）及 `inputGeneration`（同 epoch 内动作 worker 重载代次）。
- **`type` / `data`**：具体事件类型与载荷。

## 调用与生命周期

所有调用链严格依据显式 `trace.spanId / parentSpanId` 配对，绝不通过时间戳相近或函数名猜测父子关系。典型调用链形态为：

- 模型与工具链：`invoke_agent → chat / execute_tool / compaction`
- 能力与设备链：`capability → python_call → capability → command / execution`

核心事件契约速查：

| 事件类型 | 语义与生命周期边界 |
| --- | --- |
| `capability_start / capability_end` | `rsa controller` 的 `list / help / call` 边界，记录参数、能力 ID、epoch 校验结果、终态（`success / error / cancelled`）与耗时。 |
| `python_capabilities_start / python_capabilities` | 工作区 `@capability` AST 静态扫描发现的独立子 Span。 |
| `python_capability / python_capability_result` | CLI 单次 Python 能力运行器的函数位置、源码哈希、入参与返回结果。 |
| `python_call_start / python_call_end` | 工作区 `@capability` 装饰器函数的实际执行 Span，记录 PID、源码哈希、终态与耗时（不强制序列化原生 Python 入参/返回对象）。`normal` 下省略的常驻父层会在子事件标记 `parentOmitted: true`。 |
| `command / execution / execution_error` | Baseware 设备操作请求与终态；同次调用产出的媒体摘要直接内嵌于 `execution.observations`。 |
| `action_start / action_end` | 已提交异步手柄动作（`pad.play`）的独立硬件执行生命周期，携带 `actionId` 并沿用提交时的 `trace / epoch`，不会挂到后续的 `pad.wait / status` 请求下。 |
| `action_status / action_fault / action_fault_end / action_stats` | 常驻 `action.py` 进程的生命周期、故障区间与 5 秒统计；生命周期状态进入 Activity 与桌宠，故障详情与统计归入诊断分类。 |
| `background_start / background_result` | OMP 原生异步 `bash` 任务（`async`）或命名服务（`service`）的启动与完成通知，按 `jobId` 或 `service name + PID` 配对并保留启动时的 `trace / epoch`。 |

**Python 异常链归并规则**：`python_call_end.outcome = "error"` 仅代表该层函数抛出异常（外层调用方可能已 `try/except` 捕获）。分析器与 Dashboard 按显式 Python 父子关系将相邻未捕获的异常归并为一条异常链（`localPythonExceptionGroups`），一旦祖先调用成功返回即截断，不会用内部捕获的异常覆写外层工具的成功状态。

## 感知与模型真实输入

### 1. 时空轴查询与模型交付收据（`observation_context`）

- **查询事件**：每次执行 `observe` 记录 `perception_observe_start / perception_observe_end`，以该次调用的 `spanId` 作为返回信封的 `queryId`。
- **交付收据**：自动交付只在 prompt 开始（`before_agent_start`）发生；显式 `observe` 与原生工具图片各自开自己的收据（`origin` 分别为 `explicit` / `tool_result`）。每次向模型交付上下文时写入一条 `observation_context` 事件，记录 `{id, origin, queries, observations, purpose?}`。随后发起的 `model_start` 通过 `deliveryIds` 引用本次新增的收据 ID（注：`deliveryIds` 仅标识本轮新追加的观测来源，模型完整历史上下文以请求归档 payload 为准）。
- **自动交付去重游标**：自动注入开启时（`context_policy` 事件记录 `rsa perception inject on/off` 变更），扩展按时空轴 `recordId` 去重，同一条记录不会随续轮重复追加；画面像素相同但 `recordId` 不同的新采样仍作为独立时间证据交付。只有当自动交付实际成功完成时才推进采样器状态游标，被抑制或取消的读取不会吞掉状态变迁通知。

### 2. 模型输入重编码与工具图片追踪

- **派生图像（`modelMedia`）**：感知图像在送入 OMP 前经过一次 `resizeImage` 编码，编码耗时与尺寸记入 `observation_media` 事件，并将重编码后的图像交由感知 writer 存为派生资产（在 `observation_media.modelMedia` 中记录派生哈希、源 `asset / recordId / sequence` 与转换器名称 `omp.resizeImage`）。
- **原生工具图片**：通过原生 `read` 或 `bash --images` 交付给模型的图片记录为 `observation(origin = "tool_result")` 并关联对应 `toolCallId`。若 CLI 输出携带明确的时空轴记录标签且字节匹配，则精确关联到该 `recordId`；若仅字节哈希匹配 `.rsa/timeline/objects/<sha256>.bin`，则仅复用底层资产而不臆测采样时刻。

## Shiori、压缩与传输

1. **Shiori OTel 遥测**：[shiori.ts](../../rsa/src/harness/omp/shiori.ts) 挂载局部 OpenTelemetry provider（设置 `captureMessageContent = "none"` 避免重复复制正文），在单次 `agentLoop` 结束时写入 `shiori_run_end` 汇总。
2. **HTTP 与 WebSocket 传输追踪**：[trace.ts](../../rsa/src/harness/omp/trace.ts) 记录完整的请求载荷、传输协议（WS full / WS delta / HTTP SSE）与阶段耗时：
   - **HTTP 响应头等待**：从请求发出（dispatch）到收到 HTTP 响应头的耗时（流式接收完成由 `http_end` 之后的内容流结束标识）。
   - **WS 首事件等待**：WebSocket 模式下出站 `response.create` 仅为发送完成，Dashboard 统计从出站完成到收到**第一个入站服务端事件**的耗时作为首包响应指标。
3. **后台预测压缩追踪**：通过 `diagnostics_channel("omp.compaction.speculation")` 为每个后台压缩候选分配唯一 `operationId`，全链路记录 `started → armed / failed / cancelled` 及阈值阶段的 `waiting / applied / invalidated`，其内部发起的 HTTP 请求与重试均挂载在该 `operationId` 与原控制 `epoch` 下。

## 消费与指标解释

### 1. Dashboard Worker 与三层可重建索引（`.dashboard-index/`）

Dashboard 将日志解析与索引构建完全隔离在 Next.js 请求上下文之外的独立 Node Worker 中。每个 run 目录下的 `.dashboard-index/` 是纯派生、可随时重建的二级索引（绝不修改原始 `events.jsonl`、`streams/`、`.rsa/archive/` 或 `.rsa/timeline/`），包含三部分：

1. **源事件位置与关系目录**：每条事件仅保存文件字节偏移、时间戳（取 `origin.at ?? at`）、类型与调用身份；模型、Span、动作与观测的关联表均指向源事件字节偏移。
2. **Activity 按需展示配方**：仅保存每个展示块（Thinking / Text / Tool / System / Diagnostic）对应的源事件偏移或 `streams/` 截止字节数；前端或桌宠请求时才按配方从原件组装文本，不在索引中冗余存储完整正文。
3. **周期概览与统计快照**：预聚合请求延迟、Token Usage、Span 终态计数与当前运行阶段，支撑秒级打开长周期概览。

### 2. 分页缓存与冷历史构建子进程

- **页缓存与租约淘汰**：索引按每页最多 1024 条或 256 KiB 分页落盘。查询 Worker 维护默认 **256 MiB** 的共享页缓存（可通过 `RSA_DASHBOARD_INDEX_CACHE_BYTES` 调整），最多保留 **3 个**闲置 run（`RSA_DASHBOARD_INDEX_MAX_RUNS`），闲置 **5 分钟**（`RSA_DASHBOARD_INDEX_IDLE_MS`）且无在途读取租约时自动释放内存。
- **单实例冷构建 Builder**：首次打开尚未建立索引的历史大型 run 时，查询 Worker 启动全局唯一的临时 Builder 子进程（目标工作集默认 **2 GiB**，由 `RSA_DASHBOARD_BUILD_BYTES` 控制），单遍扫描固定截止点的事件流并批量生成 `generations/<id>/`，完成后通过原子替换 `.dashboard-index/active.json` 发布并退出子进程以归还 OS 内存。构建期间接口返回 HTTP `202 ARCHIVE_PREPARING` 及实时进度；关闭浏览器标签页仅取消当前 HTTP 查询，不会中断后台有限构建任务。

### 3. 控制台 HTTP 接口与 Ludens Pet 增量跟随

- **`/api/activity`**：提供 `changes`（基于不透明游标的增量块更新，供网页与 Ludens Pet 共用）、`history`（按类别与全文关键词分页检索）与 `block`（单块详情展开）。Ludens Pet 仅消费所跟随工作区最新非 Benchmark 运行的实时 `changes` 增量，并在 `workspace/logs/consumers/` 下记录自身消费水位。
- **`/api/diagnostics`**：专供 `full` 模式诊断事件按 `epoch`、时间窗、`traceId / spanId / actionId` 分页查询（单页上限 500 条），不混入普通 Activity 流或桌宠气泡。

## 经历回放

### 1. 时空轴播放器与帧预读缓冲

Dashboard 回放视图（`/api/replay`）将 `.rsa/timeline/` 的连续采样画面、设备动作区间（`action_start / action_end`）、模型推理与工具调用对齐在同一工作区墙钟时间轴上：

- **时间窗与双帧预读**：事件按最多 60 秒窗口、每页 500 条游标分页；画面使用解码缓冲 Hook——待目标时刻的所有屏幕画面加载完毕后原子切换，同时向后预读最多 2 帧（上限 8 张图 / 32 MiB 预读缓存），切换工作区或离开页面时立即释放图像内存。
- **采样画面与模型实际输入区分**：播放器主画面展示感知层留档的连续帧（包含模型思考期间采集但未送入上下文的帧）；模型调用详情按该请求的输入引用定位观测。视频帧是有损重建，不能当作模型输入的原始字节；未留档、编码缺口或过期媒体按实际状态显示缺失。

### 2. 离线日志读取与运行分析工具

从仓库根目录可在不启动 Host 或 Dashboard 的情况下直接读取归档与生成统计报告：

```sh
# 生成指定运行与控制周期的完整 JSON 统计报告
python3 rsa/scripts/analyze-run.py /path/to/workspace/logs/run-id \
  --epoch epoch-id --output /path/to/analysis.json

# 展开单条事件的归档引用正文（默认媒体仅展示引用摘要；--full 仅恢复仍有原件的媒体字节，视频源保留有损来源标记）
rsa/bin/rsa logs read --run /path/to/workspace/logs/run-id --event 123 --field payload

# 按序流式输出 run 声明的全部事实源事件（加 --diagnostics 读取 full 诊断流）
rsa/bin/rsa logs events --run /path/to/workspace/logs/run-id
rsa/bin/rsa logs events --run /path/to/workspace/logs/run-id --diagnostics
```

[analyze-run.py](../../rsa/scripts/analyze-run.py) 的核心指标统计口径：

- **模型延迟与缓存命中率**：统计已完成的模型请求，P95 采用 nearest-rank；Prompt Cache 命中率按 Token 加权计算，分母为 `input + cacheRead + cacheWrite`（`warm` 口径仅剔除周期首请求，不剔除后续压缩引起的缓存重建）。
- **有效设备动作频率**：仅计入成功的 `action_end` 以及不带 `actionId`、要求控制权且非只读的成功 `execution`；异步动作提交（`pad.play` 请求本身）、状态查询、`pad.wait` 与感知采样均不重复计入动作次数。
- **嵌套耗时不重复相加**：Shiori 总耗时包含模型与工具耗时，工具耗时包含内部能力与设备调用耗时，各层级独立展示而不做简单累加。
