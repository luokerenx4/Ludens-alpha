# Baseware

Baseware is a local device service. Drivers expose controllers; sensors are controllers that return observations. One service owns device connections, control leases, cancellation, observations and the device journal. CLI, TypeScript, Python and MCP clients call that same service. Baseware does not load an agent, task memory or workspace skills.

```sh
bun install --frozen-lockfile
export PATH="$PWD/bin:$PATH"
bun run check
bun test
```

Start against a prepared emulator bridge:

```sh
baseware serve --driver ryubing --port 47663 --socket /tmp/example-baseware.sock --data-dir /path/to/device-records
export BASEWARE_SOCKET=/tmp/example-baseware.sock
baseware list
baseware driver list
baseware controller screen --help
baseware controller screen capture
```

For a desktop, install the upstream [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)
and grant its native app Accessibility and Screen Recording permissions on macOS. Baseware connects
through one persistent `cua-driver mcp` proxy; CuaDriver.app owns the native runtime and permissions.
Upstream code and application settings are not bundled or modified.

```sh
baseware serve --driver cua --cua-command /absolute/path/to/cua-driver
baseware controller list
baseware controller cua.get_desktop_state
baseware controller cua.list_windows --args '{"app":"Calculator"}'
baseware controller cua.get_window_state --help
```

Every tool returned by the installed Driver's MCP catalog is exposed as `cua.<tool-name>`.
Its original JSON input schema and description are available through help; pass literal JSON with
`--args`, or omit it for an empty object. Read-only annotations determine whether the controller
requires a lease; missing annotations require control. RSA does not inject Cua tools into OMP.
Text and structured output stay in the execution result; binary media are archived as observations.
An accepted action can still report `unverifiable` or `suspected_noop`: inspect the original result
and subsequent state rather than treating completion as task success.

The proxy retains Cua's implicit and named sessions across CLI/API calls. Returning control stops
admitting new input, requests cancellation and ends sessions used by that connection. An already
running native call or script can finish before Cua completes cleanup; Baseware stays `releasing`
until then, and only reports `manual` after cleanup. The next call recreates its session.
Upstream cancellation and native input cleanup remain in Cua Driver. `down` closes the private proxy,
not the shared CuaDriver.app daemon or the user's applications. Separate workspaces still share
the real desktop. Use separate OS sessions or VMs when independent desktops are needed.

Native touch is exposed by the patched Ryubing and Azahar drivers as one `touch`
controller. It uses device coordinates, with the origin at the top-left, +x right
and +y down:

| Device | Inclusive x range | Inclusive y range |
| --- | --- | --- |
| Switch / Ryubing | 0–1279 | 0–719 |
| 3DS / Azahar | 0–319 | 0–239 |

The public commands are only `down --x <integer> --y <integer>`,
`move --x <integer> --y <integer>` and `up`. A contact persists between calls;
`down` requires no current contact and `move` requires one. A transition completes
after the emulator samples it. Cancellation or returning control lifts the contact.
There are no built-in tap, drag, timing, screen-layout or screenshot-coordinate
conversion commands. Callers compose those behaviors in workspace code.

Azahar provides its own native `pad`, `touch`, `screen.top` and `screen.bottom`
controllers. It has no Cua dependency or desktop capabilities. Each screen
capture returns one independent hardware image (400×240 or 320×240), with no
combined layout. Sensor fusion and transformation belong to workspace code.
Prepare the patched emulator using the
[Azahar driver instructions](src/drivers/azahar/README.md), then connect:

```sh
baseware serve --driver azahar --port 47673
baseware controller touch --help
```

The same `touch` help and commands are available with `--driver ryubing`.
CLI is the primary discovery and invocation path; TypeScript, Python and MCP
clients use the same capability and control lease.

`baseware export` writes the connected service's current capabilities and calling contract to `./baseware.json`; `--output <path>` chooses another file. It only reads discovery and replaces the snapshot, without acquiring control or sampling a device. RSA refreshes this file before starting OMP and adds a short, idempotent AGENTS note so the agent can read it on demand.

The document includes driver versions, controllers and help, control requirements, media types, the actual `controllerId`/`argv` invocation schema and the common execution-result schema. Each driver's `commands` declares a named-parameter JSON Schema and ordered `bindings`: start with the nonempty command `name`, then append each supplied parameter's flag and its string or JSON-encoded value. A binding with `style: "joined"` emits one `--flag=value` token to preserve values starting with dashes. Omit absent optional parameters. These declarations describe how to build the existing argv interface; they do not add a second execution path. For example, touch `down` declares integer `x`/`y` with the queried native bounds and binds them to `down --x <x> --y <y>`. `play.file` uses `x-fileContentSchema` to describe the JSON inside the named file. Constraints involving frame rounding or total sequence duration remain documented alongside the field schemas.

