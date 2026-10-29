# WS Recovery Test Rationale

Why would a game-agent project spend so much effort patching the OpenAI Codex WebSocket transport layer and writing a fault matrix for it?

The answer is one sentence: **multimodal payloads are just too big. Without delta transport, every request body balloons like a snowball and kills any long run.**

## Why the multimodal loop depends on WebSocket to survive

In a plain-text agent, a few hundred rounds of text add up to a few hundred KB — resending the full history over stateless HTTP SSE every round is painless.

But in Ludens, the agent looks at game frames and reads perception images every round. Even compressed, a single base64 image is tens to hundreds of KB; after tens or hundreds of rounds, session history full of multimodal images balloons to megabytes or tens of megabytes.

Falling back to classic HTTP SSE then means **every model inference round and every tool-call return re-serializes and re-uploads the entire image history accumulated since round one, verbatim**:

- E.g. 2 MB at round 10, 8 MB at round 50, 15 MB at round 100… (illustrative growth only, not measured data.)
- Every round re-uploads images the previous round just uploaded; serialization cost and upload time explode linearly with round count, and late in a run just sending the request takes forever.

The OpenAI Codex Responses API's **WebSocket mode supports delta transport**: as long as the connection stays alive, the server remembers the previous round's state, and the client only needs to send, chained on `previous_response_id`, **the tiny increment produced by the latest step (e.g. one freshly sampled image, one just-finished tool result)**.

So for us, WebSocket is not some "nice performance optimization" — it is **the lifeline that decides whether multimodal long-horizon runs can survive at all**. If a network jitter or edge case drops WS mid-run and it never comes back — permanently degrading to HTTP full retransmission — the rest of the experiment is essentially ruined.

## Potholes hit on real long device runs (R1 / R2 / R3)

Simple in theory — but run the agent in a game continuously for six to eight hours and every bizarre disconnect posture shows up:

- **Pothole 1 (R1 · 2026-10-18 Besiege 6-hour run): hard cap on connection lifetime**
  After enough uptime, the server throws back a `websocket_connection_limit_reached` following a stretch of empty `thinking`. A single WS connection has a server-side lifetime cap — expiry is inevitable, so the current round must glide back to SSE, then reopen a fresh WS after a cooldown to resume deltas.
- **Second pothole (R2 · 2026-10-19 马造 8-hour run): a `1012` at midnight, then 5.5 hours wasted as SSE**
  That run (`2026-10-19T13-19-53.903Z`) survived connection-lifetime expiry normally at 23:19:59 Beijing time and reconnected to WS at 23:21; then at 23:46:56 the connection suddenly received a `websocket closed (1012)`. The existing records establish a gap in recovery classification — they do not identify the server or network fault source. Because there was no transient-fault recovery classification for mid-stream close codes like `1012` at the time, the system got "once bitten" and gave up on WS entirely for the following **5.5 hours**, degrading to HTTP SSE with full multimodal retransmission every round!
- **Third pothole (R3 · 2026-10-20 run): disconnect mid-way through tool arguments — dare we replay over SSE?**
  In run `2026-10-20T14-57-50.713Z`, the connection expired exactly while the model was streaming `custom_tool_call_input.delta` (tool-call JSON arguments half-emitted, `done` not yet reached). To guard against replay side effects we had initially added a rule stricter than stock OMP: "if this round has emitted any visible output, never replay on disconnect, just error out" — which stopped the running agent dead.
  The post-mortem made it clear: **half-emitted `text` / `thinking` text, or tool-argument deltas not yet complete, means the tool never even started executing!** Replaying the current request over SSE at that point is perfectly safe. The only real red line is **`toolcall_end` (the tool call has been fully delivered for execution)** — only past that line must replay be abandoned to avoid double-executing a side-effecting tool. So we removed the overzealous guard and fully aligned with stock OMP's `canSafelyReplayWebsocketOverSse`.

## How the patches established the recovery rules

To make this multimodal delta artery pick itself up no matter how it falls, we fully decoupled the connection-recovery state machine from the replay boundary and set a few iron rules:

1. **Transient disconnect (retry WS after a 60 s cooldown)**: explicit expiry, mid-stream close codes `1000 / 1001 / 1006 / 1011 / 1012 / 1013`, handshake timeouts, `send` errors, or first-packet timeouts all count as transient. The current request is rescued via SSE as long as no tool has been fully delivered, then a 60 s cooldown follows (no blind handshake attempts during it); once it passes, one full-history attempt establishes a new WS connection, and the next round resumes delta transport on success.
2. **Frame size over limit (> 15 MiB or remote `1009`; recover WS only after compaction slims things down)**: if the actual outbound WS frame exceeds 15 MiB (note: this checks the actual frame to send — if cumulative history is fat but this round's delta is small, incremental WS continues as usual), fall back to SSE and raise a "size-blocked" flag; once OMP context compaction later slims the volume, the block clears automatically and WS resumes.
3. **Protocol and auth hard rejections (permanently disable WS)**: only explicit protocol, data-format, or auth rejections — `1002 / 1003 / 1007 / 1008 / 1010` or `3000 / 3003` — shut WS off for the rest of the session.

## Why a dedicated offline fault matrix?

Network edge cases that take five or six hours to hit once cannot be debugged by hanging an eight-hour 马造 run after every code change — that would take forever.

So, exceptionally during construction, we took a TDD approach and wrote a fully offline transport-layer suite ([rsa/tests/omp-websocket.test.ts](../../rsa/tests/omp-websocket.test.ts)) plus a companion dashboard benchmark ([ws-recovery.ts](../../rsa/src/benchmark/cases/ws-recovery.ts)): in-process fixtures take over the WebSocket and HTTP layers beneath `streamOpenAICodexResponses`, and a virtual clock fast-forwards the 60 s cooldown in seconds — no real model connection, not a cent of tokens spent:

```sh
(cd rsa && bun run omp:test:transport)
(cd rsa && bun run typecheck)

# Generate benchmark records viewable with event and scoring evidence in the Dashboard:
rsa/bin/rsa --workspace /absolute/path/to/workspace bench run ludens/ws-recovery
```

The suite pins down **13 scenario classes** in one pass (from an initial 19 pass / 18 fail all the way to green, with the R3 `Agent.prompt` end-to-end single-execution tool-callback regression added on Oct 21):

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
| Cumulative history `> 15 MiB` but tiny round delta | Fat history, small current increment | Judge by the actual incremental frame size — keep happily running incremental WS. |
| `1009` after a tool was delivered | Size over-limit hit after tool submission | Current request does not replay the tool, and records the size block; SSE continues until compaction completes, then WS recovers. |
| Human handoff or budget-expiry cancellation | `AbortSignal` fires mid-handshake / mid-output / mid-error | Exit immediately as `aborted` — no extra SSE requests, no pollution of the next round's transport state machine. |

Before every planned OMP upgrade, run `bun run omp:test:transport` and `rsa bench run ludens/ws-recovery` first, and check whether upstream changes broke any of these controlled recovery behaviors. The virtual clock and transport fixtures do not measure real reconnect latency and do not prove production never drops; for long runs, scheduling, and throughput, consult actual run logs.
