# RSA 观察台

独立的本地 Next.js 工程。读取 `<workspace>/logs/<run>` 的真实 `manifest.json`、`events.jsonl` 和保存的观测。通过 `../../artifacts/rsa/<workspace-id>/workspace.json` 中的路径发现工作区，仓库外的工作区也可显示；原有 `../../artifacts/rsa/<project>/runs/<run>` 仍可回放，不搬迁历史日志。只监听 `127.0.0.1:3015`，无需模型密钥，不发送模型请求。

所有相对路径以本组件目录为基准：`../../artifacts` 是与 monorepo 根目录并列的本地运行数据目录，故意放在 Git 仓库外。首次启动还没有日志时显示空列表。

```sh
cd rsa-dashboard
npm ci
npm run dev
```

打开 http://127.0.0.1:3015 。生产运行使用 `npm run build && npm start`。

- 环境项目、运行、接管周期选择；默认跟随最新 epoch，每 2.5 秒刷新，手动选中请求后保持回放位置。统计与回放严格按 `trace.epoch` 隔离，晚到清理保留在原周期；无 epoch 不推断归属。
- 请求耗时 / 响应头等待、缓存命中率、实际 HTTP 请求体曲线；点击图表或请求时间轴联动动作与前后观测。
- 观测来源、动作完成到采样请求间隔、源帧变化、采样与编码耗时。工具卡单列命令执行（exec → exec_result）与工具全程（tool_start → tool_end，含后续观测），按 epoch/modelCallId/toolCallId 关联；两者为包含关系，不相加，未完成显示未知。
- skill 的 read / write / edit 工具证据，成功状态和可用的读取哈希；错误、正常中止、OMP 压缩事件。
- 当前 Host 状态与交还控制权按钮。仅允许最新 run、在线 `status.runId` 与所选周期 `status.epoch` 都匹配；通过 Unix socket 发送 `runId` 与 `expectedEpoch`，由 Host 原子校验。历史 run 或历史周期不发控制命令。看板不会启动 AI 接管。

运行目录、观测路径都检查真实路径，只读取已索引工作区的 logs 和原运行目录；HTTP API 限本地主机，控制请求要求同源。不是联网多用户服务。

统计口径：请求数、耗时和缓存仅覆盖主循环，不包含 OMP 独立压缩请求。压缩通过 start/end 事件显示开始时间与实时等待时长；成功结束的原生 usage 和独立 compaction_http 请求、响应头等待与错误在事件面板单列，HTTP 响应头返回不代表压缩完成，HTTP 序号不推断逻辑重试关系。完成请求排除 `error` / `aborted`；实际动作统计成功 `execution`；缓存分母是 input + cacheRead + cacheWrite；“首请求后”仅排除本次运行首个完成请求，**不排除中途压缩后的冷缓存**。响应头等待包含各次尝试的等待（新日志优先使用 fetchToHeadersMs），无法独立区分上传、网络与服务端处理。预算导致的正常中止展示于事件面板，但不计为错误。

```sh
npm run typecheck
npm test
npm run build
```

测试使用小型合成事件和临时目录，覆盖运行汇总、空和未完成日志、目录越界、历史 Host 控制隔离、同源检查、IPC 字段和跨环境发现、同 Host 双 epoch 计时/晚到事件隔离与旧周期停止请求拒绝。无需本机历史日志，也不读取或修改 AI 沉淀的 skill。
