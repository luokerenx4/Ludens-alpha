import { registerFixture } from "./fixtures/registry";
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilities } from "../lib/capabilities";
import { catalog, clearCatalogCache } from "../lib/data";
import { DashboardWorker } from "../lib/dashboard-worker";
import { registerWorkspace } from "../../shared/ludens";

const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "dashboard-capabilities-")));
  const root = join(base, "home"), workspace = join(base, "workspace");
  await mkdir(workspace);
  await registerFixture(root, "ws-capabilities", workspace);
  await json(join(workspace, "baseware.json"), { schemaVersion: 2, generatedAt: "2026-10-30T00:00:00.000Z", drivers: [{ id: "recorded-driver", version: "recorded-version" }], controllers: [
    { name: "pad/press", description: "Press a button.", inputSchema: { type: "object" }, requiresControl: true, annotations: { readOnlyHint: false } },
    { name: "screen/read", description: "Read the screen.", inputSchema: { type: "object" }, requiresControl: false, annotations: { readOnlyHint: true } },
  ] });
  await writeFile(join(workspace, "actions.py"), `from rsa_tools import capability
from pathlib import Path
Path(${JSON.stringify(join(base, "MUST_NOT_EXECUTE"))}).touch()
@capability
def clamp(value: float) -> float:
    """Clamp a value to the unit interval."""
    return min(1, max(0, value))
`);
  return { base, root, workspace, cleanup: () => rm(base, { recursive: true, force: true }) };
}
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 3000;
  while (!await check()) {
    assert.ok(Date.now() < until, "condition did not complete within 3 seconds");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("capability catalog reads the selected run-free workspace and real static Python discovery protocol", async () => {
  const f = await fixture();
  try {
    const other = join(f.base, "other-workspace"); await mkdir(other);
    await registerFixture(f.root, "other", other);
    // Both stdlib and package shadowing used to execute before source discovery.
    await writeFile(join(f.workspace, "json.py"), `open(${JSON.stringify(join(f.base, "SHADOW_EXECUTED"))}, "w").close()\nraise RuntimeError("workspace json imported")\n`);
    await mkdir(join(f.workspace, "rsa_tools"));
    await writeFile(join(f.workspace, "rsa_tools/__init__.py"), `open(${JSON.stringify(join(f.base, "SHADOW_EXECUTED"))}, "w").close()\nraise RuntimeError("workspace package imported")\n`);
    const task = join(f.workspace, "benchmarks/tasks/custom");
    await mkdir(join(task, "tests"), { recursive: true }); await mkdir(join(task, "environment"));
    await writeFile(join(task, "task.toml"), 'schema_version = "1.4"\n[task]\nname = "workspace/custom"\ndescription = "Static task"\n');
    await writeFile(join(task, "instruction.md"), "Read the capability.");
    await writeFile(join(task, "tests/test.sh"), `touch '${join(f.base, "MUST_NOT_EXECUTE")}'\n`);
    assert.deepEqual(await catalog(f.root), []);
    const page = await capabilities("ws-capabilities", f.workspace, f.root);
    assert.equal(page.workspace, f.workspace);
    assert.deepEqual(page.issues, []);
    assert.deepEqual(page.groups[0].items.map(item => [item.id, item.requiresControl, item.readOnly]), [
      ["controller/pad/press", true, false], ["controller/screen/read", false, true],
    ]);
    assert.equal(page.sources.device.status, "available");
    assert.ok(Number.isFinite(Date.parse(page.checkedAt)));
    assert.deepEqual(page.deviceSnapshot, { generatedAt: "2026-10-30T00:00:00.000Z", drivers: [{ id: "recorded-driver", version: "recorded-version" }] });
    assert.deepEqual(page.groups[1].items, [{ id: "python/actions.py:clamp", kind: "workspace",
      description: "Clamp a value to the unit interval.", requiresControl: null, readOnly: null }]);
    assert.ok(page.tasks.some(item => item.name === "workspace/custom"));
    await assert.rejects(access(join(f.base, "MUST_NOT_EXECUTE")));
    await assert.rejects(access(join(f.base, "SHADOW_EXECUTED")));
    await assert.rejects(capabilities("missing", f.workspace, f.root), /ENOENT/);
  } finally { clearCatalogCache(); await f.cleanup(); }
});

test("broken snapshot and Python declarations remain visible as issues without hiding healthy discoveries", async () => {
  const f = await fixture();
  try {
    await json(join(f.workspace, "baseware.json"), { controllers: [{ name: "invalid", requiresControl: "yes" }] });
    await writeFile(join(f.workspace, "broken.py"), 'from rsa_tools import capability\n@capability\ndef broken(value: int):\n    return value\n');
    const page = await capabilities("ws-capabilities", f.workspace, f.root);
    assert.deepEqual(page.groups[0].items, []);
    assert.equal(page.sources.device.status, "error");
    assert.equal(page.sources.workspace.status, "partial");
    assert.equal(page.groups[1].items[0].id, "python/actions.py:clamp");
    assert.ok(page.issues.some(item => /baseware.json.*无效能力声明/.test(item.error)));
    assert.ok(page.issues.some(item => /broken.py/.test(item.error)));
    await rm(join(f.workspace, "baseware.json"));
    const absent = await capabilities("ws-capabilities", f.workspace, f.root);
    assert.equal(absent.sources.device.status, "missing");
    assert.equal(absent.deviceSnapshot, null);
    assert.ok(!absent.issues.some(item => /baseware.json/.test(item.error)));
  } finally { clearCatalogCache(); await f.cleanup(); }
});

test("selected capability reads ignore unrelated registry failures and distinguish an empty valid snapshot", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "registry", "unrelated.json"), "{");
    await json(join(f.workspace, "baseware.json"), { controllers: [], generatedAt: "not a date" });
    const page = await capabilities("ws-capabilities", f.workspace, f.root);
    assert.equal(page.sources.device.status, "available");
    assert.equal(page.groups[0].items.length, 0);
    assert.deepEqual(page.deviceSnapshot, { generatedAt: null, drivers: [] });
    assert.equal(page.sources.workspace.status, "available");
    assert.equal(page.groups[1].items.length, 1);
    await assert.rejects(access(join(f.base, "MUST_NOT_EXECUTE")));
  } finally { await f.cleanup(); }
});

