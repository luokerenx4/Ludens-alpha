import type { ReactNode } from 'react'

// OpenAlice's top-bar geometry, without its workspace routing and takeover UI.
export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return <header className="oa-topbar">
    <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">{title}</h1>
    {right && <div className="flex items-center gap-2">{right}</div>}
  </header>
}
