import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

type EventSource = { component: string; implementation?: string; implementationVersion?: string }
export interface ActivityProjection {
  source: EventSource
  throughSeq: number
  latestEventAt: string | null
  latestSourceAt: string | null
  generatedAt: string
  durationMs: number
  blockCount: number
}
export type ConsumerRecord = (type: string, data: Record<string, unknown>, context?: {
  runId?: string | null; epoch?: string | null; trace?: Record<string, string>
}) => void

/** A separate consumer journal cannot feed back into the host's event stream. */
export function consumerRecorder(workspace: string): ConsumerRecord {
  const clockId = randomUUID(), directory = join(workspace, 'logs', 'consumers')
  const path = join(directory, `pet-${process.pid}-${clockId}.jsonl`)
  mkdirSync(directory, { recursive: true })
  let seq = 0
  return (type, data, context = {}) => {
    seq++
    const at = new Date().toISOString(), atMs = performance.now()
    appendFileSync(path, JSON.stringify({ schemaVersion: 2, source: { component: 'pet' },
      runId: context.runId ?? null, seq, at, atMs,
      origin: { eventId: `${clockId}:${seq}`, clockId, seq, at, atMs },
      trace: { ...context.trace, ...(context.epoch ? { epoch: context.epoch } : {}) }, type, data }) + '\n')
  }
}

export interface LogBlock {
  id: string
  kind: 'thinking' | 'text' | 'tool' | 'system' | 'diagnostic'
  at: string
  title: string
  text: string
  status: 'running' | 'complete' | 'error'
  tool?: { intent?: string; args?: unknown; result?: unknown }
  data?: Record<string, unknown>
  source?: EventSource
  trace?: Record<string, string>
  eventId?: string
  seq?: number
  updatedAt?: string
}

export interface RsaPetSnapshot {
  workspace: string | null
  runId: string | null
  epoch: string | null
  phase: string
  intent: string | null
  observationUrl: string | null
  updatedAt: string | null
  error: string | null
  dashboardUrl: string
  blocks?: LogBlock[]
}

export interface RsaActivitySnapshot {
  /** Identifies one run/epoch, so switching it also clears old bubbles. */
  identity: string
  activity: 'running' | 'manual' | 'offline' | 'idle'
  current: RsaPetSnapshot
  blocks: LogBlock[]
  projection?: ActivityProjection
}

export interface RsaActivitySource {
  identity(): string | null
  read(signal?: AbortSignal): Promise<RsaActivitySnapshot>
  stop?(): void
  record?: ConsumerRecord
}

// The dashboard owns log projection and live host checks. No second parser here.
export interface RsaRunView {
  project: string
  run: string
  manifest: { workspace: string }
  selectedEpoch: string | null
  calls: { inputObservations: string[]; tools: { intent: string; at: string }[] }[]
  observations: { id: string; mediaType: string }[]
  live: { runId: string; epoch: string | null; mode: string; connected: boolean; reason: string } | null
  livePhase: { label: string } | null
  updatedAt: string
}

/** Matches RSA resolveWorkspaceState; the input must already be canonical. */
export function rsaProjectId(workspace: string): string {
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
  const name = basename(workspace).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace'
  return `ws-${name}-${hash}`
}

function url(base: string, path: string, query: Record<string, string | null> = {}): string {
  const result = new URL(path, base)
  for (const [key, value] of Object.entries(query)) if (value !== null) result.searchParams.set(key, value)
  return result.href
}

export function projectRsaRun(run: RsaRunView, workspace: string, dashboardUrl: string, blocks: LogBlock[] = []): RsaActivitySnapshot {
  // Releasing control clears the host's epoch; the log retains the reviewed epoch.
  const currentRun = run.live?.runId === run.run && (run.live.epoch === run.selectedEpoch
    || (run.live.mode === 'manual' && run.live.epoch === null))
  const connected = currentRun && run.live!.connected
  const activity = !run.live || !connected ? 'offline' : run.live!.mode === 'auto' ? 'running'
    : run.live!.mode === 'manual' ? 'manual' : 'idle'
  const phase = !run.live ? 'Host 离线' : !currentRun ? '历史运行'
    : !run.live.connected ? '设备已断开' : activity === 'running' ? run.livePhase?.label ?? '等待下一步'
      : activity === 'manual' ? run.selectedEpoch === null ? '已连接，等待 AI 接管' : '已交还控制权'
        : run.live.mode === 'acquiring' ? '正在接管' : '正在交还控制权'
  const lastCall = run.calls.at(-1)
  // Never substitute a newly captured frame which the model has not received.
  const imageId = [...lastCall?.inputObservations ?? []].reverse().find(id => run.observations.some(o => o.id === id && o.mediaType.startsWith('image/')))
  const intent = run.calls.flatMap(call => call.tools).reverse().find(tool => tool.intent.trim())?.intent ?? null
  return {
    identity: `${workspace}:${run.run}:${run.selectedEpoch ?? ''}`, activity, blocks,
    current: {
      workspace, runId: run.run, epoch: run.selectedEpoch, phase, intent, blocks,
      observationUrl: imageId ? url(dashboardUrl, '/api/media', { project: run.project, run: run.run, id: imageId }) : null,
      updatedAt: run.updatedAt, error: activity === 'offline' ? phase : null,
      dashboardUrl: url(dashboardUrl, '/', { project: run.project, run: run.run, epoch: run.selectedEpoch }),
    },
  }
}

