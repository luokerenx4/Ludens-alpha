import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EventLog as DeviceEventLog } from "../../../../baseware/src/events.ts";
import { atomicJson } from "../store.ts";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../../harness/baseware.ts";
import { WorkspaceController } from "../../harness/controller.ts";
import { Runtime } from "../../harness/runtime.ts";
import { listen as listenRsa, send } from "../../harness/transport.ts";
import type { BenchmarkContext } from "../types.ts";
import { readEvents, seqs, eventIds, until } from "../fixtures/evidence.ts";

/** Real sockets, arbitration and Python cancellation; only the physical driver is simulated. */
export async function run(ctx: BenchmarkContext): Promise<Record<string, unknown>> {
  ctx.signal?.throwIfAborted();
  const prefix = `/tmp/rsa-bench-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  const record = ctx.log.recorder({ component: "benchmark" });
  const root = resolve(import.meta.dir, "../../..");
  const env = { ...process.env, RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket,
    RSA_WORKSPACE: ctx.workspace, RSA_RUN_ID: ctx.log.clock.id, RSA_LOG_DIAGNOSTICS: ctx.log.diagnostics,
    PATH: [dirname(process.execPath), join(root, "bin"), process.env.PATH].join(":"),
    PYTHONPATH: join(root, "python") };
  await mkdir(ctx.workspace, { recursive: true });
  await writeFile(join(ctx.workspace, "handoff.py"), `from pathlib import Path
import os
from rsa_tools import Client, capability
@capability
def hold():
    """Hold a simulated input until the human takes control."""
    Path("handoff-python.pid").write_text(str(os.getpid()))
    return Client().call("controller/pad.hold", {"durationMs": 30000})
`);
  let held = false, actions = 0, abortedAt = 0, releasedAt = 0, driverInterrupted = false;
  const deviceLog = new DeviceEventLog(join(ctx.runDir, "device-sources"), crypto.randomUUID());
  const core = new BasewareCore({ serviceId: deviceLog.source.sourceId, source: deviceLog.source, record: deviceLog.record,
    diagnostics: ctx.log.diagnostics, drivers: [{ id: "benchmark-input", version: "1" }], capabilities: {
    controllers: [{ tool: { name: "pad.hold", description: "Hold simulated input for durationMs", inputSchema: { type: "object", properties: {durationMs: {type: "number", minimum: 0}}, required: ["durationMs"], additionalProperties: false } }, requiresControl: true,
      async acquire() {},
      async release() { held = false; releasedAt = performance.now(); },
      async execute(args, { signal }) {
        signal.throwIfAborted();
        const began = performance.now();
        held = true; driverInterrupted = false; actions++;
        await new Promise<void>(done => {
          const timer = setTimeout(done, Number(args.durationMs));
          signal.addEventListener("abort", () => {
            abortedAt = performance.now(); held = false; clearTimeout(timer); done();
          }, { once: true });
        });
        held = false; driverInterrupted = signal.aborted;
        return { id: crypto.randomUUID(), status: signal.aborted ? "interrupted" : "completed",
          exitCode: signal.aborted ? 130 : 0, stdout: "", stderr: "", result: { content: [] },
          timing: { clock: "benchmark-input", requestedAtMs: began, receivedAtMs: performance.now() } };
      },
    }],
  }});
  const closeBaseware = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({ socket: basewareSocket, seconds: 60, runDir: ctx.runDir, record: ctx.log.record });
  const manifestPath = join(ctx.runDir, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return {}; throw error;
  });
  await atomicJson(manifestPath, {...manifest, eventSources: devices.eventSources,
    logging: {diagnostics: ctx.log.diagnostics, basewareDiagnostics: devices.diagnostics}});
  const runtime = new Runtime(devices, ctx.log.record, 60, ctx.log.clock.id, ctx.log.diagnostics);
  runtime.controller = new WorkspaceController({ workspace: ctx.workspace, devices, env, record: ctx.log.record });
  devices.onHandback(reason => { void runtime.stop(reason); });
  devices.onDisconnect(error => { void runtime.disconnected(error); });
  const closeRsa = await listenRsa(rsaSocket, runtime);
  const measurements: Array<{ scenario: string; epoch: string; manual: boolean; neutral: boolean;
    cancelled: boolean; pythonGone: boolean; handbackMs: number; neutralMs: number; settleMs: number }> = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let staleRejected = false, staleExecuted = false;
  const abort = () => { void runtime.stop("benchmark interrupted"); };
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (const scenario of ["driver", "nested-python"]) {
      ctx.signal?.throwIfAborted();
      const epoch = (await runtime.start()).epoch!;
      const beforeActions = actions;
      record("benchmark_scenario", { scenario, phase: "started", requestedDurationMs: 30_000 }, { epoch });
      const pending = send(rsaSocket, { kind: "controller", argv: [], action: "call",
        id: scenario === "driver" ? "controller/pad.hold" : "python/handoff.py:hold",
        arguments: scenario === "driver" ? {durationMs: 30000} : {}, epoch })
        .then(value => ({ value: value as { status?: string }, error: "", at: performance.now() }),
          error => ({ value: undefined, error: String(error), at: performance.now() }));
      await until(() => actions === beforeActions + 1 && held, 5_000, ctx.signal);
      await Bun.sleep(20);
      ctx.signal?.throwIfAborted();
      const requestedAt = performance.now();
      record("benchmark_handoff_requested", { scenario }, { epoch });
      await runtime.stop("human");
      const handbackMs = performance.now() - requestedAt;
      const result = await pending;
      let pythonGone = true;
      if (scenario === "nested-python") {
        const pid = Number(await readFile(join(ctx.workspace, "handoff-python.pid"), "utf8"));
        await until(() => !alive(pid), 5_000, ctx.signal);
        pythonGone = !alive(pid);
      }
      const measurement = { scenario, epoch,
        manual: runtime.status().mode === "manual" && core.status().mode === "manual",
        neutral: !held, cancelled: driverInterrupted && (result.value?.status === "interrupted" || !!result.error),
        driverInterrupted, callerStatus: result.value?.status, callerError: result.error,
        pythonGone, handbackMs, neutralMs: Math.max(0, Math.min(abortedAt, releasedAt) - requestedAt),
        settleMs: Math.max(0, result.at - requestedAt) };
      measurements.push(measurement);
      record("benchmark_handoff_result", measurement, { epoch });
    }
    ctx.signal?.throwIfAborted();
    const priorEpoch = measurements.at(-1)!.epoch;
    await runtime.start();
    const before = actions;
    try {
      await send(rsaSocket, { kind: "controller", argv: [], action: "call", id: "controller/pad.hold",
        arguments: {durationMs: 1}, epoch: priorEpoch });
    } catch (error) { staleRejected = String(error).includes("STALE_EPOCH"); }
    staleExecuted = actions !== before;
    record("benchmark_stale_epoch", { rejected: staleRejected, driverExecuted: staleExecuted }, { epoch: priorEpoch });
  } finally {
    ctx.signal?.removeEventListener("abort", abort);
    await runtime.close(); devices.close(); await closeRsa(); await closeBaseware();
  }
  ctx.signal?.throwIfAborted();
  await ctx.log.flush();
  const events = await readEvents(ctx.runDir);
  ctx.metadata.limitations = ["使用真实 Unix socket、Runtime、Baseware 仲裁与 Python 子进程；物理设备以可中断的内存 driver 代替，不能据此证明真实模拟器响应时间。"];
  return {
    measurements, staleRejected, staleExecuted,
    evidence: measurements.map(m => ({ scenario: m.scenario,
      events: eventIds(events, e => e.trace.epoch === m.epoch && ["control", "execution", "baseware_control"].includes(e.type)),
      seqs: seqs(events, e => e.trace.epoch === m.epoch && ["benchmark_handoff_requested", "benchmark_handoff_result", "control", "capability_end", "execution"].includes(e.type)) })),
    staleEpochEvidence: seqs(events, e => e.type === "benchmark_stale_epoch"),
  };
}
