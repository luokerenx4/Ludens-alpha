import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

/** Only the configured local application may use the owner's native bridge. */
export function isDashboardUrl(input: string, origin: string): boolean {
  try {
    const url = new URL(input)
    return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password
  } catch { return false }
}

export function dashboardSender(owner: BrowserWindow, origin: string, event: IpcMainInvokeEvent): boolean {
  return !owner.isDestroyed() && event.sender === owner.webContents
    && event.senderFrame === owner.webContents.mainFrame && isDashboardUrl(event.senderFrame.url, origin)
}

export function blockUrl(dashboardUrl: string, blockId: string): string {
  const url = new URL(dashboardUrl)
  url.searchParams.set('view', 'live')
  url.searchParams.set('block', blockId)
  return url.href
}
