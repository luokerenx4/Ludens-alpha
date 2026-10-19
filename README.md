# Playness · Recursive Self-Adaptation

给 AI 传感器、控制器 CLI 和一个普通工作区，让它自行探索环境，并把经验沉淀为技能。Baseware 提供环境 driver；RSA 将原始设备与工作区 Python 能力统一放进 `rsa controller`，通过 CLI 按需发现和调用，Python API 用于组合。

这个仓库包含四个独立安装、构建的组件：

| 目录 | 职责 | 开发入口 |
| --- | --- | --- |
| [baseware/](baseware/README.md) | 独立设备进程、mGBA / Ryubing driver、CLI / API / MCP | Bun 1.4、Python 3.9+ |
| [rsa/](rsa/README.md) | Harness、Shiori（当前 OMP）、工作区 Python 能力、会话与日志 | Bun 1.4、Python 3.9+ |
| [rsa-dashboard/](rsa-dashboard/README.md) | 读取运行日志、显示看板，并为 Pet 提供本地 HTTP API | Node.js 22+、npm |
| [rsa-companion/](rsa-companion/README.md) | 从 OpenAlice 移植的 Alice Pet，消费日志并呈现气泡、画面与声音 | Node.js 22+、pnpm 11 |

RSA 写入工作区日志，Dashboard 读取日志，Pet 消费 Dashboard API。各组件保留自己的锁文件；OMP 的固定版本修改保存在 `rsa/patches/`。旧研究网站不属于这个仓库。

Shiori 是 Agent Loop 内核的稳定语义名称，OMP 是当前实现。日志分别保留职责来源、实现版本、原事件身份与跨进程调用关系，方便以后比较不同内核；原生 telemetry 与现有模型/设备记录合流到本地日志。详见 [日志契约](rsa/docs/logging.md)。

## 安装与启动

在仓库根目录分别安装依赖：

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
(cd rsa-dashboard && npm ci)
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)
export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PWD/rsa-companion/bin:$PATH"
```

按 [Ryubing 文档](baseware/src/drivers/ryubing/README.md)准备带桥的模拟器、固件与密钥，然后进入任务工作区：

```sh
mkdir -p ../workspaces/my-task
cd ../workspaces/my-task
rsa init --driver ryubing --game /absolute/path/to/game.nsp --seconds 1800
rsa up --dry-run
rsa up
rsa services
rsa auto on
```

`init` 写入本工作区的 `rsa.json`；`up --dry-run` 先显示将使用的命令和路径。`up` 在 macOS 后台启动模拟器、Baseware、Host、Dashboard 和 Pet，已有的本工作区服务会复用。Dashboard 共用 `http://127.0.0.1:3015`；Pet 跟随当前工作区。新 Host 启动后保持手动，执行 `auto on` 才开始模型请求与游戏操作，默认每次接管 30 分钟、最多 1000 次请求。复用已在接管中的 Host 时，`up` 保留现有状态，不打断运行。

停止接管或关闭本工作区：

```sh
rsa auto off              # 交还控制，模拟器与服务继续运行
rsa down --keep-emulator  # 停止 Host、Pet、Baseware，保留当前游戏
rsa down                  # 停止本工作区管理的 Host、Pet、Baseware、模拟器
```

关闭模拟器可能丢失未保存的游戏进度。`down` 默认保留共用 Dashboard；`down --dashboard` 可关闭由本工作区启动的 Dashboard。手动在外部启动的进程不会被关闭。更换预算、模型或加载 Host 代码改动时，修改 `rsa.json` 后执行 `rsa down --keep-emulator`、`rsa up`，即可保留当前游戏并续接原会话。重复 `up` 不重启已就绪的 Host；更换游戏或模拟器启动配置则使用普通 `down` / `up`。

mGBA 使用 `rsa init --driver mgba`，先按 [RSA 文档](rsa/README.md)手动打开 ROM 并加载 Lua 桥；这一入口暂不代装桥。模型访问需要本机 OMP 登录，默认模型为 `openai-codex/gpt-6.1-sol`。原来的 `rsa run` 等独立组件入口仍可用于开发和排查。

## 工作区自己长出的能力

普通 `.py` 文件中的函数用 `@capability` 标记后，可通过 `rsa controller list` 发现、通过单项 `--help` 查看参数。目录按需静态解析源码，不导入执行文件，增删改在下一次查询或调用生效。函数不会自动增加 OMP 的模型工具；CLI 与 Python API 共用目录和执行器，同一次接管的 epoch 和日志关联随调用传递。MCP 当前不注入。

```python
from rsa_tools import Client, capability

@capability
def sample(sensor_id: str, argv: list[str]) -> list:
    """Read a sensor using its documented arguments."""
    return Client().call(f"sensor/{sensor_id}", argv)
```

这里的函数只是接口示例，不会预装进任务工作区。实际方法、脚本和技能由运行中的 agent 自己编写。见 [Baseware 接口](baseware/README.md) 与 [RSA 发现规则](rsa/README.md#工作区-python-能力)。

## 代码与运行数据

任务工作区是任意普通目录，包含 `rsa.json` 启动配置、`AGENTS.md`、`skills/`、`memory/`、`logs/` 和模型自行创建的文件。它不包含 Harness 源码，也不随这个仓库提交。

当前开发约定保留一处仓库外的集中数据目录：**仓库根的同级 `artifacts/`**，即 `<repo>/../artifacts/`。它不是 clone 的内容，首次使用时按需创建：

```text
<parent>/
├── <repo>/                     # 本仓库，顶层是四个组件
├── artifacts/
│   ├── rsa/                    # workspace 索引、OMP 会话、技能版本快照
│   └── switch/                 # Ryubing 源码、SDK 和构建产物
└── workspaces/                 # 示例工作区位置，可换成其他路径
    └── my-task/
        ├── rsa.json
        ├── AGENTS.md
        ├── skills/
        ├── memory/
        └── logs/<run-id>/
```

Host 与 Dashboard 使用同一处 `artifacts/rsa/` 查找工作区。更换代码 checkout 的父目录会更换这处索引；工作区自身的文件不会移动。ROM、固件、密钥和存档由用户在本地管理，不包含在源码里。

## 验证

```sh
(cd baseware && bun run check && bun test)
(cd rsa && bun run check && bun test)
(cd rsa-dashboard && npm test && npm run typecheck)
(cd rsa-companion && pnpm typecheck && pnpm test)
```

默认检查不调用在线模型或操作真实模拟器；真实设备测试需显式开启，命令见各组件文档。Pet 的窗口与音频烟测可单独执行 `pnpm smoke`。

施工与验收见 [Baseware plan](rsa/docs/baseware-plan.md)，架构见 [rsa/docs/architecture.md](rsa/docs/architecture.md)。Alice Pet 保留 [OpenAlice 来源记录](rsa-companion/upstream.json)、[许可证](rsa-companion/LICENSE)和[资源声明](rsa-companion/ui/public/companion/NOTICE.md)。
