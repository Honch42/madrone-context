'use strict';
// Reads recent screen OCR and audio transcriptions from a local OpenRecall
// database, if one exists. OpenRecall is optional; when it is missing the
// caller gets { ok: false, notice } and carries on.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Unit separator: a byte that never appears in OCR text, so columns split cleanly.
const SEP = '\u001f';

function candidatePaths(custom) {
  const list = [];
  if (custom) list.push(custom);
  list.push(path.join(os.homedir(), 'Library', 'Application Support', 'openrecall', 'recall.db'));
  list.push(path.join(os.homedir(), '.openrecall', 'db.sqlite'));
  list.push(path.join(os.homedir(), '.local', 'share', 'openrecall', 'db.sqlite'));
  return list;
}

function findDatabase(custom) {
  return candidatePaths(custom).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

function query(dbPath, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-readonly', '-separator', SEP, dbPath, sql], { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim() ? stdout.trim().split('\n') : []);
    });
  });
}

async function getOpenRecallContext(customDbPath, { timeoutMs = 2000 } = {}) {
  const dbPath = findDatabase(customDbPath);
  if (!dbPath) {
    return { ok: false, notice: 'OpenRecall database not found. Continuing without screen context.', text: '' };
  }
  try {
    const ocr = await query(dbPath, "SELECT app, title, substr(replace(text, char(10), ' '), 1, 160) FROM entries WHERE text IS NOT NULL AND length(text) > 0 ORDER BY timestamp DESC LIMIT 8;", timeoutMs);
    const lines = ['[OpenRecall: recent screen activity]'];
    if (ocr.length === 0) lines.push('- No recent screen activity recorded.');
    for (const row of ocr) {
      const [app, win, text] = row.split(SEP);
      lines.push(`- [${app || 'app'}] ${win || ''}: ${text || ''}`);
    }
    return { ok: true, notice: null, text: lines.join('\n') };
  } catch (e) {
    const reason = e.killed ? 'timed out' : (e.code === 'ENOENT' ? 'the sqlite3 command is missing' : e.message.split('\n')[0]);
    return { ok: false, notice: `OpenRecall could not be read (${reason}). Continuing without screen context.`, text: '' };
  }
}

const PRIVACY_APP_DENYLIST = ['1password', 'bitwarden', 'keychain', 'keepass', 'auth', 'authenticator'];
const PRIVACY_TITLE_DENYLIST = ['password', 'login', 'sign in', '2fa', 'verification', 'bank', 'chase', 'wells fargo', 'mercury'];

async function getOpenRecallEntriesSince(sinceTs = 0, { customDbPath, limit = 50, timeoutMs = 5000 } = {}) {
  const dbPath = findDatabase(customDbPath);
  if (!dbPath) return { ok: false, notice: 'OpenRecall DB not found', entries: [] };
  try {
    const sql = `SELECT id, app, title, substr(replace(text, char(10), ' '), 1, 300), timestamp FROM entries WHERE timestamp > ${Math.floor(sinceTs)} AND text IS NOT NULL AND length(text) > 0 ORDER BY timestamp ASC LIMIT ${Math.floor(limit)};`;
    const rows = await query(dbPath, sql, timeoutMs);
    const entries = [];
    for (const row of rows) {
      const [id, app, win, text, ts] = row.split(SEP);
      const appLower = (app || '').toLowerCase();
      const winLower = (win || '').toLowerCase();
      if (PRIVACY_APP_DENYLIST.some(d => appLower.includes(d))) continue;
      if (PRIVACY_TITLE_DENYLIST.some(d => winLower.includes(d))) continue;
      entries.push({ id: Number(id), app: app || 'Unknown', title: win || 'Untitled', text: text || '', timestamp: Number(ts) });
    }
    return { ok: true, notice: null, entries };
  } catch (e) {
    return { ok: false, notice: e.message, entries: [] };
  }
}

module.exports = { getOpenRecallContext, getOpenRecallEntriesSince, findDatabase };
