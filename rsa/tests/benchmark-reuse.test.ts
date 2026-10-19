import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BasewareCore } from "@playness/baseware/core";
import { listen as listenBaseware } from "@playness/baseware/server";
import { connectBaseware } from "../src/harness/baseware.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { PythonCapabilities, pythonModulePaths } from "../src/harness/python-capabilities.ts";
import { EventLog, type RecordEvent } from "../src/harness/events.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { listen as listenRsa } from "../src/harness/transport.ts";
import { renderBoard } from "../src/benchmark/fixtures/reuse-board.ts";
import { ReuseEnvironment } from "../src/benchmark/fixtures/reuse-environment.ts";
import { evaluateReuse, type ReuseEvent } from "../src/benchmark/fixtures/reuse-evaluator.ts";

const passed = (events: ReuseEvent[], epoch: string, id: string) => evaluateReuse(events, epoch).checks.find(check => check.id === id)?.passed;

test("the benchmark sensor emits an actual readable, deterministic PNG", async () => {
  const view = { phase: 1, order: 1, completed: 0, values: [0, 0, 0], target: [2, 4, 1], waiting: false, done: false, notice: "READY" };
  const bytes = renderBoard(view);
  expect(bytes.equals(renderBoard(view))).toBe(true);
  expect((await new Bun.Image(bytes).metadata())).toMatchObject({ width: 960, height: 580, format: "png" });
  const next = renderBoard({ ...view, phase: 2, values: [2, 4, 1], target: [5, 7, 8] });
  expect(bytes.equals(next)).toBe(false);
});

