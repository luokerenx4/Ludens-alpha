import type { ActivityDisplay, ActivitySurface } from './activity-controller.js'
import type { AgentActivitySignal } from './activity-projection.js'
import { briefNotification, type ActivityPreferences, type SerializedNotification } from './activity-policy.js'
import type { ConsumerRecord, LogBlock, RsaActivitySnapshot, RsaActivitySource } from './rsa-source.js'
import { blockUrl } from './dashboard-window.js'

const PREVIEW_MS = 4_000
type Displayed = { blockId: string; displayId: string; surface: 'main' | 'pet'; input: SerializedNotification }

/** One ordered block queue, one bubble. Streaming updates retain their block ID. */
export class RsaActivityController {
  private sourceId: string | null = null
  private runId: string | null = null
  private activity: RsaActivitySnapshot['activity'] = 'idle'
  private pending = new Map<string, LogBlock>()
  private queuedAt = new Map<string, number>()
  private progress = ''
  private throughSeq = 0
  private revision = 0
  private context: { runId?: string | null; epoch?: string | null } = {}
  private dashboardUrl = ''
  private current: Displayed | null = null
  private serial = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private abort: AbortController | null = null
  private stopped = false
  constructor(private source: RsaActivitySource, private surface: Omit<ActivitySurface, 'open'> & { open(url: string): void }, private prefs: ActivityPreferences,
    private record: ConsumerRecord = (...args) => source.record?.(...args)) {}

