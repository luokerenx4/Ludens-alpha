import { useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { SettingsScrollArea } from '../components/form'
import { Button } from '../components/ui/button'
import { useRsaSnapshot } from '../hooks/useRsaSnapshot'
import { useActivityPreferences } from '../hooks/useActivityPreferences'
import { DEFAULT_BLOCK_VISIBILITY } from '../../../apps/desktop/src/activity-policy'
import { RunLog } from '../components/RunLog'

const phaseLabels: Record<string, string> = {
  idle: '等待下一轮', prepare: '准备请求', headers: '等待响应', firststream: '等待首段内容',
  'ws-firstevent': '等待首个事件', stream: '接收模型输出', command: '执行操作', tool: '使用工具',
  capture: '采集画面', observation: '读取画面', compaction: '整理上下文', stopped: '本轮已停止',
  disconnected: '未连接', error: '运行异常',
}

export function RunPage() {
  const { snapshot, error } = useRsaSnapshot()
  const preferences = useActivityPreferences()
  const visibility = preferences.settings?.blocks ?? DEFAULT_BLOCK_VISIBILITY
  const [openError, setOpenError] = useState<string | null>(null)
  const [failedImage, setFailedImage] = useState<string | null>(null)
  const image = snapshot?.observationUrl
  const openDashboard = async () => {
    setOpenError(null)
    try { await window.rsaPet?.openDashboard() }
    catch { setOpenError('无法打开日志页面，请检查日志前端是否正在运行。') }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader title="运行" right={<Button variant="outline" disabled={!window.rsaPet} onClick={() => { void openDashboard() }}>打开日志</Button>} />
    <SettingsScrollArea className="p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
          <div>
            <p className="text-base font-semibold" role="status">{snapshot ? (phaseLabels[snapshot.phase] ?? snapshot.phase) : '等待运行状态'}</p>
            <p className="mt-1 text-sm text-muted-foreground">最近操作意图：{snapshot?.intent ?? '暂无记录'}</p>
          </div>
        </div>
        {(error || snapshot?.error || openError) && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error ?? snapshot?.error ?? openError}</p>}
        <RunLog key={`${snapshot?.runId ?? ''}:${snapshot?.epoch ?? ''}`} blocks={snapshot?.blocks ?? []}
          visibility={visibility} pending={preferences.pending}
          onDiagnosticChange={diagnostic => { void preferences.update({ blocks: { ...visibility, diagnostic } }) }} />
        {preferences.error && <p role="alert" className="text-xs text-destructive">无法加载或保存内容偏好，请重试。</p>}
        <figure className="overflow-hidden rounded-lg border border-border bg-card">
          <figcaption className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <span className="text-sm font-medium">最后一次模型输入</span>
            {snapshot?.updatedAt && <time className="text-xs text-muted-foreground" dateTime={snapshot.updatedAt}>状态刷新 {new Date(snapshot.updatedAt).toLocaleTimeString()}</time>}
          </figcaption>
          {image && image !== failedImage
            ? <img key={image} src={image} onError={() => setFailedImage(image)} alt="最近一次模型请求实际带入的游戏画面" className="block max-h-[55vh] min-h-40 w-full bg-[#111318] object-contain" />
            : <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-muted-foreground">{image ? '这张画面暂时无法读取。' : '有新的模型观测后，画面会显示在这里。'}</div>}
        </figure>
        {snapshot?.error && image && <p className="text-xs text-muted-foreground">连接已中断，保留上次记录的模型输入画面。</p>}
        <dl className="run-identifiers text-xs">
          <dt>Workspace</dt><dd>{snapshot?.workspace ?? '尚未选择'}</dd>
          <dt>Run</dt><dd>{snapshot?.runId ?? '—'}</dd>
          <dt>Epoch</dt><dd>{snapshot?.epoch ?? '—'}</dd>
        </dl>
      </div>
    </SettingsScrollArea>
  </div>
}
