import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetSessionCoordinator, type PetTarget } from './pet-session.js'
import { RsaActivityController } from './rsa-activity-controller.js'
import { DEFAULT_ACTIVITY_PREFERENCES } from './activity-policy.js'
import type { RsaActivitySnapshot, RsaPetSnapshot } from './rsa-source.js'

function target(name: string): PetTarget {
  return { project: `ws-${name}`, workspace: `/${name}`, revision: name, updatedAt: '2026-10-20T00:00:00Z' }
}
function snapshot(name: string): RsaActivitySnapshot {
  const blocks = [{ id: name, kind: 'text' as const, title: name, text: name, status: 'running' as const, at: '', createdRevision: 1, revision: 1 }]
  return { identity: `${name}:run:epoch`, activity: 'running', blocks, mode: 'delta', revision: 1, hasMore: false, current: {
    workspace: `/${name}`, runId: `run-${name}`, epoch: 'epoch', phase: name,
    intent: null, observationUrl: null, updatedAt: null, error: null, dashboardUrl: 'http://localhost:3015',
  } }
}
const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('shared Pet follow target', () => {
  it('can stay open without a workspace, reports idle, and recovers from a missing dashboard', async () => {
    const posts: any[] = [], createSource = vi.fn(), onSnapshot = vi.fn()
    let offline = true
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (offline) throw new Error('offline')
      if (init.method === 'POST') posts.push(JSON.parse(init.body as string))
      expect(init.headers).toMatchObject({ Origin: 'http://localhost:3015' })
      return Response.json({ target: null })
    }))
    const session = new PetSessionCoordinator({ dashboardUrl: 'http://localhost:3015', createSource, onSnapshot, onTargetChanged: () => {} })
    await session.pollTarget()
    expect((await session.read()).current.error).toContain('offline')
    offline = false
    await session.pollTarget(); await session.heartbeat()
    expect(await session.read()).toMatchObject({ activity: 'idle', blocks: [], current: { workspace: null, runId: null, error: null } })
    expect(createSource).not.toHaveBeenCalled()
    expect(posts.at(-1)).toMatchObject({ pid: process.pid, revision: null, targetRevision: null, workspace: null, runId: null, phase: 'idle', error: null })
    session.stop()
  })

  it('switches immediately during an old read, clears its bubble, and rejects late old callbacks and results', async () => {
    let selected: PetTarget | null = target('a')
    const posts: any[] = [], stops: string[] = [], publications: RsaPetSnapshot[] = []
    const callbacks = new Map<string, (snapshot: RsaPetSnapshot) => void>()
    const pending = new Map<string, (snapshot: RsaActivitySnapshot) => void>()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') posts.push(JSON.parse(init.body as string))
      return Response.json({ target: selected })
    }))
    const sent: any[] = []
    let controller!: RsaActivityController
    const session = new PetSessionCoordinator({
      dashboardUrl: 'http://localhost:3015', onSnapshot: value => publications.push(value),
      onTargetChanged: () => { void controller.poll() },
      createSource: (workspace, onSnapshot) => {
        callbacks.set(workspace, onSnapshot)
        return { identity: () => workspace, stop: () => { stops.push(workspace) },
          read: () => new Promise(resolve => { pending.set(workspace, resolve) }) }
      },
    })
    controller = new RsaActivityController(session, { petVisible: () => true, foreground: () => false,
      send: (_surface, event) => sent.push(event), open: () => {} }, structuredClone(DEFAULT_ACTIVITY_PREFERENCES))
    await session.pollTarget()
    callbacks.get('/a')!(snapshot('a').current)
    pending.get('/a')!(snapshot('a'))
    await Promise.resolve(); await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ type: 'show', input: { id: 'a' } })
    const oldRead = controller.poll()
    selected = target('b')
    await session.pollTarget()
    expect(stops).toEqual(['/a'])
    expect(sent.at(-1)).toMatchObject({ type: 'hide' })
    expect(pending.has('/b')).toBe(true)
    const afterSwitch = publications.length
    callbacks.get('/a')!(snapshot('old-late').current)
    pending.get('/a')!(snapshot('old-late'))
    await oldRead
    expect(publications).toHaveLength(afterSwitch)
    callbacks.get('/b')!(snapshot('b').current)
    pending.get('/b')!(snapshot('b'))
    await Promise.resolve(); await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ type: 'show', input: { id: 'b' } })
    await session.heartbeat()
    expect(posts.at(-1)).toMatchObject({ pid: process.pid, revision: 'b', targetRevision: 'b', workspace: '/b', runId: 'run-b', phase: 'following' })
    selected = null
    await session.pollTarget()
    expect(sent.at(-1)).toMatchObject({ type: 'hide' })
    expect((await session.read()).current.workspace).toBeNull()
    controller.stop()
  })

  it('uses an explicit launch workspace only as ifUnset initialization and keeps target polling independent of reads', async () => {
    vi.useFakeTimers()
    const workspace = mkdtempSync(join(tmpdir(), 'rsa-pet-launch-')), project = `ws-${randomUUID()}`
    directories.push(workspace); mkdirSync(join(workspace, '.rsa'))
    writeFileSync(join(workspace, '.rsa', 'workspace.json'), JSON.stringify({ version: 1, id: project }))
    let selected = target('saved')
    const calls: { method: string; body: any }[] = [], changed = vi.fn()
    const snapshots: RsaPetSnapshot[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ method: init.method!, body: init.body ? JSON.parse(init.body as string) : null })
      if (init.method === 'PUT') return Response.json({ target: selected })
      if (init.method === 'POST') return Response.json({ consumer: JSON.parse(init.body as string) })
      return Response.json({ target: selected, consumer: null, connected: null, consumerError: 'Unreadable heartbeat' })
    }))
    const session = new PetSessionCoordinator({
      dashboardUrl: 'http://localhost:3015', onSnapshot: value => snapshots.push(value), onTargetChanged: changed,
      createSource: workspace => ({ identity: () => workspace, read: () => new Promise(() => {}) }),
    })
    await session.start(workspace)
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { ifUnset: true } })
    expect((calls[0].body as any).project).toBe(project)
    expect(snapshots.at(-1)?.workspace).toBe('/saved')
    void session.read()
    selected = target('next')
    await vi.advanceTimersByTimeAsync(2_500)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1)
    session.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('attributes a failed source attempt to its selection without claiming that revision loaded', async () => {
    let selected = target('a')
    const posts: any[] = [], publications: RsaPetSnapshot[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        const consumer = JSON.parse(init.body as string)
        posts.push(consumer)
        return Response.json({ consumer })
      }
      return Response.json({ target: selected, consumer: null, connected: false })
    }))
    const session = new PetSessionCoordinator({ dashboardUrl: 'http://localhost:3015',
      onSnapshot: snapshot => publications.push(snapshot), onTargetChanged: () => {},
      createSource: () => { throw new Error('Cannot open workspace') },
    })
    try {
      await session.pollTarget(); await session.heartbeat()
      expect(posts.at(-1)).toMatchObject({ workspace: '/a', revision: null, targetRevision: 'a', phase: 'error',
        error: 'Error: Cannot open workspace' })
      selected = { ...selected, revision: 'a-next' }
      await session.pollTarget(); await session.heartbeat()
      expect(posts.at(-1)).toMatchObject({ workspace: '/a', revision: null, targetRevision: 'a-next', phase: 'error' })
      expect(publications.at(-1)?.error).toContain('Cannot open workspace')
    } finally { session.stop() }
  })

  it('does not consume an unavailable saved target, stops an existing source, and resumes only after a valid read', async () => {
    const selected = target('saved'), calls: string[] = [], stop = vi.fn()
    let unavailable = true
    const createSource = vi.fn(() => ({ identity: () => '/saved', read: async () => snapshot('saved'), stop }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.method!)
      if (init.method === 'POST') return Response.json({ consumer: JSON.parse(init.body as string) })
      return Response.json({ target: selected, targetUnavailable: unavailable, consumer: null, connected: false })
    }))
    const session = new PetSessionCoordinator({ dashboardUrl: 'http://localhost:3015', createSource,
      onSnapshot: () => {}, onTargetChanged: () => {},
    })
    try {
      await session.pollTarget()
      expect(createSource).not.toHaveBeenCalled()
      expect((await session.read()).current.workspace).toBeNull()
      unavailable = false; await session.pollTarget()
      expect(createSource).toHaveBeenCalledTimes(1)
      expect(createSource).toHaveBeenCalledWith('/saved', expect.any(Function))
      unavailable = true; await session.pollTarget()
      expect(stop).toHaveBeenCalledTimes(1)
      expect((await session.read()).current.workspace).toBeNull()
      unavailable = false; await session.pollTarget()
      expect(createSource).toHaveBeenCalledTimes(2)
      expect(calls).not.toContain('PUT')
    } finally { session.stop() }
  })
})
