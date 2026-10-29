# Workspace 与自适应代码

Workspace 是交由 Agent 与开发者共同演进的普通 Coding 工作区：可以在其中编写感知与控制代码、沉淀技能与记忆、收集数据集并训练模型，而无需改动仓库内的 Harness 或 Driver 源码。

下文中的 CLI 命令均在**目标工作区目录**下执行（假定仓库 `rsa/bin` 与 `baseware/bin` 已加入 `PATH`）。环境安装与服务启停见 [开发与运行](development.md)。

## 文件与会话

### 1. 工作区目录结构

```text
workspace/
├── rsa.json                 # 本机服务启动配置（driver、端口、模型、预算）
├── AGENTS.md                # 可选的工作区专属约定（随 OMP 原生 contextFiles 加载）
├── baseware.json            # 连接设备后自动导出的设备能力与参数 schema 快照
├── perception.py            # 工作区常驻感知入口（Perception 类）
├── action.py                # 工作区常驻动作入口（Action 类）
├── skills/<name>/SKILL.md   # 可复用技能文档与配套脚本
├── memory/current.md        # 当前目标、状态与下一步计划
├── .rsa/
│   ├── timeline/            # 跨 run 共享的 @record 能力记录、MP4 视频段与去重媒体原件
│   ├── archive/             # 模型与工具日志的内容寻址 JSON 归档（媒体引用 timeline）
│   └── shiori/
│       ├── sessions/        # OMP 会话 JSONL 及其同名资源目录
│       └── current-session.json # 默认续接会话指针
└── logs/
    ├── <run-id>/            # 单次 Host 运行或 Benchmark 试验的事件、流与评分记录
    └── background/          # launchd 后台服务日志与状态
```

### 2. 模板与会话生命周期

- **初始化模板**：`rsa init` 会创建缺失的 [AGENTS.md](../../rsa/templates/AGENTS.md)、[perception.py](../../rsa/templates/perception.py) 与 [action.py](../../rsa/templates/action.py) 模板。`AGENTS.md` 可自由修改或删除，后续启动不会强行补回；修改 `AGENTS.md` 后需重启 Host 生效。
- **工作区身份**：工作区的 `realpath` 决定其唯一身份与默认 Unix socket 地址（移动或重命名目录会改变身份）。Dashboard 用于发现工作区的注册文件及历史快照保存在仓库同级的 `../artifacts/rsa/ws-<name>-<hash>/`。
- **会话续接**：重启 Host 默认读取 `.rsa/shiori/current-session.json` 续接上一轮 OMP 会话；`rsa run --new-session` 开启新会话并保留工作区全部代码与文件，`--resume <session.jsonl>` 可指定恢复同一工作区下的历史会话。
- **技能与记忆**：`skills/<name>/SKILL.md` 采用含 `name` 与 `description` 的 YAML frontmatter。Agent 通过 OMP 原生 `read` / `write` / `edit` 工具按需读写技能与记忆，RSA 不会在每轮模型请求中重复推送全量文件索引。

## 发现与调用能力

### 1. 统一能力目录（`rsa controller`）

设备原生 Controller（来自 Baseware）与工作区声明的 Python 能力（来自 `@capability`）共用同一个目录入口：

```sh
# 列出当前所有设备能力与工作区 Python 能力
rsa controller list

# 查看单项能力的输入/输出 JSON Schema 与控制权要求
rsa controller controller/pad.play --help
rsa controller python/perception.py:Perception.sample --help

# 通过 --args 或 --file 传入完整 JSON 参数对象执行调用
rsa controller controller/screen.top.capture --args '{}'
rsa controller python/scripts/nav.py:move_to --file ./move-args.json
```

- `controller/<name>`：由当前连接的 Baseware Driver 提供，Host 启动时会将最新目录快照写入工作区 `baseware.json`（也可随时执行 `baseware export` 刷新）。
- `python/<相对路径.py>:<函数或Class.method>`：由工作区 Python 代码中的 `@capability` 装饰器提供，通过 AST 静态扫描发现，无需启动进程即可查询签名与说明。

### 2. Python 能力声明与四种调用方式

在工作区 Python 代码中使用 `rsa_tools` 声明和调用能力：

```python
from rsa_tools import Client, capability

@capability
def capture_top(exposure: int = 1) -> dict:
    """Capture the top screen with documented typed parameters."""
    return Client().call("controller/screen.top.capture", {})
```

