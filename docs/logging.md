# 日志与调用链

分析器、Dashboard、Alice Pet 和 Benchmark 读取同一组事实来源。**连续能力按需存数据，主动行为存事件，内部过程按需追踪。** 函数返回、模型成功、文件写入不等于任务成功，评测见 [Benchmark](benchmark.md)，施工依据见 [记录方案](event-recording-plan.md)。

## 记录模式

`rsa.json` 的 `logging.diagnostics` 在启动时选择 `normal`（默认）或 `full`，有效值写入 manifest；Python 继承 `RSA_LOG_DIAGNOSTICS`。连接已运行的 Baseware 不会改变它的模式，`rsa status` 的 `logging.diagnostics/basewareDiagnostics` 分别报告两个进程的实际值。

- **normal**：保留模型/工具、主动能力调用、输入动作及终态、控制变化、常驻能力生命周期与故障区间。常驻入口设置 `trace.recordingPurpose="continuous-perception"` 或 `"continuous-action"`，沿嵌套 Python、RSA 转发和 Baseware 传播；连续只读调用子树不写逐次调用事件，也不发逐次 Python 日志 RPC。结果仍由 `@record` 写入 Timeline。
- **full**：额外保存上述内部调用的逐次诊断，写入独立 `diagnostics.jsonl` 或 Baseware 的 `diagnostics/` 分段，不复制已有经历事件和媒体。回放与 Pet 不依赖这一路。

Baseware 只对明确声明只读的查询采用减量；未知能力、有副作用的调用、实际输入、取消、释放和控制变化始终记录。主动 CLI/import 的调用边界也保留，普通后台循环不会仅因频率高被判成常驻调度入口。日志策略不改变权限、参数或真实返回。

连续感知每 5 秒写 `perception_stats`，按能力 ID 与实际 codeSHA 汇总调用/异常次数、耗时 total/min/max，并记录采样尝试、完成、失败、录制数；Baseware 独立写 `device_sampling_stats`。正常停止补尾段，不保留逐次耗时数组。Python 的 `sample/capabilities` 是窗口增量，`video` 是编码器进程累计计数及当前队列快照，`fault.count` 是故障区间累计，不能跨窗口相加。

动作循环同样每 5 秒写 `action_stats`，以 `stepHz/step` 记录频率与窗口增量，其余能力、故障统计口径相同。`action_fault/action_fault_end` 描述故障区间；步骤异常立即停循环，不自动重试。统计是调度与执行证据，不等于设备动作成功。正常循环不逐 tick 刷日志，真实输入及 `action_start/end` 始终保留。

首次错误立即产生 `perception_fault` / `device_sampling_error`，同类重试累加；成功与失败交替不会每帧开关故障。Python 在完整统计窗口无同类错误后结束区间；设备侧还需观察到后续成功，正常停止也会关闭区间。根采样健康通过瞬时状态通知立即更新，不等持久故障恢复。normal 不保存每次重复错误堆栈，full 可查逐次细节；区间内可以有成功尝试，不能解释为全程失败。

## 文件与事件身份

运行日志写在当前 `workspace/logs/<run-id>/`：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 工作区、模型、driver、预算、有效日志模式、Shiori 实现及 `eventSources` |
| `events.jsonl` | RSA 拥有的 schema v2 经历事件 |
| `diagnostics.jsonl` | full 模式的内部调用诊断，按需读取 |
| `streams/` | 模型流事件及 source/trace；新版正文使用内容引用，小事件内联 |
| `payloads/` | 旧版 gzip 请求、响应和工具正文；保留可读，新宿主不再写此副本 |
| `perception/<generation>/` / `action/<generation>/` | 对应入口、实际导入的工作区源码清单 `sources.json`、stderr |

设备事实由 Baseware 独立保存：每个服务实例有 `source.json`、`events/` 与 `diagnostics/`，按一小时或 256 MiB 分段，配小型摘要。RSA 不再把订阅正文抄进 run；manifest 的 `eventSources` 登记 `sourceId/root/format/recordingId/windows`。`recordingId` 是不透明的运行身份，动作开始时冻结，晚到终态仍属于原运行。窗口 `afterSeq/throughSeq` 用于定位和限定无归属背景；显式 `recordingId` 才决定所属 run，晚到已归属事实可以越过窗口。

