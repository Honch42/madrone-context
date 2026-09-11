'use strict';
// Reads recent screen OCR and audio transcriptions from a local Screenpipe
// database, if one exists. Screenpipe is optional; when it is missing the
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
  list.push(path.join(os.homedir(), '.screenpipe', 'db.sqlite'));
  list.push(path.join(os.homedir(), '.local', 'share', 'screenpipe', 'db.sqlite'));
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

async function getScreenpipeContext(customDbPath, { timeoutMs = 2000 } = {}) {
  const dbPath = findDatabase(customDbPath);
  if (!dbPath) {
    return { ok: false, notice: 'Screenpipe database not found. Continuing without screen context.', text: '' };
  }
  try {
    const ocr = await query(dbPath, "SELECT app_name, window_name, substr(replace(full_text, char(10), ' '), 1, 160) FROM frames WHERE full_text IS NOT NULL AND length(full_text) > 0 ORDER BY timestamp DESC LIMIT 8;", timeoutMs);
    const audio = await query(dbPath, "SELECT substr(replace(transcription, char(10), ' '), 1, 160) FROM audio_transcriptions WHERE transcription IS NOT NULL AND length(transcription) > 0 ORDER BY timestamp DESC LIMIT 5;", timeoutMs);
    const lines = ['[Screenpipe: recent screen activity]'];
    if (ocr.length === 0) lines.push('- No recent screen activity recorded.');
    for (const row of ocr) {
      const [app, win, text] = row.split(SEP);
      lines.push(`- [${app || 'app'}] ${win || ''}: ${text || ''}`);
    }
    lines.push('', '[Screenpipe: recent speech heard]');
    if (audio.length === 0) lines.push('- No recent audio recorded.');
    for (const row of audio) lines.push(`- ${row}`);
    return { ok: true, notice: null, text: lines.join('\n') };
  } catch (e) {
    const reason = e.killed ? 'timed out' : (e.code === 'ENOENT' ? 'the sqlite3 command is missing' : e.message.split('\n')[0]);
    return { ok: false, notice: `Screenpipe could not be read (${reason}). Continuing without screen context.`, text: '' };
  }
}

module.exports = { getScreenpipeContext, findDatabase };