test("the environment rejects wrong values and holds the next batch until the current operation returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsa-bench-board-"));
  const events: { type: string; data: any }[] = [];
  const environment = new ReuseEnvironment(11, directory, (type, data) => events.push({ type, data }));
  const controller = environment.capabilities.controllers[0]!;
  const context = { epoch: "fixture", signal: new AbortController().signal };
  let random = 11;
  const digit = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % 9 + 1; };
  try {
    expect((await controller.execute(["submit"], context)).exitCode).toBe(2);
    for (let order = 0; order < 3; order++) {
      for (let slot = 1; slot <= 3; slot++) await controller.execute(["set", String(slot), String(digit())], context);
      expect((await controller.execute(["submit"], context)).exitCode).toBe(0);
    }
    expect(environment.summary()).toEqual({ completed: 3, expected: 6, phase: 1 });
    expect((await controller.execute(["set", "1", "1"], context)).exitCode).toBe(2);
    environment.afterExec({ epoch: "fixture" });
    expect(environment.summary()).toEqual({ completed: 3, expected: 6, phase: 2 });
    expect(events.filter(event => event.type === "benchmark_reuse_phase")).toHaveLength(1);
    expect((await controller.execute(["set", "1", "1"], context)).exitCode).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const route of ["controller", "import"] as const) test(`evaluator proves productive ${route} reuse across batches, and rejects look-alikes`, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rsa-bench-eval-"));
  const runDir = join(workspace, "logs", "fixture");
  const log = new EventLog(runDir, { id: "reuse-fixture", now: () => performance.now() });
  const recordBenchmark = log.recorder({ component: "benchmark" });
  const environment = new ReuseEnvironment(17, join(runDir, "frames"), recordBenchmark);
  const record: RecordEvent = (type, data, trace, metadata) => {
    log.record(type, data, trace, metadata);
    if (type === "control" && (data as { mode: string }).mode === "auto") {
      recordBenchmark("benchmark_reuse_workspace", { pythonFiles: [], experienceFiles: 0, session: "new" }, trace);
      environment.begin(trace!);
    }
    if (type === "exec_result") environment.afterExec(trace!);
  };
  const prefix = `/tmp/rsa-bench-test-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  const core = new BasewareCore({ capabilities: environment.capabilities, drivers: [{ id: "fixture", version: "1" }] });
  const closeBaseware = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({ socket: basewareSocket, runDir, seconds: 60, record });
  const runtime = new Runtime(devices, record, 60, "reuse-fixture");
  const env = { ...process.env, RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket,
    PYTHONPATH: pythonModulePaths().join(":"),
    PATH: [dirname(process.execPath), join(import.meta.dir, "../bin"), process.env.PATH ?? ""].join(":") };
  runtime.controller = new WorkspaceController({ workspace, devices, env, record });
  const closeRsa = await listenRsa(rsaSocket, runtime);
  const epoch = (await runtime.start()).epoch!;
  let round = 0;
  const exec = async (command: string[]) => {
    const trace = { epoch, traceId: "0123456789abcdef0123456789abcdef", spanId: String(++round).padStart(16, "0"), modelCallId: `model-${round}` };
    log.record("model_start", {}, trace);
    log.record("exec", { command: command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ") }, trace);
    const child = Bun.spawn(command, { cwd: workspace,
      env: { ...env, BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify(trace) }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    record("exec_result", { stdout, stderr, exitCode }, trace);
    expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
    return stdout;
  };
  const cli = (...args: string[]) => exec([join(import.meta.dir, "../bin/rsa"), "controller", ...args]);
  try {
    const initial = JSON.parse(await cli("list"));
    expect(initial.capabilities.map((item: any) => item.id)).toEqual(["controller/bench", "controller/screen"]);
    // Test-only agent fixture. The live case never supplies this code or solves orders.
    await mkdir(join(workspace, "scripts"));
    const source = `from rsa_tools import Client, capability
${route === "controller" ? "@capability\n" : ""}
def configure(values: list[int]) -> dict:
    """Set all three dials and submit the assembled order."""
    client = Client()
    for slot, value in enumerate(values, 1):
        client.call("controller/bench", ["set", str(slot), str(value)])
    return client.call("controller/bench", ["submit"])
`;
    // The import route is an ordinary helper, with no registry decorator.
    if (route === "import") log.record("tool_start", { toolName: "write", args: { path: "scripts/bench.py", content: source } },
      { epoch, traceId: "write-trace", spanId: "write-span" });
    await writeFile(join(workspace, "scripts", "bench.py"), source);
    if (route === "import") log.record("tool_end", { toolName: "write", isError: false },
      { epoch, traceId: "write-trace", spanId: "write-span" });
    else expect(JSON.parse(await cli("list")).capabilities.at(-1).id).toBe("python/scripts/bench.py:configure");
    let random = 17;
    const digit = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % 9 + 1; };
    for (let order = 0; order < 6; order++) {
      const values = [digit(), digit(), digit()];
      if (route === "controller") await cli("python/scripts/bench.py:configure", "--args", JSON.stringify({ values }));
      else await exec(["python3", "-c", `from scripts.bench import configure as build\nprint(build(${JSON.stringify(values)}))`]);
    }
    recordBenchmark("benchmark_reuse_finished", environment.summary(), { epoch });
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as ReuseEvent);
    const outcome = evaluateReuse(events, epoch);
    expect(outcome.checks.every(check => check.passed === true)).toBe(true);
    expect(outcome.metrics.find(metric => metric.id === "productive-capability-calls")?.value).toBe(6);
    expect(outcome.metrics.find(metric => metric.id === "productive-reuse-calls")?.value).toBe(3);
    expect(outcome.metrics.find(metric => metric.id === "phase-1-orders")?.value).toBe(3);
    expect(outcome.metrics.find(metric => metric.id === "phase-2-orders")?.value).toBe(3);
    expect(outcome.checks.find(check => check.id === "capability-reused")?.evidenceSeq.length).toBeGreaterThan(12);
    expect(outcome.metrics.find(metric => metric.id === `${route}-productive-calls`)?.value).toBe(6);
    expect(outcome.metrics.find(metric => metric.id === "controller-discovered")?.value).toBe(route === "controller" ? 1 : 0);

    if (route === "import") {
      for (const code of [
        "from scripts.bench import configure", // Import alone is not an invocation.
        "from scripts.bench import configure\nif False: configure([1,2,3])", // Dead branch.
        "from scripts.bench import configure\nconfigure([1,2,3])\nmanual_driver_call()", // Mixed operations are ambiguous.
      ]) {
        const ambiguous = structuredClone(events);
        for (const event of ambiguous.filter(event => event.type === "exec")) event.data.command = `python3 - <<'PY'\n${code}\nPY`;
        expect(passed(ambiguous, epoch, "capability-reused")).toBeNull();
      }
      const failedExec = structuredClone(events);
      for (const event of failedExec.filter(event => event.type === "exec_result")) event.data.exitCode = 1;
      expect(passed(failedExec, epoch, "capability-reused")).toBeNull();
      const failedWrite = structuredClone(events);
      failedWrite.find(event => event.type === "tool_end")!.data.isError = true;
      expect(passed(failedWrite, epoch, "capability-created")).toBe(false);
      expect(passed(failedWrite, epoch, "capability-reused")).toBeNull();
      const emptyHelper = structuredClone(events);
      emptyHelper.find(event => event.type === "tool_start")!.data.args.content = "def configure(values):\n    return None\n";
      expect(passed(emptyHelper, epoch, "capability-reused")).toBeNull();
    }

    // Invocation does its own AST lookup, but that is not an explicit discovery.
    const noDiscovery = events.filter(event => !(event.type === "capability_start" && event.data.action === "list"));
    expect(passed(noDiscovery, epoch, "capability-created")).toBe(true);
    expect(evaluateReuse(noDiscovery, epoch).metrics.find(metric => metric.id === "controller-discovered")?.value).toBe(0);
    expect(passed(noDiscovery, epoch, "capability-reused")).toBe(true);

    if (route === "controller") {
    // Independent post-run AST inventory can prove creation when the agent used
    // direct imports, but must never impersonate agent discovery or registry use.
    const audited = await new PythonCapabilities(workspace).discover();
    const inventory: ReuseEvent = { seq: Math.max(...events.map(event => event.seq)) + 1,
      type: "benchmark_reuse_inventory", source: { component: "benchmark" }, trace: { epoch },
      data: { stage: "post-run", ...audited } };
    const inventoryOnly = [...events.filter(event => !event.type.startsWith("python_capabilit")), inventory];
    expect(passed(inventoryOnly, epoch, "task-completed")).toBe(true);
    expect(passed(inventoryOnly, epoch, "capability-created")).toBe(true);
    expect(evaluateReuse(inventoryOnly, epoch).metrics.find(metric => metric.id === "controller-discovered")?.value).toBe(0);
    expect(passed(inventoryOnly, epoch, "capability-reused")).toBeNull();
    expect(evaluateReuse(inventoryOnly, epoch).checks.find(check => check.id === "capability-created")?.evidenceSeq).toEqual([inventory.seq]);
    const untrustedInventory = structuredClone(inventoryOnly);
    untrustedInventory.at(-1)!.source = { component: "rsa" };
    expect(passed(untrustedInventory, epoch, "capability-created")).toBe(false);
    const wrongStage = structuredClone(inventoryOnly);
    wrongStage.at(-1)!.data.stage = "agent-turn";
    expect(passed(wrongStage, epoch, "capability-created")).toBe(false);
    }

    // Manual orders plus unrelated successful Python calls are not productive reuse.
    const unlinked = structuredClone(events);
    for (const event of unlinked.filter(event => event.type === "execution")) event.trace.parentSpanId = "unrelated-manual";
    expect(passed(unlinked, epoch, "task-completed")).toBe(true);
    expect(passed(unlinked, epoch, "capability-reused")).toBeNull();

    // A success-looking summary without real Baseware completions is not a pass.
    const noExecutions = events.filter(event => event.type !== "execution");
    expect(passed(noExecutions, epoch, "task-completed")).toBe(false);
    expect(passed(noExecutions, epoch, "capability-reused")).toBeNull();

    // One model round, different epochs, failed macros, and prefilled abilities fail learning checks.
    const sameRound = structuredClone(events);
    for (const event of sameRound) if (event.trace.modelCallId) event.trace.modelCallId = "one-round";
    expect(passed(sameRound, epoch, "capability-reused")).toBeNull();
    const splitEpoch = structuredClone(events), transfer = splitEpoch.find(event => event.type === "benchmark_reuse_phase" && event.data.phase === 2)!.seq;
    for (const event of splitEpoch) if (event.seq >= transfer) event.trace.epoch = "other-epoch";
    expect(passed(splitEpoch, epoch, "capability-reused")).toBeNull();
    const failed = structuredClone(events);
    for (const event of failed.filter(event => event.type === "python_capability_result")) event.data.outcome = "error";
    if (route === "controller") expect(passed(failed, epoch, "capability-reused")).toBeNull();
    const prefilled = structuredClone(events);
    prefilled.find(event => event.type === "benchmark_reuse_workspace")!.data.pythonFiles = ["scripts/bench.py"];
    expect(passed(prefilled, epoch, "fresh-workspace")).toBe(false);
    expect(passed(prefilled, epoch, "capability-created")).toBe(false);
    expect(passed(prefilled, epoch, "capability-reused")).toBeNull();
  } finally {
    await runtime.close(); devices.close(); await closeRsa(); await closeBaseware();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30000);
