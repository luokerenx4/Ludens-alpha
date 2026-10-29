'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityPreferences, DesktopCompanion, PetSoundSettings } from '../lib/desktop'
import { createDesktopResource, DesktopResourceCancelled, type DesktopResourceState } from './pet-resource'

function currentCompanion(): DesktopCompanion | null {
  try { return typeof window === 'undefined' ? null : window.ludens?.companion ?? null }
  catch { return null }
}

/** Bridge availability belongs to this window, not to the server's pet consumer. */
export function useDesktopCompanion() {
  const [bridge, setBridge] = useState<DesktopCompanion | null>(null)
  const [ready, setReady] = useState(false)
  const recheck = useCallback(() => { setBridge(currentCompanion()); setReady(true) }, [])
  useEffect(() => {
    recheck()
    const visible = () => { if (document.visibilityState === 'visible') recheck() }
    window.addEventListener('focus', recheck)
    window.addEventListener('pageshow', recheck)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', recheck)
      window.removeEventListener('pageshow', recheck)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [recheck])
  return { bridge, ready, recheck }
}

interface ResourceAdapter<T> {
  read(bridge: DesktopCompanion): Promise<T>
  subscribe(bridge: DesktopCompanion, callback: (value: T) => void): () => void
}
const soundAdapter: ResourceAdapter<PetSoundSettings> = {
  read: bridge => bridge.getSound(), subscribe: (bridge, callback) => bridge.onSound(callback),
}
const preferencesAdapter: ResourceAdapter<ActivityPreferences> = {
  read: bridge => bridge.activity.getPreferences(), subscribe: (bridge, callback) => bridge.activity.onPreferences(callback),
}
const visibilityAdapter: ResourceAdapter<boolean> = {
  read: bridge => bridge.getVisible(), subscribe: (bridge, callback) => bridge.onVisibility(callback),
}

function useDesktopResource<T>(bridge: DesktopCompanion | null, adapter: ResourceAdapter<T>) {
  const [state, setState] = useState<{ epoch: number; state: DesktopResourceState<T> } | null>(null)
  const identity = useRef({ bridge, epoch: 0 })
  if (identity.current.bridge !== bridge) identity.current = { bridge, epoch: identity.current.epoch + 1 }
  const epoch = identity.current.epoch
  const resource = useRef<{ epoch: number; value: ReturnType<typeof createDesktopResource<T>> } | null>(null)
  useEffect(() => {
    if (!bridge) return
    const value = createDesktopResource({
      read: () => adapter.read(bridge), subscribe: callback => adapter.subscribe(bridge, callback),
      isCurrent: () => identity.current.epoch === epoch && currentCompanion() === bridge,
      onChange: state => setState({ epoch, state }),
    })
    resource.current = { epoch, value }
    setState({ epoch, state: value.snapshot() })
    void value.retry()
    return () => { value.dispose(); if (resource.current?.value === value) resource.current = null }
  }, [bridge, adapter, epoch])
  const current = state?.epoch === epoch ? state.state : null
  const session = resource.current?.epoch === epoch ? resource.current.value : null
  const active = () => session?.current() ? session : null
  return {
    settings: current?.value ?? null,
    loading: !!bridge && (!current || current.loading),
    pending: current?.pending ?? false,
    readError: current?.readError ?? null,
    writeError: current?.writeError ?? null,
    retry: () => { void active()?.retry() },
    write: (action: (bridge: DesktopCompanion, stillCurrent: () => boolean) => Promise<T>) => {
      const value = active()
      return bridge && value ? value.write(stillCurrent => action(bridge, stillCurrent)) : Promise.resolve(false)
    },
    current: () => !!active(),
  }
}

export function usePetVisibility(bridge: DesktopCompanion | null) {
  const resource = useDesktopResource(bridge, visibilityAdapter)
  return { ...resource, toggle: () => resource.write(bridge => bridge.toggle()) }
}

export function useActivityPreferences(bridge: DesktopCompanion | null) {
  const resource = useDesktopResource(bridge, preferencesAdapter)
  return { ...resource,
    update: (patch: Partial<ActivityPreferences>) => resource.write(bridge => bridge.activity.updatePreferences(patch)),
    reset: () => resource.write(bridge => bridge.activity.resetPreferences()),
  }
}

/** Local validation precedes the only IPC write; disconnects invalidate every continuation. */
export function usePetSound(bridge: DesktopCompanion | null) {
  const resource = useDesktopResource(bridge, soundAdapter)
  const [previewError, setPreviewError] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null), previewId = useRef(0)
  useEffect(() => {
    previewId.current++; audio.current?.pause(); audio.current = null; setPreviewError(false)
    return () => { previewId.current++; audio.current?.pause(); audio.current = null }
  }, [bridge, resource.settings])
  const run = (action: (bridge: DesktopCompanion, stillCurrent: () => boolean) => Promise<PetSoundSettings>) => {
    previewId.current++; audio.current?.pause(); setPreviewError(false)
    return resource.write(action)
  }
  const update = (patch: Partial<PetSoundSettings>) => run(bridge => bridge.updateSound(patch))
  const importFile = (file: File) => run(async (bridge, stillCurrent) => {
    const mime = ({ wav: 'wav', mp3: 'mpeg', ogg: 'ogg' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() ?? '']
    if (!mime || file.size === 0 || file.size > 2 * 1024 * 1024 || file.name.length > 160) throw new Error('invalidFile')
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(`data:audio/${mime};base64,${String(reader.result).split(',')[1]}`)
      reader.onerror = reject; reader.readAsDataURL(file)
    })
    if (!stillCurrent()) throw new DesktopResourceCancelled()
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(await file.arrayBuffer())
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 10) throw new Error('invalidFile')
    } catch { throw new Error('invalidFile') }
    finally { await context.close() }
    if (!stillCurrent()) throw new DesktopResourceCancelled()
    return bridge.updateSound({ source: { name: file.name, dataUrl } })
  })
  const preview = async () => {
    if (!resource.current() || resource.pending || !resource.settings?.source) return
    previewId.current++; const id = previewId.current
    audio.current?.pause()
    const next = new Audio(resource.settings.source.dataUrl)
    next.volume = resource.settings.volume; audio.current = next; setPreviewError(false)
    try { await next.play() }
    catch { if (id === previewId.current && resource.current()) setPreviewError(true) }
    if (id !== previewId.current || !resource.current()) next.pause()
  }
  return { ...resource, previewError, update, importFile, preview, reset: () => run(bridge => bridge.resetSound()) }
}
