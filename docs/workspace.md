# Workspace 与自适应代码

Workspace 是普通 Coding 工作区，可安装依赖、写程序、采集数据、构建训练环境和模型；Harness 与 driver 源码留在仓库中。

下文命令均在**目标 workspace** 执行，假定仓库 `rsa/bin` 已加入 `PATH`。首次安装与服务启动见 [开发说明](development.md)。

## 文件与会话

```text
workspace/
  rsa.json                 本机启动配置
  AGENTS.md                可选的工作区约定
  baseware.json            当前设备能力与调用契约快照
  perception.py            Agent 实现的常驻感知入口
  action.py                Agent 实现的常驻动作入口
  skills/<name>/SKILL.md    可复用方法，可附带代码
  memory/current.md        当前状态与下一步
  .rsa/timeline/           跨 run 的能力记录与唯一媒体原件
  .rsa/archive/            模型/工具日志的共享文本对象，媒体引用时空轴
  .rsa/shiori/
    sessions/              OMP 会话及其同名资源目录
    current-session.json   默认续接指针
  logs/                    运行、评测与后台服务记录
  ...                      自行组织脚本、数据、模型、实验
```

`rsa init` 写入缺失的 [AGENTS 模板](../rsa/templates/AGENTS.md)、[感知模板](../rsa/templates/perception.py) 和 [动作模板](../rsa/templates/action.py)。`AGENTS.md` 可修改或删除，普通启动不补回；Host 启动时按原生项目上下文加载它，保留 OMP 默认系统提示词。修改后需重启 Host。

Workspace 的 canonical path 决定独立身份与默认 socket，改名或移动会改变身份。OMP 会话与默认续接指针在 `.rsa/shiori/`，日志在 `logs/<run-id>/`；技能版本和供 Dashboard 发现 workspace 的注册信息仍在仓库同级的 `../artifacts/rsa/ws-<name>-<hash>/`，由 [workspace-state](../rsa/src/harness/workspace-state.ts) 管理。默认重启续接当前会话；`rsa run --new-session` 按原生语义新建上下文并保留工作区文件，`--resume <session.jsonl>` 选择同工作区的已有会话文件，路径经 realpath 规范化并校验归属。

旧 managed 布局在新 Host 取得 workspace socket 独占权后一次性迁移：整个 `sessions/`（含资源）和当前会话指针进入 `.rsa/shiori/`，旧 `sessions/` 留符号链接，保护历史绝对资源路径。迁移不清空上下文。OMP 全局 blob 存储本次不迁，因此不能仅复制 workspace 就视为完整、独立的会话导出。

`SKILL.md` 使用 `name`、`description` frontmatter。循环只注入技能和记忆索引，Agent 按需读写正文，版本关联到日志。

工作区不提交到代码仓库；快照排除根 `logs/` 和 `.rsa/` 运行状态，避免递归复制及重复打包会话、感知媒体。

## 发现与调用能力

```sh
rsa controller list
rsa controller controller/<设备能力ID> --help
rsa controller python/scripts/action.py:perform --help
```

`controller/<id>` 来自 Baseware，参数是能力 inputSchema 定义的 JSON 对象；`python/<相对路径.py>:<函数>` 来自工作区装饰器；两类能力的 CLI 都用 `--args '<JSON object>'` 或 `--file <参数文件>` 传参。以实际目录和 help 为准。

Host 启动 OMP 前刷新 `baseware.json`，也可用 `baseware export` 刷新。它包含原生工具名称、inputSchema、可选 outputSchema、注解、控制要求及执行结果信封；不包含 epoch 或 socket。导出只读目录，不采样。契约见 [catalog.ts](../baseware/src/catalog.ts)。

Python 使用统一入口：

```python
from rsa_tools import Client, capability

@capability
def sample(controller_id: str, arguments: dict) -> dict:
    """Read the selected device capability with its documented arguments."""
    return Client().call(f"controller/{controller_id}", arguments)
```

`Client().list()` / `.help(id)` 查询目录，`.call(id, arguments)` 调用设备或本地能力。CLI 与 Python 的区别：

| 入口 | 执行位置与数据 |
| --- | --- |
| 普通 import 后调用 | 当前 Python 进程，可直接传模型、数组等对象。 |
| `Client.call("python/…", {...})` | 当前进程导入并调用，复用模块缓存；嵌套调用不经 Host 重开进程。 |
| `rsa controller python/… --args …` | Host 启动一次 Python 入口，校验参数与源码版本，跨进程结果为 JSON。独立 CLI 调用不共享内存。 |
| `Client.call("controller/…", {...})` | 连接 RSA，由 Baseware 执行设备能力；返回完整原生 JSON / 媒体字节；只有显式标记记录的能力结果才永久归档。 |