[统一来源 reader](../shared/event-sources.ts) 按需合并，保留 `origin.eventId` 与来源自己的 seq，不生成新的全局序号。旧 manifest 未声明来源时只读原 run，避免再加读设备档案造成双计。缺源或身份不符明确报错；单个 run 不是自包含包，复制时要带声明的来源依赖，删除 run 不自动回收共享档案。

新观测统一存放在 `workspace/.rsa/timeline/`，跨 run 使用：`video/<id>.mp4` 保存录制图像的视频段，配套 `.mp4.json` 保存编码状态；媒体引用含 `video: {pts,timeBase,width,height}`。`objects/<sha256>.bin` 保存其他去重媒体，`segments/` 保存 JSONL 记录、定长 `.idx` 索引及 `.meta.json` 段摘要。关闭持久化时仅使用有限的 `window-<pid>-…/` 临时窗口。运行事件只引用记录与媒体，不再生成 `run/observations/` 副本。已有 run 的观测附件和日志保持原样可读，不自动迁移或删除。

模型与工具档案位于 `workspace/.rsa/archive/objects/<sha256>.json.gz`，只存文本和结构，大消息、工具定义和正文按内容共享，跨请求、跨 run 去重。引用使用 `encoding: "rsa-json-v1"`、对象路径、内容 hash 和原始 JSON 字节数；对象用 tagged JSON 区分用户数据与内部引用，不占用用户的 `$ref` 等字段。流事件使用 `rsa-stream-v1`，`dataRef` 中不超过 2 KiB 的编码根节点可以内联，避免每个 token delta 占一个文件；大子节点仍共享。所有读者使用 [同一个 codec](../shared/log-archive.ts)。

已知 image/audio 字段、data URL 和 JSON 工具文本中的媒体引用时空轴已有资产；JSON 字符转义不产生媒体副本。未录制媒体只保存 hash、大小和不可恢复原因，不由日志永久留存。默认读取返回媒体引用；完整读取对原样保留的对象加载字节并核验 hash，过期、删除或未录制时明确失败。视频引用标记 `approximate: true`，保存的 hash/bytes 是当时交付身份；Dashboard/历史观测可从视频做视觉复原，`logs read --full` 对有损视频明确报错，不伪造与原始模型请求一致的字节。媒体引用不能冒充 provider 输入。

`events.jsonl` 保留调用身份和统计；工具参数放 `argsRef`，结果和模型消息放 artifact 引用。后台 job 和压缩结果只内联必要的生命周期/数值诊断，完整结构在结果引用中。HTTP 请求保留 wire hash、字节数和编码，JSON/gzip JSON 的正文复用语义对象；恢复 JSON 不等于还原压缩后的网络字节。stream 只存一份 data，raw 中对应的 data 行仅留位置与前缀。

媒体登记通过显式 `registerMedia` 回调，在感知发布、历史解码和模型输入重编码处执行，独立于 `EventLog.record`。后台轻量通知不落成 `timeline_media` 或 `perception_sample` 事件。`observation_media.modelMedia` 仍记录模型实际交付的 hash、帧引用和变换说明，不保存第二套衍生图片。视频媒体状态 `referenced` 只代表引用已登记，是否编码成功以视频段状态文件为准；`gap` 对应 `unrecorded`，不能统计成录像成功。

真正被日志消费的图像另在 `.rsa/archive/media/<sha256>.json` 保存小型 hash→视频引用索引，不保存媒体字节，也不为每个后台采样建立索引文件。内存映射上限为 4096 项，淘汰或 Host 重启后按 hash 读取。相同字节优先复用稳定的有效来源；它是内容重建来源，具体采样时刻仍以观测事件的 record 引用为准。窗口过期或编码失败后，有新来源时可以更新索引。

OMP 原生 session、blob 和恢复机制不改，真实模型输入不替换为日志引用。共享 archive 与 timeline 不是单个 run 的附属文件：只复制或删除 `logs/<run-id>` 不会复制或回收它们。本次不迁移旧日志、不实现自动垃圾回收，避免让历史引用失效；具体施工与验收见 [模型日志引用化方案](indexed-model-log-plan.md)。

manifest 记录 Git commit/dirty、continue/consolidate 提示和可选 workspace AGENTS 的 hash；dirty 不代表代码快照。认证头不入日志。结构见 [events.ts](../rsa/src/harness/events.ts)、[Baseware protocol](../baseware/src/protocol.ts)、[provenance.ts](../rsa/src/harness/provenance.ts)。

