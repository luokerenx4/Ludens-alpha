# 运行日志契约

日志是事实来源。分析器、Dashboard 和 Pet 从中生成各自视图；模型或函数执行成功不等于环境任务成功。本阶段提供可核对的数据，不实现游戏评分器或 benchmark runner。

## 职责与来源

| source.component | 职责 | 当前实现 |
| --- | --- | --- |
| `shiori` | Agent Loop、模型请求、工具调度、会话/压缩 | `implementation=omp`，`implementationVersion=18.9.1` |
| `rsa` | 环境循环、控制周期、统一能力入口、工作区 Python | RSA 宿主 |
| `baseware` | 设备操作权、Controller、Sensor | 独立 Baseware 服务；driver 信息见 manifest |
| `dashboard` | 日志投影、读取高水位 | Dashboard activity API |
| `pet` | 读取日志、气泡队列、提交展示 | Alice Pet |

Shiori 是稳定的架构角色，不是 OMP 的另一个包名。代码仍在 `src/harness/omp/`；换内核时保留角色，改变实现标注。实现配置和模型仍分别记录，不能仅凭角色名比较性能。

## 事件与时间

RSA 和 Baseware 的 schema 2 JSONL 包含：

- `runId` 或 `serviceId`、`seq`、`at`、`atMs`：当前写入者的文件顺序与时间。
- `source`：产生事实的组件和实现。
- `origin`：`eventId/clockId/seq/at/atMs`。Baseware 生成一次，落盘和转发保持不变；RSA 复制观测文件后可替换本地路径，但不重新创造事实身份。
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
└── execute_tool            OMP 工具调用
    └── capability          rsa controller / rsa_tools.Client
        ├── discovery       静态发现 Python 函数
        ├── capability      宏内部调用另一个能力
        │   └── device      Baseware execute / observe
        └── device
```

`capability_start/end` 覆盖 list/help/call，含参数/ID/epoch 拒绝。`outcome` 为 `success/error/cancelled`，终态带本地 `durationMs`。同一工具内并发调用相同函数也使用不同 span。

`python_capability/result` 是能力 span 的细节，保存函数位置、源码 hash、参数与结果。进程启动异常和取消均记录终态后沿原路径抛出；普通 Python helper 内部语句不逐行打点。`python_capabilities_start/python_capabilities` 对应独立 discovery 子 span。直接调用 Python runner 也生成独立 span。

Baseware 为每次设备操作生成子 span，`command/execution/execution_error` 和 `observation_start/end/error` 配对。trace 是观测信息，不授予操作权；epoch 校验和取消行为保持独立。

OMP 的 `shiori_span_start/end` 使用原生 OTel ID；局部 BasicTracerProvider 负责生成真实 ID 和取得最终状态，不注册全局 provider。`captureMessageContent=none` 避免再复制一份正文；原始请求仍保留在现有 payload 中。`shiori_run_end` 原样保存原生 summary/coverage，范围是一次 `agentLoop`，一次 RSA 接管可含多个 loop。OMP 工具覆盖只认识 read/write/edit/exec/observe；宏覆盖须看能力日志。

后台候选在 OMP 创建时通过 `omp.compaction.speculation` diagnostics channel 固定 `operationId`，RSA 用 AsyncLocalStorage 保留创建时的 epoch 和子 span；HTTP 是该候选的子 span，重试声明复用候选身份。候选准备以 `started → armed / failed / cancelled` 闭合，后续 `waiting / applied / invalidated` 仍引用同一 operation。`armed` 表示摘要可用，`applied` 只表示选中候选进入提交；HTTP end 只表示收到响应头。前台 `auto_compaction_start/end` 是另一段维护 span，结束事件保留开始时身份与单调时钟耗时。以上均不改变压缩调度、阈值或请求内容。

事件归属按显式 `trace.epoch`，不按写入时的当前周期或控制事件序号截断；交还控制后的完成、重试和清理仍留在原 epoch。控制起止只决定活跃时长和动作频率分母。旧日志缺失的候选身份保持未知，不按时间相邻、snapshot leaf 或当前 epoch 补猜。

## 消费与分析

Dashboard 的 activity 投影保留来源和调用关联，并返回投影耗时与读取高水位。Pet 的读取、队列变化和 `display_dispatched` 写入 `workspace/logs/consumers/`，每进程独立文件；无变化的轮询不重复记录。提交展示表示主进程调用了展示接口，不证明屏幕已经完成绘制。连接时略过已完成历史是展示策略，不作为日志丢失。

`python3 scripts/analyze-run.py <run> --epoch <epoch>` 离线生成分析：

- 原有模型/工具/设备/观测/压缩指标；时延统计增加 nearest-rank p95。
- 按 source 统计事件；能力、Python 调用与 discovery 按显式 span 配对，保留 late cleanup 和 pending。
- Shiori spans 与原生 loop summary 单列；旧日志缺 span 时不从名字/顺序猜测宏调用。

**禁止相加的包含关系**：原生 Shiori usage 与现有 model usage；工具耗时与其内部 exec/宏/设备耗时；capability span 与 Python 细节耗时。上述数据描述同一工作的不同层次。

现有 hooks 仍不能拆开上传、网络和服务端排队。源帧号前进、宏 exit 0、skill 被读取或写入都不证明任务推进。环境评分、能力收益和固定 benchmark case 留给独立评测层，不能把游戏知识放进 Harness。
