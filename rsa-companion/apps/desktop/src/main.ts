import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createCompanion } from './companion.js'
import { RsaSource, type RsaPetSnapshot } from './rsa-source.js'

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  workspace: { type: 'string' }, dashboard: { type: 'string' }, profile: { type: 'string' },
  'show-window': { type: 'boolean' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Alice Pet — RSA log viewer\n\n--workspace PATH   Workspace to follow (default: cwd / RSA_WORKSPACE)\n--dashboard URL    Local RSA dashboard (default: http://127.0.0.1:3015)\n--profile PATH     Separate local pet preferences\n--show-window      Open the run/settings window on launch\n\nThe pet reads existing logs; it never starts or stops the game agent.')
  app.exit(0)
} else {
  const workspace = realpathSync(resolve(values.workspace ?? process.env.RSA_WORKSPACE ?? process.cwd()))
  const dashboard = new URL(values.dashboard ?? 'http://127.0.0.1:3015')
  if (dashboard.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(dashboard.hostname) || dashboard.username || dashboard.password) {
    throw new Error('--dashboard must be a local HTTP URL')
  }
  const here = dirname(fileURLToPath(import.meta.url))
  app.setName('RSA Alice Pet')
  app.setPath('userData', resolve(values.profile ?? join(app.getPath('appData'), 'RSA Alice Pet')))
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (!app.requestSingleInstanceLock()) {
    console.error('Alice Pet is already running with this profile. Open it from the tray, or use --profile for another instance.')
    app.exit(1)
  } else {
    let quitting = false
    let owner: BrowserWindow | undefined
    let tray: Tray | undefined
    let source: RsaSource | undefined
    let snapshot: RsaPetSnapshot = {
      workspace, runId: null, epoch: null, phase: '正在连接日志', intent: null,
      observationUrl: null, updatedAt: null, error: null, dashboardUrl: dashboard.href,
    }
    const showOwner = () => {
      if (!owner || owner.isDestroyed()) return
      if (owner.isMinimized()) owner.restore()
      owner.show(); owner.focus()
    }
    app.on('second-instance', showOwner)
    app.on('activate', showOwner)
    app.on('before-quit', () => { quitting = true; source?.stop() })
    app.on('window-all-closed', () => app.quit())
    void app.whenReady().then(async () => {
      owner = new BrowserWindow({
        title: 'Alice Pet · RSA', width: 980, height: 760, minWidth: 700, minHeight: 540,
        show: false, backgroundColor: '#131313',
        webPreferences: { preload: join(here, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
      })
      owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      owner.webContents.on('will-navigate', event => event.preventDefault())
      owner.on('close', event => { if (!quitting) { event.preventDefault(); owner?.hide() } })
      const pet = createCompanion(owner)
      if (!pet) throw new Error('Alice Pet is disabled by OPENALICE_DISABLE_COMPANION')
      const trusted = (event: Electron.IpcMainInvokeEvent) =>
        !!owner && event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame
      ipcMain.handle('rsa-pet:snapshot', event => {
        if (!trusted(event)) throw new Error('Unauthorized pet access')
        return snapshot
      })
      ipcMain.handle('rsa-pet:open-dashboard', async event => {
        if (!trusted(event)) throw new Error('Unauthorized pet access')
        // This URL is derived in main from the configured local dashboard, never renderer input.
        await shell.openExternal(snapshot.dashboardUrl)
      })
      owner.webContents.on('did-finish-load', () => owner?.webContents.send('rsa-pet:snapshot', snapshot))
      source = new RsaSource({ workspace, dashboardUrl: dashboard.href, onSnapshot: value => {
        snapshot = value
        if (owner && !owner.isDestroyed()) owner.webContents.send('rsa-pet:snapshot', value)
      } })
      pet.configureActivity(source)
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
      await owner.loadFile(resolve(here, '../ui/index.html'))
      if (values['show-window']) showOwner()
      console.log(`[alice-pet] workspace=${workspace} dashboard=${dashboard.origin} profile=${app.getPath('userData')}`)
    }).catch(error => { console.error(error); app.exit(1) })
  }
}
