# 开发与运行

本页负责安装、启动和验证；另见 [架构](architecture.md)、[workspace](workspace.md)、[日志](logging.md)及 [benchmark](benchmark.md)。

除显式 `cd` 外，以下命令都从仓库根目录执行。`../artifacts/` 是仓库外的本地构建和运行状态目录；workspace、ROM、固件、密钥与存档不进入源码仓库。

## 安装

整套后台启动目前需要 macOS launchd。准备 Bun 1.4、Python 3.9+、Node.js 22+、pnpm 11，以及已配置的本机 OMP 模型登录。RSA 固定使用 OMP 18.9.1，复用其凭据；默认模型为 `openai-codex/gpt-6.1-sol`。各组件独立安装，保留各自锁文件：

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
python3 -m pip install -r rsa/python/requirements.txt
(cd rsa-dashboard && npm ci)
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)
export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PWD/rsa-companion/bin:$PATH"
```

[requirements.txt](../rsa/python/requirements.txt) 声明 `jsonschema>=4.23,<5`，用于 benchmark 报告校验，需独立于 Bun 安装。可先激活自己的 Python 环境；`RSA_PYTHON` 选择能力、感知和评测进程的解释器，shell 的 `python3` 也应指向该环境。训练、图像库由 workspace 按需安装。

其他终端也需配置 PATH 或使用绝对 CLI 路径。Bun 安装 RSA 时自动应用 [依赖补丁](../rsa/patches/)。

## 设备准备

### mGBA

已适配 mGBA 0.10.5。打开游戏，在 **Tools → Scripting** 输入：

```lua
dofile("/absolute/path/to/repo/baseware/src/drivers/mgba/bridge.lua")
```

路径可在仓库根用 `realpath baseware/src/drivers/mgba/bridge.lua` 获取。看到 `RSA bridge listening on 127.0.0.1:47653 (manual)` 后即可连接。重复执行会关闭旧桥并加载新代码；脚本窗口可关闭，游戏必须继续运行，模拟器暂停也会暂停帧回调、采集和交接。

mGBA 始终手动加载 ROM/桥，配置不接受 `game`。另开实例时先设置 `RSA_BRIDGE_PORT = 47654` 再加载脚本，workspace 的 `port` 同样改为 47654。同一桥只由一个 Baseware 持有。实现见 [bridge.lua](../baseware/src/drivers/mgba/bridge.lua)。

### Ryubing

Switch 桥基于 [Ryubing 源码归档](https://starforgejo.dev/archive/Ryubing)，固定标签 `Canary-1.3.351`、提交 `475615f0431b4995b03c930c5089d20f6f3570e0`；本地版本 `1.3.351-rsa.3` 是开发构建。准备 Apple Silicon macOS、.NET 10 SDK、Python 3、Xcode Command Line Tools：

```sh
# 默认 SDK 路径为 ../artifacts/switch/dotnet/dotnet；也可显式指定已有 SDK。
RSA_DOTNET=/absolute/path/to/dotnet baseware/src/drivers/ryubing/build.sh
```

[build.sh](../baseware/src/drivers/ryubing/build.sh) 检查提交、应用 [patch](../baseware/src/drivers/ryubing/ryubing.patch)、复制 [RsaBridge.cs](../baseware/src/drivers/ryubing/RsaBridge.cs)，通过上游工具和 JIT entitlements 做 ad-hoc 签名。补丁将 LibHac feed 改为 `https://nuget.ryulynx.org/v3/index.json`，保留依赖版本。源码在 `../artifacts/switch/ryubing-canary-source`，产物在 `../artifacts/switch/ryubing-build/Ryujinx.app`；已用 SDK 为 10.0.402。

构建不会替换应用。**退出正在运行的模拟器后**，将产物安装为 `/Applications/Ryubing.app`。Finder 显示 Ryubing，可执行文件及进程仍叫 `Ryujinx`。启动带桥应用：

```sh
baseware/src/drivers/ryubing/launch.sh /absolute/path/to/game.nsp
```

[launch.sh](../baseware/src/drivers/ryubing/launch.sh) 显式设置 `RSA_BRIDGE_PORT`（默认 47663）；从 Finder 正常打开不启用桥。固件、密钥、设置和存档沿用本机 Ryujinx 数据目录，不要并发启动两个使用同一数据目录的模拟器。重新构建后必须退出旧进程并启动新 bundle，运行中的模拟器不会加载新桥。

