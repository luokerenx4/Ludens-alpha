# 日志与调用链

分析器、Dashboard、Alice Pet 和 Benchmark 消费同一日志。函数返回、模型成功、文件写入不等于任务成功，评测见 [Benchmark](benchmark.md)。

## 文件与事件身份

运行日志写在当前 `workspace/logs/<run-id>/`：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 工作区、模型、driver、预算、Shiori 实现和运行来源 |
| `events.jsonl` | schema v2 事件时间线 |
| `streams/` | 模型流事件及 source/trace；新版正文使用内容引用，小事件内联 |
| `payloads/` | 旧版 gzip 请求、响应和工具正文；保留可读，新宿主不再写此副本 |
| `perception/<generation>/` | 感知入口、实际导入的工作区源码清单 `sources.json`、stderr |

新观测统一存放在 `workspace/.rsa/timeline/`，跨 run 使用：`objects/<sha256>.bin` 保存去重的持久媒体，`segments/` 保存 JSONL 记录、定长 `.idx` 索引及 `.meta.json` 段摘要。关闭持久化时仅使用有限的 `window-<pid>-…/` 临时窗口。运行事件只引用记录与媒体，不再生成 `run/observations/` 副本。已有 run 的观测附件和日志保持原样可读，不自动迁移或删除。

模型与工具档案位于 `workspace/.rsa/archive/objects/<sha256>.json.gz`，只存文本和结构，大消息、工具定义和正文按内容共享，跨请求、跨 run 去重。引用使用 `encoding: "rsa-json-v1"`、对象路径、内容 hash 和原始 JSON 字节数；对象用 tagged JSON 区分用户数据与内部引用，不占用用户的 `$ref` 等字段。流事件使用 `rsa-stream-v1`，`dataRef` 中不超过 2 KiB 的编码根节点可以内联，避免每个 token delta 占一个文件；大子节点仍共享。所有读者使用 [同一个 codec](../shared/log-archive.ts)。

已知 image/audio 字段、data URL 和 JSON 工具文本中的媒体引用时空轴已有资产；JSON 字符转义不产生媒体副本。未录制媒体只保存 hash、大小和不可恢复原因，不由日志永久留存。默认读取返回媒体引用；完整读取才加载字节并核验 hash，过期、删除或未录制时明确失败。媒体引用不能冒充 provider 输入。

`events.jsonl` 保留调用身份和统计；工具参数放 `argsRef`，结果和模型消息放 artifact 引用。后台 job 和压缩结果只内联必要的生命周期/数值诊断，完整结构在结果引用中。HTTP 请求保留 wire hash、字节数和编码，JSON/gzip JSON 的正文复用语义对象；恢复 JSON 不等于还原压缩后的网络字节。stream 只存一份 data，raw 中对应的 data 行仅留位置与前缀。

OMP 原生 session、blob 和恢复机制不改，真实模型输入不替换为日志引用。共享 archive 与 timeline 不是单个 run 的附属文件：只复制或删除 `logs/<run-id>` 不会复制或回收它们。本次不迁移旧日志、不实现自动垃圾回收，避免让历史引用失效；具体施工与验收见 [模型日志引用化方案](indexed-model-log-plan.md)。

manifest 记录 Git commit/dirty、continue/consolidate 提示和可选 workspace AGENTS 的 hash；dirty 不代表代码快照。认证头不入日志。结构见 [events.ts](../rsa/src/harness/events.ts)、[Baseware protocol](../baseware/src/protocol.ts)、[provenance.ts](../rsa/src/harness/provenance.ts)。

每行包含当前写入者的 `runId` 或 `serviceId`、`seq`、墙钟 `at`、单调时钟 `atMs`，以及：

- `source`：职责组件及独立的 implementation/version。
- `origin`：源进程产生一次的 `eventId/clockId/seq/at/atMs`，转发和落盘不改身份。
- `trace`：`traceId/spanId/parentSpanId` 表示调用关系；`epoch/modelCallId/requestId/httpId/toolCallId/operationId` 保留业务身份。
- `type/data`：事件语义和内容。

