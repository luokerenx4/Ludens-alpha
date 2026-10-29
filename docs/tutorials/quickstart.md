# 安装与工作区启停

本篇介绍如何安装 Ludens 各组件、配置 Python 运行时，以及使用 `rsa init / up / auto / down` 管理工作区的日常生命周期。模拟器与桌面驱动的具体准备步骤见 [设备与驱动准备](devices.md)，单组件前台调试、包脚本约定与测试见 [控制台调试与验证](debugging-and-verification.md)。

除显式 `cd` 到目标工作区外，文内命令均在仓库根目录执行。`../artifacts/` 为仓库外的本地构建与运行状态目录；工作区、ROM、固件、密钥与游戏存档均保存在仓库外，不进入源码树。

## 安装

### 1. 环境前提与凭据

- **操作系统**：完整后台服务编排（`rsa up` / `rsa down` / `rsa services`）依赖 **macOS launchd**。
- **工具链**：准备 **Bun 1.4**、**Python 3.12+**、**Node.js 22.x（22.13 起）或 24+** 与 **uv**。可选桌宠另需 **pnpm 11**。
- **模型凭据**：启动 Agent 前需在本机完成 **OMP 模型登录**。RSA 固定使用 **OMP 18.9.1** 并直接复用其凭据存储，默认模型为 `openai-codex/gpt-6.1-sol`。

### 2. 安装核心组件

默认安装 Baseware、RSA 与网页 Dashboard，各组件及 RSA Python 运行时分别维护独立锁文件。安装 `rsa` 时，Bun 会按 `package.json` 自动应用 [rsa/patches/](../../rsa/patches/) 下的 OMP 依赖补丁：

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
uv sync --project rsa/python --frozen
(cd rsa-dashboard && npm ci && npm run build)

export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PATH"
```

`export PATH` 仅对当前终端生效；新开终端请同步配置 shell profile 或使用 `baseware/bin/baseware`、`rsa/bin/rsa` 绝对路径。

### 3. Python 运行时解析规则

[rsa/python/pyproject.toml](../../rsa/python/pyproject.toml) 与 `uv.lock` 管理正式 `ludens-rsa` 包（导入名 `rsa_tools`）以及 PyAV、Pillow、jsonschema 等媒体与校验依赖。`rsa_tools` 仅提供能力声明、客户端与试验登记辅助，执行生命周期与评分由 Shiori 统一管理。

框架按以下优先级选择 Python 解释器：

1. 显式环境变量 `RSA_PYTHON`；
2. 仓库内置虚拟环境 `rsa/python/.venv/bin/python`；
3. 系统 `PATH` 中的 `python3`。

OMP 原生 shell 会自动注入 `RSA_PYTHON`。在工作区脚本中若需复用 `rsa_tools` 及框架依赖，应调用 `"$RSA_PYTHON" script.py`；直接运行裸 `python3` 仍遵循用户 login shell，不等同于框架虚拟环境。若将 `RSA_PYTHON` 指向外部训练环境（如包含 PyTorch 的 conda/venv），需在该环境中预先安装 `rsa/python` 包及其依赖。

`rsa up` 新建后台服务时会保留当前环境中的 `RSA_PYTHON`。若服务已经运行，修改终端环境不会更新它；需停止并重新启动相关服务后才会使用新解释器。

## 可选桌宠

默认通过浏览器访问 Dashboard，运行游戏与查看控制台无需安装 Electron。需要 Ludens Pet 时，准备 **pnpm 11**，在仓库根目录执行：

```sh
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)
```

新建工作区时，在所选 `rsa init --driver ...` 命令中追加 `--pet`，显式启用桌宠。已有工作区可在 `rsa.json` 设置 `"pet": true`，下次 `rsa up` 时按需启动；已有文件中的显式 `pet: true` 保持启用。设为 `"pet": false` 可在后续启动时仅使用网页控制台。

也可用 `rsa up --pet` 或 `rsa up --no-pet` 仅覆盖本次启动，不修改 `rsa.json`；这两个选项不能同时使用。`pet: false` 和 `--no-pet` 都不会关闭已经运行的共享桌宠，需从桌宠托盘菜单选择 Quit 退出。

桌宠需要可用的 Dashboard，与浏览器使用同一份控制台和日志。默认 `dashboard: true` 会按需启动 Dashboard；设为 `false` 时需自行启动。需要单独启动或调试时，见 [Ludens Pet 桌面伴侣](debugging-and-verification.md#3-ludens-pet-桌面伴侣)。

## 工作区启动与停止

### 1. 初始化与生命周期命令

先按 [设备与驱动准备](devices.md) 准备好目标环境，再在仓库外新建目录作为工作区。以下以 Azahar 为例，显式选择固定提交的外部驱动包；mGBA、Ryubing 使用各自的 [可选包](devices.md#外部驱动包发现与接入)，内置桌面驱动使用 `--driver cua`：

```sh
mkdir -p /absolute/path/to/workspace
cd /absolute/path/to/workspace

