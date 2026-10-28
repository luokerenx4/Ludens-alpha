# WS 恢复测试依据

OMP 专项测试从公开 provider API 和 Agent 入口调用固定依赖，测试与 fixture 留在本仓库，不放进 OMP 源码或补丁。更换 Shiori 时单独评估这些契约，不将 OMP 实现细节变成通用接口。

## Codex WS 恢复专项 · 2026-10-20

**这是架构施工期的 TDD 特例，不是全项目规则。** 长运行暴露相邻故障分支遗漏，因此先构造外部工况、确认旧实现失败，再修恢复策略。架构改变时重新判断用例价值，不为测试保留旧架构。

入口：[omp-websocket.test.ts](../../rsa/tests/omp-websocket.test.ts)。从仓库根运行：

```sh
(cd rsa && bun run test:transport)
(cd rsa && bun run check)
# 带标准事件和检查证据的两个真实故障族，可由现有看板读取：
rsa/bin/rsa --workspace /absolute/path/to/workspace bench run ludens/ws-recovery
```

## 构建依据

- **R1：** 2026-10-18 Besiege 六小时运行，空 thinking 后收到 `websocket_connection_limit_reached`。先前补丁已覆盖到期恢复。
- **R2：** 马造八小时运行 `2026-10-19T13-19-53.903Z`。北京时间 23:19:59 到期、23:21 恢复 WS；23:46:56 收到 `websocket closed (1012)` 后约 5.5 小时保持 SSE。缺口是关闭恢复分类，不能据此确定服务端或网络故障来源。
- **R3：** `2026-10-20T14-57-50.713Z` 在 UTC 15:57:52 到期，`custom_tool_call_input.delta` 尚未完成。额外的“可见输出后禁重放”拦截比 OMP 更严，导致 Agent 提前结束。现删除拦截，复用 `canSafelyReplayWebsocketOverSse`：完整工具交付后不重放，未完成参数、text/thinking 允许原生恢复。
- **S：** 其余关闭码、握手、交付、尺寸和取消是合成邻近工况，不声称曾在 R2 发生。码名参考 [IANA](https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number)，恢复策略是项目选择，非协议要求。

## 环境与观测范围

Bun 1.4、打补丁的 `@oh-my-pi/pi-ai@18.9.1` 调用真实 `streamOpenAICodexResponses`，每例独立 session；R3 另经 `pi-agent-core` 公开 `Agent.prompt` 真正执行工具回调并提交结果。进程内 fixture 替换 WS/HTTP，使用合成 token，不读本机登录、不连模型或模拟器。

`Date.now` 虚拟推进 60 秒冷却，握手 watchdog 为 0ms、首事件 watchdog 为 1ms，backoff 用受控 scheduler。检查请求次数、状态、交付和序列化正文，耗时不代表真实性能。全局传输替身要求顺序运行，finally 恢复环境并关闭会话。

## 工况矩阵

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

## 红绿记录与边界

2026-10-20 扩展专项由 **19 通过 / 18 失败** 到 **37 通过 / 515 断言**。其中 text/thinking 输出后必须报错的预期过严，R3 后纠正；旧通过数不证明策略合理。连接分类、冷却、尺寸、取消、空 thinking 块闭合回归仍保留。

2026-10-21 先加 R3 Agent 回归：旧实现工具回调 **0 次，期望 1 次**。恢复原生边界后验证同一 prompt 内恢复、执行一次并提交结果，以及冷却后全历史 WS → delta。text/thinking 改为原生恢复预期，完整工具不重放检查保留；最新通过数以命令为准。

测试只证明受控行为，不证明线上永不掉线或实际重连耗时；长跑、调度、吞吐仍看日志。该次 WS 修复未调整当时的 256k 阈值、模型或游戏策略。

看板基准 [ws-recovery.ts](../../rsa/src/benchmark/cases/ws-recovery.ts) 复现两类实际事件，在 `benchmark_fault` 标明来源与模拟条件；完整矩阵留在外部测试。升级 OMP 时先跑专项再跑基准，不复制测试进依赖。
