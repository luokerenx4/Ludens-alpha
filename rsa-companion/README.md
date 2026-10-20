# Alice Pet for RSA

OpenAlice's complete companion subsystem transplanted into Playness. The original
character, bubble artwork, click sound, native geometry, hit testing and
audio settings are retained. Log content uses the approved type-specific layouts.
`upstream.json` records the source commit and hashes;
`LICENSE` and `ui/public/companion/NOTICE.md` retain attribution.

## Run

Build once in this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Start the RSA dashboard in the sibling `rsa-dashboard/` directory with `npm run dev`,
then open Alice from any directory:

```sh
/absolute/path/to/rsa-companion/bin/rsa-companion --show-window
```

Choose **让 Alice 跟随此工作区** in the Dashboard to change the pet's workspace
without restarting it. This works in the browser and the desktop window.
The selection is shared and saved by the Dashboard; browsing another workspace,
historical run or epoch does not change it. Alice always follows the latest game
run in the selected workspace, excluding benchmarks. With no selection Alice
stays open and waits. Stopping following does not stop the Host or its agent.

`--workspace PATH` or `RSA_WORKSPACE` supplies an initial selection only when no
selection has ever been saved. The current directory does not select a workspace.
`--dashboard http://127.0.0.1:3015` selects the local log server.
`--profile PATH` uses a separate preferences directory / instance.
The normal preferences live in macOS Application Support/RSA Alice Pet, independently
of OpenAlice. Starting the normal instance again opens its existing window and exits
successfully. No OpenAlice service, Guardian, model request or game input is started.

The main window loads the same local Dashboard as the browser: live activity,
Benchmark and Alice settings share one frontend. The old standalone Vite/React
main UI has been removed; this package builds only the native Electron shell and
keeps the original static pet renderer/assets. Closing that window hides
it; Alice and the tray remain. Double-click Alice or click the tray to reopen it.
The tray/right-click menu controls pet visibility, size and Quit. Settings retains
the original click mute, volume, local audio import, preview and reset behavior.

## Log connection

Electron main polls the Dashboard's `/api/alice` follow target every 2.5 seconds,
independently of log reads, and reports a periodic consumer heartbeat there.
This is a same-machine contract: the heartbeat includes the Electron main
process PID so the Dashboard can check process liveness as well as heartbeat
freshness, including immediately after Alice quits.
A target change cancels the previous read, clears its bubble and queue, switches
the consumer journal to the new workspace and immediately starts reading.
Late results from the previous target cannot change the new display.
The Dashboard can therefore show whether Alice is open and has loaded the requested
target. Alice remains open if the Dashboard is temporarily offline and reconnects;
an initial failed window load retries automatically.

For the selected workspace, Electron polls the existing read-only `/api/catalog`,
`/api/run` and `/api/activity` endpoints every 2.5 seconds, without overlapping requests.
Images use `/api/media`. The activity endpoint projects both `events.jsonl` and
model stream files into stable blocks: thinking, text, tools, system events and
diagnostics. It reads the model's logged output, not input history or encrypted
reasoning. No additional model call generates narration.

Alice's bubble is the primary display even while the main window is open. Thinking,
text, tools and system events are visible by default; transport diagnostics can be
enabled in settings. Stream increments update the same block. Each new visible
block enters the display queue, instead of being discarded in favor of the latest
message. Streaming blocks update in place; completed blocks remain for four
seconds. 详情 opens the exact Dashboard project/run/epoch/block in the desktop window. Errors can interrupt ordinary previews. The owner view
retains the full text and tool arguments/results, including longer blocks.

Connecting baselines old history rather than replaying a whole session: a running
block may be shown immediately, while an already stopped run gives one brief
hand-back message. Run/epoch changes clear the queue. Window toasts are a fallback
when Alice is hidden or bubble notifications are disabled. Visibility settings
change presentation, not what the log source consumes.

The bubble renders the existing five kinds directly: thinking has a quiet violet
header, text reads as prose, tools separate intent/parameters/collapsible results,
system events emphasize status, and diagnostics align metadata fields. Running,
complete and error states use small status indicators. The speech artwork is the
same, with more reading space for activity; Alice's size and audio are unchanged.
Long text is scrollable without truncation. Streaming updates keep scroll position
and expanded results. Raw content is inserted as text, never executable HTML.

The pet renderer cannot access the network. The owner loads only the configured
local Dashboard origin; native settings IPC verifies the sender's main frame
and that exact origin. Navigation to other origins and new windows is blocked.
Browser users see the same Alice settings page with desktop-only controls disabled.
收起 does not stop the agent.

Block bubbles include their content for a fresh RSA profile. The optional brief
mode hides details. Original Journal implementation and preferences remain in the
source snapshot, while the runtime uses the RSA source/controller and block
visibility controls. No Journal server or OpenAlice business events are required.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm smoke
```

Smoke uses a disposable profile. It preserves the upstream native preview checks
(image alpha, window geometry, press/release, dialogue, mirror and three sizes),
then verifies actual audio playback, fixture-driven content for all five kinds,
long-content scrolling at three sizes and both orientations, expansion across
streaming updates, and dismissal. Captures are saved in
the temporary directory printed by the test.
`pnpm preview` leaves a disposable interactive pet open. Neither command contacts
a model or controls an emulator.

During development a macOS background launch can use RSA's existing
`rsa/scripts/launch-background.py` (relative to the repository root).
The managed launcher uses a shared desktop instance; workspace service shutdown
does not close Alice. This does not install an automatic restart or login service.
This is a local development app, not a signed distributable installer.
