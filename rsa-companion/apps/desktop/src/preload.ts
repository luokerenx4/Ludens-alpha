import { contextBridge, ipcRenderer } from 'electron'

function on(channel: string, callback: (value: any) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The original Pet settings contract; no Guardian or general filesystem bridge.
contextBridge.exposeInMainWorld('openAlice', {
  companion: {
    getSound: () => ipcRenderer.invoke('openalice:companion:sound:get'),
    updateSound: (value: unknown) => ipcRenderer.invoke('openalice:companion:sound:update', value),
    resetSound: () => ipcRenderer.invoke('openalice:companion:sound:reset'),
    onSound: (callback: (value: unknown) => void) => on('openalice:companion:sound:changed', callback),
    getVisible: () => ipcRenderer.invoke('openalice:companion:get-visible'),
    toggle: () => ipcRenderer.invoke('openalice:companion:toggle'),
    onVisibility: (callback: (value: boolean) => void) => on('openalice:companion:visibility', callback),
    activity: {
      getSignals: () => ipcRenderer.invoke('openalice:activity:signals'),
      onSignals: (callback: (value: unknown) => void) => on('openalice:activity:signals', callback),
      getPreferences: () => ipcRenderer.invoke('openalice:activity:preferences'),
      updatePreferences: (value: unknown) => ipcRenderer.invoke('openalice:activity:update-preferences', value),
      resetPreferences: () => ipcRenderer.invoke('openalice:activity:reset-preferences'),
      onPreferences: (callback: (value: unknown) => void) => on('openalice:activity:preferences-changed', callback),
      open: (displayId: string) => ipcRenderer.invoke('openalice:activity:open', displayId),
      dismiss: (displayId: string) => ipcRenderer.invoke('openalice:activity:dismiss', displayId),
      onOpen: (callback: (value: string) => void) => on('openalice:activity:open', callback),
      onDisplay: (callback: (value: any) => void) => {
        let active = true
        const changed = new Set<string>()
        const unsubscribe = on('openalice:activity:display', value => { changed.add(value.displayId); callback(value) })
        void ipcRenderer.invoke('openalice:activity:snapshot').then(events => {
          if (active) for (const event of events) if (!changed.has(event.displayId)) callback(event)
        }).catch(() => {})
        return () => { active = false; unsubscribe() }
      },
    },
  },
})
contextBridge.exposeInMainWorld('rsaPet', {
  getSnapshot: () => ipcRenderer.invoke('rsa-pet:snapshot'),
  onSnapshot: (callback: (value: unknown) => void) => on('rsa-pet:snapshot', callback),
  openDashboard: () => ipcRenderer.invoke('rsa-pet:open-dashboard'),
})
