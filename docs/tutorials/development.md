# 开发与运行

本指南覆盖环境安装、设备准备、工作区启停、独立组件调试与验证流程。组件边界见 [架构与边界](../reference/architecture.md)，工作区代码编写见 [Workspace 与自适应代码](workspace.md)，事件与控制台消费见 [日志与调用链](../reference/logging.md)，评测运行见 [Benchmark](../reference/benchmark.md)。

除显式 `cd` 到目标工作区外，文内命令均在仓库根目录执行。`../artifacts/` 为仓库外的本地构建与运行状态目录；工作区、ROM、固件、密钥与游戏存档均保存在仓库外，不进入源码树。

## 安装

### 1. 环境前提与凭据

- **操作系统**：完整后台服务编排（`rsa up` / `rsa down` / `rsa services`）依赖 **macOS launchd**。
- **工具链**：准备 **Bun 1.4**、**Python 3.12+**、**Node.js 22+**、**pnpm 11** 与 **uv**。
- **模型凭据**：启动 Agent 前需在本机完成 **OMP 模型登录**。RSA 固定使用 **OMP 18.9.1** 并直接复用其凭据存储，默认模型为 `openai-codex/gpt-6.1-sol`。

### 2. 安装各组件依赖

五个子目录各自维护独立锁文件。安装 `rsa` 时，Bun 会按 `package.json` 自动应用 [rsa/patches/](../../rsa/patches/) 下的 OMP 依赖补丁：

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
uv sync --project rsa/python --frozen
(cd rsa-dashboard && npm ci && npm run build)
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)

