import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventLog as DeviceEventLog } from "../../baseware/src/events.ts";
import { readRunEvents } from "../../shared/event-sources.ts";
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
import { evaluateReuse, type ReuseEvent } from "../benchmarks/tasks/capability-reuse/tests/evaluate.ts";
import { freezeReuseEvents } from "../src/benchmark/fixtures/reuse-facts.ts";
import { readArtifactSync } from "../../shared/log-archive.ts";

const passed = (events: ReuseEvent[], epoch: string, id: string, runDir?: string) =>
  evaluateReuse(runDir ? freezeReuseEvents(events, runDir) : events, epoch).checks![id]?.passed;

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
  const [set, submit] = environment.capabilities.controllers;
  const context = { epoch: "fixture", signal: new AbortController().signal };
  let random = 11;
  const digit = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % 9 + 1; };
  try {
    expect((await submit!.execute({}, context)).exitCode).toBe(2);
    for (let order = 0; order < 3; order++) {
      for (let slot = 1; slot <= 3; slot++) await set!.execute({slot, value: digit()}, context);
      expect((await submit!.execute({}, context)).exitCode).toBe(0);
    }
    expect(environment.summary()).toEqual({ completed: 3, expected: 6, phase: 1 });
    expect((await set!.execute({slot: 1, value: 1}, context)).exitCode).toBe(2);
    environment.afterExec({ epoch: "fixture" });
    expect(environment.summary()).toEqual({ completed: 3, expected: 6, phase: 2 });
    expect(events.filter(event => event.type === "benchmark_reuse_phase")).toHaveLength(1);
    expect((await set!.execute({slot: 1, value: 1}, context)).exitCode).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const route of ["controller", "local", "import"] as const) test(`evaluator proves productive ${route} reuse across batches, and rejects look-alikes`, async () => {
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
    if (type === "tool_end") environment.afterExec(trace!);
  };
  const prefix = `/tmp/rsa-bench-test-${crypto.randomUUID()}`;
  const basewareSocket = `${prefix}-b.sock`, rsaSocket = `${prefix}-r.sock`;
  const deviceLog = new DeviceEventLog(join(runDir, "device-sources"), crypto.randomUUID());
  const core = new BasewareCore({ serviceId: deviceLog.source.sourceId, source: deviceLog.source, record: deviceLog.record, capabilities: environment.capabilities, drivers: [{ id: "fixture", version: "1" }] });
  const closeBaseware = await listenBaseware(basewareSocket, core);
  const devices = await connectBaseware({ socket: basewareSocket, runDir, seconds: 60, record });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({workspace, eventSources: devices.eventSources}));
  const runtime = new Runtime(devices, record, 60, "reuse-fixture");
  const env = { ...process.env, RSA_SOCKET: rsaSocket, BASEWARE_SOCKET: basewareSocket,
    RSA_WORKSPACE: workspace, RSA_RUN_ID: runtime.status().runId,
    PYTHONPATH: pythonModulePaths().join(":"),
    PATH: [dirname(process.execPath), join(import.meta.dir, "../bin"), process.env.PATH ?? ""].join(":") };
  runtime.controller = new WorkspaceController({ workspace, devices, env, record });
  const closeRsa = await listenRsa(rsaSocket, runtime);
  const epoch = (await runtime.start()).epoch!;
  let round = 0;
  const exec = async (command: string[]) => {
    const trace = { epoch, traceId: "0123456789abcdef0123456789abcdef", spanId: String(++round).padStart(16, "0"), modelCallId: `model-${round}` };
    log.record("model_start", {}, trace);
    log.record("tool_start", { toolName: "bash", args: {
      command: command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" "),
    } }, trace);
    const child = Bun.spawn(command, { cwd: workspace,
      env: { ...env, BASEWARE_EPOCH: epoch, BASEWARE_TRACE: JSON.stringify(trace) }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    record("tool_end", { toolName: "bash", isError: exitCode !== 0,
      result: log.artifact({ content: [{ type: "text", text: stdout + stderr }],
        details: exitCode ? { exitCode } : {} }) }, trace);
    expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
    return stdout;
  };
  const cli = (...args: string[]) => exec([join(import.meta.dir, "../bin/rsa"), "controller", ...args]);
  try {
    const initial = JSON.parse(await cli("list"));
    expect(initial.capabilities.map((item: any) => item.id)).toEqual(["controller/bench.set", "controller/bench.submit", "controller/screen.capture"]);
    // Test-only agent fixture. The live case never supplies this code or solves orders.
    await mkdir(join(workspace, "scripts"));
    const source = `from rsa_tools import Client, capability
${route !== "import" ? "@capability\n" : ""}
def configure(values: list[int]) -> dict:
    """Set all three dials and submit the assembled order."""
    client = Client()
    for slot, value in enumerate(values, 1):
        client.call("controller/bench.set", {"slot": slot, "value": value})
    return client.call("controller/bench.submit", {})
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
      else if (route === "local") await exec(["python3", "-c", `from rsa_tools import Client\nprint(Client().call("python/scripts/bench.py:configure", {"values": ${JSON.stringify(values)}}))`]);
      else await exec(["python3", "-c", `from scripts.bench import configure as build\nprint(build(${JSON.stringify(values)}))`]);
    }
    recordBenchmark("benchmark_reuse_finished", environment.summary(), { epoch });
    const events: ReuseEvent[] = [];
    for await (const event of readRunEvents(runDir)) events.push(event as unknown as ReuseEvent);
    const judge = (records: ReuseEvent[]) => evaluateReuse(freezeReuseEvents(records, runDir), epoch);
    const check = (records: ReuseEvent[], id: string) => passed(records, epoch, id, runDir);
    const outcome = judge(events);
    expect(Object.values(outcome.checks!).filter(check => check.passed !== true)).toEqual([]);
    // The same execution evidence must keep its verdict when argument/result
    // bodies become shared references; accepting an async launch is still not completion.
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ workspace, eventSources: devices.eventSources }));
    const indexed = new EventLog(runDir, log.clock, workspace);
    const referenced = events.map(event => {
      if (event.type === "tool_end" && event.data.result) return { ...event, data: { ...event.data,
        result: indexed.artifact(readArtifactSync(runDir, event.data.result, { media: "reference" })) } };
      if (event.type !== "tool_start") return event;
      const { args, ...metadata } = event.data;
      return { ...event, data: { ...metadata, argsRef: indexed.artifact(args) } };
    });
    expect(judge(referenced)).toEqual(outcome);
    expect(outcome.metrics!["productive-capability-calls"]?.value).toBe(6);
    expect(outcome.metrics!["productive-reuse-calls"]?.value).toBe(3);
    expect(outcome.metrics!["phase-1-orders"]?.value).toBe(3);
    expect(outcome.metrics!["phase-2-orders"]?.value).toBe(3);
    expect(outcome.checks!["capability-reused"]?.evidenceSeq?.length).toBeGreaterThan(12);
    expect(outcome.metrics![`${route}-productive-calls`]?.value).toBe(6);
    expect(outcome.metrics!["controller-discovered"]?.value).toBe(route !== "import" ? 1 : 0);

    if (route === "import") {
      for (const details of [{ async: { state: "running", jobId: "bg_1" } }, { exitCode: 1 }]) {
        const incomplete = referenced.map(event => event.type === "tool_end" && event.data.toolName === "bash"
          ? { ...event, data: { ...event.data, result: indexed.artifact({ content: [], details }) } } : event);
        expect(check(incomplete, "capability-reused")).toBeNull();
      }
      const missing = { encoding: "rsa-json-v1", path: `objects/${"0".repeat(64)}.json.gz`, sha256: "0".repeat(64), bytes: 0 };
      for (const field of ["argsRef", "result"]) {
        const absent = referenced.map(event => event.data.toolName === "bash" && field in event.data
          ? { ...event, data: { ...event.data, [field]: missing } } : event);
        expect(check(absent, "capability-reused")).toBeNull();
      }
      for (const code of [
        "from scripts.bench import configure", // Import alone is not an invocation.
        "from scripts.bench import configure\nif False: configure([1,2,3])", // Dead branch.
        "from scripts.bench import configure\nconfigure([1,2,3])\nmanual_driver_call()", // Mixed operations are ambiguous.
      ]) {
        const ambiguous = structuredClone(events);
        for (const event of ambiguous.filter(event => event.type === "tool_start" && event.data.toolName === "bash"))
          event.data.args.command = `python3 - <<'PY'\n${code}\nPY`;
        expect(check(ambiguous, "capability-reused")).toBeNull();
      }
      const failedExec = structuredClone(events);
      for (const event of failedExec.filter(event => event.type === "tool_end" && event.data.toolName === "bash")) event.data.isError = true;
      expect(check(failedExec, "capability-reused")).toBeNull();
      const background = structuredClone(events);
      for (const event of background.filter(event => event.type === "tool_end" && event.data.toolName === "bash"))
        event.data.result = log.artifact({ content: [], details: { async: { state: "running", jobId: "bg_1" } } });
      expect(check(background, "capability-reused")).toBeNull();
      // Historical exec/exec_result logs remain readable after new runs switch
      // to native tool results and artifact-backed details.
      const legacy = structuredClone(events);
      for (const event of legacy.filter(event => event.data.toolName === "bash")) {
        if (event.type === "tool_start") {
          event.type = "exec"; event.data = { command: event.data.args.command };
        } else if (event.type === "tool_end") {
          event.type = "exec_result"; event.data = { exitCode: 0 };
        }
      }
      expect(passed(legacy, epoch, "capability-reused")).toBe(true);
      const failedWrite = structuredClone(events);
      failedWrite.find(event => event.type === "tool_end" && event.data.toolName === "write")!.data.isError = true;
      expect(check(failedWrite, "capability-created")).toBe(false);
      expect(check(failedWrite, "capability-reused")).toBeNull();
      const emptyHelper = structuredClone(events);
      emptyHelper.find(event => event.type === "tool_start" && event.data.toolName === "write")!.data.args.content = "def configure(values):\n    return None\n";
      expect(check(emptyHelper, "capability-reused")).toBeNull();
    }

    // Invocation does its own AST lookup, but that is not an explicit discovery.
    const noDiscovery = events.filter(event => !(event.type === "capability_start" && event.data.action === "list"));
    expect(check(noDiscovery, "capability-created")).toBe(true);
    expect(judge(noDiscovery).metrics!["controller-discovered"]?.value).toBe(0);
    expect(check(noDiscovery, "capability-reused")).toBe(true);

    if (route === "controller") {
    // Independent post-run AST inventory can prove creation when the agent used
    // direct imports, but must never impersonate agent discovery or registry use.
    const audited = await new PythonCapabilities(workspace).discover();
    const inventory: ReuseEvent = { seq: Math.max(...events.map(event => event.seq)) + 1,
      type: "benchmark_reuse_inventory", source: { component: "benchmark" }, trace: { epoch },
      data: { stage: "post-run", ...audited } };
    const inventoryOnly = [...events.filter(event => !event.type.startsWith("python_capabilit") && !event.type.startsWith("python_call_")), inventory];
    expect(check(inventoryOnly, "task-completed")).toBe(true);
    expect(check(inventoryOnly, "capability-created")).toBe(true);
    expect(judge(inventoryOnly).metrics!["controller-discovered"]?.value).toBe(0);
    expect(check(inventoryOnly, "capability-reused")).toBeNull();
    expect(judge(inventoryOnly).checks!["capability-created"]?.evidenceSeq).toEqual([inventory.seq]);
    const untrustedInventory = structuredClone(inventoryOnly);
    untrustedInventory.at(-1)!.source = { component: "rsa" };
    expect(check(untrustedInventory, "capability-created")).toBe(false);
    const wrongStage = structuredClone(inventoryOnly);
    wrongStage.at(-1)!.data.stage = "agent-turn";
    expect(check(wrongStage, "capability-created")).toBe(false);
    }

    // Manual orders plus unrelated successful Python calls are not productive reuse.
    const unlinked = structuredClone(events);
    for (const event of unlinked.filter(event => event.type === "execution")) event.trace.parentSpanId = "unrelated-manual";
    expect(check(unlinked, "task-completed")).toBe(true);
    expect(check(unlinked, "capability-reused")).toBeNull();

    // A success-looking summary without real Baseware completions is not a pass.
    const noExecutions = events.filter(event => event.type !== "execution");
    expect(check(noExecutions, "task-completed")).toBe(false);
    expect(check(noExecutions, "capability-reused")).toBeNull();

    // One model round, different epochs, failed macros, and prefilled abilities fail learning checks.
    const sameRound = structuredClone(events);
    for (const event of sameRound) if (event.trace.modelCallId) event.trace.modelCallId = "one-round";
    expect(check(sameRound, "capability-reused")).toBeNull();
    const splitEpoch = structuredClone(events), transfer = splitEpoch.find(event => event.type === "benchmark_reuse_phase" && event.data.phase === 2)!.seq;
    for (const event of splitEpoch) if (event.seq >= transfer) event.trace.epoch = "other-epoch";
    expect(check(splitEpoch, "capability-reused")).toBeNull();
    const failed = structuredClone(events);
    for (const event of failed.filter(event => event.type === "python_capability_result" || event.type === "python_call_end")) event.data.outcome = "error";
    if (route !== "import") expect(check(failed, "capability-reused")).toBeNull();
    const prefilled = structuredClone(events);
    prefilled.find(event => event.type === "benchmark_reuse_workspace")!.data.pythonFiles = ["scripts/bench.py"];
    expect(check(prefilled, "fresh-workspace")).toBe(false);
    expect(check(prefilled, "capability-created")).toBe(false);
    expect(check(prefilled, "capability-reused")).toBeNull();
  } finally {
    await runtime.close(); devices.close(); await closeRsa(); await closeBaseware();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30000);
