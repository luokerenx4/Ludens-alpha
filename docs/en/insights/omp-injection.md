# Injection Converges to a Single Per-Turn Channel

If an agent just sits in a terminal doing Q&A, it knows when the environment changed. But our agents are dropped into a game environment that **samples continuously at 30Hz and hands over device control per turn**: by the time the model finishes a batch of tool calls, the world on screen may already be a different one. "The model must hold the latest frame before deciding" thus became a hard requirement — this note covers the second injection channel we built to satisfy it, and why we ended up deleting it entirely.

## What the original design intended

The RSA extension hung two automatic injection channels on the OMP loop:

1. **Turn-start channel**: the `before_agent_start` hook, which hands the model the latest main-channel perception record plus sampler state transitions (`state / codeSHA / error`) as a persisted custom message at the start of every prompt;
2. **End-of-batch channel**: the `tool_result` hook, which appends the latest frame to the result of the **last tool to finish** in a tool batch.

The end-of-batch channel had a very "clever" justification: of all OMP hooks, `tool_result` is the only one **awaited before result persistence and the next model request** — `turn_end` is just a notification and cannot change content. To guarantee "the model holds the latest frame before every decision", this was the only point with precise enough timing (`rsa/src/harness/omp/extension.ts`).

Sounds reasonable on paper, but in practice it introduced four clear flaws.

## What went wrong

**1. Semantic pollution.** The end-of-batch channel spliced screenshots directly into the tool result's content. The model calls `edit` to change one line of code and gets back "edit succeeded + a perception JSON + a screenshot" — mixing tool output and environment observation in the same payload.

**2. Non-deterministic attribution.** The frame was attached to whichever tool in the batch **finished last**. With `read` + `bash` in the same batch, whoever returns later carries the frame; a slight timing difference between runs lands the same frame in a different tool's result, muddying log attribution and session replay.

**3. Uncontrolled frequency.** Auto queries use latest mode, where the spacetime axis returns only the **newest** record (the `_select` in `rsa/python/rsa_tools/_observation_history.py`), and deduplication only checks whether the newest main-sample ID changed. With the sampler running at 30Hz by default, new frames inevitably arrive between boundaries — so **every tool batch triggered an injection**. In a simulated 300-second takeover, 27 of 31 injected frames came from the end-of-batch channel.

**4. Persistent context growth.** The enriched tool results were persisted into session history, while RSA sets the provider image-count budget to `Infinity` (see the caching discussion in [OMP background compaction rework](omp-compaction.md)). Once a frame entered history, only compaction could clear it — one of the most expensive operations in the system.

## Running the numbers

Once this mechanism was built into the Loop injection workbench (dashboard developer panel, `?view=dev&panel=loop`), the numbers spoke for themselves. Same parameters (300s budget, 30-request cap, 8 tool batches per turn, ~1.1k tokens per image):

| Strategy | Injected frames | Delivered frame tokens | Peak wire | Retained perception share of peak |
| --- | --- | --- | --- | --- |
| With end-of-batch channel (old behavior) | 31 | 43.4k | 70.2k | **60%** |
| Turn-start channel only (current) | 4 | 5.6k | 33.8k | 17% |

These are estimates from the local simulator, not measurements of an agent run. Delivered frame tokens count image and frame-text payloads cumulatively; state notices are excluded. Retained perception includes state notices and can shrink after compaction. The chart marks compaction before the affected request.

Sixty percent of context spent on screenshots the model never asked for, and whether those frames stayed or went depended on a sampling beat entirely unrelated to the task.

## What changed

As of 2026-10-29 the end-of-batch channel is deleted as a whole:

- Automatic delivery happens only at `before_agent_start` (prompt start); the semantics of state transitions + new records are unchanged;
- **When it needs a frame mid-turn, the model calls `observe` itself** — it has always been a first-class tool, supporting queries by id / timestamp / range / capability, and explicit reads always get a complete response;
- Explicit `observe` and native tool images each open their own delivery receipts (`origin` of `explicit` / `tool_result`), so trace attribution is preserved; the `tool_result` hook only records the delivery fact of native tool images and no longer rewrites any tool result.

The "fresh frame before deciding" need has not gone away; it just changed hands: instead of the host appending frames at every batch boundary, the model pulls on demand. The sampler-state notification at turn boundaries remains — if the sampler stops, the model is not misled into "no new frames"; the explicit `observe` error codes (`UNAVAILABLE` and friends) are the unambiguous signal.

## Trade-offs and record

The trade-off is that the model may "forget to look": while focused on writing code it will not proactively `observe`, and it will not know the screen changed between turns. We accept this for three reasons: the turn-start channel guarantees every new turn starts from the latest state; state transitions are always delivered at turn boundaries; and a policy that genuinely depends on visual feedback should observe explicitly rather than rely on incidental frames attached to tool results.

In the workbench, the old behavior remains as a control preset labeled "Removed · reference only", running side by side with the current policy on the same parameters so the 60% vs. 17% overhead difference stays visible.
