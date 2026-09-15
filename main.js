'use strict';
// Electron main process: the window, native dialogs and permissions, and the
// bridge between the settings page and the config module.

const { app, BrowserWindow, systemPreferences, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('./src/config');
const legacy = require('./src/legacy');
const discover = require('./src/discover');
const onepassword = require('./src/onepassword');
const storage = require('./src/storage');
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

function showSettings(mode, focus) {
  if (mainWindow) mainWindow.loadURL(pageUrl('settings.html', `?mode=${mode}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`));
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
    anthropicAuth: settings.anthropicAuth,
    keySources: { gemini: config.getKeySource('geminiApiKey'), anthropic: config.getKeySource('anthropicApiKey'), openai: config.getKeySource('openaiApiKey') },
    onePassword: { installed: onepassword.isInstalled() },
    encryption: config.encryptionAvailable(),
    workspaceDir: settings.workspaceDir,
    mediaDir: settings.mediaDir,
    mediaDirIsDefault: settings.mediaDir === storage.defaultMediaDir(settings.workspaceDir),
    vault: storage.findVaultRoot(settings.workspaceDir),
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

const SECRET_FOR_VENDOR = { gemini: 'geminiApiKey', anthropic: 'anthropicApiKey', openai: 'openaiApiKey' };
const VENDOR_FOR_SECRET = Object.fromEntries(Object.entries(SECRET_FOR_VENDOR).map(([v, n]) => [n, v]));

const VENDOR_LABEL = { gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' };

// Catches the two common paste mistakes (wrong vendor, partial copy) without
// rejecting a valid key in a format newer than the patterns we know.
function storeKey(name, value, source) {
  const vendor = VENDOR_FOR_SECRET[name];
  if (value && !discover.looksLikeKey(vendor, value)) {
    const other = discover.vendorForKey(value);
    if (other && other !== vendor) throw new Error(`That looks like a ${VENDOR_LABEL[other]} key, not a ${VENDOR_LABEL[vendor]} key.`);
    if (/\s/.test(value) || value.length < 16) throw new Error('That does not look like an API key. Check that you copied the whole key with no spaces.');
  }
  config.setSecret(name, value, source);
  if (name === 'anthropicApiKey' && value) config.setSetting('anthropicAuth', 'key');
}

ipcMain.handle('set-secret', async (event, name, value) => {
  if (!config.SECRET_NAMES.includes(name)) throw new Error('Unknown secret.');
  const text = (value || '').trim();
  if (onepassword.isReference(text)) {
    // A pasted 1Password secret reference such as op://Private/Anthropic/credential.
    const resolved = await onepassword.readReference(text);
    storeKey(name, resolved, { type: 'onepassword', ref: text, title: text });
    return statusPayload();
  }
  storeKey(name, text, text ? { type: 'pasted' } : null);
  return statusPayload();
});

// 1Password: list likely items (titles only), import one, or refresh a key that came from there.
ipcMain.handle('onepassword-list', (event, vendor) => onepassword.listCandidates(vendor));

ipcMain.handle('onepassword-import', async (event, vendor, itemId) => {
  const name = SECRET_FOR_VENDOR[vendor];
  if (!name) throw new Error('Unknown vendor.');
  const { value, title } = await onepassword.readItem(itemId, v => discover.looksLikeKey(vendor, v));
  storeKey(name, value, { type: 'onepassword', itemId, title });
  return statusPayload();
});

ipcMain.handle('onepassword-refresh', async (event, vendor) => {
  const name = SECRET_FOR_VENDOR[vendor];
  const source = name && config.getKeySource(name);
  if (!source || source.type !== 'onepassword') throw new Error('This key did not come from 1Password.');
  const value = source.ref ? await onepassword.readReference(source.ref) : (await onepassword.readItem(source.itemId, v => discover.looksLikeKey(vendor, v))).value;
  storeKey(name, value, source);
  return statusPayload();
});

// Any .env file, wherever the user keeps it.
ipcMain.handle('import-env-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a .env file that contains your API keys',
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'Env files', extensions: ['env', 'txt', '*'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const file = result.filePaths[0];
  const found = discover.candidatesFromEnvText(fs.readFileSync(file, 'utf-8'), path.basename(file));
  return { file, ...found };
});

// Reads the clipboard only when the user clicks, and only offers it if it looks like a key.
ipcMain.handle('clipboard-key', (event, vendor) => {
  const text = (clipboard.readText() || '').trim();
  if (!text || text.length > 400) return null;
  return discover.register(vendor, text, 'Clipboard');
});

// Keys already on this Mac. Values stay in the main process; the page only
// sees masked previews and picks one by id.
ipcMain.handle('detect-keys', () => discover.discover());

ipcMain.handle('use-detected-key', (event, id) => {
  const hit = discover.resolve(id);
  if (!hit) throw new Error('That key is no longer available. Try again.');
  storeKey(SECRET_FOR_VENDOR[hit.vendor], hit.value, { type: 'found', title: 'found on this Mac' });
  return statusPayload();
});

ipcMain.handle('use-anthropic-profile', () => {
  if (!discover.anthropicProfile().found) throw new Error('No Anthropic CLI sign-in was found. Run `ant auth login` in Terminal first.');
  config.setSetting('anthropicAuth', 'profile');
  return statusPayload();
});

ipcMain.handle('dismiss-google-suggestion', () => { config.setSetting('googleSuggestionDismissed', true); return statusPayload(); });

ipcMain.handle('forget-everything', () => { config.forgetEverything(); showSettings('wizard'); });

ipcMain.handle('set-setting', (event, name, value) => {
  const allowed = ['silenceSeconds', 'sessionMinutesSoftLimit', 'anthropicAuth'];
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
    if (previous.mediaDir === storage.defaultMediaDir(previous.workspaceDir)) config.setSetting('mediaDir', null);
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

ipcMain.handle('open-in-obsidian', (event, target) => {
  if (typeof target === 'string' && fs.existsSync(target) && storage.findVaultRoot(path.dirname(target))) return shell.openExternal(storage.obsidianUrl(target));
  return false;
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

ipcMain.handle('request-microphone', async () => {
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');
  return mediaStatus();
});

ipcMain.handle('request-camera', async () => {
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('camera');
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
ipcMain.handle('open-app', () => {
  // Finishing setup from the full settings page counts once the essentials are in place.
  if (config.getKeys().gemini && mediaStatus().microphone === 'granted') config.setSetting('hasCompletedWizard', true);
  showApp();
});
ipcMain.handle('open-settings', (event, focus) => showSettings('settings', focus));
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
