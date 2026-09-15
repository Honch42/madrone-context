'use strict';
// Finds API keys the user may already have on this Mac, so setup can offer
// "use the key you already have" instead of making them paste one.
//
// Sources, in the order most people actually keep keys:
//   1. The login shell's environment (exports in ~/.zshrc, ~/.zprofile, etc.)
//   2. Dotenv-style files used by common tools: ~/.gemini/.env (Gemini CLI),
//      ~/.env, and the env block in ~/.claude/settings.json (Claude Code),
//      plus ~/.codex/auth.json (OpenAI Codex CLI)
//   3. An Anthropic CLI sign-in (`ant auth login`), which the Anthropic SDK can
//      use directly with no key at all
//   4. Keychain entries written by an earlier version of this app
//
// Nothing is imported without the user choosing it. Values never reach the
// renderer: candidates are returned masked, keyed by id, and resolved here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { readKeychain } = require('./legacy');

const ENV_VARS = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY']
};

const KEY_SHAPES = {
  gemini: /^AIza[0-9A-Za-z_-]{20,}$/,
  anthropic: /^sk-ant-[0-9A-Za-z_-]{20,}$/,
  openai: /^sk-[0-9A-Za-z_-]{20,}$/
};

let cache = new Map(); // id -> { vendor, value }

function mask(value) {
  if (!value) return '';
  if (value.length <= 12) return value.slice(0, 3) + '…';
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

function looksLikeKey(vendor, value) {
  return typeof value === 'string' && KEY_SHAPES[vendor].test(value.trim());
}

function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}

// Runs the user's login shell so exports in rc files are visible to a GUI app.
function loginShellEnv(timeoutMs = 5000) {
  return new Promise(resolve => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'env'], { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
      if (err && !stdout) return resolve({});
      resolve(parseDotenv(stdout || ''));
    });
  });
}

function anthropicProfile() {
  const root = process.env.ANTHROPIC_CONFIG_DIR
    || (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'anthropic') : path.join(os.homedir(), '.config', 'anthropic'));
  try {
    const profile = (process.env.ANTHROPIC_PROFILE || fs.readFileSync(path.join(root, 'active_config'), 'utf-8')).trim();
    if (profile && fs.existsSync(path.join(root, 'credentials', `${profile}.json`))) return { found: true, profile, root };
  } catch (e) { /* no profile */ }
  return { found: false, profile: null, root };
}

async function discover() {
  cache = new Map();
  const found = { gemini: [], anthropic: [], openai: [] };
  const seen = new Set();
  const add = (vendor, value, source) => {
    if (!looksLikeKey(vendor, value)) return;
    const v = value.trim();
    if (seen.has(vendor + v)) return;
    seen.add(vendor + v);
    const id = crypto.randomBytes(6).toString('hex');
    cache.set(id, { vendor, value: v });
    found[vendor].push({ id, source, masked: mask(v) });
  };
  const addFromMap = (map, source) => {
    for (const vendor of Object.keys(ENV_VARS)) {
      for (const name of ENV_VARS[vendor]) if (map && map[name]) add(vendor, map[name], `${source} (${name})`);
    }
  };

  const home = os.homedir();
  addFromMap(await loginShellEnv(), 'Shell environment');
  addFromMap(process.env, 'Shell environment');
  try { addFromMap(parseDotenv(fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf-8')), 'Gemini CLI (~/.gemini/.env)'); } catch (e) { /* none */ }
  try { addFromMap(parseDotenv(fs.readFileSync(path.join(home, '.env'), 'utf-8')), 'Home .env file'); } catch (e) { /* none */ }
  const claudeSettings = readJson(path.join(home, '.claude', 'settings.json'));
  if (claudeSettings && claudeSettings.env) addFromMap(claudeSettings.env, 'Claude Code settings');
  const codexAuth = readJson(path.join(home, '.codex', 'auth.json'));
  if (codexAuth && codexAuth.OPENAI_API_KEY) add('openai', codexAuth.OPENAI_API_KEY, 'Codex CLI (~/.codex/auth.json)');
  for (const [vendor, account] of [['gemini', 'gemini-api-key-Collective'], ['anthropic', 'anthropic-api-key'], ['openai', 'openai-api-key']]) {
    const raw = readKeychain(account);
    if (!raw) continue;
    let value = raw;
    try { value = JSON.parse(raw).api_key || raw; } catch (e) { /* plain */ }
    add(vendor, value, 'macOS Keychain (earlier version of this app)');
  }

  return { ...found, anthropicProfile: anthropicProfile() };
}

function resolve(id) {
  return cache.get(id) || null;
}

// Registers keys found by another route (a chosen .env file, the clipboard) so
// the page can offer them masked and pick by id, exactly like discovered ones.
function register(vendor, value, source) {
  if (!looksLikeKey(vendor, value)) return null;
  const id = crypto.randomBytes(6).toString('hex');
  cache.set(id, { vendor, value: value.trim() });
  return { id, source, masked: mask(value.trim()) };
}

function candidatesFromEnvText(text, source) {
  const map = parseDotenv(text);
  const out = { gemini: [], anthropic: [], openai: [] };
  for (const vendor of Object.keys(ENV_VARS)) {
    for (const name of ENV_VARS[vendor]) {
      if (map[name]) { const c = register(vendor, map[name], `${source} (${name})`); if (c) out[vendor].push(c); }
    }
  }
  return out;
}

// A pasted value that is not a key itself but names one.
function vendorForKey(value) {
  for (const vendor of Object.keys(KEY_SHAPES)) if (looksLikeKey(vendor, value)) return vendor;
  return null;
}

module.exports = { discover, resolve, register, candidatesFromEnvText, vendorForKey, parseDotenv, looksLikeKey, mask, anthropicProfile, ENV_VARS };