test("capability reads require the expected canonical directory and reject a stale alias after a move", async () => {
  const f = await fixture();
  try {
    await assert.rejects(capabilities("ws-capabilities", "", f.root), { status: 400, code: "WORKSPACE_SCOPE_REQUIRED" });
    const moved = join(f.base, "moved");
    await rename(f.workspace, moved); await symlink(moved, f.workspace);
    await registerWorkspace(moved, f.root);
    await assert.rejects(capabilities("ws-capabilities", f.workspace, f.root), { status: 409, code: "WORKSPACE_SCOPE_CHANGED" });
    assert.equal((await capabilities("ws-capabilities", moved, f.root)).workspace, moved);
    await assert.rejects(access(join(f.base, "MUST_NOT_EXECUTE")));
  } finally { await f.cleanup(); }
});

test("the configured Python interpreter can fail without losing the device snapshot", async () => {
  const f = await fixture(), interpreter = join(f.base, "python-failure");
  await writeFile(interpreter, `#!${process.execPath}\nprocess.stderr.write("fixture interpreter failed"); process.exit(3);\n`);
  await chmod(interpreter, 0o755);
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: f.root, RSA_PYTHON: interpreter } });
  try {
    const page = await worker.call("capabilities", ["ws-capabilities", f.workspace]);
    assert.equal(page.groups[0].items.length, 2);
    assert.deepEqual(page.groups[1].items, []);
    assert.ok(page.issues.some(item => /Python @capability.*fixture interpreter failed/.test(item.error)));
  } finally { await worker.close(); await f.cleanup(); }
});

test("slow Python discovery leaves the shared worker responsive and request cancellation stops its process", async () => {
  const f = await fixture(), interpreter = join(f.base, "python-slow"), started = join(f.base, "started");
  await writeFile(interpreter, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(started)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  await chmod(interpreter, 0o755);
  const worker = new DashboardWorker({ env: { ...process.env, LUDENS_HOME: f.root, RSA_PYTHON: interpreter } });
  const abort = new AbortController();
  try {
    assert.deepEqual(await worker.call("catalog", []), []);
    assert.equal((await worker.call("catalog", [true]))[0].id, "ws-capabilities");
    const pending = worker.call("capabilities", ["ws-capabilities", f.workspace], abort.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await waitFor(() => access(started).then(() => true, () => false));
    const pid = Number(await readFile(started, "utf8"));
    const diagnostics = await worker.call("diagnostics", [], AbortSignal.timeout(3000));
    assert.equal(diagnostics.activeRequests, 1);
    abort.abort(); await rejected;
    await waitFor(async () => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
    assert.equal((await worker.call("diagnostics", [])).activeRequests, 0);
  } finally { abort.abort(); await worker.close(); await f.cleanup(); }
});
