# Tutorials

This directory splits the hands-on journey into five standalone topics, covering the full flow from first install, preparing emulator/desktop drivers, starting and stopping workspaces, to writing adaptive code and debugging.

## Five-step path

| Stage | Topic | What it solves | Key commands / entry points |
| --- | --- | --- | --- |
| **1. Install & lifecycle** | [**Install & workspace lifecycle**](quickstart.md) | Install core components and the optional pet, pick `RSA_PYTHON`, run a workspace with `rsa init / up / auto / down` | `rsa init` · `rsa up` · `rsa auto on` · `rsa down` |
| **2. Device preparation** | [**Devices & driver setup**](devices.md) | Install the optional mGBA, Ryubing, and Azahar driver packages, or prepare the built-in Cua desktop access | `dofile(...)` · `build.sh` · `launch.sh` · `baseware driver discover` |
| **3. Capabilities & recording** | [**Workspaces & capability programming**](workspace.md) | Understand the workspace file layout, declare `@capability` and `@record`, call device and local Python capabilities | `rsa controller` · `rsa_tools.Client` · `.rsa/timeline/` |
| **4. Perception & action** | [**Resident perception & action loop**](perception-and-action.md) | Write a 30Hz resident `perception.py` and `action.py`, query the historical timeline, and manage auto-injection and recording parameters | `rsa perception reload` · `rsa observe` · `rsa action reload` |
| **5. Debugging & verification** | [**Console debugging & verification**](debugging-and-verification.md) | Debug a single component in the foreground, use the Dashboard and the Ludens Pet companion, follow script naming conventions, run offline and on-device tests | `baseware serve` · `rsa run` · `http://127.0.0.1:3015` |

## Related reference

- For the five-component boundaries, the Shiori control cycle, and OMP session assembly, see [Architecture & boundaries](../reference/architecture.md).
- For device tool schemas, control leases, and the driver package protocol, see [Baseware design & capability contracts](../reference/baseware.md) and [Driver Bridge protocol](../reference/driver-bridge-protocol.md).
- For diagnosing runtime events, model-input receipts, or the Dashboard indexing mechanism, see [Logging & call chains](../reference/logging.md).
- For running or writing Harbor eval tasks, see [Benchmark](../reference/benchmark.md).
