# Insights · 为什么这么做

本目录归档关键架构改造与工程专项的决策背景、实测数据、取舍依据与适用边界。遵循**只追加、不篡改历史判断**的原则：当后续架构演进时，通过新增篇目或明确标注现行契约链接演进，保留当时的真实测量与推理链条。

## 专项记录一览

| 专项名称 | 记录时间 / 基准 | 解决的核心问题 | 关联现行契约 |
| --- | --- | --- | --- |
| [**OMP 后台压缩改造**](omp-compaction.md) | 2026-10-27 · 马造 30Hz 实时控制循环 | 移除 `refresh-on-growth` 作废条件并等待在途 `pendingSpec`，避免后台压缩候选因高频观测增长而作废重算、阻塞前台控制循环 | [架构与边界](../reference/architecture.md#会话与-loop) · [日志与调用链](../reference/logging.md#shiori-压缩与传输) |
| [**注入收敛为纯感知通道**](omp-injection.md) | 2026-10-28 · `f5431b6` | 剥离控制状态与技能/记忆索引的逐轮自动推送，仅保留新感知记录与采样器状态变迁（`state/codeSHA/error`），并修复被抑制交付吞掉状态游标的 bug | [Workspace 感知注入](../tutorials/workspace.md#常驻感知与历史读取) · [感知与模型真实输入](../reference/logging.md#感知与模型真实输入) |
| [**WS 恢复测试依据**](ws-recovery.md) | 2026-10-20 ~ 10-21 · R1/R2/R3 长跑复盘 | 针对 Codex WebSocket 连接到期、`1012` 中途关闭与未完成工具调用（`custom_tool_call_input.delta`）构建 13 类故障注入矩阵与原生 SSE 恢复边界 | [Benchmark 内置任务](../reference/benchmark.md#内置任务与证据边界) |
