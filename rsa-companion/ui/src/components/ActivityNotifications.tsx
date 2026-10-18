import { useEffect, useState } from 'react'
import type { SerializedNotification } from '../../../apps/desktop/src/activity-policy'
import { NotificationCard } from './ui/notification-card'

export function ActivityNotifications() {
  const bridge = window.openAlice?.companion?.activity
  const [messages, setMessages] = useState<Map<string, SerializedNotification>>(() => new Map())
  useEffect(() => {
    if (!bridge) return
    return bridge.onDisplay(event => {
      setMessages(previous => {
        const next = new Map(previous)
        if (event.type === 'hide') next.delete(event.displayId)
        else next.set(event.displayId, event.input)
        return next
      })
    })
  }, [bridge])
  return <aside className="activity-notifications" aria-label="活动通知" aria-live="polite">
    {[...messages].map(([id, input]) => <NotificationCard key={id}
      content={{ ...input, action: { label: '查看运行', onClick: () => { void bridge?.open(id) } } }}
      onClose={() => { void bridge?.dismiss(id) }} />)}
  </aside>
}
