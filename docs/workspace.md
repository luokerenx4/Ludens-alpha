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
  logs/                    运行、评测与后台服务记录
  ...                      自行组织脚本、数据、模型、实验
```

`rsa init` 写入缺失的 [AGENTS 模板](../rsa/templates/AGENTS.md) 和 [感知模板](../rsa/templates/perception.py)。`AGENTS.md` 可修改或删除，普通启动不补回；Host 启动时按原生项目上下文加载它，保留 OMP 默认系统提示词。修改后需重启 Host。

Workspace 的 canonical path 决定独立身份与默认 socket。日志在 `logs/<run-id>/`；会话索引、OMP session 和经验版本在仓库同级的 `../artifacts/rsa/ws-<name>-<hash>/`，由 [workspace-state](../rsa/src/harness/workspace-state.ts) 管理。默认重启恢复当前 session；`rsa run --new-session` 新建会话但保留文件，`--resume <session.jsonl>` 只接受同工作区会话。新目录不继承经验，改名或移动也会改变身份。

`SKILL.md` 使用 `name`、`description` frontmatter。循环只注入技能和记忆索引，Agent 按需读写正文，版本关联到日志。

工作区不提交到代码仓库；快照排除根 `logs/`，避免递归复制。

## 发现与调用能力

```sh
rsa controller list
rsa controller controller/<设备能力ID> --help
rsa controller python/scripts/action.py:perform --help
```

`controller/<id>` 来自 Baseware，参数是 driver 定义的 argv；`python/<相对路径.py>:<函数>` 来自工作区装饰器，CLI 用 `--args '<JSON object>'` 传参。以实际目录和 help 为准。

Host 启动 OMP 前刷新 `baseware.json`，也可用 `baseware export` 刷新。它包含能力、控制要求与结果 schema，`bindings` 描述命名参数到 argv 的转换，可选 `stdoutSchema` 描述输出 JSON；不包含 epoch 或 socket。导出只读目录，不采样。契约见 [catalog.ts](../baseware/src/catalog.ts)。

Python 使用统一入口：

```python
from rsa_tools import Client, capability

@capability
def sample(controller_id: str, argv: list[str]) -> dict:
    """Read the selected device capability with its documented arguments."""
    return Client().call(f"controller/{controller_id}", argv)