CLI/API discovery and MCP's list result expose those same driver declarations. MCP tool `_meta` also carries `baseware/commands` and, when declared, `baseware/stdoutSchema`; its execution arguments remain `{argv, epoch?}`. Cua parameter schemas come directly from the installed driver's tools. A controller's optional `stdoutSchema` describes `JSON.parse(result.stdout)`, while media files and timing use the common execution result. No current epoch or service socket is embedded in the exported document.

`baseware/bin/baseware` is the repository CLI. The default socket uses the canonical current directory: `/tmp/playness-baseware-<uid>-<sha256-first16>.sock`. Device data defaults to `$XDG_STATE_HOME/playness/baseware/<socket-name>`, or `~/.local/state/playness/baseware/<socket-name>`. A service starts in manual mode. Device files referenced by calls should use absolute paths.

A persistent client acquires a lease and shares its epoch with temporary callers. Controllers marked `requiresControl: true` must supply that epoch. Read-only controllers such as `screen` work without a lease. Closing the owner connection, expiration, driver disconnection or `baseware revoke` restores manual input. Closing a temporary caller only cancels its pending calls. Revocation stops new input immediately and waits for the driver's cleanup before reporting manual; it does not wait for model requests. The driver stays connected for the next lease.

```ts
import { BasewareClient } from "@playness/baseware/client";

const client = await BasewareClient.connect("/tmp/example-baseware.sock", {
  onEvent: event => console.log(event),
});
const epoch = crypto.randomUUID();
try {
  await client.request({ kind: "acquire", epoch, seconds: 300 });
  const catalog = await client.request({ kind: "list" });
  const result = await client.request({ kind: "controller", id: "screen", argv: ["capture"] });
  // Controller arguments are documented by each capability's help in the catalog.
} finally {
  await client.request({ kind: "release", epoch });
  client.close();
}
```

Temporary CLI and MCP clients inherit `BASEWARE_EPOCH`; neither acquires control. `BASEWARE_TRACE` carries a JSON object of parent trace fields. The stdio MCP adapter starts with `baseware mcp` and exposes device discovery, help, observation and execution through the same client. It does not expose acquisition or revocation tools to the model.

The Python client lives in `baseware/python`; add that directory to `PYTHONPATH` for standalone scripts. RSA supplies it automatically to its script processes. A Python call opens a temporary connection and uses the existing owner's epoch:

```python
from baseware import Client

device = Client()  # BASEWARE_SOCKET, BASEWARE_EPOCH, BASEWARE_TRACE
catalog = device.list()
print(device.help("screen"))
result = device.controller("screen", ["capture"])
observations = result["observations"]
```

For a model client using MCP, configure its stdio command as `/absolute/path/to/baseware/bin/baseware`, arguments `["mcp"]`, and environment `BASEWARE_SOCKET` plus the current `BASEWARE_EPOCH`. The catalog becomes tools such as `baseware_controller_screen` and `baseware_controller_pad`, with a literal `argv` array. The owner must remain connected for tools requiring control to work. For example, `baseware_controller_screen` accepts `{"argv":["capture"]}` and returns an execution result containing observation metadata plus image content.

RSA's `@capability` Python functions belong to the task's workspace. RSA discovers, describes and launches them; their device calls use this Python client. They do not register new Baseware hardware drivers or make Baseware load workspace Python code.

Every request is a newline-delimited JSON envelope `{id, request}`; responses are `{id, ok, value}` or `{id, ok:false, error}`. A connection supports concurrent requests. Subscribed clients and the owner receive `{event:{type,data,trace}}`. `BasewareClient.request(request, signal)` sends explicit cancellation for that wire request when aborted; requests are never transparently retried. The exported protocol types document request kinds.

`Controller` declares `requiresControl`, optional `mediaTypes`, `commands`/`stdoutSchema`, argument help and `execute`. Its result carries status, text, timing and optional `observations`. Ownership hooks are optional and apply only to controllers requiring control. There is one catalog and one wire invocation kind, `controller`, for input and sensing.

`events.jsonl` records device events independently of RSA, including rejected calls. Observations are immutable files under `observations/<service-id>/`; observation timing uses the service's own clock. Parent trace fields are preserved. Each controller invocation receives one operation ID and child span shared by its command, execution and observation events. `requiresControl` distinguishes actions from read-only calls; a capture does not displace the last action used for freshness measurements. An RSA host can subscribe and copy events into its run timeline without asking Baseware to understand model calls or workspace contents.

The local socket and emulator bridges assume trusted local processes. Epochs prevent stale or accidental calls; they do not provide operating-system isolation from arbitrary code running as the same user.
