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
| mGBA | Game Boy Advance emulator | Open a ROM and load the bundled Lua bridge. See [mGBA setup](docs/development.md#mgba). |
| Ryubing | Nintendo Switch emulator | Build and install the patched emulator. See the [Ryubing guide](docs/development.md#ryubing). |
| Azahar | Nintendo 3DS emulator | Build and install the patched emulator. Native pad, touch, and separate top/bottom screen capture. See the [Azahar guide](docs/development.md#azahar). |
| Cua | Local desktop applications | Install the upstream Cua Driver and grant its required OS permissions. See [Cua setup](docs/development.md#cua). |

Drivers expose device capabilities, not game strategies. Screen processing, coordinate conversion, action sequences, and task-specific logic belong in the workspace.

## Quick start

### 1. Prepare the prerequisites

- **macOS** for `rsa up`, `rsa down`, and `rsa services`, which use launchd.
- **Bun 1.4**, **Python 3.12+**, **Node.js 22+**, **pnpm 11**, and **uv**.
- Local **OMP model credentials** configured before starting the agent. RSA reuses OMP authentication; the default model is `openai-codex/gpt-6.1-sol`.
- One prepared environment from the table above. ROMs, firmware, keys, and saves are not included.

For device preparation and model configuration, see the [development guide](docs/development.md).

### 2. Install the components

Each component has its own dependency lockfile. RSA includes a TypeScript host and a packaged Python runtime; `uv sync` installs the latter into `rsa/python/.venv`.

```sh
git clone https://github.com/luokerenx4/Ludens-alpha.git
cd Ludens-alpha

(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
uv sync --project rsa/python --frozen
(cd rsa-dashboard && npm ci)
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)

export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PWD/rsa-companion/bin:$PATH"
```

The PATH setting applies to the current shell. Keep using that shell for the commands below, or add the absolute bin paths to your shell configuration.

### 3. Create a workspace

The example below uses a prepared Ryubing installation and a local game file.

```sh
mkdir -p ../workspaces/my-task
cd ../workspaces/my-task

rsa init --driver ryubing --game /absolute/path/to/game.nsp --seconds 1800
rsa up --dry-run
rsa up
rsa services
```

`rsa init` creates `rsa.json` and starter workspace files. `rsa up --dry-run` prints the launch plan without starting services. `rsa up` starts or reuses Baseware, the agent host, the Dashboard, and Ludens Pet. A newly started host remains in manual mode.

To choose another environment, replace the `rsa init` command above with exactly one of:

```sh
rsa init --driver mgba
rsa init --driver azahar --game /absolute/path/to/game.3ds
rsa init --driver cua
```

Use a new workspace. mGBA needs its ROM and Lua bridge loaded first. Cua does not use a game path; use `--cua-command /absolute/path/to/cua-driver` if the executable is not on PATH. Detailed setup is linked in [Supported environments](#supported-environments).

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

Save your game before closing its emulator. Shared Dashboard and Ludens Pet processes remain running by default; see the [lifecycle guide](docs/development.md#工作区启动与停止) for shutdown options and configuration changes.

## How it works

Ludens separates the device, the agent runtime, and the code the agent develops.

| Component | Responsibility |
| --- | --- |
| [Baseware](baseware/README.md) | Device drivers, observations, control leases, and CLI / API / MCP access. |
| [RSA](rsa/README.md) | Agent lifecycle, persistent sessions, workspace capabilities, perception, benchmarks, and logging. |
| [Dashboard](rsa-dashboard/README.md) | A local web console for live runs, timeline replay, run analysis, benchmarks, and Ludens Pet settings. |
| [Ludens Pet companion](rsa-companion/README.md) | An Electron shell loading the same console, plus the native desktop pet, tray, and audio. |

RSA uses **Shiori** as its sole runner. Agent execution uses **OMP 18.9.1**; ordinary benchmark programs, verifiers and metrics use the same budget and cancellation lifecycle without model calls. The agent uses OMP's native coding and process-management tools. Device and workspace capabilities are discovered through the CLI rather than automatically added to the model's tool list.

### The workspace is ordinary code

A workspace lives outside the source checkout:

```text
my-task/
├── rsa.json          # Launch configuration
├── AGENTS.md         # Optional workspace instructions
├── baseware.json     # Generated device capability and parameter reference
├── perception.py     # Persistent, workspace-owned perception
├── action.py         # Persistent control program while auto is active
├── skills/           # Reusable methods and supporting scripts
├── memory/           # Current goals, state, and next steps
└── logs/             # Run records, model inputs, and diagnostics
```

The agent can compose Python functions, retain models in its separate perception and action processes, and manage background programs with OMP's native tools. Workspace files and sessions persist across runs; separate CLI invocations do not share memory. See the [workspace contract](docs/workspace.md) for unified `@capability` functions, optional `@record`, resident lifecycle, and storage locations.

### Benchmarks

Run benchmarks from a workspace:

```sh
rsa bench list
rsa bench run ludens/perception-lifecycle
rsa bench help ludens/capability-reuse
```

The built-in cases cover perception lifecycle, control handoff, WebSocket recovery, background compaction, and capability reuse. Each run selects one case explicitly; read its help first. The capability-reuse case uses a real model in an isolated test environment.

Harbor Task packages describe the evaluation; separate run configurations select the program. Programs write facts, and `tests/test.sh` writes numeric rewards. `rsa bench verify` regrades fixed evidence without rerunning the program. Inspect results in the console or use `rsa bench history` and `rsa bench compare`. Execution and verification status are separate; a completed call does not prove task success. See the [Benchmark guide](docs/benchmark.md).

## Development

Follow [AGENTS.md](AGENTS.md) for development conventions and the [development guide](docs/development.md) for component startup, checks, and the WS recovery test rationale. Each component retains its own lockfile. Default checks are offline; live model and device tests are explicit.

## Boundaries and safety

- **Local, trusted execution.** The agent can run shell commands and Python on the host. A workspace is not an OS security boundary.
- **Shared desktop.** Cua workspaces operate on the same real desktop. Use separate OS sessions or VMs when you need independent environments. An in-flight native action may finish during cancellation and cleanup.
- **Explicit control.** Device input requires a current control lease. Returning control invalidates that lease; background programs follow OMP's lifecycle and may remain alive without device input permission.
- **Data and privacy.** The console binds to localhost, but model inputs are sent to your configured model provider. Local run logs can contain requests, tool output, and screenshots; review them before sharing.
- **No bundled task knowledge.** The project does not ship game strategies or promise task success. Device connectivity, successful API calls, and benchmark results have different meanings.

## Documentation

Current documentation lives in the root `docs/` directory. Component READMEs only link here.

| Guide | Contents |
| --- | --- |
| [Baseware](docs/baseware.md) | CUA native capability contract, driver boundaries, control, media, and upstream snapshots. |
| [Architecture](docs/architecture.md) | Component boundaries, Shiori, control flow, and extension points. |
| [Development](docs/development.md) | Installation, device setup, service lifecycle, verification, and WS test provenance. |
| [Workspace](docs/workspace.md) | Configuration, Python capabilities, perception, and agent-owned programs. |
| [Logging](docs/logging.md) | Events, model inputs, trace attribution, performance metrics, and console consumers. |
| [Benchmark](docs/benchmark.md) | Cases, execution records, reports, comparison, and workspace benchmarks. |

The original [unified console](docs/history/unified-console/prd.html) and [benchmark](docs/history/benchmarks/prd.html) design records are archived under `docs/history/`; they describe past decisions, not the current API. Detailed guides are currently in Chinese. Runtime prompts, workspace templates, and license notices remain beside the files that consume them.

## License and attribution

A repository-wide license has not yet been declared. Ludens Pet's retained [license](rsa-companion/LICENSE), [provenance record](rsa-companion/upstream.json), and [asset notices](rsa-companion/ui/public/companion/NOTICE.md) document the companion's existing licensing and sources; they are not a repository-wide license declaration.

