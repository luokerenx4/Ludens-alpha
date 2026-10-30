# OMP Background Compaction Rework

For plain question-and-answer coding, OMP's native context compaction works fine. Once we ran OMP inside a **spatiotemporally consistent real-time environment**, however, its default optimistic compaction policy started falling back to synchronous blocking almost immediately.

This note covers what happened and why we adjusted OMP's compaction structure under [rsa/patches/](../../rsa/patches/) (the Agent Loop itself is untouched; see [Architecture & Boundaries](../reference/architecture.md) for the boundary). Patches track OMP releases (currently `18.14.0`): upstream additions make our duplicated parts redundant while behavioral forks are kept and replayed.

## How stock OMP thinks about it

Because the agent's inference main loop is a **serial structure**, stopping mid-conversation for a synchronous long-context summarization freezes the loop. To avoid blocking the main loop, OMP uses a two-phase "background optimistic preparation + foreground splice at the threshold" design (speculative compaction):

1. **Prepare in the background**: when context nears the compaction threshold (entering a prediction band ~12.5% below the threshold, 8k–32k tokens), a background request sends a snapshot of the current history to the model to compute a summary. Once computed it is stored in the `armed` state; the foreground main loop keeps running without interruption.
2. **Swap at the threshold**: when the main loop's context reaches the threshold, a synchronous check runs on the critical path — if a computed `armed` summary is on hand and validates, it splices "summary of everything before the snapshot + new tail messages accumulated after the snapshot" and switches immediately; if not, it aborts the in-flight work and falls back to a foreground synchronous `compact()`, waiting for the summary to return.

Sounds reasonable, right? The catch is that **OMP is far too aggressive about when to discard a prepared background summary.**

Upstream has a **refresh-on-growth** rule: counting from the moment background summarization starts, if the foreground main loop's context grows by more than `max(keepRecentTokens, 8192)` (just **20k tokens** by default), it marks the snapshot stale, discards the already-computed `armed` summary, and recomputes from scratch. And if the threshold is hit while the background summary is still in flight (`pendingSpec`), it aborts the background request and falls back to synchronous foreground recomputation.

## Why refresh-on-growth breaks in a continuous environment

In short coding sessions, 20k tokens of headroom may be plenty. But in our setting the outside world is **spatiotemporally consistent and never stops moving** — for example, a real-time workspace running continuous perception at 30 Hz while the model keeps acting and observing, accumulating screenshots and tool records. The 30 Hz here is the sampling rate, not the inference or context-update rate: auto-injection only reads the latest records at prompt start, deduplicated by record ID; explicit `observe` only delivers selected records, never stuffing every sampled frame into model history.

Here is a real measurement from a continuous run (run `2026-10-27T17-22-02.413Z`, explicitly using a `256000` threshold, 4 compaction cycles). The current default threshold still follows the selected model's native OMP setting (`contextWindow - reserve`):

| Observed fact | Value | Source |
| --- | --- | --- |
| How long one long-context summarization takes the model | **70–93 s** | `armed durationMs` of `compaction_speculation` |
| Time from `armed` ready to actually hitting the threshold | **3.9–6.0 min** | Event timestamp deltas |
| Foreground context growth over those minutes | **27.9k–35.9k tokens** | `model_end` usage (`input + cacheRead + cacheWrite`) |
| Median per-round inference growth | **~210 tokens** | Same as above |

Look at that **27.9k–35.9k tokens**: across all four measured cycles, foreground context **grew past the 20k limit** in the four to six minutes between the background summary becoming ready and the main loop reaching the threshold.

By the upstream rule, these candidates cannot survive to the threshold: once foreground growth exceeds 20k they are invalidated and recomputed. If the replacement candidate is still `pendingSpec` at the line, upstream aborts it and falls back to synchronous foreground recomputation. Whether that path is actually taken depends on recompute timing and latency; this data set does not directly measure foreground blocking counts on the unpatched version.

And remember, **OMP's main loop is a serial structure**. Once it falls back to foreground synchronous compaction, new model decisions and tool calls wait for the summary to return. The measured 70–93 s background summarization latency implies recomputation can open a noticeable decision gap — though it is not a direct measurement of foreground stall; independent background Action processes and ordinary programs keep running.

## How we changed the compaction structure

Once the root cause was clear, the fix was straightforward — **keep a slightly longer post-compaction tail rather than discarding an already-computed (or nearly computed) background result**:

### 1. Remove `refresh-on-growth` (stop discarding for normal growth)

In `pi-coding-agent` (`session-maintenance.ts` / `speculation-lead.ts`), we removed the "invalidate the candidate because context grew past the limit" condition. As long as the session branch is unchanged and there is still enough post-compaction context headroom, the `armed` summary stays valid. Even if the foreground accumulates another 30k of new messages after the snapshot, commit replays the entire post-snapshot tail verbatim after the summary — no history lost, instant switch.

### 2. If the background is still computing at the threshold (`pendingSpec`), wait for it instead of restarting

If the background candidate is still in flight when the threshold is reached, it has likely been running for fifty or sixty seconds and is about to finish. Aborting it to open a fresh foreground request only wastes that work. We now wait out the in-flight background request with `untilAborted` and validate + splice; the wait is bound to the control cycle's cancellation signal, so budget expiry or human handoff still interrupts cleanly and never commits late.

### 3. Isolate the background compaction request from the foreground WebSocket connection

If background summarization shares the session channel the foreground is using, it can disrupt the foreground WebSocket sticky session. So background compaction requests use an independent `sessionId: "<id>:spec:<snowflake>"`, inherit server-side prompt-cache affinity via a new `parentSessionId` plumbed through `pi-agent-core` / `pi-ai`, and are forced onto HTTP (`preferWebsockets: false`) so foreground and background stay isolated.

### 4. Bind a unique `operationId` to every background candidate

Previously, why a background compaction terminated and how long it took were hard to correlate in the logs. We added `diagnostics_channel("omp.compaction.speculation")`, binding a unique `operationId` from candidate creation and logging the full lifecycle and latency of `started / armed / failed / cancelled / applied / invalidated` (see [trace.ts](../../rsa/src/harness/omp/trace.ts) and the [logging contract](../reference/logging.md#shiori-compaction-and-transport)).

## Cost and verification

The trade-off is clear: **because we reuse a minutes-old snapshot summary, messages added after the snapshot stay verbatim in the post-compaction history tail**, so context right after compaction is slightly larger than a freshly computed summary. When a valid candidate is ready, re-requesting a summary is avoided; when the candidate is still in flight or fails validation, waiting can still occur. Branch changes, insufficient projection headroom, config changes, and cancellation still invalidate candidates. If some future non-real-time scenario allows pausing the environment during compaction, this trade-off can be revisited.

To keep future upgrades from breaking this behavior, two checks guard it:

- **Integration test**: [rsa/tests/omp-speculation.test.ts](../../rsa/tests/omp-speculation.test.ts) runs the real OMP preparation / validation / commit / tail replay, verifying survival past 20k growth, waiting for in-flight candidates at the threshold, invalidation on branch or headroom failures, and clean cancellation without late commits.
- **Built-in benchmark**: `rsa bench run ludens/background-compaction` (see [Benchmark](../reference/benchmark.md)), which replays the full background-compaction lifecycle offline with controlled streams.
