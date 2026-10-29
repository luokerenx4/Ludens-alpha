# Install & workspace lifecycle

This guide covers installing the Ludens components, configuring the Python runtime, and managing the day-to-day workspace lifecycle with `rsa init / up / auto / down`. For emulator and desktop driver setup, see [Devices & driver setup](devices.md); for single-component foreground debugging, package script conventions, and tests, see [Console debugging & verification](debugging-and-verification.md).

Unless a `cd` into the target workspace is shown explicitly, run all commands from the repository root. `../artifacts/` is a local build-and-runtime state directory outside the repository; workspaces, ROMs, firmware, keys, and save files all live outside the repo and never enter the source tree.

## Install

### 1. Environment prerequisites & credentials

- **OS**: full background-service orchestration (`rsa up` / `rsa down` / `rsa services`) requires **macOS launchd**.
- **Toolchain**: **Bun 1.4**, **Python 3.12+**, **Node.js 22.x (22.13+) or 24+**, and **uv**. The optional pet additionally requires **pnpm 11**.
- **Model credentials**: complete **OMP model login** on the machine before starting an agent. RSA pins **OMP 18.9.1** and reuses its credential store directly; the default model is `openai-codex/gpt-6.1-sol`.

### 2. Install core components

Install Baseware, RSA, and the web Dashboard by default; each component and the RSA Python runtime keeps its own lockfile. When installing `rsa`, Bun automatically applies the OMP dependency patches under [rsa/patches/](../../rsa/patches/) per `package.json`:

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
uv sync --project rsa/python --frozen
(cd rsa-dashboard && npm ci && npm run build)

export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PATH"
```

`export PATH` only affects the current terminal; configure your shell profile in new terminals or use the absolute `baseware/bin/baseware` and `rsa/bin/rsa` paths.

### 3. Python runtime resolution

[rsa/python/pyproject.toml](../../rsa/python/pyproject.toml) and `uv.lock` manage the official `ludens-rsa` package (import name `rsa_tools`) plus media and validation dependencies such as PyAV, Pillow, and jsonschema. `rsa_tools` only provides capability declarations, the client, and experiment-registration helpers; the execution lifecycle and scoring are managed centrally by Shiori.

The framework picks a Python interpreter with this priority:

1. Explicit `RSA_PYTHON` environment variable;
2. In-repo virtualenv `rsa/python/.venv/bin/python`;
3. System `python3` on `PATH`.

The OMP native shell injects `RSA_PYTHON` automatically. To reuse `rsa_tools` and the framework dependencies in workspace scripts, call `"$RSA_PYTHON" script.py`; running a bare `python3` follows the user's login shell and is not equivalent to the framework virtualenv. If you point `RSA_PYTHON` at an external training environment (e.g. a conda/venv with PyTorch), pre-install the `rsa/python` package and its dependencies there.

`rsa up` preserves the `RSA_PYTHON` from the current environment when creating new background services. If services are already running, changing the terminal environment does not update them; stop and restart the relevant services before the new interpreter takes effect.

## Optional pet

The Dashboard is served in a browser by default — no Electron install is needed to run games or view the console. For Ludens Pet, prepare **pnpm 11** and run from the repository root:

```sh
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)
```

When creating a workspace, append `--pet` to the chosen `rsa init --driver ...` command to explicitly enable the pet. For an existing workspace, set `"pet": true` in `rsa.json`; it starts on the next `rsa up`. An explicit `pet: true` already in the file stays enabled. Setting `"pet": false` keeps later starts on the web console only.

You can also use `rsa up --pet` or `rsa up --no-pet` to override just the current start without writing back to `rsa.json`; the two flags are mutually exclusive. Neither `pet: false` nor `--no-pet` shuts down an already-running shared pet — quit it from its tray menu.

The pet needs a working Dashboard and shares the same console and logs as the browser. By default `dashboard: true` starts the Dashboard on demand; with `false` you must start it yourself. For standalone startup or debugging, see [Ludens Pet desktop companion](debugging-and-verification.md).

## Starting and stopping workspaces

### 1. Init and lifecycle commands

Prepare the target environment per [Devices & driver setup](devices.md) first, then create a directory outside the repository as the workspace. The example below uses Azahar with an explicitly pinned external driver package; mGBA and Ryubing use their respective [optional packages](devices.md#discovering-connecting-external-driver-packages), and the built-in desktop driver uses `--driver cua`:

```sh
mkdir -p /absolute/path/to/workspace
cd /absolute/path/to/workspace

rsa init --driver azahar \
  --driver-package github:luokerenx4/ludens-3ds-driver#5b9b1f4032a5973a8882aa23957c3c34da50af9e \
  --game /absolute/path/to/game.3ds --seconds 1800
