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
  skills/<name>/SKILL.md    可复用方法，可附带代码
  memory/current.md        当前状态与下一步
  .rsa/timeline/           跨 run 的感知记录与唯一媒体原件
  .rsa/shiori/
    sessions/              OMP 会话及其同名资源目录
    current-session.json   默认续接指针
  logs/                    运行、评测与后台服务记录
  ...                      自行组织脚本、数据、模型、实验
```

`rsa init` 写入缺失的 [AGENTS 模板](../rsa/templates/AGENTS.md) 和 [感知模板](../rsa/templates/perception.py)。`AGENTS.md` 可修改或删除，普通启动不补回；Host 启动时按原生项目上下文加载它，保留 OMP 默认系统提示词。修改后需重启 Host。

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
| `Client.call("controller/…", {...})` | 连接 RSA，由 Baseware 执行设备能力；返回完整原生 JSON / 媒体字节；只有显式标记记录的感知能力才永久归档。 |

设备参数由 Baseware 按原生 schema 校验，Python 能力的跨进程 JSON 参数在调用入口校验；本地 import 和 `Client.call("python/…")` 保留普通 Python 对象。已加载模块按 Python 规则缓存，编辑代码后需重跑相应程序。

`@capability` 使顶层同步函数可发现并记录调用；辅助函数无需装饰。发现只读 AST，新增和删除在下次查询可见，跳过日志、`.rsa/` 会话数据、Git、依赖与虚拟环境。函数需 docstring 和参数类型，支持标量、列表、字符串键字典与可空类型；不支持的签名返回诊断。详见 [Python 发现与加载](../rsa/python/rsa_tools/_capabilities.py)。

评测函数使用 `@benchmark`，通过 `rsa bench` 及现有看板管理，不进入 Controller 目录；完整接口见 [Benchmark](benchmark.md)。

## 感知能力与 workspace 时空轴

`@perception` 声明感知能力，隐含 `@capability` 的发现和调用追踪。加 `@record` 后，成功结果进入 workspace 的 `.rsa/timeline/`；未标记记录的调用没有隐式永久存档。两种装饰顺序均可，类方法可以标注，只有顶层函数进入 Controller 目录。

```python
from rsa_tools import perception, record

@record
@perception
def temperature() -> dict:
    """Read a temperature sensor."""
    return {"data": {"value": 22.5, "unit": "C"},
            "space": {"frame": "room"}}