设备参数由 Baseware 按原生 schema 校验，Python 能力的跨进程 JSON 参数在调用入口校验；本地 import 和 `Client.call("python/…")` 保留普通 Python 对象。已加载模块按 Python 规则缓存，编辑代码后需重跑相应程序。

`@capability` 是感知和动作共用的能力声明，记录实际调用；类方法可标注，只有带参数类型的顶层同步函数进入 Controller 目录。辅助函数无需装饰。发现只读 AST，新增和删除在下次查询可见，跳过日志、`.rsa/` 会话数据、Git、依赖与虚拟环境。函数需 docstring 和参数类型，支持标量、列表、字符串键字典与可空类型；不支持的签名返回诊断。详见 [Python 发现与加载](../rsa/python/rsa_tools/_capabilities.py)。

评测使用 Task 包和 `rsa bench`，由 Shiori 统一运行；工作区 Task 与对应运行绑定可直接被 CLI 和 Dashboard 发现。普通 Python 测量程序直接写入分配的产物目录即可，也可用 `current_trial()` 辅助登记，独立 verifier 评分，不新增 Controller 条目。完整接口见 [Benchmark](benchmark.md)。

## 能力留档与 workspace 时空轴

`@capability` 声明能力；加 `@record` 后，成功结果进入 workspace 的 `.rsa/timeline/`。两种装饰顺序均可，但 `@record` 必须配合 `@capability`。未标记记录的函数保留普通 Python 返回值，包括模型、数组或 None，没有隐式永久存档。

```python
from rsa_tools import capability, record

@record
@capability
def temperature() -> dict:
    """Read a temperature sensor."""
    return {"data": {"value": 22.5, "unit": "C"},
            "space": {"frame": "room"}}
```

记录信封支持 `text`、`data`（任意 JSON）、`media`、`sampledAt`、`sources`、`space`。字段可省略，未知字段明确报错。媒体为 `{mediaType, path}` 或 `{mediaType, data}`（base64）；路径可相对 workspace。设备原生图片可把其 `data/mimeType` 放入信封，不必自己先存文件。`sampledAt` 只填写已知来源时刻，`space` 按设备/算法实际坐标系描述，Harness 不推断空间含义。

记录后返回信封附 `timeline: {recordId, sequence}`，媒体带同轴 `asset` 引用。图像持续编码至 `video/` 短 MP4 段，并由 `timeline.video` 的 `pts/timeBase/width/height` 定位；当前原图通过有界热缓存的内联 `data` 交付，历史冷帧按需解码，不保证存在图片 `path`。其他媒体按 SHA-256 在 `objects/` 共享一份，观测时间点仍独立。嵌套能力按各自标记记录，可在 `sources` 引用内层结果；不会自动保存所有中间数据。

普通 import、`Client.call("python/…")` 和 CLI 都经过同一装饰器。用户函数仍在原 Python 进程运行；只有结果通过 RSA socket 交给已有感知 worker 的单一写入者。没有可用 writer 或记录失败会报错，不会自动重试采样/动作。声明能力不授予设备输入权限，动作仍受 epoch 控制。

## 常驻感知与历史读取

`perception.py:Perception` 在专用 Python 进程中运行：`start(context)` 初始化一次；`sample()` 按 `sample_hz` 连续执行（默认 30 Hz）；`close()` 释放自建资源。AI 可修改类上的 `sample_hz`，执行 `rsa perception reload` 生效。context 含 `workspace/runDir/generation`。在 `sample()` 上使用 `@capability` 和 `@record`；sampler 不再隐式保存结果。类实例、模块和模型跨模型轮次保留，慢采样不重叠、不补跑。模板见 [perception.py](../rsa/templates/perception.py)。

装饰器标记的是任意能力，不限定屏幕数量或媒体类型；`@record` 在能力实际调用成功时记录。自动定频调度只调用主 `Perception.sample()`，不会为每个被标记的能力另开循环。录像编码器共用 `sample_hz` 作为名义频率，缺省也是 30；没有独立 FPS 配置。独立能力仍按实际调用时间记录，视频不按名义频率重采样；频率改变后开启新视频段。

```sh
rsa perception status
rsa perception reload
rsa perception inject off
rsa perception inject on
rsa perception inject
rsa observe
rsa observe --at 2026-10-27T01:00:00Z
rsa observe --capability python/sensors.py:temperature
rsa observe --capability '*' --start 2026-10-27T01:00:00Z --limit 8
rsa observe --id <record-id> --images
rsa perception stop
```

`observe` 只读轴，不重新采样。默认读取主 `python/perception.py:Perception.sample` 通道；`capability` 选其他能力，`*` 读全轴，`id` 定位记录。`at` 读取不晚于指定时刻的记录；`start/end` 为含端点的范围。查询时间按 `recordedAt`（记录墙钟）；`sampledAt` 和单调时钟采样区间另存，不混用。范围按全局 sequence 升序分页，默认 8 条、最多 64 条；用 `nextAfter` 配合原范围续页。未使用字段可省略或传 `null`。

