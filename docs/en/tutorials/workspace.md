# Workspace and Capability Programming

A Workspace is an ordinary coding workspace evolved jointly by the agent and developers: perception and control code can be written in it, skills and memory accumulated, datasets collected and models trained, without modifying the Harness or Driver sources in the repo.

All CLI commands below run in the **target workspace directory** (assuming the repo's `rsa/bin` and `baseware/bin` are on `PATH`). For environment setup and service lifecycle see [Installation and Workspace Lifecycle](quickstart.md); the resident `perception.py` and `action.py` implementations are covered in [Resident Perception and Action Loops](perception-and-action.md).

## Files and Sessions

### 1. Workspace Directory Layout

Global state and workspaces form two layers. `LUDENS_HOME` defaults to `~/.ludens` and does not move with a source checkout. It holds application configuration, rebuildable indexes, shared caches, and pet state:

```text
~/.ludens/                  # Override with LUDENS_HOME
├── config.json             # {version: 1, workspaceRoot: absolute, defaults: {...}}
├── registry/<id>.json      # {id, workspace, name, updatedAt}, a pointer to the workspace
├── cache/drivers/          # External driver installation cache
├── logs/baseware/          # Standalone Baseware logs without --data-dir
├── pet/
│   ├── target.json         # Stable workspace ID followed by the pet
│   ├── consumer.json       # Pet consumer heartbeat
│   ├── profile/            # Electron preferences and local cache
│   └── background/         # Shared pet background logs
└── workspaces/             # Initial workspaceRoot; configurable to any absolute path
```

Each workspace owns its runtime state. Preserve the whole directory when moving or backing it up:

```text
workspace/
├── rsa.json                 # Local service startup config (driver, ports, model, budget)
├── AGENTS.md                # Optional workspace-specific conventions (loaded via OMP native contextFiles)
├── baseware.json            # Device capability and parameter schema snapshot auto-exported after connecting a device
├── perception.py            # Resident workspace perception entry point (Perception class)
├── action.py                # Resident workspace action entry point (Action class)
├── skills/<name>/SKILL.md   # Reusable skill docs and helper scripts
├── memory/current.md        # Current goals, status, and next steps
├── .rsa/
│   ├── workspace.json       # {version: 1, id: "ws-UUID"}, persistent identity
│   ├── settings.json        # Optional workspace perception hot-window and video segment parameter overrides
│   ├── skill-versions/      # Historical skill and memory content snapshots
│   ├── timeline/            # Cross-run shared @record capability records, MP4 video segments, and deduped media originals
│   ├── archive/             # Content-addressed JSON archive of model and tool logs (media references timeline)
│   └── shiori/
│       ├── sessions/        # OMP session JSONL files and their same-named resource directories
│       └── current-session.json # Default session-resume pointer
└── logs/
    ├── <run-id>/            # Event, stream, and scoring records for a single Host run or Benchmark trial
    └── background/          # launchd background service logs and status
```

### 2. Templates and Session Lifecycle

- **Init templates**: `rsa init --name <name> --driver <id>` creates a workspace below the global default parent; pass `--workspace <path>` for an explicit directory. It creates missing [AGENTS.md](../../rsa/templates/AGENTS.md), [perception.py](../../rsa/templates/perception.py), and [action.py](../../rsa/templates/action.py) templates. Global `defaults` are copied into the new `rsa.json`; later global changes do not affect it. `AGENTS.md` may be freely edited or deleted and is never force-restored on later starts; restart the Host after editing it for changes to take effect.
- **Workspace identity**: the ID in `.rsa/workspace.json` is persistent and is not derived from the directory name or path. After moving a workspace, run `rsa workspace open <new-path>` to update the global index. Use `open <copy-path> --new-id` for an independent copy, assigning a new identity and clearing the current session selection. Past sessions, skill versions, recordings, and logs remain in the workspace. Rebuild a lost registry with `open`; `forget <id>` removes only its index entry. Old directories need explicit [import](quickstart.md#registering-and-migrating-existing-workspaces).
- **Session resume**: restarting the Host resumes the previous OMP session via `.rsa/shiori/current-session.json` by default; `rsa run --new-session` starts a new session while keeping all workspace code and files, and `--resume <session.jsonl>` resumes a specified historical session under the same workspace.
- **Skills and memory**: `skills/<name>/SKILL.md` uses YAML frontmatter with `name` and `description`. The agent reads and writes skills and memory on demand through the OMP-native `read` / `write` / `edit` tools; RSA does not re-push a full file index on every model request.

## Discovering and Calling Capabilities

### 1. Unified Capability Catalog (`rsa controller`)

Device-native controllers (from Baseware) and workspace-declared Python capabilities (via `@capability`) share one catalog entry point:

```sh
# List all current device capabilities and workspace Python capabilities
rsa controller list

# Show a single capability's input/output JSON Schema and control-ownership requirements
rsa controller controller/pad.play --help
rsa controller python/perception.py:Perception.sample --help

# Pass a full JSON argument object via --args or --file to invoke a call
rsa controller controller/screen.top.capture --args '{}'
rsa controller python/scripts/nav.py:move_to --file ./move-args.json
```

- `controller/<name>`: provided by the currently connected Baseware Driver. The Host writes the latest catalog snapshot to the workspace `baseware.json` at startup (run `baseware export` at any time to refresh it).
- `python/<relative-path.py>:<function or Class.method>`: provided by the `@capability` decorator in workspace Python code, discovered via static AST scanning — signatures and descriptions are queryable without starting any process.

### 2. Declaring Python Capabilities and the Four Call Styles

Declare and call capabilities in workspace Python code with `rsa_tools`:

```python
from rsa_tools import Client, capability

@capability
def capture_top(exposure: int = 1) -> dict:
    """Capture the top screen with documented typed parameters."""
    return Client().call("controller/screen.top.capture", {})
```

`@capability` works on both top-level sync functions and methods (e.g. `Perception.sample`, `Action.step`). Static discovery scans workspace code (skipping `logs/`, `.rsa/`, `.git/`, and virtual environments) and requires marked functions to have a **docstring** and **explicit parameter type annotations** (scalars, `list`, `dict[str, ...]`, and `Optional` are supported); top-level sync functions plus `Perception.sample` / `Action.step` are included in the `rsa controller list` catalog. Implementation details: [_capabilities.py](../../rsa/python/rsa_tools/_capabilities.py).

How the call entry points differ in execution location and data boundary:

| Call style | Executing process | Arguments and return values | When to use |
| --- | --- | --- | --- |
| Plain Python `import` call | Current Python process | Native Python objects (PyTorch models, NumPy arrays, etc.) | High-performance composition inside the workspace, sharing in-process models and caches |
| `Client().call("python/...", {...})` | Current Python process | Arguments validated against the capability schema, imported and called in the current process | Dispatching local Python capabilities dynamically by catalog ID without the Host spawning a new subprocess |
| `rsa controller python/... --args '{...}'` | One-shot Python subprocess started by the Host | Cross-process JSON serialization; the subprocess exits after the call and keeps no in-memory state | Agent triggering a single Python capability from the command line via the native `bash` tool |
| `Client().call("controller/...", {...})` or `rsa controller controller/...` | Forwarded to Baseware via RSA | JSON argument object, returning an `ExecutionResult` with the native `result` and media bytes | Driving device inputs or collecting sensor/screen data |

## Capability Archiving and the Workspace Timeline

### 1. The `@record` Decorator and the Record Envelope

A function marked only with `@capability` returns a plain Python result and writes no permanent archive to disk. When a perception or action result should be persisted to the workspace timeline, stack the `@record` decorator on top (`@record` and `@capability` may appear in either order, but `@record` must be used together with `@capability`):

```python
from rsa_tools import capability, record

@record
@capability
def detect_scene() -> dict:
    """Extract structured scene state and retain the frame on the timeline."""
    return {
        "text": "Title screen ready",
        "data": {"menu": "start", "cursor": 0},
        "media": [{"mediaType": "image/png", "path": "latest.png"}],
        "space": {"frame": "top_screen", "width": 400, "height": 240},
    }
```

An `@record` function's return value must be a dict envelope containing only the following known fields (all optional; unknown fields raise an error):

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | `str` | Short text description for the model and the console. |
| `data` | Any JSON-serializable value | Structured state data (used when expanding record details or reading from code). |
| `media` | `list[dict]` | Media list, each item either `{"mediaType": "...", "path": "..."}` (workspace-relative path supported) or `{"mediaType": "...", "data": "<base64>"}` (the `data` returned by a device screenshot can be passed through directly). |
| `sampledAt` | `str` (ISO timestamp) | Known source sampling time (omit to keep only the record-completion time `recordedAt`). |
| `sources` | `list` | Source references derived from other observations or nested records. |
| `space` | `dict` | Coordinate-system description defined by the device or algorithm. |

### 2. Single Writer and Media Archiving

Whether an `@record` function is called in the resident process, via a plain `import`, or from the CLI, computation runs in the caller's own Python process; the result is then handed over the RSA socket to the resident perception worker — the **single timeline writer** — for persisting, and the returned envelope carries `timeline: {recordId, sequence}` plus media `asset` references (if the perception writer is not running or the write fails, the call raises explicitly instead of silently swallowing the error or auto-retrying the action):

- **Images flow into fMP4 video segments**: images are written to fragmented MP4 segments under `.rsa/timeline/video/` (5 minutes per segment by default, finalized after 10 idle seconds), addressed precisely via `{pts, timeBase, width, height}` in `timeline.video`; the hot window keeps in-memory originals for realtime delivery, and cold history queries decode from video segments on demand.
- **Content-addressed non-video media**: audio, binaries, and other media are deduplicated by SHA-256 hash under `.rsa/timeline/objects/<sha256>.bin`.

For continuous sampling via the resident `perception.py`, querying the timeline with `rsa observe`, configuring `.rsa/settings.json`, and writing the resident `action.py`, continue with [Resident Perception and Action Loops](perception-and-action.md).

## Background Programs and Human Handoff

- **OMP-native background tasks**: long-running training, data analysis, or helper scripts can use the OMP-native `bash` tool's async tasks (`async`) or named services (`name`) directly; inspect status with `read proc://`, terminate with `write proc://<id>/kill`, or wait with `wait`.
- **Control-lease isolation**: on every `rsa auto on`, the RSA plugin injects the latest `BASEWARE_EPOCH` into the native shell environment. A background program only holds the `epoch` from when it started; once a human handoff or control period ends, the old `epoch` is invalidated immediately — even if the background process is still doing local computation, it can no longer send any input commands to the device, nor request a new `epoch` on its own.