```

感知信封支持 `text`、`data`（任意 JSON）、`media`、`sampledAt`、`sources`、`space`。字段可省略，未知字段明确报错。媒体为 `{mediaType, path}` 或 `{mediaType, data}`（base64）；路径可相对 workspace。设备原生图片可把其 `data/mimeType` 放入信封，不必自己先存文件。`sampledAt` 只填写已知来源时刻，`space` 按设备/算法实际坐标系描述，Harness 不推断空间含义。

记录后返回信封附 `timeline: {recordId, sequence}`，媒体带同轴 `asset` 引用及本机读取路径。相同媒体按 SHA-256 在 `objects/` 共享一份，观测时间点仍独立。嵌套能力按各自标记记录，可在 `sources` 引用内层结果；不会自动保存所有中间数据。

普通 import、`Client.call("python/…")` 和 CLI 都经过同一装饰器。用户函数仍在原 Python 进程运行；只有结果通过 RSA socket 交给已有感知 worker 的单一写入者。没有可用 writer 或记录失败会报错，不会自动重试采样/动作。声明感知不授予设备输入权限，动作仍受 epoch 控制。

## 常驻感知与历史读取

`perception.py:Perception` 在专用 Python 进程中运行：`start(context)` 初始化一次；`sample()` 按 `sample_hz` 连续执行（默认 2 Hz）；`close()` 释放自建资源。context 含 `workspace/runDir/generation`。在 `sample()` 上使用 `@perception` 和 `@record`；sampler 不再隐式保存结果。类实例、模块和模型跨模型轮次保留，慢采样不重叠、不补跑。模板见 [perception.py](../rsa/templates/perception.py)。

```sh
rsa perception status
rsa perception reload
rsa observe
rsa observe --at 2026-10-27T01:00:00Z
rsa observe --capability python/sensors.py:temperature
rsa observe --capability '*' --start 2026-10-27T01:00:00Z --limit 8
rsa observe --id <record-id> --images
rsa perception stop
```

`observe` 只读轴，不重新采样。默认读取主 `python/perception.py:Perception.sample` 通道；`capability` 选其他能力，`*` 读全轴，`id` 定位记录。`at` 读取不晚于指定时刻的记录；`start/end` 为含端点的范围。查询时间按 `recordedAt`（记录墙钟）；`sampledAt` 和单调时钟采样区间另存，不混用。范围按全局 sequence 升序分页，默认 8 条、最多 64 条；用 `nextAfter` 配合原范围续页。未使用字段可省略或传 `null`。

轴跨 run 和 generation 保存。最新主通道读取检查当前采样健康和 generation；历史查询仍可读取旧版本。worker 先初始化轴再加载用户入口，入口缺失、加载失败或采样失败不破坏历史，也不阻止独立感知能力显式记录。没有默认截图回退。`reload` 更换进程并重载代码/helper/权重；`stop` 结束 sampler 和 writer，后续记录需显式 reload。

沿用以下宿主环境变量，生效策略在 `rsa perception status` 的 `history` 中可见：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `RSA_PERCEPTION_HOT_SECONDS` | `600` | 热窗口秒数 |
| `RSA_PERCEPTION_PERSIST` | `1` | `0` 仅保留短期窗口，接受 true/false |
| `RSA_PERCEPTION_SEGMENT_SECONDS` | `3600` | UTC 时间分段长度 |
| `RSA_PERCEPTION_HOT_BYTES` | `67108864` | 热层预算，64 MiB |
| `RSA_PERCEPTION_SEGMENT_BYTES` | `268435456` | 单段预算，256 MiB |

持久模式采样完成即提交分段，冷记录按需查询，不常驻全量索引或图片。关闭持久化后只保留有限临时窗口，停止/reload 清空窗口；响应会携带选中媒体字节，防止读取后淘汰造成交付失效，不另建审计副本。过期由 `availability` 明确返回。持久化开关不删除旧持久档案或用户主动保存的文件，OMP 原生会话和请求记录也是独立范围。

CLI 默认返回 JSON，`--images` 用 OMP 原生终端图像通道交付所选图像，一页最多 32 张/40 MiB；超限需缩小分页，不静默丢图。时空轴可以保存音频/二进制等媒体，但当前模型适配仅直接消费图像及文本/JSON，不宣称支持所有模型模态。普通原生工具图片没有隐式永久归档；若字节与轴中已有媒体相同，Dashboard 可以复用其引用，不猜采集时间。

旧 run 的图片和日志仍可由 Dashboard 查看，不自动导入新轴、不删除旧数据。旧 `Perception.sample()` 和依赖 driver 永久截图路径的脚本需按上述契约适配，Harness 不改写 Agent 的工作区程序。

## 后台程序与人工交还

长程序使用 OMP 原生 `bash` 后台任务或命名服务，通过 `read proc://` 查看、`write proc://<id>/kill` 停止或 `wait` 等待。工具返回不代表程序结束，存活范围遵循 OMP 生命周期。

RSA 插件注入 CLI/Python 路径、workspace、run、socket 和当前 `BASEWARE_EPOCH`，每次接管刷新原生 shell 环境。后台程序保留启动时的 epoch，不因下一轮开始而自动获得新权限。人工交还撤销设备操作权，取消 RSA 管理的在途能力调用；普通 shell 仍按 OMP 管理。程序可以持续做本地计算，但旧 epoch 不能继续输入，不能自行申请或更换 epoch。这里是可信本机开发环境，不是系统级沙箱。
