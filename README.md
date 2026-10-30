# Ludens

**A multimodal agent harness for complex tasks through self-adaptation and self-improvement.**

Ludens connects agents to arbitrary PC desktops and console environments, giving them a persistent coding workspace to adapt to unfamiliar interfaces and continuously improve how they act. Instead of relying on static prompts or fixed action spaces, a Ludens agent writes and refines its own resident perception (`perception.py`), control loops (`action.py`), and reusable skills (`skills/`) directly in Python.

**Games** are the first flagship class of complex, real-time multimodal tasks we tackle—spanning local PC applications and console emulators—backed by a unified device control plane, a live observability console, and reproducible Harbor benchmarks.

[Quick start](#quick-start) · [Supported environments](#supported-environments) · [Architecture](#architecture) · [Documentation](#documentation)

## Why Ludens

- **Plug into any PC or console environment.** Discover device controls and workspace Python capabilities through a unified `rsa controller` interface, with parameters inspected on demand.
- **Self-adaptation in a real workspace.** Resident `perception.py` and `action.py` processes keep models, state, and high-frequency sampling in memory across turns without modifying the agent runtime.
- **Continuous self-improvement.** Agents turn repeated interaction patterns into callable `@capability` functions, compose tools via `rsa_tools.Client`, and persist experience in `skills/` and `memory/`.
- **Full-trace observability.** Inspect model inputs, tool calls, timing, and linked device actions in the web Dashboard or optional Ludens Pet desktop companion.
- **Measurable progress.** Evaluate adaptation and skill reuse with Harbor task packages, Shiori execution budgets, and independent verifiers (`rsa bench`).

## Supported environments

| Driver | Environment | Setup |
| --- | --- | --- |
| **Cua** | Local PC desktop & applications | Built-in adapter. Install the upstream Cua Driver and grant OS permissions ([Cua setup](docs/en/tutorials/devices.md#cua)). |
| **External Drivers** | Game emulators & custom runtimes | Plug in any external driver package (`--driver-package`) or implement the [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md). |

Drivers only expose raw device capabilities (screen capture, input events, control leases); perception, coordinate mapping, and task logic live in the workspace.

## Quick start

### 1. Prerequisites & installation

Requires **macOS** (for `launchd` service management), **Bun 1.4**, **Python 3.12+**, **Node.js 22.13+ / 24+**, **uv**, and configured local **OMP model credentials** (default model: `openai-codex/gpt-6.1-sol`).

```sh
(cd baseware && bun install --frozen-lockfile)
(cd rsa && bun install --frozen-lockfile)
uv sync --project rsa/python --frozen
(cd rsa-dashboard && npm ci && npm run build)

export PATH="$PWD/baseware/bin:$PWD/rsa/bin:$PATH"
```

### 2. Initialize and launch a workspace

Create a workspace for your local PC desktop (`--driver cua`, or attach an external driver package via `--driver-package`):

```sh
rsa init --name my-task --driver cua
cd "$HOME/.ludens/workspaces/my-task"
rsa up
rsa controller list
rsa auto on
```

Open [http://127.0.0.1:3015](http://127.0.0.1:3015) for the web console. `rsa auto on` grants the agent a device control lease and starts autonomous execution. On a fresh workspace, the agent initializes `perception.py` and loads it via `rsa perception reload`.

To pause or shut down:

```sh
rsa auto off  # Return device control; keep services running
rsa down      # Stop workspace-managed services
```

For workspace management, multi-driver options, and the optional **Ludens Pet** desktop companion (`rsa-companion`), see the [Quickstart guide](docs/en/tutorials/quickstart.md).

## Architecture

Ludens separates device access, the agent harness, and the workspace code evolved by the agent:

| Component | Responsibility |
| --- | --- |
| [Baseware](baseware/README.md) | Device drivers, screen/audio observation, control leases, and CLI / API / MCP access. |
| [RSA](rsa/README.md) | Agent harness powered by **Shiori** and **OMP 18.9.1**: session lifecycle, resident perception/action, benchmarks, and logging. |
| [Dashboard](rsa-dashboard/README.md) | Local web console for live runs, timeline replay, trace analysis, and benchmark comparison. |
| [Ludens Pet](rsa-companion/README.md) | Optional Electron companion shell, native desktop pet, tray controls, and audio. |

Each workspace is a standalone code directory outside the repository (`~/.ludens/workspaces/<name>` by default):

```text
my-task/
├── rsa.json          # Workspace & driver launch configuration
├── baseware.json     # Generated device capability reference
├── perception.py     # Resident, agent-authored perception process
├── action.py         # Resident control loop while auto is active
├── skills/           # Reusable @capability functions and scripts
├── memory/           # Task goals, state, and learned knowledge
└── .rsa/ & logs/     # Session identity, timeline archives, and run logs
```

## Boundaries and safety

- **Trusted local execution:** The agent executes shell commands and Python directly on the host (and shares the desktop when using Cua). Use separate OS sessions or VMs if you require isolation.
- **Explicit control leases:** Device input requires an active lease (`rsa auto on`). Revoking control (`rsa auto off`) immediately invalidates device input permissions.
- **Privacy:** Local logs and model requests may include screenshots and desktop state; review before sharing.

## Documentation

Documentation is maintained in English ([`docs/en/`](docs/en/)) and Chinese ([`docs/zh/`](docs/zh/)):

- **[Tutorials](docs/en/tutorials/index.md)** — [Quickstart](docs/en/tutorials/quickstart.md) · [Devices & Drivers](docs/en/tutorials/devices.md) · [Workspace & Capabilities](docs/en/tutorials/workspace.md) · [Perception & Action](docs/en/tutorials/perception-and-action.md) · [Debugging & Verification](docs/en/tutorials/debugging-and-verification.md)
- **[Reference](docs/en/reference/index.md)** — [Architecture](docs/en/reference/architecture.md) · [Baseware](docs/en/reference/baseware.md) · [Driver Bridge Protocol](docs/en/reference/driver-bridge-protocol.md) · [Logging](docs/en/reference/logging.md) · [Dashboard UI](docs/en/reference/dashboard-ui.md) · [Benchmark](docs/en/reference/benchmark.md)
- **[Insights](docs/en/insights/index.md)** — Engineering rationales and postmortems ([OMP Compaction](docs/en/insights/omp-compaction.md) · [WS Recovery](docs/en/insights/ws-recovery.md) · [OMP Injection](docs/en/insights/omp-injection.md))
- **[Development Conventions](AGENTS.md)** — Repository workflow and verification rules.

## License

Licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices.
