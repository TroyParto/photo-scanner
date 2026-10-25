const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getOutDir: () => ipcRenderer.invoke('get-out-dir'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  savePhotos: (payload) => ipcRenderer.invoke('save-photos', payload),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir)
})