能力为 `pad`、`screen`、`touch`、`keyboard`。screen 采集游戏 framebuffer 或前台系统键盘的真实弹窗；touch 范围 x=0..1279、y=0..719。参数与状态契约见各 controller 的 help。没有游戏内存读取、音频或模拟器存读档命令；连通不等于游戏兼容。

### Azahar

3DS 原生桥固定 Azahar `2126.2`、提交 `219d743a1e698101fe1ab8bef43e6563126c3c27`。Apple Silicon macOS 上准备 Git、CMake 和 Xcode Command Line Tools；Qt 与 MoltenVK 由上游 CMake 获取：

```sh
baseware/src/drivers/azahar/build.sh
```

[build.sh](../baseware/src/drivers/azahar/build.sh) 拉取源码和子模块、应用 [patch](../baseware/src/drivers/azahar/azahar.patch)、复制 `rsa_bridge.cpp/.h`，生成 `../artifacts/3ds/azahar-build/bundle/azahar.app`。`RSA_AZAHAR_SOURCE` 指定源码目录，`RSA_BUILD_JOBS` 改变默认四个构建任务。**退出旧模拟器后**，另行安装到 `/Applications/Azahar.app`；脚本不替换安装或停止应用。

```sh
baseware/src/drivers/azahar/launch.sh /absolute/path/to/game.3ds
```

[launch.sh](../baseware/src/drivers/azahar/launch.sh) 默认使用 `/Applications/Azahar.app`、桥端口 47673；独立启动时可用 `RSA_AZAHAR_APP` 选择 bundle。整套 `rsa up` 检查默认安装路径。所需系统数据由用户自行准备，空窗口或桥已连接不表示游戏能正常运行。

原生能力为 `pad`、`touch`、`screen.top`、`screen.bottom`，无 Cua 依赖。独立屏幕输出为 400×240 左眼画面和 320×240 下屏；touch 范围 x=0..319、y=0..239。两种模拟器均只提供 down/move/up，坐标含端点、原点左上，点按/拖拽/融合/坐标转换由 workspace 实现。契约见 [provider.ts](../baseware/src/drivers/azahar/provider.ts) 和 [原生桥](../baseware/src/drivers/azahar/rsa_bridge.cpp)。

### Cua

安装上游 [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)，macOS 为 CuaDriver.app 授予**辅助功能**和**屏幕录制**权限。Baseware 通过持久的 `cua-driver mcp` 子进程连接原装驱动，不改上游代码或应用设置。可用 `cuaCommand` / `--cua-command` 指定 CLI 绝对路径。

Cua 不使用 `game` 或桥端口；原始工具以 `cua.<tool-name>` 暴露，例如 `rsa controller controller/cua.get_desktop_state`。参数看 `--help`，不默认注入 OMP 工具列表。

交还控制会拒绝新输入并请求取消，已运行的原生调用可能先完成；清理结束后才报告 manual。`down` 不关闭共享 CuaDriver.app 或用户应用。不同 workspace 仍共享真实桌面，独立桌面需 OS session 或 VM。NDS/melonDS 当前走此桌面通道，没有独立 NDS driver。

## 工作区启动与停止

准备设备后，从新 workspace 初始化。以下示例选 Azahar；其他选项为 `--driver mgba`、`--driver ryubing --game /absolute/path/to/game.nsp`、`--driver cua`：

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

`init` 生成配置和 workspace 模板，不覆盖已有文件；`up --dry-run` 只打印计划。`up` 启动或复用 Baseware、Host、Dashboard、Alice，新 Host 保持 manual，`auto on` 才请求模型和接管。复用中的 auto Host 继续原周期；感知初始化与会话约定见 [workspace.md](workspace.md)。

`rsa.json` 字段与默认值由 [workspace.ts](../rsa/src/app/workspace.ts) 定义：

| 字段 | 默认值与用途 |
| --- | --- |
| `driver` | 必选：`mgba` / `ryubing` / `azahar` / `cua` |
| `game` | Ryubing/Azahar 可选；路径相对 workspace。省略则连接已准备的外部模拟器 |
| `port` | mGBA 47653、Ryubing 47663、Azahar 47673；Cua 不使用 |
| `cuaCommand` | 仅 Cua 可用；默认从 PATH 查找 `cua-driver` |
| `model` | `openai-codex/gpt-6.1-sol` |
| `seconds` / `requests` | 1800 / 1000；每次接管重置，任一预算用完即交还控制 |
| `compactionThreshold` | 256000，使用 OMP 原生压缩 |
| `dashboard` / `pet` | 均为 true；Pet 需要 Dashboard |

