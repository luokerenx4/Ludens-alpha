# WS Recovery Test Rationale

This note explains why Ludens patches the OpenAI Codex WebSocket transport layer and maintains an offline fault matrix for connection recovery.

The reason is straightforward: **multimodal payloads are large. Without delta transport, request bodies grow rapidly with session history and degrade long-horizon runs.**

## Why multimodal loops rely on WebSocket delta transport

In a plain-text agent, several hundred turns of text total only a few hundred KB — resending the full history over stateless HTTP SSE each turn adds minimal overhead.

In Ludens, the agent reads perception images every turn. Even compressed, a single base64 image is tens to hundreds of KB; after tens or hundreds of turns, a multimodal session history reaches multiple megabytes or tens of megabytes.

Falling back to stateless HTTP SSE means **every model inference round and tool-call return must re-serialize and re-upload the entire image history accumulated since turn one**:

- For example, 2 MB at turn 10, 8 MB at turn 50, 15 MB at turn 100… (illustrative growth only, not measured data.)
- Every turn re-uploads previously sent images, causing serialization overhead and upload latency to grow linearly with turn count.

The OpenAI Codex Responses API's **WebSocket mode supports delta transport**: as long as the connection remains open, the server retains the previous turn's state, and the client only sends, chained on `previous_response_id`, **the incremental payload produced by the latest step (such as a newly sampled image or tool result)**.

WebSocket delta transport is therefore **essential for sustaining throughput in long-horizon multimodal runs**. If a transient disconnect permanently degrades the session to full HTTP retransmission, transport overhead escalates for the remainder of the run.

## Three disconnect scenarios observed in long runs (R1 / R2 / R3)

Across six- to eight-hour continuous runs, three distinct disconnect boundary conditions surfaced:

- **Scenario 1 (R1 · 2026-10-18 6-hour continuous run): hard cap on connection lifetime**
  After enough uptime, the server returns `websocket_connection_limit_reached` following a stretch of empty `thinking`. A single WS connection has a server-side lifetime cap — expiry is expected, so the current round must fall back to SSE, then reopen a fresh WS after a cooldown to resume deltas.
- **Scenario 2 (R2 · 2026-10-19 8-hour continuous run): mid-stream `1012` close left on SSE for 5.5 hours**
  That run (`2026-10-19T13-19-53.903Z`) handled connection-lifetime expiry normally at 23:19:59 Beijing time and reconnected to WS at 23:21; then at 23:46:56 the connection received `websocket closed (1012)`. The existing records establish a gap in recovery classification — they do not identify the server or network fault source. Because mid-stream close codes like `1012` were not classified as transient faults at the time, the session remained on HTTP SSE with full multimodal retransmission for the next **5.5 hours**.
- **Scenario 3 (R3 · 2026-10-20 run): disconnect mid-way through tool arguments — SSE replay boundary**
  In run `2026-10-20T14-57-50.713Z`, the connection expired while the model was streaming `custom_tool_call_input.delta` (tool-call JSON arguments partially emitted, `done` not yet reached). To guard against replay side effects we had initially added a rule stricter than stock OMP: "if this round has emitted any visible output, never replay on disconnect, just error out" — which aborted the running agent.
  Reviewing the execution boundary clarified the invariant: **partially emitted `text` / `thinking` content, or incomplete tool-argument deltas, means the tool has not started executing.** Replaying the current request over SSE at that point is safe. The actual non-replayable boundary is **`toolcall_end` (the tool call has been fully delivered for execution)** — only past that point must replay be blocked to prevent duplicate execution of side-effecting tools. We removed the extra guard and aligned with stock OMP's `canSafelyReplayWebsocketOverSse`.

## Transport recovery rules

To ensure reliable recovery, we decoupled the connection-recovery state machine from the replay boundary under three rules:

1. **Transient disconnect (retry WS after a 60 s cooldown)**: explicit expiry, mid-stream close codes `1000 / 1001 / 1006 / 1011 / 1012 / 1013`, handshake timeouts, `send` errors, or first-packet timeouts are classified as transient faults. The current request falls back to SSE as long as no tool has been fully delivered, followed by a 60 s cooldown (with no handshake retries during cooldown); once the cooldown expires, a single full-history request establishes a new WS connection, and subsequent turns resume delta transport.
2. **Frame size over limit (> 15 MiB or remote `1009`; recover WS after context compaction)**: if the actual outbound WS frame exceeds 15 MiB (evaluated on the outbound frame size — if cumulative history is large but the current delta is small, incremental WS continues), the transport falls back to SSE and sets a size-blocked flag; once OMP context compaction reduces the history size, the block clears and WS resumes.
3. **Protocol and auth hard rejections (permanently disable WS)**: explicit protocol, data-format, or auth rejections (`1002 / 1003 / 1007 / 1008 / 1010` or `3000 / 3003`) disable WS for the remainder of the session.