`@capability` 既可用于顶层同步函数，也可用于类方法（如 `Perception.sample`、`Action.step`）。静态发现会扫描工作区代码（跳过 `logs/`、`.rsa/`、`.git/` 与虚拟环境），要求被标记函数具备 **docstring** 与**显式参数类型注解**（支持标量、`list`、`dict[str, ...]` 与 `Optional`），并将顶层同步函数及 `Perception.sample` / `Action.step` 纳入 `rsa controller list` 目录。实现细节见 [_capabilities.py](../../rsa/python/rsa_tools/_capabilities.py)。

不同调用入口的执行位置与数据边界对比：

| 调用方式 | 执行进程 | 参数与返回值 | 适用场景 |
| --- | --- | --- | --- |
| 普通 Python `import` 调用 | 当前 Python 进程 | 原生 Python 对象（可传 PyTorch 模型、NumPy 数组等） | 工作区内部高性能组合、共享进程内模型与缓存 |
| `Client().call("python/...", {...})` | 当前 Python 进程 | 按能力 schema 校验参数，在当前进程内导入并调用 | 按目录 ID 动态派发本地 Python 能力，不经 Host 重开子进程 |
| `rsa controller python/... --args '{...}'` | Host 启动一次性 Python 子进程 | 跨进程 JSON 序列化；调用结束后子进程退出，不保留内存状态 | Agent 在原生 `bash` 工具中通过命令行触发单次 Python 能力 |
| `Client().call("controller/...", {...})` 或 `rsa controller controller/...` | 经 RSA 转发至 Baseware | JSON 参数对象，返回包含原生 `result` 与媒体字节的 `ExecutionResult` | 执行设备输入或采集传感器/屏幕数据 |

## 能力留档与 workspace 时空轴

### 1. `@record` 装饰器与记录信封

仅标记 `@capability` 的函数默认只返回普通 Python 结果，不会向磁盘写入永久档案。当某项感知或动作结果需要沉淀到工作区时空轴时，叠加 `@record` 装饰器（`@record` 与 `@capability` 顺序不限，但 `@record` 必须与 `@capability` 配合使用）：

```python
from rsa_tools import capability, record

@record
@capability
def detect_scene() -> dict:
    """Extract structured scene state and retain the frame on the timeline."""
    return {
        "text": "Title screen ready",
        "data": {"menu": "start", "cursor": 0},
        "media": [{"mediaType": "image/png", "path": "latest.png"}],
        "space": {"frame": "top_screen", "width": 400, "height": 240},
    }
```

`@record` 函数的返回值必须是只包含以下已知字段的字典信封（字段均可按需省略，传入未知字段会直接报错）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `text` | `str` | 面向模型与控制台的简要文字描述。 |
| `data` | 任意可序列化 JSON | 结构化状态数据（展开记录详情或代码读取时使用）。 |
| `media` | `list[dict]` | 媒体列表，每项为 `{"mediaType": "...", "path": "..."}`（支持相对工作区路径）或 `{"mediaType": "...", "data": "<base64>"}`（可直接传入设备截图返回的 `data`）。 |
| `sampledAt` | `str`（ISO 时间戳） | 已知的源采样时刻（不填则仅保留记录完成时刻 `recordedAt`）。 |
| `sources` | `list` | 衍生自其他观测或内层记录的来源引用列表。 |
| `space` | `dict` | 设备或算法定义的坐标系描述。 |

### 2. 单写入者与媒体归档机制

无论在常驻进程、普通 `import` 还是 CLI 中调用 `@record` 函数，计算均在调用方自己的 Python 进程内完成，随后通过 RSA socket 将结果交给当前常驻感知 worker 的**唯一时空轴写入者**落盘，并在返回信封中附带 `timeline: {recordId, sequence}` 及媒体 `asset` 引用（若感知 writer 未运行或写入失败，调用会明确抛错，不会静默吞掉或自动重试动作）：

- **图像流转 MP4 视频段**：图像写入 `.rsa/timeline/video/` 下的短 MP4 视频段（默认 10 秒一段），通过 `timeline.video` 的 `{pts, timeBase, width, height}` 精确定位；热窗口内保留内存原图供实时交付，冷历史查询时按需从已完成视频段解码。
- **非视频媒体内容寻址**：音频、二进制等其他媒体按 SHA-256 哈希去重保存在 `.rsa/timeline/objects/<sha256>.bin`。

## 常驻感知与历史读取

### 1. `perception.py:Perception` 生命周期

`perception.py` 中的 `Perception` 类在独立的常驻 Python 进程中运行（模板见 [rsa/templates/perception.py](../../rsa/templates/perception.py)）：

