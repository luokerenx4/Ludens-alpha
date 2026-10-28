import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardWorker } from "../lib/dashboard-worker";

test("discoverDriver accepts a valid file package and rejects invalid specs through the real worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-discover-"));
  const driver = join(root, "driver.ts");
  await writeFile(driver, `export default { id: "fixture", transport: "bridge", defaultPort: 47111,
    version: "1.0", launchHint: "hint", async load() { throw new Error("discover must not call load()"); } };`);
  const worker = new DashboardWorker();
  try {
    const value = await worker.call("discoverDriver", [`file:${driver}`]);
    assert.deepEqual(value, { id: "fixture", version: "1.0", transport: "bridge", defaultPort: 47111, launchHint: "hint" });
    await assert.rejects(worker.call("discoverDriver", [""]), /包地址/);
    await assert.rejects(worker.call("discoverDriver", [`file:${join(root, "missing.ts")}`]), /Driver path not found/);
    await assert.rejects(worker.call("discoverDriver", ["bogus!!!"]), /spec/);
    assert.equal(worker.pendingCount, 0);
  } finally {
    await worker.close(); await rm(root, { recursive: true, force: true });
  }
});
