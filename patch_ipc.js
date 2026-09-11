const fs = require('fs');
let code = fs.readFileSync('main.js', 'utf8');

code += `
ipcMain.handle('request-media', async () => {
    try {
        const mic = await systemPreferences.askForMediaAccess('microphone');
        const cam = await systemPreferences.askForMediaAccess('camera');
        return mic && cam;
    } catch(e) {
        return false;
    }
});

ipcMain.handle('complete-wizard', (event) => {
    store.set('hasCompletedWizard', true);
    if (mainWindow && global.serverPort) {
        mainWindow.loadURL('http://localhost:' + global.serverPort + '/static/index.html');
    }
});
`;
fs.writeFileSync('main.js', code);

// Fix wizard.html to use window.electronAPI
let wiz = fs.readFileSync('frontend/wizard.html', 'utf8');
wiz = wiz.replace("const { ipcRenderer } = require('electron');", "");
wiz = wiz.replace(/ipcRenderer\.invoke/g, "window.electronAPI");
wiz = wiz.replace(/window\.electronAPI\('([a-zA-Z0-9-]+)'\)/g, function(match, p1) {
    if (p1 === 'has-api-key') return 'window.electronAPI.hasApiKey()';
    if (p1 === 'get-workspace') return 'window.electronAPI.getWorkspace()';
    if (p1 === 'request-media') return 'window.electronAPI.requestMedia()';
    if (p1 === 'select-workspace') return 'window.electronAPI.selectWorkspace()';
    if (p1 === 'complete-wizard') return 'window.electronAPI.completeWizard()';
    return match;
});
fs.writeFileSync('frontend/wizard.html', wiz);

