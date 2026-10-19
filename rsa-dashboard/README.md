# Playness 统一控制台

浏览器与 Electron 共用的本地 Next.js 界面，包含运行、Benchmark 和 Alice 三个视图。读取 `<workspace>/logs/<run>` 的真实 `manifest.json`、`events.jsonl` 和保存的观测。通过 `../../artifacts/rsa/<workspace-id>/workspace.json` 中的路径发现工作区，仓库外的工作区也可显示；原有 `../../artifacts/rsa/<project>/runs/<run>` 仍可回放，不搬迁历史日志。只监听 `127.0.0.1:3015`，无需模型密钥，不发送模型请求。

`rsa-companion` 的 Electron 主窗口直接加载这个 URL，已经移除原先独立的 React / Vite 运行界面。它保留 Alice 的原生浮窗、托盘、音频和本地偏好，通过窄范围 preload 接口供共享设置页面使用；原生 IPC 检查配置的 Dashboard origin 和主 frame。界面范围、结构和视觉方向见 [统一控制台 PRD](../docs/unified-console/prd.html)。

所有相对路径以本组件目录为基准：`../../artifacts` 是与 monorepo 根目录并列的本地运行数据目录，故意放在 Git 仓库外。首次启动还没有日志时显示空列表。

```sh
cd rsa-dashboard
npm ci
npm run dev
```

打开 http://127.0.0.1:3015 。生产运行使用 `npm run build && npm start`。

要查看同一页面的桌面版，先在 `rsa-companion/` 安装依赖并执行 `pnpm build`，再从目标工作区启动：

```sh
/absolute/path/to/repo/rsa-companion/bin/rsa-companion --show-window
```

`--workspace PATH` 可显式选择工作区，`--dashboard http://127.0.0.1:3015` 选择本地服务。启动桌面壳只消费已有日志，不发模型请求或游戏操作；常规整套服务启动仍可使用 `rsa up`。

## 三个共享视图

- **运行**：输入画面、当前执行状态与完整活动流；thinking、text、tool、system 和诊断内容使用不同排版，可筛选和查看详情。Pet 点击详情带上原始 project / run / epoch / block，定位到同一活动流。
- **Benchmark**：“运行剖析”保留请求、缓存、传输、压缩和观测统计，以及 Shiori、能力调用和 Baseware 的关联记录；“基准用例”展示四个固定 case 的真实结果、检查证据、执行条件和历史基线差值。用例由 `rsa bench` 显式运行，页面只读，不调度在线模型。见 [用例说明](../rsa/benchmarks/README.md) 与 [PRD](../docs/benchmarks/prd.html)。
- **Alice**：桌宠可见性、日志展示梯度、通知暂停、声音开关 / 音量 / 文件导入 / 试听。浏览器显示桌面能力说明并禁用原生设置；偏好保存在本机 Alice profile，不写入工作区。

运行剖析共用工作区、run 和 epoch 选择，URL 使用 `view=live|benchmark|alice`，详情可带 `block`。基准用例是跨工作区视图，使用 `view=benchmark&bench=cases`，URL 保存 case / result / baseline。没有真实接管周期的离线基准可回放完整 run，保留原 trace，不伪造 control。Alice 隐藏时，已启用的窗口内通知仍会在桌面控制台显示。

## 日志与指标

- 环境项目、运行、接管周期选择；默认跟随最新 epoch，每 2.5 秒刷新，手动选中请求后保持回放位置。统计与回放严格按 `trace.epoch` 隔离，晚到清理保留在原周期；无 epoch 不推断归属。
- 请求耗时 / HTTP 响应头等待 / WS 首事件等待、缓存命中率、实际 HTTP 请求体曲线；点击图表或请求时间轴联动动作与前后观测。
- 观测来源、动作完成到采样请求间隔、源帧变化、采样与编码耗时。工具卡单列命令执行（exec → exec_result）与工具全程（tool_start → tool_end，含后续观测），按 epoch/modelCallId/toolCallId 关联；两者为包含关系，不相加，未完成显示未知。
- skill 的 read / write / edit 工具证据，成功状态和可用的读取哈希；错误、正常中止、OMP 压缩事件。
- Shiori 原生 span / run summary、CLI 与 Python 能力及 Baseware 调用关系。使用明确的 trace / span 身份关联；来源、错误与取消状态保留，缺失数据不补成成功。父子耗时存在包含关系，不相加；OMP 原生 usage 不与主循环 usage 重复求和。
- 压缩候选准备、前台维护及其 HTTP 子 span 使用同一调用树；候选就绪与响应头到达分别展示，不与主循环指标相加。
- 当前 Host 状态与交还控制权按钮。仅允许最新 run、在线 `status.runId` 与所选周期 `status.epoch` 都匹配；通过 Unix socket 发送 `runId` 与 `expectedEpoch`，由 Host 原子校验。历史 run 或历史周期不发控制命令。看板不会启动 AI 接管。

运行目录、观测路径都检查真实路径，只读取已索引工作区的 logs 和原运行目录；HTTP API 限本地主机，控制请求要求同源。不是联网多用户服务。

统计口径：请求数、耗时和缓存仅覆盖主循环，不包含 OMP 独立压缩请求。压缩通过 start/end 事件显示开始时间与实时等待时长；成功结束的原生 usage 和独立 compaction_http 请求、响应头等待与错误在事件面板单列，HTTP 响应头返回不代表压缩完成，HTTP 序号不推断逻辑重试关系。完成请求排除 `error` / `aborted`；实际动作统计成功 `execution`；缓存分母是 input + cacheRead + cacheWrite；“首请求后”仅排除本次运行首个完成请求，**不排除中途压缩后的冷缓存**。响应头等待包含各次尝试的等待（新日志优先使用 fetchToHeadersMs），无法独立区分上传、网络与服务端处理。预算导致的正常中止展示于事件面板，但不计为错误。

HTTP 等待使用响应头时间；WS 等待使用发送到首个入站事件的 `afterDispatchMs`，缺失保持未知，不用包含请求构建的 `firstStreamMs` 代替。概况分别统计完成请求的两种等待中位数，图表和详情使用同一口径。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

测试使用小型合成事件和临时目录，覆盖运行汇总、空和未完成日志、目录越界、历史 Host 控制隔离、同源检查、IPC 字段和跨环境发现、同 Host 双 epoch 计时 / 晚到事件隔离、旧周期停止请求拒绝、并发调用链和活动详情定位。无需本机历史日志，也不读取或修改 AI 沉淀的 skill。
