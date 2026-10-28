import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardWorker, dashboardWorker } from "../lib/dashboard-worker";
import * as route from "../app/api/drivers/discover/route";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

test("discoverDriver accepts a valid file package and rejects invalid specs through the real worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-discover-"));
  const driver = join(root, "driver.ts");
  await writeFile(driver, `export default { id: "fixture", transport: "bridge", defaultPort: 47111,
    version: "1.0", launchHint: "hint", async load() { throw new Error("discover must not call load()"); } };`);
  const worker = new DashboardWorker();
  try {
    const value = await worker.call("discoverDriver", [`  file:${driver}  `]);
    assert.deepEqual(value, { spec: `file:${driver}`, id: "fixture", version: "1.0", transport: "bridge", defaultPort: 47111, launchHint: "hint" });
    await assert.rejects(worker.call("discoverDriver", [""]), /包地址/);
    await assert.rejects(worker.call("discoverDriver", [`file:${join(root, "missing.ts")}`]), /Driver path not found/);
    await assert.rejects(worker.call("discoverDriver", ["bogus!!!"]), /spec/);
    await assert.rejects(worker.call("discoverDriver", ["file:relative/driver.ts"]), /绝对路径/);
    await assert.rejects(worker.call("discoverDriver", [null as unknown as string]), /字符串/);
    assert.equal(worker.pendingCount, 0);
  } finally {
    await worker.close(); await rm(root, { recursive: true, force: true });
  }
});

test("driver discovery requires an explicit same-origin POST and a string spec", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-discover-route-"));
  const driver = join(root, "driver.ts"), imported = join(root, "imported");
  await writeFile(driver, `await Bun.write(${JSON.stringify(imported)}, "imported"); export default { id: "route-fixture", version: "1", load() { throw new Error("must not call load"); } };`);
  const request = (body: unknown, origin?: string) => new Request("http://localhost:3015/api/drivers/discover", {
    method: "POST", headers: { host: "localhost:3015", "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal("GET" in route, false);
    for (const origin of [undefined, "https://untrusted.test"]) {
      const response = await route.POST(request({ spec: `file:${driver}` }, origin));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /同源/);
    }
    await assert.rejects(access(imported));
    for (const body of [null, [], { spec: 42 }]) {
      assert.equal((await route.POST(request(body, "http://localhost:3015"))).status, 400);
    }
    await assert.rejects(access(imported));
    const response = await route.POST(request({ spec: `file:${driver}` }, "http://localhost:3015"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).spec, `file:${driver}`);
    await access(imported);
  } finally { await dashboardWorker().close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["request cancellation", "worker shutdown", "successful import"] as const) {
  test(`discovery cleans its process group after ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-discover-process-"));
    const driver = join(root, "driver.ts"), marker = join(root, "pids.json");
    await writeFile(driver, `
const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
child.unref();
${mode === "successful import" ? "" : "process.on('SIGTERM', () => {});"}
await Bun.write(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
${mode === "successful import" ? "" : "await new Promise(() => { setInterval(() => {}, 1000); });"}
export default { id: "process-fixture", version: "1", load() { throw new Error("must not call load"); } };
`);
    const worker = new DashboardWorker(), abort = new AbortController();
    let pids: number[] = [];
    try {
      const pending = worker.call("discoverDriver", [`file:${driver}`], abort.signal);
      const rejected = mode === "successful import" ? undefined : assert.rejects(pending, mode === "request cancellation" ? { name: "AbortError" } : /closing/);
      await waitFor(() => access(marker).then(() => true, () => false));
      pids = JSON.parse(await readFile(marker, "utf8"));
      if (mode === "request cancellation") {
        assert.equal((await worker.call("diagnostics", [])).activeRequests, 1);
        abort.abort(); await rejected;
      } else if (mode === "worker shutdown") {
        await worker.close(); await rejected;
      } else {
        assert.equal((await pending).id, "process-fixture");
      }
      await waitFor(async () => pids.every(pid => !alive(pid)));
      assert.equal(worker.pendingCount, 0);
    } finally {
      abort.abort(); await worker.close();
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
}
