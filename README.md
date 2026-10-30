# Ludens

**A workspace-first agent system for games and interactive environments.**

Ludens explores recursive self-adaptation: give an agent access to an environment and a regular coding workspace, then let it build the perception, tools, and reusable skills it needs. The agent can write Python, keep models and state in memory, and turn repeated actions into callable functions without changing the agent runtime.

The project combines local device control, a persistent agent session, workspace-defined perception, and a shared console for inspecting runs and comparing benchmarks.

**Status:** intended for local experimentation. The integrated service launcher currently requires macOS. Device setup is manual, and the workspace is a trusted local coding environment, not a sandbox.

[Quick start](#quick-start) · [Supported environments](#supported-environments) · [How it works](#how-it-works) · [Documentation](#documentation)

## What you can do

- **Use one interface across environments.** Discover device controls and workspace Python capabilities through `rsa controller`, with parameters available on demand.
- **Let the agent build its own perception.** A persistent `perception.py` process can retain models, state, and background sampling between observations.
- **Reuse code and experience.** Ordinary Python imports and `rsa_tools.Client` support in-process composition; `skills/` and `memory/` persist across runs.
- **Inspect what actually happened.** The console shows model inputs, activity, tool results, timing, and linked device calls. Ludens Pet provides a desktop companion view of the same run data.
- **Measure changes.** Repository and workspace Harbor tasks share Shiori execution, independent verifiers, and the same result/history interface.

These are mechanisms for experimenting with adaptation, not a claim that an agent will learn a particular game or generalize to new tasks.

## Supported environments

| Driver | Environment | Setup |
| --- | --- | --- |
| mGBA | GBA emulator | Open a ROM and load the optional driver package's Lua bridge. See [mGBA setup](docs/en/tutorials/devices.md#mgba). |
| Ryubing | Switch emulator | Build and install the patched emulator. See the [Ryubing guide](docs/en/tutorials/devices.md#ryubing). |
| Azahar | 3DS emulator | Build and install the patched emulator. Native pad, touch, and separate top/bottom screen capture. See the [Azahar guide](docs/en/tutorials/devices.md#azahar). |
| Cua | Local desktop applications | Install the upstream Cua Driver and grant its required OS permissions. See [Cua setup](docs/en/tutorials/devices.md#cua). |

Emulator drivers are optional external packages (`ludens-gba-driver`, `ludens-3ds-driver`, and `ludens-switch-driver`). Only the Cua desktop adapter is built in.

Drivers expose device capabilities, not game strategies. Screen processing, coordinate conversion, action sequences, and task-specific logic belong in the workspace.

## Quick start

### 1. Prepare the prerequisites

- **macOS** for `rsa up`, `rsa down`, and `rsa services`, which use launchd.
- **Bun 1.4**, **Python 3.12+**, **Node.js 22.x (22.13 or later) or 24+**, and **uv**. The optional desktop pet also requires **pnpm 11**.
- Local **OMP model credentials** configured before starting the agent. RSA reuses OMP authentication; the default model is `openai-codex/gpt-6.1-sol`.
- One prepared environment from the table above. ROMs, firmware, keys, and saves are not included.

For device preparation and model configuration, see [Devices & Drivers](docs/en/tutorials/devices.md) and [Installation & Quickstart](docs/en/tutorials/quickstart.md).

### 2. Install the components

The default setup uses Baseware, RSA and the browser Dashboard. Each component has its own dependency lockfile. RSA includes a TypeScript host and a packaged Python runtime; `uv sync` installs the latter into `rsa/python/.venv`.

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
uv sync --project rsa/python --frozen
(cd rsa-dashboard && npm ci && npm run build)

export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PATH"
```

The PATH setting applies to the current shell. Keep using that shell for the commands below, or add the absolute bin paths to your shell configuration.

### 3. Create a workspace

The example below uses a prepared Ryubing installation and a local game file. Global settings live in `~/.ludens` (override with `LUDENS_HOME`), independently of the source checkout.

```sh
rsa init --name my-task --workspace "$HOME/Ludens Workspaces/my-task" --driver ryubing \
  --driver-package 'github:<org>/ludens-switch-driver#<rev>' \
  --game /absolute/path/to/game.nsp --seconds 1800
cd "$HOME/Ludens Workspaces/my-task"
rsa up --dry-run
rsa up
rsa services
```

`rsa init` creates `rsa.json`, a persistent `.rsa/workspace.json` identity, and starter workspace files, then registers the workspace. Omit `--workspace` to create `--name` under the configured `workspaceRoot` (initially `$LUDENS_HOME/workspaces`). `rsa up --dry-run` prints the launch plan without starting services. `rsa up` starts or reuses Baseware, the agent host and the Dashboard. A newly started host remains in manual mode. New workspaces use the browser console by default; Ludens Pet is optional.

To choose another environment, replace the `rsa init` command above with exactly one of:

```sh
rsa init --name my-task --workspace "$HOME/Ludens Workspaces/my-task" --driver mgba --driver-package 'github:<org>/ludens-gba-driver#<rev>'
rsa init --name my-task --workspace "$HOME/Ludens Workspaces/my-task" --driver azahar --driver-package 'github:<org>/ludens-3ds-driver#<rev>' --game /absolute/path/to/game.3ds
rsa init --name my-task --workspace "$HOME/Ludens Workspaces/my-task" --driver cua
```

Use a new workspace. mGBA needs its ROM and Lua bridge loaded first. Cua does not use a game path; use `--cua-command /absolute/path/to/cua-driver` if the executable is not on PATH. Detailed setup is linked in [Supported environments](#supported-environments).

Use `rsa config show` to inspect global creation defaults and `rsa config set workspaceRoot /absolute/path` to change the parent for future workspaces. Reopen an existing workspace with `rsa workspace open /absolute/path`; list registered workspaces with `rsa workspace list`. `rsa workspace forget <id>` only removes the registry entry. Workspaces retain their identity and history when moved; copied experiments require `rsa workspace open /path/to/copy --new-id`. Older workspaces use the explicit [import command](docs/en/tutorials/quickstart.md#registering-and-migrating-existing-workspaces).

### 4. Inspect and start

Open [http://127.0.0.1:3015](http://127.0.0.1:3015) for the shared console. Discover the connected device before handing over control:

```sh
rsa controller list
rsa auto on
```

`rsa auto on` starts model requests and grants the agent device control. The default budget is 30 minutes or 1,000 model requests per control cycle, whichever comes first. Repeated cycles keep the same session history.

A new workspace starts with an unimplemented `perception.py`. The agent receives a text prompt to implement it and load it with `rsa perception reload`; there is no automatic screenshot fallback.

To return control or stop services, choose one of these commands:

```sh
rsa auto off              # Return device control; keep services running
rsa down --keep-emulator  # Stop the host and Baseware; keep the game open
rsa down                  # Also stop the workspace-managed emulator
```

Save your game before closing its emulator. The shared Dashboard and any running Ludens Pet remain open by default; see the [lifecycle guide](docs/en/tutorials/quickstart.md#starting-and-stopping-workspaces) for shutdown options and configuration changes.

### 5. Optional desktop pet

The browser Dashboard works without Electron. To add Ludens Pet, install **pnpm 11** and run the following from the repository root:

```sh
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)
```

For a new workspace, append `--pet` to the selected `rsa init` command above. For an existing workspace, set `"pet": true` in `rsa.json` before `rsa up`; existing explicit `pet: true` settings remain enabled. Set `"pet": false` to use the browser without starting the pet on subsequent launches.

For a single launch, `rsa up --pet` or `rsa up --no-pet` overrides that setting without changing `rsa.json`; the two flags cannot be combined. Neither `pet: false` nor `--no-pet` quits an already running shared pet; use its tray menu to quit. See [optional pet setup](docs/en/tutorials/quickstart.md#optional-pet).

## How it works

Ludens separates the device, the agent runtime, and the code the agent develops.

| Component | Responsibility |
| --- | --- |
| [Baseware](baseware/README.md) | Device drivers, observations, control leases, and CLI / API / MCP access. |
| [RSA](rsa/README.md) | Agent lifecycle, persistent sessions, workspace capabilities, perception, benchmarks, and logging. |
| [Dashboard](rsa-dashboard/README.md) | A local web console for live runs, timeline replay, run analysis, benchmarks, and Ludens Pet settings. |
| [Ludens Pet companion](rsa-companion/README.md) | Optional Electron shell loading the same console, plus the native desktop pet, tray, and audio. |

RSA uses **Shiori** as its sole runner. Agent execution uses **OMP 18.9.1**; ordinary benchmark programs, verifiers and metrics use the same budget and cancellation lifecycle without model calls. The agent uses OMP's native coding and process-management tools. Device and workspace capabilities are discovered through the CLI rather than automatically added to the model's tool list.

### The workspace is ordinary code

A workspace lives outside the source checkout. `~/.ludens/config.json` holds application defaults; `~/.ludens/registry/<id>.json` is a rebuildable index pointing to each workspace. Sessions, recordings and history travel with the workspace:

```text
my-task/
├── rsa.json          # Launch configuration
├── AGENTS.md         # Optional workspace instructions
├── baseware.json     # Generated device capability and parameter reference
├── perception.py     # Persistent, workspace-owned perception
├── action.py         # Persistent control program while auto is active
├── skills/           # Reusable methods and supporting scripts
├── memory/           # Current goals, state, and next steps
├── .rsa/             # Stable identity, sessions, skill snapshots, timeline and archive
└── logs/             # Run records, model inputs, and diagnostics
```

The agent can compose Python functions, retain models in its separate perception and action processes, and manage background programs with OMP's native tools. Workspace files and sessions persist across runs; separate CLI invocations do not share memory. See [Workspace & Capabilities](docs/en/tutorials/workspace.md) and [Resident Perception & Action](docs/en/tutorials/perception-and-action.md) for unified `@capability` functions, optional `@record`, resident lifecycle, and storage locations.

### Benchmarks

Run benchmarks from a workspace:

```sh
rsa bench list
rsa bench run ludens/perception-lifecycle
rsa bench help ludens/capability-reuse
```

The built-in cases cover perception lifecycle, control handoff, WebSocket recovery, background compaction, and capability reuse. Each run selects one case explicitly; read its help first. The capability-reuse case uses a real model in an isolated test environment.

Harbor Task packages describe the evaluation; separate run configurations select the program. Programs write facts, and `tests/test.sh` writes numeric rewards. `rsa bench verify` regrades fixed evidence without rerunning the program. Inspect results in the console or use `rsa bench history` and `rsa bench compare`. Execution and verification status are separate; a completed call does not prove task success. See the [Benchmark guide](docs/en/reference/benchmark.md).

## Development

Follow [AGENTS.md](AGENTS.md) for development conventions and [Console, Debugging & Verification](docs/en/tutorials/debugging-and-verification.md) for component startup and checks. Each component retains its own lockfile. Default checks are offline; live model and device tests are explicit.

## Boundaries and safety

- **Local, trusted execution.** The agent can run shell commands and Python on the host. A workspace is not an OS security boundary.
- **Shared desktop.** Cua workspaces operate on the same real desktop. Use separate OS sessions or VMs when you need independent environments. An in-flight native action may finish during cancellation and cleanup.
- **Explicit control.** Device input requires a current control lease. Returning control invalidates that lease; background programs follow OMP's lifecycle and may remain alive without device input permission.
- **Data and privacy.** The console binds to localhost, but model inputs are sent to your configured model provider. Local run logs can contain requests, tool output, and screenshots; review them before sharing.
- **No bundled task knowledge.** The project does not ship game strategies or promise task success. Device connectivity, successful API calls, and benchmark results have different meanings.

## Documentation

Current documentation lives in `docs/en/` (English) and `docs/zh/` (Chinese), split into `tutorials/` (how to run), `reference/` (components and contracts), and `insights/` (why things are the way they are). Component READMEs only link here.

| Guide | Category | Contents |
| --- | --- | --- |
| [Tutorials Overview](docs/en/tutorials/index.md) | Tutorials | End-to-end onboarding path and common operational workflows. |
| [Quickstart](docs/en/tutorials/quickstart.md) | Tutorials | Installation, `RSA_PYTHON` runtime, `rsa.json`, and workspace lifecycle (`init / up / auto / down`). |
| [Devices & Drivers](docs/en/tutorials/devices.md) | Tutorials | Preparing `mGBA`, `Ryubing`, `Azahar`, `Cua`, and external driver packages. |
| [Workspace & Capabilities](docs/en/tutorials/workspace.md) | Tutorials | Workspace layout, `@capability` / `@record`, `.rsa/timeline/`, and background programs. |
| [Perception & Action](docs/en/tutorials/perception-and-action.md) | Tutorials | Resident `perception.py` & `action.py` loops, `rsa observe`, and context injection. |
| [Debugging & Verification](docs/en/tutorials/debugging-and-verification.md) | Tutorials | Standalone component debugging, Dashboard & Ludens Pet, and offline/live test suites. |
| [Reference Overview](docs/en/reference/index.md) | Reference | System layers, contract index, and source-of-truth code map. |
| [Architecture](docs/en/reference/architecture.md) | Reference | Component boundaries, Shiori, control leases, OMP session loop, and storage ownership. |
| [Baseware](docs/en/reference/baseware.md) | Reference | CUA native capability contract, driver boundaries, control arbitration, media, and external driver packages. |
| [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md) | Reference | TCP line protocol (`HELLO` / `OWN` / `APPLY` / `TOUCH` / `CAPTURE`) for emulator bridges. |
| [Logging](docs/en/reference/logging.md) | Reference | Event envelopes, timeline/archive storage, trace attribution, Dashboard cold/hot indexing, and replay. |
| [Dashboard UI](docs/en/reference/dashboard-ui.md) | Reference | shadcn/ui primitives, Tailwind CSS 4 theme tokens, responsive layouts, and interaction rules. |
| [Benchmark](docs/en/reference/benchmark.md) | Reference | Harbor 1.4 native profile, run bindings, `current_trial()`, independent verifiers, and built-in tasks. |
| [Insights Overview](docs/en/insights/index.md) | Insights | Index of engineering decisions, production postmortems, and empirical measurements. |
| [OMP Compaction](docs/en/insights/omp-compaction.md) | Insights | Why and how OMP speculative compaction was patched for real-time control with continuous 30Hz perception. |
| [WS Recovery](docs/en/insights/ws-recovery.md) | Insights | 2026-10-20 Codex WebSocket recovery TDD rationale and 13-condition fault matrix. |
| [OMP Injection](docs/en/insights/omp-injection.md) | Insights | Why end-of-batch screenshot injection was removed in favor of turn-start delivery and explicit `observe`. |

English guides live in `docs/en/` with Chinese counterparts in `docs/zh/`. Runtime prompts, workspace templates, and license notices remain beside the files that consume them.

## License and attribution

Ludens is licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices. Dependencies and optional community drivers retain their own licenses.

