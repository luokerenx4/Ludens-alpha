# Benchmark

The Ludens evaluation system follows the [Harbor Framework](https://github.com/harbor-framework/harbor/tree/f3a5a923f6d722472c9e797af836ae4425fb215f) (pinned reference `f3a5a9`, Schema `1.4`) Task, Verifier, Reward, and Dataset file conventions, and implements a `ludens-native` Profile for the local experiment environment.

The core architectural principle is **a single execution kernel with decoupled judging**: every evaluation task is uniformly scheduled, budgeted, and cancelled/cleaned up by **Shiori**; the program under test only produces objective facts (Artifacts) at runtime, and an independent `tests/test.sh` Verifier computes the numeric Reward from the already-persisted artifacts. Regrading (`verify`) only runs the Verifier and never re-runs the program or model under test.

## Entry points and run ownership

### 1. Full `rsa bench` CLI command set

Run `rsa bench --help` under the target workspace to see all subcommands:

```sh
# Discovery, help, and static contract checks
rsa bench list
rsa bench help ludens/ws-recovery
rsa bench schema [task|reward|dataset]
rsa bench validate task /path/to/task
rsa bench validate reward /path/to/verifier-or-reward.json
rsa bench validate dataset /path/to/dataset.toml

# Run evaluations and independent regrades
rsa bench run ludens/ws-recovery [--config run.json] [--args '{"k":"v"}'] [--seconds 60] [--repeat 3] [--no-verify]
rsa bench verify <run-id> --reason "Regrade fixed measurements"
rsa bench verify <run-id> --task /path/to/updated-task --reason "Updated grading criteria"

# History queries, single-run details, version comparison, and dataset aggregation
rsa bench history [namespace/task] [--limit 20]
rsa bench get <run-id[@verification-id]>
rsa bench verifications <run-id>
rsa bench compare <run-id[@verification-id]> <baseline-run-id[@verification-id]>
rsa bench aggregate <dataset.toml> <run-id-1> <run-id-2> --policy all|graded
```

- **Exit-code semantics**: `rsa bench run` returns `0` when execution completes with a valid score (including a score of `0`); `1` when the program under test fails; `2` when execution succeeds but the Verifier is missing or scoring fails.
- **Static checks**: `schema` prints the built-in `ludens-native` contract guide (`guideOnly: true`); `validate` checks file structure and fields with a static parser and never executes task code or Verifier scripts.

### 2. Run bindings

A Harbor task package only describes "what is tested and how it is scored"; "what program runs" is declared by a separate JSON run configuration (Run Binding). The system auto-scans configurations from the repo's `rsa/benchmarks/runs/` and the workspace's `<workspace>/benchmarks/runs/`, associating each with its Task via the JSON `"task"` field (a task with a single binding uses it as the default; otherwise `--config <path>` is required):

```json
{
  "task": "my-org/example",
  "argv": ["{python}", "{workspace}/benchmarks/measure.py", "--out", "{artifacts}"],
  "workspace": "isolated",
  "seconds": 30
}
```

Placeholders and execution semantics supported by run configurations:

| Placeholder / field | Resolved value and bounds |
| --- | --- |
| `{rsa}` / `{python}` / `{bun}` | RSA package root (`rsa/` in the repo), the selected framework Python interpreter (`RSA_PYTHON`), and the Bun executable path. |
| `{workspace}` | Absolute path of the author's own workspace. |
| `{workdir}` | The trial's actual execution directory (a freshly created isolated directory per trial when `workspace: "isolated"`). |
| `{artifacts}` | The trial's exclusive artifact output directory (`logs/<run-id>/artifacts`). |
| `{task}` / `{param.<key>}` | The pinned Task directory path for this trial, plus merged values of default `parameters` and CLI `--args`. |
| `Shiori execution mode` | Plain commands run in Shiori `program` mode with no model started; tasks needing Agent participation (e.g. `ludens/capability-reuse`) mount the full OMP, Controller, and perception loop through the shared [host.ts](../../rsa/src/harness/host.ts). Budgets are timed by the outer Runtime (including startup time), with at most a 2-second grace period to write out facts on expiry. |

## Tasks and datasets

### 1. Task directory structure and content digest

Built-in tasks live in `rsa/benchmarks/tasks/`; workspace-custom tasks in `<workspace>/benchmarks/tasks/`:

```text
benchmarks/tasks/example/
├── task.toml          # Harbor 1.4 task metadata (required)
├── instruction.md     # Task description and goal (required)
├── environment/       # Input materials, fixed fixtures, or dependency declarations (required)
├── tests/
│   ├── test.sh        # Sole entry-point script for independent scoring (required)
│   └── verify.py      # Scoring implementation called by test.sh (optional; TS also works)
└── solution/          # Optional reference solution (never run as the program under test)
```

Minimal `task.toml` example:

```toml
schema_version = "1.4"

[task]
name = "my-org/example"
version = "1"
description = "Measure a capability on fixed examples."
```

- **Naming and content-addressed pinning**: `ludens-native` requires `task.name` in `org/name` namespace form. Shiori computes a deterministic `sha256:<64 hex chars>` content digest per the Harbor published-file selection rules: at the root it selects `task.toml`, `instruction.md`, optional `README.md`, and `trajectory.json`, then scans `environment/`, `tests/`, `solution/`, `steps/` applying `.gitignore` / `.harborignore` exclusion rules (see [task.ts](../../rsa/src/benchmark/task.ts)). Before the run, the selected files are snapshotted and pinned to `<workspace>/.rsa/benchmarks/tasks/<hex part of digest>/`.
- **Execution-provenance separation**: tested external scripts or model weights are not part of the Task package digest; Shiori automatically records Git commit/dirty state, actual `argv`, budgets, and model identity in `input.json` and `manifest.json`, or the program under test explicitly registers them via `current_trial().subject(...)`.

### 2. Dataset manifest (`dataset.toml`)

Datasets use the Harbor `1.0` format, pinning the task set by task name and exact `sha256` digest (built-in manifest in [rsa/benchmarks/dataset.toml](../../rsa/benchmarks/dataset.toml)):

```toml
schema_version = "1.0"

[dataset]
name = "my-org/suite"
version = "1"

[[tasks]]
name = "my-org/example"
digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

After modifying any built-in task file, the corresponding `digest` in `dataset.toml` must be updated in sync; the system never silently uses a same-named task whose digest mismatches.

## Python helper registration is optional

A Python program under test only needs to read the `RSA_BENCH_ARTIFACTS` environment variable and write measurement files (e.g. `measurements.json`) to complete a trial — importing any framework package is not required. For structured registration of experiment conditions, tested model versions, or automatic collection of in-process `@capability` call statistics, `rsa_tools.current_trial()` is available (full example in [clamp.py](../../rsa/benchmarks/examples/clamp.py)):

```python
from rsa_tools import current_trial

trial = current_trial()  # Reads RSA_BENCH_* env vars; raises outside a Shiori trial environment
trial.conditions(dataset_revision="v3", seed=7)
trial.subject("model", path="weights.pt", revision="epoch-12")
samples = measure(already_loaded_model, dataset)
trial.artifact("measurements.json", samples)
trial.limitations("Only daylight samples were measured.")
trial.flush()
```

- **Responsibility boundary**: `current_trial()` only generates `artifacts/context.json` in the artifact directory (with `conditions`, `subjects`, `artifacts`, `limitations`, plus in-process `@capability` call counts and `codeSHA` captured by the local observer) — it takes over no device and writes no Shiori event stream.
- **Artifact and media references**: `trial.artifact("name.json", value)` writes a new JSON file (overwriting a same-named file is forbidden); `trial.artifact(external_path)` copies an external file by content hash; for already-recorded `.rsa/timeline/` media, passing `trial.artifact(media)` verifies and registers the original reference and video PTS without copying image or video bytes again.

## Facts, scoring, and regrading

### 1. Verifier environment variables and the `reward.json` contract

When Shiori starts `tests/test.sh`, it clears live device sockets, control `epoch`, and model-credential environment variables, and injects these four path variables. The Native Profile runs plain local processes; `isolated` only allocates a separate execution directory — env cleanup provides no filesystem or network isolation.

| Environment variable | Target path and purpose |
| --- | --- |
| `RSA_BENCH_TASK_DIR` | Pinned task-package directory used for this scoring (`.rsa/benchmarks/tasks/<hex part of digest>/`). |
| `RSA_BENCH_INPUT` | This scoring's input manifest JSON (with trial metadata and evidence path references). |
| `RSA_BENCH_ARTIFACTS` | The program under test's `logs/<run-id>/artifacts/` directory for the scorer to read facts from; no read-only filesystem permission is imposed. |
| `RSA_BENCH_VERIFIER_DIR` | This scoring's exclusive output directory (`logs/<run-id>/verifier/<verification-id>/`). |

`tests/test.sh` writes the final numeric score to `$RSA_BENCH_VERIFIER_DIR/reward.json` (optionally writing detailed diagnostics to `details.json` in the same directory):

```json
{"accuracy": 0.94, "latency_ms": 12.3, "success": 1}
```

- **Flat finite-number map**: `reward.json` must be a flat `Record<string, number>` with all values finite numbers (no `0..1` range restriction, no preset `passed` field); an empty object parses but provides no scored dimension and cannot mark the task successful. A single-value `reward.txt` is readable, but JSON wins when `reward.json` exists.
- **Missing dimensions**: unmeasurable metric dimensions should be omitted from the object with the reason explained in `details.json`; writing `null`, `NaN`, or padding with fake `0` is forbidden. When the whole Verifier fails or produces no legal file, the projected `verifier_result.rewards` is `null`.

### 2. Multi-version regrade, compare, and dataset aggregation

- **Lossless regrade (`rsa bench verify`)**: each `verify` run appends an independent scoring record under `verifier/<new-verification-id>/` and atomically advances the current-default verification pointer after scoring; a failed scoring still becomes the current version — the previous score is never auto-restored. The original execution state (`trial.json`) and historical scoring versions are fully kept. With `--task <new-task-dir>`, the new task package is pinned and a new scoring-Task digest recorded, while the trial keeps its original execution-Task identity.
- **Two-trial compare (`rsa bench compare`)**: compares two trials (or two scoring versions of one trial, `run-id@ver-id`) on task digests, parameters, `conditions`, `subjects`, and numeric dimension deltas. Deltas are computed only for metrics present on both sides; missing dimensions stay missing, never zero-filled; differing experiment conditions or tested versions are explicitly flagged rather than claimed as capability gains.
- **Dataset aggregation (`rsa bench aggregate`)**: statistics over an explicitly selected trial set. By default grouped per task as `byTask` (Harbor mean semantics: missing or `null` counts as `0`, with `total / valid / error` counts); if the Dataset declares a custom `metric.py` (taking `-i <JSONL> -o <JSON>`), its file digest is verified and the script is called to compute cross-task aggregate metrics. `--policy all` keeps all selected trials; `--policy graded` explicitly drops trials with no valid score and records the reason.

## Files and display

Full on-disk layout of one Benchmark run under `workspace/logs/<run-id>/`:

```text
workspace/logs/<run-id>/
├── manifest.json                  # Runtime environment, Git provenance, and external event-source registration
├── input.json                     # Actual argv, cwd, budgets, and parameters executed
├── trial.json                     # Shiori-submitted terminal execution state and artifact references
├── events.jsonl                   # Run and scoring lifecycle events written by Shiori
├── stdout.log / stderr.log        # Tested program stdout and stderr
├── artifacts/                     # measurements.json, optional context.json, etc. produced by the program under test
└── verifier/<verification-id>/    # One subdirectory per independent scoring
    ├── input.json                 # Input manifest for this scoring
    ├── verification.json          # Scoring Task summary, status, timing, and error info
    ├── reward.json                # Sole authoritative numeric score record
    ├── details.json               # Optional task-private diagnostic details
    └── stdout.log / stderr.log    # Verifier script output
```

The CLI and Dashboard Benchmark views read the `Trial + Verification + Reward` triple directly, showing each dimension's numeric score, `details.json` diagnostics, and execution/scoring logs, with one-click run-command copy and baseline switching for comparison in the UI.

In **Benchmark → Eval catalog**, an empty task catalog links to the task guide; a task without runs offers its version-bound terminal command. History filters match task names across versions; the selected digest binds the command, not the history filter. Empty filtered results and an empty older page offer separate reset actions. Missing or malformed run and baseline links can be retried or cleared without discarding the task selection; pinned history remains readable after a task leaves the current catalog. Browsing, refreshing, following guides, and copying commands never start an evaluation or invoke a model.

## Built-in tasks and evidence boundaries

The repo ships 8 standard evaluation tasks (defined in `rsa/benchmarks/tasks/` and `rsa/src/benchmark/cases/`):

| Task name | Mode and object under test | Core metrics and evidence boundary |
| --- | --- | --- |
| `ludens/perception-lifecycle` | Offline · real Python + synthetic media | Resident sampling, `reload` hot update, history queries, fault recovery, and archive immutability (no real emulator or GPU model). |
| `ludens/control-handoff` | Offline · real Runtime / Baseware + mock driver | Human-takeover interrupt latency, input-zeroing release, and strict rejection of stale `epoch`. |
| `ludens/ws-recovery` | Offline · real Codex Provider + mock transport and virtual clock | Connection-limit expiry, `1012` disconnect backoff, SSE recovery, full-history WS reconnect, and no replay of submitted tools. |
| `ludens/background-compaction` | Offline · native OMP Maintenance + controlled stream | Background candidate summaries retained and reused after context growth, lossless tail-message replay, Span ownership, and cancel interruption (pinned 256k threshold fixture). |
| `ludens/capability-reuse` | **Online model** · shared Host assembly + isolated synthetic workbench | Agent autonomously writes functions from empty-skills/empty-perception initial state, with genuinely effective reuse across order batches and across model rounds. |
| `ludens/clamp` | Offline · plain Python program | Output and per-call latency of an already-loaded Python `@capability` function over sample computations. |
| `ludens/video-storage` | Offline · dual-stream synthetic images + PyAV encoder | MP4 video segment encode throughput, cold-frame decode accuracy from history, and process RSS memory. |
| `ludens/index-memory` | Offline · isolated cache dir + Dashboard Builder | Cold-history index-builder subprocess peak memory, query pagination accuracy, and cache release after exit (not a substitute for production Next.js load tests). |

**`ludens/capability-reuse` reuse-evidence rule**: its independent scorer [evaluate.ts](../../rsa/benchmarks/tasks/capability-reuse/tests/evaluate.ts) judges only from recorded runtime event streams and audit facts, never by re-running workspace code. Valid reuse requires the same self-authored Python function to be genuinely called in **two independent order batches** across **different model-inference rounds**, producing environment-accepted successful device terminal states; merely creating files, merely `import`ing without calling, or only doing an AST static inventory after the task ends does not count toward the reuse score.
