'use strict';
// Electron main process: the window, native dialogs and permissions, and the
// bridge between the settings page and the config module.

const { app, BrowserWindow, systemPreferences, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('./src/config');
const legacy = require('./src/legacy');
const googleCtx = require('./src/google');
const screenpipe = require('./src/screenpipe');
const { startServer } = require('./src/server');

let mainWindow = null;
let serverPort = null;

function pageUrl(page, query = '') {
  return `http://127.0.0.1:${serverPort}/static/${page}${query}`;
}

function showApp() {
  if (mainWindow) mainWindow.loadURL(pageUrl('index.html'));
}

function showSettings(mode) {
  if (mainWindow) mainWindow.loadURL(pageUrl('settings.html', `?mode=${mode}`));
}

function mediaStatus() {
  if (process.platform !== 'darwin') return { camera: 'granted', microphone: 'granted' };
  return {
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone')
  };
}

function statusPayload() {
  const settings = config.getSettings();
  const keys = config.getKeys();
  const googleClient = googleCtx.loadClientConfig(settings);
  return {
    platform: process.platform,
    keys: { gemini: !!keys.gemini, anthropic: !!keys.anthropic, openai: !!keys.openai },
    encryption: config.encryptionAvailable(),
    workspaceDir: settings.workspaceDir,
    mediaDir: settings.mediaDir,
    mediaDirIsDefault: settings.mediaDir === path.join(settings.workspaceDir, 'archives'),
    screenpipe: { configured: settings.screenpipeDbPath, found: screenpipe.findDatabase(settings.screenpipeDbPath) },
    google: { configured: !!googleClient, source: googleClient ? googleClient.source : null, accounts: config.listGoogleAccounts() },
    media: mediaStatus(),
    silenceSeconds: settings.silenceSeconds,
    hasCompletedWizard: settings.hasCompletedWizard
  };
}

// ---------------------------------------------------------------------------
// IPC

ipcMain.handle('get-status', () => statusPayload());

ipcMain.handle('set-secret', (event, name, value) => {
  if (!config.SECRET_NAMES.includes(name)) throw new Error('Unknown secret.');
  config.setSecret(name, value);
  return statusPayload();
});

ipcMain.handle('set-setting', (event, name, value) => {
  const allowed = ['silenceSeconds', 'sessionMinutesSoftLimit'];
  if (!allowed.includes(name)) throw new Error('Unknown setting.');
  config.setSetting(name, value);
  return statusPayload();
});

ipcMain.handle('select-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where session notes are saved',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: config.getSettings().workspaceDir
  });
  if (!result.canceled && result.filePaths.length) {
    const previous = config.getSettings();
    config.setSetting('workspaceDir', result.filePaths[0]);
    // If the recordings folder was the default under the old workspace, follow the workspace.
    if (previous.mediaDir === path.join(previous.workspaceDir, 'archives')) config.setSetting('mediaDir', null);
    fs.mkdirSync(result.filePaths[0], { recursive: true });
  }
  return statusPayload();
});

ipcMain.handle('select-media-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where recordings are saved',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: config.getSettings().mediaDir
  });
  if (!result.canceled && result.filePaths.length) config.setSetting('mediaDir', result.filePaths[0]);
  return statusPayload();
});

ipcMain.handle('reset-media-dir', () => { config.setSetting('mediaDir', null); return statusPayload(); });

ipcMain.handle('show-workspace', () => {
  const dir = config.getSettings().workspaceDir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle('show-path', (event, target) => {
  if (target && fs.existsSync(target)) shell.showItemInFolder(target);
});

ipcMain.handle('select-screenpipe', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the Screenpipe database (db.sqlite)',
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'SQLite databases', extensions: ['sqlite', 'db'] }]
  });
  if (!result.canceled && result.filePaths.length) config.setSetting('screenpipeDbPath', result.filePaths[0]);
  return statusPayload();
});

ipcMain.handle('clear-screenpipe', () => { config.setSetting('screenpipeDbPath', null); return statusPayload(); });

ipcMain.handle('select-google-client', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the Google OAuth client file (client_secret_....json)',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result.canceled && result.filePaths.length) {
    googleCtx.parseClientJson(fs.readFileSync(result.filePaths[0], 'utf-8')); // throws a readable error if wrong
    config.setSetting('googleClientPath', result.filePaths[0]);
  }
  return statusPayload();
});

ipcMain.handle('google-connect', async () => {
  const account = await googleCtx.connectAccount({ openExternal: url => shell.openExternal(url) });
  return { account, status: statusPayload() };
});

ipcMain.handle('google-disconnect', (event, id) => { config.removeGoogleAccount(id); return statusPayload(); });

ipcMain.handle('request-media', async () => {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
    await systemPreferences.askForMediaAccess('camera');
  }
  return mediaStatus();
});

ipcMain.handle('open-privacy-settings', (event, kind) => {
  const anchor = kind === 'camera' ? 'Privacy_Camera' : 'Privacy_Microphone';
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
});

ipcMain.handle('complete-wizard', () => { config.setSetting('hasCompletedWizard', true); showApp(); });
ipcMain.handle('open-app', () => showApp());
ipcMain.handle('open-settings', () => showSettings('settings'));
ipcMain.on('quit-app', () => app.quit());

// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (config.getSettings().hasCompletedWizard && config.getKeys().gemini) showApp();
  else showSettings('wizard');

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try { legacy.importIfNeeded(); } catch (e) { console.error('legacy import failed', e); }
  try {
    const { port } = await startServer();
    serverPort = port;
  } catch (e) {
    dialog.showErrorBox('Madrone Context could not start', e.message);
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// This is a single-window app: closing the window quits, which also turns the camera off.
app.on('window-all-closed', () => app.quit());
