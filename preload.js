const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    hasApiKey: () => ipcRenderer.invoke('has-api-key'),
    saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
    selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
    getWorkspace: () => ipcRenderer.invoke('get-workspace'),
    quitApp: () => ipcRenderer.send('quit-app')
});
