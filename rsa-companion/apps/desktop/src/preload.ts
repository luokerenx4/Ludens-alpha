import { contextBridge, ipcRenderer } from 'electron'

function on(channel: string, callback: (value: any) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The original Pet settings contract; no Guardian or general filesystem bridge.
contextBridge.exposeInMainWorld('ludens', {
  companion: {
    getSound: () => ipcRenderer.invoke('ludens:companion:sound:get'),
    updateSound: (value: unknown) => ipcRenderer.invoke('ludens:companion:sound:update', value),
    resetSound: () => ipcRenderer.invoke('ludens:companion:sound:reset'),
    onSound: (callback: (value: unknown) => void) => on('ludens:companion:sound:changed', callback),
    getVisible: () => ipcRenderer.invoke('ludens:companion:get-visible'),
    toggle: () => ipcRenderer.invoke('ludens:companion:toggle'),
    onVisibility: (callback: (value: boolean) => void) => on('ludens:companion:visibility', callback),
    activity: {
      getPreferences: () => ipcRenderer.invoke('ludens:activity:preferences'),
      updatePreferences: (value: unknown) => ipcRenderer.invoke('ludens:activity:update-preferences', value),
      resetPreferences: () => ipcRenderer.invoke('ludens:activity:reset-preferences'),
      onPreferences: (callback: (value: unknown) => void) => on('ludens:activity:preferences-changed', callback),
      open: (displayId: string) => ipcRenderer.invoke('ludens:activity:open', displayId),
      dismiss: (displayId: string) => ipcRenderer.invoke('ludens:activity:dismiss', displayId),
      onOpen: (callback: (value: string) => void) => on('ludens:activity:open', callback),
      onDisplay: (callback: (value: any) => void) => {
        let active = true
        const changed = new Set<string>()
        const unsubscribe = on('ludens:activity:display', value => { changed.add(value.displayId); callback(value) })
        void ipcRenderer.invoke('ludens:activity:snapshot').then(events => {
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
