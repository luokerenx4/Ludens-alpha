# Azahar touchscreen bridge

The pinned Azahar 2126.2 build exposes its native single-contact touchscreen state.
It does not send desktop mouse events. Coordinates are integer device pixels:
`x=0..319`, `y=0..239`. No layout detection, screen cropping, coordinate conversion,
tap, or drag is built into the driver; workspace code can compose the primitives.
CUA remains the source of raw window observations and ordinary desktop input.

`build.sh` downloads the exact upstream revision, applies `azahar.patch`, copies
the two bridge sources, and builds an ARM64 macOS app outside this repository.
Qt and MoltenVK are downloaded by upstream CMake. Override `RSA_AZAHAR_SOURCE`
to reuse a local checkout and `RSA_BUILD_JOBS` to change the default four jobs.
The build only outputs `artifacts/3ds/azahar-build/bundle/azahar.app`; installing
it is a separate copy to `/Applications/Azahar.app`. `launch.sh <game>` starts
that installed app with `RSA_BRIDGE_PORT=47673`. Set `RSA_AZAHAR_APP` to test a
different bundle. The build does not replace an installed app or stop an emulator.

## Local bridge protocol

One persistent TCP connection to `127.0.0.1:$RSA_BRIDGE_PORT`. Each line is tab
separated, beginning with a caller-generated request ID. Responses begin with
the same ID followed by `OK` and optional fields, or `ERROR` and a message.

| Request fields after ID | Result |
| --- | --- |
| `HELLO` | `azahar-rsa-1` |
| `TOUCH_INFO` | `0 0 319 239` (four tab-separated bounds) |
| `OWN epoch` | Acquire neutral touch state; native user touch is suppressed. |
| `TOUCH_DOWN epoch x y` | Press one contact; fails if already down. |
| `TOUCH_MOVE epoch x y` | Move the current contact; fails if not down. |
| `TOUCH_UP epoch` | Release; idempotent. |
| `STOP epoch [request-id]` | Release a cancelled action. A supplied ID must match the latest accepted touch action. |
| `DISOWN epoch` | Release and return native input ownership. |

Down, move, and a releasing up acknowledge only after the emulated input device
has sampled that state, returning `completed`. Interrupted pending transitions
return `interrupted`. The socket thread keeps accepting cancellation while a
reply is pending. `STOP`, ownership release, and disconnect clear the contact;
stale epochs cannot mutate it. `STATE` is an internal diagnostic response with
ownership, pressed state, x/y, written generation, and sampled generation.

Only the three touch transitions and their bounds are public driver capabilities.
Screenshots and keyboard control still use the unmodified CUA integration.
