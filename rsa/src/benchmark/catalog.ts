import { spawn } from "node:child_process";
import { join } from "node:path";
import { pythonExecutable, pythonEnvironment } from "../../../shared/python.ts";
import type { PythonDiagnostic } from "../harness/python-capabilities.ts";
import type { BenchmarkDefinition } from "./contract.ts";
import { builtinDefinitions } from "./builtins.ts";
import { atomicJson, indexWorkspace } from "./store.ts";

export const pythonBridge = ["-B", "-m", "rsa_tools._bridge"];
export function pythonEnv(workspace: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return pythonEnvironment({ ...extra, RSA_WORKSPACE: workspace, PYTHONDONTWRITEBYTECODE: "1" });
}
export async function discoverBenchmarks(workspace: string, artifactRoot: string) {
  const state = await indexWorkspace(workspace, artifactRoot);
  const discovery = await new Promise<{ benchmarks: BenchmarkDefinition[]; diagnostics: PythonDiagnostic[] }>((done, fail) => {
    const child = spawn(pythonExecutable(), pythonBridge, {
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
