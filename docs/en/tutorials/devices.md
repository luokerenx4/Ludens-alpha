# Devices & driver setup

Each driver only exposes a device's native input and capture capabilities — no game strategy, cross-screen coordinate fusion, or automatic save/load logic. This page follows the [core installation](quickstart.md#install); once device and driver setup is done, continue with [Starting and stopping workspaces](quickstart.md#starting-and-stopping-workspaces) to create and launch a workspace.

Only the `cua` desktop adapter is built into the main repository. Emulator and custom hardware drivers are loaded on demand as external packages (`--driver-package`); the main repository does not bundle emulator binaries, native bridges, or build patches.

## Cua

The desktop environment uses the stock upstream [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver):

1. Install Cua Driver, and in macOS **System Settings → Privacy & Security** grant `CuaDriver.app` **Accessibility** and **Screen Recording** permissions.
2. Baseware attaches the driver through a persistent `cua-driver mcp` child process (stdio transport); no `game` or bridge port is needed. If `cua-driver` is not on `PATH`, specify the absolute path via `rsa init --cua-command` or the `rsa.json` `cuaCommand` field.
3. All tools keep their upstream names and JSON parameter shapes (e.g. `rsa controller controller/get_desktop_state --args '{}'`); for contract boundaries see [Baseware design & capability contracts](../reference/baseware.md).

**Desktop environment boundaries**: multiple Cua workspaces share the same host's real desktop; use a separate OS session or VM for an isolated desktop. Handing control back to a human immediately rejects new inputs and requests cancellation, but a single native call already inside the OS may still finish; `rsa down` does not close the shared `CuaDriver.app` or the user's desktop apps.

## Discovering & connecting external driver packages

Enter the exact address in the labeled **Driver package address** field. On narrow screens the verification button sits below the full-width input. Editing the address cancels an outstanding verification and clears its result; a late response cannot validate a different address.

The Dashboard **Capabilities → Community driver verification** form validates a package only after you choose **Verify driver package**. A successful result means its registration declaration imported and passed validation; it does not connect to a device, build an emulator, or prove that a game runs. **Create workspace with this driver** opens the existing creation form with the package and verified declaration carried over in the same tab. Opening that link in a new tab, or sharing its URL, only prefills the package address and requires verification again. Creation is a separate explicit action and may download or import the package again. Set a name, review the directory and driver-specific options, then create; the completion card supplies a workspace-scoped `up` command to run in a terminal when ready.

For an existing workspace, follow the configuration instructions below rather than initializing it again. The **Workspace sources** section distinguishes the saved `baseware.json` device snapshot, static Python declarations, and discovered eval tasks. A missing snapshot calls for service setup; it is not proof of an empty live device. **Check host status** separately reads the selected workspace's Host status on demand. The reported control connection is the Host's last-known state, including uncertainty after control errors; it does not verify physical hardware, game output, or individual capability execution. Refreshing the source list does not repeat package verification or check the Host.

Non-built-in drivers must select an external package explicitly via `--driver-package`; only the `cua` desktop access is built in. Package addresses accept an npm spec, `github:org/repo#rev`, a GitHub HTTPS URL, `git@github.com:org/repo.git#rev`, or `file:path`. SSH addresses keep SSH transport, and the cache distinguishes transport, repository, and revision. Before initializing a workspace, validate the package's `DriverRegistration` declaration with `baseware driver discover` or the Dashboard capabilities page (`?view=caps`):

```sh
baseware driver discover --package 'github:org/repo#rev'
rsa init --name my-task --driver <id> --driver-package 'github:org/repo#rev'
```

- **Path resolution**: relative `file:` paths in `rsa init` and `rsa up` resolve against the target workspace directory and are normalized; relative `file:` in `baseware driver discover` resolves against the current shell directory; external-driver validation in the Dashboard web UI requires absolute `file:` paths.
- **Actual source**: the catalog's `drivers[].source`, Baseware `service_start.driverSource`, and RSA `manifest.drivers[].source` record the source the loader actually resolved: GitHub `resolvedCommit`, npm `resolvedVersion`, or local entry `entrySha256`. The entry hash does not cover dependencies, and `provider.version` still denotes the device or protocol version; see [Package addresses & caching](../reference/baseware.md#1-package-addresses-and-caching) for the fields.
- **Trust boundary**: discovery does not call the driver's `load()`, but it downloads and installs dependencies and imports the package entry code; only run discovery and init against trusted sources. For the driver package spec see [Driver packages & launch descriptions](../reference/baseware.md#driver-packages-and-launch-description) and [Driver Bridge protocol](../reference/driver-bridge-protocol.md).

**Migrating an existing external-driver workspace**: run `rsa auto off`, then `rsa down --keep-emulator`; add or update the matching `driverPackage` in `rsa.json` (pinning the target revision or commit SHA), then run `rsa up --dry-run` / `rsa up`. Do not re-run `rsa init`; the original workspace files and saves are kept. Already-running services do not switch packages just because sources were updated. To attach to an already manually prepared emulator without auto-launching a game file, omit `game`.