| source.component | 事实来源 |
| --- | --- |
| `shiori` | Agent Loop、模型、工具、会话和压缩；当前 implementation 为 OMP |
| `rsa` | 外层循环、控制周期、统一能力入口、Python 入口启动 |
| `workspace` | 工作区装饰器函数的实际执行 |
| `baseware` | 设备控制权、Controller 执行和采样 |
| `benchmark` | 评测执行与报告 |
| `dashboard` / `pet` | 日志读取、投影和展示消费 |

顶层时间是接收时间，origin 是源时间；atMs 只能在同一 clockId 内相减。墙钟仅作粗略端到端参考。媒体通过明确引用关联，不用文件路径或读取时间推测采样身份。

## 调用与生命周期

仅按显式 trace 配对，不按时间、当前轮次或名称猜父关联。典型链：Shiori `invoke_agent → chat / execute_tool / compaction`，以及 `capability → python_call → capability → device`。

| 事件 | 契约 |
| --- | --- |
| `capability_start/end` | list/help/call，含参数、ID、epoch 拒绝；终态 success/error/cancelled 与本地耗时 |
| `python_capabilities_start/python_capabilities` | 静态发现的独立子 span |
| `python_capability/result` | CLI runner 的函数位置、源码 hash、参数和结果；属于能力 span 的细节 |
| `python_call_start/end` | 工作区进程内 `@capability` 或本地 `Client.call`；独立 span、PID、实际注册源码 hash、终态和耗时，不序列化原生参数/返回对象 |
| `command/execution/execution_error` | Baseware Controller 请求生命周期、controllerId、arguments、requiresControl；提交或查询完成不代表动作结束 |
| `action_start/end` | 已提交手柄动作的独立生命周期、actionId 和终态；沿用原 play 请求的 trace/epoch，异步结束不归到后续 wait/status 请求 |
| `observation_start/end/error`、`observation` | 同一个设备 span 的采样详情、区间、帧号和媒体；不另算设备操作 |

嵌套 Python 和 `rsa_tools.Client` 继承父 span/epoch，普通 helper 不追踪。无运行上下文时装饰函数仍可运行。日志失败只记诊断，不改结果、不重试动作；缺 end 保留 pending。trace 不授予操作权，epoch 校验独立执行。

`python_call_end.outcome=error` 只证明函数抛出异常，外层可能捕获它（例如负向测试）。Dashboard 将它保留为“函数抛异常”诊断，按显式 Python 父关系归组，展示外层返回状态、调用/抛出次数及最近异常；原始事件仍可完整搜索。异常不会覆写工具或后台任务的最终结果，也不按错误文案推断“预期”。缺少原生 bash 父 trace 的直接 import 调用保持未关联，不按 PID 或时间拼接。离线分析保留原始 span 统计，另给 `localPythonExceptions` / `localPythonExceptionGroups`：相邻异常父子调用归为一条异常链，成功祖先截断；异常链数不是任务失败次数。

原生 bash 的 `tool_start/update/end` 保存参数、进度、结果 artifact，Dashboard/Pet 与流中工具调用合并展示。当前不生成自定义 exec/exec_result。插件通过 OMP 缓存注入 workspace/socket/run/epoch；并行 shell 共用环境，不注入单个工具 span，未知父工具/模型轮次不推断。

`details.async/service` 产生 background_start，冻结启动 trace；原生完成通知按 jobId 或 service name+PID 产生 background_result，晚到仍属于原周期。启动成功不等于进程结束，不合并同名不同 PID，不代管后台；缺通知不伪造完成，Agent 可用原生 proc 查询。

## 感知与模型真实输入

`perception_status` 记录状态、generation、PID、源码 hash；`perception_sample` 记录新增时空轴快照及媒体数量；`perception_observe_start/end` 记录历史查询及读取结果/耗时。`@perception` 声明感知能力，`@record` 负责将成功结果交给常驻感知进程留档；未标记记录的调用不隐式保存。采样器持续调用 `Perception.sample()`，不再无条件追加；普通 import、CLI 和后台程序也可以调用被标记的能力，写入同一 workspace 时空轴。