```

`Client().list()` / `.help(id)` 查询目录，`.call(id, arguments)` 调用设备或本地能力。CLI 与 Python 的区别：

| 入口 | 执行位置与数据 |
| --- | --- |
| 普通 import 后调用 | 当前 Python 进程，可直接传模型、数组等对象。 |
| `Client.call("python/…", {...})` | 当前进程导入并调用，复用模块缓存；嵌套调用不经 Host 重开进程。 |
| `rsa controller python/… --args …` | Host 启动一次 Python 入口，校验参数与源码版本，跨进程结果为 JSON。独立 CLI 调用不共享内存。 |
| `Client.call("controller/…", [...])` | 连接 RSA，由 Baseware 执行设备能力；输出和媒体进入运行日志。 |

JSON 参数校验发生在 CLI 边界；本地 import 和 `Client.call("python/…")` 保留普通 Python 对象。已加载模块按 Python 规则缓存，编辑代码后需重跑相应程序。

`@capability` 使顶层同步函数可发现并记录调用；辅助函数无需装饰。发现只读 AST，新增和删除在下次查询可见，跳过日志、Git、依赖与虚拟环境。函数需 docstring 和参数类型，支持标量、列表、字符串键字典与可空类型；不支持的签名返回诊断。详见 [Python 发现与加载](../rsa/python/rsa_tools/_capabilities.py)。

评测函数使用 `@benchmark`，通过 `rsa bench` 及现有看板管理，不进入 Controller 目录；完整接口见 [Benchmark](benchmark.md)。

## 常驻感知

`perception.py:Perception` 在专用 Python 进程中持续采样，Agent 实现采样、融合和输出。类实例、模块和模型跨轮保留；RSA 将结果写入 `ObservationHistory`，Shiori 的 `observe` 只读取历史，不触发采样。

| 方法 | 契约 |
| --- | --- |
| `start(context)` | 初始化一次。context 含 `workspace`、`runDir`、`generation`。 |
| `sample()` | 采集并返回一次结果；运行时独立于 Shiori 持续调用。 |
| `close()` | 停止自己创建的后台线程或任务，释放资源。 |

类属性 `sample_hz` 指定目标采样率，默认 2 Hz。采样串行执行，慢采样不重叠、不补跑积压；目标采样率不是设备帧率。

结果示例：

```python
{
    "text": "可选说明",
    "media": [{"path": "frames/result.png", "mediaType": "image/png"}],
    "sampledAt": "2026-10-21T06:00:00Z",
    "sources": [],
}
```

结果字段均可选。`sampledAt` 是已知的来源时刻，未知就省略；`sources` 可记录来源。路径可相对 workspace 或为绝对路径，返回的媒体保持不变直到下一次 `sample()` 调用。运行时在采样完成后归档媒体并分配序号，记录完成时刻 `recordedAt` 及单调时钟下的采样区间，详见 [logging.md](logging.md)。

```sh
rsa perception status
rsa perception reload
rsa observe
rsa observe --at 2026-10-22T06:00:00Z
rsa observe --start 2026-10-22T05:59:50Z --end 2026-10-22T06:00:00Z --limit 8 --images
rsa perception stop
```

`observe` 默认读取最新结果；`at` 读取不晚于指定时刻的一条记录；`start/end` 读取含端点的时间范围，可省略一侧。查询时间指 `recordedAt`，不是可选的 `sampledAt`。范围按序号升序分页，默认 8 条、最多 64 条；`hasMore/nextAfter` 表示续页，使用 `--after <nextAfter>` 保留原范围继续查询。`at` 不能和范围混用。OMP 工具使用同名参数；`rsa perception observe` 是同一 CLI 入口。返回的 `records` 包含每条快照、文字和媒体，`snapshot` 指向本页最后一条。

未使用的参数可省略或传 `null`，空白时间字符串也视为未填写。`after: 0` 从历史开头分页，与 `at` 同传时不改变点查；真正的时间条件冲突仍报错。

OMP 的 `observe` 工具直接返回带记录时间的图片。CLI 默认输出 JSON 和文件路径，便于脚本处理；在 bash 中看图用 `--images`，经 OMP 原生终端图片通道交付所选像素。一页超过 32 张图或 40 MiB 时明确报错，缩小 `--limit` 分页，不静默丢图。工具批次已返回图片时不再追加最新截图；没有图片的普通操作仍自动读取最新感知。CLI 查询失败保留非零退出码。

`reload` 关闭旧进程并启动新 generation，重新加载入口、helper 和权重并开始持续采样；不会迁移旧实例内存，已归档历史在本 run 内保留。首条结果生成前处于 loading。普通模型轮次、一次读取取消都不会重启采样。感知进程不继承控制 epoch，只读采样无需接管；它不能自行取得动作权限。

空实现、无可用结果或采样失败只把文字交给模型修复，**没有默认截图回退**；最新读取不会拿旧 generation 或错误前的记录冒充当前结果，`sample()` 出错时历史查询仍可读取已有记录；入口加载失败则需先修复并 reload，磁盘历史保留。原始设备采样仍通过 Controller。连续记录不等于模型已读取，实际输入另有日志。契约源头是 [模板](../rsa/templates/perception.py) 与 [感知 Runtime](../rsa/src/harness/perception.ts)。

## 后台程序与人工交还

长程序使用 OMP 原生 `bash` 后台任务或命名服务，通过 `read proc://` 查看、`write proc://<id>/kill` 停止或 `wait` 等待。工具返回不代表程序结束，存活范围遵循 OMP 生命周期。

RSA 插件注入 CLI/Python 路径、workspace、run、socket 和当前 `BASEWARE_EPOCH`，每次接管刷新原生 shell 环境。后台程序保留启动时的 epoch，不因下一轮开始而自动获得新权限。人工交还撤销设备操作权，取消 RSA 管理的在途能力调用；普通 shell 仍按 OMP 管理。程序可以持续做本地计算，但旧 epoch 不能继续输入，不能自行申请或更换 epoch。这里是可信本机开发环境，不是系统级沙箱。
