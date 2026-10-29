# Injection Converges to a Single Per-Turn Channel

If an agent just sits in a terminal doing Q&A, it knows when the environment changed. But our agents are dropped into a game environment that **samples continuously at 30Hz and hands over device control per turn**: by the time the model finishes a batch of tool calls, the world on screen may already be a different one. "The model must hold the latest frame before deciding" thus became a hard requirement — this note covers the second injection channel we built to satisfy it, and why we ended up deleting it entirely.

## What the original design intended

The RSA extension hung two automatic injection channels on the OMP loop:

1. **Turn-start channel**: the `before_agent_start` hook, which hands the model the latest main-channel perception record plus sampler state transitions (`state / codeSHA / error`) as a persisted custom message at the start of every prompt;
2. **End-of-batch channel**: the `tool_result` hook, which appends the latest frame to the result of the **last tool to finish** in a tool batch.

The end-of-batch channel had a very "clever" justification: of all OMP hooks, `tool_result` is the only one **awaited before result persistence and the next model request** — `turn_end` is just a notification and cannot change content. To guarantee "the model holds the latest frame before every decision", this was the only point with precise enough timing (`rsa/src/harness/omp/extension.ts`).

Sounds reasonable. In practice, four flaws, each worse than the last.

## What went wrong

**1. Semantic pollution.** The end-of-batch channel spliced screenshots directly into the tool result's content. The model calls `edit` to change one line of code and gets back "edit succeeded + a perception JSON + a screenshot" — tool output and environment observation mashed into one blob, and the model cannot tell which part is the tool speaking.

**2. Attribution by luck.** The frame was attached to whichever tool in the batch **finished last**. With `read` + `bash` in the same batch, whoever returns later carries the frame; a slight timing difference between runs lands the same frame in a different tool's result. Log attribution and session replay were both muddied by this randomness.

**3. Uncontrolled frequency.** Auto queries use latest mode, where the spacetime axis returns only the **newest** record (the `_select` in `rsa/python/rsa_tools/_observation_history.py`); and dedup only compares whether "the newest main-sample id changed". With the sampler alive (30Hz by default), new frames inevitably arrive between two boundaries — the condition is almost always true, so **every tool batch hits**. The bulk of injection volume came from here: in one simulated 300-second takeover, 27 of 31 injected frames came from the end-of-batch channel.

**4. No way out.** The enriched tool results were persisted into session history, while RSA sets the provider image-count budget to `Infinity` (see the caching discussion in [OMP background compaction rework](omp-compaction.md)). Once a frame entered history, only compaction could clear it — and compaction is itself one of the most expensive operations in the whole system.

## Running the numbers

Once this mechanism was built into the Loop injection workbench (dashboard developer panel, `?view=dev&panel=loop`), the numbers spoke for themselves. Same parameters (300s budget, 30-request cap, 8 tool batches per turn, ~1.1k tokens per image):

| Strategy | Injected frames | Frame tokens | Peak wire | Frames share of peak |
| --- | --- | --- | --- | --- |
| With end-of-batch channel (old behavior) | 31 | 43.6k | 70.2k | **60%** |
| Turn-start channel only (current) | 4 | 5.8k | 33.8k | 17% |

Sixty percent of context spent on screenshots the model never asked for, and whether those frames stayed or went depended on a sampling beat entirely unrelated to the task.

## What changed

As of 2026-10-29 the end-of-batch channel is deleted as a whole:

- Automatic delivery happens only at `before_agent_start` (prompt start); the semantics of state transitions + new records are unchanged;
- **When it needs a frame mid-turn, the model calls `observe` itself** — it has always been a first-class tool, supporting queries by id / timestamp / range / capability, and explicit reads always get a complete response;
- Explicit `observe` and native tool images each open their own delivery receipts (`origin` of `explicit` / `tool_result`), so trace attribution is preserved; the `tool_result` hook only records the delivery fact of native tool images and no longer rewrites any tool result.

The "fresh frame before deciding" need has not gone away; it just changed hands: the host used to force-feed at every boundary, now the model pulls on demand. The sampler-state notification at turn boundaries remains — if the sampler dies the model is not fooled into "no new frames"; the explicit `observe` error codes (`UNAVAILABLE` and friends) are the unambiguous signal.

## Trade-offs and record

The cost is that the model may "forget to look": while focused on writing code it will not proactively `observe`, and it will not know the screen changed between turns. We accept this for three reasons: the turn-start channel guarantees every new turn starts from the latest state; state transitions are always delivered at turn boundaries; a policy that genuinely cares about the frame should observe explicitly rather than eat host-provided feed.

The old behavior has not vanished from view — in the workbench it lives on as a control preset labeled "deleted · kept for flogging", running side by side with the current policy on the same parameters. If anyone wants to stuff things into tool results again, go look at that 60% number first.
