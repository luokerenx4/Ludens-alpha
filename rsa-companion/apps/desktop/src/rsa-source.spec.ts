import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumerRecorder, rsaProjectId, RsaSource, type ActivityChanges } from './rsa-source.js'

const directories: string[] = []
function workspace() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rsa-pet-source-')))
  directories.push(directory)
  mkdirSync(join(directory, '.rsa'))
  writeFileSync(join(directory, '.rsa', 'workspace.json'), JSON.stringify({ version: 1, id: `ws-${randomUUID()}` }))
  return directory
}
function page(directory: string, overrides: Partial<ActivityChanges> = {}): ActivityChanges {
  return {
    scope: { project: rsaProjectId(directory), runId: 'run-a', epoch: 'epoch-a' }, mode: 'snapshot', cursor: 'opaque:42', hasMore: false,
    blocks: [{ id: 'tool', createdRevision: 10, revision: 42, kind: 'tool', at: '2026-10-17T13:40:00Z',
      title: 'Tool', text: 'streamed intent', status: 'running' }],
    projection: { source: { component: 'dashboard' }, throughSeq: 42, revision: 42, generation: 'generation-a',
      latestEventAt: '2026-10-17T13:40:00Z', latestSourceAt: '2026-10-17T13:40:00Z',
      generatedAt: '2026-10-17T13:40:00Z', durationMs: 2, blockCount: 1000 },
    current: { workspace: directory, runId: 'run-a', epoch: 'epoch-a', activity: 'running',
      phase: '等待模型首事件', intent: '查看证据', observationId: 'actual-model-input', updatedAt: '2026-10-17T13:40:00Z', error: null },
    ...overrides,
  }
}
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('RSA incremental activity source', () => {
  it('keeps the persisted workspace identity after relocation and rejects missing identity files', () => {
    const directory = workspace(), project = rsaProjectId(directory)
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {} })
    const relocated = directory + '-moved'; renameSync(directory, relocated); directories.push(relocated)
    expect(rsaProjectId(relocated)).toBe(project)
    const moved = new RsaSource({ workspace: relocated, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {} })
    expect(moved.identity()).toBe(source.identity())
    source.stop(); moved.stop()
    rmSync(join(relocated, '.rsa', 'workspace.json'))
    expect(() => rsaProjectId(relocated)).toThrow()
  })

  it('makes one changes request, publishes thin current state, and commits the cursor only after acceptance', async () => {
    const directory = workspace(), link = directory + '-link'; symlinkSync(directory, link); directories.push(link)
    const onSnapshot = vi.fn(), response = page(directory)
    const source = new RsaSource({ workspace: link, dashboardUrl: 'http://127.0.0.1:3015/', onSnapshot })
    const fetch = vi.fn().mockImplementation(async () => Response.json(response)); vi.stubGlobal('fetch', fetch)
    const first = await source.read()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/api/activity')
    expect(Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams)).toEqual({ project: rsaProjectId(directory), mode: 'changes' })
    expect(first).toMatchObject({ mode: 'snapshot', revision: 42, blocks: response.blocks })
    expect(first.current).toMatchObject({ workspace: directory, phase: '等待模型首事件', intent: '查看证据' })
    expect(first.current.observationUrl).toContain('id=actual-model-input')
    expect(onSnapshot).toHaveBeenLastCalledWith(first.current)
    expect(first.current).not.toHaveProperty('blocks')
    await source.read()
    expect(new URL(fetch.mock.calls[1][0]).searchParams.has('cursor')).toBe(false)
    first.acknowledge!()
    await source.read()
    expect(new URL(fetch.mock.calls[2][0]).searchParams.get('cursor')).toBe('opaque:42')
    fetch.mockRejectedValueOnce(new Error('connection refused'))
    expect(await source.read()).toMatchObject({ activity: 'offline', mode: 'delta', blocks: [], hasMore: false,
      current: { phase: '日志服务离线', error: 'Error: connection refused' } })
    source.stop()
  })

  it('passes delta pages and current state directly, including cursor reset after an index generation changes', async () => {
    const directory = workspace(), first = page(directory)
    const delta = page(directory, { mode: 'delta', cursor: 'opaque:43', hasMore: true,
      blocks: [{ ...first.blocks[0], revision: 43, text: 'complete text', status: 'complete' }],
      projection: { ...first.projection, revision: 43 },
      current: { ...first.current, activity: 'manual', phase: '已交还控制权', observationId: null } })
    const reset = page(directory, { projection: { ...first.projection, generation: 'generation-b' }, cursor: 'new:42' })
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(delta))
      .mockResolvedValueOnce(Response.json(reset)); vi.stubGlobal('fetch', fetch)
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {} })
    const initial = await source.read(); initial.acknowledge!()
    const changes = await source.read(); changes.acknowledge!()
    expect(changes).toMatchObject({ mode: 'delta', revision: 43, hasMore: true, blocks: delta.blocks, activity: 'manual' })
    expect(changes.current.observationUrl).toBeNull()
    const rebuilt = await source.read()
    expect(rebuilt.mode).toBe('snapshot'); expect(rebuilt.identity).not.toBe(initial.identity)
    expect(new URL(fetch.mock.calls[2][0]).searchParams.get('cursor')).toBe('opaque:43')
    source.stop()
  })

  it('accepts an empty workspace without requesting a catalog or full run', async () => {
    const directory = workspace(), empty = page(directory)
    empty.scope.runId = null; empty.scope.epoch = null; empty.blocks = []; empty.cursor = null
    empty.current = { ...empty.current, runId: null, epoch: null, activity: 'idle', phase: '工作区尚无运行记录', observationId: null }
    const fetch = vi.fn().mockResolvedValue(Response.json(empty)); vi.stubGlobal('fetch', fetch)
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {} })
    expect(await source.read()).toMatchObject({ activity: 'idle', blocks: [], current: { workspace: directory, runId: null } })
    expect(fetch).toHaveBeenCalledTimes(1); source.stop()
  })

  it('keeps runtime failures in blocks without treating a healthy log feed as a consumer error', async () => {
    const directory = workspace(), response = page(directory), onSnapshot = vi.fn()
    response.current = { ...response.current, activity: 'manual', phase: '已交还控制权', error: 'Invalid channel/value: A=true' }
    response.blocks = [{ ...response.blocks[0], status: 'error', text: response.current.error! }]
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(Response.json(response)))
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot })
    expect((await source.read()).current.error).toContain('connection refused')
    const recovered = await source.read()
    expect(recovered).toMatchObject({ activity: 'manual', blocks: response.blocks, current: { error: null } })
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ error: null, phase: '已交还控制权' }))
    source.stop()
  })

  it('does not publish stale data after cancellation or stop', async () => {
    const directory = workspace(), onSnapshot = vi.fn(), abort = new AbortController()
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: true, json: async () => {
      abort.abort(new Error('switched workspace')); return page(directory)
    } })))
    await expect(source.read(abort.signal)).rejects.toThrow('switched workspace')
    expect(onSnapshot).not.toHaveBeenCalled()
    source.stop(); await expect(source.read()).rejects.toThrow()
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('rejects data from a different workspace without advancing its cursor', async () => {
    const directory = workspace(), response = page(directory); response.current.workspace = '/another-workspace'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)))
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {} })
    const result = await source.read()
    expect(result).toMatchObject({ activity: 'offline', blocks: [] })
    expect(result.current.error).toContain('当前工作区'); expect(result.acknowledge).toBeUndefined(); source.stop()
  })

  it('records cursor progress and failures once without a block-history fingerprint', async () => {
    const directory = workspace(), response = page(directory)
    const source = new RsaSource({ workspace: directory, dashboardUrl: 'http://localhost:3015', onSnapshot: () => {}, record: consumerRecorder(directory) })
    let fail = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('connection refused')
      return Response.json(response)
    }))
    await source.read(); await source.read()
    fail = true; await source.read(); await source.read()
    const files = readdirSync(join(directory, 'logs', 'consumers'))
    expect(files).toHaveLength(1)
    const rows = readFileSync(join(directory, 'logs', 'consumers', files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.map(row => row.type)).toEqual(['read', 'read_error'])
    expect(rows[0]).toMatchObject({ source: { component: 'pet' }, runId: 'run-a', seq: 1, trace: { epoch: 'epoch-a' },
      data: { projection: { throughSeq: 42, revision: 42 }, revision: 42, blocks: 1 } })
    expect(rows[0].origin.clockId).toBe(rows[1].origin.clockId)
    expect(rows[1].data.error).toContain('connection refused'); source.stop()
  })
})
