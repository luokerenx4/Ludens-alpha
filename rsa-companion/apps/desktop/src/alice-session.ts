import { randomUUID } from 'node:crypto'
import { consumerRecorder, rsaProjectId, RsaSource, type RsaActivitySnapshot, type RsaActivitySource, type RsaPetSnapshot } from './rsa-source.js'

export interface AliceTarget {
  project: string
  workspace: string
  revision: string
  updatedAt: string
}
type SourceFactory = (workspace: string, onSnapshot: (snapshot: RsaPetSnapshot) => void) => RsaActivitySource
type ConsumerPhase = 'idle' | 'switching' | 'following' | 'error'

/** One desktop instance follows the Dashboard's selected workspace, independently of page navigation. */
export class AliceSessionCoordinator implements RsaActivitySource {
  private target: AliceTarget | null = null
  private source: RsaActivitySource | undefined
  private generation = 0
  private current: RsaPetSnapshot
  private phase: ConsumerPhase = 'idle'
  private loadedRevision: string | null = null
  private stopped = false
  private targetBusy = false
  private heartbeatPending = false
  private heartbeatRequest?: Promise<void>
  private readonly abort = new AbortController()
  private readonly instanceId = randomUUID()
  private readonly origin: string
  private readonly createSource: SourceFactory
  private targetTimer?: ReturnType<typeof setInterval>
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor(private options: {
    dashboardUrl: string
    onSnapshot(snapshot: RsaPetSnapshot): void
    onTargetChanged(): void
    createSource?: SourceFactory
  }) {
    this.origin = new URL(options.dashboardUrl).origin
    this.current = this.empty('请选择要跟随的工作区')
    this.createSource = options.createSource ?? ((workspace, onSnapshot) => new RsaSource({
      workspace, dashboardUrl: this.origin, record: consumerRecorder(workspace), onSnapshot,
    }))
  }

  identity() { return `${this.origin}:alice:${this.generation}` }
  record: NonNullable<RsaActivitySource['record']> = (...args) => this.source?.record?.(...args)
  private empty(phase: string): RsaPetSnapshot {
    return { workspace: this.target?.workspace ?? null, runId: null, epoch: null, phase,
      intent: null, observationUrl: null, updatedAt: null, error: null,
      dashboardUrl: this.target ? `${this.origin}/?project=${encodeURIComponent(this.target.project)}&view=live` : `${this.origin}/` }
  }
  private publish(snapshot: RsaPetSnapshot) {
    this.current = snapshot
    this.options.onSnapshot(snapshot)
  }
  private async request(method: string, body?: unknown) {
    const response = await fetch(`${this.origin}/api/alice`, {
      method, cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2_000)]),
      headers: { Origin: this.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Alice 日志服务 HTTP ${response.status}`)
    return response.json()
  }
  async start(workspace?: string) {
    this.targetTimer = setInterval(() => { void this.pollTarget() }, 2_500)
    this.heartbeatTimer = setInterval(() => { void this.heartbeat() }, 2_500)
    // An explicit launch workspace only supplies the first-ever selection.
    if (workspace) {
      try { await this.request('PUT', { project: rsaProjectId(workspace), ifUnset: true }) }
      catch { /* The shared target remains authoritative; the next GET reports connection failures. */ }
    }
    await this.pollTarget()
    await this.heartbeat()
  }
  async pollTarget() {
    if (this.stopped || this.targetBusy) return
    this.targetBusy = true
    try {
      const state = await this.request('GET') as { target: AliceTarget | null }
      if (this.stopped) return
      const next = state.target
      if (next !== null && (!next || typeof next.project !== 'string' || typeof next.workspace !== 'string' || typeof next.revision !== 'string'))
        throw new Error('Alice 跟随目标无效')
      if (next?.revision !== this.target?.revision || next?.workspace !== this.target?.workspace || next?.project !== this.target?.project
        || (next && !this.source) || (!next && this.phase === 'error')) this.select(next)
    } catch (error) {
      if (!this.stopped) {
        this.phase = 'error'
        this.publish({ ...this.current, phase: '日志服务离线', error: String(error) })
      }
    } finally { this.targetBusy = false }
  }
  private select(target: AliceTarget | null) {
    this.source?.stop?.()
    this.source = undefined
    this.target = target
    const generation = ++this.generation
    this.loadedRevision = null
    this.phase = target ? 'switching' : 'idle'
    this.publish(this.empty(target ? '正在连接日志' : '请选择要跟随的工作区'))
    if (target) {
      try {
        this.source = this.createSource(target.workspace, snapshot => {
          if (this.stopped || generation !== this.generation) return
          this.loadedRevision = target.revision
          this.phase = snapshot.error ? 'error' : 'following'
          this.publish(snapshot)
          void this.heartbeat()
        })
      } catch (error) {
        this.phase = 'error'
        this.publish({ ...this.current, phase: '无法打开工作区', error: String(error) })
      }
    }
    this.options.onTargetChanged()
    void this.heartbeat()
  }
  async read(signal?: AbortSignal): Promise<RsaActivitySnapshot> {
    this.abort.signal.throwIfAborted()
    signal?.throwIfAborted()
    const generation = this.generation, source = this.source
    if (source) {
      const snapshot = await source.read(signal)
      if (generation !== this.generation) throw new DOMException('Follow target changed', 'AbortError')
      return snapshot
    }
    return { identity: this.identity(), activity: 'idle', current: this.current, blocks: [], mode: 'snapshot', revision: 0, hasMore: false }
  }
  heartbeat(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.heartbeatPending = true
    if (this.heartbeatRequest) return this.heartbeatRequest
    this.heartbeatRequest = (async () => {
      do {
        this.heartbeatPending = false
        try {
          await this.request('POST', {
            instanceId: this.instanceId, pid: process.pid, revision: this.loadedRevision, workspace: this.target?.workspace ?? null,
            runId: this.current.runId, phase: this.phase, error: this.current.error,
          })
        } catch { /* The next independent heartbeat retries; log consumption must keep running. */ }
      } while (this.heartbeatPending && !this.stopped)
    })().finally(() => { this.heartbeatRequest = undefined })
    return this.heartbeatRequest
  }
  stop() {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.targetTimer); clearInterval(this.heartbeatTimer)
    this.abort.abort()
    this.source?.stop?.()
  }
}
