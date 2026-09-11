const { app, BrowserWindow, systemPreferences, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const Store = require('electron-store');
const store = new Store();
const { startServer, setApiKey, setArchiveDir } = require('./server.js');

let mainWindow;

// Set default workspace if not set
if (!store.get('workspaceDir')) {
    store.set('workspaceDir', path.join(app.getPath('documents'), 'MadroneContext'));
}

ipcMain.handle('has-api-key', () => {
    let geminiOk = false;
    let anthropicOk = false;
    let openaiOk = false;
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
    
    // Check Anthropic
    if (store.get('anthropicApiKey')) {
        anthropicOk = true;
    } else {
        try {
            const rawResult = execSync(`security find-generic-password -s "AntiGravity" -a "anthropic-api-key" -w`, { encoding: 'utf-8' }).trim();
            if (rawResult) anthropicOk = true;
        } catch(e) {}
    }
    
    // Check OpenAI
    if (store.get('openaiApiKey')) {
        openaiOk = true;
    } else {
        try {
            const rawResult = execSync(`security find-generic-password -s "AntiGravity" -a "openai-api-key" -w`, { encoding: 'utf-8' }).trim();
            if (rawResult) openaiOk = true;
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
    
    return { gemini: geminiOk, anthropic: anthropicOk, openai: openaiOk, google: googleOk };
});

ipcMain.handle('save-api-key', (event, key) => {
    store.set('geminiApiKey', key);
    setApiKey(key);
    return true;
});

ipcMain.handle('save-anthropic-key', (event, key) => {
    store.set('anthropicApiKey', key);
    return true;
});

ipcMain.handle('save-openai-key', (event, key) => {
    store.set('openaiApiKey', key);
    return true;
});

ipcMain.handle('select-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        store.set('workspaceDir', result.filePaths[0]);
        setArchiveDir(result.filePaths[0]);
        return result.filePaths[0];
    }
    return store.get('workspaceDir');
});

ipcMain.handle('get-workspace', () => {
    return store.get('workspaceDir');
});

ipcMain.handle('auto-detect-paths', () => {
    const homedir = os.homedir();
    
    // Detect Screenpipe
    let spPath = path.join(homedir, '.screenpipe', 'db.sqlite');
    if (!fs.existsSync(spPath)) {
        spPath = path.join(homedir, '.local', 'share', 'screenpipe', 'db.sqlite');
    }
    if (!fs.existsSync(spPath)) spPath = null;
    
    // Detect Obsidian
    let obsPath = null;
    const possiblePaths = [
        path.join(homedir, 'Documents'),
        path.join(homedir, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
        homedir
    ];
    for (const base of possiblePaths) {
        if (!fs.existsSync(base)) continue;
        try {
            const items = fs.readdirSync(base);
            for (const item of items) {
                const fullPath = path.join(base, item);
                try {
                    if (fs.statSync(fullPath).isDirectory()) {
                        if (fs.existsSync(path.join(fullPath, '.obsidian'))) {
                            obsPath = fullPath;
                            break;
                        }
                    }
                } catch(e) {}
            }
            if (obsPath) break;
        } catch(e) {}
    }
    
    // Automatically set them in the store if they are empty
    if (!store.get('workspaceDir') && obsPath) {
        const defaultMadrone = path.join(obsPath, "Madrone Sessions");
        if (!fs.existsSync(defaultMadrone)) fs.mkdirSync(defaultMadrone, {recursive: true});
        store.set('workspaceDir', defaultMadrone);
    }
    if (!store.get('screenpipeDbPath') && spPath) {
        store.set('screenpipeDbPath', spPath);
    }
    
    return { screenpipe: spPath, obsidian: obsPath };
});

ipcMain.handle('set-screenpipe-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'SQLite Databases', extensions: ['sqlite', 'db'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        store.set('screenpipeDbPath', result.filePaths[0]);
        return result.filePaths[0];
    }
    return store.get('screenpipeDbPath');
});

ipcMain.handle('get-screenpipe-path', () => {
    return store.get('screenpipeDbPath');
});

ipcMain.on('quit-app', () => {
    app.quit();
});

async function requestPermissions() {
    if (process.platform === 'darwin') {
        const micAccess = await systemPreferences.askForMediaAccess('microphone');
        const camAccess = await systemPreferences.askForMediaAccess('camera');
        console.log(`Microphone access: ${micAccess}`);
        console.log(`Camera access: ${camAccess}`);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Start the local websocket server dynamically
    startServer().then(port => {
        global.serverPort = port;
        if (!store.get('hasCompletedWizard')) {
            mainWindow.loadFile(path.join(__dirname, 'frontend', 'wizard.html'));
        } else {
            mainWindow.loadURL('http://localhost:' + port + '/static/index.html');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    await requestPermissions();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

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