- `start(self, context)`：进程启动或 `reload` 时执行一次，可在此加载深度学习权重、初始化状态或后台采样线程。`context` 包含 `workspace`、`runDir` 与 `generation`。
- `sample(self)`：需标注 `@record` 与 `@capability`，由调度器按类属性 `sample_hz`（默认 `30.0` Hz，同时作为录像编码的名义帧率）连续调用。若单次采样耗时超过周期，下一次采样会顺延而不会并发重叠或堆积补跑。
- `close(self)`：在 `reload`、`stop` 或 Host 退出时调用，用于释放自建资源。

新工作区的 `Perception.sample()` 默认抛出 `NotImplementedError`，系统不会用默认截图替代未实现的感知；修改 `perception.py`（包括调整 `sample_hz` 或模型权重）后，执行 `rsa perception reload` 即可热替换进程并保留历史时空轴。

### 2. 感知管理与历史查询命令（`rsa observe`）

```sh
# 生命周期与自动注入策略管理
rsa perception status
rsa perception reload
rsa perception stop
rsa perception inject          # 查看当前自动注入策略（on / off）
rsa perception inject off      # 关闭向模型上下文自动追加观测，保留采样与录像
rsa perception inject on       # 恢复自动追加

# 读取时空轴历史（只读已留档记录，绝不触发重新采样）
rsa observe
rsa observe --id <record-id> --images
rsa observe --at 2026-10-27T01:00:00Z
rsa observe --capability python/sensors.py:temperature
rsa observe --capability '*' --start 2026-10-27T01:00:00Z --limit 8
```

- **采样与自动注入解耦**：`rsa perception inject off` 仅停止在每轮 prompt 开始与工具批次结束时向模型自动追加新观测和采样器状态；后台 `sample()`、视频录制与显式 `observe` 查询均照常运行。`rsa perception stop` 则会彻底停止采样进程与时空轴 writer，直至下次 `reload`。
- **查询维度与分页**：默认读取主通道 `python/perception.py:Perception.sample` 的最新记录；`--capability` 可筛选其他 `@record` 能力或传 `'*'` 查询全轴；`--at` 查询 `recordedAt` 不晚于指定时刻的最后一条记录；`--start` / `--end` 按 `recordedAt` 闭区间升序分页（默认 `8` 条，上限 `64` 条，通过返回的 `nextAfter` 传给 `--after` 翻页）。
- **终端图像交付**：在 Agent 的 `bash` 工具中加 `--images` 可通过 OMP 终端图像通道直接将图片送入模型（单页上限 32 张 / 40 MiB）。

### 3. 查询返回结构与错误码

CLI `rsa observe`、Python `Client().observe(query)` 与 OMP 原生 `observe` 工具返回相同的结构化信封 `{queryId, ok, query, records, hasMore, nextAfter?, availability?, error?}`。当 `ok: false` 时，`error.code` 明确区分原因：

| 错误码 | 触发场景 |
| --- | --- |
| `NOT_READY` | 查询最新记录，但所选能力尚未产出可用样本；主通道仍在加载时也返回此码。 |
| `NOT_FOUND` | 指定的 `--id` 不存在，或 `--at` 时刻之前没有任何匹配记录。 |
| `EXPIRED` | 时间或范围查询涉及已淘汰的非持久窗口，且无可读记录返回（若范围查询仅部分过期但仍有可读记录，则返回 `ok: true` 并标记 `availability.expired = true`）。未知 `--id` 始终返回 `NOT_FOUND`，不会推断它曾存在。 |
| `UNAVAILABLE` | 感知进程（时空轴 writer）已停止或在查询中被替换，或最新主通道的采样器不可用（如加载、采样失败）。writer 仍运行时，显式历史查询不受采样器故障影响。 |
| `QUERY_FAILED` | 参数非法、磁盘读取异常或冷视频帧解码失败。 |

### 4. 时空轴存储与编码预算环境变量

