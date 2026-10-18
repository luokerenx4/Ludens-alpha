import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { connect } from "node:net";
import { aggregate, parseEvents, selectCycle } from "./aggregate";
import { getLivePhase } from "./live-phase";
import type { Event, Manifest, Project, RunData, LiveStatus } from "./types";
// Runtime state lives in artifacts beside the monorepo, outside its Git tree.
export const artifactRoot = resolve(process.cwd(), "../../artifacts/rsa");
const safePart = (value: string) =>
  /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== "..";
async function runRoots(project: string, root: string) {
  if (!safePart(project)) throw new Error("无效的项目 ID");
  const base = await realpath(/* turbopackIgnore: true */ root);
  const state = join(base, project);
  if ((await realpath(state)) !== state)
    throw new Error("工作区索引必须位于 artifacts/rsa 内");
  const roots = [join(state, "runs")];
  try {
    // The host records its canonical workspace here, including workspaces outside this repo.
    const { workspace } = JSON.parse(
      await readFile(join(state, "workspace.json"), "utf8"),
    );
    roots.unshift(join(await realpath(workspace), "logs"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return roots;
}
async function resolveInRoots(run: string, roots: string[]) {
  if (!safePart(run)) throw new Error("无效的运行 ID");
  for (const root of roots) {
    const path = join(root, run);
    try {
      if ((await realpath(path)) !== path)
        throw new Error("运行目录必须位于工作区 logs 或原运行目录内");
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw Object.assign(new Error("未找到运行目录"), { code: "ENOENT" });
}
export async function resolveRun(
  project: string,
  run: string,
  root = artifactRoot,
) {
  return resolveInRoots(run, await runRoots(project, root));
}
export async function catalog(root = artifactRoot): Promise<Project[]> {
  const directories = await readdir(/* turbopackIgnore: true */ root, {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const projects = await Promise.all(
    directories
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const roots = await runRoots(d.name, root);
        const entries = await Promise.all(roots.map(async (path) => {
          try {
            return (await readdir(/* turbopackIgnore: true */ path, { withFileTypes: true }))
              .filter((r) => r.isDirectory())
              .map((r) => r.name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        }));
        const names = [...new Set(entries.flat())].sort().reverse();
        const runs = await Promise.all(
          names.map(async (id) => {
            try {
              const path = await resolveInRoots(id, roots);
              const m: Manifest = JSON.parse(
                await readFile(join(path, "manifest.json"), "utf8"),
              );
              return {
                id,
                model: m.model,
                seconds: m.seconds,
                provider: m.provider,
              };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
              throw error;
            }
          }),
        );
        return { id: d.name, runs: runs.filter((r) => r !== null) };
      }),
  );
  return projects
    .filter((p): p is Project => !!p && p.runs.length > 0)
    .sort((a, b) => b.runs[0].id.localeCompare(a.runs[0].id));
}
const eventCache = new Map<
  string,
  { mtime: number; size: number; events: Event[] }
>();
export async function loadRun(project: string, run: string) {
  const path = await resolveRun(project, run);
  const [manifest, s] = await Promise.all([
    readFile(join(path, "manifest.json"), "utf8").then(
      (s) => JSON.parse(s) as Manifest,
    ),
    stat(join(path, "events.jsonl")),
  ]);
  let cached = eventCache.get(path);
  if (!cached || cached.mtime !== s.mtimeMs || cached.size !== s.size) {
    cached = {
      mtime: s.mtimeMs,
      size: s.size,
      events: parseEvents(await readFile(join(path, "events.jsonl"), "utf8")),
    };
    eventCache.set(path, cached);
    if (eventCache.size > 8) eventCache.delete(eventCache.keys().next().value!);
  }
  return { path, manifest, events: cached.events };
}
export function hostRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<LiveStatus> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let complete = false;
    const fail = (error: Error) => {
      if (!complete) {
        complete = true;
        socket.destroy();
        reject(error);
      }
    };
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => fail(new Error("Host 响应超时")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Host 已断开")));
    socket.on("data", (data) => {
      buffer += data;
      const end = buffer.indexOf("\n");
      if (end < 0 || complete) return;
      try {
        const r = JSON.parse(buffer.slice(0, end));
        if (!r.ok) throw new Error(r.error);
        complete = true;
        socket.end();
        resolve(r.value);
      } catch (error) {
        fail(error as Error);
      }
    });
  });
}
export function canControl(
  latest: string,
  run: string,
  status: LiveStatus | null,
  selectedEpoch: string | null,
) {
  return (
    latest === run &&
    status?.runId === run &&
    status.connected &&
    selectedEpoch !== null &&
    selectedEpoch === status.epoch
  );
}
export async function getRun(
  project: string,
  run: string,
  epoch?: string,
): Promise<RunData> {
  const [{ manifest, events }, projects] = await Promise.all([
    loadRun(project, run),
    catalog(),
  ]);
  const cycle = selectCycle(events, epoch);
  const latest = projects.find((p) => p.id === project)?.runs[0].id;
  let live: LiveStatus | null = null;
  // Only the newest manifest may designate a live socket. Archived runs never contact hosts.
  if (latest === run)
    live = await hostRequest(manifest.socket, {
      kind: "status",
      argv: [],
    }).catch(() => null);
  const matched = live?.runId === run;
  const controlAllowed =
    !!latest && !!canControl(latest, run, live, cycle.selectedEpoch);
  return {
    project,
    run,
    manifest,
    cycles: cycle.cycles,
    selectedEpoch: cycle.selectedEpoch,
    ...aggregate(cycle.events),
    live: matched ? live : null,
    livePhase: getLivePhase(cycle.events, run, cycle.selectedEpoch, live),
    controlAllowed,
    controlReason:
      latest !== run
        ? "历史运行，仅供回放"
        : !live
          ? "Host 离线"
          : !matched
            ? "Host 属于其他运行"
            : !live.connected
              ? "设备连接已断开"
              : cycle.selectedEpoch !== cycle.cycles.at(-1)?.epoch ||
                  (live.mode === "auto" && cycle.selectedEpoch !== live.epoch)
                ? "历史周期，仅供回放"
                : "已连接当前 Host",
    updatedAt: new Date().toISOString(),
  };
}
export async function stopRun(
  project: string,
  run: string,
  expectedEpoch: string | null,
  readRun: typeof getRun = getRun,
) {
  if (!expectedEpoch) throw new Error("必须明确选择接管周期");
  const data = await readRun(project, run, expectedEpoch);
  if (
    !data.controlAllowed ||
    !data.live ||
    data.selectedEpoch !== expectedEpoch ||
    data.live.epoch !== expectedEpoch
  )
    throw new Error("控制状态已变化，请刷新后重试");
  if (data.live.mode !== "auto") throw new Error("当前运行没有开启 AI 接管");
  return hostRequest(data.manifest.socket, {
    kind: "auto",
    argv: ["off"],
    runId: run,
    expectedEpoch,
  });
}
export async function mediaFile(project: string, run: string, id: string) {
  const { path, events } = await loadRun(project, run);
  const event = events.find(
    (e) => e.type === "observation" && e.data.id === id,
  );
  if (
    !event ||
    !["image/png", "image/jpeg", "image/webp", "audio/wav"].includes(
      event.data.mediaType,
    )
  )
    throw new Error("未找到可展示的观测");
  const file = await realpath(event.data.path);
  if (file !== join(path, "observations", basename(file)))
    throw new Error("观测文件必须位于当前运行目录");
  return {
    bytes: await readFile(file),
    mediaType: event.data.mediaType as string,
  };
}
export function localRequest(request: Request, mutation = false) {
  const host = request.headers.get("host")?.split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost")
    throw new Error("只允许本地访问");
  if (
    mutation &&
    request.headers.get("origin") !==
      `${new URL(request.url).protocol}//${request.headers.get("host")}`
  )
    throw new Error("只允许同源控制请求");
}
