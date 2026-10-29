# 常驻感知与动作循环

在实时交互环境中，高频采样与高频动作由工作区内的两个独立常驻 Python 进程承担：`perception.py:Perception` 负责持续采集环境状态并写入 `.rsa/timeline/`，`action.py:Action` 负责在 `auto` 周期内持续读取时空轴并下发控制输入。能力装饰器与时空轴信封约定见 [工作区与能力编程](workspace.md)。

下文中的 CLI 命令均在**目标工作区目录**下执行，假定仓库 `rsa/bin` 与 `baseware/bin` 已加入 `PATH`。跨目录操作时，在子命令前传入 `rsa --workspace /absolute/path/to/workspace`。

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

- **采样与自动注入解耦**：`rsa perception inject off` 仅停止在每轮 prompt 开始时向模型自动追加新观测和采样器状态；后台 `sample()`、视频录制与显式 `observe` 查询均照常运行，轮内观察始终由模型显式 `observe` 完成，工具结果不会被追加任何观察。`rsa perception stop` 则会彻底停止采样进程与时空轴 writer，直至下次 `reload`。
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
