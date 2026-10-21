import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PerceptionRuntime, type PerceptionRead } from "../../harness/perception.ts";
import type { BenchmarkContext, AuthorReport } from "../types.ts";
import { readEvents, seqs } from "../fixtures/evidence.ts";

// Reproduces the Mario Maker cold-start boundary with an actual Python process,
// while a small JSON file stands in for model weights. No framework or device.
const implementation = `from pathlib import Path
from datetime import datetime, timezone
import json, os
from helper import transform

class Perception:
    def start(self, context):
        self.model = json.loads(Path("weights.json").read_text())["value"]
        self.version = transform(self.model)
        self.sequence = 0
        with Path("initializations.txt").open("a") as output:
            output.write(str(os.getpid()) + "\\n")

    def observe(self):
        self.sequence += 1
        value = {"pid": os.getpid(), "version": self.version, "sequence": self.sequence}
        Path("sample.txt").write_text(json.dumps(value))
        return {"sequence": self.sequence, "text": json.dumps(value),
                "sampledAt": datetime.now(timezone.utc).isoformat(),
                "sources": [{"kind": "benchmark", "model": self.version}],
                "media": [{"path": "sample.txt", "mediaType": "text/plain"}]}

    def close(self):
        with Path("closed.txt").open("a") as output:
            output.write(str(os.getpid()) + "\\n")
`;

/** Production perception lifecycle; the fixture owns its representation. */
export async function run(ctx: BenchmarkContext): Promise<AuthorReport> {
  ctx.signal?.throwIfAborted();
  await mkdir(ctx.workspace, { recursive: true });
  const record = ctx.log.recorder({ component: "benchmark", implementation: "perception-lifecycle" });
  const perception = new PerceptionRuntime({ workspace: ctx.workspace, runDir: ctx.runDir, record: ctx.log.record });
  const signal = ctx.signal ?? new AbortController().signal;
  const read = async (stage: string) => {
    signal.throwIfAborted();
    const result = await perception.observe(signal);
    record("benchmark_perception_step", { stage, ...result });
    return result;
  };
  const value = (result: PerceptionRead): { pid: number; version: number; sequence: number } =>
    JSON.parse(result.result.stdout);
  let missing!: PerceptionRead, first!: PerceptionRead, second!: PerceptionRead;
  let beforeReload!: PerceptionRead, reloaded!: PerceptionRead, failed!: PerceptionRead, repaired!: PerceptionRead;
  let archived = "", archiveUnchanged = false, startsBeforeReload = 0, coldMs = 0, warmMs = 0;
  try {
    await perception.reload();
    missing = await read("unimplemented");
    await writeFile(join(ctx.workspace, "helper.py"), "def transform(value):\n    return value + 1\n");
    await writeFile(join(ctx.workspace, "weights.json"), '{"value":10}');
    await writeFile(join(ctx.workspace, "perception.py"), implementation);
    const started = performance.now();
    await perception.reload();
    first = await read("first");
    coldMs = performance.now() - started;
    archived = first.result.observations![0]!.path;
    const original = await readFile(archived, "utf8");
    const warmStarted = performance.now();
    second = await read("second");
    warmMs = performance.now() - warmStarted;
    startsBeforeReload = (await readFile(join(ctx.workspace, "initializations.txt"), "utf8")).trim().split("\n").length;
    archiveUnchanged = await readFile(archived, "utf8") === original
      && original !== await readFile(join(ctx.workspace, "sample.txt"), "utf8");
    await writeFile(join(ctx.workspace, "helper.py"), "def transform(value):\n    return value + 5\n");
    await writeFile(join(ctx.workspace, "weights.json"), '{"value":20}');
    beforeReload = await read("edits-pending");
    await perception.reload();
    reloaded = await read("reloaded");
    await writeFile(join(ctx.workspace, "perception.py"), implementation.replace(
      "self.sequence += 1", 'raise RuntimeError("fixture perception failure")'));
    await perception.reload();
    failed = await read("failed");
    await writeFile(join(ctx.workspace, "perception.py"), implementation);
    await perception.reload();
    repaired = await read("repaired");
  } finally {
    await perception.stop();
  }
  signal.throwIfAborted();
  const events = await readEvents(ctx.runDir);
  const evidence = (...stages: string[]) => seqs(events, event =>
    event.type === "benchmark_perception_step" && stages.includes(event.data.stage));
  const v1 = value(first), v2 = value(second), held = value(beforeReload), fresh = value(reloaded), fixed = value(repaired);
  const closed = (await readFile(join(ctx.workspace, "closed.txt"), "utf8")).trim().split("\n").map(Number);
  ctx.metadata.artifacts = [{ path: relative(ctx.runDir, archived), label: "首次感知结果的不可变归档" }];
  ctx.metadata.limitations = ["真实 Python 进程与生产感知管理器；JSON 数值代替模型权重，不代表 PyTorch 初始化或推理性能。未调用在线模型或设备；空状态可读不等于 Agent 已自主修复。"];
  return {
    checks: {
      "empty-bootstrap": { label: "空实现可自举", passed: missing.status.state === "unimplemented"
        && !!missing.result.stdout && !missing.result.observations?.length,
        expected: "返回 unimplemented 与诊断文字，无默认媒体、不抛异常", actual: JSON.stringify(missing.status),
        evidenceSeq: evidence("unimplemented") },
      "persistent-model": { label: "跨轮复用模型", passed: startsBeforeReload === 1 && v1.pid === v2.pid
        && v1.version === 11 && v2.version === 11 && v2.sequence > v1.sequence,
        expected: "同一 PID 初始化一次，连续读取产生新序号", actual: JSON.stringify({ startsBeforeReload, v1, v2 }),
        evidenceSeq: evidence("first", "second") },
      "explicit-reload": { label: "helper 和权重显式更新", passed: held.version === 11 && fresh.version === 25
        && beforeReload.status.generation !== reloaded.status.generation && closed.includes(held.pid),
        expected: "reload 前保留已加载值 11；reload 后值 25、新 generation、旧实例 close",
        actual: JSON.stringify({ held, fresh, closed }), evidenceSeq: evidence("edits-pending", "reloaded") },
      "repair": { label: "故障后可修复", passed: failed.status.state === "error" && !!failed.error
        && repaired.status.state === "ready" && fixed.version === 25
        && failed.status.generation !== repaired.status.generation,
        expected: "错误记录可读，修复并 reload 后新 generation 正常返回",
        actual: JSON.stringify({ failed: failed.status, repaired: repaired.status }), evidenceSeq: evidence("failed", "repaired") },
      "immutable-evidence": { label: "输入结果独立归档", passed: archiveUnchanged
        && first.snapshot?.id !== second.snapshot?.id && first.result.observations![0]!.id !== second.result.observations![0]!.id,
        expected: "覆盖 workspace 输出后首轮归档不变，结果身份独立",
        actual: JSON.stringify({ archiveUnchanged, first: first.snapshot, second: second.snapshot }),
        evidenceSeq: evidence("first", "second") },
    },
    metrics: {
      "initializations-before-reload": { label: "reload 前初始化次数", value: startsBeforeReload, unit: "count", direction: "none" },
      "cold-read-ms": { label: "启动至首次读取", value: coldMs, unit: "ms", direction: "lower" },
      "warm-read-ms": { label: "后续读取", value: warmMs, unit: "ms", direction: "lower" },
    },
  };
}
