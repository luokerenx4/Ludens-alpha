import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { require as tsxRequire } from "tsx/cjs/api";
const { ArchiveBuildManager } = tsxRequire("../../lib/cold-build.ts", import.meta.url);
const { getLogIndex } = tsxRequire("../../lib/log-index.ts", import.meta.url);
const manager = new ArchiveBuildManager({ entry: fileURLToPath(new URL("./archive-builder.mjs", import.meta.url)) });
const index = getLogIndex(workerData.path);
manager.ensure(index);
const timer = setInterval(() => {
  const state = manager.state(index);
  if (state?.stage === "fixture") { clearInterval(timer); parentPort.postMessage(state.pid); }
}, 10);
