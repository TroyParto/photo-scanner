const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
let autoUpdater = null
try { autoUpdater = require('electron-updater').autoUpdater } catch (e) {}

let win
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch (e) { return {} } }
function saveSettings(s) { try { fs.writeFileSync(settingsFile(), JSON.stringify(s)) } catch (e) {} }

function defaultOutDir() {
  const s = loadSettings()
  const dir = s.outDir || path.join(app.getPath('pictures'), 'Photo Scanner')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
  return dir
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: 'Photo Scanner',
    backgroundColor: '#f4f2ee',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })
  win.setMenuBarVisibility(false)
  win.on('page-title-updated', e => e.preventDefault())
  win.loadFile('index.html')
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

ipcMain.handle('get-out-dir', () => defaultOutDir())

ipcMain.handle('pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where to save the cropped photos',
    properties: ['openDirectory', 'createDirectory']
  })
  if (canceled || !filePaths.length) return null
  saveSettings({ ...loadSettings(), outDir: filePaths[0] })
  return filePaths[0]
})

// Saves every photo of one scanned page straight into the output folder (never overwrites).
ipcMain.handle('save-photos', async (event, { dir, files }) => {
  fs.mkdirSync(dir, { recursive: true })
  const saved = []
  for (const f of files) {
    let target = path.join(dir, f.name)
    const ext = path.extname(f.name), base = path.basename(f.name, ext)
    let n = 1
    while (fs.existsSync(target)) { target = path.join(dir, `${base}-${n}${ext}`); n++ }
    fs.writeFileSync(target, Buffer.from(f.data))
    saved.push(path.basename(target))
  }
  return saved
})

ipcMain.handle('open-folder', (event, dir) => shell.openPath(dir))

app.whenReady().then(() => {
  createWindow()
  win.setTitle('Photo Scanner v' + app.getVersion())
  if (app.isPackaged && autoUpdater) {
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', () => {})
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
