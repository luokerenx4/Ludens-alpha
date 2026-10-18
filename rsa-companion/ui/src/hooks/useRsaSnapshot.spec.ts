// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRsaSnapshot } from './useRsaSnapshot'

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'rsaPet') })
const snapshot: RsaPetSnapshot = {
  workspace: '/workspace/a', runId: 'run-a', epoch: 'epoch-a', phase: 'stream', intent: 'Read dialogue',
  observationUrl: 'data:image/png;base64,abc', updatedAt: '2026-10-17T14:00:00Z', error: null, dashboardUrl: 'http://127.0.0.1:3015/',
}

describe('RSA snapshot subscription', () => {
  it('keeps live updates ahead of a late initial snapshot and cleans up the subscription', async () => {
    let resolveInitial!: (value: RsaPetSnapshot) => void
    let publish!: (value: RsaPetSnapshot) => void
    const off = vi.fn()
    Object.defineProperty(window, 'rsaPet', { configurable: true, value: {
      getSnapshot: () => new Promise<RsaPetSnapshot>(resolve => { resolveInitial = resolve }),
      onSnapshot: (callback: typeof publish) => { publish = callback; return off },
    } })
    const { result, unmount } = renderHook(useRsaSnapshot)
    await act(() => publish({ ...snapshot, phase: 'command' }))
    await act(() => resolveInitial(snapshot))
    expect(result.current.snapshot?.phase).toBe('command')
    unmount()
    expect(off).toHaveBeenCalledOnce()
  })

  it('clears a connection error when a later snapshot arrives', async () => {
    let publish!: (value: RsaPetSnapshot) => void
    Object.defineProperty(window, 'rsaPet', { configurable: true, value: {
      getSnapshot: async () => { throw new Error('offline') },
      onSnapshot: (callback: typeof publish) => { publish = callback; return () => {} },
    } })
    const { result } = renderHook(useRsaSnapshot)
    await waitFor(() => expect(result.current.error).not.toBeNull())
    await act(() => publish(snapshot))
    expect(result.current.error).toBeNull()
    expect(result.current.snapshot?.workspace).toBe('/workspace/a')
  })
})
