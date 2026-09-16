'use strict';
// Settings and secrets for Madrone Context.
//
// Settings (folders, flags, connected accounts) live in electron-store.
// Secrets (API keys, Google tokens) are encrypted with Electron's safeStorage,
// which uses the macOS Keychain, before they are written to that store.
// Outside Electron (tests, `node src/server.js`) a plain JSON file is used.

const path = require('path');
const os = require('os');
const fs = require('fs');

let electron = null;
try { electron = require('electron'); } catch (e) { /* not running inside Electron */ }
const safeStorage = electron && electron.safeStorage ? electron.safeStorage : null;

// ---------------------------------------------------------------------------
// Backing store

function createStore() {
  if (electron && electron.app) {
    const Store = require('electron-store');
    return new Store({ name: 'config' });
  }
  // Fallback: a tiny JSON file store so the server can run without Electron.
  const dir = process.env.MADRONE_CONFIG_DIR || path.join(os.homedir(), '.madrone-context');
  const file = path.join(dir, 'config.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { data = {}; }
  const flush = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  return {
    get: (k, d) => (data[k] === undefined ? d : data[k]),
    set: (k, v) => { data[k] = v; flush(); },
    delete: (k) => { delete data[k]; flush(); },
    get path() { return file; }
  };
}

let store = null;
function getStore() {
  if (!store) store = createStore();
  return store;
}

// ---------------------------------------------------------------------------
// Secrets

const SECRET_NAMES = ['geminiApiKey', 'anthropicApiKey', 'openaiApiKey'];

function encryptionAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}