rsa up --dry-run
rsa up
rsa services
rsa controller list
rsa auto on
```

For an existing emulator workspace, add `driverPackage` per the [external driver migration notes](devices.md#discovering-connecting-external-driver-packages) instead of re-running `rsa init`. The default launch path comes from each driver's build cache; when reusing an already-installed app, pass `RSA_AZAHAR_APP` or `RSA_RYUBING_APP` on every `up` (including `--dry-run`).

Quick reference for common workspace and control commands:

| Command | Behavior & boundaries |
| --- | --- |
| `rsa init` | Generates `rsa.json` plus any missing `AGENTS.md`, `perception.py`, and `action.py` templates; never overwrites existing files. Uses the web console by default; add `--pet` to explicitly enable the installed pet. |
| `rsa up --dry-run` | Validates the config and prints the full process start plan without starting services; the Dashboard build check only runs on a real `rsa up` when a new Dashboard is needed. |
| `rsa up [--pet / --no-pet]` | Starts or reuses the emulator, Baseware, Host, and Dashboard on demand; enables the pet per the `pet` setting, or override just this start with the mutually exclusive `--pet` / `--no-pet` without writing back to the config. A newly started Host is in `manual` mode; reusing an already-`auto` Host continues its control cycle. Repeating `up` does not hot-reload an edited `rsa.json`, and reusing an existing Dashboard does not hot-update its build. |
| `rsa services` | Shows the PID, status, and latest exit code of the launchd tasks bound to the current workspace. |
| `rsa auto on [--message 'text']` | Starts a new control cycle (new `epoch`, resetting time and request budgets) and issues inference to the model. `--message` is attached once on the first round of that takeover only, never re-injected in later rounds. |
| `rsa auto off` | Immediately revokes device operation rights and cancels in-flight RSA-managed calls; the emulator keeps running. Wait for the current cycle to finish cleaning up before `auto on` again. |
| `rsa action status / reload / stop` | Manages the workspace `action.py` resident action process. Under `manual`, `reload` only marks readiness; under `auto`, `stop` or `reload` clears all current device inputs for this workspace (including concurrent CLI inputs). A successful release keeps the current `epoch`, OMP session, and remaining budget. See [Resident perception & action loop](perception-and-action.md#resident-actions). |
| `rsa down --keep-emulator` | Hands back control and stops Host and Baseware, keeping the emulator window and game state; suitable for re-running `rsa up` after editing `rsa.json` (e.g. budgets or model). |
| `rsa down [--dashboard] [--pet]` | Stops this workspace's managed Host, Baseware, and emulator (**save in-game progress first**). The shared Dashboard and a running Ludens Pet are kept by default; append `--dashboard` (only from the workspace that started it) or `--pet` to shut down the corresponding shared service too. |

To operate on a workspace from another directory, prefix any command with `rsa --workspace /absolute/path/to/workspace <subcommand>` or set the `RSA_WORKSPACE` environment variable.

### 2. `rsa.json` reference

`rsa.json` is parsed and validated by [rsa/src/app/workspace.ts](../../rsa/src/app/workspace.ts); unknown fields are hard errors:

| Field | Default | Description |
| --- | --- | --- |
| `driver` | required | Driver ID; only `cua` is built in, emulator IDs must match the `id` exported by the external package. |
| `driverPackage` | none | External driver package address (npm spec, `github:org/repo#rev`, or `file:path`); required for emulator drivers, omittable for `cua`. See [Devices & driver setup](devices.md#discovering-connecting-external-driver-packages) for how to connect. |
| `game` | none | Optional for bridge drivers that support auto-launch (path relative to the workspace); omit to attach to an already manually started emulator. The `mgba` and stdio drivers reject this field. |
| `port` | per driver | An explicit port wins; otherwise the driver manifest's `defaultPort` applies (current external packages: mGBA `47653`, Ryubing `47663`, Azahar `47673`); stdio drivers do not use it. |
| `cuaCommand` | `"cua-driver"` | Only valid for stdio drivers; specifies the backend executable path or command name. |
| `model` | `"openai-codex/gpt-6.1-sol"` | OMP `provider/model` identifier with image-input support. |
| `seconds` | `1800` | Time budget (seconds) per `auto on` control cycle, reset on each takeover. |
| `requests` | `1000` | Model request cap per `auto on` control cycle; whichever of `seconds`/`requests` runs out first hands back control. |
| `compactionThreshold` | unset | OMP context-compaction trigger threshold (tokens); follows the selected model's native OMP threshold (`contextWindow - reserve`) when omitted. |
| `dashboard` | `true` | Whether `rsa up` ensures the local Dashboard service is running. |
| `pet` | `false` | Whether `rsa up` starts the shared Ludens Pet; requires the optional component installed and an available Dashboard. `rsa init --pet` writes `true`, an existing explicit `true` is left alone; `rsa up --pet` / `--no-pet` override only the current start. |
| `logging.diagnostics` | `"normal"` | Log verbosity, `"normal"` or `"full"`; see [Recording modes](../reference/logging.md#recording-modes). |

### 3. Session resumption & background service directories

- **Session resumption**: workspace OMP sessions live in `.rsa/shiori/sessions/`, with the current resume pointer at `.rsa/shiori/current-session.json`. Restarting Host resumes the original session by default and opens a new `logs/<run-id>/` directory. Foreground `rsa run` accepts `--new-session` to start a fresh context (keeping workspace files), or `--resume /absolute/path/to/session.jsonl` to switch to a given historical session of the same workspace.
- **Background service logs**: [launch-background.py](../../rsa/scripts/launch-background.py) writes the stdio and launchd state of workspace-managed processes to `<workspace>/logs/background/`; the shared Ludens Pet logs live in `../artifacts/rsa/alice/background/` next to the repo (launchd label `dev.ludens.pet`). All background services run detached from the terminal, with no boot-time autostart or crash-loop restarts; when troubleshooting, check `rsa services` and the corresponding `logs/background/` logs first.
