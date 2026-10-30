# Logging and Call Chains

Offline analyzers, the Dashboard web console, the Ludens Pet desktop companion, and the Benchmark scorer all consume the same persisted run facts. The recording rule is: **continuous high-frequency capabilities archive data on demand and report periodic aggregate statistics; active decisions and device changes record full events; internal nested call chains are traced at the diagnostics level**.

## Recording modes

### 1. `normal` vs `full` comparison

Set the log mode in `rsa.json`'s `logging.diagnostics` (or CLI `--diagnostics`); it is written to `manifest.json` at startup, and Python child processes inherit it via the `RSA_LOG_DIAGNOSTICS` environment variable (`rsa status` shows the effective modes of the Host and Baseware in `logging.diagnostics` and `basewareDiagnostics` respectively):

| Mode | Recorded scope | Written to |
| --- | --- | --- |
| `normal` (default) | Fully keeps model calls, tool executions, active capability calls, device input and terminal states (`action_start / action_end`), control transitions, resident-process lifecycles, and fault spans; for resident-loop internal read-only call chains carrying `trace.recordingPurpose = "continuous-perception"` or `"continuous-action"`, per-call events and log RPC are omitted (results annotated `@record` are still written to `.rsa/timeline/` normally). | `logs/<run-id>/events.jsonl` and Baseware `events/` |
| `full` | On top of `normal`, additionally records every nested Python call inside resident perception/action loops and every Baseware read-only query detail (without duplicating media or experience events). | Separately written to `logs/<run-id>/diagnostics.jsonl` and Baseware `diagnostics/` segments |

### 2. Periodic aggregate statistics and fault-span merging

To keep 30Hz resident loops from flooding the event stream, continuous sampling and action loops use **fixed 5-second window statistics + fault-span merging**:

- **5-second window statistics**: resident perception writes `perception_stats` every 5 seconds (per capability ID and `codeSHA`: call counts, error counts, latency `total/min/max`, sampling attempts/completions/recordings, plus video-encoder cumulative counts and current queue snapshot); Baseware independently writes `device_sampling_stats`; resident action writes `action_stats` every 5 seconds (with `stepHz` and window `step` deltas). A trailing statistics segment is automatically appended on clean process shutdown.
- **Fault-span merging**: the first continuous-perception error immediately writes `perception_fault` / `device_sampling_error`; subsequent retried errors of the same kind only accumulate the span's `fault.count` — the fault event is not reopened per frame even when successes and failures interleave. The fault span closes once a successful recovery is observed followed by at least one full 5-second window with no errors of the same kind (or the process stops normally). The first resident-action anomaly writes `action_fault` and immediately stops the action loop; `action_fault_end` is written when shutdown or reload finalizes.

## Files and event identity

### 1. Storage layout and multi-source merging

Files in a single run directory `workspace/logs/<run-id>/`:

| File / directory | Content and owner |
| --- | --- |
| `manifest.json` | Workspace paths, models, Driver list, budgets, effective log modes, Shiori implementation version, Git/prompt hashes, and `eventSources` external fact-source declarations. |
| `events.jsonl` | RSA-written Schema v2 main event stream (call identities, statistics, and content references). |
| `diagnostics.jsonl` | High-frequency internal-call diagnostics stream in `full` mode, read with on-demand pagination. |
| `streams/` | Model streaming-response shards (`rsa-stream-v1` format; small leaf nodes inline, large nodes referencing `.rsa/archive/`). |
| `perception/<gen>/` · `action/<gen>/` | Entry info of the corresponding generation, the actually imported workspace source list `sources.json`, and process `stderr`. |

Three underlying stores shared across runs:

