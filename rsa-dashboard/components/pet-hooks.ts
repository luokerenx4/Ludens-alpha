'use client'

import { useEffect, useRef, useState } from 'react'
import type { ActivityPreferences, DesktopCompanion, PetSoundSettings } from '../lib/desktop'

export function useDesktopCompanion() {
  const [bridge, setBridge] = useState<DesktopCompanion | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => { setBridge(window.ludens?.companion ?? null); setReady(true) }, [])
  return { bridge, ready }
}

/** Preserves Pet's local audio validation, persistence and preview behavior. */
export function usePetSound(bridge: DesktopCompanion | null) {
  const [settings, setSettings] = useState<PetSoundSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false), audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    if (!bridge) return
    let active = true, notified = false
    setLoading(true)
    const unsubscribe = bridge.onSound(value => {
      notified = true; audio.current?.pause()
      if (active) setSettings(value)
    })
    void bridge.getSound().then(value => { if (active && !notified) setSettings(value) })
      .catch(() => { if (active) setError('无法读取声音设置，请重试。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; unsubscribe(); audio.current?.pause() }
  }, [bridge])
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true; setPending(true); setError(null); audio.current?.pause()
    try { await action() } catch (e) {
      setError(e instanceof Error && e.message === 'invalidFile'
        ? '请选择不超过 2 MB、10 秒的 WAV、MP3 或 OGG 音频。' : '无法保存声音设置，请重试。')
    } finally { busy.current = false; setPending(false) }
  }
  const update = (patch: Partial<PetSoundSettings>) => run(async () => {
    if (bridge) setSettings(await bridge.updateSound(patch))
  })
  const importFile = (file: File) => run(async () => {
    if (!bridge) return
    const mime = ({ wav: 'wav', mp3: 'mpeg', ogg: 'ogg' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() ?? '']
    if (!mime || file.size === 0 || file.size > 2 * 1024 * 1024 || file.name.length > 160) throw new Error('invalidFile')
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(`data:audio/${mime};base64,${String(reader.result).split(',')[1]}`)
      reader.onerror = reject; reader.readAsDataURL(file)
    })
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(await file.arrayBuffer())
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 10) throw new Error('invalidFile')
    } catch { throw new Error('invalidFile') }
    finally { await context.close() }
    setSettings(await bridge.updateSound({ source: { name: file.name, dataUrl } }))
  })
  const preview = async () => {
    if (!settings?.source) return
    audio.current?.pause()
    const next = new Audio(settings.source.dataUrl)
    next.volume = settings.volume; audio.current = next; setError(null)
    try { await next.play() } catch { setError('无法播放这段音频。') }
  }
  const reset = () => run(async () => { if (bridge) setSettings(await bridge.resetSound()) })
  return { settings, loading, pending, error, update, importFile, preview, reset }
}

export function useActivityPreferences(bridge: DesktopCompanion | null) {
  const [settings, setSettings] = useState<ActivityPreferences | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    if (!bridge) return
    let active = true, changed = false
    setLoading(true)
    const off = bridge.activity.onPreferences(value => { changed = true; if (active) setSettings(value) })
    void bridge.activity.getPreferences().then(value => { if (active && !changed) setSettings(value) })
      .catch(() => { if (active) setError(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; off() }
  }, [bridge])
  const run = async (action: () => Promise<ActivityPreferences>) => {
    if (busy.current) return
    busy.current = true; setPending(true); setError(false)
    try { setSettings(await action()) } catch { setError(true) }
    finally { busy.current = false; setPending(false) }
  }
  return { settings, loading, pending, error,
    update: (patch: Partial<ActivityPreferences>) => bridge && run(() => bridge.activity.updatePreferences(patch)),
    reset: () => bridge && run(() => bridge.activity.resetPreferences()),
  }
}
