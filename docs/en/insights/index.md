# Insights · Why It Was Built This Way

This directory records key engineering trade-offs and postmortems from running a coding agent inside continuously sampled, real-time interactive environments.

Several mechanisms (such as the OMP compaction and WebSocket transport patches) can look intricate in isolation, but follow directly from the constraints of **30 Hz continuous perception, per-turn multimodal observations, and multi-hour runs**.

## Existing notes

- [**OMP background compaction rework**](omp-compaction.md): OMP's main loop is serial, while its native background compaction invalidates candidates as context grows. Measured growth shows this rule can prevent candidates from surviving to the threshold, increasing the risk of synchronous foreground recomputation. This note explains how we restructured the compaction lifecycle.
- [**WS recovery test rationale**](ws-recovery.md): Multimodal image payloads are large; without WebSocket delta transport, every inference round re-uploads historical images and request volume grows rapidly over long runs. This note documents the Codex WebSocket recovery rules and offline fault matrix derived from 6–8 hour continuous runs.
- [**Injection converges to a single per-turn channel**](omp-injection.md): Appending the latest frame to the last completed tool result in each batch consumed roughly 60% of context on unrequested screenshots and made attribution depend on completion order. This note explains why we removed the end-of-batch channel in favor of turn-start delivery plus explicit `observe` calls.
