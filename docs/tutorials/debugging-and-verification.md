# 控制台调试与验证

本篇介绍各组件包脚本命名约定、如何在不依赖 `launchd` 的情况下前台单步调试 Baseware / Host / Dashboard / Ludens Pet，以及如何运行全仓离线检查与模拟器实机测试。常规整套启停见 [安装与工作区启停](quickstart.md)。

除显式 `cd` 的命令块外，以下命令均在**仓库根目录**执行。切换到工作区进行前台调试后，运行后续组件命令前请回到仓库根目录。默认使用浏览器控制台；桌宠相关命令需先完成 [可选桌宠安装](quickstart.md#可选桌宠)。

## 脚本命名与命令目录

各包的 `package.json` 脚本遵循同一套命名规则，包管理器与锁文件保持各组件现有选择：

- 包级通用命令使用 `dev`（开发服务）、`build`（生成构建产物）、`start`（启动已构建应用）、`test`（默认自动化测试集）、`typecheck`（类型检查）；只提供组件实际需要的命令。
- 专用命令使用 `<对象>:<动作>[:<变体>]`，每段采用 lowercase kebab-case，例如 `pet:preview`、`omp:test:transport`。局部任务不得使用裸 `preview`、`smoke` 或 `check`；`rsa`、`baseware` 这类与 CLI 同名的透传入口允许保留，具体动作由后续子命令指定。
- 默认 `test` 包含集成测试，不得将其命名为 `unit`。检查已有构建产物使用 `build:check`，该命令只检查，不执行构建。
- 命令改名时同步调用方与文档，不保留旧别名。

命令目录中的脚本在对应组件目录执行。Bun 包使用 `bun run <命令>`，Dashboard 使用 `npm run <命令>`，可选 Companion 使用 `pnpm <命令>`：

| 组件目录 | 包级命令 | 专用命令与入口 |
| --- | --- | --- |
| `baseware` | `typecheck`、`test` | `baseware`：运行设备服务 CLI。 |
| `rsa` | `typecheck`：检查 TypeScript 与 Python；`test`：运行两种语言的默认测试集。 | `typescript:typecheck`、`python:typecheck`：单独检查对应语言；`typescript:test`、`python:test`：单独运行对应语言测试；`omp:test:transport`：运行 OMP WebSocket 传输恢复测试；`rsa`：运行 Host CLI。 |
| `rsa-dashboard` | `dev`、`build`、`start`、`test`、`typecheck` | `build:check`：校验现有生产构建与当前源码指纹是否一致。 |
| `rsa-companion` | `build`：使用 esbuild 生成 Electron 产物；`start`、`test`、`typecheck` | `pet:preview`：桌宠交互预览；`pet:smoke`：桌宠交互冒烟测试。两者都会先执行 `build`。 |

## 独立组件与控制台

### 1. 前台分步调试 Baseware 与 Host

不经过 `rsa up` 单独调试时，先按 [设备与驱动准备](devices.md) 准备好设备桥，随后在两个终端进入同一工作区分别启动服务：

```sh
# 终端 1：启动设备服务
cd /absolute/path/to/workspace
baseware serve --driver azahar \
  --driver-package github:luokerenx4/ludens-3ds-driver#5b9b1f4032a5973a8882aa23957c3c34da50af9e \
  --port 47673 --data-dir ./logs/baseware
```

```sh
# 终端 2：启动前台 Host（不读取 rsa.json，默认 300s / 50 次请求）
cd /absolute/path/to/workspace
rsa run --model openai-codex/gpt-6.1-sol --seconds 300 --requests 50
```

先用 `rsa workspace open <path>` 登记当前布局的工作区；旧工作区需按 [导入说明](quickstart.md#已有工作区登记与迁移) 处理。看到终端 2 输出 `"ready": true` 后，即可在第三个终端进入该工作区执行 `rsa auto on`。若仅测试设备与工作区能力而不启动 OMP 模型会话，可传入 `rsa run --device-only`。默认 socket 仍按当前工作区路径派生，也可通过 `BASEWARE_SOCKET` / `--baseware-socket` 与 `RSA_SOCKET` 显式覆盖。移动目录前应停止对应服务；这一进程地址与 `.rsa/workspace.json` 中保留不变的身份无关。

### 2. Dashboard 网页控制台

仅开发或查看前端界面时无需启动模型与模拟器，空日志目录也可直接运行：

```sh
# 开发模式（支持前端 HMR；修改 lib/ 或 worker/ 后需重启进程）
(cd rsa-dashboard && npm run dev)

# 生产模式（rsa up 受管启动使用的模式）
(cd rsa-dashboard && npm run build && npm run start)
```

`rsa up` 需要新启动 Dashboard 时，会在拉起设备前调用 `npm run build:check` 校验构建产物与当前源码指纹；若未构建或源码已更新，会提示先执行 `npm run build`。如果已有 Dashboard API 可用，`rsa up` 会直接复用，不检查或热更新该进程的构建。更新生产控制台时需重新构建并重启 Dashboard；仅停止或重启 Dashboard 不会停止正在运行的 Host、Baseware 与模拟器。

打开浏览器访问 `http://127.0.0.1:3015` 即可使用控制台。侧栏按作用域分段：**工作区**段展示当前工作区的运行信息，**全局**段放不依赖具体运行的页面，**开发者**段放原理展示工具；运行/周期选择器与实时刷新开关只出现在需要运行上下文的页面头部。

- **运行与回放（`?view=live` / `?view=replay`）**：实时查看模型推理流、工具调用、设备输入与感知画面，或在历史时间轴上同步回放采样帧与事件。归档 worker、冷索引构建子进程与内存预算详见 [消费与指标解释](../reference/logging.md#消费与指标解释)。
- **性能与评测（`?view=benchmark`）**：查看单次请求的耗时、缓存与调用链剖析，或在“评测目录”（`?view=benchmark&bench=cases`）中查看跨工作区的 Harbor 任务执行历史与评分对比。
- **能力目录与驱动校验（`?view=caps`）**：静态展示当前选中工作区的设备目录快照（`baseware.json`）、Python `@capability` 声明及 Harbor 评测任务，并提供外部驱动包的在线校验与 `rsa init` 命令生成。
- **感知配置（`?view=perception`）**：配置所选工作区的热窗口秒数、视频分段时长与停采空闲收尾秒数（写入 `.rsa/settings.json`，执行 `rsa perception reload` 后生效）。
- **工作区管理（`?view=workspaces`）**：创建新工作区（名称与可选目录）、登记已有目录、只移除索引，以及设置默认父目录；读取同一 `LUDENS_HOME` 下的配置与 `registry/<id>.json`。
- **站内文档（`?view=docs`）**：直接在控制台内浏览 `docs/tutorials/`、`docs/reference/` 与 `docs/insights/`，支持跨篇与章节锚点跳转。
- **全局设置（`?view=settings`）**：集中 Ludens Pet 陪伴偏好（跟随、气泡、声音）等不依赖具体运行的设置；工作区自身的设置在各自页面。
- **开发者面板（`?view=dev`）**：原理展示工具容器，目前有 Loop 注入实验台（`?view=dev&panel=loop`），模拟一次接管的上下文构成并对照已删除的批次末注入通道，详见 [注入收敛为轮首单通道](../insights/omp-injection.md)。

### 3. Ludens Pet 桌面伴侣

这是可选组件，网页控制台不依赖 Electron。完成 [可选桌宠安装](quickstart.md#可选桌宠) 并启动 Dashboard 后，在仓库根目录运行 `rsa-companion/bin/rsa-companion --show-window` 可单独启动桌面端；其主窗口加载同一份 Dashboard 控制台，桌宠角色（卢登斯）与气泡消费同一套增量活动日志。通过 `rsa up` 管理桌宠时，在新工作区的 `rsa init` 命令中追加 `--pet`，或在已有 `rsa.json` 设置 `pet: true`。`rsa up --pet` / `--no-pet` 可临时覆盖配置，两者互斥且不写回文件；`--no-pet` 不会关闭已运行的共享桌宠。

- **工作区跟随**：在 Dashboard 界面点击“让 Ludens Pet 跟随此工作区”即可实时热切换关注目标（状态保存在 `$LUDENS_HOME/pet/target.json`，心跳在 `pet/consumer.json`）。桌宠读取 `.rsa/workspace.json` 的稳定 ID；工作区移动并重新登记后继续跟随同一身份。浏览历史回放不会改变当前跟随目标。
- **启动参数**：`--workspace PATH`（或 `RSA_WORKSPACE`）指定首次默认工作区，`--dashboard URL` 指定控制台地址，`--profile PATH` 指定独立偏好目录（默认 `$LUDENS_HOME/pet/profile/`），`LUDENS_DISABLE_COMPANION=1` 可禁用桌宠挂件。未设置 `LUDENS_HOME` 时使用 `~/.ludens`，所有组件需使用同一 home。关闭主窗口仅隐藏到托盘，双击桌宠或通过系统托盘菜单可重新唤出，选择 Quit 才彻底退出进程。
- **构建同步**：当修改了 Dashboard 供桌宠消费的共享日志客户端代码时，需重新执行 `(cd rsa-companion && pnpm build)` 并重启 Electron 主进程。

## 验证

### 1. 离线全量检查

以下核心组件检查完全离线，不连接外部模型或真实模拟器：

```sh
(cd baseware && bun run typecheck && bun test)
python3 baseware/scripts/sync-cua-contract.py --check
(cd rsa && bun run typecheck && bun run test)
(cd rsa-dashboard && npm test && npm run typecheck && npm run build)
```

已安装可选桌宠组件时，再执行其现有检查：

```sh
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
| mGBA 连续断线恢复 | 模拟器与桥保持运行，停止占用该桥的 Host 与 Baseware | 在 [GBA 驱动仓](https://github.com/luokerenx4/ludens-gba-driver) 按 README 运行实机测试，并显式指定端口。 |
| Ryubing 按键/采样/长动作中断 | 游戏停在安全可输入画面，停止 Host 与 Baseware，模拟器桥保持运行（可用 `RSA_BRIDGE_PORT` 覆盖端口） | `RSA_SWITCH_DRIVER_PACKAGE=github:luokerenx4/ludens-switch-driver#070edf662ba724e1a31c5b477f414d4da61bbd6f RSA_SWITCH_TEST=1 bun test rsa/tests/switch.live.test.ts` |
| Ryubing 系统键盘框 | 同上，且已打开火纹的八字符命名框。测试会输入九字符并按 Enter 验证拒绝，再取消；不要在其他输入框执行，以免实际提交名字。 | `RSA_SWITCH_DRIVER_PACKAGE=github:luokerenx4/ludens-switch-driver#070edf662ba724e1a31c5b477f414d4da61bbd6f RSA_SWITCH_KEYBOARD_TEST=1 bun test rsa/tests/switch.live.test.ts` |

## WS 恢复测试依据

针对长周期运行中 OpenAI Codex WebSocket 到期、异常关闭码（如 `1012`）与未完成工具调用恢复的专项测试矩阵与设计复盘，见 [WS 恢复测试依据](../insights/ws-recovery.md)。