1. **Baseware device fact sources (`logs/baseware/`)**: each Baseware instance independently maintains `source.json`, `events/`, and `diagnostics/` (segmented by 1 hour or 256 MiB); events are uniquely identified by `origin.eventId = "<serviceId>:<seq>"`. RSA records `{sourceId, root, format, recordingId, windows}` in `manifest.json`'s `eventSources`; readers merge on demand via [shared/event-sources.ts](../../shared/event-sources.ts). The `recordingId` is frozen at action start, so even actions that end late after the window closes are still attributed exactly to the original run.
2. **Workspace spacetime axis (`.rsa/timeline/`)**: cross-run shared perception and capability archives — `video/<id>.mp4` with companion state files `.mp4.json` (distinguishing `pending / ready / error`), deduplicated non-video media `objects/<sha256>.bin`, and segmented records `segments/` (with JSONL, fixed-length `.idx` index, and `.meta.json`). With persistence off (`RSA_PERCEPTION_PERSIST=0`), only `window-<pid>-.../` temporary windows are used.
3. **Content-addressed structured archive (`.rsa/archive/`)**: uniformly read/written by [shared/log-archive.ts](../../shared/log-archive.ts). Model messages, tool definitions, and large parameters/results are stored as `objects/<sha256>.json.gz` (using `encoding: "rsa-json-v1"` with tagged JSON to distinguish internal references from user `$ref` fields). Image/audio data in logs is not stored twice; instead it references `.rsa/timeline/` assets, with a lightweight hash-to-video-frame mapping index kept in `.rsa/archive/media/<sha256>.json` (in-memory LRU capped at 4096 entries).

### 2. Common event envelope

Every JSONL event carries a top-level writer identity (`runId` or `serviceId`, incrementing `seq`, wall-clock `at`, monotonic `atMs`) plus four core blocks (defined in [rsa/src/harness/events.ts](../../rsa/src/harness/events.ts)):

- **`source`**: the responsible component that produced the semantics (`shiori`, `rsa`, `workspace`, `baseware`, `benchmark`, `dashboard`, `pet`) and its concrete implementation and version.
- **`origin`**: `{eventId, clockId, seq, at, atMs}` of the source process that first generated the fact; unchanged across forwarding and persistence (`atMs` may only be subtracted within the same `clockId`).
- **`trace`**: call-chain and business-ownership context, with `traceId / spanId / parentSpanId` (call-tree relations), `epoch / modelCallId / requestId / httpId / toolCallId / operationId` (business entity IDs), `recordingId / recordingPurpose` (run ownership and resident purpose), and `inputGeneration` (action-worker reload generation within an epoch).
- **`type` / `data`**: the concrete event type and payload.

## Calls and lifecycles

All call chains pair strictly on explicit `trace.spanId / parentSpanId` — never by guessing parentage from nearby timestamps or function names. Typical chain shapes:

- Model and tool chain: `invoke_agent → chat / execute_tool / compaction`
- Capability and device chain: `capability → python_call → capability → command / execution`

Quick reference of core event contracts:

| Event type | Semantics and lifecycle boundary |
| --- | --- |
| `capability_start / capability_end` | `rsa controller` `list / help / call` boundaries; records parameters, capability ID, epoch check result, terminal state (`success / error / cancelled`), and latency. |
| `python_capabilities_start / python_capabilities` | Independent child Span of the workspace `@capability` AST static-scan discovery. |
| `python_capability / python_capability_result` | Function location, source hash, inputs, and return value of one CLI Python-capability runner invocation. |
| `python_call_start / python_call_end` | Actual execution Span of a workspace `@capability`-decorated function; records PID, source hash, terminal state, and latency (native Python input/return objects are not force-serialized). Resident parents omitted under `normal` are flagged `parentOmitted: true` on child events. |
| `command / execution / execution_error` | Baseware device-operation request and terminal state; the media summary produced by the same call is embedded in `execution.observations`. |
| `action_start / action_end` | Independent hardware-execution lifecycle of a submitted async gamepad action (`pad.play`), carrying `actionId` and reusing the submission's `trace / epoch` — never hung under a later `pad.wait / status` request. |
| `action_status / action_fault / action_fault_end / action_stats` | Resident `action.py` process lifecycle, fault spans, and 5-second statistics; lifecycle state feeds Activity and the desktop pet, fault details and statistics feed diagnostics. |
| `background_start / background_result` | Start and completion notifications of OMP native async `bash` tasks (`async`) or named services (`service`), paired by `jobId` or `service name + PID`, keeping the `trace / epoch` from launch. |

**Python exception-chain merging rule**: `python_call_end.outcome = "error"` only means that layer's function raised (an outer caller may have caught it with `try/except`). The analyzer and Dashboard merge adjacent uncaught exceptions along explicit Python parentage into one exception chain (`localPythonExceptionGroups`); once an ancestor call returns successfully the chain is cut — an internally caught exception never overwrites the outer tool's success status.

