# Insights · Why It Was Built This Way

No dry parameter dictionaries here. Instead, these notes walk through the real issues we hit when running a coding agent inside real-time interactive environments — and why each design choice was made.

Many designs look complicated if you only read the code in isolation (e.g. why OMP has compaction and WebSocket transport patches). Once you switch to the actual setting — **continuous perception sampling at 30 Hz, the model reading selected multimodal observations turn by turn, and runs lasting seven or eight hours** — the trade-offs become straightforward.

## Existing notes

- [**OMP background compaction rework**](omp-compaction.md): OMP's main loop is serial, while its native background compaction invalidates candidates as context grows. Measured growth shows this rule can keep candidates from surviving to the threshold, raising the risk of synchronous foreground recomputation. This note explains how we restructured its compaction.
- [**WS recovery test rationale**](ws-recovery.md): Images in multimodal interaction are large — without WebSocket delta transport, every inference round re-uploads large images from previous rounds, and request volume balloons over long runs. This note explains how, after several 6–8 hour runs, we built recovery patches and an offline fault matrix for the Codex WebSocket channel.
- [**Injection converges to a single per-turn channel**](omp-injection.md): Appending the latest frame to the last completed tool result in each batch spent roughly 60% of context on unrequested screenshots and left attribution dependent on completion timing. This note explains why we removed the end-of-batch channel in favor of turn-start delivery plus explicit `observe` calls.
