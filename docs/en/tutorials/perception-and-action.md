# Resident Perception and Action Loops

In realtime interactive environments, high-frequency sampling and high-frequency actions are handled by two independent resident Python processes inside the workspace: `perception.py:Perception` continuously collects environment state and writes it to `.rsa/timeline/`, while `action.py:Action` continuously reads the timeline and issues control inputs during an `auto` period. The capability decorators and timeline envelope conventions are covered in [Workspace and Capability Programming](workspace.md).

All CLI commands below run in the **target workspace directory**, assuming the repo's `rsa/bin` and `baseware/bin` are on `PATH`. For cross-directory operation, pass `rsa --workspace /absolute/path/to/workspace` before the subcommand.

## Resident Perception and History Reads

### 1. `perception.py:Perception` Lifecycle

The `Perception` class in `perception.py` runs in a dedicated resident Python process (template: [rsa/templates/perception.py](../../rsa/templates/perception.py)):

- `start(self, context)`: runs once when the process starts or on `reload`; load deep-learning weights, initialize state, or start background sampling threads here. `context` contains `workspace`, `runDir`, and `generation`.
- `sample(self)`: must be annotated with `@record` and `@capability`, and is called continuously by the scheduler at the class attribute `sample_hz` (default `30.0` Hz, which also serves as the nominal frame rate for recording). If a single sample takes longer than one period, the next sample is deferred rather than overlapping concurrently or catching up with a backlog.
- `close(self)`: called on `reload`, `stop`, or Host exit to release self-owned resources.

A new workspace's `Perception.sample()` raises `NotImplementedError` by default; the system never substitutes a default screenshot for unimplemented perception. After editing `perception.py` (including adjusting `sample_hz` or model weights), run `rsa perception reload` to hot-swap the process while keeping the historical timeline.

### 2. Perception Management and History Query Commands (`rsa observe`)

```sh
# Lifecycle and auto-inject policy management
rsa perception status
rsa perception reload
rsa perception stop
rsa perception inject          # Show current auto-inject policy (on / off)
rsa perception inject off      # Stop auto-appending observations to model context, keep sampling and recording
rsa perception inject on       # Resume auto-appending

# Read timeline history (archived records only, never triggers resampling)
rsa observe
rsa observe --id <record-id> --images
rsa observe --at 2026-10-27T01:00:00Z
rsa observe --capability python/sensors.py:temperature
rsa observe --capability '*' --start 2026-10-27T01:00:00Z --limit 8
```

- **Sampling decoupled from auto-injection**: `rsa perception inject off` only stops auto-appending new observations and sampler state to the model at each prompt start and tool-batch end; background `sample()`, video recording, and explicit `observe` queries keep running. `rsa perception stop` halts the sampling process and timeline writer entirely until the next `reload`.
- **Query dimensions and pagination**: reads the latest record of the main channel `python/perception.py:Perception.sample` by default; `--capability` filters by another `@record` capability or takes `'*'` to query the whole timeline; `--at` returns the last record with `recordedAt` no later than the given time; `--start` / `--end` paginate in ascending `recordedAt` order over a closed interval (default `8` records, max `64`; pass the returned `nextAfter` to `--after` for the next page).
- **Terminal image delivery**: adding `--images` in the agent's `bash` tool delivers images straight into the model through the OMP terminal image channel (max 32 images / 40 MiB per page).

### 3. Query Result Shape and Error Codes

CLI `rsa observe`, Python `Client().observe(query)`, and the OMP-native `observe` tool return the same structured envelope `{queryId, ok, query, records, hasMore, nextAfter?, availability?, error?}`. When `ok: false`, `error.code` distinguishes the cause:

| Error code | Trigger |
| --- | --- |
| `NOT_READY` | Querying the latest record, but the selected capability has not produced a usable sample yet; also returned while the main channel is still loading. |
| `NOT_FOUND` | The specified `--id` does not exist, or there is no matching record before the `--at` time. |
| `EXPIRED` | A time or range query touches an evicted non-persistent window and no readable record is returned (if a range query is only partially expired but still has readable records, it returns `ok: true` with `availability.expired = true` marked). An unknown `--id` always returns `NOT_FOUND` and is never assumed to have existed. |
| `UNAVAILABLE` | The perception process (timeline writer) has stopped or was replaced during the query, or the latest main-channel sampler is unavailable (e.g. loading or sampling failure). While the writer is still running, explicit history queries are unaffected by sampler faults. |
| `QUERY_FAILED` | Illegal arguments, disk read errors, or cold video-frame decode failures. |

### 4. Timeline Storage and Encoding-Budget Environment Variables

The host process supports the following environment variables for timeline windows and video encoding parameters (the effective values are visible in the `history` field of `rsa perception status`):

