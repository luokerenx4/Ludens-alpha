import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumerRecorder, projectRsaRun, rsaProjectId, RsaSource, type RsaRunView, type LogBlock } from './rsa-source.js'

function run(overrides: Partial<RsaRunView> = {}): RsaRunView {
  return {
    project: 'ws-test', run: '2026-10-17T13-38-12.609Z', manifest: { workspace: '/workspace' }, selectedEpoch: 'epoch-a',
    calls: [{ inputObservations: ['model-input'], tools: [{ intent: '查看证据', at: '2026-10-17T13:39:01Z' }] }],
    observations: [{ id: 'model-input', mediaType: 'image/png' }, { id: 'newly-captured', mediaType: 'image/png' }],
    live: { runId: '2026-10-17T13-38-12.609Z', epoch: 'epoch-a', mode: 'auto', connected: true, reason: '' },
    livePhase: { label: '等待模型首事件' }, updatedAt: '2026-10-17T13:40:00Z', ...overrides,
  }
}
const blocks: LogBlock[] = [
  { id: 'thought', kind: 'thinking', at: '2026-10-17T13:40:00Z', title: 'Thinking', text: 'logged thinking block', status: 'complete' },
  { id: 'message', kind: 'text', at: '2026-10-17T13:40:01Z', title: 'Text', text: 'logged text block', status: 'complete' },
  { id: 'tool', kind: 'tool', at: '2026-10-17T13:40:02Z', title: 'Tool', text: 'logged tool block', status: 'running' },
]
const directories: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('RSA dashboard block source', () => {
  it('preserves all projected blocks and uses actual model input rather than the newest unconsumed capture', () => {
    const snapshot = projectRsaRun(run(), '/workspace', 'http://127.0.0.1:3015', blocks)
    expect(snapshot.current.observationUrl).toContain('id=model-input')
    expect(snapshot.current.intent).toBe('查看证据')
    expect(snapshot.current.phase).toBe('等待模型首事件')
    expect(snapshot.activity).toBe('running')
    expect(snapshot.blocks).toBe(blocks); expect(snapshot.current.blocks).toBe(blocks)
    expect(projectRsaRun(run({ calls: [{ inputObservations: [], tools: [] }] }), '/workspace', 'http://localhost:3015').current.observationUrl).toBeNull()
  })
  it('does not turn historical auto records or another epoch into live activity', () => {
    expect(projectRsaRun(run({ live: null }), '/workspace', 'http://localhost:3015')).toMatchObject({ activity: 'offline', current: { phase: 'Host 离线' } })
    const manual = run(); manual.live!.mode = 'manual'
    expect(projectRsaRun(manual, '/workspace', 'http://localhost:3015')).toMatchObject({ activity: 'manual', current: { phase: '已交还控制权' } })
    manual.live!.epoch = 'old-epoch'
    expect(projectRsaRun(manual, '/workspace', 'http://localhost:3015').activity).toBe('offline')
  })
  it('recognizes a connected manual host after it clears its epoch, while auto requires an epoch match', () => {
    const stopped = run()
    stopped.live = { ...stopped.live!, mode: 'manual', epoch: null, reason: 'time budget' }
    expect(projectRsaRun(stopped, '/workspace', 'http://localhost:3015')).toMatchObject({
      activity: 'manual', current: { phase: '已交还控制权', error: null, epoch: 'epoch-a' },
    })
    stopped.live.mode = 'auto'
    expect(projectRsaRun(stopped, '/workspace', 'http://localhost:3015').activity).toBe('offline')
    stopped.live.mode = 'manual'; stopped.live.runId = 'another-run'
    expect(projectRsaRun(stopped, '/workspace', 'http://localhost:3015').activity).toBe('offline')
  })
  it('describes a new manual host with no historical epoch as waiting for takeover', () => {
    const fresh = run({ selectedEpoch: null, calls: [] })
    fresh.live = { ...fresh.live!, mode: 'manual', epoch: null }
    expect(projectRsaRun(fresh, '/workspace', 'http://localhost:3015')).toMatchObject({
      activity: 'manual', current: { phase: '已连接，等待 AI 接管', epoch: null, error: null },
    })
  })
  it('canonicalizes workspace and fetches every activity block from the selected run and epoch', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rsa-pet-source-'))); directories.push(directory)
    const link = directory + '-link'; symlinkSync(directory, link); directories.push(link)
    const onSnapshot = vi.fn()
    const source = new RsaSource({ workspace: link, dashboardUrl: 'http://127.0.0.1:3015/', onSnapshot })
    const project = rsaProjectId(directory)
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([{ id: 'other', runs: [{ id: 'newest-other' }] }, { id: project, runs: [{ id: '2026-10-17T12-00-00.000Z' }, { id: '2026-10-17T13-38-12.609Z' }] }]))
      .mockResolvedValueOnce(Response.json(run({ manifest: { workspace: directory } })))
      .mockResolvedValueOnce(Response.json({ blocks }))
    vi.stubGlobal('fetch', fetch)
    const actual = await source.read()
    expect(fetch.mock.calls[1][0]).toContain(`project=${project}&run=2026-10-17T13-38-12.609Z`)
    expect(fetch.mock.calls[2][0]).toContain(`/api/activity?project=${project}&run=2026-10-17T13-38-12.609Z&epoch=epoch-a`)
    expect(actual.blocks).toEqual(blocks)
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ workspace: directory, blocks }))
    fetch.mockRejectedValueOnce(new Error('connection refused'))
    expect(await source.read()).toMatchObject({ activity: 'offline', blocks, current: { phase: '日志服务离线', intent: null, error: 'Error: connection refused', blocks } })
    source.stop()
  })
  it('does not publish stale data after cancellation or after the source stops', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rsa-pet-abort-')); directories.push(directory)
    const onSnapshot = vi.fn(), abort = new AbortController()
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://127.0.0.1:3015', onSnapshot })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { abort.abort(); throw new Error('aborted') }))
    await expect(source.read(abort.signal)).rejects.toThrow('aborted')
    expect(onSnapshot).not.toHaveBeenCalled()
    source.stop(); await expect(source.read()).rejects.toThrow()
    expect(onSnapshot).not.toHaveBeenCalled()
  })
  it('records changed consumption and failures once in a separate workspace journal', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rsa-pet-journal-'))); directories.push(directory)
    const projection = { source: { component: 'dashboard' }, throughSeq: 42, latestEventAt: run().updatedAt,
      latestSourceAt: run().updatedAt, generatedAt: run().updatedAt, durationMs: 2, blockCount: blocks.length }
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {},
      record: consumerRecorder(directory) })
    let fail = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (fail) throw new Error('connection refused')
      if (url.includes('/api/catalog')) return Response.json([{ id: rsaProjectId(directory), runs: [{ id: run().run }] }])
      if (url.includes('/api/run?')) return Response.json(run({ manifest: { workspace: directory } }))
      return Response.json({ blocks, projection })
    }))
    expect((await source.read()).projection).toEqual(projection)
    await source.read()
    fail = true; await source.read(); await source.read()
    const files = readdirSync(join(directory, 'logs', 'consumers'))
    expect(files).toHaveLength(1)
    const rows = readFileSync(join(directory, 'logs', 'consumers', files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.map(row => row.type)).toEqual(['read', 'read_error'])
    expect(rows[0]).toMatchObject({ schemaVersion: 2, source: { component: 'pet' }, runId: run().run,
      seq: 1, trace: { epoch: 'epoch-a' }, data: { projection: { throughSeq: 42 }, blocks: 3 } })
    expect(rows[0].origin.clockId).toBe(rows[1].origin.clockId)
    expect(rows[0].origin.eventId).not.toBe(rows[1].origin.eventId)
    expect(rows[1].data.error).toContain('connection refused')
    source.stop()
  })
})