从其他目录管理用 `rsa --workspace /absolute/path/to/workspace status` 或 `RSA_WORKSPACE`。workspace 隔离会话和默认 socket；真实设备仍需独立实例/端口，同一 workspace 不能有两个 Host。

- `rsa auto on --message '本轮的一次提醒'`：附言只在接管开始发送，不是运行中插话接口；之后续轮不重复注入。
- `rsa auto off`：撤销设备操作权并请求取消在途工作，游戏保持运行；等周期清理结束后才能再次接管。OMP 管理后台进程，活着不等于仍有设备输入权限。
- `rsa down`：先交还控制、等清理，再停止本 workspace 管理的 Host、Baseware 和模拟器。外部手动启动的进程不归它关闭；先保存游戏。
- `rsa down --keep-emulator`：保留模拟器现场，用于修改预算、模型或加载 Host/Baseware 代码；随后 `rsa up`、`rsa services`、`rsa auto on`。
- `down` 默认保留共享 Dashboard/Alice；`--pet` 关闭受管理的共享 Pet，单独打开的实例仍由应用退出；`--dashboard` 只关闭本 workspace 启动的 Dashboard，会影响其他消费者。

重复 `up` 不加载新配置。重启默认续接原 workspace 的 OMP 会话，日志另写新 run。`rsa run --new-session` 开新上下文并保留工作区文件，`--resume /absolute/path/to/session.jsonl` 选择同一 workspace 历史；会话路径见旧 run 的 `session` 事件，不手工拼接。

[launch-background.py](../rsa/scripts/launch-background.py) 将工作区日志/job 写到 `logs/background/`；共享 Alice 在 `../artifacts/rsa/alice/background/`，label 为 `dev.playness.alice.pet`。服务脱离终端，不自动重启/开机启动。故障先看 `rsa services` 和对应日志，避免重复启动。

## 独立组件与控制台

单独调试 Host 时，先准备桥；在两个终端进入同一 workspace，分别运行：

```sh
cd /absolute/path/to/workspace
baseware serve --driver azahar --port 47673 --data-dir ./logs/baseware
```

```sh
cd /absolute/path/to/workspace
rsa run --model openai-codex/gpt-6.1-sol --seconds 300 --requests 50
```

`rsa run` 是前台 Host，不读取 `rsa.json`，默认预算 300 秒 / 50 请求。等 `ready: true` 后从同一 workspace 执行 `auto on`；`--device-only` 不启动 OMP。`BASEWARE_SOCKET` / `--baseware-socket` 和 `RSA_SOCKET` 可覆盖默认设备/控制地址。参数见 CLI `--help`。

仅开发前端时无需模型或模拟器，空日志目录也能打开控制台：

```sh
(cd rsa-dashboard && npm run dev)
# 生产构建/运行：分别执行 npm run build 和 npm start（同一组件目录）。
```

