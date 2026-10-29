import { describe, expect, it } from 'vitest'
import { blockUrl, dashboardSender, isDashboardUrl } from './dashboard-window.js'

describe('shared Dashboard window', () => {
  const origin = 'http://127.0.0.1:3015'
  it('keeps native access on the exact configured main-frame origin', () => {
    const frame = { url: origin + '/?view=pet' }, contents = { mainFrame: frame }
    const owner = { isDestroyed: () => false, webContents: contents }
    const event = { sender: contents, senderFrame: frame }
    expect(dashboardSender(owner as never, origin, event as never)).toBe(true)
    expect(dashboardSender(owner as never, origin, { ...event, senderFrame: { ...frame } } as never)).toBe(false)
    frame.url = 'http://127.0.0.1:3016/'
    expect(dashboardSender(owner as never, origin, event as never)).toBe(false)
    for (const url of ['https://example.com', 'javascript:alert(1)', 'file:///tmp/a.html', 'http://user@127.0.0.1:3015/', 'http://localhost:3015/']) {
      expect(isDashboardUrl(url, origin)).toBe(false)
    }
    expect(isDashboardUrl(origin + '/?view=benchmark', origin)).toBe(true)
  })
  it('links the source run and epoch to the exact encoded activity block', () => {
    const url = new URL(blockUrl(origin + '/?project=ws-a&run=run-a&epoch=epoch-a', 'model:7/tool:abc|def'))
    expect(Object.fromEntries(url.searchParams)).toEqual({ project: 'ws-a', run: 'run-a', epoch: 'epoch-a', view: 'live', block: 'model:7/tool:abc|def' })
  })
})