function encrypt(plain) {
  if (encryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  return 'plain:' + plain;
}

function decrypt(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return null;
  if (stored.startsWith('enc:')) {
    if (!encryptionAvailable()) return null;
    try { return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')); } catch (e) { return null; }
  }
  if (stored.startsWith('plain:')) return stored.slice(6);
  // Legacy value written before encryption existed: treat as plaintext.
  return stored;
}

function getSecret(name) {
  const raw = getStore().get(name);
  const value = decrypt(raw);
  // Upgrade legacy plaintext values to encrypted storage on first read.
  if (value && typeof raw === 'string' && !raw.startsWith('enc:') && !raw.startsWith('plain:') && encryptionAvailable()) {
    getStore().set(name, encrypt(value));
  }
  return value || null;
}

function setSecret(name, value, source = null) {
  const trimmed = (value || '').trim();
  setKeySource(name, trimmed ? source : null);
  if (!trimmed) { getStore().delete(name); return; }
  getStore().set(name, encrypt(trimmed));
}

// Marker value meaning "no key; let the Anthropic SDK use the ant CLI sign-in".
const ANTHROPIC_PROFILE_AUTH = '__anthropic_profile__';

function getKeySource(name) { return getStore().get(`keySource.${name}`) || null; }
function setKeySource(name, source) { if (source) getStore().set(`keySource.${name}`, source); else getStore().delete(`keySource.${name}`); }

function getKeys() {
  const anthropicKey = getSecret('anthropicApiKey');
  return {
    gemini: getSecret('geminiApiKey'),
    anthropic: anthropicKey || (getStore().get('anthropicAuth') === 'profile' ? ANTHROPIC_PROFILE_AUTH : null),
    openai: getSecret('openaiApiKey')
  };
}

// Removes every key, connection and preference. Notes and recordings on disk
// are untouched; they belong to the user, not the app.
function forgetEverything() {
  const s = getStore();
  for (const name of SECRET_NAMES) s.delete(name);
  for (const name of SECRET_NAMES) s.delete(`keySource.${name}`);
  for (const name of ['legacyGoogleClientJson', 'googleAccounts', 'googleClientPath', 'screenpipeDbPath', 'mediaDir', 'workspaceDir',
    'hasCompletedWizard', 'silenceSeconds', 'sessionMinutesSoftLimit', 'lastModel', 'lastPersona', 'anthropicAuth',
    'googleSuggestionDismissed', 'legacyImportDone', 'contexts', 'activeContextId', 'inboxes', 'inboxProcessed', 'inboxMoveProcessed']) s.delete(name);
}

// ---------------------------------------------------------------------------
// Settings

function defaultWorkspace() {
  return path.join(os.homedir(), 'Documents', 'MadroneContext');
}

// ---------------------------------------------------------------------------
// Contexts: each is a name plus a notes folder (a whole vault or a subfolder of
// one) with its own Madrone/ folder, dossier, sessions and entity notes.

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function listContexts() {
  const s = getStore();
  let list = s.get('contexts');
  if (!Array.isArray(list) || list.length === 0) {
    // First run, or an install from before contexts existed: the single notes
    // folder becomes the first context.
    const dir = s.get('workspaceDir') || defaultWorkspace();
    const name = dir === defaultWorkspace() ? 'Personal' : path.basename(dir);
    list = [{ id: newId('ctx'), name, notesDir: dir, mediaDir: s.get('mediaDir') || null }];
    s.set('contexts', list);
  }
  return list.map(c => ({ ...c, mediaDir: c.mediaDir || null }));
}

function getActiveContextId() {
  const list = listContexts();
  const id = getStore().get('activeContextId');
  return list.find(c => c.id === id) ? id : list[0].id;
}

function getContext(id) {
  const list = listContexts();
  return list.find(c => c.id === id) || list.find(c => c.id === getActiveContextId()) || list[0];
}

function setActiveContext(id) {
  if (listContexts().find(c => c.id === id)) getStore().set('activeContextId', id);
}

function addContext({ name, notesDir, mediaDir = null }) {
  const list = listContexts();
  const entry = { id: newId('ctx'), name: (name || path.basename(notesDir)).trim() || path.basename(notesDir), notesDir, mediaDir };
  list.push(entry);
  getStore().set('contexts', list);
  return entry;
}

function updateContext(id, patch) {
  const list = listContexts();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) c.name = patch.name.trim();
  if (typeof patch.notesDir === 'string' && patch.notesDir) c.notesDir = patch.notesDir;
  if ('mediaDir' in patch) c.mediaDir = patch.mediaDir || null;
  getStore().set('contexts', list);
  return c;
}

// Which connected Google accounts a context draws on.
//   null       -> every connected account, including ones connected later (the
//                 default, and what every context has until scoped explicitly)
//   []         -> no Google accounts at all for this context, on purpose
//   [id, ...]  -> exactly those accounts
function setContextGoogleAccounts(id, accountIds) {
  const list = listContexts();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  if (accountIds === null) {
    c.googleAccountIds = null;
  } else {
    const valid = new Set(listGoogleAccounts().map(a => a.id));
    c.googleAccountIds = Array.isArray(accountIds) ? accountIds.filter(a => valid.has(a)) : null;
  }
  getStore().set('contexts', list);
  return c;
}

// Resolves a context's Google account scope to the actual connected accounts.
function googleAccountsForContext(id) {
  const c = getContext(id);
  const all = listGoogleAccounts();
  if (!Array.isArray(c.googleAccountIds)) return all; // never scoped: all accounts, present and future
  if (c.googleAccountIds.length === 0) return []; // explicitly scoped to none
  const wanted = new Set(c.googleAccountIds);
  const scoped = all.filter(a => wanted.has(a.id));
  return scoped.length ? scoped : all; // every named account has since been disconnected; fall back rather than go silently blank
}

function removeContext(id) {
  const list = listContexts();
  if (list.length <= 1) throw new Error('Keep at least one context.');
  getStore().set('contexts', list.filter(c => c.id !== id));
  if (getStore().get('activeContextId') === id) getStore().delete('activeContextId');
}

// Settings resolved for one context: the folders the storage layer uses.
function contextSettings(id) {
  const c = getContext(id);
  const base = getSettings();
  return { ...base, context: c, workspaceDir: c.notesDir, mediaDir: c.mediaDir || path.join(c.notesDir, 'Madrone', 'archives'), googleAccounts: googleAccountsForContext(c.id) };
}

// ---------------------------------------------------------------------------
// Inbox folders: where captures from the phone land before they are triaged.

function listInboxes() {
  return (getStore().get('inboxes') || []).map(i => ({ ...i }));
}

function addInbox({ name, dir }) {
  const list = listInboxes();
  if (list.find(i => i.dir === dir)) return list.find(i => i.dir === dir);
  const entry = { id: newId('inbox'), name: (name || path.basename(dir)).trim() || 'Inbox', dir };
  list.push(entry);
  getStore().set('inboxes', list);
  return entry;
}

function removeInbox(id) {
  getStore().set('inboxes', listInboxes().filter(i => i.id !== id));
}

function getInboxProcessed() {
  return getStore().get('inboxProcessed') || {};
}

function markInboxProcessed(filePath, info) {
  const map = getInboxProcessed();
  map[filePath] = { ...info, processedAt: new Date().toISOString() };
  // Keep the map from growing without bound.
  const keys = Object.keys(map);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete map[k];
  getStore().set('inboxProcessed', map);
}

function getSettings() {
  const s = getStore();
  const active = getContext(getActiveContextId());
  const workspaceDir = active.notesDir;
  return {
    workspaceDir,
    // Where session recordings go. Defaults to <notes folder>/Madrone/archives so
    // notes and recordings travel together; can be pointed outside an Obsidian vault.
    mediaDir: active.mediaDir || path.join(workspaceDir, 'Madrone', 'archives'),
    contexts: listContexts(),
    activeContextId: active.id,
    inboxes: listInboxes(),
    inboxMoveProcessed: s.get('inboxMoveProcessed') !== false,
    screenpipeDbPath: s.get('screenpipeDbPath') || null,
    googleClientPath: s.get('googleClientPath') || null,
    hasCompletedWizard: !!s.get('hasCompletedWizard'),
    silenceSeconds: Number(s.get('silenceSeconds') || 1.8),
    sessionMinutesSoftLimit: Number(s.get('sessionMinutesSoftLimit') || 15),
    lastModel: s.get('lastModel') || null,
    lastPersona: s.get('lastPersona') || null,
    anthropicAuth: s.get('anthropicAuth') === 'profile' ? 'profile' : 'key'
  };
}

function setSetting(name, value) {
  if (value === null || value === undefined || value === '') getStore().delete(name);
  else getStore().set(name, value);
}

// ---------------------------------------------------------------------------
// Google accounts. Tokens are stored encrypted; metadata stays readable.

function listGoogleAccounts() {
  const list = getStore().get('googleAccounts') || [];
  return list.map(a => ({ id: a.id, email: a.email, label: a.label || a.email, addedAt: a.addedAt, needsReconnect: !!a.needsReconnect }));
}

function getGoogleAccountTokens(id) {
  const list = getStore().get('googleAccounts') || [];
  const acc = list.find(a => a.id === id);
  if (!acc) return null;
  try { return JSON.parse(decrypt(acc.tokens) || 'null'); } catch (e) { return null; }
}

function saveGoogleAccount({ id, email, label, tokens }) {
  const list = getStore().get('googleAccounts') || [];
  const idx = list.findIndex(a => a.id === id || (email && a.email === email));
  const entry = {
    id: idx >= 0 ? list[idx].id : id,
    email: email || (idx >= 0 ? list[idx].email : null),
    label: label || email || id,
    addedAt: idx >= 0 ? list[idx].addedAt : new Date().toISOString(),
    needsReconnect: false,
    tokens: encrypt(JSON.stringify(tokens))
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  getStore().set('googleAccounts', list);
  return { id: entry.id, email: entry.email, label: entry.label };
}

function updateGoogleAccountTokens(id, tokens) {
  const list = getStore().get('googleAccounts') || [];
  const acc = list.find(a => a.id === id);
  if (!acc) return;
  const existing = getGoogleAccountTokens(id) || {};
  acc.tokens = encrypt(JSON.stringify({ ...existing, ...tokens }));
  acc.needsReconnect = false;
  getStore().set('googleAccounts', list);
}

function markGoogleAccountNeedsReconnect(id) {
  const list = getStore().get('googleAccounts') || [];
  const acc = list.find(a => a.id === id);
  if (!acc) return;
  acc.needsReconnect = true;
  getStore().set('googleAccounts', list);
}

function removeGoogleAccount(id) {
  const list = (getStore().get('googleAccounts') || []).filter(a => a.id !== id);
  getStore().set('googleAccounts', list);
}

module.exports = {
  getStore,
  SECRET_NAMES,
  ANTHROPIC_PROFILE_AUTH,
  forgetEverything,
  getKeySource,
  setKeySource,
  listContexts,
  getActiveContextId,
  getContext,
  setActiveContext,
  addContext,
  updateContext,
  removeContext,
  contextSettings,
  setContextGoogleAccounts,
  googleAccountsForContext,
  listInboxes,
  addInbox,
  removeInbox,
  getInboxProcessed,
  markInboxProcessed,
  encryptionAvailable,
  getSecret,
  setSecret,
  getKeys,
  getSettings,
  setSetting,
  defaultWorkspace,
  listGoogleAccounts,
  getGoogleAccountTokens,
  saveGoogleAccount,
  updateGoogleAccountTokens,
  markGoogleAccountNeedsReconnect,
  removeGoogleAccount
};
