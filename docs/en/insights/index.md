# Insights · Why It Was Built This Way

No dry parameter dictionaries here. Instead, these notes talk about what actually went wrong when we threw a coding agent into game and real-time interactive environments — and why each design became unavoidable.

Many designs look needlessly complicated if you only read the code (e.g. why OMP got a pile of compaction and WebSocket patches). But once you switch to the real setting — **continuous perception sampling at 30 Hz, the model reading selected multimodal observations round by round, runs lasting seven or eight hours** — the trade-offs become plain common sense.

## Existing notes

- [**OMP background compaction rework**](omp-compaction.md): OMP's main loop is serial, while its native background compaction invalidates candidates as context grows. Measured growth shows this rule can keep candidates from surviving to the threshold, raising the risk of synchronous foreground recomputation. This note explains how we restructured its compaction.
- [**WS recovery test rationale**](ws-recovery.md): Images in multimodal interaction are huge — without WebSocket delta transport, every inference round would re-upload all large images from every previous round, and context bloat becomes deadly. This note explains how, after several real 6–8 hour device runs, we armored the Codex WebSocket channel with recovery patches and an offline fault matrix.