export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PWD/rsa-companion/bin:$PATH"
```

`export PATH` 仅对当前终端生效；新开终端请同步配置 shell profile 或使用 `baseware/bin/baseware`、`rsa/bin/rsa` 绝对路径。

### 3. Python 运行时解析规则

[rsa/python/pyproject.toml](../../rsa/python/pyproject.toml) 与 `uv.lock` 管理正式 `ludens-rsa` 包（导入名 `rsa_tools`）以及 PyAV、Pillow、jsonschema 等媒体与校验依赖。`rsa_tools` 仅提供能力声明、客户端与试验登记辅助，执行生命周期与评分由 Shiori 统一管理。

框架按以下优先级选择 Python 解释器：

1. 显式环境变量 `RSA_PYTHON`；
2. 仓库内置虚拟环境 `rsa/python/.venv/bin/python`；
3. 系统 `PATH` 中的 `python3`。

OMP 原生 shell 会自动注入 `RSA_PYTHON`。在工作区脚本中若需复用 `rsa_tools` 及框架依赖，应调用 `"$RSA_PYTHON" script.py`；直接运行裸 `python3` 仍遵循用户 login shell，不等同于框架虚拟环境。若将 `RSA_PYTHON` 指向外部训练环境（如包含 PyTorch 的 conda/venv），需在该环境中预先安装 `rsa/python` 包及其依赖。

## 脚本命名与命令目录

各包的 `package.json` 脚本遵循同一套命名规则，包管理器与锁文件保持各组件现有选择：

- 包级通用命令使用 `dev`（开发服务）、`build`（生成构建产物）、`start`（启动已构建应用）、`test`（默认自动化测试集）、`typecheck`（类型检查）；只提供组件实际需要的命令。
- 专用命令使用 `<对象>:<动作>[:<变体>]`，每段采用 lowercase kebab-case，例如 `pet:preview`、`omp:test:transport`。局部任务不得使用裸 `preview`、`smoke` 或 `check`；`rsa`、`baseware` 这类与 CLI 同名的透传入口允许保留，具体动作由后续子命令指定。
- 默认 `test` 包含集成测试，不得将其命名为 `unit`。检查已有构建产物使用 `build:check`，该命令只检查，不执行构建。
- 命令改名时同步调用方与文档，不保留旧别名。

以下命令均在对应组件目录执行。Bun 包使用 `bun run <命令>`，Dashboard 使用 `npm run <命令>`，Companion 使用 `pnpm <命令>`：

| 组件目录 | 包级命令 | 专用命令与入口 |
| --- | --- | --- |
| `baseware` | `typecheck`、`test` | `baseware`：运行设备服务 CLI。 |
| `rsa` | `typecheck`：检查 TypeScript 与 Python；`test`：运行两种语言的默认测试集。 | `typescript:typecheck`、`python:typecheck`：单独检查对应语言；`typescript:test`、`python:test`：单独运行对应语言测试；`omp:test:transport`：运行 OMP WebSocket 传输恢复测试；`rsa`：运行 Host CLI。 |
| `rsa-dashboard` | `dev`、`build`、`start`、`test`、`typecheck` | `build:check`：校验现有生产构建与当前源码指纹是否一致。 |
| `rsa-companion` | `build`：使用 esbuild 生成 Electron 产物；`start`、`test`、`typecheck` | `pet:preview`：桌宠交互预览；`pet:smoke`：桌宠交互冒烟测试。两者都会先执行 `build`。 |

## 设备准备

各 Driver 仅暴露设备的原生输入与采集能力，不包含游戏策略、坐标融合或自动存读档逻辑。

### mGBA

已适配 mGBA `0.10.5`，并实机验证官方开发版 `0.11-9161-1509d8602`（[macOS 固定构建下载](https://s3.amazonaws.com/mgba/build/mGBA-build-2026-10-25-macos-9161-1509d86028c7df2d844b590723a80b2978f49e7c.dmg)）的采集、按键、断线释放与重连。升级前请先退出模拟器并备份应用、配置与 `.sav` 存档。

1. 打开 mGBA 并加载 ROM（mGBA 始终手动加载游戏与桥，`rsa.json` 不接受 `game` 字段）。
2. 打开菜单 **Tools → Scripting**，执行仓库内的 [bridge.lua](../../baseware/src/drivers/mgba/bridge.lua)（可用 `realpath baseware/src/drivers/mgba/bridge.lua` 获取绝对路径）：

```lua
dofile("/absolute/path/to/repo/baseware/src/drivers/mgba/bridge.lua")
```

看到控制台输出 `RSA bridge listening on 127.0.0.1:47653 (manual)` 即表示就绪。重复执行 `dofile` 会安全关闭旧桥并热加载新脚本；加载后可关闭 Scripting 窗口，但模拟器本体不可暂停，否则帧回调、截图采集与控制权交接都会挂起。多开实例时，在 `dofile` 前先执行 `RSA_BRIDGE_PORT = 47654`，并将对应工作区 `rsa.json` 的 `port` 设为 `47654`；每个桥端口同一时刻只能由一个 Baseware 实例连接。

**GBA 存档类型注意事项**：部分中文绿宝石改版使用 **SRAM 64 KiB**，若被自动识别为 Flash 1Mb 会导致游戏内保存失败。上述 `0.11-9161` 开发版已包含[用户 override 优先级修复](https://github.com/mgba-emu/mgba/commit/5337ae7ae14daaf0aecd4d2c40429fc31440b245)。针对此类 ROM，可在 `~/.config/mgba/config.ini` 的 `[override.<四字节游戏编号>]` 节写入 `savetype=SRAM512`（空编号 ROM 对应 `[override.]`，会作用于所有无编号 ROM，勿全局滥用），配置后务必通过“游戏内保存 → 完全退出 → 冷启动读档”验证。部分改版因双存档槽在 64 KiB 地址空间内重叠，冷启动读档成功时仍可能提示“记录破损”，建议保留独立 `.sav` 备份。

### Ryubing

Nintendo Switch 原生桥基于 [Ryubing 源码归档](https://starforgejo.dev/archive/Ryubing)（固定标签 `Canary-1.3.351`，提交 `475615f0431b4995b03c930c5089d20f6f3570e0`，本地构建标识 `1.3.351-rsa.3`）。在 Apple Silicon macOS 上准备 **.NET 10 SDK**（已验证 `10.0.402`）、**Python 3** 与 **Xcode Command Line Tools**：

```sh
# 默认使用 ../artifacts/switch/dotnet/dotnet；可通过 RSA_DOTNET 指定已有 SDK
RSA_DOTNET=/absolute/path/to/dotnet baseware/src/drivers/ryubing/build.sh
```

[build.sh](../../baseware/src/drivers/ryubing/build.sh) 会校验上游 commit、应用 [ryubing.patch](../../baseware/src/drivers/ryubing/ryubing.patch)（含 `https://nuget.ryulynx.org/v3/index.json` LibHac 源替换）、注入 [RsaBridge.cs](../../baseware/src/drivers/ryubing/RsaBridge.cs)，并附带 JIT entitlements 完成 ad-hoc 签名。源码位于 `../artifacts/switch/ryubing-canary-source`，构建产物位于 `../artifacts/switch/ryubing-build/Ryujinx.app`。

