import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ActivityChangesClient, type ActivityBlock, type ActivityProjection } from '../../../../rsa-dashboard/lib/activity-client.js'
export type { ActivityBlock, ActivityProjection, ActivityChanges, LogBlock } from '../../../../rsa-dashboard/lib/activity-client.js'

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
}

export interface RsaActivitySnapshot {
  /** Identifies one run/epoch, so switching it also clears old bubbles. */
  identity: string
  activity: 'running' | 'manual' | 'offline' | 'idle'
  current: RsaPetSnapshot
  blocks: ActivityBlock[]
  mode: 'snapshot' | 'delta'
  revision: number
  hasMore: boolean
  /** Advance the source cursor only after this page has entered the queue. */
  acknowledge?(): void
  projection?: ActivityProjection
}

export interface RsaActivitySource {
  identity(): string | null
  read(signal?: AbortSignal): Promise<RsaActivitySnapshot>
  stop?(): void
  record?: ConsumerRecord
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

/** Read-only polling source. It never calls the dashboard's control endpoint. */
export class RsaSource implements RsaActivitySource {
  private readonly workspace: string
  private readonly project: string
  private readonly dashboardUrl: string
  private latest: Omit<RsaActivitySnapshot, 'blocks' | 'acknowledge'>
  private readonly client: ActivityChangesClient
  private abort = new AbortController()
  private progress = ''
  readonly record: ConsumerRecord
  constructor(private options: { workspace: string; dashboardUrl: string; onSnapshot(snapshot: RsaPetSnapshot): void; record?: ConsumerRecord }) {
    this.workspace = realpathSync(options.workspace)
    this.project = rsaProjectId(this.workspace)
    this.dashboardUrl = new URL(options.dashboardUrl).origin
    this.client = new ActivityChangesClient({ project: this.project, baseUrl: this.dashboardUrl })
    this.latest = { identity: this.identity(), activity: 'idle', mode: 'snapshot', revision: 0, hasMore: false,
      current: { workspace: this.workspace, runId: null, epoch: null, phase: '尚未读取日志', intent: null,
        observationUrl: null, updatedAt: null, error: null, dashboardUrl: this.dashboardUrl } }
    this.record = options.record ?? (() => {})
  }
  identity(): string { return `${this.workspace}:${this.dashboardUrl}` }
  stop() { this.abort.abort() }
  async read(signal?: AbortSignal): Promise<RsaActivitySnapshot> {
    const started = performance.now()
    this.abort.signal.throwIfAborted()
    const bounded = AbortSignal.timeout(8_000)
    const requestSignal = AbortSignal.any([this.abort.signal, bounded, ...(signal ? [signal] : [])])
    let next: RsaActivitySnapshot
    let readError: string | undefined
    try {
      const page = await this.client.read(requestSignal)
      if (page.current.workspace !== null && page.current.workspace !== this.workspace)
        throw new Error('运行记录不属于当前工作区')
      const { activity, observationId, ...current } = page.current
      next = {
        identity: `${this.workspace}:${page.scope.runId ?? ''}:${page.scope.epoch ?? ''}:${page.projection.generation}`,
        activity, blocks: page.blocks, mode: page.mode, revision: page.projection.revision,
        hasMore: page.hasMore, projection: page.projection,
        current: { ...current, workspace: current.workspace ?? this.workspace, phase: current.phase ?? '尚未读取日志',
          // Pet health describes log consumption; runtime failures are activity blocks.
          error: null,
          observationUrl: observationId && current.runId ? url(this.dashboardUrl, '/api/media', {
            project: this.project, run: current.runId, id: observationId,
          }) : null,
          dashboardUrl: url(this.dashboardUrl, '/', { project: this.project, run: current.runId, epoch: current.epoch }),
        },
        acknowledge: page.acknowledge,
      }
    } catch (error) {
      if (signal?.aborted || this.abort.signal.aborted) throw error
      readError = String(error)
      next = { ...this.latest, mode: 'delta', hasMore: false, blocks: [], activity: 'offline', current: {
        ...this.latest.current, phase: '日志服务离线', intent: null, error: String(error),
      } }
    }
    if (signal?.aborted) throw signal.reason
    this.abort.signal.throwIfAborted()
    // Revisions include streaming text; no full-history fingerprint or retained block cache.
    const progress = JSON.stringify([next.identity, next.activity, next.current.error, next.projection?.throughSeq, next.revision])
    if (progress !== this.progress) {
      this.record(readError ? 'read_error' : 'read', {
        durationMs: performance.now() - started, projection: next.projection, blocks: next.blocks.length,
        activity: next.activity, mode: next.mode, revision: next.revision, hasMore: next.hasMore, error: readError ?? null,
      }, next.current)
      this.progress = progress
    }
    const { blocks: _blocks, acknowledge: _acknowledge, ...latest } = next
    this.latest = latest
    this.options.onSnapshot(next.current)
    return next
  }
}
