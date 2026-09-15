'use strict';
// 1Password integration through the `op` command-line tool.
//
// Requirements on the user's Mac: the 1Password app, the CLI
// (`brew install 1password-cli`), and "Integrate with 1Password CLI" turned on
// in 1Password > Settings > Developer. 1Password itself shows a Touch ID prompt
// naming this app before anything is read, so the user always approves.
//
// Values read here are handed to the caller (the main process) and are never
// sent to the renderer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CANDIDATE_BINARIES = [
  '/opt/homebrew/bin/op',
  '/usr/local/bin/op',
  path.join(os.homedir(), '.op', 'bin', 'op'),
  '/usr/bin/op'
];

const VENDOR_HINTS = {
  gemini: /gemini|google ai|aistudio|generative/i,
  anthropic: /anthropic|claude/i,
  openai: /openai|gpt|chatgpt/i
};

function findBinary() {
  for (const p of CANDIDATE_BINARIES) { try { if (fs.existsSync(p)) return p; } catch (e) { /* next */ } }
  return null;
}

function isInstalled() { return !!findBinary(); }

function run(args, { timeoutMs = 120000 } = {}) {
  const bin = findBinary();
  if (!bin) return Promise.reject(new Error('The 1Password command-line tool is not installed. In Terminal: brew install 1password-cli'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, OP_FORMAT: 'json' } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(friendlyError(stderr || err.message)));
      resolve(stdout);
    });
  });
}

function friendlyError(text) {
  const t = String(text || '').trim();
  if (/not signed in|no account|sign in|authorization prompt|desktop app|integrat|connect/i.test(t)) {
    return 'Could not unlock 1Password. Open 1Password, go to Settings > Developer, turn on "Integrate with 1Password CLI", and try again.';
  }
  if (/timed out|ETIMEDOUT|killed/i.test(t)) return '1Password did not respond in time. If a Touch ID prompt appeared, approve it and try again.';
  if (/isn't an item|not found|no item/i.test(t)) return 'That item could not be found in 1Password.';
  return t.split('\n')[0].replace(/^\[ERROR\]\s*\S*\s*/, '') || 'Unknown 1Password error.';
}

// Items that plausibly hold an API key for the vendor. Titles only; nothing is
// read until the user picks one.
async function listCandidates(vendor) {
  const raw = await run(['item', 'list', '--format', 'json']);
  let items = [];
  try { items = JSON.parse(raw); } catch (e) { throw new Error('Unexpected reply from 1Password.'); }
  const hint = VENDOR_HINTS[vendor];
  const scored = items.map(it => {
    const text = `${it.title || ''} ${(it.tags || []).join(' ')}`;
    let score = 0;
    if (hint && hint.test(text)) score += 10;
    if (it.category === 'API_CREDENTIAL') score += 5;
    if (/api|key|token/i.test(text)) score += 2;
    return { score, item: it };
  }).filter(x => x.score >= 2);
  scored.sort((a, b) => b.score - a.score || String(a.item.title).localeCompare(String(b.item.title)));
  return scored.slice(0, 25).map(({ item }) => ({
    id: item.id,
    title: item.title || '(untitled)',
    vault: item.vault && item.vault.name ? item.vault.name : '',
    category: (item.category || '').replace(/_/g, ' ').toLowerCase()
  }));
}

// Picks the secret out of an item's fields: the API-credential field, else the
// password, else a concealed field that has the vendor's key shape, else any
// concealed field.
function pickSecretField(item, looksLikeKey) {
  const fields = (item && item.fields) || [];
  const concealed = fields.filter(f => f && f.type === 'CONCEALED' && f.value);
  const byId = concealed.find(f => f.id === 'credential') || concealed.find(f => f.purpose === 'PASSWORD' || f.id === 'password');
  if (byId && (!looksLikeKey || looksLikeKey(byId.value))) return byId;
  if (looksLikeKey) {
    const shaped = concealed.find(f => looksLikeKey(f.value)) || fields.find(f => f && f.value && looksLikeKey(f.value));
    if (shaped) return shaped;
  }
  return byId || concealed[0] || null;
}

async function readItem(itemId, looksLikeKey) {
  const raw = await run(['item', 'get', itemId, '--format', 'json']);
  let item;
  try { item = JSON.parse(raw); } catch (e) { throw new Error('Unexpected reply from 1Password.'); }
  const field = pickSecretField(item, looksLikeKey);
  if (!field) throw new Error(`"${item.title || itemId}" has no secret field to use.`);
  return { value: String(field.value).trim(), title: item.title || itemId, field: field.label || field.id };
}

function isReference(text) {
  return /^op:\/\/[^/]+\/[^/]+\/.+/.test(String(text || '').trim());
}

async function readReference(ref) {
  const out = await run(['read', ref.trim()]);
  return out.trim();
}

module.exports = { isInstalled, findBinary, listCandidates, readItem, readReference, isReference, pickSecretField, friendlyError };
