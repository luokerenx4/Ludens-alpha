# Ryubing provider

`provider.ts` implements `Sensor` / `Controller`. `RsaBridge.cs` is compiled inside the emulator; `ryubing.patch` adds its integration points: input override, presented-frame capture, native text-entry dialog, and disposal. The Harness has no Ryubing or Switch branches. Only `app/main.ts` chooses the provider.

## Rebuild

Paths under `artifacts/` below refer to the monorepo's sibling directory `<repo>/../artifacts/`, not files shipped in the repository.

Run `build.sh` on Apple Silicon macOS with .NET 10, Python 3 and Xcode command line tools. `RSA_DOTNET` selects the SDK executable; default is the private `artifacts/switch/dotnet/dotnet` (locally installed SDK 10.0.402). The build is pinned to Ryubing tag `Canary-1.3.351`, resolving to commit `475615f0431b4995b03c930c5089d20f6f3570e0` in the [Starforge source archive](https://starforgejo.dev/archive/Ryubing). Source lives in `artifacts/switch/ryubing-canary-source`; the local version is `1.3.351-rsa.2`. This is a locally modified development build, not an official release.

The source's NuGet configuration replaces only the upstream LibHac feed URL with `https://nuget.ryulynx.org/v3/index.json`; package versions, source mappings and other upstream configuration remain unchanged. The stable build's LibHac version substitution and read-only title iteration changes are no longer needed. `ryubing.patch` contains bridge integration and this feed URL replacement, both applied by `build.sh`. Upstream macOS bundle tooling performs local ad-hoc signing with its normal JIT entitlements. No Gatekeeper or system security settings are changed.

`build.sh` stages the signed bundle at `artifacts/switch/ryubing-build/Ryujinx.app`. The single installed application is `/Applications/Ryubing.app`; install the staged bundle there after building and exiting the running emulator. The app is named Ryubing in Finder, while its upstream executable and process are still named `Ryujinx`.

`launch.sh <game.xci>` runs `/Applications/Ryubing.app/Contents/MacOS/Ryujinx` with `RSA_BRIDGE_PORT` set (default 47663). Bridge initialization requires that explicit environment variable; opening the same app normally from Finder leaves control manual. Manual and RSA use the same installed bundle and existing Ryujinx user data directory, including firmware, keys, saves and settings. Do not run two emulators against that directory concurrently.

## Wire and clocks

One TCP client on `127.0.0.1`, newline-delimited tab fields, UUID request IDs. The shared provider transport correlates concurrent replies. `HELLO` returns `ryubing-rsa-2`; `CAPTURE <absolute-path>` waits for the next presented framebuffer and returns its monotonically increasing presentation sequence. A frozen renderer fails capture after 15 seconds. PNG encoding runs off the GPU thread.

The bridge queues Screenshot through the full renderer before the corresponding Present, and fixes the sequence on that request. This ordering fix was introduced in the stable-based `rsa.3` build and is retained in the Canary build. Previously the base-renderer flag could be consumed by an older queued Present, while the reply read the later global frame counter. This change corrects ordering and frame attribution; it is not a measured latency improvement. The renderer wait runs outside the bridge lock.

Each successful capture emits one `RSA_CAPTURE` JSON line through the emulator's existing Info logger. The game path records receive-to-renderer-action, action-to-image-callback, callback-to-worker, PNG encode/save and total durations in milliseconds; the keyboard path records UI dispatch and capture/save separately. The absolute output path links it to the Harness observation. These diagnostics do not change the bridge protocol or model input. Restart into the new bundle to activate them; rebuilding does not instrument an already-running emulator.

Game screenshots use lossless PNG with zlib level 1. A quick check on one real 1920×1080 frame reduced encoding from 633 ms to 103 ms, with a 22% larger file. The aim is faster observations; this trades compression effort for bytes without changing pixels or dimensions. Results are scene-dependent.

`OWN <epoch>`, `DISOWN <epoch>`, `STATE <epoch>`, `STOP <epoch> [action-id]`, and `APPLY <epoch> <sequence>` operate only on player 1. Sequence spans are `mask:lx:ly:rx:ry:durationMs`, comma-separated. Digital mask bits match physical `ControllerKeys` 0–15; axes are signed ±32767. The provider exposes normalized axes ±1. No framebuffer parsing, memory inspection, game commands or navigation knowledge is present.

The input callback substitutes the AI state before Npad writes to emulated HID. Idle AI ownership substitutes neutral input; manual mode returns null and leaves native input intact. Motion for that player is neutral while overridden. Actions start on the first input poll, follow a cumulative monotonic wall-clock timeline, and clear at the first poll after the last span. The caller chooses each finite duration, at least 16 integer milliseconds; there is no policy upper limit. The provider requires safe integer durations and total milliseconds, and the bridge rejects integer overflow. Durations are not game frames: if emulation stalls, a wall-time action may produce no game progress. Finite actions, explicit cancellation, epoch validation and disconnect cleanup are enforced in the device bridge as well as at the Harness boundary. `STOP`/`DISOWN` are processed while an `APPLY` reply is pending. Handoff becomes visible to the emulated HID at its next input poll.

Model screenshots contain only the game framebuffer; host-window focus does not gate AI input or capture. This version supplies screen, one pad and a foreground text-entry keyboard, without audio, touch or system Home/Capture buttons. The TCP endpoint is intended for trusted local processes, not as an authentication boundary.


## Native system keyboard

Ryubing replaces the Switch foreground software keyboard with an Avalonia dialog. The game may stop presenting frames while this dialog is open. Capturing only the GPU output caused the first Fire Emblem smoke run to stop after a capture timeout at character naming.

`screen capture` now renders that actual visible dialog with Avalonia's `RenderTargetBitmap`, including its title, input, validation message and buttons. It does not OCR or synthesize a description. Dialog observations omit `sourceSequence` because no game frame was presented. The pending capture is also serviced when the dialog opens during a request.

A second controller, `keyboard`, supplies `type --text` and `press --key ENTER|ESCAPE|BACKSPACE|CTRL+A`. It is available only for this emulator's foreground text input. Text is transported as UTF-8 base64, preserving tabs/newlines without breaking the bridge framing. Native validation is retained; ENTER fails when the input is invalid. Epoch is checked again on the UI thread before changing a control. Pad and keyboard share one device ownership lease; while owned, native keyboard/pointer events in the text dialog are suppressed, and manual ownership restores them. No game name, character name or task-specific meaning is encoded in the provider.

With Fire Emblem's eight-character name dialog open and the RSA host stopped, `RSA_SWITCH_KEYBOARD_TEST=1 bun test tests/switch.live.test.ts` checks paused-frame capture, text edits, validation rejection, cancellation, unavailable-dialog errors and stale ownership. The test cancels its input rather than submitting a character name.

## Verified locally (2026-10-19)

The `1.3.351-rsa.2` build removes the two-second action/sequence cap. Durations remain explicit and finite; input sampling, cancellation and ownership semantics are unchanged. The rebuilt, signed application was installed at `/Applications/Ryubing.app`.

TypeScript checks and 16 relevant offline tests passed. Against Besiege, the live suite passed 35 assertions: a 30-second neutral sequence remained active after 2.1 seconds and was interrupted in under 500 ms; a 30-second held-input action, human handback through the device-only Runtime, disconnect cleanup and stale ownership rejection also passed. No model requests were made. The temporary emulator was closed after verification. The GBA duration changes passed encoder tests; its real-device suite was not rerun. Local build and live-test output is in `artifacts/switch/controller-duration-20261019/`.

## Verified locally (2026-10-18)

The Canary `1.3.351-rsa.1` arm64 build, signature verification, TypeScript check and four provider unit tests passed. The live pad/capture suite passed all 17 assertions; the native keyboard dialog test was not rerun. Besiege v1.0 booted with its existing per-game Hypervisor setting enabled, entered the tutorial and switched between building and physics simulation at about 30 FPS without reproducing the previous immediate crash. This is a short smoke test, not long-run compatibility validation. The emulator still logs handled AppleHv `BadArgument` warnings.

Only `/Applications/Ryubing.app` remains installed; eight old application copies and six obsolete installer/publish items were moved to Trash. Existing user data was retained and settings/saves backed up before upgrading. Build, cleanup and validation evidence is in `artifacts/switch/upgrade-20261018/`; the RSA host was reconnected in manual mode after testing.

## Verified locally (2026-10-14)

These are historical results for the stable 1.3.3-based build, not validation of the current Canary build.

The arm64 build and TypeScript check passed. The RSA suite passed 14 tests; live suites are opt-in. Both Switch live tests passed separately (17 pad/capture assertions, 7 native-keyboard assertions). A 20-request gpt-6.1-sol run discovered keyboard help, pressed ENTER on the native dialog, confirmed the name and birthday, selected Normal difficulty, and updated/read its own navigation skill. It stopped at its request budget in manual mode; native Down/Up input then moved the menu selection normally. That run ended at mode selection; it did not evaluate battle play or long-duration stability. Local evidence is in `artifacts/rsa/fire-emblem-engage/switch-verification.json` and the referenced immutable run logs.
