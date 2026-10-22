import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TerminalGraphicsDecoder } from "@oh-my-pi/pi-coding-agent/utils/terminal-graphics";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import type { PerceptionRead, PerceptionRecord } from "../src/harness/perception.ts";

// Offline reproduction of the 2026-10-22 LEGO history read: the CLI must
// deliver the requested old pixels through OMP's real terminal decoder.
// The fake socket has visibly different old/current frames; no agent or device.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rsa-observe-cli-"));
  const socket = `/tmp/rsa-observe-${crypto.randomUUID()}.sock`;
  const records: PerceptionRecord[] = [];
  for (const [index, color] of [[255, 0, 0], [0, 0, 255]].entries()) {
    const path = join(root, `${index}.png`);
    await writeFile(path, encodeRawPng(Uint8Array.from([...color, ...color, ...color, ...color]), 2, 2, 3));
    records.push({ snapshot: { id: `record-${index}`, sequence: index + 1, generation: "fixture",
      recordedAt: `2026-10-22T06:44:0${index}.000Z`, sampling: { clock: "fixture", startedAtMs: index, finishedAtMs: index } },
      text: index ? "latest blue frame" : "historical red frame",
      observations: [{ id: `image-${index}`, controllerId: "perception", path, mediaType: "image/png",
        timing: { clock: "fixture", requestedAtMs: index, receivedAtMs: index } }],
    });
  }
  const reply = (selected: PerceptionRecord[]): PerceptionRead => ({
    status: { state: "ready", generation: "fixture" }, records: selected, snapshot: selected.at(-1)?.snapshot,
    hasMore: false, result: { id: "read", status: "completed", exitCode: 0, stdout: "", stderr: "",
      observations: selected.flatMap(record => record.observations), timing: { clock: "fixture", requestedAtMs: 0, receivedAtMs: 1 } },
  });
  let response: PerceptionRead | undefined;
  const server = createServer(connection => {
    let text = "";
    connection.setEncoding("utf8");
    connection.on("data", chunk => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.split("\n")[0]!);
      const value = response ?? reply(request.query.at ? [records[0]!] : request.query.start ? records : [records[1]!]);
      connection.end(JSON.stringify({ ok: true, value }) + "\n");
    });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(socket, done); });
  return {
    records, reply, setResponse(value: PerceptionRead) { response = value; },
    async run(args: string[]) {
      const entry = resolve(import.meta.dir, "../src/harness/cli.ts");
      const child = Bun.spawn([process.execPath, "-e", `import { cli } from ${JSON.stringify(entry)}; await cli(${JSON.stringify(["observe", ...args])}, ${JSON.stringify(socket)});`],
        { cwd: root, env: { ...process.env, BASEWARE_EPOCH: undefined, BASEWARE_TRACE: undefined }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    },
    async close() {
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function decode(output: string) {
  const decoder = new TerminalGraphicsDecoder();
  const text = decoder.push(output) + decoder.finish();
  return { text, images: await decoder.images() };
}

test("observe CLI retains raw JSON and explicitly delivers requested historical pixels", async () => {
  const f = await fixture();
  try {
    const at = f.records[0]!.snapshot.recordedAt;
    const json = await f.run(["--at", at]);
    expect({ code: json.code, stderr: json.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(json.stdout).records[0].snapshot.recordedAt).toBe(at);
    expect(json.stdout).not.toContain("\x1b");
    const historical = await f.run(["--at", at, "--images"]);
    const latest = await f.run(["--images"]);
    const range = await f.run(["--start", at, "--images"]);
    for (const output of [historical, latest, range]) expect({ code: output.code, stderr: output.stderr }).toEqual({ code: 0, stderr: "" });
    const oldView = await decode(historical.stdout), latestView = await decode(latest.stdout), rangeView = await decode(range.stdout);
    expect(oldView.images).toHaveLength(1);
    expect(latestView.images).toHaveLength(1);
    expect(oldView.images[0]!.data).not.toEqual(latestView.images[0]!.data);
    expect(rangeView.images).toEqual([...oldView.images, ...latestView.images]);
    expect(rangeView.text).toContain(`Image 1: image-0 | observation #1 recordedAt=${at}`);
    expect(rangeView.text).toContain(`Image 2: image-1 | observation #2 recordedAt=${f.records[1]!.snapshot.recordedAt}`);
  } finally { await f.close(); }
});

test("observe CLI propagates failed reads and emits no partial image page on rendering failure", async () => {
  const f = await fixture();
  try {
    const failed = f.reply([]);
    failed.result = { ...failed.result, status: "failed", exitCode: 1, stderr: "No observation at requested time" };
    f.setResponse(failed);
    const result = await f.run(["--images"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).result.stderr).toContain("No observation");
    expect((await decode(result.stdout)).images).toEqual([]);

    const invalid = structuredClone(f.records[1]!);
    invalid.observations[0]!.path += ".missing";
    f.setResponse(f.reply([f.records[0]!, invalid]));
    const rendering = await f.run(["--images"]);
    expect(rendering.code).not.toBe(0);
    expect(rendering.stdout).toBe("");

    f.setResponse(f.reply(Array.from({ length: 33 }, () => f.records[0]!)));
    const oversized = await f.run(["--images"]);
    expect(oversized.code).not.toBe(0);
    expect(oversized.stdout).toBe("");
    expect(oversized.stderr).toContain("at most 32");
    expect(oversized.stderr).toContain("smaller --limit");
  } finally { await f.close(); }
});
