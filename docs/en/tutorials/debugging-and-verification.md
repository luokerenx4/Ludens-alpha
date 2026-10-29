# Console Debugging and Verification

This guide covers the naming conventions for each package's scripts, how to debug Baseware / Host / Dashboard / Ludens Pet step by step in the foreground without relying on `launchd`, and how to run repo-wide offline checks and emulator hardware tests. For the regular full start/stop flow see [Installation and Workspace Lifecycle](quickstart.md).

Unless a command block explicitly `cd`s elsewhere, all commands below run at the **repo root**. After switching to a workspace for foreground debugging, return to the repo root before running further component commands. Browser console is used by default; pet-related commands require the [optional pet install](quickstart.md#optional-pet) first.

## Script Naming and Command Catalog

Each package's `package.json` scripts follow one naming scheme, and package managers and lockfiles keep each component's existing choice:

- Package-level generic commands use `dev` (dev server), `build` (produce build artifacts), `start` (launch the built app), `test` (default automated test suite), and `typecheck` (type checking); only provide the commands a component actually needs.
- Special-purpose commands use `<object>:<action>[:<variant>]`, with each segment in lowercase kebab-case, e.g. `pet:preview`, `omp:test:transport`. Local tasks must not use bare `preview`, `smoke`, or `check`; passthrough entries sharing a name with a CLI such as `rsa` or `baseware` may stay, with the concrete action given by subsequent subcommands.
- The default `test` includes integration tests and must never be named `unit`. Checking existing build artifacts uses `build:check`, which only checks and never builds.
- When renaming a command, update callers and docs together; keep no legacy aliases.

Catalog scripts run in their component directory. Bun packages use `bun run <command>`, Dashboard uses `npm run <command>`, and the optional Companion uses `pnpm <command>`:

| Component directory | Package-level commands | Special commands and entries |
| --- | --- | --- |
| `baseware` | `typecheck`, `test` | `baseware`: run the device-service CLI. |
| `rsa` | `typecheck`: check TypeScript and Python; `test`: run the default test suites of both languages. | `typescript:typecheck`, `python:typecheck`: check one language only; `typescript:test`, `python:test`: run one language's tests only; `omp:test:transport`: run the OMP WebSocket transport-recovery tests; `rsa`: run the Host CLI. |
| `rsa-dashboard` | `dev`, `build`, `start`, `test`, `typecheck` | `build:check`: verify the existing production build matches the current source fingerprint. |
| `rsa-companion` | `build`: produce Electron artifacts with esbuild; `start`, `test`, `typecheck` | `pet:preview`: interactive pet preview; `pet:smoke`: interactive pet smoke test. Both run `build` first. |

## Standalone Components and Consoles

### 1. Foreground Step-by-Step Debugging of Baseware and Host

When debugging standalone without `rsa up`, prepare the device bridge per [Device and Driver Preparation](devices.md) first, then start the services in two terminals in the same workspace:

```sh
# Terminal 1: start the device service
cd /absolute/path/to/workspace
baseware serve --driver azahar \
  --driver-package github:luokerenx4/ludens-3ds-driver#5b9b1f4032a5973a8882aa23957c3c34da50af9e \
  --port 47673 --data-dir ./logs/baseware
```

```sh
# Terminal 2: start the foreground Host (ignores rsa.json; defaults: 300s / 50 requests)
cd /absolute/path/to/workspace
rsa run --model openai-codex/gpt-6.1-sol --seconds 300 --requests 50
```

Once terminal 2 prints `"ready": true`, run `rsa auto on` in a third terminal inside that workspace. To test device and workspace capabilities without starting an OMP model session, pass `rsa run --device-only`. By default both sides derive the Unix socket address from the workspace path; override explicitly with `BASEWARE_SOCKET` / `--baseware-socket` and `RSA_SOCKET`.

### 2. Dashboard Web Console

Developing or viewing the frontend alone needs no model or emulator — it runs fine against an empty log directory:

```sh
# Dev mode (frontend HMR; restart the process after editing lib/ or worker/)
(cd rsa-dashboard && npm run dev)

# Prod mode (the mode rsa up uses for managed startup)
(cd rsa-dashboard && npm run build && npm run start)
```

When `rsa up` needs to start Dashboard fresh, it calls `npm run build:check` before bringing up devices to verify the build artifacts match the current source fingerprint; if unbuilt or the sources changed, it prompts to run `npm run build` first. If a Dashboard API is already available, `rsa up` reuses it directly without checking or hot-updating that process's build. Updating the production console requires rebuilding and restarting Dashboard; stopping or restarting Dashboard alone never stops a running Host, Baseware, or emulator.

Open `http://127.0.0.1:3015` in a browser to use the console:

- **Run & replay (`?view=live` / `?view=replay`)**: watch model reasoning streams, tool calls, device inputs, and perception frames live, or replay sampled frames and events synchronously on the history timeline. Archive worker, cold-index builder subprocess, and memory budgets: see [Consumption and Metrics](../reference/logging.md#consumption-and-metric-interpretation).
- **Performance & benchmarks (`?view=benchmark`)**: inspect per-request latency, caches, and call-chain profiling, or browse cross-workspace Harbor task runs and score comparisons in the "benchmark catalog" (`?view=benchmark&bench=cases`).
- **Capability catalog & driver validation (`?view=caps`)**: statically display the selected workspace's device catalog snapshot (`baseware.json`), Python `@capability` declarations, and Harbor eval tasks, plus online validation of external driver packages and `rsa init` command generation.
- **Perception settings (`?view=perception`)**: configure the selected workspace's hot-window seconds, video segment duration, and idle-stop finalization seconds (written to `.rsa/settings.json`, effective after `rsa perception reload`).
- **Workspaces (`?view=workspaces`)**: search and open registered folders, create a new workspace, add an existing directory, or change the default parent directory in the same `LUDENS_HOME`.
- **In-console docs (`?view=docs`)**: browse `docs/tutorials/`, `docs/reference/`, and `docs/insights/` inside the console, with cross-article and section-anchor navigation.

### Workspace entry flow

The Workspaces page puts **New workspace** and **Add existing** beside the library. Desktop creation only needs a folder name. A community driver requires an explicit package check, which may download the package and install dependencies; its manifest determines the driver ID and which optional fields are available. **Location & advanced options** accepts a full custom directory; the preview and folder name reflect that exact destination.

Creation initializes files without starting the agent. The confirmation offers **Open workspace**, a copyable `rsa --workspace '…' up` command, and the setup guide. New workspaces remain selectable in Live and Replay before their first run, with a next-step prompt instead of an endless loading state.

**Folder available** means the workspace identity can be read, not that its services are running. **Remove from list** keeps files and services and clears only that workspace’s pet follow target before removing the registration. If target cleanup fails, registration remains. **Undo** uses the actual removed registration to add the folder again, without resuming pet following; an unavailable folder must be reconnected before registration can succeed. For a moved or disconnected folder, reconnect its drive or use **Add new location**. Changing **Default location** only affects future creations.

### 3. Ludens Pet Desktop Companion

This is an optional component; the web console does not depend on Electron. After the [optional pet install](quickstart.md#optional-pet) and with Dashboard running, run `rsa-companion/bin/rsa-companion --show-window` at the repo root to start the desktop client standalone; its main window loads the same Dashboard console, and the pet character (Ludens) and bubbles consume the same incremental activity log. When managing the pet via `rsa up`, append `--pet` to the new workspace's `rsa init` command, or set `pet: true` in an existing `rsa.json`. `rsa up --pet` / `--no-pet` temporarily override the config, are mutually exclusive, and are never written back to the file; `--no-pet` does not shut down an already-running shared pet.

- **Workspace following**: use **Set as follow target** on a workspace page or the **Saved workspace** selector in Settings. The choice is stored in `$LUDENS_HOME/pet/target.json`; **Desktop status** separately reports whether Ludens Pet has connected and applied it. Browsing other workspaces or history never changes this choice. A saved choice remains visible when the desktop is disconnected or the directory is unavailable. If a save response cannot be confirmed, read the saved target again before another change; this recovery does not repeat the save. The heartbeat is stored in `$LUDENS_HOME/pet/consumer.json`. The stable ID in `.rsa/workspace.json` preserves workspace identity after a move and re-registration.
- **Launch flags**: `--workspace PATH` (or `RSA_WORKSPACE`) sets the initial default workspace, `--dashboard URL` the console address, `--profile PATH` a standalone preferences directory (default `RSA Ludens Pet` under Electron `appData`), and `LUDENS_DISABLE_COMPANION=1` disables the pet widget. Closing the main window only hides to the tray; double-click the pet or use the system tray menu to bring it back — only Quit exits the process for good.
- **Build sync**: when Dashboard shared log-client code consumed by the pet changes, re-run `(cd rsa-companion && pnpm build)` and restart the Electron main process.

## Verification

### 1. Offline Full Checks

The following core component checks are fully offline — no external model or real emulator is contacted:

```sh
(cd baseware && bun run typecheck && bun test)
python3 baseware/scripts/sync-cua-contract.py --check
(cd rsa && bun run typecheck && bun run test)
(cd rsa-dashboard && npm test && npm run typecheck && npm run build)
```

With the optional pet component installed, run its checks too:

```sh
(cd rsa-companion && pnpm typecheck && pnpm test)
```

To stress Dashboard cold-index builds and memory reclamation against real large run logs in isolation, run the offline check script with an isolated cache directory:

```sh
cd rsa-dashboard
node --expose-gc --max-old-space-size=1024 --import tsx scripts/check-index-memory.ts \
  --run /absolute/path/to/workspace/logs/run-id \
  --cache-root /absolute/path/to/temporary-index \
  --output /absolute/path/to/report.json --epoch epoch-id
```

### 2. Pet Interaction Smoke and Pose Rules

Running `(cd rsa-companion && pnpm pet:smoke)` auto-verifies window geometry, click-through, scaling, audio, and five log-bubble categories with a temporary profile; `pnpm pet:preview` keeps the interactive pet window for manual exploration.

The Ludens pet uses static transparent WebP assets (defined in `rsa-companion/ui/public/companion/ludens/manifest.json`, with 24 full-body poses, 8 overlay effects, 3 avatars, and tray icons; sync `catalog.js` after editing the manifest):

- **Visual calibration**: poses scale bottom-centered by `display_scale` against the default standing pose's head size; bubble size stays constant.
- **Pose priority**: mouse interaction (click surprise/happy, hold to pick up, drag to drop) > current visible log state (thinking→thinking, tool running→acting, tool done→smug, error→sheepish) > right-click menu hand-picked pose/effect (current process only) > idle timers (30s sit → 90s drowsy → 120s sleep).

### 3. Hardware and Emulator Integration Tests

| Test | Prerequisite | Run at repo root |
| --- | --- | --- |
| mGBA full control handoff | Emulator has the ROM and `bridge.lua` loaded; run this workspace's Baseware and `rsa run --device-only` in a separate terminal | `RSA_MGBA=1 RSA_WORKSPACE=/absolute/path/to/workspace bun test rsa/tests/device.live.test.ts` |
| mGBA repeated disconnect recovery | Keep the emulator and bridge running; stop the Host and Baseware occupying the bridge | Run the hardware tests per the README in the [GBA driver repo](https://github.com/luokerenx4/ludens-gba-driver), with an explicit port. |
| Ryubing button/sampling/long-action interruption | Park the game on a safe input-ready screen; stop the Host and Baseware and keep the emulator bridge running (override the port with `RSA_BRIDGE_PORT`) | `RSA_SWITCH_DRIVER_PACKAGE=github:luokerenx4/ludens-switch-driver#070edf662ba724e1a31c5b477f414d4da61bbd6f RSA_SWITCH_TEST=1 bun test rsa/tests/switch.live.test.ts` |
| Ryubing system keyboard dialog | Same as above, with Fire Emblem's eight-character naming box open. The test types nine characters and presses Enter to verify rejection, then cancels; do not run it in any other input box, or it may actually submit a name. | `RSA_SWITCH_DRIVER_PACKAGE=github:luokerenx4/ludens-switch-driver#070edf662ba724e1a31c5b477f414d4da61bbd6f RSA_SWITCH_KEYBOARD_TEST=1 bun test rsa/tests/switch.live.test.ts` |

## WS Recovery Test Basis

The test matrix and design retrospective for OpenAI Codex WebSocket expiry, abnormal close codes (e.g. `1012`), and unfinished tool-call recovery during long runs: see [WS Recovery Test Basis](../insights/ws-recovery.md).