1. **安装**：构建脚本不会自动覆盖系统应用。先退出正在运行的模拟器，再将 `Ryujinx.app` 复制安装为 `/Applications/Ryubing.app`（Finder 显示为 Ryubing，内部可执行文件与进程名仍为 `Ryujinx`）。
2. **启动**：通过 [launch.sh](../../baseware/src/drivers/ryubing/launch.sh) 或 `rsa up` 启动以注入 `RSA_BRIDGE_PORT`（默认 `47663`）；直接从 Finder 双击图标不会开启桥服务：

```sh
baseware/src/drivers/ryubing/launch.sh /absolute/path/to/game.nsp
```

固件、密钥与存档沿用本机 Ryujinx 数据目录，切勿并发启动两个共用同一数据目录的实例。暴露能力包括：

- `pad.play / state / status / wait / cancel / release`：手柄时间表与状态查询；
- `screen.capture`：抓取游戏 framebuffer 或当前前台 Switch 系统键盘弹窗；
- `touch.down / move / up`：触屏操作，坐标范围 `x = 0..1279`、`y = 0..719`（左上角为原点）；
- `keyboard.type / press`：当 Switch 系统文本输入框可见时输入文本或功能键。

### Azahar

Nintendo 3DS 原生桥基于 Azahar `2126.2`（提交 `219d743a1e698101fe1ab8bef43e6563126c3c27`）。在 Apple Silicon macOS 上准备 **Git**、**CMake** 与 **Xcode Command Line Tools**（Qt 与 MoltenVK 由上游 CMake 自动拉取）：

```sh
baseware/src/drivers/azahar/build.sh
```

[build.sh](../../baseware/src/drivers/azahar/build.sh) 拉取源码与子模块、应用 [azahar.patch](../../baseware/src/drivers/azahar/azahar.patch)、注入 [rsa_bridge.cpp](../../baseware/src/drivers/azahar/rsa_bridge.cpp)，输出 `../artifacts/3ds/azahar-build/bundle/azahar.app`（可通过 `RSA_AZAHAR_SOURCE` 指定源码路径、`RSA_BUILD_JOBS` 调整并发编译数）。

1. **安装**：退出旧模拟器后，将产物安装至 `/Applications/Azahar.app`。
2. **启动**：通过 [launch.sh](../../baseware/src/drivers/azahar/launch.sh) 或 `rsa up` 启动（默认端口 `47673`，独立脚本可用 `RSA_AZAHAR_APP` 覆盖应用路径）：

```sh
baseware/src/drivers/azahar/launch.sh /absolute/path/to/game.3ds
```

原生能力由 [azahar/provider.ts](../../baseware/src/drivers/azahar/provider.ts) 定义，无需依赖桌面 Cua：

- `pad.*`：手柄与摇杆时间表控制；
- `screen.top.capture` / `screen.bottom.capture`：独立输出上屏（`400×240` 左眼画面）与下屏（`320×240`）；
- `touch.down / move / up`：下屏触控，坐标范围 `x = 0..319`、`y = 0..239`（左上角原点，含端点）。点按、拖拽与跨屏坐标换算由工作区代码实现。

