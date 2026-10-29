import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasewareCore } from "@ludens/baseware/core";
import { listen as listenDevice } from "@ludens/baseware/server";
import { EventLog as DeviceLog } from "../../baseware/src/events.ts";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { connectBaseware } from "../src/harness/baseware.ts";
import { WorkspaceController } from "../src/harness/controller.ts";
import { EventLog } from "../src/harness/events.ts";
import { PerceptionRuntime } from "../src/harness/perception.ts";
import { Runtime } from "../src/harness/runtime.ts";
import { listen } from "../src/harness/transport.ts";
import { readRunEvents } from "../../shared/event-sources.ts";
import { readArtifact } from "../../shared/log-archive.ts";
import { pythonEnvironment, pythonExecutable } from "../../shared/python.ts";

async function jsonLines(path: string): Promise<any[]> {
  return (await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }))
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function storage(path: string): Promise<{files: number; bytes: number; allocatedBytes: number}> {
  const info = await stat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return {files: 0, bytes: 0, allocatedBytes: 0};
  if (!info.isDirectory()) return {files: 1, bytes: info.size, allocatedBytes: info.blocks * 512};
  const entries = await Promise.all((await readdir(path)).map(name => storage(join(path, name))));
  return entries.reduce((sum, entry) => ({files: sum.files + entry.files, bytes: sum.bytes + entry.bytes,
    allocatedBytes: sum.allocatedBytes + entry.allocatedBytes}), {files: 0, bytes: 0, allocatedBytes: 0});
}

