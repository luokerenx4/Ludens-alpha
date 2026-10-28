# OMP 后台压缩改造

RSA 锁定 OMP 18.9.1,压缩复用其原生实现。触发阈值默认跟随所选模型的原生 OMP 设置(`contextWindow − reserve`),可经 `rsa.json`/`--compaction-threshold` 显式覆盖;本文实测数据来自显式 256000 阈值的历史 run。本篇记录我们对 OMP 压缩(speculative compaction)做了什么、为什么改、改动的行为边界与验收方式。改动全部在 [rsa/patches/](../rsa/patches/) 下的依赖补丁中,由 Bun 按 `rsa/package.json` 的 `patchedDependencies` 配置应用;agent loop 本体未替换,见 [架构边界](architecture.md)。

## OMP 原生逻辑

两段式:平时后台预备,到期前台执行。

1. **后台预备**:上下文进入预测带(距阈值约 12.5%,8k–32k)时,起一个后台 run,把历史快照发给模型生成摘要。算好后存为 armed,loop 无感。
2. **前台执行**:上下文到达阈值时,在 loop 关键路径上同步检查:
   - 有 armed 摘要且校验通过 → 直接拼接(快照前用摘要,快照后的尾部消息完整重放),瞬时完成;
   - 否则 → 作废在途 run,`compact()` 同步发摘要请求并 await——loop 阻塞到摘要返回。

上游对 armed 摘要的作废条件之一是 refresh-on-growth:从候选快照开始累计的上下文增长超过 `max(keepRecentTokens, 8192)`(默认预算 20k)就判定快照过旧,作废重算。

## 为什么要改

该次测量的工作区使用 30Hz 感知加每步截图的实时控制循环。实测(马造 run `2026-10-27T17-22-02.413Z`,4 个压缩周期):

| 事实 | 数值 | 来源 |
| --- | --- | --- |
| 一次摘要请求耗时 | 70–93 s | `compaction_speculation` armed `durationMs` |
| armed → 阈值应用间隔 | 3.9–6.0 min | 事件时间差 |
| 该窗口内历史增长 | 27.9k–35.9k token | `model_end` usage(input+cacheRead+cacheWrite) |
| 单轮中位增长 | ~210 token | 同上 |

这些记录说明的影响:

- **增长超过刷新预算**:四个周期在 armed 后的增长已超过 20k,按上游规则推断,这些候选无法一直保留到阈值。实际是否落入前台阻塞还取决于重算时机与耗时;这组记录没有直接测量未打补丁版本的阻塞次数。
- **前台阻塞暂停 OMP 决策**:同步摘要请求会延迟新的模型决策与工具调用,依赖这些调用控制设备的场景会出现响应空档。独立 Action worker 与后台程序仍可继续输入;恢复后使用的观察是否过期,应从实际观察交付与动作事件核对。

`pendingSpec` 问题同类:阈值到达时若 remote 候选还在途,上游 abort 它再用前台请求重算,放弃已完成的后台工作并重新等待摘要。

## 改动内容

### pi-coding-agent(session-maintenance.ts / speculation-lead.ts)

- **删除 refresh-on-growth 作废条件**。armed 摘要只要通过保留的校验(分支未变、投影余量足够)就保留;提交时重放快照后完整尾部,历史不丢。作废统一走 `cancelSpeculation(reason, contextTokens)`,带原因和上下文规模。
- **pendingSpec 等待**。阈值触发且 remote 候选在途时,`untilAborted` 等待其完成再校验拼接,不再 abort 重算。等待与前台 auto compaction 信号联动,预算取消随时打断,不晚提交。
- **候选身份与可观测性**。`diagnostics_channel("omp.compaction.speculation")` 绑定 `operationId`;started / armed / failed / cancelled / applied / invalidated 全生命周期结构化日志,含耗时、`snapshotLeafId`、`contextTokensAtStart`。宿主侧 [trace.ts](../rsa/src/harness/omp/trace.ts) 订阅该 channel 记录 `compaction_speculation` 事件,HTTP 子 span 与重试沿用候选身份。
- **后台候选会话隔离**。compaction 请求用独立 `sessionId: "<id>:spec:<snowflake>"` 加新增 `parentSessionId` 保持 prompt-cache 亲和,强制 `preferWebsockets: false`,避免与活跃轮次的 sticky session 交错。

### pi-agent-core / pi-ai(管道)

`parentSessionId` 从 `SummaryOptions` 穿过 `compact()` 与 V2 streaming request,仅参数透传,无行为逻辑。

## 行为边界

- 调度不变:触发阈值默认跟随所选模型的原生 OMP 设置(历史 run 曾显式用 256000),预测带、方法选择、投影校验逻辑原样保留。
- 摘要"旧"的代价:快照后的新增消息原样带入新历史,增加保留尾部的 token 数,以复用已有摘要。有效候选已就绪时可避免重新请求摘要;候选仍在途或校验失败时仍可能等待。
- 作废仍然发生:分支变化、投影余量不足、配置变更、取消,都会按原语义作废,只是不再因增长作废。
- 适用前提是实时控制循环。若场景允许压缩时安全暂停设备,此改动价值下降,可重新权衡。

## 验收

- [rsa/tests/omp-speculation.test.ts](../rsa/tests/omp-speculation.test.ts):真实 OMP preparation/validation/commit/尾部重放,覆盖阈值等待、armed 后增长存活、分支/余量失效仍刷新、后台失败回退、预算取消可打断等待且不重发、不晚提交、operation 上下文贯穿前后台。
- [rsa bench run ludens/background-compaction](benchmark.md):离线 case,验证只提交一次、尾部完整、HTTP 子链明确、取消后不晚提交。
- 运行证据:`compaction_speculation` 事件按 `operationId` 贯穿,Dashboard 与 `analyze-run.py` 可核对候选归属;归属规则见 [日志](logging.md)。