每行包含当前写入者的 `runId` 或 `serviceId`、`seq`、墙钟 `at`、单调时钟 `atMs`，以及：

- `source`：职责组件及独立的 implementation/version。
- `origin`：源进程产生一次的 `eventId/clockId/seq/at/atMs`，转发和落盘不改身份。
- `trace`：`traceId/spanId/parentSpanId` 表示调用关系；`epoch/modelCallId/requestId/httpId/toolCallId/operationId` 保留业务身份；`recordingId/recordingPurpose` 表达归属与调用用途；动作 worker 的 `inputGeneration` 区分同 epoch 内的重载代次。
- `type/data`：事件语义和内容。

| source.component | 事实来源 |
| --- | --- |
| `shiori` | Agent Loop、模型、工具、会话和压缩；当前 implementation 为 OMP |
| `rsa` | 外层循环、控制周期、统一能力入口、Python 入口启动 |
| `workspace` | 工作区装饰器函数的实际执行 |
| `baseware` | 设备控制权、Controller 执行和采样 |
| `benchmark` | 评测执行与报告 |
| `dashboard` / `pet` | 日志读取、投影和展示消费 |

顶层时间属于写入者，origin 保留产生事实的进程时间；atMs 只能在同一时钟域内相减，seq 只能在同一来源内比较。墙钟合并顺序是展示顺序，不能代替因果。媒体通过明确引用关联，不用文件路径或读取时间推测采样身份。

## 调用与生命周期

仅按显式 trace 配对，不按时间、当前轮次或名称猜父关联。典型链：Shiori `invoke_agent → chat / execute_tool / compaction`，以及 `capability → python_call → capability → device`。

| 事件 | 契约 |
| --- | --- |
| `capability_start/end` | list/help/call，含参数、ID、epoch 拒绝；终态 success/error/cancelled 与本地耗时 |
| `python_capabilities_start/python_capabilities` | 静态发现的独立子 span |
| `python_capability/result` | CLI runner 的函数位置、源码 hash、参数和结果；属于能力 span 的细节 |
| `python_call_start/end` | 主动装饰器函数调用保留独立 span、PID、实际源码 hash、终态和耗时，不序列化原生参数/返回对象；连续采样仅 full 保存逐次诊断 |
| `command/execution/execution_error` | Baseware 有副作用操作的请求与终态；只读查询逐次记录属于 full，主动查询失败仍保留。`execution.observations` 携带同次返回的观测详情；提交或查询完成不代表动作结束 |
| `action_status` / `action_fault` / `action_fault_end` / `action_stats` | 动作 worker 生命周期、故障区间和固定窗口统计；不同于设备动作终态。生命周期状态进入 Activity/Pet；故障详情和统计保留在诊断分类，避免同一次失败重复弹泡 |
| `action_start/end` | 已提交手柄动作的独立生命周期、actionId 和终态；沿用原 play 请求的 trace/epoch，异步结束不归到后续 wait/status 请求 |
| `observation` | 模型/工具交付的观测事实；旧设备 `observation_start/end/error` 与独立 `observation` 仍可读，新设备详情归入 execution，不另算操作 |

嵌套 Python 和 `rsa_tools.Client` 继承上下文，普通 helper 不追踪。本地 benchmark observer 始终可观察真实执行，不依赖日志 RPC。normal 省略的采样父层标记 `parentOmitted`，不能因没有对应诊断事件推成永久 pending。日志失败不改调用结果、不重试动作；真实已记录 start 缺终态仍为未知。trace 不授予操作权，epoch 校验独立执行。

`python_call_end.outcome=error` 只证明函数抛出异常，外层可能捕获它（例如负向测试）。Dashboard 将它保留为“函数抛异常”诊断，按显式 Python 父关系归组，展示外层返回状态、调用/抛出次数及最近异常；原始事件仍可完整搜索。异常不会覆写工具或后台任务的最终结果，也不按错误文案推断“预期”。缺少原生 bash 父 trace 的直接 import 调用保持未关联，不按 PID 或时间拼接。离线分析保留原始 span 统计，另给 `localPythonExceptions` / `localPythonExceptionGroups`：相邻异常父子调用归为一条异常链，成功祖先截断；异常链数不是任务失败次数。

