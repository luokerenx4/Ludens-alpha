// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityDisplay } from '../../../apps/desktop/src/activity-controller'
import '../i18n'
import { ActivityNotifications } from './ActivityNotifications'

afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'openAlice') })

describe('main window activity notifications', () => {
  it('renders native announcements and sends Open/Dismiss back through the existing bridge', async () => {
    let publish!: (event: ActivityDisplay) => void
    const open = vi.fn(async () => true), dismiss = vi.fn(async () => true), off = vi.fn()
    Object.defineProperty(window, 'openAlice', { configurable: true, value: { companion: { activity: {
      onDisplay: (callback: typeof publish) => { publish = callback; return off }, open, dismiss,
    } } } })
    const { unmount } = render(<ActivityNotifications />)
    await act(() => publish({ type: 'show', displayId: 'run:1', input: {
      title: 'Run complete', description: 'Budget reached', status: 'success', duration: 6000, context: 'office',
    } }))
    expect(screen.getByText('Run complete')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看运行' }))
    expect(open).toHaveBeenCalledWith('run:1')
    expect(dismiss).toHaveBeenCalledWith('run:1')
    await act(() => publish({ type: 'hide', displayId: 'run:1' }))
    expect(screen.queryByText('Run complete')).toBeNull()
    unmount()
    expect(off).toHaveBeenCalledOnce()
  })
})
