import { useEffect, useState } from 'react'
import { ActivityNotifications } from './components/ActivityNotifications'
import { Button } from './components/ui/button'
import { PetSettingsPage } from './pages/PetSettingsPage'
import { RunPage } from './pages/RunPage'

export function App() {
  const [page, setPage] = useState<'run' | 'settings'>('run')
  const [visible, setVisible] = useState<boolean | null>(null)
  const [visibilityError, setVisibilityError] = useState(false)
  const companion = window.openAlice?.companion
  useEffect(() => {
    if (!companion) return
    let active = true, changed = false
    const offVisibility = companion.onVisibility(value => { changed = true; if (active) setVisible(value) })
    const offOpen = companion.activity?.onOpen(() => setPage('run'))
    void companion.getVisible().then(value => { if (active && !changed) setVisible(value) })
      .catch(() => { if (active) setVisibilityError(true) })
    return () => { active = false; offVisibility(); offOpen?.() }
  }, [companion])
  const togglePet = async () => {
    setVisibilityError(false)
    try { if (companion) setVisible(await companion.toggle()) }
    catch { setVisibilityError(true) }
  }
  return <div className="app-shell">
    <nav className="app-sidebar" aria-label="主导航">
      <div className="app-brand">Alice Pet<span>RSA companion</span></div>
      <div className="space-y-1">
        <Button className="w-full justify-start" variant={page === 'run' ? 'secondary' : 'ghost'} aria-current={page === 'run' ? 'page' : undefined} onClick={() => setPage('run')}>运行</Button>
        <Button className="w-full justify-start" variant={page === 'settings' ? 'secondary' : 'ghost'} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>桌宠设置</Button>
      </div>
      <div className="mt-auto space-y-2 pt-6">
        {visibilityError && <p role="alert" className="text-xs text-destructive">无法切换桌宠，请重试。</p>}
        <Button className="w-full" variant="outline" disabled={visible === null} onClick={() => { void togglePet() }}>{visible ? '隐藏桌宠' : '显示桌宠'}</Button>
      </div>
    </nav>
    <main className="min-h-0 min-w-0 overflow-hidden">{page === 'run' ? <RunPage /> : <PetSettingsPage />}</main>
    <ActivityNotifications />
  </div>
}
