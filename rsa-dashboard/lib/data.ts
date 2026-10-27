import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { connect } from "node:net";
import { selectCycle } from "./aggregate";
import { loadIndexedEvents } from "./log-index";
import { refreshRunProjection, selectIndexedCycle, readRunProjection, indexedObservation, hasTimelineReference, type RunPage } from "./run-index";
import { latestGameRun } from "./initial-selection";
import { readTimelineRecord, timelinePath, type TimelineRecordDetail } from "./timeline-record";
import type { Event, Manifest, Project, RunData, LiveStatus } from "./types";
import { decodeTimelineFrame } from "../../shared/timeline-media";
// Runtime state lives in artifacts beside the monorepo, outside its Git tree.
export const artifactRoot = resolve(process.cwd(), "../../artifacts/rsa");
const safePart = (value: string) =>
  /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== "..";
async function projectState(project: string, root: string) {
  if (!safePart(project)) throw new Error("无效的项目 ID");
  const base = await realpath(/* turbopackIgnore: true */ root);
  const state = join(base, project);
  if ((await realpath(state)) !== state)
    throw new Error("工作区索引必须位于 artifacts/rsa 内");
  return state;
}
async function registeredWorkspace(state: string) {
  const { workspace } = JSON.parse(await readFile(join(state, "workspace.json"), "utf8"));
  return realpath(workspace);
}
async function runRoots(project: string, root: string) {
  const state = await projectState(project, root);
  const roots = [join(state, "runs")];
  try {
    // The host records its canonical workspace here, including workspaces outside this repo.
    roots.unshift(join(await registeredWorkspace(state), "logs"));
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
const catalogCache = new Map<string, { expires: number; value?: Project[]; pending?: Promise<Project[]> }>();
export function clearCatalogCache() { catalogCache.clear(); }
export async function catalog(root = artifactRoot, includeEmpty = false): Promise<Project[]> {
  const key = JSON.stringify([root, includeEmpty]);
  const cached = catalogCache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached?.value && cached.expires > Date.now()) return cached.value;
  const entry: { expires: number; value?: Project[]; pending?: Promise<Project[]> } = { expires: 0 };
  entry.pending = scanCatalog(root, includeEmpty).then(value => {
    entry.value = value; entry.expires = Date.now() + 3000; delete entry.pending;
    return value;
  }, error => { if (catalogCache.get(key) === entry) catalogCache.delete(key); throw error; });
  catalogCache.set(key, entry);
  return entry.pending;
}
async function scanCatalog(root: string, includeEmpty: boolean): Promise<Project[]> {
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
                ...(m.kind ? { kind: m.kind } : {}),
                model: m.model,
                seconds: m.seconds,
                drivers: m.drivers,
                ...(m.benchmark ? { benchmark: m.benchmark } : {}),
              };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
              throw error;
            }
          }),
        );
        return { id: d.name, ...(roots.length > 1 ? { workspace: dirname(roots[0]) } : {}),
          runs: runs.filter((r) => r !== null) };
      }),
  );
  return projects
    .filter((p): p is Project => !!p && (includeEmpty || p.runs.length > 0))
    .sort((a, b) => (latestGameRun(b)?.id ?? b.runs[0]?.id ?? "")
      .localeCompare(latestGameRun(a)?.id ?? a.runs[0]?.id ?? ""));
}
export async function loadRun(project: string, run: string, root = artifactRoot) {
  const path = await resolveRun(project, run, root);
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as Manifest;
  let workspace: string | null = null;
  try {
    workspace = await registeredWorkspace(await projectState(project, root));
    // Old run/media readers use the registry independently of a retained manifest.
    // A mismatch only denies new workspace archive resolution.
    if (manifest.workspace && await realpath(manifest.workspace) !== workspace) workspace = null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    workspace = null;
  }
  const indexed = await loadIndexedEvents(path);
  indexed.index.archiveWorkspace = workspace;
  return { path, manifest, ...indexed };
}
export function hostRequest<T = LiveStatus>(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<T> {
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
export function selectRunEvents(manifest: Manifest, events: Event[], epoch?: string) {
  const selected = selectCycle(events, epoch);
  // Offline fixtures have trace epochs, but do not claim a Runtime takeover.
  // Their original run is still inspectable as a whole, without inventing cycles.
  if (manifest.kind === "benchmark" && !selected.cycles.length && !epoch)
    return { ...selected, events };
  return selected;
}
export async function getRun(
  project: string,
  run: string,
  epoch?: string,
  page: RunPage = {},
): Promise<RunData> {
  const { manifest, index, release } = await loadRun(project, run);
  try {
  const projects = await catalog();
  await refreshRunProjection(index);
  const cycle = await selectIndexedCycle(index, manifest, epoch);
  const { phase, ...projection } = await readRunProjection(index, cycle.selectedEpoch, page, cycle.wholeRun);
  const latest = latestGameRun(projects.find((p) => p.id === project))?.id;
  let live: LiveStatus | null = null;
  // Only the newest manifest may designate a live socket. Archived runs never contact hosts.
  if (latest === run && manifest.kind !== "benchmark")
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
    ...projection,
    live: matched ? live : null,
    livePhase: matched && live?.connected && live.mode === "auto" && live.epoch === cycle.selectedEpoch ? phase : null,
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
  } finally { release(); }
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
export async function mediaFile(project: string, run: string, id: string, root = artifactRoot, signal?: AbortSignal) {
  const { path, index, release } = await loadRun(project, run, root);
  try {
  const observation = await indexedObservation(index, id);
  const textMedia = observation?.mediaType.startsWith("text/") || observation?.mediaType === "application/json";
  if (
    !observation ||
    (!textMedia && !["image/png", "image/jpeg", "image/webp", "audio/wav"].includes(
      observation.mediaType,
    ))
  )
    throw new Error("未找到可展示的观测");
  let file: string;
  const reference = observation.timeline;
  if (reference) {
    if ((reference.recordId !== undefined && (typeof reference.recordId !== "string" || !reference.recordId))
      || (reference.sequence !== undefined && (!Number.isSafeInteger(reference.sequence) || reference.sequence < 1))
      || typeof reference.asset !== "string" || !reference.asset.split("/").every(safePart))
      throw new Error("无效的时空轴媒体引用");
    const workspace = await registeredWorkspace(await projectState(project, root));
    const timeline = join(workspace, ".rsa", "timeline");
    if (reference.video) return {
      bytes: await decodeTimelineFrame(timeline, { asset: reference.asset, video: reference.video }, { signal }),
      mediaType: "image/png", cacheControl: "no-store",
    };
    try {
      file = await timelinePath(timeline, reference.asset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw Object.assign(new Error("观测已过期或已移除"), { status: 410, code: "OBSERVATION_EXPIRED" });
      throw error;
    }
  } else {
    if (typeof observation.path !== "string")
      throw Object.assign(new Error("此观测未录制，仅保留交付记录"), { status: 404, code: "OBSERVATION_UNRECORDED" });
    file = await realpath(observation.path);
    if (file !== join(path, "observations", basename(file)))
      throw new Error("观测文件必须位于当前运行目录");
  }
  const bytes = await readFile(file).catch(error => {
    if (reference && error.code === "ENOENT")
      throw Object.assign(new Error("观测已过期或已移除"), { status: 410, code: "OBSERVATION_EXPIRED" });
    throw error;
  });
  return {
    bytes,
    // Text media (including HTML source) is model input, never executable page content.
    mediaType: textMedia ? "text/plain; charset=utf-8" : observation.mediaType,
    cacheControl: !reference || reference.asset.startsWith("objects/")
      ? "private, max-age=31536000, immutable" : "no-store",
  };
  } finally { release(); }
}

export async function timelineRecord(project: string, run: string, recordId: string, sequence: number,
  source: { call?: string; observation?: string }, root = artifactRoot): Promise<TimelineRecordDetail> {
  if (!recordId || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("无效的时空轴记录引用");
  const { index, release } = await loadRun(project, run, root);
  try {
    if (!await hasTimelineReference(index, recordId, sequence, source)) throw new Error("此运行没有引用指定观测");
    const workspace = await registeredWorkspace(await projectState(project, root));
    const stored = await readTimelineRecord(join(workspace, ".rsa", "timeline"), recordId, sequence)
      .catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stored) return stored;

    // Window-only JSON stays in the resident writer. Ask the current registered
    // workspace host, without starting a sampler or contacting an old run's socket.
    const latest = latestGameRun((await catalog(root)).find(item => item.id === project));
    if (latest) {
      const path = await resolveRun(project, latest.id, root);
      const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as Manifest;
      if (typeof manifest.workspace === "string" && await realpath(manifest.workspace) === workspace) {
        const live = await hostRequest(manifest.socket, { kind: "status", argv: [] }).catch(() => null);
        if (live?.runId === latest.id) {
          const response = await hostRequest<{ records?: Array<{ snapshot: { id: string; sequence: number }; data?: unknown; space?: unknown }> }>(
            manifest.socket, { kind: "perception", argv: ["observe"], query: { id: recordId } },
          ).catch(() => null);
          const record = response?.records?.find(item => item.snapshot.id === recordId && item.snapshot.sequence === sequence);
          if (record) return { recordId, sequence, ...(record.data === undefined ? {} : { data: record.data }),
            ...(record.space === undefined ? {} : { space: record.space }) };
        }
      }
    }
    throw Object.assign(new Error("观测已过期或已移除"), { status: 410, code: "OBSERVATION_EXPIRED" });
  } finally { release(); }
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
