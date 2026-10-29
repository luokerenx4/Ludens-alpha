# OMP 后台压缩改造

RSA 锁定 OMP 18.9.1，上下文压缩复用其原生实现。触发阈值默认跟随所选模型的原生 OMP 设置（`contextWindow − reserve`），可经 `rsa.json` 或 `--compaction-threshold` 显式覆盖；本文实测数据来自显式 `256000` 阈值的历史运行。本篇记录我们对 OMP 预测式后台压缩（speculative compaction）做了什么、为什么改、改动的行为边界与验收方式。改动全部位于 [rsa/patches/](../../rsa/patches/) 下的依赖补丁中，由 Bun 按 `rsa/package.json` 的 `patchedDependencies` 配置自动应用；Agent Loop 本体未替换，见 [架构与边界](../reference/architecture.md)。

## OMP 原生逻辑

原生压缩采用两段式机制：平时后台预备，到达阈值时前台执行。

1. **后台预备（Speculation）**：当上下文进入预测带（距阈值约 12.5%，8k–32k tokens）时，启动一个后台请求，将当前历史快照发送给模型生成摘要；生成完毕后存为 `armed` 候选，主循环无感继续推进。
2. **前台执行（Auto Compaction）**：当上下文到达触发阈值时，在主循环关键路径上同步检查——若存在 `armed` 摘要且校验通过，则直接拼接（快照前使用摘要，快照后的尾部消息完整重放）并瞬时完成；否则作废在途后台任务，同步调用 `compact()` 发起摘要请求并 `await`，主循环阻塞直至摘要返回。

上游对 `armed` 摘要的作废条件之一是 **refresh-on-growth**：从候选快照起点累计的上下文增长一旦超过 `max(keepRecentTokens, 8192)`（默认预算 20k tokens），即判定快照过旧并作废重算。

## 为什么要改

该次测量的工作区运行在 30Hz 常驻感知加每步截图的实时控制循环下。实测数据（马造运行 `2026-10-27T17-22-02.413Z`，共 4 个压缩周期）：

| 测量维度 | 实测数值 | 数据来源 |
| --- | --- | --- |
| 单次摘要请求耗时 | 70–93 s | `compaction_speculation` armed `durationMs` |
| `armed` 就绪 → 到达阈值应用间隔 | 3.9–6.0 min | 事件时间戳差值 |
| 该时间窗内的历史上下文增长 | 27.9k–35.9k tokens | `model_end` usage（`input + cacheRead + cacheWrite`） |
| 单轮推理中位增长 | ~210 tokens | 同上 |

这组测量揭示的两个核心矛盾：

- **增长必然超出刷新预算**：4 个周期在 `armed` 就绪后的上下文增长（27.9k–35.9k）全部超过上游 20k 的 `refresh-on-growth` 预算。按上游规则推断，这些后台候选无法保留到阈值时刻（实际是否落入前台同步阻塞还取决于重算时机与耗时；该组记录未直接测量未打补丁版本的阻塞次数）。
- **前台阻塞中断 OMP 实时决策**：一旦落入前台同步摘要请求，70–93 秒的等待会直接暂停新的模型推理与工具调用，使依赖模型决策控制设备的场景出现长时间响应空档（独立 Action worker 与后台程序虽可继续输入，但模型恢复后消费的观测是否过期需从实际交付与动作事件核对）。

`pendingSpec` 存在同类问题：当上下文到达阈值而后台候选仍在途时，上游会直接 `abort` 在途后台请求并改由前台从头重算，白白丢弃已进行的后台计算。

## 改动内容

### 1. `pi-coding-agent`（`session-maintenance.ts` / `speculation-lead.ts`）

- **移除 `refresh-on-growth` 作废条件**：`armed` 摘要只要通过其余保留校验（会话分支未变、压缩后投影余量充足）即予以保留；提交时完整重放快照之后的全部尾部消息，历史不丢失。所有作废路径统一收口至 `cancelSpeculation(reason, contextTokens)`，记录明确原因与上下文规模。
- **在途 `pendingSpec` 等待复用**：当阈值触发且后台远程候选仍在途时，通过 `untilAborted` 等待其完成并校验拼接，不再 `abort` 重算。等待过程与前台 auto compaction 取消信号联动，预算耗尽或人工交还时可立即打断，绝不晚提交。
- **候选全生命周期身份与可观测性**：通过 `diagnostics_channel("omp.compaction.speculation")` 绑定唯一 `operationId`，输出 `started / armed / failed / cancelled / applied / invalidated` 全生命周期结构化事件（含耗时、`snapshotLeafId`、`contextTokensAtStart`）。宿主侧 [trace.ts](../../rsa/src/harness/omp/trace.ts) 订阅该通道写入 `compaction_speculation` 事件，内部 HTTP 子 Span 与重试均沿用该候选身份。
- **后台候选会话隔离**：后台压缩请求使用独立 `sessionId: "<id>:spec:<snowflake>"` 并附带新增的 `parentSessionId` 以保持服务端 Prompt Cache 亲和性，同时强制 `preferWebsockets: false`，避免与前台活跃轮次的 WebSocket sticky session 交错。

### 2. `pi-agent-core` / `pi-ai`（参数透传）

将 `parentSessionId` 从 `SummaryOptions` 透传至 `compact()` 与 V2 streaming request，仅做字段传递，不引入额外行为逻辑。

## 行为边界

- **调度策略不变**：触发阈值默认跟随所选模型的原生 OMP 设置（历史测试运行曾显式配置 `256000`），预测带计算、方法选择与投影余量校验原样保留。
- **复用“较早快照”的代价**：快照点之后新增的消息会作为保留尾部原样带入压缩后的新历史，使压缩后保留尾部的 token 数略高于从头重算，以此换取在候选就绪时零阻塞切换；若到达阈值时候选仍在途或校验失败，仍需等待完成或回退。
- **必要作废依然保留**：会话分支变更、压缩后投影余量不足、配置更改或主动取消，仍按上游语义正常作废候选，仅不再单纯因上下文增长而作废。
- **适用场景前提**：本改造针对高频感知下的实时控制循环；若业务场景允许在压缩期间安全暂停设备，此项改造的收益下降，可按需重新权衡。

## 验收

- **单元与集成测试**：[rsa/tests/omp-speculation.test.ts](../../rsa/tests/omp-speculation.test.ts) 调用真实 OMP preparation / validation / commit / 尾部重放，覆盖阈值等待、`armed` 后增长存活、分支/余量失效刷新、后台失败回退、预算取消打断等待且不晚提交，以及 `operationId` 上下文贯穿前后台。
- **内置 Benchmark**：`rsa bench run ludens/background-compaction`（见 [Benchmark](../reference/benchmark.md)），离线验证只提交一次、尾部消息完整、HTTP 子链归属明确且取消后不晚提交。
- **运行日志核查**：`compaction_speculation` 事件按 `operationId` 全链路串联，可通过 Dashboard 与 `analyze-run.py` 核对候选归属（见 [日志与调用链](../reference/logging.md#shiori-压缩与传输)）。
