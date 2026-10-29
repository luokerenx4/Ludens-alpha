# Devices & driver setup

Each driver only exposes a device's native input and capture capabilities — no game strategy, cross-screen coordinate fusion, or automatic save/load logic. This page follows the [core installation](quickstart.md#install); once device and driver setup is done, continue with [Starting and stopping workspaces](quickstart.md#starting-and-stopping-workspaces) to create and launch a workspace.

Emulator drivers are all installed on demand; the main repo no longer ships emulator providers, native bridges, or build patches. Driver-package installation and emulator-binary builds are two separate steps: `--driver-package` installs the TypeScript package, while each satellite repo's build guide prepares a bridged emulator.

## mGBA

Use [ludens-gba-driver](https://github.com/luokerenx4/ludens-gba-driver) (driver ID `mgba`). Follow that repo's README to install mGBA, load a game, and load the bundled `bridge.lua`; the default bridge port is `47653`. mGBA requires manually preparing the game and bridge, and `rsa.json` rejects the `game` field. Dev-build compatibility notes, port configuration, and SRAM save notes are also maintained in that repo.

## Ryubing

Use [ludens-switch-driver](https://github.com/luokerenx4/ludens-switch-driver) (driver ID `ryubing`). That repo centrally maintains the pinned upstream version, native bridge, patches, build/launch scripts, and dedicated tests; the default bridge port is `47663`. After preparing a bridged emulator per that repo's README, RSA can launch games via the driver manifest.

Native capabilities include `pad.*`, `screen.capture`, `touch.down / move / up`, plus `keyboard.type / press` for the Switch system keyboard. The touch range is `1280×720`. Firmware, keys, and saves stay on the local machine; avoid concurrently launching emulator instances that share one data directory.

## Azahar

Use [ludens-3ds-driver](https://github.com/luokerenx4/ludens-3ds-driver) (driver ID `azahar`). That repo maintains the pinned upstream version, native bridge, patches, build/launch scripts, and dedicated tests; the default bridge port is `47673`. After preparing a bridged emulator per that repo's README, RSA can launch games via the manifest.

Native capabilities include `pad.*`, `screen.top.capture` (top screen `400×240`), `screen.bottom.capture` (bottom screen `320×240`), and `touch.down / move / up` (bottom-screen range `x = 0..319`, `y = 0..239`). Coordinate mapping and game strategy belong in the workspace.

## Cua

The desktop environment uses the stock upstream [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver):

1. Install Cua Driver, and in macOS **System Settings → Privacy & Security** grant `CuaDriver.app` **Accessibility** and **Screen Recording** permissions.
2. Baseware attaches the driver through a persistent `cua-driver mcp` child process (stdio transport); no `game` or bridge port is needed. If `cua-driver` is not on `PATH`, specify the absolute path via `rsa init --cua-command` or the `rsa.json` `cuaCommand` field.
3. All tools keep their upstream names and JSON parameter shapes (e.g. `rsa controller controller/get_desktop_state --args '{}'`); for contract boundaries see [Baseware design & capability contracts](../reference/baseware.md).

**Desktop environment boundaries**: multiple Cua workspaces share the same host's real desktop (including melonDS and other emulators running on the desktop that lack a dedicated native bridge yet); use a separate OS session or VM for an isolated desktop. Handing control back to a human immediately rejects new inputs and requests cancellation, but a single native call already inside the OS may still finish; `rsa down` does not close the shared `CuaDriver.app` or the user's desktop apps.

## Discovering & connecting external driver packages

The Dashboard **Capabilities → Community driver verification** form validates a package only after you choose **Verify package**. A successful result means its registration declaration imported and passed validation; it does not connect to a device, build an emulator, or prove that a game runs. **Create workspace with this driver** opens the existing creation form with the package and verified declaration carried over in the same tab. Opening that link in a new tab, or sharing its URL, only prefills the package address and requires verification again. Creation is a separate explicit action and may download or import the package again. Set a name, review the directory and driver-specific options, then create; the completion card supplies a workspace-scoped `up` command to run in a terminal when ready.

For an existing workspace, follow the configuration instructions below rather than initializing it again. The **Workspace sources** section distinguishes the saved `baseware.json` device snapshot, static Python declarations, and discovered eval tasks. A missing snapshot calls for service setup; it is not proof of an empty live device. **Check host status** separately reads the selected workspace's Host status on demand. The reported control connection is the Host's last-known state, including uncertainty after control errors; it does not verify physical hardware, game output, or individual capability execution. Refreshing the source list does not repeat package verification or check the Host.

mGBA, Azahar, and Ryubing must select an external package explicitly via `--driver-package`; only the `cua` desktop access is built in. Package addresses accept an npm spec, `github:org/repo#rev`, a GitHub HTTPS URL, `git@github.com:org/repo.git#rev`, or `file:path`. SSH addresses keep SSH transport, and the cache distinguishes transport, repository, and revision. Before initializing a workspace, validate the package's `DriverRegistration` declaration with `baseware driver discover` or the Dashboard capabilities page (`?view=caps`):

```sh
baseware driver discover --package 'github:org/repo#rev'
rsa init --driver <id> --driver-package 'github:org/repo#rev'
```

- **Path resolution**: relative `file:` paths in `rsa init` and `rsa up` resolve against the target workspace directory and are normalized; relative `file:` in `baseware driver discover` resolves against the current shell directory; external-driver validation in the Dashboard web UI requires absolute `file:` paths.
- **Actual source**: the catalog's `drivers[].source`, Baseware `service_start.driverSource`, and RSA `manifest.drivers[].source` record the source the loader actually resolved: GitHub `resolvedCommit`, npm `resolvedVersion`, or local entry `entrySha256`. The entry hash does not cover dependencies, and `provider.version` still denotes the device or protocol version; see [Package addresses & caching](../reference/baseware.md#1-package-addresses-and-caching) for the fields.
- **Trust boundary**: discovery does not call the driver's `load()`, but it downloads and installs dependencies and imports the package entry code; only run discovery and init against trusted sources. For the driver package spec see [Driver packages & launch descriptions](../reference/baseware.md#driver-packages-and-launch-description) and [Driver Bridge protocol](../reference/driver-bridge-protocol.md).

**Migrating an existing emulator workspace**: run `rsa auto off`, then `rsa down --keep-emulator`; add the matching `driverPackage` to the original `rsa.json`, pinning the commit SHA of the corresponding repo below, then `rsa up --dry-run` / `rsa up`. Do not re-run `rsa init`; the original workspace files and saves are kept. Already-running services do not switch packages just because sources were updated.

New packages start the emulator from their respective build caches by default. To reuse an already-installed app, set `RSA_AZAHAR_APP=/Applications/Azahar.app` or `RSA_RYUBING_APP=/Applications/Ryubing.app` before the start command, e.g. `RSA_RYUBING_APP=/Applications/Ryubing.app rsa up`. These variables only select the launch path and never copy or overwrite an existing app; custom paths must be passed on every `up` (including `--dry-run`). To attach to an already manually prepared emulator only, omit `game`.

| Driver ID | Optional package |
| --- | --- |
| `mgba` | `github:luokerenx4/ludens-gba-driver#9c1a014be3d87fe6846fef8ad7eba1c13439e8a5` |
| `azahar` | `github:luokerenx4/ludens-3ds-driver#5b9b1f4032a5973a8882aa23957c3c34da50af9e` |
| `ryubing` | `github:luokerenx4/ludens-switch-driver#070edf662ba724e1a31c5b477f414d4da61bbd6f` |