## Why a dedicated offline fault matrix?

Network edge cases that take five or six hours to trigger cannot be debugged by running an eight-hour live session after every code change.

During implementation we built an offline transport-layer test suite ([rsa/tests/omp-websocket.test.ts](../../rsa/tests/omp-websocket.test.ts)) and a companion benchmark ([ws-recovery.ts](../../rsa/src/benchmark/cases/ws-recovery.ts)): in-process fixtures stub the WebSocket and HTTP layers beneath `streamOpenAICodexResponses`, and a virtual clock advances the 60 s cooldown without live model calls:

```sh
(cd rsa && bun run omp:test:transport)
(cd rsa && bun run typecheck)

# Generate benchmark records viewable with event and scoring evidence in the Dashboard:
rsa/bin/rsa --workspace /absolute/path/to/workspace bench run ludens/ws-recovery
```

The suite covers **13 scenario classes** (including the R3 `Agent.prompt` end-to-end single-execution tool-callback regression):

| Scenario class | Simulated scene / injection point | Required behavior |
| --- | --- | --- |
| Normal first frame → delta → fresh connection | Old socket closes after a clean run | New connection sends one full history (without the old `previous_response_id`); the next round resumes delta immediately. |
| Connection lifetime expiry | R1 / R2 · expiry error event after empty `thinking` | Current request falls back to SSE seamlessly; no handshakes during the 60 s cooldown; full WS after cooldown → delta resumes next round. |
| Abnormal mid-stream close (`1000 / 1001 / 1006 / 1011 / 1012 / 1013`) | R2's `1012` + synthetic close codes | Same transient-recovery path — must never permanently degrade to SSE after one drop like pre-fix R2. |
| Handshake-phase failure (`1006 / 1012 / 1013` or handshake timeout) | Connection dies before it is established | Current request goes over SSE, no tight handshake-retry loop during cooldown, reconnects normally after. |
| Protocol/auth hard rejection (`1002 / 1003 / 1007 / 1008 / 1010 / 3000 / 3003`) | Handshake or first frame rejected at protocol level | WS disabled permanently for the session; neither time passing nor context compaction unblocks it. |
| `send` error, bad JSON, first-packet timeout | Error before any valid content arrives | Bounded retries, then fall back to SSE and enter cooldown; later requests can still recover WS. |
| Disconnect halfway through `text` / `thinking` | Streaming text cut mid-output | Native SSE replay allowed for recovery; half-emitted text is not an executed side-effecting tool; WS recovers after cooldown. |
| Disconnect after a tool fully delivered (`toolcall_end`) | Tool already dispatched for execution | Current request must error — **never replay the tool over SSE**; later requests keep the cooldown WS-recovery chance. |
| Disconnect mid tool-argument streaming (`delta`) | R3 · arguments incomplete (pre-`done`) at disconnect | Rescued via SSE replay within the same `Agent.prompt`; the complete tool callback executes **exactly once** and its result is submitted. |
| Single frame `> 15 MiB` or remote `1009` | Single outbound frame over limit | Switch to SSE and flag size-blocked (no repeated handshakes while blocked); only a completed native context compaction clears the block and restores WS. |
| Cumulative history `> 15 MiB` but small round delta | Large history, small current increment | Evaluated by actual outbound frame size — continues using incremental WS. |
| `1009` after a tool was delivered | Size over-limit hit after tool submission | Current request does not replay the tool, and records the size block; SSE continues until compaction completes, then WS recovers. |
| Human handoff or budget-expiry cancellation | `AbortSignal` fires mid-handshake / mid-output / mid-error | Exit immediately as `aborted` — no extra SSE requests, no pollution of the next round's transport state machine. |

Before every planned OMP upgrade, run `bun run omp:test:transport` and `rsa bench run ludens/ws-recovery` first, and check whether upstream changes broke any of these controlled recovery behaviors. The virtual clock and transport fixtures do not measure real reconnect latency and do not prove production never drops; for long runs, scheduling, and throughput, consult actual run logs.
