import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createCompanion } from './companion.js'
import type { RsaPetSnapshot } from './rsa-source.js'
import { AliceSessionCoordinator } from './alice-session.js'
import { dashboardSender, isDashboardUrl } from './dashboard-window.js'

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  workspace: { type: 'string' }, dashboard: { type: 'string' }, profile: { type: 'string' },
  'show-window': { type: 'boolean' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Alice Pet — RSA log viewer\n\n--workspace PATH   Initial workspace, only when no follow target has been saved\n--dashboard URL    Local RSA dashboard (default: http://127.0.0.1:3015)\n--profile PATH     Separate local pet preferences\n--show-window      Open the run/settings window on launch\n\nChoose the workspace to follow in the Dashboard. The pet reads existing logs; it never starts or stops the game agent.')
  app.exit(0)
} else {
  const initialWorkspace = values.workspace ?? process.env.RSA_WORKSPACE
  const workspace = initialWorkspace ? realpathSync(resolve(initialWorkspace)) : undefined
  const dashboard = new URL(values.dashboard ?? 'http://127.0.0.1:3015')
  if (dashboard.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(dashboard.hostname) || dashboard.username || dashboard.password) {
    throw new Error('--dashboard must be a local HTTP URL')
  }
  const here = dirname(fileURLToPath(import.meta.url))
  app.setName('RSA Alice Pet')
  app.setPath('userData', resolve(values.profile ?? join(app.getPath('appData'), 'RSA Alice Pet')))
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
  } else {
    let quitting = false
    let owner: BrowserWindow | undefined
    let tray: Tray | undefined
    let source: AliceSessionCoordinator | undefined
    let retryDashboard: (() => void) | undefined
    let dashboardTimer: ReturnType<typeof setInterval> | undefined
    let snapshot: RsaPetSnapshot = {
      workspace: null, runId: null, epoch: null, phase: '请选择要跟随的工作区', intent: null,
      observationUrl: null, updatedAt: null, error: null, dashboardUrl: dashboard.href,
    }
    const showOwner = () => {
      if (!owner || owner.isDestroyed()) return
      if (owner.isMinimized()) owner.restore()
      owner.show(); owner.focus()
      retryDashboard?.()
    }
    app.on('second-instance', showOwner)
    app.on('activate', showOwner)
    app.on('before-quit', () => { quitting = true; clearInterval(dashboardTimer); source?.stop() })
    app.on('window-all-closed', () => app.quit())
    void app.whenReady().then(async () => {
      owner = new BrowserWindow({
        title: 'Playness · Console', width: 1440, height: 940, minWidth: 960, minHeight: 640,
        show: false, backgroundColor: '#202321',
        webPreferences: { preload: join(here, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
      })
      owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const navigation = (event: Electron.Event, url: string) => { if (!isDashboardUrl(url, dashboard.origin)) event.preventDefault() }
      owner.webContents.on('will-navigate', navigation)
      owner.webContents.on('will-redirect', navigation)
      owner.on('close', event => { if (!quitting) { event.preventDefault(); owner?.hide() } })
      const trusted = (event: Electron.IpcMainInvokeEvent) => !!owner && dashboardSender(owner, dashboard.origin, event)
      const openDetails = (url: string) => {
        if (!owner || owner.isDestroyed() || !isDashboardUrl(url, dashboard.origin)) return
        void owner.loadURL(url).catch(error => console.error('[alice-pet] dashboard navigation failed:', error))
      }
      const pet = createCompanion(owner, { trustedOwner: trusted, openDetails })
      if (!pet) throw new Error('Alice Pet is disabled by OPENALICE_DISABLE_COMPANION')
      ipcMain.handle('rsa-pet:snapshot', event => {
        if (!trusted(event)) throw new Error('Unauthorized pet access')
        return snapshot
      })
      ipcMain.handle('rsa-pet:open-dashboard', async event => {
        if (!trusted(event)) throw new Error('Unauthorized pet access')
        openDetails(snapshot.dashboardUrl)
        showOwner()
      })
      owner.webContents.on('did-finish-load', () => owner?.webContents.send('rsa-pet:snapshot', snapshot))
      source = new AliceSessionCoordinator({ dashboardUrl: dashboard.href, onTargetChanged: () => {
        if (source) pet.configureActivity(source)
      }, onSnapshot: value => {
        snapshot = value
        if (owner && !owner.isDestroyed()) owner.webContents.send('rsa-pet:snapshot', value)
      } })
      pet.configureActivity(source)
      void source.start(workspace)
      const icon = nativeImage.createFromPath(resolve(here, '../../ui/public/companion/alice.png')).resize({ width: 20, height: 20 })
      tray = new Tray(icon)
      tray.setToolTip('Alice Pet · RSA')
      tray.on('click', showOwner)
      tray.on('right-click', () => Menu.buildFromTemplate([
        { label: 'Open Alice Pet', click: showOwner },
        ...pet.trayMenuItems(),
        { type: 'separator' },
        { label: 'Quit Alice Pet', click: () => app.quit() },
      ]).popup())
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'Alice Pet', submenu: [ { label: 'Open Alice Pet', click: showOwner }, { type: 'separator' }, { role: 'quit' } ] },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]))
      const initial = new URL(dashboard.origin)
      initial.searchParams.set('view', 'live')
      let loadingDashboard = false, dashboardReady = false
      const loadDashboard = async () => {
        if (loadingDashboard || dashboardReady || quitting || !owner || owner.isDestroyed()) return
        loadingDashboard = true
        try {
          await owner.loadURL(initial.href)
          dashboardReady = true
        } catch {
          if (owner && !owner.isDestroyed() && !quitting) {
            const offline = '<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Playness · 等待日志服务</title><body style="background:#202321;color:#f0f2ee;font:16px system-ui;padding:64px"><h1>等待本地日志服务</h1><p>Alice 正在重新连接。服务恢复后，这个窗口会自动打开。</p></body></html>'
            await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offline)}`).catch(() => {})
          }
        } finally { loadingDashboard = false }
      }
      retryDashboard = () => { void loadDashboard() }
      dashboardTimer = setInterval(retryDashboard, 5_000)
      await loadDashboard()
      if (values['show-window'] || !workspace) showOwner()
      console.log(`[alice-pet] dashboard=${dashboard.origin} profile=${app.getPath('userData')}`)
    }).catch(error => { console.error(error); app.exit(1) })
  }
}