原生 bash 的 `tool_start/update/end` 保存参数、进度、结果 artifact，Dashboard/Pet 与流中工具调用合并展示。当前不生成自定义 exec/exec_result。插件通过 OMP 缓存注入 workspace/socket/run/epoch；并行 shell 共用环境，不注入单个工具 span，未知父工具/模型轮次不推断。

`details.async/service` 产生 background_start，冻结启动 trace；原生完成通知按 jobId 或 service name+PID 产生 background_result，晚到仍属于原周期。启动成功不等于进程结束，不合并同名不同 PID，不代管后台；缺通知不伪造完成，Agent 可用原生 proc 查询。

动作 stop/reload/故障触发输入重置，释放本 workspace 包括并发 CLI 在内的当前输入，保留 epoch 与预算；worker 生命周期不能替代具体 action/execution 的终态。分析器的 `actionRuntime` 保留显式 epoch 下的状态、故障和统计，包括晚到收尾；故障状态不重复计作故障区间，统计不计作 controllerActions。

## 感知与模型真实输入

`perception_status` 保存感知启动、替换、停止等生命周期；即时采样健康只更新内存，统计与故障按前述窗口保存。`perception_observe_start/end` 记录主动历史查询及读取结果/耗时。`@capability` 统一声明感知和动作能力，`@record` 把成功结果交给常驻 writer 留档；未标记记录的调用不隐式保存。采样器持续调用 `Perception.sample()`，独立动作进程调用 `Action.step()`；普通 import、CLI 和后台程序也能调用被标记的能力，写入同一 workspace 时空轴。

每条记录有 ID、递增 sequence、能力身份及实际加载源码 hash、runId、`recordedAt` 和 `sampling` 区间，以及适用时的 generation、`sampledAt/sources/space`。`recordedAt` 是记录墙钟；`sampling.clock/startedAtMs/finishedAtMs` 是同一进程单调时钟区间；`sampledAt` 由 workspace 提供，表示已知的来源时刻，不能用记录时间伪造设备帧时间。观测可包含文字、任意 JSON 数据和多种媒体，时间与空间信息不局限于视频。记录失败属于能力失败，会抛错；不重试感知调用或动作，也不伪造成功记录。

