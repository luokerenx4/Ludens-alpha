# Tutorials

This directory splits the hands-on journey into five standalone topics, covering the full flow from first install, preparing emulator/desktop drivers, starting and stopping workspaces, to writing adaptive code and debugging.

## Five-step path

For a first run, complete the [core installation](quickstart.md#install) in **1. Install & lifecycle**, prepare the target emulator or desktop driver in **2. Device preparation**, then return to [Starting and stopping workspaces](quickstart.md#starting-and-stopping-workspaces) to launch the workspace:

| Stage | Topic | What it solves | Key commands / entry points |
| --- | --- | --- | --- |
| **1. Install & lifecycle** | [**Install & workspace lifecycle**](quickstart.md) | Install components, configure the global default directory, then create/register/import workspaces and manage their lifecycle once devices are ready | `rsa config` · `rsa init --name` · `rsa workspace` · `rsa up` · `rsa auto on` · `rsa down` |
| **2. Device preparation** | [**Devices & driver setup**](devices.md) | Set up the built-in Cua desktop driver or discover and connect external emulator driver packages | `--driver-package` · `baseware driver discover` · `cua-driver` |
| **3. Capabilities & recording** | [**Workspaces & capability programming**](workspace.md) | Understand the workspace file layout, declare `@capability` and `@record`, call device and local Python capabilities | `rsa controller` · `rsa_tools.Client` · `.rsa/timeline/` |
| **4. Perception & action** | [**Resident perception & action loop**](perception-and-action.md) | Write a 30Hz resident `perception.py` and `action.py`, query the historical timeline, and manage auto-injection and recording parameters | `rsa perception reload` · `rsa observe` · `rsa action reload` |
| **5. Debugging & verification** | [**Console debugging & verification**](debugging-and-verification.md) | Debug a single component in the foreground, use the Dashboard and the Ludens Pet companion, follow script naming conventions, run offline and on-device tests | `baseware serve` · `rsa run` · `http://127.0.0.1:3015` |

## Related reference

- For the five-component boundaries, the Shiori control cycle, and OMP session assembly, see [Architecture & boundaries](../reference/architecture.md).
- For device tool schemas, control leases, and the driver package protocol, see [Baseware design & capability contracts](../reference/baseware.md) and [Driver Bridge protocol](../reference/driver-bridge-protocol.md).
- For diagnosing runtime events, model-input receipts, or the Dashboard indexing mechanism, see [Logging & call chains](../reference/logging.md).
- For running or writing Harbor eval tasks, see [Benchmark](../reference/benchmark.md).
