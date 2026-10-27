import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { customToolToDefinition, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { createRsaExtension } from "../src/harness/omp/extension.ts";
import { PerceptionRuntime, type PerceptionRead } from "../src/harness/perception.ts";
import { Workspace } from "../src/harness/workspace.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

test("observe wire schema accepts unused fields and real OMP calls deliver requested historical pixels", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rsa-observe-schema-")), runDir = join(workspace, "logs", "run");
  const path = join(workspace, "historical.png");
  await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==", "base64"));
  const seed = Bun.spawn(["python3", "-B", "-c", `import json, sys
from unittest.mock import patch
from rsa_tools._observation_history import ObservationHistory, timestamp
history = ObservationHistory(sys.argv[1])
records = []
for second in (50, 51):
    with patch("rsa_tools._observation_history.time.time", return_value=timestamp(f"2026-10-22T06:45:{second}Z", "at")):
        records.append(history.append({"text": "historical", "media": [{"path": "historical.png", "mediaType": "image/png"}]},
                       "previous", {"clock": "previous", "startedAtMs": second, "finishedAtMs": second}))
history.close()
print(json.dumps(records))`, workspace], {env: {...process.env, PYTHONPATH: join(import.meta.dir, "../python")}, stdout: "pipe", stderr: "pipe"});
  const [seeded, seedError, code] = await Promise.all([new Response(seed.stdout).text(), new Response(seed.stderr).text(), seed.exited]);
  expect({code, seedError}).toEqual({code: 0, seedError: ""});
  const records = JSON.parse(seeded) as {id: string}[];
  await writeFile(join(workspace, "perception.py"), 'from rsa_tools import capability, record\nclass Perception:\n    def start(self, context): pass\n    @record\n    @capability\n    def sample(self): return {"text": "live"}\n    def close(self): pass\n');
  const runtime = createTestRuntime({ controllers: [] });
  runtime.perception = new PerceptionRuntime({ workspace, runDir, record: runtime.record });
  const signal = new AbortController().signal;
  try {
    await runtime.perception.reload();
    const extension = createRsaExtension({ runtime, workspace: new Workspace(workspace, join(workspace, "versions")),
      runDir, basewareSocket: "/tmp/unused.sock", binDir: "/tmp", maxRequests: 1,
      cycle: () => ({ epoch: "offline", signal }),
    });
    const tool = customToolToDefinition(extension.tools[0]);
    const [wire] = convertOpenAICodexResponsesTools([tool], { id: "offline", provider: "openai-codex", api: "openai-codex-responses" } as Model<"openai-codex-responses">);
    if (wire?.type !== "function") throw new Error("observe must be a function tool");
    const valid = new Ajv().compile(wire.parameters);
    expect(valid({})).toBe(true);
    expect(valid({ at: null, start: null, end: null, limit: null, after: null })).toBe(true);
    // These first two argument objects came from the failed 2026-10-22 live run.
    for (const [query, expected] of [
      [{ at: "", start: "2026-10-22T06:45:45Z", end: "2026-10-22T06:45:52Z", limit: 4, after: 0 }, 2],
      [{ at: "2026-10-22T06:45:50Z", start: "", end: "", limit: 1, after: 0 }, 1],
      [{ at: null, start: "2026-10-22T06:45:45Z", end: "2026-10-22T06:45:52Z", limit: null, after: null }, 2],
    ] as const) {
      expect(valid(query)).toBe(true);
      const result = await tool.execute("offline-query", query, signal, () => {}, {} as ExtensionContext);
      expect(result.isError).toBe(false);
      const read = result.details as PerceptionRead;
      expect(read.records?.map(record => record.snapshot.id)).toEqual(records.slice(0, expected).map(record => record.id));
      expect(result.content.filter(part => part.type === "image")).toHaveLength(expected);
      expect(result.content.some(part => part.type === "text" && part.text.includes("recordedAt=2026-10-22T06:45:50.000Z"))).toBe(true);
    }
    const handlers: Record<string, (event: any) => any> = {};
    await extension.factory({ on(name: string, handler: (event: any) => any) { handlers[name] = handler; } } as ExtensionAPI);
    const invalid = { at: "2026-10-22T06:45:50Z", start: "2026-10-22T06:45:45Z" };
    const failed = await tool.execute("invalid-query", invalid, signal, () => {}, {} as ExtensionContext);
    expect(failed.isError).toBe(true);
    expect((failed.details as PerceptionRead).error).toContain("cannot be combined");
    const enriched = await handlers.tool_result!({ toolName: "observe", toolCallId: "invalid-query", input: invalid, ...failed });
    expect(enriched.isError).toBe(true);
  } finally {
    await runtime.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
