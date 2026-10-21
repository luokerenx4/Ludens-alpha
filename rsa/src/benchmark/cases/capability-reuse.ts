import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BasewareCore } from "@playness/baseware/core";
import { writeCapabilityDocument } from "@playness/baseware/catalog";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../../harness/baseware.ts";
import { WorkspaceController } from "../../harness/controller.ts";
import { PythonCapabilities } from "../../harness/python-capabilities.ts";
import { PerceptionRuntime } from "../../harness/perception.ts";
import { Runtime } from "../../harness/runtime.ts";
import { listen as listenRsa } from "../../harness/transport.ts";
import { resolveWorkspaceState } from "../../harness/workspace-state.ts";
import type { RecordEvent } from "../../harness/events.ts";
import type { BenchmarkContext, AuthorReport } from "../types.ts";
import { ReuseEnvironment } from "../fixtures/reuse-environment.ts";
import { evaluateReuse, type ReuseEvent } from "../fixtures/reuse-evaluator.ts";
import perceptionTemplate from "../../../templates/perception.py" with { type: "text" };

async function workspaceBaseline(workspace: string) {
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(join(workspace, path), { withFileTypes: true })) {
      const relative = join(path, entry.name);
      if (!path && entry.name === "logs") continue;
      if (entry.isDirectory()) await walk(relative);
      else files.push(relative);
    }
  }
  await walk("");
  const pythonFiles = files.filter(path => path.endsWith(".py"));
  const experienceFiles = files.filter(path => path.startsWith("skills/") || path.startsWith("memory/")).length;
  if (pythonFiles.length || experienceFiles) throw new Error("capability-reuse requires a new workspace with empty skills, memory, and no Python files");
  return { pythonFiles, experienceFiles };
}

/** Real Shiori + production CLI/API + a tiny simulated device, never a scripted agent. */
export async function run(ctx: BenchmarkContext): Promise<AuthorReport> {
  ctx.signal?.throwIfAborted();
  const baseline = await workspaceBaseline(ctx.workspace);
  const recordBenchmark = ctx.log.recorder({ component: "benchmark", implementation: "assembly-bench", implementationVersion: "1" });
  const environment = new ReuseEnvironment(ctx.seed, join(ctx.runDir, "bench-frames"), recordBenchmark);
  const state = await resolveWorkspaceState(ctx.workspace, join(ctx.runDir, "session-state"));
  const prefix = `/tmp/rsa-bench-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  let runtime: Runtime | undefined;
  const record: RecordEvent = (type, data, trace, metadata) => {
    ctx.log.record(type, data, trace, metadata);
    if (type === "control" && (data as { mode?: string }).mode === "auto") {
      recordBenchmark("benchmark_reuse_workspace", { ...baseline, session: "new" }, trace);
      environment.begin(trace ?? {});
    }
    if (type === "tool_end") {
      environment.afterExec(trace ?? {});
      // The operation has returned to the agent (including wait/read after a
      // background job); now stop without cancelling its final tool result.
      if (environment.done) queueMicrotask(() => { void runtime?.stop("benchmark tasks completed"); });
    }
  };
  const core = new BasewareCore({ capabilities: environment.capabilities,
    drivers: [{ id: "benchmark-assembly-bench", version: "1" }] });
  let closeBaseware: (() => Promise<void>) | undefined;
  let closeRsa: (() => Promise<void>) | undefined;
  let devices: Awaited<ReturnType<typeof connectBaseware>> | undefined;
  let epoch: string | undefined;
  const cancel = () => { void runtime?.stop("benchmark cancelled"); };
  ctx.signal?.addEventListener("abort", cancel, { once: true });
  try {
    ctx.signal?.throwIfAborted();
    closeBaseware = await listenBaseware(basewareSocket, core);
    devices = await connectBaseware({ socket: basewareSocket, seconds: ctx.seconds, runDir: ctx.runDir, record });
    await writeCapabilityDocument(devices.catalog, join(ctx.workspace, "baseware.json"));
    await writeFile(join(ctx.workspace, "perception.py"), perceptionTemplate, { flag: "wx" });
    runtime = new Runtime(devices, record, ctx.seconds, ctx.log.clock.id);
    const binDir = resolve(import.meta.dir, "../../../bin");
    const env = { RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket,
      RSA_WORKSPACE: ctx.workspace, RSA_RUN_ID: ctx.log.clock.id,
      PATH: [dirname(process.execPath), binDir, process.env.PATH ?? ""].join(":") };
    runtime.controller = new WorkspaceController({ workspace: ctx.workspace, devices, env, record });
    runtime.perception = new PerceptionRuntime({ workspace: ctx.workspace, runDir: ctx.runDir, env, record });
    devices.onHandback(reason => { void runtime!.stop(reason); });
    devices.onDisconnect(error => { void runtime!.disconnected(error); });
    closeRsa = await listenRsa(rsaSocket, runtime);
    await runtime.perception.reload();
    const { createOmpAgent } = await import("../../harness/omp/session.ts");
    runtime.agent = await createOmpAgent({ runtime, workspace: ctx.workspace, runDir: ctx.runDir, state,
      basewareSocket, rsaSocket, binDir, model: ctx.model, maxRequests: ctx.maxRequests,
      compactionThreshold: 256000, log: ctx.log });
    ctx.signal?.throwIfAborted();
    epoch = (await runtime.start("Complete both batches of assembly orders shown on the supplied display. A new batch arrives after the previous operation returns. Use the supplied capabilities and your workspace.")).epoch!;
    ctx.signal?.throwIfAborted();
    while (runtime.status().mode !== "manual" || runtime.status().thinking) await Bun.sleep(50);
    recordBenchmark("benchmark_reuse_finished", { ...environment.summary(), reason: runtime.status().reason }, { epoch });
  } finally {
    ctx.signal?.removeEventListener("abort", cancel);
    try { await runtime?.close(); }
    finally {
      devices?.close();
      await closeRsa?.(); await closeBaseware?.();
      await rm(rsaSocket, { force: true }); await rm(basewareSocket, { force: true });
    }
  }
  ctx.signal?.throwIfAborted();
  // An agent may import its helper directly without querying the registry again.
  // This read-only AST audit proves creation, never agent discovery or invocation.
  const inventory = await new PythonCapabilities(ctx.workspace).discover(ctx.signal);
  recordBenchmark("benchmark_reuse_inventory", { stage: "post-run", ...inventory }, { epoch });
  const events = (await readFile(join(ctx.runDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as ReuseEvent);
  return evaluateReuse(events, epoch!, ctx.runDir, ctx.metadata);
}