每条记录有 ID、递增 sequence、能力身份及实际加载源码 hash、runId、`recordedAt` 和 `sampling` 区间，以及适用时的 generation、`sampledAt/sources/space`。`recordedAt` 是记录墙钟；`sampling.clock/startedAtMs/finishedAtMs` 是同一进程单调时钟区间；`sampledAt` 由 workspace 提供，表示已知的来源时刻，不能用记录时间伪造设备帧时间。观测可包含文字、任意 JSON 数据和多种媒体，时间与空间信息不局限于视频。记录失败属于能力失败，会抛错；不重试感知调用或动作，也不伪造成功记录。

持久化开启时，媒体按内容哈希保存一次，记录携带 `timeline: {recordId, sequence, asset}` 引用，`asset` 是时空轴根内的相对路径；之后的历史读取不复制或覆盖原件。默认热窗口 600 秒、分段 3600 秒，并受字节预算约束；完整配置见 [Workspace](workspace.md#常驻感知)。关闭持久化时记录和媒体只存在于有限窗口，选中媒体交付期间受保护，必要时随响应携带字节，不另建永久审计副本。窗口淘汰或进程关闭后，对应媒体可以过期。

查询开始记录原参数；查询结果返回 `records`、规范化后的 `query` 和分页字段 `hasMore/nextAfter`；`snapshot` 是本页最后一条。默认读取主 `Perception.sample` 能力，可通过 `capability` 筛选其他能力、`capability: "*"` 查询全轴或 `id` 定位记录。`reused` 表示与上一次读取返回相同的一组记录，不代表采样器停止。持久历史跨 reload 和 run 保留，默认最新主观测仍校验当前 generation 与采样健康，不将旧记录冒充当前采样。

**模型看到什么以 `observation_context` 和 `model_start.observations` 为准**，包括工作区自己融合或处理的媒体；不能用最新 driver 截图代替。输入编码失败另记 `perception_input_error`，读取成功不保证输入成功。空实现或失败只给文字诊断，不回退默认截图。取消读取不杀感知进程，迟到结果不塞回已取消的模型调用。

原生 bash/read 返回的图片记录为 `observation(origin=tool_result)` 并关联对应工具，不再自动创建图片副本。插件仅按实际输入字节的 SHA-256 匹配已经存在的时空轴 `objects/<sha256>.bin`，匹配成功时附 `timeline: {asset}`；无法据此确定采样记录，因此不填 `recordId/sequence`。没有原件时只记交付元数据，不声称已保存。后台完成图片在 OMP 将其送入模型时记录为本次交付，不能冒认最近一次前台工具。事件时间是交付时间，不推断原始采样时刻；CLI 历史时间和序号保留在输出标签与查询日志中。仅返回 JSON 路径不计作图片交付。

模型输入重编码产生的版本由同一感知 writer 保存为派生资产，`observation_media.modelMedia` 记录实际 hash、源 asset/record/sequence 和转换名称。只有明确来源才能派生，不按最近截图猜测；临时窗口的派生版本随源记录淘汰。派生存档失败只记诊断，不替换有效模型输入。

Dashboard 从项目注册的 workspace 解析时空轴引用，校验真实路径与目录边界；旧 run 附件仍按原边界读取。记录详情展开时按引用读取单条记录的 `data/space`，不把它们复制回事件；窗口记录仅查询当前宿主，不启动采样。未录制媒体显示交付记录，过期引用返回明确状态并显示过期提示，不渲染失效图片。临时窗口媒体和记录详情不做持久浏览器缓存。

generation 后台 trace 不继承重载请求或控制 epoch，持续采样与查询分别记录调用；查询不会重新执行 workspace 采样代码。接口及 reload 见 [Workspace](workspace.md)。

## Shiori、压缩与传输

[Shiori telemetry](../rsa/src/harness/omp/shiori.ts) 用 OMP 原生 OTel ID/状态，局部 provider 不全局注册。`captureMessageContent=none` 避免复制正文；`shiori_run_end` 保存单次 agentLoop 的 summary/coverage，一次接管可含多个 loop。

[模型追踪](../rsa/src/harness/omp/trace.ts) 保留请求 payload、传输方式、WS full/delta、HTTP 尝试和响应流：

- HTTP 的 dispatch → headers 是响应头等待；HTTP end 不表示流已完成。
- WS 出站 `response.create` 是 dispatch，不是首个响应。Dashboard 的“WS 首事件等待”是 dispatch → 第一个入站事件；不能用 HTTP 响应头指标代替。
- 请求总耗时、日志捕获和检查开销分别记录。重试及不同阶段可能重叠或未完全拆分，分项不保证相加等于总时长；现有 hooks 不能分开上传、网络与服务端排队。

后台候选创建时由 `omp.compaction.speculation` 固定 operationId/epoch，HTTP 子 span 和重试沿用候选身份。started→armed/failed/cancelled 是准备，waiting/applied/invalidated 沿用身份：armed 表示摘要可用，applied 表示选中提交，HTTP end 仅为响应头。前台 auto_compaction_start/end 独立维护 span，保留开始身份/耗时；追踪不改调度或阈值。

事件归属以 `trace.epoch` 为准；交还后的完成、重试、清理仍属于原周期。控制起止仅决定活跃时长和动作频率分母。旧事件缺少候选身份时保持未知，不用 snapshot leaf、当前 epoch 或时间邻近补全。WS 故障工况来源见 [WS 恢复测试依据](development.md#ws-恢复测试依据)。

## 消费与指标解释

Dashboard activity 保留 source/trace、投影耗时和读取高水位。Pet 在 `workspace/logs/consumers/` 分进程记录读取、队列、`display_dispatched`，不重复记空轮询；提交展示不证明已绘制，跳过历史展示不代表日志丢失。

网页和 Electron 共用 Dashboard。点击“让 Alice 跟随此工作区”持久化关注目标，无需重启；浏览其他工作区/历史不会切换目标。Alice 跟随所选工作区最新非 Benchmark run/epoch；切换时清空旧队列，迟到读取不污染新目标。停止跟随不停止 Agent，服务暂时离线后会重连。

Dashboard 负责日志解析和投影，网页与 Alice Pet 共用增量读取客户端。Pet 是展示端，只维护正在展示和待展示的气泡，不再读取完整 run 或自行遍历原始日志；视觉与音频逻辑独立于日志存储。

活动投影读取 events 和模型流，默认展示 thinking/text/tool/system，diagnostic 可选；不读加密推理、不额外请求模型解说。流式内容更新同一块，详情定位原 run/epoch/block；展示筛选不改变日志消费。

Dashboard 的一次性与增量读取共用模型档案 reader，兼容旧 gzip payload 和新 `rsa-json-v1` 引用。新 `rsa-stream-v1` 先跳过出站 `response.create`，只展开入站内容；文字完整还原，媒体保留 `$media` 摘要和时空轴引用，不读取图片/音频字节。新模型档案只在项目注册 workspace 与 manifest 一致时解析，不能由日志引用另一个目录；旧 run 媒体仍以注册工作区为准。新版活动投影重建其可丢弃缓存，包含工具正文缓存；不改变原始日志或 Pet 协议。

每个运行的 `.dashboard-index/` 是可重建的文件缓存：原始事件以字节偏移索引，投影正文追加到分段 JSONL。索引本身也分页落盘：最新指针按 ID 分页，事件和活动块另存按位置/版本递增的历史页；每页最多 1024 条，超过 256 KiB 时拆分（单条记录不可再拆）。内存只保留稀疏页目录和有上限的共享热缓存，正文按需读取。模型/调用跨度的事件关系也存磁盘，不为查询常驻一份全量映射。

共享索引页缓存默认 32 MiB，按序列化大小的四倍估算解码对象占用；`RSA_DASHBOARD_INDEX_CACHE_BYTES` 可调整，超出预算的单页直接读取，不留缓存。最多保留 3 个闲置/可回收 run，5 分钟无访问后淘汰；对应 `RSA_DASHBOARD_INDEX_MAX_RUNS`、`RSA_DASHBOARD_INDEX_IDLE_MS`。正在读取或刷新的 run 持有租约，不被回收；淘汰只关闭文件和释放索引缓存，历史仍可重新打开。此上限不是整个 Next 进程的内存上限，页目录、单次查询结果及精确统计另占少量内存。

读取检查点保存在 `checkpoint.json`。旧版单文件指针索引首次访问时流式迁移，保留 generation、游标和已有投影，不重新解析全部正文；原始 `events.jsonl`、`streams/`、`payloads/` 不改写。源文件被替换或截断、缓存写入被中断时重建。删除该缓存不删除运行证据。同一运行的并发概览与媒体请求共用一次投影刷新；分页/搜索只保留当前页候选，历史总数和全文搜索范围不截断。

实时阶段只保存未完成操作的身份、阶段和起始时间/序号，不保存事件正文。设备采集在 `observation_end/error` 结束；后台帧不一定进入模型，不能等待 `observation_media/context` 才关闭采集。后续输入处理沿用工具或模型请求自身的生命周期。

`/api/activity` 提供三种读取：`changes` 按不透明游标交付新增与更新，`history` 按类型/搜索条件分页，`block` 按稳定 ID 定位详情。浏览器和 Pet 共用 changes 客户端，接收成功后推进游标；仅 streams 增长也会产生新版本，旧工具的晚到结果更新原块。第一次连接或索引重建返回快照，Pet 不回放历史气泡；已有队列中的块仍可更新。历史全文搜索按需读文件，开销与搜索范围有关，不以截断历史换速度。

运行概览的统计覆盖整个所选周期，请求详情和观测按页读取。页面标明请求范围，可翻到更早的请求；活动日志保留全量检索入口。`current` 随增量活动提供轻量运行状态，Pet 无需串行请求目录、全量运行详情和全量日志。

从仓库根目录离线分析：

```sh
python3 rsa/scripts/analyze-run.py /path/to/workspace/logs/run-id \
  --epoch epoch-id --output /path/to/analysis.json

# 展开指定事件的正文，默认媒体只显示引用；不启动宿主或模型
rsa/bin/rsa logs read --run /path/to/workspace/logs/run-id --event 123 --field payload
# --ref '<artifact JSON>' 或 --file reference.json 也可定位；--full 才恢复媒体字节
```

- 模型延迟统计完成请求，p95 用 nearest-rank。缓存率按 token 加权，分母为 `input + cacheRead + cacheWrite`；warm 仅去掉首请求，不排除后续压缩造成的缓存重置。
- 动作频率计成功的 `action_end`，以及不带 actionId、需要控制权且非 readOnly 的成功 execution；提交、查询和等待不重复算动作，采样也不算动作。已提交动作按 `action_start/end` 与 actionId 核查。旧日志缺少这些标记时保留原统计，需查看 argv 区分状态查询。一次 play 可以含多个输入片段，不代表单个按钮次数。独立 observe 是该请求唯一执行的工具为 observe。
- 能力、discovery、本地 Python、Shiori 分层统计，依显式 span 配对，保留 late/pending；本地 Python 不并入设备动作数。
- Shiori usage 与 model usage、工具耗时与内部设备/能力耗时、能力 span 与 Python 详情是包含关系，不能相加。
- 新版工具参数只为技能路径证据按需解引用；缺失时对应计数为未知，`skillArgumentErrors` 保留原因，`skillEvidence` 保留已知成功数，不把缺证据报成零次使用。

帧号变化、exit 0、技能读写均不证明任务推进。Benchmark 故障注入的预期错误不是真实任务故障率；执行、报告、复用证据及其限制统一见 [Benchmark](benchmark.md)。

Benchmark 终态与报告事件携带 `benchmarkRunId/executionStatus/reportStatus/verdict/reportId/previousReportId`。执行完成而评分失败显示“目标未达成”；执行异常和无效报告分别保留错误。修订报告只更新评分，不增加执行次数。CLI 非零退出仍如实记录，它可能表示检查未通过；不能仅凭退出码归因为 Python 崩溃。评测事件位于独立 run，通过 `parentRunId` 关联宿主，不靠 shell 文本关联具体工具；旧事件缺少评分时不推断结果。

设备执行返回的 `result` 保留原生工具结果。设备日志中的同名字段省略 image/audio 的 `data` 或 embedded resource 的 `blob`，通过 observation 的 `contentIndex` 对应内容位置，保留大小和明确的 `timeline` 或 `dataPath/blobPath` 引用；无原件时使用 `dataOmitted/blobOmitted` 标明未留档。API、CLI、MCP 的实际返回仍保留原生内容；日志表示不能直接冒充 MCP 返回值。