宿主进程支持以下环境变量配置时空轴窗口与视频编码参数（当前生效值可通过 `rsa perception status` 的 `history` 字段查看）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RSA_PERCEPTION_PERSIST` | `1` | 设为 `0`（或 `false`）时仅保留内存/临时热窗口，进程停止或 `reload` 即清空。 |
| `RSA_PERCEPTION_HOT_SECONDS` | `600` | 每通道热窗口保留秒数（10 分钟），窗口内原图可直接内存交付；可被工作区设置覆盖。 |
| `RSA_PERCEPTION_HOT_BYTES` | `1073741824` | 热窗口全局字节预算（1 GiB），压力下优先收缩占用最大的通道。 |
| `RSA_PERCEPTION_SEGMENT_SECONDS` | `3600` | 时空轴元数据 JSONL 与索引文件的切段时长（1 小时）。 |
| `RSA_PERCEPTION_SEGMENT_BYTES` | `268435456` | 单段元数据与非视频媒体字节上限（256 MiB）。 |
| `RSA_VIDEO_SEGMENT_SECONDS` | `300` | MP4 视频分段时长（5 分钟）；可被工作区设置覆盖。 |
| `RSA_VIDEO_IDLE_SECONDS` | `10` | 停采后空闲收尾秒数；可被工作区设置覆盖，更改 `sample_hz` 或停止进程时也会收尾。 |
| `RSA_VIDEO_QUEUE_BYTES` | `33554432` | 后台视频编码队列内存上限（32 MiB，含压缩输入与 RGB 缓冲）。 |
| `RSA_VIDEO_QUEUE_FRAMES` | `64` | 后台视频编码队列最大待编码帧数。 |
| `RSA_VIDEO_STREAMS` | `16` | 同时活跃的图像编码流数量上限（超出时最久未用流先收尾）。 |
| `RSA_VIDEO_QUERY_BYTES` | `33554432` | 单次历史冷查询解码输出字节上限（32 MiB）。 |

工作区 `.rsa/settings.json` 可覆盖 `hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds`，优先级为设置文件 > 宿主环境变量 > 内置默认。Dashboard「感知」页编辑草稿后点击“保存设置”，再执行 `rsa perception reload` 生效；“恢复继承”清除对应覆盖值，继续使用宿主环境变量或内置默认值。无运行记录的已登记工作区也可配置。设置页接受范围内的整数秒；手写文件中的有效正数秒可读取并保留，调整相应滑条后才覆盖。字节预算仍由环境变量控制。

视频使用 fragmented MP4（`+frag_keyframe+empty_moov`），约每两秒采样量形成一个关键帧间隔。未收尾段中已完整落盘的片段可供读取，最新尚未落盘的帧明确返回不可读，不用邻帧替代。每段 `.mp4.json` 用 `readableBytes`、`lastReadablePts`（微秒 PTS）、`durationSeconds` 与 `frames` 发布完整片段的可读进度，收尾后更新为最终值。Dashboard 回放按固定字节范围读取，播放超出当前范围后加载新增片段；暂无可读帧时等待进度更新，错误状态不当作成功片段。热窗口按时间过期，字节超限时从占用最大的通道收缩；非持久模式的查询会报告被淘汰的历史缺口，`rsa perception status` 的 `history.budgetEvictions` 随当前进程实时更新。

## 常驻动作

`action.py` 中的 `Action` 类在 `auto` 控制周期内运行于独立的常驻 Python 进程（模板见 [rsa/templates/action.py](../../rsa/templates/action.py)）：

- **方法契约**：`start(self, context)` 在接管或重载时初始化一次（`context` 含 `workspace`、`runDir`、`generation`、`epoch`）；`step(self)` 标注 `@capability`（如需将决策留档至时空轴可加 `@record`），按类属性 `step_hz`（默认 `30.0` Hz）循环执行；`close(self)` 释放资源。
- **读取感知与执行动作**：在 `Action` 中通过 `self.device = Client()` 调用 `self.device.observe()` 读取最新或历史感知记录，并调用 `self.device.call("controller/...", {...})` 下发设备指令。异步 `pad.play` 提交后无需在单步内同步阻塞等待，后续 `step()` 可边观测边决策。
- **生命周期管理**：

```sh
rsa action status
rsa action reload
rsa action stop
```

- **控制权与输入重置边界**：动作进程严格绑定启动时的 `epoch` 与 `inputGeneration`。当人工交还（`auto off`）、预算耗尽或设备断连时，动作进程终止并释放设备输入。在 `auto` 期间执行 `rsa action stop`、`rsa action reload` 或 `step()` 抛出未捕获异常时，系统会**停止动作循环并重置本工作区的全部当前设备输入（包括同轮并发 CLI 提交的按键/触点）**，等待释放完成后保留当前控制 `epoch`、OMP 会话与剩余预算；如果无法确认释放，则交还控制。修复代码后执行 `rsa action reload` 重新启用动作，若已交还控制还需再次 `rsa auto on`。

## 后台程序与人工交还

- **OMP 原生后台任务**：耗时训练、数据分析或辅助脚本可直接使用 OMP 原生 `bash` 工具的异步任务（`async`）或命名服务（`name`），通过 `read proc://` 查看状态、`write proc://<id>/kill` 终止或 `wait` 等待完成。
- **控制租约隔离**：每次 `rsa auto on` 时，RSA 插件会向原生 shell 环境注入最新的 `BASEWARE_EPOCH`。后台程序仅持有其启动时刻的 `epoch`；一旦发生人工交还或周期结束，旧 `epoch` 立即失效，即便后台进程仍在做本地计算，也无法再向设备发送任何输入指令，且不能自行申请新 `epoch`。
