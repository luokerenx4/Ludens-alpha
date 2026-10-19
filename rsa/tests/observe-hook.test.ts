import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runObserveHook } from "../src/harness/observe-hook.ts";

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-observe-hook-")));
  const events: { type: string; data: any; trace: any }[] = [];
  const runDir = join(workspace, "logs", "run");
  const options = { workspace, runDir, env: {}, clock: { id: "test", now: () => performance.now() },
    signal: new AbortController().signal, trace: { traceId: "observe-trace", spanId: "parent-span" },
    record: (type: string, data: unknown, trace: unknown) => { events.push({ type, data, trace }); } };
  return { workspace, runDir, options, events, cleanup: () => rm(workspace, { recursive: true, force: true }) };
}

const observer = (body: string) => `from rsa_tools import capability
@capability(hook="observe")
def observe() -> dict:
    """Provide a workspace-defined observation."""
${body}
`;

test("automatic observation refreshes workspace code and stops using a removed hook", async () => {
  const f = await fixture();
  try {
    const path = join(f.workspace, "view.py");
    const firstSource = observer('    return {"text": "first"}');
    await writeFile(path, firstSource);
    const first = await runObserveHook(f.options);
    expect(first.error).toBeUndefined();
    expect(first.result?.stdout).toBe("first");
    expect(first.hook?.id).toBe("python/view.py:observe");
    const secondSource = observer('    return {"text": "second"}');
    await writeFile(path, secondSource);
    const second = await runObserveHook(f.options);
    expect(second.result?.stdout).toBe("second");
    expect(second.hook?.id).toBe(first.hook?.id);
    expect(second.hook?.codeSHA).not.toBe(first.hook?.codeSHA);
    expect(await readFile(join(f.runDir, "observer-sources", `${first.hook!.codeSHA}.py`), "utf8")).toBe(firstSource);
    expect(await readFile(join(f.runDir, "observer-sources", `${second.hook!.codeSHA}.py`), "utf8")).toBe(secondSource);
    await writeFile(path, secondSource.replace('@capability(hook="observe")', "@capability"));
    expect(await runObserveHook(f.options)).toEqual({ diagnostics: [] });
    expect(f.events.filter(event => event.type === "observe_hook_end").map(event => event.data.outcome)).toEqual(["success", "success"]);
  } finally { await f.cleanup(); }
});

test("text and media are returned together and earlier media survives source rewrites", async () => {
  const f = await fixture();
  try {
    const imagePath = join(f.workspace, "view.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTJoAAAAASUVORK5CYII=", "base64");
    await writeFile(imagePath, png);
    await writeFile(join(f.workspace, "view.py"), observer('    return {"text": "current view", "media": [{"path": "view.png", "mediaType": "image/png"}]}'));
    const first = await runObserveHook(f.options);
    expect(first.result).toMatchObject({ status: "completed", stdout: "current view", observations: [{ mediaType: "image/png", controllerId: "python/view.py:observe" }] });
    const archived = first.result!.observations![0]!.path;
    expect(archived.startsWith(join(f.runDir, "observations"))).toBe(true);
    expect(await readFile(archived)).toEqual(png);
    const changed = Buffer.from("next generated frame");
    await writeFile(imagePath, changed);
    const second = await runObserveHook(f.options);
    expect(second.result!.observations![0]!.path).not.toBe(archived);
    expect(await readFile(second.result!.observations![0]!.path)).toEqual(changed);
    expect(await readFile(archived)).toEqual(png);
  } finally { await f.cleanup(); }
});

test("broken, ambiguous, and invalid observer definitions return a fallback error", async () => {
  const f = await fixture();
  try {
    const path = join(f.workspace, "view.py");
    for (const [body, expected] of [
      ['    raise RuntimeError("camera pipeline failed")', "camera pipeline failed"],
      ['    return ["invalid result"]', "must return"],
      ['    return {"text": 123}', "text must be a string"],
      ['    return {"media": [{"path": "missing.png", "mediaType": "image/png"}]}', "ENOENT"],
    ]) {
      await writeFile(path, observer(body!));
      const result = await runObserveHook(f.options);
      expect(result.result).toBeUndefined();
      expect(result.error).toContain(expected!);
    }
    await writeFile(path, observer('    return {"text": "one"}'));
    await writeFile(join(f.workspace, "other.py"), observer('    return {"text": "two"}'));
    expect((await runObserveHook(f.options)).error).toContain("Expected one observe hook");
    await rm(join(f.workspace, "other.py"));
    await writeFile(path, observer('    return {}').replace("def observe()", 'def observe(value: str = "optional")'));
    const invalid = await runObserveHook(f.options);
    expect(invalid.error).toContain("no parameters");
    expect(invalid.diagnostics).toEqual([expect.objectContaining({ hook: "observe", function: "observe" })]);
  } finally { await f.cleanup(); }
});

test("cancelling an active observer propagates cancellation instead of suggesting fallback", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "view.py"), `from rsa_tools import capability
from pathlib import Path
import time
@capability(hook="observe")
def observe():
    """Wait so ownership cancellation can interrupt observation."""
    Path("ready").touch()
    time.sleep(30)
    return {"text": "late result"}
`);
    const abort = new AbortController();
    const running = runObserveHook({ ...f.options, signal: abort.signal });
    void running.catch(() => {});
    const deadline = Date.now() + 3000;
    while (!await Bun.file(join(f.workspace, "ready")).exists() && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(join(f.workspace, "ready")).exists()).toBe(true);
    abort.abort(new Error("human takeover"));
    await expect(running).rejects.toThrow("human takeover");
    expect(f.events.filter(event => event.type === "observe_hook_end")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ outcome: "cancelled" }) }),
    ]);
  } finally { await f.cleanup(); }
});
