import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pythonModulePaths } from "../src/harness/python-capabilities.ts";

async function runPython(workspace: string, source: string) {
  const child = Bun.spawn(["python3", "-B", "-c", source], {cwd: workspace, stdout: "pipe", stderr: "pipe",
    env: {...process.env, RSA_SOCKET: "", RSA_WORKSPACE: workspace, PYTHONPATH: pythonModulePaths().join(delimiter)}});
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({exitCode, stderr}).toEqual({exitCode: 0, stderr: ""});
  return JSON.parse(stdout);
}

const statefulModule = `from rsa_tools import capability
MODEL = object()
calls = 0
@capability
def step(value):
    """Keep the model and arbitrary Python inputs in this process."""
    global calls
    calls += 1
    return MODEL, value, calls

def plain():
    return "ordinary helper"
`;

test("local capabilities share ordinary imports and preserve model and argument identity", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-python-local-")));
  try {
    await writeFile(join(workspace, "actions.py"), statefulModule);
    for (const importFirst of [true, false]) {
      const result = await runPython(workspace, `import json, sys
from pathlib import Path
from rsa_tools._capabilities import call_local
workspace = Path.cwd()
${importFirst ? "import actions" : ""}
value = object()
first = call_local(workspace, "python/actions.py:step", {"value": value})
import actions
second = actions.step(value)
third = call_local(workspace, "python/actions.py:step", {"value": value})
assert first[0] is second[0] is third[0] is actions.MODEL
assert first[1] is second[1] is third[1] is value
assert [first[2], second[2], third[2]] == [1, 2, 3]
# An edited source does not replace live model state. Restart the program to reload.
path = workspace / "actions.py"
path.write_text(path.read_text().replace("calls += 1", "calls += 2"))
assert call_local(workspace, "python/actions.py:step", {"value": value})[2] == 4
try:
    call_local(workspace, "python/actions.py:plain", {})
except ValueError as error:
    assert "@capability" in str(error)
else:
    raise AssertionError("unmarked helper was exposed")
print(json.dumps({"calls": actions.calls, "modules": len([m for m in sys.modules.values() if getattr(m, "__file__", None) == str(path)])}))
`);
      expect(result).toEqual({calls: 4, modules: 1});
      expect(await runPython(workspace, `import json
from pathlib import Path
from rsa_tools._capabilities import call_local
result = call_local(Path.cwd(), "python/actions.py:step", {"value": object()})
print(json.dumps({"calls": result[2]}))
`)).toEqual({calls: 2});
      await writeFile(join(workspace, "actions.py"), statefulModule);
    }
  } finally { await rm(workspace, {recursive: true, force: true}); }
});

test("local capability loading supports package-relative imports and reports the loaded source hash", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rsa-python-package-")));
  try {
    await mkdir(join(workspace, "skills"));
    await writeFile(join(workspace, "skills", "__init__.py"), "");
    await writeFile(join(workspace, "skills", "model.py"), "MODEL = object()\n");
    await writeFile(join(workspace, "skills", "actions.py"), `from rsa_tools import capability
from .model import MODEL
@capability
def model():
    """Return the package's shared model."""
    return MODEL
`);
    expect(await runPython(workspace, `import hashlib, json
from pathlib import Path
from rsa_tools._capabilities import call_local
first = call_local(Path.cwd(), "python/skills/actions.py:model", {})
import skills.actions
from skills.model import MODEL
assert first is MODEL is skills.actions.model()
print(json.dumps({"hash": skills.actions.__rsa_source_sha__ == hashlib.sha256(Path("skills/actions.py").read_bytes()).hexdigest()}))
`)).toEqual({hash: true});
  } finally { await rm(workspace, {recursive: true, force: true}); }
});
