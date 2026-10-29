/** Isolated native companion acceptance; no Guardian, credentials, or broker. */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createCompanion, resizeCompanionWindow, setCompanionBounds } from './companion.js'
import type { LogBlock } from './rsa-source.js'

const home = mkdtempSync(join(tmpdir(), 'ludens-companion-'))
app.setPath('userData', home)
app.on('window-all-closed', () => app.quit())
void app.whenReady().then(async () => {
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 })
  const companion = createCompanion(owner)!
  const pet = companion.window
  pet.webContents.on('preload-error', (_event, path, error) => console.error(path, error))
  pet.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message) })
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Companion did not become visible')), 15000)
    pet.once('show', () => { clearTimeout(timeout); done() })
  })
  console.log(`[companion-preview] ready; isolated profile: ${home}`)
  if (!process.argv.includes('--smoke')) return
  const info = await pet.webContents.executeJavaScript(`({bridge: !!window.companion, node: typeof require, alpha: alpha.data[3], width: alpha.width, transition: getComputedStyle(body).transition, origin: getComputedStyle(body).transformOrigin})`)
  assert.equal(info.bridge, true)
  assert.equal(info.node, 'undefined')
  assert.equal(info.alpha, 0)
  assert.equal(info.width, 512)
  // Decode every shipped raster and switch every pose through the real renderer.
  const assets = await pet.webContents.executeJavaScript(`(async () => {
    for (const asset of ludensCatalog.assets) {
      const image = new Image(); image.src = 'ludens/' + asset.file; await image.decode();
      if (image.naturalWidth !== 512 || image.naturalHeight !== 512) throw new Error(asset.id + ': wrong dimensions');
      if (asset.kind === 'state') {
        await showPose({state:asset.id,effect:null});
        if (document.querySelector('#pet').dataset.state !== asset.id) throw new Error(asset.id + ': not displayed');
        const rect = portrait.getBoundingClientRect(), bounds = asset.bounds_px;
        if (rect.left + bounds[0] / asset.width * rect.width < 0 ||
            rect.right - (asset.width - bounds[2]) / asset.width * rect.width > innerWidth ||
            rect.top + bounds[1] / asset.height * rect.height < 0 ||
            rect.bottom - (asset.height - bounds[3]) / asset.height * rect.height > innerHeight)
          throw new Error(asset.id + ': calibrated artwork clipped');
      }
    }
    await showPose({state:'01-idle',effect:null});
    return ludensCatalog.assets.length;
  })()`)
  assert.equal(assets, 36)

  const bubbleAlpha = await pet.webContents.executeJavaScript(`(() => {
    const img = document.querySelector('#bubble img');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    return [ctx.getImageData(0, 0, 1, 1).data[3],
      ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3]];
  })()`)
  assert.equal(bubbleAlpha[0], 0, 'Speech bubble exterior must be transparent')
  assert.ok(bubbleAlpha[1] >= 250, 'Speech bubble interior must be effectively opaque')
  assert.equal(pet.isAlwaysOnTop(), true)
  // Repeated native writes must keep the renderer size stable on fractional DPI.
  const contentBounds = () => process.platform === 'win32' ? pet.getContentBounds() : pet.getBounds()
  const initialBounds = contentBounds()
  for (let i = 0; i < 200; i++) {
    setCompanionBounds(pet, { ...initialBounds, x: initialBounds.x + i % 3, y: initialBounds.y + i % 3 })
    const actual = contentBounds()
    assert.equal(actual.width, initialBounds.width, `Companion width drifted after move ${i + 1}`)
    assert.equal(actual.height, initialBounds.height, `Companion height drifted after move ${i + 1}`)
  }
  setCompanionBounds(pet, initialBounds)
  pet.focus()
  await new Promise(done => setTimeout(done, 150))
  await pet.webContents.executeJavaScript(`window.smokeEvents=[]; for(const name of ['pointerdown','pointerup','pointercancel','lostpointercapture','blur']) window.addEventListener(name, e => window.smokeEvents.push([name,e.clientX,e.clientY]),true)`)
  const box = await pet.webContents.executeJavaScript(`(() => { const r=portrait.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height*.6)} })()`)
  pet.webContents.sendInputEvent({ type: 'mouseDown', ...box, button: 'left', clickCount: 1 })
  await new Promise(done => setTimeout(done, 280))
  assert.equal(await pet.webContents.executeJavaScript(`body.classList.contains('pressed')`), true)
  writeFileSync(join(home, 'pressed.png'), (await pet.webContents.capturePage()).toPNG())
  pet.webContents.sendInputEvent({ type: 'mouseUp', ...box, button: 'left', clickCount: 1 })
  await new Promise(done => setTimeout(done, 650))
  // A person may move the real macOS pointer during this synthetic press; that
  // correctly counts as a native drag. Exercise dialogue separately in that case.
  if (!(await pet.webContents.executeJavaScript(`bubble.classList.contains('open')`)))
    await pet.webContents.executeJavaScript(`pet.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))`)
  assert.equal(await pet.webContents.executeJavaScript(`bubble.classList.contains('open')`), true,
    await pet.webContents.executeJavaScript(`JSON.stringify({events:window.smokeEvents,held,pressed:body.className})`))
  assert.equal(await pet.webContents.executeJavaScript(`body.classList.contains('pressed')`), false)
  const expectedLines = ['我在。', '先观察，再行动。', '嗯？叫卢登斯。', '别戳了，在想了。', '这次有把握。大概。', '蛛腿也要休息。', '再试一次。', '一起看看？']
  assert.equal(await pet.webContents.executeJavaScript(`message.textContent`), expectedLines[0])
  for (let i = 1; i <= expectedLines.length; i++) {
    const text = await pet.webContents.executeJavaScript(`(() => {
      pet.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      return message.textContent;
    })()`)
    assert.equal(text, expectedLines[i % expectedLines.length], 'Dialogue must cycle through all eight Ludens lines')
  }
  writeFileSync(join(home, 'bubble.png'), (await pet.webContents.capturePage()).toPNG())
  // A light renderer backdrop exposes outline/tail placement hidden by dark previews.
  await pet.webContents.executeJavaScript(`document.documentElement.style.backgroundColor = '#f5f5f5'`)
  await new Promise(done => setTimeout(done, 50))
  writeFileSync(join(home, 'bubble-light.png'), (await pet.webContents.capturePage()).toPNG())
  pet.webContents.send('ludens:companion:flip', true)
  await new Promise(done => setTimeout(done, 350))
  assert.equal(await pet.webContents.executeJavaScript(`mirror.classList.contains('flipped')`), true)
  writeFileSync(join(home, 'flipped.png'), (await pet.webContents.capturePage()).toPNG())
  // Window gutters must preserve portrait size and contain the bubble on both sides.
  for (const size of [170, 220, 280]) {
    resizeCompanionWindow(pet, Math.round(size * 2.7), Math.round(size * 1.65))
    for (const flipped of [false, true]) {
      pet.webContents.send('ludens:companion:flip', flipped)
      await new Promise(done => setTimeout(done, 350))
      const layout = await pet.webContents.executeJavaScript(`(() => {
        const b = bubble.getBoundingClientRect(), p = portrait.getBoundingClientRect();
        return {left:b.left, right:b.right, viewport:innerWidth, portrait:p.width,
          scale:assets.get(pet.dataset.state).display_scale ?? 1,
          offset:(b.left+b.right-p.left-p.right)/2, top:b.top, height:innerHeight};
      })()`)
      assert.ok(layout.left >= -1 && layout.right <= layout.viewport + 1, 'Bubble clipped')
      assert.ok(Math.abs(layout.portrait - size * .9 * layout.scale) < 1, 'Portrait scale changed')
      assert.ok(Math.abs(layout.offset - size * .8 * (flipped ? 1 : -1)) < 1, 'Bubble offset changed')
      assert.ok(Math.abs(layout.top - (layout.height * .26 - 55)) < 1, 'Bubble must sit above-left of Pet')
      assert.ok(layout.top >= 0, 'Raised bubble must remain inside the window')
    }
  }
  // Verify the original audio can actually decode and play, beyond file hashes.
  const audio = await pet.webContents.executeJavaScript(`(async () => {
    const settings = await window.companion.getSound();
    const player = new Audio(settings.source.dataUrl); player.volume = settings.volume;
    await player.play();
    await new Promise((resolve, reject) => { player.onended = resolve; player.onerror = reject; });
    return { name: settings.source.name, duration: player.duration, volume: player.volume };
  })()`)
  assert.ok(audio.duration > 0 && audio.duration <= 10)
  assert.equal(audio.volume, .5)
  // End-to-end RSA display acceptance uses a local fixture, never a model request.
  // Keeping the owner visible must not redirect Pet's speech to a corner toast.
  owner.showInactive()
  const blocks: LogBlock[] = [{ id: 'fixture:thinking', kind: 'thinking', at: new Date().toISOString(),
    title: '思考', text: 'Read the current screen', status: 'running' }]
  companion.configureActivity({ identity: () => 'smoke:workspace', read: async () => ({
    identity: 'smoke:workspace:run:epoch', activity: 'running', mode: 'delta', revision: blocks.length, hasMore: false,
    blocks: blocks.map((block, index) => ({ ...block, createdRevision: index + 1, revision: blocks.length })),
    current: { workspace: home, runId: 'fixture', epoch: 'fixture', phase: '等待模型首事件',
      intent: 'Read the current screen', observationUrl: null, updatedAt: new Date().toISOString(),
      error: null, dashboardUrl: 'http://127.0.0.1:3015/' },
  }) })
  await new Promise(done => setTimeout(done, 100))
  const activity = await pet.webContents.executeJavaScript(`({text:message.textContent, open:!activityActions.hidden, id:activityId})`)
  assert.ok(!activity.text.includes('等待模型首事件'), 'Transport stages stay in the detailed log view')
  assert.ok(activity.text.includes('思考'))
  assert.ok(activity.text.includes('Read the current screen'))
  assert.equal(activity.open, true)
  assert.ok(activity.id)
  writeFileSync(join(home, 'rsa-activity.png'), (await pet.webContents.capturePage()).toPNG())
  blocks[0].status = 'complete'
  blocks.push(
    { id: 'fixture:text', kind: 'text', at: new Date().toISOString(), title: '文本', text: 'I will inspect the evidence.', status: 'complete' },
    { id: 'fixture:tool', kind: 'tool', at: new Date().toISOString(), title: '工具 · exec', text: 'Inspect the selected evidence', status: 'complete' },
  )
  // Both arriving together must reach Pet; the later tool cannot overwrite text.
  for (const [kind, expected] of [['text', 'I will inspect the evidence.'], ['tool', 'Inspect the selected evidence']]) {
    const deadline = Date.now() + 10_000
    while (!(await pet.webContents.executeJavaScript('message.textContent')).includes(expected) && Date.now() < deadline)
      await new Promise(done => setTimeout(done, 100))
    assert.ok((await pet.webContents.executeJavaScript('message.textContent')).includes(expected), `Missing ${kind} bubble`)
    writeFileSync(join(home, `rsa-${kind}.png`), (await pet.webContents.capturePage()).toPNG())
  }
  await pet.webContents.executeJavaScript(`window.companion.dismissActivity(activityId)`)
  assert.equal(await pet.webContents.executeJavaScript(`bubble.classList.contains('open')`), false)
  // Exercise the native content layout through the same IPC used by real logs.
  // Fixtures do not touch the running workspace, model, game, or user preferences.
  companion.configureActivity({ identity: () => 'smoke:complete', read: async () => ({
    identity: 'smoke:complete', activity: 'idle', blocks: [], mode: 'snapshot', revision: 0, hasMore: false, current: {
      workspace: home, runId: null, epoch: null, phase: 'fixture', intent: null,
      observationUrl: null, updatedAt: null, error: null, dashboardUrl: 'http://127.0.0.1:3015/',
    },
  }) })
  await new Promise(done => setTimeout(done, 100))
  const fixtures: LogBlock[] = [
    { id: 'design:thinking', kind: 'thinking', at: '', title: 'Thinking', status: 'running',
      text: 'The stairs are above me.\nI should try jumping.' },
    { id: 'design:text', kind: 'text', at: '', title: 'Assistant', status: 'complete',
      text: 'I found the crafting table.\nNext I will make a healing item.' },
    { id: 'design:tool', kind: 'tool', at: '', title: 'exec', status: 'running', text: '',
      tool: { intent: 'Move toward the stairs', args: { command: 'baseware controller pad play --inputs \'[{"atMs":0,"durationMs":600,"state":{"LY":1}}]\' --wait true' }, result: { exitCode: 0, stdout: 'Controller released.' } } },
    { id: 'design:system', kind: 'system', at: '', title: 'control', status: 'complete', text: '',
      data: { mode: 'manual', reason: 'time budget' } },
    { id: 'design:diagnostic', kind: 'diagnostic', at: '', title: 'model_end', status: 'complete', text: '',
      data: { durationMs: 2410, cacheRead: '98.1%', transport: 'websocket' } },
  ]
  const display = (block: LogBlock) => pet.webContents.send('ludens:activity:display', {
    type: 'show', displayId: block.id,
    input: { id: block.id, title: block.title, description: block.text, block, status: block.status, duration: null, context: 'office' },
  })
  await pet.webContents.executeJavaScript(`document.documentElement.style.backgroundColor = '#18212b'`)
  resizeCompanionWindow(pet, 594, 363)
  pet.webContents.send('ludens:companion:flip', false)
  for (const fixture of fixtures) {
    display(fixture)
    await new Promise(done => setTimeout(done, 350))
    assert.equal(await pet.webContents.executeJavaScript(`message.dataset.kind`), fixture.kind)
    writeFileSync(join(home, `content-${fixture.kind}.png`), (await pet.webContents.capturePage()).toPNG())
  }
  // Long content must be reachable by scrolling, with fixed heading and footer.
  const long = { ...fixtures[0], id: 'design:long', text: 'First line\n' + 'Long source line.\n'.repeat(60) + 'Final line' }
  display(long)
  for (const size of [170, 220, 280]) {
    resizeCompanionWindow(pet, Math.round(size * 2.7), Math.round(size * 1.65))
    for (const flip of [false, true]) {
      pet.webContents.send('ludens:companion:flip', flip)
      await new Promise(done => setTimeout(done, 350))
      const layout = await pet.webContents.executeJavaScript(`(() => {
        const h = message.querySelector('.log-header').getBoundingClientRect();
        const c = message.querySelector('.log-body'), r = c.getBoundingClientRect();
        const f = activityActions.getBoundingClientRect();
        c.scrollTop = c.scrollHeight;
        return { top:h.top, bottom:f.bottom, left:Math.min(h.left, f.left), right:Math.max(h.right, f.right),
          separated:h.bottom <= r.top && r.bottom <= f.top, canScroll:c.scrollTop > 0,
          last:c.textContent.endsWith('Final line'), interactive:activityHit({x:r.x+r.width/2,y:r.y+r.height/2}),
          width:innerWidth, height:innerHeight, portrait:portrait.getBoundingClientRect().width,
          scale:assets.get(pet.dataset.state).display_scale ?? 1 };
      })()`)
      assert.ok(layout.top > 0 && layout.bottom < layout.height && layout.left > 0 && layout.right < layout.width, 'Content clipped at native window edge')
      assert.ok(layout.separated && layout.canScroll && layout.last, 'Long content or fixed controls lost')
      assert.ok(layout.interactive, 'Scroll area must receive native input when mirrored')
      assert.ok(Math.abs(layout.portrait - size * .9 * layout.scale) < 1, `Content styling changed portrait scale: ${JSON.stringify({size, flip, ...layout})}`)
      writeFileSync(join(home, `content-long-${size}-${flip}.png`), (await pet.webContents.capturePage()).toPNG())
    }
  }
  resizeCompanionWindow(pet, 594, 363)
  pet.webContents.send('ludens:companion:flip', false)
  display(fixtures[2])
  await new Promise(done => setTimeout(done, 350))
  await pet.webContents.executeJavaScript(`message.querySelector('summary').click()`)
  display({ ...fixtures[2], status: 'complete' })
  await new Promise(done => setTimeout(done, 100))
  assert.equal(await pet.webContents.executeJavaScript(`message.querySelector('details').open`), true, 'Streaming update collapsed an expanded result')
  writeFileSync(join(home, 'content-tool-result.png'), (await pet.webContents.capturePage()).toPNG())
  console.log('[companion-preview] smoke passed', JSON.stringify({ ...info, audio, rsaActivity: activity.text }))
  // Tear down native windows on a task boundary, outside the renderer IPC promise.
  await new Promise<void>(done => setImmediate(() => { owner.destroy(); done() }))
  assert.equal(pet.isDestroyed(), true)
}).catch(error => { console.error(error); app.exit(1) })
