import { useEffect, useState } from 'react'

export function useRsaSnapshot() {
  const bridge = window.rsaPet
  const [snapshot, setSnapshot] = useState<RsaPetSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!bridge) return
    let active = true, changed = false
    const off = bridge.onSnapshot(value => {
      changed = true
      if (active) { setSnapshot(value); setError(null) }
    })
    void bridge.getSnapshot().then(value => {
      if (active && !changed) setSnapshot(value)
    }).catch(() => { if (active && !changed) setError('暂时无法读取运行状态。') })
    return () => { active = false; off() }
  }, [bridge])
  return { snapshot, error }
}
