/** Interpreter and source paths shared by the RSA host and offline Dashboard readers. */
import { existsSync } from "node:fs";
import { dirname, delimiter, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPython = resolve(repository, "rsa/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export function pythonExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.RSA_PYTHON || (existsSync(projectPython) ? projectPython : "python3");
}

export function pythonModulePaths(): string[] {
  return [resolve(repository, "rsa/python"), resolve(repository, "baseware/python")];
}

export function pythonEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  const executable = pythonExecutable(environment);
  const paths = [...(isAbsolute(executable) ? [dirname(executable)] : []), ...(environment.PATH?.split(delimiter) ?? [])];
  return { ...environment, RSA_PYTHON: executable, PATH: [...new Set(paths)].join(delimiter),
    PYTHONPATH: [...new Set([...pythonModulePaths(), ...(environment.PYTHONPATH?.split(delimiter) ?? [])])].join(delimiter) };
}
