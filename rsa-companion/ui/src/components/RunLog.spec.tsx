// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunLog } from './RunLog'
import { DEFAULT_BLOCK_VISIBILITY } from '../../../apps/desktop/src/activity-policy'
import type { LogBlock } from '../../../apps/desktop/src/rsa-source'

afterEach(cleanup)
const block = (id: string, patch: Partial<LogBlock> = {}): LogBlock => ({
  id, kind: 'thinking', at: '2026-10-17T15:00:00Z', title: `Block ${id}`, text: `Content ${id}`, status: 'complete', ...patch,
})
const props = { visibility: DEFAULT_BLOCK_VISIBILITY, pending: false, onDiagnosticChange: vi.fn() }

describe('full run log', () => {
  it('updates a streamed block in place and displays text as text', () => {
    const { container, rerender } = render(<RunLog {...props} blocks={[block('same', { text: 'Thinking…', status: 'running' })]} />)
    const node = container.querySelector('[data-log-block="same"]')
    rerender(<RunLog {...props} blocks={[block('same', { text: '<img src=x onerror=alert(1)> completed', status: 'complete' })]} />)
    expect(container.querySelector('[data-log-block="same"]')).toBe(node)
    expect(container.querySelectorAll('[data-log-block]')).toHaveLength(1)
    expect(screen.getByText('<img src=x onerror=alert(1)> completed')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText('Thinking…')).toBeNull()
  })
  it('includes full tool arguments/results and only exposes diagnostics when enabled', () => {
    const toolText = 'Arguments:\n{"button":"A"}\nResult:\n' + 'full-result '.repeat(500)
    const blocks = [block('tool', { kind: 'tool', text: toolText }), block('debug', { kind: 'diagnostic', text: 'Request timings' })]
    const onDiagnosticChange = vi.fn()
    const { container, rerender } = render(<RunLog {...props} onDiagnosticChange={onDiagnosticChange} blocks={blocks} />)
    expect(container.querySelector('pre')?.textContent).toBe(toolText)
    expect(screen.queryByText('Request timings')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '显示诊断详情' }))
    expect(onDiagnosticChange).toHaveBeenCalledWith(true)
    rerender(<RunLog {...props} blocks={blocks} visibility={{ ...DEFAULT_BLOCK_VISIBILITY, diagnostic: true }} />)
    expect(screen.getByText('Request timings')).toBeTruthy()
    expect(container.querySelector('[data-log-block="debug"]')?.hasAttribute('open')).toBe(false)
  })
  it('renders a page of the newest blocks and can browse older records', () => {
    const blocks = Array.from({ length: 101 }, (_, index) => block(String(index)))
    const { container } = render(<RunLog {...props} blocks={blocks} />)
    expect(container.querySelectorAll('[data-log-block]')).toHaveLength(50)
    expect(screen.getByText('Block 100')).toBeTruthy()
    expect(screen.queryByText('Block 0')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更早记录' }))
    expect(screen.getByText('Block 1')).toBeTruthy()
    expect(screen.queryByText('Block 100')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更早记录' }))
    expect(container.querySelectorAll('[data-log-block]')).toHaveLength(1)
    expect(screen.getByText('Block 0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(screen.getByText('Block 100')).toBeTruthy()
  })
})
