import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityDisplay } from './activity-controller.js'
import { DEFAULT_ACTIVITY_PREFERENCES } from './activity-policy.js'
import { RsaActivityController } from './rsa-activity-controller.js'
import type { ActivityBlock, LogBlock, RsaActivitySnapshot } from './rsa-source.js'

let revision = 0
const versions = new Map<string, { text: string; block: ActivityBlock }>()

function block(id: string, kind: LogBlock['kind'] = 'tool', status: LogBlock['status'] = 'complete', text = id): LogBlock {
  return { id, kind, status, text, title: kind, at: '2026-10-17T13:40:00Z' }
}
function state(blocks: LogBlock[] = [], overrides: Partial<RsaActivitySnapshot> = {}): RsaActivitySnapshot {
  const changes = blocks.map(block => {
    const old = versions.get(block.id), text = JSON.stringify(block)
    if (old?.text === text) return old.block
    const next = { ...block, revision: ++revision, createdRevision: old?.block.createdRevision ?? revision }
    versions.set(block.id, { text, block: next }); return next
  })
  return { identity: 'workspace:run:epoch', activity: 'running', blocks: changes, mode: 'delta', revision, hasMore: false, current: {
    workspace: '/workspace', runId: 'run', epoch: 'epoch', phase: '等待模型首事件', intent: '查看证据',
    observationUrl: null, updatedAt: '2026-10-17T13:40:00Z', error: null, dashboardUrl: 'http://localhost:3015/?project=workspace&run=run&epoch=epoch',
  }, ...overrides }
}
function setup() {
  let identity = 'workspace-a', foreground = false, petVisible = true
  const read = vi.fn().mockResolvedValue(state())
  const sent: { surface: string; event: ActivityDisplay }[] = []
  const open = vi.fn()
  const record = vi.fn()
  const controller = new RsaActivityController({ identity: () => identity, read }, {
    foreground: () => foreground, petVisible: () => petVisible, open,
    send: (surface, event) => sent.push({ surface, event }),
  }, structuredClone(DEFAULT_ACTIVITY_PREFERENCES), record)
  return { controller, read, sent, open, record,
    shows: () => sent.filter((item): item is { surface: string; event: Extract<ActivityDisplay, { type: 'show' }> } => item.event.type === 'show'),
    switchSource: () => { identity = 'workspace-b' },
    foreground: () => { foreground = true; controller.transition() },
    showPet: () => { petVisible = true; controller.transition() },
    hidePet: () => { petVisible = false; controller.transition() },
    poll: async (snapshot = state()) => { read.mockResolvedValueOnce(snapshot); await controller.poll() },
  }
}
beforeEach(() => { revision = 0; versions.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T13:40:00Z')) })
afterEach(() => vi.useRealTimers())

describe('RSA block speech', () => {
  it('records queue pressure and dispatch with provenance without claiming renderer paint', async () => {
    const s = setup(); await s.poll(); s.hidePet()
    const item = { ...block('first'), source: { component: 'shiori', implementation: 'omp' },
      trace: { traceId: 'trace', spanId: 'span' }, eventId: 'host:12', seq: 12 }
    await s.poll(state([item, block('second')]))
    expect(s.record).toHaveBeenLastCalledWith('queue_changed', expect.objectContaining({ pendingBlocks: 2, queuedBlocks: 2 }),
      { runId: 'run', epoch: 'epoch' })
    const count = s.record.mock.calls.length
    await s.poll(state([item, block('second')]))
    expect(s.record).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(500)
    s.showPet()
    expect(s.record).toHaveBeenCalledWith('display_dispatched', expect.objectContaining({ blockId: 'first',
      eventId: 'host:12', source: item.source, queueWaitMs: expect.any(Number), surface: 'pet' }),
      { runId: 'run', epoch: 'epoch', trace: item.trace })
    expect(s.record.mock.calls.map(call => call[0])).not.toContain('painted')
    s.controller.stop()
  })
  it.each(['thinking', 'text', 'tool', 'system', 'diagnostic'] as const)('passes the complete %s block to the content renderer', async (kind) => {
    const s = setup(); await s.poll()
    s.controller.setPreferences({ ...structuredClone(DEFAULT_ACTIVITY_PREFERENCES),
      blocks: { thinking: true, text: true, tool: true, system: true, diagnostic: true } })
    const source: LogBlock = { ...block('source', kind, 'complete', 'Long source content. '.repeat(50)),
      ...(kind === 'tool' ? { tool: { intent: 'Inspect', args: { command: 'inspect' }, result: { exitCode: 0 } } } : {}),
      ...(['system', 'diagnostic'].includes(kind) ? { data: { mode: 'manual', elapsedMs: 1200 } } : {}),
    }
    await s.poll(state([source]))
    expect(s.shows()[0].event.input).toMatchObject({ description: source.text, block: source })
    expect(s.shows()[0].event.input.description!.length).toBeGreaterThan(240)
    s.controller.stop()
  })
  it('omits raw log fields in brief mode, including structured tool results', async () => {
    const s = setup(); await s.poll()
    s.controller.setPreferences({ ...structuredClone(DEFAULT_ACTIVITY_PREFERENCES), brief: true })
    const source: LogBlock = { ...block('source', 'tool', 'complete', 'PRIVATE source text'), title: 'PRIVATE tool name',
      tool: { intent: 'PRIVATE intent', args: { command: 'PRIVATE command' }, result: { stdout: 'PRIVATE result' } },
    }
    await s.poll(state([source]))
    const input = s.shows()[0].event.input
    expect(input).not.toHaveProperty('block')
    expect(input).not.toHaveProperty('description')
    expect(JSON.stringify(input)).not.toContain('PRIVATE')
    s.controller.stop()
  })
  it('updates structured content in place even when the plain text is unchanged', async () => {
    const s = setup(); await s.poll()
    const source = { ...block('source', 'tool', 'running'), tool: { args: { command: 'inspect' } } }
    await s.poll(state([source]))
    const displayId = s.shows()[0].event.displayId
    await s.poll(state([{ ...source, tool: { ...source.tool, result: { stdout: 'ready' } } }]))
    expect(s.shows()).toHaveLength(2)
    expect(s.shows()[1].event).toMatchObject({ displayId, input: { block: { tool: { result: { stdout: 'ready' } } } } })
    s.controller.stop()
  })
  it('baselines old history and displays only the newest active block on first connection', async () => {
    const s = setup()
    await s.poll(state([block('old', 'text'), block('active-tool', 'tool', 'running'), block('active-thinking', 'thinking', 'running')]))
    expect(s.shows()).toHaveLength(1)
    expect(s.shows()[0].event.input.id).toBe('active-thinking')
    expect(s.shows()[0].event.input.duration).toBeNull()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(s.shows()).toHaveLength(1)
    expect(s.sent.at(-1)?.event.type).toBe('show')
    s.controller.stop()
  })
  it('queues every thinking, text and tool block in order even when legacy progress is disabled', async () => {
    const s = setup(); await s.poll()
    expect(DEFAULT_ACTIVITY_PREFERENCES.events.progress).toBe(false)
    const blocks = [block('thought', 'thinking'), block('message', 'text'), block('tool-a'), block('tool-b')]
    await s.poll(state(blocks)); expect(s.shows().map(item => item.event.input.id)).toEqual(['thought'])
    await vi.advanceTimersByTimeAsync(12_000)
    expect(s.shows().map(item => item.event.input.id)).toEqual(['thought', 'message', 'tool-a', 'tool-b'])
    await vi.advanceTimersByTimeAsync(4_000); await s.poll(state(blocks))
    expect(s.shows()).toHaveLength(4)
    s.controller.stop()
  })
  it('keeps a slow live block visible, merges deltas in place, and starts its four seconds only on completion', async () => {
    const s = setup(); await s.poll()
    const initial = [block('thinking', 'thinking', 'running', ''), block('tool', 'tool', 'running', 'pending')]
    await s.poll(state(initial)); const displayId = s.shows()[0].event.displayId
    await vi.advanceTimersByTimeAsync(12_000)
    expect(s.shows()).toHaveLength(1)
    expect(s.sent.at(-1)?.event.type).toBe('show')
    await s.poll(state([block('thinking', 'thinking', 'running', 'first'), initial[1]]))
    expect(s.shows().at(-1)?.event).toMatchObject({ displayId, input: { description: 'first', duration: null } })
    const complete = [block('thinking', 'thinking', 'complete', 'first, then second'), block('tool', 'tool', 'complete', 'complete tool result')]
    await s.poll(state(complete))
    expect(s.shows().at(-1)?.event).toMatchObject({ displayId, input: { description: 'first, then second', duration: 4_000 } })
    await vi.advanceTimersByTimeAsync(2_000)
    await s.poll(state(complete))
    expect(s.shows().at(-1)?.event.input.id).toBe('thinking')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.shows().at(-1)?.event.input).toMatchObject({ id: 'tool', description: 'complete tool result' })
    expect(new Set(s.shows().filter(item => item.event.input.id === 'thinking').map(item => item.event.displayId)).size).toBe(1)
    s.controller.stop()
  })
  it('preempts with an error without losing the interrupted block or other pending blocks', async () => {
    const s = setup(); await s.poll()
    await s.poll(state([block('first', 'text'), block('second')]))
    await s.poll(state([block('first', 'text'), block('second'), block('failed', 'tool', 'error')]))
    expect(s.shows().at(-1)?.event.input.id).toBe('failed')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(s.shows().map(item => item.event.input.id)).toEqual(['first', 'failed', 'first', 'second'])
    s.controller.stop()
  })
  it('filters only by block visibility and keeps all blocks available in the source snapshot', async () => {
    const s = setup(); await s.poll()
    const blocks = [block('http', 'diagnostic'), block('text', 'text'), block('tool')]
    await s.poll(state(blocks)); expect(s.shows()[0].event.input.id).toBe('text')
    s.controller.setPreferences({ ...structuredClone(DEFAULT_ACTIVITY_PREFERENCES), blocks: { thinking: true, text: true, tool: false, system: true, diagnostic: false } })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(s.shows()).toHaveLength(1)
    expect(blocks).toHaveLength(3)
    expect(s.controller.signalSnapshot()).toEqual([])
    s.controller.stop()
  })
  it('prefers a visible pet with owner open, and keeps hidden work queued until a surface returns', async () => {
    const s = setup(); await s.poll(); s.hidePet()
    await s.poll(state([block('waiting', 'text')]))
    expect(s.shows()).toHaveLength(0)
    s.foreground(); expect(s.shows()[0].surface).toBe('main')
    s.showPet(); expect(s.shows().at(-1)?.surface).toBe('pet')
    const count = s.sent.length; s.foreground(); expect(s.sent).toHaveLength(count)
    s.controller.stop()
  })
  it('briefly reports a manual connection without replaying completed errors or actions', async () => {
    const s = setup()
    const historical = state([block('old-action'), block('old-error', 'tool', 'error')], { activity: 'manual' })
    await s.poll(historical); await s.poll(historical)
    expect(s.shows()).toHaveLength(1)
    expect(s.shows()[0].event.input.title).toBe('本轮已结束，控制权已交还')
    await vi.advanceTimersByTimeAsync(4_000); await s.poll(historical)
    expect(s.shows()).toHaveLength(1)
    s.controller.stop()
  })
  it('does not claim a new workspace has finished before its first takeover', async () => {
    const s = setup()
    const fresh = state([], { activity: 'manual' })
    fresh.current.epoch = null
    await s.poll(fresh); await s.poll(fresh)
    expect(s.shows()).toHaveLength(1)
    expect(s.shows()[0].event.input.title).toBe('已连接，等待 AI 接管')
    expect(JSON.stringify(s.shows())).not.toContain('结束')
    s.controller.stop()
  })
  it('pauses stale running blocks while offline but preserves completed records and resumes updated blocks', async () => {
    const s = setup(); await s.poll()
    const blocks = [block('active', 'thinking', 'running'), block('done', 'text')]
    await s.poll(state(blocks)); await s.poll(state(blocks, { activity: 'offline' }))
    expect(s.shows().at(-1)?.event.input.id).toBe('done')
    await vi.advanceTimersByTimeAsync(4_000)
    await s.poll(state([block('active', 'thinking', 'complete'), blocks[1]], { activity: 'manual' }))
    expect(s.shows().at(-1)?.event.input.id).toBe('active')
    s.controller.stop()
  })
  it('scopes Open/Dismiss to the current source and clears old queued blocks on epoch change', async () => {
    const s = setup(); await s.poll()
    await s.poll(state([block('first'), block('queued')]))
    const oldId = s.shows()[0].event.displayId
    expect(s.controller.open(oldId, 'main')).toBe(false)
    expect(s.controller.open(oldId, 'pet')).toBe(true)
    const detail = new URL(s.open.mock.calls.at(-1)![0])
    expect(Object.fromEntries(detail.searchParams)).toMatchObject({ project: 'workspace', run: 'run', epoch: 'epoch', view: 'live', block: 'first' })
    await s.poll(state([block('next-active', 'text', 'running')], { identity: 'workspace:run:new-epoch' }))
    expect(s.controller.dismiss(oldId, 'pet')).toBe(false)
    expect(s.shows().at(-1)?.event.input.id).toBe('next-active')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(s.shows().filter(item => item.event.input.id === 'queued')).toHaveLength(1)
    s.controller.stop()
  })
  it('does not replay unseen historical blocks, late errors, or dismissed streaming blocks', async () => {
    const s = setup()
    await s.poll(state([], { mode: 'snapshot', revision: 100 }))
    const old: ActivityBlock = { ...block('outside-recent-snapshot', 'tool', 'error'), createdRevision: 3, revision: 101 }
    const fresh: ActivityBlock = { ...block('fresh', 'thinking', 'running', 'live'), createdRevision: 102, revision: 102 }
    await s.poll(state([], { blocks: [old, fresh], revision: 102 }))
    expect(s.shows().map(item => item.event.input.id)).toEqual(['fresh'])
    expect(s.controller.dismiss(s.shows()[0].event.displayId, 'pet')).toBe(true)
    await s.poll(state([], { blocks: [{ ...fresh, revision: 103, status: 'error', text: 'late failure' }], revision: 103 }))
    expect(s.shows()).toHaveLength(1)
    s.controller.stop()
  })
  it('accepts and acknowledges each page before requesting the next, merging updates without losing queued blocks', async () => {
    const s = setup(); await s.poll(state([], { mode: 'snapshot', revision: 10 })); s.hidePet()
    const a: ActivityBlock = { ...block('a', 'text', 'running', 'start'), createdRevision: 11, revision: 11 }
    const b: ActivityBlock = { ...block('b'), createdRevision: 12, revision: 12 }
    const firstAccepted = vi.fn(() => {
      expect(s.record).toHaveBeenLastCalledWith('queue_changed', expect.objectContaining({ pendingBlocks: 2 }), expect.anything())
    })
    const secondAccepted = vi.fn()
    s.read.mockResolvedValueOnce(state([], { blocks: [a, b], revision: 12, hasMore: true, acknowledge: firstAccepted }))
    s.read.mockImplementationOnce(async () => {
      expect(firstAccepted).toHaveBeenCalledOnce()
      return state([], { blocks: [{ ...a, revision: 13, status: 'complete', text: 'finished' }], revision: 13, acknowledge: secondAccepted })
    })
    await s.controller.poll()
    expect(secondAccepted).toHaveBeenCalledOnce()
    s.showPet(); expect(s.shows()[0].event.input).toMatchObject({ id: 'a', description: 'finished' })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(s.shows().at(-1)?.event.input.id).toBe('b')
    s.controller.stop()
  })
  it('rebaselines a snapshot reset without replaying recent completed blocks', async () => {
    const s = setup(); await s.poll()
    await s.poll(state([block('queued')]))
    await s.poll(state([block('old-error', 'tool', 'error'), block('running', 'text', 'running')], { mode: 'snapshot' }))
    expect(s.shows().at(-1)?.event.input.id).toBe('running')
    expect(s.shows().some(item => item.event.input.id === 'old-error')).toBe(false)
    s.controller.stop()
  })
  it('serializes each source but immediately reads a new source and ignores late old workspace results', async () => {
    const s = setup(); let resolve!: (value: RsaActivitySnapshot) => void, resolveNew!: (value: RsaActivitySnapshot) => void
    const staleAccepted = vi.fn()
    s.read.mockImplementationOnce((signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return new Promise<RsaActivitySnapshot>(r => { resolve = r })
    })
    const pending = s.controller.poll(); await s.controller.poll(); expect(s.read).toHaveBeenCalledTimes(1)
    s.read.mockImplementationOnce(() => new Promise<RsaActivitySnapshot>(r => { resolveNew = r }))
    s.switchSource(); const next = s.controller.poll()
    expect(s.read).toHaveBeenCalledTimes(2)
    resolve(state([block('stale', 'text', 'running')], { acknowledge: staleAccepted, hasMore: true })); await pending
    expect(staleAccepted).not.toHaveBeenCalled()
    expect(s.shows()).toHaveLength(0)
    await s.controller.poll()
    expect(s.read).toHaveBeenCalledTimes(2)
    resolveNew(state([block('fresh', 'text', 'running')])); await next
    expect(s.shows()).toHaveLength(1)
    s.controller.stop(); s.controller.transition(); await s.controller.poll()
    expect(s.read).toHaveBeenCalledTimes(2); expect(s.controller.snapshot()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
