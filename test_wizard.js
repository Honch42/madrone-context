const { app, BrowserWindow, systemPreferences, ipcMain, dialog } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const Store = require('electron-store');
const store = new Store();
const { startServer, setApiKey, setArchiveDir } = require('./server.js');

let mainWindow;

store.set('hasCompletedWizard', false); // FORCE FALSE FOR TESTING

ipcMain.handle('has-api-key', () => {
    let geminiOk = false;
    let googleOk = true;
    
    // Check Gemini
    if (store.get('geminiApiKey')) {
        geminiOk = true;
    } else {
        try {
            const rawResult = execSync(`security find-generic-password -s "AntiGravity" -a "gemini-api-key-Collective" -w`, { encoding: 'utf-8' }).trim();
            if (rawResult) geminiOk = true;
        } catch(e) {}
    }
    
    // Check Google Tokens
    const accounts = ['Personal', 'Collective', 'IV'];
    for (const acc of accounts) {
        try {
            const rawResult = execSync(`security find-generic-password -s "AntiGravity" -a "google-token-${acc}" -w`, { encoding: 'utf-8' }).trim();
            if (!rawResult) googleOk = false;
        } catch(e) {
            googleOk = false;
        }
    }
    
    return { gemini: geminiOk, google: googleOk };
});

ipcMain.handle('select-workspace', async () => {
    return "/test/path";
});

ipcMain.handle('get-workspace', () => {
    return "/test/path";
});

ipcMain.on('quit-app', () => {
    app.quit();
});

ipcMain.handle('request-media', async () => {
    return true;
});

ipcMain.handle('complete-wizard', (event) => {
    console.log("WIZARD COMPLETED");
    app.quit();
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'frontend', 'wizard.html'));
    
    // Auto-complete the wizard using injected JS to test if the UI actually works
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript(`
            setTimeout(() => {
                document.getElementById('btn-media').click();
                setTimeout(() => {
                    document.getElementById('btn-finish').click();
                }, 1000);
            }, 1000);
        `);
    });
}

app.whenReady().then(async () => {
    createWindow();
});