### Cua

桌面环境使用上游原装 [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)：

1. 安装 Cua Driver，并在 macOS **系统设置 → 隐私与安全性**中为 `CuaDriver.app` 授予**辅助功能（Accessibility）**与**屏幕录制（Screen Recording）**权限。
2. Baseware 通过持久 `cua-driver mcp` 子进程（stdio 传输）接入驱动，无需设置 `game` 或桥端口；若 `cua-driver` 不在 `PATH` 中，可在 `rsa init --cua-command` 或 `rsa.json` 的 `cuaCommand` 指定绝对路径。
3. 所有工具保持上游原生命名与 JSON 参数结构（如 `rsa controller controller/get_desktop_state --args '{}'`），契约边界见 [Baseware 设计理念与能力契约](../reference/baseware.md)。

**桌面环境边界**：多个 Cua 工作区共享同一宿主机真实桌面（包括运行在桌面上的 melonDS 等尚未提供独立原生桥的模拟器），如需隔离桌面请使用独立 OS 会话或虚拟机。人工交还控制权会立即拒绝新输入并请求取消，但已进入操作系统底层的单次原生调用可能先执行完毕；`rsa down` 不会关闭共享的 `CuaDriver.app` 或用户的桌面应用。

## 工作区启动与停止

### 1. 初始化与生命周期命令

在仓库外新建目录作为工作区（以 Azahar 为例，其他内置驱动可替换为 `--driver mgba`、`--driver ryubing --game /path/to/game.nsp` 或 `--driver cua`）：

```sh
mkdir -p /absolute/path/to/workspace
cd /absolute/path/to/workspace

rsa init --driver azahar --game /absolute/path/to/game.3ds --seconds 1800
rsa up --dry-run
rsa up
rsa services
rsa controller list
rsa auto on
```

常用工作区与控制命令说明：

