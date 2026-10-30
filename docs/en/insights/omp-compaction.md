# OMP Background Compaction Rework

For standard question-and-answer coding sessions, OMP's (`18.9.1`) native context compaction works well. In a **spatiotemporally consistent real-time environment**, however, its default speculative-compaction invalidation policy frequently falls back to synchronous blocking.

This note explains the root cause and the adjustments made to OMP's compaction flow under [rsa/patches/](../../rsa/patches/) (the Agent Loop itself is unchanged; see [Architecture & Boundaries](../reference/architecture.md)).

## Stock OMP speculative compaction

Because the agent's inference main loop is **serial**, pausing mid-session for synchronous long-context summarization blocks the loop. To avoid this, OMP uses a two-phase speculative compaction design:

1. **Asynchronous background preparation**: when context approaches the compaction threshold (entering a prediction band ~12.5% below the threshold, 8k–32k tokens), a background request computes a summary from a snapshot of the current history. Once ready, it is stored in the `armed` state while the foreground main loop continues running.
2. **Synchronous switch at the threshold**: when the main loop's context reaches the threshold, a synchronous check runs on the critical path — if a valid `armed` summary is available, it splices the pre-snapshot summary with the post-snapshot tail messages and switches immediately; otherwise it aborts in-flight work and falls back to synchronous foreground `compact()`, waiting for the summary to return.

The issue lies in **how aggressively OMP invalidates a prepared background summary.**

Upstream enforces a **refresh-on-growth** rule: starting from when background summarization begins, if the foreground main loop's context grows by more than `max(keepRecentTokens, 8192)` (**20k tokens** by default), the snapshot is marked stale, the `armed` summary is discarded, and summarization restarts. And if the threshold is reached while the background summary is still in flight (`pendingSpec`), upstream aborts the background request and falls back to synchronous foreground recomputation.

## Why refresh-on-growth fails in continuous environments

In short coding sessions, 20k tokens of headroom may be plenty. But in our setting the outside world is **spatiotemporally consistent and continuously evolving** — for example, a real-time workspace running continuous perception at 30 Hz while the model keeps acting and observing, accumulating screenshots and tool records. The 30 Hz here is the sampling rate, not the inference or context-update rate: auto-injection only reads the latest records at prompt start, deduplicated by record ID; explicit `observe` only delivers selected records, never stuffing every sampled frame into model history.

Below is a real measurement from a continuous run (`2026-10-27T17-22-02.413Z`, explicitly using a `256000` threshold, 4 compaction cycles). The current default threshold still follows the selected model's native OMP setting (`contextWindow - reserve`):

| Observed fact | Value | Source |
| --- | --- | --- |
| How long one long-context summarization takes the model | **70–93 s** | `armed durationMs` of `compaction_speculation` |
| Time from `armed` ready to actually hitting the threshold | **3.9–6.0 min** | Event timestamp deltas |
| Foreground context growth over those minutes | **27.9k–35.9k tokens** | `model_end` usage (`input + cacheRead + cacheWrite`) |
| Median per-round inference growth | **~210 tokens** | Same as above |

Across all four measured cycles, foreground context growth (**27.9k–35.9k tokens**) **exceeded the 20k invalidation limit** during the four to six minutes between background summary readiness and reaching the threshold.

Under the upstream rule, these candidates cannot survive to the threshold: once foreground growth exceeds 20k they are invalidated and recomputed. If the replacement candidate is still `pendingSpec` at the threshold, upstream aborts it and falls back to synchronous foreground recomputation. Whether that path is taken depends on recompute timing and latency; this dataset does not directly measure foreground blocking counts on the unpatched version.

Because **OMP's main loop is serial**, falling back to foreground synchronous compaction blocks new model decisions and tool calls until the summary returns. The measured 70–93 s background summarization latency indicates that recomputation can introduce a noticeable decision gap — though it is not a direct measurement of foreground stall; independent background Action processes and ordinary programs continue running.

## Compaction structure changes

To address this, the core policy is: **retain a slightly longer post-compaction message tail rather than discarding a completed or nearly completed background summary**:

### 1. Remove `refresh-on-growth` (do not invalidate on normal growth)

In `pi-coding-agent` (`session-maintenance.ts` / `speculation-lead.ts`), we removed the condition that invalidates candidates when context growth exceeds the limit. As long as the session branch is unchanged and sufficient post-compaction headroom remains, the `armed` summary stays valid. Even if the foreground accumulates another 30k tokens of messages after the snapshot, commit replays the entire post-snapshot tail verbatim after the summary without losing history.

### 2. If the background is still computing at the line (`pendingSpec`), wait for it instead of restarting

If the background candidate is still in flight when the threshold is reached, it has likely been running for fifty or sixty seconds and is about to finish. Aborting it to open a fresh foreground request wastes that work. We now wait out the in-flight background request with `untilAborted` and validate + splice; the wait is bound to the control cycle's cancellation signal, so budget expiry or human handoff still interrupts cleanly and never commits late.

### 3. Isolate the background compaction request from the foreground WebSocket connection

If background summarization grabs the session channel the foreground is using, it can disrupt the foreground WebSocket sticky session. So background compaction requests use an independent `sessionId: "<id>:spec:<snowflake>"`, inherit the server-side prompt-cache affinity via a new `parentSessionId` plumbed through `pi-agent-core` / `pi-ai`, and are forced onto HTTP (`preferWebsockets: false`) so foreground and background stay isolated.

### 4. Assign every background candidate an `operationId`

Previously, why a background compaction terminated and how long it took were not correlated in the logs. We added `diagnostics_channel("omp.compaction.speculation")`, binding a unique `operationId` from candidate creation and logging the full lifecycle and latency of `started / armed / failed / cancelled / applied / invalidated` (see [trace.ts](../../rsa/src/harness/omp/trace.ts) and the [logging contract](../reference/logging.md#shiori-compaction-and-transport)).

## Cost and verification

The trade-off is straightforward: **because a snapshot summary from several minutes earlier is reused, messages added after the snapshot remain verbatim in the post-compaction history tail**, making context immediately after compaction slightly larger than a freshly computed summary. When a valid candidate is ready, re-requesting a summary is avoided; when the candidate is still in flight or fails validation, waiting can still occur. Branch changes, insufficient projection headroom, config changes, and cancellation still invalidate candidates. If a future non-real-time scenario allows pausing the environment during compaction, this trade-off can be revisited.

Two regression checks guard this behavior across upgrades:

- **Integration test**: [rsa/tests/omp-speculation.test.ts](../../rsa/tests/omp-speculation.test.ts) runs the real OMP preparation / validation / commit / tail replay, verifying survival past 20k growth, waiting for in-flight candidates at the threshold, invalidation on branch or headroom failures, and clean cancellation without late commits.
- **Built-in benchmark**: `rsa bench run ludens/background-compaction` (see [Benchmark](../reference/benchmark.md)), which replays the full background-compaction lifecycle offline with controlled streams.
