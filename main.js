const { app, BrowserWindow, systemPreferences, ipcMain, dialog } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const Store = require('electron-store');
const store = new Store();
const { startServer, setApiKey, setArchiveDir } = require('./server.js');

let mainWindow;

// Set default workspace if not set
if (!store.get('workspaceDir')) {
    store.set('workspaceDir', path.join(app.getPath('documents'), 'ProactiveContext'));
}

ipcMain.handle('has-api-key', () => {
    // Check electron-store first, then fallback to Mac Keychain
    if (store.get('geminiApiKey')) return true;
    try {
        const result = execSync(`security find-generic-password -s "AntiGravity" -a "gemini-api-key-Collective" -w`, { encoding: 'utf-8' });
        if (result.trim()) {
            store.set('geminiApiKey', result.trim());
            return true;
        }
    } catch(e) {}
    return false;
});

ipcMain.handle('save-api-key', (event, key) => {
    store.set('geminiApiKey', key);
    setApiKey(key);
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

    // Start the local websocket server on port 8000
    startServer();

    // Load the frontend directly from the local file system or via a simple express server.
    // Since we use absolute paths in HTML for /static, we might need a tiny express server for the static files, 
    // OR we can just loadFile and modify the HTML to use relative paths.
    // Let's use a tiny express server in server.js to serve the frontend!
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:8000/static/index.html');
    }, 1000); // Wait 1 second for the server to start

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
