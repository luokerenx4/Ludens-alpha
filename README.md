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
- **Inspect what actually happened.** The console shows model inputs, activity, tool results, timing, and linked device calls. Alice provides a desktop companion view of the same run data.
- **Measure changes.** Built-in reliability cases and workspace-defined `@benchmark` functions share a result format, history, and baseline comparisons.

These are mechanisms for experimenting with adaptation, not a claim that an agent will learn a particular game or generalize to new tasks.

## Supported environments

| Driver | Environment | Setup |
| --- | --- | --- |
| mGBA | Game Boy Advance emulator | Open a ROM and load the bundled Lua bridge. See [RSA setup](rsa/README.md). |
| Ryubing | Nintendo Switch emulator | Build and install the patched emulator. See the [Ryubing guide](baseware/src/drivers/ryubing/README.md). |
| Azahar | Nintendo 3DS emulator | Build and install the patched emulator. Native pad, touch, and separate top/bottom screen capture. See the [Azahar guide](baseware/src/drivers/azahar/README.md). |
| Cua | Local desktop applications | Install the upstream Cua Driver and grant its required OS permissions. See [Baseware setup](baseware/README.md). |

Drivers expose device capabilities, not game strategies. Screen processing, coordinate conversion, action sequences, and task-specific logic belong in the workspace.

## Quick start

### 1. Prepare the prerequisites

- **macOS** for `rsa up`, `rsa down`, and `rsa services`, which use launchd.
- **Bun 1.4**, **Python 3.9+**, **Node.js 22+**, and **pnpm 11**.
- Local **OMP model credentials** configured before starting the agent. RSA reuses OMP authentication; the default model is `openai-codex/gpt-6.1-sol`.
- One prepared environment from the table above. ROMs, firmware, keys, and saves are not included.

For component-level startup and model configuration, see the [RSA guide](rsa/README.md).

### 2. Install the components

Each component has its own dependency lockfile.

```sh
git clone https://github.com/luokerenx4/Ludens-alpha.git
cd Ludens-alpha

(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
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

`rsa init` creates `rsa.json` and starter workspace files. `rsa up --dry-run` prints the launch plan without starting services. `rsa up` starts or reuses Baseware, the agent host, the Dashboard, and Alice. A newly started host remains in manual mode.

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

Save your game before closing its emulator. Shared Dashboard and Alice processes remain running by default; see the [RSA lifecycle guide](rsa/README.md) for shutdown options and configuration changes.

## How it works

Ludens separates the device, the agent runtime, and the code the agent develops.

| Component | Responsibility |
| --- | --- |
| [Baseware](baseware/README.md) | Device drivers, observations, control leases, and CLI / API / MCP access. |
| [RSA](rsa/README.md) | Agent lifecycle, persistent sessions, workspace capabilities, perception, benchmarks, and logging. |
| [Dashboard](rsa-dashboard/README.md) | A local web console for live runs, run analysis, benchmarks, and Alice settings. |
| [Alice companion](rsa-companion/README.md) | An Electron shell loading the same console, plus the native desktop pet, tray, and audio. |

RSA's agent loop is called **Shiori**; its current implementation uses **OMP 18.9.1**. The agent uses OMP's native coding and process-management tools. Device and workspace capabilities are discovered through the CLI rather than automatically added to the model's tool list.

### The workspace is ordinary code

A workspace lives outside the source checkout:

```text
my-task/
├── rsa.json          # Launch configuration
├── AGENTS.md         # Optional workspace instructions
├── baseware.json     # Generated device capability and parameter reference
├── perception.py     # Persistent, workspace-owned perception
├── skills/           # Reusable methods and supporting scripts
├── memory/           # Current goals, state, and next steps
└── logs/             # Run records, model inputs, and diagnostics
```

Use `@capability` to make a typed Python function discoverable through `rsa controller`. Normal imports and Python capability calls run in the current process, so they can reuse loaded models and state. Separate CLI calls do not share memory. Discovery reads source without importing it; already-loaded Python code needs a process restart to pick up edits.

Perception has its own `start(context)`, `observe()`, and `close()` lifecycle. The workspace chooses what to sample, how to process it, and whether to run a background loop. Use `rsa perception reload` after changing its code or weights.

Workspace files and sessions persist across runs. Shared workspace indexes and session data live under `<repo>/../artifacts/rsa/`; device builds also live outside the checkout. See the [RSA guide](rsa/README.md) for the full directory and execution contracts.

### Benchmarks

Run benchmarks from a workspace:

```sh
rsa bench list
rsa bench run perception-lifecycle
rsa bench help capability-reuse
```

The built-in cases cover perception lifecycle, control handoff, WebSocket recovery, background compaction, and capability reuse. Each run selects one case explicitly; read its help first. The capability-reuse case uses a real model in an isolated test environment.

Workspace functions marked with `@benchmark` can report metrics and checks through the same interface. Inspect results in the console or use `rsa bench history` and `rsa bench compare`. Execution status and pass/fail verdicts are separate: a completed call is not evidence of task success. See the [Benchmark guide](rsa/benchmarks/README.md).

## Development

Run the component checks from the repository root:

```sh
(cd baseware && bun run check && bun test)
(cd rsa && bun run check && bun test)
(cd rsa-dashboard && npm test && npm run typecheck)
(cd rsa-companion && pnpm typecheck && pnpm test)
```

The default checks use offline fixtures. Live model and device tests require explicit opt-in. Component guides document those tests; [AGENTS.md](AGENTS.md) describes the architecture and development conventions.

To work on the console alone, run `npm run dev` in `rsa-dashboard/`. It can display an empty state without starting a model or emulator. The desktop shell connects to the same local Dashboard.

## Boundaries and safety

- **Local, trusted execution.** The agent can run shell commands and Python on the host. A workspace is not an OS security boundary.
- **Shared desktop.** Cua workspaces operate on the same real desktop. Use separate OS sessions or VMs when you need independent environments. An in-flight native action may finish during cancellation and cleanup.
- **Explicit control.** Device input requires a current control lease. Returning control invalidates that lease; background programs follow OMP's lifecycle and may remain alive without device input permission.
- **Data and privacy.** The console binds to localhost, but model inputs are sent to your configured model provider. Local run logs can contain requests, tool output, and screenshots; review them before sharing.
- **No bundled task knowledge.** The project does not ship game strategies or promise task success. Device connectivity, successful API calls, and benchmark results have different meanings.

## Documentation

- [RSA: startup, workspace APIs, perception, and sessions](rsa/README.md)
- [Baseware: drivers, discovery, and device control](baseware/README.md)
- [Architecture](rsa/docs/architecture.md)
- [Benchmark guide](rsa/benchmarks/README.md)
- [Logging contract](rsa/docs/logging.md)
- [Dashboard](rsa-dashboard/README.md)
- [Alice companion](rsa-companion/README.md)

The detailed guides currently include both English and Chinese documentation.

## License and attribution

A repository-wide license has not yet been declared. Alice's retained [license](rsa-companion/LICENSE), [provenance record](rsa-companion/upstream.json), and [asset notices](rsa-companion/ui/public/companion/NOTICE.md) document the companion's existing licensing and sources; they are not a repository-wide license declaration.

