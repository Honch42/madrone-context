const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  setSecret: (name, value) => ipcRenderer.invoke('set-secret', name, value),
  setSetting: (name, value) => ipcRenderer.invoke('set-setting', name, value),
  selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
  selectMediaDir: () => ipcRenderer.invoke('select-media-dir'),
  resetMediaDir: () => ipcRenderer.invoke('reset-media-dir'),
  showWorkspace: () => ipcRenderer.invoke('show-workspace'),
  showPath: (target) => ipcRenderer.invoke('show-path', target),
  selectScreenpipe: () => ipcRenderer.invoke('select-screenpipe'),
  clearScreenpipe: () => ipcRenderer.invoke('clear-screenpipe'),
  selectGoogleClient: () => ipcRenderer.invoke('select-google-client'),
  googleConnect: () => ipcRenderer.invoke('google-connect'),
  googleDisconnect: (id) => ipcRenderer.invoke('google-disconnect', id),
  requestMedia: () => ipcRenderer.invoke('request-media'),
  openPrivacySettings: (kind) => ipcRenderer.invoke('open-privacy-settings', kind),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  completeWizard: () => ipcRenderer.invoke('complete-wizard'),
  openApp: () => ipcRenderer.invoke('open-app'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  quitApp: () => ipcRenderer.send('quit-app')
});