打开 [本地控制台](http://127.0.0.1:3015)。另一个终端运行 `rsa-companion/bin/rsa-companion --show-window`，Electron 加载同一页面。关闭窗口只隐藏，双击卢登斯/点击托盘重开，Quit 才退出。

在共享界面选择“让 Alice 跟随此工作区”即可热切换；历史回放不改变关注目标，Pet 跟随该 workspace 最新非 Benchmark 运行。`--workspace PATH` / `RSA_WORKSPACE` 只提供首次默认选择，`--dashboard URL` 指定本地服务，`--profile PATH` 使用独立偏好目录。默认实例会复用已有窗口。

控制台只监听 localhost；启动 Pet 不发模型请求或游戏输入。浏览器可切关注目标，音量、音频导入等原生设置需桌面端操作。日志消费、媒体和统计见 [logging.md](logging.md)。

## 验证

默认离线检查，不连接模型或操作游戏：

```sh
(cd baseware && bun run check && bun test)
(cd rsa && bun run check && bun test)
(cd rsa-dashboard && npm test && npm run typecheck && npm run build)
(cd rsa-companion && pnpm typecheck && pnpm test)
```

`(cd rsa-companion && pnpm smoke)` 用临时 profile 验证几何、点击、尺寸、音频和五类日志；`pnpm preview` 留下交互窗口。两者不连接模型或控制模拟器。

桌宠使用卢登斯的静态素材（`rsa-companion/ui/public/companion/ludens/manifest.json`）：
24 个全身姿态、8 个特效、3 个头像与托盘图标，附生成提示词和 9 份 SVG。
运行图为 512px 透明 WebP，托盘另带 PNG。无视频或逐帧动画。
右键「姿态」选择全部姿态或恢复自动，「特效」选择叠加；选择仅在本次进程有效。
自动状态在闲置 30/90/120 秒时依次托坐、犯困、睡觉，点击会短暂惊讶或开心，
按住显示被拎起，拖动释放显示落地。现有吸边、左右翻转、尺寸和透明区域穿透保留。
姿态优先级为互动、当前可见日志、手选姿态、闲置；日志隐藏后恢复原姿态。
思考日志显示思考，工具运行显示操作，工具完成显示得意，错误显示吃瘪；
这只表达当前日志块的状态，不代表整项任务成功。简略通知不读取私有日志字段。
现有 `RSA Alice Pet` 配置目录、IPC 与启动环境变量保留以延续设置。


评测统一用 `rsa bench`，先读 help。`capability-reuse` 调用真实模型，其他内置用例离线；自定义评测依其代码运行，见 [benchmark.md](benchmark.md)。

实机测试需显式授权，会输入按键并改变控制权。以下是独立可选测试，**不要在 Agent 运行时执行**：

| 测试 | 前提 | 仓库根命令 |
| --- | --- | --- |
| mGBA 完整交还 | 已加载桥；另开 Baseware 和 `rsa run --device-only`；指明同一 workspace | `RSA_MGBA=1 RSA_WORKSPACE=/absolute/path/to/workspace bun test rsa/tests/device.live.test.ts` |
| mGBA 连续断线恢复 | 保留桥和游戏，停止占用桥的 Host/Baseware；默认端口 47653 | `RSA_BRIDGE_TEST=1 bun test baseware/tests/bridge.live.test.ts` |
| Ryubing 按键/采样/长动作中断 | 停在可安全输入的场景，停止 Host/Baseware，桥保持运行 | `RSA_SWITCH_TEST=1 bun test rsa/tests/switch.live.test.ts` |
| Ryubing 原生键盘 | 同上，火纹八字符命名框打开；测试取消而不提交名字 | `RSA_SWITCH_KEYBOARD_TEST=1 bun test rsa/tests/switch.live.test.ts` |

Switch 测试可用 `RSA_BRIDGE_PORT` 指定非默认端口。这些验证覆盖控制与采样契约，不证明游戏兼容性、通关或长期稳定性。

## WS 恢复测试依据

OMP 专项测试从公开 provider API 和 Agent 入口调用固定依赖，测试与 fixture 留在本仓库，不放进 OMP 源码或补丁。更换 Shiori 时单独评估这些契约，不将 OMP 实现细节变成通用接口。

### Codex WS 恢复专项 · 2026-10-20

**这是架构施工期的 TDD 特例，不是全项目规则。** 长运行暴露相邻故障分支遗漏，因此先构造外部工况、确认旧实现失败，再修恢复策略。架构改变时重新判断用例价值，不为测试保留旧架构。

入口：[omp-websocket.test.ts](../rsa/tests/omp-websocket.test.ts)。从仓库根运行：

```sh
(cd rsa && bun run test:transport)
(cd rsa && bun run check)
# 带标准事件和检查证据的两个真实故障族，可由现有看板读取：
rsa/bin/rsa --workspace /absolute/path/to/workspace bench run ws-recovery
```

### 构建依据

- **R1：** 2026-10-18 Besiege 六小时运行，空 thinking 后收到 `websocket_connection_limit_reached`。先前补丁已覆盖到期恢复。
- **R2：** 马造八小时运行 `2026-10-19T13-19-53.903Z`。北京时间 23:19:59 到期、23:21 恢复 WS；23:46:56 收到 `websocket closed (1012)` 后约 5.5 小时保持 SSE。缺口是关闭恢复分类，不能据此确定服务端或网络故障来源。
- **R3：** `2026-10-20T14-57-50.713Z` 在 UTC 15:57:52 到期，`custom_tool_call_input.delta` 尚未完成。额外的“可见输出后禁重放”拦截比 OMP 更严，导致 Agent 提前结束。现删除拦截，复用 `canSafelyReplayWebsocketOverSse`：完整工具交付后不重放，未完成参数、text/thinking 允许原生恢复。
- **S：** 其余关闭码、握手、交付、尺寸和取消是合成邻近工况，不声称曾在 R2 发生。码名参考 [IANA](https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number)，恢复策略是项目选择，非协议要求。

### 环境与观测范围

Bun 1.4、打补丁的 `@oh-my-pi/pi-ai@18.9.1` 调用真实 `streamOpenAICodexResponses`，每例独立 session；R3 另经 `pi-agent-core` 公开 `Agent.prompt` 真正执行工具回调并提交结果。进程内 fixture 替换 WS/HTTP，使用合成 token，不读本机登录、不连模型或模拟器。

`Date.now` 虚拟推进 60 秒冷却，握手 watchdog 为 0ms、首事件 watchdog 为 1ms，backoff 用受控 scheduler。检查请求次数、状态、交付和序列化正文，耗时不代表真实性能。全局传输替身要求顺序运行，finally 恢复环境并关闭会话。

### 工况矩阵

| 工况 | 来源 / 注入位置 | 必须观察到的行为 |
| --- | --- | --- |
| 正常首帧、增量、连接替换 | S，正常完成后旧 socket 关闭 | 新连接完整历史、无旧 `previous_response_id`，下一轮恢复 delta |
| 连接到期 | R1/R2，空 thinking 后 error event | 当前请求安全回退 SSE；60 秒内不握手；随后全历史 WS → delta |
| 中途关闭 1000/1001/1006/1011/1012/1013 | R2 的 1012 + S，空 thinking 后 close | 同一临时恢复策略，不能永久禁用整个会话的 WS |
| 握手关闭 1006/1012/1013、握手超时 | S，连接尚未打开 | 当前请求 SSE、冷却内无新握手、冷却后新连接 |
| 协议/数据/策略拒绝 1002/1003/1007/1008/1010 | S，握手关闭 | 保持会话 WS 禁用；时间过去或压缩都不自动解除 |
| send 抛错、损坏 JSON、首事件超时 | S，尚无内容交付 | 有界重试，耗尽后 SSE 冷却；下一次正常请求可恢复，无密集无限重连 |
| text/thinking 部分输出后到期或 1012 | S，分别在流式输出后注入 | 原生 SSE 恢复；不把文字已显示等同于工具已执行；后续冷却、全历史 WS → delta |
| 完整工具交付后到期或 1012 | S，`toolcall_end` 后注入 | 当前请求返回 error，不向 SSE 重放工具；后续仍有冷却和 WS 恢复机会 |
| custom tool 参数未完成时到期 | R3，`custom_tool_call_input.delta` 后、done 前注入 | 同一次 `Agent.prompt` 内 SSE 恢复，完整工具回调恰好执行一次并提交结果；冷却后全历史 WS → delta |
| 本地 UTF-8 帧 >15MiB、远端 1009 | 既有尺寸回归 + S | 完整 SSE；尺寸阻断时不反复握手；仅原生压缩解除尺寸阻断 |
| 累计历史 >15MiB、实际 delta 很小 | S | 按实际发送帧判断，正常继续增量 WS |
| 已交付工具后 1009 | S | 工具不重放，仍记录尺寸阻断；后续 SSE，压缩后 WS |
| 人工/预算取消：握手中、部分输出后、拒绝同时取消 | S | aborted、不发额外 SSE、不污染后续请求的传输选择 |

恢复分类与能否重放分开：重放复用 OMP，RSA 不加可见内容拦截/外层重试。临时断连冷却，尺寸阻断等原生压缩，协议/数据/扩展/策略拒绝禁用。分类使用原生 close code，不匹配错误字符串；3000/3003 鉴权拒绝同样禁用，未知私有码不推断含义，按临时故障冷却。

### 红绿记录与边界

2026-10-20 扩展专项由 **19 通过 / 18 失败** 到 **37 通过 / 515 断言**。其中 text/thinking 输出后必须报错的预期过严，R3 后纠正；旧通过数不证明策略合理。连接分类、冷却、尺寸、取消、空 thinking 块闭合回归仍保留。

2026-10-21 先加 R3 Agent 回归：旧实现工具回调 **0 次，期望 1 次**。恢复原生边界后验证同一 prompt 内恢复、执行一次并提交结果，以及冷却后全历史 WS → delta。text/thinking 改为原生恢复预期，完整工具不重放检查保留；最新通过数以命令为准。

测试只证明受控行为，不证明线上永不掉线或实际重连耗时；长跑、调度、吞吐仍看日志。256k 阈值、模型、游戏策略不在变更范围。

看板基准 [ws-recovery.ts](../rsa/src/benchmark/cases/ws-recovery.ts) 复现两类实际事件，在 `benchmark_fault` 标明来源与模拟条件；完整矩阵留在外部测试。升级 OMP 时先跑专项再跑基准，不复制测试进依赖。