  private chosenSurface(): 'main' | 'pet' | null {
    if (!this.prefs.enabled || this.prefs.pausedUntil > Date.now()) return null
    return this.surface.petVisible() && this.prefs.pet ? 'pet'
      : this.surface.foreground() && this.prefs.main ? 'main' : null
  }
  private visible(block: LogBlock) { return this.prefs.blocks[block.kind] }
  private eligible(block: LogBlock) {
    return this.visible(block) && (block.status !== 'running' || this.activity === 'running')
  }
  private hideCurrent() {
    clearTimeout(this.timer); this.timer = undefined
    if (this.current) this.surface.send(this.current.surface, { type: 'hide', displayId: this.current.displayId })
    this.current = null
  }
  private clear() { this.hideCurrent(); this.pending.clear(); this.queuedAt.clear(); this.revision = 0 }
  private enqueue(block: LogBlock) {
    if (!this.pending.has(block.id)) this.queuedAt.set(block.id, performance.now())
    this.pending.set(block.id, block)
  }
  private recordQueue() {
    const data = { ...this.context, throughSeq: this.throughSeq, revision: this.revision, pendingBlocks: this.pending.size,
      queuedBlocks: this.pending.size - (this.current ? 1 : 0), activeBlockId: this.current?.blockId ?? null }
    const progress = JSON.stringify(data)
    if (progress === this.progress) return
    this.progress = progress
    this.record('queue_changed', { ...data,
      oldestPendingMs: this.queuedAt.size ? performance.now() - Math.min(...this.queuedAt.values()) : 0 }, this.context)
  }
  setPreferences(prefs: ActivityPreferences) {
    this.prefs = prefs
    // Explicitly hidden kinds remain available in the owner's full log, but do
    // not occupy the speech queue or replay when the preference is enabled later.
    for (const [id, block] of this.pending) if (!this.visible(block)) { this.pending.delete(id); this.queuedAt.delete(id) }
    this.flush()
  }
  transition() { if (!this.stopped) this.flush() }
  signalSnapshot(): AgentActivitySignal[] { return [] }
  snapshot(): ActivityDisplay[] {
    return this.current?.surface === 'main' && this.sourceId === this.source.identity()
      ? [{ type: 'show', displayId: this.current.displayId, input: this.current.input }] : []
  }
  private target(displayId: unknown, surface: 'main' | 'pet') {
    return typeof displayId === 'string' && this.current?.displayId === displayId && this.current.surface === surface
      && this.sourceId === this.source.identity() ? this.current : null
  }
  dismiss(displayId: unknown, surface: 'main' | 'pet') {
    if (!this.target(displayId, surface)) return false
    this.finish(displayId as string); return true
  }
  open(displayId: unknown, surface: 'main' | 'pet') {
    const target = this.target(displayId, surface)
    if (!target) return false
    this.surface.open(blockUrl(this.dashboardUrl, target.blockId))
    this.finish(displayId as string); return true
  }
  stop() {
    if (this.stopped) return
    this.stopped = true; this.abort?.abort(); this.clear(); this.recordQueue(); this.source.stop?.()
  }
  private finish(displayId: string) {
    if (this.current?.displayId !== displayId) return
    this.pending.delete(this.current.blockId)
    this.queuedAt.delete(this.current.blockId)
    this.hideCurrent(); this.flush()
  }
  private render(block: LogBlock, surface: 'main' | 'pet') {
    const firstDispatch = !this.current || this.current.blockId !== block.id
    const displayId = this.current?.displayId ?? `rsa:block:${++this.serial}`
    let input: SerializedNotification = {
      id: block.id, title: block.title, description: block.text, block,
      status: block.status === 'error' ? 'error' : block.status === 'running' ? 'running' : 'info',
      duration: block.status === 'running' ? null : PREVIEW_MS, context: 'office',
    }
    if (surface === 'pet' && this.prefs.brief) input = briefNotification(input)
    const changed = !this.current || JSON.stringify(this.current.input) !== JSON.stringify(input)
    this.current = { blockId: block.id, displayId, surface, input }
    if (changed) {
      const started = performance.now()
      this.surface.send(surface, { type: 'show', displayId, input })
      // IPC dispatch is observable here; renderer paint is not.
      this.record('display_dispatched', { displayId, blockId: block.id, eventId: block.eventId,
        source: block.source, sourceSeq: block.seq, sourceUpdatedAt: block.updatedAt ?? block.at,
        surface, kind: block.kind, status: block.status, throughSeq: this.throughSeq,
        dispatchMs: performance.now() - started,
        ...(firstDispatch ? { queueWaitMs: started - (this.queuedAt.get(block.id) ?? started) } : {}),
      }, { ...this.context, trace: block.trace })
    }
    // A live block stays in place as text arrives. The preview clock starts
    // when it finishes; subsequent updates do not reset that clock.
    if (block.status === 'running') { clearTimeout(this.timer); this.timer = undefined }
    else if (!this.timer) this.timer = setTimeout(() => this.finish(displayId), PREVIEW_MS)
  }
  private flush() {
    if (this.stopped) return
    try {
      const surface = this.chosenSurface()
      const currentBlock = this.current ? this.pending.get(this.current.blockId) : undefined
      if (this.current && (!surface || this.current.surface !== surface || !currentBlock || !this.eligible(currentBlock))) this.hideCurrent()
      if (!surface) return
      const eligible = [...this.pending.values()].filter(block => this.eligible(block))
      const error = eligible.find(block => block.status === 'error')
      // Keep an interrupted block in its original place; an error never drops it.
      if (this.current && error && this.pending.get(this.current.blockId)?.status !== 'error') this.hideCurrent()
      const next = this.current ? this.pending.get(this.current.blockId) : error ?? eligible[0]
      if (next) this.render(next, surface)
    } finally { this.recordQueue() }
  }
  private accept(snapshot: RsaActivitySnapshot) {
    const changed = snapshot.identity !== this.runId || snapshot.mode === 'snapshot'
    this.context = { runId: snapshot.current.runId, epoch: snapshot.current.epoch }
    this.dashboardUrl = snapshot.current.dashboardUrl
    this.throughSeq = snapshot.projection?.throughSeq ?? 0
    this.activity = snapshot.activity
    if (changed) {
      this.clear(); this.runId = snapshot.identity
      // Connecting does not replay a completed history. An active block is live
      // state, and all subsequent new blocks are queued in their recorded order.
      if (snapshot.activity === 'running') {
        const active = [...snapshot.blocks].reverse().find(block => block.status === 'running' && this.visible(block))
        if (active) this.enqueue(active)
      } else if (snapshot.activity === 'manual' && this.prefs.blocks.system) {
        const manual: LogBlock = { id: 'connected:manual', kind: 'system', at: snapshot.current.updatedAt ?? '',
          title: snapshot.current.epoch === null ? '已连接，等待 AI 接管' : '本轮已结束，控制权已交还',
          text: '', status: 'complete' }
        this.enqueue(manual)
      }
    } else {
      for (const block of snapshot.blocks) {
        if (block.revision <= this.revision || !this.visible(block)) continue
        // Changes arrive in revision order, including each block's creation.
        // Late updates refresh pending/active blocks, but never resurrect a
        // historical or dismissed bubble. No all-history ID map is necessary.
        if (this.pending.has(block.id) || block.createdRevision > this.revision) {
          this.enqueue(block)
        }
      }
    }
    this.revision = snapshot.revision
    this.flush()
  }
  async poll() {
    if (this.stopped) return
    const sourceId = this.source.identity()
    if (sourceId !== this.sourceId) {
      this.abort?.abort(); this.abort = null; this.sourceId = sourceId; this.runId = null; this.clear()
      this.context = {}; this.throughSeq = 0; this.recordQueue()
    }
    if (this.abort || !sourceId) return
    const abort = this.abort = new AbortController()
    try {
      let more = true
      while (more) {
        const snapshot = await this.source.read(abort.signal)
        if (this.stopped || abort.signal.aborted || sourceId !== this.source.identity()) return
        this.accept(snapshot)
        snapshot.acknowledge?.()
        more = snapshot.hasMore
      }
    } catch {
      if (!this.stopped && sourceId === this.source.identity()) { this.activity = 'offline'; this.flush() }
    } finally { if (this.abort === abort) this.abort = null }
  }
}
