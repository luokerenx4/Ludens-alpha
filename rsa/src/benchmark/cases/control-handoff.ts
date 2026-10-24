import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../../harness/baseware.ts";
import { WorkspaceController } from "../../harness/controller.ts";
import { Runtime } from "../../harness/runtime.ts";
import { listen as listenRsa, send } from "../../harness/transport.ts";
import type { BenchmarkContext, AuthorReport } from "../types.ts";
import { readEvents, seqs, until } from "../fixtures/evidence.ts";

/** Real sockets, arbitration and Python cancellation; only the physical driver is simulated. */
export async function run(ctx: BenchmarkContext): Promise<AuthorReport> {
  ctx.signal?.throwIfAborted();
  const prefix = `/tmp/rsa-bench-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  const record = ctx.log.recorder({ component: "benchmark" });
  const root = resolve(import.meta.dir, "../../..");
  const env = { ...process.env, RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket,
    RSA_WORKSPACE: ctx.workspace, RSA_RUN_ID: ctx.log.clock.id,
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
  const core = new BasewareCore({ drivers: [{ id: "benchmark-input", version: "1" }], capabilities: {
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
  const runtime = new Runtime(devices, ctx.log.record, 60, ctx.log.clock.id);
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
  const events = await readEvents(ctx.runDir);
  ctx.metadata.limitations = ["使用真实 Unix socket、Runtime、Baseware 仲裁与 Python 子进程；物理设备以可中断的内存 driver 代替，不能据此证明真实模拟器响应时间。"];
  return {
    checks: {
      ...Object.fromEntries(measurements.map(m => [`${m.scenario}-interrupted`, { label: `${m.scenario} 长动作接管`,
        passed: m.manual && m.neutral && m.cancelled && m.pythonGone,
        expected: "交还 manual、输入归零、长动作取消、Python 子进程退出", actual: JSON.stringify(m),
        evidenceSeq: seqs(events, e => e.trace.epoch === m.epoch && ["benchmark_handoff_requested", "benchmark_handoff_result", "control", "capability_end", "execution"].includes(e.type)) }])),
      "release-latency": { label: "输入及时释放", passed: measurements.every(m => m.neutralMs <= 500),
        expected: "两种路径的输入释放延迟均 ≤ 500 ms（本地 fixture）", actual: measurements.map(m => `${m.scenario}: ${m.neutralMs.toFixed(2)} ms`).join(", "),
        evidenceSeq: seqs(events, e => e.type === "benchmark_handoff_result") },
      "stale-epoch": { label: "拒绝旧控制权", passed: staleRejected && !staleExecuted,
        expected: "STALE_EPOCH，旧调用不进入 driver", actual: JSON.stringify({ staleRejected, staleExecuted }),
        evidenceSeq: seqs(events, e => e.type === "benchmark_stale_epoch") },
    },
    metrics: {
      "handback-ms": { label: "最慢交还控制", value: Math.max(...measurements.map(m => m.handbackMs)), unit: "ms" },
      "neutral-ms": { label: "最慢输入释放", value: Math.max(...measurements.map(m => m.neutralMs)), unit: "ms" },
      "caller-settle-ms": { label: "最慢调用退出", value: Math.max(...measurements.map(m => m.settleMs)), unit: "ms" },
      "scenarios": { label: "中断路径", value: measurements.length, unit: "count" },
    },
  };
}