test("resident sampling records data without per-frame audit across Python, RSA and Baseware", async () => {
  const report: Record<string, unknown>[] = [];
  for (const [hz, diagnostics] of [[1, "normal"], [10, "normal"], [30, "normal"], [1, "full"]] as const) {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-recording-flow-")));
    const runId = `sampling-${hz}-${diagnostics}`, runDir = join(workspace, "logs", runId);
    const deviceSocket = `/tmp/bw-recording-${crypto.randomUUID()}.sock`;
    const hostSocket = `/tmp/rsa-recording-${crypto.randomUUID()}.sock`;
    const log = new EventLog(runDir, { id: runId, now: () => performance.now() }, workspace, diagnostics);
    const deviceLog = new DeviceLog(join(workspace, ".device-events"), crypto.randomUUID());
    let deviceCalls = 0, rsaRpcCalls = 0, mediaRegistrations = 0;
    const core = new BasewareCore({ serviceId: deviceLog.source.sourceId, source: deviceLog.source,
      diagnostics, drivers: [{ id: "fixture", version: "1" }], record: deviceLog.record,
      capabilities: { controllers: ["top", "bottom"].map((name, index) => ({
        tool: { name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, requiresControl: false,
        async execute() {
          deviceCalls++;
          const data = Buffer.from(encodeRawPng(new Uint8Array(32 * 32 * 3).fill(60 + index * 100), 32, 32, 3)).toString("base64");
          const timing = { clock: deviceLog.source.sourceId, requestedAtMs: performance.now(), receivedAtMs: performance.now() };
          return { id: crypto.randomUUID(), result: { content: [{ type: "image" as const, data, mimeType: "image/png" }] },
            observations: [{ id: crypto.randomUUID(), controllerId: name, mediaType: "image/png", contentIndex: 0, timing }],
            status: "completed" as const, exitCode: 0, stdout: "", stderr: "", timing };
        },
      })) } });
    const closeDevice = await listenDevice(deviceSocket, core);
    const devices = await connectBaseware({ socket: deviceSocket, seconds: 60, runDir, record: log.record });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ runId, workspace, eventSources: devices.eventSources, logging: { diagnostics } }));
    const env = pythonEnvironment({ RSA_SOCKET: hostSocket, RSA_WORKSPACE: workspace, RSA_RUN_ID: runId, RSA_LOG_DIAGNOSTICS: diagnostics });
    const runtime = new Runtime(devices, log.record, 60, runId, diagnostics);
    runtime.controller = new WorkspaceController({ workspace, devices, record: log.record, env });
    runtime.perception = new PerceptionRuntime({ workspace, runDir, record: log.record, env, diagnostics,
      registerMedia: media => { mediaRegistrations++; log.registerMedia(media); } });
    const closeHost = await listen(hostSocket, () => { rsaRpcCalls++; return runtime; });
    try {
      await writeFile(join(workspace, "senses.py"), `from rsa_tools import Client, capability
device = Client()
@capability
def view(name):
    result = device.call("controller/" + name)
    block = result["result"]["content"][0]
    return {"media": [{"data": block["data"], "mediaType": block["mimeType"]}]}
@capability
def pair():
    return {"media": view("top")["media"] + view("bottom")["media"], "data": {"screens": 2}}
`);
      await writeFile(join(workspace, "perception.py"), `from rsa_tools import capability, record
from senses import pair
class Perception:
    sample_hz = ${hz}
    def start(self, context): pass
    @record
    @capability
    def sample(self): return pair()
    def close(self): pass
`);
      await runtime.start();
      expect((await runtime.perception.reload()).state).not.toBe("error");
      const started = performance.now();
      await Bun.sleep(6100);
      expect(runtime.perception.status().state).toBe("ready");
      const observed = await runtime.perception.observe(new AbortController().signal);
      expect(observed.error).toBeUndefined();
      expect(observed.records.flatMap(record => record.media)).toHaveLength(2);
      const image = observed.records[0]!.media[0]!;
      const modelInput = log.artifact({ type: "image", mimeType: image.mediaType, data: image.data });
      expect((await readArtifact(runDir, modelInput)).data.$media).toMatchObject({ asset: image.timeline!.asset, status: "referenced", video: image.timeline!.video });
      await runtime.perception.stop();
      const elapsedSeconds = (performance.now() - started) / 1000;
      await runtime.stop("fixture completed");
      devices.close();
      await core.close();

      const segments = join(workspace, ".rsa/timeline/segments");
      const records = (await Promise.all((await readdir(segments)).filter(name => name.endsWith(".jsonl")).map(name => jsonLines(join(segments, name))))).flat();
      const local = await jsonLines(join(runDir, "events.jsonl"));
      const events = await Array.fromAsync(readRunEvents(runDir));
      const detailed = await Array.fromAsync(readRunEvents(runDir, { channel: "diagnostics" }));
      const perCall = ["python_call_start", "python_call_end", "capability_start", "capability_end", "command", "execution", "observation", "observation_start", "observation_end", "perception_sample", "timeline_media"];
      expect(records.length).toBeGreaterThanOrEqual(hz * 2);
      expect(records.every(record => record.data.screens === 2 && record.media.length === 2)).toBe(true);
      expect(deviceCalls).toBe(records.length * 2);
      expect(rsaRpcCalls).toBe(deviceCalls); // No workspace_event logging RPCs, including through the nested helper.
      expect(mediaRegistrations).toBeGreaterThanOrEqual(records.length * 2);
      expect(events.filter(event => perCall.includes(event.type))).toHaveLength(0);
      expect(local.every(event => event.source.component !== "baseware")).toBe(true);
      const stats = events.filter(event => event.type === "perception_stats");
      expect(stats.length).toBeGreaterThanOrEqual(2);
      expect(stats.length).toBeLessThanOrEqual(3);
      expect(stats.reduce((sum, event) => sum + event.data.sample.recorded, 0)).toBe(records.length);
      const subjects = stats.flatMap(event => event.data.capabilities);
      expect(subjects.some(subject => subject.id === "python/senses.py:pair" && subject.codeSHA && subject.calls > 0)).toBe(true);
      const deviceStats = events.filter(event => event.type === "device_sampling_stats");
      expect(deviceStats.length).toBeGreaterThanOrEqual(2);
      expect(deviceStats.reduce((sum, event) => sum + event.data.controllers.reduce((n: number, controller: any) => n + controller.calls, 0), 0)).toBe(deviceCalls);
      if (diagnostics === "normal") expect(detailed).toHaveLength(0);
      else {
        expect(detailed.filter(event => event.type === "command")).toHaveLength(deviceCalls);
        expect(detailed.filter(event => event.type === "python_call_start")).toHaveLength(records.length * 4);
        expect(detailed.every(event => event.channel === "diagnostic")).toBe(true);
      }
      expect((await readdir(join(runDir, "perception", runtime.perception.status().generation!))).includes("stderr.log")).toBe(true);
      expect(await readFile(join(runDir, "perception", runtime.perception.status().generation!, "stderr.log"), "utf8")).toBe("");
      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      expect(manifest.eventSources).toHaveLength(1);
      expect(manifest.eventSources[0]).toMatchObject({ ...deviceLog.source, recordingId: runId,
        windows: [{ afterSeq: 0, throughSeq: core.status().seq }] });

      // A new Python process reads the same closed video, without starting or repairing a sampler.
      const cold = Bun.spawn([pythonExecutable(env), "-c", `import json
from rsa_tools._observation_history import ObservationHistory
history = ObservationHistory(${JSON.stringify(workspace)})
try:
    value = history.observe({"id": ${JSON.stringify(records[0].id)}})
    print(json.dumps({"id": value["records"][0]["id"], "media": len(value["records"][0]["media"])}))
finally: history.close()`], { env, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(cold.stdout).text(), new Response(cold.stderr).text(), cold.exited]);
      expect({ error, code }).toEqual({ error: "", code: 0 });
      expect(JSON.parse(output)).toEqual({ id: records[0].id, media: 2 });
      report.push({ diagnostics, sampleHz: hz, samples: records.length, elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        observedHz: Number((records.length / elapsedSeconds).toFixed(2)), deviceCalls, rsaRpcCalls,
        localEvents: local.length, totalEvents: events.length, diagnosticEvents: detailed.length,
        samplingSummaries: stats.length, deviceSummaries: deviceStats.length, mediaRegistrations,
        coldQuery: "passed", storage: {
          runEvents: await storage(join(runDir, "events.jsonl")),
          runDiagnostics: await storage(join(runDir, "diagnostics.jsonl")),
          baseware: await storage(deviceLog.source.root),
          timeline: await storage(join(workspace, ".rsa/timeline")),
          archive: await storage(join(workspace, ".rsa/archive")),
        }, rssMiB: Number((process.memoryUsage().rss / 1024 ** 2).toFixed(1)) });
    } finally {
      await runtime.close(); devices.close(); await closeHost(); await closeDevice();
      await rm(hostSocket, { force: true }); await rm(workspace, { recursive: true, force: true });
    }
  }
  console.log("recording-integration", JSON.stringify(report));
  if (process.env.RSA_RECORDING_REPORT) await writeFile(process.env.RSA_RECORDING_REPORT, JSON.stringify(report, null, 2) + "\n");
}, 60000);
