# 工作区与能力编程

Workspace 是交由 Agent 与开发者共同演进的普通 Coding 工作区：可以在其中编写感知与控制代码、沉淀技能与记忆、收集数据集并训练模型，而无需改动仓库内的 Harness 或 Driver 源码。

下文中的 CLI 命令均在**目标工作区目录**下执行（假定仓库 `rsa/bin` 与 `baseware/bin` 已加入 `PATH`）。环境安装与服务启停见 [安装与工作区启停](quickstart.md)，常驻 `perception.py` 与 `action.py` 的具体实现见 [常驻感知与动作循环](perception-and-action.md)。

## 文件与会话

### 1. 工作区目录结构

全局目录与工作区分为两层。`LUDENS_HOME` 默认为 `~/.ludens`，不随源码 checkout 移动；它只保存应用配置、可重建的索引、共享缓存与桌宠状态：

```text
~/.ludens/                  # 可由 LUDENS_HOME 覆盖
├── config.json             # {version: 1, workspaceRoot: absolute, defaults: {...}}
├── registry/<id>.json      # {id, workspace, name, updatedAt}，只指向工作区
├── cache/drivers/          # 外部驱动安装缓存
├── logs/baseware/          # 未指定 --data-dir 的独立 Baseware 日志
├── pet/
│   ├── target.json         # 桌宠跟随的稳定 workspace ID
│   ├── consumer.json       # 桌宠消费者心跳
│   ├── profile/            # Electron 偏好与本地缓存
│   └── background/         # 共享桌宠后台日志
└── workspaces/             # 初始 workspaceRoot，可改到任意绝对路径
```

每个工作区独立保存运行所需的状态，移动或备份时应保留整个目录：

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
│   ├── workspace.json       # {version: 1, id: "ws-UUID"}，持久身份
│   ├── settings.json        # 可选的工作区感知热窗口与视频分段参数覆盖
│   ├── skill-versions/      # 技能与记忆的历史内容快照
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

- **初始化模板**：`rsa init --name <name> --driver <id>` 在全局默认父目录下创建工作区，也可传 `--workspace <path>` 指定目录。创建缺失的 [AGENTS.md](../../rsa/templates/AGENTS.md)、[perception.py](../../rsa/templates/perception.py) 与 [action.py](../../rsa/templates/action.py) 模板；全局 `defaults` 复制到新建的 `rsa.json`，之后修改全局配置不影响它。`AGENTS.md` 可自由修改或删除，后续启动不会强行补回；修改后需重启 Host 生效。
- **工作区身份**：`.rsa/workspace.json` 的 ID 是唯一身份，不由目录名称或路径计算。移动后执行 `rsa workspace open <new-path>` 更新全局索引；独立副本用 `open <copy-path> --new-id` 分配新身份并清除当前会话选择。原始会话、技能版本、录制和日志仍在工作区内。registry 丢失后可重新 `open`，`forget <id>` 只注销索引。旧目录需显式 [导入](quickstart.md#已有工作区登记与迁移)。
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

- **图像流转 fMP4 视频段**：图像写入 `.rsa/timeline/video/` 下的 fragmented MP4 视频段（默认 5 分钟一段，空闲 10 秒收尾），通过 `timeline.video` 的 `{pts, timeBase, width, height}` 精确定位；热窗口内保留内存原图供实时交付，冷历史查询时按需从视频段解码。
- **非视频媒体内容寻址**：音频、二进制等其他媒体按 SHA-256 哈希去重保存在 `.rsa/timeline/objects/<sha256>.bin`。

关于如何通过常驻 `perception.py` 持续采样、`rsa observe` 查询时空轴、配置 `.rsa/settings.json` 以及编写 `action.py` 常驻动作，请继续阅读 [常驻感知与动作循环](perception-and-action.md)。

## 后台程序与人工交还

- **OMP 原生后台任务**：耗时训练、数据分析或辅助脚本可直接使用 OMP 原生 `bash` 工具的异步任务（`async`）或命名服务（`name`），通过 `read proc://` 查看状态、`write proc://<id>/kill` 终止或 `wait` 等待完成。
- **控制租约隔离**：每次 `rsa auto on` 时，RSA 插件会向原生 shell 环境注入最新的 `BASEWARE_EPOCH`。后台程序仅持有其启动时刻的 `epoch`；一旦发生人工交还或周期结束，旧 `epoch` 立即失效，即便后台进程仍在做本地计算，也无法再向设备发送任何输入指令，且不能自行申请新 `epoch`。
