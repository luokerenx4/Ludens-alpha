# Azahar driver

The pinned Azahar 2126.2 build exposes four native capabilities: `pad`, `touch`,
`screen.top`, and `screen.bottom`. They share one emulator connection and input epoch. This driver
has no CUA dependency and sends no desktop keyboard or mouse events.

- `pad` supplies the physical buttons, Circle Pad, and C-stick at Azahar's input
  polling boundary. Timed states and sequences use wall time, with no two-second
  ceiling; held controls persist between adjacent spans and release at completion.
- `touch` supplies a single contact in integer device coordinates `x=0..319`,
  `y=0..239`. Only down, move, and up are exposed. No tap, drag, display scaling,
  screen identification, or coordinate conversion is built in.
- `screen.top` and `screen.bottom` independently render one hardware screen through
  Azahar's screenshot path: 400×240 for the top display (left eye), 320×240 for the
  bottom touchscreen. They do not read window layout, crop a combined image, add
  host cursor overlays, or compose the two sources. Paused/no-game requests fail
  directly; pausing or stopping an in-flight capture resolves that request.

## Build and launch

`build.sh` checks out upstream revision `219d743a1e698101fe1ab8bef43e6563126c3c27`,
applies `azahar.patch`, copies `rsa_bridge.cpp/.h`, and builds an ARM64 macOS app
outside this repository. Qt and MoltenVK come from upstream CMake. Override
`RSA_AZAHAR_SOURCE` to reuse a checkout and `RSA_BUILD_JOBS` to change the default
four jobs. The output is `artifacts/3ds/azahar-build/bundle/azahar.app`; installing
it is a separate copy to `/Applications/Azahar.app`. `launch.sh <game>` starts
that installed app with `RSA_BRIDGE_PORT=47673`. `RSA_AZAHAR_APP` selects another
bundle. The build does not replace an installed app or stop a running emulator.

## Local bridge protocol

One persistent TCP connection to `127.0.0.1:$RSA_BRIDGE_PORT`. Each line is tab
separated and begins with a request ID. Responses begin with that ID and `OK`
plus optional fields, or `ERROR` plus a message.

| Request fields after ID | Result |
| --- | --- |
| `HELLO` | `azahar-rsa-3` |
| `OWN epoch` | Acquire neutral native input. |
| `STATE epoch` | `mask lx ly rx ry actionId` (tab separated); action ID is `-` when idle. |
| `APPLY epoch sequence` | `completed\|interrupted elapsedMs polls`. |
| `TOUCH_INFO` | `0 0 319 239` (four tab-separated bounds). |
| `TOUCH_DOWN epoch x y` | Press one contact; fails if already down. |
| `TOUCH_MOVE epoch x y` | Move the current contact; fails if not down. |
| `TOUCH_UP epoch` | Release; idempotent. |
| `CAPTURE top\|bottom absolutePath` | Save the selected hardware screen as PNG, return a capture sequence number, not a game-frame number. |
| `STOP epoch [request-id]` | Cancel matching pad/touch action; omitted ID releases both. |
| `DISOWN epoch` | Release all native input and restore human input. |

An APPLY sequence is comma-separated spans, each `mask:lx:ly:rx:ry:durationMs`.
Button mask order is `A B X Y L R START SELECT LEFT UP RIGHT DOWN ZL ZR`.
Axes are signed integers `-32767..32767`: X is positive right and Y positive up.
Each duration is an integer of at least 16 ms; total duration must be a safe
integer. One pad sequence runs at a time. `STATE` reports driver state, never
game memory.

Touch transitions acknowledge only after the emulated touch device samples the
state. Successful transitions return `completed`; cancelled pending transitions
return `interrupted`. The socket thread continues reading STOP and DISOWN while
waiting for input sampling. Stale epochs cannot mutate input. Disconnection
clears owned controls. `TOUCH_STATE` is an internal diagnostic response with
ownership, pressed state, x/y, written generation, and sampled generation.
