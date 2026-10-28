import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pythonPath = resolve(import.meta.dir, "../python");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rsa-python-trial-"));
  const workspace = join(root, "workspace"), runDir = join(workspace, "logs/trial"), artifacts = join(runDir, "artifacts"), task = join(root, "task");
  await mkdir(artifacts, { recursive: true }); await mkdir(task);
  const input = join(runDir, "input.json"); await writeFile(input, "{}");
  const env = { ...process.env, PYTHONPATH: pythonPath, RSA_WORKSPACE: workspace,
    RSA_BENCH_TRIAL_ID: "trial", RSA_BENCH_RUN_DIR: runDir, RSA_BENCH_ARTIFACTS: artifacts, RSA_BENCH_TASK_DIR: task, RSA_BENCH_INPUT: input,
    RSA_SOCKET: "", RSA_RUN_ID: "", BASEWARE_EPOCH: "", BASEWARE_TRACE: "{}" };
  const run = async (source: string, extra: Record<string, string> = {}) => {
    const child = Bun.spawn(["python3", "-B", "-c", source], { cwd: workspace, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };
  return { root, workspace, runDir, artifacts, task, env, run };
}

test("current_trial needs Shiori identity and never creates runs or a fallback decorator", async () => {
  const f = await fixture();
  try {
    const result = await f.run(`from rsa_tools import current_trial
import rsa_tools
assert not hasattr(rsa_tools, 'benchmark')
try: current_trial()
except RuntimeError as error: assert 'No Shiori trial' in str(error)
else: raise AssertionError('unassigned trial accepted')`, { RSA_BENCH_TRIAL_ID: "" });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await readdir(f.artifacts)).toEqual([]);
    expect(await readdir(f.runDir)).toEqual(["artifacts", "input.json"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("explicit Python trial preserves loaded objects and observes real capability versions without lifecycle writes", async () => {
  const f = await fixture();
  try {
    const source = `from rsa_tools import capability
MODEL=object()
@capability
def model():
    """Return one loaded model."""
    return MODEL
class Action:
    @capability
    def step(self): return MODEL
`;
    await writeFile(join(f.workspace, "model.py"), source);
    expect(await f.run(`from pathlib import Path
from rsa_tools import current_trial
from model import model, Action, MODEL
trial=current_trial()
trial.conditions(seed=7)
Path('model.py').write_text('changed after import')
assert model() is MODEL
assert Action().step() is MODEL
assert current_trial() is trial
trial.artifact('measurements.json', {'same': True})
trial.flush()`)).toEqual({ code: 0, stdout: "", stderr: "" });
    const context = JSON.parse(await readFile(join(f.artifacts, "context.json"), "utf8"));
    expect(context.conditions).toEqual({ seed: 7 });
    expect(context.subjects).toHaveLength(2);
    expect(context.subjects[0].revision).toBe(new Bun.CryptoHasher("sha256").update(source).digest("hex"));
    expect(context.capabilityCalls.map((call: any) => [call.started, call.succeeded, call.failed])).toEqual([[1, 1, 0], [1, 1, 0]]);
    expect(context).not.toHaveProperty("status");
    expect((await readdir(f.runDir)).sort()).toEqual(["artifacts", "input.json"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("artifact values are immutable and escaping paths are rejected", async () => {
  const f = await fixture();
  try {
    expect(await f.run(`from pathlib import Path
from rsa_tools import current_trial
trial=current_trial()
Path('sample.txt').write_text('before')
item=trial.artifact('sample.txt')
Path('sample.txt').write_text('after')
assert (trial.run_dir/item['path']).read_text() == 'before'
trial.artifact('samples.json', {'values': [1, 2]})
try: trial.artifact('samples.json', {'values': [3]})
except FileExistsError: pass
else: raise AssertionError('overwrote immutable evidence')
for path in ['../escape.json', '/tmp/escape.json', 'context.json']:
    try: trial.artifact(path, {'bad': True})
    except ValueError: pass
    else: raise AssertionError(path)
`)).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed Python measurement keeps its exception and collected facts without claiming a terminal trial", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "bad.py"), `from rsa_tools import capability
@capability
def fail():
    """Fail one measurement."""
    raise ValueError('measured failure')
`);
    const result = await f.run(`from rsa_tools import current_trial
from bad import fail
current_trial().conditions(checkpoint='before')
fail()`);
    expect(result.code).toBe(1); expect(result.stderr).toContain("ValueError: measured failure");
    const context = JSON.parse(await readFile(join(f.artifacts, "context.json"), "utf8"));
    expect(context.capabilityCalls[0]).toMatchObject({ started: 1, succeeded: 0, failed: 1 });
    expect(context).not.toHaveProperty("status");
    expect(await Bun.file(join(f.runDir, "trial.json")).exists()).toBe(false);
    expect(await Bun.file(join(f.runDir, "events.jsonl")).exists()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("timeline artifacts retain exact canonical frame identities and reject invented references", async () => {
  const f = await fixture();
  try {
    const result = await f.run(`from rsa_tools import current_trial
from rsa_tools._observation_history import ObservationHistory
from datetime import datetime, timezone
from pathlib import Path
trial=current_trial()
Path('sample.txt').write_text('first')
h=ObservationHistory(Path.cwd())
record=h.append({'text':'one', 'media':[{'path':'sample.txt','mediaType':'text/plain'}]}, 'generation', {'clock':'test','startedAtMs':0,'finishedAtMs':1}, datetime.now(timezone.utc).isoformat())
h.close()
media=record['media'][0]
item=trial.artifact(media)
assert item['timeline'] == media['timeline']
assert len(list(trial.artifacts.glob('*.bin'))) == 0
bad={**media['timeline'], 'recordId':'other'}
try: trial.artifact(bad)
except ValueError as error: assert 'identity' in str(error)
else: raise AssertionError('invented reference accepted')
source=Path('.rsa/timeline') / media['timeline']['asset']
source.write_bytes(b'corrupt')
try: trial.artifact(media)
except ValueError as error: assert 'checksum' in str(error)
else: raise AssertionError('corruption accepted')`);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("video evidence keeps exact record/PTS references and does not copy frames or clips", async () => {
  const f = await fixture();
  try {
    const result = await f.run(`import base64
from io import BytesIO
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image
from rsa_tools import current_trial
from rsa_tools._observation_history import ObservationHistory
output=BytesIO()
Image.new('RGB', (32,32), 'red').save(output, format='PNG')
h=ObservationHistory(Path.cwd(), sample_hz=30)
record=h.append({'media':[{'mediaType':'image/png','data':base64.b64encode(output.getvalue()).decode()}]}, 'generation', {'clock':'test','startedAtMs':0,'finishedAtMs':1}, datetime.now(timezone.utc).isoformat())
h.close()
trial=current_trial()
item=trial.artifact(record['media'][0])
assert item['timeline'] == record['media'][0]['timeline']
assert item['approximate'] is True
assert not list(trial.artifacts.glob('*.mp4'))
assert not list(trial.artifacts.glob('*.png'))
assert not list(trial.artifacts.glob('*.bin'))`);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
