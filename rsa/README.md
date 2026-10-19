# RSA 实验

给模型统一的设备能力 CLI 和一个空工作区，让它自行探索并积累技能。`rsa controller` 统一发现和调用设备能力与工作区 Python 函数；设备由独立 Baseware 服务的 mGBA / Ryubing / Azahar / Cua driver 提供。RSA 使用同一份 OMP 18.9.1 循环。模型凭据复用本机 OMP 登录，默认 `openai-codex/gpt-6.1-sol`。

## 启动

本仓库根目录包含 `baseware/`、`rsa/`、`rsa-dashboard/`、`rsa-companion/`。下文的 `artifacts/` 指仓库同级的运行目录 `<repo>/../artifacts/`；它不属于源码，日志仍写入各自 workspace。

### 工作区启动入口

需要 Bun 1.4、Python 3 和已准备好的设备；Dashboard、Pet 的安装步骤见[仓库 README](../README.md)。后台启动入口目前使用 macOS launchd。ROM、固件、密钥不进入 Git。

```sh
cd baseware
bun install --frozen-lockfile
cd ../rsa
bun install --frozen-lockfile
export PATH="$PWD/bin:$PWD/../baseware/bin:$PATH"
mkdir -p /absolute/path/to/workspace
cd /absolute/path/to/workspace
rsa init --driver ryubing --game /absolute/path/to/game.nsp --seconds 1800
rsa up --dry-run
rsa up
rsa services
rsa auto on
```

`rsa init` 在当前工作区生成 `rsa.json`，已有配置不会覆盖。`rsa up --dry-run` 只输出启动命令和路径，不启动进程。确认计划后，`rsa up` 连接设备并启动所需的 Baseware、Host、Dashboard 与 Pet；`rsa services` 汇总本工作区的后台进程、Host 状态和共享 Dashboard。新 Host 启动后保持手动，执行 `auto on` 后才发送模型请求并操作游戏；设备目录与 help 在启动时就已可用。复用已在接管中的 Host 时，`up` 保留当前状态，不打断运行。

接管时可附带一次用户提醒，例如 `rsa auto on --message '稍后要关闭模拟器，请先保存进度。'`。附言作为本轮第一条用户消息进入原会话，后续续轮不重复注入，也不修改技能、记忆或系统提示。

配置示例：

```json
{
  "driver": "ryubing",
  "game": "/absolute/path/to/game.nsp",
  "seconds": 1800,
  "requests": 1000,
  "model": "openai-codex/gpt-6.1-sol",
  "compactionThreshold": 256000,
  "dashboard": true,
  "pet": true
}
```

`driver` 为 `ryubing`、`mgba`、`azahar` 或 `cua`。`game` 是 Ryubing / Azahar 启动的游戏路径，相对路径以工作区为基准；省略时连接外部已准备好的模拟器。可选 `port` 指定桥端口，默认 mGBA 47653、Ryubing 47663、Azahar 47673。Cua 不使用 `game` 或 `port`；只有 Cua 可用 `cuaCommand` 指定 Cua Driver 可执行路径，默认从 PATH 查找 `cua-driver`。其余字段的默认值如上；`seconds` 和 `requests` 是每次接管的预算，达到任一预算即交还控制。

