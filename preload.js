const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    hasApiKey: () => ipcRenderer.invoke('has-api-key'),
    saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
    saveAnthropicKey: (key) => ipcRenderer.invoke('save-anthropic-key', key),
    saveOpenAIKey: (key) => ipcRenderer.invoke('save-openai-key', key),
    autoDetectPaths: () => ipcRenderer.invoke('auto-detect-paths'),
    selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
    getWorkspace: () => ipcRenderer.invoke('get-workspace'),
    setScreenpipePath: () => ipcRenderer.invoke('set-screenpipe-path'),
    getScreenpipePath: () => ipcRenderer.invoke('get-screenpipe-path'),
    quitApp: () => ipcRenderer.send('quit-app'),
    requestMedia: () => ipcRenderer.invoke('request-media'),
    completeWizard: () => ipcRenderer.invoke('complete-wizard')
});
