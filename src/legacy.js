'use strict';
// One-time import of credentials that earlier versions of the app read directly
// from the macOS Keychain under the "AntiGravity" service. New installs never
// have these entries, so for a friend this module does nothing.

const { execFileSync } = require('child_process');
const config = require('./config');

function readKeychain(account, service = 'AntiGravity') {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000
    }).trim();
    if (!raw) return null;
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      try { return Buffer.from(raw, 'hex').toString('utf-8'); } catch (e) { return raw; }
    }
    return raw;
  } catch (e) {
    return null;
  }
}

function unwrapApiKey(raw) {
  if (!raw) return null;
  try { const data = JSON.parse(raw); return data.api_key || raw; } catch (e) { return raw; }
}

function importIfNeeded() {
  const store = config.getStore();
  if (store.get('legacyImportDone')) return { imported: [] };
  const imported = [];

  const pairs = [
    ['geminiApiKey', 'gemini-api-key-Collective'],
    ['anthropicApiKey', 'anthropic-api-key'],
    ['openaiApiKey', 'openai-api-key']
  ];
  for (const [name, account] of pairs) {
    if (config.getSecret(name)) continue;
    const value = unwrapApiKey(readKeychain(account));
    if (value) { config.setSecret(name, value); imported.push(name); }
  }

  // Google tokens previously stored per account suffix, alongside the OAuth
  // client secret JSON. Import the tokens; the client config is imported as a
  // file path only if the user points the app at one later.
  for (const suffix of ['Personal', 'Collective', 'IV']) {
    const rawToken = readKeychain(`google-token-${suffix}`);
    if (!rawToken) continue;
    try {
      const tokens = JSON.parse(rawToken);
      if (!tokens.refresh_token && !tokens.access_token) continue;
      config.saveGoogleAccount({ id: `legacy-${suffix}`, email: null, label: `${suffix} (imported)`, tokens });
      imported.push(`google-${suffix}`);
      const rawSecret = readKeychain(`google-client-secret-${suffix}`);
      if (rawSecret && !config.getSecret('legacyGoogleClientJson')) {
        try { JSON.parse(rawSecret); config.setSecret('legacyGoogleClientJson', rawSecret); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore malformed entries */ }
  }

  store.set('legacyImportDone', true);
  return { imported };
}

module.exports = { importIfNeeded, readKeychain };
