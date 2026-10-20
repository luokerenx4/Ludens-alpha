import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pythonModulePaths } from "../harness/python-capabilities.ts";
import type { PythonDiagnostic } from "../harness/python-capabilities.ts";
import type { BenchmarkDefinition } from "./contract.ts";
import { builtinDefinitions } from "./builtins.ts";
import { atomicJson, indexWorkspace } from "./store.ts";

export const pythonBridge = fileURLToPath(new URL("../../python/rsa_tools/_bridge.py", import.meta.url));
export function pythonEnv(workspace: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, RSA_WORKSPACE: workspace, PYTHONDONTWRITEBYTECODE: "1" };
  return { ...env, PYTHONPATH: [...pythonModulePaths(), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter) };
}
export async function discoverBenchmarks(workspace: string, artifactRoot: string) {
  const state = await indexWorkspace(workspace, artifactRoot);
  const discovery = await new Promise<{ benchmarks: BenchmarkDefinition[]; diagnostics: PythonDiagnostic[] }>((done, fail) => {
    const child = spawn(process.env.RSA_PYTHON ?? "python3", ["-B", pythonBridge], {
      cwd: state.workspace, env: pythonEnv(state.workspace, { RSA_ARTIFACT_ROOT: artifactRoot }), stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.once("error", fail);
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") fail(error); });
    child.once("close", code => {
      try { if (code !== 0) throw new Error(`Benchmark discovery failed: ${stdout || stderr}`); done(JSON.parse(stdout)); }
      catch (error) { fail(error); }
    });
    child.stdin.end(JSON.stringify({ action: "discover_benchmarks", workspace: state.workspace }));
  });
  const catalog = { benchmarks: [...builtinDefinitions, ...discovery.benchmarks], diagnostics: discovery.diagnostics };
  await atomicJson(join(state.workspace, "logs", "benchmarks-catalog.json"), catalog);
  return catalog;
}