rsa init --driver azahar \
  --driver-package github:luokerenx4/ludens-3ds-driver#5b9b1f4032a5973a8882aa23957c3c34da50af9e \
  --game /absolute/path/to/game.3ds --seconds 1800
rsa up --dry-run
rsa up
rsa services
rsa controller list
rsa auto on
```

已有模拟器工作区请按 [外部驱动迁移说明](devices.md#外部驱动包发现与接入) 添加 `driverPackage`，不要重新执行 `rsa init`。默认启动路径来自各驱动的构建缓存；沿用已安装应用时，每次 `up`（含 `--dry-run`）需传入 `RSA_AZAHAR_APP` 或 `RSA_RYUBING_APP`。

常用工作区与控制命令速查：

| 命令 | 行为与边界 |
| --- | --- |
| `rsa init` | 生成 `rsa.json` 及缺失的 `AGENTS.md`、`perception.py`、`action.py` 模板，绝不覆盖已有文件。默认使用网页控制台；加 `--pet` 显式启用已安装的桌宠。 |
| `rsa up --dry-run` | 校验配置并打印完整进程启动计划，不实际拉起服务；需要新启动 Dashboard 时，实际 `rsa up` 才执行其构建检查。 |
| `rsa up [--pet / --no-pet]` | 按需启动或复用模拟器、Baseware、Host 与 Dashboard；按 `pet` 设置启用桌宠，也可用互斥的 `--pet` / `--no-pet` 仅覆盖本次启动，不写回配置。新启动的 Host 处于 `manual` 模式；若复用已在 `auto` 运行的 Host 则继续原控制周期。重复 `up` 不会热加载修改后的 `rsa.json`，复用现有 Dashboard 也不会热更新其构建。 |
| `rsa services` | 查询当前工作区关联的 launchd 任务 PID、状态与最近退出码。 |
| `rsa auto on [--message '文本']` | 开启新控制周期（生成新 `epoch`，重置时间与请求预算）并向模型发起推理。`--message` 仅在该次接管的首轮附加一次，后续续轮不重复注入。 |
| `rsa auto off` | 立即撤销设备操作权并取消 RSA 管理的在途调用，模拟器保持运行；需等待当前周期清理完毕后方可再次 `auto on`。 |
| `rsa action status / reload / stop` | 管理工作区 `action.py` 常驻动作进程。`manual` 下 `reload` 仅标记就绪；`auto` 下 `stop` 或 `reload` 会清空本工作区全部当前设备输入（含并发 CLI 输入），释放成功后保留当前 `epoch`、OMP 会话与剩余预算。详见 [常驻感知与动作循环](perception-and-action.md#常驻动作)。 |
| `rsa down --keep-emulator` | 交还控制权并停止 Host 与 Baseware，保留模拟器窗口与游戏现场；适合修改 `rsa.json`（如预算或模型）后重新 `rsa up`。 |
| `rsa down [--dashboard] [--pet]` | 停止本工作区受管的 Host、Baseware 与模拟器（**执行前请先在游戏内保存进度**）。默认保留共享的 Dashboard 与已运行的 Ludens Pet；附加 `--dashboard`（仅限启动它的工作区）或 `--pet` 可一并关闭对应共享服务。 |

跨目录操作工作区时，可在任意命令前传入 `rsa --workspace /absolute/path/to/workspace <subcommand>` 或设置环境变量 `RSA_WORKSPACE`。

### 2. `rsa.json` 配置参考

`rsa.json` 由 [rsa/src/app/workspace.ts](../../rsa/src/app/workspace.ts) 解析校验，未知字段会直接报错：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `driver` | 必填 | 驱动 ID；当前仅 `cua` 内置，模拟器 ID 须与外部包导出的 `id` 一致。 |
| `driverPackage` | 无 | 外部驱动包地址（npm spec、`github:org/repo#rev` 或 `file:path`）；模拟器驱动必填，`cua` 可省略。接入方式见 [设备与驱动准备](devices.md#外部驱动包发现与接入)。 |
| `game` | 无 | 支持自动启动的 bridge 驱动可选（路径相对工作区）；省略时连接已手动启动的模拟器。`mgba` 与 stdio 驱动不接受此字段。 |
| `port` | 随驱动 | 显式端口优先，否则取驱动 manifest 的 `defaultPort`（现有外部包：mGBA `47653`、Ryubing `47663`、Azahar `47673`）；stdio 驱动不使用。 |
| `cuaCommand` | `"cua-driver"` | 仅 stdio 驱动有效，指定后端可执行文件路径或命令名。 |
| `model` | `"openai-codex/gpt-6.1-sol"` | 具备图像输入能力的 OMP `provider/model` 标识。 |
| `seconds` | `1800` | 单次 `auto on` 控制周期的时长预算（秒），每次接管重置。 |
| `requests` | `1000` | 单次 `auto on` 控制周期的模型请求次数上限，与 `seconds` 先到即交还控制。 |
| `compactionThreshold` | 不设 | OMP 上下文压缩触发阈值（token 数）；省略时跟随所选模型的 OMP 原生阈值（`contextWindow - reserve`）。 |
| `dashboard` | `true` | `rsa up` 时是否确保本地 Dashboard 服务运行。 |
| `pet` | `false` | 是否在 `rsa up` 时拉起共享 Ludens Pet；需先安装可选组件并确保 Dashboard 可用。`rsa init --pet` 会写入 `true`，已有显式 `true` 不变；`rsa up --pet` / `--no-pet` 仅覆盖当次启动。 |
| `logging.diagnostics` | `"normal"` | 日志详细度，可选 `"normal"` 或 `"full"`；详见 [记录模式](../reference/logging.md#记录模式)。 |

### 3. 会话续接与后台服务目录

- **会话续接**：工作区 OMP 会话保存在 `.rsa/shiori/sessions/`，当前默认续接指针位于 `.rsa/shiori/current-session.json`。重启 Host 默认续接原会话并开启新的 `logs/<run-id>/` 目录。前台 `rsa run` 可传 `--new-session` 开启全新上下文（保留工作区文件），或传 `--resume /absolute/path/to/session.jsonl` 切换到同工作区的指定历史会话。
- **后台服务日志**：[launch-background.py](../../rsa/scripts/launch-background.py) 将工作区受管进程的标准输出与 launchd 状态写入 `<workspace>/logs/background/`；共享 Ludens Pet 的日志位于仓库同级的 `../artifacts/rsa/alice/background/`（launchd label 为 `dev.ludens.pet`）。所有后台服务均脱离终端运行，但不注册开机自启或崩溃死循环重启；排障时先查看 `rsa services` 与对应 `logs/background/` 日志。