## Perception and true model input

### 1. Spacetime queries and model delivery receipts (`observation_context`)

- **Query events**: each `observe` execution records `perception_observe_start / perception_observe_end`, using that call's `spanId` as the returned envelope's `queryId`.
- **Delivery receipts**: automatic delivery happens only at prompt start (`before_agent_start`); explicit `observe` calls and native tool images open their own receipts (`origin` of `explicit` and `tool_result`, respectively). Each context delivery to the model writes one `observation_context` event recording `{id, origin, queries, observations, purpose?}`. A subsequent `model_start` references the newly added receipt IDs via `deliveryIds` (note: `deliveryIds` only identifies newly appended observation sources for that round; the model's full history context is defined by the request archive payload).
- **Auto-delivery dedup cursor**: with auto-injection on (the `context_policy` event records `rsa perception inject on/off` changes), the extension deduplicates by spacetime-axis `recordId` so the same record is never re-appended on later turns; a new sample with identical pixels but a different `recordId` is still delivered as independent time evidence. The sampler state cursor advances only when auto-delivery actually completes; suppressed or cancelled reads never swallow state-change notifications.

### 2. Model input re-encoding and tool-image tracking

- **Derived images (`modelMedia`)**: perception images pass through one `resizeImage` encoding before reaching OMP; encoding latency and dimensions go into the `observation_media` event, and the re-encoded image is stored by the perception writer as a derived asset (recording derived hash, source `asset / recordId / sequence`, and converter name `omp.resizeImage` in `observation_media.modelMedia`).
- **Native tool images**: images delivered to the model via native `read` or `bash --images` are recorded as `observation(origin = "tool_result")` tied to the matching `toolCallId`. If the CLI output carries an explicit spacetime-axis record tag and the bytes match, it is linked exactly to that `recordId`; if only the byte hash matches `.rsa/timeline/objects/<sha256>.bin`, the underlying asset is reused without guessing the sampling moment.

## Shiori, compaction, and transport

1. **Shiori OTel telemetry**: [shiori.ts](../../rsa/src/harness/omp/shiori.ts) mounts a scoped OpenTelemetry provider (with `captureMessageContent = "none"` to avoid duplicating bodies) and writes a `shiori_run_end` summary at the end of each `agentLoop`.
2. **HTTP and WebSocket transport tracing**: [trace.ts](../../rsa/src/harness/omp/trace.ts) records full request payloads, transport protocol (WS full / WS delta / HTTP SSE), and phase latencies:
   - **HTTP header wait**: from request dispatch to receipt of the HTTP response headers (streaming completion is marked by the content-stream end after `http_end`).
   - **WS first-event wait**: in WebSocket mode the outbound `response.create` only marks send completion; the Dashboard measures outbound-completion to first inbound server event as the first-response metric.
3. **Background speculation-compaction tracing**: each background compaction candidate gets a unique `operationId` via `diagnostics_channel("omp.compaction.speculation")`, tracing `started → armed / failed / cancelled` end to end plus threshold-phase `waiting / applied / invalidated`; its internal HTTP requests and retries are mounted under that `operationId` and the original control `epoch`.

## Consumption and metric interpretation

### 1. Dashboard Worker and three-layer rebuildable index (`.dashboard-index/`)

The Dashboard isolates log parsing and index building in a dedicated Node Worker fully outside the Next.js request context. Each run directory's `.dashboard-index/` is a purely derived, freely rebuildable secondary index (never modifying the original `events.jsonl`, `streams/`, `.rsa/archive/`, or `.rsa/timeline/`), with three parts:

1. **Source-event location and relation catalog**: each event keeps only its file byte offset, timestamp (taken as `origin.at ?? at`), type, and call identity; model, Span, action, and observation relation tables all point at source-event byte offsets.
2. **Activity on-demand display recipes**: each display block (Thinking / Text / Tool / System / Diagnostic) keeps only the source-event offsets or `streams/` cutoff byte counts; text is assembled from originals on recipe only when the frontend or pet requests it, never redundantly stored in the index.
3. **Periodic overview and statistics snapshots**: pre-aggregated request latencies, Token Usage, Span terminal-state counts, and current run phase, supporting second-scale opening of long-period overviews.

### 2. Page cache and cold-history builder subprocess

- **Page cache and lease eviction**: the index pages to disk at most 1024 entries or 256 KiB per page. The query Worker keeps a shared page cache of **256 MiB** by default (tunable via `RSA_DASHBOARD_INDEX_CACHE_BYTES`), retains at most **3** idle runs (`RSA_DASHBOARD_INDEX_MAX_RUNS`), and releases memory after **5 minutes** idle (`RSA_DASHBOARD_INDEX_IDLE_MS`) with no in-flight read leases.
- **Single-instance cold builder**: on first opening a historical large run with no index yet, the query Worker spawns a globally unique temporary Builder subprocess (target working set **2 GiB** by default, controlled by `RSA_DASHBOARD_BUILD_BYTES`), which single-pass scans the event stream at a fixed cutoff and batch-generates `generations/<id>/`, then publishes via atomic replacement of `.dashboard-index/active.json` and exits to return memory to the OS. During the build, endpoints return HTTP `202 ARCHIVE_PREPARING` with live progress; closing the browser tab only cancels the current HTTP query and never interrupts the bounded background build.

### 3. Console HTTP API and Ludens Pet incremental follow

- **`/api/activity`**: `changes` (opaque-cursor incremental block updates, shared by web and Ludens Pet), `history` (paged search by category and full-text keywords), and `block` (single-block detail expansion). Ludens Pet only consumes live `changes` deltas of the followed workspace's latest non-Benchmark run, recording its own consumption watermark under `workspace/logs/consumers/`.
- **`/api/diagnostics`**: dedicated paged query of `full`-mode diagnostic events by `epoch`, time window, `traceId / spanId / actionId` (max 500 entries per page), never mixed into the regular Activity stream or pet bubbles.

## Experience replay

### 1. Spacetime player and frame read-ahead buffer

The Dashboard replay view (`/api/replay`) aligns `.rsa/timeline/` continuous-sample frames, device-action spans (`action_start / action_end`), model reasoning, and tool calls on one workspace wall-clock timeline:

- **Time windows and dual-frame read-ahead**: events page by at most 60-second windows with 500-entry cursors; frames use a decode-buffer Hook — atomically switching only once all screen frames for the target moment are loaded, while reading ahead at most 2 frames (max 8 images / 32 MiB read-ahead cache), releasing image memory immediately on workspace switch or page leave.
- **Sampled frames vs actual model input**: the player's main view shows perception-layer archived consecutive frames (including frames sampled during model thinking but never fed into context); the model-call detail locates observations by that request's input references. Video frames are lossy reconstructions and must not be treated as the model's original input bytes; unarchived, encoding-gap, or expired media shows as missing per actual state.

### 2. Offline log reading and run-analysis tools

From the repo root, archives can be read and statistics reports generated without starting the Host or Dashboard:

```sh
# Emit the full JSON statistics report for a given run and control cycle
python3 rsa/scripts/analyze-run.py /path/to/workspace/logs/run-id \
  --epoch epoch-id --output /path/to/analysis.json

# Expand one event's archived reference body (media shows reference summary by default; --full restores only media bytes whose originals still exist; video sources keep the lossy-origin mark)
rsa/bin/rsa logs read --run /path/to/workspace/logs/run-id --event 123 --field payload

# Stream all fact-source events declared by the run in order (add --diagnostics to read the full diagnostic stream)
rsa/bin/rsa logs events --run /path/to/workspace/logs/run-id
rsa/bin/rsa logs events --run /path/to/workspace/logs/run-id --diagnostics
```

Core metric semantics of [analyze-run.py](../../rsa/scripts/analyze-run.py):

- **Model latency and cache hit rate**: over completed model requests; P95 uses nearest-rank; Prompt Cache hit rate is Token-weighted with denominator `input + cacheRead + cacheWrite` (`warm` only excludes the period's first request, not cache rebuilds caused by later compaction).
- **Effective device-action rate**: counts only successful `action_end` plus successful non-`actionId`, control-requiring, non-read-only `execution`; async action submissions (the `pad.play` request itself), status queries, `pad.wait`, and perception sampling are never double-counted as actions.
- **Nested latencies are not summed**: Shiori total time includes model and tool time, tool time includes inner capability and device-call time; each level is shown independently, never naively added up.
