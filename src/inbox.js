'use strict';
// The inbox: folders where captures from the phone land (voice memos, quick
// notes) before they are reviewed. Scanning finds new items, audio is
// transcribed by the caller, and triage decisions are written into the chosen
// context's Madrone/ folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const AUDIO_MIME = {
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mp3',
  '.wav': 'audio/wav', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.caf': 'audio/x-caf'
};
const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);
const PROCESSED_DIR = 'Processed';
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

function pad(n) { return String(n).padStart(2, '0'); }

function itemId(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
}

// iCloud Drive keeps undownloaded files as ".name.icloud" placeholders.
function placeholderTarget(name) {
  const m = /^\.(.+)\.icloud$/.exec(name);
  return m ? m[1] : null;
}

function mimeFor(filePath) {
  return AUDIO_MIME[path.extname(filePath).toLowerCase()] || null;
}

// New items across all inbox folders, oldest first. Skips the Processed
// subfolder, hidden files, and anything already marked processed.
function scan(inboxes, processedMap = {}) {
  const items = [];
  for (const inbox of inboxes) {
    let entries = [];
    try { entries = fs.readdirSync(inbox.dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const placeholder = placeholderTarget(entry.name);
      const name = placeholder || entry.name;
      if (!placeholder && name.startsWith('.')) continue;
      const ext = path.extname(name).toLowerCase();
      const kind = AUDIO_MIME[ext] ? 'audio' : (TEXT_EXT.has(ext) ? 'text' : null);
      if (!kind) continue;
      const filePath = path.join(inbox.dir, name);
      if (processedMap[filePath]) continue;
      let stat = null;
      try { stat = fs.statSync(path.join(inbox.dir, entry.name)); } catch (e) { continue; }
      if (!placeholder && stat.size === 0) continue;
      items.push({
        id: itemId(filePath),
        inboxId: inbox.id,
        inboxName: inbox.name,
        inboxDir: inbox.dir,
        path: filePath,
        name,
        kind,
        size: stat.size,
        capturedAt: (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.mtime).toISOString(),
        placeholder: !!placeholder
      });
    }
  }
  items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  return items;
}

// Asks iCloud to download a placeholder and waits for the real file.
function ensureDownloaded(item, { timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    if (!item.placeholder) return resolve(true);
    if (process.platform === 'darwin') execFile('brctl', ['download', item.path], () => {});
    const started = Date.now();
    const tick = () => {
      try {
        if (fs.existsSync(item.path) && fs.statSync(item.path).size > 0) { item.placeholder = false; return resolve(true); }
      } catch (e) { /* keep waiting */ }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });
}

function readText(item) {
  const text = fs.readFileSync(item.path, 'utf-8');
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

async function readAudio(item) {
  const stat = fs.statSync(item.path);
  if (stat.size > MAX_AUDIO_BYTES) throw new Error(`${item.name} is larger than ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB; split it or transcribe it elsewhere.`);
  return { buffer: fs.readFileSync(item.path), mime: mimeFor(item.path) };
}

// Moves a reviewed item into <inbox>/Processed/YYYY-MM/ so the inbox empties
// visibly. Returns the new path (or the old one if moving is off or fails).
function moveProcessed(item, { move = true } = {}) {
  if (!move) return item.path;
  const d = new Date(item.capturedAt);
  const dir = path.join(item.inboxDir, PROCESSED_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, item.name);
    if (fs.existsSync(target)) {
      const ext = path.extname(item.name);
      target = path.join(dir, `${path.basename(item.name, ext)}-${item.id}${ext}`);
    }
    fs.renameSync(item.path, target);
    return target;
  } catch (e) {
    return item.path;
  }
}

// ---------------------------------------------------------------------------
// Writing triage results into a context.

function stamp(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function appendToFile(file, header, block) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { text = header; }
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, text + block + '\n');
  return file;
}

// A to-do in Obsidian Tasks format: "- [ ] title 📅 YYYY-MM-DD".
function appendActionItem(ctxSettings, { title, due, capturedAt, sessionId, note }) {
  const file = path.join(ctxSettings.workspaceDir, 'Madrone', 'Action Items.md');
  const header = '---\ntags:\n  - madrone-actions\n---\n# Action Items\n\nCaptured from the inbox and clarified in interviews. Tick items off here; Obsidian Tasks understands the format.\n';
  const bits = [`- [ ] ${title.trim()}`];
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) bits.push(`📅 ${due}`);
  bits.push(`(captured ${stamp(capturedAt)})`);
  if (sessionId) bits.push(`[[${sessionId}_session|review]]`);
  let block = bits.join(' ');
  if (note && note.trim()) block += `\n    ${note.trim().replace(/\s+/g, ' ')}`;
  return appendToFile(file, header, block);
}

// A thought goes into a dated note under Madrone/Thoughts/.
function appendThought(ctxSettings, { title, text, capturedAt, sessionId, links = [] }) {
  const d = new Date(capturedAt || Date.now());
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const file = path.join(ctxSettings.workspaceDir, 'Madrone', 'Thoughts', `${day}.md`);
  const header = `---\ndate: ${day}\ntags:\n  - madrone-thoughts\n---\n# Thoughts ${day}\n`;
  const lines = [`\n## ${pad(d.getHours())}:${pad(d.getMinutes())} ${title.trim()}`, '', (text || '').trim()];
  if (links.length) lines.push('', links.map(n => `[[${n}]]`).join(' · '));
  if (sessionId) lines.push('', `_Clarified in [[${sessionId}_session|this review]]._`);
  return appendToFile(file, header, lines.join('\n'));
}

// The review session's own record of what was decided.
function triageSummaryMarkdown(decisions) {
  if (!decisions.length) return '_No inbox items were triaged._';
  return decisions.map(d => {
    const where = d.kind === 'discard' ? 'discarded' : `${d.kind} → ${d.contextName}`;
    return `- **${d.title}** (${where}${d.due ? `, due ${d.due}` : ''}) — from ${d.itemName}, captured ${stamp(d.capturedAt)}`;
  }).join('\n');
}

module.exports = {
  AUDIO_MIME, TEXT_EXT, PROCESSED_DIR,
  scan, ensureDownloaded, readText, readAudio, mimeFor, moveProcessed,
  appendActionItem, appendThought, triageSummaryMarkdown, itemId
};