| 命令 | 行为与边界 |
| --- | --- |
| `rsa init` | 生成 `rsa.json` 及缺失的 `AGENTS.md`、`perception.py`、`action.py` 模板，绝不覆盖已有文件。 |
| `rsa up --dry-run` | 校验配置并打印完整进程启动计划，不实际拉起服务；需要新启动 Dashboard 时，实际 `rsa up` 才执行其构建检查。 |
| `rsa up` | 按需启动或复用模拟器、Baseware、Host、Dashboard 与 Ludens Pet。新启动的 Host 处于 `manual` 模式；若复用已在 `auto` 运行的 Host 则继续原控制周期。重复 `up` 不会热加载修改后的 `rsa.json`。 |
| `rsa services` | 查询当前工作区关联的 launchd 任务 PID、状态与最近退出码。 |
| `rsa auto on [--message '文本']` | 开启新控制周期（生成新 `epoch`，重置时间与请求预算）并向模型发起推理。`--message` 仅在该次接管的首轮附加一次，后续续轮不重复注入。 |
| `rsa auto off` | 立即撤销设备操作权并取消 RSA 管理的在途调用，模拟器保持运行；需等待当前周期清理完毕后方可再次 `auto on`。 |
| `rsa action status / reload / stop` | 管理工作区 `action.py` 常驻动作进程。`manual` 下 `reload` 仅标记就绪；`auto` 下 `stop` 或 `reload` 会清空本工作区全部当前设备输入（含并发 CLI 输入），释放成功后保留当前 `epoch`、OMP 会话与剩余预算。详见 [常驻动作](workspace.md#常驻动作)。 |
| `rsa down --keep-emulator` | 交还控制权并停止 Host 与 Baseware，保留模拟器窗口与游戏现场；适合修改 `rsa.json`（如预算或模型）后重新 `rsa up`。 |
| `rsa down [--dashboard] [--pet]` | 停止本工作区受管的 Host、Baseware 与模拟器（**执行前请先在游戏内保存进度**）。默认保留共享的 Dashboard 与 Ludens Pet；附加 `--dashboard`（仅限启动它的工作区）或 `--pet` 可一并关闭对应共享服务。 |

跨目录操作工作区时，可在任意命令前传入 `rsa --workspace /absolute/path/to/workspace <subcommand>` 或设置环境变量 `RSA_WORKSPACE`。

### 2. 外部 Driver 包发现与接入

除四个内置驱动外，可通过 `--driver-package` 接入第三方或本地驱动包（支持 npm 包名、`github:org/repo#rev` 或 `file:path`）。初始化前可用 `baseware driver discover` 校验包的 `DriverRegistration` 声明：

```sh
baseware driver discover --package github:org/repo#rev
rsa init --driver <id> --driver-package github:org/repo#rev
```

- **路径解析**：`rsa init` 与 `rsa up` 中的相对 `file:` 路径均以目标工作区目录为基准解析并归一化；`baseware driver discover` 的相对 `file:` 按当前 shell 目录解析；Dashboard 网页端的外部驱动校验要求 `file:` 使用绝对路径。
- **信任边界**：发现阶段虽不调用驱动的 `load()`，但会下载安装依赖并导入包入口代码；仅对可信来源执行发现与初始化。驱动包规范详见 [Driver 包与启动描述](../reference/baseware.md#driver-包与启动描述)。

### 3. `rsa.json` 配置参考

`rsa.json` 由 [rsa/src/app/workspace.ts](../../rsa/src/app/workspace.ts) 解析校验，未知字段会直接报错：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `driver` | 必填 | 驱动 ID；内置为 `mgba` / `ryubing` / `azahar` / `cua`，外部驱动须与包导出的 `id` 一致。 |
| `driverPackage` | 无 | 可选外部驱动包地址（npm spec、`github:org/repo#rev` 或 `file:path`）。 |
| `game` | 无 | 支持自动启动的 bridge 驱动可选（路径相对工作区）；省略时连接已手动启动的模拟器。`mgba` 与 stdio 驱动不接受此字段。 |
| `port` | 随驱动 | 显式端口优先，否则取驱动 manifest 的 `defaultPort`（内置 mGBA `47653`、Ryubing `47663`、Azahar `47673`）；stdio 驱动不使用。 |
| `cuaCommand` | `"cua-driver"` | 仅 stdio 驱动有效，指定后端可执行文件路径或命令名。 |
| `model` | `"openai-codex/gpt-6.1-sol"` | 具备图像输入能力的 OMP `provider/model` 标识。 |
| `seconds` | `1800` | 单次 `auto on` 控制周期的时长预算（秒），每次接管重置。 |
| `requests` | `1000` | 单次 `auto on` 控制周期的模型请求次数上限，与 `seconds` 先到即交还控制。 |
| `compactionThreshold` | 不设 | OMP 上下文压缩触发阈值（token 数）；省略时跟随所选模型的 OMP 原生阈值（`contextWindow - reserve`）。 |
| `dashboard` | `true` | `rsa up` 时是否确保本地 Dashboard 服务运行。 |
| `pet` | `true` | `rsa up` 时是否拉起共享 Ludens Pet 桌宠（依赖 `dashboard: true`）。 |
| `logging.diagnostics` | `"normal"` | 日志详细度，可选 `"normal"` 或 `"full"`；详见 [记录模式](../reference/logging.md#记录模式)。 |

### 4. 会话续接与后台服务目录

- **会话续接**：工作区 OMP 会话保存在 `.rsa/shiori/sessions/`，当前默认续接指针位于 `.rsa/shiori/current-session.json`。重启 Host 默认续接原会话并开启新的 `logs/<run-id>/` 目录。前台 `rsa run` 可传 `--new-session` 开启全新上下文（保留工作区文件），或传 `--resume /absolute/path/to/session.jsonl` 切换到同工作区的指定历史会话。
- **后台服务日志**：[launch-background.py](../../rsa/scripts/launch-background.py) 将工作区受管进程的标准输出与 launchd 状态写入 `<workspace>/logs/background/`；共享 Ludens Pet 的日志位于仓库同级的 `../artifacts/rsa/alice/background/`（launchd label 为 `dev.ludens.pet`）。所有后台服务均脱离终端运行，但不注册开机自启或崩溃死循环重启；排障时先查看 `rsa services` 与对应 `logs/background/` 日志。

## 独立组件与控制台

### 1. 前台分步调试 Baseware 与 Host

不经过 launchd 单独调试时，先准备好设备桥，随后在两个终端进入同一工作区分别启动服务：

```sh
# 终端 1：启动设备服务
cd /absolute/path/to/workspace
baseware serve --driver azahar --port 47673 --data-dir ./logs/baseware
```

```sh
# 终端 2：启动前台 Host（不读取 rsa.json，默认 300s / 50 次请求）
cd /absolute/path/to/workspace
rsa run --model openai-codex/gpt-6.1-sol --seconds 300 --requests 50
```

看到终端 2 输出 `"ready": true` 后，即可在第三个终端进入该工作区执行 `rsa auto on`。若仅测试设备与工作区能力而不启动 OMP 模型会话，可传入 `rsa run --device-only`。默认情况下双方通过工作区路径派生 Unix socket 地址，也可通过 `BASEWARE_SOCKET` / `--baseware-socket` 与 `RSA_SOCKET` 显式覆盖。

### 2. Dashboard 网页控制台

仅开发或查看前端界面时无需启动模型与模拟器，空日志目录也可直接运行：

```sh
# 开发模式（支持前端 HMR；修改 lib/ 或 worker/ 后需重启进程）
(cd rsa-dashboard && npm run dev)

# 生产模式（rsa up 受管启动使用的模式）
(cd rsa-dashboard && npm run build && npm run start)
```

`rsa up` 在拉起设备前会调用 `npm run build:check` 校验 `rsa-dashboard` 的构建产物与当前源码指纹；若未构建或源码已更新，会明确提示先执行 `npm run build`，绝不静默运行过期界面。停止或重启 Dashboard 不会影响正在运行的 Host、Baseware 与模拟器。

打开浏览器访问 `http://127.0.0.1:3015` 即可使用控制台：

- **运行与回放**：实时查看模型推理流、工具调用、设备输入与感知画面，或在历史时间轴上同步回放采样帧与事件。归档 worker、冷索引构建子进程与内存预算详见 [消费与指标解释](../reference/logging.md#消费与指标解释)。
- **站内文档（`?view=docs`）**：侧栏切至“文档”可直接在控制台内浏览 `docs/tutorials/`、`docs/reference/` 与 `docs/insights/`，支持跨篇与章节锚点跳转。
- **能力与评测目录（`?view=caps`）**：静态展示当前选中工作区的设备目录快照（`baseware.json`）、Python `@capability` 声明及 Harbor 评测任务，并提供外部驱动包的在线校验与 `rsa init` 命令生成。

### 3. Ludens Pet 桌面伴侣

在终端运行 `rsa-companion/bin/rsa-companion --show-window` 可启动 Electron 桌面端，其主窗口加载同一份 Dashboard 控制台，桌宠角色（卢登斯）与气泡消费同一套增量活动日志。

- **工作区跟随**：在 Dashboard 界面点击“让 Ludens Pet 跟随此工作区”即可实时热切换关注目标（状态保存在 `../artifacts/rsa/.pet-target.json`）；浏览历史回放不会改变桌宠当前跟随的活跃工作区。
- **启动参数**：`--workspace PATH`（或 `RSA_WORKSPACE`）指定首次默认工作区，`--dashboard URL` 指定控制台地址，`--profile PATH` 指定独立偏好目录（默认位于 Electron `appData` 下的 `RSA Ludens Pet`），`LUDENS_DISABLE_COMPANION=1` 可禁用桌宠挂件。关闭主窗口仅隐藏到托盘，双击桌宠或通过系统托盘菜单可重新唤出，选择 Quit 才彻底退出进程。
- **构建同步**：当修改了 Dashboard 供桌宠消费的共享日志客户端代码时，需重新执行 `(cd rsa-companion && pnpm build)` 并重启 Electron 主进程。

## 验证

### 1. 离线全量检查

默认自动化检查完全离线，不连接外部模型或真实模拟器：

```sh
(cd baseware && bun run typecheck && bun test)
python3 baseware/scripts/sync-cua-contract.py --check
(cd rsa && bun run typecheck && bun run test)
(cd rsa-dashboard && npm test && npm run typecheck && npm run build)
(cd rsa-companion && pnpm typecheck && pnpm test)
```

需要针对真实大型运行日志单独压测 Dashboard 冷索引构建与内存回收时，可使用隔离缓存目录运行离线检查脚本：

```sh
cd rsa-dashboard
node --expose-gc --max-old-space-size=1024 --import tsx scripts/check-index-memory.ts \
  --run /absolute/path/to/workspace/logs/run-id \
  --cache-root /absolute/path/to/temporary-index \
  --output /absolute/path/to/report.json --epoch epoch-id
```

### 2. 桌宠交互冒烟与姿态规则

执行 `(cd rsa-companion && pnpm pet:smoke)` 会使用临时 profile 自动验证窗口几何、点击穿透、尺寸缩放、音频与五类日志气泡；执行 `pnpm pet:preview` 则保留桌宠交互窗口供人工体验。

卢登斯桌宠采用静态透明 WebP 素材（定义于 `rsa-companion/ui/public/companion/ludens/manifest.json`，含 24 个全身姿态、8 个叠加特效、3 个头像与托盘图标；修改 manifest 后需同步 `catalog.js`）：

- **视觉校准**：各姿态通过 `display_scale` 以默认站立姿态的头部大小做底部居中缩放，气泡大小保持恒定。
- **姿态优先级**：鼠标互动（点击惊讶/开心、按住拎起、拖拽落地） > 当前可见日志状态（思考→思考、工具运行→操作、工具完成→得意、错误→吃瘪） > 右键菜单手选姿态/特效（仅当次进程有效） > 闲置计时（30s 托坐 → 90s 犯困 → 120s 睡觉）。

### 3. 实机与模拟器联调测试

实机测试会真实发送按键并切换设备控制权，**切勿在 Agent 运行期间并发执行**：

| 测试项 | 前置准备 | 仓库根目录执行命令 |
| --- | --- | --- |
| mGBA 完整控制权交还 | 模拟器已加载 ROM 与 `bridge.lua`；另开终端运行该工作区的 Baseware 与 `rsa run --device-only` | `RSA_MGBA=1 RSA_WORKSPACE=/absolute/path/to/workspace bun test rsa/tests/device.live.test.ts` |
| mGBA 连续断线恢复 | 模拟器与桥保持运行，停止占用该桥的 Host 与 Baseware（默认端口 `47653`） | `RSA_BRIDGE_TEST=1 bun test baseware/tests/bridge.live.test.ts` |
| Ryubing 按键/采样/长动作中断 | 游戏停在安全可输入画面，停止 Host 与 Baseware，模拟器桥保持运行（可用 `RSA_BRIDGE_PORT` 覆盖端口） | `RSA_SWITCH_TEST=1 bun test rsa/tests/switch.live.test.ts` |
| Ryubing 系统键盘框 | 同上，且已打开火纹的八字符命名框。测试会输入九字符并按 Enter 验证拒绝，再取消；不要在其他输入框执行，以免实际提交名字。 | `RSA_SWITCH_KEYBOARD_TEST=1 bun test rsa/tests/switch.live.test.ts` |

## WS 恢复测试依据

针对长周期运行中 OpenAI Codex WebSocket 到期、异常关闭码（如 `1012`）与未完成工具调用恢复的专项测试矩阵与设计复盘，见 [WS 恢复测试依据](../insights/ws-recovery.md)。