**持续采集与模型自动注入独立控制。** `rsa perception inject off` 关闭 prompt 开始和工具批次结束时自动附加的感知；sampler、时空轴 writer、录像和历史查询继续运行，模型可随时显式 `observe`。`inject on` 恢复自动附加，`inject` 查询当前策略，`rsa status` 的 `context.perceptionInjection` 也可查看。默认开启，修改立即作用于后续自动读取；同 Host 内跨感知 reload 和控制周期保留，新 Host 恢复默认。已经进入 OMP 的历史消息不会被改写，原生工具主动返回的图片也不受此开关影响。关闭注入后仍附加控制状态和技能/记忆索引。

CLI、Python `Client().observe()` 与原生 observe 工具共用一个查询结果：`{queryId, ok, query, records, hasMore, nextAfter?, availability?, error?}`。`queryId` 就是本次查询的 trace span ID；记录平铺 `id/sequence/generation/capability/recordedAt/sampledAt/sampling/text/data/space/sources/media`，归档身份和来源只在这一份记录中出现。没有顶层 `snapshot`、假执行 `result`、全局 `reused` 或采样健康 `status`；采样健康单独用 `rsa perception status` 读取。`media` 按记录顺序交付，保留媒体 ID、类型与实际媒体/时空轴引用。分页继续使用原范围和 `nextAfter`，不会重新采样。

`ok` 只表示本次查询成功。普通范围无记录或游标已读完时返回成功空页；无最新样本返回 `NOT_READY`，`id/at` 未匹配返回 `NOT_FOUND`，时间/范围涉及已淘汰窗口且无可读记录时返回 `EXPIRED`，writer 不在或主感知不可用时返回 `UNAVAILABLE`，查询/解码失败返回 `QUERY_FAILED`。错误格式为 `{code, message}`；部分范围已过期但仍读到记录时保留成功页及 `availability.expired=true`，不掩盖缺失。未知 ID 仍为 `NOT_FOUND`，不凭窗口淘汰推断这个 ID 曾存在。主通道最新读取保护当前 generation；显式历史查询不受 sampler 加载或采样故障影响。CLI 的进程退出码由 `ok` 决定，取消不伪装成失败页。

原生 observe 与 CLI `--images` 共用一份精简模型视图：每条记录保留 ID、时间、能力/代码版本、`text/data/space/sources` 及对应媒体 ID/类型，再附查询、分页与可用范围。内部 trace、run、timeline 路径与重复 identity 不进入模型文本。日志保留一份记录及完整来源，去掉媒体字节和 `data/space`；工具 details 只给出 `queryId/ok` 供关联，不再复制内容。工具批次中的显式 `observe` 不再被自动附加一遍，包括同批还有 bash 的情况。时空轴磁盘记录无需重写；旧查询信封不在在线 API 中兼容，工作区程序需按新契约读取 `records[].text/media`。

轴跨 run 和 generation 保存。最新主通道读取检查当前采样健康和 generation；历史查询仍可读取旧版本。worker 先初始化轴再加载用户入口，入口缺失、加载失败或采样失败不破坏历史，也不阻止独立感知能力显式记录。没有默认截图回退。`reload` 更换进程并重载代码/helper/权重；`stop` 结束 sampler 和 writer，后续记录需显式 reload。

沿用以下宿主环境变量，生效策略在 `rsa perception status` 的 `history` 中可见：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `RSA_PERCEPTION_HOT_SECONDS` | `600` | 热窗口秒数 |
| `RSA_PERCEPTION_PERSIST` | `1` | `0` 仅保留短期窗口，接受 true/false |
| `RSA_PERCEPTION_SEGMENT_SECONDS` | `3600` | UTC 时间分段长度 |
| `RSA_PERCEPTION_HOT_BYTES` | `67108864` | 热层预算，64 MiB |
| `RSA_PERCEPTION_SEGMENT_BYTES` | `268435456` | 元数据及非视频媒体单段预算，256 MiB |
| `RSA_VIDEO_SEGMENT_SECONDS` | `10` | 视频段时长；停采或停止进程时也会收尾 |
| `RSA_VIDEO_QUEUE_BYTES` | `33554432` | 编码队列预算，包含压缩输入与 RGB 大小；也限制单帧解码尺寸 |
| `RSA_VIDEO_QUEUE_FRAMES` | `64` | 编码队列帧数上限 |
| `RSA_VIDEO_STREAMS` | `16` | 同时保持的图像流数上限；新流令最久未用流收尾 |
| `RSA_VIDEO_QUERY_BYTES` | `33554432` | 单次历史查询媒体字节预算；超限需缩小分页 |

