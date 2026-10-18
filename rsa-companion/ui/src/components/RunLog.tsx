import { useState } from 'react'
import type { LogBlock } from '../../../apps/desktop/src/rsa-source'
import type { BlockKind } from '../../../apps/desktop/src/activity-policy'
import { Button } from './ui/button'

const PAGE_SIZE = 50
const labels: Record<BlockKind, string> = {
  thinking: '思考', text: '文本', tool: '工具', system: '系统', diagnostic: '诊断',
}

export function RunLog({ blocks, visibility, pending, onDiagnosticChange }: {
  blocks: LogBlock[]
  visibility: Record<BlockKind, boolean>
  pending: boolean
  onDiagnosticChange(value: boolean): void
}) {
  const [page, setPage] = useState(0)
  const selected = blocks.filter(block => visibility[block.kind])
  const pageCount = Math.max(1, Math.ceil(selected.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const end = Math.max(0, selected.length - currentPage * PAGE_SIZE)
  const start = Math.max(0, end - PAGE_SIZE)
  return <section aria-labelledby="run-log-title" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="run-log-title" className="text-sm font-semibold">运行日志</h2>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="accent-primary" checked={visibility.diagnostic} disabled={pending}
          onChange={event => { setPage(0); onDiagnosticChange(event.currentTarget.checked) }} />
        显示诊断详情
      </label>
    </div>
    {selected.length === 0 ? <p className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">暂无可见日志。新的思考、文本和工具记录会显示在这里。</p>
      : <div className="space-y-2">
        {selected.slice(start, end).reverse().map(block => <details key={block.id} open={block.kind !== 'diagnostic'}
          data-log-block={block.id} className={`overflow-hidden rounded-lg border bg-card ${block.status === 'error' ? 'border-destructive/40' : 'border-border'}`}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm">
            <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{labels[block.kind]}</span>
            <span className="min-w-0 flex-1 break-words font-medium">{block.title}</span>
            <span className={`text-xs ${block.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{block.status === 'running' ? '进行中' : block.status === 'error' ? '失败' : '完成'}</span>
            <time dateTime={block.at} className="text-[11px] text-muted-foreground">{new Date(block.at).toLocaleTimeString()}</time>
          </summary>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border px-4 py-3 font-mono text-xs leading-5">{block.text || '等待内容…'}</pre>
        </details>)}
      </div>}
    {pageCount > 1 && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{start + 1}–{end} / {selected.length}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>更早记录</Button>
        <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>较新记录</Button>
        <Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(0)}>回到最新</Button>
      </div>
    </div>}
  </section>
}
