import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PerceptionRuntime, type PerceptionRead, type PerceptionStatus } from "../../harness/perception.ts";
import type { BenchmarkContext } from "../types.ts";
import { readEvents, seqs } from "../fixtures/evidence.ts";

// Reproduces the Mario Maker cold-start boundary with an actual Python process,
// while a small JSON file stands in for model weights. No framework or device.
const implementation = `from pathlib import Path
from datetime import datetime, timezone
import json, os
from helper import transform

from rsa_tools import capability, record
class Perception:
    sample_hz = 20
    def start(self, context):
        self.model = json.loads(Path("weights.json").read_text())["value"]
        self.version = transform(self.model)
        self.sequence = 0
        with Path("initializations.txt").open("a") as output:
            output.write(str(os.getpid()) + "\\n")

    @record
    @capability
    def sample(self):
        self.sequence += 1
        value = {"pid": os.getpid(), "version": self.version, "sequence": self.sequence}
        Path("sample.txt").write_text(json.dumps(value))
        return {"text": json.dumps(value),
                "sampledAt": datetime.now(timezone.utc).isoformat(),
                "sources": [{"kind": "benchmark", "model": self.version}],
                "media": [{"path": "sample.txt", "mediaType": "text/plain"}]}

    def close(self):
        with Path("closed.txt").open("a") as output:
            output.write(str(os.getpid()) + "\\n")
`;

/** Production perception lifecycle; the fixture owns its representation. */
export async function run(ctx: BenchmarkContext): Promise<Record<string, unknown>> {
  ctx.signal?.throwIfAborted();
  await mkdir(ctx.workspace, { recursive: true });
  const record = ctx.log.recorder({ component: "benchmark", implementation: "perception-lifecycle" });
  const perception = new PerceptionRuntime({ workspace: ctx.workspace, runDir: ctx.runDir, record: ctx.log.record });
  const signal = ctx.signal ?? new AbortController().signal;
  const reload = async () => {
    await perception.reload();
    const deadline = Date.now() + 5000;
    while (perception.status().state === "loading" && Date.now() < deadline) await Bun.sleep(10);
  };
  const statuses: Record<string, PerceptionStatus> = {};
  const read = async (stage: string) => {
    signal.throwIfAborted();
    const result = await perception.observe(signal);
    statuses[stage] = perception.status();
    record("benchmark_perception_step", { stage, queryId: result.queryId, status: statuses[stage] });
    return result;
  };
  let missing!: PerceptionRead, first!: PerceptionRead, second!: PerceptionRead;
  let beforeReload!: PerceptionRead, reloaded!: PerceptionRead, failed!: PerceptionRead, repaired!: PerceptionRead;
  let historical!: PerceptionRead;
  let archived = "", archiveUnchanged = false, startsBeforeReload = 0, coldMs = 0, warmMs = 0;
  try {
    await reload();
    missing = await read("unimplemented");
    await writeFile(join(ctx.workspace, "helper.py"), "def transform(value):\n    return value + 1\n");
    await writeFile(join(ctx.workspace, "weights.json"), '{"value":10}');
    await writeFile(join(ctx.workspace, "perception.py"), implementation);
    const started = performance.now();
    await reload();
    first = await read("first");
    coldMs = performance.now() - started;
    archived = first.records[0]!.media[0]!.path!;
    const original = await readFile(archived, "utf8");
    await Bun.sleep(100); // Recorder advances while the agent does no reads.
    const warmStarted = performance.now();
    second = await read("second");
    warmMs = performance.now() - warmStarted;
    startsBeforeReload = (await readFile(join(ctx.workspace, "initializations.txt"), "utf8")).trim().split("\n").length;
    archiveUnchanged = await readFile(archived, "utf8") === original
      && original !== await readFile(join(ctx.workspace, "sample.txt"), "utf8");
    await writeFile(join(ctx.workspace, "helper.py"), "def transform(value):\n    return value + 5\n");
    await writeFile(join(ctx.workspace, "weights.json"), '{"value":20}');
    beforeReload = await read("edits-pending");
    await reload();
    reloaded = await read("reloaded");
    historical = await perception.observe(signal, {}, { at: first.records[0]!.recordedAt });
    record("benchmark_perception_step", { stage: "historical", queryId: historical.queryId });
    await writeFile(join(ctx.workspace, "perception.py"), implementation.replace(
      "self.sequence += 1", 'raise RuntimeError("fixture perception failure")'));
    await reload();
    failed = await read("failed");
    await writeFile(join(ctx.workspace, "perception.py"), implementation);
    await reload();
    repaired = await read("repaired");
  } finally {
    await perception.stop();
  }
  signal.throwIfAborted();
  await ctx.log.flush();
  const events = await readEvents(ctx.runDir);
  const evidence = (...stages: string[]) => seqs(events, event =>
    event.type === "benchmark_perception_step" && stages.includes(event.data.stage));
  const closed = (await readFile(join(ctx.workspace, "closed.txt"), "utf8")).trim().split("\n").map(Number);
  // Evidence references the workspace timeline; it is not copied into this run.
  record("benchmark_timeline_reference", { timeline: first.records[0]!.media[0]!.timeline });
  ctx.metadata.limitations = ["真实 Python 进程与生产感知管理器；JSON 数值代替模型权重，不代表 PyTorch 初始化或推理性能。未调用在线模型或设备；空状态可读不等于 Agent 已自主修复。"];
  return {
    statuses, startsBeforeReload, coldMs, warmMs, closed, archiveUnchanged,
    readings: Object.fromEntries(Object.entries({ missing, first, second, beforeReload, reloaded, failed, repaired, historical })
      .map(([name, read]) => [name, { ok: read.ok, error: read.error, records: read.records.map(({ id, text, generation, media }) =>
        ({ id, text, generation, media: media.map(({ id, timeline }) => ({ id, timeline })) })) }])),
    evidence: Object.fromEntries(["unimplemented", "first", "second", "edits-pending", "reloaded", "historical", "failed", "repaired"]
      .map(stage => [stage, evidence(stage)])),
  };
}