| Environment variable | Default | Description |
| --- | --- | --- |
| `RSA_PERCEPTION_PERSIST` | `1` | When set to `0` (or `false`), only the in-memory/temporary hot window is kept and is cleared when the process stops or on `reload`. |
| `RSA_PERCEPTION_HOT_SECONDS` | `600` | Seconds retained per channel in the hot window (10 minutes); originals in the window are deliverable directly from memory; overridable by workspace settings. |
| `RSA_PERCEPTION_HOT_BYTES` | `1073741824` | Global byte budget for the hot window (1 GiB); the largest channel shrinks first under pressure. |
| `RSA_PERCEPTION_SEGMENT_SECONDS` | `3600` | Rotation interval for timeline metadata JSONL and index files (1 hour). |
| `RSA_PERCEPTION_SEGMENT_BYTES` | `268435456` | Byte cap per segment for metadata and non-video media (256 MiB). |
| `RSA_VIDEO_SEGMENT_SECONDS` | `300` | MP4 video segment duration (5 minutes); overridable by workspace settings. |
| `RSA_VIDEO_IDLE_SECONDS` | `10` | Idle finalization seconds after sampling stops; overridable by workspace settings; also finalizes when `sample_hz` changes or the process stops. |
| `RSA_VIDEO_QUEUE_BYTES` | `33554432` | Memory cap for the background video-encoding queue (32 MiB, including compressed input and RGB buffers). |
| `RSA_VIDEO_QUEUE_FRAMES` | `64` | Maximum pending frames in the background video-encoding queue. |
| `RSA_VIDEO_STREAMS` | `16` | Cap on simultaneously active image-encoding streams (least-recently-used stream is finalized first when exceeded). |
| `RSA_VIDEO_QUERY_BYTES` | `33554432` | Decoded-output byte cap per cold history query (32 MiB). |

The workspace `.rsa/settings.json` may override `hotSeconds`, `videoSegmentSeconds`, and `videoIdleSeconds`, with precedence: settings file > host environment variables > built-in defaults. Dashboard’s Perception page edits these saved overrides independently of the running process. Use exact integer seconds, presets, or the optional slider; choosing inheritance removes that field’s override. Inherited values are not presented as known runtime defaults. Valid positive custom values already in the file, including fractions or values beyond the editor range, remain visible and unchanged until that field is edited. Byte budgets remain controlled by environment variables.

Drafts are separated by workspace identity and registered path, kept in the current browser tab, and can be discarded explicitly. When browser session storage is available, a page reload also restores them; otherwise only the current page lifetime is retained. Reading saved settings preserves unfinished input. Saving writes only changed fields and does not reload perception. A response that cannot be confirmed keeps the draft and offers a read to check the saved values rather than repeating the write. Requests include the expected workspace path, so an old draft cannot silently write to a newly relocated registration.

After saving, copy the page’s workspace-specific `env -u RSA_SOCKET rsa --workspace '/absolute/workspace/path' perception reload` command and run it when appropriate. Clearing an inherited `RSA_SOCKET` ensures the command targets this workspace’s canonical host. Then use **Check running values** for a separate, read-only host status request. Current values require a ready perception process with an identified generation, PID, and complete loaded settings; stopped or incomplete observations never prove application. The page compares explicit saved overrides against the observed values, while inherited fields show the observed value without guessing its environment/default source. A timestamped check is an observation, not continuous monitoring or proof that a later save has been applied. Registered workspaces without a running host can still be configured.

Video uses fragmented MP4 (`+frag_keyframe+empty_moov`), with roughly one keyframe interval every two seconds of sampled volume. In an unfinalized segment, fully persisted fragments are readable; the newest not-yet-persisted frames are explicitly reported as unreadable rather than substituted with neighboring frames. Each segment's `.mp4.json` publishes readable progress of complete fragments via `readableBytes`, `lastReadablePts` (microsecond PTS), `durationSeconds`, and `frames`, updated to final values on finalization. Dashboard playback reads in fixed byte ranges and loads new fragments after playing past the current range; when no frame is readable yet it waits for progress updates instead of treating the error state as a successful fragment. The hot window expires by time and shrinks the largest channel first when over budget; queries in non-persistent mode report evicted history gaps, and `rsa perception status`'s `history.budgetEvictions` updates live with the current process.

## Resident Actions

The `Action` class in `action.py` runs in a dedicated resident Python process during an `auto` control period (template: [rsa/templates/action.py](../../rsa/templates/action.py)):

- **Method contract**: `start(self, context)` initializes once on takeover or reload (`context` contains `workspace`, `runDir`, `generation`, `epoch`); `step(self)` is annotated with `@capability` (add `@record` if decisions should be archived to the timeline) and runs in a loop at the class attribute `step_hz` (default `30.0` Hz); `close(self)` releases resources.
- **Reading perception and issuing actions**: inside `Action`, use `self.device = Client()` to call `self.device.observe()` for the latest or historical perception records, and `self.device.call("controller/...", {...})` to issue device commands. After an async `pad.play` submission there is no need to block synchronously within a single step; later `step()` calls can observe and decide concurrently.
- **Lifecycle management**:

```sh
rsa action status
rsa action reload
rsa action stop
```

- **Control-ownership and input-reset boundary**: the action process is strictly bound to the `epoch` and `inputGeneration` from its start. On human handoff (`auto off`), budget exhaustion, or device disconnect, the action process terminates and releases device input. When `rsa action stop`, `rsa action reload`, or an uncaught exception from `step()` occurs during `auto`, the system **stops the action loop and resets all current device inputs of this workspace (including concurrent CLI-submitted keys/touches in the same period)**; after the release completes it keeps the current control `epoch`, the OMP session, and the remaining budget; if the release cannot be confirmed, control is handed back. After fixing the code, run `rsa action reload` to re-enable actions, and if control was already handed back, run `rsa auto on` again.
