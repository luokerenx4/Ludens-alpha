# OMP Background Compaction Rework

For plain question-and-answer coding, OMP's (`18.9.1`) native context compaction works fine. But the moment we dropped OMP into a **spatiotemporally consistent real-time game environment**, its optimistic compaction mechanism broke almost immediately.

This note covers what actually happened, and why we operated on OMP's compaction structure under [rsa/patches/](../../rsa/patches/) (the Agent Loop itself is untouched; see [Architecture & Boundaries](../reference/architecture.md) for the boundary).

## How stock OMP thinks about it

Because the agent's inference main loop is a **serial structure**, stopping mid-conversation for a synchronous long-context summarization would freeze the whole loop. To avoid blocking the main loop, OMP uses a two-phase "background optimistic preparation + foreground splice at the deadline" design (speculative compaction):

1. **Prepare quietly in the background**: when context nears the compaction threshold (entering a prediction band of ~12.5% below the threshold, 8k–32k tokens), a background request sends a snapshot of the current history to the model to compute a summary. Once computed it is stored in the `armed` state; the foreground main loop notices nothing and keeps running.
2. **Swap in one shot at the line**: when the main loop's context actually hits the threshold, a synchronous check runs on the critical path — if a computed `armed` summary is on hand and validates, it splices "summary of everything before the snapshot + new tail messages accumulated after the snapshot" and switches instantly; if not, it kills the in-flight work and falls back to a foreground synchronous `compact()`, stalling the main loop while the summary comes back.

Sounds reasonable, right? The problem: **OMP is far too aggressive about when to throw away a computed background summary.**

Upstream has a **refresh-on-growth** rule: counting from the moment background summarization starts, if the foreground main loop's context grows by more than `max(keepRecentTokens, 8192)` (just **20k tokens** by default), it declares the snapshot "too stale", discards the already-computed `armed` summary, and recomputes from scratch! And if the threshold is hit while the background summary is still in flight (`pendingSpec`), it `abort`s the background request without mercy and falls back to synchronous foreground recomputation.

## Dropped into a spatiotemporally consistent environment, disaster follows

In short coding sessions, 20k tokens of headroom may be plenty. But in our setting the outside world is **spatiotemporally consistent and never stops flowing** — e.g. the 马造 workspace runs continuous perception at 30 Hz while the model keeps acting and observing, accumulating screenshots and tool records. The 30 Hz here is the sampling rate, not the inference or context-update rate: auto-injection only reads the latest records at prompt start and at tool-batch end, deduplicated by record ID; explicit `observe` only delivers selected records, never stuffing every sampled frame into model history.

We pulled one real measurement from an actual 马造 run (run `2026-10-27T17-22-02.413Z`, explicitly using a `256000` threshold, 4 compaction cycles) and did the math. The current default threshold still follows the selected model's native OMP setting (`contextWindow - reserve`):

| Observed fact | Value | Source |
| --- | --- | --- |
| How long one long-context summarization takes the model | **70–93 s** | `armed durationMs` of `compaction_speculation` |
| Time from `armed` ready to actually hitting the threshold | **3.9–6.0 min** | Event timestamp deltas |
| Foreground context growth over those minutes | **27.9k–35.9k tokens** | `model_end` usage (`input + cacheRead + cacheWrite`) |
| Median per-round inference growth | **~210 tokens** | Same as above |

See that **27.9k–35.9k tokens**?

In other words, across these four measured cycles, foreground context **grew past the 20k tolerance** in the four or five minutes between the background summary becoming ready and the main loop hitting the line.

By the upstream rule, these candidates cannot survive to the threshold: once foreground growth exceeds 20k they are invalidated and recomputed. If the replacement candidate is still `pendingSpec` at the line, upstream `abort`s it and falls back to synchronous foreground recomputation. Whether that path is actually taken depends on recompute timing and latency; this data set does not directly measure foreground blocking counts on the unpatched version.

And remember, **OMP's main loop is a serial structure**. Once it falls back to foreground synchronous compaction, new model decisions and tool calls wait for the summary to return. The measured 70–93 s background summarization latency implies recomputation can open a noticeable decision gap — though it is not a direct measurement of foreground stall; the background standalone Action processes and ordinary programs keep running.

## How we changed the compaction structure

Once the root cause was clear, the fix was obvious — **rather keep a slightly longer post-compaction tail than ever casually discard an already-computed (or nearly computed) background result**:

### 1. Kill `refresh-on-growth` (no more discarding for fast growth)

In `pi-coding-agent` (`session-maintenance.ts` / `speculation-lead.ts`), we removed the "invalidate the candidate because context grew past the limit" condition outright. As long as the session branch is unchanged and there is still enough post-compaction context headroom, the `armed` summary stays valid! Even if the foreground accumulates another 30k of new messages after the snapshot, commit replays the entire post-snapshot tail verbatim after the summary — no history lost, instant switch.

### 2. If the background is still computing at the line (`pendingSpec`), wait for it — don't kill and restart

If the background candidate is still in flight when the threshold is reached, it has likely been running for fifty or sixty seconds and is about to finish. `abort`ing it and opening a fresh foreground request is self-sabotage. We now wait out the in-flight background request with `untilAborted` and validate + splice; the wait is bound to the control cycle's cancellation signal, so budget expiry or human handoff still interrupts cleanly and never commits late.

### 3. Isolate the background compaction request from the foreground WebSocket connection

If background summarization grabs the session channel the foreground is using, it easily corrupts the foreground WebSocket sticky session. So background compaction requests use an independent `sessionId: "<id>:spec:<snowflake>"`, inherit the server-side prompt-cache affinity via a new `parentSessionId` plumbed through `pi-agent-core` / `pi-ai`, and are forced onto HTTP (`preferWebsockets: false`) — foreground and background never touch each other.

### 4. Give every background candidate an ID (`operationId`)

Previously, how a background compaction died and how long it took was an accounting mess in the logs. We added `diagnostics_channel("omp.compaction.speculation")`, binding a unique `operationId` from candidate creation and logging the full lifecycle and latency of `started / armed / failed / cancelled / applied / invalidated` (see [trace.ts](../../rsa/src/harness/omp/trace.ts) and the [logging contract](../reference/logging.md#shiori-compaction-and-transport)).

## Cost and verification

No free lunch: the cost is clear — **because we reuse a minutes-old snapshot summary, messages added after the snapshot stay verbatim in the post-compaction history tail**, so context right after compaction is slightly fatter than a "freshly computed latest summary". When a valid candidate is ready, re-requesting a summary is avoided; when the candidate is still in flight or fails validation, waiting can still occur. Branch changes, insufficient projection headroom, config changes, and cancellation still invalidate candidates. If some future non-real-time scenario allows pausing the environment during compaction, this trade-off can be revisited.

To keep future upgrades from silently breaking this behavior, we put two locks on it:

- **Integration test**: [rsa/tests/omp-speculation.test.ts](../../rsa/tests/omp-speculation.test.ts) runs the real OMP preparation / validation / commit / tail replay, locking in "survives >20k growth", "waits for the in-flight candidate at the line", "branch/headroom failures still invalidate", and "cancellation interrupts without late commit".
- **Built-in benchmark**: `rsa bench run ludens/background-compaction` (see [Benchmark](../reference/benchmark.md)), which replays the full background-compaction lifecycle offline with controlled streams.