有 `game` 时使用对应的 `launch.sh` 启动带桥 Ryubing / Azahar；安装及设备前提见下方 [Switch / Ryubing](#switch--ryubing) 和 [3DS / Azahar](#3ds--azahar)。mGBA 的 ROM 和 Lua 桥仍按下一节手动准备，再执行 `rsa init --driver mgba` 和 `rsa up`。

生命周期约定：

- 重复 `up` 复用本工作区已就绪的 Host 和受管理的进程，不清空会话、不重启，也不改变已有接管状态。配置修改需重启对应进程加载；原 OMP 历史和工作区文件继续保留。
- Dashboard 使用 `http://127.0.0.1:3015`，已有服务可共用。新启动的 Pet 使用 `logs/background/pet-profile/` 保存独立设置；本工作区已经受管理的 Pet 保持原进程及设置。
- `rsa auto off` 立即交还控制并取消在途模型与 shell，模拟器继续运行。再次接管须等本周期清理结束。
- `rsa down` 先交还控制并等待清理，再停止本工作区管理的 Host、Pet、Baseware 和模拟器；关闭模拟器会丢失未保存的游戏进度。它不关闭外部手动启动的进程，也不删除工作区或历史。
- `rsa down --keep-emulator` 停止 Host、Pet、Baseware，保留模拟器及当前游戏状态，适合更换预算、模型或加载 Host 代码改动。更换游戏或模拟器启动配置时使用普通 `down` / `up`。
- `down` 默认保留共享 Dashboard。确需关闭时，`rsa down --dashboard` 只关闭本工作区启动的 Dashboard；其他工作区的看板和 Pet 连接可能因此中断。`--dashboard` 与 `--keep-emulator` 可以组合使用。

例如修改 `rsa.json` 中的接管预算后，保留当前游戏并加载新预算：

```sh
rsa down --keep-emulator
rsa up
rsa services
rsa auto on
```

后台进程继续复用 `scripts/launch-background.py`，工作目录是当前 workspace，日志与 job 描述写入 `logs/background/`。它们独立于交互式终端，不自动重启、不注册开机启动。启动失败时先运行 `rsa services` 查看现有服务及退出状态，再检查对应日志；避免另外手动启动一组重复进程。

### Cua 桌面

按 [Baseware 文档](../baseware/README.md) 安装 Cua Driver 并完成系统权限准备，然后在独立工作区启动：

```sh
mkdir -p /absolute/path/to/desktop-workspace
cd /absolute/path/to/desktop-workspace
rsa init --driver cua --seconds 1800
# 如未加入 PATH：rsa init --driver cua --cua-command /absolute/path/to/cua-driver
rsa up --dry-run
rsa up
rsa controller list
rsa controller controller/cua.get_desktop_state
```

Baseware 持有一个 Cua Driver MCP 子进程，桌面能力仍通过同一 `rsa controller` 目录和 Python API 使用，不注入 OMP 工具列表。Cua 工作区启动不探测模拟器或 TCP 桥；自动观测使用 `cua.get_desktop_state`，将图像和文本一起交给现有循环。需要接管时执行 `rsa auto on`，`rsa auto off` 交还控制；`rsa down` 结束本工作区的服务。桌面应用仍留在当前系统，工作区只隔离 Agent 的文件与会话。

NDS 的 [melonDS](https://github.com/melonDS-emu/melonDS/releases) 可按桌面应用接入：启动原装模拟器，在自己的工作区执行上述 Cua 启动流程，再通过目录发现窗口、键鼠和采样能力。屏幕布局、裁剪和观测选择由工作区代码自行适配，Baseware 不预设双屏含义。空窗口连通不等于游戏兼容性验证。

### 3DS / Azahar

Azahar 是独立的 3DS driver，提供原生 `pad`、`touch`、`screen.top` 和 `screen.bottom`，不依赖 Cua。先按 [Azahar driver 文档](../baseware/src/drivers/azahar/README.md) 构建并安装带桥模拟器，再在独立工作区启动：

```sh
rsa init --driver azahar --game /absolute/path/to/game.3ds --seconds 1800
rsa up --dry-run
rsa up
rsa controller list
rsa controller controller/touch --help
```

已有带桥模拟器运行时可省略 `--game`；默认原生桥端口为 47673。按键、摇杆和触屏通过模拟器内部输入状态注入，不依赖桌面鼠标坐标或窗口焦点。初始自动观测分别调用 `screen.top capture` 和 `screen.bottom capture`，原样送入两张独立的 400×240、320×240 图像。它们来自各自的硬件屏幕，不从窗口合图中裁剪；采样时间分别记录，不假定同时采样。Agent 自己在 workspace 中编写、试用和修改 observe hook，决定如何融合这些观测；驱动不提供拼接策略或画面到触点的坐标变换。

`touch` 只提供 `down --x <整数> --y <整数>`、`move --x <整数> --y <整数>`、`up`。3DS 范围为 x=0..319、y=0..239，均包含端点；原点在左上，x 向右、y 向下。状态跨调用保留，down 要求当前未按下，move 要求已经按下，释放操作权或取消会抬起。点按、拖拽、等待和画面坐标转换由 Agent 自己组合成 workspace 脚本，仍优先通过 `rsa controller` 发现和使用。

### mGBA 设备准备

在 mGBA 0.10.5 打开游戏，然后进入 **Tools → Scripting**。在底部输入框执行以下代码，路径换成自己 checkout 中的绝对路径（可在 `rsa/` 下运行 `realpath ../baseware/src/drivers/mgba/bridge.lua` 获取）：

```lua
dofile("/absolute/path/to/repo/baseware/src/drivers/mgba/bridge.lua")
```

出现 `RSA bridge listening on 127.0.0.1:47653 (manual)` 即已加载。重复执行会关闭旧桥并加载新代码。脚本窗口可以关闭，游戏需要保持运行；模拟器暂停时，帧回调、采集和交接也会暂停。

```sh
cd /absolute/path/to/workspace
rsa init --driver mgba
rsa up --dry-run
rsa up
rsa services
rsa auto on
```

### 独立 Host 与高级启动

`rsa run` 是前台 agent 宿主，连接已经运行的 Baseware，不加载设备 driver；`rsa.json` 由 `init` / `up` 管理。只运行设备或调试单个组件时仍可直接使用它，启动默认手动，等待输出 `ready: true` 后从同一工作区执行 `rsa auto on`。

可选参数：

```sh
# 先在 workspace 的另一个终端运行设备服务（或由 rsa up 管理）
baseware serve --driver ryubing --data-dir ./logs/baseware
# 本终端启动 agent
rsa run --workspace /absolute/path/to/workspace \
  --model openai-codex/gpt-6.1-sol --seconds 300 --requests 50
```

`--seconds` 是每次接管的最长墙钟时间，`--requests` 是每次接管的模型请求预算。达到任一预算即回到手动；下一次 `auto on` 使用新的预算，保留同一 OMP 会话及完整历史。默认 socket 为 `/tmp/playness-rsa-<uid>-<workspace-hash>.sock`，随工作区选择；`RSA_SOCKET` 可手动覆盖连接地址。Baseware 使用独立的 `/tmp/playness-baseware-<uid>-<workspace-hash>.sock`；Host 可用 `--baseware-socket` 或 `BASEWARE_SOCKET` 选择服务。

持续性能观察可给一次接管设置较长的总预算（例如 `--seconds 1800`），每五分钟离线查看日志，不必关掉再接管。预算到期会取消在途响应，WS 连接可能随之重建；在长历史下，频繁硬停会反复付出完整首帧上传的成本。只有需要加载代码改动时才重启宿主。

`--compaction-threshold` 设置 OMP 原生压缩的触发 token 数，默认 **256000**，不另建摘要或裁剪逻辑。2026-10-16 曾试用 100000 和 60000：压缩后部分请求变快，但这不能证明算上摘要请求、缓存重建和经验保留后的整体收益。按用户要求采用 256k，避免用反复压缩换取局部请求提速；后续性能优化优先检查请求构建和传输路径。

固定的 [pi-coding-agent 18.9.1 补丁](patches/@oh-my-pi%2Fpi-coding-agent@18.9.1.patch) 让 threshold 压缩等待已经进行中的原生后台摘要，继续用 OMP 的分支有效性检查和 snapshot 后追加历史重放；失败或结果失效才重新压缩。2026-10-16 实跑曾在后台请求等待 71 秒后取消它，再发更大的摘要请求，阻塞重做约 140 秒；这些是该轮观察，不代表补丁每次能省固定时长。等待受原有自动压缩取消信号控制，不另设宽限超时，也不改变 256k 阈值。

同日 `2026-10-16T13-42-36.546Z` 续玩又出现两次压缩、四次摘要请求。OMP 调试日志确认首份摘要在约 224k 启动，82–87 秒后已经完成；这时历史增长约 27–29k，超过默认 `keepRecentTokens=20000`，原有 refresh-on-growth 逻辑随即丢弃结果，发第二份摘要，最终在阈值处多等了 54.5 / 41.9 秒。补丁现在保留仍通过原生分支、模型和投影空间检查的已完成摘要，不再仅因自然增长刷新；新历史仍完整接在摘要之后。压缩阈值和 32k 后台提前量不变，不另建压缩器。离线回归覆盖超过 20k 增长时只生成一次并保留 tail，以及分支变化、空间不足时仍重新生成；随后十分钟实跑 `2026-10-16T14-43-29.202Z` 只发一份摘要：82.6 秒就绪，保留约 35 秒后到阈值采用，前台维护仅 3.351 毫秒；这是一次续玩观察，不保证每次都无等待。

后台摘要仍使用 OMP 选定的 Responses Lite，与主循环的 Full Responses 不同。两者正文的 `prompt_cache_key` 相同，但之前独立 `:spec:` 会话缺少 `parentSessionId`，Codex 传输层因此用子会话设置缓存路由头。[pi-agent-core 18.9.1 补丁](patches/@oh-my-pi%2Fpi-agent-core@18.9.1.patch) 透传已有父会话字段，配合 coding-agent 调用点，让后台请求保留独立传输/metadata 身份并共享父会话缓存路由；不改 Lite、SSE 或摘要语义。真实 native V2 路径的 fake-fetch 测试验证了请求头与身份隔离，实际缓存收益需后续启动验证；这不证明过去的零缓存全由路由造成。

同一补丁还保留后台摘要显式传入的独立 `:spec:` session ID 和 `preferWebsockets: false`。原 SDK 后续用宿主值覆盖它们，导致后台请求进入主会话的 WS 路径并漏过 HTTP 日志；现恢复 OMP 本身的后台隔离意图，普通压缩仍使用宿主默认值。

`status` 返回宿主 `runId` 和 `maxSeconds`。控制 IPC 必须携带匹配的 `runId`，并可用 `expectedEpoch` 校验控制周期；CLI 自动读取并带上这两个字段，避免旧看板对重启后的宿主发出控制命令。

更换时长预算并保留上下文时，先停止旧宿主，再用 `rsa run --workspace <原工作区> --seconds 1800` 启动，并按原配置指定模型、Baseware 地址。宿主默认续接该工作区的当前 OMP 会话，保留身份、历史与压缩状态；新的事件日志与观测写入新 run。`--new-session` 开始全新上下文，保留工作区文件。`--resume <原会话.jsonl>` 用于首次绑定旧会话或显式选择历史，会话路径见旧 run 的 `session` 事件；原文件原地继续追加，不搬迁、不搜索或拼接其他历史。恢复不同工作区的会话会被拒绝。

### 工作区与并行运行

`workspace` 就是启动时的当前目录，保存模型自己的技能、记忆、脚本和 `logs/` 运行记录。Harness 源码、提示词和依赖留在 `rsa/`。进入工作区后直接 `rsa run`，宿主、OMP 和工具 shell 都在这个目录运行；这里不复制 runtime、不安装项目插件，也不初始化 Git。

首次启动若缺少 `AGENTS.md`，写入一份简短目录说明；已有文件保留原样。OMP 使用原生 `contextFiles` 加载该工作区根目录的 `AGENTS.md`，配合 `customSystemPrompt` 保留 Harness 主提示；不隐式加载父目录或全局指令，也不把不断增长的日志目录树加入模型上下文。

所有管理命令都可以通过 `--workspace` 或 `RSA_WORKSPACE` 选择工作区，显式参数优先：

```sh
cd /absolute/path/to/workspace
rsa run
rsa status
rsa auto on
# 从别处管理时：rsa --workspace /absolute/path/to/workspace status
# 也可 export RSA_WORKSPACE=/absolute/path/to/workspace 后省略参数。
```

`rsa run --workspace ...` 同样有效。路径按 realpath 归一化，同一目录的符号链接使用同一份状态。两个工作区即使共享父目录，也有独立的会话、运行记录、内容快照和默认 socket。新目录从空经验、空会话开始；重开原目录保留原文件并续接会话，不自动继承其他工作区的内容。若显式复制了任务文件，则这些文件就是新工作区的初始内容。

宿主在打开会话和连接设备前先占用工作区的固定 socket；即使另设 `RSA_SOCKET`，同一工作区也不能并发启动两个宿主。模型凭据仍共享本机 OMP 登录。这是上下文与数据的逻辑隔离，shell 仍可访问本机文件系统和网络；模拟器配置、存档和设备连接由 Baseware driver 管理，不随工作区隔离。

并行游戏还需要分别启动模拟器实例并使用不同桥端口。在第二个 mGBA 实例中打开对应 ROM，再从 Scripting 执行：

```lua
RSA_BRIDGE_PORT = 47654
dofile("/absolute/path/to/repo/baseware/src/drivers/mgba/bridge.lua")
```

随后进入第二个工作区，用 `rsa init --driver mgba` 创建配置，将 `rsa.json` 的 `port` 改为 47654，再执行 `rsa up`。每个工作区有独立 Baseware 地址和 RSA 地址；真实设备也需独立实例。模型、预算在工作区 `rsa.json` 中配置。`driver` 和 `port` 只用于启动 Baseware，Harness 不据此选择设备代码。

### Switch / Ryubing

macOS arm64 桥接基于 Ryubing 的 `Canary-1.3.351` 标签，固定到提交 `475615f0431b4995b03c930c5089d20f6f3570e0`，本地版本为 `1.3.351-rsa.3`。唯一安装应用是 `/Applications/Ryubing.app`，手动和 RSA 使用同一份程序；界面名称是 Ryubing，上游内部可执行文件与进程仍叫 `Ryujinx`。具体构建来源及补丁说明见 [driver README](../baseware/src/drivers/ryubing/README.md)。

准备 .NET 10 SDK、Python 3、Xcode Command Line Tools 后，在本目录执行。当前私有 SDK 为 10.0.402，不依赖全局 SDK：

```sh
# 默认查找 ../../artifacts/switch/dotnet/dotnet，也可用 RSA_DOTNET 指定 SDK。
../baseware/src/drivers/ryubing/build.sh
# 退出正在运行的模拟器，将 ../../artifacts/switch/ryubing-build/Ryujinx.app
# 安装为 /Applications/Ryubing.app 后启动。
../baseware/src/drivers/ryubing/launch.sh '/absolute/path/to/game.xci'
```

源码在 `artifacts/switch/ryubing-canary-source`，签名后的构建暂存在 `artifacts/switch/ryubing-build/Ryujinx.app`。NuGet 配置仅将上游 LibHac 源 URL 替换为 `https://nuget.ryulynx.org/v3/index.json`，其余上游配置与依赖版本保留；不再使用旧 Stable 构建的 LibHac 升版本和标题遍历兼容修改。

固件、密钥、存档与设置继续使用本机 Ryujinx 数据目录；运行前退出另一个使用同一数据目录的模拟器。`launch.sh` 直接运行 `/Applications/Ryubing.app/Contents/MacOS/Ryujinx`，并显式设置 `RSA_BRIDGE_PORT`（默认 47663）启用桥接；游戏开始运行后才能连接。Finder 正常打开同一应用时不启用桥接，使用手动控制。

旧 Stable 基底的火纹验证使用 Vulkan、1× 分辨率、Hypervisor 关闭、一号 Pro Controller；这是历史记录，不表示已验证新版或其他游戏的兼容性。

准备设备后，进入任务工作区使用 `rsa init --driver ryubing` / `rsa up`，或分别启动 `baseware serve --driver ryubing` 与 `rsa run`。项目从空经验开始，不加载其他游戏技能；模型循环与 GBA 使用同一实现。

`screen capture` 请求模拟器呈现画面的原始 PNG；系统输入框弹出时，改采集该弹窗的真实界面，不采集桌面。可用 `capture --delay-ms 500` 在发送采集请求前等待固定时间；默认 0，等待可取消。这不检测动画完成，返回帧序号也不能保证画面已经呈现该次按键的结果。自动观测通过装配层配置，例如 `--auto-observe '[{"controllerId":"screen","argv":["capture","--delay-ms","500"]}]'`，Harness 通过同一 Controller 调用采样，不维护另一套传感器接口。

`pad` 提供 16 个数字按键和四个摇杆轴，原子动作参数见 `rsa controller controller/pad --help`。动作按墙钟时间执行，时长由调用方选择，每段为至少 16 ms 的安全整数，合计也须为安全整数，输入轮询处切换完整状态。命令等待动作完成，期间仍可用 `pad release` 中断。AI 模式覆盖一号手柄及其体感输入；其他玩家、触屏、模拟器快捷键不在此控制器范围内。完成/取消归零，关闭接管或 TCP 断连恢复一号原生手柄输入。桥接只监听本机回环地址，作为可信本机进程间接口，不是多用户安全隔离。

同一装配还提供原生 `touch`，与 `pad` / `keyboard` 共用操作权。查看 `rsa controller controller/touch --help`；公开命令只有 `down --x <整数> --y <整数>`、`move --x <整数> --y <整数>` 和 `up`，范围为 x=0..1279、y=0..719（包含端点），左上为原点，x 向右、y 向下。每个状态转换等模拟器采样后返回，触点跨调用保留。驱动不提供点按或拖拽，也不把截图坐标转换成触屏坐标；这些组合留给 Agent 的 workspace 代码。

实机测试会短按方向键和摇杆，请停在可安全操作的菜单。退出 RSA 宿主、保留游戏运行后：

```sh
RSA_SWITCH_TEST=1 bun test tests/switch.live.test.ts
```

系统输入框由第二个 `keyboard` 控制器负责，可 `type --text` 或 `press --key ENTER|ESCAPE|BACKSPACE|CTRL+A`，详见自身 help。火纹命名框打开且宿主停止时，可另运行 `RSA_SWITCH_KEYBOARD_TEST=1 bun test tests/switch.live.test.ts`；该检查取消测试输入，不提交角色名。

实机检查覆盖新画面、组合输入、状态替换、BUSY、取消、自然结束、断连清理、设备侧旧 epoch 拒绝以及原生键盘弹窗。没有音频采集、游戏内存读取或模拟器存读档命令。

## 统一能力 CLI

`rsa controller` 是 Agent 的主要能力入口，原始 Baseware 目录自动填入同一目录。采样与输入都是 Controller：采样能力主要返回信息或媒体，`requiresControl` 单独声明是否需要操作权，不根据返回图片来判断。CLI 和 Python API 使用同一执行器；能力不会自动追加到 OMP 的 tools。Baseware 原有 CLI / API / MCP 仍可单独使用，RSA 当前不接入 MCP，也不新增 RSA MCP 适配器。

先运行 Baseware，再用 `rsa run --device-only` 启动不带模型的宿主；两者使用同一工作区默认地址。目录和 help 不需要接管：

```sh
rsa controller list
rsa controller controller/screen --help
rsa controller controller/pad --help
rsa auto on
```

标记为 `requiresControl: false` 的采样能力可在手动模式直接调用；输入能力及工作区 Python 函数需要当前接管周期。把 `auto on` 输出中的 UUID 原样放入当前 shell；模型的 shell 会自动得到这些环境变量：

```sh
export BASEWARE_EPOCH='<刚才返回的 epoch>'
rsa controller controller/screen capture
rsa controller controller/pad apply --state '{"RIGHT":1,"A":1}' --for-ms 120
rsa controller controller/pad state
rsa controller controller/pad release
unset BASEWARE_EPOCH
rsa auto off
```

公共 ID 使用 `controller/<driver 能力 ID>` 和 `python/<相对路径.py>:<函数名>`。设备参数原样透传；Python 函数接受 `--args '<JSON object>'`。`list` 给出简短描述、设备是否需要控制权及发现诊断，选中能力后再用 `--help` 获取完整参数。不同 driver 的实际能力、通道和单位以它自己的 help 为准；Harness 不内置按键语义。

采样和输入共用 Controller 调用与执行结果；结果中的 `observations` 保存不可变媒体路径及采样区间，观测文件同时保存到 RSA run。普通文本或 JSON 输出保留在 `stdout`。OMP 的 `observe` 工具只接受不需要控制权的 Controller，并将其观测转换为模型图片块；通常直接使用循环在动作后提供的画面即可。动作时长由调用方决定，人工接管仍能打断。

## 工作区 Python 能力

例如在 `scripts/sampling.py` 中写：

```python
from rsa_tools import Client, capability

@capability
def sample(controller_id: str, argv: list[str]) -> dict:
    """Sample a device using its documented arguments."""
    return Client().call(f"controller/{controller_id}", argv)
```

调用方式：

```sh
rsa controller list
rsa controller python/scripts/sampling.py:sample --help
rsa controller python/scripts/sampling.py:sample --args '{"controller_id":"screen","argv":["capture"]}'
```

Python 可用同一入口组合原始能力和其他工作区能力：

```python
from rsa_tools import Client

client = Client()
catalog = client.list()
help_text = client.help("python/scripts/sampling.py:sample")
result = client.call("python/scripts/sampling.py:sample", {
    "controller_id": "screen", "argv": ["capture"],
})
```

RSA 按需扫描 workspace 中的 `.py` 文件，只登记 `@capability` / `@capability()` 标记的顶层函数。每个参数都需要类型标注，函数需要非空 docstring；默认值来自函数签名。暂不暴露 async、可变参数或仅限位置参数的函数。支持字符串、整数、浮点、布尔、列表、字符串键字典和可空类型；不支持的签名作为诊断返回，不猜测 schema。Python 3.9 使用 `T | None` 时需要 `from __future__ import annotations`。

`list` 以及 Python 能力的 help/call 会重新静态读取 AST，不运行 import 或顶层代码；新增、改动和删除无需重启会话。真正调用时启动 Python、校验源码版本和 JSON 参数、导入文件并返回 JSON 结果，普通 print 放进 stderr。失败向 CLI/API 报错，调用日志保留源码 hash、参数及结果。Python 函数可通过 `Client().call()` 嵌套调用其他能力，也可直接调用普通辅助函数；不另加全局串行队列。

`logs/`、`.git/`、依赖和虚拟环境目录不参与扫描。脚本可放在工作区根目录、`scripts/` 或技能目录，未标记的辅助函数保持普通 Python 用法。签名与语法诊断通过目录返回，供 Agent 自行修正。OMP 仍只暴露 `read/write/edit/exec/observe`，不会逐轮注入完整能力目录或各函数 schema；模型通过 CLI 按需发现。

shell 与 Python 能力自动获得 RSA/Baseware CLI、Python 包路径及当前 `RSA_SOCKET` / `BASEWARE_SOCKET` / `BASEWARE_EPOCH` / `BASEWARE_TRACE`。Python API 连接同一 RSA 宿主，原始设备调用最终交给 Baseware，观测与调用 trace 保持连通。人工接管会取消在途调用和脚本进程组，并由 Baseware 释放设备；脚本不自行获取操作权。这里是可信本机 shell，不是 Python 沙箱。

### 工作区观察 hook

工作区可用一个无参数函数替换循环的自动观测：

```python
from rsa_tools import capability

@capability(hook="observe")
def observe() -> dict:
    """Collect the information useful for the current task."""
    # 在这里调用已发现的能力、处理数据并保存需要返回的媒体。
    return {"text": "...", "media": [{"path": "view.png", "mediaType": "image/png"}]}
```

`text` 和 `media` 均可省略；媒体路径相对于 workspace，也可用绝对路径。函数负责采集与处理，不会预先强制截取默认画面。每个观察边界重新发现当前代码，新增、修改或移除标记从下一次观测生效；只允许一个有效的 observe hook。它仍可通过 `rsa controller` 单独调用，不添加新的 OMP 工具。

无 hook 时沿用默认观测；函数异常、多个 hook 或返回格式错误时，将诊断和默认观测一起交给模型，供它自行修复。取消会结束该次调用，不再追加默认采样。原有 `observe` 工具保留，用于按需读取原始设备。运行日志保存 hook 身份、源码 hash、采样结果和失败信息；源码与媒体分别归档到本次 run 的 `observer-sources/` 和 `observations/`，修改工作区文件不改变历史。

## 边界与数据

```text
../baseware/src/contracts.ts  标准能力契约
../baseware/src/drivers/      设备协议、采集、输入
src/harness/                 Agent 生命周期、OMP、统一能力目录与执行、工作区
src/app/main.ts              连接 Baseware 并装配 Agent
src/app/workspace.ts         本机组件启动与停止
```

Harness 不导入具体 driver，不解释 GBA 按键、帧率或 ROM。`screen capture` 自动观测配置也由装配层传入。提供者内部将小型 screen/pad 实现合在一个文件中，没有另建框架。

工作区就是当前目录，目录用途由根目录 `AGENTS.md` 说明：

- `skills/`：模型自行生成的 `SKILL.md` 和脚本。
- `memory/`：模型维护的当前目标、现场状态、疑问和下一步；覆盖更新工作记忆。
- `logs/<run-id>/`：该次启动的 manifest、events.jsonl、observations 图片、payloads、streams 与复盘结果。
- 其他任务文件由模型按需创建，不要求固定仓库模板。

会话续接状态位于仓库同级运行目录 `../artifacts/rsa/ws-<basename>-<workspace-hash>/`。basename 经过安全字符处理并截取至 32 字符，hash 为工作区 canonical path 的 SHA-256 前 16 位：

- `current-session.json`：当前 OMP 会话的路径；默认重启时使用。
- `sessions/`：本实现新建的 OMP 会话；显式恢复的旧会话仍留在原路径。
- `skill-versions/`：沿用内容 hash 存储技能和记忆的文件及独立清单；记忆变化不改变技能版本。
- `workspace.json`：仅供看板定位工作区及其 `logs/` 的路径索引，不是项目配置。

已有工作区、技能和记忆不搬迁或改写，旧运行日志也保留原处，仍可在看板查看。内容 hash 只用于运行证据，不是新增的 Git 管理或项目版本系统。

宿主或模拟器的额外 stdout/stderr 重定向文件也约定放在该工作区的 `logs/` 下。做 `workspace-before/after` 快照时排除 `logs/`，避免把历史日志再次复制进本轮目录。

每次 prompt 开始，以及一条模型回复中的整批工具执行结束后，采集自动观测、更新技能索引。`exec` 和 `observe` 按调用顺序执行；批次内最后一次 `exec` 后已有成功主动观测的传感器，优先复用其最近一次结果，即使参数与默认采样不同；其余默认传感器照常采样，每次 `exec` 清除此前可复用的观测。初始观测保存为 OMP 会话消息，后续观测随最后完成的工具结果保存；主动观测的图片不重复附加。模型按需读取技能正文和执行脚本。

模型默认使用循环已提供的观测进行下一次决策；`observe` 保留为按需补充采样的能力，用于已有观测不足、读取其他传感器或使用不同采样参数的情况。提示词与工具说明不要求模型在每次操作后再主动采样。

2026-10-17 连续运行暴露出只有 `skills/` 持久化出口的问题：模型把当前状态和可复用经验混在一起，即使提示“合并经验”，仍不断追加旧 `CURRENT`。现在用 `memory/current.md` 保存当前工作记忆，技能保存适用条件、做法、验证方式和例外；没有新规则、修正或例外就不需要改技能。两类文件只自动注入索引，正文由模型按需读取，版本共用原有内容存储。内容完全由环境 agent 维护，Harness 不预置游戏经验。

`rsa consolidate [--seconds 600]` 在 manual 且空闲时，让原 OMP 会话做一次文件整理。期间只开放 `read/write/edit`，不采集传感器、不接管控制器；结束后恢复原工具。`status.consolidating` 和 `consolidation_start/end` 记录过程与完成、取消或失败，`rsa auto off` 可取消，清理完成前不接受下一次任务。它是显式的一次整理，不新增定时复盘循环、摘要服务或自动压缩机制；OMP 原生 256k 压缩不变。提示词在宿主启动时载入，修改后需重启宿主。

观测图片进入会话前调用 OMP 自带的 `resizeImage`，使用其默认尺寸和编码预算；原始传感器文件保留。2026-10-15 排查发现，原先自定义 observe 直接塞入 PNG，绕开了 OMP 的常规压图路径，58 张图累积出约 74 MB JSON、54 MB 实际传输体。因此在入库时压一次，避免每次请求重新编码历史。正常轮次只追加历史，仍保留 `Infinity` 图片数量策略；上下文缩减交给 OMP 压缩。已有会话不会自动改写图片，做性能对比时须另存副本再一次性转换。认证来源由 OMP 管理。

### Harness 统一图片预算与缓存

OMP 18.9.1 的提供者图片预算表没有 DeepSeek，它会使用默认上限 5 张，在发送前逐轮删除最旧的图片。2026-10-13 的 12 请求实跑中，第 4 次请求首次删除历史图片，当次缓存命中率从上一轮的 71.9% 降到 19.9%；11 对相邻请求中有 9 对历史前缀被改写。此前只检查持久化会话历史，漏掉了这层发送前转换，最终由事件日志保存的实际 HTTP body 定位。

因此 [OMP 适配层](src/harness/omp/session.ts) 统一通过 `createOmpSession` 创建会话，在调用 SDK 前设置 `PROVIDER_IMAGE_BUDGETS[model.provider] = Infinity`。这条策略适用于 Harness 选择的所有提供者，包括以后新增的提供者，不维护 DeepSeek、Codex 等白名单。它同时解除 DeepSeek 的默认 5 图和 Codex 的 200 图数量裁剪，让历史图片保留到上下文压缩。覆盖仅影响当前宿主进程，不修改独立 OMP CLI 的全局配置或依赖源码；token、请求体预算与服务端限制仍然生效。修改后需重启宿主才会加载。

回归测试覆盖真实 OMP 的发送前转换：DeepSeek 通过本地 HTTP 服务验证超过 5 张后图片与消息前缀仍完整；Codex 累积到 208 张，验证超过原先 200 张上限后图片仍保留、增量前缀仍有效。测试不调用付费模型。

Harness 的 OMP 设置采用 `providers.openaiWebsockets: auto`，Codex 使用原生 WebSocket 增量链，保持完整历史。2026-10-16 的 5 分钟实跑中，约 9.1 MB 完整首帧成功，后续 31 次增量请求中位约 250 KB、6 秒；之前 SSE 续玩一轮的请求耗时中位约 22.7 秒。场景不同，这是实际使用对比，不是严格基准。

`package.json` / `bun.lock` 固定 [pi-ai 18.9.1 补丁](patches/@oh-my-pi%2Fpi-ai@18.9.1.patch)：实际序列化 WS JSON 帧超过 **15 MiB**（本地预算，非服务端上限），或收到远端 `1009`，立即改走完整 SSE；尺寸阻断期间不反复握手，等 OMP 原生压缩后再允许 WS。小的增量帧不受累计历史大小影响。其他传输故障、取消和已交付输出的防重复逻辑仍由 OMP 处理。用 `bun install --frozen-lockfile` 可重现补丁，不需要修改全局 OMP。

最初的 12 MiB 本地预算曾把 13.9 MB 的合法候选首帧提前挡回 SSE。放宽后，15,112,911 字节的完整首帧实跑成功，后续回到约 260 KB 增量。完整首帧仍花费约 66 秒，因此按五分钟观察效果时复用同一宿主与连接；只有加载代码改动才重启。256k 压缩阈值保持不变。

WS 握手超时、socket 错误，以及连接到期（`websocket_connection_limit_reached`）需要回退 SSE 时，采用同一个 60 秒冷却；之后由下一次正常请求重建 WS，发送完整历史，再恢复增量链。2026-10-18 六小时实跑中，到期前的空 thinking 占位触发了 OMP 的 SSE 重放和永久禁用；现将到期纳入已有临时恢复逻辑，保留当前请求的重试上限与已交付工具调用不重放规则。`model_start` / `model_end` 的 `transportDetails` 中，`sizeBlockedUntilCompaction` 表示等待原生压缩解除的尺寸阻断，`retryWebsocketAt` 是临时回退后允许重试的 Unix 毫秒时间，与永久故障标记 `websocketDisabled` 分开。

2026-10-17 第十八轮出现连接已断、但 append 状态仍保留时发送旧 `previous_response_id` 的情况。OMP 原先先构造增量体，再取得连接；后一步重建连接虽清除了状态，已构造的请求却仍引用旧响应。补丁将请求体构造移到连接确定之后：新连接首帧发送完整历史，同一连接继续增量。离线回归先复现旧行为，再验证重连后的全量请求和随后恢复增量；不改变重试次数或 SSE 策略。该轮另一次无入站事件的 WS 失败随后恢复，现有日志不足以确定具体关闭原因，不将它一并归因于上述问题。

此前曾统一关闭 WS：2026-10-14 恢复火纹会话时约 19 MB 首帧被拒，SSE 虽可继续，却每轮完整上传历史。下面保留这次排查依据。

后续独立诊断确认了拒绝原因与 SDK 行为（原始记录位于本地 `artifacts/rsa/transport-investigation-20261014/`）：

- 同一个 19,229,674 字节请求，在 OMP 18.9.1 / Bun 1.4.0 和独立 Node 22 / ws 客户端都收到远端关闭码 **1009**，即消息过大；本地放宽接收上限的 Node 服务完整接收了 Bun 发出的相同字节，SHA-256 一致。独立 Node 的 16 MiB + 1 字节合法 JSON（末尾空白填充，不增加模型上下文）也收到 1009。精确上限尚未测定，不能据此声称阈值恰好是 16 MiB。
- 未打补丁的 OMP 18.9.1 在离线假连接每次返回 1009 时发送 **6 次**（首次加 5 次重试）才回退 SSE。`retry.enabled: false` 关闭的是 agent 层重试，未关闭这一层传输重试。对相同大包反复重发无法解决体积拒绝，这是 SDK 的错误分类/降级缺陷；底层网络事件未通过 `onSseEvent` 暴露，也是原 Harness 日志看不到拒绝原因的原因。
- SSE 连续成功请求的压缩后上传量从约 13.5 MB 增长到 21.8 MB，响应头等待从约 54 秒增长到 111 秒。第二轮输入缓存为 96.2%，仍耗时约 58 秒；缓存不会省掉上传。日志记录的请求准备仅约 0.6～0.9 秒，观测约 0.2 秒，手柄动作约 0.1 秒。现有计时无法进一步区分上传、网络与服务端排队；诊断期间短暂请求重叠可能影响并发限流，不能据此排除用户在 Codex 侧看到的 429。

当前循环在每批工具完成后提供一组观测，并复用该批显式 `observe` 的结果；模型图像在首次入历史前按 OMP 路径编码，之后保持不变。`status.thinking` 仍表示 agent 循环正在运行，细分阶段由事件日志和看板展示。确认游戏推进可同时查看 `model_end`、`execution` 与操作后的画面，传感器/控制器边界不包含游戏语义。

## 事件日志

Agent Loop 内核语义上称为 **Shiori**，当前实现 OMP 18.9.1。schema 2 事件新增 `source`（职责/实现/版本）、`origin`（原事实身份/时钟）与跨进程 span 关系；旧事件名与 payload/stream 存储方式继续使用。OMP 原生 telemetry 现在写入 `shiori_span_start/end` 和 `shiori_run_end`，使用局部 tracer、不配置远程 exporter。统一能力入口用 `capability_start/end` 记录完整终态，Python/设备细节沿同一调用树关联。完整字段及分析口径见 [日志契约](docs/logging.md)。

每次启动默认记录到该次 run 的 `events.jsonl`。每行带 `schemaVersion: 2`、`runId`、递增 `seq`、UTC 时间 `at`、宿主单调时间 `atMs`、`type`、`trace` 和 `data`。`trace` 使用以下关联字段：

- `epoch`：一次接管；`modelCallId`：一次主循环模型调用。
- `requestId`：OMP 构造的一次提供者请求；`httpId`：一次实际 HTTP 发送。同一请求的传输重试有不同 `httpId`。
- `toolCallId`：模型工具调用；`operationId`：一次传感器读取、控制器执行或压缩操作。

模型调用的 `model_start` 引用本轮观测 ID 与技能版本，`model_end` 保存用量、首 token 耗时、调用耗时、结束原因及响应文件引用。`model_request` 保存经过 OMP 提供者转换和扩展处理后的完整请求，包括 messages、图片、工具定义和推理参数。`model_http_start` 另外保存 HTTP 实际发送的 body 字节，`model_http_end/error` 保存响应状态、失败正文或传输错误。HTTP 结束事件计时到收到响应头，模型结束事件计时到流结束。

大对象放在 `payloads/<sha256>.json.gz` 或 `.bin.gz`，引用中的 hash 与 bytes 对应解压后的字节；不截断内容。相同内容复用文件。HTTP body 自身若启用了压缩，先解开日志的 gzip，再按该事件的 `contentEncoding` 解释。`streams/<modelCallId>.jsonl` 保存 OMP 暴露的原始 SSE 事件或 WebSocket 帧及时间，供核查服务端原始 usage；无流事件时不会创建该文件。`model_end.usage` 则是 OMP 统一后的统计格式。

`tool_start/end`、`exec/exec_result`、`observation_start/end/error`、`command/execution/execution_error` 串起模型到能力边界的执行链。shell 和 Python 通过 `BASEWARE_TRACE` 将关联字段带入设备请求。这些只是观测元数据，操作权由本轮 epoch 校验。`python_capabilities`、`python_capability/result` 记录能力目录、源码 hash、调用参数及结果。Baseware 独立保存设备日志，同时推送给 RSA；RSA 将观测文件复制进自己的 run，保持 Dashboard 与 Pet 的日志读取方式。工具正文单独保存；观测文件与技能版本沿用已有存储。

为排查 2026-10-15 实跑中的动作后过早采样和技能读取漏记，日志额外记录以下信息；这些诊断字段不进入模型上下文，也不改变采样时机：

- `observation.origin` 区分 `prompt_start`、`tool_batch`、`explicit` 和 `cli`。`afterExecution` 关联采样请求前最后完成的控制器调用，并记录从该调用结束到采样请求／返回的间隔；只比较同一时钟。`previousObservationId` 和可选 `sourceSequenceDelta` 关联同一传感器、同一参数的相邻采样。序号增长只能证明源序列前进，不能证明游戏已完成动作或画面已稳定。
- `observation_context` 列出循环采用的新采样与复用的主动采样。`observation_media` 记录每张图片读取和编码耗时、原始／模型图片字节数及输出尺寸，便于确认没有重复编码历史。
- `read` 在工具返回后记录原始路径、OMP 解析出的实际文件路径、成功／失败和读取后文件 hash，支持 `SKILL.md:19-22` 这样的选择器。hash 表示日志采集时的整份文件版本；实际返回的片段和多目标读取结果以 `tool_end` 的正文为准。
- `model_http_dispatch` 标记检查、保存请求体后即将调用 fetch 的时刻。`model_http_end.fetchToHeadersMs` 单列 fetch 到响应头的等待，`model_ws_dispatch` 记录通过尺寸检查、即将交给 socket 的 JSON 帧大小；`model_request` 的 transport/bodyBytes/incremental 描述构建的请求。`model_stream_start` 只标记首个入站事件，忽略 OMP 混入同一回调的出站 WS 通知（不等同首个文本 token）。`model_end` 汇总请求快照、HTTP 请求体检查和流日志写入耗时，以及首事件前后时间。这里仍不能把上传、网络和服务端排队拆开，不能把首事件前的等待全算成模型推理。

在 run 目录查看某轮请求与结果：

```sh
jq 'select(.type == "model_end") | {trace, data}' events.jsonl
jq 'select(.type == "model_request") | {trace, payload: .data.payload}' events.jsonl
# 打开第一份完整请求：
rsa_payload=$(jq -r 'select(.type == "model_request") | .data.payload.path' events.jsonl | head -n 1)
gzip -dc "$rsa_payload" | jq .
```

传输日志不复制认证请求头、Cookie 或模型凭据；响应头仅保存 content-type、content-encoding、request-id、retry-after、server-timing 和 cf-ray 等诊断字段。错误额外记录 code，以及 Error cause 的 name/code/message，不复制任意错误附带对象。请求与工具正文仍按实际内容保留。它们保存在 Git 忽略的本地运行目录中。

当前完整模型传输记录覆盖主循环；OMP 内部压缩保存开始/结束事件和原生会话记录，其内部摘要调用不经过这个主循环拦截器。HTTP 字节一致性、错误、取消、重试与 CLI 关联由本地假服务验证；WebSocket 通过 OMP 接口记录请求 payload 与响应事件，已在 Codex 实跑中核对 `previous_response_id` 续接及服务端原始 usage，不记录底层握手或 socket 帧字节。日志提供检查事实，质量评分由后续分析实现。

Codex 原生压缩另用 `compaction_http_start/end/error` 观察 HTTP 边界：只识别 Codex 端点与 `request_kind=compaction`，保留原始调用和 Response，不读取或复制请求／响应流。每次 HTTP 有独立 ID，记录已知内存请求体的字节数、响应头等待和安全错误字段。`start.body` 复用 payload 文件保存 string、ArrayBuffer 或 view 的实际字节（尊重 view 的 offset/length）；未知流不读取、不保存。2026-10-16 出现压缩缓存为 0、邻近主请求仍命中 96.8% 的情况，这份正文用于离线比较缓存标识及历史前缀。落盘完成后才开始 `fetchToHeadersMs` 计时，落盘开销包含在较大的 `durationMs` 中。`end` 只表示响应头返回，不表示摘要完成。成功压缩的 usage 从 OMP 原生结果单独读取。后台准备与最终提交可能相隔数分钟，因此不能用 `auto_compaction_start/end` 的间隔代表完整网络耗时，也不能仅凭相邻 HTTP 失败就认定下一次是重试。

`compaction_speculation` 将 OMP 已有 logger 的后台生命周期接入同一事件流，stage 为 `started`、`armed`（摘要完成）、`invalidated`、`waiting`、`applied`、`failed`、`cancelled`；仅记录白名单中的方法、snapshot leaf、上下文大小、阈值、耗时与原因。`armed.durationMs` 是从快照准备后到摘要可用的时间，`waiting` 是主循环开始等待的时刻；结合最终 `auto_compaction_end` 可区分摘要生成慢、结果失效重做和提交等待。`applied` 表示选中结果进入提交，最终是否成功以 `auto_compaction_end` 为准。

`compaction_retry` 复用该 logger sink，严格匹配 OMP 原生 V2 压缩的重试警告，仅记录失败的 attempt、声明的退避毫秒、模型和字符串错误原因。2026-10-17 一次压缩先收到 HTTP 200，约 198 秒后流内返回 `server_error`，随后由原生 V2 逻辑重试；单看 HTTP 日志无法发现这类失败。分析器的 `summary.compactionRetries.announcedRetries` 统计选定接管期间明确的重试声明，`errorReasons` 汇总原因；警告发生在退避之前，不代表已经重新发出请求。没有重试事件时计数保持 `null`（包括旧日志），不从连续的 HTTP 200 推断重试；新日志用同一 operationId 关联到摘要候选。此观测不改变上游重试行为。

本地 [Next.js 观察台](../rsa-dashboard/README.md) 读取这些日志，显示逐请求延迟、请求体、缓存、动作与截图、技能证据和压缩事件。可切换环境与历史运行，并对匹配的当前宿主交还控制权；不发诊断模型请求。

`python3 scripts/analyze-run.py <run目录>` 离线生成 `analysis.json`，用 `--output <路径>` 指定其他位置。同一宿主多次接管时必须用 `--epoch <UUID>` 选择周期，模型、工具和压缩 HTTP 按周期及关联 ID 隔离，保留停止后的清理事件。支持空日志、未完成请求和只有一个完成请求；成功压缩的原生 usage 与独立 HTTP 统计单列，不混入主循环缓存指标。该脚本不打开完整 payload，也不访问模型或设备。
观测明细的 `argv` 按 epoch 和 operationId 关联 `observation_start`，缺失时为 `null`；`captureMsByOrigin` 按观测来源分组统计完整采样区间，和 `captureMs` 一样包含主动等待，不解析传感器参数来推断纯捕获耗时。

分析结果中的 `compactionSpeculation` 保留后台生命周期；其 summary 统计各阶段次数与摘要就绪耗时。`compactionMaintenance` 单独记录前台 `auto_compaction_start/end` 的窗口，汇总已结束窗口的阻塞耗时（包括失败或取消），未结束的保持 pending。新日志的 HTTP 子 span 与所属候选／维护显式关联，后台摘要耗时和主循环停顿仍是不同指标。候选通过 OMP 的诊断通道在创建时固定 operationId 与 epoch；晚到完成、重试、应用与清理保留原身份。分析器与看板统一按 trace.epoch 选择事件，控制边界只计算活跃时长。旧日志缺少身份时不补猜，详见 [日志契约](docs/logging.md)。

`summary.toolErrors` 与 `toolErrorsByName` 从工具明细的 `isError: true` 汇总总数及工具名分布，与模型请求失败数 `failedRequests` 分开；工具用法错误即使随后自行纠正仍保留计数，不据此判定环境故障。

mGBA 0.10.5 的 socket 析构会再次关闭未置为无效的描述符（[源码](https://github.com/mgba-emu/mgba/blob/0.10.5/src/script/socket.c#L107)）。桥只关闭一次并保留已关闭的 Lua wrapper，直到模拟器退出，避免回收时误关后来复用的连接；这会随连接次数保留少量对象，不保留打开的 socket。此处理仅属于该固定版本提供者。

这是本地可信 shell 实验，不是系统级隔离环境。没有预置游戏知识、音频、RAM 读取、攻略、评分器、自改 loop 或自动重连。

## 验证

可重复的 Harness 基准用例复用同一日志和看板：`rsa bench list` 查看四个 case，`rsa bench run all` 执行离线可靠性验证，`rsa bench run capability-reuse --live` 在全新 workspace 中评测真实模型的能力创建与复用。结果在 **Benchmark → 基准用例** 查看；不会操作当前游戏。执行参数、判定和限制见 [Benchmark 说明](benchmarks/README.md)。

```sh
bun run check
bun test
```

真实设备测试要求已加载 Lua 桥，并在另一个终端运行 **device-only** 宿主。测试会操作当前游戏并交还控制权：

```sh
RSA_MGBA=1 bun test tests/device.live.test.ts
```

另外，关闭宿主但保留 mGBA 脚本运行，可验证连续重连和动作中断线：

```sh
cd ../baseware
RSA_BRIDGE_TEST=1 bun test tests/bridge.live.test.ts
```

覆盖不同能力词汇注入、跨轮旧操作拒绝、交接期间取消、模型退出与设备交还解耦、技能版本、OMP 工具参数适配、观测持久化与请求前缀续接、模型传输与 CLI 事件关联，以及真实 PNG、有限按键、并发拒绝和执行中交还。普通测试不调用付费模型。

设计依据见 [架构文档](docs/architecture.md)，mGBA 接口见 [官方脚本文档](https://mgba.io/docs/scripting.html)。