持久化开启时，媒体按内容哈希保存一次，记录携带 `timeline: {recordId, sequence, asset}` 引用，`asset` 是时空轴根内的相对路径；之后的历史读取不复制或覆盖原件。默认热窗口 600 秒、分段 3600 秒，并受字节预算约束；完整配置见 [Workspace](workspace.md#常驻感知与历史读取)。关闭持久化时记录和媒体只存在于有限窗口，选中媒体交付期间受保护，必要时随响应携带字节，不另建永久审计副本。窗口淘汰或进程关闭后，对应媒体可以过期。

查询开始记录原参数；查询结果返回 `records`、规范化后的 `query` 和分页字段 `hasMore/nextAfter`；`snapshot` 是本页最后一条。默认读取主 `Perception.sample` 能力，可通过 `capability` 筛选其他能力、`capability: "*"` 查询全轴或 `id` 定位记录。`reused` 表示与上一次读取返回相同的一组记录，不代表采样器停止。持久历史跨 reload 和 run 保留，默认最新主观测仍校验当前 generation 与采样健康，不将旧记录冒充当前采样。

**模型看到什么以 `observation_context` 和 `model_start.observations` 为准**，包括工作区自己融合或处理的媒体；不能用最新 driver 截图代替。输入编码失败另记 `perception_input_error`，读取成功不保证输入成功。空实现或失败只给文字诊断，不回退默认截图。取消读取不杀感知进程，迟到结果不塞回已取消的模型调用。

`context_policy` 记录自动感知注入开关的变化；`rsa status.context.perceptionInjection` 报告当前策略。关闭只阻止自动读取/附加，持续采样、录像及显式 `observe` 不受影响。模型文本采用独立的精简投影，记录内容、时间和查询信息各出现一次；`perception_observe_end`、`observation_context` 及原生工具 details 的完整来源结构不变，Dashboard、回放和分析仍据此关联时空轴。

原生 bash/read 返回的图片记录为 `observation(origin=tool_result)` 并关联对应工具，不再自动创建图片副本。插件仅按实际输入字节的 SHA-256 匹配已经存在的时空轴 `objects/<sha256>.bin`，匹配成功时附 `timeline: {asset}`；无法据此确定采样记录，因此不填 `recordId/sequence`。没有原件时只记交付元数据，不声称已保存。后台完成图片在 OMP 将其送入模型时记录为本次交付，不能冒认最近一次前台工具。事件时间是交付时间，不推断原始采样时刻；CLI 历史时间和序号保留在输出标签与查询日志中。仅返回 JSON 路径不计作图片交付。

模型输入重编码产生的版本由同一感知 writer 保存为派生资产，`observation_media.modelMedia` 记录实际 hash、源 asset/record/sequence 和转换名称。只有明确来源才能派生，不按最近截图猜测；临时窗口的派生版本随源记录淘汰。派生存档失败只记诊断，不替换有效模型输入。

Dashboard 从项目注册的 workspace 解析时空轴引用，校验真实路径与目录边界；旧 run 附件仍按原边界读取。记录详情展开时按引用读取单条记录的 `data/space`，不把它们复制回事件；窗口记录仅查询当前宿主，不启动采样。未录制媒体显示交付记录，过期引用返回明确状态并显示过期提示，不渲染失效图片。临时窗口媒体和记录详情不做持久浏览器缓存。

generation 后台 trace 不继承重载请求或控制 epoch，保留 recordingId；查询另有主动调用身份，不重新执行 workspace 采样代码。接口及 reload 见 [Workspace](workspace.md)。

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

Dashboard 的归档读取 worker 负责日志解析和投影，Next 路由通过有界 RPC 调用它；网页与 Alice Pet 共用增量读取客户端。Pet 是展示端，只维护正在展示和待展示的气泡，不再读取完整 run 或自行遍历原始日志；视觉与音频逻辑独立于日志存储。默认产品入口使用生产构建；开发模式的热更新不会把归档解析重新放回 Next 请求的执行上下文。

活动投影读取 events 和模型流，默认展示 thinking/text/tool/system，diagnostic 可选；不读加密推理、不额外请求模型解说。流式内容更新同一块，详情定位原 run/epoch/block；展示筛选不改变日志消费。

Dashboard 的一次性与增量读取共用模型档案 reader，兼容旧 gzip payload 和新 `rsa-json-v1` 引用。新 `rsa-stream-v1` 先跳过出站 `response.create`，只展开入站内容；文字完整还原，媒体保留 `$media` 摘要和时空轴引用，不读取图片/音频字节。新模型档案只在项目注册 workspace 与 manifest 一致时解析，不能由日志引用另一个目录；旧 run 媒体仍以注册工作区为准。正文仅在查询需要时组装，不另存一份完整工具正文或流解析状态。

每个运行的 `.dashboard-index/` 是可重建目录，原始证据不写在里面。它分为三类内容：

- **源事件目录与关系**：每条 events 记录只有一个字节地址，附带时间、类型与调用身份；模型、span、动作、结果和观测的关系条目只指向源事件位置。时间查询使用 `origin.at ?? at`，范围取源时间的最小/最大值，晚到事件不要求按接收顺序排列。
- **按需展示的配方**：Activity 保存源位置，或模型流截止字节数与事件截止位置；不可变版本保留当时的截止点。调用、观测、通知和动作区间也保留位置与必要筛选字段。展示时从原件组装文本与结构，不持久化完整 LogBlock、工具正文或另一份回放事件/帧列表。
- **小型统计与当前状态**：请求耗时、usage、span 终态、计数和运行阶段支持全周期概览。它们可由源事件重新计算，不替代原始事实。

目录按 ID 分页落盘，每页最多 1024 条，超过 256 KiB 时拆分（单条记录不可再拆）；Activity 另存按版本递增的配方页，原始事件地址不重复存历史版本。内存只保留稀疏页摘要和有上限的共享热缓存。关系查询、全量检索、运行概览与回放使用同一源目录，媒体继续引用原有 timeline。

共享索引页缓存默认 256 MiB，按序列化大小的四倍估算解码对象占用；`RSA_DASHBOARD_INDEX_CACHE_BYTES` 可调整，超出预算的单页直接读取，不留缓存。最多保留 3 个闲置/可回收 run，5 分钟无访问后淘汰；对应 `RSA_DASHBOARD_INDEX_MAX_RUNS`、`RSA_DASHBOARD_INDEX_IDLE_MS`。正在读取或刷新的 run 持有租约，不被回收；淘汰只关闭文件和释放索引缓存，历史仍可重新打开。此上限不是整个 Next 进程的内存上限，页目录、单次查询结果及精确统计另占少量内存。

读取检查点保存在 `checkpoint.json`。不兼容的目录格式、源文件替换或截断、缓存写入中断都会使派生目录重建；原始 `events.jsonl`、`streams/`、`payloads/`、archive 和 timeline 不改写。Activity 的展示版本有独立 generation，不使同一源目录上的运行概览重新投影。删除缓存不删除运行证据。

冷目录由一个临时 builder 子进程处理固定的 events/stream 截止，一遍事件扫描同时更新定位、run 与 Activity reducer，最后批量写目录。冷 Activity 每个 block 只生成截止时的最终配方，各有唯一 revision；发布后的增量版本仍不可变，旧 cursor 遇到新 generation 明确重置。全局最多一个 builder，默认共享工作集目标 2 GiB（`RSA_DASHBOARD_BUILD_BYTES`），不是常驻预分配或 RSS 上限。

目录从创建起使用固定的 `generations/<id>/` 路径，完成后原子替换 `active.json`；原始档案仍是唯一事实来源。在途旧读者使用租约，读完后才删除旧目录。构建时已有目录仍可查询，无可读目录时返回 `202 ARCHIVE_PREPARING` 与进度，不能伪装空历史。HTTP 取消只取消查询；有限构建独立完成，成功后进程退出释放临时工作集。显式取消/失败保留状态，用户明确重试才重建，未发布的中间目录不续建。构建中正常追加留给发布后的共享 reducer 增量接续；替换/截断则使此次构建失败。正常增量仍用小批次，已完成的任务不留在长驻 Promise 链里。查询按需展开正文，运行详情最多四路并发，取消会停止后续读取；分页/搜索只保留当前页候选，历史总数和全文搜索范围不截断。worker 的请求队列、超时和 V8 heap 也设上限，它们与索引页缓存分别约束开销，不能把其中任一上限当作整个 Dashboard 进程的总内存。

实时阶段只保存已记录未完成操作的身份、阶段和来源位置，不保存事件正文。新设备调用由 execution/error 收尾，旧设备采集仍识别 observation_end/error；不能等待模型交付才关闭采集，也不为未采集的内部父层创建等待项。

`/api/activity` 提供三种读取：`changes` 按不透明游标交付新增与更新，`history` 按类型/搜索条件分页，`block` 按稳定 ID 定位详情。浏览器和 Pet 共用 changes 客户端，接收成功后推进游标；仅 streams 增长也会产生新版本，旧工具的晚到结果更新原块。第一次连接或索引重建返回快照，Pet 不回放历史气泡；已有队列中的块仍可更新。历史全文搜索按需读文件，开销与搜索范围有关，不以截断历史换速度。

运行概览的统计覆盖整个所选周期，请求详情和观测按页读取。页面标明请求范围，可翻到更早的请求；活动日志保留全量检索入口。`current` 随增量活动提供轻量运行状态，Pet 无需串行请求目录、全量运行详情和全量日志。

full 诊断通过独立 `/api/diagnostics` 按需分页，支持 epoch、时间、trace/span/action/observation 条件，每页最多 500 条；它不进入普通 Activity、回放轨道或 Alice 气泡。正常经历中的诊断类别与 full 原始追踪文件不是同一路。周期采样统计也不产生气泡洪泛。

## 经历回放

Dashboard 的“回放”将感知记录、动作、模型调用、工具和日志放在同一 workspace 墙钟时间轴上。播放器按时间推进，支持暂停、跳转、倍速和来源详情；播放历史不操作设备，也不改变 Alice 关注目标。选中 epoch 时使用该次控制周期的起止，预算结束后的持续采样不会延长这一轮。

回放默认选择最新接管周期，也可选指定周期或全部周期。周期目录直接读取 control 事件，不等待运行统计投影；overview 返回已读范围内的周期和解析后的 epoch，后续画面、事件与媒体链接固定使用该身份。冷目录未读完时同时显示覆盖进度，不能将已发现的周期数当作完整总数。

画面直接读取 `.rsa/timeline/` 的实际采样，包括未送进模型的记录；没有新采样时保持最近画面并显示采样时间。模型调用详情另按输入引用定位，当前播放画面不代表该请求实际看过的图。动作跨度取已记录的 `action_start/end`，未结束保持未知，不用工具提交成功代替动作完成。

`/api/replay` 提供概览、时间窗、来源详情和媒体读取。时间窗最多 60 秒，每页最多 500 条，通过游标继续读取；客户端只保留邻近窗口。画面共用解码缓冲 hook：目标帧所有图片就绪后一起切换，加载期间保留上一帧并标注缓冲，图片容器保持尺寸；同时预读后续两帧（最多 8 张图片、两路请求），超过 32 MiB 的预读缓存会被淘汰。当前与待显示帧保留必要资源，跳转、切工作区或离开页面时释放旧图片；刷新记录可重试失败图片。索引复用可重建 `.dashboard-index/`，只存位置、摘要和引用，媒体和正文仍来自原有 timeline、events 与 archive。持久记录可离线回放；已过期或未记录的内容会明确显示缺失。实现与验收见 [回放施工方案](experience-replay-plan.md)。

从仓库根目录离线分析：

```sh
python3 rsa/scripts/analyze-run.py /path/to/workspace/logs/run-id \
  --epoch epoch-id --output /path/to/analysis.json

# 展开指定事件的正文，默认媒体只显示引用；不启动宿主或模型
rsa/bin/rsa logs read --run /path/to/workspace/logs/run-id --event 123 --field payload
# --ref '<artifact JSON>' 或 --file reference.json 也可定位；--full 才恢复媒体字节

# 逐行读取 run 声明的全部事实来源；full 诊断须显式选择
rsa/bin/rsa logs events --run /path/to/workspace/logs/run-id
rsa/bin/rsa logs events --run /path/to/workspace/logs/run-id --diagnostics
```

分析器按来源流式读取并保留目标 epoch 所需事件，`source.eventCount` 仍计整个读取范围。`startEventId/endEventId` 用于跨来源定位，不能拿不同来源的 startSeq/endSeq 比大小；新 execution 内的观测和旧独立 observation 兼容读取但不双计。

- 模型延迟统计完成请求，p95 用 nearest-rank。缓存率按 token 加权，分母为 `input + cacheRead + cacheWrite`；warm 仅去掉首请求，不排除后续压缩造成的缓存重置。
- 动作频率计成功的 `action_end`，以及不带 actionId、需要控制权且非 readOnly 的成功 execution；提交、查询和等待不重复算动作，采样也不算动作。已提交动作按 `action_start/end` 与 actionId 核查。旧日志缺少这些标记时保留原统计，需查看 argv 区分状态查询。一次 play 可以含多个输入片段，不代表单个按钮次数。独立 observe 是该请求唯一执行的工具为 observe。
- 能力、discovery、本地 Python、Shiori 分层统计，依显式 span 配对，保留 late/pending；本地 Python 不并入设备动作数。
- Shiori usage 与 model usage、工具耗时与内部设备/能力耗时、能力 span 与 Python 详情是包含关系，不能相加。
- 新版工具参数只为技能路径证据按需解引用；缺失时对应计数为未知，`skillArgumentErrors` 保留原因，`skillEvidence` 保留已知成功数，不把缺证据报成零次使用。

帧号变化、exit 0、技能读写均不证明任务推进。Benchmark 故障注入的预期错误不是真实任务故障率；执行、报告、复用证据及其限制统一见 [Benchmark](benchmark.md)。

Benchmark 终态与报告事件携带 `benchmarkRunId/executionStatus/reportStatus/verdict/reportId/previousReportId`。执行完成而评分失败显示“目标未达成”；执行异常和无效报告分别保留错误。修订报告只更新评分，不增加执行次数。CLI 非零退出仍如实记录，它可能表示检查未通过；不能仅凭退出码归因为 Python 崩溃。评测事件位于独立 run，通过 `parentRunId` 关联宿主，不靠 shell 文本关联具体工具；旧事件缺少评分时不推断结果。

设备执行返回的 `result` 保留原生工具结果。设备日志中的同名字段省略 image/audio 的 `data` 或 embedded resource 的 `blob`，通过 observation 的 `contentIndex` 对应内容位置，保留大小和明确的 `timeline` 或 `dataPath/blobPath` 引用；无原件时使用 `dataOmitted/blobOmitted` 标明未留档。API、CLI、MCP 的实际返回仍保留原生内容；日志表示不能直接冒充 MCP 返回值。
