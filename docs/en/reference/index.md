# Reference · Components and Contracts

This directory defines the Ludens system architecture, process responsibility boundaries, device control protocols, run-log archive formats, and Harbor evaluation contracts. The repository source implementation is the sole authority for all contracts.

## Architecture Layers and Reference Map

| Layer | Core Concerns | Spec Document | Authoritative Source |
| --- | --- | --- | --- |
| **System topology and control loop** | Five-component boundaries, the Shiori execution kernel, OMP session assembly, control `epoch`, and cross-process store ownership | [Architecture and Boundaries](architecture.md) | `rsa/src/harness/runtime.ts` · `rsa/src/harness/omp/session.ts` |
| **Device services and capability catalog** | CUA-native tool structure, the `ExecutionResult` envelope, `requiresControl` arbitration, external driver package discovery and loading | [Baseware Philosophy and Capability Contracts](baseware.md) | `baseware/src/contracts.ts` · `baseware/src/catalog.ts` |
| **Emulator wire communication** | TCP single-client line protocol, the `HELLO / OWN / APPLY / CAPTURE / TOUCH` instruction set and error codes | [Driver Bridge Protocol](driver-bridge-protocol.md) | `baseware/src/drivers/bridge.ts` · each emulator satellite repo's Provider |
| **Observability and console consumption** | `normal / full` recording modes, `.rsa/timeline/` and `.rsa/archive/` storage, Trace pairing, Dashboard hot/cold indexes and replay | [Logging and Call Chains](logging.md) | `rsa/src/harness/events.ts` · `shared/log-archive.ts` · `rsa-dashboard/lib/` |
| **Evaluation and independent scoring** | Harbor 1.4 Native Profile, `task.toml / dataset.toml`, `current_trial()`, `reward.json`, and the 8 built-in tasks | [Benchmark](benchmark.md) | `rsa/src/benchmark/` · `rsa/benchmarks/` |

## Reading Guide

- **Adding a new emulator or hardware driver**: read [Driver packages and launch descriptors](baseware.md#driver-packages-and-launch-description) in Baseware Philosophy and Capability Contracts first, then implement the emulator-side TCP bridge and TypeScript Provider against the [Driver Bridge Protocol](driver-bridge-protocol.md).
- **Understanding how the Agent perceives the environment and issues actions**: read [Session and Loop](architecture.md#session-and-loop), [Workspace and Capability Programming](../tutorials/workspace.md), and [Resident Perception and Action Loops](../tutorials/perception-and-action.md).
- **Consuming run logs, debugging model context, or modifying the Dashboard**: read [Logging and Call Chains](logging.md).
- **Writing new evaluation tasks or reviewing scoring results**: read [Benchmark](benchmark.md).
