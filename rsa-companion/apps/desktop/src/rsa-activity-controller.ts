import type { ActivityDisplay, ActivitySurface } from './activity-controller.js'
import type { AgentActivitySignal } from './activity-projection.js'
import { briefNotification, type ActivityPreferences, type SerializedNotification } from './activity-policy.js'
import type { LogBlock, RsaActivitySnapshot, RsaActivitySource } from './rsa-source.js'

const PREVIEW_MS = 4_000
type Displayed = { blockId: string; displayId: string; surface: 'main' | 'pet'; input: SerializedNotification }

/** One ordered block queue, one bubble. Streaming updates retain their block ID. */
export class RsaActivityController {
  private sourceId: string | null = null
  private runId: string | null = null
  private activity: RsaActivitySnapshot['activity'] = 'idle'
  private known = new Map<string, LogBlock>()
  private pending = new Map<string, LogBlock>()
  private current: Displayed | null = null
  private serial = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private busy = false
  private abort: AbortController | null = null
  private stopped = false
  constructor(private source: RsaActivitySource, private surface: ActivitySurface, private prefs: ActivityPreferences) {}

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
  private clear() { this.hideCurrent(); this.pending.clear(); this.known.clear() }
  setPreferences(prefs: ActivityPreferences) {
    this.prefs = prefs
    // Explicitly hidden kinds remain available in the owner's full log, but do
    // not occupy the speech queue or replay when the preference is enabled later.
    for (const [id, block] of this.pending) if (!this.visible(block)) this.pending.delete(id)
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
    if (!this.target(displayId, surface)) return false
    this.surface.open('office')
    this.finish(displayId as string); return true
  }
  stop() {
    if (this.stopped) return
    this.stopped = true; this.abort?.abort(); this.clear(); this.source.stop?.()
  }
  private finish(displayId: string) {
    if (this.current?.displayId !== displayId) return
    this.pending.delete(this.current.blockId)
    this.hideCurrent(); this.flush()
  }
  private render(block: LogBlock, surface: 'main' | 'pet') {
    const displayId = this.current?.displayId ?? `rsa:block:${++this.serial}`
    let input: SerializedNotification = {
      id: block.id, title: block.title, description: block.text, block,
      status: block.status === 'error' ? 'error' : block.status === 'running' ? 'running' : 'info',
      duration: block.status === 'running' ? null : PREVIEW_MS, context: 'office',
    }
    if (surface === 'pet' && this.prefs.brief) input = briefNotification(input)
    const changed = !this.current || JSON.stringify(this.current.input) !== JSON.stringify(input)
    this.current = { blockId: block.id, displayId, surface, input }
    if (changed) this.surface.send(surface, { type: 'show', displayId, input })
    // A live block stays in place as text arrives. The preview clock starts
    // when it finishes; subsequent updates do not reset that clock.
    if (block.status === 'running') { clearTimeout(this.timer); this.timer = undefined }
    else if (!this.timer) this.timer = setTimeout(() => this.finish(displayId), PREVIEW_MS)
  }
  private flush() {
    if (this.stopped) return
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
  }
  private accept(snapshot: RsaActivitySnapshot) {
    const changed = snapshot.identity !== this.runId
    this.activity = snapshot.activity
    if (changed) {
      this.clear(); this.runId = snapshot.identity
      for (const block of snapshot.blocks) this.known.set(block.id, block)
      // Connecting does not replay a completed history. An active block is live
      // state, and all subsequent new blocks are queued in their recorded order.
      if (snapshot.activity === 'running') {
        const active = [...snapshot.blocks].reverse().find(block => block.status === 'running' && this.visible(block))
        if (active) this.pending.set(active.id, active)
      } else if (snapshot.activity === 'manual' && this.prefs.blocks.system) {
        const manual: LogBlock = { id: 'connected:manual', kind: 'system', at: snapshot.current.updatedAt ?? '',
          title: snapshot.current.epoch === null ? '已连接，等待 AI 接管' : '本轮已结束，控制权已交还',
          text: '', status: 'complete' }
        this.pending.set(manual.id, manual)
      }
    } else {
      for (const block of snapshot.blocks) {
        const previous = this.known.get(block.id)
        this.known.set(block.id, block)
        if (!this.visible(block)) continue
        if (!previous || this.pending.has(block.id) || (block.status === 'error' && previous.status !== 'error')) {
          this.pending.set(block.id, block)
        }
      }
    }
    this.flush()
  }
  async poll() {
    if (this.stopped) return
    const sourceId = this.source.identity()
    if (sourceId !== this.sourceId) {
      this.abort?.abort(); this.sourceId = sourceId; this.runId = null; this.clear()
    }
    if (this.busy || !sourceId) return
    this.busy = true
    const abort = this.abort = new AbortController()
    try {
      const snapshot = await this.source.read(abort.signal)
      if (this.stopped || abort.signal.aborted || sourceId !== this.source.identity()) return
      this.accept(snapshot)
    } catch {
      if (!this.stopped && sourceId === this.source.identity()) { this.activity = 'offline'; this.flush() }
    } finally { this.busy = false }
  }
}
