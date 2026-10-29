import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('companion', {
  onActivity: (callback: (input: unknown) => void) => {
    ipcRenderer.on('ludens:activity:display', (_event, input) => callback(input))
  },
  openActivity: (displayId: string) => ipcRenderer.invoke('ludens:activity:open', displayId),
  dismissActivity: (displayId: string) => ipcRenderer.invoke('ludens:activity:dismiss', displayId),
  getSound: () => ipcRenderer.invoke('ludens:companion:sound:get'),
  onSound: (callback: (settings: unknown) => void) => {
    ipcRenderer.on('ludens:companion:sound:changed', (_event, settings) => callback(settings))
  },
  interactive: (enabled: boolean) => ipcRenderer.send('ludens:companion:interactive', enabled),
  beginDrag: () => ipcRenderer.send('ludens:companion:begin-drag'),
  moveDrag: () => ipcRenderer.send('ludens:companion:move-drag'),
  endDrag: (cancelled = false) => ipcRenderer.invoke('ludens:companion:end-drag', cancelled),
  menu: () => ipcRenderer.send('ludens:companion:menu'),
  open: () => ipcRenderer.send('ludens:companion:open'),
  ready: () => ipcRenderer.send('ludens:companion:ready'),
  reducedMotion: (enabled: boolean) => ipcRenderer.send('ludens:companion:reduced-motion', enabled),
  onCursor: (callback: (point: { x: number; y: number }) => void) => {
    ipcRenderer.on('ludens:companion:cursor', (_event, point) => callback(point))
  },
  onPose: (callback: (selection: unknown) => void) => {
    ipcRenderer.on('ludens:companion:pose', (_event, selection) => callback(selection))
  },
  onFlip: (callback: (flipped: boolean) => void) => {
    ipcRenderer.on('ludens:companion:flip', (_event, flipped) => callback(flipped))
  },
})