持久模式采样完成提交记录元数据，图像由有界后台队列编码。时空轴元数据默认一小时分段，视频默认 10 秒分段；每个视频段的 `.mp4.json` 状态区分 pending/ready/error。热图像可在编码期间直接用于当前观测；冷查询需已完成的视频段，积压丢录制帧明确记为 gap。视频按实际 recordedAt 的间隔赋予 PTS，保留来源 sampledAt，不补造帧。历史解码是高质量有损复原，不声称还原当时模型输入的逐字节内容。冷记录按需查询，不常驻全量索引或图片。关闭持久化后只保留有限临时窗口，停止/reload 清空窗口；响应会携带选中媒体字节，防止读取后淘汰造成交付失效，不另建审计副本。过期由 `availability` 明确返回。持久化开关不删除旧持久档案或用户主动保存的文件，OMP 原生会话仍属独立范围；RSA 模型日志仅引用这些媒体，不让临时窗口变成永久档案。

编码器、Python 和图像库还会使用原生内存，上表不是进程 RSS 上限。冷视频解码在采样锁外执行；Dashboard 离线解码限制为 2 个并发、16 个等待请求，单次 20 秒／32 MiB 输出。MP4 末帧在没有下一次采样时使用 `1 / sample_hz` 秒尾长（按微秒取整，至少一微秒），回放随后保持最后画面，不代表补采了后续帧。

CLI 默认返回 JSON，`--images` 用 OMP 原生终端图像通道交付所选图像，一页最多 32 张/40 MiB；超限需缩小分页，不静默丢图。时空轴可以保存音频/二进制等媒体，但当前模型适配仅直接消费图像及文本/JSON，不宣称支持所有模型模态。普通原生工具图片没有隐式永久归档；若字节与轴中已有媒体相同，Dashboard 可以复用其引用，不猜采集时间。

旧 run 的图片和日志仍可由 Dashboard 查看，不自动导入新轴、不删除旧数据。旧装饰器、`Perception.sample()` 和依赖 driver 永久截图路径的脚本需按上述契约适配，Harness 不改写 Agent 的工作区程序。

## 常驻动作

`action.py:Action` 在独立 Python 进程中运行：`start(context)` 初始化一次；`step()` 按 `step_hz` 执行（默认 30 Hz，可调）；`close()` 释放资源。`step()` 使用 `@capability`，需要记录决策或结果时再加 `@record`，返回同一记录信封。context 含 `workspace/runDir/generation/epoch`；实例、模块和模型跨 Shiori 轮次保留，慢步骤不重叠、不补跑。模板见 [action.py](../rsa/templates/action.py)，没有预设控制策略。

动作通过 `Client().observe(query)` 读取同一时空轴，返回与 `rsa observe` 相同的查询结果；默认取感知主通道最新记录。动作留档仍交给感知 writer，不另存一套媒体。感知进程停止时查询和记录明确失败。

```sh
rsa action status
rsa action reload
rsa action stop
```

manual 时不运行动作 worker，`reload` 只启用待加载状态；成功接管后启动。auto 时 `reload` 收尾旧代并加载新代码、helper 与模型。`stop` 禁用本宿主内的动作自动启动，直到显式 `reload`。步骤异常会停循环，避免下一帧自动重做已经部分执行的动作；错误可在 status 和日志查看，修复后 reload。

动作 worker 固定持有启动时的 epoch 和 inputGeneration。人接管、预算结束、断连或 Host 退出会停止 worker 并释放输入；下次接管使用新 worker，不保证跨 epoch 保存内存状态。旧代不能凭同一 epoch 继续输入。

**动作 stop/reload/故障会重置本 workspace 的全部设备输入，包括同轮并发 CLI 已提交的输入。** 重置取消旧动作、释放按键/触点并等待收尾，保持当前控制 epoch、OMP 会话和剩余预算；无法确认释放则交还控制。感知进程独立继续运行。

## 后台程序与人工交还

长程序使用 OMP 原生 `bash` 后台任务或命名服务，通过 `read proc://` 查看、`write proc://<id>/kill` 停止或 `wait` 等待。工具返回不代表程序结束，存活范围遵循 OMP 生命周期。

RSA 插件注入 CLI/Python 路径、workspace、run、socket 和当前 `BASEWARE_EPOCH`，每次接管刷新原生 shell 环境。后台程序保留启动时的 epoch，不因下一轮开始而自动获得新权限。人工交还撤销设备操作权，取消 RSA 管理的在途能力调用；普通 shell 仍按 OMP 管理。程序可以持续做本地计算，但旧 epoch 不能继续输入，不能自行申请或更换 epoch。这里是可信本机开发环境，不是系统级沙箱。