/** Read-only polling source. It never calls the dashboard's control endpoint. */
export class RsaSource implements RsaActivitySource {
  private readonly workspace: string
  private readonly project: string
  private readonly dashboardUrl: string
  private latest: RsaActivitySnapshot
  private abort = new AbortController()
  private progress = ''
  readonly record: ConsumerRecord
  constructor(private options: { workspace: string; dashboardUrl: string; onSnapshot(snapshot: RsaPetSnapshot): void; record?: ConsumerRecord }) {
    this.workspace = realpathSync(options.workspace)
    this.project = rsaProjectId(this.workspace)
    this.dashboardUrl = new URL(options.dashboardUrl).origin
    this.latest = this.empty('尚未读取日志', 'idle')
    this.record = options.record ?? (() => {})
  }
  identity(): string { return `${this.workspace}:${this.dashboardUrl}` }
  stop() { this.abort.abort() }
  private empty(phase: string, activity: RsaActivitySnapshot['activity']): RsaActivitySnapshot {
    return { identity: this.identity(), activity, blocks: [], current: {
      workspace: this.workspace, runId: null, epoch: null, phase, intent: null, observationUrl: null,
      updatedAt: null, error: null, dashboardUrl: this.dashboardUrl, blocks: [],
    } }
  }
  private async json<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(url(this.dashboardUrl, path), { signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`日志服务 HTTP ${response.status}`)
    return response.json() as Promise<T>
  }
  async read(signal?: AbortSignal): Promise<RsaActivitySnapshot> {
    const started = performance.now()
    this.abort.signal.throwIfAborted()
    const bounded = AbortSignal.timeout(8_000)
    const requestSignal = AbortSignal.any([this.abort.signal, bounded, ...(signal ? [signal] : [])])
    let next: RsaActivitySnapshot
    let readError: string | undefined
    try {
      const catalog = await this.json<{ id: string; runs: { id: string; kind?: string; benchmark?: unknown }[] }[]>('/api/catalog', requestSignal)
      const runId = catalog.find(project => project.id === this.project)?.runs
        .filter(run => run.kind !== 'benchmark' && !run.benchmark).map(run => run.id).sort().at(-1)
      if (!runId) next = this.empty('工作区尚无运行记录', 'idle')
      else {
        const query = new URLSearchParams({ project: this.project, run: runId })
        const run = await this.json<RsaRunView>(`/api/run?${query}`, requestSignal)
        if (run.manifest.workspace !== this.workspace) throw new Error('运行记录不属于当前工作区')
        if (run.selectedEpoch) query.set('epoch', run.selectedEpoch)
        const activity = await this.json<{ blocks: LogBlock[]; projection?: ActivityProjection }>(`/api/activity?${query}`, requestSignal)
        next = { ...projectRsaRun(run, this.workspace, this.dashboardUrl, activity.blocks), projection: activity.projection }
      }
    } catch (error) {
      if (signal?.aborted || this.abort.signal.aborted) throw error
      readError = String(error)
      next = { ...this.latest, activity: 'offline', current: {
        ...this.latest.current, phase: '日志服务离线', intent: null, error: String(error),
      } }
    }
    if (signal?.aborted) throw signal.reason
    this.abort.signal.throwIfAborted()
    // Streaming text can advance without a new events.jsonl sequence.
    const progress = JSON.stringify([next.identity, next.activity, next.current.error, next.projection?.throughSeq,
      next.blocks.map(block => [block.id, block.status, block.updatedAt, block.text.length])])
    if (progress !== this.progress) {
      this.record(readError ? 'read_error' : 'read', {
        durationMs: performance.now() - started, projection: next.projection, blocks: next.blocks.length,
        activity: next.activity, error: readError ?? null,
      }, next.current)
      this.progress = progress
    }
    this.latest = next
    this.options.onSnapshot(next.current)
    return next
  }
}
