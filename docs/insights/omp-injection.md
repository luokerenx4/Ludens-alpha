# 注入收敛为纯感知通道

`captureContext` 曾向每个 prompt 追加三样东西：控制状态 JSON、感知内容、技能/记忆索引。2026-10-28 起只剩感知：新样本 + 采样器状态变迁（`state/codeSHA/error`）。控制状态、技能与记忆索引改由模型按需经工具查询。

## 为什么删控制推送

控制 JSON（`runId/pid/codeSHA/diagnostics` 等运维元数据）对模型零行动价值：它不会因为看到 pid 就换策略。留着只涨 token，还让模型误以为这些字段是行动依据。运维元数据仍在日志与 `rsa status`，需要的人自己查。

## 为什么删技能/记忆索引推送

技能和记忆索引曾在首次完整交付、随后追加变化。但索引不是证据：模型要的是内容，不是版本号。改成按需经工具读取后，prompt 里不再有"索引变了但内容没用"的噪音。`observation_context` 收据的 `skillVersion/memoryVersion` 字段同步移除；`consolidation` 不再产生注入收据。

## 感知状态变迁必须推：静默不能有歧义

收敛后只剩一个主动通道，静默就有了两种解读："没有新帧"还是"采样器死了"。所以采样器状态变迁（`state/codeSHA/error`）必须推：`codeSHA` 变了说明代码被 reload，`error` 带出修复相关的失败原因，`state` 告诉模型采样器是不是活着。修了此前一个循环依赖：旧代码用完整 `PerceptionStatus` 做版本比较，`state` 计算又依赖注入结果。

## 收敛暴露的 bug：被压制的交付不能丢状态

收敛实现里用 `lastPerceptionState` 去重：状态没变就不推。但 `captureContext` 有 early return（consolidate、显式 observe、在途图片已覆盖），直接 return 会跳过 `lastPerceptionState = stateVersion` 的更新——而那次的状态文本根本没发出（被压制或取消）。下一次状态再变时，比较基准是错的，变迁通知永久丢失。

修法（`f5431b6`）：把更新语句搬进"决定推送"的分支内：只要走到了推送判断，无论内容是否为空、是否被压制，基准都更新到当前。被压制或取消的交付留下"已见"标记，不重发旧状态。

## 现行契约

自动交付只有感知增量：新记录 + 采样器 `state/codeSHA/error` 变化。控制状态、技能与记忆索引不自动推送。细节见 [日志](../reference/logging.md)。
